# Release 1 — production deploy and real-model run (2026-09-22)

Scope: Local AI v3.2 (`typhoon-sections`, fitted registration, separate Thai-vocabulary STAFF call, token confidence) and
the app's multi-page PDF split (migration `0018_multipage_documents`), from branch `feature/real-data-release1` at
`027e825`. Plan and design: `release1-plan.md`. Aggregates only; no customer values are recorded here.

## Deploy
| Step | Result |
|---|---|
| Backups (AI host) | `/opt/innovera-backups/release1-20260922/ocr-pre-v32.tar.gz`, `corrections-pre-v32.jsonl`, image tag `innovera-ocr-api:pre-v32-20260922` |
| Local AI v3.2 | `/health` reports 3.2 (host and public gateway); smoke test on the synthetic sample 54 s, verdict `known`, both sections read; the test upload was deleted |
| Backups (app host) | `/opt/innovera-backups/release1-20260922/database-pre-0018.dump`, previous HEAD/status, image tags `innovera-ocr-web:pre-release1`, `innovera-ocr-worker:pre-release1` |
| Web | `0018_multipage_documents` applied at startup; `SPLIT` enum value and the three columns present; worker grants: `INSERT` only on `extraction_jobs` (no `SELECT`); the seven queue/outbox functions still owned by `ocr_queue_definer`; `/health/live` and `/health/ready` 200 |
| Worker | `worker_started` with `concurrency: 1`, `max_pdf_pages: 300`, `page_format: png`; poppler 22.12.0 in the image |

Deviation from the runbook order: the old worker was replaced 2 min after the new web started (11:23:46 → 11:25:46 UTC)
instead of being stopped first. No document was uploaded in that window (the database held only the user's PDF), so no
multi-page PDF could have been read as page 1 only.

Production still sets `OCR_REQUEST_TIMEOUT=120` in the host env file (the release default is 300). With one job loop the
slowest page took 78.7 s, so it did not trip; raise it before running more than one job loop.

## The user's 95-page PDF (`16.08.2026_8.SPA6.pdf`, previously FAILED with 413)
- Retry → split into 95 page rows in 18.5 s (0 failed pages); the SPLIT parent is hidden; every row carries
  `parentFilename` and `pageCount: 95`; the UI shows "หน้า N/95", form number and branch.
- OCR: 95/95 pages processed, 0 failed, 0 retries, 0 section errors; template verdict `known` on 95/95; every page
  `NEEDS_REVIEW` (expected while therapist masters are seeds and the body map is weak).
- Time: 82 min from the first to the last page; Local AI per page median 51.7 s, p90 53.9 s, max 78.7 s.

## Accuracy vs the hand labels (95 pages)
| Field | Right | Wrong, flagged | Wrong, not flagged |
|---|---|---|---|
| Gender | 94/95 | 1 | 0 |
| Referral sources | 99 % | 1 | 0 |
| Pressure | 90/95 | 5 | 0 |
| Form number | 95/95 | 0 | 0 |
| Nationality | 82/95 (counting "Singapore" = "Singaporean", "UK" = "British" etc.) | 13 | 0 |
| Hotel | 73/95 | 21 | 1 |
| Room | 73/95 | 21 | 1 |
| Health conditions (list exact) | 81 % | 18 | 0 |
| Oil / scrub (list exact) | 59 % | 39 | 0 |
| Customer name (exact) | 41/95 (66 with similarity ≥ 0.8) | 51 | 3 (each one letter off) |
| Treatment names | 46/95 | 47 | 2 (one is the hot-oil naming of the labels) |
| Treatments + durations | 42/95 | 51 | 2 |
| Avoid areas (body map) | 58 % | 39 | 1 |
| Preferred areas (body map) | 40 % | 54 | 3 |
| Therapist | 6/95 | 89 | 0 |

Compared with the isolated v3.2 eval run on the same pages the numbers agree within model noise (treatment names 52 → 48 %,
room 80 → 77 %, name 46 → 43 %, hotel 78 → 77 %, therapist 6 → 6 %); both runs read the pages at the scan's native
resolution, so the differences are model variation, not the split.

## Issues found
1. The batch strip's "เวลาที่ใช้" and "เอกสาร/นาที" count from the batch's `createdAt`; a batch retried hours after its
   upload shows a long elapsed time and a rate near 0 (`apps/ocr-web/src/workbench.ts`, elapsed calculation). Display only.
   Fix in Release 2 (start the clock at the first claim of the current round, or have the server return it).
2. Therapist names need the client's official list per branch; seeds never clear review.
3. The body map is the weakest section (4 unflagged errors in 95 pages across both lists).

## Rollback
Local AI: restore `ocr-pre-v32.tar.gz` and retag `innovera-ocr-api:pre-v32-20260922`. App: retag the `pre-release1`
images and `up -d --no-deps web worker`; 0018 is additive, and the consequences of a web or worker rollback are listed in
`design-2026-09-22.md` (risk table) and `full-document-batch-spec.md` §9. `database-pre-0018.dump` is kept for a full restore.
