#!/usr/bin/env bash
# =============================================================================
#  INNOVERA OCR AI -- M0 DIAGNOSTIC TOOLING
#  probe-ai-gateway.sh
#
#  *** THIS IS NOT APPLICATION CODE. ***
#  *** THIS IS NOT PART OF THE ocr-web / ocr-worker RUNTIME. ***
#  *** AS OF THE M0 REPORT DATE THIS SCRIPT HAS NEVER BEEN EXECUTED     ***
#  *** AGAINST A REAL GATEWAY -- NO INNOVERA LiteLLM ENDPOINT OR        ***
#  *** CREDENTIAL WAS AVAILABLE DURING M0.                              ***
#
#  Bash twin of probe_ai_gateway.py, for hosts where you have curl+jq but
#  would rather not run a Python file. The Python version is richer (better
#  verdict reconciliation); prefer it when you have a choice.
#
#  PURPOSE
#    Read-only capability discovery for an OpenAI-compatible LiteLLM gateway
#    fronting a self-hosted vLLM/Qwen deployment. M0 items E and F.
#
#  SAFETY CONTRACT (enforced in code)
#    1. Defaults to dry-run: prints the exact requests it WOULD make and
#       opens no sockets. Requires --run to transmit anything.
#    2. LITELLM_BASE_URL / LITELLM_API_KEY come from the environment. Never
#       hardcoded. (AI_BASE_URL / AI_API_KEY are deprecated fallbacks.)
#    3. The key is never echoed -- masked to the first 6 characters.
#    4. Refuses to run against public providers (no public-model fallback).
#       Pure string check on the hostname; no DNS, no connection.
#    5. Probe images are synthetic, generated in-process. No real document.
#    6. --max-time on every call, --no-keepalive, and NO retries.
#    7. Redirects are NOT followed (-L is never passed). A 3xx is reported as
#       a security finding: following it would send traffic to a host that
#       never passed the public-provider check in #4.
#    8. The API key is passed to curl through a mode-0600 --config file, never
#       on the command line, so it does not appear in `ps` output.
#
#  REQUIREMENTS
#    bash 3.2+ (macOS system bash is 3.2.57 -- this script avoids bash 4
#    features: no associative arrays, no ${x,,}, no mapfile)
#    curl 8.4.0+ for the streaming rung (g). --max-filesize only aborts a
#      transfer of UNKNOWN length (which an SSE stream is) from 8.4.0 onward;
#      on older curl the option silently does nothing and rung g degrades to
#      a full read. The script checks and warns. Everything else works on 7.x.
#      (verified against curl 8.7.1)
#    jq 1.6+    (verified against jq-1.7.1-apple)
#    python3    (used ONLY to render the synthetic probe PNGs; stdlib only)
#
#  USAGE
#    # Preferred names -- they match INNOVERA Chat's production contract, so
#    # one operator configures both apps with one vocabulary (b §E1).
#    export LITELLM_BASE_URL='<literal value from the gateway owner>'
#    export LITELLM_API_KEY='<OCR's own virtual key>'
#
#    # EITHER base-URL convention is accepted. Evidence (b §E2) says the
#    # production value EXCLUDES /v1; a value that already ends in /v1 is
#    # also handled. ROOT and V1 are derived below, so the ladder can never
#    # emit /v1/v1/... nor hit /chat/completions at the server root.
#    # NOTE: application code must NOT copy this tolerance -- b §4.3 requires
#    # the app's env schema to REJECT a trailing /v1 rather than normalise it.
#
#    ./probe-ai-gateway.sh              # dry run
#    ./probe-ai-gateway.sh --run        # actually probe
#    ./probe-ai-gateway.sh --run --model '<alias-from-/v1/models>' > capability.json
#
#  OUTPUT
#    Machine-readable JSON on stdout; human progress on stderr.
#
#  EXIT CODES  0 ok | 2 refused | 3 unreachable
# =============================================================================

set -euo pipefail

SCHEMA_VERSION="1.0"
TOOL_NAME="probe-ai-gateway.sh"

RUN=0
MODEL=""
INSECURE=""
DIGITS=""

T_HEALTH=5
T_INFO=10
T_CHAT=30
T_VISION=45

# Thai round-trip probe. Mandatory for a Thai-primary product: it exercises
# SARA AM (U+0E33, reordered by NFC/NFD), stacked tone marks, THANTHAKHAT
# (U+0E4C) and Thai numerals U+0E50..U+0E59 in one line. An English "PONG"
# proves nothing about any of them, and cannot calibrate the token budget.
THAI_PROBE='เอกสารเลขที่ ๐๑๒/๒๕๖๗ หน้าคำนูณ์'

# --- Public providers we refuse to touch (INNOVERA: no public fallback) -----
# Space-separated because bash 3.2 has no associative arrays.
PUBLIC_SUFFIXES="openai.com openai.azure.com anthropic.com googleapis.com \
generativelanguage.googleapis.com dashscope.aliyuncs.com \
dashscope-intl.aliyuncs.com aliyuncs.com x.ai groq.com mistral.ai cohere.ai \
cohere.com together.ai together.xyz openrouter.ai deepseek.com perplexity.ai \
fireworks.ai replicate.com huggingface.co"

log() { printf '%s\n' "$*" >&2; }

usage() {
  sed -n '2,50p' "$0" >&2
  exit 0
}

refuse() {
  log "REFUSED: $1"
  jq -n --arg v "$SCHEMA_VERSION" --arg t "$TOOL_NAME" --arg r "$1" \
    '{schema_version:$v, probe_tool:$t, status:"refused", reason:$r}'
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --run)      RUN=1 ;;
    --model)    shift; MODEL="${1:-}" ;;
    --digits)   shift; DIGITS="${1:-}" ;;
    --insecure) INSECURE="-k" ;;
    -h|--help)  usage ;;
    *) refuse "unknown argument: $1" ;;
  esac
  shift
done

command -v curl >/dev/null 2>&1 || refuse "curl not found on PATH"
command -v jq   >/dev/null 2>&1 || refuse "jq not found on PATH"
command -v python3 >/dev/null 2>&1 || refuse "python3 not found (needed to draw the synthetic probe images)"

# LITELLM_* is the evidenced house vocabulary (b §E1). AI_* is a deprecated
# fallback so an operator who copied an older draft is warned, not refused.
BASE_URL="${LITELLM_BASE_URL:-}"
API_KEY="${LITELLM_API_KEY:-}"
if [ -z "$BASE_URL" ] && [ -n "${AI_BASE_URL:-}" ]; then
  BASE_URL="$AI_BASE_URL"
  printf '  WARNING: AI_BASE_URL is DEPRECATED. Use LITELLM_BASE_URL.\n' >&2
fi
if [ -z "$API_KEY" ] && [ -n "${AI_API_KEY:-}" ]; then
  API_KEY="$AI_API_KEY"
  printf '  WARNING: AI_API_KEY is DEPRECATED. Use LITELLM_API_KEY.\n' >&2
fi

[ -n "$BASE_URL" ] || refuse "LITELLM_BASE_URL is not set. Export the literal value supplied by the gateway owner (blocker B-1). Either convention is accepted: with or without a trailing /v1."
case "$BASE_URL" in
  http://*|https://*) : ;;
  *) refuse "LITELLM_BASE_URL must start with http:// or https:// (got '$BASE_URL')" ;;
esac

# --- hostname extraction + public-provider check (pure string ops) ----------
HOSTPORT="${BASE_URL#*://}"      # strip scheme
HOSTPORT="${HOSTPORT%%/*}"       # strip path
HOSTPORT="${HOSTPORT##*@}"       # strip userinfo
HOST="${HOSTPORT%%:*}"           # strip port
# bash 3.2 has no ${x,,}; use tr.
HOST_LC="$(printf '%s' "$HOST" | tr '[:upper:]' '[:lower:]')"
[ -n "$HOST_LC" ] || refuse "LITELLM_BASE_URL has no hostname: '$BASE_URL'"

for suf in $PUBLIC_SUFFIXES; do
  if [ "$HOST_LC" = "$suf" ] || case "$HOST_LC" in *".$suf") true ;; *) false ;; esac; then
    refuse "LITELLM_BASE_URL host '$HOST_LC' is a PUBLIC model provider ($suf). INNOVERA policy forbids sending any traffic -- including synthetic probes -- to public inference providers. Point LITELLM_BASE_URL at the private LiteLLM gateway."
  fi
done

if [ "$RUN" -eq 1 ] && [ -z "$API_KEY" ]; then
  refuse "LITELLM_API_KEY is not set. Refusing to probe without a credential. Use OCR's own virtual key (blocker B-2), never Chat's key and never the master key."
fi

# --- key masking: never print more than the first 6 chars -------------------
mask_key() {
  if [ -z "$API_KEY" ]; then printf '<empty>'; return; fi
  klen=${#API_KEY}
  if [ "$klen" -le 6 ]; then printf '%s' "$(printf '%s' "$API_KEY" | cut -c1)***"; return; fi
  printf '%s...****(len=%d)' "$(printf '%s' "$API_KEY" | cut -c1-6)" "$klen"
}
MASKED="$(mask_key)"

# --- LiteLLM management routes live at the ROOT, not under /v1 --------------
# Accept EITHER base-URL convention and normalise. The evidenced production
# value excludes /v1 (b §E2); without this, that value would build
# "{base}/models" and "{base}/chat/completions" and return 404 on every rung
# of the ladder -- which reads as "the gateway is broken", not "the base URL
# convention differs". Diagnostic tolerance only; see the USAGE note.
ROOT="${BASE_URL%/}"
case "$ROOT" in */v1) ROOT="${ROOT%/v1}" ;; esac
V1="$ROOT/v1"

# --- discriminative digits (random unless pinned) ---------------------------
if [ -z "$DIGITS" ]; then
  DIGITS=$(( ( RANDOM % 90 ) + 10 ))
fi
case "$DIGITS" in
  [0-9][0-9]) : ;;
  *) refuse "--digits must be exactly two digits" ;;
esac

# ---------------------------------------------------------------------------
# Synthetic probe images. Drawn in-process by a stdlib-only python3 snippet
# (hand-rolled PNG encoder: signature + IHDR + IDAT + IEND, 8-bit grayscale).
# No external asset is read. No customer document is ever used.
# ---------------------------------------------------------------------------
make_png_b64() {
  # $1 = text to render (glyphs available: 0-9 O C R)
  python3 - "$1" <<'PYEOF'
import sys, zlib, struct, base64
F={'0':["11111","10001","10001","10001","10001","10001","11111"],
   '1':["00100","01100","00100","00100","00100","00100","01110"],
   '2':["11111","00001","00001","11111","10000","10000","11111"],
   '3':["11111","00001","00001","01111","00001","00001","11111"],
   '4':["10001","10001","10001","11111","00001","00001","00001"],
   '5':["11111","10000","10000","11111","00001","00001","11111"],
   '6':["11111","10000","10000","11111","10001","10001","11111"],
   '7':["11111","00001","00010","00100","01000","01000","01000"],
   '8':["11111","10001","10001","11111","10001","10001","11111"],
   '9':["11111","10001","10001","11111","00001","00001","11111"],
   'O':["11111","10001","10001","10001","10001","10001","11111"],
   'C':["11111","10000","10000","10000","10000","10000","11111"],
   'R':["11110","10001","10001","11110","10100","10010","10001"]}
t=sys.argv[1]; s,pad,GW,GH=8,16,5,7
adv=(GW+1)*s; W=len(t)*adv-s+2*pad; H=GH*s+2*pad
px=[[255]*W for _ in range(H)]
for i,ch in enumerate(t):
    for r,row in enumerate(F[ch]):
        for c,b in enumerate(row):
            if b=='1':
                for dy in range(s):
                    for dx in range(s):
                        px[pad+r*s+dy][pad+i*adv+c*s+dx]=0
raw=b''.join(b'\x00'+bytes(r) for r in px)
def ck(tag,d):
    body=tag+d
    return struct.pack('>I',len(d))+body+struct.pack('>I',zlib.crc32(body)&0xffffffff)
png=(b'\x89PNG\r\n\x1a\n'+ck(b'IHDR',struct.pack('>IIBBBBB',W,H,8,0,0,0,0))
     +ck(b'IDAT',zlib.compress(raw,9))+ck(b'IEND',b''))
sys.stdout.write(base64.b64encode(png).decode('ascii'))
PYEOF
}

IMG_OCR="data:image/png;base64,$(make_png_b64 OCR)"
IMG_NUM="data:image/png;base64,$(make_png_b64 "$DIGITS")"

log "INNOVERA M0 AI gateway probe -- mode=$([ "$RUN" -eq 1 ] && echo run || echo dry-run)"
log "  base_url : $BASE_URL"
log "  api_key  : $MASKED"
log "  root     : $ROOT"

MODEL_EFFECTIVE="${MODEL:-<model-from-/v1/models>}"

# --- request bodies ---------------------------------------------------------
body_chat()   { jq -nc --arg m "$1" '{model:$m,messages:[{role:"user",content:"Reply with the single word: PONG"}],max_tokens:8,temperature:0}'; }
body_vis_a()  { jq -nc --arg m "$1" --arg u "$IMG_OCR" '{model:$m,messages:[{role:"user",content:[{type:"text",text:"What text is written in this image?"},{type:"image_url",image_url:{url:$u}}]}],max_tokens:24,temperature:0}'; }
body_vis_b()  { jq -nc --arg m "$1" --arg u "$IMG_NUM" '{model:$m,messages:[{role:"user",content:[{type:"text",text:"Read the two-digit number in the image. Reply with ONLY those two digits. If you received no image, reply exactly NO_IMAGE."},{type:"image_url",image_url:{url:$u}}]}],max_tokens:8,temperature:0}'; }
body_jschema(){ jq -nc --arg m "$1" '{model:$m,messages:[{role:"user",content:"Return the number 7 and the word seven."}],max_tokens:64,temperature:0,response_format:{type:"json_schema",json_schema:{name:"probe",strict:true,schema:{type:"object",properties:{value:{type:"integer"},word:{type:"string"}},required:["value","word"],additionalProperties:false}}}}'; }
body_jobject(){ jq -nc --arg m "$1" '{model:$m,messages:[{role:"user",content:"Reply in JSON as {\"value\":7,\"word\":\"seven\"}"}],max_tokens:64,temperature:0,response_format:{type:"json_object"}}'; }
body_stream() { jq -nc --arg m "$1" '{model:$m,messages:[{role:"user",content:"Count: one two three four five."}],max_tokens:16,temperature:0,stream:true}'; }
body_thai()   { jq -nc --arg m "$1" --arg th "$THAI_PROBE" '{model:$m,messages:[{role:"user",content:("Repeat the following line back exactly, character for character, with no translation, no transliteration and no commentary:\n"+$th)}],max_tokens:64,temperature:0}'; }
body_tools()  { jq -nc --arg m "$1" '{model:$m,messages:[{role:"user",content:"What is the status of document 42?"}],max_tokens:64,temperature:0,tool_choice:"auto",tools:[{type:"function",function:{name:"get_doc_status",description:"Get the processing status of a document.",parameters:{type:"object",properties:{doc_id:{type:"integer"}},required:["doc_id"]}}}]}'; }

# ---------------------------------------------------------------------------
# DRY RUN -- prints the plan, opens nothing.
# ---------------------------------------------------------------------------
if [ "$RUN" -ne 1 ]; then
  log ""
  log "=== DRY RUN -- no sockets are opened. Pass --run to execute. ==="
  short() { printf '%s' "$1" | cut -c1-160; printf ' ...<truncated, synthetic PNG inline>\n'; }
  log ""; log "[a1] liveliness            GET  $ROOT/health/liveliness    (max-time ${T_HEALTH}s, NO key sent)"
  log "[a2] readiness             GET  $ROOT/health/readiness     (max-time ${T_HEALTH}s, NO key sent)"
  log "[a3] readiness_details     GET  $ROOT/health/readiness/details (max-time ${T_HEALTH}s) -- free litellm_version"
  log "[b]  models                GET  $V1/models                 (max-time ${T_INFO}s)"
  log "[c1] model_info            GET  $ROOT/model/info           (max-time ${T_INFO}s)"
  log "[c2] model_group_info      GET  $ROOT/model_group/info     (max-time ${T_INFO}s)"
  log "[c3] model_info_v1         GET  $V1/model/info             (max-time ${T_INFO}s)  [fallback]"
  log "[c4] model_group_info_v1   GET  $V1/model_group/info       (max-time ${T_INFO}s)  [fallback]"
  log "[d]  chat_minimal          POST $V1/chat/completions        (max-time ${T_CHAT}s)"
  log "     $(body_chat "$MODEL_EFFECTIVE")"
  log "[d2] thai_roundtrip        POST $V1/chat/completions        (max-time ${T_CHAT}s)"
  log "     $(body_thai "$MODEL_EFFECTIVE")"
  log "[e1] vision_describe       POST $V1/chat/completions        (max-time ${T_VISION}s)"
  log "     $(short "$(body_vis_a "$MODEL_EFFECTIVE")")"
  log "[e2] vision_discriminative POST $V1/chat/completions        (max-time ${T_VISION}s)  expect digits=$DIGITS"
  log "     $(short "$(body_vis_b "$MODEL_EFFECTIVE")")"
  log "[f1] json_schema           POST $V1/chat/completions        (max-time ${T_CHAT}s)"
  log "     $(body_jschema "$MODEL_EFFECTIVE")"
  log "[f2] json_object           POST $V1/chat/completions        (max-time ${T_CHAT}s)"
  log "     $(body_jobject "$MODEL_EFFECTIVE")"
  log "[g]  streaming             POST $V1/chat/completions        (max-time ${T_CHAT}s)"
  log "     $(body_stream "$MODEL_EFFECTIVE")"
  log "[h]  tools                 POST $V1/chat/completions        (max-time ${T_CHAT}s)"
  log "     $(body_tools "$MODEL_EFFECTIVE")"
  log ""
  log "All Authorization headers would be: Bearer $MASKED"

  # Emit the SAME schema as the run path and as probe_ai_gateway.py -- a
  # dry run that emits a different shape is useless for wiring up whatever
  # consumes capability.json later.
  jq -n --arg v "$SCHEMA_VERSION" --arg t "$TOOL_NAME" --arg b "$BASE_URL" \
        --arg k "$MASKED" --arg d "$DIGITS" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{schema_version:$v, probe_tool:$t, generated_at:$ts, mode:"dry-run",
      base_url:$b, api_key_masked:$k,
      capabilities:{
        reachable:null, models:[], selected_model:null,
        declared:{supports_vision:null, supports_function_calling:null,
                  max_input_tokens:null, max_output_tokens:null, mode:null,
                  source:null, trustworthy:null},
        empirical:{chat:null, vision:"unknown", json_schema:"not-probed",
                   json_object:"not-probed", streaming:null, streaming_chunks:0,
                   tools:null, thai_roundtrip:"not-probed"},
        vision_verdict:"unknown",
        context_window:{value:null, source:"unknown"},
        tokenizer:{en_prompt_tokens:null, en_prompt_chars:null,
                   th_prompt_tokens:null, th_prompt_chars:null,
                   th_chars_per_token:null, en_chars_per_token:null,
                   th_penalty_vs_en:null},
        gateway:{litellm_version:null, rate_limit_headers:{}}
      },
      probes:[], blockers:[],
      notes:["DRY RUN ONLY. No network traffic was generated.",
             ("Discriminative vision probe would have used digits " + $d + "."),
             "Probe images are synthetic bitmaps generated in-process. No customer document is ever read or transmitted."]}'
  exit 0
fi

# ---------------------------------------------------------------------------
# RUN -- single attempt each, no retries, hard timeout.
# ---------------------------------------------------------------------------
TMP="$(mktemp -d "${TMPDIR:-/tmp}/innovera-probe.XXXXXX")"
chmod 700 "$TMP"
trap 'rm -rf "$TMP"' EXIT

# curl --max-filesize only aborts an unknown-length transfer (an SSE stream)
# from curl 8.4.0 onward. Below that, rung g silently reads the whole stream
# and the "exit 63 == it streamed" signal never fires. Warn, do not fail.
CURL_VER="$(curl --version 2>/dev/null | head -1 | awk '{print $2}')"
CURL_MAJ="${CURL_VER%%.*}"
CURL_REST="${CURL_VER#*.}"; CURL_MIN="${CURL_REST%%.*}"
STREAM_ABORT_OK=1
case "$CURL_MAJ" in
  ''|*[!0-9]*) STREAM_ABORT_OK=0 ;;
  *) if [ "$CURL_MAJ" -lt 8 ] || { [ "$CURL_MAJ" -eq 8 ] && [ "${CURL_MIN:-0}" -lt 4 ]; }; then
       STREAM_ABORT_OK=0
     fi ;;
esac
[ "$STREAM_ABORT_OK" -eq 1 ] || log "  WARN: curl $CURL_VER < 8.4.0 -- rung g cannot abort the stream early; it will read to completion (bounded by max_tokens=16)."

# --- credentials go in a 0600 config file, NEVER on the command line -------
# `curl -H "Authorization: Bearer sk-..."` is visible in `ps` to every other
# user on the host for the lifetime of the request. This is not theoretical
# on a shared jump box, which is exactly where an operator would run this.
AUTH_CFG="$TMP/auth.curlrc"
( umask 077; {
    printf 'header = "Authorization: Bearer %s"\n' "$API_KEY"
    printf 'header = "x-api-key: %s"\n' "$API_KEY"
  } > "$AUTH_CFG" )
chmod 600 "$AUTH_CFG"

# call <id> <method> <url> <timeout> [body] [noauth]
# Writes body to $TMP/<id>.body, headers to $TMP/<id>.hdr, echoes the status.
# NOTE: -L is deliberately absent. curl does not follow redirects by default;
# a 3xx is reported so it can be investigated, never chased.
call() {
  _id="$1"; _method="$2"; _url="$3"; _to="$4"; _body="${5:-}"; _noauth="${6:-}"
  if [ -n "$_noauth" ]; then _cfg=""; else _cfg="--config $AUTH_CFG"; fi
  set +e
  if [ -n "$_body" ]; then
    _code=$(printf '%s' "$_body" | curl -sS $INSECURE $_cfg \
      -o "$TMP/$_id.body" -D "$TMP/$_id.hdr" -w '%{http_code}' \
      --max-time "$_to" --no-keepalive \
      -X "$_method" "$_url" \
      -H 'Content-Type: application/json' \
      -H 'Accept: application/json' \
      --data-binary @- 2>"$TMP/$_id.err")
  else
    _code=$(curl -sS $INSECURE $_cfg \
      -o "$TMP/$_id.body" -D "$TMP/$_id.hdr" -w '%{http_code}' \
      --max-time "$_to" --no-keepalive \
      -X "$_method" "$_url" \
      -H 'Accept: application/json' 2>"$TMP/$_id.err")
  fi
  _rc=$?
  set -e
  if [ $_rc -ne 0 ]; then echo "000"; else echo "$_code"; fi
}

say() { log "[$1] $(printf '%-22s' "$2") -> $3"; }

# A refused redirect is a SECURITY finding: it means traffic could leave for a
# host that never passed the public-provider check.
REDIRECTS=""
check_redirect() {  # $1=id  $2=code  $3=url
  case "$2" in
    3??) REDIRECTS="$REDIRECTS $1"
         log "  SECURITY: [$1] $3 answered $2 (redirect). NOT followed. Location: $(grep -i '^location:' "$TMP/$1.hdr" 2>/dev/null | head -1 | tr -d '\r')" ;;
  esac
}

# usage_tokens <bodyfile> -> prompt_tokens or "null"
usage_tokens() { jq -r '.usage.prompt_tokens // "null"' "$1" 2>/dev/null || echo null; }

# ---- a. health (no model load, and NO key sent: these are unauthenticated) --
A1=$(call a1 GET "$ROOT/health/liveliness" "$T_HEALTH" "" noauth); say a1 liveliness "$A1"; check_redirect a1 "$A1" "$ROOT/health/liveliness"
A2=$(call a2 GET "$ROOT/health/readiness"  "$T_HEALTH" "" noauth); say a2 readiness  "$A2"; check_redirect a2 "$A2" "$ROOT/health/readiness"
if [ "$A1" = "000" ] && [ "$A2" = "000" ]; then
  log "  curl error: $(cat "$TMP/a1.err" 2>/dev/null | head -1)"
  jq -n --arg v "$SCHEMA_VERSION" --arg t "$TOOL_NAME" --arg b "$BASE_URL" \
        --arg k "$MASKED" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{schema_version:$v, probe_tool:$t, generated_at:$ts, mode:"run",
      base_url:$b, api_key_masked:$k,
      capabilities:{reachable:false, models:[], selected_model:null,
        declared:{}, empirical:{}, vision_verdict:"unknown",
        context_window:{value:null,source:"unknown"}, tokenizer:{},
        gateway:{litellm_version:null, rate_limit_headers:{}}},
      probes:[], notes:[],
      blockers:["Gateway unreachable -- both health endpoints failed to connect. Check host, port, firewall and VPN before interpreting anything else."]}'
  exit 3
fi

# ---- a3. authenticated readiness detail: free litellm_version, no model call
A3=$(call a3 GET "$ROOT/health/readiness/details" "$T_HEALTH"); say a3 readiness_details "$A3"
LLVER="$(jq -r '.litellm_version // empty' "$TMP/a3.body" 2>/dev/null || true)"
if [ -z "$LLVER" ]; then
  LLVER="$(grep -i '^x-litellm-version:' "$TMP"/*.hdr 2>/dev/null | head -1 | sed 's/.*: *//' | tr -d '\r' || true)"
fi
[ -n "$LLVER" ] && log "  litellm_version: $LLVER"

# ---- b. authoritative model list ------------------------------------------
B=$(call b GET "$V1/models" "$T_INFO"); say b models "$B"
MODELS_JSON='[]'
if [ "$B" = "200" ]; then
  MODELS_JSON=$(jq -c '[.data[]?.id] // []' "$TMP/b.body" 2>/dev/null || echo '[]')
fi
if [ -z "$MODEL" ]; then
  # prefer an obviously-vision model if the list offers one
  MODEL=$(printf '%s' "$MODELS_JSON" | jq -r 'map(select(test("-vl|vl-|vision";"i")))[0] // .[0] // ""')
fi
[ -n "$MODEL" ] || refuse "Could not resolve a model id from $V1/models. Pass --model explicitly."
log "  selected model: $MODEL"

# ---- c. declared capability metadata (LiteLLM-specific) --------------------
# c3/c4 are /v1-prefixed fallbacks. Some builds and most path-prefixing
# reverse proxies only expose them there, and a 404 on c1/c2 alone would be
# misread as "this gateway is not LiteLLM".
C1=$(call c1 GET "$ROOT/model/info"       "$T_INFO"); say c1 model_info       "$C1"
C2=$(call c2 GET "$ROOT/model_group/info" "$T_INFO"); say c2 model_group_info "$C2"
C3=$(call c3 GET "$V1/model/info"         "$T_INFO"); say c3 model_info_v1       "$C3"
C4=$(call c4 GET "$V1/model_group/info"   "$T_INFO"); say c4 model_group_info_v1 "$C4"
if [ "$C1" = "404" ] && [ "$C2" = "404" ] && [ "$C3" = "404" ] && [ "$C4" = "404" ]; then
  log "  NOTE: all four LiteLLM metadata routes 404 while health+models worked."
  log "        You are probably talking to raw vLLM, not LiteLLM. That reframes"
  log "        the gateway model -- report it, do not retry."
fi

DECLARED='{}'
for f in c2 c4 c1 c3; do
  if [ -f "$TMP/$f.body" ]; then
    D=$(jq -c --arg m "$MODEL" '
      ( [ .data[]? | select((.model_group? // .model_name?) == $m) ][0]
        // .data[0]? // {} ) as $row
      | ($row.model_info // $row)
      | {supports_vision, supports_function_calling, max_input_tokens,
         max_output_tokens, mode}' "$TMP/$f.body" 2>/dev/null || echo '{}')
    if [ "$D" != "{}" ] && [ "$D" != "null" ]; then DECLARED="$D"; break; fi
  fi
done

# ---- d. minimal text chat --------------------------------------------------
D1=$(call d POST "$V1/chat/completions" "$T_CHAT" "$(body_chat "$MODEL")"); say d chat_minimal "$D1"
EN_TOK=$(usage_tokens "$TMP/d.body"); EN_CHARS=31   # len("Reply with the single word: PONG")-1

# ---- d2. THAI ROUND TRIP + Thai token calibration ---------------------------
# The single most important rung for a Thai-primary product, and the only
# honest source for the token-budget ratio in the M0 doc §F.6.
D2=$(call d2 POST "$V1/chat/completions" "$T_CHAT" "$(body_thai "$MODEL")"); say d2 thai_roundtrip "$D2"
TH_TOK=$(usage_tokens "$TMP/d2.body")
TH_CHARS=$(printf '%s' "$THAI_PROBE" | /usr/bin/env python3 -c 'import sys;print(len(sys.stdin.read()))' 2>/dev/null || echo 0)
THAI_TXT=""; THAI_VERDICT="unknown"
if [ -f "$TMP/d2.body" ]; then
  THAI_TXT=$(jq -r '.choices[0].message.content // ""' "$TMP/d2.body" 2>/dev/null || echo "")
fi
case "$D2" in
  2*)
    # Compare after NFC normalisation: Thai combining marks have more than one
    # valid ordering and macOS emits NFD, so a raw compare reports false
    # corruption for text that is in fact identical.
    THAI_VERDICT=$(THAI_EXPECT="$THAI_PROBE" THAI_GOT="$THAI_TXT" /usr/bin/env python3 -c '
import os,sys,unicodedata
exp=os.environ["THAI_EXPECT"]; got=os.environ["THAI_GOT"]
n=lambda s: unicodedata.normalize("NFC", s or "")
if exp in got: print("exact")
elif n(exp) in n(got): print("nfc-equal")
elif any("฀" <= c <= "๿" for c in got): print("MANGLED")
else: print("NO_THAI_RETURNED")
' 2>/dev/null || echo unknown)
    THAI_NUM_OK=$(THAI_EXPECT="$THAI_PROBE" THAI_GOT="$THAI_TXT" /usr/bin/env python3 -c '
import os
exp=os.environ["THAI_EXPECT"]; got=os.environ["THAI_GOT"]
d=[c for c in exp if "๐"<=c<="๙"]
print("%d/%d" % (len([c for c in d if c in got]), len(d)))
' 2>/dev/null || echo "0/0") ;;
  *) THAI_VERDICT="unknown (HTTP $D2)"; THAI_NUM_OK="0/0" ;;
esac
log "  thai round trip: $THAI_VERDICT  (Thai numerals preserved: $THAI_NUM_OK)"
log "  tokens: en prompt=$EN_TOK (${EN_CHARS} chars), th prompt=$TH_TOK (${TH_CHARS} chars)"

# ---- e. vision --------------------------------------------------------------
E1=$(call e1 POST "$V1/chat/completions" "$T_VISION" "$(body_vis_a "$MODEL")"); say e1 vision_describe "$E1"
E2=$(call e2 POST "$V1/chat/completions" "$T_VISION" "$(body_vis_b "$MODEL")"); say e2 vision_discrim "$E2"

# Interpretation. Distinguishes "not supported" from "misconfigured".
VISION="unknown"
E2TXT=""
if [ -f "$TMP/e2.body" ]; then
  E2TXT=$(jq -r '.choices[0].message.content // ""' "$TMP/e2.body" 2>/dev/null || echo "")
fi
E2LOW=$(printf '%s' "$(cat "$TMP/e2.body" 2>/dev/null)" | tr '[:upper:]' '[:lower:]')
case "$E2" in
  400)
    # Markers must indicate the MODALITY was rejected, not that OUR request
    # was malformed. A bare "image" substring is too broad: "invalid base64
    # image data" or "image exceeds max size" are OUR bugs and must never
    # write a text_only verdict. Every marker below asserts non-support.
    case "$E2LOW" in
      *"does not support image"*|*"doesn't support image"*|*"not support vision"* \
      |*"multimodal"*|*"content part"*|*"image_url is not supported"* \
      |*"unsupported content type"*|*"only supports text"*|*"text-only"* \
      |*"vision is not"*|*"image input"*)
        VISION="text_only" ;;
      *"base64"*|*"decode"*|*"too large"*|*"exceeds"*|*"invalid"*)
        VISION="ambiguous"
        log "  NOTE: 400 looks like OUR malformed request, not a modality rejection. Inspect $TMP/e2.body before concluding." ;;
      *) VISION="ambiguous" ;;
    esac ;;
  401|403|404) VISION="unknown" ;;   # auth/model-name problem, not a capability answer
  5*)          VISION="unknown" ;;   # backend fault
  2*)
    if printf '%s' "$E2TXT" | grep -qi 'NO_IMAGE'; then
      VISION="text_only"
    elif printf '%s' "$E2TXT" | grep -q "$DIGITS"; then
      VISION="vision"
    else
      VISION="ambiguous"
    fi ;;
esac
log "  vision verdict: $VISION (expected digits '$DIGITS', model said '$E2TXT')"

# ---- f. structured output ---------------------------------------------------
F1=$(call f1 POST "$V1/chat/completions" "$T_CHAT" "$(body_jschema "$MODEL")"); say f1 json_schema "$F1"
F2=$(call f2 POST "$V1/chat/completions" "$T_CHAT" "$(body_jobject "$MODEL")"); say f2 json_object "$F2"

judge_json() {  # $1=code $2=bodyfile
  case "$1" in
    400) printf 'rejected (400) -- response_format unsupported by this backend'; return ;;
    2*) : ;;
    *) printf 'status %s' "$1"; return ;;
  esac
  if jq -e '.choices[0].message.content | fromjson' "$2" >/dev/null 2>&1; then
    printf 'honored -- valid JSON returned'
  else
    printf 'accepted but output is NOT valid JSON (constraint not enforced)'
  fi
}
F1V=$(judge_json "$F1" "$TMP/f1.body"); F2V=$(judge_json "$F2" "$TMP/f2.body")

# ---- g. streaming (read a little, then stop) --------------------------------
set +e
G=$(printf '%s' "$(body_stream "$MODEL")" | curl -sS $INSECURE --config "$AUTH_CFG" \
      -o "$TMP/g.body" -D "$TMP/g.hdr" \
      -w '%{http_code}' --max-time "$T_CHAT" --max-filesize 4096 --no-keepalive \
      -X POST "$V1/chat/completions" \
      -H 'Content-Type: application/json' -H 'Accept: text/event-stream' \
      --data-binary @- 2>/dev/null)
GRC=$?
set -e
# curl exit 63 = max-filesize exceeded. For an unknown-length SSE body that is
# proof the server WAS streaming -- but only on curl >= 8.4.0 (see the guard
# at the top). On older curl the transfer simply completes and GRC is 0.
if [ "$GRC" -eq 63 ]; then G="200(stream-truncated)"; fi
# grep -c prints 0 AND exits 1 when there is no match, so a naive
# `|| echo 0` yields the string "0\n0". Suppress grep's own exit status
# instead of appending to its output.
GCHUNKS=$(grep -c '^data:' "$TMP/g.body" 2>/dev/null | head -1 || true)
case "$GCHUNKS" in ''|*[!0-9]*) GCHUNKS=0 ;; esac
GCTYPE=$(grep -i '^content-type:' "$TMP/g.hdr" 2>/dev/null | head -1 | tr -d '\r' || true)
GVERDICT="stream rejected"
case "$G" in
  2*) if [ "$GCHUNKS" -gt 0 ]; then
        GVERDICT="streaming ok ($GCHUNKS chunks)"
      else
        GVERDICT="200 but no SSE lines -- reverse proxy is BUFFERING (check X-Accel-Buffering / proxy_buffering off). NOT a model limit."
      fi ;;
esac
say g streaming "$G (${GCHUNKS} SSE chunks; $GCTYPE)"
log "  streaming verdict: $GVERDICT"

# ---- h. tool / function calling ---------------------------------------------
H=$(call h POST "$V1/chat/completions" "$T_CHAT" "$(body_tools "$MODEL")"); say h tools "$H"
HTOOL=false
if [ -f "$TMP/h.body" ] && jq -e '.choices[0].message.tool_calls | length > 0' "$TMP/h.body" >/dev/null 2>&1; then
  HTOOL=true
fi

# ---- i. context window (declared only -- never brute-forced) ----------------
CTX=$(printf '%s' "$DECLARED" | jq -r '.max_input_tokens // "null"')
CTXSRC="model_info"
if [ "$CTX" = "null" ] && [ -f "$TMP/b.body" ]; then
  # vLLM PR #4643 exposes max_model_len on /v1/models; LiteLLM often strips it.
  CTX=$(jq -r '[.data[]?.max_model_len] | map(select(.!=null))[0] // "null"' "$TMP/b.body" 2>/dev/null || echo null)
  [ "$CTX" != "null" ] && CTXSRC="v1_models_max_model_len"
fi

# ---- emit ---------------------------------------------------------------------
RATE_HEADERS=$(grep -ih '^x-ratelimit-' "$TMP"/*.hdr 2>/dev/null \
  | tr -d '\r' | sort -u \
  | jq -Rn '[inputs | select(length>0) | split(": ") | {(.[0]|ascii_downcase): (.[1:]|join(": "))}] | add // {}' \
  2>/dev/null || echo '{}')
[ -n "$RATE_HEADERS" ] || RATE_HEADERS='{}'

jq -n \
  --arg v "$SCHEMA_VERSION" --arg t "$TOOL_NAME" --arg b "$BASE_URL" --arg k "$MASKED" \
  --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg model "$MODEL" --argjson models "$MODELS_JSON" --argjson declared "$DECLARED" \
  --arg vision "$VISION" --arg digits "$DIGITS" --arg e2txt "$E2TXT" \
  --arg a1 "$A1" --arg a2 "$A2" --arg a3 "$A3" --arg d1 "$D1" --arg e1 "$E1" --arg e2 "$E2" \
  --arg d2 "$D2" --arg thaiv "$THAI_VERDICT" --arg thainum "$THAI_NUM_OK" \
  --arg thaitxt "$THAI_TXT" --arg thaiexp "$THAI_PROBE" \
  --arg entok "$EN_TOK" --arg enchars "$EN_CHARS" \
  --arg thtok "$TH_TOK" --arg thchars "$TH_CHARS" \
  --arg f1 "$F1" --arg f1v "$F1V" --arg f2 "$F2" --arg f2v "$F2V" \
  --arg g "$G" --arg gch "$GCHUNKS" --arg gverdict "$GVERDICT" \
  --arg h "$H" --argjson htool "$HTOOL" \
  --arg ctx "$CTX" --arg ctxsrc "$CTXSRC" --arg llver "$LLVER" \
  --argjson rate "$RATE_HEADERS" --arg redirects "$REDIRECTS" \
'
  ( ($entok|tonumber?) ) as $ent
| ( ($thtok|tonumber?) ) as $tht
| ( ($enchars|tonumber?) ) as $enc
| ( ($thchars|tonumber?) ) as $thc
| ( if ($ent and $ent>0 and $enc) then (($enc/$ent)*1000|round)/1000 else null end ) as $encpt
| ( if ($tht and $tht>0 and $thc) then (($thc/$tht)*1000|round)/1000 else null end ) as $thcpt
|
{
  schema_version:$v, probe_tool:$t, generated_at:$ts, mode:"run",
  base_url:$b, api_key_masked:$k,
  capabilities:{
    reachable:true,
    models:$models,
    selected_model:$model,
    declared:($declared + {
      source:"litellm /model_group/info or /model/info (root or /v1)",
      trustworthy:($declared.supports_vision == true)
    }),
    empirical:{
      chat:($d1|startswith("2")),
      vision:$vision,
      json_schema:$f1v,
      json_object:$f2v,
      streaming:(($g|startswith("2")) and (($gch|tonumber? // 0) > 0)),
      streaming_chunks:($gch|tonumber? // 0),
      tools:$htool,
      thai_roundtrip:$thaiv
    },
    vision_verdict:$vision,
    context_window:{ value:($ctx|tonumber? // null), source:$ctxsrc },
    tokenizer:{
      en_prompt_tokens:$ent, en_prompt_chars:$enc, en_chars_per_token:$encpt,
      th_prompt_tokens:$tht, th_prompt_chars:$thc, th_chars_per_token:$thcpt,
      th_penalty_vs_en:(if ($encpt and $thcpt and $thcpt>0) then (($encpt/$thcpt)*100|round)/100 else null end)
    },
    gateway:{ litellm_version:(if $llver=="" then null else $llver end),
              rate_limit_headers:$rate }
  },
  probes:[
    {id:"a1",name:"liveliness",status:$a1},
    {id:"a2",name:"readiness",status:$a2},
    {id:"a3",name:"readiness_details",status:$a3},
    {id:"d", name:"chat_minimal",status:$d1,usage:{prompt_tokens:$ent}},
    {id:"d2",name:"thai_roundtrip",status:$d2,verdict:$thaiv,
     thai_expected:$thaiexp,thai_got:$thaitxt,thai_numerals_preserved:$thainum,
     usage:{prompt_tokens:$tht}},
    {id:"e1",name:"vision_describe",status:$e1},
    {id:"e2",name:"vision_discriminative",status:$e2,expected:$digits,answer:$e2txt},
    {id:"f1",name:"json_schema",status:$f1,verdict:$f1v},
    {id:"f2",name:"json_object",status:$f2,verdict:$f2v},
    {id:"g", name:"streaming",status:$g,chunks:($gch|tonumber? // 0),verdict:$gverdict},
    {id:"h", name:"tools",status:$h,tool_calls:$htool}
  ],
  blockers:(
    (if ($ctx=="null") then ["Context window unknown. Ask the gateway operator for vLLM --max-model-len. DO NOT brute-force it against a production GPU."] else [] end)
  + (if ($declared.supports_vision == true and $vision == "text_only")
      then ["CONTRADICTION: metadata declares supports_vision=true but the discriminative image probe was rejected. Trust the empirical result."] else [] end)
  + (if ($f1v|startswith("accepted but"))
      then ["json_schema was ACCEPTED but not ENFORCED (200, non-JSON body). Treat structured output as UNSUPPORTED: this failure mode looks healthy and corrupts extraction downstream."] else [] end)
  + (if ($thaiv=="MANGLED" or $thaiv=="NO_THAI_RETURNED")
      then ["THAI ROUND TRIP FAILED (" + $thaiv + "). This product is Thai-primary. Do not build extraction on this path until the cause is found."] else [] end)
  + (if ($thainum|startswith("0/")) and $thainum!="0/0"
      then ["Thai numerals U+0E50-59 were NOT preserved. Extraction must normalise Thai <-> ASCII digits explicitly."] else [] end)
  + (if $llver=="" then ["LiteLLM version not observed. It decides whether response_format json_schema and model_info propagation are available -- ask the operator."] else [] end)
  + (if $redirects=="" then [] else ["SECURITY: redirect(s) returned by rung(s)" + $redirects + ". Not followed. A gateway that redirects can send document text to a host that never passed the public-provider check."] end)
  ),
  notes:[
    "Probe images are synthetic bitmaps generated in-process. No customer document was read or transmitted.",
    "declared.supports_vision is only meaningful when true. For a self-hosted vLLM behind LiteLLM, null/false means UNKNOWN, not text-only (BerriAI/litellm#27830, #9297).",
    "tokenizer.th_chars_per_token includes the English instruction and the chat template, so it UNDERSTATES the Thai penalty. Treat it as a lower bound and re-measure with a Thai-only prompt before tuning chunk sizes."
  ]
}'
