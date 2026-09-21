---
dimension: gate-2
title: Gateway Data Retention and Thai PDPA — Persistence Inventory, Owner Inspection Protocol, and the Architectural Defence
status: canonical
date: 2026-09-09
supersedes:
  - docs/architecture/m0/j-security-threat-model.md §9.4 (AI gateway data-flow questions)
  - docs/architecture/m0/j-security-threat-model.md §9.6 (PDPA verified-vs-legal-review)
  - docs/architecture/m0/j-security-threat-model.md §9.5 (erasure mechanism only; retention *periods* remain owned by the storage/data-model dimension)
  - docs/architecture/m0/k-ai-integration-and-intelligence.md (all statements about gateway-side logging and prompt persistence)
  - docs/architecture/m0/b-ai-topology-discovery.md (all statements about what the gateway retains)
  - docs/architecture/m0/i-storage.md §5.3 "PDPA override" paragraph (erasure *mechanism*; TTL values stay with storage)
owns:
  - the LiteLLM persistence-mechanism inventory
  - the owner read-only inspection protocol for Gate 2
  - the AI-stage fail-closed switch and its env vars
  - the pre-prompt minimisation/pseudonymisation contract
  - the crypto-shredding erasure mechanism and its resolution of the erasure-vs-audit tension
  - the data-residency guard on the gateway boundary
does_not_own:
  - retention periods for documents, renders, OCR text, exports (storage/data-model dimension)
  - the audit-log schema itself (data-model dimension) — this document constrains one column of it
  - OCR engine selection, routing, confidence (see the respective canonical documents)
---

# Gate 2 — Gateway Data Retention / PDPA

> **Integration status (2026-09-12):** Read the [architecture index](../README.md) and its consolidation report before using these examples. Individual review labels do not close cross-document conflicts; no application implementation is verified.

## 0. Scope, method, and the one-sentence answer

**One-sentence answer:** For INNOVERA's specific gateway the honest verdict is
**PROMPT BODY PERSISTENCE: UNKNOWN**, and this document is written so that the verdict
**does not matter** — the architecture is designed so that even a maximally-leaky gateway
receives no recoverable Thai personal data, and the fail-closed switch means the AI stage
cannot run at all until the owner answers in writing.

**Method.** The gateway is unreachable from this session (it runs on a remote production GPU
host; see the environment ground truth in the M0.5 brief). Everything below about *LiteLLM
the software* was verified this session against primary sources: the published documentation
at `docs.litellm.ai`, the `BerriAI/litellm` public repository at `main` (Prisma schema and
Python source, fetched 2026-09-09), and the project's own issue tracker. Everything about
*INNOVERA's deployment* is marked `UNKNOWN` or `UNVERIFIED:` and is routed to the owner
inspection protocol in §4.

**What is deliberately not asserted.** This document never states a fact about INNOVERA's
gateway as known. It states facts about LiteLLM's code and defaults, and it states what the
owner must look at. `UNVERIFIED:` the running gateway's LiteLLM version is unknown, and
several behaviours below are version-dependent; §4.1 makes version capture the first
inspection step for exactly that reason.

**Legal status.** §6 is an engineering summary written so that Thai counsel can be briefed
efficiently. It is **not legal advice** and every conclusion in it is marked
`LEGAL-REVIEW-REQUIRED:`. Two of its outputs are schema constraints, which is why it is a
Gate, not an M5 task.

---

## 1. Threat statement

The owner's binding requirement, restated once so the rest of the document can cite it:

> **R-G2:** *"Default design must not create an uncontrolled second copy of document content
> in the AI gateway."*

The threat is not "the gateway is malicious". The threat is that a LiteLLM proxy is, by
design, an *observability* product as much as a routing product, and its whole value
proposition to an operator is that it can tell you what was sent and what came back. Several
of its retention paths are **on by default**, several are **enabled by a single boolean an
operator sets for a good reason** (cost forensics, prompt debugging), and — the finding that
matters most — **two of them are controllable by the client on a per-request basis**, which
cuts both ways: it is a trap if an attacker or a careless caller sets them, and it is our
single most useful lever because we are the client.

A Thai national ID card processed through this product yields, in one prompt: a 13-digit
national identification number, a full name in Thai and Latin script, a date of birth, a home
address, a religion (PDPA §26 sensitive), and — if pixels were ever sent — a facial
photograph (PDPA §26 sensitive as biometric data). A single unredacted spend-log row is
therefore a §26 disclosure, not a debugging convenience.

---

## 2. Persistence mechanism inventory (LiteLLM)

Every mechanism by which a LiteLLM proxy can retain prompt or response bodies. Each row:
what it is, its default, the exact config key, where the data lands, how to disable it.

### 2.1 Summary table

| # | Mechanism | Default | Exact config key | Where data lands | Disable |
|---|---|---|---|---|---|
| M1 | Spend-log prompt/response storage | **OFF** | `general_settings.store_prompts_in_spend_logs: false` (also readable under `litellm_settings`) | Postgres `LiteLLM_SpendLogs.messages`, `.response`, `.proxy_server_request` | leave `false` |
| M2 | Spend-log row itself (metadata, no bodies) | **ON** | `general_settings.disable_spend_logs: false` | Postgres `LiteLLM_SpendLogs` (incl. `requester_ip_address`, `end_user`, `metadata`) | `disable_spend_logs: true` |
| M3 | Error-log row | **ON** | `general_settings.disable_error_logs: false` | Postgres `LiteLLM_ErrorLogs.request_kwargs`, `.exception_string` | `disable_error_logs: true` |
| M4 | Callback / logging integrations | **OFF until configured** | `litellm_settings.success_callback`, `.failure_callback`, `.callbacks` | off-box: Langfuse, Langsmith, S3, GCS, Azure Blob, Datadog, OTEL, Arize, Sentry, SQS, DynamoDB, Lunary, MLflow, Galileo, Athina, OpenMeter, custom | remove from the lists |
| M5 | Global message redaction toggle (mitigation, not a leak) | **OFF** (i.e. messages *are* sent to callbacks) | `litellm_settings.turn_off_message_logging: false` | n/a | set `true` — **but see §2.3** |
| M6 | Client-controlled redaction override — header | n/a | request header `LiteLLM-Disable-Message-Redaction: true` | re-enables full bodies on all of M4 and M1 | see §2.3 / D-G2-6 |
| M7 | Client-controlled redaction override — body field | n/a | request body top-level `turn_off_message_logging: false` | same as M6 | see §2.3 / D-G2-6 |
| M8 | Proxy stdout / container logs | **level-dependent; handler defaults to DEBUG when `LITELLM_LOG` is unset** | env `LITELLM_LOG`, `JSON_LOGS` | container stdout → Docker `json-file` driver → host disk `/var/lib/docker/containers/**/*-json.log` | `LITELLM_LOG=ERROR` + a `logging` driver with rotation |
| M9 | Response caching | **OFF** | `litellm_settings.cache: false`, `.cache_params` | Redis / in-memory / disk / S3 / GCS / Qdrant / Valkey | leave `false`; if on, see §2.7 |
| M10 | Semantic caching (embeds the whole `messages` array) | **OFF** | `cache_params.type: qdrant-semantic` \| `redis-semantic` \| `valkey-semantic` | a vector DB, as embeddings + payload | leave `false` |
| M11 | Guardrail / moderation hooks | **OFF** | `guardrails:` block; Presidio, Bedrock Guardrails, Lakera, etc. | third-party guardrail service | leave empty, or use only in-process guardrails |
| M12 | Managed files (uploads) | **OFF** (only if the Files API is used) | `LiteLLM_ManagedFileTable.storage_url` | object storage named by `storage_backend` | do not use `/v1/files` |
| M13 | Prompt-management registry | **OFF** | `LiteLLM_PromptTable` | Postgres | do not use `prompt_id` |
| M14 | Workflow / agent transcript tables | **OFF** | `LiteLLM_WorkflowMessage.content`, `LiteLLM_MemoryTable.value` | Postgres | do not use workflows/agents/memory |
| M15 | Config audit log | `store_audit_logs` gated | `LiteLLM_AuditLog.before_value`, `.updated_values` | Postgres | holds *config rows*, not prompts — low risk, retain |

### 2.2 M1 — the spend-log path, precisely

`LiteLLM_SpendLogs` is written for every request when `disable_spend_logs` is false (default).
Verified against `schema.prisma` at `main`, the body-bearing columns are:

```prisma
model LiteLLM_SpendLogs {
  request_id           String @id
  ...
  metadata             Json?     @default("{}")
  cache_key            String?   @default("")
  requester_ip_address String?
  messages             Json?     @default("{}")
  response             Json?     @default("{}")
  proxy_server_request Json?     @default("{}")
  ...
}
```

Three body-bearing columns — `messages`, `response`, `proxy_server_request` — plus `metadata`
and `requester_ip_address` (an IP address is personal data under PDPA even with no body).

All three body columns are gated on `_should_store_prompts_and_responses_in_spend_logs()`,
which reads `store_prompts_in_spend_logs` (documented default **False**). A non-obvious detail
verified in `litellm/proxy/spend_tracking/spend_tracking_utils.py`: `_get_messages_for_spend_logs_payload`
only populates the `messages` column when `call_type == "_arealtime"`. For ordinary
`/chat/completions` traffic the `messages` column stays `"{}"` and **`proxy_server_request` is
the column that actually carries the prompt**. Anyone auditing this by looking only at
`messages` will conclude, wrongly, that nothing is stored.

### 2.3 M5/M6/M7 — **the trap**, verified in source

The brief asked for precise verification of the documented behaviour where a request field can
retain unredacted messages even when message logging is disabled. Confirmed, and it is worse
than "a request field": there are **two independent client-controlled overrides**, and one of
them is checked before every other rule.

From `litellm/litellm_core_utils/redact_messages.py` at `main` (fetched 2026-09-09), verbatim:

```python
def should_redact_message_logging(model_call_details: dict) -> bool:
    """
    Priority order:
    1. Dynamic parameter (turn_off_message_logging in request)
    2. Headers (litellm-disable-message-redaction / litellm-enable-message-redaction)
    3. Global setting (litellm.turn_off_message_logging)
    """
    ...
    if request_headers and bool(request_headers.get("litellm-disable-message-redaction", False)):
        # User explicitly disabled redaction via header
        return False
    ...
    dynamic_turn_off: Final = _get_turn_off_message_logging_from_dynamic_params(model_call_details)
    if dynamic_turn_off is not None:
        # Dynamic parameter is explicitly set, use it
        return dynamic_turn_off
    ...
    return litellm.turn_off_message_logging is True
```

**M6 — header override.** `LiteLLM-Disable-Message-Redaction: true` on the request returns
`False` unconditionally, *before* the dynamic parameter and *before* the global config. Any
caller holding a valid virtual key can re-enable full body logging for their own requests,
across every configured callback and across `proxy_server_request`, no matter what the
operator put in `config.yaml`.

**M7 — body-field override.** `turn_off_message_logging` is a *supported request parameter*.
Verified in `litellm/litellm_core_utils/initialize_dynamic_callback_params.py`: it appears in
`_supported_callback_params` and is **absent** from `_request_blocked_callback_params`, so a
top-level request-body field flows into `standard_callback_dynamic_params` and wins at
Priority 1 over the global setting. `turn_off_message_logging: false` in a request body
therefore defeats `turn_off_message_logging: true` in `config.yaml`.

**Consequence for us.** `turn_off_message_logging: true` in the gateway's `config.yaml` is
**not a boundary control**. It is a default that any client can override. Two corollaries:

1. *Defensively:* we cannot rely on the operator's config to protect us from another tenant's
   misconfigured client, nor can we cite it to counsel as a technical guarantee.
2. *Offensively — and this is the useful half:* **we are the client**, so we can assert the
   safe value on every single request regardless of what the operator has configured. That is
   decision **D-G2-6**, and it is the only Gate-2 control that works with zero owner action.

### 2.4 M1 — the open `proxy_server_request` bug

`BerriAI/litellm` **issue #16336**, *"turn_off_message_logging Does Not Redact Request Messages
in proxy_server_request Field When Stored to Database"*, reported **2025-11-06** against
**`1.79.0-stable`**, **open** at time of writing, with a referenced fix PR **#18897**. The
reporter had `turn_off_message_logging: true` *and* `store_prompts_in_spend_logs: true` and
still got unredacted request messages persisted.

The `main`-branch source now *does* call `should_redact_message_logging` inside
`_get_proxy_server_request_for_spend_logs_payload`, so the fix appears merged to `main`.
**`UNVERIFIED:` whether the running gateway is on a version that contains it.** This single
fact is why §4.1 makes version capture inspection step one, and why D-G2-6 does not depend on
the fix being present.

Related open defects worth naming in the inspection brief: **#9507** (`turn_off_message_logging`
sometimes not redacting output), **#15173** (`no-log` flag does not completely prevent Langfuse
trace creation), **#10788** (proxy INFO request logging cannot be switched off).

### 2.5 M3 — the exception path

```prisma
model LiteLLM_ErrorLogs {
  request_id       String @id @default(uuid())
  ...
  request_kwargs   Json   @default("{}")
  exception_type   String @default("")
  exception_string String @default("")
  status_code      String @default("")
}
```

`request_kwargs` is the request kwargs dict; `exception_string` is the provider's error text,
which routinely echoes the offending payload. `litellm/proxy/spend_tracking/spend_tracking_utils.py`
carries an explicit constant `_ERROR_MESSAGE_PROMPT_LEAK_KEYS = ("input", "messages", "prompt")`
and a redaction path gated on the same `store_prompts_in_spend_logs` flag — i.e. upstream
*knows* error strings leak prompts and treats it as the same gate. Defaults: `disable_error_logs`
is **False**, so the table is written. `UNVERIFIED:` whether `request_kwargs` contains the full
`messages` array in the deployed version; §4.2 makes this a column-name-only check.

For third-party error trackers there is a separate global,
`litellm.redact_messages_in_exception_logs` (documented recommendation: set `True` in
production), which sanitises messages before they reach Sentry-style integrations. It does not
protect the Postgres `LiteLLM_ErrorLogs` row.

### 2.6 M8 — the proxy's own stdout, the path nobody audits

Verified in `litellm/_logging.py` at `main`:

```python
json_logs: Final = _parse_json_logs_env(os.getenv("JSON_LOGS"))
log_level: Final = os.getenv("LITELLM_LOG", "DEBUG")
numeric_level: Final[str] = getattr(logging, log_level.upper())
handler: Final = LevelRoutingStreamHandler()
handler.setLevel(numeric_level)
```

**The stream handler's level defaults to `DEBUG` when `LITELLM_LOG` is unset.** And the
truncation filter deliberately exempts DEBUG, with this comment in the source:

```python
    """...
    DEBUG records pass through untouched, since dumping full payloads is the point of
    `--detailed_debug`, and logging callbacks (OTEL, Datadog, etc.) don't run through
    logging filters at all, so they still get the untruncated error.
    """
```

`UNVERIFIED:` whether DEBUG records are actually *emitted* depends on the effective level of
the `"LiteLLM Proxy"` / `"LiteLLM"` loggers, which are obtained with `logging.getLogger(...)`
and receive an explicit `setLevel(DEBUG)` only inside the debug-enabling helper. The honest
statement is: **the handler admits DEBUG by default, so any code path or dependency that emits
at DEBUG writes untruncated payloads to stdout, and the operator has to have set `LITELLM_LOG`
explicitly to be sure it does not.** Under Docker's default `json-file` driver those lines are
written to host disk, are readable by anyone in the `docker` group, are not covered by any
Postgres retention job, and survive `docker compose down` unless the container is removed.

This is the retention path most likely to be missed by an inspection that only looks at
`config.yaml` and the database.

### 2.7 M9/M10 — a cache is a copy

Supported cache backends per the caching documentation: *"In Memory Cache, Disk Cache, Redis
Cache, Qdrant Semantic Cache, Redis Semantic Cache, Valkey Semantic Cache, S3 Bucket Cache,
GCS Bucket Cache."* The cached value is the **LLM response body**; the cache key is derived
from the request. For the semantic variants, *"the entire `messages` array (including system
prompts) gets embedded"* — i.e. the prompt itself is written into a vector store, where
"deleting" it is a materially harder engineering problem than deleting a Postgres row.

Config keys under `litellm_settings.cache_params`: `type`, `ttl`, `namespace`,
`supported_call_types`, `default_in_memory_ttl`, `default_in_redis_ttl`. There is also a
per-request `"cache": {"ttl": 300}` body parameter. `LiteLLM_SpendLogs.cache_key` persists the
cache key even when the cache itself is elsewhere.

Note the interaction with erasure: a Redis or S3 cache entry has **no foreign key to a
document** and no tenant scoping we control. It cannot be selectively erased in response to a
PDPA §33 request. That makes M9/M10 an *architectural* prohibition for us, not a tuning
preference — see D-G2-7.

### 2.8 M11 — guardrails ship content off-box by definition

A guardrail that classifies content must see the content. LiteLLM's PII-masking guardrails
integrate **Microsoft Presidio** (self-hostable) and **AWS Bedrock Guardrails** (a third-party
cloud service, and for us a cross-border transfer under PDPA §28/§29). The spend-tracking
source additionally stores `guardrail_request` / `guardrail_response` / `match_details` under
the *same* `store_prompts_in_spend_logs` gate — i.e. guardrail payloads are a fourth prompt
carrier in the spend log, alongside `messages`, `response`, and `proxy_server_request`. Tables
`LiteLLM_GuardrailsTable`, `LiteLLM_SpendLogGuardrailIndex`, `LiteLLM_DailyGuardrailMetrics`.

**We do not use gateway-side guardrails for PII.** We do the redaction ourselves, before the
prompt leaves our process (D-G2-4). A cloud guardrail that reads a Thai ID card to tell us it
contains a Thai ID card has already committed the disclosure we were trying to prevent.

### 2.9 Postgres table census — which tables can hold message bodies

From `schema.prisma` at `main`, the tables that can contain document content or direct
personal data:

| Table | Column(s) | Can hold document content? |
|---|---|---|
| `LiteLLM_SpendLogs` | `proxy_server_request`, `messages`, `response`, `metadata` | **Yes** (gated on `store_prompts_in_spend_logs`) |
| `LiteLLM_SpendLogs` | `requester_ip_address`, `end_user`, `user` | Personal data, **not** gated |
| `LiteLLM_ErrorLogs` | `request_kwargs`, `exception_string` | **Yes**, on exceptions |
| `LiteLLM_WorkflowMessage` | `content` | Yes, if workflows are used |
| `LiteLLM_MemoryTable` | `value` | Yes, if agent memory is used |
| `LiteLLM_ManagedFileTable` | `file_object`, `storage_url` | Pointer to uploaded bytes |
| `LiteLLM_PromptTable` | prompt templates | System prompts, not user content |
| `LiteLLM_AuditLog` | `before_value`, `updated_values` | **No** — config rows only |
| `LiteLLM_Daily*Spend` (7 tables) | aggregates | **No** |
| `LiteLLM_VerificationToken` | hashed keys | **No** |

### 2.10 Gateway-side retention *periods*

LiteLLM ships an automatic spend-log purge with these `general_settings` keys and documented
defaults:

| Key | Default |
|---|---|
| `maximum_spend_logs_retention_period` | `30d` |
| `maximum_spend_logs_retention_interval` | `1d` |
| `maximum_spend_logs_cleanup_batch_size` | `1000` |
| `maximum_spend_logs_cleanup_max_batches` | `500` |
| `maximum_spend_logs_cleanup_batch_timeout` | `30s` |
| `maximum_spend_logs_cleanup_cron` | unset |

Three cautions for the owner. (a) `UNVERIFIED:` whether this purge is active by default or only
when the keys are set — treat as unproven until §4 confirms rows older than 30 days are absent.
(b) It purges `LiteLLM_SpendLogs` only; it does **not** touch `LiteLLM_ErrorLogs`, caches, or
container logs. (c) A 30-day rolling purge is **not** an erasure mechanism: PDPA §33 requires
erasure *on request*, not eventually, and the 2024 PDPC notification requires copies and
backups to be covered.

---

## 3. The owner's answer, in the required shape

**For INNOVERA's gateway, as of 2026-09-09, from this session:**

```
PROMPT BODY PERSISTENCE:    UNKNOWN
RESPONSE BODY PERSISTENCE:  UNKNOWN
RETENTION LOCATION:         UNKNOWN
RETENTION PERIOD:           UNKNOWN
DELETE/ERASURE PATH AVAILABLE: UNKNOWN
```

`OWNER-BLOCKED (B-1)`. The gateway is a separate deployment on a remote production GPU host,
absent from every readable repository, with no config, image, or database reachable from this
workstation. Any other answer would be fabricated.

**What the answer would look like for a stock LiteLLM proxy with no operator changes**, given
solely as the calibration baseline the owner should compare their config against — this is
*not* a claim about INNOVERA's gateway:

```
PROMPT BODY PERSISTENCE:    NO   (store_prompts_in_spend_logs defaults to false)
                                  ...but YES on exceptions via LiteLLM_ErrorLogs (default on),
                                  and potentially YES via container stdout (M8).
RESPONSE BODY PERSISTENCE:  NO   (same gate)     ...same two exceptions.
RETENTION LOCATION:         LiteLLM Postgres DB, same host; plus Docker json-file logs on host disk.
RETENTION PERIOD:           30d for LiteLLM_SpendLogs if the purge is active; UNBOUNDED for
                            LiteLLM_ErrorLogs and for container logs without a rotation policy.
DELETE/ERASURE PATH AVAILABLE: PARTIAL — rows are deletable by SQL, but there is no
                            per-document, per-tenant, or per-data-subject erasure API, because
                            the gateway has no concept of "a document".
```

That last line is the structurally important one and it does not depend on the owner's answer:
**the gateway cannot participate in a PDPA §33 erasure workflow, because it does not know what
a document is.** Its unit of record is a request. Our unit of erasure is a document, which is
1..N requests, with no stable join key unless we put one there — and putting an INNOVERA
`documentId` into gateway metadata makes the gateway's retention problem *worse*, not better,
by making its rows re-identifiable. This is decided in D-G2-8.

---

## 4. Owner inspection protocol — read-only, and never SELECT a body column

Rules for whoever runs this on the GPU host:

- Everything below is **read-only**. No `UPDATE`, no `DELETE`, no restart, no config edit.
  Gate 2 is an *answer*, not a change; changes come after the answer, under D-G2-1.
- **Never `SELECT` a body column.** Do not run `SELECT proxy_server_request FROM ...`,
  `SELECT messages ...`, `SELECT response ...`, `SELECT request_kwargs ...`, or
  `SELECT exception_string ...`. Reading a leaked ID card to confirm it leaked is a second
  disclosure and it lands in shell history and in the psql session log. Column existence,
  row counts, and JSON *lengths* answer the question completely.
- Capture output to a file the owner controls, not to a chat window or an issue tracker.

### 4.1 Step 1 — version (do this first; several answers are version-dependent)

```bash
docker ps --format '{{.Names}}\t{{.Image}}' | grep -i litellm
docker inspect --format '{{.Config.Image}}' <litellm_container>
docker exec <litellm_container> litellm --version
docker exec <litellm_container> python -c "import litellm; print(litellm.__version__)"
```

Record the exact tag. If it is at or below `1.79.0-stable`, assume issue **#16336** is present
and that `turn_off_message_logging` does **not** protect `proxy_server_request`.

### 4.2 Step 2 — config.yaml, exact keys to read

```bash
docker exec <litellm_container> sh -c 'cat /app/config.yaml' 2>/dev/null \
  || docker inspect --format '{{json .Mounts}}' <litellm_container>
```

Report the value of each of these, or `ABSENT`:

| Block | Key |
|---|---|
| `general_settings` | `store_prompts_in_spend_logs` |
| `general_settings` | `disable_spend_logs` |
| `general_settings` | `disable_error_logs` |
| `general_settings` | `disable_spend_updates` |
| `general_settings` | `maximum_spend_logs_retention_period` |
| `general_settings` | `maximum_spend_logs_retention_interval` |
| `general_settings` | `store_audit_logs` |
| `general_settings` | `allowed_routes` |
| `litellm_settings` | `turn_off_message_logging` |
| `litellm_settings` | `redact_messages_in_exception_logs` |
| `litellm_settings` | `redact_user_api_key_info` |
| `litellm_settings` | `success_callback` (full list) |
| `litellm_settings` | `failure_callback` (full list) |
| `litellm_settings` | `callbacks` (full list) |
| `litellm_settings` | `service_callbacks` |
| `litellm_settings` | `cache` |
| `litellm_settings` | `cache_params` (whole block: `type`, `ttl`, `namespace`, `supported_call_types`) |
| `litellm_settings` | `json_logs` |
| top level | `guardrails` (whole block) |
| top level | `model_list` — **the authorised alias list**, which also answers Gate 1's model question and the residency question in §6.5 |

### 4.3 Step 3 — environment variables (names and presence, not values)

```bash
docker exec <litellm_container> printenv | cut -d= -f1 | sort
```

Flag the presence of any of: `LITELLM_LOG`, `JSON_LOGS`, `DETAILED_DEBUG`, `LANGFUSE_*`,
`LANGSMITH_*`, `DD_*` (Datadog), `OTEL_*`, `AWS_*` / `GCS_*` / `AZURE_STORAGE_*` (bucket
logging), `SENTRY_DSN`, `REDIS_*`, `ARIZE_*`, `LUNARY_*`, `POSTHOG_*`, `BRAINTRUST_*`,
`SLACK_WEBHOOK_URL`, `PRESIDIO_*`, `LAKERA_*`. **Do not print values.**
If `LITELLM_LOG` is absent, record that as a finding (§2.6).

### 4.4 Step 4 — the callbacks actually loaded at runtime

Config is not truth; runtime is. If the admin UI is reachable, read
`GET /config/callbacks` / the Logging & Alerts page. Otherwise:

```bash
docker logs <litellm_container> --since 24h 2>&1 | grep -iE 'callback|langfuse|otel|datadog|s3|gcs' | head -50
```

### 4.5 Step 5 — container logs: size and whether any payload is present

```bash
# how much log exists at all
docker inspect --format '{{.LogPath}}' <litellm_container> | xargs -I{} sudo ls -lh {}
docker inspect --format '{{json .HostConfig.LogConfig}}' <litellm_container>

# presence-only test: does any line look like a chat payload? Print COUNT, not lines.
docker logs <litellm_container> --since 168h 2>&1 \
  | grep -cE '"(messages|content)"[[:space:]]*:'
```

A non-zero count from that last command means prompt bodies are on host disk, and it is the
single fastest disproof of "the gateway does not persist bodies". If `HostConfig.LogConfig`
shows no `max-size`/`max-file`, retention is **unbounded**.

### 4.6 Step 6 — the LiteLLM Postgres DB, structure and counts only

Connect read-only. Never select a body column.

```sql
-- (a) which body-bearing tables exist
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('LiteLLM_SpendLogs','LiteLLM_ErrorLogs','LiteLLM_AuditLog',
                     'LiteLLM_WorkflowMessage','LiteLLM_MemoryTable','LiteLLM_ManagedFileTable')
ORDER BY table_name;

-- (b) column names only, for the two that matter
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('LiteLLM_SpendLogs','LiteLLM_ErrorLogs')
ORDER BY table_name, ordinal_position;

-- (c) volume and age (no bodies)
SELECT count(*) AS rows,
       min("startTime") AS oldest,
       max("startTime") AS newest
FROM "LiteLLM_SpendLogs";

SELECT count(*) AS error_rows,
       min("startTime") AS oldest,
       max("startTime") AS newest
FROM "LiteLLM_ErrorLogs";

-- (d) THE DECISIVE TEST: are bodies present? Length only, never the value.
--     length('{}') = 2, so anything above ~2 is a stored body.
SELECT count(*) FILTER (WHERE length(proxy_server_request::text) > 2) AS rows_with_request_body,
       count(*) FILTER (WHERE length(messages::text)             > 2) AS rows_with_messages,
       count(*) FILTER (WHERE length(response::text)             > 2) AS rows_with_response,
       max(length(proxy_server_request::text))                       AS max_request_body_bytes
FROM "LiteLLM_SpendLogs";

SELECT count(*) FILTER (WHERE length(request_kwargs::text) > 2) AS err_rows_with_kwargs,
       max(length(exception_string))                            AS max_exception_len
FROM "LiteLLM_ErrorLogs";

-- (e) is the retention purge actually running?
SELECT count(*) AS rows_older_than_30d
FROM "LiteLLM_SpendLogs"
WHERE "startTime" < now() - interval '30 days';

-- (f) does the DB publish a host port? (run in shell, not SQL)
--     docker inspect --format '{{json .NetworkSettings.Ports}}' <litellm_db_container>
```

Query (d) is the whole gate in one statement. `rows_with_request_body = 0` across a
representative window is the strongest available evidence that prompts are not persisted, and
it is obtained without a single byte of document content being read.

### 4.7 Step 7 — the OCR virtual key's own settings

Once a dedicated OCR key exists (D-G2-2), read it back:

```
GET /key/info?key=<hashed_or_alias>
```

and record `metadata.logging`, `models`, `max_budget`, `tpm_limit`, `rpm_limit`,
`allowed_routes`, `blocked`. Confirm `metadata.logging` is either absent (inherits config) or
explicitly empty (no callbacks).

### 4.8 What "answered in writing" means for D-G2-1

Gate 2 is answered when the owner produces a short attestation file containing: the LiteLLM
version from §4.1; the five-line block from §3 filled in with real values; the query-(d)
counts from §4.6; the `LITELLM_LOG` finding from §4.3; the callback list from §4.4; and a
date and signature. Its SHA-256 becomes `OCR_AI_GATEWAY_RETENTION_ATTESTATION` (D-G2-1).

---

## 5. The architectural defence

Nine decisions. Each carries the owner's eight-part shape: competing proposals → selected →
rejected → reason → implementation consequence → migration consequence → security consequence →
config/env consequence.

The defence has one organising idea. **We cannot control the gateway's retention. We can
control what reaches it.** Every decision below either reduces what reaches the gateway, or
makes what does reach it non-re-identifying, or prevents anything reaching it at all until the
owner has answered. Only D-G2-6 depends on gateway behaviour, and it is deliberately the
*least* load-bearing of the nine.

---

### D-G2-1 — Fail-closed AI stage

**Competing proposals.**
(a) Ship the AI stage enabled, disable it if Gate 2 comes back bad.
(b) Ship it enabled but behind a per-tenant opt-in.
(c) Ship it **disabled**, with a boot-time refusal to start if someone enables it without a
recorded Gate-2 attestation.
(d) Do not build the AI stage until Gate 2 is answered.

**Selected: (c).**

**Rejected and why.** (a) inverts the burden — an uninspected gateway is an unbounded
disclosure, and "we'll turn it off later" has never once survived a launch deadline. (b) makes
a tenant responsible for a fact only INNOVERA can know; a customer cannot consent to a
retention behaviour nobody has measured. (d) wastes the milestone: the interfaces, the
minimisation pipeline, and the tests are all buildable and testable against a local stub, and
deferring them is exactly how "architect for the ceiling now" fails.

**Reason.** A boolean default is a policy statement that survives staff turnover. A boot-time
refusal is the only form of "disabled" that cannot be silently undone by an env-var edit in a
hurry at 23:00.

**Implementation consequence.** A single `assertAiStageBootable()` in the composition root,
called **before** the HTTP listener binds. Rules, all numeric or exact-match:

| Condition | Behaviour |
|---|---|
| `OCR_AI_STAGE_ENABLED` unset or `false` | boot normally; AI stage absent from the DI container; any call to it throws `E_AI_STAGE_DISABLED` |
| `OCR_AI_STAGE_ENABLED=true` **and** `OCR_AI_GATEWAY_RETENTION_ATTESTATION` absent, empty, or not matching `^\d{4}-\d{2}-\d{2}\|[0-9a-f]{64}$` | **exit code 78** (`EX_CONFIG`), stderr `E_GATE2_UNANSWERED`, listener never binds |
| `OCR_AI_STAGE_ENABLED=true`, attestation well-formed, date older than **365 days** | boot, but log `W_GATE2_ATTESTATION_STALE` at WARN on every boot and surface it on the admin health page |
| any value of `OCR_AI_STAGE_ENABLED` | `/healthz` and `/readyz` are **unaffected** |

That last row mirrors the verified INNOVERA Chat convention: LiteLLM is not part of readiness.
The gateway must never be able to take our liveness down, and the AI stage being off must
never read as an outage.

**Migration consequence.** None — this is a greenfield default. The migration is *social*:
flipping it to `true` later requires producing the attestation file, which is the point.
Reverting to `false` is a one-line env change with no schema impact, because D-G2-3 guarantees
every AI output is an *enrichment* of a document that is already complete without it.

**Security consequence.** Removes the largest uncontrolled egress in the product by default.
Residual risk: someone forges an attestation hash to get past boot. Accepted — the control is
against forgetting, not against a malicious operator, and an operator with env access already
has the database.

**Config/env consequence.** `OCR_AI_STAGE_ENABLED` (default `false`),
`OCR_AI_GATEWAY_RETENTION_ATTESTATION` (default empty). Both in §9.

---

### D-G2-2 — A dedicated OCR virtual key, never the master key, never Chat's key

**Competing proposals.**
(a) Reuse the existing Chat virtual key.
(b) Use the LiteLLM master key so we are not blocked on key issuance.
(c) A dedicated OCR virtual key, model-scoped, budget-scoped, rate-limited, with its own
logging metadata.

**Selected: (c).**

**Rejected and why.** (a) destroys attribution — a spend-log row could not be attributed to
OCR versus Chat, which breaks both the PDPA record-of-processing and any future "which system
sent this?" incident question; it also means revoking OCR's access takes Chat down. (b) is
disqualified outright: the verified Chat convention already uses a **virtual key**, not the
master key ("LiteLLM **virtual key**", `DEPLOYMENT.md`), so INNOVERA's own house standard is
least-privilege and we do not get to be the exception. A master key can also mint keys and
read every other tenant's spend log.

**Reason.** Attribution, revocability, blast-radius, and house-convention alignment, in that
order.

**Implementation consequence.** Owner issues one key via `POST /key/generate` with:
`models: [<the authorised OCR aliases>]`, `metadata.logging: []` (explicitly no callbacks —
see the per-key logging contract in §2.1/M4 and the team-logging documentation), a `max_budget`,
`rpm_limit`, `tpm_limit`, and `allowed_routes` restricted to the completion route we actually
use. The app reads it from `LITELLM_API_KEY` — **the same env name Chat uses**, because
adopting the house convention verbatim is cheaper than a variant name and variant names are
how M0 drifted.

**Migration consequence.** Rotation is a single env change plus a restart; no schema, no data.
If the key is later scoped to a different model list, D-G2-9's allowlist check must be updated
in the same change — enforced by a startup assertion that every alias in
`OCR_AI_MODEL_ALLOWLIST` is a non-empty string, and by a runtime `403` on any other alias.

**Security consequence.** A leaked OCR key can spend an OCR budget against an OCR model list
and nothing else. It cannot read spend logs, cannot mint keys, cannot reach Chat's models.

**Config/env consequence.** `LITELLM_BASE_URL`, `LITELLM_API_KEY` — both names taken verbatim
from the verified INNOVERA Chat contract; see §9. `OCR_AI_MODEL_ALLOWLIST`.
`OWNER-BLOCKED (B-2)`: the literal base-URL value and the authorised alias list are unknown
from this session.

---

### D-G2-3 — Text-only boundary: no pixels ever cross to the gateway

**Competing proposals.**
(a) Send page images to a vision model for end-to-end document understanding.
(b) Send images only when OCR confidence is poor.
(c) Send **text and geometry only**, never image bytes, unconditionally.

**Selected: (c).**

**Rejected and why.** (a) is the largest possible PDPA disclosure: a page image of a Thai
national ID card contains a **facial photograph**, which is biometric data and therefore §26
sensitive, plus the religion field, also §26. One gateway log row would then hold a sensitive
personal data record in the most directly usable form that exists. (b) is worse than (a)
because it is *conditional*, which means the disclosure happens on exactly the documents that
are hardest to reason about, at an unpredictable rate, and it is precisely the vague
"if confidence is low" phrasing the owner banned. It also creates a nightmarish RoPA entry:
"we sometimes transfer facial images, depending on OCR quality."

**Reason.** Three independent reasons, any one of which is sufficient. (i) `UNVERIFIED:` the
deployed model is believed text-only — INNOVERA Chat's own source states *"the deployed model
is text-only … No OCR, no vision, and no image bytes ever leave the server for the LLM"* —
so (a) probably does not even work. (ii) Even if a vision alias existed, sending pixels
converts a category-1 disclosure into a category-26 disclosure. (iii) A fixed rule is
auditable; a conditional rule is not.

**Implementation consequence.** The port type makes the violation unrepresentable rather than
merely forbidden:

```ts
// domain layer — no framework imports, per the house layering rule
export type AiPromptPayload = {
  readonly kind: 'text-only';
  readonly systemPrompt: string;
  readonly userText: string;              // already minimised per D-G2-4
  readonly layoutHints: readonly LayoutHint[];  // boxes + reading order, no pixels
};
```

There is no `image` variant, no `Buffer`, no `base64`, no `dataUrl` field anywhere in the
type. A dependency-cruiser rule forbids `infrastructure/ai/**` from importing the image or
render modules at all, so the bytes are not merely unsent — they are unreachable from that
layer. This is machine-enforced, matching the house standard.

**Migration consequence.** If a vision capability is ever authorised, it is a **new port,
a new decision record, a new Gate, and a new RoPA entry** — not a new field on this type.
Structurally forcing that is the point.

**Security consequence.** Eliminates biometric-data egress entirely. Also removes the
prompt-injection-via-image class and caps per-request payload size by construction.

**Config/env consequence.** None. A rule with an env override is not a rule.

---

### D-G2-4 — Pre-prompt minimisation: pseudonymise before the boundary, not after

**Competing proposals.**
(a) Send the OCR text as-is; rely on the gateway's `turn_off_message_logging`.
(b) Send as-is; rely on a gateway-side PII guardrail (Presidio / Bedrock).
(c) Pseudonymise deterministically **in our process**, before the HTTP call, and re-substitute
on the response.

**Selected: (c).**

**Rejected and why.** (a) rests entirely on a setting §2.3 proves is client-overridable and
therefore not a boundary control. (b) is self-defeating: the guardrail must receive the ID card
to classify it, so the disclosure occurs before the protection does — and for Bedrock
Guardrails it is a cross-border transfer as well.

**Reason.** The only defence that survives an arbitrarily bad Gate-2 answer is one where the
bad thing was never sent. If the gateway logs every byte forever, and the bytes contain
`«TH_NID_1»` instead of thirteen digits, the log is not a national-ID disclosure.

**Implementation consequence.** A pure function in the domain layer,
`minimisePrompt(text): { text, map }`, applied to every payload. Rules, all deterministic and
numeric, ordered by longest-match-first with no overlapping replacements:

| Rule | Pattern | Threshold | Action | Placeholder |
|---|---|---|---|---|
| R1 | Thai national ID / tax ID: exactly **13** digits, optional `-` or space separators after digit 1, 5, 10, 12 | any 13-digit run, **checksum-independent** | replace | `«TH_NID_n»` |
| R2 | Thai passport: `^[A-Z]{1,2}[0-9]{7}$` on a token of length **8–9** | exact | replace | `«TH_PASSPORT_n»` |
| R3 | Thai phone: `(?:\+66|0)[0-9]{8,9}` | 9–12 chars | replace | `«TH_PHONE_n»` |
| R4 | Bank account: a run of **10–15** digits within **40** characters of any token in the bank-keyword list (ธนาคาร, เลขที่บัญชี, บัญชี, account, A/C, IBAN) | both conditions | replace | `«BANK_ACCT_n»` |
| R5 | Religion field (**PDPA §26**): the value following a `ศาสนา` / `Religion` label, up to **32** characters or the next line break, whichever is shorter | exact label match | **drop entirely**, no placeholder | — |
| R6 | Email: RFC-5322-lite `[^\s@]+@[^\s@]+\.[A-Za-z]{2,}` | — | replace | `«EMAIL_n»` |
| R7 | Base64/hex runs ≥ **512** characters | length | truncate to 64 chars + `…[TRUNCATED]` | — |

**R1 is deliberately checksum-independent.** The Thai NID mod-11 check digit would cut false
positives to roughly 9% of raw 13-digit matches, but OCR digit substitution breaks the checksum
on precisely the documents we most need to protect. Failing safe costs us a placeholder on an
occasional invoice number; failing open costs us a §26 disclosure. The checksum is still
computed and stored — it is a *quality* signal for the deterministic extractor, not a
*redaction* gate.

**R5 drops rather than replaces** because a placeholder named `«RELIGION_1»` is itself a
disclosure that a religion field was present, which for a §26 category is a meaningful signal.

The `map` (placeholder → original) is held **in the request scope only**, used to re-substitute
the model's response, and then discarded. It is **never** persisted, never logged, and never
sent. If any part of the pipeline needs the original values later, it reads them from the
document record, which is encrypted under the document's DEK (D-G2-5).

**The critical scoping rule that makes this cheap:** the AI stage is **not** the extractor of
identifiers. Thai NIDs, tax IDs, phone numbers, and dates are extracted **deterministically**
by regex + checksum + layout, in our own process, at higher precision than a language model
would achieve on Thai digits. The AI stage exists for layout reconstruction, table structure,
semantic field mapping, and business-rule validation — **none of which need the digits**.
Any proposed AI task that genuinely requires an unredacted identifier is **refused at design
review** and reimplemented deterministically. So R1–R6 cost us nothing in capability. If a
future task truly needs them, that is a new Gate, not a config flag.

**Migration consequence.** `minimisePrompt` is versioned (`MINIMISER_VERSION`, starts at `1`)
and the version is recorded on every AI result row. Changing a rule bumps the version; results
produced under an older version remain interpretable and re-runnable. Rules are additive-only
in a minor bump; removing or loosening a rule is a major bump and requires a decision record.

**Security consequence.** Reduces the gateway's copy from "a Thai identity document" to "an
anonymised layout fragment". Residual risk, stated plainly: **free text is not fully
anonymisable.** A Thai personal name, a street address, or an unusual company name can survive
R1–R7 and remain identifying. This is why D-G2-4 is *necessary and insufficient*, and why it
is paired with D-G2-1 (default off), D-G2-6 (assert suppression), and D-G2-8 (no join key).

**Config/env consequence.** `OCR_AI_MINIMISATION_MODE` ∈ {`strict`, `maximal`}, default
**`strict`** (R1–R7). `maximal` adds Thai person-name pseudonymisation via a local NER pass and
is **not** shipped in M1; the env value is validated against the enum at boot and an unknown
value is a boot refusal, not a silent fallback.

---

### D-G2-5 — Context cap, in characters, checked before the call

**Competing proposals.**
(a) Send the whole document; the model has a 65,536-token ceiling.
(b) Cap by tokens using a client-side tokenizer.
(c) Cap by **characters**, per request, checked before the HTTP call, with a hard refusal.

**Selected: (c), at 12,000 characters of `userText` per request.**

**Rejected and why.** (a) makes every leaked log row maximally large, maximises prefill cost
and latency, and puts us at the mercy of the ceiling — the verified Chat contract shows
INNOVERA already rejected this reasoning, budgeting 20,000 characters against a 65,536-token
ceiling *deliberately*, to bound prefill cost, latency, and KV-cache pressure. (b) requires
shipping and version-pinning a tokenizer that must match the server's, which is
`UNVERIFIED:` and unverifiable from here; a mismatch produces either silent truncation or
runtime 400s.

**Reason (why 12,000 and not Chat's 20,000).** Three reasons, and the number is derived, not
picked. (i) Our unit of work is one page region, not a conversation — 12,000 Thai characters
comfortably exceeds a dense A4 page of Thai text. (ii) Thai tokenises poorly under BPE;
`UNVERIFIED:` at an assumed 1.5–2.0 characters per token, 12,000 characters is ~6,000–8,000
tokens, leaving the response and system prompt far inside any plausible per-request budget.
(iii) We sit *below* the house precedent rather than at it, because Chat's payload is
user-authored conversation and ours is extracted identity-document text — a strictly more
sensitive payload deserves a strictly smaller blast radius per log row. Larger documents are
**chunked**, not truncated: chunking preserves the product requirement; truncation silently
destroys output.

**Implementation consequence.** `AiPromptPayload.userText.length > 12000` throws
`E_AI_PROMPT_TOO_LARGE` before any network call. Enforced in the application layer (use-case),
not the transport layer, so it cannot be bypassed by a different caller. A unit test asserts
the throw at 12,001.

**Migration consequence.** A single exported constant. Raising it is a one-line change plus a
decision record; it does not touch the schema. The chunker's overlap (**200** characters) is a
separate constant so the two can move independently.

**Security consequence.** Bounds the per-row disclosure in any gateway log to 12,000
already-minimised characters. Also bounds cost-amplification if the OCR key ever leaks.

**Config/env consequence.** `OCR_AI_MAX_PROMPT_CHARS`, default `12000`, validated as an integer
in `[1000, 20000]` at boot; out-of-range is a boot refusal. The upper bound is Chat's budget:
we may tighten below the house precedent, never exceed it without a decision record.

---

### D-G2-6 — Assert log suppression on **every** request, from the client side

**Competing proposals.**
(a) Ask the owner to set `turn_off_message_logging: true` in `config.yaml` and trust it.
(b) Send `no-log: true` in the request body.
(c) Assert suppression **from the client, on every request**, using all available channels
simultaneously, and treat it as best-effort defence-in-depth rather than a control.

**Selected: (c).**

**Rejected and why.** (a) is refuted by §2.3 — a config default is client-overridable and
therefore not a boundary control; it also blocks us on owner action for a lever we can pull
ourselves. (b) alone is unreliable: `no-log` has an open defect (**#15173**) where Langfuse
traces are still created, and it is not honoured uniformly across callbacks.

**Reason.** §2.3 established that the client wins the precedence contest. That is a trap when
someone else is the client and a **gift when we are**. This is the one Gate-2 control that
requires zero owner action and works against a gateway we have never inspected.

**Implementation consequence.** Every outbound request carries, unconditionally:

*Headers*
```
x-litellm-enable-message-redaction: true
litellm-enable-message-redaction: true      # legacy name, kept for older gateway versions
x-litellm-disable-callbacks: langfuse,langsmith,s3,gcs_bucket,datadog,otel,arize,braintrust,posthog,lunary
```
*Body (top-level, alongside `model` and `messages`)*
```json
{ "turn_off_message_logging": true, "no-log": true }
```

Both header spellings are sent because the source shows the new `x-`-prefixed name was added
alongside the old one for backwards compatibility, and the gateway's version is
`UNVERIFIED:`. Sending both is free.

Three hard rules, each a lint-enforced constant:
1. The header `LiteLLM-Disable-Message-Redaction` is **never** sent. Its presence in our
   codebase is a CI failure (a literal grep in the pre-commit hook), because it is the exact
   string that turns the protection off.
2. `turn_off_message_logging` is **never** sent as `false`.
3. These fields are set by the single HTTP adapter in `infrastructure/ai/`, not by callers,
   and the adapter is the only module permitted to construct the request object.

**Migration consequence.** If a future LiteLLM version renames or removes these, requests still
succeed (unknown body fields and headers are ignored) — the control degrades silently, which is
precisely why it is ranked as defence-in-depth and why the fail-closed switch (D-G2-1) and
minimisation (D-G2-4) carry the real weight. A quarterly re-read of the LiteLLM redaction
source is added to the maintenance checklist.

**Security consequence.** Suppresses callback-side body logging and, on versions carrying the
fix for **#16336**, the `proxy_server_request` column too. It does **not** suppress: the
`LiteLLM_ErrorLogs` row on an exception; container stdout (M8); or a cache write. Those are
owner-side (§4) and D-G2-7.

**Config/env consequence.** None — hardcoded. A control that can be switched off by
configuration is not a control.

---

### D-G2-7 — Prohibit gateway-side caching for OCR traffic

**Competing proposals.**
(a) Allow caching; identical pages are common and it saves money.
(b) Allow caching with a short TTL.
(c) Prohibit caching for OCR traffic; cache **on our side**, keyed by content hash, inside our
own erasure boundary.

**Selected: (c).**

**Rejected and why.** (a) and (b) both create a copy of the response — and, for the semantic
variants, of the **prompt embedded into a vector store** (§2.7) — in a store with no tenant
scoping we control, no document foreign key, and no participation in our erasure workflow. A
short TTL does not fix this: PDPA §33 erasure is *on request*, not *eventually*, and the 2024
PDPC notification explicitly extends to copies and backups. A cache entry that outlives an
erasure request by even one hour is a non-compliance we cannot detect, let alone prove.

**Reason.** A cache we cannot erase from is a retention system, and every retention system must
sit inside the crypto-shredding boundary (D-G2-5/D-G2-8) or not exist.

**Implementation consequence.** Send `"cache": {"no-cache": true}` on every request (the
per-request cache control documented under `cache_params`). Independently, our own result cache
lives in our Postgres, keyed by `sha256(minimisedPromptText || modelAlias || promptVersion)`,
with the cached value **encrypted under the document's DEK** — so shredding the DEK shreds the
cache entry with everything else, automatically, with no extra deletion path to forget.

**Migration consequence.** If the owner's inspection (§4.2) shows `cache: true` is already set
globally, the per-request opt-out is our mitigation and the finding is recorded in the RoPA;
this decision does not require the owner to change their global config.

**Security consequence.** Removes an unerasable copy. Cost consequence is *positive*: a
content-hash cache on our side hits more often than a gateway cache, because it survives prompt
re-ordering and is scoped to our document identity rather than to an exact byte string.

**Config/env consequence.** `OCR_AI_RESULT_CACHE_TTL_DAYS`, default `30`, integer in `[0, 365]`;
`0` disables our cache. Bounded by the document's own retention, which this document does not
own — see the storage dimension.

---

### D-G2-8 — Crypto-shredding: the resolution of the erasure-versus-audit tension

This is the decision the brief asked to be picked and specified rather than surveyed.

**The tension, stated precisely.** Two commitments already made elsewhere fight a PDPA §33
deletion request: an **append-only AuditLog**, and an **immutable-raw-evidence** rule. Both
exist for good reasons (accountability; the ability to prove what the system saw). Both mean
"just delete the row" is unavailable. And backups make it worse: the PDPC Notification on
Criteria for Deletion, Destruction or Anonymisation B.E. 2567 (2024) — gazetted 13 August 2024,
effective **11 November 2024** — requires the controller to delete, destroy, or anonymise the
data **"including their copies and backups"**, **within 90 days** of the request, such that
**"no person can, by any reasonably foreseeable means, recover or re-identify the personal
data"**. A 35-day backup window means a row deleted today is recoverable from a backup
tomorrow. Deleting from backups is not practically possible without restoring and rewriting
every one of them.

**Competing proposals.**
(a) **Tombstoning** — delete the content row, keep an ID row.
(b) **Field-level redaction** — overwrite the body columns with `NULL`, keep the audit row.
(c) **Crypto-shredding** — encrypt all content under a per-document data key; erasure destroys
the key.
(d) Shorten backup retention until erasure is "fast enough".

**Selected: (c), with a per-document DEK, plus a per-document audit-digest key that is shredded
with it.**

**Rejected and why.** (a) and (b) both fail on backups: the pre-deletion row still exists in
every backup taken before the request, so the data is recoverable by reasonably foreseeable
means (restore the backup) for the whole backup window, and the 2024 notification names copies
and backups explicitly. (d) trades a legal risk for an operational one — a short backup window
is how a ransomware event becomes a company-ending event — and it still leaves a window.

**Reason.** Crypto-shredding is the only technique that reaches data we cannot address:
backups, replicas, and any copy taken before the request. Destroying a 256-bit key renders
every copy of the ciphertext unrecoverable *simultaneously*, everywhere, including in backups
that no longer need to be touched. It maps directly onto the notification's own standard —
recovery by "reasonably foreseeable means" — because recovering AES-256-GCM ciphertext without
its key is not a foreseeable means. `LEGAL-REVIEW-REQUIRED:` that this satisfies §33 in Thai
counsel's view; it is the strongest available technical position, and counsel should be asked
to confirm it rather than asked what to do.

**The design, concretely.**

```
root key (KMS or a file-backed master, ops-controlled, never in the app DB)
  └─ tenant KEK          (one per tenant, wrapped by root)
       └─ document DEK    (one per document, 256-bit, AES-256-GCM, wrapped by tenant KEK)
            ├─ encrypts: OCR text blobs, page renders, extracted field values,
            │            correction history, exports, our AI result cache,
            │            and the minimisation map if ever persisted (it is not)
            └─ document AUDIT-DIGEST key (256-bit, HMAC-SHA-256, derived from the DEK
                                          via HKDF with info="audit-digest/v1")
```

Erasure of document `D` is a single operation: **hard-delete the `document_keys` row for `D`**
(actual `DELETE`, plus an overwrite of the wrapped-DEK bytes before the delete on the primary,
to defeat casual page-level recovery). Everything encrypted under it — live, replicated, and in
every backup — becomes unrecoverable in the same instant. Target latency: **under 60 seconds**
from an authenticated erasure command, against a statutory ceiling of **90 days**. Internal SLA:
**7 days** end-to-end including identity verification of the requester, which leaves 83 days of
margin for the parts we do not control.

**How the audit log survives.** The `AuditLog` row is kept, append-only, and holds only:
`tenantId`, `documentId`, `actorId`, `action`, `timestamp`, `chainHash`, and
`contentDigest`. Crucially:

- `chainHash` links row *N* to row *N−1* over **metadata only** (no content), under a **global,
  never-shredded** key. The tamper-evident chain therefore remains verifiable end-to-end after
  any number of erasures. This is the property that makes the whole scheme work.
- `contentDigest` is `HMAC-SHA-256(auditDigestKey_D, contentBytes)` — keyed by the
  **per-document** digest key, which is derived from the DEK and dies with it. Before erasure
  it proves "this row refers to that exact content". After erasure it is an unverifiable,
  non-invertible 32-byte value.

That second bullet is the part that a plain hash gets wrong, and it is worth stating why. A
*global* content hash would be a re-identification oracle: a 13-digit Thai NID has only 10^13
possible values, which is a trivially small keyspace to grind against a stored digest. Keying
the digest per-document, with a key that is destroyed on erasure, removes the oracle at the
same moment it removes the content. So the audit row survives erasure **and stops being
personal data**, which is exactly what PDPA §33's anonymisation limb asks for.

Rows in `AuditLog` referencing an erased document additionally carry `erasedAt` and
`erasureReceiptId`. The **erasure receipt** (`documentId`, `tenantId`, `requestedAt`,
`completedAt`, `actorId`, `keyDestroyed: true`, `artifactsCovered`) is itself retained — proving
deletion later requires a record that deletion happened, and that record contains no content.

**What crypto-shredding does *not* reach — say it out loud.** It does not reach the gateway.
The gateway holds plaintext, encrypted under nothing we control, in a database we do not
administer, on a host we cannot reach from here. **There is no erasure path into the gateway
that we can build.** That single fact is the entire justification for D-G2-1, D-G2-3, D-G2-4,
D-G2-6 and D-G2-9: since we cannot delete from the gateway, the only remaining strategy is to
never send anything that would need deleting.

**Implementation consequence.** A `document_keys` table (`documentId` PK, `tenantId`,
`wrappedDek bytea`, `keyVersion int`, `createdAt`, `algorithm text`), a `KeyRing` port in the
domain layer with an infrastructure adapter, and an envelope-encrypt/decrypt wrapper on every
content read and write. Every content-bearing column becomes `bytea` ciphertext with a 12-byte
nonce and a 16-byte GCM tag. This is a **schema-shaping constraint**, which is why it is a Gate
decision and not an M5 hardening task — retrofitting it is a full-table migration over the
largest tables in the system.

**Migration consequence.** None if adopted now. If deferred, the migration is: add the table,
generate a DEK per existing document, re-encrypt every blob and every content column, and
rewrite every index built over plaintext. Estimated as the single most expensive migration in
the product. **Adopt now.**

**Security consequence.** Strongly positive: a stolen database backup without the KMS root key
yields nothing. Two new failure modes, both named: (i) **key loss = data loss**, mitigated by
backing up the *root* key separately from the data, with a documented split-custody restore
drill; (ii) an attacker with both the DB and the root key gains everything, which is no worse
than the pre-crypto baseline. The restore drill must include the deletion-replay step: a
restore that resurrects a shredded document's *key* would undo an erasure, so shredded key rows
are recorded in a separate, append-only `shredded_keys` ledger that the restore procedure
replays.

**Config/env consequence.** `OCR_KMS_ROOT_KEY_REF` (a reference, never the key material),
`OCR_ERASURE_SLA_DAYS` default `7` (integer in `[1, 90]`; the upper bound is the statutory
ceiling and a value above it is a boot refusal).

---

### D-G2-9 — No join key to the gateway; residency asserted at the alias boundary

**Competing proposals.**
(a) Send `metadata: { documentId, tenantId }` so gateway spend logs can be correlated with our
documents.
(b) Send a per-request opaque correlation id, retained on our side.
(c) Send **no correlation identifier at all**; correlate on our side by request time and our own
request id, which we do not transmit.

**Selected: (b) — a per-request opaque id, with the mapping held only on our side and shredded
with the document.**

**Rejected and why.** (a) is the mistake that looks like good observability: putting a stable
`documentId` into gateway metadata makes every gateway row **re-identifiable back to a Thai
identity document**, converting a pile of anonymous-ish text into a linked personal data set,
and it does so in a system we established has no erasure path. It would actively undo D-G2-4.
(c) is safest but makes incident forensics ("which of our requests caused that gateway error?")
impossible, and a control that makes incidents uninvestigable will be removed under pressure.

**Reason.** (b) gets forensics without giving the gateway a join key. A random 128-bit
`aiRequestId` means nothing to anyone holding only gateway rows; joined against our
`ai_requests` table — itself inside the crypto-shredding boundary — it means everything to us.
When the document is shredded, the mapping dies, and the gateway's rows become permanently
un-attributable. Erasure thus degrades the gateway's copy too, without our being able to touch it.

**Implementation consequence.** `metadata: { "ai_request_id": "<uuidv4>" }` on the request, and
nothing else. **Never** `documentId`, `tenantId`, `userId`, `filename`, or `end_user`. That last
one matters specifically: LiteLLM has a first-class `end_user` field that populates
`LiteLLM_SpendLogs.end_user` **and** the `LiteLLM_DailyEndUserSpend` aggregate — a table with no
prompt bodies but a persistent per-end-user identity. We do not populate it. A lint rule
forbids those field names in the AI adapter's request builder.

**Residency.** `OWNER-BLOCKED (B-3)`: we cannot verify from this session where the gateway
routes. Two guards, both ours:
1. **Allowlist.** `OCR_AI_MODEL_ALLOWLIST` is an explicit list of aliases. Any other alias is
   refused client-side with `E_AI_MODEL_NOT_ALLOWED` before the call. Empty list ⇒ AI stage
   inert, consistent with D-G2-1.
2. **Response assertion.** The `model` field of every response is compared to the allowlist; a
   mismatch increments a counter, logs `W_AI_MODEL_MISMATCH` at WARN with the alias only, and
   **fails the request**. A gateway silently falling back to a public API (OpenAI, Anthropic,
   Alibaba) would be a **cross-border transfer** under PDPA §28/§29 with no lawful basis, no
   adequacy finding, and no safeguards — a reportable event, and the one gateway behaviour we
   can detect from the outside.

`UNVERIFIED:` the alias `innovera-ai` is evidence, not authorisation, and must not be treated
as confirmed. It is not written into any default.

**Migration consequence.** The allowlist is env, so it moves without a deploy. Adding an alias
requires confirming residency for that alias — recorded in the RoPA, not in a commit message.

**Security consequence.** Removes the strongest re-identification vector into gateway logs, and
converts a silent cross-border transfer into a loud, failing request.

**Config/env consequence.** `OCR_AI_MODEL_ALLOWLIST` (comma-separated, default **empty**).

---

## 6. Thai PDPA — the analysis counsel needs

**This is not legal advice.** Every conclusion below is `LEGAL-REVIEW-REQUIRED:`. It is written
so that a Thai data-protection lawyer can be briefed in one sitting and asked *specific*
questions rather than "please review our system".

### 6.1 Instrument and status

Personal Data Protection Act **B.E. 2562 (2019)**, published in the Royal Gazette **27 May
2019**, fully effective **1 June 2022** after pandemic postponements. GDPR-shaped: lawful basis,
data-subject rights, controller/processor split, security obligations, breach notification,
DPO in defined cases. Enforcement is now routine rather than exemplary — see the enforcement
record already established in `docs/architecture/m0/j-security-threat-model.md §9.6`, which this
document does not restate.

Subordinate instrument that binds D-G2-8 directly: **PDPC Notification on Criteria for
Deletion, Destruction, or Anonymisation of Personal Data B.E. 2567 (2024)**, dated 31 July 2024,
gazetted 13 August 2024, effective **11 November 2024**. Two operative requirements:
**within 90 days** of a data-subject request, covering **copies and backups**; and the outcome
must be such that **no person can by reasonably foreseeable means recover or re-identify** the
data. (The draft's 60-day figure was extended to 90 in the final text.)

### 6.2 Lawful basis — the question to put to counsel

Our position, for confirmation: **INNOVERA OCR AI is a data *processor*** for the documents its
customers upload, and a **controller** only for its own account and billing data. The lawful
basis for processing the *document contents* is therefore the **customer's** to establish, not
ours; ours is a **Data Processing Agreement** and §40 processor obligations (process only on
documented instruction, security, sub-processor control, assist with data-subject rights,
delete or return at end of contract).

Three specific questions for counsel, in priority order:

1. **Does routing document text through an INNOVERA-operated AI gateway remain within
   "processing on the controller's documented instruction", or does it require the customer's
   specific authorisation as a distinct processing operation?** Our engineering answer is that
   it must be *disclosed and authorised specifically*, which is why D-G2-1 defaults to off and
   why the DPA template must name the AI stage as an optional, per-tenant-authorised operation.
2. **§26 and specific consent.** A Thai national ID card carries **religion** and a **facial
   photograph**; medical receipts carry **health data**. All are enumerated §26 sensitive
   categories requiring, in general, **explicit consent**. But the product cannot know before
   processing which category a given upload falls into. Our proposed engineering default —
   **treat every uploaded document as potentially containing §26 data and apply the strictest
   controls uniformly** — is stated here for counsel to confirm or to replace with a
   differentiated rule. Note D-G2-3 (no pixels) and D-G2-4 R5 (drop the religion field) are the
   two concrete §26 controls, and both are cheap precisely because they were designed in.
   A national ID *number* alone is **not** in the §26 list; it is ordinary personal data. The
   *card* usually is sensitive. Same feature, two categories, decided by what the customer
   uploaded.
3. **Is destruction of the encryption key an acceptable means of "erasure or destruction" under
   §33 and the 2024 notification?** This is the single highest-value question in this document,
   because the answer shapes the schema. Our reading is that it satisfies the "no reasonably
   foreseeable means of recovery" standard better than row deletion does, since row deletion
   demonstrably leaves recoverable copies in backups. Counsel should confirm, and should say
   whether an erasure receipt naming key destruction is sufficient evidence.

### 6.3 Controller / processor / the gateway — a correction to M0

`docs/architecture/m0/j-security-threat-model.md §9.6` item 2 states that the DPA must name our
sub-processors, "which includes whoever operates the AI gateway". **That is likely wrong on the
verified facts and this document corrects it.** The gateway is operated by INNOVERA — the same
legal entity that operates the OCR product. A legal person is not its own sub-processor. The
correct characterisation is that the gateway is a **different system within the same
processor's** infrastructure, which means:

- **No inter-company DPA is required** between OCR and the gateway.
- But the **RoPA (§39) entry must name it** as a processing location, with its retention
  behaviour recorded — which is exactly what Gate 2 produces.
- And the customer's DPA must **disclose** that document text may be processed by an internal
  AI service, because the customer authorises processing operations, not just entities.
- If the gateway is *ever* pointed at a third-party API, it becomes a **sub-processor and a
  cross-border transfer** in the same instant, which is what D-G2-9's response assertion is
  designed to catch.

`LEGAL-REVIEW-REQUIRED:` counsel to confirm the same-entity analysis, which depends on the
corporate structure and not on the architecture.

### 6.4 Data-subject rights, and where they actually arrive

Rights reach us via the **customer**, not the data subject, because we are the processor. The
schema must nonetheless support them from M1 — retrofitting erasure is far more expensive than
designing for it:

| Right | Mechanism | Owner |
|---|---|---|
| Access (§30) | per-document export, tenant-scoped | API/export dimension |
| Rectification (§35, §36) | the human-correction flow, which is a product feature anyway | correction dimension |
| **Erasure (§33)** | **crypto-shred the DEK — D-G2-8** | **this document** |
| Portability (§31) | structured export | API/export dimension |
| Objection (§32) | tenant-level processing switches, incl. `OCR_AI_STAGE_ENABLED` per tenant | this document + API dimension |

### 6.5 Cross-border transfer (§28/§29)

Transfers out of Thailand require one of: an **adequacy** designation for the destination (§28
whitelist); a §28 derogation (consent, contractual necessity, legal obligation); or **appropriate
safeguards** under §29 (BCRs, SCCs). Sub-regulations on transborder data flow were issued in
2024 and refined through 2025.

What this forbids, concretely:

1. **No third-party model APIs.** Not OpenAI, not Anthropic, not Alibaba, not Google — via the
   gateway or otherwise — absent a §28/§29 determination. Enforced by D-G2-9's allowlist plus
   response assertion.
2. **No cloud logging sinks.** A `success_callback` to Langfuse Cloud, Langsmith, Datadog, or an
   S3/GCS bucket in a non-Thai region is a transfer **of the prompt body**. §4.2 and §4.3 make
   the callback list and the cloud env vars explicit inspection items for exactly this reason.
3. **No cloud guardrails.** AWS Bedrock Guardrails processes content abroad — D-G2-4 rejects
   gateway-side PII guardrails on this ground as well as on the self-defeating-order ground.
4. **Backups and object storage must be in-country** unless a §28/§29 basis exists. That is
   owned by the storage dimension; this document only records the constraint.

`OWNER-BLOCKED (B-3)`: whether the gateway's upstreams are all in Thailand is unknown from this
session. **Named default if the owner stays silent: `OCR_AI_MODEL_ALLOWLIST` remains empty and
the AI stage never runs.** Silence is not consent.

### 6.6 Breach notification

§37 security duties and the breach-notification obligation run on a defined clock (72 hours to
the PDPC for notifiable breaches, and to data subjects where there is high risk). Two
observations that matter to this Gate specifically:

- **The first PDPC administrative penalty punished governance failures, not technical ones** —
  failure to appoint a DPO and failure to follow breach-notification protocol. Getting the
  paperwork right is cheap and is the most likely thing to be enforced against us.
- **A gateway-side leak may be undetectable by us.** If the gateway retains bodies and its DB is
  compromised, we may learn of it late or never. That asymmetry is a further argument for the
  minimisation-first posture: we should prefer designs where a gateway breach is *not our
  breach* because the gateway held nothing identifying.

---

## 7. Owner-blocked register

`TBD` is forbidden; each item below has a named default that ships if the owner stays silent.

| ID | Question | Blocks | Named default if the owner stays silent | Cost of the default |
|---|---|---|---|---|
| **B-1** | Does the gateway persist prompt/response bodies? (§3, §4) | the Gate-2 verdict; `OCR_AI_GATEWAY_RETENTION_ATTESTATION` | **`OCR_AI_STAGE_ENABLED=false`.** The AI stage never runs; boot refuses if anyone flips it without an attestation. | The semantic/validation tier ships inert. The deterministic pipeline (native extraction, OCR, Thai normalisation, layout, business rules) is unaffected and is the bulk of the product. |
| **B-2** | The literal `LITELLM_BASE_URL` value and the authorised model alias list for an OCR key | D-G2-2, D-G2-9 | **`OCR_AI_MODEL_ALLOWLIST` empty**; adapter refuses every call with `E_AI_MODEL_NOT_ALLOWED`. | Same as B-1. |
| **B-3** | Where does the gateway route? Are all upstreams in Thailand? | §6.5 residency | **No transfer permitted**; allowlist stays empty. | Same as B-1. |
| **B-4** | The gateway's LiteLLM version | whether issue **#16336** applies (§2.4) | **Assume the bug is present**; rely on D-G2-4 minimisation, never on gateway-side redaction. | None — this is the posture we adopt anyway. |
| **B-5** | Thai counsel opinion on §26 uniform-strictness, key-destruction-as-erasure, and the same-entity gateway analysis (§6.2, §6.3) | the DPA template; confirmation of the D-G2-8 schema | **Strictest reading**: every document treated as §26; crypto-shredding shipped; gateway disclosed in the DPA as an internal processing location. | Slightly stricter controls than may be required. Cheap. The reverse error is not. |
| **B-6** | Is `LITELLM_LOG` set on the gateway container, and does the container have log rotation? (§2.6, §4.5) | the completeness of the Gate-2 answer | **Assume unbounded plaintext on host disk**; the minimisation posture already assumes it. | None to us; it is a finding for the gateway operator. |

---

## 8. Challenges to frozen values, and contradictions found in the corpus

Raised per the M0.5 cardinal rule rather than silently deviated from. The orchestrator arbitrates.

1. **`LITELLM_API_KEY` / `LITELLM_BASE_URL` — adopted verbatim, no challenge.** Recording
   explicitly that I considered and rejected an OCR-specific variant name (`OCR_LITELLM_*`).
   Variant names are how M0 drifted, and the verified Chat convention is INNOVERA's real
   standard. Consequence: if OCR and Chat ever run in one process (they will not), the names
   collide. Accepted.

2. **Contradiction between M0 documents on original-file retention.**
   `j-security-threat-model.md §9.5` gives originals **90 days** (per-tenant 7–365);
   `i-storage.md §5.3` gives a **30-day grace** before hard-deleting original bytes. These are
   different numbers for the same artefact. **This document does not own retention periods and
   does not pick one** — it is flagged for the storage/data-model reconciliation. Gate 2 only
   requires that whichever number wins, the *erasure* path bypasses it entirely (both M0 docs
   already agree on that, and D-G2-8 implements it).

3. **Correction to `j-security-threat-model.md §9.6` item 2** — the gateway operator is
   probably **not** a sub-processor, because it is the same legal entity. See §6.3. This changes
   what the DPA must say, so it is a substantive correction rather than a wording nit.

4. **Correction to `j-security-threat-model.md §9.6` item 7** — that section proposes resolving
   the audit-versus-erasure tension by having the audit log hold "identifiers and actions, not
   content". That is necessary but **not sufficient**, and this document supersedes it. A
   *global* content hash in an audit row is a re-identification oracle for low-entropy content
   (a 13-digit Thai NID is a 10^13 keyspace — grindable). D-G2-8 replaces it with a
   **per-document keyed HMAC whose key is shredded with the DEK**, and keeps the tamper-evident
   chain under a separate global key over metadata only. This is a schema constraint and it must
   land before the audit table is created.

5. **`turn_off_message_logging` must not be presented anywhere as a boundary control.** If any
   surviving M0.5 document asserts that the gateway config protects us, it contradicts the
   source quoted in §2.3 and should be corrected to cite this document instead.

6. **The 12,000-character prompt cap (D-G2-5) sits below Chat's verified 20,000.** Flagged in
   case a later document assumes house-wide parity at 20,000. The reasoning is in D-G2-5;
   if the arbitration prefers parity, D-G2-5's rationale (ii) and (iii) are the parts to attack.

---

## 9. CANONICAL VALUES

Every value this document owns. Other documents **cite** these; they must not restate them.

| key | value | env var | reason | failure behaviour |
|---|---|---|---|---|
| `ai.stage.enabled.default` | `false` | `OCR_AI_STAGE_ENABLED` | Gate 2 unanswered (B-1); an uninspected gateway is an unbounded disclosure | AI stage absent from DI; any call throws `E_AI_STAGE_DISABLED`; `/healthz` and `/readyz` unaffected |
| `ai.gate2.attestation` | *(empty)* — format `^\d{4}-\d{2}-\d{2}\|[0-9a-f]{64}$` | `OCR_AI_GATEWAY_RETENTION_ATTESTATION` | Enabling the AI stage requires a written, hashed Gate-2 answer (§4.8) | If `OCR_AI_STAGE_ENABLED=true` and this is absent/malformed: **exit 78**, stderr `E_GATE2_UNANSWERED`, listener never binds |
| `ai.gate2.attestation.max_age_days` | `365` | — | An attestation about a mutable system decays | boot proceeds; `W_GATE2_ATTESTATION_STALE` at WARN on every boot + admin health page |
| `ai.gateway.base_url` | `OWNER-BLOCKED (B-2)` | `LITELLM_BASE_URL` | Verbatim from the verified INNOVERA Chat convention (`DEPLOYMENT.md`) | unset ⇒ AI stage inert (never a fallback URL) |
| `ai.gateway.api_key` | `OWNER-BLOCKED (B-2)` — a **virtual key**, never the master key | `LITELLM_API_KEY` | Verbatim from the verified Chat convention; least privilege | unset ⇒ AI stage inert |
| `ai.model.allowlist` | *(empty)* | `OCR_AI_MODEL_ALLOWLIST` | Residency unverifiable (B-3); silence is not consent | empty ⇒ every call refused `E_AI_MODEL_NOT_ALLOWED`; response `model` mismatch ⇒ request fails + `W_AI_MODEL_MISMATCH` |
| `ai.boundary.pixels` | **never** | — | Page images carry §26 biometric + religion data; `AiPromptPayload` has no image variant | unrepresentable in the type; dependency-cruiser forbids `infrastructure/ai/**` importing render modules |
| `ai.minimisation.mode` | `strict` (rules R1–R7, D-G2-4) | `OCR_AI_MINIMISATION_MODE` | Only a defence applied before the boundary survives a bad Gate-2 answer | unknown enum value ⇒ **boot refusal**, never a silent fallback |
| `ai.minimisation.version` | `1` | — | Rule changes must be attributable to a result | recorded on every AI result row; loosening a rule is a major bump + decision record |
| `ai.minimisation.nid_rule` | 13-digit run, **checksum-independent** | — | OCR digit errors break the mod-11 checksum on exactly the documents that matter | over-redacts ~91% of unrelated 13-digit runs; accepted |
| `ai.prompt.max_chars` | `12000` | `OCR_AI_MAX_PROMPT_CHARS` | Below the verified house precedent (Chat: 20,000 chars vs a 65,536-token ceiling); identity-document text deserves a smaller per-row blast radius | `>12000` ⇒ `E_AI_PROMPT_TOO_LARGE` before any network call; larger inputs are **chunked, never truncated**; env outside `[1000, 20000]` ⇒ boot refusal |
| `ai.prompt.chunk_overlap_chars` | `200` | — | Preserves cross-boundary context when chunking | — |
| `ai.request.suppression_headers` | `x-litellm-enable-message-redaction: true`, `litellm-enable-message-redaction: true`, `x-litellm-disable-callbacks: langfuse,langsmith,s3,gcs_bucket,datadog,otel,arize,braintrust,posthog,lunary` | — | The client wins LiteLLM's redaction precedence (§2.3); works with zero owner action | sent unconditionally; degrades silently on unknown versions — defence-in-depth, never the primary control |
| `ai.request.suppression_body` | `{"turn_off_message_logging": true, "no-log": true}` | — | Same; verified as a supported, non-request-blocked dynamic param | as above; `no-log` has open defect #15173 |
| `ai.request.banned_header` | `LiteLLM-Disable-Message-Redaction` — **never sent** | — | Highest-precedence override that *disables* redaction (§2.3) | its literal presence in the codebase is a **CI failure** (pre-commit grep) |
| `ai.request.metadata` | `{"ai_request_id": "<uuidv4>"}` **only** | — | A `documentId` in gateway metadata makes gateway rows re-identifiable, in a system with no erasure path | `documentId`, `tenantId`, `userId`, `end_user`, `filename` are lint-forbidden in the AI request builder |
| `ai.gateway.cache` | **prohibited** — `"cache": {"no-cache": true}` per request | — | A cache is an unerasable copy outside the shredding boundary (§2.7) | our own cache instead, keyed `sha256(minimisedText‖alias‖promptVersion)`, encrypted under the document DEK |
| `ai.result_cache.ttl_days` | `30` | `OCR_AI_RESULT_CACHE_TTL_DAYS` | Bounded by document retention (owned by the storage dimension) | `0` disables; outside `[0, 365]` ⇒ boot refusal |
| `ai.readiness.participation` | **none** | — | Mirrors the verified Chat rule: LiteLLM is not part of readiness | gateway down ⇒ AI stage degrades; `/healthz`, `/readyz`, and every deterministic stage stay green |
| `erasure.mechanism` | **crypto-shredding** (per-document 256-bit DEK, AES-256-GCM, wrapped by a tenant KEK, wrapped by a root key) | `OCR_KMS_ROOT_KEY_REF` | Only technique that reaches backups and replicas; matches the 2024 PDPC "no reasonably foreseeable recovery" standard | destroy the `document_keys` row ⇒ every copy unrecoverable everywhere at once; **key loss = data loss** (root key backed up separately, split-custody restore drill) |
| `erasure.audit_digest` | `HMAC-SHA-256(HKDF(DEK, info="audit-digest/v1"), content)` | — | A globally-keyed digest of a 13-digit NID is a re-identification oracle (10^13 keyspace) | shredded with the DEK; the row survives and stops being personal data |
| `erasure.audit_chain` | `chainHash` over **metadata only**, under a global never-shredded key | — | Tamper-evidence must survive erasure | chain verifiable end-to-end after any number of erasures |
| `erasure.latency_target_seconds` | `60` | — | Key destruction is O(1); no reason to be slow | exceeded ⇒ alert; statutory ceiling is 90 days, so there is enormous margin |
| `erasure.internal_sla_days` | `7` | `OCR_ERASURE_SLA_DAYS` | 83 days of margin under the 90-day statutory ceiling for the parts we do not control | value `>90` ⇒ boot refusal (statutory ceiling) |
| `pdpa.erasure_statutory_days` | `90` | — | PDPC Notification B.E. 2567 (2024), effective 11 Nov 2024; covers copies and backups | cited, never restated |
| `pdpa.sensitive_default` | **every document treated as potentially §26** | — | The system cannot know pre-processing what was uploaded; a Thai ID card carries religion + facial photograph | uniform strictest controls; `LEGAL-REVIEW-REQUIRED (B-5)` |
| `pdpa.controller_role` | **processor** for document content; **controller** for account/billing data | — | Determines which obligations are ours vs the customer's (§6.2) | DPA required with every customer; gateway is a same-entity system, **not** a sub-processor (§6.3) |
| `gateway.retention.verdict` | prompt **UNKNOWN** / response **UNKNOWN** / location **UNKNOWN** / period **UNKNOWN** / erasure path **UNKNOWN** | — | Gateway unreachable from this session; `OWNER-BLOCKED (B-1)` | never presented as known; §4 is the inspection protocol that resolves it |
| `gateway.erasure_reachability` | **none** — no erasure path into the gateway exists that we can build | — | The gateway's unit of record is a request; it has no concept of a document | the sole justification for the minimisation-first posture (D-G2-1/3/4/6/9) |

---

## Sources

Primary documentation and source, all fetched 2026-09-09:

- [LiteLLM — Logging](https://docs.litellm.ai/docs/proxy/logging)
- [LiteLLM — All settings (`config_settings`)](https://docs.litellm.ai/docs/proxy/config_settings)
- [LiteLLM — Team/Key Based Logging](https://docs.litellm.ai/docs/proxy/team_logging)
- [LiteLLM — Caching](https://docs.litellm.ai/docs/proxy/caching)
- [LiteLLM — DB Info](https://docs.litellm.ai/docs/proxy/db_info)
- [`BerriAI/litellm` — `schema.prisma`](https://github.com/BerriAI/litellm/blob/main/schema.prisma)
- [`BerriAI/litellm` — `litellm/litellm_core_utils/redact_messages.py`](https://github.com/BerriAI/litellm/blob/main/litellm/litellm_core_utils/redact_messages.py)
- [`BerriAI/litellm` — `litellm/litellm_core_utils/initialize_dynamic_callback_params.py`](https://github.com/BerriAI/litellm/blob/main/litellm/litellm_core_utils/initialize_dynamic_callback_params.py)
- [`BerriAI/litellm` — `litellm/proxy/spend_tracking/spend_tracking_utils.py`](https://github.com/BerriAI/litellm/blob/main/litellm/proxy/spend_tracking/spend_tracking_utils.py)
- [`BerriAI/litellm` — `litellm/_logging.py`](https://github.com/BerriAI/litellm/blob/main/litellm/_logging.py)
- [Issue #16336 — `turn_off_message_logging` does not redact `proxy_server_request`](https://github.com/BerriAI/litellm/issues/16336)
- [Issue #9507 — `turn_off_message_logging` sometimes not redacting output](https://github.com/BerriAI/litellm/issues/9507)
- [Issue #15173 — `no-log` does not fully prevent Langfuse traces](https://github.com/BerriAI/litellm/issues/15173)
- [Issue #10788 — proxy INFO request logging cannot be switched off](https://github.com/BerriAI/litellm/issues/10788)

Thai PDPA:

- [Norton Rose Fulbright — Overview of Thailand PDPA B.E. 2562 (2019)](https://www.nortonrosefulbright.com/en/knowledge/publications/e29d223d/overview-of-thailand-personal-data-protection-act-be2562-2019)
- [Thailand Law Library — PDPA Rights of the Data Subject (ss. 30–42)](https://library.siam-legal.com/thai-law/personal-data-protection-act-rights-of-the-data-subject-sections-30-42/)
- [Tilleke & Gibbins — Criteria for Deletion, Destruction, and De-identification of Personal Data](https://www.tilleke.com/insights/thailand-issues-criteria-for-deletion-destruction-and-de-identification-of-personal-data/)
- [LawPlus — Rules on Deletion, Destruction or Anonymization of Personal Data](https://www.lawplusltd.com/2024/08/rules-on-deletion-destruction-or-anonymization-of-personal-data/)
- [Tilleke & Gibbins — Thailand Unveils Regulations for Cross-Border Personal Data Transfer](https://www.tilleke.com/insights/thailand-unveils-regulations-for-cross-border-personal-data-transfer/21/)
- [Nishimura & Asahi — Personal Data Protection Update: sub-regulations and guidelines](https://www.nishimura.com/en/knowledge/publications/personal-data-protection-update-recent-developments-sub-regulations-guidelines-and-official-plan-under-the-thai-pdpa)
- [PDPA Thailand — Section 33 (text)](https://pdpathailand.com/pdpa/content_eng/article33_eng.php)
- [PDPA Thailand — Section 37 (text)](https://pdpathailand.com/pdpa/content_eng/article37_eng.php)
</content>
</invoke>
