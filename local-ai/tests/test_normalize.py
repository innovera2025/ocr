"""Text normalization: treatments + durations, staff/customer transcription parsing, masters, verified memory."""

import json
import os
from pathlib import Path

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
    ("ไทย 1 ชม. 30", [("นวดไทย", 90)]),  # minutes after an hour unit may omit their own unit
    ("Thai 1h30", [("นวดไทย", 90)]),
    ("Oil 1 hr 30", [("นวดน้ำมัน", 90)]),
    ("ไทย 1ชม.30", [("นวดไทย", 90)]),
    ("น้ำมัน 1 ชม.30", [("นวดน้ำมัน", 90)]),
    ("ไทย 90 นาที + หน้า 1 ชม. 30", [("นวดไทย", 90), ("นวดหน้า", 90)]),
    ("ไทย 1:30", [("นวดไทย", 90)]),
    ("Foot 0:45", [("นวดเท้า", 45)]),
])
def test_duration_normalization(text, expected):
    items, _, _, _ = N.parse_treatments(text)
    assert [(i["value"], i["durationMinutes"]) for i in items] == expected


DURATION_CASES = json.loads((Path(__file__).parent / "duration_cases.json").read_text(encoding="utf-8"))["cases"]


@pytest.mark.parametrize("duration, minutes", DURATION_CASES)
def test_shared_duration_table(duration, minutes):
    """Same table as packages/ocr-persistence parseDurationMinutes (reviewer-edited durations)."""
    assert N.parse_treatments(f"ไทย {duration}")[0][0]["durationMinutes"] == minutes


def test_unlabeled_minutes_are_kept_in_raw_and_duration():
    items, durations, warnings, _ = N.parse_treatments("ไทย 1 ชม. 30")
    assert names(items) == [("ไทย", "นวดไทย", "1 ชม. 30", 90, False)] and items[0]["raw"] == "ไทย 1 ชม. 30"
    assert durations == ["1 ชม. 30"] and warnings == []


@pytest.mark.parametrize("text", ["ไทย 90 นาที 15", "ไทย 10:30", "ไทย 2 90 นาที",
                                  "ไทย 90 นาที + 30", "ไทย 90 นาที\n15", "หน้า 1 ชม. + 30", "ไทย 60 นาที, 30", "30 + ไทย 90 นาที"])
def test_numbers_not_read_as_a_duration_need_review(text):
    items, _, warnings, _ = N.parse_treatments(text)
    assert len(items) == 1 and items[0]["needsReview"] and any("not read as a duration" in w for w in warnings)


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
    assert misread["value"] == "พีพี" and misread["needsReview"] and misread["confidence"] < N.REVIEW_BELOW
    assert N.normalize_therapist(None)["source"] == "none"
    assert N.normalize_room("๓")["value"] == "3" and N.normalize_room("A")["needsReview"]


@pytest.mark.parametrize("text, expected", [
    ("Name: Chun\nNationality: Chinese\nHotel Name:", {"name": "Chun", "nationality": "Chinese", "hotelName": None}),
    ("Name 姓名 : Chun\nNationality 国籍 : Chinese\nHotel Name 酒店 : -", {"name": "Chun", "nationality": "Chinese", "hotelName": None}),
    ("| Name 姓名 | Chun |\n| Nationality 国籍 | Chinese |\n| Hotel Name 酒店 | |", {"name": "Chun", "nationality": "Chinese", "hotelName": None}),
    ("姓名 Chun 国籍 Chinese 酒店 Hilton Sukhumvit", {"name": "Chun", "nationality": "Chinese", "hotelName": "Hilton Sukhumvit"}),
    ("**Name:** Anna Smith\n**Nationality:** British\n**Hotel Name:** N/A", {"name": "Anna Smith", "nationality": "British", "hotelName": None}),
    # bilingual labels echoed in brackets, and numbered lines, never leak into the values
    ("Name (姓名): Chun\nNationality (国籍): Chinese\nHotel Name (酒店): Hilton", {"name": "Chun", "nationality": "Chinese", "hotelName": "Hilton"}),
    ("Name（姓名）：Chun\nNationality（国籍）：Chinese\nHotel Name（酒店）：Hilton", {"name": "Chun", "nationality": "Chinese", "hotelName": "Hilton"}),
    ("Name [姓名]: Chun\nNationality [国籍]: Chinese\nHotel Name [酒店]: -", {"name": "Chun", "nationality": "Chinese", "hotelName": None}),
    ("1. Name Chun\n2. Nationality Chinese\n3. Hotel Name Hilton", {"name": "Chun", "nationality": "Chinese", "hotelName": "Hilton"}),
    ("- Name: Chun\n- Nationality: Chinese\n- Hotel Name:", {"name": "Chun", "nationality": "Chinese", "hotelName": None}),
])
def test_customer_text_label_parsing(text, expected):
    parsed, fallback = N.parse_customer_text(text)
    assert parsed == expected and fallback is False


@pytest.mark.parametrize("text, expected", [
    ("Name: Kaname Sato", {"name": "Kaname Sato", "nationality": None, "hotelName": None}),
    ("Name: Nameeta Shah", {"name": "Nameeta Shah", "nationality": None, "hotelName": None}),
    ("Name: Anna Hotelling | Nationality: American | Hotel Name: Hilton", {"name": "Anna Hotelling", "nationality": "American", "hotelName": "Hilton"}),
    ("Hotel Name: Hotel Nikko Bangkok", {"name": None, "nationality": None, "hotelName": "Hotel Nikko Bangkok"}),
    ("Hotel Name: The Name Hotel", {"name": None, "nationality": None, "hotelName": "The Name Hotel"}),
    ("Hotel Name: โรงแรมอินดิโก", {"name": None, "nationality": None, "hotelName": "โรงแรมอินดิโก"}),
    ("Hotel Name 酒店 : 曼谷洲际酒店", {"name": None, "nationality": None, "hotelName": "曼谷洲际酒店"}),
])
def test_label_words_inside_values_do_not_start_a_new_field(text, expected):
    assert N.parse_customer_text(text) == (expected, False)


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


def test_file_cache_keeps_last_good_value_when_a_changed_file_does_not_load(tmp_path):
    path = tmp_path / "master.json"
    path.write_text(N.master_path().read_text(encoding="utf-8"), encoding="utf-8")
    cache = N._FileCache(N._load_master)
    good = cache.get(path)
    path.write_text('{"treatments": [], "therapists": [], "nationalities": [],}', encoding="utf-8")
    assert cache.get(path) is good and isinstance(cache.error, ValueError)
    path.write_text('{"treatments": [], "therapists": [], "nationalities": []}', encoding="utf-8")
    assert cache.get(path)["treatments"] == [] and cache.error is None


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


def test_real_model_staff_text_keeps_hour_and_flags_trailing_digit():
    """Real Typhoon output for sample2 (2026-09-22): "1 ชม.2" is one hour plus an unread "2", never 62 min."""
    items, durations, warnings, _ = N.parse_treatments("ไทย 90 นาที+หน้า 1 ชม.2")
    assert [(i["value"], i["durationMinutes"], i["needsReview"]) for i in items] == [("นวดไทย", 90, False), ("นวดหน้า", 60, True)]
    assert durations == ["90 นาที", "1 ชม."] and any("2" in w for w in warnings)


@pytest.mark.parametrize("text", ["ไทย 1 ชม. 5", "ไทย 2 ชม. 3"])
def test_single_unlabelled_digit_after_hours_is_not_minutes(text):
    items, _, warnings, _ = N.parse_treatments(text)
    assert items[0]["durationMinutes"] in (60, 120) and items[0]["needsReview"] and warnings


def test_therapist_vowel_confusion_suggests_master_name_for_review():
    """Handwriting OCR swaps Thai vowel marks (พิพี for พีพี): suggest the master name, but always for review."""
    result = N.normalize_therapist("พิพี")
    assert (result["value"], result["needsReview"], result["source"]) == ("พีพี", True, "master-fuzzy")
    assert result["confidence"] < N.REVIEW_BELOW
    assert N.normalize_therapist("สมชาย")["value"] is None


@pytest.mark.parametrize("text, customer, staff", [
    ("Name: chun\nNationality: Chinese\nHotel Name:\nTreatment: ไทย 90 นาที\nTherapist Name: พิพี\nRoom No.: 3",
     "Name: chun\nNationality: Chinese\nHotel Name:", "Treatment: ไทย 90 นาที\nTherapist Name: พิพี\nRoom No.: 3"),
    ("Name: A\n\nSTAFF ONLY 仅前台使用\nTreatment: หน้า 1 ชม.", "Name: A", "STAFF ONLY 仅前台使用\nTreatment: หน้า 1 ชม."),
    ("Name: A\n仅限台使用 PLOENCHIT\nTreatment: x", "Name: A", "仅限台使用 PLOENCHIT\nTreatment: x"),
    ("no markers at all", "no markers at all", "no markers at all"),
])
def test_split_combined_text(text, customer, staff):
    assert N.split_combined_text(text) == (customer, staff)


@pytest.mark.parametrize("text", [
    "Treatment: ไทย 90 นาที+หน้า 1 ชม. PLOENCHIT\nTherapist Name: พิพี\nRoom No.: 3",
    "STAFF ONLY (仅前台使用) PLOENCHIT\nTreatment: ไทย 90 นาที+หน้า 1 ชม.\nTherapist Name: พิพี Room No.: 3",
    "Treatment: ไทย 90 นาที+หน้า 1 ชม.\nMAKKHA HEALTH & SPA\nTherapist Name: พิพี\nRoom No.: 3",
])
def test_printed_staff_box_text_is_removed_inline_not_the_whole_line(text):
    treatment, therapist, room = N.extract_staff_fields(text)
    assert treatment == "ไทย 90 นาที+หน้า 1 ชม." and therapist == "พิพี" and room == "3"


def test_customer_name_without_label_is_taken_from_the_top_row():
    found, fallback = N.parse_customer_text("Cynthia De La Cruz-Eikanter\nNationality:\nHotel Name:")
    assert found == {"name": "Cynthia De La Cruz-Eikanter", "nationality": None, "hotelName": None} and not fallback
    found, _ = N.parse_customer_text("Chun\nNationality: Chinese\nHotel Name:", expected=("nationality",))
    assert found["name"] is None  # no handwriting in the Name box: nothing is invented


def test_customer_name_written_before_an_empty_chinese_label():
    """Real combined answer: 'Cynthia De La Cruz-Eikanter\n姓名\nNationality 国籍\nHotel Name 酒店'."""
    found, fallback = N.parse_customer_text("Cynthia De La Cruz-Eikanter\n姓名\nNationality 国籍\nHotel Name 酒店")
    assert found["name"] == "Cynthia De La Cruz-Eikanter" and not fallback


def test_trailing_number_with_a_full_stop_is_a_leftover_not_a_treatment():
    """Real answer for sample2 (v9 variant): "ไทย 90 นาที+หน้า 1 ชม. 2." must not add a treatment named "2"."""
    items, durations, warnings, _ = N.parse_treatments("ไทย 90 นาที+หน้า 1 ชม. 2.")
    assert [(i["value"], i["durationMinutes"]) for i in items] == [("นวดไทย", 90), ("นวดหน้า", 60)]
    assert items[1]["needsReview"] and any("2" in w for w in warnings)
