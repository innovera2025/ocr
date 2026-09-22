# Release 2 — user login + export: requirements collected so far

Status: not started (Release 1 first). Approved order: Release 1 → Release 2 → Release 3.

## Access control (blocker for export)
- Replace the public `/api/web-token` auto-auth with a **user login** (approved 2026-09-22): each staff member has a
  username/password; reviews and confirmations are attributed to the logged-in user (audit), not to a shared subject.
- Export must not be reachable before login is in place.

## Export (design: `design-2026-09-22.md` §3)
- CSV (UTF-8 with BOM for Excel Thai) and JSONL; one row per document/page; filters by batch, date range, status,
  confirmed only; preview table in the UI.
- **Original file name (user requirement, 2026-09-22):** every exported row shows the name of the file that was
  uploaded at the start of the scan (e.g. `16.08.2026_8.SPA6.pdf`), including every page row that came from a split
  PDF — i.e. `parentFilename ?? filename`, which Release 1 already stores and returns. Put it in the first columns,
  next to the page position:
  - `ชื่อไฟล์ต้นฉบับ` / `original_file_name` — the uploaded file's name
  - `หน้า` / `page` — page number within that file (empty for single images), plus `จำนวนหน้า` / `page_count`
  - `อัปโหลดเมื่อ` / `uploaded_at` — upload time (Asia/Bangkok)
- Show the same original file name (and page N/M) in the UI export preview table.
