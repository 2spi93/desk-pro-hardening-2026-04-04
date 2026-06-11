#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
OUT_DIR="$ROOT_DIR/.tmp/runtime-truth-matrix"
REPORT_DIR="$ROOT_DIR/artifacts"
REPORT_PATH="${CONSTITUTIONAL_REPORT_PATH:-$REPORT_DIR/constitutional-truth-matrix.report.json}"

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
  "$ROOT_DIR/scripts/scan-runtime-truth-matrix.ts"

CONTROL_PLANE_FORCE_SERVICE_AUTH="${CONTROL_PLANE_FORCE_SERVICE_AUTH:-1}" \
CONSTITUTIONAL_REPORT_PATH="$REPORT_PATH" \
node "$OUT_DIR/scripts/scan-runtime-truth-matrix.js"