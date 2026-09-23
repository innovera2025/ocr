"""Text normalization: master data (master_data.json), verified memory (corrections.jsonl), cleanup of the model's
answers, parsing of the STAFF ONLY / CUSTOMER INFORMATION / header transcriptions into schema-v3 fields, and the
visual-confusion aliases for misread Thai handwriting."""

import datetime
import difflib
import html
import json
import os
import re
import threading
from pathlib import Path

HERE = Path(__file__).resolve().parent
THAI_DIGITS = str.maketrans("๐๑๒๓๔๕๖๗๘๙", "0123456789")
REVIEW_BELOW = 0.85  # fuzzy master matches below this similarity need review (v2.2 rule)
VISUAL_ALIAS_CONFIDENCE = 0.6  # a value read through a visual alias is at most this confident and always needs review

# W3a (accuracy-learning-plan.md §3 W3a, §2.1, §2.5). `POST /v1/ocr/confirm` is AUDIT-ONLY: corrections.jsonl is still
# written, still parseable and still the audit trail of what staff confirmed, but nothing read out of it may reach a
# value, a confidence or a review flag. The v2.2 rule it replaces was `(field, exact raw string) -> value at confidence
# 1.0, needsReview false`, last row wins (`_load_verified`): a model reading is not an identity, so the key collides and
# the last writer decides. Measured on the 95 labelled pages, page-ordered, with staff confirming every page to its
# label: therapist wrong-and-unflagged 0 -> 8 and treatment names 5 -> 6 CAUSED by the memory (§1D).
#
# This switch is a module constant and deliberately NOT an environment variable: no deployment, env file or compose
# override can turn the raw->value memory back on -- only code can, and only `tools/benchmark.py --learning-loop`
# flips it in-process to keep measuring what W3a removed. The replacement is the voted, tenant-scoped, retirable
# learning store of W3b-W3e, which is NOT built in this step.
VERIFIED_MEMORY_ENABLED = False


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
    data["visualAliases"] = _load_visual_aliases(data.get("visualAliases"), path)
    return data


def _load_visual_aliases(section, path):
    """Optional "visualAliases": {"treatments": [{"reading", "lookalikes"}], "hourUnit": [...], "digitOne": [...]}."""
    section = {} if section is None else section
    if not isinstance(section, dict):
        raise ValueError(f"master data {path}: 'visualAliases' must be an object")
    out = {"treatments": section.get("treatments") or [], "hourUnit": section.get("hourUnit") or [], "digitOne": section.get("digitOne") or []}
    if not isinstance(out["treatments"], list) or not all(
            isinstance(e, dict) and isinstance(e.get("reading"), str) and e["reading"].strip() and isinstance(e.get("lookalikes"), list)
            and all(isinstance(a, str) for a in e["lookalikes"]) for e in out["treatments"]):
        raise ValueError(f"master data {path}: visualAliases.treatments must be a list of objects with a string 'reading' and string 'lookalikes'")
    for key in ("hourUnit", "digitOne"):
        if not isinstance(out[key], list) or not all(isinstance(a, str) for a in out[key]):
            raise ValueError(f"master data {path}: visualAliases.{key} must be a list of strings")
    return out


_verified_cache, _master_cache = _FileCache(_load_verified), _FileCache(_load_master)
_append_lock = threading.Lock()


def verified_match(field_name, raw):
    """The v2.2 raw->value confirmation memory. Always None while `VERIFIED_MEMORY_ENABLED` is False (W3a): the file is
    still appended to and still readable, it simply no longer decides anything a reader returns."""
    if not VERIFIED_MEMORY_ENABLED or not raw:
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


# Real Typhoon answers (probe on 16 real pages, 2026-09-22) wrap the fields in HTML tables
# (<table><tr><td>Treatment</td><td>X</td>...), escape "&" as "&amp;", add notes such as "(handwritten)", "(Treatments)",
# "(circled)" and echo the printed Chinese labels (治療 / 疗法 / 理疗师名称 / 房号 ...).
_TABLE_CELL_JOIN = re.compile(r"</t[dh]\s*>\s*<t[dh](?:\s[^>]*)?>", re.I)
_BLOCK_TAG = re.compile(r"</?(?:table|thead|tbody|tfoot|tr|p|div|li|ul|ol|h[1-6])(?:\s[^>]*)?/?>|<br\s*/?>", re.I)
_INLINE_TAG = re.compile(r"</?(?:b|i|u|s|em|strong|span|sup|sub|font|mark|small|del|ins|code)(?:\s[^>]*)?>", re.I)
_ANY_TAG = re.compile(r"</?[A-Za-z][^<>]*>")
# A bracketed note CONTAINING a note word; "(5)" (a circled room number) or "(2 คน)" (guests) are values, not notes.
# W1d: the note word no longer has to be the first word, because the model also writes whole sentences about the page
# ("(with a handwritten note 'total')"), and such a sentence became a treatment item.
# Doubt notes ("(unclear)", "(illegible)", "(crossed out)") stay: they are the model's own doubt about the reading next to
# them, and left in the text they keep that reading from matching a master confidently (it is flagged, as in v3.1).
_MODEL_NOTE = re.compile(r"[(（\[](?![^()（）\[\]\n]*(?:unclear|illegible|crossed[\s-]*out))"
                         r"[^()（）\[\]\n]*?(?:(?:hand[\s-]*written|handwriting|treatments?|therapists?|circled|signature)(?![A-Za-z])"
                         r"|ลายมือ|เขียนด้วยลายมือ)[^()（）\[\]\n]*[)）\]]", re.I)
_CJK_LABEL_ECHO = re.compile(r"治療師名稱|治疗师名称|理疗师名称|理療師名稱|理疗师名|治療師|治疗师|理疗师|理療師|房間號|房间号|房號|房号|治療|治疗|疗法|療法")


def clean_model_text(text):
    """A model answer -> plain text for the parsers: HTML entities decoded, table cells as "Label: value" lines, tags
    removed, parenthetical model notes ("(handwritten)", "(hand-written)", "(Treatments)", "(ลายมือ)" ...) and echoed Chinese
    label words (治療 治疗 疗法 療法, therapist / room labels) dropped, full-width colons and Markdown emphasis normalised.
    Idempotent in practice; the raw answer stays in the response evidence."""
    text = html.unescape(text or "")
    text = _TABLE_CELL_JOIN.sub(": ", text)
    text = _BLOCK_TAG.sub("\n", text)
    text = _INLINE_TAG.sub("", text)
    text = _ANY_TAG.sub("\n", text)
    text = _MODEL_NOTE.sub(" ", text)
    text = _CJK_LABEL_ECHO.sub(" ", text)
    return text.replace("：", ":").replace("**", "").replace("__", "").replace("`", "")


_clean_model_text = clean_model_text


def split_combined_text(text):
    """Combined transcription (header + customer rows above the STAFF crop) -> (customer part, staff part), each cleaned and
    stripped. Without a staff marker the whole text goes to both parsers; their label sets do not overlap. The header lines
    stay in the customer part (see ``extract_header_fields``)."""
    text = clean_model_text(text)
    m = _STAFF_START.search(text)
    if not m:
        return text.strip(), text.strip()
    return text[:m.start()].strip(), text[m.start():].strip()


_LABEL_LINE = re.compile(r"^(?:treatments?|therapist\s*name|room\s*no\.?)\b", re.I)
# The form's printed tick boxes and the ticks drawn in them, as a model transcribes them.
_BOX_GLYPH = r"[☐-☒■-□▪-▫◻-◾✓✔✗✘❏-❒⬛⬜]"


def extract_staff_fields(text):
    """(treatment, therapist, room) raw strings from the STAFF ONLY transcription (v2.2 label regexes, hardened). Printed
    box text and branch names are removed first. When the treatment label has no value but unlabeled lines precede it
    ("SUKHUMVIT 33\nไทย 1 ชม.\nTreatment\nRoom No. 5"), those lines are the treatment."""
    text = _noise_text().sub(" ", _clean_model_text(text))
    treatment = therapist = room = None
    # values may be empty: capture up to the next label, never into it ("Treatment\nRoom No. 5" has no treatment)
    m = re.search(r"Treatments?\s*:?((?:(?!Therapist\s*Name|Room\s*No).)*)", text, re.I | re.S)
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
    # "(5)": a circled room number. The value may be on the next line ("Room No.\n11"), but a label is never the value
    # ("Room No. 房号\nTreatment ...": its echoed Chinese label was dropped): the search moves on to the next "Room No.".
    # W1d: the printed tick box in front of the number is transcribed as a box glyph ("Room No. ☐ 11") and used to
    # swallow the whole answer -- the number after it is still the room number.
    m = re.search(rf"Room\s*No\.?\s*:?\s*(?:{_BOX_GLYPH}\s*)*[(（\[]?\s*"
                  r"(?!(?:treatments?|therapist|room|staff|no|name|date|time)\b)([A-Za-z0-9ก-๙]+)", text, re.I)
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


def _header_value_line(key, line):
    """A whole line that is only a value of header field `key` (written under its empty label)."""
    line = line.strip(" \t|:-*")
    if not line or _CUSTOMER_LABELS.search(line):
        return False
    if key == "formNumber":
        return bool(re.fullmatch(r"#?\s*[0-9Oo]{4,7}", line.translate(THAI_DIGITS)))
    return (parse_date if key == "date" else parse_time)(line) is not None


def extract_header_fields(text):
    """Header values from the customer part of a combined answer -> ({formNumber, date, time: raw|None}, rest of the text
    with the header labels and values removed, for the customer parser). Every header-label line is removed whatever its
    value (empty, "N/A", a misread number), so none of it can become a customer value; a label with nothing after it
    takes the next line as its value when that line is exactly such a value ("Date:\n16 Aug 2026")."""
    text = _clean_model_text(text)
    found, spans = {}, []
    matches = [m for m in _HEADER_LABELS.finditer(text) if _is_header_label(text, m)]
    for i, m in enumerate(matches):
        line_end = text.find("\n", m.end())
        end = len(text) if line_end < 0 else line_end
        if i + 1 < len(matches) and matches[i + 1].start() < end:
            end = matches[i + 1].start()
        value = _HEADER_ECHO.sub("", text[m.end():end]).strip(" \t|:-*")
        if (value and m.lastgroup in ("date", "time") and re.search(r"[^\W\d_]{3,}", value)
                and (parse_date if m.lastgroup == "date" else parse_time)(value) is None):
            # Words that are no date/time belong to the next field the model wrote on the same line
            # ("TIME时间: Michael Lee Nationality…"): leave them in the text for the customer parser.
            value, end = "", m.end()
        if value and m.lastgroup == "formNumber":
            number = re.match(r"[#\s]*([0-9Oo]{4,7})(?![0-9])", value.translate(THAI_DIGITS))
            if number:  # "07927 TIME": the unlabelled TIME word the model wrote after the number is not part of it
                value = number.group(1)
        if not value and end == line_end:
            next_end = text.find("\n", end + 1)
            next_end = len(text) if next_end < 0 else next_end
            if not (i + 1 < len(matches) and matches[i + 1].start() < next_end) and _header_value_line(m.lastgroup, text[end + 1:next_end]):
                value, end = text[end + 1:next_end].strip(" \t|:-*"), next_end
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
    line_start = bool(re.search(r"(?:^|[\n|])[^\S\n]*$", before))
    if m.lastgroup == "formNumber" and re.search(r"room\s*$", before, re.I):
        return False
    if m.lastgroup == "formNumber" and re.match(r"[^\S\n]*[.:：]?[^\S\n]*\d{4,7}(?!\d)", after.translate(THAI_DIGITS)):
        # The printed form number: the model often writes the whole header on one line ("DATE 日期 No. 07927 TIME 时间"),
        # so "No." followed by a 4-7 digit number is the label wherever it stands (real answers, 2026-09-22).
        return True
    if m.lastgroup == "formNumber" and not re.match(r"[\s.:]*\d", after.translate(THAI_DIGITS)):
        # Without a number it is still the printed label when it starts a line as "No." / "No:" / "เลขที่" (its number
        # unread, "N/A" or misread as "O7832"); a plain word "no" never is.
        return line_start and (m.group(0).endswith(".") or m.group(0) == "เลขที่" or bool(re.match(r"[^\S\n]*[:：]", after)))
    return bool(line_start or re.match(r"[^\S\n]*[:：]", after) or m.group(0) in ("日期", "时间", "時間"))


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
    core = re.sub(r"^\s*(?:no\b\.?|เลขที่)\s*[.:]?\s*", "", number.translate(THAI_DIGITS), flags=re.I) if number else ""
    lettered = bool(re.search(r"[^\W\d_]", core))  # "O7832": the printed 0 read as a letter
    digits = re.sub(r"\D", "", core.translate(str.maketrans("Oo", "00")))
    if 4 <= len(digits) <= 7:
        out = {"formNumber": field(number, digits, 0.5 if lettered else 0.9, "ocr", lettered)}
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
            doubtful = parsed is not None and key == "time" and _time_looks_like_duration(value, parsed)
            out[key] = field(value, parsed, 0.5 if doubtful else 0.8 if parsed else 0.4, "ocr", parsed is None or doubtful)
    return out


def _time_looks_like_duration(raw, parsed):
    """The real TIME boxes hold session lengths ('60', '1ช', '60 mins'): a parsed time with no am/pm/น. before 09:00 ('1:30',
    '2.00', or 14:30 written '2.30') or written with an hour unit ('1h30') is as likely a duration: review it."""
    text = raw.translate(THAI_DIGITS).lower().strip()
    suffixed = re.search(r"(?:am|pm|a\.m\.|p\.m\.|น\.?|นาฬิกา)\s*\.?$", text)
    return (not suffixed and int(parsed[:2]) < 9) or bool(re.search(r"\d\s*(?:h(?![a-z])|hrs?\b|hours?\b|ชม|ชั่วโมง)", text))


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
# W1d: a trailing bracketed Thai restatement of the line just read ("เท้า + ออย 2 ชม. (ไทยหน้า)") -- the model's own
# second transcription, not a treatment. Digits (a guest count "(2 คน)", a circled number "(5)") and anything shorter than
# three Thai consonants (the unit "( ชม. )") are not restatements and stay.
_THAI_RESTATEMENT = re.compile(r"\s*[(（\[][^\S\n]*(?P<body>[฀-๿\s]+)[)）\]]\s*$")


def _strip_restatement(text):
    m = _THAI_RESTATEMENT.search(text)
    return text[:m.start()] if m and len(re.findall(r"[ก-ฮ]", m.group("body"))) >= 3 else text


# Trailing guest count: "ไทย 90 นาที 2 ท่าน", "(2 คน)", "= 2 ท่าน", "x 2" / "× 2". A bare trailing number stays a duration.
TRAILING_GUESTS_RE = re.compile(r"\s*(?:(?:[=x×]\s*)?[(（]?\s*(?P<n>[1-9]|1\d|20)\s*(?:คน|ท่าน|pax|persons?|guests?)\s*[)）]?"
                                r"|(?<![a-z])[x×]\s*(?P<m>[1-9]|1\d|20))\s*$", re.I)


# ---------------------------------------------------------------- visual-confusion aliases (v3.2)
#
# The model misreads the cursive Thai STAFF handwriting as look-alike Latin letters / digits: "ออย" -> "004" / "002" /
# "OOW", "ชม." after a number -> "6M" / "2M" / "T2" / "62" / "5ม", "1" -> "I" / "/". master_data.json "visualAliases":
#   treatments: [{reading, lookalikes}]  a whole look-alike token (also one glued to digits, "004162", or one whose glued
#                                        Thai word makes an exact master name, "อยู่ร้อน" -> "ออยร้อน") is read as `reading`;
#   hourUnit:   [...]                    a look-alike after an hour count 1-4 (or 1.5) and a space or "-" (an all-digit
#                                        look-alike also glued on: "162." = "1 62.") is read as "ชม.";
#   digitOne:   [...]                    a look-alike standing alone right before an hour unit is read as "1".
# Everything read through an alias is source "visual-alias", confidence <= VISUAL_ALIAS_CONFIDENCE and needs review.

_HOUR_TH = r"(?:ชั่วโมง|ชัวโมง|ช\.ม\.|ชม\.?)"
_alias_cache = [None, None]  # (visualAliases object, compiled rules)


def _visual_alias_data():
    try:
        return master().get("visualAliases") or {}
    except Exception:  # broken masters: parse without aliases
        return {}


def _exact_treatment(word):
    key = _key(word)
    return bool(key) and any(_key(c) == key for e in master().get("treatments", []) for c in (e["name"], *e.get("aliases", [])))


def _treatment_rule(readings):
    alternatives = "|".join(re.escape(k) for k in sorted(readings, key=len, reverse=True))
    pattern = re.compile(rf"(?<![A-Za-z0-9\u0e01-\u0e59])(?:{alternatives})")

    def replace(m, text):
        reading, after = readings[m.group(0)], text[m.end():]
        if re.match(r"[A-Za-z]", after):
            return None
        rest = re.match(r"[\u0e01-\u0e4e]+", after)  # a Thai word glued on: only when it makes an exact master name
        if rest:
            return reading if _exact_treatment(reading + rest.group(0)) else None
        return reading + " " if after[:1].isdigit() else reading  # "004162" -> "ออย 162"
    return pattern, replace


def _alias_rules():
    data = _visual_alias_data()
    if _alias_cache[0] is data:
        return _alias_cache[1]
    rules, readings = [], {}
    for entry in data.get("treatments", []):
        for lookalike in entry["lookalikes"]:
            if lookalike.strip():
                readings.setdefault(lookalike.strip(), entry["reading"].strip())
    if readings:
        rules.append(_treatment_rule(readings))
    hours = "|".join(re.escape(h) for h in sorted({h.strip() for h in data.get("hourUnit", []) if h.strip()}, key=len, reverse=True))
    ones = "|".join(re.escape(o) for o in sorted({o.strip() for o in data.get("digitOne", []) if o.strip()}, key=len, reverse=True))
    if ones:
        unit = rf"(?:{hours}|{_HOUR_TH})" if hours else _HOUR_TH
        # alone (after a space, a Thai letter or the start; never inside a word such as "Oil") right before an hour unit
        rules.append((re.compile(rf"(?:(?<=[\s\u0e01-\u0e4e])|^)[^\S\n]*(?:{ones})[^\S\n]*(?={unit})"), lambda m, text: " 1 "))
    if hours:
        # Glued to the number only when the look-alike is all digits ("162." = "1 62."): "12M" / "16M" stay minutes.
        glued = "|".join(re.escape(h) for h in sorted({h.strip() for h in data.get("hourUnit", []) if h.strip().isdigit()}, key=len, reverse=True))
        unit = rf"(?:[^\S\n]+-?[^\S\n]*|[^\S\n]*-[^\S\n]*)(?:{hours})" + (rf"|(?:{glued})" if glued else "")
        # ...and never when a real unit follows: then it is a number ("ออย 162 นาที")
        pattern = re.compile(rf"(?<![\d.,:])(?P<n>[1-4](?:[.,]5)?)(?:{unit})\.?(?![A-Za-z0-9\u0e01-\u0e59])(?!\s*(?i:{_MIN}|{_HOUR}))")
        rules.append((pattern, lambda m, text: f"{m.group('n')} ชม."))
    _alias_cache[:] = [data, rules]
    return rules


def _sub_tracked(pattern, replace, text):
    """re.sub whose callback may decline (None) -> (new text, [(old start, old end, new start, new end, written, reading)])."""
    out, edits, pos, shift = [], [], 0, 0
    for m in pattern.finditer(text):
        new = replace(m, text)
        if new is None:
            continue
        out += [text[pos:m.start()], new]
        start = m.start() + shift
        edits.append((m.start(), m.end(), start, start + len(new), m.group(0).strip(), new.strip()))
        shift += len(new) - (m.end() - m.start())
        pos = m.end()
    out.append(text[pos:])
    return "".join(out), edits


def _move(position, edits, end):
    """A position in the text before `edits` -> the same position after them; inside a replaced range: its new start (a span
    start) or new end (a span end)."""
    for old_start, old_end, new_start, new_end, *_ in reversed(edits):
        if old_end <= position:
            return position + (new_end - old_end)
        if old_start < position:
            return new_end if end else new_start
    return position


def apply_visual_aliases(text):
    """Treatment text -> (text with the masters' look-alikes replaced, spans of the replacements in the new text,
    [(written, reading)]). The rules run in order: treatment look-alikes, a lone "1" look-alike before an hour unit, hour
    unit look-alikes after a number ("002 / 6M" -> "ออย / 6M" -> "ออย 1 6M" -> "ออย 1 ชม.")."""
    spans, notes = [], []
    for pattern, replace in _alias_rules():
        text, edits = _sub_tracked(pattern, replace, text)
        if edits:
            spans = [(_move(s, edits, False), _move(e, edits, True)) for s, e in spans] + [(e[2], e[3]) for e in edits]
            notes += [(e[4], e[5]) for e in edits]
    return text, spans, notes


def _overlaps(span, spans):
    return span is not None and any(start < span[1] and span[0] < end for start, end in spans)


def _minutes(match):
    if match.group("hh"):
        return int(match.group("hh")) * 60 + int(match.group("mm"))
    number = float(match.group("num").replace(",", "."))
    if match.group("hour"):
        minutes = number * 60 + (30 if match.group("half") else 0) + (int(match.group("num2")) if match.group("num2") else 0)
    else:
        minutes = number
    return int(round(minutes))


# W1d: what is left of a written unit after the duration regex matched a prefix of it ("90 นที" -> "90 นท" + "ี",
# "90 นทท" -> "90 นท" + "ท"). One character, or Thai vowel/tone marks only, is never a treatment name.
_UNIT_FRAGMENT = re.compile(r"[^\W\d_]|[ัิ-ฺ็-๎]+")


def _clean_name(text):
    text = BARE_NUMBER_RE.sub(" ", text)
    text = re.sub(r"^[\s.:;,*×\-–]+|[\s.:;,*×\-–]+$", "", re.sub(r"\s+", " ", text))
    return text or None


def _segment_groups(segment):
    """Split one segment into (name, raw, [(duration_text, minutes, bare)], leftover numbers, (start, end) in the segment)
    groups. Leftover numbers are numbers that no duration (and no bare-number fallback) used: they are reported instead of
    silently dropped."""
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
    if tail_name and groups and _UNIT_FRAGMENT.fullmatch(tail_name):
        groups[-1][2] = len(segment)  # "ออย 90 นที": the unit match ate "นท" and left "ี" -- a leftover of the unit, not an item
    elif tail_name:
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
    return [(g[0], segment[g[1]:g[2]].strip(), g[3], g[4], (g[1], g[2])) for g in merged]


# W1f: a treatment name is a SUGGESTION below REVIEW_BELOW (0.85) -- it is always flagged and a reviewer sees it next to
# the raw reading -- so the match threshold buys pages at no risk of a silent error. 0.72 -> 0.60. The stop at 0.60 rather
# than 0.50 is precautionary, not measured: 0.50 costs nothing on the 95 labelled pages either, but 95 pages are not
# enough to rule out a coincidence at that similarity. Revisit on held-out evidence (plan W1f).
TREATMENT_SUGGEST_ABOVE = 0.60


def _match_treatment(name_raw, raw):
    for candidate in (name_raw, raw):
        verified = verified_match("treatment", candidate)
        if verified:
            return verified, 1.0, "verified-memory"
    entry, score, alias = _best(name_raw, master().get("treatments", []), "name")
    if entry and score == 1.0:
        return entry["name"], 0.95 if alias else 1.0, "rule" if alias else "master-fuzzy"
    if entry and score >= TREATMENT_SUGGEST_ABOVE:
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


TOTAL_MIN, TOTAL_MAX = 30, 240  # no session in this batch is shorter or longer; outside it a bare total is not minutes


def _total_as_hours(total, has_unit):
    """W1e: a written total with NO unit that is impossible as minutes ("= 27", "= 285") but starts with an hour count
    1-4 is the hour figure with the unit lost or a digit doubled ("= 2 ชม." read as "= 27"). -> (minutes, re-read?)."""
    if total is None or has_unit or TOTAL_MIN <= total <= TOTAL_MAX:
        return total, False
    hours = int(str(total)[0])
    return (hours * 60, True) if 1 <= hours <= 4 else (total, False)


def _split_guests(text, has_total=False):
    """Leading guest count, only when the line has a duration of its own after it or a written total ("4 ไทย 1 ชม.",
    "4 ไทย + เท้า 30 = 90"): -> (text, guests). A lone "2 ไทย" stays a duration (v3.0 reading)."""
    m = GUESTS_RE.match(text)
    if not m or DURATION_RE.match(text, m.start("n")):
        return text, None
    if not (has_total or DURATION_RE.search(text, m.end()) or BARE_NUMBER_RE.search(text, m.end())):
        return text, None
    return text[m.end():], int(m.group("n"))


def parse_treatments(raw, visual_aliases=True):
    """Treatment transcription -> (items: [TreatmentField], all duration strings, warnings, total minutes|None).

    Totals: a written total ("= 90", "> 2 ชม", "รวม 2 ชม.") becomes the total; when exactly one treatment has no
    duration of its own, its duration is derived from the total ("ไทย + เท้า 30 = 90" -> ไทย 60); a total that does not
    add up flags every item. Without a total marker, a trailing duration equal to the sum is the total, and a duration
    written only after the last of several treatments ("ออย + หน้า 2 ชม") is read as their total. A leading guest count
    ("4 ไทย 1 ชม.") or a trailing one ("ไทย 90 นาที 2 ท่าน", "x 2") goes to ``guests`` of every item.

    Visual aliases (``apply_visual_aliases``, unless `visual_aliases` is False) are applied first; an item whose text or
    whose total went through one is source "visual-alias" (when it has a value or duration), at most
    VISUAL_ALIAS_CONFIDENCE and always needsReview; each replacement is reported in the warnings."""
    if not raw:
        return [], [], [], None
    text = _strip_restatement(raw.translate(THAI_DIGITS))
    text, alias_spans, alias_notes = apply_visual_aliases(text) if visual_aliases else (text, [], [])
    trailing = TRAILING_GUESTS_RE.search(text)
    trailing_guests = None
    if trailing and re.search(r"[^\W\d_]", text[:trailing.start()]):
        text, trailing_guests = text[:trailing.start()], int(trailing.group("n") or trailing.group("m"))
    before_total = len(text)
    text, written_total, total_text, total_unit = _split_total(text)
    written_total, total_as_hours = _total_as_hours(written_total, total_unit)
    total_span = (len(text), before_total) if written_total is not None else None  # every split keeps a prefix...
    body, guests = _split_guests(text, written_total is not None)
    base = len(text) - len(body)  # ...except the leading guest count: positions below are offset by it
    guests = guests if guests is not None else trailing_guests
    groups, pos = [], 0
    for separator in [*SEPARATOR_RE.finditer(body), None]:
        segment = body[pos:separator.start() if separator else len(body)]
        if segment.strip():
            groups.extend((*group[:4], (base + pos + group[4][0], base + pos + group[4][1])) for group in _segment_groups(segment))
        pos = separator.end() if separator else pos
    durations_all = [d[0] for _, _, ds, _, _ in groups for d in ds if not d[2]] + ([total_text] if total_unit else [])
    total, warnings, items, review_next = None, [f"visual alias: '{w}' read as '{r}'" for w, r in alias_notes], [], False
    named_minutes = [ds[0][1] for name, _, ds, _, _ in groups if name and ds]
    for index, (name, seg_raw, durs, leftover, span) in enumerate(groups):
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
                total, total_span = durs[0][1], span
                continue
            if items and items[-1]["duration"] is None:
                items[-1].update(duration=durs[0][0], durationMinutes=durs[0][1], raw=f"{items[-1]['raw']} {seg_raw}".strip(),
                                 _bare=durs[0][2], _span=(items[-1]["_span"][0], span[1]))
                if leftover:
                    items[-1]["_review"].add("leftover")
                continue
        extra = durs[1:]
        if extra and written_total is None and last and len(extra) == 1 and extra[0][1] == sum(named_minutes):
            total, extra = extra[0][1], []
        value, confidence, source = _match_treatment(name, seg_raw) if name else (None, 0.0, "none")
        item = {"raw": seg_raw or None, "nameRaw": name, "value": value, "duration": durs[0][0] if durs else None,
                "durationMinutes": durs[0][1] if durs else None, "confidence": confidence, "source": source,
                "guests": guests, "_bare": bool(durs and durs[0][2]), "_review": set(), "_span": span}
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
        if total_as_hours:  # every item on the page was read against a total this parser re-interpreted
            warnings.append(f"written total '{total_text}' is not a possible session length; read as {total} min")
            for item in named:
                item["_review"].add("total")
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
        total, total_span = last_item["durationMinutes"], last_item["_span"]
        last_item.update(duration=None, durationMinutes=None)
        warnings.append(f"{total} min written after the last of {len(named)} treatments is read as their total")
    total_aliased = _overlaps(total_span, alias_spans)  # a total read through an alias shapes every item's reading
    for item in items:
        reasons = item.pop("_review")
        item.pop("_bare")
        value = item["value"]
        allowed = _allowed_durations(value) if value else []
        if allowed and item["durationMinutes"] is not None and item["durationMinutes"] not in allowed:
            reasons.add("duration")
            item["confidence"] = min(item["confidence"], 0.6)
            warnings.append(f"{value}: {item['durationMinutes']} min is not an allowed duration ({', '.join(str(a) for a in allowed)})")
        if _overlaps(item.pop("_span"), alias_spans) or (total_aliased and item["nameRaw"]):
            reasons.add("visual-alias")
            item["confidence"] = min(item["confidence"], VISUAL_ALIAS_CONFIDENCE)
            if value or item["durationMinutes"] is not None:
                item["source"] = "visual-alias"
        review = bool(reasons) or value is None or item["confidence"] < REVIEW_BELOW or item["durationMinutes"] is None
        item["confidence"], item["needsReview"] = round(float(item["confidence"]), 3), review
    ordered = [{k: item[k] for k in ("raw", "value", "confidence", "source", "needsReview", "nameRaw", "duration", "durationMinutes", "guests")}
               for item in items]
    return ordered, durations_all, warnings, total


def legacy_treatment(raw, items, durations):
    return {"raw": raw, "durations": durations, "items": items, "needsReview": (not raw) or not items or any(i["needsReview"] for i in items)}


# ---------------------------------------------------------------- CUSTOMER INFORMATION

# Each label is matched together with the CJK/Thai twin printed next to it ("Nationality国籍", "Hotel Name 酒店"), because
# a model that transcribes the whole customer block as one line writes the second and third labels in the MIDDLE of it
# ("Name 姓名: X Nationality国籍 Y Hotel Name酒店 Z"). A bilingual pair is a printed label wherever it stands (W1a).
_CUSTOMER_LABELS = re.compile(
    # `(?![A-Za-z])` and not `\b`: CJK is a word character, so "Nationality国籍" has no word boundary after the "y".
    r"(?P<hotelName>\b(?:hotel\s*name|hotel)(?![A-Za-z])[^\S\n]*(?:酒店|โรงแรม)?|酒店|โรงแรม)"
    r"|(?P<nationality>\bnationality(?![A-Za-z])[^\S\n]*(?:国籍|國籍|สัญชาติ)?|国籍|國籍|สัญชาติ)"
    r"|(?P<name>\bname(?![A-Za-z])[^\S\n]*(?:姓名|ชื่อ)?|姓名|ชื่อ)", re.I)
_CJK_LABELS = ("姓名", "国籍", "國籍", "酒店")
_BILINGUAL_LABEL = re.compile(r"[A-Za-z][^\S\n]*(?:姓名|国籍|國籍|酒店|ชื่อ|สัญชาติ|โรงแรม)$")
# The printed labels are bilingual ("Name 姓名"); a model may echo the second one in brackets ("Name (姓名): Chun") or
# number its lines ("1. Name Chun"). Both are removed before label matching so they never end up in a value.
_ECHOED_LABEL = re.compile(r"[(\[（【][^\S\n]*(?:姓名|国籍|國籍|酒店|ชื่อ|สัญชาติ|โรงแรม)[^\S\n]*[)\]）】]")
_LIST_MARKER = re.compile(r"(?m)^[^\S\n]*(?:\d+[.)]|[-*•])[^\S\n]+")


def _is_label(text, m):
    """A label word only counts at the start of a line / table cell or right before a colon, so "Kaname", "Hotel Nikko"
    or "Anna Hotelling" inside a value never start a new field. Chinese labels also count as separate words
    ("姓名 Chun 国籍 Chinese 酒店 Hilton"), but not inside a name ("曼谷洲际酒店"). An English label written together with
    its CJK/Thai twin ("Nationality国籍") is the printed label itself and counts anywhere on the line (W1a)."""
    before, after = text[:m.start()], text[m.end():]
    if re.search(r"(?:^|[\n|])[^\S\n]*$", before) or re.match(r"[^\S\n]*[:：]", after):
        return True
    if _BILINGUAL_LABEL.search(m.group(0)):
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


def _same_line(text):
    """The value in `text` stands on the first line of it (the label's own line)."""
    return _clean_value(text.replace("|", "\n").split("\n", 1)[0]) is not None


def _not_a_name(line):
    """A line before the first customer label that is not the name: a date, clock time or session length (header / TIME
    box leftovers), a number, a header label, or no letters at all."""
    return (parse_date(line) is not None or parse_time(line) is not None or DURATION_RE.search(line.translate(THAI_DIGITS)) is not None
            or len(re.findall(r"\d", line.translate(THAI_DIGITS))) >= 3 or bool(_HEADER_LABELS.match(line))
            or not re.search(r"[^\W\d_]", line))


def parse_customer_text(text, expected=CUSTOMER_FIELDS):
    """Customer transcription -> ({field: value|None}, fallback fields). `expected` = fields that have handwriting; the
    fallback fields (a frozenset) were not read under their own label and need review."""
    text = _LIST_MARKER.sub("", _ECHOED_LABEL.sub(" ", _clean_model_text(text)))
    found, matches = {}, [m for m in _CUSTOMER_LABELS.finditer(text) if _is_label(text, m)]
    inline, offline = False, set()  # a value between two labels says which line belongs to which field; `offline`: see below
    for i, m in enumerate(matches):
        key, last = m.lastgroup, i + 1 == len(matches)
        end = len(text) if last else matches[i + 1].start()
        segment = text[m.end():end]
        value = _clean_value(segment)
        if value and not last:
            inline = True
        if value and not found.get(key):
            found[key] = value
            # A label written mid-line belongs to a row-shaped answer ("Name 姓名: X Nationality国籍 Y"), so its value is on
            # its own line. Text taken from a line BELOW such a label is a different answer shape and the assignment is a
            # guess: keep it, flag it (without this, "Name 姓名: X Nationality国籍 Hotel Name酒店\nX Y Z" hands the hotel
            # field a whole row of values unflagged).
            if not re.search(r"(?:^|[\n|])[^\S\n]*$", text[:m.start()]) and not _same_line(segment):
                offline.add(key)
    if matches and not inline:
        # "Labels block, then values block": the model echoed every printed label first and put all the handwriting after
        # the last one ("Name 姓名\nNationality 国籍\nHotel Name 酒店\n\nA\n\nB\n\nC"). Giving that block to the last label
        # alone puts the customer's NAME in the hotel field, unflagged (plan §1A). Read the lines in form order instead,
        # every one of them flagged: the answer never said which line is which.
        keys = [k for k in CUSTOMER_FIELDS if any(m.lastgroup == k for m in matches)]
        lines = [v for v in (_clean_value(line) for line in text[matches[-1].end():].replace("|", "\n").splitlines()) if v]
        if len(keys) >= 2 and len(lines) == len(keys):
            return {k: (lines[keys.index(k)] if k in keys else None) for k in CUSTOMER_FIELDS}, frozenset(keys)
    fallback = set(offline)
    if matches and not found.get("name") and "name" in expected:
        # The Name row is the top row of the crop and sits right above Nationality: real output sometimes drops only its
        # label ("Cynthia De La Cruz-Eikanter\nNationality:\nHotel Name:"), so the last real line before the first label is
        # the name -- flagged, as it was not read under its label.
        lines = [v for v in (_clean_value(line) for line in text[:matches[0].start()].replace("|", "\n").splitlines()) if v and not _not_a_name(v)]
        if lines:
            found["name"] = lines[-1]
            fallback.add("name")
    if matches:
        return {k: found.get(k) for k in CUSTOMER_FIELDS}, frozenset(fallback)
    lines = [v for v in (_clean_value(line) for line in text.splitlines()) if v]
    if lines and len(lines) == len(expected):  # unlabeled answer: one line per written field, in form order
        return {k: (lines[expected.index(k)] if k in expected else None) for k in CUSTOMER_FIELDS}, frozenset(expected)
    return {k: None for k in CUSTOMER_FIELDS}, frozenset(CUSTOMER_FIELDS if lines else ())


def normalize_free_text(raw, fallback):
    """A free-text customer field (name, hotel). W1b: an answer with no letter in it at all -- a tick, a box glyph, a
    slash for "nothing written" -- is a mark, not a value: it is reported as raw with no value, flagged, instead of being
    served as the customer's hotel."""
    if not re.search(r"[^\W\d_]", raw):
        return field(raw, None, 0.3, "ocr", True)
    return field(raw, raw, 0.5 if (fallback or len(raw) > 80) else 0.8, "ocr", fallback or len(raw) > 80)


_NAT_TOKENS = re.compile(r"[\s,;/|()\[\]]+")


def _nationality_tokens(raw, entries):
    """W1c: the distinct master entries that an individual token of `raw` matches EXACTLY ("中國 China" writes the same
    nationality twice; "China People" is one alias plus a word the master list does not know). Fuzzy matching is
    deliberately not used per token -- a 3-letter token is too short for a similarity score to mean anything."""
    hits = set()
    for token in _NAT_TOKENS.split(raw):
        key = _key(token)
        if not key:
            continue
        for entry in entries:
            if any(_key(c) == key for c in (entry["value"], *entry.get("aliases", []))):
                hits.add(entry["value"])
    return hits


def normalize_nationality(raw, fallback=False):
    entries = master().get("nationalities", [])
    entry, score, _ = _best(raw, entries, "value")
    if entry and score >= 0.8:
        return field(raw, entry["value"], score, "master-fuzzy", fallback or score < 0.9)
    hits = _nationality_tokens(raw, entries)
    if len(hits) == 1:  # always flagged: the answer carried text the master list does not explain
        return field(raw, hits.pop(), 0.8, "master-fuzzy", True)
    return field(raw, raw, 0.5, "ocr", True)
