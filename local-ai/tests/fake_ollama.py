"""Fake Ollama (OpenAI-compatible) server for local end-to-end runs of the Local AI service. Standard library only.

    python local-ai/tests/fake_ollama.py --port 11434 --latency-ms 800
    OLLAMA_URL=http://127.0.0.1:11434/v1/chat/completions uvicorn api:app --port 5000   (from local-ai/)

POST /v1/chat/completions returns canned OCR text chosen by prompt keywords (STAFF ONLY / CUSTOMER INFORMATION).
Override the canned text with FAKE_OLLAMA_STAFF_TEXT / FAKE_OLLAMA_CUSTOMER_TEXT / FAKE_OLLAMA_HEADER_TEXT.
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


def canned_text(prompt):
    if "STAFF ONLY" in prompt and "CUSTOMER INFORMATION" in prompt:  # combined call: header, customer rows, staff crop
        return (os.environ.get("FAKE_OLLAMA_HEADER_TEXT", HEADER_TEXT) + "\n" + os.environ.get("FAKE_OLLAMA_CUSTOMER_TEXT", CUSTOMER_TEXT)
                + "\n\n" + os.environ.get("FAKE_OLLAMA_STAFF_TEXT", STAFF_TEXT))
    if "STAFF ONLY" in prompt:
        return os.environ.get("FAKE_OLLAMA_STAFF_TEXT", STAFF_TEXT)
    if "CUSTOMER INFORMATION" in prompt:
        return os.environ.get("FAKE_OLLAMA_CUSTOMER_TEXT", CUSTOMER_TEXT)
    return "Fake OCR text"


def make_handler(latency_ms=0, log=None):
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
                log.append({"model": body.get("model"), "prompt": prompt, "max_tokens": body.get("max_tokens"), "at": time.time()})
            if latency_ms:
                time.sleep(latency_ms / 1000)
            text = canned_text(prompt)
            self._send(200, {"id": "chatcmpl-fake", "object": "chat.completion", "created": int(time.time()), "model": body.get("model", MODEL),
                             "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
                             "usage": {"prompt_tokens": 0, "completion_tokens": len(text), "total_tokens": len(text)}})

        def log_message(self, fmt, *args):  # keep test output quiet
            if os.environ.get("FAKE_OLLAMA_VERBOSE"):
                super().log_message(fmt, *args)

    return Handler


def start(port=0, latency_ms=0, host="127.0.0.1"):
    """Start in a daemon thread; returns (server, base_url, request_log). Stop with server.shutdown()."""
    log = []
    server = ThreadingHTTPServer((host, port), make_handler(latency_ms, log))
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
