"""Draws a synthetic makkha-intake-v1 page (printed template + optional pen marks) from ocr_layout coordinates.

Used so the deterministic detectors are exercised even when the real (gitignored) sample scan is absent.
"""

from PIL import Image, ImageDraw

import ocr_layout as L

BLUE_PEN, BLACK_PEN = (40, 45, 150), (85, 85, 90)  # scanned black ballpoint is dark gray, not black


def blank_form():
    image = Image.new("RGB", (L.REF_W, L.REF_H), (255, 255, 255))
    draw = ImageDraw.Draw(image)
    for boxes in L.CHECKBOXES.values():
        for _, _, x, y, s in boxes:
            draw.rectangle((x, y, x + s - 1, y + s - 1), outline=(150, 150, 150), width=2)
    for x0, y0, x1, y1 in (*L.TEXT_BOXES.values(), *L.HEADER_TEXT_BOXES.values()):
        draw.rounded_rectangle((x0, y0, x1, y1), radius=4, outline=(170, 170, 170), width=2)
    for _, side, lx0, ly0, lx1, ly1, ax, ay in L.BODY_LABELS:
        draw.rectangle((lx0, ly0, lx1, ly1), fill=(95, 95, 95))  # printed label text stand-in (dark gray)
        cy = (ly0 + ly1) // 2
        draw.line((lx1 + 2, cy, ax, ay) if side == "front" else (ax, ay, lx0 - 2, cy), fill=(160, 160, 160), width=1)
    for fx0, fy0, fx1, fy1 in L.BODY_FIGURES.values():
        draw.rounded_rectangle((fx0 + 4, fy0 + 2, fx1 - 4, fy1 - 2), radius=12, fill=(240, 170, 80))
    for *_, ax, ay in L.BODY_LABELS:
        draw.rectangle((ax - 1, ay - 1, ax + 1, ay + 1), fill=(20, 20, 20))  # printed leader dots
    draw.rectangle((410, 485, 710, 569), outline=(224, 159, 84), width=2)
    return image


def box_of(group, key):
    return next(b for b in L.CHECKBOXES[group] if b[0] == key)


def tick(draw, group, key, color=BLUE_PEN, width=2):
    _, _, x, y, s = box_of(group, key)
    draw.line((x + 2, y + s // 2, x + s // 2 - 1, y + s - 3, x + s + 4, y - 6), fill=color, width=width)


def label_box(area, side):
    return next(b[2:6] for b in L.BODY_LABELS if b[0] == area and b[1] == side)


def circle_label(draw, area, side, color=BLUE_PEN, width=2):
    x0, y0, x1, y1 = label_box(area, side)
    draw.ellipse((x0 - 6, y0 - 6, x1 + 6, y1 + 6), outline=color, width=width)


def cross_label(draw, area, side, color=BLUE_PEN, width=2):
    x0, y0, x1, y1 = label_box(area, side)
    cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
    draw.line((cx - 12, cy - 9, cx + 12, cy + 9), fill=color, width=width)
    draw.line((cx - 12, cy + 9, cx + 12, cy - 9), fill=color, width=width)


def write_in_box(draw, key, color=BLUE_PEN):
    x0, y0, x1, y1 = L.TEXT_BOXES[key] if key in L.TEXT_BOXES else L.HEADER_TEXT_BOXES[key]
    for i in range(6):  # a few "letters"
        lx = x0 + 10 + i * 12
        draw.line((lx, y1 - 5, lx + 4, y0 + 5, lx + 8, y1 - 5), fill=color, width=2)


def filled_form():
    """Female + Menstruation + Standard ticked, name/nationality written, Shoulder(front) circled, Calf(back) crossed."""
    image = blank_form()
    draw = ImageDraw.Draw(image)
    tick(draw, "gender", "female")
    tick(draw, "healthConditions", "menstruation")
    tick(draw, "pressure", "standard", color=BLACK_PEN)
    write_in_box(draw, "name")
    write_in_box(draw, "nationality", color=BLACK_PEN)
    circle_label(draw, "Shoulder", "front")
    cross_label(draw, "Calf", "back")
    return image


def transformed(image, scale=1.0, rotation_deg=0.0):
    """The page scaled about its centre and rotated (the ocr_register convention: positive = clockwise on screen), as a
    slightly shrunk and skewed scan would be (real SUKHUMVIT 33 scans: scale ~0.993, rotation -0.4..+0.1 degrees)."""
    import math
    cx, cy = L.REF_W / 2, L.REF_H / 2
    t = math.radians(rotation_deg)
    c, s = math.cos(t) / scale, math.sin(t) / scale
    # output q -> source p = R(-t)(q - C) / scale + C
    data = (c, s, cx - c * cx - s * cy, -s, c, cy + s * cx - c * cy)
    return image.transform(image.size, Image.AFFINE, data, resample=Image.BICUBIC, fillcolor=(255, 255, 255))


def pink_stamp(draw, box, color=(236, 118, 170)):
    """A PAID-like stamp: a thick pink frame with block letters inside."""
    x0, y0, x1, y1 = box
    draw.rectangle(box, outline=color, width=3)
    step = (x1 - x0 - 8) // 4
    for i in range(4):
        lx = x0 + 6 + i * step
        draw.rectangle((lx, y0 + 5, lx + step - 6, y1 - 5), outline=color, width=3)
