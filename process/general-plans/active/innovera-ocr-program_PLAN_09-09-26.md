# INNOVERA OCR AI — Umbrella Phase Program Plan (M0 → M8)

**Date:** 09-09-26
**Complexity:** COMPLEX — Phase Program (9 milestones)
**Status:** ✅ **M0 LOCAL DESIGN GATE CLOSED.** Discovery, M0.5 contracts and R1–R11 reconciliation decisions exist. Runtime proof and owner evidence remain milestone gates. **No milestone plan may enter EXECUTE until its own plan is approved.**
Date: 09-09-26  
Complexity: COMPLEX  
Status: PLANNED — M0 remains open pending reconciliation
**Scope owner:** `process/general-plans/` today; **promote to `process/features/innovera-ocr/` at first UPDATE PROCESS** (required by the house Feature Folder Lifecycle and already recorded as MISSING in `process/context/all-context.md`).
**Next documentation anchor:** [M0.5 reconciliation plan](phase-00b-m0-reconciliation_PLAN_12-09-26.md). [Current consolidation](../reports/M05_CONSOLIDATION_REPORT_12-09-26.md) supersedes the historical “arbitration not started” status below. No application execution anchor exists yet.
**M0 item Q.** This file *is* deliverable Q ("milestone implementation plan") of the M0 brief.

---

## Overview

INNOVERA OCR AI is a Thai-first, secure OCR + document-intelligence platform sold on **auditability**, not on raw accuracy: for every extracted value it must answer *"where on the page did this come from, and who approved it"*. The build is a single-application modular monolith (`ocr-web`, Next.js) plus a credential-free Python worker (`ocr-worker`) that does all pixel work, one PostgreSQL, one object store, and one private LiteLLM/vLLM gateway that this project does not own.

M0 produced fourteen dimension designs (~42,800 lines) plus an adversarial panel that **refuted all 24 of its verdicts — 1 fatal, 23 major**. The corpus is strong and it **contradicts itself in nine places that are schema-, migration-, grant- or compose-level** — i.e. free to fix today and expensive-to-impossible after M1. This plan therefore does two things at once: it sequences M1–M8, and it makes closing those nine contradictions the **exit gate of M0**, not a task inside M1.

**Execution rule:** advance one milestone at a time using the required 10-step loop in `/Users/innovera/process/development-protocols/phase-programs.md`. Never send this umbrella into EXECUTE. Never send two milestone plans into EXECUTE at once.

---

## Quick Links

- [Program Goal Charter](#program-goal-charter)
- [Success measures](#success-measures--measurable)
- [Milestone map M0–M8](#milestone-map-m0m8)
- [Milestone detail](#milestone-detail)
- [Dependency graph and the gateway-blocking analysis](#dependency-graph-and-the-gateway-blocking-analysis)
- [Definition of Done, per milestone](#definition-of-done-per-milestone)
- [The two M3 branches — T vs V](#the-two-m3-branches--t-vs-v)
- [The malware-scanning gate](#the-malware-scanning-gate-and-its-risk-acceptance)
- [The benchmark gate — when CER exists and what it must clear](#the-benchmark-gate--when-cer-exists-and-what-it-must-clear)
- [M0 closeout: the nine blocking contradictions](#m0-closeout-the-nine-blocking-contradictions)
- [Owner-blocked register](#owner-blocked-register)
- [Program risks](#program-risks)
- [Rollback and abort criteria](#rollback-and-abort-criteria)
- [Status matrix](#status-matrix)
- [Milestone completion rules](#milestone-completion-rules)
- [Resume and execution handoff](#resume-and-execution-handoff)

---

## Program Goal Charter

### North star

Ship a Thai-first OCR and document-intelligence platform where **deterministic OCR is the system of record**, every AI-proposed field is mechanically re-verified against that record before it is allowed to exist, every correction is appended rather than overwritten, and any completed document can be traced end-to-end from one document id.

### Definition of done

- A customer uploads a Thai or English PDF, image or Office document; the platform scans it, decides **per page** whether native text suffices or the page must be rasterised, and produces text with **per-line geometry and per-line confidence**.
- The LLM structures that text into typed fields; **every proposed value is located in the OCR text of its cited page or it is not a value**; ungrounded and low-confidence fields are routed to a human.
- A reviewer sees the page, the highlight, both confidence numbers, corrects what is wrong, and approves. Corrections and approvals are append-only and attributable.
- Results leave the system by API and by export, under per-tenant quotas, keys and rate limits.
- Cross-tenant access is impossible by construction (typed scope + composite FK + RLS) and **intra-tenant** visibility is deny-by-default (owner + workspace + explicit grant).
- PDPA operations exist and work: retention per artefact class, subject export, lawful erasure with receipts, admin access logging.
- The system runs as `docker compose` behind whichever proxy the target host already runs, with backups, runbooks and five paging alerts, and **without ever degrading INNOVERA Chat or its GPU**.

### What "verified" means — program level

A milestone is `✅ VERIFIED` only when **all** of the following are recorded in its milestone report:

1. Automated gates green: `typecheck`, `lint`, `dependency-cruiser` + `eslint-plugin-boundaries` (including the known-bad-fixture test), unit, integration, and the milestone's named E2E.
2. Data/state evidence: SQL or artefact output proving the milestone's invariants, with no PII in the evidence.
3. Negative evidence: the milestone's authorization, isolation, idempotency and error-path tests pass **as denials**, not as absences.
4. Security review of the milestone's blast radius, with zero open Critical/High.
5. Regression evidence against every previously verified overlapping surface.
6. The milestone report exists, names the commit SHA, the exact commands, the deviations and the residual blockers.
7. **STOP FOR REVIEW** — the owner has seen the evidence and said go.

No accuracy figure may appear in any report, README, UI or sales surface unless it traces to a committed `bench/results/*.json` file (`n` N39). At M0 the count of measured INNOVERA accuracy figures is **zero**.

### Scope tiers → milestone mapping

| Tier | Name | Milestones |
|---|---|---|
| Tier 0 | Architecture, discovery, and contradiction arbitration | M0 |
| Tier 1 | Secure ingest + deterministic OCR of record | M1 |
| Tier 2 | Measurement: the first true numbers | M2 |
| Tier 3 | AI enrichment behind the verifier | M3 |
| Tier 4 | Human loop, search and export | M4 |
| Tier 5 | Commercial surface: external API, tenancy operations, quotas | M5 |
| Tier 6 | Compliance operations: PDPA, retention, data lifecycle | M6 |
| Tier 7 | Hardening, scale, performance, DR | M7 |
| Tier 8 | Deployment and launch readiness (no unapproved cutover) | M8 |

This program retires Tiers 0–8.

### Explicitly out of scope (deferred tier)

Handwriting recognition · agentic extraction / tool-calling of any kind · auto-approval of extracted values · completion webhooks and any user-supplied-URL fetch (`j` D27; refuted-as-shipped by panel P5) · public-model fallback in any environment · a second GPU or any CUDA OCR process · MinIO as a migration target (`i` J7) · cross-tenant content-addressed dedupe · multi-region / data-residency enforcement beyond a recorded column · billing integration and commercial packaging · `.doc` / `.ppt` legacy binaries · HEIC until its decoder licence is cleared · PDF report generation (`l` L-17).

### Hard safety constraints (non-negotiable, every milestone)

1. **Never contact, scan, modify, deploy to, or reconfigure** `72.62.253.185`, `52.221.213.43`, `141.98.17.91`, `187.52.117.52`, `153.92.4.176`, INNOVERA Chat, its LiteLLM gateway, its vLLM process, its GPU, or its NGINX — except by an owner-approved, written runbook step executed by the owner.
2. **Never fabricate** a gateway model name, endpoint, host, port, context length, or capability. `http://litellm:4000` is a plausible-looking guess and must not be written anywhere.
3. **Never fall back to a public model provider** — not in production, not in staging, not to unblock a benchmark. Allowlist-primary guard, denylist, key-prefix tripwire, resolved-IP pinning, 3xx-is-a-policy-violation, SDK lint ban.
4. **`ocr-worker` holds no AI credential and has no default route off `ocr-internal`.** It parses attacker-supplied binaries; giving it an outbound socket and a bearer token turns a decoder CVE into an exfiltration primitive against the existing INNOVERA estate.
5. **Deterministic OCR is the record.** No probe result, benchmark, or model release flips this.
6. **NFC only. NFKC/NFKD banned pipeline-wide**, including tests and benchmark scoring.
7. **Fixtures are 100 % synthetic.** Committing a real customer document is a P0 incident, enforced by a CI check.
8. **No secret** in a repo, a log, a report, a screenshot, or a plan file. Gateway credentials arrive out-of-band only.
9. **No production deploy, DNS cutover, provider activation, paid action, or destructive database operation** without a separate explicit approval, a backup, and a written rollback.
10. **No scope widening across milestones.** A discovered lane becomes a backlog artefact or a new milestone plan, never an unannounced addition to the one in flight.

---

## Success measures — measurable

| # | Measure | Target | First measured at | Source of truth |
|---|---|---|---|---|
| SM-1 | Thai OCR character error rate | **median CER ≤ 5 %, p95 CER ≤ 20 %** on the ≥200-doc stratified Thai corpus | M2 | `bench/results/<iso>_<engine>.json` |
| SM-2 | Diacritic-restricted CER (U+0E31, 0E34–0E3A, 0E47–0E4E) | reported every run; no regression vs baseline | M2 | same |
| SM-3 | Field-level exact match after typed normalisation | per-field + `document_exact`; baseline set at M2, gated at M3 | M2 (OCR-only) / M3 (AI) | same |
| SM-4 | Critical-field escape rate (wrong value auto-accepted) | **≤ 0.1 %** critical, **≤ 2 %** normal — ⚠ **owner has not supplied this number** (`f` blocker 2) | M3 | audit sample + review queue |
| SM-5 | Confidence calibration | **ECE ≤ 0.05** per calibration key, else `calibratedP = null` and the hard gates must fail closed | M2 | calibration fit report |
| SM-6 | Cross-tenant isolation | 100 % of `TENANT_TABLES` negative tests deny; `ocr_worker` deny-list tests deny | M1 | integration suite |
| SM-7 | Intra-tenant isolation | a non-owner, non-workspace-member, non-grantee reads **404** for every document surface | M1 | integration suite |
| SM-8 | Exactly-once billing | forced double-claim ⇒ exactly 1 `ai_calls` row | M3 | integration suite |
| SM-9 | Crash resumption | SIGKILL mid-document ⇒ re-claim resumes from page checkpoints and completes; `ocr_lease_lost_total == 0` over a 60-min soak at full concurrency | M1 (basic) / M7 (soak) | soak report |
| SM-10 | End-to-end auditability | from one `documentId`: upload → scan verdict → route decision → render → OCR line + quad + confidence → AI proposal → provenance verdict → correction → approval | M4 | one SQL trace, recorded |
| SM-11 | Log hygiene | zero filename / email / raw IP / OCR text / field value / key material in logs; CI hygiene check green | M1 | `scripts/check-log-hygiene.sh` |
| SM-12 | Estate non-impact | INNOVERA Chat p95 latency unchanged within the owner's stated tolerance while OCR runs at its rated load | M3 | owner-observed, recorded |
| SM-13 | Limits coherence | one generated limits module; NGINX ↔ Next proxy ↔ app ↔ clamd ↔ DB CHECK all derive from it; boot assertion fails closed on mismatch | M1 | startup assertion + CI test |

---

## Milestone map M0–M8

| M | Name | Gateway-blocked? | Effort band | Retires |
|---|---|---|---|---|
| **M0** | Architecture, AI capability discovery, **and contradiction arbitration** | No (discovery half partially owner-blocked) | S (remaining) | Building on a self-contradicting design |
| **M1** | Foundation, secure ingest, deterministic OCR | **No** | XL | Schema/grant/compose irreversibles; hostile-input class; queue correctness |
| **M2** | OCR quality benchmark, calibration, threshold measurement | **No** | L | Every unmeasured constant; the engine bet; over-confident auto-accept |
| **M3** | AI extraction behind the provenance verifier | **YES — hard-blocked** | L (+M for branch V) | Hallucination; prompt injection blast radius; token/GPU cost |
| **M4** | Review UI, corrections, approval, search, export | Partially (field editing needs M3) | L | Unauditable approvals; XSS on attacker text; Thai search/sort |
| **M5** | External API, tenancy operations, quotas, usage | No | M–L | Key leakage; cost DoS; billing disputes |
| **M6** | PDPA operations, retention, data lifecycle | No | M | The cascade-delete retention trap; erasure vs audit conflict |
| **M7** | Hardening, scale, performance, DR | No | M | Single-document latency ceiling; seccomp/supply-chain gaps; restore-blind DR |
| **M8** | Deployment and launch readiness | Partially (host + network answer) | M | Edge/estate collisions; unrehearsed cutover |

**Effort bands are estimates with no measured basis.** S ≤ 1 engineer-week · M = 2–4 · L = 5–8 · XL = 9–14. They will be wrong until M2 measures the per-page cost, which is currently stated three ways across the corpus (4.5 / 12 / 25 CPU-seconds per page).

---

## Milestone detail

### M0 — Architecture, AI capability discovery, and contradiction arbitration

| | |
|---|---|
| **Objective** | Produce the design corpus, discover what can be known about the AI gateway without touching production, and **arbitrate every contradiction that an M1 artefact would freeze**. |
| **Scope IN** | 14 dimension documents ✅ · adversarial panel ✅ · repository context ✅ · this program plan ✅ · M0 synthesis report, complete through §S ✅ (`process/general-plans/reports/M0_ARCHITECTURE_REPORT_09-09-26.md`) · `docs/architecture/m0/limits.md` (or `limits.yaml` + generated module) · `docs/architecture/m0/ai-contract.md` · a written arbitration for each of the nine contradictions · revised data-model design (panel P8) · ADR index · `docs/product/mvp-scope.md` · owner blocker pack sent and answered |
| **Scope OUT** | Any code. Any `package.json`, `schema.prisma`, migration, Dockerfile, CI workflow, lockfile or `.env`. Any container build. Any gateway call. Any git remote push. |
| **Entry criteria** | The brief; read-only access to this workstation; the do-not-contact list understood. |
| **Exit criteria** | All nine contradictions closed with a **named winner and a one-line reason** · `limits.md` and `ai-contract.md` exist and every dimension doc cites rather than restates them · M0 report complete through §S · owner has answered the M1-blocking questions (see [Owner-blocked register](#owner-blocked-register)) · **STOP FOR REVIEW** |
| **Deliverables** | `docs/architecture/m0/*.md` (done) · M0 report A–S (done) · this plan (done) · **still to write:** `limits.md` · `ai-contract.md` · `arbitration-notes.md` · revised `g-data-model.md` §5 · `phase-00b-m0-reconciliation_PLAN_12-09-26.md` · then `phase-01-…_PLAN_…md` |
| **Dependencies** | None internal. Owner answers gate the *numbers*, not the arbitration. |
| **Risks retired** | R-01 building on contradictory foundations · R-02 fabricated gateway facts · R-03 discovering a fatal schema defect after migration 0003 |
| **Effort** | S (3–5 eng-days remaining) + owner time |

**Correction to the ground truth this program inherited** — record it once, here, so no future session re-derives it wrongly:

| Inherited claim | Corrected finding | Source |
|---|---|---|
| "Apple Silicon, `/opt/homebrew` present" | **Intel Core i5-1038NG7, x86_64.** No `/opt/homebrew`. | `a` §10, `b` §0.1, `d` §0, `m` §0.1 — four independent derivations |
| "Items C, D, E cannot be resolved; report as blocker" | **Item E is RESOLVED: text-only, high confidence.** Items C and D are **partially resolved** — env var names, base-path convention, auth header, network class, edge proxy and the `innovera-ai` alias all came from INNOVERA's own **public** repo `WeiWutichai/innovera-chat`, read over `raw.githubusercontent.com` with no production host contacted. | `b` §1.11, §3.1, §5.0 |
| "System Python 3.9.6 only" | `uv 0.11.17` is installed and manages CPython 3.11.15. The worker does not have to plan around 3.9. | `a` §10, `b` §0.1 |
| Stack pins from jawbong (Node 22 / Next 16.2.12 / pnpm 11 / Prisma 7.9.1 / Zod 4.4.3) | **Stale for a new project.** `a` §3.7 is the single source of truth: Node 24.21.0, Next 16.3.4, pnpm 12.3.4, Prisma 7.10.0 (CLI/client lockstep), Zod 4.5.4, eslint 9.39.5. | `a` §3, §10.1 |

**What remains genuinely blocked:** the literal `LITELLM_BASE_URL` value, a dedicated virtual key, the authorised model list, whether `ocr-web` may join `innovera_default`, the gateway version (and the LiteLLM 1.82.7/1.82.8 backdoor question), and whether the gateway persists prompt bodies. All six are owner-supplied. **None of them blocks M1 or M2.**

---

### M1 — Foundation, secure ingest, deterministic OCR

| | |
|---|---|
| **Objective** | A running two-process system that accepts a document **safely** and produces auditable OCR text with per-line geometry and confidence. **No AI anywhere.** |
| **Scope IN** | Git repo + remote + branch protection · toolchain pinned to `a` §3.7 · layering enforced twice (dependency-cruiser + `eslint-plugin-boundaries`) **including the known-bad-fixture test** · Prisma schema + hand-written SQL migrations **as revised by panel P8** (workspace/visibility model, partial fingerprint uniqueness, run discriminator on OCR evidence, composite FKs on the bare pointers, limits CHECKs from `limits.md`) · three isolation layers + RLS `FORCE` + four DB roles · `FileStorage` port + local adapter + `assert_safe_object_key` in both languages · **one** object-key grammar · ingest gate (`file-type@22` allowlist, polyglot rejection with the 65,557-byte tail window, PDF bomb guards incl. `/UserUnit`, Pillow ≥12.3.0 pixel caps, NFKC filename rule with grapheme truncation, busboy limits) · `ScanProvider` + `UPLOADED → SCANNING → SAFE` states **and the rule that no `ocr_jobs` row exists before `SAFE`** · `ocr_jobs` queue with lease/fencing wrapped in `SECURITY DEFINER` functions and a hashed lease token (panel P2) · Python worker: render (pypdfium2) → bounded Thai-safe preprocessing → PP-OCRv5-th on RapidOCR/ONNX → per-line quads + confidence · **one** native-vs-OCR routing implementation (`e` §4.3 owns it; `f` §P1b deleted; CI lint forbids a second) with the ink-corroboration probe and a rendering `VECTOR_ONLY` route · `NormalizedDocument` + `[PAGE n]` serialisation · append-only OCR evidence · minimal document list/detail (no editing) · pino/structlog allowlist redaction + `ocr_` metrics + `/healthz` `/readyz` · synthetic Thai fixture generator + disposable test DB harness · `docker-compose.yml` base + `.dockerignore` + build-context check |
| **Scope OUT** | **Every AI call.** Review editing/approval · external M2M API · webhooks · export · search index · OOXML/`PK\x03\x04` (rejected at the door in M1) · HEIC · `.doc`/`.ppt` · SSE (built, flagged off) · production deploy · seccomp custom profile · tracing |
| **Entry criteria** | M0 exit met · nine contradictions closed · owner has answered: upload cap, page cap, production host size, malware-in-M1 decision, tenancy model, git remote, ICU `th-TH` collation acceptance (**irreversible at `initdb`**) |
| **Exit criteria** | All seven program-level verification conditions · **plus** SM-6, SM-7, SM-11, SM-13 met · a 50-page Thai scan completes end-to-end and every page carries text + quads + a confidence number · a SIGKILL mid-document resumes and completes · the ingest corpus of hostile fixtures (polyglot, bomb, ZIP64, `/UserUnit`, RTL-override filename, EICAR-in-PDF) is rejected or quarantined, each with the right code · **STOP FOR REVIEW** |
| **Deliverables** | The repository · migrations 0000–00nn · both container images · the ingest gate · the queue protocol functions · the worker · the routing module · the fixture generator · CI · milestone report |
| **Dependencies** | M0 |
| **Risks retired** | Every schema/grant/compose irreversible · hostile-upload class · queue lease correctness · Thai collation irreversibility · credential-boundary drift |
| **Effort** | XL (9–14 eng-weeks) |

---

### M2 — OCR quality benchmark, calibration, threshold measurement

| | |
|---|---|
| **Objective** | Replace every prior in the corpus with a measured number, and produce the **first accuracy figures this project is allowed to state**. |
| **Scope IN** | Synthetic corpus pipeline (HTML → WeasyPrint/Sarabun → pypdfium2 → OpenCV degradation) · a **≥200-document stratified Thai corpus with field-level ground truth**, including the hostile strata the panel demands: forged OCR sandwiches (layer text ≠ image text), text-converted-to-outlines, annotation-appearance-only pages, blank/duplex backs, borderless Thai government tables, thermal receipts, phone photos · `bench/run_bench.py` + committed results + `baseline.json` ratchet + generated `REPORT.md` · CER (median + p95, NFC, line-structure-normalised) + diacritic-restricted CER + advisory newmm WER + `line_order_tau` + field-level exact match · **per-page wall-clock and RSS measurement** → regenerate `limits.md` and every derived cap · routing threshold sweep + the shadow-sampling detector for silent loss on NATIVE-routed pages · the anisotropic crop-side pad experiment as the #1 Thai accuracy experiment (panel P1 replaces the unclip sweep) with the unclip ratio demoted to secondary and re-centred on the runtime default · backend ablation ONNX RT / OpenVINO / native Paddle on the Thai mobile pair · DPI ablation 300/400/600 · confidence calibration (isotonic → breakpoint tables) on the **widened** calibration key (`engine, engineVersion, modelId, scriptTag, spanKind, backend, backendVersion, renderDpi, detParamsHash, pipelineVersion`) · escalation trip-rate instrumentation with the 8 % kill threshold |
| **Scope OUT** | Any AI call · any gateway contact · UI work · new product surface |
| **Entry criteria** | M1 `✅ VERIFIED` · a Thai corpus exists (owner-supplied real corpus, or an explicit written owner acceptance that synthetic-only measurement is sufficient and that the first real measurement will be a customer's production data) |
| **Exit criteria** | **The benchmark gate** (see §"The benchmark gate") passes, or a named CPU-only remediation is costed and scheduled · `limits.md` regenerated from measured cost, and the boot assertion proves all five layers agree · ECE ≤ 0.05 per key, or `calibratedP = null` and the hard gates are *proven* to fail closed · a deploy gate refuses to start in prod if any registered `(engine × backend × dpi)` combination has no calibration map · **STOP FOR REVIEW** |
| **Deliverables** | The corpus + `ground-truth.json` + `manifest.json` · `bench/` · the calibration maps · a regenerated `limits.md` · the ablation report · milestone report |
| **Dependencies** | M1 |
| **Risks retired** | The 25×-spread per-page constant · the engine bet · silent over-confident auto-accept after a backend swap · uncalibrated routing thresholds · silent content loss on NATIVE pages |
| **Effort** | L (5–8 eng-weeks) + corpus labelling, which is human effort, not engineering effort |

---

### M3 — AI extraction behind the provenance verifier ⛔ **HARD-BLOCKED ON THE GATEWAY**

| | |
|---|---|
| **Objective** | The LLM **proposes** typed fields; the verifier decides. A proposal that cannot be located in the OCR text of its cited page is not a low-confidence value — it is not a value. |
| **Scope IN** | `AiProvider` transport port · the AI-orchestration placement decided in M0 (**recommended: a dedicated single-purpose `ai-egress` service, or an `ocr-web`-consumed `AI_EXTRACT` job kind — never a gateway credential in the process that parses hostile PDFs**) · one env module with the four-layer egress guard · run the probe ladder, pin the structured-output rung once · chunk planner + coverage assertion + **persisted chunk plan and `chunkPlanHash` in the analysis identity** (panel P6-ops) · the provenance verifier with the panel P6 corrections: page-scoped search, per-**row** citations for table cells, an 8-code-unit floor on any containment in a scope larger than a matched line, a uniqueness guard, and a **split** hallucination metric so short auto-grounded values cannot mask the release gate · `DERIVED` rung wired in · merge algebra with conflict surfacing · prompt versioning + `prompts.lock.json` · `ai_calls` ledger with a unique idempotency key and RESERVED→COMPLETED · templates + tenant-text sanitisation · injection controls (nonce fencing, zero agency, invisible-text suppression, `groundingPosition` + hard gates 9/10, `criticality === 'critical' ⇒ flaggedForReview`) · cassette-based AI mocking with the nonce-placeholder canonicalisation · a **no-inference `reverify` replay mode** |
| **Scope OUT** | Vision / crop egress unless branch V is selected **and** the Thai-crop check passes **and** crop egress is signed off · auto-approval · tools/function-calling/retrieval/URL-fetch · streaming · public providers |
| **Entry criteria** | **All of:** owner supplied `LITELLM_BASE_URL` + a dedicated OCR virtual key + the authorised model list + the network answer + the gateway version + the LiteLLM-1.82.7/1.82.8 answer + the prompt-body-logging answer · the probe ladder executed successfully, **including the Thai UTF-8 round-trip (P0)** · M2 benchmark gate passed · the AI-boundary arbitration from M0 implemented |
| **Exit criteria** | Program-level conditions · SM-4 measured and inside the owner's stated escape rate · SM-8 (exactly-once billing) proven under a forced double-claim · injection corpus: no injected instruction changes a stored value; every redirected-selection case is flagged for review · **the AI stage can be turned off and the product still ships OCR-only** (proven by a test) · **STOP FOR REVIEW** |
| **Deliverables** | The intelligence module · the egress service or job kind · the verifier · prompt version 1 frozen · the ledger · the cassette corpus · the Thai injection corpus · milestone report |
| **Dependencies** | M2 (quality gate) **and** the owner (credentials). Both are hard. |
| **Risks retired** | Fabricated field values · double-billing on retry · unbounded GPU contention with INNOVERA Chat · prompt-injection blast radius |
| **Effort** | L (5–8 eng-weeks); branch V adds M (2–4) |

---

### M4 — Review UI, corrections, approval, search, export

| | |
|---|---|
| **Objective** | A human sees the page, verifies the highlight against the pixels, corrects, and approves — and the record of that is permanent and attributable. |
| **Scope IN** | Review UI with the highlight overlay driven by the D16 inverse homography (**no box is drawn for an unverified reference**) · both confidence numbers presented separately, never fused · append-only `corrections` via `POST …/corrections` (never `PATCH`) · approval workflow as a privilege boundary · injection-suspected reviewer banner · CSP moved to **enforcing**, `react/no-danger` enforced, OCR text rendered as plain text only · SSE authorised per event · Thai search (the GIN index migration `CREATE INDEX CONCURRENTLY`, newmm tokens already stored since M1) · ICU `th-TH` sort · CSV (`shape` wide/long/items, BOM on) and XLSX (1 M cells / 50 k rows cap) export with formula-injection prevention · i18n (`next-intl`, `localePrefix: 'always'`) + self-hosted IBM Plex Sans Thai · the Vercel-light design system (`l` L-11) · **OOXML ingest with every `j` §3.3 limit**, or an explicit decision to defer it again |
| **Scope OUT** | PDF report generation · auto-approval · multi-step approval roles (unless the owner answers `g` Q5 otherwise) · tablet/warehouse reviewer ergonomics |
| **Entry criteria** | M3 `✅ VERIFIED` for field editing; the OCR-only review surface (text, geometry, corrections on OCR output) may start after M2 if the owner wants the human loop earlier — **this is the one legal parallelisation in the program** |
| **Exit criteria** | Program-level conditions · SM-10 (one recorded end-to-end trace) · every export shape round-trips a Thai document with `฿1,234.56`, a 13-digit national ID and a BE date correctly · a11y keyboard flow for the critical review path · **STOP FOR REVIEW** |
| **Dependencies** | M3 (fields), M2 (geometry + confidence) |
| **Risks retired** | Unauditable approvals · stored XSS from attacker-controlled OCR text · Thai sort/search unusability · a confident highlight over text that does not support the value |
| **Effort** | L |

---

### M5 — External API, tenancy operations, quotas, usage

| | |
|---|---|
| **Objective** | Another system can drive the platform, under keys, quotas and rate limits, without any cookie or browser assumption. |
| **Scope IN** | `POST /api/v1/ocr` 202 + poll · API keys `ocr_live_{keyId}_{secret}`, HMAC-with-pepper at rest, two-key rotation, per-key rate limits · usage accounting and quota enforcement in Postgres in the same transaction as the usage row · the billable-page definition (owner-decided) · admin MFA and `admin_access_log` · CORS default-off (`l` L-19) · idempotency on the public surface · OpenAPI generated from the same limits module |
| **Scope OUT** | **Webhooks and `fileUrl` — declined (`j` D27, panel P5).** Billing/invoicing integration · self-service signup · partner/cross-tenant sharing |
| **Entry criteria** | M4 `✅ VERIFIED` (or M3 + the internal API surface, if the owner defers the review UI) |
| **Exit criteria** | Program-level conditions · a key scoped to tenant A returns **404** for every tenant-B id · quota exhaustion returns a branded 429 with the reset time in `Asia/Bangkok` · key leakage anomaly rules fire in a test · **STOP FOR REVIEW** |
| **Dependencies** | M4 |
| **Risks retired** | Key leakage · cost DoS by one tenant · billing disputes with no per-request record |
| **Effort** | M–L |

---

### M6 — PDPA operations, retention, data lifecycle

| | |
|---|---|
| **Objective** | Every artefact class expires on its own clock, erasure is lawful and provable, and the audit trail survives it. |
| **Scope IN** | **Per-artefact expiry clocks instead of a cascade from `documents`** (panel P8-ops): `OcrResult.expiresAt`, `DocumentPage.textExpiresAt`, `Document.purgedAt` tombstone, and a decision on whether corrections outlive their documents in de-identified form · a separate `ocr_retention` role with its own GUC, distinct from `ocr_erasure` · purge job with batch size, lock budget and `--dry-run` · deletion receipts · subject export and erasure endpoints · tenant-visible admin access log · audit-log partitioning if the retention answer forces it · `pg_dumpall --globals-only` alongside `pg_dump`, plus a startup assertion that the four roles and every expected policy exist · restore-with-deletion-replay drill · DPA / RoPA / cross-border determination with Thai counsel |
| **Scope OUT** | Envelope encryption (evaluated in M7) · region pinning enforcement |
| **Entry criteria** | M5 `✅ VERIFIED` · counsel has answered the audit-vs-erasure tension and the sensitive-category question (`j` B8) |
| **Exit criteria** | Program-level conditions · a document whose original has expired still renders its review page **or** the retention design is corrected so it cannot (the day-91 blank-viewer trap) · a restore to a fresh instance produces a **crash-loop, never zero rows**, when roles are missing · **STOP FOR REVIEW** |
| **Dependencies** | M5; counsel |
| **Risks retired** | The cascade-delete retention trap · a deletion claim backups contradict · a role-less restore that silently serves nothing |
| **Effort** | M |

---

### M7 — Hardening, scale, performance, DR

| | |
|---|---|
| **Objective** | Prove the system survives its own load and its own worst day. |
| **Scope IN** | Custom seccomp profile derived from a **recorded syscall trace** of a real job · COEP after auditing external resources · SBOM + image scanning as a CI gate · API-key anomaly detection · load test to the stated single-document latency SLO · **per-page fan-out with the fan-in barrier if and only if the M2 measurement shows the SLO cannot be met with one job per document** (panel P2 — under one-job-per-document there is *no other lever*, replicas do not speed a single document) · progress-conditional `BUDGET_EXCEEDED` so checkpointed work is never stranded · admission control derived from the measured per-page cost rather than a flat page cap · OpenTelemetry adoption (already `traceparent`-ready) · a second scanner if an availability SLA exists (never fail-open) · envelope encryption evaluation · 60-minute soak proving SM-9 |
| **Scope OUT** | A second GPU · any CUDA OCR process · horizontal DB scaling |
| **Entry criteria** | M6 `✅ VERIFIED`; M2's measured numbers |
| **Exit criteria** | Program-level conditions · the on-call runbook answers "a job failed on budget" without "ask the customer to re-upload" · a killed worker container is **not** a better outcome than letting the system run · **STOP FOR REVIEW** |
| **Dependencies** | M6, M2 |
| **Risks retired** | Single-document latency ceiling · restore-blind DR · supply-chain blindness |
| **Effort** | M |

---

### M8 — Deployment and launch readiness

| | |
|---|---|
| **Objective** | Hand the owner a deployable, reversible, documented stack — and stop. |
| **Scope IN** | Host decision (fresh host ⇒ Caddy in-stack; existing NGINX host ⇒ the proposal-only handover in `m` §3) · prod compose overlay with no `build:` section, loopback-only publishing, explicit subnets · preflight: NGINX ≥ 1.30.4 / 1.31.4, an explicit `default_server` on `:443`, subnet-collision check, port block 8410/8411/8432 · `docker/backup.sh` (currently mounted by compose and never written) · off-box backup destination + a dedicated key · runbooks for every paging alert · repositories set **private** · staged cutover plan with a rollback · the launch checklist |
| **Scope OUT** | **Pressing the deploy button.** DNS cutover. Any change to the incumbent's NGINX without the owner running it. Live payment/provider activation. |
| **Entry criteria** | M7 `✅ VERIFIED` · owner answered the host, the `innovera_default` membership question, and the backup destination |
| **Exit criteria** | Program-level conditions · a full deploy rehearsal on a disposable target succeeds and rolls back · the owner has the file, the command sequence and the rollback in writing · **STOP FOR REVIEW — deployment itself is a separate, explicitly approved action** |
| **Dependencies** | M7; owner host decision |
| **Risks retired** | Edge/estate collisions · unrehearsed cutover · a backup that was never written |
| **Effort** | M |

---

## Dependency graph and the gateway-blocking analysis

```text
M0  Architecture + arbitration
 └─> M1  Foundation · secure ingest · deterministic OCR        ← NOT gateway-blocked
      └─> M2  Benchmark · calibration · measured limits        ← NOT gateway-blocked
           ├─────────────────────────────┐
           │                             │
           ▼                             ▼
        M3  AI extraction          M4(partial)  OCR-only review surface
        ⛔ HARD-BLOCKED on          (text + geometry + corrections;
           the AI gateway            legal to start after M2)
           │                             │
           └──────────┬──────────────────┘
                      ▼
                 M4  Review UI · corrections · approval · search · export
                      └─> M5  External API · tenancy ops · quotas
                           └─> M6  PDPA ops · retention · lifecycle
                                └─> M7  Hardening · scale · DR
                                     └─> M8  Deployment + launch readiness
                                             (owner host answer feeds preflight from M0 onward)
```

### The key scheduling insight

| | |
|---|---|
| **Hard-blocked on the AI gateway** | **M3 only.** Its entry criteria cannot be met without the owner: the literal `LITELLM_BASE_URL`, a dedicated virtual key, the authorised model list, the network answer, the gateway version + backdoor answer, and the prompt-body-logging answer. |
| **Not blocked at all** | **M1 and M2** — which together are the majority of the build (XL + L against M3's L). Items G, H, I, J, K, L (OCR engine, Thai, service split, storage, data model, queue) touch no gateway. A PDF→raster step is mandatory in *every* branch, so the whole imaging path is buildable today. |
| **Blocked on the owner but not on the gateway** | M0 exit needs six numbers (upload cap, page cap, host size, malware decision, corpus availability, escape-rate target) and one irreversible acceptance (ICU `th-TH` collation). M8 preflight needs the host decision. None of these require the gateway. |
| **Consequence** | **Do not stall the program waiting for B-1.** Start M0 closeout now, then M1. The gateway answer is only on the critical path from the point where M2 has already produced measured CER. Realistically that is months away, which is the schedule slack the owner has to answer B-1 in. |
| **The trap to avoid** | Building M1 artefacts that *encode* a gateway assumption — compose networks, DB grants on `ai_calls`, the env module, the `AI_EXTRACT` claim predicate. Four M0 documents currently disagree about the credential holder, and a paste-ready grant script would decide it silently. **The M0 `ai-contract.md` exists precisely to stop M1 betting.** |

---

## Definition of Done, per milestone

Every milestone must tick the **shared block** plus its **milestone-specific block**. A milestone with an unticked box is not `✅ VERIFIED`, regardless of how much of it works.

### Shared DoD (all milestones M1–M8)

- [ ] `pnpm typecheck` green (TypeScript strict, no `any` escape hatch added)
- [ ] `pnpm lint` green (ESLint 9.39.5, `react/no-danger` where applicable)
- [ ] `pnpm depcruise` **and** `eslint-plugin-boundaries` green, **and** the known-bad-fixture test proves the enforcers still fail on a violation
- [ ] `pnpm build` green; both container images build reproducibly; `.dockerignore` verified by `scripts/verify-build-context.sh`
- [ ] Unit + integration suites green (Vitest, pytest); Python↔Node contract corpus green in both languages
- [ ] The milestone's named E2E green
- [ ] **Negative tests** green as denials: authorization, cross-tenant, intra-tenant, idempotency, error paths
- [ ] Security review of the milestone's blast radius recorded; **zero open Critical/High**
- [ ] `scripts/check-log-hygiene.sh` green; no PII in any test output, screenshot, or report
- [ ] Regression checks against every previously verified overlapping surface, recorded in the format `Regression: [surface] — [PASS|FIXED|BLOCKED]`
- [ ] Milestone report written to `reports/` with commit SHA, exact commands, pass/fail, deviations, blockers, redaction statement
- [ ] `process/context/all-context.md` updated in the same patch if durable operational knowledge changed
- [ ] Execution changes committed via `vc-git-manager`, separate from process/plan commits
- [ ] **STOP FOR REVIEW** — owner has seen the evidence and said go

### M0

- [ ] All nine contradictions closed, each with a named winner and a one-line reason
- [ ] `docs/architecture/m0/limits.md` exists; every other doc **cites** it and restates no number
- [ ] `docs/architecture/m0/ai-contract.md` exists; env var names, `/v1` convention, credential holder, egress guard, and the "gateway unresolved" boot state are all fixed
- [ ] `g-data-model.md` §5 revised: workspace/visibility model, partial fingerprint uniqueness, OCR-evidence run discriminator, composite FKs on the bare pointers, limits CHECKs
- [x] M0 synthesis report complete through §S — `process/general-plans/reports/M0_ARCHITECTURE_REPORT_09-09-26.md`
- [ ] ADR index exists; `docs/product/mvp-scope.md` exists
- [ ] Owner blocker pack sent, and the six M1-blocking answers received
- [ ] **No code, no `package.json`, no migration, no image, no gateway call was produced by M0**

### M1

- [ ] A 50-page Thai scan completes upload → scan → route → render → OCR, and every page carries text, quads and a confidence number
- [ ] The hostile-fixture corpus is rejected or quarantined with the correct error code for each: polyglot, decompression bomb, ZIP64, data-descriptor, `/UserUnit` giant page, RTL-override filename, `PK\x03\x04`, EICAR-in-PDF
- [ ] `ocr_worker` is proven **unable** to: read `users`/`documents`, write another org's job row, read a lease token, write `ai_calls`, or resolve a hostname
- [ ] `docker inspect ocr-worker` shows exactly one network and **zero** env keys matching `/API_KEY|_KEY_FILE|LITELLM|AI_GATEWAY/` — as a **blocking deploy gate**, not a note
- [ ] Intra-tenant: a non-owner, non-member, non-grantee gets **404** on every document surface
- [ ] The boot assertion compares app cap ↔ NGINX `client_max_body_size` ↔ Next `proxyClientMaxBodySize` ↔ clamd `StreamMaxLength` ↔ the DB CHECK, and **refuses readiness on mismatch**
- [ ] SIGKILL mid-document ⇒ re-claim resumes from page checkpoints and completes
- [ ] Exactly one native-vs-OCR routing implementation exists; CI fails the build on a second
- [ ] `ICU th-TH` collation confirmed at `initdb` (**irreversible**) and recorded

### M2

- [ ] `bench/results/<iso>_<engine>.json` committed; `bench/baseline.json` set; `bench/REPORT.md` generated
- [ ] The benchmark gate passed, **or** the named CPU-only remediation is written, costed and scheduled
- [ ] `limits.md` regenerated from the **measured** per-page cost; the 4.5 / 12 / 25 s/page spread is resolved to one number with evidence
- [ ] Calibration: ECE ≤ 0.05 per key, or `calibratedP = null` **and** a test proves hard gates 5/7/8 fail closed on a null
- [ ] A deploy gate refuses production start for any registered `(engine × backend × dpi)` with no calibration map
- [ ] The hostile strata (forged sandwich, outlined text, annotation-AP-only, blank duplex) are each measured and each has a recall assertion in `tests/routing/`
- [ ] The shadow-sampling detector for silent loss on NATIVE pages is running and alarming

### M3

- [ ] The probe ladder executed, including the **Thai UTF-8 round-trip (P0)**; the verbatim results are in the report
- [ ] The structured-output rung is probed once and **pinned**; a per-request downgrade is impossible
- [ ] Forced double-claim ⇒ exactly **1** `ai_calls` row
- [ ] The injection corpus: no injected instruction changes a stored value; every redirected-selection case is flagged for review and **not** silently grounded
- [ ] No value shorter than 8 code units reaches grounding 1.00 by containment in a scope larger than a matched row/line span
- [ ] `hallucinationRate` is reported over independently-cited fields only; `shortValueAutoGrounded` is a separate tracked ratio
- [ ] The chunk plan and `chunkPlanHash` are persisted and are part of the analysis identity; `reverify` mode runs with **zero** GPU calls
- [ ] Turning the AI stage off leaves a working OCR-only product — proven by a test, not by argument

### M4

- [ ] SM-10: one recorded SQL trace from a single `documentId` through every stage
- [ ] No highlight box is drawn for an unverified source reference — proven by a test
- [ ] CSP is **enforcing**; a fixture document whose OCR text contains `<script>`, a Markdown image, and an RTL override renders as inert plain text
- [ ] Every export shape round-trips `฿1,234.56`, a 13-digit Thai national ID, a Thai company name, and a BE date correctly in Excel and in a text editor
- [ ] Thai sort works (`SELECT 'ก' < 'เ' COLLATE "th-TH-x-icu";`) and paginates consistently across a cursor boundary

### M5

- [ ] A key scoped to tenant A returns **404**, never 403, for every tenant-B id
- [ ] Quota exhaustion returns a branded 429 with the reset time in `Asia/Bangkok`
- [ ] Per-request usage rows reconcile exactly with the `ai_calls` ledger
- [ ] `/api/v1/**` rejects cookie auth by design; CORS sends no `Access-Control-Allow-Origin` by default

### M6

- [ ] OCR text expires at its own clock without destroying the fields or the corrections that describe it
- [ ] A `--dry-run` purge reports counts and commits nothing
- [ ] An erasure produces a deletion receipt and the audit trail survives it
- [ ] A restore to a fresh instance with missing roles produces a **crash-loop**, never zero rows
- [ ] Counsel sign-off recorded for: sensitive-category classification, the audit-vs-erasure tension, cross-border transfer

### M7

- [ ] Seccomp profile derived from a recorded trace, not hand-written; the worker still runs
- [ ] 60-minute soak at full concurrency: `ocr_lease_lost_total == 0`
- [ ] A job that exhausts its budget having made page progress is **retryable** and resumes from checkpoints
- [ ] Admission control rejects at upload what the platform provably cannot finish, with an honest message
- [ ] SBOM produced; image scan gate blocking; DR rehearsal recorded end-to-end

### M8

- [ ] Preflight recorded: NGINX version, `default_server` presence, subnet collision, free ports
- [ ] `docker/backup.sh` exists, runs, and its output restores
- [ ] A full deploy rehearsal on a disposable target succeeds **and rolls back**
- [ ] Repositories are private
- [ ] The owner holds the file, the command sequence and the rollback in writing — **and the deploy itself is a separate approval**

---

## The two M3 branches — T vs V

**Current evidence: branch T.** INNOVERA Chat's production source states verbatim that *"the deployed model is text-only … No OCR, no vision, and no image bytes ever leave the server for the LLM."* Written by the team that operates the gateway, eight days before M0. Confidence **high**. Build T.

**Both branches share everything except one optional port method and one env var.** That is the entire point of the port shape, and it is why M3 is a single milestone rather than two.

| Aspect | **Branch T — text-only** (build this) | **Branch V — vision-capable** (add only if all three triggers fire) |
|---|---|---|
| Who produces the text of record | OCR engine, 100 % | OCR engine, 100 % — unchanged, no reversal trigger |
| What the model receives | Text + layout coordinates. **No pixels ever leave the OCR stage.** | Text + layout, **plus small cropped regions** for targeted re-reads. Never a full page. |
| Low-confidence regions | Flag for human review | Optional VLM re-read of that crop; accepted **only** if it agrees with the engine or clears a bar, else human review |
| Table reconstruction | Geometric heuristics over OCR boxes | Same, with optional VLM assist on failure |
| `AiProvider` surface | `analyzeChunk` / `repairChunk` / `health` / `capabilities`; `readCrop` **undefined** | `readCrop` implemented |
| Config signal | vision model alias unset | vision model alias set |
| Egress surface | **Text only — smallest** | Text + image crops — **larger; needs explicit owner sign-off** |
| PII posture | An ID document's pixels never leave the host | `thai-id-card` crops are **excluded regardless**; `readCropPolicy` defaults to `disabled` and is opt-in per template |
| Extra M3 effort | — | +M (2–4 eng-weeks) |
| Extra M3 risk | — | GPU contention with INNOVERA Chat becomes material; a vision batch can occupy the GPU long enough to visibly degrade Chat |

**The three triggers that must all fire, in order, before branch V is built:**

1. `GET /model_group/info` reports `supports_vision: true` for an alias OCR is authorised to call, **or** the 64×64 PNG probe returns HTTP 200. *(A `false` from LiteLLM is not trustworthy for a self-hosted vLLM alias; a 1×1 PNG is a bad probe — Qwen-VL preprocessors tile to 28×28 patches with a `min_pixels` floor and will reject it on dimension grounds.)*
2. A **manual Thai-crop check** shows the model actually reads Thai script — vision capability is necessary but not sufficient.
3. Measured crop-level accuracy on a Thai validation set **beats the engine on the low-confidence subset**.

**Verdicts that are not branch V:** `ambiguous` ⇒ stay on T and retest. `text_only` ⇒ T. **Thai round-trip failure ⇒ neither branch** — ship deterministic OCR with no LLM enrichment and treat the gateway as unavailable until the Thai path is fixed. That outranks every other flip condition.

**Re-check triggers that reopen the question later:** the owner names a `…-VL-…` repo · the gateway is upgraded · a model is added · `/model_group/info` changes. Record the check, do not assume the answer persists.

---

## The malware-scanning gate and its risk acceptance

**Recommendation: ClamAV ships in M1.** `j` C13 and `m` O18 both place it there; `m`'s own compose file flags its absence as a defect in red. The panel's finding is not that scanning may be deferred — it is that **the compensating controls RISK-001 leans on do not currently exist in the M1 the other documents specify**.

### Where the gate lands

| Element | Milestone | Non-negotiable |
|---|---|---|
| `ScanProvider` interface | **M1** | Ships even with a no-op implementation |
| States `UPLOADED → SCANNING → SAFE`, plus `QUARANTINED`, `SCAN_FAILED` | **M1** | In the **schema**, in the transition table, as an exported constant with a test — not as an `if` in a controller |
| **No `ocr_jobs` row may exist before `SAFE`** | **M1** | The current presigned-upload flow inserts the document row and the job row in one transaction with no scan step. **Split that transaction.** |
| ClamAV (`ocr-clamd` + `ocr-freshclam`, separate containers, clamd with zero egress) | **M1 (recommended)** | If deferred, RISK-001 applies below |
| `MaxFileSize` / `StreamMaxLength` / `MaxScanTime` | **M1** | Derived from `limits.md`, never hand-typed. The currently-drafted 30 M is derived from a 25 MB cap that three sibling docs contradict; at a 200 MB cap every legitimate 30–200 MB file is **quarantined as malware and pages on-call**. |
| Boot assertion: app cap < clamd `StreamMaxLength`, and clamd's **effective** config has `ScanPDF`/`ScanOLE2`/`ScanArchive` enabled | **M1** | A disabled parser is a silent total bypass |
| EICAR-in-PDF test at exactly the cap | **M1** | Proves cap ≤ StreamMaxLength **and** `ScanPDF yes` in one test |
| Second scanner | **M7** | Only if an availability SLA demands it. **Never fail-open.** |
| Custom seccomp profile | **M7** | Docker's default profile is the M1 baseline |

### If the owner defers scanning to M2 or later — the explicit risk acceptance required

**RISK-001 is not signable as currently written**, because three of its named compensating controls do not exist in the M1 the other dimension docs specify. All of the following must be true before a signature means anything:

- [ ] The **format allowlist is `file-type@22`**, not the five-magic-byte prefix sniffer currently specified in the API document (which also rejects WebP, a type the threat model accepts)
- [ ] **Polyglot rejection exists**: single-format assertion, the 65,557-byte tail window, trailing-data checks, offset-0-only `%PDF-`
- [ ] **The separate serving origin is in M1**, not deferred to M2 — or it is struck from RISK-001's control list and the residual is **re-rated** upward
- [ ] The **state machine ships anyway** with `SCAN_PROVIDER=noop` set **explicitly** (never by default)
- [ ] Production **refuses to boot** without a greppable `ACCEPT_UNSCANNED_UPLOADS_RISK=true`
- [ ] An **admin banner** shows in every environment where it is set
- [ ] RISK-001 carries a **named owner, a review date, and a written exit criterion**
- [ ] The security page, the sales material and the API docs **do not claim** a scanning control
- [ ] `quarantine/` in the storage layout has a **producer**, or it is deleted — a decorative directory implies a control that does not run
- [ ] The signature is recorded in the M1 milestone report, with the owner's name and the date

**If any box is unticked, scanning is not deferred — it is missing.** That distinction is the whole point of the instrument.

---

## The benchmark gate — when CER exists and what it must clear

**CER and WER numbers first exist at the end of M2. Before that, this project has zero measured accuracy figures and may state none.**

Everything in the corpus that reads like an accuracy number today is third-party, attributed, and measured on someone else's corpus. Two of them are in-distribution and from a vendor-co-authored paper. None of them is ours.

### The gate M2 must pass before M3 may start

| # | Gate | Threshold | If missed |
|---|---|---|---|
| G-1 | **Thai CER, median** | ≤ 5 % | M3 does not start |
| G-2 | **Thai CER, p95** | ≤ 20 % | M3 does not start |
| G-3 | Diacritic-restricted CER | reported, and not worse than the overall CER by more than the baseline delta | Investigate before M3 |
| G-4 | Reading-order `line_order_tau` | reported; multi-column stratum called out | Advisory |
| G-5 | Field-level exact match (OCR-only baseline) | recorded per field; this becomes the floor M3 must improve on | Advisory, but M3's own gate is meaningless without it |
| G-6 | Routing recall on the three hostile strata (forged sandwich, outlined text, annotation-AP-only) | each has a hard recall assertion that passes | M3 does not start — these fail **silently** and grounding scores them perfect |
| G-7 | Calibration ECE per key | ≤ 0.05, or `calibratedP = null` with hard gates proven to fail closed | M3 does not start |

**Why this gate exists.** M3 builds an AI layer *on top of* the OCR text. If the OCR text is wrong, the verifier grounds the wrong value at `EXACT, 1.00`, the arithmetic checks pass because every number came from the same bad transcription, and the product emits a confident, fully-grounded, review-flag-free wrong answer. **Bad OCR does not degrade the AI layer; it makes the AI layer's own quality signal lie.** That is why the gate is hard and not advisory.

### If the gate is missed — the named CPU-only remediation

The corpus's documented Plan B (promote the Thai VLM to primary) is **not available**: it needs a GPU nobody has approved, and it contradicts the rule that VLM output is a transcription candidate and never the record. The remediation must be CPU-shaped:

1. Anisotropic crop-side pad sweep (`pad_frac ∈ {0, 0.10, 0.20, 0.30}` along the local short axis only) — free, targets the Thai four-register stack, cannot merge adjacent columns
2. The detector⊕recogniser hybrid (v6 detector ⊕ v5-th recogniser) — a config change, not an integration
3. DPI and backend ablation results applied
4. A commercial Thai OCR API as a **paid escalation tier behind the same port** — no GPU, no estate change

**M2's exit criteria must name which of these runs, and what it costs, before M2 is allowed to close.** Discovering at M2 that the only documented Plan B needs a GPU is a milestone-scale restart arriving after M1 has already baked weights into an image and fit calibration maps per engine version.

---

## M0 closeout: the nine blocking contradictions

Each of these is encoded in an artefact written at M1 time — a migration, a grant script, an RLS policy, a compose network, an NGINX config. Each is free today. **M0 does not close until every row has a named winner and a one-line reason.**

| # | Contradiction | Severity | Docs | Panel | Recommended resolution | Closed? |
|---|---|---|---|---|---|---|
| 1 | The data model omits the **intra-tenant visibility model** its own threat model declared M1-blocking and non-retrofittable. `organizationId` is the only scoping dimension, so every document is visible to every member of a tenant. Plus two unique constraints that break on blank pages and on operator requeue, plus bare-scalar cross-tenant pointers the DMMF check cannot see. | **FATAL** | `g` vs `j` §7.1.1 | P8 | Land `Workspace` / `WorkspaceMember` / `DocumentGrant`; `Document.ownerUserId` and `workspaceId` both **NOT NULL**; partial unique on `kind='ORIGINAL'`; add a run discriminator to the OCR evidence key; composite FKs on the bare pointers. | ☐ |
| 2 | **No single limits contract.** Upload cap 25/200/500 MB; page cap 50/400/1500/2000; per-page cost 4.5/12/25 s; worker pool 4 vs 1; worker memory 2 GB vs 3 GB. Each number gets typed into NGINX, clamd, compose or a DB CHECK. | major | `j` `e` `i` `m` `g` | P2, P5 | One generated `limits` module; every layer derives from it; boot assertion + two CI tests (cap+1 ⇒ 413; EICAR-in-PDF at cap ⇒ QUARANTINED). Ship M1 at the **conservative** cap and re-derive from M2's measurement. | ☐ |
| 3 | **AI-orchestration placement is three mutually exclusive decisions**, two of which each break a security invariant another document argues at length. A paste-ready grant script already decides it silently. | major | `b` `h` `j` `k` `m` | P3, P7 | Write `ai-contract.md`. Recommended: a dedicated `ai-egress` service **or** an `ocr-web`-consumed `AI_EXTRACT` job kind. **Never a gateway credential in the hostile-PDF parser.** Add `AND j.kind = ANY($k)` to the claim so "don't give the worker AI work" is expressible. Gate it in CI. | ☐ |
| 4 | **The queue lease is a convention, not a control.** Column grants constrain *which columns*, never the `WHERE` clause, so a compromised worker can write any org's job row with no lease. Separately `BUDGET_EXCEEDED` is non-retryable, which strands every checkpoint and makes the design *reward* killing the worker. | major | `h` | P2 | Wrap the protocol statements in `SECURITY DEFINER` functions; store the lease token hashed; revoke direct DML; make `BUDGET_EXCEEDED` progress-conditional. | ☐ |
| 5 | **Two different native-vs-OCR routing heuristics** in the same milestone, disagreeing on the motivating example. Plus `sandwich_layer_clean` trusts a third party's invisible text layer on orthography alone, and `VECTOR_ONLY` is a terminal route nothing ever renders. | major | `e` `f` | P4 | `e` §4.3 is the sole implementation; delete `f` §P1b's thresholds; CI lint forbids a second gate. Add pixel corroboration before trusting any sandwich layer; make `VECTOR_ONLY` a rendering route; add the 72-dpi ink-corroboration probe to every non-rendering exit. | ☐ |
| 6 | **"Provenance verification stops prompt injection" is false**, and one document says so while another claims it. Grounding stops *fabricated* values, not a *redirected selection*. Separately, short values self-cite against a 30,000-character chunk, so `find("1")` always succeeds and the headline hallucination metric is structurally blind. | major | `k` §7.6 vs `f` §2.5 | P6 | Retract and replace the false claim verbatim. Add `groundingPosition` + hard gates 9/10. Verify short cells inside their own matched row span. Split the metric. | ☐ |
| 7 | **The OCR geometry contract cannot deliver the redaction feature it is justified by** — no roster engine produces sub-line Thai geometry, and the port has nowhere to put char boxes or the transform back to original-page space. Plus the calibration key omits backend, DPI, detector params and pipeline version. | major | `d` `f` | P1 | Add `emitsSubLineGeometry` and a nullable `TokenSpan.quad`; add `toOriginal` to `OcrPage`; widen the calibration key so an "easy" swap fails closed instead of lying; state the granularity honestly in the scoring matrix. | ☐ |
| 8 | **The M1 upload transport bypasses the malware gate** — the presigned direct-to-store flow inserts the document row and the job row in one transaction with no scan step. Plus three incompatible object-key grammars, which voids the "tenant is the first path segment" isolation argument. | major | `l` vs `j` vs `i` vs `g` | P5 | Keep presigned POST (its OOM argument is correct) but relocate the ingest controls into the complete-handler, split the transaction, and unify on **one** tenant-first key grammar. | ☐ |
| 9 | **Retention is five different lifetimes over a schema of cascade deletes.** They cannot expire independently. Also the render-TTL saving is void from day 91, and `pg_dump` does not carry the roles the isolation model rests on. | major | `j` §9.5 vs `g` | P8 | Give every independently-expiring artefact its own clock; split the retention role from the erasure role; `pg_dumpall --globals-only`; a startup assertion on roles and policy counts. Answer "do corrections outlive their documents" **before any FK is written**. | ☐ |

**Process finding worth carrying into every milestone:** all nine arose because parallel authors re-derived from the same summary and did not open each other's documents. The mechanical fix — **every dimension lists every dimension it read, and the union must be complete** — becomes a review checklist item for every parallel fan-out from here on.

---

## Owner-blocked register

### Blocks M0 closeout / M1 start

| # | Question | Blocks | Accepted answer |
|---|---|---|---|
| O-1 | **Max upload size**: 25 / 200 / 500 MB? | `limits.md`, NGINX, clamd, DB CHECK, API docs | one number |
| O-2 | **Max pages per document**, paired with the per-document time budget (they are the same constraint) | same | one pair |
| O-3 | **Production host size.** 4 vCPU / 8 GB fits exactly **one** worker and does not yet include the ClamAV tier. Recommendation: 8 vCPU / 16 GB. **This is a purchasing decision.** | worker count, all concurrency, all fairness arithmetic | spec |
| O-4 | **Is malware scanning in M1?** | ClamAV in M1, or RISK-001 signed with every box above ticked | yes / no + signature |
| O-5 | **Is a real Thai document corpus available for M2?** Without one, every threshold stays a prior through M2 and the first real measurement is a customer's production data. | M2 entirely | yes + delivery / explicit written acceptance of synthetic-only |
| O-6 | **Target field-level escape rate.** The single most important number the owner has to supply; everything downstream of it is arithmetic. | SM-4, every threshold in the confidence model | e.g. "≤ 0.1 % critical, ≤ 2 % normal" |
| O-7 | **ICU `th-TH` collation** — an **irreversible `initdb` choice**. Changing it later requires a dump and restore of the entire cluster. | migration 0000 | confirm |
| O-8 | **Git org / repo name**, and whether branch protection and pinned-SHA action policy are org-level settings we inherit | repo creation | org/name |
| O-9 | **Tenancy model**: an organisation with many users (assumed), or a user is a tenant? | the whole visibility model | one of the two |
| O-10 | **Retention policy** per artefact class, and whether corrections outlive their documents in de-identified form | every FK's `onDelete`, before any is written | a table |

### Blocks M3 only

| # | Question | Accepted answer |
|---|---|---|
| O-11 | **The literal `LITELLM_BASE_URL`** as set in production `.env.local`. Excludes `/v1`, no trailing slash. **Send out-of-band.** | verbatim, minus the key |
| O-12 | **A dedicated virtual key for OCR** — never Chat's key, never the master key — with its own `rpm_limit`, `tpm_limit`, `max_parallel_requests`, budget and model allowlist | key + limits, out-of-band |
| O-13 | **The authorised model list** for that key, and for each alias its underlying repo and max context | list |
| O-14 | **May `ocr-web` join `innovera_default`**, and is OCR co-located on the GPU host? | T2a / T2b / T2c + network name |
| O-15 | **Gateway product and exact version** — and specifically **did it ever run LiteLLM 1.82.7 or 1.82.8?** Those two PyPI releases were maliciously backdoored in March 2026 and harvested credentials from the host. **We are about to be issued a credential on that host.** | version + "never ran those" / "ran them, rotation completed on `<date>`" |
| O-16 | **Does the gateway persist prompt and response bodies?** (`store_prompts_in_spend_logs`, callbacks, `--detailed_debug`.) OCR sends the text of Thai identity documents, tax filings and contracts. If bodies are logged, INNOVERA has created a **secondary PDPA data store** outside this system's controls, on a multi-tenant host. | "no body logging" / sink + retention + readers |
| O-17 | **Is the GPU shared with INNOVERA Chat?** | yes / no |
| O-18 | **Is a `custom_tokenizer` configured?** LiteLLM falls back to tiktoken, which mis-counts Thai badly — `tpm_limit` would then throttle against fiction. | yes `<tokenizer>` / no |
| O-19 | **What share of the shared gateway/GPU capacity may this product consume**, and what happens to the other INNOVERA products when we saturate it? | a number and an escalation path |

### Blocks M6 / legal track (start in M1)

| # | Question |
|---|---|
| O-20 | PDPA counsel engagement: sensitive-category classification (a Thai ID card carries religion and a photograph); the 7-year-audit vs erasure tension; the DPA template; the cross-border transfer determination. **Two of its outputs are schema constraints**, so it must be started in M1 and settled before M6. |
| O-21 | Thai tax adviser sign-off on the **historical** VAT rate table (statutory 10 %, reduced to 7 % by a Royal Decree with a scheduled expiry — it is a dated lookup, never a constant), the VAT-registration turnover threshold, and the withholding-tax rate table. A web search is not a sufficient source for any of the three. |

---

## Program risks

| # | Risk | Impact | Mitigation / gate |
|---|---|---|---|
| R-01 | Building M1 on the un-arbitrated corpus | Very high — schema and grant rewrites after data exists | M0 exit gate: nine contradictions closed |
| R-02 | The per-page cost constant is wrong by 5.5× | High — every cap, budget, worker count and admission-control number is invalid | M2 measures it; ship M1 at the pessimistic end; regenerate `limits.md` from the measurement |
| R-03 | PP-OCRv5-th misses the CER gate and there is no second bet | Milestone-scale restart | Name the CPU-only remediation in M2's exit criteria **before** M2 runs |
| R-04 | The gateway answer never arrives | M3 stalls | M1 + M2 are the majority of the build and are unblocked; the product ships OCR-only if it must |
| R-05 | A 2 a.m. compose diff attaches `ocr-worker` to the AI network to "fix" a hang | Estate-wide exfiltration primitive on a multi-tenant Docker network shared with INNOVERA Chat | `ai-contract.md` + a blocking deploy gate (`docker inspect` shows one network, zero AI env keys) + `kind` predicate on the claim |
| R-06 | OCR batches degrade INNOVERA Chat | Another product's SLA, another team's incident | Separate virtual key with `max_parallel_requests`; no CUDA OCR process on Chat's GPU, ever; SM-12 observed and recorded |
| R-07 | A forged PDF text layer becomes the record | Wrong bank account on an invoice, fully grounded, review-flag-free | Pixel corroboration before trusting any third-party OCR layer; `extractionMethod` propagated into the review flag |
| R-08 | Thai correctness failures that are silent | A destroyed 2–5 px tone mark yields a *different valid Thai word* at full confidence | Never binarise; never morphologically open; NFC-only with an explicit Thai fold for comparison; diacritic-restricted CER as a standing metric |
| R-09 | Review-queue flood before M2 calibration lands | A staffing commitment nobody made | The design routes every uncalibrated field to a human **by design**; name the owner and the budget in M1's report |
| R-10 | Retention encoded as cascades | Cannot expire OCR text at 90 d while fields live to 365 d and corrections to 7 y | Answer O-10 before any FK is written |
| R-11 | Scope inflation across milestones | Program never closes | Deferred tier is explicit; a discovered lane becomes a backlog artefact, never an unannounced addition |
| R-12 | Parallel-authoring drift recurs | A tenth contradiction, discovered at migration time | Every fan-out lists every document it read; the union must be complete; it is a review checklist item |

---

## Rollback and abort criteria

### Within a milestone

- Every milestone is an **additive-migration + logical-commit boundary**. Application commits roll back without deleting data.
- A schema change needing a backfill uses **expand → migrate/verify → contract**, and the contract step is its own separately-approved plan. No autonomous destructive contract step in any milestone.
- Side-effect adapters default to fake/sandbox/manual. Rollback is disabling the adapter route, not deleting durable events.
- Evidence tables are never deleted from. Corrections are compensating records.
- A milestone whose validation fails **stays in `active/` at `🧪 TESTING` or `🚧 BLOCKED`**. It is never archived and never advanced.

### Milestone-level abort triggers

| Trigger | Action |
|---|---|
| Any of the nine contradictions is found still open after migration 0003 is written | **Stop M1. Return to M0.** Re-arbitrate, then re-plan the affected migrations. |
| M2 misses G-1/G-2 and no CPU-only remediation is available or affordable | **Do not start M3.** Escalate to the owner as a product decision: ship OCR-only at the measured quality, or fund the remediation, or re-open the engine choice. |
| Probe P0 (Thai UTF-8 round-trip) fails | **Neither branch.** M3 is abandoned until the Thai path through the gateway is fixed. Ship deterministic OCR alone. |
| The gateway ran LiteLLM 1.82.7/1.82.8 and credentials were not rotated | **Do not accept a credential.** M3 is blocked until rotation is completed and evidenced. |
| The gateway persists prompt bodies with no acceptable retention, and the owner will not change it | **M3 is a legal decision, not an engineering one.** Escalate; do not send the first real document. |
| No Thai corpus, and the owner will not accept synthetic-only measurement | **Park the program at M1 exit.** Everything after M2 rests on numbers that would not exist. |

### Program-level hard stop

| Trigger | Action |
|---|---|
| Any evidence that a production INNOVERA host was contacted, scanned, modified, or deployed to by this program | **Full stop.** Write the incident, notify the owner immediately, do not continue any milestone. |
| A real customer document is found in the repository or in a fixture | **P0 incident.** Purge, rotate anything exposed, write the incident, and fix the CI check that let it through. |
| A secret is found in a commit, a log, a report or a plan file | **Rotate first, investigate second.** Then fix the mechanism, not the instance. |
| Any accuracy figure is published that does not trace to a committed results file | Retract it publicly within the org, then fix the process that produced it. |

---

## Status matrix

| M | Milestone plan | Status | Depends on | Green proves |
|---|---|---|---|---|
| 00 | [Reconciliation plan](phase-00b-m0-reconciliation_PLAN_12-09-26.md) | 🚧 **BLOCKED** — M0.5 documents supplied; R1–R11 integration findings open | — | The design is internally consistent and safe to encode |
| 01 | [`phase-01-foundation-ingest-ocr_PLAN_13-09-26.md`](phase-01-foundation-ingest-ocr_PLAN_13-09-26.md) | ⏳ PLANNED | M0 | A document can be safely ingested and read, with geometry, confidence and a full audit trail — and no AI |
| 02 | `phase-02-benchmark-calibration_PLAN_…md` — not yet written | ⏳ PLANNED | M1 | The project's first true numbers exist, and every cap derives from a measurement |
| 03 | `phase-03-ai-extraction_PLAN_…md` — not yet written | ⏳ PLANNED | M2 + owner (O-11…O-19) | The LLM proposes and the verifier decides — and the product still works without it |
| 04 | `phase-04-review-corrections-export_PLAN_…md` — not yet written | ⏳ PLANNED | M3 (partial: M2) | A human can verify against the pixels, correct, and approve, permanently |
| 05 | `phase-05-external-api-tenancy_PLAN_…md` — not yet written | ⏳ PLANNED | M4 | Another system can drive it, under keys and quotas, with no cross-tenant reach |
| 06 | `phase-06-pdpa-retention_PLAN_…md` — not yet written | ⏳ PLANNED | M5 + counsel | Data expires lawfully and the audit trail survives it |
| 07 | `phase-07-hardening-scale-dr_PLAN_…md` — not yet written | ⏳ PLANNED | M6 | It survives its own load and its own worst day |
| 08 | `phase-08-deployment-launch_PLAN_…md` — not yet written | ⏳ PLANNED | M7 + owner (host) | The owner holds a deployable, reversible, documented stack |

**Status vocabulary:** `⏳ PLANNED` · `🔨 CODE DONE` (written, unverified) · `🧪 TESTING` · `✅ VERIFIED` (own gates **and** regression **and** owner review) · `🚧 BLOCKED` (a real blocker with a named next action).

---

## Milestone completion rules

No milestone is complete until all seven hold:

1. **Automated gates** — typecheck, lint, layering (both enforcers + the known-bad fixture), unit, integration, the named E2E
2. **Manual verification** — a human in the intended role performs the milestone's critical flow
3. **Data verification** — SQL or artefact evidence of the milestone's invariants, PII-free
4. **Error handling** — negative, retry, concurrency and unauthorized cases fail **safely**, proven as denials
5. **Owner confirmation** — the owner sees the evidence and says go (**STOP FOR REVIEW**)
6. **Regression** — every overlapping previously verified surface still passes, in the recorded format
7. **Durable capture** — milestone report written, context updated, downstream plans amended, execution committed separately from process artefacts

If a regression is found: classify it (product breakage / test breakage / harness drift / stale command), then fix-in-place, revalidate-only, or route as `🚧 BLOCKED`. **Never paper over a regression**, even a trivial one — record it in the milestone report.

---

## Change management

- A change to scope, an API, a schema, a security boundary or a limit must record: classification, affected milestones, compatibility, migration, tests, rollback — in **this umbrella and in the owning milestone plan**.
- Adding a provider, a role, a document state, a file type, an outbound request, or a model capability is an **architectural change**: return to PLAN and get owner approval.
- A learning from milestone *n* that changes milestone *n+k* must amend that plan **before** the commit and UPDATE PROCESS closeout of milestone *n*.
- A contradiction silently dropped from the §"nine contradictions" table without a recorded decision is a **defect**, not housekeeping.

---

## Resume and Execution Handoff

Next Step: continue with `phase-00b-m0-reconciliation_PLAN_12-09-26.md`; do not enter application EXECUTE while M0 remains open.

Updated 2026-09-12. Read `process/context/all-context.md`, the [M0.5 report](../reports/M05_CONSOLIDATION_REPORT_12-09-26.md), then the [reconciliation plan](phase-00b-m0-reconciliation_PLAN_12-09-26.md). Twelve M0.5 documents already exist; do not recreate them or treat arbitration as not started.

The report's original-nine-findings mapping and R1–R11 register qualify the historical design and owner-blocker tables above. M0.5 owners supersede their named M0 sections; unresolved conflicts between them are not permission to choose either example silently. Historical stack pins require fresh verification before installation.

There is still no Git repository, application, schema, migration, deployment stack or measured OCR result. Complete local source reconciliation before preparing the M1 foundation plan. Gateway evidence blocks activation, not this documentation work. No protected production host may be contacted by this continuation.

The user's continuation request authorizes useful reversible local work; this handoff does not require a ritual approval phrase for documentation fixes. The umbrella itself is never an application execute plan. External activation, paid actions and production deployment retain their separate authorization boundaries.

Feature-folder promotion remains a process follow-up. Move related artifacts together and preserve/update existing references; until then these general-plan paths are authoritative.

## Touchpoints

This umbrella routes the program. Runtime touchpoints belong to future milestone plans; current local documentation touchpoints are listed in the reconciliation plan.

## Public Contracts

No deployed API exists. Read current M0.5 owners and their unresolved exceptions before adopting the historical contracts above.

## Blast Radius

This update changes documentation and routing only. No external service or database is changed.

## Verification Evidence

Test Procedure: validate the plan artifact, current relative links and routed inventory. Runtime gates above are future requirements, not executed evidence. See the M0.5 report for this continuation's actual checks.

## Acceptance Criteria

M0 closes only when its migration-time contradictions have source-level disposition. Each later milestone must satisfy its own implementation, negative-test, regression and owner-review evidence.

## Implementation Checklist

- [x] M0 discovery and synthesis supplied.
- [x] Twelve M0.5 documents inventoried and consolidation/handoff written.
- [ ] Close R1–R11 in the current reconciliation plan.
- [ ] Prepare and execute M1–M8 sequentially with milestone-specific evidence.

## Phase Completion Rules

The existing milestone completion rules remain requirements. No runtime phase is verified by this documentation update. User Confirmation and actual test evidence must be recorded for runtime milestone verification.
