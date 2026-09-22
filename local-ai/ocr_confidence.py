"""Model confidence from token log-probabilities (v3.2).

Each parsed field's value is mapped back to the tokens the model generated for it (searched after the field's label in
the model's own answer). modelConfidence = exp(mean token logprob) over that span, or, for the digit fields (room, form
number, date, time: one wrong digit is a wrong value), the probability of its weakest token. The field's confidence becomes
min(rule confidence, modelConfidence); it needs review when modelConfidence is below its type's threshold or when any of
its tokens is below the token floor (a mean over a long value hides one doubtful letter or digit). Without logprobs (older
Ollama, a fake model) or when a value cannot be found in the answer, the field keeps its rule confidence.
"""

import math
import os
import re

from ocr_normalize import THAI_DIGITS

# Review threshold per field type on modelConfidence. Conservative first values (a wrong but confident-looking value is
# the costly error); tune them on the next real-model run. OCR_MODEL_CONFIDENCE_<TYPE> overrides one, e.g.
# OCR_MODEL_CONFIDENCE_NAME=0.9, OCR_MODEL_CONFIDENCE_HOTEL_NAME=0.8, OCR_MODEL_CONFIDENCE_FORM_NUMBER=0.95.
REVIEW_BELOW = {
    "name": 0.85, "nationality": 0.85, "hotelName": 0.85,  # names / free text
    "treatment": 0.80, "therapist": 0.80,
    "room": 0.90, "formNumber": 0.90, "date": 0.90, "time": 0.90,  # digits: one wrong digit is a wrong value
    "token": 0.50,  # floor for every field's weakest token: below it the model gave the other readings more weight
}
DIGIT_KINDS = ("room", "formNumber", "date", "time")  # modelConfidence = the weakest token's probability, not the mean
ENV_PREFIX = "OCR_MODEL_CONFIDENCE_"
_REPLACEMENT = "\ufffd".encode("utf-8")

# Where each field's value is searched first: after its printed label in the answer (then from the start of the answer).
_ANCHORS = {
    "formNumber": r"\bno\b\.?|เลขที่", "date": r"\bdate\b|日期|วันที่", "time": r"\btime\b|时间|時間|เวลา",
    "name": r"(?<!hotel )(?<!therapist )\bname\b|姓名|ชื่อ", "nationality": r"nationality|国籍|國籍|สัญชาติ",
    "hotelName": r"hotel|酒店|โรงแรม", "treatment": r"treatment", "therapist": r"therapist", "room": r"room\s*no",
}
_SKIP_SOURCES = ("ink-mark", "none", "checkbox")  # not read by the model


def threshold(kind):
    name = ENV_PREFIX + re.sub(r"(?<=[a-z])(?=[A-Z])", "_", kind).upper()  # hotelName -> OCR_MODEL_CONFIDENCE_HOTEL_NAME
    try:
        return max(0.0, min(1.0, float(os.environ[name])))
    except (KeyError, ValueError):
        return REVIEW_BELOW[kind]


class TokenMap:
    """Character spans of a model answer -> the log-probabilities of the tokens that produced them. `ok` is False when
    the answer has no usable logprobs (none returned, or the tokens do not spell the answer)."""

    def __init__(self, answer):
        text = str(answer) if answer is not None else ""
        self.text, self.ok = text.translate(THAI_DIGITS), False  # 1:1 characters: Thai digits match ASCII values
        tokens = getattr(answer, "tokens", None)
        if not tokens or not text:
            return
        encoded = text.encode("utf-8")
        offset = b"".join(data for data, _ in tokens).find(encoded)
        if offset >= 0:
            self.bounds, position = [], -offset  # token byte ranges relative to the answer text
            for data, logprob in tokens:
                self.bounds.append((position, position + len(data), logprob))
                position += len(data)
        else:
            self.bounds = _align(tokens, encoded)
            if self.bounds is None:
                return
        self.char_bytes = [0]
        for char in text:
            self.char_bytes.append(self.char_bytes[-1] + len(char.encode("utf-8")))
        self.ok = True

    def find(self, value, kind=None, start=0):
        """(start, end) of `value` in the answer: after the field's label when it has one, else from `start`. Whitespace
        and separators between the value's words may differ from the answer ("ไทย 90 นาที" vs "ไทย / 90นาที"); a value
        starting or ending with a digit must not continue a longer number ("3" is not the 3 of "SUKHUMVIT 33")."""
        value = (value or "").translate(THAI_DIGITS).strip()
        if not value:
            return None
        pattern = r"[\s/+,;:|\-]*".join(re.escape(chunk) for chunk in value.split())
        pattern = ("(?<!\\d)" if value[0].isdigit() else "") + pattern + ("(?!\\d)" if value[-1].isdigit() else "")
        regex = re.compile(pattern, re.I)
        origins = []
        if kind in _ANCHORS:
            label = re.compile(_ANCHORS[kind], re.I).search(self.text, start)
            if label:
                origins.append(label.end())
        for origin in (*origins, start):
            m = regex.search(self.text, origin)
            if m:
                return m.start(), m.end()
        return None

    def stats(self, span, digits=3):
        """{"mean": exp(mean logprob), "min": exp(min logprob), "tokens": n} over the tokens overlapping the span, rounded to
        `digits` (None: unrounded, for the review decision)."""
        first, last = self.char_bytes[span[0]], self.char_bytes[span[1]]
        logprobs = [lp for start, end, lp in self.bounds if start < last and end > first]
        if not logprobs:
            return None
        mean, low = math.exp(sum(logprobs) / len(logprobs)), math.exp(min(logprobs))
        return {"mean": mean if digits is None else round(mean, digits), "min": low if digits is None else round(low, digits), "tokens": len(logprobs)}


def _partials(answer, position):
    """Lengths of the incomplete UTF-8 characters (a lead byte without all its continuation bytes) at `position`."""
    if position >= len(answer) or not 0xC0 <= answer[position] <= 0xF7:
        return ()
    size = 2 if answer[position] < 0xE0 else 3 if answer[position] < 0xF0 else 4  # bytes of the whole character
    out = [1]
    while len(out) < size - 1 and position + len(out) < len(answer) and 0x80 <= answer[position + len(out)] <= 0xBF:
        out.append(len(out) + 1)
    return tuple(out)


def _token_ends(answer, position, data, cut_tail):
    """Where a token whose text is `data` can end when it starts at `position` of `answer`. The text may have lost bytes of
    split characters: each U+FFFD stands for one stray continuation byte (a last one also for a partial character), an
    empty text for a partial character or nothing, and `cut_tail` (the next token starts with continuation bytes) allows a
    partial character cut off its end."""
    if not data:
        return (position, *(position + n for n in _partials(answer, position)))
    ends = [position]
    chunks = data.split(_REPLACEMENT)
    for i, chunk in enumerate(chunks):
        if i:  # a U+FFFD before this chunk
            last = i == len(chunks) - 1 and not chunk
            ends = [e + n for e in ends for n in ((1,) if e < len(answer) and 0x80 <= answer[e] <= 0xBF else ()) + (_partials(answer, e) if last else ())]
        ends = [e + len(chunk) for e in ends if answer.startswith(chunk, e)]
    if cut_tail:
        ends += [e + n for e in ends for n in _partials(answer, e)]
    return tuple(ends)


def _align(tokens, answer):
    """Token byte ranges [(start, end, logprob)] in `answer` (bytes) when the tokens lost bytes of split multi-byte
    characters, else None. Ollama derives a token's bytes from its text, and llama-server cuts a partial UTF-8 character off
    the end of a token's text and JSON-encodes each stray continuation byte as U+FFFD, so a Thai character split over two
    tokens comes back as "" + "\ufffd". The token sequence is matched against the whole answer (`_token_ends`), keeping
    every position each token can end at (a character assembled from damaged tokens can look like the next token; only
    the tokens after it tell them apart): linear in the number of tokens."""
    tokens = list(tokens)
    while tokens and tokens[0][0] and not tokens[0][0].strip() and not answer.startswith(tokens[0][0]):
        tokens.pop(0)  # a leading whitespace token the answer text lost
    damaged = [not data or _REPLACEMENT in data for data, _ in tokens]
    steps = [{0: None}]  # steps[i]: {position after i tokens: position before token i-1}
    for i, (data, _) in enumerate(tokens):
        reached = {}
        for position in steps[-1]:
            for end in _token_ends(answer, position, data, i + 1 < len(tokens) and damaged[i + 1]):
                reached.setdefault(end, position)
        if not reached:
            return None
        steps.append(reached)
    count = len(tokens)
    while len(answer) not in steps[count]:  # trailing whitespace / empty tokens the answer text lost
        if count == 0 or tokens[count - 1][0].strip():
            return None
        count -= 1
    bounds, end = [], len(answer)
    for i in range(count, 0, -1):
        start = steps[i][end]
        bounds.append((start, end, tokens[i - 1][1]))
        end = start
    return bounds[::-1]


def apply(sections, answers):
    """Lower confidence / flag the model-read fields of `sections` in place from the answers' token logprobs.
    `answers` = {"header", "customer", "staff": the model answer each section was read from, or None}. Returns
    evidence.tokenConfidence: {"<section>.<field>": {"mean", "min", "tokens"} or None when the value was not found in an
    answer that had logprobs}. Answers without logprobs add nothing (the rule confidences stand)."""
    maps = {key: TokenMap(answer) for key, answer in answers.items() if answer is not None}
    evidence = {}

    def one(key, field, kind, source, start=0, anchored=True):
        token_map = maps.get(source)
        if token_map is None or not token_map.ok or not field.get("raw") or field.get("source") in _SKIP_SOURCES:
            return None
        span = token_map.find(field["raw"], kind if anchored else None, start)
        stats = token_map.stats(span, None) if span else None
        evidence[key] = stats and {k: round(v, 3) if k != "tokens" else v for k, v in stats.items()}
        if stats:
            model_confidence = stats["min"] if kind in DIGIT_KINDS else stats["mean"]
            field["confidence"] = round(min(field["confidence"], model_confidence), 3)
            if model_confidence < threshold(kind) or stats["min"] < threshold("token"):
                field["needsReview"] = True
        return span

    header, customer, staff = sections["header"], sections["customerInformation"], sections["staffOnly"]
    for key in ("formNumber", "date", "time"):
        one(f"header.{key}", header[key], key, "header")
    for key in ("name", "nationality", "hotelName"):
        one(f"customerInformation.{key}", customer[key], key, "customer")
    position = 0
    for index, item in enumerate(staff["treatments"]):  # in order: each item is searched after the one before it
        span = one(f"staffOnly.treatments.{index}", item, "treatment", "staff", position, anchored=position == 0)
        position = span[1] if span else position
    one("staffOnly.therapistName", staff["therapistName"], "therapist", "staff")
    one("staffOnly.roomNo", staff["roomNo"], "room", "staff")
    return evidence
