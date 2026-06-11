#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
OUT_DIR="$ROOT_DIR/.tmp/replay-certified-outcomes-regression"
REPORT_DIR="$ROOT_DIR/artifacts"
REPORT_PATH="${CONSTITUTIONAL_REPORT_PATH:-$REPORT_DIR/replay-certified-outcomes.report.json}"

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR" "$REPORT_DIR"

cleanup() {
  rm -rf "$OUT_DIR"
}

trap cleanup EXIT INT TERM

npx tsc \
  --target ES2020 \
  --module commonjs \
  --moduleResolution node \
  --esModuleInterop \
  --skipLibCheck \
  --lib es2020,dom \
  --rootDir "$ROOT_DIR" \
  --outDir "$OUT_DIR" \
  "$ROOT_DIR/tests/integration/replay-certified-outcomes-regression.ts"

CONSTITUTIONAL_REPORT_PATH="$REPORT_PATH" node "$OUT_DIR/tests/integration/replay-certified-outcomes-regression.js"