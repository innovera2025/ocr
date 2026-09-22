"""Fitted registration (scale, rotation, shift) and the template verdict (release1-plan A1, A3)."""

import math

import numpy as np
import pytest
from PIL import Image

import ocr_layout as L
import ocr_marks as M
import ocr_register as R
import synthetic_form as S


def register(image):
    return R.register(np.asarray(M.border_darkness(image, image.convert("L"))))


def test_geometry_maps_points_boxes_and_crops_consistently():
    geo = R.Geometry(0.99, -0.007, 0.007, 0.99, 1.5, -2.0)  # ~0.4 degrees, scale 0.99, shift (1.5, -2)
    assert geo.point(R.CX, R.CY) == (R.CX + 1.5, R.CY - 2.0)
    assert abs(geo.rotation_deg - math.degrees(math.atan2(0.007, 0.99))) < 1e-9
    assert all(abs(s - math.hypot(0.99, 0.007)) < 1e-9 for s in geo.scale)
    x, y = geo.point(100.0, 50.0)
    assert geo.offset(100.0, 50.0) == (round(x - 100), round(y - 50))
    assert geo.box(100, 50, 12) == (100 + round(geo.point(106, 56)[0] - 106), 50 + round(geo.point(106, 56)[1] - 56))
    a, b, c, d, e, f = geo.inverse_coefficients(2.0, 2.0, origin=(100, 50), out_scale=(2.0, 2.0))
    assert (a * 0 + b * 0 + c, d * 0 + e * 0 + f) == (2 * x, 2 * y)  # output pixel (0, 0) is template point (100, 50)
    assert R.Geometry.shift(3, -2).point(10, 10) == (13.0, 8.0) and R.IDENTITY.rect((1, 2, 3, 4)) == (1, 2, 3, 4)


def test_calibration_form_registers_as_identity():
    geo, detection = register(S.filled_form())
    assert detection == {"verdict": "known", "score": detection["score"], "foundRatio": 1.0, "rmsPx": 0.0, "scaleX": 1.0, "scaleY": 1.0,
                         "rotationDeg": 0.0, "dx": 0.0, "dy": 0.0}
    assert detection["score"] > 90 and geo.offset(500, 300) == (0, 0)


@pytest.mark.parametrize("scale", [0.97, 0.993, 1.02])
@pytest.mark.parametrize("rotation", [-1.0, -0.4, 0.0, 0.3, 1.0])
def test_scale_and_rotation_are_recovered(scale, rotation):
    _, detection = register(S.transformed(S.filled_form(), scale, rotation))
    assert detection["verdict"] == "known" and detection["rmsPx"] <= 0.6
    assert abs(detection["scaleX"] - scale) < 0.004 and abs(detection["scaleY"] - scale) < 0.004
    assert abs(detection["rotationDeg"] - rotation) < 0.1


def test_shift_is_recovered():
    shifted = Image.new("RGB", (L.REF_W, L.REF_H), (255, 255, 255))
    shifted.paste(S.filled_form(), (7, -5))
    geo, detection = register(shifted)
    assert detection["verdict"] == "known" and (round(detection["dx"]), round(detection["dy"])) == (7, -5)


@pytest.mark.parametrize("rotation", [1.5, -1.5, 2.0])
def test_skew_beyond_the_search_is_never_silently_known(rotation):
    """The coarse search models scale and shift only (plan A1); beyond ~1 degree the fit fails visibly (deskew: Release 3)."""
    _, detection = register(S.transformed(S.filled_form(), 1.0, rotation))
    assert detection["verdict"] != "known"


@pytest.mark.parametrize("fade, verdict", [(1.0, "known"), (0.23, "uncertain"), (0.12, "unknown")])
def test_template_verdict_follows_the_printed_grid_contrast(fade, verdict):
    image = Image.eval(S.blank_form(), lambda v: int(255 - (255 - v) * fade))
    assert register(image)[1]["verdict"] == verdict


@pytest.mark.parametrize("page", ["blank", "noise", "rot90", "mirror"])
def test_other_images_are_unknown(page):
    form = S.filled_form()
    image = {"blank": Image.new("RGB", (L.REF_W, L.REF_H), (252, 252, 250)),
             "noise": Image.fromarray(np.random.default_rng(1).integers(0, 255, (L.REF_H, L.REF_W, 3), dtype=np.uint8)),
             "rot90": form.transpose(Image.Transpose.ROTATE_90).resize((L.REF_W, L.REF_H)),
             "mirror": form.transpose(Image.Transpose.FLIP_LEFT_RIGHT)}[page]
    _, detection = register(image)
    assert detection["verdict"] != "known" and detection["score"] < 28
