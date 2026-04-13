#!/usr/bin/env sh
set -eu

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

sh scripts/qa-smoke.sh
sh scripts/qa-regression-ui.sh

echo "[qa:all] Smoke + Playwright docker regression completed"
