import base64
import json
import re
import difflib
import uuid
import urllib.request
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.responses import JSONResponse
from PIL import Image

app = FastAPI(title="INNOVERA OCR API", version="2.2")

MODEL = "scb10x/typhoon-ocr1.5-3b"
OLLAMA = "http://host.docker.internal:11434/v1/chat/completions"

UPLOAD_DIR = Path("/app/uploads")
UPLOAD_DIR.mkdir(exist_ok=True)

VERIFIED_FILE = Path("/app/verified_dataset/corrections.jsonl")

TREATMENTS = [
    "คอ บ่า ไหล่",
    "นวดไทย",
    "นวดน้ำมัน",
    "อโรมา",
    "นวดเท้า",
    "Thai Massage",
    "Oil Massage",
    "Foot Massage",
]

THERAPISTS = [
    "ฟ้า",
    "พีพี",
    "เอี้ยง",
]


def call_ocr(image_path, prompt, max_tokens=220):
    with open(image_path, "rb") as f:
        encoded = base64.b64encode(f.read()).decode()

    payload = {
        "model": MODEL,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {
                    "type": "image_url",
                    "image_url": {
                        "url": "data:image/png;base64," + encoded
                    }
                }
            ]
        }],
        "temperature": 0,
        "max_tokens": max_tokens
    }

    req = urllib.request.Request(
        OLLAMA,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"}
    )

    with urllib.request.urlopen(req, timeout=600) as r:
        result = json.loads(r.read().decode("utf-8"))

    return result["choices"][0]["message"]["content"]


def load_verified():
    records = []

    if not VERIFIED_FILE.exists():
        return records

    for line in VERIFIED_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue

        try:
            records.append(json.loads(line))
        except Exception:
            pass

    return records


def verified_match(field, raw):
    if not raw:
        return None

    for row in reversed(load_verified()):
        if (
            row.get("field") == field
            and row.get("ocrRaw") == raw
            and row.get("verifiedByHuman") is True
        ):
            return row.get("verifiedValue")

    return None


def similarity(a, b):
    return difflib.SequenceMatcher(
        None,
        a.lower().strip(),
        b.lower().strip()
    ).ratio()


def best_match(raw, candidates):
    if not raw:
        return None, 0.0

    best = None
    best_score = 0.0

    for candidate in candidates:
        score = similarity(raw, candidate)

        if score > best_score:
            best = candidate
            best_score = score

    return best, best_score


def extract_fields(text):
    treatment = None
    therapist = None
    room = None

    m = re.search(
        r"Treatment\s*:\s*(.+?)(?=\n|Therapist Name|$)",
        text,
        re.I | re.S
    )
    if m:
        treatment = m.group(1).strip()

    m = re.search(
        r"Therapist Name\s*:\s*(.+?)(?=Room No\.?|$)",
        text,
        re.I | re.S
    )
    if m:
        therapist = m.group(1).strip()

    m = re.search(
        r"Room No\.?\s*:\s*([A-Za-z0-9ก-๙]+)",
        text,
        re.I
    )
    if m:
        room = m.group(1).strip()

    return treatment, therapist, room


def normalize_therapist(raw):
    if not raw:
        return {
            "raw": raw,
            "value": None,
            "confidence": 0.0,
            "source": "none",
            "needsReview": True
        }

    verified = verified_match("therapist", raw)

    if verified:
        return {
            "raw": raw,
            "value": verified,
            "confidence": 1.0,
            "source": "verified-memory",
            "needsReview": False
        }

    matched, score = best_match(raw, THERAPISTS)

    value = matched if score >= 0.65 else None

    return {
        "raw": raw,
        "value": value,
        "confidence": round(score, 3),
        "source": "master-fuzzy",
        "needsReview": value is None or score < 0.85
    }


def parse_treatment(raw):
    if not raw:
        return {
            "raw": raw,
            "durations": [],
            "items": [],
            "needsReview": True
        }

    durations = re.findall(
        r'\d+\s*(?:นาที|ชม\.?|ชั่วโมง|min(?:ute)?s?|hr(?:s)?\.?)',
        raw,
        re.I
    )

    service_text = re.sub(
        r'\d+\s*(?:นาที|ชม\.?|ชั่วโมง|min(?:ute)?s?|hr(?:s)?\.?)',
        ' ',
        raw,
        flags=re.I
    )

    service_text = re.sub(r'[+,\d.]+', ' ', service_text)

    parts = [
        x.strip()
        for x in service_text.split()
        if x.strip()
    ]

    items = []

    for i, part in enumerate(parts):
        verified = verified_match("treatment", part)

        if verified:
            value = verified
            score = 1.0
            source = "verified-memory"

        elif part == "ไทย":
            value = "นวดไทย"
            score = 0.95
            source = "rule"

        else:
            matched, score = best_match(part, TREATMENTS)
            value = matched if score >= 0.72 else None
            source = "master-fuzzy"

        items.append({
            "raw": part,
            "value": value,
            "duration": durations[i] if i < len(durations) else None,
            "confidence": round(score, 3),
            "source": source,
            "needsReview": value is None
        })

    return {
        "raw": raw,
        "durations": durations,
        "items": items,
        "needsReview": any(x["needsReview"] for x in items)
    }


def normalize_room(raw):
    ok = bool(raw and raw.isdigit())

    return {
        "raw": raw,
        "value": raw if ok else None,
        "confidence": 0.95 if ok else 0.0,
        "source": "ocr",
        "needsReview": not ok
    }


@app.get("/health")
def health():
    return {
        "status": "ok",
        "service": "innovera-ocr",
        "version": "2.2"
    }


@app.post("/v1/ocr")
async def ocr(file: UploadFile = File(...)):
    ext = Path(file.filename).suffix.lower()

    if ext not in [".png", ".jpg", ".jpeg"]:
        raise HTTPException(
            400,
            "Only PNG/JPG/JPEG supported for now"
        )

    document_id = str(uuid.uuid4())

    source = UPLOAD_DIR / f"{document_id}{ext}"
    source.write_bytes(await file.read())

    try:
        img = Image.open(source).convert("RGB")

        staff_crop = img.crop((410, 485, 710, 570))

        staff_file = UPLOAD_DIR / f"{document_id}_staff.png"
        staff_crop.save(staff_file)

        staff_raw = call_ocr(
            staff_file,
            """
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
""",
            220
        )

        treatment_raw, therapist_raw, room_raw = extract_fields(staff_raw)

        result = {
            "documentId": document_id,
            "sourceFile": file.filename,
            "engine": "typhoon-crop-only",
            "version": "2.2",
            "staffOnly": {
                "treatment": parse_treatment(treatment_raw),
                "therapistName": normalize_therapist(therapist_raw),
                "roomNo": normalize_room(room_raw)
            },
            "evidence": {
                "staffCropRaw": staff_raw
            }
        }

        return JSONResponse(result)

    except Exception as e:
        raise HTTPException(500, str(e))

from pydantic import BaseModel
from datetime import datetime, timezone

class ConfirmRequest(BaseModel):
    documentId: str
    field: str
    raw: str
    verifiedValue: str


@app.post("/v1/ocr/confirm")
def confirm_ocr(data: ConfirmRequest):

    allowed_fields = [
        "treatment",
        "therapist"
    ]

    if data.field not in allowed_fields:
        raise HTTPException(
            400,
            "field must be treatment or therapist"
        )

    VERIFIED_FILE.parent.mkdir(
        parents=True,
        exist_ok=True
    )

    record = {
        "timestamp": datetime.now(
            timezone.utc
        ).isoformat(),
        "documentId": data.documentId,
        "field": data.field,
        "ocrRaw": data.raw,
        "verifiedValue": data.verifiedValue,
        "verifiedByHuman": True
    }

    with VERIFIED_FILE.open(
        "a",
        encoding="utf-8"
    ) as f:
        f.write(
            json.dumps(
                record,
                ensure_ascii=False
            ) + "\n"
        )

    return {
        "status": "saved",
        "record": record
    }
