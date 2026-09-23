"""INNOVERA Local AI OCR service — schema v3, version 3.2 ("typhoon-sections").

Full-document extraction for the Makkha intake form: fitted registration and template verdict, deterministic checkbox /
body-map / empty-box detection, and two concurrent Typhoon OCR calls (OCR_SECTION_MODE=staff-separate, the default): the
STAFF ONLY crop alone with a Thai vocabulary prompt, and the header stacked above the customer rows. Field confidence is
capped by the model's own token probabilities; a call that fails after one retry degrades only its own section.
OCR_SECTION_MODE=combined keeps v3.1's single call, OCR_SECTION_MODE=separate v3.0's two calls without the header.
"""

import functools
import io
import os
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from PIL import Image, ImageOps, UnidentifiedImageError
from pydantic import BaseModel

import numpy as np

import ocr_confidence as C
import ocr_layout as L
import ocr_marks as M
import ocr_model
import ocr_normalize as N
import ocr_register as R

VERSION, ENGINE, SCHEMA_VERSION = "3.2", "typhoon-sections", 3
app = FastAPI(title="INNOVERA OCR API", version=VERSION)

IMAGE_EXTENSIONS = (".png", ".jpg", ".jpeg", ".webp")
MIME_EXTENSIONS = {"image/png": ".png", "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/webp": ".webp", "application/pdf": ".pdf"}
STAMP_RED_MIN = 40  # red minus max(green, blue) of a pink/red stamp pixel (PAID stamps), removed from model crops
# ...only at a stamp's luminance: real PAID-stamp ink sits at 150-200 (1 % of it below 117), red or crimson ballpoint at
# 65-95, and pen strokes must reach the model.
STAMP_LUM_MIN = 110
MAX_PDF_PAGE_PT = 14400  # PDF page-size limit (200 in); bigger MediaBoxes are refused before anything is rendered
MAX_RASTER_PIXELS = 89_478_485  # Pillow's decompression-bomb warning threshold, enforced as an error (after JPEG draft)
JPEG_DRAFT_SIDE = 4096  # a bigger JPEG (e.g. a 108 MP phone photo) is decoded at 1/2..1/8 scale, still >= this on both sides
# PDFium (and MuPDF) keep process-global state and are not thread-safe. /v1/ocr runs in FastAPI's threadpool, so two
# PDF renders at once could crash the whole process: every render runs under this lock.
_PDF_LOCK = threading.Lock()


def upload_dir():
    return Path(os.environ.get("OCR_UPLOAD_DIR", "/app/uploads"))


def _env_number(name, default, low, high, cast=float):
    try:
        return max(low, min(high, cast(os.environ.get(name, default))))
    except ValueError:
        return default


def section_parallelism():
    return _env_number("OCR_SECTION_PARALLELISM", 2, 1, 8, int)


def max_upload_bytes():
    return _env_number("OCR_MAX_UPLOAD_BYTES", 30 * 1024 * 1024, 1024, 512 * 1024 * 1024, int)


def customer_crop_scale():
    return _env_number("OCR_CUSTOMER_CROP_SCALE", 1.0, 0.5, 4.0)


SECTION_MODES = ("staff-separate", "combined", "separate")


def section_mode():
    """"staff-separate" (default, v3.2): the STAFF crop alone (Thai vocabulary prompt) and the header + customer rows, two
    concurrent calls; "combined": v3.1's one call on header + customer rows + STAFF crop; "separate": v3.0's two calls
    (STAFF, customer rows; no header). Unknown values fall back to the default."""
    mode = os.environ.get("OCR_SECTION_MODE", "staff-separate").strip().lower()
    return mode if mode in SECTION_MODES else "staff-separate"


def _ms(start, end=None):
    return int(round(((end if end is not None else time.perf_counter()) - start) * 1000))


def _render_scale(width_pt, height_pt):
    """Render scale for a PDF page: long side at 2x the reference width (at most 6x). The long side of the bitmap is
    therefore never above 2 * REF_W px, whatever the MediaBox says. Pages outside 1..MAX_PDF_PAGE_PT pt are refused."""
    long_side, short_side = max(width_pt, height_pt), min(width_pt, height_pt)
    if not (0 < short_side and long_side <= MAX_PDF_PAGE_PT):
        raise ValueError(f"PDF page size {width_pt:.0f}x{height_pt:.0f} pt is outside 1..{MAX_PDF_PAGE_PT} pt")
    return min(6.0, 2 * L.REF_W / long_side)


@functools.lru_cache(maxsize=1)
def _pdf_renderer():
    """First-page PDF renderer using pypdfium2 or PyMuPDF when importable, else None (PDF => HTTP 415).
    Callers must hold _PDF_LOCK: neither library is thread-safe."""
    try:
        import pypdfium2 as pdfium

        def render_pdfium(data):
            pdf = pdfium.PdfDocument(data)
            try:
                page = pdf[0]
                try:
                    bitmap = page.render(scale=_render_scale(*page.get_size()))
                    try:
                        return bitmap.to_pil().convert("RGB"), len(pdf)  # convert() copies out of the PDFium buffer
                    finally:
                        bitmap.close()
                finally:
                    page.close()  # close every PDFium object here, under the lock, never later from the GC
            finally:
                pdf.close()
        return render_pdfium
    except ImportError:
        pass
    try:
        import fitz

        def render_fitz(data):
            doc = fitz.open(stream=data, filetype="pdf")
            try:
                page = doc[0]
                zoom = _render_scale(page.rect.width, page.rect.height)
                pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
                return Image.frombytes("RGB", (pix.width, pix.height), pix.samples), doc.page_count
            finally:
                doc.close()
        return render_fitz
    except ImportError:
        return None


def _decode(data, ext):
    """Bytes -> (RGB image, warnings). Raises HTTPException(400) for undecodable input."""
    warnings = []
    if ext == ".pdf":
        try:
            with _PDF_LOCK:
                image, pages = _pdf_renderer()(data)
        except Exception as error:  # renderer-specific error types, oversize pages
            raise HTTPException(400, f"Cannot render the uploaded PDF: {error}") from error
        if pages > 1:
            warnings.append(f"PDF has {pages} pages; only page 1 was processed")
        return image, warnings
    try:
        image = Image.open(io.BytesIO(data))
        if image.width * image.height > MAX_RASTER_PIXELS and image.format == "JPEG":
            image.draft(image.mode, (JPEG_DRAFT_SIDE, JPEG_DRAFT_SIDE))  # DCT scaling: cheaper than decoding full size
        if image.width * image.height > MAX_RASTER_PIXELS:  # checked on the header, before any pixel is decoded
            raise ValueError(f"image is {image.width}x{image.height} px, more than {MAX_RASTER_PIXELS} pixels")
        image.load()
        image = ImageOps.exif_transpose(image)
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError, ValueError, SyntaxError) as error:
        raise HTTPException(400, f"Cannot decode the uploaded {ext.lstrip('.').upper()} file: {error}") from error
    if image.mode in ("RGBA", "LA", "PA") or (image.mode == "P" and "transparency" in image.info):
        rgba = image.convert("RGBA")
        background = Image.new("RGB", rgba.size, (255, 255, 255))
        background.paste(rgba, mask=rgba.split()[-1])
        return background, warnings
    return image.convert("RGB"), warnings


def _sniff_extension(data, ext):
    """The decoder follows the bytes when the name says PDF but the bytes are an image: a worker from before Release 1
    (a rollback) sends a PDF page image under its parent's name 'x.pdf'. Anything else keeps the name's extension (a PDF
    may put up to 1 KB before its '%PDF-' header)."""
    if ext != ".pdf" or b"%PDF-" in data[:1024]:
        return ext
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if data.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp"
    return ext


class _Crops:
    """Model crops cut from the original image through the fitted geometry. Template boxes are in reference px; the image
    has width/805 x height/569 pixels per reference px. Above ROTATE_CROPS_ABOVE_DEG of fitted rotation a crop is
    resampled from the de-rotated page (Pillow AFFINE transform of just the crop area, equivalent to rotating the whole
    page first); below it the crop is a plain pixel copy, so an unrotated 805x569 scan gives v2.2's exact STAFF pixels."""

    def __init__(self, image, geo):
        self.image, self.geo = image, geo
        self.kx, self.ky = image.width / L.REF_W, image.height / L.REF_H
        self.rotated = abs(geo.rotation_deg) > R.ROTATE_CROPS_ABOVE_DEG
        self.stamp_pixels = 0

    def region(self, box, clamp=True):
        """clamp=False keeps v2.2's behaviour for the STAFF crop (rows beyond the page are black padding)."""
        x0, y0, x1, y1 = box
        if self.rotated:
            sx, sy = self.geo.scale
            density = (self.kx * sx, self.ky * sy)
            size = (max(1, round((x1 - x0) * density[0])), max(1, round((y1 - y0) * density[1])))
            data = self.geo.inverse_coefficients(self.kx, self.ky, (x0, y0), density)
            crop = self.image.transform(size, Image.AFFINE, data, resample=Image.BILINEAR,
                                        fillcolor=(255, 255, 255) if clamp else (0, 0, 0))
        else:
            (qx0, qy0), (qx1, qy1) = self.geo.point(x0, y0), self.geo.point(x1, y1)
            rect = [round(qx0 * self.kx), round(qy0 * self.ky), round(qx1 * self.kx), round(qy1 * self.ky)]
            if clamp:
                rect = [max(0, min(self.image.width, rect[0])), max(0, min(self.image.height, rect[1])),
                        max(0, min(self.image.width, rect[2])), max(0, min(self.image.height, rect[3]))]
            crop = self.image.crop(tuple(rect))
        if not crop.width or not crop.height:  # a region entirely off the page (only on a badly fitted page)
            crop = Image.new("RGB", (1, 1), (255, 255, 255))
        return self._stamp_free(crop)

    def _stamp_free(self, crop):
        """Pink/red stamp pixels (a PAID stamp) become paper white before the crop is sent to the model (release1 A7).
        Blue and black pen, gray print and the orange form print are kept (orange has blue far below green), and so is red
        or crimson pen: it is much darker than stamp ink (STAMP_LUM_MIN)."""
        arr = np.asarray(crop)
        if arr.ndim != 3 or not arr.size:
            return crop
        r, g, b = (arr[..., i].astype(np.int32) for i in range(3))
        stamp = (r - np.maximum(g, b) >= STAMP_RED_MIN) & (b >= g - 5) & (r >= 120) & (299 * r + 587 * g + 114 * b >= STAMP_LUM_MIN * 1000)
        found = int(stamp.sum())
        if not found:
            return crop
        self.stamp_pixels += found
        clean = arr.copy()
        clean[stamp] = 255
        return Image.fromarray(clean)

    def rows(self, rows, scale=1.0, clamp=True):
        """Reference rows cropped and stacked vertically (4 px white gap), at most 2x reference resolution."""
        parts = [self.region(row, clamp) for row in rows]
        crop = parts[0] if len(parts) == 1 else _stack(parts, gap=4)
        limit = 2 * max(r[2] - r[0] for r in rows)  # never send more than 2x reference resolution
        factor = min(scale, limit / crop.width) if crop.width else scale
        if abs(factor - 1.0) > 1e-3:
            crop = crop.resize((max(1, round(crop.width * factor)), max(1, round(crop.height * factor))), Image.LANCZOS)
        return crop

    def side_by_side(self, parts, gap=8):
        images = [self.region(part) for part in parts]
        canvas = Image.new("RGB", (sum(p.width for p in images) + gap * (len(images) - 1), max(p.height for p in images)), (255, 255, 255))
        x = 0
        for part in images:
            canvas.paste(part, (x, 0))
            x += part.width + gap
        return canvas


def _stack(parts, gap=12):
    """Stack images vertically on white (top first); each keeps its own pixels."""
    canvas = Image.new("RGB", (max(p.width for p in parts), sum(p.height for p in parts) + gap * (len(parts) - 1)), (255, 255, 255))
    y = 0
    for part in parts:
        canvas.paste(part, (0, y))
        y += part.height + gap
    return canvas


@dataclass
class _Call:
    """One model call: its answer (ModelText, or a plain str from a stub; None when it failed), wall time over all its
    attempts, the number of attempts and the error of a call that failed (after its retry, or at once on a timeout)."""
    text: object
    ms: int
    attempts: int = 1
    error: str | None = None


def _timed_call(png, prompt, max_tokens):
    """One model call, retried once after a transient Ollama error (HTTP 5xx, dropped / refused connection). A timed-out
    call is not retried (it already waited OCR_MODEL_TIMEOUT). A call that still fails returns `error` set (the caller
    degrades that section only); any other error propagates (HTTP 500)."""
    start = time.perf_counter()
    for attempt in (1, 2):
        try:
            return _Call(ocr_model.call_ocr(png, prompt, max_tokens), _ms(start), attempt)
        except Exception as error:
            if not ocr_model.is_transient(error):
                raise
            if attempt == 2 or ocr_model.is_timeout(error):
                return _Call(None, _ms(start), attempt, f"{type(error).__name__}: {error}")
        time.sleep(ocr_model.RETRY_DELAY_S)


def _run_calls(calls):
    """[(name, png, prompt, max tokens)] -> {name: _Call}, run concurrently (OCR_SECTION_PARALLELISM)."""
    with ThreadPoolExecutor(max_workers=min(section_parallelism(), len(calls))) as pool:
        futures = [(name, pool.submit(_timed_call, png, prompt, tokens)) for name, png, prompt, tokens in calls]
        return {name: future.result() for name, future in futures}


def _check_field(label, measurement, source="checkbox"):
    review = measurement["state"] != "checked" or measurement["confidence"] < M.REVIEW_BELOW
    return {**N.field(label, label, measurement["confidence"], source, review), "checked": True}


def _struck_field(results):
    """One marker for the boxes a stroke goes through (struck out = no selection): value null, needsReview."""
    struck = [label for _, label, m in results if m["state"] == "struck"]
    return {**N.field("struck out: " + ", ".join(struck), None, 0.35, "checkbox", True), "checked": True} if struck else None


def _hidden_field(results):
    """One marker for boxes that are not visible (covered): their choice is unknown, value null, needsReview."""
    hidden = [label for _, label, m in results if m["state"] == "unreadable"]
    return {**N.field("not visible: " + ", ".join(hidden), None, 0.3, "checkbox", True), "checked": True} if hidden else None


def _check_fields(results):
    fields = [_check_field(label, m) for _, label, m in results if m["state"] in ("checked", "ambiguous")]
    return fields + [marker for marker in (_struck_field(results), _hidden_field(results)) if marker]


def _single_choice(results):
    checked = [(label, m) for _, label, m in results if m["state"] == "checked"]
    ambiguous = [(label, m) for _, label, m in results if m["state"] == "ambiguous"]
    struck = _struck_field(results)
    hidden = any(m["state"] == "unreadable" for _, _, m in results)  # a box nobody can see may hold the real choice
    if len(checked) == 1 and not ambiguous:
        label, m = checked[0]
        return N.field(label, label, min(m["confidence"], 0.5) if hidden else m["confidence"], "checkbox",
                       m["confidence"] < M.REVIEW_BELOW or struck is not None or hidden)
    if len(checked) + len(ambiguous) == 1 or len(checked) == 1:  # one ambiguous mark, or one tick plus stray marks
        label, m = (checked or ambiguous)[0]
        return N.field(label, label, min(m["confidence"], 0.6), "checkbox", True)
    if checked or ambiguous:  # several boxes marked
        return N.field(", ".join(label for label, _ in checked + ambiguous), None, 0.3, "checkbox", True)
    if struck:
        return N.field(struck["raw"], None, 0.35, "checkbox", True)
    return N.field(None, None, min(m["confidence"] for _, _, m in results), "checkbox", True)  # nothing marked


def _body_fields(marks, kind):
    return [{**N.field(m["area"], m["area"], m["confidence"], "ink-mark", m["needsReview"]), "checked": True}
            for m in marks if m["kind"] == kind]


def _customer_text_fields(text_px, states, customer_raw, expected):
    parsed, fallback = N.parse_customer_text(customer_raw, expected) if customer_raw is not None else ({}, frozenset())
    out = {}
    for key in N.CUSTOMER_FIELDS:
        state, value = states[key], parsed.get(key)
        if state == "empty":
            confidence = 0.9 + 0.09 * (1 - text_px[key] / (M.TEXT_EMPTY_MAX + 1))
            out[key] = N.field(None, None, confidence, "ink-mark", False)
        elif not value:
            out[key] = N.field(None, None, 0.6, "ink-mark", True) if state == "uncertain" else N.field(None, None, 0.0, "none", True)
        elif key == "nationality":
            out[key] = N.normalize_nationality(value, key in fallback)
        else:
            out[key] = N.normalize_free_text(value, key in fallback)
    return out


def _any_review(node):
    if isinstance(node, dict):
        return node.get("needsReview") is True or any(_any_review(v) for v in node.values())
    if isinstance(node, list):
        return any(_any_review(v) for v in node)
    return False


def _flag(node, sources=None):
    """Mark fields for review: every checkbox / ink-mark field (layout doubtful), or every field (sources=None)."""
    if isinstance(node, dict):
        if "needsReview" in node and (sources is None or node.get("source") in sources):
            node["needsReview"] = True
        for value in node.values():
            _flag(value, sources)
    elif isinstance(node, list):
        for value in node:
            _flag(value, sources)


SECTIONS = ("header", "customerInformation", "recommendationCard", "staffOnly")


def _empty_sections():
    """Every section with its keys but nothing read (page not recognised as the template): all fields need review."""
    def none():
        return N.field(None, None, 0.0, "none", True)
    return {
        "header": {key: none() for key in N.HEADER_FIELDS},
        "customerInformation": {"name": none(), "gender": none(), "nationality": none(), "hotelName": none(),
                                "referralSources": [], "healthConditions": []},
        "recommendationCard": {"pressure": none(), "massageOilScrub": [], "preferredAreas": [], "avoidAreas": []},
        "staffOnly": {"treatments": [], "treatment": N.legacy_treatment(None, [], []), "therapistName": none(), "roomNo": none(),
                      "branch": none(), "totalMinutes": None},
    }


def _response(document_id, source_file, layout, sections, evidence, timings):
    result = {"documentId": document_id, "sourceFile": source_file, "engine": ENGINE, "version": VERSION, "schemaVersion": SCHEMA_VERSION,
              "layout": layout, **sections, "evidence": evidence, "timings": timings}
    result["needsReview"] = bool(layout["warnings"]) or any(_any_review(result[k]) for k in SECTIONS)
    return result


def _plain(text):
    return None if text is None else str(text)


def _model_calls(mode, crops, staff_img, customer_img):
    """The page's model calls for `mode` -> [(timings name, png, prompt, max tokens)]."""
    png = ocr_model.png_bytes
    if mode == "separate":  # v3.0: STAFF crop, customer rows (when written); no header
        return [("staffOnly", png(staff_img), ocr_model.STAFF_PROMPT, ocr_model.STAFF_MAX_TOKENS)] + (
            [("customerInformation", png(customer_img), ocr_model.CUSTOMER_PROMPT, ocr_model.CUSTOMER_MAX_TOKENS)] if customer_img else [])
    top = [crops.side_by_side(L.HEADER_CROP_PARTS), *([customer_img] if customer_img else [])]  # header, customer rows when written
    if mode == "combined":  # v3.1: one image, the STAFF crop at the bottom
        return [("combined", png(_stack([*top, staff_img])), ocr_model.COMBINED_PROMPT, ocr_model.COMBINED_MAX_TOKENS)]
    return [("staffOnly", png(staff_img), ocr_model.STAFF_VOCAB_PROMPT, ocr_model.STAFF_MAX_TOKENS),
            ("headerCustomer", png(_stack(top)), ocr_model.HEADER_CUSTOMER_PROMPT, ocr_model.HEADER_CUSTOMER_MAX_TOKENS)]


def _read_answers(mode, outputs):
    """The calls' answers -> {staff, header, customer: the answer each section is read from (None: not read or its call
    failed), staffRaw, headerRaw, customerRaw: the parsers' inputs, combinedRaw: the combined / header+customer answer}."""
    ok = {name: call.text for name, call in outputs.items() if call.error is None}
    read = {"staff": None, "header": None, "customer": None, "staffRaw": None, "headerRaw": dict.fromkeys(N.HEADER_FIELDS),
            "customerRaw": None, "combinedRaw": None}
    if mode == "combined" and "combined" in ok:
        answer = ok["combined"]
        customer_part, staff_part = N.split_combined_text(answer)
        header_raw, customer_raw = N.extract_header_fields(customer_part)
        read.update(staff=answer, header=answer, customer=answer, staffRaw=staff_part, headerRaw=header_raw, customerRaw=customer_raw,
                    combinedRaw=answer)
    elif mode == "staff-separate":
        read.update(staff=ok.get("staffOnly"), staffRaw=ok.get("staffOnly"))
        if "headerCustomer" in ok:
            answer = ok["headerCustomer"]
            header_raw, customer_raw = N.extract_header_fields(answer)
            read.update(header=answer, customer=answer, headerRaw=header_raw, customerRaw=customer_raw, combinedRaw=answer)
    elif mode == "separate":
        read.update(staff=ok.get("staffOnly"), staffRaw=ok.get("staffOnly"), customer=ok.get("customerInformation"),
                    customerRaw=ok.get("customerInformation"))
    return read


def process_image(image, document_id, source_file, started, extra_warnings=()):
    """Full-document OCR of one decoded RGB page -> schema v3 (version 3.2) response dict."""
    t_pre = time.perf_counter()
    width, height = image.size
    layout = L.describe_layout(width, height)
    layout["warnings"].extend(extra_warnings)
    ref = image if image.size == (L.REF_W, L.REF_H) else image.resize((L.REF_W, L.REF_H), Image.BILINEAR)
    lum = ref.convert("L")
    geo, detection = R.register(np.asarray(M.border_darkness(ref, lum)))
    layout["detection"] = detection
    if detection["verdict"] == "unknown":  # not this form: no template crop, no checkbox reading (generic path: Release 3)
        layout["warnings"].append(f"page is not recognised as {L.TEMPLATE} (template score {detection['score']}); no field was read")
        evidence = {"staffCropRaw": None, "customerCropRaw": None, "combinedRaw": None, "checkboxScores": {}}
        preprocess_ms = _ms(t_pre)
        timings = {"preprocessMs": preprocess_ms, "checkboxMs": 0, "inferenceMs": 0, "inferenceWallMs": 0, "normalizeMs": 0,
                   "totalMs": _ms(started), "sections": []}
        return _response(document_id, source_file, layout, _empty_sections(), evidence, timings)
    if detection["verdict"] == "uncertain":
        layout["warnings"].append(f"printed checkbox grid of {L.TEMPLATE} matches only weakly (template score {detection['score']}); "
                                  "every field needs review")
    mask, _ = M.ink_mask(ref, lum, geo)
    text_px = M.text_ink(mask, geo)
    header_px = M.text_ink(mask, geo, L.HEADER_TEXT_BOXES, L.HEADER_BESIDE_ZONES)
    text_states = {key: M.text_state(px) for key, px in text_px.items()}
    header_states = {key: M.text_state(px) for key, px in header_px.items()}
    expected = tuple(key for key in N.CUSTOMER_FIELDS if text_states[key] != "empty")
    crops = _Crops(image, geo)
    mode = section_mode()
    staff_img = crops.rows([L.STAFF_CROP], clamp=False)
    customer_img = crops.rows(L.CUSTOMER_CROP_ROWS, customer_crop_scale()) if expected else None
    calls = _model_calls(mode, crops, staff_img, customer_img)
    preprocess_ms = _ms(t_pre)

    t_inference = time.perf_counter()
    with ThreadPoolExecutor(max_workers=min(section_parallelism(), len(calls))) as pool:
        futures = [(name, pool.submit(_timed_call, png, prompt, tokens)) for name, png, prompt, tokens in calls]
        t_checkbox = time.perf_counter()  # deterministic analysis overlaps the model calls
        checkboxes = M.detect_checkboxes(mask, geo)
        body_marks = M.detect_body_marks(mask, lum, geo)
        checkbox_ms = _ms(t_checkbox)
        outputs = {name: future.result() for name, future in futures}
    if all(call.error for call in outputs.values()):  # only a page with no answer at all fails (HTTP 500, the worker retries)
        raise RuntimeError("every model call failed: " + "; ".join(f"{name}: {call.error}" for name, call in outputs.items()))
    read = _read_answers(mode, outputs)
    # Re-read a section alone with its proven prompt when its answer lost it: no staff label at all, or written customer
    # boxes with no value parsed (Typhoon occasionally answers with its own training prompt).
    fallbacks = []
    if mode != "separate" and read["staff"] is not None and not any(N.extract_staff_fields(read["staffRaw"])):
        fallbacks.append(("staffOnlyFallback", ocr_model.png_bytes(staff_img), ocr_model.STAFF_PROMPT, ocr_model.STAFF_MAX_TOKENS))
    if mode != "separate" and expected and read["customer"] is not None and not any(N.parse_customer_text(read["customerRaw"], expected)[0].values()):
        fallbacks.append(("customerInformationFallback", ocr_model.png_bytes(customer_img), ocr_model.CUSTOMER_PROMPT, ocr_model.CUSTOMER_MAX_TOKENS))
    if fallbacks:
        outputs.update(_run_calls(fallbacks))
        for name, key in (("staffOnlyFallback", "staff"), ("customerInformationFallback", "customer")):
            if name in outputs and outputs[name].error is None:
                read.update({key: outputs[name].text, f"{key}Raw": outputs[name].text})
    if not expected:
        read.update(customer=None, customerRaw=None)
    failed = [name for name, call in outputs.items() if call.error]
    inference_wall_ms = _ms(t_inference)
    layout["warnings"].extend(M.implausible_checkboxes(checkboxes))
    layout["warnings"].extend(M.hidden_checkboxes(checkboxes))

    t_normalize = time.perf_counter()
    staff_raw, customer_raw = read["staffRaw"], read["customerRaw"]
    branch = N.detect_branch(staff_raw)
    treatment_raw, therapist_raw, room_raw = N.extract_staff_fields(staff_raw)
    treatments, durations, treatment_warnings, total_minutes = N.parse_treatments(treatment_raw)
    text_fields = _customer_text_fields(text_px, text_states, customer_raw, expected)
    header = N.header_fields(read["headerRaw"], header_states, read=mode != "separate")
    customer = {"name": text_fields["name"], "gender": _single_choice(checkboxes["gender"]), "nationality": text_fields["nationality"],
                "hotelName": text_fields["hotelName"], "referralSources": _check_fields(checkboxes["referralSources"]),
                "healthConditions": _check_fields(checkboxes["healthConditions"])}
    recommendation = {"pressure": _single_choice(checkboxes["pressure"]), "massageOilScrub": _check_fields(checkboxes["massageOilScrub"]),
                      "preferredAreas": _body_fields(body_marks, "circle"), "avoidAreas": _body_fields(body_marks, "cross")}
    staff = {"treatments": treatments, "treatment": None, "therapistName": N.normalize_therapist(therapist_raw, branch["value"]),
             "roomNo": N.normalize_room(room_raw), "branch": branch, "totalMinutes": total_minutes}
    sections_out = {"header": header, "customerInformation": customer, "recommendationCard": recommendation, "staffOnly": staff}
    token_confidence = C.apply(sections_out, {key: read[key] for key in ("header", "customer", "staff")})
    staff["treatment"] = N.legacy_treatment(treatment_raw, treatments, durations)  # after the items' model confidence
    if detection["verdict"] == "uncertain":
        for section in sections_out.values():
            _flag(section)
    elif layout["warnings"]:
        for section in (header, customer, recommendation):
            _flag(section, ("checkbox", "ink-mark"))
    for name in failed:  # the fields of a section whose call failed after its retry: nothing read, all for review
        if name.startswith("staffOnly"):
            _flag(staff)
        if name in ("headerCustomer", "combined"):
            _flag(header)
        if name in ("headerCustomer", "combined") or name.startswith("customerInformation"):
            for key in N.CUSTOMER_FIELDS:
                customer[key]["needsReview"] = True
        layout["warnings"].append(f"model call {name} failed after {outputs[name].attempts} attempt(s) ({outputs[name].error}); "
                                  "its fields need review")
    evidence = {
        "staffCropRaw": _plain(staff_raw), "customerCropRaw": _plain(customer_raw if mode == "combined" else read["customer"]),
        "combinedRaw": _plain(read["combinedRaw"]),
        "checkboxScores": {f"{group}.{key}": round(m["score"], 3) for group, items in checkboxes.items() for key, _, m in items},
        "checkboxNotes": {f"{group}.{key}": m["note"] for group, items in checkboxes.items() for key, _, m in items if m["note"]},
        "bodyMap": [{k: m[k] for k in ("area", "kind", "confidence", "pixels", "onLabel", "coverage", "center", "diagonal") if k in m}
                    for m in body_marks],
        "textInk": {**text_px, **header_px},
        "layoutOffset": {"dx": round(detection["dx"]), "dy": round(detection["dy"]), "contrast": detection["score"]},
        "stampPixelsRemoved": crops.stamp_pixels, "treatmentWarnings": treatment_warnings, "treatmentTotalMinutes": total_minutes,
        "tokenConfidence": token_confidence,
        "modelErrors": [{"call": name, "attempts": outputs[name].attempts, "error": outputs[name].error} for name in failed],
    }
    normalize_ms = _ms(t_normalize)
    section_timings = [{"name": name, "ms": call.ms, **({"attempts": call.attempts} if call.attempts > 1 else {}),
                        **({"failed": True} if call.error else {})} for name, call in outputs.items()]
    timings = {"preprocessMs": preprocess_ms, "checkboxMs": checkbox_ms, "inferenceMs": sum(t["ms"] for t in section_timings),
               "inferenceWallMs": inference_wall_ms, "normalizeMs": normalize_ms, "totalMs": _ms(started), "sections": section_timings}
    return _response(document_id, source_file, layout, sections_out, evidence, timings)


@app.get("/health")
def health():
    master_state = N.master_state()  # never raises: /health must answer
    calibration_state = C.calibration_state()  # likewise; "rejected: ..." = the review thresholds are the code defaults
    # Not "ok" while master data or the calibration file is broken, so OcrClient.healthCheck and monitoring see it
    # (HTTP stays 200). A rejected calibration file only flags MORE fields, so it degrades review load, not accuracy.
    return {"status": "ok" if master_state == "ok" and not calibration_state.startswith("rejected") else "degraded",
            "service": "innovera-ocr", "version": VERSION, "engine": ENGINE,
            "schemaVersion": SCHEMA_VERSION, "model": ocr_model.model_name(), "pdfSupport": _pdf_renderer() is not None,
            "masterData": master_state, "calibration": calibration_state}


@app.post("/v1/ocr")
def ocr(file: UploadFile = File(...)):
    started = time.perf_counter()
    filename = file.filename or "upload"
    ext = Path(filename).suffix.lower() or MIME_EXTENSIONS.get((file.content_type or "").split(";")[0].strip().lower(), "")
    if ext not in IMAGE_EXTENSIONS and ext != ".pdf":
        raise HTTPException(400, "Only PNG/JPG/JPEG/WebP (and PDF when a renderer is installed) are supported")
    limit = max_upload_bytes()
    data = file.file.read(limit + 1)
    if len(data) > limit:
        raise HTTPException(413, f"File larger than {limit} bytes")
    ext = _sniff_extension(data, ext)
    if ext == ".pdf" and _pdf_renderer() is None:
        raise HTTPException(415, "PDF input needs pypdfium2 or PyMuPDF in the Local AI image; upload PNG/JPG/WebP instead")
    document_id = str(uuid.uuid4())
    try:
        directory = upload_dir()
        directory.mkdir(parents=True, exist_ok=True)
        (directory / f"{document_id}{ext}").write_bytes(data)
    except OSError as error:
        raise HTTPException(500, f"Cannot store the upload: {error}") from error
    image, warnings = _decode(data, ext)
    try:
        return JSONResponse(process_image(image, document_id, file.filename, started, warnings))
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(500, str(error)) from error


class ConfirmRequest(BaseModel):
    documentId: str
    field: str
    raw: str
    verifiedValue: str


@app.post("/v1/ocr/confirm")
def confirm_ocr(data: ConfirmRequest):
    """AUDIT-ONLY since W3a (accuracy-learning-plan.md §3 W3a, §2.5). The confirmation is appended to
    `corrections.jsonl` exactly as before -- the file, its format and the whole history stay -- but
    `ocr_normalize.VERIFIED_MEMORY_ENABLED` is False, so nothing written here can change a later reading, a confidence
    or a review flag. `applied: false` in the response says so to the caller; the app's outbox still treats a 200 as
    delivered, which is correct: the record IS stored. Re-applying confirmations is W3b-W3e's voted store, not this."""
    if data.field not in ("treatment", "therapist"):
        raise HTTPException(400, "field must be treatment or therapist")
    record = {"timestamp": datetime.now(timezone.utc).isoformat(), "documentId": data.documentId, "field": data.field,
              "ocrRaw": data.raw, "verifiedValue": data.verifiedValue, "verifiedByHuman": True}
    N.append_verified(record)
    return {"status": "saved", "applied": False, "mode": "audit-only", "record": record}
