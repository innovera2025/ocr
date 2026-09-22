"""Typhoon OCR calls through Ollama's OpenAI-compatible endpoint. Crops are sent as in-memory PNG bytes; answers come back
as `ModelText` (the text, plus the generated tokens' log-probabilities when the server returns them)."""

import base64
import http.client
import io
import json
import math
import os
import urllib.error
import urllib.request

DEFAULT_MODEL = "scb10x/typhoon-ocr1.5-3b"
DEFAULT_OLLAMA_URL = "http://host.docker.internal:11434/v1/chat/completions"

# v2.2 prompt, unchanged (proven on production scans).
STAFF_PROMPT = """
Extract all text from this STAFF ONLY section.

Focus on:
- Treatment
- Therapist Name
- Room No.

Read handwriting directly.
Do not normalize.
Do not guess.
Preserve Thai and durations.
Return clean OCR text only.
"""
STAFF_MAX_TOKENS = 220

CUSTOMER_PROMPT = """
Transcribe the handwriting in this CUSTOMER INFORMATION section.

Return exactly three lines:
Name: <handwritten name>
Nationality: <handwritten nationality>
Hotel Name: <handwritten hotel name>

Read handwriting directly.
Do not translate.
Do not guess.
Ignore the printed Chinese labels.
If a box is empty, leave the value after the colon empty.
Return clean OCR text only.
"""
CUSTOMER_MAX_TOKENS = 120

# One model call for every section (the form header and the customer rows stacked above the unchanged STAFF crop). On
# the CPU-only Local AI host every image costs the same ~25 s (Ollama resizes each image to ~1,070 tokens whatever its
# size) and requests run one at a time, so two calls took ~50 s per new document; one combined call keeps v2.2's ~25 s
# (measured 2026-09-22 on sample/sample2 variants that defeat the prompt cache). Listing every label keeps them in the
# answer (6/6 parsed, 12/12 fields right on fresh variants); a looser wording sometimes returned bare values without
# labels. v3.1 adds the header (printed "No." form number, handwritten DATE and TIME) as three more label lines. api.py
# re-reads the STAFF crop with STAFF_PROMPT when the combined answer has no staff label at all.
COMBINED_PROMPT = """
Extract all text from this image of a spa intake form, top to bottom.
Top part: form header. Middle part: CUSTOMER INFORMATION. Bottom part: STAFF ONLY section.

Copy each printed label exactly, then the handwriting after it, one field per line:
No.:
Date:
Time:
Name:
Nationality:
Hotel Name:
Treatment:
Therapist Name:
Room No.:

Read handwriting directly.
Do not normalize.
Do not translate.
Do not guess.
Preserve Thai and durations.
Leave the value empty when a box is empty.
Return clean OCR text only.
"""
COMBINED_MAX_TOKENS = 380

# v3.2 default (OCR_SECTION_MODE=staff-separate): two calls, run concurrently. In the v3.1 combined call the model read the
# cursive Thai STAFF handwriting as English/Chinese ("ออย 1 ชม." -> "OOW I 6M"; treatments right on 25 % of 95 real pages).
# A probe on 16 hard real pages (2026-09-22) put the STAFF crop ALONE with this Thai vocabulary hint first: Thai script
# 13/16, room 14/16, treatment names 5/16 after text cleanup; the combined variants were worse (room 9-10/16).
# The sentence is the probe's (probe_staff.py "staffvocab"), word for word.
STAFF_VOCAB = ("The Treatment line is handwritten in Thai, usually abbreviated service names such as ไทย, ออย, ออยร้อน, เท้า, หน้า, "
               "คอ บ่า ไหล่, ประคบ, สครับ, หินร้อน, อโรมา, ยาหม่อง, joined with + and durations such as 30, 60, 90, 1 ชม., 1.30 ชม., 2 ชม., "
               "90 นาที; sometimes '= total' at the end or a number of guests first. The Therapist Name is a short Thai nickname.")
STAFF_VOCAB_PROMPT = STAFF_PROMPT.replace("Read handwriting directly.", STAFF_VOCAB + "\nWrite Thai words in Thai script.\nRead handwriting directly.")

# The other call: the form header stacked above the customer rows (the rows only when a customer box is written), with
# COMBINED_PROMPT restricted to the header and customer label lines.
HEADER_CUSTOMER_PROMPT = """
Extract all text from this image of a spa intake form, top to bottom.
Top part: form header. Bottom part: CUSTOMER INFORMATION.

Copy each printed label exactly, then the handwriting after it, one field per line:
No.:
Date:
Time:
Name:
Nationality:
Hotel Name:

Read handwriting directly.
Do not normalize.
Do not translate.
Do not guess.
Preserve Thai and durations.
Leave the value empty when a box is empty.
Return clean OCR text only.
"""
HEADER_CUSTOMER_MAX_TOKENS = 260
RETRY_DELAY_S = 1.0  # pause before the one retry of a call that hit a transient Ollama error (api._timed_call)


def model_name():
    return os.environ.get("OCR_MODEL", DEFAULT_MODEL)


def ollama_url():
    return os.environ.get("OLLAMA_URL", DEFAULT_OLLAMA_URL)


def model_timeout():
    try:
        return max(1.0, float(os.environ.get("OCR_MODEL_TIMEOUT", "600")))
    except ValueError:
        return 600.0


def logprobs_enabled():
    """OCR_MODEL_LOGPROBS=0 stops asking for token log-probabilities (field confidence then falls back to the rules)."""
    return os.environ.get("OCR_MODEL_LOGPROBS", "1").strip().lower() not in ("0", "false", "no", "off")


class ModelText(str):
    """A model answer. It is the answer text itself (a plain str to text-only callers), plus `tokens`: the generated tokens
    as ((utf-8 bytes, logprob), ...) when the server returned logprobs, else None (older Ollama, a fake model)."""

    def __new__(cls, text, tokens=None):
        obj = super().__new__(cls, text)
        obj.tokens = tuple(tokens) if tokens else None
        return obj


def _tokens(choice):
    """choices[0].logprobs.content of an OpenAI-style answer -> ((bytes, logprob), ...) or None. A token's bytes come from its
    "bytes" list when present (a Thai character can be split over two tokens), else from its text."""
    logprobs = choice.get("logprobs") if isinstance(choice, dict) else None
    content = logprobs.get("content") if isinstance(logprobs, dict) else None
    if not isinstance(content, list) or not content:
        return None
    out = []
    for token in content:
        logprob = token.get("logprob") if isinstance(token, dict) else None
        # Python's json reads NaN / Infinity: such a value would make the field NaN and the response unserialisable
        if not isinstance(logprob, (int, float)) or isinstance(logprob, bool) or not math.isfinite(logprob):
            return None
        raw = token.get("bytes")
        if isinstance(raw, list) and all(isinstance(b, int) and 0 <= b < 256 for b in raw):
            data = bytes(raw)
        else:
            data = str(token.get("token", "")).encode("utf-8")
        out.append((data, min(0.0, float(logprob))))  # a probability is never above 1
    return tuple(out)


def is_transient(error):
    """An Ollama-side failure worth one retry: HTTP 5xx (e.g. a 500 mid-generation), a timeout or a dropped/refused
    connection. Anything else (a 4xx, a malformed answer) is not retried."""
    if isinstance(error, urllib.error.HTTPError):
        return error.code >= 500
    if isinstance(error, urllib.error.URLError):
        return isinstance(error.reason, (TimeoutError, ConnectionError))
    return isinstance(error, (TimeoutError, ConnectionError, http.client.RemoteDisconnected, http.client.IncompleteRead))


def is_timeout(error):
    """The call waited its whole OCR_MODEL_TIMEOUT: not retried (api._timed_call), since the default 600 s is already twice
    the worker's 300 s request timeout and Ollama runs one request at a time."""
    if isinstance(error, urllib.error.URLError) and not isinstance(error, urllib.error.HTTPError):
        return isinstance(error.reason, TimeoutError)
    return isinstance(error, TimeoutError)


def png_bytes(image):
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", compress_level=1)
    return buffer.getvalue()


def call_ocr(image_png, prompt, max_tokens=220):
    """One chat-completions call with a single PNG image -> ModelText (the answer text, with `.tokens` = token logprobs
    when the server returns them; requested with top_logprobs 1 unless OCR_MODEL_LOGPROBS=0)."""
    payload = {
        "model": model_name(),
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": prompt},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64," + base64.b64encode(image_png).decode()}},
        ]}],
        "temperature": 0,
        "max_tokens": max_tokens,
    }
    if logprobs_enabled():
        payload.update(logprobs=True, top_logprobs=1)
    request = urllib.request.Request(ollama_url(), data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                                     headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=model_timeout()) as response:
        result = json.loads(response.read().decode("utf-8"))
    choice = result["choices"][0]
    content = choice["message"]["content"]
    text = content if isinstance(content, str) else ""
    return ModelText(text, _tokens(choice) if text else None)


def call_ocr_text(image_png, prompt, max_tokens=220):
    """Backward-compatible call: the model's answer as a plain str (no logprobs)."""
    return str(call_ocr(image_png, prompt, max_tokens))
