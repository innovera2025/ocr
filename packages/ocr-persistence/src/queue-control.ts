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
