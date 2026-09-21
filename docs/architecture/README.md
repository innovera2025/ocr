# Architecture entrypoint

Updated: 2026-09-12. This repository contains designs, not an implemented OCR service.

Start with the [M0.5 consolidation report](../../process/general-plans/reports/M05_CONSOLIDATION_REPORT_12-09-26.md), then the [reconciliation decisions](m05/RECONCILIATION_DECISIONS_13-09-26.md). The decisions close local contract conflicts; owner evidence and runtime verification remain separate gates.

## Reading order and authority

1. Read [repository context](../../process/context/all-context.md) for the current status and constraints.
2. Read the relevant M0.5 owner below before an M0 design. Its explicit `supersedes` scope replaces that portion of M0, not the entire older document.
3. Where M0.5 owners disagree, consult the consolidation report. Do not choose a value merely because one document was read last.
4. Treat source-verification dates in the research as historical. Version pins, vendor capabilities and production facts require fresh verification before implementation or activation.

## M0.5 owners

| Contract | Owner | Remaining qualification |
|---|---|---|
| Gateway credential precondition | [Gate 1](m05/gate-1-litellm-supply-chain.md) | Gateway evidence still requires the owner |
| Owner inspection steps | [Gate 1 runbook](m05/gate-1-owner-runbook.md) | Instructions exist; execution is not evidenced here |
| Gateway retention, minimisation and erasure | [Gate 2](m05/gate-2-pdpa-retention.md) | Attestation and cross-document key lifecycle remain open |
| Repository privacy and CI governance | [Gate 3](m05/gate-3-repository-privacy.md) | Proposed governance; no repository has been created |
| Tenant visibility, identifiers and schema invariants | [F1](m05/f1-tenant-visibility-model.md) | Read C1 storage and C2 role exceptions alongside it |
| Limits | [F2](m05/f2-canonical-limits.md) | AI timing conflicts with F3/C5; operating figures are provisional |
| AI process, credentials and network boundary | [F3](m05/f3-ai-call-placement.md) | Dedicated `ocr-ai-worker`; queue naming and budgets need reconciliation |
| Storage keys and document states | [C1](m05/c1-storage-key-contract.md) | Its §14 challenges remain explicit reconciliation work |
| Queue, leases, retry and checkpoints | [C2](m05/c2-queue-contract.md) | Its §21 exceptions must be propagated into F1/F3 |
| Native/OCR routing | [C3](m05/c3-ocr-routing-policy.md) | Future vision placement conflicts with C4/F3; vision stays disabled |
| OCR providers, geometry, handwriting and calibration | [C4](m05/c4-ocr-provider-and-handwriting.md) | Provider proposal is not a measured quality result |
| Gateway transport and provenance verification | [C5](m05/c5-gateway-contract-and-qwen-role.md) | Its §22 timing and budget challenges remain unresolved |
| M0.5 cross-document decisions | [Reconciliation decisions](m05/RECONCILIATION_DECISIONS_13-09-26.md) | Local R1–R11 contract answers; no runtime proof |

## Historical M0 corpus

The [M0 synthesis](../../process/general-plans/reports/M0_ARCHITECTURE_REPORT_09-09-26.md) and [adversarial panel](m0/z-adversarial-panel.md) retain the original rationale and findings. The fifteen files in `m0/` are historical inputs, including configuration and SQL examples that must not be copied as an integrated implementation.

The [program plan](../../process/general-plans/active/innovera-ocr-program_PLAN_09-09-26.md) sequences M0–M8. No application, schema, migrations, container stack or benchmark results exist yet.

The next implementation artifact is the [M1 Foundation plan](../../process/general-plans/active/phase-01-foundation-ingest-ocr_PLAN_13-09-26.md). It is a plan only; no M1 code has been written.
