---
dimension: h-queue-and-worker-contract
title: Async job architecture + Node/Python contract (item L)
m0_items: L, I (part)
status: reviewed
date: 2026-09-09
reviewed: 2026-09-09
review: adversarial completeness pass — see §19 Critic Notes
---

# H — Async job architecture and the Node ↔ Python contract

> **Integration status (2026-09-12):** Read the [architecture index](../README.md) and its consolidation report before using these examples. Individual review labels do not close cross-document conflicts; no application implementation is verified.

> **REVISION NOTICE (2026-09-09, adversarial review).** The draft's substrate decision (PostgreSQL,
> not Redis) **survives review unchanged and with stronger evidence.** Everything else took damage.
> Nine defects were found that would have shipped as bugs, and five cross-document contradictions
> were found that would have made the M1 schema un-buildable. In summary:
>
> 1. **A schema-level deadlock (§6.2/§6.3).** The `ocr_jobs_no_abort_before_run` CHECK constraint
>    makes the reaper statement *throw* on any aborted job that loses its lease — and because the
>    reaper is one set-based `UPDATE`, one such row wedges reaping for **every** job on the platform.
>    Fixed in §6.2 and §6.3.
> 2. **The job queue was designed twice.** Dimension G (`g-data-model.md`) independently specifies
>    `ExtractionJob` / `extraction_jobs` + `JobEvent` — the same table, with `organization_id`
>    (not `tenant_id`), a timestamp lease (not a fencing token), `maxAttempts` 5 (not 4), and
>    **`priority ASC` (lower runs sooner), the exact inverse of this document's `priority DESC`.**
>    The draft reconciled with A, B, D, E and F and never opened G. New §1.6.
> 3. **RLS was invisible to the draft.** G mandates `FORCE ROW LEVEL SECURITY` with a
>    `current_setting('app.current_org')` policy and a **third role, `ocr_queue`**, precisely because
>    the claim spans tenants. §11's three-role model did not exist in the same universe. New §11.5.
> 4. **The storage prefixes in §9.2/§11.3 contradict dimension I.** I's key layout is
>    `{tenantId}/{yyyy}/{mm}/{shard}/{documentId}/…` — **tenant-first**. A credential scoped to a
>    top-level `orig/` / `deriv/` / `result/` prefix, which is the whole of decision L9's security
>    story, cannot exist under that layout. New §11.3.
> 5. **Dimension B is no longer "unknown" and this document's §16 was stale.** B is now
>    `status: reviewed` and **resolves the vision question to TEXT-ONLY** from INNOVERA's own
>    production source, and resolves the gateway's *contract* (`LITELLM_BASE_URL`,
>    `LITELLM_API_KEY`, `Authorization: Bearer`, alias `innovera-ai`, 65 536-token ceiling,
>    internal Docker network). What remains unresolved is narrow. §16 rewritten; §17 rewritten.
> 6. **`dedupeKey` as specified could never collide** — it hashed a payload containing a fresh
>    `jobId`, `correlationId` and `deadlineAt`, so layer-2 dedupe was a no-op. §10.2 rewritten with
>    a canonical, deterministic, NFC-normalised key.
> 7. **The global budget started at enqueue**, so a queue backlog longer than the budget would
>    mass-fail jobs with a *non-retryable* `BUDGET_EXCEEDED`. §13.2 rewritten.
> 8. **`oldest_pending_s` was computed from `available_at`**, which retries push into the future —
>    so the primary SLO metric hid exactly the starvation it existed to detect. §14.2/§15.1 fixed.
> 9. **Page attempts were permanent**, keyed on `(tenant, sha, recipe, engine)` with no job scope,
>    so two transient storage blips poisoned a page *forever* for that document. §8.1 fixed.
>
> Corrections to fact: the Python BullMQ client is **3.2.1**, not 2.24.0, and it now has
> FlowProducer, per-job cancellation and global rate limiting (§4.2, §18.3). Every other version in
> §18.3 was re-verified against its registry and held.
>
> New material: §1.6 (cross-dimension reconciliation), §6.6 (table maintenance), §9.8 (Thai text in
> the contract), §11.5 (RLS), §12.4 (the abort completion statement), §19 (Critic Notes).

**Scope.** Everything between "a Next.js request handler has decided a document must be processed"
and "a Python worker has durably recorded the outcome". Specifically: the queue substrate, the
claim/lease protocol, retry and dead-lettering, per-tenant fairness, page-level checkpointing,
the versioned job/result/progress schemas, database ownership and credentials, cancellation, and
timeout budgets.

**Out of scope (owned elsewhere):** which OCR engine runs (dimension D), how a page is routed
native-vs-OCR (dimension E), what preprocessing runs (dimension F), the AI gateway address
(dimension B/C), object-storage backend selection, auth, and UI.

**Method.** Every claim about jawbong or krs-pos comes from a file I opened in this session; the
path is cited. Every library version comes from a registry JSON or a docs page I fetched; the URL
is cited. Nothing was installed, started, or connected to. Anything I could not verify is marked
inline as **UNVERIFIED**.

---

## 0. Decision summary

| # | Decision | Chosen | Rejected | Reversibility | Confidence |
|---|---|---|---|---|---|
| L1 | Queue substrate | **PostgreSQL** — the same database as the app, `SELECT … FOR UPDATE SKIP LOCKED` inside one atomic `UPDATE … RETURNING`, plus `LISTEN/NOTIFY` for wake-up and abort | Redis+BullMQ; Redis+Celery/arq/dramatiq; worker-owned internal HTTP queue | moderate | high |
| L2 | Queue implementation | **Hand-rolled `ocr_jobs` table**, owned by Prisma, claimed by Python via psycopg 3.3.5 | procrastinate 3.9.0; pg-boss 12.30.0; graphile-worker 0.18.0; BullMQ 6.3.4 Postgres backend | moderate | medium-high |
| L3 | Reuse of `outbox_events` as the job queue | **No.** Copy it verbatim for domain events only. Confirms dimension A's decision A-6 | reusing `outbox_events`; extending it with 6 columns | easy | high |
| L4 | Lease/fencing | **Random UUID `lease_token`**, 120 s lease, heartbeat every 30 s, *every* worker write guarded by `WHERE lease_token = $token` | timestamp-as-token (dimension A's `WHERE lockedAt = $2`); fixed 10-minute stale window (krs-pos) | easy | high |
| L5 | Job granularity in M1 | **One job per document**, internal page loop, per-page checkpoint rows | per-page fan-out with a fan-in barrier | moderate | medium |
| L6 | Page checkpointing | **Content-addressed `ocr_page_results`**, unique on `(tenant, sha256, page, pipelineVersion, recipeHash, engineId, engineVersion)`, written per page in its own transaction | in-memory only; checkpoint per document; a resumable file on local disk | moderate | high |
| L7 | Page cache scope | **Per tenant.** Cross-tenant dedupe on identical sha256 is a timing/existence side channel and is deferred to a dedicated threat review | global content-addressed cache | easy now, hard later | high |
| L8 | Database ownership | **The Python worker connects to Postgres directly, as its own role `ocr_worker`,** with grants on exactly 3 tables and no access to `users`/`tenants`/`api_keys`/`sessions`/`documents`/`audit_log`/`billing` | sharing the app DSN; HTTP-callback-only worker with zero DB access | moderate | high |
| L9 | Source bytes | Payload carries **`{bucket, key, sha256}`**, never a pre-signed URL; the worker holds prefix-scoped object-storage credentials (read `orig/`, write `deriv/`) — which dimension F already requires | pre-signed URL in the payload (expires while queued); worker reads `documents` table | easy | high |
| L10 | Contract source of truth | **Zod 4.4.3 schemas in the Next repo** → `z.toJSONSchema()` → committed JSON Schema → Pydantic 2.13.5 models validated against it in CI | Python as source of truth; hand-maintained parallel schemas; Protobuf/Avro | easy | high |
| L11 | Payload versioning | Explicit `schemaVersion` literal; `extra="forbid"` on the consumer; **consumer-first deploy order enforced in the deploy script** | `extra="ignore"` forward compat; unversioned payloads | easy | high |
| L12 | Delivery semantics | **At-least-once.** Exactly-once *effects* via fencing token + content-addressed page cache + idempotent object PUTs + an `ai_calls` ledger keyed on a deterministic idempotency key | claiming exactly-once delivery; two-phase commit | hard | high |
| L13 | Retry policy | `min(300 s, 1 s · 2^(attempt−1))` **with full jitter**; `maxAttempts` 4 for retryable codes, **0 additional attempts** for terminal codes | jawbong's un-jittered backoff; uniform maxAttempts for all errors | easy | high |
| L14 | Poison handling | Two levels: job → `DEAD` after `maxAttempts`; **page → `POISON` after 2 attempts**, job continues and finishes `SUCCEEDED` with `degraded = true` | whole-job failure on one bad page; infinite retry | easy | high |
| L15 | DLQ | **`state = 'DEAD'` in the same table** + partial index + admin view + one-`UPDATE` requeue | a separate `ocr_jobs_dead` table | easy | high |
| L16 | Fairness | **Per-tenant in-flight cap inside the claim statement** + `priority DESC` + priority decay by tenant backlog at enqueue time | pure FIFO `ORDER BY created_at` (caused a documented production incident in krs-pos); per-tenant queues | moderate | high |
| L17 | Backpressure | Per-tenant `maxPending` / `maxInflight` → HTTP 429; global soft limit sheds API/batch traffic before interactive uploads → 503 | unbounded queue; worker-side-only limits | easy | medium |
| L18 | Progress delivery to UI | Worker updates `ocr_jobs.progress_*` per page; Next SSE endpoint polls that **one row** at 1 s. `LISTEN/NOTIFY` fan-out deferred to M2 | NOTIFY-per-page from day one; WebSocket; client polling the REST job endpoint | easy | medium |
| L19 | Cancellation | `abort_requested` flag + `NOTIFY`; **cooperative abort at page boundaries only**; an in-flight billed AI call is always allowed to complete and its result is persisted | SIGKILL the worker; `pg_cancel_backend`; abandoning paid-for results | easy | high |
| L20 | Synchronous fast path | **None.** Dimension E's `POST /v1/extract` is retained as a test-only harness, never routed in production | a sync path for ≤3-page documents | easy | medium-high |
| L21 | Error detail storage | A closed **error *code*** enum + an allow-listed redacted detail object. **Raw exception messages are never written to Postgres** — they can contain document content | jawbong's `error.name` (too coarse); `str(exc)` (leaks PII) | easy | high |

**Added in review (L22–L31).** Each of these was a hole in the draft, not a refinement of it.

| # | Decision | Chosen | Rejected | Reversibility | Confidence |
|---|---|---|---|---|---|
| L22 | Relationship to dimension G's `ExtractionJob` | **One table, not two.** G's `extraction_jobs` and this document's `ocr_jobs` are the same table; **this document owns its columns and its claim protocol (G's A-6/G-note both say so), G owns its placement in the ERD, its composite FK to `Document`, and its RLS posture.** Adopt G's `organization_id` naming, G's composite `(id, organization_id)` FK anchor, and G's `JobEvent` table name; adopt this document's fencing token, `priority DESC`, error-code enum and `max_attempts = 4` | two tables; H's naming winning by default; G's timestamp lease winning by default | **hard** (schema identity) | high |
| L23 | Tenant column name | **`organization_id` / `organizationId`** everywhere, matching dimensions G, I and L. This document's `tenantId` is renamed. The *word* "tenant" survives only in prose and in metric label names | `tenant_id`; dual naming with a view | easy now, hard after M1 | high |
| L24 | RLS posture for the queue tables | **`ocr_jobs`, `ocr_page_results`, `ocr_job_events` and `ai_calls` carry `FORCE ROW LEVEL SECURITY` with G's `app.current_org` policy for `ocr_app`, plus an explicit `ocr_queue`/`ocr_worker` policy of `USING (true)`** — the worker claims across organisations by design and cannot set `app.current_org` before it knows which one it got | exempting the queue tables from RLS (silently diverges from G's `TENANT_TABLES` test); giving the worker `BYPASSRLS` (grants it bypass on *every* table, including `users`) | moderate | high |
| L25 | Cross-organisation read by the worker | **Accepted and explicitly bounded, not denied.** A compromised worker can read every organisation's `ocr_jobs.payload` (which carries storage keys) — this is inherent to a shared queue with a cross-tenant claim. Bound it: the payload carries **no signed URL and no content**, the worker's object-storage credential is **short-lived and issued per claim** (§11.3), and `ocr_jobs` SELECT is narrowed to a column list that excludes nothing useful but is audited | claiming (as the draft did) that "the worker cannot enumerate other tenants' documents" — that claim was **false** | moderate | high |
| L26 | Object-storage credential shape | **Per-claim, short-lived, prefix-scoped credential minted by `ocr-web` and returned by the claim** (STS `AssumeRole` with a session policy on S3; a signed capability token on the local adapter) | a long-lived static key scoped to `orig/`/`deriv/`/`result/` — **impossible under dimension I's tenant-first key layout** | moderate | medium-high |
| L27 | Completion → domain event | **A Postgres `AFTER UPDATE` trigger on `ocr_jobs` writes the `document.extracted` / `document.failed` row into `outbox_events` in the worker's own commit.** The worker gets no `INSERT` grant on `outbox_events`; the trigger runs as the table owner via `SECURITY DEFINER` | a Node-side reconciler polling `ocr_jobs` (a second at-least-once boundary); granting the worker INSERT on `outbox_events` (widens L8) | easy | medium-high |
| L28 | Global budget clock | **The budget starts at first claim** (`deadline_at = started_at + budget_ms`), not at enqueue. Queue wait is governed by a **separate, retryable** `queue_expires_at` TTL | deadline from enqueue — mass terminal failure under backlog | easy | high |
| L29 | Per-error-class retry budget | **The worker computes an effective budget and passes it as a bind parameter** (`LEAST(max_attempts, class_budget)`), because `max_attempts` is an app-owned column the worker may not write | a per-class column set at enqueue (the class is not known at enqueue); letting the worker `UPDATE max_attempts` (breaks L8) | easy | high |
| L30 | Text normalisation on the contract boundary | **NFC on every Thai-bearing string that crosses the boundary or enters a hash**, and lengths are declared in **UTF-8 bytes**, not "characters", on both sides | Zod's UTF-16 `.max()` vs Pydantic's code-point `max_length` — silently different limits | easy | high |
| L31 | UI progress transport in M1 | **Adaptive polling of the job REST endpoint**, per dimension L's decision L-8. SSE is built but flagged off in M1 | the draft's "SSE from day one", which contradicted L-8 | easy | high |

---

## 1. Reconciliation with the sibling M0 dimensions

Three sibling documents already exist in `/Users/innovera/Documents/OCR/docs/architecture/m0/`
and I read them. Where they touch this dimension, here is the reconciliation.

### 1.1 Dimension A (`a-environment-and-stack.md`) — decision A-6

A-6 says: *"Copy `outbox_events` + `idempotency_records` verbatim. Do NOT reuse them as the OCR
job queue. Add a new `ocr_jobs` table built on the krs-pos single-statement claim."*

**I confirm A-6 and adopt it.** A's evidence is sound and I reproduced it independently (§2).
I add four refinements and one correction:

| | A's position | This document |
|---|---|---|
| Fencing | `UPDATE … WHERE id = $1 AND lockedAt = $2` (§5.5 item 4) | **Correction.** A `timestamptz` is a poor fencing token: two claims can land in the same `NOW()` value inside one statement, and any clock adjustment breaks the guard. Use a random `uuid` `lease_token` regenerated on every claim. Costs 16 bytes, removes the whole class of bug. |
| Stale window | krs-pos `LOCK_STALE_MS = 10 min` | Refine: 120 s lease **renewed by heartbeat every 30 s**. A crashed worker is detected in ~2 min instead of 10, and a legitimately slow 25-minute job never expires. |
| Backoff | jawbong's `min(cap, base·2^(n−1))` | Refine: add **full jitter**. Jawbong's formula is deterministic, so after a gateway outage every failed job retries at exactly the same instant. |
| Fairness | A identifies the starvation risk and says "priority column or per-document fairness from day one" | I specify the actual mechanism: a per-tenant in-flight cap evaluated **inside the claim statement**, plus priority decay at enqueue (§7). |
| Rejecting pg-boss / graphile-worker | Rejected on schema-ownership / ADR-002 grounds | Agree, and add the decisive reason A missed: **both are Node-only.** `pg-boss@12.30.0` and `graphile-worker@0.18.0` have no Python consumer and no documented wire contract for one. Our worker is Python. That alone ends the discussion (§4.2). |

A also did not cover: the polyglot cost of hand-rolled claim logic (§4.1), page-level
checkpointing, database credential separation, or the cancellation contract. Those are this
document's job.

### 1.2 Dimension E (`e-native-extraction-routing.md`) — the `POST /v1/extract` boundary

E specifies a Python 3.12 extractor exposing:

```
POST /v1/extract
  { "documentId": "...", "sourceUri": "s3://...", "declaredMime": "application/pdf",
    "policy": { … } }
→ 200 { NormalizedDocument }
```

**That request/response *shape* is correct and is preserved as the job payload and result schema.
The *transport* is not.** A synchronous HTTP call cannot carry a 200-page, multi-minute job:

- the Next.js route would have to hold an open request for 10+ minutes (Caddy, the browser, and
  any intermediate proxy will all time out first);
- a worker restart mid-request loses the job with no record that it ever existed;
- there is no retry, no backpressure, no queue depth, no progress, and no cancellation;
- the response body for a 200-page `NormalizedDocument` can be tens of MB in a single HTTP body.

So: **E's contract shape becomes §9's `OcrJobPayloadV1`; E's `NormalizedDocument` becomes the
object-storage artifact pointed at by `OcrJobResultV1.documentUri`.** The `/v1/extract` endpoint
survives only as a test harness (§11.4) and is not routed in production (decision L20).

### 1.3 Dimension F (`f-preprocessing-and-confidence.md`) — derivative keying

F specifies `deriv/{tenantId}/{documentId}/{sha256}/{recipeHash}/p{page}.png` and a `recipeHash`
computed from the ordered preprocessing recipe. This is directly load-bearing here: it means

1. a page derivative is **content-addressed**, so re-rendering after a crash produces a byte-identical
   object at the same key — object-storage writes are therefore idempotent (decision L12);
2. `recipeHash` and `pipelineVersion` belong in the page-checkpoint unique key (decision L6), so
   changing the preprocessing recipe correctly invalidates the checkpoint cache rather than
   silently reusing stale OCR;
3. **the worker must hold object-storage write credentials regardless** — F requires it to write
   `deriv/`. That settles part of the credential question in §11: HTTP-callback-only is not a
   "worker holds no credentials" design, it is a "worker holds object-storage credentials but not
   DB credentials" design, which is a much weaker claim than it first appears.

F also gives us the two-number confidence model (`ocr.*` and `extraction.*` never fused), which is
why `OcrJobResultV1` in §9.3 carries `ocr.scoreP10` and a separate `ai` block, never a blended score.

### 1.4 Dimension B/C — the AI gateway (**corrected in review; the draft was stale**)

**The draft said: "B confirms the orchestrator's negative finding: no LiteLLM/vLLM/Qwen endpoint is
discoverable on this machine." That is now only half true, and the half that changed is the half
this document depended on.**

`b-ai-topology-discovery.md` is now `status: reviewed` and partially overturns its own draft. Its
review found a second authenticated GitHub account holding a **public** repository,
`WeiWutichai/innovera-chat`, which is the existing production consumer of the gateway. From it:

| B's ref | Fact | Status for this document |
|---|---|---|
| E1 | Env vars are `LITELLM_BASE_URL` / `LITELLM_API_KEY` | **EVIDENCED** — the gateway is LiteLLM, not a generic "AI gateway" |
| E2 | The base URL does **not** include `/v1`; the client appends the full path | EVIDENCED |
| E3 | Auth is `Authorization: Bearer <key>` | EVIDENCED |
| E4 | The key is a LiteLLM **virtual key**, not the master key | EVIDENCED — matters for §16's rate-limit design |
| E5 | The model alias is **`innovera-ai`** | EVIDENCED. **The underlying model is UNRESOLVED**: B's own wording is *"Qwen"* as a name, *"which Qwen, and what size, remain UNKNOWN"* |
| E6 | Context ceiling **65 536 tokens** | EVIDENCED — bounds §16.1's chunking |
| E7 | **The deployed model is TEXT-ONLY** — *"No OCR, no vision, and no image bytes ever leave the server for the LLM"*, written as a design constraint in production source | **RESOLVES item E at high confidence.** Branch T is the build target |
| E8 | Reached over an **internal Docker network**, not a public hostname | EVIDENCED — no egress rule needed for the worker |

**What is still UNRESOLVED and must be owner-supplied** (B §3.2): the literal *value* of
`LITELLM_BASE_URL` (host/port; it lives only in a gitignored `.env.local` on the production host),
the full model list from `GET /v1/models`, whether `innovera-ai` is the only alias, and whether OCR
is issued **its own** virtual key and its own network access.

**Consequence for this document.** §16 no longer "designs both branches equally". **Branch T is the
default and is what M1 builds.** Branch V is *designed, not built*, and reopens only on B's stated
expiry triggers. Nothing in §§6–15 changes either way — that invariance was the draft's genuine
contribution and it survives.

**One requirement lands here from B §5.1, and the draft missed it.** Because the model cannot see
the page, *"`ocr-worker` must therefore emit bounding boxes, not just a text blob — a contract
decision that must land in item I now, because retrofitting geometry later is expensive."* This
document owns "item I (part)". Geometry is therefore a **hard requirement of the result contract**,
not an implementation detail — see R16 (§3) and §9.3's `blocksUri` contract.

### 1.5 Dimension G (`g-data-model.md`) — **the job queue was designed twice** (added in review)

This is the most serious finding of the review. G independently specifies the same table:

```prisma
model ExtractionJob {              // g-data-model.md §, model at line 840
  organizationId String    @map("organization_id") @db.Uuid
  status         JobStatus @default(PENDING)
  maxAttempts    Int       @default(5)
  lockedAt       DateTime? @map("locked_at")       // timestamp lease
  lockedBy       String?   @map("locked_by")
  leaseUntil     DateTime? @map("lease_until")
  lastError      String?   @db.VarChar(1000)
  @@index([status, priority, availableAt], map: "extraction_job_claim_idx")
  // "ORDER BY priority ASC, available_at ASC LIMIT $n FOR UPDATE SKIP LOCKED"
  @@unique([id, organizationId], map: "extraction_job_id_org_key")   // composite-FK anchor
}
model JobEvent { … }               // == this document's ocr_job_events
```

Point-by-point divergence, and the resolution (decision L22):

| Aspect | G (`extraction_jobs`) | H draft (`ocr_jobs`) | **Resolved** |
|---|---|---|---|
| Table name | `extraction_jobs` | `ocr_jobs` | **`extraction_jobs`** — G owns the ERD and `Document` already has the relation. This document's SQL keeps saying `ocr_jobs` below for readability; treat it as an alias to be renamed in the M1 migration. |
| Tenant column | `organization_id` | `tenant_id` | **`organization_id`** (L23). Dimensions G, I and L all say organisation; H was the outlier. |
| Priority direction | **`ORDER BY priority ASC`** (lower runs sooner) | **`priority DESC`** (higher runs sooner) | **`priority DESC`**, i.e. this document's §7.2 table stands — but **G's `extraction_job_claim_idx` is then wrong** (`(status, priority, available_at)` cannot serve `priority DESC` efficiently as a forward scan; it needs `(priority DESC, available_at ASC) WHERE status='PENDING'`). This must be fixed in G, not worked around here. **If it is not fixed, every priority in §7.2 is inverted and backfills pre-empt interactive uploads.** |
| Lease | `locked_at` / `locked_by` / `lease_until` — a timestamp lease | `lease_token` uuid + `lease_expires_at` | **The fencing token** (L4). The argument in §1.1 applies verbatim to G's shape. |
| `maxAttempts` | 5 | 4 | **4** job-level, with the per-class effective budget of L29. |
| Error storage | `lastError String @db.VarChar(1000)` | code enum + allow-listed JSONB | **Code enum + JSONB** (L21). G's free-text column is the exact PII leak §9.1 rule 5 exists to prevent. |
| Events | `JobEvent` / `job_events`, `detail String @db.VarChar(1000)`, 90-day retention | `OcrJobEvent` / `ocr_job_events`, `detail Json`, 30-day retention | **G's table name and 90-day retention; this document's `detail Json` allow-list.** 90 days beats 30 for an audit trail that a Thai PDPA subject-access request may need to answer. |
| Composite FK | `(id, organization_id)` → `Document(id, organizationId)` | none | **Adopt G's.** It is the second of G's three isolation layers and this document was silently opting out of it. |
| Result | `resultRef String @db.VarChar(1024)` | `result Json` (≤64 KiB) + `result_uri` | **Both**, as here — the ≤64 KiB summary is what makes the list view cheap. |
| RLS | `FORCE ROW LEVEL SECURITY`, `app.current_org`, and a **third role `ocr_queue`** for the cross-tenant claim | not mentioned at all | See §11.5 (L24). |

**Escalation.** L22/L23 are the only decisions in this document with **hard** reversibility. They
must be settled between G and H *before* the first migration is written, because every downstream
artifact — the Zod payload's field names, the Pydantic aliases, the grants, the views, the metric
labels — encodes the answer.

### 1.6 Dimensions I, J, L, N — the rest of the reconciliation (added in review)

**Dimension I (`i-storage.md`) breaks §11.3's credential model.** I's canonical key layout is

```
{tenantId}/{yyyy}/{mm}/{shard}/{documentId}/…      # tenant-first, hash shard, ≤512 bytes
```

with the explicit rationale that *"`tenantId` leads, so `list('{tenantId}/')` is a single prefix
scan"*, and that a hash-first layout is **rejected** because it would destroy per-tenant listing.
The draft's §9.2 (`orig/{tenantId}/{documentId}/{sha256}`), §11.3 (IAM scoped to top-level `orig/`,
`deriv/`, `result/` prefixes) and dimension F's `deriv/{tenantId}/…` are all **incompatible with
it**, and §11.3's table — the entire concrete content of decision L9's security story — cannot be
implemented as written, because there is no top-level `orig/` prefix to scope a credential to.
Resolution in §11.3 (decision L26): the role/prefix split moves *inside* the per-organisation
subtree, and the worker gets a **short-lived credential minted per claim** rather than a static
prefix-scoped key. G's `org/{orgId}/doc/{docId}/original` (G §, line 89) is a third variant and is
also superseded by I.

**Dimension J (`j-security-threat-model.md`)** is consistent with this document: its EoP row
prescribes the same *"dedicated least-privilege role: `CONNECT`, `SELECT/INSERT/UPDATE` on business
tables, no `CREATE`, no `SUPERUSER`; migrations run as a separate role → M1"*, and it already owns
`ocr_worker/imaging/limits.py`, i.e. §8.2's pixel guard. No conflict. J does **not** cover the
cross-organisation payload read of L25; that finding should be pushed back into J's STRIDE table.

**Dimension L (`l-api-ui-export.md`) contradicts §9.5.** L's decision **L-8** is *"**Adaptive
polling** on a batch-status endpoint; SSE only on the single-document review screen, **flagged off
in M1**"*. The draft's §9.5 specified SSE as the M1 path. **L wins** (decision L31) — it owns the
API surface, and adaptive polling of one indexed row is strictly cheaper than a held connection per
tab. §9.5 is rewritten. L's public status enum is `queued | processing | succeeded | failed |
cancelled`; this document's `DEAD` has **no public representation**, which is correct and
deliberate — `DEAD` maps to public `failed` and is an operator-only distinction (§6.3).

**Dimension N (`n-observability-testing-benchmark.md`) adopted this document's metrics** and refined
them: `ocr_queue_pending` is labelled `tenant_bucket` (explicitly bucketed, closing the cardinality
hole §15.2 left open), and N's `OcrQueueStalled` **subsumes** this document's `OcrNoWorkers`
(*"no workers is one cause of a stalled queue, and the symptom is what the customer experiences"*).
N adds `OcrJobFailureRateHigh`. §15.3 is updated to defer to N.

### 1.7 Corrected environment facts I am building on

Dimensions A and D both corrected the orchestrator's brief; I adopt their corrections:

- **This is an Intel Mac** (`x86_64`, i5-1038NG7, 4C/8T), not Apple Silicon. Docker is
  `linux/amd64`, 8 vCPU, 7.75 GiB — the same architecture as a Linux VPS. (`a-…md` §2.1.)
- **`uv 0.11.17` is installed** and manages CPython 3.11.15. Python tooling does not have to plan
  around the 3.9.6 system interpreter. (`b-…md` §0.1.) **Note the distinction, which the draft
  blurred:** 3.11.15 is what `uv` has fetched *on this laptop*; the **worker container pins
  Python 3.12**, per dimension E's E1 (`puremagic` 2.2.0 requires ≥ 3.12) and dimension D §7.4
  (3.9.6 ships `unicodedata` 13.0.0; 3.12 ships Unicode 15+, which matters for Thai normalisation
  — see §9.8). Every `requires_python` figure in §18.3 is checked against **3.12**, not 3.11.
- Docker containers now bind `5432` (krs-pos-db, loopback-only) and `1433`; the OCR dev stack must
  use a different port. Verified in-session:
  ```
  $ docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}'
  quotation-system-app       …  0.0.0.0:8080->80/tcp
  quotation-system-postgres  postgres:16-alpine  5432/tcp
  krs-pos-db                 postgres:16-alpine  127.0.0.1:5432->5432/tcp
  orderstock-sql             mssql/server:2022-latest  0.0.0.0:1433->1433/tcp
  ```
- **There are four stopped `redis:7` containers** (`juneflow-linrb-redis-1`, `jf-lx2-redis-1`,
  `jf-w29-redis-1`, `jf-w26lock-redis-1`). They belong to juneflow, not to any INNOVERA project,
  and **none are running**. So Redis is *familiar* to this operator but is not currently an
  operated service. This matters for the §5 owner decision.

---

## 2. What jawbong's outbox actually provides, and what it lacks

Files read in this session:

- `/Users/innovera/Documents/jawbong/src/modules/outbox/domain/outbox-event.ts`
- `/Users/innovera/Documents/jawbong/src/modules/outbox/application/outbox-ports.ts`
- `/Users/innovera/Documents/jawbong/src/modules/outbox/application/outbox-worker.ts`
- `/Users/innovera/Documents/jawbong/src/modules/outbox/infrastructure/prisma-outbox-repository.ts`
- `/Users/innovera/Documents/jawbong/src/modules/outbox/infrastructure/prisma-idempotency-repository.ts`
- `/Users/innovera/Documents/jawbong/prisma/schema.prisma`
- `/Users/innovera/Documents/jawbong/prisma/migrations/20260803000000_phase_00_foundation/migration.sql` (39 lines total)

### 2.1 What it provides — reusable as-is

| Capability | Where | Verdict for OCR |
|---|---|---|
| `SELECT … FOR UPDATE SKIP LOCKED` claim inside a transaction | `prisma-outbox-repository.ts:claimAvailable` | **Reuse the pattern.** Correct concurrency primitive. |
| Lease via `claim_until`, re-claimable when `status='PROCESSING' AND claim_until < now` | same | **Reuse the idea**, change the shape (§6.3). |
| Bounded exponential backoff `Math.min(capMs, baseMs * 2 ** Math.min(attempt-1, 20))`, base 1 s, cap 300 s | `domain/outbox-event.ts:calculateBackoffMs` | **Reuse, add jitter.** |
| Argument guardrails (`limit` 1–100, `leaseMs` 1000–900000, thrown before the query) | `claimAvailable` | **Reuse verbatim.** Good discipline. |
| Terminal `FAILED` rows retained, never deleted | `reschedule` | **Reuse.** Rows stay inspectable — that is our DLQ shape. |
| Error redaction: only `error.name` is persisted, truncated to 1000 chars | `outbox-worker.ts` + `reschedule` | **Reuse the *principle*, tighten it** (decision L21). `error.name` is too coarse to drive retry policy; a closed error-code enum is both safer and more useful. |
| Zod validation of the row on the way out (`outboxEventInputSchema.parse`) | `toClaimedEvent` | **Reuse.** Validating on read, not just on write, is the right instinct for a table two languages touch. |
| `idempotency_records` with `@@unique([scope, key])`, `requestHash` = SHA-256 of `JSON.stringify(payload)`, `response`/`responseCode`/`expiresAt` | `schema.prisma`, `prisma-idempotency-repository.ts` | **Reuse the table, NOT the hash.** *(Corrected in review — the draft said "reuse verbatim", which contradicts dimension A's own A-6, whose rejection list explicitly names "an order-dependent idempotency hash" as one of the outbox's defects.)* `JSON.stringify` preserves **insertion order**, so `{"a":1,"b":2}` and `{"b":2,"a":1}` — the same request from two clients, or from one client after a library upgrade — hash differently and the replay returns a spurious **422**. Replace with RFC 8785 JSON Canonicalization (`json-canonicalize`) over an **NFC-normalised** body, then SHA-256. See §10.1. |
| `CHECK ("attempts" >= 0)` | `migration.sql:20` | **Reuse.** |

### 2.2 What it lacks — nine gaps, each fatal for OCR

1. **No result.** `OutboxEvent` has `payload` (input) and nothing else. An OCR job must record the
   output artifact pointer, page counts, engine identity, confidence, token/cost accounting, and
   per-stage timings. There is nowhere to put any of it.
2. **Completion is not lease-guarded.** Verbatim from `prisma-outbox-repository.ts`:
   ```ts
   async markProcessed(id: string, processedAt: Date): Promise<void> {
     await this.prisma.outboxEvent.update({
       where: { id },
       data: { status: "PROCESSED", processedAt, claimedAt: null,
               claimUntil: null, lastError: null },
     });
   }
   ```
   No `WHERE claim_until > now()`. A worker whose lease expired while it was still running will,
   on completion, overwrite whatever the *new* owner wrote. Jawbong's mitigation is a written
   contract ("handlers must be idempotent"), not a guard. For a job that spends money on a model
   call and writes extracted customer text, that is not acceptable — we need an actual fencing
   token (decision L4).
3. **No lease renewal.** A 30 s default lease with no heartbeat. A single 300 dpi page render plus
   Thai OCR will exceed 30 s on the dev box; a 200-page document certainly will. Raising the lease
   to 25 minutes instead makes crash detection take 25 minutes. Only a heartbeat resolves this.
4. **No priority and no fairness.** `ORDER BY occurred_at ASC LIMIT 10`. This is the exact query
   shape that caused a documented production incident in the sibling krs-pos codebase (quoted in
   `a-…md` §5.4: held bills monopolised every batch and starved clean bills). Translated: one
   tenant's 500-page PDF starves every other tenant's single-page upload.
5. **No progress.** Nothing to show a user beyond PENDING/PROCESSING.
6. **No cancellation.** No `abort_requested`, no notification path.
7. **No poll-avoidance.** I grepped for `LISTEN`/`NOTIFY`/`pg_notify` across
   `/Users/innovera/Documents/jawbong/src` and `/scripts`: the only hits are inside
   `src/generated/prisma/**` (Prisma's own generated types), i.e. **zero application use.**
   `OutboxWorker.runOnce()` does one pass; something external must schedule it. Acceptable for
   domain events; a poor fit for a job a human is watching a spinner for.
8. **Attempts increment at claim time, not at failure time.** Good against poison pills, harsh on
   transient blips: a worker OOM-killed by an unrelated neighbour burns an attempt. With a
   200-page job that dies at page 190, burning attempts is expensive. Mitigated here by page
   checkpointing (§8) so a retry is cheap, and by error classification (§12) so infrastructure
   errors get a larger `maxAttempts` than content errors.
9. **No tenant column.** No way to express fairness, per-tenant quotas, per-tenant purge, or
   per-tenant metrics. In a multi-tenant secure platform, `tenant_id` on the queue row is
   non-negotiable.

### 2.3 Verdict

`outbox_events` is a good **domain-event outbox** and a bad **job queue**, exactly as dimension A
concluded. Adding a result column, a tenant column, a priority column, a lease token, a heartbeat
path, a progress triple, an abort flag, and a notify trigger produces a different table wearing a
misleading name. Copy the outbox verbatim for what it is for; build `ocr_jobs` separately.

**Concretely, the outbox still earns its place in this design**: the transactional enqueue of
`ocr_jobs` and the emission of `document.uploaded` / `document.extracted` domain events happen in
the *same* Prisma transaction (§13.1). The outbox is how those events reach webhooks, search
indexing, and billing — none of which belong in the OCR job path.

---

## 3. Requirements this queue must satisfy

Derived from the product and from the sibling dimensions. Each is testable.

| # | Requirement | Source | Acceptance test |
|---|---|---|---|
| R1 | A job survives an ungraceful worker death (SIGKILL / OOM / node reboot) and is retried | product | `docker kill -s KILL` mid-job → job returns to PENDING within 150 s and completes |
| R2 | A retry after a crash at page 190 of 200 does **not** redo pages 1–189 | product cost | crash test measures ≤ 15 pages re-processed |
| R3 | A 25-minute job never has its lease stolen while it is healthy | R1 tension | 25-min synthetic job completes with exactly 1 claim |
| R4 | One tenant cannot starve another | krs-pos incident (`a-…md` §5.4) | 1×500-page + 20×1-page interleaved → every 1-page job starts within 60 s |
| R5 | At-least-once delivery with no lost jobs | product | 10 000 enqueues under chaos → 10 000 terminal states, 0 stuck |
| R6 | No double-billing of the AI gateway on retry | cost + `f-…md` cost accounting | forced double-claim → exactly 1 row in `ai_calls` |
| R7 | Real per-page progress visible in the UI within 2 s of the page finishing | product | E2E asserts monotonic progress |
| R8 | Cancellation takes effect within one page boundary | product ("cancel where safely possible") | ≤ 20 s for classical branch |
| R9 | A malformed/poison document cannot loop forever | ops | 4 attempts then DEAD, with a code |
| R10 | A single bad page does not fail a 200-page document | product | job ends SUCCEEDED, `degraded=true`, poisoned page listed |
| R11 | Queue depth, age, and per-tenant backlog are observable and alertable | ops | `/metrics` gauges + 4 alert rules |
| R12 | Workers scale horizontally with no coordination beyond Postgres | ops | 1→8 workers, no duplicate processing |
| R13 | The worker holds no credential that grants access to user, tenant, key, or billing data | security ("do not share database credentials unnecessarily") | `ocr_worker` role `SELECT` on `users` → permission denied |
| R14 | The Node and Python sides cannot silently disagree about the payload shape | polyglot | CI schema-drift check fails on divergence |
| R15 | Enqueue is atomic with the document write | correctness | no document row without its job row |

**Added in review** — each of these was demanded by a sibling dimension or by the brief and was
absent from the draft's requirement set, which is why the draft's design did not satisfy them.

| # | Requirement | Source | Acceptance test |
|---|---|---|---|
| R16 | The result contract carries **per-line/per-word geometry**, not just text | `b-…md` §5.1: *"`ocr-worker` must therefore emit bounding boxes … a contract decision that must land in item I now"* | contract fixture asserts `blocks[].bbox` present and in page coordinates for every OCR-routed page |
| R17 | A terminal job emits a **domain event** that webhooks / search / billing can consume, in the same commit as the state change | `outbox_events` exists for exactly this; nothing in the draft wrote to it after enqueue | kill the Node process, finish a job from the worker only, assert one `outbox_events` row of type `document.extracted` |
| R18 | The queue tables satisfy dimension G's RLS test suite (`FORCE ROW LEVEL SECURITY` on every organisation-scoped table) **and** the cross-organisation claim still works | `g-…md` §3.4 `it.each(TENANT_TABLES)` | G's RLS test passes with `extraction_jobs` in `TENANT_TABLES`, and a claim as `ocr_worker` returns a job belonging to an org the session never set |
| R19 | Job payloads, page rows and events for a deleted organisation are **provably erasable** within the statutory window | Thailand **PDPA** §§ on erasure; the payload carries storage keys and a filename, i.e. personal data | `deleteOrganization` → 0 rows in `extraction_jobs`, `ocr_page_results`, `job_events`, `ai_calls` for that org |
| R20 | Thai text and Thai filenames round-trip byte-identically across the Node→Postgres→Python boundary | product (Thai-primary) | fixture with NFC and NFD Thai, Thai numerals (๐–๙), a ZWSP-segmented Thai sentence, and a 255-Thai-character filename passes both validators and compares equal after NFC |
| R21 | A backlog longer than the job budget does **not** terminally fail queued jobs | draft defect, §13.2 | enqueue 5 000 jobs, drain slowly, assert 0 `BUDGET_EXCEEDED` attributable to queue wait |

R15 deserves emphasis because it is the single strongest argument for the Postgres substrate.
With Postgres, `createDocument` and `createOcrJob` are two statements in one
`prisma.$transaction()`. With Redis they cannot be — you need the outbox pattern (write an event
row in the transaction, then a relay process pushes to Redis), which is an extra process, an extra
failure mode, and extra latency. We would be adding Redis *and* keeping the Postgres queue row.

---

## 4. Option comparison

### 4.0 The polyglot constraint, stated once

Our web tier is **Node 24 / Next 16 / Prisma 7** (dimension A) and our worker is **Python 3.12**
(dimension E, because pdfplumber / pypdfium2 / opencv / ONNX Runtime / PaddleOCR have no
credible TypeScript equivalents). Every option below must be scored on how it behaves when a
producer written in TypeScript and a consumer written in Python must agree.

There are exactly three ways two languages can share a queue:

- **(a) Share a data format.** SQL rows + JSONB. Both languages speak both natively. No library
  needs a port. This is the cheapest possible coupling.
- **(b) Share a library's wire protocol.** Redis keys + Lua scripts (BullMQ), or Celery's
  message envelope. Requires a maintained client in *both* languages, at compatible versions,
  forever.
- **(c) Share an HTTP contract.** Then one side owns the queue and you have not actually solved
  the queueing problem, only moved it.

### 4.1 Option A — PostgreSQL-backed queue, Python consumer

Four sub-variants. The Python side is where the real choice lives.

| Sub-option | Python side | Assessment |
|---|---|---|
| **A1** | `procrastinate 3.9.0` (PyPI, `requires_python >=3.10`) | The strongest off-the-shelf option. See §4.1.1. |
| **A2** | **Raw `psycopg 3.3.5` claim loop, custom `ocr_jobs` table** | **CHOSEN.** See §4.1.2. |
| A3 | `pg-boss 12.30.0` schema, consumed by hand-written Python | pg-boss is Node-only. Reimplementing its `job` state machine and archive semantics in Python means owning a *foreign* schema you cannot change — strictly worse than owning your own. Rejected. |
| A4 | `graphile-worker 0.18.0` schema, consumed by hand-written Python | Same objection. `graphile-worker` requires Node ≥ 22.18.0 and ships its own migration lifecycle; there is no Python consumer. Rejected. |

#### 4.1.1 procrastinate 3.9.0 — the serious runner-up

What it actually provides, from the schema I fetched
(`https://raw.githubusercontent.com/procrastinate-org/procrastinate/main/procrastinate/sql/schema.sql`)
and the docs:

- Tables `procrastinate_jobs`, `procrastinate_events`, `procrastinate_workers`,
  `procrastinate_periodic_defers`. Status enum:
  `'todo','doing','succeeded','failed','cancelled','aborting','aborted'`.
- Deferral from any language via
  `procrastinate_defer_jobs_v1(jobs procrastinate_job_to_defer_v1[])`, where the composite type is
  `(queue_name varchar, task_name varchar, priority integer, lock text, queueing_lock text, args jsonb, scheduled_at timestamptz)`.
  **A TypeScript producer really can enqueue with one `pg` query** — this is not a hack, it is the
  documented cross-language path.
- `LISTEN/NOTIFY` on `procrastinate_any_queue_v1` and `procrastinate_queue_v1#<queue_name>`, fired
  by `AFTER INSERT … WHEN (new.status = 'todo')` triggers. So a TS `INSERT` wakes a Python worker
  with no polling latency.
- **Worker heartbeat**, `procrastinate_update_heartbeat_v1(worker_id)`, default interval 10 s,
  stalled threshold 30 s, plus `procrastinate_prune_stalled_workers_v1(seconds_since_heartbeat)` and
  `JobManager.get_stalled_jobs()` / `retry_job()`. This is a **better model than a per-job lease**
  for long jobs: the heartbeat is per *worker*, so a legitimately slow 25-minute job is never
  mistaken for a dead one, while a dead worker is detected in 30 s.
- Real **abort** semantics: `cancel_job_by_id(job_id, abort=True)` sets `abort_requested`, an
  `AFTER UPDATE OF abort_requested … WHEN (status='doing')` trigger notifies the worker, and the
  task polls `context.should_abort()` (sync) or receives `asyncio.CancelledError` (async).
- Serialisation primitives we would otherwise build: `CREATE UNIQUE INDEX
  procrastinate_jobs_lock_idx_v1 ON procrastinate_jobs (lock) WHERE status='doing'` (only one job
  per lock runs at a time) and `procrastinate_jobs_queueing_lock_idx_v1 ON (queueing_lock) WHERE
  status='todo'` (pending-job dedupe). Both map cleanly onto "one job per document" and "enqueue
  dedupe".
- Sync tasks run in their own thread ("Each sync task runs in its own thread (independently of the
  worker thread)"), so a blocking OCR call does not stall the heartbeat.
- Priority is an `integer` with index `(priority DESC, id ASC) WHERE status='todo'`.

**Why it is not chosen:**

1. **No fairness hook.** `procrastinate_fetch_job_v2(target_queue_names, p_worker_id)` is a fixed
   SQL function. There is no supported way to inject "round-robin across tenants" or "cap
   in-flight per tenant" into the fetch. R4 is a hard requirement backed by an actual in-house
   production incident. The available workaround is to compute `priority` at defer time from the
   tenant's current backlog — a static snapshot that degrades exactly when the queue is deep,
   which is when fairness matters. Forking `procrastinate_fetch_job_v2` means owning a patched
   copy of the library's schema, which is worse than owning our own table.
2. **No result column, no progress.** `procrastinate_jobs` has `args` and no output field. We
   would build `ocr_job_results` + `ocr_job_events` + `ocr_page_results` regardless, so
   procrastinate saves us the *claim loop* and nothing else. That is roughly 300 lines.
3. **Schema ownership conflict with ADR-002.** Prisma is the application data access layer; a
   second migration lifecycle (`procrastinate schema --apply`) must be sequenced against Prisma
   migrations in the compose one-shot `migrate` service (dimension A-7), and Prisma's shadow-DB
   diffing must be told to ignore the `procrastinate` schema. *UNVERIFIED:* Prisma 7's
   `datasource.schemas` (multiSchema) is the documented mechanism, but I did not confirm that
   `prisma migrate diff` fully ignores unlisted schemas in 7.10.0. This must be tested before A1
   could be adopted.
4. **`job_id` is `bigserial`.** Our house convention (jawbong, krs-pos) is UUID primary keys, and
   a monotonically increasing public job id leaks total platform volume to any tenant who can see
   their own job ids. That is a real (if minor) information leak in a "secure OCR" product.
5. **Adds a dependency on a single-maintainer-ecosystem library at the centre of the product's
   reliability story.** procrastinate is healthy and well documented, but the claim loop is the
   part of this system we most need to be able to reason about at 03:00.

**What would flip this to A1:** if §7's fairness claim query turns out to be a measurable
bottleneck or a correctness problem in M2 load testing, or if we grow real scheduling needs
(cron, job dependencies, chained flows) that push our own code past ~500 lines. Then procrastinate
in its own schema with priority-decay fairness is the least-bad alternative, and the migration is
mechanical because §9's payload/result contract is transport-independent by design.

#### 4.1.2 A2 — hand-rolled `ocr_jobs`, `psycopg 3.3.5` (CHOSEN)

- Language-neutral contract: a table and a JSONB column. Neither side depends on a library the
  other side must also have.
- The claim/lease/heartbeat/complete protocol is four SQL statements (§6). The Python side is
  ~350 lines including the abort listener and graceful shutdown; the Node side is ~150 lines of
  enqueue + admin queries. Both are testable against a real Postgres (jawbong already has the
  harness: `pnpm test:integration` → `tsx scripts/with-test-database.ts`).
- Fairness, priority, page checkpointing, progress, results, cost accounting, and per-tenant
  quotas are all first-class columns we design, not features we bend a library into.
- We have **two in-house prior implementations to learn from, including their documented
  failures** (§2.2, and krs-pos's starvation incident). That is unusually good input.
- `psycopg 3.3.5` (`requires_python >=3.10`) provides async, server-side `LISTEN` via a dedicated
  connection, and `psycopg_pool` for the work pool.

Honest costs: ~500 lines of product code plus ~400 lines of tests that we own forever, and the
subtle-bug surface is real — the two bugs dimension A found in jawbong's outbox (unguarded
completion, attempts-at-claim) are exactly the bugs one writes here. §6 pins the protocol so
those specific bugs are designed out, and R1/R3/R5/R6/R12 are the tests that keep them out.

### 4.2 Option B — Redis + BullMQ

`bullmq@6.3.4` (npm, Node ≥ 14.17, optional peer deps `ioredis>=5` / `redis>=5` / `pg>=8`).
Two important 2026 facts I verified:

- **BullMQ v6 has a first-party PostgreSQL backend.** `createPostgresBackend` runs the full
  Queue/Worker/QueueEvents/FlowProducer API on Postgres 13+ (14+ recommended) in its own schema
  (default `bullmq`), with explicit `runMigrations(client)` at deploy time. Schema *downgrades are
  not supported*. (https://docs.bullmq.io/guide/postgresql)
- **There is an official Python client**, **`bullmq 3.2.1`** on PyPI (`requires_python >=3.10.0`).
  *(Corrected in review: the draft said 2.24.0. Re-fetched from `https://pypi.org/pypi/bullmq/json`
  on 2026-09-09 → **3.2.1**. The draft's version was wrong by a major release, which matters
  because 3.x is materially more capable than the draft credited it.)* Ported features now include
  regular/delayed jobs, **job deduplication**, priority, repeatable jobs, workers, job events, job
  progress, retries, backoff, getters, **Flow Producer**, **Lock Manager**, **global concurrency and
  rate limit**, and **per-job cancellation**. It still states verbatim that *"the library does not
  support all the features available in the NodeJS version"*, and it still works by sharing
  **Lua scripts** with the Node implementation: *"Python Queues are interoperable with NodeJS
  Queues, as both libraries use the same .lua scripts that power all the functionality."*

  **This strengthens rather than weakens the rejection.** The one genuine BullMQ advantage the
  draft named — `FlowProducer` — now exists on the Python side too, so option B1 is more viable
  than the draft allowed, and it is being rejected on the *coupling* argument alone. That argument
  is the durable one: shared Lua scripts across two independently released packages is a runtime,
  version-sensitive, load-dependent failure mode. It is exactly the coupling that a Postgres row
  does not have.

That last point is decisive. **Lua scripts are a Redis mechanism. The Python client therefore
cannot use the Postgres backend.** So the two genuinely available shapes are:

| Shape | What it means | Verdict |
|---|---|---|
| B1 | Node enqueues via BullMQ/Redis, Python worker via `bullmq` 3.2.1 | Couples our most critical path to *cross-language Lua-script version parity* between two independently released packages. A BullMQ Node minor that changes a Lua script must land in the Python client before we upgrade either. This is the worst kind of coupling: silent, version-sensitive, and it fails at runtime under load rather than at build time. |
| B2 | Node enqueues via BullMQ/Redis, a **Node worker shim** pulls jobs and calls Python over HTTP/gRPC | Adds a whole extra service whose only job is to move bytes, plus a second at-least-once boundary (Redis→shim, shim→Python) with its own lease and its own retry. Strictly more failure modes than talking to Postgres directly. |
| B3 | BullMQ with the **Postgres** backend and a Node worker shim | You have added a Node service and a foreign `bullmq` schema in order to avoid writing 4 SQL statements, and you still have B2's double boundary. |

BullMQ's genuine strengths, stated fairly: `FlowProducer` (parent/child jobs with an automatic
fan-in barrier) is materially better than anything we get for free, and its `QueueEvents` +
`bull-board` give a good operational UI on day one. §8.3 shows the fan-in barrier we would write
instead, in about 10 lines of SQL.

### 4.3 Option C — Redis + Python-native (Celery / arq / dramatiq), Node enqueues raw

| Library | Version verified | Notes |
|---|---|---|
| Celery | 5.6.3, `requires_python >=3.9` | Brokers: RabbitMQ, Redis, SQS, Google Pub/Sub. Feature-complete but heavy; its message envelope is a versioned protocol that Node would have to emit by hand. |
| arq | 0.28.0, `requires_python >=3.9` | **In maintenance-only mode** per its own repository — not accepting new features. Disqualifying for a foundational dependency. |
| dramatiq | 2.2.1, `requires_python >=3.10` | Redis or RabbitMQ only; **no Postgres broker**. Clean library, same coupling objection. |

The fatal issue is the same for all three: **Node would enqueue by writing that library's private
message format into Redis by hand.** That is option (b) coupling at its worst — an undocumented,
unversioned, silently-breaking contract. Celery's protocol v2 envelope in particular is not
something a TypeScript codebase should be hand-emitting.

The escape hatch — "Node calls a tiny Python HTTP endpoint that calls `task.delay()`" — means the
enqueue is no longer transactional with the document write (violates R15) and adds a synchronous
dependency to the upload path.

Redis also brings, honestly stated:

- a second datastore with a **different durability model**. Default `appendfsync everysec` means a
  crash can lose up to 1 s of accepted jobs. `appendfsync always` removes that at a large write-throughput
  cost. Postgres's WAL already gives us the guarantee we want, for free, in the same commit as
  the document row.
- a second backup/restore surface, a second thing to secure (`requirepass`, TLS, network policy),
  a second thing to monitor, and a second thing in the compose file and the disaster-recovery runbook.
- for a *secure document platform*, an in-memory store holding document identifiers and policy —
  another place customer metadata lives, another place to reason about at-rest encryption.

### 4.4 Option D — internal HTTP contract, worker owns its own queue

Node `POST`s to the Python worker's FastAPI (`fastapi 0.141.1`), worker owns state.

- The worker must still durably persist queued jobs somewhere or an HTTP 202 is a lie the moment
  the container restarts. So it needs a datastore — and the only sane one is Postgres. **We are
  back to Option A with an extra hop.**
- The enqueue is not transactional with the document write (violates R15).
- The upload path now has a synchronous dependency on the worker being up.
- Backpressure becomes an HTTP concern (connection queueing, timeouts) rather than a queryable
  queue depth.
- Horizontal scaling requires a load balancer in front of workers and sticky state, or a shared
  store — again, Postgres.

**Retained partially:** the worker *does* expose HTTP, but only `GET /healthz`, `GET /readyz`,
`GET /metrics`, and (test-only) `POST /v1/extract`. It never accepts production work over HTTP.

### 4.5 Tradeoff table

Scores: **++** strong, **+** adequate, **~** workable with effort, **−** weak, **−−** disqualifying.

| Criterion | A2 Postgres custom (chosen) | A1 procrastinate | B1 BullMQ+py client | B2/B3 BullMQ+Node shim | C Celery/dramatiq | D worker HTTP |
|---|---|---|---|---|---|---|
| Operational surface (new services) | **++** zero | **++** zero | − Redis | −− Redis + shim service | − Redis | ~ zero new, but worker becomes stateful |
| Transactional enqueue with the app write (R15) | **++** same tx | **++** same tx | −− needs outbox relay | −− needs outbox relay | −− needs outbox relay | −− |
| Crash safety / at-least-once (R1, R5) | ++ WAL | ++ WAL | + AOF, `everysec` window | + | + | ~ depends on its store |
| Lease for a 10–25 min job (R3) | ++ heartbeat-renewed lease | **++** per-worker heartbeat, arguably cleanest | ~ `lockDuration`+renewal; py-client renewal maturity **UNVERIFIED** | ~ | ~ Celery `visibility_timeout` is a known sharp edge | ~ |
| Retry + backoff | ++ ours, jittered | ++ built-in | ++ built-in | ++ | ++ | − build it |
| Poison / DLQ | ++ designed (§12) | + failed state, no page-level notion | + failed set | + | + | − |
| Idempotency / exactly-once effects (R6) | ++ fencing token + ledger | + `lock` index helps; ledger still ours | ~ ours anyway | ~ | ~ | ~ |
| Priority | ++ | ++ | ++ | ++ | ~ (Celery priority is broker-dependent) | − |
| **Per-tenant fairness (R4)** | **++ custom claim** | **− fixed fetch fn** | − | − | − | − |
| Backpressure + admission control | ++ SQL-queryable | + | ~ | ~ | ~ | − |
| Queue-depth observability (R11) | ++ plain SQL | + plain SQL | ~ Redis keys / bull-board | ~ | ~ Flower | − |
| Page-level checkpointing (R2) | ++ ours either way | ++ ours either way | ++ ours either way | ++ | ++ | ++ |
| Fan-out/fan-in for per-page parallelism | ~ 10 lines of SQL (§8.3) | ~ same | **++ FlowProducer** | ++ | ~ Celery chord (fragile) | − |
| Horizontal scaling (R12) | ++ | ++ | ++ | + | ++ | − |
| **Polyglot reality** | **++ SQL+JSONB, no shared lib** | + documented cross-lang defer fn | −− cross-language Lua parity | − extra service | −− hand-emitting a private envelope | + HTTP is neutral |
| Code we own | − ~500 LOC | ++ ~150 LOC | + | ~ | + | −− |
| Ops familiarity in this org | ++ two prior Postgres queues in-house | + | ~ Redis used in juneflow, not INNOVERA | ~ | − | ~ |

---

## 5. OWNER DECISION — Redis / BullMQ

> The user asked explicitly: *"If Redis/BullMQ materially improves safety and production
> behaviour, present the tradeoff before adding it."* This is that block. Read this section even
> if you read nothing else.

### 5.1 The honest answer

**No. For INNOVERA OCR AI as specified, Redis + BullMQ does not materially improve safety, and it
measurably degrades one safety property we actually need.**

**What BullMQ genuinely gives us that Postgres does not:**

1. **`FlowProducer`** — parent/child jobs with an automatic fan-in barrier. If we go to per-page
   parallelism, this is real, tested code we would otherwise write (§8.3 is our ~10-line
   replacement, which is small but is ours to get right).
2. **A mature operational UI on day one** (`bull-board`), versus the SQL views in §15 plus
   whatever admin screens we build.
3. **Higher claim throughput headroom.** Redis will out-claim Postgres by roughly an order of
   magnitude. *UNVERIFIED for our workload;* both are far above our need — a Postgres
   `SKIP LOCKED` claim is a single indexed row lock, and our steady-state target is well under
   10 claims/second because each job runs for seconds to minutes, not microseconds. This headroom
   is irrelevant unless the product changes shape entirely.

**What it costs us, concretely:**

1. **It breaks the transactional enqueue (R15).** Today: `prisma.$transaction([createDocument,
   createOcrJob, enqueueOutboxEvent])` — one commit, no possible divergence. With Redis: write an
   outbox row in the transaction, then a relay process pushes to Redis, then BullMQ, then the
   worker. That is a **new process, a new at-least-once boundary, and a new class of incident
   ("documents stuck at 0% because the relay died")**. This is a *net reduction* in safety, not an
   improvement.
2. **The polyglot problem gets worse, not better.** The Python client (`bullmq` **3.2.1**)
   interoperates with Node **by sharing Lua scripts**, and openly states it lacks feature parity.
   Our most critical path would depend on two independently-released packages keeping Lua scripts
   in sync. And BullMQ v6's Postgres backend — the obvious way out — is **Node-only**, so it
   cannot be used with a Python worker at all.
3. **A second durability model.** Redis default `appendfsync everysec` can lose up to one second
   of accepted jobs on an unclean shutdown. We accepted those jobs with a 202 and a job id.
4. **A second datastore to secure, back up, restore, monitor, patch, and reason about** in a
   product whose entire pitch is *secure* document handling. Every INNOVERA production project I
   can see uses Postgres and no Redis (dimension A grepped `~/quotation-system`,
   `~/Documents/TCL/server`, `/Users/innovera/Claude/Projects/POS` — zero hits). The four
   `redis:7` containers on this machine are **stopped** and belong to juneflow.
5. **Fairness (R4) is not solved by Redis either.** BullMQ has priority and group-level rate
   limiting, but per-tenant deficit fairness in the claim would still be ours to build — and it is
   *harder* on Redis, where we cannot express it as a `WHERE` clause.

### 5.2 Recommendation

**Default: PostgreSQL. Ship M1 on `ocr_jobs` (§6) with no Redis anywhere in the stack.**

Design the code so this stays reversible: all queue access goes through one port on each side —
`OcrJobQueue` (TypeScript, in `src/application/ports/`) and `JobStore` (Python protocol class).
Nothing outside the infrastructure adapters knows the substrate. The payload/result contract of
§9 is transport-independent by construction.

### 5.3 The trigger conditions that would flip this

Adopt Redis only when **at least one** of these is *measured*, not anticipated:

| # | Trigger | Measurement | Then do |
|---|---|---|---|
| T1 | Claim contention: `pg_stat_activity` shows sustained lock waits on `ocr_jobs`, or p99 claim latency > 250 ms at target load | M2 load test | First: raise batch claim size and add the `tenant_inflight` counter table (§7.4). Only if that fails, revisit. |
| T2 | Postgres write amplification from progress updates measurably harms app query latency | `pg_stat_statements` | Move `progress_*` to an unlogged table or a Redis hash **used only for ephemeral progress** — the smallest possible Redis footprint, no jobs in Redis. |
| T3 | We need > 200 concurrent in-flight jobs, i.e. the vision branch turns every page into a network call (§16.2) | capacity plan | Per-page fan-out first (§8.3). Redis still not required. |
| T4 | We adopt a hard real-time streaming UI (live token-by-token extraction) | product decision | Redis pub/sub for the *stream only*; jobs stay in Postgres. |
| T5 | We add a second consumer language, or a third service, that needs the same queue | architecture | Reassess from scratch; a broker starts to earn its keep at 3+ consumers. |

Note that **T2 and T4 add Redis as a cache/bus, not as the job store.** That is the shape to
prefer if Redis ever arrives: jobs stay in Postgres where the transaction is.

---

## 6. The chosen architecture

### 6.1 Topology

```
┌──────────────────────────┐         ┌───────────────────────────────┐
│  ocr-web  (Node 24)      │         │  ocr-worker  (Python 3.12)    │
│  Next 16 · Prisma 7      │         │  psycopg 3.3.5 · pydantic 2   │
│                          │         │                               │
│  role: ocr_app           │         │  role: ocr_worker             │
│  ─ INSERT ocr_jobs       │         │  ─ claim / heartbeat / finish │
│  ─ SELECT ocr_jobs       │         │  ─ INSERT ocr_page_results    │
│  ─ UPDATE abort_requested│         │  ─ INSERT ocr_job_events      │
│  ─ full app schema       │         │  ─ nothing else. no users,    │
│                          │         │    tenants, api_keys, docs    │
└───────────┬──────────────┘         └────────────┬──────────────────┘
            │                                     │
            │      ┌───────────────────────┐      │
            └──────┤  PostgreSQL 17        ├──────┘
                   │  ocr_jobs             │
                   │  ocr_page_results     │  NOTIFY ocr_jobs_v1
                   │  ocr_job_events       │  NOTIFY ocr_abort_v1
                   │  ai_calls             │
                   │  outbox_events        │  (domain events only)
                   │  idempotency_records  │  (HTTP idempotency only)
                   └───────────────────────┘
                              │
                   ┌──────────┴────────────┐
                   │  Object storage       │
                   │  orig/  (worker: R)   │
                   │  deriv/ (worker: RW)  │
                   │  result/(worker: RW)  │
                   └───────────────────────┘
```

No Redis. No broker. No shim service. Two processes, one database, one object store.

### 6.2 `ocr_jobs` — Prisma model

```prisma
enum OcrJobState  { PENDING RUNNING SUCCEEDED FAILED CANCELLED DEAD }
enum OcrJobKind   { DOCUMENT_EXTRACT AI_EXTRACT }

model OcrJob {
  id              String       @id @db.Uuid
  tenantId        String       @map("tenant_id")   @db.Uuid
  documentId      String       @map("document_id") @db.Uuid
  kind            OcrJobKind
  schemaVersion   Int          @default(1) @map("schema_version")
  payload         Json         @db.JsonB

  state           OcrJobState  @default(PENDING)
  priority        Int          @default(100)              // higher runs sooner
  dedupeKey       String       @map("dedupe_key") @db.VarChar(200)
  availableAt     DateTime     @default(now()) @map("available_at")  @db.Timestamptz(3)

  // lease / fencing
  leaseToken      String?      @map("lease_token")      @db.Uuid
  leaseExpiresAt  DateTime?    @map("lease_expires_at") @db.Timestamptz(3)
  workerId        String?      @map("worker_id")        @db.VarChar(120)

  // retry
  attempts        Int          @default(0)
  maxAttempts     Int          @default(4) @map("max_attempts")

  // budget  (corrected in review — decision L28)
  budgetMs        Int          @map("budget_ms")
  deadlineAt      DateTime?    @map("deadline_at")     @db.Timestamptz(3)  // NULL until first claim
  queueExpiresAt  DateTime     @map("queue_expires_at") @db.Timestamptz(3) // queue-wait TTL, separate

  // control
  abortRequested  Boolean      @default(false) @map("abort_requested")
  abortReason     String?      @map("abort_reason") @db.VarChar(40)

  // progress
  progressStage   String?      @map("progress_stage") @db.VarChar(60)
  progressPct     Int          @default(0) @map("progress_pct")
  estPages        Int          @default(1) @map("est_pages")   // added in review — see §14.2
  pagesTotal      Int?         @map("pages_total")             // NULL until the worker opens the doc
  pagesDone       Int          @default(0) @map("pages_done")  // progress display only, NOT a resume pointer (§8.2)

  // outcome
  result          Json?        @db.JsonB          // OcrJobResultV1, <= 64 KiB (CHECK)
  resultUri       String?      @map("result_uri") @db.VarChar(500)
  degraded        Boolean      @default(false)
  lastErrorCode   String?      @map("last_error_code")   @db.VarChar(80)
  lastErrorDetail Json?        @map("last_error_detail") @db.JsonB   // allow-listed keys only
  lastErrorAt     DateTime?    @map("last_error_at") @db.Timestamptz(3)

  startedAt       DateTime?    @map("started_at")  @db.Timestamptz(3)
  finishedAt      DateTime?    @map("finished_at") @db.Timestamptz(3)
  createdAt       DateTime     @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt       DateTime     @updatedAt      @map("updated_at") @db.Timestamptz(3)

  @@unique([dedupeKey], map: "ocr_jobs_dedupe_key_key")
  @@unique([id, tenantId], map: "ocr_jobs_id_org_key")   // added in review — dimension G's composite-FK anchor
  @@index([documentId],           map: "ocr_jobs_document_idx")
  @@index([tenantId, state],      map: "ocr_jobs_tenant_state_idx")
  @@map("ocr_jobs")
}
```

> **Naming (decision L23).** Every `tenantId` / `tenant_id` above is to be read as
> `organizationId` / `organization_id` in the shipped schema, and the table as `extraction_jobs`
> (decision L22). The old names are retained in this document's SQL only so the review diff stays
> readable; the M1 migration must not contain the word `tenant`.
>
> **`dedupeKey` uniqueness is deliberately partial, not total** — see the correction in §10.2. A
> total `@@unique` makes a legitimate reprocess after a `FAILED` job impossible.

Raw SQL that Prisma cannot express (goes in the migration by hand, the way jawbong does with its
`outbox_attempts_nonnegative` CHECK):

```sql
ALTER TABLE ocr_jobs
  ADD CONSTRAINT ocr_jobs_attempts_nonnegative CHECK (attempts >= 0),
  ADD CONSTRAINT ocr_jobs_progress_range       CHECK (progress_pct BETWEEN 0 AND 100),
  -- The queue table must stay small and fast. Full NormalizedDocument goes to object storage.
  ADD CONSTRAINT ocr_jobs_result_small
      CHECK (result IS NULL OR pg_column_size(result) <= 65536),
  -- A RUNNING row must be fenced; a non-RUNNING row must not hold a lease.
  ADD CONSTRAINT ocr_jobs_lease_consistent CHECK (
        (state = 'RUNNING'  AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
     OR (state <> 'RUNNING' AND lease_token IS NULL     AND lease_expires_at IS NULL)),
  -- A deadline exists exactly when the job has been claimed at least once (decision L28).
  ADD CONSTRAINT ocr_jobs_deadline_after_start CHECK (
        (started_at IS NULL AND deadline_at IS NULL)
     OR (started_at IS NOT NULL AND deadline_at IS NOT NULL));
```

> ### ⚠ Defect found in review — the draft's `ocr_jobs_no_abort_before_run` CHECK **wedges the reaper**
>
> The draft carried a fifth constraint:
>
> ```sql
> ADD CONSTRAINT ocr_jobs_no_abort_before_run CHECK (
>       NOT (state = 'PENDING' AND abort_requested = true));   -- REMOVED
> ```
>
> It is not a harmless guard. Trace it:
>
> 1. A job is `RUNNING` and a user cancels → `abort_requested = true` (§12.3).
> 2. Before the worker reaches its next page boundary, the worker is OOM-killed. The lease expires.
> 3. The reaper (§6.3 statement 5) runs `UPDATE … SET state = 'PENDING' … WHERE state='RUNNING' AND
>    lease_expires_at < now()`. That row now has `state='PENDING' AND abort_requested=true` →
>    **constraint violation**.
> 4. The reaper is **one set-based statement over every expired row**. A single violating row aborts
>    the whole statement and rolls back the entire batch. Every crashed job on the platform stops
>    being reaped, permanently, until a human notices. The `RUNNING` rows are also un-claimable
>    (§6.3 statement 1 only takes `PENDING`), so the queue silently bleeds capacity.
> 5. The same violation fires on the ordinary retry path: statement 4b's `ELSE 'PENDING'` branch on
>    any *retryable* error for a job that also happens to have been cancelled.
>
> This is a schema-level, self-inflicted, platform-wide stall, and it was invisible in the draft
> because §6 and §12 were written as separate sections and never traced together.
>
> **Fix — two parts, both required.**
>
> ```sql
> -- (1) The constraint is replaced by one that is actually true of every reachable state:
> --     an abort may only be REQUESTED on a RUNNING job, but it may SURVIVE a transition.
> ALTER TABLE ocr_jobs
>   ADD CONSTRAINT ocr_jobs_abort_terminal_consistent CHECK (
>         NOT (abort_requested = true AND state IN ('SUCCEEDED', 'DEAD')));
>
> -- (2) Every transition OUT of RUNNING clears the flag, so an aborted-then-crashed job comes back
> --     as a clean PENDING row. The cancel is re-issued by the app if the user still wants it;
> --     losing a cancel is a latency bug, keeping a stale one is a correctness bug.
> --     This clause is added to statement 4b and to the reaper below.
> --         abort_requested = false, abort_reason = NULL
> ```
>
> **Why "re-issue" rather than "carry the abort through the retry":** carrying it forward means a
> `PENDING` job silently self-cancels on its next claim, which no operator watching the DLQ would
> predict. Clearing it makes the state machine total: `abort_requested` is only ever true on a
> `RUNNING` row, which is the only row that can act on it. The app's cancel endpoint is idempotent
> (§12.3) and the UI keeps showing "cancelling…" until the job reaches a terminal state, so a
> re-issue is one extra `UPDATE`, not a user-visible regression.

```sql
CREATE INDEX ocr_jobs_claim_idx
  ON ocr_jobs (priority DESC, available_at ASC)
  WHERE state = 'PENDING';

-- Added in review. The claim's per-tenant cap (§6.3) must skip over a dominant tenant's backlog;
-- without tenant_id leading, that skip is a scan of the whole PENDING partial index (§7.5).
CREATE INDEX ocr_jobs_claim_by_tenant_idx
  ON ocr_jobs (tenant_id, priority DESC, available_at ASC)
  WHERE state = 'PENDING';

CREATE INDEX ocr_jobs_lease_idx
  ON ocr_jobs (lease_expires_at)
  WHERE state = 'RUNNING';

CREATE INDEX ocr_jobs_dead_idx
  ON ocr_jobs (finished_at DESC)
  WHERE state = 'DEAD';

-- Added in review. Enqueue-time dedupe must not block a legitimate reprocess (§10.2).
CREATE UNIQUE INDEX ocr_jobs_dedupe_live_idx
  ON ocr_jobs (dedupe_key)
  WHERE state IN ('PENDING', 'RUNNING');
```

Rationale for the partial indexes: at steady state, most rows are `SUCCEEDED`. A partial index
on `state = 'PENDING'` is tiny (the actual backlog) regardless of how many million completed rows
exist, so the claim query cost is independent of history. This is the one indexing decision that
determines whether the queue still works at year two.

**Caveat on `pg_column_size` in a CHECK** *(added in review)*: `pg_column_size` reports the size of
the datum as PostgreSQL would store it, which for a `jsonb` value large enough to TOAST is the
*compressed* size. The 64 KiB ceiling is therefore a **storage** bound, not a bound on the JSON
text length, and a highly repetitive result could squeeze past it. If the intent is "the result
summary is small", assert on `length(result::text) <= 65536` instead, or assert both. Prefer both:
the storage bound protects the table, the text bound protects the API response.

### 6.3 The protocol statements

**Renamed in review — there were never four.** The draft's heading said "four" while listing five
(claim, heartbeat, progress, complete-ok, complete-err, reaper = six), and the review adds a
seventh, statement **4c** (§12.4), because the state machine could not otherwise reach `CANCELLED`.
The accurate count is **seven statements in three passes of the reaper**, and the claim to make is
not that they are few but that they are *closed*: every state transition in §12.4's diagram is
exactly one of them, and each is lease-guarded or set-based-idempotent.

| # | Statement | Guard | Where |
|---|---|---|---|
| 1 | Claim | `SKIP LOCKED`, single atomic `UPDATE … RETURNING` | below |
| 2 | Heartbeat / lease renewal | `lease_token` | below |
| 3 | Progress | `lease_token` | below |
| 4a | Complete — success | `lease_token` | below |
| 4b | Complete — failure | `lease_token` | below |
| **4c** | **Complete — cancelled** | `lease_token` | **§12.4 (added in review)** |
| 5 | Reaper (3 passes: expired lease, exhausted budget, queue TTL) | set-based, idempotent, **must never throw** | below |

Everything else is application code.

**(1) Claim** — one atomic statement, no TOCTOU window (the krs-pos lesson), with the per-tenant
in-flight cap folded in (the R4 requirement).

```sql
-- $1 worker_id  $2 max_inflight_per_tenant  $3 lease_token(uuid)  $4 lease_seconds
WITH inflight AS (
  SELECT tenant_id, count(*) AS n
    FROM ocr_jobs
   WHERE state = 'RUNNING'
   GROUP BY tenant_id
),
candidate AS (
  SELECT j.id
    FROM ocr_jobs j
    LEFT JOIN inflight i ON i.tenant_id = j.tenant_id
   WHERE j.state = 'PENDING'
     AND j.available_at <= now()
     AND COALESCE(i.n, 0) < $2
   ORDER BY j.priority DESC, j.available_at ASC
   LIMIT 1
   FOR UPDATE OF j SKIP LOCKED
)
UPDATE ocr_jobs j
   SET state            = 'RUNNING',
       attempts         = j.attempts + 1,
       lease_token      = $3::uuid,
       lease_expires_at = now() + make_interval(secs => $4),
       worker_id        = $1,
       started_at       = COALESCE(j.started_at, now()),
       -- Decision L28: the budget clock starts at EACH claim, never at enqueue.
       -- Per-attempt, not per-job: a retry after a crash at page 190 must get enough time to
       -- finish the remaining 10 pages, and page checkpointing (§8) makes that cheap.
       -- Total wall time is therefore bounded by max_attempts x budget_ms, which is explicit,
       -- and by queue_expires_at, which is what the customer actually experiences.
       deadline_at      = now() + make_interval(secs => j.budget_ms / 1000.0),
       updated_at       = now()
  FROM candidate c
 WHERE j.id = c.id
RETURNING j.id, j.tenant_id, j.document_id, j.kind, j.schema_version, j.payload,
          j.attempts, j.max_attempts, j.lease_token, j.deadline_at, j.pages_done;
```

> ### Correction — the in-flight cap is *statistical*, not "by construction"
>
> The draft claimed this statement *"makes R4 hold by construction rather than by tuning."* **It
> does not, and the overstatement matters because R4 is backed by a real production incident.**
>
> Under `READ COMMITTED`, each claim statement takes its own snapshot at statement start. Two
> workers claiming *concurrently* each compute `inflight` without seeing the other's uncommitted
> `RUNNING` row. With N workers claiming in the same instant and a cap of 2, up to **N** jobs from
> one organisation can be admitted. `SKIP LOCKED` prevents *double-claiming a row*; it does not
> serialise an aggregate computed over other rows.
>
> The breach is **self-correcting** — the next claim after those commits sees the true count — so
> the steady-state property is "in-flight per organisation ≈ cap, with transient overshoot bounded
> by the number of simultaneously-claiming workers." At the §14.3 sizing (4 replicas × concurrency
> 1) the worst case is 4 instead of 2, which does not starve anyone. **State it that way, and test
> it that way**: R4's acceptance test must assert *"every 1-page job starts within 60 s"*
> (an outcome), not *"in-flight never exceeds 2"* (an invariant that is false).
>
> If a hard invariant is ever required, the mechanism is the `ocr_tenant_inflight` counter table of
> §7.4 with an `UPDATE … RETURNING` that takes a row lock on the counter *before* the claim — which
> serialises all claims for one organisation and is precisely the contention we are avoiding today.

> **Also returned by the claim (decision L26):** the claim RPC — not this raw statement — additionally
> mints and returns a **short-lived, organisation-and-document-scoped object-storage credential**
> for this job. It is not stored in the row, it is not in the payload, and it expires with the
> lease. See §11.3.

> **UNVERIFIED — must be tested against a real PostgreSQL 17 before implementation.**
> `FOR UPDATE OF j` inside a CTE that `LEFT JOIN`s an aggregating CTE is legal in principle (the
> lock targets only the non-nullable side, and `inflight` is a separate query level), but I could
> not execute it in this session. Two fallbacks, in order of preference:
> **(a)** replace the join with a correlated subquery in the `WHERE`:
> `AND (SELECT count(*) FROM ocr_jobs r WHERE r.state='RUNNING' AND r.tenant_id = j.tenant_id) < $2`
> — always legal, costs one index probe per candidate row, acceptable at our volumes;
> **(b)** materialise the counts into a `tenant_inflight` counter table maintained by triggers
> (§7.4) — the scaling answer, and the right shape if T1 ever fires.
> The M1 acceptance test for R4 must run against whichever form ships.

**(2) Heartbeat / lease renewal** — every 30 s from a background task, lease-guarded, and it is
also how the worker learns about aborts and its deadline.

```sql
-- $1 job_id  $2 lease_token  $3 lease_seconds
UPDATE ocr_jobs
   SET lease_expires_at = now() + make_interval(secs => $3),
       updated_at       = now()
 WHERE id = $1 AND lease_token = $2::uuid AND state = 'RUNNING'
RETURNING abort_requested, abort_reason, deadline_at;
```

**If this returns zero rows, the worker has lost the lease and MUST stop immediately** — no
further writes, no result, no completion. This is the fencing property. It converts the
jawbong bug of §2.2(2) into an impossibility.

**(3) Progress** — cheap, per page, also lease-guarded.

```sql
UPDATE ocr_jobs
   SET pages_done     = $3,
       pages_total    = COALESCE($4, pages_total),
       progress_stage = $5,
       progress_pct   = LEAST(100, GREATEST(0, $6)),
       updated_at     = now()
 WHERE id = $1 AND lease_token = $2::uuid AND state = 'RUNNING';
```

**(4a) Complete — success**

```sql
UPDATE ocr_jobs
   SET state = 'SUCCEEDED', result = $3::jsonb, result_uri = $4, degraded = $5,
       progress_pct = 100, progress_stage = 'done',
       lease_token = NULL, lease_expires_at = NULL,
       finished_at = now(), updated_at = now()
 WHERE id = $1 AND lease_token = $2::uuid AND state = 'RUNNING'
RETURNING id;
```

**(4b) Complete — failure, with retry classification**

```sql
-- $3 error_code  $4 error_detail(jsonb, allow-listed)  $5 retryable(bool)  $6 backoff_seconds
-- $7 effective_max_attempts  (decision L29 — see below)
UPDATE ocr_jobs
   SET state = CASE
                 WHEN NOT $5                     THEN 'FAILED'::"OcrJobState"
                 WHEN attempts >= LEAST(max_attempts, $7) THEN 'DEAD'::"OcrJobState"
                 ELSE                                 'PENDING'::"OcrJobState"
               END,
       available_at = CASE WHEN $5 AND attempts < LEAST(max_attempts, $7)
                           THEN now() + make_interval(secs => $6)
                           ELSE available_at END,
       lease_token = NULL, lease_expires_at = NULL,
       -- Added in review: leaving RUNNING always clears the abort flag (see the CHECK defect above).
       abort_requested = false, abort_reason = NULL,
       last_error_code = $3, last_error_detail = $4::jsonb, last_error_at = now(),
       finished_at = CASE WHEN $5 AND attempts < LEAST(max_attempts, $7) THEN NULL ELSE now() END,
       updated_at = now()
 WHERE id = $1 AND lease_token = $2::uuid AND state = 'RUNNING'
RETURNING state;
```

> **`$7` closes a hole the draft left open (decision L29).** §9.6 specifies *different* attempt
> budgets per error class — 6 for infrastructure, 4 for engine/compute, 1 for content and contract
> errors. The draft gave that table and then provided **no mechanism to implement it**: `attempts >=
> max_attempts` reads a single app-owned column, and §11.2 correctly denies the worker `UPDATE` on
> `max_attempts`. So every class would in fact have got 4.
>
> The worker knows the class (it just classified the error), so the worker supplies the budget as a
> bind parameter. `LEAST(max_attempts, $7)` keeps the app's column as a **ceiling the worker cannot
> raise** — a compromised worker can shorten its own retries (harmless) but cannot turn a job into
> an infinite retry loop (a billing and capacity attack). The class→budget map is a **constant in
> `contracts/error-codes.json`**, so both sides read the same numbers:
>
> ```json
> { "code": "AI_GATEWAY_UNAVAILABLE", "retryable": true, "maxAttempts": 6, … }
> ```
>
> `maxAttempts` becomes a required field of every row in that file, and gate 2 of §9.7 asserts every
> code has one.

Note that `FAILED` (terminal, non-retryable — e.g. a password-protected PDF) and `DEAD`
(exhausted retries — e.g. the gateway was down four times) are deliberately different states.
`FAILED` is a *user* problem shown in the UI with an actionable message; `DEAD` is an *operator*
problem that belongs on the DLQ dashboard. Conflating them is how DLQs fill with noise nobody reads.

**(5) The reaper** — one statement, run by every worker every 30 s (idempotent, races are harmless
because `SKIP LOCKED` and the `state='RUNNING'` predicate make it safe).

```sql
UPDATE ocr_jobs
   SET state = CASE WHEN attempts >= max_attempts THEN 'DEAD'::"OcrJobState"
                                                  ELSE 'PENDING'::"OcrJobState" END,
       lease_token = NULL, lease_expires_at = NULL, worker_id = NULL,
       -- Added in review: FULL JITTER. The draft's formula was deterministic, which is
       -- decision L13's own complaint about jawbong, reintroduced in the one place where
       -- a thundering herd is guaranteed: a node dies holding N leases, and without jitter
       -- all N wake in the same millisecond and re-stampede the same claim index.
       available_at = now() + make_interval(
           secs => random() * LEAST(300, power(2, LEAST(attempts, 10)))),
       -- Added in review: see the CHECK defect above. Without this the statement THROWS
       -- on any aborted job, rolling back the reaping of every other expired job.
       abort_requested = false, abort_reason = NULL,
       last_error_code = 'LEASE_EXPIRED', last_error_at = now(),
       finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END,
       updated_at = now()
 WHERE state = 'RUNNING'
   AND lease_expires_at < now()
RETURNING id, tenant_id, attempts;

-- second pass: processing budget exhausted while running.
-- deadline_at is NULL until first claim (L28), so this can never fire on a queued job.
UPDATE ocr_jobs
   SET state = 'FAILED', lease_token = NULL, lease_expires_at = NULL,
       abort_requested = false, abort_reason = NULL,
       last_error_code = 'BUDGET_EXCEEDED', last_error_at = now(),
       finished_at = now(), updated_at = now()
 WHERE state = 'RUNNING' AND deadline_at IS NOT NULL
   AND deadline_at < now() - interval '60 seconds';

-- third pass, added in review (L28/R21): queue-wait TTL. A job that has waited longer than
-- its organisation's queue TTL is FAILED with a DIFFERENT, honest code — it never started,
-- so calling it BUDGET_EXCEEDED would lie to the customer and to capacity planning.
UPDATE ocr_jobs
   SET state = 'FAILED', last_error_code = 'QUEUE_WAIT_EXCEEDED',
       last_error_at = now(), finished_at = now(), updated_at = now()
 WHERE state = 'PENDING' AND queue_expires_at < now();
```

> **Reaper safety, restated after the fixes.** The reaper is one statement per pass, run by every
> worker every 30 s. It is idempotent (a row already moved out of `RUNNING` no longer matches) and
> races are harmless. **It must never be able to raise an exception on a data condition** — that is
> the lesson of the CHECK defect above, and it is why all three passes now clear `abort_requested`
> and why pass 2 guards `deadline_at IS NOT NULL`. Add a soak assertion: run the reaper against a
> table seeded with one row in every reachable state combination and assert it completes.

> **Clock authority** *(added in review; the draft never said)*: **every timestamp in the lease,
> backoff, deadline and TTL machinery is produced by `now()` inside PostgreSQL.** The worker's own
> wall clock is never authoritative and is never compared against a stored timestamp. §13.2's
> "before each page, check the deadline" is implemented against the `deadline_at` value **returned
> by the last heartbeat**, converted to a monotonic local budget (`time.monotonic()` delta), not
> against `datetime.now()`. This makes the design immune to container clock skew, to NTP steps, and
> to the Asia/Bangkok (UTC+7) offset entirely.

### 6.4 Wake-up and abort notification

```sql
CREATE FUNCTION ocr_notify_job_ready_v1() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('ocr_jobs_v1',
    json_build_object('jobId', NEW.id, 'tenantId', NEW.tenant_id,
                      'priority', NEW.priority)::text);
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER ocr_jobs_notify_ready_v1
  AFTER INSERT ON ocr_jobs FOR EACH ROW
  WHEN (NEW.state = 'PENDING')
  EXECUTE PROCEDURE ocr_notify_job_ready_v1();

CREATE FUNCTION ocr_notify_abort_v1() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('ocr_abort_v1',
    json_build_object('jobId', NEW.id, 'reason', NEW.abort_reason)::text);
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER ocr_jobs_notify_abort_v1
  AFTER UPDATE OF abort_requested ON ocr_jobs FOR EACH ROW
  WHEN (OLD.abort_requested = false AND NEW.abort_requested = true
        AND NEW.state = 'RUNNING')
  EXECUTE PROCEDURE ocr_notify_abort_v1();
```

Both triggers are modelled directly on procrastinate's
`procrastinate_notify_queue_job_inserted_v1` / `procrastinate_notify_queue_abort_job_v1`, which I
read in its `schema.sql`. Borrowing a proven trigger shape without taking the dependency is the
right trade here.

Notification payloads are deliberately tiny (`NOTIFY` payloads are limited to 8000 bytes in the
default configuration — **verified in review** against
`https://www.postgresql.org/docs/17/sql-notify.html`: *"In the default configuration it must be
shorter than 8000 bytes"* — and a large payload would put document identifiers into every
listener's memory). **NOTIFY is an optimisation, never a correctness dependency:** workers also
poll every 2 s, so a dropped notification costs at most 2 s of latency, never a lost job. That
property is what makes it safe to run behind connection poolers, restarts, and network blips.

> ### Security note added in review — `LISTEN` has no permission model
>
> The same PostgreSQL page states: **_"Notifications are visible to all users."_** There is no
> `GRANT` for a notification channel. **Any role that can connect to this database can
> `LISTEN ocr_jobs_v1` and observe a live stream of `organizationId`s, job ids and arrival rates**
> — a real cross-tenant metadata side channel in a product sold on secure document handling, and
> the exact class of leak §8.1's decision L7 refuses to make elsewhere.
>
> The draft's payload was `{jobId, tenantId, priority}`. **Reduce it to a bare wake-up with no
> identifiers at all**, which costs nothing because the listener's only reaction is "run a claim":
>
> ```sql
> PERFORM pg_notify('ocr_jobs_v1', '');          -- wake-up only, zero information content
> ```
>
> The abort channel genuinely needs the job id, because a worker must match it against its own
> in-process registry. Two options, in order of preference:
> 1. **Notify per job**, on a channel named for the job — `pg_notify('ocr_abort_v1_' || NEW.id, '')`
>    — and have the worker `LISTEN` on that channel only for the duration of the job. An observer
>    must already know a job id to learn anything, so nothing is enumerable.
> 2. Keep one channel but send an **HMAC of the job id** under a server-side secret; only a worker
>    holding the secret can match it. Simpler to operate, weaker (an observer still learns the
>    cancel *rate*).
>
> Option 1 is chosen. The connection budget is unchanged: `LISTEN`/`UNLISTEN` on an existing
> dedicated connection is free, and the worker holds at most `OCR_WORKER_CONCURRENCY` of them.

**Pooler gotcha (important for deploy):** `LISTEN` does **not** work through PgBouncer in
transaction-pooling mode. The worker must open its listener on a **direct** Postgres connection.
Budget one extra connection per worker process. With 8 workers × (2 pool + 1 listen) = 24, plus
ocr-web's Prisma pool (10) and the migrate one-shot, we sit comfortably under the default
`max_connections = 100`.

### 6.5 The Python worker loop (shape)

```python
# ocr_worker/queue/store.py  —  psycopg 3.3.5, async
async def claim_one(conn, worker_id: str, max_inflight: int,
                    lease_s: int = 120) -> ClaimedJob | None: ...
async def heartbeat(conn, job_id: UUID, token: UUID,
                    lease_s: int = 120) -> HeartbeatResult | None: ...   # None => lease lost
async def report_progress(conn, job_id, token, *, pages_done, pages_total,
                          stage, pct) -> None: ...
async def finish_ok(conn, job_id, token, result: dict, result_uri: str,
                    degraded: bool) -> bool: ...
async def finish_err(conn, job_id, token, code: ErrorCode,
                     detail: dict, retryable: bool, backoff_s: int) -> bool: ...
async def reap(conn) -> list[UUID]: ...
```

```python
LEASE_S            = 120
HEARTBEAT_EVERY_S  = 30    # 4x margin: three consecutive misses before expiry
POLL_EVERY_S       = 2.0
REAP_EVERY_S       = 30

async def run_job(job: ClaimedJob) -> None:
    stop = asyncio.Event()                       # set when lease lost OR abort requested
    hb   = asyncio.create_task(heartbeat_loop(job, stop))
    try:
        await process_document(job, stop)        # checks stop.is_set() at every page boundary
    finally:
        stop.set()
        await hb
```

`heartbeat_loop` sets `stop` on **either** condition — lease lost (fencing) or
`abort_requested = true` (cancellation). One mechanism, two causes. The document loop only has to
check one flag, at one place: the page boundary.

> ### The heartbeat must not share an event loop with the OCR call *(hardened in review)*
>
> The draft deferred this to §17.2 as an "UNVERIFIED" and then wrote `await ocr_one_page(...)` as if
> it were non-blocking. It is not. `ocr_one_page` calls into ONNX Runtime and OpenCV. If it runs on
> the event loop thread, **the 30 s heartbeat cannot fire**, the 120 s lease expires, the reaper
> re-queues a job that is still running, and a second worker starts the same document — the exact
> double-processing the fencing token exists to make *safe* but which we should not be *causing*.
>
> ONNX Runtime and OpenCV release the GIL inside their native kernels, so a thread is *usually*
> enough — but "usually" is not a design. Pin it:
>
> ```python
> # ocr_worker/runtime.py
> _POOL = concurrent.futures.ProcessPoolExecutor(max_workers=1, mp_context=mp.get_context("spawn"))
>
> async def ocr_one_page(job, page_no, deadline_s: float):
>     loop = asyncio.get_running_loop()
>     return await asyncio.wait_for(
>         loop.run_in_executor(_POOL, _ocr_page_sync, job.id, page_no), timeout=deadline_s)
> ```
>
> A **process** pool, not a thread pool, for three reasons that all matter here:
> 1. the GIL question disappears entirely, so the heartbeat is guaranteed responsive;
> 2. `RLIMIT_AS` (§8.2) can be set on the child, so a `MemoryError` kills one page rather than the
>    worker — the guard the draft claimed but could not deliver from inside a thread;
> 3. a native-code segfault in a decoder on a hostile PDF kills the child, and the parent turns that
>    into a clean `PAGE_RENDER_FAILED` instead of losing the lease.
>
> Cost: one model load per child process. Mitigate with `max_workers=1` and a long-lived child
> recycled every `N` pages (`max_tasks_per_child`), not per page.
>
> **This converts §17.2's open question into a design decision.** The M1 soak test asserting
> `ocr_lease_lost_total == 0` over 60 minutes stays — it now verifies the fix rather than deciding it.

### 6.6 Table maintenance — the part that decides whether this works at year two (added in review)

The draft argued that partial indexes make the queue history-independent. That is true of **index
size** and false of **table bloat**, and the draft never mentioned vacuum. A queue table is the
worst-case workload for PostgreSQL's MVCC: §6.3 statement 3 writes a progress update **per page**,
so a single 200-page document creates 200 dead row versions of one row.

```sql
ALTER TABLE ocr_jobs SET (
  fillfactor                   = 70,    -- leave in-page room so progress updates stay HOT
  autovacuum_vacuum_scale_factor = 0.02,-- 2% instead of the 20% default
  autovacuum_vacuum_threshold    = 50,
  autovacuum_analyze_scale_factor= 0.02,
  autovacuum_vacuum_cost_delay   = 2    -- vacuum this table aggressively; it is small
);
ALTER TABLE ocr_page_results SET (fillfactor = 85, autovacuum_vacuum_scale_factor = 0.05);
```

**Why `fillfactor = 70` specifically.** A HOT update — one that avoids touching any index — is only
possible when the new row version fits on the *same* page. Progress updates change only
`pages_done`, `progress_pct`, `progress_stage`, `updated_at`, none of which are indexed, so they are
HOT-eligible; they become HOT-*actual* only if there is free space. 70 leaves room for roughly two
extra versions per row at our row width, and the page's HOT chain is pruned on the next access.

**What is *not* HOT, and therefore what actually costs:** the claim (writes `state`, indexed),
statement 4b (writes `state` and `available_at`, both indexed), and the reaper. Those are once or
twice per job, not per page. This is the reason §6.3 keeps progress in its own statement instead of
folding it into a larger update.

**Retention (R19, and Thailand's PDPA).** The draft set a 30-day retention for events and **no
retention at all for `ocr_jobs`**, whose `payload` carries `originalFilename` and storage keys —
personal data under PDPA once the filename is a person's name, which in a Thai document pipeline it
routinely is.

| Table | Hot retention | Then | Trigger |
|---|---|---|---|
| `ocr_jobs` (terminal rows) | 90 days | `payload` and `last_error_detail` **nulled**, row kept for accounting | nightly job |
| `ocr_jobs` (all) | 400 days | row deleted | nightly job |
| `job_events` | 90 days (dimension G's number, adopted over the draft's 30) | deleted | `at` index makes this a cheap range delete |
| `ocr_page_results` | follows the document | deleted with the document | `ON DELETE CASCADE` via the document FK |
| `ai_calls` | 400 days | `response_uri` object deleted, row kept (billing) | nightly job |
| **Organisation deletion** | **immediate** | hard delete across all five tables in one transaction | R19's acceptance test |

Deletes run in bounded batches (`DELETE … WHERE id IN (SELECT id … LIMIT 5000)`) so a retention
sweep never holds a long transaction against the claim path.

---

## 7. Priority and fairness

### 7.1 The incident we are designing against

From `a-…md` §5.4, quoting the krs-pos source verbatim:

> *"Held bills MUST NOT stay immediately eligible: the claim query is `ORDER BY createdAt ASC
> LIMIT 10`, so instantly-requeued held bills monopolize every batch and STARVE the clean bills
> behind them (16-07-26 incident: zero-discount sales never reached KRS because the 10 oldest held
> bills were re-claimed on every run)."*

This is not a hypothetical. The same query shape, in this codebase family, took down a production
integration. In OCR the equivalent is: **Tenant A uploads a 500-page contract bundle; Tenant B's
one-page receipt waits 40 minutes.** For a paid multi-tenant product that is a churn event.

### 7.2 Two mechanisms, both required

**(a) Hard per-tenant in-flight cap, evaluated inside the claim (§6.3 statement 1).**
`OCR_MAX_INFLIGHT_PER_TENANT`, default **2**. No matter how deep one tenant's backlog is, they can
never occupy more than 2 of N worker slots while another tenant has pending work. This is the
mechanism that makes R4 hold by construction rather than by tuning.

Refinement worth having in M1: make the cap *elastic* — allow a tenant to exceed it when nobody
else is waiting, so an idle cluster still drains a big backlog fast. **The draft's version of this
was wrong** and is corrected below.

```sql
-- DRAFT (rejected in review): binary, and it wastes the cluster.
AND ( COALESCE(i.n, 0) < $2
      OR NOT EXISTS (SELECT 1 FROM ocr_jobs o
                      WHERE o.state = 'PENDING'
                        AND o.available_at <= now()
                        AND o.tenant_id <> j.tenant_id) )
```

**Why it is wrong.** The escape hatch is all-or-nothing: the moment *any* other organisation has
*one* pending job, every organisation is clamped to the fixed cap of 2. With 8 worker slots and two
active organisations, **four slots sit idle** while both queues are deep. Fairness has been achieved
by throwing away half the capacity — and worse, the idle capacity is invisible: `ocr_queue_pending`
is high, workers are up, `ocr_jobs_claimed_total` is flat, and every §15.3 alert stays green.

**Corrected: a proportional (max-min) share.** The cap is a *fair share of live capacity*, not a
constant. Compute it once per claim from two counts the worker already has cheap access to:

```sql
-- $2 is no longer a constant. The claim RPC computes:
--   active_orgs      = number of organisations with >=1 PENDING-and-available or RUNNING job
--   total_slots      = replicas * OCR_WORKER_CONCURRENCY   (from config, not the DB)
--   effective_cap    = GREATEST( floor_cap, ceil(total_slots::numeric / GREATEST(active_orgs,1)) )
-- with floor_cap = 2 (never below; a single organisation must always make progress)
WITH pressure AS (
  SELECT count(DISTINCT tenant_id) AS active_orgs
    FROM ocr_jobs
   WHERE (state = 'PENDING' AND available_at <= now()) OR state = 'RUNNING'
),
inflight AS (
  SELECT tenant_id, count(*) AS n FROM ocr_jobs WHERE state = 'RUNNING' GROUP BY tenant_id
),
candidate AS (
  SELECT j.id
    FROM ocr_jobs j
    LEFT JOIN inflight i ON i.tenant_id = j.tenant_id
   CROSS JOIN pressure p
   WHERE j.state = 'PENDING'
     AND j.available_at <= now()
     AND COALESCE(i.n, 0) < GREATEST($2, ceil($3::numeric / GREATEST(p.active_orgs, 1)))
   ORDER BY j.priority DESC, j.available_at ASC
   LIMIT 1
   FOR UPDATE OF j SKIP LOCKED
)
…
```

Behaviour, which is the point:

| Active organisations | Total slots | Effective cap | Slots used |
|---|---|---|---|
| 1 | 8 | 8 | **8** — one org drains at full speed |
| 2 | 8 | 4 | **8** — both drain, evenly |
| 4 | 8 | 2 | **8** |
| 10 | 8 | 2 (floor) | 8, round-robin by priority/age |

`count(DISTINCT tenant_id)` over the `PENDING` partial index is the one added cost. At the queue
depths §14.2 tolerates (≤ 5 000 pending) it is a single index-only scan of a small index; measure it
in Q1's test alongside the claim itself, and if it shows up, cache `active_orgs` in the worker for
5 s — a stale share is a fairness wobble, never a correctness bug.

**(b) Priority, set at enqueue time.** Base priorities:

| Source | Base priority | Reason |
|---|---|---|
| Interactive single upload (a human is watching) | 200 | latency-sensitive |
| Interactive multi-file upload | 150 | |
| API submission | 100 | |
| Bulk/batch import | 50 | throughput-oriented |
| Reprocess / backfill | 10 | never competes with live traffic |
| Requeued from DLQ by an operator | 120 | should clear promptly, but not ahead of live users |

With **backlog decay** applied at enqueue, so a tenant dumping 500 documents progressively
de-prioritises their own tail rather than everyone else's head:

```ts
const pending = await tx.ocrJob.count({ where: { tenantId, state: "PENDING" } });
const priority = Math.max(1, basePriority - Math.min(80, Math.floor(pending / 5)));
```

Documented explicitly: **decay is a heuristic and is not the fairness guarantee.** The in-flight
cap (a) is the guarantee. If decay were removed, R4 would still hold.

### 7.3 Starvation of the *aged* is the opposite failure

A permanently low-priority job must still eventually run. Add an ageing sweep, every 5 minutes:

```sql
-- DRAFT (wrong):  AND available_at < now() - interval '10 minutes'
-- CORRECTED:      age is measured from created_at, never from available_at.
UPDATE ocr_jobs
   SET priority = LEAST(190, priority + 5), updated_at = now()
 WHERE state = 'PENDING'
   AND created_at < now() - interval '10 minutes'
   AND priority < 190;
```

**Two corrections, both found in review.**

1. **`available_at` is not age.** Every retry pushes `available_at` into the future (statement 4b).
   A job enqueued an hour ago that has failed twice has a *recent* `available_at`, so the draft's
   predicate would never fire for it — the sweep skipped exactly the jobs that had been waiting
   longest. `created_at` is immutable and is the only honest age. The same bug is in §14.2 and
   §15.1 and is fixed there.
2. **The ceiling is 190, not 200.** At 200 an aged backfill becomes indistinguishable from a live
   interactive upload (§7.2b's top priority), so after ~3 hours of backlog the priority scheme
   collapses to FIFO and the whole §7.2 table stops meaning anything. Capping ageing one band below
   the interactive tier keeps the invariant *"a human waiting always beats a machine waiting"*
   while still guaranteeing monotonic progress. A backfill at priority 10 reaches 190 in 180
   minutes; that is the documented worst-case starvation bound and it belongs in the SLO.

Bounded, cheap (hits only the `PENDING` partial index), and guarantees monotonic progress toward
the head.

**Interaction with backlog decay (§7.2b), which the draft did not analyse.** Decay subtracts up to
80 at enqueue; ageing adds 5 every 5 minutes. So a decayed interactive job (200 − 80 = 120) recovers
its full band in ~70 minutes, and a decayed backfill (50 − 40 = 10) needs 180. The two mechanisms do
not fight: decay orders a single organisation's own tail, ageing orders across time. **Neither
touches the in-flight cap, which remains the only fairness guarantee.**

### 7.4 The scaling path (only if T1 fires)

Replace the `inflight` CTE with a maintained counter:

```sql
CREATE TABLE ocr_tenant_inflight (
  tenant_id uuid PRIMARY KEY,
  running   int  NOT NULL DEFAULT 0 CHECK (running >= 0)
);
```
maintained by an `AFTER UPDATE OF state` trigger. Turns an aggregate into a single indexed lookup.
Deliberately **not** in M1: it adds a consistency invariant (the counter can drift) for a
performance problem we have not measured.

**Added in review:** if it is ever adopted, it must come with a **reconciler**, not just a trigger.
A counter maintained by a trigger drifts on exactly the paths this design has most of — a rolled-back
transaction is fine (the trigger rolls back too), but a `TRUNCATE`, a bulk migration, or a manual
`UPDATE` in an incident all bypass it. Ship `SELECT tenant_id, count(*) FROM ocr_jobs WHERE
state='RUNNING' GROUP BY 1` as a 60 s reconciliation that logs and corrects drift, and alert on any
non-zero correction. Without that, adopting §7.4 trades a measured performance problem for an
unmeasured correctness one.

### 7.5 The claim's scaling cliff (added in review)

The draft never analysed what the per-tenant cap costs the claim query. It is worth one paragraph
because it is the failure mode that will actually arrive first.

When one organisation is at its cap and holds the head of the priority order — the 500-page bulk
import, i.e. **the exact scenario §7.1 exists for** — the planner walks `ocr_jobs_claim_idx` in
`(priority DESC, available_at ASC)` order and rejects every one of that organisation's rows on the
cap predicate before it reaches another organisation's first row. With a 500-job backlog that is
~500 index tuples per claim: microseconds, irrelevant. With a 50 000-job backlog it is ~50 000
tuples **per claim, per worker, per poll**, and the claim latency that T1 watches for will blow out
precisely when the queue is deep.

The fix is already indexed for (`ocr_jobs_claim_by_tenant_idx`, §6.2): pick the best candidate
*per organisation* first, then order those, so the scan is bounded by the number of organisations
rather than the depth of the deepest queue.

```sql
candidate AS (
  SELECT j.id FROM (
    SELECT DISTINCT tenant_id FROM ocr_jobs
     WHERE state = 'PENDING' AND available_at <= now()
  ) t
  CROSS JOIN LATERAL (
    SELECT jj.id, jj.priority, jj.available_at, jj.tenant_id
      FROM ocr_jobs jj
     WHERE jj.state = 'PENDING' AND jj.available_at <= now()
       AND jj.tenant_id = t.tenant_id
     ORDER BY jj.priority DESC, jj.available_at ASC
     LIMIT 1                                   -- one candidate per organisation
  ) j
  LEFT JOIN inflight i ON i.tenant_id = j.tenant_id
  CROSS JOIN pressure p
 WHERE COALESCE(i.n, 0) < GREATEST($2, ceil($3::numeric / GREATEST(p.active_orgs, 1)))
 ORDER BY j.priority DESC, j.available_at ASC
 LIMIT 1
 FOR UPDATE OF j SKIP LOCKED
)
```

**Do not ship this in M1.** It is strictly more complex, and `FOR UPDATE OF j` where `j` is a
`LATERAL` subquery alias is *more* likely to hit a planner restriction than the simple form — which
is why Q1 (§17.1) must test **both** forms in the same throwaway container, and this one is written
out here so that test is cheap to write. Ship the simple form; keep this in the drawer with a
measured trigger (T1).

---

## 8. Page-level checkpointing and OOM survival

This section answers the brief's hardest question: *"how a job survives a worker OOM-kill
mid-200-page-document."*

### 8.1 `ocr_page_results` — a content-addressed checkpoint

```prisma
enum OcrPageState { IN_PROGRESS DONE POISON }

model OcrPageResult {
  id              String       @id @db.Uuid
  tenantId        String       @map("tenant_id") @db.Uuid
  documentSha256  String       @map("document_sha256") @db.Char(64)
  pageNo          Int          @map("page_no")
  pipelineVersion String       @map("pipeline_version") @db.VarChar(40)
  recipeHash      String       @map("recipe_hash")      @db.Char(64)
  engineId        String       @map("engine_id")        @db.VarChar(60)
  engineVersion   String       @map("engine_version")   @db.VarChar(40)

  state           OcrPageState @default(IN_PROGRESS)
  attempts        Int          @default(0)   // LIFETIME attempts — see the defect note below
  jobAttempts     Int          @default(0) @map("job_attempts")   // added in review: attempts within lastJobId
  poisonedAt      DateTime?    @map("poisoned_at") @db.Timestamptz(3)  // added in review
  route           String       @db.VarChar(16)          // native | ocr | skipped
  blocksUri       String?      @map("blocks_uri") @db.VarChar(500)  // per-page NormalizedDocument fragment
  charCount       Int?         @map("char_count")
  ocrScoreP10     Decimal?     @map("ocr_score_p10") @db.Decimal(5,4)
  ocrScoreMin     Decimal?     @map("ocr_score_min") @db.Decimal(5,4)
  durationMs      Int?         @map("duration_ms")
  failureCode     String?      @map("failure_code") @db.VarChar(80)

  lastJobId       String       @map("last_job_id") @db.Uuid
  createdAt       DateTime     @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt       DateTime     @updatedAt      @map("updated_at") @db.Timestamptz(3)

  @@unique([tenantId, documentSha256, pageNo, pipelineVersion,
            recipeHash, engineId, engineVersion], map: "ocr_page_result_key")
  @@index([lastJobId], map: "ocr_page_result_job_idx")
  @@map("ocr_page_results")
}
```

Three properties fall out of that unique key:

1. **Retry is cheap (R2).** A new attempt — even a brand-new job — finds every already-`DONE` page
   and skips it. Crash at page 190 of 200 costs 10 pages, not 190.
2. **Changing the recipe correctly invalidates the cache.** `recipeHash` comes from dimension F's
   ordered-op manifest and `pipelineVersion` from the code. Bump either and every page recomputes.
   No stale-result class of bug.
3. **Re-uploading an identical document is near-instant** — a genuine product feature that costs
   nothing extra.

> ### ⚠ Defect found in review — the draft's page attempts were **permanent**
>
> The draft's `attempts` column is keyed on `(org, sha256, page, pipelineVersion, recipeHash,
> engineId, engineVersion)` and nothing else — **no job scope, no time scope.** §8.2's loop reads it
> and poisons the page when it exceeds `MAX_PAGE_ATTEMPTS` (2). So:
>
> - Two transient `STORAGE_UNAVAILABLE` blips on page 47 (object store restarting, S3 5xx, a
>   network partition — all listed as `retryable: true` in §9.6, i.e. *expected*) burn both page
>   attempts.
> - Page 47 is now `POISON` for that `(org, sha, recipe, engine)` tuple **forever**.
> - The user resubmits the document. The cache-hit branch in §8.2 step (1) skips `POISON` pages, so
>   page 47 is **never retried again** — not by this job, not by any future job, not after the
>   outage is over. The customer gets a permanently degraded document and a `poisoned: [47]` gap
>   with no route to recovery except an engine-version bump.
>
> A *retryable infrastructure* error has been converted into a *permanent content* verdict. That is
> the opposite of §9.6's whole classification scheme, and it is worse for Thai documents
> specifically, where a page that needed a second attempt is often a dense or low-contrast scan —
> i.e. exactly the page the customer most needs.
>
> **Fix — three parts.**
>
> 1. **Poison on `job_attempts`, not lifetime `attempts`.** `job_attempts` resets whenever
>    `last_job_id` changes. Within one job a bad page still cannot eat the budget (R10 holds); a new
>    job gets a clean slate.
> 2. **Only *content* failures poison.** `upsert_page_in_progress` takes the previous failure's
>    class. `retryable: false` codes (`PDF_CORRUPT`, `PAGE_RENDER_FAILED` on a malformed page
>    object) count toward poison; `STORAGE_UNAVAILABLE`, `AI_GATEWAY_*` and `LEASE_EXPIRED`
>    **increment nothing** at the page level — they are job-level concerns and statement 4b already
>    handles them.
> 3. **`POISON` expires.** The cache-hit branch treats a `POISON` row as a hit only while
>    `poisoned_at > now() - interval '7 days'`. After that it is retried once. Seven days is chosen
>    to be longer than any plausible incident and shorter than a customer's patience.
>
> ```sql
> -- the corrected page claim, one statement, own transaction
> INSERT INTO ocr_page_results (id, tenant_id, document_sha256, page_no, pipeline_version,
>                               recipe_hash, engine_id, engine_version, state, attempts,
>                               job_attempts, last_job_id, route)
> VALUES (gen_random_uuid(), $1,$2,$3,$4,$5,$6,$7, 'IN_PROGRESS', 1, 1, $8, $9)
> ON CONFLICT ON CONSTRAINT ocr_page_result_key DO UPDATE
>    SET attempts     = ocr_page_results.attempts + 1,
>        job_attempts = CASE WHEN ocr_page_results.last_job_id = $8
>                            THEN ocr_page_results.job_attempts + 1 ELSE 1 END,
>        last_job_id  = $8,
>        state        = 'IN_PROGRESS',
>        poisoned_at  = NULL,
>        updated_at   = now()
> RETURNING job_attempts, attempts;
> ```
>
> Note `attempts` is retained as a **lifetime counter for observability only** — it is what tells
> you that page 47 of this contract template has needed three attempts across five uploads, which
> is a genuine engine-quality signal (`ocr_pages_poisoned_total` gains a `lifetime_attempts`
> histogram companion). It no longer drives control flow.

**Decision L7 — the cache is scoped to `tenantId`, deliberately.** A globally content-addressed
cache would let Tenant B upload a file and observe from the response time that Tenant A had
already processed the identical bytes. B already has the bytes, so no *content* leaks — but
"someone else on this platform has this exact document" is a real existence/timing side channel,
and for a product sold on security that is not a trade to make silently. Cross-tenant dedupe stays
available as a future decision with its own threat review; the unique key already has the shape to
support it (drop one column).

### 8.2 The page loop and the OOM story

```python
async def process_document(job, stop):
    doc = await load_manifest(job)              # page count + per-page route, from dimension E
    await report_progress(..., pages_total=doc.page_count, stage="rendering", pct=5)

    for page_no in range(1, doc.page_count + 1):
        if stop.is_set():
            raise Aborted(reason=stop_reason())

        # (1) cache hit -> skip, no work at all.
        #     Corrected in review: a POISON row is only a hit while it is fresh (7 days).
        cached = await get_page_result(key(job, page_no))
        if cached and (cached.state == "DONE"
                       or (cached.state == "POISON" and cached.poisoned_at > utcnow() - POISON_TTL)):
            continue

        # (2) claim the page BEFORE doing the work. Own transaction, committed immediately.
        #     This is what makes an OOM-kill visible on the next attempt.
        #     Corrected in review: poison on job-scoped attempts, not lifetime attempts.
        job_attempts, _lifetime = await upsert_page_in_progress(key(job, page_no), job.id)
        if job_attempts > MAX_PAGE_ATTEMPTS:         # default 2
            await mark_page_poison(key(job, page_no), code="PAGE_REPEATED_HARD_FAILURE")
            continue

        # (3) do the work
        result = await ocr_one_page(job, page_no, deadline=per_page_deadline())

        # (4) commit the page result; object writes already happened and are idempotent
        await mark_page_done(key(job, page_no), result)

        # (5) progress + implicit liveness
        await report_progress(..., pages_done=page_no,
                              stage="ocr", pct=5 + int(90 * page_no / doc.page_count))
```

**What happens on an OOM-kill at page 190.** The container receives SIGKILL: no `finally`, no
flush, no lease release.

1. `ocr_page_results` already holds `DONE` rows for pages 1–189 and one `IN_PROGRESS` row with
   `attempts = 1` for page 190. All committed.
2. The lease is not renewed. `lease_expires_at` passes at most 120 s later.
3. Any worker's reaper (§6.3 statement 5) flips the job to `PENDING` with jittered backoff and
   `last_error_code = 'LEASE_EXPIRED'`. **Detection window: ≤ 150 s.**
4. A worker re-claims (`attempts = 2`), skips 1–189 instantly, and re-enters page 190.
5. `upsert_page_in_progress` returns `job_attempts = 2`. Work is attempted once more.
6. If it OOMs again, the third claim sees `job_attempts = 3 > MAX_PAGE_ATTEMPTS`, marks the page
   `POISON`, and **the loop continues to page 191.** The job finishes `SUCCEEDED` with
   `degraded = true` and `result.pages.poisoned = [190]`. **A single pathological page cannot
   consume the job's entire retry budget** (R10). Because `PAGE_OOM` is classified as a *content*
   failure at page level (it is a property of that page's dimensions, not of the cluster), it
   legitimately counts toward poison — unlike `STORAGE_UNAVAILABLE`, which does not.

**One thing the draft's OOM story got wrong by omission: `pages_done` is not a resume pointer.**
Step 4 says the worker "skips 1–189 instantly" — it does that by *querying `ocr_page_results`*, not
by reading `ocr_jobs.pages_done`. That distinction is load-bearing: `pages_done` is a progress
*display* value written by an unfenced-in-spirit statement (§6.3 statement 3 is lease-guarded, but a
retry legitimately rewrites it downward and then upward again), whereas `ocr_page_results` is the
durable checkpoint. **Never resume from `pages_done`.** The M1 crash test must assert that a job
whose `pages_done` has been manually corrupted to `0` still skips the completed pages.

**Preventing the OOM in the first place** — three cheap guards, all inside our control:

| Guard | Setting | Effect |
|---|---|---|
| Container memory limit | `mem_limit: 3g` per worker in compose | Bounds blast radius; the kernel kills one worker, not the host |
| In-process soft limit | `resource.setrlimit(RLIMIT_AS, (2.5 GiB, hard))` at startup | Most allocations raise a **catchable** `MemoryError` before the kernel OOM-killer fires, so we get a clean `PAGE_OOM` code and a graceful page-level failure instead of a SIGKILL |
| Never hold the document | render page-by-page with `pypdfium2` (dimension E-E4); never `bitmap` more than one page at a time; explicitly `del` and drop numpy buffers between pages | Peak RSS is O(1) in page count, not O(n) |

Also: a page-size pre-check. At 600 dpi an A0 page is roughly 14 000 × 20 000 px ≈ 840 MB as
RGB. Refuse to render above `MAX_RENDER_PIXELS` (default 80 Mpx) — clamp DPI down and record a
warning. This turns the single most likely OOM cause into a graceful degradation.

### 8.3 If we later need per-page parallelism (the fan-out/fan-in barrier)

Not in M1 (decision L5), because a single worker looping pages is simpler, keeps ordering trivial,
and holds one lease. When the vision branch (§16.2) makes pages network-bound, fan-out becomes
worth it. This is the barrier — the thing BullMQ's `FlowProducer` gives for free:

```sql
-- Run by each page job on success. Atomic; the last one to finish wins exactly once.
-- Corrected in review: the draft named a table `ocr_documents` that exists in no dimension.
-- The counter lives on the PARENT JOB row, not on the document — the worker has no grant on
-- `documents` (§11.2) and must not acquire one just to fan in.
WITH bump AS (
  UPDATE ocr_jobs
     SET pages_done = pages_done + 1
   WHERE id = $7                                  -- the parent DOCUMENT_EXTRACT job
  RETURNING pages_done, pages_total, document_id
)
INSERT INTO ocr_jobs (id, tenant_id, document_id, kind, schema_version, payload,
                      priority, dedupe_key, budget_ms, deadline_at)
SELECT gen_random_uuid(), $2, $1, 'AI_EXTRACT', 1, $3::jsonb,
       $4, 'assemble:' || $1::text, $5, now() + make_interval(secs => $6)
  FROM bump WHERE pages_done = pages_total
ON CONFLICT (dedupe_key) DO NOTHING;
```

`pages_done = pages_done + 1` under a row lock means exactly one statement observes
`pages_done = pages_total`, and `ON CONFLICT (dedupe_key) DO NOTHING` makes even that idempotent
under at-least-once redelivery. Ten lines, one unique index. That is the honest measure of what
`FlowProducer` is worth to us — and note that as of `bullmq` **3.2.1** the Python client has
`FlowProducer` too, so this is a comparison against a feature we could actually have had (§4.2).

**Three corrections from review, because the draft's version would not have worked:**

1. **The dedupe key format is inconsistent with §10.2.** `'assemble:' || $1::text` is not the
   `sha256(...)` of §10.2, and it is not unique across `pipelineVersion` — a reprocess with a new
   recipe would collide with the old assemble job and be silently dropped by
   `ON CONFLICT DO NOTHING`. Use the same canonical function as everything else:
   `dedupe_key = sha256_canonical({kind:'AI_EXTRACT', orgId, documentId, pipelineVersion, recipeHash})`.
2. **The `INSERT` needs the worker to hold `INSERT` on `ocr_jobs`, which §11.2 does not grant.**
   Fan-out therefore cannot ship without either widening the worker's grant (bad — it could then
   enqueue unlimited work) or, better, exposing this as a **`SECURITY DEFINER` function**
   `ocr_fan_in_v1(parent_job_id uuid, lease_token uuid)` owned by `ocr_owner`, which validates the
   lease before inserting. Same shape as decision L27's outbox trigger. This is the *reason*
   fan-out is deferred, and the draft did not notice it.
3. **`pages_total` must be `NOT NULL` on the parent before any child completes**, or `pages_done =
   pages_total` is never true and the barrier never fires — a silent hang, not a crash. Assert it in
   the fan-out enqueue and add a reaper pass for parents whose children are all terminal but whose
   barrier never fired.

---

## 9. The Node ↔ Python contract

### 9.1 Governing rules

1. **One source of truth: Zod, in the Next repo.** The producer owns the schema.
2. **The wire format is JSONB in a Postgres column.** No serialisation library, no codegen at
   runtime, no schema registry service.
3. **Every message carries `schemaVersion` as a literal**, and the consumer rejects unknown
   versions with a *terminal* error — never a guess, never a best-effort parse.
4. **No secrets, no credentials, no pre-signed URLs, and no document content in the payload.**
   The payload is stored at rest in a queue table that operators and support staff can read.
5. **No raw exception text ever crosses the boundary into Postgres** (decision L21). A closed
   error-code enum plus an allow-listed detail object. Free-form text goes to structured logs,
   which have their own retention and access controls.

### 9.2 `OcrJobPayloadV1` — Zod (source of truth)

```ts
// contracts/src/ocr-job-payload.v1.ts   (ocr-web)
import { z } from "zod";                       // zod 4.4.3

export const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

export const ocrJobPayloadV1 = z.strictObject({
  schemaVersion: z.literal(1),
  jobId:         z.uuid(),
  kind:          z.enum(["DOCUMENT_EXTRACT", "AI_EXTRACT"]),
  tenantId:      z.uuid(),
  documentId:    z.uuid(),
  correlationId: z.uuid(),          // trace id; propagated to logs and to the AI gateway

  source: z.strictObject({
    bucket:           z.string().min(1).max(63),
    key:              z.string().min(1).max(1024),   // orig/{tenantId}/{documentId}/{sha256}
    sha256:           sha256Hex,
    sizeBytes:        z.number().int().positive().max(1_073_741_824),
    declaredMime:     z.string().max(255),           // client-declared; NOT trusted
    originalFilename: z.string().max(512),           // display only; never used as a path
  }),

  policy: z.strictObject({
    pipelineVersion:       z.string().max(40),       // e.g. "extract@1.4.0"
    engineProfile:         z.enum(["classical", "vlm", "auto"]),
    languages:             z.array(z.enum(["tha", "eng"])).min(1).max(4),
    renderDpi:             z.number().int().min(150).max(600),
    maxRenderPages:        z.number().int().min(1).max(2000),
    maxRenderPixels:       z.number().int().min(1_000_000).max(200_000_000),
    trustExistingOcrLayer: z.enum(["never", "if-clean", "always"]),
    preprocess:            z.strictObject({
      deskew:   z.boolean(),
      binarize: z.boolean(),
      clahe:    z.boolean(),
      recipeHash: sha256Hex,                          // dimension F's ordered-op hash
    }),
    ocrBudgetPages: z.number().int().min(0).max(2000),
    aiExtraction:   z.strictObject({
      enabled:       z.boolean(),
      promptVersion: z.string().max(40),
      schemaId:      z.string().max(80).nullable(),   // target extraction schema, if any
    }),
  }),

  budget: z.strictObject({
    globalMs:   z.number().int().min(30_000).max(3_600_000),
    perPageMs:  z.number().int().min(1_000).max(300_000),
    deadlineAt: z.iso.datetime({ offset: true }),
  }),
});

export type OcrJobPayloadV1 = z.infer<typeof ocrJobPayloadV1>;
```

> ### Correction found in review — `.max()` does not mean the same thing on both sides
>
> This is a cross-language contract, and the draft declared its string limits in a unit that
> differs between the two languages. It matters for Thai and it matters for R14.
>
> | | Zod 4 `z.string().max(n)` | Pydantic 2 `max_length=n` | PostgreSQL `VARCHAR(n)` |
> |---|---|---|---|
> | Counts | JavaScript `.length` = **UTF-16 code units** | **Unicode code points** | **characters (code points)** |
> | `"สวัสดีครับ"` (10 Thai chars) | 10 | 10 | 10 |
> | An emoji or any non-BMP char | **2** | 1 | 1 |
> | Bytes actually stored (UTF-8, Thai) | — | — | **30** |
>
> Thai is entirely in the BMP, so Thai *text* agrees across all three. **Filenames do not**: a Thai
> user naming a file `สัญญา📄.pdf` produces a string that Zod measures as one unit longer than
> Pydantic does. At the boundary that is a fixture that passes one validator and fails the other —
> exactly the silent divergence R14 exists to prevent, and the CI gates of §9.7 would catch it only
> if someone thought to put an emoji in a fixture.
>
> **Decision L30, applied:**
> - Every length bound that can carry user text is declared in **UTF-8 bytes** and enforced with a
>   shared refinement on both sides, not with the native `.max()`:
>   ```ts
>   const utf8Bytes = (n: number) => (s: string) =>
>     new TextEncoder().encode(s).length <= n;
>   originalFilename: z.string().refine(utf8Bytes(512), { message: "filename_too_long" }),
>   ```
>   ```python
>   @field_validator("original_filename")
>   @classmethod
>   def _len(cls, v: str) -> str:
>       if len(v.encode("utf-8")) > 512: raise ValueError("filename_too_long")
>       return v
>   ```
> - `originalFilename` at 512 **bytes** is ~170 Thai characters. That is deliberate and must be
>   surfaced in the UI's upload validation with a Thai-aware counter, not silently truncated —
>   truncating a UTF-8 string mid-sequence produces mojibake, and truncating a Thai string
>   mid-cluster orphans a tone mark onto the wrong consonant.
> - The **fixture corpus is mandatory**, not optional: NFC Thai, NFD Thai, a filename with an
>   emoji, a filename at exactly 512 bytes, and one at 513. R20's acceptance test is these five.
>
> Note also that the identifier fields (`bucket`, `key`) are ASCII by construction — the key is
> `{orgId}/{yyyy}/{mm}/{shard}/{documentId}/…` per dimension I — so **no Thai ever reaches an
> object-storage key or a path**. That was already true in the draft and it is the single most
> important Thai-safety property of this contract; §9.8 states it as an invariant with a test.

**Deliberate omissions, each for a reason:**

| Omitted | Why |
|---|---|
| A pre-signed source URL | It expires while the job is queued or retried. `{bucket, key}` plus the worker's own prefix-scoped credentials never expires (decision L9). |
| Any credential or token | The payload sits at rest in a table support staff read. |
| A callback URL | v1 has exactly one result path: DB + object storage. An HTTP callback is a second, lossy, SSRF-shaped path. |
| Document text or thumbnails | The queue table stays small; §6.2's `pg_column_size` CHECK enforces it on the result side. |
| Tenant name, user email, filename beyond display | Minimise PII in the queue. `originalFilename` is retained only because the UI needs it and it is already visible to the tenant. |

### 9.3 `OcrJobResultV1` — the ≤ 64 KiB summary

```ts
export const ocrJobResultV1 = z.strictObject({
  schemaVersion: z.literal(1),
  jobId:  z.uuid(),
  status: z.enum(["succeeded", "succeeded_degraded"]),

  document: z.strictObject({
    uri:      z.string().max(500),   // result/{tenantId}/{documentId}/{sha256}/{pipelineVersion}/doc.json
    sha256:   sha256Hex,             // of the NormalizedDocument JSON itself
    bytes:    z.number().int().nonnegative(),
    modelVersion: z.literal("NormalizedDocument@1.0"),   // dimension E's E16
  }),

  pages: z.strictObject({
    total: z.number().int().nonnegative(),
    native: z.number().int().nonnegative(),
    ocr:    z.number().int().nonnegative(),
    skipped:z.number().int().nonnegative(),
    poisoned: z.array(z.number().int().positive()).max(100),
  }),

  ocr: z.strictObject({
    engineId:      z.string().max(60),
    engineVersion: z.string().max(40),
    modelId:       z.string().max(120),
    scriptTag:     z.string().max(20),
    scoreP10:      z.number().min(0).max(1),    // dimension F D10: length-weighted p10
    scoreMin:      z.number().min(0).max(1),
  }).nullable(),                                 // null when every page was native

  ai: z.strictObject({
    used:          z.boolean(),
    gateway:       z.string().max(80).nullable(),
    model:         z.string().max(120).nullable(),
    promptVersion: z.string().max(40).nullable(),
    inputTokens:   z.number().int().nonnegative(),
    outputTokens:  z.number().int().nonnegative(),
    costMicros:    z.number().int().nonnegative(),
    calls:         z.number().int().nonnegative(),
  }).nullable(),

  timings: z.record(z.string().max(40), z.number().int().nonnegative()),  // stage -> ms
  warnings: z.array(z.strictObject({
    code:   z.string().max(80),
    pageNo: z.number().int().positive().nullable(),
  })).max(50),
});
```

Note that `ocr` and `ai` are separate objects with separate scores and are **never fused into a
single confidence number** — dimension F's D9, enforced by the type.

> ### Added in review — geometry is part of the contract (R16), and the draft never said so
>
> Dimension B §5.1 assigns this here explicitly: *"the model cannot see the layout, so multi-column
> and table reconstruction depends entirely on the OCR engine's geometry output. `ocr-worker` must
> therefore emit bounding boxes, not just a text blob — **a contract decision that must land in item
> I now**, because retrofitting geometry later is expensive."* Since the model is text-only (§1.4),
> geometry is not a nice-to-have: it is the **only** source of layout in the whole product, and it
> is also what redaction and field anchoring need.
>
> The ≤64 KiB result summary cannot carry it — a 200-page document's boxes are megabytes. So the
> contract is: **geometry lives in the per-page artifact, and the result asserts its presence and
> shape.** Add to `ocrJobResultV1`:
>
> ```ts
>   geometry: z.strictObject({
>     present:      z.boolean(),                       // false only if every page was `skipped`
>     granularity:  z.enum(["word", "line", "block"]), // engine-determined; dimension D owns it
>     coordinateSpace: z.literal("pdf-user-space@72dpi"),  // NOT pixels — render DPI varies per page
>     originCorner: z.literal("top-left"),
>     pagesWithGeometry: z.number().int().nonnegative(),
>   }),
> ```
>
> and to `OcrPageResult.blocksUri`, a stated schema for the fragment it points at:
>
> ```jsonc
> // deriv/{orgId}/…/p{page}.blocks.json    — one file per page, gzip, content-addressed
> { "schemaVersion": 1, "pageNo": 12, "width": 595.28, "height": 841.89,
>   "blocks": [ { "type": "line", "bbox": [72.0, 700.4, 523.1, 714.9],
>                 "text": "สัญญาจ้างทำของ", "conf": 0.93,
>                 "words": [ { "bbox": [...], "text": "สัญญา", "conf": 0.95 } ] } ] }
> ```
>
> **Two Thai-specific constraints on that fragment**, both of which will silently corrupt output if
> missed and neither of which was in the draft:
> 1. **`words` is not a safe unit for Thai.** Thai is written without spaces; what an engine calls a
>    "word" is a detector artefact, not a linguistic word. `granularity` must therefore be recorded
>    per result, downstream consumers must treat `line` as the only reliably meaningful unit for
>    Thai, and any word-level box must never be used to re-join text with an inserted space — that
>    is how `ค่าจ้าง` becomes `ค่า จ้าง`.
> 2. **Coordinates are in PDF user space, not render pixels.** The draft's `renderDpi` is per-job
>    and the DPI clamp of §8.2 can lower it *per page*, so a pixel box is meaningless without also
>    carrying the DPI it was captured at. Normalising to 72 dpi user space at the worker removes an
>    entire class of "the highlight is in the wrong place on some pages" bug.

**Storage key correction (dimension I).** `document.uri` in the draft was
`result/{tenantId}/{documentId}/{sha256}/{pipelineVersion}/doc.json`. Under dimension I's layout
the result object is
`{organizationId}/{yyyy}/{mm}/{shard}/{documentId}/result/{sha256}.{pipelineVersion}.json`, and the
`z.string().max(500)` bound must become **1024 UTF-8 bytes** to match I's own key rules
(*"S3 hard limit is 1024 UTF-8 bytes. We cap at 512 to leave headroom"* — so 512 is I's cap and
this field should assert exactly I's cap, imported from I's contract, not restated here).

### 9.4 Progress and audit events — `ocr_job_events`

```prisma
enum OcrJobEventType {
  CLAIMED STAGE_STARTED PAGE_DONE PAGE_FAILED PAGE_POISONED PROGRESS
  LEASE_LOST RETRY_SCHEDULED ABORT_REQUESTED ABORTED
  SUCCEEDED FAILED DEAD_LETTERED
}

model OcrJobEvent {
  seq       BigInt          @id @default(autoincrement())
  jobId     String          @map("job_id")    @db.Uuid
  tenantId  String          @map("tenant_id") @db.Uuid
  type      OcrJobEventType
  at        DateTime        @default(now()) @db.Timestamptz(3)
  stage     String?         @db.VarChar(60)
  pageNo    Int?            @map("page_no")
  workerId  String?         @map("worker_id") @db.VarChar(120)
  detail    Json?           @db.JsonB       // allow-listed keys only, <= 4 KiB

  @@index([jobId, seq],   map: "ocr_job_event_job_idx")
  @@index([at],           map: "ocr_job_event_at_idx")
  @@map("ocr_job_events")
}
```

**Write volume discipline.** One event per page across a busy platform is a lot of rows. The rule:
write an event on every **stage transition**, every **failure**, and every **10th page**; write the
`ocr_jobs.progress_*` columns on **every** page. The UI reads the columns; the audit trail reads
the events. Retention: 30 days (`at` index makes the delete cheap), except terminal-state events,
which follow the job's own retention.

`detail` is allow-listed and capped — this is the same rule as L21. `pg_column_size(detail) <= 4096`
as a CHECK.

### 9.5 UI progress delivery — **corrected in review to match dimension L**

The draft specified SSE as the M1 path. **Dimension L owns the API surface and its decision L-8 is
the opposite**: *"**Adaptive polling** on a batch-status endpoint; SSE only on the single-document
review screen, **flagged off in M1**."* L wins (decision L31). The query is unchanged; the transport
is not.

```ts
// app/api/v1/jobs/[id]/route.ts   — plain GET, adaptive client polling (L-8)
const row = await prisma.ocrJob.findFirst({
  where:  { id, organizationId },        // organisation scoping is mandatory, not optional
  select: { state: true, progressPct: true, progressStage: true,
            pagesDone: true, pagesTotal: true, degraded: true,
            lastErrorCode: true, updatedAt: true },
});
```

**Adaptive cadence** (the "adaptive" in L-8, which the draft's fixed 1 s did not have):

| Job state | Poll interval | Reason |
|---|---|---|
| `PENDING` | 5 s, backing off to 15 s after 2 min | nothing is changing; the user is queued |
| `RUNNING`, `pages_total ≤ 5` | 1 s | short job, a human is watching every page |
| `RUNNING`, `pages_total > 5` | `clamp(2 s, median_page_ms, 10 s)` | one poll per page, not per second |
| terminal | stop | — |
| tab hidden (`document.visibilityState`) | pause entirely | the single largest saving, and free |

The server returns `Cache-Control: no-store` and an `ETag`; a `304` costs one index probe and no
serialisation. **`Retry-After` on 429 is honoured by the client** — the poll loop is subject to the
same rate limiter as every other endpoint (dimension L's `rate-limiter-flexible`).

At 200 concurrent watchers on multi-page jobs this is well under 100 qps of the cheapest query
Postgres has — materially less than the draft's 200 qps of held SSE connections, and with no
connection pinning, no per-connection listener bookkeeping, and identical behaviour behind
PgBouncer.

**Public state mapping** (L's enum is `queued | processing | succeeded | failed | cancelled`):

| Internal | Public | Note |
|---|---|---|
| `PENDING` | `queued` | |
| `RUNNING` | `processing` | |
| `SUCCEEDED` (`degraded=false`) | `succeeded` | |
| `SUCCEEDED` (`degraded=true`) | `succeeded` + `warnings[]` | the gap list is in the body, not the state |
| `FAILED` | `failed` | `lastErrorCode` surfaced only when `userFacing: true` |
| **`DEAD`** | **`failed`** | **deliberately indistinguishable from outside.** `DEAD` is an operator word; telling a customer their document is "dead" after our gateway was down four times is both alarming and an internal-state leak |
| `CANCELLED` | `cancelled` | |

**Trigger to turn SSE on:** > 500 concurrent watchers on the review screen, or measured poll cost in
`pg_stat_statements` top 10. At that point the transport changes and this table does not.

### 9.6 Error contract

`contracts/error-codes.json`, consumed by both sides, one row per code. **Corrected in review:**
every row now carries `maxAttempts` (decision L29 — without it §9.6's per-class budget table had no
implementation), `pageLevel` (whether the code may count toward page poison — the §8.1 defect), and
`msgKey` (the i18n key; see the Thai note below). Two codes are added: `QUEUE_WAIT_EXCEEDED`
(§6.3 pass 3) and `PAGE_POISONED`.

```jsonc
// full shape of one row
{ "code": "AI_GATEWAY_UNAVAILABLE", "retryable": true, "userFacing": false,
  "http": 503, "maxAttempts": 6, "pageLevel": false, "msgKey": null }
```

```json
{ "code": "SOURCE_NOT_FOUND",        "retryable": false, "userFacing": true,  "http": 404 },
{ "code": "SOURCE_CHECKSUM_MISMATCH","retryable": false, "userFacing": true,  "http": 422 },
{ "code": "UNSUPPORTED_MIME",        "retryable": false, "userFacing": true,  "http": 415 },
{ "code": "PDF_PASSWORD_PROTECTED",  "retryable": false, "userFacing": true,  "http": 422 },
{ "code": "PDF_CORRUPT",             "retryable": false, "userFacing": true,  "http": 422 },
{ "code": "PAYLOAD_SCHEMA_INVALID",  "retryable": false, "userFacing": false, "http": 500 },
{ "code": "PAYLOAD_VERSION_UNKNOWN", "retryable": false, "userFacing": false, "http": 500 },
{ "code": "PAGE_OOM",                "retryable": true,  "userFacing": false, "http": 500 },
{ "code": "PAGE_RENDER_FAILED",      "retryable": true,  "userFacing": false, "http": 500 },
{ "code": "OCR_ENGINE_FAILED",       "retryable": true,  "userFacing": false, "http": 500 },
{ "code": "STORAGE_UNAVAILABLE",     "retryable": true,  "userFacing": false, "http": 503 },
{ "code": "AI_GATEWAY_UNAVAILABLE",  "retryable": true,  "userFacing": false, "http": 503 },
{ "code": "AI_GATEWAY_RATE_LIMITED", "retryable": true,  "userFacing": false, "http": 429 },
{ "code": "AI_RESPONSE_INVALID",     "retryable": true,  "userFacing": false, "http": 502 },
{ "code": "BUDGET_EXCEEDED",         "retryable": false, "userFacing": true,  "http": 504 },
{ "code": "LEASE_EXPIRED",           "retryable": true,  "userFacing": false, "http": 500 },
{ "code": "CANCELLED_BY_USER",       "retryable": false, "userFacing": true,  "http": 499 },
{ "code": "QUEUE_WAIT_EXCEEDED",     "retryable": false, "userFacing": true,  "http": 503 },
{ "code": "PAGE_POISONED",           "retryable": false, "userFacing": true,  "http": 422 }
```

> ### Thai blind spot found in review — a `userFacing` error code has no Thai message
>
> Seven of these codes are `userFacing: true` in a **Thai-primary** product, and the draft specified
> no path from a code to a Thai sentence. The failure mode is not hypothetical: the easiest
> implementation is for the API to return an English string alongside the code, and then the Thai UI
> shows English for exactly the moments a user is already frustrated.
>
> **Rule: the server never returns prose.** It returns `{ code, msgKey, params }`. The `th` and `en`
> catalogues live in the Next app and are the only place a sentence exists.
>
> ```jsonc
> { "code": "PDF_PASSWORD_PROTECTED", "userFacing": true, "msgKey": "err.pdf_password",
>   "params": ["fileName"] }
> ```
> ```jsonc
> // messages/th.json
> "err.pdf_password": "ไฟล์ {fileName} มีการตั้งรหัสผ่าน กรุณาปลดล็อกไฟล์แล้วอัปโหลดใหม่",
> // messages/en.json
> "err.pdf_password": "{fileName} is password-protected. Please unlock it and upload again."
> ```
>
> **CI gate 4 (new):** every code with `userFacing: true` has a `msgKey`, and every `msgKey` exists
> in **both** `th.json` and `en.json`. A missing Thai string fails the build. This is one line of
> test and it is the difference between a Thai product and an English product with a Thai font.
>
> Two further Thai-specific requirements on user-facing errors:
> - **`params` values are interpolated client-side, never concatenated server-side.** Thai has no
>   spaces at word boundaries, so a server-built `"Error: " + filename` produces a run-on that a
>   Thai reader parses wrongly. Only the catalogue knows where the particles go.
> - **`fileName` is rendered with `dir="auto"` and Unicode-isolated** (`⁨…⁩`). A filename
>   mixing Thai, Latin and an RTL script otherwise reorders the surrounding sentence — a spoofing
>   vector as well as a legibility one.

`retryable` drives §6.3 statement 4b directly. Retry budgets differ by class:

| Class | `maxAttempts` | Rationale |
|---|---|---|
| Content errors (`PDF_*`, `UNSUPPORTED_MIME`, `SOURCE_CHECKSUM_MISMATCH`) | effectively 1 — terminal on first failure | Retrying a corrupt PDF four times wastes 4× the compute to reach the same answer |
| Infrastructure (`STORAGE_*`, `AI_GATEWAY_*`, `LEASE_EXPIRED`) | **6** | These are transient by nature; a gateway restart should not dead-letter a day's work |
| Engine/compute (`PAGE_OOM`, `OCR_ENGINE_FAILED`, `PAGE_RENDER_FAILED`) | 4 job-level, **2 page-level** | Page-level cap is what stops one bad page eating the job |
| Contract (`PAYLOAD_*`) | 1, and page an operator | A schema mismatch means a deploy-order violation; retrying cannot fix it |

### 9.7 Schema governance and the drift guard (R14)

```
contracts/
  src/ocr-job-payload.v1.ts        # Zod, source of truth
  src/ocr-job-result.v1.ts
  src/error-codes.json
  generated/ocr-job-payload.v1.schema.json     # committed, generated
  generated/ocr-job-result.v1.schema.json      # committed, generated
  fixtures/payload.v1.valid.*.json             # golden, hand-written
  fixtures/payload.v1.invalid.*.json
```

```ts
// contracts/scripts/emit.ts   —  pnpm contracts:emit
import { z } from "zod";
import { ocrJobPayloadV1 } from "../src/ocr-job-payload.v1";
writeFileSync(
  "generated/ocr-job-payload.v1.schema.json",
  JSON.stringify(z.toJSONSchema(ocrJobPayloadV1, {
    target: "draft-2020-12",
    io: "output",
    unrepresentable: "throw",     // fail loudly rather than silently emit `any`
  }), null, 2) + "\n",
);
```

`z.toJSONSchema()` is built into Zod 4 (verified: https://zod.dev/json-schema).

**Three CI gates, all required to merge:**

1. `pnpm contracts:emit && git diff --exit-code contracts/generated` — a Zod change that is not
   regenerated fails the build. This is the drift guard.
2. Python: `pytest tests/contract/test_payload_schema.py` — loads
   `contracts/generated/ocr-job-payload.v1.schema.json`, validates every `fixtures/*.valid.json`
   against **both** the JSON Schema and the Pydantic model, and asserts every
   `fixtures/*.invalid.json` is rejected by **both**. This catches divergence in either direction.
3. TypeScript: the same fixtures parsed by Zod, same assertions.

The Pydantic side is hand-written (not generated), because a hand-written model that is
*verified* against the schema is easier to read and to attach domain methods to than generated
code, and gate 2 makes divergence impossible:

```python
# ocr_worker/contracts/payload_v1.py   —  pydantic 2.13.5
from pydantic import BaseModel, ConfigDict, Field
from typing import Literal
from uuid import UUID

class OcrJobPayloadV1(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    schema_version: Literal[1] = Field(alias="schemaVersion")
    job_id:         UUID       = Field(alias="jobId")
    kind:           Literal["DOCUMENT_EXTRACT", "AI_EXTRACT"]
    tenant_id:      UUID       = Field(alias="tenantId")
    document_id:    UUID       = Field(alias="documentId")
    correlation_id: UUID       = Field(alias="correlationId")
    source: SourceV1
    policy: PolicyV1
    budget: BudgetV1
```

**Version evolution rules (decision L11):**

| Change | New `schemaVersion`? | Deploy order |
|---|---|---|
| Add an **optional** field with a consumer-side default | No | either |
| Add a **required** field | **Yes** | consumer first |
| Remove or rename any field | **Yes** | consumer first |
| Add an enum member the consumer must handle | **Yes** | consumer first |
| Change a field's meaning without changing its type | **Yes** — this is the dangerous one | consumer first |

`extra="forbid"` on the consumer is only safe because deploy order is enforced. Make it
mechanical, in the compose deploy script:

```bash
# deploy.sh — worker before web, always. Non-negotiable.
docker compose up -d --wait ocr-migrate
docker compose up -d --wait ocr-worker     # consumer first
docker compose up -d --wait ocr-web        # producer second
```

During the window between the two, the *new* worker is reading *old* payloads. That direction is
always safe because the new worker still accepts every version it ever accepted. The reverse
order is what breaks, which is exactly why it is scripted rather than documented.

**Rollback** is the mirror image and is the case people forget: rolling `ocr-web` back is safe;
rolling `ocr-worker` back while new-version payloads are still queued is **not**. The runbook must
say: before rolling the worker back, drain or requeue `PENDING` jobs whose `schema_version`
exceeds the target version.

**A fourth CI gate, added in review** (§9.6 introduced it; recording it here with the others):

4. `pnpm contracts:i18n` — every `userFacing: true` code has a `msgKey` present in both `th.json`
   and `en.json`.

**Two notes on `z.toJSONSchema` that the draft got slightly wrong:**

- `io: "output"` is the wrong direction for a *payload*. The payload is what the producer emits and
  the consumer validates, so the consumer must be validating against the **input** schema. With the
  current schema they are identical (no transforms, no defaults, no coercion), so nothing breaks
  today — but the moment anyone adds a `.default()` or a `.transform()`, the committed schema and
  the wire bytes diverge and gate 2 will pass while production fails. **Emit both**
  (`…payload.v1.input.schema.json` and `…payload.v1.output.schema.json`) and have the Python gate
  validate against the *input* one. The result schema is the mirror: Python produces it, Node
  consumes it, so Node validates against its **output** schema.
- `unrepresentable: "throw"` is correct and should stay, but note it will throw on `z.date()`,
  `z.bigint()`, `z.map()`, `z.set()` and `z.custom()`. That is the point — it prevents someone
  adding a field that has no cross-language representation — but it must be documented, or the
  first person who reaches for `z.date()` will "fix" the build by relaxing the option.

### 9.8 Thai text across the boundary — invariants and tests (added in review)

The draft's contract is *mostly* Thai-safe, but by accident rather than by statement, and three
things in it were not. Stating the invariants makes them testable.

| # | Invariant | Why it breaks if violated | Test |
|---|---|---|---|
| T-1 | **No Thai ever reaches an object-storage key, a file path, a channel name, or a log field used as an identifier.** Keys are `{orgId}/{yyyy}/{mm}/{shard}/{documentId}/…` (dimension I) — all ASCII/hex | S3 keys are byte strings; a Thai key survives S3 but breaks on the local filesystem adapter across macOS (NFD) / Linux (NFC), and breaks prefix scans | fixture uploads `สัญญา ๒๕๖๙.pdf`; assert the stored key matches `^[A-Za-z0-9/_.-]+$` and the filename survives only in `originalFilename` |
| T-2 | **Every Thai-bearing string is NFC-normalised at the ingress boundary**, once, in `ocr-web`, before hashing, before storing, before enqueueing | macOS Safari uploads filenames in **NFD**; Windows/Android send **NFC**. The same file from two devices produces two different `sha256(canonical)` values → two jobs, two invoices, two "duplicate" documents in the UI. This is the single highest-probability Thai bug in the whole design | R20: upload the same bytes with an NFD and an NFC filename; assert one job, one dedupe key |
| T-3 | **Lengths are byte-lengths** (decision L30, §9.2) | Zod counts UTF-16 units, Pydantic counts code points, Postgres counts characters | the five fixtures of §9.2 |
| T-4 | **`charCount` is defined as Unicode code points after NFC**, and is documented as *not* a count of what a Thai reader would call characters | `เ`+`ก`+`ิ`+`ด` is 4 code points and 2 perceived characters. If `charCount` feeds dimension E's "did this page produce text?" routing threshold, the same page scores differently depending on how the engine emits diacritics — a **silent routing flip**, not a visible error | golden page with stacked diacritics; assert `charCount` is stable across NFC and NFD input |
| T-5 | **Thai numerals `๐–๙` (U+0E50–U+0E59) are preserved verbatim in `rawText`** and are never normalised to ASCII digits at this layer | a Thai tax invoice number written `๑๒๓` must not silently become `123` in the system of record — that is a data-integrity failure in a legal document, and the transformation, if wanted, belongs in the extraction layer with provenance | fixture asserts round-trip of `๐๑๒๓๔๕๖๗๘๙` |
| T-6 | **ZWSP (U+200B) and the Thai character `฿` survive the JSONB round-trip and the `pg_column_size` CHECKs** | Thai line-breaking uses ZWSP; a naive "strip control/invisible characters" sanitiser destroys line breaking. `฿` is 3 UTF-8 bytes and eats budget in the 4 KiB `detail` cap | round-trip fixture; and the `detail` cap is stated in **bytes**, so a Thai detail holds ~1 300 characters, not 4 096 |
| T-7 | **`TimeZone` is pinned to `UTC` on every connection** (`ocr_app`, `ocr_worker`, migrations) | `date_trunc('minute', finished_at)` on a `timestamptz` truncates **in the session time zone**; Asia/Bangkok is UTC+7 with no sub-hour offset so minute-truncation is safe, but `date_trunc('day', …)` in §15's future daily rollups would silently split a Thai business day. Pin it once rather than reason about it per query | `SHOW TimeZone` assertion in the connection-health test |

**On Python's Unicode version** (dimension D §7.4): the worker pins **Python 3.12** partly for this —
3.9's `unicodedata` is Unicode 13.0.0. D's own assessment is that *"Thai's decomposition data has
not changed across these versions, so this is hygiene, not a bug"*, and that is right, but the pin
also governs `str.isprintable()`, `unicodedata.normalize` behaviour on newly-assigned code points,
and `re` module properties. Keep the pin, and add a startup assertion:
`assert unicodedata.unidata_version >= "15.0.0"`.

---

## 10. Idempotency and exactly-once side effects

**Delivery is at-least-once. It is not possible to make it exactly-once, and any design that
claims otherwise is wrong.** What we can and do make exactly-once is the *effects*. Four layers:

### 10.1 Layer 1 — enqueue idempotency (HTTP)

Reuse jawbong's `idempotency_records` **table**
(`/Users/innovera/Documents/jawbong/src/modules/outbox/infrastructure/prisma-idempotency-repository.ts`):
`scope = "ocr.job.submit"`, `key = <client Idempotency-Key header>`. A replay with the same key and
the same hash returns the stored response; the same key with a *different* hash is a 422.

> **Corrected in review — do NOT reuse the hash.** Jawbong computes
> `requestHash = sha256(JSON.stringify(payload))`. `JSON.stringify` serialises object keys in
> **insertion order**, so two semantically identical bodies hash differently and the replay returns
> a spurious 422 — the failure is *user-visible* and *nondeterministic*, which is the worst
> combination. Dimension A already flagged this in decision A-6's rejection list ("an order-dependent
> idempotency hash"); the draft of this document reused it anyway.
>
> ```ts
> import { canonicalize } from "json-canonicalize";     // RFC 8785 JCS
> const requestHash = sha256Hex(
>   canonicalize(nfcDeep(body)),                        // NFC first — invariant T-2, §9.8
> );
> ```
>
> RFC 8785 fixes key order, number formatting and string escaping. `nfcDeep` normalises every
> string value (a Thai filename from an NFD client must hash the same as from an NFC client, or the
> idempotency key silently stops working for Mac users only).
>
> **Also missing from the draft:** the `IN_FLIGHT` state. Jawbong's repository has `response` /
> `responseCode` populated only on completion, so two genuinely concurrent requests with the same
> key both find no record and both proceed. Insert the record with `responseCode = NULL` **first**,
> under the unique constraint; the loser of that race gets a `409` with `Retry-After: 1` rather than
> a duplicate job. And set `expiresAt` — 24 h — or the table grows without bound.

### 10.2 Layer 2 — job dedupe (DB)

> ### ⚠ Defect found in review — the draft's `dedupeKey` could never collide
>
> The draft specified
> `dedupeKey = sha256(tenantId | documentId | kind | pipelineVersion | recipeHash | payloadHash)`.
>
> `payloadHash` is a hash of `OcrJobPayloadV1`, and that payload contains **`jobId`** (freshly
> generated per submit), **`correlationId`** (a fresh trace id per request) and
> **`budget.deadlineAt`** (a wall-clock timestamp). All three differ on every submission. Therefore
> **the dedupe key is unique on every call**, `ON CONFLICT DO NOTHING` never fires, and layer 2 —
> the layer that stops a double-click creating two jobs and two invoices — **does nothing at all**.
> The `?? findUniqueOrThrow` fallback in the code below would never execute, so the bug would not
> even crash; it would just quietly enqueue duplicates.
>
> **Corrected definition — a canonical, deterministic, explicitly-enumerated key:**
>
> ```ts
> // contracts/src/dedupe-key.v1.ts  — shared, tested, versioned with the payload
> export function dedupeKeyV1(p: OcrJobPayloadV1): string {
>   return sha256Hex(canonicalize({          // RFC 8785, same helper as §10.1
>     v: 1,
>     organizationId: p.organizationId,
>     documentId:     p.documentId,
>     kind:           p.kind,
>     sha256:         p.source.sha256,       // the BYTES, not the document row
>     pipelineVersion: p.policy.pipelineVersion,
>     recipeHash:      p.policy.preprocess.recipeHash,
>     engineProfile:   p.policy.engineProfile,
>     languages:      [...p.policy.languages].sort(),   // order-insensitive
>     renderDpi:       p.policy.renderDpi,
>     aiSchemaId:      p.policy.aiExtraction.schemaId,
>     aiPromptVersion: p.policy.aiExtraction.promptVersion,
>   }));
> }
> // Explicitly EXCLUDED and why:
> //   jobId, correlationId  -> per-request, would defeat the whole mechanism
> //   budget.*              -> operational, not semantic; a retry with a bigger budget is the SAME work
> //   source.originalFilename -> the same bytes under two names is the same work
> //   source.sizeBytes, declaredMime -> derivable from / implied by sha256
> ```
>
> **And the uniqueness must be partial, not total.** The draft's `@@unique([dedupeKey])` is a
> *permanent* lock: once a job for that document+recipe has ever existed — including one that
> `FAILED` because the object store was briefly down — **no future job for the same document and
> recipe can ever be enqueued again.** "Reprocess this document" becomes impossible without either
> mutating the key or deleting history. §6.2's `ocr_jobs_dedupe_live_idx` replaces it:
>
> ```sql
> CREATE UNIQUE INDEX ocr_jobs_dedupe_live_idx ON ocr_jobs (dedupe_key)
>   WHERE state IN ('PENDING', 'RUNNING');
> ```
>
> Semantics become the intended ones: *"there is at most one **live** job for this exact work"*.
> A concurrent double-submit still collapses to one job; a deliberate reprocess after a terminal
> state succeeds. The `?? findUnique` fallback then genuinely fires and must query with the same
> partial predicate.

Enqueue:

```ts
const job = await tx.$queryRaw<{ id: string }[]>`
  INSERT INTO ocr_jobs (id, tenant_id, document_id, kind, schema_version, payload,
                        priority, dedupe_key, budget_ms, deadline_at)
  VALUES (${id}::uuid, ${tenantId}::uuid, ${documentId}::uuid, ${kind}::"OcrJobKind",
          1, ${payload}::jsonb, ${priority}, ${dedupeKey},
          ${budgetMs}, ${deadlineAt})
  ON CONFLICT (dedupe_key) DO NOTHING
  RETURNING id`;
const jobId = job[0]?.id
  ?? (await tx.ocrJob.findUniqueOrThrow({ where: { dedupeKey }, select: { id: true } })).id;
```

Two concurrent submits of the same document produce one job and two identical 202s. Note this runs
**inside** the same `tx` as the document insert and the outbox event — satisfying R15.

### 10.3 Layer 3 — fencing (the general guarantee)

Every worker write to **Postgres** carries `WHERE lease_token = $token`. A zombie worker whose lease
expired can write nothing to `ocr_jobs`: not a result, not progress. This is the property that makes
"handlers must be idempotent" an enforced invariant instead of jawbong's written wish.

> ### Overclaim corrected in review — fencing does **not** cover everything the draft said it did
>
> The draft wrote: *"A zombie worker whose lease expired can write **nothing**: not a result, not
> progress, not a page row … "*. Three of those are false as specified.
>
> | Write | Fenced in the draft? | Consequence | Fix |
> |---|---|---|---|
> | `ocr_jobs` (result, progress, state) | ✅ yes | — | — |
> | `ocr_page_results` upsert | ❌ **no** — the statement in §8.1 has no `lease_token` predicate at all. The draft's parenthetical *"the loop re-checks the heartbeat before the write"* is a TOCTOU window, not a guard | a zombie overwrites the live owner's page row, resetting `job_attempts` or flipping a `POISON` back to `IN_PROGRESS` | the page upsert becomes a `SECURITY DEFINER` function taking `(job_id, lease_token, …)` that revalidates the lease **in the same statement**, or carries `WHERE EXISTS (SELECT 1 FROM ocr_jobs WHERE id=$job AND lease_token=$tok AND state='RUNNING')` |
> | `ocr_job_events` insert | ❌ no | harmless (append-only audit); a duplicate event is correct history | leave unfenced, but stamp `worker_id` and `lease_token` so the audit trail *shows* the zombie |
> | `ai_calls` reserve/complete | ❌ **no** | a zombie can complete a ledger row for a job it no longer owns, and — worse — **spend money** on a gateway call the live owner will also make | fence `complete_ai_call`; and see §10.4 |
> | **Object storage PUT** | ❌ **no, and it cannot be** | object stores have no notion of our lease | see below |
>
> **Object storage is the honest gap and the draft did not name it.** A zombie worker can PUT to
> `deriv/` and `result/` after losing its lease. For derivatives this is benign: dimension F makes
> them content-addressed, so both workers write **byte-identical** objects to the same key.
>
> For the **result** object it is not benign. `…/result/{sha256}.{pipelineVersion}.json` is *not*
> content-addressed by job — two workers can legitimately produce different bytes (different
> `poisoned` page sets, different partial progress at cancel). A zombie finishing 30 s late
> overwrites the good result with a worse one, and the `ocr_jobs.result_uri` still points at it.
>
> **Fix — make the result object immutable and let the DB pick the winner:**
> 1. Write the result to a **per-attempt** key: `…/result/{sha256}.{pipelineVersion}.{jobAttempt}.json`.
> 2. `finish_ok` sets `result_uri` to that key **and is lease-guarded**, so only the live owner's
>    key is ever published. The zombie's object exists but is referenced by nothing.
> 3. The orphan-derivative GC of dimension I (`list(prefix)`, GC-only) sweeps unreferenced attempt
>    keys. This is exactly the job I already scoped that call for.
>
> This costs one path segment and removes the last unfenced write that can corrupt customer output.
> **`ocr_lease_lost_total` (§15.2) is the metric that tells us how often this path is exercised**;
> the draft was right that it should be ~0, and now it is right for a checkable reason.

### 10.4 Layer 4 — the AI call ledger (the money guarantee, R6)

The AI gateway call is the one **non-idempotent, billable** side effect in the system. Content-
addressed page results make OCR free to redo; a model call is not.

```prisma
model AiCall {
  id             String   @id @db.Uuid
  tenantId       String   @map("tenant_id") @db.Uuid
  jobId          String   @map("job_id")    @db.Uuid
  idempotencyKey String   @unique @map("idempotency_key") @db.Char(64)
  stage          String   @db.VarChar(40)
  model          String   @db.VarChar(120)
  promptVersion  String   @map("prompt_version") @db.VarChar(40)
  state          String   @db.VarChar(20)     // RESERVED | COMPLETED | FAILED
  responseUri    String?  @map("response_uri") @db.VarChar(500)
  inputTokens    Int?     @map("input_tokens")
  outputTokens   Int?     @map("output_tokens")
  costMicros     Int?     @map("cost_micros")
  createdAt      DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
  completedAt    DateTime? @map("completed_at") @db.Timestamptz(3)
  @@map("ai_calls")
}
```

`idempotencyKey = sha256(jobId | stage | pageNo | promptVersion | model | sha256(renderedPrompt))`.

The protocol:

```python
key = ai_idempotency_key(...)
row = await reserve_ai_call(key)          # INSERT ... ON CONFLICT (idempotency_key) DO NOTHING
                                          #   RETURNING state, response_uri
if row is None:                           # someone already reserved it
    existing = await get_ai_call(key)
    if existing.state == "COMPLETED":
        return await load_response(existing.response_uri)   # replay, no second charge
    if existing.state == "RESERVED" and existing.age < AI_CALL_STALE:
        raise Retryable("AI_CALL_IN_FLIGHT")                # back off, do not duplicate
    # RESERVED and stale, or FAILED -> we may retry; flip to RESERVED with a new attempt marker
response = await gateway.complete(...)    # <-- the only place money is spent
await complete_ai_call(key, response)     # store response to object storage + tokens + cost
```

The residual window is unavoidable and must be named: **if the process dies after the gateway
processed the request but before `complete_ai_call` commits, we have paid and lost the response.**
The retry then re-reserves and pays again. Mitigations, in order:

1. Persist the raw gateway response to object storage **before** the DB write, keyed by the
   idempotency key. Then recovery reads it back instead of re-calling. Shrinks the window to the
   gateway round-trip itself.
2. ~~If the gateway honours a client-supplied idempotency key, pass it (many OpenAI-compatible
   gateways do).~~ **Revised in review.** We now know the gateway is **LiteLLM** (§1.4, evidence E1/E4).
   A search of LiteLLM's proxy documentation surfaced **no request-level idempotency-key
   deduplication** — LiteLLM has a *caching* layer, which is a different thing with different
   semantics (it can serve a stale answer to a distinct question). **Plan on the assumption that the
   gateway will happily bill a duplicate request.** The §10.4 ledger is therefore the only defence,
   not a belt-and-braces one. Downgraded from "probe to see if we can lean on it" to "probe to
   confirm we cannot" (§17.1 Q3).
3. **New, and specific to LiteLLM: a client timeout does not mean the request was not billed.**
   LiteLLM performs its own retries and provider fallbacks internally — *"if the primary returns a
   429, 503, or context-length error, LiteLLM automatically retries with the next provider in the
   chain, and the client sees a single successful response"*. So our `ai_extract` 180 s timeout can
   fire while the gateway is on its second upstream attempt, and **both** attempts may be billed.
   Consequences we must design for, none of which were in the draft:
   - the client timeout must be **longer** than the gateway's own worst-case retry chain, or we
     abandon paid work on every slow call. Ask for that number (§17.1 Q3); until we have it, set
     `ai_extract` to 180 s **per attempt with `max_retries=0` on our side**, and let the ledger
     absorb the rest;
   - on timeout, the `ai_calls` row stays `RESERVED` and is *not* retried until `AI_CALL_STALE`
     (set it to `2 × ai_extract` = 360 s), so a slow success is not raced by our own retry;
   - a `RESERVED` row that is never completed is a **suspected paid-and-lost** event. Emit
     `ocr_ai_calls_total{state="reserved_stale"}` and alert on it: it is the only visibility we have
     into money spent for nothing.
4. Accept the residual. At an estimated single-digit occurrences per million calls, the cost of
   eliminating it exceeds the cost of it happening. **This estimate is UNVERIFIED and is now less
   safe than the draft assumed**, because point 3 makes the window the *whole gateway retry chain*
   rather than one round-trip. Re-derive it once Q3 is answered.

**One more thing the ledger must fence** (from §10.3): `complete_ai_call` carries
`WHERE EXISTS (SELECT 1 FROM ocr_jobs WHERE id = $job AND lease_token = $tok AND state = 'RUNNING')`.
A zombie must not be able to mark a reservation complete for a job it no longer owns — otherwise the
live owner reads `COMPLETED`, replays the zombie's response, and silently returns a result derived
from a stale attempt.

---

## 11. Database ownership and credentials

> The user's constraint: **"Do not share database credentials unnecessarily."**

### 11.1 The two candidate answers

| | **Direct DB (chosen)** | HTTP-callback-only |
|---|---|---|
| Worker holds | its own Postgres role + object-storage keys | an internal API token + object-storage keys |
| Results travel | `UPDATE ocr_jobs` + object PUT | HTTP POST to ocr-web, which writes | 
| Worker can read | 3 tables | nothing directly |
| New failure modes | none | ocr-web down ⇒ result lost or must be re-queued; callback retry needs *its own* idempotency and lease protocol; a multi-MB body over HTTP |
| Queue access | needed anyway | **still needed anyway** — otherwise the worker has no queue |
| SSRF / auth surface | none added | a new authenticated internal endpoint that accepts arbitrary result payloads |

The decisive observation: **in a Postgres-backed queue, the worker must connect to Postgres to
claim a job at all.** "HTTP-callback-only" therefore does not remove DB credentials from the
worker — it only removes them from the *result* path, while adding a second at-least-once boundary
with its own retry, its own idempotency, and its own failure modes. That is more surface, not less.

**Decision L8: the worker connects directly, as a least-privilege role.** "Do not share
credentials unnecessarily" is satisfied not by having no credentials, but by having credentials
that grant nothing beyond the job protocol. The failure mode we are actually defending against is
"the worker container is compromised (it parses hostile PDFs all day — it is the *most* likely
component to be compromised) and the attacker gets the app's DSN." A dedicated role makes that
compromise worth almost nothing.

### 11.2 The grants, concretely

```sql
-- Roles. Three, not one.
CREATE ROLE ocr_owner  LOGIN PASSWORD :'owner_pw';    -- migrations only, run by the one-shot
CREATE ROLE ocr_app    LOGIN PASSWORD :'app_pw';      -- Next.js runtime
CREATE ROLE ocr_worker LOGIN PASSWORD :'worker_pw';   -- Python worker runtime

-- ocr_owner owns the schema; nobody else may create or drop anything.
ALTER SCHEMA public OWNER TO ocr_owner;
REVOKE CREATE ON SCHEMA public FROM PUBLIC, ocr_app, ocr_worker;

-- Deny-by-default, then grant explicitly.
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM ocr_worker;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ocr_worker;
GRANT USAGE ON SCHEMA public TO ocr_worker;

-- Exactly three tables. Nothing else.
GRANT SELECT, UPDATE                 ON ocr_jobs         TO ocr_worker;
GRANT SELECT, INSERT, UPDATE         ON ocr_page_results TO ocr_worker;
GRANT SELECT, INSERT                 ON ocr_job_events   TO ocr_worker;
GRANT SELECT, INSERT, UPDATE         ON ai_calls         TO ocr_worker;
GRANT USAGE ON SEQUENCE ocr_job_events_seq_seq TO ocr_worker;

-- Column-level: the worker may not rewrite the payload, the tenant, or the dedupe key.
REVOKE UPDATE ON ocr_jobs FROM ocr_worker;
GRANT  UPDATE (state, attempts, lease_token, lease_expires_at, worker_id,
               progress_stage, progress_pct, pages_done, pages_total,
               result, result_uri, degraded,
               last_error_code, last_error_detail, last_error_at,
               started_at, finished_at, available_at, updated_at)
       ON ocr_jobs TO ocr_worker;

-- The critical part: a future migration must not silently widen this.
ALTER DEFAULT PRIVILEGES FOR ROLE ocr_owner IN SCHEMA public
  REVOKE ALL ON TABLES FROM ocr_worker;

-- ocr_worker MUST NOT be able to read any of these. Verified by an integration test.
--   users, tenants, memberships, api_keys, sessions, documents,
--   audit_log, billing_*, outbox_events, idempotency_records
```

Note what the worker **cannot** do even on its own tables: it cannot change `tenant_id`,
`document_id`, `payload`, `priority`, `dedupe_key`, `budget_ms`, `deadline_at`, `max_attempts`, or
`abort_requested`. Those are the app's. Column-level grants make that structural rather than
conventional.

**R13's test** is a real integration test, not a code review item:

```ts
it("ocr_worker cannot read tenant data", async () => {
  const c = new Client({ connectionString: WORKER_DSN });
  await expect(c.query("SELECT 1 FROM users LIMIT 1"))
    .rejects.toThrow(/permission denied for table users/);
  await expect(c.query("UPDATE ocr_jobs SET tenant_id = gen_random_uuid()"))
    .rejects.toThrow(/permission denied/);
});
```

Run it for every table in the deny list, generated from the Prisma schema so a new table is
denied by default and the test fails loudly if someone grants it.

> ### Correction — what the draft's grants do **not** prevent (decision L25)
>
> The draft's §11.3 claimed: *"it also means the worker cannot enumerate other tenants' documents:
> the only key it ever sees is the one handed to it."* **That is false, and it is false because of a
> grant three lines above it.** `GRANT SELECT … ON ocr_jobs TO ocr_worker` is table-wide and
> unfiltered: the worker can `SELECT payload FROM ocr_jobs` and read **every organisation's**
> `source.bucket` and `source.key`. Combined with a static credential scoped to a shared `orig/`
> prefix (which the draft also specified), a compromised worker — *and §11.1 correctly identifies
> the worker as the most likely component to be compromised, because it parses hostile PDFs all
> day* — can read every document on the platform.
>
> The claim query is cross-organisation by design, so this cannot be closed by scoping the SELECT.
> It is closed by making the payload not worth stealing (decision L26):
>
> 1. **The object-storage credential is minted per claim**, scoped to that one organisation and that
>    one document prefix, and expires with the lease. Reading another organisation's key from
>    `ocr_jobs` then buys the attacker nothing — they have no credential that can fetch it.
> 2. **`GRANT SELECT` is narrowed by column** to what the protocol needs; there is no reason for the
>    worker to read `last_error_detail` or `result` of jobs it does not own:
>    ```sql
>    REVOKE SELECT ON ocr_jobs FROM ocr_worker;
>    GRANT  SELECT (id, tenant_id, document_id, kind, schema_version, payload, state,
>                   attempts, max_attempts, lease_token, lease_expires_at,
>                   deadline_at, pages_done, pages_total, abort_requested, abort_reason)
>           ON ocr_jobs TO ocr_worker;
>    ```
>    This is defence in depth, not a fix — `payload` is still in the list because the claim needs it.
> 3. **Residual risk is accepted and written down**, which is the part the draft skipped: *a
>    compromised worker can enumerate document identifiers and storage keys platform-wide, but not
>    fetch their contents.* That belongs in dimension J's STRIDE table as an Information-Disclosure
>    row with this mitigation, and it is the honest version of decision L8.

### 11.2.1 Completion → domain event, without widening the grant (decision L27)

The draft had a hole nobody would have found until integration: **when a job finishes, nothing tells
the rest of the system.** §2.3 says the outbox emits `document.uploaded` / `document.extracted` in
the same transaction as the *enqueue* — but `document.extracted` is only true at *completion*, and
completion is written by the worker, which §11.2 explicitly denies `INSERT` on `outbox_events`
(correctly — an `INSERT` grant there lets a compromised worker forge any domain event, including
billing ones). So webhooks, search indexing and billing would never fire (R17).

Resolution: a trigger owned by `ocr_owner`, so no grant changes.

```sql
CREATE FUNCTION ocr_emit_terminal_event_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO outbox_events (id, aggregate_type, aggregate_id, type, payload, occurred_at, status)
  VALUES (gen_random_uuid(), 'Document', NEW.document_id,
          CASE NEW.state
            WHEN 'SUCCEEDED' THEN CASE WHEN NEW.degraded THEN 'document.extracted.degraded'
                                                         ELSE 'document.extracted' END
            WHEN 'CANCELLED' THEN 'document.cancelled'
            ELSE 'document.failed' END,
          jsonb_build_object('jobId', NEW.id, 'organizationId', NEW.tenant_id,
                             'documentId', NEW.document_id, 'resultUri', NEW.result_uri,
                             'pagesDone', NEW.pages_done, 'pagesTotal', NEW.pages_total,
                             'degraded', NEW.degraded, 'errorCode', NEW.last_error_code),
          now(), 'PENDING');
  RETURN NEW;
END; $$;

CREATE TRIGGER ocr_jobs_emit_terminal_v1
  AFTER UPDATE OF state ON ocr_jobs FOR EACH ROW
  WHEN (OLD.state <> NEW.state
        AND NEW.state IN ('SUCCEEDED','FAILED','DEAD','CANCELLED'))
  EXECUTE PROCEDURE ocr_emit_terminal_event_v1();
```

Three properties this buys, all of which a Node-side reconciler would not:

1. **The event is in the worker's own commit.** No second at-least-once boundary, no "documents
   stuck at 100% because the reconciler died" incident — the exact failure mode §5.1 rejected Redis
   for.
2. **The worker still cannot forge an event.** It can only cause the ones this function emits, with
   the fields this function chooses, for a row it holds the lease on.
3. **`DEAD` and `FAILED` both emit**, so a webhook subscriber learns about operator-visible failures
   too — and the *public* payload says `document.failed` for both (§9.5's mapping), so `DEAD` never
   leaks outward.

`SECURITY DEFINER` functions are a privilege-escalation surface, so: owned by `ocr_owner` (not a
superuser), `SET search_path = public` pinned (the standard hardening), no dynamic SQL, no
parameters the worker controls beyond the row it already owns, and `REVOKE EXECUTE … FROM PUBLIC`.

### 11.3 Object storage — **rebuilt in review; the draft's model cannot be implemented**

Dimension F requires the worker to write derivatives. The draft scoped that by top-level prefix:

```
| Prefix    | ocr_app                | ocr_worker   |     <-- DRAFT. Does not exist.
| orig/     | write-once             | read only    |
| deriv/    | read                   | read + write |
| result/   | read                   | read + write |
```

**There are no such prefixes.** Dimension I (`i-storage.md`) fixes the key layout as

```
{organizationId}/{yyyy}/{mm}/{shard}/{documentId}/{orig|deriv|result}/…
```

**organisation-first**, with an explicit rejection of hash-first *"because it would destroy
per-tenant listing"* and with `list('{tenantId}/')` named as a supported single-prefix scan. The
role/purpose segment is the **fifth** path component, not the first. An IAM policy or a bucket ACL
scoped to `arn:…:s3:::bucket/orig/*` matches **nothing**. Decision L9's entire concrete security
content — "the worker holds prefix-scoped credentials (read `orig/`, write `deriv/`)" — was
unimplementable as written. (Dimension G's `org/{orgId}/doc/{docId}/original` is a third,
also-superseded variant; I is authoritative.)

**Corrected model (decision L26): a short-lived, per-claim, per-document credential.**

| | `ocr_app` (long-lived) | `ocr_worker` (per claim, TTL = lease + 60 s) |
|---|---|---|
| Scope | the whole bucket, via the app's own role | `{organizationId}/{yyyy}/{mm}/{shard}/{documentId}/*` — **one document** |
| `…/orig/*` | `PutObject` (write-once, no overwrite, no delete) | `GetObject` |
| `…/deriv/*` | `GetObject` | `GetObject`, `PutObject` |
| `…/result/*` | `GetObject` | `PutObject` (per-attempt keys only, §10.3) |
| Everything else | — | **denied by the session policy, not by convention** |

```jsonc
// the session policy attached at claim time (S3 / STS AssumeRole)
{ "Version": "2012-10-17", "Statement": [
  { "Effect": "Allow", "Action": ["s3:GetObject"],
    "Resource": "arn:aws:s3:::${BUCKET}/${orgId}/${yyyy}/${mm}/${shard}/${docId}/orig/*" },
  { "Effect": "Allow", "Action": ["s3:GetObject","s3:PutObject"],
    "Resource": ["arn:aws:s3:::${BUCKET}/${orgId}/.../${docId}/deriv/*",
                 "arn:aws:s3:::${BUCKET}/${orgId}/.../${docId}/result/*"] }
]}
```

**On the local/filesystem adapter** (dimension I's other backend), the equivalent is a signed
capability token carrying the same prefix and expiry, validated by the storage adapter on every
call. The *shape* of the credential must be identical across backends or the security property
becomes backend-dependent, which is how it gets lost in a migration.

**Why this is strictly better than the draft, not just different:**

| | Draft (static prefix key) | Corrected (per-claim session) |
|---|---|---|
| Blast radius of a compromised worker | every document of every organisation, indefinitely | one document, for one lease |
| Interacts with I's layout | **impossible** | native — the layout *is* the scope |
| Credential rotation | a redeploy | automatic, every claim |
| Cost | 0 | one `AssumeRole` per claim (~10 ms), amortised over a job that runs for seconds to minutes |

**Cost honestly stated:** this makes the claim RPC stateful in a way the four SQL statements are
not — the claim is no longer *only* SQL. That is the price of closing L25. It is paid in
`ocr-web`'s claim endpoint, not in the queue protocol, so §6.3 is unaffected and Option A2's
"language-neutral contract" property survives: the SQL is still the contract, the credential is an
adjunct the worker fetches with its lease token.

**On the `documents` table:** the worker still never needs it, because `bucket`, `key` and `sha256`
are in the payload (§9.2). That part of the draft stands. **What does not stand is the sentence
that followed it** — see the L25 correction in §11.2: table-wide `SELECT` on `ocr_jobs` *does* let
the worker enumerate other organisations' keys. The per-claim credential is what makes that
enumeration useless.

### 11.4 Worker HTTP surface

```
GET  /healthz    liveness   — process is up
GET  /readyz     readiness  — DB reachable, object store reachable, models loaded
GET  /metrics    Prometheus — internal network only, never routed by Caddy
POST /v1/extract TEST ONLY  — compiled in only when OCR_ENABLE_TEST_HTTP=1, never set in prod
```

`/v1/extract` (dimension E's endpoint) exists so extraction can be tested without a queue. It is
gated by an environment flag that the production compose file must never set, and it is not
present in the Caddy routing table. Keeping it behind a flag rather than deleting it preserves
E's testability without creating decision L20's second production code path.

**Hardening added in review**, because "gated by an env flag" is not by itself a control:
- the flag is read **once at import time** and the router is not even constructed when it is unset,
  so there is no runtime path to enable it;
- `/metrics` and `/v1/extract` bind to a **second listener on `127.0.0.1` or the internal Docker
  network only**, never to `0.0.0.0`. The draft said "internal network only, never routed by Caddy"
  — routing is Caddy's concern; **binding** is ours, and a bind is a control while a routing table
  is a convention;
- a CI check asserts `OCR_ENABLE_TEST_HTTP` appears in no file under `deploy/` or
  `docker-compose*.prod.yml`. One grep, permanently.

### 11.5 Row-Level Security — the layer the draft did not know existed (decision L24)

Dimension G's decision **K-3** mandates *"three independent isolation layers: (1) typed application
scoping, (2) the composite FK, (3) PostgreSQL **RLS with `FORCE ROW LEVEL SECURITY`** and a
non-owner runtime role"*, with the policy

```sql
CREATE POLICY org_isolation ON <table> FOR ALL TO ocr_app
  USING      (organization_id = current_setting('app.current_org', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.current_org', true)::uuid);
```

and a test `it.each(TENANT_TABLES)("%s has RLS enabled and forced")`. **This document never
mentioned RLS.** That is not a stylistic gap: if `extraction_jobs` is added to `TENANT_TABLES` — and
it must be, it is organisation-scoped data — then **`ocr_worker`'s claim returns zero rows**,
because the worker cannot set `app.current_org` before it knows which organisation it got. The
queue would appear to be permanently empty, on a system where every other test passes.

G anticipated this and named the resolution: *"The worker's claim query spans all tenants, so it
cannot run under `app.current_org`. Resolution: the claim runs as a **third role, `ocr_queue`**."*
This document's §11.2 defined `ocr_owner`, `ocr_app`, `ocr_worker` — and `ocr_worker` **is** G's
`ocr_queue`. They are the same role under two names; that is the whole conflict.

**Resolved shape (L24), reconciling both documents:**

```sql
-- Enable and FORCE on all four queue tables (G's requirement, no exceptions list).
ALTER TABLE ocr_jobs         ENABLE ROW LEVEL SECURITY;
ALTER TABLE ocr_jobs         FORCE  ROW LEVEL SECURITY;   -- applies to the owner too
-- … same for ocr_page_results, ocr_job_events, ai_calls

-- Layer 3 for the app: G's policy, unchanged.
CREATE POLICY org_isolation ON ocr_jobs FOR ALL TO ocr_app
  USING      (tenant_id = current_setting('app.current_org', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_org', true)::uuid);

-- The queue exception, explicit and narrow. NOT `BYPASSRLS` on the role.
CREATE POLICY queue_all_orgs ON ocr_jobs FOR ALL TO ocr_worker
  USING (true) WITH CHECK (true);
```

**Why a permissive policy and not `ALTER ROLE ocr_worker BYPASSRLS`:**

| | `BYPASSRLS` on the role | A `USING (true)` policy per table |
|---|---|---|
| Scope | **every table in the database**, including `users` and `api_keys`, forever | exactly the four tables named |
| Effect if someone later grants the worker SELECT on a new table | silently bypasses that table's RLS too | the new table's RLS still applies; the worker sees nothing |
| Visible in | `pg_roles`, easy to miss | `pg_policies`, and G's own RLS test enumerates it |
| Reviewable | one flag, no context | one row per table, with a name that says why |

`BYPASSRLS` would quietly delete the third isolation layer for the most-likely-compromised component
in the system. The per-table policy keeps L8's least-privilege story intact: the worker is *allowed*
to see all organisations **in the queue tables**, which is inherent to a shared queue (L25), and is
denied everywhere else by two independent mechanisms (grants **and** RLS).

**Two operational consequences, both of which must be in the runbook:**

1. **`ocr_owner` must run migrations with `FORCE ROW LEVEL SECURITY` in mind.** G already notes
   *"the table owner bypasses RLS by default"* — `FORCE` removes that, so a data migration run as
   the owner needs an explicit policy or a `SET row_security = off` (superuser only) — plan the
   migration path or the first backfill will fail confusingly.
2. **R18's acceptance test is two assertions, not one:** G's `TENANT_TABLES` test passes with the
   queue tables included, **and** a claim as `ocr_worker` with `app.current_org` unset returns a job
   belonging to an organisation the session never named. Both, or the reconciliation is not proven.

---

## 12. Cancellation semantics

> The user asked for cancel *"where safely possible"*. This section defines "safely".

### 12.1 What is cancellable, precisely

| Job state | Cancellable? | Mechanism | Latency | Effect on side effects |
|---|---|---|---|---|
| `PENDING` (never claimed) | **Yes, hard** | `UPDATE … SET state='CANCELLED' WHERE id=$1 AND state='PENDING'` | immediate | none — nothing happened |
| `PENDING` (retry backoff after ≥1 attempt) | **Yes, hard** | same | immediate | completed pages are retained; job ends `CANCELLED`, `degraded=true` |
| `RUNNING`, between pages | **Yes, cooperative** | `abort_requested = true` + `NOTIFY` | ≤ 1 page: **≤ 20 s** classical, **≤ 120 s** vision | pages already `DONE` are kept and downloadable |
| `RUNNING`, inside a page render / OCR call | **Deferred to the page boundary** | the worker checks `stop` after the page | as above | the in-progress page is completed and persisted, not discarded |
| `RUNNING`, inside a **billed AI gateway call** | **No — by design** | the call runs to completion, the response is persisted to the `ai_calls` ledger, *then* the job stops | ≤ AI stage timeout | **we already paid; we keep what we paid for** |
| `SUCCEEDED` / `FAILED` / `DEAD` / `CANCELLED` | No | terminal | — | — |

### 12.2 Rules

1. **Never SIGKILL a worker to cancel a job.** It kills every other job on that worker and leaves
   leases to expire.
2. **Never `pg_cancel_backend` / `pg_terminate_backend`.** It cancels a *query*, not a job, and
   corrupts lease accounting.
3. **Never abandon a paid-for AI response.** Cancelling the HTTP request after the gateway has
   begun generation typically does not refund anything; discarding the response converts a
   cancellation into a pure waste of money. Persist it, then stop. **Sharpened in review:** we now
   know this is **LiteLLM** (§1.4), and LiteLLM performs its own upstream retries and fallbacks, so
   aborting our client connection does not necessarily stop — or unbill — work already in flight
   upstream. That makes "let it finish and keep the result" the *only* defensible rule, not merely
   the frugal one. Still **UNVERIFIED**: whether this deployment's virtual key is billed on
   completion or on tokens generated, and whether mid-stream abort is honoured (§17.1 Q3).
4. **Partial results are a feature, not debris.** A cancelled 200-page job that completed 140
   pages produces a downloadable 140-page `NormalizedDocument` with
   `status = "succeeded_degraded"` and an explicit gap list. Users cancel because a document is
   taking too long; handing them what exists is strictly better than handing them nothing.
5. **Derivatives are retained** under dimension F's 30-day TTL, so an immediate re-submit is fast.

### 12.3 Implementation

```ts
// Node: the only writer of abort_requested. Note the state guard and tenant scoping.
await prisma.$executeRaw`
  UPDATE ocr_jobs
     SET abort_requested = true, abort_reason = ${reason}, updated_at = now()
   WHERE id = ${jobId}::uuid AND tenant_id = ${tenantId}::uuid
     AND state = 'RUNNING' AND abort_requested = false`;
// If 0 rows and state = 'PENDING', take the hard-cancel path instead (one statement, one branch).
```

```python
# Python: one listener connection per worker process, shared by all its jobs.
async def abort_listener(conn, registry: dict[UUID, asyncio.Event]) -> None:
    await conn.execute("LISTEN ocr_abort_v1")
    async for note in conn.notifies():
        payload = json.loads(note.payload)
        if ev := registry.get(UUID(payload["jobId"])):
            ev.set()
```

Belt and braces: the 30 s heartbeat also returns `abort_requested` (§6.3 statement 2), so a
dropped `NOTIFY` costs at most 30 s of extra latency and never a missed cancellation. **The
notification is an optimisation; the heartbeat is the guarantee.** That principle repeats
throughout this design and is why it degrades gracefully.

### 12.4 The missing statement — how a `RUNNING` job actually reaches `CANCELLED` (added in review)

**The draft's state machine could not produce `CANCELLED` from `RUNNING`.** §6.3 provides five
statements: claim, heartbeat, progress, complete-ok (4a), complete-err (4b), reaper. §12.1 says a
running job cancels cooperatively at a page boundary. But there is no statement that writes
`CANCELLED`, and routing it through 4b with `CANCELLED_BY_USER` (`retryable: false`) writes
**`FAILED`**, not `CANCELLED`. So:

- the UI would show *"failed"* for a job the user themselves cancelled — with a `userFacing`
  error code, i.e. an error message for a deliberate action;
- `ocr_jobs_finished_total{state="FAILED"}` would count user cancellations, corrupting N's
  `OcrJobFailureRateHigh` alert (§1.6) — a customer cancelling ten large uploads would page the
  on-call;
- §12.1's promise that a cancelled 200-page job yields a downloadable 140-page result has nowhere
  to put `result_uri`, because 4b has no result parameter.

**Statement (4c) — complete: cancelled.** Lease-guarded like every other completion, and it carries
the partial result, because §12.2 rule 4 says partial results are a feature.

```sql
-- $1 job_id  $2 lease_token  $3 partial result(jsonb)  $4 result_uri  $5 pages_done
UPDATE ocr_jobs
   SET state = 'CANCELLED',
       result = $3::jsonb, result_uri = $4,
       degraded = true,                       -- a cancelled job is by definition incomplete
       pages_done = $5,
       progress_stage = 'cancelled',
       lease_token = NULL, lease_expires_at = NULL,
       abort_requested = false, abort_reason = abort_reason,   -- reason RETAINED for the UI
       last_error_code = 'CANCELLED_BY_USER', last_error_at = now(),
       finished_at = now(), updated_at = now()
 WHERE id = $1 AND lease_token = $2::uuid AND state = 'RUNNING'
RETURNING state;
```

Note `abort_requested` is cleared (the CHECK/reaper fix of §6.2) while `abort_reason` is kept — the
reason is what the UI shows ("cancelled by you", "cancelled by an administrator", "cancelled by a
quota rule") and it must survive into the terminal row.

**The full, now-total state machine:**

```
                    ┌──────────────────────────────────── (4b retryable, backoff) ─────┐
                    ▼                                                                   │
  [enqueue] ──► PENDING ──(1) claim──► RUNNING ──(4a)──► SUCCEEDED                       │
                  │  │                   │  ├──(4b !retryable)──► FAILED                 │
                  │  │                   │  ├──(4b attempts exhausted)──► DEAD           │
                  │  │                   │  ├──(4c abort ack)──► CANCELLED               │
                  │  │                   │  └──(5 reaper, lease expired)─────────────────┘
                  │  └──(app hard cancel)──► CANCELLED
                  └─────(5 pass 3, queue TTL)──► FAILED / QUEUE_WAIT_EXCEEDED
```

Every arrow is one lease-guarded statement; every terminal state is reachable; no state is
reachable by two mechanisms with different side effects. **This diagram is the acceptance criterion
for R5** ("10 000 enqueues under chaos → 10 000 terminal states, 0 stuck") — the test asserts the
reachable set equals exactly `{SUCCEEDED, FAILED, DEAD, CANCELLED}` and that nothing sits in
`RUNNING` with an expired lease for longer than one reaper interval.

---

## 13. Timeouts and budgets

### 13.1 Per-stage timeouts

> **Every number below is an engineering estimate, UNVERIFIED.** No benchmark has been run —
> dimension D says the same about its accuracy figures. These are *initial defaults with the right
> shape and order of magnitude*, to be calibrated against the M2 benchmark set on the real target
> hardware. They are configuration, not code.

Baseline assumption: an amd64 container with 8 vCPU / 3 GiB, running dimension D's chosen
RapidOCR/ONNX classical path.

| Stage | Timeout | Scope | Notes |
|---|---|---|---|
| `fetch` | 60 s | per document | object-store GET + sha256 verify; 1 GiB ceiling from §9.2 |
| `identify` | 10 s | per document | magic bytes, page count, encryption probe |
| `route` | 15 s | per document | dimension E's per-page routing analysis over `page.chars` |
| `render` | 20 s | per page | pypdfium2 at ≤ `maxRenderPixels`; the DPI clamp of §8.2 keeps this true |
| `preprocess` | 10 s | per page | opencv deskew / CLAHE (dimension F tiers 0–1) |
| `ocr_classical` | 45 s | per page | detect + recognise; generous for a dense Thai A4 on a modest CPU |
| `ocr_vlm` | 180 s | per page | only on the vision branch (§16.2); network-bound |
| `native_extract` | 10 s | per page | pdfplumber / python-docx path |
| `assemble` | 60 s | per document | build + write `NormalizedDocument` |
| `ai_extract` | 180 s | per call | one gateway request; 3 retries within the job budget |
| **heartbeat** | 30 s interval, 120 s lease | per job | 4× margin — three consecutive misses before expiry |

### 13.2 Global job budget

```ts
// Corrected in review. Two changes: an unambiguous clamp signature, and — decision L28 —
// the budget is a PROCESSING budget that starts at first claim, not at enqueue.
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const budgetMs = clamp(
    60_000                                        // fixed overhead
      + pages * perPageBudgetMs                   // 25 s classical / 200 s vision
      + (aiEnabled ? 5 * 60_000 : 0),
    5  * 60_000,                                  // floor:   5 min
    45 * 60_000,                                  // ceiling: 45 min
);

// deadline_at is NULL at enqueue and is (re)set by EVERY claim (§6.3 statement 1):
//     deadline_at = now() + budget_ms
// Total wall time is bounded by max_attempts * budget_ms (4 x 45 min worst case) and,
// from the customer's side, by queue_expires_at. Queue wait is NOT part of the
// processing budget:
const queueExpiresAt = enqueuedAt + queueTtlMs;   // per-organisation, default 24 h
```

> ### ⚠ Defect found in review — the draft's `deadlineAt = enqueuedAt + budgetMs`
>
> The draft started the clock at enqueue. Trace it against the draft's own §14.2 thresholds:
>
> - §14.2 tolerates `oldest_pending_s > 1800` (30 min) before it even calls the queue "Critical".
> - A 200-page job's budget clamps to 45 min.
> - So a job enqueued into a 30-minute backlog is claimed with **15 minutes of budget left** for
>   45 minutes of work, and dies at page ~60 with `BUDGET_EXCEEDED`.
> - `BUDGET_EXCEEDED` is **non-retryable** (§13.2's own last line). The job is *terminally* failed.
> - Worse: a 40-minute backlog kills jobs *before they are ever claimed*, and the reaper's second
>   pass only matched `state='RUNNING'`, so they would instead be claimed and killed one page in —
>   consuming a worker slot to fail, which deepens the backlog, which kills more jobs. **A retry
>   storm and a queue backlog would compound into a self-amplifying outage** in which the platform
>   terminally fails work it was perfectly capable of doing.
>
> This is the most damaging single line in the draft, because the failure only appears under load —
> i.e. never in development, and always at the worst moment.
>
> **Fix, and why it is two mechanisms rather than a bigger number:** raising the ceiling to
> "budget + expected queue wait" makes the budget meaningless as a processing SLA and makes
> `BUDGET_EXCEEDED` unactionable. Instead:
> - `deadline_at` measures **our** time and answers *"is this worker stuck?"* → non-retryable
>   `BUDGET_EXCEEDED`, correct as before.
> - `queue_expires_at` measures **the customer's** wait and answers *"did we fail to get to this in
>   a reasonable time?"* → `QUEUE_WAIT_EXCEEDED`, a **capacity** signal that belongs on the ops
>   dashboard, is `userFacing` with an honest Thai message, and is the thing that should page
>   someone. Default 24 h, per-organisation in `tenant_quotas`.
> - R21 is the regression test.
>
> **Second-order benefit:** with the clock restarting on each claim, `deadline_at` is also correct
> across retries — a job that crashes at page 190 and is re-claimed gets a *fresh* processing budget
> for the remaining 10 pages, which is what §8's page-checkpoint story assumed all along but the
> draft's arithmetic quietly denied. The price is an explicit worst case of
> `max_attempts × budget_ms` = 4 × 45 min = 3 hours of *processing* for a pathological job, which is
> bounded, visible in `ocr_job_duration_seconds`, and acceptable because each attempt makes
> checkpointed forward progress. If it ever is not acceptable, store `budget_remaining_ms` and
> decrement it at completion — deliberately not done in M1, because it adds a write to the hot path
> to solve a problem we have not seen.

For a 200-page classical document: `60 s + 200 × 25 s = 5060 s` → clamped to **45 min**. That is a
deliberate signal: a 200-page document at 25 s/page cannot finish inside a sane budget on one
worker, which is precisely the case that should route to per-page fan-out (§8.3) once we measure
real throughput in M2. The clamp does not hide the problem; it surfaces it as a
`BUDGET_EXCEEDED` with `pages_done` telling us exactly how far we got.

**Enforcement, in three places** — because any one of them can be bypassed:

1. In the worker: each stage runs under `asyncio.timeout(stage_timeout)`.
2. In the worker: before each page, `if now() > deadline: raise Terminal("BUDGET_EXCEEDED")`.
   `deadline` is refreshed from every heartbeat, so an operator can extend a job by updating
   `deadline_at` and the running worker picks it up within 30 s.
3. In the reaper: `state='RUNNING' AND deadline_at < now() - 60s` → `FAILED / BUDGET_EXCEEDED`.
   This is the backstop for a worker that has wedged without dying.

`BUDGET_EXCEEDED` is **non-retryable** (§9.6). Retrying a job that ran out of time yields the same
result more slowly. The partial result is kept and surfaced.

---

## 14. Backpressure and admission control

### 14.1 Per-tenant limits, enforced at enqueue

| Limit | Default | Response when exceeded |
|---|---|---|
| `maxPendingJobs` | 200 | HTTP 429 + `Retry-After: 60`, body carries current queue position |
| `maxPendingPages` | 5 000 | HTTP 429 — the page count is the real cost driver, not the job count |
| `maxInflightJobs` | 2 **floor**, raised to a proportional share when few organisations are active (§7.2a — corrected in review; a flat 2 idles the cluster) | not an error — enforced by the claim, invisible to the client |
| `maxDocumentPages` | 2 000 | HTTP 413 at upload, before a job exists |
| `maxDocumentBytes` | 1 GiB | HTTP 413 at upload |
| `queueTtlMs` **(added in review, decision L28)** | 24 h | on expiry the job becomes `FAILED / QUEUE_WAIT_EXCEEDED` — a **capacity** signal, distinct from `BUDGET_EXCEEDED`, and it pages (§15.3) |

Limits live in a `tenant_quotas` table with plan-based defaults, so raising a customer's ceiling is
a row update, not a deploy. **Renamed per decision L23:** the table is `organization_quotas` and its
key is `organization_id`; dimension G already defines a `Quota` model, so this is one more thing
Q0 must reconcile rather than duplicate.

### 14.2 Global admission control

```sql
-- Corrected in review. Two bugs in the draft, both of which made the view lie in the
-- direction of "everything is fine".
CREATE VIEW ocr_queue_pressure AS
SELECT count(*) FILTER (WHERE state = 'PENDING')                                AS pending,
       count(*) FILTER (WHERE state = 'RUNNING')                                AS running,
       -- (1) age is measured from created_at, NOT available_at.
       COALESCE(EXTRACT(epoch FROM now() - min(created_at))
                  FILTER (WHERE state = 'PENDING'), 0)::int                     AS oldest_pending_s,
       -- (2) the real page count, not the per-job CAP.
       COALESCE(sum(COALESCE(pages_total, est_pages))
                  FILTER (WHERE state = 'PENDING'), 0)                          AS pending_pages
  FROM ocr_jobs;
```

> ### Two metric defects found in review
>
> **(1) `min(available_at)` is not the oldest pending job.** Statement 4b pushes `available_at`
> into the future on every retry. A job enqueued 90 minutes ago that has failed twice has an
> `available_at` a few seconds old, so `now() - available_at` for it is **near zero or negative**.
> `min(available_at)` therefore reports the *soonest-runnable* job, not the *longest-waiting* one.
>
> The consequence is not cosmetic. `oldest_pending_s` feeds:
> - §14.2's Elevated (`> 600`) and Critical (`> 1800`) admission-control thresholds — so
>   backpressure would not engage during exactly the incident it exists for (a retry storm);
> - `ocr_queue_oldest_pending_seconds`, which §15.2 calls **"the primary SLO"**;
> - N's `OcrQueueStalled` page alert.
>
> A gateway outage produces thousands of jobs retrying with fresh `available_at` values, the
> primary SLO metric reads healthy, backpressure never engages, and no one is paged. **The draft's
> single most consequential observability bug.** `created_at` is immutable and is the only correct
> source. (Same fix applied to §7.3's ageing sweep and §15.1's two views.)
>
> **(2) `payload->'policy'->>'maxRenderPages'` is a policy *ceiling*, not a page count.** Its
> default is 2 000 (§9.2). So a queue of 100 one-page receipts reports `pending_pages = 200 000`,
> and §14.2's shedding logic — whose entire premise is *"the page count is the real cost driver"* —
> would shed API and batch traffic against a queue containing 100 pages of actual work.
>
> `pages_total` is the truth but is NULL until the worker has opened the document. Fill the gap
> with an `est_pages` column written at enqueue: for PDFs, `ocr-web` already reads the page count
> during upload validation (dimension L's 413 check on `maxDocumentPages`), so it is free; for
> images it is 1; for anything unknown it is a conservative constant. `COALESCE(pages_total,
> est_pages)` is then never NULL and never a ceiling.
>
> Add to §6.2: `estPages Int @default(1) @map("est_pages")`.
>
> **Cost note the draft got wrong too:** the draft called this *"one cached read of
> `ocr_queue_pressure`"*. It is a full scan of every `PENDING` row with a JSONB extraction per row,
> every 5 s. With the fix it is a scan of the `PENDING` partial index plus two column reads —
> genuinely cheap — but only because `est_pages` replaced the JSONB dereference. Keep the 5 s cache
> and add `ocr_queue_pressure_query_seconds` to the metrics so it cannot silently become expensive.

| Pressure | Condition | Action |
|---|---|---|
| Normal | `pending < 2000` | accept everything |
| Elevated | `pending ≥ 2000` **or** `oldest_pending_s > 600` | shed **batch/backfill** submissions with 503 + `Retry-After: 300`; keep interactive and API |
| Critical | `pending ≥ 5000` **or** `oldest_pending_s > 1800` | shed batch **and** API with 503; keep interactive uploads only; page the on-call |

Rationale for the ordering: an interactive upload has a human waiting and represents one page most
of the time. A backfill has no one waiting and represents thousands. Shedding the cheap
latency-sensitive traffic first is exactly backwards.

The check is one cached read of `ocr_queue_pressure` (recomputed every 5 s in the Next process),
not a query per request.

### 14.3 Worker-side concurrency

Dimension D chose ONNX Runtime. ONNX Runtime parallelises *within* an inference call via intra-op
threads, so running many jobs concurrently in one process causes thread oversubscription and
makes everything slower. Therefore:

```yaml
# docker-compose.yml (excerpt)
ocr-worker:
  deploy: { replicas: 4 }
  mem_limit: 3g
  cpus: "2.0"
  environment:
    OCR_WORKER_CONCURRENCY: "1"     # one document at a time per process
    OMP_NUM_THREADS: "2"
    ORT_INTRA_OP_THREADS: "2"
```

**Scale by replicas, not by in-process concurrency** — for the classical branch. The vision branch
inverts this (§16.2): network-bound work wants high async concurrency and low CPU threads.

Total capacity = `replicas × OCR_WORKER_CONCURRENCY`. The per-tenant in-flight cap (default 2)
must stay meaningfully below that or fairness has nothing to allocate: keep
`replicas × concurrency ≥ 3 × maxInflightPerTenant`.

---

## 15. Observability

### 15.1 SQL views

```sql
-- Corrected in review: every age is measured from created_at, never available_at (see §14.2).
CREATE VIEW ocr_queue_depth AS
SELECT state, count(*) AS jobs,
       COALESCE(max(EXTRACT(epoch FROM now() - created_at))::int, 0) AS oldest_s,
       -- added in review: how much of the backlog is merely BACKING OFF vs genuinely waiting.
       -- Without this split, a retry storm and a capacity shortage look identical on the dashboard.
       count(*) FILTER (WHERE state = 'PENDING' AND available_at > now()) AS backing_off
  FROM ocr_jobs GROUP BY state;

CREATE VIEW ocr_queue_by_tenant AS
SELECT tenant_id,
       count(*) FILTER (WHERE state = 'PENDING') AS pending,
       count(*) FILTER (WHERE state = 'RUNNING') AS running,
       count(*) FILTER (WHERE state = 'DEAD'
                          AND finished_at > now() - interval '24 hours') AS dead_24h,
       COALESCE(max(EXTRACT(epoch FROM now() - created_at))
                  FILTER (WHERE state = 'PENDING'), 0)::int AS oldest_pending_s
  FROM ocr_jobs GROUP BY tenant_id;

CREATE VIEW ocr_dlq AS
SELECT id, tenant_id, document_id, kind, attempts,
       last_error_code, last_error_detail, finished_at,
       pages_done, pages_total
  FROM ocr_jobs
 WHERE state = 'DEAD'
 ORDER BY finished_at DESC;

CREATE VIEW ocr_throughput_1h AS
SELECT date_trunc('minute', finished_at)                              AS minute,
       count(*) FILTER (WHERE state = 'SUCCEEDED')                    AS ok,
       count(*) FILTER (WHERE state = 'SUCCEEDED' AND degraded)       AS degraded,
       count(*) FILTER (WHERE state IN ('FAILED','DEAD'))             AS bad,
       sum(pages_done)                                                AS pages,
       percentile_disc(0.95) WITHIN GROUP (
         ORDER BY EXTRACT(epoch FROM finished_at - started_at))::int   AS p95_s
  FROM ocr_jobs
 WHERE finished_at > now() - interval '1 hour'
 GROUP BY 1 ORDER BY 1 DESC;
```

### 15.2 Prometheus metrics from the worker `/metrics`

| Metric | Type | Labels | Why it matters |
|---|---|---|---|
| `ocr_queue_pending` | gauge | `tenant_bucket` — **corrected in review**, and dimension N made the same correction independently. A raw `tenant` label is an unbounded-cardinality series in a multi-tenant product and will eventually take down Prometheus; "top-N then other" is also *not* stable, because membership of the top N changes and produces orphaned series. Bucket by size class (`xs/s/m/l/xl`) instead, and get per-organisation depth from `ocr_queue_by_tenant` on demand | autoscaling signal |
| `ocr_queue_oldest_pending_seconds` | gauge | — | **the primary SLO**: how long is anyone waiting |
| `ocr_jobs_claimed_total` | counter | `worker` | throughput |
| `ocr_jobs_finished_total` | counter | `state`, `error_code` | error budget |
| `ocr_job_duration_seconds` | histogram | `kind`, `engine_profile` | capacity planning |
| `ocr_page_duration_seconds` | histogram | `route`, `engine_id` | engine regression detection |
| `ocr_pages_cached_total` | counter | — | measures how much R2 is actually saving |
| `ocr_lease_lost_total` | counter | `worker` | **should be ~0. Non-zero means the fencing token is earning its keep, or heartbeats are starving.** |
| `ocr_leases_reaped_total` | counter | — | worker crash rate |
| `ocr_pages_poisoned_total` | counter | `failure_code` | content-quality signal |
| `ocr_ai_calls_total` | counter | `model`, `replayed` | `replayed=true` proves the §10.4 ledger works |
| `ocr_ai_cost_micros_total` | counter | `model` only | billing reconciliation. **Corrected in review:** the draft labelled this `tenant`, which puts per-customer spend into a Prometheus series — unbounded cardinality *and* commercially sensitive data in a system with a weaker access model than the database. Per-organisation cost is a **billing** query against `ai_calls`, not a metric |
| `ocr_ai_calls_total{state="reserved_stale"}` | counter | `model` | added in review — suspected paid-and-lost calls (§10.4 item 3). The only visibility we have into money spent for nothing |
| `ocr_queue_pressure_query_seconds` | histogram | — | added in review — guards §14.2's admission-control query from silently becoming expensive |
| `ocr_pages_lifetime_attempts` | histogram | `engine_id` | added in review — pairs with `ocr_pages_poisoned_total`; a page needing 3 attempts across 5 uploads is an engine-quality signal (§8.1) |

### 15.3 Alerts

| Alert | Condition | Severity | Meaning |
|---|---|---|---|
| `OcrQueueStalled` | `ocr_queue_oldest_pending_seconds > 900` for 5 min | page | jobs exist and nothing is draining |
| `OcrNoWorkers` | `ocr_jobs_claimed_total` flat for 5 min while `pending > 0` | page | all workers dead or wedged |
| `OcrDlqGrowing` | `increase(ocr_jobs_finished_total{state="DEAD"}[1h]) > 10` | ticket | systematic failure |
| `OcrLeaseLost` | `increase(ocr_lease_lost_total[15m]) > 0` | ticket | heartbeat starvation or clock skew — investigate before it becomes double-processing |
| `OcrPoisonSpike` | `increase(ocr_pages_poisoned_total[1h]) > 50` | ticket | an engine regression or a bad tenant corpus |
| `OcrTenantStarved` | `max by (tenant)(oldest_pending_s) > 600` while another tenant's `running > 0` | ticket | **R4 has regressed** |
| `OcrBudgetExceeded` | `increase(...{error_code="BUDGET_EXCEEDED"}[1h]) > 5` | ticket | budgets are miscalibrated or throughput has degraded |
| `OcrQueueWaitExceeded` | `increase(...{error_code="QUEUE_WAIT_EXCEEDED"}[1h]) > 0` | **page** | added in review — we accepted work and never got to it. Unlike `BUDGET_EXCEEDED` this is unambiguously *our* capacity failure, visible to the customer, and never self-correcting |
| `OcrAiCallReservedStale` | `increase(ocr_ai_calls_total{state="reserved_stale"}[1h]) > 0` | ticket | added in review — suspected duplicate or lost billing (§10.4) |

> **Deferred to dimension N (added in review).** `n-observability-testing-benchmark.md` adopted this
> table and refined it: it **subsumes `OcrNoWorkers` into `OcrQueueStalled`** (*"no workers is one
> cause of a stalled queue, and the symptom is what the customer experiences"*) and adds
> `OcrJobFailureRateHigh`. **N is authoritative for alerting from here on**; this section remains as
> the rationale for *why* each signal exists, and as the list of metrics the worker must emit.
>
> One consequence worth flagging back to N: `OcrJobFailureRateHigh` counts
> `state=~"FAILED|DEAD"`. With §12.4's fix, user cancellations are `CANCELLED` and correctly
> excluded — **but `QUEUE_WAIT_EXCEEDED` writes `FAILED`**, so a capacity incident will also trip
> the failure-rate page. That is arguably correct (it *is* a failure) but it will double-page. N
> should either exclude `error_code="QUEUE_WAIT_EXCEEDED"` from that ratio or explicitly accept the
> double-page.

---

## 16. The AI-gateway branches — **rewritten in review; the draft was stale**

**What the draft said:** *"Dimension B confirms the INNOVERA gateway's address, model list, and
vision capability are unknown and not discoverable from this machine. Both branches are designed
here."*

**What is true as of B's reviewed revision (§1.4):**

| Question | Draft's position | Now |
|---|---|---|
| Is there a gateway, and what kind? | unknown | **LiteLLM.** `LITELLM_BASE_URL` / `LITELLM_API_KEY` are required runtime config of a deployed INNOVERA production app (B E1), and the key is documented as a *"LiteLLM virtual key"* (B E4) |
| Auth | unknown | `Authorization: Bearer <virtual key>` (B E3) |
| URL shape | unknown | base URL **excludes** `/v1`; the client appends the full path (B E2) |
| Model alias | unknown | **`innovera-ai`** (B E5) |
| **Underlying model** | assumed "Qwen" | **UNRESOLVED.** B's own words: *"the underlying model identity (**Qwen**) is never exposed"* — the *name* is evidenced, *"which Qwen, and what size, remain UNKNOWN"*. **Nothing in this document may depend on a Qwen generation, parameter count, tokenizer, or context beyond E6** |
| Context ceiling | unknown | **65 536 tokens** (B E6) |
| **Vision** | 50/50, design both | **TEXT-ONLY, high confidence** (B E7, verbatim from production source: *"the deployed model is text-only … No OCR, no vision, and no image bytes ever leave the server for the LLM"*) |
| Network path | unknown | **internal Docker network**, not a public hostname (B E8); shared network default `innovera_default` (B E9) |
| **Endpoint value, model list, whether OCR gets its own virtual key** | unknown | **still UNRESOLVED — owner-supplied** (B §3.2) |

**Consequence for this document. Branch T is the build target for M1.** Branch V is *designed, not
built*, and reopens only on B's stated expiry triggers: a probe reporting `supports_vision: true`
for an alias OCR can call, a `…-VL-…` repo in the owner's answer, or a gateway upgrade.

**Two things this changes beyond the branch weighting**, neither of which was in the draft:

1. **The internal-network fact removes a whole security question.** The worker reaches the gateway
   over `innovera_default`, not the public internet, so there is no egress allow-list, no public TLS
   pinning, and no SSRF-shaped outbound path to design here. It also means the gateway is *not*
   reachable from the worker unless the worker container is explicitly attached to that network —
   which is an item for dimension M's compose file, and a hard dependency of every `ai_extract`
   stage timeout in §13.1.
2. **`innovera-ai` is an alias over a LiteLLM router, so "the model" can change under us without a
   deploy on our side.** Anything we cache or key on must therefore include the *alias*, not an
   assumed model — which §10.4's `ai_calls.model` and §9.3's `ai.model` already do, but for the
   wrong reason. Record it as an invariant: **never key an idempotency hash or a cache on an
   assumed model identity; key on the alias plus `promptVersion`.** If LiteLLM returns the resolved
   model in its response (`model` field), store *that* in `ai_calls.model` for accounting while
   keying on the alias.

### 16.1 Branch T — the model is text-only (**the M1 target**)

- Every scanned page must go through classical OCR. OCR is the throughput bottleneck and it is
  **CPU-bound**.
- Job graph: `DOCUMENT_EXTRACT` (render → OCR → assemble) → `AI_EXTRACT` (one or a few gateway
  calls over the assembled text, chunked by dimension E's `[PAGE n]` markers).
- Gateway calls per document: **O(1–5)**, not O(pages). The §10.4 ledger matters but the blast
  radius of a double-call is small.
- **The 65 536-token ceiling (B E6) is a queue parameter, and the draft did not treat it as one.**
  A 200-page Thai document is far beyond it, so `AI_EXTRACT` must chunk — and chunking makes the
  *number of gateway calls* a function of page count after all, just with a much smaller constant.
  Two things follow: (a) `budgetMs`'s `aiEnabled ? 5 min : 0` term (§13.2) is wrong for large
  documents and should be `ceil(estimatedTokens / chunkTokens) × ai_extract_timeout`; (b) each
  chunk is a separate `ai_calls` ledger row, so the idempotency key of §10.4 must include the
  **chunk index**, which the draft's `(jobId | stage | pageNo | promptVersion | model | promptHash)`
  does not have a slot for. Add `chunkIndex`.
- **Thai tokenises badly.** Thai text costs materially more tokens per character than English in
  most BPE vocabularies (no whitespace to anchor merges), so a token budget calibrated on English
  will overflow on Thai. **UNVERIFIED and it must not be guessed**: measure the actual
  characters-per-token ratio for `innovera-ai` on a Thai corpus before setting `chunkTokens`. Until
  measured, use a deliberately conservative 1.5 characters/token for Thai and record the
  assumption. This is on the §17.1 probe list (Q6).
- Queue parameters: `perPageBudgetMs = 25_000`; worker concurrency **1**; scale by replicas;
  `OMP_NUM_THREADS = 2`.
- Backpressure bottleneck: **CPU**. `ocr_queue_pending` is the autoscaling signal.
- Per-page fan-out (§8.3) is worth it only if we get more CPU. It does not reduce total CPU.

### 16.2 Branch V — the model is vision-capable (**designed, not built**)

> **Status after B's review: this branch is contingency, not a coin-flip.** B E7 resolves the
> deployed model to text-only at high confidence, from production source written by the team that
> operates the gateway. This section stays because B's own verdict names a limited scope
> (*"not proof that the **gateway** serves no vision model — only that **Chat's** model has none"*)
> and four explicit re-check triggers. Build none of it in M1; keep it costed.

- Dimension F's D14 applies: tier-0 preprocessing only, full-colour RGB renders. Dimension D keeps
  the classical engine as the always-on baseline (it is the only one that returns per-line
  geometry, which redaction and field anchoring require), with the VLM as an accuracy escalation.
- Job graph is the same, but the OCR stage becomes **network-bound**, and gateway calls scale as
  **O(pages)**.
- **Six concrete queue-parameter changes:**
  1. `ocr_vlm` stage timeout 180 s (vs 45 s classical).
  2. `perPageBudgetMs = 200_000`; the 45-minute ceiling now binds at ~13 pages, so the ceiling
     must rise **or** fan-out becomes mandatory. **This is the trigger for §8.3.**
  3. Worker concurrency inverts: `OCR_WORKER_CONCURRENCY = 8–16` async, `OMP_NUM_THREADS = 1`.
     One worker process can hold many in-flight HTTP calls.
  4. The §10.4 `ai_calls` ledger goes from "nice" to **load-bearing**: every page is billable, so
     a retry storm without the ledger is a retry storm of invoices.
  5. A **shared rate limiter** becomes necessary — N workers × 16 concurrent calls will trip the
     gateway. Preferred implementation: honour the gateway's `429` + `Retry-After` as a
     first-class `AI_GATEWAY_RATE_LIMITED` retryable error with full jitter (§13). A Postgres
     token-bucket (`ai_rate_buckets` updated atomically) is the fallback if the gateway does not
     return `Retry-After`.

     **Sharpened in review, now that we know it is LiteLLM.** Two behaviours matter and neither was
     in the draft:
     - LiteLLM **does** set `retry-after` on **its own** rate limits and cooldowns — including the
       virtual-key TPM/RPM budget of B E4, which is the limit we will actually hit first. So the
       preferred implementation is available.
     - LiteLLM does **not** forward an *upstream provider's* `retry-after` under that name; it is
       exposed only as **`llm_provider-retry-after`**. **The worker must read both headers**, in
       that order, or it will silently fall back to blind exponential backoff exactly when the
       upstream is telling us how long to wait. One line of code, and impossible to discover from a
       failure — it just backs off wrong.
     - Because the virtual key carries the budget, a 429 may mean *"this key is out of quota for the
       minute"* rather than *"the model is busy"*. These want different reactions: the first should
       throttle **the whole worker fleet** (it is a shared key), the second only this call.
       `x-litellm-*` response headers should be captured into `ai_calls` so we can tell them apart
       after the fact. Exact header names are **UNVERIFIED** — §17.1 Q3.
  6. Backpressure bottleneck moves from CPU to **gateway concurrency**. The autoscaling signal
     becomes gateway queue latency, not `ocr_queue_pending`; adding workers past the gateway's
     capacity makes things worse, not better.
- The per-page checkpoint (§8.1) becomes **more** valuable, not less: each cached page is a saved
  invoice, not just saved CPU. `ocr_pages_cached_total` becomes a cost metric.

**What does not change in either branch:** the queue substrate, the four protocol statements, the
fencing token, the payload/result schemas, credential separation, cancellation, the DLQ, fairness,
and every acceptance test in §3. That invariance is the point of the design — the AI unknown does
not block this dimension.

---

## 17. Open questions and unverified claims

### 17.1 Must be resolved before implementation (blocking)

| # | Question | How to resolve | Owner |
|---|---|---|---|
| **Q0** | **Do dimensions G and H agree on one job table, one tenant column name, and one priority direction?** (§1.5, decisions L22/L23) | A 30-minute reconciliation between the two documents, *before* the first migration. **This is now the blocking question, ahead of Q1** — it is the only decision in this document with `hard` reversibility, and every downstream artifact encodes the answer | eng lead |
| Q1 | Does the §6.3 claim statement (`FOR UPDATE OF j` inside a CTE joined to an aggregating CTE) execute on PostgreSQL 17? **And does the §7.5 `LATERAL` variant?** | Run both against a throwaway container. Fall back to §6.3's option (a) if not. **`FOR UPDATE` is documented as illegal with `GROUP BY`/`HAVING` and "in contexts where returned rows cannot be clearly identified with individual table rows"; the aggregation lives in a *separate* CTE and `OF j` names only the non-nullable side, so it should be legal — but "should be" is not a migration.** First thing M1 tests | eng |
| Q2 | ~~Does the INNOVERA AI gateway expose a vision-capable model?~~ **Largely resolved: NO** (B E7, high confidence). Residual: does the *gateway* serve any other alias that is vision-capable? | B's probes P2 (`GET /v1/models`) and P3b, once the owner supplies `LITELLM_BASE_URL` | owner + eng |
| Q3 | LiteLLM specifics: does it accept a client-supplied idempotency key (**assume NO** until shown otherwise, §10.4); which headers carry rate-limit state; what is the gateway's own internal retry/fallback worst-case duration (§10.4 item 3) | probe against the real endpoint | owner + eng |
| Q4 | Real per-page OCR wall time on the target host for a dense Thai A4 | M2 benchmark (dimension D owns the corpus) — every number in §13 depends on it | eng |
| Q5 | Peak RSS per page at 300/600 dpi for the chosen engine | M2 benchmark; sets `mem_limit` and `MAX_RENDER_PIXELS` | eng |
| **Q6** | **Characters-per-token ratio for Thai on `innovera-ai`** (§16.1) | measure against the real gateway with a Thai corpus; until then assume a conservative 1.5 | eng |
| **Q7** | **Is `extraction_jobs` in dimension G's `TENANT_TABLES`, and does the `USING (true)` worker policy satisfy G's RLS test?** (§11.5, R18) | run G's `it.each(TENANT_TABLES)` suite with the queue tables added | eng |
| **Q8** | **Does the object-storage backend support per-request scoped credentials** (S3 STS `AssumeRole` with a session policy; the local adapter's equivalent)? Decision L26 depends on it | dimension I owns the adapter interface; confirm before M1 | eng |
| **Q9** | **Does `ocr-web` already know the page count at upload time**, so `est_pages` (§14.2) is free? | dimension L's `maxDocumentPages` 413 check implies yes; confirm | eng |

### 17.2 Explicitly unverified claims in this document

- **UNVERIFIED:** the §6.3 claim SQL (Q1 above). Two fallbacks given.
- **UNVERIFIED:** Prisma 7.10.0's `datasource.schemas` fully excludes an unlisted schema from
  `migrate diff` — only relevant if we ever adopt procrastinate (§4.1.1 objection 3).
- **UNVERIFIED:** the maturity of `bullmq` **3.2.1** (Python)'s lock-renewal behaviour for jobs
  running longer than `lockDuration`. Not on the chosen path. *(Version corrected in review; the
  draft said 2.24.0.)*
- **UNVERIFIED:** every timing number in §13. They are engineering estimates with the right order
  of magnitude, explicitly to be calibrated in M2.
- **UNVERIFIED:** the claim that Redis out-claims Postgres by ~10× for this access pattern. Widely
  reported; not measured by us; irrelevant at our target rate.
- ~~**UNVERIFIED:** that a Python worker running ONNX/OpenCV in a thread does not starve the asyncio
  heartbeat.~~ **Closed in review by design change, not by verification:** OCR runs in a
  `ProcessPoolExecutor` (§6.5), which removes the GIL question, enables `RLIMIT_AS` per page, and
  contains native segfaults. **M1 still includes the soak test asserting
  `ocr_lease_lost_total == 0` over a 60-minute run at full concurrency** — it now verifies the fix
  rather than deciding the question.
- ~~**UNVERIFIED:** the 8000-byte `NOTIFY` payload limit.~~ **VERIFIED in review** against
  `https://www.postgresql.org/docs/17/sql-notify.html`: *"In the default configuration it must be
  shorter than 8000 bytes."* The same page also yields a finding the draft missed —
  *"Notifications are visible to all users"*, i.e. `LISTEN` has **no permission model** — which is
  why §6.4's payloads are now empty.
- **UNVERIFIED:** that `pg_column_size()` in a CHECK constraint behaves as the draft assumed. It is
  permitted, but it measures the **stored (possibly TOAST-compressed)** datum, so the 64 KiB bound
  is a storage bound and not a text-length bound (§6.2). Assert both, or state which one is meant.
- **UNVERIFIED:** that a `SECURITY DEFINER` trigger writing to `outbox_events` (decision L27)
  composes correctly with `FORCE ROW LEVEL SECURITY` on that table (§11.5). The definer is
  `ocr_owner`, and `FORCE` applies to owners — so the function may need its own permissive policy
  or an explicit `organization_id` that satisfies the existing one. **Test this in the same
  throwaway container as Q1.**
- **UNVERIFIED:** the exact LiteLLM response headers carrying rate-limit and cost state, and
  whether its internal retry/fallback chain can outlive our client timeout (§10.4 item 3, §16.2
  item 5). The *behaviours* are documented; the *header names and durations for this deployment*
  are not.
- **UNVERIFIED:** Thai characters-per-token on `innovera-ai` (Q6). Every token-budget number in
  §16.1 is currently an assumption with a conservative constant attached.

### 17.3 Deliberately deferred (with the trigger that reopens them)

| Deferred | Trigger to revisit |
|---|---|
| Redis, in any role | §5.3 T1–T5, all requiring measurement |
| Per-page fan-out with a fan-in barrier (§8.3) | Branch V (§16.2), or measured throughput below target with CPU headroom available |
| `tenant_inflight` counter table (§7.4) | T1: measured claim contention |
| `LISTEN/NOTIFY` progress fan-out to the UI (§9.5) | > 500 concurrent watchers |
| Cross-tenant content-addressed dedupe (§8.1) | Never, without an explicit threat review |
| procrastinate 3.9.0 (§4.1.1) | Our queue code exceeding ~500 lines, or new scheduling needs (cron, dependencies, chained flows) |
| An HTTP result callback | A second consumer that cannot reach Postgres |
| `ocr_tenant_inflight` counter **plus its reconciler** (§7.4) | T1 only — and never without the reconciler |
| The §7.5 `LATERAL` claim variant | Measured claim latency degradation with a deep single-organisation backlog |
| `budget_remaining_ms` (decrementing budget across attempts, §13.2) | A pathological job observed consuming `max_attempts × budget_ms` |
| Cross-organisation content-addressed page cache (§8.1) | Never, without an explicit threat review |
| `x-litellm-*` fleet-wide throttling (§16.2 item 5) | First 429 storm attributable to the shared virtual key |

---

## 18. Evidence appendix

### 18.1 Files read in this session

```
/Users/innovera/Documents/jawbong/src/modules/outbox/domain/outbox-event.ts
/Users/innovera/Documents/jawbong/src/modules/outbox/application/outbox-ports.ts
/Users/innovera/Documents/jawbong/src/modules/outbox/application/outbox-worker.ts
/Users/innovera/Documents/jawbong/src/modules/outbox/infrastructure/prisma-outbox-repository.ts
/Users/innovera/Documents/jawbong/src/modules/outbox/infrastructure/prisma-idempotency-repository.ts
/Users/innovera/Documents/jawbong/prisma/schema.prisma
/Users/innovera/Documents/jawbong/prisma/migrations/20260803000000_phase_00_foundation/migration.sql
/Users/innovera/Documents/jawbong/package.json
/Users/innovera/Documents/OCR/docs/architecture/m0/a-environment-and-stack.md   (§0, §1, §2, §5)
/Users/innovera/Documents/OCR/docs/architecture/m0/b-ai-topology-discovery.md   (§0)
/Users/innovera/Documents/OCR/docs/architecture/m0/d-ocr-engine.md              (§0, §1)
/Users/innovera/Documents/OCR/docs/architecture/m0/e-native-extraction-routing.md (§0, §1)
/Users/innovera/Documents/OCR/docs/architecture/m0/f-preprocessing-and-confidence.md (§0)
```

**Added in the review pass** (the draft had read only A, B, D, E, F — the gap that produced findings
§1.5 and §1.6):

```
/Users/innovera/Documents/OCR/docs/architecture/m0/b-ai-topology-discovery.md   (revision notice, §5.0, §5.1, E1–E9 table)
/Users/innovera/Documents/OCR/docs/architecture/m0/g-data-model.md              (K-3, §3.4 RLS, models ExtractionJob/JobEvent, RLS claim exception)
/Users/innovera/Documents/OCR/docs/architecture/m0/i-storage.md                 (key layout, prefix throughput, 1024-byte key limit)
/Users/innovera/Documents/OCR/docs/architecture/m0/j-security-threat-model.md   (EoP row, imaging limits)
/Users/innovera/Documents/OCR/docs/architecture/m0/l-api-ui-export.md           (L-5, L-8, status enum, cancel endpoint)
/Users/innovera/Documents/OCR/docs/architecture/m0/n-observability-testing-benchmark.md (metric adoption, alert subsumption)
/Users/innovera/Documents/jawbong/src/modules/outbox/infrastructure/prisma-outbox-repository.ts (markProcessed, reschedule — quoted verbatim, re-confirmed)
/Users/innovera/Documents/jawbong/src/modules/outbox/domain/outbox-event.ts     (calculateBackoffMs — re-confirmed)
/Users/innovera/Documents/jawbong/package.json                                  (zod 4.4.3, @prisma/client 7.9.1, pg 8.22.0)
```

### 18.2 Commands run (all read-only)

```
$ ls -la /Users/innovera/Documents/OCR/ ; find /Users/innovera/Documents/OCR -type d
$ find /Users/innovera/Documents/jawbong/src/modules/outbox -type f
$ grep -rn --exclude-dir=node_modules -il "listen\|notify\|pg_notify" \
       /Users/innovera/Documents/jawbong/src /Users/innovera/Documents/jawbong/scripts
    -> only src/generated/prisma/** (Prisma's own types). Zero application use.
$ ls /Users/innovera/Documents/jawbong/prisma/migrations/
    -> 20260803000000_phase_00_foundation, migration_lock.toml
$ wc -l .../20260803000000_phase_00_foundation/migration.sql   -> 39
$ docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}'
$ docker ps -a --format '{{.Names}}\t{{.Image}}' | grep -i redis
    -> juneflow-linrb-redis-1, jf-lx2-redis-1, jf-w29-redis-1, jf-w26lock-redis-1 (all stopped)
```

No network connection was made to `72.62.253.185`, `52.221.213.43`, `141.98.17.91`,
`187.52.117.52`, or `153.92.4.176`. No package was installed. No container was started, stopped,
or reconfigured. No file outside `/Users/innovera/Documents/OCR` was written.

### 18.3 Library facts, with the source fetched

| Library | Version | Requires | Source |
|---|---|---|---|
| procrastinate | **3.9.0** | Python ≥ 3.10, PostgreSQL 13+ | https://pypi.org/pypi/procrastinate/json |
| — schema, functions, triggers, channels, indexes | — | — | https://raw.githubusercontent.com/procrastinate-org/procrastinate/main/procrastinate/sql/schema.sql |
| — heartbeat / stalled jobs | 10 s interval, 30 s threshold | — | https://procrastinate.readthedocs.io/en/stable/howto/production/retry_stalled_jobs.html |
| — cancel vs abort | — | — | https://procrastinate.readthedocs.io/en/stable/howto/advanced/cancellation.html |
| — sync tasks run in their own thread | — | — | https://procrastinate.readthedocs.io/en/stable/howto/basics/tasks.html |
| psycopg | **3.3.5** | Python ≥ 3.10; extras `binary`, `pool`, `c` | https://pypi.org/pypi/psycopg/json |
| pydantic | **2.13.5** (2026-08-28) | Python 3.9–3.14 | https://pypi.org/pypi/pydantic/json |
| pg-boss | **12.30.0** | Node ≥ 22.12.0; deps `pg ^8.23.0` | https://registry.npmjs.org/pg-boss/latest |
| graphile-worker | **0.18.0** | Node ≥ 22.18.0 | https://registry.npmjs.org/graphile-worker/latest |
| bullmq (Node) | **6.3.4** | Node ≥ 14.17; optional peers `ioredis>=5`, `redis>=5`, `pg>=8` | https://registry.npmjs.org/bullmq/latest |
| bullmq (Python) | **3.2.1** ⚠ *corrected in review — the draft said 2.24.0* | Python ≥ 3.10.0; **still not feature-complete** (*"the library does not support all the features available in the NodeJS version"*) but 3.x now ports FlowProducer, Lock Manager, global concurrency + rate limit, job deduplication and per-job cancellation; interoperates via shared `.lua` scripts | https://pypi.org/pypi/bullmq/json (re-fetched 2026-09-09) |
| — BullMQ Postgres backend | Postgres 13+ (14+ rec.), own schema `bullmq`, explicit `runMigrations`, **no downgrades**, Node-only | — | https://docs.bullmq.io/guide/postgresql |
| celery | **5.6.3** | Python ≥ 3.9; RabbitMQ/Redis/SQS/PubSub | https://pypi.org/pypi/celery/json |
| arq | **0.28.0** | Python ≥ 3.9; Redis; **maintenance-only mode** | https://pypi.org/pypi/arq/json |
| dramatiq | **2.2.1** | Python ≥ 3.10; Redis/RabbitMQ only, **no Postgres broker** | https://pypi.org/pypi/dramatiq/json |
| fastapi | **0.141.1** | Python ≥ 3.10 | https://pypi.org/pypi/fastapi/json |
| zod `z.toJSONSchema()` | Zod 4 built-in; `target`, `io`, `unrepresentable`, `cycles`, `reused` | — | https://zod.dev/json-schema |
| Prisma / pg (house pins) | `@prisma/client` 7.9.1 → **7.10.0** per A-4; `pg` 8.22.0; `zod` **4.4.3** | — | `/Users/innovera/Documents/jawbong/package.json` — re-read in review: lines 33/35/38/57 confirm `@prisma/client` 7.9.1, `pg` 8.22.0, `zod` 4.4.3, `prisma` 7.9.1 |

**Re-verification pass (2026-09-09, review).** Every version claim above was re-fetched from its
registry. Results:

| Claim | Draft | Re-fetched | Verdict |
|---|---|---|---|
| procrastinate | 3.9.0, py ≥ 3.10 | 3.9.0, `>=3.10` | ✅ held |
| psycopg | 3.3.5, py ≥ 3.10 | 3.3.5, `>=3.10` | ✅ held |
| pydantic | 2.13.5 (2026-08-28) | 2.13.5, released 2026-08-28 | ✅ held |
| pg-boss | 12.30.0, node ≥ 22.12.0 | 12.30.0, `{"node":">=22.12.0"}` | ✅ held |
| graphile-worker | 0.18.0, node ≥ 22.18.0 | 0.18.0, `{"node":">=22.18.0"}` | ✅ held |
| bullmq (Node) | 6.3.4, node ≥ 14.17, optional peers `pg>=8`, `ioredis>=5`, `redis>=5` | 6.3.4, `{"node":">=14.17.0"}`, optional peers `pg>=8.0.0`, `redis>=5.0.0`, `ioredis>=5.0.0`, `bullmq-otel>=2.0.0` | ✅ held (draft omitted the `bullmq-otel` peer; immaterial) |
| **bullmq (Python)** | **2.24.0** | **3.2.1**, `>=3.10.0` | ❌ **wrong by a major version** |
| celery | 5.6.3, py ≥ 3.9 | 5.6.3, `>=3.9` | ✅ held |
| arq | 0.28.0, maintenance-only | 0.28.0; description states *"arq is in maintenance only mode, see #510"* | ✅ held |
| dramatiq | 2.2.1, py ≥ 3.10, Redis/RabbitMQ only | 2.2.1, `>=3.10`, RabbitMQ + Redis extras only | ✅ held |
| BullMQ Postgres backend | first-party, `createPostgresBackend`, PG 13+ (14+ rec.), explicit `runMigrations`, no downgrades, Node-only | confirmed on docs.bullmq.io: factory `createPostgresBackend`, *"PostgreSQL 13 or newer"* with 14+ recommended, `UnsupportedPostgresVersionError` + `skipVersionCheck`, *"you must explicitly call `runMigrations(client)`"*, idempotent and concurrency-safe; the Python bindings page documents no Postgres backend | ✅ held |
| `NOTIFY` 8000 bytes | asserted, unverified | postgresql.org/docs/17/sql-notify: *"In the default configuration it must be shorter than 8000 bytes"* | ✅ **now verified** |
| `FOR UPDATE` restrictions | asserted, unverified | postgresql.org/docs/17/sql-select: *"cannot be specified with `GROUP BY`"*, *"cannot be specified with `HAVING`"*, *"cannot be used in contexts where returned rows cannot be clearly identified with individual table rows; for example they cannot be used with aggregation"* | ⚠ **consistent with the design but not proof of it** — the aggregation is in a separate CTE. Q1 still stands |
| LiteLLM 429 / `retry-after` | not in the draft (the gateway was "unknown") | LiteLLM sets `retry-after` on **its own** limits/cooldowns; forwards an upstream provider's only as **`llm_provider-retry-after`**; performs internal retries and provider fallbacks transparently to the client | ✅ new, and load-bearing for §10.4 and §16.2 |
| Zod | 4.4.3 (house pin) | npm `zod@latest` is 4.5.4; the **house pin is 4.4.3** and this document tracks the pin, not `latest` | ✅ held, with the drift noted |

### 18.4 Review-pass commands and fetches (all read-only)

```
$ sed -n / grep -n over the seven sibling m0 documents listed in §18.1
$ grep -n '"zod"|"prisma"|"@prisma/client"|"pg"' /Users/innovera/Documents/jawbong/package.json
$ sed -n '100,175p' .../prisma-outbox-repository.ts     # markProcessed + reschedule, verbatim
$ grep -n -A12 calculateBackoffMs .../domain/outbox-event.ts
```

Public documentation fetched (no production host contacted; no INNOVERA endpoint contacted):

```
https://registry.npmjs.org/bullmq/latest          https://pypi.org/pypi/bullmq/json
https://registry.npmjs.org/pg-boss/latest         https://pypi.org/pypi/procrastinate/json
https://registry.npmjs.org/graphile-worker/latest https://pypi.org/pypi/psycopg/json
https://registry.npmjs.org/zod/latest             https://pypi.org/pypi/celery/json
https://docs.bullmq.io/guide/postgresql           https://pypi.org/pypi/arq/json
https://www.postgresql.org/docs/17/sql-select.html   https://pypi.org/pypi/dramatiq/json
https://www.postgresql.org/docs/17/sql-notify.html   https://pypi.org/project/pydantic/
LiteLLM proxy rate-limit / retry-after behaviour (docs.litellm.ai + issue tracker, via search)
```

No package was installed. No container was started, stopped, or reconfigured. No file outside
`/Users/innovera/Documents/OCR` was written. No environment/secrets file was opened.

---

## 19. Critic Notes

**Review type:** adversarial completeness pass — factual verification, gap analysis, hand-waving
audit, Thai-specific blind spots, security blind spots, internal contradictions, fabrication check.
**Date:** 2026-09-09. **Outcome:** revised in place; `status: draft` → `status: reviewed`.

### 19.1 What survived

The central decision — **PostgreSQL as the queue substrate, hand-rolled `ocr_jobs`, Python consumer
via psycopg, no Redis** — survives review intact and is now better supported than it was. The
argument that carried it is the polyglot one (§4.0's three-way taxonomy) plus R15's transactional
enqueue, and neither was damaged by anything found here. The OWNER DECISION block (§5) is exactly
the artifact the brief asked for and its trigger table (T1–T5) is genuinely falsifiable.

Also strong and untouched: the jawbong outbox teardown (§2, verified verbatim against source), the
distinction between `FAILED` and `DEAD`, the fencing-token argument against dimension A's
timestamp lease, the "notification is an optimisation, the heartbeat is the guarantee" principle,
the content-addressed page checkpoint, the refusal to do cross-tenant dedupe, and the decision to
keep `/v1/extract` behind a compile-time flag rather than delete it.

### 19.2 Defects found — nine that would have shipped as bugs

| # | Where | Severity | Defect |
|---|---|---|---|
| D1 | §6.2 / §6.3 | **critical** | `ocr_jobs_no_abort_before_run` CHECK makes the reaper's set-based `UPDATE` **throw** on any aborted-then-crashed job, rolling back the reaping of every other expired job platform-wide. Constraint replaced; all three reaper passes and 4b now clear `abort_requested` |
| D2 | §13.2 | **critical** | `deadlineAt = enqueuedAt + budgetMs` terminally fails queued work under backlog with a **non-retryable** code, and compounds: those failures consume worker slots, deepening the backlog. Split into a per-claim processing budget + a separate `queue_expires_at` TTL |
| D3 | §10.2 | **high** | `dedupeKey` hashed a payload containing `jobId`, `correlationId` and `deadlineAt`, so it was unique on every call and layer-2 dedupe did nothing at all. Also, a *total* unique index would have made reprocessing permanently impossible. Canonical key + partial index |
| D4 | §14.2 / §15.1 / §7.3 | **high** | `oldest_pending_s` computed from `available_at`, which retries push forward — so the **primary SLO metric** reads healthy during exactly the retry storm it exists to catch, and admission control never engages. Changed to `created_at` in four places |
| D5 | §8.1 / §8.2 | **high** | Page `attempts` had no job scope and no expiry, so two transient `STORAGE_UNAVAILABLE` blips poisoned a page **forever** for that document — converting a retryable infrastructure error into a permanent content verdict. Added `job_attempts`, `poisoned_at` + 7-day TTL, and "only content failures poison" |
| D6 | §12 | **high** | No statement could write `CANCELLED` from `RUNNING`. Cancellations would have surfaced as `FAILED` — an error message for the user's own deliberate action, and a corrupted failure-rate alert. Added statement 4c and the complete state machine |
| D7 | §9.6 | medium | A per-error-class `maxAttempts` table with **no mechanism** — the worker cannot write `max_attempts`, so every class would have got 4. Added `$7 effective_max_attempts` bounded by `LEAST` |
| D8 | §14.2 | medium | `pending_pages` summed `policy.maxRenderPages`, a per-job **ceiling** (default 2 000), so 100 one-page receipts read as 200 000 pages and shedding logic fired against nothing. Added `est_pages` |
| D9 | §7.2 | medium | The "elastic cap" was binary: one pending job from a second organisation clamped everyone, idling half the cluster invisibly (every alert green). Replaced with a proportional max-min share |

### 19.3 Cross-document contradictions found — five

The draft reconciled with dimensions A, B, D, E and F, and opened none of G, I, J, L or N. That
single omission produced most of what follows.

1. **G defines the same job table** (`ExtractionJob`) with a different tenant column, a different
   lease mechanism, a different `maxAttempts`, and **the opposite priority direction**. §1.5,
   decisions L22/L23. This is the only `hard`-reversibility item in the document and is now Q0.
2. **G mandates `FORCE ROW LEVEL SECURITY`** and names a third role for the cross-tenant claim. The
   draft's three-role model would have produced an apparently-empty queue. §11.5, decision L24.
3. **I fixes an organisation-first storage key layout**, which makes the draft's top-level
   `orig/` / `deriv/` / `result/` credential scoping — the entire concrete content of decision L9 —
   **unimplementable**. §11.3, decision L26.
4. **L decided adaptive polling with SSE flagged off in M1**; the draft specified SSE as the M1
   path. §9.5, decision L31.
5. **N adopted this document's metrics and refined them**, subsuming `OcrNoWorkers`. §15.3 now
   defers to N, and pushes one issue back (`QUEUE_WAIT_EXCEEDED` double-paging).

### 19.4 Factual errors found

- **`bullmq` (Python) is 3.2.1, not 2.24.0** — wrong by a major version, and the draft's feature
  characterisation was correspondingly stale (3.x has FlowProducer, per-job cancellation, global
  rate limiting, job deduplication). The rejection of option B1 stands, but now rests purely on the
  Lua-script coupling argument rather than partly on a capability gap. §4.2, §18.3.
- **Every other version claim held** on re-fetch: procrastinate 3.9.0, psycopg 3.3.5, pydantic
  2.13.5, pg-boss 12.30.0, graphile-worker 0.18.0, bullmq (Node) 6.3.4, celery 5.6.3, arq 0.28.0
  (maintenance-only, quoted from its own description), dramatiq 2.2.1 (no Postgres broker), and
  BullMQ's first-party Postgres backend with `createPostgresBackend` / `runMigrations`. That is an
  unusually good hit rate and the draft deserves credit for it.
- **Two previously-unverified assertions are now verified**: the 8000-byte `NOTIFY` limit, and the
  documented `FOR UPDATE` restrictions — which are *consistent with* but not *proof of* the claim
  statement's legality, so Q1 still stands and now tests two variants.

### 19.5 Fabrication check

The draft did **not** fabricate an endpoint, port, model name, or credential — it correctly reported
them as unknown. Two softer problems were found and fixed:

- **§16's branch titles asserted "Qwen"** ("Branch T — Qwen is text-only") as though the model were
  known. It is not. B's evidence is that the *name* "Qwen" appears in INNOVERA's own source with the
  explicit rider that *"which Qwen, and what size, remain UNKNOWN"*. Branch titles now name the
  capability, not a model, and §16's preamble marks the underlying model **UNRESOLVED** while
  recording what *is* evidenced (`innovera-ai`, LiteLLM, Bearer auth, 65 536 tokens, internal Docker
  network, text-only).
- **§16's preamble was stale in the opposite direction**: it asserted the gateway's contract was
  unknown, when dimension B's reviewed revision had resolved most of it. Understating knowledge is a
  smaller sin than overstating it, but it caused a real design gap — §10.4 and §16.2 were reasoning
  about a generic "AI gateway" when LiteLLM's specific 429 / `retry-after` / internal-fallback
  behaviour is documented and load-bearing.

### 19.6 Thai-specific blind spots found

The draft's contract was *accidentally* Thai-safe in its most important respect (no Thai ever
reaches a storage key) and unsafe in six others. §9.8 now states all seven invariants as tests.

1. **NFC/NFD.** macOS clients upload filenames in NFD, everything else in NFC. The draft's dedupe
   key and idempotency hash would have produced two jobs and two invoices for the same file from a
   Mac. Highest-probability Thai bug in the design. Fixed in §10.1, §10.2, §9.8 T-2.
2. **`.max()` means different things in Zod (UTF-16 units), Pydantic (code points) and Postgres
   (characters)** — and none of them is bytes. A cross-language contract cannot declare limits in a
   unit that differs across the languages. Decision L30, §9.2.
3. **No Thai error messages.** Seven codes are `userFacing: true` in a Thai-primary product and the
   draft specified no code→message path — which is how a Thai product ends up showing English at
   precisely the frustrating moments. Added `msgKey`, `th.json`/`en.json` catalogues, CI gate 4, and
   rules on client-side interpolation and bidi isolation. §9.6.
4. **`charCount` is ambiguous for Thai** — code points vs perceived characters differ by up to a
   factor of two for stacked diacritics, and it feeds dimension E's routing threshold, so the same
   page can route differently depending on how the engine emits diacritics. Defined as NFC code
   points, with a stability test. §9.8 T-4.
5. **Thai numerals and ZWSP.** `๐–๙` must survive verbatim into `rawText` (silently normalising a
   Thai tax number to ASCII is a data-integrity failure in a legal document), and ZWSP must survive
   any sanitiser or Thai line-breaking is destroyed. §9.8 T-5, T-6.
6. **Word-level bounding boxes are meaningless for Thai** (no inter-word spaces), so `granularity`
   is recorded per result and consumers are told `line` is the only safe unit — otherwise
   `ค่าจ้าง` gets re-joined as `ค่า จ้าง`. §9.3.
7. **Thai tokenises poorly**, so a token budget calibrated on English overflows on Thai — and the
   65 536-token ceiling is a queue parameter that determines the number of billable calls. Q6, §16.1.

### 19.7 Security blind spots found

1. **The worker could read every organisation's storage keys** via table-wide `SELECT` on
   `ocr_jobs`, while the draft explicitly claimed the opposite. Decision L25 plus the per-claim
   credential of L26. §11.2, §11.3.
2. **`LISTEN` has no permission model** — *"Notifications are visible to all users"* — so the
   draft's `{jobId, tenantId, priority}` payload was a live cross-tenant metadata feed to any
   database user. Payloads reduced to empty wake-ups; abort moved to per-job channels. §6.4.
3. **Object-storage writes are not fenced and cannot be**, so a zombie worker could overwrite a good
   result object with a stale one. The draft claimed fencing covered "not a result, not progress,
   not a page row" — three of which were false. Per-attempt result keys + lease-guarded
   `result_uri`. §10.3.
4. **The `ai_calls` ledger was unfenced**, letting a zombie complete a reservation for a job it no
   longer owned — the live owner would then replay a stale response as if it were its own. §10.4.
5. **Metric labels leaked commercially sensitive data** (`ocr_ai_cost_micros_total{tenant}`) and
   carried unbounded cardinality (`ocr_queue_pending{tenant}`). §15.2.
6. **`SECURITY DEFINER` hardening** stated explicitly for the new outbox trigger: owned by
   `ocr_owner` not a superuser, pinned `search_path`, no dynamic SQL, `REVOKE EXECUTE FROM PUBLIC`.
   §11.2.1.
7. **`/metrics` and `/v1/extract` must bind, not merely not-be-routed.** "Not in the Caddy routing
   table" is a convention; a loopback bind is a control. §11.4.

### 19.8 Hand-waving replaced with mechanism

| Draft said | Now specifies |
|---|---|
| "the loop re-checks the heartbeat before the write" | an actual `WHERE EXISTS (… lease_token …)` predicate, because a re-check is a TOCTOU window |
| "handlers must be idempotent" (inherited from jawbong) | a per-write fencing table showing which writes are fenced, which are not, and what is done about each |
| a per-class `maxAttempts` table | the bind parameter and `LEAST()` ceiling that implement it |
| "make the cap elastic" | a proportional max-min share with a worked utilisation table |
| "the worker holds prefix-scoped credentials" | an actual STS session policy — and the admission that the draft's version was unimplementable under dimension I |
| "sync tasks run in their own thread … should be fine" | a `ProcessPoolExecutor` with three named reasons and the soak test that verifies it |
| "the queue still works at year two" (from partial indexes alone) | `fillfactor`, autovacuum settings, HOT-eligibility analysis, and a retention table |
| "reuse jawbong's `idempotency_records` verbatim" | RFC 8785 canonicalisation + NFC + an `IN_FLIGHT` state + `expiresAt` |
| "R4 holds by construction" | the honest statement that the cap is statistical under concurrent claims, with the bounded overshoot and an outcome-based test |

### 19.9 What remains genuinely unknowable in this session

These cannot be closed from this workstation and are **not** hidden anywhere in this document as
resolved:

1. **The literal gateway base-URL value** (host/port). It exists only in a gitignored local
   environment file on the production host. Owner-supplied.
2. **The full model list** (`GET /v1/models`), whether `innovera-ai` is the only alias, and whether
   OCR will be issued its **own** virtual key with its own budget. Owner plus a probe.
3. **The underlying model identity and size.** "Qwen" is evidenced as a name only.
4. **LiteLLM deployment specifics**: idempotency-key support (assume none), exact rate-limit header
   names, the internal retry/fallback worst-case duration, and whether billing is on completion or
   on tokens generated. All require the endpoint.
5. **Whether the §6.3 claim statement executes on PostgreSQL 17.** The documentation is consistent
   with it but does not settle it, and no PostgreSQL 17 instance was started in this session — the
   two running Postgres containers belong to other projects and were not touched. Q1.
6. **Every timing number in §13.** No benchmark was run; dimension D owns the corpus.
7. **Thai characters-per-token** on the deployed model. Q6.
8. **Whether the object-storage backend supports per-request scoped credentials.** Decision L26
   depends on it; dimension I owns the adapter interface. Q8.
9. **Whether `pg_column_size` in a CHECK measures what §6.2 wants**, and whether a `SECURITY
   DEFINER` trigger composes with `FORCE ROW LEVEL SECURITY` on `outbox_events`. Both need the same
   throwaway container as Q1.

### 19.10 Confidence after review

| Area | Confidence | Note |
|---|---|---|
| Substrate choice (Postgres, no Redis) | **high** | strengthened; the owner-decision block is sound and its triggers are falsifiable |
| Claim / lease / fencing protocol | **medium-high** | correct in design; Q1 unproven, and the in-flight cap is statistical, not absolute |
| Contract schemas (payload, result, errors) | **high** | now byte-length-correct, geometry-carrying, and i18n-capable |
| Credential separation | **medium** | the *shape* is right; L26 depends on Q8 |
| Cross-document coherence | **low until Q0 closes** | G and H must agree on one table, one tenant column and one priority direction before any migration is written |
| AI-gateway integration | **medium** | contract known, endpoint and billing behaviour not |
| Every number in §13 | **low, by construction** | explicitly configuration, explicitly uncalibrated |
