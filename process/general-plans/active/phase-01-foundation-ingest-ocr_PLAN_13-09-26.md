# M1 — Foundation, secure ingest and deterministic OCR

**Date:** 13-09-26
**Complexity:** COMPLEX — first implementation milestone
**Status:** CODE DONE — initial scaffold only; M1 implementation and verification remain incomplete
**Depends on:** M0 local design gate and [M0.5 reconciliation decisions](../../../docs/architecture/m05/RECONCILIATION_DECISIONS_13-09-26.md)
**Primary execute anchor:** this file; enter only after the research gate and explicit `ENTER EXECUTE MODE` transition.

Date: 13-09-26  
Complexity: COMPLEX  
Status: PLANNED

## Overview

Build the smallest runnable foundation that accepts hostile PDF/image/Office input, stages it safely, scans it before publication, routes pages, runs deterministic OCR and persists auditable results under tenant isolation. AI enrichment, handwriting recognition, production deployment and live gateway calls are out of scope.

## Goals and non-goals

Goals: reproducible local development; hand-written PostgreSQL migrations; application and worker package boundaries; staged/quarantined storage; ClamAV gate; extraction job lease/fencing; per-page routing and OCR geometry/confidence; append-only events; health/metrics and synthetic fixtures.

Non-goals: real customer data, public model providers, gateway credentials, vision, auto-approval, external API quotas, PDPA legal-period decisions, production DNS or deployment.

## Touchpoints

| Area | Planned artifacts |
|---|---|
| Workspace | `package.json`, `pnpm-workspace.yaml`, Node/TypeScript config, lint and boundary rules |
| Web | `apps/ocr-web/**` upload/status endpoints, typed env boundary and repository ports |
| OCR worker | `services/ocr-worker/**` parser, scan consumer, routing, RapidOCR adapter and result serializer |
| Database | `prisma/schema.prisma` plus hand-written migrations for F1/C1/C2 roles, constraints, RLS and indexes |
| Storage | `packages/storage/**` identity-addressed keys, local adapter and encryption envelope ports |
| Queue | `packages/queue/**` `extraction_jobs`, claim/heartbeat/finish functions and Node→Python payload |
| Ops | `deploy/docker-compose.yml`, generated limits, health endpoints, structured redacted logs and metrics |
| Tests | unit/integration/E2E fixtures, SQL denial tests, crash/retry scenarios and synthetic-only CI checks |

## Public Contracts

- `POST /api/documents` stages a body and returns `202` with an external document id only after structural validation; it never publishes an unscanned object.
- A clean scan is the only transition that makes a document eligible for `DOCUMENT_EXTRACT`.
- OCR output is append-only per `(document, run, page, engine)` and stores NFC text, line/cluster geometry, raw and calibrated confidence, pipeline/calibration identifiers and warnings.
- Cross-tenant and unauthorized document reads return the F1 not-found contract. Queue workers cannot issue raw DML; lease-sensitive writes use the C2 database functions.
- AI is disabled and absent from M1 compose/runtime paths. No image or OCR payload leaves the local stack.

## Blast Radius

This milestone creates the first executable repository surface and local database/storage containers. It must not contact protected production hosts, the external gateway or any remote account. Migrations are irreversible once applied to a shared database; use disposable local PostgreSQL and record rollback SQL for every migration. Fixtures are synthetic and contain no credentials or personal data.

## Research and decisions before execution

1. Reverify M0 A version pins and the current RapidOCR package/model licensing without installing unpinned dependencies.
2. Convert the M0.5 decision register into an executable schema/role/index matrix; identify every raw SQL expression Prisma cannot own.
3. Confirm local ClamAV image/config behavior and the staged upload transaction using synthetic EICAR fixtures.
4. Define the exact `NormalizedDocument`, `PageRoute`, OCR line/quad and Node→Python payload schemas with NFC-only handling.
5. Define the generated limits source and boot assertions so nginx/clamd/app/DB cannot drift.

## Implementation Checklist

- [ ] Scaffold workspace with pinned versions from M0 A §3.7 and a locked dependency file.
- [ ] Add environment schema, redacted logger, boundary/layer rules and synthetic-fixture CI check.
- [ ] Add PostgreSQL schema/migrations for Organization, visibility entities, Document, storage, runs, jobs, pages, OCR results/events, roles, grants, FORCE RLS and hand-authored indexes.
- [ ] Implement identity-addressed local storage, path parser, size reservations and encryption/key ports.
- [ ] Implement upload staging, MIME/container sniffing, quarantine state, ClamAV scan job and clean/failed state transitions.
- [ ] Implement C2 claim/heartbeat/finish functions, hashed leases, retries, checkpoints, cancellation and idempotent enqueue.
- [ ] Implement PDF/image/OOXML parsing under limits, C3 route decision, render/preprocess pipeline and C4 primary OCR adapter with coordinate round-trip assertions.
- [ ] Persist append-only per-page OCR evidence and document progress; expose minimal status/read endpoint with F1 authorization.
- [ ] Add readiness/liveness, structured metrics and runbook-quality local compose configuration; keep AI profile disabled.
- [ ] Run all verification stages below and write the M1 report with commit SHA, commands, evidence and residual blockers.

## Verification Evidence

**Automated:** typecheck, lint, dependency-cruiser and eslint boundaries including a known-bad fixture; unit tests; disposable-PostgreSQL integration tests; Playwright E2E against a production build; migration drift and startup assertions. When the runner exists, record commands and fixtures in `process/context/tests/all-tests.md`.

**Security/negative:** cross-tenant reads return 404; intra-tenant non-member reads deny; raw worker table DML denies; wrong lease token cannot heartbeat/finish/write; infected and malformed uploads never enqueue extraction; size/page/archive limits fail closed; logs contain no filename, IP, OCR text, field value or secret.

**Concurrency/recovery:** duplicate idempotency submissions create one document/run; forced worker kill resumes from page checkpoints; expired leases are reclaimed; requeue creates a new run without unique violations; cancellation is terminal and auditable.

**Manual:** upload a synthetic Thai/English fixture, observe quarantine → clean → extraction, inspect page image/text geometry and warnings, then verify the SQL trace from document id through run, job and OCR result.

**Data:** record PII-free SQL outputs proving composite foreign keys, RLS policies, role grants, index definitions, append-only constraints and object-key tenant prefixes. No OCR accuracy claim is made until M2.

## Acceptance Criteria

The local stack starts from a clean checkout; a synthetic document completes deterministic OCR; every failure path is safe and observable; tenant isolation and lease fencing are proven as denials; the OCR record is reproducible and append-only; AI is absent/disabled; all automated, manual and data gates pass. This is `CODE DONE` until owner review confirms the evidence; it is not `VERIFIED` from a build alone.

## Phase Completion Rules

M1 cannot close with an open Critical/High security finding, a failed isolation/lease test, an unscanned publication path, a missing migration assertion, a real fixture, an unmeasured claim presented as accuracy, or absent milestone report. Owner review is required before M2 begins.

## Resume and Execution Handoff

Read `process/context/all-context.md`, the M0.5 decision record and this plan. Perform the five research items, update this plan with any justified drift, then stop for the explicit execution transition `ENTER EXECUTE MODE` with this exact plan path. After execution, run the verification stages, write the M1 report and update context before preparing M2. Do not add AI, handwriting or production deployment to this milestone.
