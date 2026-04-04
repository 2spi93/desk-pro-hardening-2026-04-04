#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
HOST_HEADER="${HOST_HEADER:-app.txt.gtixt.com}"
USERNAME="${USERNAME:-operator}"
PASSWORD="${PASSWORD:-}"
SYMBOL="${SYMBOL:-BTCUSD}"
ACCOUNT_ID="${ACCOUNT_ID:-mt5-demo-01}"
WS_PATH="${WS_PATH:-/ws/v1/market/quotes}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

check_http() {
  local url="$1"
  local expect_regex="$2"
  local code
  local curl_tls_flag=""
  case "$url" in
    https://*) curl_tls_flag="-k" ;;
  esac
  code="$(curl $curl_tls_flag --max-time 20 -sS -o /tmp/post_deploy_smoke_body.out -w '%{http_code}' -H "Host: $HOST_HEADER" "$url" || echo 000)"
  if [[ ! "$code" =~ $expect_regex ]]; then
    echo "[fail] $url -> $code (expected: $expect_regex)"
    head -c 240 /tmp/post_deploy_smoke_body.out || true
    echo
    return 1
  fi
  echo "[ok]   $url -> $code"
}

echo "[1/5] Core health checks"
check_http "http://127.0.0.1:8000/health" '^(200)$'
check_http "http://127.0.0.1:8003/health" '^(200)$'
check_http "http://127.0.0.1:8001/health" '^(200)$'
check_http "http://127.0.0.1:8004/health" '^(200)$'

echo "[2/5] Gateway/UI checks"
check_http "$BASE_URL/" '^(200)$'
check_http "http://127.0.0.1/healthz" '^(200)$'
check_http "https://127.0.0.1/healthz" '^(200)$'

echo "[3/5] Next static asset checks"
"$ROOT_DIR/scripts/check_ui_static_assets.sh" --base-url "$BASE_URL" --host "$HOST_HEADER"

# These endpoints are expected to be protected when called without auth.
check_http "$BASE_URL/api/auth/ws-token" '^(200|401)$'
check_http "$BASE_URL/api/connectors/status" '^(200|401)$'
check_http "$BASE_URL/api/mt5/health" '^(200|401)$'

echo "[4/5] Authenticated API + WS 101 E2E"
if [[ -n "$PASSWORD" ]]; then
  "$ROOT_DIR/scripts/mc-auth-smoke.sh" \
    --base-url "$BASE_URL" \
    --host "$HOST_HEADER" \
    --insecure \
    --username "$USERNAME" \
    --password "$PASSWORD" \
    --symbol "$SYMBOL" \
    --account-id "$ACCOUNT_ID" \
    --ws-path "$WS_PATH"
else
  "$ROOT_DIR/scripts/mc-auth-smoke.sh" \
    --base-url "$BASE_URL" \
    --host "$HOST_HEADER" \
    --insecure \
    --username "$USERNAME" \
    --symbol "$SYMBOL" \
    --account-id "$ACCOUNT_ID" \
    --ws-path "$WS_PATH"
fi

echo "[5/5] Post-deploy smoke completed"
