# M0.5 consolidation and continuation report

**Date:** 2026-09-12 (continued 2026-09-13)
**Status:** Local architecture reconciliation completed; runtime proof and owner evidence remain open. M1 implementation plan can now be prepared.
**Scope:** Local document inspection and documentation changes only.

## Outcome

The interrupted work left twelve M0.5 documents under `docs/architecture/m05/`, but the README, context router and umbrella still described reconciliation as not started. This report connects that work to the active program and records what still prevents treating the designs as one coherent implementation contract.

The twelve documents are eleven contract documents plus the Gate 1 owner runbook. Together they contain 19,154 lines before the continuation notices added in this pass. The fifteen M0 documents, M0 synthesis and umbrella already existed. There is no Git repository, application code, dependency manifest, database schema, migration, Dockerfile, CI pipeline or measured OCR result. The two discovery scripts exist; this pass did not execute them.

**Evidence limit:** This is a targeted cross-document review, not a fresh verification of every vendor citation or every SQL example. Existing labels such as “verified this session” refer to the original document's session, not 2026-09-12. No production host, gateway, GitHub settings or customer documents were accessed.

## What the newer documents establish

Use the [architecture index](../../../docs/architecture/README.md) for links to every owner.

- F1 defines workspace membership, explicit grants, separate public identifiers and run-scoped evidence. This replaces the original tenant-only visibility proposal.
- F2 supplies a consolidated limits design and a generated-configuration approach. It does not supply an implemented generator or measured production sizing.
- F3 assigns AI calls to a dedicated `ocr-ai-worker`. The hostile-document parser remains credential-free; the AI process receives minimised text, not page images.
- C1 defines identity-addressed object keys and a document-state vocabulary, with explicit challenges to older uniqueness and key-management rules.
- C2 defines `extraction_jobs`, hashed lease tokens, function-mediated queue writes, run-scoped checkpoints and degraded completion. Its SQL is still design material.
- C3 defines a single page-routing policy, pixel corroboration and explicit review routes. C4 defines provider, geometry and calibration proposals. Neither is benchmark evidence.
- C5 retracts the claim that grounding prevents prompt injection, narrows evidence matching and specifies the gateway transport. Identifier minimisation also changes what the AI is allowed to verify.
- Gates 1–3 separate credential safety, gateway data handling and repository governance. Written controls are not evidence that the external controls have been activated.

## Original nine findings: disposition

The numbers below refer to the umbrella's original nine-finding register, not similarly numbered local sections in C1/C2.

| Original finding | New evidence | Current disposition |
|---|---|---|
| 1. Intra-tenant visibility and schema defects | F1, C1 §14, C2 §21 | Visibility design supplied; storage uniqueness and queue-role integration remain open |
| 2. Conflicting limits | F2, C5 §22 | Ingest limits consolidated; AI clocks and budgets remain inconsistent |
| 3. AI call placement | F3, C5 | Text-only process boundary supplied; propagate queue naming and exclude future vision contradictions |
| 4. Lease fencing and budget exhaustion | C2 §§4–6, §19, §21 | Enforcement design supplied; role/policy integration and actual database proof remain outstanding |
| 5. Routing and forged text layers | C3 | Replacement routing design supplied; geometry/provider integration and measurement remain outstanding |
| 6. Prompt injection and weak grounding | C5 §§17–18 | False claim retracted in the newer contract; legacy K examples are superseded within C5's declared scope; no runtime security claim |
| 7. Geometry and calibration | C4 §§3–5 | Expanded contract supplied; adapter implementation, round-trip tests and calibration are outstanding |
| 8. Scan bypass and object-key grammar | F2 F2-D3, C1 | Storage grammar supplied; API ingest transaction and scan-state projections still need one end-to-end specification |
| 9. Retention and restore roles | F1, Gate 2, C1 §14 | Restore-global requirement supplied; independent retention, export keys and erasure lifecycle remain incompletely integrated |

## Remaining reconciliation register

These are design integration items. They can be investigated locally and must not be misreported as waiting for gateway credentials.

| ID | Evidence and concrete problem | Required resolution / proof |
|---|---|---|
| R1 | C1 §14.1 rejects F1 `uniq.storage_original_fingerprint`: identical uploads as separate documents conflict with a unique live original and separate document DEKs | Reconcile F1's index/duplicate semantics with C1's per-document ciphertext; duplicate-upload and erase-one-keep-the-other scenario must have one answer |
| R2 | C1 §14.2 proposes eight partial indexes while F1 freezes seven; C2 §17 adds queue indexes | Replace global fixed-count assumptions with a named, consolidated index inventory and explicit ownership; include all adopted indexes |
| R3 | C2 §21 names `extraction_jobs` while F3 SQL still names `ocr_jobs`; F1's tenant-only wording conflicts with the claim-function owner's cross-tenant policy | Propagate one table vocabulary and a complete caller/function-owner/role/policy matrix; raw worker DML must remain denied |
| R4 | C5 §22 C5-1: F2's per-call clock and retry description conflict with F3/C5 | Give one owner the AI per-call clock and retry semantics; retire the competing variable rather than silently selecting it in code |
| R5 | C5 §22 C5-2/C5-4: the OCR job reserves AI time despite separate jobs; chunk/call counts do not match F3's budget derivation | Separate OCR and AI budgets; account for repair calls, retry waits and partial coverage. Do not substitute an invented measured p95 |
| R6 | C5 §22 C5-3/C5-5: prompt-character and readiness rules have competing owner keys | One per-request prompt cap, explicit chunk/document budget distinction and one readiness owner; preserve the stricter existing data boundary |
| R7 | C3 `vision.entry_point` puts a future vision provider in `ocr-worker`; C4 C4-D4 and C5 §20 describe AI-side alternatives; F3/Gate 2 forbid the required access | Text-only remains the current supported design. Withdraw executable-looking future vision instructions pending a separate topology, privacy and provenance decision |
| R8 | C1 §14.3/§14.4 requires a public-id spool path, an envelope key reference and per-export keys beyond F3/Gate 2 | Reconcile identifiers and key lifecycle in the owning documents; cover exports containing multiple documents and erasure after backup restore |
| R9 | Original retention/cascade conflict is not solved by specifying crypto-shredding alone | Specify metadata versus encrypted payload retention, independently expiring artifact classes, referential actions and key destruction; legal periods remain owner decisions |
| R10 | F2 F2-D3 asynchronous scanning, C1 §11 state projections and M0 L presigned ingest describe different flows | Produce one upload → quarantine → clean verdict → eligible extraction transaction sequence, with timeout, infected, duplicate and crash cases |
| R11 | F2 §7 flags Redis-based rate limiting versus the M0 deployment exclusion | Specify the shared rate-limit store or an explicit single-instance deployment constraint before claiming multi-instance quotas/rate limits |

Do not mark the whole architecture closed merely because each individual document has a canonical header. R1–R11 need disposition in the owning sources and the follow-up plan; the eventual M1 tests prove implementation separately.

## Continuation disposition (2026-09-13)

Three source-level clarifications were applied after the first report:

- **R4 partial:** F2 now retires its duplicate `AI_CALL_TIMEOUT_S` and identifies F3 as the sole AI per-call clock owner. Runtime retry and budget integration remains open.
- **R5 partial:** F2 now describes its 300-second value as reserved OCR sizing headroom; AI execution remains a separate F3 job. Chunk, repair and retry accounting is still open.
- **R7 partial:** C3 now explicitly defers Branch V and registers no future vision provider in either worker. A future vision design still needs its own topology, privacy and provenance review.

The remaining R1–R3, R5–R6, R8–R11 items are now answered in [the decision record](../../../docs/architecture/m05/RECONCILIATION_DECISIONS_13-09-26.md). They are implementation-proof obligations, not unresolved design choices. No runtime claim follows from these wording changes.

## Owner and measurement dependencies

| Dependency | Blocks | Safe current boundary |
|---|---|---|
| Gateway host inspection and supply-chain attestation (Gate 1 + owner runbook) | Credential acceptance / real AI calls | No credential issued or accepted by this pass; AI disabled |
| Literal gateway address, OCR-scoped key and authorised aliases (C5 §21) | Live transport validation | No guessed endpoint, port or model default |
| Gateway retention/residency attestation (Gate 2) | AI activation | Keep AI disabled; minimisation is a defence, not proof that arbitrary free text contains no personal data |
| Deployment host, storage jurisdiction and approved retention periods | Production configuration and lifecycle policy | Local design work may proceed; no production location or legal approval inferred |
| Repository ownership/privacy settings (Gate 3) | Remote creation / publication | No remote created and no account settings changed |
| Own-corpus OCR, calibration, RSS and latency measurements | Accuracy claims and production sizing | Treat numeric design targets as provisional, not measured results |
| Handwriting data/consent and product scope (C3/C4) | Promised handwriting support | Review-only boundary; do not advertise recognition quality |

Reference blockers as `document + local tag`, such as `C5 B-2`; bare `B-1` is ambiguous across these documents.

## Changes in this continuation

- Added this synthesis and an architecture index covering all twelve M0.5 artifacts.
- Updated README and the context router to reflect the actual files and limitations.
- Updated the umbrella's active handoff and added a concrete reconciliation plan.
- Added navigation notices to historical/current dimension documents so direct readers can reach the integration findings without assuming isolated examples are ready to implement.
- Kept historical design bodies and original reports available; no claim that their proposed controls were executed.

## Verification evidence

Validation results from 2026-09-12: the local link/index check passed (57 Markdown links; all 12 M0.5 documents indexed); the plan validator passed both active plans with one non-blocking legacy-shape warning for the required `phase-00b-...` filename. The inherited context validator was also attempted from this repository and correctly reported missing inherited harness surfaces (`.claude`, `.agents`, `AGENTS.md`) plus the missing lifecycle section; the lifecycle section is now present. Running it from `/Users/innovera` is not a valid project audit because that parent has no `process/context` for this repository. Documentation checks cannot prove the queue, OCR, RLS, erasure or gateway designs work.

## Next work

Use [the reconciliation plan](../active/phase-00b-m0-reconciliation_PLAN_12-09-26.md). Close the source-level design conflicts first, then prepare the bounded M1 foundation plan. Gateway evidence is a separate activation dependency and does not prevent local architecture reconciliation.

The M0–M8 application program is not complete. This report completes the missing consolidation and handoff, with its remaining work made explicit.
