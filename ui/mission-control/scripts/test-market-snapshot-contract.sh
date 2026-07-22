#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

"${ROOT_DIR}/node_modules/.bin/tsc" \
  "${ROOT_DIR}/lib/marketSnapshotContract.ts" \
  --target ES2020 \
  --module commonjs \
  --outDir "$TMP_DIR" \
  --skipLibCheck

MARKET_SNAPSHOT_CONTRACT_MODULE="$TMP_DIR/marketSnapshotContract.js" \
  node "${ROOT_DIR}/tests/market-snapshot-contract.test.cjs"
