"""Deterministic detection: checkboxes, handwriting boxes and body map (no model calls)."""

import numpy as np
import pytest
from PIL import Image, ImageChops, ImageDraw, ImageFilter

import ocr_layout as L
import ocr_marks as M
import ocr_register as R
import synthetic_form as S


def analyse(image):
    if image.size != (L.REF_W, L.REF_H):
        image = image.resize((L.REF_W, L.REF_H), Image.BILINEAR)
    lum = image.convert("L")
    geo, detection = R.register(np.asarray(M.border_darkness(image, lum)))
    mask, _ = M.ink_mask(image, lum, geo)
    boxes = M.detect_checkboxes(mask, geo)
    states = {f"{group}.{key}": m["state"] for group, items in boxes.items() for key, _, m in items}
    return {"offset": (round(detection["dx"]), round(detection["dy"])), "detection": detection, "contrast": detection["score"],
            "boxes": boxes, "notes": {f"{group}.{key}": m["note"] for group, items in boxes.items() for key, _, m in items if m["note"]},
            "marked": {k: v for k, v in states.items() if v != "unchecked"},
            "text": {k: M.text_state(v) for k, v in M.text_ink(mask, geo).items()},
            "body": {(m["area"], m["kind"]): m for m in M.detect_body_marks(mask, lum, geo)}}


# Ground truth read visually from tests/fixtures/sample2.png (zoomed crops): Female, Menstruation and Standard are
# ticked; a wavy pen line is scribbled across the whole massage-oil row (through Jasmine, Rose and Lavender, beside
# Citronella and Orange-Cinnamon): one stroke through 3 boxes = the row is struck out; no referral source is ticked;
# the Name box says "Chun", Nationality "Chinese", Hotel Name is empty; the body map has circles around Shoulder (front),
# Neck (back) and Back (back) and no crosses.
SAMPLE_MARKED = {
    "gender.female": "checked", "healthConditions.menstruation": "checked", "pressure.standard": "checked",
    "massageOilScrub.jasmine": "struck", "massageOilScrub.rose": "struck", "massageOilScrub.lavender": "struck",
}


def test_sample2_checkboxes_match_visual_ground_truth(sample_image):
    result = analyse(sample_image)
    assert result["offset"] == (0, 0) and result["detection"]["verdict"] == "known"
    assert result["marked"] == SAMPLE_MARKED
    notes = {key: m["note"] for key, _, m in result["boxes"]["massageOilScrub"] if m["state"] == "struck"}
    assert set(notes.values()) == {"row-struck-out"}
    female = next(m for key, _, m in result["boxes"]["gender"] if key == "female")
    assert female["confidence"] >= 0.9 and 0.2 < female["score"] < 0.5


def test_sample2_handwriting_boxes(sample_image):
    assert analyse(sample_image)["text"] == {"name": "present", "nationality": "present", "hotelName": "empty"}


def test_sample2_body_map_circles(sample_image):
    body = analyse(sample_image)["body"]
    assert set(body) == {("Shoulder (front)", "circle"), ("Neck (back)", "circle"), ("Back (back)", "circle")}
    assert all(not m["needsReview"] and m["confidence"] >= 0.9 for m in body.values())


def test_registration_recovers_a_shifted_scan(sample_image):
    shifted = Image.new("RGB", sample_image.size, (255, 255, 255))
    shifted.paste(sample_image, (3, -2))
    result = analyse(shifted)
    assert result["offset"] == (3, -2)
    assert result["marked"] == SAMPLE_MARKED
    assert set(result["body"]) == {("Shoulder (front)", "circle"), ("Neck (back)", "circle"), ("Back (back)", "circle")}


def test_higher_resolution_scan_gives_same_marks(sample_image):
    result = analyse(sample_image.resize((1610, 1138), Image.LANCZOS))
    checked = {k for k, v in result["marked"].items() if v == "checked"}
    struck = {k for k, v in result["marked"].items() if v == "struck"}
    assert checked == {k for k, v in SAMPLE_MARKED.items() if v == "checked"}
    # resampling blur can push the scribble that grazes Orange-Cinnamon's corner inside that box too: struck, never "checked"
    assert {k for k, v in SAMPLE_MARKED.items() if v == "struck"} <= struck <= {f"massageOilScrub.{k}" for k, *_ in L.CHECKBOXES["massageOilScrub"]}
    assert result["text"]["hotelName"] == "empty"


def test_extra_pen_marks_on_sample(sample_image):
    image = sample_image.copy()
    draw = ImageDraw.Draw(image)
    S.tick(draw, "referralSources", "google")
    S.tick(draw, "gender", "male")
    S.cross_label(draw, "Calf", "front")
    S.circle_label(draw, "Head", "back")
    result = analyse(image)
    assert result["marked"]["referralSources.google"] == "checked"
    assert result["marked"]["gender.male"] == "checked"
    assert result["body"][("Calf (front)", "cross")]["confidence"] >= 0.8
    assert result["body"][("Head (back)", "circle")]["confidence"] >= 0.8


def test_synthetic_blank_form_has_no_marks():
    result = analyse(S.blank_form())
    assert result["contrast"] > 30
    assert result["marked"] == {} and result["body"] == {}
    assert result["text"] == {"name": "empty", "nationality": "empty", "hotelName": "empty"}


def test_synthetic_form_blue_and_black_pen():
    result = analyse(S.filled_form())
    assert result["marked"] == {"gender.female": "checked", "healthConditions.menstruation": "checked", "pressure.standard": "checked"}
    assert result["text"] == {"name": "present", "nationality": "present", "hotelName": "empty"}
    assert set(result["body"]) == {("Shoulder (front)", "circle"), ("Calf (back)", "cross")}


def test_long_stroke_through_a_row_is_struck_out_not_checked():
    image = S.blank_form()
    draw = ImageDraw.Draw(image)
    draw.line((505, 104, 790, 104), fill=S.BLUE_PEN, width=2)  # scribble across the whole first oil row
    result = analyse(image)
    assert result["marked"] == {"massageOilScrub.jasmine": "struck", "massageOilScrub.rose": "struck", "massageOilScrub.citronella": "struck"}
    assert set(result["notes"].values()) == {"row-struck-out"}


def test_faint_mark_is_ambiguous():
    image = S.blank_form()
    draw = ImageDraw.Draw(image)
    _, _, x, y, s = S.box_of("healthConditions", "asthma")
    draw.point((x + 5, y + 5), fill=S.BLUE_PEN)
    draw.point((x + 6, y + 5), fill=S.BLUE_PEN)
    draw.point((x + 5, y + 6), fill=S.BLUE_PEN)
    assert analyse(image)["marked"] == {"healthConditions.asthma": "ambiguous"}


def test_mark_on_figure_needs_review():
    image = S.blank_form()
    draw = ImageDraw.Draw(image)
    fx0, fy0, fx1, fy1 = L.BODY_FIGURES["front"]
    draw.line((fx0 + 15, 285, fx0 + 31, 301), fill=(30, 30, 60), width=3)
    draw.line((fx0 + 15, 301, fx0 + 31, 285), fill=(30, 30, 60), width=3)
    marks = list(analyse(image)["body"].values())
    assert len(marks) == 1 and marks[0]["needsReview"] and not marks[0]["onLabel"]


def test_layout_describes_scale_and_aspect():
    same = L.describe_layout(805, 569)
    assert same == {"template": "makkha-intake-v1", "imageWidth": 805, "imageHeight": 569, "scaleX": 1.0, "scaleY": 1.0,
                    "aspectMatch": True, "warnings": []}
    double = L.describe_layout(1610, 1138)
    assert double["scaleX"] == 2.0 and double["aspectMatch"]
    square = L.describe_layout(800, 800)
    assert not square["aspectMatch"] and "aspect ratio" in square["warnings"][0]


def test_darker_than_paper_keeps_light_gray_pen_and_drops_orange_print():
    image = Image.new("RGB", (5, 1))
    image.putdata([(200, 200, 200), (170, 170, 170), (150, 150, 150), (224, 159, 84), (60, 60, 140)])
    assert list(M.darker_than_paper(image, image.convert("L")).tobytes()) == [0, 255, 255, 0, 255]


def test_heavy_jpeg_still_finds_ticks(sample_image):
    import io
    buffer = io.BytesIO()
    sample_image.save(buffer, format="JPEG", quality=70)  # 4:2:0 chroma subsampling washes out thin blue strokes
    result = analyse(Image.open(io.BytesIO(buffer.getvalue())).convert("RGB"))
    checked = {k for k, v in result["marked"].items() if v == "checked"}
    assert {"gender.female", "healthConditions.menstruation", "pressure.standard"} <= checked
    assert not any(k.startswith(("referralSources.", "healthConditions.")) and k != "healthConditions.menstruation" for k in result["marked"])
    assert result["text"] == {"name": "present", "nationality": "present", "hotelName": "empty"}
    # Known limitation: the scribble across the oil row loses its colour outside the boxes, so it is not recognised
    # as a stroke-through here (see README "Known limitations").


def shaded(image, level, box=(0, 330, 420, 569), blur=12):
    """A soft shadow (hand / phone) over the lower-left block: paper there drops to `level`."""
    shade = Image.new("L", image.size, 255)
    shade.paste(level, box)
    shade = shade.filter(ImageFilter.GaussianBlur(blur))
    return ImageChops.multiply(image, Image.merge("RGB", [shade] * 3))


@pytest.mark.parametrize("level", [184, 160, 140])
def test_shadowed_paper_is_not_ink(level):
    """Shaded paper below the old absolute 185 threshold used to fill every health box ("checked", 0.99, no review)."""
    result = analyse(shaded(S.filled_form(), level))
    assert result["marked"] == {"gender.female": "checked", "healthConditions.menstruation": "checked", "pressure.standard": "checked"}


@pytest.mark.parametrize("factor", [0.74, 0.72, 0.6])
def test_dimmed_sample_keeps_its_marks(sample_image, factor):
    result = analyse(Image.eval(sample_image, lambda v: int(v * factor)))
    assert {k for k, v in result["marked"].items() if v == "checked"} == {k for k, v in SAMPLE_MARKED.items() if v == "checked"}
    assert set(result["marked"]) <= set(SAMPLE_MARKED) | {f"massageOilScrub.{k}" for k, *_ in L.CHECKBOXES["massageOilScrub"]}
    assert result["text"] == {"name": "present", "nationality": "present", "hotelName": "empty"}


def test_paper_level_follows_local_shading():
    paper = M.paper_level(shaded(S.blank_form(), 160).convert("L"))
    assert paper.getpixel((600, 200)) >= 250 and 150 <= paper.getpixel((100, 450)) <= 170


def test_implausible_checkbox_groups_are_reported():
    image = S.blank_form()
    draw = ImageDraw.Draw(image)
    for key, *_ in L.CHECKBOXES["healthConditions"][:9]:
        S.tick(draw, "healthConditions", key)
    warnings = M.implausible_checkboxes(analyse(image)["boxes"])
    assert warnings == ["9 of 16 healthConditions boxes read as checked; the page may be shaded or tinted"]
    assert M.implausible_checkboxes(analyse(S.filled_form())["boxes"]) == []


@pytest.mark.parametrize("factor, quality, side", [(0.85, 50, None), (0.85, 70, None), (0.8, 85, None), (0.9, 50, 1280), (0.8, 70, 1600)])
def test_dim_jpeg_keeps_body_map_circles(sample_image, factor, quality, side):
    """Phone photos / messenger forwards (paper ~200-230, JPEG): a paper-relative threshold alone dropped thin circles or
    turned Neck (back) into an avoid-area cross; the absolute ceiling plus a smaller relative drop keeps all three."""
    import io
    image = sample_image if side is None else sample_image.resize((side, round(side * L.REF_H / L.REF_W)), Image.LANCZOS)
    buffer = io.BytesIO()
    Image.eval(image, lambda v: int(v * factor)).save(buffer, format="JPEG", quality=quality)
    body = analyse(Image.open(io.BytesIO(buffer.getvalue())).convert("RGB"))["body"]
    assert set(body) == {("Shoulder (front)", "circle"), ("Neck (back)", "circle"), ("Back (back)", "circle")}


# ---------------------------------------------------------------- release 1 (v3.1) checkbox rules, calibrated on 95 real scans

def test_long_tailed_tick_is_checked_not_a_strike():
    image = S.blank_form()
    _, _, x, y, s = S.box_of("pressure", "standard")
    ImageDraw.Draw(image).line((x - 3, y + 5, x + 5, y + s - 2, x + 55, y - 30), fill=S.BLUE_PEN, width=2)  # starts left, long tail
    result = analyse(image)
    assert result["marked"] == {"pressure.standard": "checked"}


def test_tick_whose_tail_crosses_the_box_above_counts_only_for_its_own_box():
    image = S.blank_form()
    _, _, x, y, s = S.box_of("massageOilScrub", "orangeCinnamon")  # Jasmine is right above it
    ImageDraw.Draw(image).line((x + 2, y + 5, x + 5, y + s - 2, x + 9, y - 10), fill=S.BLUE_PEN, width=2)
    marked = analyse(image)["marked"]
    assert marked.get("massageOilScrub.orangeCinnamon") in ("checked",) and marked.get("massageOilScrub.jasmine", "struck") == "struck"


def test_strike_fragments_in_a_struck_row_are_dropped():
    image = S.blank_form()
    draw = ImageDraw.Draw(image)
    draw.line((505, 104, 790, 104), fill=S.BLUE_PEN, width=2)  # row struck out
    _, _, x, y, s = S.box_of("massageOilScrub", "lavender")
    draw.point((x + 5, y + 5), fill=S.BLUE_PEN)
    draw.point((x + 6, y + 5), fill=S.BLUE_PEN)
    draw.point((x + 5, y + 6), fill=S.BLUE_PEN)  # a faint speck that would be "ambiguous" on its own
    result = analyse(image)
    assert result["marked"] == {"massageOilScrub.jasmine": "struck", "massageOilScrub.rose": "struck", "massageOilScrub.citronella": "struck"}
    assert result["notes"]["massageOilScrub.lavender"] == "strike-fragment"


def test_light_tick_needs_review():
    image = S.blank_form()
    _, _, x, y, s = S.box_of("referralSources", "google")
    ImageDraw.Draw(image).point([(x + 3 + i, y + 5 + i) for i in range(4)] + [(x + 4 + i, y + 5 + i) for i in range(4)], fill=S.BLUE_PEN)
    m = next(m for key, _, m in analyse(image)["boxes"]["referralSources"] if key == "google")
    assert m["state"] == "checked" and m["note"] == "light" and m["confidence"] < M.REVIEW_BELOW


def test_tick_at_the_box_corner_counts_but_a_straight_line_on_the_label_does_not():
    image = S.blank_form()
    draw = ImageDraw.Draw(image)
    _, _, x, y, s = S.box_of("gender", "female")
    draw.line((x + s + 1, y + s, x + s + 4, y + s + 3, x + s + 22, y - 12), fill=S.BLUE_PEN, width=2)  # vertex just outside the corner
    _, _, x2, y2, s2 = S.box_of("healthConditions", "diabetes")
    draw.line((x2 + s2 + 12, y2 + s2, x2 + s2 + 60, y2 - 30), fill=S.BLUE_PEN, width=2)  # a strike line passing over the label
    marked = analyse(image)["marked"]
    assert marked.get("gender.female") == "ambiguous" and "healthConditions.diabetes" not in marked


def test_staff_note_starting_next_to_a_box_is_not_a_tick():
    image = S.blank_form()
    draw = ImageDraw.Draw(image)
    _, _, x, y, s = S.box_of("referralSources", "redBook")
    for i in range(9):  # an asterisk and a line of handwriting right after the box
        lx = x + s + 8 + i * 9
        draw.line((lx, y + s, lx + 4, y - 2, lx + 8, y + s), fill=S.BLUE_PEN, width=2)
    assert "referralSources.redBook" not in analyse(image)["marked"]


def test_text_on_the_referral_others_line_is_an_unsure_others():
    image = S.blank_form()
    x0, y0, x1, y1 = L.REFERRAL_OTHERS_LINE
    draw = ImageDraw.Draw(image)
    for i in range(5):
        lx = x0 + 4 + i * 11
        draw.line((lx, y1 - 5, lx + 4, y0 + 6, lx + 8, y1 - 5), fill=S.BLUE_PEN, width=2)
    result = analyse(image)
    assert result["marked"] == {"referralSources.others": "ambiguous"} and result["notes"]["referralSources.others"] == "text-on-others-line"


def test_header_boxes_count_handwriting_beside_them():
    image = S.blank_form()
    draw = ImageDraw.Draw(image)
    x0, y0, x1, y1 = L.HEADER_BESIDE_ZONES["date"][0]
    for i in range(4):  # a date written right of the DATE label instead of in the box
        lx = x0 + 6 + i * 12
        draw.line((lx, y1 - 4, lx + 4, y0 + 6, lx + 8, y1 - 4), fill=S.BLUE_PEN, width=2)
    lum = image.convert("L")
    geo, _ = R.register(np.asarray(M.border_darkness(image, lum)))
    mask, _ = M.ink_mask(image, lum, geo)
    ink = M.text_ink(mask, geo, L.HEADER_TEXT_BOXES, L.HEADER_BESIDE_ZONES)
    assert M.text_state(ink["date"]) == "present" and M.text_state(ink["time"]) == "empty"
