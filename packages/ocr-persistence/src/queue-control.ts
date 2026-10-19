/**
 * Queue control read model and input rules (plan queue-control D7, D10, D14). Pure: the store (`index.ts`) runs the SQL,
 * these functions shape and validate what goes in and out, so they are unit-tested without a database.
 */
import type { AuditContext } from "./audit.js";

/** D7, derived, never stored: `stopped` while stopped_at is set; else `round_full` once a cap is set and reached; else `reading`. */
export type QueueRoundState = "reading" | "stopped" | "round_full";
/** The control row as the API returns it. `stoppedBy` is a display name, never an id or a credential. */
export type QueueControlState = { stopped: boolean; stoppedAt: string | null; stoppedBy: string | null; roundCap: number | null;
  roundNo: number; roundStartedAt: string; roundDone: number; roundState: QueueRoundState };
/** Who changes the control: `displayName` is shown as "stopped by", `audit` carries the actor's id into audit_events. */
export type QueueActor = Readonly<{ displayName: string; audit: AuditContext }>;
/** `changed` is false for an idempotent repeat (stop while stopped, the same cap again): no audit row, no log line. */
export type QueueControlChange = { changed: boolean; control: QueueControlState };

export const ROUND_CAP_MAX = 100_000;
/** int4 upper bound: a round number above it can never match a row. */
const ROUND_NO_MAX = 2_147_483_647;

/**
 * D7 `POST /api/queue/next-round` with a stale `roundNo`: someone already started that round. The 409 carries the
 * current control state so the page can refresh without a second request.
 */
export class RoundAlreadyStartedError extends Error {
  readonly control: QueueControlState;
  constructor(control: QueueControlState) {
    super("ROUND_ALREADY_STARTED");
    this.name = "RoundAlreadyStartedError";
    this.control = control;
  }
}

type Row = Record<string, unknown>;
function isoOrNull(value: unknown): string | null {
  return value instanceof Date ? value.toISOString() : typeof value === "string" ? new Date(value).toISOString() : null;
}

/** `stopped` wins over `round_full` (the UI still shows that the round is full, from roundCap/roundDone). */
export function roundStateOf(control: Readonly<{ stopped: boolean; roundCap: number | null; roundDone: number }>): QueueRoundState {
  if (control.stopped) return "stopped";
  if (control.roundCap !== null && control.roundDone >= control.roundCap) return "round_full";
  return "reading";
}

/** A `queue_control` row → the API shape. */
export function toQueueControlState(row: Row): QueueControlState {
  const stoppedAt = isoOrNull(row.stopped_at);
  const roundCap = row.round_cap === null || row.round_cap === undefined ? null : Number(row.round_cap);
  const roundDone = Number(row.round_done ?? 0);
  const base = { stopped: stoppedAt !== null, roundCap, roundDone };
  return { stopped: base.stopped, stoppedAt, stoppedBy: stoppedAt !== null && typeof row.stopped_by === "string" ? row.stopped_by : null, roundCap,
    roundNo: Number(row.round_no ?? 1), roundStartedAt: isoOrNull(row.round_started_at) ?? "", roundDone, roundState: roundStateOf(base) };
}

/** `roundCap`: an integer 1..ROUND_CAP_MAX, or null for unlimited. Anything else (missing, string, 0, 1.5) → ROUND_CAP_INVALID. */
export function parseRoundCap(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > ROUND_CAP_MAX) throw new Error("ROUND_CAP_INVALID");
  return value;
}

/** `roundNo`: the round the caller is looking at, a positive integer. Anything else → ROUND_INVALID. */
export function parseRoundNo(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > ROUND_NO_MAX) throw new Error("ROUND_INVALID");
  return value;
}

/** `stopped_by`: the actor's display name, trimmed to the column (varchar 255); never empty. */
export function stoppedByName(actor: QueueActor): string {
  const name = typeof actor.displayName === "string" ? actor.displayName.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 255) : "";
  return name || "-";
}

// ---- Progress read model (D11) -----------------------------------------------------------------------------------

/** D11: the rate looks at the tenant's last 21 read pages (20 gaps) of the last 24 h. */
export const RATE_COMPLETIONS = 21;
/** A gap above 15 minutes is a stop, an idle queue or off-hours, not reading time (Q5, decided 2026-10-19). */
export const RATE_MAX_GAP_SECONDS = 900;
/** Fewer usable gaps than this: no rate ("ยังประเมินไม่ได้"), never a guess. */
export const RATE_MIN_GAPS = 5;
/** `GET /api/queue` lists this many open batches; the totals cover all of them. */
export const QUEUE_BATCHES_SHOWN = 50;

export type QueueRate = { secondsPerPage: number | null; sample: number };

/** Median of a non-empty list (mean of the two middle values for an even count). */
export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * D11: completion times (ms, any order) → gaps between consecutive completions, gaps above RATE_MAX_GAP_SECONDS
 * dropped, at least RATE_MIN_GAPS left → their median in seconds (0.1 s precision). `sample` is the number of gaps used.
 */
export function rateFromCompletions(times: readonly number[]): QueueRate {
  const sorted = times.filter((time) => Number.isFinite(time)).sort((a, b) => a - b).slice(-RATE_COMPLETIONS);
  const gaps: number[] = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const gap = (sorted[index]! - sorted[index - 1]!) / 1000;
    if (gap <= RATE_MAX_GAP_SECONDS) gaps.push(gap);
  }
  if (gaps.length < RATE_MIN_GAPS) return { secondsPerPage: null, sample: gaps.length };
  return { secondsPerPage: Math.round(median(gaps) * 10) / 10, sample: gaps.length };
}

/** The fields of a batch summary the overview adds up (a subset of `BatchSummary`, so tests can pass plain objects). */
export type QueueBatchCounts = Readonly<{ rowsExpected: number; completed: number; failed: number; queued: number; processing: number;
  uploaded: number; expectedTotal: number; filesDone: number; paused: boolean }>;
export type QueueOverviewTotals = { openBatches: number; pagesTotal: number; pagesRead: number; pagesFailed: number; pagesWaiting: number;
  pagesReading: number; heldPages: number; filesUploaded: number; filesExpected: number; filesDone: number; secondsPerPage: number | null;
  etaSeconds: number | null; roundEtaSeconds: number | null; rateSample: number };
export type QueueOverview<B extends QueueBatchCounts = QueueBatchCounts> = { control: QueueControlState; overview: QueueOverviewTotals; batches: B[];
  batchesTotal: number; holdsAvailable: boolean };

/**
 * D11 totals and ETAs over every open batch. Remaining pages = rows the batch will have minus rows already read
 * (pages not split yet count). Paused (held) batches are excluded from the ETA and reported as `heldPages`.
 * `etaSeconds` = remaining × rate; `roundEtaSeconds` = min(remaining, N − done) × rate with a cap. Null without a rate.
 */
export function queueOverviewTotals(batches: readonly QueueBatchCounts[], control: Pick<QueueControlState, "roundCap" | "roundDone">, rate: QueueRate): QueueOverviewTotals {
  const sum = (pick: (batch: QueueBatchCounts) => number) => batches.reduce((total, batch) => total + pick(batch), 0);
  const remaining = (batch: QueueBatchCounts) => Math.max(0, batch.rowsExpected - batch.completed);
  const remainingPages = sum((batch) => batch.paused ? 0 : remaining(batch));
  const heldPages = sum((batch) => batch.paused ? remaining(batch) : 0);
  const spp = rate.secondsPerPage;
  const roundLeft = control.roundCap === null ? null : Math.max(0, control.roundCap - control.roundDone);
  return {
    openBatches: batches.length, pagesTotal: sum((batch) => batch.rowsExpected), pagesRead: sum((batch) => batch.completed), pagesFailed: sum((batch) => batch.failed),
    pagesWaiting: sum((batch) => batch.queued), pagesReading: sum((batch) => batch.processing), heldPages,
    filesUploaded: sum((batch) => batch.uploaded), filesExpected: sum((batch) => batch.expectedTotal), filesDone: sum((batch) => batch.filesDone),
    secondsPerPage: spp, etaSeconds: spp === null ? null : Math.round(remainingPages * spp),
    roundEtaSeconds: spp === null || roundLeft === null ? null : Math.round(Math.min(remainingPages, roundLeft) * spp), rateSample: rate.sample
  };
}

/** The `GET /api/queue` body: totals over all open batches, the first QUEUE_BATCHES_SHOWN of them in queue order. */
export function queueOverview<B extends QueueBatchCounts>(control: QueueControlState, batches: readonly B[], rate: QueueRate, holdsAvailable: boolean): QueueOverview<B> {
  return { control, overview: queueOverviewTotals(batches, control, rate), batches: batches.slice(0, QUEUE_BATCHES_SHOWN), batchesTotal: batches.length, holdsAvailable };
}
