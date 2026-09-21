---
dimension: m-docker-nginx-resources
title: Docker topology, NGINX, resource sizing (items O, P, R)
m0_items: O, P, R
status: reviewed
date: 2026-09-09
reviewed: 2026-09-09
review_pass: adversarial completeness + fact-check (see "Critic Notes" at the end)
---

# M — Docker topology, NGINX, and resource sizing

> **Integration status (2026-09-12):** Read the [architecture index](../README.md) and its consolidation report before using these examples. Individual review labels do not close cross-document conflicts; no application implementation is verified.

**Scope.** M0 items **O** (container topology, networking, volumes, reverse proxy), **P** (resource
estimates), **R** (production impact on the existing INNOVERA estate).

**Verification posture.** Every command shown under "Evidence" was actually run in this session on
this workstation. Every URL cited was actually fetched in this session. Everything I could not
verify is prefixed **UNVERIFIED:**. No endpoint, model name, port, or capability of the INNOVERA AI
stack is asserted anywhere in this document — the two places that depend on it are designed as two
explicit branches.

**M0 changes nothing in production.** This document is a proposal. No container was started,
stopped or built; no NGINX file was written or reloaded; no package was installed; no production
host was contacted. See §5.1.

**Review-pass note (2026-09-09).** This document was subjected to an adversarial completeness and
fact-check pass. Every `docker`/`sysctl`/`lsof` claim in §0 and §5.4 was re-executed and confirmed;
every external URL that carries a decision was re-fetched. Fourteen defects were found and are fixed
in place — nine of them would have produced a broken or insecure deployment, not a cosmetic problem.
The full change list is in **"Critic Notes"** at the end of this document. The ones you should read
before anything else, because they change behaviour rather than wording:

| # | Where | What was wrong |
|---|---|---|
| C-1 | §3.3 SSE location | `proxy_set_header` has the **same inheritance rule as `add_header`** — the SSE location silently dropped `Host`, `X-Forwarded-*` and `X-Request-Id` for every streaming request. The document documented the `add_header` trap and then walked straight into its twin. |
| C-2 | §2.2 `ocr-web` / `ocr-backup` | `env_file: [.env]` injects **every** variable in `.env`, including `MIGRATE_DATABASE_URL` (superuser) and the AI key, into containers the document says must not have them. This directly contradicts §2.5.3 and §2.2's own comment. |
| C-3 | §2.2 `ocr-db` | No `shm_size:`. Docker's default `/dev/shm` is **64 MB**; PostgreSQL parallel query fails with `could not resize shared memory segment`. |
| C-4 | §2.4.5 worker Dockerfile | `fc-cache` was called but **`fontconfig` was never installed** (`--no-install-recommends` drops it). The build fails — and the Thai-font decision in §2.4.3, which is the most important correctness finding in the document, silently depends on fontconfig at *runtime* too. |
| C-5 | §3.3 TLS | `ssl_stapling on` is dead config: Let's Encrypt **stopped emitting OCSP URLs on 2025-05-07 and turned off its responders on 2025-08-06**. |
| C-6 | §2.4.2 base image | Debian 12 **bookworm left regular security support on 2026-07-12** — two months before this document's date. The document's own stated reversal trigger had already fired. |
| C-7 | §2.6.1 volume ownership | Group-shared `0770`/`0660` between two different uids does not work without the **setgid bit on the directories**; without it the worker cannot read what the web tier wrote. |
| C-8 | §2.7.3 / §5.5 | `ocr_scratch` is **one volume shared by all `ocr-worker` replicas**, and the proposed "startup sweep that empties `/scratch`" would delete another running worker's in-flight page renders. |
| C-9 | §2.1.1, §4.5, §5.7.3, §5.7.4 | The queue and schema SQL used table and column names that **do not exist** in the authoritative `g-data-model.md` / `h-queue-and-worker-contract.md` (`ocr_jobs.status/run_after` vs `extraction_jobs.state/available_at/lease_token`), and §4.5's disk estimate omitted six real tables. |

---

## 0. Corrections to the orchestrator's ground truth

Two facts in the brief are wrong and both change decisions in this dimension.

### 0.1 This is an **Intel x86_64** Mac, not Apple Silicon

```
$ uname -m                                  → x86_64
$ arch                                      → i386
$ sysctl -n machdep.cpu.brand_string        → Intel(R) Core(TM) i5-1038NG7 CPU @ 2.00GHz
$ sysctl -n hw.optional.arm64               → sysctl: unknown oid 'hw.optional.arm64'   (absent ⇒ Intel)
$ sysctl -n hw.physicalcpu hw.logicalcpu    → 4 / 8
$ sysctl -n hw.memsize                      → 34359738368   (32 GiB)
$ ls -d /opt/homebrew                       → No such file or directory
$ brew config | grep HOMEBREW_PREFIX        → HOMEBREW_PREFIX: /usr/local     (Intel prefix)
$ docker info --format '…'                  → CPUs=8 Mem=8324579328 Driver=overlayfs Server=29.5.2
$ docker compose version                    → v5.1.3
```

This independently reproduces the same correction made in `d-ocr-engine.md §0` and
`b-ai-topology-discovery.md` row 1.

**Consequence for this dimension — it is entirely good news:** there is **no dev/prod architecture
split**. Dev containers run `linux/amd64` natively (no QEMU emulation), which is the same
architecture as any commodity Linux VPS. Therefore:

- **Do not** add `platform: linux/amd64` to compose services. It is a no-op here and it would
  silently force emulation if the team later moves to an Apple Silicon machine — better to fail
  loudly then than to run 5–20× slower silently.
- **Do** pin base images by digest in production (§2.3) so that "same architecture" also means
  "same bytes".
- Wheel selection (`onnxruntime`, `opencv-python-headless`, `pypdfium2`) uses `manylinux_2_28_x86_64`
  in the container regardless of host, so the host arch only matters for *native* dev outside Docker,
  which we are not doing.

### 0.2 The binding capacity constraint is the Docker VM, not the 32 GiB host

Docker Desktop has been given **8,324,579,328 bytes ≈ 7.75 GiB** of the host's 32 GiB. Every sizing
number in §4 for the dev scenario is against 7.75 GiB, not 32 GiB.

> **Owner action (outside our M0 mandate — we must not do this):** raise Docker Desktop →
> Settings → Resources → Memory to **16 GB** before M2 container work begins.
> `a-environment-and-stack.md §2.2` raises the same ask independently.

### 0.3 Review pass: §0.1 and §0.2 re-executed and confirmed

The review pass re-ran the §0.1 commands rather than trusting the transcript. Verbatim output:

```
$ uname -m                               → x86_64
$ arch                                   → i386
$ sysctl -n machdep.cpu.brand_string     → Intel(R) Core(TM) i5-1038NG7 CPU @ 2.00GHz
$ sysctl -n hw.optional.arm64            → sysctl: unknown oid 'hw.optional.arm64'
$ sysctl -n hw.physicalcpu hw.logicalcpu → 4 / 8
$ sysctl -n hw.memsize                   → 34359738368
$ ls -d /opt/homebrew                    → No such file or directory
$ ls -d /usr/local/Homebrew              → /usr/local/Homebrew
$ docker version --format '{{.Server.Version}}'  → 29.5.2
$ docker compose version                 → Docker Compose version v5.1.3
$ docker info --format 'CPUs={{.NCPU}} Mem={{.MemTotal}}' → CPUs=8 Mem=8324579328
$ which nginx                            → nginx not found
```

**Confirmed.** The orchestrator's "Apple Silicon, `/opt/homebrew` present" is wrong; this document's
§0.1 correction stands. `/usr/local/Homebrew` (the Intel prefix) is what actually exists.

### 0.4 A third ground-truth item the review pass added: the Docker IPv4 address pool is half spent

Not in the original draft, and it matters because §2.2 asks Docker to create **two more** networks.

```
$ docker network ls --format '{{.Name}}' | while read n; do \
    echo "$n -> $(docker network inspect $n --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}')"; done

bridge                  -> 172.17.0.0/16
orderstock_default      -> 172.18.0.0/16
pos_default             -> 172.19.0.0/16
quotation-system_default-> 172.20.0.0/16
jf-w26lock_default      -> 172.21.0.0/16
jf-w29_default          -> 172.22.0.0/16
jf-lx2_default          -> 172.23.0.0/16
juneflow-linrb_default  -> 172.24.0.0/16

$ docker info --format '{{json .DefaultAddressPools}}'   → null   (i.e. the built-in default)
```

Docker's built-in default pool is `172.17.0.0/12` carved into `/16`s — **16 slots, 172.17 through
172.31.** Eight are in use. Our two networks take it to ten. The many *stopped* juneflow stacks
reclaim their subnets the moment someone runs `docker compose up` on them, and each new compose
project takes another. The failure mode when the pool is exhausted is a hard one:

```
ERROR: could not find an available, non-overlapping IPv4 address pool among the defaults
```

**Two consequences, both actioned in this revision:**

1. **Pin our subnets explicitly** (§2.2 `networks:` block) so we cannot be pushed out by whichever
   project happens to start first, and so our addresses are stable in any firewall rule.
2. **On the target VPS this is a *different* risk:** many hosting providers put the private VLAN on
   `172.16/12` or `10/8`. A Docker bridge that overlaps the provider's private network silently
   breaks the host's access to its own metadata service, block storage, or backup network. The VPS
   preflight in §5.4 now checks for the overlap before we create anything.

---

## 1. Decision summary

| # | Decision | Chosen | Rejected | Confidence | Reversibility |
|---|---|---|---|---|---|
| **O1** | Service set for M1 | `ocr-db`, `ocr-migrate` (one-shot), `ocr-web`, `ocr-worker` | adding `ocr-redis`; adding an in-stack `ocr-nginx` | high | easy |
| **O2** | Redis | **Rejected for M1.** Queue = Postgres `ocr_jobs` + `FOR UPDATE SKIP LOCKED`, on top of Jawbong's existing `outbox_events` / `idempotency_records` foundation | Redis + BullMQ | high | easy |
| **O3** | DB service **name** | `ocr-db` (never `postgres`) | `postgres`, `db` | high | hard (in `DATABASE_URL`) |
| **O4** | Web image | multi-stage `node:22.23.1-trixie-slim` + `output: 'standalone'` (**suite corrected by the review pass — see P6**) | `next start` with full `node_modules`; distroless (no shell for healthcheck/debug); `-bookworm-slim` (Debian 12 left regular security support 2026-07-12) | high | easy |
| **O5** | Worker image | multi-stage `python:3.13-slim-trixie`, `uv` for install (**REVERSED by the review pass — see P6 and §2.4.2**) | `python:3.13-slim-bookworm` (the draft's choice; Debian 12 is on LTS-only support since 2026-07-12); Alpine (musl breaks manylinux wheels) | high | easy |
| **O6** | Worker system deps | `libglib2.0-0`, `libgomp1`, Thai fonts, `ca-certificates`, `tini`. **No `libgl1`. No `poppler-utils`.** | installing `libgl1`+`libsm6`+`libxext6` cargo-cult; `poppler-utils` | high | easy |
| **O7** | OCR model weights | **Baked into the image**, digest-pinned | volume-mounted; downloaded at boot | high | moderate |
| **O8** | Networking | one **`internal: true`** back network (`ocr-internal`) + one egress network (`ocr-egress`) that **only `ocr-web` joins** | single bridge network for all services | high | easy |
| **O9** | Host port publishing | `ocr-web` → `127.0.0.1:8410:3000` only. `ocr-db` → **nothing in prod**, `127.0.0.1:8432:5432` in a dev-only overlay. `ocr-worker` → **never** | `ports: ["5432:5432"]` anywhere | high | easy |
| **O10** | Worker egress | **Denied.** `ocr-worker` gets no default route off `ocr-internal`; it holds no AI credential | letting the worker call the gateway for the vision branch | high | moderate |
| **O11** | Hardening | `no-new-privileges`, `cap_drop: ALL`, non-root `USER`, `read_only: true` on web+worker, `pids_limit`, capped json-file logging | privileged/root containers; unbounded logs | high | easy |
| **O12** | Scratch space for page renders | named volume `ocr_scratch` on **disk**, not tmpfs | tmpfs `/scratch` — tmpfs pages count against `mem_limit` and cause OOMKill on large scans (§2.7.3) | high | easy |
| **N1** | Edge terminator | **Host NGINX** (owner-managed) proxying to `127.0.0.1:8410`, *when the target host already runs NGINX*. Otherwise `caddy:2-alpine` in-stack per `a-environment-and-stack.md` A-7 | in-stack NGINX container publishing 80/443 on a host that already has a listener | high | moderate |
| **N2** | `client_max_body_size` | **Per-location**, not global. Server default `1m`; upload location `500m`; everything else inherits `1m` | one global `client_max_body_size 500m` | high | easy |
| **N3** | CSP ownership | **Next.js `proxy.ts` owns CSP** (nonce requires per-request generation). NGINX owns HSTS + the static headers | NGINX emitting a nonce CSP (impossible without body rewriting) | high | easy |
| **N4** | Upload streaming | `proxy_request_buffering off` on the upload location only | globally off (loses upstream retry on every request) | high | easy |
| **N5** | Download path | `proxy_buffering off` on the download location, to stop NGINX spooling 500 MB files to `proxy_temp` | leaving defaults on | high | easy |
| **N6** | Rate limiting | 4 zones: `ocr_api` 20r/s, `ocr_up` 2r/s, `ocr_auth` 10r/m, `ocr_conn` 20 conns | one zone for everything | high | easy |
| **P1** | Per-page OCR cost | **≈ 4.5 CPU-seconds/page** planning midpoint (range 3–6) on a modern server core, at 300 dpi greyscale A4. **ESTIMATE — must be replaced by the M2 benchmark** | quoting the vendor's Xeon numbers as ours | low-medium | n/a |
| **P2** | Per-worker RSS budget | **2.0 GB** reservation, **3.0 GB** hard limit | 1 GB (models alone are 0.6–1.2 GB per `d-ocr-engine.md §4`) | medium | easy |
| **P3** | Worker count formula | `W = min(⌊cores/threads_per_proc⌋, ⌊(mem_GB − 0.5)/2.0⌋)` with `threads_per_proc = 1` | letting ONNX Runtime auto-thread per process (oversubscription) | high | easy |
| **P4** | Storage growth | **≈ 2.0 GB per 1,000 documents** at 6 pages/doc under the "keep viewer renders" policy; **≈ 1.0 GB** under "regenerate on demand" | not deciding, then discovering it at 100k docs | medium | easy |
| **P5** | GPU for OCR | **Not used.** The GPU stays dedicated to Qwen/vLLM | putting a CUDA OCR process on the INNOVERA Chat GPU | high | hard to reverse safely |
| **R1** | LiteLLM key | **A separate virtual key** for OCR with its own `max_budget`, `budget_duration`, `rpm_limit`, `tpm_limit`, `max_parallel_requests`, `models` allowlist | reusing INNOVERA Chat's key or the master key | high | easy |
| **R2** | Host port block | `8410` (web), `8411` (worker internal), `8432` (db, dev-only) — all verified free (§5.4) | 8080 / 5432 / 1433 (all taken, §5.4) | high | easy |
| **R3** | NGINX change protocol | **Proposal only.** We hand the owner one file and one command sequence; we never run `nginx -t` or `reload` on a production host | editing prod NGINX ourselves | high | n/a |

### 1.1 Decisions added by the review pass

Same register, same rules: chosen, rejected, confidence, reversibility. These are new decisions, not
restatements.

| # | Decision | Chosen | Rejected | Confidence | Reversibility |
|---|---|---|---|---|---|
| **O13** | `ocr-db` shared memory | **`shm_size: 256mb`** on `ocr-db` | Docker's 64 MB default (breaks PostgreSQL parallel query, §2.2); `max_parallel_workers_per_gather = 0` (fixes the symptom by disabling a feature we want for the reporting queries) | high | easy |
| **O14** | Secrets into containers | **Per-service explicit `environment:` allowlist** + compose `secrets:` (files, `0400`, root-owned on the host) for `POSTGRES_PASSWORD` and the AI key | `env_file: [.env]`, which injects *every* variable in the file into the container and is how `MIGRATE_DATABASE_URL` and the AI key leak into services that must not hold them (§2.5.3) | high | easy |
| **O15** | Build context hygiene | **A `.dockerignore` is a required M1 deliverable** (§2.3.1), enforced by a CI check | relying on `COPY . .` being "obviously fine" — it is how `.env`, `.git` and 900 MB of `node_modules` get baked into a layer that `docker history` will happily show an attacker | high | easy |
| **O16** | Scratch layout under scaling | **`/scratch/<worker_id>/<job_id>/`**, swept by **mtime**, never by "empty the directory" | one flat `/scratch` shared by every replica — replica 2's startup sweep deletes replica 1's in-flight page renders (§2.7.3) | high | easy |
| **O17** | Network addressing | **Explicit `ipam.config.subnet`** on both our networks (`172.28.0.0/16`, `172.29.0.0/16`), checked against the host's routes first | letting Docker pick from a pool that is already half consumed on this box and may overlap the VPS provider's private VLAN (§0.4) | high | easy |
| **O18** | Malware-scan tier | **Named as a REQUIRED M1 service pair (`ocr-clamd` + `ocr-freshclam`) that this document does not yet size or wire.** `j-security-threat-model.md` C13/§11.4 puts it in M1; our compose omitted it entirely | silently shipping a compose file that contradicts the security dimension | high (that it is missing) / low (on its sizing) | n/a — must be resolved in M1 |
| **O19** | Container syscall filter | **Keep Docker's default seccomp profile** (do **not** set `seccomp:unconfined`), and state that explicitly; a tightened custom profile is an M2 task with its own verification | assuming `cap_drop: ALL` covers what seccomp covers — it does not; `j` §5's mitigation list names seccomp separately | high | easy |
| **N7** | OCSP stapling | **Removed.** Let's Encrypt dropped OCSP URLs from certificates on **2025-05-07** and shut its responders down on **2025-08-06** | `ssl_stapling on; ssl_stapling_verify on;` + a `resolver` — in 2026 this is dead config that only produces a startup warning and a pointless DNS dependency | high | easy |
| **N8** | Proxy headers | **A second snippet, `ocr-proxy-headers.conf`, re-included in every location that defines its own `proxy_set_header`** | assuming the `add_header` inheritance trap is the only one — `proxy_set_header` has the identical rule, and the draft's SSE location silently lost `Host` and every `X-Forwarded-*` (§3.3) | high | easy |
| **N9** | `/metrics` exposure | **`return 404` at the edge for `/metrics` and `/api/internal/`** | proxying everything under `location /` — `n-observability-testing-benchmark.md` N9 puts a Prometheus endpoint on `ocr-web`, and the draft's config published it to the internet | high | easy |
| **N10** | gzip scope | **Inside our `server` block only** | `gzip on;` in `conf.d/` (http context) — that newly enables gzip **for every other vhost on the box, including quotation-system**, which contradicts §3.7's promise that we change nothing about the incumbent | high | easy |
| **N11** | Upstream header buffers | **`proxy_buffer_size 16k; proxy_buffers 8 16k;`** | the 4k/8k default — a single Thai filename in an RFC 6266 `Content-Disposition*` header is ~9 bytes per character after UTF-8 + percent-encoding, so a 90-character Thai filename alone can exceed one buffer and produce `upstream sent too big header` → 502 (§3.3.1) | high | easy |
| **P6** | Worker/web base image | **`-trixie` (Debian 13)**, with `libglib2.0-0t64` | `-bookworm` — regular security support **ended 2026-07-12**; the document's own stated reversal trigger ("bookworm reaching EOL") has already fired (§2.4.2) | high | easy (one apt line) |
| **P7** | Per-worker memory, stated once | **3072 M per `ocr-worker` container, everywhere**, and `W` is redefined as *number of worker containers* | §4.4's formula (host-total memory), §4.2's justification (3072 M) and §4.8 Scenario 2 (2304 M) were three different numbers for the same quantity (§4.4.1) | high | easy |
| **R4** | NGINX version floor | **Preflight asserts `nginx ≥ 1.30.4` (stable) or `≥ 1.31.4` (mainline)** before we hand over any config | adding config to whatever is installed — the 1.30.4/1.31.4 releases fix **CVE-2026-42533** (buffer overflow in `map` with regex) and **CVE-2026-60005** (memory disclosure in `ngx_http_slice_module`), and we are about to ship the owner a file containing a `map` (§3.2) | high | n/a |

**Where each fix landed:** O13 §2.2 · O14 §2.2 + §2.5.4 · O15 §2.3.1 · O16 §2.7.3 · O17 §2.2 +
§5.4 · O18 §2.1 · O19 §2.7.1 · N7 §3.3 · N8 §3.3 · N9 §3.3 · N10 §3.2 · N11 §3.3.1 · P6 §2.4.2 ·
P7 §4.4.1 · R4 §3.7.2.

---

# ITEM O — Docker topology

## 2.1 Service inventory, and why there is no Redis

| Service | Image | Role | Publishes | Networks |
|---|---|---|---|---|
| `ocr-db` | `postgres:18.6-trixie` | System of record + job queue | **nothing** (prod) | `ocr-internal` |
| `ocr-migrate` | our `ocr-web` image, `target: migrate` | one-shot `prisma migrate deploy` as the **superuser** role | nothing | `ocr-internal` |
| `ocr-web` | our build, `target: runtime` | Next.js 16.2.12: upload, API, review UI, **the only holder of an AI credential** | `127.0.0.1:8410:3000` | `ocr-internal` + `ocr-egress` |
| `ocr-worker` | our build (Python) | PDF render, native extraction, OCR. Polls `ocr_jobs` | **never** | `ocr-internal` only |
| `ocr-backup` | `postgres:18.4-trixie` | nightly `pg_dump` + off-box push | nothing | `ocr-internal` |
| **`ocr-clamd`** | `clamav/clamav:<pin>` | **REQUIRED BY `j` C13 — NOT YET IN OUR COMPOSE.** Malware scan of every upload before it reaches the worker | nothing | `ocr-internal` only, **no egress** |
| **`ocr-freshclam`** | `clamav/clamav:<pin>` | **REQUIRED BY `j` C13 — NOT YET IN OUR COMPOSE.** The *only* egress-capable service in the malware tier; writes signatures to a volume `ocr-clamd` mounts read-only | nothing | `ocr-egress` |
| ~~`ocr-redis`~~ | — | **not built** — but see §2.1.2, `j` raises a session-store question this document must not answer alone | — | — |

`postgres:18.x` is the house pin, verified from
`/Users/innovera/Documents/jawbong/docker-compose.test.yml` (which pins `18.4-bookworm`). TCL uses
`postgres:16-alpine` (`/Users/innovera/Documents/TCL/server/docker-compose.yml`); Jawbong is newer
and is the reference stack, so the 18 line wins.

**Two corrections from the review pass on that pin:**

1. **The Debian suite changes from `bookworm` to `trixie`** for the same reason as the worker image
   (§2.4.2): Debian 12's regular security support ended **2026-07-12**. `postgres:18.4-trixie`
   exists on Docker Hub (verified via the registry tag API this session).
2. **18.4 is no longer the newest 18.** The registry currently serves **18.6** (`18.6`,
   `18.6-trixie`, `18.6-bookworm`, `18.6-alpine…`), verified this session. 18.4 was last pushed
   **2026-08-05**. Pinning a *minor* PostgreSQL version means pinning away from two rounds of
   fixes. **Decision: match Jawbong's line but not its frozen patch — pin `postgres:18.6-trixie` in
   M1 and add a scheduled review**, because "the house pin" should mean "the house *major*", not "the
   patch level that happened to be current when a sibling repo was written". If a strict
   byte-for-byte match with Jawbong's test database is required for some CI reason, say so
   explicitly and pin 18.4 with a comment naming that reason — do not inherit it silently.

### 2.1.0 🔴 The malware-scan tier is missing from this document's compose file

`j-security-threat-model.md` places ClamAV **in M1**, not later:

> *C13 — `freshclam` signature updater. Trusted, **the only component in the malware subsystem with
> egress**.* … *TB12 — freshclam → ClamAV mirror … the malware subsystem's only egress path, and
> therefore the only exfiltration route out of the scanning tier.* … *clamd runs as its own non-root
> user, read-only rootfs, no egress except the freshclam mirror, and is on the `--internal` network
> → §11 → **M1**.*

The draft of this document listed five services and none of them was a scanner. That is a genuine
scope hole between the security dimension and the deployment dimension, not a difference of opinion.
This revision **names it rather than papering over it**, because sizing it properly needs numbers
this document does not have:

| Unknown | Why it blocks sizing | Who answers |
|---|---|---|
| `clamd` resident memory with a current signature database | ClamAV loads the whole signature set into RAM. This is **not** a rounding error against an 8 GB VPS — it is the second-largest single allocation in the stack after the OCR models. | measure in M1; `j` §11 owns the requirement |
| Scan latency per MB, and whether it is in the upload path (synchronous, user waits) or the job path (asynchronous, `state = 'SCANNING'`) | Changes NGINX's `proxy_read_timeout` on the upload location and changes `h`'s job state machine | `j` §11 + `h` |
| freshclam update cadence and mirror egress volume | It is the *only* hole in the internal network; §5.4's port table and any VPS firewall rule must account for it | `j` §11.4 |

**M1 must not ship a compose file without this tier, and must not ship it un-sized.** Add both
services to §2.2 the moment `j`'s §11 numbers exist. The structural shape is already implied by `j`:
`ocr-clamd` on `ocr-internal` with **no** egress; `ocr-freshclam` on `ocr-egress` only, writing to a
`ocr_clamav_db` volume that `ocr-clamd` mounts `:ro`. Two containers, not one — a single container
running both would hand a compromised `clamd` the egress it must never have.

### 2.1.1 Redis: rejected, with the exact re-open trigger

`a-environment-and-stack.md §7` verified by grep that **no INNOVERA production project uses Redis** —
the four `redis:7` containers on this box (`juneflow-linrb-redis-1`, `jf-lx2-redis-1`,
`jf-w29-redis-1`, `jf-w26lock-redis-1`) belong to juneflow, not to an INNOVERA project. Adding Redis
buys a second datastore, a second durability model, a second backup surface and a second failure
mode, in exchange for a queue we already have.

The queue is Postgres.

> 🔴 **Review-pass correction (C-9).** The draft printed an invented schema here — a table called
> `ocr_jobs` with columns `status` and `run_after`, claimed by a bare `SELECT … FOR UPDATE SKIP
> LOCKED`. **None of that matches the authoritative contract.** `h-queue-and-worker-contract.md`
> owns the claim protocol and `g-data-model.md` owns the table's identity, and between them they
> specify something materially different. This document had **zero** citations of either `h` or `g`
> — the two documents whose contract it was quoting. That is fixed here and in §4.5, §5.7.3 and
> §5.7.4, which repeated the same invented names.

**The real contract, as owned by `h` and `g`:**

| Aspect | Authoritative value | Source | The draft said |
|---|---|---|---|
| Table name | **`extraction_jobs`** (`h` writes `ocr_jobs` throughout as a readability alias, to be renamed in the M1 migration) | `h` L22, `g` §ERD | `ocr_jobs` as if it were final |
| Claim shape | **one atomic `UPDATE … RETURNING`** wrapping `SELECT … FOR UPDATE SKIP LOCKED`, plus `LISTEN/NOTIFY` for wake-up | `h` L1 | a bare `SELECT`, which claims nothing |
| Fencing | **random `uuid` `lease_token`**, regenerated on every claim, guarding *every* subsequent worker write | `h` L4 — and `h` §1.1 explicitly **rejects** a timestamp lease | absent |
| Lease | **120 s**, heartbeat every **30 s** | `h` L4 / §1.1 | "the row's lock dies with the transaction" |
| Ordering | `priority DESC, available_at ASC` | `h` L22 (note `h`'s own §229 comment says `priority ASC`; L22 is the resolution row and wins) | `priority DESC, run_after ASC` |
| Retries | `max_attempts = 4` | `h` L22 | "attempt" column, no ceiling |
| Dead letter | `state = 'DEAD'` in the same table + partial index | `h` L15 | absent |
| RLS | `FORCE ROW LEVEL SECURITY`, `app.current_org`; the worker claims cross-organisation with an explicit `USING (true)` policy on the `ocr_queue` role | `h` L24/L25, `g` §266 | absent |

```sql
-- The claim, in the shape h L1/L4 actually specifies: ONE statement, atomic, fenced.
-- Table is `extraction_jobs` (g owns the name); `ocr_jobs` below would be the M1 alias.
-- Run as the `ocr_queue` role, whose RLS policy is USING (true) — NOT as ocr_app, and
-- absolutely NOT as a superuser (a superuser bypasses RLS entirely, silently).
UPDATE extraction_jobs j
   SET state            = 'PROCESSING',
       lease_token      = gen_random_uuid(),
       lease_expires_at = now() + interval '120 seconds',
       attempts         = j.attempts + 1,
       claimed_at       = now()
 WHERE j.id = (
        SELECT id
          FROM extraction_jobs
         WHERE state = 'PENDING'
           AND available_at <= now()
         ORDER BY priority DESC, available_at ASC
           FOR UPDATE SKIP LOCKED
         LIMIT 1)
RETURNING j.id, j.organization_id, j.document_id, j.page_no,
          j.attempts, j.lease_token;
```

`FOR UPDATE SKIP LOCKED` inside that `UPDATE` is what makes the claim exactly-once under
concurrency. **What survives a worker `SIGKILL` is not the row lock** — that dies with the
transaction and the row is already `PROCESSING` — **it is the expired lease**: the reaper finds rows
whose `lease_expires_at < now()` and returns them to `PENDING`. That distinction is the whole reason
`h` L4 insists on a lease token, and the draft's phrasing lost it.

**Three deployment-side consequences that this document *does* own**, and which only make sense once
the lease semantics are stated correctly:

1. **`stop_grace_period` on the worker must be reasoned against the 120 s lease, not chosen by
   feel.** See the corrected §2.8.
2. **The pre-deploy drain query in `deploy.sh` must use `state`, not `status`.** Fixed in §5.7.3.
3. **The re-run-a-bad-release query must use `state` and `available_at`.** Fixed in §5.7.4.

**Re-open Redis when — and only when — one of these is measured, not predicted:**

1. Job-claim contention makes the claim query exceed ~5 ms at p99 with `W ≥ 16` workers, **or**
2. we need a shared circuit-breaker / rate-limiter state across ≥ 2 `ocr-web` replicas
   (`c-ai-capability-probe.md §…` contemplates storing breaker state in Redis), **or**
3. we need pub/sub fan-out for SSE across replicas.

Until then the commented-out service below is the whole plan:

```yaml
  # ocr-redis:
  #   ENABLE ONLY IF one of the three triggers in docs/architecture/m0/m-docker-nginx-resources.md
  #   §2.1.1 is MEASURED. Adding this is a data-durability decision, not a convenience.
  #   image: redis:8-alpine
  #   command: ["redis-server", "--save", "", "--appendonly", "no", "--maxmemory", "256mb",
  #             "--maxmemory-policy", "noeviction"]
  #   networks: [ocr-internal]
```

Note the `--maxmemory-policy noeviction`: a queue broker that silently evicts jobs under memory
pressure is worse than no broker. If Redis ever holds jobs, it must refuse writes rather than drop
them.

---

### 2.1.2 A cross-document question this dimension must not settle by itself

`j-security-threat-model.md` carries a STRIDE row that presumes Redis **exists** in M1:

> *Spoofing — Redis reachable without auth on the internal network → **read every live session token
> → impersonate any user, including admin** … `requirepass` **and** ACL users per service
> (`ocr-web`, `ocr-worker`) with command allowlists; TLS; bound to the internal network only;
> `protected-mode yes` → **M1**.*

This document's **O2 rejects Redis for M1** on queue grounds — and that reasoning is sound, because
`h-queue-and-worker-contract.md` L1 independently chose Postgres as the queue substrate. But `j`'s
row is about **sessions**, not the queue, and the two dimensions may be talking past each other.

**Resolution required in M1, not here.** Three possibilities, and only one of them leaves O2 intact:

1. `j`'s row is conditional ("*if* a Redis is introduced, it must be authenticated"). O2 stands
   unchanged. **Most likely, and the assumption this document proceeds on.**
2. The session store genuinely needs Redis. Then O2's "no second datastore" argument is already lost
   and the queue decision should be **re-examined on its merits**, not defended by inertia — though
   `h` L1's reasoning would still likely win.
3. Sessions are database- or cookie-backed (which is what `l-api-ui-export.md`'s auth surface
   implies). O2 stands, and `j`'s row should be marked conditional.

Whoever reconciles this owns updating **both** documents in the same patch. Leaving it as two
confident, incompatible sentences in two M0 reports is the failure mode.

---

## 2.2 `docker-compose.yml` (base) — complete

Save as `docker-compose.yml` at the repo root. It is safe to `up` locally as-is (no host ports for
the DB, no secrets inline). The production overlay is §2.2.2.

```yaml
# ==============================================================================
# INNOVERA OCR AI — base compose stack
#   docs/architecture/m0/m-docker-nginx-resources.md  (items O, P, R)
#
# 🚫 No secret values in this file. Everything comes from `.env` (git-ignored),
#    which compose reads from THIS file's directory, and from `secrets/` files.
# 🚫 `ocr-db` publishes NO host port. See §2.5.2 for the mistake this prevents.
# 🚫 `ocr-worker` has NO egress and NO AI credential. See §2.5.3.
# 🚫 NO SERVICE USES `env_file:`. Every variable is listed per service, on purpose.
#    `env_file` injects the WHOLE file — including MIGRATE_DATABASE_URL and the AI
#    key — into whatever service names it. See §2.5.4 (review-pass finding C-2).
# ⚠️ MISSING FROM THIS FILE: ocr-clamd + ocr-freshclam, which j-security-threat-model.md
#    C13 places in M1. See §2.1.0. Do not treat this compose file as complete until
#    that tier is added and sized.
# ==============================================================================

name: ocr            # → containers ocr-web-1 … ; volumes ocr_postgres_data … ; network ocr_ocr-internal

x-logging: &default-logging
  driver: json-file
  options:
    max-size: "10m"      # OCR logs are voluminous; TCL uses the same cap
    max-file: "3"

x-hardening: &hardening
  security_opt:
    - no-new-privileges:true
  cap_drop:
    - ALL

services:

  # ---------------------------------------------------------------------------
  # ocr-db — system of record AND the job queue (no Redis; see §2.1.1)
  # ---------------------------------------------------------------------------
  ocr-db:
    image: postgres:18.6-trixie
    # ⚠️ NO `ports:` KEY. Intentional. Adding one is how Postgres reaches the
    #    public internet by accident — see §2.5.2 for the live example on this host.
    #
    # 🔴 REVIEW-PASS FIX C-3: shm_size. Docker gives a container a 64 MB /dev/shm by
    #    default. PostgreSQL puts its DYNAMIC shared memory there (dsm, posix) —
    #    which is what parallel query, parallel index build and parallel VACUUM use.
    #    Symptom without this line:
    #      ERROR: could not resize shared memory segment "/PostgreSQL.NNNNNNN" to
    #             N bytes: No space left on device
    #    It does NOT appear until a query actually goes parallel, so it reliably
    #    ships to production and fires on the first big report. shared_buffers is
    #    NOT affected (that is SysV/mmap, not /dev/shm) — which is exactly why the
    #    bug hides: the database starts perfectly.
    shm_size: 256mb
    environment:
      # ⚠️ ROLE NAMES ARE OWNED BY g-data-model.md §1604, NOT by this file:
      #      ocr_owner   — migrations / DDL / table owner
      #      ocr_app     — Next.js runtime, NOSUPERUSER NOBYPASSRLS
      #      ocr_queue   — the worker's claim role, RLS policy USING (true)
      #      ocr_erasure — purge only
      #    The draft called this "ocr_super" and §2.2's ocr-migrate comment called it
      #    "the SUPERUSER role". Both are wrong and dangerous: a PostgreSQL SUPERUSER
      #    BYPASSES ROW LEVEL SECURITY UNCONDITIONALLY, so running migrations — or,
      #    worse, ever reusing that URL at runtime — silently voids every tenant
      #    isolation guarantee g §302 and h L24 depend on. The bootstrap superuser
      #    below exists only to create the four roles in migration 0001; nothing
      #    else may ever use it.
      POSTGRES_USER: ${POSTGRES_USER:-ocr_bootstrap}
      POSTGRES_DB: ${POSTGRES_DB:-ocr}
      POSTGRES_PASSWORD_FILE: /run/secrets/postgres_password
      # TZ is deliberately NOT Asia/Bangkok here. See the timezone note below.
      TZ: UTC
      # Deterministic collation. A Thai-locale DB created by accident changes
      # ORDER BY results and index behaviour; pin it at initdb time and never rely
      # on the host locale. ⚠️ READ §2.2.3 BEFORE ACCEPTING THIS LINE — `--locale=C`
      # has a real, Thai-specific cost and it is a one-way door at initdb time.
      POSTGRES_INITDB_ARGS: "--encoding=UTF8 --locale=C --lc-collate=C --lc-ctype=C"
    secrets:
      - postgres_password
    command:
      - postgres
      - -c
      - shared_buffers=384MB           # ≈25% of the 1.5G mem_limit below
      - -c
      - effective_cache_size=1GB
      - -c
      - work_mem=8MB
      - -c
      - maintenance_work_mem=128MB
      - -c
      - max_connections=60             # web pool 20 + worker pool 4×W + migrate 5 + headroom
      - -c
      - wal_compression=zstd
      - -c
      - max_wal_size=2GB               # bound the checkpoint-driven disk spike (§5.5)
      - -c
      - min_wal_size=256MB
      - -c
      - timezone=UTC                   # store UTC, render Asia/Bangkok in the app
      - -c
      - log_min_duration_statement=500ms
      - -c
      - log_lock_waits=on
      - -c
      - track_io_timing=on
      - -c
      - lc_messages=C                  # keep server log lines greppable and ASCII
    volumes:
      - ocr_postgres_data:/var/lib/postgresql/data
    healthcheck:
      # $$ so the container shell expands it, not compose at parse time (TCL's note)
      test: ["CMD-SHELL", "pg_isready -U \"$$POSTGRES_USER\" -d \"$$POSTGRES_DB\" -q"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 30s
    <<: *hardening
    cap_add:
      # UNVERIFIED (not executed this session): the official postgres entrypoint runs
      # as root and `gosu postgres`-es down, so it needs these five back after
      # cap_drop:ALL. Verify with:
      #   docker compose up ocr-db  &&  docker compose logs ocr-db | grep -i 'permission denied'
      # If it fails, the fallback is `user: "999:999"` + a pre-chowned volume.
      - CHOWN
      - DAC_OVERRIDE
      - FOWNER
      - SETGID
      - SETUID
    # read_only: true is NOT set here. Postgres writes /var/run/postgresql, /tmp and
    # (on some paths) $PGDATA/pg_stat_tmp. It CAN be made read-only with tmpfs mounts,
    # but that is an M2 hardening task with its own verification, not an M1 assumption.
    # Deliberate, documented gap — see §2.7.2.
    pids_limit: 256
    # The official postgres image already sets `STOPSIGNAL SIGINT` (verified this
    # session against docker-library/postgres 18/trixie/Dockerfile), which is
    # PostgreSQL "fast shutdown" — active transactions are aborted, buffers flushed,
    # a clean shutdown record written. Do NOT override stop_signal to SIGTERM:
    # that is "smart shutdown", which WAITS for every client to disconnect, will
    # therefore burn the whole grace period, and ends in SIGKILL → crash recovery
    # on the next boot. 30 s is ample for fast shutdown at our data size.
    stop_grace_period: 30s
    restart: unless-stopped
    networks: [ocr-internal]
    logging: *default-logging
    deploy:
      resources:
        limits:   { cpus: "1.0",  memory: 1536M }
        reservations: { memory: 512M }

  # ---------------------------------------------------------------------------
  # ocr-migrate — one-shot DDL. Runs as `ocr_owner` (the TABLE OWNER), NOT as a
  # superuser — see the role note on ocr-db above and g-data-model.md §1604.
  # Copied from ~/deploy-krspos.sh / POS compose, per a-environment-and-stack.md §8.3.
  # ---------------------------------------------------------------------------
  ocr-migrate:
    build:
      context: .
      dockerfile: docker/web.Dockerfile
      target: migrate
    image: innovera/ocr-web:${OCR_VERSION:-dev}-migrate
    restart: "no"
    depends_on:
      ocr-db: { condition: service_healthy }
    environment:
      # DDL runs as ocr_owner. ocr-web must NOT get this URL — and because this
      # file uses no `env_file:`, it cannot get it by accident. (Review-pass C-2.)
      DATABASE_URL: ${MIGRATE_DATABASE_URL:?set MIGRATE_DATABASE_URL (ocr_owner role) in .env}
      # 🔴 REVIEW-PASS FIX: with `read_only: true`, HOME (/home/node) is on the
      #    read-only layer. `npx` writes to ~/.npm and `prisma` writes to
      #    ~/.cache/prisma before it does anything useful, so the container exits
      #    non-zero with EROFS and — because ocr-web depends on
      #    service_completed_successfully — the whole stack refuses to start.
      #    Redirect both to the tmpfs below.
      HOME: /tmp
      npm_config_cache: /tmp/.npm
      XDG_CACHE_HOME: /tmp/.cache
      PRISMA_HIDE_UPDATE_MESSAGE: "1"
      CHECKPOINT_DISABLE: "1"          # no telemetry call-home from a container with egress
    <<: *hardening
    read_only: true
    tmpfs: [ "/tmp:size=64m,mode=1777,nosuid,nodev" ]   # NOTE: no `noexec` — see below
    pids_limit: 128
    networks: [ocr-internal]
    logging: *default-logging

  # ---------------------------------------------------------------------------
  # ocr-web — Next.js 16.2.12. The ONLY service with an AI credential (§2.5.3).
  # ---------------------------------------------------------------------------
  ocr-web:
    build:
      context: .
      dockerfile: docker/web.Dockerfile
      target: runtime
    image: innovera/ocr-web:${OCR_VERSION:-dev}
    depends_on:
      ocr-db:      { condition: service_healthy }
      ocr-migrate: { condition: service_completed_successfully }
    # 🔴 REVIEW-PASS FIX C-2: `env_file: [ .env ]` REMOVED.
    #    `env_file` is not a "load the config" directive — it injects EVERY key in
    #    the file into the container's environment. `.env` holds MIGRATE_DATABASE_URL
    #    (ocr_owner, full DDL), POSTGRES_PASSWORD, the backup SSH target, and the AI
    #    gateway key. With `env_file` present, `docker inspect ocr-web-1` and
    #    `/proc/1/environ` inside the container both expose all of them — so the file
    #    contradicted its own comment three lines above ("ocr-web must NOT get this
    #    URL") and §2.5.3's "ocr-web is the only holder of an AI credential" became
    #    "ocr-web holds every credential in the project".
    #    Every service in this file now lists its variables explicitly. That is more
    #    typing and it is the entire point: adding a credential to a service becomes
    #    a visible diff instead of a side effect of editing an unrelated file.
    environment:
      NODE_ENV: production
      PORT: "3000"
      HOSTNAME: "0.0.0.0"          # inside the container only; the host bind is 127.0.0.1 below
      TZ: ${TZ:-Asia/Bangkok}      # display timezone; the DB stores UTC (see ocr-db)
      # V8 does not read the cgroup limit. Without this, the container is OOMKilled
      # by the kernel with no JS heap error and no stack trace. Keep it ≈ 75% of memory.
      NODE_OPTIONS: "--max-old-space-size=768"
      DATABASE_URL: ${DATABASE_URL:?set DATABASE_URL (ocr_app role, NOSUPERUSER NOBYPASSRLS) in .env}
      OCR_STORAGE_ROOT: /data/files
      OCR_PUBLIC_ORIGIN: ${OCR_PUBLIC_ORIGIN:?set the canonical https origin (CSRF origin check, j TB-CSRF)}
      MAX_UPLOAD_BYTES: ${MAX_UPLOAD_BYTES:?one number, three layers — see §3.4.3}
      NEXT_TELEMETRY_DISABLED: "1"
      # The AI gateway credential — the ONE credential this service legitimately holds.
      # File-based, not an env var: an env var is readable from `docker inspect`, from
      # any child process, and from a crash dump. A secret file is 0400 root-owned on
      # the host and mounted at a path the app reads once at boot.
      # ⚠️ UNRESOLVED: the gateway's base URL, model id and auth scheme are NOT KNOWN
      #    (b-ai-topology-discovery.md Q3/Q5/Q9). These two names are placeholders for
      #    a shape, not a claim about what the gateway is.
      AI_GATEWAY_API_KEY_FILE: /run/secrets/ai_gateway_key
      AI_GATEWAY_BASE_URL: ${AI_GATEWAY_BASE_URL:-}   # empty ⇒ AI features hard-disabled, OCR unaffected
    secrets:
      - ai_gateway_key
    # Supplementary group so this container can read/write files the WORKER created.
    # Both services share ocr_file_storage; see §2.6.1 for why the gid — and the
    # setgid bit on the directories — is load-bearing.
    group_add:
      - "10001"
    ports:
      # ⬇⬇ THE IMPORTANT PART: the 127.0.0.1 prefix. Without it this is 0.0.0.0. ⬇⬇
      - "127.0.0.1:8410:3000"
    volumes:
      - ocr_file_storage:/data/files
    healthcheck:
      # node:22-slim has no curl/wget. Use Node's own fetch, exactly as TCL does.
      test:
        - CMD
        - node
        - -e
        - "fetch('http://127.0.0.1:3000/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 45s
    <<: *hardening
    read_only: true
    tmpfs:
      - "/tmp:size=64m,mode=1777,noexec,nosuid,nodev"
      - "/app/.next/cache:size=256m,mode=0700,noexec,nosuid,nodev"
    pids_limit: 256
    stop_grace_period: 30s
    restart: unless-stopped
    networks: [ocr-internal, ocr-egress]
    logging: *default-logging
    deploy:
      resources:
        limits:   { cpus: "1.0", memory: 1024M }
        reservations: { memory: 320M }

  # ---------------------------------------------------------------------------
  # ocr-worker — Python 3.13. NO egress, NO AI credential, NO published port.
  # Scale with `docker compose up -d --scale ocr-worker=N` (see §4.4 for N).
  # ---------------------------------------------------------------------------
  ocr-worker:
    build:
      context: .
      dockerfile: docker/worker.Dockerfile
      target: runtime
    image: innovera/ocr-worker:${OCR_VERSION:-dev}
    depends_on:
      ocr-db:      { condition: service_healthy }
      ocr-migrate: { condition: service_completed_successfully }
    environment:
      TZ: ${TZ:-Asia/Bangkok}
      DATABASE_URL: ${WORKER_DATABASE_URL:?set WORKER_DATABASE_URL (ocr_queue role) in .env}
      OCR_STORAGE_ROOT: /data/files
      # 🔴 REVIEW-PASS FIX C-8: every replica mounts the SAME ocr_scratch volume.
      #    A flat /scratch means (a) two replicas can collide on a page-render
      #    filename, and (b) the "startup sweep that empties /scratch" proposed in
      #    §5.5 would delete the in-flight renders of every OTHER running replica —
      #    a data-loss bug that only appears once you scale past one worker, i.e.
      #    in production and never in dev. Each replica owns a subtree; the sweep
      #    is by mtime, never by directory. See §2.7.3.
      OCR_SCRATCH_ROOT: /scratch
      OCR_WORKER_ID: "${OCR_WORKER_ID:-}"   # empty ⇒ the worker generates a uuid4 at boot
      # Belt and braces: even if the app forgot, the effective scratch dir is
      # /scratch/<worker_id>/<job_id>/ and nothing writes to /scratch directly.
      OCR_SCRATCH_STRICT: "1"
      # One inference thread per process. We scale by PROCESS, not by thread —
      # see §4.4. Leaving these unset makes ORT/OpenBLAS each spawn ncpu threads
      # and the box thrashes at W≥2.
      OMP_NUM_THREADS: "1"
      OPENBLAS_NUM_THREADS: "1"
      MKL_NUM_THREADS: "1"
      ORT_INTRA_OP_NUM_THREADS: "1"
      # Belt and braces on the no-egress rule (§2.5.3). If a dependency ever tries
      # to phone home, it fails fast and loudly instead of hanging for 2 minutes.
      HTTP_PROXY: "http://127.0.0.1:9"
      HTTPS_PROXY: "http://127.0.0.1:9"
      NO_PROXY: "ocr-db,localhost,127.0.0.1"
      HF_HUB_OFFLINE: "1"
      TRANSFORMERS_OFFLINE: "1"
    expose:
      - "8411"                     # internal health/metrics only; never published
    volumes:
      - ocr_file_storage:/data/files
      - ocr_scratch:/scratch       # DISK, not tmpfs — see §2.7.3
    healthcheck:
      test:
        - CMD
        - python
        - -c
        - "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8411/healthz',timeout=4).status==200 else 1)"
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 90s            # model load into the ORT session is slow on first boot
    <<: *hardening
    read_only: true
    tmpfs:
      - "/tmp:size=64m,mode=1777,noexec,nosuid,nodev"
    pids_limit: 512                # OCR libs fork; 512 is generous but still a fork-bomb ceiling
    # 🔴 REVIEW-PASS: this number is not a feeling. h-queue-and-worker-contract.md L4
    #    sets a 120 s lease with a 30 s heartbeat. If stop_grace_period == the lease
    #    length, a worker that is SIGKILLed at the end of the grace period releases
    #    its row at almost exactly the moment the reaper would have taken it, which
    #    is the worst case for double-processing. Make the grace period SHORTER than
    #    the lease so a clean shutdown always wins the race, and make the worker
    #    respond to SIGTERM by (1) stopping the claim loop immediately, (2) finishing
    #    the current PAGE only, (3) writing state back under `WHERE lease_token = $1`,
    #    (4) exiting. 90 s covers one 600 dpi page with margin; it does not cover a
    #    whole 200-page document, and it must not try to.
    stop_grace_period: 90s
    restart: unless-stopped
    networks: [ocr-internal]       # ← the ONLY network. No egress.
    logging: *default-logging
    deploy:
      # Per CONTAINER, not per host. One worker PROCESS per container (§4.4.1).
      # cpus 1.5 not 2.0: the process is pinned to one inference thread by the env
      # vars above, so 2.0 was buying 1.0 idle core per replica. 1.5 leaves headroom
      # for the pypdfium2 render and the OpenCV preprocess, which are the only parts
      # that ever want a second core.
      resources:
        limits:   { cpus: "1.5", memory: 3072M }
        reservations: { memory: 2048M }

  # ---------------------------------------------------------------------------
  # ocr-backup — pg_dump + OFF-BOX push. A dump on the same disk is not a backup.
  # Structure lifted from TCL's backup sidecar (~/Documents/TCL/server/docker-compose.yml).
  # ---------------------------------------------------------------------------
  ocr-backup:
    image: postgres:18.6-trixie     # same image ⇒ pg_dump version matches the server exactly
    depends_on:
      ocr-db: { condition: service_healthy }
    # 🔴 REVIEW-PASS FIX C-2 (second instance): `env_file: [ .env ]` REMOVED here too.
    #    The backup sidecar had NO reason to hold the AI gateway key or the
    #    ocr_owner DDL URL, and with env_file it held both. It is also the one
    #    container in the stack that legitimately makes an OUTBOUND ssh connection —
    #    i.e. exactly the wrong place to keep a credential you never want to leave
    #    the box. It now gets a read-only backup role and nothing else.
    environment:
      # A dedicated, minimal role. `pg_dump` needs SELECT on everything plus
      # `pg_read_all_data` (PG 14+) — it does NOT need superuser, and giving it
      # superuser would (again) mean an RLS-bypassing credential on the network
      # boundary. Grant: GRANT pg_read_all_data TO ocr_backup;
      PGHOST: ocr-db
      PGUSER: ${BACKUP_DB_USER:-ocr_backup}
      PGDATABASE: ${POSTGRES_DB:-ocr}
      PGPASSFILE: /run/secrets/backup_pgpass
      # 🔴 THAI-SPECIFIC: LC_ALL=C is not decoration. glibc's th_TH locale renders
      #    the BUDDHIST ERA for %Y in several formats (2569, not 2026). A backup
      #    script that names files with `date` under a Thai locale produces
      #    ocr-2569-09-09.dump, which sorts wrong, breaks every retention regex,
      #    and makes "delete backups older than 14 days" delete the wrong set.
      #    `date +%F` alone is ISO and safe, but run.sh must not be the only thing
      #    standing between us and that bug. Pin the locale for the whole script.
      LC_ALL: C
      LANG: C
      TZ: ${TZ:-Asia/Bangkok}       # the SCHEDULE is local time; the FILENAMES are ISO
      BACKUP_HOUR: ${BACKUP_HOUR:-3}   # 3, not 2 — see §5.6 collision check
      BACKUP_RETAIN_DAYS: ${BACKUP_RETAIN_DAYS:-14}
      BACKUP_REMOTE: ${BACKUP_REMOTE:?set user@host:/path — a dump on this disk is not a backup}
      BACKUP_BWLIMIT_KBPS: ${BACKUP_BWLIMIT_KBPS:-5000}
    secrets:
      - backup_pgpass
      - backup_ssh_key
    volumes:
      - ocr_backups:/backups
    entrypoint: ["/bin/bash", "/backup/run.sh"]
    configs:
      - source: backup_script
        target: /backup/run.sh
    <<: *hardening
    # 🔴 REVIEW-PASS: §2.7.1 claimed "non-root USER — applied to: all". It was not.
    #    The postgres image has no USER directive; its entrypoint runs as root and
    #    gosu's down. We override the entrypoint entirely here, so without this line
    #    the backup container — the one holding an SSH key and an outbound
    #    connection — runs as UID 0. uid/gid 999 is the `postgres` user the image
    #    already creates (verified against docker-library/postgres 18/trixie).
    user: "999:999"
    read_only: true
    tmpfs:
      - "/tmp:size=32m,mode=1777,noexec,nosuid,nodev"
      - "/var/lib/postgresql:size=8m,mode=0700,uid=999,gid=999"   # ssh needs a writable HOME
    pids_limit: 128
    restart: unless-stopped
    networks: [ocr-internal, ocr-egress]   # ← needs egress for the off-box push
    logging: *default-logging
    deploy:
      resources:
        limits: { cpus: "0.5", memory: 512M }

configs:
  backup_script:
    file: ./docker/backup.sh

# ⚠️ These are FILES ON THE HOST, `chmod 0400`, owned by the user that runs compose,
#    in a directory `chmod 0700` that is in .gitignore AND in .dockerignore.
#    They are mounted read-only at /run/secrets/<name> in only the services that
#    list them. `docker inspect` shows the mount, never the content.
secrets:
  postgres_password: { file: ./secrets/postgres_password }
  ai_gateway_key:    { file: ./secrets/ai_gateway_key }
  backup_pgpass:     { file: ./secrets/backup_pgpass }   # host:port:db:user:password, mode 0400
  backup_ssh_key:    { file: ./secrets/backup_ssh_ed25519 }

networks:
  # No container on this network can reach anything off the host. Docker installs
  # no default route and no NAT rule for an `internal` network.
  #
  # 🔴 REVIEW-PASS FIX O17: subnets are PINNED. Docker's default pool is
  #    172.17.0.0/12 in /16 chunks — 16 slots — and eight are already taken on this
  #    workstation (§0.4). Unpinned, our addresses change depending on which project
  #    started first, which makes any host firewall rule referencing them a lie.
  #    On a VPS the same lack of pinning can silently overlap the provider's private
  #    VLAN. Verify these two ranges are free on the target host BEFORE `up`:
  #      ip route | grep -E '172\.(2[89])\.'   →  must print nothing
  ocr-internal:
    internal: true
    ipam:
      config:
        - subnet: 172.28.0.0/16
  # Egress-capable. ocr-web and ocr-backup join it; the WORKER never does.
  ocr-egress:
    internal: false
    ipam:
      config:
        - subnet: 172.29.0.0/16

volumes:
  ocr_postgres_data: {}   # the database. Backed up nightly. Losing this loses everything.
  ocr_file_storage: {}    # originals + derivatives. Backed up. See §2.6.
  ocr_scratch: {}         # transient page renders. NOT backed up. Safe to wipe when stopped.
  ocr_backups: {}         # local staging for pg_dump before the off-box push. Not a backup.
```

### 2.2.1 Why `deploy.resources.limits` and not the old `cpus:` / `mem_limit:` keys

Compose v2/v5 honours `deploy.resources.limits` for non-Swarm `docker compose up`. The legacy
top-level `mem_limit`/`cpus` keys still work but are v2-file-format leftovers and are not what the
Compose Specification documents. Using one style consistently avoids the classic bug where
`mem_limit` and `deploy.resources.limits.memory` disagree and the smaller silently wins.

**UNVERIFIED (not executed this session):** that `docker compose v5.1.3` applies
`deploy.resources.limits` on this machine. Verify before relying on it:

```bash
docker compose up -d ocr-web
docker inspect ocr-web-1 --format '{{.HostConfig.Memory}} {{.HostConfig.NanoCpus}}'
# expect 1073741824 1000000000  — a 0 0 means the limits were ignored and you must
# fall back to the top-level mem_limit:/cpus: keys.
```

### 2.2.2 `docker-compose.prod.yml` overlay

```yaml
# docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
#   (note: NO --build. See the `build: !reset null` note below.)
name: ocr

services:
  ocr-db:
    # Digest-pin in production. A tag is mutable; a digest is not.
    # Obtain with: docker buildx imagetools inspect postgres:18.6-trixie
    image: postgres:18.6-trixie@sha256:<PIN_ME>      # UNVERIFIED: digest not resolved in-session

  ocr-web:
    # 🔴 REVIEW-PASS FIX: the draft wrote `build: null`.
    #    Plain `null` is NOT how the Compose Specification removes an inherited
    #    attribute — it is at best undefined and at worst merged as an empty build
    #    section, which makes `docker compose config` emit a build stanza with no
    #    context and `--build` fail with an unhelpful error. The documented way to
    #    delete an attribute in an override file is the `!reset` YAML tag.
    #    (docs.docker.com/reference/compose-file/merge/ — "!reset … the target
    #     attribute gets set with type's default value or null".)
    build: !reset null            # prod pulls a pre-built, tested image; it never builds on the box
    image: innovera/ocr-web:${OCR_VERSION:?set OCR_VERSION to a git sha}
    # 🔴 REVIEW-PASS FIX: the draft restated the port "so an override can never
    #    widen it". That is FALSE and the reasoning is worth keeping, because it is
    #    a plausible-sounding belief that fails silently.
    #    Compose merges `ports` as a UNIQUE-RESOURCE LIST keyed on
    #    {ip, target, published, protocol}. Restating the identical entry dedupes to
    #    one — harmless, but it protects nothing. A *different* third file adding
    #    `"8410:3000"` (no ip) has a DIFFERENT key, so it is APPENDED, and the
    #    service ends up bound on BOTH 127.0.0.1:8410 and 0.0.0.0:8410. The wide
    #    bind wins in practice and nothing warns you.
    #    `!override` replaces the list outright, which is what was actually meant.
    ports: !override
      - "127.0.0.1:8410:3000"

  ocr-worker:
    build: !reset null
    image: innovera/ocr-worker:${OCR_VERSION:?set OCR_VERSION to a git sha}
    deploy:
      # W = number of worker CONTAINERS. See §4.4.1 for the corrected formula and
      # for why `deploy.resources.limits.memory` in the base file is PER REPLICA.
      replicas: ${OCR_WORKERS:-2}
```

**The CI check that makes the two fixes above stick** — a comment cannot enforce either of them, and
both failures are invisible in review:

```bash
# fails the build if the merged prod config still carries a build section,
# or publishes anything on a non-loopback address (this subsumes §2.5.2's check)
docker compose -f docker-compose.yml -f docker-compose.prod.yml config --no-interpolate \
| python3 - <<'PY'
import sys, yaml
cfg = yaml.safe_load(sys.stdin); bad = []
for name, svc in (cfg.get("services") or {}).items():
    if svc.get("build"):
        bad.append(f"{name}: prod config still has a build section -> use `build: !reset null`")
    for p in (svc.get("ports") or []):
        ip = p.get("host_ip") if isinstance(p, dict) else None
        if ip != "127.0.0.1":
            bad.append(f"{name}: non-loopback publish {p} -> use `ports: !override`")
if bad: print("PROD CONFIG FAILURE:\n  " + "\n  ".join(bad)); sys.exit(1)
print("prod config OK")
PY
```

And a **dev-only** overlay that is the *only* place a DB port is ever published:

```yaml
# docker-compose.dev.yml — NEVER use on a server. Referenced explicitly, never by default.
name: ocr
services:
  ocr-db:
    ports:
      - "127.0.0.1:8432:5432"   # psql -h 127.0.0.1 -p 8432. Loopback-only, and 8432 is free (§5.4).
```

---

### 2.2.3 🔴 THAI BLIND SPOT: `--locale=C` is a one-way door, and it is not free

The draft set `POSTGRES_INITDB_ARGS: "--encoding=UTF8 --locale=C --lc-collate=C --lc-ctype=C"` with
a one-line justification ("deterministic"). Determinism is genuinely the right instinct — a database
whose sort order depends on the host's glibc version is a database whose indexes silently corrupt on
a base-image bump. But the draft did not state the price, and for a **Thai-first product** the price
is specific and it cannot be paid later: **`lc_collate` is fixed at `initdb` time for the whole
cluster.** Changing it means dump, re-`initdb`, restore, and `REINDEX` everything.

**What `--lc-collate=C` actually does to Thai:**

| Operation | Under `C` | What a Thai user expects |
|---|---|---|
| `ORDER BY document_name` | UTF-8 **code-point order** | Thai dictionary order. These differ badly: Thai's five **leading vowels** (เ แ โ ใ ไ, U+0E40–U+0E44) are *written* before the consonant but *collate* after it. Under `C`, `เก` sorts after `ก` by codepoint — i.e. every word starting with a leading vowel lands in a block of its own, far from where a reader will look for it. |
| `upper()` / `lower()` | ASCII-only | Harmless — **Thai has no case.** This is the one place `C` costs nothing. |
| `LIKE` / `ILIKE 'ภาษี%'` | byte comparison, correct | correct |
| `pg_trgm` similarity | unaffected by collation | unaffected |
| B-tree index validity across glibc upgrades | **immune** — this is the win | n/a |

**Decision (unchanged, but now with the trade stated and a mitigation):** keep `--locale=C` as the
**cluster default**, because (a) it makes indexes immune to the glibc collation-version churn that
has corrupted indexes across Debian upgrades, (b) it is the only setting that is identical on a
developer's machine, in CI, and on the VPS, and (c) `g-data-model.md` §9 has already decided that
Thai *search* is solved in the application layer (newmm tokenisation → `to_tsvector('simple',
tokens)`), not by the collation.

**But add the mitigation the draft omitted:** any column a human will ever sort by name gets an
**explicit ICU collation at the column level**, which is per-column and reversible:

```sql
-- migration 0001, alongside CREATE EXTENSION pg_trgm
CREATE COLLATION IF NOT EXISTS th_icu (provider = icu, locale = 'th-TH', deterministic = true);

-- and on the columns humans sort:
ALTER TABLE documents      ALTER COLUMN title      TYPE text COLLATE th_icu;
ALTER TABLE organizations  ALTER COLUMN name       TYPE text COLLATE th_icu;
-- or, without changing the type, at query time:
SELECT ... ORDER BY title COLLATE th_icu;
```

ICU collations carry their own version, are checked by `pg_collation_actual_version()`, and — unlike
the cluster default — can be changed with a `REINDEX` of the affected indexes only.

**UNVERIFIED (not executed — there is no PostgreSQL 18 instance we may write to in this session):**
that `provider = icu, locale = 'th-TH'` is accepted verbatim by PostgreSQL 18 and that it produces
Royal-Institute Thai dictionary order rather than merely "not codepoint order". **M1 acceptance
test**, and it is a five-minute check:

```sql
-- Expect Thai dictionary order: กา, ไก่, ขา  (leading-vowel word sorts by its CONSONANT)
SELECT w FROM (VALUES ('ไก่'),('กา'),('ขา')) t(w) ORDER BY w COLLATE th_icu;
-- Compare with the C order, which will differ:
SELECT w FROM (VALUES ('ไก่'),('กา'),('ขา')) t(w) ORDER BY w COLLATE "C";
```

**Also verify at the same time** (`g` §1982 lists it as an open item): `SELECT show_trgm('ภาษี');`
— whether `pg_trgm` treats a run of Thai letters as one long "word", which determines whether the
GIN trigram index in §4.5 is the size this document assumes.

### 2.2.4 Timezone: store UTC, render Asia/Bangkok — and never let `date` see a Thai locale

The draft set `TZ: Asia/Bangkok` on **every** service including `ocr-db`. Two problems:

1. **The database should store UTC.** With `TZ=Asia/Bangkok` and no explicit `timezone` GUC, the
   server's `timezone` is inherited from the container, so `now()`, `CURRENT_TIMESTAMP` and every
   `timestamptz` render in +07:00 — which is fine until a second deployment, a DST-less-but-still-
   changed tzdata, or a `pg_dump` restored on a UTC host makes two rows that were written a second
   apart appear an hour apart. `-c timezone=UTC` is now explicit in `command:` above. Presentation
   is `l-api-ui-export.md`'s job, in the browser, where the user's real timezone lives.
2. **`TZ` on the backup container is about the *schedule*, not the *filenames*.** `BACKUP_HOUR=3`
   should mean 03:00 Bangkok, because that is when the office is asleep. The filenames must stay
   ISO/UTC-stable. Hence `LC_ALL=C` **and** `TZ=Asia/Bangkok` together on that one service, which
   looks contradictory and is not.

**The Buddhist-era trap, spelled out**, because it is the kind of thing that is discovered six months
later by a retention job: glibc's `th_TH` locale defines an era, so under `LC_ALL=th_TH.UTF-8`,
`date +%x` and several `%`-formats emit **2569**, not 2026. Any script that builds a filename,
compares a timestamp, or greps a log with a locale-dependent date format will do the wrong thing, and
`find -mtime` retention will keep everything forever. The rule for every shell script in this repo:
**`export LC_ALL=C` at the top, and use `%F`/`%s`, never `%x`/`%c`.** This is cheap and it is not
optional in a Thai-locale estate.

---

## 2.3 `docker/web.Dockerfile` — Next.js 16.2.12

### 2.3.1 🔴 First, the file the draft forgot: `.dockerignore`

The web build stage below runs `COPY . .`. Without a `.dockerignore` in the build context root, that
copies the **entire repository** into a layer — and `docker history`, `docker save`, and anyone who
can pull the image can read every byte of it. Concretely, on this project, the missing file means:

| What gets baked in | Consequence |
|---|---|
| `.env` | The AI gateway key, `MIGRATE_DATABASE_URL` (`ocr_owner`, full DDL) and `POSTGRES_PASSWORD` are inside the published image. `read_only`, `cap_drop`, non-root `USER` and the entire §2.7 hardening chapter are irrelevant against `docker save \| tar x`. **This is the single highest-severity defect the review pass found in the build.** |
| `secrets/` (added in §2.2) | Same, plus the backup SSH private key. |
| `.git/` | Full history — including any credential that was ever committed and later removed, which is the normal way credentials are "removed". |
| `node_modules/` | 400–900 MB through the build-context tarball on **every** build, defeating the `--mount=type=cache` pnpm store entirely and making `COPY . .` invalidate on any local install. |
| `.next/` | A stale local build shadowing the one the image is supposed to produce. |

`.dockerignore` is an **allowlist-shaped denylist** — start by excluding everything, then re-admit:

```gitignore
# .dockerignore — repo root. Present in M1 or the build does not ship.
# Deny by default; re-admit only what a build genuinely needs.
*

# --- source and build inputs (re-admitted) ---
!package.json
!pnpm-lock.yaml
!.npmrc
!pnpm-workspace.yaml
!next.config.ts
!tsconfig.json
!postcss.config.mjs
!prisma.config.ts
!prisma/
!public/
!src/
!messages/
!docker/

# --- and then re-deny things that slipped in under those prefixes ---
**/node_modules
**/.next
**/.turbo
**/*.log
**/.DS_Store
**/__pycache__
**/.pytest_cache
**/.venv
```

Note the deny-first (`*`) shape. The common form — a list of things to exclude — fails open: the day
someone adds `secrets/`, `credentials.json` or `dump.sql` to the repo root, it is silently in the
image. Deny-first fails closed, and the failure is a build error, which is the correct direction.

**Enforce it in CI, because a review will not catch a missing file:**

```bash
# scripts/verify-build-context.sh
set -euo pipefail
test -f .dockerignore || { echo "FAIL: no .dockerignore"; exit 1; }
# Build the context exactly as Docker would, and assert the forbidden paths are absent.
docker build --no-cache -f docker/context-audit.Dockerfile -t ocr-ctx-audit . >/dev/null
docker run --rm ocr-ctx-audit sh -c '
  for p in .env .env.local secrets .git node_modules .next; do
    if [ -e "/ctx/$p" ]; then echo "LEAKED INTO BUILD CONTEXT: $p"; exit 1; fi
  done; echo "build context clean"'
```

```dockerfile
# docker/context-audit.Dockerfile — one job: show us what the context actually contains.
FROM busybox:1.37
COPY . /ctx
CMD ["true"]
```

The same `.dockerignore` covers `docker/worker.Dockerfile`, whose `COPY --chown=ocr:ocr src/worker`
is narrower but whose context is the same directory.

### 2.3.2 The Dockerfile

```dockerfile
# syntax=docker/dockerfile:1.9
# ==============================================================================
# ocr-web — Next.js 16.2.12 / React 19.2.8 / Node 22.23.1 / pnpm 11.18.0
# House pins verified from /Users/innovera/Documents/jawbong/package.json + .nvmrc
# ==============================================================================

# ---- deps -------------------------------------------------------------------
FROM node:22.23.1-trixie-slim AS deps
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@11.18.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml .npmrc ./
# BuildKit cache mount: the pnpm store survives between builds without landing in a layer.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---- build ------------------------------------------------------------------
FROM deps AS build
COPY . .
# Prisma 7.9.1 must generate BEFORE next build; the client is imported at build time.
RUN pnpm exec prisma generate
# next.config.ts MUST carry `output: 'standalone'`.
# (Jawbong's next.config.ts does not yet — verified; add it in M1.)
#   → .next/standalone/server.js + a pruned node_modules
#   → `public` and `.next/static` are NOT copied automatically; we do it below.
#     Source: https://nextjs.org/docs/app/api-reference/config/next-config-js/output
RUN pnpm build \
 && cp -r public .next/standalone/ 2>/dev/null || true \
 && cp -r .next/static .next/standalone/.next/

# ---- migrate (one-shot target) ----------------------------------------------
# 🔴 REVIEW-PASS REWRITE. The draft's migrate stage could not work, for two reasons
#    that are both specific to pnpm and both silent until the first deploy:
#
#    1. pnpm's node_modules is a SYMLINK FARM. `node_modules/prisma` and
#       `node_modules/@prisma/*` are symlinks into `node_modules/.pnpm/<pkg>@<ver>/…`.
#       `COPY --from=build /app/node_modules/@prisma ./node_modules/@prisma` copies
#       the symlinks, whose targets are not copied — you get a directory of dangling
#       links and `Cannot find module '@prisma/client'` at runtime.
#    2. `COPY --from=build /app/node_modules/.pnpm/prisma@*/…` uses a glob against a
#       path that also contains the peer-suffixed form (`prisma@7.9.1_typescript@6.0.3`).
#       The glob may match zero entries — and a COPY that matches nothing is a build
#       ERROR, not a warning, so this fails loudly at least. Small mercy.
#
#    The fix is to stop hand-picking packages out of a pnpm store. `pnpm deploy`
#    produces a self-contained, symlink-free node_modules for exactly this purpose.
FROM node:22.23.1-trixie-slim AS migrate
ENV NODE_ENV=production \
    PRISMA_HIDE_UPDATE_MESSAGE=1 \
    CHECKPOINT_DISABLE=1
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.18.0 --activate
# `--legacy` because this is a single-package repo, not a workspace; drop it if the
# repo becomes a pnpm workspace. `--prod` prunes devDependencies but KEEPS `prisma`
# only if `prisma` is a dependency — if it is a devDependency (the common default),
# use `--prod=false` here and accept the larger one-shot image, or move `prisma` to
# `dependencies`. Decide this in M1 and write the reason in package.json.
COPY --from=build /app /src
RUN cd /src && pnpm deploy --legacy --filter . /app-deploy \
 && rm -rf /app && mv /app-deploy /app && rm -rf /src
# migrations, schema and config must be in the image, not in a volume (§2.6.3)
COPY --from=build /app/prisma           ./prisma
COPY --from=build /app/prisma.config.ts ./prisma.config.ts
USER node
# `migrate deploy` applies committed migrations only. It never generates,
# never resets, and never prompts. It is the only safe migration verb in a container.
# `pnpm exec`, not `npx`: npx will happily reach the NETWORK to fetch a missing
# `prisma`, which in a container with egress is a supply-chain hole and in one
# without egress is a two-minute hang followed by a confusing failure.
CMD ["pnpm", "exec", "prisma", "migrate", "deploy"]

# ---- runtime ----------------------------------------------------------------
FROM node:22.23.1-trixie-slim AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app

# `tini` reaps zombies and forwards SIGTERM. Without an init, `node server.js` is PID 1
# and does not reap children, and `docker compose stop` degenerates into SIGKILL.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# The standalone output is already ownership-neutral; copy it as `node` (uid 1000,
# which the node image already creates) so a read_only rootfs still works.
COPY --from=build --chown=node:node /app/.next/standalone ./
# The storage mount point must exist and be owned BEFORE the volume mounts, or
# Docker creates it root-owned and the app cannot write. (TCL hit this exact bug
# with bind-mounted config/ dirs — see its compose header comment.)
#
# 🔴 REVIEW-PASS FIX C-7: the shared-storage group.
#    ocr-web runs as `node` (uid 1000, gid 1000). ocr-worker runs as uid/gid 10001.
#    They share ocr_file_storage. §2.6.1 said "both write as gid 10001 with 0770/0660"
#    but nothing in either Dockerfile made that true, and the missing piece is not
#    the group — it is the SETGID BIT. Without `chmod 2770`, a file created by
#    `node` gets gid 1000 (node's primary group) and the worker gets EACCES on it.
#    With setgid on the directory, every file created inside it inherits gid 10001
#    regardless of who created it. The umask matters too: 0007 so the group keeps rw.
RUN groupadd -g 10001 ocrdata \
 && usermod -aG ocrdata node \
 && mkdir -p /data/files /app/.next/cache \
 && chown -R node:ocrdata /data /app/.next \
 && chmod 2770 /data /data/files

USER node
ENV UMASK=0007
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
# `sh -c` only to apply the umask; the JS process is still PID 2 under tini and
# still receives SIGTERM. If you prefer no shell, call process.umask(0o007) in
# instrumentation.ts instead — but do one of the two.
CMD ["sh", "-c", "umask 0007 && exec node server.js"]
```

**What `output: 'standalone'` buys** (verified from the Next.js docs page fetched this session):
the image ships `.next/standalone/server.js` plus only the traced subset of `node_modules`, and
`public` / `.next/static` must be copied manually — which the `RUN pnpm build && cp -r …` line
above does. Rejected alternative: shipping the full `node_modules` and running `next start`. That
is roughly 400–900 MB of `node_modules` for a large Next app versus tens of MB traced, and every
byte is CVE surface.

**Three standalone caveats the draft did not state, each of which produces a *runtime* failure in a
container that built cleanly:**

1. **The build must be run from the repo root, or file tracing under-collects.** If the Dockerfile
   ever builds from a subdirectory, set `outputFileTracingRoot` in `next.config.ts`. The symptom is
   `Cannot find module` for a transitive dependency, at request time, only for some routes.
2. **Prisma and file tracing.** Next's tracer follows `require`/`import` graphs; it does not know
   about files a library loads by computed path. Prisma 7 with `@prisma/adapter-pg` is the good case
   — driver adapters mean there is **no Rust query-engine binary** to trace — but the generated
   client lives at a path Prisma chooses, and if `prisma generate` writes to a custom `output`, that
   directory must be named in `outputFileTracingIncludes`. **M1 acceptance test:** start the runtime
   image with the DB unreachable and assert the failure is a *connection* error, not
   `Cannot find module '.prisma/client'`. The two look nothing alike and only one of them is fine.
3. **`next-intl` message catalogues** (`a-environment-and-stack.md`'s stack, `th` + `en`) are
   frequently loaded by dynamic `import(\`./messages/${locale}.json\`)`, which the tracer cannot
   resolve statically. If the Thai catalogue is missing at runtime the app does not crash — it falls
   back to the message *keys*, and you ship a Thai-first product rendering `document.upload.title`
   to Thai users. Add `messages/**` to `outputFileTracingIncludes` and assert a Thai string in a
   smoke test. **This is a Thai-specific failure mode with an English-passing test suite**, which is
   the worst combination.

---

## 2.4 `docker/worker.Dockerfile` — the Python OCR worker

This is the image where the real decisions live.

### 2.4.1 System dependency table — each line justified, each omission justified

| apt package | Needed? | Why / why not |
|---|---|---|
| `libglib2.0-0` | **YES** | `opencv-python-headless` still links `libgthread-2.0.so.0`, which lives in `libglib2.0-0`. This is the single most common "works on my machine, `ImportError` in Docker" failure. Source: [opencv-python#203 "headless package requires libglib2.0-0"](https://github.com/opencv/opencv-python/issues/203). |
| `libgomp1` | **YES** | ONNX Runtime's manylinux wheel is built with OpenMP and needs `libgomp.so.1`. Missing ⇒ `ImportError: libgomp.so.1: cannot open shared object file`. Same failure class as [spaCy#1110](https://github.com/explosion/spaCy/issues/1110). |
| `fonts-thai-tlwg` + `fonts-noto-core` | **YES — non-obvious, correctness-critical** | See §2.4.3. `fonts-noto-core` was verified this session against the Debian package page: it ships **Noto Sans Thai, Noto Serif Thai, Noto Looped Thai Regular/Bold**. Good — "Noto covers Thai" was an assumption in the draft and it happens to be true. |
| **`fontconfig`** | **YES — 🔴 THE DRAFT'S DOCKERFILE DOES NOT BUILD WITHOUT IT** | Review-pass finding C-4. §2.4.5 calls `fc-cache -f`, and `fc-cache` is shipped by **`fontconfig`**, which the Debian font packages only *Recommend*. The Dockerfile installs with `--no-install-recommends`, so `fontconfig` is absent and the build dies on `fc-cache: not found`. Worse than the build break: **PDFium's Linux font lookup goes through fontconfig at *runtime***, so even if someone "fixes" the build by deleting the `fc-cache` line, the installed Thai fonts would be invisible to the renderer and §2.4.3's entire finding would be silently undone. ~1 MB. |
| `ca-certificates` | YES | TLS to `ocr-db` if we ever enable it, and correct trust store hygiene even with no egress. ~200 KB. |
| `tini` | YES | PID 1 / signal forwarding, same reason as the web image. Matters more here: a `SIGKILL`ed worker orphans an `ocr_jobs` row until the visibility timeout. |
| `libgl1` | **NO** | This is the cargo-cult line. It is required by `opencv-python`, **not** by `opencv-python-headless`. `f-preprocessing-and-confidence.md` D1 pins `opencv-python-headless==4.14.0.94` precisely so we can omit it. Installing it pulls in Mesa + a large X/GL dependency chain for zero benefit. |
| `libsm6`, `libxext6`, `libxrender1` | **NO** | Same reason. These appear in every StackOverflow OpenCV Dockerfile and are pure X11 baggage for a headless build. |
| `poppler-utils` | **NO** | `e-native-extraction-routing.md` E4 chose **`pypdfium2` 5.13.0** (Apache-2.0 / BSD-3-Clause, prebuilt wheels, in-process, **no system deps**) over `pdf2image` + poppler. Installing poppler would (a) add a GPL-2/3 CLI to a product we intend to license commercially, (b) add a subprocess-per-page tax, (c) add ~40 MB. **If someone adds `poppler-utils` to this Dockerfile, that is a licence regression, not a convenience.** |
| `tesseract-ocr`, `tesseract-ocr-tha` | **Optional, behind a build ARG** | `d-ocr-engine.md` keeps Tesseract 5.5.3 as the air-gap *floor* engine and the M2 benchmark low-water mark. ~15 MB + language data. Gate it on `ARG WITH_TESSERACT=0` so the default production image does not carry a second engine it never calls. |
| `libpango`, `libcairo` | **NO (yet)** | Only WeasyPrint needs them, and `l-api-ui-export.md` L-17 **defers** the PDF report. Adding them now is ~60 MB of unused attack surface. Re-open when L-17 is scheduled. |
| `curl` / `wget` | **NO** | The healthcheck uses `python -c urllib` (§2.2). A container with no HTTP client is a container an attacker cannot use to pull a second stage. |

### 2.4.2 Base image: `python:3.13-slim-trixie` — the draft chose bookworm and the review overturns it

> 🔴 **REVIEW-PASS REVERSAL (C-6 / decision P6).** The draft chose `-bookworm` and wrote its own
> reversal trigger: *"**What would change this:** bookworm reaching EOL, or a wheel we need
> publishing only `manylinux_2_38`+ builds."* **That trigger had already fired when the draft was
> written.** Debian announced on **2026-07-12** that regular security support for Debian 12
> (bookworm) ended and was handed to the LTS team; bookworm LTS runs to **2028-06-30**
> ([debian.org/News/2026/20260712](https://www.debian.org/News/2026/20260712), fetched this session).
> This document is dated **2026-09-09** — two months *after* the handover.
>
> Debian LTS is real and competent, but it is a **reduced-scope, volunteer-staffed** effort with a
> different (generally slower) response profile and a narrower package set than the security team's.
> For a product whose entire premise is "secure OCR", choosing a base image that is *already* on
> reduced support at M0 — for the stated benefit of not editing one `apt` line — is the wrong trade.
> The trixie migration cost the draft itself quantified: **change `libglib2.0-0` to
> `libglib2.0-0t64`.** That is the whole migration.
>
> Everything below is preserved because the *reasoning* is still the reasoning; only the conclusion
> flips. The corrected §2.4.5 Dockerfile, the web Dockerfile, `ocr-db` and `ocr-backup` all move to
> trixie together — a stack with two Debian suites in it is a stack with two patch cadences.
>
> **What would change *this* decision (stating it properly this time, with a date):** a wheel we
> depend on failing to install on trixie's glibc 2.41, or trixie itself reaching its regular-support
> end (expected mid-2028). Re-evaluate at the **next base-image bump or 2027-06, whichever is
> sooner** — a reversal trigger with no review date is a trigger nobody pulls.

The original bookworm-vs-trixie-vs-Alpine analysis, with the conclusion corrected:

- **`numpy 2.5.3` requires Python ≥ 3.12** (verified in `f-preprocessing-and-confidence.md` §… from
  PyPI metadata), and `puremagic 2.2.0` requires ≥ 3.12 (`e-native-extraction-routing.md` §2). So
  3.13 it is. The workstation's `/usr/bin/python3` is 3.9.6 — irrelevant, this is container-only.
- **`-trixie`, and the one thing that changes.** Debian 13 (trixie) renamed the GLib runtime to
  **`libglib2.0-0t64`** as part of the 64-bit `time_t` transition; `apt-get install libglib2.0-0`
  fails outright on trixie with `Unable to locate package`. Both `python:3.13-slim-bookworm` and
  `python:3.13-slim-trixie` exist ([docker-library/python](https://github.com/docker-library/python),
  [Debian trixie `libglib2.0-0t64`](https://packages.debian.org/trixie/i386/libglib2.0-0t64)).
  Bookworm's advantages were real — familiar package names, a longer track record with scientific
  wheels, one fewer class of "the base image bumped and apt broke" incident — but they are
  *convenience* advantages, and they are now paid for with reduced security support (see the
  reversal box above). **Concretely, migrating is these three lines and nothing else:**

  | bookworm | trixie |
  |---|---|
  | `libglib2.0-0` | **`libglib2.0-0t64`** |
  | `python:3.13-slim-bookworm` | `python:3.13-slim-trixie` |
  | `node:22.23.1-bookworm-slim` | `node:22.23.1-trixie-slim` (verified to exist on Docker Hub this session, alongside `22.23.2-*`) |

  `fonts-thai-tlwg`, `fonts-noto-core`, `fontconfig`, `libgomp1`, `tini` and `ca-certificates` keep
  their names across the transition — checked, because a `t64` rename in any of *those* would have
  been a nastier surprise. **`libgomp1` in particular did not get a t64 suffix** (it exposes no
  `time_t` in its ABI), so the ONNX Runtime dependency is unaffected.
  **M1 acceptance test, one line:** `docker build --target runtime -f docker/worker.Dockerfile .`
  must succeed, and `docker run --rm <img> python -c "import cv2, onnxruntime, pypdfium2; print('ok')"`
  must print `ok`. If either fails, the wheel/glibc combination is the reason to reconsider — not a
  reason to quietly go back to an unsupported base.
- **Not Alpine.** musl is not `manylinux`. `onnxruntime`, `opencv-python-headless`, `numpy` and
  `pypdfium2` all ship glibc `manylinux_2_28_x86_64` wheels; on Alpine `pip` falls back to building
  from source (or fails). A "smaller" image that takes 25 minutes to build and yields an untested
  binary is not smaller in any dimension that matters.

### 2.4.3 Thai fonts in the **worker** — the finding most likely to be missed

The intuition is "the worker does not render text, so it does not need fonts." That is wrong, and
the failure mode is silent and severe.

`pypdfium2` rasterises PDF pages with PDFium. PDFium can only draw a glyph if the font is either
**embedded in the PDF** or **present on the system**. Thai business documents produced by older
Thai Office toolchains routinely reference `TH Sarabun New`, `Angsana New`, `Cordia New` or
`Browallia New` **without embedding them**. On a font-less container PDFium substitutes whatever it
can find, and the rendered page contains wrong glyphs, tofu boxes, or missing Thai entirely.

The OCR engine then reads that rendered page and returns **confident, well-formed, wrong text**. It
does not error. It does not lower its confidence score. The `f-preprocessing-and-confidence.md`
confidence machinery cannot detect it, because the OCR *was* confident — the corruption happened one
stage upstream.

**Decision: install `fonts-thai-tlwg`, `fonts-noto-core` AND `fontconfig` in the worker image.**
~16–26 MB. TLWG provides the Thai metric-compatible families (Garuda, Loma, Norasi, Sarabun) that
are the standard Linux substitutes for the Windows Thai fonts; Noto Core covers the fallback —
verified this session against the Debian package description, which lists **Noto Sans Thai, Noto
Serif Thai, Noto Looped Thai Regular** and **Noto Looped Thai Bold**.

> 🔴 **REVIEW-PASS FIX C-4 — the third package is the one that makes the other two work.**
> The draft installed the two font packages and then called `fc-cache -f`. `fc-cache` is shipped by
> **`fontconfig`**, which Debian font packages only *Recommend*; with `--no-install-recommends`
> (which §2.4.5 uses, correctly) it is **not installed**, and the build fails on `fc-cache: not
> found`.
>
> The build break is the *good* half of this bug. The bad half: **PDFium resolves system fonts
> through fontconfig on Linux.** If someone "fixes" the build by deleting the `fc-cache` line —
> which is the obvious fix, because the line looks like a cache warm-up — the fonts are installed
> and *invisible*, PDFium falls back exactly as if the container had no fonts, and this entire
> section's finding is silently undone. There would be no error, no warning, and no way to tell from
> the logs. **`fontconfig` is a runtime dependency of correct Thai rendering, not a build tool.**
>
> Add this to the image's own smoke test, so the regression cannot be quiet:
> ```bash
> docker run --rm innovera/ocr-worker:<sha> sh -c \
>   'fc-match "TH Sarabun New" && fc-list :lang=th | head -5'
> # Expect a Thai-capable face (e.g. Garuda / Loma / Norasi / Noto Sans Thai),
> # NOT "DejaVu Sans" — DejaVu has no Thai coverage and is the tofu answer.
> ```

**UNVERIFIED (I could not execute this):** that PDFium's fallback picks a Thai-capable face once
these are installed — `fc-match` proving fontconfig sees the font is necessary but not sufficient,
because PDFium may not be consulting fontconfig at all (see the escalation in the test below). Add
this to the M2 test corpus as a hard gate:

```
Test T-FONT-1: render a PDF that references "TH Sarabun New" without embedding it,
               once in a container WITH fonts-thai-tlwg and once WITHOUT.
               Assert the two rendered PNGs differ, and that the WITHOUT case
               produces measurably worse OCR CER. If they are identical, PDFium is
               not consulting fontconfig and we need FPDF_SetSystemFontInfo or an
               explicit font path — investigate before M2 ships.
```

Rejected alternative: "reject PDFs with non-embedded fonts". Unacceptable — that is a large slice of
the real Thai corpus, and rejecting them makes the product useless for exactly the customers we want.

**Three further Thai typography traps in this image, added by the review pass.** They are cheap to
handle now and expensive to diagnose later, and none of them appear if you test with English:

1. **Thai has no word spaces, and PDFium/fontconfig do not care — but the *renderer* does.** Thai
   line-breaking requires dictionary segmentation. This does not affect *our* rasterisation (we
   render an existing PDF; the producer already broke the lines), but it **will** affect
   `l-api-ui-export.md` L-17's PDF report if that is ever built with a naive engine. Note it here so
   the deferred WeasyPrint decision (§2.4.1's `libpango`/`libcairo` row) is made with eyes open:
   Pango does have Thai line-breaking via its `libthai` dependency, and a renderer without libthai
   will break Thai lines mid-syllable. If L-17 is scheduled, `libthai0` joins the apt list.
2. **Thai combining marks stack, and a font without the right GPOS tables renders them overlapping
   or displaced.** TLWG's fonts are built for this; a generic fallback like DejaVu is not — which is
   the concrete reason the `fc-match` smoke test above asserts the *identity* of the matched face
   and not merely that a match occurred.
3. **Thai digits (๐๑๒๓๔๕๖๗๘๙, U+0E50–U+0E59) are a distinct code block from ASCII digits.** Thai
   government and older business forms use them freely, sometimes mixed with Arabic numerals on the
   same line. Two consequences for this dimension: a font missing U+0E50–U+0E59 renders tofu where a
   *number* should be — which is the highest-value field on an invoice — and the `fc-list :lang=th`
   check above does **not** guarantee that range is covered. Extend the smoke test:
   ```bash
   docker run --rm innovera/ocr-worker:<sha> python - <<'PY'
   # every Thai-tagged face must actually carry the Thai digit block
   import subprocess
   out = subprocess.run(["fc-list", ":lang=th", "family", "charset"],
                        capture_output=True, text=True).stdout
   assert "e50" in out.lower(), "no face advertises U+0E50 (Thai digit zero)"
   print("Thai digit coverage present")
   PY
   ```
   The *interpretation* of Thai digits — that `๐๐๑๒๓` is the invoice number `00123`, and that a
   Buddhist-era year `๒๕๖๙` is CE 2026 — belongs to `f-preprocessing-and-confidence.md` and
   `k-ai-integration-and-intelligence.md`, not here. What belongs here is: **if the glyph does not
   render, no downstream layer can recover it.**

### 2.4.4 Model weights: **bake into the image**

| Option | Verdict | Reasoning |
|---|---|---|
| **Bake into the image** | **CHOSEN** | The OCR result depends on the model bytes. `f-preprocessing-and-confidence.md` puts the model version *inside* the hashed extraction payload — meaning the weights are part of the **deterministic contract**, not part of the environment. If weights live outside the image, then rolling back `innovera/ocr-worker:<sha>` does **not** roll back the model, and the audit trail lies. Also: no boot-time network, works air-gapped, one artifact to sign and scan. Cost: ~100 MB of image (PP-OCRv5 th mobile det+rec+cls via RapidOCR ≈ 50–80 MB per the RapidOCR deploy figure cited in `d-ocr-engine.md §4`; +`tessdata_best/tha`+`eng` if the Tesseract ARG is on). |
| Volume-mounted | **REJECTED** | Introduces an unversioned, mutable input to an auditable pipeline. Creates a UID-ownership problem against a non-root `USER`. Two workers on different hosts can silently diverge. The only thing it buys — hot model swap without a rebuild — is a thing we explicitly *do not want* in a system that must reproduce a 6-month-old extraction. |
| Downloaded at boot | **REJECTED, hard** | Requires egress from the worker, which §2.5.3 denies for good reasons. Makes container start depend on a third-party CDN. Worst of all, upstream re-tagging a model file changes our accuracy silently, with no diff, no review and no rollback. |

Implementation: a `models` build stage fetches and **checksums** the weights at build time, so the
network dependency exists only in CI, never in production.

### 2.4.5 The Dockerfile

```dockerfile
# syntax=docker/dockerfile:1.9
# ==============================================================================
# ocr-worker — Python 3.13, RapidOCR/ONNX (PP-OCRv5 Thai), pypdfium2, OpenCV headless
# Engine choice: docs/architecture/m0/d-ocr-engine.md §1
# Preprocessing pins: docs/architecture/m0/f-preprocessing-and-confidence.md D1
# Rasteriser: docs/architecture/m0/e-native-extraction-routing.md E4
# ==============================================================================
ARG PYTHON_TAG=3.13-slim-trixie

# ---- models: fetch + verify at BUILD time only (§2.4.4) ----------------------
FROM python:${PYTHON_TAG} AS models
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /models
# 🔴 UNRESOLVED IN M0 — THIS STAGE DOES NOT BUILD AS WRITTEN, ON PURPOSE.
#    The exact URLs + sha256 for the PP-OCRv5 Thai ONNX artefacts were NOT resolved
#    in this session, so every curl is commented out and `sha256sum -c` will fail
#    with "no properly formatted checksum lines found". That is the CORRECT failure:
#    a stage that silently produced an empty /models directory would give us a worker
#    image that starts, serves traffic, and returns garbage.
#
#    M1 must (a) resolve the three URLs from d-ocr-engine.md §3.1's cited sources,
#    (b) download each ONCE by hand, (c) record `sha256sum <file>` output in
#    docker/models.sha256, (d) uncomment. A model download without a checksum is an
#    unsigned dependency in the deterministic contract (§2.4.4) — and because
#    f-preprocessing-and-confidence.md hashes the model version into the extraction
#    payload, an unpinned model makes the audit trail a lie rather than merely a risk.
#
#    Engine/version cross-check: d-ocr-engine.md §1 pins RapidOCR 3.9.2 as the
#    executor. That version belongs in pyproject.toml/uv.lock, NOT here — but if the
#    ONNX artefacts and the RapidOCR version ever drift apart, this is the stage that
#    should fail, so record the RapidOCR version as a comment beside each checksum.
COPY docker/models.sha256 ./models.sha256
RUN set -eux; \
    # curl -fsSL -o th_PP-OCRv5_mobile_rec.onnx   "<URL — d-ocr-engine.md §3.1>"; \
    # curl -fsSL -o PP-OCRv5_mobile_det.onnx      "<URL>"; \
    # curl -fsSL -o ch_ppocr_mobile_v2.0_cls.onnx "<URL>"; \
    sha256sum -c models.sha256; \
    test "$(ls -A .)" != "models.sha256" || { echo "FATAL: no model files"; exit 1; }
# (The draft carried `--mount=type=secret,id=none` here. There is no secret named
#  "none"; the mount was a no-op that implied a secret dependency that does not
#  exist. Removed — this stage needs public egress, not a secret.)

# ---- deps: build the venv ---------------------------------------------------
FROM python:${PYTHON_TAG} AS deps
# uv 0.11.17 is already the house Python toolchain on this workstation
# (verified in b-ai-topology-discovery.md row 2: /Users/innovera/.local/bin/uv).
COPY --from=ghcr.io/astral-sh/uv:0.11.17 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy VIRTUAL_ENV=/opt/venv
RUN uv venv /opt/venv
WORKDIR /build
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --python /opt/venv/bin/python

# ---- runtime ----------------------------------------------------------------
FROM python:${PYTHON_TAG} AS runtime
ARG WITH_TESSERACT=0

# ── system deps: every line justified in §2.4.1. Do NOT add libgl1. ──
# NOTE the two review-pass changes: `libglib2.0-0t64` (trixie's t64 rename, §2.4.2)
# and `fontconfig` (without it `fc-cache` does not exist AND PDFium cannot see the
# Thai fonts at runtime — §2.4.3, finding C-4).
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      tini \
      ca-certificates \
      libglib2.0-0t64 \
      libgomp1 \
      fontconfig \
      fonts-thai-tlwg \
      fonts-noto-core \
    ; \
    if [ "$WITH_TESSERACT" = "1" ]; then \
      apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-tha tesseract-ocr-eng; \
    fi; \
    fc-cache -f; \
    # Fail the BUILD, not a customer's document, if Thai went missing.
    fc-list :lang=th | grep -qi . || { echo "FATAL: no Thai-capable font"; exit 1; }; \
    rm -rf /var/lib/apt/lists/*

# Non-root, fixed uid/gid so volume ownership is deterministic across hosts.
# gid 10001 is the SHARED storage group; ocr-web adds it as a supplementary group
# (§2.3.2) and the mount points carry the setgid bit (§2.6.1).
RUN groupadd -g 10001 ocr && useradd -u 10001 -g 10001 -m -s /usr/sbin/nologin ocr

ENV VIRTUAL_ENV=/opt/venv \
    PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    OCR_MODEL_DIR=/opt/models

COPY --from=deps   --chown=root:root /opt/venv  /opt/venv
COPY --from=models --chown=root:root /models    /opt/models
COPY --chown=ocr:ocr src/worker /app/worker
WORKDIR /app

# Mount points must exist and be owned BEFORE the volumes attach, or Docker
# creates them root-owned and a non-root process cannot write.
# setgid (2770) on /data/files so files created here are readable by ocr-web,
# which runs under a different uid with 10001 as a supplementary group (§2.6.1).
RUN mkdir -p /data/files /scratch \
 && chown -R ocr:ocr /data /scratch \
 && chmod 2770 /data /data/files /scratch

USER 10001:10001
ENV UMASK=0007
EXPOSE 8411
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "-c", "umask 0007 && exec python -m worker.main"]
```

**A note on what `EXPOSE 8411` does and does not do**, because it is load-bearing for §2.5.2's
argument and is widely misread: `EXPOSE` publishes **nothing**. It is metadata plus an
intra-network hint, and it is exactly what we want for the worker's health/metrics endpoint —
reachable from `ocr-internal`, unreachable from the host, unreachable from the internet. The
`expose:` key in §2.2 is the compose-level equivalent and is equally inert. The thing that would
publish it is a `ports:` key, and the worker must never have one.

**Estimated image size (UNVERIFIED — not built this session):**

| Layer | Size |
|---|---|
| `python:3.13-slim-trixie` | ~130 MB |
| apt deps (glib-t64, gomp, **fontconfig**, fonts, tini, ca-certs) | ~36 MB |
| venv: `onnxruntime` (~15 MB) + `opencv-python-headless` (62 MB wheel → ~200 MB installed) + `numpy` (16.7 MB wheel) + `pillow` (6.9 MB) + `pypdfium2` + `pdfplumber`/`pdfminer.six` + `openpyxl`/`python-docx`/`python-pptx` | ~420 MB |
| models | ~80 MB |
| **Total** | **≈ 665 MB** |

Wheel sizes are verified in `f-preprocessing-and-confidence.md` §… from `pypi.org/pypi/{pkg}/json`
on 2026-09-09. If the built image materially exceeds ~800 MB, the first thing to check is whether
something pulled `opencv-python` (non-headless) instead of `opencv-python-headless`.

---

## 2.5 Networking

### 2.5.1 The two-network design

```
                    ┌──────────────────── host ────────────────────┐
   internet ──443──▶│ NGINX (owner-managed, outside our compose)    │
                    │        │                                     │
                    │        └─▶ 127.0.0.1:8410                    │
                    └────────────────────┬─────────────────────────┘
                                         │  (published, loopback-only)
   ┌─────────────────────────────────────┼──────────────────────────────────┐
   │ ocr-egress  (internal: false)       │                                  │
   │   ┌──────────┐                      ▼                                  │
   │   │ ocr-web  │◀────────────────────────────  the ONLY egress-capable   │
   │   └────┬─────┘                                container. Holds the      │
   │        │  ── outbound HTTPS ──▶ INNOVERA LiteLLM gateway (UNKNOWN addr) │
   └────────┼──────────────────────────────────────────────────────────────┘
   ┌────────┼──────────────────────────────────────────────────────────────┐
   │ ocr-internal  (internal: true — no default route, no NAT)              │
   │   ┌────▼─────┐   ┌────────────┐   ┌──────────────┐   ┌─────────────┐   │
   │   │ ocr-web  │   │ ocr-worker │   │ ocr-migrate  │   │  ocr-db     │   │
   │   └──────────┘   └────────────┘   └──────────────┘   └─────────────┘   │
   │                        ▲ no egress, no AI credential, no host port     │
   └───────────────────────────────────────────────────────────────────────┘
```

`networks: { ocr-internal: { internal: true } }` is the load-bearing line. Docker installs **no
default route and no MASQUERADE rule** for an internal network, so `ocr-worker` cannot reach the
internet even if a dependency tries, and cannot reach other projects' containers on this host.

**Carry-forward warning from TCL** (`~/Documents/TCL/docs/deploy-vps.md` §4): on a *shared*
proxy network, a service literally named `postgres` can collide with another project's `postgres`
and the app silently connects to the wrong database. We are on our own private networks, so this
cannot bite us — but the mitigation is free, so `ocr-db` is the name everywhere, and
`DATABASE_URL` points at `ocr-db:5432`, never `postgres:5432`, never `localhost`.

**Second TCL warning, also carried forward:** if we ever join an existing `caddy-gen-proxy`,
**every service must be on exactly one network**, or caddy-gen round-robins across both container
IPs and you get *"502 alternating with 200, exactly 50%"* (TCL observed this in production on
2026-08-24). Our `ocr-web` is deliberately on two networks — so if the deployment target turns out
to be a caddy-gen host, `ocr-web` must be collapsed to one network and the egress path re-thought.

### 2.5.2 The exact bind syntax — and the mistake, with live evidence on this machine

```yaml
ports:
  - "127.0.0.1:8410:3000"    # ✅ loopback only. Reachable by NGINX on the host. Not by anyone else.
  - "8410:3000"              # ❌ binds 0.0.0.0 → the WHOLE INTERNET, and it bypasses ufw/firewalld
  - "0.0.0.0:8410:3000"      # ❌ identical to the above, just honest about it
```

This is not theoretical. Both the right and the wrong pattern are running on this workstation right
now:

```
$ docker ps --format 'table {{.Names}}\t{{.Ports}}'
NAMES                       PORTS
quotation-system-app        0.0.0.0:8080->80/tcp, [::]:8080->80/tcp     ← wide open
quotation-system-api        3000/tcp                                    ← ✅ expose only, no publish
quotation-system-postgres   5432/tcp                                    ← ✅ CORRECT: never published
krs-pos-db                  127.0.0.1:5432->5432/tcp                    ← ✅ CORRECT: loopback pin
orderstock-sql              0.0.0.0:1433->1433/tcp, [::]:1433->1433/tcp ← ❌ MSSQL on all interfaces

$ lsof -nP -iTCP -sTCP:LISTEN | grep docker
com.docke  41344  162u  IPv6  TCP *:8080 (LISTEN)
com.docke  41344  163u  IPv4  TCP 127.0.0.1:5432 (LISTEN)     ← the difference is visible here
com.docke  41344  164u  IPv6  TCP *:1433 (LISTEN)
```

`quotation-system-postgres` and `krs-pos-db` show the two correct patterns (`expose` only, and
`127.0.0.1:` pin). `orderstock-sql` shows the failure. **Note it is `*:1433`, i.e. IPv6 wildcard —
on a laptop behind NAT this is a LAN exposure; on a cloud VPS with a public IP it is an internet
exposure of a database.**

Three additional traps worth writing into the M1 checklist:

1. **Docker's published ports bypass `ufw`/`firewalld` on Linux.** Docker inserts its rules into the
   `DOCKER` chain, which is traversed *before* the `INPUT` chain rules ufw manages. A VPS with
   `ufw deny 5432` and `ports: ["5432:5432"]` is **still exposed**. The `127.0.0.1:` prefix is what
   actually protects you, not the firewall.
2. **`expose:` publishes nothing.** It is documentation plus an intra-network hint. Use it for
   `ocr-worker`'s `8411`. It is safe.
3. **A CI test, not a code review.** Add to the pipeline:

```bash
# fails the build if any service in the merged prod config publishes a non-loopback port
docker compose -f docker-compose.yml -f docker-compose.prod.yml config \
| python3 - <<'PY'
import sys, yaml
cfg = yaml.safe_load(sys.stdin)
bad = []
for name, svc in (cfg.get("services") or {}).items():
    for p in (svc.get("ports") or []):
        host_ip = p.get("host_ip") if isinstance(p, dict) else None
        if host_ip != "127.0.0.1":
            bad.append(f"{name}: {p}")
if bad:
    print("PORT EXPOSURE FAILURE:\n  " + "\n  ".join(bad)); sys.exit(1)
print("port bindings OK (all loopback)")
PY
```

### 2.5.3 Does `ocr-worker` get egress?

**No.** This follows directly from `b-ai-topology-discovery.md`, which states:
*"`ocr-web` is the only process in the system that holds an AI credential or opens a socket to the
gateway. `ocr-worker` performs deterministic OCR and returns text; it gets no AI credential and no
gateway route."*

That decision is unchanged by the vision-capability branch:

| Branch | Who calls the gateway | Worker egress | Notes |
|---|---|---|---|
| **T — text-in** (model UNRESOLVED) | `ocr-web` | none | Worker returns text + quads; web sends text to the gateway. Trivially satisfied. |
| **V — image-in** (model + vision capability UNRESOLVED) | **still `ocr-web`** | **still none** | Worker writes the rendered page to `ocr_file_storage`; `ocr-web` reads it and posts the image. Costs one extra read of a ~200–600 KB image over a local volume — microseconds, and worth it. |

Rejected: letting the worker call the gateway directly in branch V. It doubles the credential blast
radius, and the worker is the process that parses **attacker-supplied files** — it is precisely the
process that must not hold a network credential. `j-security-threat-model.md` rates prompt injection
from document content as *Critical / near-certain at scale*; a worker with both a parser for hostile
input and an outbound credential is the exact shape of an exfiltration primitive.

**What would change this:** if page images turn out to be so large that the extra hop dominates cost
(they do not — see §4.6), the fix is a **signed, short-lived, single-use internal token** that lets
the worker POST *through* `ocr-web`, not a gateway credential in the worker.

### 2.5.4 The other half of the credential story: `env_file` made every service a credential holder

Review-pass finding **C-2**, recorded here because §2.5.3 is where the credential invariant lives.

The draft's compose file asserted, in three separate places, that `ocr-web` is *"the ONLY holder of
an AI credential"* and that *"ocr-web must NOT get"* the `ocr_owner` DDL URL. It then wrote
`env_file: [ .env ]` on both `ocr-web` and `ocr-backup`.

`env_file` is not a config loader. **It injects every key in the file** into the named service's
environment. `.env` in this design holds `POSTGRES_PASSWORD`, `MIGRATE_DATABASE_URL` (full DDL as
the table owner), `DATABASE_URL`, `WORKER_DATABASE_URL`, the backup SSH destination and — the moment
`b-ai-topology-discovery.md` Q3 is answered — the AI gateway key. So:

- `ocr-web`, the internet-facing service, held the DDL credential. Its own compose comment said it
  must not.
- `ocr-backup`, the one container in the stack that opens an **outbound SSH connection to a machine
  we do not control**, held the AI gateway key it has no use for.
- Both are visible to anyone who can run `docker inspect`, read `/proc/1/environ` inside the
  container, or read a crash dump — i.e. to exactly the RCE-in-a-decoder scenario
  `j-security-threat-model.md` rates as a continuous CVE class.

**Fixed by three changes in §2.2**, all of which are in the file above:

| Change | Why this shape |
|---|---|
| **No `env_file:` anywhere.** Every service lists its variables explicitly. | Adding a credential to a service becomes a visible one-line diff in the compose file. With `env_file`, it is a side effect of editing an unrelated file, reviewed by nobody. |
| **`POSTGRES_PASSWORD_FILE` / `AI_GATEWAY_API_KEY_FILE` / `PGPASSFILE`**, backed by compose `secrets:` | A file at `/run/secrets/x` is not in `docker inspect`, not inherited by child processes, and not in a core dump of the parent. The postgres image supports the `_FILE` convention natively; the Node and Python sides read the file once at boot. |
| **`AI_GATEWAY_BASE_URL` defaults to empty**, and empty means *AI features hard-disabled* | The deterministic OCR path — which `d-ocr-engine.md` §1 makes the system of record — must run with **no** AI configuration at all. This makes "we have not resolved the gateway yet" a supported operating mode rather than a broken one, which matters because §6 says we may be in that mode for a while. |

**The residual risk this does *not* fix, stated plainly rather than left implied:** `ocr-web` is on
`ocr-egress`, which is an ordinary NAT'd bridge. It can reach **any** host on the internet, any
other container on this box's other networks, and the host's gateway address. We spent §2.5.3
denying the worker egress on the grounds that the process parsing hostile input must not have an
outbound channel — but `ocr-web` also handles attacker-influenced data (filenames, OCR text rendered
into the review UI, export templates) and it holds the only credential worth stealing.

`j-security-threat-model.md` §5.6 explicitly **rejected** an egress-allowlist proxy for the worker,
with a good argument: *"a proxy is an allowlist that someone will widen at 2 a.m. to unblock a
deploy, and it does not stop non-HTTP exfiltration."* That argument is about the worker, where the
answer is "no egress at all" and a proxy would be a weaker substitute for a stronger control. It
does **not** transfer to `ocr-web`, where "no egress at all" is not available — the service must
reach the gateway.

**Recommendation (new, and deliberately modest):** do not build an egress proxy in M1. Instead:

1. **Pin the egress network's subnet** (done, §2.2) so a host-level firewall rule can name it.
2. **Hand the owner one optional `iptables`/`nftables` rule** as a *proposal*, in the same
   proposal-only spirit as §3.7 — restricting `172.29.0.0/16` egress to the gateway's IP and
   `:443`, once §6 Q4 tells us what that IP is. One rule, on the host, outside our compose, owner-
   applied and owner-reversible.
3. **Log every outbound gateway call** with `request_id`, model, token counts and latency into the
   `ai_calls` ledger `n-observability-testing-benchmark.md` N12 already requires. Detection is what
   we can actually afford in M1; prevention is a follow-on.
4. **Re-open properly if `k-ai-integration-and-intelligence.md` ever gives `ocr-web` a tool-use or
   function-calling path**, because at that point the model's output can influence an outbound
   request and the risk changes category entirely. `j` line 157 already rules that output is data
   and no URL from it is ever fetched — this is the deployment-side reason that rule matters.

---

## 2.6 Volumes

| Volume | Contents | Container owner | In backup? | Losing it means |
|---|---|---|---|---|
| `ocr_postgres_data` | `$PGDATA` | `ocr-db`, uid 999 | **YES** — nightly `pg_dump -Fc`, pushed off-box | Total loss. Documents, jobs, corrections, audit trail. |
| `ocr_file_storage` | originals + kept derivatives + thumbnails, under `/data/files` per `i-storage.md` J3's key scheme | `ocr-web` **and** `ocr-worker`, both uid 10001 (web) / 10001 (worker) — **must match** | **YES** — separate mechanism (rsync/restic), *not* pg_dump | Every uploaded document. The DB rows survive and point at nothing — worse than losing both, because the UI shows documents that 404. |
| `ocr_scratch` | transient page renders at 300 dpi during OCR | `ocr-worker` | **NO** | Nothing. In-flight jobs retry. Safe to `docker volume rm` while stopped. |
| `ocr_backups` | staged `pg_dump` output before the off-box push | `ocr-backup` | **NO** (it *is* the backup staging) | Nothing, if the off-box push is working. Everything, if it is not — see below. |

### 2.6.1 Ownership: the uid must be pinned, not inherited

`ocr_file_storage` is written by two different images. If `ocr-web` runs as node's uid 1000 and
`ocr-worker` runs as uid 10001, one of them gets `EACCES` on the other's files and the failure shows
up as a mysterious partial-extraction bug.

**Decision:** both containers write to `/data/files` as **gid 10001**, with **`2770`** directories
and `0660` files, and the images `chown`/`chmod` the mount point at build time. `i-storage.md` J5
specifies `0700`/`0600` for the *local adapter* — that is correct for a single-writer design; we
relax to group-shared `2770`/`0660` **only** because two services legitimately share this volume. If
M2 splits them (worker writes to its own prefix, web reads via a stream from the worker), revert to
J5's stricter mode.

> 🔴 **REVIEW-PASS FIX C-7 — `0770` was the wrong number and the shared group alone does not work.**
>
> The draft prescribed `0770` directories and a supplementary group, which *sounds* sufficient and is
> not. On Linux, a new file's **group** is inherited from the creating process's **primary** group,
> not from the directory — unless the directory carries the **setgid bit**. So with plain `0770`:
>
> - `ocr-worker` (primary group 10001) creates `page-3.webp` → gid **10001** → `ocr-web` can read it. ✅
> - `ocr-web` (user `node`, primary group **1000**, supplementary 10001) creates `original.pdf` →
>   gid **1000** → `ocr-worker` gets **EACCES**. ❌
>
> The failure is asymmetric and therefore doubly confusing: the worker can read everything the
> worker wrote, and the pipeline breaks only on the files the *web tier* wrote — which is every
> uploaded original, i.e. every job. It presents as "extraction randomly fails for some documents"
> and it is 100 % reproducible once you know which direction to look.
>
> **Two changes are required together, and neither is sufficient alone:**
>
> 1. **`chmod 2770` on the directories** (setgid) — new entries inherit gid 10001 regardless of who
>    created them, and new *sub*directories inherit the setgid bit too.
> 2. **`umask 0007` in both runtimes** — the default umask `0022` strips group-write from every new
>    file, so files land `0644`, the group can read but not write, and *deletion/replacement* fails
>    instead of creation. Both Dockerfiles now set it in `CMD`.
>
> Both changes are in the corrected Dockerfiles in §2.3.2 and §2.4.5.

```dockerfile
# web.Dockerfile: give `node` the shared gid, and set the setgid bit on the mount point
RUN groupadd -g 10001 ocrdata \
 && usermod -aG ocrdata node \
 && mkdir -p /data/files \
 && chown -R node:ocrdata /data \
 && chmod 2770 /data /data/files
```

**M1 acceptance test — run it, do not reason about it.** This is a ten-line test that would have
caught the original bug, and permission bugs are exactly the class where reading the code proves
nothing:

```bash
docker compose up -d ocr-web ocr-worker
# web writes, worker must be able to read AND replace
docker compose exec -T ocr-web    sh -c 'umask 0007; echo web  > /data/files/_t_web'
docker compose exec -T ocr-worker sh -c 'cat /data/files/_t_web && echo w2 >> /data/files/_t_web'
# worker writes, web must be able to read AND replace
docker compose exec -T ocr-worker sh -c 'umask 0007; echo wrk > /data/files/_t_wrk'
docker compose exec -T ocr-web    sh -c 'cat /data/files/_t_wrk && echo w2 >> /data/files/_t_wrk'
# and confirm the inherited group is 10001 in BOTH directions, not just the mode
docker compose exec -T ocr-worker sh -c 'stat -c "%n %U:%G %a" /data/files/_t_web /data/files/_t_wrk'
#   expect: ... :ocr 660   for both lines. A gid of 1000 or a mode of 644 is the bug.
docker compose exec -T ocr-web sh -c 'rm -f /data/files/_t_web /data/files/_t_wrk'
```

**A Thai-specific note on this volume, which the draft did not raise.** Filenames on this volume
must be **opaque keys**, never user-supplied Thai filenames — and `i-storage.md` J3's key scheme
already does this, so we are safe by construction. It is worth writing down *why*, because "just use
the original filename" is a tempting simplification someone will propose:

- macOS (this workstation, where developers will run the stack) stores filenames in a **decomposed**
  Unicode form; Linux stores whatever bytes it is given. Thai has no precomposed/decomposed
  ambiguity for its own letters, so this is less lethal than for Vietnamese or Korean — **but a Thai
  filename routinely contains a mixture of Thai, Latin, and the `NBSP`/`ZWSP` characters that Thai
  Office toolchains insert**, and those *do* round-trip differently.
- The consequence, if user filenames were used as keys: a file written on a developer's Mac and read
  on the Linux VPS resolves to a different byte sequence, `open()` returns `ENOENT`, and the
  document 404s for that one customer with no error anywhere else.
- **The original filename belongs in a database column, UTF-8, unnormalised, displayed verbatim —
  and normalised to NFC only for *comparison*.** The storage key stays ASCII. This document's job is
  only to make sure nothing in the container or NGINX layer breaks that contract; see §3.3.1 for the
  matching `Content-Disposition` handling on the way back out.

### 2.6.2 Backup story

`pg_dump` output that lives on the same disk as the database **is not a backup**. This is TCL's
hard-won lesson, stated in its own compose file in Thai; we adopt it verbatim:

- Nightly `pg_dump -Fc -Z 6`, written as `.part` then `mv`d so a reader never sees a half file.
- Pushed off-box via `rsync -a --partial -e "ssh -i /keys/id_ed25519"` to a target set in `.env`.
- `.last-offsite-ok` timestamp file; **alert if it is older than 26 hours**.
- 14-day local retention; retention at the destination is the destination's job (TCL deliberately
  omits `--delete`, so a local deletion cannot cascade).
- **Restore drill quarterly, or it is not a backup.** `pg_restore --clean` into a scratch database
  and run the integration suite against it.

`ocr_file_storage` needs its **own** mechanism — `pg_dump` does not touch it. Recommendation:
`restic` to the same off-box target, because it deduplicates (page renders across versions of the
same document dedupe well) and encrypts client-side, which matters for a "secure OCR" product.
**UNVERIFIED:** restic's dedup ratio on our specific derivative mix; measure at M3.

### 2.6.3 What must **NOT** be in a volume

| Must not be in a volume | Where it goes instead | Why |
|---|---|---|
| **OCR model weights** | baked into the image (§2.4.4) | Reproducibility. An image rollback must roll the model back too. |
| `.env` / any secret | bind-mounted `:ro` file, or Docker/compose secrets; `chmod 600` on the host | A named volume is easy to `docker cp` out and impossible to audit. |
| TLS private keys | the host, owned by root, read by NGINX only | Never inside the compose blast radius at all. |
| Application code | the image | A volume-mounted `src/` in production means "what is running" is not "what was reviewed". |
| Prisma migrations | the image (`ocr-migrate` target) | Same reason. |
| Postgres config `.conf` files | `command:` flags in compose (as written in §2.2) | Version-controlled, diffable, and visible in `docker compose config`. A `postgresql.conf` in a volume is invisible state. |
| **The 300-dpi OCR render** | `ocr_scratch`, deleted immediately after OCR | ~8.7 MB per page (§4.1). Keeping them costs 5× the storage for a file we can regenerate in ~0.2 s. |

---

## 2.7 Hardening

### 2.7.1 What each control actually buys

| Control | Applied to | What it stops |
|---|---|---|
| `security_opt: [no-new-privileges:true]` | all | A setuid binary inside the container cannot escalate. Neutralises a whole class of container-escape chains. Zero cost. |
| `cap_drop: [ALL]` | all | Removes `CAP_NET_RAW` (no raw sockets ⇒ no ARP spoofing on the docker bridge), `CAP_SYS_PTRACE`, `CAP_MKNOD`, etc. `ocr-db` needs 5 back (§2.2). Web and worker need **zero**. |
| non-root `USER` | web, worker, migrate — **and, after the review pass, backup** | A container running as root that escapes a namespace is root on the host. `ocr-worker` parses hostile files — this is the one that matters most. ⚠️ **The draft's table said "all" and that was false.** The `postgres` image has no `USER` directive: its entrypoint runs as root and `gosu`es down. `ocr-db` therefore starts as root *by design* and that is accepted (§2.2's `cap_add` note). But `ocr-backup` **overrides the entrypoint**, so gosu never runs and it was executing our backup script — with an SSH private key and an outbound connection — as **uid 0**. Fixed with `user: "999:999"` in §2.2. |
| **default seccomp profile** (decision O19) | all | Docker applies its default seccomp profile unless you disable it, and it blocks ~44 syscalls including `keyctl`, `add_key`, `ptrace` (pre-4.8), `mount`, `pivot_root` and `userfaultfd` — several of which are the first step in published container escapes. `cap_drop: ALL` does **not** subsume this; they filter different things. **The rule is therefore a negative one: nothing in this stack may set `security_opt: [seccomp:unconfined]`**, and nothing does. `j-security-threat-model.md` §5 names seccomp separately in its mitigation list for the decoder-RCE row; this is where that requirement is discharged. A *tightened custom* profile for the worker (which needs a small syscall set: file I/O, mmap, futex, epoll, no network beyond a unix socket to Postgres) is a real M2 win and a real M2 risk — an over-tight profile crashes ONNX Runtime in a way that looks like a model bug. M2 task, with `strace -f -c` evidence. |
| `read_only: true` | web, worker, migrate | An attacker with RCE cannot drop a persistent second stage anywhere except the two small `noexec` tmpfs mounts and the data volume, and the data volume can be mounted `noexec` too. |
| `tmpfs … noexec,nosuid,nodev` | web, worker | Writable, but nothing there can be executed. |
| `pids_limit` | all | A fork bomb in a dependency degrades one container instead of the host. |
| `logging` caps | all | Prevents a log loop filling the host disk — see §5.5 for how close this host already is to that. |
| no published DB port | db | §2.5.2. |
| `internal: true` network | worker, db, migrate | No egress from the processes that parse hostile input. |

### 2.7.2 `read_only: true` — where it works and where I stopped

- **`ocr-web`: works.** Next.js standalone writes only `/tmp` and `.next/cache` (ISR / fetch cache),
  both given as tmpfs. **UNVERIFIED:** whether Next 16.2.12's fetch cache respects a tmpfs at
  `/app/.next/cache` under `output: 'standalone'`. Verify with `docker compose up ocr-web` and
  `grep -i EROFS` in the logs; if it complains, the fallback is `CACHE_HANDLER` pointed at Postgres.
- **`ocr-worker`: works,** because every write target is an explicit env var (`OCR_STORAGE_ROOT`,
  `OCR_SCRATCH_ROOT`) pointed at a volume. Watch for libraries that default to `~/.cache` —
  `HF_HUB_OFFLINE=1` and `TRANSFORMERS_OFFLINE=1` prevent the most likely one.
- **`ocr-db`: deliberately NOT read-only in M1.** Postgres writes `/var/run/postgresql`, `/tmp`, and
  parts of `$PGDATA` outside the data files. It *can* be made read-only with tmpfs mounts, but that
  is a change I could not test in this session, and shipping an untested hardening flag on the
  database is a worse outcome than shipping without it. **M2 task**, with this acceptance test:
  `docker compose up ocr-db && docker compose exec ocr-db psql -c 'create table t(i int); drop table t;'`
  plus a clean `pg_ctl reload`.

### 2.7.3 Why `ocr_scratch` is a disk volume and **not** tmpfs

This is the non-obvious one. **tmpfs pages count against the container's `mem_limit`.** A
`tmpfs: /scratch:size=1g` on a container with `memory: 3072M` does not give you 3 GB of RAM *plus*
1 GB of scratch — it gives you 3 GB total, and a 200-page scanned PDF whose renders land in
`/scratch` will OOMKill the worker mid-job. The kill is a `SIGKILL`, so the worker cannot mark the
job failed, and the row sits in `PROCESSING` until the visibility timeout expires.

Named volume on disk: renders cost disk (cheap, and bounded by the page-at-a-time policy below), not
RAM. `/tmp` stays tmpfs at 64 MB because it holds only small things.

**Companion policy the worker must implement:** render **one page at a time**, OCR it, delete it,
then render the next. Never materialise all N pages of a document. At 300 dpi greyscale that caps
scratch at ~8.7 MB per concurrent worker (§4.1) instead of ~1.7 GB for a 200-page document.

### 2.7.4 🔴 REVIEW-PASS FIX C-8: `ocr_scratch` is shared by every replica, and the draft's sweep destroys live work

The draft treated `/scratch` as if each worker had its own. It does not. `ocr_scratch` is **one named
volume**, and `deploy.replicas: ${OCR_WORKERS:-2}` (§2.2.2) mounts that same volume into **every**
replica. Combine that with the disk-pressure mitigation the draft proposed in §5.5 —

> *"Add a startup sweep that empties `/scratch` (nothing there is ever needed across a restart)"*

— and you get a data-loss bug that **cannot occur in development** (where `W = 1`, §4.8 Scenario 1)
and occurs on the first production restart:

```
t0   replica-1 is 140 pages into a 200-page document; /scratch holds its current render
t1   replica-2 restarts (OOM, deploy, health-check flap, `restart: unless-stopped` — take your pick)
t2   replica-2's startup sweep runs `rm -rf /scratch/*`
t3   replica-1's next open() on its own render file → ENOENT
t4   replica-1 raises, the job goes to RETRYING, and 140 pages of work are redone
```

At `W = 5` with `restart: unless-stopped`, this is not a rare race; it is a background rate of
mysterious retries that nobody attributes correctly, because the traceback is in replica-1 and the
cause is in replica-2. A secondary version of the same bug is a **filename collision** — two replicas
rendering page 3 of two different documents into `/scratch/page-3.png`.

**The fix, which is why `OCR_SCRATCH_STRICT` and `OCR_WORKER_ID` appear in §2.2:**

1. **Namespace by worker, then by job.** Every render path is
   `/scratch/<worker_id>/<job_id>/page-<n>.<ext>`. `worker_id` is a uuid4 generated at boot (or
   injected); `job_id` is `extraction_jobs.id`. Collisions become structurally impossible rather
   than statistically unlikely.
2. **Sweep by mtime, never by directory.** A worker at boot may delete **only its own** stale
   subtree, and a separate janitor may delete *any* subtree whose mtime is older than a threshold
   comfortably beyond the longest legitimate job:

   ```python
   # worker/scratch.py — the ONLY code permitted to delete under /scratch
   STALE = timedelta(hours=6)      # >> the longest legitimate single job; tune with §4.4
   def sweep(root: Path, my_id: str) -> None:
       for worker_dir in root.iterdir():
           if not worker_dir.is_dir():
               continue
           mine = worker_dir.name == my_id
           for job_dir in worker_dir.iterdir():
               age = datetime.now(UTC) - datetime.fromtimestamp(job_dir.stat().st_mtime, UTC)
               # own subtree: safe to clear at boot (this process is not running it).
               # someone else's: ONLY if it is unambiguously abandoned.
               if mine or age > STALE:
                   shutil.rmtree(job_dir, ignore_errors=True)
           if not any(worker_dir.iterdir()) and not mine:
               worker_dir.rmdir()
   ```

   The worker must `touch` its job directory on every page so a legitimately slow 200-page document
   never looks abandoned. This is the same liveness idea as `h` L4's 30 s heartbeat, applied to the
   filesystem, and it should be driven off the same timer.
3. **The size alarm in §5.5 is now per-worker-subtree**, which also makes it *actionable*: "worker
   `a3f1…` is holding 4 GB of scratch" names a container you can restart, where "scratch is 4 GB"
   names nothing.

**Rejected alternative: give each replica its own volume.** Compose cannot template a volume name per
replica without abandoning `deploy.replicas` for N hand-written services, which trades one real bug
for N copies of every future edit. **What would change it:** moving to a scheduler (Swarm/Nomad/k8s)
with per-task ephemeral volumes, at which point per-replica scratch is free and should be taken.

---

## 2.8 Healthchecks, `depends_on`, restart policy

```
ocr-db  ──(service_healthy)──▶ ocr-migrate ──(service_completed_successfully)──▶ ocr-web
   └────(service_healthy)─────────────────────────────────────────────────────▶ ocr-worker
```

Three rules, each learned from prior art in this estate:

1. **`condition: service_healthy`, never bare `depends_on: [ocr-db]`.** Bare `depends_on` waits for
   the container to *start*, not for Postgres to accept connections. TCL's compose calls this out
   explicitly. The failure is a boot-time race that reproduces one time in ten.
2. **Healthchecks are liveness, never dependency status.** TCL's compose carries this warning in
   red: *"liveness only (event loop + Postgres ping) — never tie it to ERP status, or an ERP outage
   restart-loops the container forever."* For us: `ocr-web`'s `/api/v1/health` must **not** check the
   AI gateway. If it does, a gateway outage restart-loops `ocr-web` and takes down the entire
   product including the deterministic OCR path that does not need the gateway at all. Gateway
   status belongs at `/api/v1/health/detail`, reported, never enforced.
3. **`start_period` sized to the real cold start.** `ocr-worker` gets 90 s because the first ONNX
   Runtime session load is slow. Too short ⇒ Docker kills a container that was merely booting, and
   you get a restart loop that looks like a crash.

`stop_grace_period: 90s` on the worker (the draft said 120 s): a `SIGTERM` mid-page should let the
current **page** finish and the job row be released cleanly. `~/deploy-krspos.sh` stage 1 does the
same thing one level up — it *refuses to deploy* while jobs are in flight. Both belong in our
`deploy.sh` (§5.7).

> **Review-pass correction: 120 s was the wrong number, and the reason is in `h`, not here.**
> `h-queue-and-worker-contract.md` L4 sets a **120 s lease** renewed by a **30 s heartbeat**. A grace
> period equal to the lease means a worker SIGKILLed at the end of its grace period releases its row
> at approximately the same instant the reaper decides the lease has expired — the exact window in
> which the reaper hands the job to a second worker while the first is still, briefly, alive. The
> fencing token makes that *safe* (the zombie's writes are rejected by `WHERE lease_token = $1`) but
> not *free*: the page is processed twice and one result is discarded.
> **Make the grace period comfortably shorter than the lease.** 90 s < 120 s, and 90 s is enough for
> one 600 dpi page with margin (§4.3's worst case is ~5.3 CPU-s of OCR plus render and preprocess).
> The worker's SIGTERM handler must: stop claiming, finish the current **page only**, write back
> under the lease guard, exit. It must **not** try to finish the document.

**Two health-endpoint corrections the review pass found, both small and both the kind that waste an
afternoon:**

1. **One path, not two.** The draft's compose healthcheck hits `/api/healthz`, while §3.6's CI script
   and §3.7.2's post-reload smoke test both hit `/api/v1/health`. Pick one — **`/api/v1/health`**,
   because it is under the versioned prefix that `l-api-ui-export.md` owns and it is therefore
   matched by the `location /api/` block's rate limit and headers rather than falling through to
   `location /`. All three call sites are corrected to `/api/v1/health` in this revision.
2. **Rule 2 above ("healthchecks are liveness, never dependency status") has a second victim.**
   Beyond the AI gateway, `/api/v1/health` must **not** check `ocr_file_storage` writability or the
   worker's liveness either. A full disk should refuse *uploads* (§5.5) and keep serving the review
   UI; a dead worker should surface as a queue-depth alert, not as a web tier that restart-loops.
   The container healthcheck answers exactly one question: *is this Node process still able to serve
   a request and reach its database?* Everything else belongs at `/api/v1/health/detail`, reported,
   never enforced, and never wired to `restart:`.

`restart: unless-stopped` everywhere except `ocr-migrate` (`restart: "no"` — a one-shot that restarts
is a migration that runs twice).

---

# NGINX

## 3.1 Where NGINX lives, and the tension with decision A-7

`a-environment-and-stack.md` A-7 recommends **`caddy:2-alpine` in-stack** and explicitly *rejects*
quotation-system's host-NGINX pattern because "the reverse proxy then lives outside the repo and
outside version control." That is a good argument and I do not overturn it in general.

But the choice is not ours to make in the abstract — it is determined by the target host:

| Target host | Correct edge | Why |
|---|---|---|
| A **fresh** host we own, 80/443 free | **`caddy:2-alpine` in-stack** (A-7) | Automatic Let's Encrypt, config in the repo, one fewer thing to hand over. |
| A host already running **`caddy-gen-proxy`** | **TCL label-join**, publish **zero** host ports | Per `~/Documents/TCL/docs/deploy-vps.md` §4. Note its 50%-502 trap (§2.5.1). |
| A host already running **host NGINX** — e.g. the quotation VPS at `72.62.253.185`, where `a-environment-and-stack.md §8.1` records "host **nginx** proxies to `127.0.0.1:8091`" | **Host NGINX** — this section | We cannot run a second thing on :443. Fighting the incumbent is not an option. |

**This section designs the third case**, because it is the one my brief specifies and the one with
the real traps. The mitigation for A-7's objection is straightforward and non-negotiable: **the
NGINX file lives in our repo at `deploy/nginx/ocr.conf` and is version-controlled**; the owner
copies it into place. It is outside the *running* system's control, not outside version control.

**What would change the decision:** if the OCR service gets its own host, use Caddy in-stack per
A-7 and delete this section's file. The security-header and rate-limit *semantics* below still apply
— translate them into the Caddyfile.

## 3.2 Two files, not one — and why `limit_req_zone` forces it

`limit_req_zone` and `limit_conn_zone` are **`http`-context only**. Putting them inside a `server`
block yields:

```
nginx: [emerg] "limit_req_zone" directive is not allowed here in /etc/nginx/sites-available/ocr.conf:12
```

So the proposal is **three** files (the draft said two; the review pass added the proxy-header
snippet — see §3.3 finding C-1).

> 🔴 **REVIEW-PASS FIX N10 — an http-context file changes every other site on the box.**
>
> This is the single most important correction in the NGINX section, because it directly contradicts
> §3.7's promise. §3.7 says: *"Files we would NOT touch: `/etc/nginx/nginx.conf`, any existing site
> file, any existing `conf.d/*.conf`…"* — technically true, and beside the point. A **new** file in
> `conf.d/` is included into the **`http` block**, and directives there apply to **every `server`
> block on the host**, including quotation-system's.
>
> The draft's `ocr-zones.conf` put `gzip on; gzip_vary on; gzip_comp_level 5; gzip_min_length 1024;
> gzip_proxied any; gzip_types …` in that file. If the incumbent nginx did not previously have gzip
> enabled (Debian's default `nginx.conf` ships `gzip on;` but with `gzip_types` limited to
> `text/html` only, and many hardened configs turn it off entirely), **installing our file silently
> enables gzip for the live quotation-system**. Consequences range from harmless to a genuine
> incident: changed `Content-Length`/`ETag` behaviour, broken byte-range requests on assets it serves,
> new CPU load, and — for any authenticated page that reflects user input — newly-created **BREACH**
> exposure on a system whose owners never agreed to the change and will not know to look.
>
> **Corrected scope rule, applied throughout:** `ocr-zones.conf` contains **only** directives that
> are inert unless referenced by name — zone definitions, a `map`, a `log_format`, an `upstream`.
> Everything with a global default (`gzip*`, `server_tokens`, `client_*`, `proxy_*`, `ssl_*`) moves
> **inside our `server` block**, where it cannot reach another vhost. `limit_req_status` and
> `limit_conn_status` are the one grey area: they are http-context-only and cannot be set per-server,
> but they take effect only where a `limit_req`/`limit_conn` fires, and no incumbent config that
> lacks our zones can be affected. They stay, with the reasoning written in the file.

**File 1 — `/etc/nginx/conf.d/ocr-zones.conf`** (http context — *inert definitions only*)

```nginx
# ==============================================================================
# INNOVERA OCR AI — http-context zones and maps.
# MUST be in conf.d/ (http context). limit_req_zone is NOT allowed in a server block.
# Owned by: INNOVERA OCR. Do not merge into another project's file.
#
# 🔴 SCOPE RULE — READ BEFORE ADDING A LINE HERE.
#    Everything in this file applies to EVERY server block on this host, including
#    other projects'. Therefore this file may contain ONLY definitions that are
#    inert until referenced by name: limit_*_zone, map, log_format, upstream.
#    Anything with a global default — gzip*, server_tokens, client_*, proxy_*,
#    ssl_*, add_header — belongs in OUR server block (ocr.conf), never here.
#    The draft violated this with a gzip block; see §3.2.
#
# 💾 MEMORY COST: the four zones below reserve 4 x 10 MB = 40 MB of shared memory
#    in the nginx master, allocated at startup whether or not they are used. On a
#    2 GB VPS that is worth knowing before you are surprised by it. 10m each is
#    right for a multi-tenant B2B service; drop to 1m each if this is single-tenant.
# ==============================================================================

# --- the rate-limit KEY -------------------------------------------------------
# 🔴 REVIEW-PASS ADDITION. The draft keyed every zone on $binary_remote_addr alone.
#    For a B2B API that is wrong in both directions:
#      * ONE customer behind an office NAT = one bucket for their whole company.
#        A 20-seat Thai accounting firm sharing a single public IP hits 2r/s on
#        uploads collectively and blames us.
#      * An attacker with a /64 of IPv6 or a rotating pool gets a fresh bucket per
#        address and the limit does nothing.
#    Key on the API key when there is one, and fall back to the IP for anonymous
#    traffic. The key is never logged in full — only this hashed variable is used.
map $http_authorization $ocr_limit_key {
    default        $binary_remote_addr;   # anonymous / browser session -> per IP
    ~^Bearer\s+.+$ $http_authorization;   # API client -> per credential
}
# ⚠️ If you enable the real_ip block below, $binary_remote_addr becomes the CLIENT
#    address and this map keeps working. If you do NOT, and you are behind a CDN,
#    the fallback branch collapses every anonymous user into one bucket. Fix the
#    real_ip config first; do not "fix" it by widening the rate.

# --- rate-limit zones ---------------------------------------------------------
# A 10m zone holds ~160,000 states (nginx docs: 1m ≈ 16,000 states of 64 bytes on 64-bit).
# $binary_remote_addr, not $remote_addr: 4 bytes vs ~15, so ~4x the addresses per MB.
# NOTE: keying on $ocr_limit_key means an Authorization header (long) can occupy far
# more than 64 bytes of state. nginx truncates the key at 255 bytes; budget for ~1/3
# the address capacity on the API-keyed zones. 10m is still ample.
limit_req_zone  $ocr_limit_key       zone=ocr_api:10m   rate=20r/s;   # normal JSON API
limit_req_zone  $ocr_limit_key       zone=ocr_up:10m    rate=2r/s;    # uploads — expensive
limit_req_zone  $binary_remote_addr  zone=ocr_auth:10m  rate=10r/m;   # login/API-key mint — per IP
                                                                      # ON PURPOSE: credential
                                                                      # stuffing has no valid key yet
limit_conn_zone $binary_remote_addr  zone=ocr_conn:10m;               # concurrent conns

# 429, not the default 503. A 503 tells a client "server broken, retry hard";
# a 429 tells it "you are the problem, back off" and is what our SDK retries on.
limit_req_status  429;
limit_conn_status 429;
limit_req_log_level warn;

# --- SSE / websocket upgrade map ---------------------------------------------
map $http_upgrade $ocr_connection_upgrade {
    default upgrade;
    ''      close;
}

# --- ⚠️ IF THIS HOST IS BEHIND CLOUDFLARE OR ANY L7 LB, READ THIS -------------
# $binary_remote_addr is then the CDN's IP, so ALL tenants share one rate-limit
# bucket and the first busy customer 429s everyone. Uncomment and set real ranges:
#   set_real_ip_from  <cdn-range>/nn;
#   real_ip_header    CF-Connecting-IP;   # or X-Forwarded-For
#   real_ip_recursive on;
# Do NOT enable this without the allowlist — an attacker can then spoof their own IP.

# --- gzip: DELIBERATELY NOT HERE ----------------------------------------------
# 🔴 The draft had the gzip block at this point in this file. It has been MOVED
#    into the server block in ocr.conf. Reason (§3.2): a gzip directive in http
#    context turns gzip on for every OTHER vhost on this host, including the live
#    quotation-system, which contradicts §3.7's "we change nothing about the
#    incumbent". Do not move it back.

# --- log format that is actually useful for an OCR service --------------------
# ⚠️ PII NOTE (review-pass addition). This is a document-processing product for
#    Thai businesses; $uri and $http_referer can carry document identifiers, and in
#    a mis-designed client, a filename. Two rules, both cheap:
#      1. NEVER add $args / $query_string / $http_authorization / $http_cookie here.
#         The draft did not, and that was correct — this comment exists so the next
#         person debugging an upload does not add them "temporarily".
#      2. The owner's logrotate must cover /var/log/nginx/ocr.*.log with a retention
#         that matches the product's data-retention promise (§6, item 17). An access
#         log kept for a year is a year of document-access metadata nobody scoped.
#    $ocr_limit_key is NOT logged: it can be the raw Authorization header.
log_format ocr_json escape=json '{'
  '"ts":"$time_iso8601","ip":"$remote_addr","host":"$host","method":"$request_method",'
  '"uri":"$uri","status":$status,"bytes_in":$request_length,"bytes_out":$body_bytes_sent,'
  '"rt":$request_time,"urt":"$upstream_response_time","ua":"$http_user_agent",'
  '"rid":"$request_id","limit_status":"$limit_req_status"'
'}';

upstream ocr_web {
    server 127.0.0.1:8410 max_fails=3 fail_timeout=10s;
    keepalive 32;      # requires proxy_http_version 1.1 (default since nginx 1.29.7)
}
```

## 3.3 File 2 — the complete server block

**`/etc/nginx/sites-available/ocr.conf`** (symlinked from `sites-enabled/`, or dropped in
`conf.d/` on RPM-family hosts).

```nginx
# ==============================================================================
# INNOVERA OCR AI — production server block            PROPOSAL, NOT YET APPLIED
# Repo source of truth: deploy/nginx/ocr.conf
# Requires /etc/nginx/conf.d/ocr-zones.conf to be installed first (http-context zones).
# Upstream: ocr-web bound to 127.0.0.1:8410 by docker-compose.prod.yml.
# ==============================================================================

# ---- :80 → :443, except the ACME challenge ----------------------------------
server {
    listen      80;
    listen [::]:80;
    server_name ocr.example.co.th;                 # ← owner sets the real name

    # Certificates are OWNER-MANAGED (certbot/acme.sh). We do not issue, renew,
    # or install them, and nothing in our compose stack touches :80 or :443.
    location ^~ /.well-known/acme-challenge/ {
        root /var/www/html;
        allow all;
    }
    location / { return 301 https://$host$request_uri; }
}

server {
    listen      443 ssl;
    listen [::]:443 ssl;
    http2       on;
    server_name ocr.example.co.th;

    # ---- TLS (owner-managed) -------------------------------------------------
    ssl_certificate           /etc/letsencrypt/live/ocr.example.co.th/fullchain.pem;
    ssl_certificate_key       /etc/letsencrypt/live/ocr.example.co.th/privkey.pem;
    ssl_trusted_certificate   /etc/letsencrypt/live/ocr.example.co.th/chain.pem;
    ssl_protocols             TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;                 # TLS1.3 makes server preference harmful
    ssl_ciphers               ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305;
    ssl_session_cache         shared:OCRSSL:10m;
    ssl_session_timeout       1d;
    ssl_session_tickets       off;                 # forward secrecy over resumption speed

    # 🔴 REVIEW-PASS FIX N7: OCSP STAPLING REMOVED. It is dead config in 2026.
    #    The draft had:
    #        ssl_stapling on; ssl_stapling_verify on;
    #        resolver 127.0.0.53 ipv6=off valid=300s; resolver_timeout 5s;
    #    Let's Encrypt ended OCSP: OCSP URLs were dropped from issued certificates on
    #    2025-05-07 and the responders were switched off on 2025-08-06
    #    (letsencrypt.org/2024/12/05/ending-ocsp — verified this session). A cert with
    #    no AIA/OCSP URL makes `ssl_stapling on` a no-op that logs
    #        "ssl_stapling" ignored, no OCSP responder URL in the certificate
    #    on every reload. Worse, `resolver` was there ONLY to serve stapling, so it
    #    was adding a hard DNS dependency to TLS handshakes for zero benefit — and
    #    127.0.0.53 only exists if the host runs systemd-resolved, which the draft
    #    hand-waved as "owner: match the host's resolver". Both lines are gone.
    #    Revocation is now CRL-based and is the browser's job, not ours.
    #    ⚠️ IF THE OWNER USES A NON-LETS-ENCRYPT CA whose certs still carry an OCSP
    #       URL, stapling becomes worth re-enabling — and then, and only then, the
    #       `resolver` line comes back with the host's real resolver.

    server_tokens off;
    access_log /var/log/nginx/ocr.access.log ocr_json buffer=32k flush=5s;
    error_log  /var/log/nginx/ocr.error.log  warn;
    charset    utf-8;

    # ---- gzip: HERE, not in conf.d (§3.2, fix N10) --------------------------
    gzip              on;
    gzip_vary         on;
    gzip_comp_level   5;
    gzip_min_length   1024;
    gzip_proxied      any;
    gzip_types        text/plain text/css text/xml application/json application/javascript
                      application/xml+rss application/atom+xml image/svg+xml
                      text/csv application/x-ndjson;
    # Deliberately absent: application/pdf, image/jpeg, image/png, image/webp, application/zip,
    # and the XLSX mime. They are already compressed; gzipping them burns CPU for ~0% gain
    # and, on a 200 MB PDF download, burns a lot of it.
    # ⚠️ BREACH note (review-pass addition): gzip + a secret reflected in a compressed
    #    response + attacker-controlled input in the same response = a compression
    #    oracle. Our exposure is small (the API returns JSON to authenticated clients,
    #    and CSRF tokens are not reflected into gzipped bodies) but it is not zero once
    #    the review UI renders attacker-supplied OCR text next to a session-scoped
    #    value. Mitigation is at the app layer — do not reflect secrets into response
    #    bodies — and is j-security-threat-model.md's to own. Written here so the
    #    decision to gzip JSON is a decision and not an accident.

    # ---- 🔴 THE BODY-SIZE TRAP ----------------------------------------------
    # Server-level default is deliberately SMALL. Every location inherits 1m
    # unless it overrides. See §3.4 for exactly how the naive version breaks.
    client_max_body_size 1m;
    client_body_timeout  30s;
    client_header_timeout 15s;
    send_timeout         60s;
    large_client_header_buffers 4 16k;   # Thai UTF-8 filenames in REQUEST headers are long

    # ---- 🔴 REVIEW-PASS FIX N11: the OTHER header buffer, for RESPONSES ------
    # large_client_header_buffers sizes the buffer for headers nginx RECEIVES FROM
    # THE CLIENT. It does nothing for headers nginx receives FROM THE UPSTREAM —
    # that is proxy_buffer_size, whose default is one memory page (4k or 8k).
    # This matters here specifically because of Thai:
    #   RFC 6266 requires a non-ASCII filename to be sent as
    #     Content-Disposition: attachment; filename="fallback.pdf";
    #                          filename*=UTF-8''%E0%B9%83%E0%B8%9A%E0%B8%81...
    #   A Thai character is 3 UTF-8 bytes -> 9 bytes once percent-encoded.
    #   A 90-character Thai document title is ~810 bytes in that ONE header, before
    #   Set-Cookie, CSP (which for a nonce policy is 400-600 bytes), and the rest.
    # Exceed proxy_buffer_size and nginx returns 502 with
    #     upstream sent too big header while reading response header from upstream
    # — a 502 with no application error, triggered ONLY by long Thai filenames, i.e.
    # never in an English test suite. See §3.3.1.
    proxy_buffer_size   16k;
    proxy_buffers     8 16k;
    proxy_busy_buffers_size 32k;

    # ---- shared proxy setup --------------------------------------------------
    proxy_http_version 1.1;                       # nginx ≥1.29.7 defaults to this; be explicit
    proxy_redirect off;

    # 🔴🔴 REVIEW-PASS FIX C-1 / N8 — THE TWIN OF THE add_header TRAP.
    #    The draft listed six `proxy_set_header` lines right here, at server level,
    #    and then the SSE location (§3.3 block 3) added its own `proxy_set_header
    #    Connection` and `Upgrade`. From the nginx docs, verbatim:
    #
    #      "These directives are inherited from the previous configuration level if
    #       and only if there are no proxy_set_header directives defined on the
    #       current level."
    #       — nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_set_header
    #
    #    That is the SAME rule the draft documented so carefully for add_header —
    #    and then walked into. Consequence for the SSE location: Host, X-Real-IP,
    #    X-Forwarded-For, X-Forwarded-Proto, X-Forwarded-Host and X-Request-Id are
    #    ALL DROPPED, and nginx falls back to its documented defaults:
    #        proxy_set_header Host       $proxy_host;   # -> literally "ocr_web"
    #        proxy_set_header Connection close;
    #    So every SSE request reaches Next.js with `Host: ocr_web` and no
    #    X-Forwarded-Proto. Symptoms, none of which say "header": Next.js host/origin
    #    checks reject the stream; absolute URLs are built as http://ocr_web/...;
    #    the CSRF origin check in j's TB-CSRF row fails; the request is invisible in
    #    correlated logs because X-Request-Id is gone. It works in every curl test
    #    that does not go through nginx.
    #
    #    Fix: the shared headers live in a SNIPPET, and every location that defines
    #    its OWN proxy_set_header re-includes it — exactly the discipline already
    #    used for add_header. There is a CI test for both in §3.6.
    include /etc/nginx/snippets/ocr-proxy-headers.conf;

    limit_conn ocr_conn 20;

    # ---- security headers ----------------------------------------------------
    # ⚠️⚠️ add_header INHERITANCE TRAP:
    #   "These directives are inherited from the previous configuration level if and
    #    only if there are no add_header directives defined on the current level."
    #    — https://nginx.org/en/docs/http/ngx_http_headers_module.html#add_header
    # ONE add_header inside a location silently DROPS ALL of these for that location.
    # Mitigation: they live in an include file, and every location that needs its own
    # header MUST re-include it. There is a CI test for this in §3.9.
    include /etc/nginx/snippets/ocr-security-headers.conf;

    # =========================================================================
    # 1. UPLOAD — the ONLY location with a large body limit
    # =========================================================================
    location = /api/v1/uploads {
        limit_req zone=ocr_up burst=5 nodelay;
        include /etc/nginx/snippets/ocr-security-headers.conf;   # re-include (trap above)

        # Matched to the application limit. i-storage.md §1302 proposes 500 MB as the
        # max upload; e-native-extraction-routing.md line 743 sets MAX_UPLOAD_BYTES to
        # 200 MB. THESE DISAGREE — see §3.4.3. This value MUST equal the app's limit.
        client_max_body_size 500m;

        # Stream the body upstream as it arrives instead of spooling the whole 500 MB
        # to /var/lib/nginx/body first. Cost, per the nginx docs: "the request cannot
        # be passed to the next server if nginx already started sending the request body"
        # — i.e. no upstream retry. Correct trade for a single upstream.
        proxy_request_buffering off;

        # A 500 MB upload on a 20 Mbps Thai office ADSL link takes ~3.5 minutes.
        # The defaults (60s) would kill it. These timeouts are BETWEEN operations,
        # not for the whole transfer (nginx docs) — so they are generous, not reckless.
        client_body_timeout   300s;
        proxy_send_timeout    600s;
        proxy_read_timeout    600s;
        proxy_connect_timeout  10s;

        proxy_pass http://ocr_web;
    }

    # =========================================================================
    # 2. DOWNLOAD / EXPORT — stream out, do not spool to disk
    # =========================================================================
    location ~ ^/api/v1/(documents/[^/]+/(content|pages/[^/]+)|exports/[^/]+/download)$ {
        limit_req zone=ocr_api burst=20 nodelay;
        include /etc/nginx/snippets/ocr-security-headers.conf;

        # 🔴 TRAP: with the defaults (proxy_buffering on, proxy_max_temp_file_size 1024m)
        # a 500 MB download is written to /var/cache/nginx/proxy_temp BEFORE the client
        # sees byte one. Result: multi-second TTFB, and N concurrent downloads consume
        # N x filesize of host disk. On a small VPS that fills / and takes down the box.
        proxy_buffering off;
        proxy_max_temp_file_size 0;      # belt and braces: never spool, ever

        proxy_read_timeout 300s;
        proxy_pass http://ocr_web;
    }

    # =========================================================================
    # 3. SSE — the single-document review stream (l-api-ui-export.md L-8)
    # =========================================================================
    location ~ ^/api/v1/documents/[^/]+/events$ {
        include /etc/nginx/snippets/ocr-security-headers.conf;
        # 🔴 REVIEW-PASS FIX C-1: this location defines its own proxy_set_header
        #    below, which DROPS every inherited one. Re-include the snippet FIRST,
        #    then override only what differs. Getting the order wrong is harmless
        #    (they are all at the same level) but keep it consistent so the CI test
        #    in §3.6 has one shape to check for.
        include /etc/nginx/snippets/ocr-proxy-headers.conf;

        # No rate limit: this is ONE long-lived connection, not a request flood.
        # limit_conn (20, server level) is the right control here.

        proxy_buffering    off;          # without this nginx holds events until a buffer fills
        proxy_cache        off;
        gzip               off;          # gzip buffers too; it breaks event flushing
        chunked_transfer_encoding on;

        # ⚠️ REVIEW-PASS NOTE: SSE is NOT a protocol upgrade. It is a plain HTTP/1.1
        #    response with `Content-Type: text/event-stream`. The draft set
        #    Connection/Upgrade from the $ocr_connection_upgrade map, which for an
        #    SSE request (no Upgrade header) evaluates to "close" — harmless, but it
        #    also disables upstream keepalive for this location and it implies a
        #    WebSocket that does not exist. Keep the map for a FUTURE WebSocket route
        #    and set Connection explicitly here.
        #    l-api-ui-export.md L-8 specifies SSE; if that ever becomes a WebSocket,
        #    this is the block that changes, and then $ocr_connection_upgrade is right.
        proxy_set_header   Connection "";

        proxy_read_timeout 3600s;        # an idle SSE stream must not be reaped at 60s
        proxy_send_timeout 3600s;
        proxy_pass http://ocr_web;
        # The app must ALSO send a `: heartbeat\n\n` comment every ~20s. nginx timeouts
        # are between reads; a genuinely silent stream still dies, and should.
        # And note limit_conn ocr_conn 20 applies here: 20 open tabs per IP is the
        # real ceiling on SSE fan-out. h L18 polls one row per stream at 1 Hz, so 20
        # streams is 20 queries/s against ocr-db — fine, but it is the number to
        # revisit before raising limit_conn.
    }

    # =========================================================================
    # 3b. 🔴 REVIEW-PASS ADDITION (N9) — BLOCK THE OPERATIONAL SURFACE
    # =========================================================================
    # n-observability-testing-benchmark.md N9 puts a prom-client `/metrics`
    # endpoint on ocr-web. The draft's `location /` proxied everything, so
    # https://ocr.example.co.th/metrics was PUBLIC: per-tenant counters, queue
    # depths, error taxonomies, model ids, and enough cardinality to enumerate
    # activity patterns. Prometheus must scrape ocr-web over the INTERNAL docker
    # network, never through this vhost.
    location = /metrics          { return 404; }
    location ^~ /api/internal/   { return 404; }
    location ^~ /_next/webpack-hmr { return 404; }   # dev-only endpoint, never in prod

    # =========================================================================
    # 4. AUTH — the tightest bucket
    # =========================================================================
    location ~ ^/api/v1/(auth|api-keys)(/|$) {
        limit_req zone=ocr_auth burst=5 nodelay;
        include /etc/nginx/snippets/ocr-security-headers.conf;
        client_max_body_size 32k;
        proxy_pass http://ocr_web;
    }

    # =========================================================================
    # 5. EVERYTHING ELSE UNDER /api/ — small bodies, normal rate
    # =========================================================================
    location /api/ {
        limit_req zone=ocr_api burst=40 nodelay;
        include /etc/nginx/snippets/ocr-security-headers.conf;
        client_max_body_size 1m;         # inherited anyway; explicit so it survives edits
        proxy_read_timeout 120s;
        proxy_pass http://ocr_web;
    }

    # =========================================================================
    # 6. STATIC — immutable, no rate limit, long cache
    # =========================================================================
    location /_next/static/ {
        include /etc/nginx/snippets/ocr-security-headers.conf;
        # 🔴 REVIEW-PASS FIX: the draft had `proxy_cache_valid 200 365d;` here.
        #    proxy_cache_valid does NOTHING without proxy_cache <zone>, which needs a
        #    proxy_cache_path in http context — which we deliberately do not add
        #    (§3.2's scope rule: no http-context state that touches other vhosts, and
        #    a disk cache is exactly that). So the line was inert and misleading:
        #    a reader would reasonably believe assets were being cached at the edge.
        #    They are not, and they do not need to be — Next.js content-hashes every
        #    file under /_next/static/, so the browser cache does the whole job after
        #    the first request. If edge caching is ever wanted, it is a deliberate
        #    proxy_cache_path + proxy_cache pair with its own key and purge story.
        #
        #    Second fix: Next.js ALREADY sends
        #      Cache-Control: public, max-age=31536000, immutable
        #    on these assets. add_header APPENDS, so the draft produced a DUPLICATE
        #    Cache-Control header. Most clients take the first; some concatenate;
        #    intermediaries vary. Hide the upstream one before setting ours, or —
        #    simpler and chosen here — just let the app's own header through.
        proxy_pass http://ocr_web;
    }

    # =========================================================================
    # 7. BLOCK direct access to storage paths and dotfiles
    # =========================================================================
    # Defence in depth. `ocr_file_storage` is a Docker volume with no filesystem
    # path served by nginx, so there is nothing to leak TODAY. These exist so that a
    # future `root /var/lib/docker/volumes/...;` or an alias typo cannot become a
    # data breach, and so a scanner probing /data/, /storage/, /uploads/ gets 404s.
    # 🔴 REVIEW-PASS FIX: `/.well-known/` MUST be admitted BEFORE the dotfile deny.
    #    `location ~ /\.` matches ANY path segment starting with a dot, including
    #    /.well-known/. The :80 server has an `^~` ACME location so HTTP-01 renewal
    #    still works — but everything else under /.well-known/ on :443 was being
    #    403'd: security.txt (RFC 9116), change-password (RFC 8615), and — the one
    #    that will actually bite — TLS-ALPN-01 is fine but any future acme.sh switch
    #    to a webroot challenge over HTTPS is not. `^~` outranks the regex, so this
    #    one line fixes it. It returns 404 for unknown paths, which is correct.
    location ^~ /.well-known/ {
        root /var/www/html;
        try_files $uri =404;
        access_log off;
    }

    location ^~ /data/     { return 404; }
    location ^~ /storage/  { return 404; }
    location ^~ /uploads/  { return 404; }
    location ^~ /files/    { return 404; }
    location ~ /\.         { deny all; access_log off; log_not_found off; }   # .env, .git, .DS_Store
    location = /.env       { return 404; }
    location ^~ /.git/     { return 404; }

    # =========================================================================
    # 8. Everything else → the Next.js app
    # =========================================================================
    location / {
        limit_req zone=ocr_api burst=40 nodelay;
        include /etc/nginx/snippets/ocr-security-headers.conf;
        proxy_read_timeout 60s;
        proxy_pass http://ocr_web;
    }
}
```

**`/etc/nginx/snippets/ocr-security-headers.conf`**

```nginx
# Included in EVERY location that defines its own add_header. See the inheritance
# trap note in ocr.conf. `always` so the header is present on 4xx/5xx too — the
# nginx docs limit non-`always` add_header to 200/201/204/206/301/302/303/304/307/308.

# HSTS belongs here, not in Next.js, because it must also cover responses Next never
# produces (a 502 when ocr-web is down, a 429 from limit_req).
add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
# `preload` is DELIBERATELY OMITTED. HSTS preload is effectively irreversible and
# applies to every subdomain of the apex. Owner decision, not ours.

add_header X-Content-Type-Options  "nosniff"                      always;
add_header X-Frame-Options         "DENY"                         always;
add_header Referrer-Policy         "strict-origin-when-cross-origin" always;
add_header Cross-Origin-Opener-Policy   "same-origin"             always;
add_header Cross-Origin-Resource-Policy "same-origin"             always;
add_header Permissions-Policy      "accelerometer=(), autoplay=(), camera=(), display-capture=(), encrypted-media=(), fullscreen=(self), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), publickey-credentials-get=(), screen-wake-lock=(), sync-xhr=(), usb=(), xr-spatial-tracking=()" always;

# ⚠️ NO Content-Security-Policy HERE. Next.js owns it. See §3.5.
```

**`/etc/nginx/snippets/ocr-proxy-headers.conf`** — the third file, added by the review pass (N8)

```nginx
# Included at server level AND re-included in EVERY location that defines its own
# proxy_set_header. The rule is identical to add_header's and is quoted in ocr.conf:
#   "inherited ... if and only if there are no proxy_set_header directives defined
#    on the current level."
# Forgetting the re-include does not error. It silently rewrites Host to the
# upstream NAME and drops every X-Forwarded-*. See the CI test in §3.6.

proxy_set_header Host              $host;
proxy_set_header X-Real-IP         $remote_addr;
proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-Host  $host;
proxy_set_header X-Forwarded-Port  $server_port;
proxy_set_header X-Request-Id      $request_id;
proxy_set_header Connection        "";        # enable upstream keepalive (upstream ocr_web)

# Strip anything a client tries to inject that we set ourselves. Without this a
# client can send its own X-Real-IP / X-Request-Id; $proxy_add_x_forwarded_for
# APPENDS to a client-supplied X-Forwarded-For, so the left-most entry is
# attacker-controlled and any code that reads XFF[0] as "the client IP" is lying.
# The app must read the RIGHT-most trusted hop, or just use X-Real-IP, which this
# proxy always overwrites.
proxy_set_header X-Forwarded-Server "";
```

### 3.3.1 🔴 THAI BLIND SPOT: downloading a file whose name is Thai

Not in the draft at all, and it is the most likely Thai-specific production failure in this
dimension — because it is invisible to an English test suite and it manifests as a 502 with no
application error.

**The mechanism.** `i-storage.md` J8 has the app set `Content-Disposition` on the download response
so the browser saves the user's original filename. A Thai filename cannot go in a plain
`filename="…"` — HTTP header values are ISO-8859-1 by RFC 9110, so raw UTF-8 there is undefined
behaviour (Chrome mojibakes it, Safari drops it, some proxies reject the response). The correct
encoding is **RFC 6266 / RFC 8187**:

```
Content-Disposition: attachment;
  filename="document.pdf";
  filename*=UTF-8''%E0%B9%83%E0%B8%9A%E0%B9%81%E0%B8%88%E0%B9%89%E0%B8%87%E0%B8%AB%E0%B8%99%E0%B8%B5%E0%B9%89.pdf
```

**The arithmetic that breaks nginx.** Thai is 3 bytes per character in UTF-8, and every one of those
bytes becomes `%XX` — **9 bytes per Thai character** in the `filename*` parameter. Real Thai document
titles are long (`ใบแจ้งหนี้ค่าบริการประจำเดือนกันยายน๒๕๖๙.pdf` is 44 characters ≈ **400 bytes**
encoded). Add the ASCII fallback, `Set-Cookie`, and a nonce CSP header at 400–600 bytes, and a
single response's headers pass 1 KB routinely and 4 KB occasionally. nginx's `proxy_buffer_size`
default is **one memory page — 4k or 8k** — and exceeding it produces:

```
upstream sent too big header while reading response header from upstream
```

which nginx turns into a **502 Bad Gateway**. The application logged a successful 200. Nothing in
the app's telemetry shows a problem. It reproduces only for Thai filenames above a length threshold
that varies with how many cookies the user happens to have.

**The fix is the three lines already added to the server block** (`proxy_buffer_size 16k;
proxy_buffers 8 16k; proxy_busy_buffers_size 32k;`) — plus a test that actually uses Thai:

```bash
# scripts/verify-thai-download.sh — must be in CI, not in someone's memory
set -euo pipefail
BASE="${1:?usage: verify-thai-download.sh https://ocr.staging.example}"
TOKEN="${2:?api token}"
# 61 Thai characters -> ~550 bytes once RFC 8187-encoded
NAME='ใบแจ้งหนี้ค่าบริการอินเทอร์เน็ตความเร็วสูงประจำเดือนกันยายน๒๕๖๙.pdf'
id=$(curl -sS -H "Authorization: Bearer $TOKEN" -F "file=@fixtures/thai-invoice.pdf;filename=$NAME" \
      "$BASE/api/v1/uploads" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
hdrs=$(curl -sS -D - -o /dev/null -H "Authorization: Bearer $TOKEN" \
      "$BASE/api/v1/documents/$id/content")
grep -qi "^HTTP/[0-9.]* 200" <<<"$hdrs" || { echo "FAIL: not 200 (502 => proxy_buffer_size)"; exit 1; }
grep -qi "filename\*=UTF-8''"  <<<"$hdrs" || { echo "FAIL: no RFC 8187 filename*"; exit 1; }
# and the ASCII fallback must be present and must be ASCII
grep -qiP '^content-disposition:.*filename="[\x20-\x7E]+"' <<<"$hdrs" \
  || { echo "FAIL: missing or non-ASCII fallback filename"; exit 1; }
echo "Thai download headers OK"
```

**Three related rules, so the whole path is specified and not just the nginx half:**

| Layer | Rule |
|---|---|
| App (`i-storage.md` J8) | Emit **both** `filename="<ascii-transliterated-or-generic>.pdf"` and `filename*=UTF-8''<pct-encoded>`. Never emit only the second — old clients ignore `filename*`, and a client that ignores both saves the file as the last URL segment, which is an opaque storage key. |
| App | Normalise the stored title to **NFC** before encoding. Thai letters have no decomposed forms, but a filename arriving from a macOS client can carry decomposed Latin (`é`) in a mixed Thai/English title, and NFC vs NFD produces two different `filename*` values for what the user sees as one name. |
| App | **Strip `\r`, `\n`, `"` and `;`** from the fallback before interpolating it — a filename is user-controlled data going into a response header, i.e. textbook **response splitting / header injection**. `j-security-threat-model.md` covers the class; this is the concrete instance in the download path. |
| NGINX | `proxy_buffer_size 16k` (done). Do **not** try to fix this with `proxy_hide_header` / `add_header` — nginx cannot re-encode the value, and rewriting `Content-Disposition` at the proxy is how you lose the filename entirely. |

## 3.4 The `client_max_body_size` trap, spelled out

### 3.4.1 The naive config that breaks uploads silently-ish

```nginx
server {
    client_max_body_size 1m;          # sensible-looking default
    location /api/ { proxy_pass http://ocr_web; }    # ← uploads live under /api/
}
```

A 40 MB scanned PDF now gets **`413 Request Entity Too Large`**, generated by nginx. The request
never reaches the app, so:

- there is **no application log line**,
- there is **no `ocr_jobs` row**,
- the browser's `fetch` sees a 413 with an HTML body where JSON was expected, and most SPA error
  handlers render "Something went wrong",
- and the developer, who tested with a 200 KB file, cannot reproduce it.

### 3.4.2 The other half of the trap: location precedence

Even with a large override, this still fails:

```nginx
location /api/ { client_max_body_size 500m; proxy_pass http://ocr_web; }
location ~ ^/api/v1/ { proxy_pass http://ocr_web; }   # ← regex WINS, inherits 1m
```

nginx matches **`=` exact → `^~` prefix → regex (in file order) → longest prefix**. A regex location
beats a plain prefix location. The §3.3 config avoids this by making the upload route an **exact
`location =` match**, which outranks everything.

### 3.4.3 🔴 The two sibling documents disagree on the number — resolve before M1

| Source | Value | Status after the review pass |
|---|---|---|
| `i-storage.md` line **1377** | `const declared = opts.contentLength ?? MAX_UPLOAD_BYTES;  // MAX_UPLOAD_BYTES = 500 * 1024**2` — and lines 51, 184, 484, 662 all reason about "a 500 MB PDF" as the worked example | **Verified.** The draft cited "line 1303 / line 1616"; the number is actually *in code* at 1377, which makes the conflict harder, not softer — this is not a proposal in prose, it is a constant a reviewer would copy. |
| `e-native-extraction-routing.md` line **1173** | `MAX_UPLOAD_BYTES = 200 * 1024 * 1024   # coordinate with ingestion` | **Verified.** The draft cited line 743; the constant is at 1173. Same conflict, correct line. |

Three numbers must be **one** number, set from one env var:

| Layer | Setting | Must be |
|---|---|---|
| NGINX | `client_max_body_size` | `MAX_UPLOAD_MB` **+ ~2 MB** (multipart boundary and header overhead — a body exactly at the limit otherwise 413s) |
| Next.js route handler | `l-api-ui-export.md` L-1's streaming path | `MAX_UPLOAD_MB` exactly, checked from `Content-Length` **and** enforced while streaming (a lying `Content-Length` is trivial) |
| Python worker | `MAX_UPLOAD_BYTES` | `MAX_UPLOAD_MB` exactly |

**Recommendation: 200 MB**, matching `e-native-extraction-routing.md`. Rationale: a 200 MB scanned
PDF at ~250 KB/page is roughly **800 pages**, which is already beyond `e`'s own
`maxRenderPages: 400` policy; and 500 MB uploads over Thai office upstream links take 10+ minutes
and will time out more often than they succeed. Ship 200 MB, publish it in the API docs as a hard
limit with a documented `413` error code, and revisit with evidence.

**What would change this:** a named customer with a real 400 MB TIFF batch. Then raise the number
*and* switch that customer to the L-1 presigned direct-to-object-store path, which bypasses NGINX
body limits entirely — that is the actual answer for very large files.

### 3.4.4 The 413 must be JSON, not HTML

Add to the server block so a 413 matches the app's error envelope (`l-api-ui-export.md` §1.3):

```nginx
    error_page 413 = @too_large;
    location @too_large {
        internal;
        default_type application/json;
        # 🔴 REVIEW-PASS FIX: the draft ALSO had
        #      add_header Content-Type application/json always;
        #    which is wrong twice over:
        #      1. `default_type` already sets Content-Type for a `return` with a body,
        #         so add_header APPENDS a SECOND Content-Type header. Duplicate
        #         Content-Type is a protocol error some clients reject outright.
        #      2. Any add_header at this level DROPS every inherited security header —
        #         the exact trap this document documents two sections earlier. So the
        #         413 response, uniquely, went out with no HSTS, no nosniff, no
        #         X-Frame-Options. Re-include the snippet instead.
        include /etc/nginx/snippets/ocr-security-headers.conf;
        # Error CODE aligned with i-storage.md's StorageError, which throws
        # `'too-large'` (i §153, §1379, §1402) — not an invented "payload_too_large".
        # l-api-ui-export.md §1.3 owns the envelope shape; this must match it exactly,
        # because a client that special-cases the app's 413 must also match nginx's.
        return 413 '{"error":{"code":"too-large","message":"ไฟล์มีขนาดเกินขีดจำกัด / File exceeds the upload limit.","limitBytes":209715200,"requestId":"$request_id"}}';
    }

    # Same treatment for the other three statuses nginx can generate on its own.
    # Without these, a rate-limited or upstream-down request returns nginx's HTML
    # error page to a client that parsed JSON on the previous request — which is
    # how "Something went wrong" ends up in front of a user during an incident.
    error_page 429 = @rate_limited;
    location @rate_limited {
        internal;
        default_type application/json;
        include /etc/nginx/snippets/ocr-security-headers.conf;
        add_header Retry-After 10 always;
        return 429 '{"error":{"code":"rate-limited","message":"คำขอมากเกินไป / Too many requests.","retryAfterSeconds":10,"requestId":"$request_id"}}';
    }
    error_page 502 503 504 = @upstream_down;
    location @upstream_down {
        internal;
        default_type application/json;
        include /etc/nginx/snippets/ocr-security-headers.conf;
        return 503 '{"error":{"code":"service-unavailable","message":"ระบบไม่พร้อมใช้งานชั่วคราว / Service temporarily unavailable.","requestId":"$request_id"}}';
    }
```

> ⚠️ **The `@rate_limited` block adds an `add_header`, so it re-includes the snippet — but note the
> ordering rule that makes that safe:** all `add_header` directives at the *same* level accumulate.
> The trap is only about *inheritance across levels*. The snippet include and the `Retry-After` line
> are both at location level, so both apply. This is worth stating because "never use add_header in a
> location" is the wrong lesson to take from §3.3; the right lesson is "if you use one, bring the
> others with you."

**One more 413 subtlety the draft did not mention, and it changes what the user sees.** With
`proxy_request_buffering off` on the upload location, nginx rejects an over-size body as soon as it
knows — from `Content-Length` before reading, or mid-stream for a chunked body. In the mid-stream
case nginx must **drain or reset** the connection while the client is still uploading. nginx's
`lingering_close` (default `on`, `lingering_time 30s`, `lingering_timeout 5s`) does the draining, but
a client 90 seconds into a 300 MB upload will usually be cut off with a TCP RST **before it reads our
JSON body**, and the browser reports a network error rather than a 413. There is no nginx-side fix —
this is inherent to rejecting a body you are still receiving.

**The actual fix is in the client**, and it belongs in `l-api-ui-export.md` L-1: **check
`file.size > MAX_UPLOAD_BYTES` in the browser before starting the upload** and show a real message.
The server-side 413 then exists only for non-browser clients and for a lying `Content-Length` — which
is exactly the right division of labour, since a client-side check is a UX feature and never a
security control.

## 3.5 CSP: Next.js owns it, NGINX must not

`l-api-ui-export.md` and `j-security-threat-model.md` both require a **nonce-based** CSP (the review
UI's entire job is rendering attacker-controlled OCR text, so `unsafe-inline` is not survivable).

A nonce must be **unique per request** and must appear in **both** the header and every `<script>`
tag in the HTML body. NGINX can generate a random value (`$request_id`) and set a header — but it
cannot put that value into the HTML body without `sub_filter`-style body rewriting, which is fragile,
breaks with gzip, and breaks with streaming SSR. **So NGINX physically cannot own a nonce CSP for a
Next.js app.**

Next.js does own it. Per the [Next.js CSP guide](https://nextjs.org/docs/app/guides/content-security-policy)
(fetched this session; note that in Next 16 the file is **`proxy.ts`**, formerly `middleware.ts`):

```ts
// proxy.ts  — this file owns Content-Security-Policy. NGINX must not set one.
import { NextRequest, NextResponse } from 'next/server'

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64')
  const isDev = process.env.NODE_ENV === 'development'
  const csp = `
    default-src 'self';
    script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''};
    style-src 'self' 'nonce-${nonce}';
    style-src-attr 'unsafe-inline';
    img-src 'self' blob: data:;
    font-src 'self';
    connect-src 'self';
    worker-src 'self' blob:;
    child-src 'none';
    frame-src 'none';
    manifest-src 'self';
    media-src 'none';
    object-src 'none';
    base-uri 'none';
    form-action 'self';
    frame-ancestors 'none';
    upgrade-insecure-requests;
    report-uri /api/v1/csp-report;
  `.replace(/\s{2,}/g, ' ').trim()

  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-nonce', nonce)
  requestHeaders.set('Content-Security-Policy', csp)
  const res = NextResponse.next({ request: { headers: requestHeaders } })
  res.headers.set('Content-Security-Policy', csp)
  return res
}
```

Four consequences that must be written into the M1 plan, because they are not obvious:

1. **Nonces force dynamic rendering.** Static optimisation, ISR and **PPR are all incompatible** with
   nonce CSP (Next.js docs, explicit). For a per-tenant authenticated document app this costs us
   almost nothing — almost nothing was static anyway — but the marketing/login pages become dynamic
   too. Accept it, or serve those from a separate static route with a hash-based CSP.
2. **`'strict-dynamic'` makes host allowlists in `script-src` inert.** Do not waste time adding CDN
   hosts there; add them to `connect-src`/`img-src` instead.
3. **`base-uri 'none'`, not `'self'`.** The Next.js example uses `'self'`; `'none'` is strictly
   better and nothing in our app sets a `<base>` tag.

3a. **Six directives the draft's policy omitted, added above.** `default-src 'self'` is a fallback
   for *fetch* directives only, so several of these were genuinely unset rather than inherited, and
   two of them will break the product rather than merely weaken it:

   | Directive | Why it is now explicit |
   |---|---|
   | `worker-src 'self' blob:` | **This is the one that breaks the app.** A PDF viewer in the review UI (pdf.js and every wrapper around it) instantiates its worker from a `blob:` URL. `worker-src` falls back to `child-src` then `default-src 'self'` — which does **not** permit `blob:` — so the viewer fails to initialise and the review screen, the core of the product, shows nothing. It fails only in the browser, only in production, and the console message names a worker rather than a CSP. |
   | `style-src-attr 'unsafe-inline'` | React sets inline `style` **attributes** for anything dynamic (progress bars, bounding-box overlays on the OCR result — i.e. exactly what this UI does). `style-src 'nonce-…'` blocks style *attributes* with no way to nonce them. Splitting `style-src-attr` keeps `<style>` elements nonce-locked while allowing attributes, which is the meaningful half of the protection. Without this split the practical outcome is that someone adds `'unsafe-inline'` to `style-src` and loses both. |
   | `frame-src 'none'` / `child-src 'none'` | We embed nothing. Explicit is free. |
   | `manifest-src 'self'` | Does **not** fall back to `default-src` in all engines. |
   | `media-src 'none'` | No audio/video in this product; make that a policy, not an accident. |
   | `report-uri /api/v1/csp-report` | A CSP you cannot observe is a CSP you will eventually relax blindly. Needs a route handler that **rate-limits and size-caps** — CSP reports are unauthenticated, attacker-triggerable POSTs. Prefer `report-to` + `Reporting-Endpoints` once the browser matrix allows; keep `report-uri` for now because support is broader. |

3b. **`next/font` and the style nonce — verify, do not assume.** Next.js's font optimisation injects
   an inline `<style>` block. Whether it carries the nonce depends on the Next version and on the
   font loader path. If it does not, self-hosted fonts silently fail to load and the app falls back
   to system fonts — **which for Thai means falling back to whatever the OS has, i.e. the exact
   substitution problem §2.4.3 goes to such lengths to avoid, but in the browser this time.**
   **M1 acceptance test:** load the app with the CSP enforced, and assert (a) zero
   `Refused to apply inline style` console errors and (b) `document.fonts.check('16px "<our Thai
   face>"') === true`. If the nonce is missing, the fix is `next.config.ts`'s font config or a
   hash-based `style-src`, **never** `'unsafe-inline'` on `style-src`.
4. **This collides with `l-api-ui-export.md` L-2.** L-2 excludes upload and export routes from the
   `proxy.ts` matcher (to avoid Next buffering the body). Those routes then get **no CSP header** —
   which is correct and harmless for a JSON/binary API response, but must be a *deliberate,
   commented* exclusion with a CI test, not an accident. NGINX's `nosniff` +
   `Content-Disposition: attachment` (set by the app per `i-storage.md` J8) is what protects those.

`i-storage.md` J8 additionally sets `Content-Security-Policy: default-src 'none'; sandbox; base-uri
'none'; form-action 'none'` on the **download response itself**. That is a different, narrower CSP
set by the app on a specific response, and it does not conflict with the page CSP above.

## 3.6 CI tests for BOTH inheritance traps

Both traps are invisible in review and silent at runtime. The draft tested one of them. This version
tests both, plus the four other silent failures the review pass found — and it deliberately includes
paths that reach the `error_page` named locations, which the draft's path list never did (that is why
the `@too_large` `add_header` bug survived its own CI script).

```bash
#!/usr/bin/env bash
# scripts/verify-edge.sh — run against staging after ANY nginx change.
# Exit non-zero = do not promote.
set -uo pipefail
BASE="${1:?usage: verify-edge.sh https://ocr.staging.example [token]}"
TOKEN="${2:-}"
fail=0
note() { echo "FAIL: $*"; fail=1; }

REQUIRED=(strict-transport-security x-content-type-options x-frame-options
          referrer-policy permissions-policy cross-origin-opener-policy
          cross-origin-resource-policy)

# ---- 1. add_header inheritance: every path, including error paths -----------
PATHS=(/ /api/v1/health /_next/static/nonexistent.js /data/x /nope-404 /.env)
for p in "${PATHS[@]}"; do
  h=$(curl -sS -o /dev/null -D - "$BASE$p" | tr 'A-Z' 'a-z')
  for r in "${REQUIRED[@]}"; do
    grep -q "^$r:" <<<"$h" || note "missing $r on $p"
  done
done

# ---- 1b. the 413 path, which the draft's list never reached -----------------
# 2 MB against the 1m server default -> nginx-generated 413 -> @too_large
h=$(head -c 2097152 /dev/zero | curl -sS -o /dev/null -D - --data-binary @- \
      -H 'Content-Type: application/octet-stream' "$BASE/api/v1/documents" | tr 'A-Z' 'a-z')
grep -q '413' <<<"$h" || note "expected 413 from the 1m server default"
for r in "${REQUIRED[@]}"; do
  grep -q "^$r:" <<<"$h" || note "missing $r on the 413 response (@too_large add_header trap)"
done
[ "$(grep -c '^content-type:' <<<"$h")" -eq 1 ] || note "duplicate Content-Type on 413"

# ---- 2. proxy_set_header inheritance (review-pass fix C-1) ------------------
# The app must echo what it received. Add a debug route in staging ONLY that
# returns {host, xfproto, xrequestid} from the incoming request headers.
if [ -n "$TOKEN" ]; then
  for p in "/api/v1/echo-headers" "/api/v1/documents/00000000-0000-0000-0000-000000000000/events"; do
    body=$(curl -sS --max-time 5 -H "Authorization: Bearer $TOKEN" -H 'Accept: text/event-stream' \
             "$BASE$p" | head -c 2000)
    grep -q 'ocr_web' <<<"$body" && note "Host was rewritten to the upstream NAME on $p -> the location defines proxy_set_header and did not re-include ocr-proxy-headers.conf"
    grep -qi 'x-request-id' <<<"$body" || note "X-Request-Id missing on $p (same cause)"
  done
fi

# ---- 3. CSP: exactly one, from the app, with the directives that matter -----
csp=$(curl -sS -o /dev/null -D - "$BASE/" | grep -i '^content-security-policy:')
[ "$(grep -c . <<<"$csp")" -eq 1 ] || note "expected exactly 1 CSP header on /"
grep -q "nonce-"            <<<"$csp" || note "CSP has no nonce"
grep -q "worker-src"        <<<"$csp" || note "CSP has no worker-src -> the PDF viewer will not start"
grep -q "frame-ancestors 'none'" <<<"$csp" || note "CSP missing frame-ancestors"
grep -q "unsafe-inline"     <<<"$csp" && \
  grep -qv "style-src-attr 'unsafe-inline'" <<<"$csp" && note "unsafe-inline outside style-src-attr"

# ---- 4. the operational surface must NOT be public (fix N9) -----------------
for p in /metrics /api/internal/x /_next/webpack-hmr; do
  code=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE$p")
  [ "$code" = "404" ] || note "$p returned $code, expected 404 — operational surface is public"
done

# ---- 5. .well-known must survive the dotfile deny ---------------------------
code=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/.well-known/security.txt")
[ "$code" = "403" ] && note "/.well-known/ is being caught by the dotfile deny (missing ^~ location)"

# ---- 6. nothing may leak the nginx version ---------------------------------
curl -sS -o /dev/null -D - "$BASE/" | grep -qiE '^server: *nginx/[0-9]' \
  && note "server_tokens is on"

exit $fail
```

Run `scripts/verify-thai-download.sh` (§3.3.1) in the same CI stage. Between them they cover every
edge defect this review pass found; a config change that passes both is not *proved* correct, but
none of the nine failure modes above can recur silently.

## 3.7 🔴 EXPLICIT WARNING — we do not touch the production NGINX

> ## ⚠️⚠️⚠️ DO NOT MODIFY THE EXISTING PRODUCTION NGINX ⚠️⚠️⚠️
>
> **The target host — if it is `72.62.253.185` — currently serves `quotation-system` through a
> host-installed NGINX** (`a-environment-and-stack.md §8.1`: *"host **nginx** proxies to
> `127.0.0.1:8091`"*). That configuration belongs to a **live business system**.
>
> **A bad `nginx -t` is survivable. A bad `nginx -s reload` is a production outage for
> quotation-system, not just for us.**
>
> In M0 we have contacted no production host, run no `nginx` command anywhere, and written no file
> outside `/Users/innovera/Documents/OCR`. In M1 we still will not. What we deliver is **three
> files and a runbook**. A human with production access runs the commands.

### 3.7.1 Files we would ADD (never edit an existing one)

| # | Path on the server | Repo source | Action |
|---|---|---|---|
| 1 | `/etc/nginx/conf.d/ocr-zones.conf` | `deploy/nginx/ocr-zones.conf` | **new file** (§3.2) |
| 2 | `/etc/nginx/snippets/ocr-security-headers.conf` | `deploy/nginx/ocr-security-headers.conf` | **new file** (§3.3) |
| 3 | **`/etc/nginx/snippets/ocr-proxy-headers.conf`** | `deploy/nginx/ocr-proxy-headers.conf` | **new file** (§3.3, added by the review pass — fix N8) |
| 4 | `/etc/nginx/sites-available/ocr.conf` + symlink into `sites-enabled/` | `deploy/nginx/ocr.conf` | **new file** (§3.3) |

**Files we would NOT touch:** `/etc/nginx/nginx.conf`, any existing site file, any existing
`conf.d/*.conf`, any certificate, any systemd unit.

> 🔴 **REVIEW-PASS CORRECTION to the sentence below.** The draft said there is *"exactly one"*
> unavoidable shared-state risk (duplicate zone/format/upstream names). **There are four**, and the
> draft's own §3.2 file contained the second one:
>
> 1. **Duplicate names** — a zone, `log_format` or `upstream` already called `ocr_*` makes
>    `nginx -t` fail. Loud, safe, caught by step 0.
> 2. **http-context directives with global defaults** — the draft's `gzip on;` in `conf.d/` would
>    have changed behaviour for **every vhost on the box**, silently and without failing `nginx -t`.
>    Fixed in §3.2 by moving gzip into our server block; step 0 now *verifies* that our shipped file
>    contains no such directive, rather than trusting that it does not.
> 3. **`default_server` and the catch-all** — if no existing `server` block on `:443` is marked
>    `default_server`, nginx uses the **first one it parses** as the default. Files in `conf.d/` are
>    included before `sites-enabled/` in Debian's stock `nginx.conf`, and within a directory the
>    order is asciibetical — so adding a file can **change which vhost answers requests with an
>    unmatched Host header**, including scanner traffic and any client using the bare IP. Our
>    `ocr.conf` is deliberately not `default_server`, and step 0 now checks what is.
> 4. **Shared memory** — our four zones reserve 40 MB in the nginx master at startup (§3.2). On a
>    small VPS already running another site, confirm there is headroom; nginx will fail to start, not
>    degrade, if it cannot allocate.

### 3.7.2 The exact command sequence — **for the OWNER to run, on the server**

```bash
# ── 0. PRE-FLIGHT — read-only. Confirms we are not about to collide. ──────────
export LC_ALL=C          # never let a th_TH locale put a Buddhist year in a filename (§2.2.4)

# 0a. VERSION FLOOR (review-pass addition R4). We are about to hand this server a
#     config containing a `map`. nginx 1.30.4 (stable) / 1.31.4 (mainline) fixed
#     CVE-2026-42533 — a buffer overflow when using `map` with a regex — and
#     CVE-2026-60005 (memory disclosure in ngx_http_slice_module). Our map has no
#     regex on the LEFT side, so we are not the trigger; but adding config to an
#     unpatched nginx and then reloading it is the moment any latent problem
#     surfaces and gets blamed on us. Refuse to proceed below the floor.
nginx -v            # e.g. nginx version: nginx/1.30.4
nginx -V 2>&1 | tr ' ' '\n' | grep -E '^--with-http_(ssl|v2|realip)_module' || \
  echo "WARNING: check that ssl/v2/realip modules are compiled in"

nginx -T > /root/nginx-full-config-$(date +%F-%H%M).txt   # full effective config, for the diff later

# 0b. name collisions (risk 1)
grep -nE 'ocr_api|ocr_up|ocr_auth|ocr_conn|ocr_json|ocr_limit_key|upstream[[:space:]]+ocr_web' \
     /root/nginx-full-config-*.txt || echo "no name collisions — safe to proceed"
grep -rn 'server_name' /etc/nginx/sites-enabled/ /etc/nginx/conf.d/ | grep -i ocr \
     || echo "server_name is free"

# 0c. GLOBAL-DEFAULT directives in our own shipped file (risk 2) — self-check.
#     If this prints anything, our file is about to change another vhost's behaviour.
grep -nE '^\s*(gzip|server_tokens|client_max_body_size|client_body|proxy_(buffer|read|send|http)|ssl_|add_header|charset)' \
     ./deploy/nginx/ocr-zones.conf && \
  { echo "STOP: ocr-zones.conf contains an http-context directive with a global default"; exit 1; } \
  || echo "ocr-zones.conf contains only inert definitions — good"

# 0d. WHO IS THE DEFAULT SERVER? (risk 3) Adding a file must not change this.
grep -rnE 'listen[^;]*default_server' /etc/nginx/ || \
  echo "WARNING: no explicit default_server on this host — the FIRST parsed server block wins, and adding a file can change which one that is. Ask the owner to mark the incumbent explicitly BEFORE we add ours."

# 0e. what already exists, and what is listening
ls -la /etc/nginx/sites-enabled/ /etc/nginx/conf.d/ /etc/nginx/snippets/ 2>/dev/null
ss -tlnp | grep -E ':(80|443|8410)\s' || true      # 8410 must be FREE before the stack starts

# 0f. does the host's logrotate already cover our log paths? (§6 item 17)
grep -rn 'ocr' /etc/logrotate.d/nginx /etc/logrotate.d/ 2>/dev/null | head || \
  echo "note: /var/log/nginx/*.log wildcards usually cover ocr.*.log — CONFIRM, do not assume"

# ── 1. BACKUP — mandatory. Not optional. ─────────────────────────────────────
tar -czf /root/nginx-backup-$(date +%F-%H%M).tar.gz /etc/nginx
ls -la /root/nginx-backup-*.tar.gz

# ── 2. INSTALL the three new files ───────────────────────────────────────────
install -o root -g root -m 0644 ./deploy/nginx/ocr-zones.conf             /etc/nginx/conf.d/ocr-zones.conf
mkdir -p /etc/nginx/snippets
install -o root -g root -m 0644 ./deploy/nginx/ocr-security-headers.conf  /etc/nginx/snippets/ocr-security-headers.conf
install -o root -g root -m 0644 ./deploy/nginx/ocr-proxy-headers.conf     /etc/nginx/snippets/ocr-proxy-headers.conf
install -o root -g root -m 0644 ./deploy/nginx/ocr.conf                   /etc/nginx/sites-available/ocr.conf
ln -sfn /etc/nginx/sites-available/ocr.conf /etc/nginx/sites-enabled/ocr.conf

# ── 3. VALIDATE — this does NOT affect the running server ────────────────────
nginx -t
#   Expected, and nothing else:
#     nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
#     nginx: configuration file /etc/nginx/nginx.conf test is successful
#   ANY other output → STOP. Go to step 6.

# ── 4. DIFF the effective config, so you know exactly what changed ───────────
nginx -T > /root/nginx-full-config-AFTER.txt
diff /root/nginx-full-config-$(date +%F)-*.txt /root/nginx-full-config-AFTER.txt | head -80
#   Every changed line must belong to OUR three files. If any line from another
#   project's server block moved, STOP. Go to step 6.

# ── 5. RELOAD — graceful. In-flight requests finish on the old workers. ──────
systemctl reload nginx        # or: nginx -s reload
systemctl status nginx --no-pager
curl -sS -o /dev/null -w '%{http_code}\n' https://ocr.example.co.th/api/v1/health
#   ⇒ then IMMEDIATELY re-verify the INCUMBENT service is unharmed:
curl -sS -o /dev/null -w 'quotation: %{http_code}\n' https://<existing-quotation-host>/

# ── 6. ROLLBACK — if ANY step above was not clean ────────────────────────────
rm -f /etc/nginx/sites-enabled/ocr.conf
rm -f /etc/nginx/conf.d/ocr-zones.conf
rm -f /etc/nginx/snippets/ocr-security-headers.conf
rm -f /etc/nginx/snippets/ocr-proxy-headers.conf
nginx -t && systemctl reload nginx
# Full restore if the tree was somehow disturbed:
#   tar -xzf /root/nginx-backup-<stamp>.tar.gz -C /  &&  nginx -t  &&  systemctl reload nginx
```

**Three rules for whoever runs this:**

1. **Never `systemctl restart nginx`.** `restart` drops every in-flight connection on every site on
   the box. `reload` forks new workers and retires the old ones gracefully. Use `reload`.
2. **`nginx -t` before every reload, without exception**, including for a one-character change.
3. **Do it in a window where the incumbent service can tolerate a rollback**, and have a second
   person watching the quotation-system endpoint.

---

# ITEM P — Resource estimates, with the arithmetic

> **Read this first.** Every latency and throughput number below is an **ESTIMATE derived by
> arithmetic on other people's published hardware figures**. We have benchmarked nothing.
> `d-ocr-engine.md §4` says the same about its inputs, and the estimates below inherit that
> uncertainty and compound it. **Do not put these in a plan, an SLA, or a customer conversation.**
> They exist to size containers and to tell the M2 benchmark what to measure.

## 4.1 Pixel arithmetic — the foundation of everything else

A4 = 210 × 297 mm = 8.268 × 11.693 in.

| DPI | Pixels | Megapixels | Grey 8bpp | BGR 24bpp | BGRA 32bpp |
|---|---|---:|---:|---:|---:|
| 150 | 1240 × 1754 | 2.17 | 2.2 MB | 6.5 MB | 8.7 MB |
| 200 | 1654 × 2339 | 3.87 | 3.9 MB | 11.6 MB | 15.5 MB |
| **300 (default, E8)** | **2480 × 3508** | **8.70** | **8.7 MB** | **26.1 MB** | **34.8 MB** |
| 400 | 3307 × 4677 | 15.47 | 15.5 MB | 46.4 MB | 61.9 MB |
| 600 | 4961 × 7016 | 34.81 | 34.8 MB | 104.4 MB | **139.2 MB** |

**Immediate consequence — render greyscale at the PDFium level, not after.** `e-native-extraction-routing.md`
E9 already chose greyscale for the classical-OCR branch. Doing it *inside* `pypdfium2`'s render call
rather than converting a BGRA bitmap afterwards is a **4× memory saving on the largest allocation in
the pipeline** (8.7 MB vs 34.8 MB at 300 dpi; 34.8 MB vs 139.2 MB at 600 dpi). At the adaptive
600-dpi ceiling E8 permits for small print, the difference between doing this right and doing it
naively is 104 MB **per concurrent page**.

## 4.2 PDF render RAM per page

| Allocation | 300 dpi grey | 600 dpi grey |
|---|---:|---:|
| PDFium output bitmap | 8.7 MB | 34.8 MB |
| NumPy view/copy for OpenCV | 8.7 MB | 34.8 MB |
| Deskew rotation output (`cv2.warpAffine` cannot work in place) | 8.7 MB | 34.8 MB |
| Threshold/binarise output | 8.7 MB | 34.8 MB |
| PDFium internal page cache: decompressed embedded images, font programs, shading | **50–300 MB** (page-dependent) | 50–300 MB |
| **Peak working set, one page** | **≈ 85–335 MB** | **≈ 190–440 MB** |

The dominant, most variable term is PDFium's internal cache, not our buffers. A page containing a
full-bleed 600-dpi embedded scan makes PDFium decompress that image at its native resolution
regardless of our render scale — a single such page can exceed **1 GB** transiently.

**Two mitigations, both cheap:**

1. **Hard page-complexity gate before rendering.** `pypdf` can enumerate a page's `/XObject` images
   and their `/Width`×`/Height` without decoding them. If `Σ(W×H) > 80 Mpx`, route the page to a
   degraded path (render at 150 dpi, or fail with a named error) rather than letting it OOM the
   worker.
2. **One page in flight per worker process** (§2.7.3). This is what makes the peak bounded at all.

**Set the worker's `memory: 3072M` limit accordingly:** ~1.2 GB resident models + ~0.4 GB Python/venv
+ ~0.35 GB typical page peak + headroom for one bad page. A 2 GB limit would OOMKill on
image-heavy Thai scans, which are exactly our target corpus.

## 4.3 Per-page OCR CPU-seconds

**Inputs (all cited in `d-ocr-engine.md §4`, all on other people's hardware):**

- PP-OCRv6 medium: **1.40 s/image** on Intel Xeon 8350C with OpenVINO.
- PP-OCRv6 small: **0.59 s**, tiny: **0.20 s**, same host.
- RapidOCR: "0.5–1 s/page", CPU unspecified.
- `d-ocr-engine.md`'s own estimate for PP-OCRv5 Thai on ONNX/OpenVINO with a mobile detector on
  **this dev box**: **1.0–2.5 s wall**, RSS 0.6–1.2 GB.

**Derivation to CPU-seconds (the unit that actually sizes a container):**

The 1.0–2.5 s figure is *wall* time with multi-threaded inference. With `ORT_INTRA_OP_NUM_THREADS`
unset, ONNX Runtime uses all cores; on a 4-physical-core box, real speedup on these convolutional
graphs is roughly 2.5×, not 4×. So:

```
CPU-seconds (this dev box)  ≈ 1.0–2.5 s wall × 2.5 threads-effective  =  2.5 – 6.3 CPU-s
```

Scaling to a modern server core (a 2.8–3.5 GHz Xeon Ice Lake-SP / EPYC Genoa core vs this
i5-1038NG7's 2.0 GHz base Ice Lake-U): about **1.4–1.6× per-core advantage**, and the AVX-512-VNNI
that `d-ocr-engine.md §0` verified on this chip is present on those parts too, so INT8 gains carry
across.

```
OCR inference, server core:   2.5–6.3 / 1.5   ≈  1.7 – 4.2 CPU-s
```

**The full pipeline is more than inference:**

| Stage | CPU-s / page (server core) | Basis |
|---|---:|---|
| PDF render, `pypdfium2`, 300 dpi grey | 0.05 – 0.35 | ESTIMATE. Born-digital text page is fast; a page with a large embedded JPEG pays the decode. |
| Preprocess: EXIF decode, deskew coarse+fine, optional threshold | 0.15 – 0.50 | ESTIMATE, consistent with `f-preprocessing-and-confidence.md §…` "order-of-magnitude from typical OpenCV throughput" on 8.7 Mpx |
| **OCR detect + classify + recognise** | **1.7 – 4.2** | derived above |
| Post-process: confidence maths, bbox normalisation, JSON assembly | 0.05 – 0.15 | ESTIMATE |
| DB write + object-storage write | 0.02 – 0.10 | mostly I/O wait, not CPU |
| **Total** | **≈ 2.0 – 5.3** | |

> ### 📌 **Planning number: 4.5 CPU-seconds per OCR'd A4 page at 300 dpi.**
> Deliberately near the top of the range. A capacity plan that is 2× pessimistic wastes money; one
> that is 2× optimistic wastes a launch. **Confidence: LOW-MEDIUM. Replace with the M2 benchmark.**

**Native-extracted pages cost ~nothing.** `e-native-extraction-routing.md` puts native extraction at
**20–200× cheaper** than OCR — call it **0.02–0.2 CPU-s/page**. This is the single biggest lever in
the whole system: on a corpus that is 70% born-digital, effective cost per page is
`0.3 × 4.5 + 0.7 × 0.1 ≈ 1.42 CPU-s`, a **3.2× throughput multiplier** over assuming everything is
scanned. Every capacity number below should be quoted twice — worst case (all-scanned) and expected
(mixed).

## 4.4 Concurrent-worker sizing

> 🔴 **REVIEW-PASS FIX P7 — read §4.4.1 first. The draft's formula silently mixed two different
> units and the document then quoted three different values for "worker memory".**

```
W = min( floor(CPU_LIMIT_CORES / THREADS_PER_PROC),
         floor((MEM_LIMIT_GB - 0.5) / RSS_PER_PROC_GB) )

  THREADS_PER_PROC = 1        (OMP_NUM_THREADS=1, ORT_INTRA_OP_NUM_THREADS=1 — §2.2)
  RSS_PER_PROC_GB  = 2.0      (1.2 models + 0.4 runtime + 0.35 page peak + slack)
  the -0.5 GB reserves headroom for the OS page cache inside the container
```

### 4.4.1 What `W` actually counts, and the three contradictory memory numbers

The formula above computes a number of **worker processes** from a **CPU and memory budget**. The
draft never said whose budget, and the document used the answer three incompatible ways:

| Where | What it said | Unit implied |
|---|---|---|
| §2.2 compose comment | *"Scale with `docker compose up -d --scale ocr-worker=N` (see §4.4 for N)"* | `W` = number of **containers** |
| §2.2 `deploy.resources.limits` | `memory: 3072M`, `cpus: "2.0"` | **per container** (this is what Docker does) |
| §4.2 | *"Set the worker's `memory: 3072M` limit accordingly: ~1.2 GB models + 0.4 GB runtime + 0.35 GB page peak + headroom for one bad page"* | **per process** — and it justifies 3072M |
| §4.4 worked table | "VPS 4 vCPU / 8 GB, worker `cpus 2.0 / mem 4.5G`" → `W = 2` | `mem 4.5G` is the **total across all workers** |
| §4.8 Scenario 2 | *"`ocr-worker` × 2 … 4608M total (2 × 2304M)"* | **2304M per container** |

**2304M contradicts 3072M, and §4.2 is the one with the reasoning behind it.** §4.2 derives the peak
working set of a single page as **85–335 MB typical**, notes that *"a page containing a full-bleed
600-dpi embedded scan… can exceed 1 GB transiently"*, and concludes 3072M specifically so that one
bad page does not OOMKill the worker — adding, correctly, that *"a 2 GB limit would OOMKill on
image-heavy Thai scans, which are exactly our target corpus."* Scenario 2's 2304M is 2 GB plus
250 MB. It is inside the range §4.2 explicitly rejects, and it would fail on precisely the documents
this product exists to read.

**Resolution — one definition, used everywhere from here on:**

```
W  = the number of ocr-worker CONTAINERS  (docker compose --scale / deploy.replicas)
     Exactly ONE worker process per container. Always. Non-negotiable, because:
       - the ONNX/OpenMP thread pinning in §2.2 is per-process env, so a second
         process in the same container inherits it and they oversubscribe each other
       - `docker stats` and the OOM-killer both operate per CONTAINER, so two
         processes sharing a mem_limit means one bad page kills the innocent one
       - h L4's lease/heartbeat is per worker identity; two processes behind one
         OCR_WORKER_ID break the scratch namespacing of §2.7.4

Each container is fixed at:   cpus 1.5,  memory 3072M   (§2.2, §4.2)

Therefore the host-level formula is about how many CONTAINERS fit:

  W = min( floor( (HOST_CORES  - 2.5) / 1.5  ),          # 1.0 web + 1.0 db + 0.5 backup
           floor( (HOST_MEM_GB - 3.6) / 3.0  ) )         # 1.5 db + 1.0 web + 0.5 backup + 0.6 OS

  and never less than 1; if the answer is 0, the host is too small — say so rather
  than shaving the worker's memory limit, which is how the 2304M number was born.
```

**Re-derived worked examples** (replacing the table below, which used the old mixed units — the
throughput columns are unchanged because they depend only on `W` and §4.3's 4.5 CPU-s):

| Host | CPU-bound W | Mem-bound W | **W** | Pages/min (all-scanned) | Pages/min (30% scanned) |
|---|---:|---:|---:|---:|---:|
| Dev laptop — **7.75 GiB Docker VM**, 8 vCPU | ⌊(8−2.5)/1.5⌋ = 3 | ⌊(7.75−3.6)/3.0⌋ = **1** | **1** | 13.3 | 42 |
| Dev laptop **after raising Docker to 16 GB** (the §0.2 owner ask) | 3 | ⌊(16−3.6)/3.0⌋ = 4 | **3** | 40.0 | 127 |
| VPS 4 vCPU / 8 GB | ⌊(4−2.5)/1.5⌋ = **1** | ⌊(8−3.6)/3.0⌋ = 1 | **1** | 13.3 | 42 |
| VPS 4 vCPU / 16 GB **(recommended, §4.8)** | **1** | 4 | **1** | 13.3 | 42 |
| VPS 8 vCPU / 16 GB | ⌊(8−2.5)/1.5⌋ = 3 | 4 | **3** | 40.0 | 127 |
| VPS 16 vCPU / 32 GB | ⌊(16−2.5)/1.5⌋ = 9 | ⌊(32−3.6)/3.0⌋ = 9 | **9** | 120.0 | 380 |

> **This is materially less optimistic than the draft's table, and the difference is not a rounding
> error — it is the draft double-counting.** The draft's "VPS 4 vCPU / 8 GB → W = 2 → 26.7 pages/min"
> assumed a worker budget of `cpus 2.0 / mem 4.5G` on a box that also has to run Postgres (1.0 / 1.5G),
> Next.js (1.0 / 1.0G), the backup sidecar (0.5 / 0.5G) and the OS — a total the draft's own
> Scenario 2 then admitted came to **8.2 GB on an 8 GB box**. Once each worker is given the 3072M
> §4.2 says it needs, a 4 vCPU / 8 GB VPS fits exactly **one** worker, not two.
>
> **The practical consequence is a recommendation change, and it should be said plainly to whoever
> is buying the server: 4 vCPU / 8 GB is not a viable production size for this product.** It is a
> demo size. §4.8 Scenario 2 is corrected accordingly. On a mixed (30 % scanned) corpus one worker
> is still ~42 pages/min ≈ 2,500 pages/hour before the duty-cycle haircut, which is a real workload —
> but there is no burst capacity, and a single 400-page scanned document occupies the entire service
> for half an hour.
>
> **What would change this:** the M2 benchmark measuring per-page RSS *below* 2 GB (entirely
> possible — §4.2's model figure of 1.2 GB is itself an estimate inherited from `d-ocr-engine.md §4`).
> Every number here moves with that one measurement, which is the strongest argument for doing the
> benchmark early. **Do not re-tune the container limit downward to make a chosen VPS size work.**

**Why one thread per process rather than one fat multi-threaded process:**

| | Multi-threaded, 1 process | Single-threaded, W processes ✅ |
|---|---|---|
| Model memory | loaded once (~1.2 GB) | loaded W times (W × 1.2 GB) ← the real cost |
| Scaling efficiency | ~2.5× on 4 cores (Amdahl + memory bandwidth) | ~linear to core count |
| Blast radius of a segfault in a native lib | whole worker dies, all in-flight pages lost | one page lost |
| Tail latency | one huge page blocks the pool | isolated |
| Thread oversubscription risk | **severe** at W ≥ 2 — every process spawns ncpu threads and the box thrashes | eliminated by the env vars |

The model-memory duplication is the price, and it is why `RSS_PER_PROC_GB = 2.0` dominates the
formula on small hosts. **If memory becomes the binding constraint before CPU does**, the fix is
`ONNXRuntime` session sharing via a single-process, `asyncio` + thread-pool worker — an M3
optimisation, not an M1 one.

**The draft's worked examples, preserved so the correction is auditable** — these are the numbers
§4.4.1 supersedes. They are ~2× optimistic because the worker budget they assume does not leave room
for the other four services on the same host:

| Host / limits | CPU bound | Mem bound | **W** | Pages/min (all-scanned) | Pages/min (30% scanned) |
|---|---:|---:|---:|---:|---:|
| ~~Dev laptop, worker `cpus 2.0 / mem 3G`~~ | ⌊2.0/1⌋ = 2 | ⌊(3.0−0.5)/2.0⌋ = 1 | ~~**1**~~ | ~~13.3~~ | ~~42~~ |
| ~~VPS 4 vCPU / 8 GB, worker `cpus 2.0 / mem 4.5G`~~ | 2 | ⌊4.0/2.0⌋ = 2 | ~~**2**~~ | ~~26.7~~ | ~~84~~ |
| ~~VPS 8 vCPU / 16 GB, worker `cpus 5.0 / mem 11G`~~ | 5 | ⌊10.5/2.0⌋ = 5 | ~~**5**~~ | ~~66.7~~ | ~~211~~ |
| ~~VPS 16 vCPU / 32 GB, worker `cpus 11 / mem 23G`~~ | 11 | ⌊22.5/2.0⌋ = 11 | ~~**11**~~ | ~~146.7~~ | ~~465~~ |

**Use the table in §4.4.1 instead.**

`pages/min = W × 60 / 4.5` for all-scanned; `W × 60 / 1.42` for the 30%-scanned mix. Both formulas
are unchanged and both are still correct — only `W` was wrong.

Apply a **0.7 duty-cycle factor** for real workloads (queue gaps, DB waits, retries, uneven page
sizes) before quoting anything to a customer.

## 4.5 Postgres sizing

**RAM.** With `mem_limit: 1536M`:

| Parameter | Value | Arithmetic |
|---|---|---|
| `shared_buffers` | **384 MB** | 25% of 1536 MB — the standard starting point |
| `effective_cache_size` | **1 GB** | a planner *hint*, not an allocation; ≈ shared_buffers + expected host page cache |
| `work_mem` | **8 MB** | ⚠️ this is **per sort/hash node, per connection**. 60 connections × 3 nodes × 8 MB = **1.44 GB worst case** — larger than the whole container. 8 MB is chosen *because* of that multiplication, not despite it. Raise it per-session (`SET LOCAL work_mem`) for the few reporting queries that need it. |
| `maintenance_work_mem` | **128 MB** | VACUUM / CREATE INDEX; one at a time |
| `max_connections` | **60** | web pool 20 + worker 4 × W(≤5) + migrate 5 + backup 2 + human 5 ≈ 52 |
| Per-connection backend overhead | ~5–10 MB | 60 × 7 MB ≈ 420 MB |

Sum of the steady terms: 384 + 420 + 128 ≈ **930 MB**, leaving ~600 MB of the 1536 MB for `work_mem`
spikes and WAL buffers. Tight but sound. **If the connection count ever needs to grow, add PgBouncer
in transaction mode before raising `max_connections`** — Postgres backends are processes, and 200 of
them is 1.4 GB of pure overhead.

**Disk.** Per 1,000 documents at 6 pages/doc = 6,000 pages.

> 🔴 **REVIEW-PASS REBUILD (C-9). The draft's table used a schema that does not exist.** This
> document had **zero** citations of `g-data-model.md`, which owns the schema, and invented six table
> names while omitting six real ones. Specifically: `ocr_jobs` → **`extraction_jobs`**;
> `field_corrections` → **`corrections`**; `audit_log` → **`audit_logs`**; **`document_lines` does
> not exist in `g` at all**; and `ocr_results`, `job_events`, `extraction_field_values`,
> `document_analyses`, `storage_objects` and `usage_counters` were all missing. The estimate below is
> rebuilt on `g`'s actual table list and `g`'s own row-count model (`g` §1905–1915, which is stated
> for 20,000 documents and is divided by 20 here).

| Table (per `g` §1905–1915) | Rows / 1,000 docs | Bytes/row incl. TOAST | Subtotal |
|---|---:|---:|---:|
| `documents` | 1,000 | ~900 | 0.9 MB |
| `document_pages` | 6,000 | ~1,200 | 7.2 MB |
| `ocr_results` (the page-level `NormalizedDocument` JSONB, TOAST-compressed — **the big one**) | ~6,500 | ~8,500 | 55.3 MB |
| `extraction_jobs` (~3.2 jobs/doc incl. retries; pruned at 30 days) | ~3,200 | ~450 | 1.4 MB |
| `job_events` (~5 events/job) | ~16,000 | ~350 | 5.6 MB |
| `extraction_field_values` (15 fields/doc + corrections) | ~16,000 | ~400 | 6.4 MB |
| `corrections` (append-only, L-12) | ~2,000 | ~500 | 1.0 MB |
| `audit_logs` | ~10,000 | ~600 | 6.0 MB |
| `document_analyses` | ~1,100 | ~2,000 | 2.2 MB |
| `storage_objects` (1 original + 6 renders per doc) | ~7,000 | ~350 | 2.5 MB |
| `usage_counters` | ~525 | ~200 | 0.1 MB |
| **Heap subtotal** | | | **≈ 88.6 MB** |
| B-tree indexes (~40 % of heap — many are composite `(id, organization_id)` per `g`'s RLS anchor) | — | — | ~35 MB |
| **Table + B-tree index total** | | | **≈ 124 MB** |
| WAL churn (amortised, `wal_compression=zstd`, 7-day retention) | | | ~60 MB |
| **Postgres disk per 1,000 documents, M1 (no search index)** | | | **≈ 185 MB** |

The draft's headline number was 200 MB; the rebuilt number is 185 MB. **The headline barely moved,
and that is the least interesting thing about this correction** — it moved by 8 % because the
invented `document_lines` row (27 MB) happened to be roughly the size of the six omitted tables. The
number was right by luck. Anyone who had used the draft's table to write a migration would have
built the wrong schema.

> **The design decision the draft embedded here is still right, and is `g`'s decision, not ours:**
> store the page-level `NormalizedDocument` as **one JSONB per page** (`ocr_results`) and materialise
> only the fields that need indexing (`extraction_field_values`) — not one row per OCR line with
> every attribute. Fully normalising ~60 lines/page is ~360,000 rows per 1,000 documents and roughly
> triples both disk and index-maintenance cost for a query pattern ("give me page 3") that JSONB
> serves in one row read. Reversibility: **hard** — this is a schema shape, and it is `g`'s to
> decide, not this document's. Recorded here only because it is what makes the 55 MB row above the
> dominant term.

### 4.5.1 🔴 THAI BLIND SPOT: the search index is not in the table above, and it is not 45 %

The draft's line item *"B-tree + GIN indexes (≈ 45 % on top)"* rolled a full-text index into a
percentage. For a Thai corpus that is wrong twice.

**First: there is no GIN index in M1.** `g-data-model.md` **K-10** is explicit — *"Store
`searchTokens` at ingest, build no search index until M4."* So the M1 number above correctly carries
B-tree indexes only, and a capacity plan that budgets for a search index in M1 is over-provisioning.

**Second: when the index does arrive in M4, it is not a 45 % surcharge.** `g` §9 works through why
PostgreSQL full-text search does not work on Thai at all:

- Thai is written **without spaces between words**. `to_tsvector('simple', <raw Thai>)` produces
  **one lexeme for an entire sentence** — `g` §1679 calls it *"useless. Do not ship it."*
- `pg_trgm` GIN + `ILIKE` is the one classic technique Thai does not break, because trigrams are
  character-level. But it is `ILIKE` acceleration only — no ranking, no phrase search — and `g`
  §1680 warns the index is **large**, with `g` §2029 naming *"a 30 GB index"* as the thing K-10
  defers rather than ships.
- The chosen path (`g` K-10 / §1681) is **application-side tokenisation**: segment the Thai in Python
  (newmm, a by-product of work `d-ocr-engine.md` §7.1 already does), store the space-joined tokens
  in a `search_tokens` column, and index `to_tsvector('simple', search_tokens)`. That yields a
  *small* index with real ranking.

**Consequences for this dimension, which is what we own:**

| | M1 | M4 (`to_tsvector` on tokens) | M4 alternative (`pg_trgm` on raw text) |
|---|---|---|---|
| Extra Postgres disk per 1,000 docs | **0** | **~15–25 MB** (a tsvector index on tokenised text is roughly 20–30 % of the tokenised text size) | **~120–200 MB** — trigram GIN on Thai can approach or exceed the size of the indexed text, because with no word boundaries every character position generates a trigram |
| Storage for `search_tokens` itself | **~9 MB/1,000 docs** (add this to §4.5 now — K-10 says store it from M1) | included | n/a |
| `maintenance_work_mem` needed to build it | n/a | 128 MB is fine | **raise it, temporarily, for the build** — and note §4.5's `maintenance_work_mem=128MB` is sized for VACUUM, not for a large GIN build |

**Two actions this creates for us, both cheap and both easy to forget:**

1. **Add ~9 MB per 1,000 documents to the disk model now**, for the `search_tokens` column K-10
   populates from M1 even though nothing indexes it yet. That makes the working number **≈ 194 MB per
   1,000 documents**, and the §4.6 scaling table's Postgres column should be read as ~0.2 GB — which
   it already was, so no downstream number changes.
2. **Do not let M4's index build happen inside the 1536M `ocr-db` container without raising
   `maintenance_work_mem` for that session.** A GIN build that spills is not merely slow; combined
   with `shm_size` (§2.2) it is the second place a 64 MB `/dev/shm` would have bitten us.

**UNVERIFIED, and `g` §1982 flags the same gap:** `pg_trgm`'s exact behaviour on Thai multibyte
input. `g` §1680 notes PostgreSQL's docs say `pg_trgm` *"ignores non-word characters"* but are silent
on multibyte classification. **`SELECT show_trgm('ภาษี');` on any PostgreSQL 18 instance settles it
in thirty seconds** and determines whether the 120–200 MB figure above is right or a factor of two
out. Bundle it with the collation test in §2.2.3 — same instance, same five minutes.

## 4.6 Object-storage growth per 1,000 documents

**Stated assumptions** (change these and the answer changes; that is the point of listing them):

- 6 pages per document.
- 60% born-digital PDF (mean 350 KB whole file), 40% scanned (mean 250 KB per page ⇒ 1.5 MB/doc).
- 300-dpi OCR renders are **transient** — written to `ocr_scratch`, deleted after OCR. **Not stored.**
- Viewer derivative: **150 dpi greyscale WebP q80**, ≈ 180 KB/page (2.17 Mpx text-heavy).
- Thumbnail: 200 px wide WebP, ≈ 8 KB/page.

| Item | Count | Unit | Subtotal |
|---|---:|---:|---:|
| Originals — born-digital | 600 docs | 350 KB | 210 MB |
| Originals — scanned | 400 docs | 1.5 MB | 600 MB |
| Viewer derivatives (all pages) | 6,000 | 180 KB | **1,080 MB** |
| Thumbnails | 6,000 | 8 KB | 48 MB |
| Exports (CSV/XLSX, GC'd at 7 days) | — | — | ~20 MB steady |
| **Object storage, Policy A (keep derivatives)** | | | **≈ 1.96 GB** |
| **Object storage, Policy B (thumbnails only, regenerate on demand)** | | | **≈ 0.88 GB** |
| Postgres (§4.5) | | | 0.20 GB |
| **TOTAL per 1,000 documents — Policy A** | | | **≈ 2.16 GB** |
| **TOTAL per 1,000 documents — Policy B** | | | **≈ 1.08 GB** |

**Recommendation: Policy A for M1, with a 90-day demotion job.** The viewer derivative is what
`l-api-ui-export.md` L-13 shows in the review UI by default, and regenerating it costs ~0.2 s of CPU
plus a full PDF page decode on every view — poor UX on the screen where humans do the work.
After 90 days, a GC job deletes derivatives for documents with no access in that window and flips a
`derivativesEvicted` flag; the viewer regenerates on demand. That converts the storage curve from
linear-forever to linear-in-active-documents.

**Scaling table (Policy A):**

| Documents | Object storage | Postgres | Total |
|---:|---:|---:|---:|
| 1,000 | 2.0 GB | 0.2 GB | **2.2 GB** |
| 10,000 | 19.6 GB | 2.0 GB | **21.6 GB** |
| 100,000 | 196 GB | 20 GB | **216 GB** |
| 1,000,000 | 1.96 TB | 200 GB | **2.16 TB** |

At **100k documents a single-VPS local-disk deployment is at its limit** — that is the trigger for
`i-storage.md` J7's migration to SeaweedFS 4.46 or managed S3/R2, not a date on a calendar.

## 4.7 `ocr-web` (Next.js) RAM

| Component | RSS | Basis |
|---|---:|---|
| Node 22 runtime + V8 baseline | 45–60 MB | ESTIMATE |
| Next.js 16 standalone server, App Router, warm | 90–160 MB | ESTIMATE |
| `@prisma/client` 7.9.1 + `@prisma/adapter-pg` + `pg` pool (20 conns) | 60–110 MB | ESTIMATE |
| `next-intl` 4.14.2 message catalogues (th + en) | 10–25 MB | ESTIMATE |
| Route-handler transient buffers (the ≤8 MB streaming upload fallback, CSV/XLSX export assembly capped at 50k rows per L-16) | 40–150 MB peak | ESTIMATE |
| **Steady** | **≈ 250–350 MB** | |
| **Peak under concurrent export + upload** | **≈ 450–550 MB** | |

`memory: 1024M` with `NODE_OPTIONS=--max-old-space-size=768`.

> ### 🔴 The `--max-old-space-size` trap
> V8 does **not** read the cgroup memory limit. Its default heap on a machine reporting 32 GB is
> multiple GB. In a 1 GB container, V8 happily grows past 1 GB, the **kernel** OOM-killer fires, and
> you get exit code 137 with **no JS heap error, no stack trace, and nothing in the app log**. It
> looks like a random crash. Always set `--max-old-space-size` to ~75% of the container limit.
> This is why the env var is in the compose file and not left to chance.

## 4.8 Three sizing scenarios

### Scenario 1 — Dev laptop (this machine, verified)

Budget against the **7.75 GiB Docker VM**, not the 32 GiB host.

| Service | cpus | memory | Note |
|---|---:|---:|---|
| `ocr-db` | 1.0 | 1536M | |
| `ocr-web` | 1.0 | 1024M | |
| `ocr-worker` × 1 | 1.5 | 3072M | **W = 1** (memory-bound, §4.4.1) |
| `ocr-backup` | 0.5 | 512M | often `--scale ocr-backup=0` locally |
| Docker/containerd overhead | — | ~400M | |
| **Total** | 4.0 | **≈ 6.5 GB of 7.75 GB** | ~1.2 GB headroom |

Throughput ≈ **13 pages/min** all-scanned. A 50-page scanned PDF ≈ **3.8 minutes**. Fine for dev,
useless as a performance signal.

> **Owner action:** raise Docker Desktop memory to **16 GB** before M2. Per the corrected §4.4.1
> formula that lifts `W` from 1 to **3** — `⌊(16 − 3.6)/3.0⌋ = 4` on memory, `⌊(8 − 2.5)/1.5⌋ = 3` on
> CPU, so CPU becomes the binding constraint — and takes the dev loop from 13 to **40 pages/min**.
> (The draft said "3–4"; 3 is the answer, because at 16 GB this box becomes CPU-bound.) We must not
> change this ourselves.

### Scenario 2 — Small production VPS, 4 vCPU / 8 GB (the brief's example)

> 🔴 **REVIEW-PASS CORRECTION.** The draft's budget did not fit. It listed `2 × 2304M` workers and
> totalled **8.2 GB on an 8 GB box** — i.e. it was already ~200 MB over before a single page of OS
> page cache — and it got there by shaving each worker from the 3072M that §4.2 spends a whole
> section justifying down to 2304M, which is inside the range §4.2 explicitly says *"would OOMKill on
> image-heavy Thai scans, which are exactly our target corpus."* Corrected below with `W` as defined
> in §4.4.1.

**Corrected budget — 4 vCPU / 8 GB:**

| Service | cpus | memory |
|---|---:|---:|
| `ocr-db` | 1.0 | 1536M |
| `ocr-web` | 1.0 | 1024M |
| `ocr-worker` × **1** | 1.5 | **3072M** (the number §4.2 derived, not a shaved one) |
| `ocr-backup` | 0.5 | 512M |
| Host OS + Docker + NGINX | — | ~600M |
| **Total** | 4.0 (at the vCPU count, and they do not all peak together) | **≈ 6.6 GB of 8 GB** |
| **Not yet counted: `ocr-clamd`** (§2.1.0 — required by `j` C13, unsized) | ? | **?** |

**8 GB is not "tight". It is a demo size, and the ClamAV row is why it may not even be that.** Honest
assessment:

- ✅ Fits, with ~1.4 GB of genuine headroom — **but only at `W = 1`**, and only until the malware
  scanner is sized. ClamAV's resident signature database is not a rounding error; if it needs
  ~1.5–2 GB, this configuration does not fit at all and the answer is 16 GB, not a smaller worker.
- ✅ Throughput at `W = 1`: **~13 pages/min all-scanned, ~42 pages/min at 30 % scanned** ⇒
  ~800–2,500 pages/hour before the 0.7 duty-cycle haircut. Half what the draft promised.
- ⚠️ Zero burst capacity. One 400-page scanned document occupies the entire service for ~30 minutes,
  during which every other customer's job waits. `h` L22's `priority DESC` is the only mitigation,
  and it is a fairness knob, not capacity.
- ⚠️ Zero headroom for a `VACUUM FULL`, a large export, and an upload burst at the same time.
- ❌ **Do not attempt any local VLM on this box.** Not at 8 GB, not at 32 GB — see §4.9.
- ✅ **Recommended instead: 4 vCPU / 16 GB, or better 8 vCPU / 16 GB.** At 4 vCPU the CPU term
  (§4.4.1) pins `W = 1` no matter how much RAM you add, so the extra 8 GB buys *safety* (headroom for
  ClamAV, exports, VACUUM) rather than throughput. **8 vCPU / 16 GB is the first size that buys
  throughput: `W = 3`, ~40 pages/min all-scanned, ~127 at 30 % scanned.** If someone has to choose
  one production box, that is the recommendation, and the ~3× throughput difference is worth stating
  in the same sentence as the price.

**Disk:** 40 GB is the floor (OS 8 + images 3 + Postgres 5 + files 20 + logs/backups 4). For 50k
documents, provision **150 GB**. Add ~1 GB for the ClamAV signature database once that tier exists.

### Scenario 3 — "GPU-assisted"

**Our stack adds zero GPU containers. This is a deliberate, load-bearing decision.**

The only GPU touchpoint is the **optional** escalation to a VLM (`d-ocr-engine.md`'s secondary
choice, Typhoon OCR 1.5), and that call goes `ocr-web → LiteLLM gateway → whatever GPU the gateway
fronts`. Nothing in our compose file changes. What changes is item R (§5.2), not item P.

Compose delta for the GPU-assisted branch: **none.**

## 4.9 GPU: OCR does not need it, and must not take it

### 4.9.1 The recommended design is CPU-only, on purpose

`d-ocr-engine.md §1` selects **PP-OCRv5 Thai on ONNX Runtime via RapidOCR** as the primary engine
precisely because it is CPU-real-time. Consequences:

- Deployment target is any commodity VPS. No CUDA driver, no `nvidia-container-toolkit`, no
  device plugin, no driver/CUDA version matrix.
- The dev box has **no usable GPU** (`d-ocr-engine.md §0`: Iris Plus iGPU, no CUDA, no ROCm). A
  GPU-dependent design would be undevelopable locally, which is a project risk long before it is a
  performance question.
- Horizontal scaling is `--scale ocr-worker=N` on cheap CPU instances.

### 4.9.2 🔴🔴 If we ever GPU-accelerate OCR, we can take down INNOVERA Chat

> ## ⚠️ VRAM CONTENTION IS NOT "SLOWER CHAT". IT IS "CHAT FAILS TO START."
>
> vLLM's `--gpu-memory-utilization` **defaults to 0.9** and vLLM **pre-allocates that share of VRAM
> at startup** for weights + activations + the PagedAttention KV-cache pool. It is not lazy, and it
> does not give memory back. It is a **per-instance** setting: vLLM does not know or care that
> another process is on the device.
> ([vLLM optimization docs](https://docs.vllm.ai/en/stable/configuration/optimization/),
> [vLLM forum: what does gpu_memory_utilization include](https://discuss.vllm.ai/t/what-does-gpu-memory-utilisation-include/1651))
>
> Therefore, on a shared GPU:
>
> - **Chat first, OCR second** → our CUDA process gets `CUDA error: out of memory` on its first
>   allocation. Our jobs fail. Chat is unharmed. *(The good outcome.)*
> - **OCR first, Chat restarts (deploy, reboot, OOM, `restart: unless-stopped`)** → **vLLM fails to
>   allocate its KV cache and INNOVERA Chat does not come back up.** Our OCR container caused an
>   outage in a service we were explicitly told not to touch. *(The bad outcome — and it happens on
>   the next routine restart, possibly weeks after our change, which makes it very hard to
>   attribute.)*
> - **Both running** → PCIe/SM contention, unpredictable p99 on both, and neither team's dashboards
>   explain it.
>
> **Rule: no OCR CUDA process on any GPU that serves INNOVERA Chat. Not "carefully". Not "off-peak".
> Not at all.**

**If GPU OCR ever becomes genuinely necessary, the acceptable options are, in order:**

1. **A separate GPU** (or a separate host). Clean, boring, correct.
2. **MIG partitioning** (A100/H100 class only) — hardware-isolated slices with their own memory.
   Requires an owner-approved reconfiguration of the GPU and a Chat restart.
3. **Lower vLLM's `--gpu-memory-utilization`** to carve out a slice. This directly shrinks Chat's
   KV-cache pool, which reduces its **maximum concurrent sequences** — the effect is fewer
   simultaneous Chat users, not slower ones, and it will look like a capacity regression to whoever
   owns Chat. **Requires their explicit sign-off and a Chat restart.**
4. **Route the VLM through the existing LiteLLM gateway** and let its owner do the scheduling. This
   is what §5.2 recommends, and it is the only option that requires **no change to the GPU host at
   all**.

**UNVERIFIED, and it matters:** we do not know whether the INNOVERA GPU host runs vLLM, what
`--gpu-memory-utilization` it uses, how much VRAM it has, or whether Chat and any OCR-capable model
would share a device. Owner questions Q3 and Q9 in `b-ai-topology-discovery.md §…` cover this.
**Until answered, treat the GPU as fully committed to Chat.**

---

# ITEM R — Production impact on the existing INNOVERA estate

## 5.1 M0 changes nothing. Here is the proof.

| Class of change | Done in this session? | Evidence |
|---|---|---|
| Container started/stopped/built | **No** | Only `docker ps`, `docker network ls`, `docker volume ls`, `docker system df`, `docker version/info` — all read-only |
| Package installed | **No** | No pip/npm/brew/apt invoked |
| Production host contacted | **No** | No connection to `72.62.253.185`, `52.221.213.43`, `141.98.17.91`, `187.52.117.52`. No port scan. |
| NGINX file written or reloaded | **No** | `which nginx` → **not found** on this workstation; there is no NGINX here to touch |
| DB write | **No** | No `psql`, no client connection to any of the running databases |
| File written outside `/Users/innovera/Documents/OCR` | **No** | This document is the only file this dimension wrote |
| Docker Desktop reconfigured | **No** | The 16 GB memory increase is an **owner action**, flagged twice, not taken |

Network calls made: public documentation only — `nginx.org`, `nextjs.org`, `docs.litellm.ai`,
`docs.vllm.ai`, GitHub issue pages, `packages.debian.org`. All listed in §6.

## 5.2 Added load on the shared LiteLLM gateway and the shared GPU

`b-ai-topology-discovery.md` Q9 asks the decisive question: *"Is this the same gateway that serves
the existing INNOVERA Chat?"* **Unanswered.** Both branches below assume "yes, shared" — the
pessimistic case.

> 🔴 **REVIEW-PASS FABRICATION CHECK — read this before any number in §5.2.**
>
> The draft labelled its two branches *"Branch T — text-only **Qwen**"* and *"Branch V —
> vision-capable **Qwen**"*, and computed Branch V's token cost with the **Qwen2.5-VL** patch-merge
> formula. Stated that way, it reads as though the model behind the INNOVERA gateway is known to be
> Qwen. **It is not known.** What is actually established:
>
> | Claim | Status |
> |---|---|
> | The gateway exists | **UNRESOLVED.** No base URL, host, or port is recorded in any file this project may read. `b-ai-topology-discovery.md` Q3. |
> | It is LiteLLM | **ASSUMED**, from the project brief. Not verified against a live `/model/info`. |
> | It fronts a Qwen model | **ASSUMED**, from the project brief. Never verified. |
> | It fronts a **vision-capable** model | **UNRESOLVED** — this is the entire reason Branch T and Branch V exist as branches rather than a decision. `c-ai-capability-probe.md` exists to answer it. |
> | It is the same gateway that serves INNOVERA Chat | **UNRESOLVED.** `b` Q9. §5.2 assumes "yes, shared" as the pessimistic case, which is the right posture. |
> | The GPU host runs vLLM, at what `--gpu-memory-utilization`, with how much VRAM | **UNRESOLVED.** §4.9.2 already says so; §5.2 must inherit that uncertainty rather than quietly spending it. |
>
> **Nothing below may be quoted as a property of the INNOVERA stack.** The branches are renamed
> **T (text-in)** and **V (image-in)** to stop the model name from smuggling in a fact. The
> Qwen2.5-VL formula is retained because it is the best available *order-of-magnitude* anchor for
> any modern patch-based vision encoder — and because the **ratio** it establishes (an unresized
> 300 dpi page costs ~4× a 150 dpi one) is a property of pixel counts, not of Qwen, so the
> operational rule it produces survives whatever the model turns out to be.
>
> **Two further caveats the draft did not state, both of which move the numbers:**
>
> 1. **`tokens ≈ (H × W)/(28 × 28)` is an upper bound, not a fixed cost.** The Qwen-VL processors
>    apply a *smart resize* that snaps dimensions to multiples of 28 and clamps total pixels to a
>    configured `max_pixels` (commonly ~12.8 Mpx, but it is a deployment setting). A server
>    configured with a low `max_pixels` will silently downscale our unresized 300 dpi page — which
>    *helps* the token bill and *hurts* OCR accuracy, invisibly. Our mandatory client-side resize
>    (below) is what makes the behaviour deterministic and ours.
> 2. **`d-ocr-engine.md`'s own VLM candidate is Typhoon OCR 1.5, whose base is `Qwen3-VL-2B`**, not
>    Qwen2.5-VL. Different generation, potentially different patch/merge geometry. If Branch V is
>    ever enabled, **measure the actual tokens-per-page against the actual endpoint** — it is one
>    request and it replaces this whole table.

### 5.2.1 Token arithmetic — Thai is expensive

Thai has no word spaces, so subword tokenisers fragment it heavily. A rule of thumb consistent with
BPE behaviour on Thai is **1 token per ~1.5–2.5 Thai characters**. A text-dense A4 Thai business page
holds ~1,500–2,500 characters ⇒ **~800–1,600 tokens/page**. Planning figure: **1,200 tokens/page.**
**UNVERIFIED:** the actual tokeniser's Thai ratio — measure it as probe rung `b` the moment a
gateway is reachable; it swings this whole section by ±40%.

**Branch T — text-in** (`ocr-web` sends OCR text for structuring/enrichment). Model UNRESOLVED:

```
per document (6 pages):  6 × 1,200 = 7,200 input tokens  +  ~1,500 output tokens
                                    = 8,700 tokens/document

1,000 documents/day  →  8.7 M tokens/day
spread over an 8-hour business day → 302 tokens/s average
realistic 3× business-hours peak   → ~900 tokens/s peak
```

**Branch V — image-in** (`ocr-web` sends page images). Model AND vision capability UNRESOLVED:

Qwen-VL-family image tokens: `tokens ≈ (H × W) / (28 × 28)` — patch 14 px with a 2×2 merge
([Qwen2.5-VL patch-merger discussion](https://github.com/QwenLM/Qwen2.5-VL/issues/633)).

| Image sent | Pixels | **Tokens/page** |
|---|---:|---:|
| A4 @ **300 dpi**, unresized | 2480 × 3508 | **11,097** 🔴 |
| A4 @ 200 dpi | 1654 × 2339 | 4,934 |
| A4 @ **150 dpi** ✅ | 1240 × 1754 | **2,774** |
| A4 @ 110 dpi | 909 × 1286 | 1,491 |

> ### 🔴 Sending an unresized 300-dpi page to a VLM costs **11,097 tokens — 9.2× the text branch,
> for one page.** A 6-page document is ~67k input tokens, likely past the model's context window,
> and it is **prefill**, which is GPU-compute-bound. Prefill competes directly with Chat's decode
> for SM time.
>
> **Mandatory rule if branch V is ever enabled: downscale to ≤150 dpi (long edge ≤ 1,754 px) before
> sending, and enforce it in code with a test, not a comment.** `e-native-extraction-routing.md` E9
> already specifies an RGB render for the VLM branch — pair that with a hard resize cap.

Branch V at 150 dpi: 6 × 2,774 ≈ **16,600 input tokens/document**, ≈ **1.9×** branch T. Unresized:
**≈ 7.7×**. That factor of 4 between "did the resize" and "forgot the resize" is the single largest
lever on our impact to INNOVERA Chat.

### 5.2.2 Impact assessment

**UNVERIFIED throughout — the GPU, model and current Chat load are all unknown.** As an
order-of-magnitude anchor: a single L40S/A100-class GPU serving a 7B-class model typically sustains
**~1,000–3,000 output tok/s aggregate** with continuous batching; prefill throughput is higher per
token but is what a document workload consumes almost exclusively.

| Volume | Branch T (text-in) | Branch V (image-in) @150 dpi | Verdict |
|---|---|---|---|
| 100 docs/day | 0.87 M tok/day | 1.7 M tok/day | Noise. Ship it. |
| 1,000 docs/day | 8.7 M tok/day, ~900 tok/s peak | 17 M tok/day | **Material.** Chat p95 latency will move. Needs a separate key with limits (§5.3). |
| 10,000 docs/day | 87 M tok/day | 170 M tok/day | **Will visibly degrade Chat.** Needs a dedicated model deployment, a separate GPU, or off-peak batching. |

**Three architectural mitigations, in order of preference:**

1. **Prefer the deterministic path.** The OCR engine is the system of record in *both* branches
   (`d-ocr-engine.md §1`, `c-ai-capability-probe.md §6`). The AI call is an **optional
   post-processor**. Gate it: call the gateway only when OCR confidence is below threshold, or the
   user explicitly requests enrichment. This alone can cut gateway traffic by 60–90%.
2. **Batch off-peak.** Non-interactive enrichment (bulk imports, backfills) runs 22:00–06:00
   Asia/Bangkok when Chat is idle, driven by a `run_after` timestamp on the job row. Costs one
   column; buys the entire peak window.
3. **Cache aggressively.** The same document re-processed must not re-hit the gateway. Key the cache
   on `sha256(normalised_text) + model_id + prompt_version` — the extraction hash
   `f-preprocessing-and-confidence.md` already defines gives us this nearly for free.

## 5.3 A separate LiteLLM virtual key — **strongly recommended**

**Recommendation: yes, a dedicated virtual key for OCR, with its own budget, rate limits and model
allowlist. Not INNOVERA Chat's key. Definitely not the master key.**

Four reasons:

1. **Blast-radius containment.** `b-ai-topology-discovery.md` Q5 makes the point sharply: *"A master
   key in an application container is a full-control credential over the entire gateway (it can mint
   further keys)."* `ocr-web` is internet-facing. A compromise there must not become gateway
   administration.
2. **A runaway OCR job cannot starve Chat.** With `rpm_limit`/`tpm_limit`/`max_parallel_requests` on
   our key, a retry storm hits *our* ceiling and 429s *us*. Without them, it consumes shared GPU
   capacity until someone notices.
3. **Attribution.** Per-key spend and token accounting answers "what did OCR cost this month?"
   without log archaeology. Impossible with a shared key.
4. **Independent revocation.** Rotating or revoking the OCR key must not log out Chat.

LiteLLM's `POST /key/generate` accepts exactly these parameters (verbatim from the
[Virtual Keys docs](https://docs.litellm.ai/docs/proxy/virtual_keys), fetched this session):
`models`, `max_budget`, `budget_duration`, `rpm_limit`, `tpm_limit`, `max_parallel_requests`,
`metadata`, `duration`, `user_id`, `team_id`, `aliases`.

**Proposed request — for the GATEWAY OWNER to run, not us:**

```bash
# Run by the LiteLLM administrator, on the gateway host, with the MASTER key.
# We never see the master key; we receive only the returned sk-... value.
curl -sS "${LITELLM_BASE_URL}/key/generate" \
  --header "Authorization: Bearer ${LITELLM_MASTER_KEY}" \
  --header 'Content-Type: application/json' \
  --data-raw '{
    "key_alias": "innovera-ocr-ai-prod",
    "models": ["<EXACT MODEL ID FROM /model/info — WE DO NOT KNOW IT YET>"],
    "max_budget": 50,
    "budget_duration": "30d",
    "rpm_limit": 60,
    "tpm_limit": 120000,
    "max_parallel_requests": 4,
    "duration": "90d",
    "metadata": {
      "service": "innovera-ocr-ai",
      "env": "prod",
      "owner": "ocr-team",
      "runbook": "docs/architecture/m0/m-docker-nginx-resources.md#53"
    }
  }'
```

**Where those numbers come from — and they are starting points, not truths:**

| Field | Value | Arithmetic |
|---|---|---|
| `tpm_limit` | 120,000 | Branch T at 1,000 docs/day peak ≈ 900 tok/s ≈ 54,000 tok/min. 120k gives ~2.2× burst headroom while still capping us at a fraction of a GPU. |
| `rpm_limit` | 60 | One request per document (batched pages) at 1,000 docs/day, business hours, 3× peak ≈ 6 rpm. 60 is 10× headroom and still a hard stop on a retry storm. |
| `max_parallel_requests` | 4 | ≈ our worker count. This is the **most important field**: it directly caps how much of the GPU's batch slots we can hold at once, which is what actually determines Chat's latency. |
| `max_budget` / `budget_duration` | 50 / `30d` | A **circuit breaker**, not a forecast. On a self-hosted model the "cost" may be notional; the value is that a runaway loop stops. Set it, watch actual spend for 30 days, then set it for real. |
| `duration` | `90d` | Forces a rotation cadence. Put the expiry in the team calendar — an unmonitored key expiry is a self-inflicted outage. |
| `models` | **allowlist** | Never omit. An unscoped key can call every model the gateway fronts, including expensive ones we never intended to touch. |

**Also required, and separate:** a **second, tighter key for staging/dev** (`key_alias:
innovera-ocr-ai-staging`, `max_parallel_requests: 1`, `max_budget: 5`). A developer's loop must
never be able to affect production Chat.

**On rate-limit behaviour:** LiteLLM returns HTTP **429** when a key's limit is hit. `ocr-web` must
treat 429 as **retryable with exponential backoff + jitter**, honour `Retry-After` if present, and
**never** as a job failure. `c-ai-capability-probe.md` contemplates a circuit breaker; 429 should
open it, not fail the document — remember the deterministic OCR result is already saved and is the
system of record.

## 5.4 Port and host collisions

**Verified in-session on this workstation** (`docker ps`, `lsof -nP -iTCP -sTCP:LISTEN`):

| Port | Bound to | Owner | Can we use it? |
|---|---|---|---|
| 5000, 7000 | `*` (all ifaces) | macOS `ControlCenter` (AirPlay Receiver) | **NO** — and note these are an OS service, not an app; disabling them is an owner decision |
| 5037 | `127.0.0.1` | `adb` | NO |
| **5432** | `127.0.0.1` | `krs-pos-db` ✅ correct pattern | **NO — hard collision with our Postgres default** |
| **8080** | `*` | `quotation-system-app` | **NO** |
| **1433** | `*` | `orderstock-sql` ⚠️ over-exposed | NO |
| 55243 | `*` | `rapportd` (Handoff) | NO |
| 3000 | — | *(free on the host; `quotation-system-api` uses it container-internal only)* | container-internal only for us too |
| 20021, 23961, 29023, 49368, 52100, 53390, 53425, 10274 | `127.0.0.1` | VS Code / JetBrains | ephemeral, ignore |

**Proposed OCR port block — every one verified free in the `lsof` output above:**

| Port | Service | Binding | Environment |
|---|---|---|---|
| **8410** | `ocr-web` | `127.0.0.1:8410:3000` | all |
| **8411** | `ocr-worker` health/metrics | `expose:` only, **never published** | all |
| **8432** | `ocr-db` | `127.0.0.1:8432:5432` | **dev overlay only** |
| 8412–8419 | reserved for OCR growth | — | — |

Mnemonic: `84xx` = "OCR". The block is contiguous, documented, and far from every incumbent.

**Non-port collisions, also checked:**

| Namespace | Existing on this host | Ours | Collides? |
|---|---|---|---|
| Compose project | `quotation-system`, `orderstock`, `pos`, `jf-*`, `juneflow-*`, `jawbong-phase00` | `ocr` | ✅ no |
| Docker network **name** | `bridge`, `host`, `none`, `jf-lx2_default`, `jf-w26lock_default`, `jf-w29_default`, `juneflow-linrb_default`, `orderstock_default`, `pos_default`, `quotation-system_default` | `ocr_ocr-internal`, `ocr_ocr-egress` | ✅ no |
| Docker network **SUBNET** | 172.17–172.24 (all eight `/16`s, verified §0.4) | 172.28.0.0/16, 172.29.0.0/16 (now pinned) | ✅ no — **but see below; the draft did not check this at all** |
| Volume | 155 volumes, mostly unnamed hashes | `ocr_postgres_data`, `ocr_file_storage`, `ocr_scratch`, `ocr_backups` | ✅ no |
| Container | `quotation-system-*`, `krs-pos-db`, `orderstock-sql` | `ocr-web-1`, `ocr-db-1`, `ocr-worker-N` | ✅ no |

**🔴 Review-pass addition: the collision the draft missed is an address collision, not a name
collision.** Docker's default pool (`172.17.0.0/12` in `/16` chunks) has **16 slots and 8 are used**
on this workstation (§0.4). Ours take it to 10. Every future compose project on this box takes
another, and every stopped juneflow stack reclaims its slot when restarted. Exhaustion produces
`could not find an available, non-overlapping IPv4 address pool among the defaults` at `up` time —
which is at least loud. The *silent* version is on a VPS, where a Docker bridge that overlaps the
provider's private VLAN breaks the host's route to its own metadata service, block storage or backup
network, and does so only for traffic that happens to fall in the overlapping range.

**On the target VPS**, run TCL's preflight (`~/Documents/TCL/docs/deploy-vps.md` §0) **plus the four
review-pass checks**, before anything:

```bash
export LC_ALL=C

# --- TCL's original preflight ---
ss -tlnp | grep -E ':(80|443|8410|8411|8432)\s' || echo 'all free'
docker ps --format 'table {{.Names}}\t{{.Ports}}'
docker network ls --format '{{.Name}}' | grep -i ocr || echo 'network name free'
docker volume  ls --format '{{.Name}}' | grep -i ocr || echo 'volume names free'
df -h /opt | tail -1 ; free -h | head -2

# --- review-pass additions ---

# 1. SUBNET overlap: our two /16s must not collide with the host's own routes.
ip route | grep -E '172\.(28|29)\.' \
  && { echo "STOP: 172.28/29 already routed on this host — pick another pair"; exit 1; } \
  || echo 'ocr subnets free'

# 2. How much of Docker's pool is already spent here?
docker network ls -q | xargs -r docker network inspect \
  --format '{{.Name}} {{range .IPAM.Config}}{{.Subnet}}{{end}}' | sort -k2

# 3. Is the provider's private network inside 172.16/12 or 10/8? (the silent one)
ip -o addr show | awk '{print $2, $4}' | grep -vE '^lo|127\.0\.0\.1'

# 4. Existing backup schedules, so §5.6's BACKUP_HOUR does not collide.
crontab -l 2>/dev/null; ls -la /etc/cron.d/ 2>/dev/null
systemctl list-timers --all 2>/dev/null | grep -iE 'backup|dump|restic|borg' || echo 'no backup timers'
```

## 5.5 Disk pressure

**On this workstation (verified `docker system df`, `df -h`):**

```
Filesystem     Size   Used  Avail  Capacity   Mounted on
/dev/disk1s4  466Gi  169Gi  276Gi     38%     /System/Volumes/Data

TYPE            TOTAL  ACTIVE  SIZE     RECLAIMABLE
Images            110       8  39.46GB  12.47GB (31%)
Containers         24       5   1.62MB   1.44MB (88%)
Local Volumes     155      12   9.11GB   8.16GB (89%)
Build Cache       402       0  24.00GB  21.47GB (89%)
```

**Docker already occupies ~72.6 GB, of which ~42 GB is reclaimable.** Adding OCR:

| Item | Size |
|---|---:|
| `ocr-web` image | ~350 MB (est.) |
| `ocr-worker` image | ~665 MB (est., §2.4.5) |
| `postgres:18.6-trixie` | ~440 MB |
| Build cache for two multi-stage builds (Python wheels + pnpm store) | **2–5 GB** |
| Dev data (a few hundred test documents) | ~1 GB |
| **Added on the dev box** | **≈ 5–8 GB** |

276 GB free — no problem. But **the build cache is the term that grows without bound**: 402 entries
and 24 GB already, from projects that are not even running. Recommendation for the dev box (owner's
call, we do not run it):

```bash
docker buildx prune --filter until=336h    # drop build cache older than 14 days
docker image prune -a --filter until=720h  # drop images unused for 30 days
```

**On a production VPS,** the disk-pressure sources, ranked:

1. **`ocr_file_storage`** — the one that actually grows. ~2 GB per 1,000 documents (§4.6). **Alert at
   80%, hard-refuse uploads at 90%** — a full disk mid-write corrupts Postgres, and "cannot accept
   uploads" is a far better outcome than "database will not start". 🔴 **Review-pass: "alert" and
   "hard-refuse" are verbs, not mechanisms. Specified in §5.5.1 below.**
2. **`ocr_scratch`** — bounded by `W × ~9 MB` under the one-page-at-a-time policy, but **unbounded if
   that policy is ever violated**. 🔴 **Do NOT "add a startup sweep that empties `/scratch`" — that
   was the draft's wording and it is a data-loss bug once `W > 1`, because every replica shares the
   volume. See §2.7.4 for the corrected per-worker, mtime-based sweep.** The size alarm is
   per-worker-subtree at 2 GB, which also makes it actionable: it names a container.
3. **Postgres WAL** — `wal_compression=zstd` is set; ensure no orphaned replication slot exists
   (`SELECT * FROM pg_replication_slots WHERE NOT active;`). An inactive slot pins WAL forever and is
   the classic way a Postgres box fills its disk overnight.
4. **Container logs** — capped at 10 MB × 3 × 5 services = **150 MB max**, by the `x-logging` anchor.
   Without it, an OCR error loop writes gigabytes in hours.
5. **NGINX access logs** — `logrotate` is the host's job, not ours; confirm it covers
   `/var/log/nginx/ocr.*.log` before go-live.
6. **`proxy_temp`** — §3.3 location 2 sets `proxy_buffering off` + `proxy_max_temp_file_size 0`
   precisely so N concurrent 200 MB downloads do not become N × 200 MB of host disk.

**Provisioning:** 40 GB minimum; **150 GB for 50k documents**; move to object storage
(`i-storage.md` J7) before 100k.

### 5.5.1 🔴 "Alert at 80 %, refuse at 90 %" — the actual mechanism

The draft asserted a policy and named no mechanism, which is the difference between a plan and an
intention. Here is the whole thing; it is three small pieces and none of them needs new
infrastructure.

**Thresholds, stated once, as configuration:**

| Name | Value | Applies to |
|---|---|---|
| `STORAGE_WARN_PCT` | 80 | `ocr_file_storage` filesystem |
| `STORAGE_REFUSE_PCT` | 90 | `ocr_file_storage` filesystem |
| `STORAGE_REFUSE_ABS_MB` | 2048 | absolute floor — on a 2 TB disk, 10 % is 200 GB and you want to refuse long before that; on a 40 GB disk, 10 % is 4 GB and you want the percentage. Refuse when **either** trips. |
| `SCRATCH_ALARM_MB` | 2048 | per `/scratch/<worker_id>` subtree |

**Piece 1 — measurement.** `ocr-web` already has the volume mounted. A `statvfs` on
`OCR_STORAGE_ROOT` is one syscall; sample it every 30 s in a background task and cache the result.
Export it as the gauge `n-observability-testing-benchmark.md` N9's `prom-client` registry already
exists to hold:

```ts
// src/lib/obs/metrics.ts — registered once, per N14's cardinality rule (no per-path labels)
export const storageBytesFree  = new Gauge({ name: 'ocr_storage_bytes_free',  help: '...' });
export const storageBytesTotal = new Gauge({ name: 'ocr_storage_bytes_total', help: '...' });
export const storageRefusing   = new Gauge({ name: 'ocr_storage_refusing', help: '1 = uploads refused' });
```

**Piece 2 — enforcement, in the upload route, before a byte is written.** This is the part that
must not be a dashboard:

```ts
// the upload Route Handler (l-api-ui-export.md L-1), first thing after auth
const s = await storageHealth();               // cached, 30 s
if (s.usedPct >= STORAGE_REFUSE_PCT || s.freeMb <= STORAGE_REFUSE_ABS_MB) {
  storageRefusing.set(1);
  return Response.json(
    { error: { code: 'storage-full',
               message: 'พื้นที่จัดเก็บเต็ม ไม่สามารถอัปโหลดได้ชั่วคราว / Storage full; uploads are temporarily disabled.',
               requestId } },
    { status: 507 });                          // 507 Insufficient Storage — a real, specific code
}
```

**507, not 500 and not 503.** A monitoring system, a retrying SDK and a human all need to
distinguish "we are full" from "we are broken", because the remediation is completely different and
retrying does not help.

**Piece 3 — the alert.** `n` Q5 records that whether a Prometheus exists is **owner-blocked**, so
this dimension must specify a path that works either way:

| If a Prometheus/Alertmanager exists (n Q5 answered "yes") | If it does not (M1 fallback) |
|---|---|
| `ocr_storage_bytes_free / ocr_storage_bytes_total < 0.20` for 10 m → warning; `< 0.10` → page. The 10-minute `for:` clause matters: a large export briefly consuming space must not page anyone. | The **backup sidecar** already runs nightly and already has a shell. Add a `df` check to `docker/backup.sh` that writes a marker file and exits non-zero; `restart: unless-stopped` plus a non-zero exit is visible in `docker compose ps`. Crude, but it is the difference between "we found out from a customer" and "we found out". |

**Piece 4 — the same shape for the other three sources**, so this is a pattern and not a one-off:

| Source | Detection | Action |
|---|---|---|
| `ocr_scratch` per-worker subtree > `SCRATCH_ALARM_MB` | the worker's own 30 s heartbeat tick (`h` L4) already runs; add a `du -s` on its own subtree | log at `error` with `worker_id`; refuse to claim a **new** job until it drops. Refusing to claim is safe — the job stays `PENDING` and another worker takes it. |
| Postgres WAL pinned by an inactive replication slot | `SELECT slot_name, active, pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) FROM pg_replication_slots WHERE NOT active;` in the nightly backup script | alert if any row returns > 1 GB. This is the classic overnight disk-fill and it has no other symptom until the disk is full. |
| Container logs exceeding the cap | none needed — `x-logging` caps them at 10 MB × 3 × 5 = **150 MB** | the cap *is* the mechanism; this row exists to say so explicitly |
| NGINX access logs | the host's `logrotate` | **confirm before go-live** (§6 item 17). Not ours, and therefore easy to assume. |

## 5.6 Backup impact on the existing estate

`ocr-backup` runs `pg_dump` at 02:00 Asia/Bangkok by default (TCL's `BACKUP_HOUR`).

**Collision risk:** if the target host already runs backups for quotation-system or orderstock at
02:00, they contend for disk I/O and network. Two dumps and an rsync at once on a small VPS is a
visible latency event for whatever else is running.

- **Check first:** `crontab -l; ls -la /etc/cron.d/; systemctl list-timers --all | grep -i backup`
- **Set `BACKUP_HOUR` to an unoccupied slot**, e.g. `3` if the incumbent uses 02:00.
- **Bandwidth:** the nightly compressed dump is small at our scale (a 200 MB database dumps to
  roughly 20–40 MB with `-Fc -Z 6`). The `ocr_file_storage` sync is the heavy one — use `restic` or
  `rsync` **incrementally**, never a full re-copy, and rate-limit it (`rsync --bwlimit=5000`) so it
  cannot saturate a shared uplink during business hours.
- **Do not reuse another project's SSH key or backup destination path.** A separate key with a
  separate `authorized_keys` entry restricted by `command=` and `from=`, and a separate destination
  directory, so an OCR backup bug cannot damage quotation-system's backups.

## 5.7 Rollback story

### 5.7.1 What is and is not reversible

| Change | Rollback | Time |
|---|---|---|
| `ocr-web` / `ocr-worker` image | `OCR_VERSION=<previous-sha> docker compose up -d` | < 60 s |
| Compose config | `git revert` + `up -d` | < 2 min |
| NGINX | §3.7.2 step 6 | < 2 min |
| Docker volumes | untouched by a rollback — they persist | n/a |
| **Prisma migration** | **NOT automatically reversible** | see below |
| **Data written under the new code** | **NOT reversible** | see below |

### 5.7.2 The migration contract — expand/contract, two releases minimum

`prisma migrate deploy` rolls forward only. Therefore:

> **Rule: no migration may destroy information that the previous release's code depends on.**
>
> - **Release N (expand):** add the new column/table. Write to both old and new. Read from old.
>   Deploy. **The previous image still works against this schema** — that is the whole point.
> - **Release N+1 (migrate):** read from new. Backfill complete. Old column still present, still
>   written.
> - **Release N+2 (contract):** stop writing old. Drop it in N+3.
>
> A `DROP COLUMN` in the same release that stops using it makes rollback impossible, because the
> previous image `SELECT`s a column that no longer exists and crash-loops.

Enforce it in CI: fail the build if a migration contains `DROP COLUMN`, `DROP TABLE`, or a
`NOT NULL` addition without a default, unless the file name carries an explicit `_contract` suffix
and the PR is labelled.

### 5.7.3 `deploy.sh` — modelled on `~/deploy-krspos.sh`

The krs-pos script's six-stage shape transfers directly (`a-environment-and-stack.md §8.2`), with
stages 1 and 6 re-pointed at our queue:

> 🔴 **REVIEW-PASS REWRITE.** The draft's script had four defects, three of which make it fail on
> the **first** deploy — i.e. the one time nobody has a working script to fall back on:
>
> | # | Defect | Effect |
> |---|---|---|
> | 1 | Stage 1 runs `$COMPOSE exec -T ocr-db` **before** stage 3 starts the stack | On a fresh host there is no running `ocr-db`; `exec` fails; `set -e` aborts. The first deploy can never run. |
> | 2 | Stage 2 pipes `docker compose ps` into `grep` under `set -o pipefail` | On a fresh host `grep` matches nothing, exits 1, `pipefail` propagates, the script aborts — and if it somehow continued, `.deploy-previous` would be **empty** and the stage-5 rollback would run `OCR_VERSION=""`. |
> | 3 | `SELECT … FROM ocr_jobs WHERE status IN (…)` | Wrong table and wrong column. `g` owns the name (`extraction_jobs`) and `h` owns the columns (`state`, not `status`). The query errors; `set -e` aborts. |
> | 4 | Stage 5's rollback re-runs `up -d` with the old tag but does **not** roll back the migration | Correct and unavoidable (`prisma migrate deploy` is forward-only) — but it must be *said*, because "rolled back" implies something it does not deliver. §5.7.2 is the mitigation and the script should point at it. |

```bash
#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C                       # §2.2.4 — never let a Thai locale into a filename or a date
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml"
PSQL="$COMPOSE exec -T ocr-db psql -qtAX -v ON_ERROR_STOP=1"

# 0. local preflight — refuse to deploy anything that is not on origin/main
git fetch origin
git merge-base --is-ancestor HEAD origin/main \
  || { echo "HEAD is not an ancestor of origin/main; refusing"; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "worktree dirty; refusing"; exit 1; }
NEW_SHA=$(git rev-parse --short HEAD)

# 0b. FIRST-DEPLOY DETECTION. Everything in stages 1-2 is meaningful only if a
#     previous stack exists. Ask once, branch once — do not let `set -e` decide.
if $COMPOSE ps --status running --services 2>/dev/null | grep -qx ocr-db; then
  FIRST_DEPLOY=0
else
  FIRST_DEPLOY=1
  echo "no running ocr-db — treating this as a FIRST DEPLOY (skipping drain + rollback capture)"
fi

# 1. PRE-DEPLOY DRAIN CHECK  ← krs-pos stage 1, re-pointed at the queue.
#    Swapping the worker container while a 400-page document is mid-extraction
#    orphans its job rows. Table/columns per g-data-model.md + h L4/L15:
#      table  extraction_jobs   (h writes `ocr_jobs` as a readability alias)
#      column state             ('PENDING'|'PROCESSING'|'RETRYING'|'DONE'|'FAILED'|'DEAD')
#    Note we do NOT need to wait for PENDING — those are safe to leave queued.
if [ "$FIRST_DEPLOY" -eq 0 ]; then
  IN_FLIGHT=$($PSQL -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -c "SELECT count(*) FROM extraction_jobs WHERE state IN ('PROCESSING','RETRYING');")
  IN_FLIGHT=${IN_FLIGHT//[[:space:]]/}
  if [ "${IN_FLIGHT:-0}" -ne 0 ]; then
    echo "ABORT: $IN_FLIGHT jobs in flight."
    echo "  Wait for them (a 400-page document can take ~30 min at W=1 — see §4.4.1),"
    echo "  or drain deliberately: stop claiming, let leases expire, then redeploy."
    exit 1
  fi
fi

# 2. record the CURRENT version so rollback is one command, not archaeology
if [ "$FIRST_DEPLOY" -eq 0 ]; then
  PREV=$($COMPOSE ps --format '{{.Image}}' 2>/dev/null | grep 'innovera/ocr-web' | head -1 || true)
  if [ -n "$PREV" ]; then
    printf '%s\n' "$PREV" > .deploy-previous
    echo "rollback target: $PREV"
  else
    rm -f .deploy-previous
    echo "WARNING: could not determine the running image; automatic rollback is DISABLED for this run"
  fi
fi

# 3. start. NOTE: no `--build`. The prod overlay sets `build: !reset null` (§2.2.2);
#    production pulls a tested image, it does not build on the box.
#    ocr-migrate runs first via service_completed_successfully.
OCR_VERSION="$NEW_SHA" $COMPOSE pull
OCR_VERSION="$NEW_SHA" $COMPOSE up -d

# 4. surface migration output — a failed migration must be loud, not buried
$COMPOSE logs --no-color ocr-migrate | tail -50
# ⚠️ A FAILED MIGRATION IS NOT ROLLED BACK BY STAGE 5. prisma migrate deploy is
#    forward-only; §5.7.2's expand/contract discipline is what makes the previous
#    image still able to run against the new schema. If stage 5 fires and the
#    migration succeeded, you are rolling back CODE only — which is exactly what
#    expand/contract is designed to make safe, and is unsafe without it.

# 5. health gate: poll, do not sleep-and-hope
for i in $(seq 1 25); do
  s=$(docker inspect --format '{{.State.Health.Status}}' ocr-web-1 2>/dev/null || echo starting)
  [ "$s" = healthy ] && break
  if [ "$i" -eq 25 ]; then
    echo "UNHEALTHY after 150s"
    if [ -s .deploy-previous ]; then
      echo "rolling back to $(cat .deploy-previous)"
      OCR_VERSION="$(cut -d: -f2 < .deploy-previous)" $COMPOSE up -d
    else
      echo "NO ROLLBACK TARGET RECORDED — leaving the stack as-is for inspection."
      echo "  docker compose logs ocr-web | tail -100"
    fi
    exit 1
  fi
  sleep 6
done

# 6. post-deploy re-check — catches jobs enqueued during the deploy window
$PSQL -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "SELECT state, count(*) FROM extraction_jobs GROUP BY state ORDER BY 1;"
# and confirm nothing is stuck holding an expired lease (h L4)
$PSQL -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "SELECT count(*) AS expired_leases FROM extraction_jobs
       WHERE state='PROCESSING' AND lease_expires_at < now();"
echo "deployed $NEW_SHA"
```

### 5.7.4 The rollback that is not a rollback

If a bad release wrote **wrong extracted data** into `document_pages`, reverting the image does not
un-write it. Two protections, both cheap and both worth having from day one:

1. **`l-api-ui-export.md` L-12's append-only corrections table** (`l` calls it `field_corrections`; `g-data-model.md` §1911 names it **`corrections`** — `g` owns the schema, so `corrections` is the name that ships) means human corrections are never
   destroyed by a bad extraction — they are a separate, additive layer.
2. **Every extraction row carries `engineVersion`, `modelVersion` and `extractionHash`**
   (`f-preprocessing-and-confidence.md`). A bad release is therefore *identifiable* and
   *re-runnable*. **This is only possible because the model weights are baked into the image
   (§2.4.4)** — with volume-mounted weights, `modelVersion` would be a claim rather than a fact, and
   this recovery path would not exist.

   🔴 **Review-pass: the draft's one-line requeue was wrong in three ways and dangerous in a fourth.**
   It read `UPDATE ocr_jobs SET status='PENDING' WHERE engine_version = '<bad>'` — wrong table
   (`extraction_jobs`), wrong column (`state`), and it would also resurrect jobs that are currently
   `PROCESSING`, handing the same document to a second worker while the first still holds a live
   lease. The fencing token makes that *safe* but wasteful, and it makes the queue-depth graph lie.
   It also has no rate control: on a bad release affecting 50,000 documents it enqueues all of them
   at once and the service does nothing else for a day.

   ```sql
   -- Requeue exactly the affected, SETTLED rows. Never touch a live lease.
   -- Run it in batches so the queue depth stays observable and the service stays usable.
   WITH affected AS (
     SELECT j.id
       FROM extraction_jobs j
       JOIN ocr_results r ON r.extraction_job_id = j.id
      WHERE r.engine_version = :bad_version
        AND j.state IN ('DONE','FAILED')          -- settled only
        AND (j.lease_expires_at IS NULL OR j.lease_expires_at < now())
      ORDER BY j.id
      LIMIT :batch                                 -- e.g. 500
      FOR UPDATE SKIP LOCKED
   )
   UPDATE extraction_jobs j
      SET state            = 'PENDING',
          attempts         = 0,                    -- a re-run is not a retry; do not burn max_attempts
          lease_token      = NULL,
          lease_expires_at = NULL,
          -- stagger, so 50k rows do not become one thundering herd
          available_at     = now() + (random() * interval '4 hours'),
          priority         = -10                   -- BELOW live traffic (h L22: priority DESC)
     FROM affected a
    WHERE j.id = a.id;
   ```

   Three things in that statement are the point, and none of them was in the draft: **`priority`
   below live traffic** so a backfill cannot starve paying users; **`available_at` jittered** so the
   re-run spreads over hours instead of arriving as one spike; and **`attempts = 0`** because a
   re-run caused by *our* bad release must not consume the document's `max_attempts = 4` budget and
   push it into `state = 'DEAD'` (`h` L15) on its second genuine failure.

---

## 6. Open questions and owner asks

### Blocking (owner must answer)

| # | Question | Blocks |
|---|---|---|
| 1 | **Deployment target host.** Fresh host (⇒ Caddy in-stack, A-7), an existing `caddy-gen-proxy` host (⇒ TCL label-join), or the quotation VPS with host NGINX (⇒ §3)? | The entire edge design |
| 2 | **Is `72.62.253.185` the target?** If yes, who owns its NGINX and what maintenance window is acceptable? | §3.7 |
| 3 | **Max upload size: 200 MB or 500 MB?** Two sibling docs disagree (§3.4.3) | NGINX `client_max_body_size`, app limit, API docs |
| 4 | **Is the AI gateway shared with INNOVERA Chat?** (`b-ai-topology-discovery.md` Q9) | §5.2 impact assessment |
| 5 | **Who mints the LiteLLM virtual key, and is it virtual or master?** (`b` Q5) | §5.3 |
| 6 | **Does the GPU host run vLLM, at what `--gpu-memory-utilization`, with how much VRAM?** | §4.9.2 |
| 7 | **Raise Docker Desktop to 16 GB** before M2 | Scenario 1 dev throughput (W: 1 → 3) |
| 8 | **Backup destination + a dedicated SSH key** for OCR | §5.6 |
| **9** | **🔴 Is the production VPS 4 vCPU / 8 GB, or larger?** The review pass shows 4/8 fits exactly **one** worker (§4.4.1) — half the draft's claim — and does not yet include the mandatory ClamAV tier. **Recommend 8 vCPU / 16 GB.** This is a *purchasing* decision and it is now blocking. | §4.4.1, §4.8 Scenario 2 |
| **10** | **🔴 What is `clamd`'s resident memory with a current signature database?** `j` C13 puts ClamAV in M1; §2.1.0 cannot size the host without it, and it may be the difference between an 8 GB and a 16 GB box. | §2.1.0, §4.8 |
| **11** | **Does `j`'s Redis session row (`j` §214) mean Redis exists in M1?** If yes, O2's premise changes. Two M0 documents currently disagree by implication. | §2.1.2, O2 |
| **12** | **Nginx version on the target host.** Must be ≥ 1.30.4 stable / 1.31.4 mainline before we hand over a config containing a `map` (CVE-2026-42533, CVE-2026-60005). | §3.7.2 step 0a |
| **13** | **Is there an explicit `default_server` on the target's `:443`?** If not, adding our file can change which vhost answers unmatched Host headers — including for the incumbent. Ask the owner to mark theirs explicitly **before** we install anything. | §3.7.1 risk 3 |

### Non-blocking, but must be resolved in M1

| # | Item |
|---|---|
| 14 | Resolve and pin `sha256` digests for `postgres:18.6-trixie` and both model artefacts (§2.2.2, §2.4.5). The models stage **fails by design** until this is done. |
| 15 | Verify `docker compose v5.1.3` honours `deploy.resources.limits` **and `deploy.replicas`** on this host (§2.2.1). The Compose Specification page does not state platform support levels, so this stays UNVERIFIED until executed. |
| 16 | Verify `ocr-db` boots with `cap_drop: ALL` + the five re-added caps (§2.2) |
| 17 | Run test **T-FONT-1** — does installing `fonts-thai-tlwg` actually change PDFium's output? (§2.4.3) |
| 18 | Verify Next 16.2.12's fetch cache tolerates a tmpfs at `/app/.next/cache` (§2.7.2) |
| 19 | Add `output: 'standalone'` to `next.config.ts` (absent from Jawbong's — verified), **plus `outputFileTracingIncludes` for `messages/**` and any custom Prisma client output** (§2.3.2) |
| 20 | Measure the gateway tokeniser's Thai chars-per-token ratio; §5.2.1 swings ±40 % on it |
| 21 | Decide the derivative-retention policy: Policy A + 90-day demotion vs Policy B (§4.6) |
| 22 | Confirm the target host's `logrotate` covers `/var/log/nginx/ocr.*.log`, **and that its retention matches the product's data-retention promise** — access logs are document-access metadata (§3.2) |
| **23** | **Run the two five-minute PostgreSQL checks together on any PG 18 instance: `ORDER BY … COLLATE th_icu` (§2.2.3) and `SELECT show_trgm('ภาษี');` (§4.5.1).** Between them they settle whether Thai sorting works and whether the M4 search index is 20 MB or 200 MB per 1,000 documents. |
| **24** | **Write `.dockerignore` and `scripts/verify-build-context.sh` (§2.3.1) before the first image is built.** Not after. |
| **25** | **Verify the `fc-match` / Thai-digit smoke tests pass in the built worker image** (§2.4.3) |
| **26** | **Run the volume-ownership acceptance test** (§2.6.1) — setgid + umask, both directions |
| **27** | **Verify `worker-src 'self' blob:` is actually needed** by whatever PDF viewer `l-api-ui-export.md` L-13 selects, and that `next/font`'s inline style carries the nonce (§3.5 item 3b) |
| **28** | **Provide `docker/backup.sh`.** The compose file mounts it via `configs:` and this document never wrote it. It must implement: `pg_dump -Fc -Z 6` to `.part` then `mv`; `LC_ALL=C`; the off-box `rsync --bwlimit`; `.last-offsite-ok`; 14-day retention; the `pg_replication_slots` check from §5.5.1; and the `df` fallback alert. |

---

## 7. Evidence log

**Commands run on this workstation (all read-only):**

```
sysctl -n hw.ncpu hw.memsize machdep.cpu.brand_string hw.physicalcpu hw.logicalcpu hw.optional.arm64
uname -m ; arch ; brew config
df -h / /System/Volumes/Data
docker version --format '{{.Server.Version}}'        → 29.5.2
docker compose version                               → v5.1.3
docker info --format 'CPUs={{.NCPU}} Mem={{.MemTotal}} …'
docker ps --format 'table {{.Names}}\t{{.Ports}}\t{{.Status}}'
docker network ls ; docker volume ls ; docker system df
lsof -nP -iTCP -sTCP:LISTEN
which nginx                                          → not found
ls -la /Users/innovera/Documents/OCR/docs/architecture/m0/
```

**Files read on this machine:**

- `/Users/innovera/Documents/TCL/server/docker-compose.yml` — the house compose conventions:
  `x-logging` anchor, `expose`-not-`ports`, `condition: service_healthy`, `$$`-escaped healthchecks,
  the backup sidecar, the "a local dump is not a backup" rule
- `/Users/innovera/Documents/TCL/server/Dockerfile` — multi-stage node, `USER node`, "COPY the
  contract files into the image" lesson
- `/Users/innovera/Documents/TCL/docs/deploy-vps.md` §0–§7 — VPS preflight, the caddy-gen
  one-network trap, the `postgres` name-collision trap, `.env` handling
- `/Users/innovera/Documents/jawbong/docker-compose.test.yml` — `postgres:18.4-bookworm`,
  `127.0.0.1:55432` binding style
- `/Users/innovera/Documents/jawbong/package.json`, `.nvmrc`, `next.config.ts`, `prisma.config.ts` —
  Next 16.2.12 / React 19.2.8 / TS 6.0.3 / pnpm 11.18.0 / Node 22.23.1 / Prisma 7.9.1 / Zod 4.4.3;
  and the fact that `output: 'standalone'` is **absent**
- Sibling M0 dimension reports in `/Users/innovera/Documents/OCR/docs/architecture/m0/`:
  `a-environment-and-stack.md` (§2.2, §8.1–8.5), `b-ai-topology-discovery.md` (§2.3, Q5/Q9, the
  ocr-web-owns-the-credential rule), `c-ai-capability-probe.md` (§1–2), `d-ocr-engine.md`
  (§0, §1, §4), `e-native-extraction-routing.md` (§0 decision table, §1, §2, DPI analysis,
  `MAX_UPLOAD_BYTES`), `f-preprocessing-and-confidence.md` (D1, the wheel-size table, the
  `opencv-python-headless` rule), `i-storage.md` (J3–J8, the 500 MB proposal), `j-security-threat-model.md`
  (the STRIDE rows for DoS, clickjacking, sniffing, prompt injection), `l-api-ui-export.md` (L-1,
  L-2, L-8, L-12, L-13, L-16, L-17)

**URLs fetched or searched this session:**

- <https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_request_buffering> — `proxy_request_buffering`, `proxy_buffering`, `proxy_read_timeout`, `proxy_send_timeout`, `proxy_http_version` (1.1 default since 1.29.7)
- <https://nginx.org/en/docs/http/ngx_http_headers_module.html#add_header> — the inheritance rule and the `always` parameter
- <https://nextjs.org/docs/app/guides/content-security-policy> — nonce CSP via `proxy.ts`, dynamic-rendering requirement, PPR incompatibility
- <https://nextjs.org/docs/app/api-reference/config/next-config-js/output> — `output: 'standalone'`, manual copy of `public` and `.next/static`, `PORT`/`HOSTNAME`
- <https://docs.litellm.ai/docs/proxy/virtual_keys> — `/key/generate` parameter names
- <https://docs.vllm.ai/en/stable/configuration/optimization/> and <https://discuss.vllm.ai/t/what-does-gpu-memory-utilisation-include/1651> — `gpu_memory_utilization` default 0.9, pre-allocation, per-instance semantics
- <https://github.com/opencv/opencv-python/issues/203> — "headless package requires libglib2.0-0"
- <https://github.com/explosion/spaCy/issues/1110> — `libgomp.so.1` missing on slim images
- <https://packages.debian.org/trixie/i386/libglib2.0-0t64> and <https://github.com/docker-library/python> — the bookworm→trixie package rename
- <https://github.com/QwenLM/Qwen2.5-VL/issues/633> — image-token formula `H×W/(28×28)`
- <https://nginx.org/news.html> / <https://github.com/nginx/nginx/releases> — 1.30.0 stable, 1.31.x mainline (2026)

### 7.1 Review pass — additional evidence (2026-09-09)

**Commands re-executed on this workstation (all read-only, all confirmed the draft's §0):**

```
uname -m ; arch ; sysctl -n machdep.cpu.brand_string hw.optional.arm64 \
                          hw.physicalcpu hw.logicalcpu hw.memsize
ls -d /opt/homebrew ; ls -d /usr/local/Homebrew
docker version --format '{{.Server.Version}}'   → 29.5.2
docker compose version                          → v5.1.3
docker info --format 'CPUs={{.NCPU}} Mem={{.MemTotal}}'  → CPUs=8 Mem=8324579328
docker info --format '{{json .DefaultAddressPools}}'     → null  (built-in default)
which nginx                                     → not found
docker network ls --format '{{.Name}}' ; docker network inspect <each> \
  --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}'    → 172.17-172.24, eight /16s in use
ls -la /Users/innovera/Documents/OCR/docs/architecture/m0/
grep -c '<sibling>.md' m-docker-nginx-resources.md       → g:0  h:0  k:0  n:0  (the gap fixed in this pass)
```

**Sibling M0 reports read in the review pass that the draft had NOT cited:**

- `g-data-model.md` — §266 (`ocr_app` role: *"NOT the table owner, NOT superuser, no BYPASSRLS"*),
  §593 (`locale` default `th-TH`), §1604 (the four roles `ocr_owner`/`ocr_app`/`ocr_queue`/
  `ocr_erasure`), §1660–1696 and K-10 (why `to_tsvector` is useless on Thai; app-side newmm
  tokenisation; **no search index until M4**), §1905–1915 (the real table list and row-count model
  used to rebuild §4.5), §1982 (the `pg_trgm`-on-Thai open question)
- `h-queue-and-worker-contract.md` — L1 (Postgres queue, one atomic `UPDATE … RETURNING`), L4
  (uuid `lease_token`, 120 s lease, 30 s heartbeat; timestamp leases explicitly rejected), L15
  (`state = 'DEAD'` DLQ), L18 (SSE polls one row at 1 Hz), L22 (**table name is `extraction_jobs`**,
  `priority DESC`, `max_attempts = 4`), L24/L25 (`FORCE ROW LEVEL SECURITY`, the worker's
  cross-organisation claim)
- `j-security-threat-model.md` — C13 / TB12 / §11.4 (**ClamAV `clamd` + `freshclam` in M1**, freshclam
  as the only egress in that tier), §157 (model output is data; no URL from it is ever fetched),
  §173 (decoder-RCE mitigations naming **seccomp** separately), §214 (the Redis session row that
  §2.1.2 now surfaces), §616–631 (the case for a worker with no egress; the explicit rejection of an
  egress-allowlist proxy; weights baked at build time)
- `n-observability-testing-benchmark.md` — N9 (`prom-client` / `prometheus-client`, pull model,
  `GET /metrics` on both services, worker's internal-only), N12, N14 (cardinality budget), Q5
  (**owner-blocked: is there a Prometheus at all?**) — the basis for NGINX fix N9 and for §5.5.1's
  two-path alerting
- `i-storage.md` — line **1377** (`MAX_UPLOAD_BYTES = 500 * 1024**2`, in code), §153/§1379/§1402
  (the `'too-large'` error code the 413 envelope now matches)
- `e-native-extraction-routing.md` — line **1173** (`MAX_UPLOAD_BYTES = 200 * 1024 * 1024`), E4
  (`pypdfium2` 5.13.0, Apache-2.0/BSD-3), `maxRenderPages: 400`
- `d-ocr-engine.md` — §87 (PP-OCRv5 Thai via **RapidOCR 3.9.2**), §88 (`scb10x/typhoon-ocr1.5-2b`,
  base **`Qwen3-VL-2B-Instruct`** — not Qwen2.5-VL, which is why §5.2's token formula is now flagged)
- `f-preprocessing-and-confidence.md` — D1 (`opencv-python-headless==4.14.0.94`, `pillow==12.3.0`),
  §934 (`numpy==2.5.3` requires Python ≥ 3.12)
- `a-environment-and-stack.md` — A-7 and §1803–1805 (the three observed deploy patterns; the
  quotation VPS's host nginx → `127.0.0.1:8091`), §1955 (A-7's own edge-proxy addendum deferring to
  this document's §3.1)

**URLs fetched in the review pass:**

- <https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_set_header> — **the inheritance
  rule, verbatim**: *"These directives are inherited from the previous configuration level if and
  only if there are no `proxy_set_header` directives defined on the current level"*; and the
  defaults that apply when they are not: `Host $proxy_host`, `Connection close`. This is fix C-1.
- <https://nginx.org/en/docs/http/ngx_http_proxy_module.html> — `proxy_http_version` **default 1.1
  since 1.29.7** (the draft's claim, **confirmed**); `proxy_buffering on`, `proxy_request_buffering
  on`, `proxy_read_timeout 60s`, `proxy_max_temp_file_size 1024m`, `proxy_buffer_size 4k|8k`
- <https://letsencrypt.org/2024/12/05/ending-ocsp> and the associated timeline — OCSP Must-Staple
  fails 2025-01-30; **OCSP URLs dropped from certificates 2025-05-07**; **responders off
  2025-08-06**. This is fix N7.
- <https://www.debian.org/News/2026/20260712> — **Debian 12 bookworm regular security support ended
  2026-07-12**, handed to the LTS team; LTS to 2028-06-30. This is fix C-6 / decision P6.
- <https://community.nginx.org/t/nginx-1-30-4-stable-and-nginx-1-31-3-mainline-versions-released/10134>
  and <https://nginx.org/2026.html> — current: **1.30.4 stable / 1.31.4 mainline**; **CVE-2026-42533**
  (buffer overflow using `map` with regex) and **CVE-2026-60005** (memory disclosure in
  `ngx_http_slice_module`). This is decision R4.
- Docker Hub registry tag API for `library/postgres` (`?name=18.`) — `18.4-bookworm` **exists**
  (pushed 2026-08-05) but **18.6** is current, with `18.6-trixie`/`18.6-bookworm`/`18.6-alpine*`
- Docker Hub registry tag API for `library/node` (`?name=22.23`) — `22.23.1-bookworm-slim` **exists**;
  `22.23.1-trixie-slim` and `22.23.2-*` also exist
- <https://raw.githubusercontent.com/docker-library/postgres/master/18/bookworm/Dockerfile> —
  **`STOPSIGNAL SIGINT`** (fast shutdown), `groupadd -r postgres --gid=999` / `useradd --uid=999`,
  `ENTRYPOINT ["docker-entrypoint.sh"]` + `CMD ["postgres"]`, **no `USER` directive** (runs as root
  and `gosu`es down — the basis for the `ocr-backup` non-root fix)
- <https://packages.debian.org/bookworm/fonts-noto-core> — ships **Noto Sans Thai, Noto Serif Thai,
  Noto Looped Thai Regular/Bold**; the draft's "Noto Core covers the fallback" was an assumption and
  is **confirmed**
- <https://github.com/opencv/opencv-python/issues/203> — re-read; **confirms** the `libglib2.0-0`
  requirement for the headless wheel on slim images
- <https://docs.docker.com/reference/compose-file/merge/> — `ports` merge is a **unique-resource**
  list keyed on `{ip, target, published, protocol}`; **`!reset`** clears an attribute, **`!override`**
  replaces it. This is the §2.2.2 fix.
- <https://docs.docker.com/reference/compose-file/deploy/> — read; it **does not** state
  non-Swarm support levels for `replicas`/`resources`, so §2.2.1's UNVERIFIED note stands rather
  than being upgraded to a claim
- Docker `/dev/shm` + PostgreSQL `could not resize shared memory segment` — the 64 MB default and
  `shm_size` as the fix. This is C-3.
- <https://nextjs.org/blog/next-16> / <https://nextjs.org/docs/messages/middleware-to-proxy> —
  **`middleware.ts` → `proxy.ts` in Next 16**, export renamed to `proxy`, runtime is Node and not
  configurable, codemod `npx @next/codemod@canary middleware-to-proxy`. The draft's claim,
  **confirmed**.

**What the review pass did NOT do:** contact any production host; port-scan anything; start, stop,
build, or pull any container or image; install any package; write any file outside
`/Users/innovera/Documents/OCR`; read any `.env` or `.env.example`; run any `nginx` command
anywhere; write to any database; connect to any AI gateway.

---

## Critic Notes

**Review pass, 2026-09-09.** Adversarial completeness and fact-check against the original brief for
M0 items O, P and R. The draft was strong — the `add_header` inheritance trap, the `client_max_body_size`
location-precedence trap, the tmpfs-counts-against-`mem_limit` finding, the Thai-font-in-PDFium
finding, and the vLLM VRAM pre-allocation warning are all genuinely good and all survive unchanged.
What follows is what was wrong.

### What was factually wrong

| # | Claim | Reality |
|---|---|---|
| F-1 | `ssl_stapling on; ssl_stapling_verify on;` + `resolver 127.0.0.53` | Dead config. Let's Encrypt dropped OCSP URLs from certificates **2025-05-07** and shut its responders down **2025-08-06**. Produces a startup warning and a pointless DNS dependency in the TLS path. **Removed.** |
| F-2 | *"`-bookworm`, not `-trixie` … removes a whole class of incidents"* | Debian 12's regular security support **ended 2026-07-12**, two months before this document's date. The draft's own stated reversal trigger had already fired. **Flipped to trixie**, with the `libglib2.0-0t64` rename. |
| F-3 | `proxy_cache_valid 200 365d;` in `/_next/static/` | Inert without `proxy_cache` + `proxy_cache_path`. Nothing was being cached; a reader would reasonably believe otherwise. **Removed**, with the reason. |
| F-4 | `add_header Cache-Control …` alongside Next's own | Produces a **duplicate** `Cache-Control` header. **Removed.** |
| F-5 | `add_header Content-Type application/json always;` in `@too_large` | `default_type` already sets it → duplicate `Content-Type`; and the `add_header` **dropped every inherited security header** from the 413 response. **Both fixed.** |
| F-6 | *"restating the port so an override can never widen it"* | False. Compose merges `ports` as a unique-resource list; a later file with a different `host_ip` is **appended**, not rejected. **Changed to `ports: !override`.** |
| F-7 | `build: null` | Not the documented way to remove an inherited attribute. **Changed to `build: !reset null`.** |
| F-8 | `ocr_jobs` / `status` / `run_after` / bare `SELECT … FOR UPDATE SKIP LOCKED` | The authoritative table is **`extraction_jobs`** (`g`), the column is **`state`**, the claim is **one atomic `UPDATE … RETURNING`** with a **uuid `lease_token`** (`h` L1/L4). Four SQL statements across §2.1.1, §5.7.3 and §5.7.4 were rewritten. |
| F-9 | §4.5's Postgres table list | Six invented names, six real tables omitted, `document_lines` does not exist in `g` at all. **Rebuilt on `g` §1905–1915.** The headline (200 → 185 MB) barely moved; the schema was entirely wrong. |
| F-10 | *"non-root `USER` — applied to: all"* | `ocr-backup` overrode the entrypoint and therefore ran as **uid 0** while holding an SSH private key. **Fixed with `user: "999:999"`.** |
| F-11 | Citations `i-storage.md` line 1303 / `e-…` line 743 | The constants are at **1377** and **1173**. Corrected — and i's is *in code*, which makes the 200-vs-500 MB conflict sharper than the draft implied. |
| F-12 | "Branch T — text-only **Qwen**" / "Branch V — vision-capable **Qwen**" | The model behind the INNOVERA gateway is **not known**. Renamed to text-in / image-in, with an explicit fabrication-check table. Also: `d`'s own VLM candidate is built on **Qwen3-VL**, not the Qwen2.5-VL the token formula comes from. |
| F-13 | `--mount=type=secret,id=none` in the models stage | A no-op mount implying a secret dependency that does not exist. **Removed.** |
| F-14 | *"exactly one unavoidable shared-state risk"* (duplicate names) | **Four.** Duplicate names; http-context directives with global defaults (the draft's own `gzip` block); `default_server` election order; shared-memory allocation. |

### What was missing (gaps against the brief)

| # | Gap |
|---|---|
| G-1 | **No `.dockerignore`** — with `COPY . .` in the build stage, `.env`, `secrets/` and `.git` would be baked into the published image. Highest-severity build defect found. §2.3.1. |
| G-2 | **`env_file: [.env]`** on `ocr-web` and `ocr-backup` contradicted the document's own credential invariant three times over. §2.5.4. |
| G-3 | **No `shm_size` on `ocr-db`** — PostgreSQL parallel query fails on Docker's 64 MB `/dev/shm`. §2.2. |
| G-4 | **`fontconfig` never installed** — the worker Dockerfile calls `fc-cache` (build break) and PDFium needs fontconfig at runtime (silent undoing of §2.4.3). §2.4.1. |
| G-5 | **`proxy_set_header` inheritance** — the twin of the trap the draft documented; the SSE location lost `Host` and every `X-Forwarded-*`. A third NGINX file was added. §3.3. |
| G-6 | **No `proxy_buffer_size` increase** — a long Thai filename in an RFC 8187 `Content-Disposition*` header overflows the 4k/8k default and returns **502 with a 200 in the app log**. §3.3.1. |
| G-7 | **`/metrics` was publicly proxied** — `n` N9 puts a Prometheus endpoint on `ocr-web`. §3.3 block 3b. |
| G-8 | **`gzip` in http context** would have changed behaviour for the incumbent quotation-system, contradicting §3.7. §3.2. |
| G-9 | **The setgid bit** — the two-service shared volume cannot work with plain `0770` + a supplementary group. §2.6.1. |
| G-10 | **`ocr_scratch` is shared across replicas**, and the draft's proposed startup sweep deletes other workers' in-flight renders. §2.7.4. |
| G-11 | **The ClamAV tier (`j` C13) is entirely absent** from the compose file, and its memory footprint may change the VPS sizing answer. §2.1.0. |
| G-12 | **Docker's IPv4 pool is half spent on this box** (8 of 16 `/16`s) and the draft pinned no subnets. §0.4, §2.2, §5.4. |
| G-13 | **"Alert at 80 %, refuse at 90 %"** named no mechanism. Replaced with thresholds, a gauge, a **507** response, and a two-path alerting story that works whether or not `n` Q5's Prometheus exists. §5.5.1. |
| G-14 | **`deploy.sh` could not run a first deploy** (three separate `set -e` aborts) and its rollback target could be empty. §5.7.3. |
| G-15 | **CSP was missing `worker-src`** — a `blob:` PDF worker is how every pdf.js-based viewer starts, so the review UI would not render. Plus `style-src-attr`, `frame-src`, `manifest-src`, `media-src`, `report-uri`. §3.5. |
| G-16 | **`/.well-known/` was caught by the dotfile deny** on `:443`. §3.3 block 7. |
| G-17 | **No `error_page` JSON for 429/502/504** — clients that parse JSON got nginx HTML during exactly the incidents where clarity matters. §3.4.4. |
| G-18 | **The migrate stage could not work with pnpm** (symlink farm + a glob that may match nothing) and `read_only` broke `npx`'s cache. §2.3.2. |
| G-19 | **`docker/backup.sh` is referenced by the compose file and was never written.** Now an explicit M1 deliverable with a specified content list (item 28). |
| G-20 | **No seccomp statement**, which `j` §173 names separately from capabilities. §2.7.1. |

### Thai-specific blind spots found

| # | Blind spot |
|---|---|
| T-1 | **`--locale=C` is a one-way door** set at `initdb`, and under it Thai `ORDER BY` is codepoint order — which misfiles every word beginning with a leading vowel (เ แ โ ใ ไ). Decision kept, but with the trade stated and per-column `COLLATE th_icu` as the mitigation. §2.2.3. |
| T-2 | **`fontconfig` missing** silently undoes the entire Thai-font finding. §2.4.1/§2.4.3. |
| T-3 | **Thai digits U+0E50–U+0E59** are a separate block; a Thai-tagged font is not proof of coverage, and a missing glyph loses the *number* on an invoice. §2.4.3. |
| T-4 | **Long Thai filenames overflow `proxy_buffer_size`** → 502 that no English test reproduces. §3.3.1. |
| T-5 | **`Content-Disposition` must be RFC 8187** with an ASCII fallback, NFC-normalised, and stripped of `\r\n";` before interpolation. §3.3.1. |
| T-6 | **glibc `th_TH` renders the Buddhist era**, so any script naming files with `date` under a Thai locale produces `2569`, breaking retention regexes. `LC_ALL=C` in every script. §2.2.4. |
| T-7 | **`to_tsvector` on Thai is useless** (`g` §9) — so §4.5's "GIN ≈ 45 %" was wrong in M1 (there is no index) and wrong in M4 (a trigram index on space-less Thai is far larger than 45 %). §4.5.1. |
| T-8 | **`next-intl` catalogues may not survive Next's file tracing** — the Thai UI silently renders message *keys*, and an English-passing test suite never notices. §2.3.2. |
| T-9 | **Thai line-breaking needs `libthai`**, relevant if `l` L-17's PDF report is ever built with Pango. §2.4.3. |
| T-10 | **User filenames must never be storage keys** — mixed Thai/Latin titles from macOS clients round-trip differently. `i` J3 already prevents this; the reason is now written down. §2.6.1. |

### What remains genuinely unknowable in this session

These are **not** deferred work items; they are questions this session had no way to answer, and no
amount of further analysis in M0 will change that.

1. **Everything about the INNOVERA AI gateway.** Base URL, host, port, auth scheme, model id,
   whether it is LiteLLM at all, whether the model is Qwen, whether it is vision-capable, whether it
   is shared with INNOVERA Chat. The orchestrator's exhaustive grep of this workstation found no
   configuration, and no file this session may read records it. **§5.2's entire impact assessment,
   §5.3's key parameters, and the Branch T/V split all inherit this.** Anyone who finds a model name
   or endpoint asserted anywhere in this document should treat it as a bug.
2. **Everything about the GPU host.** Whether it runs vLLM, at what `--gpu-memory-utilization`, with
   how much VRAM, and whether Chat and any OCR-capable model would share a device. §4.9.2's warning
   is therefore *conditional*, and correctly so — but the condition is unverified.
3. **The deployment target host.** Fresh box, existing `caddy-gen-proxy`, or the quotation VPS with
   host NGINX. §3 designs the third case because the brief specified it; if it is the first, §3's
   file is deleted and A-7's in-stack Caddy applies.
4. **Every performance number in Item P.** Nothing was benchmarked. §4.3's 4.5 CPU-s/page is
   arithmetic on other people's published figures on other people's hardware, inheriting
   `d-ocr-engine.md §4`'s own uncertainty and compounding it. The review pass corrected the *worker
   sizing* arithmetic (§4.4.1) but could not improve the *input*, and a 2× error in per-page RSS
   moves every capacity number in this document.
5. **Whether `deploy.resources.limits` and `deploy.replicas` are honoured by Compose v5.1.3 here.**
   The Compose Specification page does not state non-Swarm support levels, and running `docker
   compose up` to find out is outside this session's read-only mandate. §2.2.1's verification
   command is one line and takes thirty seconds — it just has to be run by someone permitted to
   start a container.
6. **PDFium's actual font-fallback behaviour with `fonts-thai-tlwg` installed** (test T-FONT-1), and
   **`pg_trgm`'s behaviour on Thai multibyte input** (`SELECT show_trgm('ภาษี');`). Both need a
   container and a database this session may not create. Both are five-minute checks that settle
   material questions, which is why they are items 17 and 23 rather than paragraphs of speculation.
7. **ClamAV's resident memory.** It may be the difference between an 8 GB and a 16 GB production
   box, and it is `j` §11's number to produce.

### What the review pass deliberately did *not* change

- **O2 (no Redis).** The reasoning is sound and `h` L1 independently reaches the same conclusion.
  §2.1.2 surfaces `j`'s session-store row as a cross-document question rather than overturning a
  decision on an inference.
- **O7 (bake model weights).** Correct, and `j` §631 independently requires it.
- **O10 / §2.5.3 (worker gets no egress).** Correct, well argued, and `j` §5.6 agrees.
- **P5 / §4.9 (no GPU for OCR).** Correct, and §4.9.2's VRAM-contention warning is the most
  operationally valuable paragraph in the document.
- **N2 (per-location body limits) and §3.4's trap analysis.** Correct and unusually well explained.
- **The 200 MB upload recommendation** in §3.4.3. Only the citations were corrected.
- **§2.7.3's tmpfs-vs-disk reasoning for scratch.** Correct; §2.7.4 adds the multi-replica dimension
  it was missing, but the core finding stands.
