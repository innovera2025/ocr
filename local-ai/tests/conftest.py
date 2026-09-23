import io
import os
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
HEADER_TEXT = "No. 01234\nDate 日期 : 16/08/26\nTime 时间 : 14:30"


@pytest.fixture(autouse=True)
def isolated_paths(tmp_path, monkeypatch):
    """Uploads and verified memory go to a temp dir, never /app. No retry pause, no model-confidence env overrides."""
    import ocr_model
    monkeypatch.setattr(ocr_model, "RETRY_DELAY_S", 0.0)
    for name in [n for n in os.environ if n.startswith("OCR_MODEL_CONFIDENCE_")] + ["OCR_MODEL_LOGPROBS", "OCR_CALIBRATION_FILE"]:
        monkeypatch.delenv(name, raising=False)  # the repo's own calibration.json stays in force: it is what production runs
    monkeypatch.setenv("OCR_UPLOAD_DIR", str(tmp_path / "uploads"))
    monkeypatch.setenv("OCR_VERIFIED_FILE", str(tmp_path / "verified_dataset" / "corrections.jsonl"))
    monkeypatch.delenv("OCR_MASTER_DATA", raising=False)
    monkeypatch.delenv("OCR_SECTION_PARALLELISM", raising=False)
    monkeypatch.delenv("OCR_SECTION_MODE", raising=False)
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
    """Replaces ocr_model.call_ocr: answers by prompt kind (fake_ollama.prompt_kind), records calls.

    `logprob`: answer with ModelText carrying fake byte-level token logprobs (default None: a plain str, no logprobs);
    `low`: {substring: logprob} for the tokens inside those substrings. `errors`: {kind: [exception, ...]} raised, in order,
    by the next calls of that kind ("staff", "headerCustomer", "customer", "combined"); `fail` raises on every call."""

    def __init__(self, staff=STAFF_TEXT, customer=CUSTOMER_TEXT, delay=0.0, fail=False, header=HEADER_TEXT, logprob=None, low=None,
                 errors=None):
        self.staff, self.customer, self.delay, self.fail, self.header, self.calls = staff, customer, delay, fail, header, []
        self.logprob, self.low, self.errors = logprob, low, {k: list(v) for k, v in (errors or {}).items()}

    def answer(self, kind):
        header_customer = "\n".join(part for part in (self.header, self.customer) if part)
        return {"combined": header_customer + "\n\n" + self.staff, "staff": self.staff, "headerCustomer": header_customer}.get(kind, self.customer)

    def __call__(self, png, prompt, max_tokens=220):
        import time

        import fake_ollama
        import ocr_model
        assert png.startswith(b"\x89PNG"), "crops must be sent as PNG bytes"
        kind = fake_ollama.prompt_kind(prompt)
        self.calls.append({"prompt": prompt, "max_tokens": max_tokens, "png": png, "kind": kind})
        if self.delay:
            time.sleep(self.delay)
        if self.fail:
            raise ConnectionError("model unavailable")
        if self.errors.get(kind):
            raise self.errors[kind].pop(0)
        text = self.answer(kind)
        if self.logprob is None:
            return text
        tokens = [(bytes(t["bytes"]), t["logprob"]) for t in fake_ollama.fake_tokens(text, self.logprob, self.low)]
        return ocr_model.ModelText(text, tokens)

    def kinds(self):
        return [c["kind"] for c in self.calls]

    def call(self, kind):
        return next(c for c in self.calls if c["kind"] == kind)


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
