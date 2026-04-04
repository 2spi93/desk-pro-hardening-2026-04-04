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
ROUTE_KEY="${ROUTE_KEY:-default}"
SOURCE="${SOURCE:-kairos}"
NOTIONAL_USD="${NOTIONAL_USD:-7}"
LIVE_ENABLED="${LIVE_ENABLED:-0}"
PRINT_RAW="${PRINT_RAW:-0}"
CURL_INSECURE="${CURL_INSECURE:-0}"

usage() {
  cat <<'EOF'
Usage: configure_kairos_bingx_route.sh [options]

Options:
  --control-plane-url URL    Control-plane base URL
  --username NAME            Login username (default: operator)
  --password VALUE           Login password
  --account-id VALUE         Linked BingX trade account id (required)
  --route-key VALUE          Integration route key (default: default)
  --source VALUE             Platform source name (default: kairos)
  --notional-usd VALUE       Route notional in USD (default: 7)
  --live-enabled 0|1         Route live flag (default: 0)
  --print-raw                Print raw JSON response
  --insecure                 Pass -k to curl
  -h, --help                 Show help

Notes:
  - This upserts the control-plane integration route consumed by Kairos.
  - With --live-enabled 1, the route targets real BingX execution.
  - Live execution still depends on global policy, env gates, and linked trade credentials.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --control-plane-url) CONTROL_PLANE_URL="$2"; shift 2 ;;
    --username) USERNAME="$2"; shift 2 ;;
    --password) PASSWORD="$2"; shift 2 ;;
    --account-id) ACCOUNT_ID="$2"; shift 2 ;;
    --route-key) ROUTE_KEY="$2"; shift 2 ;;
    --source) SOURCE="$2"; shift 2 ;;
    --notional-usd) NOTIONAL_USD="$2"; shift 2 ;;
    --live-enabled) LIVE_ENABLED="$2"; shift 2 ;;
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

if [ "$LIVE_ENABLED" != "0" ] && [ "$LIVE_ENABLED" != "1" ]; then
  echo "invalid_live_enabled: expected 0 or 1" >&2
  exit 4
fi

if [ -z "$PASSWORD" ]; then
  echo "auth_error: password missing for user '$USERNAME'" >&2
  exit 5
fi

REQUEST_BODY="$(python3 - <<PY
import json

live_enabled = ${LIVE_ENABLED@Q} == "1"
body = {
    "source": ${SOURCE@Q},
    "route_key": ${ROUTE_KEY@Q},
    "provider": "bingx",
    "account_id": ${ACCOUNT_ID@Q},
    "live_enabled": live_enabled,
    "preferred_venue": "bingx" if live_enabled else "paper-bingx",
    "notional_usd": float(${NOTIONAL_USD@Q}),
}
print(json.dumps(body))
PY
)"

RESPONSE_BODY="$(CONTROL_PLANE_URL="$CONTROL_PLANE_URL" USERNAME="$USERNAME" PASSWORD="$PASSWORD" REQUEST_BODY="$REQUEST_BODY" CURL_INSECURE="$CURL_INSECURE" python3 - <<'PY'
import json
import os
import ssl
import urllib.request


def context():
  return ssl._create_unverified_context() if os.environ.get("CURL_INSECURE") == "1" else None


base = os.environ["CONTROL_PLANE_URL"].rstrip("/")
login_payload = json.dumps(
  {"username": os.environ["USERNAME"], "password": os.environ["PASSWORD"]}
).encode("utf-8")
login_request = urllib.request.Request(
  f"{base}/v1/auth/login",
  data=login_payload,
  headers={"content-type": "application/json"},
  method="POST",
)
with urllib.request.urlopen(login_request, timeout=20, context=context()) as response:
  token = json.load(response).get("access_token", "")

if not token:
  raise SystemExit("login_failed: no access token returned")

route_request = urllib.request.Request(
  f"{base}/v1/integrations/routes",
  data=os.environ["REQUEST_BODY"].encode("utf-8"),
  headers={
    "content-type": "application/json",
    "authorization": f"Bearer {token}",
  },
  method="POST",
)
with urllib.request.urlopen(route_request, timeout=25, context=context()) as response:
  print(response.read().decode("utf-8"))
PY
)"

if [ "$PRINT_RAW" = "1" ]; then
  printf '%s\n' "$RESPONSE_BODY"
  exit 0
fi

RESPONSE_BODY_JSON="$RESPONSE_BODY" python3 - <<'PY'
import json
import os

body = json.loads(os.environ["RESPONSE_BODY_JSON"])
routes = body.get("routes") if isinstance(body.get("routes"), list) else []
selected = None
for item in routes:
    if str(item.get("source", "")).strip().lower() == "kairos":
        selected = item
        if str(item.get("route_key", "default")).strip().lower() == "default":
            break

print(f"status={body.get('status', '-')}")
if isinstance(selected, dict):
    print(f"source={selected.get('source', '-')}")
    print(f"route_key={selected.get('route_key', '-')}")
    print(f"provider={selected.get('provider', '-')}")
    print(f"account_id={selected.get('account_id', '-')}")
    print(f"live_enabled={selected.get('live_enabled', '-')}")
    print(f"preferred_venue={selected.get('preferred_venue', '-')}")
    print(f"notional_usd={selected.get('notional_usd', '-')}")
PY