"""Deterministic (model-free) mark detection on a reference-size (805x569) RGB image.

Pen ink = (a) bluish pixels anywhere (blue clearly above red and green; printed text on this form is dark *gray*,
luminance >= ~73, or light cyan-gray) or very dark pixels, plus (b) any darker-than-paper, non-orange pixel inside
*template-blank* zones (checkbox interiors, handwriting-box interiors, the body map minus its printed labels,
leader lines and figures). (b) is classic form dropout: it keeps black/red pens and heavily compressed JPEGs
(whose chroma subsampling washes out thin blue strokes) working. Only Pillow is required.
"""

import math

from PIL import Image, ImageChops, ImageFilter

import ocr_layout as L

# Ink classification thresholds (calibrated on sample2.png; see README "Calibration").
BLUE_STRONG, LUM_STRONG = 10, 175      # blueness >= 10 and luminance < 175
BLUE_FAINT, LUM_FAINT = 18, 215        # blueness >= 18 and luminance < 215 (faint, thin strokes)
LUM_DARK = 60                          # any pixel darker than this (black pen); printed text is >= ~73
LUM_PAPER, LUM_ANY_HUE, BLUE_MIN_PAPER = 185, 120, -25  # darker-than-paper inside blank zones (orange print excluded)
PAPER_MIN_DROP = 30                    # ...and at least this far below the *local* paper level (shadows, dim photos)
FIGURE_LUM = 125                       # pen on the orange body figures shows up dark (orange is ~180)

# Checkbox decision thresholds on the interior ink fraction.
T_CHECKED, T_AMBIGUOUS, T_MARGIN = 0.10, 0.04, 0.10
LONG_STROKE = 48                       # px; a component longer than this passing through a box is not a tick
REVIEW_BELOW = 0.7                     # confidence below this => needsReview

# Handwriting box emptiness (ink pixel counts inside a text box).
TEXT_EMPTY_MAX, TEXT_PRESENT_MIN = 12, 40


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


def blank_zones(size, dx=0, dy=0):
    """0/255 mask of areas that are blank on the printed template (shifted by the registration offset)."""
    zones = Image.new("L", size, 0)
    on, off = 255, 0

    def rect(box, value, inset=0):
        x0, y0, x1, y1 = box
        if x1 - x0 > 2 * inset and y1 - y0 > 2 * inset:
            zones.paste(value, (x0 + dx + inset, y0 + dy + inset, x1 + dx - inset, y1 + dy - inset))

    for boxes in L.CHECKBOXES.values():
        for _, _, x, y, s in boxes:
            rect((x, y, x + s, y + s), on, 2)
    for box in L.TEXT_BOXES.values():
        rect(box, on, 2)
    rect(L.BODY_REGION, on)
    for figure in L.BODY_FIGURES.values():
        rect(figure, off)
    for _, side, lx0, ly0, lx1, ly1, ax, ay in L.BODY_LABELS:
        rect((lx0 - 2, ly0 - 2, lx1 + 2, ly1 + 2), off)
        top, bottom = min((ly0 + ly1) // 2, ay) - 3, max((ly0 + ly1) // 2, ay) + 4  # dotted leader line to the figure
        rect((lx1 - 2, top, ax + 2, bottom) if side == "front" else (ax - 2, top, lx0 + 2, bottom), off)
    return zones


def ink_mask(rgb, lum=None, dx=0, dy=0):
    """Pen-ink mask (see module docstring) and the luminance image."""
    lum = lum if lum is not None else rgb.convert("L")
    blank = blank_zones(rgb.size, dx, dy)
    return ImageChops.lighter(color_ink(rgb, lum), ImageChops.darker(darker_than_paper(rgb, lum, paper_level(lum)), blank)), lum


def border_darkness(rgb, lum):
    """Darkness (255 - luminance) of low-chroma (printed gray) pixels; used to register checkbox borders."""
    r, g, b = rgb.split()
    chroma = ImageChops.subtract(ImageChops.lighter(ImageChops.lighter(r, g), b), ImageChops.darker(ImageChops.darker(r, g), b))
    return ImageChops.darker(ImageChops.invert(lum), _mask(chroma, lambda v: v < 50))


def count(mask, box):
    return mask.crop(box).histogram()[255]


class _Integral:
    def __init__(self, img):
        self.w, self.h = img.size
        data = img.tobytes()
        w = self.w
        table = [[0] * (w + 1)]
        for y in range(self.h):
            row, acc, prev = [0] * (w + 1), 0, table[y]
            base = y * w
            for x in range(w):
                acc += data[base + x]
                row[x + 1] = prev[x + 1] + acc
            table.append(row)
        self.t = table

    def sum(self, x0, y0, x1, y1):
        t = self.t
        return t[y1][x1] - t[y0][x1] - t[y1][x0] + t[y0][x0]


def _ring_contrast(integral, x, y, s):
    """Mean darkness of the 2px square ring minus the mean darkness of the 2px band around it."""
    outer = integral.sum(x, y, x + s, y + s)
    inner = integral.sum(x + 2, y + 2, x + s - 2, y + s - 2)
    around = integral.sum(x - 2, y - 2, x + s + 2, y + s + 2) - outer
    return (outer - inner) / (s * s - (s - 4) ** 2) - around / ((s + 4) ** 2 - s * s)


def register(dark, radius=5):
    """Find the (dx, dy) shift of the printed checkbox grid. Returns (dx, dy, mean ring contrast at the shift)."""
    boxes = [next(b for b in L.CHECKBOXES[group] if b[0] == key) for group, key in L.REGISTRATION_BOXES]
    pad = radius + 2
    windows = []
    for _, _, x, y, s in boxes:
        crop_box = (x - pad, y - pad, x + s + pad, y + s + pad)
        windows.append((_Integral(dark.crop(crop_box)), s))
    best = None
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            total = sum(_ring_contrast(integral, pad + dx, pad + dy, s) for integral, s in windows)
            score = (total / len(windows), -(abs(dx) + abs(dy)))
            if best is None or score > best[0]:
                best = (score, dx, dy)
    base = sum(_ring_contrast(integral, pad, pad, s) for integral, s in windows) / len(windows)
    (contrast, _), dx, dy = best
    if contrast < base + 3:  # not clearly better than the template position: keep it
        return 0, 0, round(base, 1)
    return dx, dy, round(contrast, 1)


def _component_extents(mask_bytes, width, height, seeds, window):
    """Flood-fill ink from seed pixels inside window (x0, y0, x1, y1); returns [(extent_w, extent_h, pixels)]."""
    x0w, y0w, x1w, y1w = window
    seen, comps = set(), []
    for seed in seeds:
        if seed in seen:
            continue
        stack, seen_local = [seed], 1
        seen.add(seed)
        minx = maxx = seed % width
        miny = maxy = seed // width
        while stack:
            p = stack.pop()
            px, py = p % width, p // width
            for ny in range(max(py - 2, y0w), min(py + 3, y1w)):
                rowbase = ny * width
                for nx in range(max(px - 2, x0w), min(px + 3, x1w)):
                    q = rowbase + nx
                    if mask_bytes[q] and q not in seen:
                        seen.add(q)
                        stack.append(q)
                        seen_local += 1
                        minx, maxx, miny, maxy = min(minx, nx), max(maxx, nx), min(miny, ny), max(maxy, ny)
        comps.append((maxx - minx + 1, maxy - miny + 1, seen_local))
    return comps


def _seeds(mask_bytes, width, box):
    x0, y0, x1, y1 = box
    return [y * width + x for y in range(y0, y1) for x in range(x0, x1) if mask_bytes[y * width + x]]


def _unchecked_conf(frac):
    return round(0.9 + 0.09 * max(0.0, 1.0 - frac / T_AMBIGUOUS), 3)


def measure_checkbox(mask, mask_bytes, box, dx=0, dy=0):
    """Classify one checkbox. Returns dict(state=checked|ambiguous|unchecked, score, confidence, note)."""
    _, _, x, y, s = box
    x, y = x + dx, y + dy
    width, height = mask.size
    interior = (x + 2, y + 2, x + s - 2, y + s - 2)
    area = (s - 4) * (s - 4)
    inside = count(mask, interior)
    around = count(mask, (x - 3, y - 3, x + s + 3, y + s + 3)) - count(mask, (x, y, x + s, y + s))
    frac, margin = inside / area, around / ((s + 6) ** 2 - s * s)
    window = (max(0, x - LONG_STROKE), max(0, y - LONG_STROKE), min(width, x + s + LONG_STROKE), min(height, y + s + LONG_STROKE))
    if inside:
        comps = _component_extents(mask_bytes, width, height, _seeds(mask_bytes, width, interior), window)
        if max(max(w, h) for w, h, _ in comps) > LONG_STROKE:
            return {"state": "ambiguous", "score": frac, "confidence": 0.35, "note": "stroke-through"}
    if frac >= T_CHECKED:
        return {"state": "checked", "score": frac, "confidence": round(0.8 + min(0.19, (frac - T_CHECKED) * 1.9), 3), "note": None}
    if frac >= T_AMBIGUOUS:
        return {"state": "ambiguous", "score": frac, "confidence": round(0.4 + (frac - T_AMBIGUOUS) * 3, 3), "note": "faint"}
    if margin >= T_MARGIN:
        ring = (x - 3, y - 3, x + s + 3, y + s + 3)
        seeds = [p for p in _seeds(mask_bytes, width, ring) if not (x <= p % width < x + s and y <= p // width < y + s)]
        comps = _component_extents(mask_bytes, width, height, seeds, window)
        if comps and max(max(w, h) for w, h, _ in comps) <= LONG_STROKE:
            return {"state": "ambiguous", "score": frac, "confidence": 0.45, "note": "mark-beside-box"}
    return {"state": "unchecked", "score": frac, "confidence": _unchecked_conf(frac), "note": None}


def detect_checkboxes(mask, dx=0, dy=0):
    """All template checkboxes -> {group: [(key, label, measurement)]}."""
    mask_bytes = mask.tobytes()
    return {group: [(box[0], box[1], measure_checkbox(mask, mask_bytes, box, dx, dy)) for box in boxes]
            for group, boxes in L.CHECKBOXES.items()}


def implausible_checkboxes(checkboxes, min_boxes=8):
    """Warnings for multi-choice groups (>= min_boxes boxes) where more than half of the boxes read as checked: real
    forms never look like that, a shaded or tinted page does. The caller flags every deterministic field for review."""
    warnings = []
    for group, items in checkboxes.items():
        checked = sum(1 for _, _, m in items if m["state"] == "checked")
        if group not in L.SINGLE_CHOICE and len(items) >= min_boxes and checked * 2 > len(items):
            warnings.append(f"{checked} of {len(items)} {group} boxes read as checked; the page may be shaded or tinted")
    return warnings


def text_ink(mask, dx=0, dy=0):
    """Ink pixel count inside each handwriting box (border excluded, small overflow allowed)."""
    out = {}
    for key, (x0, y0, x1, y1) in L.TEXT_BOXES.items():
        out[key] = count(mask, (x0 + 2 + dx, y0 + 2 + dy, x1 - 1 + dx, y1 - 1 + dy))
    return out


def text_state(pixels):
    if pixels <= TEXT_EMPTY_MAX:
        return "empty"
    return "present" if pixels >= TEXT_PRESENT_MIN else "uncertain"


# ---------------------------------------------------------------- body map

def _body_ink(mask, lum, dx, dy):
    """Ink mask restricted to the body map, plus dark pen strokes on the orange figures; printed dots removed."""
    region = (L.BODY_REGION[0] + dx, L.BODY_REGION[1] + dy, L.BODY_REGION[2] + dx, L.BODY_REGION[3] + dy)
    body = Image.new("L", mask.size, 0)
    body.paste(mask.crop(region), region[:2])
    dark_on_figure = _mask(lum, lambda v: v < FIGURE_LUM)
    for fx0, fy0, fx1, fy1 in L.BODY_FIGURES.values():
        fig = (fx0 + dx, fy0 + dy, fx1 + dx, fy1 + dy)
        body.paste(ImageChops.lighter(body.crop(fig), dark_on_figure.crop(fig)), fig[:2])
    blank = Image.new("L", (9, 9), 0)
    for *_, ax, ay in L.BODY_LABELS:  # printed leader dots
        body.paste(blank, (ax + dx - 4, ay + dy - 4))
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


def detect_body_marks(mask, lum, dx=0, dy=0, min_pixels=15):
    """Pen marks on the FRONT/BACK body map -> list of dict(area, side, kind, confidence, needsReview, pixels)."""
    body, region = _body_ink(mask, lum, dx, dy)
    width = body.size[0]
    comps = [c for c in _components(body.tobytes(), width, region) if len(c) >= 6]
    groups = {}
    for comp in comps:
        xs, ys = [p[0] for p in comp], [p[1] for p in comp]
        ccx, ccy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
        dists = []
        for area, side, lx0, ly0, lx1, ly1, ax, ay in L.BODY_LABELS:
            label_d = _rect_distance(ccx, ccy, lx0 + dx, ly0 + dy, lx1 + dx, ly1 + dy)
            anchor_d = math.hypot(ccx - ax - dx, ccy - ay - dy)
            dists.append((min(label_d, anchor_d), label_d <= anchor_d, area, side))
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
