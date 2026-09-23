# Release 2 — production report (2026-09-23)

Login (Deploy A) and export (Deploy B) are live. Plan: `release2-plan.md`; runbook: `release2-deploy.md`.
Branch `feature/release2-login-export`, merged to `main` at `946c41f`; production runs `ee0a769` (main adds only the
checksum pin). Aggregates only; no customer values and no credentials here.

## Deploy A — login (morning)
| Step | Result |
|---|---|
| Backups | `/opt/innovera-backups/release2-20260923/`: `database-pre-0019.dump` (11 TABLE DATA), `ocr-compose.env.bak`, previous HEAD; image tags `innovera-ocr-{web,worker}:pre-release2` |
| Proxy precondition | `nginx-proxy` sets `X-Forwarded-For $proxy_x_forwarded_for`, a map over `$proxy_add_x_forwarded_for`, so exactly one hop appends the client → `OCR_TRUSTED_PROXY_HOPS=1` |
| Host env | `OCR_WEB_AUTO_AUTH` deleted (a rollback fails closed), `OCR_PUBLIC_BASE_URL` added, `AUTH_JWT_SECRETS` rotated in place (generated on the host, never printed) |
| Migration 0019 | applied at web startup; `users`, `auth_sessions`, `audit_events` all FORCE RLS; the 7 queue functions still owned by `ocr_queue_definer` |
| Checks | grant check 18/18 PASS; `auth-smoke.sh` 9/9 PASS (including `web-token:gone`); `/api/web-token` and `/api/batches` answer 401; login page renders in Thai |
| First admin | created with the CLI driven over a pty, password generated on the host; the host file was removed after hand-over. The account owns a self-chosen password (no forced change), so it must be changed by hand |
| End-to-end | login 200 → `/api/documents` 200 (95 rows) → logout 204 → 401 |

## Deploy B — export and carry-overs (afternoon)
| Step | Result |
|---|---|
| Backups | `/opt/innovera-backups/release2b-20260923/`: `database-pre-0020.dump` (14 TABLE DATA), env copy, previous HEAD; image tags `*:pre-release2b` |
| Host env | `OCR_REQUEST_TIMEOUT` 120 → 300 (the release default) |
| Order | queue empty (96 SUCCEEDED, 1 DEAD) → old worker stopped → web (applies 0020) → worker |
| Migration 0020 | `0020_batch_round_clock` applied; function owners unchanged; 0 `request_failed` in the first 5 min |
| Worker | `worker_started` once, `concurrency 1`, `OCR_REQUEST_TIMEOUT=300`, gate `REQUIRED_SCHEMA_VERSION=0020_batch_round_clock` |
| Checks | grant check `PASS=20 SKIP=0 FAIL=0`; `auth-smoke.sh` 9/9; `/api/exports/documents.csv` and `/api/exports/preview` answer 401 without a session |
| Export end-to-end (admin) | preview 200 with first columns `ชื่อไฟล์ต้นฉบับ, หน้า, จำนวนหน้า, อัปโหลดเมื่อ` and total 95; CSV 200, UTF-8 BOM present, 96 lines (header + 95); JSONL 200, 95 lines. Downloads were deleted from the host immediately |

## What shipped
- Per-user login (opaque server-side sessions in `__Host-ocr_session`, scrypt passwords, layered CSRF, throttling with
  identical answers for unknown and locked accounts), an admin/staff role split with a per-user export right, an
  append-only `audit_events` row written in the same transaction as each action, and admin user management in the UI.
- Export: CSV (UTF-8 BOM, CRLF, RFC 4180, formula guard) and JSONL, one row per document or page, the original
  uploaded file name first, filters (batch, date range in Asia/Bangkok, status, confirmed-only, search), a preview
  table that renders exactly the file's columns, cursor streaming in one REPEATABLE READ tenant transaction, row cap,
  per-user and per-process concurrency limits, and `export.started/completed/failed/previewed` audit rows.
- Carry-overs: the batch strip counts from the current processing round (`round_opened_at`, `processing_started_at`)
  and shows `—` until the first claim; `OCR_REQUEST_TIMEOUT` back to 300.

## Engineering record
Two implementation passes plus two adversarial review passes: the login half took 14 findings (13 fixed), the export
half 22 in its second pass (18 fixed, 4 shown to be non-issues: the `:-` compose default, bare LF inside a quoted CSV
field, the `OCR_REQUEST_TIMEOUT` conflict, and one half of the grant-check claim). Tests went 199 → 388 plus 42 DB
integration tests; typecheck and lint clean; `prisma/migrations` 0001–0019 untouched by the export half, 0020 the only
new migration, and the checksum pin now freezes 0001–0020.

## Open items
1. The bootstrap admin password was handed over in chat and has not been changed yet — change it, then create staff
   accounts (each gets a one-time temporary password valid 72 h).
2. `can_export` gates the export file, not the data: any logged-in user can still page `/api/documents`. Deliberate
   (`documents_read_total` watches it), but worth a decision if staff should be restricted.
3. Excel's double-click CSV import still coerces `007` to `7`; the file itself is correct. An `.xlsx` writer or a
   `codes=excel` toggle would fix it and is additive.
4. `nginx-proxy` sets no `proxy_read_timeout`, so the default (60 s) bounds the gap between two export chunks. Fine at
   today's volume (one chunk per 500 rows); revisit if an export ever stalls.
5. Never exercised at scale: the 50,000-row cap, the 60 s per-FETCH statement timeout and the 10-minute wall clock.
6. Deploy A's runbook order (stop the old worker before the new web) was followed in Deploy B; in Deploy A the old
   worker ran ~2 min alongside the new web with no uploads in that window.
