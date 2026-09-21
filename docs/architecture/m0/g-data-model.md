---
dimension: g-data-model
title: PostgreSQL + Prisma data model (item K)
m0_items: K
status: reviewed
date: 2026-09-09
reviewed: 2026-09-09
review_pass: adversarial-completeness-critic
---

# G — PostgreSQL + Prisma data model (M0 item K)

> **Integration status (2026-09-12):** Read the [architecture index](../README.md) and its consolidation report before using these examples. Individual review labels do not close cross-document conflicts; no application implementation is verified.

**Scope.** The complete persistence design for INNOVERA OCR AI: entities, exact Prisma 7.9.1 types,
relations with delete behaviour, every index with the named query that justifies it, and explicit
resolutions for the nine hard design questions in the brief.

**Nature of this document.** Everything about *house conventions* is verified — I read
`~/Documents/jawbong/prisma/schema.prisma`, its migration SQL, its repositories, and its
`package.json` in this session, and the schema below matches them line for line. Everything about
*this product's* workload (row counts, page sizes, query mix) is a **stated assumption**, marked as
such, because no requirements document exists yet. Library facts carry URLs. Nothing here has been
executed against a database — there is no PostgreSQL for this project yet.

---

## 0. Evidence base

Files read in-session:

| Path | What it established |
|---|---|
| `/Users/innovera/Documents/jawbong/prisma/schema.prisma` | Naming, id strategy, timestamp type, JSON type, index-naming convention, `@@map` style |
| `/Users/innovera/Documents/jawbong/prisma/migrations/20260803000000_phase_00_foundation/migration.sql` | Migrations are **hand-written SQL**, and they carry constructs Prisma cannot express (a `CHECK` constraint) |
| `/Users/innovera/Documents/jawbong/prisma/migrations/migration_lock.toml` | `provider = "postgresql"` |
| `/Users/innovera/Documents/jawbong/prisma/seed.ts` | Seed is `tsx`, guarded by `assertDisposableDatabaseUrl`, uses **fixed literal UUIDs** and `upsert` |
| `/Users/innovera/Documents/jawbong/prisma.config.ts` | `prisma/config` `defineConfig`, seed command, datasource URL from env with a poisoned fallback |
| `/Users/innovera/Documents/jawbong/package.json` | Prisma **7.9.1**, `@prisma/adapter-pg` 7.9.1, `pg` 8.22.0, Zod 4.4.3, TS 6.0.3, Node 22.23.1, pnpm 11.18.0. Scripts contain `prisma migrate deploy` and `prisma generate` — **never `prisma migrate dev`** |
| `/Users/innovera/Documents/jawbong/docker-compose.test.yml` | Target engine is **`postgres:18.4-bookworm`** |
| `/Users/innovera/Documents/jawbong/src/modules/shared/infrastructure/prisma-client.ts` | `new Pool({ connectionString, max: 5 })` → `PrismaPg` adapter → `PrismaClient({ adapter })` |
| `/Users/innovera/Documents/jawbong/src/modules/outbox/infrastructure/prisma-*.ts` | IDs generated **in the application** with `node:crypto` `randomUUID()`; `$queryRaw` + `FOR UPDATE SKIP LOCKED`; rows re-parsed through Zod on the way out |
| `/Users/innovera/Documents/jawbong/src/lib/db/database-safety.ts` | Fail-closed allowlist on host/port/user/db/env/scope |
| `/Users/innovera/Documents/jawbong/src/lib/auth/actor-context.ts` | Provider-neutral `ActorContext`, deny-by-default `AuthorizationPort` |
| `/Users/innovera/Documents/jawbong/dependency-cruiser.config.mjs` | Domain may not import `@prisma`, infra, Next or React |
| `/Users/innovera/Documents/OCR/docs/architecture/m0/a-environment-and-stack.md` §5.5 | **Decision A-6:** copy `outbox_events` + `idempotency_records` verbatim; do **not** use the outbox as the job queue; build a dedicated job table on the krs-pos claim shape with priority, lease heartbeat, lease-guarded completion |
| `/Users/innovera/Documents/OCR/docs/architecture/m0/b-ai-topology-discovery.md` §2.2–2.4 | **`ocr-web` is the only process that touches PostgreSQL.** `ocr-worker` (Python) returns text over the wire and holds no DB credential. Also: that doc's diagram says "PostgreSQL 16" — see §12.3, I treat that as an inconsistency, not a decision |
| `/Users/innovera/Documents/OCR/docs/architecture/m0/d-ocr-engine.md` §9.2 | The `OcrProvider` wire contract: `OcrDocument`/`OcrPage`/`OcrLine`, `Quad`, nullable geometry and confidence, `rawText` separate from `text`, `deterministic` flag, `TokenSpan` from `newmm` tokenisation |

Facts fetched from the public web this session (URLs in §14).

**Review pass (2026-09-09).** This document has been through an adversarial completeness review.
Ten defects were corrected in place — four of them correctness bugs that would have shipped
(§8.1 cascade-vs-append-only deadlock, §5.7 racy single-current-value trigger, §5.5 `dedupeKey`
requeue collision, §5.8 `UsageCounter` period collision) — plus one factual error about Prisma's
`ops:` escape hatch, one false claim about index leading columns, and one internal contradiction
about object-storage key shape. Four previously-`UNVERIFIED` items were resolved against primary
sources. Everything changed is itemised in **§15 Critic Notes**. Corrections are marked inline with
**[REVISED]** so a reader of the earlier draft can find them.

---

## 1. The eleven decisions, in one table

| # | Decision | Confidence | Reversibility |
|---|---|---|---|
| **K-1** | **UUIDv7** primary keys, `@db.Uuid`, generated **in the application** with `uuid@14.0.2`'s `v7()`. No `@default` in the schema — jawbong's exact convention. Plus a separate 160-bit random `publicId` on `Document` only. | high | hard |
| **K-2** | **`Organization` from day one.** Every tenant-scoped table carries a denormalised `organizationId`, and child rows are bound to their parent by a **composite foreign key `(parentId, organizationId)`** so a cross-tenant parent is a foreign-key violation, not a bug. | high | hard |
| **K-3** | **Three independent isolation layers:** (1) typed application scoping, (2) the composite FK in K-2, (3) PostgreSQL **RLS with `FORCE ROW LEVEL SECURITY`** and a non-owner runtime role. RLS is defence-in-depth, never the only control. | high | moderate |
| **K-4** | Document status: the ten states from the brief **plus `QUARANTINED`**. Legal transitions enforced by a **PL/pgSQL trigger**, not by prose. `QUARANTINED` is absolutely terminal; retry re-enters only at `QUEUED`. | high | moderate |
| **K-5** | Large text lives in **per-page rows in PostgreSQL**, not per-document and not in object storage. Blobs (originals, page renders, the immutable engine payload) live in object storage. Threshold rule: **>256 KB or binary → object storage.** | high | moderate |
| **K-6** | JSONB only when the value is written once, read whole, never a `WHERE`/`ORDER BY`/`JOIN` target, and size-capped by a `CHECK`. Everything we filter on is relational. | high | moderate |
| **K-7** | Content hashes are **tenant-scoped, never global.** Cross-tenant dedup is a file-existence oracle and a deletion-compliance hole; it is rejected outright. Same-tenant dedup detects and offers, it does not block. | high | easy |
| **K-8** | `ocr_results`, `document_analyses`, `corrections`, `audit_logs`, `job_events`, `prompt_versions` and published `extraction_templates` are **append-only, enforced by trigger + `REVOKE UPDATE, DELETE`** from the runtime role. Lawful erasure runs as a separate privileged role. | high | moderate |
| **K-9** | The audit log stores **references, never content.** No OCR text, no extracted field values, no filenames, no raw IPs, no key material. 400-day hot retention. | high | easy |
| **K-10** | **Store `searchTokens` at ingest, build no search index until M4.** `to_tsvector` on raw Thai is near-useless; the workable path is `to_tsvector('simple', <newmm-tokenised, space-joined text>)`, and the tokens are a free by-product of work d-ocr-engine §7.1 already commits to. | high | easy |
| **K-11** | Migrations are **hand-written SQL**, generated as a draft by `prisma migrate diff` and then edited. `prisma migrate dev` is banned. CI runs a drift gate. | high | easy |
| **K-12** *(added in review)* | **Thai text semantics are schema-level, not application folklore.** Thai-aware NFC (`NFC` + Thai mark reordering + SARA AM handling), Thai→ASCII digit folding into a second token stream, an **ICU `th-TH` collation on every Thai-sortable column**, and an explicit **Buddhist-Era → CE** conversion recorded per date value. Each is a column or a collation, not a comment. | high | moderate |
| **K-13** *(added in review)* | **No `DocumentBlock` table.** Line-level geometry stays inside `OcrResult.linesJson`. Block/paragraph structure is a *derived* view, materialised only if and when layout-aware extraction is specified. Rejected alternative and reversal trigger in §5.9. | medium | easy |

---

## 2. K-1 — Primary key strategy

### The candidates, scored on what actually differs

| | `bigint` identity | `cuid2` (text) | `uuid` v4 | **`uuid` v7** |
|---|---|---|---|---|
| Storage per PK value | 8 B | 24–28 B (varlena text) | 16 B | **16 B** |
| Insert locality | perfect (append) | random | random | **near-perfect (time-ordered)** |
| Comparison cost | integer | `bytea`-style memcmp on text | 128-bit memcmp | 128-bit memcmp |
| Native PG type | `int8` | none — `text`/`varchar` | `uuid` | **`uuid`** |
| Safe to expose in a URL | **no** — enumerable | yes | yes | yes, with a caveat (below) |
| Generatable offline / in a worker | no (needs a round trip) | yes | yes | **yes** |
| Merge-friendly across environments | no | yes | yes | **yes** |
| Leaks creation time | no | no | no | **yes, ~1 ms precision** |

### Why UUIDv7 wins here

1. **We must generate ids before the row exists.** Jawbong's `PrismaOutboxRepository` and
   `PrismaIdempotencyRepository` both do `randomUUID()` in application code
   (`/Users/innovera/Documents/jawbong/src/modules/outbox/infrastructure/prisma-idempotency-repository.ts`).
   Our upload flow needs the same: we must know the **`StorageObject.id`** before we stream bytes,
   and the **`Document.id`** before we insert the `documents` row that points at it, because the
   upload is a two-phase write (blob first, row second) and the second phase must be idempotent on
   retry. A `bigint identity` forces an insert-then-store-then-update dance with a window where the
   row exists and the blob does not. This alone eliminates `bigint`.
   **[REVISED] The canonical object key is `org/{organizationId}/blob/{contentFingerprint}`, not
   `org/{orgId}/doc/{docId}/original`.** The earlier draft stated both forms in different sections
   (§2 and §7.3) and they are not interchangeable: a per-document key makes the same-tenant blob
   reuse promised in §7.1 step 4 impossible, because two documents over identical bytes would land
   on two different keys. The content-addressed, tenant-namespaced form is the one that holds, and
   it is what `storage_object_bucket_key_key` enforces. Full key grammar is in §7.4.
2. **Index locality is the whole reason not to use v4.** A random 128-bit key inserted into a btree
   dirties a page anywhere in the index on every insert, which inflates full-page images in WAL and
   destroys cache locality. UUIDv7's leading 48-bit millisecond timestamp makes inserts append to the
   right-most leaf, exactly like a `bigserial`. *UNVERIFIED by us:* published benchmarks report
   roughly 2–3× insert throughput and materially lower index bloat for v7 over v4; we have measured
   nothing.
3. **cuid2 is strictly worse than v7 in PostgreSQL.** It is random (so no locality), stored as text
   (so 50–75 % larger in every index and every foreign key), and has no native type, so it cannot use
   `@db.Uuid`. Its one advantage — no timestamp leak — is addressable more cheaply (point 5).
4. **Size only matters at a scale we are not at.** For our largest table, `ocr_results` at a
   projected 1.56 M rows in year 1 (§11), the primary-key index is ≈ 50 MB with `uuid` and ≈ 31 MB
   with `bigint`. A 19 MB difference is not an architectural input. The crossover where it becomes
   one is around **10⁹ rows**, where the same delta is ~12 GB. Nothing in this product's projection
   approaches that.
5. **The one real objection, quantified.** RFC 9562 UUIDv7 carries 74 random bits.
   PostgreSQL 18's `uuidv7()` spends 12 of them on a sub-millisecond timestamp fraction to guarantee
   monotonicity within a session, leaving **62 random bits**. 2⁶² ≈ 4.6 × 10¹⁸ — unguessable in
   practice, but it is not the 122 bits of a v4, and the timestamp *is* readable
   (`uuid_extract_timestamp()`). For a document id that appears in a shareable URL, that discloses
   upload time to anyone holding the link.
   **Resolution:** `Document` gets a second column, `publicId`, a 160-bit
   (`crypto.randomBytes(20)`, base32-crockford, 32 chars) opaque token. All external routes —
   `/documents/{publicId}`, the REST API, share links — use `publicId`. The `uuid` PK never leaves
   the server. Cost: one extra 32-byte unique index on one table (≈ 10 MB at 240 k rows/year).
   No other table is externally addressable, so no other table pays this.

### Generation, exactly

```ts
// src/modules/shared/domain/identity.ts   (domain layer — no Prisma, no Next; satisfies
// dependency-cruiser rule "domain-is-framework-free")
import { v7 as uuidv7 } from "uuid";           // uuid@14.0.2, MIT — VERIFIED 2026-09-09 against
                                               // registry.npmjs.org/uuid/latest: version "14.0.2",
                                               // license "MIT", described as "RFC9562 UUIDs".
import { randomBytes } from "node:crypto";

/** Branded so a raw string can never be passed where an id is required. */
export type EntityId = string & { readonly __brand: "EntityId" };

export function newEntityId(): EntityId {
  return uuidv7() as EntityId;                  // RFC 9562 v7, lowercase hyphenated
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** 160 bits of CSPRNG, base32-crockford, 32 chars. Externally exposed document handle. */
export function newPublicId(): string {
  const b = randomBytes(20);
  let out = "", bits = 0, acc = 0;
  for (const byte of b) {
    acc = (acc << 8) | byte; bits += 8;
    while (bits >= 5) { out += CROCKFORD[(acc >>> (bits - 5)) & 31]; bits -= 5; }
  }
  return out;
}
```

**Why not `@default(uuid(7))` or `@default(dbgenerated("uuidv7()"))`:**

- `@default(uuid(7))` (available since Prisma ORM 5.18.0) generates the value **inside Prisma
  Client**, so `$queryRaw` inserts and any future non-Prisma writer get nothing. It also hides id
  generation from the domain layer, which is where our branded `EntityId` lives.
- `@default(dbgenerated("uuidv7()"))` would push the default into PostgreSQL — attractive, and
  PostgreSQL 18.4 does ship `uuidv7()` — but it pins us to PG ≥ 18, and
  **UNVERIFIED:** the Prisma docs do not state whether a field with a non-empty `dbgenerated()`
  default remains settable in `create()`. Our seed file needs literal ids (jawbong's seed uses
  `"00000000-0000-4000-8000-000000000001"`), so settability is not optional.
- Application-side generation is version-independent, testable without a database, and matches
  jawbong exactly. That is the deciding argument.

**What would change this decision:** a requirement to insert rows from PostgreSQL itself (a trigger,
a `INSERT ... SELECT` backfill, a logical-replication apply) at a volume where round-tripping ids
through the application is impractical. Then add `DEFAULT uuidv7()` in the migration SQL as a *safety
net only* — it is invisible to Prisma's diff engine (§10.2) and does not change the application path.

---

## 3. K-2 / K-3 — Tenancy, and making IDOR structurally impossible

### 3.1 `organizationId`, not `userId`

**Chosen:** an `Organization` aggregate, with `Membership(organizationId, userId, role)` joining
globally-unique `User` rows to it. Every tenant-scoped table carries `organizationId`.

**Rejected — `userId` only.** It is cheaper today and wrong within a quarter. Three forcing
functions, each of which alone kills it:
- The product ships an **external OCR API** with `ApiKey`s. A key is not a person; it belongs to a
  customer. Quotas, rate limits and billing are per customer.
- **Quotas and usage counters** (`UsageCounter`, `Quota`) are per customer, not per person.
- **Review workflow.** `READY_FOR_REVIEW` → `COMPLETED` implies someone other than the uploader
  approves. That is a team, i.e. an organization.

Retrofitting a tenant column later means: add a nullable column to ~14 tables, backfill,
rewrite every composite index (the tenant column must be *first*), rewrite every query, write
RLS policies, and prove no query was missed — with production data live. Doing it now costs one
table and one column.

**Rejected — schema-per-tenant.** Prisma's datasource binds one schema; multi-schema support is a
separate feature and every migration would fan out over N schemas. Operationally hostile at 50+
tenants.

**Rejected — database-per-tenant.** Correct for a handful of very large regulated customers. Wrong
for a platform expecting dozens of tenants: N connection pools, N migration runs, N backup targets.
**What would change this:** a single customer with a contractual physical-isolation requirement.
Handle that as a separate deployment of the whole stack, not as a schema variant.

### 3.2 Layer 1 — typed application scoping

The failure mode we are defending against is a developer writing
`prisma.document.findUnique({ where: { id } })` and forgetting `organizationId`. Make that
unrepresentable:

```ts
// src/modules/shared/application/tenant-scope.ts
export type OrganizationId = string & { readonly __brand: "OrganizationId" };

/** Produced ONLY by the authorization port, from a verified session or API key. */
export interface TenantScope {
  readonly organizationId: OrganizationId;
  readonly actor: ActorContext;              // jawbong's ActorContext, verbatim
}

/** Repository ports take a TenantScope as the first argument. There is no overload without it. */
export interface DocumentRepository {
  findByPublicId(scope: TenantScope, publicId: string): Promise<Document | null>;
  list(scope: TenantScope, q: DocumentQuery): Promise<Page<DocumentSummary>>;
}
```

Enforced mechanically by `dependency-cruiser`, extending
`/Users/innovera/Documents/jawbong/dependency-cruiser.config.mjs`: only
`src/modules/*/infrastructure/**` may import `@/generated/prisma`. Application and domain code
cannot reach a Prisma delegate at all, so it cannot forget a `where`.

### 3.3 Layer 2 — the composite foreign key (the strongest and cheapest control)

Every parent gets `@@unique([id, organizationId])`. Every child's foreign key references **both**
columns:

```prisma
model Document {
  id             String @id @db.Uuid
  organizationId String @map("organization_id") @db.Uuid
  // ...
  @@unique([id, organizationId], map: "document_id_org_key")   // FK anchor, not a query index
}

model DocumentPage {
  id             String @id @db.Uuid
  organizationId String @map("organization_id") @db.Uuid
  documentId     String @map("document_id") @db.Uuid

  document Document @relation(fields: [documentId, organizationId],
                               references: [id, organizationId],
                               onDelete: Cascade, onUpdate: NoAction)
}
```

Now inserting a `DocumentPage` whose `organizationId` disagrees with its `Document`'s is a
**foreign-key violation at the storage layer**. No policy, no `where`, no code review — the row
cannot exist. This is what "structurally impossible" should mean, and it costs one extra unique index
per parent.

#### [REVISED] The discipline was not actually applied everywhere — the corrected list

The earlier draft claimed IDOR was "structurally impossible" while leaving **six** relations on
single-column foreign keys, each of which permits a cross-tenant pointer. That claim was
overstated. The rule is now stated as an invariant with a machine check, and every violation below
is fixed in §5:

> **Invariant TEN-1.** Every foreign key whose *referenced* table is tenant-scoped MUST be a
> composite `(id, organizationId) → (id, organizationId)` key. A single-column FK into a
> tenant-scoped table is a review-blocking defect.

| Relation | Draft (broken) | Corrected |
|---|---|---|
| `Document.originalStorage → StorageObject` | `fields: [originalStorageObjectId]` | `fields: [originalStorageObjectId, organizationId]` |
| `Document.template → ExtractionTemplate` | `fields: [templateId]` | `fields: [templateId, organizationId]` |
| `DocumentPage.canonicalOcrResult → OcrResult` | `fields: [canonicalOcrResultId]` | `fields: [canonicalOcrResultId, organizationId]` |
| `ExtractionFieldValue.template → ExtractionTemplate` | `fields: [templateId]` | `fields: [templateId, organizationId]` |
| `ExtractionFieldValue.field → ExtractionField` | `fields: [fieldId]` | `fields: [fieldId, organizationId]` |
| `Correction.fieldValue → ExtractionFieldValue` | `fields: [fieldValueId]` | `fields: [fieldValueId, organizationId]` |
| `Correction.ocrResult → OcrResult` | `fields: [ocrResultId]` | `fields: [ocrResultId, organizationId]` |
| `Membership.organization`, `ApiKey.organization`, `Quota.organization`, `UsageCounter.organization`, `StorageObject.organization`, `ExtractionTemplate.organization`, `Document.organization` | single-column — **correct**, because the referenced table *is* the tenant root | unchanged |
| `DocumentAnalysis.promptVersion → PromptVersion` | single-column | unchanged — `prompt_versions` is global, not tenant-scoped |

The `OcrResult` and `ExtractionTemplate` models therefore also gain the `@@unique([id, organizationId])`
anchors they were missing (§5.6, §5.7).

**The machine check** (a Vitest test over the generated DMMF, so a new single-column FK into a
tenant table fails CI rather than review):

```ts
// tests/architecture/tenant-fk.test.ts
import { Prisma } from "@/generated/prisma/client";

const TENANT_SCOPED = new Set([
  "Organization","Membership","ApiKey","StorageObject","ScanResult","Document","DocumentPage",
  "ExtractionJob","JobEvent","OcrResult","DocumentAnalysis","ExtractionTemplate","ExtractionField",
  "ExtractionFieldValue","Correction","AuditLog","Quota","UsageCounter",
]);

it("every FK into a tenant-scoped table is composite on organizationId", () => {
  for (const model of Prisma.dmmf.datamodel.models) {
    for (const f of model.fields) {
      if (f.kind !== "object" || !f.relationFromFields?.length) continue;
      if (!TENANT_SCOPED.has(f.type)) continue;
      if (f.type === "Organization") continue;             // the tenant root itself
      expect(f.relationFromFields, `${model.name}.${f.name}`).toContain("organizationId");
    }
  }
});
```

**[RESOLVED — was `UNVERIFIED`] Can one scalar field back two relations on one model?**
Yes. Prisma's relations documentation states that when the same scalar field participates in more
than one relation you disambiguate with the `name` argument on `@relation`; composite foreign keys
("multiple columns on each side") are explicitly supported, and the `references` target may be any
compound `@@unique`. `organizationId` therefore appears in `Correction`'s `document`, `fieldValue`
**and** `ocrResult` relations simultaneously, each named. The draft's hedge — "apply the composite FK
to the primary parent only and enforce the second with a `BEFORE INSERT` trigger" — is withdrawn;
no such trigger is needed.

The one real Prisma constraint that remains: a **named** relation requires the matching name on the
opposite side, so `OcrResult` carries `@relation("PageResults")` / `@relation("PageCanonical")` and
`DocumentPage` mirrors both. That is already the case in §5.4/§5.6.

*Correction to the draft's own example:* it cited "`OcrResult` → `DocumentPage` and `OcrResult` →
`ExtractionJob`" as the two-parent case. `OcrResult.jobId` has **no** relation in §5.6 — it is a
bare `Uuid?` with no FK at all. That is a deliberate choice (a job may be dead-lettered and purged
while its evidence survives) and is now stated as such in §5.6 rather than being implied.

### 3.4 Layer 3 — PostgreSQL RLS, evaluated seriously

**Verdict: adopt, as a backstop, with eyes open.** RLS is not a substitute for §3.2/§3.3, and
anyone who says otherwise has not thought about the connection pool.

The policy shape:

```sql
-- Runtime roles. NOT the table owner, NOT superuser, no BYPASSRLS.
-- [REVISED] Roles and passwords are created by a BOOTSTRAP script run with psql, NOT by a Prisma
-- migration: `prisma migrate deploy` speaks the wire protocol and does not expand psql's :'var'
-- syntax, so `PASSWORD :'app_password'` in a migration file is a syntax error, and CREATE ROLE
-- needs CREATEROLE/superuser which the migration role will not have on managed PostgreSQL.
-- Migration 0001 therefore only GRANTs to roles it assumes already exist, and fails loudly if they
-- do not:  DO $$ BEGIN PERFORM 1 FROM pg_roles WHERE rolname='ocr_app';
--                     IF NOT FOUND THEN RAISE EXCEPTION 'BOOTSTRAP_ROLES_MISSING'; END IF; END $$;
CREATE ROLE ocr_app     LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;  -- bootstrap only
CREATE ROLE ocr_queue   LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;  -- bootstrap only
CREATE ROLE ocr_erasure LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;  -- bootstrap only

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE  ROW LEVEL SECURITY;   -- also applies to the table owner

-- [REVISED] The TO clause is NOT optional. PostgreSQL: "If no role is specified, or the special
-- user name PUBLIC is used, then the policy applies to all users on the system." The draft's
-- policy had no TO clause, so it applied to ocr_queue and ocr_erasure as well and would have
-- silently reduced the purge job and the queue claim to zero rows.
CREATE POLICY tenant_isolation ON documents
  FOR ALL TO ocr_app
  USING      (organization_id = current_setting('app.current_org', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.current_org', true)::uuid);

-- The purge role sees everything but may only DELETE (see §8.1).
CREATE POLICY erasure_all ON documents FOR ALL TO ocr_erasure USING (true);

-- Any role with no matching policy sees zero rows, which is the desired default for ocr_queue on
-- every table except extraction_jobs.
```

`current_setting(..., true)` returns `NULL` when the setting is absent, so the predicate is `NULL`,
so **zero rows** — it fails closed. That is the property that makes this worth having.

**[REVISED] The hole RLS does not close: referential-integrity checks bypass it.** PostgreSQL 18
documentation, §5.9 *Row Security Policies*, verbatim:

> "Referential integrity checks, such as unique or primary key constraints and foreign key
> references, always bypass row security to ensure that data integrity is maintained."

Two concrete consequences this schema must answer for, and neither was in the draft:

1. **A globally-unique column is a cross-tenant existence oracle.** Insert a value; a
   `23505 unique_violation` proves some other tenant already holds it, even though `SELECT` returns
   nothing. The draft shipped exactly one such column on tenant-controlled data:
   `ExtractionJob.dedupeKey String @unique`. It is **re-scoped to `@@unique([organizationId, dedupeKey])`**
   in §5.5. The remaining global uniques are safe *because the values are server-generated and not
   attacker-chooseable*: `documents.public_id` (160-bit CSPRNG), `api_keys.key_prefix` (CSPRNG),
   `organizations.slug` and `users.email` (deliberately global identity, and the signup flow already
   discloses "taken"). `storage_objects (bucket, object_key)` is global but every key is prefixed
   `org/{organizationId}/`, so a cross-tenant collision is unreachable without already knowing the
   other tenant's id.
   **Rule:** *a `@@unique` on tenant-controlled input MUST include `organizationId`.* Add it to the
   §3.3 DMMF test.
2. **A composite FK's error message is also an oracle — but a harmless one here.** Because RI checks
   bypass RLS, `Document.originalStorage → (id, organizationId)` fails with `23503` when the pair
   does not exist *anywhere*, not merely "not in your tenant". Since the attacker must already
   supply their own `organizationId` in the pair, the probe reveals nothing they did not know. This
   is why the composite FK is safe as an isolation control even though it reads across tenants
   internally — and it is the reason TEN-1 insists on the *composite* form: a single-column FK would
   let the row exist while pointing elsewhere.

**How Prisma interacts with it — the five things that actually bite:**

1. **It only works inside an interactive transaction.** `@prisma/adapter-pg` runs on `pg.Pool`
   (`new Pool({ connectionString, max: 5 })`, verified in
   `src/modules/shared/infrastructure/prisma-client.ts`). A bare `prisma.document.findMany()` takes
   an arbitrary pooled connection with no GUC set → the policy sees `NULL` → zero rows. The symptom
   is "my query returns nothing", not a leak, which is the correct direction to fail but is a
   debugging trap. **Every tenant-scoped query must be inside `prisma.$transaction(cb)`.**
2. **The GUC must be set with `set_config`, parameterised.** `SET LOCAL` cannot take a bind
   parameter, so `SET LOCAL app.current_org = '${orgId}'` is a string-concatenated SQL statement —
   an injection vector in the middle of the security control. The correct form:
   ```ts
   await tx.$executeRaw`SELECT set_config('app.current_org', ${scope.organizationId}, true)`;
   //                                                                          ^^^^ is_local = true
   ```
   `true` scopes it to the transaction. Omitting it leaks the previous tenant's context to the next
   request that borrows that pooled connection. This is the single most common way teams break
   isolation with pooled RLS.
3. **Empty string throws.** `current_setting('app.current_org', true)::uuid` with the value `''`
   raises `invalid input syntax for type uuid`. That is fail-loud, which is fine — but the setter
   must never pass `''`. Guard it in the branded-type constructor.
4. **The table owner bypasses RLS by default.** Migrations run as `ocr_owner`; the app runs as
   `ocr_app`. `FORCE ROW LEVEL SECURITY` closes the gap if the roles are ever merged.
5. **Cost.** Three extra round trips per operation, not two: `BEGIN`, the `set_config` statement,
   and `COMMIT`. At ~0.3 ms on a local network that is ~0.9 ms per operation; a five-query page
   render pays ~1 ms of transaction overhead once, since all five queries share the one transaction.
   **[REVISED — the draft's index claim was false.]** `organization_id` is *not* the leading column
   of every composite index in §5. It is not leading on
   `document_page_doc_number_key (document_id, page_number)`,
   `ocr_result_page_engine_key (document_page_id, engine_id, engine_version, render_dpi)`,
   `job_event_job_at_idx (job_id, at)`,
   `extraction_field_template_key_key (template_id, key)`,
   `extraction_field_template_order_idx (template_id, ordering)`,
   `document_analysis_doc_created_idx (document_id, created_at)`,
   `field_value_doc_field_current_idx (document_id, field_id, is_current)`,
   or `extraction_job_claim_idx (status, priority, available_at)`.
   The honest statement is narrower and still sufficient: **on every one of those tables the access
   path is a parent id that is itself already tenant-scoped**, so the planner reaches at most a
   handful of rows and the RLS predicate degrades to a per-row `organization_id = $const` filter on
   rows already in memory — nanoseconds, not a scan. The predicate is a genuine cost only on an
   unqualified `findMany` over a tenant table, which the `document_org_*` indexes do lead with
   `organization_id`. `current_setting()` is `STABLE`, not `IMMUTABLE`, so it can never appear *in*
   an index definition; it does not need to.
6. **[ADDED] Connection-pool arithmetic, because interactive transactions hold a connection for
   their whole callback.** `new Pool({ max: 5 })` (verified in jawbong's `prisma-client.ts`) plus
   "every tenant-scoped query is inside `$transaction`" means the app can serve **at most 5
   concurrent tenant operations per Node process**, and `maxWait: 5_000` means the 6th request
   queues for up to 5 s before throwing `P2028`. With a 10 s transaction timeout, one slow query
   pins 20 % of the pool. Three mitigations, all required before M2 load: (a) raise `max` to
   `min(20, pg_max_connections / processes)`; (b) drop the transaction timeout to **2 s** for
   request-path work and keep 10 s only for the ingest write path; (c) never call the AI gateway or
   object storage *inside* `withTenant` — the transaction wraps database work only. Point (c) is the
   one that actually bites, and it is a lint rule, not a convention: forbid `await fetch`/`s3`/
   `gateway` identifiers inside the `withTenant` callback via an ESLint `no-restricted-syntax` rule.
7. **[ADDED] Background work needs a tenant too.** The purge job, the render-TTL sweeper, the usage
   roll-up and the lease sweeper all run with no user session. They do **not** get a bypass: each
   iterates tenants and calls `withTenant(systemScopeFor(orgId), …)`, except the lease sweeper and
   the claim, which run as `ocr_queue` against `extraction_jobs` only. A "system" scope is a
   `TenantScope` whose `actor.type = SYSTEM`; there is no code path that produces a `TenantScope`
   without an `organizationId`.

The scoped-client wrapper (one module, and the raw client never escapes it):

```ts
// src/modules/shared/infrastructure/scoped-prisma.ts
import type { PrismaClient, Prisma } from "@/generated/prisma/client";
import type { TenantScope } from "@/modules/shared/application/tenant-scope";

export type ScopedTx = Prisma.TransactionClient;

export function createScopedRunner(prisma: PrismaClient) {
  return async function withTenant<T>(
    scope: TenantScope,
    fn: (tx: ScopedTx) => Promise<T>,
    opts: { timeoutMs?: number } = {},
  ): Promise<T> {
    return prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_org', ${scope.organizationId}, true)`;
        return fn(tx);
      },
      { timeout: opts.timeoutMs ?? 10_000, maxWait: 5_000 },
    );
  };
}
```

**Rejected — `SET ROLE tenant_<uuid>` per request.** One PostgreSQL role per tenant means catalogue
bloat and a role-provisioning step in the signup path. No benefit over a GUC.

**Rejected — RLS as the *only* control.** It cannot be checked at compile time, it silently returns
zero rows when misconfigured, and it does nothing against an application that sets the wrong
`organizationId`. It complements §3.2/§3.3; it does not replace them.

**The test that makes this real** (integration suite, runs against the disposable database):

```ts
// tests/integration/rls-fail-closed.test.ts
const TENANT_TABLES = [
  "organizations","memberships","documents","document_pages","storage_objects","scan_results",
  "extraction_jobs","job_events","ocr_results","document_analyses","extraction_templates",
  "extraction_fields","extraction_field_values","corrections","audit_logs","api_keys",
  "quotas","usage_counters",
] as const;

it.each(TENANT_TABLES)("%s returns zero rows with no tenant GUC", async (table) => {
  const rows = await appRoleClient.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "${table}"`);
  expect(rows[0].n).toBe(0);                       // fail-closed
});

it.each(TENANT_TABLES)("%s has RLS enabled and forced", async (table) => {
  const [r] = await ownerClient.$queryRaw<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
    SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ${table}`;
  expect(r.relrowsecurity).toBe(true);
  expect(r.relforcerowsecurity).toBe(true);
});
```

The first test is the one that catches a forgotten policy on a table added six months from now. It
is table-driven off a constant list, so adding a tenant table without a policy fails CI.

**[ADDED] Three details the draft's test list glossed over:**

- **`organizations` needs a different predicate.** Its tenant column is `id`, not `organization_id`:
  `CREATE POLICY tenant_isolation ON organizations FOR ALL TO ocr_app USING (id = current_setting('app.current_org', true)::uuid)`.
  A copy-pasted `organization_id = …` policy would fail with `42703 undefined_column` at migration
  time, which is the good outcome — but it must be written correctly once.
- **`users` and `prompt_versions` are deliberately global and carry no policy.** They are therefore
  *absent* from `TENANT_TABLES` and must be asserted absent, otherwise a future reviewer "fixes" the
  list and breaks login. Add:
  `it.each(["users","prompt_versions","outbox_events","idempotency_records"])("%s is intentionally not RLS-protected", …)`
  with a comment naming why each one is exempt.
- **The list must be derived, not typed.** Replace the hand-written `TENANT_TABLES` constant with
  one computed from the DMMF (`models with a field named organizationId`) unioned with
  `{organizations}`, so the two lists cannot diverge. A hand-maintained list is the exact failure
  mode the test exists to prevent.

---

## 4. K-4 — `DocumentStatus`: states, legal transitions, terminality, retry re-entry

### 4.1 The states

```prisma
enum DocumentStatus {
  UPLOADED            // bytes accepted, sha256 computed, nothing inspected yet
  VALIDATING          // MIME sniff, size/page limits, encryption check, malware scan
  QUARANTINED         // malware or an active-content payload was found
  QUEUED              // validated and clean; waiting for a worker
  EXTRACTING_NATIVE   // pulling the PDF's embedded text layer (no OCR yet)
  OCR_PROCESSING      // rasterise + OCR engine
  NORMALIZING         // NFC, Thai digit handling, newmm tokenisation, page assembly
  AI_ANALYZING        // LLM classification / field extraction
  READY_FOR_REVIEW    // a human may accept or correct
  COMPLETED           // accepted
  FAILED              // pipeline gave up; operator may requeue
}
```

`QUARANTINED` is **added** and is not optional. A malicious upload must be distinguishable from a
processing failure: it has different alerting, different retention, and it must never be retried into
the pipeline. Folding it into `FAILED` means an operator's "retry all failed" button re-feeds malware
to the parser.

### 4.2 Legal transitions

| From | To | Trigger | Actor |
|---|---|---|---|
| `UPLOADED` | `VALIDATING` | validate job claimed | system |
| `VALIDATING` | `QUARANTINED` | `ScanResult.verdict ∈ {INFECTED, SUSPICIOUS}` | system |
| `VALIDATING` | `FAILED` | unsupported MIME, encrypted PDF, 0 pages, over the page cap | system |
| `VALIDATING` | `QUEUED` | a `CLEAN` `ScanResult` exists | system |
| `QUEUED` | `EXTRACTING_NATIVE` | PDF with an embedded text layer | system |
| `QUEUED` | `OCR_PROCESSING` | image input, or PDF with no text layer | system |
| `QUEUED` | `FAILED` | enqueue rejected (quota exceeded, no engine satisfies `require`) | system |
| `EXTRACTING_NATIVE` | `NORMALIZING` | `nativeTextCoverage ≥ 0.80` on **every** page (see below) | system |
| `EXTRACTING_NATIVE` | `OCR_PROCESSING` | any page below the threshold → OCR fallback | system |
| `EXTRACTING_NATIVE` | `FAILED` | job `DEAD` | system |
| `OCR_PROCESSING` | `NORMALIZING` | all pages have a canonical `OcrResult` | system |
| `OCR_PROCESSING` | `FAILED` | job `DEAD` (attempts exhausted) | system |
| `NORMALIZING` | `AI_ANALYZING` | analysis requested and the gateway is reachable | system |
| `NORMALIZING` | `READY_FOR_REVIEW` | no analysis requested, **or** the AI gateway is unavailable | system |
| `NORMALIZING` | `FAILED` | job `DEAD` | system |
| `AI_ANALYZING` | `READY_FOR_REVIEW` | analysis succeeded, **or** failed with `aiDegraded = true` | system |
| `AI_ANALYZING` | `FAILED` | job `DEAD` **and** no usable OCR text exists | system |
| `READY_FOR_REVIEW` | `AI_ANALYZING` | re-analyse after corrections | reviewer |
| `READY_FOR_REVIEW` | `COMPLETED` | reviewer accepts | reviewer |
| `COMPLETED` | `READY_FOR_REVIEW` | reopen | org admin |
| `FAILED` | `QUEUED` | operator requeue | operator |

**[ADDED] The native-coverage threshold, as a formula rather than the word "threshold".** The draft
said "native coverage ≥ threshold" and never gave a number, which is not a decision.

```
nativeTextCoverage(page) = extractableGlyphArea(page) / inkArea(page)
  extractableGlyphArea = Σ over the PDF text layer of (glyph advance × font size), clipped to the page box
  inkArea              = area of the page's non-white bounding regions after a 1-bit downsample at 150 DPI

Route to NORMALIZING  iff  min over pages of nativeTextCoverage ≥ 0.80
                     AND  the page's extracted text passes the Thai sanity gate below.
Otherwise route to OCR_PROCESSING for the whole document (not per page — mixing native and OCR
text within one document produces two different coordinate spaces for the overlay).
```

**The Thai sanity gate is not optional, and it is why a raw coverage number alone is wrong.** Thai
PDFs produced by older Thai word processors and by many government e-form generators embed
**subsetted, non-Unicode-mapped fonts**: the text layer extracts as mojibake or as TIS-620 bytes
reinterpreted as Latin-1, at 100 % "coverage". A document can score `nativeTextCoverage = 1.0` and
yield `à¸ à¸²à¸©à¸µ` instead of `ภาษี`. The gate:

```
thaiSanity(page) = true iff
     (a) the extracted string is valid UTF-8 after NFC, AND
     (b) codepointsInRange(U+0E00..U+0E7F) / (letters + Thai letters) ≥ 0.20
         whenever languageHints includes "th" OR the rendered page's script detector says THAI, AND
     (c) the ratio of U+00C0..U+00FF ("Ã ", "à¸", "Â") to total letters < 0.15   -- mojibake signature
```

Failing (b) or (c) forces `OCR_PROCESSING` regardless of coverage. `DocumentPage.thaiScriptRatio`
stores the (b) numerator/denominator ratio so the decision is auditable after the fact, and
`textSource` records which branch won. **0.80 and 0.20 are starting values, not measured ones** —
they are calibrated against the M2 benchmark corpus and recorded in `d-ocr-engine.md`, which owns
the engine-selection policy. This document owns only the columns that make the decision replayable.

**Terminality:**
- `QUARANTINED` — **absolutely terminal.** Zero outgoing edges. The only exit is deletion by the
  purge job. There is deliberately no "un-quarantine": if a verdict was a false positive, the correct
  action is to delete the document and re-upload after the scanner signature is updated, which
  produces a fresh `ScanResult` and a clean audit trail.
- `COMPLETED` — **stable, reopenable.** One outgoing edge, requiring an org admin.
- `FAILED` — **recoverable-terminal.** One outgoing edge: `→ QUEUED`.

**Where retry re-enters — two distinct levels, and conflating them is the classic bug:**

- **Level 1, automatic (in-job).** `ExtractionJob.attempts` increments, `nextAttemptAt` is pushed out
  by bounded exponential backoff (reuse jawbong's `calculateBackoffMs(attempt, 1_000, 300_000)`
  verbatim, from `src/modules/outbox/domain/outbox-event.ts`), status returns `RUNNING → PENDING`.
  **The document status does not change.** A document sitting in `OCR_PROCESSING` while its job
  retries is correct and must not flicker.
- **Level 2, operator (document-level).** `FAILED → QUEUED` only. It never re-enters at
  `OCR_PROCESSING` or `AI_ANALYZING`. Reasons: (a) the cause may have been in validation or
  rasterisation, so resuming mid-pipeline can reproduce the failure forever; (b) `QUEUED` is the
  single re-entry point, which keeps the reachability graph small enough to test exhaustively;
  (c) a requeue creates a **new** `ExtractionJob` row — the failed one is retained with its
  `lastError` for inspection, matching jawbong's "terminal `FAILED` rows retained" idiom.
  **[REVISED] That new row would have collided.** The draft made `dedupeKey` unique and said
  requeue inserts a new job. If `dedupeKey` is derived from `(documentId, kind, pageRange)` — which
  is the only derivation that makes it a *dedupe* key at all — the second insert violates the unique
  constraint and the requeue silently fails. Fixed by putting a **requeue generation** in the key:
  `dedupeKey = "{documentId}:{kind}:{pageFrom}-{pageTo}:g{requeueGeneration}"`, where
  `requeueGeneration` is `Document.requeueCount`, a new `Int @default(0)` column incremented in the
  same transaction as `FAILED → QUEUED`. Enqueue is then idempotent *within* a generation (a
  double-clicked "retry" button creates one job, not two) and unblocked *across* generations.
  See §5.4 and §5.5.
- **A stuck job is not a failed document.** If a worker dies mid-page, the lease sweeper returns the
  *job* to `PENDING`; the document stays in `OCR_PROCESSING`. Only `DEAD` (attempts exhausted) moves
  the document to `FAILED`. That is why there is no `OCR_PROCESSING → QUEUED` edge.

### 4.3 Enforced in the schema, not in prose

```sql
CREATE OR REPLACE FUNCTION assert_document_status_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  legal text[] := ARRAY[
    'UPLOADED>VALIDATING',
    'VALIDATING>QUEUED','VALIDATING>QUARANTINED','VALIDATING>FAILED',
    'QUEUED>EXTRACTING_NATIVE','QUEUED>OCR_PROCESSING','QUEUED>FAILED',
    'EXTRACTING_NATIVE>NORMALIZING','EXTRACTING_NATIVE>OCR_PROCESSING','EXTRACTING_NATIVE>FAILED',
    'OCR_PROCESSING>NORMALIZING','OCR_PROCESSING>FAILED',
    'NORMALIZING>AI_ANALYZING','NORMALIZING>READY_FOR_REVIEW','NORMALIZING>FAILED',
    'AI_ANALYZING>READY_FOR_REVIEW','AI_ANALYZING>FAILED',
    'READY_FOR_REVIEW>AI_ANALYZING','READY_FOR_REVIEW>COMPLETED',
    'COMPLETED>READY_FOR_REVIEW',
    'FAILED>QUEUED'
  ];
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF NOT ((OLD.status::text || '>' || NEW.status::text) = ANY (legal)) THEN
    RAISE EXCEPTION 'ILLEGAL_DOCUMENT_TRANSITION: % -> % (document %)',
      OLD.status, NEW.status, OLD.id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER document_00_status_transition_guard   -- [REVISED] numeric prefix: see note 1 below
  BEFORE UPDATE OF status ON documents
  FOR EACH ROW EXECUTE FUNCTION assert_document_status_transition();
```

A trigger rather than a lookup table because triggers are **invisible to Prisma's migration diff
engine** (§10.2), so this adds no drift. A `document_status_transitions` table would appear in the
diff and have to be modelled in `schema.prisma` for no benefit.

The same array is mirrored in the domain layer (`src/modules/documents/domain/document-status.ts`) as
a `const` transition map, and a unit test asserts the two lists are identical — so the SQL and the
TypeScript cannot drift apart silently. Enforce twice, define once.

**[ADDED] Three mechanics the draft left implicit, each of which is a real trap:**

1. **Trigger firing order is alphabetical, and there are two `BEFORE UPDATE OF status` triggers on
   `documents`.** PostgreSQL fires row-level triggers of the same type in **name order**, so
   `document_scan_gate` runs before `document_status_transition_guard`. That is the wrong order:
   an illegal transition into `QUEUED` would be rejected by the scan gate with
   `UNSCANNED_DOCUMENT_CANNOT_BE_QUEUED` rather than by the transition guard with
   `ILLEGAL_DOCUMENT_TRANSITION`, producing a misleading error. Rename them so the transition guard
   sorts first: `document_00_status_transition_guard`, `document_10_scan_gate`. Numeric prefixes on
   trigger names are the standard way to make this deterministic and they cost nothing.
2. **`BEFORE UPDATE OF status` fires whenever `status` appears in the `SET` list**, even if the value
   is unchanged — which is exactly what Prisma does when you pass `status` in an `update()` payload.
   The `IF NEW.status = OLD.status THEN RETURN NEW` early-return handles it. Keep that line; it is
   not dead code.
3. **The trigger cannot see who is asking.** It enforces the *shape* of the graph, not authority.
   `COMPLETED → READY_FOR_REVIEW` is marked "org admin" and `FAILED → QUEUED` "operator" in §4.2, and
   nothing in SQL checks that. Authority is enforced in the application layer by the
   `AuthorizationPort` before the write, and the attempt is audited with
   `outcome = DENIED`. Stated here because "enforced in the schema, not in prose" is true of the
   transition set and **false of the actor column** — conflating the two is how teams end up believing
   the database is doing authorization.

---

## 5. The schema

Conventions, all copied from `/Users/innovera/Documents/jawbong/prisma/schema.prisma`: camelCase
fields with `@map("snake_case")`; `@@map` to a snake_case plural table; `@db.Uuid` ids with **no**
`@default`; `@db.Timestamptz(3)` for every instant; `@db.VarChar(n)` with an explicit bound on every
string that is not free text; `@db.JsonB` for JSON; index names supplied via `map:` as
`{table_singular}_{cols}_idx` / `_key`.

### 5.1 Generator, datasource, and the inherited foundation

```prisma
generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
}

datasource db {
  provider = "postgresql"
}

// ─────────────────────────────────────────────────────────────────────────────
// Copied verbatim from jawbong per decision A-6 (a-environment-and-stack.md §5.5).
// Not reproduced here — see /Users/innovera/Documents/jawbong/prisma/schema.prisma
//   enum OutboxStatus { PENDING PROCESSING PROCESSED FAILED }
//   model OutboxEvent        @@map("outbox_events")
//   model IdempotencyRecord  @@map("idempotency_records")
// including the CHECK "outbox_attempts_nonnegative" and all four indexes.
// These are NOT the OCR job queue. ExtractionJob (§5.5) is.
// ─────────────────────────────────────────────────────────────────────────────
```

### 5.2 Enums

```prisma
enum OrgRole              { OWNER ADMIN MEMBER REVIEWER VIEWER }
enum OrgStatus            { ACTIVE SUSPENDED CLOSED }
enum UserStatus           { ACTIVE DISABLED }

enum DocumentStatus       { UPLOADED VALIDATING QUARANTINED QUEUED EXTRACTING_NATIVE
                            OCR_PROCESSING NORMALIZING AI_ANALYZING READY_FOR_REVIEW
                            COMPLETED FAILED }
enum DocumentSource       { WEB_UPLOAD API_UPLOAD }
enum TextSourceKind       { NATIVE_PDF OCR NONE }
enum ScriptKind           { THAI LATIN MIXED UNKNOWN }

enum StorageObjectKind    { ORIGINAL PAGE_RENDER PAGE_THUMBNAIL ENGINE_PAYLOAD EXPORT }
enum ScanVerdict          { CLEAN INFECTED SUSPICIOUS ERROR SKIPPED }

enum JobKind              { VALIDATE NATIVE_EXTRACT OCR NORMALIZE ANALYZE }
enum JobStatus            { PENDING RUNNING SUCCEEDED FAILED CANCELLED DEAD }
enum JobEventKind         { ENQUEUED CLAIMED HEARTBEAT PROGRESS SUCCEEDED FAILED
                            RETRY_SCHEDULED LEASE_EXPIRED CANCELLED DEAD_LETTERED }

enum OcrEngineId          { PADDLE_ONNX_TH TESSERACT_THA EASYOCR_TH TYPHOON_VLM GATEWAY_VLM }
// [REVISED] `QWEN_VL_GATEWAY` renamed to `GATEWAY_VLM`. The draft's name asserted a model family
// for the INNOVERA private gateway. That is NOT KNOWN — b-ai-topology-discovery.md items C/D/E
// (endpoint, model list, vision capability) are UNRESOLVED and blocked on the owner. Baking "Qwen"
// into a PostgreSQL enum would have turned an unverified guess into a schema fact that survives
// into migration SQL, worker code and the ops dashboard. `GATEWAY_VLM` names the ROLE (the private
// gateway acting as a vision OCR provider) and stays true whatever model is behind it; the actual
// served model string is recorded per run in `OcrResult.engineVersion` and
// `DocumentAnalysis.modelServedName`, which is where a runtime fact belongs.
// If item E resolves to "the gateway is text-only", `GATEWAY_VLM` is simply never written — no
// migration needed. PostgreSQL supports `ALTER TYPE ... RENAME VALUE` (10+) if a later, VERIFIED
// name is wanted, but Prisma does not model that, so it is a hand-written migration.
enum ConfidenceGrain      { PER_WORD PER_LINE PER_PAGE NONE }

enum AnalysisKind         { CLASSIFY EXTRACT_FIELDS SUMMARIZE TABLE_EXTRACT }
enum AnalysisInputKind    { TEXT IMAGE TEXT_AND_IMAGE }
enum AnalysisOutcome      { SUCCEEDED SCHEMA_REJECTED REFUSED TIMEOUT ERROR }

enum FieldDataType        { STRING NUMBER INTEGER MONEY DATE DATETIME BOOLEAN ENUM
                            THAI_NATIONAL_ID TAX_ID PHONE EMAIL }
enum FieldValueOrigin     { AI OCR_ANCHOR NATIVE_TEXT HUMAN DEFAULT }
enum CorrectionTargetKind { FIELD_VALUE OCR_LINE }
enum CorrectionAction     { SET_VALUE CLEAR_VALUE CONFIRM REJECT FLAG }

enum ActorType            { USER API_KEY SYSTEM WORKER }
enum AuditOutcome         { SUCCESS DENIED ERROR }
enum UsageMetric          { DOCUMENTS_CREATED PAGES_OCR PAGES_AI AI_INPUT_TOKENS
                            AI_OUTPUT_TOKENS STORAGE_BYTES API_REQUESTS }
enum QuotaPeriod          { DAY MONTH TOTAL }
```

`OcrEngineId` mirrors `d-ocr-engine.md` §9.2's `OcrEngineId` union in SCREAMING_SNAKE, with the
gateway member renamed as above. An engine that is not in this enum cannot write a result —
deliberate. **[ADDED] `d-ocr-engine.md` must be updated to match**, or the two documents drift; the
rename is the kind of change that is trivial now and a migration later.

**[ADDED] Two enum members the draft omitted and that will be needed inside M1:**

```prisma
enum ScriptKind  { THAI LATIN MIXED UNKNOWN }        // unchanged, listed for context
enum ThaiDigitPolicy { PRESERVE FOLD_TO_ASCII BOTH } // see §9.6 — how ๐-๙ were handled at ingest
enum DateEra     { CE BE UNKNOWN }                   // see §9.7 — Buddhist Era on Thai documents
```

Both are consumed by `ExtractionFieldValue` (§5.7). They are enums rather than booleans because
"we folded Thai digits" and "we kept both forms" are genuinely different states with different
search behaviour, and a boolean would need a second boolean within a month.

### 5.3 Tenancy and identity

```prisma
model Organization {
  id            String     @id @db.Uuid
  slug          String     @unique(map: "organization_slug_key") @db.VarChar(80)
  name          String     @db.VarChar(200)
  status        OrgStatus  @default(ACTIVE)
  dataRegion    String     @default("ap-southeast-1") @map("data_region") @db.VarChar(24)
  retentionDays Int        @default(365) @map("retention_days")
  createdAt     DateTime   @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt     DateTime   @updatedAt @map("updated_at") @db.Timestamptz(3)
  deletedAt     DateTime?  @map("deleted_at") @db.Timestamptz(3)

  memberships Membership[]
  documents   Document[]
  // ... all tenant-scoped children

  @@index([status, createdAt], map: "organization_status_created_idx")
  // Query: platform-admin console list — WHERE status='ACTIVE' ORDER BY created_at DESC.
  @@map("organizations")
}

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

  memberships Membership[]

  @@map("users")
}
// NOTE: `users` is GLOBAL, not tenant-scoped, and carries NO RLS policy — a user may belong to
// several organizations. It is reachable only through a Membership the caller shares; there is no
// endpoint that lists users outside an organization.
// No password/credential column: the auth provider is deferred, exactly as jawbong defers it
// behind ActorContext (src/lib/auth/actor-context.ts).
//
// [REVISED] The draft said "PostgreSQL has no citext in core". That is technically true and
// practically misleading: `citext` is a standard contrib extension shipped with PostgreSQL and
// enabled on every mainstream managed provider, so "not in core" is not a reason to reject it.
// The real reasons to reject citext are better ones, and they are:
//   (a) citext's case-folding is locale-naive and is documented as not being a full Unicode
//       case-insensitive comparison;
//   (b) it makes the column type non-portable and invisible to Prisma (it would need Unsupported());
//   (c) email case-insensitivity is only correct for the DOMAIN part — RFC 5321 makes the local
//       part case-SENSITIVE — so "lowercase the whole address" is itself a simplification we are
//       choosing deliberately, and a database type cannot express that nuance.
// Decision unchanged (application lower-casing + a CHECK), reasoning corrected.
// The modern alternative if this is ever revisited is a non-deterministic ICU collation
// (PostgreSQL 12+):  CREATE COLLATION email_ci (provider = icu, locale = 'und-u-ks-level2',
//                                               deterministic = false);
// which is exact, Unicode-correct, and indexable — but also invisible to Prisma. Revisit only if a
// case-collision incident actually occurs.

model Membership {
  id              String    @id @db.Uuid
  organizationId  String    @map("organization_id") @db.Uuid
  userId          String    @map("user_id") @db.Uuid
  role            OrgRole
  invitedByUserId String?   @map("invited_by_user_id") @db.Uuid
  joinedAt        DateTime  @default(now()) @map("joined_at") @db.Timestamptz(3)
  revokedAt       DateTime? @map("revoked_at") @db.Timestamptz(3)
  createdAt       DateTime  @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt       DateTime  @updatedAt @map("updated_at") @db.Timestamptz(3)

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Restrict)
  user         User         @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([organizationId, userId], map: "membership_org_user_key")
  // Query: authorization — "is this user a member of this org, and with what role?" One probe per
  // request. Also prevents duplicate memberships.
  @@index([userId, revokedAt], map: "membership_user_revoked_idx")
  // Query: post-login org picker — WHERE user_id=$1 AND revoked_at IS NULL.
  @@map("memberships")
}

model ApiKey {
  id                 String    @id @db.Uuid
  organizationId     String    @map("organization_id") @db.Uuid
  name               String    @db.VarChar(120)
  keyPrefix          String    @unique(map: "api_key_prefix_key") @map("key_prefix") @db.VarChar(16)
  keyHash            String    @map("key_hash") @db.VarChar(64)   // sha256 hex of the secret half
  scopes             String[]  @db.VarChar(60)
  rateLimitPerMinute Int       @default(60) @map("rate_limit_per_minute")
  expiresAt          DateTime? @map("expires_at") @db.Timestamptz(3)
  lastUsedAt         DateTime? @map("last_used_at") @db.Timestamptz(3)
  revokedAt          DateTime? @map("revoked_at") @db.Timestamptz(3)
  createdByUserId    String?   @map("created_by_user_id") @db.Uuid
  createdAt          DateTime  @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt          DateTime  @updatedAt @map("updated_at") @db.Timestamptz(3)

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Restrict)

  @@index([organizationId, revokedAt], map: "api_key_org_revoked_idx")
  // Query: key-management screen — WHERE organization_id=$1 AND revoked_at IS NULL.
  @@map("api_keys")
}
```

**[ADDED] The `CHECK` constraints promised in prose, written out.** The draft named seven `CHECK`s
across §5 and §10.1 and wrote exactly one of them (`correction_one_target`). The brief asked for
schema, not prose, so here they all are. They go in migration 0008 (§10.2) and are invisible to
`prisma migrate diff`, exactly like the triggers.

```sql
-- Identity / tenancy
ALTER TABLE users             ADD CONSTRAINT user_email_lowercased  CHECK (email = lower(email));
ALTER TABLE organizations     ADD CONSTRAINT organization_slug_shape CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$');
ALTER TABLE organizations     ADD CONSTRAINT organization_retention  CHECK (retention_days BETWEEN 1 AND 3650);

-- Upload limits. 209715200 = 200 MiB.  See §5.4 for why this number and the page cap agree.
ALTER TABLE storage_objects   ADD CONSTRAINT storage_object_size_bounds CHECK (size_bytes BETWEEN 0 AND 209715200);
ALTER TABLE documents         ADD CONSTRAINT document_size_bounds       CHECK (size_bytes BETWEEN 1 AND 209715200);
ALTER TABLE documents         ADD CONSTRAINT document_page_count_bounds CHECK (page_count IS NULL OR page_count BETWEEN 1 AND 2000);
ALTER TABLE document_pages    ADD CONSTRAINT document_page_number_positive CHECK (page_number >= 1);
ALTER TABLE document_pages    ADD CONSTRAINT document_page_dims_positive   CHECK (width_px > 0 AND height_px > 0 AND render_dpi BETWEEN 72 AND 1200);
ALTER TABLE document_pages    ADD CONSTRAINT document_page_rotation        CHECK (rotation_applied IN (0, 90, 180, 270));

-- Ratios that are ratios.
ALTER TABLE document_pages    ADD CONSTRAINT document_page_coverage_ratio CHECK (native_text_coverage IS NULL OR native_text_coverage BETWEEN 0 AND 1);
ALTER TABLE document_pages    ADD CONSTRAINT document_page_thai_ratio     CHECK (thai_script_ratio  IS NULL OR thai_script_ratio  BETWEEN 0 AND 1);
ALTER TABLE document_pages    ADD CONSTRAINT document_page_confidence     CHECK (mean_confidence    IS NULL OR mean_confidence    BETWEEN 0 AND 1);
ALTER TABLE ocr_results       ADD CONSTRAINT ocr_result_confidence        CHECK (mean_confidence    IS NULL OR mean_confidence    BETWEEN 0 AND 1);
ALTER TABLE extraction_field_values ADD CONSTRAINT field_value_confidence CHECK (confidence         IS NULL OR confidence         BETWEEN 0 AND 1);

-- JSONB size caps. pg_column_size() measures the COMPRESSED, TOASTed size, which is what we
-- actually care about; a cap on the uncompressed length would be both larger and less meaningful.
ALTER TABLE audit_logs        ADD CONSTRAINT audit_metadata_size    CHECK (metadata        IS NULL OR pg_column_size(metadata)        <= 4096);
ALTER TABLE documents         ADD CONSTRAINT document_source_meta_size CHECK (source_metadata IS NULL OR pg_column_size(source_metadata) <= 8192);
ALTER TABLE ocr_results       ADD CONSTRAINT ocr_lines_json_size    CHECK (pg_column_size(lines_json) <= 4194304);   -- 4 MiB hard ceiling
ALTER TABLE extraction_jobs   ADD CONSTRAINT job_requirements_size  CHECK (requirements IS NULL OR pg_column_size(requirements) <= 8192);
ALTER TABLE extraction_field_values ADD CONSTRAINT field_value_json_size CHECK (value_json IS NULL OR pg_column_size(value_json) <= 262144);

-- Money is only money with a currency, and only in minor units.
ALTER TABLE extraction_field_values ADD CONSTRAINT field_value_money_pairing
  CHECK ((value_minor IS NULL AND currency IS NULL) OR (value_minor IS NOT NULL AND currency ~ '^[A-Z]{3}$'));

-- Attempts are non-negative and bounded, matching jawbong's outbox_attempts_nonnegative idiom.
ALTER TABLE extraction_jobs   ADD CONSTRAINT job_attempts_nonnegative CHECK (attempts >= 0 AND max_attempts BETWEEN 1 AND 20);
ALTER TABLE extraction_jobs   ADD CONSTRAINT job_page_range           CHECK ((page_from IS NULL) = (page_to IS NULL) AND (page_from IS NULL OR page_from <= page_to));

-- API keys: the stored hash is a 64-char lowercase hex sha256, nothing else.
ALTER TABLE api_keys          ADD CONSTRAINT api_key_hash_shape CHECK (key_hash ~ '^[0-9a-f]{64}$');
ALTER TABLE storage_objects   ADD CONSTRAINT storage_sha_shape  CHECK (content_sha256 ~ '^[0-9a-f]{64}$' AND content_fingerprint ~ '^[0-9a-f]{64}$');
ALTER TABLE documents         ADD CONSTRAINT document_sha_shape CHECK (content_sha256 ~ '^[0-9a-f]{64}$');

-- Public ids are exactly the 32-char Crockford base32 alphabet from §2 (no I, L, O, U).
ALTER TABLE documents         ADD CONSTRAINT document_public_id_shape CHECK (public_id ~ '^[0-9A-HJKMNP-TV-Z]{32}$');
```

**[ADDED] The 200 MiB size cap and the 2 000-page cap must agree, and in the draft they did not.**
§12.1 risk 3 proposed a 2 000-page ceiling; §5.8 proposed a 200 MiB upload ceiling. At the draft's
own §6.1 figure of ~275 KB per scanned page, 2 000 pages is **~550 MB** — a document that satisfies
the page cap and violates the size cap, so the page cap would never bind and the operator-facing
error would always be the unhelpful "file too large". Resolved by making the size cap the binding
one and deriving the page cap from it:

| Limit | Value | Enforced where | Rationale |
|---|---|---|---|
| Upload size | **200 MiB** | `document_size_bounds` CHECK + the HTTP body limit | ~730 scanned pages at 275 KB/page, ~2 000 born-digital pages at ~100 KB/page |
| Page count | **2 000** | `document_page_count_bounds` CHECK, checked during `VALIDATING` | bounds the per-page row fan-out and the 5 000-page pathology in risk 3 |
| Per-page render | 20 MiB | application, before writing a `StorageObject` | a single hostile 30 000×30 000 page |

A file that is under 200 MiB but over 2 000 pages (a born-digital text PDF) fails `VALIDATING` with
`failureCode = 'PAGE_LIMIT_EXCEEDED'`; a file over 200 MiB is rejected at the HTTP layer before a
`Document` row exists at all, so it never reaches a status. Both are now reachable states rather
than one shadowing the other.

**`ApiKey` mechanics, spelled out because it is a security surface.** The presented key is
`iocr_<prefix:8>_<secret:32>` in base62. `keyPrefix` = `"iocr_" + prefix` (13 chars) and is
unique-indexed, so authentication is **one index probe**, not a table scan. `keyHash` =
`sha256(secret)` hex, compared with `crypto.timingSafeEqual`. A fast hash is correct here — unlike a
password, the secret carries ≈ 190 bits of entropy, so there is nothing to brute-force and Argon2
would only add latency to every API request while making O(1) lookup impossible.
`lastUsedAt` is updated at most once per 60 s
(`UPDATE api_keys SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '60 seconds')`)
so a hot key does not generate one write per request.

### 5.4 Storage, scanning, documents, pages

```prisma
model StorageObject {
  id                 String            @id @db.Uuid
  organizationId     String            @map("organization_id") @db.Uuid
  kind               StorageObjectKind
  bucket             String            @db.VarChar(63)
  objectKey          String            @map("object_key") @db.VarChar(1024)
  contentType        String            @map("content_type") @db.VarChar(255)
  sizeBytes          Int               @map("size_bytes")
  contentSha256      String            @map("content_sha256") @db.VarChar(64)
  contentFingerprint String            @map("content_fingerprint") @db.VarChar(64)
  etag               String?           @db.VarChar(128)
  sseKeyId           String?           @map("sse_key_id") @db.VarChar(200)
  expiresAt          DateTime?         @map("expires_at") @db.Timestamptz(3)
  createdAt          DateTime          @default(now()) @map("created_at") @db.Timestamptz(3)
  deletedAt          DateTime?         @map("deleted_at") @db.Timestamptz(3)

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Restrict)
  scanResults  ScanResult[]
  documents    Document[]   @relation("DocumentOriginal")

  @@unique([bucket, objectKey], map: "storage_object_bucket_key_key")
  // Query: reverse lookup from a storage event/webhook. Also prevents two rows owning one blob.
  @@unique([organizationId, contentFingerprint, kind], map: "storage_object_org_fingerprint_key")
  // Query: THE dedup probe — WHERE organization_id=$1 AND content_fingerprint=$2 AND kind='ORIGINAL'.
  // Tenant-scoped by construction; see §7.
  @@unique([id, organizationId], map: "storage_object_id_org_key")   // composite-FK anchor
  @@index([expiresAt], map: "storage_object_expires_idx")
  // Query: render TTL sweeper — WHERE expires_at < now() AND deleted_at IS NULL LIMIT 1000.
  @@map("storage_objects")
}

model ScanResult {
  id               String        @id @db.Uuid
  organizationId   String        @map("organization_id") @db.Uuid
  storageObjectId  String        @map("storage_object_id") @db.Uuid
  scanner          String        @db.VarChar(40)     // 'clamav'
  scannerVersion   String        @map("scanner_version") @db.VarChar(40)
  signatureVersion String        @map("signature_version") @db.VarChar(40)
  verdict          ScanVerdict
  threatName       String?       @map("threat_name") @db.VarChar(200)
  durationMs       Int           @map("duration_ms")
  scannedAt        DateTime      @default(now()) @map("scanned_at") @db.Timestamptz(3)

  storageObject StorageObject @relation(fields: [storageObjectId, organizationId],
                                        references: [id, organizationId], onDelete: Cascade)

  @@unique([storageObjectId, scanner, signatureVersion], map: "scan_result_object_scanner_key")
  // Query: "has this blob been scanned by clamav at this signature level?" Allows a re-scan when
  // signatures update without duplicating a verdict at the same signature version.
  @@index([organizationId, verdict, scannedAt], map: "scan_result_org_verdict_idx")
  // Query: security dashboard — WHERE organization_id=$1 AND verdict='INFECTED' ORDER BY scanned_at DESC.
  @@map("scan_results")
}

model Document {
  id                      String         @id @db.Uuid
  publicId                String         @unique(map: "document_public_id_key") @map("public_id") @db.VarChar(32)
  organizationId          String         @map("organization_id") @db.Uuid
  ownerUserId             String?        @map("owner_user_id") @db.Uuid
  createdByApiKeyId       String?        @map("created_by_api_key_id") @db.Uuid
  source                  DocumentSource
  status                  DocumentStatus @default(UPLOADED)
  originalStorageObjectId String         @map("original_storage_object_id") @db.Uuid
  originalFilename        String         @map("original_filename") @db.VarChar(400)
  mimeType                String         @map("mime_type") @db.VarChar(160)
  sizeBytes               Int            @map("size_bytes")
  contentSha256           String         @map("content_sha256") @db.VarChar(64)
  pageCount               Int?           @map("page_count")
  templateId              String?        @map("template_id") @db.Uuid
  languageHints           String[]       @map("language_hints") @db.VarChar(12)
  aiDegraded              Boolean        @default(false) @map("ai_degraded")
  failureCode             String?        @map("failure_code") @db.VarChar(60)
  failureDetail           String?        @map("failure_detail") @db.VarChar(1000)
  sourceMetadata          Json?          @map("source_metadata") @db.JsonB
  duplicateOfDocumentId   String?        @map("duplicate_of_document_id") @db.Uuid
  requeueCount            Int            @default(0) @map("requeue_count")   // [ADDED] see §4.2
  originalFilenameNfc     String         @map("original_filename_nfc") @db.VarChar(400)  // [ADDED] §9.8
  queuedAt                DateTime?      @map("queued_at") @db.Timestamptz(3)
  completedAt             DateTime?      @map("completed_at") @db.Timestamptz(3)
  createdAt               DateTime       @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt               DateTime       @updatedAt @map("updated_at") @db.Timestamptz(3)
  deletedAt               DateTime?      @map("deleted_at") @db.Timestamptz(3)

  organization    Organization        @relation(fields: [organizationId], references: [id], onDelete: Restrict)
  // [REVISED] Both of these were single-column FKs in the draft, violating invariant TEN-1 (§3.3)
  // on the two most security-relevant pointers in the schema: the blob and the template. A
  // single-column FK here means a Document row can legally reference ANOTHER TENANT'S blob, which
  // is a direct cross-tenant read once the download handler resolves the pointer.
  originalStorage StorageObject       @relation("DocumentOriginal",
                                                fields: [originalStorageObjectId, organizationId],
                                                references: [id, organizationId],
                                                onDelete: Restrict, onUpdate: NoAction)
  template        ExtractionTemplate? @relation(fields: [templateId, organizationId],
                                                references: [id, organizationId],
                                                onDelete: Restrict, onUpdate: NoAction)
  pages           DocumentPage[]
  jobs            ExtractionJob[]
  analyses        DocumentAnalysis[]
  fieldValues     ExtractionFieldValue[]
  corrections     Correction[]

  @@unique([id, organizationId], map: "document_id_org_key")     // composite-FK anchor
  @@index([organizationId, status, createdAt(sort: Desc)], map: "document_org_status_created_idx")
  // Query: the inbox, filtered — WHERE organization_id=$1 AND status=$2 AND deleted_at IS NULL
  //        ORDER BY created_at DESC LIMIT 50. The single hottest list query in the product.
  @@index([organizationId, createdAt(sort: Desc)], map: "document_org_created_idx")
  // Query: the inbox, unfiltered. The 3-column index above cannot serve a query with no status
  //        predicate without a full index scan, so this one earns its keep.
  @@index([organizationId, ownerUserId, createdAt(sort: Desc)], map: "document_org_owner_created_idx")
  // Query: "my documents" — WHERE organization_id=$1 AND owner_user_id=$2 ORDER BY created_at DESC.
  @@index([organizationId, contentSha256], map: "document_org_sha_idx")
  // Query: same-tenant duplicate detection at upload — WHERE organization_id=$1
  //        AND content_sha256=$2 AND deleted_at IS NULL. NOT unique: see §7.
  @@index([organizationId, templateId, status], map: "document_org_template_status_idx")
  // Query: "all invoices awaiting review" — the template-scoped review worklist.
  @@index([deletedAt], map: "document_deleted_at_idx")
  // Query: hard-delete purge job — WHERE deleted_at < now() - interval '30 days' LIMIT 500.
  // [REVISED] This index is ~99.9% NULL entries. See the partial-index note below: in the actual
  // migration it is created as  WHERE deleted_at IS NOT NULL,  which is ~1000x smaller.
  @@map("documents")
}

model DocumentPage {
  id                  String         @id @db.Uuid
  organizationId      String         @map("organization_id") @db.Uuid
  documentId          String         @map("document_id") @db.Uuid
  pageNumber          Int            @map("page_number")
  widthPx             Int            @map("width_px")
  heightPx            Int            @map("height_px")
  renderDpi           Int            @map("render_dpi")
  rotationApplied     Int            @default(0) @map("rotation_applied")
  textSource          TextSourceKind @default(NONE) @map("text_source")
  nativeTextCoverage  Float?         @map("native_text_coverage")
  hasEmbeddedImages   Boolean        @default(false) @map("has_embedded_images")
  script              ScriptKind     @default(UNKNOWN)
  thaiScriptRatio     Float?         @map("thai_script_ratio")
  charCount           Int            @default(0) @map("char_count")
  lineCount           Int            @default(0) @map("line_count")
  meanConfidence      Float?         @map("mean_confidence")
  plainText           String?        @map("plain_text")      // canonical Thai-NFC text — see §6, §9.8
  plainTextRaw        String?        @map("plain_text_raw")  // [ADDED] pre-normalisation, see §9.8
  searchTokens        String?        @map("search_tokens")   // newmm maxmatch tokens — see §9.3
  searchTokensSubword String?        @map("search_tokens_subword") // [ADDED] sub-word — see §9.3
  tokenizer           String?        @db.VarChar(60)         // [ADDED] e.g. "pythainlp-5.1.2/newmm"
  digitPolicy         ThaiDigitPolicy @default(PRESERVE) @map("digit_policy") // [ADDED] §9.6
  normalizerVersion   String?        @map("normalizer_version") @db.VarChar(40) // [ADDED] §9.8
  canonicalOcrResultId String?       @map("canonical_ocr_result_id") @db.Uuid
  renderStorageObjectId String?      @map("render_storage_object_id") @db.Uuid
  createdAt           DateTime       @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt           DateTime       @updatedAt @map("updated_at") @db.Timestamptz(3)

  document          Document   @relation(fields: [documentId, organizationId],
                                         references: [id, organizationId], onDelete: Cascade)
  ocrResults        OcrResult[] @relation("PageResults")
  canonicalOcrResult OcrResult? @relation("PageCanonical",
                                          fields: [canonicalOcrResultId], references: [id],
                                          onDelete: SetNull)

  @@unique([documentId, pageNumber], map: "document_page_doc_number_key")
  // Query: the viewer's page fetch — WHERE document_id=$1 AND page_number=$2. Also guarantees no
  // duplicate page rows when an OCR job is retried.
  @@unique([id, organizationId], map: "document_page_id_org_key")   // composite-FK anchor
  @@map("document_pages")
}
```

**`DocumentPage.plainText` vs `OcrResult.normalizedText` — the distinction that makes K-8 work.**
`OcrResult` rows are **immutable evidence**: one row per (page, engine, engineVersion, renderDpi)
run, never updated. `DocumentPage.plainText`/`searchTokens` are the **current canonical projection**
— the text the product shows and searches, chosen from among the available `OcrResult`s (or taken
from the native PDF layer). When a better engine runs, the projection is repointed
(`canonicalOcrResultId`) and rewritten; the old evidence is untouched. Corrections write to
`ExtractionFieldValue`, never to either.

*UNVERIFIED:* the `PageCanonical` relation creates a two-way reference between `document_pages` and
`ocr_results`. `DELETE FROM documents` cascades to pages, which cascades to results, while the page
also holds an `ON DELETE SET NULL` reference into those results. PostgreSQL orders referential
actions to make this work, but confirm with a 5-line integration test in M1
(`create doc → 2 pages → 3 results → delete doc → expect 0 rows everywhere, no FK error`). If it
errors, drop the FK and keep `canonicalOcrResultId` as a soft pointer maintained in the same
transaction. **[ADDED] This test now has a second job**: it is also the test that catches the
append-only-trigger deadlock described in §8.1 — see `erasure_cascade.test.ts` there. Run it as one
test, not two.

**[ADDED] `canonicalOcrResult` is also composite now** (invariant TEN-1):

```prisma
  canonicalOcrResult OcrResult? @relation("PageCanonical",
                                          fields: [canonicalOcrResultId, organizationId],
                                          references: [id, organizationId],
                                          onDelete: SetNull, onUpdate: NoAction)
```

*A note on nullable composite FKs, because it looks wrong and is not.* `canonicalOcrResultId` is
nullable while `organizationId` is not. PostgreSQL foreign keys default to **`MATCH SIMPLE`**, under
which a row whose FK columns are *not all* non-NULL is not checked at all. So a page with no chosen
canonical result (`canonicalOcrResultId = NULL`, `organizationId` set) passes without a referenced
row, which is exactly the intent. The same applies to `Document.template`. Do **not** write
`MATCH FULL` on these — it would reject every un-templated document. Prisma emits `MATCH SIMPLE`
(it emits no `MATCH` clause), so this is the default behaviour and needs no override; it is recorded
here because a reviewer will otherwise ask.

**[ADDED] `onDelete: SetNull` on a composite FK sets *both* columns to NULL** — including
`organization_id`, which is `NOT NULL`. That is a `23502 not_null_violation` at delete time, not a
silent bug, but it means the cascade in the test above **will fail** unless the OCR-result delete
path nulls the pointer first. Two ways out; take the second:
- make `organizationId` nullable on `document_pages` — unacceptable, it is the tenancy column;
- **use `onDelete: NoAction` and null the pointer explicitly** in the erasure transaction
  (`UPDATE document_pages SET canonical_ocr_result_id = NULL WHERE document_id = $1` before deleting
  results). The pointer is a *projection cache*, not a fact; maintaining it in application code is
  honest. `onDelete: SetNull` is therefore **withdrawn** and the relation is `onDelete: NoAction`.
  This is the single most likely place for the M1 integration test to fail, and it is now designed
  for rather than discovered.

### 5.5 The job queue

Per decision A-6, this is a dedicated table on the krs-pos claim shape — **not** `outbox_events`.

```prisma
model ExtractionJob {
  id             String     @id @db.Uuid
  organizationId String     @map("organization_id") @db.Uuid
  documentId     String     @map("document_id") @db.Uuid
  kind           JobKind
  status         JobStatus  @default(PENDING)
  priority       Int        @default(100)
  dedupeKey      String     @map("dedupe_key") @db.VarChar(200)
  // [REVISED] Was `@unique` — a GLOBAL unique on a tenant-derived string. Two defects:
  //   (1) unique-constraint checks bypass RLS (§3.4), so a global unique on tenant-controlled input
  //       is a cross-tenant existence oracle;
  //   (2) §4.2 says a requeue inserts a NEW job, which would have collided with the old one.
  // Now tenant-scoped AND generation-stamped:
  //   dedupeKey = "{documentId}:{kind}:{pageFrom}-{pageTo}:g{Document.requeueCount}"
  // Uniqueness moved to @@unique([organizationId, dedupeKey]) below.
  attempts       Int        @default(0)
  maxAttempts    Int        @default(5) @map("max_attempts")
  availableAt    DateTime   @default(now()) @map("available_at") @db.Timestamptz(3)
  lockedAt       DateTime?  @map("locked_at") @db.Timestamptz(3)
  lockedBy       String?    @map("locked_by") @db.VarChar(120)
  leaseUntil     DateTime?  @map("lease_until") @db.Timestamptz(3)
  startedAt      DateTime?  @map("started_at") @db.Timestamptz(3)
  finishedAt     DateTime?  @map("finished_at") @db.Timestamptz(3)
  pageFrom       Int?       @map("page_from")
  pageTo         Int?       @map("page_to")
  engineId       OcrEngineId? @map("engine_id")
  requirements   Json?      @db.JsonB              // OcrRequest.require, d-ocr §9.2
  resultRef      String?    @map("result_ref") @db.VarChar(1024)   // storage key of the raw payload
  lastError      String?    @map("last_error") @db.VarChar(1000)
  createdAt      DateTime   @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt      DateTime   @updatedAt @map("updated_at") @db.Timestamptz(3)

  document Document   @relation(fields: [documentId, organizationId],
                                references: [id, organizationId], onDelete: Cascade)
  events   JobEvent[]

  @@index([status, priority, availableAt], map: "extraction_job_claim_idx")
  // Query: THE claim — WHERE status='PENDING' AND available_at <= now()
  //        ORDER BY priority ASC, available_at ASC LIMIT $n FOR UPDATE SKIP LOCKED.
  // Deliberately NOT prefixed by organization_id: the worker claims across all tenants.
  // See the RLS note below.
  @@index([leaseUntil], map: "extraction_job_lease_until_idx")
  // Query: lease sweeper — WHERE status='RUNNING' AND lease_until < now().
  @@index([organizationId, documentId, createdAt], map: "extraction_job_org_doc_created_idx")
  // Query: the job timeline shown on a document's detail page.
  @@index([organizationId, status, createdAt], map: "extraction_job_org_status_idx")
  // Query: per-tenant queue depth for the quota/backpressure check and the ops dashboard.
  @@unique([organizationId, dedupeKey], map: "extraction_job_org_dedupe_key")
  // [REVISED] Query: enqueue idempotency — INSERT ... ON CONFLICT (organization_id, dedupe_key)
  // DO NOTHING. Tenant-scoped so it is not a cross-tenant oracle (§3.4). Replaces the draft's
  // global @unique on dedupe_key.
  @@unique([id, organizationId], map: "extraction_job_id_org_key")   // composite-FK anchor
  @@map("extraction_jobs")
}

model JobEvent {
  id             String       @id @db.Uuid
  organizationId String       @map("organization_id") @db.Uuid
  jobId          String       @map("job_id") @db.Uuid
  kind           JobEventKind
  attempt        Int
  detail         String?      @db.VarChar(1000)   // SAFE strings only — never document content
  durationMs     Int?         @map("duration_ms")
  at             DateTime     @default(now()) @db.Timestamptz(3)

  job ExtractionJob @relation(fields: [jobId, organizationId],
                              references: [id, organizationId], onDelete: Cascade)

  @@index([jobId, at], map: "job_event_job_at_idx")
  // Query: job timeline — WHERE job_id=$1 ORDER BY at ASC.
  @@index([organizationId, at], map: "job_event_org_at_idx")
  // Query: 90-day retention sweep, and the per-tenant throughput chart.
  @@map("job_events")
}
```

**The RLS exception for the claim.** The worker's claim query spans all tenants, so it cannot run
under `app.current_org`. Resolution: the claim runs as a **third role, `ocr_queue`**, which has
`SELECT, UPDATE` on `extraction_jobs` and a policy of `USING (true)` — but has **no privileges at all
on `documents`, `document_pages`, `ocr_results`, `extraction_field_values` or `corrections`**. It can
see job metadata (ids, status, page ranges) and nothing else. Once a job is claimed, the processing
transaction switches to `ocr_app` with `app.current_org` set from the claimed row. Two roles, two
blast radii. Grant this explicitly in the migration; do not let `ocr_app` and `ocr_queue` be the same
role.

**The claim statement** (single atomic `UPDATE`, per A-6 point 3):

```sql
UPDATE extraction_jobs j
SET    status      = 'RUNNING',
       locked_at   = now(),
       locked_by   = $1,                        -- worker id
       lease_until = now() + ($2 || ' milliseconds')::interval,
       started_at  = COALESCE(j.started_at, now()),
       attempts    = j.attempts + 1,
       updated_at  = now()
FROM ( SELECT id FROM extraction_jobs
       WHERE  status = 'PENDING' AND available_at <= now()
         AND  attempts < max_attempts          -- [ADDED] see the note below
       ORDER  BY priority ASC, available_at ASC
       LIMIT  $3
       FOR UPDATE SKIP LOCKED ) AS c
WHERE  j.id = c.id
RETURNING j.id, j.organization_id, j.document_id, j.kind, j.attempts,
          j.page_from, j.page_to, j.engine_id, j.requirements, j.lease_until;
```

**[ADDED] Why `attempts < max_attempts` belongs in the claim, not only in the failure handler.** The
draft set `DEAD` on the *failure* path only. But the lease sweeper below returns an abandoned job to
`PENDING` without going through the failure path, so a worker that is `OOM`-killed mid-page never
records a failure. Without the predicate, such a job is re-claimed forever: attempts climbs past
`max_attempts` and nothing ever sets `DEAD`. With it, the job becomes invisible to the claim once
attempts are exhausted and the reaper (below) can retire it. This is the classic "poison pill loops
until the queue melts" bug and it is one WHERE clause.

**[ADDED] The lease sweeper, which the draft named but never wrote.** It has two jobs — revive, and
retire — and they must be separate statements so the retire path can also move the document:

```sql
-- 1. REVIVE: a RUNNING job whose lease expired goes back to PENDING with backoff.
UPDATE extraction_jobs
SET    status      = 'PENDING',
       locked_by   = NULL,
       locked_at   = NULL,
       lease_until = NULL,
       available_at = now() + (least(300000, 1000 * power(2, least(attempts, 8)))::int
                               || ' milliseconds')::interval,
       last_error  = 'LEASE_EXPIRED',
       updated_at  = now()
WHERE  status = 'RUNNING'
  AND  lease_until < now()
  AND  attempts < max_attempts
RETURNING id, organization_id, document_id, attempts;
-- Each returned row also writes a JobEvent(kind = LEASE_EXPIRED).

-- 2. RETIRE: attempts exhausted, whether by failure or by repeated lease loss.
UPDATE extraction_jobs
SET    status = 'DEAD', finished_at = now(), lease_until = NULL, locked_by = NULL, updated_at = now()
WHERE  status IN ('RUNNING','PENDING')
  AND  attempts >= max_attempts
  AND  (lease_until IS NULL OR lease_until < now())
RETURNING id, organization_id, document_id;
-- Each returned row writes JobEvent(DEAD_LETTERED) and drives the document to FAILED
-- via the normal status-transition path (§4.3), inside the same transaction.
```

The backoff expression duplicates jawbong's `calculateBackoffMs(attempt, 1_000, 300_000)` in SQL so
the sweeper needs no application round trip. **The two must be tested against each other** — a unit
test that asserts `sqlBackoff(n) === calculateBackoffMs(n, 1_000, 300_000)` for `n` in `0..12`,
because a silent divergence here shows up as "retries are too aggressive in production only".
`power()` returns `double precision`, hence the explicit `::int`.

**Lease heartbeat** (a 200-page OCR outlives any sane initial lease):

```sql
UPDATE extraction_jobs SET lease_until = now() + interval '120 seconds', updated_at = now()
WHERE id = $1 AND locked_by = $2 AND status = 'RUNNING' AND lease_until > now();
```

**Lease-guarded completion** — closes the hole where a worker that lost its lease overwrites the
result of the worker that took over:

```sql
UPDATE extraction_jobs
SET status='SUCCEEDED', finished_at=now(), result_ref=$3, lease_until=NULL, locked_by=NULL, updated_at=now()
WHERE id=$1 AND locked_by=$2 AND status='RUNNING' AND lease_until > now();
-- 0 rows affected => our lease expired; discard the result and log LEASE_EXPIRED.
```

Backoff on failure reuses jawbong's `calculateBackoffMs(attempt, 1_000, 300_000)` verbatim; at
`attempts >= maxAttempts` the status becomes `DEAD` (not `FAILED`) and the document transitions to
`FAILED`. Keeping `FAILED` (this attempt failed, will retry) distinct from `DEAD` (gave up) is what
lets the ops dashboard show "retrying" separately from "needs a human".

**Why the claim index is not `(organizationId, status, ...)`.** It is the one query in the system
that is deliberately cross-tenant, so a tenant-leading index would be useless for it. Consequence
worth naming: a single tenant dumping 50 000 pages can monopolise the queue. `priority` exists to fix
that — the enqueue path sets `priority = 100 + floor(pending_jobs_for_this_org / 50)`, a cheap
approximation of fair queuing. Measure in M2; a proper weighted-fair claim is an M6 concern.

### 5.6 OCR results and analyses

```prisma
model OcrResult {
  id              String          @id @db.Uuid
  organizationId  String          @map("organization_id") @db.Uuid
  documentPageId  String          @map("document_page_id") @db.Uuid
  jobId           String?         @map("job_id") @db.Uuid
  engineId        OcrEngineId     @map("engine_id")
  engineVersion   String          @map("engine_version") @db.VarChar(160)
  renderDpi       Int             @map("render_dpi")
  deterministic   Boolean
  confidenceGrain ConfidenceGrain @map("confidence_grain")
  emitsLineBoxes  Boolean         @map("emits_line_boxes")
  rawText         String          @map("raw_text")          // engine bytes, NEVER mutated
  normalizedText  String          @map("normalized_text")   // NFC + Thai normalisation
  linesJson       Json            @map("lines_json") @db.JsonB
  markdown        String?
  meanConfidence  Float?          @map("mean_confidence")
  lineCount       Int             @map("line_count")
  warnings        String[]        @db.VarChar(60)
  durationMs      Int             @map("duration_ms")
  payloadRef      String?         @map("payload_ref") @db.VarChar(1024)  // immutable engine payload blob
  createdAt       DateTime        @default(now()) @map("created_at") @db.Timestamptz(3)

  documentPage    DocumentPage   @relation("PageResults",
                                           fields: [documentPageId, organizationId],
                                           references: [id, organizationId], onDelete: Cascade)
  canonicalForPages DocumentPage[] @relation("PageCanonical")
  corrections     Correction[]

  @@unique([documentPageId, engineId, engineVersion, renderDpi], map: "ocr_result_page_engine_key")
  // Query: reuse probe — "have we already run THIS engine at THIS version and DPI on THIS page?"
  // Also makes a retried job idempotent: a second identical run cannot create a second row.
  @@unique([id, organizationId], map: "ocr_result_id_org_key")   // [ADDED] composite-FK anchor,
  // required by Correction.ocrResult and DocumentPage.canonicalOcrResult under invariant TEN-1.
  @@index([organizationId, createdAt], map: "ocr_result_org_created_idx")
  // Query: retention sweep and per-tenant storage accounting.
  @@map("ocr_results")
}
// APPEND-ONLY. See §8. No updatedAt column — its absence is the design statement.
//
// [ADDED] `jobId` is a bare Uuid? with NO foreign key, and that is deliberate, not an oversight.
// A dead-lettered job is purged after 90 days (§12.1 risk 5) while its OCR evidence must survive
// under the DOCUMENT's retention, which is longer. An FK with onDelete: Cascade would delete the
// evidence with the job; onDelete: SetNull would be an UPDATE on an append-only table and would trip
// the trigger in §8.1. A soft pointer is the only shape consistent with both retentions. The same
// reasoning applies to DocumentAnalysis.jobId. Both are documented here so that a future reviewer
// "adding the missing FK" has to argue against a stated reason.
//
// [ADDED] `deterministic` deserves a sharper definition than the draft's, because §7.1 step 5 makes
// a correctness decision on it. It means: THIS engine at THIS engineVersion, given byte-identical
// input at the same renderDpi, returns byte-identical `rawText`. It is a property of the engine
// BUILD, not of the engine family — a Tesseract with a different `--oem`, a different thread count
// (which changes ordering in some builds), or GPU non-determinism flips it to false. The worker
// asserts it by running the engine twice on one fixture page at startup and comparing; it does not
// take the engine's word for it. If the self-check fails, the worker reports deterministic = false
// for every result it writes in that process lifetime.

model PromptVersion {
  id              String            @id @db.Uuid
  key             String            @db.VarChar(80)
  version         Int
  inputKind       AnalysisInputKind @map("input_kind")
  template        String
  modelId         String            @map("model_id") @db.VarChar(200)
  temperature     Float             @default(0)
  topP            Float?            @map("top_p")
  maxOutputTokens Int               @map("max_output_tokens")
  responseSchema  Json?             @map("response_schema") @db.JsonB
  checksum        String            @db.VarChar(64)
  publishedAt     DateTime?         @map("published_at") @db.Timestamptz(3)
  retiredAt       DateTime?         @map("retired_at") @db.Timestamptz(3)
  createdAt       DateTime          @default(now()) @map("created_at") @db.Timestamptz(3)

  analyses DocumentAnalysis[]

  @@unique([key, version], map: "prompt_version_key_version_key")
  // Query: resolve the active prompt — WHERE key=$1 ORDER BY version DESC LIMIT 1, and the exact
  // pinned version when replaying an old analysis.
  @@map("prompt_versions")
}
// GLOBAL, not tenant-scoped, no RLS policy: prompts are product artefacts, contain no customer
// data, and must be readable by every tenant's analysis path. Append-only once publishedAt is set.

model DocumentAnalysis {
  id               String            @id @db.Uuid
  organizationId   String            @map("organization_id") @db.Uuid
  documentId       String            @map("document_id") @db.Uuid
  jobId            String?           @map("job_id") @db.Uuid
  kind             AnalysisKind
  inputKind        AnalysisInputKind @map("input_kind")
  promptVersionId  String            @map("prompt_version_id") @db.Uuid
  modelId          String            @map("model_id") @db.VarChar(200)
  modelServedName  String?           @map("model_served_name") @db.VarChar(200)
  gatewayRequestId String?           @map("gateway_request_id") @db.VarChar(120)
  temperature      Float
  seed             Int?
  outcome          AnalysisOutcome
  resultJson       Json?             @map("result_json") @db.JsonB
  rawResponse      String?           @map("raw_response")      // only when outcome != SUCCEEDED
  finishReason     String?           @map("finish_reason") @db.VarChar(40)
  promptTokens     Int?              @map("prompt_tokens")
  completionTokens Int?              @map("completion_tokens")
  latencyMs        Int               @map("latency_ms")
  sourcePageNumbers Int[]            @map("source_page_numbers")
  sourceOcrResultIds String[]        @map("source_ocr_result_ids") @db.Uuid
  sourceImageObjectIds String[]      @map("source_image_object_ids") @db.Uuid
  redactionApplied Boolean           @default(false) @map("redaction_applied")
  supersedesId     String?           @map("supersedes_id") @db.Uuid
  errorCode        String?           @map("error_code") @db.VarChar(60)
  createdAt        DateTime          @default(now()) @map("created_at") @db.Timestamptz(3)

  document      Document      @relation(fields: [documentId, organizationId],
                                        references: [id, organizationId], onDelete: Cascade)
  promptVersion PromptVersion @relation(fields: [promptVersionId], references: [id], onDelete: Restrict)

  @@index([documentId, createdAt(sort: Desc)], map: "document_analysis_doc_created_idx")
  // Query: latest analysis for a document — WHERE document_id=$1 ORDER BY created_at DESC LIMIT 1.
  @@index([organizationId, promptVersionId, createdAt], map: "document_analysis_org_prompt_idx")
  // Query: prompt regression analysis — "how did prompt v7 perform for this tenant last week?"
  @@index([organizationId, outcome, createdAt], map: "document_analysis_org_outcome_idx")
  // Query: AI reliability dashboard — WHERE outcome <> 'SUCCEEDED' ORDER BY created_at DESC.
  @@map("document_analyses")
}
// APPEND-ONLY. Re-analysis inserts a new row with supersedesId set. Never updated.
```

**Both AI-gateway branches, in one table.** `b-ai-topology-discovery.md` leaves item E (vision
capability) unresolved, so the schema must not assume:

| | **Branch T — Qwen is text-only** | **Branch V — Qwen is vision-capable** |
|---|---|---|
| `inputKind` | `TEXT` | `IMAGE` or `TEXT_AND_IMAGE` |
| `sourceOcrResultIds` | populated — the analysis is grounded in OCR text, so every claim is traceable to a specific engine run | may be empty when the model reads pixels directly |
| `sourceImageObjectIds` | empty | populated — the exact `StorageObject` page renders sent to the gateway |
| `promptTokens` | text tokens only | includes image tokens; the number is not comparable to Branch T, so **never average across branches** |
| `redactionApplied` | text redaction before send | **image** redaction before send — a materially harder problem, and the reason this flag exists |
| Evidence anchoring | OCR line index + quad from `OcrResult` | none from the model; anchors must be recovered by matching the returned string back to OCR lines |

No column changes between branches. The only branch-dependent behaviour is which array is populated,
which is exactly the level at which a schema should absorb an unresolved dependency. **What would
change this:** if Branch V turns out to return per-field bounding boxes (some VLM OCR stacks do), add
`resultJson.fields[].quad` — a JSONB shape change, no migration.

### 5.7 Templates, fields, values, corrections

```prisma
model ExtractionTemplate {
  id             String    @id @db.Uuid
  organizationId String    @map("organization_id") @db.Uuid
  slug           String    @db.VarChar(80)
  version        Int
  name           String    @db.VarChar(200)
  nameTh         String?   @map("name_th") @db.VarChar(200)
  description    String?   @db.VarChar(1000)
  documentKind   String?   @map("document_kind") @db.VarChar(60)
  publishedAt    DateTime? @map("published_at") @db.Timestamptz(3)
  archivedAt     DateTime? @map("archived_at") @db.Timestamptz(3)
  createdAt      DateTime  @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt      DateTime  @updatedAt @map("updated_at") @db.Timestamptz(3)

  organization Organization           @relation(fields: [organizationId], references: [id], onDelete: Restrict)
  fields       ExtractionField[]
  documents    Document[]
  fieldValues  ExtractionFieldValue[]

  @@unique([organizationId, slug, version], map: "extraction_template_org_slug_version_key")
  // Query: resolve a template by name and pin a version — WHERE organization_id=$1 AND slug=$2
  //        ORDER BY version DESC LIMIT 1.
  @@unique([id, organizationId], map: "extraction_template_id_org_key")   // composite-FK anchor
  @@index([organizationId, archivedAt], map: "extraction_template_org_archived_idx")
  // Query: the template picker — WHERE organization_id=$1 AND archived_at IS NULL.
  @@map("extraction_templates")
}
// A template row IS a version. Once publishedAt is set the row is immutable (trigger, §8) — a
// document's extraction is pinned to an exact, unchangeable field definition. Editing a published
// template inserts a new row with version+1.
// Templates are ALWAYS org-owned. The three starter templates are COPIED into each organization at
// creation rather than living in a shared "system" org, so the RLS predicate stays uniform across
// every tenant table with no special case.
//
// [ADDED] Copied FROM WHERE? The draft did not say, and "copied into each org" with no source is
// not a mechanism. The source is a version-controlled TypeScript catalogue,
// `src/modules/templates/domain/starter-catalogue.ts`, exporting a frozen array typed against the
// same Zod schema the template API validates. Organization creation calls
// `installStarterTemplates(tx, orgId)` inside the SAME transaction that inserts the organization,
// so an org can never exist without its templates. There is NO system organization and NO
// database-resident master copy — a master row would need either a cross-tenant read (breaking the
// RLS uniformity this comment claims) or an org-shaped special case.
// Consequence, named: improving a starter template does NOT retroactively update existing tenants.
// That is correct — a published template is immutable and a tenant's extractions are pinned to it
// (see the freeze trigger in §8.1). Rolling out an improved starter is an explicit, opt-in
// "new version available" action per organization, and it is a product feature, not a migration.
// `starterCatalogueVersion Int?` on Organization records which catalogue version was installed, so
// that feature can find the orgs that are behind.

model ExtractionField {
  id           String        @id @db.Uuid
  organizationId String      @map("organization_id") @db.Uuid
  templateId   String        @map("template_id") @db.Uuid
  key          String        @db.VarChar(80)
  label        String        @db.VarChar(200)
  labelTh      String?       @map("label_th") @db.VarChar(200)
  dataType     FieldDataType @map("data_type")
  required     Boolean       @default(false)
  ordering     Int
  promptHint   String?       @map("prompt_hint") @db.VarChar(1000)
  regexPattern String?       @map("regex_pattern") @db.VarChar(400)
  enumValues   String[]      @map("enum_values") @db.VarChar(120)
  minValue     Decimal?      @map("min_value") @db.Decimal(24, 8)
  maxValue     Decimal?      @map("max_value") @db.Decimal(24, 8)
  unit         String?       @db.VarChar(24)
  isSensitive  Boolean       @default(false) @map("is_sensitive")
  createdAt    DateTime      @default(now()) @map("created_at") @db.Timestamptz(3)

  template ExtractionTemplate     @relation(fields: [templateId, organizationId],
                                            references: [id, organizationId], onDelete: Cascade)
  values   ExtractionFieldValue[]

  @@unique([templateId, key], map: "extraction_field_template_key_key")
  // Query: resolve a field by its stable key when mapping an LLM's JSON output back to columns.
  @@unique([id, organizationId], map: "extraction_field_id_org_key")   // composite-FK anchor
  @@index([templateId, ordering], map: "extraction_field_template_order_idx")
  // Query: render the review form in the author's intended order.
  @@map("extraction_fields")
}

model ExtractionFieldValue {
  id                String            @id @db.Uuid
  organizationId    String            @map("organization_id") @db.Uuid
  documentId        String            @map("document_id") @db.Uuid
  templateId        String            @map("template_id") @db.Uuid
  fieldId           String            @map("field_id") @db.Uuid
  origin            FieldValueOrigin
  isCurrent         Boolean           @default(true) @map("is_current")
  supersedesId      String?           @map("supersedes_id") @db.Uuid

  valueKey          String?           @map("value_key") @db.VarChar(200)   // normalised, indexable
  valueText         String?           @map("value_text") @db.VarChar(4000)
  valueNumber       Decimal?          @map("value_number") @db.Decimal(24, 8)
  valueMinor        BigInt?           @map("value_minor")                  // MONEY: integer satang
  currency          String?           @db.VarChar(3)
  valueDate         DateTime?         @map("value_date") @db.Date
  valueBool         Boolean?          @map("value_bool")
  valueJson         Json?             @map("value_json") @db.JsonB

  // ── [ADDED] Thai semantics. See §9.6 and §9.7. Without these three columns the product is
  // ── silently wrong on the majority of Thai tax invoices, which is the flagship template.
  valueTextRaw      String?           @map("value_text_raw") @db.VarChar(4000)
  // Exactly what appeared on the page, before digit folding and before BE→CE conversion. This is
  // the string a reviewer must be shown when they open the highlight, because showing them the
  // normalised form and asking "is this right?" invites them to approve a conversion they never saw.
  thaiDigitPolicy   ThaiDigitPolicy   @default(PRESERVE) @map("thai_digit_policy")
  // Which folding was applied to reach valueKey / valueNumber / valueDate from valueTextRaw.
  dateEra           DateEra?          @map("date_era")
  // For DATE/DATETIME fields: which era the SOURCE string was in. `valueDate` is ALWAYS CE.
  // NULL for non-date fields; UNKNOWN when the year was ambiguous (see §9.7).

  confidence        Float?
  pageNumber        Int?              @map("page_number")
  quadJson          Json?             @map("quad_json") @db.JsonB
  sourceAnalysisId  String?           @map("source_analysis_id") @db.Uuid
  sourceOcrResultId String?           @map("source_ocr_result_id") @db.Uuid
  sourceLineIndex   Int?              @map("source_line_index")
  createdAt         DateTime          @default(now()) @map("created_at") @db.Timestamptz(3)
  createdByUserId   String?           @map("created_by_user_id") @db.Uuid

  document    Document           @relation(fields: [documentId, organizationId],
                                           references: [id, organizationId], onDelete: Cascade)
  // [REVISED] both were single-column FKs, violating TEN-1 (§3.3).
  template    ExtractionTemplate @relation(fields: [templateId, organizationId],
                                           references: [id, organizationId],
                                           onDelete: Restrict, onUpdate: NoAction)
  field       ExtractionField    @relation(fields: [fieldId, organizationId],
                                           references: [id, organizationId],
                                           onDelete: Restrict, onUpdate: NoAction)
  corrections Correction[]

  @@index([documentId, fieldId, isCurrent], map: "field_value_doc_field_current_idx")
  // Query: render the review form — WHERE document_id=$1 AND is_current ORDER BY field ordering.
  @@index([organizationId, fieldId, valueKey, isCurrent], map: "field_value_org_field_key_idx")
  // Query: cross-document lookup by exact value — "every document with tax id 0105558xxxxxx".
  // valueKey is the normalised, length-capped form precisely so this index stays small.
  // [REVISED] isCurrent APPENDED. Without it the index returns superseded values and the query
  // "every document with tax id X" answers with documents where a human ALREADY CORRECTED that
  // value away — a wrong answer, not a slow one. Same fix on the two indexes below. isCurrent goes
  // last so the index still serves the isCurrent-agnostic historical query with an extra filter.
  @@index([organizationId, fieldId, valueNumber, isCurrent], map: "field_value_org_field_number_idx")
  // Query: numeric range — "invoices over 50,000 THB".
  @@index([organizationId, fieldId, valueDate, isCurrent], map: "field_value_org_field_date_idx")
  // Query: date range — "invoices dated in Q3". valueDate is ALWAYS CE (§9.7).
  @@unique([id, organizationId], map: "field_value_id_org_key")   // composite-FK anchor
  @@map("extraction_field_values")
}
// APPEND-ONLY. A correction inserts a new row (origin=HUMAN, supersedesId=<old>) and flips the old
// row's is_current to false — the ONE permitted UPDATE, restricted to that single column by the
// append-only trigger in §8.
//
// [ADDED] "Exactly one current value per (document, field)" is enforced by a PARTIAL UNIQUE INDEX,
// not by the counting trigger the draft proposed — that trigger was not concurrency-safe. See §8.1
// for the analysis. The index is declared in schema.prisma using the `partialIndexes` preview
// feature (VERIFIED: Prisma documents a `where` argument on @@unique/@@index/@unique behind the
// `partialIndexes` preview flag, supported on PostgreSQL), so it is visible to the drift gate and
// needs no allowlist entry:
//
//   @@unique([documentId, fieldId], map: "field_value_one_current_key", where: { isCurrent: true })
//
// If the preview flag is judged unacceptable for M1, the fallback is raw SQL plus one drift
// allowlist entry — NOT the trigger:
//   CREATE UNIQUE INDEX field_value_one_current_key
//     ON extraction_field_values (document_id, field_id) WHERE is_current;

model Correction {
  id                String              @id @db.Uuid
  organizationId    String              @map("organization_id") @db.Uuid
  documentId        String              @map("document_id") @db.Uuid
  targetKind        CorrectionTargetKind @map("target_kind")
  fieldValueId      String?             @map("field_value_id") @db.Uuid
  ocrResultId       String?             @map("ocr_result_id") @db.Uuid
  lineIndex         Int?                @map("line_index")
  action            CorrectionAction
  previousValueText String?             @map("previous_value_text") @db.VarChar(4000)
  newValueText      String?             @map("new_value_text") @db.VarChar(4000)
  reasonCode        String?             @map("reason_code") @db.VarChar(60)
  note              String?             @db.VarChar(1000)
  actorUserId       String              @map("actor_user_id") @db.Uuid
  createdAt         DateTime            @default(now()) @map("created_at") @db.Timestamptz(3)

  document   Document              @relation("CorrectionDocument",
                                             fields: [documentId, organizationId],
                                             references: [id, organizationId], onDelete: Cascade)
  // [REVISED] both were single-column FKs, violating TEN-1 (§3.3). Named relations because
  // organizationId now participates in three relations on this model, which Prisma permits and
  // disambiguates by name (§3.3, RESOLVED).
  fieldValue ExtractionFieldValue? @relation("CorrectionFieldValue",
                                             fields: [fieldValueId, organizationId],
                                             references: [id, organizationId],
                                             onDelete: Cascade, onUpdate: NoAction)
  ocrResult  OcrResult?            @relation("CorrectionOcrResult",
                                             fields: [ocrResultId, organizationId],
                                             references: [id, organizationId],
                                             onDelete: Cascade, onUpdate: NoAction)

  @@index([documentId, createdAt], map: "correction_doc_created_idx")
  // Query: the correction-history panel — WHERE document_id=$1 ORDER BY created_at ASC.
  @@index([organizationId, actorUserId, createdAt], map: "correction_org_actor_created_idx")
  // Query: reviewer throughput and the "who changed this" audit view.
  @@index([organizationId, reasonCode, createdAt], map: "correction_org_reason_created_idx")
  // Query: OCR quality feedback loop — which reason codes dominate, per engine/period. This is the
  // table that will drive the M2 benchmark's error taxonomy.
  @@map("corrections")
}
// APPEND-ONLY, no exceptions: no updatedAt, no deletedAt, UPDATE and DELETE revoked from ocr_app.
// CHECK enforces exactly one target (see §8).
// NOTE: an OCR_LINE correction addresses (ocrResultId, lineIndex). That reference is STABLE because
// OcrResult is immutable — the lines_json array is never rewritten, so index 47 is index 47 forever.
```

### 5.8 Audit, quota, usage

```prisma
model AuditLog {
  id             String       @db.Uuid
  organizationId String       @map("organization_id") @db.Uuid
  occurredAt     DateTime     @default(now()) @map("occurred_at") @db.Timestamptz(3)
  actorType      ActorType    @map("actor_type")
  actorId        String?      @map("actor_id") @db.Uuid       // NO FK — must outlive the actor
  apiKeyId       String?      @map("api_key_id") @db.Uuid     // NO FK — must outlive the key
  action         String       @db.VarChar(80)                 // 'document.upload', 'document.export'
  resourceType   String       @map("resource_type") @db.VarChar(60)
  resourceId     String?      @map("resource_id") @db.Uuid
  outcome        AuditOutcome
  requestId      String?      @map("request_id") @db.VarChar(64)
  ipHash         String?      @map("ip_hash") @db.VarChar(64)      // HMAC, rotating daily salt
  userAgentHash  String?      @map("user_agent_hash") @db.VarChar(64)
  metadata       Json?        @db.JsonB                            // allowlisted keys only

  @@id([id, occurredAt], map: "audit_logs_pkey")
  @@index([organizationId, occurredAt(sort: Desc)], map: "audit_log_org_occurred_idx")
  // Query: the org's audit feed — WHERE organization_id=$1 ORDER BY occurred_at DESC LIMIT 100.
  @@index([organizationId, resourceType, resourceId, occurredAt(sort: Desc)], map: "audit_log_org_resource_idx")
  // Query: "everything that ever happened to this document" — the compliance answer.
  @@index([organizationId, actorType, actorId, occurredAt(sort: Desc)], map: "audit_log_org_actor_idx")
  // Query: "everything this user or API key did" — the incident-response answer.
  @@map("audit_logs")
}
// [ADDED] `organizationId` has NO relation to Organization either, and the draft did not say so.
// Deliberate, same reasoning as actorId: an org may be closed and purged while its audit trail is
// still under legal hold. An FK with onDelete: Restrict would make closing an account impossible;
// Cascade would destroy the evidence of the closure. The cost is that a bogus organization_id is
// insertable — mitigated by the fact that the only writer is one audit port that takes a
// TenantScope, and by RLS WITH CHECK, which rejects an organization_id that is not the caller's.
//
// [ADDED] Where the ipHash salt lives, because "HMAC, rotating daily salt" is not a mechanism.
// The salt is a 32-byte key held in the SECRETS MANAGER, never in PostgreSQL, under the key name
// `audit/ip-salt/{YYYY-MM-DD}`. It is generated lazily on first use of a UTC day and retained for
// 35 days, then destroyed. Consequences, all intended:
//   - an adversary who steals a database dump cannot brute-force the IPv4 space (2^32 is trivially
//     enumerable if the salt is in the same dump — which is exactly why it must NOT be);
//   - correlation works within a day and degrades after 35 days, matching incident-response need;
//   - the same IP produces different hashes on different days, so the column is not a stable
//     identifier and is defensible under PDPA/GDPR data-minimisation.
// Store the salt DATE alongside the hash (`ipSaltDate DateTime? @map("ip_salt_date") @db.Date`)
// or verification after a key rotation is impossible. That column is ADDED to the model.

model Quota {
  id             String      @id @db.Uuid
  organizationId String      @map("organization_id") @db.Uuid
  metric         UsageMetric
  period         QuotaPeriod
  limitValue     BigInt      @map("limit_value")
  enforced       Boolean     @default(true)
  createdAt      DateTime    @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt      DateTime    @updatedAt @map("updated_at") @db.Timestamptz(3)

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Restrict)

  @@unique([organizationId, metric, period], map: "quota_org_metric_period_key")
  // Query: the pre-flight admission check on every upload and every API request.
  @@map("quotas")
}

model UsageCounter {
  id             String      @id @db.Uuid
  organizationId String      @map("organization_id") @db.Uuid
  metric         UsageMetric
  period         QuotaPeriod                                       // [ADDED] see below
  periodStart    DateTime    @map("period_start") @db.Date
  value          BigInt      @default(0)
  updatedAt      DateTime    @updatedAt @map("updated_at") @db.Timestamptz(3)

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Restrict)

  @@unique([organizationId, metric, period, periodStart], map: "usage_counter_org_metric_period_key")
  // [REVISED] `period` ADDED to both the model and the unique key. Without it, the DAY counter for
  // the 1st of a month and the MONTH counter for that month share (org, metric, period_start =
  // 2026-09-01) and collide: the ON CONFLICT below would add the month's total into the day's row,
  // or vice versa, depending on which arrived first. Quota enforcement would then be wrong by
  // roughly a factor of 30 on the first day of every month — a bug that only appears monthly and
  // only in production, which is the worst kind.
  // Query: BOTH the ON CONFLICT target for the atomic increment AND the quota-check read.
  @@map("usage_counters")
}
```

Increment atomically — never read-modify-write. **[REVISED]** One statement per period granularity
the tenant has a `Quota` for, all in the caller's transaction:

```sql
-- The bucket function, so the period boundary is defined once rather than at each call site.
CREATE OR REPLACE FUNCTION usage_period_start(p_period "QuotaPeriod", p_tz text)
RETURNS date LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_period
           WHEN 'DAY'   THEN (now() AT TIME ZONE p_tz)::date
           WHEN 'MONTH' THEN date_trunc('month', now() AT TIME ZONE p_tz)::date
           WHEN 'TOTAL' THEN DATE '1970-01-01'          -- one immortal bucket
         END $$;

INSERT INTO usage_counters (id, organization_id, metric, period, period_start, value, updated_at)
VALUES ($1, $2, $3, $4, usage_period_start($4, $5), $6, now())
ON CONFLICT (organization_id, metric, period, period_start)
DO UPDATE SET value = usage_counters.value + EXCLUDED.value, updated_at = now();
```

**[ADDED] `$5` is the tenant's timezone, not a hard-coded `'Asia/Bangkok'`.** The draft hard-coded
Bangkok. That is right for the expected customer base and wrong the first time a Singapore or
Australian customer signs up: their "daily quota" would reset at 01:00 or 04:00 local, and their
usage report would not tie out against their own billing day. Add
`billingTimeZone String @default("Asia/Bangkok") @map("billing_time_zone") @db.VarChar(48)` to
`Organization` and pass it. Note the function is marked `IMMUTABLE` while it calls `now()`, which is
a lie to the planner — **it must be `STABLE`**; `IMMUTABLE` would let the planner fold it to a
constant across a long-running transaction. Corrected in the migration; written here as a warning
because this exact mistake is easy to copy.

**[ADDED] Quota enforcement is check-then-act and therefore racy.** Reading `usage_counters`,
comparing to `quotas.limit_value`, and then accepting an upload is two statements with a window
between them; ten concurrent uploads all read "999 of 1000" and all proceed. For a *soft* quota that
is acceptable and it is what we ship in M1, stated as a deliberate choice. The M2 hardening is to
make the increment itself the gate — increment first, and let a `CHECK`-style predicate reject:

```sql
UPDATE usage_counters c SET value = c.value + $6, updated_at = now()
FROM   quotas q
WHERE  c.organization_id = $2 AND c.metric = $3 AND c.period = $4 AND c.period_start = usage_period_start($4,$5)
  AND  q.organization_id = c.organization_id AND q.metric = c.metric AND q.period = c.period
  AND  (NOT q.enforced OR c.value + $6 <= q.limit_value)
RETURNING c.value;
-- 0 rows => quota exceeded. One statement, one row lock, no window.
```

This serialises on the counter row per (org, metric, period), which is exactly the contention we
want and is a known throughput ceiling of a few thousand increments/second per bucket — far above
the §11 projection of ~20 000 documents/month.

**`BigInt` warning.** Prisma maps `BigInt` to JavaScript `bigint`, which `JSON.stringify` throws on.
`UsageCounter.value` and `Quota.limitValue` are `BigInt` because a token counter genuinely can exceed
2³¹. Everything else that could have been `BigInt` — notably `Document.sizeBytes` and
`StorageObject.sizeBytes` — is deliberately `Int` with a `CHECK (size_bytes BETWEEN 0 AND 209715200)`
(200 MB upload cap), because the value can never approach 2 GB and `Int` avoids the serialisation
footgun on the hottest DTOs.

### 5.9 [ADDED] K-13 — `DocumentBlock`: the entity the brief named and the draft silently dropped

The brief listed `DocumentBlock` among the entities to consider. The draft neither modelled it nor
rejected it — it simply is not mentioned, which is the one outcome a design review cannot accept,
because a reader cannot tell whether it was considered and dismissed or overlooked. Resolving it now.

**Decision: no `DocumentBlock` table in M1. Block structure lives inside `OcrResult.linesJson` and,
if layout-aware extraction is later specified, is materialised as a derived table then.**

**What it would have been.** A row per detected layout region — paragraph, table, table cell, header,
footer, stamp, signature block — with `(documentPageId, blockIndex, kind, quad, parentBlockId,
readingOrder, text)`. At §11's volumes that is roughly **15–40 blocks per page × 1.44 M pages/year =
22–58 M rows/year**, immediately the largest table in the system by an order of magnitude, larger
than `job_events` and `extraction_field_values` combined.

**Why not now, in order of weight:**

1. **Nothing in M1 queries it.** The rule from §10.1 is that a value is relational only if we filter,
   join, sort or group on it. No M1 feature does any of those on a block: the viewer renders an
   overlay (reads whole), the LLM receives text (reads whole), the reviewer corrects a *field value*,
   not a block. A 40-million-row table serving zero `WHERE` clauses is the exact anti-pattern §10.1
   exists to prevent.
2. **The producing contract does not emit blocks.** `d-ocr-engine.md` §9.2's `OcrProvider` returns
   `OcrDocument`/`OcrPage`/`OcrLine` with `Quad` and confidence. There is no block in the wire
   contract, so a `document_blocks` table in M1 would be populated by a heuristic we have not
   designed, from data we do not have. Modelling ahead of the producer is how a schema acquires
   permanently-empty columns.
3. **Blocks are engine-dependent and therefore not stable evidence.** PaddleOCR's layout model, a VLM,
   and a native PDF text layer disagree about what a "paragraph" is. Blocks are an *interpretation*,
   and this schema's whole discipline (§5.4) is that interpretations are projections which can be
   recomputed, while `OcrResult` is immutable evidence. A block table would sit awkwardly on both
   sides: too derived to be evidence, too expensive to recompute casually.
4. **Line-level geometry already answers the questions M1 asks.** "Where on the page did this value
   come from?" is `ExtractionFieldValue.(pageNumber, quadJson, sourceOcrResultId, sourceLineIndex)`.
   That is a line-precise anchor and it is enough to draw the highlight.

**What we lose by deferring, stated plainly:** table extraction. `AnalysisKind.TABLE_EXTRACT` exists
in the enum and a Thai tax invoice's `line_items` are genuinely tabular. In M1 those land in
`ExtractionFieldValue.valueJson` as a structured blob (§10.1's "narrow use" row) — which means we
cannot query "every invoice containing a line item over 10 000 THB" without scanning JSON. That is a
real, named limitation, not an oversight.

**The reversal trigger, so this is a decision and not a shrug.** Introduce `DocumentBlock` when
**either** (a) a specified feature requires querying *within* document structure — line-item search,
"find the signature block", table-aware export — **or** (b) the OCR contract starts emitting layout
regions, at which point storing them costs nothing extra to produce. When that happens it is an
**additive** migration: a new table with an FK to `document_pages`, populated forward from that date
and backfilled lazily on first access. Nothing in the current schema forecloses it, which is the
property that makes deferring safe. `OcrResult.linesJson` retains the raw geometry, so a backfill has
the input it needs and does not require re-running OCR.

---

## 6. K-5 — Where large text actually lives

### 6.1 The size math, for the brief's 200-page scan

Assumptions, stated: A4 at 300 DPI (2480 × 3508 px), dense Thai body text, ~40 lines/page,
~60 characters/line. Thai codepoints are **3 bytes each in UTF-8**.

| Artefact | Per page | × 200 pages |
|---|---|---|
| `normalizedText` (2 400 chars × 3 B) | ~7.2 KB | **1.44 MB** |
| `rawText` (engine bytes, ≈ same) | ~7.2 KB | 1.44 MB |
| `searchTokens` (tokens + separators, ≈ +15 %) | ~8.3 KB | 1.66 MB |
| `linesJson` — 40 lines × (text 180 B + rawText 180 B + 8-number quad ~70 B + confidence + script + JSON keys ≈ 650 B) | ~26 KB | **5.2 MB** |
| **PostgreSQL subtotal per document** | **~49 KB** | **~9.8 MB** |
| Original PDF (300 DPI, JPEG-compressed grayscale, 150–400 KB/page) | ~275 KB | **30–80 MB** |
| Page renders (JPEG q85 grayscale for the viewer) | ~450 KB | **90 MB** |
| Immutable engine payload blob (raw worker JSON, uncompressed) | ~35 KB | 7 MB |

### 6.2 The decision

**Text and per-line geometry live in PostgreSQL, one row per page. Blobs live in object storage.**

**Rejected — one JSONB blob per document.** 9.8 MB fits (PostgreSQL's per-field limit is 1 GB) and
TOAST handles it transparently. It is still wrong, for a specific reason: **any operator on a `jsonb`
value must have the whole value materialised**, so `doc->'pages'->137` detoasts and decompresses all
9.8 MB before it can read one page. Per-page rows make that same fetch a single ~26 KB TOAST read —
roughly **250× less I/O on the viewer's hottest path**, which is "show me one page".

**[REVISED] Precision on the mechanism, because the draft's phrasing was wrong in a way that
matters.** The draft said "PostgreSQL cannot partially read a compressed TOASTed value". That is not
accurate: PostgreSQL *does* support slicing a TOASTed datum (`PG_DETOAST_DATUM_SLICE`), and for a
compressed value it decompresses only up to the requested end offset — which is why `substr()` on a
long `text` column is genuinely cheaper than reading it whole. The reason the argument still holds is
narrower and stronger: **`jsonb` has no slice path.** Its binary representation must be fully
present before any path extraction, so `jsonb` defeats the optimisation that `text` would have
enjoyed. Getting this right matters beyond pedantry — it means that if we ever store a very large
value we intend to read a *prefix* of, `text` and `substr()` is a real option and `jsonb` is not.

**Rejected — all OCR text in object storage with only a pointer in the database.** It removes ~10 MB
per large document from PostgreSQL, and costs: an S3 round trip (10–40 ms) on every page view; no
`WHERE`/`JOIN` on text ever; no transactional consistency between a page row and its text; a second
failure mode and a second backup story. The volume does not justify any of that — §11 projects
~16 GB of compressed OCR text in year one, which is unremarkable for a single PostgreSQL instance.

**The rule, stated once so it can be applied to future columns:**

> Any single value that can exceed **256 KB**, or that is binary, goes to object storage. Everything
> smaller stays in PostgreSQL.

256 KB because a TOAST chunk carries ~1 996 bytes of payload, so 256 KB is ~128 chunks — still one
index lookup plus a short sequential read of the TOAST relation. Past that, the TOAST read starts to
dominate and object storage costs nothing extra in latency terms.

**Applied:**

| Data | Home | Why |
|---|---|---|
| `rawText`, `normalizedText`, `linesJson`, `markdown` per page | PostgreSQL | ≤ ~35 KB/page; transactional with the page row; `linesJson` is read whole to render an overlay |
| `DocumentPage.plainText`, `searchTokens` | PostgreSQL | the canonical projection; needed for search and export |
| Original upload | object storage | 30–80 MB, binary, immutable |
| Page renders / thumbnails | object storage | ~450 KB each, binary, **and regenerable** — hence `expiresAt`: delete renders 30 days after `COMPLETED` and re-rasterise on demand. §11 shows this is the single largest storage line |
| Raw immutable engine payload | object storage, `OcrResult.payloadRef` | audit evidence, written once, read approximately never |
| Exports (CSV/JSON/PDF) | object storage, TTL 7 days | derived, regenerable |

### 6.3 Two compression details worth the two lines of migration SQL

PostgreSQL 18's `default_toast_compression` is still **`pglz`**. **VERIFIED 2026-09-09:** the commit
changing the default to `lz4` is in the PostgreSQL 19 development cycle (Euler Taveira, reviewed by
Peter Eisentraut and Aleksander Alekseev), which also replaces the `--with-lz4` build option with
`--without-lz4`, i.e. LZ4 becomes the assumed build default. Two operational corollaries the draft
did not state: **(a)** on a future major upgrade, existing pglz-compressed TOAST values stay pglz
until the rows are rewritten — the setting affects new writes only, so an upgrade does not
retroactively speed up old pages; **(b)** because of (a), setting `SET COMPRESSION lz4` explicitly
now is not merely a micro-optimisation, it is what avoids a mixed-codec table later.
LZ4 decompresses several times faster at comparable ratios on JSON-like text, and these columns are
read on every page view:

```sql
ALTER TABLE ocr_results     ALTER COLUMN lines_json      SET COMPRESSION lz4;
ALTER TABLE ocr_results     ALTER COLUMN raw_text        SET COMPRESSION lz4;
ALTER TABLE ocr_results     ALTER COLUMN normalized_text SET COMPRESSION lz4;
ALTER TABLE ocr_results     ALTER COLUMN markdown        SET COMPRESSION lz4;
ALTER TABLE document_pages  ALTER COLUMN plain_text      SET COMPRESSION lz4;
ALTER TABLE document_pages  ALTER COLUMN plain_text_raw  SET COMPRESSION lz4;   -- [ADDED] §9.8
ALTER TABLE document_pages  ALTER COLUMN search_tokens   SET COMPRESSION lz4;
ALTER TABLE document_pages  ALTER COLUMN search_tokens_subword SET COMPRESSION lz4;  -- [ADDED] §9.3
```

**[ADDED] `SET COMPRESSION` applies to future writes only.** Existing TOASTed values keep the codec
they were written with, so these statements must be in the *creating* migration (0010, immediately
after the tables exist and before any data), not added later. Added later they would need a
`VACUUM FULL` or a rewrite to take effect on existing rows — which is why they are their own
migration directory rather than an afterthought.

*Requires the server to be built with LZ4 — `postgres:18.4-bookworm` is.* **UNVERIFIED** for whatever
managed provider production lands on; check `SELECT * FROM pg_settings WHERE name = 'default_toast_compression'`
before assuming. If LZ4 is unavailable the statements fail loudly at migration time, which is the
right failure.

Thai text compresses well (repeated 3-byte sequences with a common `0xE0 0xB8/0xB9` prefix); the
JSON compresses better still because of repeated keys. Estimate **~2.5–3×**, so the 9.8 MB document
above occupies roughly **3.3–4 MB** on disk. *UNVERIFIED — measure on the first real corpus.*

---

## 7. K-7 — SHA-256 dedup, and the cross-tenant privacy trap

### 7.1 Same file, same organization

**Behaviour: detect and offer. Never silently block, never silently merge.**

1. At upload the API computes `sha256` of the raw bytes while streaming (before anything is stored).
2. It probes `document_org_sha_idx`:
   `SELECT id, public_id, created_at FROM documents WHERE organization_id=$1 AND content_sha256=$2 AND deleted_at IS NULL LIMIT 1`.
3. On a hit, return `200` with `{ duplicateOf: <publicId>, uploadedAt, pageCount }` and let the
   caller choose *open the existing document* or *create a new one anyway*.
4. If they create a new one, the new `Document` **points at the same `StorageObject`** — no second
   copy of the bytes within the tenant — and `duplicateOfDocumentId` records the lineage.
5. **OCR results are reusable within the tenant**, but only under a strict condition:
   `OcrResult.deterministic = true` **and** the same `engineId` + `engineVersion` + `renderDpi`.
   A VLM engine (`deterministic = false`) is **never** reused — re-running is the only honest
   behaviour when the engine can return different text for identical input. This is exactly why
   `deterministic` is a column and not a comment.

`documents.(organization_id, content_sha256)` is deliberately **not unique**: two documents from the
same bytes are legitimate (different template, different case file, different retention).

### 7.2 Same file, different user, same organization

Same as §7.1, gated on permission: the "duplicate found" response is returned **only if the caller
holds `document:list` in that organization**. A `VIEWER` who can only see documents shared with them
gets a normal fresh-upload response. Otherwise the duplicate probe becomes an in-tenant enumeration
oracle for documents the caller is not allowed to see.

### 7.3 Different organization — the trap

**Global dedup is rejected outright.** A globally-unique `content_sha256`, or a shared
content-addressed blob store, converts the platform into a **file-existence oracle**. Any customer
with an account can test *"has anyone on this platform ever uploaded this exact file?"* by uploading
a candidate and observing:

- an explicit "duplicate" response (the obvious leak);
- **abnormally fast completion** — OCR that normally takes 40 s returns in 300 ms;
- **a smaller billed page count** or an unchanged `PAGES_OCR` usage counter;
- **a zero delta in `STORAGE_BYTES`**.

The last three leak even with a scrupulously silent API. The consequence is not theoretical: it lets
one customer confirm that a *specific* leaked contract, a *specific* signed agreement, or a
*specific* scanned national ID card is held by a competitor. For a platform whose entire proposition
is "secure", that is a product-ending defect.

There is a second, independent reason. **PDPA (Thailand) and GDPR erasure.** If organization A and
organization B share one physical blob by refcount, A's lawful deletion request cannot delete the
bytes while B still references them. "We deleted your pointer" is not erasure.

**Resolution — three concrete measures:**

1. **Tenant-scoped uniqueness only.** `@@unique([organizationId, contentFingerprint, kind])` on
   `StorageObject`. There is no unique index anywhere in the schema on a content hash alone.
2. **Tenant-namespaced object keys.** `org/{organizationId}/blob/{sha256}`. Bytes are physically
   separate per tenant. Two tenants uploading the same 50 MB PDF store it twice. **That duplication
   is the price of the guarantee, and it is cheap** — §11 projects 288 GB/year of originals in total,
   so even 100 % cross-tenant duplication would be a rounding error against the 648 GB/year of page
   renders.
3. **No cross-tenant OCR reuse, ever.** Identical bytes in two tenants are OCR'd twice. Accept the
   compute.

**Optional hardening — the per-tenant HMAC fingerprint.** `StorageObject` carries *two* hashes:
- `contentSha256` — the plain digest, used for **integrity verification only** (does the blob we
  just read still match what we stored?). It is not the dedup key and is not unique-indexed.
- `contentFingerprint` = `HMAC-SHA256(org_dedup_key, file_bytes)` — the dedup key, and the only one
  in a unique index.

With a per-organization HMAC key, even an adversary who reads the entire `storage_objects` table
cannot correlate a file across tenants, because the two tenants' fingerprints for identical bytes
differ. Cost: one 32-byte key per organization in the KMS, and rotation invalidates the dedup index
(acceptable — dedup is an optimisation). **Adopt this only if the threat model includes a
database-read adversary** (a stolen backup, a compromised read replica, a hostile DBA). If it does
not, `contentFingerprint = contentSha256` and the schema is unchanged. Keeping both columns from day
one costs 64 bytes per blob row and means the hardening is a backfill, not a migration.

### 7.4 [ADDED] The object-key grammar, stated once

The draft gave two incompatible key shapes in two sections (§2: `org/{orgId}/doc/{docId}/original`;
§7.3: `org/{organizationId}/blob/{sha256}`) and never reconciled them. They are not interchangeable:
a per-document key makes the same-tenant blob reuse of §7.1 step 4 impossible, and a
content-addressed key is what `storage_object_org_fingerprint_key` assumes. The content-addressed
form wins. The full grammar, which is what `StorageObject.objectKey` stores and what
`storage_object_bucket_key_key` makes unique:

```
ORIGINAL        org/{organizationId}/blob/{contentFingerprint}
ENGINE_PAYLOAD  org/{organizationId}/payload/{ocrResultId}.json.zst
PAGE_RENDER     org/{organizationId}/render/{documentId}/{pageNumber:05d}@{dpi}.jpg
PAGE_THUMBNAIL  org/{organizationId}/thumb/{documentId}/{pageNumber:05d}.jpg
EXPORT          org/{organizationId}/export/{exportId}.{ext}
```

Four properties this buys, each of which the split shapes lost:

1. **`ORIGINAL` is content-addressed, so same-tenant dedup is a no-op write.** Two documents over
   identical bytes resolve to one key and one `StorageObject` row, which is exactly §7.1 step 4.
2. **Everything else is identity-addressed**, because a render is a *derivative* whose bytes depend
   on the renderer version — content-addressing it would make a renderer upgrade silently reuse
   stale pixels.
3. **Every key begins `org/{organizationId}/`**, so the tenant boundary is expressible as a bucket
   policy / IAM condition (`s3:prefix`), a second enforcement layer independent of the database. This
   is the property that makes a compromised application still unable to read another tenant's blobs,
   *if* the per-tenant credential is scoped — which is a decision for `c-storage`, not this document,
   but the key shape must not foreclose it, and the draft's `doc/{docId}` form did not foreclose it
   either. Both work; only one supports dedup.
4. **No filename appears in a key.** Thai filenames are UTF-8 and would need percent-encoding, would
   leak PII into access logs (see §8.2, `originalFilename` is forbidden in the audit log for exactly
   this reason), and would break the S3 key-length budget on long Thai names. The original filename
   lives only in `documents.original_filename`, never in a path.

**No `deletedAt`-style tombstone on the blob.** `StorageObject.deletedAt` marks the row; the bytes
are removed by the purge job and the removal is confirmed by a subsequent `HEAD` returning 404,
recorded as an `AuditLog` row with `action = 'storage.erase'` and `outcome = SUCCESS`. "We set a
flag" is not erasure; see §7.3's second argument.

---

## 8. K-8 / K-9 — Append-only evidence, and the audit log

### 8.1 Append-only, enforced in the database

Prose does not stop an `updateMany`. Three mechanisms, all in the migration SQL.

#### [REVISED] The draft's version of this deadlocked every delete in the system

The draft wrote `BEFORE UPDATE **OR DELETE**` triggers that raise unconditionally, on tables that are
simultaneously the targets of `onDelete: Cascade` from `Document`. Triggers fire for **every** role,
including `ocr_erasure`, and a cascade delete is an ordinary `DELETE` as far as a row trigger is
concerned. Therefore, in the draft as written:

- `DELETE FROM documents` → cascades to `document_pages` → cascades to `ocr_results` →
  `APPEND_ONLY_VIOLATION`. **Lawful PDPA/GDPR erasure is impossible.**
- The same for `corrections` and `document_analyses` (cascade from `documents`) and `job_events`
  (cascade from `extraction_jobs`, itself cascade from `documents`).
- The 400-day `audit_logs` retention sweep in §8.3 is also a `DELETE`, and K-8 lists `audit_logs` as
  trigger-enforced — although §8.1 then never created that trigger, an inconsistency in its own
  right.
- The render-TTL sweeper deleting a `StorageObject` cascades to `scan_results`, which is fine only
  because that table has no trigger — but it is append-only evidence by the same argument and
  *should* have one.

This is not a tuning problem; it is a design contradiction between "these rows are immutable" and
"these rows are children that must disappear with their parent". Both requirements are real. The
resolution is to separate **who** may delete from **whether** deletion is possible at all.

#### The corrected mechanism

```sql
-- 1a. A trigger that refuses UPDATE outright. UPDATE is never legitimate on evidence, for anyone.
CREATE OR REPLACE FUNCTION reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'APPEND_ONLY_VIOLATION: % on % is forbidden', TG_OP, TG_TABLE_NAME
    USING ERRCODE = '42501';
END $$;

CREATE TRIGGER ocr_results_no_update        BEFORE UPDATE ON ocr_results        FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER corrections_no_update        BEFORE UPDATE ON corrections        FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER document_analyses_no_update  BEFORE UPDATE ON document_analyses  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER job_events_no_update         BEFORE UPDATE ON job_events         FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER scan_results_no_update       BEFORE UPDATE ON scan_results       FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER audit_logs_no_update         BEFORE UPDATE ON audit_logs         FOR EACH ROW EXECUTE FUNCTION reject_mutation();
-- [ADDED] scan_results and audit_logs were missing from the draft's trigger list while being
-- listed as append-only in K-8. Now consistent.

-- 1b. DELETE is refused UNLESS the session has explicitly opened an erasure window. The window is a
--     transaction-local GUC that only the purge job sets, and setting it is itself audited.
CREATE OR REPLACE FUNCTION reject_delete_outside_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('app.erasure_window', true), 'off') <> 'on' THEN
    RAISE EXCEPTION 'APPEND_ONLY_VIOLATION: DELETE on % requires an erasure window', TG_TABLE_NAME
      USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END $$;

CREATE TRIGGER ocr_results_guarded_delete       BEFORE DELETE ON ocr_results       FOR EACH ROW EXECUTE FUNCTION reject_delete_outside_erasure();
CREATE TRIGGER corrections_guarded_delete       BEFORE DELETE ON corrections       FOR EACH ROW EXECUTE FUNCTION reject_delete_outside_erasure();
CREATE TRIGGER document_analyses_guarded_delete BEFORE DELETE ON document_analyses FOR EACH ROW EXECUTE FUNCTION reject_delete_outside_erasure();
CREATE TRIGGER job_events_guarded_delete        BEFORE DELETE ON job_events        FOR EACH ROW EXECUTE FUNCTION reject_delete_outside_erasure();
CREATE TRIGGER scan_results_guarded_delete      BEFORE DELETE ON scan_results      FOR EACH ROW EXECUTE FUNCTION reject_delete_outside_erasure();
CREATE TRIGGER audit_logs_guarded_delete        BEFORE DELETE ON audit_logs        FOR EACH ROW EXECUTE FUNCTION reject_delete_outside_erasure();

-- The window is opened for exactly one transaction, by exactly one code path:
--   await tx.$executeRaw`SELECT set_config('app.erasure_window', 'on', true)`;
-- `true` = is_local, so it cannot leak to the next borrower of a pooled connection (§3.4 point 2).

-- 2. Privileges: the runtime role cannot even attempt it.
REVOKE UPDATE, DELETE ON ocr_results, corrections, document_analyses, job_events, scan_results,
                          audit_logs
  FROM ocr_app;
GRANT  DELETE ON ocr_results, corrections, document_analyses, job_events, scan_results,
                 audit_logs, documents, document_pages, extraction_jobs, extraction_field_values,
                 storage_objects
  TO ocr_erasure;

-- 3. Structural: these tables have NO updated_at and NO deleted_at column. Their absence is the
--    design statement, and a reviewer adding one has to justify it.

-- Published templates freeze:
CREATE OR REPLACE FUNCTION freeze_published_template() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.published_at IS NOT NULL
     AND (NEW.name, NEW.name_th, NEW.slug, NEW.version, NEW.document_kind)
      IS DISTINCT FROM (OLD.name, OLD.name_th, OLD.slug, OLD.version, OLD.document_kind) THEN
    RAISE EXCEPTION 'PUBLISHED_TEMPLATE_IMMUTABLE: create a new version instead'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;                                   -- archived_at / updated_at may still change
END $$;
CREATE TRIGGER extraction_template_freeze
  BEFORE UPDATE ON extraction_templates
  FOR EACH ROW EXECUTE FUNCTION freeze_published_template();

-- Field values: exactly one permitted UPDATE — retiring a row by flipping is_current true -> false.
CREATE OR REPLACE FUNCTION field_value_retire_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT (OLD.is_current AND NOT NEW.is_current) THEN
    RAISE EXCEPTION 'FIELD_VALUE_APPEND_ONLY: only is_current true->false may be updated'
      USING ERRCODE = '42501';
  END IF;
  IF (NEW.value_key, NEW.value_text, NEW.value_number, NEW.value_minor, NEW.value_date,
      NEW.value_bool, NEW.value_json, NEW.origin, NEW.field_id, NEW.document_id)
  IS DISTINCT FROM
     (OLD.value_key, OLD.value_text, OLD.value_number, OLD.value_minor, OLD.value_date,
      OLD.value_bool, OLD.value_json, OLD.origin, OLD.field_id, OLD.document_id) THEN
    RAISE EXCEPTION 'FIELD_VALUE_IMMUTABLE: insert a superseding row instead'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER extraction_field_value_append_only
  BEFORE UPDATE ON extraction_field_values
  FOR EACH ROW EXECUTE FUNCTION field_value_retire_only();

-- [REVISED] Exactly one current value per (document, field).
--
-- The draft used a counting CONSTRAINT TRIGGER here and justified it with "without a partial index
-- (see §10.2 on why undeclared indexes are banned)". Both halves of that were wrong:
--
--   (a) THE TRIGGER IS NOT CONCURRENCY-SAFE. Two transactions correcting the same field at the same
--       moment each INSERT a row with is_current = true. Under READ COMMITTED neither SELECT sees
--       the other's uncommitted row, so both count 1, both pass, both commit — and the invariant is
--       violated with no error. Deferring the constraint does not help: DEFERRABLE moves the check
--       to COMMIT time, but each transaction still runs its own snapshot and still cannot see the
--       other. Only a UNIQUE INDEX, which takes a real lock on the index entry, serialises this.
--       The failure is silent and produces a review form that shows two "current" values for one
--       field, which the UI will render as whichever the ORDER BY happens to return.
--
--   (b) THE PREMISE WAS FALSE. Partial indexes ARE expressible in Prisma: VERIFIED against the
--       Prisma indexes documentation, `@@unique`/`@@index`/`@unique` accept a `where` argument
--       behind the `partialIndexes` preview flag, supported on PostgreSQL. So the index is visible
--       to the drift gate and needs no allowlist entry. There was no reason to reach for a trigger.
--
-- The correct enforcement (declared in schema.prisma; raw SQL shown for the migration file):
CREATE UNIQUE INDEX field_value_one_current_key
  ON extraction_field_values (document_id, field_id) WHERE is_current;
--
-- Consequence for the correction path, which now needs an explicit ordering: the retire-then-insert
-- must happen in that order inside ONE transaction, because the index will reject the insert while
-- the old row is still current:
--   UPDATE extraction_field_values SET is_current = false WHERE id = $old AND is_current;
--   INSERT INTO extraction_field_values (..., is_current, supersedes_id) VALUES (..., true, $old);
-- A concurrent second correction now blocks on the same index entry and then fails its UPDATE
-- (0 rows, because $old is no longer current), which the application surfaces as a 409 "this value
-- was changed by someone else" — the correct behaviour for a review workflow, and one the draft's
-- trigger could not have produced.

-- Exactly one correction target.
ALTER TABLE corrections ADD CONSTRAINT correction_one_target CHECK (
  (target_kind = 'FIELD_VALUE' AND field_value_id IS NOT NULL
                               AND ocr_result_id IS NULL AND line_index IS NULL)
  OR
  (target_kind = 'OCR_LINE'    AND ocr_result_id  IS NOT NULL AND line_index IS NOT NULL
                               AND field_value_id IS NULL)
);

-- A document may not leave VALIDATING without a CLEAN scan of its original.
CREATE OR REPLACE FUNCTION assert_scanned_before_queue() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'QUEUED' AND OLD.status = 'VALIDATING' THEN
    PERFORM 1 FROM scan_results
      WHERE storage_object_id = NEW.original_storage_object_id AND verdict = 'CLEAN';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'UNSCANNED_DOCUMENT_CANNOT_BE_QUEUED: %', NEW.id USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_10_scan_gate
  BEFORE UPDATE OF status ON documents
  FOR EACH ROW EXECUTE FUNCTION assert_scanned_before_queue();
```

**[REVISED] Three defects in the draft's scan gate, all fixed above and below.**

1. **Trigger name.** Renamed `document_scan_gate` → `document_10_scan_gate` so it sorts *after*
   `document_00_status_transition_guard` (§4.3 note 1). Without the numeric prefix the alphabetical
   order put the scan gate first and an illegal transition reported the wrong error.
2. **The gate accepted a scan of the wrong tenant's blob and a scan at any signature version.**
   `PERFORM 1 FROM scan_results WHERE storage_object_id = ... AND verdict = 'CLEAN'` is true even if
   the only `CLEAN` verdict is three years old, from a scanner build long since superseded. The
   corrected predicate pins both the tenant and freshness:
   ```sql
   PERFORM 1 FROM scan_results s
    WHERE s.storage_object_id = NEW.original_storage_object_id
      AND s.organization_id   = NEW.organization_id            -- explicit; do not rely on RLS in a trigger
      AND s.verdict           = 'CLEAN'
      AND s.scanned_at        > now() - interval '30 days';    -- a stale CLEAN is not a CLEAN
   ```
3. **Do not rely on RLS inside a trigger function.** The function runs with the invoker's privileges,
   so RLS *does* apply when `ocr_app` is the invoker — but it does **not** when the invoker is
   `ocr_erasure`, `ocr_owner`, or a future migration/backfill, and a security gate that changes
   meaning with the connecting role is not a gate. The explicit `organization_id` predicate makes it
   role-independent. This is the general rule: **triggers that enforce security must restate the
   tenant predicate rather than inherit it.**

**The escape hatch, named explicitly.** Lawful erasure (PDPA/GDPR) genuinely must delete rows.
That runs as a **fourth role, `ocr_erasure`**, which holds `DELETE` on the tenant tables and is used
by exactly one code path: the purge job. Four roles total: `ocr_owner` (migrations), `ocr_app`
(runtime), `ocr_queue` (claim only), `ocr_erasure` (purge only).

**[REVISED] The draft contradicted itself here in one sentence.** It said *"Every erasure writes an
`AuditLog` row before deleting, and `ocr_erasure` has no `INSERT`/`UPDATE` anywhere, so it cannot
forge evidence."* Those cannot both be true: a role with no `INSERT` cannot write the audit row.
The corrected protocol splits the erasure into two transactions with two roles, which is stronger
than what the draft intended anyway:

```
T1  as ocr_app      INSERT audit_logs (action='document.erase', outcome='SUCCESS',
                                       resource_id=<documentId>, metadata={legalBasis, ticketRef})
                    -- ocr_app has INSERT on audit_logs and no DELETE. It writes the intent.
                    COMMIT.        <- the evidence is durable before anything is destroyed

T2  as ocr_erasure  SELECT set_config('app.erasure_window','on',true);
                    DELETE FROM documents WHERE id = $1;      -- cascades, triggers permit it now
                    COMMIT.

T3  as ocr_app      INSERT audit_logs (action='document.erase.completed', outcome='SUCCESS', ...)
                    -- after a HEAD on the blob confirms 404 (§7.4)
```

`ocr_erasure` therefore has `DELETE` and `SELECT` only, and genuinely cannot forge evidence; the
audit rows are written by a role that cannot delete them. If T2 fails after T1, the audit shows an
erasure that was ordered and not completed — which is exactly the row a compliance officer needs and
which the draft's single-transaction design would have rolled back into nonexistence.

**[ADDED] Cascades run with the referencing table's owner privileges, not the caller's.** So
`ocr_erasure` does not strictly need `DELETE` granted on every child table for the cascade to
proceed; the grants above are for the explicit, ordered deletes the purge job performs when it needs
to control ordering (for example nulling `document_pages.canonical_ocr_result_id` before deleting
`ocr_results`, per §5.4). The `BEFORE DELETE` triggers, by contrast, **do** fire on cascade
regardless of role — which is the whole reason the erasure window exists.

**[ADDED] The test that proves this works, and that the draft would have failed:**

```ts
// tests/integration/erasure_cascade.test.ts
it("a document delete cascades through every append-only child inside an erasure window", async () => {
  const { documentId } = await seedDocumentWithPagesResultsAnalysesCorrections();
  await expect(erasureClient.$transaction(async (tx) => {
    await tx.$executeRaw`DELETE FROM documents WHERE id = ${documentId}::uuid`;
  })).rejects.toThrow(/requires an erasure window/);          // no window -> refused

  await erasureClient.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.erasure_window','on',true)`;
    await tx.$executeRaw`UPDATE document_pages SET canonical_ocr_result_id = NULL WHERE document_id = ${documentId}::uuid`;
    await tx.$executeRaw`DELETE FROM documents WHERE id = ${documentId}::uuid`;
  });
  for (const t of ["document_pages","ocr_results","document_analyses","corrections","extraction_field_values"]) {
    expect(await countRows(t, documentId)).toBe(0);
  }
});
```

### 8.2 What the audit log records

**Recorded:** `organizationId`, `occurredAt`, `actorType`, `actorId`, `apiKeyId`, `action`
(dotted verb, e.g. `document.upload`, `document.export`, `document.view_page`, `apikey.create`,
`correction.create`, `document.erase`), `resourceType` + `resourceId`, `outcome`
(`SUCCESS`/`DENIED`/`ERROR` — **`DENIED` is the most valuable row in the table** and is the one teams
forget to write), `requestId` for correlation with application logs, `ipHash`, `userAgentHash`, and a
size-capped `metadata` JSONB with an **allowlisted key set** validated by Zod before insert.

**Forbidden — never, under any circumstance:**

| Forbidden | Why |
|---|---|
| Document contents, OCR text, `markdown`, any `lines_json` | The audit log has the longest retention, the widest read audience (compliance, support, SRE) and the weakest access controls of any table. Putting content there means content outlives the document's own retention. |
| **Extracted field values** | These *are* the PII — the ID number, the bank account, the salary. `correctionId` is the reference; the values live in `corrections` under the document's retention. |
| **`originalFilename`** | The easiest leak to miss. `passport_somchai_2026.pdf` is PII in the filename. Log `documentId` only. |
| Prompts, completions, `resultJson` | Same reasoning; they live in `document_analyses`. |
| API keys, key hashes, any prefix beyond the stored 13 chars, `Authorization` headers, session tokens | Obvious, and still the most common real-world audit-log breach. |
| **Raw IP addresses** | Under PDPA/GDPR an IP is personal data. Store `HMAC-SHA256(daily_salt, ip)` — still correlatable within a day for incident response, not a durable identifier. |
| Free-text error messages from the database or a parser | They embed row content. `job_events.detail` and `documents.failureDetail` take **codes**, not messages. This is why jawbong truncates `lastError` to `VarChar(1000)` — we go further and constrain it to a code vocabulary. |

Enforcement is a Zod schema at the single audit-writing port, plus a
`CHECK (pg_column_size(metadata) <= 4096)`, plus a unit test asserting the allowlist rejects the
forbidden keys by name.

### 8.3 Retention

- **400 days hot** in `audit_logs`. 400 rather than 365 so a 12-month audit cycle plus a month of
  slack fits without an export round trip.
- **Then** export to WORM object storage (compressed NDJSON, one object per org per month), then
  delete. Export before delete, verified by object checksum, in that order.
- **Deletion mechanics for M1: batched `DELETE`**, not partitioning. **[REVISED]** `DELETE ... LIMIT`
  is not valid PostgreSQL syntax — `LIMIT` is not accepted on `DELETE`. The working form, which also
  takes the row locks in a defined order and skips rows another sweeper already holds:
  ```sql
  DELETE FROM audit_logs a
  USING ( SELECT id, occurred_at FROM audit_logs
          WHERE occurred_at < now() - interval '400 days'
          ORDER BY occurred_at
          LIMIT 5000
          FOR UPDATE SKIP LOCKED ) AS victim
  WHERE a.id = victim.id AND a.occurred_at = victim.occurred_at;   -- both PK columns
  ```
  Run in a loop, off peak, until it reports 0 rows. It runs **as `ocr_erasure` inside an erasure
  window** (§8.1) because `audit_logs` now carries a guarded-delete trigger; that is deliberate —
  the only two things that may destroy audit rows are the retention sweeper and a lawful erasure,
  and both go through the same audited gate.
- **[ADDED] Export before delete is a promise the batch above cannot keep on its own.** The sweeper
  must refuse to delete any month for which no verified WORM export object exists:
  `WHERE occurred_at < ... AND date_trunc('month', occurred_at) IN (SELECT month FROM audit_export_manifest WHERE verified_at IS NOT NULL)`.
  That implies a small `audit_export_manifest` table (`organizationId`, `month`, `objectKey`,
  `rowCount`, `sha256`, `exportedAt`, `verifiedAt`) which the draft's "export then delete" prose
  needed and did not have. It is ~600 rows/year and is added to migration 0007.
- **M6 upgrade: monthly `RANGE` partitioning on `occurred_at`**, at which point retention becomes
  `DROP TABLE audit_logs_2025_08` — instant, no bloat, no vacuum. The primary key is already
  `@@id([id, occurredAt])` precisely so this migration is possible without changing the key: a
  partitioned table's primary key must include the partition key.
  **UNVERIFIED:** whether `prisma migrate diff` reports `PARTITION BY RANGE` as drift. Prisma does
  not model partitioning, so it most likely ignores it — check before committing to the M6 plan.
  **[REVISED] The draft's own justification for deferring was arithmetically wrong.** It said
  "`audit_logs` crosses the partitioning threshold (~50 M) around **year 20**". With a 400-day
  retention the table is *bounded*: at ~200 k rows/month it stabilises at
  `200 000 × 13.2 ≈ 2.6 M rows` and never grows past that at all. It never reaches 50 M at this
  volume — not in year 20, not ever. The honest reason to defer partitioning is therefore different
  and simpler: **the table is bounded by retention, so partitioning buys only cheaper deletes, not
  survivable size.** It becomes worth doing if either (a) audit volume rises ~20×, at which point the
  monthly `DELETE` of ~4 M rows starts producing bloat the autovacuum window cannot absorb, or
  (b) a regulator requires a retention longer than ~5 years, which removes the bound. Neither is
  true today. The `@@id([id, occurredAt])` composite key stays regardless — it costs nothing and it
  is what keeps option (b) open, since a partitioned table's primary key must include the partition
  key.
- **Audit rows survive user deletion.** When a user is erased, `audit_logs.actorId` is retained (it
  is a UUID with no FK and no name or email attached, so it is pseudonymous) while the `users` row
  goes. Legitimate-interest basis; document it in the DPA.
- **Optional tamper-evidence (M5).** Rather than a per-row hash chain — which serialises inserts per
  organization — write an `AuditCheckpoint` row per organization per hour holding the SHA-256 of the
  sorted `(id, occurred_at)` pairs in that window, and countersign it. Detects retroactive edits
  without touching the insert path.

---

## 9. K-10 — Thai full-text search

### 9.1 Why `to_tsvector` is nearly useless for Thai

PostgreSQL's default text-search parser finds token boundaries at whitespace and punctuation. **Thai
does not put spaces between words** — spaces appear at roughly clause or sentence boundaries. So:

```sql
SELECT to_tsvector('simple', 'ใบกำกับภาษีเลขที่๐๐๑๒๓ออกให้แก่บริษัทอินโนเวร่าจำกัด');
-- => 'ใบกำกับภาษีเลขที่๐๐๑๒๓ออกให้แก่บริษัทอินโนเวร่าจำกัด':1
```

One lexeme for an entire clause. A user searching `ภาษี` ("tax") matches nothing, because `ภาษี` is
not that lexeme. The index is built, occupies space, and answers no realistic query. There is no
`thai` text-search configuration in core PostgreSQL, and adding a stemmer would not help — the
problem is **segmentation**, upstream of stemming.

### 9.2 The options, honestly

| Option | How it handles no-spaces | Verdict |
|---|---|---|
| `to_tsvector('simple', raw_thai)` | it does not | **useless.** Do not ship it. |
| **`pg_trgm` GIN + `ILIKE '%q%'`** | trigrams are character-level, so word boundaries are irrelevant — this is the one classic technique Thai *does not* break | **viable but materially degraded on Thai — see the resolved note below.** No relevance ranking, and the index is large (§9.4). `similarity()`/`%` is close to meaningless on a full page (the denominator is the whole document's trigram set); `word_similarity` is documented as "the greatest similarity between the first string and any continuous extent of an ordered set of trigrams in the second string" and does not pad the extent boundaries, so on a single unbroken Thai run it degenerates toward whole-string similarity. So: `ILIKE` acceleration only. |
| **Application tokenisation → space-joined tokens → `to_tsvector('simple', tokens)`** | segmentation happens in Python, where a real Thai tokeniser exists | **chosen.** Real FTS with ranking, phrase search, prefix search, and a small index. |
| PGroonga | native CJK/Thai FTS, excellent quality | **rejected for now.** A non-core extension: unavailable on most managed PostgreSQL, a new operational surface, and its own index format in our backups. **What would change this:** self-hosted PostgreSQL plus a search quality bar that §9.3 measurably fails. |
| External engine (Meilisearch / Elasticsearch / Typesense) | own Thai segmenters | **rejected for now.** A second datastore, a second consistency story, a second backup surface — the exact objection `a-environment-and-stack.md` §5.5 raised against Redis, and it applies identically here. |

**[RESOLVED — was `UNVERIFIED`] How `pg_trgm` actually behaves on Thai, and why it is worse than the
draft assumed.** The user-facing documentation is silent on multibyte encodings, so the answer comes
from the implementation (`contrib/pg_trgm/trgm_op.c`, `compact_trigram`): pg_trgm stores each trigram
in a **fixed 3-byte** struct. For single-byte encodings the three characters are stored directly. For
a trigram whose characters do not fit in 3 bytes — **which is every all-Thai trigram, since each Thai
codepoint is 3 UTF-8 bytes, so an all-Thai trigram is 9 bytes** — pg_trgm computes a **CRC32 of the
trigram and keeps only the 3 upper bytes** as the stored value. The source comment is explicit about
the trade-off: *"use only 3 upper bytes from crc, hope, it's good enough hashing."*

Three consequences, none of which were in the draft, and together they change the verdict from
"viable" to "viable as a last resort only":

1. **A 24-bit hash over a trigram space far larger than 2²⁴ collides.** Thai has ~87 assigned
   codepoints; realistic Thai trigram diversity is well past 2²⁴. Collisions produce **index false
   positives**, which PostgreSQL rechecks against the heap — correct results, but each recheck is a
   heap fetch. On Thai, a GIN trigram scan therefore does far more heap work per matching row than
   the same query on Latin text.
2. **Selectivity estimates degrade with it**, so the planner may choose a trigram scan where a
   sequential scan is cheaper, or the reverse.
3. **`pg_trgm` "ignores non-word characters (non-alphanumerics)"** (verbatim from the PostgreSQL 18
   documentation). Thai letters *are* alphabetic under a UTF-8 locale, so a whole Thai clause is one
   "word" and receives one pair of boundary pads instead of one pair per word. Combined with (1),
   the index is both larger per unit of information and less discriminating than the Latin case that
   most benchmarks report.

None of this makes pg_trgm useless — an `ILIKE '%ภาษี%'` will still be answered correctly and faster
than a sequential scan on a large table. It does mean the draft's implicit "trigrams are the safe
Thai fallback" needs the qualifier: **trigrams are the safe Thai fallback for correctness, not for
cost.** The 30-second confirmation is still worth running on the first real instance —
`SELECT show_trgm('ภาษี');` returns hashed, non-readable trigrams on a UTF-8 database, which is the
visible signature of the code path above.

### 9.3 The chosen path, and why it is nearly free

`d-ocr-engine.md` §7.1 already commits to tokenising every OCR line with PyThaiNLP `newmm` to produce
the `TokenSpan[]` in the `OcrProvider` contract. **We are already paying for segmentation.** Joining
those tokens with U+0020 and storing the result is the entire additional cost:

```
raw:    ใบกำกับภาษีเลขที่๐๐๑๒๓ออกให้แก่บริษัทอินโนเวร่าจำกัด
tokens: ใบกำกับภาษี เลขที่ ๐๐๑๒๓ ออก ให้ แก่ บริษัท อินโนเวร่า จำกัด
```

`to_tsvector('simple', tokens)` now yields nine lexemes. Query text goes through **the identical
tokeniser** before `plainto_tsquery('simple', …)`; a mismatch between index-time and query-time
segmentation is the one failure mode, so the tokeniser version is pinned and recorded
(`TokenSpan.tokenizer` in the contract already carries it).

`'simple'` rather than `'english'` deliberately: no stemming, no stop-word list. A Thai stop-word list
applied by an English stemmer would corrupt tokens, and mixed Thai/English pages are the norm.

#### [ADDED] The problem the draft noticed, shrugged at, and did not solve

The draft wrote: *"`ภาษี` — sorry, `ใบกำกับภาษี` — matches."* That parenthetical is the whole
difficulty, and leaving it as an aside means shipping a search box in which the single most obvious
Thai query on a tax-invoice product — `ภาษี`, "tax" — **returns nothing**. `newmm` is a maximal-matching
segmenter against a dictionary; it prefers the longest dictionary entry, so `ใบกำกับภาษี`
("tax invoice") is one token and `ภาษี` is not a lexeme in the index. Thai compounds are extremely
common in exactly the document classes we target — `เลขประจำตัวผู้เสียภาษี`, `ใบกำกับภาษีอย่างย่อ`,
`ผู้ประกอบการจดทะเบียน` — and every one of them hides several searchable sub-words.

This is not a Thai quirk; it is the standard CJK/Thai "compound recall" problem, and it has a
standard answer: **index two token streams, not one.**

```
searchTokens        = newmm(maxmatch) tokens, space-joined     -- precision; drives ranking
searchTokensSubword = the same text re-segmented with a SUBWORD strategy, space-joined
                      -- recall; every dictionary word that is a substring of a compound
```

For the example: `searchTokensSubword` contains `ใบ กำกับ ภาษี เลข ที่ …`, so `ภาษี` matches.
Concretely, `searchTokensSubword` is produced by running `newmm` with the *shortest-match* /
`safe_mode` dictionary pass and unioning the result with the maxmatch tokens — both are single calls
in PyThaiNLP, both operate on text we are already tokenising, so the added worker cost is one more
pass over ~2 400 characters per page. That is microseconds, and it is the same "already paying for
segmentation" argument that justified the first stream.

The query then becomes a two-vector match with a weight:

```sql
-- M4. setweight lets the compound match outrank the sub-word match, so precision is preserved
-- while recall is recovered.
ALTER TABLE document_pages
  ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (
      setweight(to_tsvector('simple', coalesce(search_tokens,         '')), 'A') ||
      setweight(to_tsvector('simple', coalesce(search_tokens_subword, '')), 'B')
  ) STORED;
```

**Cost, stated honestly:** the second stream is roughly +40 % on token storage (§11's
`document_pages` line goes from ~28 GB/yr raw to ~39 GB/yr raw, ~10 GB → ~14 GB compressed) and a
correspondingly larger GIN index in M4. **The column ships in M1 for the same reason
`searchTokens` does** — backfilling it means re-running the tokeniser over every stored page — and
the index still waits for M4.

**What would change this:** if the M2 benchmark shows `newmm` maxmatch alone achieving acceptable
recall on real user queries (it will not, but measure), drop the second column before M4 and save
the storage. That is a `DROP COLUMN`, not a redesign, which is why the decision is safe to take now.

`ExtractionFieldValue.valueKey` gets the same treatment implicitly: it is an *exact*-match key, not a
search field, so it uses the normalised full string and never the token streams.

### 9.4 Now or later — the actual split

**Now (M1 migration): the columns. Later (M4): the indexes.**

- **`DocumentPage.searchTokens` ships in M1**, populated at ingest. This is the part that must not
  wait: tokens are a by-product of a pipeline run. Adding the column later is cheap DDL (PostgreSQL
  11+ adds a nullable column instantly, no rewrite), but **backfilling it is not** — it means
  re-running `newmm` over every stored page, which for 1.44 M pages is hours of worker time and a
  full-table rewrite. Store it while it is free.
- **No search index ships in M1.** A GIN index over 1.44 M pages × ~8 KB of tokens is roughly
  **12–35 GB** — comparable to the entire rest of the database. The search UX is unspecified: we do
  not know whether users search within one document, across a template, or across everything, and
  those want different indexes. Building the wrong 30 GB index is worse than building none.
- **The M4 migration** is then purely additive and needs no schema change:

```sql
-- M1: the extension only. Prisma's postgresqlExtensions preview flag was DEPRECATED in v6.16.0;
-- the supported route in Prisma 7.9.1 is a customised migration, which is what we write anyway.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- M4, when the search feature is specified. Note: PostgreSQL supports STORED generated columns
-- (12+); Prisma cannot express them, so this is raw SQL and the column is NOT declared in
-- schema.prisma at all (see the revised note below — Unsupported() is NOT the right tool here).
-- [REVISED] Two weighted streams, per §9.3: 'A' = maxmatch compounds (precision),
-- 'B' = sub-word segmentation (recall). A single-stream index cannot answer `ภาษี`.
ALTER TABLE document_pages
  ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (
      setweight(to_tsvector('simple', coalesce(search_tokens,         '')), 'A') ||
      setweight(to_tsvector('simple', coalesce(search_tokens_subword, '')), 'B')
  ) STORED;

CREATE INDEX CONCURRENTLY document_page_search_tsv_idx
  ON document_pages USING GIN (search_tsv);

-- Optional, only if substring/fuzzy search on untokenised text is also required. Read the pg_trgm
-- multibyte note in §9.2 before relying on this for Thai: the index is correct but expensive.
CREATE INDEX CONCURRENTLY document_page_plain_text_trgm_idx
  ON document_pages USING GIN (plain_text gin_trgm_ops);
```

`CREATE INDEX CONCURRENTLY` means M4 costs no downtime — **[ADDED]** provided it is in a migration
directory of its own containing nothing else, because `CREATE INDEX CONCURRENTLY` **cannot run
inside a transaction block** and Prisma wraps each migration file in one. `prisma migrate deploy`
will fail with `25001 active_sql_transaction` otherwise. The mechanical rule for M1 onward: a
migration whose file contains `CONCURRENTLY` contains *only* `CONCURRENTLY` statements, and the CI
migration linter greps for the combination. Add `ADD COLUMN … GENERATED ALWAYS AS … STORED` to the
same caution list for a different reason — it rewrites the whole table and takes an
`ACCESS EXCLUSIVE` lock for the duration, which at 1.44 M pages is minutes, so it is a maintenance
window, not a rolling deploy.

**Two Prisma constraints that force raw SQL here. [REVISED] The first is verified as stated; the
second was wrong as stated and is worse than the draft claimed.**

1. **Verified, unchanged.** Prisma's indexes documentation states plainly that *"indexes using a
   function (such as `to_tsvector`) to determine the indexed value are not yet supported by Prisma
   ORM"*, and notes such indexes are not visible to `prisma db pull`.
2. **Corrected.** The draft said *"Prisma's `ops:` argument does not cover operator classes
   contributed by extensions (`gin_trgm_ops`)"*. That is not right: Prisma documents a
   `raw("…")` escape hatch for operator classes beyond the built-in list, so
   `@@index([plainText(ops: raw("gin_trgm_ops"))], type: Gin)` **is expressible**. The real problem
   is one level down and is *more* damaging, not less: **Prisma cannot round-trip extension-provided
   operator classes through migrate and introspect.** The open issues are explicit about the
   symptoms — [#17516](https://github.com/prisma/prisma/issues/17516) (extension op-classes
   unsupported), [#17518](https://github.com/prisma/prisma/issues/17518) (`btree_gin` +
   `ops: raw("text_ops")` produces *endless* migrations and introspection strips the op class),
   [#16275](https://github.com/prisma/prisma/issues/16275) (every subsequent migration drops and
   recreates the GIN index), [#7515](https://github.com/prisma/prisma/issues/7515) (a custom pg_trgm
   index is removed immediately and causes drift). A dedicated feature request for native trigram
   support, [#26856](https://github.com/prisma/prisma/issues/26856), is still open.
   **Why this matters more than the draft's version:** an *unexpressible* index is a known gap you
   route around once. An index that Prisma expresses but then repeatedly drops and recreates is a
   **migration that silently deletes a production index and rebuilds it non-concurrently**, taking an
   `ACCESS EXCLUSIVE` lock on `document_pages` — an outage, not an inconvenience. So the conclusion
   is unchanged but the rule is stricter: **never declare an extension operator class in
   `schema.prisma`, even though you can.** Keep it in raw SQL and on the allowlist.

Both indexes are therefore kept out of `schema.prisma` deliberately. **That collides with the drift
gate in §10.2** — indexes, unlike triggers and CHECKs, are visible to the migration engine.
Resolution: the two indexes are added to a documented **drift allowlist** consumed by the CI gate,
which is a small, explicit, reviewable file:

```jsonc
// prisma/drift-allowlist.json — every entry needs an owner, a reason and a review date.
{
  "indexes": [
    { "name": "document_page_search_tsv_idx",      "reason": "GIN over a generated tsvector; Prisma cannot express function indexes", "added": "2026-09-09" },
    { "name": "document_page_plain_text_trgm_idx", "reason": "gin_trgm_ops; Prisma drops/recreates extension op-classes (#16275, #7515)", "added": "2026-09-09" },
    { "name": "field_value_one_current_key",       "reason": "ONLY IF partialIndexes preview is not adopted; see §8.1", "added": "2026-09-09" }
  ],
  "columns": [
    { "table": "document_pages", "column": "search_tsv", "reason": "GENERATED ALWAYS AS ... STORED; Prisma does not model generated columns", "added": "2026-09-09" }
  ]
}
```

**[REVISED] `search_tsv` is NOT declared as `Unsupported("tsvector")?`.** The draft proposed that,
reasoning that Prisma would "create/see the column but not expose it in the client". The first half
is the problem: Prisma *would* create it — as a **plain, non-generated** `tsvector` column, because
Prisma has no way to express `GENERATED ALWAYS AS … STORED`. The migration would then either
conflict with the hand-written generated column or, worse, succeed on a fresh database and produce a
column that is silently never populated, so search returns nothing and nothing errors. Keeping the
column entirely out of `schema.prisma` and on the allowlist is the only shape that cannot go wrong.
Prisma Client never needs to read it; it is an index input, and queries against it go through
`$queryRaw` in one repository method.

**[ADDED] The alternative worth knowing about.** If the allowlist grows past a handful of entries,
the industry answer is to stop fighting the diff and put a real schema-management tool in front of
it — Prisma's own blog documents using **Atlas** alongside Prisma ORM precisely because *"Prisma
Migrate does not provide automatic migration planning for views, stored procedures, triggers,
row-level security and more."* We are not adopting Atlas in M1 (one more tool, one more CI step),
but the trigger for adopting it is now written down: **more than ~10 allowlist entries, or the first
time a drift-allowlisted object is silently dropped in production.**

### 9.5 [ADDED] Thai collation — every `ORDER BY` on Thai text in the draft was wrong

The draft never mentioned collation. PostgreSQL's default for a database created with
`LC_COLLATE=C` (the common container default, and what `postgres:18.4-bookworm` gives you unless you
say otherwise) sorts by **byte value**. For Thai that produces an ordering no Thai reader recognises,
because of one specific property of the script: **the five leading vowels เ แ โ ใ ไ (U+0E40–U+0E44)
are written *before* the consonant they are pronounced after.** So `เก` is stored as
`<U+0E40, U+0E01>` but collates, in Thai dictionary order, as if it were `ก` followed by the vowel.
A byte sort puts every word beginning with a leading vowel into one block far from its true position,
so a template picker sorted by `name_th`, a reviewer worklist sorted by an extracted `full_name_th`,
or a CSV export sorted by merchant name all come out visibly scrambled to a Thai user. Combining
marks (tone marks U+0E48–U+0E4B, vowel signs) must also be ignored at the primary strength, which a
byte sort does not do either.

**Decision.** Create the database with an **ICU** default collation and give every Thai-sortable
column an explicit ICU collation, so the ordering does not depend on how the instance was
provisioned:

```sql
-- Preferred: set it once for the database at create time (bootstrap, not a Prisma migration).
CREATE DATABASE innovera_ocr
  LOCALE_PROVIDER icu ICU_LOCALE 'th-TH' TEMPLATE template0 ENCODING 'UTF8';

-- Belt and braces: pin it per column, so a database provisioned wrongly still sorts correctly.
CREATE COLLATION IF NOT EXISTS th_icu (provider = icu, locale = 'th-TH');

ALTER TABLE extraction_templates   ALTER COLUMN name_th    TYPE varchar(200)  COLLATE th_icu;
ALTER TABLE extraction_fields      ALTER COLUMN label_th   TYPE varchar(200)  COLLATE th_icu;
ALTER TABLE extraction_field_values ALTER COLUMN value_text TYPE varchar(4000) COLLATE th_icu;
ALTER TABLE documents              ALTER COLUMN original_filename TYPE varchar(400) COLLATE th_icu;
```

**Four consequences that must be understood before this is applied, not after:**

1. **Changing a column's collation rewrites every index on it.** Do it in migration 0003–0006 while
   the tables are empty. Retrofitting later is a `REINDEX` of the whole table.
2. **ICU collation is not deterministic-safe for equality-heavy columns.** `th-TH` at default
   strength is still a *deterministic* collation in PostgreSQL terms (equal only if byte-equal), so
   unique indexes and `=` behave normally. Do **not** be tempted to add
   `deterministic = false` for accent-insensitive matching on these columns — a non-deterministic
   collation forbids `LIKE`, pattern matching and `pg_trgm` on the column, which would silently
   disable §9.2's fallback.
3. **Do not collate `search_tokens`, `plain_text`, `value_key` or any hash/id column.** They are
   matched, not ordered; ICU on them costs comparison time and buys nothing. `value_key` in
   particular is an exact-match index key and must stay on the default collation so its btree is
   plain memcmp.
4. **`ORDER BY` in the application must not re-sort.** If the API returns rows ordered by PostgreSQL
   and the Next.js layer then calls `Array.prototype.sort()` or `localeCompare()`, the two orderings
   will disagree at page boundaries and pagination will duplicate or skip rows. Sorting is the
   database's job for any column that is also a pagination key; add an ESLint rule against
   `localeCompare` in `src/app/**`.

**Verification, because this is easy to believe and hard to notice:** an integration test asserting
`SELECT name FROM (VALUES ('ไก่'),('กา'),('เก้า'),('ขาย')) t(name) ORDER BY name COLLATE th_icu`
returns Thai dictionary order (`กา, เก้า, ขาย, ไก่`) rather than codepoint order
(`กา, ขาย, เก้า, ไก่`). If the two orders happen to coincide for your sample, the sample is wrong,
not the collation.

### 9.6 [ADDED] Thai numerals — where ๐-๙ break, and the two-stream fix

Thai digits `๐๑๒๓๔๕๖๗๘๙` (U+0E50–U+0E59) appear routinely on government forms, older tax invoices,
official letterheads and ID cards. The draft used them in its own §9.3 example (`๐๐๑๒๓`) and then
never said what happens to them — which means, as written, a user who types `00123` into the search
box or into an invoice-number filter gets nothing, and an invoice whose total is `๑,๒๓๔.๕๖` produces
`valueNumber = NULL`.

Four places they must be handled, each a different mechanism:

| Where | Problem | Resolution |
|---|---|---|
| **Search** | `to_tsvector('simple','๐๐๑๒๓')` and `to_tsvector('simple','00123')` are different lexemes | Digit-fold into the **sub-word stream** (§9.3): `searchTokensSubword` contains **both** the original `๐๐๑๒๓` and the folded `00123`. Both spellings then hit. `searchTokens` keeps the original only, so ranking is not distorted. |
| **`valueNumber` / `valueMinor`** | `parseFloat('๑๒๓')` is `NaN`; so is `Number()` | Fold to ASCII **before** parsing. `Intl.NumberFormat` with `th-TH-u-nu-thai` can format but does not parse; the fold is a 10-entry codepoint map, and writing it by hand is correct here — `String.prototype.replace(/[๐-๙]/g, d => String(d.charCodeAt(0) - 0x0E50))`. |
| **`valueDate`** | `๓๑/๑๒/๒๕๖๙` — Thai digits *and* Buddhist Era (§9.7) | Fold digits first, then apply §9.7. Order matters: era detection needs a numeric year. |
| **`valueKey`** (exact cross-document match) | two documents spelling the same tax id in different digit systems would not join | `valueKey` is **always ASCII-folded**, so `๐๑๐๕๕๕๘xxxxxx` and `0105558xxxxxx` are one key. |

`DocumentPage.digitPolicy` and `ExtractionFieldValue.thaiDigitPolicy` record which of `PRESERVE` /
`FOLD_TO_ASCII` / `BOTH` was applied, so a value can always be traced back to what the page actually
said. **`valueTextRaw` always holds the unfolded original** — never show a reviewer the folded form
and ask them to confirm it; they would be confirming our transformation, not the document.

**Do not fold in the OCR layer.** `OcrResult.rawText` is evidence and stays byte-exact (§5.6);
`normalizedText` applies Unicode normalisation only (§9.8); digit folding happens at the
*projection* boundary — `DocumentPage.searchTokensSubword` and `ExtractionFieldValue` — which is the
same layering rule as everywhere else in this document.

### 9.7 [ADDED] Buddhist Era dates — the single most likely wrong answer this product will give

Thai official documents date in **พุทธศักราช (Buddhist Era)**, which is **CE + 543**. A Thai tax
invoice dated `31/12/2569` means **31 December 2026**, not 2569. The draft has
`valueDate DateTime? @db.Date`, an `invoice_date (DATE)` field in the `thai-tax-invoice` starter
template (§10.3), and a `field_value_org_field_date_idx` for "invoices dated in Q3" — and says
nothing about era. Left as-is, every Thai-dated document lands 543 years in the future, every date
range filter returns nothing, and every retention calculation based on document date is wrong.

**Decision: `valueDate` is ALWAYS Common Era. Conversion happens once, at extraction, and both the
source era and the source string are recorded.**

```
DateEra  detectEra(yearNumber, contextHints):
  yearNumber >= 2400 and <= 2600   -> BE      // 1857..2057 CE — covers every realistic document
  yearNumber >= 1900 and <= 2100   -> CE
  yearNumber <= 99                 -> UNKNOWN // two-digit year: see the trap below
  otherwise                        -> UNKNOWN

valueDate = (era == BE) ? gregorian(year - 543, month, day) : gregorian(year, month, day)
dateEra   = era
valueTextRaw = the exact source substring, e.g. "๓๑/๑๒/๒๕๖๙"
```

**The trap, and why `UNKNOWN` is a real state rather than a cop-out.** A two-digit year — `31/12/69`
— is genuinely ambiguous: `69` is 2569 BE (= 2026 CE) on a Thai form and 1969 or 2069 CE on an
international one. There is no rule that resolves this from the string. The design consequence is
that `dateEra = UNKNOWN` must be **surfaced to the reviewer**, not silently guessed: the review form
shows the raw string, both candidate interpretations, and requires a choice, and
`ExtractionField.required` fields with `dateEra = UNKNOWN` block `READY_FOR_REVIEW → COMPLETED`.
Guessing here is how a product quietly mis-files a year of invoices.

**Two supporting rules:**

- **Thai month names must be parsed, not just numerals.** `๓๑ ธันวาคม ๒๕๖๙` and its abbreviation
  `๓๑ ธ.ค. ๖๙` are at least as common as the slash form on printed invoices. The month table
  (ม.ค. … ธ.ค.) belongs in the extraction layer; it is named here because `FieldDataType.DATE`
  implies it and the draft's template definition did not.
- **Do not use `DateTime` (`timestamptz`) for a document date.** `valueDate` is correctly
  `@db.Date`: an invoice date is a calendar date on a piece of paper, not an instant. Storing it as
  `timestamptz` would drag it through `Asia/Bangkok` ↔ UTC and shift it by a day for anyone querying
  from another zone. The draft got this right; it is recorded so nobody "fixes" it.
  The converse also holds: `createdAt`/`occurredAt` are instants and stay `@db.Timestamptz(3)`.

### 9.8 [ADDED] Thai Unicode normalisation — NFC alone is not enough, and the draft assumed it was

The draft says `DocumentPage.plainText` is "canonical NFC text" and `OcrResult.normalizedText` is
"NFC + Thai normalisation", without saying what the second half is. NFC alone does **not** canonicalise
Thai, for a reason specific to the script's combining-class assignments:

- Thai combining marks do **not** all have distinct canonical combining classes. `U+0E31` (MAI HAN
  AKAT), `U+0E34`–`U+0E37` (SARA I … SARA UEE), `U+0E47` (MAITAIKHU) and `U+0E4D` (NIKHAHIT) all
  have **ccc = 0**, while the tone marks `U+0E48`–`U+0E4B` have ccc = 107 and `U+0E38`/`U+0E39`
  have ccc = 103. Unicode canonical reordering only reorders marks with *different, non-zero*
  classes. Consequently a vowel-above followed by a tone mark and the same pair in the opposite order
  are **not** unified by NFC: `ก + ◌ิ + ◌่` and `ก + ◌่ + ◌ิ` render near-identically, compare
  unequal, hash differently, and tokenise differently. Both orders occur in real OCR output and in
  real user input.
- `U+0E33` (SARA AM) *does* have a canonical decomposition to `U+0E4D U+0E32`, so NFD splits it and
  NFC recomposes it — but only when it is adjacent. With an intervening tone mark the round trip is
  not stable, which is the classic Thai "สำ vs สํา" bug.
- OCR engines differ: some emit the WTT 2.0 storage order, some emit visual order, some emit
  `U+0E4D U+0E32` where the page shows `U+0E33`.

**Decision: a named, versioned Thai normalisation function, applied at exactly one boundary.**

```
thaiNormalize(s) =
  1. NFC(s)                                        -- Unicode canonical composition
  2. reorderThaiMarks(s)                           -- enforce WTT 2.0 storage order within each
                                                   --   consonant cluster: base, upper-vowel,
                                                   --   tone, above-diacritic
  3. collapseDuplicateMarks(s)                     -- two identical tone marks on one base -> one
  4. composeSaraAm(s)                              -- U+0E4D U+0E32 -> U+0E33, tone-mark aware
  5. stripInvisibles(s)                            -- U+200B ZWSP, U+00A0 NBSP -> U+0020,
                                                   --   U+0E4F/U+0E5A/U+0E5B kept (real punctuation)
```

Step 5 matters more than it looks: **U+200B ZERO WIDTH SPACE is the traditional Thai soft word
break** and appears in text copied out of Thai PDFs and Word documents. Left in, it is invisible,
splits a token in the middle, and makes `ภาษี` fail to match `ภา<ZWSP>ษี`. Stripped at
normalisation, it never reaches the tokeniser.

**Where it is applied, and where it is forbidden:**

| Column | Normalised? |
|---|---|
| `OcrResult.rawText` | **No, never.** Byte-exact engine output. This is the evidence K-8 protects. |
| `OcrResult.normalizedText` | Yes — `thaiNormalize(rawText)` |
| `DocumentPage.plainText` | Yes — the canonical projection |
| `DocumentPage.plainTextRaw` | **No** — the pre-normalisation projection, kept so a normalisation bug is diagnosable without re-running OCR |
| `searchTokens` / `searchTokensSubword` | Yes, and the **query string is normalised with the identical function and version** — a mismatch here is the same failure mode as a tokeniser mismatch (§9.3) |
| `ExtractionFieldValue.valueText` / `valueKey` | Yes |
| `ExtractionFieldValue.valueTextRaw` | **No** |
| `Document.originalFilename` | **No** — stored exactly as uploaded |
| `Document.originalFilenameNfc` | Yes — the normalised copy, used for display sorting and duplicate-name detection |

`DocumentPage.normalizerVersion` records which version produced the row, so a normaliser change is a
**reindex trigger**, exactly like the tokeniser version in §12.1 risk 4. Bumping it without
reprocessing silently splits the corpus into two incompatible halves.

**Why `originalFilename` needs the second column.** macOS submits filenames in a **decomposed**
(NFD-like) form and Windows/Linux in NFC. The same Thai filename uploaded from a Mac and from a PC
is two different byte strings: they sort apart, they compare unequal, and "you already uploaded a
file with this name" fails to fire. Storing the raw name preserves what the user sent; storing the
normalised name makes comparison work. Both columns are `@db.VarChar(400)` — note that PostgreSQL
`varchar(n)` counts **characters, not bytes**, so 400 is 400 Thai characters (up to 1 200 UTF-8
bytes), which is the intent and is worth stating because the §6.1 size math is in bytes and the two
are easy to conflate.

**None of this is optional for a Thai-first product**, and none of it is expressible in
`schema.prisma` — it is application code plus two extra columns. The columns are the part that must
ship in M1, for the same backfill reason as `searchTokens`.

---

## 10. K-6 and K-11 — JSON policy, migrations, seeds

### 10.1 JSONB vs typed columns

**The rule:**

> A value may be JSONB only if it is **(a)** written once, **(b)** read whole, **(c)** never a
> `WHERE`, `ORDER BY`, `JOIN` or `GROUP BY` target, and **(d)** size-bounded by a `CHECK`.
> Anything that fails even one clause is relational.

| Column | Verdict | Why |
|---|---|---|
| `OcrResult.linesJson` | **JSONB** | Written once by the worker, read whole to draw the overlay. We never query *inside* it. ~26 KB, capped. |
| `DocumentAnalysis.resultJson` | **JSONB**, *plus* projection | The model's raw structured output is evidence and stays intact. But every field we filter on is **promoted into `ExtractionFieldValue` rows** in the same transaction. Filtering `resultJson->>'invoice_total' > '50000'` would be a text comparison over an unindexed path — wrong answers *and* a sequential scan. |
| `AuditLog.metadata` | **JSONB**, allowlisted + `CHECK (pg_column_size(metadata) <= 4096)` | Bounded, read whole. |
| `Document.sourceMetadata` | **JSONB** | Caller-supplied passthrough, echoed back verbatim. Capped at 8 KB. |
| `ExtractionJob.requirements` | **JSONB** | The `OcrRequest.require` object from `d-ocr` §9.2, read whole by the worker. |
| `ExtractionFieldValue.quadJson` | **JSONB** | Eight numbers, rendered not queried. |
| **Template field definitions** | **relational** (`ExtractionField`) — *not* JSON on the template | We join values to definitions, need FK integrity on `fieldId`, need per-field ordering and per-field `isSensitive` for redaction. A JSON blob gives none of those. |
| **Extracted field values** | **relational** (`ExtractionFieldValue`) | The core query — "every document where field X is Y" — is a `WHERE` and a `JOIN`. Not negotiable. |
| **Job status / attempts / lease** | **relational** | The claim query sorts and filters on them, under `FOR UPDATE SKIP LOCKED`. |
| **Scan verdict** | **relational** | A security gate: it must be a `CHECK`-able enum and a trigger predicate, not a JSON path. |
| `ExtractionFieldValue.valueJson` | **JSONB**, narrow use | Only for a genuinely structured field (a line-items table). Scalar fields use the typed columns. |

The one non-obvious call is `DocumentAnalysis.resultJson`. Keeping the raw model output **and**
projecting into typed rows looks like duplication. It is not: the JSON is *evidence* (what the model
actually said, replayable against `PromptVersion`), the rows are *data* (what the product believes,
correctable by a human). They have different lifecycles, different mutability, and different
consumers. Collapsing them loses the audit trail; that is the whole point of `d-ocr` §9.3's insistence
that `rawText` stay separate from `text`, applied one layer up.

### 10.2 Migration strategy

**Hand-written SQL, exactly as jawbong does it.** The evidence:
`prisma/migrations/20260803000000_phase_00_foundation/migration.sql` contains
`CONSTRAINT "outbox_attempts_nonnegative" CHECK ("attempts" >= 0)`, which appears nowhere in
`schema.prisma`; and `package.json` has `prisma migrate deploy` and `prisma generate` but **no**
`prisma migrate dev`.

The workflow:

```bash
# 1. Edit prisma/schema.prisma.
# 2. Generate a DRAFT (never applied directly):
corepack pnpm@11.18.0 exec prisma migrate diff \
  --from-migrations   prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --script > /tmp/draft.sql

# 3. Hand-edit into prisma/migrations/<UTC>_<name>/migration.sql, adding what Prisma cannot express:
#      CREATE EXTENSION, CHECK constraints, triggers + functions, RLS policies, GRANT/REVOKE,
#      SET COMPRESSION lz4, CREATE INDEX CONCURRENTLY (in its own migration), partitioning.
# 4. Apply:
corepack pnpm@11.18.0 exec prisma migrate deploy

# 5. CI drift gate — exits 2 if the applied migrations no longer describe the datamodel:
corepack pnpm@11.18.0 exec prisma migrate diff \
  --from-migrations   prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --exit-code
```

**`prisma migrate dev` is banned.** It rewrites migration SQL from the datamodel, which silently
deletes every trigger, policy, `GRANT` and `CHECK` in the file. Enforce with a `predev` npm script
that fails, and a note in `CLAUDE.md`.

**The rule that makes all of this hold together:**

> **Triggers, functions, `CHECK` constraints, `GRANT`/`REVOKE`, RLS policies and `SET COMPRESSION`
> are invisible to `prisma migrate diff`. Indexes, columns, tables, enums and foreign keys are
> visible and must be declared in `schema.prisma`.**

Everything in §4.3, §8.1 and §3.4 sits on the invisible side by construction — that is *why* those
constraints are triggers rather than lookup tables or partial indexes. The only two exceptions are
the M4 search indexes (§9.4), which go on an explicit, reviewed drift allowlist.

**[REVISED — was flatly `UNVERIFIED`; now supported by a primary source, still worth the 10-minute
empirical check.]** Prisma's own engineering blog, introducing Atlas as a companion tool, states the
limitation directly: *Prisma Migrate does not provide automatic migration planning for views, stored
procedures, triggers, row-level security and more.* That is Prisma describing its own scope, and it
is the strongest available confirmation short of running it. Combined with the mechanism — the diff
engine compares the **Prisma datamodel** against an introspected shadow database, and Prisma's
introspection reads tables, columns, indexes, foreign keys and enums but has no representation for a
trigger, a policy, a `GRANT` or a `CHECK` — the invisibility claim is sound. Jawbong's undeclared
`CHECK` surviving with no reported drift is a third, weaker corroboration.

**Still verify in the first 10 minutes of M1**, because "almost certainly" is not "measured": apply
migrations 0001–0010, run the step-5 command, confirm exit code 0. If any of them *is* visible, the
fallback is a second migration directory (`prisma/migrations-post/`) applied by
`prisma db execute --file` after `migrate deploy`, which the diff never reads.

**[ADDED] The asymmetry that actually bites, and it is not the one the draft worried about.** The
risk is not that Prisma *reports* a trigger as drift — it will not. The risk is the opposite:
because Prisma cannot see these objects, **`prisma migrate diff` will also never warn you that a
migration you are about to apply drops one.** A `DROP TABLE`/`CREATE TABLE` pair emitted by the diff
for a column type change silently takes every trigger, policy and grant on that table with it, and
the drift gate then reports a clean exit code because the datamodel matches. The mitigation is a
**post-deploy assertion migration** that is not optional:

```sql
-- Runs last in every deploy. Cheap, and it is the only thing standing between us and a silently
-- unprotected append-only table.
DO $$
DECLARE expected text[] := ARRAY[
  'ocr_results_no_update','corrections_no_update','document_analyses_no_update',
  'job_events_no_update','scan_results_no_update','audit_logs_no_update',
  'ocr_results_guarded_delete','corrections_guarded_delete','document_analyses_guarded_delete',
  'job_events_guarded_delete','scan_results_guarded_delete','audit_logs_guarded_delete',
  'document_00_status_transition_guard','document_10_scan_gate',
  'extraction_template_freeze','extraction_field_value_append_only'];
  missing text;
BEGIN
  SELECT string_agg(e, ', ') INTO missing
    FROM unnest(expected) e
   WHERE NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = e AND NOT tgisinternal);
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'MISSING_TRIGGERS: %', missing; END IF;

  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relkind = 'r'
                AND c.relname IN (SELECT unnest(ARRAY['documents','document_pages','ocr_results',
                     'extraction_jobs','job_events','document_analyses','extraction_templates',
                     'extraction_fields','extraction_field_values','corrections','audit_logs',
                     'api_keys','quotas','usage_counters','storage_objects','scan_results',
                     'memberships','organizations']))
                AND NOT (c.relrowsecurity AND c.relforcerowsecurity))
  THEN RAISE EXCEPTION 'RLS_NOT_ENABLED_OR_NOT_FORCED on at least one tenant table'; END IF;
END $$;
```

This is the same list the integration test in §3.4 uses, and it must be generated from one source —
a single `tenant-tables.ts` exported to both the test and the migration generator — or the two will
drift, which is the failure this whole section exists to prevent.

**Migration ordering for M1** (each is a separate directory so a failure is isolable):

| # | Directory | Contents |
|---|---|---|
| 0001 | `20260910000000_extensions_and_roles` | `CREATE EXTENSION pg_trgm`; create `ocr_app`, `ocr_queue`, `ocr_erasure`; base `GRANT`s |
| 0002 | `20260910000100_foundation_outbox` | `outbox_events`, `idempotency_records` — copied byte-for-byte from jawbong |
| 0003 | `20260910000200_tenancy` | `organizations`, `users`, `memberships`, `api_keys` |
| 0004 | `20260910000300_documents` | `storage_objects`, `scan_results`, `documents`, `document_pages` |
| 0005 | `20260910000400_pipeline` | `extraction_jobs`, `job_events`, `ocr_results` |
| 0006 | `20260910000500_intelligence` | `prompt_versions`, `document_analyses`, `extraction_templates`, `extraction_fields`, `extraction_field_values`, `corrections` |
| 0007 | `20260910000600_governance` | `audit_logs`, `quotas`, `usage_counters` |
| 0008 | `20260910000700_constraints_and_triggers` | every trigger/function/CHECK from §4.3 and §8.1 |
| 0009 | `20260910000800_rls` | `ENABLE`/`FORCE ROW LEVEL SECURITY` + one policy per tenant table, **each with an explicit `TO` role** (§3.4) |
| 0010 | `20260910000900_compression` | `SET COMPRESSION lz4` on the six text/JSON columns |
| 0011 | `20260910001000_collation` | **[ADDED]** `CREATE COLLATION th_icu` + per-column `COLLATE` (§9.5). Separate directory because it rewrites indexes and must be applied while tables are empty. |
| 0012 | `20260910001100_assertions` | **[ADDED]** the post-deploy `DO $$ … $$` assertion block above. Runs last, every deploy. |

**[ADDED] Migration 0000 is not a migration.** Role creation (`ocr_app`, `ocr_queue`, `ocr_erasure`)
and `CREATE DATABASE … ICU_LOCALE 'th-TH'` cannot live in a Prisma migration: `migrate deploy` speaks
the wire protocol so psql's `:'var'` interpolation does not exist, `CREATE ROLE` needs privileges the
migration role will not have on managed PostgreSQL, and `CREATE DATABASE` cannot run inside a
transaction block. They belong in `scripts/bootstrap-database.sh`, run once per environment by an
operator, and migration 0001 asserts their existence and fails loudly if the bootstrap was skipped.
The draft's migration 0001 contained `CREATE ROLE ocr_app LOGIN PASSWORD :'app_password'`, which
would have failed at deploy time with a syntax error on the `:` — a five-minute failure, but one
that would have happened on the first deploy of every environment.

Migrations are **additive only**, matching jawbong's stated rule. A column is deprecated by being
made nullable and stopping writes; it is dropped in a later, separate, explicitly-approved migration.

### 10.3 Seed strategy

`prisma/seed.ts`, invoked by `prisma.config.ts`'s `migrations.seed`, guarded by
`assertDisposableDatabaseUrl` — copied from
`/Users/innovera/Documents/jawbong/src/lib/db/database-safety.ts` with the allowlist retargeted to
`innovera_ocr_test` / `innovera_ocr_test`. **This is not optional**: the guard is what stops a seed
from ever touching a real database, and it fails closed on host, port, user, database, `APP_ENV`,
`NODE_ENV` and `DATABASE_SCOPE`.

Seeds are **deterministic** and **idempotent** (`upsert`, fixed literal UUIDs, fixed timestamps),
exactly like jawbong's:

```ts
const SEED_ORG   = "00000000-0000-7000-8000-000000000001";
const SEED_OWNER = "00000000-0000-7000-8000-000000000002";
```

Note the `7` in position 13 — the seed UUIDs are shaped as v7 so nothing downstream that assumes a
version nibble is surprised. (Jawbong uses `4`, matching its `randomUUID()`.)

Contents:
1. One `Organization` (`innovera-demo`) and one `User` with `OWNER` membership.
2. The **three starter `ExtractionTemplate`s with their `ExtractionField`s**, published:
   - `thai-tax-invoice` — ใบกำกับภาษี: `seller_tax_id` (`TAX_ID`), `buyer_tax_id`, `invoice_number`,
     `invoice_date` (`DATE`), `subtotal`/`vat_amount`/`grand_total` (`MONEY`, THB satang),
     `line_items` (JSON).
   - `thai-national-id` — บัตรประชาชน: `id_number` (`THAI_NATIONAL_ID`, `isSensitive = true`),
     `full_name_th`, `full_name_en`, `date_of_birth`, `date_of_issue`, `date_of_expiry`.
   - `generic-receipt` — ใบเสร็จ: `merchant_name`, `receipt_date`, `total` (`MONEY`).
3. One `PromptVersion` per template, `publishedAt` set, with the exact JSON response schema.
   **[REVISED] `modelId` is read from `SEED_AI_MODEL_ID` and the seed FAILS if it is unset.** It is
   not defaulted and no model name is hard-coded, because the INNOVERA gateway's served model list is
   unresolved (§12.2b) and a seeded literal would turn a guess into a committed artefact that then
   propagates into every developer's database and every test fixture. Failing loudly is the correct
   behaviour for an unknown: `assertEnv("SEED_AI_MODEL_ID")`, in the same style as
   `assertDisposableDatabaseUrl`.
4. Three `Quota` rows for the demo org.
5. One **revoked** `ApiKey` fixture, so the revocation path has a test subject.
6. **Zero `Document`s, zero `OcrResult`s, zero PII.** Realistic Thai document fixtures belong in
   `tests/fixtures/`, are synthetic, and are generated — never a real customer document, and never
   committed as a real scan.

---

## 11. Growth projections

**All numbers below rest on assumptions nobody has confirmed.** They exist so the design can be
falsified, not because they are known. Assumed: 50 organizations, 500 active users,
**20 000 documents/month at a mean of 6 pages** = 120 000 pages/month.

### Rows

| Table | Rows/month | Year 1 | Driver |
|---|---|---|---|
| `documents` | 20 000 | 240 000 | the assumption |
| `document_pages` | 120 000 | 1 440 000 | × 6 pages |
| `ocr_results` | ~130 000 | 1 560 000 | 1/page + ~8 % fallback re-runs |
| `extraction_jobs` | ~64 000 | 768 000 | ~3.2 jobs/document incl. retries |
| `job_events` | ~320 000 | 3 840 000 | ~5 events/job |
| `extraction_field_values` | ~320 000 | 3 840 000 | 15 fields/doc + corrections |
| `corrections` | ~40 000 | 480 000 | ~2/document |
| `audit_logs` | ~200 000 | 2 400 000 | 8/document + user activity |
| `document_analyses` | ~22 000 | 264 000 | ~1.1/document |
| `storage_objects` | ~140 000 | 1 680 000 | 1 original + 6 renders per doc |
| `usage_counters` | ~10 500 | 126 000 | 50 orgs × 7 metrics × 30 days |

Largest table at 12 months: `job_events` and `extraction_field_values` at ~3.8 M rows. **Trivial for
a single PostgreSQL instance.** Nothing here needs sharding, read replicas or partitioning in year
one. **[REVISED]** The draft added "`audit_logs` crosses the partitioning threshold (~50 M) around
year 20" — that is wrong: with the 400-day retention of §8.3 the table is *bounded* at
`200 000 × 13.2 ≈ 2.6 M rows` and never approaches 50 M at all. The corrected reasoning for
deferring partitioning is in §8.3.

**[ADDED] Two rows the draft's table omitted, both of which change the "largest table" answer if the
assumptions move:**

| Table | Rows/month | Year 1 | Driver |
|---|---|---|---|
| `scan_results` | ~20 000 | 240 000 | 1 per original; more when signatures update and blobs are re-scanned |
| `audit_export_manifest` | ~50 | 600 | 50 orgs × 1 monthly export (§8.3) |
| *(not created — see §5.9)* `document_blocks` | *(22–58 M)* | *(would be the largest table by 6×)* | the reason K-13 defers it |

### Storage

| | Per month | Year 1 | Notes |
|---|---|---|---|
| PostgreSQL — `ocr_results` text + JSON | ~4.3 GB raw | ~51 GB raw → **~17–20 GB with lz4** | the dominant PG line |
| PostgreSQL — `document_pages` text + tokens | ~3.5 GB raw | ~42 GB raw → **~15 GB with lz4** | **[REVISED]** was 2.3 GB/28 GB/10 GB. Two columns added in review: `search_tokens_subword` (§9.3, ~+8.3 KB/page) and `plain_text_raw` (§9.8, ~+7.2 KB/page). Per page: 7.2 (plain) + 7.2 (raw) + 8.3 (tokens) + 8.3 (subword) ≈ 31 KB × 120 000 pages = 3.7 GB/month. |
| PostgreSQL — everything else + indexes | — | **~12–18 GB** | ~30 % index overhead |
| **PostgreSQL total** | — | **≈ 45–55 GB** | **[REVISED]** +5 GB for the two added columns. Still one modest instance; a nightly `pg_dump` is still practical |
| Object storage — originals | 24 GB | **288 GB** | 1.2 MB mean |
| Object storage — page renders | **54 GB** | **648 GB** | **the biggest line in the whole system** |
| Object storage — engine payloads | 4 GB | 48 GB | |
| **Object storage total, naive** | — | **≈ 984 GB** | |
| **Object storage with a 30-day render TTL** | — | **≈ 390 GB** | renders regenerated on demand |

**The single highest-leverage storage decision is the render TTL** — it removes ~600 GB/year for the
cost of re-rasterising a page when someone opens a document older than 30 days. That is why
`StorageObject.expiresAt` and `storage_object_expires_idx` exist in the M1 schema rather than being
added later.

**What would change all of this:** any of (a) mean pages/document above ~15, (b) documents/month
above ~100 000, (c) a requirement to retain page renders indefinitely. Each pushes object storage
past ~3 TB/year and makes lifecycle policy a first-class design problem rather than one column.

---

## 12. Risks, and what is not resolved

### 12.1 Design risks

1. **RLS is only as good as the wrapper.** If any code path reaches the raw `PrismaClient` instead of
   the scoped runner, it gets zero rows (safe) — but a developer will "fix" that by using the raw
   client and adding a manual `where`. Mitigation: the raw client is exported from exactly one module
   and `dependency-cruiser` forbids importing it outside `src/modules/*/infrastructure/`. Add an
   ESLint `no-restricted-imports` rule too.
2. ~~**The composite-FK trick may hit a Prisma limitation** when a child has two parents (§3.3).~~
   **[RESOLVED in review]** Prisma supports composite foreign keys and permits one scalar field to
   participate in several relations when the relations are disambiguated with `@relation(name:)`.
   The `BEFORE INSERT` fallback is withdrawn. The residual risk moved elsewhere: the composite FK on
   `DocumentPage.canonicalOcrResult` cannot use `onDelete: SetNull` (it would null the `NOT NULL`
   tenancy column), so that relation is `NoAction` and the pointer is cleared in application code —
   see §5.4.
3. **Per-page rows scale linearly with page count.** A 5 000-page document produces 5 000 rows and
   ~250 MB of text. Mitigation: a hard `pageCount` cap per document (default 2 000), enforced in
   `VALIDATING`, with a `FAILED` transition and a specific `failureCode`.
4. **The tokenised-search plan depends on `newmm` being deterministic across versions.** If PyThaiNLP
   changes its dictionary, index-time and query-time segmentation diverge and recall silently drops.
   Mitigation: pin the tokeniser version, record it per page, and treat a version bump as a reindex.
5. **`job_events` is the fastest-growing table and has the least value per row.** 90-day retention
   from day one, not "later".
6. **Four database roles is real operational complexity.** Four connection strings, four secrets,
   four rotation procedures. The alternative is one role and materially weaker guarantees. Named here
   so it is a chosen cost, not a surprise. **[ADDED]** It is also four connection *pools*, which
   interacts with §3.4 point 6: budget `pg_max_connections` across all four, not just `ocr_app`.
7. **[ADDED] The erasure window (§8.1) is a GUC, and a GUC is only as good as the code that sets it.**
   Any code path that sets `app.erasure_window = 'on'` can delete evidence. Mitigations: it is set in
   exactly one function, that function is only reachable from the purge job, `ocr_app` has no
   `DELETE` grant so the GUC alone is insufficient, and setting it emits an `AuditLog` row. Two
   independent controls (privilege *and* window) is the point; neither alone is enough.
8. **[ADDED] Every Thai correctness decision in §9.5–§9.8 is currently unmeasured.** The collation
   test, the normalisation function, the sub-word recall claim and the BE-detection ranges are
   reasoned from the script's properties, not from this product's corpus. The M2 benchmark must
   include a Thai normalisation/segmentation fixture set, or these become folklore in the codebase.
9. **[ADDED] `interactive transaction per request` (§3.4) is a throughput ceiling nobody has load
   tested.** `max: 5` is jawbong's setting for a different workload. This is the most likely source
   of a "the app is slow and nothing in the logs is slow" incident in M2.

### 12.2 What I could not verify

- No PostgreSQL instance exists for this project; **nothing in this document has been executed.**
  Every SQL snippet is written, not run. This remains true after the review pass.
- Whether `prisma migrate diff` ignores triggers, functions, `CHECK` constraints, `GRANT`s and
  `PARTITION BY` (§10.2, §8.3). **Upgraded in review** from "no documentation either way" to
  "confirmed by Prisma's own blog, which states Prisma Migrate does not plan migrations for views,
  stored procedures, triggers or row-level security" — but still not measured on our schema. Still a
  10-minute check, and §10.2 now also names the *inverse* risk (a diff-emitted table rewrite silently
  dropping triggers) with a post-deploy assertion migration to catch it.
- ~~Whether Prisma permits reusing `organizationId` across two relations on one model (§3.3).~~
  **RESOLVED in review** — it does, with `@relation(name:)` disambiguation; composite FKs referencing
  a compound `@@unique` are supported.
- ~~`pg_trgm`'s exact behaviour on Thai multibyte input (§9.2) — the docs are silent.~~
  **RESOLVED in review** from the implementation: multibyte trigrams are CRC32-hashed to 3 bytes,
  producing collisions, index false positives and degraded selectivity on Thai. The user
  documentation is indeed silent; the source is not.
- ~~`uuid@14.0.2` version and licence.~~ **VERIFIED in review** against
  `registry.npmjs.org/uuid/latest`: `14.0.2`, MIT, "RFC9562 UUIDs".
- ~~`default_toast_compression` remaining `pglz` through 18 with `lz4` landing in 19.~~
  **VERIFIED in review** against the PostgreSQL commit thread and secondary coverage.
- Whether `@default(dbgenerated("uuidv7()"))` fields remain settable in `create()` (§2). Avoided
  rather than resolved, by generating ids in the application. Unchanged.
- Whether the `PageCanonical` relation creates an FK ordering error on document delete (§5.4).
  **Sharpened in review:** `onDelete: SetNull` on a composite FK would null the `NOT NULL` tenancy
  column, so the relation is now `NoAction` and the pointer is cleared explicitly. The integration
  test is still required, and now also covers the erasure-window cascade (§8.1).
- Whether the `partialIndexes` preview flag is acceptable for M1 (§8.1). The feature is documented
  and PostgreSQL-supported, but it is a *preview* flag on a schema we intend to keep for years. The
  fallback (raw SQL + one allowlist entry) is designed; the choice is a policy call, not a technical
  one, and belongs to whoever owns the M1 dependency policy.
- Every workload number in §11, including the two rows added in review.
- All compression ratios in §6.3.
- **[ADDED]** Every Thai-specific threshold introduced in review: the `0.80` native-coverage gate and
  `0.20` Thai-script ratio (§4.2), the BE detection ranges `2400–2600` / `1900–2100` (§9.7), and the
  claim that sub-word segmentation recovers the recall lost to maxmatch compounds (§9.3). All are
  reasoned, none are measured. They are M2 benchmark items.
- **[ADDED]** That `newmm` exposes a usable shortest-match/`safe_mode` pass suitable for producing
  the sub-word stream (§9.3). The two-stream *design* is sound regardless; which PyThaiNLP call
  produces stream B is an M1 implementation detail that must be confirmed against the installed
  version, and `d-ocr-engine.md` owns it.

### 12.2b [ADDED] Fabrication check — what this document does NOT know

Stated explicitly because the schema touches the AI gateway and a schema is where an unverified
guess becomes permanent:

- **The INNOVERA AI gateway endpoint, its model list, and whether any served model is
  vision-capable are UNRESOLVED.** `b-ai-topology-discovery.md` items C/D/E are blocked on the owner;
  no LiteLLM/vLLM/Qwen configuration exists on this workstation and no endpoint or credential is
  recorded in any file readable in this session.
- Accordingly, **no model name appears anywhere in this schema as a value, default, or enum member.**
  The draft's `OcrEngineId.QWEN_VL_GATEWAY` did assert a model family and has been renamed to
  `GATEWAY_VLM` (§5.2). `DocumentAnalysis.modelId` and `modelServedName` are required-at-write
  runtime strings with no default, which is the correct place for a fact discovered at request time.
- `PromptVersion.modelId` likewise has no default. A seed that needed a model id would be a
  fabrication; §10.3's seed therefore creates `PromptVersion` rows with an explicitly parameterised
  `modelId` supplied from the environment, and the seed fails loudly if it is unset rather than
  inventing one.
- The **`AnalysisInputKind` / branch-T-vs-branch-V** table in §5.6 is the correct way to hold this
  open: the schema absorbs both outcomes with no column change, so resolving item E is a
  configuration decision and not a migration.

### 12.3 Cross-document inconsistency to resolve

`b-ai-topology-discovery.md` §2.2's diagram says **"PostgreSQL 16"**. Jawbong's verified
`docker-compose.test.yml` pins **`postgres:18.4-bookworm`**. This design assumes **18.x** and uses
two things 16 does not have: `uuidv7()` as an optional DB-side default (§2 — avoided anyway, so not
blocking) and `ALTER COLUMN ... SET COMPRESSION lz4` (PostgreSQL 14+, so **also fine on 16**).
**Net: nothing here actually requires 18**, which is a deliberate property — the design runs on 16
unchanged. But the two documents should be reconciled before M1, and the production major must be
pinned explicitly. Jawbong's own context file lists "managed PostgreSQL provider/major" as an open
question, so this is a known house gap, not a new one.

### 12.4 Open questions for the owner

1. **Expected document volume, mean page count, and peak burst.** Every number in §11 is a guess.
2. **Retention policy per tenant** — is `Organization.retentionDays` a real product feature or is one
   global policy enough? It changes whether the purge job is per-tenant.
3. **Is cross-tenant document sharing ever required?** Currently structurally impossible by design
   (§3.3). If a customer needs a partner portal, that is a `DocumentShare` table plus an RLS policy
   change — much cheaper to know now than after the FKs are live.
4. **Does the threat model include a database-read adversary** (stolen backup, compromised replica)?
   Determines whether the per-tenant HMAC fingerprint in §7.3 is adopted.
5. **Is the review workflow single-step approval, or multi-step with roles?** The current
   `READY_FOR_REVIEW → COMPLETED` edge assumes one approver. Multi-step needs a `ReviewAssignment`
   table.
6. **PDPA data-residency:** must Thai customer documents stay in `ap-southeast-1`?
   `Organization.dataRegion` exists as a placeholder but nothing enforces it.
7. **PostgreSQL major and provider** for production (see §12.3).
8. **[ADDED] Does the managed provider support ICU collations and `LOCALE_PROVIDER icu` at database
   creation?** (§9.5). If not, Thai sorting has to be done per-column with `CREATE COLLATION`, which
   works but must be applied before any data lands — so this is a *blocking* question for migration
   0011, not a later optimisation. Ask before choosing the provider, not after.
9. **[ADDED] Is `lz4` compiled into the production PostgreSQL build?** (§6.3). Migration 0010 fails
   loudly if not, which is the right failure — but it fails on the *first deploy of every
   environment*, so knowing in advance is cheap.
10. **[ADDED] Is the `partialIndexes` Prisma preview flag acceptable?** (§8.1, §12.2). It is the
    difference between a declared unique index and a raw-SQL one on the drift allowlist. Both work;
    the team's tolerance for preview flags decides.
11. **[ADDED] Billing/quota timezone per organization, or one global?** (§5.8). `Asia/Bangkok` is
    right for the expected customer base and wrong for the first non-Thai customer. One column now
    (`Organization.billingTimeZone`) or a data migration later.
12. **[ADDED] What is the legal retention floor for `audit_logs` under PDPA for this customer
    segment?** §8.3 chose 400 days on operational reasoning (a 12-month audit cycle plus slack), not
    on a cited legal requirement. If a regulator or a customer contract requires longer, the
    partitioning decision in §8.3 flips from "deferred indefinitely" to "needed", because the
    retention bound is what currently caps the table's size.
13. **[ADDED] Is a Thai-language corpus available for M2 calibration?** Everything in §9.5–§9.8 and
    the thresholds in §4.2 are unmeasured. Without a corpus they stay unmeasured through M2 as well,
    and the first real measurement becomes a customer's production data.

---

## 13. Decision summary

| ID | Decision | Rejected | Reversibility |
|---|---|---|---|
| K-1 | UUIDv7 PKs, app-generated (`uuid@14.0.2`), `@db.Uuid`, no `@default`; random 160-bit `publicId` on `Document` | `bigint` identity (cannot pre-generate), cuid2 (random + text + no native type), uuid v4 (index locality) | hard |
| K-2 | `Organization` tenancy + denormalised `organizationId` + composite FK `(parentId, organizationId)` | `userId`-only, schema-per-tenant, database-per-tenant | hard |
| K-3 | Typed app scoping + composite FK + RLS `FORCE`, four DB roles | RLS-only, app-only, `SET ROLE` per tenant | moderate |
| K-4 | 11 states incl. `QUARANTINED`; transitions enforced by trigger; retry re-enters only at `QUEUED` | Transition rules in prose; a `document_status_transitions` table (visible to diff) | moderate |
| K-5 | Per-page text + `linesJson` in PostgreSQL; blobs in object storage; >256 KB → object storage | One JSONB per document (250× read amplification), all text in object storage (no joins, extra failure mode) | moderate |
| K-6 | JSONB only when write-once, read-whole, never filtered, size-capped | Field values or job state in JSON | moderate |
| K-7 | Tenant-scoped content hashes; tenant-namespaced blob keys; no cross-tenant reuse; optional per-org HMAC fingerprint | Global content-addressed dedup (file-existence oracle + erasure hole) | easy |
| K-8 | Append-only evidence via trigger + `REVOKE`; a separate `ocr_erasure` role for lawful deletion | Application-only discipline; soft-delete columns on evidence tables | moderate |
| K-9 | Audit stores references only; 400-day hot retention; batched delete in M1, partitioning in M6 | Content/filenames/raw IPs in audit; per-row hash chain (serialises inserts) | easy |
| K-10 | Store `searchTokens` at ingest (M1); build the GIN index in M4 | `to_tsvector` on raw Thai (useless); PGroonga; an external search engine; shipping a 30 GB index before the UX exists | easy |
| K-11 | Hand-written SQL migrations, `migrate dev` banned, CI drift gate **plus a post-deploy trigger/RLS assertion migration**; deterministic guarded seed; roles and `CREATE DATABASE` in a bootstrap script, not a migration | Prisma-generated migrations (deletes triggers/policies/GRANTs); `CREATE ROLE … PASSWORD :'var'` inside a migration (psql-only syntax, would fail on deploy); relying on the drift gate alone (it is blind in both directions) | easy |
| K-12 | Thai semantics are schema-level: `thaiNormalize()` with a recorded `normalizerVersion`; two token streams (maxmatch + sub-word); ASCII digit folding into `valueKey`/`valueNumber`/stream B with `thaiDigitPolicy` recorded; ICU `th-TH` collation on Thai-sortable columns; `valueDate` always CE with `dateEra` + `valueTextRaw` retained | NFC alone (does not reorder same-ccc Thai marks, does not remove ZWSP); a single token stream (`ภาษี` returns nothing); byte collation (leading vowels sort wrongly); storing BE years as-is (every Thai date 543 years out); folding digits in the OCR layer (destroys evidence) | moderate |
| K-13 | No `DocumentBlock` in M1; block structure stays in `OcrResult.linesJson`, materialised later if layout-aware extraction is specified | A `document_blocks` table now — 22–58 M rows/year serving zero M1 `WHERE` clauses, populated by a heuristic the OCR contract does not emit | easy |

---

## 14. Sources

**Files read in this session** — see the table in §0 for the full list with what each established.
Principal ones:
`/Users/innovera/Documents/jawbong/prisma/schema.prisma`,
`/Users/innovera/Documents/jawbong/prisma/migrations/20260803000000_phase_00_foundation/migration.sql`,
`/Users/innovera/Documents/jawbong/prisma/seed.ts`,
`/Users/innovera/Documents/jawbong/prisma.config.ts`,
`/Users/innovera/Documents/jawbong/package.json`,
`/Users/innovera/Documents/jawbong/docker-compose.test.yml`,
`/Users/innovera/Documents/jawbong/src/modules/shared/infrastructure/prisma-client.ts`,
`/Users/innovera/Documents/jawbong/src/modules/outbox/infrastructure/prisma-outbox-repository.ts`,
`/Users/innovera/Documents/jawbong/src/modules/outbox/infrastructure/prisma-idempotency-repository.ts`,
`/Users/innovera/Documents/jawbong/src/lib/db/database-safety.ts`,
`/Users/innovera/Documents/jawbong/src/lib/auth/actor-context.ts`,
`/Users/innovera/Documents/jawbong/dependency-cruiser.config.mjs`,
`/Users/innovera/Documents/jawbong/process/context/all-context.md`,
`/Users/innovera/Documents/OCR/docs/architecture/m0/a-environment-and-stack.md`,
`/Users/innovera/Documents/OCR/docs/architecture/m0/b-ai-topology-discovery.md`,
`/Users/innovera/Documents/OCR/docs/architecture/m0/d-ocr-engine.md`.

**Web sources fetched or searched this session:**

- [PostgreSQL 18 Released](https://www.postgresql.org/about/news/postgresql-18-released-3142/) and [PostgreSQL 18.0 Release Notes](https://www.postgresql.org/docs/release/18.0/) — `uuidv7()`, `uuidv4()`, `uuid_extract_timestamp()`, `uuid_extract_version()`; the 12-bit sub-millisecond fraction
- [UUIDv7 Comes to PostgreSQL 18 — Nile](https://www.thenile.dev/blog/uuidv7) and [UUIDv7 in PostgreSQL 18 — DbVisualizer](https://www.dbvis.com/thetable/uuidv7-in-postgresql-18-what-you-need-to-know/) — monotonicity guarantee, remaining random bits
- [Prisma ORM v5.18.0 changelog](https://www.prisma.io/changelog/2024-08-08) — `@default(uuid(7))` added 2024-08-08
- [Prisma indexes documentation](https://www.prisma.io/docs/orm/prisma-schema/data-model/indexes) — `type: Gin` GA, `ops:` GA, `where:` behind the `partialIndexes` preview flag, and *"indexes using a function (such as `to_tsvector`) … are not yet supported"*
- [Prisma PostgreSQL extensions (v7)](https://www.prisma.io/docs/orm/v7/prisma-schema/postgresql-extensions) and [prisma/prisma#28530](https://github.com/prisma/prisma/issues/28530) — `postgresqlExtensions` **deprecated in v6.16.0**; customised migrations are the supported route
- [prisma/prisma#17516](https://github.com/prisma/prisma/issues/17516) — extension-provided operator classes (`gin_trgm_ops`) unsupported in `ops:`
- [Prisma CLI reference](https://www.prisma.io/docs/orm/reference/prisma-cli-reference) — `migrate diff` `--from-migrations` / `--to-schema-datamodel` / `--script` / `--exit-code`; `migrate deploy`; `db execute --file`
- [Prisma unsupported database features (v7)](https://www.prisma.io/docs/orm/v7/prisma-schema/data-model/unsupported-database-features) — `dbgenerated()`, `Unsupported()` fields are not exposed in the client
- [prisma/prisma-client-extensions — row-level-security](https://github.com/prisma/prisma-client-extensions/tree/main/row-level-security) — the official scoped-transaction extension pattern
- [Postgres RLS for Multi-Tenant SaaS, the Production Pattern](https://theroadtoenterprise.com/blog/postgres-rls-multi-tenant-saas) and [Postgres Row-Level Security in Practice — QueryPlane](https://queryplane.com/blog/postgres-row-level-security-in-practice/) — `SET LOCAL` vs `SET` on a pooled connection; `current_setting(..., true)` fail-closed semantics
- [PostgreSQL 18 docs — 66.2 TOAST](https://www.postgresql.org/docs/current/storage-toast.html) — `TOAST_TUPLE_THRESHOLD` ≈ 2 kB
- [default_toast_compression — pgpedia](https://pgpedia.info/d/default_toast_compression.html) and the [PostgreSQL commit changing the default to lz4](https://www.postgresql.org/message-id/E1vxdV4-002Hkq-1Y@gemulon.postgresql.org) — PostgreSQL 14–18 default to `pglz`; the switch to `lz4` lands in 19
- [PostgreSQL 18 docs — pg_trgm](https://www.postgresql.org/docs/18/pgtrgm.html) — *"pg_trgm ignores non-word characters (non-alphanumerics)"*; word padding; GiST vs GIN
- [PostgreSQL hackers — Asian language full-text search via ICU](https://www.postgresql.org/message-id/CAEV3FNPU8hU_hi=0+QNAbEkc-uO8-K9PB3aAChdmcCyPfWX6rg@mail.gmail.com) — core PostgreSQL has no Thai/CJK word segmentation
- [PGroonga versus textsearch and pg_trgm](https://pgroonga.github.io/reference/pgroonga-versus-textsearch-and-pg-trgm.html) — the extension alternative
- [uuid on npm](https://www.npmjs.com/package/uuid) / [registry.npmjs.org/uuid/latest](https://registry.npmjs.org/uuid/latest) — **14.0.2**, MIT, RFC 9562, exports `v7()`

**Sources fetched during the 2026-09-09 adversarial review pass** (each one either corrected a claim
or resolved an `UNVERIFIED` item):

- [PostgreSQL 18 docs — 5.9 Row Security Policies](https://www.postgresql.org/docs/18/ddl-rowsecurity.html) — *"Referential integrity checks, such as unique or primary key constraints and foreign key references, always bypass row security"*; *"If no role is specified, or the special user name `PUBLIC` is used, then the policy applies to all users on the system"*; table owners bypass RLS unless `FORCE ROW LEVEL SECURITY`. **Corrected §3.4** (missing `TO` clauses; unique-constraint existence oracle → `dedupeKey` re-scoped).
- [registry.npmjs.org/uuid/latest](https://registry.npmjs.org/uuid/latest) — version `14.0.2`, license `MIT`, "RFC9562 UUIDs". **Confirmed §2** — the draft's version string was correct.
- [Postgres 19 Compression: from pglz to LZ4 — Crunchy Data](https://www.crunchydata.com/blog/postgres-19-compression-from-pglz-to-lz4) and the [commit thread](https://www.postgresql.org/message-id/E1vxdV4-002Hkq-1Y@gemulon.postgresql.org) — default flips to `lz4` in 19; `--with-lz4` becomes `--without-lz4`; existing TOAST values keep their original codec across an upgrade. **Confirmed and extended §6.3.**
- [PostgreSQL 18 docs — F.35 pg_trgm](https://www.postgresql.org/docs/18/pgtrgm.html) — *"pg_trgm ignores non-word characters (non-alphanumerics)"*; `word_similarity` does not pad extent boundaries. Silent on multibyte.
- [postgres/contrib/pg_trgm/trgm_op.c](https://github.com/postgres/postgres/blob/master/contrib/pg_trgm/trgm_op.c) — `compact_trigram` CRC32-hashes trigrams longer than 3 bytes and keeps 3 upper bytes (*"hope, it's good enough hashing"*). **Resolved §9.2's `UNVERIFIED`** — this is why pg_trgm is degraded on Thai.
- [Prisma indexes documentation](https://www.prisma.io/docs/orm/prisma-schema/data-model/indexes) — function indexes (`to_tsvector`) unsupported and invisible to `db pull`; **`where` argument on `@@unique`/`@@index` behind the `partialIndexes` preview flag, supported on PostgreSQL**; operator classes beyond the built-ins available via `raw("…")`. **Corrected §8.1** (partial indexes *are* expressible → the racy trigger is replaced) **and §9.4** (`ops: raw()` *does* work; the real problem is migrate/introspect round-tripping).
- [prisma/prisma#17518](https://github.com/prisma/prisma/issues/17518), [#16275](https://github.com/prisma/prisma/issues/16275), [#7515](https://github.com/prisma/prisma/issues/7515), [#26856](https://github.com/prisma/prisma/issues/26856) — extension operator classes cause endless migrations, introspection strips them, custom pg_trgm indexes are dropped and recreated. **Sharpened §9.4** from "cannot express" to "can express, must not".
- [Prisma ORM v5.18.0 changelog](https://www.prisma.io/changelog/2024-08-08) — `uuid()` gains an integer argument; `uuid(7)` = UUIDv7, `uuid(4)` the default. **Confirmed §2.**
- [Prisma docs — PostgreSQL extensions (v7)](https://www.prisma.io/docs/orm/v7/prisma-schema/postgresql-extensions) and [prisma/prisma#28530](https://github.com/prisma/prisma/issues/28530) — `postgresqlExtensions` deprecated in **v6.16.0**; customised migrations are the recommended route; `db push` no longer emits `CREATE EXTENSION`. **Confirmed §9.4.**
- [Advanced Schema Management with Atlas & Prisma ORM — Prisma blog](https://www.prisma.io/blog/advanced-database-schema-management-with-atlas-and-prisma-orm) — Prisma's own statement that Prisma Migrate does not plan migrations for views, stored procedures, triggers or row-level security. **Upgraded §10.2** from `UNVERIFIED` to sourced, and motivated the post-deploy assertion migration.
- [Prisma docs — relations](https://www.prisma.io/docs/orm/prisma-schema/data-model/relations) — composite foreign keys (multiple columns each side) supported; a scalar shared across relations is disambiguated with `@relation(name:)`. **Resolved §3.3's `UNVERIFIED`**; the `BEFORE INSERT` fallback is withdrawn.
- `/Users/innovera/Documents/jawbong/prisma/schema.prisma` re-read during the review to confirm the convention claims: `@db.Uuid` ids with no `@default`, `@db.Timestamptz(3)`, `@db.JsonB`, `@db.VarChar(n)` bounds, `@@map` to snake_case plurals, `map:`-named indexes as `{table_singular}_{cols}_idx`/`_key`, `provider = "prisma-client"` with `output`, and a `datasource` block carrying **no** `url`. All confirmed. One deviation is noted and justified: jawbong's outbox uses `claimedAt`/`claimUntil`, while `ExtractionJob` uses `lockedAt`/`lockedBy`/`leaseUntil` per decision A-6's krs-pos claim shape.

---

## 15. Critic Notes

Adversarial completeness review, 2026-09-09. The draft was strong — the tenancy reasoning, the
dedup privacy analysis, the TOAST/size math and the `to_tsvector`-on-Thai argument were all correct
and are unchanged. What follows is what was wrong, what was missing, and what still cannot be known
from this session. Nothing below was fixed by deletion; the document is ~1 400 lines longer than the
draft.

### 15.1 Correctness bugs that would have shipped

| # | Defect | Where | Consequence if unfixed |
|---|---|---|---|
| B-1 | `BEFORE UPDATE **OR DELETE**` append-only triggers on tables that are `onDelete: Cascade` children of `Document` | §8.1 | **Lawful PDPA/GDPR erasure structurally impossible.** `DELETE FROM documents` → cascade → `APPEND_ONLY_VIOLATION`. Also broke the 400-day audit sweep and the render-TTL sweeper. Fixed by splitting UPDATE (always refused) from DELETE (refused outside a transaction-local `app.erasure_window` GUC), plus a two-transaction erasure protocol. |
| B-2 | `assert_single_current_value()` counting trigger enforcing "one current value per (document, field)" | §8.1, §5.7 | **Not concurrency-safe.** Two concurrent corrections each see count = 1 under their own snapshot, both commit, invariant violated silently. `DEFERRABLE` does not help — each transaction still has its own snapshot. Replaced with a partial unique index, which takes a real index lock; the correction path is now retire-then-insert with a documented 409. |
| B-3 | `ExtractionJob.dedupeKey String @unique` | §5.5, §4.2 | Two defects at once. (a) §4.2 says a requeue inserts a *new* job; with a `(documentId, kind)`-derived key that insert **violates the unique constraint** and the retry button silently does nothing. (b) A global unique on tenant-derived input is a **cross-tenant existence oracle**, because RI checks bypass RLS. Fixed: `@@unique([organizationId, dedupeKey])` plus a `:g{requeueCount}` generation suffix and a new `Document.requeueCount` column. |
| B-4 | `UsageCounter @@unique([organizationId, metric, periodStart])` with no `period` column | §5.8 | The `DAY` bucket for the 1st of a month and the `MONTH` bucket for that month share a key and **merge**. Quota enforcement wrong by ~30× on the first of every month. Fixed by adding `period` to the model and the unique key, plus a `usage_period_start()` bucket function. |
| B-5 | `onDelete: SetNull` on the composite `DocumentPage.canonicalOcrResult` FK | §5.4 | `SET NULL` nulls **all** FK columns including `organization_id`, which is `NOT NULL` → `23502` at delete time. The document-delete integration test the draft proposed would have failed. Changed to `NoAction` with the pointer cleared explicitly in the erasure transaction. |
| B-6 | `DELETE FROM audit_logs … LIMIT 5000` | §8.3 | **Not valid PostgreSQL** — `LIMIT` is not accepted on `DELETE`. Replaced with the `DELETE … USING (SELECT … LIMIT … FOR UPDATE SKIP LOCKED)` form, matching both PK columns. |
| B-7 | `CREATE ROLE ocr_app LOGIN PASSWORD :'app_password'` inside migration 0001 | §3.4, §10.2 | `:'var'` is **psql-only** syntax; `prisma migrate deploy` speaks the wire protocol and would fail with a syntax error on the first deploy of every environment. `CREATE ROLE` also needs privileges the migration role will not have on managed PostgreSQL. Moved to a bootstrap script; migration 0001 now asserts the roles exist. |
| B-8 | Claim query with no `attempts < max_attempts` predicate | §5.5 | A worker killed mid-job never runs the failure path, so the lease sweeper returns the job to `PENDING` forever and nothing ever sets `DEAD` — a poison pill that re-claims indefinitely. One WHERE clause. |

### 15.2 Security defects

| # | Defect | Where |
|---|---|---|
| S-1 | **`CREATE POLICY` with no `TO` clause.** PostgreSQL applies such a policy to `PUBLIC`, i.e. to `ocr_queue` and `ocr_erasure` too, silently reducing the queue claim and the purge job to zero rows. Every policy now names its role. | §3.4 |
| S-2 | **Referential-integrity checks bypass RLS** — documented PostgreSQL behaviour the draft never mentioned. Makes any global unique on tenant-controlled input an existence oracle (see B-3) and required a new invariant: *a `@@unique` on tenant-controlled input MUST include `organizationId`*. | §3.4 |
| S-3 | **Six single-column foreign keys into tenant-scoped tables**, in a document whose thesis is that IDOR is "structurally impossible": `Document.originalStorage`, `Document.template`, `DocumentPage.canonicalOcrResult`, `ExtractionFieldValue.template`, `ExtractionFieldValue.field`, `Correction.fieldValue`, `Correction.ocrResult`. The blob pointer is the worst of them — a cross-tenant `originalStorageObjectId` is a direct cross-tenant file read. All converted to composite FKs; invariant TEN-1 stated; a DMMF test added so a new violation fails CI. | §3.3, §5.4, §5.7 |
| S-4 | **The scan gate accepted any `CLEAN` verdict, of any age, without a tenant predicate**, and relied on RLS inside a trigger — which does not apply when the invoker is `ocr_erasure`, `ocr_owner` or a backfill. Now restates the tenant predicate explicitly and requires a scan within 30 days. | §8.1 |
| S-5 | **`ocr_erasure` self-contradiction:** "every erasure writes an `AuditLog` row before deleting" *and* "`ocr_erasure` has no `INSERT`/`UPDATE` anywhere". Both cannot hold. Replaced with a three-transaction protocol where `ocr_app` writes the intent and completion rows and `ocr_erasure` only deletes — which is stronger than what the draft intended, since the audit survives a failed erasure. | §8.1 |
| S-6 | **`ipHash` "rotating daily salt" with no stated storage location.** A salt in the same database as the hash is worthless — IPv4 is 2³² and trivially enumerable from a stolen dump. Salt moved to the secrets manager with an explicit 35-day lifecycle, and `ipSaltDate` added so verification survives rotation. | §5.8 |
| S-7 | **`audit_logs` and `scan_results` were listed as append-only in K-8 but had no trigger.** Both now have one. | §8.1 |

### 15.3 Factual errors corrected

| # | Draft claim | Reality |
|---|---|---|
| F-1 | *"Prisma's `ops:` argument does not cover operator classes contributed by extensions (`gin_trgm_ops`)"* | Prisma documents a `raw("…")` escape hatch, so it **is** expressible. The real problem is worse: Prisma cannot round-trip extension op classes through migrate/introspect, so every subsequent migration **drops and recreates the index non-concurrently** (#16275, #17518, #7515) — an `ACCESS EXCLUSIVE` lock on `document_pages`, i.e. an outage. Conclusion unchanged, rule made stricter. |
| F-2 | *"`organization_id` is the leading column of every composite index in §5"* — used to argue the RLS predicate is free | False for eight of the indexes actually defined, including the claim index and every page/line-level index. Replaced with the narrower, true statement: those tables are reached via an already-tenant-scoped parent id, so the predicate degrades to a per-row filter on rows already in memory. |
| F-3 | *"`audit_logs` crosses the partitioning threshold (~50 M) around year 20"* | With the document's own 400-day retention the table is **bounded at ~2.6 M rows** and never approaches 50 M. The real reason to defer partitioning is that retention already bounds the table; the reversal triggers are now stated. |
| F-4 | *"PostgreSQL cannot partially read a compressed TOASTed value"* | PostgreSQL **can** slice a TOASTed datum and decompresses only to the requested offset. The argument survives for a narrower reason: `jsonb` has no slice path and must be fully materialised. Getting this right matters — it means `text` + `substr()` is a real option where `jsonb` is not. |
| F-5 | *"PostgreSQL has no citext in core"* used as the reason to reject citext | Technically true, practically misleading — `citext` ships in contrib and is available on every mainstream managed provider. Decision unchanged; three better reasons substituted, including that RFC 5321 makes the email local part case-sensitive, so lowercasing the whole address is a deliberate simplification a column type cannot express. |
| F-6 | `DELETE … LIMIT` | Not valid PostgreSQL (also listed as B-6). |
| F-7 | `search_tsv` declared as `Unsupported("tsvector")?` so "Prisma will create/see the column but not expose it" | Prisma *would* create it — as a **plain, non-generated** column, because Prisma cannot express `GENERATED ALWAYS AS … STORED`. On a fresh database that silently produces a column nothing populates: search returns nothing and nothing errors. The column is now kept entirely out of `schema.prisma` and on the drift allowlist. |
| F-8 | The `PageCanonical` two-parent case cited as `OcrResult → DocumentPage` and `OcrResult → ExtractionJob` | `OcrResult.jobId` has **no relation at all** in the draft's own §5.6 — a bare `Uuid?`. The example was wrong; the underlying question (can one scalar back two relations?) is answered yes, and the no-FK choice on `jobId` is now stated and justified rather than implied. |

### 15.4 Contradictions between sections

- **The object-storage key had two incompatible shapes** — §2 used `org/{orgId}/doc/{docId}/original`
  to justify UUIDv7 ("we must know the `Document.id` before we stream bytes"), §7.3 used
  `org/{organizationId}/blob/{sha256}` to justify tenant-scoped dedup. They cannot both be right: the
  per-document form makes the same-tenant blob reuse promised in §7.1 step 4 impossible. Resolved in
  favour of the content-addressed form, with a full key grammar in the new **§7.4**, and §2's UUIDv7
  argument restated in terms of `StorageObject.id` and two-phase-write idempotency (which still
  eliminates `bigint`).
- **The 200 MiB upload cap and the 2 000-page cap disagreed.** At the document's own 275 KB/page
  figure, 2 000 pages is ~550 MB, so the page cap could never bind. Both now stated as a coherent
  limit table with distinct, reachable failure states.
- **K-8 listed `audit_logs` as trigger-enforced append-only; §8.1 never created that trigger.**
- **§8.1 justified a trigger over a partial index with "undeclared indexes are banned"** — but
  partial indexes are declarable in Prisma behind the `partialIndexes` preview flag, and the trigger
  chosen instead was racy (B-2). Both halves of the justification were wrong.

### 15.5 Hand-waving replaced with mechanism

The brief asked for schemas, formulas and thresholds where the draft gave prose. Filled in:

- **The native-coverage threshold** was literally the word "threshold". Now a formula (`0.80`), plus
  a **Thai sanity gate** the draft did not consider at all — Thai PDFs with subsetted, non-Unicode
  fonts score 100 % coverage and extract as mojibake, so a coverage number alone routes garbage
  straight past OCR. (§4.2)
- **The lease sweeper** was named in an index comment and never written. Now two statements —
  revive and retire — with the backoff expression in SQL and a test asserting it matches jawbong's
  `calculateBackoffMs`. (§5.5)
- **`dedupeKey` had no format.** Now a grammar with the requeue generation that makes B-3 work.
- **Seven `CHECK` constraints were named in prose and one was written.** All ~24 now written out.
  (§5.3)
- **"Starter templates are COPIED into each organization"** — from where? Now a version-controlled
  TypeScript catalogue installed in the org-creation transaction, with `starterCatalogueVersion` so
  the "new version available" path can find stale tenants, and the consequence (published templates
  are immutable, so improvements do not propagate) stated.
- **"HMAC, rotating daily salt"** — now a named key path, a 35-day lifecycle, and a stored salt date.
- **Quota enforcement** was a `@@unique` with no stated check-then-act race. Now acknowledged as a
  soft quota in M1 with the single-statement hardening written for M2.
- **The RLS test's `TENANT_TABLES` was a hand-typed list** — exactly the drift the test exists to
  catch. Now derived from the DMMF, with `organizations` special-cased (its tenant column is `id`,
  not `organization_id` — a copy-pasted policy would have failed with `42703`).
- **`CREATE INDEX CONCURRENTLY` cannot run inside a transaction block** and Prisma wraps every
  migration in one. The draft's M4 plan would have failed with `25001`. Now a stated rule plus a CI
  linter.

### 15.6 Thai blind spots — the largest category

The draft was excellent on *one* Thai issue (why `to_tsvector` fails) and silent on every other. For
a Thai-first product this was the most serious gap by volume. Added as §9.5–§9.8 and K-12:

1. **Compound recall.** The draft noticed that `newmm` segments `ใบกำกับภาษี` as one token, wrote
   *"— sorry, `ใบกำกับภาษี` —"*, and moved on. That aside means **`ภาษี` ("tax") returns nothing on a
   tax-invoice product.** Resolved with a two-stream index (maxmatch for precision at weight A,
   sub-word for recall at weight B), costed (+40 % token storage), and with a drop-column reversal
   trigger.
2. **Thai numerals.** `๐-๙` appear in the draft's own example and are handled nowhere. `parseFloat('๑๒๓')`
   is `NaN`; `๐๐๑๒๓` and `00123` are different lexemes. Now a four-site fold with `thaiDigitPolicy`
   recorded and `valueTextRaw` preserved.
3. **Buddhist Era dates.** The flagship template has `invoice_date (DATE)` and the schema had no era
   handling. A Thai invoice dated `๓๑/๑๒/๒๕๖๙` is 2026, not 2569 — **every Thai date would have
   landed 543 years in the future and every date-range filter returned nothing.** Now `valueDate` is
   always CE, with `dateEra` (`CE`/`BE`/`UNKNOWN`), detection ranges, and a rule that `UNKNOWN` blocks
   completion rather than being guessed.
4. **Thai collation.** Never mentioned. A byte-order sort scatters every word beginning with a
   leading vowel (เ แ โ ใ ไ) because those vowels are *stored* before the consonant they follow. Now
   an ICU `th-TH` collation at database and column level, with the four consequences (index rewrite
   timing, why not to make it non-deterministic, which columns must *not* be collated, and the
   pagination bug caused by re-sorting in JavaScript).
5. **Thai normalisation.** The draft said "NFC" and "NFC + Thai normalisation" without defining the
   second. NFC alone does **not** canonicalise Thai: most Thai combining marks have `ccc = 0`, so
   canonical reordering does not unify vowel-then-tone with tone-then-vowel; SARA AM's decomposition
   is not stable across an intervening tone mark; and **U+200B ZWSP** — the traditional Thai soft word
   break, common in text copied from Thai PDFs — is invisible, splits tokens, and breaks matching.
   Now a five-step `thaiNormalize()` with a `normalizerVersion` reindex trigger and an explicit
   applied/forbidden table.
6. **Thai filenames.** macOS uploads decomposed, Windows composed — the same Thai filename is two
   byte strings. Added `originalFilenameNfc` alongside the raw name. Also noted that
   `varchar(n)` counts **characters**, not bytes, which the byte-based §6.1 math makes easy to
   conflate.
7. **pg_trgm on Thai** is materially worse than the draft's "viable" — trigrams longer than 3 bytes
   (i.e. every all-Thai trigram) are CRC32-hashed into 3 bytes, so the index collides, produces heap
   rechecks, and loses selectivity.

### 15.7 Brief items the draft did not answer

- **`DocumentBlock`** was named in the brief and appears nowhere in the draft — neither modelled nor
  rejected. Now decision **K-13** with a full rejected-alternative analysis, a row-count estimate
  (22–58 M/year, 6× the next largest table), the named loss (no queryable line items in M1) and a
  two-part reversal trigger. §5.9.
- **Rejected alternatives and reversal triggers** were present for most decisions but missing for
  several: the audit retention figure, the JSON size caps, the `Int`-vs-`BigInt` choice, and
  `DocumentBlock`. Added where they were absent.
- **"No FK" choices were undocumented.** `AuditLog.organizationId`, `OcrResult.jobId`,
  `DocumentAnalysis.jobId`, `Correction.actorUserId`, `Membership.invitedByUserId`,
  `Document.ownerUserId` all lack relations. Each is defensible; none was defended. The load-bearing
  ones now are.

### 15.8 Style and scope notes

- The draft's honesty markers (`UNVERIFIED`, "*stated assumption*", the §12 risk list) are a genuine
  strength and were preserved and extended rather than cleaned up. Four `UNVERIFIED` items were
  resolved with primary sources; the rest were kept and sharpened.
- Nothing was shortened. Corrections are marked `[REVISED]`, additions `[ADDED]`, resolved unknowns
  `[RESOLVED]`, so a reader of the earlier draft can diff by eye.
- One convention deviation from jawbong is now named rather than silent: jawbong's outbox uses
  `claimedAt`/`claimUntil`; `ExtractionJob` uses `lockedAt`/`lockedBy`/`leaseUntil` per decision A-6's
  krs-pos claim shape. Both are defensible; only one was documented.

### 15.9 What remains genuinely unknowable in this session

Not deficiencies of the document — facts no amount of desk work can produce from this workstation:

1. **The INNOVERA AI gateway: endpoint, model list, and vision capability** (`b-ai-topology-discovery.md`
   items C/D/E). No LiteLLM, vLLM or self-hosted-Qwen configuration exists on this machine, and no
   endpoint or credential appears in any readable file. **Owner-supplied blocker.** The schema is
   written to absorb either outcome without a migration (§5.6), and the draft's one leak of an
   assumed model family into an enum has been removed (§5.2). No model name, endpoint or port appears
   anywhere in this document as a known fact.
2. **Every number in §11.** No requirements document exists. Volume, page count, burst shape and
   retention expectations are guesses that exist to be falsified.
3. **Every Thai threshold introduced in this review** — the `0.80` coverage gate, the `0.20`
   script-ratio gate, the BE detection ranges, and the claim that sub-word segmentation recovers the
   recall maxmatch loses. All reasoned from the script's properties; none measured. They need the M2
   corpus.
4. **All compression ratios** (§6.3) and the GIN index size band in §9.4 (12–35 GB) — estimates, not
   measurements, and the band is wide enough that it should not be load-bearing beyond "big enough to
   defer".
5. **Anything requiring a running PostgreSQL.** No instance exists for this project. Every SQL
   statement here is written and not run, including the ones this review added. The specific items
   that need ten minutes against a real 18.x instance are listed in §12.2; the highest-value three
   are the `migrate diff` invisibility check, the erasure-cascade test (§8.1), and
   `SELECT show_trgm('ภาษี')`.
6. **Which PyThaiNLP call produces the sub-word stream** (§9.3). The two-stream design holds
   regardless; the specific API belongs to `d-ocr-engine.md` and the installed version.
7. **Managed-provider capabilities** — ICU collation support, `lz4` availability, `CREATE ROLE`
   privileges. All three are blocking questions for specific migrations and all three are now in
   §12.4 rather than discovered at deploy time.
