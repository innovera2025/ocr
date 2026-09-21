# M0.5 — Cross-document reconciliation

**Date:** 12-09-26
**Complexity:** COMPLEX — one documentation phase in the M0–M8 program
**Status:** CODE DONE — local R1–R11 decisions recorded; runtime proof and owner evidence outstanding
**Primary execute anchor:** this file, for documentation reconciliation only.

Date: 12-09-26  
Complexity: COMPLEX  
Status: PLANNED

## Overview

Finish integration of the twelve M0.5 artifacts. Inputs: `process/context/all-context.md`, the [consolidation report](../reports/M05_CONSOLIDATION_REPORT_12-09-26.md), the [architecture index](../../../docs/architecture/README.md) and the umbrella. The earlier proposed reconciliation plan dated 09-09-26 was never created; this is its actual dated replacement.

The user requested continuation. Inventory, synthesis and routing were completed in that continuation. This plan records remaining source-level work; it does not add an approval requirement for reversible documentation corrections. External gateway operations remain outside scope.

## Touchpoints

| Files | Work |
|---|---|
| M0.5 F1, C1, C2 | Independent originals, duplicate hints, index inventory, queue roles/table names |
| M0.5 F2, F3, C2, C5 | Clock/cap ownership, separate OCR/AI budgets and partial coverage |
| M0.5 C3, C4, C5, F3 | Withdraw conflicting future vision implementation instructions |
| M0.5 C1, Gate 2, F3; M0 G/I/L | Key references, exports, retention referential actions and scan-gated upload |
| M0 J/M and F2 | Rate-limit store/deployment constraint |
| README, context, architecture index, umbrella, report | Disposition and next milestone boundary |

## Public Contracts

Design contracts only; no deployed API changes. Preserve tenant isolation, private AI, deterministic evidence, no pixels to the current AI service and separate document DEKs. Statuses, queue identifiers, env names and paths must have one owner. Retired names may remain only as labelled historical alternatives.

## Blast Radius

Markdown under this workspace. No scaffold, dependencies, SQL execution, model download, real document, credential, remote creation or production call. Rollback restores changed Markdown with its corresponding routing; no database migration exists.

## Implementation Checklist

- [x] Inventory actual files and compare README/context/umbrella.
- [x] Write synthesis, authority index and original-nine-findings disposition.
- [x] Collect second read-only review of vision, retention and budget conflicts.
- [x] Update routing and create this continuation anchor.
- [x] R1–R3: decisions recorded in `RECONCILIATION_DECISIONS_13-09-26.md`; implementation proof remains an M1 gate.
- [x] R4–R7: decisions recorded; runtime and owner gates remain separate.
- [x] R8–R11: decisions recorded; migrations and failure-path tests remain M1 proof.
- [ ] Edit conflicting canonical rows, recording rationale, affected milestones and required runtime scenarios in the report.
- [ ] Repeat targeted review and documentation checks; update status using actual results.
- [ ] Prepare a bounded M1 plan only after the architecture gate closes; do not start M1 from this plan.

## Acceptance Criteria

Every R1–R11 item has one recorded answer or scoped deferral in the decision record. No unsafe default substitutes for owner evidence. Original findings remain traceable and current Markdown links resolve. No runtime-verified claim is made.

## Verification Evidence

**Test Procedure:** check relative links, routed-file existence, indexing of all twelve M0.5 documents and conflicting names in canonical rows. Run the inherited plan validator against this plan and umbrella. Run inherited context discovery from its parent root and report OCR-local checks separately.

**Manual Test:** README → report → relevant owner → next plan must reveal what exists, what is historical, what remains open and what depends on outside evidence.

**Data Verification:** file inventory only. There is no database. RLS denials, crash recovery, erasure, scanning, OCR and gateway behavior are later runtime requirements, not checks performed by this phase.

## Phase Completion Rules

Require source alignment, report, current routing and documentation validation. Owner review and runtime milestone verification are distinct from completing documentation. Do not close M0 while migration-time contradictions remain; do not mark M1 complete from documentation checks.

## Resume and Execution Handoff

Read `process/context/all-context.md` and the report. Resume at the first unchecked R-item using its cited source sections. Do not repeat discovery or gateway probes to resolve local naming conflicts. Record each decision alongside edited canonical rows. Next Step: finish this documentation reconciliation, then report external dependencies separately. RIPER-5 application implementation remains bounded to its own future milestone plan.
