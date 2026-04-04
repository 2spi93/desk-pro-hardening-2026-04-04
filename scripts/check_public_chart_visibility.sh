#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_ROOT="${ROOT_DIR}/logs/healthwatch/public-chart"
mkdir -p "$LOG_ROOT"

UI_BASE_URL="${UI_BASE_URL:-https://app.txt.gtixt.com}"
PLAYWRIGHT_IMAGE="${PLAYWRIGHT_IMAGE:-mcr.microsoft.com/playwright:v1.58.2-jammy}"
CHART_DIAG_PASSWORD_FILE="${CHART_DIAG_PASSWORD_FILE:-${ROOT_DIR}/secrets/default_operator_password}"
PUBLIC_CHART_MAX_BARS_STALE_MS="${PUBLIC_CHART_MAX_BARS_STALE_MS:-30000}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="${LOG_ROOT}/${STAMP}"
mkdir -p "$OUT_DIR"

PASSWORD="$(tr -d '\r\n' < "$CHART_DIAG_PASSWORD_FILE")"
COOKIE_JAR="$(mktemp)"
AUTH_HEADERS="$(mktemp)"
trap 'rm -f "$COOKIE_JAR" "$AUTH_HEADERS"' EXIT

curl -ksS -D "$AUTH_HEADERS" -c "$COOKIE_JAR" -X POST "${UI_BASE_URL}/api/auth/login" \
  -d 'username=operator' \
  --data-urlencode "password=${PASSWORD}" >/dev/null

MC_TOKEN="$(tr -d '\r' < "$AUTH_HEADERS" | sed -n 's/^set-cookie: mc_token=\([^;]*\).*/\1/ip' | tail -n 1)"

if [[ -z "$MC_TOKEN" ]]; then
  MC_TOKEN="$(awk -F '\t' '($6 == "mc_token" || $7 == "mc_token") { print ($7 == "mc_token" ? $8 : $7) }' "$COOKIE_JAR" | tail -n 1)"
fi

if [[ -z "$MC_TOKEN" ]]; then
  echo "public chart diagnostic could not extract mc_token" >&2
  exit 1
fi

docker run --rm \
  --network host \
  -v "${ROOT_DIR}:/workspace" \
  -w /workspace/ui/mission-control \
  -e "MC_TOKEN=${MC_TOKEN}" \
  -e "PUBLIC_CHART_MAX_BARS_STALE_MS=${PUBLIC_CHART_MAX_BARS_STALE_MS}" \
  -v "${OUT_DIR}:/artifacts" \
  "$PLAYWRIGHT_IMAGE" \
  bash -lc 'node scripts/chart_stability_diagnose_playwright.js' | tee "$OUT_DIR/diagnostic.json"

ln -sfn "$OUT_DIR" "$LOG_ROOT/latest"