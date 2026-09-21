import { randomBytes, createHash } from "node:crypto";

export type JobStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "DEAD" | "CANCELLED";
export type QueueJob = Readonly<{ id: string; status: JobStatus; attempts: number; leaseTokenHash?: string | undefined; leaseExpiresAt?: number | undefined }>;

export function hashLeaseToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function claim(job: QueueJob, now = Date.now()): { job: QueueJob; leaseToken: string } {
  if (job.status !== "PENDING") throw new Error("JOB_NOT_CLAIMABLE");
  const leaseToken = randomBytes(32).toString("hex");
  return { leaseToken, job: { ...job, status: "RUNNING", attempts: job.attempts + 1, leaseTokenHash: hashLeaseToken(leaseToken), leaseExpiresAt: now + 120_000 } };
}

export function heartbeat(job: QueueJob, leaseToken: string, now = Date.now()): QueueJob {
  if (job.status !== "RUNNING" || job.leaseTokenHash !== hashLeaseToken(leaseToken) || (job.leaseExpiresAt ?? 0) <= now) throw new Error("LEASE_LOST");
  return { ...job, leaseExpiresAt: now + 120_000 };
}

export function finish(job: QueueJob, leaseToken: string, outcome: "SUCCEEDED" | "FAILED", now = Date.now()): QueueJob {
  if (job.status !== "RUNNING" || job.leaseTokenHash !== hashLeaseToken(leaseToken) || (job.leaseExpiresAt ?? 0) <= now) throw new Error("LEASE_LOST");
  return { ...job, status: outcome, leaseTokenHash: undefined, leaseExpiresAt: undefined };
}
