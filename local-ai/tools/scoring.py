"""The one scorer (accuracy-learning-plan.md §4), with the §1E metric artefacts fixed.

Every field is scored per page into exactly one of four buckets:

    right                 the value matches the label
    right & flagged       matches, but needsReview is set -- review cost, not an error
    wrong & flagged       does not match, and needsReview is set -- the system said so
    wrong & UNFLAGGED     does not match and nothing says so -- a SILENT error, the only kind §4 G1 forbids

The four §1E fixes, each of which moves a headline number:

1. `compare.py:12` scored a list entry as `value or raw`, so the value-less "struck out: ..." marker (`api.py:303-306`)
   counted as a selected item and made 35 oil and 14 health pages wrong although their value sets matched exactly. Here a
   list is scored by its VALUE SET; an entry with no value is a marker and is review cost only (it still flags the field).
2. Nationality was compared through a hand-written 12-entry country map that lacked two country codes. Here both sides go
   through the repo's own `normalize_nationality`, so the scorer can never disagree with the reader about what two
   spellings of one nationality mean, and a master-list fix (W1c) moves both sides at once.
3. The body map was scored per list, so a circle read as a cross made `preferredAreas` wrong-and-unflagged while the flag
   sat in `avoidAreas`. Here it is scored AND flagged as one unit -- and, because merging is also what would hide a
   per-list regression, each list is reported separately as well.
4. A MISSED item carries no flag and no entry, so a page-level list score can never see it. Item-level recall is reported
   for every list field (plan §4 G1b), on its own baseline, and is deliberately not folded into the page counts.

Labels are split into certain and uncertain (`labels.json` -> `uncertainFields`): therapist is uncertain on 91 of 95 pages
and name on 25, so a headline that mixes them is not a measurement.
"""

import re
import sys
import unicodedata
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE.parent)]
sys.dont_write_bytecode = True

import ocr_normalize as N  # noqa: E402


def norm(text):
    """Comparison form for a handwritten value: NFC, lower case, separators and spaces removed."""
    return re.sub(r"[\s.\-_,:;/()]+", "", unicodedata.normalize("NFC", str(text or "")).lower())


def nationality_key(text):
    """§1E fix 2: both sides of a nationality comparison go through the reader's own master matching."""
    if not text:
        return ""
    entry = N.normalize_nationality(str(text))
    return norm(entry["value"]) if entry["source"] == "master-fuzzy" else norm(text)


def items_of(entries):
    """(selected values, marker count) of a checkbox / body-map list. §1E fix 1: a marker has no value and is not an item."""
    values = sorted(norm(e["value"]) for e in (entries or []) if e.get("value") is not None)
    return values, sum(1 for e in (entries or []) if e.get("value") is None)


def flagged_list(entries):
    return any(e.get("needsReview") for e in (entries or []))


def _counts(got, want):
    """Item-level accounting for one list: (labelled items, matched, missed, extra). Duplicates are not expected here."""
    got_set, want_set = set(got), set(want)
    return len(want_set), len(got_set & want_set), len(want_set - got_set), len(got_set - want_set)


# ------------------------------------------------------------------ one page -> {field: outcome}

# field -> the labels.json `uncertainFields` prefixes that make this page's label uncertain for it
UNCERTAIN = {
    "header.date": ("date",),
    "customerInformation.name": ("customer.name",),
    "customerInformation.nationality": ("customer.nationality",),
    "customerInformation.hotelName": ("customer.hotelName",),
    "customerInformation.gender": ("customer.gender",),
    "customerInformation.referralSources": ("customer.referralSources",),
    "customerInformation.healthConditions": ("customer.healthConditions",),
    "recommendationCard.pressure": ("recommendation.pressure",),
    "recommendationCard.massageOilScrub": ("recommendation.massageOilScrub",),
    "recommendationCard.preferredAreas": ("recommendation.preferredAreas",),
    "recommendationCard.avoidAreas": ("recommendation.avoidAreas",),
    "recommendationCard.bodyMap": ("recommendation.preferredAreas", "recommendation.avoidAreas"),
    "staffOnly.treatmentNames": ("staff.treatments", "staff.treatmentAsWritten"),
    "staffOnly.treatmentsWithDuration": ("staff.treatments", "staff.treatmentAsWritten"),
    "staffOnly.roomNo": ("staff.room",),
    "staffOnly.therapistName": ("staff.therapist",),
    "staffOnly.totalMinutes": ("staff.treatments", "staff.treatmentAsWritten"),
}
# Order of the report. "unit" is the body map's only honest page-level metric (§1E fix 3).
ORDER = ("header.formNumber", "header.date", "customerInformation.gender", "customerInformation.name",
         "customerInformation.nationality", "customerInformation.hotelName", "customerInformation.referralSources",
         "customerInformation.healthConditions", "recommendationCard.pressure", "recommendationCard.massageOilScrub",
         "recommendationCard.preferredAreas", "recommendationCard.avoidAreas", "recommendationCard.bodyMap",
         "staffOnly.treatmentNames", "staffOnly.treatmentsWithDuration", "staffOnly.roomNo", "staffOnly.therapistName",
         "staffOnly.totalMinutes")
LIST_FIELDS = ("customerInformation.referralSources", "customerInformation.healthConditions", "recommendationCard.massageOilScrub",
               "recommendationCard.preferredAreas", "recommendationCard.avoidAreas", "recommendationCard.bodyMap")


def written_total(text):
    """The label's written session total -> minutes, or None when the page has none ("2 ชม." = 120, "90" = 90)."""
    if not text:
        return None
    m = re.fullmatch(r"(\d+(?:\.\d+)?)\s*(ชม\.?|ช\.?|นาที)?", str(text).strip(" =>"))
    if not m:
        return "unparsed"
    n = float(m.group(1))
    return int(n * 60) if (m.group(2) or "").startswith("ช") or n <= 4 else int(n)


def _sorted_pairs(pairs):
    """(name, minutes) pairs in a stable total order. A duration may be None (unread, or left blank by the labeller), so
    the pairs cannot be compared directly."""
    return sorted(pairs, key=lambda p: (p[0], p[1] is not None, p[1] or 0))


def _treat_pairs(items):
    return _sorted_pairs((norm(t.get("value")), t.get("durationMinutes")) for t in items)


def _want_pairs(label):
    return _sorted_pairs((norm(t["name"]), t["durationMinutes"]) for t in label["staff"]["treatments"])


def score_page(sections, label):
    """One replayed page -> {field: {right, flagged, markers, want, hit, missed, extra}}. `sections` is a v3 response body
    (stored or replayed); `label` is one entry of labels.json."""
    header, customer = sections["header"], sections["customerInformation"]
    rec, staff = sections["recommendationCard"], sections["staffOnly"]
    out = {}

    def put(field, right, flagged, markers=0, counts=None):
        want, hit, missed, extra = counts or (0, 0, 0, 0)
        out[field] = {"right": bool(right), "flagged": bool(flagged), "markers": markers,
                      "want": want, "hit": hit, "missed": missed, "extra": extra,
                      "uncertain": any(u.startswith(p) for p in UNCERTAIN.get(field, ()) for u in label["uncertainFields"])}

    def scalar(field, node, want, key=norm):
        got = node.get("value")
        put(field, key(got) == key(want) if want else not got, node.get("needsReview"))

    scalar("header.formNumber", header["formNumber"], label.get("formNo"))
    want_date = N.parse_date(label.get("date")) if label.get("date") else None
    put("header.date", (header["date"].get("value") or None) == want_date, header["date"].get("needsReview"))
    scalar("customerInformation.gender", customer["gender"], label["customer"]["gender"])
    scalar("customerInformation.name", customer["name"], label["customer"]["name"])
    scalar("customerInformation.nationality", customer["nationality"], label["customer"]["nationality"], nationality_key)
    scalar("customerInformation.hotelName", customer["hotelName"], label["customer"]["hotelName"])
    scalar("recommendationCard.pressure", rec["pressure"], label["recommendation"]["pressure"])

    for field, entries, want_values in (
            ("customerInformation.referralSources", customer["referralSources"], label["customer"]["referralSources"]),
            ("customerInformation.healthConditions", customer["healthConditions"], label["customer"]["healthConditions"]),
            ("recommendationCard.massageOilScrub", rec["massageOilScrub"], label["recommendation"]["massageOilScrub"]),
            ("recommendationCard.preferredAreas", rec["preferredAreas"], label["recommendation"]["preferredAreas"]),
            ("recommendationCard.avoidAreas", rec["avoidAreas"], label["recommendation"]["avoidAreas"])):
        got, markers = items_of(entries)
        want = sorted(norm(v) for v in want_values)
        put(field, got == want, flagged_list(entries), markers, _counts(got, want))

    # §1E fix 3: a circle read as a cross moves an item between the two lists, so the pair is one value set and one flag.
    got_pref, _ = items_of(rec["preferredAreas"])
    got_avoid, _ = items_of(rec["avoidAreas"])
    got_unit = sorted([("p", v) for v in got_pref] + [("a", v) for v in got_avoid])
    want_unit = sorted([("p", norm(v)) for v in label["recommendation"]["preferredAreas"]]
                       + [("a", norm(v)) for v in label["recommendation"]["avoidAreas"]])
    put("recommendationCard.bodyMap", got_unit == want_unit,
        flagged_list(rec["preferredAreas"]) or flagged_list(rec["avoidAreas"]), 0, _counts(got_unit, want_unit))

    items = staff["treatments"]
    got_pairs, want_pairs = _treat_pairs(items), _want_pairs(label)
    got_names, want_names = sorted(n for n, _ in got_pairs), sorted(n for n, _ in want_pairs)
    # No item at all is the same silence as a wrong item: an empty treatment list is treated as flagged, as production does.
    flagged = flagged_list(items) or not items
    put("staffOnly.treatmentNames", got_names == want_names, flagged, 0, _counts(got_names, want_names))
    put("staffOnly.treatmentsWithDuration", got_pairs == want_pairs, flagged)
    scalar("staffOnly.roomNo", staff["roomNo"], label["staff"]["room"])
    scalar("staffOnly.therapistName", staff["therapistName"], label["staff"]["therapist"])

    want_total = written_total(label["staff"].get("totalAsWritten"))
    if want_total is not None:
        # `staffOnly.totalMinutes` is a bare integer with no needsReview of its own: it has NO flag carrier, so every one
        # of its errors is silent by construction. Reported, never folded into G1 (which is per flaggable field).
        put("staffOnly.totalMinutes", want_total == staff.get("totalMinutes"), False)
    return out


# ------------------------------------------------------------------ totals

class Totals:
    """Per-field buckets over a page set, plus the item-level accounting §4 G1b gates separately."""

    def __init__(self):
        self.rows = {}

    def add(self, page, scored):
        for field, s in scored.items():
            row = self.rows.setdefault(field, {"n": 0, "right": 0, "rightFlagged": 0, "wrongFlagged": 0, "wrongUnflagged": 0,
                                               "markers": 0, "want": 0, "hit": 0, "missed": 0, "extra": 0,
                                               "uncertain": 0, "pages": {"wrongUnflagged": [], "wrongFlagged": [], "right": []}})
            row["n"] += 1
            row["uncertain"] += s["uncertain"]
            row["markers"] += bool(s["markers"])
            for key in ("want", "hit", "missed", "extra"):
                row[key] += s[key]
            if s["right"]:  # `right` counts every correct page; `rightFlagged` is the review-cost subset of it (G3)
                row["right"] += 1
                row["rightFlagged"] += bool(s["flagged"])
                row["pages"]["right"].append(page)
            elif s["flagged"]:
                row["wrongFlagged"] += 1
                row["pages"]["wrongFlagged"].append(page)
            else:
                row["wrongUnflagged"] += 1
                row["pages"]["wrongUnflagged"].append(page)

    def field(self, name):
        return self.rows.get(name)

    def ordered(self):
        return [(f, self.rows[f]) for f in ORDER if f in self.rows] + [(f, r) for f, r in self.rows.items() if f not in ORDER]
