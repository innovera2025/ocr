"""Text normalization: master data (master_data.json), verified memory (corrections.jsonl), parsing of the model's
STAFF ONLY / CUSTOMER INFORMATION transcriptions into schema-v3 fields."""

import difflib
import json
import os
import re
import threading
from pathlib import Path

HERE = Path(__file__).resolve().parent
THAI_DIGITS = str.maketrans("๐๑๒๓๔๕๖๗๘๙", "0123456789")
REVIEW_BELOW = 0.85  # fuzzy master matches below this similarity need review (v2.2 rule)


def field(raw, value, confidence, source, needs_review):
    return {"raw": raw, "value": value, "confidence": round(float(confidence), 3), "source": source, "needsReview": bool(needs_review)}


def verified_path():
    return Path(os.environ.get("OCR_VERIFIED_FILE", "/app/verified_dataset/corrections.jsonl"))


def master_path():
    return Path(os.environ.get("OCR_MASTER_DATA", str(HERE / "master_data.json")))


class _FileCache:
    """Re-parses a file only when its (path, mtime_ns, size) changes."""

    def __init__(self, loader):
        self._loader, self._lock, self._key, self._value = loader, threading.Lock(), None, None

    def get(self, path):
        try:
            st = path.stat()
            key = (str(path), st.st_mtime_ns, st.st_size)
        except FileNotFoundError:
            key = (str(path), None, None)
        with self._lock:
            if key != self._key:
                self._value, self._key = self._loader(path if key[1] is not None else None), key
            return self._value


def _load_verified(path):
    memory = {}
    if path is None:
        return memory
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if isinstance(row, dict) and row.get("verifiedByHuman") is True and row.get("ocrRaw") and row.get("verifiedValue"):
            memory[(row.get("field"), row["ocrRaw"])] = row["verifiedValue"]  # later rows win (v2.2: last match)
    return memory


def _load_master(path):
    if path is None:
        raise FileNotFoundError(f"master data not found: {master_path()}")
    return json.loads(path.read_text(encoding="utf-8"))


_verified_cache, _master_cache = _FileCache(_load_verified), _FileCache(_load_master)
_append_lock = threading.Lock()


def verified_match(field_name, raw):
    if not raw:
        return None
    memory = _verified_cache.get(verified_path())
    return memory.get((field_name, raw)) or memory.get((field_name, raw.strip()))


def append_verified(record):
    path = verified_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(record, ensure_ascii=False) + "\n"
    with _append_lock, path.open("a", encoding="utf-8") as f:
        f.write(line)


def master():
    return _master_cache.get(master_path())


def _key(text):
    return re.sub(r"[\s.\-_,:;/()]+", "", text.translate(THAI_DIGITS).lower())


def similarity(a, b):
    return difflib.SequenceMatcher(None, a.lower().strip(), b.lower().strip()).ratio()


def _best(raw, entries, name_key):
    """Best master entry for raw among each entry's name and aliases -> (entry, score, exact)."""
    raw_key, best = _key(raw), (None, 0.0, False)
    for entry in entries:
        for candidate in [entry[name_key], *entry.get("aliases", [])]:
            if _key(candidate) == raw_key and raw_key:
                return entry, 1.0, candidate != entry[name_key]
            score = similarity(raw, candidate)
            if score > best[1]:
                best = (entry, score, False)
    return best


# ---------------------------------------------------------------- STAFF ONLY

_NOISE_LINES = re.compile(r"staff\s*only|仅前台|ploenchit|makkha|health\s*&\s*spa", re.I)


def _clean_model_text(text):
    text = re.sub(r"<[^>]+>", "\n", text or "")
    return text.replace("：", ":").replace("**", "").replace("__", "").replace("`", "")


def extract_staff_fields(text):
    """(treatment, therapist, room) raw strings from the STAFF ONLY transcription (v2.2 label regexes, hardened)."""
    text = _clean_model_text(text)
    treatment = therapist = room = None
    m = re.search(r"Treatment\s*:?\s*(.+?)(?=Therapist\s*Name|Room\s*No|$)", text, re.I | re.S)
    if m:
        lines = [ln.strip(" \t|-") for ln in m.group(1).splitlines()]
        lines = [ln for ln in lines if ln and not _NOISE_LINES.search(ln)]
        treatment = "\n".join(lines) or None
    m = re.search(r"Therapist\s*Name\s*:?\s*(.+?)(?=Room\s*No\.?|$)", text, re.I | re.S)
    if m:
        lines = [ln.strip(" \t|:-") for ln in m.group(1).splitlines() if ln.strip(" \t|:-")]
        therapist = lines[0] if lines else None
    m = re.search(r"Room\s*No\.?\s*:?\s*([A-Za-z0-9ก-๙]+)", text, re.I)
    if m:
        room = m.group(1).strip()
    return treatment, therapist, room


def normalize_therapist(raw):
    if not raw:
        return field(raw, None, 0.0, "none", True)
    verified = verified_match("therapist", raw)
    if verified:
        return field(raw, verified, 1.0, "verified-memory", False)
    entry, score, _ = _best(raw, master().get("therapists", []), "name")
    value = entry["name"] if entry and score >= 0.65 else None
    return field(raw, value, score, "master-fuzzy", value is None or score < REVIEW_BELOW)


def normalize_room(raw):
    clean = raw.translate(THAI_DIGITS).strip(" .:-") if raw else raw
    ok = bool(clean and clean.isdigit())
    return field(raw, clean if ok else None, 0.95 if ok else 0.0, "ocr", not ok)


# ---------------------------------------------------------------- treatments

_HOUR = r"(?:ชั่วโมง|ชัวโมง|ช\.ม\.|ชม\.?|ซม\.?|hours?|hrs?\.?|h(?![a-z]))"
_MIN = r"(?:นาที|นท\.?|น\.|minutes?|mins?\.?|m(?![a-z]))"
DURATION_RE = re.compile(
    rf"(?P<num>\d+(?:[.,]\d+)?)\s*(?:(?P<hour>{_HOUR})(?:\s*(?P<half>ครึ่ง))?(?:\s*(?P<num2>\d+)\s*{_MIN})?|(?P<min>{_MIN}))", re.I)
BARE_NUMBER_RE = re.compile(r"(?<![\d.])(\d+(?:\.\d+)?)(?![\d.])")
SEPARATOR_RE = re.compile(r"\s*(?:\+|＋|/|\n|;|、|，|(?<!\d),|,(?!\d)|\s&\s|\sและ\s)\s*")


def _minutes(match):
    number = float(match.group("num").replace(",", "."))
    if match.group("hour"):
        minutes = number * 60 + (30 if match.group("half") else 0) + (int(match.group("num2")) if match.group("num2") else 0)
    else:
        minutes = number
    return int(round(minutes))


def _clean_name(text):
    text = BARE_NUMBER_RE.sub(" ", text)
    text = re.sub(r"^[\s.:;,*×\-–]+|[\s.:;,*×\-–]+$", "", re.sub(r"\s+", " ", text))
    return text or None


def _segment_groups(segment):
    """Split one segment into [name, raw_start, raw_end, [(duration_text, minutes, bare)]] groups."""
    groups, pos = [], 0
    for m in DURATION_RE.finditer(segment):
        name = _clean_name(segment[pos:m.start()])
        if name or not groups:
            groups.append([name, pos, m.end(), []])
        groups[-1][2] = m.end()
        groups[-1][3].append((m.group(0).strip(), _minutes(m), False))
        pos = m.end()
    tail = segment[pos:]
    tail_name = _clean_name(tail)
    if tail_name:
        groups.append([tail_name, pos, len(segment), []])
    for group in groups:  # "ไทย 90" -> bare number as duration
        if group[0] and not group[3]:
            bare = BARE_NUMBER_RE.findall(segment[group[1]:group[2]])
            if bare:
                number = float(bare[0])
                minutes = int(round(number * 60)) if number <= 4 else int(round(number))
                group[3].append((bare[0], minutes, True))
    merged = []
    for group in groups:  # "90 นาที ไทย": a leading duration belongs to the following name
        if merged and merged[-1][0] is None and group[0] and not group[3]:
            group[3], group[1] = merged[-1][3], merged[-1][1]
            merged[-1] = group
        else:
            merged.append(group)
    return [(g[0], segment[g[1]:g[2]].strip(), g[3]) for g in merged]


def _match_treatment(name_raw, raw):
    for candidate in (name_raw, raw):
        verified = verified_match("treatment", candidate)
        if verified:
            return verified, 1.0, "verified-memory"
    entry, score, alias = _best(name_raw, master().get("treatments", []), "name")
    if entry and score == 1.0:
        return entry["name"], 0.95 if alias else 1.0, "rule" if alias else "master-fuzzy"
    if entry and score >= 0.72:
        return entry["name"], score, "master-fuzzy"
    return None, score, "master-fuzzy"


def _allowed_durations(value):
    for entry in master().get("treatments", []):
        if entry["name"] == value:
            return entry.get("durations") or []
    return []


def parse_treatments(raw):
    """Treatment transcription -> (items: [TreatmentField], all duration strings, warnings, total minutes|None)."""
    if not raw:
        return [], [], [], None
    text = raw.translate(THAI_DIGITS)
    groups = []
    for segment in SEPARATOR_RE.split(text):
        if segment.strip():
            groups.extend(_segment_groups(segment))
    durations_all = [d[0] for _, _, ds in groups for d in ds if not d[2]]
    total, warnings, items = None, [], []
    named_minutes = [ds[0][1] for name, _, ds in groups if name and ds]
    for index, (name, seg_raw, durs) in enumerate(groups):
        last = index == len(groups) - 1
        if name is None:
            if last and len(durs) == 1 and len(named_minutes) >= 2 and durs[0][1] == sum(named_minutes):
                total = durs[0][1]
                continue
            if items and items[-1]["duration"] is None:
                items[-1].update(duration=durs[0][0], durationMinutes=durs[0][1], raw=f"{items[-1]['raw']} {seg_raw}".strip())
                continue
        extra = durs[1:]
        if extra and last and len(extra) == 1 and extra[0][1] == sum(named_minutes):
            total, extra = extra[0][1], []
        value, confidence, source = _match_treatment(name, seg_raw) if name else (None, 0.0, "none")
        item = {"raw": seg_raw or None, "nameRaw": name, "value": value, "duration": durs[0][0] if durs else None,
                "durationMinutes": durs[0][1] if durs else None, "confidence": confidence, "source": source}
        review = value is None or confidence < REVIEW_BELOW or item["duration"] is None
        if extra:
            review = True
            warnings.append(f"{name or seg_raw}: more than one duration ({', '.join(d[0] for d in durs)})")
        if durs and durs[0][2]:
            warnings.append(f"{name}: duration '{durs[0][0]}' has no unit; read as {durs[0][1]} min")
        allowed = _allowed_durations(value) if value else []
        if allowed and item["durationMinutes"] is not None and item["durationMinutes"] not in allowed:
            review = True
            confidence = min(confidence, 0.6)
            warnings.append(f"{value}: {item['durationMinutes']} min is not an allowed duration ({', '.join(str(a) for a in allowed)})")
        item["confidence"], item["needsReview"] = round(float(confidence), 3), bool(review)
        items.append(item)
    for item in items:  # re-run for items whose duration was attached late (orphan durations)
        if item["value"] and item["durationMinutes"] is not None:
            allowed = _allowed_durations(item["value"])
            if allowed and item["durationMinutes"] not in allowed and not item["needsReview"]:
                item["needsReview"], item["confidence"] = True, min(item["confidence"], 0.6)
        elif item["duration"] is None:
            item["needsReview"] = True
    ordered = [{k: item[k] for k in ("raw", "value", "confidence", "source", "needsReview", "nameRaw", "duration", "durationMinutes")}
               for item in items]
    return ordered, durations_all, warnings, total


def legacy_treatment(raw, items, durations):
    return {"raw": raw, "durations": durations, "items": items, "needsReview": (not raw) or not items or any(i["needsReview"] for i in items)}


# ---------------------------------------------------------------- CUSTOMER INFORMATION

_CUSTOMER_LABELS = re.compile(
    r"(?P<hotelName>hotel\s*name|hotel|酒店|โรงแรม)|(?P<nationality>nationality|国籍|國籍|สัญชาติ)|(?P<name>(?<!hotel )(?<!hotel)name|姓名|ชื่อ)",
    re.I)
_PLACEHOLDERS = {"", "-", "--", "—", "n/a", "na", "none", "null", "nil", "empty", "(empty)", "[empty]", "blank", "(blank)", "[blank]",
                 "ไม่มี", "无", "空", "..."}
CUSTOMER_FIELDS = ("name", "nationality", "hotelName")


def _clean_value(text):
    for line in text.replace("|", "\n").splitlines():
        value = re.sub(r"\s+", " ", line).strip(" \t:：-–—*#>•\"'()[]{}")
        if value.lower() not in _PLACEHOLDERS:
            return value
    return None


def parse_customer_text(text, expected=CUSTOMER_FIELDS):
    """Customer transcription -> ({field: value|None}, used_fallback). `expected` = fields that have handwriting."""
    text = _clean_model_text(text)
    found, matches = {}, list(_CUSTOMER_LABELS.finditer(text))
    for i, m in enumerate(matches):
        key = m.lastgroup
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        value = _clean_value(text[m.end():end])
        if value and not found.get(key):
            found[key] = value
    if matches:
        return {k: found.get(k) for k in CUSTOMER_FIELDS}, False
    lines = [v for v in (_clean_value(line) for line in text.splitlines()) if v]
    if lines and len(lines) == len(expected):  # unlabeled answer: one line per written field, in form order
        return {k: (lines[expected.index(k)] if k in expected else None) for k in CUSTOMER_FIELDS}, True
    return {k: None for k in CUSTOMER_FIELDS}, bool(lines)


def normalize_free_text(raw, fallback):
    suspicious = len(raw) > 80 or not re.search(r"[^\W\d_]", raw)
    return field(raw, raw, 0.5 if (fallback or suspicious) else 0.8, "ocr", fallback or suspicious)


def normalize_nationality(raw, fallback=False):
    entry, score, _ = _best(raw, master().get("nationalities", []), "value")
    if entry and score >= 0.8:
        return field(raw, entry["value"], score, "master-fuzzy", fallback or score < 0.9)
    return field(raw, raw, 0.5, "ocr", True)
