---
dimension: gate-1-litellm-supply-chain
title: "Gate 1 — LiteLLM Supply-Chain History and Credential-Issuance Precondition"
status: canonical
date: 2026-09-09
supersedes:
  - docs/architecture/m0/b-ai-topology-discovery.md  # Q8b, S-4, B-15 (LiteLLM 1.82.7/1.82.8 precondition) — superseded in full for this dimension
  - docs/architecture/m0/j-security-threat-model.md  # §10 "Deep dive G — Supply chain", LiteLLM/PyPI portion only; the rest of §10 (model-weight baking, hashed lockfiles) is NOT owned here
  - docs/architecture/m0/z-adversarial-panel.md      # the "Q8b/S-4 credential boundary" objection, resolved here
owner: Gate 1
scope_note: "This document owns the LiteLLM supply-chain verdict and the credential-issuance precondition ONLY. It does not own the gateway wire contract, the model list, the OCR key format, or the general Python lockfile policy."
---

# Gate 1 — LiteLLM Supply-Chain History and Credential-Issuance Precondition

> **Integration status (2026-09-12):** Read the [architecture index](../README.md) and its consolidation report before using these examples. Individual review labels do not close cross-document conflicts; no application implementation is verified.

## 0. The one thing this gate decides

**We are about to ask a third party to issue us an AI credential on a host we do not own and cannot reach.**
On 2026-03-24 two LiteLLM releases were maliciously backdoored specifically to harvest every
credential present on the host running them. If that host ran either version and was not rotated,
then any key issued to INNOVERA OCR AI is born compromised, and no amount of downstream
architecture repairs that.

Gate 1 therefore answers exactly one question — *may a credential be accepted from that host?* —
and it answers it **separately for two scopes that must never be conflated**:

| Scope | What it is | Reachable this session? | Verdict authority |
|---|---|---|---|
| **Scope L — WORKSTATION** | The dev box, `/Users/innovera`, Intel i5-1038NG7, macOS, Docker Desktop | **Yes**, fully | **This document. Definitive.** |
| **Scope G — GATEWAY** | The remote production GPU host running LiteLLM | **No.** Not on this machine, not in any of the 15 repos, network access forbidden by the M0.5 constraints | **Owner only**, via `gate-1-owner-runbook.md` |

A clean Scope L result is **not** evidence about Scope G. The two scopes share no filesystem, no
package index cache, no Docker daemon and no Python interpreter. Every verdict below is tagged.

---

## 1. The incident — precise, citable IOC set

### 1.1 Attack chain (verified)

| Date (UTC) | Event | Source |
|---|---|---|
| 2026-03-19 | Attackers rewrote Git tags on the **Trivy GitHub Action** repo to point at a malicious release **v0.69.4**. LiteLLM's CI/CD invoked Trivy **without a pinned SHA**, so the poisoned action ran inside LiteLLM's own runner and exfiltrated the `PYPI_PUBLISH` token from the runner environment. | Snyk |
| 2026-03-23 | Attacker registered the exfiltration domain `litellm.cloud` through Spaceship, Inc. — one day of pre-staging. | GitHub issue #24518 |
| **2026-03-24 10:39** | **litellm 1.82.7 and 1.82.8 go live on PyPI**, published directly with the stolen token, **bypassing the GitHub CI/CD pipeline entirely** (so no GitHub release, no CI log, no provenance record exists for them). | Orchestrator-verified; docs.litellm.ai |
| 2026-03-24 ~11:19 | PyPI quarantines both releases. **Stated live window ≈ 40 minutes.** | Orchestrator-verified (frozen value) |
| 2026-03-30 | **v1.83.0** released — first post-incident release, built on a rebuilt "CI/CD v2" pipeline. | docs.litellm.ai |

**UNVERIFIED / source conflict (C-1):** `docs.litellm.ai/blog/security-update-march-2026` as retrieved
this session renders a quarantine time of *~16:00 UTC* while also asserting *"approximately 40 minutes
of exposure"*; 10:39 → 16:00 is 5 h 21 m, not 40 minutes. The M0.5 brief freezes the value at **~40
minutes from 10:39 UTC**, and this document uses the frozen value. **This conflict is not academic** —
see §1.4, where it is shown that the PyPI live window is the *wrong* number to plan against anyway.

### 1.2 Payload delivery — the two versions are materially different

| | **1.82.7** | **1.82.8** |
|---|---|---|
| Vector | Base64-encoded payload inside `litellm/proxy/proxy_server.py` | **`litellm_init.pth`** dropped into `site-packages` |
| Trigger | On `import` of the proxy module | **Interpreter start. Every `python` invocation on the machine. No import of litellm required.** |
| Blast radius | Anything that ran the LiteLLM proxy | **Anything that ran Python at all on that machine**, including `pip`, backup scripts, cron jobs, and unrelated services |
| Detectable by "we don't use the proxy" | Partially | **No. That defence is void.** |

This asymmetry drives decision **D1-2**: a host that installed 1.82.8 is compromised even if LiteLLM
was never started.

### 1.3 Indicator set (use verbatim)

**Malicious artefact**

| Indicator | Value |
|---|---|
| Filename | `litellm_init.pth` |
| Size | **34,628 bytes** |
| SHA-256 (hex) | `71e35aef03099cd1f2d6446734273025a163597de93912df321ef118bf135238` |
| SHA-256 (base64url, as published by safedep / issue #24518) | `ceNa7wMJnNHy1kRnNCcwJaFjWX3pORLfMh7xGL8TUjg` |
| 1.82.8 wheel SHA-256 | `d2a0d5f564628773b6af7b9c11f6b86531a875bd2d186d7081ab62748a800ebb` |
| 1.82.7 payload location | `litellm/proxy/proxy_server.py` |

> **Resolved discrepancy (verified in-session, not assumed):** two published hashes for
> `litellm_init.pth` look different but are the **same digest in two encodings**. Verified by
> base64url-decoding `ceNa7wMJnNHy1kRnNCcwJaFjWX3pORLfMh7xGL8TUjg` → `71e35aef…35238`, exact match.
> An operator comparing against only one encoding and finding "no match" would draw a false
> conclusion. The runbook (§4 of `gate-1-owner-runbook.md`) therefore instructs hex comparison.

**Network indicators**

| Indicator | Value | Role |
|---|---|---|
| Exfiltration endpoint | `https://models.litellm.cloud/` (note: **not** `litellm.ai`) | Receives `tpcp.tar.gz` via HTTP POST |
| C2 polling URL | `https://checkmarx.zone/raw` | Returns a URL of a binary to download and execute |
| Poll interval | **UNVERIFIED / source conflict (C-2):** Snyk states **every 5 minutes**; safedep states **~50 minutes**. Detection must not depend on the interval — alert on the *destination*, not the cadence. | |

**Host persistence indicators (Linux)**

| Indicator | Value |
|---|---|
| Backdoor script | `~/.config/sysmon/sysmon.py` and `/root/.config/sysmon/sysmon.py` |
| systemd unit | `~/.config/systemd/user/sysmon.service`, description **"System Telemetry Service"**, enabled via `systemctl --user enable --now` |
| Staging files | `/tmp/tpcp.tar.gz`, `/tmp/session.key`, `/tmp/session.key.enc`, `/tmp/payload.enc` |

**Kubernetes indicators**

| Indicator | Value |
|---|---|
| Pod name pattern | `node-setup-{node_name}` in namespace `kube-system` |
| Container | name `setup`, image `alpine:latest` |
| Pod spec | `hostPID: true`, `hostNetwork: true`, privileged, host-root volume mount, scheduled onto **every** node |

**Crypto / attribution**

| Indicator | Value |
|---|---|
| Session key | 32-byte random, **AES-256-CBC** with PBKDF2 derivation |
| Key wrapping | Hardcoded **4096-bit RSA public key**, OAEP padding |
| RSA public key prefix (identical across the Trivy, KICS and LiteLLM payloads — strongest single attribution string) | `MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAvahaZDo8mucujrT15ry+` |
| Actor | self-styled **TeamPCP** |

**What was harvested** (this is the list that decides the credential question): SSH private keys,
`.env` files, git credentials, **API keys scraped out of shell history**, AWS credentials via IMDSv2,
GCP and Azure credentials, kubeconfig files and all cluster secrets across all namespaces, Docker
registry credentials, cryptocurrency wallet seed phrases, and the full process environment.

> The inclusion of **shell history** and **`.env` files** is the operative fact for INNOVERA. A LiteLLM
> *virtual key* for another service, an `OPENAI_API_KEY`, a Postgres URL, or an SSH key that was ever
> echoed on that host is in scope — not merely the LiteLLM master key.

### 1.4 The exposure window that actually matters is **not** 40 minutes

Planning against "the packages were only live for 40 minutes" is the single most likely way to get
this gate wrong. The real risk window is wider for four mechanically distinct reasons:

1. **PyPI quarantine removes the file from the index; it does not remove it from caches.** A host's
   local `pip`/`uv` HTTP cache, or a wheelhouse directory, can serve 1.82.7/1.82.8 for as long as the
   cache persists.
2. **Private mirrors and pull-through proxies** (Artifactory, Nexus, devpi, an internal PyPI mirror)
   replicate on their own schedule and do not honour a PyPI quarantine retroactively. A mirror that
   synced at 10:45 UTC keeps serving the malicious wheel until someone purges it.
3. **Docker layer caching.** A `pip install litellm` layer built during the window is frozen into an
   image and re-used by every subsequent build that hits the cache, potentially for months. **This is
   the most likely realistic path onto a GPU host**, because the LiteLLM gateway is almost certainly a
   container.
4. **`>=` / unpinned constraints.** Any `litellm` requirement without an exact `==` pin resolved to
   the newest release at build time — which, during the window, was 1.82.8.

**Numeric consequence:** the runbook treats **any gateway image whose `Created` timestamp falls in
`2026-03-24T10:39:00Z` … `2026-03-31T00:00:00Z`** (the incident start through the day after the clean
v1.83.0 release, ≈ 6.6 days) as **HIGH RISK requiring layer-level proof**, not as clean-by-default.
Images created before `2026-03-24T10:39:00Z` are clean *for this incident* only if their pinned
version is ≤ 1.82.6 — a pre-incident image can still be *rebuilt* later against a poisoned cache.

---

## 2. Scope L — WORKSTATION sweep (definitive result)

All findings below were produced this session on the dev box. Nothing was executed from any
discovered package; every check is `find` / `ls` / `shasum` / `grep` / `docker inspect` metadata only.

### 2.1 What was checked and what was found

| # | Check | Method | Result |
|---|---|---|---|
| L-1 | LiteLLM Docker image present? | `docker images` (110 unique image IDs) | **NONE.** No repository or tag matches `litellm`. |
| L-2 | LiteLLM in any Docker **layer history**? | `docker image history --no-trunc` iterated over **all 110 image IDs**, grepped for `litellm` in `CreatedBy` | **ZERO HITS.** No image on this box ever ran a `pip install litellm` build step. |
| L-3 | `litellm` importable? | `python3 -c "importlib.util.find_spec('litellm')"` on system Python 3.9.6 | **NOT IMPORTABLE.** |
| L-4 | Any `litellm*` file or directory anywhere on `/`? | `find / \( -type d -o -type f \) -iname "litellm*"` | **ZERO RESULTS.** |
| L-5 | **`litellm_init.pth` anywhere** (the 1.82.8 vector) | `find / -name "litellm_init.pth"` | **ZERO RESULTS.** |
| L-6 | **All `.pth` files enumerated and individually cleared** | `find / -name "*.pth"`, then per-file byte count, SHA-256 and content dump | **12 unique files, all benign.** See §2.2. |
| L-7 | All `site-packages` directories | `find / -type d -name "site-packages"` | **15 directories**, none containing litellm (proved by L-4). |
| L-8 | pip / uv caches | `~/Library/Caches/pip` (exists), `~/.cache/uv`; searched for `*litellm*` | **NO litellm wheel or cache entry.** `~/.cache/pip` does not exist. |
| L-9 | Dependency manifests pinning litellm | `grep -ril litellm` across `requirements*.txt`, `poetry.lock`, `Pipfile.lock`, `pyproject.toml`, `uv.lock`, `Dockerfile*`, `docker-compose*.yml`, `*.yaml` under `~` | **NO MATCHES.** |
| L-10 | `sysmon` persistence IOC | `ls ~/.config/sysmon`, `ls ~/.config/systemd`, `find / -name "sysmon*"` | **`~/.config/sysmon` does not exist. `~/.config/systemd` does not exist.** The only `sysmon*` hits are Apple's own `/usr/libexec/sysmond` and its man pages in the CommandLineTools SDKs — a **different, unrelated Apple binary**; do not mistake it for the IOC. |
| L-11 | `/tmp` staging artefacts | Existence test for `tpcp.tar.gz`, `session.key`, `session.key.enc`, `payload.enc` | **ALL FOUR ABSENT.** |
| L-12 | C2 strings on disk | `grep -rlE "models\.litellm\.cloud\|checkmarx\.zone"` over `/Users/innovera/Documents` and `/etc`; also `/etc/hosts` | **NO MATCHES.** |
| L-13 | macOS persistence | `~/Library/LaunchAgents`, `/Library/LaunchAgents`, `/Library/LaunchDaemons`, `launchctl list` filtered to non-Apple labels | **NO UNEXPLAINED ENTRY.** See §2.3. |

### 2.2 The `.pth` clearance — the check that actually matters for 1.82.8

28 `.pth` paths were returned by `find /`. They decompose as:

- **4** are PyTorch model weights, **not** Python path-configuration files:
  `~/.EasyOCR/model/craft_mlt_25k.pth` and `~/.EasyOCR/model/thai.pth` (each also visible through
  the `/System/Volumes/Data` firmlink, hence 4 paths for 2 files). These live outside any
  `site-packages` directory, so the Python `site` module **never processes them**. They are prior
  Thai-OCR evidence, not a supply-chain indicator.
- The remainder are the same 12 real files, each seen twice (once directly, once via
  `/System/Volumes/Data` — macOS firmlinks, not duplicates on disk).

Every one of the 12 was hashed and read:

| SHA-256 | Bytes | Content | Verdict |
|---|---|---|---|
| `2638ce9e2500e572a5e0de7faed6661eb569d1b696fcba07b0dd223da5f5d224` | 151 | setuptools `distutils-precedence.pth` (`SETUPTOOLS_USE_DISTUTILS`, default `local`) | benign — 3 copies |
| `7ea7ffef3fe2a117ee12c68ed6553617f0d7fd2f0590257c25c484959a3b7373` | 152 | same shim, default `stdlib` (Apple CommandLineTools variant) | benign — 1 copy |
| `8012937d0739b85441718553fffa1191e547126f5d7a3bc3b064b0d3c5d16da9` | 97 | `__editable__.hermes_agent-0.17.0.pth` — editable-install finder | benign — 2 copies |
| `1678cd642e1cc5df0a223fb30b0260b7f436dec32ccb0cc734cfeebca66bead7` | 97 | `__editable__.hermes_agent-0.15.1.pth` | benign — 1 copy |
| `ae5b487501ff1be587362e5dcc6aa71602c82fba81b0af66cf86cdc5a8dc93d8` | 97 | `__editable__.hermes_agent-0.16.0.pth` | benign — 2 copies |
| `69ac3d8f27e679c81b94ab30b3b56e9cd138219b1ba94a1fa3606d5a76a1433d` | 18 | `_virtualenv.pth` → `import _virtualenv` | benign — 3 copies |

**Largest benign `.pth` on this machine: 152 bytes. Malicious `litellm_init.pth`: 34,628 bytes — a
228× difference.** This is a usable mechanical rule and it is promoted to a canonical value:

> **`PTH_ANOMALY_SIZE_BYTES = 1024`.** Any `.pth` file inside a `site-packages` directory larger than
> 1,024 bytes is anomalous and must be read before the environment is trusted. Legitimate `.pth`
> files are one or two lines; nothing benign observed across 15 `site-packages` directories on this
> host approached 1 KiB. This rule generalises past `litellm_init.pth` to the whole `.pth`-injection
> class, which is why it is preferred over matching the one known filename.

### 2.3 macOS persistence — and why the Linux IOC does not transfer

**macOS uses `launchd`, not `systemd`.** The `sysmon.service` / `systemctl --user` persistence IOC has
**no applicable form on this workstation** — its absence here is a tautology, not evidence of
hygiene. The equivalent check is `launchd`, which was performed:

- `~/Library/LaunchAgents`: `ai.hermes.gateway.plist`, `com.google.GoogleUpdater.wake.plist`,
  `com.google.keystone.agent.plist`, `com.google.keystone.xpcservice.plist`.
- `/Library/LaunchAgents`: Google Keystone ×2, `org.chromium.chromoting.plist`.
- `/Library/LaunchDaemons`: `com.docker.socket`, `com.docker.vmnetd`, Google Updater/Keystone ×2,
  `org.chromium.chromoting.broker`.
- `launchctl list` non-Apple labels: Claude for Desktop, Docker helper, TablePlus (+ Sparkle updater),
  Chrome, VS Code, LINE, Telegram, `com.openssh.ssh-agent`, `org.chromium.chromoting`,
  `ai.hermes.gateway`.

The only non-vendor agent, `ai.hermes.gateway`, was read in full: it executes
`/Users/innovera/.hermes/hermes-agent/venv/bin/python -m hermes_cli.main gateway run --replace` with
`HERMES_HOME=/Users/innovera/.hermes`. Its interpreter's `site-packages` contains exactly two `.pth`
files, both cleared in §2.2, and contains no `litellm`. **Not an IOC.** It is called out explicitly
because a "hermes **gateway**" agent running Python out of a hidden dotfile venv is precisely the
shape a reviewer should challenge, and it is cleared on evidence rather than on its name.

> **Note for the reader:** `org.chromium.chromoting` is Chrome Remote Desktop — a legitimate but
> *remote-access* service. It is unrelated to this incident and is **out of Gate 1's scope**, but it
> is recorded here because it is the one entry that materially widens the workstation's attack
> surface, and a security reader deserves to see it named rather than silently filtered.

### 2.4 The one check that could NOT be run

| Check | Status | Why |
|---|---|---|
| Shell-history search for a historical `pip install litellm` | **NOT RUN — BLOCKED** | `~/.zsh_history` exists (**64,293 bytes**), but reads of it are refused by this session's permission classifier. The orchestrator hit the same block earlier; this session re-confirmed it. `~/.bash_history` does not exist. |

**This is recorded as an un-run check, not as a clean result.** It is the only Scope L gap. Its
practical weight is low — L-4 and L-5 prove nothing named `litellm` exists on disk *now*, and L-2
proves no image layer ever installed it — but a historical install that was later removed would
leave a history entry and no filesystem trace. The owner may authorise:
`grep -n "litellm" ~/.zsh_history`. **Expected clean result: zero lines.** Any line containing
`pip install litellm` or `uv add litellm` promotes Scope L from CLEAN to REQUIRES-REVIEW pending
`pip download` cache and date correlation.

### 2.5 Scope L verdict

> **Scope L (WORKSTATION) — CLEAN.** LiteLLM has never been installed, imported, cached, pinned,
> containerised or built on this machine. No `litellm_init.pth`. No `sysmon` persistence. No `/tmp`
> staging artefacts. No C2 strings. All 12 `.pth` files individually hashed and read; none exceeds
> 152 bytes. 110 Docker images had their full layer history searched with zero hits. One check
> (shell history) is blocked and recorded as un-run.
>
> **This says nothing whatsoever about Scope G.**

---

## 3. Repo-side sweep — can the estate date the gateway's LiteLLM version?

**Answer: no. Definitively no, and the absence is itself informative.**

### 3.1 Method correction (methodology matters here)

`gh search code "litellm" --owner WeiWutichai` returned zero results — **but so did a control search
for `LITELLM_BASE_URL`, a string the orchestrator verified this session is present in
`innovera-chat/DEPLOYMENT.md`.** GitHub's code-search index is therefore **not reliable for this
estate** with the available token scopes (`gist`, `read:org`, `repo`, `workflow`).

> **A "no results" from `gh search code` here is a false negative and must never be reported as a
> clean result.** All findings below were instead produced by enumerating each repository's full git
> tree via `GET /repos/{r}/git/trees/{default_branch}?recursive=1` and by fetching candidate file
> contents directly.

### 3.2 What the 15 public repos contain

All 15 confirmed **PUBLIC** via `gh repo list`. Trees enumerated (default branch in parentheses):

| Repo | Branch | Files | Python manifest? | LiteLLM pin? |
|---|---|---|---|---|
| WeiWutichai/pguard | main | 2,119 | **1** — `tooling/codegen/requirements.txt` | no |
| WeiWutichai/innovera-chat | main | 215 | none | no |
| WeiWutichai/innovera-plan | main | 212 | none | no |
| WeiWutichai/Maxtech-Backend | main | **0** (empty) | — | — |
| WeiWutichai/Maxtech-Frontend | main | **0** (empty) | — | — |
| WeiWutichai/Innovera | main | 398 | none | no |
| WeiWutichai/guard-dispatch | main | 583 | none | no |
| WeiWutichai/focus-media-api-hub | main | 148 | none | no |
| innovera2025/tcl | main | 348 | none | no |
| innovera2025/juneflow | dev | 2,514 | none | no |
| innovera2025/krs-pos | main | 642 | none | no |
| innovera2025/orderstock | main | 956 | none | no |
| innovera2025/temple | main | 521 | none | no |
| innovera2025/docketlaw | main | 542 | none | no |
| innovera2025/SRMS | main | 148 | none | no |

**Zero files named `*litellm*` across ~9,346 tracked files in 15 repositories.**

**The estate's only Python dependency manifest**, `WeiWutichai/pguard/tooling/codegen/requirements.txt`,
was fetched in full. It is two lines:

```
# Pinned deps for the Rust event-types generator (gen_rust_events.py). python3 + this only.
PyYAML==6.0.2
```

Exactly pinned, single dependency, no transitive path to `litellm`. **The entire INNOVERA public
estate has one Python dependency and it is PyYAML.**

### 3.3 innovera-chat specifically — a pure client, and it proves nothing about the gateway

Full 215-file tree inspected. `innovera-chat` is **100 % TypeScript / Next.js**: no `requirements.txt`,
no `pyproject.toml`, no `uv.lock`, no Python file of any kind, and — notably — **no `.github/`
directory at all**, so there is no CI workflow to date either. Deployment is manual, via
`scripts/deploy.sh`.

LiteLLM appears in Chat only as **configuration it consumes**, never as a dependency it installs:

- `DEPLOYMENT.md:50` — `LITELLM_API_KEY` — *"LiteLLM virtual key."*
- `DEPLOYMENT.md:51` — `LITELLM_BASE_URL` — *"LiteLLM endpoint. Reached over the internal network."*
- `DEPLOYMENT.md:150` — `AI_NETWORK_NAME` — *"The shared AI network `chat-db` must **not** be on (default `innovera_default`)"*
- `DEPLOYMENT.md:440` — *"LiteLLM is **not** part of readiness."*
- `scripts/deploy.sh:39` — `REQUIRED_RUNTIME_VARS="DATABASE_URL CLERK_SECRET_KEY LITELLM_API_KEY LITELLM_BASE_URL"`
- `scripts/deploy.sh:179` — `AI_NET="${AI_NETWORK_NAME:-innovera_default}"`

`docker-compose.yml` was read in full and contains exactly three services — `chat-db`,
`chat-migrator`, `chat-app` — and **no LiteLLM service**, confirming LiteLLM is a *separate*
deployment on the same host reached over the shared `innovera_default` network.
(Gateway contract details: cite `gate-2` / `OCR_ARCHITECTURE_CANONICAL.md`; not restated here.)

**No version string. No image tag. No digest. No pin.** Chat is a *client*, and clients do not record
their gateway's package version.

### 3.4 Repo-side verdict

> **The repository estate cannot date the gateway's LiteLLM version, and this is a structural fact,
> not a search failure.** No repo installs LiteLLM; the one repo that talks to it is TypeScript and
> pins nothing; and the malicious releases were published **directly to PyPI bypassing CI**, so even a
> LiteLLM CI log would not have recorded them. Scope G is resolvable **only** on the GPU host itself.
> That is what `gate-1-owner-runbook.md` exists for.

---

## 4. Decisions

Each decision states: competing proposals → selected → rejected alternatives → reason →
implementation consequence → migration consequence → security consequence → config/env consequence.

### D1-1 — Two-scope verdict model

- **Competing proposals.** (a) One overall Gate 1 verdict. (b) Two independent verdicts, Scope L and
  Scope G, never combined. (c) One verdict qualified by prose caveats.
- **Selected.** **(b) Two independent, separately-labelled verdicts.**
- **Rejected alternatives.** (a) and (c).
- **Reason.** The Scope L evidence is strong, complete and quotable; the Scope G evidence does not
  exist. Any single verdict inherits the *confidence* of the strong half and the *truth value* of the
  weak half. M0's failure mode was exactly this — five documents independently "absorbed" the gateway
  unknown and disagreed (`z-adversarial-panel.md`). Prose caveats (c) get stripped when a verdict is
  quoted into a summary.
- **Implementation consequence.** Every artefact citing Gate 1 must cite `gate1.scopeL.verdict` or
  `gate1.scopeG.verdict`, never "Gate 1 passed". The structured gate result carries two fields.
- **Migration consequence.** When the owner returns the runbook output, **only** `gate1.scopeG.*`
  changes. Scope L is frozen and never re-litigated unless this workstation installs Python packages
  it did not have on 2026-09-09.
- **Security consequence.** Removes the single most dangerous misread available here — "the sweep came
  back clean, ship it" — where the sweep covered a machine that is not the one holding the credential.
- **Config/env consequence.** None. Documentation and gate-state shape only.

### D1-2 — Minimum acceptable gateway LiteLLM version

- **Competing proposals.** (a) `>= 1.82.6` (the last confirmed-clean pre-incident release).
  (b) `>= 1.83.0` (first post-incident release, built on the rebuilt CI/CD v2). (c) `!= 1.82.7` and
  `!= 1.82.8` — exclude only the two known-bad versions. (d) Latest available.
- **Selected.** **(b) `>= 1.83.0`, with (a) `== 1.82.6` accepted only under the conditional in the
  next paragraph.**
- **Rejected alternatives.** (c) is rejected outright: it accepts a host that installed 1.82.8, was
  compromised, and was later "fixed" by downgrading — downgrading removes the package but **does not
  remove `~/.config/sysmon/sysmon.py`, the `sysmon.service` unit, or the harvested credentials**. A
  version check alone is not a compromise check. (d) is rejected because "latest" is unpinned, which
  is the exact constraint shape that resolved to 1.82.8 during the window (§1.4 reason 4). (a) is
  conditionally accepted, not preferred, because 1.82.6 predates the CI/CD rebuild and the maintainer
  account rotation.
- **Reason.** 1.83.0 is the first release whose provenance was re-established after PyPI credentials
  and maintainer accounts were rotated and Mandiant was engaged. An exact `==` pin against a published
  GitHub release is the only pin shape that survives a repeat of this incident class.
- **Conditional acceptance of 1.82.6.** Permitted **only** when all three hold: (i) the version is
  pinned `==1.82.6` exactly, not `>=`; (ii) the image `Created` timestamp is strictly before
  `2026-03-24T10:39:00Z`; (iii) runbook steps 4 and 6 (`.pth` enumeration, persistence scan) return
  clean. Otherwise 1.82.6 is treated as UNKNOWN and 1.83.0+ is required.
- **Implementation consequence.** OCR's gateway preflight records the attested version as an opaque
  string; it does **not** query the gateway for it (the gateway is not ours to interrogate at runtime
  and must not gate our liveness — cite the readiness rule in `OCR_ARCHITECTURE_CANONICAL.md`). The
  value is entered once by the owner from runbook output.
- **Migration consequence.** A gateway upgrade below the floor is a **blocking** change: the attested
  value moves, the attestation expires, and Gate 1 re-runs before OCR resumes calls. Encode the floor
  as data, not as a comment, so the check is mechanical.
- **Security consequence.** Sets a hard, numeric, auditable floor in place of a judgement call, and
  explicitly refuses the "we downgraded, we're fine" reasoning that a naive version check permits.
- **Config/env consequence.** Introduces `LITELLM_ATTESTED_VERSION` (owner-supplied, e.g. `1.83.0`)
  and the build-time constant `LITELLM_MIN_SAFE_VERSION = 1.83.0`. **Fail-closed:** if
  `LITELLM_ATTESTED_VERSION` is unset or parses below the floor, OCR **must not send any document
  content to the gateway** and the AI-assist feature is disabled. Core OCR is unaffected — see D1-5.

### D1-3 — Credential acceptance is a **precondition**, not a follow-up task

- **Competing proposals.** (a) Request the OCR key now, wire it, and run the supply-chain check in
  parallel. (b) Refuse to accept or store any credential until Scope G returns clean. (c) Accept a
  key now but scope it to a throwaway "probe" identity, and re-issue after clearance.
- **Selected.** **(b) No credential is requested, accepted, stored, or written to any `.env` until
  Scope G returns clean.**
- **Rejected alternatives.** (a) is rejected because the malware harvests `.env` files, the process
  environment **and shell history** — so a key issued onto an unrotated host is compromised at the
  moment of issuance, and "we'll check later" checks a key that has already leaked. (c) is rejected
  because a probe key issued *from* a compromised gateway is issued *by* a control plane the attacker
  may hold; a scoped key does not fix a compromised issuer, and re-issuance after clearance is the same
  work done twice with an extra leak in between.
- **Reason.** Rotation cannot be retroactive. The window between issuance and clearance is precisely
  the window in which the credential is exposed, and it is a window we choose to open.
- **Implementation consequence.** The OCR AI-assist code path is written to a port interface and
  ships **disabled**, with the deterministic OCR pipeline fully functional without it. No `.env` key,
  no secret-manager entry, no CI secret is created before clearance.
- **Migration consequence.** When Scope G clears, one config value is populated and one feature flag
  flips. No schema change, no code change, no redeploy of anything but configuration. If Scope G
  *fails*, nothing must be un-done and no credential must be rotated — the cheapest possible failure.
- **Security consequence.** Reduces the credential's exposure window from "issuance → discovery" to
  **zero**. Also enforces the `z-adversarial-panel.md` objection that the credential boundary was the
  one control M0 absorbed inconsistently.
- **Config/env consequence.** Canonical gate value `GATE1_CREDENTIAL_ISSUANCE = BLOCKED` until the
  owner supplies runbook output. The AI-assist feature flag defaults **off**.

### D1-4 — Attestation has a defined lifetime and a defined re-trigger

- **Competing proposals.** (a) One-time clearance, permanent. (b) Time-boxed clearance requiring
  periodic re-attestation. (c) Re-attest on every deploy.
- **Selected.** **(b), with the specific rule: an attestation is valid for 90 days, and is invalidated
  immediately — regardless of age — by any change to the gateway image digest.**
- **Rejected alternatives.** (a) is rejected because the gateway is a *live* third-party system that
  will be upgraded without telling us; a permanent clearance certifies a machine state that no longer
  exists. (c) is rejected as unenforceable — we do not control gateway deploys and cannot observe
  them, so a per-deploy rule would silently degrade into (a).
- **Reason.** 90 days matches the practical cadence at which an unmanaged host drifts, and the digest
  trigger catches the actual risk event (a new image) rather than the calendar.
- **Implementation consequence.** Store `LITELLM_ATTESTED_AT` (ISO-8601 date) and
  `LITELLM_ATTESTED_IMAGE_DIGEST` alongside the version. A preflight compares
  `now - LITELLM_ATTESTED_AT` against 90 days.
- **Migration consequence.** Expiry is a **warning**, not an outage: it raises an operational alert
  and blocks *new* credential issuance, but does not sever an already-working integration. Treating
  expiry as an outage would guarantee the check gets disabled the first time it fires at 02:00.
- **Security consequence.** Bounds how stale a security claim may get, and ties re-verification to the
  event that actually changes the risk. Recording the digest also gives incident response an exact
  artefact to investigate rather than a tag like `latest`.
- **Config/env consequence.** `LITELLM_ATTESTED_AT`, `LITELLM_ATTESTED_IMAGE_DIGEST`,
  `LITELLM_ATTESTATION_MAX_AGE_DAYS = 90`. **Failure behaviour: warn + block new issuance; do not
  disable an existing, working integration.**

### D1-5 — INNOVERA OCR AI never installs `litellm`, and OCR never depends on the gateway

- **Competing proposals.** (a) Use the `litellm` Python SDK in the OCR worker for convenience.
  (b) Speak the gateway's OpenAI-compatible HTTP API directly from TypeScript, with **zero** LiteLLM
  code in our supply chain. (c) Vendor a pinned, hash-verified `litellm`.
- **Selected.** **(b). `litellm` is added to a permanent dependency denylist for this project.**
- **Rejected alternatives.** (a) is rejected because it imports the exact package whose PyPI
  distribution was backdoored twice in one day, into the worker that holds Thai identity documents.
  (c) is rejected because hash pinning defends against a *later* tamper of a known-good artefact; it
  does not help you choose the right artefact when the compromise is in the publishing pipeline, and it
  adds a large transitive dependency tree for an HTTP call we can make in ~30 lines.
- **Reason.** The house stack is TypeScript (Next.js 16 / Node 22); the gateway exposes an
  OpenAI-compatible HTTP surface. There is no functional reason to take the dependency, and the
  incident is a concrete, dated reason not to.
- **Implementation consequence.** A thin typed HTTP client with a Zod-validated response schema and an
  explicit timeout, behind a port interface. Deterministic OCR (native extraction, engine routing,
  Thai normalisation, layout reconstruction) has **no gateway dependency at all**; only semantic
  assist does.
- **Migration consequence.** Replacing LiteLLM with another gateway, or calling a model directly, is a
  one-adapter change. Adopting the SDK later would be a dependency-tree decision requiring a new gate.
- **Security consequence.** Our attack surface for this incident class becomes **zero by
  construction** — no Python LLM dependency exists to be poisoned. It also means a *future* LiteLLM
  compromise can degrade our AI-assist availability but cannot execute code in our worker.
- **Config/env consequence.** Denylist entry `litellm` enforced in CI (fail the build if the name
  appears in any lockfile or manifest). No LiteLLM SDK env vars. **Failure behaviour: build fails.**

### D1-6 — Treat the gateway as an untrusted, potentially-logging boundary

- **Competing proposals.** (a) Treat the gateway as internal/trusted since it is on our own host.
  (b) Treat it as an external boundary that may persist full prompt and response bodies.
- **Selected.** **(b).**
- **Rejected alternatives.** (a).
- **Reason.** Whether the gateway persists prompt/response bodies is **OWNER-BLOCKED (B-2)** and
  unknowable from here; LiteLLM's proxy supports request/response logging and callback integrations
  that write bodies to a database or a third-party sink. Independently, this incident demonstrated
  that "on our own host" is not a security property. This product processes **Thai identity
  documents**, so a body-logging gateway is a PDPA exposure, not merely a hygiene concern.
- **Implementation consequence.** Prompts sent to the gateway carry the **minimum text span needed for
  the specific semantic task**, never a whole document, never raw image bytes, and never a full
  national-ID number where a masked form suffices. The redaction step is in the request builder, not
  in a reviewer's discipline.
- **Migration consequence.** If the owner later confirms the gateway does not persist bodies (B-2
  resolved), the redaction step can be relaxed by configuration — but the code path stays, because the
  answer can change with one gateway config edit we would never see.
- **Security consequence.** Caps the blast radius of a gateway compromise or a gateway log leak at "a
  short span of a document" rather than "the document, and the identity in it".
- **Config/env consequence.** Governed by the redaction policy owned in
  `OCR_ARCHITECTURE_CANONICAL.md`; Gate 1 sets only the *requirement* that one exists and that it is
  fail-closed. Gate 1 owns `GATEWAY_TRUST_LEVEL = UNTRUSTED_LOGGING_ASSUMED`.

### D1-7 — The STOP rule

- **Competing proposals.** (a) On a positive IOC hit, document it and continue architecture work in
  parallel. (b) On a positive hit, **stop the OCR architecture process** and produce only the evidence
  and remediation record. (c) On a positive hit, continue but disable AI features.
- **Selected.** **(b).**
- **Rejected alternatives.** (a) and (c) are rejected for the same reason: a positive hit means every
  credential on the GPU host is compromised — including the Postgres passwords, the Clerk secret and
  the SSH keys used by **INNOVERA Chat, which runs on that same host**. That is an active
  incident-response situation affecting a live production system with real users. Continuing to
  design a *new* system on top of a host under active compromise is the wrong use of the next hour,
  and (c)'s "just disable AI" understates it — the compromise is not confined to the AI path.
- **Reason.** The scope of a hit is the host, not the feature.
- **Implementation consequence.** The gate returns `verdict: BLOCKED-OWNER-ACTION-REQUIRED` (or `FAIL`
  on a confirmed hit) and M0.5 halts for this dimension. No further OCR gateway design is produced
  until remediation is recorded.
- **Migration consequence.** Post-remediation, Gate 1 re-runs from scratch against the **rebuilt** host.
  Evidence from the compromised host is not carried forward.
- **Security consequence.** Prevents the classic failure of designing around a known-compromised
  dependency and shipping the compromise as an accepted risk.
- **Config/env consequence.** None. Process control only.
- **Rotation SLA on a confirmed hit (numeric, not "promptly"):** revoke all gateway-issued virtual
  keys within **4 hours** of confirmation; complete full host credential rotation — SSH keys, cloud
  credentials, DB passwords, Clerk secret, registry credentials, all LiteLLM virtual keys and the
  master key — within **24 hours**; rebuild the gateway host from a known-good image within **72
  hours**. Accept **no** credential from that host until the rebuild is complete.

---

## 5. Deliverable — the owner's exact requested shape

Answers are given **per scope**. Do not merge the columns.

### A. Current LiteLLM version

| Scope | Answer |
|---|---|
| **L — Workstation** | **Not installed. No version. Never installed.** Proven by L-1 through L-9: no image, no layer, no import, no file, no cache entry, no pin. |
| **G — Gateway** | **OWNER-BLOCKED (B-1).** Unknown and unknowable from this session. The gateway is not on this machine and not in any of the 15 public repos; the only repo that talks to it (`innovera-chat`) is TypeScript and pins nothing. Resolvable **only** by runbook step 2/3 on the GPU host. **Default if the owner stays silent: treat as UNKNOWN → `GATE1_CREDENTIAL_ISSUANCE = BLOCKED`, AI-assist ships disabled, deterministic OCR ships fully functional.** |

### B. Historical 1.82.7 usage — YES / NO / UNKNOWN

| Scope | Answer |
|---|---|
| **L — Workstation** | **NO.** No `litellm` directory or file anywhere on `/` (L-4); no `proxy_server.py`; no litellm layer in any of 110 Docker images (L-2); no cached wheel (L-8); no manifest pin (L-9). Caveat: the shell-history check is **un-run** (§2.4). |
| **G — Gateway** | **UNKNOWN — OWNER-BLOCKED (B-1).** **Default if silent: UNKNOWN, treated as NOT-CLEARED.** |

### C. Historical 1.82.8 usage — YES / NO / UNKNOWN

| Scope | Answer |
|---|---|
| **L — Workstation** | **NO.** The decisive check is `.pth`: `find / -name "litellm_init.pth"` → zero results, and **all 12** `.pth` files on the box were hashed and read, none exceeding 152 bytes against the malicious 34,628 (§2.2). |
| **G — Gateway** | **UNKNOWN — OWNER-BLOCKED (B-1).** Runbook steps 4 and 5 resolve it. **Default if silent: UNKNOWN, treated as NOT-CLEARED.** |

### D. Persistence IOC present — YES / NO

| Scope | Answer |
|---|---|
| **L — Workstation** | **NO.** `~/.config/sysmon` absent; `~/.config/systemd` absent; all four `/tmp` staging artefacts absent; no C2 strings on disk or in `/etc/hosts`; `launchd` fully enumerated with every non-Apple entry attributed (§2.3). The Linux `systemd` IOC has no applicable form on macOS — its absence is by construction and is **not** counted as evidence. |
| **G — Gateway** | **UNKNOWN — OWNER-BLOCKED (B-1).** Runbook steps 6 and 7. **Default if silent: UNKNOWN, treated as NOT-CLEARED.** |

### E. Credential-exposure risk classification

| Credential class | Scope | Classification | Basis |
|---|---|---|---|
| Anything held on this workstation | L | **LOW** | No infection vector was ever present. Residual risk is confined to the un-run shell-history check (§2.4) and is not specific to this incident. |
| A **new** OCR virtual key issued by the gateway | G | **UNQUANTIFIED — NOT LOW** | Cannot be classified until B/C/D resolve for Scope G. Must not be treated as LOW by default. |
| Existing credentials already on the GPU host — Chat's `LITELLM_API_KEY`, `CHAT_POSTGRES_PASSWORD`, `CLERK_SECRET_KEY`, `DATABASE_URL`, host SSH keys, registry credentials | G | **UNQUANTIFIED — POTENTIALLY CRITICAL** | If the gateway ran either version, all of these were harvested. This is **the most consequential finding in Gate 1** and it is about **INNOVERA Chat's live production credentials, not ours**. It is surfaced here because Gate 1's evidence-gathering is what would reveal it, and the owner needs to know that the runbook is worth running for Chat's sake even if OCR were cancelled tomorrow. |
| Prompt / response bodies sent to the gateway | G | **UNQUANTIFIED — OWNER-BLOCKED (B-2)** | Whether the gateway persists bodies is unknown. **Default if silent: assume it persists them** (D1-6), and minimise/redact accordingly. |

### F. Is AI credential issuance safe now — YES / NO

> ## **NO — not yet. BLOCKED pending owner action.**
>
> Not because anything bad was found, but because **the one machine that matters was not examined**.
> Scope L is clean and that is genuinely good news; it is also irrelevant to this question, because
> the credential will be minted on Scope G.
>
> This flips to **YES** when, and only when, `gate-1-owner-runbook.md` returns clean for steps 2–8 and
> the attested version satisfies `>= 1.83.0` (or the `== 1.82.6` conditional in D1-2).
> It flips to a hard **NO + STOP** (D1-7) on any positive hit.
>
> **Cost of waiting: near zero.** Per D1-3 and D1-5, deterministic OCR — native extraction, engine
> routing, multi-engine candidates, Thai normalisation, layout and table reconstruction, confidence
> and provenance — has **no gateway dependency**. Only semantic assist is gated, and it ships behind a
> flag that is off. Nothing in M0.5 is blocked by this gate except the act of accepting a secret.

### G. Required remediation if exposure cannot be ruled out

Two branches. Take exactly one.

**G-1 — Exposure ruled out (runbook clean).** Record `LITELLM_ATTESTED_VERSION`,
`LITELLM_ATTESTED_AT`, `LITELLM_ATTESTED_IMAGE_DIGEST`. Set `GATE1_CREDENTIAL_ISSUANCE = ALLOWED`.
Request a **least-privilege virtual key**, mirroring Chat's existing `LITELLM_API_KEY` convention —
**never the master key** (Chat already follows this; cite `OCR_ARCHITECTURE_CANONICAL.md` for the key
contract). Re-attest within **90 days** or on any image-digest change (D1-4).

**G-2 — Exposure cannot be ruled out (hit, or the owner cannot / will not run the runbook).**

1. **Stop.** D1-7 applies. No credential is requested or accepted from that host.
2. **Contain, do not clean-in-place.** Removing `litellm_init.pth` and downgrading is **not
   remediation** — it leaves `~/.config/sysmon/sysmon.py` and the `sysmon.service` unit, which poll
   `https://checkmarx.zone/raw` for arbitrary binaries. Rebuild the host from a known-good image.
3. **Rotate everything on the host, on the D1-7 SLA** (4 h revoke / 24 h rotate / 72 h rebuild):
   all LiteLLM virtual keys **and** the master key; every upstream model-provider key the gateway
   holds; the gateway's own DB credentials; **INNOVERA Chat's** `CHAT_POSTGRES_PASSWORD`,
   `CLERK_SECRET_KEY` and `DATABASE_URL`; host SSH keys and any `authorized_keys` entry; Docker
   registry credentials; every cloud credential reachable from the host, including anything obtainable
   via IMDSv2; and any secret that ever appeared in shell history on that host.
4. **Hunt for the second stage.** The malware polls C2 for arbitrary binaries. Assume additional,
   unrelated implants may have been delivered after the initial payload. A version check does not
   clear a host that polled C2 for days.
5. **Egress evidence.** Search host/network logs for `models.litellm.cloud` and `checkmarx.zone` from
   `2026-03-24` onward. A single successful POST to `models.litellm.cloud` upgrades this from
   *possible* to *confirmed* exfiltration and makes rotation mandatory rather than precautionary.
6. **Then and only then**, re-run Gate 1 from scratch against the rebuilt host.

---

## 6. Owner-blocked items and shipping defaults

| ID | Question | Why it cannot be answered here | **Default that ships if the owner stays silent** |
|---|---|---|---|
| **B-1** | Did the gateway ever run LiteLLM 1.82.7 or 1.82.8, and what version does it run now? | Gateway is a remote host; network access to it is forbidden by the M0.5 constraints and it appears in no readable repo. | `GATE1_CREDENTIAL_ISSUANCE = BLOCKED`. AI-assist ships **disabled**. Deterministic OCR ships **fully functional**. No credential is ever requested. |
| **B-2** | Does the gateway persist prompt/response bodies (LiteLLM logging/callbacks/DB)? | Gateway config unreadable. | **Assume YES.** Minimum-span prompts, redaction on by default, no raw document and no unmasked national-ID number sent (D1-6). |
| **B-3** | Was `pip install litellm` ever run on **this workstation** historically? | `~/.zsh_history` (64,293 bytes) exists but reads are refused by the session permission classifier. | Treated as **un-run, not clean**. Does not change the Scope L verdict, because L-2/L-4/L-5 already prove no artefact survives. One command clears it: `grep -n "litellm" ~/.zsh_history`. |
| **B-4** | What do the GPU host's deployment / image-pull logs show around 2026-03-24? | Host unreachable. | Absence of logs is treated as **UNKNOWN**, never as clean. Runbook step 8. |

---

## CANONICAL VALUES

Every value below is **owned by this document**. Cite it as
`gate-1-litellm-supply-chain.md §CANONICAL VALUES`. **Do not restate it** — restating is how M0 drifted.

| key | value | env var | reason | failure behaviour |
|---|---|---|---|---|
| `gate1.scopeL.verdict` | `CLEAN` | — | Workstation proven free of LiteLLM by 13 independent checks incl. 110-image layer history and 12 hashed `.pth` files | Frozen. Re-run Gate 1 only if this box installs Python packages after 2026-09-09. |
| `gate1.scopeG.verdict` | `UNKNOWN-OWNER-BLOCKED` | — | Gateway unreachable; no repo dates it; malicious releases bypassed CI so no CI log exists | Never treat as clean. Blocks credential acceptance only — not OCR delivery. |
| `GATE1_CREDENTIAL_ISSUANCE` | `BLOCKED` | `GATE1_CREDENTIAL_ISSUANCE` | No credential may be minted on a host whose supply-chain history is unknown (D1-3) | Fail-closed. AI-assist disabled; deterministic OCR unaffected. Flips to `ALLOWED` only on clean runbook output. |
| `LITELLM_MIN_SAFE_VERSION` | `1.83.0` | build-time constant | First post-incident release on the rebuilt CI/CD v2 pipeline (D1-2) | Attested version below floor ⇒ `GATE1_CREDENTIAL_ISSUANCE=BLOCKED`, no document content sent to gateway. |
| `LITELLM_CONDITIONAL_SAFE_VERSION` | `1.82.6` | — | Last confirmed-clean pre-incident release; accepted **only** with exact `==` pin **and** image `Created` < `2026-03-24T10:39:00Z` **and** clean runbook steps 4 + 6 (D1-2) | Any condition unmet ⇒ treated as UNKNOWN; 1.83.0+ required. |
| `LITELLM_FORBIDDEN_VERSIONS` | `1.82.7`, `1.82.8` | — | Maliciously backdoored PyPI releases, 2026-03-24 | Positive identification ⇒ **STOP** (D1-7). No credential accepted from that host, ever, until full rebuild. |
| `LITELLM_ATTESTED_VERSION` | *(owner-supplied)* | `LITELLM_ATTESTED_VERSION` | Recorded once from runbook output; never queried at runtime — the gateway must not gate our liveness | Unset or below floor ⇒ AI-assist disabled. Never inferred, never defaulted to a version number. |
| `LITELLM_ATTESTED_AT` | *(owner-supplied, ISO-8601 date)* | `LITELLM_ATTESTED_AT` | Anchors the attestation lifetime (D1-4) | Unset ⇒ attestation invalid ⇒ issuance blocked. |
| `LITELLM_ATTESTED_IMAGE_DIGEST` | *(owner-supplied, `sha256:…`)* | `LITELLM_ATTESTED_IMAGE_DIGEST` | A digest identifies the exact artefact; a tag like `latest` does not (D1-4) | Digest change ⇒ attestation void immediately, regardless of age. |
| `LITELLM_ATTESTATION_MAX_AGE_DAYS` | `90` | `LITELLM_ATTESTATION_MAX_AGE_DAYS` | Bounds staleness of a third-party security claim (D1-4) | Expiry ⇒ **warn + block new issuance**. Does **not** sever a working integration. |
| `GATEWAY_TRUST_LEVEL` | `UNTRUSTED_LOGGING_ASSUMED` | `GATEWAY_TRUST_LEVEL` | B-2 unresolved; "same host" is not a security property; Thai identity documents ⇒ PDPA exposure (D1-6) | Redaction fail-closed: if the redactor errors, the request is **not** sent. |
| `PTH_ANOMALY_SIZE_BYTES` | `1024` | build/scan constant | Largest benign `.pth` observed across 15 `site-packages` dirs = **152 B**; malicious = **34,628 B** (228×). Generalises past one filename to the whole `.pth`-injection class (§2.2) | Any `site-packages` `.pth` over the threshold ⇒ read it before trusting the environment. |
| `LITELLM_IOC_PTH_FILENAME` | `litellm_init.pth` | — | 1.82.8 vector; executes at interpreter start, no import required | Present anywhere ⇒ **STOP** (D1-7). |
| `LITELLM_IOC_PTH_SHA256` | `71e35aef03099cd1f2d6446734273025a163597de93912df321ef118bf135238` | — | Hex form. Equals the base64url form `ceNa7wMJnNHy1kRnNCcwJaFjWX3pORLfMh7xGL8TUjg` — **verified in-session by decoding**; comparing across encodings yields a false negative | Compare in **hex**. Match ⇒ **STOP**. |
| `LITELLM_IOC_WHEEL_SHA256` | `d2a0d5f564628773b6af7b9c11f6b86531a875bd2d186d7081ab62748a800ebb` | — | 1.82.8 wheel digest | Match in any cache/wheelhouse ⇒ **STOP**. |
| `LITELLM_IOC_EXFIL_HOST` | `models.litellm.cloud` | — | Exfil endpoint; deliberately confusable with `litellm.ai`. Registered 2026-03-23 | Any egress record ⇒ **confirmed** exfiltration ⇒ mandatory rotation, not precautionary. |
| `LITELLM_IOC_C2_URL` | `https://checkmarx.zone/raw` | — | C2 poll for arbitrary binaries; poll interval disputed (5 min vs ~50 min) so alert on **destination**, not cadence | Any egress record ⇒ **STOP** + assume second-stage implants. |
| `LITELLM_IOC_PERSISTENCE_PATHS` | `~/.config/sysmon/sysmon.py`, `/root/.config/sysmon/sysmon.py`, `~/.config/systemd/user/sysmon.service` | — | Survives package removal and downgrade — a version check alone does **not** clear a host | Present ⇒ **STOP**. Do not clean in place; rebuild. |
| `LITELLM_IOC_SYSTEMD_UNIT` | `sysmon.service` (description: `System Telemetry Service`) | — | Linux persistence unit. **No macOS equivalent** — absence on macOS is by construction, not evidence | Present on the gateway ⇒ **STOP**. |
| `LITELLM_IOC_TMP_ARTEFACTS` | `/tmp/tpcp.tar.gz`, `/tmp/session.key`, `/tmp/session.key.enc`, `/tmp/payload.enc` | — | Staging files, AES-256-CBC + RSA-4096-OAEP bundle | Present ⇒ **STOP**. |
| `LITELLM_IOC_K8S_POD_PATTERN` | `node-setup-*` in `kube-system` (container `setup`, image `alpine:latest`, `hostPID`+`hostNetwork`+privileged) | — | Lateral movement to every node | Present ⇒ **STOP**, cluster-wide incident. |
| `LITELLM_IOC_RSA_PUBKEY_PREFIX` | `MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAvahaZDo8mucujrT15ry+` | — | Identical across the Trivy, KICS and LiteLLM payloads — strongest single attribution string | Found in any artefact ⇒ **STOP**, TeamPCP campaign confirmed. |
| `LITELLM_INCIDENT_WINDOW_START` | `2026-03-24T10:39:00Z` | — | Malicious releases went live on PyPI | Gateway image `Created` at or after this ⇒ HIGH RISK, requires layer-level proof. |
| `LITELLM_INCIDENT_WINDOW_END` | `2026-03-31T00:00:00Z` | — | Day after clean v1.83.0. Deliberately **wider than the ~40-minute PyPI window** because pip caches, private mirrors, Docker layer caches and unpinned `>=` constraints all outlive a quarantine (§1.4) | Image created inside the window ⇒ never clean-by-default. |
| `GATE1_ROTATION_SLA_REVOKE_HOURS` | `4` | — | Revoke all gateway-issued virtual keys on confirmed hit (D1-7) | Missed ⇒ escalate; no credential accepted from the host meanwhile. |
| `GATE1_ROTATION_SLA_FULL_HOURS` | `24` | — | Full host credential rotation on confirmed hit | Missed ⇒ host stays quarantined. |
| `GATE1_REBUILD_SLA_HOURS` | `72` | — | Host rebuild from known-good image; cleaning in place is not remediation | Missed ⇒ Gate 1 stays `FAIL`; OCR gateway integration stays unbuilt. |
| `OCR_DEPENDENCY_DENYLIST` | `litellm` | CI check | We speak the gateway's OpenAI-compatible HTTP API from TypeScript; the SDK buys nothing and re-imports the compromised distribution (D1-5) | Name appearing in any manifest or lockfile ⇒ **build fails**. |

---

## Sources

- [safedep — Malicious litellm 1.82.8: Credential Theft and Persistent Backdoor](https://safedep.io/malicious-litellm-1-82-8-analysis/)
- [Snyk — How a Poisoned Security Scanner Became the Key to Backdooring LiteLLM](https://snyk.io/blog/poisoned-security-scanner-backdooring-litellm/)
- [LiteLLM — Security Update: Suspected Supply Chain Incident](https://docs.litellm.ai/blog/security-update-march-2026)
- [BerriAI/litellm issue #24518 — full timeline and status](https://github.com/BerriAI/litellm/issues/24518)
- [BleepingComputer — Popular LiteLLM PyPI package backdoored to steal credentials](https://www.bleepingcomputer.com/news/security/popular-litellm-pypi-package-compromised-in-teampcp-supply-chain-attack/)
- [Cycode — Shedding The Lite: the LiteLLM Compromise](https://cycode.com/blog/lite-llm-supply-chain-attack/)
- `WeiWutichai/innovera-chat` — `DEPLOYMENT.md`, `scripts/deploy.sh`, `docker-compose.yml`, full 215-file tree (public repo, read via `gh api`)
- `WeiWutichai/pguard` — `tooling/codegen/requirements.txt` (public repo, read via `gh api`)
