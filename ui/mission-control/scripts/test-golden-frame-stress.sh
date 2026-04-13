#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
OUT_DIR="$ROOT_DIR/.tmp/golden-frame-stress"

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

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
  "$ROOT_DIR/tests/integration/golden-frame-stress.ts"

node "$OUT_DIR/tests/integration/golden-frame-stress.js"