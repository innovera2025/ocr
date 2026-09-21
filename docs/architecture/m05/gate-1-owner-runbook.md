---
dimension: gate-1-litellm-supply-chain
title: "Gate 1 — Owner Runbook: Clearing the GPU Host of the LiteLLM 1.82.7/1.82.8 Backdoor"
status: canonical
date: 2026-09-09
supersedes:
  - docs/architecture/m0/b-ai-topology-discovery.md  # Q8b (the owner question this runbook operationalises), B-15
owner: Gate 1
audience: "The person with SSH access to the production GPU host. Not an agent. Not automatable from this session."
---

# Gate 1 — Owner Runbook

> **Integration status (2026-09-12):** Read the [architecture index](../README.md) and its consolidation report before using these examples. Individual review labels do not close cross-document conflicts; no application implementation is verified.

# ⚠️ NOTHING IN THIS RUNBOOK MUTATES STATE. DO NOT ROTATE ANYTHING AUTOMATICALLY.

**Every command below is read-only.** No `rm`, no `docker rm`, no `docker pull`, no `pip install`,
no `systemctl stop|disable`, no key revocation, no config edit. This is a *fact-finding* pass whose
entire output is a set of yes/no answers.

**Why read-only matters here, specifically:** if the host **is** compromised, the correct first move
is *preserve and rotate*, not *clean*. Deleting `litellm_init.pth` destroys the single best piece of
evidence, does not remove the `sysmon` persistence, does not remove the C2 implant, and does not
un-leak the credentials that were already exfiltrated. Cleaning before rotating is worse than doing
nothing. **Run this whole runbook first. Decide second.**

---

## 0. Before you start

**Context:** LiteLLM `1.82.7` and `1.82.8` were maliciously backdoored on PyPI on **2026-03-24 from
10:39 UTC**, and harvest SSH keys, cloud credentials, DB passwords, Kubernetes secrets, `.env` files,
**API keys out of shell history**, and the whole process environment from any host that installed
them. INNOVERA OCR AI is about to ask this host to issue it a credential.

**Also note:** INNOVERA Chat's production credentials — `CHAT_POSTGRES_PASSWORD`, `CLERK_SECRET_KEY`,
`DATABASE_URL`, `LITELLM_API_KEY` — live on this same host. **This runbook is worth running for Chat's
sake even if the OCR project were cancelled today.**

Full incident detail, IOC table and decision rationale:
`docs/architecture/m05/gate-1-litellm-supply-chain.md`.

**Fill this in as you go, then send it back:**

```
GATE 1 — GPU HOST RESULT
  host                          : ______________________
  date/time run (UTC)           : ______________________
  step 1  container name        : ______________________
  step 2  image tag             : ______________________
  step 2  image digest          : sha256:______________
  step 2  image Created (UTC)   : ______________________
  step 3  litellm version       : ______________________
  step 4  .pth files (count)    : ______  any >1024 B? Y/N
  step 5  litellm_init.pth      : FOUND / NOT FOUND
  step 6  sysmon persistence    : FOUND / NOT FOUND
  step 7  /tmp artefacts        : FOUND / NOT FOUND
  step 8  image history hit     : FOUND / NOT FOUND
  step 9  pin in compose/reqs   : ______________________
  step 10 egress to C2/exfil    : FOUND / NOT FOUND / NO LOGS
  step 11 k8s (if any)          : FOUND / NOT FOUND / N/A
  OVERALL                       : CLEAN / HIT / INCONCLUSIVE
```

**Set this once and reuse it.** Find the LiteLLM container name first:

```bash
docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Status}}' | grep -i litellm
```

Then:

```bash
C=<the container name from above>
```

If **nothing matches**, LiteLLM may be running under a non-obvious name. Widen the search:

```bash
docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Ports}}'
docker network inspect innovera_default --format '{{range .Containers}}{{.Name}}{{"\n"}}{{end}}'
```

The LiteLLM proxy conventionally listens on **4000**. **Do not proceed with `C` unset** — every step
below depends on it.

---

## Step 1 — Identify the container

```bash
docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.CreatedAt}}\t{{.Status}}' | grep -i litellm
```

- **CLEAN LOOKS LIKE:** exactly one row, with an image reference you recognise.
- **A HIT LOOKS LIKE:** *(no hit possible at this step — identification only)*.
- **NOTE:** more than one row, or an image from an unexpected registry, is worth pausing over. Record
  every row before continuing.
- **ON A HIT:** n/a.

---

## Step 2 — Image tag, digest, and creation date ★ high value

```bash
docker inspect "$C" --format 'image_ref={{.Config.Image}}'
docker image inspect "$(docker inspect "$C" --format '{{.Image}}')" \
  --format 'digest={{index .RepoDigests 0}}
created={{.Created}}
tags={{.RepoTags}}'
```

Record `digest` and `created` on the form — Gate 1 stores both as
`LITELLM_ATTESTED_IMAGE_DIGEST` and the attestation anchor.

- **CLEAN LOOKS LIKE:** `created` is **strictly before `2026-03-24T10:39:00Z`**, or **on/after
  `2026-03-31T00:00:00Z`**. Both sit outside the incident window.
- **A HIT LOOKS LIKE:** `created` falls **inside `2026-03-24T10:39:00Z` … `2026-03-31T00:00:00Z`**.
  This is **not proof of compromise** — it is proof that this image *could* have pulled a poisoned
  wheel. Steps 3–5 and 8 decide it.
- **ON A HIT:** do not stop; run steps 3, 4, 5 and 8, which are decisive. Report the digest either way.
- **WHY THE WINDOW IS ~6.6 DAYS, NOT 40 MINUTES:** PyPI quarantine removes the file from the index but
  **not** from pip/uv HTTP caches, private mirrors or pull-through proxies, and **not** from a cached
  Docker `RUN pip install` layer. An unpinned `litellm` constraint resolved to 1.82.8 during the live
  window and then froze into any image whose build cache was reused. Never treat "it was only live for
  40 minutes" as clearance.
- **PITFALL:** `RepoDigests` is empty for locally-built images. If so, record
  `local-build:<image id>` and rely on step 8.

---

## Step 3 — The installed LiteLLM version ★ high value

```bash
docker exec "$C" pip show litellm 2>/dev/null | grep -E '^(Name|Version|Location)'
```

If `pip` is absent from the image (slim/distroless base), use either:

```bash
docker exec "$C" python -c "import litellm, litellm.version; print(litellm.__file__)" 2>/dev/null
docker exec "$C" sh -c 'ls -d /usr/lib/python3*/site-packages/litellm-*.dist-info \
                              /usr/local/lib/python3*/site-packages/litellm-*.dist-info \
                              /usr/lib/python3/dist-packages/litellm-*.dist-info 2>/dev/null'
```

The `dist-info` directory name carries the version, e.g. `litellm-1.83.0.dist-info`.

Then capture the full environment for the record:

```bash
docker exec "$C" pip freeze > "$HOME/gate1-pip-freeze-$(date -u +%Y%m%dT%H%M%SZ).txt"
grep -i '^litellm' "$HOME"/gate1-pip-freeze-*.txt
```

- **CLEAN LOOKS LIKE:** `Version: 1.83.0` or higher. (Or exactly `1.82.6` **and** step 2 `created` is
  before `2026-03-24T10:39:00Z` **and** steps 4 + 6 are clean — the conditional acceptance.)
- **A HIT LOOKS LIKE:** `Version: 1.82.7` or `Version: 1.82.8`. **This is a confirmed compromise.**
- **ON A HIT:** **STOP.** Do not clean. Go to §"On any HIT" below.
- **⚠ THE TRAP IN THIS STEP:** a *clean* version here does **not** clear the host. If someone
  downgraded or rebuilt after the incident, `pip show` reads clean while
  `~/.config/sysmon/sysmon.py` and the C2 implant are still running. **Steps 4, 5, 6, 7 and 10 are
  what actually clear the host. Do not stop at step 3.**
- **PITFALL:** `pip freeze` inside the container ≠ the host's Python. Both matter; step 6 covers the
  host.

---

## Step 4 — Enumerate every `.pth` in the container's site-packages ★ decisive for 1.82.8

```bash
docker exec "$C" sh -c '
  find / -name "*.pth" -path "*site-packages*" -o -name "*.pth" -path "*dist-packages*" 2>/dev/null |
  while read -r f; do
    printf "%8s  %s  %s\n" "$(wc -c < "$f")" "$(sha256sum "$f" 2>/dev/null | cut -d" " -f1)" "$f"
  done | sort -rn'
```

If `sha256sum` is missing, substitute `python -c "import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],'"'"'rb'"'"').read()).hexdigest())" "$f"`.

Read the top of that sorted list — the largest file first.

- **CLEAN LOOKS LIKE:** a short list (typically 1–5 files), **every one under 1,024 bytes**. Expected
  names: `distutils-precedence.pth` (~151 B), `_virtualenv.pth` (18 B), `__editable__.*.pth` (~97 B),
  `protobuf-*.pth`, `matplotlib.pth`. For reference, the largest benign `.pth` observed across 15
  `site-packages` directories on the INNOVERA workstation is **152 bytes**.
- **A HIT LOOKS LIKE:** any `.pth` at or near **34,628 bytes**, and/or any file named
  `litellm_init.pth`, and/or SHA-256
  `71e35aef03099cd1f2d6446734273025a163597de93912df321ef118bf135238`.
- **ON A HIT:** **STOP.** §"On any HIT".
- **WHY SIZE AND NOT JUST THE NAME:** the size rule catches a *renamed* variant of the same technique.
  The threshold is `1024` bytes; legitimate `.pth` files are one or two lines. **Any `.pth` over
  1,024 bytes must be read before the host is trusted**, even if the name looks innocent.
- **DIFF AGAINST EXPECTED:** if you have a known-good image of the same base, run the identical
  command against it and compare the two lists file-by-file. Any `.pth` present in the running
  container but absent from the reference image is anomalous regardless of size.

---

## Step 5 — Search the whole image filesystem for the malicious filename

Step 4 covers site-packages. This covers everything else, including build-cache leftovers and
non-standard install roots.

```bash
docker exec "$C" sh -c 'find / -xdev -name "litellm_init.pth" 2>/dev/null; echo "exit:$?"'
```

Also check every *layer* of the image, not just the running filesystem (catches a file added then
deleted in a later layer — deleted files still ship in the earlier layer):

```bash
docker save "$(docker inspect "$C" --format '{{.Image}}')" \
  | tar -tv 2>/dev/null | grep -i 'litellm_init\.pth'
```

- **CLEAN LOOKS LIKE:** no path printed by either command. (`docker save | tar -t` produces no
  matching line.)
- **A HIT LOOKS LIKE:** any path ending in `litellm_init.pth`, from either command.
- **ON A HIT:** **STOP.** §"On any HIT". Hash it for the record — do **not** delete it:
  `docker exec "$C" sha256sum <path>` and compare **in hex** against
  `71e35aef03099cd1f2d6446734273025a163597de93912df321ef118bf135238`.
- **⚠ ENCODING TRAP:** some published advisories give this digest in **base64url** as
  `ceNa7wMJnNHy1kRnNCcwJaFjWX3pORLfMh7xGL8TUjg`. That is the **same digest**, verified by decoding.
  Compare in **hex**; comparing hex against base64 produces a false "no match".
- **PITFALL:** `docker save` on a large image is slow and writes a lot through the pipe. It reads
  nothing from the network and mutates nothing. Skip it only if steps 3 and 4 are unambiguous.

---

## Step 6 — Host persistence: the `sysmon` implant ★ decisive, and independent of version

**Run these on the HOST, not in the container.** The payload escapes the container's Python and
installs into the invoking user's home.

```bash
ls -la ~/.config/sysmon/ 2>&1
ls -la /root/.config/sysmon/ 2>&1
ls -la ~/.config/systemd/user/sysmon.service 2>&1

systemctl --user list-unit-files 2>/dev/null | grep -i sysmon
systemctl --user status sysmon.service 2>&1 | head -20
sudo systemctl list-unit-files 2>/dev/null | grep -i sysmon

# Any user on the box, not just yours:
sudo find /home /root -maxdepth 5 -path "*/.config/sysmon*" 2>/dev/null
sudo find /home /root -maxdepth 6 -name "sysmon.service" 2>/dev/null
```

- **CLEAN LOOKS LIKE:** `No such file or directory` for every `ls`; **no output** from every `grep`;
  `systemctl --user status sysmon.service` reports `Unit sysmon.service could not be found.`; both
  `find` commands print nothing.
- **A HIT LOOKS LIKE:** a `sysmon.py` file, or a `sysmon.service` unit — commonly with
  `Description=System Telemetry Service`. **This survives package removal and downgrade.**
- **ON A HIT:** **STOP.** §"On any HIT". Do **not** run `systemctl --user disable`, do **not** delete
  the file. Capture it read-only for evidence:
  `cp -p ~/.config/sysmon/sysmon.py ~/gate1-evidence-sysmon.py` and record `sha256sum` of both files.
- **WHY THIS STEP OUTRANKS STEP 3:** a host that ran 1.82.8 and was later "fixed" by downgrading
  reads **clean at step 3 and dirty here**. If you run only one step in this runbook, run this one.
- **PITFALL:** `systemctl --user` only queries *your* user's session bus. The `find` commands above
  cover other users; do not skip them. If the container ran as `root` on the host, `/root/.config/`
  is the likely location.

---

## Step 7 — Staging artefacts in `/tmp`

```bash
ls -la /tmp/tpcp.tar.gz /tmp/session.key /tmp/session.key.enc /tmp/payload.enc 2>&1
docker exec "$C" ls -la /tmp/tpcp.tar.gz /tmp/session.key /tmp/session.key.enc /tmp/payload.enc 2>&1
```

- **CLEAN LOOKS LIKE:** `No such file or directory` for all four, on both host and container.
- **A HIT LOOKS LIKE:** any of the four present.
- **ON A HIT:** **STOP.** §"On any HIT". Their presence means the exfiltration bundle was *built* —
  treat exfiltration as having occurred.
- **PITFALL:** `/tmp` is cleared on reboot on most distributions. **Absence here is weak evidence.**
  Do not let a clean step 7 offset a dirty step 4, 5 or 6.

---

## Step 8 — Image build history ★ catches an unpinned install even if the file is gone

```bash
docker image history --no-trunc "$(docker inspect "$C" --format '{{.Image}}')" \
  | grep -iE 'litellm|pip install|requirements'
```

- **CLEAN LOOKS LIKE:** either no output, or install lines carrying an **exact** pin such as
  `pip install litellm==1.83.0`.
- **A HIT LOOKS LIKE:** `pip install litellm==1.82.7` or `==1.82.8`.
- **A YELLOW FLAG (not a hit, but it prevents clearance):** an **unpinned** install —
  `pip install litellm`, `litellm>=1.82`, `litellm[proxy]` with no `==`. Combined with a step-2
  `created` inside the incident window, this is the exact shape that pulled 1.82.8. It does not
  confirm compromise, but it means step 2 alone cannot clear the host — steps 4, 5 and 6 must.
- **ON A HIT:** **STOP.** §"On any HIT".
- **PITFALL:** if the image was pulled from a registry rather than built here, history may be squashed
  or show only `#(nop)` lines. Then the version comes from step 3 and the file evidence from steps 4–5.

---

## Step 9 — The declared pins (compose / requirements)

```bash
# Wherever the LiteLLM deployment lives on this host — likely a sibling of the Chat deployment:
grep -rniE 'litellm' \
  --include='docker-compose*.y*ml' --include='compose*.y*ml' \
  --include='requirements*.txt' --include='pyproject.toml' \
  --include='poetry.lock' --include='uv.lock' --include='Pipfile.lock' \
  --include='Dockerfile*' \
  ~ /opt /srv /etc 2>/dev/null | head -40
```

- **CLEAN LOOKS LIKE:** an exact pin (`litellm==1.83.0`) or a pinned image
  (`image: ghcr.io/berriai/litellm:v1.83.0@sha256:…`).
- **A HIT LOOKS LIKE:** `1.82.7` or `1.82.8` anywhere.
- **A YELLOW FLAG:** `image: ...litellm:latest` or `:main-latest`, or an unpinned pip requirement.
  `latest` means the running version can change under you between attestations — which is exactly why
  Gate 1 records an **image digest**, not a tag, and voids the attestation when the digest moves.
- **ON A HIT:** **STOP.** §"On any HIT".
- **NOTE:** for reference, **no** INNOVERA repository pins `litellm` anywhere — all 15 public repos
  were enumerated file-by-file this session and the entire estate contains one Python dependency
  (`PyYAML==6.0.2`). So whatever you find here exists **only on this host** and is not under version
  control. That is itself worth fixing later; it is not a Gate 1 blocker.

---

## Step 10 — Deployment and egress evidence

```bash
# When was the image pulled / the service last deployed?
docker events --since '2026-03-20' --until '2026-04-05' \
  --filter 'event=pull' --filter 'event=create' 2>/dev/null | head -40

# Journal around the incident window (if the host retains it that far back):
sudo journalctl --since '2026-03-24 00:00' --until '2026-03-31 23:59' 2>/dev/null \
  | grep -iE 'litellm|pip install|models\.litellm\.cloud|checkmarx' | head -40

# Egress evidence — the single most decisive artefact if it exists:
sudo grep -rniE 'models\.litellm\.cloud|checkmarx\.zone' \
  /var/log /etc/hosts 2>/dev/null | head -20
```

If a firewall, proxy or DNS resolver keeps logs, query them for `models.litellm.cloud` and
`checkmarx.zone` from `2026-03-24` onward. That is where the answer actually lives.

- **CLEAN LOOKS LIKE:** no reference to either domain anywhere, and a `docker pull` timestamp outside
  the incident window.
- **A HIT LOOKS LIKE:** any DNS lookup, connection, or log line for `models.litellm.cloud` or
  `checkmarx.zone`. A **successful POST to `models.litellm.cloud`** upgrades this from *possible* to
  **confirmed exfiltration**, and makes credential rotation mandatory rather than precautionary.
- **ON A HIT:** **STOP.** §"On any HIT", and treat every credential on the host as *known* leaked, not
  *possibly* leaked.
- **PITFALL:** `docker events` is **not persistent across daemon restarts** and journald retention is
  often 1–4 weeks. Five months after the incident, **"no logs" is the most likely outcome and must be
  recorded as `NO LOGS`, never as `CLEAN`.** Absence of evidence is not evidence here.

---

## Step 11 — Kubernetes (only if this host is part of a cluster)

Skip and mark **N/A** if the gateway runs under plain Docker Compose — which the evidence suggests it
does.

```bash
kubectl get pods -A | grep -i 'node-setup-'
kubectl get pods -n kube-system -o json 2>/dev/null \
  | grep -E '"hostPID": true|"privileged": true|node-setup' | head -20
kubectl get daemonsets -A 2>/dev/null | grep -i 'node-setup'
```

- **CLEAN LOOKS LIKE:** no output from any command.
- **A HIT LOOKS LIKE:** any pod named `node-setup-*` in `kube-system`, typically with a container
  named `setup` running `alpine:latest`, `hostPID: true`, `hostNetwork: true`, privileged, and a
  host-root mount — on **every** node.
- **ON A HIT:** **STOP.** This is a cluster-wide incident, materially worse than a single-host one:
  the malware reads **all secrets in all namespaces**. §"On any HIT", scoped to the whole cluster.

---

# ON ANY HIT — the decision rule, stated plainly

> ## If step 3, 4, 5, 6, 7, 8, 9, 10 or 11 returns a positive indicator:
>
> ### 1. The OCR architecture process **STOPS**.
> No further design work on the gateway integration. Gate 1 returns `FAIL`. M0.5 halts for this
> dimension.
>
> ### 2. **No credential is accepted from this host.** Not a scoped one. Not a temporary one. Not a
> "just for testing" one. The issuing control plane is under the attacker's reach; a narrower key from
> a compromised issuer is still a compromised key.
>
> ### 3. Do **not** clean in place.
> Deleting `litellm_init.pth` and downgrading LiteLLM removes the *loader* and leaves the *implant*.
> `~/.config/sysmon/sysmon.py` polls `https://checkmarx.zone/raw` for arbitrary binaries, so
> **additional, unrelated second-stage payloads may have been delivered in the months since March.**
> A version check does not clear a host that polled C2 for days. **Rebuild from a known-good image.**
>
> ### 4. Rotate everything on this host, on this SLA:
> - **within 4 hours** — revoke every LiteLLM virtual key **and** the master key;
> - **within 24 hours** — rotate every upstream model-provider API key the gateway holds; the
>   gateway's own DB credentials; **INNOVERA Chat's** `CHAT_POSTGRES_PASSWORD`, `CLERK_SECRET_KEY` and
>   `DATABASE_URL`; all host SSH keys and every `authorized_keys` entry; Docker registry credentials;
>   every cloud credential reachable from the host including anything obtainable via IMDSv2; and any
>   secret that ever appeared in shell history on this host;
> - **within 72 hours** — rebuild the host from a known-good image.
>
> ### 5. Preserve evidence before rebuilding.
> Copy (do not move) `sysmon.py`, the `sysmon.service` unit, any `litellm_init.pth`, and the relevant
> log excerpts. Record `sha256sum` of each. Rebuilding destroys the only forensic record.
>
> ### 6. Only after the rebuild, re-run this runbook from step 1 against the new host.
> Evidence from the compromised host is not carried forward.

---

# ON AN ALL-CLEAR

Send back the completed form from §0. Gate 1 then records three values —
`LITELLM_ATTESTED_VERSION`, `LITELLM_ATTESTED_AT`, `LITELLM_ATTESTED_IMAGE_DIGEST` — flips
`GATE1_CREDENTIAL_ISSUANCE` from `BLOCKED` to `ALLOWED`, and the OCR project requests a
**least-privilege LiteLLM virtual key** (never the master key, mirroring the convention INNOVERA Chat
already uses).

**The attestation expires after 90 days, and is voided immediately by any change to the image
digest** — i.e. the next time the gateway is upgraded, steps 2, 3 and 4 are re-run. Expiry blocks
*new* credential issuance and raises an alert; it does **not** sever a working integration.

---

# Quick reference — the IOC card

| What | Value |
|---|---|
| Bad versions | `1.82.7`, `1.82.8` |
| Safe versions | `<= 1.82.6` (conditional), `>= 1.83.0` (preferred) |
| Malicious file | `litellm_init.pth`, **34,628 bytes** |
| SHA-256 (hex — compare in this form) | `71e35aef03099cd1f2d6446734273025a163597de93912df321ef118bf135238` |
| Same digest, base64url (do not compare across encodings) | `ceNa7wMJnNHy1kRnNCcwJaFjWX3pORLfMh7xGL8TUjg` |
| 1.82.8 wheel SHA-256 | `d2a0d5f564628773b6af7b9c11f6b86531a875bd2d186d7081ab62748a800ebb` |
| Exfil endpoint | `https://models.litellm.cloud/` (**not** `litellm.ai`) |
| C2 poll | `https://checkmarx.zone/raw` |
| Persistence | `~/.config/sysmon/sysmon.py`, `~/.config/systemd/user/sysmon.service` ("System Telemetry Service") |
| Staging | `/tmp/tpcp.tar.gz`, `/tmp/session.key`, `/tmp/session.key.enc`, `/tmp/payload.enc` |
| K8s | pods `node-setup-*` in `kube-system`, container `setup`, `alpine:latest`, privileged |
| Attribution | RSA pubkey prefix `MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAvahaZDo8mucujrT15ry+` (TeamPCP) |
| Incident window for image dates | `2026-03-24T10:39:00Z` … `2026-03-31T00:00:00Z` |
| `.pth` anomaly threshold | any `site-packages` `.pth` **> 1,024 bytes** — read it |

Full context and the eight-part decision records: `gate-1-litellm-supply-chain.md`.
Canonical values: `gate-1-litellm-supply-chain.md §CANONICAL VALUES` — cite, do not restate.
