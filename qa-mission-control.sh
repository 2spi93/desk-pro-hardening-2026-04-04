#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
MC_UI_DIR="$ROOT_DIR/ui/mission-control"

if ! command -v docker >/dev/null 2>&1; then
  echo "[qa:wrapper] docker is required"
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "[qa:wrapper] docker compose plugin is required"
  exit 1
fi

echo "[qa:wrapper] 1/2 Smoke QA in mission-control-ui container"
cd "$ROOT_DIR"
docker compose run --rm mission-control-ui sh -lc "npm ci --no-audit --no-fund && npm run qa:smoke"

echo "[qa:wrapper] 2/2 UI regression in pinned Playwright image"
cd "$MC_UI_DIR"
sh scripts/qa-regression-ui.sh

echo "[qa:wrapper] Completed: smoke + reproducible e2e"