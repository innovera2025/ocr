---
dimension: f1-tenant-visibility-model
title: "Foundation 1 — Tenant, Ownership and Visibility: the P8 FATAL fix"
status: canonical
date: 2026-09-09
supersedes:
  - docs/architecture/m0/g-data-model.md §2 (K-1 identifiers), §3 (K-2/K-3 tenancy, all three layers), §5.3 (Organization/User/Membership/ApiKey), §5.4 (Document and DocumentPage ownership/visibility columns and their indexes only), §5.5 (ExtractionJob dedupe identity only), §5.6 (OcrResult uniqueness only), §7.3 (StorageObject fingerprint uniqueness only)
  - docs/architecture/m0/j-security-threat-model.md §7.1 and §7.1.1 (the visibility model, its schema consequence, and the 404-not-403 rule) — the rest of §7 is NOT owned here
  - docs/architecture/m0/l-api-ui-export.md §1.2 (Identifiers), §2.1 (the 404/403 table), §2.2 (Layer 1 `tenantScoped()` $extends client — deleted, not amended)
  - docs/architecture/m0/z-adversarial-panel.md P8 (all three lenses) — this document is the response
owner: Foundation 1
owns:
  - the tenant scope column name and the tenant root model
  - the Workspace / Membership / WorkspaceMember / DocumentGrant entity model
  - the separation of document OWNERSHIP from document VISIBILITY
  - the internal primary-key strategy and the external (URL-facing) identifier
  - the single authorization chokepoint and its type-level guarantee
  - the PostgreSQL role set, the transaction-local GUCs, and the RLS policies that carry visibility
  - the not-found response rule and its timing side-channel treatment
  - the admin scope rule and the audited elevation mechanism
  - the exact unique constraints for storage objects, pages, runs, jobs, OCR results, workspace
    members and document grants
does_not_own:
  - retention periods and the erasure mechanism (owned by `gate-2-pdpa-retention.md`) — cited, never restated
  - ingest size/page limits (currently contradictory across g §5.3 and j §8.1/§8.2 — see §11.4)
  - the object-key grammar (storage dimension) — this document constrains it, it does not define it
  - the DocumentStatus vocabulary (state-machine dimension) — this document adds `DocumentRun`, not states
  - the queue claim protocol (owned by h-queue-and-worker-contract.md) — cited
  - the `ocr_live_` API key format (owned by j §8/§12.3) — cited
---

# Foundation 1 — Tenant, Ownership and Visibility

> **Integration status (2026-09-12):** Read the [architecture index](../README.md) and its consolidation report before using these examples. Individual review labels do not close cross-document conflicts; no application implementation is verified.

## 0. The one thing this document fixes

The adversarial panel returned exactly one **FATAL** verdict in M0, against P8, and all three lenses
agreed on the same root cause:

> `g-data-model.md` scopes every isolation control on `organizationId` and nothing else. All three of
> its "independent layers" — the typed `TenantScope`, the composite FK `(id, organizationId)`, and the
> RLS predicate `organization_id = current_setting('app.current_org')` — pass for an accounts-payable
> clerk reading a scanned employment contract that HR uploaded in the same tenant.

`j-security-threat-model.md` §7.1.1 had already written the requirement, in bold, addressed to the
data-model dimension, and declared it **non-retrofittable**. `g` shipped without it. This document is
the reconciliation.

**The fix in one paragraph.** A document is *owned* by exactly one membership and *contained* by
exactly one workspace; those are facts about the document. A document is *visible* under one of three
rules plus an explicit grant list; that is a policy about the document. Ownership and visibility are
two separate NOT NULL columns and one separate table, and they can never be conflated because no
single column carries both meanings. Every document read in the system passes through one function
whose return type cannot be constructed anywhere else, and the same predicate is enforced a second
time by PostgreSQL RLS from transaction-local GUCs. Cross-organization and not-visible-to-you produce
byte-identical 404s on a 25 ms floor; insufficient-scope-on-a-document-you-can-already-see produces
403. Admin is scoped to one tenant, and an admin reading content outside their own visible set must
pass through a separate, reason-required, time-boxed, audited method that is the only code path in
the system that can set the override GUC.

---

## 1. Vocabulary — the six nouns, fixed once

| Noun | Meaning | Identity |
|---|---|---|
| **Organization** | The tenant. The billing, quota, API-key and data-residency boundary. | `organizations.id` (uuidv7) |
| **User** | A global human identity. May belong to several organizations. | `users.id` (uuidv7) |
| **Membership** | One user's participation in one organization, with an `OrgRole`. **This, not the user, is the tenant-anchored principal identity.** | `memberships.id` (uuidv7) |
| **Workspace** | A named container inside an organization. `PERSONAL` (exactly one per membership) or `SHARED`. The *containment* axis. | `workspaces.id` (uuidv7) |
| **Document ownership** | Which membership is accountable for a document. Immutable after insert. | `documents.owner_membership_id` |
| **Document visibility** | The rule by which principals other than the owner may read it. Mutable, audited. | `documents.visibility` + `document_grants` |

The two axes are orthogonal by construction:

```
                    visibility = PRIVATE      WORKSPACE            ORGANIZATION
workspace = PERSONAL   owner only            owner only(*)        every active member
workspace = SHARED     owner + grants        workspace members    every active member
```

(*) A `PERSONAL` workspace has exactly one member — its owner — enforced by a trigger (§4.3). So
`WORKSPACE` visibility inside a personal workspace *is* private, with no special case in any query.
That is why the default is safe.

---

## 2. Decisions

Every decision below states: competing proposals → **selected** → rejected → reason →
implementation consequence → migration consequence → security consequence → config/env consequence.

### D-F1-1 — The tenant scope column name *(resolves contradiction 8)*

- **Competing proposals.** `g-data-model.md` §5 uses `organizationId` / `organization_id` on 18
  tables. `l-api-ui-export.md` §2.2 uses `tenantId` and lists `GLOBAL_MODELS = ['Tenant', …]`.
  The panel proved `l`'s extension, run against `g`'s schema, throws on **every** model including
  `User`, i.e. it breaks login on the first request.
- **Selected.** `organizationId` (Prisma field) / `organization_id` (column), tenant root model
  `Organization`, table `organizations`, GUC `app.current_org`.
- **Rejected.** `tenantId`; a `Tenant` model; a `tenant_id` column with an `Organization` model.
- **Reason.** Prisma names a relation scalar after the relation field. `model Organization` with a
  scalar called `tenantId` produces the pair `organization` / `tenantId`, which is precisely the shape
  that lets a reviewer forget which of the two is authoritative. Renaming the model to `Tenant`
  instead would rename the customer-facing noun in every screen and every API field for zero
  security benefit. `g` also has the larger installed footprint (18 tables, 9 index names, the RLS
  GUC, the erasure role predicates), so the migration cost is asymmetric.
- **Implementation consequence.** `l` §2.2's `tenantScoped()` `$extends` client is **deleted, not
  renamed** — see D-F1-8. Every `tenantId` string in `l` and `j` is read as `organizationId`.
- **Migration consequence.** **Irreversible.** The column is the leading column of nine composite
  indexes and the second column of every composite FK; renaming after data exists rewrites all of
  them plus every RLS policy. Must be right in migration 0002.
- **Security consequence.** Removes the class of bug where one layer scopes on `organization_id` and
  another on `tenant_id` and neither notices they never both fired.
- **Config/env consequence.** None. The GUC name `app.current_org` is a database identifier, not an
  environment variable.

### D-F1-2 — Ownership and visibility are separate columns, both NOT NULL from row zero

- **Competing proposals.** (a) `g` §5.4: `ownerUserId String?` — nullable, no FK, used only by a
  convenience index. (b) The panel's safer alternative: `ownerUserId` + `workspaceId`, both NOT NULL.
  (c) A single `accessLevel` column conflating who owns it with who sees it.
- **Selected.** Three NOT NULL columns on `documents`: `owner_membership_id` (ownership, immutable),
  `workspace_id` (containment, mutable + audited), `visibility` (policy, mutable + audited), plus a
  denormalised `owner_user_id` that authorization **never reads** (§4.4).
- **Rejected.** (a) and (c). (b) is adopted with the substitution of `membership_id` for `user_id`.
- **Reason.** (a) is the FATAL finding. (c) fails the owner's explicit requirement that ownership and
  visibility be separable: a document can be owned by Alice and visible to the whole organization, or
  owned by Alice and visible to nobody else, and no single scalar expresses both without an implicit
  ordering that will be wrong for someone. Anchoring on `membership_id` rather than `user_id` means
  the composite FK `(owner_membership_id, organization_id) → memberships(id, organization_id)` makes
  it **structurally impossible** for a document to be owned by someone who is not a member of its own
  organization — which a `user_id` FK to the global `users` table cannot express.
- **Implementation consequence.** Upload cannot begin until the principal is resolved, because
  `owner_membership_id` and `workspace_id` must both be known before the `documents` insert. The
  two-phase upload (blob first, row second) is unaffected: both values come from the request context,
  not from the blob.
- **Migration consequence.** **This is the un-backfillable one.** `j` §7.1.1: retrofitting means
  "backfilling ownership for rows whose real owner is no longer knowable". Both columns must be
  `NOT NULL` in the migration that creates `documents`. There is no cheap second chance.
- **Security consequence.** Closes the FATAL intra-tenant IDOR. Also closes the forged-approval path
  (`j` §7.6), because approval authority is read from `workspace_members.role` /
  `document_grants.can_approve`, never inferred from the ability to read.
- **Config/env consequence.** One organization-level setting, `Organization.defaultDocumentVisibility`
  (default `WORKSPACE`), changeable by an `OWNER` and written to the audit log.

### D-F1-3 — The grouping unit is a Workspace, and every membership gets a PERSONAL one

- **Competing proposals.** (a) Per-document ACLs only. (b) A department tree. (c) Workspaces (`j`
  §7.1.1's choice). (d) Workspaces **plus** an automatic personal workspace per membership.
- **Selected.** (d).
- **Rejected.** (a) — nobody shares 500 invoices by hand; the grant table stays, but as the exception
  path, not the primary one. (b) — a tree needs inheritance rules, a move operation that reparents
  permissions, and it is rigid where Thai org charts are not. (c) alone — it forces a special-case
  "no workspace yet" branch in the upload path and in every query, and that branch is where the
  nullable-owner bug comes back.
- **Reason.** With a personal workspace guaranteed to exist for every membership, `workspace_id` is
  never absent, "private" needs no special query shape, and the default upload target is
  private-by-construction rather than private-by-remembering. One extra row per membership.
- **Implementation consequence.** `createMembership()` inserts the membership, its personal
  workspace, and the `workspace_members` row for it in **one transaction**. `Membership.defaultWorkspaceId`
  points at it. A deferred constraint trigger (§4.3) makes a membership without a default workspace
  impossible to commit.
- **Migration consequence.** Additive later for *new* memberships, un-backfillable for existing
  documents (a document already in a shared workspace cannot be retroactively assigned to a personal
  one). Ships in migration 0002.
- **Security consequence.** Deny-by-default without a policy engine. Widening is an explicit act
  (move to a shared workspace, or change visibility) that writes an audit row.
- **Config/env consequence.** None.

### D-F1-4 — The visibility enum

- **Competing proposals.** (a) Boolean `isPrivate`. (b) Two values `PRIVATE | SHARED`. (c) Three
  values `PRIVATE | WORKSPACE | ORGANIZATION`. (d) A full policy expression column (JSONB).
- **Selected.** (c) `enum DocumentVisibility { PRIVATE, WORKSPACE, ORGANIZATION }`, column default
  `WORKSPACE`, effective default from `Organization.defaultDocumentVisibility`.
- **Rejected.** (a)/(b) — cannot express "the whole company may see this" without abusing the
  workspace dimension, which is the flat-pool product some customers ask for (`j` §7.1.1's "what would
  change it" row). (d) — an unindexable, untestable, un-reviewable authorization surface; a JSONB
  policy is the thing you build after you have measured that three values are not enough.
- **Reason.** Three values cover the whole observed requirement space and each maps to an
  index-friendly SQL predicate. Adding a fourth value later is `ALTER TYPE … ADD VALUE`, which is
  additive; removing one is not, which is why we do not start with five.
- **Implementation consequence.** `visibility <> 'PRIVATE'` is the workspace branch predicate;
  `visibility = 'ORGANIZATION'` is its own partial index (§7.6).
- **Migration consequence.** The enum must exist before `documents`. `ALTER TYPE … ADD VALUE` cannot
  run in the same transaction as its own use, so a future fourth value is a two-migration change —
  documented, not destructive.
- **Security consequence.** `ORGANIZATION` is never a default and cannot be set by a `MEMBER` unless
  `Organization.defaultDocumentVisibility` is already `ORGANIZATION`; promoting a document to
  `ORGANIZATION` requires `WorkspaceRole.MANAGER` or `OrgRole.ADMIN|OWNER` and writes an audit row.
- **Config/env consequence.** `Organization.defaultDocumentVisibility` — a database column, not an
  env var, because it is per tenant.

### D-F1-5 — Grants are a table, with a polymorphic grantee designed in on day one

- **Competing proposals.** (a) `document_grants(document_id, user_id)` only (`j` §7.1.1, the panel).
  (b) No grant table in M1; ship workspaces only. (c) A grantee that can be a membership **or** an
  API key, from the first migration.
- **Selected.** (c) — `grantee_kind` enum plus two nullable, mutually exclusive, composite-FK'd
  columns and a CHECK.
- **Rejected.** (a) — the external OCR API is in the product from M1 (`g` §3.1), so a key that must
  read one shared document is a first-quarter request, and adding `grantee_api_key_id` later means a
  new nullable column *plus* rewriting the two unique indexes and the CHECK. (b) — "share this one
  document with the auditor" is the single most common ask that workspaces cannot express.
- **Reason.** The additional cost today is one enum, one nullable column, one CHECK and one extra
  partial unique index. The cost later is an index rewrite on a live authorization table.
- **Implementation consequence.** The RLS policy and the application filter each carry two EXISTS
  branches instead of one.
- **Migration consequence.** Additive. Nothing here is un-backfillable — grants that were never
  recorded simply do not exist, which is the correct closed state.
- **Security consequence.** `canApprove` and `canExport` live on the grant, so reading never implies
  approving (`j` §7.6). Grants carry `expires_at` and `revoked_at`; the unique indexes are partial on
  `revoked_at IS NULL` so re-granting after revocation is legal (§7.7).
- **Config/env consequence.** None.

### D-F1-6 — Internal primary key: uuidv7

- **Competing proposals.** `bigint identity`; `cuid2`; `uuid` v4; **`uuid` v7**.
- **Selected.** `uuid` v7, generated in application code (`uuid@14.0.2`, `v7()`), typed `@db.Uuid`,
  branded `EntityId` in the domain layer.
- **Rejected.** `bigint` — the upload flow must know `StorageObject.id` before it streams bytes and
  `Document.id` before it inserts the row; a database-generated key forces an insert-then-update
  window. Also enumerable. `cuid2` — random (no btree locality), stored as `text` (50–75 % larger in
  every index and every composite FK, and we now have *more* composite FKs, not fewer), no native
  PostgreSQL type, so it cannot use `@db.Uuid` and cannot be compared as a 128-bit memcmp. `uuid` v4
  — random keys dirty an arbitrary index page per insert, inflating full-page images in WAL.
- **Reason.** v7's leading 48-bit millisecond timestamp makes inserts append to the right-most btree
  leaf. Its one real cost — 62 effective random bits after PostgreSQL 18's monotonicity counter, and a
  readable creation timestamp — is paid for by D-F1-7, which keeps the PK off the wire entirely.
- **Implementation consequence.** `newEntityId()` in `src/modules/shared/domain/identity.ts`; no
  `@default(uuid(7))` (invisible to `$queryRaw` writers and hides generation from the domain layer),
  no `@default(dbgenerated("uuidv7()"))` (pins PostgreSQL ≥ 18 and it is **UNVERIFIED** whether a
  `dbgenerated()` field stays settable in `create()`, which the seed file needs).
- **Migration consequence.** Column type `uuid` is fixed for the life of the schema; changing it later
  rewrites every table and every index.
- **Security consequence.** The PK never appears in a URL, a webhook body, an export or an error
  message, so its 62 random bits and its timestamp are not attack surface. A lint rule (§6.5) fails
  the build on `document.id` reaching a response serializer.
- **Config/env consequence.** None.

### D-F1-7 — The external identifier: **two identifiers, not one** *(resolves contradiction 7)*

- **Competing proposals.** (a) `g` §2 K-1: a second column `publicId`, 160-bit CSPRNG, Crockford
  base32, 32 chars; the uuid PK never leaves the server. (b) `l` §1.2: "Database PK and public id are
  the **same UUIDv7**", exposed as `doc_0192f4c1-…`.
- **Selected.** (a), with `l`'s type prefix adopted as a **wire-format decoration only**.
  - Stored: `documents.public_id VARCHAR(32) NOT NULL UNIQUE`,
    `CHECK (public_id ~ '^[0-9A-HJKMNP-TV-Z]{32}$')`.
  - Generated: `crypto.randomBytes(20)` → Crockford base32 (alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`,
    no I/L/O/U).
  - On the wire: `doc_` + the 32 stored characters. The server strips and validates the prefix.
- **Rejected.** (b). Reason: a UUIDv7 on the wire discloses the upload millisecond to anyone holding
  the link — including a link forwarded outside the organization, a link in a browser history, a link
  in a customer's own log aggregator. `l`'s counter-argument ("`createdAt` is in the payload anyway")
  only holds for a principal authorized to read the payload; the id in the URL is visible to everyone
  in the transport path. Separately, 62 effective random bits is a materially weaker guessing target
  than 160, and this product's payload is Thai identity documents.
- **Reason for two rather than replacing the PK with the random token.** A 32-char text PK would cost
  the 50–75 % index inflation D-F1-6 rejected, on every one of the ~20 composite FKs. One extra
  unique index on one table (≈ 10 MB at 240 k documents/year) is the cheaper half of the trade.
- **Implementation consequence.** Exactly one `@unique` text column per externally-addressable model.
  In M1 that is `Document`. Every other externally-addressable entity added later (`ExtractionJob`,
  `ExtractionTemplate`, `Export`, `Webhook`) **must** follow the same rule; a DMMF test asserts that
  any model appearing in the public route table has a `publicId`. Collision handling: a 23505 on
  `document_public_id_key` retries generation once, then fails the request; at 2¹⁶⁰ this branch is
  expected to execute never and exists so that it is not a wedge if it does.
- **Migration consequence.** **Effectively irreversible.** Changing the exposed identifier later
  breaks every customer-stored URL, every webhook consumer and every exported CSV. Decide in
  migration 0002.
- **Security consequence.** Removes URL-based enumeration outright (2¹⁶⁰) and removes the timestamp
  disclosure. It does **not** by itself remove the *confirmation* oracle for an id an attacker already
  holds — that is D-F1-14.
- **Config/env consequence.** None. The prefix `doc_` is a compile-time constant, not configurable;
  a configurable prefix is an invitation to two deployments disagreeing about it.

### D-F1-8 — Enforcement: scoped repository **and** RLS, both carrying the full visibility predicate

- **Competing proposals.** (a) Application-level scoped repository only (`g` §3.2's `TenantScope`).
  (b) PostgreSQL RLS only. (c) `l` §2.2's Prisma `$extends` client that injects the scope column into
  every operation. (d) Both (a) and (b), with RLS carrying only the tenant predicate. (e) Both, with
  RLS carrying the **full** visibility predicate.
- **Selected.** (e).
- **Rejected.**
  - (a) alone — `$queryRaw` / `$queryRawUnsafe` bypass it entirely, and a background job that forgets
    to wrap has no backstop.
  - (b) alone — cannot be checked at compile time, fails by silently returning zero rows (the "my
    query returns nothing" trap), and does nothing against an application that sets the *wrong*
    organization in the GUC.
  - (c) — deleted outright, not repaired. Three independent defects, each fatal: it injects the wrong
    column name (D-F1-1); its `GLOBAL_MODELS` allowlist omits `User`, so it throws on the login path;
    and `$allOperations` under `$allModels` provably does not intercept raw queries, which is exactly
    where `l`'s own keyset pagination lives. An ambient injector also makes the scope invisible at the
    call site, which is the property that lets a reviewer stop looking for it.
  - (d) — leaves visibility enforced in exactly one place, so a bug there is a silent intra-tenant
    breach with no second line.
- **Reason.** The two layers fail in opposite directions and catch different mistakes. The repository
  chokepoint is a **compile-time** control that also supplies the predicate to the planner (so the
  indexes are used). RLS is a **runtime** control that survives raw SQL, a future ORM swap, a
  misrouted background job and a direct `psql` session as `ocr_app`. Keeping the predicate identical
  in both is enforced mechanically by an equivalence test (§6.6), so the usual "two copies drift"
  objection is answered by a test rather than by discipline.
- **Implementation consequence.** Four transaction-local GUCs, five PostgreSQL roles, one policy per
  tenant table, and one `withPrincipal()` runner. Raw SQL is banned outside one allowlisted folder
  (D-F1-10), which removes the only place the repository layer could be bypassed.
- **Migration consequence.** Roles must exist before migration 0001 grants to them (created by a
  bootstrap `psql` script, not by Prisma — `prisma migrate deploy` speaks the wire protocol and does
  not expand `psql`'s `:'var'` syntax, and `CREATE ROLE` needs a privilege the migration role will not
  have on managed PostgreSQL). `FORCE ROW LEVEL SECURITY` must be on before the first row.
- **Security consequence.** Two independent controls on the same predicate. A restore that loses the
  roles must **crash-loop, not serve zero rows** — asserted at startup (§6.7).
- **Config/env consequence.** `DATABASE_URL` (role `ocr_app`), `DATABASE_URL_WORKER` (`ocr_worker`),
  `DATABASE_URL_QUEUE` (`ocr_queue`), `DATABASE_URL_ERASURE` (`ocr_erasure`),
  `DATABASE_URL_MIGRATOR` (`ocr_owner`). Five URLs, five roles, no sharing.

### D-F1-9 — The chokepoint is type-level: the Prisma delegates are removed from the transaction type

- **Competing proposals.** (a) Convention plus code review. (b) `dependency-cruiser` + ESLint rules
  only. (c) A branded `DocumentRef` that only the chokepoint can produce, **and** a `ScopedTx` type
  from which the document delegates are structurally absent.
- **Selected.** (c), with (b) retained as the outer perimeter.
- **Rejected.** (a) — this is exactly what produced the FATAL finding. (b) alone — lint rules are
  suppressible with a comment and a new file path can be added to an allowlist in the same PR that
  needs it.
- **Reason.** A lint rule says "do not"; a type says "cannot". `ScopedTx = Omit<Prisma.TransactionClient,
  'document' | 'documentPage' | 'documentRun' | 'ocrResult' | 'documentAnalysis' |
  'extractionFieldValue' | 'correction' | 'extractionJob' | 'jobEvent' | 'documentGrant'>` means a new
  route handler writing `tx.document.findMany(...)` does not fail review — it fails `tsc`, because the
  property does not exist on the type it was given. The full client is constructed in one module and
  handed to one class.
- **Implementation consequence.** §6 gives the code. `DocumentAccess` is the only holder of the
  unrestricted client for those ten models; every child-entity method takes a `DocumentRef`, which
  carries a `declare const` `unique symbol` brand and therefore cannot be constructed by object
  literal anywhere outside its module.
- **Migration consequence.** None (application-layer).
- **Security consequence.** The remaining bypass is `as unknown as DocumentRef`, which is banned by an
  ESLint `no-restricted-syntax` rule on `TSAsExpression` naming `DocumentRef`, plus a CI grep that
  fails on `eslint-disable` within `src/modules/documents/**`.
- **Config/env consequence.** None.

### D-F1-10 — Raw SQL is banned in the tenant read path

- **Competing proposals.** (a) `l` §1.4's keyset pagination as `$queryRaw` (its stated design).
  (b) Keyset pagination expressed in Prisma (`cursor` + `take` + `orderBy`).
- **Selected.** (b), plus a hard ban: `$queryRaw`, `$queryRawUnsafe`, `$executeRaw`, `$executeRawUnsafe`
  may appear **only** under `src/modules/shared/infrastructure/db/raw/**`, which has a CODEOWNERS
  entry and contains, in M1, exactly four files: the GUC setter, the partial-index-aware storage
  upsert, the queue claim, and the retention sweeper.
- **Rejected.** (a). Reason: `l` itself concedes that raw queries are invisible to application-level
  scoping, and it used that concession to argue RLS is load-bearing for list endpoints. With
  visibility now in the predicate, a raw list query would bypass the *visibility* filter as well as
  the tenant filter, leaving only RLS — and RLS's failure mode on that path (zero rows) is
  indistinguishable from "you have no documents".
- **Reason.** Prisma's `cursor`/`take`/`orderBy` compiles to the same keyset SQL. The raw form bought
  nothing that justified punching a hole in the only compile-time control we have.
- **Implementation consequence.** Ordering is `orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]` with
  `cursor: { id }`, `skip: 1`, `take: 51` (fetch one extra to compute `hasMore`). The API cursor is
  base64url of `{createdAt, id}` and is opaque.
- **Migration consequence.** None.
- **Security consequence.** Every list endpoint is covered by both layers, with no exception to
  remember.
- **Config/env consequence.** Page size default `50`, maximum `200` (`take` is never optional).

### D-F1-11 — Uniqueness defect A: blank pages *(see §7.2 for the exact constraints)*

- **Competing proposals.** (a) Keep `@@unique([organizationId, contentFingerprint, kind])`.
  (b) Drop fingerprint uniqueness entirely and rely on `(bucket, object_key)`. (c) Make the fingerprint
  unique **partial** on `kind = 'ORIGINAL' AND deleted_at IS NULL`.
- **Selected.** (c).
- **Rejected.** (a) — it is the defect: two byte-identical page renders (two blank backs of a duplex
  scan, two identical letterhead pages, two empty-page engine payloads) collide with `23505`, the job
  retries, exhausts `max_attempts`, goes `DEAD`, and the document goes `FAILED`. Blank backs and
  separator sheets are the *median* artifact in scanned-document workloads. (b) — it deletes the
  same-tenant dedup probe that `g` §7.1 step 4 depends on, and dedup is the reason the constraint was
  written.
- **Reason.** Only `ORIGINAL` is content-addressed. Derivatives are identity-addressed
  (`…/render/{docId}/{page:05d}@{dpi}.jpg`) and are already unique through
  `storage_object_bucket_key_key (bucket, object_key)`. The `deleted_at IS NULL` clause makes
  re-upload after a delete legal, which the full constraint also blocked.
- **Implementation consequence.** The dedup upsert becomes raw SQL with an inferred partial conflict
  target (§7.2). Prisma cannot express a partial unique index without the `partialIndexes` preview
  flag, which we reject in D-F1-16.
- **Migration consequence.** Tightening a unique index after data exists fails if any duplicate has
  landed; loosening is free. This one *loosens*, so it is the safe direction — but the *derivative*
  rows it permits cannot be retroactively created for documents that failed in the meantime, so it
  must ship in migration 0003, before ingest.
- **Security consequence.** Neutral on isolation. It does remove a self-inflicted denial of service:
  under (a), a 50-page PDF of one repeated page permanently wedges its own pipeline at the cost of one
  upload.
- **Config/env consequence.** None.

### D-F1-12 — Uniqueness defect B: the identity of a document, a run, a job and an attempt

- **Competing proposals.** (a) `g` §5.5's fix: a mutable `Document.requeueCount` stamped into a
  `dedupeKey` string. (b) The panel's fix: add a `runSeq` discriminator to the OCR evidence key.
  (c) Make the current OCR key partial on `WHERE deterministic`. (d) A first-class `DocumentRun`
  entity that owns the generation, with every job and every piece of evidence pointing at it.
- **Selected.** (d), which subsumes (b).
- **Rejected.**
  - (a) — `requeueCount` is a mutable counter on a hot row. Two operators requeueing within the same
    second read the same value, stamp the same key, and one gets a 23505 on the *job* table with no
    way to tell "already queued" from "lost a race". It also gives evidence rows nothing to point at.
  - (b) alone — a bare `runSeq Int` on `ocr_results` with no parent row is exactly the "bare scalar
    with no relation" pattern the panel condemned in the same verdict; nothing constrains it to agree
    with the job that produced it.
  - (c) — makes the key depend on a boolean that the worker computes at startup by self-checking the
    engine. A worker that flips `deterministic` mid-fleet changes which rows are unique.
- **Reason and the four identities, stated once:**
  | Concept | Definition | Table | Identity |
  |---|---|---|---|
  | **Document** | The uploaded artefact. One identity for its whole life, across every reprocessing. | `documents` | `id` |
  | **Run** | One end-to-end processing pass over that document. A requeue creates a new run. | `document_runs` | `id`, ordered by `(document_id, run_seq)` |
  | **Job** | One unit of work inside one run (render, OCR pages 1–20, analyse). | `extraction_jobs` | `id`, deduped by `(organization_id, dedupe_key)` |
  | **Attempt** | One execution of one job by one worker. Not a row of its own. | `extraction_jobs.attempts` + `job_events` | `(job_id, attempt)` |
- **Implementation consequence.** `Document.requeueCount` is **deleted**. `dedupeKey` is derived from
  `runId`, not from a counter: `"{runId}:{kind}:{pageFrom|*}-{pageTo|*}"`. `ocr_results.run_id` and
  `document_analyses.run_id` are NOT NULL with composite FKs. At most one `RUNNING` run per document
  (partial unique index), so a requeue must cancel the live run in the same transaction or receive a
  distinct, loud `23505` that the API maps to `409 run_in_progress` — a correct refusal, not a wedge.
  `run_seq` is allocated under `SELECT 1 FROM documents WHERE id = $1 FOR NO KEY UPDATE` so there is
  no retry loop.
- **Migration consequence.** **Un-backfillable.** Adding `run_id NOT NULL` to `ocr_results` after
  evidence exists requires inventing a run for rows that never had one. `document_runs` must exist in
  migration 0004, before the first job.
- **Security consequence.** Indirect but real: under `g`'s shape, `FAILED → QUEUED` is the only
  recovery edge, so a document that hits the collision is permanently stuck and the only exit is
  deletion — which destroys evidence a customer may be legally required to retain.
- **Config/env consequence.** None.

### D-F1-13 — The not-found rule *(resolves contradiction 9)*

- **Competing proposals.** (a) `l` §2.1: 404 cross-tenant, **403 `insufficient_scope`** for
  same-tenant-but-not-permitted. (b) `j` §7.1.1: 404 for intra-tenant invisible, "exactly like one in
  another tenant". (c) Blanket 404 everywhere.
- **Selected.** A single rule that makes both correct, stated as one sentence:
  > **404 when the principal has not already been told the resource exists. 403 only when it has.**

  | Situation | Status | Code |
  |---|---|---|
  | Not authenticated | **401** | `unauthenticated` |
  | Resource does not exist | **404** | `not_found` |
  | Exists, different organization | **404** | `not_found` |
  | Exists, same organization, **not visible** to this principal | **404** | `not_found` |
  | Malformed or wrongly-prefixed identifier | **404** | `not_found` |
  | Exists, same organization, **visible** to this principal, but the principal lacks the *operation* scope (approve / export / delete / requeue) | **403** | `insufficient_scope` |
- **Rejected.** (a) as written — it returns 403 for a same-tenant document the caller cannot see,
  which tells a curious employee exactly which document ids their colleagues are working on: an
  existence oracle with an org chart attached. (c) — a blanket 404 on "you can see it in the list but
  you may not approve it" is the support nightmare `l` correctly identified.
- **Reason.** The two documents were answering different questions. `l` assumed everything in a tenant
  is listable (true under `g`'s tenant-only model, false under this one). Once visibility exists,
  "listable to this principal" is the exact boundary between the two codes, and it is already computed
  by the chokepoint.
- **Implementation consequence.** 404 falls out for free: the chokepoint's filter returns `null`,
  `mustFind` throws `NotFoundError`, one translation point maps it. 403 is thrown *after* a successful
  resolve, by a capability check on the returned `DocumentRef`. There is deliberately no
  `CrossTenantError` type — it is unrepresentable. **The malformed-identifier row overrides `l`
  §1.2's "a `doc_` prefix on a template id is a 400, not a 404"**: one path, one body, no shape oracle.
- **Migration consequence.** None.
- **Security consequence.** Closes the intra-tenant existence oracle while keeping the legitimate
  permission error legible.
- **Config/env consequence.** None.

### D-F1-14 — The timing side channel on 404

- **Competing proposals.** (a) `l` §2.2: "they are the same query, so timing is not meaningfully
  distinguishable… we do not add artificial delay." (b) A fixed response-time floor on the 404 path.
  (c) Constant-time for all responses.
- **Selected.** (b), floor `RES_404_MIN_MS = 25`.
- **Rejected.** (a) — it is **wrong under this design**, and the owner is right to have flagged it.
  A nonexistent `public_id` misses the `document_public_id_key` index probe immediately. An existing
  but invisible one **hits** the index, fetches the heap tuple, evaluates the visibility predicate,
  and on the grant branch performs a second index probe into `document_grants`. That is one extra heap
  fetch plus up to one extra index probe: on the order of **10–50 µs**. Small, non-zero, and
  repeatable — which is the definition of an oracle. (c) — constant-time for *all* responses would
  bound the whole API by its slowest path; the leak we care about is confined to the not-found path.
- **Reason.** 25 ms is ~500× the measured signal and ~2× typical LAN + TLS + framework jitter, so it
  collapses the distinguisher into noise that cannot be averaged out in a practical number of
  requests. It is also cheap: a 404 is not on any latency-sensitive path.
- **Implementation consequence.** In the single error-translation point: on `NotFoundError`,
  `await setTimeout(Math.max(0, 25 - elapsedMs))` from `node:timers/promises` (non-blocking; never
  `Atomics.wait`). Response bodies must be **byte-identical** — same `error.code`, same `message`
  (`"Not found"`, constant, never echoing the id), no `ETag`, no `Cache-Control` variance, no
  duration header. A regression test asserts byte-equality between the cross-org 404 and the
  random-id 404 for every route in the route table.
- **Migration consequence.** None.
- **Security consequence.** Also add the volumetric control the timing floor cannot provide:
  **20 `not_found` responses from one principal within 60 s** raises a `SEC_ENUMERATION_SUSPECTED`
  audit event and applies a 30 s per-principal cooldown on document routes. This is the control that
  actually stops a scan; the floor only stops a confirmation.
- **Config/env consequence.** `RES_404_MIN_MS=25` (accepted range `0`–`250`; `0` permitted **only**
  when `NODE_ENV=test`, otherwise boot refusal), `SEC_ENUM_WINDOW_SECONDS=60`,
  `SEC_ENUM_THRESHOLD=20`, `SEC_ENUM_COOLDOWN_SECONDS=30`.

### D-F1-15 — Admin scope: tenant-scoped, never ambient

- **Competing proposals.** (a) `g`: no admin concept in the schema. (b) The panel: an
  `app.is_org_admin = 'on'` GUC set by the authorization port for any admin request. (c) A global
  platform admin who can read any tenant. (d) Admin is tenant-scoped, ambient for *metadata*, and
  requires an explicit, reason-required, time-boxed, audited elevation for *content*.
- **Selected.** (d).
- **Rejected.** (b) — "set by the authorization port for any admin request" is ambient by another
  name: every request an admin makes would carry omniscience, and the audit log would record 100 %
  of admin traffic, which is the same as recording none. (c) — a global tenant-crossing role in the
  schema is the single largest standing breach surface in a PDPA product, and `j` §9.3 already
  requires that platform access be reason-logged.
- **Reason.** The owner asked two questions: *is an admin scoped to a tenant or global?* and *is admin
  content access audited or ambient?* Answers: **tenant-scoped**, and **audited**.
  - `OrgRole.ADMIN` and `OrgRole.OWNER` exist only on a `Membership`, so they are scoped to exactly
    one organization by the same FK that scopes everything else. There is no global org role.
  - INNOVERA staff are **not** members. They are `platform_staff` rows with a `PlatformRole`, and they
    have **no ambient read of any document**. Staff access requires an `AdminAccessGrant` row (below),
    and it is subject to the same 404 rule until that grant exists.
  - An org admin's normal request is *not* elevated: `app.is_org_admin` stays `'off'`, so their
    document list is their own visible set. Reading outside it goes through
    `DocumentAccess.findWithAdminOverride(principal, publicId, reason)` — the **only** function in the
    codebase that sets `app.is_org_admin = 'on'`, and it writes the `AdminAccessLog` row in the same
    transaction before returning.
- **Implementation consequence.** `withAdminOverride()` lives in the same module as `withPrincipal()`
  and is not exported from the package barrel; a `dependency-cruiser` rule allows exactly
  `src/modules/documents/infrastructure/document-access.ts` to import it.
  Numeric parameters: elevation TTL **60 minutes**, `reason` minimum **20 characters**, maximum
  **4** concurrent active elevations per principal, alert at **50** elevated reads per principal per
  hour (`j` §9.3's volume anomaly, made numeric).
- **Migration consequence.** `admin_access_logs` is append-only by grant (`ocr_app` has no `UPDATE`
  or `DELETE`), and it is one of the tables whose retention is 7 years — see
  `gate-2-pdpa-retention.md` for the erasure mechanism; the *period* is owned by the storage
  dimension. Must be created before the first admin exists.
- **Security consequence.** Makes casual browsing feel like what it is (`j` §9.3), and makes
  "did anyone look at my HR folder?" answerable. `AdminAccessLog` is visible to the tenant's own
  `OWNER` from M5.
- **Config/env consequence.** `ADMIN_OVERRIDE_TTL_MINUTES=60`, `ADMIN_OVERRIDE_REASON_MIN_CHARS=20`,
  `ADMIN_OVERRIDE_MAX_CONCURRENT=4`, `ADMIN_OVERRIDE_ALERT_READS_PER_HOUR=50`.

### D-F1-16 — Partial indexes are authored as raw SQL, not with Prisma's `partialIndexes` preview flag

- **Competing proposals.** (a) `@@unique([...], where: …)` behind the `partialIndexes` preview flag
  (available since Prisma 7.4.0; we pin 7.9.1, so it exists). (b) Hand-authored
  `CREATE UNIQUE INDEX … WHERE …` in the migration, with a drift allowlist and a post-migrate
  assertion.
- **Selected.** (b).
- **Rejected.** (a). Two open upstream defects make it the riskier path for *authorization-bearing*
  indexes: prisma/prisma#29263 (partial indexes dropped and recreated on every migration in 7.4.x) and
  prisma/prisma#29282 (partial unique indexes excluded from DMMF `uniqueFields`/`uniqueIndexes`, so
  `findUnique` input types are not generated for them anyway). A drop-and-recreate on
  `document_grant_doc_membership_key` is a window in which duplicate grants can land.
- **Reason.** We need seven partial indexes and five of them carry an authorization or a
  correctness invariant. An index that CI can prove exists is worth more than an index the schema
  language can express.
- **Implementation consequence.** The seven indexes live in migration SQL. Because Prisma does not
  know they are unique, every write that relies on them uses raw `INSERT … ON CONFLICT (cols) WHERE
  predicate` from the allowlisted `db/raw/**` folder (PostgreSQL infers a partial unique index when
  the conflict target repeats its predicate).
- **Migration consequence.** They are invisible to `prisma migrate diff`, so each one goes on the
  documented drift allowlist and is asserted by a post-deploy `DO $$ … $$` block that reads
  `pg_indexes.indexdef` and raises if any is missing or altered (§6.7).
- **Security consequence.** Removes a silent-drop window on the grant and workspace-member uniqueness.
- **Config/env consequence.** None. The `partialIndexes` preview flag is **not** enabled.

### D-F1-17 — The list-query plan, and the escape hatch that is additive by construction

- **Competing proposals.** (a) One OR-chain, planned as a `BitmapOr` across three indexes plus a
  semi-join into `document_grants`. (b) A `UNION ALL` of four keyset-paginated branches (raw SQL).
  (c) A denormalised `document_visibility_index` fan-out table maintained by trigger, from day one.
- **Selected.** (a) for M1, with (c) named as a **planned additive change** behind two numeric
  triggers.
- **Rejected.** (b) — it requires raw SQL, which D-F1-10 bans on this exact path. (c) from day one —
  it is a second write path on every membership change, every workspace change and every visibility
  change, for a performance problem we have not yet measured; and it is the classic source of
  "the index says you can see it, the table says you cannot".
- **Reason.** The predicate has three index-servable branches plus one semi-join. PostgreSQL will
  bitmap-OR the three and probe `document_grant_org_grantee_idx` for the fourth. The cost that
  actually grows is the sort: no single index provides `created_at DESC` ordering across the union, so
  the planner sorts the matched set. At a per-organization corpus of ~240 000 documents/year with a
  principal typically matching ~10 % of it, that is a ~24 000-row sort — single-digit milliseconds.
- **Implementation consequence.** Four indexes (§7.6), one of them partial on
  `visibility = 'ORGANIZATION'`.
- **Migration consequence.** The escape hatch is a **new table**, not a change to `documents`, so it is
  additive and reversible. That is what keeps "no retrofit-required design" honest rather than
  aspirational.
- **Security consequence.** None in M1. If (c) is ever built, it becomes a second authorization
  surface and must be covered by the §6.6 equivalence test on every write path.
- **Config/env consequence.** Trigger to reconsider: **p95 of `GET /api/documents` > 300 ms** over a
  1-hour window, **or** any single organization exceeding **100 000** non-deleted documents. Both are
  emitted as metrics from M2.

---

## 3. The entity model — Prisma 7.9.1

House conventions inherited verbatim from `~/Documents/jawbong/prisma/schema.prisma`: `@db.Uuid` ids
generated in application code, `@map`ped snake_case columns, `@db.Timestamptz(3)`, `@@map`ped
snake_case tables, every index and constraint explicitly `map`ped and commented with the query it
serves.

### 3.1 Enums

```prisma
enum OrgRole        { OWNER ADMIN MEMBER }
enum WorkspaceKind  { PERSONAL SHARED }
enum WorkspaceRole  { MANAGER REVIEWER CONTRIBUTOR VIEWER }
enum DocumentVisibility { PRIVATE WORKSPACE ORGANIZATION }
enum GranteeKind    { USER API_KEY }
enum PlatformRole   { SUPPORT ENGINEER SECURITY }
enum RunTrigger     { INITIAL_UPLOAD OPERATOR_REQUEUE ENGINE_UPGRADE TEMPLATE_CHANGE API_REPROCESS }
enum RunOutcome     { RUNNING SUCCEEDED FAILED CANCELLED }
```

`OrgRole` is deliberately three values. `MEMBER` is the working role; `ADMIN` administers the
organization (workspaces, memberships, API keys, settings) and may elevate to read content;
`OWNER` additionally owns billing, may delete the organization, and may change
`defaultDocumentVisibility`. Approval authority is **not** here — it is `WorkspaceRole.REVIEWER`,
`WorkspaceRole.MANAGER`, or `DocumentGrant.canApprove`, because reading must never imply approving
(`j` §7.6).

### 3.2 Organization, User, Membership

```prisma
model Organization {
  id                        String             @id @db.Uuid
  slug                      String             @unique(map: "organization_slug_key") @db.VarChar(80)
  name                      String             @db.VarChar(200)
  status                    OrgStatus          @default(ACTIVE)
  defaultDocumentVisibility DocumentVisibility @default(WORKSPACE) @map("default_document_visibility")
  dataRegion                String             @default("ap-southeast-1") @map("data_region") @db.VarChar(24)
  createdAt                 DateTime           @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt                 DateTime           @updatedAt @map("updated_at") @db.Timestamptz(3)
  deletedAt                 DateTime?          @map("deleted_at") @db.Timestamptz(3)

  memberships Membership[]
  workspaces  Workspace[]
  apiKeys     ApiKey[]
  documents   Document[]

  @@index([status, createdAt], map: "organization_status_created_idx")
  @@map("organizations")
}
// `retentionDays` is deliberately ABSENT here: retention is owned by gate-2-pdpa-retention.md and the
// storage dimension. Do not reintroduce it in this table without reading that document first.

model User {
  id              String     @id @db.Uuid
  email           String     @unique(map: "user_email_key") @db.VarChar(320)
  emailVerifiedAt DateTime?  @map("email_verified_at") @db.Timestamptz(3)
  displayName     String     @map("display_name") @db.VarChar(200)
  locale          String     @default("th-TH") @db.VarChar(12)
  timeZone        String     @default("Asia/Bangkok") @map("time_zone") @db.VarChar(48)
  status          UserStatus @default(ACTIVE)
  createdAt       DateTime   @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt       DateTime   @updatedAt @map("updated_at") @db.Timestamptz(3)
  deletedAt       DateTime?  @map("deleted_at") @db.Timestamptz(3)

  memberships   Membership[]
  ownedDocuments Document[] @relation("DocumentOwnerUser")

  @@map("users")
}

model Membership {
  id                 String    @id @db.Uuid
  organizationId     String    @map("organization_id") @db.Uuid
  userId             String    @map("user_id") @db.Uuid
  role               OrgRole   @default(MEMBER)
  defaultWorkspaceId String?   @map("default_workspace_id") @db.Uuid   // NOT NULL at COMMIT — see §4.3
  invitedByMembershipId String? @map("invited_by_membership_id") @db.Uuid
  joinedAt           DateTime  @default(now()) @map("joined_at") @db.Timestamptz(3)
  revokedAt          DateTime? @map("revoked_at") @db.Timestamptz(3)
  createdAt          DateTime  @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt          DateTime  @updatedAt @map("updated_at") @db.Timestamptz(3)

  organization     Organization @relation(fields: [organizationId], references: [id], onDelete: Restrict)
  user             User         @relation(fields: [userId], references: [id], onDelete: Restrict)
  invitedBy        Membership?  @relation("MembershipInviter",
                                          fields: [invitedByMembershipId, organizationId],
                                          references: [id, organizationId], onDelete: NoAction, onUpdate: NoAction)
  invitees         Membership[] @relation("MembershipInviter")
  personalWorkspace Workspace?  @relation("PersonalWorkspaceOwner")
  workspaceMembers WorkspaceMember[] @relation("WorkspaceMemberOf")
  addedWorkspaceMembers WorkspaceMember[] @relation("WorkspaceMemberAddedBy")
  ownedDocuments   Document[]   @relation("DocumentOwnerMembership")
  issuedGrants     DocumentGrant[] @relation("GrantIssuer")
  receivedGrants   DocumentGrant[] @relation("GrantGrantee")
  ownedApiKeys     ApiKey[]     @relation("ApiKeyOwner")

  @@unique([id, organizationId], map: "membership_id_org_key")   // composite-FK anchor (TEN-1)
  @@unique([organizationId, userId], map: "membership_org_user_key")
  // Query: authorization — "is this user a member of this org, and with what role?" One probe per request.
  @@index([userId, revokedAt], map: "membership_user_revoked_idx")
  // Query: post-login organization picker — WHERE user_id=$1 AND revoked_at IS NULL.
  @@index([organizationId, role, revokedAt], map: "membership_org_role_idx")
  // Query: "who are the admins of this org?" — the elevation-alerting and offboarding path.
  @@map("memberships")
}
```

`User.onDelete: Restrict` (not `Cascade` as in `g` §5.3): deleting a user row must not silently
destroy the membership that anchors document ownership. User erasure is a pseudonymisation, not a
row delete — see the challenge in §12.

### 3.3 Workspace and WorkspaceMember

```prisma
model Workspace {
  id                String        @id @db.Uuid
  organizationId    String        @map("organization_id") @db.Uuid
  kind              WorkspaceKind
  slug              String        @db.VarChar(80)
  name              String        @db.VarChar(200)
  ownerMembershipId String?       @map("owner_membership_id") @db.Uuid   // set IFF kind = PERSONAL
  archivedAt        DateTime?     @map("archived_at") @db.Timestamptz(3)
  createdAt         DateTime      @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt         DateTime      @updatedAt @map("updated_at") @db.Timestamptz(3)

  organization    Organization @relation(fields: [organizationId], references: [id], onDelete: Restrict)
  ownerMembership Membership?  @relation("PersonalWorkspaceOwner",
                                         fields: [ownerMembershipId, organizationId],
                                         references: [id, organizationId], onDelete: NoAction, onUpdate: NoAction)
  members   WorkspaceMember[]
  documents Document[]
  apiKeys   ApiKey[]

  @@unique([id, organizationId], map: "workspace_id_org_key")      // composite-FK anchor (TEN-1)
  @@unique([organizationId, slug], map: "workspace_org_slug_key")
  // Query: /w/{slug} routing and duplicate-name rejection inside one organization.
  @@index([organizationId, kind, archivedAt], map: "workspace_org_kind_idx")
  // Query: the workspace switcher — WHERE organization_id=$1 AND kind='SHARED' AND archived_at IS NULL.
  @@map("workspaces")
}

model WorkspaceMember {
  id                  String        @id @db.Uuid
  organizationId      String        @map("organization_id") @db.Uuid
  workspaceId         String        @map("workspace_id") @db.Uuid
  membershipId        String        @map("membership_id") @db.Uuid
  role                WorkspaceRole @default(CONTRIBUTOR)
  addedByMembershipId String?       @map("added_by_membership_id") @db.Uuid
  createdAt           DateTime      @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt           DateTime      @updatedAt @map("updated_at") @db.Timestamptz(3)
  revokedAt           DateTime?     @map("revoked_at") @db.Timestamptz(3)

  workspace  Workspace  @relation(fields: [workspaceId, organizationId],
                                  references: [id, organizationId], onDelete: Cascade, onUpdate: NoAction)
  membership Membership @relation("WorkspaceMemberOf",
                                  fields: [membershipId, organizationId],
                                  references: [id, organizationId], onDelete: Cascade, onUpdate: NoAction)
  addedBy    Membership? @relation("WorkspaceMemberAddedBy",
                                  fields: [addedByMembershipId, organizationId],
                                  references: [id, organizationId], onDelete: NoAction, onUpdate: NoAction)

  @@unique([id, organizationId], map: "workspace_member_id_org_key")
  @@index([organizationId, membershipId, revokedAt], map: "workspace_member_org_membership_idx")
  // Query: THE hot path — build the principal's workspace set at session/API-key resolution.
  //        WHERE organization_id=$1 AND membership_id=$2 AND revoked_at IS NULL.
  @@index([workspaceId, role, revokedAt], map: "workspace_member_ws_role_idx")
  // Query: "who can approve in this workspace?" and the workspace member list screen.
  @@map("workspace_members")
}
```

**Why `membershipId` and not `userId`.** A `user_id` column would need a FK into the global `users`
table, which cannot carry `organization_id`, so nothing would prevent adding a user who is not a
member of the workspace's organization. Keying on `membership_id` makes that a foreign-key violation.
This is invariant TEN-1 applied to the authorization tables themselves.

### 3.4 ApiKey — a key is not a person, and that is the point

```prisma
model ApiKey {
  id                 String             @id @db.Uuid
  organizationId     String             @map("organization_id") @db.Uuid
  workspaceId        String             @map("workspace_id") @db.Uuid          // NOT NULL
  ownerMembershipId  String             @map("owner_membership_id") @db.Uuid   // NOT NULL
  name               String             @db.VarChar(120)
  keyPrefix          String             @unique(map: "api_key_prefix_key") @map("key_prefix") @db.VarChar(16)
  keyHash            String             @map("key_hash") @db.VarChar(64)
  scopes             String[]           @db.VarChar(60)
  defaultVisibility  DocumentVisibility @default(WORKSPACE) @map("default_visibility")
  rateLimitPerMinute Int                @default(60) @map("rate_limit_per_minute")
  expiresAt          DateTime?          @map("expires_at") @db.Timestamptz(3)
  lastUsedAt         DateTime?          @map("last_used_at") @db.Timestamptz(3)
  revokedAt          DateTime?          @map("revoked_at") @db.Timestamptz(3)
  createdAt          DateTime           @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt          DateTime           @updatedAt @map("updated_at") @db.Timestamptz(3)

  organization    Organization @relation(fields: [organizationId], references: [id], onDelete: Restrict)
  workspace       Workspace    @relation(fields: [workspaceId, organizationId],
                                         references: [id, organizationId], onDelete: Restrict, onUpdate: NoAction)
  ownerMembership Membership   @relation("ApiKeyOwner", fields: [ownerMembershipId, organizationId],
                                         references: [id, organizationId], onDelete: Restrict, onUpdate: NoAction)
  createdDocuments Document[]      @relation("DocumentCreatedByApiKey")
  receivedGrants   DocumentGrant[] @relation("GrantGranteeApiKey")

  @@unique([id, organizationId], map: "api_key_id_org_key")   // composite-FK anchor (TEN-1)
  @@index([organizationId, revokedAt], map: "api_key_org_revoked_idx")
  @@index([organizationId, ownerMembershipId], map: "api_key_org_owner_idx")
  // Query: offboarding — "revoke every key this leaver owns."
  @@map("api_keys")
}
```

This is the concrete answer to *"authorization must not depend solely on userId"*. An API-key
principal's authority comes from **its own row** — one bound workspace, its own scopes, its own
grants — not from the human who created it. `ownerMembershipId` exists for accountability and
offboarding, and is deliberately **not** consulted by the visibility predicate: an API key never sees
its owner's private documents.

The `ocr_live_` presented-key format, prefix/hash mechanics and rotation are owned by
`j-security-threat-model.md` §8 and §12.3 — cited, not restated.

### 3.5 Document — the delta from `g` §5.4

Only the ownership/visibility surface is restated here. Every other column on `Document`
(`publicId` excepted, see D-F1-7), the status machine, filenames, hashes and page counts remain as
owned by their dimensions.

```prisma
model Document {
  id                String             @id @db.Uuid
  publicId          String             @unique(map: "document_public_id_key") @map("public_id") @db.VarChar(32)
  organizationId    String             @map("organization_id") @db.Uuid

  // ---- ownership (facts; immutable after insert, enforced by trigger) ----
  ownerMembershipId String             @map("owner_membership_id") @db.Uuid   // NOT NULL
  ownerUserId       String             @map("owner_user_id") @db.Uuid         // NOT NULL, DERIVED, never read by authz
  createdByApiKeyId String?            @map("created_by_api_key_id") @db.Uuid

  // ---- containment + policy (mutable; every change writes an audit row) ----
  workspaceId       String             @map("workspace_id") @db.Uuid          // NOT NULL
  visibility        DocumentVisibility @default(WORKSPACE)

  currentRunId      String?            @map("current_run_id") @db.Uuid
  // `requeueCount` is DELETED — superseded by DocumentRun.runSeq (D-F1-12).

  // ... status, filenames, hashes, pageCount, templateId, timestamps: unchanged, owned elsewhere ...

  organization    Organization @relation(fields: [organizationId], references: [id], onDelete: Restrict)
  ownerMembership Membership   @relation("DocumentOwnerMembership",
                                         fields: [ownerMembershipId, organizationId],
                                         references: [id, organizationId], onDelete: Restrict, onUpdate: NoAction)
  ownerUser       User         @relation("DocumentOwnerUser", fields: [ownerUserId], references: [id], onDelete: Restrict)
  workspace       Workspace    @relation(fields: [workspaceId, organizationId],
                                         references: [id, organizationId], onDelete: Restrict, onUpdate: NoAction)
  createdByApiKey ApiKey?      @relation("DocumentCreatedByApiKey",
                                         fields: [createdByApiKeyId, organizationId],
                                         references: [id, organizationId], onDelete: SetNull, onUpdate: NoAction)
  grants          DocumentGrant[]
  runs            DocumentRun[]
  // ... pages, jobs, analyses, fieldValues, corrections: unchanged ...

  @@unique([id, organizationId], map: "document_id_org_key")   // composite-FK anchor (TEN-1)
  @@map("documents")
}
```

`createdByApiKey` uses `onDelete: SetNull` on a **nullable** composite FK. That is safe here and only
here: PostgreSQL foreign keys default to `MATCH SIMPLE`, under which a row whose FK columns are not
all non-NULL is not checked — but `SetNull` on a composite FK nulls **both** columns, including the
NOT NULL `organization_id`. To avoid the `23502` that `g` §5.4 correctly identified, API keys are
**never hard-deleted**; they are revoked (`revoked_at`). The `onDelete: SetNull` therefore never
fires and is present only to make the intent explicit if a future hard-delete is added. A CI test
asserts `DELETE FROM api_keys` is not granted to `ocr_app`.

### 3.6 DocumentGrant

```prisma
model DocumentGrant {
  id                    String      @id @db.Uuid
  organizationId        String      @map("organization_id") @db.Uuid
  documentId            String      @map("document_id") @db.Uuid
  granteeKind           GranteeKind @map("grantee_kind")
  granteeMembershipId   String?     @map("grantee_membership_id") @db.Uuid
  granteeApiKeyId       String?     @map("grantee_api_key_id") @db.Uuid
  canApprove            Boolean     @default(false) @map("can_approve")
  canExport             Boolean     @default(false) @map("can_export")
  grantedByMembershipId String      @map("granted_by_membership_id") @db.Uuid
  reason                String?     @db.VarChar(400)
  expiresAt             DateTime?   @map("expires_at") @db.Timestamptz(3)
  revokedAt             DateTime?   @map("revoked_at") @db.Timestamptz(3)
  createdAt             DateTime    @default(now()) @map("created_at") @db.Timestamptz(3)

  document        Document    @relation(fields: [documentId, organizationId],
                                        references: [id, organizationId], onDelete: Cascade, onUpdate: NoAction)
  granteeMembership Membership? @relation("GrantGrantee",
                                        fields: [granteeMembershipId, organizationId],
                                        references: [id, organizationId], onDelete: Cascade, onUpdate: NoAction)
  granteeApiKey   ApiKey?     @relation("GrantGranteeApiKey",
                                        fields: [granteeApiKeyId, organizationId],
                                        references: [id, organizationId], onDelete: Cascade, onUpdate: NoAction)
  grantedBy       Membership  @relation("GrantIssuer",
                                        fields: [grantedByMembershipId, organizationId],
                                        references: [id, organizationId], onDelete: Restrict, onUpdate: NoAction)

  @@unique([id, organizationId], map: "document_grant_id_org_key")
  @@index([organizationId, granteeMembershipId, revokedAt], map: "document_grant_org_grantee_idx")
  // Query: THE grant branch of the visibility predicate, and "what has been shared with me?"
  @@index([organizationId, granteeApiKeyId, revokedAt], map: "document_grant_org_grantee_key_idx")
  @@index([documentId], map: "document_grant_doc_idx")
  // Query: the sharing panel — "who can see this document?"
  @@index([expiresAt], map: "document_grant_expires_idx")
  // Query: the expiry sweeper — WHERE expires_at < now() AND revoked_at IS NULL LIMIT 1000.
  @@map("document_grants")
}
```

### 3.7 DocumentRun

```prisma
model DocumentRun {
  id                      String     @id @db.Uuid
  organizationId          String     @map("organization_id") @db.Uuid
  documentId              String     @map("document_id") @db.Uuid
  runSeq                  Int        @map("run_seq")
  trigger                 RunTrigger
  triggeredByMembershipId String?    @map("triggered_by_membership_id") @db.Uuid   // NULL for INITIAL_UPLOAD by API key
  triggeredByApiKeyId     String?    @map("triggered_by_api_key_id") @db.Uuid
  reason                  String?    @db.VarChar(400)
  pipelineVersion         String     @map("pipeline_version") @db.VarChar(60)
  outcome                 RunOutcome @default(RUNNING)
  startedAt               DateTime   @default(now()) @map("started_at") @db.Timestamptz(3)
  finishedAt              DateTime?  @map("finished_at") @db.Timestamptz(3)

  document            Document    @relation(fields: [documentId, organizationId],
                                            references: [id, organizationId], onDelete: Cascade, onUpdate: NoAction)
  triggeredByMembership Membership? @relation("RunTriggeredBy",
                                            fields: [triggeredByMembershipId, organizationId],
                                            references: [id, organizationId], onDelete: NoAction, onUpdate: NoAction)
  triggeredByApiKey   ApiKey?     @relation("RunTriggeredByApiKey",
                                            fields: [triggeredByApiKeyId, organizationId],
                                            references: [id, organizationId], onDelete: NoAction, onUpdate: NoAction)
  jobs       ExtractionJob[]
  ocrResults OcrResult[]
  analyses   DocumentAnalysis[]

  @@unique([id, organizationId], map: "document_run_id_org_key")     // composite-FK anchor (TEN-1)
  @@unique([documentId, runSeq], map: "document_run_doc_seq_key")
  // Query: "run 3 of this document", and the anti-race guard on requeue.
  @@index([organizationId, outcome, startedAt(sort: Desc)], map: "document_run_org_outcome_idx")
  // Query: ops dashboard — WHERE organization_id=$1 AND outcome='RUNNING' ORDER BY started_at DESC.
  @@map("document_runs")
}
```

### 3.8 Admin elevation

```prisma
model PlatformStaff {
  id        String       @id @db.Uuid
  userId    String       @unique(map: "platform_staff_user_key") @map("user_id") @db.Uuid
  role      PlatformRole
  createdAt DateTime     @default(now()) @map("created_at") @db.Timestamptz(3)
  revokedAt DateTime?    @map("revoked_at") @db.Timestamptz(3)

  @@map("platform_staff")
}
// GLOBAL, not tenant-scoped. Carries NO ambient read of any document: a PlatformStaff row grants the
// ability to REQUEST an AdminAccessGrant, nothing more. Until a grant exists, staff receive 404 on
// every tenant document, identically to any other principal.

model AdminAccessGrant {
  id                String    @id @db.Uuid
  organizationId    String    @map("organization_id") @db.Uuid
  subjectUserId     String    @map("subject_user_id") @db.Uuid
  grantedByUserId   String    @map("granted_by_user_id") @db.Uuid
  reason            String    @db.VarChar(400)
  expiresAt         DateTime  @map("expires_at") @db.Timestamptz(3)
  revokedAt         DateTime? @map("revoked_at") @db.Timestamptz(3)
  createdAt         DateTime  @default(now()) @map("created_at") @db.Timestamptz(3)

  @@index([organizationId, subjectUserId, expiresAt], map: "admin_access_grant_org_subject_idx")
  @@map("admin_access_grants")
}

model AdminAccessLog {
  id             String   @id @db.Uuid
  organizationId String   @map("organization_id") @db.Uuid
  actorUserId    String   @map("actor_user_id") @db.Uuid
  actorKind      String   @map("actor_kind") @db.VarChar(20)   // 'ORG_ADMIN' | 'PLATFORM_STAFF'
  documentId     String?  @map("document_id") @db.Uuid
  action         String   @db.VarChar(60)
  reason         String   @db.VarChar(400)
  correlationId  String   @map("correlation_id") @db.VarChar(64)
  at             DateTime @default(now()) @db.Timestamptz(3)

  @@index([organizationId, at(sort: Desc)], map: "admin_access_log_org_at_idx")
  // Query: the tenant-visible "who looked at our data" report (M5).
  @@index([actorUserId, at(sort: Desc)], map: "admin_access_log_actor_at_idx")
  // Query: the volume-anomaly alert — 50 reads/principal/hour.
  @@map("admin_access_logs")
}
// APPEND-ONLY BY GRANT: ocr_app holds INSERT and SELECT only. No UPDATE, no DELETE, ever.
```

---

## 4. Constraints, triggers and checks that Prisma cannot express

All of these live in a hand-written migration and go on the drift allowlist (D-F1-16).

### 4.1 Shape and pairing CHECKs

```sql
-- The external identifier: exactly the Crockford base32 alphabet, exactly 32 characters.
ALTER TABLE documents ADD CONSTRAINT document_public_id_shape
  CHECK (public_id ~ '^[0-9A-HJKMNP-TV-Z]{32}$');

-- A personal workspace has an owner; a shared workspace does not.
ALTER TABLE workspaces ADD CONSTRAINT workspace_owner_pairing
  CHECK ((kind = 'PERSONAL' AND owner_membership_id IS NOT NULL)
      OR (kind = 'SHARED'   AND owner_membership_id IS NULL));

-- A grant has exactly one grantee, of the declared kind.
ALTER TABLE document_grants ADD CONSTRAINT document_grant_grantee_exactly_one
  CHECK ((grantee_kind = 'USER'    AND grantee_membership_id IS NOT NULL AND grantee_api_key_id     IS NULL)
      OR (grantee_kind = 'API_KEY' AND grantee_api_key_id     IS NOT NULL AND grantee_membership_id IS NULL));

-- A grant cannot expire before it is created.
ALTER TABLE document_grants ADD CONSTRAINT document_grant_expiry_sane
  CHECK (expires_at IS NULL OR expires_at > created_at);

-- An admin elevation is bounded: 60 minutes, and the reason is 20 characters of prose.
ALTER TABLE admin_access_grants ADD CONSTRAINT admin_grant_ttl_bounded
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '60 minutes');
ALTER TABLE admin_access_grants ADD CONSTRAINT admin_grant_reason_length
  CHECK (char_length(btrim(reason)) >= 20);
ALTER TABLE admin_access_logs   ADD CONSTRAINT admin_log_reason_length
  CHECK (char_length(btrim(reason)) >= 20);

-- Run sequence starts at 1 and is monotonic.
ALTER TABLE document_runs ADD CONSTRAINT document_run_seq_positive CHECK (run_seq >= 1);

-- The job dedupe key grammar (D-F1-12). Rejects a hand-built key that omits the run.
ALTER TABLE extraction_jobs ADD CONSTRAINT job_dedupe_key_shape
  CHECK (dedupe_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[A-Z_]{1,40}:(\*|[0-9]{1,5})-(\*|[0-9]{1,5})$');
```

### 4.2 Immutability of ownership

```sql
CREATE OR REPLACE FUNCTION assert_document_ownership_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.organization_id     IS DISTINCT FROM OLD.organization_id
  OR NEW.owner_membership_id IS DISTINCT FROM OLD.owner_membership_id
  OR NEW.owner_user_id       IS DISTINCT FROM OLD.owner_user_id THEN
    RAISE EXCEPTION 'DOCUMENT_OWNERSHIP_IMMUTABLE' USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER document_ownership_immutable
  BEFORE UPDATE ON documents FOR EACH ROW
  EXECUTE FUNCTION assert_document_ownership_immutable();
```

`workspace_id` and `visibility` are deliberately **not** in this trigger: moving a document between
workspaces and changing its visibility are legitimate product actions. Both go through use cases that
write an `AuditLog` row in the same transaction, and both require `WorkspaceRole.MANAGER` in the
*source* workspace or `OrgRole.ADMIN|OWNER`.

### 4.3 The two deferred/consistency triggers

```sql
-- (a) A membership must have a default workspace at COMMIT. Deferred, because the workspace row
--     cannot exist before the membership it points back at.
CREATE OR REPLACE FUNCTION assert_membership_default_workspace() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.default_workspace_id IS NULL THEN
    RAISE EXCEPTION 'MEMBERSHIP_WITHOUT_DEFAULT_WORKSPACE: %', NEW.id USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END $$;

CREATE CONSTRAINT TRIGGER membership_default_workspace_required
  AFTER INSERT OR UPDATE ON memberships
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_membership_default_workspace();

-- (b) A PERSONAL workspace has exactly one member, and it is its owner.
CREATE OR REPLACE FUNCTION assert_personal_workspace_single_member() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE w_kind text; w_owner uuid;
BEGIN
  SELECT kind::text, owner_membership_id INTO w_kind, w_owner
    FROM workspaces WHERE id = NEW.workspace_id;
  IF w_kind = 'PERSONAL' AND NEW.membership_id IS DISTINCT FROM w_owner THEN
    RAISE EXCEPTION 'PERSONAL_WORKSPACE_SINGLE_MEMBER' USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER workspace_member_personal_guard
  BEFORE INSERT OR UPDATE ON workspace_members FOR EACH ROW
  EXECUTE FUNCTION assert_personal_workspace_single_member();
```

### 4.4 Keeping the derived owner column honest

`documents.owner_user_id` is a denormalisation of `memberships.user_id`. Authorization **never** reads
it (a CI grep fails the build if the identifier `ownerUserId` appears anywhere under
`src/modules/*/application/authz/**` or in `visibility.ts`); it exists for the "my documents across
every organization" index and for PDPA subject-access and erasure, where the question is asked about
a *user*, not a membership. Because it is security-adjacent, it is kept correct mechanically:

```sql
CREATE OR REPLACE FUNCTION assert_document_owner_user_matches() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE m_user uuid;
BEGIN
  SELECT user_id INTO m_user FROM memberships
   WHERE id = NEW.owner_membership_id AND organization_id = NEW.organization_id;
  IF m_user IS NULL OR m_user <> NEW.owner_user_id THEN
    RAISE EXCEPTION 'DOCUMENT_OWNER_USER_MISMATCH' USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER document_owner_user_matches
  BEFORE INSERT ON documents FOR EACH ROW
  EXECUTE FUNCTION assert_document_owner_user_matches();
```

Insert-only: `document_ownership_immutable` (§4.2) already forbids either column changing.

---

## 5. Roles, GUCs and RLS

### 5.1 The five roles

| Role | Used by | Sees | Notes |
|---|---|---|---|
| `ocr_owner` | `prisma migrate deploy` | everything | Table owner. `FORCE ROW LEVEL SECURITY` applies to it too. |
| `ocr_app` | the Next.js request path | tenant **and** visibility filtered | The only role subject to the visibility policy. |
| `ocr_worker` | the OCR/AI worker after it has claimed a job | tenant filtered, **visibility-blind** | The worker never lists; it processes the one document its claimed job names. Giving it the visibility policy would require an ambient admin flag, which is what we are eliminating. |
| `ocr_queue` | the queue claim only | `extraction_jobs` only, `USING (true)` | `SELECT, UPDATE` on `extraction_jobs`; **no privilege at all** on `documents`, `document_pages`, `ocr_results`, `extraction_field_values`, `corrections`. Owned by h-queue-and-worker-contract.md; restated here only as a grant constraint. |
| `ocr_erasure` | the erasure job | everything, DELETE-capable | Gated by `app.erasure_window`. Mechanism owned by `gate-2-pdpa-retention.md`. |

Roles are created by a bootstrap `psql` script, **not** by a Prisma migration. Migration 0001 only
grants, and fails loudly if a role is absent:

```sql
DO $$ BEGIN
  PERFORM 1 FROM pg_roles WHERE rolname = ANY (ARRAY['ocr_app','ocr_worker','ocr_queue','ocr_erasure']);
  IF NOT FOUND THEN RAISE EXCEPTION 'BOOTSTRAP_ROLES_MISSING'; END IF;
END $$;
```

### 5.2 The five transaction-local GUCs

| GUC | Type | Set for | Empty means |
|---|---|---|---|
| `app.current_org` | uuid | every principal | fail closed (predicate is NULL → zero rows) |
| `app.current_membership` | uuid | `user` principals only | the owner-match and user-grant branches are NULL → false |
| `app.current_api_key` | uuid | `apiKey` principals only | the api-key-grant and created-by branches are NULL → false |
| `app.current_workspaces` | comma-separated uuids | `user` and `apiKey` | empty array → the workspace branch is false |
| `app.is_org_admin` | `'on'` / `'off'` | set to `'on'` **only** inside `withAdminOverride()` | `'off'` |

Every one is set with `set_config(name, value, true)` — `is_local = true` — inside the transaction.
`SET LOCAL` cannot take a bind parameter, so the string-concatenated form is an injection vector in
the middle of the security control and is banned by lint. Empty string is passed as `''` and read
through `nullif(..., '')` so that `::uuid` never raises `invalid input syntax`.

`app.current_workspaces` is capped at **200** ids (≈ 7.4 KB). A principal with more than 200 active
workspace memberships is refused with `E_TOO_MANY_WORKSPACES` rather than silently truncated — a
truncated set is a silent authorization change.

```sql
CREATE OR REPLACE FUNCTION app_current_workspaces() RETURNS uuid[]
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN coalesce(current_setting('app.current_workspaces', true), '') = '' THEN ARRAY[]::uuid[]
    ELSE string_to_array(current_setting('app.current_workspaces', true), ',')::uuid[]
  END
$$;
```

`STABLE`, not `IMMUTABLE`, so it is evaluated once per query and can never appear inside an index
definition — which it does not need to.

### 5.3 The visibility policy

```sql
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE  ROW LEVEL SECURITY;

CREATE POLICY document_visibility ON documents
  FOR ALL TO ocr_app
  USING (
    organization_id = nullif(current_setting('app.current_org', true), '')::uuid
    AND (
         current_setting('app.is_org_admin', true) = 'on'
      OR owner_membership_id = nullif(current_setting('app.current_membership', true), '')::uuid
      OR created_by_api_key_id = nullif(current_setting('app.current_api_key', true), '')::uuid
      OR (visibility <> 'PRIVATE' AND workspace_id = ANY (app_current_workspaces()))
      OR visibility = 'ORGANIZATION'
      OR EXISTS (
           SELECT 1 FROM document_grants g
            WHERE g.document_id     = documents.id
              AND g.organization_id = documents.organization_id
              AND g.revoked_at IS NULL
              AND (g.expires_at IS NULL OR g.expires_at > now())
              AND ( g.grantee_membership_id = nullif(current_setting('app.current_membership', true), '')::uuid
                 OR g.grantee_api_key_id    = nullif(current_setting('app.current_api_key', true), '')::uuid ))
    )
  )
  WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);

CREATE POLICY document_worker ON documents FOR ALL TO ocr_worker
  USING      (organization_id = nullif(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);

CREATE POLICY document_erasure ON documents FOR ALL TO ocr_erasure USING (true);
```

**No recursion.** PostgreSQL applies row security to tables referenced inside a policy expression, so
the `EXISTS` into `document_grants` runs under `document_grants`' own policy. That policy is
**tenant-only** and does not reference `documents`, so there is no cycle and no
`infinite recursion detected in policy for relation` error, and no `SECURITY DEFINER` wrapper is
needed. This is verified by construction and asserted by the §6.6 test; it is also the single most
common way this design is got wrong, so it is stated here rather than discovered later.

```sql
CREATE POLICY grant_tenant ON document_grants FOR ALL TO ocr_app
  USING      (organization_id = nullif(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);
```

**Child tables carry tenant-only policies, not visibility.** `document_pages`, `ocr_results`,
`document_analyses`, `extraction_field_values`, `corrections`, `extraction_jobs`, `job_events` and
`document_runs` are reachable only through a `DocumentRef` (§6.3), which can only be produced by the
visibility-enforcing chokepoint. Duplicating a six-branch predicate onto eight child tables would cost
a per-row `EXISTS` into `documents` on the highest-volume tables in the system (~1.56 M `ocr_results`
in year 1) for a boundary the type system already closes.

**`organizations` needs a different predicate** — its tenant column is `id`, not `organization_id`:

```sql
CREATE POLICY organization_self ON organizations FOR ALL TO ocr_app
  USING (id = nullif(current_setting('app.current_org', true), '')::uuid);
```

**`users`, `prompt_versions`, `outbox_events`, `idempotency_records` and `platform_staff` are
deliberately global and carry no policy.** They must be asserted *absent* from the tenant-table list,
so that a future reviewer "fixing" the list does not break login. `users` gets one policy anyway —
membership-gated `SELECT` — with the pre-organization login lookup moved to a dedicated bootstrap role
that holds `SELECT (id, email, status)` on `users` and nothing else:

```sql
CREATE POLICY user_visible_to_shared_org ON users FOR SELECT TO ocr_app
  USING (EXISTS (SELECT 1 FROM memberships m
                  WHERE m.user_id = users.id
                    AND m.organization_id = nullif(current_setting('app.current_org', true), '')::uuid
                    AND m.revoked_at IS NULL));
```

### 5.4 Cost, measured honestly

Per tenant-scoped operation: `BEGIN`, one `set_config` batch (all five GUCs in one statement), the
work, `COMMIT` — three extra round trips, ≈ **0.9 ms** at 0.3 ms/round-trip on a local network,
amortised across every query in the transaction. The visibility predicate itself is a per-row scalar
comparison on rows the planner already reached via an index, plus at most one index probe into
`document_grant_org_grantee_idx`.

**Connection-pool arithmetic.** `@prisma/adapter-pg` runs on `pg.Pool`. Every tenant-scoped query is
inside `$transaction`, so an interactive transaction holds a connection for its whole callback.
`max: 5` (jawbong's current value) would cap the app at 5 concurrent tenant operations per Node
process. Required before M2 load: `max = min(20, pg_max_connections / processes)`; a **2 s**
transaction timeout for request-path work and **10 s** only for the ingest write path; and an ESLint
`no-restricted-syntax` rule forbidding `fetch`, S3 and gateway identifiers **inside** the
`withPrincipal` callback — the transaction wraps database work only.

---

## 6. The chokepoint

### 6.1 The principal

```ts
// src/modules/shared/application/principal.ts   (application layer; no Prisma, no Next)
export type OrganizationId = string & { readonly __brand: "OrganizationId" };
export type MembershipId   = string & { readonly __brand: "MembershipId" };
export type WorkspaceId    = string & { readonly __brand: "WorkspaceId" };
export type ApiKeyId       = string & { readonly __brand: "ApiKeyId" };
export type UserId         = string & { readonly __brand: "UserId" };

/** Produced ONLY by the authorization port, from a verified session or a verified API key. */
export type Principal =
  | { readonly kind: "user";
      readonly organizationId: OrganizationId;
      readonly membershipId:  MembershipId;
      readonly userId:        UserId;
      readonly orgRole:       OrgRole;
      readonly workspaceIds:  readonly WorkspaceId[];   // active memberships only, max 200
      readonly scopes:        readonly Scope[]; }
  | { readonly kind: "apiKey";
      readonly organizationId: OrganizationId;
      readonly apiKeyId:      ApiKeyId;
      readonly workspaceIds:  readonly [WorkspaceId];   // exactly one, the key's bound workspace
      readonly scopes:        readonly Scope[]; }
  | { readonly kind: "system";
      readonly organizationId: OrganizationId;
      readonly reason:        SystemReason; };          // worker path only; ocr_worker role
```

There is **no anonymous variant**: a `Principal` cannot be constructed without an `organizationId`.
The `system` variant carries no `membershipId` and no `userId`, so any code that reads
`principal.userId` without narrowing fails to compile. That is the type-level form of
*"authorization must not depend solely on userId"*.

### 6.2 The scoped runner, and why the delegates are gone

```ts
// src/modules/shared/infrastructure/db/scoped-prisma.ts
// The ONLY module that holds an unrestricted PrismaClient.

const DOCUMENT_DELEGATES = [
  "document", "documentPage", "documentRun", "ocrResult", "documentAnalysis",
  "extractionFieldValue", "correction", "extractionJob", "jobEvent", "documentGrant",
] as const;

/** What every other module is allowed to see. The document delegates are structurally absent. */
export type ScopedTx = Omit<Prisma.TransactionClient, (typeof DOCUMENT_DELEGATES)[number]>;

export function createScopedRunner(prisma: PrismaClient) {
  return async function withPrincipal<T>(
    p: Principal,
    fn: (tx: ScopedTx) => Promise<T>,
    opts: { timeoutMs?: number } = {},
  ): Promise<T> {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT
        set_config('app.current_org',        ${p.organizationId},                  true),
        set_config('app.current_membership', ${p.kind === "user"   ? p.membershipId : ""}, true),
        set_config('app.current_api_key',    ${p.kind === "apiKey" ? p.apiKeyId     : ""}, true),
        set_config('app.current_workspaces', ${p.kind === "system" ? "" : p.workspaceIds.join(",")}, true),
        set_config('app.is_org_admin',       'off',                                true)`;
      return fn(tx as ScopedTx);
    }, { timeout: opts.timeoutMs ?? 2_000, maxWait: 5_000 });
  };
}
```

A new route handler that writes `tx.document.findMany({ where: { id } })` does not fail code review.
It fails `tsc`, with `Property 'document' does not exist on type 'ScopedTx'`. That is the guarantee
the owner asked for: **a type-level one, not a discipline one.**

### 6.3 The one chokepoint, and the reference nothing else can forge

```ts
// src/modules/documents/infrastructure/document-access.ts
declare const DOCUMENT_REF: unique symbol;

/** Proof that visibility has already been evaluated for a specific principal. Unforgeable. */
export interface DocumentRef {
  readonly [DOCUMENT_REF]: true;
  readonly id: DocumentId;
  readonly organizationId: OrganizationId;
  readonly workspaceId: WorkspaceId;
  readonly ownerMembershipId: MembershipId;
  readonly visibility: DocumentVisibility;
  readonly capabilities: DocumentCapabilities;   // { read, approve, export, delete, requeue, share }
}

/** THE visibility filter. One definition, used by resolve() and by list(). Never duplicated. */
export function visibilityWhere(p: Principal): Prisma.DocumentWhereInput {
  if (p.kind === "system") return {};                       // ocr_worker role; tenant-only by policy
  const OR: Prisma.DocumentWhereInput[] = [
    { workspaceId: { in: [...p.workspaceIds] }, visibility: { not: "PRIVATE" } },
    { visibility: "ORGANIZATION" },
  ];
  if (p.kind === "user") {
    OR.push({ ownerMembershipId: p.membershipId });
    OR.push({ grants: { some: { granteeMembershipId: p.membershipId, revokedAt: null,
                                OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] } } });
  } else {
    OR.push({ createdByApiKeyId: p.apiKeyId });
    OR.push({ grants: { some: { granteeApiKeyId: p.apiKeyId, revokedAt: null,
                                OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] } } });
  }
  return { OR };
}

export class DocumentAccess implements DocumentAccessPort {
  constructor(private readonly full: Prisma.TransactionClient) {}

  /** The ONLY way to obtain a DocumentRef. There is deliberately no unscoped findById. */
  async resolve(p: Principal, publicId: string): Promise<DocumentRef | null> {
    const row = await this.full.document.findFirst({
      where: { publicId, organizationId: p.organizationId, deletedAt: null, ...visibilityWhere(p) },
      select: { id: true, organizationId: true, workspaceId: true,
                ownerMembershipId: true, visibility: true },
    });
    return row ? toRef(row, await this.capabilitiesFor(p, row)) : null;
  }

  /** Children take a DocumentRef, never a raw id. */
  async pages(ref: DocumentRef): Promise<DocumentPage[]> { /* … where: { documentId: ref.id } … */ }
}
```

`DocumentAccessPort` is declared in `src/modules/documents/application/ports.ts` with **every** method
typed `(principal: Principal, …)` or `(ref: DocumentRef, …)`; `implements` makes the compiler enforce
it. `DOCUMENT_REF` is `declare const … : unique symbol` — it has no runtime value, is never exported,
and therefore no object literal outside this module can satisfy `DocumentRef`.

### 6.4 Why a new route physically cannot bypass it

| Bypass attempt | What stops it | Kind of guarantee |
|---|---|---|
| `prisma.document.findMany(...)` in a route file | `dependency-cruiser`: only `src/modules/*/infrastructure/**` may import `@/generated/prisma` | build-time |
| `tx.document.findMany(...)` inside `withPrincipal` | `document` is absent from `ScopedTx` | **type-level** |
| A new repository in another module importing `PrismaClient` | `dependency-cruiser`: only `db/scoped-prisma.ts` may import the client module | build-time |
| Constructing a `DocumentRef` by hand | `unique symbol` brand, never exported | **type-level** |
| `{...row} as unknown as DocumentRef` | ESLint `no-restricted-syntax` on `TSAsExpression` naming `DocumentRef`; CI grep fails on `eslint-disable` under `src/modules/documents/**` | build-time |
| `$queryRaw` list query | `$queryRaw*` banned outside `db/raw/**` (D-F1-10); CODEOWNERS on that folder | build-time |
| Forgetting the filter inside `DocumentAccess` | RLS `document_visibility` policy returns zero rows | runtime |
| Setting the wrong `organizationId` in the GUC | Composite FK `(id, organization_id)` on every child; a mis-scoped write is `23503` | runtime |
| A direct `psql` session as `ocr_app` with no GUC | `nullif(...)::uuid` is NULL → predicate NULL → zero rows | runtime |
| A restore that lost the roles | startup assertion crash-loops (§6.7) | runtime |

### 6.5 The DMMF and architecture tests

1. **TEN-1** (from `g` §3.3, retained): every FK whose referenced table is tenant-scoped is composite
   on `organizationId`.
2. **TEN-2** (new, closes the bare-pointer hole the panel found): any scalar field matching
   `/Id$|Ids$/` whose name maps to a tenant-scoped model must back a relation, or appear in an
   explicit, commented `NO_FK_BY_DESIGN` allowlist. This is the check that would have caught
   `DocumentPage.renderStorageObjectId`, `ExtractionFieldValue.sourceOcrResultId`, and the two
   `DocumentAnalysis` uuid arrays. Arrays are replaced by join tables, because PostgreSQL cannot
   foreign-key an array element at all.
3. **TEN-3**: the tenant-table list is **derived** from the DMMF (models with an `organizationId`
   field) unioned with `{organizations}` — never hand-typed — and every table on it has RLS enabled
   and forced, and at least one policy.
4. **TEN-4**: `users`, `prompt_versions`, `outbox_events`, `idempotency_records`, `platform_staff`
   are asserted **absent** from that list, each with a comment naming why.
5. **VIS-1**: every model appearing in the public route table has a `publicId` field with
   `@db.VarChar(32)` and a unique index.
6. **VIS-2**: no identifier named `ownerUserId` appears under
   `src/modules/*/application/authz/**` or in `visibility.ts`.
7. **UNIQ-1**: every `@@unique` on tenant-controlled input includes `organizationId` — unique-constraint
   checks bypass RLS, so a global unique on attacker-chooseable data is a cross-tenant existence
   oracle. (`documents.public_id`, `api_keys.key_prefix`, `organizations.slug`, `users.email` are
   server-generated or deliberately global and are on a commented exemption list.)

### 6.6 The equivalence test that stops the two layers drifting

For a seeded matrix of **7 principals × 12 documents** covering every branch of the predicate
(owner, workspace member with each visibility, non-member, org-wide, direct grant, expired grant,
revoked grant, api-key-created, api-key-granted, cross-organization, admin-elevated):

```
for each principal p:
  A = ids from DocumentAccess.list(p)                          -- app filter + RLS
  B = ids from `SELECT id FROM documents` as ocr_app under p's GUCs   -- RLS alone
  assert A == B
```

If the application filter is ever loosened, `A ⊃ B` and the test fails. If the policy is ever
loosened, `B ⊃ A` and the test fails. Neither can drift silently. This is also the test that would
catch an RLS recursion error, because `B` would raise rather than return rows.

### 6.7 Startup assertions — fail loud, never fail quiet

`pg_dump` dumps a single database and **does not carry roles**; `pg_dumpall --globals-only` does. A
restore to a fresh instance without the globals yields `CREATE POLICY … TO ocr_app` statements that
fail with `role "ocr_app" does not exist` (which `pg_restore` skips by default), `FORCE ROW LEVEL
SECURITY` enabled, and **zero policies** — after which the app returns zero rows for every query with
no error raised. That is the worst possible failure mode for this design, so it is asserted at boot:

```sql
DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(r, ', ') INTO missing
    FROM unnest(ARRAY['ocr_app','ocr_worker','ocr_queue','ocr_erasure']) r
   WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'STARTUP_ROLES_MISSING: %', missing; END IF;

  IF (SELECT count(*) FROM pg_policies WHERE tablename = 'documents') < 3 THEN
    RAISE EXCEPTION 'STARTUP_DOCUMENT_POLICIES_MISSING';
  END IF;

  PERFORM 1 FROM pg_indexes WHERE indexname = 'storage_object_org_original_fp_key'
    AND indexdef LIKE '%WHERE ((kind = ''ORIGINAL''::"StorageObjectKind") AND (deleted_at IS NULL))%';
  IF NOT FOUND THEN RAISE EXCEPTION 'STARTUP_PARTIAL_INDEX_MISSING: storage_object_org_original_fp_key'; END IF;
  -- … one PERFORM per entry on the partial-index drift allowlist (§7) …
END $$;
```

The process must **crash-loop**, not serve. Nightly backups run `pg_dumpall --globals-only` alongside
`pg_dump`.

---

## 7. The uniqueness defects, fixed exactly

Seven partial indexes, all authored as raw SQL (D-F1-16), all on the drift allowlist, all asserted at
startup (§6.7).

### 7.1 What breaks, precisely

| # | Offending constraint (as shipped in `g`) | Breaks when | Symptom |
|---|---|---|---|
| A | `storage_object_org_fingerprint_key` = `@@unique([organizationId, contentFingerprint, kind])` on `storage_objects` | two derivative blobs have identical bytes: two blank duplex backs, two identical letterhead pages, two empty-page `ENGINE_PAYLOAD` JSONs | `23505` on the second insert → job retries → `max_attempts` → `DEAD` → document `FAILED`, on the **median** multi-page scan |
| B | `ocr_result_page_engine_key` = `@@unique([documentPageId, engineId, engineVersion, renderDpi])` on an append-only table with a `reject_mutation` trigger | an operator requeues a `FAILED` document and the worker re-OCRs page 1 with the same engine build at the same DPI | `23505`, no `ON CONFLICT DO UPDATE` escape (the trigger forbids UPDATE), `FAILED → QUEUED` is the only recovery edge, so the document is **permanently stuck** and the only exit is deletion |

### 7.2 Fix A — the exact final constraint

**Drop:**
```sql
DROP INDEX IF EXISTS storage_object_org_fingerprint_key;   -- @@unique([organizationId, contentFingerprint, kind])
```

**Replace with:**
```sql
-- Serves: THE same-tenant dedup probe (g §7.1 step 4).
--   WHERE organization_id = $1 AND content_fingerprint = $2 AND kind = 'ORIGINAL' AND deleted_at IS NULL
-- Scoped to the ONLY kind that is content-addressed. Derivatives are identity-addressed and are
-- already unique through storage_object_bucket_key_key (bucket, object_key).
-- `deleted_at IS NULL` makes re-upload after a delete legal, which the full constraint also blocked.
CREATE UNIQUE INDEX storage_object_org_original_fp_key
  ON storage_objects (organization_id, content_fingerprint)
  WHERE kind = 'ORIGINAL' AND deleted_at IS NULL;
```

**The dedup write, which must be raw because Prisma cannot see a partial unique index:**
```sql
INSERT INTO storage_objects (id, organization_id, kind, bucket, object_key, content_type,
                             size_bytes, content_sha256, content_fingerprint, created_at)
VALUES ($1, $2, 'ORIGINAL', $3, $4, $5, $6, $7, $8, now())
ON CONFLICT (organization_id, content_fingerprint) WHERE kind = 'ORIGINAL' AND deleted_at IS NULL
DO NOTHING
RETURNING id;
-- 0 rows returned => the blob already exists in this tenant; SELECT the existing row and reuse it.
```
PostgreSQL infers a partial unique index when the `ON CONFLICT` target repeats the index predicate.

**Regression test (must exist before ingest ships):** ingest a 4-page PDF whose pages 2 and 4 are
blank; assert **four distinct `PAGE_RENDER` rows** and four distinct `PAGE_THUMBNAIL` rows, and assert
the document reaches `READY_FOR_REVIEW`.

**Not the alternative:** "reuse the colliding row" is refused. It would make
`DocumentPage.renderStorageObjectId` in two different documents point at one blob, so PDPA erasure of
document A would destroy a blob document B still renders — the exact refcount argument `g` §7.3 uses
to reject cross-tenant dedup, reappearing intra-tenant.

### 7.3 Fix B — the exact final constraints

**Drop:**
```sql
DROP INDEX IF EXISTS ocr_result_page_engine_key;  -- @@unique([documentPageId, engineId, engineVersion, renderDpi])
```

**Replace with (Prisma, because it is a plain composite unique):**
```prisma
model OcrResult {
  runId String @map("run_id") @db.Uuid    // NOT NULL — added by D-F1-12
  run   DocumentRun @relation(fields: [runId, organizationId],
                              references: [id, organizationId], onDelete: Restrict, onUpdate: NoAction)

  @@unique([documentPageId, runId, engineId, engineVersion, renderDpi], map: "ocr_result_page_run_engine_key")
  // Serves TWO invariants at once:
  //  (1) within ONE run, re-running the same engine build at the same DPI on the same page is a
  //      worker retry after a crash — ON CONFLICT DO NOTHING makes it idempotent;
  //  (2) across runs, the same (page, engine, version, dpi) is legal, which is what makes the
  //      operator requeue and the mandatory VLM re-run (g §7.1 step 5) possible on an append-only table.
  @@unique([id, organizationId], map: "ocr_result_id_org_key")   // composite-FK anchor (TEN-1)
  @@index([organizationId, createdAt], map: "ocr_result_org_created_idx")
}
```

**And the run-identity constraints that make it work:**
```prisma
// DocumentRun
@@unique([documentId, runSeq], map: "document_run_doc_seq_key")
```
```sql
-- At most one live run per document. A requeue must first CANCEL the live run in the same
-- transaction; otherwise it receives a distinct, loud 23505 that the API maps to 409 run_in_progress.
-- That is a correct refusal, not a wedge.
CREATE UNIQUE INDEX document_run_one_active_key
  ON document_runs (document_id) WHERE outcome = 'RUNNING';
```
```prisma
// ExtractionJob — dedupeKey derived from the RUN, not from a mutable counter.
//   dedupeKey = `${runId}:${kind}:${pageFrom ?? '*'}-${pageTo ?? '*'}`
// The '*' encoding exists because PostgreSQL treats NULLs as distinct in a unique index, so a
// column-based key on nullable pageFrom/pageTo would permit two identical whole-document jobs.
@@unique([organizationId, dedupeKey], map: "extraction_job_org_dedupe_key")
// Serves: enqueue idempotency — INSERT … ON CONFLICT (organization_id, dedupe_key) DO NOTHING.
// Tenant-scoped so it is not a cross-tenant existence oracle (unique checks bypass RLS).
@@unique([id, organizationId], map: "extraction_job_id_org_key")
```
```prisma
// DocumentPage — UNCHANGED and correct: a page number is a property of the DOCUMENT, not of a run.
@@unique([documentId, pageNumber], map: "document_page_doc_number_key")
// Consequence for requeue: the render step must UPSERT pages, never INSERT:
//   INSERT … ON CONFLICT (document_id, page_number) DO UPDATE
//     SET width_px = EXCLUDED.width_px, height_px = EXCLUDED.height_px,
//         render_dpi = EXCLUDED.render_dpi, rotation_applied = EXCLUDED.rotation_applied,
//         updated_at = now();
// document_pages is a mutable PROJECTION (it has updated_at); ocr_results is immutable EVIDENCE
// (it has none). That asymmetry is the whole reason the upsert is legal here and forbidden there.
```

**`Document.requeueCount` is deleted.** The current generation is `SELECT max(run_seq) FROM
document_runs WHERE document_id = $1`. `run_seq` is allocated under a row lock, not a counter read:

```sql
SELECT 1 FROM documents WHERE id = $1 FOR NO KEY UPDATE;   -- serialises concurrent requeues
INSERT INTO document_runs (id, organization_id, document_id, run_seq, trigger, pipeline_version)
SELECT $2, $3, $1, coalesce(max(run_seq), 0) + 1, $4, $5 FROM document_runs WHERE document_id = $1;
```

`FOR NO KEY UPDATE` (not `FOR UPDATE`) so it does not block concurrent FK checks against the same
document row. No retry loop; the unique index is a backstop, not the mechanism.

**Regression test:** requeue a `FAILED` 60-page document **twice** and assert it reaches
`READY_FOR_REVIEW`, that three `document_runs` rows exist with `run_seq` 1/2/3, and that
`ocr_results` holds three rows for page 1 with the same `(engine_id, engine_version, render_dpi)` and
three different `run_id`s.

### 7.4 Two further uniqueness traps, closed proactively

```sql
-- Re-adding a removed workspace member must be legal.
CREATE UNIQUE INDEX workspace_member_ws_membership_key
  ON workspace_members (workspace_id, membership_id) WHERE revoked_at IS NULL;

-- Re-granting after revocation must be legal, for both grantee kinds.
CREATE UNIQUE INDEX document_grant_doc_membership_key
  ON document_grants (document_id, grantee_membership_id)
  WHERE grantee_membership_id IS NOT NULL AND revoked_at IS NULL;

CREATE UNIQUE INDEX document_grant_doc_api_key_key
  ON document_grants (document_id, grantee_api_key_id)
  WHERE grantee_api_key_id IS NOT NULL AND revoked_at IS NULL;

-- Exactly one personal workspace per membership.
CREATE UNIQUE INDEX workspace_personal_owner_key
  ON workspaces (owner_membership_id) WHERE kind = 'PERSONAL';
```

### 7.5 The seven partial indexes, in one place

| Index | Table | Predicate | Invariant it serves |
|---|---|---|---|
| `storage_object_org_original_fp_key` | `storage_objects` | `kind='ORIGINAL' AND deleted_at IS NULL` | same-tenant dedup; blank pages do not collide |
| `document_run_one_active_key` | `document_runs` | `outcome='RUNNING'` | at most one live run per document |
| `workspace_member_ws_membership_key` | `workspace_members` | `revoked_at IS NULL` | one active membership per workspace, re-addable |
| `document_grant_doc_membership_key` | `document_grants` | `grantee_membership_id IS NOT NULL AND revoked_at IS NULL` | one active user grant per document, re-grantable |
| `document_grant_doc_api_key_key` | `document_grants` | `grantee_api_key_id IS NOT NULL AND revoked_at IS NULL` | one active key grant per document, re-grantable |
| `workspace_personal_owner_key` | `workspaces` | `kind='PERSONAL'` | exactly one personal workspace per membership |
| `document_org_visibility_created_idx` | `documents` | `visibility='ORGANIZATION' AND deleted_at IS NULL` | the org-wide branch of the list query |

### 7.6 The four `documents` indexes the visibility predicate needs

```prisma
@@index([organizationId, workspaceId, status, createdAt(sort: Desc)], map: "document_org_ws_status_created_idx")
// Query: the workspace inbox — the single hottest list query in the product.
@@index([organizationId, ownerMembershipId, createdAt(sort: Desc)], map: "document_org_owner_created_idx")
// Query: "my documents", and the owner branch of the visibility predicate.
@@index([organizationId, createdAt(sort: Desc)], map: "document_org_created_idx")
// Query: the unfiltered inbox; also the admin-elevated list.
@@index([organizationId, ownerUserId, createdAt(sort: Desc)], map: "document_org_owner_user_created_idx")
// Query: PDPA subject access — "every document owned by this USER", across memberships.
```
```sql
CREATE INDEX document_org_visibility_created_idx
  ON documents (organization_id, created_at DESC)
  WHERE visibility = 'ORGANIZATION' AND deleted_at IS NULL;
```

`g`'s `document_org_status_created_idx` (without `workspace_id`) is **replaced**, not kept: with
visibility as a second mandatory predicate it can no longer serve the inbox on its own.

---

## 8. Migration-consequence statement

**These must be right before the first migration runs, because they cannot be changed after
production data exists.**

| # | What | Why it is irreversible |
|---|---|---|
| 1 | `documents.owner_membership_id NOT NULL` and `documents.workspace_id NOT NULL` | `j` §7.1.1: backfilling ownership for rows "whose real owner is no longer knowable". This is the FATAL finding and it is the whole reason for M0.5. |
| 2 | `documents.visibility NOT NULL DEFAULT 'WORKSPACE'` | A backfill must guess a policy. Guessing wide is a breach; guessing narrow breaks the customer's workflow on the day you tighten it. |
| 3 | The tenant column name `organization_id` | Leading column of nine composite indexes and second column of ~20 composite FKs; every RLS policy names it. |
| 4 | Every parent's `@@unique([id, organizationId])` anchor | Without it, the composite FKs cannot be declared, and adding them later requires validating every existing child row. |
| 5 | `documents.public_id` as the exposed identifier | Changing the exposed id later breaks every customer-stored URL, webhook consumer and exported CSV. |
| 6 | `document_runs`, and `run_id NOT NULL` on `ocr_results` / `document_analyses` / `extraction_jobs` | Retrofitting `run_id` means inventing a run for evidence that never had one. |
| 7 | The two replaced unique constraints (§7.2, §7.3) | Tightening a unique index after duplicates land fails outright; and documents that already wedged cannot be un-wedged retroactively. |
| 8 | RLS enabled + **forced** + policies present before the first row | A table that accumulates rows before `FORCE ROW LEVEL SECURITY` has served unfiltered reads, and no later DDL undoes that. |
| 9 | `PERSONAL` workspace created in the same transaction as every membership | A membership that ever existed without one has documents with no private home. |
| 10 | `admin_access_logs` append-only **by grant**, from row zero | A log that was ever `UPDATE`-able is not evidence. |
| 11 | The five roles and five GUC names | They appear in every policy; renaming means rewriting every policy under lock. |

**Explicitly NOT on this list**, i.e. genuinely additive later: a fourth `DocumentVisibility` value;
`grantee_api_key_id` semantics (the column exists from day one); the `document_visibility_index`
fan-out table (D-F1-17); additional `WorkspaceRole` values; per-organization
`defaultDocumentVisibility` changes.

---

## 9. What this document changes in the four M0 documents

| Document | Section | Change |
|---|---|---|
| `g-data-model.md` | §2 K-1 | `publicId` **confirmed and generalised** — every externally-addressable model, not only `Document`. Wire prefix `doc_` adopted from `l`. |
| `g-data-model.md` | §3.1 | `organizationId` **confirmed** as the tenant column; `Membership` becomes the tenant-anchored principal identity. |
| `g-data-model.md` | §3.2 | `TenantScope` **replaced** by `Principal`; the runner becomes `withPrincipal`; the delegate-stripped `ScopedTx` is added. |
| `g-data-model.md` | §3.3 | Invariant TEN-1 **retained**, plus TEN-2/3/4 and UNIQ-1. |
| `g-data-model.md` | §3.4 | RLS **extended** from tenant-only to full visibility on `documents`, with five GUCs and five roles. |
| `g-data-model.md` | §5.4 | `Document` gains `owner_membership_id`, `owner_user_id`, `workspace_id`, `visibility`, `current_run_id`, all NOT NULL except the last; loses `requeueCount`. Indexes re-cut. |
| `g-data-model.md` | §5.5/§5.6 | `run_id` added; `dedupeKey` re-derived; `ocr_result_page_engine_key` replaced. |
| `g-data-model.md` | §7.3 | `storage_object_org_fingerprint_key` replaced by a partial unique on `ORIGINAL`. |
| `j-security-threat-model.md` | §7.1.1 | Its schema mandate is **implemented in full**, with `membershipId` substituted for `userId` and personal workspaces added. Its `403` for same-tenant is narrowed — see §7.1 row below. |
| `j-security-threat-model.md` | §7.1(3) | The 404 rule is **kept and sharpened**: 404 covers not-visible as well as cross-tenant; 403 survives only for insufficient scope on an already-visible document. |
| `l-api-ui-export.md` | §1.2 | Identifiers **overruled**: two identifiers, not one. The `doc_` prefix is kept as a wire decoration. A mis-prefixed id is a **404**, not a 400. |
| `l-api-ui-export.md` | §2.1 | Its 404/403 table is **replaced** by D-F1-13's table. |
| `l-api-ui-export.md` | §2.2 | Layer 1 (`tenantScoped()` `$extends`) is **deleted, not repaired**. Layer 2 (RLS) is kept and extended. Layer 3 (build-time) is kept and extended. Layer 4 (one translation point) is kept verbatim. Its `bootstrapDb` escape hatch is kept, renamed to the `db/raw/**` folder rule. |
| `l-api-ui-export.md` | §1.4 | Keyset pagination is **re-expressed in Prisma**; the raw query is withdrawn (D-F1-10). |

---

## 10. Tests that make this real

| Test | Asserts | Fails when |
|---|---|---|
| `tests/architecture/tenant-fk.test.ts` | TEN-1 | a new single-column FK into a tenant table |
| `tests/architecture/bare-pointer.test.ts` | TEN-2 | a new `*Id` scalar with no relation and no allowlist entry |
| `tests/architecture/rls-coverage.test.ts` | TEN-3/TEN-4 | a new tenant table with no policy, or a global table added to the list |
| `tests/architecture/public-id.test.ts` | VIS-1 | a new externally-addressable model without a `publicId` |
| `tests/architecture/scoped-tx.test.ts` | `ScopedTx` excludes all ten document delegates | a delegate is removed from the exclusion list |
| `tests/integration/visibility-matrix.test.ts` | 7 principals × 12 documents, expected id sets | any predicate branch changes meaning |
| `tests/integration/rls-app-equivalence.test.ts` | §6.6 — app filter result == RLS-only result | either layer drifts |
| `tests/integration/rls-fail-closed.test.ts` | every tenant table returns 0 rows with no GUC | a policy is missing or `TO` is omitted |
| `tests/integration/blank-page-render.test.ts` | 4-page PDF, pages 2 and 4 blank → 4 render rows | fix A regresses |
| `tests/integration/requeue-twice.test.ts` | two requeues → `READY_FOR_REVIEW`, 3 runs, 3 results/page | fix B regresses |
| `tests/integration/erasure-cascade.test.ts` | doc → 2 pages → 3 results → delete doc → 0 rows, no FK error | the two-way `PageCanonical` reference or an append-only trigger deadlocks |
| `tests/api/not-found-byte-identity.test.ts` | for **every** route: cross-org 404 body is byte-identical to random-id 404 body, and both take ≥ 25 ms | a differing `message` or a missing floor re-opens the oracle |
| `tests/api/insufficient-scope.test.ts` | a visible document + missing `documents:approve` → **403** | the two codes are conflated in either direction |
| `tests/integration/admin-override.test.ts` | a normal admin request sees only their visible set; `findWithAdminOverride` writes exactly one `AdminAccessLog` row per document read | the override becomes ambient |

---

## 11. Cross-document items this document does **not** resolve

### 11.1 The object-key grammar
Three incompatible forms exist across `g` §7.4, `j` §4 and `l` §4.4. This document does not pick one.
It imposes one constraint on whichever is picked, because the object-storage boundary is otherwise
outside both RLS and the composite FK:

```sql
ALTER TABLE ocr_results     ADD CONSTRAINT ocr_payload_ref_tenant_prefix
  CHECK (payload_ref IS NULL OR payload_ref LIKE 'org/' || organization_id::text || '/%');
ALTER TABLE extraction_jobs ADD CONSTRAINT job_result_ref_tenant_prefix
  CHECK (result_ref  IS NULL OR result_ref  LIKE 'org/' || organization_id::text || '/%');
ALTER TABLE storage_objects ADD CONSTRAINT storage_object_key_tenant_prefix
  CHECK (object_key LIKE 'org/' || organization_id::text || '/%');
```
Whatever grammar wins **must** keep `org/{organization_id}/` as its first two segments.

### 11.2 The `DocumentStatus` vocabulary
`g` §4.1 defines 11 states; `j` §4.1/§11.2 uses eight values `g`'s enum does not contain. Not resolved
here. `DocumentRun.outcome` is a **separate, smaller** enum and does not depend on which wins.

### 11.3 Retention and erasure
Owned by `gate-2-pdpa-retention.md` (mechanism) and the storage dimension (periods). One schema
constraint this document imposes: the per-document DEK row (`document_keys`) is tenant-scoped, carries
`organization_id`, takes a composite FK `(document_id, organization_id)`, and appears on the TEN-3
derived tenant-table list like every other tenant table.

### 11.4 Ingest limits — an unresolved 8×/40× disagreement
`g` §5.3 writes `size_bytes BETWEEN 1 AND 209715200` (200 MiB) and `page_count BETWEEN 1 AND 2000`.
`j` §8.1/§8.2 states "**Global hard cap 25 MB**… This is the number every other layer must agree with"
and "**50 pages per document (hard reject at 51)**". Every downstream number in `j` §8.3, §8.6, §8.7
and §8.8 was derived from the smaller envelope. This is **not** this document's dimension, but it is
flagged here for two reasons: (a) `ALTER TABLE … ADD CONSTRAINT … CHECK` validates existing rows, so
tightening 2 000 → 50 fails outright once one oversized document lands, which makes it a
**migration-order** problem and therefore adjacent to §8; (b) it must be settled by whoever owns
ingest before migration 0008 writes the CHECKs. Recommended interim: adopt `j`'s numbers, because they
are the ones the concurrency, memory and timeout budgets were computed from.

---

## 12. Owner-blocked items

| Tag | Question | Named default that ships if the owner stays silent |
|---|---|---|
| **OWNER-BLOCKED (B-F1-1)** | Is `ORGANIZATION` visibility offered at all in M1, or is it M2+? | **Offered, but never the default.** `Organization.defaultDocumentVisibility` ships as `WORKSPACE`; only an `OWNER` may change it, and the change is audited. |
| **OWNER-BLOCKED (B-F1-2)** | May an org `ADMIN` elevate to read content, or only an `OWNER`? | **`ADMIN` and `OWNER` both may**, with the §4.1 CHECKs (60-minute TTL, 20-character reason) and one `AdminAccessLog` row per document read. |
| **OWNER-BLOCKED (B-F1-3)** | Do INNOVERA `PlatformStaff` require the *customer's* approval before an `AdminAccessGrant` is issued, or is an internal second approver enough? | **Internal second approver in M1** (`granted_by_user_id` must differ from `subject_user_id`), with the tenant-visible log shipping in M5. Customer pre-approval is the stronger posture and should be reconsidered before the first enterprise contract. |
| **OWNER-BLOCKED (B-F1-4)** | Should a document be *movable* between workspaces, or only copyable? | **Movable**, requiring `MANAGER` in the source workspace or `ADMIN`/`OWNER`, with an `AuditLog` row. Copy is not built in M1. |

---

## 13. Sources

Read in full this session:
- `docs/architecture/m0/g-data-model.md` §2, §3.1–§3.4, §5.3–§5.6, §7.3–§7.4
- `docs/architecture/m0/z-adversarial-panel.md` §P8, all three lenses (lines 980–1198)
- `docs/architecture/m0/j-security-threat-model.md` §7.1, §7.1.1, §7.3, §9.3, §9.4
- `docs/architecture/m0/l-api-ui-export.md` §1.2, §2.1, §2.2
- `~/Documents/jawbong/prisma/schema.prisma`, `prisma/migrations/20260803000000_phase_00_foundation/migration.sql`,
  `src/lib/auth/actor-context.ts`, `dependency-cruiser.config.mjs`
- `docs/architecture/m05/gate-1-litellm-supply-chain.md`, `gate-2-pdpa-retention.md`, `gate-3-repository-privacy.md` (canonical-value registers, to avoid restatement)

Primary documentation verified this session:
- [PostgreSQL 18 — Row Security Policies](https://www.postgresql.org/docs/18/ddl-rowsecurity.html) —
  verbatim: *"Referential integrity checks, such as unique or primary key constraints and foreign key
  references, always bypass row security"*; *"If no policy exists for the table, a default-deny policy
  is used"*; *"Policy expressions are run as part of the query and with the privileges of the user
  running the query, although security-definer functions can be used to access data not available to
  the calling user."*
- [Prisma 7.4.0 release notes — partial indexes](https://github.com/prisma/prisma/releases/tag/7.4.0)
  and [Prisma — Indexes](https://www.prisma.io/docs/orm/prisma-schema/data-model/indexes) — the
  `partialIndexes` preview flag and the `where` argument on `@unique`/`@@unique`/`@@index`.
- [prisma/prisma#29263](https://github.com/prisma/prisma/issues/29263) — partial indexes dropped and
  recreated on every migration in 7.4.x.
- [prisma/prisma#29282](https://github.com/prisma/prisma/issues/29282) — partial unique indexes
  excluded from DMMF `uniqueFields`/`uniqueIndexes`.
- [Infinite recursion in Postgres RLS: a SECURITY DEFINER gotcha](https://dev.to/bairescodeai/infinite-recursion-in-postgres-rls-a-security-definer-gotcha-1916)
  and [supabase discussion #47525](https://github.com/orgs/supabase/discussions/47525) — RLS applies to
  tables referenced inside a policy expression; cycles raise
  `infinite recursion detected in policy for relation`. Our `documents → document_grants` reference is
  acyclic, which is why no `SECURITY DEFINER` wrapper is required.

---

## CANONICAL VALUES

Every value below is **owned by this document**. Cite it as
`f1-tenant-visibility-model.md §CANONICAL VALUES`. **Do not restate it** — restating is how M0 drifted.

| key | value | env var | reason | failure behaviour |
|---|---|---|---|---|
| `tenant.scope_column` | Prisma `organizationId`, column `organization_id`, type `uuid` | — | Prisma names a relation scalar after its relation field; `model Organization` + `tenantId` is the shape that lets a reviewer forget which is authoritative (D-F1-1). Resolves contradiction 8. | Any document using `tenantId` is out of date. Renaming after data exists rewrites 9 composite indexes, ~20 composite FKs and every RLS policy. |
| `tenant.root_model` | `Organization` / table `organizations`; tenant column there is `id`, not `organization_id` | — | The tenant root cannot reference itself by the child column name. | A copy-pasted `organization_id = …` policy on `organizations` fails with `42703 undefined_column` at migration time — the good outcome, but it must be written correctly once. |
| `tenant.principal_identity` | `Membership.id` — **not** `User.id` | — | Only a membership can carry a composite FK on `(id, organization_id)`; a global `users` FK cannot express tenant containment. | Keying authorization tables on `user_id` permits a workspace member who is not a member of the organization. |
| `authz.principal_type` | `Principal` — a 3-variant discriminated union (`user` \| `apiKey` \| `system`), **no anonymous variant**, every variant carries `organizationId` | — | Makes "authorization must not depend solely on userId" a compile error rather than a convention (D-F1-2, §6.1). | Code reading `principal.userId` without narrowing does not compile. A `Principal` cannot be constructed without an organization. |
| `authz.org_role_enum` | `enum OrgRole { OWNER, ADMIN, MEMBER }` | — | Three values cover administration, ownership and work. Approval authority is deliberately absent — it belongs to `WorkspaceRole`/`DocumentGrant` (`j` §7.6). | Adding a value is `ALTER TYPE … ADD VALUE` (two migrations). Removing one is not additive. |
| `authz.workspace_role_enum` | `enum WorkspaceRole { MANAGER, REVIEWER, CONTRIBUTOR, VIEWER }`, default `CONTRIBUTOR` | — | Separates reading from approving. `REVIEWER` and `MANAGER` may approve; `CONTRIBUTOR` and `VIEWER` may not. | Read implying approve is `j` §7.6's "forged financial authorisation with a real name attached". |
| `authz.workspace_kind_enum` | `enum WorkspaceKind { PERSONAL, SHARED }` | — | A `PERSONAL` workspace has exactly one member (its owner), so `WORKSPACE` visibility inside it *is* private with no special-case query (D-F1-3). | `workspace_owner_pairing` CHECK + `workspace_member_personal_guard` trigger. Violating either raises, never silently widens. |
| `authz.visibility_enum` | `enum DocumentVisibility { PRIVATE, WORKSPACE, ORGANIZATION }` | — | Three index-servable rules. `PRIVATE` = owner + grants; `WORKSPACE` = active members of the document's workspace; `ORGANIZATION` = every active member (D-F1-4). | An unknown value is a boot-time enum error, never a silent widening. |
| `authz.visibility_default` | column default `WORKSPACE`; effective default from `Organization.defaultDocumentVisibility`, which ships as `WORKSPACE` | — | Combined with a `PERSONAL` default workspace this is deny-by-default without a policy engine. | `ORGANIZATION` is never a default. Promoting a document to `ORGANIZATION` requires `MANAGER`/`ADMIN`/`OWNER` and writes an audit row. |
| `authz.upload_default_workspace` | the principal's `Membership.defaultWorkspaceId`, which is its `PERSONAL` workspace | — | An upload with no explicit workspace is private by construction, not by remembering. | A membership with a NULL default workspace cannot COMMIT (`membership_default_workspace_required`, deferred). |
| `authz.grantee_kind_enum` | `enum GranteeKind { USER, API_KEY }`; exactly one of `grantee_membership_id` / `grantee_api_key_id` set | — | Designed in on day one so adding key-grants later is not an index rewrite on a live authorization table (D-F1-5). | `document_grant_grantee_exactly_one` CHECK. A grant with both or neither cannot be inserted. |
| `authz.grant_capabilities` | `canApprove`, `canExport` — booleans on the grant, default `false` | — | Reading never implies approving or exporting. | Absent capability ⇒ **403 `insufficient_scope`**, not 404, because the principal can already see the document. |
| `authz.api_key_binding` | an `ApiKey` has `workspaceId NOT NULL`, `ownerMembershipId NOT NULL`, its own `scopes`, and its own `defaultVisibility` | — | A key's authority comes from its own row, not from the human who created it. `ownerMembershipId` is for accountability and offboarding and is **never** consulted by the visibility predicate. | An API key never sees its owner's private documents. Revoking the owner's membership does not silently keep the key alive — the offboarding query is `api_key_org_owner_idx`. |
| `id.internal` | `uuid` v7, generated in application code (`uuid@14.0.2`, `v7()`), `@db.Uuid`, branded `EntityId` | — | Ids must exist before the row (two-phase upload); v7 gives btree append locality; native 16-byte type keeps ~20 composite FKs cheap (D-F1-6). | Never `@default(uuid(7))` (invisible to raw writers) and never `@default(dbgenerated("uuidv7()"))` (pins PG ≥ 18; settability in `create()` is UNVERIFIED and the seed needs literal ids). |
| `id.external.count` | **two identifiers**: internal `uuid` PK (never leaves the server) + external `public_id` | — | Resolves contradiction 7 (`g` K-1 vs `l` §1.2). A UUIDv7 on the wire discloses the upload millisecond to everyone in the transport path, and 62 effective random bits is a weaker target than 160. | A lint rule fails the build if `document.id` reaches a response serializer. |
| `id.external.shape` | 160 bits from `crypto.randomBytes(20)`, Crockford base32 (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`), 32 chars, stored `VARCHAR(32)`, `CHECK (public_id ~ '^[0-9A-HJKMNP-TV-Z]{32}$')` | — | Non-enumerable (2¹⁶⁰), no timestamp leak, no I/L/O/U so it survives being read aloud or retyped. | A 23505 on `document_public_id_key` retries generation once, then fails the request. Expected to execute never. |
| `id.external.wire_prefix` | `doc_` prepended on the wire; the **stored** column holds the bare 32 characters | — | `l` §1.2's prefix is genuinely useful UX; it is transport decoration, not part of the identifier. | A compile-time constant, never configurable — two deployments disagreeing about a prefix is a support incident. A mis-prefixed id is a **404**, not a 400. |
| `api.not_found_rule` | **RES-404**: 404 when the principal has not already been told the resource exists; 403 `insufficient_scope` only when it has. Full table in D-F1-13. | — | Resolves contradiction 9 (`j` §7.1.1's blanket 404 vs `l` §2.1's same-tenant 403). "Listable to this principal" is the exact boundary. | There is deliberately no `CrossTenantError` type — a scoped query returns `null` and 404 falls out. Byte-identical bodies for every 404, asserted per route. |
| `api.not_found_floor_ms` | `25` | `RES_404_MIN_MS` | The existing-but-invisible path costs one extra heap fetch plus up to one extra index probe (~10–50 µs) versus a nonexistent id. 25 ms is ~500× the signal. `l` §2.2's "not meaningfully distinguishable" is wrong under this design. | Value outside `[0, 250]` ⇒ boot refusal. `0` permitted **only** when `NODE_ENV=test`. |
| `api.enumeration_alarm` | `20` not-found responses per principal per `60` s ⇒ `SEC_ENUMERATION_SUSPECTED` audit event + `30` s cooldown on document routes | `SEC_ENUM_THRESHOLD`, `SEC_ENUM_WINDOW_SECONDS`, `SEC_ENUM_COOLDOWN_SECONDS` | The timing floor stops a *confirmation*; only a volumetric control stops a *scan*. | Cooldown returns `429`, which is not an existence oracle because it is emitted regardless of whether any probed id was real. |
| `admin.scope` | **tenant-scoped.** `OrgRole.ADMIN`/`OWNER` exist only on a `Membership`. There is **no global org role**. INNOVERA staff are `platform_staff` rows with **no ambient read of any document**. | — | A global tenant-crossing role is the largest standing breach surface in a PDPA product (D-F1-15). | Until an `AdminAccessGrant` exists, staff receive 404 on every tenant document, identically to any other principal. |
| `admin.override.mechanism` | `DocumentAccess.findWithAdminOverride(principal, publicId, reason)` — the **only** code path that sets `app.is_org_admin='on'`; writes one `AdminAccessLog` row per document read, in the same transaction | — | Admin content access must be audited, not ambient. A normal admin request is not elevated, so the log records exceptions rather than 100 % of traffic. | `dependency-cruiser` allows exactly one file to import `withAdminOverride`. An elevated read that fails to log rolls back the read. |
| `admin.override.ttl_minutes` | `60` | `ADMIN_OVERRIDE_TTL_MINUTES` | Bounded elevation; `admin_grant_ttl_bounded` CHECK enforces it in the database, not only in code. | `expires_at > created_at + 60 min` ⇒ insert rejected. |
| `admin.override.reason_min_chars` | `20` (after `btrim`) | `ADMIN_OVERRIDE_REASON_MIN_CHARS` | A required reason changes behaviour more than any technical control (`j` §9.3). | `admin_grant_reason_length` / `admin_log_reason_length` CHECKs reject shorter. |
| `admin.override.max_concurrent` | `4` active elevations per principal | `ADMIN_OVERRIDE_MAX_CONCURRENT` | Bounds a compromised admin session's reach. | 5th elevation refused `E_TOO_MANY_ELEVATIONS`. |
| `admin.override.alert_reads_per_hour` | `50` | `ADMIN_OVERRIDE_ALERT_READS_PER_HOUR` | `j` §9.3's "an admin reading 50 documents in an hour", made numeric. | Alert only; never blocks — a genuine incident response must not be rate-limited. |
| `db.roles` | `ocr_owner` (migrations), `ocr_app` (request path, visibility-enforced), `ocr_worker` (job path, tenant-only), `ocr_queue` (`extraction_jobs` only), `ocr_erasure` (purge) | `DATABASE_URL`, `DATABASE_URL_WORKER`, `DATABASE_URL_QUEUE`, `DATABASE_URL_ERASURE`, `DATABASE_URL_MIGRATOR` | Five blast radii. The worker is visibility-blind by role rather than by an ambient admin flag. | Created by a bootstrap `psql` script, **not** by Prisma. Migration 0001 raises `BOOTSTRAP_ROLES_MISSING` if any is absent. |
| `db.guc.org` | `app.current_org` (uuid) | — | The tenant predicate on every policy. | Absent ⇒ `nullif(...)::uuid` is NULL ⇒ predicate NULL ⇒ **zero rows**, fail-closed. |
| `db.guc.membership` | `app.current_membership` (uuid; empty for `apiKey` and `system`) | — | Drives the owner-match and user-grant branches. | Empty ⇒ those branches are NULL ⇒ false. Never `''::uuid` — always read through `nullif(..., '')`. |
| `db.guc.api_key` | `app.current_api_key` (uuid; empty for `user` and `system`) | — | Drives the created-by and key-grant branches. | As above. |
| `db.guc.workspaces` | `app.current_workspaces` — comma-separated uuids, read by `app_current_workspaces()` (`STABLE`, `PARALLEL SAFE`) | — | A set cannot be a scalar GUC; a comma list plus `= ANY(...)` avoids a sub-SELECT and therefore avoids any recursion risk on this branch. | Empty ⇒ empty array ⇒ workspace branch false. |
| `db.guc.workspace_cap` | `200` workspace ids (≈ 7.4 KB) | — | A truncated authorization set is a silent authorization change. | Exceeding it ⇒ `E_TOO_MANY_WORKSPACES`, request refused. Never truncated. |
| `db.guc.admin_override` | `app.is_org_admin` ∈ `'on'` / `'off'`, default `'off'` | — | Set to `'on'` in exactly one function (§6.3). | Any other code path setting it is a CI failure (grep on `is_org_admin` outside the allowlisted file). |
| `db.guc.setter` | `set_config(name, value, true)` — `is_local = true`, always parameterised | — | `SET LOCAL` cannot take a bind parameter, so the concatenated form is an injection vector inside the security control; omitting `is_local` leaks the previous tenant's context to the next request on that pooled connection. | String-concatenated `SET LOCAL` is banned by lint. All five GUCs are set in one statement batch. |
| `db.rls.visibility_policy` | `document_visibility` on `documents` `FOR ALL TO ocr_app` — six OR branches (admin flag, owner match, created-by-key, workspace+non-private, org-wide, active grant), `WITH CHECK` on the tenant predicate only. Full SQL in §5.3. | — | Second, independent enforcement of the same predicate the chokepoint applies. `documents → document_grants` is acyclic, so no `SECURITY DEFINER` wrapper is needed. | Missing policy ⇒ default-deny (zero rows) ⇒ startup assertion crash-loops rather than serving. |
| `db.rls.children` | child tables (`document_pages`, `ocr_results`, `document_analyses`, `extraction_field_values`, `corrections`, `extraction_jobs`, `job_events`, `document_runs`) carry **tenant-only** policies | — | They are reachable only through an unforgeable `DocumentRef`; a six-branch predicate on 1.56 M `ocr_results` buys nothing the type system has not already closed. | If `DocumentRef` is ever weakened, these tables lose visibility enforcement — which is why the brand is `unique symbol` and the `as` cast is lint-banned. |
| `authz.chokepoint` | `DocumentAccess` in `src/modules/documents/infrastructure/document-access.ts`; the only holder of the ten document delegates; `visibilityWhere(principal)` is defined once and used by both `resolve()` and `list()` | — | One place a filter can be missing, and it is covered by the §6.6 equivalence test. | A second copy of the predicate anywhere is a review-blocking defect. |
| `authz.type_guarantee` | `ScopedTx = Omit<Prisma.TransactionClient, 'document'\|'documentPage'\|'documentRun'\|'ocrResult'\|'documentAnalysis'\|'extractionFieldValue'\|'correction'\|'extractionJob'\|'jobEvent'\|'documentGrant'>` | — | A new route writing `tx.document.findMany` fails `tsc`, not review. This is the type-level guarantee the brief demanded. | Removing a name from the exclusion list fails `tests/architecture/scoped-tx.test.ts`. |
| `authz.document_ref` | `DocumentRef` — branded with a module-private `declare const … : unique symbol`; produced **only** by `DocumentAccess.resolve()`; every child-entity method takes it instead of a raw id | — | Proof that visibility was evaluated for a specific principal, carried in the type system. | `as unknown as DocumentRef` is banned by ESLint `no-restricted-syntax`; `eslint-disable` under `src/modules/documents/**` fails CI. |
| `authz.raw_sql_rule` | `$queryRaw`, `$queryRawUnsafe`, `$executeRaw`, `$executeRawUnsafe` allowed **only** under `src/modules/shared/infrastructure/db/raw/**` (CODEOWNERS-protected; 4 files in M1) | — | Raw queries bypass every application-level control; `l` §1.4's raw keyset pagination is re-expressed in Prisma (D-F1-10). | Any occurrence elsewhere fails the `dependency-cruiser` + ESLint gate. |
| `list.pagination` | Prisma keyset: `orderBy [{createdAt:'desc'},{id:'desc'}]`, `cursor {id}`, `skip 1`, `take` default **50**, max **200**, fetch `take+1` to compute `hasMore`; API cursor is opaque base64url of `{createdAt,id}` | — | Same SQL as the raw form, without the hole. `take` is never optional. | A list call without `take` fails `tsc` (the port's parameter is required). |
| `list.escape_hatch_trigger` | reconsider the denormalised `document_visibility_index` fan-out table when **p95 of `GET /api/documents` > 300 ms** over 1 h **or** any organization exceeds **100 000** non-deleted documents | — | The OR-chain is a `BitmapOr` over three indexes plus one grant probe; the cost that grows is the sort (~24 000 rows at a 240 k/yr corpus ⇒ single-digit ms). | The hatch is a **new table**, not a change to `documents` — additive and reversible, which is what keeps "no retrofit-required" honest. |
| `uniq.storage_original_fingerprint` | `CREATE UNIQUE INDEX storage_object_org_original_fp_key ON storage_objects (organization_id, content_fingerprint) WHERE kind = 'ORIGINAL' AND deleted_at IS NULL;` — **replaces** `@@unique([organizationId, contentFingerprint, kind])` | — | Only `ORIGINAL` is content-addressed; derivatives are identity-addressed and already unique via `storage_object_bucket_key_key`. Fixes the blank-page `23505` (defect A). | Writes use raw `INSERT … ON CONFLICT (organization_id, content_fingerprint) WHERE kind='ORIGINAL' AND deleted_at IS NULL DO NOTHING`. Reusing a colliding derivative row is **forbidden** — it makes PDPA erasure of document A destroy a blob document B renders. |
| `uniq.document_page` | `@@unique([documentId, pageNumber], map: "document_page_doc_number_key")` — **unchanged**; requeue **upserts** pages (`ON CONFLICT (document_id, page_number) DO UPDATE`) | — | A page number is a property of the document, not of a run. `document_pages` is a mutable projection (it has `updated_at`); `ocr_results` is immutable evidence (it has none). | An `INSERT` (not upsert) on the render step of a requeue is a `23505` — the exact wedge class this document exists to remove. |
| `uniq.ocr_result` | `@@unique([documentPageId, runId, engineId, engineVersion, renderDpi], map: "ocr_result_page_run_engine_key")` — **replaces** `ocr_result_page_engine_key` | — | Within a run, a worker retry is idempotent (`ON CONFLICT DO NOTHING`); across runs, the same engine at the same DPI is legal, which is what makes the operator requeue and the mandatory VLM re-run possible on an append-only table (defect B). | Without `runId`, `FAILED → QUEUED` — the only recovery edge — reproduces `23505` forever and the only exit is deletion. |
| `uniq.document_run_seq` | `@@unique([documentId, runSeq], map: "document_run_doc_seq_key")`; `run_seq` allocated under `SELECT 1 FROM documents WHERE id=$1 FOR NO KEY UPDATE` then `max(run_seq)+1` | — | Replaces `Document.requeueCount`, a mutable counter two concurrent operators read identically. `FOR NO KEY UPDATE` does not block concurrent FK checks. | Deterministic; no retry loop. The unique index is a backstop, not the mechanism. |
| `uniq.document_run_one_active` | `CREATE UNIQUE INDEX document_run_one_active_key ON document_runs (document_id) WHERE outcome = 'RUNNING';` | — | A requeue must cancel the live run in the same transaction. | Otherwise a distinct, loud `23505` mapped to **409 `run_in_progress`** — a correct refusal, never a wedge. |
| `uniq.extraction_job_dedupe` | `@@unique([organizationId, dedupeKey], map: "extraction_job_org_dedupe_key")` | — | Enqueue idempotency via `ON CONFLICT (organization_id, dedupe_key) DO NOTHING`. Tenant-scoped because unique-constraint checks bypass RLS, so a global unique on tenant-controlled input is a cross-tenant existence oracle. | A global `@unique` on `dedupe_key` is a review-blocking defect. |
| `job.dedupe_key_grammar` | `` `${runId}:${kind}:${pageFrom ?? '*'}-${pageTo ?? '*'}` ``, `VARCHAR(200)`, shape-CHECKed (§4.1) | — | Derived from the **run**, not from a mutable counter. `'*'` encodes NULL because PostgreSQL treats NULLs as distinct in a unique index, so a column-based key on nullable page bounds would permit two identical whole-document jobs. | A hand-built key that omits the run fails `job_dedupe_key_shape`. |
| `uniq.workspace_member_active` | `CREATE UNIQUE INDEX workspace_member_ws_membership_key ON workspace_members (workspace_id, membership_id) WHERE revoked_at IS NULL;` | — | Re-adding a removed member must be legal — the same class of defect as A and B, closed proactively. | A full unique would make "remove then re-add" a `23505`. |
| `uniq.document_grant_active` | `CREATE UNIQUE INDEX document_grant_doc_membership_key ON document_grants (document_id, grantee_membership_id) WHERE grantee_membership_id IS NOT NULL AND revoked_at IS NULL;` and `document_grant_doc_api_key_key` on `(document_id, grantee_api_key_id) WHERE grantee_api_key_id IS NOT NULL AND revoked_at IS NULL` | — | Re-granting after revocation must be legal, for both grantee kinds. | Same class as above. |
| `uniq.workspace_personal_owner` | `CREATE UNIQUE INDEX workspace_personal_owner_key ON workspaces (owner_membership_id) WHERE kind = 'PERSONAL';` | — | Exactly one personal workspace per membership. | A second one would make `Membership.defaultWorkspaceId` ambiguous. |
| `partial_index.policy` | All 7 partial indexes are **hand-authored raw SQL** in migrations, on the documented drift allowlist, asserted at startup by `pg_indexes.indexdef`. The Prisma `partialIndexes` preview flag is **NOT enabled**. | — | prisma/prisma#29263 (dropped and recreated on every migration in 7.4.x) and #29282 (excluded from DMMF `uniqueFields`). A drop-and-recreate window on `document_grant_doc_membership_key` is a window in which duplicate grants land. | Missing or altered index ⇒ startup raises `STARTUP_PARTIAL_INDEX_MISSING: <name>` and the process crash-loops. |
| `db.backup.globals` | nightly `pg_dumpall --globals-only` **alongside** `pg_dump`, plus a startup assertion that the four runtime roles exist and `documents` has ≥ 3 policies | — | `pg_dump` dumps one database and carries no roles; a role-less restore leaves FORCE RLS on with zero policies and the app returns zero rows for every query with no error. | The process must **crash-loop, not serve**. `STARTUP_ROLES_MISSING` / `STARTUP_DOCUMENT_POLICIES_MISSING`. |
| `schema.invariants` | TEN-1 (composite FK into every tenant table), TEN-2 (no bare `*Id`/`*Ids` scalar without a relation or a commented `NO_FK_BY_DESIGN` entry; uuid arrays replaced by join tables), TEN-3 (tenant-table list derived from the DMMF, never typed), TEN-4 (global tables asserted absent), UNIQ-1 (every `@@unique` on tenant-controlled input includes `organizationId`), VIS-1 (every externally-addressable model has a `publicId`), VIS-2 (`ownerUserId` never appears in authz code) | — | TEN-2 is the check that would have caught `DocumentPage.renderStorageObjectId` and the two `DocumentAnalysis` uuid arrays; the M0 DMMF test iterated only `f.kind === "object"` and was structurally blind to them. | Each is a Vitest test over the generated DMMF or a CI grep. A violation fails the build, not the review. |
| `storage.tenant_prefix_check` | `CHECK (object_key LIKE 'org/' \|\| organization_id::text \|\| '/%')` on `storage_objects.object_key`, and the same on `ocr_results.payload_ref` and `extraction_jobs.result_ref` | — | Object-storage keys are resolved with the app credential and never touch PostgreSQL, so neither the composite FK nor RLS applies to them. The `org/{id}/` prefix must be a constraint, not a convention. | This document does **not** pick the object-key grammar (three incompatible forms exist across `g` §7.4, `j` §4, `l` §4.4) — but whichever wins must keep `org/{organization_id}/` as its first two segments. |
