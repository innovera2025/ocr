"""Deterministic (model-free) mark detection on a reference-size (805x569) RGB image.

Every template region is placed through the fitted registration (``ocr_register.Geometry``): each checkbox window at its
own fitted position, handwriting boxes as 4 strips (so a rotated scan keeps the printed border out of the interior), and
the body-map labels, leader lines, dots and figures one by one.

Pen ink = (a) bluish pixels anywhere (blue clearly above red and green; printed text on this form is dark *gray*,
luminance >= ~73, or light cyan-gray) or very dark pixels, plus (b) any darker-than-paper, non-orange pixel inside
*template-blank* zones (checkbox interiors at a 3 px inset, handwriting-box interiors, the body map minus its printed
labels, leader lines and figures). (b) is classic form dropout: it keeps black/red pens and heavily compressed JPEGs
(whose chroma subsampling washes out thin blue strokes) working, and the 3 px inset keeps printed checkbox borders
(luminance ~180 on real scans) out of the checkbox scores.
"""

import math

from PIL import Image, ImageChops, ImageFilter

import ocr_layout as L
from ocr_register import IDENTITY

# Ink classification thresholds (calibrated on sample2.png; see README "Calibration").
BLUE_STRONG, LUM_STRONG = 10, 175      # blueness >= 10 and luminance < 175
BLUE_FAINT, LUM_FAINT = 18, 215        # blueness >= 18 and luminance < 215 (faint, thin strokes)
LUM_DARK = 60                          # any pixel darker than this (black pen); printed text is >= ~73
LUM_PAPER, LUM_ANY_HUE, BLUE_MIN_PAPER = 185, 120, -25  # darker-than-paper inside blank zones (orange print excluded)
PAPER_MIN_DROP = 30                    # ...and at least this far below the *local* paper level (shadows, dim photos)
FIGURE_LUM = 125                       # pen on the orange body figures shows up dark (orange is ~180)

# Checkbox decision thresholds on the interior ink fraction (interior = box minus its 2 px border).
T_CHECKED, T_AMBIGUOUS = 0.10, 0.04
T_CONFIDENT, T_FILLED = 0.16, 0.50     # below 0.16 a tick is light (needs review); from 0.50 the box is filled (review)
WIDE_MARGIN = 8                        # a tick stroke reaching 8+ px beyond both sides: an X, a lead-in or handwriting (review)
CHECKBOX_DARK_INSET = 3                # darker-than-paper (non-blue) pixels only count 3 px inside the box
PASS_MARGIN = 4                        # a stroke "passes" a side when it reaches this far beyond it...
PASS_FLATNESS = 0.4                    # ...and is flat along that direction (height <= 0.4 x width): ticks pass both sides too
FLAT_LINE_HEIGHT = 9                   # px; a flat line (height <= 9, width >= 3 x height) through a box is a strike
SECTION_STROKE = 110                   # px; a stroke this long is a strike through a section, never a tick
STRUCK_MIN_BOXES = 3                   # one stroke through >= this many boxes = the row is struck out
STROKE_WINDOW = 260                    # px around a box followed along a stroke (covers the widest printed row)
BESIDE_WIDTH, BESIDE_RING, BESIDE_MIN = 26, 6, 14  # tick next to a box: label window width, ring width, min ink px
BESIDE_MAX_EXTENT, BESIDE_MIN_HEIGHT = 64, 8       # ...a compact stroke with some height (not a flat strike fragment)
BESIDE_TEXT_INK = 30                   # ink px further right that make the "mark" the start of a handwritten note
OTHERS_LINE_INK = 40                   # handwriting on the referral "Others" line counts as an (unsure) Others choice
REVIEW_BELOW = 0.7                     # confidence below this => needsReview

# Handwriting box emptiness (ink pixel counts inside a text box).
TEXT_EMPTY_MAX, TEXT_PRESENT_MIN = 12, 40
TEXT_STRIPS = 4


def _mask(img, fn):
    return img.point(lambda v: 255 if fn(v) else 0)


def color_ink(rgb, lum):
    """0/255 L-mode mask of bluish or very dark pixels (C-speed Pillow channel operations)."""
    r, g, b = rgb.split()
    blue = ImageChops.subtract(b, ImageChops.lighter(r, g))
    strong = ImageChops.darker(_mask(blue, lambda v: v >= BLUE_STRONG), _mask(lum, lambda v: v < LUM_STRONG))
    faint = ImageChops.darker(_mask(blue, lambda v: v >= BLUE_FAINT), _mask(lum, lambda v: v < LUM_FAINT))
    dark = _mask(lum, lambda v: v < LUM_DARK)
    return ImageChops.lighter(ImageChops.lighter(strong, faint), dark)


def paper_level(lum):
    """Local paper luminance (L image): the brightest level within ~10 px (4x reduce, 5x5 max filter, bilinear back up).
    A shadow, a dim photocopy or a grayish photo lowers it, so shaded paper is not mistaken for ink."""
    width, height = lum.size
    small = lum.reduce(4) if min(width, height) >= 20 else lum
    return small.filter(ImageFilter.MaxFilter(5)).resize((width, height), Image.BILINEAR)


def darker_than_paper(rgb, lum, paper=None):
    """Any pixel clearly darker than paper, except orange/yellow print (blue far below red/green). `paper` is the local
    paper level (`paper_level`); without it the paper is taken as white. With it a pixel must be both below LUM_PAPER
    and PAPER_MIN_DROP below the local paper: the absolute ceiling keeps thin pen strokes on dim JPEGs (paper ~200-230),
    the relative drop rejects shadows and dim paper that fall below LUM_PAPER."""
    r, g, b = rgb.split()
    # orange-ness = max(r, g) - b (clipped at 0); orange/yellow print has blue far below red/green
    not_orange = _mask(ImageChops.subtract(ImageChops.lighter(r, g), b), lambda v: v <= -BLUE_MIN_PAPER)
    if paper is None:
        below_paper = _mask(lum, lambda v: v < LUM_PAPER)
    else:
        below_paper = ImageChops.darker(_mask(lum, lambda v: v < LUM_PAPER),
                                        _mask(ImageChops.subtract(paper, lum), lambda v: v > PAPER_MIN_DROP))
    very_dark = ImageChops.darker(below_paper, _mask(lum, lambda v: v < LUM_ANY_HUE))
    return ImageChops.lighter(ImageChops.darker(below_paper, not_orange), very_dark)


def checkbox_position(geo, box):
    """Fitted top-left (x, y) of a template checkbox (key, label, x, y, size)."""
    return geo.box(box[2], box[3], box[4])


def text_strips(geo, box, inset=2):
    """Interior of a handwriting box (inset px inside its border) as TEXT_STRIPS fitted rectangles, left to right.
    Adjacent strips share their mapped boundary, so no column is counted twice or skipped."""
    x0, y0, x1, y1 = box[0] + inset, box[1] + inset, box[2] - inset, box[3] - inset
    xs = [x0 + (x1 - x0) * k / TEXT_STRIPS for k in range(TEXT_STRIPS + 1)]
    bounds = [int(round(geo.point(x, (y0 + y1) / 2)[0])) for x in xs]
    strips = []
    for k in range(TEXT_STRIPS):
        mid = (xs[k] + xs[k + 1]) / 2
        top, bottom = geo.point(mid, y0)[1], geo.point(mid, y1)[1]
        strips.append((bounds[k], int(round(top)), bounds[k + 1], int(round(bottom))))
    return strips


def blank_zones(size, geo=IDENTITY):
    """0/255 mask of areas that are blank on the printed template, placed through the fitted geometry."""
    zones = Image.new("L", size, 0)
    on, off = 255, 0

    def paste(rect, value):
        x0, y0, x1, y1 = rect
        if x1 > x0 and y1 > y0:
            zones.paste(value, (x0, y0, x1, y1))

    for boxes in L.CHECKBOXES.values():
        for box in boxes:
            x, y = checkbox_position(geo, box)
            s, inset = box[4], CHECKBOX_DARK_INSET
            paste((x + inset, y + inset, x + s - inset, y + s - inset), on)
    for box in (*L.TEXT_BOXES.values(), *L.HEADER_TEXT_BOXES.values()):
        for strip in text_strips(geo, box):
            paste(strip, on)
    paste(geo.rect(L.BODY_REGION), on)
    for figure in L.BODY_FIGURES.values():
        paste(geo.rect(figure), off)
    for _, side, lx0, ly0, lx1, ly1, ax, ay in L.BODY_LABELS:
        paste(geo.rect((lx0 - 2, ly0 - 2, lx1 + 2, ly1 + 2)), off)
        top, bottom = min((ly0 + ly1) // 2, ay) - 3, max((ly0 + ly1) // 2, ay) + 4  # dotted leader line to the figure
        paste(geo.rect((lx1 - 2, top, ax + 2, bottom) if side == "front" else (ax - 2, top, lx0 + 2, bottom)), off)
    return zones


def ink_mask(rgb, lum=None, geo=IDENTITY):
    """Pen-ink mask (see module docstring) and the luminance image."""
    lum = lum if lum is not None else rgb.convert("L")
    blank = blank_zones(rgb.size, geo)
    return ImageChops.lighter(color_ink(rgb, lum), ImageChops.darker(darker_than_paper(rgb, lum, paper_level(lum)), blank)), lum


def border_darkness(rgb, lum):
    """Darkness (255 - luminance) of low-chroma (printed gray) pixels; used to register checkbox borders."""
    r, g, b = rgb.split()
    chroma = ImageChops.subtract(ImageChops.lighter(ImageChops.lighter(r, g), b), ImageChops.darker(ImageChops.darker(r, g), b))
    return ImageChops.darker(ImageChops.invert(lum), _mask(chroma, lambda v: v < 50))


def count(mask, box):
    return mask.crop(box).histogram()[255]


# ---------------------------------------------------------------- checkboxes

class _Strokes:
    """Connected pen strokes through checkbox interiors (5x5 neighbourhood: gaps of 1 px stay connected), followed up to
    STROKE_WINDOW px around the box they start in. Each stroke: bbox, pixel count and the boxes whose interior it enters."""

    def __init__(self, mask, placed):
        self.bytes, (self.width, self.height) = mask.tobytes(), mask.size
        self.owner = {}  # interior pixel -> (group, key)
        for (group, key), (x, y, s) in placed.items():
            for py in range(max(0, y + 2), min(self.height, y + s - 2)):
                for px in range(max(0, x + 2), min(self.width, x + s - 2)):
                    self.owner[py * self.width + px] = (group, key)
        self.stroke_of = {}  # pixel -> stroke index
        self.strokes = []

    def through(self, x, y, s):
        """Strokes with ink inside the interior of the box at (x, y) of size s."""
        found, width, height, data = [], self.width, self.height, self.bytes
        window = (max(0, x - STROKE_WINDOW), max(0, y - STROKE_WINDOW), min(width, x + s + STROKE_WINDOW),
                  min(height, y + s + STROKE_WINDOW))
        for py in range(max(0, y + 2), min(height, y + s - 2)):
            for px in range(max(0, x + 2), min(width, x + s - 2)):
                p = py * width + px
                if data[p]:
                    if p not in self.stroke_of:
                        self._fill(p, window)
                    index = self.stroke_of[p]
                    if index not in found:
                        found.append(index)
        return [self.strokes[i] for i in found]

    def _fill(self, seed, window):
        x0w, y0w, x1w, y1w = window
        width, data, owner, stroke_of = self.width, self.bytes, self.owner, self.stroke_of
        index = len(self.strokes)
        stack, pixels, boxes = [seed], 0, set()
        stroke_of[seed] = index
        minx = maxx = seed % width
        miny = maxy = seed // width
        low = (minx, miny)
        while stack:
            p = stack.pop()
            pixels += 1
            if p in owner:
                boxes.add(owner[p])
            px, py = p % width, p // width
            for ny in range(max(py - 2, y0w), min(py + 3, y1w)):
                base = ny * width
                for nx in range(max(px - 2, x0w), min(px + 3, x1w)):
                    q = base + nx
                    if data[q] and q not in stroke_of:
                        stroke_of[q] = index
                        stack.append(q)
                        minx, maxx, miny = min(minx, nx), max(maxx, nx), min(miny, ny)
                        if ny > maxy:
                            maxy, low = ny, (nx, ny)
        self.strokes.append({"bbox": (minx, miny, maxx, maxy), "low": low, "pixels": pixels, "boxes": boxes, "index": index})

    def pixels_in(self, stroke, rect):
        x0, y0, x1, y1 = rect
        width, index, stroke_of = self.width, stroke["index"], self.stroke_of
        return sum(1 for py in range(y0, y1) for px in range(x0, x1) if stroke_of.get(py * width + px) == index)


def _is_strike(stroke, x, y, s):
    """A stroke through the box that is not a tick (calibrated on 95 real scans, where big ticks with long tails reach
    60-80 px and often start a few px left of the box): one stroke through >= 3 boxes, a stroke longer than any tick,
    a flat line longer than the box, or a flat stroke passing both opposite sides of the box."""
    minx, miny, maxx, maxy = stroke["bbox"]
    width, height = maxx - minx + 1, maxy - miny + 1
    if len(stroke["boxes"]) >= STRUCK_MIN_BOXES or max(width, height) >= SECTION_STROKE:
        return True
    if len(stroke["boxes"]) == 2 and not _holds_low_point(stroke, x, y, s):
        return True  # a tick belongs to the box holding its lowest point; the other box is only crossed
    if _flat(width, height, s):
        return True
    passes_x = minx <= x - PASS_MARGIN and maxx >= x + s - 1 + PASS_MARGIN
    passes_y = miny <= y - PASS_MARGIN and maxy >= y + s - 1 + PASS_MARGIN
    return (passes_x and height <= PASS_FLATNESS * width) or (passes_y and width <= PASS_FLATNESS * height)


def _holds_low_point(stroke, x, y, s):
    """The stroke's lowest pixel (a tick's vertex) is in the box (border included), and the stroke rises above it (the
    tick's tail)."""
    lx, ly = stroke["low"]
    return x <= lx <= x + s - 1 and y + 1 <= ly <= y + s and stroke["bbox"][1] <= y - PASS_MARGIN


def _tick_into_strike(strokes, stroke, group, x, y, s):
    """A tick whose tail runs on into a strike of its own group: the stroke starts at the box (it does not come in from
    the left), stays within the group's boxes, has its lowest point, the tick's vertex, in the box, and a first arm
    coming down into that vertex from the upper left (a line that merely starts in the box has none)."""
    if not (stroke["bbox"][0] >= x - PASS_MARGIN and all(g == group for g, _ in stroke["boxes"]) and _holds_low_point(stroke, x, y, s)):
        return False
    lx, ly = stroke["low"]
    return strokes.pixels_in(stroke, (x - 3, max(0, y - 6), max(x - 3, lx - 1), max(0, ly - 2))) >= 3


def _flat(width, height, s):
    """A flat line segment longer than the box (a strike or a strike fragment), never a tick."""
    return height <= FLAT_LINE_HEIGHT and width >= max(s + 2, 3 * height)


def _unchecked_conf(frac):
    return round(0.9 + 0.09 * max(0.0, 1.0 - frac / T_AMBIGUOUS), 3)


def _straight(points, s):
    """A straight segment longer than 2.5 box sizes (its pixels within ~1.5 px of one line): a line, never a tick."""
    n = len(points)
    if n < 8:
        return False
    mx, my = sum(p % 100000 for p in points) / n, sum(p // 100000 for p in points) / n
    sxx = sum((p % 100000 - mx) ** 2 for p in points) / n
    syy = sum((p // 100000 - my) ** 2 for p in points) / n
    sxy = sum((p % 100000 - mx) * (p // 100000 - my) for p in points) / n
    half, root = (sxx + syy) / 2, math.sqrt(max(0.0, ((sxx - syy) / 2) ** 2 + sxy ** 2))
    return 4 * math.sqrt(half + root) >= 2.5 * s and math.sqrt(max(0.0, half - root)) <= 1.5


def _flood(data, width, height, seed, seen, window, owner, points=None):
    """Flood fill inside window -> (pixel count, bbox, boxes whose interior it enters); points (x + 100000 y) collected
    into `points` when given."""
    x0w, y0w, x1w, y1w = max(0, window[0]), max(0, window[1]), min(width, window[2]), min(height, window[3])
    stack, pixels, boxes = [seed], 0, set()
    seen.add(seed)
    minx = maxx = seed % width
    miny = maxy = seed // width
    while stack:
        p = stack.pop()
        pixels += 1
        if points is not None:
            points.append(p % width + 100000 * (p // width))
        if p in owner:
            boxes.add(owner[p])
        px, py = p % width, p // width
        for ny in range(max(py - 2, y0w), min(py + 3, y1w)):
            base = ny * width
            for nx in range(max(px - 2, x0w), min(px + 3, x1w)):
                q = base + nx
                if data[q] and q not in seen:
                    seen.add(q)
                    stack.append(q)
                    minx, maxx, miny, maxy = min(minx, nx), max(maxx, nx), min(miny, ny), max(maxy, ny)
    return pixels, (minx, miny, maxx, maxy), boxes


def _beside(mask, strokes, group, key, x, y, s):
    """Ink of a mark drawn next to the box -- on the 6 px ring around it or on its printed label to the right -- that is a
    compact tick-like stroke: not part of another box's stroke, not a flat line, not longer than a tick (-> pixel count)."""
    width, height = mask.size
    ring = (max(0, x - BESIDE_RING), max(0, y - BESIDE_RING), min(width, x + s + BESIDE_RING), min(height, y + s + BESIDE_RING))
    label = (x + s + BESIDE_RING, max(0, y - 3), min(width, x + s + 1 + BESIDE_WIDTH), min(height, y + s + 3))
    windows = [w for w in (ring, label) if w[2] > w[0] and w[3] > w[1]]
    if sum(count(mask, w) for w in windows) - count(mask, (x, y, x + s, y + s)) < BESIDE_MIN:
        return 0
    text = (x + s + BESIDE_WIDTH + 2, max(0, y - 6), min(width, x + s + BESIDE_WIDTH + 80), min(height, y + s + 6))
    if text[2] > text[0] and count(mask, text) >= BESIDE_TEXT_INK:
        return 0  # a line of handwriting starts next to the box (a staff note), not a tick
    data, seen, own = strokes.bytes, set(), 0
    search = (max(0, x - 40), max(0, y - 40), min(width, x + s + BESIDE_WIDTH + 40), min(height, y + s + 40))
    for wx0, wy0, wx1, wy1 in windows:
        for py in range(wy0, wy1):
            for px in range(wx0, wx1):
                seed = py * width + px
                if not data[seed] or seed in seen or (x <= px < x + s and y <= py < y + s):
                    continue
                points = []
                pixels, (minx, miny, maxx, maxy), boxes = _flood(data, width, height, seed, seen, search, strokes.owner, points)
                w, h = maxx - minx + 1, maxy - miny + 1
                clipped = (minx == search[0] > 0 or miny == search[1] > 0 or maxx == search[2] - 1 < width - 1
                           or maxy == search[3] - 1 < height - 1)  # runs out of the search window: a long stroke
                on_ring = minx < ring[2] and maxx >= ring[0] and miny < ring[3] and maxy >= ring[1] and any(
                    ring[0] <= q % 100000 < ring[2] and ring[1] <= q // 100000 < ring[3] for q in points)
                if (boxes - {(group, key)} or clipped or max(w, h) > BESIDE_MAX_EXTENT or _flat(w, h, s) or h < BESIDE_MIN_HEIGHT
                        or (not on_ring and _straight(points, s))):  # away from the box a straight segment is a line
                    continue
                own += pixels
    return own


def _others_line_text(mask, geo):
    """Handwriting on the writing line after the referral 'Others' label (the reason, e.g. 'friend') -> ink px."""
    return sum(count(mask, strip) for strip in text_strips(geo, L.REFERRAL_OTHERS_LINE, inset=0))


def _measure(mask, strokes, group, x, y, s):
    """Interior measurement of one box -> dict(state, score, confidence, note)."""
    interior = (x + 2, y + 2, x + s - 2, y + s - 2)
    area = (s - 4) * (s - 4)
    inside = count(mask, interior)
    frac = inside / area
    if frac < T_AMBIGUOUS:
        return {"state": "unchecked", "score": frac, "confidence": _unchecked_conf(frac), "note": None}
    through = strokes.through(x, y, s)
    strikes = [st for st in through if _is_strike(st, x, y, s)]
    rest = [st for st in through if st not in strikes]
    tick_frac = sum(strokes.pixels_in(st, interior) for st in rest) / area
    if strikes:
        if tick_frac >= T_CHECKED or any(_tick_into_strike(strokes, st, group, x, y, s) for st in strikes):
            # a separate tick next to the strike, or a tick whose tail runs on into the strike: a choice, for review
            return {"state": "ambiguous", "score": frac, "confidence": 0.5, "note": "tick-and-strike"}
        note = "row-struck-out" if any(len(st["boxes"]) >= STRUCK_MIN_BOXES for st in strikes) else "stroke-through"
        return {"state": "struck", "score": frac, "confidence": 0.35, "note": note}
    if frac < T_CHECKED:
        return {"state": "ambiguous", "score": frac, "confidence": round(0.4 + (frac - T_AMBIGUOUS) * 3, 3), "note": "faint"}
    if frac >= T_FILLED:  # a box filled with ink: an X mark or a scribbled-out choice (as dense as each other)
        return {"state": "ambiguous", "score": frac, "confidence": 0.5, "note": "filled"}
    main = max(rest, key=lambda st: strokes.pixels_in(st, interior)) if rest else None
    if main and main["bbox"][0] <= x - WIDE_MARGIN and main["bbox"][2] >= x + s - 1 + WIDE_MARGIN:
        return {"state": "checked", "score": frac, "confidence": 0.6, "note": "wide-stroke"}  # an X, a lead-in tick or handwriting
    if frac < T_CONFIDENT:
        return {"state": "checked", "score": frac, "confidence": round(0.6 + (frac - T_CHECKED), 3), "note": "light"}
    return {"state": "checked", "score": frac, "confidence": round(0.8 + min(0.19, (frac - T_CONFIDENT) * 1.9), 3), "note": None}


def detect_checkboxes(mask, geo=IDENTITY):
    """All template checkboxes -> {group: [(key, label, measurement)]}; measurement = dict(state, score, confidence, note)
    with state checked | ambiguous | struck | unchecked. ``struck``: a stroke through the box (one stroke through >= 3
    boxes = row struck out, a stroke longer than a tick, a flat line, or a flat stroke passing both opposite sides) --
    never a selection. In a group with a struck box, faint marks and marks beside a box are taken as parts of the strike
    and dropped, and the remaining ticks need review. A tick drawn next to a box (ring or printed label) is ``ambiguous``."""
    placed = {(group, box[0]): (*checkbox_position(geo, box), box[4]) for group, boxes in L.CHECKBOXES.items() for box in boxes}
    strokes = _Strokes(mask, placed)
    out = {}
    for group, boxes in L.CHECKBOXES.items():
        items = [(key, label, _measure(mask, strokes, group, *placed[(group, key)])) for key, label, *_ in boxes]
        if any(m["state"] == "struck" for _, _, m in items):
            for _, _, m in items:
                if m["note"] in ("faint", "light"):
                    m.update(state="unchecked", confidence=0.5, note="strike-fragment")
                elif m["state"] == "checked":
                    m.update(confidence=min(m["confidence"], 0.6), note=m["note"] or "beside-strike")
        else:
            for key, _, m in items:
                if m["state"] == "unchecked" and _beside(mask, strokes, group, key, *placed[(group, key)]) >= BESIDE_MIN:
                    m.update(state="ambiguous", confidence=0.5, note="mark-beside-box")
        if group == "referralSources":
            others = next(m for key, _, m in items if key == "others")
            if others["state"] == "unchecked" and _others_line_text(mask, geo) >= OTHERS_LINE_INK:
                others.update(state="ambiguous", confidence=0.5, note="text-on-others-line")
        out[group] = items
    return out


def implausible_checkboxes(checkboxes, min_boxes=8):
    """Warnings for multi-choice groups (>= min_boxes boxes) where more than half of the boxes read as checked: real
    forms never look like that, a shaded or tinted page does. The caller flags every deterministic field for review."""
    warnings = []
    for group, items in checkboxes.items():
        checked = sum(1 for _, _, m in items if m["state"] == "checked")
        if group not in L.SINGLE_CHOICE and len(items) >= min_boxes and checked * 2 > len(items):
            warnings.append(f"{checked} of {len(items)} {group} boxes read as checked; the page may be shaded or tinted")
    return warnings


def text_ink(mask, geo=IDENTITY, boxes=None, beside=None):
    """Ink pixel count inside each handwriting box interior (border excluded), counted strip by strip, plus the ink in
    the key's `beside` zones (plain paper next to the box, where only pen colour counts as ink)."""
    boxes = L.TEXT_BOXES if boxes is None else boxes
    beside = beside or {}
    return {key: sum(count(mask, strip) for strip in text_strips(geo, box)) + sum(count(mask, geo.rect(z)) for z in beside.get(key, ()))
            for key, box in boxes.items()}


def text_state(pixels):
    if pixels <= TEXT_EMPTY_MAX:
        return "empty"
    return "present" if pixels >= TEXT_PRESENT_MIN else "uncertain"


# ---------------------------------------------------------------- body map

def _body_labels(geo):
    """BODY_LABELS with the label box and leader dot placed through the fitted geometry."""
    out = []
    for area, side, lx0, ly0, lx1, ly1, ax, ay in L.BODY_LABELS:
        qx0, qy0, qx1, qy1 = geo.rect((lx0, ly0, lx1, ly1))
        dot = geo.point(ax, ay)
        out.append((area, side, qx0, qy0, qx1, qy1, int(round(dot[0])), int(round(dot[1]))))
    return out


def _body_ink(mask, lum, geo, labels):
    """Ink mask restricted to the body map, plus dark pen strokes on the orange figures; printed dots removed."""
    region = geo.rect(L.BODY_REGION)
    body = Image.new("L", mask.size, 0)
    body.paste(mask.crop(region), region[:2])
    dark_on_figure = _mask(lum, lambda v: v < FIGURE_LUM)
    for figure in L.BODY_FIGURES.values():
        fig = geo.rect(figure)
        body.paste(ImageChops.lighter(body.crop(fig), dark_on_figure.crop(fig)), fig[:2])
    blank = Image.new("L", (9, 9), 0)
    for *_, ax, ay in labels:  # printed leader dots
        body.paste(blank, (ax - 4, ay - 4))
    return body, region


def _components(mask_bytes, width, region):
    x0, y0, x1, y1 = region
    seen, comps = set(), []
    for y in range(y0, y1):
        base = y * width
        for x in range(x0, x1):
            p = base + x
            if not mask_bytes[p] or p in seen:
                continue
            stack, pts = [p], []
            seen.add(p)
            while stack:
                q = stack.pop()
                pts.append(q)
                qx, qy = q % width, q // width
                for ny in range(max(qy - 2, y0), min(qy + 3, y1)):
                    for nx in range(max(qx - 2, x0), min(qx + 3, x1)):
                        n = ny * width + nx
                        if mask_bytes[n] and n not in seen:
                            seen.add(n)
                            stack.append(n)
            comps.append([(q % width, q // width) for q in pts])
    return comps


def _rect_distance(px, py, x0, y0, x1, y1):
    return math.hypot(max(x0 - px, 0, px - x1), max(y0 - py, 0, py - y1))


def classify_shape(points):
    """circle vs cross for a set of ink points. Returns (kind, confidence, features)."""
    xs, ys = [p[0] for p in points], [p[1] for p in points]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    w, h = x1 - x0 + 1, y1 - y0 + 1
    if w < 6 or h < 6:
        return "mark", 0.3, {"w": w, "h": h}
    cx, cy, hw, hh = (x0 + x1) / 2, (y0 + y1) / 2, max(w / 2, 1.0), max(h / 2, 1.0)
    sectors, quads, center, diag = set(), set(), 0, 0
    for x, y in points:
        nx, ny = (x - cx) / hw, (y - cy) / hh
        r = math.hypot(nx, ny)
        if r < 0.35:
            center += 1
        if r >= 0.55:
            sectors.add(int((math.atan2(ny, nx) + math.pi) / (2 * math.pi) * 12) % 12)
        if abs(abs(nx) - abs(ny)) < 0.3:
            diag += 1
            if r >= 0.5:
                quads.add((nx > 0, ny > 0))
    n = len(points)
    coverage, center_frac, diag_frac = len(sectors) / 12, center / n, diag / n
    # An X lies on the bbox diagonals with arms in all four quadrants (its centre may be hidden when it crosses
    # printed label text); a ring covers most directions with an empty centre and only ~30% of its ink near the diagonals.
    diag_score = max(0.0, min(1.0, (diag_frac - 0.35) / 0.35))
    circle = coverage * (1 - min(1.0, center_frac * 5)) * (1 - max(0.0, min(1.0, (diag_frac - 0.4) / 0.3)))
    cross = diag_score * (0.6 + 0.4 * min(1.0, center_frac * 5)) * (len(quads) / 4) ** 2
    kind = "circle" if circle >= cross else "cross"
    confidence = max(0.3, min(0.98, 0.5 + (max(circle, cross) - min(circle, cross)) * 0.6))
    if n < 40:  # too little ink to be sure of the shape
        confidence = min(confidence, 0.6)
    return kind, round(confidence, 3), {"coverage": round(coverage, 2), "center": round(center_frac, 2), "diagonal": round(diag_frac, 2)}


def detect_body_marks(mask, lum, geo=IDENTITY, min_pixels=15):
    """Pen marks on the FRONT/BACK body map -> list of dict(area, side, kind, confidence, needsReview, pixels)."""
    labels = _body_labels(geo)
    body, region = _body_ink(mask, lum, geo, labels)
    width = body.size[0]
    comps = [c for c in _components(body.tobytes(), width, region) if len(c) >= 6]
    groups = {}
    for comp in comps:
        xs, ys = [p[0] for p in comp], [p[1] for p in comp]
        ccx, ccy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
        dists = []
        for area, side, lx0, ly0, lx1, ly1, ax, ay in labels:
            label_d = _rect_distance(ccx, ccy, lx0, ly0, lx1, ly1)
            anchor_d = math.hypot(ccx - ax, ccy - ay)
            # on the label only when the mark overlaps the printed label (a circle encloses it, a cross covers it)
            overlaps = min(xs) <= lx1 + 3 and max(xs) >= lx0 - 3 and min(ys) <= ly1 + 3 and max(ys) >= ly0 - 3
            dists.append((min(label_d, anchor_d), label_d <= anchor_d and overlaps, area, side))
        dists.sort()
        best, second = dists[0], dists[1]
        if best[0] > 30:
            continue  # stray ink far from every label and figure part
        key = (best[2], best[3])
        grp = groups.setdefault(key, {"points": [], "onLabel": best[1], "ambiguous": False})
        grp["points"].extend(comp)
        grp["onLabel"] = grp["onLabel"] and best[1]
        if second[0] - best[0] < 4:
            grp["ambiguous"] = True
    marks = []
    for (area, side), grp in groups.items():
        if len(grp["points"]) < min_pixels:
            continue
        kind, confidence, features = classify_shape(grp["points"])
        if not grp["onLabel"]:
            confidence = min(confidence, 0.6)  # drawn on the figure: position-to-area mapping is approximate
        if grp["ambiguous"]:
            confidence = min(confidence, 0.55)
        if kind == "mark":
            kind = "circle"
        marks.append({"area": L.body_area_value(area, side), "side": side, "kind": kind, "confidence": confidence,
                      "needsReview": confidence < REVIEW_BELOW, "pixels": len(grp["points"]), "onLabel": grp["onLabel"], **features})
    order = {L.body_area_value(a, s): i for i, (a, s, *_rest) in enumerate(L.BODY_LABELS)}
    marks.sort(key=lambda m: order.get(m["area"], 99))
    return marks
