"""Typhoon OCR calls through Ollama's OpenAI-compatible endpoint. Crops are sent as in-memory PNG bytes."""

import base64
import io
import json
import os
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


def model_name():
    return os.environ.get("OCR_MODEL", DEFAULT_MODEL)


def ollama_url():
    return os.environ.get("OLLAMA_URL", DEFAULT_OLLAMA_URL)


def model_timeout():
    try:
        return max(1.0, float(os.environ.get("OCR_MODEL_TIMEOUT", "600")))
    except ValueError:
        return 600.0


def png_bytes(image):
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", compress_level=1)
    return buffer.getvalue()


def call_ocr(image_png, prompt, max_tokens=220):
    """One chat-completions call with a single PNG image; returns the model's text."""
    payload = {
        "model": model_name(),
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": prompt},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64," + base64.b64encode(image_png).decode()}},
        ]}],
        "temperature": 0,
        "max_tokens": max_tokens,
    }
    request = urllib.request.Request(ollama_url(), data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                                     headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=model_timeout()) as response:
        result = json.loads(response.read().decode("utf-8"))
    content = result["choices"][0]["message"]["content"]
    return content if isinstance(content, str) else ""
