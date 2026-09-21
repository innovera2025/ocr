"""HTTP contract of the Local AI service (schema v3) with the model call mocked."""

import io
import os

from PIL import Image, ImageDraw

import api
import synthetic_form as S
from conftest import CUSTOMER_TEXT, STAFF_TEXT, FakeModel, png_of

FIELD_KEYS = {"raw", "value", "confidence", "source", "needsReview"}
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
    assert 0.2 < body["evidence"]["checkboxScores"]["gender.female"] < 0.5
    assert body["evidence"]["checkboxScores"]["gender.male"] == 0.0
    assert body["needsReview"] is True  # the scribbled massage-oil row must be reviewed
    assert [s["name"] for s in body["timings"]["sections"]] == ["staffOnly", "customerInformation"]
    assert len(fake_model.calls) == 2


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
    assert therapist["raw"] == "พิพิ" and therapist["value"] is None and therapist["needsReview"]
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


def test_model_crops_match_v22_geometry_and_scale(client, fake_model):
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
