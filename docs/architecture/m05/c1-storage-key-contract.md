---
dimension: c1-storage-key-contract
title: Canonical storage object-key grammar, namespaces, and document-status vocabulary
status: canonical-reviewed
date: 2026-09-09
reviewed: 2026-09-09
owner_section: 13
resolves_contradiction: 3
supersedes:
  - docs/architecture/m0/i-storage.md §2.0, §2.1, §2.2, §3.1 (mintObjectKey), §3.2 (segment count), §4.1 (directory layout) — the key template, the identifier rendering, the shard derivation and the 7-segment validator
  - docs/architecture/m0/g-data-model.md §7.4 (the five-line key grammar), §4.1 (DocumentStatus enum), §5.4 (StorageObject.objectKey VarChar(1024)), enum StorageObjectKind
  - docs/architecture/m0/l-api-ui-export.md §3.3 step 5 (`orig/{tenantId}/{documentId}/{sha256}` and `staging/{tenantId}/{uploadId}`), §4.4 (`render/{tenantId}/{documentId}/{recipeHash}/p{n}-w{w}.webp`), §4.2 DocumentListQuery status enum
  - docs/architecture/m0/j-security-threat-model.md §3.8 (`{tenantId}/{documentId}/original.{detectedExt}`), §4 key-shape row, §4 quarantine-prefix row, §4.1 DOWNLOADABLE_STATES
  - docs/architecture/m0/f-preprocessing-and-confidence.md D7 (derivative key layout, as quoted by `l` §3.3/§4.4)
cites_without_restating:
  - docs/architecture/m05/f1-tenant-visibility-model.md — id.internal, id.external.*, storage.tenant_prefix_check, uniq.storage_original_fingerprint, uniq.document_run_seq, uniq.ocr_result, uniq.document_page, partial_index.policy, schema.ownership_immutability, db.guc.setter
  - docs/architecture/m05/f2-canonical-limits.md — MAX_UPLOAD_BYTES, MAX_PAGES_PER_DOCUMENT, MAX_OCR_PAGES_PER_DOCUMENT, MAX_PAGE_RENDER_BYTES, MAX_TILES_PER_PAGE, MAX_PIXELS_PER_TILE, RENDER_DPI_DEFAULT, MAX_EXPORT_ROWS, FILENAME_MAX_CHARS, JOB_PROCESSING_BUDGET_MS, PROVISIONAL_PER_PAGE_OCR_S, MAX_INFLIGHT_UPLOADS_GLOBAL, DEFAULT_STORAGE_QUOTA_BYTES, LIMITS_SOURCE_OF_TRUTH, CHECK_* / TUNABLE_LIMITS_IN_SCHEMA
  - docs/architecture/m05/f3-ai-call-placement.md — ai.spool.volume, ai.spool.key, ai.spool.retention_days
  - docs/architecture/m05/c3-ocr-routing-policy.md — every routing, text-quality, Thai-orthography, DPI and tiling threshold (`OCR_ROUTE_*`), including `OCR_ROUTE_TILING_DPI_FLOOR`; this document restates none of them
  - docs/architecture/m05/gate-2-pdpa-retention.md — erasure.mechanism (crypto-shredding, per-document DEK), erasure.audit_digest, D-G2-8
citation_discipline: >
  Where a number owned by another M0.5 document appears in this file it is quoted ONLY inside an
  arithmetic derivation, is immediately followed by its owning key, and is marked "(owned by X;
  quoted for the arithmetic)". No such number is re-derived, rounded or renamed here, and a change
  to the owning document is authoritative over any quotation in this one.
---

# M0.5 / C1 — The canonical storage object-key grammar

> **Integration status (2026-09-12):** Read the [architecture index](../README.md) and its consolidation report before using these examples. Individual review labels do not close cross-document conflicts; no application implementation is verified.

**Scope.** One object-key grammar for the whole platform; the namespaces every stored byte lives in;
the key-construction function and its total parser; the proof that no client-controlled byte reaches
a path; the storage envelope's consequences for the key; and one document-status vocabulary.

**Not in scope, and deliberately not decided here.** The upload transport (streamed vs presigned) —
owned by the API dimension; the render recipe's contents — owned by `e`/`f`; engine selection —
owned by `d`; retention *periods* other than the two this document must name to be implementable;
key *management* (KMS, KEK, DEK lifecycle) — owned by `gate-2-pdpa-retention.md` D-G2-8.

---

## 0. Executive decisions

| # | Decision | Confidence |
|---|---|---|
| C1-1 | **The key is identity-addressed, never content-addressed.** `ORIGINAL` = `org/{orgId}/original/{sh}/{docPub}`. This is forced by `gate-2`'s frozen per-document DEK: a shared blob cannot be crypto-shredded. See §3.1. | high |
| C1-2 | **The document segment is the external `public_id` (f1 `id.external.shape`), lowercased — never the internal UUIDv7.** A UUIDv7 in a key publishes the upload millisecond to the storage provider, its inventory reports, its support staff and every access log. See §3.2. | high |
| C1-3 | **The tenant segment is `org/{organization_id}` — the internal org UUID, lowercase hyphenated.** Frozen by `f1` `storage.tenant_prefix_check`; cited, not re-derived. One org-level timestamp disclosed once is not the same class of leak as N per-document timestamps. See §3.2. | high |
| C1-4 | **Five namespaces, one literal segment each: `original`, `render`, `preview`, `payload`, `export`.** `PAGE_THUMBNAIL` is deleted and folded into `PAGE_PREVIEW` at `w=400`. See §4. | high |
| C1-13 | **`PAGE_RENDER` carries an optional tile discriminator `-t{tile:02d}`.** `c3` `OCR_ROUTE_TILING_DPI_FLOOR` and `f2` `MAX_TILES_PER_PAGE` make a tiled page emit up to twelve distinct bitmaps for one page number. Without the discriminator all twelve mint the same key. See §4.8. | high |
| C1-14 | **`storage_objects.bucket` becomes a two-value enum `bucket_role ∈ {PRIMARY, QUARANTINE}`; the physical bucket/root name is resolved from configuration at runtime.** The `current_setting()`-based trigger this replaces was **fail-open**: an unset GUC made the illegal-transition test evaluate to `NULL` and permitted every bucket change. See §4.6. | high |
| C1-15 | **The envelope derives a per-object key by HKDF from the document DEK; it does not manage nonces with a 4-byte random prefix, and it never puts an internal UUID in the header.** A 4-byte prefix collides at ~1 document in 540 at this object fan-out, and a GCM nonce reuse under one key is catastrophic. See §10. | high |
| C1-16 | **`PAGE_PREVIEW`'s `{recipeHash}` is computed over the render recipe *extended with the preview profile*.** Sharing the render's hash means changing the downscaler silently reuses stale preview pixels under `Cache-Control: immutable`. See §5.4.1. | high |
| C1-17 | **`MAX_RECIPES_PER_DOCUMENT = 4`.** A tenant influences the recipe, so the recipe hash is an unbounded key-space dimension and therefore an unbounded storage-amplification vector. Derivatives count against the tenant storage quota. See §5.6. | high |
| C1-18 | **The grammar is shaped so that a per-document, per-lease storage credential is expressible as four resource statements.** This closes the panel's `h` L25/L26 finding (a compromised worker enumerating every organisation's storage keys) rather than leaving it an accepted risk. See §9.4. | high |
| C1-19 | **The client filename never reaches a key, a path or a raw header.** It lives NFC-normalised in `documents.original_filename`, capped by `f2` `FILENAME_MAX_CHARS`, and is emitted only through RFC 6266 `filename*=UTF-8''…` with an ASCII fallback. This is the Thai-specific half of "no client byte reaches a path". See §4.9. | high |
| C1-5 | **The shard is the first 2 characters of the public id that immediately follows it.** A prefix shard is safe here — and only here — because `public_id` is `crypto.randomBytes(20)` with no timestamp. This is the direct payoff of `f1` `id.external.shape` and it removes one SHA-256 per key mint. See §5.3. | high |
| C1-6 | **`ORIGINAL` carries no extension at all.** Derivative extensions come from *our own encoder*, which is strictly stronger than deriving them from sniffed magic bytes. Media type lives in `storage_objects.content_type`. See §6. | high |
| C1-7 | **A key is written once and never changes for the life of the object. Only `bucket_role` may change, exactly once, `PRIMARY → QUARANTINE`, never back.** Enforced by a `BEFORE UPDATE` trigger comparing enum literals, not by convention and not by configuration. See §7. | high |
| C1-8 | **`parseObjectKey` is a total parser whose last statement is `mintObjectKey(parsed) === raw`.** "Accepted by the parser" and "producible by the minter" are therefore the same set, by construction. See §8.2. | high |
| C1-9 | **The grammar is generated, not written three times.** `config/storage-keys.yaml` → TypeScript package + Python package + the SQL shape `CHECK` + a cross-language conformance vector file. Mirrors `f2` `LIMITS_SOURCE_OF_TRUTH`. See §8.4. | high |
| C1-10 | **One `DocumentStatus` enum of 12 members; the wire form is the member lowercased; `phase` is a derived total function, never stored.** `PENDING_UPLOAD` is deleted — a `documents` row exists only once bytes are accepted. See §11. | high |
| C1-11 | **`storage_objects.object_key` is `VARCHAR(512)`; the longest key this grammar can produce is 145 bytes** (`ENGINE_PAYLOAD`), its longest folder prefix 91 bytes and its longest single segment 54 bytes. Against ceilings verified this session on S3 (1,024 B), GCS flat (1,024 B), GCS hierarchical (512 B folder segment **and** 512 B base name), Cloudflare R2 (1,024 B) and Azure Blob (1,024 characters, ≤ 63 path segments with HNS). See §9.1. | high |
| C1-12 | **Getting this wrong is not a normal migration: `ocr_results` is append-only with an `UPDATE`-rejecting trigger, and it holds `payload_ref`.** A grammar change is *unmigratable* for 1.56 M evidence rows without breaking the evidence guarantee. §12 specifies the six-line insurance policy that makes it merely expensive. | high |

---

## 1. The four competing grammars, tabulated

M0 produced **four** incompatible grammars, not three. `f-preprocessing-and-confidence.md` D7 is a
fifth voice but is only ever quoted through `l`, so it is folded into `l`'s row.

| Source | Grammar as written | External identifier used | Addressing | Segments | Fatal problem |
|---|---|---|---|---|---|
| `i-storage.md` J3 / §2.1 | `{tenantId}/{yyyy}/{mm}/{shard}/{documentId}/{kind}/{oid}.{ext}` | internal UUIDv7 (36 ch) for tenant **and** document; ULID (26 ch) per object | identity, per object | exactly 7 | Tenant segment is not `org/{id}/` → violates `f1` `storage.tenant_prefix_check`. `{yyyy}/{mm}` puts the *creation month* in the path, so the key is unstable if `createdAt` is ever corrected, and it publishes a per-document timestamp twice (once in the date, once in the UUIDv7). A fresh `oid` per write means the same logical derivative gets a new key on every re-render → unbounded orphans. |
| `g-data-model.md` §7.4 | `org/{organizationId}/blob/{contentFingerprint}` + `payload/{ocrResultId}.json.zst` + `render/{documentId}/{page:05d}@{dpi}.jpg` + `thumb/{documentId}/{page:05d}.jpg` + `export/{exportId}.{ext}` | internal UUIDs; content hash for originals | **content**-addressed originals, identity-addressed derivatives | 4 or 5, varies | Content-addressed originals are **unshreddable** under `gate-2`'s frozen per-document DEK (§3.1) — this is the fatal one. `@` is on AWS's own "characters that might require special handling" list (verified §9.1). No shard → 240,000 sibling entries per org-year on local disk. `render/` key has no run or recipe discriminator → a requeue at a different DPI silently overwrites the pixels an immutable `ocr_result` row points at. |
| `l-api-ui-export.md` §3.3/§4.4 (quoting `f` D7) | `staging/{tenantId}/{uploadId}` → `orig/{tenantId}/{documentId}/{sha256}`; `render/{tenantId}/{documentId}/{recipeHash}/p{n}-w{w}.webp` | `doc_<uuid>` on the wire, raw UUID in the key | content-addressed originals, recipe-addressed renders | 3–5 | Tenant segment is not first (`staging/`, `orig/`, `render/` lead) → a bucket policy cannot express `s3:prefix = org/{id}/*`, which is the second enforcement layer `f1` requires. `sha256` in the key is a cross-tenant correlation oracle in any storage-provider-side listing. Requires a `staging → orig` server-side copy of up to 200 MiB per upload (`f2` `MAX_UPLOAD_BYTES`). |
| `j-security-threat-model.md` §3.8/§4 | `{tenantId}/{documentId}/original.{detectedExt}` and `{tenantId}/{documentId}/pages/{n:04d}.webp`; quarantine at `quarantine/{documentId}` | internal UUIDs | identity | 3–4 | `quarantine/{documentId}` has **no tenant segment at all** → violates `f1` `storage.tenant_prefix_check` and makes quarantined bytes unattributable to a tenant, i.e. unfindable by a PDPA erasure sweep. `{n:04d}` caps at 9,999 pages, inconsistent with `f2` `MAX_PAGES_PER_DOCUMENT` (value owned by `f2`) only by luck. `.{detectedExt}` puts a sniffer verdict in an immutable path (§6). |

**What all four agree on, and what therefore is not in dispute:** the key is server-generated; the
client filename never appears; the tenant appears somewhere; derivatives are separated from
originals. Everything else is in conflict.

**One further disagreement the panel did not count.** `i` §4.1 places `quarantine/` *outside* the key
namespace (a sibling of `objects/`, with `STORAGE_ROOT` pointing at `objects/`), so quarantined bytes
are structurally unreachable by any key — and therefore also unreachable by any PDPA erasure query.
`j` §4 places quarantine *inside* the namespace but *outside* the tenant prefix. Neither works. §4.6
resolves it.

---

## 2. The constraints that were already decided, and what each one eliminates

This section exists so that no decision below re-litigates something frozen. Values are cited, never
restated.

| Frozen input | Source | What it eliminates from the candidate set |
|---|---|---|
| Every `object_key` matches `'org/' \|\| organization_id::text \|\| '/%'` | `f1` `storage.tenant_prefix_check` | `i`'s `{tenantId}/…` (no `org/` literal); `l`'s `staging/…`, `orig/…`, `render/…` (tenant not first); `j`'s `quarantine/{documentId}` (no tenant at all). Only `g`'s first two segments survive. |
| `public_id` = 160 bits, `crypto.randomBytes(20)`, Crockford base32, 32 chars, no timestamp | `f1` `id.external.shape` | The premise of `i` J9 and `l` §1.2 ("the PK and the public id are the same UUIDv7"). It also makes a *prefix* shard uniform, which `i` §2.2 correctly said was unsafe for the ids `i` had. |
| Internal id = UUIDv7, "never leaves the server" | `f1` `id.internal`, `id.external.count` | Any key that embeds the internal document UUID — because an object key **does** leave the server: to the storage provider, its inventory reports, its access logs and its support organisation. |
| Erasure = crypto-shredding a **per-document** 256-bit DEK | `gate-2` `erasure.mechanism`, D-G2-8 | Content-addressed originals shared between documents (§3.1). This is the fatal interaction. |
| `uniq.ocr_result` includes `runId`, `engineId`, `engineVersion`, `renderDpi`; `uniq.document_run_seq` allocates `run_seq` | `f1` | Any derivative key without a run-or-recipe discriminator: two immutable `ocr_result` rows would otherwise point at one mutable render object. |
| `MAX_PAGES_PER_DOCUMENT`, `RENDER_DPI_DEFAULT`, `MAX_UPLOAD_BYTES` *(values owned by `f2`; quoted below only inside arithmetic)* | `f2` | Field widths: 5 digits for a page number is two orders of magnitude of headroom over the frozen page cap; 4 digits for DPI covers the whole practical range. A `staging → orig` server-side copy of a whole upload is a real cost at the frozen upload cap, not a rounding error. |
| `MAX_TILES_PER_PAGE`, `MAX_PIXELS_PER_TILE`, and `c3` `OCR_ROUTE_TILING_DPI_FLOOR` | `f2`, `c3` | Any render key **without a tile discriminator**. A tiled page emits up to `MAX_TILES_PER_PAGE` distinct bitmaps for one page number; all M0 grammars and the first draft of this one mint one key for all of them. See §4.8. |
| `FILENAME_MAX_CHARS` | `f2` | Any design in which the client filename is a path input. It is a **column**, bounded there, and never a key segment (§4.9). |
| `JOB_PROCESSING_BUDGET_MS` (per claim) | `f2` | Any orphan-reclamation age floor below twice that budget: below it, an in-flight write is indistinguishable from a crashed-run leftover and the GC deletes live bytes (§7.3). |
| Partial indexes are hand-authored raw SQL on a drift allowlist, asserted at startup | `f1` `partial_index.policy` | Any design that needs a *new* partial unique index to be correct. §3.1's design needs none — see the note at §13.2. |
| `MAX_INFLIGHT_UPLOADS_GLOBAL = 8`, sized as "8 × 202 MiB ≈ 1.6 GiB of **nginx body-temp** volume" | `f2` | The presigned direct-to-store upload of `l` L-1: that arithmetic only exists if the body traverses nginx into the app. `f2` has already, implicitly, chosen the app-streamed transport. §3.1 shows `gate-2` forces the same answer independently. |

---

## 3. The two decisions everything else follows from

### 3.1 Decision C1-1 — identity-addressed, not content-addressed

**Competing proposals.**
(a) `g` §7.4 and `l` §3.3: `ORIGINAL` is content-addressed — `blob/{contentFingerprint}` /
`orig/{tenantId}/{documentId}/{sha256}` — with same-tenant dedup, backed by `f1`'s frozen
`uniq.storage_original_fingerprint` (a **unique** partial index on `(organization_id,
content_fingerprint) WHERE kind='ORIGINAL' AND deleted_at IS NULL`).
(b) `i` J3 and `j` §3.8: `ORIGINAL` is identity-addressed by document.

**Selected: (b), identity-addressed by the document's `public_id`.**

**Rejected: (a), and the frozen unique index that assumes it. Reason — it is unshreddable.**

`gate-2` `erasure.mechanism` freezes crypto-shredding with **one 256-bit DEK per document**, and
D-G2-8 states erasure is "hard-delete the `document_keys` row for `D`", after which "everything
encrypted under it — live, replicated, and in every backup — becomes unrecoverable in the same
instant". Now consider two documents in one organisation over identical bytes, which is not an edge
case — it is a user re-uploading the same invoice, a second reviewer uploading the batch again, and
an integration retrying a failed POST:

1. Under (a) they resolve to **one** `storage_objects` row and **one** blob.
2. One blob is one ciphertext, so it is encrypted under **one** DEK.
3. Erasing document A destroys that DEK.
4. Document B's original is now unreadable, with no error anywhere, discovered the next time someone
   opens it. Document B was never erased and its owner never consented to losing it.

The reverse arrangement — refuse to shred while a sibling exists — is worse and `g` §7.3 already
refutes it in its own words: *"'We deleted your pointer' is not erasure."* And `f1` states the
identical rule for the derivative case and simply did not apply it to `ORIGINAL`: *"Reusing a
colliding derivative row is **forbidden** — it makes PDPA erasure of document A destroy a blob
document B renders."*

**A third variant fails for a different reason.** Make the *second upload return the first document*
(`l` §3.3's `deduplicated: true`). Then one blob is one document and shredding is safe — but
`f1` `schema.ownership_immutability` makes `owner_membership_id` immutable, so user B's upload would
return a document owned by user A, sitting in A's `PERSONAL` workspace, which B may have no
visibility on. Either B is handed A's document (an authorization break) or B receives a 404 for the
bytes B just uploaded (an intra-tenant existence oracle: B learns A holds exactly these bytes). Both
are the disclosure class `f1` `api.not_found_rule` exists to close.

**Reason (positive case for (b)).** One document, one DEK, one ciphertext, one key, one retention
clock, one erasure. Every lifecycle noun lines up on the same object. Duplication is the price and it
is affordable: `g` §11 projects **288 GB/year of originals** against **648 GB/year of page renders**,
and `g` §7.3 already accepted 100 % duplication as "a rounding error" for the cross-tenant case; the
intra-tenant case is a small fraction of that.

**Implementation consequence.** The upload flow simplifies rather than complicates. Because the key
is `org/{orgId}/original/{sh}/{docPub}` and `f1` `id.internal` already requires ids to exist *before*
the row ("two-phase upload"), the document id, its `public_id` and its DEK are all minted at upload
**init**. The final key is therefore known before the first byte arrives. There is **no staging
namespace, no `starts-with` policy, and no `staging → orig` server-side copy of up to 200 MiB**
(`l` §3.3 step 5 and `j` §4 Hole 3's `incoming/` prefix are both deleted). The bytes are written
once, at their final key, already encrypted.

`contentFingerprint` survives as a **duplicate-detection hint only**: a non-unique index, surfaced in
the UI as "you uploaded this file on 3 March", never a shared blob and never a shared row. Keep
`g` §7.3's per-organisation HMAC construction for it — it costs nothing now that it has no effect on
any key, and it stops a stolen database dump correlating a file across tenants.

**Migration consequence.** None if decided now. If (a) ships first, the correction requires
re-uploading or re-encrypting every original — see §12.

**Security consequence.** Strictly positive on three axes: erasure becomes total (the whole point of
`gate-2` D-G2-8); the object key stops being a content hash, so a storage-provider-side listing no
longer reveals *which tenants hold identical files*; and the intra-tenant dedup oracle above never
exists.

**Config/env consequence.** `OCR_STORAGE_DEDUP_MODE = hint` (only value; the constant exists so that
a future proposal to reintroduce blob sharing has to change a named value and trip a review).

> **This contradicts a frozen value and is raised formally in §14.1.** `f1`
> `uniq.storage_original_fingerprint` must become **non-unique**. It cannot be implemented as frozen
> alongside this decision: the second upload of identical bytes as a second document raises `23505`
> on a routine user action.

### 3.2 Decision C1-2 / C1-3 — which identifier goes in which segment

**Competing proposals.** (a) `i`, `g`, `j`, `l`: internal UUIDv7 for both tenant and document.
(b) External `public_id` for both. (c) Internal UUID for the tenant, external `public_id` for the
document.

**Selected: (c).**

**Rejected: (a) — the per-document timestamp leak.** `f1` `id.external.count` states the reason for
having two identifiers at all: *"A UUIDv7 on the wire discloses the upload millisecond to everyone in
the transport path, and 62 effective random bits is a weaker target than 160."* An object key is on
the wire in exactly that sense. It appears in: the storage provider's server-side access log; an S3
Inventory report; a bucket listing; a backup manifest; the local filesystem, visible to anyone with a
shell on the host or a copy of a volume snapshot; and any support ticket that quotes a key. Under (a),
each of those surfaces publishes a sorted, per-tenant, millisecond-resolution log of when every
document was uploaded — document volume, working hours, batch boundaries, and the exact minute a
particular national ID card was scanned. `uuid_extract_timestamp()` makes that a one-line query.
Under (c) the same surfaces publish 160 uniform random bits and a count.

**Rejected: (b) — the tenant segment.** `f1` `storage.tenant_prefix_check` is frozen as
`object_key LIKE 'org/' || organization_id::text || '/%'`. A `CHECK` constraint can only compare the
key against a column of the same row; `organizations.public_id` is in another table, so a
`public_id`-based tenant segment makes the constraint impossible to express in the database and
demotes it to a convention — which is precisely what `f1` says it must not be. The asymmetry is also
principled on its own terms: the organisation id is **one** identifier disclosed **once**, shared by
every key of that tenant, and it discloses one organisation-creation timestamp. The document id is
**N** identifiers disclosing **N** upload timestamps. Those are different orders of leak.

**Reason.** The tenant segment must be database-checkable; the document segment must be
non-enumerable. Those are different requirements and they are satisfied by different identifiers.

**Implementation consequence.** `public_id` is stored uppercase (`f1` `id.external.shape`:
`^[0-9A-HJKMNP-TV-Z]{32}$`) and rendered lowercase in the key. Crockford base32 excludes `I`, `L`,
`O` and `U`, so `toLowerCase()` is a **bijection** onto `[0-9a-hjkmnp-tv-z]`, total and reversible;
the parser upper-cases on the way back and a round-trip property test asserts it. The lowercase-only
rule is `i` §2.2's, kept for its empirical reason: this workstation's APFS root is case-insensitive
and the production host's ext4/XFS is not, so a lowercase-only alphabet makes macOS development and
Linux production structurally identical.

**Migration consequence.** None. `public_id` is immutable for the life of a row (`f1` VIS-1), so an
identity-addressed key never needs rewriting — unlike `i`'s `{yyyy}/{mm}`, which is a *derived*
segment that becomes wrong the first time anyone corrects a `created_at`.

**Security consequence.** The document segment is 160 bits from a CSPRNG. Enumerating a tenant's
originals from a leaked bucket-listing capability is 2^160 work instead of "read the timestamps".

**Config/env consequence.** None; both identifiers already exist.

---

## 4. The canonical grammar

### 4.1 The five namespaces

```
ORIGINAL         org/{orgId}/original/{sh}/{docPub}
PAGE_RENDER      org/{orgId}/render/{sh}/{docPub}/{recipeHash}/p{page:05d}[-t{tile:02d}].{ext}
PAGE_PREVIEW     org/{orgId}/preview/{sh}/{docPub}/{previewHash}/p{page:05d}-w{width}.webp
ENGINE_PAYLOAD   org/{orgId}/payload/{sh}/{docPub}/r{runSeq:04d}/p{page:05d}-{engineSlug}-d{dpi}.json.zst
EXPORT           org/{orgId}/export/{sh}/{exportPub}.{ext}
```

`[-t{tile:02d}]` is present **iff** the page was tiled (§4.8). It is the only optional element in the
whole grammar, and the minter's `KeySpec` makes it a discriminated field rather than an optional
string, so "present" and "absent" are two total renderings and not a formatting choice.

| Field | Production | Width | Source |
|---|---|---|---|
| `orgId` | `organization_id::text` — lowercase hyphenated UUID | 36 | `f1` `storage.tenant_prefix_check` (cited) |
| `sh` | first **2** characters of the public id that immediately follows | 2 | this document, §5.3 |
| `docPub` | `documents.public_id` lowercased | 32 | `f1` `id.external.shape` (cited) |
| `exportPub` | `exports.public_id` lowercased | 32 | `f1` VIS-1 (cited); the `exports` entity is specified in §13.4 |
| `recipeHash` | `sha256(canonicalJson(renderRecipe)).hex.slice(0,32)` | 32 | this document, §5.4 |
| `previewHash` | `sha256(canonicalJson(renderRecipe ⊕ previewProfile)).hex.slice(0,32)` | 32 | this document, §5.4.1 |
| `page` | 1-based page number, zero-padded to 5 | 5 | admission bounded by `f2` `MAX_PAGES_PER_DOCUMENT`; the **field width** is deliberately wider than the cap (§4.1.1) |
| `tile` | 1-based tile index, zero-padded to 2; absent on an untiled page | 0 or 4 (`-tNN`) | bounded by `f2` `MAX_TILES_PER_PAGE`; field width 2 (§4.8) |
| `runSeq` | `document_runs.run_seq`, zero-padded to 4 | 4 | `f1` `uniq.document_run_seq` (cited) |
| `engineSlug` | `^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$`, from the engine registry, registry-unique | 2–32 | this document, §5.5 |
| `dpi` | render DPI, `^[1-9][0-9]{2,3}$` (100–9999) | 3–4 | default from `f2` `RENDER_DPI_DEFAULT` |
| `width` | one of `400`, `800`, `1600`, `2400` | 3–4 | `l` §4.4 (cited) |
| `ext` | closed suffix map, §6.2 | 3–4 | this document |

Worked example, all identifiers synthetic:

```
org/0199c3a1-7b2e-7f41-9c3d-5e6f70819a2b/original/7q/7qm3v9zx0k5r2t8h6j4n1p7s3d0f5g2b
org/0199c3a1-7b2e-7f41-9c3d-5e6f70819a2b/render/7q/7qm3v9zx0k5r2t8h6j4n1p7s3d0f5g2b/9f3a1c7e5b2d804612ae7f9c3b5d1e08/p00007.png
org/0199c3a1-7b2e-7f41-9c3d-5e6f70819a2b/render/7q/7qm3v9zx0k5r2t8h6j4n1p7s3d0f5g2b/9f3a1c7e5b2d804612ae7f9c3b5d1e08/p00012-t03.png
org/0199c3a1-7b2e-7f41-9c3d-5e6f70819a2b/preview/7q/7qm3v9zx0k5r2t8h6j4n1p7s3d0f5g2b/2c6b0d94f18e37a5b0c4d29e61f8a730/p00007-w1600.webp
org/0199c3a1-7b2e-7f41-9c3d-5e6f70819a2b/payload/7q/7qm3v9zx0k5r2t8h6j4n1p7s3d0f5g2b/r0002/p00007-tesseract-5-5-1-d300.json.zst
org/0199c3a1-7b2e-7f41-9c3d-5e6f70819a2b/export/4b/4bh8k2m5n9p3q7r1s6t0v4w8x2y5z9a3.xlsx
```

Note that the render and preview hashes of the *same* page differ (§5.4.1) — that is intentional and
is what stops a downscaler change from serving stale preview pixels under an `immutable` cache header.

### 4.1.1 Field widths are not limits, and that is deliberate

`page` is five digits and `dpi` is up to four while `f2` `MAX_PAGES_PER_DOCUMENT` and the practical
DPI range are far narrower. This is not sloppiness, it is `f2` `TUNABLE_LIMITS_IN_SCHEMA = none`
applied to a grammar: a **limit** is tunable and must be changeable by restarting a container, whereas
a **field width** is immutable by C1-7 and changing it is the §12 migration. Sizing the width to the
current limit would convert every future limit change into a full key rewrite. The branded
constructors of §8.1 therefore range-check against the *grammar* width (`pageNumber` accepts 1–99,999),
and the *policy* cap is enforced at admission by `f2`'s owned constants, in a different layer.
A property test asserts the inclusion `f2` limit ⊆ grammar width for every field, and fails loudly if
a future `f2` change ever inverts it.

### 4.2 `StorageObjectKind` — the enum, reduced from six to five

```prisma
enum StorageObjectKind { ORIGINAL PAGE_RENDER PAGE_PREVIEW ENGINE_PAYLOAD EXPORT }
```

**Competing proposals.** `g` §5.4: `{ ORIGINAL PAGE_RENDER PAGE_THUMBNAIL ENGINE_PAYLOAD EXPORT }`.
`i` §1.2: `['original','page','derivative','thumbnail','export']`.

**Selected:** the five above. **Rejected:** `PAGE_THUMBNAIL` as a separate kind — a thumbnail is a
`PAGE_PREVIEW` at `w=400`, which `l` §4.4 already states ("400 is the thumbnail rail"). **Rejected:**
`i`'s `page` *and* `derivative` as two kinds — nothing in any M0 document distinguishes them, and two
undistinguished kinds is how a `kind`-scoped policy ends up covering half the objects.

**Reason.** `kind` is the discriminator for the retention sweeper, the RLS-adjacent bucket policy,
and the shape `CHECK`. Every value must therefore have a *different* lifecycle. `PAGE_PREVIEW`
w=400 and w=1600 have the same lifecycle; `ORIGINAL` and `PAGE_RENDER` do not.

**Implementation consequence.** The literal namespace segment is a **total, injective** function of
`kind`: `original | render | preview | payload | export`. Two representations of one fact are a drift
source, so the mapping lives in `config/storage-keys.yaml` and both are generated from it.

**Migration consequence.** `PAGE_THUMBNAIL` never ships, so this is a rename in a design document,
not a data migration.

**Security consequence.** A bucket policy or IAM statement can be written per namespace prefix, e.g.
deny `s3:GetObject` on `org/*/original/*` to the credential used by the preview-serving path.

**Config/env consequence.** None.

### 4.3 Renders vs previews — why both exist

`PAGE_RENDER` is the exact bitmap the OCR engine read, at `RENDER_DPI_DEFAULT` (`f2`), in the
encoder the recipe names. It is what `l` §4.4 calls `space=derivative`, and it is what makes the
bounding-box overlay land pixel-perfect. `PAGE_PREVIEW` is a downscale for the browser at one of four
widths. Conflating them means either serving an 8.7-megapixel PNG to a reviewer scrolling 40 pages,
or overlaying quads on an image whose scale factor is a guess.

### 4.4 `ENGINE_PAYLOAD` — the key is derived from the frozen uniqueness tuple

`f1` `uniq.ocr_result` freezes `@@unique([documentPageId, runId, engineId, engineVersion,
renderDpi])`. The payload key is that tuple, rendered: `{docPub}` + `r{runSeq}` (for `runId`) +
`p{page}` (for `documentPageId`) + `{engineSlug}` (for `engineId`+`engineVersion`) + `d{dpi}` (for
`renderDpi`). One `ocr_result` row ⇔ one payload key, structurally, with no extra identifier and no
opportunity for the two to disagree. This is why `ENGINE_PAYLOAD` uses `runSeq` while renders use
`recipeHash`: an `ocr_result` is immutable evidence bound to a run, whereas a render is a cache bound
to a recipe.

`g` §7.4's `payload/{ocrResultId}.json.zst` is rejected: it introduces an internal UUID into a key
(§3.2) and it has no organisation-scoped shard, so 1.56 M payload objects land as siblings.

### 4.5 `EXPORT` — and the erasure hole it opens

An export may span many documents (`f2` `MAX_EXPORT_ROWS`, value owned there), so it cannot be
encrypted under any one document's DEK. It therefore sits *outside* per-document crypto-shredding:
erasing document D does not, by itself, make an export containing D unreadable. This is a **new key
class that `gate-2` D-G2-8 does not currently define**, and it is raised as a formal extension request
in §14.4 rather than invented here silently.

**Competing proposals.**
(a) Encrypt an export under the **tenant KEK directly**, and on erasure of document D rewrite or
delete every export containing D.
(b) Encrypt an export under a **per-export DEK**, itself wrapped by the tenant KEK, and on erasure of
document D destroy the DEKs of every export joined to D.
(c) Do not persist exports at all — stream them and never store bytes.

**Selected: (b), plus a join table, plus a hard TTL. All three are required.**

**Rejected: (a).** "Rewrite every export containing D" is an unbounded amount of work inside an
erasure transaction, over files up to `f2` `MAX_EXPORT_CELLS` in size, and it fails the `gate-2`
D-G2-8 standard that erasure must reach **backups and replicas in the same instant**: a rewritten
export is still readable in last night's backup. Deleting the object instead is a network call that
cannot participate in a database transaction, so a crash between the commit and the delete leaves the
subject's data readable with no row left to find it by.

**Rejected: (c).** `l` §3.5 already establishes that any export above its synchronous threshold is a
`202` plus a worker, and a worker's output has to live somewhere. It also loses resumable download,
which at `MAX_EXPORT_ROWS` matters on a Thai mobile connection.

**Reason.** Under (b) erasure is again a single transactional row delete — the same primitive
`gate-2` D-G2-8 already chose — and it reaches backups for the same reason. The two supporting
mechanisms are:

1. **`export_documents` join table** (`export_id`, `document_id`, `organization_id`, composite FK per
   `f1` TEN-1). The erasure use case **destroys the `export_keys` row** of every export joined to the
   erased document, in the same transaction that destroys the document DEK. Byte deletion is a
   *separate*, idempotent sweeper job; it is a cleanup, not the erasure, because by then the bytes
   are already unrecoverable. **No network or filesystem call occurs inside the erasure transaction.**
2. **A hard TTL.** `OCR_STORAGE_EXPORT_RETENTION_DAYS = 7` — **OWNER-BLOCKED (B-C1-3)**, default ships as 7. An
   export is a transient artefact a human downloads within minutes; a 7-day ceiling bounds the window
   in which mechanism 1 has anything to do at all.

Without the join table, "erasure" leaves the erased person's data readable in an XLSX in the same
bucket, which is exactly the failure `gate-2` D-G2-8 was selected to prevent.

**Implementation consequence.** `exports` and `export_keys` entities are required (§13.4). The export
worker allocates the export's `public_id` and DEK before writing a byte, exactly as the upload path
does for a document, so the final key is known before the first row is serialised. The join rows are
written in the same transaction as the `exports` row, from the document ids the query actually
returned — never from the filter the user supplied, which may match documents the principal cannot
see (`f1` `authz.chokepoint` resolves visibility; the join records the resolved set).

**Migration consequence.** Migration 0014 adds `export_documents`; 0017 adds `export_keys`. Deciding
this now costs two tables. Discovering it after launch means every export written before the fix is
permanently outside the erasure boundary and must be deleted wholesale, because there is no record of
which documents each one contains.

**Security consequence.** Positive and specific: an export becomes crypto-shreddable at
per-**export** granularity; the blast radius of an erasure is exactly the exports that actually
contain the subject; and the retention TTL bounds the interval during which an export can contain a
subject who has since been erased but whose export sweeper has not yet run. Negative and stated:
until the sweeper runs, the *ciphertext* remains, and `gate-2`'s "no reasonably foreseeable recovery"
standard is met by key destruction, not by byte absence — this is the same argument D-G2-8 already
makes for documents and it either holds for both or for neither.

**Config/env consequence.** `OCR_STORAGE_EXPORT_RETENTION_DAYS = 7` (B-C1-3);
`OCR_STORAGE_EXPORT_SWEEP_INTERVAL_S = 900` — the byte-deletion sweeper's period. 900 s bounds the
window between key destruction and byte absence at 15 minutes, which is short enough to be reportable
to a data subject and long enough that the sweeper is not a hot loop; the interval is never a
correctness dependency, because unreadability is already total at commit.

### 4.6 Quarantine — the bucket changes, the key does not

**Competing proposals.** `i` §4.1: `quarantine/` is a sibling of `objects/`, outside the key
namespace entirely, so no key can reach it. `j` §4: `quarantine/{documentId}` — inside the namespace,
outside the tenant prefix.

**Selected: neither. The object keeps its key and changes its `bucket_role`.**

```
bucket_role = 'PRIMARY'      resolves to  OCR_STORAGE_BUCKET_PRIMARY    (s3)  |  $OCR_STORAGE_ROOT/objects     (local)
bucket_role = 'QUARANTINE'   resolves to  OCR_STORAGE_BUCKET_QUARANTINE (s3)  |  $OCR_STORAGE_ROOT/quarantine  (local)
object_key  = unchanged
```

**C1-14: the column is a two-value enum, not the physical bucket name.** `g` §5.4 declares
`bucket String @db.VarChar(63)` — the DNS bucket name itself. That is wrong in three ways and one of
them was a live fail-open:

1. **Fail-open enforcement.** The first draft of §7.2's trigger compared `OLD.bucket` and `NEW.bucket`
   against `current_setting('app.bucket_primary', true)`. With `true` as the second argument
   `current_setting` returns **NULL** when the GUC is unset, so the guard evaluated
   `NEW.bucket IS DISTINCT FROM OLD.bucket AND NOT (NULL AND …)` → `TRUE AND NULL` → **NULL**, the
   `IF` did not fire, and **every** bucket transition was permitted, including `quarantine → primary`.
   `f1` `db.guc.setter` also makes every GUC transaction-local (`is_local = true`), so a GUC "asserted
   at startup" is not even present on a pooled connection during a later `UPDATE`. A security control
   whose enforcement depends on a value that is normally absent is not a control.
2. **Renaming a bucket becomes a data migration.** Under `g`'s free string, moving from
   `innovera-ocr` to `innovera-ocr-bkk` rewrites 1,680,000 rows. Under the enum it is one environment
   variable.
3. **A free string is a third place a path can come from.** `VarChar(63)` accepts `../` and every
   character AWS lists as "to avoid" (§9.1, verified). The adapter concatenates the bucket with
   `object_key` for the local driver; §8's proof covers the key and said nothing about the bucket.

**Rejected: keeping `g`'s free-string `bucket`.** Its only advantage is that a deployment could use
more than two buckets without a migration. Nothing in this platform wants a third bucket, and if one
is ever wanted, adding an enum value is `ALTER TYPE … ADD VALUE` — cheap, deliberate, and visible in
review, which is exactly the property that a free string does not have.

**Rejected: `i`'s out-of-namespace directory.** It has no `storage_objects` row, therefore no
`organization_id`, therefore a PDPA erasure sweep — which is a query over rows — cannot find it. A
quarantined upload is still the data subject's personal data. `i`'s own review notes flag the same
directory as "decorative — no producer and no scanner".

**Rejected: `j`'s `quarantine/{documentId}` prefix.** It violates `f1` `storage.tenant_prefix_check`
(no tenant segment), so it cannot be stored in `storage_objects.object_key` at all, and it is
unattributable to a tenant.

**Reason.** The two requirements — "physically outside the serving root" and "enumerable by tenant
for erasure" — are satisfied by two *different* columns. `bucket_role` gives the physical separation
(`g` §5.4 already has a bucket column and `storage_object_bucket_key_key` already keys on it);
`object_key` gives the tenant attribution. Changing the role and holding the key constant satisfies
both, and preserves the owner's "immutable original object identity" requirement *through quarantine*,
which neither M0 proposal does.

**Implementation consequence.** The move is `copy(primary→quarantine) ; delete(primary)`, one object,
on a rare path. On local disk both roots are on the same mount (`i` §4.1's `st.dev` equality assertion
already exists for `tmp/`), so it is a `rename(2)`. `storage_objects.bucket_role` is `UPDATE`d; the
`storage_object_immutable` trigger of §7.2 permits exactly this one transition, comparing against
**enum literals**, not against configuration. The role→physical-name map is resolved once at boot into
a frozen object; no code path takes a bucket name as an argument.

**Migration consequence.** None for keys — no key is rewritten, which is the entire point. One
migration (0012) converts `bucket VarChar(63)` to `bucket_role storage_bucket_role`, mapping every
existing value to `'PRIMARY'`; at M1 the table is empty, so the conversion is a DDL statement with no
data step.

**Security consequence.** No application route maps to the quarantine role; the URL signer of
`j` §4.1 refuses on the download gate of §11.4, not on a prefix. A bucket-level `Deny` on
`s3:GetObject` for the quarantine bucket is a second, independent enforcement point that does not
depend on any application code being correct. The enum also removes the fail-open trigger described
above, which is the larger of the two wins.

**Config/env consequence.** `OCR_STORAGE_BUCKET_PRIMARY`, `OCR_STORAGE_BUCKET_QUARANTINE`,
`OCR_STORAGE_QUARANTINE_RETENTION_DAYS = 7` — **OWNER-BLOCKED (B-C1-2)**: whether an infected
customer file is retained at all for incident response, or deleted on the spot with only its
metadata kept. Default ships as 7 days, aligned with `f3` `ai.spool.retention_days`, and quarantined
bytes remain inside the crypto-shredding boundary so an erasure request destroys them regardless.
Both variables are **deployment** facts and neither ever reaches a key or a trigger.

### 4.7 What is deliberately *not* in the object store

| Artefact | Where it lives | Owner |
|---|---|---|
| AI prompt/response spool | `/data/ai/...` on the `ocr_ai_spool` volume | `f3` `ai.spool.volume` / `ai.spool.key` (cited; see §14.3 for one challenge) |
| In-flight upload temp files | `$OCR_STORAGE_ROOT/tmp`, sibling of the roots, outside every key namespace | `i` §4.1, kept unchanged |
| OCR text, field values, corrections | PostgreSQL, encrypted under the document DEK | `g`, `gate-2` |
| The client's original filename | `documents.original_filename` — a column, never a path (§4.9) | this document |

**The two other columns that hold an object key, and the rule that binds them.** `f1`
`storage.tenant_prefix_check` places the same `org/{organization_id}/%` constraint on
`ocr_results.payload_ref` and `extraction_jobs.result_ref` as on `storage_objects.object_key`. Those
two columns are therefore governed by this grammar, and neither gets a namespace of its own:

- `ocr_results.payload_ref` **must** be a key in the `payload` namespace, minted by `mintObjectKey`
  for the same `(document, run, page, engine, dpi)` tuple as the row itself (§4.4).
- `extraction_jobs.result_ref` **must** be `NULL`, or a key in the `payload` namespace referring to an
  object that already exists. It is a *reference*, never a sixth namespace. There is no
  `job/` prefix and no key shape a job may invent.

A CI test walks every column typed as an object key in the Prisma schema and asserts
`parseObjectKey` accepts every value a fixture run produces, and that its `kind` is in the allowed set
for that column. This is the check the panel asked for when it observed that these two columns are
"raw `VarChar(1024)` object-storage keys … neither the composite FK nor RLS applies to them at all".

### 4.8 Decision C1-13 — the tile discriminator

**Competing proposals.**
(a) No tile in the key — every M0 grammar, and the first draft of this document.
(b) A tile index inside `recipeHash` — i.e. make the tile geometry part of the recipe, so each tile
gets its own recipe hash and its own directory.
(c) An explicit optional `-t{tile:02d}` element on the `PAGE_RENDER` filename.

**Selected: (c).**

**Rejected: (a) — it is a silent overwrite on an ordinary input.** `c3` `OCR_ROUTE_TILING_DPI_FLOOR`
routes a page to tiling when reducing DPI would fall below the floor, and `f2` `MAX_TILES_PER_PAGE`
bounds a tiled page at twelve tiles with 5 % overlap. Under (a) all twelve tiles of page 12 mint
`…/p00012.png`. The consequences compound:

1. `putImmutable` returns `created:false` for tiles 2–12, which §7.1 classifies as a *legitimate cache
   hit* for a derivative kind — so the pipeline reports success while eleven twelfths of the page's
   pixels were never stored;
2. the `ocr_result` for that page is immutable evidence pointing at a `payload_ref` derived from
   pixels that no longer exist in the store;
3. and because a key is immutable (C1-7), adding the discriminator later is the §12 migration —
   1.68 M `CopyObject`s and an `UPDATE` of 1.56 M append-only evidence rows.

This is the single defect in this contract that would most plausibly have shipped: A0 engineering
drawings and Thai land-title plans are exactly the corpus that triggers tiling, and they are rare
enough not to appear in a smoke test.

**Rejected: (b) — a tile is not a recipe.** Two tiles of one page share every recipe field: same
renderer, same DPI, same colourspace, same deskew. Folding the tile index into the hash would make
`recipeHash` no longer answer "were these pixels produced the same way", which is the one question
§5.4 exists to answer and the question `Cache-Control: immutable` depends on. It would also make the
recipe hash unstable under a change to the *tiling* algorithm, which is a rendering concern, not a
recipe concern, and would orphan every render on the day the overlap fraction changes.

**Reason.** The tile index is an identity coordinate of the bitmap, exactly like the page number, so
by §5.1 it belongs in the path next to the page number. Two digits admit 99 tiles against a frozen cap
of `f2` `MAX_TILES_PER_PAGE`, giving headroom without widening the key.

**Implementation consequence.** `KeySpec`'s `PAGE_RENDER` variant gains `tile?: TileIndex`, where
`TileIndex` is a branded integer in 1..99. The minter emits `-t{tile:02d}` iff the field is present;
the parser's `S_RENDER` regex makes the group optional and the closing `mint(parse(k)) === k` makes the
two renderings mutually exclusive by construction — a `-t00`, a `-t1`, or a `-t03` on an untiled spec
all fail. The tile *geometry* (origin, size, overlap) is not in the key: it is
`document_pages.tile_geometry` JSONB, because it can be recomputed and corrected while the bitmap's
identity cannot.

**`ENGINE_PAYLOAD` deliberately gains no tile element.** `f1` `uniq.ocr_result` is keyed on
`documentPageId`, not on a tile, so one page yields exactly one `ocr_result` per
`(run, engine, version, dpi)` and the tiles' recognised text is stitched **before** the payload is
written. Adding a tile to the payload key would create N payload objects for one evidence row and
reintroduce the very disagreement §4.4 was built to prevent. The per-tile intermediate output is a
worker-local temporary under `$OCR_STORAGE_ROOT/tmp`, never an addressable object.

**Migration consequence.** None if decided now: an untiled page's key is byte-identical to the
pre-tile grammar, so this is a pure extension of the accepted set. If discovered after launch it is
the full §12 migration, because the eleven missing tiles cannot be recovered without re-rendering and
the evidence rows that point at them are append-only.

**Security consequence.** Neutral on disclosure — the tile index leaks that a page was large enough
to tile, which the page's own dimensions already disclose to anyone entitled to see it. Positive on
integrity: it removes a path where a "successful" job silently stores 1/12 of the evidence, which is
the class of failure that produces a confidently wrong extraction from a Thai title deed.

**Config/env consequence.** None. The tile *count* is `f2` `MAX_TILES_PER_PAGE` and is not restated
here; the grammar width (2 digits) is in `config/storage-keys.yaml` as `storage.tile_digits = 2`.

### 4.9 Decision C1-19 — the client filename: where it lives, and the Thai-specific reason it matters

**Competing proposals.** (a) `i` §2.1 / `j` §3.8: sanitise the filename and use it, or a derived
extension, in the key. (b) `l` §3.3: keep it as an `X-Filename` header, normalised. (c) Keep it only
as a column, and never let it reach a path or a raw header.

**Selected: (c).**

**Rejected: (a).** §6.1 already removes the *extension*; this removes the rest of the same channel.
A sanitiser is a denylist wearing an allowlist's clothes, and the corpus here is Thai: a filename such
as `บัตรประชาชน_สมชาย.pdf` is 24 UTF-8 bytes of Thai plus ASCII, may carry combining marks that
normalise differently under NFC and NFKC, and may contain the Thai numerals `๐–๙` (U+0E50–U+0E59),
which are *not* `[0-9]` and which several ASCII-oriented sanitisers silently delete rather than
transliterate — turning two distinct filenames into one.

**Rejected: (b) as the *whole* answer.** A header is fine as transport, but it is not storage, and a
raw header value is where the actual Thai hazard lives: HTTP header values are ISO-8859-1 by
RFC 9110, so a raw Thai filename in `Content-Disposition` either mojibakes or, if a byte sequence is
mishandled, becomes a header-splitting primitive.

**Reason.** The filename is the one piece of genuinely client-controlled text the product must
display back, so it needs a place where being arbitrary is harmless. A column is that place.

**Implementation consequence.**

| Rule | Value |
|---|---|
| Column | `documents.original_filename TEXT NOT NULL` |
| Normalisation | Unicode **NFC**, applied once at ingest, before the length check |
| Control/format stripping | C0/C1 controls, U+200B–U+200F, U+202A–U+202E, U+2066–U+2069 removed; a run of more than 8 combining marks is truncated to 8 (`j` §3.8's rule, adopted by citation) |
| Length cap | `f2` `FILENAME_MAX_CHARS` — counted in **NFC code points after stripping**, and separately capped at `OCR_STORAGE_FILENAME_MAX_BYTES = 1080` UTF-8 bytes, which is that cap at 9 bytes per Thai grapheme cluster |
| Emptiness | If nothing survives normalisation, store the literal `untitled` — never a generated path-like string |
| Egress | `Content-Disposition: attachment; filename="<ASCII fallback>"; filename*=UTF-8''<pct-encoded NFC>` per RFC 6266/5987. The ASCII fallback is `document-<first 8 chars of docPub>.<ext>` — derived, not transliterated |
| Never | in an object key, a prefix, a local path, a log line at `info` or above, or a raw header value |

**Migration consequence.** None; a column added at 0011.

**Security consequence.** Closes three at once: path traversal via filename (structurally
unreachable — §8.3), header injection via `Content-Disposition` (percent-encoded, and the ASCII
fallback is server-derived), and the homoglyph/RTL-override display attack in the reviewer UI (the
strip list above). The residual is that a filename is still attacker-controlled text rendered in a
browser; that is XSS-escaping's job and belongs to `l`.

**Config/env consequence.** `OCR_STORAGE_FILENAME_MAX_BYTES = 1080`. Boot assertion:
`OCR_STORAGE_FILENAME_MAX_BYTES >= 9 × f2.FILENAME_MAX_CHARS`, so a future increase to the character
cap cannot silently start truncating Thai mid-grapheme.

---

## 5. Derivations, stated once

### 5.1 The governing principle

> **A key encodes identity. Anything that can change independently of identity goes in a column.**

`content_type`, `size_bytes`, `plaintext_bytes`, `plaintext_sha256`, `envelope_version`,
`content_fingerprint`, `scan_verdict`, `expires_at`, `kind`, `bucket_role`, `last_read_at` and
`deleted_at` are all columns. None of them appears in a key. This one rule generates §6 (no extension
on originals), §7 (immutability), and the rejection of `i`'s `{yyyy}/{mm}` (a *derived* segment whose
input is a correctable column).

### 5.2 What may legally become a path byte

Exactly four classes, and the minter's type signature admits nothing else:

| Class | Examples | Why it is safe |
|---|---|---|
| **A. Branded server identifiers** | `orgId`, `docPub`, `exportPub` | Producible only by the constructors in the storage-keys package, which are called only on values read from columns carrying a database `CHECK` (`f1` `id.external.shape`) or typed `uuid`. |
| **B. Bounded server integers, fixed-width formatted** | `page:05d`, `runSeq:04d`, `dpi`, `width` | Range-checked at the branded-constructor boundary; formatted, so the output alphabet is `[0-9]` regardless of input. |
| **C. Fixed-alphabet digests of a server-canonicalised structure** | `recipeHash` | The output alphabet of a hex-encoded SHA-256 is `[0-9a-f]` and its length is constant **whatever the input is**. Hashing is a sanctioned laundering step; concatenation is not. |
| **D. Closed literal unions** | namespace segment, `ext`, `engineSlug` (from a registry) | The set of possible values is enumerated in `config/storage-keys.yaml` and exhaustiveness is a `tsc` error. |

Class C is the interesting one and it is what makes the `recipeHash` acceptable even though a tenant
influences the recipe (a tenant may request deskew on or off). A tenant-influenced *value* passing
through SHA-256 cannot introduce a byte outside `[0-9a-f]` or change the segment's length. A
tenant-influenced value passing through string concatenation can. The rule is therefore stated as a
property of the *transform*, not of the input's provenance.

### 5.3 Decision C1-5 — the shard is a prefix, and here that is safe

**Competing proposals.** (a) `i` §2.2: `shard = sha256(documentId).hex[0:2]`, with an explicit warning
that a *prefix* shard is unsafe. (b) `g`, `j`, `l`: no shard at all.

**Selected: `sh = publicId.toLowerCase().slice(0, 2)` — a prefix.**

**Rejected: (b), no shard.** `g` §11 projects 240,000 documents/year. Without a shard that is 240,000
sibling entries per organisation-year under `original/`, and `i` §2.2's measured concern applies:
`getdents64` over such a directory is a multi-second stall that blocks the Node threadpool, and the
GC reconciler's `readdir` + per-entry `stat` is the operational pain rather than the lookup.

**Rejected: (a), a hashed shard — but only because the input changed.** `i` §2.2 is *correct for the
ids `i` had*: UUIDv7 and ULID both lead with a 48-bit millisecond, so every document created in a
given month shares its first ~7 characters and a prefix shard would place a whole month in one or two
buckets. `f1` `id.external.shape` replaced that input with `crypto.randomBytes(20)`. A prefix of a
CSPRNG output is uniform by definition, so the SHA-256 buys nothing and costs one hash per mint plus
a second identifier the ops team must compute by hand to find a file.

**Reason.** 2 characters of Crockford base32 = **1,024** buckets; at 240,000 documents/organisation-
year that is ~234 entries per directory per year, which `readdir` returns in a single syscall buffer.
Directories are created lazily on write, so a small organisation with five documents creates at most
five shard directories, not 1,024.

**Implementation consequence.** `shardOf(pub)` is two characters of a `slice`. The property test
asserts that over 10^6 random `public_id`s the χ² statistic against a uniform 1,024-bucket
distribution does not exceed the 99.9th percentile — the test that would have caught `i`'s hazard
had it been written for the old ids.

**Migration consequence.** The shard is a pure function of a segment already in the key, so a future
change from 2 characters to 1 or 3 is *still* a full key rewrite. It is priced in §12 like everything
else, which is why the number is chosen against a 10-year projection and not a 1-year one.

**Security consequence.** None; the shard discloses 10 bits of an identifier that is already in the
next segment.

**Config/env consequence.** `storage.shard_chars = 2` in `config/storage-keys.yaml`. Not an
environment variable: changing it changes every future key while every existing key keeps the old
shape, so it must be a code change with a migration, not a restart.

### 5.4 `recipeHash` — 128 bits, and exactly what goes into it

```
recipeHash = sha256(canonicalJson(renderRecipe)).hex.slice(0, 32)   // 32 lowercase hex chars, 128 bits

renderRecipe = {
  pipelineVersion: string,        // semver of the render pipeline
  renderer:        string,        // e.g. "pdfium"
  rendererVersion: string,
  encoder:         "png" | "tif" | "jpg" | "webp",
  encoderQuality:  integer,       // 0..100; 100 for lossless encoders
  dpi:             integer,       // f2 RENDER_DPI_DEFAULT unless overridden
  colorspace:      "gray" | "rgb" | "bilevel",
  rotationDeg:     0 | 90 | 180 | 270,
  deskew:          { enabled: boolean, algorithm: string, version: string },
  denoise:         { enabled: boolean, algorithm: string, version: string },
  binarise:        { enabled: boolean, algorithm: string, version: string },
  cropPolicy:      "mediabox" | "cropbox" | "trimbox"
}
```

`canonicalJson` = keys sorted lexicographically, no whitespace, no `undefined`, integers only.
`sha256(...)` truncated to 128 bits: this is a cache discriminator inside one document's directory,
not a security boundary, and 128 bits against a lifetime population of at most ~10^7 distinct recipes
has a collision probability below 10^-25.

**The contents of `renderRecipe` are owned by `e-native-extraction-routing.md` / `f-preprocessing-and-
confidence.md`, and every *threshold* that selects a value for one of its fields — DPI ladder, tiling
floor, deskew and binarise gates — is owned by `c3-ocr-routing-policy.md` and is not restated here.**
This document owns only the *canonicalisation and truncation*, and the invariant that follows from it:
**the recipe schema is append-only.** Adding a field changes every future hash (fine — new keys, old
renders still readable and still referenced by their rows). Removing or renaming a field silently
changes the hash of an *unchanged* recipe and orphans every existing render in one deploy. A CI check
compares the recipe schema's field list against a checked-in snapshot and fails on any removal.

**Why `recipeHash` and not `runSeq` for renders.** `f1` `uniq.document_run_seq` makes a requeue
allocate a new run. If renders were keyed by run, every requeue would re-render every page — at
`f2`'s frozen `MAX_OCR_PAGES_PER_DOCUMENT` × `PROVISIONAL_PER_PAGE_OCR_S` (50 × 25 s, both values
owned by `f2` and quoted here only for this arithmetic) that is up to 1,250 seconds of work thrown
away to retry, say, a gateway timeout. Keyed by recipe, an unchanged recipe is a cache hit and the
requeue skips rendering entirely; a changed recipe gets a new key, so `l` §4.4's
`Cache-Control: immutable` stays truthful and `g` §7.4's "a renderer upgrade must not silently reuse
stale pixels" is satisfied.

### 5.4.1 Decision C1-16 — the preview hash is *not* the render hash

**Competing proposals.** (a) `PAGE_PREVIEW` reuses the render's `recipeHash` (the first draft of this
document, and the shape implied by `l` §4.4). (b) `PAGE_PREVIEW` carries its own hash over the render
recipe extended with the preview profile.

**Selected: (b).**

```
previewProfile = {
  downscaler:        string,     // e.g. "lanczos3"
  downscalerVersion: string,     // the imaging library's version
  sharpenAmount:     integer,    // 0..100
  webpQuality:       integer,    // 0..100
  webpMethod:        integer     // 0..6
}
previewHash = sha256(canonicalJson({ ...renderRecipe, preview: previewProfile })).hex.slice(0, 32)
```

`width` is deliberately **not** in the hash: it is already an explicit element of the filename, and
putting a value in two places is the drift `l`'s `w` element exists to avoid.

**Rejected: (a) — it reintroduces the exact bug §5.4 was written to prevent, one namespace over.**
Under (a), upgrading the imaging library from a box filter to Lanczos, or changing WebP quality from
80 to 90, produces *visually different* preview bytes at an *unchanged* key. `l` §4.4 serves previews
with `Cache-Control: immutable`, so every browser and every CDN in front of the product would continue
to serve the old pixels indefinitely, and `putImmutable` would report `created:false` — a cache hit —
so the new bytes would never be written at all. The reviewer would be drawing correction boxes on a
stale image. This matters more for Thai than for Latin script: the tone marks and vowel signs that
distinguish ก่ from ก้ occupy roughly 3 px at the preview widths, so a downscaler change is precisely
the change that alters whether a human reviewer can read the character they are being asked to confirm.

**Reason.** The rule from §5.4 is that a key changes iff the bytes could change. The preview bytes
depend on the preview profile; therefore the preview key must.

**Implementation consequence.** `PAGE_PREVIEW`'s `KeySpec` field is named `preview: PreviewHash`, a
brand distinct from `RecipeHash`, so a `tsc` error — not a review — catches someone passing the render
hash. Both brands are 32 lowercase hex characters, which is exactly why they must be different types.

**Migration consequence.** None if decided now. If (a) ships, the correction is not a key migration —
it is worse in one respect and better in another: the *keys* need not move, but every existing preview
must be deleted and re-rendered, and every cached copy in every browser is unreachable until its
`immutable` lifetime expires.

**Security consequence.** Minor and positive: it removes a case where an attacker who can influence
the preview profile (a tenant setting) could cause a *different* tenant's cached preview to be served,
because the profile is now inside the cache key rather than outside it.

**Config/env consequence.** None. `previewProfile`'s field *values* are owned by `f`; its presence in
the hash is owned here.

### 5.5 `engineSlug` — and the correction of a claim that was simply false

```
engineSlug = trimHyphens(
               (slug(engineId) + "-" + slug(engineVersion)).slice(0, 32)
             )
slug(s)    = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
trimHyphens(s) = s.replace(/-+$/g, "")          // truncation can land on a hyphen
```

Asserted against `^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$` after construction. Note the regex is **not**
`^[a-z0-9][a-z0-9-]{0,31}$`: that form admits a trailing hyphen, which `slice(0,32)` can produce and
which then renders as `…-tesseract-5-5--d300.json.zst`. The doubled hyphen still parses (the closing
round-trip of §8.2 guarantees it), but it is an ugly, avoidable ambiguity in a filename an operator
reads during an incident. The corrected regex also forces a minimum length of 2, so an `engineId` of
`๑` — Thai digit one, which `slug()` maps to the empty string — fails at the constructor instead of
producing a zero-length segment.

The *unslugged* `engineId` and `engineVersion` are stored verbatim in `ocr_results` and are the
authoritative record; the slug is a lossy, human-readable echo.

> **Correction to the first draft.** It claimed: *"If two engine versions ever slugged identically,
> the database rejects the second row before any key is minted."* **That is false, and it hid a real
> evidence-integrity defect.** `f1` `uniq.ocr_result` is `(documentPageId, runId, engineId,
> engineVersion, renderDpi)` over the **real** columns, so two *distinct* engine versions are two
> perfectly legal, distinct rows. The database has no reason to reject either. But if they slug
> identically — `tesseract 5.5.1` and `tesseract 5.5-1`, or any pair colliding past the 32-character
> truncation — both rows mint the **same** `ENGINE_PAYLOAD` key. `putImmutable` then returns
> `created:false`, which §7.1 classifies as a legitimate cache hit for a derivative, and the second
> `ocr_result` row's `payload_ref` silently points at the **first** row's payload. Two pieces of
> immutable evidence, one body, no error. The lossy slug is only safe if it is injective, and nothing
> in the first draft made it so.

**The fix, in three parts.**

1. **`engineSlug` comes from the engine registry, never from a free-form version string.** The
   registry is `config/engines.yaml`, generated into both runtimes, and each entry carries an explicit
   `slug` field. Deriving it is a *default*, not a mechanism.
2. **Registry-wide slug uniqueness is asserted at boot and in CI.** `OCR_ENGINE_SLUG_UNIQUE`: the set
   of slugs over all registry entries must have the same cardinality as the set of
   `(engineId, engineVersion)` pairs. Violation is a boot refusal (exit 78), not a warning, because the
   failure it prevents is silent.
3. **`created:false` on `ENGINE_PAYLOAD` is verified, not assumed.** Because a worker retry *within*
   a run legitimately re-mints the same payload key (`f1` `uniq.ocr_result`: "within a run, a worker
   retry is idempotent"), `created:false` cannot simply be an error the way it is for `ORIGINAL`. It
   is instead checked: the writer compares the stored object's `plaintext_sha256` with the digest of
   the bytes it was about to write. Equal ⇒ idempotent retry, skip. **Unequal ⇒
   `SEC_OBJECT_KEY_COLLISION`, severity CRITICAL, the job fails closed.** One extra `HEAD` on a path
   that is already rare.

### 5.6 Decision C1-17 — the recipe is tenant-influenced, so its cardinality must be bounded

**Competing proposals.** (a) No bound — the first draft, and every M0 grammar. (b) A per-document cap
on the number of distinct render recipes, with LRU eviction of unreferenced render sets.

**Selected: (b), `MAX_RECIPES_PER_DOCUMENT = 4`.**

**Rejected: (a) — it is an unbounded storage-amplification vector wearing a cache's clothes.** §5.2
class C establishes that a tenant-influenced value passing through SHA-256 cannot introduce a byte
outside `[0-9a-f]` or change a segment's length, and that argument is correct as far as it goes. It
says nothing about **cardinality**. A tenant who can request deskew on/off, a DPI, a colourspace and a
rotation can mint a fresh `recipeHash` per request, and each one is a full page-render set: at
`f2`'s render budget that is up to 50 rendered pages per recipe, each up to `f2`
`MAX_PAGE_RENDER_BYTES`. Twenty requests with twenty flag combinations is a four-figure multiple of
the document's own size, produced by an authenticated user doing nothing the API forbids. `f2`
`DEFAULT_STORAGE_QUOTA_BYTES` is the only backstop and it is per **organisation**, so the amplification
lands on the victim's own quota before it lands on ours — which makes it a denial-of-service against a
paying tenant rather than merely a cost to us.

**Reason.** Four covers every legitimate case we can name: the default recipe, one operator requeue at
a different DPI, one deskew-toggled retry, and one renderer-version bump. A fifth simultaneous live
recipe for one document is a bug or an attack, and in either case failing loudly is right.

**Implementation consequence.** The render use case counts `SELECT count(DISTINCT recipe_hash)` over
that document's live `PAGE_RENDER` rows before minting. At the cap it evicts the least-recently-read
recipe set **that no `ocr_results` row references** (a referenced render set is evidence and is never
evicted); if every set is referenced, it returns `429` with `ERROR_CODE_QUOTA`'s windowed code
(`f2` owns the code). Derivatives — renders, previews, payloads and exports — **count against the
tenant storage quota** on their ciphertext `size_bytes`. Stating this is necessary: `f2`
`QUOTA_CHECK_ORDERING` requires the check before the storage PUT, and a quota that counted only
originals would have made this entire attack free.

**Migration consequence.** None — a counted `SELECT` and a config constant.

**Security consequence.** Converts an unbounded amplification into a bounded one with a numeric
ceiling and an audit trail. `storage_recipe_cap_reached_total{organization_id}` is the metric; three
hits in an hour for one document is the alert.

**Config/env consequence.** `OCR_STORAGE_MAX_RECIPES_PER_DOCUMENT = 4`, and
`OCR_STORAGE_DERIVATIVES_COUNT_AGAINST_QUOTA = true` (only legal value; the constant exists so that
turning it off trips a review, in the same spirit as `OCR_STORAGE_DEDUP_MODE`).

---

## 6. Extension policy

### 6.1 Decision C1-6 — `ORIGINAL` carries no extension

**Competing proposals.** `i` §2.1: `.{ext}` from `ALLOWED_MEDIA`, keyed on the **sniffed** media type.
`j` §3.8: `original.{detectedExt}`. `g` §7.4 and `l` §3.3: no extension on the original.

**Selected: no extension on `ORIGINAL`.**

**Rejected: an extension derived from magic bytes.** It is better than deriving one from the upload —
which is why `i` and `j` chose it — but it still puts a **classifier's verdict** into an **immutable
path**. `file-type` v22.0.2 (`j` §3.1, verified) reads a 4,100-byte sample; a future version, a
different sample size, or a container-format edge case can classify the same bytes differently. Under
`i`/`j` that produces a *different key for the same object*, which is either a re-write of an
immutable key or a permanent disagreement between the row and the store. The requirement in the
owner's brief — "the extension policy (derived from verified magic bytes, never from the upload)" — is
satisfied more strongly by having no extension at all: the strongest form of "never derived from the
upload" is "not present".

**Reason.** `i` §2.2 gives three operational reasons for `.ext` — `file`/`ls` readability during an
incident, S3-console preview, CDN tooling. All three apply to derivatives and all three survive,
because derivatives keep their extensions. For originals, `file(1)` reads content and does not need a
name, the S3 console cannot preview a ciphertext anyway (§10), and no CDN ever serves an original.
`i` §7.2 already states that the response `Content-Type` comes from `storage_objects.content_type`
and never from the extension — so the extension was already non-authoritative; removing it removes a
second representation of a fact rather than removing information.

**Implementation consequence.** `documents.declared_content_type` (what the client said, retained for
diagnostics only), `storage_objects.content_type` (the sniffed verdict, authoritative for the
response header). The sniffer may be re-run and the column corrected without touching a single key.

**Migration consequence.** Re-classifying an object is an `UPDATE` of one column, not a key rewrite.
Under `i`/`j` it would have been a key rewrite — see §12 for what that costs.

**Security consequence.** Removes the only path by which a content-sniffer disagreement becomes a
storage inconsistency, and removes any temptation to serve `Content-Type` from a path suffix.

**Config/env consequence.** None.

### 6.2 The closed suffix map, for derivatives only

```yaml
# config/storage-keys.yaml (excerpt) — the ONLY definition of a suffix
suffixes:
  PAGE_RENDER:    [png, tif, jpg]        # chosen by recipe.encoder; recipe.encoder is in recipeHash
  PAGE_PREVIEW:   [webp]                 # fixed; l §4.4
  ENGINE_PAYLOAD: [json.zst]             # fixed
  EXPORT:         [csv, xlsx, json, pdf, zip]
  ORIGINAL:       []                     # deliberately empty
```

`json.zst` is a two-dot suffix. It is legal: `i`'s alphabet permits an interior `.`, and the validator
forbids only a segment that *starts* with `.` or that *is* `.`/`..`. AWS's own guidance (verified,
§9.1) confirms the distinction: `folder/..backup/file.txt` "works normally", `folder/../file.txt` does
not.

Which export format is offered is `l`'s decision; this document owns only the mapping from a format
to a suffix, and the rule that the set is closed and generated.

---

## 7. Immutability

### 7.0 Decision C1-7 — the key is written once, in the eight-part form

**Competing proposals.**
(a) `i` §2.1: a fresh object id (`{oid}`) per write, so re-rendering a derivative produces a *new*
key and the old one is garbage.
(b) `g` §7.4 / `l` §4.4: keys are stable but nothing enforces it; immutability is a convention in
prose.
(c) The key is written once and enforced by a `BEFORE UPDATE` trigger; `bucket_role` is the single
exception and moves one way only.

**Selected: (c).**

**Rejected: (a) — unbounded orphans by design.** A fresh id per write means every re-render of page 7
leaves the previous bitmap addressed by a key nothing references. `i` has a GC reconciler, but a
reconciler that must run for *correctness* rather than for tidiness is a permanent operational
liability, and at `g` §11's fan-out it walks 1.68 M objects. Worse, it makes `l` §4.4's
`Cache-Control: immutable` meaningless: the URL changes on every render, so nothing is ever cached.

**Rejected: (b) — a convention is not an invariant.** The whole reason this document exists is that
four M0 authors each held a different convention. `payload_ref` is a key inside an append-only
evidence table; the cost of one wrong `UPDATE` is §12. That is exactly the size of consequence that
justifies a trigger.

**Reason.** Immutability is what makes every other guarantee in this contract cheap: caching is
truthful, the parser's round-trip closure is total, orphan reclamation is well-defined, and a
per-document credential scope (§9.4) can be issued without wondering whether the key it names will
still be the key tomorrow.

**Implementation consequence.** §7.1's three consequences and §7.2's trigger. `putImmutable` is the
only writer; `reclaimOrphan` is the only sanctioned overwrite and it is a distinct, audited function.

**Migration consequence.** None to adopt. The *consequence* of the invariant is §12: a grammar change
becomes a data migration rather than a rename, which is the price paid for everything above and is why
§12 prices it in full.

**Security consequence.** Two. A signed URL minted for a key remains a reference to the same bytes for
its whole lifetime, so a time-of-check/time-of-use swap of the object behind a live URL is impossible
through the application. And `bucket_role`'s one-way transition means a quarantined object cannot be
returned to the serving root by any code path, including a mistaken one — `g` §4.1's "`QUARANTINED` is
absolutely terminal" becomes true at the byte layer, not just at the row layer.

**Config/env consequence.** None. Immutability is not tunable; that is the point.

### 7.1 The invariant

> **No object key is ever written twice with different bytes, and no row's `object_key` ever changes.**

Three consequences, all of which the M0 grammars violated somewhere:

1. **A reprocess never rewrites a key.** `ORIGINAL` is identity-addressed by a `public_id` that
   `f1` VIS-1 makes immutable, so it is byte-identical across every run forever. `PAGE_RENDER`
   changes key iff the render recipe, the page or the **tile index** changes (§4.8); `PAGE_PREVIEW`
   iff the render recipe, the **preview profile** (§5.4.1), the page or the width changes.
   `ENGINE_PAYLOAD` changes key iff the run, page, engine, version or DPI changes — i.e. exactly when
   `f1` `uniq.ocr_result` says it is a different row.
2. **A same-recipe requeue is a cache hit, not a collision — but which of the two it is must be
   *decided*, never assumed.** `putImmutable(key, stream)` returns `{ created: true }` or
   `{ created: false, existing }`. The first draft said `created:false` is a legitimate skip for any
   derivative and an unconditional CRITICAL for `ORIGINAL`. **Both halves were wrong**, and §7.1.1
   replaces them with a decision table.
3. **Orphan reclamation is the one sanctioned overwrite.** An object whose key has no non-deleted
   `storage_objects` row **and** whose store mtime is older than `ORPHAN_MIN_AGE_S` is a crashed-run
   leftover. `reclaimOrphan(key)` deletes then re-puts, in one code path, with an audit row. Without
   the age floor, a concurrent in-flight write looks exactly like an orphan — see §7.3 for the
   derivation of the floor, which the first draft asserted as a bare `3600`.

### 7.1.1 `putImmutable` — the decision table that replaces two wrong rules

The first draft's `ORIGINAL` rule was **wrong in the direction that breaks ordinary retries**. The
upload is two-phase (`f1` `id.internal`: ids exist before the row), so the key is minted at upload
*init*. A worker or client that crashes after the bytes land but before the row commits, and then
retries the same upload, re-mints the **same** key — because the key is a pure function of the
document's immutable `public_id`. Under the first draft that ordinary, expected retry raised a
CRITICAL security alert. Conversely, the derivative rule was wrong in the direction that hides a real
defect (§5.5's slug collision, §4.8's missing tile).

Under identity addressing, `key ⇒ document` is a function, so a same-key write can only ever come from
the same document. The question is therefore never "whose object is this" — it is "are these the same
bytes":

| Kind | `created:false`, live row exists for this key | `created:false`, no live row (orphan) |
|---|---|---|
| `ORIGINAL` | The row's `plaintext_sha256` equals the digest of the bytes being written ⇒ **idempotent retry, skip, return the existing row.** Unequal ⇒ `SEC_OBJECT_KEY_COLLISION`, CRITICAL, fail closed — this is either a `public_id` reuse (a CSPRNG or id-generation failure) or a store that returned the wrong object. | Crashed prior attempt for **this same document**. Permitted overwrite **only** inside the same upload use case that owns this `public_id`, with an `AuditLog` row; the `ORPHAN_MIN_AGE_S` floor does **not** apply, because the caller holds proof of ownership rather than inferring it from age. |
| `PAGE_RENDER`, `PAGE_PREVIEW`, `EXPORT` | **Legitimate cache hit.** Skip. The key already encodes everything that determines the bytes (recipe or preview hash, page, tile, width, export id), so equal keys mean equal bytes by construction. | Reclaim per §7.1 item 3, under the age floor. |
| `ENGINE_PAYLOAD` | Compare digests (§5.5). Equal ⇒ idempotent worker retry within the run, skip. **Unequal ⇒ `SEC_OBJECT_KEY_COLLISION`, CRITICAL**, because the payload key does *not* encode everything that determines the bytes — `engineSlug` is lossy. | Reclaim per §7.1 item 3, under the age floor. |

`plaintext_sha256` is a column on `storage_objects`, distinct from `content_fingerprint` (which is the
per-organisation HMAC of §3.1 and is a *hint*). It is the digest of the plaintext, computed while
streaming, before encryption — so it is comparable across two writes of the same bytes even though
their ciphertexts differ by construction (§10).

### 7.2 Enforced in the database, not in prose

```sql
CREATE TYPE storage_bucket_role AS ENUM ('PRIMARY', 'QUARANTINE');

CREATE OR REPLACE FUNCTION storage_object_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- (1) identity and tenancy: never.
  IF NEW.object_key      IS DISTINCT FROM OLD.object_key
  OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
  OR NEW.kind            IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'STORAGE_IDENTITY_IMMUTABLE: object_key/organization_id/kind may never be updated (id=%)',
      OLD.id USING ERRCODE = '42501';
  END IF;

  -- (2) the bytes' fingerprint and geometry: never. A row that could be re-pointed at different
  --     bytes is not evidence, and storage_objects backs ocr_results.payload_ref.
  IF NEW.plaintext_sha256 IS DISTINCT FROM OLD.plaintext_sha256
  OR NEW.size_bytes       IS DISTINCT FROM OLD.size_bytes
  OR NEW.plaintext_bytes  IS DISTINCT FROM OLD.plaintext_bytes
  OR NEW.envelope_version IS DISTINCT FROM OLD.envelope_version THEN
    RAISE EXCEPTION 'STORAGE_CONTENT_IMMUTABLE: content columns may never be updated (id=%)',
      OLD.id USING ERRCODE = '42501';
  END IF;

  -- (3) bucket_role: exactly one transition, PRIMARY -> QUARANTINE, compared against ENUM LITERALS.
  --     No current_setting(), no configuration, nothing that can be absent. Absence was the defect:
  --     current_setting(name, true) returns NULL when unset, so `TRUE AND NOT (NULL AND ...)`
  --     evaluated to NULL, the IF did not fire, and EVERY transition was silently permitted.
  IF NEW.bucket_role IS DISTINCT FROM OLD.bucket_role
     AND NOT (OLD.bucket_role = 'PRIMARY' AND NEW.bucket_role = 'QUARANTINE') THEN
    RAISE EXCEPTION 'STORAGE_BUCKET_TRANSITION_ILLEGAL: % -> % (id=%)',
      OLD.bucket_role, NEW.bucket_role, OLD.id USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER storage_object_immutable_trg
  BEFORE UPDATE ON storage_objects
  FOR EACH ROW EXECUTE FUNCTION storage_object_immutable();
```

Columns deliberately left **mutable**: `content_type` (a re-run sniffer verdict — §6.1's whole point),
`deleted_at` (soft delete), `last_read_at` (LRU input for §5.6), and `scan_verdict` if the row carries
one. Everything an object *is* is frozen; everything we have *learned about* it is not.

The one-way `PRIMARY → QUARANTINE` transition is the only mutation of `bucket_role` the trigger
permits; `QUARANTINE → PRIMARY` raises. `g` §4.1's argument for `QUARANTINED` being absolutely
terminal — "if a verdict was a false positive, the correct action is to delete the document and
re-upload" — is thereby true at the byte layer as well as at the row layer.

**Two negative tests, in the migration's own test file, because a fail-open guard passes every
positive test.** (i) `UPDATE storage_objects SET bucket_role='PRIMARY' WHERE bucket_role='QUARANTINE'`
raises `42501` **on a connection with no GUCs set at all**; (ii) `UPDATE … SET object_key = object_key`
succeeds (an unchanged value is not a change), while any different value raises.

### 7.3 `ORPHAN_MIN_AGE_S` is derived, not chosen

The first draft asserted `3600` with the justification "without the age floor, a concurrent in-flight
write looks exactly like an orphan". That is the right *reason* and no derivation, which is the defect
class this milestone exists to remove. The floor must exceed the longest interval that can elapse
between an object's bytes landing in the store and its `storage_objects` row committing:

```
ORPHAN_MIN_AGE_S  >=  2 x (f2.JOB_PROCESSING_BUDGET_MS / 1000)
                  =   2 x 1800                                   # value owned by f2, quoted for the arithmetic
                  =   3600
```

The factor of two is deliberate: one budget covers the claim in which the object was written, the
second covers a lease loss and a re-claim in which the same object is written again before either row
commits. `f2` `JOB_PROCESSING_BUDGET_MS` is **per claim** and resets on every claim, which is exactly
why one budget is not enough.

`f3` `ai.job.budget_ms`'s 120-minute ceiling does **not** enter this derivation, and stating why
matters: `f3` `ai.spool.volume` gives `ocr-ai-worker` no mount of the object store at all, so no AI
job can be the writer of an object-store object. If that ever changes, this floor changes with it.

A boot assertion enforces the inequality rather than the number:
`OCR_STORAGE_ORPHAN_MIN_AGE_S >= 2 * f2.JOB_PROCESSING_BUDGET_MS / 1000`, exit 78 on failure. A future
`f2` increase to the job budget therefore refuses to boot instead of silently enabling the GC to
delete live bytes.

**Erasure interacts with this and must not be confused with it.** A crypto-shredded object (`gate-2`
D-G2-8) still has a live `storage_objects` row until its sweeper runs, so it is never an orphan. The
orphan reconciler keys on *row absence*, never on readability, and must not attempt to decrypt
anything — an object it cannot read is not evidence that it is garbage.

---

## 8. The code

### 8.1 Types and the minter (TypeScript, generated)

```ts
// packages/ocr-storage-keys/src/index.ts
// GENERATED from config/storage-keys.yaml by scripts/gen-storage-keys.ts — do not hand-edit.
// CI asserts sha256(this file) against config/storage-keys.lock.json.

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type ObjectKey       = Brand<string, 'ObjectKey'>;
export type KeyPrefix       = Brand<string, 'KeyPrefix'>;
export type OrganizationId  = Brand<string, 'OrganizationId'>;   // lowercase hyphenated uuid
export type DocumentPublicId= Brand<string, 'DocumentPublicId'>; // 32 Crockford base32, UPPER in DB
export type ExportPublicId  = Brand<string, 'ExportPublicId'>;
export type RecipeHash      = Brand<string, 'RecipeHash'>;       // 32 lowercase hex — RENDER recipe
export type PreviewHash     = Brand<string, 'PreviewHash'>;      // 32 lowercase hex — recipe ⊕ preview profile.
                                                                 // A DISTINCT brand from RecipeHash on purpose:
                                                                 // both are 32 hex chars, so only the type
                                                                 // system can stop §5.4.1's stale-pixel bug.
export type EngineSlug      = Brand<string, 'EngineSlug'>;
export type PageNumber      = Brand<number, 'PageNumber'>;
export type TileIndex       = Brand<number, 'TileIndex'>;
export type RunSeq          = Brand<number, 'RunSeq'>;
export type RenderDpi       = Brand<number, 'RenderDpi'>;
export type BucketRole      = 'PRIMARY' | 'QUARANTINE';          // a closed union, never a bucket name

export const PREVIEW_WIDTHS = [400, 800, 1600, 2400] as const;   // l §4.4
export type  PreviewWidth   = (typeof PREVIEW_WIDTHS)[number];
export const RENDER_EXTS    = ['png', 'tif', 'jpg'] as const;
export type  RenderExt      = (typeof RENDER_EXTS)[number];
export const EXPORT_EXTS    = ['csv', 'xlsx', 'json', 'pdf', 'zip'] as const;
export type  ExportExt      = (typeof EXPORT_EXTS)[number];

export const SHARD_CHARS        = 2;
export const TILE_DIGITS        = 2;
export const KEY_MAX_BYTES      = 512;
export const SEGMENT_MAX_BYTES  = 64;
export const SEGMENT_MIN_COUNT  = 5;
export const SEGMENT_MAX_COUNT  = 7;

// ---- branded constructors: the ONLY doors into the brands -------------------
const UUID_RE   = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PUBID_RE  = /^[0-9A-HJKMNP-TV-Z]{32}$/;            // f1 id.external.shape, uppercase in DB
const HEX32_RE  = /^[0-9a-f]{32}$/;
const SLUG_RE   = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/;   // §5.5: NO trailing hyphen, min length 2

export class StorageKeyError extends Error {
  constructor(readonly code: 'invalid-key' | 'invalid-id' | 'invalid-prefix', msg: string) {
    super(msg); this.name = 'StorageKeyError';
  }
}
const bad = (c: StorageKeyError['code'], m: string): never => { throw new StorageKeyError(c, m); };

export const organizationId   = (s: string): OrganizationId   =>
  (UUID_RE.test(s.toLowerCase()) ? s.toLowerCase() : bad('invalid-id', 'organizationId')) as OrganizationId;
export const documentPublicId = (s: string): DocumentPublicId =>
  (PUBID_RE.test(s) ? s : bad('invalid-id', 'documentPublicId')) as DocumentPublicId;
export const exportPublicId   = (s: string): ExportPublicId   =>
  (PUBID_RE.test(s) ? s : bad('invalid-id', 'exportPublicId')) as ExportPublicId;
export const recipeHash       = (s: string): RecipeHash       =>
  (HEX32_RE.test(s) ? s : bad('invalid-id', 'recipeHash')) as RecipeHash;
export const previewHash      = (s: string): PreviewHash      =>
  (HEX32_RE.test(s) ? s : bad('invalid-id', 'previewHash')) as PreviewHash;
export const engineSlug       = (s: string): EngineSlug       =>
  (SLUG_RE.test(s) ? s : bad('invalid-id', 'engineSlug')) as EngineSlug;

const int = <B extends string>(n: number, lo: number, hi: number, what: B) =>
  (Number.isSafeInteger(n) && n >= lo && n <= hi ? n : bad('invalid-id', what)) as Brand<number, B>;
// Grammar widths, NOT policy limits — see §4.1.1. The policy caps are f2's and are enforced at
// admission, in a different layer, so that changing a limit is a restart and not a key migration.
export const pageNumber = (n: number) => int(n, 1, 99_999, 'PageNumber') as PageNumber;
export const tileIndex  = (n: number) => int(n, 1, 99,     'TileIndex')  as TileIndex;
export const runSeq     = (n: number) => int(n, 1, 9_999,  'RunSeq')     as RunSeq;
export const renderDpi  = (n: number) => int(n, 100, 9_999,'RenderDpi')  as RenderDpi;

// ---- the spec: a closed discriminated union, no free strings ----------------
export type KeySpec =
  | { kind: 'ORIGINAL';       org: OrganizationId; doc: DocumentPublicId }
  | { kind: 'PAGE_RENDER';    org: OrganizationId; doc: DocumentPublicId;
      recipe: RecipeHash; page: PageNumber; tile?: TileIndex; ext: RenderExt }
  | { kind: 'PAGE_PREVIEW';   org: OrganizationId; doc: DocumentPublicId;
      preview: PreviewHash; page: PageNumber; width: PreviewWidth }
  | { kind: 'ENGINE_PAYLOAD'; org: OrganizationId; doc: DocumentPublicId;
      run: RunSeq; page: PageNumber; engine: EngineSlug; dpi: RenderDpi }
  | { kind: 'EXPORT';         org: OrganizationId; exp: ExportPublicId; ext: ExportExt };

const lc  = (id: string) => id.toLowerCase();                       // bijective: Crockford has no I/L/O/U
const sh  = (id: string) => lc(id).slice(0, SHARD_CHARS);
const pad = (n: number, w: number) => String(n).padStart(w, '0');

/**
 * The ONLY function permitted to produce an ObjectKey.
 *
 * NOTE THE SIGNATURE. There is no `filename`, no `contentType`, no `headers`, no `options`,
 * no `string`, no `unknown`, no index signature. Every field is a brand produced by a
 * constructor above, a bounded integer, or a member of a closed literal union. There is no
 * parameter through which a client-controlled byte can travel. See §8.3 for the proof.
 */
export function mintObjectKey(spec: KeySpec): ObjectKey {
  const o = spec.org;
  let key: string;
  switch (spec.kind) {
    case 'ORIGINAL':
      key = `org/${o}/original/${sh(spec.doc)}/${lc(spec.doc)}`;
      break;
    case 'PAGE_RENDER': {
      // The tile element is present iff the page was tiled (§4.8). `undefined` and a present
      // TileIndex are two total renderings; there is no third, and no `-t00`.
      const t = spec.tile === undefined ? '' : `-t${pad(spec.tile, TILE_DIGITS)}`;
      key = `org/${o}/render/${sh(spec.doc)}/${lc(spec.doc)}/${spec.recipe}` +
            `/p${pad(spec.page, 5)}${t}.${spec.ext}`;
      break;
    }
    case 'PAGE_PREVIEW':
      key = `org/${o}/preview/${sh(spec.doc)}/${lc(spec.doc)}/${spec.preview}` +
            `/p${pad(spec.page, 5)}-w${spec.width}.webp`;
      break;
    case 'ENGINE_PAYLOAD':
      key = `org/${o}/payload/${sh(spec.doc)}/${lc(spec.doc)}/r${pad(spec.run, 4)}` +
            `/p${pad(spec.page, 5)}-${spec.engine}-d${spec.dpi}.json.zst`;
      break;
    case 'EXPORT':
      key = `org/${o}/export/${sh(spec.exp)}/${lc(spec.exp)}.${spec.ext}`;
      break;
    default: {
      const never: never = spec;                       // exhaustiveness is a tsc error
      throw new StorageKeyError('invalid-key', `unreachable ${JSON.stringify(never)}`);
    }
  }
  return assertSafeObjectKey(key);                     // the minter validates its own output
}

/** The only sanctioned prefixes. Both take brands, so no request string can reach them. */
export const orgPrefix      = (o: OrganizationId): KeyPrefix =>
  assertSafeKeyPrefix(`org/${o}/`);
export const namespacePrefix = (o: OrganizationId, ns: KeySpec['kind']): KeyPrefix =>
  assertSafeKeyPrefix(`org/${o}/${NAMESPACE[ns]}/`);
export const documentPrefix  = (o: OrganizationId, ns: 'PAGE_RENDER' | 'PAGE_PREVIEW' | 'ENGINE_PAYLOAD',
                                d: DocumentPublicId): KeyPrefix =>
  assertSafeKeyPrefix(`org/${o}/${NAMESPACE[ns]}/${sh(d)}/${lc(d)}/`);

export const NAMESPACE = {
  ORIGINAL: 'original', PAGE_RENDER: 'render', PAGE_PREVIEW: 'preview',
  ENGINE_PAYLOAD: 'payload', EXPORT: 'export',
} as const satisfies Record<KeySpec['kind'], string>;
```

### 8.2 The structural validator and the total parser

```ts
// packages/ocr-storage-keys/src/parse.ts   (GENERATED)

/** ASCII lowercase alnum plus '/', '.', '-'. Must start and end with [0-9a-z].
 *  '_' is deliberately NOT in the alphabet: nothing in this grammar produces one, and a
 *  smaller alphabet is a smaller attack surface. This narrows i §3.2's KEY_RE. */
const KEY_RE = /^[0-9a-z](?:[0-9a-z.\-/]*[0-9a-z])?$/;

const RESERVED_WIN = new Set([
  'con','prn','aux','nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

export function assertSafeObjectKey(raw: unknown): ObjectKey {
  if (typeof raw !== 'string') return bad('invalid-key', 'key must be a string');

  // (1) length first, so every regex below runs on a bounded string.
  //     Byte length, not UTF-16 units: the key is ASCII by (2), but a hostile non-ASCII string
  //     must be measured in the same unit as the 512-byte column and the 1,024-byte S3 ceiling.
  const bytes = Buffer.byteLength(raw, 'utf8');
  if (bytes === 0 || bytes > KEY_MAX_BYTES) {
    return bad('invalid-key', `key is ${bytes} bytes, outside 1..${KEY_MAX_BYTES}`);
  }

  // (2) the alphabet. Kills NUL, every control char, absolute paths (a leading '/'),
  //     backslash, overlong UTF-8, confusables, RTL overrides, every Thai codepoint
  //     (U+0E00..U+0E7F), uppercase, and any trailing '/', '.', '-' or space.
  if (!KEY_RE.test(raw)) return bad('invalid-key', 'byte outside the ASCII allowlist');

  // (3) no empty segment
  if (raw.includes('//')) return bad('invalid-key', 'empty path segment');

  // (4) per segment.
  const segments = raw.split('/');
  if (segments.length < SEGMENT_MIN_COUNT || segments.length > SEGMENT_MAX_COUNT) {
    return bad('invalid-key', `segment count ${segments.length} outside ${SEGMENT_MIN_COUNT}..${SEGMENT_MAX_COUNT}`);
  }
  for (const seg of segments) {
    if (seg.length === 0 || Buffer.byteLength(seg, 'utf8') > SEGMENT_MAX_BYTES) {
      return bad('invalid-key', 'segment length out of range');
    }
    // (4a) *** LOAD-BEARING, NOT REDUNDANT. *** i §3.2 verified on node v22.22.3 that
    //      KEY_RE.test('a/../b') === true and 'a/../b'.includes('//') === false, because the
    //      regex anchors bind the whole string and never a segment interior. AWS states the
    //      same hazard from the other side (verified this session): keys with period-only
    //      path segments "can cause unexpected behavior", and 'folder/./file.txt' may be
    //      normalised to 'folder/file.txt' by SDKs and tools.
    if (seg === '.' || seg === '..') return bad('invalid-key', 'path traversal segment');
    if (seg.startsWith('.')) return bad('invalid-key', 'segment starts with "."');  // hidden files, and '..'
    if (seg.startsWith('-')) return bad('invalid-key', 'segment starts with "-"');  // argument injection
                                                                                    // into pdftoppm/gs/tesseract
    // (4b) Azure, verified this session: "No path segments should end with a dot (.)" and
    //      "Avoid blob names that end with a dot (.), a forward slash (/), a backslash (\)".
    //      AWS, verified this session: the S3 *console* strips trailing periods from downloaded
    //      key names, so a trailing '.' makes the stored key and the downloaded key disagree.
    //      Nothing in this grammar produces one; the check exists so nothing ever starts to.
    if (seg.endsWith('.')) return bad('invalid-key', 'segment ends with "."');
    if (seg.endsWith('-')) return bad('invalid-key', 'segment ends with "-"');
    if (RESERVED_WIN.has(seg.split('.', 1)[0]!)) return bad('invalid-key', 'reserved device name');
  }
  return raw as ObjectKey;
}

// ---- the total parser ------------------------------------------------------
// U is the exact lowercase-hyphenated UUID shape. The first draft used [0-9a-f-]{36}, which
// accepts '------------------------------------'; the closing round-trip caught it, but a parser
// whose regex is looser than its grammar makes every reader work out why it is still safe.
const U = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const B = '[0-9a-hjkmnp-tv-z]';                       // Crockford base32, lowercased on the wire

const S_ORIGINAL = new RegExp(`^org/(?<org>${U})/original/(?<sh>${B}{2})/(?<doc>${B}{32})$`);
const S_RENDER   = new RegExp(`^org/(?<org>${U})/render/(?<sh>${B}{2})/(?<doc>${B}{32})/(?<recipe>[0-9a-f]{32})/p(?<page>[0-9]{5})(?:-t(?<tile>[0-9]{2}))?\\.(?<ext>png|tif|jpg)$`);
const S_PREVIEW  = new RegExp(`^org/(?<org>${U})/preview/(?<sh>${B}{2})/(?<doc>${B}{32})/(?<preview>[0-9a-f]{32})/p(?<page>[0-9]{5})-w(?<width>400|800|1600|2400)\\.webp$`);
const S_PAYLOAD  = new RegExp(`^org/(?<org>${U})/payload/(?<sh>${B}{2})/(?<doc>${B}{32})/r(?<run>[0-9]{4})/p(?<page>[0-9]{5})-(?<engine>[0-9a-z][0-9a-z-]{0,30}[0-9a-z])-d(?<dpi>[1-9][0-9]{2,3})\\.json\\.zst$`);
const S_EXPORT   = new RegExp(`^org/(?<org>${U})/export/(?<sh>${B}{2})/(?<exp>${B}{32})\\.(?<ext>csv|xlsx|json|pdf|zip)$`);

const up = (s: string) => s.toUpperCase();   // inverse of lc(); bijective on Crockford base32

export function parseObjectKey(raw: unknown): KeySpec & { key: ObjectKey } {
  const key = assertSafeObjectKey(raw);
  const ns  = key.split('/', 3)[2];
  let spec: KeySpec;

  const g = (re: RegExp) => re.exec(key)?.groups ?? bad('invalid-key', `key does not match ${ns} shape`);
  switch (ns) {
    case 'original': { const m = g(S_ORIGINAL);
      spec = { kind: 'ORIGINAL', org: organizationId(m.org!), doc: documentPublicId(up(m.doc!)) }; break; }
    case 'render': { const m = g(S_RENDER);
      spec = { kind: 'PAGE_RENDER', org: organizationId(m.org!), doc: documentPublicId(up(m.doc!)),
               recipe: recipeHash(m.recipe!), page: pageNumber(Number(m.page)),
               // absent group -> undefined -> the minter emits no tile element. A literal '-t00'
               // or '-t0' therefore dies at the closing round-trip, not at a hand-written guard.
               ...(m.tile === undefined ? {} : { tile: tileIndex(Number(m.tile)) }),
               ext: m.ext as RenderExt }; break; }
    case 'preview': { const m = g(S_PREVIEW);
      spec = { kind: 'PAGE_PREVIEW', org: organizationId(m.org!), doc: documentPublicId(up(m.doc!)),
               preview: previewHash(m.preview!), page: pageNumber(Number(m.page)),
               width: Number(m.width) as PreviewWidth }; break; }
    case 'payload': { const m = g(S_PAYLOAD);
      spec = { kind: 'ENGINE_PAYLOAD', org: organizationId(m.org!), doc: documentPublicId(up(m.doc!)),
               run: runSeq(Number(m.run)), page: pageNumber(Number(m.page)),
               engine: engineSlug(m.engine!), dpi: renderDpi(Number(m.dpi)) }; break; }
    case 'export': { const m = g(S_EXPORT);
      spec = { kind: 'EXPORT', org: organizationId(m.org!), exp: exportPublicId(up(m.exp!)),
               ext: m.ext as ExportExt }; break; }
    default:
      return bad('invalid-key', `unknown namespace segment "${ns}"`);
  }

  // *** THE CLOSING PROPERTY. ***
  // "Accepted by the parser" and "producible by the minter" are the SAME SET, by construction.
  // Any key that mintObjectKey could not have emitted -- including one with a shard that does
  // not match its own document id, a zero page number, or a leading-zero DPI -- dies here,
  // before it reaches any storage adapter or any filesystem call.
  if (mintObjectKey(spec) !== key) {
    return bad('invalid-key', 'key is not the canonical rendering of its own contents');
  }
  return { ...spec, key };
}
```

`assertSafeKeyPrefix` is `i` §3.2.1's, unchanged in substance and regenerated from the same YAML:
1–5 complete segments (raised from 4 so that `documentPrefix` — five segments — is expressible),
mandatory trailing `/`, per-segment anchors (never whole-string anchors), same traversal, trailing-dot
and reserved-name checks. `i`'s reasoning is correct and is adopted by citation.

### 8.2.1 The per-segment traversal check **is** `f1`'s tenant boundary, not a nicety

This is the most important sentence in §8, and the first draft did not contain it.

`f1` `storage.tenant_prefix_check` is frozen as a SQL `LIKE`:

```
object_key LIKE 'org/' || organization_id::text || '/%'
```

A `LIKE` prefix test is **purely lexical**. It has no notion of path segments and performs no
normalisation. Therefore this key **passes** it:

```
org/{victim-is-not-here}/../{attacker-org-uuid}/original/7q/…      -- LIKE 'org/{that org}/%'  ⇒ TRUE
```

and its normalised form addresses a different tenant's prefix entirely. The direction that matters is
the reverse one: a row belonging to organisation *A* can carry a key that any normalising consumer
resolves **into organisation B's prefix**, and the database will happily store it, because
`'org/A/../B/original/…' LIKE 'org/A/%'` is true.

Three verified facts make this a live hazard rather than a theoretical one:

1. **AWS explicitly permits it.** Verified this session, *Naming Amazon S3 objects*: *"Object keys that
   contain relative path elements (for example, `../`) are valid if, when parsed left-to-right, the
   cumulative count of relative path segments never exceeds the number of non-relative path elements
   encountered."* `videos/2014/../../video1.wmv` is given as a **valid** example. S3 will store and
   serve such a key; it is not rejected at the API.
2. **Tools normalise it, inconsistently.** Same page: *"Many systems automatically resolve `.` and
   `..` references, potentially changing the effective path"*, and *"Different tools and SDKs might
   handle these patterns differently."* So the row, the bucket policy evaluator, the local filesystem
   and the backup tool may each disagree about which tenant a key belongs to.
3. **On the local driver it is a filesystem escape.** `$OCR_STORAGE_ROOT/objects/` + the key goes to
   `path.join`, which normalises `..` — so a key with enough `../` elements reaches `tmp/`,
   `quarantine/`, or outside `OCR_STORAGE_ROOT` altogether.

**Conclusion, and it is a structural one.** `f1`'s `CHECK` gives *attribution*; it does not give
*containment*. Containment comes from the per-segment traversal check in `assertSafeObjectKey` — the
one the first draft's own property test §8.3(7b) protects with the comment "load-bearing, not
redundant". It is more load-bearing than that comment claims: **without it, the tenant-isolation
property that `f1` freezes for object storage does not hold at all**, and the panel's finding that
"for these columns RLS is not defence-in-depth, it is absent" would stand unfixed.

Two mechanical consequences follow, and both are adopted:

- The SQL shape `CHECK` of §13.1 keeps its `object_key !~ '(^|/)[.]{1,2}(/|$)'` clause. The first
  draft called it "belt and braces". It is not: it is the only traversal defence that survives a
  compromised application process, and it is the reason the `CHECK` is written as a conjunction of a
  traversal test **and** a per-kind shape test rather than relying on the shape regexes alone.
- The same `!~` clause is added to `f1`'s sibling constraints on `ocr_results.payload_ref` and
  `extraction_jobs.result_ref` (migration 0011), because those two columns have exactly the same
  `LIKE`-only protection and are read with the application's storage credential without touching
  PostgreSQL at all.

### 8.3 The proof that no client-controlled byte reaches a key

Eight independent mechanisms. Numbers 1–4 make it unrepresentable, 5–6 make it untestable-away,
7–8 catch it at runtime and at rest.

1. **Signature.** `mintObjectKey` accepts one closed discriminated union. Every field is a brand, a
   bounded integer, or a member of a closed literal union (§5.2 classes A–D). `KeySpec` has no
   `string`, no `unknown`, no index signature and no options bag. A value from
   `await request.formData()`, a header, a query parameter or a JSON body is not assignable to any
   field without an explicit cast.
2. **Brand doors.** The brands can only be produced by the seven constructors in §8.1, each of which
   applies a regex derived from a database `CHECK` — `f1` `id.external.shape` for `public_id`, the
   `uuid` type for the organisation. Any other value throws before a key exists.
3. **ESLint.** `no-restricted-syntax` bans `as ObjectKey`, `as DocumentPublicId`, `as OrganizationId`,
   `as ExportPublicId`, `as RecipeHash`, `as PreviewHash`, `as EngineSlug`, `as TileIndex`,
   `as PageNumber`, `as RunSeq`, `as RenderDpi`, `as KeyPrefix` everywhere except inside
   `packages/ocr-storage-keys/src/**`. The escape hatch exists in exactly one package. The rule is
   generated from the brand list in `config/storage-keys.yaml`, so adding a brand without adding its
   ban is impossible rather than merely discouraged.
4. **dependency-cruiser.** `packages/ocr-storage-keys` may not import `next`, `react`, `@prisma/*`,
   `@aws-sdk/*`, `node:http`, `busboy`, or anything under `src/app/**`. It is structurally incapable
   of receiving a request object.
5. **Generation + lock.** All regexes, the namespace map and the suffix map are generated from
   `config/storage-keys.yaml`. CI recomputes the generated files and fails on any diff, so a
   hand-loosened regex cannot be merged. This is `f2` `LIMITS_SOURCE_OF_TRUTH` applied to a grammar
   instead of to numbers.
6. **Cross-language conformance.** `contracts/storage-key-vectors.json` holds 400 `(spec → key)`
   vectors plus 200 must-reject strings, emitted by the TypeScript minter and asserted by both the
   TypeScript and the Python suites. A grammar that drifts in one runtime fails in the other.
   `i` J11's reason stands: `NewType` is a runtime no-op in Python, so the Python worker's guarantee
   must be a test, not a type.
7. **Property tests.**

```ts
// (a) The absence of a channel. mintObjectKey has no filename parameter, so this asserts that
//     no adjacent attacker-controlled value can influence the key.
it('key is invariant under every uploaded filename, content-type and header', () => {
  const spec = { kind: 'ORIGINAL', org: ORG, doc: DOC } as const;
  const expected = mintObjectKey(spec);
  fc.assert(fc.property(fc.fullUnicodeString(), fc.fullUnicodeString(), fc.fullUnicodeString(),
    (filename, contentType, xFilename) => {
      const doc = uploadFixture({ filename, contentType, xFilename });   // route-level fixture
      expect(doc.storageObject.objectKey).toBe(expected);
    }));
});

// (b) i §3.2 (4a)'s regression guard, kept verbatim because it encodes a FALSE claim someone
//     will re-derive. If the per-segment traversal check is deleted, line 2 fails and says why.
it('KEY_RE alone does NOT stop traversal — the per-segment check is load-bearing', () => {
  expect(KEY_RE.test('a/../b/c/d')).toBe(true);
  expect(() => assertSafeObjectKey('a/../b/c/d')).toThrow(StorageKeyError);
});

// (c) Anything accepted satisfies every structural invariant simultaneously.
it('rejects every non-conforming string', () => {
  fc.assert(fc.property(fc.fullUnicodeString(), (s) => {
    let ok = true; try { assertSafeObjectKey(s); } catch { ok = false; }
    if (!ok) return true;
    const segs = s.split('/');
    return /^[0-9a-z][0-9a-z.\-/]*[0-9a-z]$/.test(s)
      && segs.length >= 5 && segs.length <= 7
      && segs.every((g) => g.length > 0 && g !== '.' && g !== '..'
                        && !g.startsWith('.') && !g.startsWith('-'));
  }));
});

// (d) Round-trip, both directions.
it('parse ∘ mint = id  and  mint ∘ parse = id', () => {
  fc.assert(fc.property(arbitraryKeySpec(), (spec) => {
    const k = mintObjectKey(spec);
    const p = parseObjectKey(k);
    expect(mintObjectKey(p)).toBe(k);
  }));
});

// (e) The shard is uniform. This is the test that would have caught i §2.2's hazard.
it('shard distribution over 10^6 public ids is uniform across 1024 buckets (χ², p > 0.001)', ...);

// (f) §8.2.1's boundary, asserted directly. A key that satisfies f1's LIKE prefix but escapes
//     the tenant on normalisation must be unrepresentable AND unstorable.
it('a key that passes f1 LIKE but normalises out of the tenant prefix is rejected', () => {
  const escape = `org/${ORG}/../${OTHER_ORG}/original/7q/${'a'.repeat(32)}`;
  expect(escape.startsWith(`org/${ORG}/`)).toBe(true);             // f1's CHECK would pass it
  expect(() => assertSafeObjectKey(escape)).toThrow(StorageKeyError);
  expect(path.resolve('/data/ocr-files/objects', escape))          // and the local driver escapes
    .not.toMatch(new RegExp(`^/data/ocr-files/objects/org/${ORG}/`));
});

// (g) The tile element is total: two renderings, no third.
it('the tile element admits exactly -tNN for NN in 01..99, or nothing', () => {
  const base = mintObjectKey({ kind: 'PAGE_RENDER', org: ORG, doc: DOC,
                               recipe: R, page: pageNumber(7), ext: 'png' });
  expect(base.endsWith('/p00007.png')).toBe(true);
  for (const s of ['/p00007-t00.png', '/p00007-t0.png', '/p00007-t1.png', '/p00007-t003.png'])
    expect(() => parseObjectKey(base.replace('/p00007.png', s))).toThrow(StorageKeyError);
});

// (h) f2's policy caps are inside this grammar's field widths (§4.1.1). If f2 ever raises a limit
//     past a field width, THIS test fails rather than production minting an unparseable key.
it('every f2 admission cap fits inside its grammar field width', () => {
  expect(LIMITS.MAX_PAGES_PER_DOCUMENT).toBeLessThanOrEqual(99_999);
  expect(LIMITS.MAX_TILES_PER_PAGE).toBeLessThanOrEqual(99);
  expect(LIMITS.MAX_OCR_PAGES_PER_DOCUMENT).toBeLessThanOrEqual(LIMITS.MAX_PAGES_PER_DOCUMENT);
});
```

8. **The database.** The shape `CHECK` of §13.1 means a key that this grammar cannot produce cannot
   be *stored*, independently of any application code being correct. That is the third enforcement
   point, after the type system and the parser, and it is the only one that survives a compromised
   application process.

### 8.4 The Python twin

```python
# packages/innovera_ocr_storage_keys/keys.py
# GENERATED from config/storage-keys.yaml — do not hand-edit.
import re
from dataclasses import dataclass
from typing import Literal, Union

KEY_MAX_BYTES     = 512
SEGMENT_MAX_BYTES = 64
SEGMENT_MIN_COUNT = 5
SEGMENT_MAX_COUNT = 7
SHARD_CHARS       = 2

KEY_RE = re.compile(r"\A[0-9a-z](?:[0-9a-z.\-/]*[0-9a-z])?\Z")   # \A/\Z, never ^/$: in Python
                                                                 # '$' also matches before a
                                                                 # trailing newline, so "a/b\n"
                                                                 # would pass a '$'-anchored regex.
RESERVED_WIN = {"con", "prn", "aux", "nul",
                *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10))}

class StorageKeyError(ValueError): ...

def assert_safe_object_key(raw: object) -> str:
    if not isinstance(raw, str):
        raise StorageKeyError("key must be a str")
    n = len(raw.encode("utf-8"))
    if n == 0 or n > KEY_MAX_BYTES:
        raise StorageKeyError(f"key is {n} bytes, outside 1..{KEY_MAX_BYTES}")
    if KEY_RE.match(raw) is None:
        raise StorageKeyError("byte outside the ASCII allowlist")
    if "//" in raw:
        raise StorageKeyError("empty path segment")
    segs = raw.split("/")
    if not (SEGMENT_MIN_COUNT <= len(segs) <= SEGMENT_MAX_COUNT):
        raise StorageKeyError(f"segment count {len(segs)} out of range")
    for seg in segs:
        if not seg or len(seg.encode("utf-8")) > SEGMENT_MAX_BYTES:
            raise StorageKeyError("segment length out of range")
        if seg in (".", ".."):
            raise StorageKeyError("path traversal segment")
        if seg[0] in (".", "-"):
            raise StorageKeyError('segment starts with "." or "-"')
        if seg[-1] in (".", "-"):                       # §8.2 (4b); Azure + AWS console, verified
            raise StorageKeyError('segment ends with "." or "-"')
        if seg.split(".", 1)[0] in RESERVED_WIN:
            raise StorageKeyError("reserved device name")
    return raw
```

`mint_object_key` and `parse_object_key` mirror §8.1/§8.2 exactly, including the closing
`mint(parse(k)) == k` assertion, and are validated against
`contracts/storage-key-vectors.json` in the worker's own suite.

**The `\A`/`\Z` note is not pedantry.** Python's `$` matches before a trailing newline, so a
`^…$`-anchored port of `KEY_RE` would accept `org/…/original/7q/…\n`, which then reaches
`os.path.join` and `open()`. This is the specific class of defect `i` J11 predicted when it said the
TypeScript proof does not carry over to a second runtime.

**One further Python-only hazard, stated because the worker is the process that touches paths.**
`os.path.join(root, key)` returns `key` verbatim if `key` is absolute, and `pathlib.Path(root) / key`
does the same. `KEY_RE` already forbids a leading `/`, but the worker must **also** assert
containment after joining, because a future loosening of one regex must not become a filesystem
escape:

```python
def resolve_local(root: str, key: str) -> str:
    key = assert_safe_object_key(key)
    root_real = os.path.realpath(root)
    full = os.path.realpath(os.path.join(root_real, key))
    if not (full == root_real or full.startswith(root_real + os.sep)):
        raise StorageKeyError("resolved path escapes the storage root")
    return full
```

`realpath` is used on both sides so a symlink planted inside the root cannot redirect a write, and the
`os.sep` suffix is what stops `/data/ocr-files/objects-evil` from matching `/data/ocr-files/objects`
under a bare `startswith`. The TypeScript adapter carries the identical assertion using
`path.resolve` and `fs.realpathSync`.

### 8.5 Decision C1-8 — the parser is total and closes on the minter

**Competing proposals.** (a) `i` §3.2: a structural validator only — alphabet, length, segment count,
traversal — with no shape parsing, so any string satisfying the structure is "a key". (b) Shape
regexes per namespace, returning a parsed record. (c) (b) plus a closing assertion that re-minting the
parsed record reproduces the input byte for byte.

**Selected: (c).**

**Rejected: (a).** It accepts `org/{uuid}/original/zz/{32 chars}` where `zz` is not the shard of that
document — a key the minter can never emit but every consumer will happily dereference. Under a local
driver that is a lookup miss; under a future migration that walks keys it is a row that can never be
matched to its object.

**Rejected: (b) alone.** A regex per namespace cannot express a *relationship between two groups*.
The shard-matches-its-own-id property is exactly such a relationship, and so is "the tile element is
absent iff the spec has no tile". Writing those as extra hand-authored guards is a second definition
of the grammar, and a second definition is the drift this document exists to remove.

**Reason.** With (c), "accepted by the parser" and "producible by the minter" are the same set **by
construction**, not by review. One definition of the grammar exists — the minter — and the parser is
its inverse checked against it on every call.

**Implementation consequence.** One extra `mintObjectKey` call per parse. `mintObjectKey` is string
concatenation over already-validated brands: no I/O, no hashing (the shard is a `slice`, not a
digest — §5.3), so the cost is on the order of a microsecond and the parse path is not hot in any case.

**Migration consequence.** None. It is a property of one function.

**Security consequence.** It is the point at which every "almost right" key dies: a mismatched shard,
a leading-zero DPI, `p0007` instead of `p00007`, `-t00`, an uppercase base32 character, or a key
carrying a valid shape for one namespace under another namespace's literal segment. Each of those is a
place where two components could otherwise disagree about which object a row names.

**Config/env consequence.** None.

### 8.6 Decision C1-9 — the grammar is generated, in three runtimes plus SQL

**Competing proposals.** (a) Hand-write the grammar in TypeScript, in Python and in the SQL `CHECK` —
what M0 did, and it produced four grammars from four authors. (b) Generate all three from one YAML
source, with a lock hash and a cross-language vector file.

**Selected: (b).**

**Rejected: (a).** Three hand-written copies of one grammar have three independent drift rates. The
observed failure is not hypothetical: `i`'s validator demands exactly 7 segments while `g`'s keys have
4 or 5, so `i`'s own validator rejects `g`'s own keys, in the same milestone.

**Reason.** This is `f2` `LIMITS_SOURCE_OF_TRUTH` applied to a grammar rather than to numbers, and the
argument is identical: no layer reads a literal.

**Implementation consequence.** `config/storage-keys.yaml` → `scripts/gen-storage-keys.ts` →
`@innovera/ocr-storage-keys`, `innovera_ocr_storage_keys`, `migrations/0011_*.sql`'s `CHECK`, the
ESLint brand-ban rule, and `contracts/storage-key-vectors.json`. CI regenerates and fails on any diff.
The Python package is a *generated artefact checked into the repository*, not a build step, so the
worker image does not need Node.

**Migration consequence.** The generator's output for the SQL `CHECK` is a migration file, so a
grammar change is a migration by construction and cannot be a hot edit.

**Security consequence.** A hand-loosened regex cannot be merged: the lock hash fails in CI and the
startup assertion fails at boot. This is what stops the single most likely real-world regression —
someone widening a regex to make a test pass.

**Config/env consequence.** Nothing in `storage-keys.yaml` is an environment variable, for the reason
in §16: changing a grammar changes only future keys while every existing key keeps the old shape.
That is a migration, never a restart.

---

## 9. Provider limits, prefix throughput, and local-disk fan-out

### 9.1 Verified key-length and character constraints

Every row below marked "verified this session" was fetched from the vendor's own documentation during
this review. The first draft left three rows `UNVERIFIED` citing an exhausted search budget; all three
are now resolved.

| Provider | Limit | Status |
|---|---|---|
| Amazon S3 | *"The object key name consists of a sequence of Unicode characters encoded in UTF-8, with a maximum length of 1,024 bytes or approximately 1,024 Latin characters."* *"The prefix, the delimiter (`/`), and the name of the object are included in the 1,024 byte limitation."* | **Verified this session** — AWS S3 User Guide, *Naming Amazon S3 objects*. |
| Amazon S3 — characters | Safe: alphanumerics and `! - _ . * ' ( )`. "Might require additional code handling": `&`, `$`, ASCII 00–1F and 7F, `@`, `=`, `;`, `/`, `:`, `+`, space, `,`, `?`. "Characters to avoid": `\ { } ^ % ` [ ] " > < # ~ \|` and non-printable 128–255. | **Verified this session**, same page. Independent vendor confirmation that `g` §7.4's `@{dpi}` is a mistake. Note our alphabet is a **strict subset of S3's safe set** minus `_ ! * ' ( )`. |
| Amazon S3 — relative path elements | *"Object keys that contain relative path elements (for example, `../`) are **valid** if, when parsed left-to-right, the cumulative count of relative path segments never exceeds the number of non-relative path elements encountered."* `videos/2014/../../video1.wmv` is given as valid. | **Verified this session**, same page. **This is the fact that makes §8.2.1 a tenant-isolation issue rather than a hygiene issue: S3 will store a traversal key, so `f1`'s `LIKE` prefix check alone does not contain a tenant.** |
| Amazon S3 — period-only segments | *"Object keys containing period-only path segments (`.` or `..`) can cause unexpected behavior."* *"Path normalization — many systems automatically resolve `.` and `..` references, potentially changing the effective path."* *"Different tools and SDKs might handle these patterns differently."* `folder/..backup/file.txt` and `folder/.hidden/file.txt` *"work normally"*. | **Verified this session**, same page. Confirms both that `.json.zst`'s interior dot is fine and that §8.2's per-segment check is not paranoia. |
| Amazon S3 — trailing periods | *"If you use the Amazon S3 console to download objects that have key names that end with periods (`.`), the periods are removed from the ends of the key names of the downloaded objects."* | **Verified this session**, same page. This is the vendor evidence for §8.2's new `endsWith('.')` per-segment rejection. |
| Google Cloud Storage — flat namespace | *"Object name size in a flat namespace bucket: 1-1024 bytes when UTF-8 encoded."* | **Verified this session** — Cloud Storage docs, *Objects*. |
| Google Cloud Storage — hierarchical namespace | The name splits into a **folder name segment** (everything up to the last `/`) and a **base name segment**: *"The maximum size of the folder name segment is 512 bytes when UTF-8 encoded"* and *"The maximum size of the base name segment is 512 bytes when UTF-8 encoded."* Objects *"cannot be named `.` or `..`"*; names cannot contain CR or LF, and cannot start with `.well-known/acme-challenge/`. | **Verified this session**, same page. **Correction to the first draft:** it described this as a "512-byte *per-segment* ceiling" and compared it against our longest single **path component**. That is a category error — the folder limit applies to the *whole prefix*, not to one component. The corrected comparison is below. |
| Cloudflare R2 | Object key length: **1,024 bytes**. No additional key-name character restrictions documented. | **Verified this session** — Cloudflare R2 docs, *Limits*. |
| Azure Blob Storage | *"A blob name must be at least one character long and cannot be more than 1,024 characters long"* (**characters**, not bytes). Path segments: **≤ 254** without hierarchical namespace, **≤ 63** with HNS *"(including path segments for account name and container name)"*. *"No path segments should end with a dot (.)"*; avoid names ending in `.`, `/`, `\`. Control characters 0x00–0x1F and a listed set of Unicode code points are invalid. | **Verified this session** — Azure Storage REST docs, *Naming and Referencing Containers, Blobs, and Metadata*. |
| SeaweedFS (the `i` J7 migration target) | **UNVERIFIED** — filer path limits not fetched. Not load-bearing: SeaweedFS is a possible future backend, not an M1 one, and our margin against every verified backend is ≥ 7×. Tagged **OWNER-BLOCKED? no — MEASUREMENT-DEFERRED**: verify before any SeaweedFS adoption decision, not before M1. |
| Linux (local disk, XFS/ext4) | `NAME_MAX` = 255 bytes **per path component**; `PATH_MAX` = 4096 bytes. | Standard; the binding constraint on local disk is per-component, not total. |

**Our numbers against those ceilings — recomputed. The first draft's arithmetic was wrong in three
of five rows** (it under-counted `/original/`, `/preview/` and `/payload/` as eight characters and
mis-added the `ENGINE_PAYLOAD` filename). The corrected figures:

| Kind | Longest key (bytes) | Longest folder prefix (bytes) | Longest single component (bytes) |
|---|---|---|---|
| `ORIGINAL` | 85 | 53 (`org/<36>/original/7q/`) | 36 (the org uuid) |
| `EXPORT` | 88 | 51 | 37 (`<32>.xlsx`) |
| `PAGE_RENDER` | 127 (131 with a tile element) | 117 | 36 |
| `PAGE_PREVIEW` | 135 | 118 | 36 |
| `ENGINE_PAYLOAD` | **145** | 91 | **54** (`p00007-<32-char slug>-d9999.json.zst`) |

Derivation of the worst case, so it can be rechecked rather than believed:

```
ENGINE_PAYLOAD = "org/"(4) + orgId(36) + "/payload/"(9) + sh(2) + "/"(1) + docPub(32)
               + "/r"(2)  + runSeq(4)  + "/p"(2)        + page(5) + "-"(1) + engineSlug(32)
               + "-d"(2)  + dpi(4)     + ".json.zst"(9)
               = 145 bytes
folder prefix  = everything up to the last "/"  = 91 bytes
base name      = "p00007-" (7) + 32 + "-d9999" (6) + ".json.zst" (9) = 54 bytes
PAGE_RENDER    = "org/"(4)+36+"/render/"(8)+2+"/"(1)+32+"/"(1)+32+"/p"(2)+5+"."(1)+3  = 127
                 with "-t12"                                                          = 131
```

**Against every verified ceiling:**

| Ceiling | Verified value | Our worst case | Headroom |
|---|---|---|---|
| S3 / GCS-flat / R2 total key | 1,024 bytes | 145 bytes | **7.1×** |
| Azure total blob name | 1,024 characters (our keys are ASCII, so bytes = characters) | 145 | 7.1× |
| GCS-HNS folder name segment | 512 bytes | 91 bytes | 5.6× |
| GCS-HNS base name segment | 512 bytes | 54 bytes | 9.5× |
| Azure path segments, HNS | 63 (including account and container) | 7 + 2 = 9 | 7× |
| Linux `NAME_MAX` | 255 bytes per component | 54 bytes | 4.7× |
| Our own column | `VARCHAR(512)` | 145 bytes | 3.5× |

`KEY_MAX_BYTES = 512` leaves room for a **367-byte** migration prefix without touching the column, and
the column is `VARCHAR(512)` — **not** `g` §5.4's `VarChar(1024)`, because a column bound equal to the
provider's own hard limit gives no early warning: the first key that violates it is rejected by the
provider in production, not by PostgreSQL in CI.

### 9.1.1 Decision C1-11 — `VARCHAR(512)` in the eight-part form

**Competing proposals.** (a) `g` §5.4: `VarChar(1024)` — the provider limit. (b) `VARCHAR(512)` — half
the provider limit and 3.5× our worst case. (c) `VARCHAR(160)` — snug against the worst case.

**Selected: (b).**

**Rejected: (a).** A column bound equal to the provider's own hard limit can never reject anything the
provider would reject, so it provides no early warning at all: the first over-long key fails in
production at the storage API, after the row has been written, leaving a row that names an object that
cannot exist.

**Rejected: (c).** It is snug against *today's* worst case and would have to be widened by the first
migration that prefixes keys (§12's dual-read window prefixes the new key). Widening a `VARCHAR` in
PostgreSQL is metadata-only and cheap, but doing it under incident pressure on a 1.68 M-row table is
not where anyone wants to discover the bound.

**Reason.** 512 is the largest bound that is *strictly tighter than every verified provider limit* —
so it fails in CI, not in production — while still admitting a full migration prefix.

**Implementation consequence.** `KEY_MAX_BYTES = 512` in both runtimes; the SQL `CHECK` restates it
(harmlessly, and deliberately, so the constraint reads as a complete statement of the rule); the byte
length is measured with `Buffer.byteLength` / `len(s.encode("utf-8"))`, never `.length`, because the
column, the S3 limit and the GCS limit are all in **bytes** while a JavaScript string length is UTF-16
units. Azure is the exception — its limit is in *characters* — and our ASCII-only alphabet makes the
two identical, which is one more reason the alphabet is ASCII-only.

**Migration consequence.** One `ALTER COLUMN … TYPE VARCHAR(512)` in 0011. On an empty M1 table this
is instantaneous. Doing it later is a full table rewrite under an `ACCESS EXCLUSIVE` lock.

**Security consequence.** A bounded key is a bounded input to every regex in §8, which is why
`assertSafeObjectKey` checks the length **first** — every subsequent pattern then runs on a string of
at most 512 bytes, so no regex in this contract can be a ReDoS target regardless of its shape.

**Config/env consequence.** None. `storage.key_max_bytes` lives in `config/storage-keys.yaml` and is
not an environment variable, because changing it changes the column type.

### 9.2 S3 prefix throughput

AWS documents at least **3,500** PUT/COPY/POST/DELETE and **5,500** GET/HEAD requests per second per
partitioned prefix, with no limit on the number of prefixes (cited from `i` §2.2, which verified it
against the S3 performance-optimisation guide). Two consequences, both of which `i` derived correctly
and which survive the grammar change:

1. **Hash-first keys are obsolete and are rejected.** Putting a random shard in the leading position
   would destroy per-tenant listing and, more importantly, per-tenant IAM — `f1`
   `storage.tenant_prefix_check` requires `org/{id}/` to lead precisely so a bucket policy can scope a
   credential with `"Resource": "arn:aws:s3:::bucket/org/{id}/*"`. That second enforcement layer is
   worth more than a throughput optimisation S3 no longer needs.
2. **The shard is still useful as a scaling accelerant.** AWS notes repartitioning "happens gradually
   and is not instantaneous" and emits `503 (Slow Down)` meanwhile. Pre-existing fan-out gives S3
   1,024 partitionable prefixes per organisation per namespace from day one.

### 9.3 Local-disk fan-out

`g` §11's projection is 240,000 documents/year and 1,680,000 storage objects/year across all tenants.
For the largest single organisation, assume the whole corpus: 240,000 `ORIGINAL` objects spread over
1,024 shard directories = **~234 entries per directory per year**, which `getdents64` returns in a
single 32 KiB buffer. `i` §2.2's operational failure mode — a multi-second `readdir` + `stat` walk
over a 100,000-entry directory blocking the Node threadpool — is 400× away.

`i`'s XFS-over-ext4 choice, the `nodev,nosuid,noexec,noatime` mount, the `0700`/`0600` modes, the
`read_only: true` container with a single bind mount, and the `st.dev` equality assertion between
`tmp/` and the object roots are all adopted unchanged by citation (`i` §4.2–§4.4). The only change is
that `OCR_STORAGE_ROOT` now resolves *two* roots — one per `bucket_role` (§4.6) — and the boot
assertion checks `st.dev` equality across all three of `objects/`, `quarantine/` and `tmp/`, because
the quarantine move must be a `rename(2)`.

### 9.4 Decision C1-18 — the grammar makes a per-document, per-lease credential expressible

This section exists to close a panel finding that no other M0.5 document has taken. The panel wrote,
of `h` L25:

> *"H is admirably honest at L25: table-wide `SELECT` on `ocr_jobs` lets a compromised worker
> enumerate **every** organisation's storage keys, and this is closed by L26 — a per-claim,
> per-document, short-lived credential … giving blast radius 'one document, for one lease'."*

and asked (R22) for a negative test proving *"the credential it does hold cannot `GetObject` outside
its own document prefix"*. Whether that credential can be *minted* is a property of the **key
grammar**: a session policy can only scope to prefixes the grammar actually produces.

**Competing proposals.** (a) One long-lived storage credential for the whole worker fleet — what
every M0 document implicitly assumes. (b) A per-**organisation** credential. (c) A per-document,
per-lease credential scoped by this grammar.

**Selected: (c).**

**Rejected: (a).** It is the credential whose compromise the panel priced: every object of every
tenant, forever. Under `g` §11's projection that is 936 GB of Thai identity documents.

**Rejected: (b).** Better, and still wrong for the specific threat: the worker parses hostile files
(`f3` `ai.network.map` gives it no egress precisely because of this), so a parser RCE inside one job
would read every document of the *tenant* whose job it happened to be running. A tenant-scoped
credential also does not bound a *logic* bug — a worker that computes the wrong `documentId` still
succeeds.

**Reason.** The grammar makes the scope exactly four statements, and that is only true because of
C1-1 (identity-addressed, so `ORIGINAL` is one deterministic key), C1-2 (the document segment is a
stable `public_id`, so the prefix is knowable at lease time) and C1-7 (immutable, so the prefix stays
valid for the lease's duration). Under `g`'s content-addressed originals the `ORIGINAL` key is not
known until the bytes have been hashed, so it cannot appear in a policy issued *before* the read.

**Implementation consequence.** The scope for a lease on document `D` in organisation `O`:

| # | Resource | Actions |
|---|---|---|
| 1 | `org/{O}/original/{sh}/{docPub}` — the exact key, no wildcard | `GetObject` |
| 2 | `org/{O}/render/{sh}/{docPub}/*` | `GetObject`, `PutObject` |
| 3 | `org/{O}/preview/{sh}/{docPub}/*` | `GetObject`, `PutObject` |
| 4 | `org/{O}/payload/{sh}/{docPub}/*` | `GetObject`, `PutObject` |

Note the asymmetry, and that it is deliberate: `ORIGINAL` is a **key**, so it is granted read-only and
without a wildcard — a worker can never write an original, and never list the namespace. This is why
`documentPrefix()` in §8.1 accepts only the three derivative namespaces; the first draft had that
restriction without stating the reason. `EXPORT` is absent entirely: exports are the export worker's,
not the OCR worker's.

The mint endpoint is `h` L26's, adopted by citation and constrained here: it accepts
`{jobId, leaseToken}` and **nothing else**, re-reads the job row, derives `O`, `docPub` and `sh`
**server-side from the stored row**, and issues with `TTL = remaining lease + 60 s`. It accepts no
bucket, no key, no prefix and no organisation id from the caller — `i` J4's "accepts zero strings from
the request", applied to a credential instead of to a path.

**Migration consequence.** None; the grammar already supports it. If the local driver is the M1
backend (B-C1-1's default), the equivalent is a per-lease bind-mount subtree or an open file-descriptor
set rather than an IAM policy — the *shape* of the scope is what this decision fixes, not the
mechanism.

**Security consequence.** Converts the panel's accepted residual risk into a bounded one, and makes
`h` §17.1's open question Q8 answerable. It also removes the last place where a raw key string crosses
a process boundary: **no port, message or job payload carries an object key as a `string`.** The OCR
engine port takes a branded `ObjectKey` (or, across the process boundary, a `{jobId, leaseToken}` pair
the callee redeems), never `source: { storageKey: string }` — which is exactly the port shape the
panel flagged in `d`:911 as *"a raw dereferenceable path"*.

**Config/env consequence.** `OCR_STORAGE_LEASE_CREDENTIAL_TTL_GRACE_S = 60` (the `+ 60 s` above);
`OCR_STORAGE_LEASE_CREDENTIAL_MODE ∈ {none, subtree, sts}`, default `subtree` for the local driver and
`sts` for `s3`. `none` is legal only when `OCR_STORAGE_DRIVER=local` **and**
`OCR_ENV=development`; in any other combination it is a boot refusal, so the unscoped credential
cannot reach production by omission.

**Acceptance test R22, restated as this document owes it.** A worker process holding a valid lease for
job A requests a credential naming job B's document and receives `403`; the credential it *does* hold
returns `403` on `GetObject` for any key outside the four resources above, including
`org/{O}/original/{sh}/{other docPub}` in the same organisation.

---

## 10. What the encryption envelope does to the key

`gate-2` `erasure.mechanism` freezes AES-256-GCM under a per-document DEK. Three consequences land on
this document because they change what a key addresses and what `size_bytes` means. The DEK's
lifecycle is `gate-2`'s; the container format is storage's.

### 10.1 Decision C1-15 — chunked AEAD with a per-object derived key

**Competing proposals.**
(a) One AES-256-GCM operation over the whole object under the document DEK.
(b) Chunked AEAD, 1 MiB frames, **nonce management**: a 4-byte random per-object prefix concatenated
with an 8-byte frame counter, all objects of a document sharing the document DEK. *(This was the first
draft of this section.)*
(c) Chunked AEAD, 1 MiB frames, **key derivation instead of nonce management**: a per-object key
derived by HKDF from the document DEK, with a deterministic all-zero-prefix nonce.

**Selected: (c).**

**Rejected: (a).** A single GCM operation over an object at `f2` `MAX_UPLOAD_BYTES` cannot be streamed
safely: the authentication tag arrives last, so a streaming reader either buffers the whole object or
releases unauthenticated plaintext to the OCR pipeline. It also makes a ranged read impossible, which
`l` §4.4's page viewer needs.

**Rejected: (b) — it is a nonce-reuse defect, and GCM's failure mode under nonce reuse is total.**
`gate-2` `erasure.mechanism` gives **one DEK per document**, and every object of that document is
encrypted under it: the original, up to `f2` `MAX_PAGES_PER_DOCUMENT` renders (more with tiles), four
preview widths per page, and one payload per page per engine per run. A realistic worst case is on the
order of 4,000 objects under one key. With a 4-byte (2³²) random per-object prefix the birthday
collision probability across `n` objects is `≈ n²/2 / 2³²`:

```
n = 4,000   ->  4000^2 / 2 / 2^32  =  8.0e6 / 4.295e9  =  1.9e-3
```

**About one document in 540 would contain two objects sharing a nonce prefix**, and any two frames at
the same index under the same key and nonce then leak `P1 XOR P2` **and** — because GCM is a
Carter–Wegman construction — the GHASH authentication subkey, which permits forging tags for that key
thereafter. On a corpus of Thai national ID cards, `P1 XOR P2` of two page renders is not an abstract
loss of semantic security. The first draft's numbers were: 4-byte prefix, 8-byte counter. A 1 MiB frame
size caps a 200 MiB object at 200 frames, so **eight bytes of counter were spent on a value that never
exceeds 200, while four bytes of entropy carried the whole uniqueness burden.** The allocation was
exactly backwards.

**Rejected also: simply widening the prefix to 8 bytes.** It reduces the collision probability to
`≈ 4.3e-13`, which is acceptable, but it leaves the property *probabilistic* and leaves an operator no
way to verify it. (c) makes it structural at the same cost.

**Selected mechanism.**

```
objectKeyMaterial = HKDF-SHA256(
                      ikm    = DEK,                      // 32 bytes, gate-2 per-document (or per-export)
                      salt   = header.salt,              // 16 random bytes, unique per OBJECT
                      info   = "innovera-ocr/storage-object/v1" || objectKey (utf-8),
                      length = 32)

header (64 bytes, authenticated as AAD of every frame):
  magic         8  "IOCRENV1"
  version       2  uint16 BE   = 1
  cipher        2  uint16 BE   = 1 (AES-256-GCM)
  frameSize     4  uint32 BE   = 1048576
  keyRef       16  the first 16 bytes of the owning entity's public_id, base32-decoded
  salt         16  crypto.randomBytes(16), fresh per object
  reserved     16  zero

frame i:  key   = objectKeyMaterial                       -- unique per object by construction
          nonce = uint32BE(0) || uint64BE(i)              -- 12 bytes; unique per frame, and the key
                                                             is unique per object, so (key, nonce) is
                                                             unique WITHOUT any randomness budget
          aad   = header || uint64BE(i)                   -- reorder and splice are detected
          body  = ciphertext(<= 1048576) || tag(16)
```

Three properties this buys that (b) did not:

1. **No nonce management at all.** `(key, nonce)` uniqueness is a theorem, not a probability. The
   16-byte salt makes an HKDF output collision negligible (2⁻¹²⁸ class) and, unlike a nonce collision,
   an HKDF collision is not catastrophic — it is merely two objects sharing a key, which is the
   *starting* position under (b).
2. **The object key is bound into the ciphertext.** `info` includes the object key, so an object
   cannot be moved from one key to another: page 3's render cannot be served as page 7's, and an
   `ORIGINAL` cannot be substituted for a different document's — even by an attacker with write
   access to the store, and even though both objects live under the same document DEK. Under (b) the
   header travelled with the object, so a whole-object swap decrypted cleanly.
3. **Shredding still works, unchanged.** HKDF is one-way, so destroying the DEK destroys every derived
   object key at the same instant, everywhere, exactly as `gate-2` D-G2-8 requires. Nothing about
   erasure changes.

**`keyRef` must not be the internal document UUID.** The first draft wrote
`keyId 32 = document_keys.id (uuid, 16 bytes) + 16 reserved`. `document_keys` is keyed by the internal
document id (`gate-2` D-G2-8), which is a UUIDv7 — so the first draft placed **the upload
millisecond, in plaintext, in the first 64 bytes of every stored object**, on exactly the surfaces
C1-2 spent §3.2 removing it from: the storage provider, its inventory, backups, volume snapshots and
support bundles. A ciphertext whose header discloses the upload timestamp of the document it belongs
to defeats the entire point of having two identifiers. `keyRef` is therefore the first 16 bytes of the
owning entity's `public_id` (20 CSPRNG bytes, base32-decoded), which is already in the object's own
key and discloses nothing new. The DEK lookup is
`SELECT … FROM document_keys WHERE key_ref = $1` — a new indexed column on the table `gate-2` owns,
raised in §14.4.

**Truncation is detected explicitly.** Each frame authenticates individually, so dropping the *last*
`k` frames produces a shorter but perfectly valid plaintext. The reader therefore asserts that the
total decrypted length equals `storage_objects.plaintext_bytes` and raises
`STORAGE_INTEGRITY_FAILURE` otherwise. Without this, a truncated Thai contract decrypts cleanly and
extracts confidently — the worst possible failure mode for this product.

Overhead is 16 bytes per 1 MiB frame plus a 64-byte header = **0.0015 %**. A ranged plaintext read of
`[a, b]` maps to frames `floor(a/frameSize) .. floor(b/frameSize)`, so `l` §4.4's viewer and `i` §7.4's
`Range` handling both work without decrypting the whole object.

**Implementation consequence.** `plaintext_sha256` (§7.1.1) is computed on the plaintext stream before
encryption, so it is stable across re-encryptions and is what makes the retry/collision distinction
decidable. `f2` `MAX_PAGE_RENDER_BYTES` and every other byte limit are compared against **plaintext**
length, never ciphertext, so the envelope overhead can never turn a legal page into a rejected one.

**Migration consequence.** None if decided now. `envelope_version` exists precisely so that a future
change is a read-path branch rather than a re-encryption; but a change from (b) to (c) *after* objects
exist would require re-encrypting every object, because (b)'s objects have no salt.

**Security consequence.** Removes a 1-in-540 catastrophic key-reuse event; removes an internal-UUID
timestamp disclosure from every stored object; adds object-substitution resistance; adds truncation
detection. All four are consequences of a single mechanism change.

**Config/env consequence.** `OCR_STORAGE_ENVELOPE_FRAME_BYTES = 1048576`.
**Correction to the first draft:** it described this variable as *"read-only at runtime; a change
requires `envelope_version` 2"*. That is wrong — `frameSize` is a **header field**, so a reader takes
it from the object it is reading. The variable sets the frame size for **newly written** objects only;
changing it needs no version bump and does not invalidate anything already stored. Permitted range
`[65536, 8388608]`, asserted at boot; outside it, exit 78.

### 10.2 The other two envelope consequences

**`storage.envelope.version_location` — a column, never the key.** `storage_objects.envelope_version
SMALLINT NOT NULL DEFAULT 1`. By §5.1's governing principle: the envelope can change independently of
the object's identity, so it must not be in the path. Had it been in the path, rolling to a v2 cipher
would have been a rewrite of every key.

**`storage.size_bytes_semantics` — ciphertext.** `storage_objects.size_bytes` is the bytes actually
at rest (what the disk, the quota and the storage bill see). Plaintext length lives in
`storage_objects.plaintext_bytes`. Conflating them makes every quota either over- or under-count by
the envelope overhead and makes `Content-Length` wrong on a download.

Two consequences that must be stated so nobody has to infer them:

- **`f2`'s byte limits are compared against `plaintext_bytes`, never `size_bytes`.** A page render at
  exactly `f2` `MAX_PAGE_RENDER_BYTES` is legal; its ciphertext is 80 bytes larger and is still legal.
- **`f2` `CHECK_storage_objects_size_nonneg` (`size_bytes >= 0`) is unchanged and still correct**, and
  the same non-negative-only form is used for `plaintext_bytes`. `f2`'s rationale — "an empty
  derivative is legal" — survives the envelope: an empty derivative has `plaintext_bytes = 0` and
  `size_bytes = 64` (the header alone). No **upper** bound is added to either column, per `f2`
  `TUNABLE_LIMITS_IN_SCHEMA = none`.

**The transport consequence, stated once and handed back to its owner.** Because the bytes must be
encrypted under the document's DEK *before* they are at rest, **any upload transport must deliver
plaintext to a process that holds the DEK.** A presigned direct-to-object-store upload (`l` L-1)
cannot: the browser would write plaintext to the store, leaving the most sensitive object in the
system outside the crypto-shredding boundary until a worker rewrote 200 MiB. This is a constraint the
key/envelope design *imposes*; the transport decision itself belongs to the API dimension. Note that
`f2` `MAX_INFLIGHT_UPLOADS_GLOBAL` already sizes an nginx body-temp volume at "8 × 202 MiB ≈ 1.6 GiB",
which only exists on the app-streamed path — so the frozen limits already assume the answer this
constraint forces.

---

## 11. The canonical document-status vocabulary

### 11.1 The four competing vocabularies

| Source | Values | Problem |
|---|---|---|
| `g` §4.1 | `UPLOADED VALIDATING QUARANTINED QUEUED EXTRACTING_NATIVE OCR_PROCESSING NORMALIZING AI_ANALYZING READY_FOR_REVIEW COMPLETED FAILED` (11) | No `CANCELLED`, so the backlog bounded by `f2` `MAX_QUEUED_DOCS_PER_USER` has no user-facing exit and `h`'s job-level `CANCELLED` has nothing to project onto. |
| `l` §4.2 | `pending_upload queued processing needs_review reviewed failed cancelled` (7, lower_snake) | A second, coarser vocabulary with no stated mapping. `pending_upload` and `g`'s `UPLOADED` are different states with confusingly similar names — one means "no bytes yet", the other "bytes accepted". |
| `j` §4.1 | `SAFE VALIDATING PROCESSING EXTRACTING READY_FOR_REVIEW APPROVED REJECTED` as downloadable, plus `UPLOADED SCANNING SCAN_FAILED QUARANTINED DELETED` (12, a third naming scheme) | Contradicts itself: `VALIDATING` is in `DOWNLOADABLE_STATES` while the surrounding prose (Hole 2) argues the pre-verdict window must not be downloadable. |
| `i` | none; implies a quarantine state | — |

### 11.2 Decision C1-10 — one enum, twelve members

**Competing proposals.** (a) `g`'s 11-member DB enum plus `l`'s 7-member wire enum with a mapping
table. (b) One enum, wire form derived.

**Selected: (b).**

```prisma
enum DocumentStatus {
  UPLOADED            // bytes accepted and at rest, encrypted; nothing inspected yet
  VALIDATING          // magic-byte sniff, size/page limits, encryption check, AV scan
  QUARANTINED         // AV or active-content verdict. ABSOLUTELY TERMINAL.
  QUEUED              // validated and CLEAN; waiting for a worker
  EXTRACTING_NATIVE   // pulling the PDF's embedded text layer, no OCR
  OCR_PROCESSING      // rasterise + OCR engine
  NORMALIZING         // NFC, Thai digit handling, tokenisation, page assembly
  AI_ANALYZING        // semantic extraction / validation
  READY_FOR_REVIEW    // a human may accept or correct
  COMPLETED           // accepted
  FAILED              // pipeline gave up; operator may requeue
  CANCELLED           // a human stopped it before completion
}
```

**Rejected: (a), a mapping table between two vocabularies.** Two vocabularies with a mapping is
exactly the mechanism that produced this contradiction: `l` added `cancelled` and `g` never learned
about it; `g` added `AI_ANALYZING` and `l` never learned about it. A mapping table is a place where
drift is *permitted*.

**Rejected: `PENDING_UPLOAD` / `pending_upload`.** A `documents` row exists only once bytes are
accepted. The pre-bytes state is `uploads.status` on a different table with a different lifecycle and
a TTL. Creating a document row for an upload that may never arrive means every list query, every
quota count and every "how many documents do I have" answer includes rows that are not documents.

**Reason.** One list, stored once, rendered on the wire as the member lowercased
(`ready_for_review`). `l`'s legitimate concern — that exposing `EXTRACTING_NATIVE` couples the public
API to internal pipeline stages — is answered by a *derived* projection rather than by a second
vocabulary:

```ts
export const PHASE: Record<DocumentStatus, 'intake' | 'processing' | 'review' | 'done' | 'stopped'> = {
  UPLOADED: 'intake',            VALIDATING: 'intake',
  QUEUED: 'processing',          EXTRACTING_NATIVE: 'processing',
  OCR_PROCESSING: 'processing',  NORMALIZING: 'processing',   AI_ANALYZING: 'processing',
  READY_FOR_REVIEW: 'review',
  COMPLETED: 'done',
  QUARANTINED: 'stopped',        FAILED: 'stopped',           CANCELLED: 'stopped',
};
```

`Record<DocumentStatus, …>` makes adding an enum member without classifying it a `tsc` error. `phase`
is never stored, never written to the database, and is recomputed on every response, so it cannot
disagree with `status`. Clients may filter on either.

**Implementation consequence.** `l` §4.2's `DocumentListQuery.status` becomes
`z.array(z.enum(DOCUMENT_STATUS_WIRE)).max(12)` plus an optional
`phase: z.array(z.enum(['intake','processing','review','done','stopped'])).max(5)`.

**Migration consequence.** `CANCELLED` is a new enum value; `ALTER TYPE ... ADD VALUE` is not
transactional before PostgreSQL 12 and is cheap after it. Deciding it now costs one line; deciding it
after launch costs an enum alteration on a live `documents` table plus a client-visible API change.

**Security consequence.** `QUARANTINED` remains a first-class value with zero outgoing edges
(`g` §4.1's argument is adopted verbatim: folding it into `FAILED` means an operator's "retry all
failed" button re-feeds malware to the parser). `CANCELLED` is distinguishable from `FAILED`, so a
cancellation spike and a failure spike do not look identical on a dashboard.

**Config/env consequence.** None.

### 11.3 Transitions

`g` §4.2's transition table is adopted **unchanged** in its *topology* — which states may follow
which, and its two-level retry model — and is cited, not restated.

**Correction to the first draft:** it also restated `g` §4.2's native-coverage figure and its Thai
sanity gate (a Thai-codepoint fraction and a mojibake-signature fraction) as though this document
owned them. **It does not, and those particular numbers are additionally superseded.** Every
threshold that decides *whether a page's text layer is good enough*, *whether the script is
plausibly Thai*, and *whether to escalate* is owned by `c3-ocr-routing-policy.md` under its
`OCR_ROUTE_*` names — where several of them are marked **PROVISIONAL** pending its M2 sweep. Quoting
`g`'s pre-arbitration values here would have pinned a superseded number into a second document, which
is precisely the mechanism that produced the nine M0 contradictions. This document therefore names no
routing or text-quality threshold at all; the transition *from* `EXTRACTING_NATIVE` *to*
`OCR_PROCESSING` is triggered by `c3`'s routing decision, whatever `c3` sets it to.

Four rows are added for `CANCELLED`:

| From | To | Trigger | Actor |
|---|---|---|---|
| `UPLOADED`, `VALIDATING`, `QUEUED` | `CANCELLED` | user or operator cancels | user / operator |
| `EXTRACTING_NATIVE`, `OCR_PROCESSING`, `NORMALIZING`, `AI_ANALYZING` | `CANCELLED` | cancel requested; the live run is marked `CANCELLED` in the same transaction (`f1` `uniq.document_run_one_active`) | user / operator |
| `CANCELLED` | `QUEUED` | operator requeue | operator |
| `QUARANTINED` | — | **no outgoing edge** | — |

`QUEUED` remains the single re-entry point for both `FAILED` and `CANCELLED`, preserving `g` §4.2's
small, exhaustively testable reachability graph.

### 11.3.1 `f2`'s `SCANNING` is a **job** state, and `DocumentStatus` deliberately has no member for it

`f2` F2-D3 moves malware scanning off the synchronous upload path and says *"the document enters
`SCANNING` after the body is durably staged; the HTTP request returns `202` immediately."* This
document's enum has no `SCANNING` member, and that is a decision, not an oversight. The reconciliation,
stated once so no third vocabulary appears:

- `SCANNING` is a state of `h`'s **job** state machine. `f2` itself says so in the same decision:
  *"`h`'s job state machine already carries `SCANNING` (`m`:265 confirms `h` owns it)"*. `f2`'s prose
  sentence "the document enters `SCANNING`" is a shorthand for "the document's job does".
- The **document-level** projection of the whole pre-verdict window — sniff, size and page-limit
  checks, encryption check, and the AV stream — is the single status `VALIDATING`. Its `phase` is
  `intake`.
- The *detail* a user or an operator actually needs during that window is not the job's stage name; it
  is the **verdict**, and that lives on `documents.scan_verdict` (§11.4) with values
  `PENDING | CLEAN | INFECTED | SUSPICIOUS | ERROR`. A status plus a verdict column carries strictly
  more information than a status alone, with no second vocabulary and no mapping table.
- Nothing about this weakens `f2`'s decision: the HTTP request still returns `202`, scanning still
  happens on the job path with `f2` `CLAMD_MAX_SCAN_TIME_MS`, and the document is not downloadable
  until the verdict is `CLEAN`.

The job→document projection is a total function owned by `h`, in `h`'s direction, and it is one-way:
a document status is never read to infer a job state.

**One consequence of `scan_verdict = 'ERROR'` that must be named rather than discovered.** The
download gate requires `CLEAN`, so a clamd outage that leaves verdicts at `ERROR` blocks downloads for
every document processed during the outage. That is the correct default — fail closed on an unscanned
file — but it must be *visible*: `storage_download_blocked_by_verdict_total{verdict}` is the metric,
and **20 `ERROR` verdicts within 300 s** raises `SEC_AV_UNAVAILABLE` at severity HIGH
(`OCR_STORAGE_AV_ERROR_ALERT_COUNT = 20`, `OCR_STORAGE_AV_ERROR_ALERT_WINDOW_S = 300`). Re-scanning an
`ERROR` document is an operator action that sets the verdict back to `PENDING` and re-enqueues; it is
the one verdict transition that is not monotonic, and it is audited.

### 11.4 The download gate — a verdict column, not a state set

`j` §4.1 gates signed URLs on `DOWNLOADABLE_STATES`. That set is wrong in both directions: it
contains `VALIDATING` (pre-verdict, which `j`'s own Hole 2 says must be blocked) and it omits
`FAILED` (a user whose OCR failed must still be able to retrieve their own file). The correct gate is
monotonic and lives on a column, so adding a status cannot silently widen it:

```sql
ALTER TABLE documents ADD COLUMN scan_verdict scan_verdict_enum NOT NULL DEFAULT 'PENDING';
-- enum scan_verdict_enum { PENDING CLEAN INFECTED SUSPICIOUS ERROR }
```

```ts
const downloadable = (d: Document) =>
  d.scanVerdict === 'CLEAN' && d.status !== 'QUARANTINED' && d.deletedAt === null;
```

`j` §4.1's other four rules — the signer takes a document row and an actor rather than a key; it sets
`ResponseContentDisposition`/`ResponseContentType` itself to constants; it rejects any caller key
matching `/^response-/i`; and `nosniff` is also a bucket-level default response header — are adopted
unchanged by citation. They are correct and this document does not own them.

**One amendment to "constants", forced by §4.9.** `ResponseContentDisposition` cannot be a literal
constant if a user is to get their own filename back. It is instead **server-constructed** from
`documents.original_filename` by the exact RFC 6266 template in §4.9 — percent-encoded, with a derived
ASCII fallback — and never by string concatenation of a caller-supplied value. "Constant" was `j`'s
correct answer to "may the caller set it"; the answer to that is still no.

**The gate in the eight-part form.**

**Competing proposals.** (a) `j` §4.1: a `DOWNLOADABLE_STATES` allowlist over `DocumentStatus`.
(b) A monotonic predicate over a dedicated `scan_verdict` column plus a terminal-status exclusion.

**Selected: (b).**

**Rejected: (a) — a state allowlist is wrong in both directions and gets more wrong over time.** `j`'s
own set contains `VALIDATING`, which is the *pre-verdict* window that `j`'s Hole 2 argues must be
blocked; and it omits `FAILED`, so a user whose OCR failed cannot retrieve the file they uploaded —
which is not a security property, it is a support ticket. The structural defect is worse than either
error: with an allowlist, **adding a status member silently changes the security boundary**. A future
`REPROCESSING` member is either forgotten (a user cannot download during a requeue) or added
reflexively (widening the gate without anyone deciding to).

**Reason.** Downloadability is a fact about the *bytes* — have they been scanned and found clean —
not about where the pipeline has got to. Putting it on a column makes it monotonic and makes adding a
status a no-op for the gate.

**Implementation consequence.** One column, one enum, one three-clause predicate, evaluated inside
`DocumentAccess` (`f1` `authz.chokepoint`) so that visibility and downloadability are checked in the
same place and neither can be applied without the other.

**Migration consequence.** Migration 0013 adds the column and the enum with `DEFAULT 'PENDING'`, so
every pre-existing row is non-downloadable until scanned — fail-closed by construction rather than by
a backfill that could be skipped.

**Security consequence.** Fail-closed on outage (see §11.3.1's alert), fail-closed on a new status,
and no signed URL is minted at all when the predicate is false — so the boundary is at the *mint*,
not at the fetch. A URL that was already minted for a document later moved to `QUARANTINED` remains
live for its residual TTL; that residual is bounded by `j` §4.1's signed-URL expiry, which `j` owns,
and the quarantine bucket-level `Deny` of §4.6 is the second, independent stop.

**Config/env consequence.** `OCR_STORAGE_AV_ERROR_ALERT_COUNT = 20`,
`OCR_STORAGE_AV_ERROR_ALERT_WINDOW_S = 300` (§11.3.1). No tunable widens the gate; there is
deliberately no environment variable that can add a verdict to the downloadable set.

---

## 12. The migration consequence of getting this wrong

The owner asked for this priced, because every stored key is immutable. Against `g` §11's 12-month
projection: **1,680,000 `storage_objects` rows**, **1,560,000 `ocr_results` rows**, ~**288 GB** of
originals and ~**648 GB** of page renders.

**Cost 1 — the bytes.** Every object must be copied to its new key and the old one deleted:
1.68 M `CopyObject` + 1.68 M `HeadObject` (verify) + 1.68 M `DeleteObject` ≈ **5.0 M storage
requests**, with up to **936 GB duplicated at peak** because both keys must be readable during the
window. On local disk it is 1.68 M `rename(2)` calls — roughly 170 seconds of syscalls, but with the
same metadata churn and the same dual-read window. *(Money is deliberately not quoted: current
per-request pricing was not verified this session.)*

**Cost 2 — the rows.** A full-table `UPDATE` of `storage_objects.object_key` rewrites the
`storage_object_bucket_key_key` unique index and every partial index on the table, and — because the
key is the object's identity — cannot be done in one transaction without holding row locks over a
network copy. It must be a resumable, idempotent, batched job with a both-keys-valid read path.

**Cost 3 — and this is the one that makes it a design decision rather than an operations task.**
`ocr_results.payload_ref` holds a key (`f1` `storage.tenant_prefix_check` constrains it), and
`g` §8.1 puts a `BEFORE UPDATE` trigger on `ocr_results` that raises `APPEND_ONLY_VIOLATION` for
**every role**, plus `REVOKE UPDATE ON ocr_results FROM ocr_app`. So:

> **Rewriting the key of 1.56 M immutable evidence rows is not slow. It is impossible without
> disabling the append-only guarantee that makes those rows evidence.**

The choices at that point are all bad: drop the trigger platform-wide for the duration of the
migration (a window in which any code can silently rewrite OCR output); add a second column
`payload_ref_v2` and a resolver that reads both, forever; or orphan every payload and re-run OCR on
1.56 M pages — at `f2` `PROVISIONAL_PER_PAGE_OCR_S` (25 s, value owned by `f2`, quoted for this
arithmetic) that is **~10,833 CPU-hours**.

**Decision C1-12, in the eight-part form.**

**Competing proposals.** (a) Accept that a grammar change is impossible and rely on getting it right
(the implicit M0 position — no M0 document mentions the interaction at all). (b) Store `payload_ref`
as a *structured* reference (run, page, engine, dpi) and re-derive the key on read, so a grammar change
touches no row. (c) Keep the denormalised key and add one narrow, audited migration window.

**Selected: (c).**

**Rejected: (a).** "Get it right" is what M0 tried, and four authors produced four grammars. The
project has one chance and no undo; an insurance policy that costs six lines against a 10,833
CPU-hour downside is not a close call.

**Rejected: (b), and this one is genuinely tempting.** Re-deriving the key on read would make a grammar
change free for `ocr_results` — no `UPDATE`, no trigger to defeat. It fails for a different reason:
`ENGINE_PAYLOAD` keys are derived through `engineSlug`, which is **lossy** (§5.5), and through the
engine registry, which is mutable configuration. Re-deriving means a change to `config/engines.yaml`
silently changes where an immutable evidence row's payload *is believed to be*. A denormalised key is a
record of where the bytes were actually written; a derived key is a guess that the registry has not
changed. For evidence, the record wins. (b) is however the right answer for
`extraction_jobs.result_ref`, which is a transient pointer, and §4.7 keeps it a reference rather than
an independent shape for exactly this reason.

**The insurance policy, six lines, adopted now.** Mirror `g` §8.1's own `app.erasure_window` pattern
with a second, equally narrow window that permits an `UPDATE` of `payload_ref` **and nothing else**:

```sql
CREATE OR REPLACE FUNCTION reject_mutation_except_key_migration() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('app.key_migration_window', true), 'off') = 'on'
     AND to_jsonb(NEW) - 'payload_ref' = to_jsonb(OLD) - 'payload_ref' THEN
    RETURN NEW;                       -- payload_ref changed, nothing else did
  END IF;
  RAISE EXCEPTION 'APPEND_ONLY_VIOLATION: % on % is forbidden', TG_OP, TG_TABLE_NAME
    USING ERRCODE = '42501';
END $$;
```

The window is opened by one code path, is transaction-local (`set_config(..., true)` — `f1`
`db.guc.setter`'s `is_local` argument, for the same reason), and writes an `AuditLog` row. The
`to_jsonb(NEW) - 'payload_ref' = to_jsonb(OLD) - 'payload_ref'` comparison is what makes it narrow:
the window cannot be used to alter recognised text, confidences or bounding boxes.

Note the **fail-closed default**, and note that it is the opposite of the bug found in §7.2's first
draft: `coalesce(current_setting('app.key_migration_window', true), 'off') = 'on'` treats an unset GUC
as `'off'` and falls through to the `RAISE`. An absent GUC therefore *denies*. Any guard written
against `current_setting(…, true)` must be checked for which way it fails when the setting is missing;
one of the two guards in this document had it backwards, and the difference is invisible in every
positive test.

**Implementation consequence.** One function, one `AuditLog` row per opened window, and a
`storage_key_migration_window_opened_total` counter whose steady-state value is zero — an alert on any
non-zero rate outside a declared migration.

**Migration consequence.** Migration 0016 replaces `g` §8.1's `reject_mutation()` on `ocr_results`
with `reject_mutation_except_key_migration()`. This is the only change to an append-only guarantee in
the whole contract, and it strictly narrows nothing and widens exactly one column under one named GUC.

**Security consequence.** The honest statement is that this is a *deliberate weakening* of an
append-only guarantee, bounded to one column and one transaction-local flag, in exchange for making a
foreseeable migration possible without disabling the guarantee platform-wide. The alternative — drop
the trigger for the duration — is a multi-hour window in which any code path can rewrite any OCR
output with no audit trail. Choosing a narrow, audited, always-present door over a wide, unaudited,
occasionally-open one is the trade, and it is made explicitly rather than discovered under pressure.

**Config/env consequence.** None: the window is a transaction-local GUC set by one use case, never an
environment variable. There is deliberately no way to open it from configuration.

**This is why the key grammar had to be decided in M0.5 and not discovered in M1.** Three of the four
M0 grammars would have needed exactly this migration: `i`'s because `{yyyy}/{mm}` is derived from a
correctable column and its `{oid}` is fresh per write; `g`'s and `l`'s because a content-addressed
original is unshreddable (§3.1) and must be abandoned the first time a real erasure request arrives.
And the first draft of *this* document would have needed it too, for the missing tile discriminator
(§4.8) — which is the strongest available argument that this section is not theatre.

---

## 13. Schema, constraints and migrations

### 13.1 The shape `CHECK` (generated)

```sql
-- migration 0011_storage_key_contract.sql
-- GENERATED from config/storage-keys.yaml. Hand edits fail the CI lock check.

ALTER TABLE storage_objects
  ALTER COLUMN object_key TYPE VARCHAR(512);           -- was VarChar(1024) in g §5.4

ALTER TABLE storage_objects ADD CONSTRAINT storage_object_key_shape CHECK (
  length(object_key) <= 512
  AND object_key !~ '(^|/)[.]{1,2}(/|$)'               -- traversal, belt and braces
  AND CASE kind
    WHEN 'ORIGINAL'       THEN object_key ~ '^org/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/original/[0-9a-hjkmnp-tv-z]{2}/[0-9a-hjkmnp-tv-z]{32}$'
    WHEN 'PAGE_RENDER'    THEN object_key ~ '^org/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/render/[0-9a-hjkmnp-tv-z]{2}/[0-9a-hjkmnp-tv-z]{32}/[0-9a-f]{32}/p[0-9]{5}(-t[0-9]{2})?[.](png|tif|jpg)$'
    WHEN 'PAGE_PREVIEW'   THEN object_key ~ '^org/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/preview/[0-9a-hjkmnp-tv-z]{2}/[0-9a-hjkmnp-tv-z]{32}/[0-9a-f]{32}/p[0-9]{5}-w(400|800|1600|2400)[.]webp$'
    WHEN 'ENGINE_PAYLOAD' THEN object_key ~ '^org/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/payload/[0-9a-hjkmnp-tv-z]{2}/[0-9a-hjkmnp-tv-z]{32}/r[0-9]{4}/p[0-9]{5}-[0-9a-z][0-9a-z-]{0,30}[0-9a-z]-d[1-9][0-9]{2,3}[.]json[.]zst$'
    WHEN 'EXPORT'         THEN object_key ~ '^org/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/export/[0-9a-hjkmnp-tv-z]{2}/[0-9a-hjkmnp-tv-z]{32}[.](csv|xlsx|json|pdf|zip)$'
  END
);
```

The same migration adds the traversal clause to the two sibling key columns, per §8.2.1:

```sql
ALTER TABLE ocr_results     ADD CONSTRAINT ocr_result_payload_ref_no_traversal
  CHECK (payload_ref IS NULL OR payload_ref !~ '(^|/)[.]{1,2}(/|$)');
ALTER TABLE extraction_jobs ADD CONSTRAINT extraction_job_result_ref_no_traversal
  CHECK (result_ref  IS NULL OR result_ref  !~ '(^|/)[.]{1,2}(/|$)');
```

**Why this is a `CHECK` and not a tunable.** `f2` `TUNABLE_LIMITS_IN_SCHEMA = none` forbids database
constraints on *tunable* values, because lowering a tunable then fails against existing rows. This
constraint is not tunable: it is a **grammar**, it is immutable by C1-7, and by §12 a change to it is
a data migration in any case. Note the direct consequence for §4.1.1: because the `CHECK` encodes
`p[0-9]{5}` — a *width* — and not `f2`'s page cap — a *limit* — raising `MAX_PAGES_PER_DOCUMENT` from
500 to 900 requires no `ALTER TABLE` at all. That is `TUNABLE_LIMITS_IN_SCHEMA` honoured, not
circumvented.

The `length(object_key) <= 512` clause is redundant with the column type and is kept only so the
constraint reads as a complete statement of the rule.

The shard-matches-its-own-id property is **not** expressible in a single regex and is therefore
enforced by the parser (§8.2's closing round-trip) and by the app-vs-DB equivalence test, in the same
way `f1` `db.rls.visibility_policy` is a second enforcement of a predicate the chokepoint also
applies. The equivalence test is generated from the same vector file as everything else: all 400
accept vectors must pass the `CHECK` and all 200 reject vectors must raise `23514`, executed against a
real PostgreSQL instance in CI — because a PostgreSQL POSIX regex and a JavaScript regex are not the
same dialect, and asserting they agree is cheaper than reasoning that they do.

### 13.2 Index consequences

`storage_object_bucket_key_key` `(bucket, object_key)` stays **non-partial and unique**, unchanged
from `g` §5.4. Under content addressing it would have had to become partial on `deleted_at IS NULL`
(a re-upload after a soft delete would produce the same key and raise `23505` — the same defect class
as `f1`'s defects A and B). Under identity addressing a `public_id` is never reused, so a key is
globally unique forever and no partial index is needed. `f1` `partial_index.policy`'s count of
**seven** partial indexes is therefore unchanged by this document.

`storage_object_org_original_fp_key` must become non-unique — see §14.1.

Two indexes are added:

```sql
CREATE INDEX storage_object_org_kind_created_idx
  ON storage_objects (organization_id, kind, created_at DESC);   -- retention sweeps, per-namespace GC
CREATE INDEX document_org_fingerprint_idx
  ON documents (organization_id, content_fingerprint)
  WHERE deleted_at IS NULL;                                       -- the duplicate-detection HINT (§3.1)
```

The second is partial, which makes the platform total **eight** — see §14.2.

### 13.3 Migration ordering

| # | File | Contents |
|---|---|---|
| 0011 | `20260911000100_storage_key_contract` | `object_key` → `VARCHAR(512)`; `storage_object_key_shape` CHECK; `storage_object_immutable_trg`; `envelope_version`, `plaintext_bytes`, `plaintext_sha256`, `last_read_at` columns; `documents.original_filename`; the two `*_no_traversal` CHECKs of §13.1 |
| 0012 | `20260911000200_storage_kind_and_buckets` | `StorageObjectKind` drops `PAGE_THUMBNAIL`, adds `PAGE_PREVIEW`; **`bucket VarChar(63)` → `bucket_role storage_bucket_role`** (C1-14), all existing rows → `'PRIMARY'`; `storage_object_bucket_key_key` rebuilt on `(bucket_role, object_key)`. **No GUCs are created — that was the fail-open defect.** |
| 0013 | `20260911000300_document_status_cancelled` | `ALTER TYPE "DocumentStatus" ADD VALUE 'CANCELLED'`; `scan_verdict` column and enum, `DEFAULT 'PENDING'` |
| 0014 | `20260911000400_export_documents` | `exports` and `export_documents` (§13.4), both with the `f1` TEN-1 composite FK |
| 0015 | `20260911000500_fingerprint_hint` | `storage_object_org_original_fp_key` → non-unique (**pending §14.1 arbitration**); `document_org_fingerprint_idx` |
| 0016 | `20260911000600_payload_ref_migration_window` | `reject_mutation_except_key_migration()` (§12's insurance policy) |
| 0017 | `20260911000700_envelope_key_refs` | `export_keys` table; `document_keys.key_ref BYTEA(16)` + unique index (**pending §14.4 arbitration with `gate-2`**) |

### 13.4 The `exports` entity this document depends on

`g`'s data model contains no `Export` model at all — `l` §3.5 returns an `exportId` from an API that
nothing in `g` backs. An `EXPORT` key cannot exist without one, so the minimum shape is stated here.
**This document owns only `public_id`, `bucket_role` and the key-relevant columns; format, status,
row/cell counts and the request parameters are `l`'s and `g`'s.**

```prisma
model Export {
  id             String   @id @db.Uuid                      // f1 id.internal — uuid v7
  publicId       String   @unique @map("public_id") @db.VarChar(32)   // f1 id.external.shape
  organizationId String   @map("organization_id") @db.Uuid
  // … format, status, requestedByMembershipId, rowCount, cellCount — owned by l/g
  expiresAt      DateTime @map("expires_at")                // now() + OCR_STORAGE_EXPORT_RETENTION_DAYS
  deletedAt      DateTime? @map("deleted_at")
  @@map("exports")
}

model ExportDocument {                                       // §4.5 mechanism 1
  exportId       String @map("export_id")   @db.Uuid
  documentId     String @map("document_id") @db.Uuid
  organizationId String @map("organization_id") @db.Uuid
  @@id([exportId, documentId])
  // composite FKs on (exportId, organizationId) and (documentId, organizationId) — f1 TEN-1
  @@map("export_documents")
}

model ExportKey {                                            // §4.5 mechanism 1, §14.4
  exportId       String @id @map("export_id") @db.Uuid
  organizationId String @map("organization_id") @db.Uuid
  keyRef         Bytes  @unique @map("key_ref") @db.ByteA    // §10.1 — 16 bytes, never a UUID
  wrappedDek     Bytes  @map("wrapped_dek")                  // wrapped by the tenant KEK — gate-2 owns the KEK
  @@map("export_keys")
}
```

`f1` VIS-1 ("every externally-addressable model has a `publicId`") already requires `Export.publicId`;
this section is the place it becomes concrete. `f1` TEN-1 requires the composite FKs. Neither is
re-derived here.

---

## 14. Challenges to frozen values

### 14.1 `f1` `uniq.storage_original_fingerprint` must become non-unique — HIGH

**Frozen value.**
`CREATE UNIQUE INDEX storage_object_org_original_fp_key ON storage_objects (organization_id, content_fingerprint) WHERE kind = 'ORIGINAL' AND deleted_at IS NULL;`

**Objection.** It enforces at most one live `ORIGINAL` object per `(org, fingerprint)`, i.e. it
*requires* blob sharing between documents. `gate-2` `erasure.mechanism` freezes one DEK per document.
A shared blob has one ciphertext and therefore one DEK, so erasing document A destroys document B's
bytes — the exact failure `f1` itself names for the derivative case ("Reusing a colliding derivative
row is **forbidden** — it makes PDPA erasure of document A destroy a blob document B renders"). It was
simply not applied to `ORIGINAL`. Independently, the two frozen values cannot both be honoured
on a routine user action: a user re-uploading the same invoice as a second document raises `23505`.

**Proposed value.**
`CREATE INDEX document_org_fingerprint_idx ON documents (organization_id, content_fingerprint) WHERE deleted_at IS NULL;` — non-unique, moved to `documents` where the fingerprint is a property of the upload rather than of a shared blob, and used only as a duplicate-detection hint.

**If the owner keeps the frozen value:** `ORIGINAL` reverts to content-addressed
`org/{orgId}/blob/{sh}/{fingerprint}`, writes use `ON CONFLICT … DO NOTHING` and reuse the existing
row, and the platform ships with a known, documented PDPA defect: **an erasure request for document A
silently destroys document B's original whenever their bytes are identical.** That defect must then
be recorded in the DPA and in `gate-2`'s open-risk list. This document implements the identity-
addressed form because the alternative is an unsound erasure guarantee, and flags it here rather than
deviating silently.

### 14.2 `f1` `partial_index.policy` — the count moves from seven to eight — LOW

**Frozen value.** "All 7 partial indexes are hand-authored raw SQL in migrations, on the documented
drift allowlist, asserted at startup by `pg_indexes.indexdef`."

**Objection.** §13.2 adds `document_org_fingerprint_idx … WHERE deleted_at IS NULL`, making eight.
The *policy* is unchanged and correct; only the number and the allowlist table need updating. Flagged
because "7" is a frozen literal that a startup assertion may compare against.

**Proposed value.** 8, with `document_org_fingerprint_idx` added to `f1`'s allowlist table and to the
startup assertion.

### 14.3 `f3` `ai.spool.key` should use the document `public_id` — LOW

**Frozen value.**
`/data/ai/{orgId}/{documentId}/{pipelineVersion}/{promptVersion}/{chunkIndex}.{idempotencyKey}.json`

**Objection.** `{documentId}` is the internal UUIDv7, which `f1` `id.external.count` says "never
leaves the server" and which discloses the upload millisecond. The spool volume is private, so the
exposure is far smaller than for an object key — but it is mounted **read-only into `ocr-web`**
(`f3` `ai.spool.volume`), it is inside a container that holds the gateway credential, and it will
appear in any support bundle, `docker cp`, or volume snapshot. Using `public_id` costs nothing and
makes the rule "no internal id ever appears in a path" total rather than nearly-total.

**Proposed value.**
`/data/ai/{orgId}/{docPub}/{pipelineVersion}/{promptVersion}/{chunkIndex}.{idempotencyKey}.json`,
with `docPub` lowercased exactly as in §5.2.

### 14.4 `gate-2` `erasure.mechanism` needs two additions it does not currently contain — MEDIUM

**Frozen value.** *"crypto-shredding (per-document 256-bit DEK, AES-256-GCM, wrapped by a tenant KEK,
wrapped by a root key)"*, with `document_keys` keyed by document id (D-G2-8).

**This is not an objection — the mechanism is right.** It is a request for two additions that this
document's implementation requires and that `gate-2` cannot have anticipated, because both fall out of
the object-key and envelope design:

1. **A non-timestamped key reference.** An envelope header must name the key that decrypts it. Naming
   it by `document_keys.id` puts a UUIDv7 — and therefore the upload millisecond — in plaintext at the
   head of every stored ciphertext, on every surface C1-2/§3.2 removes it from. **Proposed:**
   `document_keys.key_ref BYTEA(16) UNIQUE NOT NULL` = the first 16 bytes of the document's
   `public_id`, base32-decoded. Lookup is by `key_ref`, never by document id. No new secret, no new
   entropy source, and nothing disclosed that the object's own key did not already disclose.
2. **A key class for exports.** An export spans many documents (§4.5) and cannot be encrypted under
   any one document's DEK, so it needs a per-export DEK wrapped by the same tenant KEK. `gate-2`
   D-G2-8 defines only per-document DEKs. **Proposed:** `export_keys` (§13.4), same wrapping chain,
   same destruction primitive, destroyed in the same transaction as any joined document's DEK.

**If the owner declines (1):** the envelope must carry a random 16-byte `key_ref` in a new column
instead, which works equally well and costs one more column plus an index — the *only* unacceptable
outcome is naming the key by its UUID.

**If the owner declines (2):** exports must not be persisted at all; they become synchronous-only,
which contradicts `l` §3.5 and caps an export at what a request timeout allows. There is no third
option in which exports are both stored and erasable.

### 14.5 `f2`'s prose names a document state that this document's enum does not have — INFORMATIONAL

**Frozen value.** `f2` F2-D3's implementation prose: *"the document enters `SCANNING` after the body
is durably staged; the HTTP request returns `202` immediately."*

**Not a challenge, and deliberately not raised as one.** `f2`'s CANONICAL VALUES table freezes no
document-status enum, and `f2` itself attributes `SCANNING` to `h`'s **job** state machine two
paragraphs later. §11.3.1 records the reconciliation in full: `SCANNING` remains a job state owned by
`h`; its document-level projection is `VALIDATING`; and the information a caller actually needs is on
`documents.scan_verdict`. It is listed here so that a future reader who greps `f2` for `SCANNING` and
does not find it in `docstatus.enum` finds this entry instead of assuming a contradiction.

### 14.6 `g` §5.4's `bucket String @db.VarChar(63)` — HIGH, but `g` is superseded, not frozen

**Value being changed.** `g` §5.4's free-string bucket column and
`storage_object_bucket_key_key (bucket, object_key)`.

**Recorded here rather than in §14.1–§14.4 because `g` is an M0 input, not a frozen M0.5 value.** It
is listed for completeness of the change set: C1-14 replaces the column with a two-value enum and
rebuilds the unique index on `(bucket_role, object_key)`. No M0.5 document restates `g`'s column type,
so nothing is contradicted. See §4.6 for the fail-open trigger this fixes.

---

## 15. Owner-blocked items

| Tag | Question | Default that ships if the owner stays silent | Consequence of the default |
|---|---|---|---|
| **B-C1-1** | Is object storage required to be in-country? `gate-2` §1224 records the constraint ("Backups and object storage must be in-country … owned by the storage dimension") but no jurisdiction is named. | **Local disk only at M1**, on the in-country production host, with the S3-compatible adapter present but unconfigured. `OCR_STORAGE_DRIVER=local`. | No third-party object store is engaged, so no cross-border transfer analysis is needed at M1. Costs the durability of a managed store; `g`'s render TTL keeps the volume bounded. |
| **B-C1-2** | Are infected customer uploads retained for incident response, or deleted immediately with only metadata kept? | **Retained 7 days** in the quarantine bucket, inside the crypto-shredding boundary. `OCR_STORAGE_QUARANTINE_RETENTION_DAYS=7`. | A false-positive verdict can be investigated; a true positive is available to the AV vendor. Set to `0` to delete on verdict, keeping `scan_results` metadata only. |
| **B-C1-3** | Export retention. | **7 days.** `OCR_STORAGE_EXPORT_RETENTION_DAYS=7`. | Bounds the window in which §4.5's join-table erasure has work to do. A longer TTL widens the interval during which an erased subject's data survives inside an export. |

The `B-n` namespace already collides across M0.5 documents (`f2` uses B-1..B-3, `gate-2` uses
B-1..B-5 for different questions). This document uses a document-scoped `B-C1-n` prefix and
recommends the orchestrator adopt that convention retroactively.

---

## 16. Configuration

`config/storage-keys.yaml` is the single source of truth for the *grammar* (namespaces, field
widths, alphabets, suffix maps, shard width). It generates the TypeScript package, the Python
package, the SQL `CHECK` of §13.1, and the conformance vectors. Nothing in it is an environment
variable, because changing a grammar changes only *future* keys while every existing key keeps the
old shape — that is a migration, never a restart.

Environment variables, all of which are *deployment* facts rather than grammar:

Every variable below has a name, a default, a permitted range and a documented failure behaviour.
None of them is a qualitative gate, and none of them is `TBD`.

| Variable | Default | Range / legal values | Meaning |
|---|---|---|---|
| `OCR_STORAGE_DRIVER` | `local` | `local` \| `s3` | Backend selector. `local` is B-C1-1's shipping default |
| `OCR_STORAGE_BUCKET_PRIMARY` | `innovera-ocr` | 3–63 chars, DNS bucket-name shape | Physical name for `bucket_role='PRIMARY'`; ignored when the driver is `local` |
| `OCR_STORAGE_BUCKET_QUARANTINE` | `innovera-ocr-q` | as above | Physical name for `bucket_role='QUARANTINE'` |
| `OCR_STORAGE_ROOT` | `/data/ocr-files` | absolute path | Parent of `objects/`, `quarantine/`, `tmp/` (the `local` driver's role map) |
| `OCR_STORAGE_QUARANTINE_RETENTION_DAYS` | `7` | `[0, 90]` | B-C1-2. `0` = delete on verdict, metadata kept |
| `OCR_STORAGE_EXPORT_RETENTION_DAYS` | `7` | `[1, 30]` | B-C1-3 |
| `OCR_STORAGE_EXPORT_SWEEP_INTERVAL_S` | `900` | `[60, 86400]` | §4.5; bounds key-destruction-to-byte-absence at 15 min. Never a correctness dependency |
| `OCR_STORAGE_ORPHAN_MIN_AGE_S` | `3600` | `>= 2 × f2.JOB_PROCESSING_BUDGET_MS / 1000` | §7.3. **Derived, and the inequality is asserted rather than the number** |
| `OCR_STORAGE_ENVELOPE_FRAME_BYTES` | `1048576` | `[65536, 8388608]` | §10.1. Applies to **newly written** objects only; readers take the frame size from the object's own header, so a change needs no `envelope_version` bump |
| `OCR_STORAGE_DEDUP_MODE` | `hint` | `hint` only | §3.1; exists so reintroducing blob sharing trips a review |
| `OCR_STORAGE_MAX_RECIPES_PER_DOCUMENT` | `4` | `[1, 16]` | C1-17 / §5.6 |
| `OCR_STORAGE_DERIVATIVES_COUNT_AGAINST_QUOTA` | `true` | `true` only | §5.6; the same review-tripwire pattern |
| `OCR_STORAGE_FILENAME_MAX_BYTES` | `1080` | `>= 9 × f2.FILENAME_MAX_CHARS` | §4.9; 9 bytes per Thai grapheme cluster |
| `OCR_STORAGE_LEASE_CREDENTIAL_MODE` | `subtree` (local) / `sts` (s3) | `none` \| `subtree` \| `sts` | §9.4. `none` is legal **only** with `OCR_STORAGE_DRIVER=local` **and** `OCR_ENV=development` |
| `OCR_STORAGE_LEASE_CREDENTIAL_TTL_GRACE_S` | `60` | `[10, 300]` | §9.4; added to the remaining lease |
| `OCR_STORAGE_AV_ERROR_ALERT_COUNT` | `20` | `[1, 1000]` | §11.3.1 |
| `OCR_STORAGE_AV_ERROR_ALERT_WINDOW_S` | `300` | `[60, 3600]` | §11.3.1 |
| `OCR_ENGINE_SLUG_UNIQUE` | *(assertion, not a value)* | — | §5.5; boot refusal if two registry entries slug identically |

**Startup assertions (fail closed, exit 78 / `EX_CONFIG`, listener never binds):**

1. `sha256(config/storage-keys.yaml)` equals `config/storage-keys.lock.json`.
2. `pg_constraint` contains `storage_object_key_shape`, `storage_object_key_tenant_prefix` (`f1`),
   `ocr_result_payload_ref_no_traversal` and `extraction_job_result_ref_no_traversal`; `pg_trigger`
   contains `storage_object_immutable_trg`; `pg_type` contains `storage_bucket_role` with exactly the
   two labels `PRIMARY` and `QUARANTINE`.
3. `st.dev` is equal for `objects/`, `quarantine/` and `tmp/` (§4.6 requires `rename(2)`), and all
   three resolve (via `realpath`) inside `OCR_STORAGE_ROOT`.
4. `OCR_STORAGE_BUCKET_PRIMARY != OCR_STORAGE_BUCKET_QUARANTINE`.
5. The 400 conformance vectors round-trip in this process, and the 200 reject vectors all throw.
6. `OCR_STORAGE_ORPHAN_MIN_AGE_S >= 2 × f2.JOB_PROCESSING_BUDGET_MS / 1000` (§7.3).
7. `OCR_STORAGE_FILENAME_MAX_BYTES >= 9 × f2.FILENAME_MAX_CHARS` (§4.9).
8. Every `f2` admission cap fits inside its grammar field width (§4.1.1): `MAX_PAGES_PER_DOCUMENT ≤
   99,999`, `MAX_TILES_PER_PAGE ≤ 99`.
9. Engine-registry slugs are unique (§5.5).
10. `OCR_STORAGE_LEASE_CREDENTIAL_MODE != 'none'` unless driver is `local` and `OCR_ENV` is
    `development` (§9.4).
11. The `NAMESPACE` map is total and injective over `StorageObjectKind` — asserted at runtime as well
    as in `tsc`, because the Python twin has no exhaustiveness checker.

---

## 17. Evidence log

**Verified during the original authoring session (fetched from vendor documentation):**

- Amazon S3 object key maximum length — *"a maximum length of 1,024 bytes"*; prefixes and delimiters
  count toward it. AWS S3 User Guide, *Naming Amazon S3 objects*.
- Amazon S3 character guidance — `@`, `=`, `;`, `:`, `+`, `,`, `?` "might require additional code
  handling"; period-only path segments "can cause unexpected behavior" and may be normalised by SDKs;
  `folder/..backup/file.txt` "works normally" while `folder/../file.txt` does not. Same page.
- Google Cloud Storage — *"Object name size in a flat namespace bucket: 1-1024 bytes when UTF-8
  encoded"*; hierarchical-namespace names split into folder and base-name segments of **512 bytes
  each**. Google Cloud Storage docs, *Objects*.

**Verified during the adversarial review (re-fetched or newly fetched; every previously UNVERIFIED
row is now resolved except SeaweedFS, which is deferred with a reason):**

- Amazon S3, *Naming Amazon S3 objects*, re-fetched and confirmed verbatim: the 1,024-byte limit
  ("or approximately 1,024 Latin characters"); the full safe-character set (alphanumerics plus
  `! - _ . * ' ( )`); the "might require special handling" list (which includes `&` and `$` and the
  ASCII 00–1F/7F ranges — the first draft's rendering of this list was incomplete but not wrong); the
  "characters to avoid" list; the period-only-segment guidance; **and two facts the first draft did
  not have**: (i) *"Object keys that contain relative path elements (for example, `../`) are valid
  if, when parsed left-to-right, the cumulative count of relative path segments never exceeds the
  number of non-relative path elements encountered"*, with `videos/2014/../../video1.wmv` given as
  **valid** — this is the fact §8.2.1 turns into a tenant-isolation argument; and (ii) the S3 console
  strips trailing periods from downloaded key names, which is the vendor evidence for §8.2's new
  `endsWith('.')` rejection.
- Amazon S3, *Best practices design patterns: optimizing Amazon S3 performance*, fetched directly
  rather than via `i` §2.2: *"at least 3,500 PUT/COPY/POST/DELETE or 5,500 GET/HEAD requests per
  second per partitioned Amazon S3 prefix. There are no limits to the number of prefixes in a
  bucket."* and *"The scaling … happens gradually and is not instantaneous … you may see some
  503 (Slow Down) errors."* Both numbers in §9.2 are now first-hand.
- Google Cloud Storage, *Objects*: flat namespace 1–1,024 bytes; hierarchical namespace **folder name
  segment ≤ 512 bytes** and **base name segment ≤ 512 bytes**; objects cannot be named `.` or `..`;
  names cannot contain CR or LF; names cannot start with `.well-known/acme-challenge/`. **This
  corrected a category error in the first draft**, which read the 512-byte folder limit as a
  per-path-component limit and compared it against our longest component.
- Cloudflare R2, *Limits*: object key length **1,024 bytes**. Previously assumed by S3 compatibility;
  now first-hand.
- Azure Blob Storage, *Naming and Referencing Containers, Blobs, and Metadata*: blob name 1–1,024
  **characters**; path segments ≤ **254** without hierarchical namespace and ≤ **63** with it
  ("including path segments for account name and container name"); *"No path segments should end with
  a dot (.)"*; avoid names ending in `.`, `/`, `\`; control characters 0x00–0x1F invalid.
- `file-type` on the npm registry: latest is **22.0.2**, MIT, `engines.node >= 22`. This confirms
  `j` §3.1's version claim, which §6.1 relies on, and confirms it is compatible with the house Node
  22 runtime.

**Cited from M0 documents whose own evidence was recorded there:**
`KEY_RE.test('a/../b') === true` on node v22.22.3 via `i` §3.2 (4a) — and independently re-derived by
inspection during this review: the pattern's anchors bind the whole string, `/`, `.` and `-` are all
in the character class, and the string starts and ends with `[0-9a-z]`, so the match is unavoidable.
`file-type` reading a 4,100-byte sample via `j` §3.1. APFS case-insensitivity on this workstation via
`i` §3.3 attack 9.

**Still UNVERIFIED, labelled in-line, with the reason it is acceptable:** SeaweedFS filer path limits
(§9.1) — not an M1 backend, and our margin against every verified backend is ≥ 5.6× on the tightest
published dimension; verify before any SeaweedFS adoption decision, not before M1. Current S3
per-request pricing (§12 deliberately quotes request counts and bytes, never money).

**Nothing in this document asserts any fact about the LiteLLM gateway, its model list, its version, or
any model's vision capability.** The AI-side interactions here are limited to citing `f3`'s frozen
placement decisions and one challenge to `f3`'s spool path shape (§14.3).

**Sources:**
- [Naming Amazon S3 objects](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-keys.html)
- [Best practices design patterns: optimizing Amazon S3 performance](https://docs.aws.amazon.com/AmazonS3/latest/userguide/optimizing-performance.html)
- [Google Cloud Storage — Objects](https://docs.cloud.google.com/storage/docs/objects)
- [Cloudflare R2 — Limits](https://developers.cloudflare.com/r2/reference/limits/)
- [Azure — Naming and Referencing Containers, Blobs, and Metadata](https://learn.microsoft.com/en-us/rest/api/storageservices/naming-and-referencing-containers--blobs--and-metadata)
- [file-type on the npm registry](https://registry.npmjs.org/file-type/latest)

---

## CANONICAL VALUES

Every value below is owned by this document. Other documents must **cite** them
(`see c1-storage-key-contract.md §x`) and must never restate them.

| key | value | env var | reason | failure behaviour |
|---|---|---|---|---|
| `storage.key.grammar.original` | `org/{orgId}/original/{sh}/{docPub}` | — | Identity-addressed: one document, one DEK, one ciphertext, one erasure (§3.1). Content addressing is unshreddable under `gate-2` `erasure.mechanism`. | A key not matching this is rejected by `storage_object_key_shape` (`23514`), by `parseObjectKey`, and by `tsc`. |
| `storage.key.grammar.render` | `org/{orgId}/render/{sh}/{docPub}/{recipeHash}/p{page:05d}[-t{tile:02d}].{ext}` | — | Recipe-addressed so a same-recipe requeue is a cache hit and a renderer upgrade cannot reuse stale pixels. The tile element is present iff the page was tiled: without it, a tiled page's 12 bitmaps all mint one key and 11/12 of the evidence is silently discarded (§4.8). | As above. |
| `storage.key.grammar.preview` | `org/{orgId}/preview/{sh}/{docPub}/{previewHash}/p{page:05d}-w{width}.webp` | — | Display derivative at one of four widths. The hash is over the render recipe **⊕ the preview profile**, not the render hash: sharing it means a downscaler change serves stale pixels forever under `Cache-Control: immutable` (§5.4.1). | As above. |
| `storage.key.tile_element` | `-t{tile:02d}`, 1-based, present iff tiled; grammar width 2 digits (1..99), admission cap is `f2` `MAX_TILES_PER_PAGE` | `storage.tile_digits` in `config/storage-keys.yaml` | `c3` `OCR_ROUTE_TILING_DPI_FLOOR` makes tiling a routine outcome for A0 drawings and Thai land-title plans. `ENGINE_PAYLOAD` deliberately has **no** tile element, because `f1` `uniq.ocr_result` is per page and tile text is stitched before the payload is written. | A `-t00`, `-t0` or `-t003`, or a tile element on a spec with no tile, dies at `parseObjectKey`'s closing round-trip. |
| `storage.preview_hash` | `sha256(canonicalJson({...renderRecipe, preview: previewProfile})).hex.slice(0,32)`; `width` is **not** in the hash | — | Distinct TypeScript brand `PreviewHash` from `RecipeHash` — both are 32 hex chars, so only the type system can prevent the substitution. Thai tone marks occupy ~3 px at preview widths, so a downscaler change is exactly the change that decides whether a reviewer can read the glyph. | Passing a `RecipeHash` where a `PreviewHash` is required is a `tsc` error. |
| `storage.key.grammar.payload` | `org/{orgId}/payload/{sh}/{docPub}/r{runSeq:04d}/p{page:05d}-{engineSlug}-d{dpi}.json.zst` | — | The rendered form of `f1` `uniq.ocr_result`'s tuple, so one evidence row ⇔ one key structurally. | As above. |
| `storage.key.grammar.export` | `org/{orgId}/export/{sh}/{exportPub}.{ext}` | — | Exports are their own entity with their own public id and their own DEK. | As above. |
| `storage.key.tenant_segment` | `org/{organization_id}` — internal org UUID, lowercase hyphenated | — | Frozen by `f1` `storage.tenant_prefix_check`; the only identifier a database `CHECK` can compare against a column of the same row. | `f1`'s `storage_object_key_tenant_prefix` CHECK raises `23514`. |
| `storage.key.document_segment` | `documents.public_id` lowercased (32 chars, `[0-9a-hjkmnp-tv-z]`) | — | An internal UUIDv7 in a key publishes the upload millisecond to the storage provider, its logs, its inventory reports and its staff (§3.2). | `documentPublicId()` throws `StorageKeyError('invalid-id')` before a key exists. |
| `storage.key.shard` | first **2** characters of the public id that immediately follows | `storage.shard_chars` in `config/storage-keys.yaml`, not an env var | Uniform because `public_id` is `crypto.randomBytes(20)` with no timestamp; 1,024 buckets ⇒ ~234 entries/dir/org-year. Saves one SHA-256 per mint versus `i` §2.2. | A key whose shard does not match its own id fails `parseObjectKey`'s closing `mint(parse(k)) === k`. |
| `storage.key.max_bytes` | `512` (column `VARCHAR(512)`; longest producible key is **145** bytes — `ENGINE_PAYLOAD`) | — | 7.1× headroom under the 1,024-byte ceilings verified this session on S3, GCS-flat, R2 and Azure; a column bound equal to the provider's own limit gives no early warning, and one snug against the worst case must be widened by the first migration that prefixes keys. Replaces `g` §5.4's `VarChar(1024)`. **Corrects the first draft's 151.** | `assertSafeObjectKey` throws (length is checked **first**, so every later regex runs on a ≤ 512-byte string and none can be a ReDoS target); the column type rejects. |
| `storage.key.segment_max_bytes` | `64` (longest producible path component is **54**; longest folder prefix is **91**; longest base name is **54**) | — | Under `NAME_MAX` (255 per component). The GCS hierarchical-namespace limits are **512 bytes for the whole folder segment and 512 for the base name** — not per path component; the first draft compared against the wrong quantity. Azure's HNS ≤ 63 path segments is met with 9 of 63 used. | `assertSafeObjectKey` throws. |
| `storage.key.field_widths_are_not_limits` | grammar widths: page 5 digits (1..99,999), tile 2 digits (1..99), runSeq 4 digits, dpi 3–4 digits. The **policy** caps are `f2`'s and are enforced at admission, never in the grammar or the `CHECK`. | — | `f2` `TUNABLE_LIMITS_IN_SCHEMA = none`: a limit must be changeable by restarting a container, a field width is immutable by C1-7 and changing it is the §12 migration. Sizing a width to today's limit turns every future limit change into a full key rewrite. | Boot assertion 8 and property test (h) fail if an `f2` cap ever exceeds its field width. |
| `storage.key.segment_count` | `5..7` inclusive | — | `ORIGINAL`/`EXPORT` are 5, the three document-scoped derivatives are 7. Replaces `i` §3.2's "exactly 7". | `assertSafeObjectKey` throws. |
| `storage.key.alphabet` | `^[0-9a-z](?:[0-9a-z.\-/]*[0-9a-z])?$` — lowercase ASCII, `.`, `-`, `/`. No `_`, no `@`. | — | Kills NUL, controls, absolute paths, backslash, overlong UTF-8, confusables, every Thai codepoint and case collisions. `@` is on AWS's own special-handling list (verified), which is why `g` §7.4's `@{dpi}` is rejected. | `assertSafeObjectKey` throws `StorageKeyError('invalid-key')`. |
| `storage.key.traversal_rule` | No segment may equal `.` or `..`, start with `.` or `-`, **or end with `.` or `-`**; the check is **per segment**, never whole-string. The identical `!~ '(^\|/)[.]{1,2}(/\|$)'` clause is on `storage_objects.object_key`, `ocr_results.payload_ref` and `extraction_jobs.result_ref`. | — | **This check *is* `f1` `storage.tenant_prefix_check`'s tenant boundary, not a nicety.** A SQL `LIKE` prefix test is purely lexical, so `org/A/../B/original/…` satisfies `LIKE 'org/A/%'` and normalises into tenant B. AWS states (verified this session) that keys containing `../` **are valid** and that tools normalise them inconsistently; on the local driver `path.join` resolves them out of the storage root. Trailing `.` is Azure's explicit rule and the S3 console strips it on download. Leading `-` is argument injection into `pdftoppm`/`gs`/`tesseract`. | Throws; and `23514` from three separate `CHECK`s. Property tests (b) and (f) assert both that the regex alone does *not* catch it and that a LIKE-passing escape is rejected, so the check cannot be "optimised" away. |
| `storage.key.mutability` | **A key is never updated.** `bucket_role` may change exactly once, `PRIMARY → QUARANTINE`, never back. `kind`, `organization_id`, `plaintext_sha256`, `size_bytes`, `plaintext_bytes` and `envelope_version` are equally immutable; `content_type`, `deleted_at` and `last_read_at` are not. | — | The owner's "immutable original object identity", satisfied through quarantine as well. Everything an object *is* is frozen; everything we have *learned about* it is not. | `storage_object_immutable_trg` raises `42501`. |
| `storage.bucket_role` | `enum storage_bucket_role { PRIMARY, QUARANTINE }` on `storage_objects.bucket_role`; the **physical** bucket or local root is resolved from configuration at boot. Replaces `g` §5.4's `bucket String @db.VarChar(63)`; `storage_object_bucket_key_key` becomes `(bucket_role, object_key)`. | `OCR_STORAGE_BUCKET_PRIMARY`, `OCR_STORAGE_BUCKET_QUARANTINE` (physical names only) | The trigger this replaces compared against `current_setting('app.bucket_primary', true)`, which returns **NULL** when unset — so `TRUE AND NOT (NULL AND …)` evaluated to NULL, the `IF` never fired, and **every** bucket transition including `QUARANTINE → PRIMARY` was silently permitted. `f1` `db.guc.setter` also makes GUCs transaction-local, so a startup-set GUC is absent on a pooled connection. An enum compares against literals and cannot be absent. | `42501` on any transition other than `PRIMARY → QUARANTINE`, **including on a connection with no GUCs set at all** — which is the negative test in migration 0012's test file. |
| `storage.namespaces` | `original`, `render`, `preview`, `payload`, `export` | — | One literal segment per `StorageObjectKind`, total and injective; per-namespace bucket policies and retention sweeps become expressible. | Unknown namespace ⇒ `parseObjectKey` throws. |
| `storage.object_kind_enum` | `enum StorageObjectKind { ORIGINAL PAGE_RENDER PAGE_PREVIEW ENGINE_PAYLOAD EXPORT }` | — | `PAGE_THUMBNAIL` deleted — a thumbnail is a `PAGE_PREVIEW` at `w=400` (`l` §4.4). Two kinds with one lifecycle is how a kind-scoped policy ends up covering half the objects. | `tsc` exhaustiveness error; `ALTER TYPE` required to add a value. |
| `storage.preview_widths` | `400, 800, 1600, 2400` | — | `l` §4.4's closed set, adopted. A free `w` is an unbounded render cache keyed by attacker-chosen values. | Any other width ⇒ 422 at the route and `parseObjectKey` rejection. |
| `storage.recipe_hash` | `sha256(canonicalJson(renderRecipe)).hex.slice(0,32)` — 128 bits, 32 lowercase hex | — | Cache discriminator, not a security boundary. Keys sorted, no whitespace, integers only. The recipe schema is **append-only**: removing a field silently reshuffles every hash. The recipe's *field values* are owned by `e`/`f`; every *threshold* that selects one is owned by `c3` and is not restated here. | A CI check fails on any field removal from the recipe schema. |
| `storage.max_recipes_per_document` | `4`; render/preview/payload/export ciphertext counts against the tenant storage quota | `OCR_STORAGE_MAX_RECIPES_PER_DOCUMENT`, `OCR_STORAGE_DERIVATIVES_COUNT_AGAINST_QUOTA` | §5.2 class C proves a tenant-influenced value cannot change a segment's *alphabet or length*; it says nothing about **cardinality**. An authenticated user toggling recipe flags mints unbounded page-render sets, amplifying storage by a four-figure multiple of the document — a DoS against the paying tenant's own `f2` `DEFAULT_STORAGE_QUOTA_BYTES`. Four covers default + one requeue + one deskew retry + one renderer bump. | At the cap, evict the least-recently-read recipe set **no `ocr_results` row references**; if all are referenced, `429` with `f2` `ERROR_CODE_QUOTA`'s windowed code. Metric `storage_recipe_cap_reached_total`; three hits/hour on one document alerts. |
| `storage.engine_slug` | `trimHyphens(slug(engineId)-slug(engineVersion) sliced to 32)`, `^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$`, **registry-unique**, asserted at boot | `OCR_ENGINE_SLUG_UNIQUE` (assertion) | **Corrects a false claim in the first draft.** It said the database rejects a second row when two versions slug identically. It does not: `f1` `uniq.ocr_result` is over the **real** columns, so two distinct versions are two legal rows — that then mint the **same** payload key, and the second row's `payload_ref` silently points at the first row's payload. The slug is lossy, so it is only safe if it is injective, and only the registry can make it so. The corrected regex also forbids a trailing hyphen (which `slice(0,32)` can produce) and a zero-length slug (which a Thai-digit engine id would produce). | Boot refusal (exit 78) on a registry slug collision. On `created:false` for `ENGINE_PAYLOAD`, digests are compared: equal ⇒ idempotent retry, unequal ⇒ `SEC_OBJECT_KEY_COLLISION` CRITICAL, job fails closed. |
| `storage.extension_policy` | `ORIGINAL` carries **no extension**. Derivative suffixes come from a closed generated map: render `png\|tif\|jpg`, preview `webp`, payload `json.zst`, export `csv\|xlsx\|json\|pdf\|zip`. | — | The strongest form of "never derived from the upload" is "not present". A sniffer verdict in an immutable path means a re-classification is a key rewrite (§6.1). `Content-Type` comes from `storage_objects.content_type`. | An unmapped suffix is a `tsc` error and a `CHECK` violation. |
| `storage.buckets` | `OCR_STORAGE_BUCKET_PRIMARY` = `innovera-ocr`; `OCR_STORAGE_BUCKET_QUARANTINE` = `innovera-ocr-q`; on the `local` driver the roles resolve to `$OCR_STORAGE_ROOT/objects` and `$OCR_STORAGE_ROOT/quarantine` | `OCR_STORAGE_BUCKET_PRIMARY`, `OCR_STORAGE_BUCKET_QUARANTINE`, `OCR_STORAGE_ROOT` | Quarantine gets physical separation via `bucket_role` and tenant attribution via `object_key` — two requirements, two columns. Replaces `i` §4.1's out-of-namespace directory (unfindable by an erasure query) and `j` §4's `quarantine/{documentId}` (no tenant segment). These names are **deployment facts** and reach neither a key nor a trigger. | Startup assertion 4 fails if they are equal; assertion 3 fails if the two roots are on different devices (the quarantine move must be a `rename(2)`) or resolve outside `OCR_STORAGE_ROOT`. |
| `storage.quarantine.retention_days` | `7` — **OWNER-BLOCKED (B-C1-2)** | `OCR_STORAGE_QUARANTINE_RETENTION_DAYS` | Aligned with `f3` `ai.spool.retention_days`. Quarantined bytes stay inside the crypto-shredding boundary. | `0` deletes on verdict, keeping `scan_results` metadata. Outside `[0, 90]` ⇒ boot refusal. |
| `storage.export.retention_days` | `7` — **OWNER-BLOCKED (B-C1-3)** | `OCR_STORAGE_EXPORT_RETENTION_DAYS` | An export spans many documents and sits outside per-document shredding; a hard TTL bounds the exposure. | Outside `[1, 30]` ⇒ boot refusal. |
| `storage.export.erasure_join` | `export_documents (export_id, document_id, organization_id)` with the `f1` TEN-1 composite FK. Erasure **destroys the `export_keys` row** of every export joined to the erased document, in the same transaction as the document DEK destruction; byte deletion is a separate idempotent sweeper. Join rows record the **resolved** document set the query returned, never the filter the user supplied. | `OCR_STORAGE_EXPORT_SWEEP_INTERVAL_S=900` | Without the join table, erasure leaves the subject's data readable in an XLSX in the same bucket. **Correction to the first draft**, which said erasure "hard-deletes the export objects" in the same transaction: a network or filesystem delete cannot participate in a database transaction, and a crash between commit and delete leaves the data readable with no row left to find it by. Key destruction is transactional and reaches backups; byte deletion is cleanup. | Erasure use case raises if the join table or `export_keys` is absent (startup assertion 2 extended). Requires the `gate-2` extension in §14.4. |
| `storage.exports_entity` | `exports (id, public_id VARCHAR(32) UNIQUE, organization_id, expires_at, deleted_at, …)`, `export_documents`, `export_keys (export_id, organization_id, key_ref, wrapped_dek)`. This document owns `public_id`, `key_ref` and the key-relevant columns only. | — | `g`'s data model contains **no `Export` model at all** — `l` §3.5 returns an `exportId` from an API nothing backs. An `EXPORT` key cannot exist without the entity, and `f1` VIS-1 already requires the `publicId`. | Migration 0014/0017. Absent ⇒ the `EXPORT` namespace is unmintable and startup assertion 2 fails. |
| `storage.orphan_min_age_s` | `3600` — **derived**: `2 × f2.JOB_PROCESSING_BUDGET_MS / 1000`, asserted as an inequality at boot, not typed as a number | `OCR_STORAGE_ORPHAN_MIN_AGE_S` | Below this an in-flight write is indistinguishable from a crashed-run leftover and the GC deletes live bytes. The factor of two covers one lease loss and re-claim; `f2`'s budget is **per claim** and resets, which is why one budget is not enough. `f3` `ai.job.budget_ms`'s 120-minute ceiling does not enter the derivation because `f3` `ai.spool.volume` gives the AI worker no object-store mount. | `reclaimOrphan()` refuses and logs `STORAGE_ORPHAN_TOO_YOUNG`. Boot assertion 6 refuses to start if a future `f2` budget increase invalidates the floor. A crypto-shredded object is **never** an orphan: the reconciler keys on row absence, never on readability. |
| `storage.put_semantics` | A decision table (§7.1.1), not a per-kind rule. `ORIGINAL` and `ENGINE_PAYLOAD` on `created:false` compare `plaintext_sha256`: equal ⇒ idempotent retry, unequal ⇒ `SEC_OBJECT_KEY_COLLISION` CRITICAL. `PAGE_RENDER`/`PAGE_PREVIEW`/`EXPORT` on `created:false` are cache hits. An orphaned `ORIGINAL` may be overwritten only inside the upload use case that owns that `public_id`, audited, and is exempt from the age floor. | — | **Corrects both halves of the first draft.** Its unconditional CRITICAL on `ORIGINAL` fired on an ordinary two-phase-upload retry (the key is a pure function of an immutable `public_id`, so a retry re-mints it). Its blanket cache-hit for derivatives hid the slug collision above and the missing tile element. Under identity addressing `key ⇒ document` is a function, so the question is never "whose object is this" but "are these the same bytes". | CRITICAL alert and fail-closed on a digest mismatch; a silent, counted skip on a match. |
| `storage.envelope.format` | AES-256-GCM, **1 MiB** frames, 64-byte header. **Per-object key** = `HKDF-SHA256(ikm=DEK, salt=header.salt(16 random bytes), info="innovera-ocr/storage-object/v1" ‖ objectKey)`. Nonce = `uint32BE(0) ‖ uint64BE(frameIndex)`. AAD = header ‖ frame index. Header = magic(8) ‖ version(2) ‖ cipher(2) ‖ frameSize(4) ‖ **keyRef(16)** ‖ salt(16) ‖ reserved(16). | `OCR_STORAGE_ENVELOPE_FRAME_BYTES=1048576`, range `[65536, 8388608]` | A single GCM pass over the frozen upload cap cannot be streamed without buffering or releasing unauthenticated plaintext; framing also makes ranged reads possible. **Key derivation replaces nonce management**: the first draft's 4-byte random per-object nonce prefix, with ~4,000 objects sharing one per-document DEK, collides at `4000²/2/2³² ≈ 1.9e-3` — **about 1 document in 540** — and GCM nonce reuse leaks `P1 XOR P2` *and* the GHASH subkey. It also spent 8 bytes of counter on a value that never exceeds 200 frames. Binding `objectKey` into `info` additionally makes an object unmovable between keys. Overhead 0.0015 %. | A tag failure on any frame aborts the read with `STORAGE_INTEGRITY_FAILURE`; no plaintext is emitted for that frame. Total decrypted length must equal `plaintext_bytes` or the same error is raised — otherwise dropping trailing frames yields a shorter, perfectly valid plaintext. |
| `storage.envelope.key_ref` | `keyRef` = the **first 16 bytes of the owning entity's `public_id`, base32-decoded** — never `document_keys.id`, never any UUID | — | The first draft put `document_keys.id` (a UUIDv7) in the header, i.e. the upload millisecond in **plaintext at the head of every stored ciphertext**, on precisely the surfaces C1-2/§3.2 spent a section removing it from: the provider, its inventory, backups, snapshots, support bundles. `public_id` is already in the object's own key, so this discloses nothing new. Requires `document_keys.key_ref` / `export_keys.key_ref` — raised to `gate-2` in §14.4. | An unknown `key_ref` on read raises `STORAGE_KEY_REF_UNKNOWN`; no plaintext is emitted. |
| `storage.envelope.version_location` | `storage_objects.envelope_version SMALLINT NOT NULL DEFAULT 1` — a **column**, never the key | — | §5.1: anything that can change independently of identity goes in a column. A cipher roll must not be a key rewrite. | An unknown `envelope_version` on read raises `STORAGE_ENVELOPE_UNSUPPORTED`. |
| `storage.size_bytes_semantics` | `storage_objects.size_bytes` = **ciphertext** bytes at rest; `plaintext_bytes` = decrypted length; `plaintext_sha256` = digest of the plaintext, computed while streaming, **before** encryption. Every `f2` byte limit is compared against **plaintext**. | — | Conflating them mis-counts every quota and emits a wrong `Content-Length`. `plaintext_sha256` is stable across re-encryptions (whose ciphertexts differ by construction, §10.1) and is therefore what makes `storage.put_semantics` decidable. It is distinct from `content_fingerprint`, which is the per-organisation HMAC hint of §3.1. | `f2` `CHECK_storage_objects_size_nonneg` still applies to `size_bytes`, unchanged and still correct: an empty derivative has `plaintext_bytes = 0` and `size_bytes = 64` (the header alone). No **upper** bound is added to either column, per `f2` `TUNABLE_LIMITS_IN_SCHEMA`. |
| `storage.original_filename` | `documents.original_filename TEXT NOT NULL`, NFC-normalised at ingest, C0/C1 + bidi/zero-width stripped, combining runs capped at 8, length-capped by `f2` `FILENAME_MAX_CHARS` **and** by `OCR_STORAGE_FILENAME_MAX_BYTES = 1080`; empty ⇒ literal `untitled`. Emitted only as RFC 6266 `filename*=UTF-8''<pct-encoded>` with a **server-derived** ASCII fallback `document-<first 8 of docPub>.<ext>`. | `OCR_STORAGE_FILENAME_MAX_BYTES` | The client filename is the one genuinely client-controlled string the product must display back, so it needs a place where being arbitrary is harmless — a column. Thai-specific: `๐–๙` (U+0E50–U+0E59) are not `[0-9]` and ASCII-oriented sanitisers delete rather than transliterate them, merging distinct filenames; HTTP header values are ISO-8859-1 by RFC 9110, so a raw Thai filename in `Content-Disposition` mojibakes or becomes a splitting primitive. 1080 = 9 bytes per Thai grapheme cluster × the frozen character cap. | Structurally unreachable from a key (§8.3). Boot assertion 7 fails if the byte cap ever falls below 9 × the character cap, so raising the character cap cannot silently start truncating mid-grapheme. |
| `storage.lease_credential_scope` | Four resource statements per lease: `org/{O}/original/{sh}/{docPub}` (exact key, `GetObject` only) plus `org/{O}/{render\|preview\|payload}/{sh}/{docPub}/*` (`GetObject`+`PutObject`). Mint accepts `{jobId, leaseToken}` and nothing else; TTL = remaining lease + `OCR_STORAGE_LEASE_CREDENTIAL_TTL_GRACE_S`. | `OCR_STORAGE_LEASE_CREDENTIAL_MODE`, `OCR_STORAGE_LEASE_CREDENTIAL_TTL_GRACE_S` | Closes the panel's `h` L25 accepted risk ("a compromised worker can enumerate every organisation's document identifiers and storage keys platform-wide") rather than restating it. Expressible **only because** of C1-1 (the `ORIGINAL` key is deterministic and known before the read — under content addressing it is not), C1-2 (a stable `public_id` prefix) and C1-7 (the prefix stays valid for the lease). No port, message or job payload carries an object key as a raw `string`. | Acceptance test R22: a lease for job A requesting a credential for job B's document gets `403`; the credential held returns `403` for any key outside the four resources, **including another document in the same organisation**. `MODE=none` is a boot refusal outside local+development. |
| `storage.dedup_mode` | `hint` — fingerprint is a non-unique index on `documents`, surfaced as "you uploaded this before"; **never** a shared blob or a shared row | `OCR_STORAGE_DEDUP_MODE` | A shared blob is unshreddable under `gate-2`'s per-document DEK (§3.1). See the challenge in §14.1. | Any other value ⇒ boot refusal. |
| `storage.transport_constraint` | Any upload transport must deliver **plaintext to a process holding the document DEK**. | — | A presigned direct-to-store upload writes unencrypted bytes to the store, putting the most sensitive object outside the crypto-shredding boundary. The transport *decision* is the API dimension's; this is the constraint it must satisfy. | A design review gate, not a runtime check. |
| `docstatus.enum` | `enum DocumentStatus { UPLOADED VALIDATING QUARANTINED QUEUED EXTRACTING_NATIVE OCR_PROCESSING NORMALIZING AI_ANALYZING READY_FOR_REVIEW COMPLETED FAILED CANCELLED }` — 12 members | — | One list. `g` §4.1's 11 plus `CANCELLED`; `l`'s 7-member wire vocabulary and `j`'s third naming scheme are deleted. `PENDING_UPLOAD` is deleted — a `documents` row exists only once bytes are accepted. | Adding a member without classifying it in `PHASE` is a `tsc` error. |
| `docstatus.wire_form` | the enum member **lowercased** (`ready_for_review`); no mapping table exists | — | A mapping table between two vocabularies is where drift lives — it is what produced this contradiction. | An unknown wire value is a 422 from the Zod schema. |
| `docstatus.phase` | derived total function → `intake \| processing \| review \| done \| stopped`; never stored | — | Answers `l`'s legitimate concern (do not couple the public API to internal pipeline stages) without a second vocabulary. Recomputed per response, so it cannot disagree with `status`. | `Record<DocumentStatus, Phase>` makes an unclassified member a compile error. |
| `docstatus.terminality` | `QUARANTINED` absolutely terminal (zero outgoing edges); `COMPLETED` reopenable by an org admin; `FAILED` and `CANCELLED` re-enter only at `QUEUED` | — | `g` §4.1's argument adopted: folding `QUARANTINED` into `FAILED` means "retry all failed" re-feeds malware to the parser. `QUEUED` as the single re-entry point keeps the reachability graph exhaustively testable. | An illegal transition raises `DOCUMENT_TRANSITION_ILLEGAL` in the use case and is asserted by a table-driven test over all 12 × 12 pairs. |
| `docstatus.download_gate` | `scan_verdict = 'CLEAN' AND status <> 'QUARANTINED' AND deleted_at IS NULL` | — | Replaces `j` §4.1's `DOWNLOADABLE_STATES`, which contained `VALIDATING` (contradicting `j`'s own Hole 2) and omitted `FAILED` (a user must be able to retrieve their own file). Monotonic and on a column, so adding a status cannot silently widen it. | Anything else ⇒ 404 per `f1` `api.not_found_rule`; no signed URL is minted. |
| `storage.grammar_source_of_truth` | `config/storage-keys.yaml` generating `@innovera/ocr-storage-keys` (TS) + `innovera_ocr_storage_keys` (Python) + the SQL shape `CHECK` + `contracts/storage-key-vectors.json` (400 accept + 200 reject vectors) | — | Mirrors `f2` `LIMITS_SOURCE_OF_TRUTH`. Three hand-written copies of one grammar is how M0 produced four. | Startup assertion 1 (lock hash) and the CI regeneration diff both fail closed. |
| `storage.parser_closure` | `parseObjectKey`'s final statement is `mintObjectKey(parsed) === raw` | — | Makes "accepted by the parser" and "producible by the minter" the same set, by construction. Catches a shard that does not match its own id, a zero page number, a leading-zero DPI, a `-t00`, and a valid-shaped key filed under the wrong namespace literal. | Throws `StorageKeyError('invalid-key')` before any adapter or filesystem call. |
| `storage.local_path_containment` | After joining a key to a root, both sides are `realpath`-resolved and the result must equal the root or start with `root + os.sep` | — | `os.path.join` / `pathlib` return an absolute `key` verbatim, and a symlink planted inside the root can redirect a write. A bare `startswith` also matches `/data/ocr-files/objects-evil` against `/data/ocr-files/objects`. This is defence in depth behind the alphabet check, so that a future loosening of one regex is not a filesystem escape. | `StorageKeyError('resolved path escapes the storage root')`; the write never occurs. |
| `docstatus.scanning_reconciliation` | `f2` F2-D3's `SCANNING` is a **job** state owned by `h`. Its document-level projection is `VALIDATING`; the detail lives on `documents.scan_verdict`. `DocumentStatus` gains no member for it, and the projection is one-way. | — | `f2` freezes no document-status enum and itself attributes `SCANNING` to `h`'s job state machine. A status plus a verdict column carries strictly more than a status alone, with no second vocabulary — which is the whole point of `docstatus.enum`. Recorded so a reader who greps `f2` for `SCANNING` finds the reconciliation rather than assuming a contradiction. | Alert `SEC_AV_UNAVAILABLE` (HIGH) at `OCR_STORAGE_AV_ERROR_ALERT_COUNT=20` `ERROR` verdicts within `OCR_STORAGE_AV_ERROR_ALERT_WINDOW_S=300`, because a clamd outage otherwise blocks every download silently. |

---

## Reviewer Notes

**Review pass:** adversarial review + in-place revision, 2026-09-09. Status raised
`canonical` → `canonical-reviewed`. The document was extended, not shortened.

### A. Frozen-value drift — the highest-priority check

Every number and name owned by `f1`, `f2`, `f3`, `gate-2` and `c3` was grepped against its owning
document. **No frozen value was found misquoted, renamed, rounded or contradicted.** Three findings,
all about *discipline* rather than *correctness*:

1. **Restatement without deviation.** The first draft restated frozen literals inline
   (`MAX_EXPORT_ROWS = 50000`, `MAX_OCR_PAGES_PER_DOCUMENT = 50`, `PROVISIONAL_PER_PAGE_OCR_S = 25`,
   `MAX_PAGES_PER_DOCUMENT = 500`, `RENDER_DPI_DEFAULT = 300`, `MAX_UPLOAD_BYTES = 209715200`). Each
   was **verified correct** against `f2`, but restating is the mechanism by which M0 drifted. All are
   now either cited by key alone, or — where an arithmetic derivation genuinely needs the number —
   marked "(value owned by `f2`, quoted for the arithmetic)". A `citation_discipline` clause was added
   to the front matter.
2. **A genuine cross-document restatement, removed.** §11.3 restated `g` §4.2's native-coverage
   threshold and Thai sanity gate as this document's own. Those are `c3-ocr-routing-policy.md`'s
   territory under `OCR_ROUTE_*`, and several of `c3`'s values are **PROVISIONAL** pending its M2
   sweep — so the first draft had pinned superseded, pre-arbitration numbers into a canonical
   document. Removed; `c3` is now cited and no routing or text-quality threshold appears here.
3. **No variant env-var names were invented.** All new variables use the `OCR_STORAGE_*` prefix with
   mandatory unit suffixes (`_BYTES`, `_S`, `_DAYS`), matching `f2` `LIMITS_SOURCE_OF_TRUTH`'s rule
   and never `_MB`.

### B. Defects found and fixed — correctness and security

| # | Severity | Finding | Fix |
|---|---|---|---|
| B1 | **Critical** | **No tile discriminator in `PAGE_RENDER`.** `c3` `OCR_ROUTE_TILING_DPI_FLOOR` and `f2` `MAX_TILES_PER_PAGE` make a tiled page emit up to 12 bitmaps for one page number; all 12 minted the same key, `putImmutable` reported cache hits, and 11/12 of the evidence was silently discarded — on exactly the corpus (A0 plans, Thai land titles) that a smoke test misses. By C1-7 this is unmigratable after launch. | C1-13 / §4.8: optional `-t{tile:02d}`, with `ENGINE_PAYLOAD` deliberately excluded because `f1` `uniq.ocr_result` is per page. |
| B2 | **Critical** | **Fail-open bucket-transition trigger.** §7.2 compared against `current_setting('app.bucket_primary', true)`, which returns NULL when unset, so `TRUE AND NOT (NULL AND …)` → NULL, the `IF` never fired, and **every** transition including `QUARANTINE → PRIMARY` was permitted. `f1` `db.guc.setter` also makes GUCs transaction-local, so a "startup-asserted" GUC is absent during any later `UPDATE`. | C1-14 / §4.6 + §7.2: `bucket_role` enum compared against literals; no GUC. Negative test runs on a connection with no GUCs set. |
| B3 | **Critical** | **GCM nonce reuse.** A 4-byte random per-object nonce prefix, with ~4,000 objects under one per-document DEK, collides at ≈1.9e-3 — about 1 document in 540 — and GCM nonce reuse leaks `P1 XOR P2` and the GHASH subkey. 8 bytes of counter were spent on a value never exceeding 200 frames. | C1-15 / §10.1: per-object key by HKDF from the DEK with a 16-byte salt; deterministic nonce; `objectKey` bound into `info` so objects cannot be swapped between keys. |
| B4 | **High** | **Internal UUIDv7 in the envelope header.** `keyId = document_keys.id` put the upload millisecond in plaintext at the head of every ciphertext — on the exact surfaces C1-2/§3.2 removes it from. | §10.1: `keyRef` = first 16 bytes of the entity's `public_id`, base32-decoded. Requires a `gate-2` column; raised in §14.4. |
| B5 | **High** | **False claim hiding an evidence-integrity defect.** §5.5 asserted the database rejects a second row when two engine versions slug identically. It does not — `f1` `uniq.ocr_result` is over the real columns, so two distinct versions are two legal rows that mint one payload key, and the second row's `payload_ref` points at the first's payload. | §5.5: registry-sourced slugs, boot-asserted registry uniqueness, corrected regex (no trailing hyphen, min length 2), and a digest comparison on `created:false`. |
| B6 | **High** | **`putImmutable`'s `ORIGINAL` rule fired on ordinary retries.** The key is a pure function of an immutable `public_id`, so a two-phase upload retry re-mints it — and raised a CRITICAL. The derivative rule was wrong the other way, swallowing B1 and B5. | §7.1.1: a decision table over (kind × live-row-present), keyed on `plaintext_sha256` rather than on assumption. |
| B7 | **High** | **`f1`'s tenant `LIKE` check does not contain a tenant.** Verified this session: AWS states keys containing `../` **are valid**, and that tools normalise them inconsistently. `org/A/../B/original/…` satisfies `LIKE 'org/A/%'` and resolves into B. On the local driver it escapes the storage root. | §8.2.1 (new): the per-segment traversal check is named as the enforcement of `f1`'s frozen constraint; the `!~` clause is added to `ocr_results.payload_ref` and `extraction_jobs.result_ref`; property test (f) added; `realpath` containment added to both runtimes. |
| B8 | **High** | **Unbounded tenant-influenced key cardinality.** §5.2 class C proves a tenant cannot change a segment's alphabet or length; it says nothing about how many distinct recipes a tenant can mint. Each is a full page-render set, amplifying storage by a four-figure multiple against the victim's own quota. | C1-17 / §5.6: `MAX_RECIPES_PER_DOCUMENT = 4`, LRU eviction of unreferenced sets, derivatives explicitly counted against the quota, metric and alert. |
| B9 | **Medium** | **Preview and render shared one hash.** A downscaler or WebP-quality change produced different pixels at an unchanged key served with `Cache-Control: immutable` — and `putImmutable` would report a cache hit, so the new bytes were never written. Thai tone marks occupy ~3 px at preview widths, so this is the change that decides legibility. | C1-16 / §5.4.1: `previewHash` over `renderRecipe ⊕ previewProfile`, with a distinct TypeScript brand. |
| B10 | **Medium** | **Erasure did I/O inside a transaction.** §4.5 said erasure "hard-deletes the export objects" in the same transaction as the DEK destruction. A network delete cannot participate in a transaction; a crash between commit and delete leaves data readable with no row to find it by. | §4.5: destroy `export_keys` transactionally; byte deletion is a separate idempotent sweeper with a bounded interval. |
| B11 | **Medium** | **`exports` did not exist.** `g` has no `Export` model; the `EXPORT` namespace referenced `exports.public_id` with nothing behind it. | §13.4: the minimum entity, with the ownership boundary stated. |
| B12 | **Medium** | **Truncation was undetected.** Each frame authenticates individually, so dropping trailing frames yields a shorter, valid plaintext — a truncated Thai contract that extracts confidently. | §10.1: total decrypted length must equal `plaintext_bytes`. |
| B13 | **Medium** | **`ORPHAN_MIN_AGE_S = 3600` was asserted, not derived** — a bare number with a qualitative justification, which is the pattern this milestone exists to remove. | §7.3: `2 × f2.JOB_PROCESSING_BUDGET_MS/1000`, asserted as an *inequality* at boot so a future `f2` change refuses to start rather than silently enabling the GC to delete live bytes. |
| B14 | **Low** | Arithmetic errors in §9.1: `EXPORT` 90 (→88), `PAGE_RENDER` 122 (→127), `ENGINE_PAYLOAD` 151 (→145), longest segment 52 (→54). `/original/`, `/preview/` and `/payload/` were counted as 8 characters. | §9.1: recomputed with the derivation shown, and C1-11 updated. |
| B15 | **Low** | **GCS category error.** The 512-byte hierarchical-namespace limit was read as per-path-component and compared against our longest component. It is per **folder segment** (the whole prefix) and per **base name**. | §9.1: corrected, with folder-prefix and base-name figures computed separately. |
| B16 | **Low** | `OCR_STORAGE_ENVELOPE_FRAME_BYTES` was described as requiring an `envelope_version` bump to change. `frameSize` is a header field, so readers take it from the object. | §10.1: applies to newly written objects only; no version bump. |
| B17 | **Low** | Missing per-segment trailing-`.`/`-` rejection, and a parser regex (`[0-9a-f-]{36}`) looser than the grammar. | §8.2: both added, in both runtimes, with the Azure and AWS-console evidence quoted. |
| B18 | **Low** | `assertSafeKeyPrefix` allowed 1–4 segments while `documentPrefix` produces five. | §8.2: raised to 1–5. |

### C. Missing eight-part decision shapes, added

C1-7 (§7.0), C1-8 (§8.5), C1-9 (§8.6), C1-11 (§9.1.1), C1-12 (§12), the `EXPORT` design (§4.5), the
envelope (§10.1), the download gate (§11.4), plus the new C1-13/14/15/16/17/18/19. Every decision in
this document now carries competing proposals, selected, rejected, reason, and implementation,
migration, security and config/env consequences.

### D. Vagueness sweep

No `TBD` appears anywhere in the file. No qualitative gate of the "if enough text" / "if confidence is
low" form survives: the review found none in the first draft and introduced none. Every new threshold
ships with a number, a default, an env var, a permitted range, a rationale and a failure behaviour —
`MAX_RECIPES_PER_DOCUMENT`, `OCR_STORAGE_FILENAME_MAX_BYTES`, `OCR_STORAGE_AV_ERROR_ALERT_*`,
`OCR_STORAGE_EXPORT_SWEEP_INTERVAL_S`, `OCR_STORAGE_LEASE_CREDENTIAL_TTL_GRACE_S`, and the frame-size
range. §16 now tabulates range and failure behaviour for every variable.

### E. Fact-checking

Every load-bearing external claim was re-fetched from vendor documentation this session and is logged
in §17. Three rows the first draft marked UNVERIFIED (Cloudflare R2, Azure Blob, S3 prefix throughput
cited second-hand via `i`) are now first-hand; two new AWS facts were found that materially strengthen
the document (the relative-path-element validity rule behind B7, and the console's trailing-period
stripping behind B17); one first-draft claim was corrected (B15). `file-type@22.0.2`, MIT,
`engines.node >= 22` was confirmed on the npm registry. SeaweedFS remains unverified and is now
explicitly **measurement-deferred with a reason**, not silently unverified.

### F. Fabrication check

The document asserts **no** fact about the LiteLLM gateway, its base URL, its model list, its version,
or any model's vision capability. Its only AI-adjacent content is a citation of `f3`'s frozen
placement decisions and the §14.3 challenge to `f3`'s spool path shape. Nothing was presented as known
that this session cannot know.

### G. Panel findings in this area — status

| Panel finding | Status |
|---|---|
| Object-key grammar specified three (in fact four) incompatible ways | **Fixed** — §1, §4. |
| `payload_ref` / `result_ref` are raw keys to which neither the composite FK nor RLS applies | **Fixed further than `f1` did** — `f1` froze the `LIKE` prefix CHECK; §8.2.1 shows that check alone does not contain a tenant, and adds the traversal constraint to both columns. |
| `h` L25: a compromised worker can enumerate every organisation's storage keys; L26 proposes a per-lease credential; R22 asks for the negative test | **Fixed** — §9.4 / C1-18, with the four-statement scope and R22 restated. Previously an accepted residual risk in every document. |
| `d`:911 `OcrRequest.source.storageKey: string` is a raw dereferenceable path | **Fixed** — §9.4: no port, message or job payload carries an object key as a raw string. |
| The fingerprint unique index wedges the render pipeline on blank pages | **Fixed by `f1`** (`kind='ORIGINAL'` partial) and challenged further in §14.1. |
| Three sibling documents disagree with `g` about the status enum | **Fixed** — §11, plus §11.3.1 for `f2`'s `SCANNING`. |

### H. What remains owner-blocked or arbitration-blocked

| Tag | What | Shipping default |
|---|---|---|
| **B-C1-1** | In-country object-storage requirement (§15) | `OCR_STORAGE_DRIVER=local` on the in-country host |
| **B-C1-2** | Infected-file retention (§15) | 7 days in the quarantine role |
| **B-C1-3** | Export retention (§15) | 7 days |
| **§14.1** | `f1` `uniq.storage_original_fingerprint` must become non-unique — **HIGH**, blocks migration 0015 | Implemented non-unique; the frozen alternative ships a documented PDPA defect |
| **§14.2** | `f1` `partial_index.policy` count 7 → 8 — LOW | 8 |
| **§14.3** | `f3` `ai.spool.key` should use `docPub`, not the internal UUID — LOW | `f3`'s value unless arbitrated |
| **§14.4** | `gate-2` needs `document_keys.key_ref` and an `export_keys` class — **MEDIUM**, blocks migrations 0014/0017 and the §10.1 envelope | Implemented as proposed; a random 16-byte `key_ref` is an acceptable substitute, a UUID is not |
| **§9.1** | SeaweedFS path limits — measurement-deferred, not owner-blocked | Not an M1 backend; verify before adoption |

The `B-n` namespace collision noted in §15 stands: this document uses `B-C1-n` and recommends the
orchestrator adopt document-scoped prefixes retroactively across M0.5.
