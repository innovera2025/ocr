# INNOVERA OCR AI — Repository Context

**Last updated:** 2026-09-12
**Repo HEAD:** Not a Git repository; no commit, branch or remote exists.
**Current status:** M0 local design gate closed; M1 scaffold started. Health/config/worker contract files exist, but no database, OCR runtime, container stack or end-to-end flow exists.

## Scope and read-when rules

Read this router first, then follow the relevant deeper document. It owns repository state and routing, not duplicate version pins or limits. A canonical header in one source does not close the cross-document findings in the M0.5 report.

M0.5 supersedes only the M0 sections explicitly named by its owner. Conflicts between M0.5 owners remain open until recorded and propagated. Historical source-verification claims are dated research, not fresh production evidence. Do not scaffold from isolated SQL or compose examples.

## Quick Routing

| Task | Read next |
|---|---|
| Current findings and dependencies | [M0.5 report](../general-plans/reports/M05_CONSOLIDATION_REPORT_12-09-26.md), [decisions](../../docs/architecture/m05/RECONCILIATION_DECISIONS_13-09-26.md) |
| Next reconciliation steps | [Reconciliation plan](../general-plans/active/phase-00b-m0-reconciliation_PLAN_12-09-26.md) |
| M1 implementation scope and gates | [M1 Foundation plan](../general-plans/active/phase-01-foundation-ingest-ocr_PLAN_13-09-26.md) |
| Program sequence | [M0–M8 umbrella](../general-plans/active/innovera-ocr-program_PLAN_09-09-26.md) |
| Architecture ownership and all M0.5 links | [Architecture index](../../docs/architecture/README.md) |
| Original synthesis and findings | [M0 report](../general-plans/reports/M0_ARCHITECTURE_REPORT_09-09-26.md), [panel](../../docs/architecture/m0/z-adversarial-panel.md) |
| Visibility, public ids and schema | [F1](../../docs/architecture/m05/f1-tenant-visibility-model.md); C1 §14 and C2 §21 qualify it |
| Limits | [F2](../../docs/architecture/m05/f2-canonical-limits.md); also C5 §22 |
| AI process and credential boundary | [F3](../../docs/architecture/m05/f3-ai-call-placement.md) |
| Object keys and document states | [C1](../../docs/architecture/m05/c1-storage-key-contract.md) |
| Queue, leases, checkpoints and roles | [C2](../../docs/architecture/m05/c2-queue-contract.md) |
| Page routing | [C3](../../docs/architecture/m05/c3-ocr-routing-policy.md) |
| OCR providers, geometry and calibration | [C4](../../docs/architecture/m05/c4-ocr-provider-and-handwriting.md) |
| Gateway transport and provenance | [C5](../../docs/architecture/m05/c5-gateway-contract-and-qwen-role.md) |
| Credential preconditions / owner inspection | [Gate 1](../../docs/architecture/m05/gate-1-litellm-supply-chain.md), [runbook](../../docs/architecture/m05/gate-1-owner-runbook.md) |
| Gateway retention and erasure | [Gate 2](../../docs/architecture/m05/gate-2-pdpa-retention.md) |
| Repository privacy and CI governance | [Gate 3](../../docs/architecture/m05/gate-3-repository-privacy.md) |
| Historical stack and layering | [M0 A](../../docs/architecture/m0/a-environment-and-stack.md), §3.7; reverify before installation |
| Native format extraction | [M0 E](../../docs/architecture/m0/e-native-extraction-routing.md), with C3 overrides |
| Preprocessing and confidence rationale | [M0 F](../../docs/architecture/m0/f-preprocessing-and-confidence.md), with C3/C4 overrides |
| Threat model | [M0 J](../../docs/architecture/m0/j-security-threat-model.md), with M0.5 overrides |
| API, UI, Thai design and exports | [M0 L](../../docs/architecture/m0/l-api-ui-export.md); upload integration remains open |
| Deployment and resources | [M0 M](../../docs/architecture/m0/m-docker-nginx-resources.md), with F2/F3 overrides |
| Logging, testing and benchmarks | [M0 N](../../docs/architecture/m0/n-observability-testing-benchmark.md) |
| Probe review, not execution approval | `docs/m0/discovery/probe_ai_gateway.py`, `docs/m0/discovery/probe-ai-gateway.sh`; also C5 |
| Shared workflow | `/Users/innovera/process/development-protocols/all-development-protocols.md` — inherited |

## Current Features and repository state

INNOVERA OCR is the only planned product. Plans/reports remain under `process/general-plans/`. No feature folder exists. Promotion to `process/features/innovera-ocr/` is a process follow-up: move related plans/reports together, preserve compatibility links, and update this router in the same patch. The destination is planned, not an existing entrypoint.

Existing inventory: fifteen M0 documents, thirteen M0.5 documents including the reconciliation decision record, architecture index, M0/M0.5 reports, umbrella, reconciliation plan, M1 plan, two probe scripts and the initial M1 workspace scaffold. A first Prisma schema, hand-written migrations, local PostgreSQL/ClamAV/web/worker compose services and Node 24 Dockerfiles now exist; they are not applied or exercised end-to-end and do not constitute integration proof. No CI, `.env` or benchmark results exist.

No test runner or test context group exists. Create testing context when an implemented testing contract exists. No accuracy, isolation, latency or recovery result was measured by this continuation.

## Product Context

Thai first, English second: upload, scan hostile bytes, route pages, extract deterministic text with geometry, optionally propose fields via private AI, verify, review and export. NFC is the storage normalisation policy. NFKC/NFKD are prohibited; comparison-only transformations must not invalidate stored offsets.

Design direction: modular TypeScript web service, Python OCR worker, PostgreSQL-backed queue, storage boundary and separate TypeScript AI worker. F3 replaces older AI placement inside web/parser processes. The scaffold now includes an inert `@innovera/ocr-ai-contract` boundary; it makes no network calls and accepts no default endpoint/model. The Python OCR runtime and persistence are not implemented. Runtime pins remain historical proposals in M0 A; C4 owns provider-specific revisions.

## Non-negotiable boundaries

1. Do not contact, scan, modify or deploy to protected production hosts: `72.62.253.185`, `52.221.213.43`, `141.98.17.91`, `187.52.117.52`, `153.92.4.176`. The program reserves production inspection for an owner-executed approved runbook; this continuation does not authorize it.
2. No public-model fallback. No invented gateway URL, host, port, alias, context length or capability. Chat source is not authorization for an OCR-scoped credential.
3. Deterministic OCR is the evidence of record. Grounding does not prevent attacker-directed selection among document values. Use C5's narrower verifier contract.
4. The parser has no AI credential; F3 assigns credentials to a separate AI process. The current design sends no pixels. Conflicting future vision proposals confer no implementation authority.
5. AI stays disabled pending gateway evidence and does not gate OCR readiness. Minimisation is not proof that arbitrary text is anonymous.
6. Typed tenant scoping, composite foreign keys and FORCE RLS are required. F1 adds workspace/grant visibility and owns the not-found contract. Reconcile queue exceptions through C2, not broad worker grants.
7. Synthetic fixtures only. No customer documents, credentials or personal-data payloads in repository or evidence logs. Model weights are to be pinned and verified; no runtime downloads from the parser.
8. No production deployment, DNS change, paid action, account change or destructive operation without its separately authorized procedure.

## Open Contradictions and blocker routing

The M0.5 report preserves the original nine-finding mapping. [Reconciliation decisions](../../docs/architecture/m05/RECONCILIATION_DECISIONS_13-09-26.md) now close the local R1–R11 contract conflicts. Runtime proof and owner evidence remain open.

Local design work includes independent encrypted originals, index inventory, queue naming/RLS, separate job clocks, prompt ownership, future vision deferral, export/key lifecycle, independent retention schema, scan-gated ingest and rate-limit storage. These are not gateway-blocked.

Owner evidence is needed for gateway attestation/address/key/aliases, privacy/residency, production host, retention policy and remote governance. A workstation check cannot establish gateway safety. OCR quality, calibration and sizing require later measurement on an approved corpus.

## Harness Inheritance

This project inherits `/Users/innovera/AGENTS.md`, `.claude/`, `.agents/`, `.codex/` and protocols. They are not vendored. Run inherited harness validators from the parent and distinguish parent findings from OCR documentation findings. Do not copy harness files merely to silence missing-local-harness checks.

There is one context document and no context groups. The architecture index is a documentation index, not a context group.

## Context Group Lifecycle

No context groups exist. Create `process/context/{group}/all-{group}.md` only when a durable topic has three or more documents, a document exceeds roughly 800 lines with separable subtopics, or repeated work needs one slice. Update this router in the same patch and run the inherited context audit. A future tests group is created only when a test runner and testing contract exist.

## Update Triggers

Update this router and README when findings are disposed, milestone status changes, a feature folder is promoted, gateway evidence arrives, pins change, or runnable artifacts/benchmarks land. Record proof rather than inferring implementation from canonical labels. Validate context routing after changes.
