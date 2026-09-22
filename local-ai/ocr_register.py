"""Fitted registration of a scan against the printed checkbox grid of ``makkha-intake-v1`` (numpy), and the template verdict.

The printed checkbox borders are the registration target: all 39 boxes, ring contrast = mean darkness of the 2 px border
ring minus the 2 px band around it (low-chroma pixels only, see ``ocr_marks.border_darkness``). Steps (release1-plan A1):

1. coarse search: uniform scale 0.97-1.02 (step 0.0025) x shift +-24 px, mean ring contrast over all boxes;
2. per-box local search +-3 px around the coarse prediction;
3. weighted least-squares affine fit (scale x/y, rotation, shift; shear is fitted too and is ~0 on real scans), boxes
   more than 1.5 px off dropped and the fit repeated; one more local-search + fit pass from the fitted positions so
   rotations up to ~1 degree converge.

The result maps template (reference 805x569) coordinates to coordinates of the scan resized to 805x569. Every other
geometry (checkbox windows, handwriting boxes, body map, model crops) is placed through it (``Geometry``).
Template verdict (A3): S = mean ring contrast of the 39 boxes at their fitted positions, foundRatio = share of boxes with a
contrast >= 20 within +-1 px. ``known`` if S >= 28, foundRatio >= 0.75, rmsPx <= 1.0, scale 0.95-1.05 and
|rotation| <= 3 degrees; otherwise ``uncertain`` if S >= 20; ``unknown`` below 20.
"""

import math

import numpy as np

import ocr_layout as L

BOXES = [(group, box) for group, boxes in L.CHECKBOXES.items() for box in boxes]
CENTERS = np.array([(x + s / 2, y + s / 2) for _, (_, _, x, y, s) in BOXES], dtype=np.float64)
CX, CY = L.REF_W / 2, L.REF_H / 2
COARSE_SCALES = tuple(round(0.97 + k * 0.0025, 4) for k in range(21))
COARSE_SHIFT, LOCAL_SEARCH, INLIER_PX, MIN_INLIERS = 24, 3, 1.5, 12
FOUND_CONTRAST = 20.0
KNOWN_SCORE, UNCERTAIN_SCORE, KNOWN_FOUND, KNOWN_RMS, KNOWN_SCALE, KNOWN_ROTATION = 28.0, 20.0, 0.75, 1.0, (0.95, 1.05), 3.0
ROTATE_CROPS_ABOVE_DEG = 0.3  # model crops are cut from a de-rotated page above this fitted rotation


class Geometry:
    """Affine map template -> scan (reference px): q = A (p - C) + C + t, C = page centre."""

    def __init__(self, a=1.0, b=0.0, c=0.0, d=1.0, tx=0.0, ty=0.0):
        self.a, self.b, self.c, self.d, self.tx, self.ty = float(a), float(b), float(c), float(d), float(tx), float(ty)

    @classmethod
    def shift(cls, dx, dy):
        return cls(tx=dx, ty=dy)

    def point(self, x, y):
        px, py = x - CX, y - CY
        return self.a * px + self.b * py + CX + self.tx, self.c * px + self.d * py + CY + self.ty

    def offset(self, x, y):
        """Rounded displacement (dx, dy) of template point (x, y)."""
        qx, qy = self.point(x, y)
        return int(round(qx - x)), int(round(qy - y))

    def box(self, x, y, s):
        """Top-left of a template square box (size kept) placed at its fitted centre."""
        dx, dy = self.offset(x + s / 2, y + s / 2)
        return x + dx, y + dy

    def rect(self, box):
        """Integer rectangle of a template rectangle: its corners mapped (scale included), rotation ignored."""
        x0, y0 = self.point(box[0], box[1])
        x1, y1 = self.point(box[2], box[3])
        return int(round(x0)), int(round(y0)), int(round(x1)), int(round(y1))

    @property
    def rotation_deg(self):
        return math.degrees(math.atan2(self.c - self.b, self.a + self.d))

    @property
    def scale(self):
        return math.hypot(self.a, self.c), math.hypot(self.b, self.d)

    def inverse_coefficients(self, kx=1.0, ky=1.0, origin=(0.0, 0.0), out_scale=(1.0, 1.0)):
        """Pillow AFFINE data mapping an output pixel of a crop to the source image. The output pixel (u, v) is template
        point origin + (u / out_scale); the source image has kx, ky pixels per reference px."""
        ox, oy = origin
        sx, sy = out_scale
        # template p = (ox + u/sx, oy + v/sy); scan q = A (p - C) + C + t; image = (kx qx, ky qy)
        a, b, c, d = self.a, self.b, self.c, self.d
        const_x = a * (ox - CX) + b * (oy - CY) + CX + self.tx
        const_y = c * (ox - CX) + d * (oy - CY) + CY + self.ty
        return (kx * a / sx, kx * b / sy, kx * const_x, ky * c / sx, ky * d / sy, ky * const_y)


IDENTITY = Geometry()


def _search_windows():
    """Per box, the offset range any search can ask for: coarse scale displacement + shift, plus the local search and the
    +-1 'found' check around a fitted position -> [(u0, v0, n_u, n_v)] (offsets u0.., v0..)."""
    rel = CENTERS - (CX, CY)
    lo = np.minimum(*((s - 1.0) * rel for s in (COARSE_SCALES[0], COARSE_SCALES[-1])))
    hi = np.maximum(*((s - 1.0) * rel for s in (COARSE_SCALES[0], COARSE_SCALES[-1])))
    margin = COARSE_SHIFT + LOCAL_SEARCH + 2
    out = []
    for (lx, ly), (hx, hy) in zip(lo, hi, strict=True):
        u0, v0 = int(math.floor(lx)) - margin, int(math.floor(ly)) - margin
        out.append((u0, v0, int(math.ceil(hx)) + margin - u0 + 1, int(math.ceil(hy)) + margin - v0 + 1))
    return out


SEARCH_WINDOWS = _search_windows()
PAD = max(max(-u0, -v0, u0 + nu, v0 + nv) for u0, v0, nu, nv in SEARCH_WINDOWS) + 4


def _integral(dark):
    """Integral image (int32, exact) of the darkness image padded by PAD px of zeros; entry [y, x] = sum above-left."""
    h, w = dark.shape
    table = np.zeros((h + 2 * PAD + 1, w + 2 * PAD + 1), np.int32)
    table[PAD + 1:PAD + 1 + h, PAD + 1:PAD + 1 + w] = dark
    np.cumsum(table, 0, out=table)
    np.cumsum(table, 1, out=table)
    return table


def _box_sums(integral, box, nu, nv):
    """Sums of the box (x0+u, y0+v, x1+u, y1+v) for every offset u < nu, v < nv (padded integral coordinates)."""
    x0, y0, x1, y1 = box
    return (integral[y1:y1 + nv, x1:x1 + nu] - integral[y0:y0 + nv, x1:x1 + nu]
            - integral[y1:y1 + nv, x0:x0 + nu] + integral[y0:y0 + nv, x0:x0 + nu])


class _Surfaces:
    """Ring contrast of every template box over its search window of translations (see SEARCH_WINDOWS)."""

    def __init__(self, dark):
        integral = _integral(dark)
        self.grids = []
        for (_, (_, _, x, y, s)), (u0, v0, nu, nv) in zip(BOXES, SEARCH_WINDOWS, strict=True):
            bx, by = x + u0 + PAD, y + v0 + PAD
            outer = _box_sums(integral, (bx, by, bx + s, by + s), nu, nv)
            inner = _box_sums(integral, (bx + 2, by + 2, bx + s - 2, by + s - 2), nu, nv)
            around = _box_sums(integral, (bx - 2, by - 2, bx + s + 2, by + s + 2), nu, nv)
            ring, band = s * s - (s - 4) ** 2, (s + 4) ** 2 - s * s
            self.grids.append((outer * (1.0 / ring + 1.0 / band) - inner * (1.0 / ring) - around * (1.0 / band)).astype(np.float32))

    def at(self, offsets):
        """Contrast of each box at its integer offset (dx, dy); -50 outside its window."""
        out = np.empty(len(BOXES))
        for i, ((u0, v0, nu, nv), (dx, dy)) in enumerate(zip(SEARCH_WINDOWS, offsets, strict=True)):
            u, v = int(dx) - u0, int(dy) - v0
            out[i] = self.grids[i][v, u] if 0 <= u < nu and 0 <= v < nv else -50.0
        return out

    def local(self, predicted, radius):
        """Best integer offset of every box within +-radius of its predicted (float) offset -> (offsets, contrasts);
        ties go to the offset nearest the prediction."""
        base = np.rint(predicted).astype(int)
        offsets, contrasts = base.copy(), np.full(len(BOXES), -50.0)
        penalty = 1e-3 * (np.abs(np.arange(-radius, radius + 1))[None, :] + np.abs(np.arange(-radius, radius + 1))[:, None])
        for i, ((u0, v0, nu, nv), (bx, by)) in enumerate(zip(SEARCH_WINDOWS, base, strict=True)):
            u, v = bx - radius - u0, by - radius - v0
            if u < 0 or v < 0 or u + 2 * radius + 1 > nu or v + 2 * radius + 1 > nv:
                continue  # prediction outside the searched range (not this form)
            patch = self.grids[i][v:v + 2 * radius + 1, u:u + 2 * radius + 1] - penalty
            iy, ix = np.unravel_index(int(np.argmax(patch)), patch.shape)
            offsets[i], contrasts[i] = (bx + ix - radius, by + iy - radius), patch[iy, ix] + penalty[iy, ix]
        return offsets, contrasts


def _fit(src, dst, weight):
    rows = np.zeros((2 * len(src), 6))
    rows[0::2, 0:2], rows[0::2, 2] = src - (CX, CY), 1
    rows[1::2, 3:5], rows[1::2, 5] = src - (CX, CY), 1
    target = (dst - (CX, CY)).reshape(-1)
    w = np.repeat(np.sqrt(weight), 2)
    sol, *_ = np.linalg.lstsq(rows * w[:, None], target * w, rcond=None)
    residual = (rows @ sol - target).reshape(-1, 2)
    return sol, np.hypot(residual[:, 0], residual[:, 1])


def _geometry(sol):
    a, b, tx, c, d, ty = sol
    return Geometry(a, b, c, d, tx, ty)


def _predict(geo):
    return np.array([geo.point(x, y) for x, y in CENTERS]) - CENTERS


def register(dark):
    """Fit the template to a darkness image (reference size, see ocr_marks.border_darkness). Returns (Geometry, detection)."""
    surf = _Surfaces(np.asarray(dark))
    rel = CENTERS - (CX, CY)
    n = 2 * COARSE_SHIFT + 1
    best = None
    for scale in COARSE_SCALES:
        disp = np.rint((scale - 1.0) * rel).astype(int)
        acc = np.zeros((n, n), np.float32)
        for grid, (u0, v0, _, _), (ox, oy) in zip(surf.grids, SEARCH_WINDOWS, disp, strict=True):
            u, v = ox - COARSE_SHIFT - u0, oy - COARSE_SHIFT - v0
            acc += grid[v:v + n, u:u + n]
        iy, ix = np.unravel_index(int(np.argmax(acc)), acc.shape)
        score = float(acc[iy, ix]) - 1e-3 * abs(scale - 1.0)
        if best is None or score > best[0]:
            best = (score, scale, ix - COARSE_SHIFT, iy - COARSE_SHIFT)
    _, scale, tx, ty = best
    geo = Geometry(scale, 0.0, 0.0, scale, tx, ty)
    for _ in range(2):  # local search from the coarse model, then once more from the fitted one
        local, contrast = surf.local(_predict(geo), LOCAL_SEARCH)
        src, dst, weight = CENTERS, CENTERS + local, np.clip(contrast, 1.0, None)
        sol, residual = _fit(src, dst, weight)
        keep = residual <= INLIER_PX
        if keep.sum() >= MIN_INLIERS:
            sol, _ = _fit(src[keep], dst[keep], weight[keep])
        geo = _geometry(sol)
    fitted = _predict(geo)
    residual = np.hypot(*(fitted - local).T)
    offsets = np.rint(fitted).astype(int)
    score = float(surf.at(offsets).mean())
    near = surf.local(fitted, 1)[1]
    found = float((near >= FOUND_CONTRAST).mean())
    rms = float(np.sqrt(np.mean(residual ** 2)))
    scale_x, scale_y = geo.scale
    rotation = geo.rotation_deg
    known = (score >= KNOWN_SCORE and found >= KNOWN_FOUND and rms <= KNOWN_RMS and abs(rotation) <= KNOWN_ROTATION
             and all(KNOWN_SCALE[0] <= s <= KNOWN_SCALE[1] for s in (scale_x, scale_y)))
    verdict = "known" if known else "uncertain" if score >= UNCERTAIN_SCORE else "unknown"
    detection = {"verdict": verdict, "score": round(score, 1), "foundRatio": round(found, 3), "rmsPx": round(rms, 2),
                 "scaleX": round(scale_x, 4), "scaleY": round(scale_y, 4), "rotationDeg": round(rotation, 3) + 0.0,
                 "dx": round(geo.tx, 2) + 0.0, "dy": round(geo.ty, 2) + 0.0}
    return geo, detection
