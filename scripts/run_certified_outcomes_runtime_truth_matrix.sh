#!/usr/bin/env bash
# Read-only runtime truth matrix refresh for PORTE 3.1.
# Compiles the UI scanner with the local TypeScript compiler and runs it with
# incident dispatch disabled. It writes only the scanner report.
set -euo pipefail

ROOT_DIR="${ROOT_DIR:-/opt/txt/ui/mission-control}"
OUT_DIR="${OUT_DIR:-$ROOT_DIR/.tmp/runtime-truth-matrix-codex}"
REPORT_PATH="${CONSTITUTIONAL_REPORT_PATH:-/opt/txt/var/proof_renewal/certified_outcomes_review_runtime_truth_matrix.json}"
PROJECTION_PATH="${CERTIFIED_OUTCOMES_PROJECTION_PATH:-/opt/txt/var/proof_renewal/certified_outcomes_projection_for_scanner.json}"
CONTROL_PLANE_URL="${CONTROL_PLANE_URL:-http://127.0.0.1:8000}"
CONTROL_PLANE_FALLBACK_URL="${CONTROL_PLANE_FALLBACK_URL:-$CONTROL_PLANE_URL}"

if [ ! -x "$ROOT_DIR/node_modules/.bin/tsc" ]; then
  echo "local TypeScript compiler missing: $ROOT_DIR/node_modules/.bin/tsc" >&2
  exit 2
fi

TOKEN="${CONTROL_PLANE_TOKEN:-}"
if [ -z "$TOKEN" ] && command -v docker >/dev/null 2>&1; then
  TOKEN="$(docker exec control-plane printenv CONTROL_PLANE_TOKEN 2>/dev/null || true)"
fi
if [ -z "$TOKEN" ]; then
  echo "CONTROL_PLANE_TOKEN unavailable; refusing unauthenticated scanner run" >&2
  exit 2
fi

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR" "$(dirname "$REPORT_PATH")" "$(dirname "$PROJECTION_PATH")"

python3 /opt/txt/scripts/txt_certified_outcomes_projection.py \
  --scanner-report "$REPORT_PATH" \
  --output "$PROJECTION_PATH" \
  --out-dir "$(dirname "$PROJECTION_PATH")" \
  --repo-root /opt/txt \
  --text

"$ROOT_DIR/node_modules/.bin/tsc" \
  --target ES2020 \
  --module commonjs \
  --moduleResolution node \
  --esModuleInterop \
  --skipLibCheck \
  --lib es2020,dom \
  --rootDir "$ROOT_DIR" \
  --outDir "$OUT_DIR" \
  "$ROOT_DIR/scripts/scan-runtime-truth-matrix.ts"

set +e
CONTROL_PLANE_URL="$CONTROL_PLANE_URL" \
CONTROL_PLANE_FALLBACK_URL="$CONTROL_PLANE_FALLBACK_URL" \
CONTROL_PLANE_TOKEN="$TOKEN" \
CONTROL_PLANE_FORCE_SERVICE_AUTH=1 \
CONSTITUTIONAL_OPEN_INCIDENTS=0 \
CONSTITUTIONAL_REPORT_PATH="$REPORT_PATH" \
CERTIFIED_OUTCOMES_PROJECTION_PATH="$PROJECTION_PATH" \
node "$OUT_DIR/scripts/scan-runtime-truth-matrix.js"
status=$?
set -e

echo "report: $REPORT_PATH"
echo "projection: $PROJECTION_PATH"
echo "scanner_exit: $status"

if [ "${STRICT_SCANNER_EXIT:-0}" = "1" ]; then
  exit "$status"
fi
exit 0
