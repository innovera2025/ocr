import { Pool, type PoolConfig } from "pg";

export type ClaimedJob = Readonly<{ jobId: string; organizationId: string; runId: string; kind: string; leaseToken: string }>;
export type RetryPolicy = Readonly<{ maxAttempts: number; delaySeconds: number }>;

export class PostgresQueue {
  readonly pool: Pool;
  readonly workerPool: Pool;
  constructor(config: Pool | PoolConfig | string, workerConfig?: Pool | PoolConfig | string) {
    this.pool = config instanceof Pool ? config : new Pool(typeof config === "string" ? { connectionString: config } : config);
    this.workerPool = workerConfig instanceof Pool ? workerConfig : workerConfig ? new Pool(typeof workerConfig === "string" ? { connectionString: workerConfig } : workerConfig) : this.pool;
  }

  async enqueue(input: { organizationId: string; runId: string; kind?: string; availableAt?: Date }): Promise<string> {
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO extraction_jobs(id, organization_id, run_id, kind, status, available_at)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, 'PENDING', COALESCE($4, now())) RETURNING id`,
      [input.organizationId, input.runId, input.kind ?? "OCR", input.availableAt ?? null]
    );
    return result.rows[0]!.id;
  }

  async claim(now = new Date()): Promise<ClaimedJob | null> {
    const result = await this.pool.query<{ job_id: string; organization_id: string; run_id: string; kind: string; lease_token: string }>("SELECT * FROM ocr_claim_v1($1::timestamptz)", [now]);
    const row = result.rows[0];
    return row ? { jobId: row.job_id, organizationId: row.organization_id, runId: row.run_id, kind: row.kind, leaseToken: row.lease_token } : null;
  }

  async heartbeat(jobId: string, leaseToken: string, now = new Date()): Promise<boolean> {
    const result = await this.workerPool.query<{ ocr_heartbeat_v1: boolean }>("SELECT ocr_heartbeat_v1($1::uuid, $2::text, $3::timestamptz)", [jobId, leaseToken, now]);
    return result.rows[0]?.ocr_heartbeat_v1 === true;
  }

  async finish(jobId: string, leaseToken: string, outcome: "SUCCEEDED" | "FAILED" | "DEAD", error?: string): Promise<boolean> {
    const result = await this.workerPool.query<{ accepted: boolean }>("SELECT accepted FROM ocr_finish_retry_v1($1::uuid, $2::text, $3::job_status, $4::text, now())", [jobId, leaseToken, outcome, error ?? null]);
    return result.rows[0]?.accepted === true;
  }

  async recoverExpired(now = new Date()): Promise<number> {
    const result = await this.workerPool.query<{ ocr_recover_expired_v1: number }>("SELECT ocr_recover_expired_v1($1::timestamptz)", [now]);
    return result.rows[0]?.ocr_recover_expired_v1 ?? 0;
  }

  async close(): Promise<void> { if (this.workerPool !== this.pool) await this.workerPool.end(); await this.pool.end(); }
}
