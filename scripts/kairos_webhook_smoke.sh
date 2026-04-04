#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib/control_plane_helpers.sh
. "$SCRIPT_DIR/lib/control_plane_helpers.sh"

txt_source_repo_env

CONTROL_PLANE_URL="$(txt_resolve_control_plane_url "${CONTROL_PLANE_URL:-}")"
PLATFORM_ID="${PLATFORM_ID:-kairos}"
ROUTE_KEY="${ROUTE_KEY:-default}"
SYMBOL="${SYMBOL:-BTCUSDT}"
SIDE="${SIDE:-buy}"
NOTIONAL_USD="${NOTIONAL_USD:-7}"
USERNAME="${USERNAME:-operator}"
PASSWORD="${PASSWORD:-}"
WEBHOOK_SECRET="${WEBHOOK_SECRET:-${KAIROS_WEBHOOK_SECRET:-}}"
WEBHOOK_SECRET_FILE="${WEBHOOK_SECRET_FILE:-${KAIROS_WEBHOOK_SECRET_FILE:-}}"
AUTO_FLATTEN="${AUTO_FLATTEN:-0}"
CONFIRM_FLATTEN="${CONFIRM_FLATTEN:-BINGX_FLATTEN}"
PRINT_RAW="${PRINT_RAW:-0}"
CURL_INSECURE="${CURL_INSECURE:-0}"

usage() {
  cat <<'EOF'
Usage: kairos_webhook_smoke.sh [options]

Options:
  --control-plane-url URL    Control-plane base URL
  --platform-id VALUE        Platform source id (default: kairos)
  --route-key VALUE          Integration route key (default: default)
  --symbol VALUE             Symbol to route (default: BTCUSDT)
  --side VALUE               buy or sell (default: buy)
  --notional-usd VALUE       Estimated notional in USD (default: 7)
  --username VALUE           Login username for optional auto-flatten (default: operator)
  --password VALUE           Login password for optional auto-flatten
  --webhook-secret VALUE     Optional X-Platform-Secret value
  --auto-flatten             After a live BingX fill, login and flatten the opened position
  --confirm-flatten VALUE    Flatten confirmation text (default: BINGX_FLATTEN)
  --print-raw                Print raw JSON response
  --insecure                 Pass -k to curl
  -h, --help                 Show help

Notes:
  - This hits the generic control-plane webhook exactly like Kairos live handoff.
  - A 409 response means the route asked for live but control-plane gates still blocked it.
  - A 200 response with execution payload means the handoff reached execution-router.
  - --auto-flatten is explicit and only applies when the mapped route is live on BingX.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --control-plane-url) CONTROL_PLANE_URL="$2"; shift 2 ;;
    --platform-id) PLATFORM_ID="$2"; shift 2 ;;
    --route-key) ROUTE_KEY="$2"; shift 2 ;;
    --symbol) SYMBOL="$2"; shift 2 ;;
    --side) SIDE="$2"; shift 2 ;;
    --notional-usd) NOTIONAL_USD="$2"; shift 2 ;;
    --username) USERNAME="$2"; shift 2 ;;
    --password) PASSWORD="$2"; shift 2 ;;
    --webhook-secret) WEBHOOK_SECRET="$2"; shift 2 ;;
    --auto-flatten) AUTO_FLATTEN="1"; shift 1 ;;
    --confirm-flatten) CONFIRM_FLATTEN="$2"; shift 2 ;;
    --print-raw) PRINT_RAW="1"; shift 1 ;;
    --insecure) CURL_INSECURE="1"; shift 1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 2 ;;
  esac
done

if [ "$SIDE" != "buy" ] && [ "$SIDE" != "sell" ]; then
  echo "invalid_side: expected buy or sell" >&2
  exit 3
fi

if [ -z "$WEBHOOK_SECRET" ]; then
  WEBHOOK_SECRET="$(txt_resolve_secret "$WEBHOOK_SECRET" "$WEBHOOK_SECRET_FILE" || true)"
fi

if [ "$AUTO_FLATTEN" = "1" ] && [ -z "$PASSWORD" ]; then
  PASSWORD="$(txt_resolve_user_password "$USERNAME" "$PASSWORD" || true)"
fi

if [ "$AUTO_FLATTEN" = "1" ] && [ -z "$PASSWORD" ]; then
  echo "auto_flatten_auth_error: password missing for user '$USERNAME'" >&2
  exit 4
fi

REQUEST_BODY="$(python3 - <<PY
import json
from uuid import uuid4

body = {
    "route_key": ${ROUTE_KEY@Q},
    "decision_id": f"kairos-smoke-{uuid4().hex[:20]}",
    "symbol": ${SYMBOL@Q},
    "side": ${SIDE@Q},
    "estimated_notional_usd": float(${NOTIONAL_USD@Q}),
    "metadata": {"source": "kairos-webhook-smoke"},
}
print(json.dumps(body))
PY
)"

HTTP_RESULT="$(CONTROL_PLANE_URL="$CONTROL_PLANE_URL" PLATFORM_ID="$PLATFORM_ID" WEBHOOK_SECRET="$WEBHOOK_SECRET" REQUEST_BODY="$REQUEST_BODY" CURL_INSECURE="$CURL_INSECURE" python3 - <<'PY'
import os
import ssl
import urllib.error
import urllib.request


def context():
  return ssl._create_unverified_context() if os.environ.get("CURL_INSECURE") == "1" else None


headers = {"content-type": "application/json"}
if os.environ.get("WEBHOOK_SECRET"):
  headers["X-Platform-Secret"] = os.environ["WEBHOOK_SECRET"]

request = urllib.request.Request(
  f"{os.environ['CONTROL_PLANE_URL'].rstrip('/')}/v1/integrations/platforms/{os.environ['PLATFORM_ID']}/webhook",
  data=os.environ["REQUEST_BODY"].encode("utf-8"),
  headers=headers,
  method="POST",
)
try:
  with urllib.request.urlopen(request, timeout=30, context=context()) as response:
    status = response.getcode()
    body = response.read().decode("utf-8")
except urllib.error.HTTPError as exc:
  status = exc.code
  body = exc.read().decode("utf-8")

print(status)
print(body)
PY
)"
HTTP_STATUS="$(printf '%s\n' "$HTTP_RESULT" | sed -n '1p')"
RESPONSE_BODY="$(printf '%s\n' "$HTTP_RESULT" | sed -n '2,$p')"

AUTO_FLATTEN_RESULT=""
if [ "$AUTO_FLATTEN" = "1" ]; then
  AUTO_FLATTEN_RESULT="$(CONTROL_PLANE_URL="$CONTROL_PLANE_URL" HTTP_STATUS_VALUE="$HTTP_STATUS" RESPONSE_BODY_JSON="$RESPONSE_BODY" USERNAME="$USERNAME" PASSWORD="$PASSWORD" SYMBOL="$SYMBOL" SIDE="$SIDE" CURL_INSECURE="$CURL_INSECURE" CONFIRM_FLATTEN="$CONFIRM_FLATTEN" python3 - <<'PY'
import json
import os
import ssl
import urllib.error
import urllib.request


def context():
  return ssl._create_unverified_context() if os.environ.get("CURL_INSECURE") == "1" else None


def post_json(url: str, payload: dict, headers: dict[str, str] | None = None) -> tuple[int, dict | str]:
  request = urllib.request.Request(
    url,
    data=json.dumps(payload).encode("utf-8"),
    headers={"content-type": "application/json", **(headers or {})},
    method="POST",
  )
  try:
    with urllib.request.urlopen(request, timeout=30, context=context()) as response:
      status = response.getcode()
      body = response.read().decode("utf-8")
  except urllib.error.HTTPError as exc:
    status = exc.code
    body = exc.read().decode("utf-8")

  try:
    parsed = json.loads(body)
  except Exception:
    parsed = body
  return status, parsed


try:
  http_status = int(os.environ.get("HTTP_STATUS_VALUE") or "0")
except Exception:
  http_status = 0

try:
  webhook_body = json.loads(os.environ.get("RESPONSE_BODY_JSON") or "{}")
except Exception:
  print(json.dumps({"status": "skipped", "reason": "webhook_response_not_json"}))
  raise SystemExit(0)

if http_status >= 400 or not isinstance(webhook_body, dict):
  print(json.dumps({"status": "skipped", "reason": "webhook_not_successful", "http_status": http_status}))
  raise SystemExit(0)

route = webhook_body.get("route") if isinstance(webhook_body.get("route"), dict) else {}
execution = webhook_body.get("execution") if isinstance(webhook_body.get("execution"), dict) else {}
live_execution = execution.get("live_execution") if isinstance(execution.get("live_execution"), dict) else {}
provider = str(route.get("provider") or live_execution.get("provider") or "").strip().lower()
account_id = str(route.get("account_id") or live_execution.get("account_id") or "").strip()
symbol = str(execution.get("instrument") or os.environ.get("SYMBOL") or "").strip().upper()
position_side = str(live_execution.get("position_side") or ("LONG" if str(os.environ.get("SIDE") or "buy").strip().lower() == "buy" else "SHORT")).strip().upper()

if provider != "bingx":
  print(json.dumps({"status": "skipped", "reason": "provider_not_bingx", "provider": provider or None}))
  raise SystemExit(0)
if not account_id:
  print(json.dumps({"status": "skipped", "reason": "route_account_missing"}))
  raise SystemExit(0)
if not bool(live_execution.get("enabled")):
  print(json.dumps({"status": "skipped", "reason": "live_execution_not_enabled", "account_id": account_id}))
  raise SystemExit(0)

login_status, login_body = post_json(
  f"{os.environ['CONTROL_PLANE_URL'].rstrip('/')}/v1/auth/login",
  {"username": os.environ.get("USERNAME") or "operator", "password": os.environ.get("PASSWORD") or ""},
)
if login_status >= 400 or not isinstance(login_body, dict) or not str(login_body.get("access_token") or "").strip():
  print(json.dumps({"status": "error", "reason": "login_failed", "http_status": login_status, "detail": login_body}))
  raise SystemExit(0)

flatten_payload = {
  "account_id": account_id,
  "symbol": symbol,
  "confirmation_text": os.environ.get("CONFIRM_FLATTEN") or "BINGX_FLATTEN",
}
if position_side in {"LONG", "SHORT", "BOTH"}:
  flatten_payload["position_side"] = position_side

flatten_status, flatten_body = post_json(
  f"{os.environ['CONTROL_PLANE_URL'].rstrip('/')}/v1/connectors/bingx/flatten",
  flatten_payload,
  headers={"Authorization": f"Bearer {login_body['access_token']}"},
)
if isinstance(flatten_body, dict):
  flatten_body.setdefault("http_status", flatten_status)
print(json.dumps(flatten_body))
PY
)"
fi

if [ "$PRINT_RAW" = "1" ]; then
  printf 'http_status=%s\n' "$HTTP_STATUS"
  printf '%s\n' "$RESPONSE_BODY"
  if [ -n "$AUTO_FLATTEN_RESULT" ]; then
    printf 'auto_flatten=%s\n' "$AUTO_FLATTEN_RESULT"
  fi
  exit 0
fi

HTTP_STATUS_VALUE="$HTTP_STATUS" RESPONSE_BODY_JSON="$RESPONSE_BODY" AUTO_FLATTEN_RESULT_JSON="$AUTO_FLATTEN_RESULT" python3 - <<'PY'
import json
import os

status = os.environ["HTTP_STATUS_VALUE"]
body = json.loads(os.environ["RESPONSE_BODY_JSON"])
flatten_raw = os.environ.get("AUTO_FLATTEN_RESULT_JSON") or ""
flatten = json.loads(flatten_raw) if flatten_raw else None
print(f"http_status={status}")
if isinstance(body, dict):
    print(f"status={body.get('status', '-')}")
    detail = body.get("detail")
    if isinstance(detail, dict):
        print(f"detail_status={detail.get('status', '-')}")
        print(f"detail_provider={detail.get('provider', '-')}")
        print(f"detail_account_id={detail.get('account_id', '-')}")
        reasons = detail.get("reasons") if isinstance(detail.get("reasons"), list) else []
        print(f"detail_reasons={','.join(str(item) for item in reasons) if reasons else '-'}")
    execution = body.get("execution") if isinstance(body.get("execution"), dict) else {}
    if execution:
        print(f"execution_status={execution.get('status', '-')}")
        print(f"execution_order_id={execution.get('order_id', '-')}")
        print(f"execution_live={execution.get('live_execution', {}).get('enabled', '-') if isinstance(execution.get('live_execution'), dict) else '-'}")
if isinstance(flatten, dict):
    print(f"flatten_status={flatten.get('status', '-')}")
    print(f"flatten_reason={flatten.get('reason', '-')}")
    print(f"flatten_http_status={flatten.get('http_status', '-')}")
    before = flatten.get('positions_before') if isinstance(flatten.get('positions_before'), list) else []
    results = flatten.get('close_results') if isinstance(flatten.get('close_results'), list) else []
    after = flatten.get('positions_after') if isinstance(flatten.get('positions_after'), list) else []
    print(f"flatten_positions_before={len(before)}")
    print(f"flatten_close_results={len(results)}")
    print(f"flatten_positions_after={len(after)}")
PY