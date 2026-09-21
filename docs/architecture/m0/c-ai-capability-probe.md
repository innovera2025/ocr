---
dimension: c-ai-capability-probe
title: Safe AI capability discovery method + probe tooling (items E, F)
m0_items: E, F
status: reviewed
date: 2026-09-09
reviewed: 2026-09-09
review_note: >
  Adversarial completeness review. Two citation/method errors corrected, one
  ladder rung added (Thai round trip), two rungs added (readiness details,
  /v1 metadata fallbacks), five script defects fixed, and every hand-waved
  policy in §5 replaced with code. See "Critic Notes" at the end.
---

# Safe AI Capability Discovery + Probe Tooling

> **Integration status (2026-09-12):** Read the [architecture index](../README.md) and its consolidation report before using these examples. Individual review labels do not close cross-document conflicts; no application implementation is verified.

**Scope.** M0 items **E** ("what can the AI gateway actually do?") and **F** ("what is the
production-safe way ocr-web talks to it?").

**Bottom line.** Items E's *answers* cannot be produced in this session — there is no INNOVERA
LiteLLM endpoint or credential reachable from this workstation, and I independently confirmed
that (§2). What I deliver instead is the **method**: a ten-rung, least-invasive-first probe
ladder, two runnable-but-never-yet-run probe scripts, and a decision table that lets
architecture proceed *before* the answer arrives, because **the deterministic OCR engine is
primary in both branches** (§6). The AI gateway is a post-processor, never the OCR of record.
Nothing in M1 is blocked on this probe; only the *optional* enrichment layer is.

> **Nothing below asserts what the INNOVERA gateway is or can do.** Every model name,
> endpoint, port, token count and capability in this document is either an explicitly
> labelled placeholder or an explicitly labelled branch. Items **C, D, E** remain
> **UNRESOLVED — owner-supplied blocker**. If you are skimming for "does it do vision?",
> the answer is: *nobody in this repository knows yet, and §4's run-book is how you find out.*

---

## 1. The one finding that changes the method

My brief instructed me to treat LiteLLM's `/model/info` as *"the cheapest authoritative vision
answer, prefer it over inference."* **Research says that is only conditionally true, and
believing it unconditionally would produce a wrong architecture.**

For a **self-hosted vLLM behind LiteLLM**, `supports_vision` and `max_input_tokens` are *not*
discovered from the backend. LiteLLM populates them from its static model-price map, which has
no entry for a custom `openai/qwen-*` route. Two upstream issues confirm this:

| Evidence | What it establishes |
|---|---|
| [BerriAI/litellm#27830](https://github.com/BerriAI/litellm/issues/27830) — *"Auto-populate max_input_tokens/max_output_tokens for hosted vLLM/OpenAI-like models"* | Hosted vLLM / OpenAI-compatible models "frequently display `max_input_tokens: null` and `max_output_tokens: null` unless administrators manually configure `model_info`". Open feature request — **not** current behaviour. |
| [BerriAI/litellm#9297](https://github.com/BerriAI/litellm/issues/9297) — *"Parameter supports_vision: True is ignored on config.yaml of LiteLLM Proxy"* | A user set `supports_vision: True` under `model_info`, `metadata`, **and** `litellm_params`; none took effect for their client. Closed as *not planned*. **Caveat added on review:** this report is against an **Ollama** backend, not vLLM, and it is old. It is evidence that the propagation path is fragile, **not** proof that `model_info` never works. See the correction under the trust rule. |
| [LiteLLM — Using Vision Models](https://docs.litellm.ai/docs/completion/vision), `/model_group/info` sample | The sample response shows `llava-hf` with `"max_input_tokens": null, "max_output_tokens": null, "mode": null` **and `"supports_vision": true`** — the operator set `supports_vision` by hand in `model_info` and it *did* surface, while the token limits stayed null. This is the single most informative example in the docs and it establishes both halves of the trust rule at once. |

> **Correction made on review.** An earlier draft of this table cited the `llava-hf` sample
> to `docs/proxy/model_discovery`. That page documents only `/v1/models` and contains no such
> example; the sample lives on the **vision** page. The link is fixed above. The underlying
> claim survives — but note the sample actually shows `supports_vision: true` *working*, which
> is why the trust rule below asymmetrically trusts `true` and distrusts `null`. Do not repeat
> the earlier draft's stronger reading that `model_info` is simply ignored.

### The trust rule (encoded in both scripts)

> `supports_vision: true` → **trust it.** Only a human operator writing `model_info` produces
> this, so it is a positive assertion.
>
> `supports_vision: false` or `null` → **UNKNOWN, not "no".** This is the default for an
> unconfigured self-hosted route. Fall through to the empirical probe (rung **e**).

Rung **c** is therefore *cheap and worth doing first*, but it is **declarative** (what the
operator claims), not **authoritative** (what the GPU does). Rung **e** is the authority when c
is silent. Both scripts emit `declared.trustworthy` to make this explicit, and raise a
`CONTRADICTION` blocker if `declared=true` but the empirical probe is rejected.

*Rejected alternative:* trust `/model/info` alone and skip rung e. **Why rejected:** on the most
likely INNOVERA topology (custom vLLM route, `model_info` not hand-written) it yields a
false "text-only" verdict, which would delete the entire vision branch of the architecture
for no reason.

---

## 2. Verification log — what I actually confirmed in-session

Commands I ran, on this workstation only:

```
ls -la ~/.EasyOCR/model/
  craft_mlt_25k.pth   83,152,330 B  Jun  2 15:28
  thai.pth           215,384,298 B  Jun  2 15:50
/usr/bin/python3 -V   -> Python 3.9.6      (system interpreter, only one on PATH)
jq --version          -> jq-1.7.1-apple
curl --version        -> curl 8.7.1
/bin/bash --version   -> GNU bash 3.2.57(1)-release
```

### ⚠ Correction made on review — the original search command was invalid

An earlier draft recorded this as the evidence for the negative finding:

```
grep -rilE 'litellm|vllm' ~/Documents --include='*.md,*.yaml,*.yml,*.json,*.ts,*.py'
  (no output)
```

**That command proves nothing.** `--include` takes **one** glob per occurrence; a
comma-separated list is treated as a single literal pattern that matches no filename at all.
The command therefore searched **zero files** and exited 1. Reproduced here to be sure:

```
$ printf 'litellm here\n' > g/a.md ; printf 'vllm here\n' > g/b.yaml
$ grep -rilE 'litellm|vllm' g --include='*.md,*.yaml,*.yml,*.json,*.ts,*.py'
(no output)                                   # exit 1 -- FALSE NEGATIVE
$ grep -rilE 'litellm|vllm' g --include='*.md' --include='*.yaml'
g/b.yaml
g/a.md                                        # exit 0 -- the correct form
```

Re-run correctly, with one `--include` per glob and `node_modules` excluded:

```
grep -rilE 'litellm|vllm' ~/Documents \
  --exclude-dir=node_modules --exclude-dir=.git \
  --include='*.md' --include='*.yaml' --include='*.yml' --include='*.json' \
  --include='*.ts'  --include='*.py'   --include='*.sh'  --include='*.toml'
  -> (no matches outside ~/Documents/OCR itself)

# control, proving files really are being searched:
grep -rilE 'react|next' ~/Documents --exclude-dir=node_modules --include='*.json' | head -3
  -> Documents/GarageOS/garageos-app/tsconfig.base.json
     Documents/GarageOS/garageos-app/apps/web/package.json
     Documents/GarageOS/garageos-app/apps/web/tsconfig.json
```

* **Orchestrator's negative finding — CONFIRMED, this time with a command that actually ran.**
  Zero LiteLLM/vLLM configuration anywhere under `~/Documents`. Items C/D/E's *values* are
  genuinely owner-supplied blockers, not a search failure. The conclusion did not change; the
  evidence for it did, and the earlier version of this section should not be cited.
* **Scope caveat that remains true:** this searched `~/Documents` only, by file extension, and
  deliberately did not read `.env*` files (repo privacy hook). A credential living in a
  password manager, a Kubernetes secret, or a colleague's head would not appear here. The
  finding is "not recorded in files this session may read", not "does not exist".
* **Prior Thai OCR work — CONFIRMED.** EasyOCR Thai recognition weights and the CRAFT text
  detector were downloaded 2026-06-02. Relevant to the engine dimension, not this one.
* **bash is 3.2.57**, so the shell probe avoids bash-4 features (no associative arrays, no
  `${x,,}`, no `mapfile`). This is a real constraint I designed around, not a hypothetical.

**UNVERIFIED (and unverifiable here):** the gateway's hostname, port, auth scheme, LiteLLM
version, vLLM version, model names, and every capability answer. No claim about them appears
below except as an explicitly-labelled branch.

---

## 3. The probe ladder

Ordered strictly least-invasive → most. **Stop at the first rung that fails structurally**
(connection refused, 401) — later rungs cannot be interpreted without earlier ones.

**Sharpened on review — "structurally" means exactly two things**, and nothing else should stop
the ladder:

| Failure | Stop? | Why |
|---|---|---|
| Connection refused / DNS / TLS handshake | **STOP** | Nothing downstream is interpretable. Wrong host/port/firewall/VPN. |
| 401/403 on an authenticated rung | **STOP** | Every later verdict would be an auth artefact, not a capability. |
| **3xx redirect** | **STOP** — and escalate | Security finding (§4 contract #7, §5.1a). Do not chase, do not continue. |
| 404 on a1/a2 | **continue** | Path-stripping proxy or not-LiteLLM. Misconfiguration; `/v1/*` may still work. |
| 404 on a3 or on all of c1–c4 | **continue** | Optional/version-dependent routes. Record and move on. |
| 404 on a chat rung | **continue, but fix the model name** | Wrong model id. Later verdicts are meaningless until fixed. |
| 5xx anywhere | **continue** | Backend fault. Never a capability answer; recorded as `unknown`. |

Cost legend: **none** = no model load, no GPU. **tiny** = one forward pass, ≤ 64 output tokens.

**Rung index** (a1, a2, **a3**, b, c1–c4, d, **d2**, e1, e2, f1, f2, g, h — 16 requests).
**a3**, **c3/c4** and **d2** were added during the completeness review; **d2** in particular
closes the document's largest gap, since the original ladder never sent a single Thai character
to a gateway intended for a Thai-primary product.

### a1/a2. Liveness — `GET /health/liveliness`, `GET /health/readiness` · cost: none

Per the [LiteLLM health docs](https://docs.litellm.ai/docs/proxy/health), both are unauthenticated
and neither triggers a model call. `liveliness` (LiteLLM's spelling; `/health/liveness` is an
alias) is a bare process-up check with no dependency checks.

**Corrected on review — the response shape.** An earlier draft said `readiness` returns
`{"status":"healthy","db":...}`. It does not. The documented payload is:

```json
{ "status": "ready", "db_initialized": true, "router_initialized": true }
```

`status` is `"ready"` or `"not_ready"`; it returns **503** when a configured database is
unreachable. The payload is deliberately low-detail *because* it is exposed unauthenticated.
Both scripts now record these three fields verbatim rather than asserting a shape.

* **PASS** → 200 (and `status: "ready"` on a2).
* **FAIL** → connection refused / DNS failure / TLS error.
* **not-supported vs misconfigured:** a 404 here means the proxy is *not LiteLLM* (or is behind a
  path-stripping reverse proxy) — that is misconfiguration, not absence of capability, and the
  later rungs are still worth running. Connection refused means wrong host/port/firewall/VPN.
  A **503** on readiness with a **200** on liveliness is a third, distinct state: LiteLLM is up
  but its database is not, which will fail virtual-key auth while chat may still work.
* **401 here** is a *reverse-proxy* finding, not a LiteLLM one: LiteLLM documents these as
  unauthenticated, so an auth challenge means something in front of it is adding one.

> **Do NOT call bare `GET /health`.** It is authenticated and, per the same doc, *"runs a real
> test request against every configured model."* On a production GPU that is a broadcast load
> event. Both scripts deliberately omit it, and so must you.
>
> **The scripts do not send the API key on a1/a2.** These endpoints do not read it, and writing
> a live credential into the access log of an unauthenticated endpoint is free risk.

### a3. Gateway version — `GET /health/readiness/details` · cost: none *(added on review)*

Authenticated, but still **no model call**. Returns the authenticated readiness diagnostics:
database, cache, callbacks, and **`litellm_version`**.

*Why this rung exists:* an earlier draft listed "LiteLLM version" in §7 as a question for the
gateway operator, while a zero-cost endpoint answers it. Since the LiteLLM version decides
whether `model_info` propagation and `response_format: json_schema` pass-through behave, asking
a human for something the gateway will volunteer is a self-inflicted blocker. Both scripts now
read it here, and fall back to the `x-litellm-version` **response header** harvested from any
other rung.

* **PASS** → 200 with `litellm_version`.
* **404** → older LiteLLM, or `general_settings.allow_public_health_readiness_details` is unset
  on a build that gates it. **Not** a failure; fall back to the header.
* **401/403** → the key is wrong or lacks admin scope. Says nothing about the models.
* **UNVERIFIED:** the exact availability of this path across LiteLLM versions. It is probed
  opportunistically and never depended on.

### b. Authoritative model list — `GET /v1/models` · cost: none

* **PASS** → 200 with `data[].id`. This list, not documentation, is the set of callable names.
* **FAIL** → 401 (bad key) / 404 (base URL missing `/v1`).
* **Bonus:** vLLM [PR #4643](https://github.com/vllm-project/vllm/pull/4643) adds `max_model_len`
  to the ModelCard. **UNVERIFIED whether it survives LiteLLM's proxying** — LiteLLM rebuilds the
  list from its own model groups, so expect it to be stripped. Both scripts read it opportunistically.

### c. Declared capability metadata — `/model_group/info`, `/model/info` · cost: none

These are documented at the server **root**. Confirmed request shape:

```bash
curl -X GET 'http://localhost:4000/model_group/info' \
  -H 'accept: application/json' -H 'x-api-key: sk-1234'
```

Returns per model group: `model_group`, `providers`, `max_input_tokens`, `max_output_tokens`,
`mode`, `supports_vision`, `supports_function_calling`.

**Path note (corrected on review).** The original brief asked for `/v1/model/group/info`. That
path does not exist — the underscore form is the real one. Both spellings are however served
at the **root and under `/v1`** on the builds we can find evidence for
(`/model_group/info` and `/v1/model_group/info`; likewise `/model/info` and `/v1/model/info`),
and a path-prefixing reverse proxy will commonly expose only the `/v1` variants. The scripts
therefore probe **four** paths — `c1 /model/info`, `c2 /model_group/info`,
`c3 /v1/model/info`, `c4 /v1/model_group/info` — so that a 404 on the root pair is never
mistaken for "this is not LiteLLM". *(Which prefix a given build serves: **UNVERIFIED**.)*

* **PASS** → 200 and `supports_vision: true` → vision confirmed, **cheapest possible answer**.
* **AMBIGUOUS** → 200 but `null`/`false` → **UNKNOWN** (see §1). Proceed to **e**.
* **not-supported vs misconfigured:** 404 on **all four** c-paths while **a** and **b** passed
  means you are talking to raw vLLM, not LiteLLM — these are LiteLLM-only routes. That reframes
  the whole gateway model and should be reported, not retried. 404 on the root pair but 200 on
  the `/v1` pair means a path-prefixing proxy — cosmetic, adjust the base URL and move on.

*Scripts prefer `model_group/info` over `model/info`, because the former is keyed by the
model-group name that `/v1/models` returns; and they prefer whichever prefix answers first.*

### d. Minimal text liveness — `POST /v1/chat/completions`, `max_tokens: 8` · cost: tiny

Body: one user turn `"Reply with the single word: PONG"`, `temperature: 0`.

* **PASS** → 200, non-empty `choices[0].message.content`. Record wall-clock latency: this is your
  cold-start + single-token baseline and it feeds the timeout budget in §5.6.
* **FAIL** → 404 *model not found* (name wrong — misconfigured), 401 (key), 500 (backend down),
  timeout (model still loading — retry once manually after 60 s).
* **Tokenizer sanity:** record `usage.prompt_tokens` and the prompt's character count. This is
  the **English half** of the calibration; on its own it is useless for Thai. The scripts now
  store `tokenizer.en_prompt_tokens` / `en_chars_per_token` for comparison against rung **d2**.

### d2. Thai round trip + Thai token calibration · cost: tiny · **ADDED ON REVIEW**

**This rung did not exist in the original ladder and its absence was the largest gap in the
document.** INNOVERA OCR AI is Thai-primary. A ladder whose only text probe is
`"Reply with the single word: PONG"` proves the gateway can move ASCII and proves nothing about
the language the product is actually for. Worse, §5.6 declared that the Thai token ratio "must
be recalibrated from rung **d**'s `usage.prompt_tokens`" — but rung **d** sends English, so the
calibration it promised was **impossible with the ladder as designed**. That contradiction is
resolved here.

Body: one user turn asking for a verbatim echo of a fixed Thai string, `max_tokens: 64`,
`temperature: 0`. The probe string is chosen to detonate every Thai-specific failure mode at
once:

```
เอกสารเลขที่ ๐๑๒/๒๕๖๗ หน้าคำนูณ์
```

| Element | Codepoints | What it catches |
|---|---|---|
| `ที่` — vowel above + tone mark | U+0E17 U+0E35 U+0E48 | Multi-level combining-mark stacking; naive "strip diacritics" middleware |
| `คำ` — SARA AM | U+0E33 | **NFC/NFD reordering.** SARA AM decomposes to NIKHAHIT + SARA AA under NFD. macOS emits NFD; most servers emit NFC. |
| `ณ์` — THANTHAKHAT | U+0E4C | The silent-letter mark. Dropped by lossy normalisers, which silently changes the word. |
| `๐๑๒/๒๕๖๗` | U+0E50–U+0E59 | **Thai numerals.** Not ASCII digits. Ubiquitous in Thai document numbers and Buddhist-era dates. |
| No spaces inside words | — | Thai is unsegmented; this is *why* it tokenises badly. |

**Three separate answers come out of this one call:**

1. **Encoding integrity.** Does the Thai come back byte-identical?
   * **PASS `exact`** → the string is present verbatim.
   * **PASS-WITH-NOTE `nfc-equal`** → present after NFC normalisation only. Not corruption, but
     it means **every** boundary (DB write, hash, string compare, dedup key) must normalise to
     NFC or identical Thai will compare unequal. The scripts emit that note.
   * **BLOCKER `MANGLED`** → Thai returned but altered.
   * **BLOCKER `NO_THAI_RETURNED`** → the model translated, transliterated, or the text was
     stripped in transit.
   * Comparison is done **after `unicodedata.normalize("NFC", …)` on both sides** — a raw
     `==` would report false corruption purely from macOS's NFD filesystem/clipboard forms.
2. **Thai-numeral survival.** The scripts count how many of U+0E50–59 came back. `0/4` is a
   note, not a blocker, but it means the extraction layer **must** carry an explicit
   Thai↔ASCII digit normaliser and must not assume the model preserves them.
3. **The token budget, measured.** `usage.prompt_tokens` here vs rung **d** yields
   `th_chars_per_token` and `th_penalty_vs_en`. This is the **only** honest source for §5.6.
   * **Honest caveat, encoded in the script's own output:** `prompt_tokens` includes the English
     instruction and the chat template, so the measured Thai ratio **understates** the penalty.
     Treat it as a **lower bound**, and re-measure with a Thai-only prompt before tuning chunk
     sizes. The scripts say this in `notes[]` so nobody reads the number as final.

* **not-supported vs misconfigured:** a non-2xx here is never a Thai finding — it is the same
  auth/model-name/backend problem as rung **d**, and is reported as `unknown (HTTP nnn)`.

> **Gate.** Do not accept the gateway for this product until d2 returns `exact` or `nfc-equal`.
> Both scripts raise a blocker if d2 was not run.

### e. Vision — the discriminative probe · cost: tiny

Standard OpenAI content-parts format, confirmed against
[LiteLLM's vision doc](https://docs.litellm.ai/docs/completion/vision):

```json
{"role":"user","content":[
  {"type":"text","text":"..."},
  {"type":"image_url","image_url":{"url":"data:image/png;base64,<...>"}}]}
```

**Design change vs the brief — and why.** The brief specifies a describe-probe on an image of the
word "OCR", then a discriminative retest only if the answer is ambiguous. I **invert the
priority**: the discriminative image is the *primary* probe, run unconditionally.

*Reason:* "OCR" is **guessable**. A model prompted by an OCR system may answer "OCR" from context
with no image at all, producing a **false positive for vision**. A **random two-digit number** is
not guessable (1-in-90), so it separates *seeing* from *inferring*. Both scripts randomise the
digits per run (`random.randint(10,99)` / `$RANDOM`), which also defeats a cached or replayed
answer. The "OCR" describe-probe is retained as rung **e1** for qualitative colour only; **e2**
decides.

Prompt: *"Read the two-digit number in the image. Reply with ONLY those two digits. If you
received no image, reply exactly NO_IMAGE."* The explicit `NO_IMAGE` escape hatch is what
converts the brief's "ambiguous" bucket into a decisive answer in the common
silently-dropped-image case.

Interpretation (implemented identically in both scripts):

| Observation | Verdict | Reasoning |
|---|---|---|
| 400 + body asserts **the modality** is unsupported (see marker set below) | **text_only** | Backend explicitly rejected the modality. |
| 400 + body indicates **our request** was malformed (`base64`, `decode`, `too large`, `exceeds`, `invalid`) | **ambiguous** + explicit "inspect the body" note | **Our** bug, not a capability answer. |
| 400 without any marker | **ambiguous** | Inspect before concluding. |
| 401 / 403 | **unknown** | Auth failure says nothing about vision. |
| 404 | **unknown** | Wrong model name — *misconfigured*, not text-only. |
| 3xx | **redirect-refused** + SECURITY blocker | Not followed. See §5.1a. |
| 5xx | **unknown** | Backend fault, not a capability answer. |
| 200 and reply contains the expected digits | **vision** | Only a model that saw the pixels can produce them. |
| 200 and reply contains `NO_IMAGE` | **text_only** | Model answered but the gateway dropped the image part. |
| 200, any other reply | **ambiguous** | See the three sub-cases below. |

**Marker set narrowed on review.** The original matcher included a bare `image` substring. That
is a false-positive generator of exactly the kind this rung exists to prevent: a 400 reading
*"invalid base64 image data"* or *"image exceeds maximum size"* is **our** bug, and the original
matcher would have written a confident **`text_only`** verdict from it — deleting the entire
vision branch of the architecture (§6) because of a malformed probe. Every marker now asserts
non-support of the modality, not the mere presence of the word "image":

```
"does not support image"   "doesn't support image"   "not support vision"
"multimodal"               "content part"            "image_url is not supported"
"unsupported content type" "only supports text"      "text-only"
"vision is not"            "image input"
```

The **`404 → unknown`**, **`5xx → unknown`** and **malformed-400 → ambiguous** rows are the
"not supported vs misconfigured" discipline: none of them is ever allowed to write a
`text_only` verdict.

**The three sub-cases behind "200, any other reply"** — the scripts emit this as a note, because
they are genuinely different problems:

1. **Vision works, the bitmap is too crude.** The 5×7 font at 8× scale is legible to a human but
   is not a natural glyph. Re-run with `--digits` pinned and inspect `probes[].evidence`.
2. **Thai-numeral answer.** A Thai-tuned model may answer `๔๗` rather than `47`. The matcher
   looks for ASCII digits only, so this reads as `ambiguous` when the model in fact **saw the
   image perfectly**. If the reply contains U+0E50–59, treat it as a **`vision` PASS** by hand.
   *This is a known limitation of the automated verdict and is deliberately left conservative —
   an ambiguous verdict costs a retest; a wrong `text_only` costs an architecture branch.*
3. **The image was dropped silently and the model guessed.** Distinguished by re-running: a
   guess will not track a fresh random pair across runs, a real read will.

**What this rung does NOT establish: that the model can read Thai script.** The synthetic font
has glyphs for `0-9 O C R` only; the Python stdlib cannot rasterise Thai (no font engine, and
Thai requires mark positioning, not just glyph placement). Vision capability is therefore
**necessary but not sufficient** for Branch B — see §6's flip conditions. Establishing Thai
*reading* requires a real rendered Thai crop, which is a **manual e3 step for the owner**:
render one line of Thai with any system font (`textutil`/Preview/a screenshot of a test doc),
pass it through the same request shape, and check the transcription by eye. It is deliberately
not automated here, because doing it properly needs a font asset this repository does not have.

### f. Structured output · cost: tiny

Two separate requests, because support differs:

1. `response_format: {"type":"json_schema", "json_schema":{..., "strict":true}}`
2. `response_format: {"type":"json_object"}`

`response_format: {"type":"json_schema"}` is documented as supported in vLLM's OpenAI server
**from around v0.8.5** *(source: vLLM structured-outputs docs and secondary write-ups; the exact
first-shipping version is **UNVERIFIED**, and it is **UNVERIFIED** for the INNOVERA build)*.
Do not treat "0.8.5" as a hard gate — treat it as "old builds probably can't, new builds probably
can, **measure it**."

There is a **second, opposite** version hazard the original draft missed. vLLM has since
**deprecated** the `guided_*` extra-body parameters in favour of the unified
`structured_outputs` / `response_format` API, and the backend is selected by
`--structured-outputs-config.backend` (default `auto`, choosing among xgrammar / outlines /
lm-format-enforcer / guidance). So the fallback ladder is **version-bracketed at both ends**:

| Gateway vintage | `response_format: json_schema` | `guided_json` extra body |
|---|---|---|
| Old vLLM | likely unsupported | supported (the only option) |
| Middle | supported | supported (deprecated) |
| New vLLM | supported | **may be removed** |

Which means: **do not design the fallback as "try json_schema, else guided_json."** On a new
build both the modern path and the legacy fallback can behave differently than assumed. The only
safe fallback is the one that needs no server feature at all — see the consequence line below.

* **PASS** → 200 **and** `choices[0].message.content` parses as JSON. Both scripts assert the
  *parse*, not just the status code, and record the **verdict string**, not a boolean.
* **PARTIAL** → 200 but content is not valid JSON → the constraint was **silently ignored**. This
  is the dangerous case: it looks healthy and corrupts data downstream. Treat as *not supported*
  — both scripts now raise a **blocker**, not a note, for this outcome.
* **FAIL** → 400 → `response_format` unsupported by this backend/version.
* **not-supported vs misconfigured** *(this line was missing and has been added)*:
  * **400 naming `response_format` / `json_schema` / `guided decoding`** → genuinely unsupported
    by this vLLM build. A capability answer.
  * **400 naming the *schema*** (`additionalProperties`, `unsupported schema keyword`,
    `$ref not supported`) → **misconfigured probe**: the backend supports structured output but
    not this schema dialect. xgrammar in particular rejects schema features outlines accepts.
    Simplify the schema and retest before writing off the capability.
  * **500 with a grammar-compilation trace** → the backend is present but failed to compile the
    grammar. Misconfiguration/bug, fixable, not a capability answer.
  * **404** → wrong model name, as everywhere else. Never a capability answer.
* **Consequence if both fail:** the extraction layer must use prompt-coaxed JSON + a **Zod parse
  at the boundary** + **one bounded repair retry** (feed the parse error back once, then give
  up), instead of relying on guided decoding. Because of the both-ends version hazard above,
  **build this path regardless of the probe result** and treat guided decoding as an
  optimisation that removes a retry, never as a correctness dependency. Design for this (§6).

### g. Streaming · cost: tiny

`stream: true`, read 2 SSE chunks, **abort**. The two implementations differ, and both caveats
below were wrong or missing in the original draft:

* **Python (fixed on review).** The original used the ordinary `http()` helper, which calls
  `resp.read()` — that **drains the entire stream**, which is precisely what the brief forbade
  and what holds a GPU slot for the full generation. There is now a dedicated `stream_probe()`
  that `readline()`s until it has seen 2 `data:` lines (hard cap 200 lines) and then **closes
  the socket**. It also inspects `Content-Type` so a buffered non-SSE reply is distinguishable
  from a rejected one.
* **Bash: the `--max-filesize` trick has a version floor the original draft did not state.**
  `curl --max-filesize 4096` aborts a transfer whose length is *not known in advance* — which is
  exactly what a chunked SSE stream is — **only from curl 8.4.0 onward**. The man page is
  explicit: *"before curl 8.4.0, when the file size is not known prior to download, for such
  files this option has no effect."* On older curl the option is silently inert, the script reads
  the whole stream, exit 63 never fires, and the "exit 63 proves it streamed" inference never
  triggers. The script now **checks `curl --version` and warns**; the header block's requirement
  was corrected from "curl 7.x+" to "curl 8.4.0+ for rung g". Verified locally against
  curl 8.7.1, where the trick does work. Blast radius when it doesn't: bounded by
  `max_tokens: 16`, so this is a verdict-quality bug, not a load event.

* **PASS** → 2xx **and** ≥1 `data:` line (both scripts now require *both*; the original set
  `streaming: true` from the status code alone).
* **PARTIAL / misconfigured** → 2xx, zero `data:` lines, non-`text/event-stream` content type →
  a **reverse proxy is buffering**, not a model limitation. Check `X-Accel-Buffering: no` and
  nginx `proxy_buffering off`. Both scripts now emit this as a distinct verdict string rather
  than a bare `false`.
* **FAIL** → 400 (streaming disabled by the gateway) or 4xx/5xx.
* **Bearing on the architecture:** almost none. §5.1 rejects browser-facing streaming outright,
  and OCR enrichment is a worker-side batch call. Streaming is probed because it is nearly free
  and because a buffering proxy is worth knowing about *before* it surprises someone later — not
  because M1 depends on it.

### h. Tool / function calling · cost: tiny

One trivial tool (`get_doc_status(doc_id:int)`), `tool_choice:"auto"`.

* **PASS** → `choices[0].message.tool_calls` non-empty.
* **PARTIAL** → 200 but no `tool_calls` (model answered in prose) → parameter accepted, capability
  weak/absent. Not usable for routing.
* **FAIL** → 400 → `tools` unsupported.
* Note: vLLM requires a `--tool-call-parser` matching the model family; absence usually means the
  server was started without it — **misconfigured, fixable**, not a model limit.

### i. Context window — read, never brute-force · cost: none

Take `max_input_tokens` from rung **c**; fall back to `max_model_len` from rung **b**.

> **Explicitly forbidden:** binary-searching the context limit with long prompts. On a shared
> production GPU that means multi-minute prefill occupancy, KV-cache pressure, and a
> denial-of-service against real users, to learn a number the operator can simply read off
> vLLM's `--max-model-len` flag.

If both sources are null, both scripts emit a **blocker** telling the owner to ask the operator.

Until then, architecture assumes an **UNVERIFIED 32 768-token** window. To be explicit about
what that number is: it is **a placeholder, not a measurement and not a recommendation**. It is
chosen because 32 768 is a common `--max-model-len` default for models in this class, and
because being wrong *low* is safe (extra chunking, slightly more calls) while being wrong *high*
is not (silent truncation of a document, which for an ID card means a silently missing field).
`AI_MAX_INPUT_TOKENS` in §5.2 exists precisely so this guess is a one-line config change and
never a code change. **Replace it with the probe's answer the day the probe runs.**

### Free facts harvested from every rung — response headers · cost: none *(added on review)*

Both scripts now capture response headers on **every** request and fold them into the report.
This costs nothing and pre-answers questions §7 would otherwise put to a human:

| Header | Answers |
|---|---|
| `x-litellm-version` | Open question #4, without waiting for a3 |
| `x-ratelimit-limit-requests` / `-remaining-requests` | Open question #6 — quota per key |
| `x-ratelimit-limit-tokens` / `-remaining-tokens` | Token quota, drives `maxCallsPerDocument` |
| `retry-after` | Confirms whether the gateway sends it at all (see §5.4) |
| `llm_provider-retry-after` | LiteLLM's *upstream* passthrough form (see §5.4) |
| `x-accel-buffering` | The rung-**g** buffering diagnosis |

**Caveat, cited:** per [BerriAI/litellm#27748](https://github.com/BerriAI/litellm/issues/27748),
`x-ratelimit-*` headers are **dropped on streaming responses** in the v3 parallel-request
limiter, because SSE headers flush before the post-call hook runs. So read quota headers from
the non-streaming rungs, and do not conclude "no rate limiting" from rung **g** alone.

---

## 4. The probe scripts

| Path | Runtime | Notes |
|---|---|---|
| `/Users/innovera/Documents/OCR/docs/m0/discovery/probe_ai_gateway.py` | Python 3.9 stdlib only | Richer: verdict reconciliation, contradiction detection, full JSON report. **Preferred.** |
| `/Users/innovera/Documents/OCR/docs/m0/discovery/probe-ai-gateway.sh` | bash 3.2 + curl + jq | For hosts where running a Python file is unwelcome. |

Both are headed with a banner stating they are **M0 diagnostic tooling, not application code, and
have never been executed against a real gateway.**

### Shared safety contract (enforced in code, not just documented)

1. **Dry-run by default.** `--run` is required to transmit anything.
2. **No hardcoded config.** `AI_BASE_URL` / `AI_API_KEY` from env only.
3. **Key never printed.** Masked to first 6 chars + length: `sk-dum...****(len=27)`.
4. **Public-provider refusal.** Hostname-suffix check against openai.com, anthropic.com,
   googleapis.com, dashscope/aliyuncs, x.ai, groq, mistral, cohere, together, openrouter,
   deepseek, perplexity, fireworks, replicate, huggingface. Pure string comparison — **no DNS,
   no connection**. `amazonaws.com` is deliberately *not* blanket-blocked (INNOVERA runs its own
   Lightsail hosts); only the Bedrock runtime endpoint is listed.
5. **Synthetic images only.** PNGs are drawn in-process by a hand-rolled encoder
   (signature + IHDR + IDAT + IEND, 8-bit grayscale, 5×7 bitmap font). No external asset, no
   customer document, ever.
6. **Short timeouts, zero retries, no state mutation.** Every request is a GET or a
   `max_tokens ≤ 64` POST. `POST /model/new` and friends are never called.
7. **Redirects are refused, not followed.** *(added on review — this was a real hole.)*
   Python's `urllib` installs `HTTPRedirectHandler` by default, so the original script would
   have **silently followed a 302 to any host**. That defeats guard #4 completely: the refusal
   list only ever inspects the URL you typed, never the URL you ended up talking to. A gateway
   with a stale config, a hijacked DNS entry, or a helpful reverse proxy could have redirected
   the probe — and later, real document text — to a public provider, and nothing would have
   objected. The Python script now installs a `redirect_request → None` handler; the bash
   script never passed `-L` (curl's safe default) and this is now stated rather than accidental.
   Any 3xx is recorded as a **SECURITY blocker**, not chased.
8. **The key is never on a command line.** *(added on review.)* The original bash passed
   `-H "Authorization: Bearer $API_KEY"` as an argv element, which is readable via `ps` by every
   other user on the host for the lifetime of the request — and a shared jump box is exactly
   where an operator would run this. Credentials now go through a `umask 077`, mode-0600
   `--config` file inside a mode-0700 temp dir, removed on trap EXIT.
9. **The key is not sent where it is not needed.** Rungs a1/a2 are documented as unauthenticated;
   the scripts omit the credential there rather than writing it into those endpoints' logs.

### Verification performed (these commands were actually run — re-run after the review edits)

```
python3 -m py_compile probe_ai_gateway.py            -> PY_COMPILE_OK
bash -n probe-ai-gateway.sh                          -> BASH_N_OK
/bin/bash -n probe-ai-gateway.sh                     -> BASH32_N_OK   (bash 3.2.57)

# dry-run against the discard port, nothing contacted
AI_BASE_URL=http://127.0.0.1:9/v1 AI_API_KEY=... python3 probe_ai_gateway.py  -> exit 0, valid JSON, 16 probes
AI_BASE_URL=http://127.0.0.1:9/v1 AI_API_KEY=... ./probe-ai-gateway.sh        -> exit 0, valid JSON

# the two tools agree on the contract
diff <(py  dry-run | jq -S 'keys')              <(sh dry-run | jq -S 'keys')              -> TOPLEVEL_KEYS_MATCH
diff <(py  dry-run | jq -S '.capabilities|keys') <(sh dry-run | jq -S '.capabilities|keys') -> CAP_KEYS_MATCH

# refusal guards (both tools)
AI_BASE_URL=https://api.openai.com/v1               -> REFUSED (suffix match), exit 2
AI_BASE_URL=https://dashscope-intl.aliyuncs.com/... -> REFUSED, exit 2
AI_BASE_URL=https://generativelanguage.googleapis.com/v1beta -> REFUSED, exit 2
AI_BASE_URL=https://api.deepseek.com/v1             -> REFUSED, exit 2
AI_BASE_URL unset                                   -> REFUSED, exit 2
--run with AI_API_KEY unset                         -> REFUSED, exit 2
AI_BASE_URL=http://10.20.30.40:4000/v1              -> NOT refused (private host proceeds)
```

**The bash emit filter was broken and is now fixed.** Extracting the final `jq` program and
running it standalone against dummy values produced:

```
jq: error: syntax error, unexpected '{', expecting '|' ... at <top-level>, line 8
```

A chain of `... as $x` bindings was missing its final `|` before the object constructor. This
would have crashed **only on the `--run` path, at emit time, after every network probe had
already been made** — the operator would have paid the full probe cost and received nothing but
a jq error. The filter is now exercised standalone with both a success-path and a
failure-path argument set, and asserted to produce the expected `tokenizer` maths and all six
blocker strings. **This is the strongest argument for the dry-run-by-default design: it does not
catch this class of bug.** Run the extracted-filter test after any edit to the emit block.

**Hard proof the dry-run opens no sockets.** I re-ran the Python dry-run with `socket.socket`
replaced by a class whose constructor raises, and `socket.create_connection` replaced by a raising
lambda. It completed normally and emitted its JSON — no socket was constructed:

```
python3 -c "import socket; socket.socket = <raising class>; \
            socket.create_connection = <raising lambda>; exec(open('probe_ai_gateway.py').read())"
  -> completed, notes: ["DRY RUN ONLY. No network traffic was generated.", ...]
```

**PNG encoder verified by an independent decoder.** Output opens in Pillow 11.3.0 as a valid
`168×88` / `120×88` 8-bit grayscale PNG (187 B / 160 B; 252 / 216 base64 chars). I rendered and
visually inspected both at 3× to confirm the glyphs are legible — an early version silently
clipped the text off a fixed 64×64 canvas, which would have produced a **false `text_only`
verdict** from an unreadable image. The canvas now auto-fits the text with a 16 px quiet zone.

### Output schema (`schema_version: "1.0"`)

> **⚠ EVERY VALUE BELOW IS A SHAPE ILLUSTRATION, NOT A FINDING.** An earlier draft of this
> block used `"qwen2.5-vl-7b"` as the example model id and `"vision_verdict": "vision"` as the
> example verdict. Both were invented to make the sample readable, and both are exactly the kind
> of plausible-looking placeholder a reader skims and remembers as an answer. **No INNOVERA
> model name is known to this repository.** Placeholders are now angle-bracketed so they cannot
> be mistaken for data.

```jsonc
{
  "schema_version": "1.0",
  "probe_tool": "probe_ai_gateway.py",           // or probe-ai-gateway.sh
  "generated_at": "<ISO-8601 UTC>",
  "mode": "dry-run" | "run",
  "base_url": "<AI_BASE_URL as given>",
  "api_key_masked": "sk-dum...****(len=27)",
  "capabilities": {
    "reachable": true,
    "models": ["<model-id-from-/v1/models>", "..."],   // UNKNOWN until the probe runs
    "selected_model": "<model-id>",
    "declared": {                      // from /model_group/info -- DECLARATIVE
      "supports_vision": null,         // true = trust; null/false = UNKNOWN, not "no"
      "supports_function_calling": null,
      "max_input_tokens": null,
      "max_output_tokens": null,
      "mode": null,
      "source": "model_group_info",
      "trustworthy": false             // true only when supports_vision === true
    },
    "empirical": {                     // measured -- AUTHORITATIVE
      "chat": true,
      "vision": "vision" | "text_only" | "ambiguous" | "unknown",
      // json_* are VERDICT STRINGS, never booleans -- see the fix note below
      "json_schema": "honored -- valid JSON returned"
                   | "accepted but output is NOT valid JSON (constraint not enforced)"
                   | "rejected (400) -- response_format not supported by this backend"
                   | "not-probed",
      "json_object": "<same enum>",
      "streaming": true,               // 2xx AND >=1 data: line, not status alone
      "streaming_chunks": 2,
      "tools": false,
      "thai_roundtrip": "exact" | "nfc-equal (normalisation differs)"
                      | "MANGLED" | "NO_THAI_RETURNED"
                      | "unknown (HTTP nnn)" | "not-probed"
    },
    "vision_verdict": "<one of the vision enum above>",
    "context_window": { "value": null, "source": "model_group_info"
                                               | "v1_models_max_model_len" | "unknown" },
    "tokenizer": {                     // measured by rungs d + d2. Null until probed.
      "en_prompt_tokens": null, "en_prompt_chars": null, "en_chars_per_token": null,
      "th_prompt_tokens": null, "th_prompt_chars": null, "th_chars_per_token": null,
      "th_penalty_vs_en": null         // en_cpt / th_cpt. >1 means Thai costs more.
    },
    "gateway": {
      "litellm_version": null,         // from a3, or the x-litellm-version header
      "rate_limit_headers": {}         // harvested x-ratelimit-* (absent on streaming)
    }
  },
  "probes":   [ { "id":"d2", "name":"thai_roundtrip", "status":200,
                  "verdict":"exact", "thai_expected":"...", "thai_got":"...",
                  "thai_numerals_preserved":"4/4",
                  "usage":{"prompt_tokens":null} },
                { "id":"e2", "name":"vision_discriminative",
                  "status":200, "expected":"<2 random digits>", "answer":"<model reply>" } ],
  "blockers": [ "<hard stops, e.g. context window unknown / Thai round trip failed>" ],
  "notes":    [ "<qualifications that change how a value should be read>" ]
}
```

**Both scripts emit this identical shape**, in **all** modes — verified by diffing
`jq -S 'keys'` and `jq -S '.capabilities|keys'` between the two dry runs.
*(Fixed on review: the bash dry run previously emitted `"capabilities": null` with no
`generated_at` and no `blockers`, and its unreachable-exit path emitted a fourth, entirely
different shape. Anything written against one output would have broken on the others.)*

**`blockers` vs `notes`.** A **blocker** means *do not proceed on this path* — it has a named
owner and a named next action. A **note** qualifies how to read a value. Do not demote a blocker
to a note to make a report look clean.

**Fixed on review — `json_schema` was a boolean.** The Python script set
`empirical.json_schema = bool(status == 2xx)` while the *document* claimed both scripts "assert
the parse, not just the status code", and while the bash twin correctly stored the verdict
string. That is the worst possible disagreement: the one outcome the document calls out as
**dangerous** — 200 with a non-JSON body, i.e. the constraint silently ignored — was being
recorded as `json_schema: true`, a clean pass. Both scripts now store the verdict string and
raise a **blocker** on the silently-ignored case.

Human progress goes to **stderr**, so `> capability.json` stays clean.

### Owner run-book (the moment credentials exist)

```bash
cd /Users/innovera/Documents/OCR/docs/m0/discovery
export AI_BASE_URL='https://<gateway-host>/v1'
export AI_API_KEY='sk-...'

python3 probe_ai_gateway.py                       # 1. review the plan (no sockets)
python3 probe_ai_gateway.py --run | tee capability.json

# 2. read the four answers that actually decide architecture, in this order:
jq '.blockers' capability.json                              # anything here = stop and resolve
jq '.capabilities.empirical.thai_roundtrip' capability.json # Thai-primary gate (§3.d2)
jq '.capabilities.vision_verdict' capability.json           # picks §6 Branch A or B
jq '.capabilities.context_window, .capabilities.tokenizer' capability.json  # sets §5.6 budget
```

**Read `blockers` first.** A report with a populated `blockers` array is not an answer; it is a
list of things to go resolve. In particular, `vision_verdict` is meaningless if `chat` failed,
and the Thai gate outranks the vision verdict — a gateway that mangles Thai is unusable for this
product no matter how well it reads pictures.

Commit `capability.json` (it contains **no key** — only the masked fingerprint) to
`docs/m0/discovery/` as the durable answer to item E, then pick a branch from §6.

**Before committing, check the report for leakage.** The report embeds `probes[].evidence` and
`probes[].thai_got`, i.e. gateway response bodies. Those are synthetic-probe replies and should
be safe, but confirm before it enters git history:

```bash
grep -c "$AI_API_KEY" capability.json          # must print 0
jq -r '.api_key_masked' capability.json        # must be the masked form only
```

---

## 5. Item F — the production-safe connection method

### F.1 Server-side only. Non-negotiable.

The gateway is reachable **only** from the Next.js server runtime (Route Handlers / Server
Actions / the worker). Never from the browser.

* `AI_BASE_URL` / `AI_API_KEY` must **never** carry the `NEXT_PUBLIC_` prefix. Anything so
  prefixed is inlined into the client bundle at build time.
* Enforce mechanically, not by review, using the layering already in the house stack
  (dependency-cruiser + eslint): the AI adapter module is importable only by the application
  layer, and `src/app/**` may not import it directly. This matches the existing rule that
  `src/app` is transport/composition only.

*Rejected alternative:* a thin browser→gateway proxy for streaming UX. **Why rejected:** it puts
a token-spending endpoint on the public internet. If streaming to the browser is later required,
stream **from our own Route Handler**, which re-authenticates the session, enforces the per-user
budget, and holds the key server-side. **What would change this:** nothing short of the gateway
gaining per-user scoped tokens — and even then the budget must stay ours.

### F.1a Redirects are an exfiltration path, not a convenience *(added on review)*

Everything in F.1, F.2 and F.7 guards the URL **we configure**. None of it guards the URL we
**end up talking to**. `fetch` follows redirects by default (`redirect: "follow"`), so a single
302 from the gateway would send document text to an arbitrary host with every one of our
controls reporting green.

```ts
const res = await fetch(url, {
  method: 'POST',
  redirect: 'error',        // NON-NEGOTIABLE. A redirecting AI gateway is a security event.
  cache: 'no-store',
  // ...
});
```

`redirect: 'error'` makes `fetch` reject rather than follow. Treat the rejection as a
**circuit-breaker-tripping, page-the-owner** condition, not a retryable error: a gateway that
suddenly redirects is either misconfigured or compromised, and retrying is the wrong response to
both. The probe scripts enforce the same rule (§4, safety contract #7) so the behaviour is
identical at diagnosis time and at run time.

*Rejected alternative:* `redirect: 'manual'` plus a same-origin allowlist check. **Why
rejected:** it invites someone to later add "just this one trusted redirect", which is how the
guarantee erodes. There is no legitimate reason for our own inference gateway to redirect a
POST. **What would change this:** the gateway moving behind an authenticating proxy that issues
a 307 to a signed URL — at which point the allowlist becomes explicit config, reviewed, not a
default.

### F.2 Environment contract (Zod 4.4.3, at the boundary)

```ts
// src/infrastructure/ai/ai-env.ts
import { z } from 'zod';

/**
 * SINGLE SOURCE OF TRUTH for the public-provider refusal.
 *
 * Fixed on review: an earlier draft listed 8 hosts here while the probe
 * scripts refused 22, and the prose claimed "the same public-provider refusal
 * lives in the app". It did not. x.ai, together, cohere, perplexity,
 * fireworks, replicate, huggingface and Azure OpenAI were all refused by the
 * diagnostic tool and accepted by the application -- the exact inversion of
 * where the guarantee matters. Keep this list and
 * docs/m0/discovery/probe_ai_gateway.py:PUBLIC_PROVIDER_SUFFIXES identical;
 * a unit test asserts it (see below).
 */
export const PUBLIC_PROVIDER_SUFFIXES = [
  'openai.com', 'openai.azure.com', 'anthropic.com',
  'googleapis.com', 'generativelanguage.googleapis.com',
  'aliyuncs.com', 'dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com',
  'x.ai', 'groq.com', 'mistral.ai', 'cohere.ai', 'cohere.com',
  'together.ai', 'together.xyz', 'openrouter.ai', 'deepseek.com',
  'perplexity.ai', 'fireworks.ai', 'replicate.com', 'huggingface.co',
  'bedrock-runtime.us-east-1.amazonaws.com',
] as const;
// NOTE: amazonaws.com is deliberately NOT blanket-blocked -- INNOVERA runs its
// own Lightsail hosts. Only the Bedrock runtime endpoint is refused.

const isPublicProvider = (hostname: string) => {
  const h = hostname.toLowerCase();
  return PUBLIC_PROVIDER_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`));
};

/** Parse defensively: a malformed URL must produce a Zod issue, not a TypeError. */
const hostnameOf = (u: string): string | null => {
  try { return new URL(u).hostname; } catch { return null; }
};

export const aiEnvSchema = z.object({
  // z.url() (not z.httpUrl()) is deliberate: z.httpUrl() enforces
  // z.regexes.domain on the hostname, which REJECTS "http://10.20.30.40:4000"
  // and "http://litellm.internal:4000" -- i.e. exactly the private-gateway
  // shapes this product needs. z.url() delegates to `new URL()` and accepts
  // IP literals and single-label hosts.
  AI_BASE_URL: z.url({ protocol: /^https?$/ })
    .refine((u) => hostnameOf(u) !== null, 'AI_BASE_URL is not a parseable URL')
    .refine((u) => { const h = hostnameOf(u); return h !== null && !isPublicProvider(h); },
      'INNOVERA policy: public model providers are forbidden. Use the private gateway.')
    // Plaintext HTTP is allowed ONLY with an explicit, auditable opt-in. OCR
    // inputs are Thai ID cards, invoices and contracts; shipping them over
    // cleartext because a dev typed http:// once is not an acceptable default.
    .refine((u) => u.startsWith('https://') || process.env.AI_ALLOW_INSECURE_HTTP === 'true',
      'AI_BASE_URL is plaintext http://. Set AI_ALLOW_INSECURE_HTTP=true to accept this ' +
      'on a trusted private network, and record why in the deployment runbook.'),
  AI_API_KEY: z.string().min(20),
  AI_MODEL_TEXT: z.string().min(1),
  AI_MODEL_VISION: z.string().min(1).optional(),   // absent => text-only branch (§6)
  AI_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
  AI_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(4).default(3),
  AI_MAX_INPUT_TOKENS: z.coerce.number().int().positive().default(32_768), // UNVERIFIED (§3.i)
  // Measured by probe rung d2. Placeholder until then -- see §5.6.
  AI_THAI_CHARS_PER_TOKEN: z.coerce.number().positive().max(10).default(1.0), // UNVERIFIED
  AI_DOC_DEADLINE_MS: z.coerce.number().int().min(5_000).max(900_000).default(180_000),
  AI_MAX_CALLS_PER_DOCUMENT: z.coerce.number().int().min(1).max(64).default(8),
});

export type AiEnv = z.infer<typeof aiEnvSchema>;
```

The **same public-provider refusal lives in the app**, not only in the probe — and now it
demonstrably is the same list. A misconfigured `.env` in staging must fail at boot, loudly,
rather than quietly shipping documents to a public API. Parse once at startup and fail fast.

**Required test (this is the guarantee, not the list):**

```ts
// src/infrastructure/ai/ai-env.test.ts
it('app refusal list matches the probe tool refusal list', async () => {
  const py = await readFile('docs/m0/discovery/probe_ai_gateway.py', 'utf8');
  const inPy = [...py.matchAll(/^\s{4}"([a-z0-9.\-]+)",$/gm)].map((m) => m[1]);
  expect(new Set(inPy)).toEqual(new Set(PUBLIC_PROVIDER_SUFFIXES));
});

it.each(['https://api.openai.com/v1', 'https://dashscope-intl.aliyuncs.com/v1'])(
  'rejects %s', (u) => expect(aiEnvSchema.shape.AI_BASE_URL.safeParse(u).success).toBe(false));

it.each(['https://litellm.internal:4000/v1', 'https://10.20.30.40:4000/v1'])(
  'accepts private %s', (u) => expect(aiEnvSchema.shape.AI_BASE_URL.safeParse(u).success).toBe(true));
```

*Rejected alternative:* a regex over the whole URL rather than the parsed hostname. **Why
rejected:** `https://evil.example/?x=api.openai.com` matches a naive URL regex, and
`https://api.openai.com.evil.example/` defeats a naive suffix test on the string. Parsing to a
hostname and comparing whole labels (`h === s || h.endsWith('.' + s)`) is the only form that
resists both. **What would change this:** nothing; this is the correct shape.

### F.3 Port / adapter

Matching the house modular-monolith style (domain declares the port; infrastructure implements it):

```ts
// src/modules/ocr/application/ports/llm-gateway.port.ts
// Domain-facing. Imports no Next/React/Prisma/fetch.
export interface LlmGatewayPort {
  extractFromText(input: {
    text: string;
    schema: unknown;          // JSON Schema
    requestId: string;
    budget: TokenBudget;
  }): Promise<LlmResult>;

  /** Present ONLY when capability probe returned vision_verdict === 'vision'. */
  extractFromImage?(input: {
    imagePng: Uint8Array;     // a CROP, never a whole document (§6)
    hintText: string;
    schema: unknown;
    requestId: string;
    budget: TokenBudget;
  }): Promise<LlmResult>;
}

export type LlmResult =
  | { ok: true; data: unknown; usage: { promptTokens: number; completionTokens: number } }
  | { ok: false; reason: 'timeout' | 'rate_limited' | 'circuit_open' | 'budget_exceeded'
                       | 'invalid_output' | 'upstream_error' };
```

`extractFromImage` being **optional on the interface** is the type-level encoding of the unknown:
call sites must handle its absence, so the text-only branch is not an afterthought.

### F.4 Timeouts, retries, jitter

```ts
// src/infrastructure/ai/litellm-gateway.adapter.ts  (excerpt)

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

// Every helper the earlier draft referenced but never defined, so this
// compiles as written rather than as an aspiration.
export class NonRetryableUpstreamError extends Error {
  constructor(readonly status: number, readonly bodyExcerpt: string) {
    super(`upstream ${status}`);
  }
}
export class RetryableUpstreamError extends Error {
  constructor(readonly status: number) { super(`upstream ${status} (retryable)`); }
}
export class RedirectRefusedError extends Error {}          // §5.1a
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Read at most 2 KB of an error body, never the whole thing, never logged raw. */
async function safeBody(res: Response): Promise<string> {
  try { return (await res.text()).slice(0, 2_048); } catch { return '<unreadable>'; }
}

/**
 * Retry-After, bounded.
 *
 * Fixed on review: the earlier draft did `await sleep(ra * 1000)` with no cap.
 * A gateway sending `Retry-After: 86400` -- by misconfiguration or malice --
 * would have parked a worker for a day, holding its queue slot, its DB
 * connection and its document lock. Never let a remote party choose how long
 * you block.
 *
 * Also: RFC 9110 allows Retry-After to be an HTTP-date, not only
 * delta-seconds. Number("Wed, 09 Sep 2026 ...") is NaN, which the earlier
 * draft happened to survive by falling through to backoff -- by luck, not
 * design. Both forms are parsed explicitly here.
 *
 * LiteLLM specificity (cited): LiteLLM sets `retry-after` on ITS OWN rate
 * limits and cooldowns, but does not forward the upstream provider's -- that
 * arrives as `llm_provider-retry-after` (BerriAI/litellm#21553). Read both.
 */
const RETRY_AFTER_CAP_MS = 20_000;
function retryAfterMs(res: Response): number | null {
  const raw = res.headers.get('retry-after') ?? res.headers.get('llm_provider-retry-after');
  if (!raw) return null;
  const secs = Number(raw);
  const ms = Number.isFinite(secs)
    ? secs * 1_000
    : (() => { const t = Date.parse(raw); return Number.isNaN(t) ? NaN : t - Date.now(); })();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.min(ms, RETRY_AFTER_CAP_MS);
}

async function callWithPolicy(
  url: string, body: unknown, env: AiEnv, requestId: string, budget: TokenBudget,
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= env.AI_MAX_ATTEMPTS; attempt++) {
    // The per-document deadline outranks the per-call retry count. Without
    // this check the worst case is AI_MAX_ATTEMPTS x AI_TIMEOUT_MS plus
    // backoff PER CALL, times maxCallsPerDocument -- roughly 13 minutes for
    // the defaults, which silently contradicts F.6's deadlineAt.
    if (Date.now() >= budget.deadlineAt) throw new RetryableUpstreamError(408);
    const remaining = budget.deadlineAt - Date.now();
    const timeoutMs = Math.max(1_000, Math.min(env.AI_TIMEOUT_MS, remaining));

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${env.AI_API_KEY}`,
          'x-request-id': requestId,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),   // Node 17.3+; pinned Node is 22.23.1
        redirect: 'error',                        // §5.1a -- NON-NEGOTIABLE
        cache: 'no-store',
      });

      // 4xx (except the retryable set) are OUR bug. Retrying wastes budget and
      // multiplies a malformed request. Fail immediately.
      if (!res.ok && !RETRYABLE_STATUS.has(res.status)) {
        throw new NonRetryableUpstreamError(res.status, await safeBody(res));
      }
      if (res.ok) return res;

      lastErr = new RetryableUpstreamError(res.status);
      if (attempt >= env.AI_MAX_ATTEMPTS) break;
      const wait = retryAfterMs(res) ?? backoffMs(attempt);
      // Never sleep past the deadline; fail now instead of waking up too late.
      if (Date.now() + wait >= budget.deadlineAt) break;
      await sleep(wait);
    } catch (e) {
      if (e instanceof NonRetryableUpstreamError) throw e;
      // A redirect is a security event, not a transient fault. Do not retry it.
      if (e instanceof TypeError && /redirect/i.test(String(e.message))) {
        throw new RedirectRefusedError(`gateway attempted a redirect from ${url}`);
      }
      lastErr = e;                                  // timeout / socket error
      if (attempt >= env.AI_MAX_ATTEMPTS) break;
      const wait = backoffMs(attempt);
      if (Date.now() + wait >= budget.deadlineAt) break;
      await sleep(wait);
    }
  }
  throw lastErr;
}

/** Full jitter (AWS). Prevents the thundering herd a fixed backoff creates. */
function backoffMs(attempt: number): number {
  const cap = 8_000;
  const expo = Math.min(cap, 500 * 2 ** (attempt - 1)); // 500, 1000, 2000...
  return Math.random() * expo;
}
```

**Retry only on 429 + 5xx + timeout. Never on other 4xx.** A 400 means our body is malformed and
a 401 means our key is wrong; retrying either just triples the damage. **Full jitter** rather than
fixed or equal-jitter backoff because a single GPU behind the gateway is exactly the shared
bottleneck that synchronised retries collapse.

### F.4a The port never throws — the boundary that converts *(added on review)*

F.3 declares `Promise<LlmResult>` with an `{ ok: false, reason }` arm. F.4 as originally written
`throw`s. Both cannot be the contract, and an unhandled throw in a worker is how a document gets
stuck rather than degraded. `callWithPolicy` is an **internal** helper that throws; the adapter
method is the **boundary** that converts:

```ts
async extractFromText(input): Promise<LlmResult> {
  if (this.breaker.isOpen()) return { ok: false, reason: 'circuit_open' };
  if (!this.budget.admit(input)) return { ok: false, reason: 'budget_exceeded' };
  try {
    const res = await callWithPolicy(this.url, buildBody(input), this.env,
                                     input.requestId, input.budget);
    const parsed = this.schema.safeParse(await extractJson(res));   // Zod at the boundary
    if (!parsed.success) { this.breaker.onSuccess(); return { ok: false, reason: 'invalid_output' }; }
    this.breaker.onSuccess();
    return { ok: true, data: parsed.data, usage: readUsage(res) };
  } catch (e) {
    if (e instanceof RedirectRefusedError) { this.breaker.trip(); throw e; }  // security: escalate
    this.breaker.onFailure(e);
    return { ok: false, reason: classify(e) };   // timeout | rate_limited | upstream_error
  }
}
```

**`RedirectRefusedError` is the one deliberate exception to never-throw.** Everything else
degrades to §6's deterministic-OCR-only path; a redirecting gateway must wake a human.
Note also that `invalid_output` calls `onSuccess()`: the gateway answered correctly and *our*
schema did not match. Counting that as a breaker failure would let one bad prompt disable the
whole integration — see F.5.

*Rejected alternative:* `p-retry` / `cockatiel`. **Why rejected:** ~40 lines of policy is not worth
a dependency in a security-sensitive path where I want to read every branch. **What would change
this:** needing bulkheads and hedged requests too — then adopt `cockatiel` wholesale rather than
grow this by hand.

### F.5 Circuit breaker

Per `(model, endpoint)`, in-process:

| Parameter | Value | Reasoning |
|---|---|---|
| Failure threshold | 5 consecutive, or >50% over a 20-request window | Survives one-off blips; trips on a real outage. |
| Open duration | 30 s | Longer than a vLLM model reload stall, short enough to self-heal. |
| Half-open | 1 trial request | One probe; success closes, failure re-opens. |
| Counts as failure | timeout, 5xx, circuit-open | — |
| Does **not** count | 400, 401, 422, `invalid_output` | Our bug — must not disable the whole integration. |

The table above is the specification; here is the implementation, because "5 consecutive **or**
>50% over a 20-request window" leaves two questions the table cannot answer — which condition
wins, and how the window is maintained:

```ts
// src/infrastructure/ai/circuit-breaker.ts
type State = 'closed' | 'open' | 'half-open';

export class CircuitBreaker {
  private state: State = 'closed';
  private consecutiveFailures = 0;
  private window: boolean[] = [];          // true = failure. Ring, newest last.
  private openedAt = 0;
  private halfOpenInFlight = false;

  constructor(private readonly opts = {
    consecutiveThreshold: 5,
    windowSize: 20,
    windowFailureRatio: 0.5,
    windowMinSamples: 10,                  // do not trip on 3-of-4; too noisy
    openMs: 30_000,
  }) {}

  /** Either condition trips it -- consecutive is the fast path, ratio the slow one. */
  private shouldTrip(): boolean {
    if (this.consecutiveFailures >= this.opts.consecutiveThreshold) return true;
    if (this.window.length < this.opts.windowMinSamples) return false;
    const failures = this.window.filter(Boolean).length;
    return failures / this.window.length > this.opts.windowFailureRatio;
  }

  private push(failed: boolean) {
    this.window.push(failed);
    if (this.window.length > this.opts.windowSize) this.window.shift();
  }

  isOpen(): boolean {
    if (this.state === 'open' && Date.now() - this.openedAt >= this.opts.openMs) {
      this.state = 'half-open';
      this.halfOpenInFlight = false;
    }
    if (this.state === 'half-open') {
      // Exactly ONE trial request passes. Everything else is refused, or a
      // burst of queued work would hammer a recovering GPU on reopen.
      if (this.halfOpenInFlight) return true;
      this.halfOpenInFlight = true;
      return false;
    }
    return this.state === 'open';
  }

  onSuccess() {
    this.consecutiveFailures = 0;
    this.push(false);
    this.state = 'closed';
    this.halfOpenInFlight = false;
  }

  /** Only counts faults that indicate the GATEWAY is unwell. */
  onFailure(e: unknown) {
    if (!countsAsFailure(e)) return;       // our bug -> not the breaker's business
    this.consecutiveFailures++;
    this.push(true);
    if (this.state === 'half-open' || this.shouldTrip()) this.trip();
  }

  trip() { this.state = 'open'; this.openedAt = Date.now(); this.halfOpenInFlight = false; }
}

const countsAsFailure = (e: unknown): boolean =>
  e instanceof RetryableUpstreamError ||          // 429 / 5xx / 408
  (e instanceof DOMException && e.name === 'TimeoutError') ||
  (e instanceof TypeError);                        // socket / DNS / TLS
// NOT counted: NonRetryableUpstreamError (400/401/422) and invalid_output --
// those are OUR bug and must never disable the whole integration.
```

When open, `extractFrom*` returns `{ ok:false, reason:'circuit_open' }` **immediately**. The
caller degrades to deterministic-OCR-only output (§6) — it never blocks and never falls back to a
public model.

*Note:* in-process state means N instances hold N breakers. Acceptable at M1 scale (single app
instance + worker). **What would change this:** horizontal scaling past ~3 instances — then move
breaker state to Redis alongside the queue.

*Rejected alternative:* count `invalid_output` as a breaker failure. **Why rejected:** it
couples *our* prompt/schema quality to *the gateway's* availability. One bad extraction schema
shipped on a Friday would open the circuit for every document type, including the ones that
work. **What would change this:** nothing — but do alert on a sustained `invalid_output` rate
separately, because it is a real signal about a different subsystem.

### F.6 Per-request budget

Enforced **before** the call, so a pathological 300-page PDF cannot melt the GPU:

```ts
export interface TokenBudget {
  maxInputTokens: number;   // min(AI_MAX_INPUT_TOKENS, probed max_input_tokens) - safetyMargin
  maxOutputTokens: number;  // hard cap, always sent as max_tokens
  maxCallsPerDocument: number;
  deadlineAt: number;       // epoch ms; the whole document, not one call
}
```

Estimate input tokens **before** sending; chunk or reject rather than discover the limit by
429/400. The earlier draft said this and then gave only a bare number, which is the thing that
gets copied wrong. Here is the estimator, and the correction to the number:

```ts
// src/infrastructure/ai/token-estimate.ts

/**
 * Character-class-aware token estimate.
 *
 * CORRECTED ON REVIEW. The earlier draft said "1 token ~= 2.2 Thai
 * characters", which is a claim that Thai is CHEAPER per token than English
 * (English is roughly 4 chars/token). That is backwards, and it is backwards
 * in the dangerous direction: it would have UNDER-estimated Thai token cost
 * by ~2x and produced exactly the silent truncation the same paragraph warns
 * about.
 *
 * Direction of the real effect: Thai is unsegmented (no spaces between
 * words), so BPE vocabularies trained mostly on spaced scripts fragment it
 * heavily -- frequently to roughly one token per character or worse, i.e.
 * ~1.0 chars/token against English's ~4.0. Treat Thai as ~4x more expensive
 * per character than English until measured.
 *
 * The exact ratio is MODEL-SPECIFIC and UNVERIFIED. It is measured by probe
 * rung d2 (capabilities.tokenizer.th_chars_per_token) and injected via
 * AI_THAI_CHARS_PER_TOKEN. Do not hardcode it.
 */
const EN_CHARS_PER_TOKEN = 4.0;      // conventional English rule of thumb

export function estimateTokens(text: string, thaiCharsPerToken: number): number {
  let thai = 0, other = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    // U+0E00..U+0E7F is the Thai block: consonants, vowels, tone marks and
    // the Thai digits U+0E50..U+0E59. Counting the whole block is correct --
    // combining marks cost tokens too.
    if (cp >= 0x0e00 && cp <= 0x0e7f) thai++;
    else other++;
  }
  return Math.ceil(thai / thaiCharsPerToken + other / EN_CHARS_PER_TOKEN);
}

/** Always leave headroom: the estimate is an estimate, and the template costs tokens. */
const SAFETY_MARGIN = 0.15;                    // 15%
const TEMPLATE_OVERHEAD_TOKENS = 256;          // chat template + system + schema

export function admits(text: string, budget: TokenBudget, thaiCpt: number): boolean {
  const est = estimateTokens(text, thaiCpt) + TEMPLATE_OVERHEAD_TOKENS;
  return est <= budget.maxInputTokens * (1 - SAFETY_MARGIN);
}
```

**Normalise to NFC before you count, hash, or store.** `estimateTokens` iterates codepoints, and
NFD Thai has *more* codepoints than NFC Thai for the same visible text (SARA AM alone splits into
two). Counting an NFD string against a limit calibrated on NFC silently changes the answer.
Normalise once, at ingest, and never again.

* `maxCallsPerDocument` (suggest **8**, `AI_MAX_CALLS_PER_DOCUMENT`) bounds the blast radius of a
  retry loop.
* `deadlineAt` is checked between chunks **and inside the retry loop** (F.4) so a slow document
  fails as a whole rather than occupying a worker indefinitely. Worst case is now bounded by
  `AI_DOC_DEADLINE_MS`, not by `attempts × timeout × calls`.
* **Chunk on Thai-safe boundaries.** Never split inside a grapheme cluster: a Thai base
  consonant separated from its tone mark is not the same text, and truncating mid-cluster can
  change a word rather than shorten it. Split on `Intl.Segmenter('th', {granularity:'word'})`
  where available, falling back to `{granularity:'grapheme'}` — never on a UTF-16 code-unit
  index, and never on `String.prototype.slice` over a character count.

### F.7 Never fall back to a public model

No code path may substitute a public provider on failure. The Zod refusal (F.2) plus the probe
refusal (§4) enforce this at both boot and diagnosis time. Failure degrades to
**deterministic OCR output without AI enrichment** — a strictly smaller result, never a result
computed somewhere else. This is a data-residency guarantee, not a preference: OCR inputs are
customer documents (Thai ID cards, invoices, contracts).

### F.8 Redacted logging

* **Never log:** `AI_API_KEY` (mask to 6 chars), full document text, base64 images, raw model
  output containing extracted PII.
* **Do log:** `requestId`, model, latency, HTTP status, `usage.*`, attempt count, breaker state,
  content **lengths** and SHA-256 **hashes** — enough to debug without reproducing the document.
* Redact `authorization` in any error serialiser before it reaches Sentry/stdout. Verify with a
  test that asserts the key never appears in a serialised error.

The earlier draft stopped at that instruction. Here is the redactor, because "redact the key"
is the kind of rule that gets satisfied in one code path and forgotten in three:

```ts
// src/infrastructure/ai/redact.ts
const SECRET_KEYS = /^(authorization|x-api-key|ai_api_key|api_?key|cookie|set-cookie)$/i;
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._\-]{8,}/gi;
const SK = /\bsk-[A-Za-z0-9._\-]{8,}/g;
const DATA_URI = /data:[a-z/+.\-]+;base64,[A-Za-z0-9+/=]{32,}/gi;

export const maskKey = (k: string) =>
  k.length <= 6 ? '***' : `${k.slice(0, 6)}...****(len=${k.length})`;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '<depth>';
  if (typeof value === 'string') {
    return value.replace(BEARER, '$1<redacted>')
                .replace(SK, '<redacted>')
                .replace(DATA_URI, '<data-uri:redacted>');
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) =>
      [k, SECRET_KEYS.test(k) ? '<redacted>' : redact(v, depth + 1)]));
  }
  return value;
}
```

**Required test — the guarantee, not the regex:**

```ts
it('never serialises the key, from any error shape', async () => {
  const key = 'sk-test-0123456789abcdefghij';
  const shapes = [
    new Error(`failed with Authorization: Bearer ${key}`),
    { headers: { authorization: `Bearer ${key}` }, cause: { 'x-api-key': key } },
    { config: { headers: [['Authorization', `Bearer ${key}`]] } },     // array-of-pairs form
  ];
  for (const s of shapes) expect(JSON.stringify(redact(s))).not.toContain(key);
});
```

**Thai-specific logging hazards** *(added on review)*:

* **Hash after NFC normalisation.** `sha256(text)` over an NFD string differs from the same
  visible Thai in NFC. If ingest hashes raw bytes and the worker hashes normalised text, dedup
  silently stops working and every "same document" audit trail breaks. Normalise, then hash, and
  say so at the call site.
* **Do not log "first 100 characters" of a document as a preview.** For Thai that is roughly 100
  tokens of real content — and for an ID card, 100 characters is the whole card. Log lengths and
  hashes. If a preview is genuinely needed for debugging, log a character-class histogram
  (`{thai: 412, latin: 30, digit: 13}`), which is diagnostic and carries no PII.
* **Thai filenames are NFD on macOS and usually NFC on Linux.** Log the normalised form and the
  hash, never the raw filename as a correlation key across environments.

---

## 6. Decision table — text-only Qwen vs vision Qwen

**The deterministic OCR engine is PRIMARY in both branches. It is the OCR of record. The LLM
never produces the authoritative text.** This holds regardless of the probe result and is the
single most important line in this document: it means M1 can be built and shipped **before** the
probe ever runs.

| Dimension | Branch A — **text-only Qwen** | Branch B — **vision-capable Qwen** |
|---|---|---|
| Who produces text | OCR engine, 100% | OCR engine, 100% |
| What the LLM receives | **Text + layout coordinates only.** No pixels ever leave the OCR stage. | Text + layout, **plus small cropped regions** for targeted re-reads. Never the full page. |
| Field extraction | LLM structures OCR text → JSON schema | Same |
| Low-confidence regions | Flag for **human review** | Optional **VLM re-read of that crop**; accept only if it agrees with the engine or clears a confidence bar, else flag for human review |
| Table / layout reconstruction | Geometric heuristics over OCR boxes | Geometric heuristics, **with** optional VLM assist on failure |
| Handwriting / stamps / signatures | Out of scope — flag | Best-effort VLM description, **advisory only**, never authoritative |
| Rotated / skewed pages | Deterministic deskew (engine) | Same; VLM only as a fallback classifier |
| Data egress surface | Text only — **smallest** | Text + image crops — **larger; needs explicit sign-off** |
| Token budget | Text only; cheapest | Images cost far more; enforce `maxCallsPerDocument` strictly |
| `LlmGatewayPort` | `extractFromText` only; `extractFromImage` **undefined** | Both implemented |
| Config signal | `AI_MODEL_VISION` unset | `AI_MODEL_VISION` set |
| Accuracy ceiling on clean Thai docs | Essentially the same as B | Marginal gain |
| Accuracy on degraded scans | Lower — more human review | Higher — fewer escalations |
| **Thai round trip (rung d2)** | **Gate for BOTH branches.** `MANGLED`/`NO_THAI_RETURNED` ⇒ neither branch is available; the LLM layer is off entirely and OCR ships alone. | Same gate, and additionally: vision without verified Thai *reading* buys nothing here (see flip conditions). |
| **Thai numerals (U+0E50–59)** | Normalise Thai↔ASCII digits in **our** code before and after the LLM; never rely on the model. | Same, plus: a VLM crop re-read may return either digit set — normalise both sides before the agreement check, or every match will fail. |
| **Unicode normalisation** | NFC at ingest; hash/compare/count only on NFC. | Same. The crop path adds no new normalisation surface. |
| Structured output | `json_schema` if probed-honored, else prompt-coaxed JSON + Zod + one repair retry. **Build the fallback either way** (§3.f). | Same |

**Why the engine stays primary in Branch B.** A VLM is a *probabilistic* reader that fails
**silently and fluently** — it will confidently hallucinate a plausible Thai national-ID number.
A deterministic engine fails *visibly*, with a low confidence score you can route to a human.
For ID numbers, invoice totals, and dates, a visible failure is enormously more valuable than a
fluent wrong answer. The VLM is therefore only ever allowed to **agree, or escalate** — never to
overwrite.

### What is shared (build this now, before the probe)

Everything except the optional `extractFromImage` path: the OCR engine, layout model, confidence
scoring, the human-review queue, `LlmGatewayPort`, the adapter, retry/breaker/budget policy, and
the Zod-validated extraction schema. **Branch selection changes one optional method and one env
var.** That is the whole point of the port shape in F.3.

### What would flip the decision

* Probe returns `vision` **and** the manual Thai-crop check (§3.e, "manual e3") shows the model
  actually reads Thai script **and** measured crop-level accuracy on a Thai validation set beats
  the engine on the low-confidence subset → enable Branch B's re-read. **All three, in order.**
* Probe returns `vision` but the model cannot read Thai script reliably → stay on Branch A even
  though vision exists. **Vision capability is necessary but not sufficient.** The synthetic
  ASCII-digit probe in rung **e2** cannot answer this; only the manual Thai crop can.
* Probe returns `text_only` → Branch A, and revisit only if the gateway later adds a VL model.
* Probe returns `ambiguous` → **stay on Branch A and retest.** Ambiguous is not a branch. Shipping
  Branch B on an ambiguous verdict means shipping an image-egress surface (§6, "Data egress")
  that may not even work.
* Rung **d2** fails → **neither branch.** Ship deterministic OCR with no LLM enrichment and treat
  the gateway as unavailable until the Thai path is fixed. This outranks every other flip
  condition: a gateway that cannot carry Thai losslessly is not a gateway this product can use,
  regardless of what else it can do.

### The reversal trigger for the whole decision

The engine-primary rule (top of §6) is the one decision here with **no** reversal trigger, and
that is deliberate. State it explicitly so nobody relitigates it in a later phase:

> **No probe result flips it.** Even `vision_verdict: "vision"` with perfect Thai reading and
> better-than-engine accuracy does not promote the LLM to OCR-of-record, because the failure
> *mode* is what disqualifies it, not the failure *rate*. A VLM that is 99% accurate fails the
> remaining 1% fluently and unmarked; a deterministic engine that is 95% accurate marks its own
> 5%. For a Thai national-ID number, a marked failure is routable to a human and an unmarked one
> is a wrong record in a customer's system.
>
> **What would change it:** a VLM that emits calibrated per-field confidence which we have
> independently validated against a held-out Thai set — i.e. the property the engine has and the
> VLM does not. Not a better accuracy number.

---

## 7. Open questions for the gateway owner

Ordered by how much architecture each unblocks:

Trimmed on review: three of the original seven are now answered by the probe itself and should
not consume a human's attention. **Ask only what the gateway cannot tell us.**

1. **`AI_BASE_URL` and a scoped `AI_API_KEY`** (read-only / low-quota if LiteLLM virtual keys are
   in use). Blocks everything. There is no way to derive this.
2. **Is there a VL model in the pool, and is it *for us*?** — `/v1/models` lists what exists;
   only a human can say whether we are permitted to use it and whether it shares a GPU with
   something latency-sensitive.
3. **vLLM `--max-model-len`** — the one number I refuse to discover by brute force (§3.i).
   *Only ask if rungs **c** and **b** both returned null.*
4. **vLLM version** — brackets structured-output support at both ends (§3.f). *The **LiteLLM**
   version is no longer a question: rung **a3** and the `x-litellm-version` header answer it.*
5. **Was `model_info` hand-configured in the LiteLLM config?** — decides whether rung **c** is
   informative at all (§1). Cheap for the operator to answer, expensive for us to infer.
6. **Rate limits / quota per key**, and whether a burst from the OCR worker will affect other
   INNOVERA consumers of the same GPU. *Partially self-answering now — the probe harvests
   `x-ratelimit-*` headers (§3, "Free facts"). Ask only for what the headers do not show:
   whether we share the GPU, and with whom.* Drives `maxCallsPerDocument` and breaker thresholds.
7. **Is TLS a self-signed cert, and where is the CA?** — both scripts have `--insecure` for
   diagnosis; the app must not. We need the CA bundle, or a proper certificate.
8. **Is the gateway plaintext `http://`?** *(new)* — if so, §5.2 requires an explicit
   `AI_ALLOW_INSECURE_HTTP=true` and a written justification, because the payload is Thai ID
   cards and contracts. Confirm the network path is genuinely private before accepting it.
9. **Is there a staging/non-production gateway?** *(new)* — the probe is safe, but it is still
   the first traffic we will ever send. Running it against staging first costs nothing and is
   the difference between a diagnostic and a surprise.

---

## 8. Claims I could not verify

* **UNVERIFIED:** every capability answer for item E — no endpoint or credential existed this
  session. All §6 branches are conditional by construction.
* **UNVERIFIED:** exact LiteLLM error strings for a text-only model receiving `image_url`. The
  rung-**e** matcher uses a substring set over several plausible phrasings plus the `NO_IMAGE`
  escape hatch; if the real gateway says something else the verdict degrades to `ambiguous`
  (safe) rather than a wrong `text_only`. Refine after the first real run.
* **UNVERIFIED:** that `max_model_len` survives LiteLLM's `/v1/models` proxying. Read
  opportunistically, never depended on.
* **UNVERIFIED:** vLLM ≥ 0.8.5 for `response_format: json_schema`. The version *number* comes
  from secondary write-ups of vLLM's structured-outputs docs, not from a changelog entry I read;
  treat it as "old builds probably can't, new builds probably can". Separately **verified** from
  current vLLM docs: the `guided_*` extra-body params are **deprecated** in favour of
  `response_format`/`structured_outputs`, so the fallback is bracketed at both ends (§3.f).
* **CORRECTED, then still UNVERIFIED:** the Thai token ratio. The earlier draft's
  "1 token ≈ 2.2 Thai characters" was **wrong in direction** — it implied Thai is cheaper per
  token than English. Thai is unsegmented and fragments heavily under BPE; assume ~1.0
  chars/token (≈4× English) until measured. The exact figure is model-specific and is now
  measured by rung **d2**, which the earlier ladder did not contain. Still **UNVERIFIED**
  for the INNOVERA model.
* **UNVERIFIED:** whether the INNOVERA gateway carries Thai losslessly, preserves Thai numerals,
  or normalises Unicode in transit. Rung **d2** exists to answer this and has never been run.
* **UNVERIFIED:** whether a vision-capable model in the pool can read **Thai script** as opposed
  to seeing pixels. Rung **e2** deliberately cannot answer this (ASCII-digit bitmap font); the
  manual Thai-crop step in §3.e is required and is not automated.
* **UNVERIFIED:** which LiteLLM builds serve the metadata routes at the root vs under `/v1`, and
  whether `/health/readiness/details` exists on the INNOVERA build. All four/both are probed
  opportunistically; none is depended on.
* **UNVERIFIED:** that `/health/liveliness` is unauthenticated on *this* deployment — LiteLLM
  documents it so, but a reverse proxy may add auth. Rung a failing with 401 is a proxy finding.
* **Not executed:** neither probe script has ever made a network call. Syntax, dry-run, refusal
  guards, exit codes, JSON validity, and socket-freedom were all verified locally (§4); the
  network paths are unexercised.

---

## 9. Sources

Each source is annotated with what it actually establishes, and whether I read it or inferred it.
*(Corrected on review: one link previously pointed at a page that does not contain the claim
attributed to it.)*

* [LiteLLM — Health Checks](https://docs.litellm.ai/docs/proxy/health) — **read.** Establishes
  `/health/liveliness` (+ `/health/liveness` alias) and `/health/readiness` are unauthenticated
  and make no model call; that bare `/health` is authenticated and *"runs a real test request
  against every configured model"*; and that `/health/readiness/details`, `/health/services`
  exist and are authenticated.
* [LiteLLM — Health Endpoints API reference](https://mintlify.wiki/BerriAI/litellm/api/proxy/health)
  — **read.** Establishes the `/health/readiness` payload as
  `{status, db_initialized, router_initialized}`. **This corrects the earlier draft's
  `{"status":"healthy","db":...}`.**
* [LiteLLM — Using Vision Models](https://docs.litellm.ai/docs/completion/vision) — **read.**
  Establishes the OpenAI content-parts request shape, **and** carries the `/model_group/info`
  sample showing `llava-hf` with `supports_vision: true` alongside
  `max_input_tokens: null, max_output_tokens: null, mode: null`. **This is the correct home of
  that example**; the earlier draft attributed it to the model-discovery page.
* [LiteLLM — Model Discovery](https://docs.litellm.ai/docs/proxy/model_discovery) — **read.**
  Documents `/v1/models` only. Retained for the `/v1/models` shape; it does **not** support the
  `/model_group/info` claim previously hung on it.
* [LiteLLM — Model Management](https://docs.litellm.ai/docs/proxy/model_management) — **read.**
  Mentions `GET /model/info` ("full model list with API keys masked"); contains no response
  example.
* [BerriAI/litellm#27830 — auto-populate max_input_tokens for hosted vLLM](https://github.com/BerriAI/litellm/issues/27830)
  — **read. OPEN feature request**, not current behaviour. Establishes that hosted vLLM /
  OpenAI-compatible models "frequently display `max_input_tokens: null`… unless administrators
  manually configure `model_info`".
* [BerriAI/litellm#9297 — supports_vision ignored in config.yaml](https://github.com/BerriAI/litellm/issues/9297)
  — **read. CLOSED as not planned.** Against an **Ollama** backend, not vLLM, and old. Evidence
  that the propagation path is fragile; **not** proof it never works — the vision-doc sample
  above shows it working. Weighted accordingly in §1.
* [BerriAI/litellm#21553 — upstream `retry-after` not forwarded](https://github.com/BerriAI/litellm/issues/21553)
  — **read.** LiteLLM sets `retry-after` on its **own** rate limits/cooldowns; the upstream
  provider's arrives as `llm_provider-retry-after`. Drives §5.4's two-header read.
* [BerriAI/litellm#27748 — `x-ratelimit-*` dropped on streaming](https://github.com/BerriAI/litellm/issues/27748)
  — **read.** SSE headers flush before the post-call hook. Drives the §3 "Free facts" caveat.
* [LiteLLM — Response Headers](https://docs.litellm.ai/docs/proxy/response_headers) — **not read
  in full**; cited as the canonical reference for the harvested header names.
* [vLLM — Structured Outputs](https://docs.vllm.ai/en/latest/features/structured_outputs/) —
  **read via search summaries.** Establishes `response_format: json_schema` support, the
  `--structured-outputs-config.backend` flag with `auto` default, and the **deprecation of
  `guided_*`**. The specific "0.8.5" figure comes from secondary write-ups, not a changelog —
  see §8.
* [vllm-project/vllm#4643 — return max_model_len on /v1/models](https://github.com/vllm-project/vllm/pull/4643)
  — **read. MERGED 2024-06-02.** Title: *"[Frontend][OpenAI] Support for returning max_model_len
  on /v1/models response"*. Whether it survives LiteLLM's proxying is **UNVERIFIED** (§8).
* [Zod — Defining schemas](https://zod.dev/api) — **read.** Establishes `z.url({protocol, hostname})`
  option shapes, and that `z.url()` accepts IP-literal and `localhost` hosts while
  `z.httpUrl()` (= `z.url({protocol:/^https?$/, hostname: z.regexes.domain})`) does **not** —
  which is why §5.2 uses `z.url()` and says so.
* `man curl` (8.7.1, local) — **read.** Exit **63** = "Maximum file size exceeded"; and
  `--max-filesize` "has no effect" on unknown-length transfers **before curl 8.4.0**, aborting
  mid-transfer only from 8.4.0 on. Drives the §3.g version floor.
* Local: `~/.EasyOCR/model/{thai.pth,craft_mlt_25k.pth}`; `~/Documents/jawbong/process/context/all-context.md` (house stack)

---

## Critic Notes

Adversarial completeness review, 2026-09-09. The document was **not** rewritten — the structure,
the probe-ladder concept, the trust rule, the discriminative-digit inversion and the
engine-primary decision all survived scrutiny and are good. What follows is what was **wrong**,
**missing**, or **hand-waved**, and what remains genuinely unknowable in this session.

### A. Factual errors corrected

| # | Error in the draft | Reality | Where |
|---|---|---|---|
| A1 | The `llava-hf` / `/model_group/info` sample was cited to `docs/proxy/model_discovery`. | That page documents **only `/v1/models`** and contains no such example. The sample is on the **vision** page — and it shows `supports_vision: **true**` next to the null token limits, which is *stronger* evidence for the asymmetric trust rule than the draft realised. | §1 |
| A2 | The §2 verification log's evidence command was `grep … --include='*.md,*.yaml,*.yml,…'`. | `--include` takes **one glob per occurrence**; a comma list matches no filename. The command searched **zero files** and exited 1 — a **false negative**, so the "independently confirmed" claim rested on nothing. Re-run correctly (one `--include` each, plus a control proving files were searched): **the conclusion holds**, but the original evidence did not support it. | §2 |
| A3 | `/health/readiness` "returns `{"status":"healthy","db":…}`". | Documented payload is `{status, db_initialized, router_initialized}`, `status ∈ {ready, not_ready}`, 503 when the DB is unreachable. | §3.a |
| A4 | "1 token ≈ 2.2 Thai characters." | **Backwards, in the dangerous direction.** English is ~4 chars/token; 2.2 would make Thai *cheaper*. Thai is unsegmented and fragments under BPE toward ~1 char/token (≈4× English cost). The draft's own next sentence warned about silent truncation — which this number would have caused. | §5.6 |
| A5 | `#9297` presented as flat proof that `model_info` is ignored. | It is an **Ollama** report, old, closed as not-planned. Fragility evidence, not proof — and the vision-doc sample shows the field working. Re-weighted. | §1 |
| A6 | Bash header claimed "curl 7.x+". | `--max-filesize` has **no effect on unknown-length transfers before curl 8.4.0** (man page, verbatim). The whole "exit 63 proves streaming" inference silently fails on older curl. Requirement corrected, runtime version check added. | §3.g |
| A7 | The brief's `/v1/model/group/info` was carried forward as real. | That path does not exist; the underscore form does, at root **and** under `/v1`. Four paths now probed. | §3.c |
| A8 | vLLM ≥ 0.8.5 for `json_schema` stated with a citation to "vLLM structured-outputs docs". | The version number comes from **secondary write-ups**, not a changelog line I read. Downgraded to "old builds probably can't, new probably can — measure it", and the **opposite** hazard added: current vLLM has **deprecated `guided_*`**, so the draft's implied fallback may not exist on new builds either. | §3.f, §8 |

### B. Gaps against the brief

| # | Gap | Fix |
|---|---|---|
| B1 | **No Thai anywhere in the ladder.** The only text probe was `"Reply with the single word: PONG"`. For a Thai-primary OCR product this is the single largest omission in the document. | New rung **d2**: verbatim Thai echo exercising SARA AM, stacked tone marks, THANTHAKHAT and Thai numerals; NFC-aware comparison; blocker on failure. |
| B2 | **A stated calibration that was impossible.** §5.6 said the Thai ratio "must be recalibrated from rung **d**'s `usage.prompt_tokens`" — but rung **d** sends English. The plan depended on data the ladder never produced. | d2 measures both halves; report now carries `tokenizer.{en,th}_chars_per_token` and `th_penalty_vs_en`, with an in-band caveat that the figure is a **lower bound**. |
| B3 | **`usage` was never captured** by either script, despite two sections depending on it. | Captured on d and d2 and emitted per-probe. |
| B4 | Rung **f** had no "not-supported vs misconfigured" line, which the brief demanded for **every** rung. | Added, with the genuinely useful distinction: 400-naming-`response_format` (capability) vs 400-naming-the-*schema* (xgrammar dialect limits — misconfigured probe) vs 500-with-grammar-trace. |
| B5 | Brief asked for "read 2 chunks, abort". **Python drained the entire stream** via `resp.read()`. | Dedicated `stream_probe()` reads 2 `data:` lines and closes the socket; also inspects `Content-Type` to separate "buffering proxy" from "rejected". |
| B6 | LiteLLM version was an **owner question** while a free endpoint answers it. | New rung **a3** (`/health/readiness/details`) + `x-litellm-version` header harvest. §7 trimmed from 7 questions to what a human must actually supply. |
| B7 | Response headers discarded entirely — `x-ratelimit-*` answers open question #6 for free. | Harvested on every rung, with the cited caveat that they are dropped on streaming responses (litellm#27748). |
| B8 | No leakage check before committing `capability.json`. | Added to the run-book. |

### C. Hand-waving replaced with code

* **F.5 circuit breaker** was a table. "5 consecutive **or** >50% over 20" does not say which wins or how the window is kept. → Full `CircuitBreaker` class, single-trial half-open, `windowMinSamples` so it cannot trip on 3-of-4, explicit `countsAsFailure`.
* **F.6 budget** gave an interface and the prose "estimate input tokens before sending". → `estimateTokens()` with a Thai/non-Thai codepoint split, safety margin, template overhead, and Thai-safe chunk boundaries via `Intl.Segmenter`.
* **F.8 logging** said "verify with a test". → `redact()` plus the test, across three error shapes including array-of-pairs headers.
* **F.4** referenced `safeBody`, `sleep`, `NonRetryableUpstreamError`, `RetryableUpstreamError` — none defined. → All defined; the excerpt now compiles as written.

### D. Real defects found in the scripts

| # | Defect | Severity |
|---|---|---|
| D1 | **The bash emit `jq` program did not parse.** A chain of `… as $x` bindings was missing its final `\|`. It would have crashed **on the `--run` path only, at emit time, after every network probe had already fired** — full cost, zero output. Found by extracting the filter and running it standalone; that test is now documented. | **Critical** |
| D2 | **Python followed redirects.** `urllib` installs `HTTPRedirectHandler` by default, so a 302 would have been chased to any host, silently defeating the public-provider refusal for both the probe and (via the same omission in §5.4's `fetch`) real document text. | **Critical / security** |
| D3 | **`empirical.json_schema` was `bool(status==2xx)`** in Python while the doc claimed both scripts assert the parse and the bash twin correctly stored a verdict string. The one outcome the doc calls *dangerous* — 200 with non-JSON body, constraint silently ignored — was recorded as a clean `true`. | **High** |
| D4 | **The vision 400-matcher included a bare `image` substring.** `"invalid base64 image data"` → confident `text_only` → the entire vision branch of §6 deleted by a malformed probe. Marker set narrowed to modality assertions; malformed-request markers routed to `ambiguous` with an inspect-the-body note. | **High** |
| D5 | **API key on the bash command line** (`-H "Authorization: Bearer $KEY"`), readable via `ps` by any user on the host — and a shared jump box is exactly where this gets run. Moved to a mode-0600 `--config` file in a mode-0700 temp dir. | **Medium / security** |
| D6 | The key was sent to `/health/liveliness` and `/health/readiness`, which are unauthenticated and do not read it — free credential exposure in those access logs. | **Low / security** |
| D7 | `grep -c` prints `0` **and** exits 1, so `$(grep -c … \|\| echo 0)` yielded the string `"0\n0"`, producing garbled chunk counts. | **Low** |
| D8 | Bash dry-run emitted `"capabilities": null`, no `generated_at`, no `blockers`; the unreachable path emitted a **fourth** distinct shape. Anything written against one output broke on the others. All four paths now emit one schema, asserted by diffing `jq -S 'keys'` between the two tools. | **Medium** |
| D9 | `streaming` was set from the status code alone, ignoring whether any `data:` line arrived — so a buffering reverse proxy reported as working streaming. Now requires 2xx **and** ≥1 chunk. | **Medium** |
| D10 | `selected_model` was never recorded when `--model` was passed explicitly. | **Low** |
| D11 | **Unbounded `Retry-After`.** `sleep(ra * 1000)` with no cap: `Retry-After: 86400` parks a worker for a day holding its queue slot, DB connection and document lock. Capped at 20 s, HTTP-date form parsed explicitly, and `llm_provider-retry-after` read as well (litellm#21553). | **High** |
| D12 | **Retry loop ignored the per-document deadline.** `attempts × timeout × backoff × maxCallsPerDocument` ≈ 13 min on the defaults, directly contradicting F.6's `deadlineAt`. Deadline now checked before each attempt and before each sleep. | **High** |
| D13 | **F.3 promised never-throw (`{ok:false, reason}`); F.4 threw.** An unhandled throw in a worker is a stuck document, not a degraded one. F.4a defines the converting boundary — with `RedirectRefusedError` as the one deliberate escalation. | **Medium** |
| D14 | **The app's public-provider list had 8 hosts; the probe's had 22**, while the prose claimed they were "the same refusal". The *diagnostic* was stricter than the *production* path — the exact inversion of where it matters. Unified, with a test asserting parity against the Python source. | **High / security** |

### E. Thai-specific blind spots (beyond B1/B2/A4)

1. **NFC/NFD.** macOS emits NFD; servers usually NFC. SARA AM (U+0E33) decomposes. Raw `==` reports false corruption; raw `sha256` breaks dedup across environments; codepoint counting changes token estimates. Normalise at ingest, then hash/compare/count only on NFC — now stated at every point where it bites (d2, F.6, F.8).
2. **Thai numerals U+0E50–59.** Ubiquitous in Thai document numbers and Buddhist-era dates, and *not* ASCII digits. Three consequences added: d2 counts their survival; §6 requires an explicit normaliser in **our** code in both branches; and the **rung-e2 verdict itself** is fallible here — a Thai-tuned model answering `๔๗` instead of `47` reads as `ambiguous` when it in fact saw the image perfectly.
3. **Vision ≠ Thai reading.** The 5×7 font has `0-9 O C R` only; the stdlib cannot rasterise Thai (needs mark positioning, not just glyph placement). The document now says plainly that e2 proves *seeing*, not *Thai reading*, and specifies a **manual e3** with a real rendered Thai crop as a prerequisite for Branch B.
4. **Chunk boundaries.** Splitting on a character index can separate a base consonant from its tone mark — changing a word rather than shortening it. `Intl.Segmenter` required.
5. **Log previews.** "First 100 characters" is ~100 tokens of Thai and, for an ID card, the whole card. Replaced with a character-class histogram.
6. **Thai filenames** are NFD on macOS, NFC on Linux — never a cross-environment correlation key.

### F. Fabrication check

* `"qwen2.5-vl-7b"` appeared **twice** in the §4 output-schema sample (as `models[0]` and as `selected_model`), with `"vision_verdict": "vision"` beside it. Illustrative, but it is a plausible-looking name in the exact slot a reader skims for the answer. **Replaced with angle-bracketed placeholders**, and a loud banner added above the block and in §Bottom line stating that items **C/D/E remain UNRESOLVED — owner-supplied blocker** and that no model name is known to this repository.
* `32 768` was labelled UNVERIFIED but not *explained*. It is now stated as a placeholder chosen because erring low is safe (extra chunking) and erring high is not (silent truncation of an ID field), with `AI_MAX_INPUT_TOKENS` as the one-line replacement path.
* No other claim about the INNOVERA gateway, model, endpoint, port or capability is asserted anywhere in the document. Re-checked by reading every occurrence of "qwen", "vision", "32768" and every `"status"` sample.

### G. Decisions that lacked a rejected alternative + reversal trigger

Added: **F.1a** redirect policy (rejected `redirect:'manual'` + allowlist), **F.2** hostname
parsing (rejected whole-URL regex, with the two bypasses it permits), **F.5** breaker failure
classification (rejected counting `invalid_output`), and — most importantly — **§6's
engine-primary rule**, which previously had *no* stated reversal trigger. It now says explicitly
that **no probe result flips it**, because the disqualifying property is the failure *mode*
(fluent, unmarked) not the failure *rate*, and names the one thing that would: a VLM emitting
calibrated per-field confidence validated against a held-out Thai set.

### H. What remains genuinely unknowable in this session

* **Everything about the INNOVERA gateway.** Endpoint, port, auth scheme, LiteLLM version, vLLM version, model names, vision, structured output, tools, context window, rate limits, Thai fidelity. Items **C/D/E** are an **owner-supplied blocker**, confirmed by a corrected search (§2). The correct output of this session is the *method*, and that is what §3–§5 are.
* **The exact LiteLLM 400 wording** for a text-only model receiving `image_url`. The narrowed marker set is a best guess; unmatched bodies degrade to `ambiguous` (safe) rather than a wrong `text_only`. Refine after the first real run.
* **Whether `max_model_len` survives LiteLLM's `/v1/models` proxying.** Read opportunistically, never depended on.
* **Which path prefix** (root vs `/v1`) this build serves the metadata routes at, and whether `/health/readiness/details` exists on it. All variants probed; none depended on.
* **The real Thai token ratio for the actual model.** d2 measures it, and its own note says the measurement is a lower bound because the instruction and chat template are counted in. A Thai-only prompt is required for a tight figure.
* **Whether the model can read Thai script from pixels.** Requires the manual e3 crop; not automatable here without a font asset.
* **Neither script has ever made a network call.** Syntax (`py_compile`, `bash -n` on bash 3.2.57), dry-run JSON validity, cross-tool schema parity, refusal guards, exit codes, socket-freedom (Python re-run with `socket.socket` replaced by a raising class — completed normally), and the extracted `jq` emit filter were all verified locally. **Every network path is unexercised.** Treat the first real run as itself an experiment, on staging if one exists (§7.9).
