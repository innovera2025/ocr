import io
import sys
from pathlib import Path

import pytest

LOCAL_AI = Path(__file__).resolve().parents[1]
TESTS = Path(__file__).resolve().parent
for path in (str(LOCAL_AI), str(TESTS)):
    if path not in sys.path:
        sys.path.insert(0, path)

SAMPLE = TESTS / "fixtures" / "sample2.png"

STAFF_TEXT = "Treatment : ไทย 90 นาที + หน้า 1 ชม.\nTherapist Name : พีพี\nRoom No. : 3"
CUSTOMER_TEXT = "Name 姓名 : Chun\nNationality 国籍 : Chinese\nHotel Name 酒店 :"


@pytest.fixture(autouse=True)
def isolated_paths(tmp_path, monkeypatch):
    """Uploads and verified memory go to a temp dir, never /app."""
    monkeypatch.setenv("OCR_UPLOAD_DIR", str(tmp_path / "uploads"))
    monkeypatch.setenv("OCR_VERIFIED_FILE", str(tmp_path / "verified_dataset" / "corrections.jsonl"))
    monkeypatch.delenv("OCR_MASTER_DATA", raising=False)
    monkeypatch.delenv("OCR_SECTION_PARALLELISM", raising=False)
    return tmp_path


@pytest.fixture
def sample_image():
    if not SAMPLE.exists():
        pytest.skip("gitignored fixture tests/fixtures/sample2.png is not present")
    from PIL import Image
    return Image.open(SAMPLE).convert("RGB")


@pytest.fixture
def sample_png():
    if not SAMPLE.exists():
        pytest.skip("gitignored fixture tests/fixtures/sample2.png is not present")
    return SAMPLE.read_bytes()


class FakeModel:
    """Replaces ocr_model.call_ocr: answers by prompt keyword, records calls."""

    def __init__(self, staff=STAFF_TEXT, customer=CUSTOMER_TEXT, delay=0.0, fail=False):
        self.staff, self.customer, self.delay, self.fail, self.calls = staff, customer, delay, fail, []

    def __call__(self, png, prompt, max_tokens=220):
        import time
        assert png.startswith(b"\x89PNG"), "crops must be sent as PNG bytes"
        self.calls.append({"prompt": prompt, "max_tokens": max_tokens, "png": png})
        if self.delay:
            time.sleep(self.delay)
        if self.fail:
            raise ConnectionError("model unavailable")
        return self.staff if "STAFF ONLY" in prompt else self.customer


@pytest.fixture
def fake_model(monkeypatch):
    import ocr_model
    model = FakeModel()
    monkeypatch.setattr(ocr_model, "call_ocr", model)
    return model


@pytest.fixture
def client():
    from fastapi.testclient import TestClient
    import api
    return TestClient(api.app)


def png_of(image, fmt="PNG", **params):
    buffer = io.BytesIO()
    image.save(buffer, format=fmt, **params)
    return buffer.getvalue()
