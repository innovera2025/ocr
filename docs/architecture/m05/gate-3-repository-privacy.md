---
dimension: gate-3-repository-privacy
title: "Gate 3 — Repository Privacy, Access Control and CI Supply-Chain Governance"
status: canonical
date: 2026-09-09
supersedes:
  - docs/architecture/m0/j-security-threat-model.md §10.1 (registry/lockfile controls — the CI-side half only; the dependency and model-weight controls in §10.2–§10.4 remain owned by j)
  - docs/architecture/m0/j-security-threat-model.md §12.1 (the repository-side secret controls: .gitignore, gitleaks, push protection. Runtime secrets in §12.2–§12.4 remain owned by j)
  - docs/architecture/m0/a-environment-and-stack.md §11 open question 10 ("Is there an existing INNOVERA git org convention…") — answered here, closed
  - docs/architecture/m0/a-environment-and-stack.md Q5 (repository name) — answered here, closed
owns:
  - Repository name, topology and directory layout
  - GitHub account/org model, plan, teams, roles, 2FA
  - Branch and tag rulesets
  - Secret-scanning layers and the git hook contract
  - GitHub Actions permission model, action pinning, environments
  - CI artifact/log privacy rules and fixture policy
  - Retro-remediation posture for the 15 existing public repositories
does_not_own:
  - The `ocr_live_` API key format (owned by j-security-threat-model.md §8, §12.3) — cited, never restated
  - Runtime secret injection, Zod env boundary, rotation (j §12.2, §12.4)
  - Dependency update cadence and the two-lane SLA (j §10.2)
  - OCR model-weight hashing and `.pth` pickle controls (j §10.3)
  - Container hardening (j §10.4, m-docker-nginx-resources.md)
---

# Gate 3 — Repository Privacy

> **Integration status (2026-09-12):** Read the [architecture index](../README.md) and its consolidation report before using these examples. Individual review labels do not close cross-document conflicts; no application implementation is verified.

**DOCUMENT ONLY. Nothing in this file has been created, enabled, purchased or configured.**
No repository was created. No organization was created. No GitHub setting was changed. No
package was installed. Every `gh` call made while producing this document was a **read**
(`gh api … GET`, `gh repo list`, `gh auth status`).

---

## 0. Why this gate exists, in one paragraph

INNOVERA owns **15 repositories. All 15 are PUBLIC** (verified this session — see §1.1). One of
them, `WeiWutichai/innovera-chat`, is the production client of the AI gateway this product will
also consume, and it publicly discloses the gateway's env-var contract, the shared Docker network
name, the model's token ceiling, the full timeout budget, the upload cap, the loopback port and the
complete deploy/backup/rollback script set. **No credential is exposed** — that matters and §9 says
so plainly — but the architecture is. INNOVERA OCR AI will process **Thai national identity
documents**. Inheriting the public-by-default habit from a personal-account estate into a repository
that will hold ID-document fixtures, extraction schemas, PDPA deletion logic and an AI gateway
virtual key is the single cheapest catastrophic mistake available in M1.

Second reason: **the LiteLLM compromise of March 2026 arrived through CI, not through code.** The
same gateway software this product depends on was poisoned because its pipeline installed a security
scanner by mutable tag. §7 treats that as a design input, not a news item.

---

## 1. Verified ground truth

### 1.1 The estate (read via `gh` this session, 2026-09-09)

| Account | Repo | Visibility | Default branch | Last push |
|---|---|---|---|---|
| WeiWutichai | `pguard` | **PUBLIC** | main | 2026-09-09 |
| WeiWutichai | `innovera-chat` | **PUBLIC** | main | 2026-09-01 |
| WeiWutichai | `innovera-plan` | **PUBLIC** | main | 2026-07-21 |
| WeiWutichai | `Maxtech-Backend` | **PUBLIC** | *(empty — no default branch)* | 2026-07-21 |
| WeiWutichai | `Maxtech-Frontend` | **PUBLIC** | *(empty — no default branch)* | 2026-07-21 |
| WeiWutichai | `Innovera` | **PUBLIC** | main | 2026-07-15 |
| WeiWutichai | `guard-dispatch` | **PUBLIC** | main | 2026-06-03 |
| WeiWutichai | `focus-media-api-hub` | **PUBLIC** | main | 2026-04-22 |
| innovera2025 | `tcl` | **PUBLIC** | main | 2026-09-08 |
| innovera2025 | `juneflow` | **PUBLIC** | dev | 2026-09-05 |
| innovera2025 | `krs-pos` | **PUBLIC** | main | 2026-07-30 |
| innovera2025 | `orderstock` | **PUBLIC** | main | 2026-07-26 |
| innovera2025 | `temple` | **PUBLIC** | main | 2026-06-16 |
| innovera2025 | `docketlaw` | **PUBLIC** | main | 2026-05-29 |
| innovera2025 | `SRMS` | **PUBLIC** | main | 2026-05-20 |

`gh api user/orgs` for the active account returns **empty**. **There is no GitHub organization
today.** Both accounts are personal, both hold `repo`, `workflow`, `gist`, `read:org` token scopes,
and both are logged in on this workstation simultaneously.

### 1.2 House CI conventions (read this session)

| Repo | Workflows | Action pinning | Default `permissions` |
|---|---|---|---|
| `~/Documents/jawbong` (house target stack) | `.github/workflows/ci.yml` | **Full 40-char SHA** — `actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803`, `pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1`, `actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38` | **absent** (inherits repo default) |
| `WeiWutichai/pguard` | `ci.yml`, `deploy.yml` | **Mutable tags** — `actions/checkout@v4` ×8, plus third-party `Swatinem/rust-cache@v2`, `taiki-e/install-action@v2`, `subosito/flutter-action@v2`, `pnpm/action-setup@v4`, `actions/setup-node@v4` | `permissions: contents: read` at top level; `packages: write` widened per-job in `deploy.yml` |
| `WeiWutichai/innovera-chat` | **none** (`.github/workflows` returns 404) | n/a | n/a |
| `innovera2025/tcl`, `innovera2025/juneflow` | `ci.yml` | not inspected | not inspected |

**Finding H-1 (house drift):** jawbong pins action SHAs; pguard does not. pguard's `deploy.yml`
pushes 14 images to `ghcr.io` with `packages: write` while resolving `actions/checkout` by a mutable
tag. That is precisely the topology the Trivy→LiteLLM chain exploited. Gate 3 adopts **jawbong's**
convention, not pguard's, and §9 recommends back-porting it.

**Finding H-2 (good prior art to reuse):** `innovera-chat` ships `.githooks/pre-push` — a versioned,
committed hook enabled with `git config core.hooksPath .githooks`. Its own header states the design
rationale verbatim: *"This is the SECOND layer of protection, not the first… that setting is local
config: a fresh clone, a reset .git/config, or a re-added remote would silently lose it, while this
file is versioned and travels with the repository."* It also states it *"contains no host, no
credential and no production identifier, so it is safe to commit."* **This is the correct pattern and
§6.3 reuses it verbatim, extending the directory rather than inventing a new mechanism.**

**Finding H-3:** `innovera-chat/.gitignore` ignores `.env*` with no un-ignore exception; jawbong's
ignores `.env*` but un-ignores `!.env.example` and `!.env.test.example`. Gate 3 follows jawbong
(names committed, values never) — consistent with j-security-threat-model.md §12.1.

### 1.3 GitHub platform facts verified by web research this session

| Fact | Status | Consequence |
|---|---|---|
| Branch protection rules **and rulesets are not enforced on private repositories under GitHub Free** (org or personal). Rulesets are available on public repos on Free, and on public **and private** repos on Pro / Team / Enterprise Cloud. | VERIFIED (GitHub Docs + community discussions #190190, #174419, #198686, 2026) | **This is the decisive fact of §3.** A free private repo has *zero* enforceable branch protection. Private + Free = an unprotected `main`. |
| Secret-scanning **push protection is free for public repositories only**. Private/internal repositories require **GitHub Secret Protection**, billed **per active committer**. | VERIFIED (GitHub Changelog 2026-07-15; GitHub Secret Protection product page) | Going private *loses* the free push-protection net. §6 restores it with tooling that does not depend on plan. |
| GitHub Secret Protection list price **$19 / active committer / month**; GitHub Code Security **$30 / active committer / month**; both purchasable on the **Team** plan. | VERIFIED (multiple 2026 pricing analyses) | §6.2 costs this explicitly. |
| GitHub **Team** list price **$4 / user / month** billed annually (**$3.67** with annual prepayment). | VERIFIED (2026 pricing sources) | §2.3 costs this explicitly. |
| **Dependabot** alerts, security updates and version updates are **free on private repositories under any paid plan**; must be explicitly enabled per-repo (dependency graph first). | VERIFIED (GitHub Docs 2026) | §6.4 — no incremental cost. |
| **SAML SSO** requires GitHub **Enterprise Cloud**, not Team. | VERIFIED | §2.5 specifies 2FA enforcement, **not** SSO. Claiming SSO on Team would be false. |
| Org REST fields exist: `members_can_create_public_repositories`, `members_can_create_private_repositories`, `members_can_create_repositories`, `members_allowed_repository_creation_type`, `default_repository_permission`. | VERIFIED (GitHub REST `PATCH /orgs/{org}`) | §3 names the machine-verifiable field for every UI toggle, so the setting can be asserted by script rather than by screenshot. |

### 1.4 The LiteLLM supply-chain compromise — the facts that drive §7

VERIFIED via multiple independent 2026 reports (Trend Micro research, SecurityWeek, CloudSEK,
CPO Magazine, SOCRadar, cybersecuritynews, hackread):

1. **2026-03-24**: the actor "TeamPCP" published malicious LiteLLM **1.82.7** and **1.82.8** to
   PyPI using compromised credentials. Live for **~40 minutes**.
2. Root cause was **upstream of LiteLLM**: Aqua Security's **Trivy** scanner was compromised first.
   A leaked **automation token was rotated but not fully revoked**, leaving an **~20-day window** in
   which the attacker **force-pushed malicious code over the scanner's published version tags**.
3. **LiteLLM's CI installed Trivy without pinning a version**, so its build pulled the poisoned tag
   automatically and shipped the result to PyPI.
4. Payload: three stages — credential harvesting, Kubernetes lateral movement, persistent RCE
   backdoor — executing **on every Python invocation**, targeting cloud credentials, SSH keys and
   Kubernetes clusters.
5. Blast radius: **2,500+ organisations, 434,000+ CI/CD pipelines**.

**Four design rules fall straight out of this, and §7 enforces all four:**

- **R1 — A version tag is not an identity.** Anything CI resolves — GitHub Actions, container base
  images, security scanners, CLI tools — is pinned by **immutable digest/SHA**, never by tag.
- **R2 — Rotation is not revocation.** Every credential retirement in this product is a **revoke**,
  and the runbook proves the old value is dead, not merely superseded.
- **R3 — A publish window of 40 minutes defeats human review but not a cooling-off timer.** §7.6
  sets a **4320-minute (3-day) `minimumReleaseAge`** on the npm side. Nothing published in the last
  72 hours can enter a build. The poisoned LiteLLM versions existed for 0.7 hours.
- **R4 — Published tags must be immutable in *our* repo too.** §5.3 adds a tag ruleset that
  forbids updating or deleting `v*`. The attack's mechanism was a force-push over a published tag;
  we are not going to leave that door open on our own releases.

---

## 2. Decision D3.1 — Account model: a GitHub Organization, on the Team plan

**Competing proposals**
- **P1** Keep the status quo: create `innovera-ocr` under `innovera2025` (personal, Free).
- **P2** Create it under `WeiWutichai` (personal, Free) — the account that already owns `innovera-chat`.
- **P3** Personal account on **GitHub Pro** ($4/mo, one seat) — buys private-repo rulesets without an org.
- **P4** Create a **GitHub Organization** on the **Free** plan, own the repo there.
- **P5** Create a **GitHub Organization** on the **Team** plan. ← selected

**Selected: P5 — a GitHub Organization on the Team plan.**

**Rejected, with reasons**

- **P1 / P2 rejected — private + Free = no branch protection.** §1.3: rulesets are not enforced on
  private repositories under GitHub Free. A private repo on a free personal account has an
  unprotected `main`: force-pushable, deletable, mergeable with no review and no required checks.
  For a repository holding Thai ID-document extraction logic that is not a trade-off, it is an
  absence of control.
- **P1 / P2 also rejected — the two-personal-account split is itself the finding.** A personal
  account cannot be governed, audited or offboarded. If `WeiWutichai` becomes unavailable,
  `innovera-chat` — the production Chat client — becomes unavailable with it, and no one else can
  transfer it. There is no org audit log, no team, no base-permission floor, no enforceable 2FA
  policy, and no way to answer "who has access to what" other than by asking the account holder.
  Two accounts means the answer is asked twice and reconciled by hand. **Bus factor = 1 per account,
  and offboarding is impossible by construction.**
- **P3 rejected — Pro fixes rulesets but not governance.** Pro gives one person private-repo
  rulesets. It gives no teams, no base permissions, no org audit log, no org-wide 2FA requirement,
  no Actions allowlist, no per-org artifact-retention setting, and no path to a second engineer. It
  solves the cheapest half of the problem and leaves the structural half.
- **P4 rejected — Free org still cannot enforce rulesets on private repos.** A Free org buys the
  governance surface (teams, base permissions, member-privilege toggles, Actions policy) but leaves
  `main` unprotected, which is the control the gate exists to obtain. Free org is strictly worse than
  Team for **$4/user/month**.

**Reason (positive case for P5).** Team is the cheapest plan on which *all* of the following are
simultaneously true: private repositories, enforced rulesets on private repositories, teams and
role-based access, `default_repository_permission = none`, org-level Actions policy and artifact
retention, org audit log, enforced 2FA, and the *option* to add Secret Protection later without a
migration.

**Implementation consequence.** Create org `innovera-th` (**OWNER-BLOCKED (B-3.1)** — name
availability). Subscribe to Team, **3 seats**. Create `innovera-th/innovera-ocr` **private**. Do not
create the repo under either personal account even temporarily — a repo created public, even for one
minute, is indexed, and "we made it private later" is not a remediation.

**Migration consequence.** The 15 existing repos are **transferred**, not re-pushed (§9). Transfer
preserves history, issues, stars and installs a permanent redirect from the old path, so existing
clones keep working. Re-pushing loses all of that and orphans every clone. Transfer is a one-way
door per repo: plan the order, do the low-traffic ones first.

**Security consequence.** Access becomes revocable centrally. Removing a person from the org removes
every grant at once. The org audit log records visibility changes, ruleset edits, and member-role
changes — none of which exist today.

**Config/env consequence.** Every clone URL, every `git remote`, every CI `github.repository`
reference and every `ghcr.io/<owner>/…` image path becomes `innovera-th/…`. Because the org does not
exist yet and no code has been written, **this costs nothing today and would cost a coordinated
migration at M3.** That timing is the whole argument for doing it in M0.5.

**Cost, numerically.** Team: **3 seats × $4.00 = $12.00/month = $144.00/year** at list, or **$132.12/year**
with annual prepayment ($3.67/seat/mo). This is the entire additional spend that D3.1 requires;
Secret Protection is a separate, optional decision (§6.2).

---

## 3. Decision D3.2 — Repository topology: one private monorepo

**Competing proposals**
- **P1** Three repos: `ocr-web` / `ocr-worker` / `ocr-infra`.
- **P2** Two repos: `innovera-ocr` (Next.js app) + `innovera-ocr-worker` (Python).
- **P3** One repo, `innovera-ocr`, polyglot monorepo. ← selected
- **P4** One repo plus a separate private `innovera-ocr-fixtures` for test documents.

**Selected: P3 — a single private polyglot monorepo named `innovera-ocr`.**

**Naming.** `innovera-ocr`. It matches the two existing product repos in the estate — `innovera-chat`
and `innovera-plan` — which is the house convention: `innovera-<product-noun>`, lowercase, single
hyphen, no marketing suffix. Rejected `ocr` (unqualified, collides in any namespace),
`innovera-ocr-ai` (the product is *INNOVERA OCR AI*, but house repo names carry the noun, not the
brandline — `innovera-chat` is not `innovera-chat-ai`), and `INNOVERA-OCR` (the estate contains
`Innovera`, `Maxtech-Backend`, `SRMS` in mixed case; pguard's own `deploy.yml` contains a
"Compute lowercase image prefix" step precisely because GHCR rejects an uppercase repository path —
a mixed-case name creates that workaround on day one).

**Rejected, with reasons**

- **P1/P2 rejected — the web↔worker contract cannot change atomically across repos.** The queue
  message shape, the document state machine and the extraction result schema are a *single contract*
  consumed by a TypeScript app and a Python worker. Split across repos, every contract change is two
  PRs merged in an order nobody can enforce, plus a compatibility window that exists only because of
  the repo boundary. In one repo it is one PR, one review, one CI run that type-checks both sides.
- **P1/P2 rejected — house evidence is monorepo.** `pguard` holds **11 Rust services + a Node
  mediasoup SFU + a Next.js admin + a custom Postgres image** in one repo with a matrix build.
  `jawbong` is a single-repo pnpm workspace (`pnpm-workspace.yaml: packages: ["."]`). The estate has
  exactly one split — `Maxtech-Backend` / `Maxtech-Frontend` — and **both of those repos currently
  have an empty default branch**, which is not an endorsement.
- **P1/P2 rejected — cost of governance multiplies, benefit does not.** Every ruleset, CODEOWNERS
  file, Dependabot config, artifact-retention setting, Actions allowlist and environment protection
  rule is authored once per repo. Three repos means three chances for one of them to drift open.
  Note the *seat* cost does not multiply — Team and Secret Protection bill per user/committer, not
  per repository — so there is no cost argument in the other direction either.
- **P4 rejected — a fixtures repo implies real documents exist somewhere in git.** §8 forbids that
  outright. Fixtures are **generated** by a committed script from synthetic inputs; a repository
  whose purpose is to hold document files is a repository that will eventually hold a real one.

**Implementation consequence.** Layout, fixed here so every downstream document cites one shape:

```
innovera-ocr/                     # private, org-owned, single repo
├── .github/
│   ├── workflows/                # ci.yml, deploy.yml — see §7
│   ├── dependabot.yml            # cadence cited from j §10.2, not restated
│   └── CODEOWNERS
├── .githooks/                    # pre-commit, pre-push — §6.3 (pattern from innovera-chat)
├── apps/web/                     # Next.js 16 App Router (house stack)
├── services/worker/              # Python OCR worker
├── packages/contracts/           # the shared queue + result schema (Zod ⇄ generated JSON Schema)
├── infra/                        # Dockerfiles, compose, nginx vhost
├── prisma/                       # schema + migrations
├── tests/fixtures/               # SYNTHETIC ONLY, manifest-enforced — §8.2
├── scripts/fixtures/generate.ts  # the ONLY producer of tests/fixtures/**
└── docs/architecture/            # this corpus, moved in at bootstrap
```

`pnpm-workspace.yaml` lists `apps/*`, `packages/*`. The Python worker is **not** a pnpm workspace
member; it is built by its own Dockerfile with a hash-locked requirements file (format owned by
j §10.1 — cited, not restated here).

**Migration consequence.** A monorepo can be split later (`git subtree split` preserves history);
three repos cannot be merged later without losing linear history or rewriting it. The reversible
direction is the one selected.

**Security consequence.** One blast radius: a compromised write credential reaches everything. This
is accepted and mitigated by §5 (no bypass on `main`, required checks) and §7 (read-only
`GITHUB_TOKEN`, environment gates), which are the controls that actually bound a compromised
credential. A three-repo split does not bound it either — the same person holds all three grants.

**Config/env consequence.** `github.repository` = `innovera-th/innovera-ocr`. Image paths become
`ghcr.io/innovera-th/innovera-ocr/<service>:<sha>`. CI paths are filtered per job
(`paths: ['apps/web/**', 'packages/**']` vs `paths: ['services/worker/**']`) so a Python-only change
does not run Playwright.

---

## 4. Decision D3.3 — Org settings that make a public repository impossible to create

**Competing proposals**
- **P1** Set the repo private and rely on discipline.
- **P2** Set the repo private + set the org's *default* repository visibility to private.
- **P3** Set the repo private + remove the **ability** for members to create public repos at all, and
  remove the ability to change visibility or delete/transfer. ← selected

**Selected: P3.** A default is a suggestion; a removed capability is a control.

**The exact settings. UI path, then the machine-verifiable REST field.**

| # | UI: Organization → Settings → … | REST field on `PATCH /orgs/{org}` | Value |
|---|---|---|---|
| 1 | **Access → Member privileges → Repository creation** → uncheck **Public** | **`members_can_create_public_repositories`** | **`false`** ← *the setting the brief asks for by name* |
| 2 | Access → Member privileges → Repository creation → keep **Private** checked | `members_can_create_private_repositories` | `true` |
| 3 | Access → Member privileges → Repository creation → members may create repos | `members_can_create_repositories` | `true` |
| 4 | Access → Member privileges → Repository creation (legacy composite) | `members_allowed_repository_creation_type` | `"private"` |
| 5 | Access → Member privileges → **Base permissions** | **`default_repository_permission`** | **`"none"`** |
| 6 | Access → Member privileges → **Repository visibility change** → uncheck "Allow members to change repository visibilities for this organization" | *(no REST field; UI/audit-log verified)* | disabled |
| 7 | Access → Member privileges → **Repository deletion and transfer** → uncheck "Allow members to delete or transfer repositories for this organization" | `members_can_delete_repositories` | `false` |
| 8 | Access → Member privileges → **Repository forking** → do **not** allow forking of private repositories | `members_can_fork_private_repositories` | `false` |
| 9 | Access → Member privileges → Pages creation | — | disable public Pages |
| 10 | Security → **Authentication security** → "Require two-factor authentication for everyone in the … organization" | *(UI)* | **enabled** |

**Reason for #5 = `none`, not `read`.** `read` grants every org member read access to every
repository automatically. In an org that will hold ID-document extraction logic, the default answer
to "can this person read this repo?" must be *no*, with access arriving only through explicit team
membership. `none` makes team membership the single source of truth for access; `read` makes it a
second source that silently overrides the first.

**Reason for #6 and #7.** With `members_can_create_public_repositories = false` still in force, a
member could otherwise create a private repo and immediately flip it public, or transfer it to a
personal account where no policy applies. Setting #1 without #6 and #7 is a lock on the front door
with the window open.

**Reason for #8.** A fork of a private repo is a second copy under weaker governance whose ruleset,
retention and access list are not the org's. There is no legitimate fork workflow in a 3-person
internal product.

**Implementation consequence.** Ten toggles, ~15 minutes, done **before** the first repository is
created. A committed script (`scripts/audit-org-settings.sh`) re-asserts fields 1,2,3,4,5,7,8 via
`gh api /orgs/innovera-th` and exits non-zero on drift; run it in the weekly CI cron. Fields 6, 9
and 10 have no REST getter and are verified by a **quarterly manual screenshot** attached to the
security review, plus an audit-log query for `org.update_member_privileges` events.

**Migration consequence.** Applying #5 (`none`) *after* repos are transferred silently removes access
people currently have. Order matters: apply #5 **first**, create the teams (§4.1), then transfer.

**Security consequence.** The failure mode this closes is the one that produced today's estate: a
repository created public by default, by habit, at 11 p.m. It becomes impossible rather than
discouraged.

**Config/env consequence.** None in the application. The org settings are infrastructure state and
are represented in the repo only by the audit script and its expected-values JSON.

### 4.1 Teams, roles and who can admin

| Team | Repo role | Members | Can they… |
|---|---|---|---|
| `ocr-maintainers` | **Maintain** | 2 | edit repo settings, manage topics, manage some security settings. **Cannot** delete the repo, **cannot** change visibility, **cannot** edit rulesets. |
| `ocr-developers` | **Write** | 0 today; N contractors later | push to branches, open PRs. Cannot merge to `main` except through the ruleset. |
| `ocr-audit` | **Read** | 0 today; auditor/counsel later | read only. Used for the PDPA counsel engagement (j §16.1 B8). |

- **Org Owners: exactly 2.** Not 1 — a single owner is an account-lockout outage with no recovery
  path. Not 3+ — an owner can flip visibility, edit rulesets and bypass everything, so the count is
  the real blast radius. **2 is the minimum that survives one lost device.**
- **Repository role `Admin`: granted to nobody.** Org owners already hold implicit admin. An explicit
  repo-admin grant is a standing capability to disable the ruleset; `Maintain` covers every legitimate
  day-to-day need and cannot.
- **2FA:** enforced org-wide (#10). Members without 2FA are removed by GitHub on enablement — check
  the roster before enabling. **SSO/SAML is NOT available on Team** (§1.3); do not plan for it.
  Compensating control: both org owners use **hardware-backed passkeys** and hold a printed recovery
  code stored off-machine.
- **Personal access tokens:** org policy → Settings → Third-party access → **Personal access tokens →
  restrict access via fine-grained tokens: "Require approval"**; classic PATs: **"Do not allow"**.
  Reason: a classic PAT with `repo` scope is exactly what both accounts hold on this workstation today
  (verified in `gh auth status`), and it grants full access to every repo the user can see — the
  broadest credential in the estate.

**OWNER-BLOCKED (B-3.3)** — how many humans will commit to this repo. **Default if the owner stays
silent:** 2 owners, 2 maintainers (the same two people), 0 developers, 3 Team seats.

---

## 5. Decision D3.4 — Branch and tag rulesets

**Competing proposals**
- **P1** Legacy "branch protection rules".
- **P2** **Repository rulesets** targeting `main`, plus a second ruleset targeting `v*` tags. ← selected
- **P3** Rulesets defined at **org** level and applied to all repos.

**Selected: P2 now, with P3 as the M3 upgrade.** Rulesets supersede legacy branch protection, are
evaluable in the UI ("which rule blocked me?"), support tag targets — which legacy branch protection
cannot, and §5.3 needs — and are exportable as JSON so the configuration is reviewable. **P3 rejected
for now** only because it is one repo; org-level rulesets become correct the moment a second private
repo exists, and the JSON is portable.

### 5.1 Ruleset `main-protection` — target: default branch

| Rule | Value | Reason |
|---|---|---|
| Restrict deletions | **on** | `main` cannot be deleted. |
| Block force pushes | **on** | Non-negotiable. The Trivy compromise was **delivered by a force-push over published refs** (§1.4). |
| Require linear history | **on** | Squash-merge only. A bisect over `main` must be meaningful when an OCR regression appears 40 commits later. |
| Require a pull request before merging | **on** | No direct pushes to `main`, ever. |
| — Required approvals | **0 while committers < 2; 1 while committers = 2–4; 2 at ≥ 5** | Stated numerically because "require review" is meaningless on a solo repo: GitHub cannot count a self-approval, so a `1` today would make `main` unmergeable and the first response would be to add a bypass — which is how rulesets die. With approvals at 0 the ruleset **still enforces** required checks, linear history, no force-push and no deletion. |
| — Dismiss stale approvals on new push | **on** | An approval is of a diff, not of a branch name. |
| — Require review from Code Owners | **on** | See §5.2. |
| — Require conversation resolution | **on** | An unresolved review thread is an unanswered question. |
| Require status checks to pass | **on**, strict (branch must be up to date) | See §5.4 for the exact check names. |
| Require signed commits | **on** | 10-minute setup with SSH signing (`git config --global gpg.format ssh`). Given §1.4 — a credential holder force-pushing over refs — commit provenance is the cheapest control that survives a stolen token used from a different machine. |
| Require deployments to succeed | **off** | No staging environment exists in M1. Revisit at M4. |
| **Bypass list** | **EMPTY. Organization admin, repository admin and Deploy keys are NOT added.** | The brief asks "whether admins are included" — **admins are included, i.e. the rules apply to them.** A bypass entry for the only two people who commit turns the ruleset into documentation. |

**Emergency procedure (because a policy with no escape hatch gets disabled permanently instead of
temporarily):** an org owner adds themselves to the bypass list, performs the action, and removes
themselves. **Removal SLA: 24 hours.** Every step lands in the org audit log as
`repository_ruleset.update`, and a weekly CI cron asserts the bypass list is empty and fails loudly
if it is not.

### 5.2 CODEOWNERS

```
*                        @innovera-th/ocr-maintainers
/.github/                @innovera-th/ocr-maintainers
/.githooks/              @innovera-th/ocr-maintainers
/infra/                  @innovera-th/ocr-maintainers
/prisma/                 @innovera-th/ocr-maintainers
/packages/contracts/     @innovera-th/ocr-maintainers
/scripts/fixtures/       @innovera-th/ocr-maintainers
/tests/fixtures/         @innovera-th/ocr-maintainers
```

The four paths that matter beyond the wildcard: **CI definitions** (a workflow edit is a privilege
escalation), **git hooks** (deleting the pre-commit hook disables §6.3), **the shared contract**
(a silent shape change breaks the worker), and **fixtures** (the only place a real document could
enter the repo, §8.2).

### 5.3 Ruleset `tag-immutability` — target: tags matching `v*`

| Rule | Value |
|---|---|
| Restrict updates | **on** — a published tag cannot be moved |
| Restrict deletions | **on** |
| Restrict creations | **on**, bypass: `ocr-maintainers` only |
| Require signed tags (via required signatures) | **on** |

**This ruleset exists because of §1.4 point 2.** The Trivy compromise worked by **force-pushing
malicious code over already-published version tags**, so downstream builds pulling `v0.x` received
poisoned code that still looked legitimate. If `innovera-ocr` ever publishes a tag another system
resolves, that tag must be as immutable as we demand our own dependencies' tags be. Refusing to make
our tags immutable while pinning everyone else's by SHA is incoherent.

### 5.4 Required status checks (exact job names)

| Check | Job | Blocking |
|---|---|---|
| `verify` | typecheck · eslint `--max-warnings=0` · `depcruise` boundary · vitest · integration · build · Playwright (jawbong's `ci.yml` job name, reused verbatim) | yes |
| `secret-scan` | `gitleaks detect --redact --exit-code 1` over the full history | yes |
| `supply-chain` | `pnpm audit --prod` (fail on high/critical), lockfile-freshness assert, **action-pin assert** (§7.3), **`pull_request_target` assert** (§7.4) | yes |
| `privacy-guard` | fixture-manifest assert, 13-digit-number grep, artifact-upload grep (§8) | yes |
| `worker-verify` | ruff · mypy · pytest for `services/worker/**` | yes |

Five checks. **All five blocking.** A non-blocking security check is a notification, and the estate
already demonstrates what happens to notifications.

**Implementation consequence.** Rulesets are authored in the UI and exported to
`docs/ops/rulesets/main-protection.json` and `tag-immutability.json`; the weekly cron diffs live
against committed and fails on drift.

**Migration consequence.** Enabling `require linear history` after merge commits exist is fine
(it applies going forward), but enabling required checks on a repo whose CI does not yet emit those
job names blocks every PR. **Order: land `ci.yml` first, observe all five checks green on one PR,
then enable the ruleset.**

**Security consequence.** The window this closes: a stolen laptop with an authenticated `gh` session
can currently force-push to any of 15 repos and delete them. Post-gate it can open a PR.

**Config/env consequence.** Contributors must run `git config --global gpg.format ssh` and
`git config --global user.signingkey ~/.ssh/id_ed25519.pub`, and register the signing key on GitHub.
Documented in `CONTRIBUTING.md`; asserted by the pre-commit hook, which fails with that exact command
if signing is unconfigured.

---

## 6. Decision D3.5 — Secret scanning: three layers, only one of which costs money

**Competing proposals**
- **P1** Buy GitHub Secret Protection; rely on push protection.
- **P2** Free tooling only: gitleaks pre-commit + CI + periodic TruffleHog.
- **P3** **Both, layered — free tooling as the required control, Secret Protection as an optional
  platform net.** ← selected

**Selected: P3, with the free layers as the *blocking* controls.**

**Rejected P1 alone**, for two reasons. First, push protection fires at `git push` — after the secret
is already in local history, so remediation is a rebase rather than a "no". A pre-commit hook fires
before the object exists. Second, it is plan-coupled: the control would vanish if billing lapses.
**Rejected P2 alone** only in the sense that P2 is genuinely sufficient — see the OWNER-BLOCKED
default below.

### 6.1 The layers

| Layer | Tool | When | Latency | Blocking | Cost |
|---|---|---|---|---|---|
| L1 | `gitleaks protect --staged --redact` | `pre-commit` | < 1 s typical commit | **yes** | $0 |
| L2 | `gitleaks detect --redact` (full history) | CI `secret-scan` job on every PR | ~seconds | **yes** (required check) | $0 |
| L3 | `trufflehog git file://. --results=verified --fail` | weekly `schedule` cron + before any repo transfer (§9) | minutes | yes, on the cron | $0 |
| L4 | GitHub Secret Protection push protection + custom pattern | server-side, at push | — | yes | **$19/committer/mo** |

L3 uses TruffleHog rather than gitleaks specifically because it **verifies liveness** — it answers
"is this key still valid?", which is the only question that matters when deciding between "rotate and
revoke now" and "note and move on". L1/L2 use gitleaks because sub-second pattern matching is what a
pre-commit hook can afford.

**Custom rule for our own key format.** Both gitleaks (`.gitleaks.toml`) and, if purchased, a GitHub
custom secret-scanning pattern, carry a rule for the product's API key prefix. **That prefix is owned
by `j-security-threat-model.md` §8/§12.3 — see it there; it is deliberately not restated in this
document.** The regex in `.gitleaks.toml` must be generated from that document's canonical value at
bootstrap, not typed by hand, so the two cannot drift.

### 6.2 The money, stated plainly

**Secret Protection = $19 × 3 active committers = $57.00/month = $684.00/year**, on top of the
**$144.00/year** Team cost from §2. Total if both are bought: **$828.00/year**.

**OWNER-BLOCKED (B-3.2)** — buy GitHub Secret Protection?
**Default that ships if the owner stays silent: NO.** L1–L3 are enabled, blocking, and free; they
catch the same secrets earlier in the loop. Revisit at the first of: (a) a fourth committer,
(b) the first external contractor, (c) M3 (PDPA scope), or (d) any confirmed near-miss in L1/L2.
The decision is a one-click purchase on Team and requires no migration, which is exactly why it is
safe to defer.

### 6.3 The git hook contract — reusing `innovera-chat`'s pattern

`innovera-chat` already ships `.githooks/pre-push`, enabled with `git config core.hooksPath .githooks`,
and its header states the reasoning we adopt (§1.2, H-2): the hook is **versioned** so it survives a
fresh clone, unlike local config. `innovera-ocr` extends the same directory:

| Hook | Checks | Failure |
|---|---|---|
| `.githooks/pre-commit` | 1. `gitleaks protect --staged --redact` · 2. `.env` / `.env.*` / `*.pem` / `*.key` / `*.p12` / `id_rsa*` not staged (belt-and-braces over `.gitignore`) · 3. no staged binary > **256 KB** outside `tests/fixtures/` (which is manifest-checked separately) · 4. commit signing configured | exit 1, prints the exact remedy command |
| `.githooks/pre-push` | 1. **refuses any push to a remote named `production`** — copied from `innovera-chat` unchanged, including the `ALLOW_PRODUCTION_PUSH=1` escape · 2. `gitleaks detect` on the commits being pushed | exit 1 |

`git config core.hooksPath .githooks` is executed by `scripts/bootstrap.sh` and **asserted by CI**:
the `privacy-guard` job fails if `.githooks/pre-commit` is missing or non-executable. Note honestly
that CI cannot assert a *developer* has run the `git config` line — hooks are advisory by nature,
which is exactly why L2 (server-side, required check) exists behind L1.

### 6.4 Dependabot

`.github/dependabot.yml`, three ecosystems: `npm` (root workspace), `pip` (`services/worker`),
`docker` (`infra/docker`), **plus `github-actions`** — the last is the one most often forgotten and
is what keeps §7.3's pinned SHAs current instead of frozen. Alerts + security updates + version
updates: **free on private repos under Team** (§1.3), enabled per-repo after enabling the dependency
graph. **The two-lane cadence and the 7-day security-patch merge SLA are owned by
`j-security-threat-model.md` §10.2 — cited, not restated.**

**Implementation consequence.** Four files: `.gitleaks.toml`, `.githooks/{pre-commit,pre-push}`,
`.github/dependabot.yml`. Two CI jobs. Zero purchases under the default.

**Migration consequence.** L2 scans **full history**. Run it once at bootstrap on an empty repo so the
baseline is clean; running it first on a repo with history means triaging findings under merge
pressure.

**Security consequence.** The gap that remains under the default: a secret pushed from a machine
where `core.hooksPath` was never set reaches the remote and is caught by L2 at PR time — present in
the remote's object store, so remediation is **revoke first, then rewrite** (that ordering is owned
by j §12.1). Buying L4 closes exactly this gap and nothing else. That is the honest value of $684/yr.

**Config/env consequence.** `gitleaks` and `trufflehog` are pinned by version **and digest** in CI
(§7.3, rule R1 — a security scanner resolved by tag is literally the LiteLLM failure).

---

## 7. Decision D3.6 — GitHub Actions: the LiteLLM lesson, made structural

**Competing proposals**
- **P1** pguard's convention: top-level `contents: read`, actions pinned by tag.
- **P2** jawbong's convention: SHA-pinned actions, no explicit `permissions` block.
- **P3** **Both, plus org-level policy, plus environment gates, plus tool pinning.** ← selected

**Selected: P3.** P1 and P2 each hold one half of the control. §1.2 H-1 shows the estate contains
both halves in different repos, which is the same drift M0.5 exists to eliminate.

### 7.1 Org-level Actions policy (set once, before the repo exists)

| Setting: Organization → Settings → Actions → General | Value | Reason |
|---|---|---|
| Actions permissions | **"Allow enterprise, and select non-enterprise, actions and reusable workflows"** with an explicit allowlist | An unrestricted marketplace is an unrestricted dependency list. |
| Allowlist (**4 entries**) | `actions/*`, `pnpm/action-setup@*`, `docker/*`, `github/codeql-action/*` | Numeric and reviewable. A fifth entry is a PR to this document. |
| Workflow permissions | **"Read repository contents and packages permissions"** | Default `GITHUB_TOKEN` is **read-only**. A workflow that needs to write must say so. |
| "Allow GitHub Actions to create and approve pull requests" | **unchecked** | Otherwise a workflow can approve its own PR and satisfy §5.1's review requirement. |
| Fork pull request workflows from outside collaborators | **"Require approval for all outside collaborators"** | Moot today (no forks, §4 #8) but correct before the first contractor. |
| **Artifact and log retention** | **7 days** (default is 90) | §8.4. |

### 7.2 Per-workflow permission model

```yaml
# Top of EVERY workflow file. No exceptions.
permissions:
  contents: read
```

Widened **per job**, never at the top level:

| Job | `permissions` | Why |
|---|---|---|
| `verify`, `secret-scan`, `supply-chain`, `privacy-guard`, `worker-verify` | `contents: read` | Read-only CI. |
| `build-and-push` (deploy.yml) | `contents: read`, `packages: write`, `id-token: write` | GHCR push via `GITHUB_TOKEN`; OIDC for anything else. |
| `dependabot-automerge` (if adopted) | `contents: write`, `pull-requests: write` | Scoped to that job alone. |

pguard's `deploy.yml` already demonstrates this shape correctly (`permissions: contents: read` at
top, `packages: write` widened in the job). **That half of pguard's convention is adopted verbatim.**

### 7.3 Pinning — R1 from §1.4

**Every `uses:` is a full 40-character commit SHA with the human-readable version in a trailing
comment.** jawbong's convention, adopted:

```yaml
- uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803        # v5.x
- uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1       # v4.x
- uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38      # v4.x
```

Enforced by the `supply-chain` job:

```bash
# Fails on any `uses:` that is not a 40-hex SHA (local ./ actions excepted).
! grep -rhoE '^\s*(- )?uses:\s*[^ ]+' .github/workflows \
  | grep -vE 'uses:\s*\./' \
  | grep -vE 'uses:\s*[^@]+@[0-9a-f]{40}$'
```

**And the same rule applies to every tool the workflow installs — this is the actual LiteLLM
failure mode**, not the actions:

| Tool | Pinned as | Not |
|---|---|---|
| `gitleaks` | container digest `ghcr.io/gitleaks/gitleaks@sha256:…` | `:latest`, `:v8` |
| `trufflehog` | container digest | `:latest` |
| Trivy/Grype (image scanning, owned by j §10.4) | **digest** | `@v0` — **this exact substitution is what compromised LiteLLM** |
| `pnpm` | `11.18.0` (house pin) + `--frozen-lockfile` | `latest` |
| Node | `22.23.1` (house pin) | `lts/*` |
| Base images | `FROM …@sha256:…` (rule owned by j §10.1) | any tag |

**State it because the brief asks it to be stated: the LiteLLM compromise came through a poisoned
CI scanner.** LiteLLM's pipeline installed Trivy **unpinned**; a rotated-but-not-revoked automation
token let an attacker force-push malicious code over Trivy's published tags for ~20 days; LiteLLM's
build pulled a poisoned tag and shipped backdoored 1.82.7/1.82.8 to PyPI, reaching 2,500+
organisations and 434,000+ pipelines in a 40-minute publish window. **A security scanner is a
dependency with root in your build. Pin it like one.**

### 7.4 `pull_request_target` — forbidden outright

No workflow in `innovera-ocr` may use `pull_request_target`. Enforced:

```bash
! grep -rn 'pull_request_target' .github/workflows/
```

Reason: `pull_request_target` runs with the **base** repo's secrets and a **write-capable** token; if
combined with `actions/checkout` of `github.event.pull_request.head.sha`, untrusted PR code executes
with those secrets. It is the single most-exploited GitHub Actions pattern. We have no use case for
it (no forks, §4 #8), so the correct configuration is a grep, not a guideline.

### 7.5 Credentials: OIDC over long-lived secrets

- GHCR pushes use the job-scoped `GITHUB_TOKEN` with `packages: write`. **No PAT.**
- Any future cloud/registry auth uses **OIDC** (`permissions: id-token: write` + the provider's
  federated trust on `repo:innovera-th/innovera-ocr:environment:production`), not a stored
  long-lived key. An OIDC token lives minutes and is bound to the repo, ref and environment; a stored
  key lives until someone remembers it.
- **No secret is defined at repository scope.** All deploy secrets live on the `production`
  **environment**, so they are unreachable from a PR workflow.

### 7.6 `minimumReleaseAge` — R3 from §1.4

Set in `pnpm-workspace.yaml`: **`minimumReleaseAge: 4320`** (minutes = **3 days**).

**UNVERIFIED:** jawbong's `pnpm-workspace.yaml` declares `minimumReleaseAgeExclude` (for
`dependency-cruiser@18.1.1`, `tsx@4.23.5`) but the paired `minimumReleaseAge` key was not found in
`pnpm-workspace.yaml` or `.npmrc`; it may be set elsewhere or be vestigial. Either way, **this
document sets it explicitly**, because it is the one control that would have blocked the LiteLLM
attack outright: the malicious versions existed for **40 minutes**, against a 4320-minute floor. An
exclusion list entry requires a PR and a comment naming the reason and a review date.

*(Python-side equivalent — a fully hashed lockfile — is owned by `j-security-threat-model.md` §10.1.)*

### 7.7 Environment protection rules for deploy

Environment **`production`**:

| Rule | Value |
|---|---|
| Required reviewers | **1** (an org owner) |
| Wait timer | **5 minutes** |
| Deployment branches | **`main` only** (selected branches rule) |
| Secrets | scoped to this environment; **zero repo-level secrets** |

The 5-minute timer is not ceremony: it is the window in which a human who just noticed the wrong SHA
can cancel. `deploy.yml` uses `concurrency: { group: deploy-main, cancel-in-progress: false }` —
pguard's convention, adopted: never cancel an in-flight image push.

**Implementation consequence.** Two workflow files, four grep assertions in `supply-chain`, one
environment, six org toggles.

**Migration consequence.** SHA pins go stale. The `github-actions` Dependabot ecosystem (§6.4) opens
the bump PRs; without it, pinning degrades into "pinned to 2026 forever", which is a different
vulnerability wearing the same clothes.

**Security consequence.** A compromised third-party action, or a compromised CI tool, gets a
**read-only** token and no secrets in the PR-triggered path. That is the specific difference between
being inconvenienced by the next Trivy-class event and being LiteLLM.

**Config/env consequence.** `GITHUB_TOKEN` is read-only by default org-wide; any future workflow that
writes must declare it in a reviewed PR that touches `/.github/`, which CODEOWNERS routes to
`ocr-maintainers` (§5.2).

---

## 8. Decision D3.7 — Artifact and log privacy: no document content ever reaches CI

**Competing proposals**
- **P1** Redact/scrub CI logs and artifacts after the fact.
- **P2** **Ensure no real document, OCR text or PII can enter CI in the first place; treat scrubbing
  as the backstop, not the control.** ← selected

**Selected: P2.** Scrubbing is a filter over an untrusted stream; a synthetic-only corpus removes the
stream. A GitHub Actions log is retrievable by every org member with read access and by every
workflow; a Playwright trace embeds full DOM snapshots. There is no acceptable redaction story for a
Thai national ID rendered into a trace.

### 8.1 The rules

1. **No real document, no real OCR output, no real PII, no key material** in any CI log, artifact,
   cache, test fixture, snapshot, screenshot, trace, or issue attachment. No exceptions, no
   "temporarily for debugging".
2. **Test fixtures are synthetic and generated.** `tests/fixtures/**` is produced only by
   `scripts/fixtures/generate.ts` from committed synthetic Thai strings. CI asserts that every file
   under `tests/fixtures/` has a SHA-256 present in `tests/fixtures/MANIFEST.sha256`, and that the
   manifest is regenerable byte-identically from the script. A hand-dropped file fails the build.
3. **Thai national ID numbers.** Synthetic IDs are generated to pass the mod-11 check digit (the
   parser must accept them) but are drawn from a **fixed reserved generator seed** recorded in the
   manifest. CI greps for `\b\d{13}\b` **outside** `tests/fixtures/` and `docs/` and fails on any hit.
   The `privacy-guard` job also greps the *diff* of every PR for the same pattern.
4. **`actions/upload-artifact` is forbidden by default.** CI asserts it appears in **at most 1**
   workflow step:
   ```bash
   test "$(grep -rc 'actions/upload-artifact' .github/workflows | awk -F: '{s+=$2} END{print s+0}')" -le 1
   ```
   The one permitted step uploads `playwright-report/` with `retention-days: 1`, and **only on
   failure** (`if: failure()`).
5. **Playwright in CI:** `screenshot: 'off'`, `video: 'off'`, `trace: 'off'`. Locally,
   `trace: 'on-first-retry'` is fine — a developer's disk is not a shared artifact store.
   `playwright-report/` and `test-results/` are `.gitignore`d (jawbong already ignores both — adopted).
6. **No worker container is run against a real corpus in CI.** Benchmark runs against real Thai
   documents (j §16.2 U1, U20) happen on the owner's machine or the deploy host, and their **outputs
   are numbers, never text**: WER, latency, page counts. A benchmark that prints a recognised line is
   a benchmark that publishes a document.
7. **Log masking as backstop.** Every job that touches a secret emits `::add-mask::` for it. This is
   layer 2; layer 1 is that CI holds no secret capable of reading a real document (§7.5: no repo-level
   secrets).
8. **Binary guard.** CI fails on any file > **256 KB** added outside `tests/fixtures/`, `docs/` and
   `public/`, and on any `*.pdf|*.jpg|*.jpeg|*.png|*.tif|*.tiff` added outside those paths.
   Rationale: the realistic accident is not a leaked key, it is a PDF dragged into the repo to
   reproduce a bug.
9. **No Git LFS.** An LFS object survives a history rewrite because it lives in a separate store;
   "we removed it from history" would be false.
10. **Issue and PR hygiene.** A bug report attaches the **generated** reproducer, never the customer
    file. `.github/ISSUE_TEMPLATE/bug.yml` opens with that requirement as the first field.

### 8.2 Retention, numerically

| Surface | Retention | Set where |
|---|---|---|
| Actions **logs** | **7 days** | org Actions → Artifact and log retention |
| Actions **artifacts** | **7 days** org default; **1 day** on the single permitted upload step | org setting + `retention-days: 1` |
| Actions **caches** | GitHub default 7 days idle eviction; caches contain `pnpm` store + `~/.cargo`-class dirs only | — |
| Playwright report | uploaded only `if: failure()`, 1 day | `deploy`/`ci` workflow |

**Implementation consequence.** One CI job (`privacy-guard`), one generator script, one manifest, one
issue template, four grep assertions, one org retention setting.

**Migration consequence.** If a real document ever *does* land in history, removal requires a history
rewrite of a repo whose `main` forbids force-push — meaning: temporarily bypass (§5.1 emergency, 24h
SLA), rewrite, re-protect, and **notify every clone holder**, because their local copy still has it.
Cost measured in hours. That cost is the reason rule 8 exists as a machine check rather than a norm.

**Security consequence.** Under PDPA, a Thai ID in a CI log held for 90 days in a US-hosted log store
is a processing and cross-border-transfer question (owned by `j-security-threat-model.md` §9.6).
Rules 1–8 mean the question never has to be answered, which is materially cheaper than answering it.

**Config/env consequence.** `playwright.config.ts` branches on `process.env.CI` for the three capture
settings. No other application config changes.

---

## 9. Retro-remediation for the 15 existing public repositories

**Framed as a recommendation with effort and benefit, and accurate about what was actually found.**

### 9.1 What is actually exposed — and what is not

**No secret was found in `innovera-chat`.** Its `.gitignore` excludes `.env*` with no exception; its
`.githooks/pre-push` is written to be committable and says so in its own header ("contains no host,
no credential and no production identifier"). This document performed **no** credential extraction,
and by design did not read `.env` or `.env.example` anywhere.

What **is** public is **architecture**, which has reconnaissance value rather than credential value:

| Disclosed | Where |
|---|---|
| `LITELLM_BASE_URL`, `LITELLM_API_KEY` env contract, and that the key is a **virtual key** (not master) | `DEPLOYMENT.md` |
| Shared AI Docker network `AI_NETWORK_NAME`, default `innovera_default` | `DEPLOYMENT.md` / compose |
| LiteLLM is a **separate deployment on the same GPU host** (absent from Chat's compose) | `docker-compose.yml` |
| Model **65,536-token ceiling**; `CHAT_CONTEXT_CHAR_BUDGET=20000` | repo docs |
| Timeout budget: app 540,000 ms; NGINX 600 s | repo docs |
| `client_max_body_size 10M`; app on loopback **:3002**; NGINX terminates TLS | repo docs |
| Operational surface: `deploy.sh`, `rollback.sh`, `backup.sh`, `backup-retention.sh`, `bootstrap-db.sh`, `restore-rehearsal.sh` | `scripts/` |
| That a `production` git remote exists and is deliberately disabled | `.githooks/pre-push` |

Read together, that is a map: one host, one shared network, a database deliberately kept off it, and
a gateway holding a virtual key. **Nothing here is exploitable on its own.** It lowers the cost of
targeting the host if the host is ever found by other means. The correct response is proportionate,
not urgent.

Note also, in Chat's favour: it uses a **virtual key rather than the master key**, and it keeps
`chat-db` off the shared AI network with no published host port. Those are good decisions that this
product mirrors (topology ownership is `m-docker-nginx-resources.md`'s, not this document's).

### 9.2 Recommendations, ordered by benefit ÷ effort

| # | Action | Effort | Benefit | Notes |
|---|---|---|---|---|
| R1 | **Make `innovera-chat` private.** | **5 min** | **High** | Nothing to redact — no secret found. Removes the AI-topology map from public view and from search indexes and code-search datasets going forward. Caveat, stated honestly: **existing forks and third-party mirrors/caches are not retracted** by flipping visibility. Benefit is prospective, not retroactive — which is exactly why it should be done now rather than later. |
| R2 | **Run `trufflehog git file://<clone> --results=verified` across all 15 repos** before anything else. | **1 h** total | **High** | Verifies *liveness*, not just pattern shape. Decides whether R4 is ever needed. Do this before R3, because transferring a repo with a live key just moves it. |
| R3 | **Create the org and transfer all 15 repos into it** (§2). | **2–4 h** | **High** | Fixes bus-factor and offboarding, the two structural problems. Transfer (not re-push) preserves history, issues, stars and installs redirects so existing clones keep working. Set `default_repository_permission = none` and create teams **before** transferring (§4). |
| R4 | **Rewrite history — only if R2 finds a verified live credential.** | High | Situational | **Revoke first, then rewrite** (ordering owned by j §12.1). Rewriting alone is not remediation: the value already exists in clones, forks and CI logs. Do **not** rewrite history on a repo where R2 found nothing — the cost is real (every clone breaks) and the benefit is zero. |
| R5 | **Audit the other 14 for the same disclosure class.** Grep each for `LITELLM\|_BASE_URL\|_API_KEY\|innovera_default\|nginx\|GPU\|ssh`. | **4 h** | Medium | `innovera-plan` and `Innovera` are the likeliest to carry planning documents describing the same host. |
| R6 | **Back-port SHA-pinning to `pguard`** (§1.2 H-1). Its `deploy.yml` pushes 14 images to GHCR with `packages: write` while resolving `actions/checkout@v4` and four third-party actions by mutable tag. | **1–2 h** | **High** | This is the one *live* instance in the estate of the exact pattern that compromised LiteLLM. Highest security return per hour on this list. |
| R7 | **Archive or delete the dormant repos.** `Maxtech-Backend` and `Maxtech-Frontend` both report an **empty default branch**; `focus-media-api-hub` and `Innovera` have not been pushed since April/July. | **30 min** | Medium | An archived repo is read-only and its workflows cannot run — it removes CI attack surface without deleting history. |
| R8 | **Enable Dependabot alerts on all transferred repos.** | 15 min | Medium | Free under Team (§1.3); needs the dependency graph enabled per repo. |
| R9 | **Adopt `innovera-chat`'s `.githooks` pattern across the estate.** | 1 h | Medium | It already exists and is well-reasoned (§1.2 H-2). Add `pre-commit` + gitleaks alongside the existing `pre-push`. |

**Explicitly not recommended:** a public statement, a security advisory, or credential rotation
*triggered by this finding alone*. No credential was exposed. Rotating the LiteLLM virtual key is
still a good hygiene item on its own quarterly schedule (owned by j §12.4) — but it is not incident
response, and calling it that would misrepresent the finding.

### 9.3 What is out of scope for Gate 3

The gateway's own configuration, its LiteLLM version, whether it persists prompt/response bodies, and
whether the host is reachable from the internet are all **owner-blocked and unreachable from this
session** (j §16.1 B1–B6). Gate 3 governs *our repositories*. It cannot and does not assert anything
about the production host.

---

## 10. Owner-blocked items

| ID | Question | Blocks | Default that ships if the owner stays silent |
|---|---|---|---|
| **OWNER-BLOCKED (B-3.1)** | GitHub organization **name** (is `innovera` available?) and who holds billing. | §2, and every clone URL / image path. | Org **`innovera-th`**, **GitHub Team**, **3 seats** (`$144.00/yr` list), billed to the owner's existing GitHub payment method. Repo `innovera-th/innovera-ocr`, **private**. |
| **OWNER-BLOCKED (B-3.2)** | Purchase **GitHub Secret Protection** ($19/active committer/mo = **$684.00/yr** at 3 committers)? | §6.2 layer L4 only. | **NO.** Ship L1–L3 (gitleaks pre-commit + gitleaks CI + weekly verified TruffleHog), all blocking, all $0. Revisit at a 4th committer, the first contractor, M3, or any L1/L2 near-miss. |
| **OWNER-BLOCKED (B-3.3)** | How many humans will commit, and will any be external contractors? | §4.1 seat count; §5.1 required-approval count. | 2 org owners = 2 maintainers, 0 developers, 0 contractors. Required approvals **0** until a second independent committer exists, then **1**. |
| **OWNER-BLOCKED (B-3.4)** | Proceed with **R1** (make `innovera-chat` private) and **R3** (transfer all 15 repos)? Both change URLs other people may rely on. | §9 remediation only. Not a blocker for `innovera-ocr`. | Create the org and put **`innovera-ocr` alone** in it. Leave the 15 existing repos untouched pending an explicit decision. `innovera-ocr` is private and governed from commit #1 either way. |

---

## 11. Challenges to frozen values

Per the cardinal rule, deviations are raised rather than made silently. **This document deviates from
nothing it was given.** Two observations for the orchestrator's arbitration:

1. **`innovera-chat`'s `.githooks/pre-push` refuses pushes to a remote named `production`, and this
   product will have no `production` remote** (deploy is an image pull, not a git push). The hook is
   still adopted **unchanged** rather than "improved", because a hook that is identical across the
   estate is a hook people recognise, and its cost when the remote does not exist is zero. Flagging
   only so a reviewer does not later "clean it up" as dead code.

2. **§5.1 sets required approvals to `0` for the solo period, which reads like a weakened control.**
   It is not: the ruleset still enforces no-force-push, no-deletion, linear history, signed commits
   and five required status checks, none of which a solo committer can satisfy by self-approval
   anyway. Setting `1` on a one-person repo makes `main` unmergeable, and the first fix anyone
   reaches for is a bypass entry — which would disable *all* of the above, permanently. If the
   orchestrator prefers a hard `1`, the correct paired change is to seat a second committer in the
   same decision, not to set the number and hope.

---

## CANONICAL VALUES

Every value below is owned by this document. Other documents **cite** these; they must not restate
them. Values owned elsewhere (the `ocr_live_` key prefix, the dependency-update SLA, model-weight
hashing, container hardening, runtime secret injection) are deliberately absent — see the `does_not_own`
list in the YAML header.

| key | value | env var | reason | failure behaviour |
|---|---|---|---|---|
| `REPO_OWNER` | `innovera-th` *(OWNER-BLOCKED B-3.1 default)* | — | GitHub **organization**, not a personal account; personal accounts cannot be governed, audited or offboarded. | Repo created under a personal account ⇒ no teams, no base permissions, no enforceable 2FA, bus factor 1. Gate 3 fails. |
| `REPO_NAME` | `innovera-ocr` | — | House convention `innovera-<product-noun>`, matching `innovera-chat` / `innovera-plan`. Lowercase — GHCR rejects uppercase repository paths. | Mixed case ⇒ every image push needs pguard's "compute lowercase prefix" workaround. |
| `REPO_FULL` | `innovera-th/innovera-ocr` | `GITHUB_REPOSITORY` (CI-provided) | Single source for clone URL, `ghcr.io` path and OIDC subject. | Drift between docs ⇒ broken image paths and a failing OIDC trust policy. |
| `REPO_VISIBILITY` | `private` | — | Thai identity documents, extraction logic, PDPA deletion logic, AI gateway virtual key. | Public ⇒ the estate's existing failure mode, with ID-document code. Unrecoverable once indexed. |
| `REPO_TOPOLOGY` | single polyglot monorepo (`apps/web`, `services/worker`, `packages/contracts`, `infra`) | — | The web↔worker contract must change atomically; house prior art (`pguard`, `jawbong`) is monorepo. | Multi-repo ⇒ two-PR contract changes, no atomic review, 3× governance drift surface. |
| `GITHUB_PLAN` | `GitHub Team` — **3 seats**, `$4.00/user/month` list (`$144.00/yr`; `$132.12/yr` prepaid) | — | **Rulesets are not enforced on private repos under GitHub Free.** Team is the cheapest plan where private + enforced rulesets coexist. | Free plan ⇒ `main` is force-pushable, deletable, unreviewable. The gate's central control is absent. |
| `ORG_MEMBERS_CAN_CREATE_PUBLIC_REPOS` | `false` | `members_can_create_public_repositories` (REST `PATCH /orgs/{org}`) | Removes the capability rather than defaulting against it. | `true` ⇒ one late-night `gh repo create --public` reproduces the current estate. |
| `ORG_MEMBERS_CAN_CREATE_PRIVATE_REPOS` | `true` | `members_can_create_private_repositories` | Private creation stays frictionless so nobody routes around the org. | `false` ⇒ repo creation queues on an owner; people use personal accounts instead. |
| `ORG_BASE_PERMISSION` | `none` | `default_repository_permission` | Access arrives only via team membership; `read` would grant all members all repos. | `read` ⇒ every member reads the ID-document codebase by default; team membership stops being the source of truth. |
| `ORG_MEMBERS_CAN_DELETE_REPOS` | `false` | `members_can_delete_repositories` | Blocks transfer-to-personal-account, which would escape all policy. | `true` ⇒ the private repo can be transferred out of governance in one click. |
| `ORG_MEMBERS_CAN_FORK_PRIVATE_REPOS` | `false` | `members_can_fork_private_repositories` | A fork is a second copy under weaker governance. | `true` ⇒ a full copy of the corpus outside the ruleset and the retention policy. |
| `ORG_VISIBILITY_CHANGE_ALLOWED` | disabled (owners only) | *(UI: Member privileges → Repository visibility change)* | Without it, a member creates private then flips public. | Enabled ⇒ the public-repo block is bypassable in two steps. |
| `ORG_2FA_REQUIRED` | `true` | *(UI: Security → Authentication security)* | SAML SSO is **Enterprise Cloud only**, unavailable on Team; 2FA is the strongest available identity control. | Disabled ⇒ a phished password is full org access. |
| `ORG_OWNER_COUNT` | `2` | — | 1 = lockout with no recovery; 3+ = more people who can flip visibility and edit rulesets. | 1 ⇒ a lost device is an outage. 3+ ⇒ enlarged blast radius. |
| `REPO_ADMIN_GRANTS` | `0` (org owners hold implicit admin; teams get `Maintain` / `Write` / `Read`) | — | `Maintain` covers daily needs and cannot delete the repo, change visibility, or edit rulesets. | Standing repo-admin ⇒ a standing capability to disable every control in §5. |
| `TEAMS` | `ocr-maintainers`=Maintain, `ocr-developers`=Write, `ocr-audit`=Read | — | Least privilege with a named read-only lane for counsel/auditors. | Ad-hoc collaborator grants ⇒ no revocation story at offboarding. |
| `PAT_POLICY` | fine-grained PATs: **require approval**; classic PATs: **not allowed** | — | A classic `repo`-scoped PAT (both accounts hold one today) grants every repo the user can see. | Allowed ⇒ the broadest credential in the estate remains issuable without review. |
| `PROTECTED_BRANCH` | `main` (ruleset `main-protection`) | — | Single protected default branch; `juneflow` uses `dev` — not inherited. | Unprotected ⇒ every control in §5 is advisory. |
| `RULESET_FORCE_PUSH` | blocked | — | The Trivy→LiteLLM chain was **delivered by force-push over published refs**. | Allowed ⇒ history is rewritable by any write holder; signed commits and bisect both become meaningless. |
| `RULESET_DELETIONS` | blocked | — | `main` cannot be deleted. | Allowed ⇒ one command removes the default branch. |
| `RULESET_LINEAR_HISTORY` | required (squash-merge only) | — | Bisect must be meaningful when an OCR regression surfaces 40 commits later. | Merge commits ⇒ regression triage cost rises with corpus size. |
| `RULESET_SIGNED_COMMITS` | required (SSH signing) | — | Commit provenance survives a stolen token used from another machine. | Off ⇒ a compromised credential produces indistinguishable commits. |
| `RULESET_REQUIRED_APPROVALS` | **0** while committers < 2; **1** at 2–4; **2** at ≥ 5 | — | GitHub cannot count a self-approval; a hard `1` on a solo repo makes `main` unmergeable and invites a permanent bypass. | A bypass entry added to unblock a merge disables *all* rules, not just review. |
| `RULESET_BYPASS_ACTORS` | **empty — org and repo admins are subject to the rules** | — | The brief asks whether admins are included: they are. A bypass for the only two committers makes the ruleset documentation. | Any standing bypass ⇒ every §5 control is optional for the people most able to use it. |
| `RULESET_EMERGENCY_BYPASS_SLA` | **24 hours** to remove a temporary bypass; weekly CI cron asserts the list is empty | — | An escape hatch that is never closed is a permanently disabled control. | Bypass left in place ⇒ silent, indefinite loss of protection with no alarm. |
| `REQUIRED_STATUS_CHECKS` | `verify`, `secret-scan`, `supply-chain`, `privacy-guard`, `worker-verify` — **all 5 blocking**, strict (branch up to date) | — | A non-blocking security check is a notification. | Non-blocking ⇒ findings accumulate unread, exactly as the estate demonstrates. |
| `TAG_RULESET` | `v*`: restrict updates, deletions and creations; require signatures | — | Direct §1.4 mitigation — the attack force-pushed over **published version tags**. | Mutable tags ⇒ we ship the same weakness we pin every dependency against. |
| `SECRET_SCAN_L1` | `gitleaks protect --staged --redact` in `.githooks/pre-commit` — **blocking**, `$0` | — | Fires before the git object exists; remediation is "don't", not "rebase". | Missing/unconfigured hook ⇒ the secret reaches the remote and L2 becomes revoke-then-rewrite. |
| `SECRET_SCAN_L2` | `gitleaks detect --redact --exit-code 1` (full history) as required check `secret-scan` — **blocking**, `$0` | — | Server-side; cannot be skipped by an unconfigured clone. | Disabled ⇒ L1 becomes the only layer and it is developer-optional by nature. |
| `SECRET_SCAN_L3` | `trufflehog git file://. --results=verified --fail` — weekly cron + before any repo transfer, `$0` | — | Verifies liveness, which is what decides revoke-now vs note-and-move-on. | Skipped ⇒ a live key is transferred into the org along with the repo. |
| `SECRET_SCAN_L4` | GitHub Secret Protection — **$19/active committer/mo** = **$684.00/yr at 3**. **OWNER-BLOCKED (B-3.2); default = NOT purchased.** | — | Push protection for private repos requires it; free push protection is public-repos-only. | Not purchased ⇒ the residual gap is a secret pushed from a clone without hooks, caught at PR time by L2. |
| `GITLEAKS_CUSTOM_RULE_SOURCE` | generated at bootstrap from `j-security-threat-model.md` §8/§12.3 (never hand-typed) | — | The key prefix is owned there; a hand-copied regex is guaranteed drift. | Hand-typed ⇒ the rule silently stops matching after a format change. |
| `GITHOOKS_PATH` | `.githooks` (`git config core.hooksPath .githooks`); hooks: `pre-commit`, `pre-push` | — | Versioned hooks survive a fresh clone; local config does not — `innovera-chat`'s own stated rationale. | Not configured ⇒ L1 silently absent on that machine; CI asserts presence of the files but cannot assert the `git config`. |
| `PRE_PUSH_PRODUCTION_GUARD` | `innovera-chat/.githooks/pre-push` adopted **unchanged**, incl. `ALLOW_PRODUCTION_PUSH=1` | — | Estate-wide identical hooks are recognisable; zero cost when no `production` remote exists. | Rewritten per repo ⇒ divergent behaviour and a hook nobody trusts. |
| `DEPENDABOT_ECOSYSTEMS` | `npm`, `pip`, `docker`, **`github-actions`** | — | `github-actions` is what keeps §7.3's SHA pins current rather than frozen. | Omitting `github-actions` ⇒ pins ossify; "pinned to 2026 forever" is its own vulnerability. |
| `ACTIONS_DEFAULT_TOKEN_PERMISSIONS` | **read-only** (org: "Read repository contents and packages permissions") | `GITHUB_TOKEN` | A compromised action gets a read-only token by default. | Read-write default ⇒ any third-party action can push to `main` and to GHCR. |
| `ACTIONS_CAN_APPROVE_PRS` | `false` | — | Otherwise a workflow satisfies the §5.1 review requirement itself. | `true` ⇒ required review is self-serviceable by CI. |
| `ACTIONS_ALLOWLIST` | 4 entries: `actions/*`, `pnpm/action-setup@*`, `docker/*`, `github/codeql-action/*` | — | An unrestricted marketplace is an unrestricted dependency list. | Unrestricted ⇒ any action, from any author, at any version, in the build. |
| `ACTION_PIN_POLICY` | **full 40-char commit SHA** on every `uses:`, version in a trailing comment; asserted by a grep in `supply-chain` | — | jawbong's convention. `pguard` uses mutable tags — the live instance of the LiteLLM pattern in the estate (§9 R6). | Tag pins ⇒ exactly the Trivy→LiteLLM delivery path: poisoned code behind an unchanged tag. |
| `CI_TOOL_PIN_POLICY` | every CI-installed tool (gitleaks, trufflehog, image scanners) pinned by **container digest**; never `latest`/`vN` | — | **The LiteLLM compromise came through a poisoned CI scanner installed unpinned.** A scanner is a dependency with root in your build. | Unpinned ⇒ the documented, reproduced 2,500-org failure mode. |
| `PULL_REQUEST_TARGET` | **forbidden**; asserted by `! grep -rn 'pull_request_target' .github/workflows/` | — | Runs with base-repo secrets and a write-capable token; the most-exploited Actions pattern. | Present ⇒ untrusted PR code can execute with production secrets. |
| `MINIMUM_RELEASE_AGE` | **4320 minutes (3 days)** in `pnpm-workspace.yaml`; exclusions require a PR with reason + review date | — | The malicious LiteLLM versions lived **40 minutes**. A 4320-minute floor blocks that class outright. | Unset ⇒ a package published minutes ago can enter the next build. |
| `DEPLOY_ENVIRONMENT` | `production` — required reviewers **1**, wait timer **5 min**, deployment branch **`main` only** | — | The 5-minute timer is the cancel window for a wrong SHA. | No environment ⇒ deploy secrets sit at repo scope, reachable from any workflow. |
| `REPO_LEVEL_SECRETS` | **0** — all secrets live on the `production` environment | — | Environment-scoped secrets are unreachable from PR-triggered workflows. | Repo-scoped ⇒ any workflow, including one added in a PR, can read them. |
| `CREDENTIAL_STRATEGY` | **OIDC** (`id-token: write`, subject `repo:innovera-th/innovera-ocr:environment:production`); GHCR via job-scoped `GITHUB_TOKEN` + `packages: write`. **No PAT in CI.** | — | An OIDC token lives minutes and is bound to repo/ref/environment. Also §1.4 R2: rotation is not revocation. | Long-lived PAT ⇒ a credential that outlives the person, the project and the incident. |
| `CI_ARTIFACT_RETENTION_DAYS` | org default **7**; the single permitted upload step **1** | — | GitHub's 90-day default is a 90-day window on anything that leaks into an artifact. | 90 days ⇒ a long-lived, org-readable copy of anything CI emitted. |
| `CI_LOG_RETENTION_DAYS` | **7** | — | Same reasoning; logs are readable by every member with repo read. | 90 days ⇒ prolonged exposure of anything printed. |
| `UPLOAD_ARTIFACT_MAX_STEPS` | **1**, `if: failure()`, `retention-days: 1`, uploads `playwright-report/` only; asserted by grep | — | Artifact upload is the realistic exfiltration path for rendered document content. | Unbounded ⇒ traces and screenshots containing rendered documents become shared artifacts. |
| `PLAYWRIGHT_CI_CAPTURE` | `screenshot: 'off'`, `video: 'off'`, `trace: 'off'` when `CI` | `CI` | A Playwright trace embeds full DOM snapshots — unredactable if a document is on screen. | On ⇒ a rendered Thai ID lands in a downloadable CI artifact. |
| `FIXTURE_POLICY` | synthetic only; produced solely by `scripts/fixtures/generate.ts`; every file's SHA-256 in `tests/fixtures/MANIFEST.sha256`; CI asserts manifest completeness and regenerability | — | Removes the stream rather than filtering it. | A hand-dropped fixture ⇒ possible real PII in git history forever; removal needs a bypass + rewrite + clone-holder notification. |
| `PII_GREP_RULE` | `\b\d{13}\b` forbidden outside `tests/fixtures/` and `docs/`; run on the full tree and on every PR diff | — | Thai national ID is 13 digits; this is the highest-value single pattern. | Absent ⇒ a real ID enters history via a test, an issue body or a comment. |
| `BINARY_GUARD` | no file > **256 KB**, and no `*.pdf|*.jpg|*.jpeg|*.png|*.tif|*.tiff`, added outside `tests/fixtures/`, `docs/`, `public/` | — | The realistic accident is a customer PDF dragged in to reproduce a bug. | Absent ⇒ a customer document in permanent history. |
| `GIT_LFS` | **not used** | — | LFS objects survive a history rewrite in a separate store, so "we removed it" would be false. | Enabled ⇒ deletion claims become unverifiable. |
| `ORG_SETTINGS_DRIFT_CHECK` | `scripts/audit-org-settings.sh` re-asserts 7 REST-verifiable org fields weekly via `gh api /orgs/innovera-th`; non-zero exit on drift. Fields 6, 9, 10 verified quarterly by screenshot + audit-log query. | — | Settings set once in a UI drift silently and invisibly. | No check ⇒ a reverted toggle is discovered by an incident, not by CI. |
| `EXISTING_REPO_POSTURE` | 15 repos, **all public**, split across two personal accounts; **no secret found** in `innovera-chat` — architecture only. Remediation R1–R9 in §9.2. **OWNER-BLOCKED (B-3.4).** | — | Accurate framing: reconnaissance value, not credential value. Bus-factor and offboarding are the structural findings. | Left as-is ⇒ the AI topology stays public and no repo is recoverable if either account holder is unavailable. |
| `NEW_REPO_CREATION_IN_THIS_GATE` | **none — zero repositories, zero organizations created** | — | Gate 3 is document-only by the brief's hard constraint. | Any creation here ⇒ milestone failure. |

---

**Sources for the platform and incident facts in §1.3 and §1.4:**
[GitHub Secret Protection](https://github.com/security/advanced-security/secret-protection) ·
[GitHub Changelog — secret scanning improvements, 2026-07-15](https://github.blog/changelog/2026-07-15-improvements-to-secret-scanning-and-public-monitoring/) ·
[Push Protection for Private Repos — community #197712](https://github.com/orgs/community/discussions/197712) ·
[Rulesets Free Plan Private Repo — community #190190](https://github.com/orgs/community/discussions/190190) ·
[Basic Branch Protection for Private Repos — community #174419](https://github.com/orgs/community/discussions/174419) ·
[GitHub Docs — Managing a branch protection rule](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/managing-a-branch-protection-rule) ·
[GitHub Docs — Restricting repository creation in your organization](https://docs.github.com/en/organizations/managing-organization-settings/restricting-repository-creation-in-your-organization) ·
[GitHub Docs — REST: Organizations](https://docs.github.com/en/rest/orgs/orgs) ·
[GitHub Docs — About Dependabot security updates](https://docs.github.com/en/code-security/concepts/supply-chain-security/about-dependabot-security-updates) ·
[Trend Micro — Inside the LiteLLM supply chain compromise](https://www.trendmicro.com/en_us/research/26/c/inside-litellm-supply-chain-compromise.html) ·
[SecurityWeek — Over 2,500 organizations impacted](https://www.securityweek.com/over-2500-organizations-impacted-by-litellm-supply-chain-attack/) ·
[CloudSEK — LiteLLM supply chain attack](https://www.cloudsek.com/blog/ai-supply-chain-breach-2500-companies-434000-cicd-pipelines) ·
[SOCRadar — LiteLLM supply chain attack](https://socradar.io/blog/litellm-supply-chain-attack/) ·
[CPO Magazine — LiteLLM supply chain attack](https://www.cpomagazine.com/cyber-security/litellm-supply-chain-attack-affects-over-2500-organizations-and-more-than-434000-ci-cd-pipelines/) ·
[Gitleaks vs TruffleHog (2026)](https://rafter.so/blog/secrets/gitleaks-vs-trufflehog)
