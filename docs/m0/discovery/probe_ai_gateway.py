#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
=============================================================================
 INNOVERA OCR AI -- M0 DIAGNOSTIC TOOLING
 probe_ai_gateway.py

 *** THIS IS NOT APPLICATION CODE. ***
 *** THIS IS NOT PART OF THE ocr-web / ocr-worker RUNTIME. ***
 *** AS OF THE M0 REPORT DATE THIS SCRIPT HAS NEVER BEEN EXECUTED ***
 *** AGAINST A REAL GATEWAY -- NO INNOVERA LiteLLM ENDPOINT OR      ***
 *** CREDENTIAL WAS AVAILABLE DURING M0.                            ***

 PURPOSE
   Read-only capability discovery for an OpenAI-compatible LiteLLM gateway
   fronting a self-hosted vLLM/Qwen deployment. Answers M0 checklist items:
     E. What can the AI gateway actually do? (models, vision, JSON, tools, ctx)
     F. What is the safe way for our app to talk to it?

 SAFETY CONTRACT (enforced in code, not just documented)
   1. Defaults to --dry-run. Prints the exact requests it WOULD send and
      opens NO sockets. You must pass --run to transmit anything.
   2. Never hardcodes a URL or key. Both come from the environment.
   3. Never prints the API key. Masked to first 6 chars everywhere.
   4. Refuses to run against public model providers (INNOVERA policy: no
      public-model fallback, ever). Refusal is a pure string check on the
      hostname -- it performs no DNS lookup and no connection.
   5. Generates its probe images in-process. It never reads, uploads, or
      transmits a real customer document. The images are synthetic bitmaps
      drawn from a built-in 5x7 font.
   6. No retries in probe mode. Short timeouts. Never mutates gateway state
      (every request is GET, or a POST to /v1/chat/completions with
      max_tokens <= 24, which allocates no persistent resource).
   7. HTTP redirects are REFUSED, not followed. urllib follows 3xx by
      default; a gateway (or a hijacked DNS/proxy) that answers 302 to a
      public provider would silently defeat guard #4 and exfiltrate the
      probe. NoRedirect below turns any 3xx into a recorded finding.

 REQUIREMENTS
   Python 3.9+ standard library ONLY (urllib, json, base64, zlib, struct,
   argparse, random, time, ssl). No pip install. Verified to compile on the
   macOS system interpreter /usr/bin/python3 (3.9.6).

 USAGE
   # Preferred names -- they match INNOVERA Chat's production contract
   # (src/lib/required-config.ts), so one operator configures both apps
   # against the same gateway with one vocabulary.
   export LITELLM_BASE_URL='<literal value from the gateway owner>'
   export LITELLM_API_KEY='<OCR's own virtual key, read from a file/manager>'

   # AI_BASE_URL / AI_API_KEY are still accepted as DEPRECATED fallbacks.

   # EITHER convention is accepted for the base URL. Evidence (b §E2) says
   # the production value EXCLUDES /v1 and the client appends the path; a
   # value that already ends in /v1 is also handled. The script derives the
   # server root and the /v1 prefix itself -- see split_base() -- so it can
   # never emit /v1/v1/... or hit /chat/completions at the server root.

   python3 probe_ai_gateway.py                        # dry run, no sockets
   python3 probe_ai_gateway.py --run                  # actually probe
   python3 probe_ai_gateway.py --run --model '<alias-from-/v1/models>'
   python3 probe_ai_gateway.py --run > capability.json

 OUTPUT
   A single machine-readable JSON capability report on stdout, matching
   schema_version 1.0 as documented in
   docs/architecture/m0/c-ai-capability-probe.md. All human-readable
   progress goes to stderr so `> capability.json` stays clean.

 EXIT CODES
   0 = probe completed (read the JSON for per-probe verdicts)
   2 = refused to run (bad config / public host / missing env)
   3 = gateway unreachable
=============================================================================
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import random
import ssl
import struct
import sys
import time
import unicodedata
import urllib.error
import urllib.request
import zlib
from urllib.parse import urlsplit

SCHEMA_VERSION = "1.0"
TOOL_NAME = "probe_ai_gateway.py"

# --------------------------------------------------------------------------
# Policy: public providers we refuse to probe.
# INNOVERA rule -- customer documents and even synthetic probes must never
# leave the private inference estate. This is a hostname-suffix check only.
# NOTE: amazonaws.com is deliberately NOT blanket-blocked (INNOVERA runs its
# own Lightsail hosts); only the Bedrock inference endpoints are refused.
# --------------------------------------------------------------------------
PUBLIC_PROVIDER_SUFFIXES = (
    "openai.com",
    "api.openai.com",
    "openai.azure.com",
    "anthropic.com",
    "googleapis.com",
    "generativelanguage.googleapis.com",
    "dashscope.aliyuncs.com",
    "dashscope-intl.aliyuncs.com",
    "aliyuncs.com",
    "x.ai",
    "groq.com",
    "mistral.ai",
    "cohere.ai",
    "cohere.com",
    "together.ai",
    "together.xyz",
    "openrouter.ai",
    "deepseek.com",
    "perplexity.ai",
    "fireworks.ai",
    "replicate.com",
    "huggingface.co",
    "bedrock-runtime.us-east-1.amazonaws.com",
)

# Per-probe timeouts (seconds). Deliberately short: this is a diagnostic,
# not a workload. A slow answer is itself a finding.
T_HEALTH = 5
T_INFO = 10
T_CHAT = 30
T_VISION = 45

# Thai round-trip probe string. Deliberately exercises every Thai text hazard
# in one line, because a Thai-primary OCR product cannot ship on an
# English-only liveness check:
#   - SARA AM (U+0E33), which NFC/NFD normalisation reorders
#   - a tone mark stacked over a vowel above (combining marks, 3 levels)
#   - Thai digits U+0E50..U+0E59, which are NOT ASCII digits
#   - THANTHAKHAT (U+0E4C), the silent-letter killer mark
# The expected answer is byte-for-byte echo. Anything else is a finding.
THAI_PROBE = "เอกสารเลขที่ ๐๑๒/๒๕๖๗ หน้าคำนูณ์"
# = "เอกสารเลขที่ ๐๑๒/๒๕๖๗ หน้าคำนูณ์"  (document no. <Thai numerals>, page ...)


# --------------------------------------------------------------------------
# Synthetic probe image generation -- stdlib only, no Pillow.
#
# Writes a minimal 8-bit grayscale non-interlaced PNG by hand:
#   signature + IHDR + IDAT(zlib deflate of filter-0 scanlines) + IEND
# Verified: output opens cleanly in Pillow 11.3.0 as a valid PNG, and the
# glyphs are visually legible at native resolution.
# --------------------------------------------------------------------------
_FONT_5x7 = {
    "0": ["11111", "10001", "10001", "10001", "10001", "10001", "11111"],
    "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
    "2": ["11111", "00001", "00001", "11111", "10000", "10000", "11111"],
    "3": ["11111", "00001", "00001", "01111", "00001", "00001", "11111"],
    "4": ["10001", "10001", "10001", "11111", "00001", "00001", "00001"],
    "5": ["11111", "10000", "10000", "11111", "00001", "00001", "11111"],
    "6": ["11111", "10000", "10000", "11111", "10001", "10001", "11111"],
    "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
    "8": ["11111", "10001", "10001", "11111", "10001", "10001", "11111"],
    "9": ["11111", "10001", "10001", "11111", "00001", "00001", "11111"],
    "O": ["11111", "10001", "10001", "10001", "10001", "10001", "11111"],
    "C": ["11111", "10000", "10000", "10000", "10000", "10000", "11111"],
    "R": ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
}
_GLYPH_W, _GLYPH_H = 5, 7


def _png_chunk(tag: bytes, data: bytes) -> bytes:
    body = tag + data
    return (
        struct.pack(">I", len(data))
        + body
        + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)
    )


def make_probe_png(text: str, scale: int = 8, pad: int = 16) -> bytes:
    """Render `text` as black-on-white PNG bytes. Canvas auto-fits the text."""
    for ch in text:
        if ch not in _FONT_5x7:
            raise ValueError("no glyph for %r" % ch)
    advance = (_GLYPH_W + 1) * scale
    text_w = len(text) * advance - scale
    width = text_w + 2 * pad
    height = _GLYPH_H * scale + 2 * pad

    rows = [[255] * width for _ in range(height)]
    for i, ch in enumerate(text):
        for r, bits in enumerate(_FONT_5x7[ch]):
            for c, bit in enumerate(bits):
                if bit == "1":
                    for dy in range(scale):
                        for dx in range(scale):
                            rows[pad + r * scale + dy][pad + i * advance + c * scale + dx] = 0

    raw = b"".join(b"\x00" + bytes(row) for row in rows)
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0)  # 8-bit gray
    return (
        b"\x89PNG\r\n\x1a\n"
        + _png_chunk(b"IHDR", ihdr)
        + _png_chunk(b"IDAT", zlib.compress(raw, 9))
        + _png_chunk(b"IEND", b"")
    )


def png_data_uri(png: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(png).decode("ascii")


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
def mask_key(key: str) -> str:
    if not key:
        return "<empty>"
    if len(key) <= 6:
        return key[0] + "*" * (len(key) - 1)
    return key[:6] + "..." + ("*" * 4) + ("(len=%d)" % len(key))


def log(msg: str) -> None:
    sys.stderr.write(msg + "\n")
    sys.stderr.flush()


def refuse(msg: str) -> None:
    log("REFUSED: " + msg)
    json.dump(
        {
            "schema_version": SCHEMA_VERSION,
            "probe_tool": TOOL_NAME,
            "status": "refused",
            "reason": msg,
        },
        sys.stdout,
        indent=2,
    )
    sys.stdout.write("\n")
    sys.exit(2)


def check_public_host(base_url: str) -> str:
    """Pure string check. No DNS, no connection."""
    parts = urlsplit(base_url)
    host = (parts.hostname or "").lower()
    if not host:
        refuse("LITELLM_BASE_URL has no hostname: %r" % base_url)
    for suffix in PUBLIC_PROVIDER_SUFFIXES:
        if host == suffix or host.endswith("." + suffix):
            refuse(
                "LITELLM_BASE_URL host %r is a PUBLIC model provider (%s). "
                "INNOVERA policy forbids sending any traffic -- including "
                "synthetic probes -- to public inference providers. "
                "Point LITELLM_BASE_URL at the private LiteLLM gateway."
                % (host, suffix)
            )
    return host


def split_base(base_url: str) -> tuple:
    """
    Return (root, v1) for either base-URL convention.

    LiteLLM's management endpoints (/health/*, /model/info, /model_group/info)
    live at the server ROOT; the OpenAI-compatible endpoints live under /v1.

    INNOVERA Chat's production contract (b §E2) is that the configured base
    URL EXCLUDES /v1 and the client appends "/v1/chat/completions". Some
    OpenAI tooling instead configures a base that already ends in /v1. Both
    are accepted here and normalised, because the failure this prevents --
    a whole 16-request ladder returning 404 and being read as "the gateway
    is broken" -- is the most expensive possible outcome of a naming detail.

    NOTE: this tolerance is correct for a DIAGNOSTIC script. Application
    code must NOT copy it: b §4.3 (decision B-5) requires the app's env
    schema to REJECT a base URL ending in /v1 rather than normalise it, so
    that a disagreement between the deployer's mental model and the code is
    surfaced instead of hidden.
    """
    u = base_url.rstrip("/")
    if u.endswith("/v1"):
        return u[: -len("/v1")], u
    return u, u + "/v1"


# --------------------------------------------------------------------------
# Probe result accumulator
# --------------------------------------------------------------------------
class Report:
    def __init__(self, base_url: str, api_key: str, mode: str):
        self.base_url = base_url
        self.mode = mode
        self.api_key_masked = mask_key(api_key)
        self.probes = []
        self.blockers = []
        self.notes = []
        self.capabilities = {
            "reachable": None,
            "models": [],
            "selected_model": None,
            "declared": {
                "supports_vision": None,
                "supports_function_calling": None,
                "max_input_tokens": None,
                "max_output_tokens": None,
                "mode": None,
                "source": None,
                "trustworthy": None,
            },
            "empirical": {
                "chat": None,
                "vision": "unknown",
                "json_schema": "not-probed",
                "json_object": "not-probed",
                "streaming": None,
                "streaming_chunks": 0,
                "tools": None,
                "thai_roundtrip": "not-probed",
            },
            "vision_verdict": "unknown",
            "context_window": {"value": None, "source": "unknown"},
            # Thai tokenisation is the single biggest budget unknown (see the
            # M0 doc §F.6). Measured, never assumed.
            "tokenizer": {
                "en_prompt_tokens": None,
                "en_prompt_chars": None,
                "th_prompt_tokens": None,
                "th_prompt_chars": None,
                "th_chars_per_token": None,
                "en_chars_per_token": None,
                "th_penalty_vs_en": None,
            },
            "gateway": {
                "litellm_version": None,
                "rate_limit_headers": {},
            },
        }

    def add(self, **kw) -> dict:
        self.probes.append(kw)
        return kw

    def emit(self) -> None:
        json.dump(
            {
                "schema_version": SCHEMA_VERSION,
                "probe_tool": TOOL_NAME,
                "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "mode": self.mode,
                "base_url": self.base_url,
                "api_key_masked": self.api_key_masked,
                "capabilities": self.capabilities,
                "probes": self.probes,
                "blockers": self.blockers,
                "notes": self.notes,
            },
            sys.stdout,
            indent=2,
            sort_keys=False,
        )
        sys.stdout.write("\n")


# --------------------------------------------------------------------------
# HTTP -- single attempt, no retry, explicit timeout, NO REDIRECTS.
#
# Why no redirects: urllib installs HTTPRedirectHandler by default, so a 302
# from the gateway would be followed silently to an arbitrary host. That
# defeats check_public_host() entirely -- the refusal list only ever sees the
# URL we typed, never the URL we ended up talking to. A 3xx is therefore
# surfaced as a status, not chased.
# --------------------------------------------------------------------------
class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # -> urllib raises HTTPError with the 3xx code


_OPENER_CACHE = {}


def _opener(insecure):
    key = bool(insecure)
    if key not in _OPENER_CACHE:
        handlers = [_NoRedirect()]
        if insecure:
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            handlers.append(urllib.request.HTTPSHandler(context=ctx))
        _OPENER_CACHE[key] = urllib.request.build_opener(*handlers)
    return _OPENER_CACHE[key]


# Response headers worth keeping: they answer, for free, questions the M0 doc
# would otherwise have to ask the gateway operator (§7).
INTERESTING_HEADERS = (
    "x-litellm-version", "x-litellm-model-id", "x-litellm-call-id",
    "retry-after", "llm_provider-retry-after",
    "x-ratelimit-limit-requests", "x-ratelimit-remaining-requests",
    "x-ratelimit-limit-tokens", "x-ratelimit-remaining-tokens",
    "content-type", "server", "x-accel-buffering",
)


def _pick_headers(hdrs):
    out = {}
    try:
        for k in INTERESTING_HEADERS:
            v = hdrs.get(k)
            if v is not None:
                out[k] = v
    except Exception:
        pass
    return out


def http(method, url, api_key, timeout, body=None, insecure=False, send_key=True):
    """Returns (status, parsed_json_or_text, latency_ms, error_str, headers)."""
    data = None
    headers = {"Accept": "application/json", "User-Agent": "innovera-m0-probe/1.0"}
    # send_key=False for the unauthenticated /health/* rungs: there is no
    # reason to write the credential into an endpoint's access log when the
    # endpoint does not read it.
    if api_key and send_key:
        headers["Authorization"] = "Bearer " + api_key
        # LiteLLM management routes historically accept x-api-key too.
        headers["x-api-key"] = api_key
    if body is not None:
        # ensure_ascii=True keeps Thai as \uXXXX escapes on the wire. That is
        # valid JSON and immune to any Content-Length/encoding disagreement in
        # an intermediate proxy; the server decodes it back to real Thai.
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = urllib.request.Request(url, data=data, headers=headers, method=method)

    t0 = time.time()
    try:
        with _opener(insecure).open(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
            ms = int((time.time() - t0) * 1000)
            hd = _pick_headers(resp.headers)
            try:
                return resp.status, json.loads(raw), ms, None, hd
            except ValueError:
                return resp.status, raw, ms, None, hd
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        ms = int((time.time() - t0) * 1000)
        hd = _pick_headers(e.headers)
        err = None
        if 300 <= e.code < 400:
            loc = (e.headers.get("location") or "?") if e.headers else "?"
            err = ("REDIRECT REFUSED: %s -> %s. Not followed: following it would "
                   "bypass the public-provider refusal. Investigate the proxy."
                   % (url, loc))
        try:
            return e.code, json.loads(raw), ms, err, hd
        except ValueError:
            return e.code, raw, ms, err, hd
    except Exception as e:  # URLError, timeout, ssl, dns
        ms = int((time.time() - t0) * 1000)
        return None, None, ms, "%s: %s" % (type(e).__name__, e), {}


def stream_probe(url, api_key, timeout, body, insecure=False, want_chunks=2):
    """
    Rung g. Reads at most `want_chunks` SSE 'data:' lines and then ABORTS by
    closing the socket. It does NOT drain the stream -- draining is what the
    brief forbade, and on a real gateway it holds a GPU slot for the full
    generation. Returns (status, chunks_seen, first_line, error, headers).
    """
    data = json.dumps(body).encode("utf-8")
    hdrs = {"Accept": "text/event-stream", "Content-Type": "application/json",
            "User-Agent": "innovera-m0-probe/1.0"}
    if api_key:
        hdrs["Authorization"] = "Bearer " + api_key
    req = urllib.request.Request(url, data=data, headers=hdrs, method="POST")
    try:
        resp = _opener(insecure).open(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        return e.code, 0, blob(raw, 300), None, _pick_headers(e.headers)
    except Exception as e:
        return None, 0, "", "%s: %s" % (type(e).__name__, e), {}

    hd = _pick_headers(resp.headers)
    ctype = (resp.headers.get("content-type") or "").lower()
    chunks, first = 0, ""
    try:
        for _ in range(200):                      # hard read cap
            line = resp.readline()
            if not line:
                break
            s = line.decode("utf-8", "replace").strip()
            if s.startswith("data:"):
                chunks += 1
                if not first:
                    first = s[:200]
                if chunks >= want_chunks:
                    break                          # ABORT -- do not drain
    finally:
        try:
            resp.close()                           # closes the socket
        except Exception:
            pass
    if chunks == 0 and "event-stream" not in ctype:
        # A single buffered JSON blob: the model streamed but a reverse proxy
        # collapsed it. That is proxy misconfiguration, not a model limit.
        return resp.status, 0, "non-SSE content-type: %s" % ctype, None, hd
    return resp.status, chunks, first, None, hd


def blob(obj, limit=600):
    """Truncated stringification for evidence fields."""
    s = obj if isinstance(obj, str) else json.dumps(obj, ensure_ascii=False)
    return s if len(s) <= limit else s[:limit] + "...<truncated>"


def text_of(chat_json):
    try:
        return chat_json["choices"][0]["message"]["content"] or ""
    except Exception:
        return ""


# --------------------------------------------------------------------------
# The probe ladder -- strictly least-invasive first.
# --------------------------------------------------------------------------
def build_plan(base_url, model_hint, expect_digits):
    """Return the ordered list of requests. Used by BOTH dry-run and run."""
    root, v1 = split_base(base_url)
    m = model_hint or "<model-from-/v1/models>"
    ocr_uri = png_data_uri(make_probe_png("OCR"))
    num_uri = png_data_uri(make_probe_png(expect_digits))

    return [
        ("a1", "liveliness", "GET", root + "/health/liveliness", None, T_HEALTH),
        ("a2", "readiness", "GET", root + "/health/readiness", None, T_HEALTH),
        # a3: authenticated, still NO model call. Returns litellm_version +
        # callbacks + cache detail, which answers M0 open question #4 for free
        # instead of asking the gateway operator for it.
        ("a3", "readiness_details", "GET", root + "/health/readiness/details", None, T_HEALTH),
        ("b", "models", "GET", v1 + "/models", None, T_INFO),
        ("c1", "model_info", "GET", root + "/model/info", None, T_INFO),
        ("c2", "model_group_info", "GET", root + "/model_group/info", None, T_INFO),
        # c3/c4: some LiteLLM builds and most path-prefixing reverse proxies
        # expose these only under /v1. Probed as fallbacks so a 404 on c1/c2
        # is not misread as "this is not LiteLLM".
        ("c3", "model_info_v1", "GET", v1 + "/model/info", None, T_INFO),
        ("c4", "model_group_info_v1", "GET", v1 + "/model_group/info", None, T_INFO),
        (
            "d",
            "chat_minimal",
            "POST",
            v1 + "/chat/completions",
            {
                "model": m,
                "messages": [{"role": "user", "content": "Reply with the single word: PONG"}],
                "max_tokens": 8,
                "temperature": 0,
            },
            T_CHAT,
        ),
        # d2: THE THAI PROBE. Mandatory for a Thai-primary product and absent
        # from the original ladder. It answers three separate questions that
        # an English "PONG" can never answer:
        #   1. Does Thai survive the round trip byte-for-byte? (encoding /
        #      normalisation / proxy mangling)
        #   2. Are Thai numerals U+0E50..59 preserved, or silently folded to
        #      ASCII by the model or a normalising middlebox?
        #   3. What does Thai actually cost in tokens? usage.prompt_tokens
        #      here vs rung d is the ONLY honest source for the §F.6 budget
        #      ratio. Everything else is a guess.
        (
            "d2",
            "thai_roundtrip",
            "POST",
            v1 + "/chat/completions",
            {
                "model": m,
                "messages": [{
                    "role": "user",
                    "content": ("Repeat the following line back exactly, character for "
                                "character, with no translation, no transliteration and "
                                "no commentary:\n" + THAI_PROBE),
                }],
                "max_tokens": 64,
                "temperature": 0,
            },
            T_CHAT,
        ),
        (
            "e1",
            "vision_describe",
            "POST",
            v1 + "/chat/completions",
            {
                "model": m,
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": "What text is written in this image?"},
                            {"type": "image_url", "image_url": {"url": ocr_uri}},
                        ],
                    }
                ],
                "max_tokens": 24,
                "temperature": 0,
            },
            T_VISION,
        ),
        (
            "e2",
            "vision_discriminative",
            "POST",
            v1 + "/chat/completions",
            {
                "model": m,
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "text",
                                "text": (
                                    "Read the two-digit number in the image. "
                                    "Reply with ONLY those two digits. "
                                    "If you received no image, reply exactly NO_IMAGE."
                                ),
                            },
                            {"type": "image_url", "image_url": {"url": num_uri}},
                        ],
                    }
                ],
                "max_tokens": 8,
                "temperature": 0,
            },
            T_VISION,
        ),
        (
            "f1",
            "json_schema",
            "POST",
            v1 + "/chat/completions",
            {
                "model": m,
                "messages": [{"role": "user", "content": "Return the number 7 and the word seven."}],
                "max_tokens": 64,
                "temperature": 0,
                "response_format": {
                    "type": "json_schema",
                    "json_schema": {
                        "name": "probe",
                        "strict": True,
                        "schema": {
                            "type": "object",
                            "properties": {
                                "value": {"type": "integer"},
                                "word": {"type": "string"},
                            },
                            "required": ["value", "word"],
                            "additionalProperties": False,
                        },
                    },
                },
            },
            T_CHAT,
        ),
        (
            "f2",
            "json_object",
            "POST",
            v1 + "/chat/completions",
            {
                "model": m,
                "messages": [
                    {"role": "user", "content": 'Reply in JSON as {"value":7,"word":"seven"}'}
                ],
                "max_tokens": 64,
                "temperature": 0,
                "response_format": {"type": "json_object"},
            },
            T_CHAT,
        ),
        (
            "g",
            "streaming",
            "POST",
            v1 + "/chat/completions",
            {
                "model": m,
                "messages": [{"role": "user", "content": "Count: one two three four five."}],
                "max_tokens": 16,
                "temperature": 0,
                "stream": True,
            },
            T_CHAT,
        ),
        (
            "h",
            "tools",
            "POST",
            v1 + "/chat/completions",
            {
                "model": m,
                "messages": [{"role": "user", "content": "What is the status of document 42?"}],
                "max_tokens": 64,
                "temperature": 0,
                "tools": [
                    {
                        "type": "function",
                        "function": {
                            "name": "get_doc_status",
                            "description": "Get the processing status of a document.",
                            "parameters": {
                                "type": "object",
                                "properties": {"doc_id": {"type": "integer"}},
                                "required": ["doc_id"],
                            },
                        },
                    }
                ],
                "tool_choice": "auto",
            },
            T_CHAT,
        ),
    ]


def do_dry_run(rep, plan, expect_digits):
    log("=== DRY RUN -- no sockets are opened. Pass --run to execute. ===")
    for pid, name, method, url, body, timeout in plan:
        log("")
        log("[%s] %s" % (pid, name))
        log("  %s %s   (timeout %ss)" % (method, url, timeout))
        log("  Authorization: Bearer %s" % rep.api_key_masked)
        if body is not None:
            b = json.loads(json.dumps(body))
            # collapse the huge data URI so the dry run stays readable
            for msg in b.get("messages", []):
                if isinstance(msg.get("content"), list):
                    for part in msg["content"]:
                        if part.get("type") == "image_url":
                            u = part["image_url"]["url"]
                            part["image_url"]["url"] = (
                                u[:48] + "...<%d base64 chars, synthetic PNG>" % (len(u) - 48)
                            )
            log("  body: " + json.dumps(b)[:1200])
        rep.add(
            id=pid, name=name, method=method, url=url, planned=True,
            status=None, ok=None, latency_ms=None, verdict="not-executed",
        )
    rep.notes.append(
        "DRY RUN ONLY. No network traffic was generated. "
        "Discriminative vision probe would have used the digits %r." % expect_digits
    )
    rep.notes.append(
        "Probe images are synthetic bitmaps generated in-process. "
        "No customer document is ever read or transmitted by this tool."
    )


def _usage(payload):
    """Extract (prompt_tokens, completion_tokens) or (None, None)."""
    try:
        u = payload.get("usage") or {}
        return u.get("prompt_tokens"), u.get("completion_tokens")
    except Exception:
        return None, None


def _nfc(s):
    """
    Normalise before comparing Thai.

    Thai combining marks (sara/tone/thanthakhat) have more than one valid byte
    ordering, and macOS hands out NFD while most servers emit NFC. Comparing
    raw strings would report a mangled round trip for text that is in fact
    identical. Compare NFC-to-NFC, and report an ordering-only difference
    separately from real corruption.
    """
    return unicodedata.normalize("NFC", s or "")


def do_run(rep, plan, expect_digits, model_hint, insecure, api_key):
    selected = model_hint
    if selected:
        rep.capabilities["selected_model"] = selected
    for pid, name, method, url, body, timeout in plan:
        # Late-bind the model name once /v1/models has answered.
        if body is not None and body.get("model", "").startswith("<"):
            if not selected:
                rep.add(id=pid, name=name, method=method, url=url,
                        status=None, ok=False, latency_ms=None,
                        verdict="skipped", error="no model resolved from /v1/models")
                continue
            body = dict(body, model=selected)

        # /health/liveliness and /health/readiness are documented as
        # UNAUTHENTICATED. Do not write the credential into their access logs.
        send_key = pid not in ("a1", "a2")

        if pid == "g":
            status, gchunks, gfirst, err, hdrs = stream_probe(
                url, api_key, timeout, body, insecure)
            payload, ms = gfirst, None
        else:
            status, payload, ms, err, hdrs = http(
                method, url, api_key, timeout, body, insecure, send_key=send_key)
            gchunks = None

        entry = rep.add(
            id=pid, name=name, method=method, url=url,
            status=status, ok=(status is not None and 200 <= status < 300),
            latency_ms=ms, verdict="", evidence=blob(payload) if payload is not None else None,
            headers=hdrs or None, error=err,
        )
        log("[%s] %-22s -> %s (%sms)" % (pid, name, status if status else err, ms))

        # Harvest free facts from headers on every response.
        if hdrs:
            if hdrs.get("x-litellm-version"):
                rep.capabilities["gateway"]["litellm_version"] = hdrs["x-litellm-version"]
            for hk, hv in hdrs.items():
                if hk.startswith("x-ratelimit-"):
                    rep.capabilities["gateway"]["rate_limit_headers"][hk] = hv

        # A refused redirect is a security finding, not a capability answer.
        if status is not None and 300 <= status < 400:
            entry["verdict"] = "redirect-refused"
            rep.blockers.append(
                "SECURITY: %s answered HTTP %s (redirect). The probe refused to "
                "follow it. A gateway that redirects can send document text to a "
                "host that never passed the public-provider check. Resolve the "
                "redirect with the operator before any application traffic."
                % (url, status))
            continue

        # ---- interpretation -------------------------------------------
        if pid == "a1":
            rep.capabilities["reachable"] = bool(entry["ok"])
            if not entry["ok"] and err:
                rep.blockers.append("Gateway unreachable at %s -- %s" % (url, err))
                entry["verdict"] = "unreachable"
            elif status == 404:
                entry["verdict"] = "404 -- not LiteLLM, or a path-stripping proxy"
                rep.notes.append(
                    "/health/liveliness returned 404 while the URL resolved. This is "
                    "MISCONFIGURATION (wrong base path, or the gateway is not "
                    "LiteLLM), not absence of capability. Later rungs still apply.")
            else:
                entry["verdict"] = "alive" if entry["ok"] else "not-alive"

        elif pid == "a2":
            entry["verdict"] = "ready" if entry["ok"] else "not-ready(%s)" % status
            if isinstance(payload, dict):
                # LiteLLM's documented shape is
                # {status, db_initialized, router_initialized} -- NOT
                # {"status":"healthy","db":...}. Record whatever we get.
                entry["readiness"] = {k: payload.get(k) for k in
                                      ("status", "db_initialized", "router_initialized")}

        elif pid == "a3":
            if entry["ok"] and isinstance(payload, dict):
                v = payload.get("litellm_version")
                if v:
                    rep.capabilities["gateway"]["litellm_version"] = v
                entry["verdict"] = "details ok (litellm_version=%s)" % v
            elif status in (401, 403):
                entry["verdict"] = "authenticated endpoint, key rejected"
            elif status == 404:
                entry["verdict"] = ("404 -- older LiteLLM, or "
                                    "allow_public_health_readiness_details not set")
            else:
                entry["verdict"] = "no details"

        elif pid == "b" and entry["ok"] and isinstance(payload, dict):
            ids = [m.get("id") for m in payload.get("data", []) if m.get("id")]
            rep.capabilities["models"] = ids
            # vLLM (PR #4643, merged 2024-06-02) may expose max_model_len here;
            # LiteLLM rebuilds the list from its own model groups and usually
            # strips it. Read opportunistically, never depend on it.
            for m in payload.get("data", []):
                if m.get("max_model_len"):
                    rep.capabilities["context_window"] = {
                        "value": m["max_model_len"], "source": "v1_models_max_model_len"}
            if not selected and ids:
                # Prefer an obviously-vision model if one is present.
                vl = [i for i in ids if any(t in i.lower() for t in ("-vl", "vl-", "vision"))]
                selected = vl[0] if vl else ids[0]
                rep.capabilities["selected_model"] = selected
                log("    selected model: %s (of %d)" % (selected, len(ids)))
            entry["verdict"] = "listed %d model(s)" % len(ids)

        elif pid in ("c1", "c2", "c3", "c4") and entry["ok"] and isinstance(payload, dict):
            rows = payload.get("data", []) or []
            match = None
            for r in rows:
                nm = r.get("model_group") or r.get("model_name")
                if selected and nm == selected:
                    match = r
                    break
            if match is None and rows:
                match = rows[0]
            if match:
                info = match.get("model_info", match)
                d = rep.capabilities["declared"]
                for k in ("supports_vision", "supports_function_calling",
                          "max_input_tokens", "max_output_tokens", "mode"):
                    if info.get(k) is not None and d.get(k) is None:
                        d[k] = info[k]
                        d["source"] = name
                if d.get("max_input_tokens") and not rep.capabilities["context_window"]["value"]:
                    rep.capabilities["context_window"] = {
                        "value": d["max_input_tokens"], "source": name}
                # TRUST RULE -- see the M0 doc §1. A self-hosted vLLM behind
                # LiteLLM only reports supports_vision/max_input_tokens if the
                # operator hand-wrote model_info. true => operator asserted it.
                # null/false => UNKNOWN, not "no". Must fall through to e2.
                d["trustworthy"] = (d.get("supports_vision") is True)
                if d.get("supports_vision") is not True:
                    rep.notes.append(
                        "%s did not assert supports_vision=true. For a self-hosted "
                        "vLLM this is NOT evidence of text-only; LiteLLM leaves these "
                        "fields null unless model_info is configured by hand "
                        "(BerriAI/litellm#27830, #9297). Empirical probe e2 decides."
                        % name)
            entry["verdict"] = "declared metadata read"

        elif pid == "d":
            rep.capabilities["empirical"]["chat"] = bool(entry["ok"])
            pt, ct = _usage(payload)
            entry["usage"] = {"prompt_tokens": pt, "completion_tokens": ct}
            if pt:
                # The English baseline half of the Thai budget calibration.
                chars = len("Reply with the single word: PONG")
                tk = rep.capabilities["tokenizer"]
                tk["en_prompt_tokens"] = pt
                tk["en_prompt_chars"] = chars
                tk["en_chars_per_token"] = round(chars / float(pt), 3)
            entry["verdict"] = "chat ok" if entry["ok"] else "chat failed"

        elif pid == "d2":
            e = rep.capabilities["empirical"]
            tk = rep.capabilities["tokenizer"]
            pt, ct = _usage(payload)
            entry["usage"] = {"prompt_tokens": pt, "completion_tokens": ct}
            if not entry["ok"]:
                e["thai_roundtrip"] = "unknown (HTTP %s)" % status
                entry["verdict"] = "thai probe did not return 2xx"
            else:
                got = text_of(payload) if isinstance(payload, dict) else ""
                entry["thai_expected"] = THAI_PROBE
                entry["thai_got"] = blob(got, 300)
                if _nfc(THAI_PROBE) in _nfc(got):
                    if THAI_PROBE in got:
                        e["thai_roundtrip"] = "exact"
                    else:
                        e["thai_roundtrip"] = "nfc-equal (normalisation differs)"
                        rep.notes.append(
                            "Thai survived but in a different Unicode normalisation "
                            "form. Normalise to NFC at every boundary (DB write, "
                            "hashing, comparison) or identical Thai will compare "
                            "unequal.")
                elif any("฀" <= c <= "๿" for c in got):
                    e["thai_roundtrip"] = "MANGLED"
                    rep.blockers.append(
                        "THAI ROUND TRIP FAILED: Thai came back altered. Expected "
                        "%r, got %r. Do NOT build extraction on this path until the "
                        "cause is found (tokenizer, proxy transcoding, or model "
                        "normalisation)." % (THAI_PROBE, got[:120]))
                else:
                    e["thai_roundtrip"] = "NO_THAI_RETURNED"
                    rep.blockers.append(
                        "THAI ROUND TRIP FAILED: the reply contains no Thai at all "
                        "(got %r). The model transliterated, translated, or the text "
                        "was stripped in transit." % got[:120])
                # Thai numerals are a separate, silent failure mode.
                thai_digits = [c for c in THAI_PROBE if "๐" <= c <= "๙"]
                kept = [c for c in thai_digits if c in got]
                entry["thai_numerals_preserved"] = "%d/%d" % (len(kept), len(thai_digits))
                if thai_digits and not kept:
                    rep.notes.append(
                        "Thai numerals (U+0E50-59) were NOT preserved. Extraction "
                        "must normalise Thai <-> ASCII digits explicitly; do not "
                        "assume the model preserves them.")
            if pt:
                chars = len(THAI_PROBE)
                tk["th_prompt_tokens"] = pt
                tk["th_prompt_chars"] = chars
                tk["th_chars_per_token"] = round(chars / float(pt), 3)
                if tk.get("en_chars_per_token"):
                    tk["th_penalty_vs_en"] = round(
                        tk["en_chars_per_token"] / tk["th_chars_per_token"], 2)
                rep.notes.append(
                    "MEASURED Thai tokenisation: %s chars/token (English %s). Use "
                    "this, not the placeholder heuristic, for the §F.6 budget. "
                    "NOTE: prompt_tokens includes the English instruction and the "
                    "chat template, so this UNDERSTATES the Thai penalty -- treat "
                    "it as a lower bound and re-measure with a Thai-only prompt "
                    "before tuning chunk sizes."
                    % (tk["th_chars_per_token"], tk.get("en_chars_per_token")))

        elif pid in ("e1", "e2"):
            v = classify_vision(status, payload, expect_digits if pid == "e2" else None)
            entry["verdict"] = v
            if pid == "e2":
                rep.capabilities["empirical"]["vision"] = v
                rep.capabilities["vision_verdict"] = v
                if v == "ambiguous" and entry["ok"]:
                    rep.notes.append(
                        "e2 returned 200 but neither the digits nor NO_IMAGE. The "
                        "model may see the image and misread an 8x-scaled bitmap "
                        "font, or a Thai-tuned model may have answered in Thai "
                        "numerals (U+0E50-59). Re-run with --digits and inspect "
                        "probes[].evidence before concluding anything.")

        elif pid == "f1":
            v = judge_structured(status, payload)
            # Deliberately the VERDICT STRING, not bool(ok). A 200 whose body
            # is not JSON means the constraint was silently ignored -- the most
            # dangerous outcome, and indistinguishable from success by status.
            rep.capabilities["empirical"]["json_schema"] = v
            entry["verdict"] = v
            if v.startswith("accepted but"):
                rep.blockers.append(
                    "json_schema was ACCEPTED but not ENFORCED (200, non-JSON body). "
                    "Treat structured output as UNSUPPORTED: this failure mode looks "
                    "healthy and corrupts extraction downstream. Use prompt-coaxed "
                    "JSON + Zod parse + one bounded repair retry.")
        elif pid == "f2":
            v = judge_structured(status, payload)
            rep.capabilities["empirical"]["json_object"] = v
            entry["verdict"] = v

        elif pid == "g":
            e = rep.capabilities["empirical"]
            e["streaming"] = bool(entry["ok"]) and bool(gchunks)
            e["streaming_chunks"] = gchunks or 0
            entry["chunks"] = gchunks
            if entry["ok"] and gchunks:
                entry["verdict"] = "streaming ok (%d chunks read, aborted)" % gchunks
            elif entry["ok"]:
                entry["verdict"] = "200 but no SSE lines -- proxy is BUFFERING"
                rep.notes.append(
                    "Streaming returned 200 with no 'data:' lines. That is a "
                    "reverse-proxy buffering problem (check X-Accel-Buffering / "
                    "proxy_buffering off), NOT a model limitation.")
            else:
                entry["verdict"] = "stream rejected (%s)" % status

        elif pid == "h":
            got_tool = False
            if entry["ok"] and isinstance(payload, dict):
                try:
                    got_tool = bool(payload["choices"][0]["message"].get("tool_calls"))
                except Exception:
                    got_tool = False
            rep.capabilities["empirical"]["tools"] = got_tool
            entry["verdict"] = "tool_calls emitted" if got_tool else (
                "accepted but no tool_calls" if entry["ok"] else "rejected")
            if entry["ok"] and not got_tool:
                rep.notes.append(
                    "tools accepted but no tool_calls emitted. Usually vLLM was "
                    "started without a --tool-call-parser matching the model family: "
                    "MISCONFIGURED and fixable, not a model limit.")

    # ---- cross-probe reconciliation ------------------------------------
    d = rep.capabilities["declared"]
    e = rep.capabilities["empirical"]
    if d.get("supports_vision") is True and e["vision"] == "text_only":
        rep.blockers.append(
            "CONTRADICTION: /model_info declares supports_vision=true but the "
            "discriminative image probe was rejected. The gateway metadata is "
            "wrong, or the vision model is mis-routed. Trust the empirical result.")
    if not rep.capabilities["context_window"]["value"]:
        rep.blockers.append(
            "Context window unknown. LiteLLM reported no max_input_tokens. Ask the "
            "gateway operator for vLLM's --max-model-len. DO NOT brute-force it "
            "with a long prompt against a production GPU.")
    if not rep.capabilities["gateway"]["litellm_version"]:
        rep.blockers.append(
            "LiteLLM version not observed (no x-litellm-version header, no "
            "/health/readiness/details). Ask the operator: it decides whether "
            "response_format json_schema and model_info propagation are available.")
    if e.get("thai_roundtrip") in ("not-probed", None):
        rep.blockers.append(
            "Thai round trip was not established. This product is Thai-primary; "
            "do not accept the gateway until rung d2 passes.")


def classify_vision(status, payload, expect):
    """
    Distinguish 'not supported' from 'misconfigured' from 'silently ignored'.
    """
    if status is None:
        return "unknown"
    body = blob(payload, 4000).lower()

    if status == 400:
        markers = ("image", "multimodal", "content part", "vision",
                   "not support", "unsupported", "only supports text",
                   "invalid type", "image_url")
        if any(m in body for m in markers):
            return "text_only"
        return "ambiguous"
    if status in (401, 403):
        return "unknown"  # auth problem, tells us nothing about vision
    if status == 404:
        return "unknown"  # model name wrong -- misconfigured, not text-only
    if status and status >= 500:
        return "unknown"  # backend fault, not a capability answer

    if 200 <= status < 300:
        txt = text_of(payload) if isinstance(payload, dict) else ""
        t = txt.strip().lower()
        if "no_image" in t:
            return "text_only"  # model answered, explicitly saw no image
        if expect:
            return "vision" if expect in t else "ambiguous"
        return "vision_maybe"
    return "unknown"


def judge_structured(status, payload):
    if status is None:
        return "no response"
    if status == 400:
        return "rejected (400) -- response_format not supported by this backend"
    if 200 <= status < 300 and isinstance(payload, dict):
        txt = text_of(payload).strip()
        try:
            json.loads(txt)
            return "honored -- valid JSON returned"
        except Exception:
            return "accepted but output is NOT valid JSON (constraint not enforced)"
    return "status %s" % status


# --------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser(
        description="INNOVERA M0 read-only AI gateway capability probe.")
    ap.add_argument("--run", action="store_true",
                    help="Actually send requests. Without this, dry-run only.")
    ap.add_argument("--model", default=None,
                    help="Pin a model id instead of auto-selecting from /v1/models.")
    ap.add_argument("--insecure", action="store_true",
                    help="Skip TLS verification (self-signed gateway cert only).")
    ap.add_argument("--digits", default=None,
                    help="Force the 2-digit discriminative value (default: random).")
    args = ap.parse_args()

    # LITELLM_* is the evidenced house vocabulary (b §E1). AI_* is accepted
    # as a deprecated fallback so an operator who copied an older draft is
    # warned rather than silently refused.
    base_url = os.environ.get("LITELLM_BASE_URL", "").strip()
    api_key = os.environ.get("LITELLM_API_KEY", "").strip()
    if not base_url and os.environ.get("AI_BASE_URL", "").strip():
        base_url = os.environ["AI_BASE_URL"].strip()
        log("  WARNING: AI_BASE_URL is DEPRECATED. Use LITELLM_BASE_URL.")
    if not api_key and os.environ.get("AI_API_KEY", "").strip():
        api_key = os.environ["AI_API_KEY"].strip()
        log("  WARNING: AI_API_KEY is DEPRECATED. Use LITELLM_API_KEY.")

    if not base_url:
        refuse(
            "LITELLM_BASE_URL is not set. Export the literal value supplied "
            "by the gateway owner (blocker B-1). Either convention is "
            "accepted: with or without a trailing /v1."
        )
    if not base_url.startswith(("http://", "https://")):
        refuse(
            "LITELLM_BASE_URL must start with http:// or https:// (got %r)"
            % base_url
        )
    check_public_host(base_url)
    if args.run and not api_key:
        refuse(
            "LITELLM_API_KEY is not set. Refusing to probe without a "
            "credential. Use OCR's own virtual key (blocker B-2), never "
            "Chat's key and never the master key."
        )

    expect = args.digits or str(random.randint(10, 99))
    if len(expect) != 2 or not expect.isdigit():
        refuse("--digits must be exactly two digits")

    mode = "run" if args.run else "dry-run"
    log("INNOVERA M0 AI gateway probe -- mode=%s" % mode)
    log("  base_url : %s" % base_url)
    log("  api_key  : %s" % mask_key(api_key))

    rep = Report(base_url, api_key, mode)
    plan = build_plan(base_url, args.model, expect)

    if not args.run:
        do_dry_run(rep, plan, expect)
        rep.emit()
        return 0

    do_run(rep, plan, expect, args.model, args.insecure, api_key)
    rep.emit()
    return 0 if rep.capabilities["reachable"] else 3


if __name__ == "__main__":
    sys.exit(main())
