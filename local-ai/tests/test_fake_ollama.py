"""End to end through the real HTTP model client against tests/fake_ollama.py (no mocking of call_ocr)."""

import http.client
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


# ---------------------------------------------------------------- v3.2: logprobs, retry of an Ollama 500, degraded section

@pytest.fixture
def ollama(monkeypatch):
    """Starts a fake Ollama with options: ollama(fail={"staff": 1}, low={"พีพี": -2.0}) -> request log."""
    servers = []

    def run(**options):
        server, base, log = fake_ollama.start(**options)
        servers.append(server)
        monkeypatch.setenv("OLLAMA_URL", f"{base}/v1/chat/completions")
        return log
    yield run
    for server in servers:
        server.shutdown()


def test_real_client_returns_text_with_token_logprobs(ollama):
    log = ollama()
    png = png_of(S.blank_form().crop((410, 485, 710, 569)))
    answer = ocr_model.call_ocr(png, ocr_model.STAFF_VOCAB_PROMPT, 220)
    assert isinstance(answer, str) and answer == fake_ollama.STAFF_TEXT
    assert b"".join(data for data, _ in answer.tokens) == answer.encode("utf-8") and {lp for _, lp in answer.tokens} == {-0.01}
    assert log[0]["logprobs"] is True and log[0]["top_logprobs"] == 1
    text = ocr_model.call_ocr_text(png, ocr_model.STAFF_PROMPT, 220)  # the text-only call
    assert type(text) is str and text == fake_ollama.STAFF_TEXT


def test_logprobs_can_be_switched_off(ollama, monkeypatch):
    log = ollama()
    monkeypatch.setenv("OCR_MODEL_LOGPROBS", "0")
    answer = ocr_model.call_ocr(png_of(S.blank_form().crop((410, 485, 710, 569))), ocr_model.STAFF_PROMPT, 220)
    assert answer == fake_ollama.STAFF_TEXT and answer.tokens is None and log[0]["logprobs"] is None


def test_whole_service_retries_an_ollama_500_and_caps_confidence_by_token_logprobs(client, ollama):
    log = ollama(fail={"staff": 1}, low={"พีพี": -2.0})
    response = client.post("/v1/ocr", files={"file": ("form.png", png_of(S.filled_form()), "image/png")})
    assert response.status_code == 200, response.text
    body = response.json()
    assert sorted(fake_ollama.prompt_kind(entry["prompt"]) for entry in log) == ["headerCustomer", "staff", "staff"]
    assert {s["name"]: s.get("attempts", 1) for s in body["timings"]["sections"]} == {"staffOnly": 2, "headerCustomer": 1}
    therapist = body["staffOnly"]["therapistName"]
    assert therapist["value"] == "พีพี" and therapist["confidence"] == 0.135 and therapist["needsReview"] is True
    assert body["evidence"]["tokenConfidence"]["staffOnly.therapistName"]["mean"] == 0.135
    assert body["customerInformation"]["name"]["value"] == "Chun" and not body["customerInformation"]["name"]["needsReview"]
    assert [t["value"] for t in body["staffOnly"]["treatments"]] == ["นวดไทย", "นวดหน้า"]


def test_whole_service_degrades_one_section_when_ollama_keeps_failing_it(client, ollama):
    ollama(fail={"headerCustomer": 2})
    response = client.post("/v1/ocr", files={"file": ("form.png", png_of(S.filled_form()), "image/png")})
    assert response.status_code == 200, response.text
    body = response.json()
    assert any("model call headerCustomer failed after 2 attempt(s) (HTTPError: HTTP Error 500" in w for w in body["layout"]["warnings"])
    assert body["customerInformation"]["name"]["needsReview"] and body["staffOnly"]["therapistName"]["value"] == "พีพี"


@pytest.mark.parametrize("error, transient", [
    (urllib.error.HTTPError("u", 500, "x", None, None), True), (urllib.error.HTTPError("u", 503, "x", None, None), True),
    (urllib.error.HTTPError("u", 400, "x", None, None), False), (urllib.error.HTTPError("u", 404, "x", None, None), False),
    (TimeoutError("timed out"), True), (urllib.error.URLError(TimeoutError("timed out")), True),
    (urllib.error.URLError(ConnectionRefusedError()), True), (urllib.error.URLError("unknown url type"), False),
    (ConnectionResetError(), True), (http.client.RemoteDisconnected("closed"), True),
    (ValueError("bad json"), False), (KeyError("choices"), False)])
def test_transient_model_errors(error, transient):
    assert ocr_model.is_transient(error) is transient


def test_token_logprobs_are_parsed_from_the_answer():
    choice = {"logprobs": {"content": [{"token": "ไ", "logprob": -0.1, "bytes": [224, 185, 132]}, {"token": "ท", "logprob": -0.2}]}}
    assert ocr_model._tokens(choice) == ((b"\xe0\xb9\x84", -0.1), ("ท".encode(), -0.2))
    assert ocr_model._tokens({}) is None and ocr_model._tokens({"logprobs": None}) is None
    assert ocr_model._tokens({"logprobs": {"content": [{"token": "x", "logprob": None}]}}) is None  # unusable: rules decide


def test_whole_service_maps_token_logprobs_whose_split_thai_characters_lost_their_bytes(client, ollama):
    """Ollama's OpenAI endpoint in front of llama-server: a Thai character split over two tokens comes back as "" + U+FFFD
    (bytes taken from that text). The staff answer used to be unmappable as a whole, so no staff field got a confidence."""
    ollama(low={"พีพี": -2.0}, token_text=True)
    body = client.post("/v1/ocr", files={"file": ("form.png", png_of(S.filled_form()), "image/png")}).json()
    confidence = body["evidence"]["tokenConfidence"]
    assert confidence["staffOnly.therapistName"]["mean"] == 0.135 and body["staffOnly"]["therapistName"]["needsReview"] is True
    assert all(confidence[f"staffOnly.treatments.{i}"] is not None for i in range(2)) and confidence["staffOnly.roomNo"]["min"] == 0.99
    assert confidence["customerInformation.name"]["mean"] == 0.99 and not body["customerInformation"]["name"]["needsReview"]
