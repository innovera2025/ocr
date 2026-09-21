import type { OcrResponse } from "@innovera/ocr-client";

/** Canonical `documents.structured_result` (schema v3). Evidence/timings stay in `raw_response`. */
export type DocumentView = { schemaVersion: 3; customerInformation: Record<string, unknown>;
  recommendationCard: Record<string, unknown>; staffOnly: Record<string, unknown> };
export type DocumentSummary = { customerName: string | null; gender: string | null; nationality: string | null;
  treatments: Array<{ name: string | null; duration: string | null }>; therapist: string | null; room: string | null;
  minConfidence: number | null; reviewFieldCount: number };
export type ReviewChange = { path: string; oldRaw: string | null; oldValue: string | null; newValue: string | null;
  provider?: { field: "treatment" | "therapist"; raw: string; verifiedValue: string } };

type Section = "customerInformation" | "recommendationCard" | "staffOnly";
type Json = Record<string, unknown>;

export const DOCUMENT_SECTIONS: readonly Section[] = ["customerInformation", "recommendationCard", "staffOnly"];
export const REVIEW_ARRAY_FIELDS: Readonly<Record<Section, readonly string[]>> = {
  customerInformation: ["referralSources", "healthConditions"], recommendationCard: ["massageOilScrub", "preferredAreas", "avoidAreas"], staffOnly: ["treatments"]
};
export const REVIEW_SCALAR_FIELDS: Readonly<Record<Section, readonly string[]>> = {
  customerInformation: ["name", "gender", "nationality", "hotelName"], recommendationCard: ["pressure"], staffOnly: ["therapistName", "roomNo"]
};
export const MAX_REVIEW_VALUE_LENGTH = 500;
export const MAX_REVIEW_ARRAY_ITEMS = 50;
const LEGACY_STAFF_KEYS = ["treatment", "treatments", "therapistName", "roomNo"];
const MAX_DEPTH = 32;

function isRecord(value: unknown): value is Json { return typeof value === "object" && value !== null && !Array.isArray(value); }
function text(value: unknown): string | null { return typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : typeof value === "boolean" ? String(value) : null; }
function nonEmpty(value: string | null): value is string { return value !== null && value.trim().length > 0; }
function isFieldLike(value: unknown): value is Json { return isRecord(value) && ("value" in value || "raw" in value); }
function reviewInvalid(): Error { return new Error("REVIEW_INVALID"); }
function emptyView(): DocumentView { return { schemaVersion: 3, customerInformation: {}, recommendationCard: {}, staffOnly: {} }; }

/** Deep copy of JSON-like data: drops functions/undefined/`__proto__` keys, non-finite numbers become null, depth-limited. */
function cloneJson(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "object" || depth > MAX_DEPTH) return undefined;
  if (Array.isArray(value)) return value.map((item) => cloneJson(item, depth + 1) ?? null);
  const out: Json = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "__proto__") continue;
    const copy = cloneJson(item, depth + 1);
    if (copy !== undefined) out[key] = copy;
  }
  return out;
}

/** "90 นาที" → 90, "1.5 ชม." → 90, "60 min" → 60, "90" → 90; anything else → null. */
export function parseDurationMinutes(duration: unknown): number | null {
  const source = text(duration);
  if (!source) return null;
  const match = /(\d+(?:[.,]\d+)?)\s*(นาที|ชั่วโมง|ชม\.?|minutes?|mins?|hours?|hrs?\.?|h)?/i.exec(source.trim());
  if (!match) return null;
  const amount = Number(match[1]!.replace(",", "."));
  if (!Number.isFinite(amount)) return null;
  const unit = (match[2] ?? "").toLowerCase();
  const minutes = /^(ชั่วโมง|ชม|hour|hr|h)/.test(unit) ? amount * 60 : amount;
  return Math.round(minutes);
}

function normalizeField(value: unknown): unknown {
  if (value === null || value === undefined) return { raw: null, value: null, needsReview: false };
  if (!isRecord(value)) {
    const primitive = text(value);
    return primitive === null ? value : { raw: primitive, value: primitive, needsReview: false };
  }
  const out: Json = { ...value, raw: text(value.raw), value: text(value.value), needsReview: value.needsReview === true };
  const confidence = typeof value.confidence === "string" ? Number(value.confidence) : value.confidence;
  if (typeof confidence === "number" && Number.isFinite(confidence)) out.confidence = confidence; else delete out.confidence;
  if (typeof value.source !== "string") delete out.source;
  return out;
}

function normalizeCheckItem(item: unknown): Json | null {
  if (typeof item === "string") return { raw: item, value: item, needsReview: false, checked: true };
  if (!isRecord(item)) return null;
  const field = normalizeField(item) as Json;
  if (!("checked" in field)) field.checked = true;
  return field;
}

function normalizeTreatment(item: unknown): Json | null {
  if (typeof item === "string") return { raw: item, nameRaw: item, value: null, duration: null, durationMinutes: null, needsReview: true };
  if (!isRecord(item)) return null;
  const source: Json = { ...item };
  // Early drafts nested the service as `name: Field`; fold it into the item.
  if (isRecord(source.name)) {
    const name = source.name;
    if (!("value" in source)) source.value = name.value;
    if (!("raw" in source)) source.raw = name.raw;
    if (!("confidence" in source) && "confidence" in name) source.confidence = name.confidence;
    if (name.needsReview === true) source.needsReview = true;
    delete source.name;
  } else if (!("value" in source) && typeof source.name === "string") source.value = source.name;
  if (isRecord(source.duration)) source.duration = source.duration.value ?? source.duration.raw ?? null;
  const out = normalizeField(source) as Json;
  out.nameRaw = "nameRaw" in item ? text(item.nameRaw) : out.raw;
  out.duration = text(source.duration);
  out.durationMinutes = typeof item.durationMinutes === "number" && Number.isFinite(item.durationMinutes) ? item.durationMinutes : parseDurationMinutes(out.duration);
  return out;
}

function normalizeArray(key: string, value: unknown): Json[] {
  if (!Array.isArray(value)) return [];
  const mapped = value.map((item) => key === "treatments" ? normalizeTreatment(item) : normalizeCheckItem(item));
  return mapped.filter((item): item is Json => item !== null);
}

/** v2.2 `staffOnly.treatment = {raw, durations, items, needsReview}` → `treatments[]`; never drops a needsReview signal. */
function legacyTreatments(treatment: unknown): Json[] {
  if (!isRecord(treatment)) return [];
  const items = normalizeArray("treatments", treatment.items);
  if (items.length > 0) return items;
  const raw = text(treatment.raw);
  if (treatment.needsReview !== true && !nonEmpty(raw)) return [];
  const duration = Array.isArray(treatment.durations) ? text(treatment.durations[0]) : null;
  return [{ raw, nameRaw: raw, value: null, duration, durationMinutes: parseDurationMinutes(duration), confidence: 0, source: "none", needsReview: treatment.needsReview === true }];
}

function normalizeSection(section: Section, value: unknown): Json {
  if (!isRecord(value)) return {};
  const out: Json = {};
  for (const [key, item] of Object.entries(value)) {
    if (section === "staffOnly" && key === "treatment") continue;
    if (REVIEW_ARRAY_FIELDS[section].includes(key)) out[key] = normalizeArray(key, item);
    else if (REVIEW_SCALAR_FIELDS[section].includes(key)) out[key] = normalizeField(item);
    else out[key] = item;
  }
  if (section === "staffOnly" && "treatment" in value) {
    const treatments = Array.isArray(out.treatments) ? out.treatments as Json[] : [];
    const legacy = legacyTreatments(value.treatment);
    const merged = treatments.length > 0 ? treatments : legacy;
    const rest = { ...out };
    delete rest.treatments;
    return { treatments: merged, ...rest };
  }
  return out;
}

function normalizeUnsafe(value: unknown): DocumentView {
  const source = cloneJson(value);
  if (!isRecord(source)) return emptyView();
  if (DOCUMENT_SECTIONS.some((section) => section in source) || source.schemaVersion === 3) {
    return { schemaVersion: 3, customerInformation: normalizeSection("customerInformation", source.customerInformation),
      recommendationCard: normalizeSection("recommendationCard", source.recommendationCard), staffOnly: normalizeSection("staffOnly", source.staffOnly) };
  }
  if (LEGACY_STAFF_KEYS.some((key) => key in source)) return { ...emptyView(), staffOnly: normalizeSection("staffOnly", source) };
  return emptyView();
}

/**
 * Converts any stored structured result to the canonical v3 view: canonical v3, legacy flat v2.2 staff results
 * (`{treatment, therapistName, roomNo}`) and whole v2.2/v3 responses (`{documentId, staffOnly, evidence…}`).
 * Returns a fresh deep copy and never throws.
 */
export function normalizeStructuredResult(value: unknown): DocumentView {
  try { return normalizeUnsafe(value); } catch { return emptyView(); }
}

/** Canonical view of a Local AI response (sections only; evidence, timings and layout are not stored here). */
export function toStructuredResult(response: OcrResponse): DocumentView {
  const sections: Json = {};
  for (const section of DOCUMENT_SECTIONS) if (response[section] !== undefined) sections[section] = response[section];
  return normalizeStructuredResult({ schemaVersion: 3, ...sections });
}

function fieldsOf(view: DocumentView): Json[] {
  const fields: Json[] = [];
  for (const section of DOCUMENT_SECTIONS) {
    const value = view[section];
    if (!isRecord(value)) continue;
    for (const entry of Object.values(value)) {
      if (Array.isArray(entry)) fields.push(...entry.filter(isRecord));
      else if (isFieldLike(entry)) fields.push(entry);
    }
  }
  return fields;
}

function valueOf(section: unknown, key: string): string | null {
  return isRecord(section) && isRecord(section[key]) ? text(section[key].value) : null;
}

const EMPTY_SUMMARY: DocumentSummary = { customerName: null, gender: null, nationality: null, treatments: [], therapist: null, room: null, minConfidence: null, reviewFieldCount: 0 };

/** Table row summary of a canonical view. Human-sourced fields count as confidence 1. Never throws. */
export function summarizeDocument(view: DocumentView): DocumentSummary {
  try {
    const staff = view.staffOnly;
    const treatments = isRecord(staff) && Array.isArray(staff.treatments)
      ? staff.treatments.filter(isRecord).map((item) => ({ name: text(item.value), duration: text(item.duration) }))
      : [];
    let minConfidence: number | null = null;
    let reviewFieldCount = 0;
    for (const field of fieldsOf(view)) {
      if (field.needsReview === true) reviewFieldCount += 1;
      const confidence = field.source === "human" ? 1 : field.confidence;
      if (typeof confidence === "number" && Number.isFinite(confidence)) minConfidence = minConfidence === null ? confidence : Math.min(minConfidence, confidence);
    }
    return { customerName: valueOf(view.customerInformation, "name"), gender: valueOf(view.customerInformation, "gender"), nationality: valueOf(view.customerInformation, "nationality"),
      treatments, therapist: valueOf(staff, "therapistName"), room: valueOf(staff, "roomNo"), minConfidence, reviewFieldCount };
  } catch { return { ...EMPTY_SUMMARY, treatments: [] }; }
}

/** Editable leaf: string (trimmed, "" → null) or null, at most 500 characters. */
function readValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length > MAX_REVIEW_VALUE_LENGTH) throw reviewInvalid();
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function clearNeedsReview(value: unknown, depth = 0): void {
  if (depth > MAX_DEPTH || typeof value !== "object" || value === null) return;
  if (Array.isArray(value)) { for (const item of value) clearNeedsReview(item, depth + 1); return; }
  const record = value as Json;
  if (record.needsReview === true) record.needsReview = false;
  for (const item of Object.values(record)) clearNeedsReview(item, depth + 1);
}

function mergeField(path: string, current: unknown, edited: unknown, provider: "therapist" | undefined, changes: ReviewChange[]): unknown {
  if (edited === undefined || edited === null) return current;
  if (!isRecord(edited)) throw reviewInvalid();
  if (!("value" in edited)) return current;
  const newValue = readValue(edited.value);
  if (!isRecord(current)) {
    if (newValue === null) return current;
    changes.push({ path, oldRaw: null, oldValue: null, newValue });
    return { raw: null, value: newValue, confidence: 1, source: "human", needsReview: false };
  }
  const oldRaw = text(current.raw);
  const oldValue = text(current.value);
  const changed = newValue !== oldValue;
  const next: Json = changed ? { ...current, value: newValue, source: "human", needsReview: false } : { ...current, needsReview: false };
  const confirm = provider !== undefined && (changed || current.needsReview === true) && nonEmpty(oldRaw) && nonEmpty(newValue);
  if (changed || confirm) changes.push({ path, oldRaw, oldValue, newValue, ...(confirm ? { provider: { field: provider, raw: oldRaw, verifiedValue: newValue } } : {}) });
  return next;
}

/** Identity keys the client echoes back unchanged; they tie an edited item to its stored original. */
function sameItem(current: Json, edited: Json): boolean {
  if ("raw" in edited && text(edited.raw) !== text(current.raw)) return false;
  if ("nameRaw" in edited && text(edited.nameRaw) !== text(current.nameRaw)) return false;
  if ("confidence" in edited && (typeof edited.confidence === "number" ? edited.confidence : null) !== (typeof current.confidence === "number" ? current.confidence : null)) return false;
  return true;
}

function findItem(current: readonly Json[], used: boolean[], edited: Json, newValue: string | null | undefined): number {
  if ("raw" in edited || "nameRaw" in edited || "confidence" in edited) return current.findIndex((item, index) => !used[index] && sameItem(item, edited));
  if (newValue === undefined || newValue === null) return -1;
  return current.findIndex((item, index) => !used[index] && text(item.value) === newValue);
}

function mergeArray(section: Section, key: string, current: readonly Json[], edited: unknown, changes: ReviewChange[]): Json[] {
  if (edited === undefined || edited === null) return current.map((item) => ({ ...item }));
  if (!Array.isArray(edited) || edited.length > MAX_REVIEW_ARRAY_ITEMS) throw reviewInvalid();
  const treatment = section === "staffOnly" && key === "treatments";
  const base = `${section}.${key}`;
  const used = current.map(() => false);
  const result: Json[] = [];
  for (const entry of edited) {
    if (typeof entry !== "string" && !isRecord(entry)) throw reviewInvalid();
    const item: Json = typeof entry === "string" ? { value: entry } : entry;
    const newValue = "value" in item ? readValue(item.value) : undefined;
    const newDuration = treatment && "duration" in item ? readValue(item.duration) : undefined;
    const index = findItem(current, used, item, newValue);
    const path = `${base}[${result.length}]`;
    if (index === -1) {
      const value = newValue ?? null;
      const duration = newDuration ?? null;
      if (value === null && duration === null) continue;
      result.push(treatment
        ? { raw: null, nameRaw: null, value, duration, durationMinutes: parseDurationMinutes(duration), confidence: 1, source: "human", needsReview: false }
        : { raw: null, value, confidence: 1, source: "human", needsReview: false, checked: true });
      changes.push({ path, oldRaw: null, oldValue: null, newValue: value });
      continue;
    }
    used[index] = true;
    const original = current[index]!;
    const oldRaw = text(original.raw);
    const oldValue = text(original.value);
    const oldDuration = text(original.duration);
    const valueChanged = newValue !== undefined && newValue !== oldValue;
    const durationChanged = newDuration !== undefined && newDuration !== oldDuration;
    const next: Json = { ...original, needsReview: false };
    if (valueChanged) next.value = newValue;
    if (durationChanged) { next.duration = newDuration; next.durationMinutes = parseDurationMinutes(newDuration); }
    if (valueChanged || durationChanged) next.source = "human";
    const finalValue = text(next.value);
    const nameRaw = text(original.nameRaw);
    const providerRaw = nonEmpty(nameRaw) ? nameRaw : oldRaw;
    const confirm = treatment && (valueChanged || original.needsReview === true) && nonEmpty(providerRaw) && nonEmpty(finalValue);
    if (valueChanged || confirm) changes.push({ path, oldRaw, oldValue, newValue: finalValue, ...(confirm ? { provider: { field: "treatment" as const, raw: providerRaw, verifiedValue: finalValue } } : {}) });
    if (durationChanged) changes.push({ path: `${path}.duration`, oldRaw, oldValue: oldDuration, newValue: newDuration });
    result.push(next);
  }
  // Removed items are reported at their original index.
  current.forEach((item, index) => { if (!used[index]) changes.push({ path: `${base}[${index}]`, oldRaw: text(item.raw), oldValue: text(item.value), newValue: null }); });
  return result;
}

function mergeSection(section: Section, current: Json, edited: Json | undefined, changes: ReviewChange[]): Json {
  const out: Json = { ...current };
  const known = [...REVIEW_SCALAR_FIELDS[section], ...REVIEW_ARRAY_FIELDS[section]];
  const keys = new Set([...Object.keys(current), ...(edited ? known.filter((key) => key in edited) : [])]);
  for (const key of keys) {
    const editedValue = edited?.[key];
    if (REVIEW_ARRAY_FIELDS[section].includes(key)) {
      const items = Array.isArray(current[key]) ? (current[key] as unknown[]).filter(isRecord) : [];
      const merged = mergeArray(section, key, items, editedValue, changes);
      if (key in current || merged.length > 0) out[key] = merged;
    } else if (REVIEW_SCALAR_FIELDS[section].includes(key) || isFieldLike(current[key])) {
      const provider = section === "staffOnly" && key === "therapistName" ? "therapist" as const : undefined;
      const merged = mergeField(`${section}.${key}`, current[key], editedValue, provider, changes);
      if (merged !== undefined) out[key] = merged;
    }
  }
  return out;
}

/**
 * Applies a reviewer's edited view onto the stored view. Only `value` (and treatment `duration`) leaves are editable,
 * plus adding/removing items of the known arrays; everything else comes from `current`. Edited array items are
 * matched to stored items by the identity keys they echo back (`raw`, `nameRaw`, `confidence`) or, when none are
 * sent, by value; unmatched items are additions (`raw:null`, `source:"human"`), unmatched stored items removals.
 * Provider confirmations (verified memory) are only produced for fields/items whose `value` the client actually sent.
 * Throws `REVIEW_INVALID` for malformed input, values over 500 characters or arrays over 50 items.
 */
export function applyReviewEdits(current: DocumentView, edited: unknown): { merged: DocumentView; changes: ReviewChange[] } {
  if (!isRecord(edited)) throw reviewInvalid();
  const base = normalizeStructuredResult(current);
  const changes: ReviewChange[] = [];
  const merged = emptyView();
  for (const section of DOCUMENT_SECTIONS) {
    const editedSection = edited[section];
    if (editedSection !== undefined && editedSection !== null && !isRecord(editedSection)) throw reviewInvalid();
    merged[section] = mergeSection(section, base[section], isRecord(editedSection) ? editedSection : undefined, changes);
  }
  for (const section of DOCUMENT_SECTIONS) clearNeedsReview(merged[section]);
  return { merged, changes };
}
