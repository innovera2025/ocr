"""Text normalization: master data (master_data.json), verified memory (corrections.jsonl), parsing of the model's
STAFF ONLY / CUSTOMER INFORMATION transcriptions into schema-v3 fields."""

import datetime
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
    """Re-parses a file only when its (path, mtime_ns, size) changes. When a changed file does not load (e.g. a typo in
    a hand-edited master_data.json), the last good value keeps being served and `error` says why; only a file that has
    never loaded raises."""

    def __init__(self, loader):
        self._loader, self._lock, self._key, self._value, self._loaded, self.error = loader, threading.Lock(), None, None, False, None

    def get(self, path):
        try:
            st = path.stat()
            key = (str(path), st.st_mtime_ns, st.st_size)
        except FileNotFoundError:
            key = (str(path), None, None)
        with self._lock:
            if key != self._key:
                self._key = key  # a broken file is parsed once, not on every lookup
                try:
                    self._value, self._loaded, self.error = self._loader(path if key[1] is not None else None), True, None
                except Exception as error:  # keep the last good value
                    self.error = error
            if not self._loaded:
                raise self.error.with_traceback(None)
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
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"master data {path}: must be a JSON object")
    for section, name_key in (("treatments", "name"), ("therapists", "name"), ("nationalities", "value"), ("branches", "name")):
        if data.get(section) is None:  # a missing section is an empty master list, as every lookup reads it
            data[section] = []
        entries = data[section]
        if not isinstance(entries, list) or not all(
                isinstance(e, dict) and isinstance(e.get(name_key), str) and isinstance(e.get("aliases", []), list)
                and all(isinstance(a, str) for a in e.get("aliases", [])) for e in entries):
            raise ValueError(f"master data {path}: '{section}' must be a list of objects with a string '{name_key}' and string 'aliases'")
    for entry in data["treatments"]:
        if entry.get("durations") is None:  # like an empty list: no duration restriction
            entry["durations"] = []
        if not isinstance(entry["durations"], list) or not all(isinstance(d, int) for d in entry["durations"]):
            raise ValueError(f"master data {path}: durations of '{entry['name']}' must be a list of whole minutes")
    for entry in data["therapists"]:  # optional "branch" (null = every branch) and "seed" (a suggestion, never confident)
        if not isinstance(entry.get("branch"), (str, type(None))) or not isinstance(entry.get("seed", False), bool):
            raise ValueError(f"master data {path}: therapist '{entry['name']}' needs a string or null 'branch' and a boolean 'seed'")
    return data


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


def master_state():
    """'ok'; 'stale: …' while the last good master data is served because the file on disk does not load; 'error: …'
    when it has never loaded (then every OCR request fails)."""
    try:
        master()
    except Exception as error:
        return f"error: {error}"
    return "ok" if _master_cache.error is None else f"stale: {_master_cache.error}"


def _key(text):
    return re.sub(r"[\s.\-_,:;/()]+", "", text.translate(THAI_DIGITS).lower())


def similarity(a, b):
    return difflib.SequenceMatcher(None, a.lower().strip(), b.lower().strip()).ratio()


# Thai above/below vowels and tone marks: handwriting OCR confuses them (พิพี for พีพี) far more than consonants.
_THAI_MARKS = re.compile(r"[\u0e31\u0e34-\u0e3a\u0e47-\u0e4e]")
SKELETON_WEIGHT = 0.8  # a consonant-only match is a suggestion, always below REVIEW_BELOW


def _skeleton(text):
    return _THAI_MARKS.sub("", _key(text))


def _best(raw, entries, name_key):
    """Best master entry for raw among each entry's name and aliases -> (entry, score, exact)."""
    raw_key, best = _key(raw), (None, 0.0, False)
    raw_skeleton = _skeleton(raw)
    for entry in entries:
        for candidate in [entry[name_key], *entry.get("aliases", [])]:
            if _key(candidate) == raw_key and raw_key:
                return entry, 1.0, candidate != entry[name_key]
            score = similarity(raw, candidate)
            candidate_skeleton = _skeleton(candidate)
            if raw_skeleton and candidate_skeleton and raw_skeleton != raw_key:
                score = max(score, SKELETON_WEIGHT * difflib.SequenceMatcher(None, raw_skeleton, candidate_skeleton).ratio())
            if score > best[1]:
                best = (entry, score, False)
    return best


# ---------------------------------------------------------------- STAFF ONLY

# Printed text of the STAFF ONLY box (heading, its Chinese label, logo) plus every branch name of the masters (the
# branch is printed in the box: "PLOENCHIT", "SUKHUMVIT 33"). The model sometimes appends it to the handwritten
# treatment line ("ไทย 90 นาที+หน้า 1 ชม. PLOENCHIT"), so it is removed inline, not by dropping the line.
_BASE_NOISE = r"staff\s*only|[(（]?\s*仅[^\s)）]*\s*[)）]?|ploenchit|makkha|health\s*&\s*spa"
# Where the STAFF ONLY part starts in a combined (customer + staff) transcription.
_STAFF_START = re.compile(r"staff\s*only|仅[限前]|treatment\s*:?", re.I)
_noise_cache = [None, None]  # (masters object, compiled noise regex)


def _branch_pattern(name):
    """'SUKHUMVIT 33' -> regex that also matches 'Sukhumvit33' / 'SUKHUMVIT  ๓๓' (Thai digits are translated first)."""
    tokens = [re.escape(t) for t in re.split(r"\s+", name.strip()) if t]
    return r"(?<![A-Za-z0-9])" + r"\s*".join(tokens) + r"(?![A-Za-z0-9])"


def _branch_entries():
    try:
        return master().get("branches", [])
    except Exception:  # broken masters: printed-text removal must still work
        return []


def _noise_text():
    data = _branch_entries()
    if _noise_cache[0] is not data:
        names = [c for entry in data for c in (entry["name"], *entry.get("aliases", []))]
        _noise_cache[:] = [data, re.compile("|".join([_BASE_NOISE, *(_branch_pattern(n) for n in names)]), re.I)]
    return _noise_cache[1]


def detect_branch(staff_text):
    """Branch printed in the STAFF ONLY box, matched against the ``branches`` masters in the STAFF text only (a hotel "on
    Sukhumvit 33" in the customer rows must not set it) -> Field. Not found: value null, source "none", needsReview false
    (the branch is informational)."""
    text = (staff_text or "").translate(THAI_DIGITS)
    for entry in _branch_entries():
        for candidate in (entry["name"], *entry.get("aliases", [])):
            m = re.search(_branch_pattern(candidate.translate(THAI_DIGITS)), text, re.I)
            if m:
                return field(m.group(0), entry["name"], 1.0 if candidate == entry["name"] else 0.95, "rule", False)
    return field(None, None, 0.0, "none", False)


def _clean_model_text(text):
    text = re.sub(r"<[^>]+>", "\n", text or "")
    return text.replace("：", ":").replace("**", "").replace("__", "").replace("`", "")


def split_combined_text(text):
    """Combined transcription (header + customer rows above the STAFF crop) -> (customer part, staff part), each stripped.
    Without a staff marker the whole text goes to both parsers; their label sets do not overlap. The header lines stay
    in the customer part (see ``extract_header_fields``)."""
    text = text or ""
    m = _STAFF_START.search(text)
    if not m:
        return text.strip(), text.strip()
    return text[:m.start()].strip(), text[m.start():].strip()


_LABEL_LINE = re.compile(r"^(?:treatment|therapist\s*name|room\s*no\.?)\b", re.I)


def extract_staff_fields(text):
    """(treatment, therapist, room) raw strings from the STAFF ONLY transcription (v2.2 label regexes, hardened). Printed
    box text and branch names are removed first. When the treatment label has no value but unlabeled lines precede it
    ("SUKHUMVIT 33\nไทย 1 ชม.\nTreatment\nRoom No. 5"), those lines are the treatment."""
    text = _noise_text().sub(" ", _clean_model_text(text))
    treatment = therapist = room = None
    # values may be empty: capture up to the next label, never into it ("Treatment\nRoom No. 5" has no treatment)
    m = re.search(r"Treatment\s*:?((?:(?!Therapist\s*Name|Room\s*No).)*)", text, re.I | re.S)
    if m:
        lines = [re.sub(r"\s{2,}", " ", ln.strip(" \t|-")) for ln in m.group(1).splitlines()]
        lines = [ln for ln in lines if ln and not re.fullmatch(r"[\s|:\-]*", ln)]
        treatment = "\n".join(lines) or None
        if treatment is None:
            before = [ln.strip(" \t|:-") for ln in text[:m.start()].splitlines()]
            before = [ln for ln in before if ln and not _LABEL_LINE.match(ln)]
            treatment = before[-1] if before else None
    m = re.search(r"Therapist\s*Name\s*:?((?:(?!Room\s*No).)*)", text, re.I | re.S)
    if m:
        lines = [ln.strip(" \t|:-") for ln in m.group(1).splitlines() if ln.strip(" \t|:-")]
        therapist = lines[0] if lines else None
    m = re.search(r"Room\s*No\.?\s*:?\s*([A-Za-z0-9ก-๙]+)", text, re.I)
    if m:
        room = m.group(1).strip()
    return treatment, therapist, room


_THERAPIST_SPLIT = re.compile(r"\s*(?:/|\+|＋|&|,|，|\sและ\s)\s*")
SEED_CONFIDENCE = 0.8  # a seed name is a suggestion: its confidence stays below the review threshold


def _therapist_entries(branch):
    entries = master().get("therapists", [])
    return [e for e in entries if not e.get("branch") or e["branch"] == branch] if branch else entries


def _match_therapist(raw, branch):
    """One therapist name -> (value, confidence, source, confident)."""
    verified = verified_match("therapist", raw)
    if verified:
        return verified, 1.0, "verified-memory", True
    entry, score, _ = _best(raw, _therapist_entries(branch), "name")
    if not entry or score < 0.65:
        return None, score, "master-fuzzy", False
    if entry.get("seed"):
        return entry["name"], min(score, SEED_CONFIDENCE), "master-fuzzy", False
    return entry["name"], score, "master-fuzzy", score >= REVIEW_BELOW


def normalize_therapist(raw, branch=None):
    """Therapist Field. Master names are matched among the therapists of the page's branch (or of every branch); a match
    to a seed name is only a suggestion. Two therapists ("อิน / ป๊อป", "A + B") give one Field whose value joins the
    names with " / " (an unmatched name is kept as written); it needs review unless every name is a confident match."""
    if not raw:
        return field(raw, None, 0.0, "none", True)
    verified = verified_match("therapist", raw)
    if verified:
        return field(raw, verified, 1.0, "verified-memory", False)
    parts = [p.strip() for p in _THERAPIST_SPLIT.split(raw.strip()) if p.strip(" .")]
    if len(parts) <= 1:
        value, confidence, source, confident = _match_therapist(raw, branch)
        return field(raw, value, confidence, source, not confident)
    matches = [_match_therapist(part, branch) for part in parts]
    value = " / ".join(m[0] or part for m, part in zip(matches, parts, strict=True))
    source = "verified-memory" if all(m[2] == "verified-memory" for m in matches) else "master-fuzzy"
    return field(raw, value, min(m[1] for m in matches), source, not all(m[0] and m[3] for m in matches))


def normalize_room(raw):
    clean = raw.translate(THAI_DIGITS).strip(" .:-") if raw else raw
    ok = bool(clean and clean.isdigit())
    return field(raw, clean if ok else None, 0.95 if ok else 0.0, "ocr", not ok)


# ---------------------------------------------------------------- form header

# "No." (printed form number), DATE / TIME (handwritten). A label counts at the start of a line / table cell or before a
# colon; "Room No." never counts. The echoed Chinese label ("DATE 日期", "TIME 时间") is dropped from the value.
_HEADER_LABELS = re.compile(r"(?P<formNumber>\bno\b\.?|เลขที่)|(?P<date>\bdate\b|日期|วันที่)|(?P<time>\btime\b|时间|時間|เวลา)", re.I)
_HEADER_ECHO = re.compile(r"^[\s:.\-|]*(?:日期|时间|時間|วันที่|เวลา)?[\s:.\-|]*")
HEADER_FIELDS = ("formNumber", "date", "time")
_MONTHS = {m: i + 1 for i, names in enumerate((
    ("jan", "january", "ม.ค.", "มค", "มกราคม"), ("feb", "february", "ก.พ.", "กพ", "กุมภาพันธ์"), ("mar", "march", "มี.ค.", "มีค", "มีนาคม"),
    ("apr", "april", "เม.ย.", "เมย", "เมษายน"), ("may", "พ.ค.", "พค", "พฤษภาคม"), ("jun", "june", "มิ.ย.", "มิย", "มิถุนายน"),
    ("jul", "july", "ก.ค.", "กค", "กรกฎาคม"), ("aug", "august", "ส.ค.", "สค", "สิงหาคม"), ("sep", "sept", "september", "ก.ย.", "กย", "กันยายน"),
    ("oct", "october", "ต.ค.", "ตค", "ตุลาคม"), ("nov", "november", "พ.ย.", "พย", "พฤศจิกายน"), ("dec", "december", "ธ.ค.", "ธค", "ธันวาคม"),
)) for m in names}


def extract_header_fields(text):
    """Header values from the customer part of a combined answer -> ({formNumber, date, time: raw|None}, rest of the text
    with the header labels and values removed, for the customer parser)."""
    text = _clean_model_text(text)
    found, spans = {}, []
    matches = [m for m in _HEADER_LABELS.finditer(text) if _is_header_label(text, m)]
    for i, m in enumerate(matches):
        line_end = text.find("\n", m.end())
        end = len(text) if line_end < 0 else line_end
        if i + 1 < len(matches) and matches[i + 1].start() < end:
            end = matches[i + 1].start()
        value = _HEADER_ECHO.sub("", text[m.end():end]).strip(" \t|:-*")
        spans.append((m.start(), end))
        if value and value.lower() not in _PLACEHOLDERS and not found.get(m.lastgroup):
            found[m.lastgroup] = value
    rest, pos = [], 0
    for start, end in spans:
        rest.append(text[pos:start])
        pos = end
    rest.append(text[pos:])
    return {k: found.get(k) for k in HEADER_FIELDS}, "".join(rest).strip()


def _is_header_label(text, m):
    before, after = text[:m.start()], text[m.end():]
    if m.lastgroup == "formNumber" and re.search(r"room\s*$", before, re.I):
        return False
    if m.lastgroup == "formNumber" and not re.match(r"[\s.:]*\d", after.translate(THAI_DIGITS)):
        return False  # "No." without a number is not the printed form number
    return bool(re.search(r"(?:^|[\n|])[^\S\n]*$", before) or re.match(r"[^\S\n]*[:：]", after)
                or m.group(0) in ("日期", "时间", "時間"))


def _year(text):
    year = int(text)
    if year < 100:
        year += 2500 if year >= 50 else 2000  # two-digit years >= 50 are Buddhist era (69 = 2569)
    return year - 543 if year >= 2400 else year


def parse_date(raw):
    """Handwritten date -> ISO 'YYYY-MM-DD', or None when day, month or year is missing or impossible. Day before month
    ('16/08/26', '16 Aug 2026', '16.8.69' in the Buddhist era); 'Aug 16 2026' also works."""
    if not raw:
        return None
    text = raw.translate(THAI_DIGITS).lower()
    words = re.findall(r"[a-zก-๙.]+", text)
    month = next((_MONTHS[w.strip(".")] if w.strip(".") in _MONTHS else _MONTHS.get(w) for w in words
                  if w.strip(".") in _MONTHS or w in _MONTHS), None)
    numbers = [int(n) for n in re.findall(r"\d+", text)]
    if month is not None:
        if len(numbers) < 2:
            return None
        day, year = (numbers[0], numbers[1]) if numbers[0] <= 31 else (numbers[1], numbers[0])
    else:
        if len(numbers) != 3:
            return None
        day, month, year = numbers if numbers[0] <= 31 else numbers[::-1]  # year first: 2026-08-16
        if month > 12 >= day:  # month/day/year
            day, month = month, day
    year = _year(year)
    try:
        return datetime.date(year, month, day).isoformat() if 2000 <= year <= 2100 else None
    except ValueError:
        return None


def parse_time(raw):
    """Handwritten clock time -> 'HH:MM' (24 h), or None ('14:30', '14.30 น.', '2.30 pm', '1430')."""
    if not raw:
        return None
    text = raw.translate(THAI_DIGITS).lower().strip()
    m = re.fullmatch(r"(\d{1,2})\s*[:.;,h ]\s*(\d{2})\s*(am|pm|a\.m\.|p\.m\.|น\.?|นาฬิกา)?\.?", text) or \
        re.fullmatch(r"(\d{2})(\d{2})\s*(น\.?)?", text) or re.fullmatch(r"(\d{1,2})\s*()(am|pm)", text)
    if not m:
        return None
    hour, minute, suffix = int(m.group(1)), int(m.group(2) or 0), (m.group(3) or "")
    if suffix.startswith("p") and hour < 12:
        hour += 12
    if suffix.startswith("a") and hour == 12:
        hour = 0
    return f"{hour:02d}:{minute:02d}" if hour < 24 and minute < 60 else None


def header_fields(raw, ink_states, read=True):
    """Header Fields. `raw` from ``extract_header_fields``; `ink_states` = {date, time: empty|uncertain|present} from the
    handwriting boxes; `read` False when no model call read the header (OCR_SECTION_MODE=separate)."""
    number = raw.get("formNumber")
    digits = re.sub(r"\D", "", number.translate(THAI_DIGITS)) if number else ""
    if 4 <= len(digits) <= 7:
        out = {"formNumber": field(number, digits, 0.9, "ocr", False)}
    else:
        out = {"formNumber": field(number, None, 0.0, "ocr" if number else "none", read)}
    for key, parse in (("date", parse_date), ("time", parse_time)):
        value, state = raw.get(key), ink_states.get(key, "present")
        if state == "empty":
            out[key] = field(None, None, 0.95, "ink-mark", False)
        elif not value:
            out[key] = field(None, None, 0.0, "none", read or state == "present")
        else:
            parsed = parse(value)
            out[key] = field(value, parsed, 0.8 if parsed else 0.4, "ocr", parsed is None)
    return out


# ---------------------------------------------------------------- treatments

_HOUR = r"(?:ชั่วโมง|ชัวโมง|ช\.ม\.|ชม\.?|ซม\.?|hours?|hrs?\.?|h(?![a-z])|ช\.?(?![ก-๙]))"
_MIN = r"(?:นาที|นท\.?|น\.|minutes?|mins?\.?|m(?![a-z]))"
# "1:30" (hours:minutes), or a number with an hour unit (+ "ครึ่ง" and/or minutes, whose unit may be left out:
# "1 ชม. 30", "1h30"), or a number with a minute unit. Unlabelled minutes after an hour unit need two digits
# (10-59): the real model reads "1 ชม. 2.5 ชม." as "1 ชม.2", which must stay 60 min plus a flagged leftover "2".
# A lone "ช" right after a number is a truncated "ชม." ("= 2 ช").
DURATION_RE = re.compile(
    rf"(?<![\d:])(?P<hh>[0-4]):(?P<mm>[0-5]\d)(?![\d:])"
    rf"|(?P<num>\d+(?:[.,]\d+)?)\s*(?:(?P<hour>{_HOUR})(?:\s*(?P<half>ครึ่ง))?"
    rf"(?:\s*(?P<num2>[1-5]\d|\d(?=\s*{_MIN}))(?![\d.,:])(?!\s*{_HOUR})(?:\s*{_MIN})?)?|(?P<min>{_MIN}))", re.I)
BARE_NUMBER_RE = re.compile(r"(?<!\d)(?<!\d[.,])(\d+(?:\.\d+)?)(?!\d|\.\d)")  # "ชม.2": a dot after a unit is not a decimal point
SEPARATOR_RE = re.compile(r"\s*(?:\+|＋|/|\n|;|、|，|(?<!\d),|,(?!\d)|\s&\s|\sและ\s)\s*")
# Written total: "ไทย + เท้า 30 = 90", "สครับ + ออย = 2 ชม.", "ไทย + ประคบ > 2 ชม", "... รวม 90 นาที".
TOTAL_MARK_RE = re.compile(r"\s*(?:=+>?|＝|->|→|>|รวม|\btotal\b)\s*", re.I)
# Leading guest count: "4 ไทย 1 ชม." (4 guests, one hour each), "2 คน ออย 90 นาที".
GUESTS_RE = re.compile(r"^\s*(?P<n>[1-9]|1\d|20)\s*(?:คน|ท่าน|pax|persons?|guests?|x|×)?\s+(?=[^\W\d_])", re.I)


def _minutes(match):
    if match.group("hh"):
        return int(match.group("hh")) * 60 + int(match.group("mm"))
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
    """Split one segment into (name, raw, [(duration_text, minutes, bare)], leftover numbers) groups. Leftover numbers are
    numbers that no duration (and no bare-number fallback) used: they are reported instead of silently dropped."""
    groups, pos, used = [], 0, []
    for m in DURATION_RE.finditer(segment):
        name = _clean_name(segment[pos:m.start()])
        if name or not groups:
            groups.append([name, pos, m.end(), []])
        groups[-1][2] = m.end()
        groups[-1][3].append((m.group(0).strip(), _minutes(m), False))
        used.append(m.span())
        pos = m.end()
    tail = segment[pos:]
    tail_name = _clean_name(tail)
    if tail_name:
        groups.append([tail_name, pos, len(segment), []])
    elif groups and BARE_NUMBER_RE.search(tail):  # "ไทย 90 นาที 15": the stray number belongs to the last item
        groups[-1][2] = len(segment)
    elif BARE_NUMBER_RE.search(tail):  # a segment of bare numbers only ("ไทย 90 นาที + 30"): reported, not dropped
        groups.append([None, pos, len(segment), []])
    for group in groups:  # "ไทย 90" -> bare number as duration
        if group[0] and not group[3]:
            bare = BARE_NUMBER_RE.search(segment, group[1], group[2])
            if bare:
                number = float(bare.group(1))
                minutes = int(round(number * 60)) if number <= 4 else int(round(number))
                group[3].append((bare.group(1), minutes, True))
                used.append(bare.span())
    for group in groups:
        group.append([n.group(1) for n in BARE_NUMBER_RE.finditer(segment, group[1], group[2])
                      if not any(start <= n.start() < end for start, end in used)])
    merged = []
    for group in groups:  # "90 นาที ไทย": a leading duration belongs to the following name
        if merged and merged[-1][0] is None and group[0] and not group[3]:
            group[3], group[1], group[4] = merged[-1][3], merged[-1][1], merged[-1][4] + group[4]
            merged[-1] = group
        else:
            merged.append(group)
    return [(g[0], segment[g[1]:g[2]].strip(), g[3], g[4]) for g in merged]


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


def _single_duration(text):
    """Exactly one duration (with or without a unit) and nothing else -> (minutes, duration text, has unit) or None."""
    text = text.strip().rstrip(".")
    matches = list(DURATION_RE.finditer(text))
    if len(matches) == 1 and not re.search(r"[^\W_]", text[:matches[0].start()] + text[matches[0].end():]):
        return _minutes(matches[0]), matches[0].group(0).strip(), True
    bare = BARE_NUMBER_RE.fullmatch(text)
    if bare:
        number = float(bare.group(1))
        return (int(round(number * 60)) if number <= 4 else int(round(number))), bare.group(1), False
    return None


def _split_total(text):
    """'A + B 30 = 90' -> ('A + B 30', 90, '90', has_unit=False); no total -> (text, None, None, False). The last total
    marker must be followed by one duration only."""
    for m in reversed(list(TOTAL_MARK_RE.finditer(text))):
        head, tail = text[:m.start()], text[m.end():]
        if not re.search(r"[^\W\d_]", head):
            continue  # nothing named before the marker
        total = _single_duration(tail)
        if total:
            return (head, *total)
    return text, None, None, False


def _split_guests(text, has_total=False):
    """Leading guest count, only when the line has a duration of its own after it or a written total ("4 ไทย 1 ชม.",
    "4 ไทย + เท้า 30 = 90"): -> (text, guests). A lone "2 ไทย" stays a duration (v3.0 reading)."""
    m = GUESTS_RE.match(text)
    if not m or DURATION_RE.match(text, m.start("n")):
        return text, None
    if not (has_total or DURATION_RE.search(text, m.end()) or BARE_NUMBER_RE.search(text, m.end())):
        return text, None
    return text[m.end():], int(m.group("n"))


def parse_treatments(raw):
    """Treatment transcription -> (items: [TreatmentField], all duration strings, warnings, total minutes|None).

    Totals: a written total ("= 90", "> 2 ชม", "รวม 2 ชม.") becomes the total; when exactly one treatment has no
    duration of its own, its duration is derived from the total ("ไทย + เท้า 30 = 90" -> ไทย 60); a total that does not
    add up flags every item. Without a total marker, a trailing duration equal to the sum is the total, and a duration
    written only after the last of several treatments ("ออย + หน้า 2 ชม") is read as their total. A leading guest count
    ("4 ไทย 1 ชม.") goes to ``guests`` of every item."""
    if not raw:
        return [], [], [], None
    text = raw.translate(THAI_DIGITS)
    text, written_total, total_text, total_unit = _split_total(text)
    text, guests = _split_guests(text, written_total is not None)
    groups = []
    for segment in SEPARATOR_RE.split(text):
        if segment.strip():
            groups.extend(_segment_groups(segment))
    durations_all = [d[0] for _, _, ds, _ in groups for d in ds if not d[2]] + ([total_text] if total_unit else [])
    total, warnings, items, review_next = None, [], [], False
    named_minutes = [ds[0][1] for name, _, ds, _ in groups if name and ds]
    for index, (name, seg_raw, durs, leftover) in enumerate(groups):
        last = index == len(groups) - 1
        if leftover:
            warnings.append(f"{name or seg_raw}: number(s) {', '.join(leftover)} not read as a duration")
        if name is None and not durs:  # bare numbers only: the previous item (else the next one) needs review
            if items:
                items[-1]["_review"].add("leftover")
            else:
                review_next = True
            continue
        if name is None:
            if written_total is None and last and len(durs) == 1 and len(named_minutes) >= 2 and durs[0][1] == sum(named_minutes):
                total = durs[0][1]
                continue
            if items and items[-1]["duration"] is None:
                items[-1].update(duration=durs[0][0], durationMinutes=durs[0][1], raw=f"{items[-1]['raw']} {seg_raw}".strip(),
                                 _bare=durs[0][2])
                if leftover:
                    items[-1]["_review"].add("leftover")
                continue
        extra = durs[1:]
        if extra and written_total is None and last and len(extra) == 1 and extra[0][1] == sum(named_minutes):
            total, extra = extra[0][1], []
        value, confidence, source = _match_treatment(name, seg_raw) if name else (None, 0.0, "none")
        item = {"raw": seg_raw or None, "nameRaw": name, "value": value, "duration": durs[0][0] if durs else None,
                "durationMinutes": durs[0][1] if durs else None, "confidence": confidence, "source": source,
                "guests": guests, "_bare": bool(durs and durs[0][2]), "_review": set()}
        if leftover:
            item["_review"].add("leftover")
        if review_next:
            item["_review"].add("leftover")
            review_next = False
        if extra:
            item["_review"].add("extra")
            warnings.append(f"{name or seg_raw}: more than one duration ({', '.join(d[0] for d in durs)})")
        if durs and durs[0][2]:
            warnings.append(f"{name}: duration '{durs[0][0]}' has no unit; read as {durs[0][1]} min")
        items.append(item)
    named = [item for item in items if item["nameRaw"]]
    if written_total is not None:
        total = written_total
        missing = [item for item in named if item["durationMinutes"] is None]
        known = sum(item["durationMinutes"] for item in named if item["durationMinutes"] is not None)
        if len(missing) == 1:
            derived = total - known
            if derived > 0:
                missing[0].update(duration=f"{derived} นาที", durationMinutes=derived)
                warnings.append(f"{missing[0]['nameRaw']}: {derived} min derived from the written total ({total} min)")
                if any(item["_review"] for item in named if item is not missing[0]):
                    missing[0]["_review"].add("derived")  # derived from a duration that itself needs review
            else:
                for item in named:
                    item["_review"].add("total")
                warnings.append(f"written total {total} min is not more than the other durations ({known} min)")
        elif not missing and named and known != total:
            for item in named:
                item["_review"].add("total")
            warnings.append(f"written total {total} min differs from the sum of the durations ({known} min)")
        elif len(missing) > 1:
            warnings.append(f"written total {total} min covers {len(missing)} treatments without their own duration")
    elif total is None and len(named) >= 2 and named[-1]["durationMinutes"] is not None and not named[-1]["_bare"] \
            and all(item["durationMinutes"] is None for item in named[:-1]):
        last_item = named[-1]
        total = last_item["durationMinutes"]
        last_item.update(duration=None, durationMinutes=None)
        warnings.append(f"{total} min written after the last of {len(named)} treatments is read as their total")
    for item in items:
        reasons = item.pop("_review")
        item.pop("_bare")
        value = item["value"]
        allowed = _allowed_durations(value) if value else []
        if allowed and item["durationMinutes"] is not None and item["durationMinutes"] not in allowed:
            reasons.add("duration")
            item["confidence"] = min(item["confidence"], 0.6)
            warnings.append(f"{value}: {item['durationMinutes']} min is not an allowed duration ({', '.join(str(a) for a in allowed)})")
        review = bool(reasons) or value is None or item["confidence"] < REVIEW_BELOW or item["durationMinutes"] is None
        item["confidence"], item["needsReview"] = round(float(item["confidence"]), 3), review
    ordered = [{k: item[k] for k in ("raw", "value", "confidence", "source", "needsReview", "nameRaw", "duration", "durationMinutes", "guests")}
               for item in items]
    return ordered, durations_all, warnings, total


def legacy_treatment(raw, items, durations):
    return {"raw": raw, "durations": durations, "items": items, "needsReview": (not raw) or not items or any(i["needsReview"] for i in items)}


# ---------------------------------------------------------------- CUSTOMER INFORMATION

_CUSTOMER_LABELS = re.compile(
    r"(?P<hotelName>\bhotel\s*name\b|\bhotel\b|酒店|โรงแรม)|(?P<nationality>\bnationality\b|国籍|國籍|สัญชาติ)|(?P<name>\bname\b|姓名|ชื่อ)",
    re.I)
_CJK_LABELS = ("姓名", "国籍", "國籍", "酒店")
# The printed labels are bilingual ("Name 姓名"); a model may echo the second one in brackets ("Name (姓名): Chun") or
# number its lines ("1. Name Chun"). Both are removed before label matching so they never end up in a value.
_ECHOED_LABEL = re.compile(r"[(\[（【][^\S\n]*(?:姓名|国籍|國籍|酒店|ชื่อ|สัญชาติ|โรงแรม)[^\S\n]*[)\]）】]")
_LIST_MARKER = re.compile(r"(?m)^[^\S\n]*(?:\d+[.)]|[-*•])[^\S\n]+")


def _is_label(text, m):
    """A label word only counts at the start of a line / table cell or right before a colon, so "Kaname", "Hotel Nikko"
    or "Anna Hotelling" inside a value never start a new field. Chinese labels also count as separate words
    ("姓名 Chun 国籍 Chinese 酒店 Hilton"), but not inside a name ("曼谷洲际酒店")."""
    before, after = text[:m.start()], text[m.end():]
    if re.search(r"(?:^|[\n|])[^\S\n]*$", before) or re.match(r"[^\S\n]*[:：]", after):
        return True
    return m.group(0) in _CJK_LABELS and (not before or before[-1].isspace()) and (not after or after[0].isspace())


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
    text = _LIST_MARKER.sub("", _ECHOED_LABEL.sub(" ", _clean_model_text(text)))
    found, matches = {}, [m for m in _CUSTOMER_LABELS.finditer(text) if _is_label(text, m)]
    for i, m in enumerate(matches):
        key = m.lastgroup
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        value = _clean_value(text[m.end():end])
        if value and not found.get(key):
            found[key] = value
    if matches and not found.get("name") and "name" in expected and (matches[0].lastgroup != "name" or _clean_value(text[:matches[0].start()])):
        # The Name row is the top row of the crop: real output sometimes drops only its label
        # ("Cynthia De La Cruz-Eikanter\nNationality:\nHotel Name:"), so text before the first label is the name.
        found["name"] = _clean_value(text[:matches[0].start()])
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
