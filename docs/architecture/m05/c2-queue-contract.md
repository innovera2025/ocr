---
dimension: c2-queue-contract
title: Canonical queue, retry and idempotency contract (owner section 12; contradiction 6)
status: canonical
date: 2026-09-09
supersedes:
  - docs/architecture/m0/h-queue-and-worker-contract.md (§0 L1-L31 in part, §6.2, §6.3, §6.4, §6.5, §7.2, §7.3, §8.1, §8.2, §9.2, §9.4, §9.5, §10.1, §10.2, §10.3, §11.2, §11.3, §11.5, §12.3, §12.4, §13.2, §14.1, §15.1)
  - docs/architecture/m0/g-data-model.md (§5.5 ExtractionJob/JobEvent columns, claim statement, lease sweeper, heartbeat, completion, priority direction)
  - docs/architecture/m0/z-adversarial-panel.md P2-queue (all three lenses; every safer-alternative item is either adopted or explicitly rejected with a reason here)
---

# C2 — The queue, retry and idempotency contract

> **Integration status (2026-09-12):** Read the [architecture index](../README.md) and its consolidation report before using these examples. Individual review labels do not close cross-document conflicts; no application implementation is verified.

**Scope.** Everything between *"a Next.js request handler has decided this document must be
processed"* and *"a Python worker has durably recorded the outcome"*: job identity, the claim/lease
protocol, retry and dead-lettering, operator requeue, page-level checkpointing and crash recovery,
idempotency, duplicate submission, the versioned Node→Python payload, progress, cancellation, and
the DB grants that make all of it enforceable rather than conventional.

**Out of scope, owned elsewhere and cited never restated:** every numeric limit
(`f2-canonical-limits.md`), the tenant/visibility/uniqueness model (`f1-tenant-visibility-model.md`),
everything the AI worker does after it claims an `AI_EXTRACT` row (`f3-ai-call-placement.md`),
retention periods (`gate-2-pdpa-retention.md`), the object-key grammar
(`f1-tenant-visibility-model.md` §11.1 — unresolved, one constraint imposed), the OCR engine (`d`),
native-vs-OCR routing (`e`), preprocessing (`f`), and the public API envelope (`l`).

**The owner's instruction that governs every choice below: prefer the simplest safe design.**
Where M0 offered a mechanism and a simpler mechanism provably delivers the same guarantee at the
frozen numbers, the simpler one ships and the more complex one is written down with a *numeric*
trigger that reopens it. Four M0 artefacts are deleted outright by that rule (§9.1, §15.1, §7.4,
§8.3).

---

## 0. What this document settles

| M0 item | State before | Settled here |
|---|---|---|
| **Contradiction 6** — the queue was designed twice (`g` §5.5 vs `h` §6.2) | two tables, two column sets, two lease shapes, two retry budgets | **D-C2-2 … D-C2-5, §17** |
| "One job table" | `extraction_jobs` (`g`) vs `ocr_jobs` (`h`, and `f3` inherits `h`'s name) | **`extraction_jobs`** (D-C2-2) |
| "One tenant column name" | `organization_id` (`g`, `f1`) vs `tenant_id` (`h`) | **`organization_id`** — frozen by `f1` `tenant.scope_column`; adopted, not re-decided |
| "One priority direction" | `priority ASC` (`g`) vs `priority DESC` (`h`); `h` §1.5 flagged this as making the claim index wrong | **`priority ASC`, lower runs sooner** (D-C2-5) |
| Lease token: hashed or plaintext | panel required hashed; `h` §6.2 ships plaintext `lease_token uuid` and `h` §11.2 grants `SELECT` on it; `g` §5.5 ships a timestamp lease | **`lease_token_hash bytea`, plaintext returned once by the claim and never stored** (D-C2-8) |
| Operator requeue that cannot violate a unique constraint | `g` §5.5 used a mutable `requeueCount`; `h` L15 requeued by `UPDATE`ing the DEAD row | **New run, new `run_id`, new dedupe keys; 409 if a run is live** (D-C2-12) |
| Fencing enforced or merely conventional | panel: *"fencing is a convention, not a control"* — column-level `GRANT UPDATE` constrains columns, never the `WHERE` clause | **The worker holds no DML on any queue table. Nine `SECURITY DEFINER` functions are the entire surface** (D-C2-6) |
| Budget exhaustion = terminal failure | `h` §13.2 raised non-retryable `BUDGET_EXCEEDED` at page ~108 of 200 | **≥1 page done ⇒ `SUCCEEDED` + `degraded`** — frozen by `f2` `JOB_PROCESSING_BUDGET_MS` / DECISION F2-D6; implemented here (D-C2-10) |

---

## 1. Frozen values this document consumes (cited, never restated)

Read these before reading anything below. Nothing in this document re-derives, renames or rounds
any of them.

| From | Keys consumed |
|---|---|
| `f1-tenant-visibility-model.md` | `tenant.scope_column`, `tenant.root_model`, `id.internal`, `id.external.*`, `uniq.document_run_seq`, `uniq.document_run_one_active`, `uniq.extraction_job_dedupe`, `job.dedupe_key_grammar`, `uniq.ocr_result`, `uniq.document_page`, `db.roles`, `db.guc.org`, `db.rls.children`, `storage.tenant_prefix_check`, `schema.invariants`, `partial_index.policy`, `api.not_found_rule` |
| `f2-canonical-limits.md` | `JOB_PROCESSING_BUDGET_MS`, `JOB_FIXED_OVERHEAD_S`, `AI_STAGE_BUDGET_S`, `JOB_QUEUE_TTL_MS`, `PROVISIONAL_PER_PAGE_OCR_S`, `PAGE_RENDER_TIMEOUT_S`, `PAGE_PARSE_TIMEOUT_S`, `PAGE_OCR_TIMEOUT_S`, `MAX_PAGES_PER_DOCUMENT`, `MAX_OCR_PAGES_PER_DOCUMENT`, `MAX_CONCURRENT_JOBS_GLOBAL`, `WORKER_JOB_CONCURRENCY`, `MAX_CONCURRENT_JOBS_PER_USER`, `MAX_QUEUED_DOCS_PER_USER`, `RENDER_CONCURRENCY`, `WORKER_MEMORY_LIMIT_BYTES`, `LIMITS_SOURCE_OF_TRUTH`, `TUNABLE_LIMITS_IN_SCHEMA`, `ERROR_CODE_QUOTA` |
| `f3-ai-call-placement.md` | `ai.service.name`, `ai.db.role`, `ai.db.rls_policy`, `ai.db.revoked_from_worker`, `ai.ledger`, `ai.idempotency_key`, `ai.job.budget_ms`, `ai.job.max_attempts`, `ai.job.backoff`, `ai.retry.never_reruns_ocr`, `ai.claim.kind_predicate`, `ai.error.taxonomy_owner`, `ai.spool.*`, `ai.concurrency` |
| `gate-2-pdpa-retention.md` | retention periods for `extraction_jobs.payload`, `job_events`, `ai_calls`; `ai.stage.enabled.default` |

Two frozen values are challenged in §21 (both are naming collisions between frozen documents, not
disagreements with a number). Both are implemented as this document states and flagged for
arbitration.

---

## 2. Job identity — and its exact relationship to document, run and attempt

### D-C2-1 — A job is a unit of work inside exactly one run, and is never externally addressable

- **Competing proposals.** (a) `h` §6.2: a job carries `document_id` and nothing else; a requeue is a
  new job with a hashed dedupe key. (b) `g` §5.5: a job carries `document_id` plus a
  `Document.requeueCount` generation stamp. (c) `f1` D-F1-12: four identities — Document, Run, Job,
  Attempt — with `document_runs` as a first-class table. (d) Additionally expose a `public_id` on the
  job so clients can poll a job URL, mirroring `f1` VIS-1.
- **Selected.** (c) for the identity model, **without** (d): `extraction_jobs.run_id` is `NOT NULL`
  with a composite FK `(run_id, organization_id) → document_runs(id, organization_id)`, and
  `extraction_jobs` carries **no `public_id`**.
- **Rejected.**
  - (a) — a job with no run has nothing for `ocr_results.run_id` to point at, and the frozen
    `uniq.ocr_result` key requires `run_id`.
  - (b) — a mutable counter on a hot row; `f1` D-F1-12 already rejected it and deleted
    `Document.requeueCount`.
  - (d) — a job id on the wire is a second enumerable surface with its own 404 rule, its own rate
    limit and its own timing floor (`f1` `api.not_found_rule`, `api.not_found_floor_ms`), bought for
    nothing: the client already has `doc_<32 chars>` and every question it can ask is "how is this
    document doing". `f1` VIS-1 ("every externally-addressable model has a `publicId`") is satisfied
    **vacuously**, which is strictly stronger than satisfying it with another identifier.
- **Reason.** The four identities are `f1`'s (cite `f1` D-F1-12; not restated). The queue-side
  consequence is the one thing this document adds: **`run_id` is what makes every uniqueness
  constraint in the system requeue-safe**, because it appears in the job dedupe key
  (`f1` `job.dedupe_key_grammar`) and in the evidence key (`f1` `uniq.ocr_result`). An attempt
  remains what `f1` says it is — `extraction_jobs.attempts` plus `job_events`, never a row of its own.
- **Implementation consequence.** Public surface is
  `GET /v1/documents/{public_id}` (current run summary) and
  `GET /v1/documents/{public_id}/runs/{run_seq}` (per-run detail, including the job list). Job UUIDs
  appear only in operator tooling, `job_events`, logs and metrics. `l`'s batch-status endpoint keys
  on `public_id`, capped by `f2` `MAX_STATUS_IDS_PER_QUERY`.
- **Migration consequence.** `run_id` must be `NOT NULL` from migration 0004 — the same
  un-backfillable constraint `f1` D-F1-12 records for `ocr_results`. `document_runs` is created
  before the first job row can exist.
- **Security consequence.** Removes an enumeration surface and removes the need to decide whether a
  job id leaks a run count. It also means a compromised worker that learns a job UUID learns nothing
  addressable from the internet.
- **Config/env consequence.** None.

### 2.1 The identity table, queue-side

| Question the queue must answer | Answered by | Cost |
|---|---|---|
| "Which pages of this pass are already done?" | `SELECT document_page_id FROM ocr_results WHERE run_id = $1` | one index scan (`f1` `uniq.ocr_result` leads with `document_page_id`; add `ocr_result_run_idx` on `(run_id)` — §17.3) |
| "Is this the same work as something already queued?" | `f1` `uniq.extraction_job_dedupe` + `f1` `job.dedupe_key_grammar` | one unique-index probe |
| "How many times has this exact job been executed?" | `extraction_jobs.attempts` | column read |
| "How many times has page 47 hard-failed inside this job?" | `job_events` where `kind='PAGE_FAILED_CONTENT' AND page_no=47` | partial index probe (§9.2) |
| "Is a reprocess of this document legal right now?" | `f1` `uniq.document_run_one_active` | one partial-unique probe |

---

## 3. One table, one status vocabulary, one direction

### D-C2-2 — The table is `extraction_jobs`; the event table is `job_events`

- **Competing proposals.** (a) `g` §5.5: `extraction_jobs` / `job_events`. (b) `h` §6.2:
  `ocr_jobs` / `ocr_job_events` (and `h` L22 already conceded `extraction_jobs` while continuing to
  write `ocr_jobs` "for readability"). (c) `f3` frozen text writes `ocr_jobs` in
  `ai.db.rls_policy` and `ai.claim.kind_predicate`.
- **Selected.** **`extraction_jobs`** (Prisma `ExtractionJob`) and **`job_events`** (Prisma
  `JobEvent`).
- **Rejected.** (b) and (c) — `f1` is the frozen schema authority and every frozen key it publishes
  uses `g`'s names: `uniq.extraction_job_dedupe` maps to `extraction_job_org_dedupe_key`,
  `db.rls.children` enumerates `extraction_jobs` and `job_events`, and
  `storage.tenant_prefix_check` names `extraction_jobs.result_ref`. Renaming three frozen index
  names to preserve `h`'s prose is the wrong direction.
- **Reason.** The name that appears in a frozen constraint identifier wins, because an index name is
  an executable artefact and a section heading is not.
- **Implementation consequence.** Every occurrence of `ocr_jobs`, `ocr_job_events` and
  `OcrJobState` in `h` and in `f3`'s two SQL fragments is renamed. `f3`'s
  `queue_ai_all_orgs` policy is created on `extraction_jobs`; nothing else about it changes.
- **Migration consequence.** None if settled before migration 0004, which is the point of settling
  it here. After 0004 it is an `ALTER TABLE … RENAME` plus a Prisma `@@map` change plus a rename of
  every dependent index, policy, trigger and function — `hard` reversibility, exactly as `h` L22
  said.
- **Security consequence.** None directly. Indirectly: `f3`'s frozen `ai.db.rls_policy` is
  *unreachable* if it is created on a table that does not exist, and `CREATE POLICY` on a missing
  table is a migration error rather than a silent no-op — so this is caught loudly either way.
- **Config/env consequence.** Metric label `table="extraction_jobs"`; `f3`'s `emitter` values
  unchanged.

### D-C2-3 — `JobStatus` with six values; `SUCCEEDED` is the only success state

- **Competing proposals.** (a) `g`: `JobStatus` / column `status`. (b) `h`: `OcrJobState` / column
  `state`, values `PENDING RUNNING SUCCEEDED FAILED CANCELLED DEAD`. (c) `f2` D-F2-6's raised
  question: add `SUCCEEDED_PARTIAL` for a time-budget breach with pages completed.
- **Selected.** `enum JobStatus { PENDING RUNNING SUCCEEDED FAILED DEAD CANCELLED }`, column
  `status`. Partial completion is `status = 'SUCCEEDED'` with `degraded = true` and a
  `result.warnings[]` entry.
- **Rejected.**
  - `h`'s enum *name* and column name — `g`/`f1` own the schema vocabulary (D-C2-2's reason).
  - (c) — `f2` D-F2-6 itself recommends against it: *"adding a state to a state machine with
    CHECK-guarded transitions is far more invasive than adding a column, and every consumer of 'did
    it succeed' stays correct by default."* Adopted verbatim as a decision here, since `f2`
    explicitly deferred it to the queue dimension.
- **Reason.** Four terminal states, each with a distinct operator meaning:
  `SUCCEEDED` (done, possibly degraded — a customer outcome), `FAILED` (this work is not doable as
  submitted — a customer outcome, `userFacing`), `DEAD` (we could not do it after N attempts — an
  operator outcome), `CANCELLED` (a human stopped it). Public mapping to `l`'s enum
  (`queued|processing|succeeded|failed|cancelled`): `DEAD → failed`, deliberately indistinguishable
  from outside.
- **Implementation consequence.** `degraded Boolean @default(false)` is indexed for the ops view;
  the warning list lives inside the ≤64 KiB `result` JSONB, not in a `text[]` column, so it does not
  widen the hot row.
- **Migration consequence.** The enum is created once in migration 0004. Adding a value later is an
  `ALTER TYPE … ADD VALUE` (non-transactional before PG12, transactional from PG12 — we are on 17),
  removing one is a table rewrite. Six is deliberately the floor, not a starting point.
- **Security consequence.** `DEAD` never reaches a client, so the number of internal retries a
  platform performed is not disclosed.
- **Config/env consequence.** None.

### D-C2-4 — `JobKind` has exactly two members in M1

- **Competing proposals.** (a) `h`: `DOCUMENT_EXTRACT | AI_EXTRACT`. (b) a per-stage split
  (`RENDER | OCR | ASSEMBLE | AI_EXTRACT`) enabling `h` §8.3's per-page fan-out. (c) `g`'s `JobKind`
  with unenumerated members.
- **Selected.** `enum JobKind { DOCUMENT_EXTRACT AI_EXTRACT }`.
- **Rejected.** (b) — fan-out needs a fan-in barrier, a parent/child column, a
  `pages_total NOT NULL`-before-children invariant and a reaper pass for barriers that never fire
  (`h` §8.3's own three corrections). At `f2` `MAX_CONCURRENT_JOBS_GLOBAL = 4` there is nothing to
  fan out *to*: splitting one document across four slots and then capping one organisation at
  `MAX_CONCURRENT_JOBS_PER_USER = 2` makes single-document latency *worse*, not better. (c) — an
  unenumerated enum is not a contract.
- **Reason.** `f3` `ai.retry.never_reruns_ocr` already froze that `AI_EXTRACT` is a separate row with
  its own budget and DLQ path, so two kinds is the minimum that satisfies a frozen value, and the
  third would buy nothing at the frozen concurrency.
- **Implementation consequence.** `ocr_claim_v1` takes `p_kinds text[]`; `ocr-worker` passes
  `{DOCUMENT_EXTRACT}` and `ocr-ai-worker` passes `{AI_EXTRACT}` — this is `f3`
  `ai.claim.kind_predicate`, implemented (§6.1).
- **Migration consequence.** Adding `RENDER`/`OCR`/`ASSEMBLE` later is `ALTER TYPE … ADD VALUE` plus
  a parent-id column plus the barrier; it is additive and needs no rewrite.
- **Security consequence.** A two-value enum makes `f3`'s frozen `queue_ai_all_orgs`
  (`USING (kind = 'AI_EXTRACT')`) an exact complement of the OCR worker's reach.
- **Config/env consequence.** None.
- **Fan-out reopens when, numerically:** `MAX_CONCURRENT_JOBS_GLOBAL > 8` **and** measured
  single-document p95 wall time exceeds 15 min at the M-1 measured per-page constant. Neither holds
  at any frozen value today.

### D-C2-5 — `priority ASC`: **lower number runs sooner**

- **Competing proposals.** (a) `g` §5.5: `ORDER BY priority ASC, available_at ASC`, index
  `extraction_job_claim_idx (status, priority, available_at)`. (b) `h` §7.2 / L16:
  `ORDER BY priority DESC, available_at ASC`, requiring a mixed-direction index
  `(priority DESC, available_at ASC) WHERE status='PENDING'`, with `h` §1.5 noting *"if it is not
  fixed, every priority in §7.2 is inverted and backfills pre-empt interactive uploads."*
- **Selected.** **(a) `priority ASC`. `priority` is a rank: 1 is the most urgent, 1000 the least.**
- **Rejected.** (b) — three reasons, in order of weight.
  1. A same-direction composite `(priority, available_at)` is a plain forward btree scan. The mixed
     form is legal but is a second index shape that must be written `DESC` in exactly one place and
     silently degrades to a sort if anyone writes it ascending. That is a class of bug that produces
     *correct results at the wrong latency*, which is the hardest kind to notice.
  2. `g` already publishes the index name `extraction_job_claim_idx` and `f1`'s frozen index-name
     convention is `g`'s. Keeping the direction keeps the name honest.
  3. Rank-ascending is the convention of every queue the operator has touched (BullMQ: lower value =
     higher priority; Unix `nice`; Celery `priority` on Redis).
  The counter-argument for (b) — *"higher number = more important reads naturally"* — is real and is
  paid for once, in a comment on the column and in the band table below.
- **Reason.** The direction is worth one decision only because both documents wrote a claim
  statement, and a claim statement with the wrong `ORDER BY` inverts the entire fairness design
  without failing any test that does not measure ordering.
- **Implementation consequence — the bands, stated once, in the chosen direction:**

  | Source | `priority` | Reason |
  |---|---|---|
  | Interactive single upload (a human is watching) | **10** | latency-sensitive, one page most of the time |
  | Interactive multi-file upload | **20** | |
  | Operator requeue of a `DEAD`/`FAILED` document | **40** | must clear promptly, must not pre-empt a live user |
  | API submission | **100** | |
  | Bulk/batch import | **300** | throughput-oriented |
  | Reprocess / backfill / engine upgrade | **800** | never competes with live traffic |

  **Backlog decay at enqueue** (a heuristic, explicitly *not* the fairness guarantee):
  ```ts
  const pending = await tx.extractionJob.count({
    where: { organizationId, status: "PENDING" },
  });
  const priority = Math.min(900, base + Math.min(400, Math.floor(pending / 5) * 5));
  ```
  **Ageing sweep**, every 300 s, measured from `created_at` because `available_at` moves forward on
  every retry (`h` §7.3's correction, kept):
  ```sql
  UPDATE extraction_jobs
     SET priority = GREATEST(30, priority - 5), updated_at = now()
   WHERE status = 'PENDING'
     AND created_at < now() - interval '600 seconds'
     AND priority > 30;
  ```
  **Floor 30, not 10.** A backfill must never become indistinguishable from an interactive upload;
  30 is strictly worse than both interactive bands (10, 20) and strictly better than API (100). A
  backfill at 800 reaches 30 in `(800-30)/5 × 300 s = 46 200 s ≈ 12.8 h`, which is the documented
  worst-case starvation bound and belongs in the SLO. A decayed interactive job (10 + 400 = 410)
  recovers its band in `(410-30)/5 × 300 s ≈ 6.3 h`; it is capped at 900 so it can never sort behind
  a fresh backfill's tail.
- **Migration consequence.** The column default changes from `h`'s 100-as-middling to
  **`@default(100)`** meaning "API submission", which is the same literal and a different meaning —
  so a stale comment is the only migration hazard. The column comment is mandatory:
  `COMMENT ON COLUMN extraction_jobs.priority IS 'RANK. Lower runs sooner. See c2-queue-contract.md D-C2-5.';`
- **Security consequence.** None. Priority is not a trust boundary; the in-flight cap is (§14).
- **Config/env consequence.** The six band constants live in `config/limits.yaml` under
  `queue.priority.*` and are generated into `@innovera/ocr-limits`, per `f2`
  `LIMITS_SOURCE_OF_TRUTH`. No layer reads a literal.

---

## 4. Roles and grants — fencing becomes a control, not a convention

### D-C2-6 — The workers hold **no DML on any queue table**. Nine `SECURITY DEFINER` functions are the entire surface

- **Competing proposals.** (a) `h` §11.2: column-level `GRANT UPDATE (…) ON ocr_jobs TO ocr_worker`
  plus table `GRANT SELECT`, with the lease enforced by a `WHERE lease_token = $2` the worker itself
  chooses to send. (b) The panel's stopgap: keep the grants, hash the token, and add a
  `BEFORE UPDATE` trigger rejecting any change where
  `OLD.lease_token IS DISTINCT FROM current_setting('app.lease_token')`. (c) The panel's full
  recommendation: revoke all DML and expose the protocol as `SECURITY DEFINER` functions.
- **Selected.** **(c).** Nine functions owned by `ocr_owner`, `SET search_path = public`, no dynamic
  SQL, `REVOKE EXECUTE … FROM PUBLIC`:
  `ocr_claim_v1`, `ocr_heartbeat_v1`, `ocr_progress_v1`, `ocr_event_v1`,
  `ocr_finish_ok_v1`, `ocr_finish_err_v1`, `ocr_finish_cancelled_v1`,
  `ocr_page_result_v1`, `ocr_reap_v1`.
- **Rejected.**
  - (a) — the panel's finding is arithmetic, not opinion: a column-level `GRANT UPDATE` constrains
    *which columns* may be written and places no constraint whatsoever on the `WHERE` clause, so
    `UPDATE extraction_jobs SET status='SUCCEEDED', result_ref='<attacker key>' WHERE organization_id='<victim>' AND status='RUNNING'`
    is permitted by the grants and by `USING (true)` RLS. `h` §11.2.1's assertion that the outbox
    trigger fires only *"for a row it holds the lease on"* is false under those grants.
  - (b) — a bridge, not an answer. It leaves the `ai_calls` billing-tamper path
    (`UPDATE ai_calls SET cost_micros = 0`) and the cross-organisation `SELECT` open. It also puts
    the lease token in a GUC that the same compromised process sets.
- **Reason.** `f3` already froze exactly this shape for the AI side —
  `ai.db.role`: *"all else via four `SECURITY DEFINER` functions (`ocr_ai_claim_v1`,
  `ocr_ai_heartbeat_v1`, `ocr_ai_complete_v1`, `ocr_ai_abort_v1`) owned by `ocr_owner`"*. Applying
  two different enforcement models to two workers that claim from the same table would be the
  contradiction this milestone exists to remove. **Nine functions is not more complex than seven raw
  statements: it is the same seven statements, plus two, moved inside a function body.** The SQL is
  unchanged; only who may send it changes.
- **Implementation consequence.** `f3`'s frozen `ocr_ai_claim_v1` and `ocr_ai_abort_v1` are **thin
  wrappers** over `ocr_claim_v1` and `ocr_finish_cancelled_v1` with `p_kinds` fixed to
  `{AI_EXTRACT}`; `f3`'s `ocr_ai_heartbeat_v1` wraps `ocr_heartbeat_v1`; `f3`'s
  `ocr_ai_complete_v1` wraps `ocr_finish_ok_v1` **and** performs the `ai_calls` ledger write that
  `f3` `ai.ledger` owns. One implementation, two entry points, both frozen names preserved.
- **Migration consequence.** The functions are created in migration 0005, immediately after the
  tables. `CREATE OR REPLACE FUNCTION` is transactional and needs no table lock, so a protocol change
  is a migration that does not touch a row — strictly cheaper than the column-grant model, where
  adding a writable column is a `GRANT` change coordinated with a deploy.
- **Security consequence.** This is the change that converts every remaining item on the panel's
  security list from *accepted residual risk* to *closed*:
  - `h` L25 (*"a compromised worker can enumerate every organisation's document identifiers and
    storage keys platform-wide"*) — **closed.** `ocr_queue` has no `SELECT` on `extraction_jobs`;
    the only read path is `ocr_claim_v1`, which returns exactly one row, the one it just leased.
  - Cross-tenant job forgery — **closed.** No `UPDATE` grant exists.
  - `ai_calls` billing tamper by `ocr_worker` — **closed** by `f3` `ai.db.revoked_from_worker`
    (cited, already frozen), and additionally by the absence of any `ocr_worker` grant here.
  - Forged audit rows in `job_events` — **closed.** `ocr_event_v1` stamps `job_id`,
    `organization_id`, `attempt` and `locked_by` **from the leased row**, never from an argument.
- **Config/env consequence.** None new. The worker's DSNs are `f1`'s frozen
  `DATABASE_URL_QUEUE` and `DATABASE_URL_WORKER`.

### D-C2-7 — Two roles for the Python worker process, restoring `g`'s two blast radii

- **Competing proposals.** (a) `h` §11.5: *"`ocr_worker` **is** G's `ocr_queue`. They are the same
  role under two names; that is the whole conflict"* — one role, `USING (true)` on four tables for
  the entire processing lifetime. (b) `g` §5.5 and `f1` `db.roles`: two roles — `ocr_queue` for the
  cross-tenant claim only, then *"the processing transaction switches to `ocr_app` with
  `app.current_org` set from the claimed row"*. (c) `f1` `db.roles` as frozen: five roles, with
  `ocr_worker` = *"the OCR/AI worker after it has claimed a job; tenant filtered, visibility-blind"*
  and `ocr_queue` = *"the queue claim only"*.
- **Selected.** **(c), which is (b) with the processing role being `ocr_worker` rather than
  `ocr_app`.** The `ocr-worker` container opens **two** connection pools:

  | Pool | Role | DSN (frozen, `f1` `db.roles`) | Used for | RLS |
  |---|---|---|---|---|
  | queue pool, size 1 per worker process | `ocr_queue` | `DATABASE_URL_QUEUE` | `EXECUTE` on the nine functions, and nothing else | policy `queue_claim_all_orgs` `USING (true)` — unreachable in practice, kept as the second wall |
  | work pool, size `WORKER_JOB_CONCURRENCY` | `ocr_worker` | `DATABASE_URL_WORKER` | `document_pages` upsert, `ocr_results` insert, `document_analyses` insert | tenant-only policies (`f1` `db.rls.children`), under `SET LOCAL app.current_org` (`f1` `db.guc.org`) set from the **claimed row**, never from a request |
- **Rejected.** (a) — it is the deletion of `g`'s second blast radius, and the panel identified it as
  adopted silently. Under (a) a compromised worker reads `ocr_results.payload_ref` and
  `ai_calls.response_uri` for every organisation for the whole processing lifetime; under (c) it
  reads them only for the single organisation whose job it currently holds, because
  `app.current_org` is a transaction-local GUC and the tenant-only policy is the same one `ocr_app`
  runs under.
- **Reason.** The claim is the *only* statement that must span organisations. Everything after it
  knows exactly one organisation. Confining `USING (true)` to that one statement is free.
- **Implementation consequence.** The Python worker's `JobStore` protocol splits: `claim()`,
  `heartbeat()`, `progress()`, `finish_*()`, `reap()` take the queue connection; every other write
  takes a work connection opened with
  `SELECT set_config('app.current_org', $1, true)` as the first statement of the transaction
  (`f1` `db.guc.setter`: `is_local = true`, parameterised, never concatenated).
  `f3`'s `ocr-ai-worker` is symmetric: `AI_WORKER_DATABASE_URL` (frozen, `f3` `ai.db.role`) for the
  ledger, and the queue functions for the protocol.
- **Migration consequence.** `ocr_queue` and `ocr_worker` already exist in `f1`'s frozen bootstrap
  role list, so this is a `GRANT` change only, in migration 0005.
- **Security consequence.** Restores the property `g` stated and `h` removed. Also removes the need
  for `h` L26's per-claim minted object-storage credential to be the *sole* mitigation for L25 —
  L25 is closed by D-C2-6 independently, so the credential design becomes defence in depth rather
  than load-bearing. (The mint-binding itself is still open; see §21 and `f3` §5's note that it
  remains unowned.)
- **Config/env consequence.** `DATABASE_URL_QUEUE` and `DATABASE_URL_WORKER` are both required on
  `ocr-worker`; the boot assertion refuses to start if either is missing **or if they are equal**.

### 4.1 The grants, exactly

```sql
-- ============================================================================
-- migration 0005_queue_protocol.sql   (roles already exist; f1 §5.1 bootstrap)
-- ============================================================================

-- ---- ocr_queue: EXECUTE only. No table privilege of any kind. -------------
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM ocr_queue;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ocr_queue;
GRANT  USAGE ON SCHEMA public TO ocr_queue;

GRANT EXECUTE ON FUNCTION
      ocr_claim_v1(text, text[], int, int),
      ocr_heartbeat_v1(uuid, text, int),
      ocr_progress_v1(uuid, text, varchar, int, int, int),
      ocr_event_v1(uuid, text, varchar, int, int, jsonb),
      ocr_finish_ok_v1(uuid, text, jsonb, varchar, boolean, int),
      ocr_finish_err_v1(uuid, text, varchar, jsonb, boolean, int, int),
      ocr_finish_cancelled_v1(uuid, text, jsonb, varchar, int),
      ocr_page_result_v1(uuid, text, uuid, varchar, jsonb),
      ocr_reap_v1()
   TO ocr_queue;

-- ---- ocr_worker: the processing surface, tenant-scoped by RLS -------------
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ocr_worker;
GRANT  USAGE ON SCHEMA public TO ocr_worker;
GRANT  SELECT, INSERT, UPDATE ON document_pages     TO ocr_worker;
GRANT  SELECT, INSERT         ON ocr_results        TO ocr_worker;
GRANT  SELECT, INSERT         ON document_analyses  TO ocr_worker;
GRANT  SELECT, INSERT         ON storage_objects    TO ocr_worker;
GRANT  EXECUTE ON FUNCTION
      ocr_heartbeat_v1(uuid, text, int),
      ocr_progress_v1(uuid, text, varchar, int, int, int),
      ocr_event_v1(uuid, text, varchar, int, int, jsonb),
      ocr_page_result_v1(uuid, text, uuid, varchar, jsonb)
   TO ocr_worker;
-- NOT granted to ocr_worker, ever: extraction_jobs, job_events, documents,
-- document_runs, ai_calls, extraction_field_values, corrections, document_grants,
-- users, memberships, api_keys, sessions, audit_logs, outbox_events,
-- idempotency_records, organizations, workspaces, platform_staff,
-- admin_access_grants, admin_access_logs, document_keys.

-- ---- ocr_ai_worker: f3 ai.db.role, cited not restated ---------------------
GRANT EXECUTE ON FUNCTION
      ocr_ai_claim_v1(text, int, int),
      ocr_ai_heartbeat_v1(uuid, text, int),
      ocr_ai_complete_v1(uuid, text, jsonb, varchar, jsonb),
      ocr_ai_abort_v1(uuid, text, varchar)
   TO ocr_ai_worker;

-- ---- a future migration must not silently widen any of this ---------------
ALTER DEFAULT PRIVILEGES FOR ROLE ocr_owner IN SCHEMA public
  REVOKE ALL ON TABLES    FROM ocr_queue, ocr_worker, ocr_ai_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE ocr_owner IN SCHEMA public
  REVOKE ALL ON FUNCTIONS FROM PUBLIC, ocr_queue, ocr_worker, ocr_ai_worker;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
```

### 4.2 RLS, and the trap that `FORCE ROW LEVEL SECURITY` sets for a `SECURITY DEFINER` function

`f1` freezes `FORCE ROW LEVEL SECURITY`, which **applies to the table owner too**. A
`SECURITY DEFINER` function owned by `ocr_owner` therefore runs *under* RLS, and with no policy
naming `ocr_owner` the claim returns zero rows — a queue that appears permanently empty on a system
where every other test passes. This is the same failure `h` §11.5 identified for `ocr_worker` and
did not re-check for the definer.

```sql
ALTER TABLE extraction_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE extraction_jobs FORCE  ROW LEVEL SECURITY;
ALTER TABLE job_events      ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_events      FORCE  ROW LEVEL SECURITY;

-- (1) The app: tenant-only, per f1 db.rls.children. Unchanged, restated as a grant constraint only.
CREATE POLICY org_isolation ON extraction_jobs FOR ALL TO ocr_app
  USING      (organization_id = nullif(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);
CREATE POLICY org_isolation ON job_events FOR ALL TO ocr_app
  USING      (organization_id = nullif(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);

-- (2) The definer exception. This is the ONLY cross-organisation policy in the system, it names
--     two tables, and ocr_owner reaches these tables from exactly two places: a migration, and the
--     body of one of the nine functions. NEVER `ALTER ROLE ocr_owner BYPASSRLS` — that would grant
--     bypass on users, api_keys and documents as well, forever, from one flag in pg_roles.
CREATE POLICY queue_definer_all_orgs ON extraction_jobs FOR ALL TO ocr_owner
  USING (true) WITH CHECK (true);
CREATE POLICY queue_definer_all_orgs ON job_events      FOR ALL TO ocr_owner
  USING (true) WITH CHECK (true);
COMMENT ON POLICY queue_definer_all_orgs ON extraction_jobs IS
  'FORCE RLS applies to the owner. Without this the SECURITY DEFINER claim returns zero rows. '
  'See c2-queue-contract.md D-C2-6 / §4.2.';

-- (3) Belt and braces. Neither role holds a table grant under D-C2-6, so neither policy is
--     reachable today. They exist so that if a future migration grants a table privilege by
--     mistake, the blast radius is already bounded rather than USING (true).
CREATE POLICY queue_claim_all_orgs  ON extraction_jobs FOR ALL TO ocr_queue
  USING (true) WITH CHECK (true);
-- f3 ai.db.rls_policy, verbatim except for the frozen table rename of D-C2-2:
CREATE POLICY queue_ai_all_orgs     ON extraction_jobs FOR ALL TO ocr_ai_worker
  USING (kind = 'AI_EXTRACT') WITH CHECK (kind = 'AI_EXTRACT');
```

**Startup assertion (fail loud, never fail quiet), per `f1` `db.backup.globals`' reasoning:**
`extraction_jobs` must report `relrowsecurity AND relforcerowsecurity` and **≥ 4** rows in
`pg_policies`; `ocr_queue` must hold **zero** rows in
`information_schema.table_privileges`. A role-less or policy-less restore otherwise returns zero
rows for every query with no error raised.

---

## 5. The lease

### D-C2-8 — `lease_token_hash bytea`. The plaintext is minted in the database, returned once, and never stored

- **Competing proposals.** (a) `g` §5.5: a timestamp lease — `locked_at` / `locked_by` /
  `lease_until`, guarded by `WHERE locked_by = $2 AND lease_until > now()`. (b) `h` L4 / §6.2: a
  random `lease_token uuid` column, plaintext, with `h` §11.2 explicitly granting
  `SELECT (… lease_token …)` to the worker. (c) The panel: *"make the lease token a secret, not a
  readable column. Store `lease_token_hash bytea` (SHA-256); the claim returns the plaintext exactly
  once."*
- **Selected.** **(c).** `lease_token_hash bytea` (32 bytes). `ocr_claim_v1` generates a 256-bit
  token with `gen_random_bytes(32)`, stores only `sha256(...)`, and returns the hex plaintext in its
  result row. No `SELECT` path in the system yields a usable token.
- **Rejected.**
  - (a) — `h` §1.1's objection stands and is not stylistic: two claims can land inside one `now()`
    value (`now()` is transaction-start time and is *identical* for every statement in a
    transaction), and any clock adjustment or `SET TIME ZONE` mistake breaks the guard. A timestamp
    is not a nonce.
  - (b) — the panel's finding is decisive:
    `SELECT id, organization_id, payload, lease_token FROM extraction_jobs WHERE status='RUNNING'`
    under `USING (true)` returns *a live, valid capability for every running job on the platform*.
    That defeats the fencing guarantee, and it also defeats `h` L26, whose per-claim storage
    credential must be authorised by something the worker presents — and the only candidate `h`
    offers is the lease token.
  - A UUID as the token (even hashed) — 122 bits of entropy is enough, but there is no reason to
    take a 122-bit primitive when a 256-bit one is one function call away, and a `uuid`-typed column
    invites someone to log it.
- **Reason.** Three properties, none of which (a) or (b) has: the token is **unguessable** (2^256),
  **unreadable** (only its hash is at rest), and **unforgeable by the holder of a DB role** (it is
  minted inside the definer function, not supplied by the caller).
- **Implementation consequence.**

  | Constant | Value | Env | Reason |
  |---|---|---|---|
  | `LEASE_TTL_S` | **90** | `OCR_QUEUE_LEASE_TTL_S` | 6× the heartbeat interval: five consecutive misses before expiry |
  | `HEARTBEAT_INTERVAL_S` | **15** | `OCR_QUEUE_HEARTBEAT_INTERVAL_S` | must be < `LEASE_TTL_S / 5`; also the cancellation-detection interval (§13) |
  | `REAP_INTERVAL_S` | **15** | `OCR_QUEUE_REAP_INTERVAL_S` | crash detection ≤ `LEASE_TTL_S + REAP_INTERVAL_S` = **105 s** |
  | `POLL_INTERVAL_S` | **2** | `OCR_QUEUE_POLL_INTERVAL_S` | the correctness floor; `NOTIFY` only shortens it (§15) |
  | `REAP_GRACE_S` | **120** | `OCR_QUEUE_REAP_GRACE_S` | budget-overrun grace: `assemble` + result upload must fit inside it |

  `h`'s 120 s / 30 s pair is tightened to 90 s / 15 s. The reason is cancellation, not crash
  detection: §15 deletes the abort `NOTIFY` channel, so the heartbeat becomes the *only* cancel
  path and its period is the dominant term in cancel latency. The margin is *better* than `h`'s
  (6× vs 4×) because a blocking OCR call can no longer starve the heartbeat — it runs in a separate
  process (§9.4).

  **The heartbeat is the single mechanism with two causes.** `ocr_heartbeat_v1` returns
  `(abort_requested, abort_reason, deadline_at)`; **zero rows means the lease is lost and the worker
  MUST stop immediately** — no further writes, no result, no completion. That is the fencing
  property, and under D-C2-6 it is now enforced by the absence of any other write path rather than
  by the worker's own `WHERE` clause.
- **Migration consequence.** `bytea` not `uuid`, so a later move to a longer hash is a column type
  change on a column that is `NULL` on every non-`RUNNING` row — i.e. on a handful of rows at any
  instant. `h`'s `uuid` column would have forced a rewrite.
- **Security consequence.** Closes the panel's token-harvesting path. Note explicitly what is *not*
  claimed: `sha256(...) = ...` in a `WHERE` clause is **not** a constant-time comparison. That is
  irrelevant here — an attacker cannot mount a timing oracle against a 256-bit value they must first
  guess, and the comparison is a PK-qualified single-row equality. Recorded so nobody "fixes" it
  with `pgcrypto`'s `crypt()` and makes the claim path 100× slower.
- **Config/env consequence.** Five `OCR_QUEUE_*` variables above, all generated from
  `config/limits.yaml` per `f2` `LIMITS_SOURCE_OF_TRUTH`, all with the mandatory `_S` unit suffix.
  `gen_random_bytes` requires `pgcrypto`; migration 0001 runs `CREATE EXTENSION IF NOT EXISTS
  pgcrypto`. Core-only fallback, if pgcrypto is ever refused:
  `encode(uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid()), 'hex')` — 244 effective
  bits from the same CSPRNG, no extension.

**Superseded M0 text, named exactly.** `h` §6.2's
`leaseToken String? @map("lease_token") @db.Uuid`; `h` §11.2's
`GRANT SELECT (id, tenant_id, …, lease_token, lease_expires_at, …) ON ocr_jobs TO ocr_worker`;
`h` §6.3 statements 2/3/4a/4b and §12.4 statement 4c wherever they read
`lease_token = $2::uuid`; and `g` §5.5's `locked_at` / `lease_until` timestamp lease and its
`WHERE id=$1 AND locked_by=$2 AND status='RUNNING' AND lease_until > now()` guard. `locked_by` is
**retained** as a non-secret operator label (which worker holds it), and is never a guard.

---

## 6. The protocol, as real SQL

Seven statements, nine functions (`ocr_page_result_v1` and `ocr_event_v1` are the two that were
never statements in `h` and were therefore unfenced). Every function is
`LANGUAGE plpgsql SECURITY DEFINER SET search_path = public`, owned by `ocr_owner`, with no dynamic
SQL and no parameter that names a row the caller does not already hold a lease on.

### 6.1 Claim

```sql
CREATE FUNCTION ocr_claim_v1(
  p_worker_id text,
  p_kinds     text[],          -- f3 ai.claim.kind_predicate: {'DOCUMENT_EXTRACT'} or {'AI_EXTRACT'}
  p_org_cap   int,             -- f2 MAX_CONCURRENT_JOBS_PER_USER
  p_lease_s   int              -- LEASE_TTL_S
) RETURNS TABLE (
  job_id uuid, organization_id uuid, document_id uuid, run_id uuid,
  kind text, schema_version int, payload jsonb,
  attempts int, max_attempts int, deadline_at timestamptz, lease_token text
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_token text := encode(gen_random_bytes(32), 'hex');
BEGIN
  RETURN QUERY
  WITH candidate AS (
    SELECT j.id
      FROM extraction_jobs j
     WHERE j.status       = 'PENDING'
       AND j.available_at <= now()
       AND j.kind         = ANY (p_kinds::"JobKind"[])
       -- g §5.5's [ADDED] predicate. Without it, a job that repeatedly loses its lease is
       -- re-claimed forever: attempts climbs past max_attempts and nothing ever sets DEAD,
       -- because the lease sweeper does not go through the failure path.
       AND j.attempts     < j.max_attempts
       -- Per-organisation in-flight cap, with an escape hatch when nobody else is waiting.
       AND ( (SELECT count(*) FROM extraction_jobs r
               WHERE r.status = 'RUNNING'
                 AND r.organization_id = j.organization_id) < p_org_cap
             OR NOT EXISTS (SELECT 1 FROM extraction_jobs o
               WHERE o.status = 'PENDING'
                 AND o.available_at <= now()
                 AND o.kind = ANY (p_kinds::"JobKind"[])
                 AND o.organization_id <> j.organization_id) )
     ORDER BY j.priority ASC, j.available_at ASC        -- D-C2-5
     LIMIT 1
     FOR UPDATE OF j SKIP LOCKED
  )
  UPDATE extraction_jobs j
     SET status           = 'RUNNING',
         attempts         = j.attempts + 1,
         lease_token_hash = sha256(convert_to(v_token, 'UTF8')),
         lease_expires_at = now() + make_interval(secs => p_lease_s),
         locked_by        = p_worker_id,
         locked_at        = now(),
         started_at       = COALESCE(j.started_at, now()),
         -- f2 JOB_PROCESSING_BUDGET_MS is PER CLAIM (h L28). Reset on every claim so a job that
         -- crashed at page 47 gets a full budget for the remaining pages, which is the whole
         -- point of §9's checkpoints.
         deadline_at      = now() + make_interval(secs => j.budget_ms / 1000.0),
         -- Leaving PENDING always clears a stale abort. See D-C2-20.
         abort_requested  = false,
         abort_reason     = NULL,
         updated_at       = now()
    FROM candidate c
   WHERE j.id = c.id
  RETURNING j.id, j.organization_id, j.document_id, j.run_id, j.kind::text,
            j.schema_version, j.payload, j.attempts, j.max_attempts,
            j.deadline_at, v_token;
END; $fn$;
```

**Why this shape and not `h` §6.3's.** `h` §6.3 joins an *aggregating* CTE (`inflight`) into the
locked query level and then flags the whole statement **UNVERIFIED** as its blocking question Q1
(*"does `FOR UPDATE OF j` inside a CTE joined to an aggregating CTE execute on PostgreSQL 17?"*),
with two fallbacks. `h` §7.5 then adds a `LATERAL` variant it says is *"more likely to hit a planner
restriction"*. **The correlated-subquery form above is `h`'s own fallback (a), and it is
unconditionally legal**: PostgreSQL forbids `FOR UPDATE` with `GROUP BY`/`HAVING`/aggregates *at the
same query level*, and a scalar subquery in `WHERE` is a separate query level. **Q1 is therefore
closed by construction rather than deferred to an M1 spike.** Cost: one index probe per candidate
row rejected on the cap. Bounded by `f2` `MAX_QUEUED_DOCS_PER_USER = 25` — the worst case is one
organisation holding the whole head of the priority order, i.e. ≤ 25 probes per claim, which at
`f2` `MAX_CONCURRENT_JOBS_GLOBAL = 4` and `POLL_INTERVAL_S = 2` is ≤ 50 index probes/second across
the platform.

**Why the elastic fair-share CTE of `h` §7.2a is deleted.** At the frozen numbers it is a no-op.
`h`'s formula is `GREATEST(floor_cap, ceil(total_slots / active_orgs))` with
`total_slots = f2 MAX_CONCURRENT_JOBS_GLOBAL = 4` and `floor_cap = f2 MAX_CONCURRENT_JOBS_PER_USER = 2`:

| active orgs | `h` §7.2a effective cap | This claim's cap | Same? |
|---|---|---|---|
| 1 | `GREATEST(2, 4) = 4` | escape hatch fires → bounded only by worker slots = 4 | **yes** |
| 2 | `GREATEST(2, 2) = 2` | 2 | **yes** |
| 3 | `GREATEST(2, 2) = 2` | 2 | **yes** |
| ≥4 | `GREATEST(2, 1) = 2` | 2 | **yes** |

The two forms are **identical at every frozen value**, and the simple form costs one `NOT EXISTS`
instead of a `count(DISTINCT organization_id)` over the whole `PENDING` index on every claim.
**Reopening trigger, numeric:** restore `h` §7.2a's proportional share when
`MAX_CONCURRENT_JOBS_GLOBAL > 6`, at which point `ceil(G/2) > 2 = floor_cap` and the two forms
diverge for the first time.

**The cap is statistical, not an invariant** — `h` §6.3's own correction, kept and restated as a
test obligation: under `READ COMMITTED` two workers claiming in the same instant each compute the
count without seeing the other's uncommitted `RUNNING` row, so with N simultaneous claimers the
transient overshoot is bounded by N. At `f2` `MAX_CONCURRENT_JOBS_GLOBAL = 4` the worst case is 4
instead of 2, which starves nobody. **The acceptance test asserts an outcome — "every single-page
job starts within 60 s while a 500-page job is running" — never the invariant "in-flight never
exceeds 2", which is false.**

### 6.2 Heartbeat, progress, event

```sql
CREATE FUNCTION ocr_heartbeat_v1(p_job uuid, p_token text, p_lease_s int)
RETURNS TABLE (abort_requested boolean, abort_reason varchar, deadline_at timestamptz,
               pages_done int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  RETURN QUERY
  UPDATE extraction_jobs j
     SET lease_expires_at = now() + make_interval(secs => p_lease_s),
         updated_at       = now()
   WHERE j.id = p_job
     AND j.status = 'RUNNING'
     AND j.lease_token_hash = sha256(convert_to(p_token, 'UTF8'))
  RETURNING j.abort_requested, j.abort_reason, j.deadline_at, j.pages_done;
END; $fn$;
-- ZERO ROWS => the lease is lost. The worker MUST abandon the job immediately.

CREATE FUNCTION ocr_progress_v1(p_job uuid, p_token text, p_stage varchar,
                                p_pages_done int, p_pages_total int, p_pct int)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v int;
BEGIN
  UPDATE extraction_jobs j
     SET pages_done     = p_pages_done,
         pages_total    = COALESCE(p_pages_total, j.pages_total),
         progress_stage = p_stage,
         progress_pct   = LEAST(100, GREATEST(0, p_pct)),
         updated_at     = now()
   WHERE j.id = p_job AND j.status = 'RUNNING'
     AND j.lease_token_hash = sha256(convert_to(p_token, 'UTF8'));
  GET DIAGNOSTICS v = ROW_COUNT;
  RETURN v = 1;
END; $fn$;

CREATE FUNCTION ocr_event_v1(p_job uuid, p_token text, p_kind varchar,
                             p_page_no int, p_duration_ms int, p_detail jsonb)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_org uuid; v_attempt int; v_worker varchar; v_id bigint;
BEGIN
  -- Every identity field is read FROM THE LEASED ROW. None is taken from an argument.
  -- This is what makes job_events an audit trail rather than a worker-controlled text field.
  SELECT j.organization_id, j.attempts, j.locked_by
    INTO v_org, v_attempt, v_worker
    FROM extraction_jobs j
   WHERE j.id = p_job AND j.status = 'RUNNING'
     AND j.lease_token_hash = sha256(convert_to(p_token, 'UTF8'));
  IF NOT FOUND THEN RETURN NULL; END IF;                 -- lease lost: write nothing
  IF p_detail IS NOT NULL AND pg_column_size(p_detail) > 4096 THEN
    RAISE EXCEPTION 'JOB_EVENT_DETAIL_TOO_LARGE' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO job_events (id, organization_id, job_id, kind, attempt, page_no,
                          duration_ms, worker_id, detail, at)
  VALUES (gen_random_uuid(), v_org, p_job, p_kind::"JobEventKind", v_attempt, p_page_no,
          p_duration_ms, v_worker, p_detail, now())
  RETURNING seq INTO v_id;
  RETURN v_id;
END; $fn$;
```

`h` §10.3 classified the `ocr_job_events` insert as *"harmless (append-only audit)"* and left it
unfenced. The panel's third security finding is that a 90-day **PDPA** audit trail that the
most-likely-compromised component can write arbitrary cross-tenant rows into is not a record you can
answer a regulator with, and is an unbounded storage-exhaustion vector. `ocr_event_v1` closes both:
lease-gated, org taken from the row, `detail` capped at 4 096 **bytes** (which is ~1 300 Thai
characters — `h` §9.8 invariant T-6, kept).

### 6.3 Completion — three functions, and the defect the panel found in the fourth

```sql
CREATE FUNCTION ocr_finish_ok_v1(p_job uuid, p_token text, p_result jsonb,
                                 p_result_ref varchar, p_degraded boolean,
                                 p_max_result_bytes int)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v int;
BEGIN
  IF p_result IS NOT NULL
     AND (pg_column_size(p_result) > p_max_result_bytes
          OR length(p_result::text) > p_max_result_bytes) THEN
    RAISE EXCEPTION 'JOB_RESULT_TOO_LARGE' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE extraction_jobs j
     SET status           = 'SUCCEEDED',
         result           = p_result,
         result_ref       = p_result_ref,
         degraded         = p_degraded,
         progress_pct     = 100,
         progress_stage   = 'done',
         lease_token_hash = NULL,
         lease_expires_at = NULL,
         locked_by        = NULL,
         -- >>> THE PANEL'S DEFECT (2), FIXED. h §6.3 statement 4a was the ONE completion
         -- statement never updated to clear the flag, so an abort arriving during the final
         -- page's OCR or during `assemble` produced SUCCEEDED + abort_requested=true and a
         -- deterministic, permanently repeatable CHECK violation on already-paid-for work.
         abort_requested  = false,
         abort_reason     = NULL,
         finished_at      = now(),
         updated_at       = now()
   WHERE j.id = p_job AND j.status = 'RUNNING'
     AND j.lease_token_hash = sha256(convert_to(p_token, 'UTF8'));
  GET DIAGNOSTICS v = ROW_COUNT;
  IF v = 1 THEN PERFORM ocr_settle_run_v1(p_job); END IF;
  RETURN v = 1;
END; $fn$;
```

**And the CHECK that made it fatal is deleted, not repaired.** `h` §6.2 replaced
`ocr_jobs_no_abort_before_run` with
`CHECK (NOT (abort_requested = true AND state IN ('SUCCEEDED','DEAD')))`. The panel then showed 4a
violates the replacement. The lesson is not "patch 4a" — it is that **a CHECK referencing
`abort_requested` can throw inside a set-based reaper and wedge reaping platform-wide**, which is
the original defect wearing a new predicate.

> **Decision: no CHECK constraint in this schema references `abort_requested`.** The invariant
> *"`abort_requested` is true only on a `RUNNING` row"* is enforced by the four functions that leave
> `RUNNING` (`ocr_finish_ok_v1`, `ocr_finish_err_v1`, `ocr_finish_cancelled_v1`, `ocr_reap_v1`) and
> by the claim, all five of which clear it, and it is **asserted by the state-machine soak test**
> (§19 T-3): seed one row in every reachable
> `(status, abort_requested, lease_token_hash, deadline_at, started_at, attempts)` combination and
> assert all nine functions complete without raising. That test is what would have caught both the
> original wedge and the panel's 4a defect; a constraint is what caused them.

```sql
CREATE FUNCTION ocr_finish_err_v1(p_job uuid, p_token text, p_code varchar,
                                  p_detail jsonb, p_retryable boolean,
                                  p_class_max_attempts int, p_backoff_cap_s int)
RETURNS varchar LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_status "JobStatus";
BEGIN
  UPDATE extraction_jobs j
     SET status = CASE
           WHEN NOT p_retryable                                         THEN 'FAILED'
           WHEN j.attempts >= LEAST(j.max_attempts, p_class_max_attempts) THEN 'DEAD'
           ELSE 'PENDING' END,
         available_at = CASE
           WHEN p_retryable AND j.attempts < LEAST(j.max_attempts, p_class_max_attempts)
           THEN now() + make_interval(secs => 1 + random() *
                  (LEAST(p_backoff_cap_s, power(2, LEAST(j.attempts, 9))::int) - 1))
           ELSE j.available_at END,
         lease_token_hash = NULL, lease_expires_at = NULL, locked_by = NULL,
         abort_requested  = false, abort_reason = NULL,
         last_error_code  = p_code,
         last_error_detail= p_detail,
         last_error_at    = now(),
         finished_at = CASE
           WHEN p_retryable AND j.attempts < LEAST(j.max_attempts, p_class_max_attempts)
           THEN NULL ELSE now() END,
         updated_at = now()
   WHERE j.id = p_job AND j.status = 'RUNNING'
     AND j.lease_token_hash = sha256(convert_to(p_token, 'UTF8'))
  RETURNING j.status INTO v_status;
  IF v_status IN ('FAILED','DEAD') THEN PERFORM ocr_settle_run_v1(p_job); END IF;
  RETURN v_status::varchar;
END; $fn$;

CREATE FUNCTION ocr_finish_cancelled_v1(p_job uuid, p_token text, p_result jsonb,
                                        p_result_ref varchar, p_max_result_bytes int)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v int;
BEGIN
  UPDATE extraction_jobs j
     SET status = 'CANCELLED',
         result = p_result, result_ref = p_result_ref,
         degraded = true,                       -- a cancelled job is by definition incomplete
         progress_stage = 'cancelled',
         lease_token_hash = NULL, lease_expires_at = NULL, locked_by = NULL,
         abort_requested = false,               -- cleared
         abort_reason = j.abort_reason,         -- RETAINED: it is what the UI shows
         last_error_code = 'CANCELLED_BY_USER',
         last_error_at = now(), finished_at = now(), updated_at = now()
   WHERE j.id = p_job AND j.status = 'RUNNING'
     AND j.lease_token_hash = sha256(convert_to(p_token, 'UTF8'));
  GET DIAGNOSTICS v = ROW_COUNT;
  IF v = 1 THEN PERFORM ocr_settle_run_v1(p_job); END IF;
  RETURN v = 1;
END; $fn$;
```

`ocr_finish_cancelled_v1` is `h` §12.4's statement 4c. Without it the state machine cannot reach
`CANCELLED` from `RUNNING` at all, and routing a cancel through the failure path writes `FAILED` —
which shows a user "failed" for their own deliberate action and corrupts `n`'s
`OcrJobFailureRateHigh` ratio.

### 6.4 The reaper — four passes, one function, and it must never raise

```sql
CREATE FUNCTION ocr_reap_v1()
RETURNS TABLE (pass text, n bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE c bigint;
BEGIN
  -- PASS 1 — REVIVE: the lease expired (worker OOM-killed, container evicted, node reboot).
  WITH r AS (
    UPDATE extraction_jobs j
       SET status = 'PENDING',
           lease_token_hash = NULL, lease_expires_at = NULL, locked_by = NULL, locked_at = NULL,
           -- FULL JITTER with a 1 s floor. Without jitter, a node dying while holding N leases
           -- wakes all N in the same millisecond and re-stampedes the claim index.
           available_at = now() + make_interval(secs =>
               1 + random() * (LEAST(300, power(2, LEAST(j.attempts, 9))::int) - 1)),
           abort_requested = false, abort_reason = NULL,
           last_error_code = 'LEASE_EXPIRED', last_error_at = now(),
           updated_at = now()
     WHERE j.status = 'RUNNING' AND j.lease_expires_at < now()
       AND j.attempts < j.max_attempts
    RETURNING 1)
  SELECT count(*) INTO c FROM r;  pass := 'revive'; n := c; RETURN NEXT;

  -- PASS 2 — RETIRE: attempts exhausted, whether by failure or by repeated lease loss.
  -- This is the pass that makes g §5.5's `attempts < max_attempts` claim predicate safe: rows
  -- that predicate hides from the claim are retired here instead of sitting PENDING forever.
  WITH r AS (
    UPDATE extraction_jobs j
       SET status = 'DEAD', finished_at = now(),
           lease_token_hash = NULL, lease_expires_at = NULL, locked_by = NULL,
           abort_requested = false, abort_reason = NULL,
           last_error_code = COALESCE(j.last_error_code, 'LEASE_EXPIRED'),
           updated_at = now()
     WHERE j.status IN ('RUNNING','PENDING')
       AND j.attempts >= j.max_attempts
       AND (j.lease_expires_at IS NULL OR j.lease_expires_at < now())
    RETURNING id)
  SELECT count(*) INTO c FROM r;  pass := 'retire'; n := c; RETURN NEXT;

  -- PASS 3 — WEDGED: the worker is alive (its heartbeat holds the lease) but has blown the
  -- processing budget plus grace. A worker that merely ran out of time finalises itself as a
  -- partial success (D-C2-10); reaching this pass means it is stuck.
  -- deadline_at is NULL until first claim, so this can never fire on a queued job.
  WITH r AS (
    UPDATE extraction_jobs j
       SET status = 'FAILED',
           lease_token_hash = NULL, lease_expires_at = NULL, locked_by = NULL,
           abort_requested = false, abort_reason = NULL,
           last_error_code = 'BUDGET_EXCEEDED_NO_PROGRESS', last_error_at = now(),
           finished_at = now(), updated_at = now()
     WHERE j.status = 'RUNNING'
       AND j.deadline_at IS NOT NULL
       AND j.deadline_at < now() - make_interval(secs => 120)
    RETURNING id)
  SELECT count(*) INTO c FROM r;  pass := 'wedged'; n := c; RETURN NEXT;

  -- PASS 4 — QUEUE TTL: we accepted work and never got to it. f2 JOB_QUEUE_TTL_MS.
  -- A DIFFERENT and honest code: the job never started, so BUDGET_EXCEEDED would lie to the
  -- customer and to capacity planning.
  WITH r AS (
    UPDATE extraction_jobs j
       SET status = 'FAILED', last_error_code = 'QUEUE_WAIT_EXCEEDED',
           last_error_at = now(), finished_at = now(), updated_at = now()
     WHERE j.status = 'PENDING' AND j.queue_expires_at < now()
    RETURNING id)
  SELECT count(*) INTO c FROM r;  pass := 'queue_ttl'; n := c; RETURN NEXT;

  PERFORM ocr_settle_run_v1(NULL);   -- settle every run whose last job just went terminal
END; $fn$;
```

**Reaper safety rules, restated because both M0 documents broke one of them.** It is set-based and
idempotent (a row already moved out of `RUNNING` no longer matches); races between workers are
harmless; **it must never be able to raise an exception on a data condition**, which is why no CHECK
references `abort_requested`, why every pass clears the flag, and why pass 3 guards
`deadline_at IS NOT NULL`. Every worker calls it every `REAP_INTERVAL_S`.

**Clock authority.** Every timestamp in the lease, backoff, deadline and TTL machinery is produced
by `now()` **inside PostgreSQL**. The worker's wall clock is never authoritative and is never
compared against a stored timestamp: `deadline_at` arrives from the heartbeat and is converted to a
local monotonic budget with `time.monotonic()`. This makes the design immune to container clock
skew, NTP steps and the Asia/Bangkok (UTC+7) offset entirely. Sessions pin `TimeZone = 'UTC'`
(`h` §9.8 invariant T-7, kept).

---

## 7. Retry, backoff, terminal failure, dead-letter

### D-C2-9 — `max_attempts = 5` on the row, with a worker-supplied per-class ceiling

- **Competing proposals.** (a) `g` §5.5: `maxAttempts Int @default(5)`. (b) `h` L22/§6.2:
  `max_attempts` 4, with `h` §9.6 additionally specifying per-class budgets (6 infrastructure, 4
  engine, 1 content/contract) and `h` L29 adding a worker-supplied `LEAST(max_attempts, $7)`
  ceiling. (c) `h`'s own review note, which says 5 in one place and 4 in another — `f2` D-F2-6
  flagged this as *"contradictory in M0 … flagged, not arbitrated here"*.
- **Selected.** **`max_attempts Int @default(5)`** (the app-owned ceiling, immutable by any worker),
  with `h` L29's mechanism kept: `ocr_finish_err_v1` takes `p_class_max_attempts` and the effective
  budget is `LEAST(max_attempts, p_class_max_attempts)`.

  | Error class | `maxAttempts` in `contracts/error-codes.json` | Rationale |
  |---|---|---|
  | Content (`PDF_CORRUPT`, `PDF_PASSWORD_PROTECTED`, `UNSUPPORTED_MIME`, `SOURCE_CHECKSUM_MISMATCH`) | **1** | retrying a corrupt PDF four times spends 4× the compute to reach the same answer |
  | Contract (`PAYLOAD_SCHEMA_INVALID`, `PAYLOAD_VERSION_UNKNOWN`) | **1** | a deploy-order violation; retrying cannot fix it, and it must page an operator |
  | Engine / compute (`PAGE_OOM`, `OCR_ENGINE_FAILED`, `PAGE_RENDER_FAILED`) | **3** | job-level; the page-level cap of 2 (§9.2) is what stops one bad page eating the job |
  | Infrastructure (`STORAGE_UNAVAILABLE`, `LEASE_EXPIRED`, `DB_UNAVAILABLE`) | **5** | transient by nature; a storage restart must not dead-letter a day's work |
  | AI (`AI_GATEWAY_*`, `AI_OUTPUT_UNPARSEABLE`, …) | **frozen at 3 by `f3` `ai.job.max_attempts`** | cited, not restated; applies only to `AI_EXTRACT` rows |

- **Rejected.** `h`'s 4 — 5 is `g`'s shipped default, is what `f1`'s data model already carries, and
  sits at the top of the envelope `f2` D-F2-6 explicitly priced: *"bounded worst case per job is
  `max_attempts × 30 min`, so 2–2.5 h of processing for a pathological job"* — 5 × 30 min = 2.5 h,
  the stated ceiling. `h`'s 6 for infrastructure is rejected for the same reason: it would make the
  worst case 3 h, outside `f2`'s priced envelope, and it was sized for a design without page
  checkpoints.
- **Reason.** One app-owned ceiling the worker cannot raise, plus a worker-supplied floor the worker
  *can* lower. A compromised worker can shorten its own retries (harmless) but cannot turn a job into
  an infinite retry loop, which is a billing and capacity attack.
- **Implementation consequence.** `maxAttempts` becomes a **required** field of every row in
  `contracts/error-codes.json` (owner: `h` per `f3` `ai.error.taxonomy_owner`; the `AI_*` members
  owned by `k`). CI gate 2 asserts every code has one and that no code declares a value > 5.
- **Migration consequence.** None — `g`'s default already ships 5.
- **Security consequence.** See above; also, `attempts` is written only inside `ocr_claim_v1`, so the
  counter cannot be reset by a compromised worker to obtain unlimited GPU/CPU.
- **Config/env consequence.** `queue.max_attempts: 5` in `config/limits.yaml`, env
  `OCR_QUEUE_MAX_ATTEMPTS`; the per-class map lives in `contracts/error-codes.json` and is read by
  both languages.

### D-C2-10 — Backoff: bounded exponential with **full jitter**, 1 s floor, 300 s cap

- **Competing proposals.** (a) jawbong `calculateBackoffMs(attempt, 1_000, 300_000)` =
  `min(300 000, 1000 · 2^min(attempt−1, 20))`, deterministic
  (`~/Documents/jawbong/src/modules/outbox/domain/outbox-event.ts`). (b) `g` §5.5's SQL
  transliteration of the same, also deterministic, with a unit test asserting the two agree. (c)
  `h` L13: (a) plus full jitter.
- **Selected.** **(c)**, expressed once, in SQL, inside `ocr_finish_err_v1` and `ocr_reap_v1`:
  ```
  available_at = now() + (1 + random() * (LEAST(300, 2^LEAST(attempts, 9)) - 1)) seconds
  ```
  giving `[1, 2]`, `[1, 4]`, `[1, 8]`, … `[1, 300]` seconds for attempts 1…5+.
- **Rejected.** (a)/(b) — deterministic backoff is `h` L13's own complaint about jawbong,
  reintroduced in the one place a thundering herd is guaranteed: a node dies holding N leases and
  without jitter all N wake in the same millisecond and re-stampede the claim index. `g`'s
  "test that the SQL and the TypeScript agree" obligation **disappears**, because there is now only
  one implementation, in SQL, and no application round trip. That is a deleted test, not a new one.
- **Reason.** Full jitter (AWS's formulation) is the variant that minimises both contention and
  completion time. The `1 +` floor exists so a retry is never scheduled at `now()`, which would let
  the same worker re-claim the row it just failed before any other worker sees it.
- **Implementation consequence.** `power(2, …)` returns `double precision`, hence the explicit
  `::int` — `g` §5.5 already noted this and it is kept. `LEAST(j.attempts, 9)` caps the exponent
  before the `LEAST(300, …)` so the multiply cannot overflow.
- **Migration consequence.** None.
- **Security consequence.** Jitter also removes a coarse timing oracle: without it, an observer
  measuring retry instants learns the platform-wide failure clock.
- **Config/env consequence.** `queue.backoff.base_s: 1`, `queue.backoff.cap_s: 300`
  (`OCR_QUEUE_BACKOFF_BASE_S`, `OCR_QUEUE_BACKOFF_CAP_S`). `f3` `ai.job.backoff` owns the
  `AI_EXTRACT` numbers and is cited, not overridden — `ocr_finish_err_v1` receives
  `p_backoff_cap_s` as a parameter for exactly this reason.

### D-C2-11 — Budget exhaustion with ≥ 1 page completed is a **success**, not a failure

- **Competing proposals.** (a) `h` §13.2 + §9.6: `BUDGET_EXCEEDED`, `retryable: false`, terminal
  `FAILED`. (b) The panel's operations lens: make `BUDGET_EXCEEDED` progress-conditional —
  `retryable = (pages_completed_this_attempt > 0)`. (c) `f2` DECISION F2-D6:
  *"exceeding the budget with ≥ 1 page completed is `SUCCEEDED_PARTIAL`, remaining pages
  `route=SKIPPED, reason="time_budget_exhausted"`; `BUDGET_EXCEEDED` as a terminal failure is
  reserved for **zero** pages completed."*
- **Selected.** **(c)**, which is frozen. Realised as `status = 'SUCCEEDED'`, `degraded = true`
  (D-C2-3), via `ocr_finish_ok_v1` — **not** via the failure path at all.
- **Rejected.**
  - (a) — `f2` D-F2-6 records it as *"the single most damaging behaviour in M0: it throws away
    completed, checkpointed, already-paid-for work"*, and the panel showed the de-facto recovery is
    "ask the customer to upload it twice".
  - (b) — a retry after a budget breach re-enters the same page loop and hits the same wall one page
    further along; at `f2` `MAX_OCR_PAGES_PER_DOCUMENT = 50` and
    `PROVISIONAL_PER_PAGE_OCR_S = 25` the page allowance is not the binding constraint anyway
    (50 × 25 = 1 250 s ≤ 1 440 s available). Retrying to gain 190 s of slack is not a mechanism.
    (c) delivers the *customer* outcome (a usable document plus an explicit gap list) instead of a
    slower path to the same place.
- **Reason.** The frozen envelope closes: `f2` `JOB_PROCESSING_BUDGET_MS` −
  `JOB_FIXED_OVERHEAD_S` − reserved `AI_STAGE_BUDGET_S` headroom = 1 440 s of page allowance, and the page cap is
  sized to fit inside it. The partial rule is what makes the *provisional* per-page constant
  survivable: if the guess is 2× low, a document does not fail, it completes with half its pages
  OCR'd, the user sees exactly which, and the `render_budget_exhausted` counter tells operations the
  constant is wrong.
- **Implementation consequence.** Enforcement moves to **three** points, and point 2 is the one that
  changes from `h`:
  1. per stage, `asyncio.timeout(stage_timeout)` at `f2` `PAGE_RENDER_TIMEOUT_S` /
     `PAGE_PARSE_TIMEOUT_S` / `PAGE_OCR_TIMEOUT_S`;
  2. **before each page, `if monotonic_deadline_passed(): break` — leave the loop and finalise as a
     partial success**, marking every unprocessed page `route='SKIPPED', reason='time_budget_exhausted'`
     and appending `{code: 'TIME_BUDGET_PARTIAL', pageFrom, pageTo}` to `result.warnings[]`. `h`'s
     `raise Terminal("BUDGET_EXCEEDED")` is **deleted**;
  3. `ocr_reap_v1` pass 3, which fires only if the worker never reached point 2 —
     `BUDGET_EXCEEDED_NO_PROGRESS`, terminal `FAILED`, and it **pages** (see §18), because it means
     a worker is wedged, which is what `h`'s ticket-level `OcrBudgetExceeded` was actually trying to
     detect.
- **Migration consequence.** `contracts/error-codes.json` gains `TIME_BUDGET_PARTIAL` as a
  **non-error terminal-success warning code** (`retryable: false`, `userFacing: true`,
  `http: 200`, `msgKey: "warn.time_budget_partial"`) and `BUDGET_EXCEEDED_NO_PROGRESS`
  (`retryable: false`, `userFacing: false`, `http: 504`). `BUDGET_EXCEEDED` itself is **removed**
  from the enum — one condition, one code (`f2` `ERROR_CODE_OVERSIZE_BODY`'s principle applied).
- **Security consequence.** Removes the self-amplifying outage `f2` D-F2-6 names: under backlog,
  `h`'s design terminally failed work it was capable of doing, and those failures consumed worker
  slots, deepening the backlog.
- **Config/env consequence.** None new; the numbers are all `f2`'s.

### D-C2-12 — Dead-letter is a **view over `status`**, and it includes budget/capacity failures

- **Competing proposals.** (a) `h` L15: `state='DEAD'` plus a partial index plus a view, requeued by
  one `UPDATE`. (b) A separate `extraction_jobs_dead` table. (c) The panel: widen the DLQ view to
  include `FAILED` rows whose code an operator can act on, because *"a `FAILED` job is not in the
  DLQ, L15's one-UPDATE requeue is DEAD-only, and there is no documented requeue path."*
- **Selected.** (a)'s storage shape with (c)'s membership rule:
  ```sql
  CREATE VIEW extraction_job_dlq AS
  SELECT j.id, j.organization_id, j.document_id, j.run_id, j.kind, j.attempts, j.max_attempts,
         j.last_error_code, j.last_error_detail, j.finished_at, j.pages_done, j.pages_total,
         j.locked_by, r.run_seq, d.public_id
    FROM extraction_jobs j
    JOIN document_runs   r ON r.id = j.run_id  AND r.organization_id = j.organization_id
    JOIN documents       d ON d.id = j.document_id AND d.organization_id = j.organization_id
   WHERE j.status = 'DEAD'
      OR (j.status = 'FAILED' AND j.last_error_code IN (
            'BUDGET_EXCEEDED_NO_PROGRESS','QUEUE_WAIT_EXCEEDED','STORAGE_UNAVAILABLE',
            'PAYLOAD_SCHEMA_INVALID','PAYLOAD_VERSION_UNKNOWN','DB_UNAVAILABLE'))
   ORDER BY j.finished_at DESC;
  ```
  The membership list is **operator-actionable codes only**: a `PDF_PASSWORD_PROTECTED` failure is a
  customer problem and must never fill an operator queue.
- **Rejected.** (b) — a second table needs its own RLS, its own grants, its own retention and a
  move-on-death write in the hot path, to gain a `WHERE` clause. (a) alone — the panel's finding.
- **Reason.** `FAILED` and `DEAD` are deliberately different states (D-C2-3); the DLQ is a
  *worklist*, and worklist membership is a property of the error code, not of the state.
- **Implementation consequence.** The view is granted `SELECT` to `ocr_app` only and is served under
  `ocr_app`'s tenant policy, so an org admin sees their own DLQ and INNOVERA staff see one org at a
  time via `f1` `admin.override.mechanism`.
- **Migration consequence.** A view; free to change.
- **Security consequence.** `last_error_detail` is allow-listed JSONB (`h` L21, kept) — **no raw
  exception text ever reaches Postgres**, because an exception message from a PDF parser can contain
  document content. `g` §5.5's `lastError String @db.VarChar(1000)` free-text column is
  **superseded** for exactly this reason.
- **Config/env consequence.** None.

**`h` L15's one-`UPDATE` requeue is deleted.** Requeue is D-C2-13's mechanism and nothing else —
one path, not two.

---

## 8. Operator requeue that cannot violate a unique constraint *(named exit-gate item)*

### D-C2-13 — A requeue is a **new `DocumentRun`**. It never touches a terminal job row

- **Competing proposals.** (a) `g` §5.5: stamp `Document.requeueCount` into the dedupe key. (b)
  `h` L15: `UPDATE extraction_jobs SET status='PENDING', attempts=0 WHERE id=$dead`. (c) `f1`
  D-F1-12: a new `DocumentRun` whose `run_id` flows into every dedupe key and every evidence key.
- **Selected.** **(c)**, which is frozen. The exact mechanism, and the proof:

```sql
-- POST /v1/documents/{public_id}/runs      (role: ocr_app, inside one transaction)
BEGIN;
  SELECT set_config('app.current_org', $org, true);

  -- (0) PRECONDITION. A live run makes a requeue illegal. This is a REFUSAL, not a wedge:
  --     f1 D-F1-12 — "otherwise it receives a distinct, loud 23505 that the API maps to
  --     409 run_in_progress". We check it explicitly so the client gets a clean 409 with a
  --     Retry-After rather than a constraint-violation error page.
  SELECT 1 FROM document_runs
   WHERE document_id = $doc AND organization_id = $org AND outcome = 'RUNNING';
  --   1 row  -> ROLLBACK; respond 409 { code: "run_in_progress", runSeq, retryAfterSeconds: 30 }
  --   0 rows -> continue

  -- (1) SERIALISE concurrent requeues on the DOCUMENT row.
  --     FOR NO KEY UPDATE, not FOR UPDATE, so it does not block concurrent FK checks against
  --     the same document row (f1 uniq.document_run_seq).
  SELECT 1 FROM documents
   WHERE id = $doc AND organization_id = $org FOR NO KEY UPDATE;

  -- (2) ALLOCATE the next run_seq under that lock. No counter read, no retry loop.
  INSERT INTO document_runs (id, organization_id, document_id, run_seq, trigger,
                             triggered_by_membership_id, reason, pipeline_version, outcome)
  SELECT $newRunId, $org, $doc, coalesce(max(run_seq), 0) + 1, $trigger,
         $membership, $reason, $pipelineVersion, 'RUNNING'
    FROM document_runs WHERE document_id = $doc AND organization_id = $org;

  -- (3) ENQUEUE. dedupe_key is f1 job.dedupe_key_grammar over the NEW runId.
  INSERT INTO extraction_jobs (id, organization_id, document_id, run_id, kind, schema_version,
                               payload, status, priority, dedupe_key, est_pages,
                               budget_ms, queue_expires_at, max_attempts, available_at)
  VALUES ($jobId, $org, $doc, $newRunId, 'DOCUMENT_EXTRACT', 1, $payload::jsonb, 'PENDING',
          40,                                  -- D-C2-5 band: operator requeue
          $newRunId || ':DOCUMENT_EXTRACT:*-*',
          $estPages, $budgetMs, now() + make_interval(secs => $queueTtlS), 5, now())
  ON CONFLICT (organization_id, dedupe_key) DO NOTHING
  RETURNING id;

  -- (4) domain event, same commit (R17)
  INSERT INTO outbox_events (...) VALUES ('document.run.started', ...);
COMMIT;
```

**Why it provably cannot violate a unique constraint — all five, enumerated:**

| Constraint (all frozen by `f1`) | Why this transaction cannot violate it |
|---|---|
| `document_run_one_active_key` (`document_runs (document_id) WHERE outcome='RUNNING'`) | step (0) refuses when one exists. The check and the insert are in one transaction under the step-(1) row lock, so no other requeue can create one in between. |
| `document_run_doc_seq_key` (`(document_id, run_seq)`) | `FOR NO KEY UPDATE` on the `documents` row serialises every concurrent requeue of that document, so `max(run_seq)+1` is computed under mutual exclusion. The unique index is a backstop, not the mechanism. |
| `extraction_job_org_dedupe_key` (`(organization_id, dedupe_key)`) | the key's first segment is `$newRunId`, a fresh uuid v7 (`f1` `id.internal`) generated in this transaction. It cannot collide with any key that has ever existed. `ON CONFLICT DO NOTHING` therefore fires only on a **genuine double-submit of this same requeue**, which is the behaviour we want. |
| `ocr_result_page_run_engine_key` (`(document_page_id, run_id, engine_id, engine_version, render_dpi)`) | contains `run_id`. The same page, same engine build, same DPI in run 4 does not collide with run 3 — which `f1` `uniq.ocr_result` states is exactly what makes the operator requeue possible on an append-only table. |
| `document_page_doc_number_key` (`(document_id, page_number)`) | the render step **UPSERTs** (`f1` `uniq.document_page`: `ON CONFLICT (document_id, page_number) DO UPDATE`). `document_pages` is a mutable projection; `ocr_results` is immutable evidence. No new run ever inserts a duplicate page row. |

**The 409 is a feature, and the operator's path is two explicit calls.** `DELETE`-free, hidden-state-free:

1. `POST /v1/documents/{public_id}/cancel` → sets `abort_requested = true` on every `RUNNING` job of
   the live run and `status='CANCELLED'` on every `PENDING` job of it (hard cancel is safe on
   `PENDING`: nothing has happened). Returns `202 { cancelling: true, etaSeconds: 60 }`.
2. `POST /v1/documents/{public_id}/runs` once the run is terminal → the transaction above.

A convenience flag `?cancelRunning=true` performs step 1 and returns
`202 { code: "cancel_in_progress", retryAfterSeconds: 30 }`, telling the client to re-issue step 2.
It never performs step 2 itself. **Reason:** letting a requeue start while the previous run's worker
is still draining would let the old run's render step upsert `document_pages` with the *old*
`render_dpi` after the new run wrote the new one — a silent, page-level data race that no unique
constraint catches. The 409 makes that structurally impossible.

- **Rejected.**
  - (a) — `f1` D-F1-12 deleted `Document.requeueCount`: two operators requeueing within the same
    second read the same value, stamp the same key, and one gets a 23505 on the job table with no
    way to distinguish "already queued" from "lost a race".
  - (b) — `h` L15's `UPDATE` of the DEAD row rewrites terminal evidence (`attempts`, `finished_at`,
    `last_error_code`), destroys the audit answer to "how many times did we try, and when did we give
    up", leaves `ocr_results` pointing at a run that is now claimed to be running again, and gives
    the new work the **old** run's dedupe key — so a second requeue collides with the first. It is
    the mechanism that produced the exit-gate item.
- **Reason.** Requeue is a *new fact about the document*, not an edit of an old one. Modelling it as
  a new row is what makes every uniqueness constraint in the schema requeue-safe simultaneously.
- **Implementation consequence.** Bulk requeue (`POST /v1/admin/runs:bulk`) is the same transaction
  in a loop, capped at **200 documents per call** (`OCR_QUEUE_BULK_REQUEUE_MAX`), each in its own
  transaction so one 409 does not roll back 199 successes; the response is a per-document result
  array. Authorisation: `WorkspaceRole.MANAGER` in the document's workspace, or `OrgRole.ADMIN` /
  `OWNER` (see **OWNER-BLOCKED (B-C2-1)**).
- **Migration consequence.** None beyond `f1`'s — `document_runs` and the two partial indexes are
  already frozen and land in migration 0004.
- **Security consequence.** A requeue is an authenticated, authorised, audited write
  (`document_runs.trigger`, `triggered_by_membership_id`, `reason`, plus an `AuditLog` row). It is
  also a cost multiplier, so it is rate-limited under `f2` `RATE_PATCH` and counts against the
  organisation's page quota exactly like a first upload — a requeue that did not consume quota would
  be a free-compute primitive.
- **Config/env consequence.** `OCR_QUEUE_BULK_REQUEUE_MAX=200`,
  `OCR_QUEUE_REQUEUE_CONFLICT_RETRY_AFTER_S=30`.

**Regression test (`f1` D-F1-12's, extended):** requeue a `FAILED` 60-page document **twice**;
assert three `document_runs` rows with `run_seq` 1/2/3, three `ocr_results` rows for page 1 with
identical `(engine_id, engine_version, render_dpi)` and three distinct `run_id`s, exactly one
`document_pages` row for page 1, and zero 23505s. Then issue a fourth requeue **while run 3 is
`RUNNING`** and assert `409 run_in_progress` with no rows written.

---

## 9. Page-level checkpointing and crash recovery

### D-C2-14 — The checkpoint is `ocr_results`. `h`'s `ocr_page_results` table is **deleted**

- **Competing proposals.** (a) `h` L6/§8.1: a new table `ocr_page_results`, content-addressed on
  `(organizationId, documentSha256, pageNo, pipelineVersion, recipeHash, engineId, engineVersion)`,
  plus `attempts`, `jobAttempts`, `poisonedAt`, a 7-day `POISON` TTL and a cross-document cache.
  (b) `f1` `uniq.ocr_result`: `ocr_results` unique on
  `(documentPageId, runId, engineId, engineVersion, renderDpi)` — frozen, and described by `f1` as
  serving *"within ONE run, re-running the same engine build at the same DPI on the same page is a
  worker retry after a crash — `ON CONFLICT DO NOTHING` makes it idempotent"*.
- **Selected.** **(b).** `ocr_page_results` does not exist. Resume is
  `SELECT document_page_id FROM ocr_results WHERE run_id = $run AND organization_id = $org`.
- **Rejected.** (a) — three reasons, in order of weight.
  1. **`f1` already froze a constraint whose stated purpose is crash-retry idempotency.** Two tables
     both claiming to be the page checkpoint, with different keys, is precisely contradiction 6
     reproduced one level down.
  2. **The 7-column content-addressed key is not implementable against the frozen schema.**
     `ocr_results` is tenant-scoped with a composite FK to `document_pages`; a parallel table keyed
     on `document_sha256` has no composite FK into any tenant table and would fail `f1`
     `schema.invariants` TEN-1 and TEN-2 (a bare `*Id` scalar with no relation).
  3. **The whole `POISON`-TTL apparatus disappears with it.** `h` §8.1's own review found the
     draft's page poison was *permanent* and bolted on `job_attempts`, `poisoned_at` and a 7-day
     expiry to fix it. Under a run-scoped checkpoint the defect cannot occur: a new run is a clean
     slate by construction, so there is nothing to expire.
- **Reason.** One fewer table, one fewer unique key, one fewer TTL sweeper, one fewer cache
  invalidation rule — and the property the brief asks for (a crash at page 190 does not redo pages
  1–189) is delivered by a constraint that is already frozen.
- **What is genuinely lost, and the numeric trigger to get it back.** `h` L6 property 3 —
  *"re-uploading an identical document is near-instant"* — is gone: two `Document` rows over the
  same bytes are OCR'd twice. Byte-level dedup survives at the storage layer via `f1`
  `uniq.storage_original_fingerprint`. **Reopen a same-organisation, cross-document OCR cache when
  `ocr_duplicate_original_uploads_total / ocr_documents_created_total > 0.10` measured over 30 days**
  — i.e. when more than one upload in ten is bytes we have already processed. `h` L7's tenant
  scoping is the correct shape for it if it ever ships, and the frozen key already supports it by
  joining through `document_pages.storage_object_id`.
- **Implementation consequence.** The page write becomes one lease-guarded function:
  ```sql
  CREATE FUNCTION ocr_page_result_v1(p_job uuid, p_token text, p_page_id uuid,
                                     p_route varchar, p_result jsonb)
  RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
  DECLARE v_org uuid; v_run uuid;
  BEGIN
    SELECT j.organization_id, j.run_id INTO v_org, v_run
      FROM extraction_jobs j
     WHERE j.id = p_job AND j.status = 'RUNNING'
       AND j.lease_token_hash = sha256(convert_to(p_token, 'UTF8'));
    IF NOT FOUND THEN RETURN false; END IF;      -- lease lost: a zombie writes NOTHING
    INSERT INTO ocr_results (id, organization_id, document_page_id, run_id, engine_id,
                             engine_version, render_dpi, route, payload_ref, lines_json,
                             score_p10, score_min, char_count, duration_ms, created_at)
    SELECT gen_random_uuid(), v_org, p_page_id, v_run,
           p_result->>'engineId', p_result->>'engineVersion',
           (p_result->>'renderDpi')::int, p_route, p_result->>'payloadRef',
           p_result->'lines', (p_result->>'scoreP10')::numeric,
           (p_result->>'scoreMin')::numeric, (p_result->>'charCount')::int,
           (p_result->>'durationMs')::int, now()
    ON CONFLICT ON CONSTRAINT ocr_result_page_run_engine_key DO NOTHING;
    RETURN true;
  END; $fn$;
  ```
  `h` §10.3's honest gap — *"the `ocr_page_results` upsert has no `lease_token` predicate at all;
  the parenthetical 'the loop re-checks the heartbeat before the write' is a TOCTOU window, not a
  guard"* — is closed: the lease is revalidated **in the same statement** that resolves the org and
  the run.
- **Migration consequence.** One table fewer to create, and `h`'s `ocr_page_results` retention rule
  and its `ON DELETE CASCADE` obligation disappear. `ocr_results` retention already follows the
  document (`gate-2-pdpa-retention.md`).
- **Security consequence.** Deletes `h` L7's cross-tenant timing/existence side channel *by
  construction* rather than by policy: there is no cross-document cache to probe, so "someone else on
  this platform has this exact document" is not observable at any latency.
- **Config/env consequence.** None. `OCR_PAGE_CACHE_*` variables are not created.

### 9.1 The OOM-kill story, with the frozen numbers

The brief's scenario is a 200-page document. Under the frozen envelope that document is **admitted**
(`f2` `MAX_PAGES_PER_DOCUMENT = 500`) and, if it is a scan, **50 of its pages are OCR'd**
(`f2` `MAX_OCR_PAGES_PER_DOCUMENT = 50`, provisional, expires at M-1); native-text pages do not
consume that budget, so a 200-page native PDF is fully extracted. The crash story below is written
at page 47 of the 50-page OCR budget because that is where the frozen limits put it.

```python
# ocr_worker/pipeline/document.py  — the loop, in full
async def process_document(job: ClaimedJob, stop: asyncio.Event) -> RunOutcome:
    pages   = await load_page_manifest(job)         # dimension E; UPSERTs document_pages
    done    = await already_done_page_ids(job)      # SELECT document_page_id FROM ocr_results
                                                    #  WHERE run_id = job.run_id
    budget  = MonotonicBudget.from_deadline(job.deadline_at)   # DB clock -> local monotonic
    ocr_used, skipped, warnings = 0, [], []

    for page in pages:
        if stop.is_set():                            # lease lost OR abort requested
            raise Aborted(stop.reason)
        if page.id in done:                          # (1) checkpoint hit: zero work
            continue
        if budget.expired():                         # (2) D-C2-11: leave, do not raise
            skipped.append(page.number); continue
        if page.route == "ocr" and ocr_used >= LIMITS.MAX_OCR_PAGES_PER_DOCUMENT:
            skipped.append(page.number)              # f2's OCR budget, not a failure
            warnings.append(("OCR_PAGE_BUDGET_EXHAUSTED", page.number)); continue
        if await content_failures(job.id, page.number) >= MAX_PAGE_ATTEMPTS:   # (3) §9.2
            skipped.append(page.number)
            warnings.append(("PAGE_POISONED", page.number)); continue

        result = await run_page_in_child(job, page, budget.per_page_deadline())  # (4)
        await store.page_result(job.id, job.token, page.id, page.route, result)  # (5) commit
        if page.route == "ocr":
            ocr_used += 1
        await store.progress(job.id, job.token, stage="ocr",
                             pages_done=len(done) + ocr_used + len(skipped),
                             pages_total=len(pages),
                             pct=5 + int(90 * (len(done) + ocr_used) / max(len(pages), 1)))
```

**What happens on a SIGKILL at page 47** (no `finally`, no flush, no lease release):

| t | Event | State |
|---|---|---|
| 0 s | container OOM-killed by the kernel at `f2` `WORKER_MEMORY_LIMIT_BYTES` | `ocr_results` holds 46 committed rows for `run_id = R`; `extraction_jobs` row is `RUNNING`, `attempts = 1` |
| ≤ 90 s | `lease_expires_at` passes (`LEASE_TTL_S`) | still `RUNNING`, now unfenced |
| ≤ 105 s | any worker's `ocr_reap_v1()` pass 1 (`REAP_INTERVAL_S = 15`) | `PENDING`, `last_error_code='LEASE_EXPIRED'`, `available_at = now() + [1, 4] s`, `abort_requested` cleared |
| ≤ 109 s | a worker claims it | `RUNNING`, `attempts = 2`, **fresh `deadline_at = now() + JOB_PROCESSING_BUDGET_MS`** |
| +0 s | `already_done_page_ids` returns 46 ids | pages 1–46 skipped with **zero work** |
| — | resumes at page 47 | **redone work: ≤ 1 page** |

**Detection window ≤ 105 s. Redone work ≤ 1 page.** Requirement R2 (*"a retry after a crash at page
190 of 200 does not redo pages 1–189"*) holds with a much smaller constant than `h`'s "≤ 15 pages".

**`pages_done` is not a resume pointer** and must never be used as one — it is a display value that
a retry legitimately rewrites downward and then upward again. The M1 crash test asserts that a job
whose `pages_done` has been manually corrupted to `0` still skips every completed page.

### 9.2 Page-level poison, without a poison column

- **Competing proposals.** (a) `h` §8.1: `attempts` / `job_attempts` / `poisoned_at` columns on the
  deleted `ocr_page_results` table, with a 7-day TTL. (b) A new `page_attempts` table. (c) Count
  content-class failure events in `job_events`.
- **Selected.** **(c).** `job_events` gains `page_no Int?` (which `h` §9.4 already had and `g` §5.5
  omitted) and one partial index:
  ```sql
  CREATE INDEX job_event_content_failure_idx
    ON job_events (job_id, page_no)
    WHERE kind = 'PAGE_FAILED_CONTENT';
  ```
  ```sql
  -- the poison check, one index probe
  SELECT count(*) FROM job_events
   WHERE job_id = $1 AND page_no = $2 AND kind = 'PAGE_FAILED_CONTENT';
  ```
  `MAX_PAGE_ATTEMPTS = 2` (`OCR_QUEUE_MAX_PAGE_ATTEMPTS`). A third content failure on the same page
  marks it `SKIPPED` with `PAGE_POISONED` in `result.warnings[]` and **the loop continues** — one
  pathological page cannot consume the job's retry budget (R10).
- **Rejected.** (a) — the table is gone; (b) — a whole table, an RLS policy, a grant, a retention
  rule and a composite FK, to hold a counter that an existing append-only audit table already
  records.
- **Reason and the scoping property.** The count is scoped to `job_id`, and a job row persists across
  its ≤ 5 attempts but a **requeue creates new job rows** (D-C2-13). That is *exactly* the semantics
  `h` §8.1's review had to introduce `job_attempts` to obtain — obtained here for free.
- **Only content failures poison.** `PAGE_FAILED_CONTENT` is emitted for `retryable: false` codes
  (`PDF_CORRUPT`, `PAGE_RENDER_FAILED` on a malformed page object, `PAGE_OOM` — a property of that
  page's dimensions, not of the cluster). `STORAGE_UNAVAILABLE`, `DB_UNAVAILABLE`, `LEASE_EXPIRED`
  and every `AI_GATEWAY_*` code emit `PAGE_FAILED_TRANSIENT`, which **increments nothing** at page
  level. `h` §8.1's found defect — *"two transient blips on page 47 convert a retryable
  infrastructure error into a permanent content verdict"* — is closed by the event *kind*, not by a
  TTL. `contracts/error-codes.json`'s `pageLevel` field carries which kind a code emits, and CI gate
  2 asserts every code has one.
- **Implementation consequence.** Poison verdicts are visible in the run detail response and in
  `ocr_pages_poisoned_total{failure_code}`; they never change the job's terminal state.
- **Migration consequence.** One nullable int column and one partial index on `job_events`
  (on `f1` `partial_index.policy`'s hand-authored allowlist, asserted at startup by
  `pg_indexes.indexdef`).
- **Security consequence.** None; `job_events` is already lease-gated (§6.2) and `detail` is
  allow-listed.
- **Config/env consequence.** `OCR_QUEUE_MAX_PAGE_ATTEMPTS=2`.

### 9.3 The three guards that prevent the OOM in the first place

| Guard | Setting | Effect |
|---|---|---|
| Container memory limit | `f2` `WORKER_MEMORY_LIMIT_BYTES` (cited) | the kernel kills one worker, not the host |
| In-process soft limit | `resource.setrlimit(RLIMIT_AS, int(0.8 × WORKER_MEMORY_LIMIT_BYTES))` **in the child process** | most allocations raise a catchable `MemoryError` before the kernel OOM-killer fires, so we get a clean `PAGE_OOM` and a page-level skip instead of a SIGKILL |
| Never hold the document | render page-by-page, one bitmap at a time, explicit `del` between pages | peak RSS is O(1) in page count, bounded by `f2` `MAX_BITMAP_BYTES_PER_PAGE` |

Pixel and tile caps are `f2`'s (`MAX_PAGE_PIXELS`, `MAX_PAGE_EDGE_PX`, `MAX_PIXELS_PER_TILE`,
`MAX_TILES_PER_PAGE`, `MAX_TOTAL_RENDER_PIXELS`) — cited, enforced in
`ocr_worker/imaging/limits.py`, never restated here.

### 9.4 The heartbeat must not share a thread with the OCR call

`run_page_in_child` above is **a process pool, not a thread pool** —
`ProcessPoolExecutor(max_workers=RENDER_CONCURRENCY, mp_context=mp.get_context("spawn"))`, sized by
`f2` `RENDER_CONCURRENCY`, with a child recycled every 64 pages (`max_tasks_per_child`). Three
reasons, all load-bearing here rather than stylistic:

1. the GIL question disappears, so the 15 s heartbeat is *guaranteed* responsive and the 90 s lease
   cannot expire under a live worker — which would cause the reaper to requeue a job that is still
   running, i.e. the double-processing the fencing token exists to make *safe* but which we should
   not be *causing*;
2. `RLIMIT_AS` is set on the child, so a `MemoryError` kills one page rather than the worker;
3. a native-code segfault in a decoder on a hostile PDF kills the child, and the parent turns it into
   a clean `PAGE_RENDER_FAILED` instead of losing the lease.

Soak assertion: `ocr_lease_lost_total == 0` over 60 minutes of continuous 50-page jobs.

---

## 10. Idempotency — four layers, each with one owner

| Layer | Question it answers | Mechanism | Owner |
|---|---|---|---|
| 1 — HTTP | "is this the same *request*?" | `idempotency_records` (jawbong's table, reused) | **this document, D-C2-15** |
| 2 — enqueue | "is this the same *work*?" | `f1` `uniq.extraction_job_dedupe` + `f1` `job.dedupe_key_grammar` | **`f1`, frozen — cited, not restated** |
| 3 — execution | "is this write from the *current* owner?" | `lease_token_hash`, revalidated inside all nine functions | **this document, D-C2-8** |
| 4 — money | "have we already paid for this model call?" | `ai_calls` + `f3` `ai.idempotency_key` | **`f3`, frozen — cited, not restated** |

**Delivery is at-least-once and cannot be made exactly-once.** What is exactly-once is the *effects*:
layer 3 fences every DB write, `ocr_result_page_run_engine_key` makes the page write idempotent,
object PUTs are content-addressed (dimension F), and layer 4 makes the one non-idempotent billable
side effect crossable exactly once.

### D-C2-15 — Layer 1: reuse jawbong's table, **replace its hash**

- **Competing proposals.** (a) `h` §10.1's draft and dimension A's A-6: *"copy `idempotency_records`
  verbatim"*, including
  `requestHash = sha256(JSON.stringify(payload))`
  (`~/Documents/jawbong/src/modules/outbox/infrastructure/prisma-idempotency-repository.ts`).
  (b) `h` §10.1's own correction: RFC 8785 JSON Canonicalization over an NFC-normalised body.
- **Selected.** (b), plus an `IN_FLIGHT` reservation that jawbong's repository does not have.
  ```ts
  // src/modules/documents/infrastructure/idempotency.ts
  import { canonicalize } from "json-canonicalize";        // RFC 8785 JCS
  const requestHash = sha256Hex(canonicalize(nfcDeep(body)));
  //   scope     = "ocr.document.submit"
  //   key       = the client's Idempotency-Key header (required on POST /v1/documents)
  //   expiresAt = now + 24 h            (OCR_QUEUE_IDEMPOTENCY_TTL_S = 86400)
  ```
  **Reserve first, respond later.** Insert the record with `response_code = NULL` **before** doing
  any work, under `idempotency_scope_key_key`. Outcomes:

  | Situation | Response |
  |---|---|
  | no record | reserve, do the work, store `{response, responseCode}`, return `202` |
  | record exists, same `requestHash`, `responseCode` set | replay the stored response verbatim |
  | record exists, same `requestHash`, `responseCode` NULL | **`409 request_in_flight`, `Retry-After: 1`** |
  | record exists, different `requestHash` | `422 idempotency_key_reused` |
  | record expired | treated as absent |
- **Rejected.** (a) — `JSON.stringify` serialises object keys in **insertion order**, so
  `{"a":1,"b":2}` and `{"b":2,"a":1}` — the same request from two clients, or from one client after
  a library upgrade — hash differently and the replay returns a spurious 422. The failure is
  *user-visible* and *nondeterministic*, the worst combination. Dimension A's own A-6 rejection list
  names *"an order-dependent idempotency hash"* as a defect of the outbox, and `h`'s draft reused it
  anyway. Jawbong's missing `IN_FLIGHT` state is the second half: with `response`/`responseCode`
  populated only on completion, two genuinely concurrent requests with the same key both find no
  record and both proceed.
- **Reason.** `nfcDeep` matters specifically for Thailand: **macOS Safari uploads filenames in NFD,
  Windows and Android send NFC.** Without NFC-first normalisation the same file from two devices
  produces two different hashes, two jobs and two invoices — `h` §9.8 invariant T-2 calls this
  *"the single highest-probability Thai bug in the whole design"*, and it lands here.
- **Implementation consequence.** `Idempotency-Key` is **required** on `POST /v1/documents` and
  `POST /v1/documents/{public_id}/runs`, and optional-but-honoured elsewhere. The 24 h TTL is swept
  by the existing `idempotency_expires_at_idx`, in bounded batches of 5 000.
- **Migration consequence.** The jawbong table is copied verbatim (`@@unique([scope, key])`,
  `requestHash VarChar(128)`, `expiresAt`) — only the *function that fills* `requestHash` differs, so
  there is no schema delta at all.
- **Security consequence.** The reservation is per `(scope, key)` and the record is written by
  `ocr_app` under the tenant RLS policy, so one organisation's key cannot collide with another's.
  Layer 2's uniqueness is tenant-scoped for the same reason (`f1` `uniq.extraction_job_dedupe`:
  *"unique-constraint checks bypass RLS, so a global unique on tenant-controlled input is a
  cross-tenant existence oracle"*).
- **Config/env consequence.** `OCR_QUEUE_IDEMPOTENCY_TTL_S=86400`,
  `OCR_QUEUE_IDEMPOTENCY_SCOPE=ocr.document.submit`.

**Layer 2, stated once and only as a wiring rule.** The dedupe key is `f1` `job.dedupe_key_grammar`;
the constraint is `f1` `uniq.extraction_job_dedupe`; the enqueue is
`INSERT … ON CONFLICT (organization_id, dedupe_key) DO NOTHING RETURNING id`, and the `?? findUnique`
fallback queries on the same `(organization_id, dedupe_key)` pair. **`h` §10.2's `sha256`-canonical
dedupe key and its `ocr_jobs_dedupe_live_idx` partial unique index are both superseded** — the
run-scoped grammar makes the "live only" predicate unnecessary, because a terminal run's keys can
never be regenerated (D-C2-13).

**R15 — atomicity.** `createDocument`, `createDocumentRun`, `createExtractionJob` and
`enqueueOutboxEvent` are **four statements in one `prisma.$transaction()`**. This is the single
strongest argument for the PostgreSQL substrate and it survives every review: with Redis they cannot
be, and you would need the outbox relay pattern — an extra process, an extra at-least-once boundary,
and a new class of incident ("documents stuck at 0% because the relay died"). The substrate decision
(`h` L1, `m` O2) is **not reopened here**; the panel agreed with it under all three lenses.

---

## 11. Duplicate submission

### D-C2-16 — Same bytes, same organisation ⇒ one `StorageObject`, **N `Document` rows**. Cross-tenant ⇒ nothing is shared, ever

- **Competing proposals.** (a) `g` §7.1: a second upload of identical bytes in the same organisation
  returns the *existing* document. (b) `h` L7: a per-tenant content-addressed OCR page cache, so the
  second document is created but is near-instant. (c) A new `Document` row over the same
  `StorageObject`, with no OCR reuse.
- **Selected.** **(c).**
  - **Same sha256, same organisation, same uploader, replayed request** → layer 1 (D-C2-15) returns
    the first response. One document, one job.
  - **Same sha256, same organisation, a genuinely new submission** (different uploader, different
    workspace, or a deliberate re-upload) → a **new `Document` row** with its own `public_id`, its
    own `owner_membership_id`, its own `workspace_id` and its own `visibility` (`f1`
    `authz.upload_default_workspace`), pointing at the **same** `storage_objects` row, which is
    deduplicated by `f1` `uniq.storage_original_fingerprint`. A new run, a new job, OCR runs again.
  - **Same sha256, different organisation** → **nothing whatsoever is shared.** The frozen
    fingerprint uniqueness is `(organization_id, content_fingerprint)`, so two organisations that
    upload identical bytes get two independent storage objects, two documents and two OCR passes.
- **Rejected.**
  - (a) — returning another principal's document is an authorization decision disguised as a
    performance optimisation, and it collides head-on with `f1` `api.not_found_rule`: to return the
    existing document you must first decide whether this principal may see it, and if it may not,
    the *only* correct answers are "create a new one" or "404". Answering "here is a document you did
    not upload" would leak ownership; answering "409 duplicate" would leak existence. (c) makes the
    question unaskable.
  - (b) — deleted with `ocr_page_results` (D-C2-14). Its reopening trigger is stated there.
- **Reason.** Document identity is per-upload; byte identity is per-organisation; and **the two must
  not be conflated**, because ownership, workspace and visibility are properties of the upload, not
  of the bytes.
- **Implementation consequence.** Storage deduplication is invisible above the storage port. The
  response to a duplicate upload is a normal `202` with a fresh `doc_<32>` and **no field naming any
  other document** — no `duplicate_of`, no `alreadyExists`. Erasure follows: deleting one document
  must not delete a `storage_objects` row another document still references, so the object is
  reference-counted and its physical delete is owned by `gate-2-pdpa-retention.md`'s crypto-shredding
  regime (per-document DEK, `f1` §11.3), which makes shared ciphertext safe to retain.
- **Migration consequence.** None — the constraint is frozen.
- **Security consequence.** **Cross-tenant dedup is structurally impossible, not merely disabled.**
  There is no timing signal to probe, because the second organisation's upload does the same work as
  the first: `f1` `api.not_found_floor_ms` is not even needed on this path. `h` L7's deferred
  "cross-tenant dedupe with its own threat review" is not deferred here — the frozen constraint
  forecloses it, and reopening it would require changing a frozen uniqueness key.
- **Config/env consequence.** `ocr_duplicate_original_uploads_total` counter (labels: none) to feed
  D-C2-14's reopening trigger.

---

## 12. The Node-enqueues / Python-consumes contract

### 12.1 Governing rules

1. **One source of truth: Zod 4.4.3, in the Next repo.** The producer owns the schema.
2. **The wire format is JSONB in a Postgres column.** No serialisation library, no codegen at
   runtime, no schema registry service. Both languages speak JSON and SQL natively; this is the
   cheapest possible coupling between a TypeScript producer and a Python consumer.
3. **Every message carries `schemaVersion` as a literal**, and the consumer rejects an unknown
   version with a *terminal* error (`PAYLOAD_VERSION_UNKNOWN`, `maxAttempts: 1`) — never a guess,
   never a best-effort parse.
4. **No secrets, no credentials, no pre-signed URLs and no document content in the payload.** The
   payload sits at rest in a table operators read.
5. **No raw exception text ever crosses the boundary into Postgres** — a closed error-code enum plus
   an allow-listed detail object (`h` L21, kept). Free-form text goes to structured logs, which have
   their own retention and access controls.
6. **Every length bound that can carry user text is declared in UTF-8 bytes** and enforced with a
   shared refinement on both sides, never with the native `.max()` — Zod counts UTF-16 code units,
   Pydantic counts code points, `VARCHAR(n)` counts characters (`h` L30/§9.2, kept).

### D-C2-17 — `ExtractionJobPayloadV1`, and the split between snapshotted and live configuration

- **Competing proposals.** (a) `h` §9.2: the payload carries the whole resolved policy including
  `renderDpi`, `maxRenderPages`, `maxRenderPixels`, `ocrBudgetPages` and a `budget` object. (b) The
  payload carries only identifiers, and the worker reads every limit live from
  `@innovera/ocr-limits` / `innovera_ocr_limits` (`f2` `LIMITS_SOURCE_OF_TRUTH`).
- **Selected.** A principled split: **values that change the *result* are snapshotted into the
  payload at enqueue; values that are *operational* are read live.**
  - Snapshotted (`policy`): `pipelineVersion`, `engineProfile`, `languages`, `renderDpi`,
    `maxOcrPages`, `maxPagePixels`, `trustExistingOcrLayer`, `preprocess.recipeHash`,
    `aiExtraction.{enabled,promptVersion,schemaId}`.
  - Live: every timeout, every budget, every concurrency cap, every rate limit, every quota. Read
    from the generated limits package at the moment they are used.
- **Rejected.**
  - (a) wholesale — putting `JOB_PROCESSING_BUDGET_MS` in the payload means a queued job carries a
    stale budget for up to `f2` `JOB_QUEUE_TTL_MS` = 24 h, and an operator lowering the budget cannot
    affect the backlog. `budget_ms` is a **column**, set at enqueue and updatable by an operator; the
    payload does not carry it. `h` §9.2's `budget` object is deleted.
  - (b) wholesale — a config change to `renderDpi` mid-flight would make pages 1–20 of a document
    300 dpi and pages 21–50 400 dpi, and `f1` `uniq.ocr_result` includes `render_dpi`, so the run
    would silently contain two incompatible evidence sets.
- **Reason.** "Would changing this value mid-run corrupt the output?" is a mechanical test, and it
  partitions the config surface cleanly.

```ts
// contracts/src/extraction-job-payload.v1.ts        (zod 4.4.3)
import { z } from "zod";

const utf8Bytes = (n: number) => (s: string) => new TextEncoder().encode(s).length <= n;
export const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

export const extractionJobPayloadV1 = z.strictObject({
  schemaVersion:  z.literal(1),
  jobId:          z.uuid(),
  kind:           z.enum(["DOCUMENT_EXTRACT", "AI_EXTRACT"]),
  organizationId: z.uuid(),                 // f1 tenant.scope_column
  documentId:     z.uuid(),
  documentPublicId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{32}$/),   // f1 id.external.shape
  runId:          z.uuid(),                 // f1 D-F1-12 — NOT NULL, never derived
  runSeq:         z.number().int().positive(),
  correlationId:  z.uuid(),

  source: z.strictObject({
    objectKey:        z.string().refine(utf8Bytes(512)),   // MUST start `org/{organizationId}/`
    contentFingerprint: sha256Hex,
    sizeBytes:        z.number().int().positive(),
    declaredMime:     z.string().max(255),                 // client-declared; NOT trusted
    originalFilename: z.string().refine(utf8Bytes(512), { message: "filename_too_long" }),
  }),

  policy: z.strictObject({
    pipelineVersion:       z.string().max(60),
    engineProfile:         z.enum(["classical", "vlm", "auto"]),
    languages:             z.array(z.enum(["tha", "eng"])).min(1).max(4),
    renderDpi:             z.number().int().min(150).max(600),
    maxOcrPages:           z.number().int().min(0),        // snapshot of f2 MAX_OCR_PAGES_PER_DOCUMENT
    maxPagePixels:         z.number().int().min(1),        // snapshot of f2 MAX_PAGE_PIXELS
    trustExistingOcrLayer: z.enum(["never", "if-clean", "always"]),
    preprocess: z.strictObject({
      deskew: z.boolean(), binarize: z.boolean(), clahe: z.boolean(),
      recipeHash: sha256Hex,                               // dimension F's ordered-op hash
    }),
    aiExtraction: z.strictObject({
      enabled:       z.boolean(),                          // gate-2 ai.stage.enabled.default
      promptVersion: z.string().max(40),
      schemaId:      z.string().max(80).nullable(),
    }),
  }),
});
export type ExtractionJobPayloadV1 = z.infer<typeof extractionJobPayloadV1>;
```

**Deliberate omissions, each for a reason:**

| Omitted | Why |
|---|---|
| a pre-signed source URL | it expires while the job is queued or retried; `f2` `JOB_QUEUE_TTL_MS` is 24 h. The worker uses its own credential. |
| any credential or token | the payload is at rest in a table operators read |
| a callback URL | v1 has exactly one result path (DB + object storage). An HTTP callback is a second, lossy, SSRF-shaped path |
| document text, thumbnails, page images | the queue table must stay small and HOT-updatable (§17.4) |
| `budget`, timeouts, concurrency | operational, read live (D-C2-17) |
| tenant name, user email | PII minimisation. `originalFilename` survives only because the UI needs it and the tenant already sees it |

**`objectKey` carries the frozen tenant prefix.** `f1` `storage.tenant_prefix_check` puts
`CHECK (result_ref LIKE 'org/' || organization_id::text || '/%')` on `extraction_jobs.result_ref`;
the same rule is asserted on `payload->'source'->>'objectKey'` **in `ocr-web` at enqueue and in the
Pydantic model at consume**, because a JSONB path cannot carry a composite-FK-style check cheaply.
Object-storage keys are resolved with the app credential and never touch PostgreSQL, so neither the
composite FK nor RLS applies to them — the prefix must be a constraint, not a convention.

**Thai invariants on this boundary**, all carried forward from `h` §9.8 with tests:

| # | Invariant | Test |
|---|---|---|
| T-1 | No Thai ever reaches an object key, a path, a channel name or an identifier log field. Keys are `org/{uuid}/…` — ASCII by construction | assert the stored key matches `^[A-Za-z0-9/_.-]+$`; the filename survives only in `originalFilename` |
| T-2 | Every Thai-bearing string is NFC-normalised **once**, at ingress in `ocr-web`, before hashing, storing or enqueueing | upload identical bytes with an NFD and an NFC filename; assert **one** job and **one** dedupe key |
| T-3 | Lengths are byte lengths | five fixtures: NFC Thai, NFD Thai, a filename with an emoji, one at exactly 512 bytes, one at 513 |
| T-5 | Thai numerals ๐–๙ (U+0E50–U+0E59) are preserved verbatim in extracted text and never normalised to ASCII digits at this layer | round-trip `๐๑๒๓๔๕๖๗๘๙`; a Thai tax-invoice number silently becoming `123` is a data-integrity failure in a legal document |
| T-6 | ZWSP (U+200B) and `฿` survive the JSONB round trip and the 4 096-**byte** `detail` cap | round-trip fixture; the cap holds ~1 300 Thai characters, not 4 096 |
| T-7 | `TimeZone` is pinned to `UTC` on every connection (`ocr_app`, `ocr_queue`, `ocr_worker`, `ocr_ai_worker`, migrations) | `SHOW TimeZone` assertion in the connection-health test |

The worker pins **Python 3.12** and asserts `unicodedata.unidata_version >= "15.0.0"` at startup.

### D-C2-18 — Schema governance, the drift guard, and the deploy order

- **Selected.** `h` L10/L11/§9.7's governance, adopted with the file paths renamed and one
  correction kept:
  ```
  contracts/
    src/extraction-job-payload.v1.ts      # Zod, source of truth
    src/extraction-job-result.v1.ts
    src/error-codes.json                  # owner: this document; AI_* members: k (f3 ai.error.taxonomy_owner)
    generated/extraction-job-payload.v1.input.schema.json    # committed, generated
    generated/extraction-job-payload.v1.output.schema.json
    generated/extraction-job-result.v1.output.schema.json
    fixtures/payload.v1.{valid,invalid}.*.json
  ```
  `z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" | "output", unrepresentable: "throw" })`.
  **Both directions are emitted**: the payload is produced by Node and validated by Python, so
  Python validates against the **input** schema; the result is produced by Python and consumed by
  Node, so Node validates against the **output** schema. With no `.default()` or `.transform()` in
  the schema today the two are identical — but the moment anyone adds one, the committed schema and
  the wire bytes diverge and a single-direction gate passes while production fails.

  **Five CI gates, all required to merge:**
  1. `pnpm contracts:emit && git diff --exit-code contracts/generated` — the drift guard.
  2. `pytest tests/contract/test_payload_schema.py` — every `*.valid.json` validates against **both**
     the input JSON Schema and the Pydantic model; every `*.invalid.json` is rejected by **both**.
  3. The same fixtures parsed by Zod, same assertions.
  4. `pnpm contracts:i18n` — every code with `userFacing: true` has a `msgKey` present in **both**
     `messages/th.json` and `messages/en.json`. A missing Thai string fails the build.
  5. `pnpm contracts:codes` — every row in `error-codes.json` has `retryable`, `userFacing`, `http`,
     `maxAttempts` ≤ 5, and `pageLevel` ∈ `{none, content, transient}`.

  **Version evolution:**

  | Change | New `schemaVersion`? | Deploy order |
  |---|---|---|
  | add an **optional** field with a consumer-side default | no | either |
  | add a **required** field | **yes** | consumer first |
  | remove or rename any field | **yes** | consumer first |
  | add an enum member the consumer must handle | **yes** | consumer first |
  | change a field's meaning without changing its type | **yes** — the dangerous one | consumer first |

  **Deploy order is scripted, not documented**, because `extra="forbid"` on the Pydantic side is only
  safe if it holds:
  ```bash
  # deploy.sh — consumers before producer, always. Non-negotiable.
  docker compose up -d --wait ocr-migrate
  docker compose up -d --wait ocr-worker        # consumer
  docker compose up -d --wait ocr-ai-worker     # consumer (f3 ai.service.name; profile: ai)
  docker compose up -d --wait ocr-web           # producer, last
  ```
  During the window the *new* worker reads *old* payloads, which is always safe because a new
  consumer still accepts every version it ever accepted. **Rollback is the mirror image and is the
  case people forget:** rolling `ocr-web` back is safe; rolling a worker back while
  higher-`schema_version` rows are still `PENDING` is not. The runbook line:
  `SELECT count(*) FROM extraction_jobs WHERE status='PENDING' AND schema_version > $target` **must
  return 0** before a worker rollback, else drain or cancel those jobs first.
- **Reason.** `h` R14 — *"the Node and Python sides cannot silently disagree about the payload
  shape"* — is a CI property or it is nothing.
- **Security consequence.** `unrepresentable: "throw"` will throw on `z.date()`, `z.bigint()`,
  `z.map()`, `z.set()` and `z.custom()`. That is the point: it prevents a field with no cross-language
  representation. It must be documented, or the first person who reaches for `z.date()` will "fix"
  the build by relaxing the option.

### D-C2-19 — Progress: columns per page, events per transition, polling for the UI

- **Competing proposals.** (a) `h` §9.5 draft: SSE from day one, server polling one row at 1 s.
  (b) Dimension L decision L-8 and `h` L31: **adaptive polling** of a batch-status endpoint; SSE only
  on the single-document review screen, flagged off in M1.
- **Selected.** (b). The write policy is the part this document owns:

  | Signal | Written | Where | Volume for a 50-page job |
  |---|---|---|---|
  | `progress_stage`, `pages_done`, `pages_total`, `progress_pct` | **every page** | `extraction_jobs` columns, via `ocr_progress_v1` | 50 HOT updates of one row |
  | stage transition, every failure, every poison verdict, **every 10th page** | `job_events` row, via `ocr_event_v1` | append-only audit | ~12 rows |
  | per-page evidence | `ocr_results` row, via `ocr_page_result_v1` | append-only evidence | 50 rows |

  The UI reads the **columns**; the audit trail reads the **events**. Confusing the two is what makes
  a queue table unmaintainable at year two (§17.4).

  **Adaptive cadence** (the "adaptive" in L-8, which `h`'s fixed 1 s did not have):

  | Job state | Poll interval |
  |---|---|
  | `PENDING` | 5 s, backing off to 15 s after 120 s |
  | `RUNNING`, `pages_total ≤ 5` | 1 s |
  | `RUNNING`, `pages_total > 5` | `clamp(2 s, median_page_ms, 10 s)` — one poll per page, not per second |
  | terminal | stop |
  | tab hidden (`document.visibilityState`) | **pause entirely** — the largest saving, and free |

  `Cache-Control: no-store` plus an `ETag`; a `304` costs one index probe and no serialisation.
  `Retry-After` on 429 is honoured by the client — the poll loop is subject to `f2` `RATE_READ` like
  every other endpoint.

  **Public state mapping** (`l`'s enum is `queued|processing|succeeded|failed|cancelled`):

  | Internal | Public | Note |
  |---|---|---|
  | `PENDING` | `queued` | |
  | `RUNNING` | `processing` | |
  | `SUCCEEDED`, `degraded=false` | `succeeded` | |
  | `SUCCEEDED`, `degraded=true` | `succeeded` + `warnings[]` | the gap list is in the body, never in the state |
  | `FAILED` | `failed` | `last_error_code` surfaced only when `userFacing: true`, as `{code, msgKey, params}` |
  | **`DEAD`** | **`failed`** | deliberately indistinguishable from outside |
  | `CANCELLED` | `cancelled` | `abort_reason` surfaced |

  **The server never returns prose.** It returns `{code, msgKey, params}`; the `th` and `en`
  catalogues in the Next app are the only place a sentence exists. `params` are interpolated
  client-side, never concatenated server-side — Thai has no spaces at word boundaries, so a
  server-built `"Error: " + filename` produces a run-on a Thai reader parses wrongly. `fileName` is
  rendered with `dir="auto"` and Unicode-isolated (`⁨…⁩`), because a filename mixing Thai, Latin and
  an RTL script otherwise reorders the surrounding sentence — a spoofing vector as well as a
  legibility one.

  **SSE turns on when:** > 500 concurrent watchers on the review screen, **or** the poll query enters
  the `pg_stat_statements` top 10 by total time. The transport changes; this table does not.

---

## 13. Cancellation

### D-C2-20 — Cooperative abort at page boundaries, carried by the heartbeat alone

| Job state | Cancellable | Mechanism | Latency | Effect on side effects |
|---|---|---|---|---|
| `PENDING`, never claimed | **yes, hard** | `UPDATE … SET status='CANCELLED' WHERE id=$1 AND organization_id=$2 AND status='PENDING'` (`ocr_app`) | immediate | none — nothing happened |
| `PENDING`, in retry backoff | **yes, hard** | same | immediate | completed pages retained; run ends `CANCELLED` |
| `RUNNING`, between pages | **yes, cooperative** | `abort_requested = true`; the worker learns it from the next heartbeat | **≤ `HEARTBEAT_INTERVAL_S` + `PAGE_OCR_TIMEOUT_S` = 15 + 45 = 60 s** | pages already in `ocr_results` are kept and downloadable |
| `RUNNING`, inside a page render / OCR call | deferred to the page boundary | the worker checks `stop` after the page | as above | the in-progress page is completed and persisted, not discarded |
| `RUNNING`, inside a billed AI gateway call | **no — by design** | the call runs to completion, the response is persisted to `ai_calls`, *then* the job stops | ≤ `f3` `ai.timeout.call_ms` | **we already paid; we keep what we paid for** |
| `SUCCEEDED` / `FAILED` / `DEAD` / `CANCELLED` | no | terminal | — | — |

**Five rules.**

1. **Never SIGKILL a worker to cancel a job.** It kills every other job on that worker and leaves
   leases to expire.
2. **Never `pg_cancel_backend` / `pg_terminate_backend`.** They cancel a *query*, not a job, and
   corrupt lease accounting.
3. **Never abandon a paid-for AI response.** `f3` records that LiteLLM performs its own upstream
   retries and fallbacks, so aborting our client connection does not necessarily stop — or unbill —
   work already in flight upstream. That makes "let it finish and keep the result" the *only*
   defensible rule, not merely the frugal one.
4. **Partial results are a feature, not debris.** A cancelled 50-page job that completed 40 pages
   produces a downloadable 40-page result with `degraded = true` and an explicit gap list. Users
   cancel because something is taking too long; handing them what exists is strictly better than
   handing them nothing.
5. **The abort flag is only ever true on a `RUNNING` row.** Every transition out of `RUNNING` clears
   it (§6.3, §6.4), and a cancel that is lost to a crash is **re-issued by the app**, not carried
   forward. Carrying it forward means a `PENDING` job silently self-cancels on its next claim, which
   no operator watching the DLQ would predict. Losing a cancel is a latency bug; keeping a stale one
   is a correctness bug. The cancel endpoint is idempotent and the UI keeps showing "cancelling…"
   until the job is terminal, so a re-issue is one extra `UPDATE`, not a user-visible regression.

**Only `ocr_app` writes `abort_requested`**, and only under the tenant policy:
```sql
UPDATE extraction_jobs
   SET abort_requested = true, abort_reason = $3, updated_at = now()
 WHERE id = $1 AND organization_id = $2 AND status = 'RUNNING' AND abort_requested = false;
-- 0 rows and status='PENDING' -> take the hard-cancel branch. One statement, one branch.
```
`abort_reason VARCHAR(40)` is a **closed set** — `user_request | admin_request | quota_exceeded |
requeue_requested | org_deleted` — never free text, because it is rendered to a user via `msgKey`.

---

## 14. Concurrency, fairness and backpressure

Every number in this section is **frozen by `f2` and cited, never restated**:
`MAX_CONCURRENT_JOBS_GLOBAL`, `WORKER_JOB_CONCURRENCY`, `MAX_CONCURRENT_JOBS_PER_USER`,
`MAX_QUEUED_DOCS_PER_USER`, `MAX_INFLIGHT_UPLOADS_PER_USER`, `RENDER_CONCURRENCY`,
`DB_POOL_PER_APP_INSTANCE`, `JOB_QUEUE_TTL_MS`, and the quota family
(`DEFAULT_DOCS_PER_DAY`, `DEFAULT_PAGES_PER_DAY`, …). `f3` `ai.concurrency` owns the AI side.

What this document owns is **where each is enforced**, which M0 left ambiguous:

| Limit | Enforced at | Response when exceeded |
|---|---|---|
| `MAX_CONCURRENT_JOBS_PER_USER` | **inside `ocr_claim_v1`** (§6.1) | not an error — invisible to the client, the job simply waits |
| `MAX_CONCURRENT_JOBS_GLOBAL` | worker slot count (`OCR_WORKERS × WORKER_JOB_CONCURRENCY`) | not an error |
| `MAX_QUEUED_DOCS_PER_USER` | **at enqueue**, in the same transaction as the insert | `429` + `Retry-After: 60`, body carries queue position |
| pending-page ceiling | at enqueue, `sum(COALESCE(pages_total, est_pages))` over `PENDING` | `429` |
| `MAX_PAGES_PER_DOCUMENT` | at upload, before a job exists | `413 payload_too_large` (`f2` `ERROR_CODE_OVERSIZE_BODY`) |
| quotas (docs/pages/bytes/tokens per day and month) | `f2` `QUOTA_CHECK_ORDERING` — **before the storage PUT and before each AI call**, decremented in the same transaction as the usage row | `429 quota_exceeded` / `507 storage_quota_exceeded` (`f2` `ERROR_CODE_QUOTA`) |
| `JOB_QUEUE_TTL_MS` | `ocr_reap_v1` pass 4 | `FAILED` / `QUEUE_WAIT_EXCEEDED`, and it **pages** |

**`est_pages`** — a column, `Int @default(1)`, written at enqueue. It exists because `pages_total` is
NULL until the worker opens the document, and because `h` §14.2's original expression
(`payload->'policy'->>'maxRenderPages'`) read a policy **ceiling**, so a queue of 100 one-page
receipts reported 200 000 pending pages and would have shed traffic against 100 pages of real work.
For PDFs `ocr-web` already knows the count from the upload-time page check; for images it is 1; for
anything unknown it is a conservative constant of 10.

**Admission pressure**, computed from a 5 s-cached view (`extraction_queue_pressure`, §18.1) and
never per request:

| Pressure | Condition | Action |
|---|---|---|
| Normal | `pending < 500` | accept everything |
| Elevated | `pending ≥ 500` **or** `oldest_pending_s > 600` | shed **batch/backfill** submissions with `503` + `Retry-After: 300`; keep interactive and API |
| Critical | `pending ≥ 2000` **or** `oldest_pending_s > 1800` | shed batch **and** API with `503`; keep interactive uploads only; page the on-call |

Thresholds are scaled to `f2` `MAX_CONCURRENT_JOBS_GLOBAL = 4` — `h`'s 2 000/5 000 were sized for a
cluster an order of magnitude larger and would never have engaged. Env:
`OCR_QUEUE_PRESSURE_ELEVATED_PENDING=500`, `OCR_QUEUE_PRESSURE_CRITICAL_PENDING=2000`.

**`oldest_pending_s` is measured from `created_at`, never from `available_at`.** Every retry pushes
`available_at` into the future, so `min(available_at)` reports the *soonest-runnable* job rather than
the *longest-waiting* one — meaning a gateway outage produces thousands of retrying jobs, the primary
SLO metric reads healthy, backpressure never engages and nobody is paged. `h` §14.2 called this its
single most consequential observability bug; the same fix applies to the ageing sweep (§D-C2-5) and
to every view in §18.1.

**Shedding order rationale, because it is counter-intuitive:** an interactive upload has a human
waiting and is one page most of the time; a backfill has nobody waiting and is thousands. Shedding
the cheap latency-sensitive traffic first is exactly backwards.

---

## 15. Wake-up notification

### D-C2-21 — **One** channel, empty payload, wake-up only. There is **no** abort channel

- **Competing proposals.** (a) `h` §6.4 draft: `pg_notify('ocr_jobs_v1', json_build_object('jobId',
  …, 'tenantId', …, 'priority', …))` plus `pg_notify('ocr_abort_v1', {'jobId', 'reason'})`.
  (b) `h` §6.4 as corrected: an empty wake-up payload plus **per-job abort channels**
  (`pg_notify('ocr_abort_v1_' || NEW.id, '')`), with `LISTEN` issued dynamically for the duration of
  each job. (c) One empty wake-up channel and no abort channel at all.
- **Selected.** **(c).**
  ```sql
  CREATE FUNCTION ocr_notify_job_ready_v1() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
  BEGIN
    PERFORM pg_notify('ocr_wake_v1', '');   -- zero information content
    RETURN NEW;
  END; $fn$;

  CREATE TRIGGER extraction_jobs_notify_ready_v1
    AFTER INSERT ON extraction_jobs FOR EACH ROW
    WHEN (NEW.status = 'PENDING')
    EXECUTE PROCEDURE ocr_notify_job_ready_v1();
  ```
- **Rejected.**
  - (a) — PostgreSQL's own documentation states *"Notifications are visible to all users."* There is
    **no `GRANT` for a notification channel**, so any role that can connect could `LISTEN` and
    observe a live stream of organisation ids, job ids and arrival rates: a real cross-tenant
    metadata side channel in a product sold on secure document handling.
  - (b) — the panel's third feasibility finding: `h` §6.4 declared *"Option 1 is chosen"* while
    `h` §12.3's Python still executed `LISTEN ocr_abort_v1` and `json.loads(note.payload)["jobId"]`
    — listening on a channel nothing publishes to, and raising `JSONDecodeError` on the empty payload
    if it did. Beyond the inconsistency, per-job `LISTEN` requires issuing a *dynamic identifier*
    `LISTEN` on the same dedicated connection whose notification generator is already being consumed
    by a long-lived task, which is a non-trivial concurrency constraint neither M0 document
    addressed.
- **Reason.** **The notification is an optimisation; the heartbeat and the poll are the
  guarantees.** Deleting the abort channel deletes a documented metadata side channel *and* a
  concurrency hazard *and* an inconsistency between two sections, and costs exactly one thing:
  cancel latency rises from `h`'s claimed ≤ 20 s to a measured, honest **≤ 60 s**
  (`HEARTBEAT_INTERVAL_S` 15 + `PAGE_OCR_TIMEOUT_S` 45). `h`'s ≤ 20 s was not achievable anyway once
  the panel showed `§12.3` listened to the wrong channel.
- **Implementation consequence.** One `LISTEN ocr_wake_v1` per worker **process** (not per job), on a
  dedicated connection, with a `select()` timeout of `POLL_INTERVAL_S`. A dropped notification costs
  ≤ 2 s of latency, never a lost job. **`LISTEN` does not work through PgBouncer in transaction-
  pooling mode** — the listener must be a **direct** connection. Connection budget: 2 workers ×
  (1 queue + `WORKER_JOB_CONCURRENCY` work + 1 listen) = 2 × 4 = 8, plus `f2`
  `DB_POOL_PER_APP_INSTANCE` = 10 for `ocr-web`, plus `ocr-ai-worker`'s pools, plus the migrate
  one-shot — comfortably under `max_connections = 100`.
- **Migration consequence.** One trigger, one function; no abort trigger is created.
- **Security consequence.** Zero information content on the only channel. There is nothing to
  correlate, no arrival-rate signal, and no job-id oracle.
- **Config/env consequence.** `OCR_QUEUE_NOTIFY_CHANNEL=ocr_wake_v1`.

---

## 16. Run settlement and the terminal domain event

### D-C2-22 — The run is settled in the worker's own commit, by a function, and the outbox event fires from the **run**, not the job

- **Competing proposals.** (a) `h` L27: an `AFTER UPDATE OF state ON ocr_jobs` `SECURITY DEFINER`
  trigger writing `document.extracted` / `document.failed` per **job**. (b) A Node-side reconciler
  polling for terminal jobs. (c) A settlement function called by the four terminal paths, emitting
  one event per **run**.
- **Selected.** **(c).**
```sql
CREATE FUNCTION ocr_settle_run_v1(p_job uuid)   -- NULL = settle every eligible run
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE n int := 0;
BEGIN
  WITH target AS (
    SELECT DISTINCT j.run_id, j.organization_id
      FROM extraction_jobs j
     WHERE (p_job IS NULL OR j.id = p_job)
  ), agg AS (
    SELECT t.run_id, t.organization_id,
           count(*) FILTER (WHERE j.status IN ('PENDING','RUNNING'))  AS live,
           count(*) FILTER (WHERE j.status IN ('FAILED','DEAD'))      AS bad,
           count(*) FILTER (WHERE j.status = 'CANCELLED')             AS cancelled
      FROM target t JOIN extraction_jobs j
        ON j.run_id = t.run_id AND j.organization_id = t.organization_id
     GROUP BY t.run_id, t.organization_id
  ), settled AS (
    UPDATE document_runs r
       SET outcome = CASE WHEN a.bad > 0       THEN 'FAILED'
                          WHEN a.cancelled > 0 THEN 'CANCELLED'
                          ELSE 'SUCCEEDED' END,
           finished_at = now()
      FROM agg a
     WHERE r.id = a.run_id AND r.organization_id = a.organization_id
       AND r.outcome = 'RUNNING' AND a.live = 0
    RETURNING r.id, r.organization_id, r.document_id, r.run_seq, r.outcome
  )
  INSERT INTO outbox_events (id, event_type, event_version, aggregate_id, payload,
                             occurred_at, available_at, status)
  SELECT gen_random_uuid(),
         CASE s.outcome WHEN 'SUCCEEDED' THEN 'document.run.succeeded'
                        WHEN 'CANCELLED' THEN 'document.run.cancelled'
                        ELSE 'document.run.failed' END,
         1, s.document_id::text,
         jsonb_build_object('organizationId', s.organization_id, 'documentId', s.document_id,
                            'runId', s.id, 'runSeq', s.run_seq, 'outcome', s.outcome),
         now(), now(), 'PENDING'
    FROM settled s;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END; $fn$;
```
- **Rejected.**
  - (a) — a per-job trigger fires once per job, so a run with a `DOCUMENT_EXTRACT` and an
    `AI_EXTRACT` job emits **two** `document.*` events for one document, and webhook subscribers,
    search indexing and billing must each deduplicate. Worse, the panel showed the trigger's
    `WHEN (NEW.state IN (…))` clause has **no lease check**, so under `h`'s column grants a
    compromised worker could produce a genuine, database-signed `document.extracted` event for a
    victim organisation with an attacker-chosen `resultUri`. Under D-C2-6 that path is closed by the
    absence of DML, and moving settlement into the function makes it explicit rather than incidental.
  - (b) — a second at-least-once boundary and the exact "documents stuck at 100% because the
    reconciler died" incident the substrate decision rejected Redis for.
- **Reason.** *Precedence is `FAILED` > `CANCELLED` > `SUCCEEDED`*, stated once. One event per run is
  the unit consumers actually want ("this document finished a pass"), and the run row is where
  `run_seq` lives, so the event is self-describing.
- **Implementation consequence.** **The queue never writes `documents`.** `documents.status` is a
  projection maintained by whoever owns `DocumentStatus` — `f1` §11.2 records that vocabulary as
  unresolved between `g` §4.1 (11 states) and `j` §4.1 (8 different values), and this document
  deliberately does not pick one. `ocr_worker` and `ocr_queue` hold no grant on `documents`, so the
  question cannot leak into the queue's blast radius while it stays open.
- **Migration consequence.** The `outbox_events` insert uses jawbong's shipped column set verbatim
  (`event_type`, `event_version`, `aggregate_id`, `payload`, `occurred_at`, `available_at`,
  `status`), so no schema change to the copied table.
- **Security consequence.** `SECURITY DEFINER` hardening, all four applied: owned by `ocr_owner`
  (not a superuser), `SET search_path = public` pinned, no dynamic SQL, `REVOKE EXECUTE … FROM
  PUBLIC`. The function takes a job id it has already lease-validated, or `NULL` from the reaper,
  which is the only caller that may settle a run it does not hold a lease on — and the reaper is
  itself only callable by `ocr_queue`.
- **Config/env consequence.** None.

---

## 17. The schema

### 17.1 `ExtractionJob` — Prisma 7.9.1

Only the queue's own columns are authoritative here. `documents`, `document_runs`, `document_pages`,
`ocr_results` and `ai_calls` are owned by `f1` / `f3` and are shown only where a relation is needed.

```prisma
enum JobStatus     { PENDING RUNNING SUCCEEDED FAILED DEAD CANCELLED }
enum JobKind       { DOCUMENT_EXTRACT AI_EXTRACT }
enum JobEventKind  {
  CLAIMED STAGE_STARTED STAGE_FINISHED
  PAGE_DONE PAGE_SKIPPED PAGE_FAILED_CONTENT PAGE_FAILED_TRANSIENT PAGE_POISONED
  PROGRESS LEASE_EXPIRED RETRY_SCHEDULED ABORT_REQUESTED
  SUCCEEDED FAILED DEAD_LETTERED CANCELLED
}

model ExtractionJob {
  id              String    @id @db.Uuid                       // f1 id.internal: uuid v7, app-generated
  organizationId  String    @map("organization_id") @db.Uuid   // f1 tenant.scope_column
  documentId      String    @map("document_id")     @db.Uuid
  runId           String    @map("run_id")          @db.Uuid   // f1 D-F1-12, NOT NULL
  kind            JobKind
  schemaVersion   Int       @default(1) @map("schema_version")
  payload         Json      @db.JsonB                          // ExtractionJobPayloadV1

  status          JobStatus @default(PENDING)
  /// RANK. LOWER RUNS SOONER. See c2-queue-contract.md D-C2-5.
  priority        Int       @default(100)
  dedupeKey       String    @map("dedupe_key") @db.VarChar(200) // f1 job.dedupe_key_grammar
  availableAt     DateTime  @default(now()) @map("available_at")     @db.Timestamptz(3)
  queueExpiresAt  DateTime  @map("queue_expires_at")                 @db.Timestamptz(3)

  // ---- lease / fencing (D-C2-8) ----
  leaseTokenHash  Bytes?    @map("lease_token_hash")  @db.ByteA       // sha256, 32 bytes
  leaseExpiresAt  DateTime? @map("lease_expires_at")  @db.Timestamptz(3)
  lockedBy        String?   @map("locked_by")         @db.VarChar(120) // operator label, NEVER a guard
  lockedAt        DateTime? @map("locked_at")         @db.Timestamptz(3)

  // ---- retry ----
  attempts        Int       @default(0)
  maxAttempts     Int       @default(5) @map("max_attempts")     // D-C2-9

  // ---- budget (per claim; f2 JOB_PROCESSING_BUDGET_MS) ----
  budgetMs        Int       @map("budget_ms")
  deadlineAt      DateTime? @map("deadline_at") @db.Timestamptz(3) // NULL until the first claim

  // ---- control ----
  abortRequested  Boolean   @default(false) @map("abort_requested")
  abortReason     String?   @map("abort_reason") @db.VarChar(40)   // closed set, never free text

  // ---- progress (display only; NEVER a resume pointer) ----
  progressStage   String?   @map("progress_stage") @db.VarChar(60)
  progressPct     Int       @default(0) @map("progress_pct")
  estPages        Int       @default(1) @map("est_pages")
  pagesTotal      Int?      @map("pages_total")
  pagesDone       Int       @default(0) @map("pages_done")

  // ---- outcome ----
  result          Json?     @db.JsonB                             // ExtractionJobResultV1, <= 64 KiB
  resultRef       String?   @map("result_ref") @db.VarChar(1024)   // f1 storage.tenant_prefix_check
  degraded        Boolean   @default(false)
  lastErrorCode   String?   @map("last_error_code")   @db.VarChar(80)
  lastErrorDetail Json?     @map("last_error_detail") @db.JsonB    // allow-listed keys only
  lastErrorAt     DateTime? @map("last_error_at") @db.Timestamptz(3)

  startedAt       DateTime? @map("started_at")  @db.Timestamptz(3)
  finishedAt      DateTime? @map("finished_at") @db.Timestamptz(3)
  createdAt       DateTime  @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt       DateTime  @updatedAt      @map("updated_at") @db.Timestamptz(3)

  document Document    @relation(fields: [documentId, organizationId],
                                 references: [id, organizationId], onDelete: Cascade, onUpdate: NoAction)
  run      DocumentRun @relation(fields: [runId, organizationId],
                                 references: [id, organizationId], onDelete: Cascade, onUpdate: NoAction)
  events   JobEvent[]

  @@unique([organizationId, dedupeKey], map: "extraction_job_org_dedupe_key")  // f1, frozen
  @@unique([id, organizationId],        map: "extraction_job_id_org_key")      // f1 TEN-1 anchor
  @@index([status, priority, availableAt],            map: "extraction_job_claim_idx")
  @@index([leaseExpiresAt],                           map: "extraction_job_lease_until_idx")
  @@index([runId],                                    map: "extraction_job_run_idx")
  @@index([organizationId, documentId, createdAt],    map: "extraction_job_org_doc_created_idx")
  @@index([organizationId, status, createdAt],        map: "extraction_job_org_status_idx")
  @@map("extraction_jobs")
}

model JobEvent {
  seq            BigInt       @id @default(autoincrement())
  id             String       @unique(map: "job_event_id_key") @db.Uuid
  organizationId String       @map("organization_id") @db.Uuid
  jobId          String       @map("job_id") @db.Uuid
  kind           JobEventKind
  attempt        Int
  pageNo         Int?         @map("page_no")        // ADDED here: g omitted it; §9.2 needs it
  durationMs     Int?         @map("duration_ms")
  workerId       String?      @map("worker_id") @db.VarChar(120)
  detail         Json?        @db.JsonB              // allow-listed keys, <= 4096 BYTES
  at             DateTime     @default(now()) @db.Timestamptz(3)

  job ExtractionJob @relation(fields: [jobId, organizationId],
                              references: [id, organizationId], onDelete: Cascade, onUpdate: NoAction)

  @@index([jobId, at],           map: "job_event_job_at_idx")
  @@index([organizationId, at],  map: "job_event_org_at_idx")
  @@map("job_events")
}
```

`seq BigInt @id @default(autoincrement())` is kept as the physical key because a job timeline must
be totally ordered and a uuid v7 is only *approximately* so under concurrent inserts; `id` is a
uuid v7 for `f1` TEN-1/TEN-2 conformance. `g` §5.5's `detail String @db.VarChar(1000)` is
**superseded** by `detail Json` with an allow-list — a free-text column populated from a PDF parser's
exception message is the exact PII leak rule 5 of §12.1 exists to prevent.

### 17.2 Raw SQL Prisma cannot express

```sql
-- ---- CHECKs. Only immutable invariants; f2 TUNABLE_LIMITS_IN_SCHEMA forbids the rest. -------
ALTER TABLE extraction_jobs
  ADD CONSTRAINT extraction_job_attempts_nonneg  CHECK (attempts >= 0),
  ADD CONSTRAINT extraction_job_progress_range   CHECK (progress_pct BETWEEN 0 AND 100),
  ADD CONSTRAINT extraction_job_pages_nonneg     CHECK (pages_done >= 0 AND est_pages >= 1
                                                        AND (pages_total IS NULL OR pages_total >= 0)),
  -- a RUNNING row is fenced; a non-RUNNING row holds no lease. Both directions.
  ADD CONSTRAINT extraction_job_lease_consistent CHECK (
        (status =  'RUNNING' AND lease_token_hash IS NOT NULL AND lease_expires_at IS NOT NULL)
     OR (status <> 'RUNNING' AND lease_token_hash IS NULL     AND lease_expires_at IS NULL)),
  -- a deadline exists exactly when the job has been claimed at least once
  ADD CONSTRAINT extraction_job_deadline_after_start CHECK (
        (started_at IS NULL AND deadline_at IS NULL)
     OR (started_at IS NOT NULL AND deadline_at IS NOT NULL)),
  -- f1 job.dedupe_key_grammar, shape only
  ADD CONSTRAINT job_dedupe_key_shape CHECK (
        dedupe_key ~ '^[0-9a-f-]{36}:(DOCUMENT_EXTRACT|AI_EXTRACT):([0-9]+|\*)-([0-9]+|\*)$'),
  -- f1 storage.tenant_prefix_check, verbatim
  ADD CONSTRAINT job_result_ref_tenant_prefix CHECK (
        result_ref IS NULL OR result_ref LIKE 'org/' || organization_id::text || '/%');

-- NO CHECK REFERENCES abort_requested. See §6.3: a CHECK on that column throws inside the
-- set-based reaper and wedges reaping platform-wide. The invariant is enforced by the five
-- functions that leave RUNNING and asserted by the state-machine soak test (§19 T-3).
-- NO CHECK bounds result size, budget_ms, max_attempts or priority: all four are operator-tunable,
-- and f2 TUNABLE_LIMITS_IN_SCHEMA is explicit that a CHECK on a tunable turns a config change into
-- an ACCESS EXCLUSIVE lock plus a full scan and FAILS OUTRIGHT when lowering a limit.
-- Result size is enforced by ocr_finish_ok_v1's p_max_result_bytes parameter (§6.3).

ALTER TABLE job_events
  ADD CONSTRAINT job_event_attempt_nonneg CHECK (attempt >= 0),
  ADD CONSTRAINT job_event_page_positive  CHECK (page_no IS NULL OR page_no >= 1);

-- ---- Indexes Prisma cannot express: partial, and one DESC. --------------------------------
-- On f1 partial_index.policy's hand-authored allowlist; asserted at startup via pg_indexes.indexdef.
-- The Prisma partialIndexes preview flag is NOT enabled (prisma#29263 drops and recreates partial
-- indexes on every migration; a drop-and-recreate window on a unique index is a window in which
-- duplicates land).
CREATE INDEX extraction_job_claim_pending_idx
  ON extraction_jobs (priority ASC, available_at ASC)
  WHERE status = 'PENDING';
-- The one index the claim actually uses. At steady state most rows are SUCCEEDED, so a partial
-- index on PENDING is the size of the real backlog regardless of how many million rows exist:
-- claim cost is independent of history. This is the single indexing decision that determines
-- whether the queue still works at year two.

CREATE INDEX extraction_job_claim_by_org_idx
  ON extraction_jobs (organization_id, priority ASC, available_at ASC)
  WHERE status = 'PENDING';
-- Serves the claim's per-organisation cap subquery and the "escape hatch" NOT EXISTS.

CREATE INDEX extraction_job_running_org_idx
  ON extraction_jobs (organization_id)
  WHERE status = 'RUNNING';
-- Serves the in-flight count. Tiny by construction: at most MAX_CONCURRENT_JOBS_GLOBAL rows.

CREATE INDEX extraction_job_lease_expiry_idx
  ON extraction_jobs (lease_expires_at)
  WHERE status = 'RUNNING';

CREATE INDEX extraction_job_queue_ttl_idx
  ON extraction_jobs (queue_expires_at)
  WHERE status = 'PENDING';

CREATE INDEX extraction_job_dlq_idx
  ON extraction_jobs (finished_at DESC)
  WHERE status = 'DEAD';

CREATE INDEX job_event_content_failure_idx
  ON job_events (job_id, page_no)
  WHERE kind = 'PAGE_FAILED_CONTENT';

-- ---- ocr_results: the checkpoint read path (D-C2-14). -------------------------------------
CREATE INDEX ocr_result_run_page_idx ON ocr_results (run_id, document_page_id);
-- Query: SELECT document_page_id FROM ocr_results WHERE run_id = $1 -- the resume set.
-- f1 uniq.ocr_result leads with document_page_id, so it cannot serve a run-leading scan.

COMMENT ON COLUMN extraction_jobs.priority IS
  'RANK. Lower runs sooner. Bands in c2-queue-contract.md D-C2-5.';
COMMENT ON COLUMN extraction_jobs.lease_token_hash IS
  'sha256 of a 256-bit token minted inside ocr_claim_v1. The plaintext is returned once and never stored.';
COMMENT ON COLUMN extraction_jobs.pages_done IS
  'DISPLAY ONLY. Never a resume pointer. Resume reads ocr_results by run_id.';
```

### 17.3 Nine indexes, and what each is for

| Index | Query it serves | Why partial / ordered this way |
|---|---|---|
| `extraction_job_claim_pending_idx` | the claim's `ORDER BY priority, available_at` | forward scan, same direction on both columns (D-C2-5); partial on `PENDING` so cost is independent of history |
| `extraction_job_claim_by_org_idx` | the per-org cap subquery and the escape-hatch `NOT EXISTS` | without `organization_id` leading, skipping a dominant organisation's backlog is a scan of the whole `PENDING` index |
| `extraction_job_running_org_idx` | `count(*) WHERE status='RUNNING' AND organization_id=…` | bounded by `f2` `MAX_CONCURRENT_JOBS_GLOBAL` rows |
| `extraction_job_lease_expiry_idx` | reaper pass 1 and 3 | |
| `extraction_job_queue_ttl_idx` | reaper pass 4 | |
| `extraction_job_dlq_idx` | the DLQ view | |
| `extraction_job_org_status_idx` | per-tenant depth for backpressure and the ops dashboard | `g` §5.5, kept |
| `extraction_job_org_doc_created_idx` | the job timeline on a document detail page | `g` §5.5, kept |
| `job_event_content_failure_idx` | the §9.2 poison count | |

**`extraction_job_claim_idx (status, priority, availableAt)`** from `g` §5.5 is kept as the Prisma
declaration for tooling, but the **partial** index above is what the planner uses; the non-partial
one is redundant once the partial exists and is dropped in migration 0006 after an
`EXPLAIN (ANALYZE, BUFFERS)` on a seeded 50 000-row queue confirms it. That confirmation is
measurement M-C2-2 (§20).

### 17.4 Table maintenance — the part that decides whether this works at year two

A queue table is the worst case for MVCC: §12's write policy issues one progress update **per page**,
so a 50-page document creates 50 dead row versions of one row.

```sql
ALTER TABLE extraction_jobs SET (
  fillfactor                      = 70,   -- leave in-page room so progress updates stay HOT
  autovacuum_vacuum_scale_factor  = 0.02, -- 2 % instead of the 20 % default
  autovacuum_vacuum_threshold     = 50,
  autovacuum_analyze_scale_factor = 0.02,
  autovacuum_vacuum_cost_delay    = 2     -- vacuum this table aggressively; it is small
);
ALTER TABLE job_events SET (fillfactor = 95, autovacuum_vacuum_scale_factor = 0.05);
```

**Why `fillfactor = 70` specifically.** A HOT update — one that avoids touching any index — is
possible only when the new row version fits on the *same* page. Progress updates change
`pages_done`, `progress_pct`, `progress_stage` and `updated_at`, none of which is indexed, so they
are HOT-*eligible*; they become HOT-*actual* only if there is free space. 70 leaves room for roughly
two extra versions per row at our row width, and the page's HOT chain is pruned on the next access.
What is **not** HOT — the claim (writes `status`, indexed), `ocr_finish_err_v1` (writes `status` and
`available_at`, both indexed), the reaper — happens once or twice per job, not per page. **This is
the reason §6.2 keeps progress in its own function instead of folding it into a larger update.**
`job_events` is append-only, so it takes `fillfactor = 95`.

**Retention** is owned by `gate-2-pdpa-retention.md`; this document contributes two facts and one
mechanism:
- **Classification:** `extraction_jobs.payload` carries `originalFilename` and an object key, and
  `last_error_detail` can carry page geometry — both are personal data under Thailand's PDPA once
  the filename is a person's name, which in a Thai document pipeline it routinely is. They are
  derivatives under gate 2's retention and crypto-shredding regime, never an exception to it.
- **Organisation deletion is immediate and total**: `extraction_jobs` and `job_events` cascade from
  `documents` (`onDelete: Cascade` on the composite FK), so `deleteOrganization` leaves zero rows.
- **Mechanism:** every retention sweep runs in bounded batches —
  `DELETE … WHERE id IN (SELECT id … LIMIT 5000)` — so a sweep never holds a long transaction against
  the claim path.

---

## 18. Observability

### 18.1 Views

```sql
-- Every age is measured from created_at, never available_at. See §14.
CREATE VIEW extraction_queue_pressure AS
SELECT count(*) FILTER (WHERE status = 'PENDING')                                   AS pending,
       count(*) FILTER (WHERE status = 'RUNNING')                                   AS running,
       count(*) FILTER (WHERE status = 'PENDING' AND available_at > now())          AS backing_off,
       COALESCE(EXTRACT(epoch FROM now() - min(created_at))
                  FILTER (WHERE status = 'PENDING'), 0)::int                        AS oldest_pending_s,
       COALESCE(sum(COALESCE(pages_total, est_pages))
                  FILTER (WHERE status = 'PENDING'), 0)                             AS pending_pages
  FROM extraction_jobs;

CREATE VIEW extraction_queue_by_org AS
SELECT organization_id,
       count(*) FILTER (WHERE status = 'PENDING')                                   AS pending,
       count(*) FILTER (WHERE status = 'RUNNING')                                   AS running,
       count(*) FILTER (WHERE status = 'DEAD'
                          AND finished_at > now() - interval '24 hours')            AS dead_24h,
       COALESCE(max(EXTRACT(epoch FROM now() - created_at))
                  FILTER (WHERE status = 'PENDING'), 0)::int                        AS oldest_pending_s
  FROM extraction_jobs GROUP BY organization_id;

CREATE VIEW extraction_throughput_1h AS
SELECT date_trunc('minute', finished_at)                                  AS minute,
       count(*) FILTER (WHERE status = 'SUCCEEDED' AND NOT degraded)      AS ok,
       count(*) FILTER (WHERE status = 'SUCCEEDED' AND degraded)          AS degraded,
       count(*) FILTER (WHERE status IN ('FAILED','DEAD'))                AS bad,
       count(*) FILTER (WHERE status = 'CANCELLED')                       AS cancelled,
       sum(pages_done)                                                    AS pages,
       percentile_disc(0.95) WITHIN GROUP (
         ORDER BY EXTRACT(epoch FROM finished_at - started_at))::int      AS p95_s
  FROM extraction_jobs
 WHERE finished_at > now() - interval '1 hour'
 GROUP BY 1 ORDER BY 1 DESC;
```
`backing_off` exists because without it a retry storm and a capacity shortage look identical on the
dashboard.

### 18.2 Metrics the worker must emit

| Metric | Type | Labels | Why |
|---|---|---|---|
| `ocr_queue_pending` | gauge | `org_bucket` (`xs/s/m/l/xl`) | autoscaling. **Never a raw `organization` label** — unbounded cardinality in a multi-tenant product, and "top-N then other" is not stable because membership changes and orphans series. Per-org depth comes from `extraction_queue_by_org` on demand |
| `ocr_queue_oldest_pending_seconds` | gauge | — | **the primary SLO**: how long is anyone waiting |
| `ocr_jobs_claimed_total` | counter | `worker`, `kind` | throughput |
| `ocr_jobs_finished_total` | counter | `status`, `error_code`, `kind` | error budget |
| `ocr_job_duration_seconds` | histogram | `kind`, `engine_profile` | capacity planning **and** the per-document latency alert `h` never had |
| `ocr_page_duration_seconds` | histogram | `route`, `engine_id` | engine regression detection |
| `ocr_pages_checkpoint_skipped_total` | counter | — | measures how much R2 actually saves |
| `ocr_lease_lost_total` | counter | `worker` | **should be ~0.** Non-zero means heartbeat starvation or clock skew |
| `ocr_leases_reaped_total` | counter | `pass` | worker crash rate, per reaper pass |
| `ocr_pages_poisoned_total` | counter | `failure_code` | content-quality signal |
| `ocr_pages_skipped_total` | counter | `reason` (`time_budget_exhausted`, `ocr_page_budget_exhausted`, `poisoned`) | tells operations the provisional per-page constant is wrong |
| `ocr_duplicate_original_uploads_total` | counter | — | feeds D-C2-14's reopening trigger |
| `ocr_claim_latency_seconds` | histogram | — | the T1 substrate-reversal trigger |
| `ocr_reap_duration_seconds` | histogram | `pass` | guards the reaper from silently becoming expensive |
| `ocr_queue_pressure_query_seconds` | histogram | — | guards the admission query |
| `ocr_requeue_total` | counter | `trigger`, `outcome` (`created`/`conflict`) | how often 409 fires |
| `ocr_ai_*` | — | — | **owned by `f3`**, cited, not restated |

**Never label a metric with per-organisation cost.** Per-organisation spend is a billing query
against `ai_calls`; putting it in a Prometheus series is unbounded cardinality *and* commercially
sensitive data in a system with a weaker access model than the database.

### 18.3 Alerts — deferring to `n`, with three additions

`n-observability-testing-benchmark.md` is authoritative for alerting. This document contributes the
signals and three rules `n` does not yet have:

| Alert | Condition | Severity | Meaning |
|---|---|---|---|
| `OcrQueueWaitExceeded` | `increase(ocr_jobs_finished_total{error_code="QUEUE_WAIT_EXCEEDED"}[1h]) > 0` | **page** | we accepted work and never got to it. Unlike a slow job this is unambiguously *our* capacity failure, visible to the customer, and never self-correcting |
| `OcrBudgetExceededNoProgress` | `increase(ocr_jobs_finished_total{error_code="BUDGET_EXCEEDED_NO_PROGRESS"}[1h]) > 0` | **page** | a worker is wedged. This is what `h`'s ticket-level `OcrBudgetExceeded` was actually trying to catch; the *slow* case is now a degraded success and is a ticket, not a page |
| `OcrLeaseLost` | `increase(ocr_lease_lost_total[15m]) > 0` | ticket | heartbeat starvation or clock skew — investigate before it becomes double-processing |
| `OcrOrgStarved` | `max(extraction_queue_by_org.oldest_pending_s) > 600` while another organisation's `running > 0` | ticket | R4 has regressed |
| `OcrPagesSkippedSpike` | `increase(ocr_pages_skipped_total{reason="time_budget_exhausted"}[1h]) > 20` | ticket | the provisional per-page constant is wrong; this is measurement M-1's expiry trigger firing |

**Flagged back to `n`:** `OcrJobFailureRateHigh` counts `status =~ "FAILED|DEAD"`. User cancellations
are now `CANCELLED` and correctly excluded, but `QUEUE_WAIT_EXCEEDED` writes `FAILED`, so a capacity
incident will trip both it and `OcrQueueWaitExceeded`. `n` should either exclude
`error_code="QUEUE_WAIT_EXCEEDED"` from that ratio or explicitly accept the double-page.

---

## 19. The tests that make this real

| # | Test | Asserts |
|---|---|---|
| T-1 | **Crash recovery.** `docker kill -s KILL` a worker at page 47 of a 50-page OCR job | job returns to `PENDING` within **105 s**; second attempt redoes **≤ 1 page**; final state `SUCCEEDED`; `ocr_pages_checkpoint_skipped_total` increases by 46 |
| T-2 | **`pages_done` is not a resume pointer.** Corrupt `pages_done` to 0 before the retry | the retry still skips every page that has an `ocr_results` row for that `run_id` |
| T-3 | **State-machine soak.** Seed one row in every reachable `(status, abort_requested, lease_token_hash, deadline_at, started_at, attempts)` combination; call all nine functions against each | **no function raises.** This is the test that would have caught both the original reaper wedge and the panel's statement-4a defect |
| T-4 | **Fencing is a control.** As `ocr_queue`, attempt every write the honest protocol makes, but with a wrong/absent lease token, and every raw DML statement | `ocr_heartbeat_v1` returns 0 rows; `ocr_finish_ok_v1` returns false; `ocr_page_result_v1` returns false and writes nothing; `SELECT * FROM extraction_jobs`, `UPDATE extraction_jobs …`, `INSERT INTO job_events …`, `SELECT lease_token_hash …`, `SELECT response_uri FROM ai_calls`, `UPDATE ai_calls SET cost_micros=0` **all raise `permission denied`** |
| T-5 | **Blast radius.** As `ocr_worker`, `SELECT 1` from every table in the deny list of §4.1, generated from the Prisma DMMF so a new table is denied by default | every one raises `permission denied` |
| T-6 | **Cross-organisation claim still works under FORCE RLS.** Claim as `ocr_queue` with `app.current_org` unset | returns a job belonging to an organisation the session never named — and `f1`'s `it.each(TENANT_TABLES)` RLS suite passes with `extraction_jobs` and `job_events` included. **Both, or the reconciliation is not proven** |
| T-7 | **Requeue is collision-free.** `f1` D-F1-12's test, extended per §8: two requeues of a `FAILED` 60-page document, then a third while run 3 is `RUNNING` | 3 runs, 3 `ocr_results` rows per page with distinct `run_id`s, 1 `document_pages` row per page, 0 × 23505, and the third attempt returns `409 run_in_progress` with zero rows written |
| T-8 | **Fairness (outcome, not invariant).** 1 × 50-page job interleaved with 20 × 1-page jobs from other organisations | **every 1-page job starts within 60 s.** Explicitly *not* asserted: "in-flight per org never exceeds 2", which is false under `READ COMMITTED` (§6.1) |
| T-9 | **No lost jobs.** 10 000 enqueues under chaos (random worker kills, DB restarts, clock steps) | 10 000 terminal states, 0 stuck; the reachable state set equals exactly `{SUCCEEDED, FAILED, DEAD, CANCELLED}`; nothing sits in `RUNNING` with an expired lease longer than one reaper interval |
| T-10 | **Backlog does not terminally fail queued work.** Enqueue 5 000 jobs, drain slowly | 0 jobs fail with a budget code attributable to queue wait; `QUEUE_WAIT_EXCEEDED` fires only after `f2` `JOB_QUEUE_TTL_MS` |
| T-11 | **Budget breach degrades.** A document sized at 3 × its page allowance | completes `SUCCEEDED` with `degraded = true`, a page gap list, and **zero DLQ rows** |
| T-12 | **Idempotency.** Same `Idempotency-Key` + same body from two concurrent clients; then the same body with reordered JSON keys; then an NFD vs NFC Thai filename | one job; the reordered body replays rather than 422ing; NFD and NFC produce **one** dedupe key |
| T-13 | **Contract drift.** The five CI gates of D-C2-18 | a Zod change that is not regenerated fails the build; a fixture that passes one validator and fails the other fails the build; a `userFacing` code without a Thai `msgKey` fails the build |
| T-14 | **Thai round trip.** The fixture corpus of §12.1 T-1…T-7 | byte-identical Thai through Node → Postgres → Python → Postgres → Node |
| T-15 | **Cancellation.** Cancel a `RUNNING` 50-page job at page 20 | terminal `CANCELLED` within **60 s**; 20 pages downloadable; `abort_reason` preserved; `ocr_jobs_finished_total{status="FAILED"}` unchanged |
| T-16 | **Backoff is jittered.** 200 simultaneous lease expiries | the standard deviation of `available_at` is > 0 and the spread is within `[1 s, cap]`; no two rows share a millisecond |
| T-17 | **AI retry never re-runs OCR** (`f3` `ai.retry.never_reruns_ocr`'s regression test, wired here) | with `DOCUMENT_EXTRACT` `SUCCEEDED` and `AI_EXTRACT` failing all 3 attempts, `ocr_results` for that run is byte-identical before and after |
| T-18 | **Startup assertions.** Boot against a database restored without globals | boot **fails loudly** when a role is missing, when `extraction_jobs` lacks `FORCE ROW LEVEL SECURITY`, when it has fewer than 4 policies, when `ocr_queue` holds any table privilege, or when `DATABASE_URL_QUEUE = DATABASE_URL_WORKER` |

---

## 20. Open items

### 20.1 OWNER-BLOCKED

| Tag | Question | Default that ships if the owner stays silent |
|---|---|---|
| **OWNER-BLOCKED (B-C2-1)** | Who may requeue a document — the workspace, the organisation, or only INNOVERA staff? A requeue is a cost multiplier (it re-consumes page quota) and it invalidates a run a reviewer may already have approved. | **`WorkspaceRole.MANAGER` in the document's workspace, or `OrgRole.ADMIN`/`OWNER`.** `WorkspaceRole.REVIEWER` and `CONTRIBUTOR` may **not** (reading and approving must never imply re-spending — `f1` `authz.workspace_role_enum`'s own reasoning). `PlatformStaff` may requeue only through `f1` `admin.override.mechanism`, which writes an `AdminAccessLog` row. Every requeue writes `document_runs.trigger`, `triggered_by_membership_id` and `reason`, and consumes quota exactly like a first upload. |
| **OWNER-BLOCKED (B-C2-2)** | After a platform-wide incident, may operations bulk-requeue every `DEAD` document since time *T* in one action? | **Manual only, capped at `OCR_QUEUE_BULK_REQUEUE_MAX = 200` documents per call**, each in its own transaction, with a per-document result array and a mandatory `reason` of ≥ 20 characters (mirroring `f1` `admin.override.reason_min_chars`). **No automatic requeue on any condition** — an automatic requeue after an incident is how an incident becomes a second incident, and it spends customer quota without a human deciding to. |

### 20.2 Measurement-blocked (not owner-blocked): what M-1 and M-2 must produce

| # | Measurement | What it regenerates | Trigger that says it is wrong today |
|---|---|---|---|
| M-C2-1 | p95 per-page OCR wall time for a dense Thai A4 on the target host | `f2` `PROVISIONAL_PER_PAGE_OCR_S` and, through it, `MAX_OCR_PAGES_PER_DOCUMENT` and the page allowance | `ocr_pages_skipped_total{reason="time_budget_exhausted"}` > 20/h |
| M-C2-2 | Claim plan and latency against a seeded 50 000-row queue, `EXPLAIN (ANALYZE, BUFFERS)`, with and without `extraction_job_claim_idx` | whether the non-partial claim index is dropped in migration 0006 | p99 `ocr_claim_latency_seconds` > 0.25 s |
| M-C2-3 | `ocr_reap_v1()` duration with 5 000 `RUNNING` rows, all four passes | `REAP_INTERVAL_S` | p95 `ocr_reap_duration_seconds` > 1 s |
| M-C2-4 | Heartbeat responsiveness under a saturated `ProcessPoolExecutor`, 60-minute soak | `LEASE_TTL_S` / `HEARTBEAT_INTERVAL_S` | `ocr_lease_lost_total` > 0 |
| M-C2-5 | HOT-update ratio on `extraction_jobs` after 10 000 jobs (`pg_stat_user_tables.n_tup_hot_upd / n_tup_upd`) | `fillfactor` | ratio < 0.90 |

### 20.3 UNVERIFIED register

Every claim below is unverified in this session and is labelled where it is used.

- **UNVERIFIED:** that `FOR UPDATE OF j SKIP LOCKED` inside a CTE whose `WHERE` contains a correlated
  scalar subquery executes on PostgreSQL 17. It is legal by the documented rule (`FOR UPDATE` is
  forbidden with `GROUP BY`/`HAVING`/aggregates *at the same query level*; a scalar subquery is a
  separate level), but no PostgreSQL instance was contacted in this session. **Fallback if it does
  not:** materialise the in-flight counts into an `extraction_org_inflight` counter table maintained
  by an `AFTER UPDATE OF status` trigger *plus a 60-second reconciler that logs and corrects drift*
  — a trigger alone drifts on `TRUNCATE`, on bulk migrations and on any manual `UPDATE` in an
  incident, which trades a measured performance problem for an unmeasured correctness one. This is
  the first thing M1 tests.
- **UNVERIFIED:** that `sha256(bytea)` is available as a core function on the deployed PostgreSQL
  (it is documented from PostgreSQL 11; the deployment target is 17). `pgcrypto`'s `digest()` is the
  fallback and `pgcrypto` is required regardless for `gen_random_bytes`.
- **UNVERIFIED:** every wall-clock figure derived from `f2` `PROVISIONAL_PER_PAGE_OCR_S`, which `f2`
  itself labels UNVERIFIED and measurement-blocked at M-1. The M0 spread across dimensions was
  0.5–45 s/page — a 90× range.
- **UNVERIFIED:** anything about the LiteLLM gateway. Nothing in this document depends on a gateway
  fact: `f3` owns the AI worker entirely, and the queue's only AI-specific behaviour is a `kind`
  predicate in one `WHERE` clause.
- **UNVERIFIED:** that `LISTEN` is unavailable through PgBouncer in transaction-pooling mode in the
  deployed configuration. It is documented behaviour and the design does not depend on it — a
  dropped notification costs ≤ `POLL_INTERVAL_S`, never a lost job.
- **NOT CLAIMED:** that delivery is exactly-once. It is at-least-once; the *effects* are
  exactly-once (§10).

### 20.4 Deliberately deferred, each with a numeric trigger

| Deferred | Trigger that reopens it |
|---|---|
| Per-page fan-out with a fan-in barrier (`h` §8.3) | `MAX_CONCURRENT_JOBS_GLOBAL > 8` **and** measured single-document p95 above 15 min |
| The proportional fair-share cap (`h` §7.2a) | `MAX_CONCURRENT_JOBS_GLOBAL > 6` |
| A cross-document, same-organisation OCR cache (`h` L6/L7) | `ocr_duplicate_original_uploads_total / ocr_documents_created_total > 0.10` over 30 days |
| SSE for progress | > 500 concurrent watchers, or the poll query in the `pg_stat_statements` top 10 |
| An `extraction_org_inflight` counter table (`h` §7.4) | p99 `ocr_claim_latency_seconds` > 0.25 s at target load — and it ships **with** its reconciler or not at all |
| Redis as a queue substrate | none of `h` §5.3's T1–T5 is met, and the panel agreed with the rejection under all three lenses. **Not reopened here.** |

---

## 21. Challenges to frozen values

Both are naming collisions **between** frozen documents, not disagreements with a number. Both are
implemented as stated in this document; the orchestrator arbitrates.

| # | Frozen key | Objection | Proposed |
|---|---|---|---|
| **C-C2-1** | `f3` `ai.db.rls_policy` and `ai.claim.kind_predicate` name the table **`ocr_jobs`** | `f1` names the same table **`extraction_jobs`** in four frozen keys whose values are *executable identifiers*: `uniq.extraction_job_dedupe` → `extraction_job_org_dedupe_key`, `job.dedupe_key_grammar` (VARCHAR(200) on that table), `db.rls.children` (which enumerates `extraction_jobs` and `job_events`), and `storage.tenant_prefix_check` (`extraction_jobs.result_ref`). `f3` inherited `h`'s prose name, which `h` L22 had already conceded was an alias. A `CREATE POLICY` on a non-existent table is a migration error, so this cannot ship both ways. | Read `f3`'s two SQL fragments with `ocr_jobs` → `extraction_jobs`. No other change to `f3`. Implemented that way in §4.2 and §6.1. |
| **C-C2-2** | `f1` `db.rls.children` places `extraction_jobs` and `job_events` under **"TENANT-ONLY policies"** | Taken literally, a tenant-only policy set makes the cross-organisation claim return zero rows, which is the failure `h` §11.5 identified for `ocr_worker` and did not re-check for the `SECURITY DEFINER` owner. `f1` §5.1 *already* resolves it by giving `ocr_queue` a `USING (true)` policy on `extraction_jobs`, so this is a wording gap between a frozen key and the frozen prose that qualifies it, not a design disagreement. | Read `db.rls.children` as **"tenant-only *for `ocr_app` and `ocr_worker`*"**, with the two additional policies of §4.2 (`queue_definer_all_orgs` `TO ocr_owner`, required because `FORCE ROW LEVEL SECURITY` applies to the owner; `queue_claim_all_orgs` `TO ocr_queue`). |

**One deliberate narrowing, recorded for transparency rather than as a challenge.** `f1` §5.1
describes `ocr_queue` as holding *"`SELECT, UPDATE` on `extraction_jobs`"* and immediately adds
*"Owned by h-queue-and-worker-contract.md; restated here only as a grant constraint."* Ownership is
therefore delegated to this document, and §4.1 **narrows** the grant to `EXECUTE`-only on nine
functions and **zero** table privileges. The binding constraint `f1` actually imposes — *"no
privilege at all on `documents`, `document_pages`, `ocr_results`, `extraction_field_values`,
`corrections`"* — is honoured and strengthened. This closes the panel's finding that
`SELECT lease_token FROM extraction_jobs WHERE status='RUNNING'` returns a live capability for every
running job on the platform.

---

## 22. What this document supersedes, statement by statement

| Superseded | Where | What now holds |
|---|---|---|
| `ocr_jobs`, `ocr_job_events`, `OcrJobState`, `state`, `tenant_id` | `h` §6.2 and throughout | `extraction_jobs`, `job_events`, `JobStatus`, `status`, `organization_id` (D-C2-2, D-C2-3) |
| `priority DESC` and the §7.2b band table | `h` L16, §6.2, §6.3, §7.2 | `priority ASC` with the inverted band table (D-C2-5) |
| `ORDER BY priority ASC` **with** `extraction_job_claim_idx (status, priority, availableAt)` as the serving index | `g` §5.5 | direction kept; the serving index is the **partial** `extraction_job_claim_pending_idx (priority, available_at) WHERE status='PENDING'` (§17.2) |
| `leaseToken … @db.Uuid` (plaintext) and `GRANT SELECT (… lease_token …)` | `h` §6.2, §11.2 | `lease_token_hash bytea`; no `SELECT` path yields a token (D-C2-8) |
| `locked_at` / `locked_by` / `lease_until` as the fencing guard | `g` §5.5 (claim, heartbeat, completion, sweeper) | `lease_token_hash`; `locked_by`/`locked_at` survive as non-secret operator labels only |
| `GRANT SELECT, UPDATE (…) ON ocr_jobs TO ocr_worker` and the column list | `h` §11.2 | no DML for any worker on any queue table; nine `SECURITY DEFINER` functions (D-C2-6) |
| *"`ocr_worker` **is** G's `ocr_queue`. They are the same role under two names"* | `h` §11.5 | two roles, two blast radii; `USING (true)` is confined to the claim (D-C2-7) |
| `ocr_page_results` (model, unique key, `attempts`/`job_attempts`/`poisoned_at`, the 7-day POISON TTL, the cross-document cache) | `h` L6, L7, §8.1, §8.2 | deleted; the checkpoint is `ocr_results` under `f1` `uniq.ocr_result` (D-C2-14) |
| `dedupeKey = sha256(canonicalize({…}))` and `ocr_jobs_dedupe_live_idx` | `h` §10.2 | `f1` `job.dedupe_key_grammar` + `f1` `uniq.extraction_job_dedupe`; no partial-live index (§10) |
| `dedupeKey = "{documentId}:{kind}:{pageFrom}-{pageTo}:g{Document.requeueCount}"` | `g` §5.5 | same, with `runId` in place of the counter — `f1` `job.dedupe_key_grammar` |
| `maxAttempts` 4 (`h` L22) / 5 (`h` review note) / 6 for infrastructure (`h` §9.6) | `h` §0, §1.5, §9.6 | 5 on the row; class ceilings 1/1/3/5, AI frozen at 3 by `f3` (D-C2-9) |
| `requestHash = sha256(JSON.stringify(payload))` | `h` §10.1 draft, jawbong `prisma-idempotency-repository.ts` | RFC 8785 canonicalisation over an NFC-normalised body, plus an `IN_FLIGHT` reservation (D-C2-15) |
| `calculateBackoffMs` duplicated in SQL and TypeScript, with a test asserting they agree | `g` §5.5 | one implementation, in SQL, with full jitter (D-C2-10). The agreement test is deleted |
| `BUDGET_EXCEEDED`, `retryable: false`, terminal `FAILED` at page ~108 | `h` §9.6, §13.2 | `TIME_BUDGET_PARTIAL` → `SUCCEEDED` + `degraded`; `BUDGET_EXCEEDED_NO_PROGRESS` for a wedged worker (D-C2-11, per frozen `f2` D-F2-6) |
| `budgetMs = clamp(60_000 + pages·perPage + (aiEnabled ? 300_000 : 0), 5 min, 45 min)` | `h` §13.2 | `f2` `JOB_PROCESSING_BUDGET_MS`, per claim; the AI term is deleted per `f3` §5 |
| `CHECK (NOT (abort_requested AND state IN ('SUCCEEDED','DEAD')))` | `h` §6.2 | no CHECK references `abort_requested`; the invariant is enforced by five functions and asserted by T-3 (§6.3) |
| statement 4a not clearing `abort_requested` | `h` §6.3 | `ocr_finish_ok_v1` clears it — the panel's defect (2), fixed (§6.3) |
| L15's one-`UPDATE` requeue of a `DEAD` row | `h` §0, §15.1 | a new `DocumentRun`; terminal job rows are never edited (D-C2-13) |
| `ocr_dlq` as `WHERE state = 'DEAD'` | `h` §15.1 | `extraction_job_dlq` includes operator-actionable `FAILED` codes (D-C2-12) |
| `pg_notify('ocr_jobs_v1', {jobId, tenantId, priority})`; per-job abort channels; `LISTEN ocr_abort_v1` + `json.loads(payload)["jobId"]` | `h` §6.4 (both variants), §12.3 | one channel `ocr_wake_v1`, empty payload, no abort channel (D-C2-21) |
| the `AFTER UPDATE OF state ON ocr_jobs` outbox trigger | `h` §11.2.1 / L27 | `ocr_settle_run_v1`, one event per **run**, called by the four terminal paths (D-C2-22) |
| `lastError String @db.VarChar(1000)` | `g` §5.5, `JobEvent.detail String @db.VarChar(1000)` | `last_error_code` (closed enum) + `last_error_detail Json` (allow-listed); `detail Json`, ≤ 4 096 bytes |
| `min(available_at)` as `oldest_pending_s`; `payload->>'maxRenderPages'` as `pending_pages` | `h` §14.2, §15.1 | `min(created_at)`; `COALESCE(pages_total, est_pages)` (§14, §18.1) |
| `maxPendingJobs 200 / maxPendingPages 5000 / maxInflightJobs / maxDocumentPages 2000 / maxDocumentBytes 1 GiB` | `h` §14.1 | every one is `f2`'s, cited; this document owns only the enforcement point (§14) |
| `replicas: 4, mem_limit: 3g, cpus: "2.0", OCR_WORKER_CONCURRENCY: 1` | `h` §14.3 | `f2` `MAX_CONCURRENT_JOBS_GLOBAL`, `WORKER_JOB_CONCURRENCY`, `RENDER_CONCURRENCY`, `WORKER_MEMORY_LIMIT_BYTES` — cited, never restated |
| `ai_extract 180 s` in the worker stage table; `AiCallLog`; the Redis breaker | `h` §13.1, `k` §2.7 | already superseded by `f3` §5; restated here only so the queue's stage table does not reintroduce them |
| SSE as the M1 progress transport | `h` §9.5 draft | adaptive polling per `l` L-8 (D-C2-19) |
| `POST /v1/extract` as anything other than a flag-gated test harness | `h` L20, §11.4 | unchanged and endorsed: read at import time, never constructed when the flag is unset, bound to loopback, and a CI grep asserts the flag appears in no production compose file |

---

## CANONICAL VALUES

Every value this document **owns**. Any other document that needs one of these must cite
`c2-queue-contract.md` and the key — never restate it. Values owned by `f1`, `f2`, `f3` or
`gate-2-pdpa-retention.md` are deliberately **absent** from this table.

| key | value | env var | reason | failure behaviour |
|---|---|---|---|---|
| `queue.table` | `extraction_jobs` (Prisma `ExtractionJob`) | n/a | `f1`'s frozen constraint identifiers all use `g`'s name; an index name is executable, a section heading is not | a `CREATE POLICY`/`ALTER TABLE` on the wrong name fails the migration loudly |
| `queue.events_table` | `job_events` (Prisma `JobEvent`), with `page_no Int?` added | n/a | `f1` `db.rls.children` enumerates it; `page_no` is what §9.2's poison count reads | missing column ⇒ poison detection silently always returns 0, and a bad page is retried forever within the job |
| `queue.status_enum` | `enum JobStatus { PENDING RUNNING SUCCEEDED FAILED DEAD CANCELLED }`, column `status` | n/a | four terminal states with distinct operator meanings; `SUCCEEDED` is the only success state and partial completion is `degraded = true` | a fifth value added later is `ALTER TYPE … ADD VALUE`; removing one is a table rewrite |
| `queue.kind_enum` | `enum JobKind { DOCUMENT_EXTRACT AI_EXTRACT }` | n/a | the minimum that satisfies `f3` `ai.retry.never_reruns_ocr`; a per-stage split buys nothing at `f2` `MAX_CONCURRENT_JOBS_GLOBAL` | an unknown kind in `p_kinds` makes the claim return zero rows — the queue looks empty |
| `queue.priority_direction` | **`priority ASC` — lower runs sooner.** `ORDER BY priority ASC, available_at ASC` | n/a | a same-direction composite btree is a forward scan; a mixed-direction index degrades to a sort if written wrong, which produces correct results at the wrong latency | inverted direction ⇒ backfills pre-empt interactive uploads and no test that does not measure ordering fails |
| `queue.priority_bands` | interactive-single **10**, interactive-multi **20**, operator-requeue **40**, API **100**, batch **300**, backfill **800**; decay `+min(400, floor(pending/5)*5)` capped at 900; ageing `-5` per 300 s from `created_at`, floor **30** | `OCR_LIMIT_QUEUE_PRIORITY_*` | floor 30 keeps *"a human waiting always beats a machine waiting"* while guaranteeing monotonic progress; worst-case starvation 12.8 h, which belongs in the SLO | ageing measured from `available_at` instead of `created_at` skips exactly the jobs that waited longest |
| `queue.lease_token` | `lease_token_hash bytea` = `sha256(convert_to(token,'UTF8'))` of a 256-bit `gen_random_bytes(32)` token minted **inside `ocr_claim_v1`** and returned exactly once | n/a | a readable token column is a live capability for every running job on the platform | plaintext storage ⇒ fencing is a convention, not a control |
| `queue.lease_ttl_s` | **90** | `OCR_QUEUE_LEASE_TTL_S` | 6× the heartbeat; crash detection ≤ `LEASE_TTL_S + REAP_INTERVAL_S` = 105 s | too low ⇒ a live worker's job is reaped and double-processed (safe but wasteful); too high ⇒ slow crash detection |
| `queue.heartbeat_interval_s` | **15** | `OCR_QUEUE_HEARTBEAT_INTERVAL_S` | also the cancellation-detection interval, since there is no abort channel | starved heartbeat ⇒ `ocr_lease_lost_total` > 0 and the reaper requeues live work |
| `queue.reap_interval_s` | **15** | `OCR_QUEUE_REAP_INTERVAL_S` | every worker runs `ocr_reap_v1()` on this period | longer ⇒ crash detection window grows linearly |
| `queue.poll_interval_s` | **2** | `OCR_QUEUE_POLL_INTERVAL_S` | the correctness floor; `NOTIFY` only shortens latency | a dropped notification costs ≤ 2 s, never a lost job |
| `queue.reap_grace_s` | **120** | `OCR_QUEUE_REAP_GRACE_S` | `assemble` + result upload must fit inside it before reaper pass 3 fires | too low ⇒ a worker finalising a partial success is killed and its work is thrown away |
| `queue.function_set` | `ocr_claim_v1`, `ocr_heartbeat_v1`, `ocr_progress_v1`, `ocr_event_v1`, `ocr_finish_ok_v1`, `ocr_finish_err_v1`, `ocr_finish_cancelled_v1`, `ocr_page_result_v1`, `ocr_reap_v1`, plus `ocr_settle_run_v1`; all `SECURITY DEFINER`, owned by `ocr_owner`, `SET search_path = public`, `REVOKE EXECUTE FROM PUBLIC` | n/a | column-level `GRANT UPDATE` constrains columns, never the `WHERE` clause | a worker with raw DML can forge a terminal state for any organisation and a database-signed outbox event with it |
| `queue.worker_dml` | **none.** `ocr_queue` holds `EXECUTE` on the nine protocol functions and **zero** table privileges; `ocr_worker` holds DML on `document_pages`, `ocr_results`, `document_analyses`, `storage_objects` only, under `app.current_org` | `DATABASE_URL_QUEUE`, `DATABASE_URL_WORKER` (both `f1`-frozen names) | restores `g`'s two blast radii; `USING (true)` is confined to the claim | equal DSNs, or any table grant to `ocr_queue`, must fail the startup assertion |
| `queue.definer_rls_policy` | `queue_definer_all_orgs ON extraction_jobs, job_events FOR ALL TO ocr_owner USING (true) WITH CHECK (true)` | n/a | `FORCE ROW LEVEL SECURITY` applies to the table owner, so without it every `SECURITY DEFINER` claim returns zero rows | the queue appears permanently empty while every other test passes |
| `queue.max_attempts` | **5** on the row (app-owned ceiling), effective budget `LEAST(max_attempts, class_budget)`; class budgets content **1**, contract **1**, engine **3**, infrastructure **5** (`AI_EXTRACT` is `f3` `ai.job.max_attempts`) | `OCR_QUEUE_MAX_ATTEMPTS`; class map in `contracts/error-codes.json` | 5 × `f2` `JOB_PROCESSING_BUDGET_MS` = 2.5 h, the top of the envelope `f2` D-F2-6 priced | a worker able to raise it turns a job into an unbounded billing and capacity attack |
| `queue.backoff` | `available_at = now() + (1 + random() × (LEAST(300, 2^LEAST(attempts,9)) − 1))` seconds — full jitter, 1 s floor, 300 s cap, expressed **only in SQL** | `OCR_QUEUE_BACKOFF_BASE_S=1`, `OCR_QUEUE_BACKOFF_CAP_S=300` | deterministic backoff makes a node death a thundering herd on the claim index | a 0 s floor lets the same worker re-claim the row it just failed |
| `queue.dlq` | view `extraction_job_dlq` = `status='DEAD'` **OR** (`status='FAILED'` AND `last_error_code IN (BUDGET_EXCEEDED_NO_PROGRESS, QUEUE_WAIT_EXCEEDED, STORAGE_UNAVAILABLE, PAYLOAD_SCHEMA_INVALID, PAYLOAD_VERSION_UNKNOWN, DB_UNAVAILABLE)`) | n/a | DLQ membership is a property of the error code, not of the state; customer-caused failures must never fill an operator worklist | a `DEAD`-only DLQ leaves budget/capacity failures with **no** operator lever |
| `queue.requeue_mechanism` | one transaction: (0) refuse if a `RUNNING` run exists → **409**; (1) `SELECT 1 FROM documents … FOR NO KEY UPDATE`; (2) `INSERT document_runs … coalesce(max(run_seq),0)+1`; (3) `INSERT extraction_jobs … ON CONFLICT (organization_id, dedupe_key) DO NOTHING` with the key derived from the **new** `run_id`; (4) outbox event. **A terminal job row is never edited.** | n/a | the new `run_id` makes all five frozen unique keys collision-free simultaneously (§8's table) | editing the `DEAD` row instead reuses the old dedupe key, so a second requeue silently collides and rewrites terminal evidence |
| `queue.requeue_conflict` | `409 { code: "run_in_progress", runSeq, retryAfterSeconds: 30 }`; `?cancelRunning=true` performs the cancel and returns `202 cancel_in_progress`, never the requeue | `OCR_QUEUE_REQUEUE_CONFLICT_RETRY_AFTER_S=30` | starting a new run while the old one drains lets the old render step upsert `document_pages` with the previous `render_dpi` — a page-level data race no unique constraint catches | a wedge instead of a refusal, which is `f1` D-F1-12's stated failure mode |
| `queue.bulk_requeue_max` | **200** documents per call, each in its own transaction, `reason` ≥ 20 chars | `OCR_QUEUE_BULK_REQUEUE_MAX` | one 409 must not roll back 199 successes | unbounded bulk requeue turns an incident into a second incident and spends customer quota |
| `queue.checkpoint` | **`ocr_results`**, read as `SELECT document_page_id FROM ocr_results WHERE run_id = $1`. **`ocr_page_results` does not exist.** | n/a | `f1` `uniq.ocr_result` is already frozen with crash-retry idempotency as its stated purpose; a second checkpoint table is contradiction 6 one level down | resuming from `pages_done` instead redoes or skips arbitrary pages |
| `queue.checkpoint_index` | `CREATE INDEX ocr_result_run_page_idx ON ocr_results (run_id, document_page_id);` | n/a | `f1` `uniq.ocr_result` leads with `document_page_id` and cannot serve a run-leading scan | without it the resume set is a sequential scan of all evidence for the organisation |
| `queue.page_poison` | `MAX_PAGE_ATTEMPTS = 2` content-class failures per `(job_id, page_no)`, counted from `job_events` where `kind='PAGE_FAILED_CONTENT'`; a third marks the page `SKIPPED` and the loop continues | `OCR_QUEUE_MAX_PAGE_ATTEMPTS` | scoped to `job_id`, so a requeue is a clean slate by construction — no `POISON` TTL is needed | counting transient failures poisons a page after two infrastructure blips, converting a retryable error into a permanent content verdict |
| `queue.progress_write_policy` | columns **every page**; `job_events` on every stage transition, every failure, every poison verdict and **every 10th page** | n/a | the UI reads columns, the audit reads events; conflating them is what makes a queue table unmaintainable | an event per page is ~50× the audit write volume and destroys the HOT-update ratio |
| `queue.event_detail_cap` | **4 096 bytes** (`pg_column_size`), enforced inside `ocr_event_v1` | `OCR_QUEUE_EVENT_DETAIL_MAX_BYTES` | bytes not characters: a Thai `detail` holds ~1 300 characters, not 4 096 | an uncapped worker-controlled JSONB on an append-only table is a storage-exhaustion vector with no quota |
| `queue.result_cap_bytes` | **65 536**, checked on **both** `pg_column_size(result)` and `length(result::text)` inside `ocr_finish_ok_v1`, **never as a CHECK constraint** | `OCR_QUEUE_MAX_RESULT_BYTES` | `pg_column_size` on a TOASTed jsonb reports the *compressed* size, so a repetitive result squeezes past a storage-only bound; and `f2` `TUNABLE_LIMITS_IN_SCHEMA` forbids a CHECK on a tunable | a CHECK here turns a config change into an ACCESS EXCLUSIVE lock plus a full scan and fails outright when lowered |
| `queue.abort_check_constraint` | **none.** No CHECK in this schema references `abort_requested` | n/a | a CHECK on that column throws inside the set-based reaper and wedges reaping platform-wide; the invariant is enforced by the five functions that leave `RUNNING` and asserted by test T-3 | one violating row aborts the whole reaper statement and every crashed job on the platform stops being reaped |
| `queue.cancel_latency_s` | **≤ 60** = `heartbeat_interval_s` (15) + `f2` `PAGE_OCR_TIMEOUT_S` (45) | n/a | there is no abort channel; the heartbeat is the only cancel path and the only guarantee | a promised ≤ 20 s that the transport cannot deliver, which is what `h` §12.1 claimed |
| `queue.cancel_ai_rule` | an in-flight billed gateway call **always** runs to completion and its response is persisted before the job stops | n/a | LiteLLM performs its own upstream retries, so aborting our client does not necessarily stop or unbill work already in flight | discarding a paid response converts a cancellation into pure waste |
| `queue.abort_reason_enum` | closed set: `user_request \| admin_request \| quota_exceeded \| requeue_requested \| org_deleted` | n/a | it is rendered to a user through a `msgKey`; free text cannot be translated and cannot be trusted | server-built prose in a Thai product produces English at the moment a user is already frustrated |
| `queue.notify_channel` | **`ocr_wake_v1`**, empty payload, `AFTER INSERT … WHEN (NEW.status='PENDING')`. **No abort channel exists.** | `OCR_QUEUE_NOTIFY_CHANNEL` | *"Notifications are visible to all users"* — there is no `GRANT` for a channel, so any identifier in a payload is a cross-tenant metadata side channel | a dropped notification costs ≤ `poll_interval_s`; it is an optimisation, never a correctness dependency |
| `queue.payload_schema` | `ExtractionJobPayloadV1` — Zod 4.4.3 source of truth in `contracts/src/extraction-job-payload.v1.ts`; `schemaVersion` a literal; `extra="forbid"` on the Pydantic consumer; **result-affecting config snapshotted, operational config read live** | n/a | a stale budget in a payload survives up to `f2` `JOB_QUEUE_TTL_MS`; a live `renderDpi` mid-run splits one run's evidence across two DPIs | an unknown `schemaVersion` is `PAYLOAD_VERSION_UNKNOWN`, `maxAttempts` 1, and pages an operator |
| `queue.contract_gates` | five CI gates: emit-and-diff; Python validates fixtures against the **input** schema **and** Pydantic; TypeScript the same; i18n (`userFacing` ⇒ `msgKey` in both `th.json` and `en.json`); code-table shape | n/a | R14 is a CI property or it is nothing | a schema change that is not regenerated ships a producer and a consumer that disagree |
| `queue.deploy_order` | `ocr-migrate` → `ocr-worker` → `ocr-ai-worker` → `ocr-web`. Rollback requires `SELECT count(*) FROM extraction_jobs WHERE status='PENDING' AND schema_version > $target` to be **0** | n/a | a new consumer accepts every version it ever accepted; the reverse order does not | producer-first ⇒ the running worker rejects every new payload with a terminal contract error |
| `queue.enqueue_idempotency` | `idempotency_records` (jawbong table, copied verbatim), `scope = "ocr.document.submit"`, `requestHash = sha256(RFC8785-canonicalize(nfcDeep(body)))`, reserve with `response_code = NULL` **first**, TTL 24 h; concurrent second request ⇒ `409` + `Retry-After: 1`; different hash ⇒ `422` | `OCR_QUEUE_IDEMPOTENCY_TTL_S=86400`, `OCR_QUEUE_IDEMPOTENCY_SCOPE` | `JSON.stringify` preserves key insertion order, so the same request from two clients hashes differently and replays as a spurious 422 — user-visible and nondeterministic. NFC-first is required because macOS Safari sends NFD filenames and Windows/Android send NFC | without the `IN_FLIGHT` reservation two concurrent requests both find no record and both create a job and an invoice |
| `queue.job_addressability` | jobs are **not** externally addressable; there is no `public_id` on `extraction_jobs`. Public surface is `GET /v1/documents/{public_id}` and `/runs/{run_seq}` | n/a | satisfies `f1` VIS-1 vacuously, which is stronger than satisfying it with a second enumerable identifier | a job id on the wire needs its own 404 rule, timing floor and rate limit for no product gain |
| `queue.duplicate_upload` | same bytes + same organisation ⇒ **one `storage_objects` row, N `Document` rows**, each with its own `public_id`, owner, workspace and visibility; the response names no other document. **No OCR reuse across documents in M1.** Cross-organisation: nothing is shared, ever | n/a | returning an existing document is an authorization decision disguised as an optimisation and collides with `f1` `api.not_found_rule`; cross-tenant sharing is foreclosed by `f1` `uniq.storage_original_fingerprint` being `(organization_id, content_fingerprint)` | a `duplicate_of` field leaks existence or ownership; cross-tenant dedup is a timing/existence oracle |
| `queue.run_settlement` | `ocr_settle_run_v1`, called by the four terminal paths and by the reaper. Outcome precedence **`FAILED` > `CANCELLED` > `SUCCEEDED`**, set only when zero jobs of the run remain `PENDING`/`RUNNING`; emits **one** outbox event per run (`document.run.succeeded` / `.failed` / `.cancelled`) in the worker's own commit | n/a | one event per run is the unit consumers want; a per-job trigger emits two events for one document and must be deduplicated by every subscriber | a Node-side reconciler is a second at-least-once boundary and the "stuck at 100 %" incident class |
| `queue.documents_write` | **the queue never writes `documents`.** `documents.status` is a projection owned by whoever settles `f1` §11.2's unresolved `DocumentStatus` vocabulary | n/a | keeps an open contradiction outside the queue's blast radius; `ocr_queue` and `ocr_worker` hold no grant on `documents` | a queue that writes `documents.status` forces the enum question to be answered by the wrong dimension |
| `queue.est_pages` | `est_pages Int @default(1)`, written at enqueue: PDF page count from the upload check, 1 for images, **10** for unknown | `OCR_QUEUE_EST_PAGES_UNKNOWN=10` | `pages_total` is NULL until the worker opens the document, and a policy *ceiling* read from the payload made 100 one-page receipts report 200 000 pending pages | backpressure sheds real traffic against imaginary work |
| `queue.pressure_thresholds` | Elevated at `pending ≥ 500` **or** `oldest_pending_s > 600`; Critical at `pending ≥ 2000` **or** `oldest_pending_s > 1800`; shed **batch first, then API, never interactive**; `oldest_pending_s` from `created_at` | `OCR_QUEUE_PRESSURE_ELEVATED_PENDING=500`, `OCR_QUEUE_PRESSURE_CRITICAL_PENDING=2000` | scaled to `f2` `MAX_CONCURRENT_JOBS_GLOBAL = 4`; `h`'s 2 000/5 000 were sized for a cluster 10× larger and would never engage | measuring age from `available_at` makes a retry storm read healthy and backpressure never engages |
| `queue.claim_sql_shape` | correlated scalar subquery for the per-organisation count plus a `NOT EXISTS` escape hatch; **no aggregating CTE is joined at the locked query level** | n/a | `FOR UPDATE` is forbidden only with `GROUP BY`/`HAVING`/aggregates *at the same query level*, so this form is unconditionally legal — it closes `h`'s blocking question Q1 by construction | an aggregate CTE join risks a planner refusal that only appears against a real PostgreSQL |
| `queue.inflight_cap_semantics` | **statistical, not an invariant.** Under `READ COMMITTED` transient overshoot is bounded by the number of simultaneously-claiming workers. Tests assert the outcome ("every 1-page job starts within 60 s"), never the invariant | n/a | `SKIP LOCKED` prevents double-claiming a row; it does not serialise an aggregate computed over other rows | asserting the invariant produces a flaky test that will be "fixed" by weakening the cap |
| `queue.table_storage` | `extraction_jobs`: `fillfactor=70`, `autovacuum_vacuum_scale_factor=0.02`, `autovacuum_vacuum_threshold=50`, `autovacuum_analyze_scale_factor=0.02`, `autovacuum_vacuum_cost_delay=2`. `job_events`: `fillfactor=95`, scale factor `0.05` | n/a | one progress update per page creates one dead row version per page; HOT updates need in-page free space, and none of the progress columns is indexed | at the default 20 % scale factor the queue table bloats until the claim's partial index no longer fits in cache |
| `queue.retention_classification` | `extraction_jobs.payload` and `last_error_detail` are **personal data** (they carry `original_filename` and object keys) and are derivatives under `gate-2-pdpa-retention.md`. Deletes run in batches of **5 000**. Organisation deletion cascades from `documents` to zero rows | n/a | in a Thai document pipeline a filename routinely *is* a person's name | an unbatched retention sweep holds a long transaction against the claim path |

---

*End of `c2-queue-contract.md`. Values owned here are listed above; everything else is cited.*
