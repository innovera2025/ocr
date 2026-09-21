# INNOVERA OCR AI

A planned Thai-first OCR and document-intelligence platform for Thai and English business documents. Deterministic OCR supplies the evidence; private AI may propose structured fields; verification and human review determine what is accepted.

**Current status — 2026-09-12:** M0 discovery and twelve M0.5 follow-up documents exist. Their consolidation and continuation handoff are complete. Cross-document architecture reconciliation remains open before M1 implementation.

**M1 scaffold exists, but the platform is not runnable end-to-end yet.** The workspace and health/worker contracts are present; there is no database schema, migration, Dockerfile, CI pipeline, OCR runtime or benchmark result. Dependencies are installed and the scaffold's typecheck, lint and tests pass. The two gateway probe scripts are research artifacts; this continuation did not run them.

## Start here

- [M0.5 consolidation report](process/general-plans/reports/M05_CONSOLIDATION_REPORT_12-09-26.md): current findings, remaining conflicts, owner dependencies and verification evidence.
- [Architecture index](docs/architecture/README.md): routes to all twelve M0.5 documents and explains their authority over M0.
- [Repository context](process/context/all-context.md): routing, constraints and factual repository state.
- [Reconciliation plan](process/general-plans/active/phase-00b-m0-reconciliation_PLAN_12-09-26.md): concrete next work before preparing M1.
- [M0–M8 program](process/general-plans/active/innovera-ocr-program_PLAN_09-09-26.md): overall product sequence.
- [Original M0 report](process/general-plans/reports/M0_ARCHITECTURE_REPORT_09-09-26.md): historical discovery and adversarial findings.

## Design boundaries

Deterministic OCR remains the system of record. The AI model cannot silently replace evidence. Public-model fallback is forbidden. The current design separates a credential-free document parser from a dedicated AI worker and keeps AI disabled pending gateway evidence.

M0.5 supplies workspace visibility, object-key, queue, routing, OCR geometry, limits, gateway and governance contracts. A `canonical` label on one document does not establish that those contracts agree with each other. The consolidation report names the unresolved integration items.

Every OCR accuracy figure in the original research is a target or an attributed external result. **This project has measured no OCR accuracy yet.** Historical version pins and vendor claims must be rechecked before implementation.

## Repository contents

| Path | Contents |
|---|---|
| `docs/architecture/m0/` | Fourteen original designs and one adversarial panel |
| `docs/architecture/m05/` | Eleven follow-up contracts and one owner runbook |
| `docs/architecture/README.md` | Architecture navigation and authority rules |
| `docs/m0/discovery/` | Two gateway probe scripts |
| `process/general-plans/active/` | Program, reconciliation and M1 implementation plans |
| `apps/ocr-web/`, `packages/config/`, `packages/ai-contract/`, `packages/queue/`, `packages/storage/`, `packages/ingest/`, `services/ocr-worker/` | Initial M1 TypeScript scaffold; health endpoint, config/AI boundaries, queue/storage/ingest contracts and worker payload contract |
| `prisma/` | Foundation schema and hand-written migrations; not applied to a database |
| `deploy/docker-compose.yml` | Local PostgreSQL 17, ClamAV, web and worker services |
| `deploy/Dockerfile.web`, `deploy/Dockerfile.worker` | Reproducible Node 24 development containers |
| `process/general-plans/reports/` | M0 synthesis and M0.5 consolidation |
| `process/context/all-context.md` | Current context router |

## Development process

The project inherits its agent harness from `/Users/innovera`; it does not vendor the harness. Copying these documents to another machine does not install that environment. Feature-folder promotion remains a process follow-up; current links point to the files that actually exist.

Production deployment, external account changes and gateway activation are separate operations. None was performed by the documentation continuation.

License: not yet determined.
