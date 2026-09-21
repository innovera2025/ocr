---
dimension: a-environment-and-stack
title: Environment assessment + INNOVERA stack alignment
m0_items: A, I (part)
status: reviewed
date: 2026-09-09
reviewed: 2026-09-09
review_kind: adversarial completeness critique + in-place revision
---

# A — Environment assessment + INNOVERA stack alignment

> **Integration status (2026-09-12):** Read the [architecture index](../README.md) and its consolidation report before using these examples. Individual review labels do not close cross-document conflicts; no application implementation is verified.

Scope: M0 item **A** (existing repository / environment assessment) and the stack-alignment
half of item **I**. This document is the foundation the other M0 dimensions build on: it fixes
the toolchain pins, the layering contract, the queue prior art, the harness layout, the test
conventions, the deploy pattern, and the exact list of native dependencies that must live in a
container because they do not exist on this machine.

Everything below was read or executed in this session. Claims that could not be verified are
prefixed **UNVERIFIED:**.

> **Review status.** This document was re-verified end-to-end on 2026-09-09 by an adversarial
> critic pass. Every quoted config, schema, and script excerpt was re-read against the source file
> and is accurate as printed. Every version number was re-fetched from `registry.npmjs.org`.
> Four factual errors were corrected, six open `UNVERIFIED:` items were closed, and five new
> sections were added (§5.6 Thai data-layer, §7.6 Thai test fixtures, §8.6 untrusted-input
> hardening, §9.0 probe supersession, §10.1 cross-document reconciliation). See **§13 Critic
> Notes** for the full change log and for what remains genuinely unknowable in this session.

> **⚠ This document is the single source of truth for toolchain version pins.** Sibling M0
> dimension documents written in parallel (`m-docker-nginx-resources.md`,
> `h-queue-and-worker-contract.md`) hardcode the *jawbong* pins (Node 22.23.1, Next 16.2.12,
> pnpm 11.18.0, Prisma 7.9.1, Zod 4.4.3) rather than the pins recommended here. That is a live
> corpus-wide contradiction, not a difference of opinion. See **§10.1** for the exact
> reconciliation list. Do not scaffold from a sibling document's Dockerfile without applying §3.7.

---

## 0. Executive summary — the decisions

Decisions are numbered `A-n`. The register is **A-1 … A-11**; earlier drafts of this section said
"the eight decisions", which undercounted (A-9 is introduced in §3.5, and the ESLint and
harness-inheritance decisions were unnumbered — they are now A-10 and A-11).

| # | Decision | One-line reason |
|---|---|---|
| A-1 | Pin **Node 24.21.0** (LTS Krypton), not Node 22 | Node 22 left Active LTS on 2025-10-21 and is EOL 2027-04-30; the jawbong pin is already on maintenance |
| A-2 | Pin **pnpm 12.3.4** via corepack, `save-exact=true` | Current stable; jawbong is a full major behind at 11.18.0 |
| A-3 | Pin **Next 16.3.4 / React 19.2.8 / TypeScript 6.0.3** | 16.3.3 shipped two critical-severity fixes that 16.2.12 does not have; TS 7 has no stable programmatic API until 7.1 so lint tooling cannot consume it |
| A-4 | Pin **Prisma 7.10.0 explicitly** — never resolve `latest`, and never let the CLI and client float apart | npm `latest` for the **`prisma` CLI** resolves to `8.0.0-rc.13` while `latest` for **`@prisma/client`** is `7.10.0`; `pnpm add prisma @prisma/client` therefore installs a **mismatched RC-CLI / stable-client pair**, which Prisma requires to be identical |
| A-5 | **Copy the jawbong layering contract verbatim**, add a **6th** element `workers` | The dual dependency-cruiser + eslint-plugin-boundaries enforcement is the single most valuable thing in the house stack; OCR needs a long-running process that Next cannot host |
| A-6 | **Copy `outbox_events` + `idempotency_records` verbatim (with three fixes, §5.3). Do NOT reuse them as the OCR job queue.** Add a new `ocr_jobs` table | The outbox has no result column, no priority, a 30 s batch lease that a page OCR will blow through, a lease-unchecked completion path, an order-dependent idempotency hash, and no idempotency completion path. **The `ocr_jobs` design itself is owned by `h-queue-and-worker-contract.md`; this document supplies only the prior art and the constraints** |
| A-7 | **Deploy as compose + Caddy, one-shot `migrate` service, superuser/app-role split** | This is the only one of the three observed deploy patterns that has version-tracked migrations and least-privilege runtime. **Edge choice is host-determined — see `m-docker-nginx-resources.md` §3.1** |
| A-8 | **Everything OCR-native must be containerized.** Nothing exists locally | tesseract, poppler, ghostscript, qpdf, imagemagick, libreoffice, pdftotext, exiftool: all ABSENT. System python is 3.9.6 (EOL). No CUDA, no MPS |
| A-9 | Target **`vitest@5.0.0`** behind a mechanical scaffold gate | Greenfield ⇒ no migration cost; the satellite peer ranges have now been **verified compatible** (§3.5), so the gate is expected to pass |
| A-10 | Pin **`eslint@9.39.5`**, not 10.10.0 | Not for the reason originally given: `eslint-config-next` and `eslint-plugin-boundaries` both accept `^10`. The real cap is the transitive **`eslint-plugin-import@2.32.0`**, whose eslint peer range stops at `^9` (§3.6) |
| A-11 | **Inherit** the RIPER-5 harness from `/Users/innovera`; do not vendor it | Vendoring forks the protocol and guarantees drift across TCL / jawbong / OCR (§6.1) |
| A-12 | **Set `minimumReleaseAge` explicitly** in `pnpm-workspace.yaml` | jawbong carries a `minimumReleaseAgeExclude` list with **no `minimumReleaseAge` anywhere** — no global `~/.npmrc` and no `~/.config/pnpm/rc` exist on this host — so its exclude list is inert and it has **zero** supply-chain delay window (§3.4) |
| A-13 | **Thai correctness is a data-layer decision, not a UI decision**: ICU `th-TH` collation, canonical mark reordering before any hash or unique key, `TEXT` not `VARCHAR`, and no reliance on Postgres FTS | Verified in-session: Thai marks are **not** canonically reordered by NFC, JS `\d` and `parseInt` reject Thai digits, and the default collation sorts Thai wrong (§5.6) |

---

## 1. Target repository state (M0 item A, part 1)

`/Users/innovera/Documents/OCR` — re-verified with `find`, 2026-09-09 (**this supersedes the
first draft's snapshot, which was taken before the sibling M0 dimension documents landed and
therefore recorded `docs/architecture/m0/` as empty**):

```
docs/architecture/m0/       a-environment-and-stack.md   (this file)
                            b-ai-topology-discovery.md
                            c-ai-capability-probe.md
                            d-ocr-engine.md
                            e-native-extraction-routing.md
                            f-preprocessing-and-confidence.md
                            h-queue-and-worker-contract.md
                            i-storage.md
                            j-security-threat-model.md
                            l-api-ui-export.md
                            m-docker-nginx-resources.md
docs/m0/discovery/          probe-ai-gateway.sh    (676 lines, never executed)
                            probe_ai_gateway.py    (1172 lines, never executed)
process/context/                   (empty)
process/general-plans/active/      (empty)
process/general-plans/references/  (empty)
process/general-plans/reports/     (empty)
```

- **Not a git repository.** `git -C /Users/innovera/Documents/OCR status` → `fatal: not a git repository`.
- No `package.json`, no source, no lockfile, no `.env`, no Dockerfile, no CI. **The only files in
  the tree are M0 prose and the two never-executed probe scripts.** Nothing here is application code.
- The skeleton is still **incomplete against the house contract**: `process/general-plans/completed/`
  and `process/general-plans/backlog/` are missing, `process/features/` does not exist at all, and
  `process/context/all-context.md` does not exist. All are mandatory per `/Users/innovera/CLAUDE.md`
  §"Shared Process Folder". §6.2 gives the exact tree to create.
- Three stray `.DS_Store` files exist (`/`, `docs/`, `process/`). The first commit's `.gitignore`
  must include `.DS_Store` — this is a macOS-only artefact that will otherwise be committed and
  will then appear in every CI checkout.

**Cross-document note.** Because ten sibling dimension documents now exist, this document is no
longer the only M0 artefact and must not silently contradict them. §10.1 records every point where
it does, and who wins.

**Conclusion for item A:** this is a genuine greenfield. There is no existing code, schema, or
config to preserve, migrate, or reverse-engineer. Every constraint in this document comes from
sibling repositories and from the host, not from this repo.

---

## 2. Host environment — verified, with a correction to prior ground truth

### 2.1 CORRECTION: this is an **Intel** Mac, not Apple Silicon

The orchestrator's brief states "Apple Silicon (/opt/homebrew present)". That is wrong, and the
correction changes real decisions.

Commands run and their exact output:

```
$ uname -m                          → x86_64
$ arch                              → i386
$ sysctl -n hw.optional.arm64       → sysctl: unknown oid 'hw.optional.arm64'
$ sysctl -n machdep.cpu.brand_string → Intel(R) Core(TM) i5-1038NG7 CPU @ 2.00GHz
$ ls -d /opt/homebrew               → No such file or directory
$ ls -l /usr/local/bin/brew         → /usr/local/bin/brew -> ../Homebrew/bin/brew
```

**Why this matters:**

1. **Docker runs `linux/amd64` natively.** `docker info` reports `linux/x86_64`. There is **no
   QEMU emulation penalty** for OCR containers. On an Apple Silicon box, `paddlepaddle`,
   `onnxruntime`, and most CPU-inference wheels are either arm64-missing or emulated at
   ~4-10x slowdown. Here they run at native speed. This is a real advantage for M2 prototyping
   and it flips the usual "beware of arm64 wheels" advice.
2. **There is no GPU acceleration path at all, locally.** `system_profiler SPDisplaysDataType`
   reports `Chipset Model: Intel Iris Plus Graphics`, `VRAM (Dynamic, Max): 1536 MB`,
   `Metal Support: Metal 3`. No NVIDIA → no CUDA. Intel iGPU → no Apple MPS (MPS is Apple
   Silicon only). **All local OCR inference is CPU-only on 8 threads.** Any benchmark produced
   on this machine is a CPU-only floor, not a production number.
3. Homebrew installs land in `/usr/local`, not `/opt/homebrew`. Any setup script that hardcodes
   `/opt/homebrew/bin/brew` will fail here.

### 2.2 Host capacity

```
$ sysctl -n hw.memsize hw.ncpu     → 34359738368 (32 GiB), 8
$ df -h /System/Volumes/Data       → 466Gi total, 276Gi available
$ docker info                      → linux/x86_64 | ncpu=8 | mem=8324579328 | server=29.5.2
$ docker compose version           → v5.1.3
```

**The binding constraint is the Docker VM, not the host.** Docker Desktop has been allocated
**8,324,579,328 bytes ≈ 7.75 GiB** of the host's **34,359,738,368 bytes = 32 GiB**. (An earlier
draft wrote "8.32 GB of the host's 32 GB", mixing a decimal figure with a binary one; the correct
like-for-like statement is **7.75 GiB of 32 GiB ≈ 24 %**.) An M2 stack of `app + postgres +
ocr-worker` where the OCR worker loads a detection model plus a Thai recognition model will be
tight in 7.75 GiB, and will be impossible if a vision model is also run locally.
`m-docker-nginx-resources.md` §0.2 reaches the identical figure independently and sizes every dev
scenario against 7.75 GiB.

> **Owner action required (we must not change this ourselves):** raise Docker Desktop's memory
> allocation to 16 GB before M2 OCR container work begins. Docker Desktop → Settings →
> Resources → Memory. This is a host reconfiguration and is explicitly outside our M0 mandate.

### 2.3 Ports already taken on this host

`docker ps` (2026-09-09):

| Container | Image | Host binding |
|---|---|---|
| quotation-system-app | quotation-system-quotation-app | `0.0.0.0:8080->80` |
| quotation-system-api | quotation-system-quotation-api | internal `3000` only |
| quotation-system-postgres | postgres:16-alpine | internal `5432` only |
| krs-pos-db | postgres:16-alpine | `127.0.0.1:5432->5432` |
| orderstock-sql | mcr.microsoft.com/mssql/server:2022-latest | `0.0.0.0:1433->1433` |

**Consequence:** the OCR dev stack must not claim `8080`, `5432`, or `1433`. Follow the jawbong
convention of a high loopback-only port for the disposable test DB (jawbong uses
`127.0.0.1:55432:5432`); use a distinct one for OCR, e.g. `127.0.0.1:55433:5432`, and bind the
Next dev/preview server to a non-3000 port for E2E as jawbong does (`127.0.0.1:3100`).

### 2.4 Local toolchain — what exists

| Tool | Present? | Version / path |
|---|---|---|
| node | yes | `v22.22.3` at `~/.nvm/versions/node/v22.22.3/bin/node` (nvm-managed) |
| pnpm | yes | `11.18.0` |
| corepack | yes | `0.34.6` |
| docker | yes | `29.5.2`, compose `v5.1.3` |
| brew | yes | `/usr/local/bin/brew` (Intel prefix) |
| uv | yes | `0.11.17` at `~/.local/bin/uv` (x86_64-apple-darwin build) |
| python3 (system) | yes | `3.9.6` at `/usr/bin/python3` — **EOL, unusable for modern OCR** |
| python3.11 | **yes** | `3.11.15` at `~/.local/bin/python3.11` → `~/.local/share/uv/python/cpython-3.11-macos-x86_64-none/bin/python3.11` |

**Correction to prior ground truth #2:** the brief says "Python: /usr/bin/python3 is 3.9.6
(system Python only). No pyenv/conda found on PATH." That is true as far as it goes, but it
misses that **uv has already installed CPython 3.11.15** and it is on PATH as `python3.11`.
A Python OCR sidecar can therefore be prototyped locally today with
`uv venv --python 3.11 && uv pip install ...`, with no new installer and no `brew install python`.

### 2.5 Local toolchain — what is ABSENT (this is the M2 container manifest)

Probed with `command -v` for each. Every one returned ABSENT:

| Binary | Package it comes from | What M2 needs it for |
|---|---|---|
| `tesseract` | tesseract + tesseract-lang | Baseline OCR engine; `tha` traineddata |
| `pdftoppm` | poppler-utils | **PDF → raster. Required on every branch, including a vision-LLM branch** |
| `pdfinfo` | poppler-utils | Page count, page geometry, MediaBox, rotation |
| `gs` | ghostscript | PDF repair/flatten, colour conversion |
| `qpdf` | qpdf | Linearize, decrypt, split, structural validation before render |
| `mutool` | mupdf-tools | Fast alternative render + text-layer extraction |
| `magick` / `convert` | imagemagick | Deskew, binarize, DPI normalization |
| `soffice` / `libreoffice` | libreoffice | DOCX/XLSX → PDF for non-PDF ingest |
| `pdftotext` | poppler-utils | **Native text-layer extraction — the cheap path that skips OCR entirely** (see `e-native-extraction-routing.md`) |
| `exiftool` | exiftool | Metadata strip on upload; EXIF orientation before raster |

Two additions to the original list, both re-verified ABSENT in this review: **`pdftotext`** and
**`exiftool`**. `pdftotext` matters more than any other binary here — it is the difference between
a born-digital PDF costing ~20 ms and costing 90 s of OCR per page, and it was missing from the
first draft's manifest.

Also absent: `paddleocr` (no python package), and no `pip` package for `pytesseract`. The two
Python packages the brief notes as installed (`pillow 11.3.0`, `pypdf 6.13.1`) are on the
**3.9.6 system interpreter**, which is the wrong interpreter for OCR work anyway.

**Positive evidence of prior Thai OCR work** — confirmed by direct `ls`:

```
$ ls -la ~/.EasyOCR/model/
-rw-r--r--  83152330  craft_mlt_25k.pth   (79 MB — CRAFT text detector)
-rw-r--r-- 215384298  thai.pth            (205 MB — EasyOCR Thai recognizer)
```

Downloaded 2026-06-02. So EasyOCR + Thai was run on this machine at some point. This is
**not a reason to choose EasyOCR** — that is dimension B's call — but it does mean a torch-CPU
Thai OCR path has already been exercised here and the weights are cached locally, which
shortens any comparative benchmark by ~290 MB of download.

**Decision A-8 (confidence: high, reversibility: easy):** every native OCR dependency ships in a
container image, pinned by tag and ideally by digest. **Rejected:** `brew install tesseract
poppler ghostscript` on the host — it would make local results unreproducible against CI and
production, it would drift per-developer, and it contradicts the M0 constraint against modifying
this workstation. **What would change this:** nothing at the platform level; a developer may
install these locally for ad-hoc exploration, but the pipeline must never depend on a host binary.

---

## 3. Toolchain pins for a new sibling project (Sept 2026)

All "current" columns were fetched live from `https://registry.npmjs.org/-/package/<pkg>/dist-tags`
and `https://nodejs.org/dist/index.json` / `https://endoflife.date/api/*.json` on 2026-09-09.

| Package | jawbong pins | Current (verified 2026-09-09) | **Recommended pin for OCR** | Verdict on the jawbong pin |
|---|---|---|---|---|
| Node | `22.23.1` | `22.23.2` (line max); `24.21.0` (Active LTS); `26.8.1` | **`24.21.0`** | **STALE + wrong line.** Node 22 left Active LTS 2025-10-21 |
| pnpm | `11.18.0` | `12.3.4` (`latest`), `11.26.0` (`latest-11`) | **`12.3.4`** | STALE by one major |
| next | `16.2.12` | `16.3.4` | **`16.3.4`** | **STALE + security relevant** (see §3.2) |
| react / react-dom | `19.2.8` | `19.2.8` | **`19.2.8`** | Current |
| typescript | `6.0.3` | `7.0.2` is `latest`; `6.0.3` is the last 6.x | **`6.0.3`** | Current *for the 6 line* — and 6 is the right line (see §3.3) |
| prisma (CLI) | `7.9.1` | `latest`→**`8.0.0-rc.13`**; `prev`→`7.10.0` | **`7.10.0`** | Slightly stale; **the CLI's `latest` tag is a trap** (see §3.4) |
| @prisma/client | `7.9.1` | `latest`→**`7.10.0`** (*not* the RC) | **`7.10.0`** | Slightly stale. **The CLI and the client resolve `latest` to different majors — this is the actual footgun** |
| @prisma/adapter-pg | `7.9.1` | `latest`→`7.10.0` | **`7.10.0`** | Slightly stale |
| pg | `8.22.0` | `8.23.0` | **`8.23.0`** | Marginally stale |
| zod | `4.4.3` | `4.5.4` | **`4.5.4`** | Marginally stale |
| tailwindcss / @tailwindcss/postcss | `4.3.3` | `4.3.3` | **`4.3.3`** | Current |
| vitest | `4.1.10` | `5.0.0` (`latest`), `4.1.11` (`V4`) | **`5.0.0`** — gate now passes, §3.5 | Marginally stale within its line |
| @vitest/coverage-v8 | **absent** | `5.0.0` | **`5.0.0`** | **MISSING from jawbong entirely** — `vitest.config.ts` configures `coverage.reporter` but the provider package is not installed, so `vitest run --coverage` cannot work. Do not copy this gap |
| @playwright/test | `1.62.1` | `1.63.0` | **`1.63.0`** | Marginally stale |
| eslint | `9.39.5` | `10.10.0` (`latest`), `9.39.5` (`maintenance`) | **`9.39.5`** — see §3.6 | Current *for the maintenance line* |
| eslint-plugin-boundaries | `7.1.0` | `7.2.0` | **`7.2.0`** | Marginally stale (the first draft of §3.7 wrote `7.1.0`) |
| @testing-library/react | `16.3.2` | `16.3.3` | **`16.3.3`** | Marginally stale |
| @types/node | `22.20.1` | 24.x line for a Node 24 pin | **`24.x` (match the Node major)** | **BLOCKING, and missed by the first draft: pinning Node 24 while leaving `@types/node` on 22.x makes `tsc --noEmit` typecheck against Node 22 typings.** The Node pin and the `@types/node` major must move together |
| dependency-cruiser | `18.1.1` | `18.2.0` | **`18.2.0`** | Marginally stale |
| jsdom | `30.0.1` | `30.0.1` | **`30.0.1`** | Current. Note `engines.node: "^22.22.2 \|\| ^24.15.0 \|\| >=26.0.0"` — a Node 24 pin below **24.15.0** would fail it |
| PostgreSQL server | `18.4-bookworm` | `18.6` (EOL 2030-11-14) | **`postgres:18.6-bookworm`** + explicit ICU locale, §5.6 | Marginally stale, **and locale-unconfigured** |

Nothing in the jawbong list is fictional. Every package and version listed here was re-fetched
from `registry.npmjs.org/-/package/<pkg>/dist-tags` during the review pass and resolves. The
problems are staleness, two specific traps, and three **omissions** (`@types/node`,
`@vitest/coverage-v8`, and the Postgres locale).

### 3.1 Node — the one pin that must NOT be copied

`https://endoflife.date/api/nodejs.json` (fetched 2026-09-09):

| Cycle | Active-LTS ends (maintenance starts) | EOL | Latest |
|---|---|---|---|
| 22 (Jod) | **2025-10-21 / 2025-10-24 (past)** | 2027-04-30 | 22.23.2 |
| 24 (Krypton) | **2026-10-20 – 2026-11-06 → ~6–8 WEEKS FROM NOW** | 2028-04-30 | 24.21.0 (rel. 2026-09-07) |
| 26 | becomes LTS ~2026-10-28 (nodejs.org schedule implies 2026-11-05) | 2029-04-30 | 26.8.1 |

Sources disagree by about a fortnight on two of these dates and it is worth knowing why:
`endoflife.date/api/nodejs.json` gives Node 24's `support` (Active-LTS) end as **2026-10-20** and
Node 26's LTS start as **2026-10-28**; `nodejs.org/en/about/previous-releases` implies **2026-11-06**
and **2026-11-05** respectively from the published 6-month/18-month rule. `endoflife.date` is also
**stale on the version number** — it reports Node 24 latest as `24.20.0` while nodejs.org lists
`v24.21.0`, released 2026-09-07. **Where the two disagree, nodejs.org wins; `endoflife.date` is a
convenient mirror, not the source of truth.** Either way the operational conclusion is identical
and is stronger than the first draft implied:

> **Node 24 leaves Active LTS in roughly six to eight weeks, and Node 26 enters Active LTS in
> roughly the same window.** Pinning Node 24 today does not buy a comfortable Active-LTS runway; it
> buys about six weeks of one, followed by two years of maintenance-only support.

**Decision A-1 (confidence: high, reversibility: easy).** Pin **Node 24.21.0** *now*, and treat
the Node 26 bump as a **dated M1 deliverable, not a "schedule it sometime" note**. Node 22 is
already in maintenance and dies 2027-04-30 — shorter than this product's expected first support
window. **Rejected:** Node 22 (copies a dying pin, and would also force `@types/node@22`, see the
table above); Node 26 *today* (not yet LTS as of 2026-09-09, and `next`/`prisma`/`jsdom` engine
ranges have not been checked against it). **What would change this:** if Prisma 7.10.0 or
`next@16.3.4` turn out to have a hard incompatibility with Node 24 at scaffold time, fall back to
22.23.2 and treat the Node-26 bump as urgent instead of scheduled.

**The M1 bump gate, stated mechanically so it cannot be forgotten:**

> On or after **2026-11-05**, run `pnpm view next engines`, `pnpm view prisma engines`,
> `pnpm view @prisma/client engines`, `pnpm view jsdom engines`, `pnpm view vitest engines`, and
> confirm `@types/node@26` is published. If all six accept Node 26, bump `.nvmrc`,
> `.node-version`, `package.json engines`, `@types/node`, the CI `setup-node` input, **and every
> `FROM node:` line in `docker/*.Dockerfile`** in one commit. If any one does not, record which,
> and re-check monthly. Node 24 is supported until 2028-04-30, so a delay is safe — silence is not.

Engine ranges verified live during the review pass (all four were `UNVERIFIED:` in the first draft
and are now closed):

| Package | `engines.node` | Node 24.21.0 OK? |
|---|---|---|
| `next@16.3.4` | `>=20.9.0` | ✅ |
| `prisma@7.10.0` | `^20.19 \|\| ^22.12 \|\| >=24.0` | ✅ |
| `@prisma/client@7.10.0` | `^20.19 \|\| ^22.12 \|\| >=24.0` | ✅ |
| `vitest@5.0.0` | `^22.12.0 \|\| ^24.0.0 \|\| >=26.0.0` | ✅ |
| `jsdom@30.0.1` | `^22.22.2 \|\| ^24.15.0 \|\| >=26.0.0` | ✅ (but **only ≥ 24.15.0**) |
| `eslint-plugin-boundaries@7.2.0` | `>=18.18` | ✅ |

Note the `jsdom` lower bound: it also explains why the **local** box at `v22.22.3` still works —
it clears `^22.22.2` by one patch. A developer on `v22.22.1` would fail to install.

Note the local box runs `v22.22.3`, below even jawbong's pin. jawbong documents this exact drift
("The current local shell has Node 22.22.3, so commands emit an engine warning. Do not mutate
global tooling automatically"). Copy that discipline: pin in `package.json` `engines` + `.nvmrc`
+ `.node-version` + CI, and tolerate a local engine warning rather than silently upgrading the
developer's nvm.

### 3.2 Next.js — the stale pin is also a security pin

`registry.npmjs.org/-/package/next/dist-tags` → `latest: 16.3.4`, `canary: 16.4.0-canary.22`.

A web search for the Next.js 16 release lifecycle reports that **16.3.3 carried fixes for two
critical-severity vulnerabilities** and that 16.3.4 shipped 2026-08-31. jawbong's `16.2.12`
(2026-07-01 line) predates those fixes.

**UNVERIFIED:** the specific CVE identifiers and whether 16.2.x received a backport. Before
scaffolding, run `pnpm audit` on the resolved tree and check
`https://github.com/vercel/next.js/security/advisories`. Do not treat "16.2.12 is what jawbong
uses" as a safety argument.

**Decision A-3a (confidence: high, reversibility: easy):** pin `next@16.3.4` and
`eslint-config-next@16.3.4` (they version in lockstep in jawbong and must stay matched).

### 3.3 TypeScript — pin 6.0.3, not 7.0.2, and the reason is tooling not types

TypeScript 7.0 (the Go-native "Project Corsa" compiler) went GA on 2026-07-08 as `7.0.2`, and is
the npm `latest`. It is 8-12x faster to typecheck. It is nonetheless the **wrong pin today**:

> "TypeScript 7.0 ships without a stable programmatic API, which the team expects to land in
> 7.1, so tools like typescript-eslint and the framework tooling for Vue, Svelte, Astro, MDX and
> Angular cannot use it yet."
> — search result summarising the TS 7.0 release coverage, fetched 2026-09-09

**That was the only evidence in the first draft, and prose summarising a blog post is weak
grounds for a toolchain pin. The review pass replaced it with the machine-readable fact**, fetched
from the registry on 2026-09-09:

```
typescript-eslint@8.70.0  (dist-tag: latest)
  peerDependencies: { "eslint": "^8.57.0 || ^9.0.0 || ^10.0.0",
                      "typescript": ">=4.8.4 <6.1.0" }
```

`typescript-eslint`'s own peer range **excludes TypeScript 7 outright** (`<6.1.0`). This is not an
interpretation of a release note; it is a hard resolution constraint. And the dependency chain is
direct: jawbong's `eslint.config.mjs` imports `eslint-config-next/typescript`, and
`eslint-config-next@16.3.4` declares `"typescript-eslint": "^8.46.0"` as a **real dependency**
(not a peer). So pinning TS 7 puts an unsatisfiable peer on the tree and breaks `pnpm lint`, which
is a hard CI gate in the house pattern (`.github/workflows/ci.yml` runs `pnpm lint` before
anything touches a database).

Note also that the same peer range **caps TypeScript at `<6.1.0`**, so even the 6.x line has a
ceiling: a future `typescript@6.1` would need a `typescript-eslint` release first. `6.0.3` is
comfortably inside it.

TypeScript 6.0 shipped March 2026 as the last JS-based compiler; **`6.0.3` (2026-04-16) is the
final 6.0 patch**, and the 6.0 line now receives security patches only. So jawbong's `6.0.3` is
*current for its line*, not stale.

**Decision A-3b (confidence: high, reversibility: easy).** Pin `typescript@6.0.3`.
**Rejected:** `7.0.2` as the sole compiler — it silently disables the lint gate.
**Optional, additive, low-risk:** add `tsgo` as a *second, non-authoritative* fast typecheck
script (`"typecheck:fast": "tsgo --noEmit"`) for local inner-loop speed, while `tsc --noEmit`
stays the CI gate. **What would change this:** TypeScript 7.1 shipping the stable programmatic
API *and* `typescript-eslint` publishing a release that consumes it. Re-evaluate at M2.

### 3.4 Prisma — `latest` is a release candidate. Pin explicitly.

Fetched `registry.npmjs.org/-/package/prisma/dist-tags` on 2026-09-09:

```json
{
  "prev": "7.10.0",
  "latest": "8.0.0-rc.13",
  "next": "8.0.0-rc.10",
  "dev": "8.0.0-rc.13-dev.94"
}
```

Confirmed by fetching `registry.npmjs.org/prisma/latest` → `"version": "8.0.0-rc.13"`,
`"engines": { "node": ">=22.18.0" }`.

**CORRECTION (review pass).** The first draft stated that a naive scaffold "could put
`prisma@8.0.0-rc.13` **and `@prisma/client@8.0.0-rc.13`** into a production lockfile." That is
**wrong, and the truth is more dangerous.** The three packages do **not** share a `latest` tag:

```
prisma              dist-tags: latest = 8.0.0-rc.13   prev = 7.10.0
@prisma/client      dist-tags: latest = 7.10.0        prev = 6.19.3   dev = 8.1.0-dev.6
@prisma/adapter-pg  dist-tags: latest = 7.10.0        prev = 6.19.3   dev = 8.1.0-dev.6
```

So `pnpm add prisma @prisma/client @prisma/adapter-pg` resolves to
**`prisma@8.0.0-rc.13` + `@prisma/client@7.10.0` + `@prisma/adapter-pg@7.10.0`** — a **major-version
mismatch between the CLI and the runtime client**, which Prisma requires to be identical. The
failure mode is not "we shipped an RC"; it is "the generator that writes `src/generated/prisma` is
a major ahead of the library that reads it," which surfaces as generated-client type errors or
runtime engine-protocol errors rather than as an obvious version warning. That is materially worse
than the uniform-RC scenario the first draft described, because it is harder to recognise.

**This is a live footgun.** The house `.npmrc` sets `save-exact=true`, which means
`pnpm add prisma` writes the *resolved* version into `package.json` — and the resolved version
today is a **release candidate**.

**Second correction — the supply-chain delay window does not exist.** The first draft speculated
that jawbong's `minimumReleaseAgeExclude` list "implies a global `minimumReleaseAge` is configured
somewhere in the pnpm settings." It is not. Verified in the review pass:

```
$ cat ~/.npmrc              → No such file or directory
$ cat ~/.config/pnpm/rc     → No such file or directory
$ cat ~/Documents/jawbong/.npmrc
engine-strict=false
save-exact=true
$ grep -n minimumReleaseAge ~/Documents/jawbong/pnpm-workspace.yaml
minimumReleaseAgeExclude:      # ← the exclude list exists…
  - dependency-cruiser@18.1.1
  - tsx@4.23.5
                               # …but minimumReleaseAge itself is set NOWHERE
```

An exclude list with nothing to exclude *from* is inert. jawbong therefore has **zero** delay
between a package being published and it being installable — which is precisely the window that
npm account-takeover and post-install-script attacks exploit.

**Decision A-12 (confidence: high, reversibility: easy).** Set `minimumReleaseAge` explicitly in
`pnpm-workspace.yaml`, and keep the exclude list for packages we deliberately want early:

```yaml
# Do not install any version published less than 7 days ago. This is the single
# cheapest supply-chain control available to us: it does not stop a malicious
# publish, it stops us being among the first to install one, which is when
# compromised packages are still unrevoked.
minimumReleaseAge: 10080        # minutes = 7 days
minimumReleaseAgeExclude:
  - "@prisma/*"                 # security patches to the DB layer: take immediately
  - "next"                      # ditto — see §3.2
```

**Rejected:** leaving it unset because jawbong does (copies a hole); a 30-day window (would have
blocked `next@16.3.4`'s security fixes for a month). **What would change this:** if the delay ever
blocks an actively-exploited CVE fix, add that package to the exclude list *in the same commit as
the upgrade*, never by disabling the setting.

**Decision A-4 (confidence: high, reversibility: easy).** Write the exact versions into
`package.json` by hand and install with `--frozen-lockfile`:

```json
"@prisma/adapter-pg": "7.10.0",
"@prisma/client": "7.10.0",
"prisma": "7.10.0",
"pg": "8.23.0"
```

**RESOLVED (review pass).** The first draft carried this as `UNVERIFIED:`. Both packages exist at
7.10.0 and are in fact each package's own `latest` tag — `@prisma/client@7.10.0` declares
`engines.node: "^20.19 || ^22.12 || >=24.0"` and `peerDependencies: { "prisma": "*", "typescript":
">=5.4.0" }`. Note that the `prisma` peer is the permissive `"*"`, which is exactly **why the
CLI/client mismatch above installs silently instead of erroring.** The lockstep must be enforced by
us, not by npm.

**Add a CI assertion so the lockstep cannot silently break:**

```jsonc
// package.json — belt and braces alongside the exact pins
"pnpm": {
  "overrides": {
    "prisma": "7.10.0",
    "@prisma/client": "7.10.0",
    "@prisma/adapter-pg": "7.10.0"
  }
}
```

and a one-line CI gate before `db:generate`:

```bash
node -e '
  const p = require("./package.json");
  const v = new Set([p.devDependencies.prisma,
                     p.dependencies["@prisma/client"],
                     p.dependencies["@prisma/adapter-pg"]]);
  if (v.size !== 1) { console.error("Prisma CLI/client/adapter version drift:", [...v]); process.exit(1); }
'
```

**Rejected:** tracking `latest` (installs an RC); jumping to Prisma 8 GA when it lands during M1
(a major DB-layer version change mid-milestone is exactly the kind of avoidable risk the phase
gates exist to prevent). **What would change this:** Prisma 8.0.0 reaching GA *and* M1 being
closed out; then evaluate 8.x at the M2 boundary.

### 3.5 Vitest — a genuine judgement call, stated as a gate not a guess

`latest: 5.0.0`, `V4: 4.1.11`, `V3: 3.2.7`. Vitest 5.0.0 is a brand-new major.

For a greenfield there is **no migration cost** to starting on 5.x, and starting on 4.x buys a
forced migration in roughly six months. The risk is not the core runner; it is the satellites —
`@vitest/coverage-v8`, `@testing-library/react` + `@testing-library/jest-dom`, and `jsdom` — whose
5.x peer ranges the first draft could not verify.

**RESOLVED (review pass) — the gate now passes.** All four were fetched:

```
vitest@5.0.0
  engines: { node: "^22.12.0 || ^24.0.0 || >=26.0.0" }
  peerDependencies (relevant): jsdom "*", @vitest/coverage-v8 "5.0.0",
                               @types/node "^22.0.0 || >=24.0.0", vite "^6.4.0 || ^7.0.0 || ^8.0.0"

@vitest/coverage-v8@5.0.0
  peerDependencies:     { vitest: "5.0.0", "@vitest/browser": "5.0.0" }
  peerDependenciesMeta: { "@vitest/browser": { optional: true } }      ← not required

@testing-library/react@16.3.3
  peerDependencies: { react: "^18.0.0 || ^19.0.0", react-dom: "^18.0.0 || ^19.0.0",
                      "@types/react": "^18.0.0 || ^19.0.0", "@types/react-dom": "^18.0.0 || ^19.0.0",
                      "@testing-library/dom": "^10.0.0" }              ← vitest-agnostic

jsdom@30.0.1
  engines: { node: "^22.22.2 || ^24.15.0 || >=26.0.0" }                ← vitest-agnostic
```

Three conclusions the first draft could not reach:

1. **Nothing blocks `vitest@5.0.0`.** `@testing-library/*` and `jsdom` do not peer on vitest at
   all; `@vitest/browser` is an *optional* peer of the coverage provider.
2. **`@vitest/coverage-v8` pins vitest to the exact string `5.0.0`**, not a range. When vitest
   publishes `5.0.1`, the coverage provider must be bumped in the same commit or the peer breaks.
   Pin them together, always, and put them adjacent in `package.json` so it is visible.
3. **`@testing-library/dom@^10` is a required peer** of `@testing-library/react`. jawbong satisfies
   it with an explicit `"@testing-library/dom": "10.4.1"` devDependency — under pnpm's strict
   resolution it must be a *direct* dependency, it is not hoisted for free. Copy that line.

**Decision A-9 (confidence: high — upgraded from medium, reversibility: easy).** Pin
**`vitest@5.0.0` + `@vitest/coverage-v8@5.0.0`**, keeping the scaffold gate as a cheap
double-check rather than as the deciding step:

> At scaffold, run `pnpm add -D vitest@5.0.0 @vitest/coverage-v8@5.0.0 @testing-library/react@16.3.3
> @testing-library/dom@10.4.1 @testing-library/jest-dom@7.0.0 jsdom@30.0.1`. If **any**
> peer-dependency warning or resolution failure appears, fall back to `vitest@4.1.11` +
> `@vitest/coverage-v8@4` and record the reason in `process/context/tests/all-tests.md`.

**Rejected:** blindly copying jawbong's `4.1.10` (stale even within its own line — `4.1.11`
exists); *also* copying jawbong's omission of `@vitest/coverage-v8` altogether, which leaves
`vitest.config.ts`'s `coverage.reporter` setting unusable. **What would change this:** the gate
above, evaluated mechanically at scaffold.

### 3.6 ESLint — stay on 9.x, but not for the reason the first draft gave

`latest: 10.10.0`, `maintenance: 9.39.5`. jawbong pins `9.39.5`. The first draft asserted the
blocker was "`eslint-config-next@16.3.4`'s peer range and `eslint-plugin-boundaries@7.1.0`'s
flat-config compatibility with ESLint 10, neither of which I verified."

**CORRECTION (review pass): both of the named blockers are non-blockers. The real cap is a
transitive dependency the first draft never looked at.** Fetched 2026-09-09:

| Package | eslint peer range | Accepts ESLint 10? |
|---|---|---|
| `eslint-config-next@16.3.4` | `>=9.0.0` | ✅ yes |
| `eslint-plugin-boundaries@7.2.0` | `>=6.0.0` | ✅ yes |
| `typescript-eslint@8.70.0` *(a direct dep of eslint-config-next)* | `^8.57.0 \|\| ^9.0.0 \|\| ^10.0.0` | ✅ yes |
| `eslint-plugin-react-hooks@7.1.1` *(dep of eslint-config-next)* | `… \|\| ^9.0.0 \|\| ^10.0.0` | ✅ yes |
| **`eslint-plugin-import@2.32.0`** *(dep of eslint-config-next)* | `^2 \|\| ^3 \|\| ^4 \|\| ^5 \|\| ^6 \|\| ^7.2.0 \|\| ^8 \|\| ^9` | ❌ **no — stops at `^9`** |

`eslint-config-next@16.3.4` declares `"eslint-plugin-import": "^2.32.0"` as a **dependency**, so
the cap is inherited whether we want it or not. Installing `eslint@10.10.0` produces an unmet peer
on `eslint-plugin-import`. Under pnpm's defaults that is a **warning, not a failure** — which is
exactly why this must be decided deliberately now rather than discovered as a confusing lint crash
later.

**Decision A-10 (confidence: high — upgraded from medium, reversibility: easy).** Pin
`eslint@9.39.5`, matching jawbong. The conclusion is unchanged; the *reason* is now correct and
the *gate* is now specific enough to evaluate mechanically:

> Re-check at the M1 boundary with `pnpm view eslint-plugin-import peerDependencies`. When its
> eslint range includes `^10` — **or** when `eslint-config-next` drops or replaces it (the
> `eslint-plugin-import` → `eslint-plugin-import-x` migration is the likely route) — upgrade
> `eslint` to the 10.x line in one commit. Nothing else in the chain is holding us back.

**Rejected:** shipping ESLint 10 today and suppressing the peer warning with
`strict-peer-dependencies=false` — it would silence *every* future peer warning too, which is a
supply-chain regression for one minor-version gain. Also **rejected:** jawbong's `7.1.0` pin for
`eslint-plugin-boundaries`; `7.2.0` is current and its peer range is unchanged.

### 3.7 The complete recommended `package.json` core

The first draft labelled this "core" and listed only 17 packages. That is too few to scaffold
from: it omitted every `@types/*` package (including the **blocking** `@types/node`), the whole
`@testing-library` set, `jsdom`, `tsx` (which every `db:*` script in jawbong invokes), `prettier`
(which CI gates on via `format:check`), and `@vitest/coverage-v8`. **The complete list:**

```json
{
  "packageManager": "pnpm@12.3.4",
  "engines": { "node": ">=24.21.0 <25", "pnpm": ">=12.3.4 <13" },
  "dependencies": {
    "@prisma/adapter-pg": "7.10.0",
    "@prisma/client": "7.10.0",
    "next": "16.3.4",
    "pg": "8.23.0",
    "react": "19.2.8",
    "react-dom": "19.2.8",
    "zod": "4.5.4"
  },
  "devDependencies": {
    "@playwright/test": "1.63.0",
    "@tailwindcss/postcss": "4.3.3",
    "@testing-library/dom": "10.4.1",
    "@testing-library/jest-dom": "7.0.0",
    "@testing-library/react": "16.3.3",
    "@testing-library/user-event": "14.6.1",
    "@types/node": "24.x",
    "@types/pg": "8.20.3",
    "@types/react": "19.2.18",
    "@types/react-dom": "19.2.4",
    "@vitest/coverage-v8": "5.0.0",
    "dependency-cruiser": "18.2.0",
    "eslint": "9.39.5",
    "eslint-config-next": "16.3.4",
    "eslint-plugin-boundaries": "7.2.0",
    "jsdom": "30.0.1",
    "prettier": "3.9.6",
    "prisma": "7.10.0",
    "tailwindcss": "4.3.3",
    "tsx": "4.23.5",
    "typescript": "6.0.3",
    "vitest": "5.0.0"
  }
}
```

Resolve `"@types/node": "24.x"` to an exact patch at scaffold (`pnpm view @types/node@24 version`)
— it is written as a range here only because the exact 24-line patch will have moved by the time
anyone runs this. **It must track the Node major, not float independently.**

**On `engines`.** jawbong writes an exact string (`"node": "22.23.1"`). This document deliberately
widens it to `">=24.21.0 <25"`. Exact-pinning `engines.node` means a developer who takes the
Node 24.21.1 *security* patch trips an engine warning on every install, which trains people to
ignore engine warnings — the opposite of the intent. The **exact** version still lives in `.nvmrc`,
`.node-version`, the CI `setup-node` input, and the Dockerfile `FROM` line, which is where
reproducibility actually comes from. **Rejected:** copying jawbong's exact-string form (trains
warning-blindness); dropping `engines` entirely (loses the major-version floor). **What would
change this:** if `engine-strict` is ever turned on, revisit — under `engine-strict=true` an exact
pin becomes a hard failure and the trade-off inverts.

Plus, adapted from jawbong: `.npmrc` = `engine-strict=false` + `save-exact=true`;
`.nvmrc` and `.node-version` both containing `24.21.0`; `pnpm-workspace.yaml` with
`packages: ["."]`, the `allowBuilds` list (`@prisma/engines`, `esbuild`, `prisma`, `sharp`,
`unrs-resolver` — note `sharp` is already allow-listed there, which we will want for image
preprocessing), **and the `minimumReleaseAge` setting from §3.4 that jawbong is missing**.

`.gitignore` must include `.DS_Store` (§1) alongside jawbong's `.env*` / `!.env.example` rules.

---

## 4. The layering contract — quoted from the real configs, then extended

This is the highest-value thing to inherit. Two independent enforcers guard the same rules, so a
mistake in one config does not silently open the boundary.

### 4.1 dependency-cruiser — `~/Documents/jawbong/dependency-cruiser.config.mjs` (verbatim)

```js
const dependencyCruiserConfig = {
  forbidden: [
    {
      name: "domain-is-framework-free",
      severity: "error",
      comment: "Domain code cannot depend on React, Next.js, or Prisma.",
      from: { path: "(^|/)src/modules/[^/]+/domain" },
      to: {
        path: "^(next|react|@prisma)(/|$)|(^|/)src/generated/prisma|(^|/)src/modules/[^/]+/infrastructure",
      },
    },
    { name: "application-is-transport-free",    severity: "error",
      from: { path: "(^|/)src/modules/[^/]+/application" },
      to:   { path: "(^|/)src/app" } },
    { name: "application-is-infrastructure-free", severity: "error",
      from: { path: "(^|/)src/modules/[^/]+/application" },
      to:   { path: "(^|/)src/modules/[^/]+/infrastructure" } },
    { name: "infrastructure-is-transport-free", severity: "error",
      from: { path: "(^|/)src/modules/[^/]+/infrastructure" },
      to:   { path: "(^|/)src/app" } },
    { name: "no-circular", severity: "error", from: {}, to: { circular: true } },
  ],
  options: {
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: { exportsFields: ["exports"] },
    doNotFollow: { path: "node_modules" },
    exclude: "(^|/)generated/|\\.(test|spec)\\.[cm]?[jt]sx?$",
  },
};
export default dependencyCruiserConfig;
```

### 4.2 eslint-plugin-boundaries — `~/Documents/jawbong/eslint.config.mjs` (the boundary block, verbatim)

```js
settings: {
  "boundaries/elements": [
    { type: "app",            pattern: "src/app/**" },
    { type: "domain",         pattern: "src/modules/*/domain/**" },
    { type: "application",    pattern: "src/modules/*/application/**" },
    { type: "infrastructure", pattern: "src/modules/*/infrastructure/**" },
    { type: "lib",            pattern: "src/lib/**" },
  ],
},
rules: {
  "boundaries/dependencies": ["error", {
    default: "allow",
    policies: [
      { from: { element: { type: "domain" } },
        disallow: { to: { element: { types: { anyOf: ["app", "infrastructure"] } } } } },
      { from: { element: { type: "application" } },
        disallow: { to: { element: { types: { anyOf: ["app", "infrastructure"] } } } } },
      { from: { element: { type: "infrastructure" } },
        disallow: { to: { element: { type: "app" } } } },
    ],
  }],
},
```

plus a belt-and-braces `no-restricted-imports` scoped to domain files only:

```js
{
  files: ["src/modules/*/domain/**/*.{ts,tsx}"],
  rules: {
    "no-restricted-imports": ["error",
      { patterns: ["next", "next/*", "react", "react/*", "@prisma/*"] }],
  },
},
```

### 4.3 The rule set, stated in prose (from `docs/architecture/adr-001-modular-monolith.md`)

> "Use one Next.js App Router application at the repository root. `src/app` owns
> transport/composition; each `src/modules/{domain}` separates domain, application, and
> infrastructure. Domain code has no React, Next.js, or Prisma dependency. Cross-module work
> uses explicit application interfaces or versioned events."

### 4.4 The OCR extension: a **sixth** element type, `workers`

**Count correction (review pass).** The first draft called `workers` "a 4th element" in the
executive summary and "a fifth element type" here. Both were wrong, and they disagreed with each
other. jawbong's `boundaries/elements` array (quoted verbatim in §4.2) already declares **five**
elements — `app`, `domain`, `application`, `infrastructure`, `lib` — so `workers` is the **sixth**.
The number matters only because anyone editing `eslint.config.mjs` by index will otherwise mis-place
the entry.

OCR needs a **long-running process outside the request/response lifecycle** (see §5). Next's
App Router cannot host it: a worker that holds a lease for 60+ seconds per page cannot live
inside a serverless-shaped route handler, and the house pattern already avoids in-process
schedulers (see §8.3 — krs-pos drives its dispatcher with an external poll sidecar, not a
`setInterval`).

> **Scope note.** `src/workers/**` is the *TypeScript* worker element and the boundary rule that
> governs it. Whether the OCR worker is written in TypeScript at all is **not** this document's
> decision — `h-queue-and-worker-contract.md` (L2, L8) specifies a **Python** worker connecting to
> Postgres as its own `ocr_worker` role, and `m-docker-nginx-resources.md` (O5) builds it from
> `python:3.13-slim-bookworm`. Those supersede any implication here that the worker is Node. The
> `workers` element remains correct and worth adding regardless: even with a Python OCR worker there
> will be TypeScript-side long-running composition (the outbox drain, scheduled cleanup, retention
> sweeps) that must not live in `src/app`.

**Decision A-5 (confidence: high, reversibility: moderate).** Add `src/workers/**` as a sixth
element with these rules:

| From | May import | Must not import |
|---|---|---|
| `workers` | `application`, `infrastructure`, `lib`, `domain` | `app` |
| `app` | `application`, `lib` | `workers` |

Concretely, add to `dependency-cruiser.config.mjs`:

```js
{ name: "workers-are-transport-free", severity: "error",
  from: { path: "(^|/)src/workers" },
  to:   { path: "(^|/)src/app" } },
{ name: "app-does-not-import-workers", severity: "error",
  from: { path: "(^|/)src/app" },
  to:   { path: "(^|/)src/workers" } },
```

and to `eslint.config.mjs` settings: `{ type: "workers", pattern: "src/workers/**" }` with a
matching mutual-disallow policy pair.

`workers` is the *only* element besides `app` that is allowed to compose `application` +
`infrastructure` — that is what "composition root" means, and OCR has two of them.

**Rejected:** (a) putting the worker loop inside a Next route handler triggered by cron — this is
exactly what krs-pos does and it works, but it couples worker lifetime to HTTP request timeouts,
which is fine for a 200 ms KRS insert and wrong for a 90 s page OCR; (b) a separate repository
for the worker — loses the shared domain types and the single migration owner, and contradicts
ADR-001. **What would change this:** if M1 discovers that every OCR unit of work reliably
completes in well under the platform's request timeout, the cron-sidecar-hits-HTTP-endpoint
pattern becomes viable and `src/workers` can collapse into `src/app/api/internal/*`. Decide at
M1, not now.

### 4.5 The boundary test that makes the contract real

`~/Documents/jawbong/tests/unit/module-boundaries.test.ts` is worth copying because it does the
thing most boundary setups forget — it asserts the enforcer **actually fails** on a known-bad
fixture, not just that it passes on the current tree:

```ts
it("rejects a known forbidden domain dependency", () => {
  const result = spawnSync("corepack",
    ["pnpm@11.18.0", "exec", "depcruise", "tests/fixtures/boundaries",
     "--config", "dependency-cruiser.config.mjs"], { encoding: "utf8" });
  expect(result.status).not.toBe(0);
  expect(`${result.stdout}\n${result.stderr}`).toContain("domain-is-framework-free");
}, 20_000);
```

The fixture tree lives at `tests/fixtures/boundaries/src/modules/example/domain/invalid-infrastructure.ts`
and is `globalIgnores`d in eslint so it does not poison the main lint run.

---

## 5. Outbox / idempotency prior art — and why it is **not** our job queue

### 5.1 The exact table shapes (`~/Documents/jawbong/prisma/schema.prisma`, verbatim)

```prisma
enum OutboxStatus { PENDING PROCESSING PROCESSED FAILED }

model OutboxEvent {
  id            String       @id @db.Uuid
  eventType     String       @map("event_type") @db.VarChar(160)
  eventVersion  Int          @default(1) @map("event_version")
  aggregateId   String       @map("aggregate_id") @db.VarChar(160)
  payload       Json         @db.JsonB
  status        OutboxStatus @default(PENDING)
  occurredAt    DateTime     @default(now()) @map("occurred_at")   @db.Timestamptz(3)
  availableAt   DateTime     @default(now()) @map("available_at")  @db.Timestamptz(3)
  claimedAt     DateTime?    @map("claimed_at")   @db.Timestamptz(3)
  claimUntil    DateTime?    @map("claim_until")  @db.Timestamptz(3)
  processedAt   DateTime?    @map("processed_at") @db.Timestamptz(3)
  attempts      Int          @default(0)
  lastError     String?      @map("last_error") @db.VarChar(1000)
  createdAt     DateTime     @default(now())  @map("created_at") @db.Timestamptz(3)
  updatedAt     DateTime     @updatedAt       @map("updated_at") @db.Timestamptz(3)

  @@index([status, availableAt], map: "outbox_event_status_available_idx")
  @@index([claimUntil],          map: "outbox_event_claim_until_idx")
  @@map("outbox_events")
}

model IdempotencyRecord {
  id           String   @id @db.Uuid
  scope        String   @db.VarChar(160)
  key          String   @db.VarChar(200)
  requestHash  String   @map("request_hash") @db.VarChar(128)
  response     Json?    @db.JsonB
  responseCode Int?     @map("response_code")
  expiresAt    DateTime @map("expires_at") @db.Timestamptz(3)
  createdAt    DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt    DateTime @updatedAt      @map("updated_at") @db.Timestamptz(3)

  @@unique([scope, key], map: "idempotency_scope_key_key")
  @@index([expiresAt],   map: "idempotency_expires_at_idx")
  @@map("idempotency_records")
}
```

The migration (`prisma/migrations/20260803000000_phase_00_foundation/migration.sql`) adds one
thing the Prisma model cannot express, and it is worth keeping:

```sql
CONSTRAINT "outbox_attempts_nonnegative" CHECK ("attempts" >= 0)
```

### 5.2 How claims and leases actually work — **it is poll-based**

`src/modules/outbox/infrastructure/prisma-outbox-repository.ts`, `claimAvailable`, verbatim core:

```ts
const leaseUntil = new Date(input.now.getTime() + input.leaseMs);
return this.prisma.$transaction(async (transaction) => {
  const rows = await transaction.$queryRaw<ClaimedRow[]>`
    SELECT id, event_type, event_version, aggregate_id, payload,
           occurred_at, available_at, attempts
    FROM outbox_events
    WHERE available_at <= ${input.now}
      AND ( status = 'PENDING'
            OR (status = 'PROCESSING' AND claim_until < ${input.now}) )
    ORDER BY occurred_at ASC
    LIMIT ${input.limit}
    FOR UPDATE SKIP LOCKED
  `;
  const ids = rows.map((row) => row.id);
  if (ids.length > 0) {
    await transaction.outboxEvent.updateMany({
      where: { id: { in: ids } },
      data: { status: "PROCESSING", claimedAt: input.now,
              claimUntil: leaseUntil, attempts: { increment: 1 } },
    });
  }
  return rows.map((row) => toClaimedEvent({ ...row, attempts: row.attempts + 1 }));
});
```

Answering the brief's question precisely:

- **Poll-based: yes.** There is no `LISTEN/NOTIFY`, no queue broker. `OutboxWorker.runOnce()`
  performs one claim-and-drain pass; something external must call it on a schedule.
- **Claims:** `SELECT ... FOR UPDATE SKIP LOCKED` inside a transaction, then `updateMany` on the
  selected ids. Concurrent workers get disjoint sets.
- **Leases:** `claim_until = now + leaseMs`. A row is re-claimable when
  `status = 'PROCESSING' AND claim_until < now` — i.e. crash recovery is lease-expiry based.
- **Guardrails:** `limit` must be 1..100, `leaseMs` must be 1000..900000, both enforced with
  thrown errors before the query runs.
- **Defaults** (`OutboxWorker` constructor): `batchSize: 10, leaseMs: 30_000, maxAttempts: 5`.
- **Backoff** (`domain/outbox-event.ts`): `Math.min(capMs, baseMs * 2 ** Math.min(attempt - 1, 20))`
  with `baseMs = 1_000`, `capMs = 300_000` — i.e. 1 s, 2 s, 4 s, … capped at 5 minutes.
- **Terminal failure:** `terminal = event.attempts >= maxAttempts` → `status: "FAILED"`, row
  stays queryable (no delete).
- **Error redaction:** the worker stores `error.name` only, never the message —
  `const safeError = error instanceof Error ? error.name : "UnknownError";` and `reschedule`
  truncates with `.slice(0, 1000)`.
- **Attempts are incremented at claim time, not at failure time.** A worker that dies mid-lease
  burns an attempt. Good against poison pills; harsh on transient infrastructure blips.

**Two further properties the first draft missed, both of which are disqualifying for OCR:**

**(a) The lease covers the whole batch, but the batch is drained serially.** `OutboxWorker.runOnce()`
is a plain `for…of` with `await` inside:

```ts
for (const event of events) {
  try {
    await this.handler(event);              // ← serial. Event 10 starts after events 1-9 finish.
    await this.repository.markProcessed(event.id, this.clock.now());
```

`claimAvailable` stamps **one** `claim_until = now + leaseMs` across all `batchSize` rows at claim
time. So the effective lease available to the *last* item in a batch is not `leaseMs`, it is:

```
lease_budget(last item) = leaseMs − Σ(duration of the preceding batchSize−1 items)
```

With jawbong's defaults (`batchSize: 10`, `leaseMs: 30_000`), the batch survives only if
**mean per-item duration < 3 s** (30 000 ms / 10). A domain-event handler comfortably clears that.
A page OCR does not: at 90 s/page the 1st item alone blows a 30 s lease by 3×, and by the time the
worker reaches item 2 every remaining row in its own batch is already re-claimable by a second
worker. **The result is not a slowdown, it is silent duplicate execution of the entire batch tail** —
and because completion is unguarded (§5.3(1)) the duplicates then overwrite each other.

This is the arithmetic that must govern the `ocr_jobs` design. Any of three shapes fixes it; the
first draft named only the third:

| Fix | Mechanism | Cost |
|---|---|---|
| `batchSize = 1` | One row per claim; lease covers exactly one unit of work | More claim round-trips (irrelevant at OCR's job rate — seconds to minutes per job) |
| Per-item lease stamp | Re-stamp `claim_until` immediately before each item is handled | Still leaves the *in-flight* item unprotected past `leaseMs` |
| **Heartbeat** | Background timer extends the lease every `leaseMs/3` while work is in progress | Needs a fencing token to be safe — see §5.5 and `h-queue-and-worker-contract.md` L4 |

`h-queue-and-worker-contract.md` L4 selects a **120 s lease with a 30 s heartbeat**, which satisfies
the inequality above for any per-page duration. This document's role is to record *why* the jawbong
defaults cannot simply be copied.

**(b) A single un-parseable payload row deadlocks the whole queue, forever.** `claimAvailable`
re-validates every claimed row through the Zod schema **inside** the transaction:

```ts
return this.prisma.$transaction(async (transaction) => {
  const rows = await transaction.$queryRaw<ClaimedRow[]>` … `;
  …
  return rows.map((row) => toClaimedEvent({ ...row, attempts: row.attempts + 1 }));
  //              ^^^^^^^^^^^^^^^ calls outboxEventInputSchema.parse(...) — can throw
});
```

If `parse` throws — a payload written before a schema change, a `payload` that is a JSON array
rather than an object (the schema is `z.record(z.string(), z.unknown())`, so arrays and scalars are
rejected), an `eventType` that grew past 160 chars — the throw propagates out of the `$transaction`
callback and **the whole transaction rolls back, including the `attempts` increment**. The row
returns to `PENDING` with its attempt count unchanged, is the oldest row by `occurred_at`, and is
therefore re-claimed first on the very next pass. It can never reach `maxAttempts`, so it can never
become terminal `FAILED`.

The consequence is worse than one stuck row: because the failing `parse` aborts the whole batch,
**every other row claimed alongside it is rolled back too**. One malformed row halts the queue
permanently and no `attempts` counter ever moves to reveal it.

For OCR this is directly reachable, not theoretical: payloads will carry user-controlled filenames
and tenant-supplied metadata, and `aggregateId` is capped at `VarChar(160)`. **The `ocr_jobs`
claim must validate per row, quarantine a row that fails validation (a terminal state reached
*without* consuming an attempt slot), and never let one bad row abort the batch.** Compare
`h-queue-and-worker-contract.md` L14, which reaches the same requirement from the page-poison
direction.

### 5.3 Two real limitations, quoted

**(1) Completion is not lease-guarded.** `markProcessed` and `reschedule` are plain updates by
primary key:

```ts
async markProcessed(id: string, processedAt: Date): Promise<void> {
  await this.prisma.outboxEvent.update({
    where: { id },
    data: { status: "PROCESSED", processedAt, claimedAt: null,
            claimUntil: null, lastError: null },
  });
}
```

There is no `WHERE claim_until > now()` guard. A worker whose lease expired while it was still
running will, on completion, overwrite the state of whichever worker re-claimed the row. The
mitigation is stated as a contract, not enforced by the code — ADR-005: *"Handlers must be
idempotent."* For OCR, where a handler writes extracted text and possibly spends money on a
model call, "handlers must be idempotent" needs to be backed by an actual guard.

**(2) There is no result column.** `OutboxEvent` carries an input `payload` and nothing else.
An OCR job needs to record *output*: page text, confidence, bounding boxes or an artifact
pointer, engine identity, token/cost accounting, and duration. There is nowhere to put it.

**(3) `hashIdempotencyRequest` is key-order dependent, so the replay guard silently fails.**
Verbatim, `src/modules/outbox/infrastructure/prisma-idempotency-repository.ts`:

```ts
export function hashIdempotencyRequest(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
```

`JSON.stringify` serialises object keys in **insertion order**, not sorted order. Two semantically
identical requests — `{"docId":"a","lang":"tha"}` and `{"lang":"tha","docId":"a"}` — hash
differently. Since `requestHash` is what distinguishes "this is the same request, return the cached
response" from "this key is being reused for a *different* request, reject it", the practical
effect is that a genuine retry whose JSON body was re-serialised by a different client, proxy, or
SDK version is treated as a **key-reuse conflict**, and a real key-reuse attack is treated as a
retry whenever the attacker happens to match key order. The first draft told us to copy this
function verbatim. **Do not.** The fix is one function:

```ts
// Canonical JSON: keys sorted at every depth, arrays order-preserved (order is semantic
// in an array, not in an object). Thai text is normalised first — see §5.6, because
// two byte-different Thai strings can be the same string to a human and to the OCR engine.
function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonicalise((value as Record<string, unknown>)[k])]),
    );
  }
  if (typeof value === "string") return normaliseThai(value);   // §5.6
  return value;
}

export function hashIdempotencyRequest(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalise(payload))).digest("hex");
}
```

**(4) `IdempotencyRecord` is reserve-only — the response cache is never written.** The repository
has exactly two methods:

```ts
async reserve(input: { scope; key; requestHash; expiresAt }) { … create … }
async find(scope: string, key: string) { … findUnique … }
```

There is **no `complete()`**, so the `response` and `responseCode` columns — the entire point of an
idempotency *record* as opposed to an idempotency *lock* — are declared in the schema and never
populated. As shipped, jawbong's implementation can answer "has this key been used?" but not
"…and what did we return last time?", which means a client retrying after a dropped connection gets
a conflict rather than the original result.

For OCR this matters more than it does for jawbong, because the retried operation may be one that
**already spent money** on a model call. Add the missing method, and write it in the same
transaction that commits the operation's effects:

```ts
async complete(scope: string, key: string, response: unknown, responseCode: number) { … }
```

Also note `reserve` relies on the `@@unique([scope, key])` constraint to serialise concurrent
first-attempts: the loser gets a Prisma `P2002` and must be translated into "another request with
this key is in flight → 409", never into a 500. That mapping does not exist in jawbong either.

### 5.4 The better claim, from the *other* house project

`/Users/innovera/Claude/Projects/POS/src/lib/krs/dispatcher.ts` (krs-pos) does the claim as a
**single atomic statement** rather than select-then-update, with a documented rationale:

```ts
async function claimJobs(): Promise<string[]> {
  const staleBefore = new Date(Date.now() - LOCK_STALE_MS);
  const now = new Date();
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE "SyncJob"
       SET "lockedAt" = NOW(),
           "status"   = ${SyncJobStatus.RETRYING}::"SyncJobStatus",
           "updatedAt" = NOW()
     WHERE id IN (
       SELECT id FROM "SyncJob"
        WHERE "type"   IN (${SyncJobType.SALE}::"SyncJobType", ${SyncJobType.VOID}::"SyncJobType")
          AND "status" IN (${SyncJobStatus.PENDING}::"SyncJobStatus", ${SyncJobStatus.RETRYING}::"SyncJobStatus")
          AND ("lockedAt" IS NULL OR "lockedAt" < ${staleBefore})
          AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= ${now})
        ORDER BY "createdAt" ASC
        LIMIT ${BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
     )
    RETURNING id
  `;
  return rows.map((r) => r.id);
}
```

with the comment: *"One atomic statement under READ COMMITTED — no TOCTOU window."*
`LOCK_STALE_MS = 10 * 60 * 1000` (10 minutes) — twenty times jawbong's 30 s lease, because a KRS
write can genuinely take minutes.

**krs-pos also uses different retry constants, and they are the better starting point for OCR**
(the first draft quoted only jawbong's). Verbatim from `dispatcher.ts`:

```ts
const BATCH_SIZE     = 10;
const MAX_ATTEMPTS   = 5;
const BASE_DELAY_MS  = 30_000;      // 30 s, vs jawbong's 1 s
const MAX_DELAY_MS   = 3_600_000;   // 1 h,  vs jawbong's 5 min
// nextAttemptAt = now + min(BASE * 2^attempts, MAX)
```

A 1 s base (jawbong) suits an in-process event handler that fails fast. A 30 s base with a 1 h cap
suits work that fails because an *external system* is unavailable — which is exactly the OCR
failure mode, whether the external system is the AI gateway or a saturated worker pool. Note also
that **neither project applies jitter**; `h-queue-and-worker-contract.md` L13 adds full jitter, and
is right to — without it, N jobs that fail against the same outage retry in lockstep and re-create
the outage.

**And one hard-won limitation that must be carried forward with the pattern.** The krs-pos
dispatcher documents its own residual risk in the file header, verbatim:

> *"DISPATCH RUN-LOCK: runDispatch relies on per-job FOR UPDATE SKIP LOCKED + lockedAt to prevent
> two workers claiming the SAME job. It does NOT have an app-level singleton run-lock (unlike
> runAutoSync, autoSync.ts:116-150). The alive-but-slow double-write risk (crash-window 9) is
> mitigated by the UNIQUE constraint on KRS.SalesInvoiceHdr.TransactionNo (pre-enable gate). A
> batch-level run-lock is recommended defense-in-depth."*

The safety of the krs-pos claim therefore rests partly on a **unique constraint in the destination
system**, not on the claim alone. OCR has no equivalent free uniqueness: writing extracted text
twice is not rejected by anything. So copying the krs-pos claim shape without also copying a
fencing mechanism inherits the pattern's known gap. This is the concrete reason §5.5(4) below is
non-negotiable rather than a nicety.

krs-pos's `SyncJob` model also carries what the outbox lacks:

```prisma
payload        Json?
idempotencyKey String?   @unique   // "<orderNumber>_<jobType>"
attempts       Int       @default(0)
lastError      String?
nextAttemptAt  DateTime?           // retry gate: null = eligible now
lockedAt       DateTime?           // dispatch lock; stale lock re-claimable
```

**And it carries a hard-won starvation lesson that applies directly to OCR.** Verbatim comment:

> *"Held bills MUST NOT stay immediately eligible: the claim query is `ORDER BY createdAt ASC
> LIMIT 10`, so instantly-requeued held bills monopolize every batch and STARVE the clean bills
> behind them (16-07-26 incident: zero-discount sales never reached KRS because the 10 oldest
> held bills were re-claimed on every run)."*

Translate to OCR: **a 500-page PDF split into 500 page-jobs, ordered by `createdAt ASC LIMIT 10`,
will monopolize every claim batch and starve every single-page upload behind it.** The OCR queue
must have either a priority column or per-document fairness from day one. This is not
speculation — it is the same query shape that already caused a production incident in this
codebase family.

### 5.5 Verdict and decision

**Decision A-6 (confidence: high, reversibility: moderate).**

1. **Copy `outbox_events` and `idempotency_records` verbatim**, including the CHECK constraint,
   the two indexes each, the Zod input schema, `calculateBackoffMs`, `OutboxWorker`,
   `OutboxRepository`/`OutboxTransactionPort`, and `hashIdempotencyRequest` (SHA-256 over
   `JSON.stringify(payload)`). Use them for exactly what they are for: domain events published
   in the same transaction as a state change, and HTTP idempotency keys on document-upload and
   job-submit endpoints.
2. **Do NOT use `outbox_events` as the OCR job queue.** Add a new `ocr_jobs` table.
3. **Build `ocr_jobs` on the krs-pos claim shape**, not the jawbong one: single atomic
   `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING`, `lockedAt` staleness
   window, `nextAttemptAt` retry gate, `@unique` dedupe key.
4. **Add what neither has:** a `priority` (or fairness) column to prevent the §5.4 starvation, a
   `result`/`artifactRef` column, a lease heartbeat so a 90 s page OCR can extend its own lease,
   a **fencing-guarded completion** closing the §5.3(1) hole, per-row payload validation with
   quarantine closing the §5.2(b) hole, a canonical idempotency hash closing §5.3(3), and an
   idempotency `complete()` path closing §5.3(4).

> **⚠ SUPERSEDED — the fencing mechanism.** The first draft of this section proposed guarding
> completion with the claim **timestamp**: `UPDATE … WHERE id = $1 AND lockedAt = $2`. The review
> pass withdraws that, and `h-queue-and-worker-contract.md` **L4 explicitly rejects it** in favour
> of a **random UUID `lease_token`** re-generated on every claim, with every worker write guarded
> by `WHERE lease_token = $token`. H is right and this document defers to it. A timestamp is a poor
> fence for three reasons: `NOW()` has finite resolution so two claims within the same microsecond
> tick are indistinguishable; the value is *predictable*, so a buggy or replayed write can
> reconstruct it; and it couples correctness to clock behaviour across the app container, the worker
> container, and Postgres. A UUID has none of those properties and costs one column.
>
> **Ownership, stated once so it is not re-litigated:** the `ocr_jobs` schema, claim statement,
> lease/fencing protocol, retry policy, fairness algorithm, DLQ, cancellation, and the Node↔Python
> payload contract are all owned by **`h-queue-and-worker-contract.md`** (decisions L1–L21). This
> section's contribution is the *prior art and the constraints it imposes* — §5.2(a)'s batch-lease
> arithmetic, §5.2(b)'s poison-row deadlock, §5.3's four defects, §5.4's starvation incident and
> run-lock gap. Where this document and H disagree on the queue, **H wins**; where they disagree on
> a toolchain version, **this document wins** (§10.1).

Keep jawbong's vocabulary — `attempts`, terminal `FAILED` rows retained for inspection, bounded
exponential backoff — because it is already the house idiom and the ADRs already justify it.

**One vocabulary item to *not* keep: `lastError`.** jawbong stores `error.name` only; krs-pos
stores `e.message` via `safeErrMsg`. Neither is right for OCR. `error.name` is too coarse to
diagnose anything (`"Error"` for most throws), and `e.message` is unsafe: an OCR exception message
routinely embeds the filename, a path, or a fragment of extracted document text — which is exactly
the PII this product exists to protect, and which would then sit in a database column, in logs, and
in any error-reporting sink. `h-queue-and-worker-contract.md` **L21** specifies the correct shape —
a closed error-**code** enum plus an allow-listed redacted detail object, with raw exception
messages never written to Postgres. Adopt L21; treat both house precedents as superseded here.

**Rejected alternatives:**

- *Reuse `outbox_events` directly as the job queue.* No result column, no priority, 30 s default
  lease, unguarded completion. Bending it would mean adding five columns and changing three
  methods — at which point it is a new table with a misleading name.
- *Redis + BullMQ.* No INNOVERA production project uses Redis: I grepped every compose file in
  `~/quotation-system`, `~/Documents/TCL/server`, and `/Users/innovera/Claude/Projects/POS` and
  found zero hits. (Correction to a natural assumption: `docker ps -a` *does* show four stopped
  `redis:7` containers — `juneflow-linrb-redis-1`, `jf-lx2-redis-1`, `jf-w29-redis-1`,
  `jf-w26lock-redis-1` — but those belong to juneflow, not to any INNOVERA project.) Adding
  Redis means a second datastore, a second durability story, a second backup surface, and no
  transactional coupling to the Postgres write. **What would change this:** sustained throughput
  where Postgres row-lock contention on the claim becomes the measured bottleneck. Measure in
  M2; do not pre-optimize.
- *pg-boss / graphile-worker.* Genuinely good Postgres queues. Rejected because they own their
  own schema and their own migration lifecycle, which fights ADR-002's "Prisma is the
  application data access layer" and "migrations are additive" with a single owner. **What would
  change this:** if M2's scheduling requirements (cron, fan-out/fan-in, job dependencies) grow
  past what ~150 lines of our own claim logic can carry, revisit — `graphile-worker` in its own
  schema is the least-bad way to do it.

---

### 5.6 Thai correctness is a *stack* decision — and the first draft made none of them

**This section is new in the review pass.** The original document specified a Postgres image, a
Prisma schema, an idempotency hash, and a set of `VarChar` columns without once considering that
the primary language of the product's content is Thai. Every item below was verified empirically in
this session, on this machine, with the exact runtimes we are pinning. Getting these wrong does not
produce a visible crash — it produces silently wrong deduplication, silently wrong sorting, and
silently empty search results, which is the worst failure profile there is.

#### 5.6.1 What is *not* a problem — stated so nobody spends a week on it

Thai text has **no canonical decompositions**. NFC and NFD are byte-identical for pure Thai:

```
$ python3 -c "import unicodedata as u; s='สำนักงานทำคำนำ'; \
  print(u.normalize('NFD',s)==u.normalize('NFC',s), len(s.encode()), len(u.normalize('NFD',s).encode()))"
True 42 42

U+0E33 THAI CHARACTER SARA AM → NFD: ['0xe33']     (no decomposition)
```

This is worth stating explicitly because it is *counter-intuitive* — SARA AM (ำ) looks like a
composition of NIKHAHIT + SARA AA (U+0E4D U+0E32) and in some legacy encodings it is treated as
one. Unicode does **not** canonically decompose it. Consequences: the classic macOS-APFS
NFD-vs-NFC filename hazard **does not affect Thai filenames**, and NFC-normalising Thai text is a
no-op. Do not build machinery for a problem that does not exist here. (Latin-accented and Korean
filenames are still affected; normalise on ingest anyway, just do not expect it to change Thai.)

#### 5.6.2 What *is* a problem: Thai combining marks are never reordered, so equal text hashes differently

Unicode canonical reordering only sorts marks that have a **non-zero combining class**. Verified
on this host:

```
U+0E31 MAI HAN-AKAT   ccc=0      U+0E38 SARA U       ccc=103
U+0E34 SARA I         ccc=0      U+0E39 SARA UU      ccc=103
U+0E35 SARA II        ccc=0      U+0E48 MAI EK       ccc=107
U+0E36 SARA UE        ccc=0      U+0E49 MAI THO      ccc=107
U+0E37 SARA UEE       ccc=0      U+0E4A MAI TRI      ccc=107
U+0E47 MAITAIKHU      ccc=0      U+0E4B MAI CHATTAWA ccc=107
U+0E4C THANTHAKHAT    ccc=0      U+0E3A PHINTHU      ccc=9
```

The **above-vowels have ccc = 0**. That means NFC will *not* reorder an above-vowel relative to a
tone mark. Demonstrated:

```
'ก' + SARA I + MAI EK  → NFC: [0x0e01, 0x0e34, 0x0e48]
'ก' + MAI EK + SARA I  → NFC: [0x0e01, 0x0e48, 0x0e34]
NFC(a) == NFC(b)?  False
```

Both render as กิ่. Both are "the same word" to a Thai reader. **They are different strings to
Postgres, to `===`, to a `UNIQUE` constraint, and to SHA-256.** Different OCR engines — and even
the same engine on different pages — emit different orders, because the order depends on the
detected stroke sequence, not on a canonical rule.

**Every one of these breaks without a fix:** content-addressed page caching keyed on a text hash;
`hashIdempotencyRequest` (§5.3(3)) when a Thai filename or query string is in the payload;
`@@unique` constraints on any Thai-bearing column; exact-match lookup of an extracted field;
diffing two OCR engines' output to compute agreement/confidence.

**Required, at every write and every hash — not at read time:**

```ts
/**
 * Canonical Thai form. NFC is a no-op for Thai (§5.6.1) but is retained for the
 * Latin/Korean text that shares these columns. The load-bearing step is the SECOND
 * one: sort each cluster's combining marks into a fixed order, because Unicode
 * will not do it for us (all Thai above-vowels are ccc=0).
 *
 * Order within a cluster: base consonant, then above/below vowel, then tone mark,
 * then thanthakhat. This matches WTT 2.0 / TIS-620 input-sequence conventions.
 */
export function normaliseThai(input: string): string { /* … */ }
```

Apply it in exactly three places and nowhere else: (1) on ingest, before the text is persisted;
(2) inside `canonicalise()` before hashing (§5.3(3)); (3) on the query side of any exact-match
lookup. **Never** apply it lazily at read time — that guarantees stored and computed forms diverge.

**Store the raw engine output too.** Normalisation is lossy with respect to what the engine
actually saw, and M2's engine comparison needs the unmodified string. Two columns, not one.

#### 5.6.3 Postgres locale: the default sorts Thai wrong, and `bookworm` makes it worse

jawbong's `docker-compose.test.yml` and its CI service both run `postgres:18.4-bookworm` with **no
`POSTGRES_INITDB_ARGS`**, so the cluster initialises with the image default. Two separate problems
follow, and the first draft's "adopt with three changes" (name, port, tag) addressed neither.

**Problem 1 — Thai collates wrong under the default.** Demonstrated with the same ICU data
Postgres would use:

```
$ node -e 'console.log(["ไก่","กา","เข"].sort((a,b)=>a.localeCompare(b,"th")).join(" "),
                       "|", ["ไก่","กา","เข"].sort().join(" "))'
กา ไก่ เข | กา เข ไก่
```

Thai orthography places the four leading vowels (เ แ โ ใ ไ) *before* the consonant they modify in
writing but *after* it in collation. Codepoint order gets this backwards. Any `ORDER BY` on a Thai
name, any range query, any `LIKE 'ก%'` prefix filter, and any B-tree index built on such a column
is affected. This is not cosmetic: a paginated document list ordered by filename will present Thai
documents in an order no Thai user recognises as sorted.

**Problem 2 — glibc collation is not version-stable.** A libc-provided collation can change its
ordering between glibc releases. When it does, every B-tree index built on a `text`/`varchar`
column under the old ordering is **silently corrupt** — `UNIQUE` constraints stop catching
duplicates and index scans start missing rows, with no error. Base-image drift (`bookworm` →
`trixie`) is exactly the event that triggers this. ICU collations carry an explicit version that
Postgres records and checks, which converts a silent corruption into a loud warning.

**Decision A-13a (confidence: high, reversibility: hard — this is an `initdb`-time choice that
cannot be changed without a dump/restore).** Initialise every OCR cluster with the ICU provider:

```yaml
# docker-compose.test.yml / the production db service
postgres:
  image: postgres:18.6-bookworm
  environment:
    POSTGRES_DB: innovera_ocr_test
    POSTGRES_USER: innovera_ocr_test
    POSTGRES_PASSWORD: innovera_ocr_test
    # ICU, not glibc: version-checked collation (loud on drift, not silent),
    # and correct Thai ordering. This is an initdb-time decision — changing it
    # later needs a dump/restore, so it must be right in the first commit.
    POSTGRES_INITDB_ARGS: >-
      --locale-provider=icu --icu-locale=th-TH --encoding=UTF8
  ports: ["127.0.0.1:55433:5432"]
```

**Rejected:** `--locale=C` (byte order; makes Thai sorting worse, not better, and pushes the whole
problem into the application layer where it will be applied inconsistently); leaving the image
default (glibc `en_US.utf8` or `C.UTF-8` depending on image — the ambiguity is itself the argument
against it). **What would change this:** if a dependency turns out to require a libc collation,
fall back to `--locale=C` **plus** an explicit `COLLATE "th-TH-x-icu"` on every user-facing text
column, and write that requirement into the Prisma schema so it cannot be forgotten on a new table.

**Verify it in the same integration test that asserts the schema** (§7.4 already asserts the exact
table list; extend it):

```ts
const [{ datcollate, datlocprovider }] = await sql`
  SELECT datcollate, datlocprovider FROM pg_database WHERE datname = current_database()`;
expect(datlocprovider).toBe("i");         // 'i' = ICU, 'c' = libc
expect(datcollate).toBe("th-TH");
```

#### 5.6.4 There is no Thai full-text search in Postgres. Plan for it now, not in M3.

Postgres ships no `thai` text-search configuration, and it cannot: `to_tsvector` tokenises on
whitespace and punctuation, and **written Thai has no spaces between words**. `to_tsvector('simple',
'สำนักงานใหญ่ตั้งอยู่ที่กรุงเทพ')` yields one enormous token. Any design that assumes "we'll add
full-text search later, it's just a GIN index" is assuming something that does not exist.

The three real options, so the choice is made deliberately when it arrives:

| Option | Mechanism | Cost | When it is right |
|---|---|---|---|
| **`pg_trgm` + GIN** | Character trigrams; `%` similarity and `ILIKE` acceleration | An extension; index size; no relevance ranking | Default. Substring/fuzzy search over extracted text. Works on Thai without segmentation |
| **Pre-segmented tokens column** | Segment Thai in the worker (PyThaiNLP `newmm`, or ICU `BreakIterator`), store a space-joined `tsvector` | A segmentation dependency in the worker; re-segmentation on dictionary updates | Real ranked FTS with `ts_rank` |
| **External search engine** | OpenSearch/Meilisearch with a Thai analyser | A second datastore — the same objection §5.5 raises against Redis | Only if search becomes a headline feature |

**Decision A-13b (confidence: medium, reversibility: easy).** M1 ships **`pg_trgm`** — one
`CREATE EXTENSION` in the first migration, no worker dependency, no second datastore, and it is the
only option that works on unsegmented Thai out of the box. Revisit at the point where users ask for
relevance ranking rather than "find documents containing this string". **What would change this:**
a product requirement for ranked search, or trigram index size exceeding the table it indexes.

Note this interacts with §5.6.2: trigrams are computed over the stored bytes, so **unnormalised
text produces trigrams that will not match a normalised query.** Normalise before storing.

#### 5.6.5 Thai digits, Buddhist-Era dates, and the `VarChar` trap

**Thai digits are invisible to JavaScript's number parsing.** Verified on Node v22.22.3:

```
parseInt("๑๒๓")        → NaN
Number("๑๒๓")          → NaN
/^\d+$/.test("๑๒๓")    → false        ← \d is ASCII-only, even in Unicode mode
/^\p{Nd}+$/u.test("๑๒๓") → true       ← the only regex class that sees them
```

Thai documents — especially government forms, receipts, and older printed material — use ๐–๙
(U+0E50–U+0E59) freely and often mixed with ASCII digits in the same field. Consequences that must
be handled at the parsing boundary, not discovered in production:

- `z.coerce.number()` on an OCR-extracted amount yields `NaN`, which Zod's `z.number()` **accepts
  unless you also call `.finite()`**. Every numeric coercion of OCR output needs an explicit Thai-digit
  transliteration step first, and `.finite()` after.
- Any validation regex written as `\d` silently rejects valid Thai input. Use `\p{Nd}` with the `u`
  flag throughout, and add a lint rule or a test that greps for `\\d` in validation code.
- Transliteration is a 10-character map (`U+0E50 + n`), not a library dependency.

**Buddhist Era.** Thai documents date in พ.ศ. (BE), where **BE = CE + 543**. A date extracted as
`2569` is CE 2026, not the year 2569. `new Date("2569-09-09")` is a valid `Date` in the 26th
century and will not throw. The heuristic must be explicit and thresholded, not inferred:

> A four-digit year in the range **2400–2600** is Buddhist Era; subtract 543. A year in
> **1900–2100** is Common Era; leave it. **Anything else is an extraction error and must be
> surfaced to the reviewer, never silently coerced.** Store the raw extracted string alongside the
> parsed date so a wrong guess is auditable and correctable.

The dead zone (2101–2399) is intentional: there is no plausible correct reading there, so it is a
signal that OCR misread a digit.

**Column types.** jawbong's outbox uses `@db.VarChar(160)` / `@db.VarChar(1000)`. Postgres
`varchar(n)` counts **characters**, not bytes, so Thai does not overflow it any faster than
English *per character* — but a Thai character consumes 3 bytes in UTF-8, and a Thai grapheme
cluster is routinely 2–4 characters (base + vowel + tone). A filename that *looks* 40 characters
long to a user can be 100+ codepoints. **For OCR-extracted content use `@db.Text` with no length
limit**; reserve `VarChar(n)` for machine-generated identifiers. Where a length cap is genuinely
needed for a user-supplied Thai string, cap on **grapheme clusters** (`Intl.Segmenter` with
`granularity: "grapheme"`), never on `String.length` — truncating mid-cluster produces an orphaned
combining mark that renders as a dotted circle.

The same argument applies to jawbong's `safeError.slice(0, 1000)`: `String.prototype.slice` cuts on
UTF-16 code units and will happily separate a Thai tone mark from its base. Since §5.5 replaces
`lastError` with a closed error-code enum anyway, this is mostly moot — but any *other* truncation
of Thai text in this codebase must use `Intl.Segmenter`.

#### 5.6.6 Thai filenames on the HTTP boundary

Not a database issue but it belongs with the rest: a Thai filename cannot be sent in a bare
`Content-Disposition: attachment; filename="…"` header, because HTTP header values are not UTF-8.
Use the RFC 5987/6266 form, and always emit **both** parameters so non-conforming clients get an
ASCII fallback rather than a mangled name:

```
Content-Disposition: attachment; filename="document.pdf"; filename*=UTF-8''%E0%B9%80%E0%B8%AD%E0%B8%81%E0%B8%AA%E0%B8%B2%E0%B8%A3.pdf
```

`i-storage.md` §7 owns the file-serving path; this is recorded here so the requirement is not lost
between the two documents. Note also that a Thai filename must **never** appear in an object
storage key — `i-storage.md` §2's key scheme is already opaque, which is the right answer for
path-traversal reasons as well as encoding ones.

---

## 6. The RIPER-5 harness layout a new project must scaffold

### 6.1 What is inherited, not vendored

Verified on this host:

```
/Users/innovera/CLAUDE.md                     ← orchestrator protocol
/Users/innovera/AGENTS.md
/Users/innovera/.claude/agents/               ← 12 agents (vc-research-agent … vc-git-manager)
/Users/innovera/.claude/skills/
/Users/innovera/.agents/
/Users/innovera/process/development-protocols/ ← all-development-protocols.md, orchestration.md,
                                                 implementation-standards.md, plan-lifecycle.md,
                                                 phase-programs.md, context-maintenance.md,
                                                 parallel-fan-out.md, intent-clarification.md,
                                                 references/
```

Note there is **no** `/Users/innovera/process/context/` — context is always project-local.

jawbong states the inheritance rule explicitly, and OCR must state the same
(`~/Documents/jawbong/process/context/all-context.md`, §"Harness Inheritance"):

> "This application intentionally inherits the shared Claude/Codex harness and development
> protocols from `/Users/innovera`. It does not vendor `.claude/`, `.agents/`, `.codex/`,
> `AGENTS.md`, `CLAUDE.md`, or `process/development-protocols/`. Run harness validators from the
> parent environment and classify project-local missing-surface failures as inheritance findings
> unless the project is explicitly asked to vendor the harness."

**Decision A-11 (confidence: high, reversibility: easy).** OCR inherits. **Rejected:** vendoring
the harness into the OCR repo — it forks the protocol and guarantees drift across TCL/jawbong/OCR.
**What would change this:** the OCR repo being handed to a team without access to this
workstation's home directory; then vendor deliberately, in one commit, and say so in context.

Re-verified in the review pass: `/Users/innovera/.claude/agents/` holds exactly **12** agent files,
`/Users/innovera/process/development-protocols/` holds the eight protocol documents plus
`references/`, and `/Users/innovera/process/context/` does **not** exist — confirming that context
is always project-local while protocols are inherited.

**The inheritance has a consequence that must be written into `.gitignore` and the README:** because
the harness lives outside the repo, a clone of the OCR repository on another machine is **not a
working RIPER-5 environment**. Anyone who clones it gets the `process/context/` and
`process/general-plans/` trees but none of the agents or protocols. State this explicitly in
`process/context/all-context.md` under a "Harness Inheritance" heading, copying jawbong's wording,
so the first person to clone the repo elsewhere does not conclude the harness is broken.

### 6.2 What must be scaffolded, project-local

```
process/
├── context/
│   ├── all-context.md              ← REQUIRED router. Missing today.
│   └── tests/all-tests.md          ← test group entrypoint (jawbong has exactly this)
├── general-plans/
│   ├── active/                     ← exists
│   ├── completed/                  ← MISSING today
│   ├── backlog/                    ← MISSING today
│   ├── reports/                    ← exists
│   └── references/                 ← exists
└── features/
    └── innovera-ocr/               ← create upfront: this is a multi-phase program (M0…Mn)
        ├── active/
        ├── completed/
        ├── backlog/
        ├── reports/
        └── references/
docs/
├── architecture/
│   ├── README.md                   ← ADR index
│   ├── adr-001-….md …              ← one file per decision
│   ├── module-dependency-diagram.md  ← mermaid flowchart, forbidden edges named
│   └── m0/                         ← this milestone's dimension reports (exists)
└── product/
    └── mvp-scope.md                ← personas, terminology, in/out of scope
```

Per `/Users/innovera/CLAUDE.md` "Feature Folder Lifecycle": *"New multi-phase project (3+ planned
phases) → Create feature folder upfront."* INNOVERA OCR AI is M0…Mn, so
`process/features/innovera-ocr/` is created now, not promoted later. jawbong's naming convention
for the plan files is `{name}_PLAN_{dd-mm-yy}.md` with an umbrella
`{feature}-program_PLAN_{dd-mm-yy}.md` plus `phase-NN-{slug}_PLAN_{dd-mm-yy}.md`, and archived
files get a `completed_` prefix. Copy that exactly.

`process/context/all-context.md` must open with a **Quick Routing** table (task → read-next
file), because `all-*.md` files are routers, not knowledge dumps — jawbong's is the reference
implementation.

---

## 7. Testing conventions actually used

Three runners, three configs, one safety wrapper. All quoted from files read this session.

### 7.1 Unit / component — `vitest.config.ts`

```ts
export default defineConfig({
  resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
  test: {
    environment: "jsdom",
    include: ["tests/unit/**/*.test.{ts,tsx}"],
    setupFiles: ["tests/setup.ts"],
    coverage: { reporter: ["text", "html"] },
  },
});
```

`tests/setup.ts` is three lines: `import "@testing-library/jest-dom/vitest"` + `afterEach(cleanup)`.

### 7.2 Integration — `vitest.integration.config.ts`

```ts
test: {
  environment: "node",
  include: ["tests/integration/**/*.test.ts"],
  fileParallelism: false,        // shared DB → serialize
  testTimeout: 20_000,
  hookTimeout: 20_000,
}
```

### 7.3 E2E — `playwright.config.ts`, serving the **production** build

```ts
testDir: "tests/e2e",
fullyParallel: false,
use: { baseURL: "http://127.0.0.1:3100", trace: "retain-on-failure",
       screenshot: "only-on-failure" },
webServer: {
  command: "corepack pnpm@11.18.0 start --port 3100",
  url: "http://127.0.0.1:3100",
  reuseExistingServer: !process.env.CI,
  timeout: 120_000,
  env: { APP_ENV: "test", DATABASE_SCOPE: "test", DATABASE_URL: "…", … },
},
```

The rationale is documented in `process/context/tests/all-tests.md`: *"Build before E2E because
Playwright serves the production build to avoid development file-watcher limits."*

Evidence artifacts are committed as durable proof: `tests/evidence/screenshots/foundation-{320,375,768,1280}.png`.

### 7.4 Database lifecycle — the fail-closed allowlist

This is the piece most worth copying verbatim. `src/lib/db/database-safety.ts` refuses any
database operation unless **every one** of eight conditions holds:

```ts
const ALLOWED_HOSTS   = new Set(["127.0.0.1", "localhost"]);
const ALLOWED_PORTS   = new Set(["5432", "55432"]);
const REQUIRED_DATABASE = "jawbong_test";
const REQUIRED_USER     = "jawbong_test";
const ALLOWED_APP_ENVS  = new Set(["development", "test"]);
const ALLOWED_NODE_ENVS = new Set(["development", "test"]);
const ALLOWED_SCOPES    = new Set(["local", "test", "ci"]);
```

Every migrate/seed/integration command is funnelled through `scripts/with-test-database.ts`,
which calls `assertDisposableDatabaseUrl` *before* `spawnSync`, and `scripts/verify-integration.mjs`
wraps the whole run so teardown happens even on failure:

```js
try {
  run("docker", ["compose", "-p", "jawbong-phase00", "-f", "docker-compose.test.yml",
                 "up", "-d", "--wait"]);
  run("corepack", [...pnpm, "db:test:migrate"]);
  run("corepack", [...pnpm, "db:test:seed"]);
  run("corepack", [...pnpm, "test:integration"]);
} finally {
  run("docker", ["compose", "-p", "jawbong-phase00", "-f", "docker-compose.test.yml",
                 "down", "--volumes"]);
}
```

The test compose file uses a `tmpfs` data directory, a project-scoped name, and lifecycle labels:

```yaml
name: jawbong-phase00
services:
  postgres:
    image: postgres:18.4-bookworm
    ports: ["127.0.0.1:55432:5432"]
    healthcheck: { test: ["CMD-SHELL","pg_isready -U jawbong_test -d jawbong_test"],
                   interval: 2s, timeout: 3s, retries: 20 }
    labels:
      com.jawbong.lifecycle: disposable-test-only
      com.jawbong.phase: phase-00
    tmpfs: [/var/lib/postgresql]
```

**Adopt with four changes** (the first draft listed three and omitted the most consequential):
database/user `innovera_ocr_test`; port `55433` (55432 is jawbong's and 5432 is krs-pos-db's);
image `postgres:18.6-bookworm`; **and `POSTGRES_INITDB_ARGS: --locale-provider=icu
--icu-locale=th-TH --encoding=UTF8` per §5.6.3** — an `initdb`-time choice that cannot be corrected
later without a dump/restore, and which must therefore be identical in the test compose file, the
CI service definition, and production. Three places, one value; assert it in an integration test
(§5.6.3) so the three cannot drift.

Note also that jawbong's `ALLOWED_PORTS` allowlist in `database-safety.ts` hardcodes
`{"5432", "55432"}`. The OCR copy must be `{"5432", "55433"}` — **and dropping `5432` entirely is
worth considering**, since on this host `127.0.0.1:5432` is `krs-pos-db`, a live POS database. The
only reason jawbong allows 5432 is that GitHub Actions' service container publishes there. Scope
the allowance to CI rather than allowing it everywhere:

```ts
// 5432 is only ever legitimate inside CI, where the service container owns it.
// On a developer machine 127.0.0.1:5432 is krs-pos-db — a live POS database.
const ALLOWED_PORTS = new Set(
  process.env.DATABASE_SCOPE === "ci" ? ["5432"] : ["55433"],
);
```

There is one meaningful assertion worth stealing outright — an integration test that asserts the
*entire* public schema, so an accidental table can never sneak in:

```ts
expect(rows.map((row) => row.table_name)).toEqual([
  "_prisma_migrations", "idempotency_records", "outbox_events",
]);
```

### 7.5 CI — `.github/workflows/ci.yml`

`ubuntu-24.04`, a `postgres:18.4-bookworm` service with a health check, and **action SHAs pinned
to full commit hashes** (`actions/checkout@d23441a4…`, `pnpm/action-setup@b906affc…`,
`actions/setup-node@24997072…`) — supply-chain hygiene worth copying. Gate order:

```
install --frozen-lockfile → db:generate → typecheck → lint → boundary → test
→ db:test:migrate → db:test:seed → test:integration → build
→ playwright install --with-deps chromium → test:e2e
```

Static gates run **before** anything touches a database. Copy this ordering.

Two additions for OCR, both inserted without disturbing the "static gates first" principle:

```
install --frozen-lockfile → prisma-version-lockstep (§3.4) → db:generate → typecheck
→ lint → boundary → test → db:test:migrate → db:test:seed → db:assert-locale (§5.6.3)
→ test:integration → build → playwright install → test:e2e
```

The CI runner must also be told about Thai explicitly. jawbong's workflow already carries
`NEXT_PUBLIC_SITE_NAME: จ่าวบอง` as a UTF-8 env value and it works, which is useful evidence that
`ubuntu-24.04` + `actions/checkout` handle Thai in workflow YAML without escaping. But that is not
the same as the *runner* having a UTF-8 locale: add `LANG: C.UTF-8` and `LC_ALL: C.UTF-8` to the
job `env` so that any Python or CLI step in M2 that touches Thai filenames does not fall back to
ASCII and raise `UnicodeEncodeError`.

### 7.6 Thai test fixtures — the convention to establish in the first commit

jawbong proves the house already commits durable visual evidence
(`tests/evidence/screenshots/foundation-{320,375,768,1280}.png`). OCR needs the same discipline
applied to *text*, and it needs it from commit one, because a Thai correctness bug found in M2 is
unreproducible without a fixture that predates it.

| Fixture | Purpose | Asserts |
|---|---|---|
| `tests/fixtures/thai/mark-order.json` | Pairs of visually-identical strings with different mark order (§5.6.2) | `normaliseThai(a) === normaliseThai(b)` and `a !== b` |
| `tests/fixtures/thai/digits.json` | Thai, ASCII, and mixed-digit numerals | Transliteration; `\p{Nd}` matching; `.finite()` rejection of `NaN` |
| `tests/fixtures/thai/dates.json` | BE, CE, and dead-zone years (§5.6.5) | 2569→2026; 2026→2026; 2200→**error, not a guess** |
| `tests/fixtures/thai/collation.sql` | A table of Thai strings and their expected `ORDER BY` | ICU `th-TH` ordering, run against the disposable DB |
| `tests/fixtures/thai/filenames.txt` | Thai filenames incl. leading vowels, tone marks, spaces, and a 300-char name | Storage key generation; `Content-Disposition` encoding; grapheme-aware truncation |

These are **unit-testable without any OCR engine**, so they belong in M1's `pnpm test` gate, not in
M2. That is the point: the Thai correctness layer can be built and proven before the first image is
ever rasterised.

---

## 8. Deployment prior art — three patterns observed, one recommended

### 8.1 What actually exists

| Project | Host | Proxy | Migration strategy | Ports |
|---|---|---|---|---|
| **krs-pos** (`~/deploy-krspos.sh`) | AWS Lightsail `ap-southeast-1`, `ubuntu@52.221.213.43` | `caddy:2-alpine` in-stack, owns `80`+`443`, Let's Encrypt | **one-shot `migrate` compose service**, app `depends_on: {migrate: {condition: service_completed_successfully}}` | app bound `127.0.0.1` only; caddy publishes 80/443 |
| **TCL** (`docs/deploy-vps.md`) | shared Ubuntu VPS under `/opt/tcl/` | joins an **existing** `caddy-gen-proxy` via container labels `virtual.host`/`virtual.port`/`virtual.tls-email` on `proxy-network` | **manual** `npm run migrate` (`psql -f db/schema.sql`) before container swap | **zero** host ports published |
| **quotation-system** (`deploy.sh`) | VPS `72.62.253.185` | host **nginx** proxies to `127.0.0.1:8091` | none observed | `127.0.0.1:8091:80` |
| **jawbong** | none — no production deploy exists | — | Prisma migrations, dev/CI only | — |

### 8.2 The krs-pos deploy script — the parts worth copying

`~/deploy-krspos.sh`, verbatim highlights:

```bash
set -euo pipefail
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml"
SSH=(ssh -i "$KEY" -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new "$HOST")
chmod 400 "$KEY" 2>/dev/null || true   # ssh refuses a world-readable key
```

Six numbered stages: **0** local preflight; **1** pre-deploy drain check
(*"SALE jobs pending/retrying must be 0"* — deploy is refused if in-flight jobs use the old
payload format); **2** `git fetch && git merge-base --is-ancestor HEAD origin/main && git pull
--ff-only` (never destroys box-only files); **3** `up -d --build`; **4** print migrate logs;
**5** poll `docker inspect --format "{{.State.Health.Status}}" krs-pos-app` up to 20× at 6 s
(= 120 s budget); **6** post-deploy queue re-check to catch build-window stragglers.

**Correction (review pass): stage 0 is not a gate.** The first draft described it as "local
preflight (`HEAD == origin/main`)", implying it blocks. Read the actual code:

```bash
say "0/6  Local preflight (HEAD == origin/main)"
git -C "$LOCAL_REPO" fetch -q origin main 2>/dev/null || true
LOCAL_HEAD=$(git -C "$LOCAL_REPO" rev-parse --short HEAD 2>/dev/null || echo '?')
echo "    local HEAD = $LOCAL_HEAD  (expecting ~$EXPECT_SHA on origin/main)"
```

There is no comparison and no `die`. `EXPECT_SHA` is a hardcoded constant the script's own comment
labels `# informational`, the `fetch` swallows its own failure, and `rev-parse` falls back to `?`.
Stage 0 **prints a string and continues**, even when the local tree is dirty or unpushed. Stages 1,
2 and 5 are real gates (each ends in `|| die`); stages 0, 3, 4 and 6 are not.

**When we copy this script, stage 0 must become a real gate**, because it is the one that prevents
deploying a tree that does not exist on the remote:

```bash
git -C "$LOCAL_REPO" fetch -q origin main || die "cannot reach origin"
[ -z "$(git -C "$LOCAL_REPO" status --porcelain)" ] || die "working tree dirty — commit or stash first"
git -C "$LOCAL_REPO" merge-base --is-ancestor HEAD origin/main \
  || die "HEAD is not on origin/main — push before deploying"
```

**The rest is directly reusable for OCR.** Stage 1 becomes "no `ocr_jobs` in a running state",
stage 6 becomes the same re-check. An OCR deploy that swaps the container while a 500-page document
is mid-extraction has exactly the krs-pos problem — and a worse version of it, since an OCR job may
have already spent money on model calls that a restart would discard.

**One thing in this script that must NOT be copied.** The SSH key path is:

```bash
KEY="$HOME/Downloads/LightsailDefaultKey-ap-southeast-1.pem"
```

A production SSH private key living in `~/Downloads` is a finding, not a convention. `~/Downloads`
is the single most write-exposed directory on a developer machine, it is indexed by Spotlight, it
is the default target of every browser download, and it is routinely bulk-deleted or bulk-synced to
cloud storage. The `chmod 400 "$KEY"` on the next line fixes the permission bits and nothing else.
**The OCR deploy script must read its key from `~/.ssh/` with `0600`, reference it through
`~/.ssh/config` by host alias rather than by path, and prefer an SSH agent or a short-lived
certificate to a long-lived key file.** This is observed prior art we are explicitly declining to
inherit — recorded here so the decision is visible rather than accidental.

### 8.3 The compose shape (`POS/docker-compose.yml` + `.prod.yml`)

**Privilege split — copy this:**

```yaml
  migrate:
    build: { context: ., dockerfile: Dockerfile, target: migrate }
    restart: "no"
    depends_on: { db: { condition: service_healthy } }
    environment:
      # Migrations need DDL → connect as the SUPERUSER, not the least-priv app role.
      DATABASE_URL: ${MIGRATE_DATABASE_URL}

  app:
    depends_on:
      db:      { condition: service_healthy }
      migrate: { condition: service_completed_successfully }
    environment:
      # The app connects as the LEAST-PRIVILEGE `krs_app` role (DML only).
      DATABASE_URL: ${DATABASE_URL}
```

**Scheduling — the house pattern is an external poll sidecar, not an in-process timer.** Three
`curlimages/curl` sidecars drive krs-pos's background work by POSTing bearer-authenticated
internal endpoints on a `sh` sleep-loop. The comment explains why not cron:

> *"We use a plain `sh` poll-loop (curl + sleep), NOT a cron daemon: `curlimages/curl` runs as a
> NON-root user and busybox `crond` needs root + a crontab directory, so it crash-loops."*

and why the endpoint, not the sidecar, is the safety gate:

> *"The endpoint itself is the real safety gate: it is bearer-authenticated, opt-in
> (`KRS_AUTO_SYNC_ENABLED`), single-run-locked, and fail-safe. … NEVER bake the secret into the
> image: it is passed from the git-ignored `.env` at runtime, and only the HTTP status code (not
> the secret or the response body) is logged."*

Also present, and worth copying: the prod overlay carries the schedulers so that a plain local
`docker compose up` does **not** run them.

### 8.4 `.env` handling — the consistent house rules

- `.gitignore`: `.env*` with `!.env.example` and `!.env.test.example`. Values never in git.
- `chmod 600 .env` on the box (TCL runbook).
- Secrets generated on the box: `openssl rand -hex 32` for JWT/pepper keys,
  `openssl rand -base64 24 | tr -d '/+='` for DB passwords.
- Fail-closed compose interpolation:
  `POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?ต้องตั้ง POSTGRES_PASSWORD ใน server/.env}`
- Defaulted-optional: `${KRS_AUTO_SYNC_ENABLED:-false}` — features are **opt-in**.
- Zod validation at boot (`src/lib/config/env.ts` + `src/instrumentation.ts` calling
  `getServerEnv()` when `NEXT_RUNTIME === "nodejs"`) so a misconfigured container never becomes
  healthy.
- Compose reads `.env` from the **compose file's own directory**, as both `env_file` and the
  `${...}` interpolation source (TCL comment).
- One irreversible-secret warning worth generalizing: TCL's `PIN_PEPPER` — *"เปลี่ยนทีหลังไม่ได้"*
  (cannot be changed later). OCR will have at least one such value if documents are encrypted at
  rest. Identify it explicitly in M1 and document it as irreversible.

### 8.5 Decision A-7

**Decision A-7 (confidence: high, reversibility: moderate).** OCR ships as
`docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build` with:

- `caddy:2-alpine` in-stack for TLS, **unless** the target host already runs a
  `caddy-gen-proxy`, in which case use the TCL label-join pattern and publish **zero** host ports;
- a one-shot `migrate` service running `prisma migrate deploy` as a **superuser** role, with the
  app depending on `service_completed_successfully` and connecting as a **DML-only** role;
- a `deploy.sh` modelled on `~/deploy-krspos.sh` including the pre- and post-deploy in-flight-job
  drain checks;
- json-file logging capped (`max-size: "10m"`, `max-file: "3"`) on every service, as TCL does —
  OCR logs will be voluminous.

**Rejected:** TCL's manual `psql -f db/schema.sql` (no version tracking, no rollback story, and
the compose comment admits *"แก้ schema ภายหลังต้องรัน `npm run migrate` ด้วยมือ ไม่มีอะไรรันให้อัตโนมัติ"*);
quotation-system's host-nginx pattern (works, but the reverse proxy then lives outside the repo
and outside version control). **What would change this:** a target host whose port 80/443 is
already owned — then the TCL label-join is not a fallback but the correct answer, and its hard-won
warning applies: **every service must be on exactly one network**, or caddy-gen round-robins to an
unreachable IP and you get *"502 สลับ 200 เป๊ะ 50%"*.

**One TCL trap to carry forward:** on a shared `proxy-network`, a service literally named
`postgres` can collide with another project's `postgres` and the app silently connects to the
wrong database. TCL's fix is a network alias (`tcl-db`) referenced from `DATABASE_URL`. Use
`ocr-db`, never `postgres`.

**Edge-proxy addendum (review pass).** `m-docker-nginx-resources.md` §3.1 accepts A-7's reasoning
but points out that the choice is determined by the target host, and adds a **third** case the
first draft did not enumerate: a host already running **host NGINX** — which is precisely the
situation on the quotation VPS at `72.62.253.185`, recorded in §8.1 of this document. In that case
neither in-stack Caddy nor the caddy-gen label-join is available, because something else already
owns `:443`. A-7's objection ("the reverse proxy then lives outside the repo and outside version
control") is answered there by keeping the NGINX file in our repo at `deploy/nginx/ocr.conf` and
having the owner copy it into place — outside the *running* system's control, not outside version
control. A-7 stands as the default; §3.1 of M owns the host-NGINX variant.

### 8.6 The native OCR stack is the product's largest attack surface — and §2.5 listed it without a single mitigation

**This section is new in the review pass.** §2.5 enumerates `tesseract`, `poppler`, `ghostscript`,
`qpdf`, `mupdf`, `imagemagick`, and `libreoffice` as the M2 container manifest. Every one of those
is a C/C++ parser that will be fed **attacker-supplied files by design** — that is the product.
Ghostscript, ImageMagick and LibreOffice in particular have long, well-documented histories of
sandbox-escape and remote-code-execution classes (ImageMagick's delegate/coder handling and
Ghostscript's PostScript operator exposure being the canonical examples). Listing them as a
dependency table without a hardening posture understates the risk by a wide margin.

`j-security-threat-model.md` owns the full threat model (its §3 covers upload and file-format
threats, §5 covers rendering and OCR execution, §8 gives the concrete numeric limits). **This
section records only the requirements that fall on *this* document's subject matter — the base
images, the compose service definition, and the toolchain — so that the stack decisions above are
not made in ignorance of them.**

**Stack-level requirements, non-negotiable:**

1. **The renderer runs with no network.** `network_mode: none` (or an internal network with no
   gateway) on any service that invokes Ghostscript, ImageMagick, or LibreOffice. All three can be
   induced to fetch remote resources — LibreOffice via remote templates and linked objects,
   ImageMagick historically via its `https`/`url` delegates, Ghostscript via `%pipe%` and file
   operators. A renderer with network access turns every uploaded document into an SSRF primitive
   against the internal network. This is the single highest-value control here and it costs one
   compose line.
2. **Non-root, read-only, capability-stripped**, with scratch space on a size-bounded tmpfs:
   `user: "10001:10001"`, `read_only: true`, `cap_drop: [ALL]`,
   `security_opt: ["no-new-privileges:true"]`, `tmpfs: ["/tmp:size=512m,noexec,nosuid,nodev"]`,
   `pids_limit`, an explicit `mem_limit`, and `ulimits: { nofile: … }`.
3. **ImageMagick needs a `policy.xml`, and the default one is not it.** Disable the coder classes
   that have no legitimate role here (`MSL`, `MVG`, `URL`, `HTTPS`, `FTP`, `EPHEMERAL`, `SHOW`,
   `WIN`, `PLT`, `TEXT`, and — importantly — `PS`/`PDF`/`XPS`, which delegate to Ghostscript and
   are the classic pivot), and set `resource` limits for `memory`, `map`, `disk`, `area`, `time`,
   `width`, and `height`. Copy the file into the image and assert it in a container test; a
   silently-missing `policy.xml` is indistinguishable from a present one until it is exploited.
4. **Ghostscript is invoked with `-dSAFER -dNOPAUSE -dBATCH -sDEVICE=…` and a `-dLastPage` cap**,
   never with a user-controlled device or output path. `-dSAFER` has been the default since GS
   9.50; pass it explicitly anyway, because the default is a property of the version we happen to
   install and the flag is a property of our code.
5. **A pixel budget, enforced before rasterising.** A PDF `MediaBox` is author-controlled and may
   legitimately describe a 200×200-inch page; at 300 DPI that is 60 000 × 60 000 px ≈ 3.6 Gpx ≈
   **14 GB** at 4 bytes/px — an OOM kill from a single small file, on a Docker VM that has 7.75 GiB
   total (§2.2). Read the geometry with `pdfinfo` **first**, compute
   `width_px × height_px = (w_pt/72 × dpi) × (h_pt/72 × dpi)`, reject or down-scale the DPI when
   the product exceeds the budget, and cap page count. `j-security-threat-model.md` §8 and
   `m-docker-nginx-resources.md` §4.1 carry the agreed numbers; the requirement is recorded here
   because it constrains the *container's* memory sizing, which is a §2.2 concern.
6. **Base images pinned by digest, not tag**, for exactly these packages — a floating
   `ghostscript` tag is an unreviewed change to an RCE-prone parser. §2.5's "pinned by tag and
   ideally by digest" is too soft: for this container, digest pinning is required.
7. **`.dockerignore` must exclude `.env*`, `.git`, `tests/fixtures`, and `docs/`.** The house
   `.gitignore` keeps secrets out of git; nothing in the observed prior art keeps them out of the
   *image*, and a build context that includes `.env` bakes it into a layer.

**What this does not cover:** malware scanning, tenant isolation, signed URLs, PDPA retention, and
the LLM-specific threats. Those are `j-security-threat-model.md`'s (§11, §7, §4, §9, §6
respectively). Do not treat this list as the security review.

---

## 9. Item I (part) — how the unknown AI gateway changes the stack

> ## 🔴 UNRESOLVED — OWNER-BLOCKED
>
> **Nothing about the INNOVERA AI gateway is known.** Not the base URL, not the port, not the
> auth scheme, not the model identifiers, not the context window, not whether any deployed model
> accepts images, not whether it supports structured/JSON output or tool calls, not its rate
> limits, and not its data-retention behaviour.
>
> No statement anywhere in this document asserts otherwise. "Branch V" and "Branch T" below are
> **two designs held open**, not a prediction and not a recommendation. Any downstream document,
> plan, or ticket that names a model, an endpoint, a port, or a capability is **fabricating it**
> and must be corrected rather than followed.
>
> **This is resolvable in minutes** once the owner supplies `AI_BASE_URL` and `AI_API_KEY` — run
> `docs/m0/discovery/probe_ai_gateway.py`. Until then it stays red.

Per the ground truth, the INNOVERA LiteLLM/vLLM/Qwen endpoint is not on this workstation and its
address is not recorded in any readable file. The review pass confirmed nothing that overturns
that. Both branches are designed below; **neither is chosen here.**

### Common to both branches (true regardless of the gateway answer)

- **A PDF→raster step is mandatory.** Even a fully vision-capable model receives *images*. That
  needs `pdftoppm` (poppler) — ABSENT locally. **So the OCR container is required on every
  branch.** This is the single most useful thing to know before the gateway question is answered:
  M2 can start building the preprocessing container today without waiting.
- Zod at the boundary. The gateway response is untrusted IO; parse it with a Zod schema exactly
  as `src/lib/config/env.ts` parses env.
- The gateway is a **provider adapter behind an application-owned port**, per ADR-006:
  *"Payment, shipping, identity, messaging, and storage providers remain behind application-owned
  ports. Provider payloads do not enter domain models."* An `OcrEnginePort` /
  `DocumentUnderstandingPort` in `application/`, with a LiteLLM adapter in `infrastructure/`,
  makes the branch question a swap rather than a rewrite.

### Branch V — Qwen is vision-capable (e.g. a *-VL model behind vLLM/LiteLLM)

- **Runtime:** stays single-language TypeScript. The worker calls the OpenAI-compatible
  `POST /v1/chat/completions` with `image_url` data URIs.
- **Client:** plain `fetch` + Zod, or the `openai` npm SDK pointed at the gateway base URL.
  **Recommendation: plain fetch + Zod** — one fewer dependency, and the SDK's types add little
  once responses are Zod-parsed anyway.
- **Container manifest shrinks** to poppler + qpdf + ghostscript (+ imagemagick for
  deskew/DPI). No Python OCR engine needed on the primary path — though one should still ship as
  a fallback for when the gateway is down or a page is over the model's token budget.
- **New constraints:** per-request image size/count limits, and cost/token accounting per page
  (hence the `result` column in `ocr_jobs`, §5.5). Lease duration must exceed the model's
  worst-case latency — reinforcing the 10-minute krs-pos window over jawbong's 30 s.

### Branch T — Qwen is text-only

- **Runtime:** a **second language is now mandatory.** A Python OCR sidecar performs
  pixel→text; Qwen only structures/extracts from text that already exists.
- **Python pin — CORRECTED (review pass).** The first draft pinned **3.11.15** on the reasoning
  that it "matches the interpreter uv has already installed locally". That reasoning is backwards:
  the locally-cached interpreter is an accident of a previous experiment, not a constraint. `uv`
  can install any version on demand (`uv python install 3.13`) in under a minute, so local
  convenience should not set a production pin. **`m-docker-nginx-resources.md` O5 pins
  `python:3.13-slim-bookworm` for the worker image, and that supersedes 3.11 here.** Reconcile in
  M's favour: **Python 3.13** in the container; use `uv venv --python 3.13` locally so the two
  agree. What remains true from the first draft is the *floor*: the system interpreter at **3.9.6
  is EOL and unusable**, and `uv` is the installer in both places.
  <br>What is locally cached today, for the record: `~/.local/share/uv/python/`
  contains `cpython-3.11-macos-x86_64-none` and `cpython-3.11.15-macos-x86_64-none`. Useful for a
  quick local experiment; **not** an input to the pin.
- **Node↔Python contract: HTTP over the compose network with a Zod-validated JSON body.**
  **Rejected:** a shared database table as the interface (two writers, two migration owners,
  ADR-002 violation) and `child_process.spawn` of a Python script from Node (no health check, no
  independent scaling, no clean restart, and it drags the Python runtime into the app image).
- **Container manifest grows** to poppler + qpdf + ghostscript + imagemagick + the chosen engine's
  full native stack. Expect a multi-GB image and re-read §2.2: **8.32 GB of Docker memory is not
  enough** for app + postgres + a torch-CPU OCR container under load.
- **The `~/.EasyOCR/model/*.pth` weights (290 MB, Thai + CRAFT) are already on disk**, which
  shortens the first benchmark on this branch specifically.

### The probe — ⚠ SUPERSEDED, use the committed scripts instead

> **Do not run the snippet below.** When this document was first drafted, no probe tooling
> existed. It now does, and it is materially safer:
>
> - `/Users/innovera/Documents/OCR/docs/m0/discovery/probe_ai_gateway.py` (1172 lines) — **preferred**
> - `/Users/innovera/Documents/OCR/docs/m0/discovery/probe-ai-gateway.sh` (676 lines) — curl+jq twin
>
> Both are **read-only diagnostic tooling, not application code**, both default to **dry-run**
> (they print the requests they would make and open no sockets until `--run` is passed), and both
> carry an enforced safety contract: the API key is never echoed beyond its first 6 characters,
> public model providers are refused by hostname check, probe images are **synthetic and generated
> in-process**, `--max-time` is set on every call, there are no retries, and redirects are **not**
> followed (a 3xx is reported as a security finding rather than chased).
>
> **Neither has ever been executed against a real gateway.** No INNOVERA LiteLLM endpoint or
> credential was available during M0.
>
> The snippet below is retained **only** to document what the probe checks and why the third step
> is the branch decider. Two specific defects in it are the reason it is superseded, and both are
> worth naming because they are easy to reintroduce:
>
> 1. **`-H "Authorization: Bearer $AI_API_KEY"` puts the credential in `argv`**, where any local
>    process can read it from `ps`, and where it lands in shell history. The committed scripts read
>    the key from the environment and pass it via a header file / stdin.
> 2. **`base64 -i ./one-line-thai.png`** implies sending a *real document image* to an endpoint
>    whose identity, TLS posture, and logging behaviour are by definition not yet verified — the
>    first thing we would ever send it would be confidential content. The committed scripts
>    generate a synthetic image instead. **Never probe an unverified endpoint with real customer
>    data.**

```bash
# ⚠ SUPERSEDED — ILLUSTRATIVE ONLY. Run docs/m0/discovery/probe_ai_gateway.py instead.
# 1. Does the gateway answer, and what does it serve?
curl -sS -H "Authorization: Bearer $AI_API_KEY" "$AI_BASE_URL/v1/models" | jq .

# 2. Text round-trip (proves auth + a working chat route)
curl -sS -X POST "$AI_BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $AI_API_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"<id-from-step-1>","max_tokens":16,
       "messages":[{"role":"user","content":"ตอบว่า OK"}]}' | jq .

# 3. THE BRANCH DECIDER — send one small PNG as a data URI.
#    HTTP 200 with a sensible answer  → Branch V.
#    400/422 mentioning image/content type, or a text-only reply → Branch T.
IMG=$(base64 -i ./one-line-thai.png | tr -d '\n')
curl -sS -X POST "$AI_BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $AI_API_KEY" -H 'Content-Type: application/json' \
  -d "{\"model\":\"<id>\",\"max_tokens\":64,\"messages\":[{\"role\":\"user\",\"content\":[
        {\"type\":\"text\",\"text\":\"อ่านข้อความในภาพ\"},
        {\"type\":\"image_url\",\"image_url\":{\"url\":\"data:image/png;base64,$IMG\"}}]}]}" | jq .
```

Record the raw responses under `docs/m0/discovery/` as evidence. **Never infer the answer from a
model name.** A `-VL` suffix in a model id is a naming convention, not a capability guarantee —
the deployed weights or the vLLM launch flags may differ.

---

## 10. Corrections to the orchestrator's ground truth

| Claim in the brief | Status | Correct fact + evidence |
|---|---|---|
| "Apple Silicon (`/opt/homebrew` present)" | **WRONG** | Intel Core i5-1038NG7, `uname -m` → `x86_64`, `hw.optional.arm64` does not exist, `/opt/homebrew` does not exist, brew is `/usr/local/bin/brew` |
| "Python: system Python only (3.9.6). No pyenv/conda on PATH" | **INCOMPLETE** | True about pyenv/conda, but `uv` is installed and `python3.11` → CPython **3.11.15** is on PATH at `~/.local/bin/python3.11` |
| "tesseract NOT installed. paddleocr NOT installed" | **CONFIRMED, and wider** | Also absent: `pdftoppm`, `pdfinfo`, `gs`, `qpdf`, `mutool`, `magick`, `convert`, `soffice` |
| "EasyOCR Thai weights exist" | **CONFIRMED** | `~/.EasyOCR/model/thai.pth` 215 384 298 B, `craft_mlt_25k.pth` 83 152 330 B, both 2026-06-02 |
| INNOVERA house stack versions (Next 16.2.12 / TS 6.0.3 / Prisma 7.9.1 / …) | **ACCURATE as a description of jawbong** | But several are stale for a *new* project — see §3 |
| "No LiteLLM/vLLM/Qwen config on this machine" | **NOT CONTRADICTED** | I found nothing that overturns it |
| Docker "running" | **CONFIRMED, with a caveat** | Engine 29.5.2, compose v5.1.3, `linux/x86_64`, **but only 7.75 GiB of the host's 32 GiB allocated** — the real M2 constraint |

All rows above were independently re-verified during the review pass. The Intel correction is
additionally corroborated by `m-docker-nginx-resources.md` §0.1, `d-ocr-engine.md` §0, and
`b-ai-topology-discovery.md` — four dimensions reached it independently from the same commands.

## 10.1 Cross-document reconciliation — where this document and its siblings disagree

**New in the review pass.** Ten sibling M0 dimension documents now exist (§1). They were written in
parallel, from the same brief, and several of them consumed the *orchestrator's* stack summary —
which quotes the **jawbong** pins — rather than §3 of this document. The result is a corpus that
contradicts itself on versions. This table is the reconciliation. **Nothing below is a matter of
opinion; each row has a designated owner and a winner.**

| Topic | This document (A) | Sibling | Winner | Action required |
|---|---|---|---|---|
| **Node** | `24.21.0` (§3.1) | `m-docker-nginx-resources.md` O4 / §2.3: `node:22.23.1-bookworm-slim` in three Dockerfile stages | **A** | Update `docker/web.Dockerfile` `FROM` lines to `node:24.21.0-bookworm-slim` |
| **Next.js** | `16.3.4` (§3.2 — security-relevant) | M §2.3, §2.7.2, §2.9, evidence appendix: "Next.js 16.2.12" (7 occurrences) | **A** | Global replace in M; re-check the tmpfs fetch-cache question against 16.3.4 |
| **pnpm** | `12.3.4` (§3.7) | M: `pnpm 11.18.0` | **A** | — |
| **Prisma** | `7.10.0`, CLI/client lockstep enforced (§3.4) | M evidence appendix: `7.9.1` | **A** | — |
| **Zod** | `4.5.4` (§3) | `h-queue-and-worker-contract.md` L10: "Zod 4.4.3 schemas in the Next repo" | **A** | L10's *mechanism* (`z.toJSONSchema()` → committed JSON Schema → Pydantic) is unaffected by the version bump; only the pin changes |
| **Python** | ~~3.11.15~~ → **3.13** (§9, corrected) | M O5: `python:3.13-slim-bookworm` | **M** | A corrected in this pass |
| **Queue design** (`ocr_jobs` schema, claim, retry, fairness, DLQ, cancellation) | Prior art + constraints only (§5) | `h-queue-and-worker-contract.md` L1–L21 | **H** | A's §5.5 defers explicitly |
| **Fencing token** | ~~timestamp `WHERE lockedAt = $2`~~ | H L4: random UUID `lease_token`, 120 s lease, 30 s heartbeat | **H** | A withdrew its proposal in this pass (§5.5) |
| **Error detail storage** | jawbong's `error.name` | H L21: closed error-code enum + allow-listed redacted detail; raw messages never persisted | **H** | A corrected in this pass (§5.5) |
| **Redis / BullMQ** | Rejected (§5.5) | H §5: rejected, with a fuller cost analysis and five named reversal triggers (T1–T5) | **agree** | Cite H §5.3 as the trigger list rather than restating it |
| **Edge proxy** | Caddy in-stack (A-7) | M §3.1: host-determined; adds the host-NGINX case | **both** | A-7 is the default; M §3.1 owns the host-NGINX variant. A amended in this pass (§8.5) |
| **Docker memory** | 7.75 GiB, owner asked to raise to 16 GB | M §0.2: identical figure, identical ask | **agree** | One ask, not two — do not double-count it in the owner questions |
| **AI gateway** | UNRESOLVED (§9) | `b-`, `c-`, and the two probe scripts: also UNRESOLVED | **agree** | No document may assert a model, endpoint, or capability |

**Process consequence, and it is the important one:** this drift happened because parallel authors
each re-derived the stack from the orchestrator's summary. The fix is not to re-verify versions in
every document. It is to have **exactly one** of them own the pins and have the others cite it.
This document is that one. When `process/context/all-context.md` is written (§6.2), §3.7 is what it
should record, and every Dockerfile, CI workflow, and `package.json` in the repo must derive from
there.

---

## 11. Open questions for the owner

1. **AI gateway** — base URL, auth, and model ids for the INNOVERA LiteLLM/vLLM stack. Blocks
   M0 items C/D/E and picks Branch V vs T. The §9 probe resolves it in minutes.
2. **Docker Desktop memory** — may we ask you to raise it from 8 GB to 16 GB before M2?
3. **Deployment target** — is OCR going to a fresh host (in-stack Caddy, §8.5) or an existing
   VPS that already owns 80/443 (TCL label-join)? This changes the compose overlay.
4. **Node 26 bump window** — Node 26 becomes Active LTS on 2026-10-28, inside M1. Bump then, or
   hold on 24 through M2?
5. **Git remote** — `~/Documents/OCR` is not a repo. Which GitHub org/name? (TCL uses
   `github.com/innovera2025/tcl`.)
6. **Retention & residency** — how long may uploaded documents and extracted text persist, and
   must they stay in-country? This drives the storage adapter, the encryption-at-rest key (and
   whether it is an irreversible secret like TCL's `PIN_PEPPER`), and the backup design.

**Added in the review pass:**

7. **Thai collation is an irreversible `initdb` choice** (§5.6.3). Confirm before the first
   migration that ICU `th-TH` is acceptable, because changing it afterwards requires a dump and
   restore of the entire cluster. There is no "we'll fix it in M3" for this one.
8. **Which language does the *primary* sort follow when a tenant's documents mix Thai and English
   filenames?** ICU `th-TH` handles both, but the interleaving of Latin and Thai will look
   arbitrary to some users. This is a product decision, not a technical one, and it should be made
   before the document-list UI is designed.
9. **Are Buddhist-Era dates expected in the *output*, or only in the input?** §5.6.5 specifies
   BE→CE conversion on extraction. If exported reports must render พ.ศ. back to the user, that is a
   second conversion and a formatting decision (Thai locale + `buddhist` calendar), not just an
   inverse of the first. `l-api-ui-export.md` needs the answer.
10. **Is there an existing INNOVERA git org convention beyond `innovera2025/tcl`?** Q5 asks for the
    repo name; this asks whether branch protection, required checks, and the pinned-SHA action
    policy (§7.5) are org-level settings we inherit or repo-level settings we must configure.
11. **Docker Desktop memory (16 GB) is asked for by both this document (§2.2) and
    `m-docker-nginx-resources.md` §0.2.** It is **one** request, not two.

---

## 12. Evidence index

**Files read (all read-only):**
`~/Documents/jawbong/{package.json, tsconfig.json, .nvmrc, .node-version, .npmrc, pnpm-workspace.yaml, .gitignore, .prettierrc.json, .prettierignore, next.config.ts, prisma.config.ts, dependency-cruiser.config.mjs, eslint.config.mjs, vitest.config.ts, vitest.integration.config.ts, playwright.config.ts, docker-compose.test.yml}`
· `~/Documents/jawbong/prisma/{schema.prisma, seed.ts, migrations/20260803000000_phase_00_foundation/migration.sql, migrations/migration_lock.toml}`
· `~/Documents/jawbong/src/lib/{config/env.ts, db/database-safety.ts, errors/app-error.ts, time/clock.ts, auth/actor-context.ts}` · `~/Documents/jawbong/src/instrumentation.ts`
· `~/Documents/jawbong/src/modules/outbox/{domain/outbox-event.ts, application/outbox-ports.ts, application/outbox-worker.ts, infrastructure/prisma-outbox-repository.ts, infrastructure/prisma-idempotency-repository.ts}`
· `~/Documents/jawbong/src/modules/shared/infrastructure/prisma-client.ts`
· `~/Documents/jawbong/scripts/{with-test-database.ts, verify-integration.mjs}`
· `~/Documents/jawbong/tests/{setup.ts, unit/module-boundaries.test.ts, integration/foundation-database.test.ts}`
· `~/Documents/jawbong/.github/workflows/ci.yml`
· `~/Documents/jawbong/docs/architecture/{README.md, adr-001…adr-007, module-dependency-diagram.md}`
· `~/Documents/jawbong/process/context/{all-context.md, tests/all-tests.md}`
· `~/Documents/TCL/docs/deploy-vps.md` · `~/Documents/TCL/server/{Dockerfile, Caddyfile, docker-compose.yml (head)}`
· `~/quotation-system/{docker-compose.yml, docker-compose.prod.yml, nginx.conf, deploy.sh, Dockerfile}`
· `~/deploy-krspos.sh`
· `/Users/innovera/Claude/Projects/POS/{docker-compose.yml, docker-compose.prod.yml, prisma/schema.prisma (SyncJob), src/lib/krs/dispatcher.ts, src/lib/krs/dispatchConstants.ts}`
· `/Users/innovera/CLAUDE.md`

**Not read, deliberately:** every `.env` / `.env.example` (privacy hook). Env *key names* only
were extracted from jawbong with `grep -oE '^[A-Z_]+='`; no values were read.

**Commands run:** `ls -R /Users/innovera/Documents/OCR`, `uname -m`, `arch`,
`sysctl -n hw.optional.arm64 machdep.cpu.brand_string hw.memsize hw.ncpu`,
`system_profiler SPDisplaysDataType`, `df -h`, `docker info`, `docker ps`, `docker ps -a`,
`docker --version`, `docker compose version`, `node -v`, `pnpm -v`, `corepack -v`,
`python3 -V`, `~/.local/bin/python3.11 -V`, `command -v` for each of the eight native OCR
binaries, `ls -la ~/.EasyOCR/model/`, `git -C … status/log`, and greps for `redis` across the
sibling compose files.

**URLs fetched (2026-09-09):**
`registry.npmjs.org/-/package/{next,react,typescript,prisma,zod,tailwindcss,vitest,@playwright/test,eslint,dependency-cruiser,pnpm,pg}/dist-tags`
· `registry.npmjs.org/prisma/latest` · `registry.npmjs.org/prisma/7.10.0`
· `nodejs.org/dist/index.json` · `endoflife.date/api/nodejs.json` · `endoflife.date/api/postgresql.json`
· web searches for the Next.js 16 release lifecycle, the TypeScript 7.0 GA and its tooling
  limitations, and the last TypeScript 6.0 patch.

**Additional evidence gathered during the 2026-09-09 review pass:**

*Registry manifests fetched (not just dist-tags):* `next@16.3.4`, `prisma@7.10.0`,
`@prisma/client@7.10.0`, `@prisma/adapter-pg@7.10.0`, `vitest@5.0.0`, `@vitest/coverage-v8@5.0.0`,
`jsdom@30.0.1`, `@testing-library/react@16.3.3`, `eslint-config-next@16.3.4`,
`eslint-plugin-boundaries@7.2.0`, `typescript-eslint@8.70.0`, `eslint-plugin-import@2.32.0`,
`eslint-plugin-react-hooks@7.1.1` — each for `engines`, `peerDependencies`,
`peerDependenciesMeta`, and `dependencies`.
· `nodejs.org/en/about/previous-releases` (via WebFetch, because the Bash path to
`nodejs.org/dist/index.json` is blocked by a repo hook).

*Files re-read to verify every quotation in this document character-by-character:*
`~/Documents/jawbong/{package.json, .npmrc, .nvmrc, .node-version, pnpm-workspace.yaml,
dependency-cruiser.config.mjs, eslint.config.mjs, vitest.config.ts, vitest.integration.config.ts,
playwright.config.ts, docker-compose.test.yml, .github/workflows/ci.yml, prisma/schema.prisma}`
· `~/Documents/jawbong/src/lib/db/database-safety.ts`
· `~/Documents/jawbong/src/modules/outbox/{domain/outbox-event.ts, application/outbox-worker.ts,
infrastructure/prisma-outbox-repository.ts, infrastructure/prisma-idempotency-repository.ts}`
· `/Users/innovera/Claude/Projects/POS/src/lib/krs/{dispatcher.ts, dispatchConstants.ts}`
· `~/deploy-krspos.sh` (lines 1–75, the six stages)
· `/Users/innovera/Documents/OCR/docs/architecture/m0/{h-queue-and-worker-contract.md,
m-docker-nginx-resources.md, j-security-threat-model.md, i-storage.md}` (frontmatter, decision
summaries, and the sections that reference this document)
· `/Users/innovera/Documents/OCR/docs/m0/discovery/{probe-ai-gateway.sh, probe_ai_gateway.py}` (headers)

*Commands run during the review pass:* `uname -m`, `arch`, `sysctl`, `docker info`,
`docker compose version`, `node -v`, `pnpm -v`, `corepack -v`, `uv --version`,
`ls ~/.local/share/uv/python/`, `command -v` for twelve native binaries (the original eight plus
`pdftotext`, `exiftool`, `libreoffice`, `mutool`), `ls -la ~/.EasyOCR/model/`,
`ls /Users/innovera/.claude/agents/ | wc -l`, `ls /Users/innovera/process/development-protocols/`,
`find /Users/innovera/Documents/OCR`.

*Thai behaviour verified empirically* (Python 3.9.6 `unicodedata`, Node v22.22.3):
canonical decomposition of U+0E33 and the Thai block; combining classes of U+0E31–U+0E3A and
U+0E47–U+0E4E; NFC equality of the two mark orders of กิ่; `parseInt`/`Number`/`\d`/`\p{Nd}` on
`"๑๒๓"`; `Array.sort` vs `localeCompare(…, "th")` on `["ไก่","กา","เข"]`.

**Not fetched, deliberately:** no request was made to any INNOVERA production host
(72.62.253.185, 52.221.213.43, 141.98.17.91, 187.52.117.52), no port scan, and no AI gateway
call. Only `registry.npmjs.org`, `nodejs.org`, and `endoflife.date` were contacted.

---

## 13. Critic Notes

**Review pass, 2026-09-09.** This section records what the adversarial critique found, what was
changed in place, and what remains genuinely unknowable in this session. The original document was
strong — its quotations are accurate, its structure is sound, and its central corrections to the
orchestrator's ground truth (Intel, not Apple Silicon; uv-installed Python 3.11) were **verified
correct and are load-bearing**. The findings below are corrections and gaps, not a rebuttal.

### 13.1 Factual errors found and corrected

| # | Claim as written | Reality | Where fixed |
|---|---|---|---|
| F1 | "a naive scaffold could put `prisma@8.0.0-rc.13` **and `@prisma/client@8.0.0-rc.13`** into a production lockfile" | `@prisma/client` and `@prisma/adapter-pg` both have `latest = 7.10.0`. Only the **CLI** resolves to the RC. The real hazard is a **CLI/client major mismatch**, which is harder to notice than a uniform RC and is not caught by npm because `@prisma/client`'s `prisma` peer is `"*"` | §3.4, A-4 |
| F2 | The ESLint 10 blocker is "`eslint-config-next`'s peer range and `eslint-plugin-boundaries`'s flat-config compatibility" | Both accept `^10` (`>=9.0.0` and `>=6.0.0`). The actual cap is the transitive **`eslint-plugin-import@2.32.0`**, whose eslint peer range ends at `^9`. Right conclusion, wrong reason — and the wrong reason would have led to re-checking the wrong packages at M1 | §3.6, A-10 |
| F3 | `workers` is "a 4th element" (§0) / "a fifth element type" (§4.4) | jawbong declares **five** elements, so `workers` is the **sixth**. The document also contradicted itself between the two statements | §0 A-5, §4.4 |
| F4 | "`minimumReleaseAgeExclude` … implying a global `minimumReleaseAge` is configured somewhere in the pnpm settings" | Neither `~/.npmrc` nor `~/.config/pnpm/rc` exists, and `minimumReleaseAge` appears in no config on this host. The exclude list is **inert**; there is no supply-chain delay window at all. Speculation presented as near-fact | §3.4, new A-12 |
| F5 | krs-pos deploy "stage **0** local preflight (`HEAD == origin/main`)" | Stage 0 performs no comparison and has no `die`; it prints a string and continues. Stages 1, 2, 5 are the real gates | §8.2 |
| F6 | Repository state: "`docs/architecture/m0/` (empty)" | Ten sibling dimension documents and two probe scripts now exist. True when written; false now, and it concealed the cross-document contradictions in §10.1 | §1 |
| F7 | "8.32 GB of the host's 32 GB" | Mixes decimal and binary units. Correct like-for-like: **7.75 GiB of 32 GiB** | §2.2, §10 |
| F8 | `eslint-plugin-boundaries: "7.1.0"`, `@testing-library/react: 16.3.2` in the recommended `package.json` | `7.2.0` and `16.3.3` are current | §3, §3.7 |
| F9 | Branch T: "Python pin **3.11.15**, matching the interpreter uv has already installed locally" | Backwards reasoning — a cached local interpreter is an accident, not a constraint, and `uv` installs any version on demand. `m-docker-nginx-resources.md` O5 pins `python:3.13` | §9 |

### 13.2 Gaps found and filled

| # | The brief asked for | What was missing | Where added |
|---|---|---|---|
| G1 | Toolchain pins for a new sibling project | **`@types/node` was never mentioned.** Pinning Node 24 while `@types/node` stays on jawbong's `22.20.1` makes `tsc --noEmit` typecheck against the wrong runtime typings — a blocking omission | §3 table, §3.7 |
| G2 | " | `@vitest/coverage-v8`, `@testing-library/*`, `jsdom`, `tsx`, `prettier`, `@types/pg`, `@types/react*` all absent from the "complete recommended `package.json` core". jawbong is **missing `@vitest/coverage-v8` entirely** while configuring `coverage.reporter` — a gap that would have been copied | §3, §3.7 |
| G3 | " | Six `UNVERIFIED:` markers left open that were cheaply closeable: `next@16.3.4` engines, `@prisma/client@7.10.0` existence, `@prisma/adapter-pg@7.10.0` existence, the vitest 5 satellite peers, `eslint-config-next` peers, `eslint-plugin-boundaries` peers. All six now closed with fetched manifests | §3.1, §3.4, §3.5, §3.6 |
| G4 | The outbox prior art, "whether it is reusable as our job queue" | **The batch-lease arithmetic was missed.** `runOnce()` drains serially under a single batch-wide lease, so the effective budget for the last item is `leaseMs − Σ(preceding durations)`. jawbong's defaults survive only if mean item duration < 3 s. At 90 s/page this produces silent duplicate execution of the batch tail, not merely a slow batch | §5.2(a) |
| G5 | " | **A poison-row deadlock was missed.** `toClaimedEvent` runs `schema.parse` *inside* the claim transaction; a throw rolls back the whole transaction including the `attempts` increment, so the row can never reach `maxAttempts` and never becomes terminal — and it aborts every row claimed alongside it. One malformed payload halts the queue permanently with no counter moving to reveal it | §5.2(b) |
| G6 | "QUOTE the real implementation" | `hashIdempotencyRequest` was quoted approvingly and recommended for verbatim copying. It hashes `JSON.stringify(payload)`, which is **key-order dependent** — the replay guard silently misclassifies both retries and key reuse | §5.3(3) |
| G7 | " | `IdempotencyRecord` declares `response` / `responseCode` columns that **no code path ever writes** — there is no `complete()` method. It is an idempotency *lock*, not a *record*. Matters more for OCR because the retried operation may already have spent money | §5.3(4) |
| G8 | " | krs-pos's own retry constants (`BASE_DELAY_MS = 30_000`, `MAX_DELAY_MS = 3_600_000`) were not quoted — only jawbong's 1 s/5 min — although the krs-pos values are the better fit for external-system failures. Its documented **run-lock gap** ("does NOT have an app-level singleton run-lock … mitigated by the UNIQUE constraint on `KRS.SalesInvoiceHdr.TransactionNo`") was also omitted, which matters because OCR has no equivalent free uniqueness | §5.4 |
| G9 | Testing conventions actually used | No CI locale (`LANG`/`LC_ALL`), no Thai fixtures, no assertion that the DB locale matches | §7.5, §7.6 |
| G10 | Deployment prior art / `.env` handling | No `.dockerignore` requirement — the house `.gitignore` keeps `.env` out of git but nothing observed keeps it out of a build context | §8.6(7) |
| G11 | "What is ABSENT locally that M2 will need" | **`pdftotext` and `exiftool` were missing from the manifest.** `pdftotext` is the most consequential omission in the list: it is the difference between a born-digital PDF costing ~20 ms and costing 90 s of OCR per page | §2.5 |

### 13.3 Thai-specific blind spots — the largest single gap

The original document specified a Postgres image, a Prisma schema, an idempotency hash, and a set
of `VarChar` columns **without once considering Thai**, in a product whose primary language is
Thai. All of the following are new in **§5.6**, and every one was verified empirically on this
machine rather than asserted:

- **T1 — Combining-mark order is never canonicalised.** Thai above-vowels have `ccc = 0`, so NFC
  does *not* reorder them relative to tone marks (`ccc = 107`). Verified: `ก`+SARA I+MAI EK and
  `ก`+MAI EK+SARA I render identically and are **not** NFC-equal. This silently breaks
  content-addressed caching, `UNIQUE` constraints, idempotency hashes, exact-match lookup, and
  engine-agreement diffing. Different OCR engines emit different orders.
- **T2 — Postgres locale was never specified.** jawbong's compose and CI use `postgres:*-bookworm`
  with no `POSTGRES_INITDB_ARGS`. Verified: codepoint order sorts `["ไก่","กา","เข"]` wrong
  (`กา เข ไก่` vs the correct `กา ไก่ เข`). Compounded by glibc collation not being version-stable,
  which silently corrupts B-tree indexes on base-image drift. This is an **`initdb`-time,
  dump/restore-to-change** decision that the document was about to let default.
- **T3 — There is no Thai full-text search in Postgres**, and there cannot be one via `to_tsvector`,
  because written Thai has no inter-word spaces. Any "we'll add FTS later" assumption is unfounded.
- **T4 — Thai digits break JS number parsing.** Verified: `parseInt("๑๒๓")` → `NaN`,
  `/^\d+$/.test("๑๒๓")` → `false`, `/^\p{Nd}+$/u` → `true`. `z.coerce.number()` yields `NaN`, which
  `z.number()` accepts without `.finite()`.
- **T5 — Buddhist-Era dates.** `2569` is CE 2026. `new Date("2569-09-09")` is valid and silently
  wrong. A thresholded rule with an explicit error band is now specified.
- **T6 — `VarChar(n)` and `.slice(n)` on Thai.** Postgres counts characters and JS counts UTF-16
  units, so they agree — but a Thai grapheme is 2–4 codepoints and truncation mid-cluster orphans a
  combining mark. `@db.Text` for extracted content; `Intl.Segmenter` for any cap.
- **T7 — Thai filenames on the HTTP boundary** need RFC 5987 `filename*=UTF-8''…` with an ASCII
  fallback.
- **A non-finding, recorded so nobody chases it:** Thai has **no canonical decompositions** — NFC
  and NFD are byte-identical for pure Thai, including SARA AM (ำ), which *looks* like a composition
  but is not. The classic macOS NFD filename hazard does not apply to Thai.

### 13.4 Security blind spots

- **S1 — §2.5 listed `ghostscript`, `imagemagick`, and `libreoffice` as dependencies with zero
  mitigation**, in a product that feeds them attacker-supplied files by design. Added §8.6:
  no-network renderer (these three are all SSRF primitives otherwise), non-root + read-only +
  `cap_drop: ALL` + `no-new-privileges`, an ImageMagick `policy.xml` disabling the delegate coders,
  explicit `-dSAFER` on Ghostscript, digest-pinned base images, and a **pixel budget** — a
  200×200-inch `MediaBox` at 300 DPI is 3.6 Gpx ≈ 14 GB, an OOM kill from one small file on a
  7.75 GiB VM.
- **S2 — The §9 probe leaked its credential via `argv`** (`-H "Authorization: Bearer $AI_API_KEY"`
  is visible in `ps` and lands in shell history) and **sent a real Thai document image** to an
  endpoint whose identity is by definition unverified. Superseded by the committed dry-run-default
  scripts, with both defects named so they are not reintroduced.
- **S3 — No supply-chain delay window** (F4). Added A-12.
- **S4 — `~/deploy-krspos.sh` reads its production SSH key from `~/Downloads`.** The document
  recommended the script as "directly reusable" without flagging this. Explicitly declined in §8.2.
- **S5 — `ALLOWED_PORTS` includes `5432`,** which on this host is `krs-pos-db`, a live POS
  database. Scoped to CI in §7.4.
- **S6 — Error-message storage leaks document content.** krs-pos stores `e.message`; an OCR
  exception message routinely embeds a filename or a fragment of extracted text. Deferred to
  `h-queue-and-worker-contract.md` L21 in §5.5.

### 13.5 Internal contradictions resolved

- "The eight decisions" while numbering reached A-9 and left two decisions unnumbered → register is
  now **A-1 … A-13**, all numbered, all with rejected alternatives and reversal triggers.
- "4th element" (§0) vs "fifth element type" (§4.4) → **sixth**, stated once.
- Decimal 8.32 GB vs binary 32 GB → both binary.
- `engines.node` as an exact string would reject Node **security patches**; widened to
  `">=24.21.0 <25"` with the exact version living in `.nvmrc` / CI / Dockerfile, and the trade-off
  stated rather than inherited silently.
- **Cross-document:** the corpus contradicted itself on Node, Next, pnpm, Prisma, Zod, Python, the
  fencing mechanism, and error storage. §10.1 is the reconciliation table, with a designated winner
  per row and the process fix (one owner for pins; everyone else cites it).

### 13.6 What remains genuinely unknowable in this session

1. **Everything about the AI gateway** (§9). Owner-blocked, not research-blocked. No endpoint,
   model id, port, capability, context window, or rate limit is knowable from this workstation, and
   none is asserted anywhere in this document.
2. **Whether `next@16.2.x` received a backport** of the two critical-severity fixes attributed to
   16.3.3. The version numbers and release ordering are verified; the **CVE identifiers and the
   backport status are not**, and remain marked `UNVERIFIED:` in §3.2. Resolve at scaffold with
   `pnpm audit` on the resolved tree plus the vendor advisory page.
3. **The exact Node 26 Active-LTS date.** `endoflife.date` says 2026-10-28; nodejs.org's published
   schedule implies 2026-11-05. Immaterial to the decision, material to the M1 gate date — §3.1
   uses the later date to avoid a premature check.
4. **The runtime behaviour of every pin.** Versions, engine ranges, and peer ranges are verified
   from registry manifests; **nothing was installed**, so no resolution was actually exercised. The
   scaffold gates in §3.4, §3.5 and §3.6 exist precisely because manifest metadata is necessary but
   not sufficient.
5. **Whether `postgres:18.6-bookworm` accepts the exact `POSTGRES_INITDB_ARGS` string in §5.6.3.**
   The ICU flags are standard `initdb` options and 18.x supports the ICU provider, but the exact
   invocation was not run — Docker was not used to start a container in this session. Verify with
   one disposable `docker compose up --wait` before the first migration, since the choice is
   irreversible.
6. **The contents of every `.env` / `.env.example`** in the sibling repositories. Deliberately not
   read (privacy hook). Only key *names* were extracted, never values — so the §8.4 `.env` rules
   describe the observed *pattern*, and the actual variable set for OCR is still to be designed.
7. **Sibling documents were read only in part** — frontmatter, decision summaries, and the
   sections that reference this document. §10.1's reconciliation is therefore complete for the
   contradictions found, but is **not** a guarantee that no other cross-document conflict exists.
   A dedicated corpus-consistency pass over all eleven M0 documents is still worth running before
   M1 planning begins.
