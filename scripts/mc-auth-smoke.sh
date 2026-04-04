#!/usr/bin/env sh
set -eu

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
HOST_HEADER="${HOST_HEADER:-app.txt.gtixt.com}"
USERNAME="${USERNAME:-operator}"
PASSWORD="${PASSWORD:-}"
NEW_PASSWORD="${NEW_PASSWORD:-}"
CONFIRM_PASSWORD="${CONFIRM_PASSWORD:-}"
SYMBOL="${SYMBOL:-BTCUSD}"
ACCOUNT_ID="${ACCOUNT_ID:-mt5-demo-01}"
WS_E2E="${WS_E2E:-1}"
WS_PATH="${WS_PATH:-/ws/v1/market/quotes}"
CURL_INSECURE="${CURL_INSECURE:-0}"
SKIP_API_SMOKE="${SKIP_API_SMOKE:-0}"

usage() {
  cat <<'EOF'
Usage: mc-auth-smoke.sh [options]

Options:
  --base-url URL             Base URL (default: http://127.0.0.1:3000)
  --host HOST                Host header (default: app.txt.gtixt.com)
  --username NAME            Login username (default: operator)
  --password VALUE           Login password (default: resolved from .env defaults)
  --new-password VALUE       Optional: rotate password after login
  --confirm-password VALUE   Optional: confirmation for --new-password
  --symbol VALUE             Symbol for smoke calls (default: BTCUSD)
  --account-id VALUE         Account id for risk-history smoke (default: mt5-demo-01)
  --ws-path VALUE            WS path to test (default: /ws/v1/market/quotes)
  --skip-api-smoke           Skip authenticated HTTP API smoke and only validate login/ws-token/WS E2E
  --skip-ws-e2e              Skip authenticated WS 101 check
  --insecure                 Pass -k to curl (useful for self-signed certs)
  -h, --help                 Show help

Environment fallbacks:
  BASE_URL, HOST_HEADER, USERNAME, PASSWORD, NEW_PASSWORD, CONFIRM_PASSWORD, SYMBOL, ACCOUNT_ID, WS_E2E, WS_PATH, CURL_INSECURE, SKIP_API_SMOKE

Notes:
  - If --password is omitted, script resolves password from /opt/txt/.env using:
    DEFAULT_OPERATOR_PASSWORD(_FILE), DEFAULT_ADMIN_PASSWORD(_FILE), DEFAULT_VIEWER_PASSWORD(_FILE)
  - Does not print secrets.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --base-url) BASE_URL="$2"; shift 2 ;;
    --host) HOST_HEADER="$2"; shift 2 ;;
    --username) USERNAME="$2"; shift 2 ;;
    --password) PASSWORD="$2"; shift 2 ;;
    --new-password) NEW_PASSWORD="$2"; shift 2 ;;
    --confirm-password) CONFIRM_PASSWORD="$2"; shift 2 ;;
    --symbol) SYMBOL="$2"; shift 2 ;;
    --account-id) ACCOUNT_ID="$2"; shift 2 ;;
    --ws-path) WS_PATH="$2"; shift 2 ;;
    --skip-api-smoke) SKIP_API_SMOKE="1"; shift 1 ;;
    --skip-ws-e2e) WS_E2E="0"; shift 1 ;;
    --insecure) CURL_INSECURE="1"; shift 1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 2 ;;
  esac
done

resolve_secret() {
  value="$1"
  file_path="$2"
  if [ -n "$value" ]; then
    printf "%s" "$value"
    return 0
  fi
  if [ -n "$file_path" ] && [ -f "$file_path" ]; then
    tr -d '\n' < "$file_path"
    return 0
  fi
  if [ -n "$file_path" ]; then
    file_name="$(basename "$file_path")"
    for alt in "/opt/txt/secrets/$file_name" "/root/txt/secrets/$file_name"; do
      if [ -f "$alt" ]; then
        tr -d '\n' < "$alt"
        return 0
      fi
    done
  fi
  return 1
}

if [ -f /opt/txt/.env ]; then
  # shellcheck disable=SC1091
  set -a
  . /opt/txt/.env
  set +a
fi

if [ -z "$PASSWORD" ]; then
  case "$USERNAME" in
    operator)
      PASSWORD="$(resolve_secret "${DEFAULT_OPERATOR_PASSWORD:-}" "${DEFAULT_OPERATOR_PASSWORD_FILE:-}" || true)"
      ;;
    admin)
      PASSWORD="$(resolve_secret "${DEFAULT_ADMIN_PASSWORD:-}" "${DEFAULT_ADMIN_PASSWORD_FILE:-}" || true)"
      ;;
    viewer)
      PASSWORD="$(resolve_secret "${DEFAULT_VIEWER_PASSWORD:-}" "${DEFAULT_VIEWER_PASSWORD_FILE:-}" || true)"
      ;;
  esac
fi

if [ -z "$PASSWORD" ]; then
  echo "auth_error: password missing for user '$USERNAME'" >&2
  exit 3
fi

if [ -n "$NEW_PASSWORD" ] && [ -z "$CONFIRM_PASSWORD" ]; then
  CONFIRM_PASSWORD="$NEW_PASSWORD"
fi

COOKIE_FILE="/tmp/mc_auth_cookie.txt"
rm -f "$COOKIE_FILE"

CURL_TLS_FLAG=""
if [ "$CURL_INSECURE" = "1" ]; then
  CURL_TLS_FLAG="-k"
fi

AUTH_BASE_URL="$BASE_URL"

login_code="$(curl --max-time 20 -s -o /tmp/mc_login_body.txt -D /tmp/mc_login_headers.txt -c "$COOKIE_FILE" -b "$COOKIE_FILE" -w '%{http_code}' \
  -H "Host: $HOST_HEADER" \
  -H 'content-type: application/json' \
  -X POST "$BASE_URL/api/auth/login" \
  --data "{\"username\":\"$USERNAME\",\"password\":\"$PASSWORD\"}")"

login_location="$(grep -i '^location:' /tmp/mc_login_headers.txt | tail -n 1 | tr -d '\r' | cut -d' ' -f2-)"

if grep -qi '^set-cookie: .*;.*Secure' /tmp/mc_login_headers.txt; then
  case "$BASE_URL" in
    http://*) AUTH_BASE_URL="https://$HOST_HEADER" ;;
  esac
fi

if [ "$login_code" != "302" ] && [ "$login_code" != "303" ] && [ "$login_code" != "307" ]; then
  echo "login_failed: status=$login_code"
  exit 4
fi

if echo "$login_location" | grep -q 'error=1'; then
  echo "login_failed: invalid_credentials"
  exit 5
fi

if [ -n "$NEW_PASSWORD" ]; then
  cp_code="$(curl --max-time 20 -s -o /tmp/mc_change_password_body.txt -D /tmp/mc_change_password_headers.txt -b "$COOKIE_FILE" -c "$COOKIE_FILE" -w '%{http_code}' \
    $CURL_TLS_FLAG \
    -H "Host: $HOST_HEADER" \
    -H 'content-type: application/x-www-form-urlencoded' \
    -X POST "$AUTH_BASE_URL/api/auth/change-password" \
    --data "old_password=$(printf '%s' "$PASSWORD" | sed 's/%/%25/g; s/&/%26/g; s/=/%3D/g')&new_password=$(printf '%s' "$NEW_PASSWORD" | sed 's/%/%25/g; s/&/%26/g; s/=/%3D/g')&confirm_password=$(printf '%s' "$CONFIRM_PASSWORD" | sed 's/%/%25/g; s/&/%26/g; s/=/%3D/g')")"
  cp_location="$(grep -i '^location:' /tmp/mc_change_password_headers.txt | tail -n 1 | tr -d '\r' | cut -d' ' -f2-)"
  if [ "$cp_code" != "302" ] && [ "$cp_code" != "303" ] && [ "$cp_code" != "307" ]; then
    echo "change_password_failed: status=$cp_code"
    exit 6
  fi
  if echo "$cp_location" | grep -q 'error=1'; then
    echo "change_password_failed: rejected"
    exit 7
  fi
  echo "change_password_ok"
fi

if [ "$SKIP_API_SMOKE" != "1" ]; then
  risk_code="$(curl --max-time 20 -s -o /tmp/mc_risk_history_body.json -w '%{http_code}' -b "$COOKIE_FILE" \
    $CURL_TLS_FLAG \
    -H "Host: $HOST_HEADER" \
    -H 'x-mc-origin: terminal' \
    -H 'x-mc-priority: high' \
    -H 'x-mc-requested-by: execution' \
    -H 'x-mc-signal-state: danger' \
    -H 'x-mc-volatility: high' \
    "$AUTH_BASE_URL/api/mt5/orders/risk-history?limit=120&symbol=$SYMBOL&account_id=$ACCOUNT_ID")"
  risk_bytes="$(wc -c < /tmp/mc_risk_history_body.json)"

  dom_code="$(curl --max-time 20 -s -o /tmp/mc_broker_orderbook_body.json -w '%{http_code}' -b "$COOKIE_FILE" \
    $CURL_TLS_FLAG \
    -H "Host: $HOST_HEADER" \
    -H 'x-mc-origin: terminal' \
    -H 'x-mc-priority: high' \
    -H 'x-mc-requested-by: execution' \
    -H 'x-mc-signal-state: danger' \
    -H 'x-mc-volatility: high' \
    "$AUTH_BASE_URL/api/broker/orderbook/binance/$SYMBOL?limit=20")"
  dom_bytes="$(wc -c < /tmp/mc_broker_orderbook_body.json)"

  echo "risk_history_auth $risk_code bytes=$risk_bytes"
  echo "broker_orderbook_auth $dom_code bytes=$dom_bytes"
fi

if [ "$WS_E2E" = "1" ]; then
  ws_token_code="$(curl --max-time 20 -s -o /tmp/mc_ws_token_body.json -w '%{http_code}' -b "$COOKIE_FILE" \
    $CURL_TLS_FLAG \
    -H "Host: $HOST_HEADER" \
    "$AUTH_BASE_URL/api/auth/ws-token")"

  if [ "$ws_token_code" != "200" ] && [ "$AUTH_BASE_URL" != "$BASE_URL" ]; then
    rm -f "$COOKIE_FILE"
    relogin_code="$(curl --max-time 20 -s -o /tmp/mc_login_body_retry.txt -D /tmp/mc_login_headers_retry.txt -c "$COOKIE_FILE" -b "$COOKIE_FILE" -w '%{http_code}' \
      $CURL_TLS_FLAG \
      -H "Host: $HOST_HEADER" \
      -H 'content-type: application/json' \
      -X POST "$AUTH_BASE_URL/api/auth/login" \
      --data "{\"username\":\"$USERNAME\",\"password\":\"$PASSWORD\"}")"
    relogin_location="$(grep -i '^location:' /tmp/mc_login_headers_retry.txt | tail -n 1 | tr -d '\r' | cut -d' ' -f2-)"
    if [ "$relogin_code" = "302" ] || [ "$relogin_code" = "303" ] || [ "$relogin_code" = "307" ]; then
      if ! echo "$relogin_location" | grep -q 'error=1'; then
        ws_token_code="$(curl --max-time 20 -s -o /tmp/mc_ws_token_body.json -w '%{http_code}' -b "$COOKIE_FILE" \
          $CURL_TLS_FLAG \
          -H "Host: $HOST_HEADER" \
          "$AUTH_BASE_URL/api/auth/ws-token")"
      fi
    fi
  fi

  if [ "$ws_token_code" != "200" ]; then
    echo "ws_token_failed: status=$ws_token_code"
    exit 8
  fi

  ws_token="$(python3 - <<'PY'
import json
from pathlib import Path

payload = json.loads(Path('/tmp/mc_ws_token_body.json').read_text(encoding='utf-8'))
token = str(payload.get('token') or '').strip()
print(token)
PY
)"

  if [ -z "$ws_token" ]; then
    echo "ws_token_failed: empty_token"
    exit 9
  fi

  if ! BASE_URL="$AUTH_BASE_URL" HOST_HEADER="$HOST_HEADER" WS_PATH="$WS_PATH" WS_TOKEN="$ws_token" CURL_INSECURE="$CURL_INSECURE" python3 - <<'PY'
import os
import ssl
from urllib.parse import parse_qsl, urlencode, urlparse

import websocket

base_url = os.environ['BASE_URL']
host_header = os.environ['HOST_HEADER']
ws_path = os.environ['WS_PATH']
token = os.environ['WS_TOKEN']
curl_insecure = os.environ.get('CURL_INSECURE', '0') == '1'

parsed = urlparse(base_url)
scheme = parsed.scheme.lower()
if scheme not in {'http', 'https'}:
    print('ws_e2e_error unsupported_base_url_scheme')
    raise SystemExit(2)

if not ws_path.startswith('/'):
    ws_path = '/' + ws_path

query = dict(parse_qsl(urlparse(ws_path).query, keep_blank_values=True))
query['token'] = token
path_only = urlparse(ws_path).path
request_path = path_only + '?' + urlencode(query)

port = parsed.port or (443 if scheme == 'https' else 80)
ws_scheme = 'wss' if scheme == 'https' else 'ws'
ws_url = f'{ws_scheme}://{parsed.hostname}:{port}{request_path}' if parsed.hostname else f'{ws_scheme}://127.0.0.1:{port}{request_path}'

sslopt = None
if ws_scheme == 'wss':
  sslopt = {'cert_reqs': ssl.CERT_NONE} if curl_insecure else {'cert_reqs': ssl.CERT_REQUIRED}

conn = websocket.create_connection(
  ws_url,
  timeout=8,
  host=host_header,
  origin='https://app.txt.gtixt.com',
  sslopt=sslopt,
)
print(f'ws_e2e_status connected {ws_url}')
conn.close()
PY
  then
    echo "ws_e2e_failed"
    exit 10
  fi
fi
