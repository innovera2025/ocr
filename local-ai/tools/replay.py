"""Replay a stored v3 response through the CURRENT text pipeline, with no model call and no page image.

`api.process_image` does three separable things: it reads the page image (ink masks, checkboxes, body marks), it calls the
model, and it runs the model's answers through `ocr_normalize` + `ocr_confidence`. The stored response keeps every input of
that third part -- the raw answers (`evidence.staffCropRaw`, `.customerCropRaw`, `.combinedRaw`), the handwriting-box ink
counts (`evidence.textInk`) and the per-field token statistics (`evidence.tokenConfidence`) -- so the parsing/normalisation
stage can be re-run exactly, on any number of archived pages, for free.

What is REPLAYED (rebuilt by today's code):  header.formNumber/date/time, customerInformation.name/nationality/hotelName,
staffOnly.treatments/therapistName/roomNo/branch/totalMinutes.
What is COPIED from the stored response: every image-derived field -- gender, referralSources, healthConditions, pressure,
massageOilScrub, preferredAreas, avoidAreas. They need the page pixels, which this replay deliberately does not have (the
archived production renders are 1610 px and are not available offline yet; see the plan's G0).

The confidence gate is replayed from `evidence.tokenConfidence` rather than from logprobs, because the responses store the
per-field statistics and not the tokens. That is exact while a variant leaves the field's `raw` string unchanged: the stored
statistics were measured over the span of that exact string. `replay_page` therefore reports `staleGate` for every field
whose replayed `raw` differs from production's, so a caller never scores a gate decision that no longer has evidence.
"""

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE.parent)]
sys.dont_write_bytecode = True

import api  # noqa: E402
import ocr_confidence as C  # noqa: E402
import ocr_marks as M  # noqa: E402
import ocr_normalize as N  # noqa: E402

# Field path -> confidence kind, exactly as ocr_confidence.apply walks them.
SCALAR_KINDS = (("header.formNumber", "formNumber"), ("header.date", "date"), ("header.time", "time"),
                ("customerInformation.name", "name"), ("customerInformation.nationality", "nationality"),
                ("customerInformation.hotelName", "hotelName"),
                ("staffOnly.therapistName", "therapist"), ("staffOnly.roomNo", "room"))
COPIED = (("customerInformation", "gender"), ("customerInformation", "referralSources"), ("customerInformation", "healthConditions"),
          ("recommendationCard", "pressure"), ("recommendationCard", "massageOilScrub"),
          ("recommendationCard", "preferredAreas"), ("recommendationCard", "avoidAreas"))


def section_mode(result):
    """The OCR_SECTION_MODE the stored page ran under, from the model calls it made."""
    names = [s["name"] for s in result["timings"]["sections"]]
    if "combined" in names:
        return "combined"
    return "staff-separate" if "headerCustomer" in names else "separate"


def _answers(result, mode):
    """The parsers' inputs, as `api._read_answers` built them for this page: (staffRaw, headerRaw, customerRaw)."""
    ev = result["evidence"]
    names = [s["name"] for s in result["timings"]["sections"]]
    empty_header = dict.fromkeys(N.HEADER_FIELDS)
    if mode == "combined":
        if ev["combinedRaw"] is None:
            return ev["staffCropRaw"], empty_header, None
        customer_part, staff_part = N.split_combined_text(ev["combinedRaw"])
        header_raw, customer_raw = N.extract_header_fields(customer_part)
        return staff_part, header_raw, customer_raw
    if mode == "separate":
        return ev["staffCropRaw"], empty_header, ev["customerCropRaw"]
    header_raw, customer_raw = N.extract_header_fields(ev["combinedRaw"]) if ev["combinedRaw"] is not None else (empty_header, None)
    if "customerInformationFallback" in names:  # the re-read answer replaced both `customer` and `customerRaw`
        customer_raw = ev["customerCropRaw"]
    return ev["staffCropRaw"], header_raw, customer_raw


def _gate(field, kind, stats):
    """`ocr_confidence.apply`'s effect on one field, from its stored statistics. Returns the outcome for the audit trail."""
    if not field.get("raw") or field.get("source") in C._SKIP_SOURCES:
        return "not-read"
    if stats is None:
        return "no-stats"  # the answer had no usable logprobs, or the value was not found in it: the rule confidence stands
    model_confidence = stats["min"] if kind in C.DIGIT_KINDS else stats["mean"]
    field["confidence"] = round(min(field["confidence"], model_confidence), 3)
    if model_confidence < C.threshold(kind) or stats["min"] < C.threshold("token"):
        field["needsReview"] = True
    return "applied"


def _stored(result, path):
    node = result
    for part in path.split("."):
        node = node[int(part)] if part.isdigit() else node[part]
    return node


def replay_page(result):
    """Stored response -> ({header, customerInformation, recommendationCard, staffOnly}, notes).

    `notes.staleGate` lists the confidence keys whose stored statistics no longer describe the replayed value (the field's
    `raw` changed, or the treatment item count changed, so the span the statistics were measured over is gone). `notes.gate`
    records what the gate did per key. Nothing in here consults a page image or the model.
    """
    ev, mode = result["evidence"], section_mode(result)
    staff_raw, header_raw, customer_raw = _answers(result, mode)
    ink = ev["textInk"]
    states = {key: M.text_state(ink[key]) for key in N.CUSTOMER_FIELDS}
    header_states = {key: M.text_state(ink[key]) for key in ("date", "time") if key in ink}
    expected = tuple(key for key in N.CUSTOMER_FIELDS if states[key] != "empty")
    if not expected:
        customer_raw = None

    branch = N.detect_branch(staff_raw)
    treatment_raw, therapist_raw, room_raw = N.extract_staff_fields(staff_raw)
    treatments, _durations, _warnings, total_minutes = N.parse_treatments(treatment_raw)
    text_fields = api._customer_text_fields({key: ink[key] for key in N.CUSTOMER_FIELDS}, states, customer_raw, expected)
    header = N.header_fields(header_raw, header_states, read=mode != "separate")
    customer = {"name": text_fields["name"], "nationality": text_fields["nationality"], "hotelName": text_fields["hotelName"]}
    staff = {"treatments": treatments, "therapistName": N.normalize_therapist(therapist_raw, branch["value"]),
             "roomNo": N.normalize_room(room_raw), "branch": branch, "totalMinutes": total_minutes}
    sections = {"header": header, "customerInformation": customer, "recommendationCard": {}, "staffOnly": staff}
    for section, key in COPIED:  # image-derived: no page pixels here, so production's own answer stands
        sections[section][key] = result[section][key]

    token_confidence = ev.get("tokenConfidence") or {}
    notes = {"mode": mode, "gate": {}, "staleGate": [], "treatmentCountChanged": False}
    for path, kind in SCALAR_KINDS:
        section, name = path.split(".")
        field = sections[section][name]
        if (field.get("raw") or None) != (_stored(result, path).get("raw") or None):
            notes["staleGate"].append(path)
        notes["gate"][path] = _gate(field, kind, token_confidence.get(path))
    stored_items = result["staffOnly"]["treatments"]
    notes["treatmentCountChanged"] = len(stored_items) != len(treatments)
    for index, item in enumerate(treatments):
        path = f"staffOnly.treatments.{index}"
        stale = notes["treatmentCountChanged"] or (item.get("raw") or None) != (stored_items[index].get("raw") or None)
        if stale:
            notes["staleGate"].append(path)
        notes["gate"][path] = _gate(item, "treatment", token_confidence.get(path))
    return sections, notes


# ------------------------------------------------------------------ fidelity: does the replay reproduce production?

FIDELITY_SCALARS = ("header.formNumber", "header.date", "header.time", "customerInformation.name", "customerInformation.nationality",
                    "customerInformation.hotelName", "staffOnly.therapistName", "staffOnly.roomNo", "staffOnly.branch")
FIDELITY_ATTRS = ("value", "raw", "source", "confidence", "needsReview")


def _compare(got, want, path, out):
    for attr in FIDELITY_ATTRS:
        a, b = got.get(attr), want.get(attr)
        if (a or None) != (b or None) if attr in ("value", "raw") else a != b:
            # `source` is an enum and safe to report; a value or a raw reading is customer data and is never carried out.
            out.append((path, attr, a, b) if attr == "source" else (path, attr, None, None))


def fidelity(result, sections):
    """[(field path, attribute, replayed, production)] where the replay disagrees with the stored production response.
    Empty = the replay reproduced the page exactly. Only the `source` enum is carried out; values never are."""
    out = []
    for path in FIDELITY_SCALARS:
        section, name = path.split(".")
        _compare(sections[section][name], _stored(result, path), path, out)
    stored_items, items = result["staffOnly"]["treatments"], sections["staffOnly"]["treatments"]
    if len(stored_items) != len(items):
        out.append(("staffOnly.treatments", "count", len(items), len(stored_items)))
    else:
        for index, (item, stored_item) in enumerate(zip(items, stored_items)):
            _compare(item, stored_item, f"staffOnly.treatments.{index}", out)
            if item.get("durationMinutes") != stored_item.get("durationMinutes"):
                out.append((f"staffOnly.treatments.{index}", "durationMinutes", None, None))
    if sections["staffOnly"]["totalMinutes"] != result["staffOnly"]["totalMinutes"]:
        out.append(("staffOnly.totalMinutes", "value", None, None))
    return out
