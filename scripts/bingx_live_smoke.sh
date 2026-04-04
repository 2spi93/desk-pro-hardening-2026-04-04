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
SIDE="${SIDE:-buy}"
NOTIONAL_USD="${NOTIONAL_USD:-7}"
LIMIT_OFFSET_BPS="${LIMIT_OFFSET_BPS:-}"
CONFIRM_LIVE="${CONFIRM_LIVE:-}"
PRINT_RAW="${PRINT_RAW:-0}"
CURL_INSECURE="${CURL_INSECURE:-0}"

usage() {
  cat <<'EOF'
Usage: bingx_live_smoke.sh [options]

Options:
  --control-plane-url URL    Control-plane base URL (default: http://127.0.0.1:8000)
  --username NAME            Login username (default: operator)
  --password VALUE           Login password (default: resolved from .env/secrets)
  --account-id VALUE         Linked BingX account id (required)
  --symbol VALUE             Symbol to use (default: BTCUSDT)
  --side VALUE               buy or sell (default: buy)
  --notional-usd VALUE       Smoke notional in USD (default: 7)
  --limit-offset-bps VALUE   Optional far-from-market limit offset in bps
  --confirm-live VALUE       Must equal BINGX_LIVE_SMOKE to execute
  --print-raw                Print raw JSON response
  --insecure                 Pass -k to curl
  -h, --help                 Show help

Environment fallbacks:
  CONTROL_PLANE_URL, USERNAME, PASSWORD, ACCOUNT_ID, SYMBOL, SIDE, NOTIONAL_USD,
  LIMIT_OFFSET_BPS, CONFIRM_LIVE, PRINT_RAW, CURL_INSECURE

Notes:
  - This script places a tiny live LIMIT order on BingX and cancels it immediately if still open.
  - The control-plane and config/live_execution_policy.json must both allow BingX live smoke.
  - Does not print credentials or tokens.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --control-plane-url) CONTROL_PLANE_URL="$2"; shift 2 ;;
    --username) USERNAME="$2"; shift 2 ;;
    --password) PASSWORD="$2"; shift 2 ;;
    --account-id) ACCOUNT_ID="$2"; shift 2 ;;
    --symbol) SYMBOL="$2"; shift 2 ;;
    --side) SIDE="$2"; shift 2 ;;
    --notional-usd) NOTIONAL_USD="$2"; shift 2 ;;
    --limit-offset-bps) LIMIT_OFFSET_BPS="$2"; shift 2 ;;
    --confirm-live) CONFIRM_LIVE="$2"; shift 2 ;;
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

if [ "$CONFIRM_LIVE" != "BINGX_LIVE_SMOKE" ]; then
  echo "confirmation_missing: pass --confirm-live BINGX_LIVE_SMOKE" >&2
  exit 4
fi

if [ -z "$PASSWORD" ]; then
  echo "auth_error: password missing for user '$USERNAME'" >&2
  exit 5
fi

if [ "$SIDE" != "buy" ] && [ "$SIDE" != "sell" ]; then
  echo "invalid_side: expected buy or sell" >&2
  exit 6
fi

txt_init_curl_tls_flag "$CURL_INSECURE"

TOKEN="$(txt_control_plane_login_token "$CONTROL_PLANE_URL" "$USERNAME" "$PASSWORD" "$CURL_INSECURE" || true)"
if [ -z "$TOKEN" ]; then
  echo "login_failed: no access token returned" >&2
  exit 7
fi

REQUEST_BODY="$(python3 - <<PY
import json
body = {
    "account_id": ${ACCOUNT_ID@Q},
    "symbol": ${SYMBOL@Q},
    "side": ${SIDE@Q},
    "notional_usd": float(${NOTIONAL_USD@Q}),
    "confirmation_text": "BINGX_LIVE_SMOKE",
}
limit_offset = ${LIMIT_OFFSET_BPS@Q}
if limit_offset:
    body["limit_offset_bps"] = float(limit_offset)
print(json.dumps(body))
PY
)"

RESPONSE_BODY="$(curl "${CURL_TLS_FLAG[@]}" --max-time 40 -sS \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -X POST "$CONTROL_PLANE_URL/v1/connectors/bingx/live-smoke" \
  --data "$REQUEST_BODY")"

if [ "$PRINT_RAW" = "1" ]; then
  printf '%s\n' "$RESPONSE_BODY"
  exit 0
fi

RESPONSE_BODY_JSON="$RESPONSE_BODY" python3 - <<'PY'
import json
import os
import sys

body = json.loads(os.environ["RESPONSE_BODY_JSON"])
create = body.get("create") if isinstance(body.get("create"), dict) else {}
cancel = body.get("cancel") if isinstance(body.get("cancel"), dict) else {}
print(f"status={body.get('status', '-')}")
print(f"provider={body.get('provider', '-')}")
print(f"account_id={body.get('account_id', '-')}")
print(f"symbol={body.get('symbol', '-')}")
print(f"side={body.get('side', '-')}")
print(f"notional_usd={body.get('notional_usd', '-')}")
print(f"reference_price={body.get('reference_price', '-')}")
print(f"limit_price={body.get('limit_price', '-')}")
print(f"create_status={create.get('status', '-')}")
print(f"create_order_id={create.get('order_id', '-')}")
print(f"cancel_status={cancel.get('status', '-')}")
PY