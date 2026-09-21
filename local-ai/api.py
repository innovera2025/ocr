"""INNOVERA Local AI OCR service — schema v3 ("typhoon-sections").

Full-document extraction for the Makkha intake form: deterministic checkbox / body-map / empty-box detection plus
two concurrent Typhoon OCR section calls (STAFF ONLY and CUSTOMER INFORMATION handwriting).
"""

import functools
import io
import os
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from PIL import Image, ImageOps, UnidentifiedImageError
from pydantic import BaseModel

import ocr_layout as L
import ocr_marks as M
import ocr_model
import ocr_normalize as N

VERSION, ENGINE, SCHEMA_VERSION = "3.0", "typhoon-sections", 3
app = FastAPI(title="INNOVERA OCR API", version=VERSION)

IMAGE_EXTENSIONS = (".png", ".jpg", ".jpeg", ".webp")
MIME_EXTENSIONS = {"image/png": ".png", "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/webp": ".webp", "application/pdf": ".pdf"}
TEMPLATE_MIN_CONTRAST = 15  # mean printed-checkbox ring contrast below this => not the expected form / badly aligned


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


def _ms(start, end=None):
    return int(round(((end if end is not None else time.perf_counter()) - start) * 1000))


@functools.lru_cache(maxsize=1)
def _pdf_renderer():
    """First-page PDF renderer using pypdfium2 or PyMuPDF when importable, else None (PDF => HTTP 415)."""
    try:
        import pypdfium2 as pdfium

        def render_pdfium(data):
            pdf = pdfium.PdfDocument(data)
            try:
                page = pdf[0]
                width_pt, height_pt = page.get_size()
                scale = max(0.5, min(6.0, 2 * L.REF_W / max(width_pt, height_pt)))
                return page.render(scale=scale).to_pil().convert("RGB"), len(pdf)
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
                zoom = max(0.5, min(6.0, 2 * L.REF_W / max(page.rect.width, page.rect.height)))
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
            image, pages = _pdf_renderer()(data)
        except Exception as error:  # renderer-specific error types
            raise HTTPException(400, f"Cannot render the uploaded PDF: {error}") from error
        if pages > 1:
            warnings.append(f"PDF has {pages} pages; only page 1 was processed")
        return image, warnings
    try:
        image = Image.open(io.BytesIO(data))
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


def _model_crop(image, rows, sx, sy, dx, dy, scale=1.0, clamp=True):
    """Crop reference rows (scaled + registered) from the original image; stack them vertically; PNG bytes.
    clamp=False keeps v2.2's behaviour for the STAFF crop (Pillow pads rows beyond the page with black)."""
    width, height = image.size
    parts = [image.crop(L.scale_box(row, sx, sy, dx, dy, width if clamp else None, height if clamp else None)) for row in rows]
    if len(parts) == 1:
        crop = parts[0]
    else:
        crop = Image.new("RGB", (max(p.width for p in parts), sum(p.height for p in parts) + 4 * (len(parts) - 1)), (255, 255, 255))
        y = 0
        for part in parts:
            crop.paste(part, (0, y))
            y += part.height + 4
    limit = 2 * max(r[2] - r[0] for r in rows)  # never send more than 2x reference resolution
    factor = min(scale, limit / crop.width) if crop.width else scale
    if abs(factor - 1.0) > 1e-3:
        crop = crop.resize((max(1, round(crop.width * factor)), max(1, round(crop.height * factor))), Image.LANCZOS)
    return ocr_model.png_bytes(crop)


def _timed_call(png, prompt, max_tokens):
    start = time.perf_counter()
    text = ocr_model.call_ocr(png, prompt, max_tokens)
    return text, _ms(start)


def _check_field(label, measurement, source="checkbox"):
    review = measurement["state"] != "checked" or measurement["confidence"] < M.REVIEW_BELOW
    return {**N.field(label, label, measurement["confidence"], source, review), "checked": True}


def _check_fields(results):
    return [_check_field(label, m) for _, label, m in results if m["state"] in ("checked", "ambiguous")]


def _single_choice(results):
    checked = [(label, m) for _, label, m in results if m["state"] == "checked"]
    ambiguous = [(label, m) for _, label, m in results if m["state"] == "ambiguous"]
    if len(checked) == 1 and not ambiguous:
        label, m = checked[0]
        return N.field(label, label, m["confidence"], "checkbox", m["confidence"] < M.REVIEW_BELOW)
    if len(checked) + len(ambiguous) == 1 or len(checked) == 1:  # one ambiguous mark, or one tick plus stray marks
        label, m = (checked or ambiguous)[0]
        return N.field(label, label, min(m["confidence"], 0.6), "checkbox", True)
    if checked or ambiguous:  # several boxes marked
        return N.field(", ".join(label for label, _ in checked + ambiguous), None, 0.3, "checkbox", True)
    return N.field(None, None, min(m["confidence"] for _, _, m in results), "checkbox", True)  # nothing marked


def _body_fields(marks, kind):
    return [{**N.field(m["area"], m["area"], m["confidence"], "ink-mark", m["needsReview"]), "checked": True}
            for m in marks if m["kind"] == kind]


def _customer_text_fields(text_px, states, customer_raw, expected):
    parsed, fallback = N.parse_customer_text(customer_raw, expected) if customer_raw is not None else ({}, False)
    out = {}
    for key in N.CUSTOMER_FIELDS:
        state, value = states[key], parsed.get(key)
        if state == "empty":
            confidence = 0.9 + 0.09 * (1 - text_px[key] / (M.TEXT_EMPTY_MAX + 1))
            out[key] = N.field(None, None, confidence, "ink-mark", False)
        elif not value:
            out[key] = N.field(None, None, 0.6, "ink-mark", True) if state == "uncertain" else N.field(None, None, 0.0, "none", True)
        elif key == "nationality":
            out[key] = N.normalize_nationality(value, fallback)
        else:
            out[key] = N.normalize_free_text(value, fallback)
    return out


def _any_review(node):
    if isinstance(node, dict):
        return node.get("needsReview") is True or any(_any_review(v) for v in node.values())
    if isinstance(node, list):
        return any(_any_review(v) for v in node)
    return False


def _flag_deterministic(node):
    """Layout is doubtful: every checkbox / ink-mark field needs review."""
    if isinstance(node, dict):
        if node.get("source") in ("checkbox", "ink-mark"):
            node["needsReview"] = True
        for value in node.values():
            _flag_deterministic(value)
    elif isinstance(node, list):
        for value in node:
            _flag_deterministic(value)


def process_image(image, document_id, source_file, started, extra_warnings=()):
    """Full-document OCR of one decoded RGB page -> schema v3 response dict."""
    t_pre = time.perf_counter()
    width, height = image.size
    layout = L.describe_layout(width, height)
    layout["warnings"].extend(extra_warnings)
    ref = image if image.size == (L.REF_W, L.REF_H) else image.resize((L.REF_W, L.REF_H), Image.BILINEAR)
    lum = ref.convert("L")
    dx, dy, contrast = M.register(M.border_darkness(ref, lum))
    if contrast < TEMPLATE_MIN_CONTRAST:
        layout["warnings"].append(f"printed checkbox grid of {L.TEMPLATE} not found (contrast {contrast}); results are unreliable")
    mask, _ = M.ink_mask(ref, lum, dx, dy)
    text_px = M.text_ink(mask, dx, dy)
    text_states = {key: M.text_state(px) for key, px in text_px.items()}
    expected = tuple(key for key in N.CUSTOMER_FIELDS if text_states[key] != "empty")
    sx, sy = width / L.REF_W, height / L.REF_H
    sections = [("staffOnly", _model_crop(image, [L.STAFF_CROP], sx, sy, dx, dy, clamp=False), ocr_model.STAFF_PROMPT, ocr_model.STAFF_MAX_TOKENS)]
    if expected:  # no model call when every handwriting box is blank
        sections.append(("customerInformation", _model_crop(image, L.CUSTOMER_CROP_ROWS, sx, sy, dx, dy, customer_crop_scale()),
                         ocr_model.CUSTOMER_PROMPT, ocr_model.CUSTOMER_MAX_TOKENS))
    preprocess_ms = _ms(t_pre)

    t_inference = time.perf_counter()
    with ThreadPoolExecutor(max_workers=min(section_parallelism(), len(sections))) as pool:
        futures = [(name, pool.submit(_timed_call, png, prompt, tokens)) for name, png, prompt, tokens in sections]
        t_checkbox = time.perf_counter()  # deterministic analysis overlaps the model calls
        checkboxes = M.detect_checkboxes(mask, dx, dy)
        body_marks = M.detect_body_marks(mask, lum, dx, dy)
        checkbox_ms = _ms(t_checkbox)
        outputs = {name: future.result() for name, future in futures}
    inference_wall_ms = _ms(t_inference)

    t_normalize = time.perf_counter()
    staff_raw = outputs["staffOnly"][0]
    customer_raw = outputs["customerInformation"][0] if "customerInformation" in outputs else None
    treatment_raw, therapist_raw, room_raw = N.extract_staff_fields(staff_raw)
    treatments, durations, treatment_warnings, total_minutes = N.parse_treatments(treatment_raw)
    text_fields = _customer_text_fields(text_px, text_states, customer_raw, expected)
    customer = {"name": text_fields["name"], "gender": _single_choice(checkboxes["gender"]), "nationality": text_fields["nationality"],
                "hotelName": text_fields["hotelName"], "referralSources": _check_fields(checkboxes["referralSources"]),
                "healthConditions": _check_fields(checkboxes["healthConditions"])}
    recommendation = {"pressure": _single_choice(checkboxes["pressure"]), "massageOilScrub": _check_fields(checkboxes["massageOilScrub"]),
                      "preferredAreas": _body_fields(body_marks, "circle"), "avoidAreas": _body_fields(body_marks, "cross")}
    staff = {"treatments": treatments, "treatment": N.legacy_treatment(treatment_raw, treatments, durations),
             "therapistName": N.normalize_therapist(therapist_raw), "roomNo": N.normalize_room(room_raw)}
    if layout["warnings"]:
        _flag_deterministic(customer)
        _flag_deterministic(recommendation)
    evidence = {
        "staffCropRaw": staff_raw, "customerCropRaw": customer_raw,
        "checkboxScores": {f"{group}.{key}": round(m["score"], 3) for group, items in checkboxes.items() for key, _, m in items},
        "checkboxNotes": {f"{group}.{key}": m["note"] for group, items in checkboxes.items() for key, _, m in items if m["note"]},
        "bodyMap": [{k: m[k] for k in ("area", "kind", "confidence", "pixels", "onLabel", "coverage", "center", "diagonal") if k in m}
                    for m in body_marks],
        "textInk": text_px, "layoutOffset": {"dx": dx, "dy": dy, "contrast": contrast},
        "treatmentWarnings": treatment_warnings, "treatmentTotalMinutes": total_minutes,
    }
    normalize_ms = _ms(t_normalize)
    section_timings = [{"name": name, "ms": ms} for name, (_, ms) in outputs.items()]
    result = {
        "documentId": document_id, "sourceFile": source_file, "engine": ENGINE, "version": VERSION, "schemaVersion": SCHEMA_VERSION,
        "layout": layout, "customerInformation": customer, "recommendationCard": recommendation, "staffOnly": staff, "evidence": evidence,
        "timings": {"preprocessMs": preprocess_ms, "checkboxMs": checkbox_ms, "inferenceMs": sum(t["ms"] for t in section_timings),
                    "inferenceWallMs": inference_wall_ms, "normalizeMs": normalize_ms, "totalMs": _ms(started), "sections": section_timings},
    }
    result["needsReview"] = bool(layout["warnings"]) or any(_any_review(result[k]) for k in ("customerInformation", "recommendationCard", "staffOnly"))
    return result


@app.get("/health")
def health():
    try:
        N.master()
        master_state = "ok"
    except Exception as error:  # reported, not raised: /health must answer
        master_state = f"error: {error}"
    return {"status": "ok", "service": "innovera-ocr", "version": VERSION, "engine": ENGINE, "schemaVersion": SCHEMA_VERSION,
            "model": ocr_model.model_name(), "pdfSupport": _pdf_renderer() is not None, "masterData": master_state}


@app.post("/v1/ocr")
def ocr(file: UploadFile = File(...)):
    started = time.perf_counter()
    filename = file.filename or "upload"
    ext = Path(filename).suffix.lower() or MIME_EXTENSIONS.get((file.content_type or "").split(";")[0].strip().lower(), "")
    if ext not in IMAGE_EXTENSIONS and ext != ".pdf":
        raise HTTPException(400, "Only PNG/JPG/JPEG/WebP (and PDF when a renderer is installed) are supported")
    if ext == ".pdf" and _pdf_renderer() is None:
        raise HTTPException(415, "PDF input needs pypdfium2 or PyMuPDF in the Local AI image; upload PNG/JPG/WebP instead")
    limit = max_upload_bytes()
    data = file.file.read(limit + 1)
    if len(data) > limit:
        raise HTTPException(413, f"File larger than {limit} bytes")
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
    if data.field not in ("treatment", "therapist"):
        raise HTTPException(400, "field must be treatment or therapist")
    record = {"timestamp": datetime.now(timezone.utc).isoformat(), "documentId": data.documentId, "field": data.field,
              "ocrRaw": data.raw, "verifiedValue": data.verifiedValue, "verifiedByHuman": True}
    N.append_verified(record)
    return {"status": "saved", "record": record}
