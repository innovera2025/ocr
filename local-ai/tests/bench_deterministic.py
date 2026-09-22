"""Times everything except the model: decode, layout/registration, ink masks, checkbox + body-map detection, crops, parsing.

    python tests/bench_deterministic.py [image] [--runs 30]      (from local-ai/; defaults to the synthetic form)

The model call is replaced by an instant canned answer, so totalMs here is the overhead v3 adds around inference.
"""

import argparse
import io
import statistics
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE.parent), str(HERE)]

import api  # noqa: E402
import fake_ollama  # noqa: E402
import ocr_model  # noqa: E402
import synthetic_form  # noqa: E402
from PIL import Image  # noqa: E402

STAFF = "Treatment : ไทย 90 นาที + หน้า 1 ชม.\nTherapist Name : พีพี\nRoom No. : 3"
CUSTOMER = "Name 姓名 : Chun\nNationality 国籍 : Chinese\nHotel Name 酒店 :"
HEADER = "No. 01234\nDate 日期 : 16/08/26\nTime 时间 :"


def canned(png, prompt, max_tokens=220):
    """Instant model answer; every prompt gets all its sections, so no fallback call is triggered."""
    kind = fake_ollama.prompt_kind(prompt)
    return {"combined": f"{HEADER}\n{CUSTOMER}\n\n{STAFF}", "staff": STAFF, "headerCustomer": f"{HEADER}\n{CUSTOMER}"}.get(kind, CUSTOMER)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("image", nargs="?")
    parser.add_argument("--runs", type=int, default=30)
    args = parser.parse_args()
    if args.image:
        data, ext = Path(args.image).read_bytes(), Path(args.image).suffix.lower()
    else:
        buffer = io.BytesIO()
        synthetic_form.filled_form().save(buffer, format="PNG")
        data, ext = buffer.getvalue(), ".png"
    ocr_model.call_ocr = canned
    rows = []
    for _ in range(args.runs + 3):
        started = time.perf_counter()
        image, warnings = api._decode(data, ext)
        decoded = time.perf_counter()
        result = api.process_image(image, "bench", "bench" + ext, started, warnings)
        rows.append({**{k: v for k, v in result["timings"].items() if k != "sections"}, "decodeMs": (decoded - started) * 1000})
    rows = rows[3:]  # warm-up
    print(f"python {sys.version.split()[0]}, Pillow {Image.__version__}, runs={args.runs}, image={args.image or 'synthetic'}")
    for key in ("decodeMs", "preprocessMs", "checkboxMs", "normalizeMs", "totalMs"):
        values = sorted(r[key] for r in rows)
        print(f"  {key:13s} median {statistics.median(values):7.1f}  p90 {values[int(len(values) * 0.9) - 1]:7.1f}  max {values[-1]:7.1f}")


if __name__ == "__main__":
    main()
