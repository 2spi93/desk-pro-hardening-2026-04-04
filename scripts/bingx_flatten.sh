#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib/control_plane_helpers.sh
. "$SCRIPT_DIR/lib/control_plane_helpers.sh"

txt_source_repo_env

CONTROL_PLANE_URL="$(txt_resolve_control_plane_url "${CONTROL_PLANE_URL:-}")"
USERNAME="${USERNAME:-operator}"
PASSWORD="${PASSWORD:-}"
ACCOUNT_ID="${ACCOUNT_ID:-}"
SYMBOL="${SYMBOL:-BTCUSDT}"
POSITION_SIDE="${POSITION_SIDE:-}"
CONFIRM_FLATTEN="${CONFIRM_FLATTEN:-}"
DRY_RUN="${DRY_RUN:-0}"
PRINT_RAW="${PRINT_RAW:-0}"
CURL_INSECURE="${CURL_INSECURE:-0}"

usage() {
  cat <<'EOF'
Usage: bingx_flatten.sh [options]

Options:
  --control-plane-url URL    Control-plane base URL (default: http://127.0.0.1:8000)
  --username NAME            Login username (default: operator)
  --password VALUE           Login password (default: resolved from .env/secrets)
  --account-id VALUE         Linked BingX account id (required)
  --symbol VALUE             Symbol to flatten (default: BTCUSDT)
  --position-side VALUE      Optional LONG or SHORT filter
  --confirm-flatten VALUE    Must equal BINGX_FLATTEN unless --dry-run is used
  --dry-run                  Preview only, no close order sent to BingX
  --print-raw                Print raw JSON response
  --insecure                 Pass -k to curl
  -h, --help                 Show help
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --control-plane-url) CONTROL_PLANE_URL="$2"; shift 2 ;;
    --username) USERNAME="$2"; shift 2 ;;
    --password) PASSWORD="$2"; shift 2 ;;
    --account-id) ACCOUNT_ID="$2"; shift 2 ;;
    --symbol) SYMBOL="$2"; shift 2 ;;
    --position-side) POSITION_SIDE="$2"; shift 2 ;;
    --confirm-flatten) CONFIRM_FLATTEN="$2"; shift 2 ;;
    --dry-run) DRY_RUN="1"; shift 1 ;;
    --print-raw) PRINT_RAW="1"; shift 1 ;;
    --insecure) CURL_INSECURE="1"; shift 1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 2 ;;
  esac
done

if [ -z "$PASSWORD" ]; then
  PASSWORD="$(txt_resolve_user_password "$USERNAME" "$PASSWORD" || true)"
fi

if [ -z "$ACCOUNT_ID" ]; then
  echo "account_id_missing: pass --account-id or set ACCOUNT_ID" >&2
  exit 3
fi

if [ "$DRY_RUN" != "1" ] && [ "$CONFIRM_FLATTEN" != "BINGX_FLATTEN" ]; then
  echo "confirmation_missing: pass --confirm-flatten BINGX_FLATTEN or use --dry-run" >&2
  exit 4
fi

if [ -z "$PASSWORD" ]; then
  echo "auth_error: password missing for user '$USERNAME'" >&2
  exit 5
fi

txt_init_curl_tls_flag "$CURL_INSECURE"

TOKEN="$(txt_control_plane_login_token "$CONTROL_PLANE_URL" "$USERNAME" "$PASSWORD" "$CURL_INSECURE" || true)"
if [ -z "$TOKEN" ]; then
  echo "login_failed: no access token returned" >&2
  exit 6
fi

REQUEST_BODY="$(python3 - <<PY
import json
body = {
    "account_id": ${ACCOUNT_ID@Q},
    "symbol": ${SYMBOL@Q},
}
position_side = ${POSITION_SIDE@Q}.strip().upper()
if position_side:
    body["position_side"] = position_side
if ${DRY_RUN@Q} == "1":
    body["dry_run"] = True
else:
    body["confirmation_text"] = ${CONFIRM_FLATTEN@Q}
print(json.dumps(body))
PY
)"

RESPONSE_BODY="$(curl "${CURL_TLS_FLAG[@]}" --max-time 40 -sS \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -X POST "$CONTROL_PLANE_URL/v1/connectors/bingx/flatten" \
  --data "$REQUEST_BODY")"

if [ "$PRINT_RAW" = "1" ]; then
  printf '%s\n' "$RESPONSE_BODY"
  exit 0
fi

RESPONSE_BODY_JSON="$RESPONSE_BODY" python3 - <<'PY'
import json
import os

body = json.loads(os.environ["RESPONSE_BODY_JSON"])
print(f"status={body.get('status', '-')}")
print(f"provider={body.get('provider', '-')}")
print(f"account_id={body.get('account_id', '-')}")
print(f"symbol={body.get('symbol', '-')}")
print(f"requested_position_side={body.get('requested_position_side', '-')}")
before = body.get('positions_before') if isinstance(body.get('positions_before'), list) else []
after = body.get('positions_after') if isinstance(body.get('positions_after'), list) else []
results = body.get('close_results') if isinstance(body.get('close_results'), list) else []
errors = body.get('close_errors') if isinstance(body.get('close_errors'), list) else []
print(f"positions_before={len(before)}")
print(f"close_results={len(results)}")
print(f"close_errors={len(errors)}")
print(f"positions_after={len(after)}")
PY