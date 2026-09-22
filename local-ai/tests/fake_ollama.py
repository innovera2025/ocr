"""Fake Ollama (OpenAI-compatible) server for local end-to-end runs of the Local AI service. Standard library only.

    python local-ai/tests/fake_ollama.py --port 11434 --latency-ms 800
    OLLAMA_URL=http://127.0.0.1:11434/v1/chat/completions uvicorn api:app --port 5000   (from local-ai/)

POST /v1/chat/completions returns canned OCR text chosen by prompt keywords (see `prompt_kind`: the v3.1 combined prompt,
the STAFF ONLY prompts, the v3.2 header + customer prompt, the customer prompt). Override the canned text with
FAKE_OLLAMA_STAFF_TEXT / FAKE_OLLAMA_CUSTOMER_TEXT / FAKE_OLLAMA_HEADER_TEXT. With "logprobs": true in the request the
answer carries OpenAI-style token logprobs (byte-level tokens of 4 bytes, so Thai characters are split across tokens like
a real byte-level BPE; logprob FAKE_OLLAMA_LOGPROB, default -0.01). FAKE_OLLAMA_TOKEN_TEXT=1 (or start(token_text=True))
returns them as Ollama does in front of llama-server (see `ollama_view`): a split Thai character loses its bytes.
GET /v1/models and /api/tags list the model.
Requests without a PNG data-URL image are rejected with 400 so client regressions show up.
"""

import argparse
import base64
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL = "scb10x/typhoon-ocr1.5-3b"
STAFF_TEXT = "Treatment : ไทย 90 นาที + หน้า 1 ชม.\nTherapist Name : พีพี\nRoom No. : 3"
CUSTOMER_TEXT = "Name 姓名 : Chun\nNationality 国籍 : Chinese\nHotel Name 酒店 :"
HEADER_TEXT = "No. 01234\nDate 日期 : 16/08/26\nTime 时间 :"


def prompt_kind(prompt):
    """"combined" (v3.1 prompt: header, customer rows, staff crop), "staff" (STAFF_PROMPT / STAFF_VOCAB_PROMPT),
    "headerCustomer" (v3.2: header above the customer rows), "customer" (CUSTOMER_PROMPT) or "other"."""
    if "STAFF ONLY" in prompt:
        return "combined" if "CUSTOMER INFORMATION" in prompt else "staff"
    if "CUSTOMER INFORMATION" in prompt:
        return "headerCustomer" if "\nDate:" in prompt else "customer"
    return "other"


def canned_text(prompt):
    header, customer, staff = (os.environ.get("FAKE_OLLAMA_HEADER_TEXT", HEADER_TEXT), os.environ.get("FAKE_OLLAMA_CUSTOMER_TEXT", CUSTOMER_TEXT),
                               os.environ.get("FAKE_OLLAMA_STAFF_TEXT", STAFF_TEXT))
    return {"combined": f"{header}\n{customer}\n\n{staff}", "staff": staff, "headerCustomer": f"{header}\n{customer}",
            "customer": customer}.get(prompt_kind(prompt), "Fake OCR text")


def fake_tokens(text, logprob=-0.01, low=None, size=4):
    """OpenAI-style logprobs content for `text`: byte-level tokens of `size` bytes (a Thai character, 3 bytes, is split
    across two tokens), each with `logprob`, or low[s] for the tokens inside an occurrence of substring s."""
    data = text.encode("utf-8")
    slow = []  # (byte start, byte end, logprob) of the low-confidence substrings
    for word, value in (low or {}).items():
        start = text.find(word)
        while start >= 0:
            first = len(text[:start].encode("utf-8"))
            slow.append((first, first + len(word.encode("utf-8")), value))
            start = text.find(word, start + 1)
    content = []
    for position in range(0, len(data), size):
        piece = data[position:position + size]
        value = min([lp for s, e, lp in slow if s < position + len(piece) and e > position], default=logprob)
        token = piece.decode("utf-8", "replace")
        content.append({"token": token, "logprob": value, "bytes": list(piece), "top_logprobs": [{"token": token, "logprob": value, "bytes": list(piece)}]})
    return content


def _valid_prefix(piece):
    """llama.cpp's validate_utf8: the length of `piece` without a multi-byte character cut off at its end."""
    for back in range(1, min(4, len(piece)) + 1):
        byte = piece[-back]
        if (byte & 0xE0 == 0xC0 and back < 2) or (byte & 0xF0 == 0xE0 and back < 3) or (byte & 0xF8 == 0xF0 and back < 4):
            return len(piece) - back
    return len(piece)


def ollama_view(content):
    """`fake_tokens` content as Ollama's OpenAI endpoint returns it from llama-server: llama-server cuts a partial UTF-8
    character off the end of a token's text and JSON-encodes stray continuation bytes as U+FFFD; Ollama keeps only that
    text and derives "bytes" from it (omitted when empty). A Thai character split over two tokens comes back as "" + "\ufffd"."""
    out = []
    for token in content:
        piece = bytes(token["bytes"])
        text = piece[:_valid_prefix(piece)].decode("utf-8", "replace")
        entry = {"token": text, "logprob": token["logprob"], **({"bytes": list(text.encode("utf-8"))} if text else {})}
        out.append({**entry, "top_logprobs": [dict(entry)]})
    return out


def make_handler(latency_ms=0, log=None, fail=None, low=None, token_text=False):
    """`fail`: {prompt kind: n} answers HTTP 500 to the first n requests of that kind (Ollama failing mid-generation);
    `low`: {substring: logprob} for the logprobs of the tokens inside those substrings; `token_text`: token logprobs as
    Ollama returns them from llama-server (`ollama_view`)."""
    token_text = token_text or os.environ.get("FAKE_OLLAMA_TOKEN_TEXT") == "1"
    failures, lock = dict(fail or {}), threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def _send(self, status, body):
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):  # noqa: N802 (http.server naming)
            if self.path in ("/v1/models", "/api/tags"):
                self._send(200, {"object": "list", "data": [{"id": MODEL, "object": "model"}], "models": [{"name": MODEL}]})
            else:
                self._send(404, {"error": "not found"})

        def do_POST(self):  # noqa: N802
            if self.path != "/v1/chat/completions":
                self._send(404, {"error": "not found"})
                return
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))).decode("utf-8"))
                content = body["messages"][0]["content"]
                prompt = next(part["text"] for part in content if part.get("type") == "text")
                url = next(part["image_url"]["url"] for part in content if part.get("type") == "image_url")
                if not url.startswith("data:image/png;base64,") or not base64.b64decode(url.split(",", 1)[1]).startswith(b"\x89PNG"):
                    raise ValueError("image_url must be a PNG data URL")
            except (KeyError, IndexError, StopIteration, ValueError, TypeError) as error:
                self._send(400, {"error": f"bad request: {error}"})
                return
            if log is not None:
                log.append({"model": body.get("model"), "prompt": prompt, "max_tokens": body.get("max_tokens"), "at": time.time(),
                            "logprobs": body.get("logprobs"), "top_logprobs": body.get("top_logprobs")})
            if latency_ms:
                time.sleep(latency_ms / 1000)
            with lock:
                kind = prompt_kind(prompt)
                failing = failures.get(kind, 0) > 0
                if failing:
                    failures[kind] -= 1
            if failing:
                self._send(500, {"error": "llama runner process has terminated"})
                return
            text = canned_text(prompt)
            choice = {"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}
            if body.get("logprobs"):
                content = fake_tokens(text, float(os.environ.get("FAKE_OLLAMA_LOGPROB", "-0.01")), low)
                choice["logprobs"] = {"content": ollama_view(content) if token_text else content}
            self._send(200, {"id": "chatcmpl-fake", "object": "chat.completion", "created": int(time.time()), "model": body.get("model", MODEL),
                             "choices": [choice], "usage": {"prompt_tokens": 0, "completion_tokens": len(text), "total_tokens": len(text)}})

        def log_message(self, fmt, *args):  # keep test output quiet
            if os.environ.get("FAKE_OLLAMA_VERBOSE"):
                super().log_message(fmt, *args)

    return Handler


def start(port=0, latency_ms=0, host="127.0.0.1", fail=None, low=None, token_text=False):
    """Start in a daemon thread; returns (server, base_url, request_log). Stop with server.shutdown()."""
    log = []
    server = ThreadingHTTPServer((host, port), make_handler(latency_ms, log, fail, low, token_text))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://{host}:{server.server_address[1]}", log


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=11434)
    parser.add_argument("--latency-ms", type=int, default=int(os.environ.get("FAKE_OLLAMA_LATENCY_MS", "0")))
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), make_handler(args.latency_ms))
    print(f"fake ollama on http://{args.host}:{args.port}/v1/chat/completions (latency {args.latency_ms} ms)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
