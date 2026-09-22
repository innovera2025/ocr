"""HTTP contract of the Local AI service (schema v3) with the model call mocked."""

import io
import json
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from PIL import Image, ImageDraw

import api
import ocr_layout
import synthetic_form as S
from conftest import CUSTOMER_TEXT, STAFF_TEXT, FakeModel, png_of

FIELD_KEYS = {"raw", "value", "confidence", "source", "needsReview"}
L_CHECKBOXES = ocr_layout.CHECKBOXES
SOURCES = {"ocr", "checkbox", "ink-mark", "rule", "master-fuzzy", "verified-memory", "none", "human"}


def post(client, data, filename="form.png", content_type="image/png"):
    return client.post("/v1/ocr", files={"file": (filename, data, content_type)})


def assert_field(value, extra=()):
    assert isinstance(value, dict) and FIELD_KEYS | set(extra) == set(value), value
    assert value["raw"] is None or isinstance(value["raw"], str)
    assert value["value"] is None or isinstance(value["value"], str)
    assert 0.0 <= value["confidence"] <= 1.0 and value["source"] in SOURCES and isinstance(value["needsReview"], bool)


def assert_v3_shape(body):
    assert list(body) == ["documentId", "sourceFile", "engine", "version", "schemaVersion", "layout", "customerInformation",
                          "recommendationCard", "staffOnly", "evidence", "timings", "needsReview"]
    assert body["engine"] == "typhoon-sections" and body["version"] == "3.0" and body["schemaVersion"] == 3
    assert set(body["layout"]) == {"template", "imageWidth", "imageHeight", "scaleX", "scaleY", "aspectMatch", "warnings"}
    customer = body["customerInformation"]
    assert list(customer) == ["name", "gender", "nationality", "hotelName", "referralSources", "healthConditions"]
    for key in ("name", "gender", "nationality", "hotelName"):
        assert_field(customer[key])
    recommendation = body["recommendationCard"]
    assert list(recommendation) == ["pressure", "massageOilScrub", "preferredAreas", "avoidAreas"]
    assert_field(recommendation["pressure"])
    for item in customer["referralSources"] + customer["healthConditions"] + recommendation["massageOilScrub"] + \
            recommendation["preferredAreas"] + recommendation["avoidAreas"]:
        assert_field(item, {"checked"})
        assert item["checked"] is True
    staff = body["staffOnly"]
    assert list(staff) == ["treatments", "treatment", "therapistName", "roomNo"]
    for item in staff["treatments"]:
        assert_field(item, {"nameRaw", "duration", "durationMinutes"})
    assert set(staff["treatment"]) == {"raw", "durations", "items", "needsReview"}
    assert staff["treatment"]["items"] == staff["treatments"]
    assert_field(staff["therapistName"])
    assert_field(staff["roomNo"])
    assert {"staffCropRaw", "customerCropRaw", "checkboxScores"} <= set(body["evidence"])
    assert all(isinstance(v, float) for v in body["evidence"]["checkboxScores"].values())
    assert len(body["evidence"]["checkboxScores"]) == 39
    timings = body["timings"]
    assert set(timings) == {"preprocessMs", "checkboxMs", "inferenceMs", "inferenceWallMs", "normalizeMs", "totalMs", "sections"}
    assert all(isinstance(timings[k], int) and timings[k] >= 0 for k in timings if k != "sections")
    assert timings["inferenceMs"] == sum(s["ms"] for s in timings["sections"])
    assert isinstance(body["needsReview"], bool)


def values(items):
    return [(i["value"], i["needsReview"]) for i in items]


def test_full_document_response_on_sample2(client, fake_model, sample_png):
    response = post(client, sample_png, "sample2.png")
    assert response.status_code == 200, response.text
    body = response.json()
    assert_v3_shape(body)
    assert body["sourceFile"] == "sample2.png"
    assert body["layout"]["aspectMatch"] and body["layout"]["warnings"] == []
    customer, recommendation, staff = body["customerInformation"], body["recommendationCard"], body["staffOnly"]
    assert customer["name"]["value"] == "Chun" and customer["name"]["source"] == "ocr" and not customer["name"]["needsReview"]
    assert customer["nationality"]["value"] == "Chinese" and not customer["nationality"]["needsReview"]
    hotel = customer["hotelName"]
    assert hotel == {"raw": None, "value": None, "confidence": hotel["confidence"], "source": "ink-mark", "needsReview": False}
    assert hotel["confidence"] >= 0.9
    assert customer["gender"]["value"] == "Female" and customer["gender"]["source"] == "checkbox" and not customer["gender"]["needsReview"]
    assert customer["referralSources"] == []
    assert values(customer["healthConditions"]) == [("Menstruation", False)]
    assert recommendation["pressure"]["value"] == "Standard" and not recommendation["pressure"]["needsReview"]
    assert values(recommendation["massageOilScrub"]) == [("Jasmine", True), ("Rose", True), ("Lavender", True)]  # scribbled row
    assert values(recommendation["preferredAreas"]) == [("Shoulder (front)", False), ("Neck (back)", False), ("Back (back)", False)]
    assert recommendation["avoidAreas"] == []
    assert [(t["nameRaw"], t["value"], t["duration"], t["durationMinutes"]) for t in staff["treatments"]] == \
        [("ไทย", "นวดไทย", "90 นาที", 90), ("หน้า", "นวดหน้า", "1 ชม.", 60)]
    assert staff["therapistName"]["value"] == "พีพี" and staff["roomNo"]["value"] == "3"
    assert body["evidence"]["staffCropRaw"] == STAFF_TEXT and body["evidence"]["customerCropRaw"] == CUSTOMER_TEXT
    assert body["evidence"]["combinedRaw"] == CUSTOMER_TEXT + "\n\n" + STAFF_TEXT
    assert 0.2 < body["evidence"]["checkboxScores"]["gender.female"] < 0.5
    assert body["evidence"]["checkboxScores"]["gender.male"] == 0.0
    assert body["needsReview"] is True  # the scribbled massage-oil row must be reviewed
    assert [s["name"] for s in body["timings"]["sections"]] == ["combined"]
    assert len(fake_model.calls) == 1


def test_legacy_v22_fields_keep_their_shape(client, fake_model):
    body = post(client, png_of(S.filled_form())).json()
    legacy = body["staffOnly"]["treatment"]
    assert legacy["raw"] == "ไทย 90 นาที + หน้า 1 ชม." and legacy["durations"] == ["90 นาที", "1 ชม."] and legacy["needsReview"] is False
    for item in legacy["items"]:  # v2.2 item keys are still there
        assert {"raw", "value", "duration", "confidence", "source", "needsReview"} <= set(item)
    assert body["staffOnly"]["therapistName"]["raw"] == "พีพี" and body["staffOnly"]["roomNo"]["raw"] == "3"
    assert body["evidence"]["staffCropRaw"] == STAFF_TEXT


def test_synthetic_form_full_shape_without_fixture(client, fake_model):
    body = post(client, png_of(S.filled_form())).json()
    assert_v3_shape(body)
    assert body["customerInformation"]["gender"]["value"] == "Female"
    assert values(body["customerInformation"]["healthConditions"]) == [("Menstruation", False)]
    assert body["recommendationCard"]["pressure"]["value"] == "Standard"
    assert values(body["recommendationCard"]["preferredAreas"]) == [("Shoulder (front)", False)]
    assert values(body["recommendationCard"]["avoidAreas"]) == [("Calf (back)", False)]
    assert body["needsReview"] is False


def test_empty_handwriting_boxes_skip_the_customer_model_call(client, fake_model):
    body = post(client, png_of(S.blank_form())).json()
    assert len(fake_model.calls) == 1 and "STAFF ONLY" in fake_model.calls[0]["prompt"]
    for key in ("name", "nationality", "hotelName"):
        field = body["customerInformation"][key]
        assert field["value"] is None and field["source"] == "ink-mark" and field["confidence"] >= 0.9 and not field["needsReview"]
    assert body["evidence"]["customerCropRaw"] is None
    assert [s["name"] for s in body["timings"]["sections"]] == ["staffOnly"]
    gender = body["customerInformation"]["gender"]
    assert gender["value"] is None and gender["needsReview"]  # single choice with nothing marked
    assert body["needsReview"] is True


def test_multiple_gender_marks_need_review(client, fake_model):
    image = S.filled_form()
    S.tick(ImageDraw.Draw(image), "gender", "male")
    gender = post(client, png_of(image)).json()["customerInformation"]["gender"]
    assert gender["value"] is None and gender["raw"] == "Male, Female" and gender["needsReview"]


def test_customer_text_written_in_box_but_unread_needs_review(client, monkeypatch):
    import ocr_model
    monkeypatch.setattr(ocr_model, "call_ocr", FakeModel(customer="Name:\nNationality:\nHotel Name:"))
    customer = post(client, png_of(S.filled_form())).json()["customerInformation"]
    assert customer["name"]["value"] is None and customer["name"]["needsReview"] and customer["name"]["source"] == "none"


def test_section_calls_run_concurrently(client, monkeypatch):
    import ocr_model
    monkeypatch.setenv("OCR_SECTION_MODE", "separate")
    monkeypatch.setattr(ocr_model, "call_ocr", FakeModel(delay=0.3))
    timings = post(client, png_of(S.filled_form())).json()["timings"]
    assert timings["inferenceMs"] >= 580 and timings["inferenceWallMs"] < 0.8 * timings["inferenceMs"]
    monkeypatch.setenv("OCR_SECTION_PARALLELISM", "1")
    timings = post(client, png_of(S.filled_form())).json()["timings"]
    assert timings["inferenceWallMs"] >= 0.95 * timings["inferenceMs"]


def test_therapist_verified_memory_round_trip(client, monkeypatch):
    import ocr_model
    monkeypatch.setattr(ocr_model, "call_ocr", FakeModel(staff="Treatment : ไทย 90 นาที\nTherapist Name : พิพิ\nRoom No. : 3"))
    first = post(client, png_of(S.filled_form())).json()
    therapist = first["staffOnly"]["therapistName"]
    # vowel-mark confusion: the master name is suggested, but only human memory makes it confident
    assert therapist["raw"] == "พิพิ" and therapist["value"] == "พีพี" and therapist["needsReview"] and therapist["source"] == "master-fuzzy"
    confirm = client.post("/v1/ocr/confirm", json={"documentId": first["documentId"], "field": "therapist", "raw": "พิพิ", "verifiedValue": "พีพี"})
    assert confirm.status_code == 200 and confirm.json()["status"] == "saved"
    assert confirm.json()["record"]["verifiedByHuman"] is True
    second = post(client, png_of(S.filled_form())).json()["staffOnly"]["therapistName"]
    assert second == {"raw": "พิพิ", "value": "พีพี", "confidence": 1.0, "source": "verified-memory", "needsReview": False}


def test_treatment_verified_memory_round_trip_uses_name_raw(client, monkeypatch):
    import ocr_model
    monkeypatch.setattr(ocr_model, "call_ocr", FakeModel(staff="Treatment : ใทบ 90 นาที + หน้า 1 ชม.\nTherapist Name : พีพี\nRoom No. : 3"))
    first = post(client, png_of(S.filled_form())).json()["staffOnly"]["treatments"][0]
    assert first["nameRaw"] == "ใทบ" and first["value"] is None and first["needsReview"]
    assert client.post("/v1/ocr/confirm", json={"documentId": "d", "field": "treatment", "raw": first["nameRaw"], "verifiedValue": "นวดไทย"}).status_code == 200
    again = post(client, png_of(S.filled_form())).json()["staffOnly"]["treatments"][0]
    assert again["value"] == "นวดไทย" and again["source"] == "verified-memory" and again["durationMinutes"] == 90 and not again["needsReview"]


def test_confirm_field_validation(client):
    bad = client.post("/v1/ocr/confirm", json={"documentId": "d", "field": "roomNo", "raw": "3", "verifiedValue": "3"})
    assert bad.status_code == 400 and bad.json()["detail"] == "field must be treatment or therapist"
    assert client.post("/v1/ocr/confirm", json={"documentId": "d", "field": "therapist", "raw": "x"}).status_code == 422
    assert not os.path.exists(os.environ["OCR_VERIFIED_FILE"])


def test_unsupported_type_is_400(client, fake_model):
    response = post(client, b"GIF89a....", "form.gif", "image/gif")
    assert response.status_code == 400 and "supported" in response.json()["detail"]
    assert fake_model.calls == []


def test_pdf_without_renderer_is_415(client, fake_model, monkeypatch):
    monkeypatch.setattr(api, "_pdf_renderer", lambda: None)
    response = post(client, b"%PDF-1.4\n%%EOF", "form.pdf", "application/pdf")
    assert response.status_code == 415 and "PDF" in response.json()["detail"]


def test_pdf_with_renderer_processes_first_page(client, fake_model, monkeypatch):
    monkeypatch.setattr(api, "_pdf_renderer", lambda: (lambda data: (S.filled_form(), 3)))
    body = post(client, b"%PDF-1.4 fake", "form.pdf", "application/pdf").json()
    assert body["customerInformation"]["gender"]["value"] == "Female"
    assert body["layout"]["warnings"] == ["PDF has 3 pages; only page 1 was processed"] and body["needsReview"]


def make_pdf(media_box=(0, 0, 595, 842), text=True):
    """Minimal one-page PDF; `text` adds a Helvetica text object (text pages are what crashed concurrent PDFium renders)."""
    content = b"BT /F1 24 Tf 72 720 Td (Makkha intake form) Tj ET" if text else b""
    objects = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
               b"<< /Type /Page /Parent 2 0 R /MediaBox [%d %d %d %d] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>" % media_box,
               b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream",
               b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    out, offsets = bytearray(b"%PDF-1.4\n"), []
    for number, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % number + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1) + b"".join(b"%010d 00000 n \n" % o for o in offsets)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n" % (len(objects) + 1, xref) + b"%%EOF\n"
    return bytes(out)


def test_pdf_renders_never_overlap(client, fake_model, monkeypatch):
    """/v1/ocr runs in a threadpool; PDFium/MuPDF are not thread-safe, so renders must be serialised."""
    lock, active, peak = threading.Lock(), [0], [0]

    def renderer(data):
        with lock:
            active[0] += 1
            peak[0] = max(peak[0], active[0])
        time.sleep(0.05)
        with lock:
            active[0] -= 1
        return S.filled_form(), 1
    monkeypatch.setattr(api, "_pdf_renderer", lambda: renderer)
    with ThreadPoolExecutor(max_workers=4) as pool:
        statuses = list(pool.map(lambda _: post(client, b"%PDF-1.4 fake", "form.pdf", "application/pdf").status_code, range(4)))
    assert statuses == [200] * 4 and peak[0] == 1


def test_real_pdf_renders_from_two_threads_do_not_crash():
    """Without the lock this segfaults/aborts the interpreter within a few overlapping renders (pypdfium2 4.x/5.x)."""
    pytest.importorskip("pypdfium2")
    api._pdf_renderer.cache_clear()
    pdf = make_pdf()

    def render_many(_):
        return [api._decode(pdf, ".pdf")[0].size for _ in range(40)]
    with ThreadPoolExecutor(max_workers=2) as pool:
        sizes = {size for batch in pool.map(render_many, range(2)) for size in batch}
    assert sizes == {(round(595 * 1610 / 842), 1610)}


def test_pdf_render_scale_is_bounded_by_the_long_side():
    assert api._render_scale(595, 842) == 2 * 805 / 842
    assert api._render_scale(10, 20) == 6.0  # tiny pages: at most 6x
    width, height = 14400 * api._render_scale(14400, 14400), 14400 * api._render_scale(14400, 14400)
    assert round(width) == round(height) == 1610  # the largest allowed page still renders at 1610 px
    for size in ((40000, 40000), (14401, 100), (0, 842), (595, 0), (float("nan"), 842)):
        with pytest.raises(ValueError):
            api._render_scale(*size)


def test_oversize_pdf_page_is_rejected_before_rendering(client, fake_model):
    pytest.importorskip("pypdfium2")
    api._pdf_renderer.cache_clear()
    response = post(client, make_pdf((0, 0, 40000, 40000), text=False), "bomb.pdf", "application/pdf")
    assert response.status_code == 400 and "outside" in response.json()["detail"] and fake_model.calls == []
    ok = post(client, make_pdf((0, 0, 842, 595), text=False), "form.pdf", "application/pdf")
    assert ok.status_code == 200 and ok.json()["layout"]["imageWidth"] == 1610


def test_raster_over_the_pixel_budget_is_400(client, fake_model):
    huge = Image.new("1", (9500, 9500), 1)  # 90.25 MP: under Pillow's hard limit, over its decompression-bomb warning
    response = post(client, png_of(huge))
    assert response.status_code == 400 and "pixels" in response.json()["detail"] and fake_model.calls == []


def test_oversize_jpeg_is_decoded_at_reduced_scale(client, fake_model):
    photo = png_of(Image.new("L", (12000, 9000), 255), "JPEG", quality=50)  # 108 MP phone mode: 1/2 scale, not a 400
    image, _ = api._decode(photo, ".jpg")
    assert image.size == (6000, 4500) and image.mode == "RGB"
    assert post(client, photo, "photo.jpg", "image/jpeg").status_code == 200


def test_master_data_optional_shapes_still_load(client, fake_model, tmp_path, monkeypatch):
    import ocr_normalize as N
    data = json.loads((N.HERE / "master_data.json").read_text(encoding="utf-8"))
    del data["therapists"]  # lookups read a missing section as []
    face = next(entry for entry in data["treatments"] if entry["name"] == "นวดหน้า")
    face["durations"] = None  # like []: no duration restriction
    custom = tmp_path / "master.json"
    custom.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setenv("OCR_MASTER_DATA", str(custom))
    assert N.master_state() == "ok" and client.get("/health").json()["status"] == "ok"
    assert post(client, png_of(S.filled_form())).status_code == 200
    assert N.parse_treatments("หน้า 50 นาที")[0][0]["needsReview"] is False


def test_master_data_typo_keeps_last_good_masters_and_health_degrades(client, fake_model, tmp_path, monkeypatch):
    import ocr_normalize as N
    good = (N.HERE / "master_data.json").read_text(encoding="utf-8")
    custom = tmp_path / "master.json"
    custom.write_text(good, encoding="utf-8")
    monkeypatch.setenv("OCR_MASTER_DATA", str(custom))
    assert post(client, png_of(S.filled_form())).status_code == 200
    custom.write_text(good.replace('"durations": [60, 90, 120, 180] }', '"durations": [60, 90, 120, 180] },', 1), encoding="utf-8")  # typo
    response = post(client, png_of(S.filled_form()))
    assert response.status_code == 200 and response.json()["staffOnly"]["treatments"][0]["value"] == "นวดไทย"
    health = client.get("/health").json()
    assert health["status"] == "degraded" and health["masterData"].startswith("stale: ")
    custom.write_text(json.dumps({"treatments": {}, "therapists": [], "nationalities": []}), encoding="utf-8")
    assert client.get("/health").json()["masterData"].startswith("stale: ")  # a wrong structure is refused too
    custom.write_text(good + "\n", encoding="utf-8")
    assert client.get("/health").json()["status"] == "ok"


def test_master_data_that_never_loaded_is_an_error(client, tmp_path, monkeypatch):
    import ocr_normalize as N
    broken = tmp_path / "broken.json"
    broken.write_text("{", encoding="utf-8")
    cache = N._FileCache(N._load_master)
    with pytest.raises(ValueError):
        cache.get(broken)
    with pytest.raises(ValueError):  # cached failure, re-raised without re-parsing
        cache.get(broken)
    monkeypatch.setattr(N, "_master_cache", cache)
    monkeypatch.setenv("OCR_MASTER_DATA", str(broken))
    health = client.get("/health").json()
    assert health["status"] == "degraded" and health["masterData"].startswith("error: ")


def test_implausibly_many_checked_boxes_flag_the_whole_card(client, fake_model):
    image = S.filled_form()
    draw = ImageDraw.Draw(image)
    for key, *_ in L_CHECKBOXES["healthConditions"][:10]:
        S.tick(draw, "healthConditions", key)
    body = post(client, png_of(image)).json()
    assert any("healthConditions boxes read as checked" in w for w in body["layout"]["warnings"])
    assert all(f["needsReview"] for f in body["customerInformation"]["healthConditions"]) and body["needsReview"] is True


def test_corrupt_image_is_400(client, fake_model):
    assert post(client, b"\x89PNG\r\n\x1a\nnot really").status_code == 400


def test_filename_without_extension_uses_content_type(client, fake_model):
    assert post(client, png_of(S.filled_form(), "WEBP", lossless=True), "upload", "image/webp").status_code == 200


def test_jpeg_webp_and_rgba_inputs(client, fake_model):
    for data, name in ((png_of(S.filled_form(), "JPEG", quality=95), "a.jpg"), (png_of(S.filled_form(), "WEBP", lossless=True), "a.webp"),
                       (png_of(S.filled_form().convert("RGBA")), "a.png")):
        body = post(client, data, name).json()
        assert body["customerInformation"]["gender"]["value"] == "Female", name
        assert body["recommendationCard"]["pressure"]["value"] == "Standard", name


def test_model_failure_is_500(client, monkeypatch):
    import ocr_model
    monkeypatch.setattr(ocr_model, "call_ocr", FakeModel(fail=True))
    response = post(client, png_of(S.filled_form()))
    assert response.status_code == 500 and "model unavailable" in response.json()["detail"]


def test_upload_is_saved_and_crops_stay_in_memory(client, fake_model, isolated_paths):
    body = post(client, png_of(S.filled_form()), "x.png").json()
    files = os.listdir(isolated_paths / "uploads")
    assert files == [f"{body['documentId']}.png"]


def test_model_crops_match_v22_geometry_and_scale(client, fake_model, monkeypatch):
    monkeypatch.setenv("OCR_SECTION_MODE", "separate")
    post(client, png_of(S.filled_form()))
    crops = {("staff" if "STAFF ONLY" in c["prompt"] else "customer"): Image.open(io.BytesIO(c["png"])) for c in fake_model.calls}
    staff, customer = crops["staff"], crops["customer"]
    assert staff.size == (300, 85)  # exactly the v2.2 crop (410,485,710,570), incl. its black padding row
    assert staff.getpixel((150, 84)) == (0, 0, 0)
    assert customer.size == (324, 93)  # Name row + Nationality/Hotel rows
    fake_model.calls.clear()
    post(client, png_of(S.filled_form().resize((1610, 1138))))
    staff_2x = next(c for c in fake_model.calls if "STAFF ONLY" in c["prompt"])
    assert Image.open(io.BytesIO(staff_2x["png"])).size == (600, 170)


def test_aspect_mismatch_is_reported_and_reviewed(client, fake_model):
    square = Image.new("RGB", (805, 805), (255, 255, 255))
    square.paste(S.filled_form(), (0, 0))
    body = post(client, png_of(square)).json()
    assert body["layout"]["aspectMatch"] is False and body["layout"]["warnings"] and body["needsReview"] is True


def test_non_form_image_is_flagged(client, fake_model):
    body = post(client, png_of(Image.new("RGB", (805, 569), (255, 255, 255)))).json()
    assert any("not found" in w for w in body["layout"]["warnings"]) and body["needsReview"] is True


def test_health_reports_v3(client):
    body = client.get("/health").json()
    assert body["status"] == "ok" and body["version"] == "3.0" and body["engine"] == "typhoon-sections" and body["masterData"] == "ok"


def test_combined_mode_sends_one_image_customer_rows_above_the_unchanged_staff_crop(client, fake_model, monkeypatch):
    post(client, png_of(S.filled_form()))
    assert len(fake_model.calls) == 1
    call = fake_model.calls[0]
    assert "CUSTOMER INFORMATION" in call["prompt"] and "STAFF ONLY" in call["prompt"] and call["max_tokens"] == 340
    combined = Image.open(io.BytesIO(call["png"])).convert("RGB")
    fake_model.calls.clear()
    monkeypatch.setenv("OCR_SECTION_MODE", "separate")
    post(client, png_of(S.filled_form()))
    crops = {("staff" if "STAFF ONLY" in c["prompt"] else "customer"): Image.open(io.BytesIO(c["png"])).convert("RGB") for c in fake_model.calls}
    staff, customer = crops["staff"], crops["customer"]
    assert combined.size == (max(staff.width, customer.width), customer.height + 12 + staff.height)
    assert combined.crop((0, 0, customer.width, customer.height)).tobytes() == customer.tobytes()
    bottom = combined.crop((0, customer.height + 12, staff.width, customer.height + 12 + staff.height))
    assert bottom.tobytes() == staff.tobytes()  # the STAFF pixels the v2.2 prompt was proven on


def test_combined_mode_parses_real_model_output(client, monkeypatch):
    """Real Typhoon answers to combined images (2026-09-22, cache-defeating variants of sample2 / sample)."""
    import ocr_model
    real = {
        "sample2": "Name: chun\nNationality: Chinese\nHotel Name:\nTreatment: ไทย 90 นาที+หน้า 1 ชม. PLOENCHIT\nTherapist Name: พิพี\nRoom No.: 3",
        "sample": ("Cynthia De La Cruz-Eikanter\nNationality:\nHotel Name:\n\nSTAFF ONLY 仅前台使用\nPLOENCHIT\n\n"
                   "Treatment: หน้า 1 ชม.\nTherapist Name: เอี้ยง Room No. 1"),
    }
    expected = {
        "sample2": ("chun", "Chinese", [("นวดไทย", 90), ("นวดหน้า", 60)], "พีพี", "3"),
        "sample": ("Cynthia De La Cruz-Eikanter", None, [("นวดหน้า", 60)], "เอี้ยง", "1"),
    }
    for name, text in real.items():
        monkeypatch.setattr(ocr_model, "call_ocr", lambda png, prompt, max_tokens=220, text=text: text)
        body = post(client, png_of(S.filled_form())).json()
        customer, staff = body["customerInformation"], body["staffOnly"]
        got = (customer["name"]["value"], customer["nationality"]["value"],
               [(t["value"], t["durationMinutes"]) for t in staff["treatments"]], staff["therapistName"]["value"], staff["roomNo"]["value"])
        assert got == expected[name], name
        assert "PLOENCHIT" not in (staff["treatment"]["raw"] or "") and not customer["name"]["needsReview"]


def _section_model(combined_answer, calls):
    """Answers the combined prompt with `combined_answer` and the single-section prompts with the proven texts."""
    def model(png, prompt, max_tokens=220):
        calls.append(prompt)
        if "CUSTOMER INFORMATION" in prompt and "STAFF ONLY" in prompt:
            return combined_answer
        return CUSTOMER_TEXT if "CUSTOMER INFORMATION" in prompt else STAFF_TEXT
    return model


def test_combined_answer_without_labels_falls_back_to_both_single_section_calls(client, monkeypatch):
    """Real answer seen once with a looser prompt: bare values, no labels. Both sections are re-read alone."""
    import ocr_model
    calls = []
    monkeypatch.setattr(ocr_model, "call_ocr", _section_model("chun\nChinese\nPLOENCHIT\nไทย 90 นาที+หน้า 1 ชม. 2.\nฟิพี\n3", calls))
    body = post(client, png_of(S.filled_form())).json()
    assert len(calls) == 3 and sorted(calls[1:]) == sorted([ocr_model.STAFF_PROMPT, ocr_model.CUSTOMER_PROMPT])
    assert [s["name"] for s in body["timings"]["sections"]] == ["combined", "staffOnlyFallback", "customerInformationFallback"]
    assert body["evidence"]["staffCropRaw"] == STAFF_TEXT and body["evidence"]["combinedRaw"].startswith("chun")
    assert [t["value"] for t in body["staffOnly"]["treatments"]] == ["นวดไทย", "นวดหน้า"]
    assert body["customerInformation"]["name"]["value"] == "Chun" and body["customerInformation"]["nationality"]["value"] == "Chinese"
    assert body["timings"]["inferenceWallMs"] >= 0 and body["timings"]["inferenceMs"] == sum(s["ms"] for s in body["timings"]["sections"])


def test_model_answering_with_its_training_prompt_is_recovered_by_fallbacks(client, monkeypatch):
    """Production 2026-09-22 (1 in 18 fresh documents): the combined call returned Typhoon's own training prompt."""
    import ocr_model
    calls = []
    regurgitated = ("Extract all text from the image.\n\nInstructions:\n- Only return the clean Markdown.\n\nFormatting Rules:\n"
                    "- Checkboxes: Use ☐ for unchecked and ☑ for checked boxes.")
    monkeypatch.setattr(ocr_model, "call_ocr", _section_model(regurgitated, calls))
    body = post(client, png_of(S.filled_form())).json()
    assert len(calls) == 3
    assert body["customerInformation"]["name"]["value"] == "Chun" and body["staffOnly"]["therapistName"]["value"] == "พีพี"
    assert body["evidence"]["combinedRaw"] == regurgitated and body["evidence"]["customerCropRaw"] == CUSTOMER_TEXT


def test_good_combined_answer_needs_no_fallback(client, monkeypatch):
    import ocr_model
    calls = []
    monkeypatch.setattr(ocr_model, "call_ocr", _section_model(CUSTOMER_TEXT + "\n\n" + STAFF_TEXT, calls))
    body = post(client, png_of(S.filled_form())).json()
    assert len(calls) == 1 and [s["name"] for s in body["timings"]["sections"]] == ["combined"]
