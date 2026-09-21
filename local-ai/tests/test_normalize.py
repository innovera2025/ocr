"""Text normalization: treatments + durations, staff/customer transcription parsing, masters, verified memory."""

import json
import os

import pytest

import ocr_normalize as N


def names(items):
    return [(i["nameRaw"], i["value"], i["duration"], i["durationMinutes"], i["needsReview"]) for i in items]


def test_multiple_treatments_pair_each_name_with_its_own_duration():
    items, durations, warnings, total = N.parse_treatments("ไทย 90 นาที + หน้า 1 ชม.")
    assert names(items) == [("ไทย", "นวดไทย", "90 นาที", 90, False), ("หน้า", "นวดหน้า", "1 ชม.", 60, False)]
    assert items[0]["raw"] == "ไทย 90 นาที" and items[0]["source"] == "rule"
    assert durations == ["90 นาที", "1 ชม."] and warnings == [] and total is None


def test_trailing_total_is_not_a_treatment_duration():
    items, durations, _, total = N.parse_treatments("ไทย 90 นาที + หน้า 1 ชม. 2.5 ชม.")
    assert names(items) == [("ไทย", "นวดไทย", "90 นาที", 90, False), ("หน้า", "นวดหน้า", "1 ชม.", 60, False)]
    assert total == 150 and durations[-1] == "2.5 ชม."


@pytest.mark.parametrize("text, expected", [
    ("นวดไทย 1.5 ชม.\nนวดเท้า 30 นาที", [("นวดไทย", 90), ("นวดเท้า", 30)]),
    ("Thai Massage 60 min, Foot 45min", [("นวดไทย", 60), ("นวดเท้า", 45)]),
    ("อโรม่า 2 ชั่วโมง / เท้า 30 นาที", [("อโรมา", 120), ("นวดเท้า", 30)]),
    ("ไทย ๙๐ นาที", [("นวดไทย", 90)]),
    ("ไทย 1 ชม. 30 นาที", [("นวดไทย", 90)]),
    ("ไทย 1 ชม.ครึ่ง", [("นวดไทย", 90)]),
    ("90 นาที ไทย", [("นวดไทย", 90)]),
    ("Oil 1,5 hr", [("นวดน้ำมัน", 90)]),
    ("คอ บ่า ไหล่ 30 นาที", [("คอ บ่า ไหล่", 30)]),
])
def test_duration_normalization(text, expected):
    items, _, _, _ = N.parse_treatments(text)
    assert [(i["value"], i["durationMinutes"]) for i in items] == expected


def test_duration_not_allowed_for_treatment_needs_review():
    items, _, warnings, _ = N.parse_treatments("หน้า 50 นาที")
    assert items[0]["value"] == "นวดหน้า" and items[0]["needsReview"] and items[0]["confidence"] <= 0.6
    assert "not an allowed duration" in warnings[0]


def test_missing_duration_and_unknown_treatment_need_review():
    items, _, _, _ = N.parse_treatments("เท้า + Relax 60 min")
    assert items[0]["value"] == "นวดเท้า" and items[0]["duration"] is None and items[0]["needsReview"]
    assert items[1]["value"] is None and items[1]["needsReview"]


def test_bare_number_duration_is_read_as_minutes_with_warning():
    items, durations, warnings, _ = N.parse_treatments("ไทย 90")
    assert names(items) == [("ไทย", "นวดไทย", "90", 90, False)] and durations == [] and "no unit" in warnings[0]


def test_empty_treatment():
    assert N.parse_treatments(None) == ([], [], [], None)
    assert N.legacy_treatment(None, [], [])["needsReview"] is True


def test_staff_fields_v22_format_and_hardened_variants():
    assert N.extract_staff_fields("Treatment : ไทย 90 นาที + หน้า 1 ชม.\nTherapist Name : พีพี\nRoom No. : 3") == ("ไทย 90 นาที + หน้า 1 ชม.", "พีพี", "3")
    text = "STAFF ONLY 仅前台使用 PLOENCHIT\n**Treatment**：ไทย 90 นาที\nหน้า 1 ชม.\n**Therapist Name** พีพี **Room No.** ๓"
    assert N.extract_staff_fields(text) == ("ไทย 90 นาที\nหน้า 1 ชม.", "พีพี", "๓")
    assert N.extract_staff_fields("nothing useful") == (None, None, None)


def test_therapist_and_room_normalization():
    assert N.normalize_therapist("พีพี") == {"raw": "พีพี", "value": "พีพี", "confidence": 1.0, "source": "master-fuzzy", "needsReview": False}
    misread = N.normalize_therapist("พิพิ")
    assert misread["value"] is None and misread["needsReview"]
    assert N.normalize_therapist(None)["source"] == "none"
    assert N.normalize_room("๓")["value"] == "3" and N.normalize_room("A")["needsReview"]


@pytest.mark.parametrize("text, expected", [
    ("Name: Chun\nNationality: Chinese\nHotel Name:", {"name": "Chun", "nationality": "Chinese", "hotelName": None}),
    ("Name 姓名 : Chun\nNationality 国籍 : Chinese\nHotel Name 酒店 : -", {"name": "Chun", "nationality": "Chinese", "hotelName": None}),
    ("| Name 姓名 | Chun |\n| Nationality 国籍 | Chinese |\n| Hotel Name 酒店 | |", {"name": "Chun", "nationality": "Chinese", "hotelName": None}),
    ("姓名 Chun 国籍 Chinese 酒店 Hilton Sukhumvit", {"name": "Chun", "nationality": "Chinese", "hotelName": "Hilton Sukhumvit"}),
    ("**Name:** Anna Smith\n**Nationality:** British\n**Hotel Name:** N/A", {"name": "Anna Smith", "nationality": "British", "hotelName": None}),
])
def test_customer_text_label_parsing(text, expected):
    parsed, fallback = N.parse_customer_text(text)
    assert parsed == expected and fallback is False


def test_customer_text_unlabeled_fallback_uses_written_boxes():
    parsed, fallback = N.parse_customer_text("Chun\nChinese", ("name", "nationality"))
    assert parsed == {"name": "Chun", "nationality": "Chinese", "hotelName": None} and fallback is True


def test_nationality_master_english_thai_chinese_and_fuzzy():
    assert N.normalize_nationality("Chinese")["value"] == "Chinese"
    assert N.normalize_nationality("จีน")["value"] == "Chinese"
    assert N.normalize_nationality("中国")["value"] == "Chinese"
    fuzzy = N.normalize_nationality("Chinesse")
    assert fuzzy["value"] == "Chinese" and fuzzy["source"] == "master-fuzzy"
    unknown = N.normalize_nationality("Uzbek")
    assert unknown["value"] == "Uzbek" and unknown["needsReview"]


def test_verified_memory_is_cached_and_reloaded_on_change(tmp_path):
    assert N.verified_match("treatment", "ใทย") is None
    N.append_verified({"field": "treatment", "ocrRaw": "ใทย", "verifiedValue": "นวดไทย", "verifiedByHuman": True})
    assert N.verified_match("treatment", "ใทย") == "นวดไทย"
    N.append_verified({"field": "treatment", "ocrRaw": "ใทย", "verifiedValue": "นวดน้ำมัน", "verifiedByHuman": True})
    assert N.verified_match("treatment", "ใทย") == "นวดน้ำมัน"  # last confirmation wins (v2.2 semantics)
    path = N.verified_path()
    with path.open("a", encoding="utf-8") as f:
        f.write("not json\n" + json.dumps({"field": "therapist", "ocrRaw": "x", "verifiedValue": "ฟ้า", "verifiedByHuman": False}) + "\n")
    assert N.verified_match("therapist", "x") is None


def test_treatment_verified_memory_tries_name_raw_then_raw():
    N.append_verified({"field": "treatment", "ocrRaw": "สปาร้อน", "verifiedValue": "Hot Stone Spa", "verifiedByHuman": True})
    items, _, _, _ = N.parse_treatments("สปาร้อน 60 นาที")
    assert items[0]["value"] == "Hot Stone Spa" and items[0]["source"] == "verified-memory"
    N.append_verified({"field": "treatment", "ocrRaw": "ขัดผิว 45 นาที", "verifiedValue": "Body Scrub", "verifiedByHuman": True})
    items, _, _, _ = N.parse_treatments("ขัดผิว 45 นาที")
    assert items[0]["value"] == "Body Scrub" and items[0]["nameRaw"] == "ขัดผิว"


def test_master_data_is_editable_and_reloaded(tmp_path, monkeypatch):
    master = json.loads(N.master_path().read_text(encoding="utf-8"))
    custom = tmp_path / "master.json"
    custom.write_text(json.dumps(master, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setenv("OCR_MASTER_DATA", str(custom))
    assert N.parse_treatments("ขัดผิว 45 นาที")[0][0]["value"] is None
    master["treatments"].append({"name": "ขัดผิว", "aliases": ["Scrub"], "durations": [45]})
    custom.write_text(json.dumps(master, ensure_ascii=False), encoding="utf-8")
    os.utime(custom, ns=(os.stat(custom).st_atime_ns, os.stat(custom).st_mtime_ns + 1_000_000))
    item = N.parse_treatments("Scrub 45 min")[0][0]
    assert item["value"] == "ขัดผิว" and not item["needsReview"]


def test_default_master_data_covers_v22_treatments_and_therapists():
    master = N.master()
    known = {n for t in master["treatments"] for n in [t["name"], *t["aliases"]]}
    assert {"คอ บ่า ไหล่", "นวดไทย", "นวดน้ำมัน", "อโรมา", "นวดเท้า", "Thai Massage", "Oil Massage", "Foot Massage", "นวดหน้า", "Face"} <= known
    assert {t["name"] for t in master["therapists"]} == {"ฟ้า", "พีพี", "เอี้ยง"}
