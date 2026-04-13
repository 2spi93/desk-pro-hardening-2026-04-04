#!/usr/bin/env sh
set -eu

ROOT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
OUTPUT_FILE="$(mktemp)"
trap 'rm -f "$OUTPUT_FILE"' EXIT
PROFILE="${1:-${MC_CONTROL_PLANE_PROFILE:-staging}}"
PROFILE_FILE="$ROOT_DIR/ui/mission-control/.env.control-plane.$PROFILE"

if [ ! -f "$PROFILE_FILE" ]; then
  echo "[qa:real-cp] missing profile file: $PROFILE_FILE"
  echo "[qa:real-cp] create it from .env.control-plane.$PROFILE.example"
  exit 1
fi

set -a
. "$PROFILE_FILE"
set +a

if [ -z "${CONTROL_PLANE_URL:-}" ] || [ -z "${CONTROL_PLANE_TOKEN:-}" ]; then
  echo "[qa:real-cp] CONTROL_PLANE_URL and CONTROL_PLANE_TOKEN must be set in $PROFILE_FILE"
  exit 1
fi

echo "[qa:real-cp] profile=$PROFILE"
echo "[qa:real-cp] CONTROL_PLANE_URL=$CONTROL_PLANE_URL"

if MC_E2E_DEV_DEGRADED=0 sh /opt/txt/qa-mission-control.sh >"$OUTPUT_FILE" 2>&1; then
  :
else
  cat "$OUTPUT_FILE"
  echo "[qa:real-cp] FAILED: wrapper command returned non-zero"
  exit 1
fi

cat "$OUTPUT_FILE"

if grep -Eq "ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|getaddrinfo|control_plane_unreachable_e2e_dev|\[mc:e2e-dev\]|cpFetch \(lib/controlPlane.ts:" "$OUTPUT_FILE"; then
  echo "[qa:real-cp] FAILED: control-plane appears unreachable or degraded/network fetch errors surfaced"
  exit 1
fi

echo "[qa:real-cp] PASS: control-plane reachable and no degraded/network fetch errors detected"
