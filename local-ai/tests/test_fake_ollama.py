"""End to end through the real HTTP model client against tests/fake_ollama.py (no mocking of call_ocr)."""

import json
import urllib.error
import urllib.request

import pytest

import fake_ollama
import ocr_model
import synthetic_form as S
from conftest import png_of


@pytest.fixture
def fake_server(monkeypatch):
    server, base, log = fake_ollama.start(latency_ms=150)
    monkeypatch.setenv("OLLAMA_URL", f"{base}/v1/chat/completions")
    yield base, log
    server.shutdown()


def test_real_client_against_fake_ollama(fake_server):
    base, log = fake_server
    text = ocr_model.call_ocr(png_of(S.blank_form().crop((410, 485, 710, 569))), ocr_model.STAFF_PROMPT, 220)
    assert text == fake_ollama.STAFF_TEXT
    assert log[0]["model"] == "scb10x/typhoon-ocr1.5-3b" and log[0]["max_tokens"] == 220


def test_fake_ollama_rejects_requests_without_png(fake_server):
    base, _ = fake_server
    payload = {"model": "m", "messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}]}
    request = urllib.request.Request(f"{base}/v1/chat/completions", data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
    with pytest.raises(urllib.error.HTTPError) as error:
        urllib.request.urlopen(request, timeout=5)
    assert error.value.code == 400


def test_whole_service_against_fake_ollama(client, fake_server, monkeypatch):
    _, log = fake_server
    monkeypatch.setenv("OCR_SECTION_MODE", "separate")
    response = client.post("/v1/ocr", files={"file": ("form.png", png_of(S.filled_form()), "image/png")})
    assert response.status_code == 200, response.text
    body = response.json()
    assert [t["value"] for t in body["staffOnly"]["treatments"]] == ["นวดไทย", "นวดหน้า"]
    assert body["customerInformation"]["nationality"]["value"] == "Chinese"
    assert len(log) == 2 and {("STAFF ONLY" in c["prompt"]) for c in log} == {True, False}
    assert body["timings"]["inferenceWallMs"] < body["timings"]["inferenceMs"]  # 2 x 150 ms calls overlapped
