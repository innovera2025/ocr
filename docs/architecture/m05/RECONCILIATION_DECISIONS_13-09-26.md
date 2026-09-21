# M0.5 reconciliation decisions

**Date:** 2026-09-13
**Authority:** M0.5 integration decision record. It resolves local contradictions between F1–F3, C1–C5 and the three gates. It does not grant gateway credentials, approve production deployment or replace later runtime evidence.

## Decision register

| ID | Decision | Applied contract |
|---|---|---|
| R1 | Originals are identity-addressed and encrypted per document. Fingerprints are non-unique duplicate hints on `documents`; no shared ciphertext. | C1 §3/§14.1; F1 uniqueness index is superseded for originals |
| R2 | The partial-index inventory is named, not count-based. C1, F1 and C2 each contribute to one generated allowlist; startup asserts names and definitions. | F1 `partial_index.policy`; C1 §14.2; C2 §17 |
| R3 | The queue table is `extraction_jobs`. `ocr-ai-worker` and queue functions use that name; raw worker DML remains denied. Cross-organisation claim is permitted only through the queue `SECURITY DEFINER` function, never a tenant-only worker policy. | C2 §0/§21; F1 RLS exception |
| R4 | F3 owns AI per-call timeout, retry and AI-job budget. F2 owns OCR processing budget. F2's former `AI_CALL_TIMEOUT_S` is retired and its 300-second value is OCR sizing headroom only. | F2 time table; F3 §CANONICAL VALUES; C2 budget text |
| R5 | OCR and AI are separate jobs. AI coverage is bounded by the F2 chunk cap and F3 call/budget cap; repair and retry calls consume the AI ledger. OCR completion never waits for or retries OCR because AI failed. | F3 AI job; C2 §17; C5 §9 |
| R6 | `gate-2 ai.prompt.max_chars` is the per-request cap. F2 `AI_CONTEXT_CHAR_BUDGET` is the per-document aggregate budget. Readiness coupling is owned by Gate 2 and is `none`. | Gate 2 §9; F2 AI context; C5 §22 |
| R7 | Vision and generative handwriting are deferred. No provider, image mount or pixel path is registered. Reopening requires a new reviewed topology, privacy and provenance contract. | C3 canonical `vision.entry_point`; C4 H2; C5 §20 |
| R8 | AI spool paths use document public ids. Envelopes use a non-timestamped key reference. Persisted multi-document exports use export DEKs and a join-aware destruction transaction. | C1 §14.3–§14.4; F3 spool; Gate 2 erasure mechanism |
| R9 | Retention periods and clock anchors are explicit per artifact class. Document deletion destroys its DEK immediately; lifecycle cleanup is asynchronous and cannot delay erasure. Original retention remains owner-configured until legal periods are supplied. | Gate 2; C1 §14.5; F1 lifecycle |
| R10 | Ingest is staged, quarantined and scanned before publication. The document and extraction job become eligible in one transaction only after a clean verdict; failed scans never enter the extraction queue. | F2 F2-D3; C1 state projection; M0 J/L upload constraints |
| R11 | Shared rate limits require a shared store. M1 ships with one web instance and a database-backed limiter; multi-instance deployment is blocked until the store and failover contract are specified. | F2 rate values; M0 M deployment constraint |

## Gate result

R1–R11 now have one documented answer. This closes the **local design-reconciliation gate** for M0. It does not claim implementation, runtime proof or owner evidence. Gateway address/key/model, host supply-chain attestation, gateway retention/residency, legal retention periods, repository governance and OCR performance remain external or measurement dependencies.

## Required implementation proof

M1 must prove R1–R3, R8–R11 with migrations, grants, state-machine tests and failure-path tests. M2 must measure the provisional OCR limits. M3 must prove R4–R7 and keep AI disabled when any owner gate is absent. No implementation may silently reintroduce a superseded name or branch.
