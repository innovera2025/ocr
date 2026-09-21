import { randomUUID } from "node:crypto";
import { Pool, type PoolConfig } from "pg";

export type ConfirmSender = (payload: Readonly<Record<string, unknown>>) => Promise<void>;
export type OutboxDispatchResult = Readonly<{ claimed: boolean; delivered: boolean }>;
type OutboxDb = Readonly<{ query: (text: string, values?: readonly unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> ; end?: () => Promise<void> }>;

export class PostgresConfirmOutbox {
  readonly pool: OutboxDb;
  readonly workerId: string;
  constructor(config: Pool | PoolConfig | string | OutboxDb, workerId?: string) {
    this.pool = config instanceof Pool || (typeof config === "object" && "query" in config) ? config as OutboxDb : new Pool(typeof config === "string" ? { connectionString: config } : config);
    this.workerId = workerId ?? randomUUID();
  }

  async dispatchOnce(sender: ConfirmSender): Promise<OutboxDispatchResult> {
    const claimed = await this.pool.query("SELECT * FROM ocr_claim_confirm_outbox_v1($1::text, now())", [this.workerId]);
    const item = claimed.rows[0];
    if (!item) return { claimed: false, delivered: false };
    try {
      await sender(item.payload as Readonly<Record<string, unknown>>);
      const result = await this.pool.query("SELECT ocr_finish_confirm_outbox_v1($1::uuid, $2::text, true, NULL, now())", [item.outbox_id, this.workerId]);
      return { claimed: true, delivered: result.rows[0]?.ocr_finish_confirm_outbox_v1 === true };
    } catch (error) {
      const message = error instanceof Error ? error.message : "CONFIRM_OUTBOX_FAILED";
      await this.pool.query("SELECT ocr_finish_confirm_outbox_v1($1::uuid, $2::text, false, $3::text, now())", [item.outbox_id, this.workerId, message.slice(0, 4000)]);
      return { claimed: true, delivered: false };
    }
  }

  async recoverExpired(): Promise<number> {
    const result = await this.pool.query("SELECT ocr_recover_confirm_outbox_v1(now())");
    return Number(result.rows[0]?.ocr_recover_confirm_outbox_v1 ?? 0);
  }

  async close(): Promise<void> { await this.pool.end?.(); }
}
