import { Pool, type PoolConfig } from "pg";

/**
 * The worker's queue gate (plan queue-control D5 to D7). Before every claim a job loop asks for a slot; a closed gate
 * claims nothing and changes no job row, so Stop/Resume and the per-round page cap are instant and lose nothing.
 *
 * - Closed while `queue_control.stopped_at` is set (`stopped`), or while a cap is set and `round_done + inflight >=
 *   round_cap` (`round_full`). `inflight` counts this process's slots taken and not yet given back; because the slot is
 *   taken BEFORE the claim, at most `cap - round_done` pages are ever started, for any concurrency.
 * - A slot is given back uncounted when the claim returned nothing, the job was a PDF split, or the job ended without a
 *   successful OCR finish. Only an accepted SUCCEEDED OCR finish counts: `round_done = round_done + 1` (one atomic
 *   UPDATE, serialised with "Start next round" by the row lock), then `inflight` drops.
 * - A slot survives a round reset: a page started in round r and finished after the reset is counted in round r+1 and
 *   occupies one of its N slots meanwhile (D7).
 * - Fails closed: an unreadable control row throws into the loop's backoff, so nothing is claimed.
 */
export type GateReason = "stopped" | "round_full";
export type GateDecision = Readonly<{ open: true }> | Readonly<{ open: false; reason: GateReason }>;
/** The three columns the gate reads. `roundCap` null = unlimited. */
export type GateRow = Readonly<{ stopped: boolean; roundCap: number | null; roundDone: number }>;

/** Pure: the gate's decision for a control row and this process's in-flight slots. `stopped` wins over `round_full`. */
export function gateDecision(row: GateRow, inflight: number): GateDecision {
  if (row.stopped) return { open: false, reason: "stopped" };
  if (row.roundCap !== null && row.roundDone + inflight >= row.roundCap) return { open: false, reason: "round_full" };
  return { open: true };
}

/** One reserved page. `complete(true)` counts it (accepted SUCCEEDED OCR finish); `release()` gives it back uncounted. Both are idempotent. */
export type QueueSlot = Readonly<{ complete(counted: boolean): Promise<void>; release(): void }>;
/** Structural view the worker uses (fakes in tests). `reserve()` resolves null while the gate is closed. */
export type QueueGate = Readonly<{ reserve(): Promise<QueueSlot | null> }>;
export type QueueGateLog = (event: string, fields: Readonly<Record<string, unknown>>) => void;

const READ_SQL = "SELECT stopped_at, round_cap, round_done FROM queue_control";
const COUNT_SQL = "UPDATE queue_control SET round_done = round_done + 1 WHERE id";

export class PostgresQueueControl implements QueueGate {
  readonly pool: Pool;
  private inflightSlots = 0;
  /** Serialises read → decide → take within this process, so two loops can never both take the last slot. */
  private turn: Promise<void> = Promise.resolve();
  /** "open" or the reason it is closed; transitions are logged once. Starts open, so a gate closed at startup logs once. */
  private state: "open" | GateReason = "open";
  private readonly log: QueueGateLog;

  constructor(config: Pool | PoolConfig | string, options: Readonly<{ log?: QueueGateLog }> = {}) {
    this.pool = config instanceof Pool ? config : new Pool(typeof config === "string" ? { connectionString: config } : config);
    this.log = options.log ?? (() => undefined);
  }

  /** In-flight slots of this process (tests and logs). */
  get inflight(): number { return this.inflightSlots; }

  /** The control row as the gate sees it. QUEUE_CONTROL_MISSING when the single row is absent (fail closed). */
  async read(): Promise<GateRow> {
    const result = await this.pool.query<{ stopped_at: Date | null; round_cap: number | null; round_done: number }>(READ_SQL);
    const row = result.rows[0];
    if (!row) throw new Error("QUEUE_CONTROL_MISSING");
    return { stopped: row.stopped_at !== null, roundCap: row.round_cap === null ? null : Number(row.round_cap), roundDone: Number(row.round_done) };
  }

  async reserve(): Promise<QueueSlot | null> {
    const previous = this.turn;
    let done!: () => void;
    this.turn = new Promise<void>((resolveTurn) => { done = resolveTurn; });
    await previous;
    try {
      const row = await this.read();
      const decision = gateDecision(row, this.inflightSlots);
      this.transition(decision, row);
      if (!decision.open) return null;
      this.inflightSlots += 1;
      return this.slot();
    } finally { done(); }
  }

  private slot(): QueueSlot {
    let settled = false;
    const release = (): void => {
      if (settled) return;
      settled = true;
      this.inflightSlots = Math.max(0, this.inflightSlots - 1);
    };
    return {
      release,
      complete: async (counted) => {
        if (settled) return;
        if (!counted) { release(); return; }
        // The count is written first and the slot given back after, so between the two the page is (conservatively)
        // seen twice by a concurrent reserve, never zero times. A failed write still frees the slot (undercount by one).
        try { await this.pool.query(COUNT_SQL); } finally { release(); }
      }
    };
  }

  private transition(decision: GateDecision, row: GateRow): void {
    const next = decision.open ? "open" : decision.reason;
    if (next === this.state) return;
    this.state = next;
    if (next === "open") this.log("queue_gate_opened", { round_cap: row.roundCap, round_done: row.roundDone, inflight: this.inflightSlots });
    else this.log("queue_gate_closed", { reason: next, round_cap: row.roundCap, round_done: row.roundDone, inflight: this.inflightSlots });
  }

  async close(): Promise<void> { await this.pool.end(); }
}
