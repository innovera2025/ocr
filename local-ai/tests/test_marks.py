"""Deterministic detection: checkboxes, handwriting boxes and body map (no model calls)."""

from PIL import Image, ImageDraw

import ocr_layout as L
import ocr_marks as M
import synthetic_form as S


def analyse(image):
    if image.size != (L.REF_W, L.REF_H):
        image = image.resize((L.REF_W, L.REF_H), Image.BILINEAR)
    lum = image.convert("L")
    dx, dy, contrast = M.register(M.border_darkness(image, lum))
    mask, _ = M.ink_mask(image, lum, dx, dy)
    boxes = M.detect_checkboxes(mask, dx, dy)
    states = {f"{group}.{key}": m["state"] for group, items in boxes.items() for key, _, m in items}
    return {"offset": (dx, dy), "contrast": contrast, "boxes": boxes, "marked": {k: v for k, v in states.items() if v != "unchecked"},
            "text": {k: M.text_state(v) for k, v in M.text_ink(mask, dx, dy).items()},
            "body": {(m["area"], m["kind"]): m for m in M.detect_body_marks(mask, lum, dx, dy)}}


# Ground truth read visually from tests/fixtures/sample2.png (zoomed crops): Female, Menstruation and Standard are
# ticked; a wavy pen line is scribbled across the whole massage-oil row (through Jasmine, Rose and Lavender, beside
# Citronella and Orange-Cinnamon); no referral source is ticked; the Name box says "Chun", Nationality "Chinese",
# Hotel Name is empty; the body map has circles around Shoulder (front), Neck (back) and Back (back) and no crosses.
SAMPLE_MARKED = {
    "gender.female": "checked", "healthConditions.menstruation": "checked", "pressure.standard": "checked",
    "massageOilScrub.jasmine": "ambiguous", "massageOilScrub.rose": "ambiguous", "massageOilScrub.lavender": "ambiguous",
}


def test_sample2_checkboxes_match_visual_ground_truth(sample_image):
    result = analyse(sample_image)
    assert result["offset"] == (0, 0)
    assert result["marked"] == SAMPLE_MARKED
    notes = {key: m["note"] for key, _, m in result["boxes"]["massageOilScrub"] if m["state"] == "ambiguous"}
    assert set(notes.values()) == {"stroke-through"}
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
    ambiguous = {k for k, v in result["marked"].items() if v == "ambiguous"}
    assert checked == {k for k, v in SAMPLE_MARKED.items() if v == "checked"}
    # resampling blur can push the scribble that grazes Orange-Cinnamon's corner inside that box too: review, never "checked"
    assert {k for k, v in SAMPLE_MARKED.items() if v == "ambiguous"} <= ambiguous <= {f"massageOilScrub.{k}" for k, *_ in L.CHECKBOXES["massageOilScrub"]}
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


def test_long_stroke_through_boxes_is_ambiguous_not_checked():
    image = S.blank_form()
    draw = ImageDraw.Draw(image)
    draw.line((505, 104, 790, 104), fill=S.BLUE_PEN, width=2)  # scribble across the whole first oil row
    marked = analyse(image)["marked"]
    assert marked == {"massageOilScrub.jasmine": "ambiguous", "massageOilScrub.rose": "ambiguous", "massageOilScrub.citronella": "ambiguous"}


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
