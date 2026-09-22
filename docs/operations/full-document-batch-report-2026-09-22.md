# Full-document OCR + batch upload + table UI — rollout report (2026-09-22)

Continuation of the Codex session that stopped on 2026-09-21 (out of credits) after planning. Branch
`feature/full-document-batch` (GitHub `innovera2025/ocr`); `main` not yet updated.

## 1. Commits

| Commit | Content |
|---|---|
| `845a053` | Production app state imported (VPS HEAD `4004ff0` + 6 uncommitted hotfix files), byte-identical to the VPS tree |
| `3a3b0ba` | Merge with `origin/main` (Codex contract commits) |
| `94ff56d` | Local AI v2.2 source imported into `local-ai/`; implementation contract |
| `cdcf8d1` | Local AI v3: section crops, ink-based checkboxes / body map / blank boxes, masters, timings |
| `a806dd8` | Migration 0017, document views, batch/list/retry/review persistence, outbox-definer provisioning SQL |
| `317377d` | Batch/list/review/retry API, CSP, worker concurrency + maintenance loop, DEAD for 4xx |
| `fe0b667` | Table workbench UI |
| `e1a6f8d`, `a9f859e` | Fixes from two adversarial review rounds (24 + 14 confirmed findings) |
| `c73335e` | Rollout runbook |
| `048878d`, `01fd3fd`, `5edbe5e`, `9e45db7`, `3151ac9` | Tuning against the real model on the production host; one combined model call; fallbacks |

## 2. Migrations applied

`0017_batch_processing` applied by the web container as `ocr_migrator` at 2026-09-22 03:05:04 UTC.
Verified after apply: `ocr_batches` has ENABLE + FORCE RLS; grants `ocr_app` SELECT/INSERT/REFERENCES,
`ocr_worker` REFERENCES; all 7 queue/outbox SECURITY DEFINER functions still owned by `ocr_queue_definer`.
The production-only outbox ownership fix is now recorded in `deploy/sql/queue-definer.sql`.

## 3. Services deployed

| Host | Service | Change | Rollback |
|---|---|---|---|
| Local AI 187.53.143.23 | `innovera-ocr-api` (mount `/opt/innovera-ocr`) | v2.2 → v3.0 `typhoon-sections` (files = repo `local-ai/` at `3151ac9`) | `/opt/innovera-backups/full-document-20260922/ocr-pre-swap-*.tar.gz`, image tag `innovera-ocr-api:pre-v3-20260922` |
| App 72.61.123.78 | `deploy-web-1`, `deploy-worker-1` | images built from `9e45db7` (app code unchanged since); worker `OCR_WORKER_CONCURRENCY=2` | images `innovera-ocr-{web,worker}:pre-0017`; DB dump `database-pre-0017.dump`; 0017 is additive |

PostgreSQL, ClamAV, Prometheus, nginx and the other applications on both hosts were not recreated or changed.
The app VPS checkout is on `feature/full-document-batch`; the old uncommitted hotfixes are kept in `git stash`
(content identical to `845a053`).

## 4. Test results

- TypeScript: typecheck + lint clean, 146/146 tests.
- DB integration (throwaway PostgreSQL 17.6 provisioned like production): 20/20.
- Local AI pytest (python 3.11): 159/159; ruff clean.
- Local full stack (fake model): 33/33 HTTP checks; Playwright E2E.
- Local AI v3 side-by-side on the production host with the real model: 12/12 fresh documents fully parsed.

## 5. Production E2E (browser, https://ocr.innoveraappcenter.com)

Uploads used ±1-pixel variants of the two real sample forms so Ollama's prompt cache could not answer.

| Batch | Files | Wall time | Throughput | Result |
|---|---|---|---|---|
| 1 | 1 | 26 s | — | read, NEEDS_REVIEW (scribbled oil row) |
| 2 | 5 | 158 s | 1.9 docs/min | 5/5 read |
| 3 | 10 | 254 s | 2.4 docs/min | 10/10 read |
| 4 | 2 (1 corrupt PNG) | ~30 s | — | corrupt → FAILED (HTTP 400, no retries), sibling read; UI retry queued a new job, failed again as expected |

All 16 real-form documents returned gender, health conditions, pressure, body map, treatments with durations
and room correctly. Misreads, all flagged for review: 3× therapist `ฟิพี่` (no master match); 1× the model answered
with its own training prompt (staff recovered by the fallback, customer name lost; the customer fallback that
fixes this was deployed afterwards, `3151ac9`). Review drawer: therapist `ฟิพี่ → พีพี`, treatment confirmed,
scribbled oils removed → document confirmed; outbox delivered both provider corrections to the Local AI in ~1 s
(`therapist ฟิพี่ → พีพี`, `treatment หน้า → นวดหน้า` now in verified memory). Browser console: 0 errors, 0 warnings.

## 6. OCR latency (production host: CPU-only, 8 vCPU, Ollama one request at a time)

- One model call ≈ 24–27 s for a new document (prompt eval ~26 s for ~1,150 tokens; every image is resized to
  ~1,070 tokens). v2.2 measured the same way: 24.7–27.6 s. The earlier "1.5–1.8 s" was the prompt cache.
- v3 default makes one combined call: 23.9–24.7 s per document alone; deterministic work ~60 ms.
- A fallback call adds ~25 s for the rare document whose combined answer is unusable.

## 7. Batch throughput

1.9–2.4 documents/minute, bounded by the single Ollama slot on CPU (worker concurrency only keeps it busy).
10 documents ≈ 4–5 minutes. More throughput needs a GPU or a second Ollama host.

## 8. Remaining known issues and follow-ups

- **Security:** `/api/web-token` issues a tenant token to any visitor (deliberate auto-auth), so the site and its
  customer/health data are public. Put Basic Auth / IP allowlist / real login in front.
- **Security:** root SSH passwords are stored in plaintext in `connect-*.command` on the operator Mac and appeared
  in chat logs; key login works — rotate the passwords and disable password SSH.
- Throughput (above). `master_data.json` allowed durations are placeholders — confirm with the spa menu.
- Verified memory is global to the Local AI (not tenant-scoped), as in v2.2.
- `documents.confirm_status` stays `PENDING` after outbox delivery (pre-existing; UI uses `deliveryStatus`).
- Worker metrics are not scraped (worker has no `/metrics`; pre-existing).
- Batch label cannot be set from the UI. 18 E2E documents (`e2e-*.png`) remain in the tenant (no delete endpoint).
- The Local AI keeps every upload in `/opt/innovera-ocr/uploads` (pre-existing retention question).
- Merge `feature/full-document-batch` into `main` and push (pending approval).
