import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { applyReviewEdits, legacyTreatmentIndex, markReviewed, normalizeStructuredResult, parseDurationMinutes, summarizeDocument, toStructuredResult, type DocumentView } from "./document-view.js";
import { hasReviewFields } from "./index.js";

const field = (raw: string | null, value: string | null, confidence: number, needsReview = false, source = "ocr") => ({ raw, value, confidence, source, needsReview });
const check = (label: string, needsReview = false) => ({ ...field(label, label, 0.97, needsReview, "checkbox"), checked: true as const });
const treatment = (raw: string, nameRaw: string, value: string | null, duration: string | null, confidence: number, needsReview = false) =>
  ({ ...field(raw, value, confidence, needsReview, value ? "master-fuzzy" : "none"), nameRaw, duration, durationMinutes: duration ? Number.parseInt(duration, 10) : null });

const v2Treatment = { raw: "ไทย 90 นาที ฟุต 60 นาที", durations: ["90 นาที", "60 นาที"], needsReview: true, items: [
  { raw: "ไทย", value: "นวดไทย", duration: "90 นาที", confidence: 0.95, source: "rule", needsReview: false },
  { raw: "ฟุต", value: null, duration: "60 นาที", confidence: 0.41, source: "master-fuzzy", needsReview: true }
] };
const v2Staff = { treatment: v2Treatment, therapistName: field("พิพิ", null, 0.5, true, "master-fuzzy"), roomNo: field("12", "12", 0.95) };
const v2Response = { documentId: "local-1", sourceFile: "a.png", engine: "typhoon-crop-only", version: "2.2", staffOnly: v2Staff, evidence: { staffCropRaw: "Treatment: ไทย 90 นาที" } };

const v3Response = {
  documentId: "local-3", sourceFile: "b.png", engine: "typhoon-sections", version: "3.0", schemaVersion: 3,
  layout: { template: "makkha-intake-v1", imageWidth: 805, imageHeight: 569 },
  customerInformation: { name: field("Chun Li", "Chun Li", 0.88), gender: { ...field("Female", "Female", 0.96, false, "checkbox") }, nationality: field("Thai", "Thai", 0.9),
    hotelName: { raw: null, value: null, confidence: 0.93, source: "ink-mark", needsReview: false }, referralSources: [check("Hotel")], healthConditions: [check("Menstruation")] },
  recommendationCard: { pressure: field("Standard", "Standard", 0.91, false, "checkbox"), massageOilScrub: [], preferredAreas: [check("Back")], avoidAreas: [check("Neck", true)] },
  staffOnly: {
    treatments: [treatment("ไทย 90 นาที", "ไทย", "นวดไทย", "90 นาที", 0.95), treatment("ฟุต 60 นาที", "ฟุต", null, "60 นาที", 0.41, true)],
    treatment: { raw: "ไทย 90 นาที ฟุต 60 นาที", durations: ["90 นาที", "60 นาที"], items: [], needsReview: true },
    therapistName: field("พิพิ", "พิพิม", 0.7, true, "master-fuzzy"), roomNo: field("12", "12", 0.95)
  },
  evidence: { staffCropRaw: "...", customerCropRaw: "...", checkboxScores: { "gender.female": 0.31 } },
  timings: { inferenceMs: 2900, totalMs: 1650 }, needsReview: true
};

test("normalizes a v3 response to the canonical view without evidence, timings or the legacy treatment block", () => {
  const view = normalizeStructuredResult(v3Response);
  assert.deepEqual(Object.keys(view).sort(), ["customerInformation", "header", "recommendationCard", "schemaVersion", "staffOnly"]);
  assert.deepEqual(view.header, {}, "a v3.0 response has no header: {} like any absent section");
  assert.equal(view.schemaVersion, 3);
  assert.deepEqual(view.customerInformation.name, v3Response.customerInformation.name);
  assert.deepEqual(view.recommendationCard.avoidAreas, [check("Neck", true)]);
  assert.equal("treatment" in view.staffOnly, false);
  assert.deepEqual(view.staffOnly.treatments, v3Response.staffOnly.treatments);
  assert.deepEqual(toStructuredResult(v3Response), view);
});

test("normalizes legacy flat v2.2 staff rows: treatment.items become staffOnly.treatments", () => {
  const view = normalizeStructuredResult(v2Staff);
  assert.deepEqual(view.customerInformation, {});
  assert.deepEqual(view.recommendationCard, {});
  assert.deepEqual(view.staffOnly.therapistName, v2Staff.therapistName);
  assert.deepEqual(view.staffOnly.roomNo, v2Staff.roomNo);
  assert.deepEqual(view.staffOnly.treatments, [
    { raw: "ไทย", value: "นวดไทย", duration: "90 นาที", confidence: 0.95, source: "rule", needsReview: false, nameRaw: "ไทย", durationMinutes: 90 },
    { raw: "ฟุต", value: null, duration: "60 นาที", confidence: 0.41, source: "master-fuzzy", needsReview: true, nameRaw: "ฟุต", durationMinutes: 60 }
  ]);
  assert.equal(hasReviewFields(view), true);
});

test("normalizes whole legacy v2.2 responses the same way as flat rows (documentId/evidence dropped)", () => {
  assert.deepEqual(normalizeStructuredResult(v2Response), normalizeStructuredResult(v2Staff));
  assert.deepEqual(toStructuredResult(v2Response), normalizeStructuredResult(v2Staff));
});

test("an unreadable legacy treatment keeps its needsReview signal as a placeholder item", () => {
  const view = normalizeStructuredResult({ treatment: { raw: null, durations: [], items: [], needsReview: true }, therapistName: field("A", "A", 1, false, "verified-memory") });
  assert.deepEqual(view.staffOnly.treatments, [{ raw: null, nameRaw: null, value: null, duration: null, durationMinutes: null, confidence: 0, source: "none", needsReview: true }]);
  assert.equal(hasReviewFields(view), true);
  const blank = normalizeStructuredResult({ treatment: { raw: "", durations: [], items: [], needsReview: false }, roomNo: field("1", "1", 1) });
  assert.deepEqual(blank.staffOnly.treatments, []);
});

test("normalizeStructuredResult never throws and always returns the canonical shape", () => {
  const circular: Record<string, unknown> = { staffOnly: { roomNo: field("1", "1", 1) } };
  circular.self = circular;
  let deep: Record<string, unknown> = {};
  const deepRoot = { customerInformation: { extra: deep } };
  for (let index = 0; index < 200; index += 1) { const next: Record<string, unknown> = {}; deep.child = next; deep = next; }
  const inputs: unknown[] = [null, undefined, "text", 42, true, [], [1, 2], {}, { foo: 1 }, { staffOnly: "x" }, { staffOnly: [] },
    { staffOnly: { treatment: { items: "nope" } } }, { staffOnly: { treatments: "nope", roomNo: 7 } }, { staffOnly: { treatments: [null, 1, "ไทย", { name: { raw: "ไทย", value: "นวดไทย", needsReview: true }, duration: { value: "90 นาที" } }] } },
    { customerInformation: { referralSources: "x", healthConditions: [null, "Menstruation", 3], name: 5 } }, JSON.parse('{"__proto__": {"polluted": true}, "staffOnly": {"roomNo": {"raw": "1", "value": "1"}}}'),
    circular, deepRoot, { schemaVersion: 3 }, { treatment: "ไทย", therapistName: "A" }, new Date(0), { staffOnly: { therapistName: { raw: {}, value: [], confidence: "0.5", source: 3 } } }];
  for (const input of inputs) {
    const view = normalizeStructuredResult(input);
    assert.equal(view.schemaVersion, 3);
    for (const section of ["customerInformation", "recommendationCard", "staffOnly"] as const) assert.equal(typeof view[section], "object");
    assert.deepEqual(normalizeStructuredResult(view), view, "normalization is idempotent");
    assert.doesNotThrow(() => summarizeDocument(view));
    assert.doesNotThrow(() => JSON.stringify(view));
  }
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  const nested = normalizeStructuredResult(inputs[13]).staffOnly.treatments as Array<Record<string, unknown>>;
  assert.deepEqual(nested.map((item) => item.value), [null, "นวดไทย"]);
  assert.equal(nested[1]!.needsReview, true);
  assert.equal(nested[1]!.durationMinutes, 90);
  assert.deepEqual(normalizeStructuredResult(inputs[14]).customerInformation.healthConditions, [{ raw: "Menstruation", value: "Menstruation", needsReview: false, checked: true }]);
  assert.deepEqual(normalizeStructuredResult(inputs[21]).staffOnly.therapistName, { raw: null, value: null, confidence: 0.5, needsReview: false });
});

test("normalization returns a fresh copy (mutating the view never changes the stored input)", () => {
  const input = structuredClone(v3Response);
  const view = normalizeStructuredResult(input);
  (view.customerInformation.name as Record<string, unknown>).value = "changed";
  assert.equal(input.customerInformation.name.value, "Chun Li");
});

test("parseDurationMinutes understands Thai and English units", () => {
  assert.equal(parseDurationMinutes("90 นาที"), 90);
  assert.equal(parseDurationMinutes("1.5 ชม."), 90);
  assert.equal(parseDurationMinutes("2 ชั่วโมง"), 120);
  assert.equal(parseDurationMinutes("60 min"), 60);
  assert.equal(parseDurationMinutes("1 hr"), 60);
  assert.equal(parseDurationMinutes("90"), 90);
  assert.equal(parseDurationMinutes("ไม่ระบุ"), null);
  assert.equal(parseDurationMinutes(null), null);
});

test("parseDurationMinutes reads durations exactly like the Local AI (shared table) and never half-parses", () => {
  const shared = JSON.parse(readFileSync(new URL("../../../local-ai/tests/duration_cases.json", import.meta.url), "utf8")) as { cases: Array<[string, number]> };
  assert.ok(shared.cases.length >= 15);
  for (const [duration, minutes] of shared.cases) assert.equal(parseDurationMinutes(duration), minutes, duration);
  for (const duration of ["90 นาที + 1 ชม.", "1 ชม. 2.5 ชม.", "ไทย 90 นาที", "10:30", "90 นาที ประมาณ", "", "1 ชม.2", "1 ชม. 5"]) assert.equal(parseDurationMinutes(duration), null, duration);
});

test("summarizeDocument extracts table columns, min confidence and review count", () => {
  const summary = summarizeDocument(normalizeStructuredResult(v3Response));
  assert.deepEqual(summary, {
    customerName: "Chun Li", gender: "Female", nationality: "Thai",
    treatments: [{ name: "นวดไทย", duration: "90 นาที" }, { name: null, duration: "60 นาที" }],
    therapist: "พิพิม", room: "12", formNumber: null, branch: null, minConfidence: 0.41, reviewFieldCount: 3
  });
  assert.deepEqual(summarizeDocument(normalizeStructuredResult(null)), { customerName: null, gender: null, nationality: null, treatments: [], therapist: null, room: null, formNumber: null, branch: null, minConfidence: null, reviewFieldCount: 0 });
  const human = normalizeStructuredResult({ staffOnly: { roomNo: { raw: "1", value: "2", confidence: 0.2, source: "human", needsReview: false } } });
  assert.equal(summarizeDocument(human).minConfidence, 1);
});

function v3View(): DocumentView { return normalizeStructuredResult(v3Response); }

test("applyReviewEdits: value edits become human, keep raw, and clear every needsReview", () => {
  const current = v3View();
  const edited = structuredClone(current);
  (edited.customerInformation.name as Record<string, unknown>).value = "  Chun-Li  ";
  (edited.customerInformation.name as Record<string, unknown>).raw = "forged raw";
  (edited.customerInformation.name as Record<string, unknown>).confidence = 1;
  const { merged, changes } = applyReviewEdits(current, edited);
  assert.deepEqual(merged.customerInformation.name, { raw: "Chun Li", value: "Chun-Li", confidence: 0.88, source: "human", needsReview: false });
  assert.deepEqual(changes.find((change) => change.path === "customerInformation.name"), { path: "customerInformation.name", oldRaw: "Chun Li", oldValue: "Chun Li", newValue: "Chun-Li" });
  assert.equal(hasReviewFields(merged), false);
  assert.deepEqual((merged.recommendationCard.avoidAreas as unknown[])[0], { ...check("Neck"), needsReview: false });
  assert.equal(merged.schemaVersion, 3);
});

// W3a weight rule (accuracy-learning-plan.md §2.5.2, §3 W3a): only an EDITED field confirms. The workbench posts the
// whole draft, so a flagged field the reviewer merely accepted arrives looking exactly like one they approved, and
// v3.2 turned each one into a verified row (§1D: 13 therapist + 15 treatment junk rows on 95 pages).
test("applyReviewEdits: therapistName maps to provider field 'therapist' only when the reviewer changed it", () => {
  const current = v3View();
  const unchanged = applyReviewEdits(current, structuredClone(current));
  assert.equal(unchanged.changes.find((change) => change.path === "staffOnly.therapistName"), undefined,
    "flagged-but-unedited is weight 0: neither a correction row nor a confirmation");
  assert.equal((unchanged.merged.staffOnly.therapistName as Record<string, unknown>).needsReview, false,
    "the reviewer still cleared the flag; only the learning row is withheld");
  const edited = structuredClone(current);
  (edited.staffOnly.therapistName as Record<string, unknown>).value = "พิมพ์";
  const changed = applyReviewEdits(current, edited).changes.find((change) => change.path === "staffOnly.therapistName");
  assert.deepEqual(changed?.provider, { field: "therapist", raw: "พิพิ", verifiedValue: "พิมพ์" });
  const verified = normalizeStructuredResult({ staffOnly: { therapistName: field("A", "Anna", 1, false, "verified-memory") } });
  assert.deepEqual(applyReviewEdits(verified, structuredClone(verified)).changes, []);
  const cleared = structuredClone(current);
  (cleared.staffOnly.therapistName as Record<string, unknown>).value = "";
  const clearedChange = applyReviewEdits(current, cleared).changes.find((change) => change.path === "staffOnly.therapistName");
  assert.equal(clearedChange?.newValue, null);
  assert.equal(clearedChange?.provider, undefined);
});

test("applyReviewEdits: a flagged treatment the reviewer only accepted is weight 0, and a duration edit confirms no name", () => {
  const current = normalizeStructuredResult({ staffOnly: { treatments: [treatment("ไทย 90 นาที", "ไทย", "นวดไทย", "90 นาที", 0.62, true)] } });
  const accepted = applyReviewEdits(current, structuredClone(current));
  assert.deepEqual(accepted.changes, [], "W3a: a suggestion nobody edited never becomes a confirmed value");
  assert.equal((accepted.merged.staffOnly.treatments as Array<Record<string, unknown>>)[0]!.needsReview, false);
  const durationOnly = structuredClone(current);
  (durationOnly.staffOnly.treatments as Array<Record<string, unknown>>)[0]!.duration = "120 นาที";
  const { changes } = applyReviewEdits(current, durationOnly);
  assert.deepEqual(changes.map((change) => change.path), ["staffOnly.treatments[0].duration"]);
  assert.equal(changes.every((change) => change.provider === undefined), true, "the name was not edited, so it is not confirmed");
});

test("applyReviewEdits: treatments support edit, removal and addition without mixing up raw text", () => {
  const current = v3View();
  const [thai, foot] = structuredClone(current.staffOnly.treatments as Array<Record<string, unknown>>);
  const { merged, changes } = applyReviewEdits(current, { staffOnly: { treatments: [{ ...foot, value: "นวดเท้า" }, { raw: null, value: "สครับ", duration: "30 นาที" }, { value: "", duration: "" }] } });
  const treatments = merged.staffOnly.treatments as Array<Record<string, unknown>>;
  assert.equal(treatments.length, 2);
  assert.deepEqual(treatments[0], { ...foot, value: "นวดเท้า", source: "human", needsReview: false });
  assert.deepEqual(treatments[1], { raw: null, nameRaw: null, value: "สครับ", duration: "30 นาที", durationMinutes: 30, confidence: 1, source: "human", needsReview: false });
  assert.deepEqual(changes.filter((change) => change.path.startsWith("staffOnly.treatments")), [
    { path: "staffOnly.treatments[0]", oldRaw: "ฟุต 60 นาที", oldValue: null, newValue: "นวดเท้า", provider: { field: "treatment", raw: "ฟุต", verifiedValue: "นวดเท้า" } },
    { path: "staffOnly.treatments[1]", oldRaw: null, oldValue: null, newValue: "สครับ" },
    { path: "staffOnly.treatments[0].removed", oldRaw: "ไทย 90 นาที", oldValue: "นวดไทย", newValue: null }
  ]);
  assert.equal(thai!.value, "นวดไทย");
});

test("applyReviewEdits: treatment provider raw falls back to raw for legacy items and duration edits are recorded", () => {
  const current = normalizeStructuredResult(v2Staff);
  const items = structuredClone(current.staffOnly.treatments as Array<Record<string, unknown>>);
  items[0]!.duration = "120 นาที";
  items[1]!.value = "นวดเท้า";
  const { merged, changes } = applyReviewEdits(current, { staffOnly: { treatments: items } });
  const merged0 = (merged.staffOnly.treatments as Array<Record<string, unknown>>)[0]!;
  assert.equal(merged0.duration, "120 นาที");
  assert.equal(merged0.durationMinutes, 120);
  assert.equal(merged0.source, "human");
  assert.deepEqual(changes.filter((change) => change.path.startsWith("staffOnly.treatments")), [
    { path: "staffOnly.treatments[0].duration", oldRaw: "ไทย", oldValue: "90 นาที", newValue: "120 นาที" },
    { path: "staffOnly.treatments[1]", oldRaw: "ฟุต", oldValue: null, newValue: "นวดเท้า", provider: { field: "treatment", raw: "ฟุต", verifiedValue: "นวดเท้า" } }
  ]);
});

test("applyReviewEdits: checkbox arrays are editable as lists of strings or items", () => {
  const current = v3View();
  const { merged, changes } = applyReviewEdits(current, { customerInformation: { healthConditions: ["Menstruation", "Pregnancy"], referralSources: [] } });
  assert.deepEqual(merged.customerInformation.healthConditions, [{ ...check("Menstruation"), needsReview: false }, { raw: null, value: "Pregnancy", confidence: 1, source: "human", needsReview: false, checked: true }]);
  assert.deepEqual(merged.customerInformation.referralSources, []);
  // staffOnly was not sent: its needsReview therapist is accepted (needsReview:false) but not sent to provider memory.
  assert.deepEqual(changes, [
    { path: "customerInformation.referralSources[0].removed", oldRaw: "Hotel", oldValue: "Hotel", newValue: null },
    { path: "customerInformation.healthConditions[1]", oldRaw: null, oldValue: null, newValue: "Pregnancy" }
  ]);
  assert.equal((merged.staffOnly.therapistName as Record<string, unknown>).needsReview, false);
});

test("applyReviewEdits: unknown keys are preserved, never added, and only value/duration leaves change", () => {
  const current = normalizeStructuredResult({ customerInformation: { name: field("A", "A", 0.9), phone: field("081", "081", 0.8), note: "keep" }, staffOnly: { roomNo: field("1", "1", 0.9), custom: { x: 1 } }, extraTop: true });
  const { merged, changes } = applyReviewEdits(current, {
    customerInformation: { phone: { value: "0812", raw: "x", source: "ocr", confidence: 1 }, note: "changed", injected: { value: "evil" } },
    staffOnly: { custom: { x: 2 }, roomNo: { value: "1", needsReview: true } }, recommendationCard: { pressure: { value: "Strong" } }, schemaVersion: 99
  });
  assert.deepEqual(merged.customerInformation, { name: { ...field("A", "A", 0.9) }, phone: { raw: "081", value: "0812", confidence: 0.8, source: "human", needsReview: false }, note: "keep" });
  assert.deepEqual(merged.staffOnly, { roomNo: field("1", "1", 0.9), custom: { x: 1 } });
  assert.deepEqual(merged.recommendationCard, { pressure: { raw: null, value: "Strong", confidence: 1, source: "human", needsReview: false } });
  assert.equal(merged.schemaVersion, 3);
  assert.deepEqual(changes.map((change) => change.path), ["customerInformation.phone", "recommendationCard.pressure"]);
});

test("applyReviewEdits rejects malformed or oversize input with REVIEW_INVALID", () => {
  const current = v3View();
  const invalid = { message: "REVIEW_INVALID" };
  assert.throws(() => applyReviewEdits(current, null), invalid);
  assert.throws(() => applyReviewEdits(current, []), invalid);
  assert.throws(() => applyReviewEdits(current, "x"), invalid);
  assert.throws(() => applyReviewEdits(current, { staffOnly: [] }), invalid);
  assert.throws(() => applyReviewEdits(current, { customerInformation: { name: "Chun" } }), invalid);
  assert.throws(() => applyReviewEdits(current, { customerInformation: { name: { value: 5 } } }), invalid);
  assert.throws(() => applyReviewEdits(current, { customerInformation: { name: { value: "x".repeat(501) } } }), invalid);
  assert.doesNotThrow(() => applyReviewEdits(current, { customerInformation: { name: { value: "x".repeat(500) } } }));
  // PostgreSQL cannot store NUL or unpaired surrogates in text/jsonb: 400, not a 500 from the database.
  assert.throws(() => applyReviewEdits(current, { customerInformation: { name: { value: "Som\u0000chai" } } }), invalid);
  assert.throws(() => applyReviewEdits(current, { customerInformation: { name: { value: "Som\ud800chai" } } }), invalid);
  assert.throws(() => applyReviewEdits(current, { staffOnly: { treatments: [{ value: "นวดไทย", duration: "\udc0090 นาที" }] } }), invalid);
  assert.doesNotThrow(() => applyReviewEdits(current, { customerInformation: { name: { value: "Chun 😀" } } }));
  assert.throws(() => applyReviewEdits(current, { staffOnly: { treatments: "ไทย" } }), invalid);
  assert.throws(() => applyReviewEdits(current, { staffOnly: { treatments: [42] } }), invalid);
  assert.throws(() => applyReviewEdits(current, { staffOnly: { treatments: [{ value: "a", duration: 90 }] } }), invalid);
  assert.throws(() => applyReviewEdits(current, { recommendationCard: { preferredAreas: Array.from({ length: 51 }, (_, index) => `Area ${index}`) } }), invalid);
  assert.doesNotThrow(() => applyReviewEdits(current, { recommendationCard: { preferredAreas: Array.from({ length: 50 }, (_, index) => `Area ${index}`) } }));
});

test("applyReviewEdits on an empty legacy view can fill known fields", () => {
  const { merged, changes } = applyReviewEdits(normalizeStructuredResult(null), { customerInformation: { name: { value: "Somchai" }, gender: { value: "" } }, staffOnly: { treatments: [{ value: "นวดไทย", duration: "60 นาที" }] } });
  assert.deepEqual(merged.customerInformation, { name: { raw: null, value: "Somchai", confidence: 1, source: "human", needsReview: false } });
  assert.equal((merged.staffOnly.treatments as unknown[]).length, 1);
  assert.equal(changes.length, 2);
  assert.equal(changes.every((change) => change.provider === undefined), true);
});

/** v2.2 legacy confirm wrote `jsonb_set(structured_result, ARRAY['treatment','value'], …)` and left needsReview untouched. */
const confirmedV2 = (items: unknown[], durations: string[]) => ({
  treatment: { raw: "ฟุต 60 นาที", durations, items, needsReview: true, value: "นวดเท้า 60 นาที" },
  therapistName: { ...field("พิพิ", null, 0.5, true, "master-fuzzy"), value: "พีพี" }, roomNo: field("12", "12", 0.95)
});

test("a v2.2 confirmed treatment (treatment.value) is a human item, and a later review save keeps it", () => {
  const one = normalizeStructuredResult(confirmedV2([{ raw: "ฟุต", value: null, duration: "60 นาที", confidence: 0.41, source: "master-fuzzy", needsReview: true }], ["60 นาที"]));
  assert.deepEqual(one.staffOnly.treatments, [{ raw: "ฟุต", value: "นวดเท้า 60 นาที", duration: "60 นาที", confidence: 1, source: "human", needsReview: false, nameRaw: "ฟุต", durationMinutes: 60 }]);
  assert.deepEqual(summarizeDocument(one).treatments, [{ name: "นวดเท้า 60 นาที", duration: "60 นาที" }]);
  const several = normalizeStructuredResult(confirmedV2(v2Treatment.items, ["90 นาที", "60 นาที"]));
  assert.deepEqual(several.staffOnly.treatments, [{ raw: "ฟุต 60 นาที", nameRaw: "ฟุต 60 นาที", value: "นวดเท้า 60 นาที", duration: "90 นาที + 60 นาที", durationMinutes: null, confidence: 1, source: "human", needsReview: false }]);
  const none = normalizeStructuredResult(confirmedV2([], ["60 นาที"]));
  assert.deepEqual((none.staffOnly.treatments as Array<Record<string, unknown>>).map((item) => [item.value, item.duration, item.durationMinutes, item.needsReview]), [["นวดเท้า 60 นาที", "60 นาที", 60, false]]);
  const edited = structuredClone(one);
  (edited.staffOnly.roomNo as Record<string, unknown>).value = "14";
  const { merged, changes } = applyReviewEdits(one, edited);
  assert.equal((merged.staffOnly.treatments as Array<Record<string, unknown>>)[0]!.value, "นวดเท้า 60 นาที");
  assert.equal(changes.some((change) => change.provider?.field === "treatment"), false, "a confirmed treatment is not re-sent to verified memory");
});

test("markReviewed clears stale needsReview flags of a confirmed document", () => {
  const view = normalizeStructuredResult(confirmedV2([], []));
  assert.equal(hasReviewFields(view), true);
  assert.equal(markReviewed(view), view);
  assert.equal(hasReviewFields(view), false);
  const { changes } = applyReviewEdits(view, structuredClone(view));
  assert.deepEqual(changes, [], "no provider confirmation for fields confirmed in v2.2");
});

test("legacyTreatmentIndex picks the confirmed treatment item or refuses to guess", () => {
  const items = [treatment("ไทย 90 นาที", "ไทย", "นวดไทย", "90 นาที", 0.95), treatment("ฟุต 60 นาที", "ฟุต", null, "60 นาที", 0.41, true), treatment("หน้า 30 นาที", "หน้า", null, "30 นาที", 0.5, true)];
  assert.equal(legacyTreatmentIndex(items, "ฟุต"), 1);
  assert.equal(legacyTreatmentIndex(items, " หน้า 30 นาที "), 2);
  assert.equal(legacyTreatmentIndex(items, "ไทย"), 0, "an exact raw match wins even when the item is not flagged");
  assert.equal(legacyTreatmentIndex(items, "ใทบ"), null, "two flagged items and no match: ambiguous");
  assert.equal(legacyTreatmentIndex(items.slice(0, 2), "ใทบ"), 1, "the only flagged item");
  assert.equal(legacyTreatmentIndex(items.slice(0, 1), ""), 0, "the only item");
  assert.equal(legacyTreatmentIndex([items[1], items[1]], "ฟุต"), null, "duplicates of a flagged item stay ambiguous");
  assert.equal(legacyTreatmentIndex([], "ฟุต"), null);
  assert.equal(legacyTreatmentIndex(["junk", items[1]], "ฟุต"), 1, "indices point into the stored array");
});

test("review removals never share a correction path with the item edited at that index", () => {
  const current = v3View();
  const [thai, foot] = structuredClone(current.staffOnly.treatments as Array<Record<string, unknown>>);
  // Delete the first item and rename the second, which now sits at index 0 (one review, one verified_at).
  const { changes } = applyReviewEdits(current, { staffOnly: { treatments: [{ ...foot, value: "นวดเท้า" }] } });
  assert.deepEqual(changes.map((change) => change.path), ["staffOnly.treatments[0]", "staffOnly.treatments[0].removed"]);
  assert.equal(changes[0]!.provider?.verifiedValue, "นวดเท้า");
  assert.equal(thai!.value, "นวดไทย");
});

/** Local AI v3.1 (release1-plan "v3.1 response additions"): header section, staffOnly.branch/totalMinutes, treatment guests. */
const v31Response = {
  ...v3Response, version: "3.1",
  header: { formNumber: field("012345", "012345", 0.93), date: field("21/9/69", "21/9/69", 0.7, true), time: field("14:30", "14:30", 0.8) },
  layout: { ...v3Response.layout, detection: { verdict: "known", score: 45.3, foundRatio: 1, rmsPx: 0.5, scaleX: 0.993, scaleY: 0.993, rotationDeg: -0.15, dx: 1.2, dy: -2 } },
  staffOnly: {
    ...v3Response.staffOnly,
    treatments: [{ ...treatment("4 ไทย 1 ชม.", "ไทย", "นวดไทย", "1 ชม.", 0.9), durationMinutes: 60, guests: 4 }, { ...treatment("ประคบ 30", "ประคบ", "ประคบ", "30", 0.8), guests: null }],
    branch: field("SUKHUMVIT 33", "SUKHUMVIT 33", 0.95, false, "master-fuzzy"), totalMinutes: 90
  }
};

test("v3.1: the canonical view keeps header, staffOnly.branch, totalMinutes and treatment guests (layout stays out)", () => {
  const view = toStructuredResult(v31Response);
  assert.deepEqual(view.header, v31Response.header);
  assert.deepEqual(view.staffOnly.branch, v31Response.staffOnly.branch);
  assert.equal(view.staffOnly.totalMinutes, 90);
  assert.deepEqual((view.staffOnly.treatments as Array<Record<string, unknown>>).map((item) => [item.value, item.durationMinutes, item.guests]), [["นวดไทย", 60, 4], ["ประคบ", 30, null]]);
  assert.equal("layout" in view, false);
  assert.deepEqual(normalizeStructuredResult(view), view, "idempotent");
  assert.deepEqual(summarizeDocument(view), { customerName: "Chun Li", gender: "Female", nationality: "Thai", treatments: [{ name: "นวดไทย", duration: "1 ชม." }, { name: "ประคบ", duration: "30" }],
    therapist: "พิพิม", room: "12", formNumber: "012345", branch: "SUKHUMVIT 33", minConfidence: 0.7, reviewFieldCount: 3 });
  assert.equal(hasReviewFields(normalizeStructuredResult({ header: { date: field("x", null, 0.2, true) } })), true, "a flagged header field sends the document to review");
});

test("v3.1: malformed numeric additions become null, and v3.0 / legacy rows get an empty header", () => {
  const view = normalizeStructuredResult({ schemaVersion: 3, header: { formNumber: 12345 }, staffOnly: { totalMinutes: "90", treatments: [{ raw: "ไทย", value: "นวดไทย", guests: "4" }] } });
  assert.equal(view.staffOnly.totalMinutes, null);
  assert.equal((view.staffOnly.treatments as Array<Record<string, unknown>>)[0]!.guests, null);
  assert.deepEqual(view.header.formNumber, { raw: "12345", value: "12345", needsReview: false });
  assert.deepEqual(normalizeStructuredResult(v2Staff).header, {});
  assert.deepEqual(normalizeStructuredResult(null).header, {});
  assert.equal("guests" in (normalizeStructuredResult(v3Response).staffOnly.treatments as Array<Record<string, unknown>>)[0]!, false, "v3.0 items do not grow a guests key");
});

test("v3.1: the review editor edits header values and the branch; totalMinutes and guests survive a save", () => {
  const current = toStructuredResult(v31Response);
  const edited = structuredClone(current);
  (edited.header.formNumber as Record<string, unknown>).value = "012346";
  (edited.staffOnly.branch as Record<string, unknown>).value = "PLOENCHIT";
  edited.staffOnly.totalMinutes = 999;
  ((edited.staffOnly.treatments as Array<Record<string, unknown>>)[0]!).guests = 9;
  const { merged, changes } = applyReviewEdits(current, edited);
  assert.deepEqual(merged.header.formNumber, { raw: "012345", value: "012346", confidence: 0.93, source: "human", needsReview: false });
  assert.deepEqual(merged.header.date, { ...v31Response.header.date, needsReview: false }, "accepted as read");
  assert.deepEqual(merged.staffOnly.branch, { raw: "SUKHUMVIT 33", value: "PLOENCHIT", confidence: 0.95, source: "human", needsReview: false });
  assert.equal(merged.staffOnly.totalMinutes, 90, "not an editable leaf");
  assert.equal((merged.staffOnly.treatments as Array<Record<string, unknown>>)[0]!.guests, 4, "not an editable leaf");
  const paths = changes.map((change) => change.path);
  assert.ok(paths.includes("header.formNumber") && paths.includes("staffOnly.branch"));
  assert.equal(changes.find((change) => change.path === "staffOnly.branch")?.provider, undefined, "the branch is not sent to verified memory");
  assert.equal(hasReviewFields(merged), false);
  const filled = applyReviewEdits(normalizeStructuredResult(v3Response), { header: { formNumber: { value: "777" } } });
  assert.deepEqual(filled.merged.header, { formNumber: { raw: null, value: "777", confidence: 1, source: "human", needsReview: false } }, "a v3.0 row can get a form number");
  assert.throws(() => applyReviewEdits(current, { header: "x" }), { message: "REVIEW_INVALID" });
});

/**
 * Contract with the Local AI: a REAL v3.1 response (test/fixtures/local-ai-v31-response.json, made by local-ai api.process_image
 * on the synthetic form with a canned model answer: header, a struck-out oil row, guests, a written total, two therapists, the
 * printed branch). Field by field, what the Local AI emits is what the canonical view, the summary and the review save keep.
 */
type Sections = Record<"header" | "customerInformation" | "recommendationCard" | "staffOnly", Record<string, unknown>>;
const v31Real = JSON.parse(readFileSync(new URL("../../../test/fixtures/local-ai-v31-response.json", import.meta.url), "utf8")) as Sections & { version: string };
const struckMarker = (v31Real.recommendationCard.massageOilScrub as Array<Record<string, unknown>>)[0]!;

test("v3.1 contract: a real Local AI response maps field by field onto the canonical view and the summary", () => {
  assert.equal(v31Real.version, "3.1");
  const view = toStructuredResult({ documentId: "local-31", ...v31Real });
  assert.deepEqual(Object.keys(view).sort(), ["customerInformation", "header", "recommendationCard", "schemaVersion", "staffOnly"], "layout/evidence/timings stay in raw_response");
  for (const key of ["formNumber", "date", "time"]) assert.deepEqual(view.header[key], v31Real.header[key], `header.${key}`);
  assert.deepEqual([view.header.date, view.header.time].map((f) => (f as Record<string, unknown>).value), ["2026-09-21", "14:30"], "ISO date, HH:MM time");
  assert.deepEqual(view.staffOnly.branch, v31Real.staffOnly.branch);
  assert.equal(view.staffOnly.totalMinutes, 90);
  assert.equal(view.staffOnly.totalMinutes, v31Real.staffOnly.totalMinutes);
  assert.deepEqual(view.staffOnly.treatments, v31Real.staffOnly.treatments, "treatments incl. guests and a derived duration, unchanged");
  assert.deepEqual((view.staffOnly.treatments as Array<Record<string, unknown>>).map((t) => [t.value, t.durationMinutes, t.guests]), [["นวดไทย", 60, 2], ["นวดเท้า", 30, 2]]);
  assert.equal("treatment" in view.staffOnly, false, "the legacy v2.2 block is folded into treatments");
  assert.deepEqual(view.staffOnly.therapistName, v31Real.staffOnly.therapistName, "two therapists joined with ' / '");
  const marker = (view.recommendationCard.massageOilScrub as Array<Record<string, unknown>>)[0]!;
  assert.deepEqual(marker, struckMarker, "struck-out row marker kept (value null, flagged)");
  assert.equal(marker.value, null);
  assert.deepEqual(view.customerInformation, v31Real.customerInformation);
  assert.deepEqual(view.recommendationCard, v31Real.recommendationCard);
  assert.equal(hasReviewFields(view), true);
  assert.deepEqual(normalizeStructuredResult(view), view, "idempotent");
  const summary = summarizeDocument(view);
  assert.equal(summary.formNumber, "012345");
  assert.equal(summary.branch, "SUKHUMVIT 33");
  assert.deepEqual(summary.treatments, [{ name: "นวดไทย", duration: "60 นาที" }, { name: "นวดเท้า", duration: "30" }]);
  assert.equal(summary.reviewFieldCount, 2, "the struck-out marker and the two-therapist field");
});

test("v3.1 contract: the review editor's round trip keeps the struck-out marker and the numeric additions", () => {
  const current = toStructuredResult({ documentId: "local-31", ...v31Real });
  const draft = structuredClone(current); // what the UI sends back when the reviewer changes nothing
  const { merged, changes } = applyReviewEdits(current, draft);
  const marker = (merged.recommendationCard.massageOilScrub as Array<Record<string, unknown>>)[0]!;
  assert.deepEqual(marker, { ...struckMarker, needsReview: false }, "accepted as read: still no selection");
  assert.equal(merged.staffOnly.totalMinutes, 90);
  assert.deepEqual((merged.staffOnly.treatments as Array<Record<string, unknown>>).map((t) => t.guests), [2, 2]);
  assert.deepEqual(merged.header.date, { ...(v31Real.header.date as Record<string, unknown>), needsReview: false });
  assert.deepEqual(changes, [], "W3a: the reviewer changed nothing, so nothing is recorded as a correction or a confirmation");
  assert.equal(hasReviewFields(merged), false);
});

test("v3.1: an unread field (branch not found: source none, confidence 0) does not pull the row's confidence to 0", () => {
  const response = structuredClone(v31Real);
  response.staffOnly.branch = { raw: null, value: null, confidence: 0, source: "none", needsReview: false };
  response.staffOnly.therapistName = { raw: "พีพี", value: "พีพี", confidence: 1, source: "master-fuzzy", needsReview: false };
  response.recommendationCard.massageOilScrub = [];
  const summary = summarizeDocument(toStructuredResult({ documentId: "local-31", ...response }));
  assert.equal(summary.branch, null);
  assert.equal(summary.minConfidence, 0.8, "the weakest reading (name 0.8), not the absent branch");
  const flagged = summarizeDocument(normalizeStructuredResult({ staffOnly: { branch: { raw: null, value: null, confidence: 0, source: "none", needsReview: true } } }));
  assert.equal(flagged.minConfidence, 0, "a flagged empty field still counts");
  const read = summarizeDocument(normalizeStructuredResult({ staffOnly: { roomNo: { raw: "x", value: null, confidence: 0, source: "none", needsReview: false } } }));
  assert.equal(read.minConfidence, 0, "raw text without a value is a reading and counts");
});
