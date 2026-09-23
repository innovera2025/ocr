"""The offline replay must reproduce what `api.process_image` produced from the same answers -- on synthetic pages.

`tools/replay.py` rebuilds the text fields of a stored response from the raw model answers it carries, so parser and
vocabulary changes can be scored on archived pages with no model call and no page image. If it ever drifts from the real
`api.py` path, every number the benchmark prints is measuring the replay instead of the product. These tests run a
synthetic form through the real service with a mocked model, then replay the response it returned, and demand an exact
match. No customer data: the form and the answers are generated.
"""

import pytest

import ocr_model
from conftest import FakeModel, png_of
from tools import replay
import synthetic_form as S

MODES = ["staff-separate", "combined"]


def response(client, monkeypatch, mode, **model):
    monkeypatch.setenv("OCR_SECTION_MODE", mode)
    monkeypatch.setattr(ocr_model, "call_ocr", FakeModel(**model))
    result = client.post("/v1/ocr", files={"file": ("form.png", png_of(S.filled_form()), "image/png")})
    assert result.status_code == 200, result.text
    return result.json()


@pytest.mark.parametrize("mode", MODES)
def test_replay_reproduces_the_service_answer(client, monkeypatch, mode):
    body = response(client, monkeypatch, mode, logprob=-0.05)
    assert body["evidence"]["tokenConfidence"], "the token gate must be exercised, not skipped"
    sections, notes = replay.replay_page(body)
    assert notes["mode"] == mode and not notes["staleGate"]
    assert replay.fidelity(body, sections) == []


@pytest.mark.parametrize("mode", MODES)
def test_replay_reproduces_a_page_the_token_gate_flagged(client, monkeypatch, mode):
    """A doubtful token must flag the same field in the replay as in the service."""
    body = response(client, monkeypatch, mode, logprob=-0.05, low={"3": -3.0})
    assert body["staffOnly"]["roomNo"]["needsReview"] is True
    sections, _ = replay.replay_page(body)
    assert replay.fidelity(body, sections) == []


@pytest.mark.parametrize("mode", MODES)
def test_replay_reproduces_an_answer_without_logprobs(client, monkeypatch, mode):
    """Older Ollama returns no logprobs: the rule confidences stand and the replay must not invent a gate."""
    body = response(client, monkeypatch, mode)
    assert body["evidence"]["tokenConfidence"] == {}
    sections, notes = replay.replay_page(body)
    assert set(notes["gate"].values()) <= {"no-stats", "not-read"}
    assert replay.fidelity(body, sections) == []


def test_replay_reproduces_a_page_with_empty_handwriting_boxes(client, monkeypatch):
    """No written customer field: the service makes no customer call at all, and the replay must take the same branch."""
    monkeypatch.setenv("OCR_SECTION_MODE", "staff-separate")
    monkeypatch.setattr(ocr_model, "call_ocr", FakeModel(logprob=-0.05))
    body = client.post("/v1/ocr", files={"file": ("form.png", png_of(S.blank_form()), "image/png")}).json()
    sections, _ = replay.replay_page(body)
    assert replay.fidelity(body, sections) == []


def test_replay_reports_a_stale_gate_when_the_raw_value_changes(client, monkeypatch):
    """The stored token statistics were measured over the field's exact raw string. If a variant changes it, the gate has
    no evidence any more and the caller has to know."""
    body = response(client, monkeypatch, "staff-separate", logprob=-0.05)
    body["staffOnly"]["roomNo"] = body["staffOnly"]["roomNo"] | {"raw": "changed"}
    _, notes = replay.replay_page(body)
    assert "staffOnly.roomNo" in notes["staleGate"]
