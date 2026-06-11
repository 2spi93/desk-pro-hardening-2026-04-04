#!/bin/sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
OUT_DIR="$ROOT_DIR/.tmp/controlled-live-ramp-gate"
REPORT_DIR="$ROOT_DIR/artifacts"
REPORT_PATH="${CONSTITUTIONAL_REPORT_PATH:-}"

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR" "$REPORT_DIR"

./node_modules/.bin/tsc \
  --pretty false \
  --outDir "$OUT_DIR" \
  --module commonjs \
  --target es2020 \
  --moduleResolution node \
  --esModuleInterop \
  --skipLibCheck \
  --resolveJsonModule \
  scripts/scan-controlled-live-ramp-gate.ts \
  lib/tradeLifecycleHealth.ts \
  lib/runtimeTruth.ts \
  lib/healthwatchDashboard.ts

if [ -n "$REPORT_PATH" ]; then
  CONSTITUTIONAL_REPORT_PATH="$REPORT_PATH" node "$OUT_DIR/scripts/scan-controlled-live-ramp-gate.js"
else
  node "$OUT_DIR/scripts/scan-controlled-live-ramp-gate.js"
fi
