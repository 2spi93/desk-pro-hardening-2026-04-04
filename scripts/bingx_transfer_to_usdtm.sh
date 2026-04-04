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
AMOUNT="${AMOUNT:-}"
ASSET="${ASSET:-USDT}"
FROM_ACCOUNT_TYPE="${FROM_ACCOUNT_TYPE:-spot}"
TO_ACCOUNT_TYPE="${TO_ACCOUNT_TYPE:-usdtm_perp}"
CONFIRM_TRANSFER="${CONFIRM_TRANSFER:-}"
DRY_RUN="${DRY_RUN:-0}"
PRINT_RAW="${PRINT_RAW:-0}"
CURL_INSECURE="${CURL_INSECURE:-0}"

usage() {
  cat <<'EOF'
Usage: bingx_transfer_to_usdtm.sh [options]

Options:
  --control-plane-url URL    Control-plane base URL (default: http://127.0.0.1:8000)
  --username NAME            Login username (default: operator)
  --password VALUE           Login password (default: resolved from .env/secrets)
  --account-id VALUE         Linked BingX account id (required)
  --amount VALUE             Transfer amount in asset units (required)
  --asset VALUE              Asset symbol (default: USDT)
  --from VALUE               Source pocket alias/code (default: spot)
  --to VALUE                 Destination pocket alias/code (default: usdtm_perp)
  --confirm-transfer VALUE   Must equal BINGX_TRANSFER unless --dry-run is used
  --dry-run                  Preview only, no transfer sent to BingX
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
    --amount) AMOUNT="$2"; shift 2 ;;
    --asset) ASSET="$2"; shift 2 ;;
    --from) FROM_ACCOUNT_TYPE="$2"; shift 2 ;;
    --to) TO_ACCOUNT_TYPE="$2"; shift 2 ;;
    --confirm-transfer) CONFIRM_TRANSFER="$2"; shift 2 ;;
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

if [ -z "$AMOUNT" ]; then
  echo "amount_missing: pass --amount or set AMOUNT" >&2
  exit 4
fi

if [ "$DRY_RUN" != "1" ] && [ "$CONFIRM_TRANSFER" != "BINGX_TRANSFER" ]; then
  echo "confirmation_missing: pass --confirm-transfer BINGX_TRANSFER or use --dry-run" >&2
  exit 5
fi

if [ -z "$PASSWORD" ]; then
  echo "auth_error: password missing for user '$USERNAME'" >&2
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
    "amount": float(${AMOUNT@Q}),
    "asset": ${ASSET@Q},
    "from_account_type": ${FROM_ACCOUNT_TYPE@Q},
    "to_account_type": ${TO_ACCOUNT_TYPE@Q},
}
if ${DRY_RUN@Q} == "1":
    body["dry_run"] = True
else:
    body["confirmation_text"] = ${CONFIRM_TRANSFER@Q}
print(json.dumps(body))
PY
)"

RESPONSE_BODY="$(curl "${CURL_TLS_FLAG[@]}" --max-time 40 -sS \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -X POST "$CONTROL_PLANE_URL/v1/connectors/bingx/transfer" \
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
print(f"asset={body.get('asset', '-')}")
print(f"amount={body.get('amount', '-')}")
source = body.get('from_account_type') if isinstance(body.get('from_account_type'), dict) else {}
target = body.get('to_account_type') if isinstance(body.get('to_account_type'), dict) else {}
print(f"from_account_type={source.get('label', source.get('code', '-'))}")
print(f"to_account_type={target.get('label', target.get('code', '-'))}")
if body.get('status') == 'dry_run':
    before = body.get('before') if isinstance(body.get('before'), dict) else {}
    overview = before.get('account_overview') if isinstance(before.get('account_overview'), list) else []
    print(f"before_account_overview_count={len(overview)}")
else:
    transfer = body.get('transfer') if isinstance(body.get('transfer'), dict) else {}
    print(f"transfer_id={transfer.get('tranId', transfer.get('id', '-'))}")
PY