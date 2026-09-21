---
dimension: f3-ai-call-placement
title: Where the LiteLLM call happens — the AI call owner, the network map, and the credential boundary
status: canonical
date: 2026-09-09
supersedes:
  - docs/architecture/m0/b-ai-topology-discovery.md §2.4 (decision B-2) — the network/credential table
  - docs/architecture/m0/h-queue-and-worker-contract.md §10.4, §11.2 (ai_calls grant), §13.1 (ai_extract row), §16 (worker-reaches-gateway)
  - docs/architecture/m0/i-storage.md §8 (branch framing only; the B1 storage decision survives)
  - docs/architecture/m0/j-security-threat-model.md §6.10 (the conditional two-row placement table) and decision-register row D6's reversal trigger
  - docs/architecture/m0/k-ai-integration-and-intelligence.md §2.1 (the process that runs the tree; the tree itself survives verbatim) and §2.7 (Redis breaker state)
  - docs/architecture/m0/m-docker-nginx-resources.md §2.1 (service inventory), §2.2 (compose network/secret attachments), §2.5.1, §2.5.3, §2.5.4
  - docs/architecture/m0/a-environment-and-stack.md §9 ("neither branch is chosen here") — the placement half only
---

# F3 — AI call placement

> **Integration status (2026-09-12):** Read the [architecture index](../README.md) and its consolidation report before using these examples. Individual review labels do not close cross-document conflicts; no application implementation is verified.

**What this document decides.** Exactly one thing, and everything that mechanically follows from it:
**which operating-system process opens the socket to the INNOVERA LiteLLM gateway.** The adversarial
panel scored this as the single most migration-time-expensive open item in M0 — it decides *"the
grant script, the RLS policies, the compose networks, the error taxonomy's owner, and the stage-
timeout table"* (`z-adversarial-panel.md` P3, operations lens) — and it is currently answered three
mutually exclusive ways in four documents that each carry a `status: reviewed` stamp.

**What this document does not decide.** It does not touch the AI *layer's* design. K's module tree,
Zod contract, prompt versioning, chunking algebra, provenance verifier and template compiler are
correct and survive **verbatim**; only the process that executes them changes. It does not restate
the gateway env contract, the minimisation rules, the readiness principle or the erasure mechanism —
those are owned by `gate-2-pdpa-retention.md §9` and are cited, never repeated.

## 0.1 Frozen values this document consumes (cited, never restated)

| Value | Owner | Used here for |
|---|---|---|
| `LITELLM_BASE_URL`, `LITELLM_API_KEY` (a **virtual key**) | `gate-2-pdpa-retention.md §9` (`ai.gateway.base_url`, `ai.gateway.api_key`) | The secret this document assigns to exactly one container |
| `OCR_AI_STAGE_ENABLED`, default `false` | `gate-2-pdpa-retention.md §9` (`ai.stage.enabled.default`) | The enable/disable flag. **This document does not mint a competing name** — see §7 C-1 |
| `ai.readiness.participation = none` | `gate-2-pdpa-retention.md §9` | The readiness principle. This document defines the per-service contract that implements it |
| `ai.boundary.pixels = never` | `gate-2-pdpa-retention.md §9` | Structurally enforced here by a volume boundary, not only by a type (D-F3-6) |
| `GATE1_CREDENTIAL_ISSUANCE = BLOCKED` | `gate-1-litellm-supply-chain.md §CANONICAL VALUES` | Why the key does not exist yet and the AI service ships inert |
| `AI_NETWORK_NAME`, default `innovera_default`; the shared AI Docker network; chat-db is deliberately kept off it | Verified INNOVERA Chat contract (session ground truth) | The external network name our compose references |
| `CHAT_UPSTREAM_TIMEOUT_MS = 540000` | Verified INNOVERA Chat contract | The operator's own measured upstream ceiling; adopted as our per-call timeout (D-F3-5) |
| 65,536-token model ceiling | Verified INNOVERA Chat contract | Bounds the chunk count that drives the job budget |
| Lease 120 s / heartbeat 30 s, the four-statement claim protocol, `ocr_jobs` schema, the `ai_calls` ledger shape | `h-queue-and-worker-contract.md` §6.3, §13.1, §10.4 | Reused unchanged by the new consumer |
| `src/modules/intelligence/**` tree, `AiProvider` port, K-15 (no streaming), K-24 (`bad_request`), `maxCallsPerDocument = 12` | `k-ai-integration-and-intelligence.md` §2.1–2.3, §1 | Runs unchanged in the new process |

---

## 1. The contradiction, tabulated

The panel is right that this is not one decision stated three ways; it is three decisions, each
written by an author who had not read the others.

### 1.1 The three asserted positions

| # | Position | Asserted by | Exact section and words |
|---|---|---|---|
| **A** | **`ocr-web` (Next.js) owns the call. The Python worker never talks to LiteLLM.** | `b-ai-topology-discovery.md` §2.4, decision **B-2** | *"**`ocr-web` is the only process in the system that holds an AI credential or opens a socket to the gateway.** `ocr-worker` (Python) performs deterministic OCR and returns text; it gets **no** AI credential and **no** network route to the gateway."* Table: `ocr-web \| joins innovera_default: yes \| holds LITELLM_API_KEY: yes — sole holder`; `ocr-worker \| no \| no`. |
| **A** | same | `m-docker-nginx-resources.md` §2.1 (service inventory), §2.5.1 (topology diagram), §2.5.3, §2.5.4 | §2.1: `ocr-web … **the only holder of an AI credential**`, networks `ocr-internal + ocr-egress`; `ocr-worker … ocr-internal only`. §2.5.3 heading *"Does `ocr-worker` get egress?"* → *"**No.**"*, holding in **both** branches, and *"Rejected: letting the worker call the gateway directly … the worker is the process that parses attacker-supplied files — it is precisely the process that must not hold a network credential … the exact shape of an exfiltration primitive."* **Already baked into a compose flag:** `networks: [ocr-internal]  # ← the ONLY network. No egress.` on `ocr-worker`; `secrets: [ai_gateway_key]` mounted only into `ocr-web`; `ocr-internal: { internal: true }`. |
| **A** | same, implicitly | `k-ai-integration-and-intelligence.md` §2.1 | The entire layer is a TypeScript tree at `src/modules/intelligence/{domain,application,infrastructure}` with `infrastructure/ai/litellm-openai.adapter.ts` — *"the **ONLY** implementation"* — enforced by dependency-cruiser + `eslint-plugin-boundaries`, persisted by Prisma (`DocumentAnalysis`, `AiCallLog`). Node-only APIs (`fetch` with `redirect`, undici `connect.lookup`, Zod 4.4.3). Nothing in it is portable to Python. |
| **B** | **`ocr-worker` (Python) owns it, as one more pipeline stage.** | `h-queue-and-worker-contract.md` §6.2, §10.4, §11.2, §13.1, §16 | §6.2: `enum OcrJobKind { DOCUMENT_EXTRACT AI_EXTRACT }` with **no `kind` predicate** on the §6.3 claim, so the Python worker claims `AI_EXTRACT` rows unconditionally. §10.4: the reserve→call→complete protocol written as Python — `response = await gateway.complete(...)   # <-- the only place money is spent`. §11.2: `GRANT SELECT, INSERT, UPDATE ON ai_calls TO ocr_worker;`. §13.1: `\| ai_extract \| 180 s \| per call \|` **inside the worker's per-stage timeout table**. §16: *"The worker reaches the gateway over `innovera_default` … the gateway is **not** reachable from the worker unless the worker container is explicitly attached to that network — which is an item for dimension M's compose file, and a hard dependency of every `ai_extract` stage timeout in §13.1."* |
| **B** | same, conditionally | `j-security-threat-model.md` §6.10 row 1 | *"If the gateway can join `ocr-internal` → the call is made by **the worker** … `AI_*` credentials exist **only** in the worker's environment; the web tier never has them."* And it **explicitly rejects A**: *"Rejected: the **web tier** making the call … it gives the internet-facing, session-handling, largest-attack-surface component an outbound network capability and a long-lived credential … Moving egress from the low-exposure component to the high-exposure one is the wrong direction."* |
| **C** | **A dedicated single-purpose service.** | `j-security-threat-model.md` §6.10 row 2 | *"If the gateway cannot join `ocr-internal` → **a dedicated `ai-egress` service**, not the web tier … The worker calls `ai-egress` over `ocr-internal`; only `ai-egress` has egress, and only to one pinned address:port."* Shape: an **HTTP proxy** the worker calls. Appears in exactly one file; M and K never mention it. |

### 1.2 The internal contradictions inside the contradiction

Four more, all load-bearing, none of which any single document notices:

1. **J contradicts itself.** §6.10's table maps *unreachable → `ai-egress`, never the web tier*;
   J's own decision register row **D6** records the reversal trigger as *"The AI gateway proving
   unreachable internally → **the web tier makes the call**, or a single-purpose pinned egress
   proxy"*. Two mappings, one document.
2. **B's evidence selects the row M rejects.** B E8/E9 place the gateway on an **internal Docker
   network** (`innovera_default`), and B §2.3 calls co-location on the GPU host the most likely
   topology. That is exactly J §6.10's row 1 — *the worker makes the call* — i.e. the option
   B's own §2.4 forbids.
3. **M's compose cannot execute A as B describes it.** B §2.4's table has `ocr-web` joining
   `innovera_default`. M's compose file contains **no such network**: `ocr-web` is on `ocr-egress`,
   an ordinary NAT'd bridge to the whole internet (§2.2 `ocr-egress: { internal: false, subnet:
   172.29.0.0/16 }`). A is therefore itself implemented two ways — *shared internal bridge* (B) and
   *NAT to a public endpoint* (M) — which are different security postures and different failure
   modes.
4. **K was written against a topology that does not exist.** K §2.7: *"scaling past ~3 worker
   instances → move breaker state to **the same Redis that holds the job queue**."* There is no
   Redis: `h` L1 chose Postgres as the queue substrate and `m` §2.1 lists `ocr-redis` as **not
   built**.

### 1.3 Why neither live candidate works as the documents stand

| Resolve toward… | What breaks |
|---|---|
| **A (`ocr-web`)** | `AI_EXTRACT` is a row in `ocr_jobs`. The only claim statement is `h` §6.3, and the only role with the cross-organisation RLS exception is `ocr_worker` (`h` §11.5, `CREATE POLICY queue_all_orgs … TO ocr_worker USING (true)`). `ocr_app` is pinned to `tenant_id = current_setting('app.current_org')` and its claim returns **zero rows** — *"the queue would appear to be permanently empty, on a system where every other test passes."* Beyond RLS: read literally (a Next.js request handler), the one billable stage runs with **no lease, no fencing token, no heartbeat, no attempt counter, no DLQ, no budget clock**, and `h` §10.4's `complete_ai_call … WHERE … lease_token = $tok` has no holder, so R6 ("forced double-claim ⇒ exactly one `ai_calls` row") tests a path that no longer exists. |
| **B (`ocr-worker`)** | Hands an outbound socket and a long-lived bearer credential to the one process whose entire job is opening attacker-supplied PDFs, TIFFs and images, on a **shared multi-tenant Docker bridge that also carries INNOVERA Chat**. `j` rates decoder RCE a continuous CVE class and document-borne prompt injection *Critical / near-certain at scale*; `j` §5.6 states the test directly — *"ask what a decoder RCE needs to be valuable: an outbound channel."* It also breaks the derived control that model weights are baked at build time with no runtime download (`j` D7). |
| **C as written (`ai-egress` HTTP proxy)** | Adds a second at-least-once boundary and a new authenticated internal endpoint that accepts arbitrary payloads — precisely the cost `h` §11.1 spent a section rejecting for the worker split, and it collides with `h` §11.4, which compiles the worker's `/v1/extract` **out at import time** in production with a CI grep asserting `OCR_ENABLE_TEST_HTTP` appears in no prod compose file. |

**The crux, stated once.** The worker is the process that opens attacker-controlled bytes. Egress
from *that* process is the largest blast radius in the system, and three documents (B, J §5.6, M)
independently refuse it. But `ocr-web` is not the low-exposure alternative it was assumed to be: it
is internet-facing, session-handling, renders attacker-influenced OCR text into a review UI, and M
§2.5.4 already concedes in writing that under A it holds *"the only credential worth stealing"* on
*"an ordinary NAT'd bridge"* to the whole internet with *"log every outbound gateway call"* as the
sole M1 control. The decision below refuses to pick the least-bad of two bad options.

---

## 2. The decision axes, evaluated

### 2.1 Network topology — the decisive axis

Chat's own rule is that `chat-db` must **not** join the shared AI network, *"otherwise everything on
that network can reach the database"*. Mirror it, and then ask the same question of every service:

| If this service joins the shared AI network… | …what becomes reachable from a compromise of it |
|---|---|
| `ocr-worker` | Every member of `innovera_default` (INNOVERA Chat, the gateway, anything else the operator has deployed there), **plus** the gateway credential, **plus** `ocr_file_storage` (every organisation's original uploads, mounted), **plus** `ocr_jobs.payload` for every organisation (`h` L25's admitted hole). Reached by a malformed PDF. |
| `ocr-web` | Every member of `innovera_default`, plus the gateway credential, plus session state, plus `ocr_file_storage`. Reached over HTTP by any authenticated tenant, through the largest attack surface in the system (`j` A01 rates IDOR and the Next middleware bypass CVE-2025-29927 *"the dominant risk"*). |
| A process that parses **no files**, terminates **no user connection**, and mounts **no original-document volume** | Every member of `innovera_default`, plus the gateway credential, plus the assembled text of documents currently in flight. Reached only by first compromising something else. |

The third row is strictly smaller than the other two on every dimension that matters, and no
argument in B, J or M applies to it. That is the answer.

### 2.2 The remaining axes

| Axis | Finding |
|---|---|
| **DB credentials / does the AI stage need DB access at all** | Yes — it must claim from `ocr_jobs` and write the `ai_calls` ledger, or the billable stage loses its lease, fence and idempotency. It needs **no** grant on `documents`, `ocr_page_results`, `users`, or any content table. That is a role, not a container: PostgreSQL roles are per-connection. |
| **540 s inside a request handler vs a job** | Non-negotiable in favour of a job. `CHAT_UPSTREAM_TIMEOUT_MS = 540000` is the operator's own measured upstream ceiling, and K's `maxCallsPerDocument = 12` makes the worst case a multi-call loop. A Next.js request handler has no lease, no heartbeat, no attempt counter, and a deploy restart loses the work silently with nothing to retry it. |
| **Retry / idempotency ownership** | The `ai_calls` ledger (`h` §10.4) is the only defence against double-billing — LiteLLM has no request-level idempotency and its internal upstream retries can bill twice behind our timeout. Its fence is `WHERE … lease_token = $tok AND state='RUNNING'`, so the caller **must** be a lease-holding queue consumer. |
| **Does an AI retry re-run OCR?** | It must not. Under B (worker owns it) `AI_EXTRACT` sits inside the worker's job graph and an AI failure re-enters the worker's stage table; the split below makes AI_EXTRACT a **separate job row** whose retry cannot touch OCR (D-F3-8). |
| **Error taxonomy owner / stage-timeout table** | Both currently live in the worker's file (`h` §9.6, §13.1). The AI codes' emitter must move with the socket. |
| **Chunk / map-reduce partial state** | K's map→reduce writes per-chunk results between calls. They must live where the caller can replay them after a crash without a second gateway charge → object storage keyed by the ledger's idempotency key, written **before** the DB commit (`h` §10.4 mitigation 1). |
| **Streaming** | Not needed, and actively unwanted: K-15 already decided no streaming for extraction, and a grammar-constrained JSON response has nothing useful to stream. Consequence recorded in D-F3-5. |
| **Secret blast radius** | The credential must exist in exactly one container's filesystem, mounted from a compose `secret`, never in `docker inspect`, never inherited by a child process, never in `env_file`. |
| **Operational scaling** | OCR is CPU-bound (`h` §16.1: *"backpressure bottleneck: **CPU**"*); the AI stage is network-bound and its concurrency is capped by the gateway's virtual-key `max_parallel_requests`, not by our CPU. Scaling one by scaling the other wastes 1.5 vCPU + 3 GiB per unit of AI concurrency, or throttles OCR to protect Chat. They must be separately scalable. |

---

## 3. D-F3-1 — The AI call owner

**Competing proposals.** A: `ocr-web` (B-2, M §2.1/§2.5.3, K §2.1). B: `ocr-worker` (H §10.4/§11.2/
§13.1/§16, J §6.10 row 1). C: a dedicated service (J §6.10 row 2, as an HTTP proxy).

**Selected.** **C, in a queue-consumer shape, not a proxy shape.**

> A new fourth application service, **`ocr-ai-worker`**, is the sole process in the system that
> opens a socket to the LiteLLM gateway and the sole holder of `LITELLM_API_KEY`. It is a Node 22
> container built from **the same repository and the same Dockerfile as `ocr-web`** (a new
> `target: ai-worker`), whose composition root is `src/workers/ai-extract/` and which runs
> `k-ai-integration-and-intelligence.md` §2.1's `src/modules/intelligence/**` tree **unchanged**.
> It claims `ocr_jobs` rows with `kind = 'AI_EXTRACT'` **only**, using
> `h-queue-and-worker-contract.md` §6.3's four-statement protocol **unchanged**, holding a real
> lease and fencing token.

**Rejected alternatives, and why.**

| Rejected | Reason |
|---|---|
| **A1 — `ocr-web` request handler** (K §2.1 read literally) | The one billable, non-idempotent stage in the system would run with no lease, no fencing token, no heartbeat, no attempt counter, no DLQ and no budget clock. `h` §10.4's `complete_ai_call` fence has no holder, so R6 is untestable. A deploy restart mid-analysis loses paid work silently and nothing retries it. |
| **A2 — a queue claimer inside `ocr-web`** (`src/workers/**`; the panel's operations-lens Option 1 — the strongest runner-up) | Keeps the internet-facing, session-handling tier on an egress network holding the only credential worth stealing — M §2.5.4's own admitted, unfixed residual. Couples AI concurrency to HTTP-serving capacity: scaling AI means scaling the tier NGINX proxies to. Reduces role separation from a container boundary to a code convention (both DSNs sit in one process's environment). And it forces `ocr-web` to keep NAT egress forever, so every future outbound integration inherits an already-widened hole. |
| **B — `ocr-worker`** | Gives an outbound socket and a long-lived bearer credential to the process that parses attacker-supplied files, on a shared multi-tenant bridge carrying INNOVERA Chat. Refused independently by `b` §2.4, `j` §5.6 and `m` §2.5.3; the exfiltration primitive `j` names explicitly. Also requires attaching `ocr-worker` to a second network, demolishing `ocr-internal: { internal: true }` — the control M calls *"the load-bearing line"*. |
| **C-as-written — `ai-egress` HTTP proxy** (J §6.10 row 2) | Adds a second at-least-once boundary and a new authenticated internal endpoint accepting arbitrary payloads (`h` §11.1's decisive cost against HTTP-callback designs), and requires a production worker HTTP surface that `h` §11.4 compiles out by construction with a CI grep. A queue consumer needs **no** new HTTP surface at all. |
| **A separate repository for the AI service** | Loses K's shared Zod contract as the single source of truth (K-2), splits the migration owner, and contradicts `a` ADR-001. The chosen shape is one repo, one migration owner, one Zod contract, two composition roots — which `a` decision **A-5** already created `src/workers/**` for. |

**Reason.** It is the only option under which *no* process holds both a gateway credential and a
high-exposure input surface. The hostile-file parser keeps zero egress (B/J/M satisfied). The
internet-facing tier keeps zero egress and zero AI credential — a **strict improvement** on A, which
M §2.5.4 concedes it cannot make. Every property H's queue exists to provide (lease, fencing token,
heartbeat, attempt counter, DLQ, budget clock, per-tenant fairness, `queue_expires_at`, backpressure,
cooperative abort) applies to the billable stage unchanged. K's tree ships verbatim in the language
it was written in. And the cost is small and concrete: one compose service, one Dockerfile target,
one DB role, one migration — **no new codebase, no new language, no new dependency set, no new HTTP
endpoint, no new datastore**.

**Implementation consequence.**
- New Dockerfile target in `docker/web.Dockerfile`: `target: ai-worker`, entrypoint
  `node dist/workers/ai-extract/main.js`. Built from the same `pnpm install --frozen-lockfile` layer
  as `runtime`; no Next.js server, no `.next` output, no public assets.
- New composition root `src/workers/ai-extract/` under `a` A-5's `workers` boundary element. The
  existing dependency-cruiser rules `workers-are-transport-free` and `app-does-not-import-workers`
  apply with no change.
- K §2.1's rule *"`src/app/**` may not import `infrastructure/ai/**`"* stops being only a lint rule
  and becomes a **process boundary**: `src/app` and the LiteLLM adapter no longer run in the same
  container.
- `h` §6.3 statement 1 gains `AND j.kind = ANY($k)`; the Python worker passes
  `{'DOCUMENT_EXTRACT'}` and `ocr-ai-worker` passes `{'AI_EXTRACT'}`. Without this predicate
  *"just do not give the worker AI work" is not expressible*.
- Fan-in from `DOCUMENT_EXTRACT` to `AI_EXTRACT` is unchanged (`h` §8.3's `ocr_fan_in_v1`
  `SECURITY DEFINER` function), gated on `OCR_AI_STAGE_ENABLED` (D-F3-9).

**Migration consequence.** Three migration-time artefacts change, all before the first `prisma
migrate deploy`: (i) the role/grant script gains `ocr_ai_worker` and **loses**
`GRANT … ON ai_calls TO ocr_worker`; (ii) the RLS policy set gains `queue_ai_all_orgs`; (iii) the
compose file gains one service, one network, one volume and moves one secret. No table is added or
dropped, no column type changes, and `ai_calls` keeps H's shape including `idempotency_key UNIQUE`.
Because these are grants and networks, not data, the change is **reversible by re-running the grant
script** — but only until the first production key is issued, after which reverting means rotating
it.

**Security consequence.** The credential blast radius drops from *"the process that opens hostile
PDFs"* (B) or *"the process that terminates internet TLS sessions"* (A) to *"a process with no
parser, no listener facing users, and no mount of original-document storage"*. `ocr-web` loses
egress entirely and fails closed on any future accidental outbound call. `ocr-worker` is unchanged.
`ocr-db` stays off the shared AI network, mirroring Chat's own isolation rule. Residual, stated
plainly: `ocr-ai-worker` joins a **shared, multi-tenant** Docker bridge, so a compromise of it can
reach every other member of that bridge, and it can read the assembled text of documents currently
in flight (`ocr_ai_spool`). That residual is real, is smaller than either alternative's, and is the
one this document accepts.

**Config/env consequence.** See §8. `LITELLM_BASE_URL`, `LITELLM_API_KEY_FILE`,
`OCR_AI_MODEL_ALLOWLIST` and every other `LITELLM_*`/`OCR_AI_*` variable are declared on
`ocr-ai-worker` **and nowhere else**. `ocr-web` reads exactly one AI-related variable —
`OCR_AI_STAGE_ENABLED` — because it decides whether to enqueue; it never learns the endpoint, the
key, the model or the allowlist.

---

## 4. Consequences, specified

### 4.1 D-F3-2 — The per-service network attachment map

**Competing proposals.** M §2.2's two-network map (`ocr-internal` internal-only, `ocr-egress` NAT,
`ocr-web` on both) vs B §2.4's map (`ocr-web` on `innovera_default`) vs H §16's request to attach
`ocr-worker` to `innovera_default`.

**Selected.** A three-network map. `ocr-internal` and `ocr-egress` keep M's names, semantics and
pinned subnets; a third network `ai-shared` is the **pre-existing external** shared AI bridge.

| Service | `ocr-internal`<br>`internal: true`<br>172.28.0.0/16 | `ai-shared`<br>external `${AI_NETWORK_NAME:-innovera_default}` | `ocr-egress`<br>`internal: false`<br>172.29.0.0/16 | Internet-reachable? |
|---|:--:|:--:|:--:|:--:|
| `ocr-db` | ✅ | ❌ | ❌ | **no** |
| `ocr-migrate` | ✅ | ❌ | ❌ | **no** |
| `ocr-web` | ✅ | ❌ | ❌ | **no** (changed — M put it on `ocr-egress`) |
| `ocr-worker` | ✅ | ❌ | ❌ | **no** (unchanged) |
| **`ocr-ai-worker`** | ✅ | ✅ | ❌ | **no** — reaches the gateway as a bridge peer, not via NAT |
| `ocr-clamd` | ✅ | ❌ | ❌ | **no** |
| `ocr-freshclam` | ✅ | ❌ | ✅ | yes (signature updates only) |
| `ocr-backup` | ✅ | ❌ | ✅ | yes (off-box push only) |

**Rejected alternatives.** (i) Putting `ocr-ai-worker` on `ocr-egress` (NAT to the whole internet)
instead of the shared bridge — rejected because B E8/E9 evidence the gateway as an internal peer, so
NAT grants reachability we do not need and cannot revoke. (ii) Keeping `ocr-web` on `ocr-egress`
"just in case" — rejected: an unused egress path is a hole nobody reviews, and `internal: true`
turns any future accidental outbound call into a loud boot-time or first-call failure instead of a
silent exfiltration path.

**Reason.** `ocr-egress` now carries only two services, neither of which holds a gateway credential
or terminates a user session. Every credential-bearing or user-facing service is on a network with
no default route and no MASQUERADE rule.

**Implementation consequence.** Compose excerpt (additions and changes only; everything not shown is
unchanged from `m` §2.2):

```yaml
services:
  # ---------------------------------------------------------------------------
  # ocr-web — Next.js. CHANGED: no egress network, no AI secret, no AI env
  # beyond the OCR_AI_STAGE_ENABLED enqueue switch.
  # ---------------------------------------------------------------------------
  ocr-web:
    environment:
      OCR_AI_STAGE_ENABLED: ${OCR_AI_STAGE_ENABLED:?set true|false explicitly — never implied}
    networks: [ocr-internal]          # ← CHANGED from [ocr-internal, ocr-egress]
    # secrets: [ai_gateway_key]       # ← REMOVED. See ocr-ai-worker.

  # ---------------------------------------------------------------------------
  # ocr-ai-worker — Node 22. The ONLY process that opens a socket to LiteLLM and
  # the ONLY holder of LITELLM_API_KEY. No file parsers. No user-facing listener.
  # No mount of ocr_file_storage — page images are structurally unreachable
  # (gate-2-pdpa-retention.md §9 `ai.boundary.pixels`).
  # Started only under the `ai` profile; see D-F3-9.
  # ---------------------------------------------------------------------------
  ocr-ai-worker:
    profiles: [ai]
    build:
      context: .
      dockerfile: docker/web.Dockerfile
      target: ai-worker
    image: innovera/ocr-ai:${OCR_VERSION:-dev}
    depends_on:
      ocr-db:      { condition: service_healthy }
      ocr-migrate: { condition: service_completed_successfully }
    environment:
      TZ: ${TZ:-Asia/Bangkok}
      DATABASE_URL:              ${AI_WORKER_DATABASE_URL:?set AI_WORKER_DATABASE_URL (ocr_ai_worker role)}
      OCR_AI_STAGE_ENABLED:      ${OCR_AI_STAGE_ENABLED:?set true|false explicitly}
      LITELLM_BASE_URL:          ${LITELLM_BASE_URL:-}
      LITELLM_API_KEY_FILE:      /run/secrets/litellm_api_key
      OCR_AI_SPOOL_ROOT:         /data/ai
      OCR_AI_METRICS_PORT:       "8412"
      OCR_AI_WORKER_CONCURRENCY: "2"
      OCR_AI_CALL_TIMEOUT_MS:    "540000"
      OCR_AI_CONNECT_TIMEOUT_MS: "5000"
      OCR_AI_CALL_STALE_MS:      "1080000"
      NEXT_TELEMETRY_DISABLED:   "1"
    secrets: [litellm_api_key]
    volumes:
      - ocr_ai_spool:/data/ai            # rw. The ONLY document-derived data it can reach.
    expose: ["8412"]                     # documentation + intra-network hint; publishes nothing
    healthcheck:                          # LIVENESS ONLY — never /readyz, never the gateway
      test: ["CMD","node","-e","fetch('http://127.0.0.1:8412/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s
    <<: *hardening
    read_only: true
    tmpfs: ["/tmp:size=64m,mode=1777,noexec,nosuid,nodev"]
    pids_limit: 128
    stop_grace_period: 90s               # < the 120 s lease, per h §13.1's reasoning
    restart: unless-stopped
    networks: [ocr-internal, ai-shared]
    logging: *default-logging
    deploy:
      replicas: 2                        # OCR_AI_WORKER_REPLICAS; see D-F3-7
      resources:
        limits:       { cpus: "0.5", memory: 512M }
        reservations: { memory: 192M }

  ocr-worker:
    volumes:
      - ocr_ai_spool:/data/ai            # rw — the assemble stage writes the AI input here

networks:
  ai-shared:
    external: true
    name: ${AI_NETWORK_NAME:-innovera_default}

volumes:
  ocr_ai_spool: {}   # assembled, minimised document text awaiting AI. Retention: D-F3-6.

secrets:
  litellm_api_key: { file: ./secrets/litellm_api_key }   # replaces m §2.2's ai_gateway_key
```

**Migration consequence.** `ai-shared` is `external: true`, so `docker compose up` **fails loudly**
if the network does not exist on the target host rather than silently creating an empty one. That is
the desired behaviour: it converts OWNER-BLOCKED B-1 (§7) from a runtime mystery into a deploy-time
error. Under the default `OCR_AI_STAGE_ENABLED=false`, the `ai` profile is not activated and the
service is never started, so the whole stack deploys today with no `ai-shared` network present.

**Security consequence.** Verified by two deploy gates, not by prose (§6).

**Config/env consequence.** `AI_NETWORK_NAME` is consumed here, owned by the verified Chat contract.

---

### 4.2 D-F3-3 — The credential holder and the DB role

**Competing proposals.** M §2.2: `secrets: [ai_gateway_key]` on `ocr-web`, env name
`AI_GATEWAY_API_KEY_FILE`. J §6.10: `AI_*` credentials only in the worker's environment. B-5 and the
verified Chat contract: `LITELLM_API_KEY`.

**Selected.** `LITELLM_API_KEY_FILE=/run/secrets/litellm_api_key`, mounted into **`ocr-ai-worker`
only**, read once at boot, never re-read. The `_FILE` convention and the "no `env_file:` anywhere"
rule are M §2.5.4's and are adopted unchanged; only the holder and the variable name change. A
fourth DB role, `ocr_ai_worker`, is introduced.

**Rejected alternatives.** (i) `AI_GATEWAY_API_KEY_FILE` (M's name) — rejected: the verified Chat
`DEPLOYMENT.md` says `LITELLM_API_KEY`, and *"an operator who deploys both apps on the same host must
not learn two vocabularies"* (B-5). (ii) A plain env var rather than a secret file — rejected: env
vars appear in `docker inspect`, in `/proc/1/environ`, and in a crash dump of the parent. (iii)
Reusing `ocr_worker` for the AI consumer — rejected: it would give the hostile-file parser the
`ai_calls` ledger and the AI job rows.

**Reason.** One container, one credential, one variable name that matches the estate.

**Implementation consequence.** Role and grant shape (`g`/`h` own the final DDL; this is the
required shape, and it is **derived from the statements the role executes**, which the panel showed
`h` §11.2's list was not):

```sql
-- Role 4. Deny-by-default.
CREATE ROLE ocr_ai_worker LOGIN PASSWORD :'ai_worker_pw';
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ocr_ai_worker;
GRANT USAGE ON SCHEMA public TO ocr_ai_worker;

-- The ledger is the only table it touches directly: it must read it to replay
-- a COMPLETED reservation instead of paying twice.
GRANT SELECT, INSERT, UPDATE ON ai_calls TO ocr_ai_worker;

-- Claim / heartbeat / complete / abort / analysis-write are SECURITY DEFINER
-- functions owned by ocr_owner, which validate (job_id, lease_token) and derive
-- tenant_id server-side. Same pattern as h §11.2.1's outbox trigger. This
-- collapses the column-audit problem the panel found in h §11.2 permanently.
GRANT EXECUTE ON FUNCTION
  ocr_ai_claim_v1(uuid, int),
  ocr_ai_heartbeat_v1(uuid, uuid),
  ocr_ai_complete_v1(uuid, uuid, jsonb, text),
  ocr_ai_abort_v1(uuid, uuid, text)
TO ocr_ai_worker;

-- RLS: narrower than ocr_worker's USING(true). It cannot see OCR jobs at all.
CREATE POLICY queue_ai_all_orgs ON ocr_jobs FOR ALL TO ocr_ai_worker
  USING (kind = 'AI_EXTRACT') WITH CHECK (kind = 'AI_EXTRACT');
CREATE POLICY ledger_ai_all_orgs ON ai_calls FOR ALL TO ocr_ai_worker
  USING (true) WITH CHECK (true);

-- SUPERSEDES h §11.2: the hostile-file parser is no longer the ledger writer.
REVOKE ALL ON ai_calls FROM ocr_worker;

-- INVARIANT: ocr_app NEVER receives a cross-organisation policy on ocr_jobs or
-- ai_calls. It keeps `tenant_id = current_setting('app.current_org')` forever.
```

**Migration consequence.** One migration adds the role, four functions, two policies and one revoke.
`ai_calls` keeps H's shape unchanged, so R6's test survives verbatim with the emitter swapped.
K's `AiCallLog` Prisma model — which has **no unique constraint** and would have made R6 untestable
— is deleted; `ai_calls` is the single ledger. **One ledger, not two.**

**Security consequence.** The AI consumer cannot read `documents`, `ocr_page_results`, `users`,
`sessions`, `api_keys` or any storage key. It cannot see a `DOCUMENT_EXTRACT` row. Its analysis
write cannot forge a `tenant_id` because the function derives it from the leased job row. And `g`'s
third tenant-isolation layer is preserved for the internet-facing tier, which the A2 resolution
would have had to delete.

**Config/env consequence.** `AI_WORKER_DATABASE_URL` (role `ocr_ai_worker`) is declared on
`ocr-ai-worker` only, exactly as `WORKER_DATABASE_URL` is on `ocr-worker`.

---

### 4.3 D-F3-4 — The readiness and health contract

**Competing proposals.** M §2.2 healthchecks; `n` N16 excluding the gateway from `/readyz`;
gate-2's `ai.readiness.participation = none`.

**Selected.** Gate 2's principle, implemented per service. **No probe of LiteLLM appears in any
liveness or readiness endpoint, in any Docker healthcheck, or in any `depends_on` condition, in any
service.**

| Service | Liveness | Readiness | LiteLLM referenced? |
|---|---|---|---|
| `ocr-web` | `GET /api/v1/health` — process alive, no I/O | `GET /api/v1/ready` — DB reachable + migration version matches | **never** |
| `ocr-worker` | `:8411/healthz` (owned by `h` §11.4) | `:8411/readyz` (owned by `h` §11.4) | **never** |
| `ocr-ai-worker` | `:8412/healthz` — event loop responsive, claim loop not wedged (last loop tick < 60 s) | `:8412/readyz` — DB reachable **and** `prompts.lock.json` hash verified | **never** |
| Docker healthcheck | `/healthz` on all three | never `/readyz` | **never** |

**Rejected alternatives.** (i) Gateway reachability in `ocr-ai-worker`'s `/readyz` — rejected: a
gateway outage would mark the container unhealthy, Docker would restart it, and it would drop leases
on jobs that were about to be retried anyway. Chat's rule exists for this reason. (ii) A
`depends_on` edge from `ocr-web` to `ocr-ai-worker` — rejected: it would make the AI service an
availability dependency of upload and review, which are the deterministic product.

**Reason.** The deterministic OCR pipeline is the system of record (`d` §1). It must stay green,
serve results, and accept uploads with the gateway completely down.

**Implementation consequence.** Gateway health is an **observability** signal only:
`ocr_ai_gateway_breaker_state{state="closed|half_open|open"}` (a gauge from D-F3-7's breaker),
`ocr_ai_calls_total{state}` including `reserved_stale`, and `ocr_ai_stage_skipped_total{reason}`.
Plus the one detector M0 never had: **alert when `OCR_AI_STAGE_ENABLED=true` and zero `ai_calls`
rows have been written in 24 h.** That is the only control that catches a silent misconfiguration in
hours instead of at a customer complaint.

**Migration consequence.** None — no schema change.

**Security consequence.** A gateway that is down, slow, or hostile cannot restart our containers,
cannot flush our queue, and cannot make a document appear processed. It can only make documents
complete OCR-only, which is a recorded, alerted, counted state.

**Config/env consequence.** `OCR_AI_METRICS_PORT = 8412` (`ocr-worker` holds 8411 per `m`). Neither
is published to the host.

---

### 4.4 D-F3-5 — The timeout budget, per hop

**Competing proposals.** H §13.1: `ai_extract` 180 s per call inside the worker's stage table, with
H §10.4 point 3 simultaneously arguing the client timeout *"must be **longer** than the gateway's own
worst-case retry chain, or we abandon paid work on every slow call."* Chat: 540,000 ms app-side,
600 s at NGINX.

**Selected.** Mirror the operator's own number. The full budget:

| Hop | Value | Owner | Note |
|---|---|---|---|
| Browser → NGINX → `ocr-web` upload | owned by `l`/`m` (cite) | — | A **new** vhost/location with its own `client_max_body_size`; Chat's 10M is not inherited |
| `ocr-web` enqueue → `DOCUMENT_EXTRACT` claim | `h` §13.2 `budgetMs` (cite) | H | The `(aiEnabled ? 5 × 60 000 : 0)` term is **deleted** — see below |
| `DOCUMENT_EXTRACT` stages | `h` §13.1 (cite) | H | `ai_extract` row **removed** from this table |
| `AI_EXTRACT` claim → lease | 120 s lease / 30 s heartbeat (`h` §13.1, cite) | H | Unchanged; `stop_grace_period: 90s` stays below it |
| **`ocr-ai-worker` → LiteLLM, TCP connect** | **5,000 ms** | **F3** | A connect that takes >5 s on a local Docker bridge is a topology fault, not a slow model |
| **`ocr-ai-worker` → LiteLLM, full response** | **540,000 ms** | **F3** | `= CHAT_UPSTREAM_TIMEOUT_MS`. Longer than the gateway's internal retry chain (UNVERIFIED — see §7 B-4), so we do not abandon paid work |
| **Ledger reservation stale threshold** | **1,080,000 ms** (= 2 × call timeout) | **F3** | `h` §10.4's rule, re-derived from the new call timeout |
| **`AI_EXTRACT` job budget** | `clamp(120_000 + chunks × 540_000, 600_000, 7_200_000)` ms | **F3** | Floor 10 min, ceiling **120 min**. At K's `maxCallsPerDocument = 12`: 120 000 + 6 480 000 = 6 600 000 ms < ceiling, so 12 calls fit and the ceiling is not silently binding |
| **`AI_EXTRACT` job `max_attempts`** | **3** | **F3** | Supersedes `h` §9.6's `maxAttempts: 6` for `AI_*` codes |
| **Job-attempt backoff** | base 30,000 ms, factor 4, cap 600,000 ms, full jitter → 30 s / 120 s / 480 s | **F3** | Applied to `available_at` |
| **In-process 429 retries** | max **5**, base 2,000 ms, cap 60,000 ms, full jitter | **F3** | Does **not** consume a ledger reservation or a job attempt — a 429 is not a billed call |
| `AI_EXTRACT` `queue_expires_at` | 24 h, per-organisation (`h` §13.2, cite) | H | Unchanged |
| NGINX 600 s proxy read | irrelevant to this path | — | `ocr-ai-worker` → gateway crosses **no** NGINX hop |

**Rejected alternatives.** (i) H's 180 s — rejected by H's own argument: LiteLLM retries upstream
internally and a client timeout at 180 s can fire mid-chain, billing both attempts and discarding
both. (ii) An unbounded timeout — rejected: it removes the ability to distinguish "slow" from
"wedged" and lets one document hold a worker slot forever. (iii) Deriving a number ourselves —
rejected: 540 s is the operator's own production value against this exact gateway, and a number with
evidence beats a number with arithmetic.

**Reason.** Every clock is now owned by the process that holds the lease, and the per-call clock
matches the estate.

**Implementation consequence.** No streaming (K-15), so `stream: false` on every request and the
540 s budget is a single-shot read with no first-byte timeout available. **Stated cost:** we cannot
detect a stalled generation before 540 s elapse. Compensating control: `reserved_stale` plus the
breaker, both of which fire on the *next* call, not this one. Accepted; revisit only if
`ocr_ai_call_duration_seconds` p99 approaches the ceiling.

`h` §13.2's `budgetMs` loses its `(aiEnabled ? 5 × 60_000 : 0)` term entirely, because AI is no
longer a stage of that job. This also fixes the defect `h` §16.1 flagged and could not cleanly
resolve — that the term is wrong for large documents — by making the AI budget a function of chunk
count in its own job.

**Migration consequence.** `ocr_jobs.budget_ms` is set per row at enqueue, so this is data, not DDL.

**Security consequence.** A wedged gateway consumes at most `OCR_AI_WORKER_CONCURRENCY × replicas`
= 4 slots for 540 s, then the breaker opens. It cannot consume OCR capacity at all, because the two
services share no worker pool. Under placement B a wedged gateway would have consumed OCR slots and
deepened the backlog.

**Config/env consequence.** All five timeout values are env-overridable (§8) so calibration in M2
is a config change, not a deploy of new code.

---

### 4.5 D-F3-6 — Where document-derived data lives between the two jobs

**Competing proposals.** `i` §8 designs storage as branch-invariant with page images available to
the AI on branch V. Gate 2 freezes `ai.boundary.pixels = never` and enforces it with a type and a
dependency-cruiser rule.

**Selected.** A dedicated volume, `ocr_ai_spool`, mounted read-write into `ocr-worker` (writer) and
`ocr-ai-worker` (reader/writer), and **read-only** into `ocr-web`. `ocr-ai-worker` does **not** mount
`ocr_file_storage` at all.

**Rejected alternatives.** (i) Mounting `ocr_file_storage` into `ocr-ai-worker` — rejected: it would
give the one egress-capable container read access to every organisation's original uploads, which is
the exact hole `h` L25 admits for `ocr-worker` and which we are not obliged to reproduce. (ii)
Passing the assembled text through the `ocr_jobs.payload` column — rejected: `h` §9.1 rule 4
forbids document content in the payload, which is stored at rest in a table operators and support
staff can read.

**Reason.** It turns gate 2's `ai.boundary.pixels = never` from a type-system rule into a
**filesystem boundary**. On branch T the AI service is structurally incapable of reaching a page
image; there is no code path, no mount and no credential that would let it. That is the strongest
form the rule can take, and it costs one volume.

**Implementation consequence.**
- The `assemble` stage of `DOCUMENT_EXTRACT` writes the minimised, serialised `[PAGE n]` text
  (gate-2 `ai.minimisation.mode = strict`, applied **before** the write) to
  `/data/ai/{orgId}/{documentId}/{pipelineVersion}/input.json`.
- Per-chunk map results and raw gateway responses are written to
  `/data/ai/{orgId}/{documentId}/{pipelineVersion}/{promptVersion}/{chunkIndex}.{idempotencyKey}.json`
  **before** the `complete_ai_call` DB commit (`h` §10.4 mitigation 1). A crash between the two is
  recovered by reading the file back, never by re-calling the gateway.
- `ai_calls.response_uri` points into this prefix. The key is derived server-side from the leased job
  row; the requester supplies no path component, mirroring `i` J4's *"accepts zero strings from the
  request"* discipline.
- Sweep: entries are deleted when the owning `AI_EXTRACT` job reaches a terminal state plus
  `OCR_AI_SPOOL_RETENTION_DAYS = 7`, **or** when the document's retention expires — **whichever is
  shorter**. Document retention and the crypto-shredding mechanism are owned by
  `gate-2-pdpa-retention.md §9`; this spool is a derivative under that regime, not an exception to it.

**Migration consequence.** One new named volume. No schema change; `ai_calls.response_uri` already
exists in `h` §10.4's model.

**Security consequence.** The spool holds minimised extracted **text** only — never original bytes,
never page images, never a filename. A compromise of `ocr-ai-worker` exposes the in-flight and
recent-7-day text of documents, not the document corpus. Under placement A or B the same compromise
would have exposed `ocr_file_storage` in full.

**Config/env consequence.** `OCR_AI_SPOOL_ROOT = /data/ai`, `OCR_AI_SPOOL_RETENTION_DAYS = 7`.

---

### 4.6 D-F3-7 — Retry ownership, idempotency, and the breaker

**Competing proposals.** H §10.4's reserve→call→complete ledger in Python under `ocr_worker`; K
§2.6's retry policy and §2.7's circuit breaker with Redis-backed state past three instances.

**Selected.** H's ledger protocol, verbatim, executed by `ocr-ai-worker` in TypeScript against
`ai_calls`. Our own per-call retry count is **0**; retry happens at the **job** level.

**Rejected alternatives.** (i) In-process retry of a billed call — rejected: LiteLLM has no
request-level idempotency and a client-side retry of a call that may already have been billed is a
retry storm of invoices. (ii) K §2.7's Redis breaker state — rejected: there is no Redis, and
introducing one to hold breaker state would reopen the queue-substrate decision (`h` L1, `m` O2) for
a counter. **Superseded:** past 3 replicas, breaker state goes in a Postgres row, not Redis.

**Reason.** Every retry that costs money must cross a durable, uniquely-keyed reservation. Every
retry that costs nothing may happen in-process.

**Implementation consequence.**

| Failure | Class | Retried where | Consumes a ledger reservation? | Counted by the breaker? |
|---|---|---|---|---|
| HTTP 429 (`retry-after`, then `llm_provider-retry-after` — **read both, in that order**) | `AI_GATEWAY_RATE_LIMITED` | in-process, max 5 | **no** | no |
| Connect refused / DNS failure / socket reset | `AI_GATEWAY_UNAVAILABLE` | job level, max_attempts 3 | no | yes |
| 540 s elapsed with no response | `AI_GATEWAY_TIMEOUT` | job level, but **not before** `OCR_AI_CALL_STALE_MS` | **yes** — row stays `RESERVED` | yes |
| 3xx under `redirect: 'manual'`, or a resolved IP outside the allowlist, or a host outside `LITELLM_ALLOWED_HOSTS` | **`AI_POLICY_VIOLATION`** (new) | **never** | no | **no** — alert CRITICAL, page the owner |
| Unclassified 4xx | `AI_BAD_REQUEST` (K-24) | never | yes | no — alerts as **our** bug |
| Output unparseable after K §5's repair ladder | `AI_OUTPUT_UNPARSEABLE` | never | yes | no |
| Chunk plan overflows the context ceiling | `AI_CONTEXT_OVERFLOW` | never | n/a | no — job completes `status: 'partial'` (K-9) |
| `OCR_AI_STAGE_ENABLED=false` | `E_AI_STAGE_DISABLED` (gate-2, cite) | n/a | n/a | n/a |

- `idempotencyKey = sha256(jobId | stage | chunkIndex | promptVersion | modelAlias |
  sha256(renderedPrompt))`. The **`chunkIndex` slot is new** — `h` §16.1 identified it as missing and
  had nowhere to put it; here it is mandatory, because chunking makes call count a function of page
  count.
- **Key on the alias, never the resolved model.** `innovera-ai` is a LiteLLM router alias, so the
  underlying model can change without a deploy on our side. Store LiteLLM's returned `model` in
  `ai_calls.model` for accounting; key idempotency on the alias plus `promptVersion`.
- Breaker: opens after **5** consecutive countable failures within **120 s**; half-open probe after
  **60 s**; one probe at a time. State is per-replica and in-memory at ≤3 replicas; beyond that it
  moves to a single `ai_breaker_state` row updated atomically.

**Migration consequence.** `ai_calls.idempotency_key` keeps its `UNIQUE` constraint and its
`Char(64)` type; only the input to the hash changes, which affects no deployed data because no key
has ever been minted.

**Security consequence.** `AI_POLICY_VIOLATION` exists because P7 verified by execution that the
`redirect: 'error'` guard both K and C declare "non-negotiable" is **inert**: undici rejects with
`TypeError('fetch failed')` and the string `"unexpected redirect"` lives on `e.cause.message`, so
`/redirect/i.test(e.message)` is `false`, `RedirectRefusedError` is never constructed, and a
redirect to a public host degrades to a retried transport error that nobody is paged for. Using
`redirect: 'manual'` and testing `res.status` is version-independent and cannot fail silently.

**Config/env consequence.** All retry counts and windows are env-overridable (§8).

---

### 4.7 D-F3-8 — An AI retry never re-runs OCR

**Competing proposals.** H's job graph makes `AI_EXTRACT` a successor job; H's `ai_extract` stage
timeout simultaneously places it inside the worker's stage table, which would put an AI failure
inside a `DOCUMENT_EXTRACT` attempt.

**Selected.** `AI_EXTRACT` is a **separate `ocr_jobs` row** with its own `attempts`, `budget_ms`,
`deadline_at`, `lease_token` and DLQ path. A failed AI attempt re-claims **only** the `AI_EXTRACT`
row; `DOCUMENT_EXTRACT` is already terminal and its result is content-addressed.

**Rejected alternative.** AI as a stage of `DOCUMENT_EXTRACT` — rejected: a gateway outage would
re-run render + preprocess + OCR for every page of every affected document, which for a 200-page
Thai document is ~85 CPU-minutes to retry a network call.

**Reason.** OCR is expensive and idempotent; the AI call is cheap in CPU and non-idempotent in
money. Coupling their retry budgets is exactly backwards.

**Implementation consequence.** Stated as an invariant with a regression test: *given a
`DOCUMENT_EXTRACT` job in state `SUCCEEDED` and an `AI_EXTRACT` job that fails all 3 attempts, the
`ocr_page_results` rows for that document are byte-identical before and after, and
`ocr_pages_ocred_total` does not increase.*

**Migration consequence.** None — this is how `h` §8.3's fan-in already enqueues; this document just
removes the contradicting stage-table row.

**Security consequence.** Removes a denial-of-service amplifier: a hostile actor who can make the
gateway slow cannot thereby multiply our OCR CPU consumption.

**Config/env consequence.** None.

---

### 4.8 D-F3-9 — What `OCR_AI_STAGE_ENABLED` does, per service

**Competing proposals.** M §2.5.4: `AI_GATEWAY_BASE_URL` defaults empty and empty means hard-
disabled (misconfiguration is invisible). K §2.10: the AI env schema is required and fails fast at
boot (the stack cannot boot in the state we are actually in). Gate 2: `OCR_AI_STAGE_ENABLED`,
default `false`, explicit.

**Selected.** Gate 2's flag, unchanged, with the per-service semantics this placement requires:

| `OCR_AI_STAGE_ENABLED` | `ocr-web` | `ocr-worker` | `ocr-ai-worker` |
|---|---|---|---|
| `false` (default) | Does not set `payload.aiEnabled`; the `assemble` fan-in does not enqueue `AI_EXTRACT`; `ocr_ai_stage_skipped_total{reason="disabled"}` increments; the document completes OCR-only and **is not marked `degraded`** — disabled is not degraded | Skips the `/data/ai` spool write | Not started (`profiles: [ai]`). If started anyway: logs `ai.mode=disabled`, exits **0**, does not restart-loop |
| `true` | Sets `payload.aiEnabled = true`; enqueue proceeds | Writes the minimised spool input | Parses the full `litellm` env schema at boot. Missing/invalid `LITELLM_BASE_URL`, key file, model allowlist or gate-2 attestation ⇒ **process exits non-zero, listener never binds** |
| unset | **boot refusal on every service** — `:?` in compose, and a Zod `.required()` with no default | same | same |

**Rejected alternatives.** (i) Minting a new `LITELLM_ENABLED` — rejected: gate 2 already froze
`OCR_AI_STAGE_ENABLED`; see §7 C-1. (ii) "Empty base URL means off" (M) — rejected: a typo in the
variable name is then indistinguishable from a deliberate disable, and `n` N16 keeps the gateway out
of `/readyz`, so nothing would ever surface it. (iii) Unconditional fail-fast (K) — rejected: it
makes today's actual state unbootable and the path of least resistance becomes weakening the schema.

**Reason.** Three states — *deliberately off*, *on and correct*, *forgotten* — must be
distinguishable, and the third must be loud.

**Implementation consequence.** `ocr-web` reads `OCR_AI_STAGE_ENABLED` and **nothing else**
AI-related. The `ai` compose profile and the flag can drift; the compensating control is the D-F3-4
detector (`OCR_AI_STAGE_ENABLED=true` + zero `ai_calls` rows in 24 h ⇒ alert) plus a one-line
`ai.mode=` log at every `ocr-web` boot.

**Migration consequence.** None.

**Security consequence.** With `GATE1_CREDENTIAL_ISSUANCE = BLOCKED` and gate 2 unanswered, the
shipped default is `false`, so **no document content reaches the gateway** and the deterministic
pipeline — which is the bulk of the product — is unaffected.

**Config/env consequence.** Cite `gate-2-pdpa-retention.md §9 ai.stage.enabled.default`.

---

### 4.9 D-F3-10 — Error taxonomy and stage-timeout table ownership

**Competing proposals.** H owns `contracts/error-codes.json` and the per-stage timeout table, with
`ai_extract` inside it and the `AI_*` codes classified by the Python worker.

**Selected.** The **file** stays H's single closed enum shared by all three services. The `AI_*`
**members** are owned by the AI dimension (K) and **emitted solely by `ocr-ai-worker`**. The
`ai_extract` row **leaves** H §13.1's worker stage table; `ocr-ai-worker` gets its own stage table
(D-F3-5).

**Rejected alternative.** A second error-code file for the AI service — rejected: two closed enums
drift, and the UI and the DLQ must render both.

**Reason.** One file, one enum, one emitter per code. The emitter moves with the socket; the
contract does not fork.

**Implementation consequence.** `contracts/error-codes.json` gains `AI_POLICY_VIOLATION`
(retryable: false, breakerCounted: false, severity: CRITICAL, userFacing: false). Every `AI_*` code
gains `emitter: "ocr-ai-worker"`, and a contract test asserts no `AI_*` code is constructible from
`services/ocr-worker/**`.

**Migration consequence.** None (a JSON contract, not a schema).

**Security consequence.** A code the worker cannot construct is a code the worker cannot use to
mask an outbound attempt as a benign failure.

**Config/env consequence.** None.

---

### 4.10 D-F3-11 — What to scale, when

**Selected.**

| Bottleneck | Signal | Scale | Bound |
|---|---|---|---|
| OCR | `ocr_queue_pending{kind="DOCUMENT_EXTRACT"}`, CPU saturation | `ocr-worker` replicas | Host CPU; `m` §4.4's `W` |
| AI | `ocr_queue_pending{kind="AI_EXTRACT"}`, gateway queue latency | `ocr-ai-worker` replicas | **The virtual key's `max_parallel_requests`** |

**Reason and the derivation the panel asked for.** `m` §5.3 sets `max_parallel_requests: 4`,
derived as *"≈ our worker count"* — a limit sized against a component that, under this decision, is
not the caller. Re-derived correctly:
`OCR_AI_WORKER_CONCURRENCY (2) × OCR_AI_WORKER_REPLICAS (2) = 4 in-flight gateway requests`, which
is exactly `max_parallel_requests: 4`. The number survives; its derivation is now sound and the
invariant is checkable: **`concurrency × replicas` must never exceed the key's
`max_parallel_requests`**, asserted at boot from an env value the operator sets alongside the key.

**Implementation consequence.** `ocr-ai-worker` at 0.5 vCPU / 512 MB per replica is ~1/6 the cost of
an `ocr-worker` replica (1.5 vCPU / 3 GiB), so AI concurrency is cheap to add and cheap to remove.
Under A2 (claimer inside `ocr-web`) the same unit of AI concurrency would have cost a full Next.js
server.

**Migration / security / config consequence.** None beyond `OCR_AI_WORKER_CONCURRENCY = 2`,
`OCR_AI_WORKER_REPLICAS = 2`, `OCR_AI_MAX_PARALLEL_REQUESTS = 4` in §8.

---

## 5. M0 statements this document supersedes

Recorded explicitly, because two of them are already written as executable artefacts.

| Superseded | Where | What now holds |
|---|---|---|
| **A compose flag already written:** `ocr-web: networks: [ocr-internal, ocr-egress]` and `secrets: [ai_gateway_key]` | `m` §2.2 | `ocr-web: networks: [ocr-internal]`, no AI secret (D-F3-2, D-F3-3) |
| *"`ocr-web` … **the only holder of an AI credential**"* | `m` §2.1 inventory, `m` §2.5.1 diagram, `m` §2.5.3 table (both branches) | `ocr-ai-worker` is the sole holder. M's **negative** claim — the worker never gets one — survives and is strengthened |
| `ocr-web \| joins innovera_default: yes \| holds LITELLM_API_KEY: yes — sole holder` | `b` §2.4 decision B-2 table | Replaced by D-F3-2's map. B-2's *rationale* (the parser must not hold the key) survives and is the reason for this decision |
| *"The worker reaches the gateway over `innovera_default` … an item for dimension M's compose file"* | `h` §16 item 1 | **Withdrawn.** M is not asked to attach the worker to any AI network, and the deploy gate in §6 asserts it never happens |
| `GRANT SELECT, INSERT, UPDATE ON ai_calls TO ocr_worker;` | `h` §11.2 | `REVOKE ALL ON ai_calls FROM ocr_worker;` + the same grant to `ocr_ai_worker` (D-F3-3) |
| `\| ai_extract \| 180 s \| per call \|` in the worker's stage table | `h` §13.1 | Removed from that table; 540,000 ms in `ocr-ai-worker`'s own table (D-F3-5) |
| `maxAttempts: 6` for `AI_GATEWAY_*` | `h` §9.6 | `max_attempts: 3` at the job level, plus 5 in-process 429 retries (D-F3-6) |
| `budgetMs` term `(aiEnabled ? 5 × 60_000 : 0)` | `h` §13.2 | Deleted; the AI budget is its own job's (D-F3-5) |
| J §6.10's two-row conditional table, and D6's reversal trigger *"the web tier makes the call"* | `j` §6.10, `j` D6 | One unconditional row: `ocr-ai-worker`. J's *rejection* of the web tier survives and is honoured |
| K §2.1's implied host process; K §2.7's Redis breaker state; K's `AiCallLog` Prisma model | `k` §2.1, §2.7, §617–643 | The tree runs in `ocr-ai-worker`; breaker state goes to Postgres past 3 replicas; `AiCallLog` is deleted in favour of `ai_calls` (D-F3-3, D-F3-6) |
| *"neither branch is chosen here"* on placement | `a` §9 | Chosen here. `a` A-5's `src/workers/**` element becomes load-bearing rather than anticipatory |
| `i` §8's branch framing | `i` §8 | The **B1 inline-base64 storage decision survives untouched**; what changes is that on branch T no page image is reachable by the AI process at all (D-F3-6) |

Two M0 findings this document does **not** resolve and does not claim to: `m` §2.1.0's missing
`ocr-clamd`/`ocr-freshclam` tier (nothing scans before the worker parses), and `h` L25/L26's
credential-mint binding for `ocr-worker`. Both are owned elsewhere in M0.5; both remain open. The
mint-binding discipline — *the endpoint takes `(jobId, leaseToken)` and nothing else, re-reads the
row, and derives every path server-side* — is adopted here for `ocr_ai_complete_v1` (D-F3-3).

---

## 6. Mechanical gates — so this cannot silently regress

Prose is what produced the contradiction. These are commands.

```bash
# G1 — the hostile-file parser holds no AI route and no AI credential.
docker inspect ocr-worker-1 --format '{{json .NetworkSettings.Networks}}' \
  | python3 -c 'import json,sys; n=json.load(sys.stdin); assert list(n)==["ocr_ocr-internal"], n'
docker inspect ocr-worker-1 --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep -cE 'LITELLM|API_KEY|_KEY_FILE' | grep -qx 0

# G2 — the internet-facing tier holds no AI route and no AI credential either.
docker inspect ocr-web-1 --format '{{json .NetworkSettings.Networks}}' \
  | python3 -c 'import json,sys; n=json.load(sys.stdin); assert list(n)==["ocr_ocr-internal"], n'
docker inspect ocr-web-1 --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep -E 'LITELLM' | grep -vqx 'OCR_AI_STAGE_ENABLED=.*' || true   # only the enqueue switch

# G3 — the AI service holds no original-document mount.
docker inspect ocr-ai-worker-1 --format '{{range .Mounts}}{{println .Name}}{{end}}' \
  | grep -q ocr_file_storage && { echo 'FAIL: AI worker mounts document storage'; exit 1; }

# G4 — the AI service is on exactly the two intended networks.
docker inspect ocr-ai-worker-1 --format '{{json .NetworkSettings.Networks}}' \
  | python3 -c 'import json,sys; n=sorted(json.load(sys.stdin)); assert n==sorted(["ocr_ocr-internal","innovera_default"]), n'

# G5 — no service publishes a non-loopback port (m §2.5.2's test, unchanged).
# G6 — SQL: the worker is refused the ledger; ocr_app has no cross-org policy.
psql "$WORKER_DSN"  -c 'SELECT 1 FROM ai_calls LIMIT 1' 2>&1 | grep -q 'permission denied'
psql "$OWNER_DSN"   -tAc "SELECT count(*) FROM pg_policies
                          WHERE tablename IN ('ocr_jobs','ai_calls')
                            AND roles::text LIKE '%ocr_app%'
                            AND qual = 'true'" | grep -qx 0
```

Plus three source-level tests: (a) no `AI_*` error code is constructible from
`services/ocr-worker/**`; (b) `dependency-cruiser` forbids `src/app/**` → `infrastructure/ai/**`
(K §2.1, now also a process boundary); (c) the guard test P7 asked for, extended from one case to
four — a 302 response, a resolved IP outside the CIDR allowlist, a 401, and an unrecognised 400 —
each asserting the declared class **and that no retry occurred**.

---

## 7. OWNER-BLOCKED items and challenges

Every one carries a named default that ships if the owner stays silent.

| Tag | Question | Blocks | Default that ships |
|---|---|---|---|
| **OWNER-BLOCKED (B-1)** | Does `${AI_NETWORK_NAME:-innovera_default}` exist on the deployment host, and may `ocr-ai-worker` join it? (`j` B6, `b` §3.2) | The `ai-shared` attachment | Ship the compose as written with `external: true` and `OCR_AI_STAGE_ENABLED=false`. The stack deploys and runs OCR-only; the network is never referenced. If the answer is *no, the gateway is remote*, the only change is that `ocr-ai-worker` moves to `ocr-egress` with a host firewall rule pinning `172.29.0.0/16` egress to the gateway IP:443. **No other decision in this document changes** — that is the point of choosing a dedicated service. |
| **OWNER-BLOCKED (B-2)** | The literal `LITELLM_BASE_URL` and the OCR virtual key | Any real call | Unset; `OCR_AI_STAGE_ENABLED=false` (gate-2 default) |
| **OWNER-BLOCKED (B-3)** | Does the OCR virtual key exist, and what is its `max_parallel_requests`? | D-F3-11's bound | Assume `4` (`m` §5.3). Ship `concurrency 2 × replicas 2`. The boot assertion `concurrency × replicas ≤ OCR_AI_MAX_PARALLEL_REQUESTS` makes a wrong assumption a boot failure, not a production surprise |
| **OWNER-BLOCKED (B-4)** | The gateway's own worst-case internal retry-chain duration (`h` §17.1 Q3) | Whether 540,000 ms is long enough | 540,000 ms, mirroring `CHAT_UPSTREAM_TIMEOUT_MS`. Re-derive when answered; it is one env value |
| **OWNER-BLOCKED (B-5)** | Does the gateway persist prompt/response bodies? | gate-2's attestation | Owned by `gate-2-pdpa-retention.md`; cited, not re-decided here |

### Challenges to frozen values

**C-1 — the brief assigns F3 ownership of "the AI stage enable/disable flag name", but
`gate-2-pdpa-retention.md §9` has already frozen `OCR_AI_STAGE_ENABLED` (default `false`).** Minting
a second name would recreate exactly the M0 failure mode this milestone exists to end — M0 produced
four env vocabularies for this one concept (`LITELLM_*`, `AI_*`, `AI_GATEWAY_*`, and K's variant set)
and the mismatch fails silently. **This document therefore adopts gate 2's name verbatim and does not
mint one.** What F3 owns is the *placement-scoped semantics* of that flag: which services read it,
what each does with it, and the container-lifecycle rule (§4.8, §8). The orchestrator should record
gate 2 as the flag's owner and F3 as the owner of its per-service behaviour. This is a scoping
correction, not an objection to gate 2's value.

---

## 8. UNVERIFIED register

- **UNVERIFIED:** that the gateway is reachable from a container on `innovera_default` on the
  deployment host. Evidence is E8/E9 plus INNOVERA Chat's `AI_NETWORK_NAME` default; no probe has
  run. B-1.
- **UNVERIFIED:** that a model alias named `innovera-ai` exists or is authorised for an OCR key.
  Evidence, not authorisation. Never present it as confirmed.
- **UNVERIFIED:** that the gateway serves no vision-capable alias. Chat's source proves *Chat's*
  model is text-only; it does not prove the gateway's model list. Treated as text-only. D-F3-6's
  volume boundary means a later vision answer requires an explicit, reviewable mount change rather
  than a silent capability.
- **UNVERIFIED:** LiteLLM's `x-litellm-*` response header names, and whether a 429 distinguishes
  "key out of quota" from "model busy" (`h` §17.1 Q3).
- **UNVERIFIED:** that 540,000 ms exceeds the gateway's internal retry chain. B-4.
- **UNVERIFIED:** every latency, cost and throughput figure inherited from `m` §4 and `h` §13.1.
  No benchmark has been run on target hardware.
- **UNVERIFIED:** that `ocr_ai_worker`'s grant list is complete. It is *derived* from the four
  functions it executes rather than asserted — which is more than `h` §11.2 could claim — but the
  panel's finding stands until an integration test executes each statement as the role against a
  real PostgreSQL 18 and asserts success.

---

## CANONICAL VALUES

Every value below is **owned by this document**. Cite it as
`f3-ai-call-placement.md §CANONICAL VALUES`. Do not restate it — restating is how M0 drifted.

| key | value | env var | reason | failure behaviour |
|---|---|---|---|---|
| `ai_call_owner` | **`ocr-ai-worker`** — the sole process that opens a socket to the LiteLLM gateway | — | The only placement under which no process holds both a gateway credential and a high-exposure input surface (D-F3-1) | Any gateway socket opened from `ocr-web` or `ocr-worker` is a **deploy-gate failure** (§6 G1/G2), not a warning |
| `ai.service.name` | `ocr-ai-worker` | — | Compose service, container name prefix, metrics label, `emitter` value in the error contract | A different name breaks G1–G4 and the error-contract test |
| `ai.service.image` | `innovera/ocr-ai:${OCR_VERSION:-dev}`, built from `docker/web.Dockerfile` `target: ai-worker` | `OCR_VERSION` | Same repo, same lockfile, same Zod contract as `ocr-web`; only the entrypoint differs | A separate repo or image family reintroduces contract drift |
| `ai.service.composition_root` | `src/workers/ai-extract/` | — | `a` decision A-5's `workers` boundary element; dependency-cruiser rules apply unchanged | Code under `src/app/**` importing `infrastructure/ai/**` fails dependency-cruiser |
| `ai.network.map` | `ocr-db`: `ocr-internal` · `ocr-migrate`: `ocr-internal` · `ocr-web`: `ocr-internal` · `ocr-worker`: `ocr-internal` · **`ocr-ai-worker`: `ocr-internal` + `ai-shared`** · `ocr-clamd`: `ocr-internal` · `ocr-freshclam`: `ocr-internal` + `ocr-egress` · `ocr-backup`: `ocr-internal` + `ocr-egress` | — | Egress is granted only to services with no parser, no user-facing listener and no gateway credential (D-F3-2) | Deviation is a deploy-gate failure (§6 G1–G4) |
| `ai.network.shared_name` | compose network `ai-shared`, `external: true`, `name: ${AI_NETWORK_NAME:-innovera_default}` | `AI_NETWORK_NAME` | The pre-existing shared AI bridge; `external: true` makes a missing network a loud deploy error | Network absent ⇒ `docker compose up` fails; under the default `OCR_AI_STAGE_ENABLED=false` the service is not started and the stack deploys normally |
| `ai.services.no_egress` | `ocr-db`, `ocr-migrate`, **`ocr-web`**, `ocr-worker`, `ocr-clamd` | — | Every credential-bearing or user-facing service sits behind `internal: true` — no default route, no MASQUERADE | Any future outbound call from these fails closed and loudly |
| `ai.credential.holder` | **`ocr-ai-worker`, sole holder** | `LITELLM_API_KEY_FILE=/run/secrets/litellm_api_key` | One container, one credential, mounted from a compose secret; never in `docker inspect`, never via `env_file` | Key present in any other container ⇒ deploy-gate failure. Absent with `OCR_AI_STAGE_ENABLED=true` ⇒ **exit non-zero, listener never binds** |
| `ai.db.role` | `ocr_ai_worker` | `AI_WORKER_DATABASE_URL` | Fourth role. Table grants: `SELECT, INSERT, UPDATE ON ai_calls` only; everything else via four `SECURITY DEFINER` functions owned by `ocr_owner` | A grant on `documents`, `ocr_page_results` or any content table is a review failure |
| `ai.db.rls_policy` | `queue_ai_all_orgs ON ocr_jobs TO ocr_ai_worker USING (kind = 'AI_EXTRACT')` | — | Narrower than `ocr_worker`'s `USING (true)`: the AI service cannot see OCR jobs at all | `ocr_app` **never** receives a cross-organisation policy on `ocr_jobs` or `ai_calls` — asserted by §6 G6 |
| `ai.db.revoked_from_worker` | `REVOKE ALL ON ai_calls FROM ocr_worker` | — | The hostile-file parser is no longer the ledger writer (supersedes `h` §11.2) | §6 G6 asserts `permission denied` |
| `ai.ledger` | **one** ledger: `ai_calls` (H's model, `idempotency_key UNIQUE`). K's `AiCallLog` is deleted | — | Two ledgers, one without a unique constraint, would make R6 untestable and a retry storm a storm of invoices | A second AI ledger model in the schema is a review failure |
| `ai.idempotency_key` | `sha256(jobId \| stage \| chunkIndex \| promptVersion \| modelAlias \| sha256(renderedPrompt))` | — | `chunkIndex` is mandatory: chunking makes call count a function of page count (`h` §16.1) | Collision ⇒ a paid call is replayed instead of re-billed. Keyed on the **alias**, never a resolved model identity |
| `ai.readiness.contract` | `ocr-ai-worker`: `/healthz` = liveness (loop tick < 60 s); `/readyz` = DB + `prompts.lock.json` hash. **Neither probes LiteLLM.** Docker healthcheck uses `/healthz` only; no `depends_on` edge into `ocr-ai-worker` | `OCR_AI_METRICS_PORT=8412` | Implements `gate-2 ai.readiness.participation = none` per service; mirrors the verified Chat rule | Gateway down ⇒ documents complete OCR-only, containers keep running, `/healthz` and `/readyz` stay green everywhere |
| `ai.detector.silent_off` | Alert when `OCR_AI_STAGE_ENABLED=true` **and** zero `ai_calls` rows written in **24 h** | — | The only control that catches a naming/config mistake in hours rather than at a customer complaint | Missing detector ⇒ months of OCR-only output can ship unnoticed |
| `ai.stage_enabled.semantics` | `false`: `ocr-ai-worker` not started (`profiles: [ai]`); no `AI_EXTRACT` enqueued; `ocr_ai_stage_skipped_total{reason="disabled"}`++; document **not** marked `degraded`. `true`: full env schema parsed at boot in `ocr-ai-worker` only. **unset: boot refusal on every service.** `ocr-web` reads this variable and no other AI variable | `OCR_AI_STAGE_ENABLED` (name + default owned by `gate-2-pdpa-retention.md §9`) | Three states — off, on, forgotten — must be distinguishable and the third must be loud | Unset ⇒ compose `:?` failure. `true` with invalid AI config ⇒ exit non-zero, listener never binds |
| `ai.timeout.connect_ms` | `5000` | `OCR_AI_CONNECT_TIMEOUT_MS` | A >5 s TCP connect on a local Docker bridge is a topology fault, not a slow model | ⇒ `AI_GATEWAY_UNAVAILABLE`, job-level retry |
| `ai.timeout.call_ms` | `540000` | `OCR_AI_CALL_TIMEOUT_MS` | `= CHAT_UPSTREAM_TIMEOUT_MS`; longer than the gateway's internal retry chain so we do not abandon paid work | ⇒ `AI_GATEWAY_TIMEOUT`; the ledger row stays `RESERVED` and is not retried before `ai.timeout.stale_ms` |
| `ai.timeout.stale_ms` | `1080000` (2 × call timeout) | `OCR_AI_CALL_STALE_MS` | A slow success must not be raced by our own retry (`h` §10.4) | A `RESERVED` row past this ⇒ `ocr_ai_calls_total{state="reserved_stale"}`++ and alert: money spent for nothing |
| `ai.job.budget_ms` | `clamp(120_000 + chunks × 540_000, 600_000, 7_200_000)` | `OCR_AI_JOB_BUDGET_FLOOR_MS=600000`, `OCR_AI_JOB_BUDGET_CEILING_MS=7200000` | Floor 10 min, ceiling 120 min; 12 calls (K's `maxCallsPerDocument`) = 6,600,000 ms and fit under the ceiling | Exceeded ⇒ `BUDGET_EXCEEDED`, non-retryable, partial result kept and surfaced |
| `ai.job.max_attempts` | `3` | `OCR_AI_JOB_MAX_ATTEMPTS` | Each attempt replays `COMPLETED` ledger rows instead of re-calling, so every attempt makes forward progress. Supersedes `h` §9.6's `6` | Exhausted ⇒ DLQ; the deterministic OCR result is already saved and is the system of record |
| `ai.job.backoff` | base `30000` ms, factor `4`, cap `600000` ms, full jitter (30 s / 120 s / 480 s) | — | Applied to `available_at` between job attempts | — |
| `ai.ratelimit.retry` | max `5` in-process attempts, base `2000` ms, cap `60000` ms, full jitter; read `retry-after` **then** `llm_provider-retry-after`, in that order | `OCR_AI_RATE_LIMIT_MAX_ATTEMPTS`, `OCR_AI_RATE_LIMIT_BASE_MS`, `OCR_AI_RATE_LIMIT_CAP_MS` | A 429 is not a billed call, so it may be retried in-process. LiteLLM does not forward an upstream `retry-after` under that name | Reading only the first header ⇒ silent blind backoff exactly when the upstream is telling us how long to wait. Consumes **no** ledger reservation and **no** job attempt |
| `ai.error.taxonomy_owner` | File `contracts/error-codes.json` owned by `h`; the `AI_*` members owned by `k`; **emitted solely by `ocr-ai-worker`** (`emitter: "ocr-ai-worker"`) | — | One closed enum, one emitter per code; the emitter moves with the socket, the contract does not fork | A contract test asserts no `AI_*` code is constructible from `services/ocr-worker/**` |
| `ai.error.policy_violation` | New code **`AI_POLICY_VIOLATION`**: never retried, never breaker-counted, severity CRITICAL. Detected with `redirect: 'manual'` + `res.status >= 300 && < 400`, or a resolved IP outside the CIDR allowlist, or a host outside the allowlist | — | P7 verified by execution that `redirect: 'error'` + `/redirect/i.test(e.message)` is **inert** (undici puts the text on `e.cause.message`), so a redirect to a public host silently degrades to a retried transport error | Without it, an ops proxy or poisoned DNS in front of the gateway reads as flaky networking and nobody is paged |
| `ai.breaker` | Opens after **5** consecutive countable failures within **120000** ms; half-open probe after **60000** ms, one probe at a time. State in-memory per replica at ≤3 replicas; beyond that a single `ai_breaker_state` Postgres row. **Never Redis** | — | There is no Redis (`h` L1, `m` O2); introducing one for a counter reopens the queue-substrate decision. Supersedes `k` §2.7 | Open breaker ⇒ documents complete OCR-only; `ocr_ai_gateway_breaker_state` gauge is the signal |
| `ai.streaming` | **none** — `stream: false` on every request | — | K-15; a grammar-constrained JSON response has nothing useful to stream | Cost accepted and recorded: no first-byte stall detection before 540 s. Compensated by `reserved_stale` + the breaker |
| `ai.retry.never_reruns_ocr` | `AI_EXTRACT` is a **separate `ocr_jobs` row** with its own attempts, budget, lease and DLQ | — | OCR is expensive and idempotent; the AI call is cheap in CPU and non-idempotent in money. Coupling their retry budgets is backwards | Regression test: 3 failed AI attempts leave `ocr_page_results` byte-identical and `ocr_pages_ocred_total` unchanged |
| `ai.spool.volume` | `ocr_ai_spool` at `/data/ai` — rw in `ocr-worker` and `ocr-ai-worker`, **ro** in `ocr-web`. `ocr-ai-worker` does **not** mount `ocr_file_storage` | `OCR_AI_SPOOL_ROOT=/data/ai` | Makes `gate-2 ai.boundary.pixels = never` a filesystem boundary, not only a type rule: the AI process is structurally incapable of reaching an original upload or a page image | §6 G3 fails the deploy if `ocr_file_storage` is mounted into `ocr-ai-worker` |
| `ai.spool.key` | `/data/ai/{orgId}/{documentId}/{pipelineVersion}/{promptVersion}/{chunkIndex}.{idempotencyKey}.json`, written **before** the `complete_ai_call` DB commit | — | Crash recovery reads the file back instead of re-calling the gateway (`h` §10.4 mitigation 1). Path derived server-side from the leased row; the requester supplies no path component (`i` J4's discipline) | A crash between write and commit costs a file read, not a second charge |
| `ai.spool.retention_days` | `7` after the owning `AI_EXTRACT` job is terminal, **or** the document's retention — whichever is shorter | `OCR_AI_SPOOL_RETENTION_DAYS` | The spool holds minimised document text; it is a derivative under `gate-2-pdpa-retention.md`'s regime, never an exception to it | Sweep failure ⇒ PDPA exposure; alert on spool age p99 > 8 days |
| `ai.concurrency` | `OCR_AI_WORKER_CONCURRENCY = 2` × `OCR_AI_WORKER_REPLICAS = 2` = **4** in-flight gateway requests | `OCR_AI_WORKER_CONCURRENCY`, `OCR_AI_WORKER_REPLICAS`, `OCR_AI_MAX_PARALLEL_REQUESTS=4` | Re-derives `m` §5.3's `max_parallel_requests: 4` from the component that actually calls the gateway | Boot assertion: `concurrency × replicas ≤ OCR_AI_MAX_PARALLEL_REQUESTS`, else **exit non-zero**. Scale AI by replicas; scale OCR by `ocr-worker` replicas; never the one for the other |
| `ai.claim.kind_predicate` | `h` §6.3 statement 1 gains `AND j.kind = ANY($k)`. `ocr-worker` passes `{'DOCUMENT_EXTRACT'}`; `ocr-ai-worker` passes `{'AI_EXTRACT'}` | — | Without it, *"just do not give the worker AI work"* is not expressible in the queue at all | Missing predicate ⇒ the Python worker claims AI jobs and fails every one against `internal: true`, burning a worker slot on guaranteed failures |
