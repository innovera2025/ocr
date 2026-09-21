import assert from "node:assert/strict";
import { test } from "node:test";
import { applyReviewEdits, normalizeStructuredResult, parseDurationMinutes, summarizeDocument, toStructuredResult, type DocumentView } from "./document-view.js";
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
  assert.deepEqual(Object.keys(view).sort(), ["customerInformation", "recommendationCard", "schemaVersion", "staffOnly"]);
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

test("summarizeDocument extracts table columns, min confidence and review count", () => {
  const summary = summarizeDocument(normalizeStructuredResult(v3Response));
  assert.deepEqual(summary, {
    customerName: "Chun Li", gender: "Female", nationality: "Thai",
    treatments: [{ name: "นวดไทย", duration: "90 นาที" }, { name: null, duration: "60 นาที" }],
    therapist: "พิพิม", room: "12", minConfidence: 0.41, reviewFieldCount: 3
  });
  assert.deepEqual(summarizeDocument(normalizeStructuredResult(null)), { customerName: null, gender: null, nationality: null, treatments: [], therapist: null, room: null, minConfidence: null, reviewFieldCount: 0 });
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

test("applyReviewEdits: therapistName maps to provider field 'therapist' when changed or when it needed review", () => {
  const current = v3View();
  const unchanged = applyReviewEdits(current, structuredClone(current));
  assert.deepEqual(unchanged.changes.find((change) => change.path === "staffOnly.therapistName"),
    { path: "staffOnly.therapistName", oldRaw: "พิพิ", oldValue: "พิพิม", newValue: "พิพิม", provider: { field: "therapist", raw: "พิพิ", verifiedValue: "พิพิม" } });
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
    { path: "staffOnly.treatments[0]", oldRaw: "ไทย 90 นาที", oldValue: "นวดไทย", newValue: null }
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
    { path: "customerInformation.referralSources[0]", oldRaw: "Hotel", oldValue: "Hotel", newValue: null },
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
