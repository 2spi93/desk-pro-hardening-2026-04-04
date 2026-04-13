#!/usr/bin/env sh
set -eu

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v docker >/dev/null 2>&1; then
  echo "[deps:next] docker is required"
  exit 1
fi

CURRENT_NEXT="$(docker run --rm -v "$ROOT_DIR":/work -w /work node:20-bullseye node -e "console.log(require('./package.json').dependencies.next)")"

LATEST_INFO="$(docker run --rm node:20-bullseye sh -lc 'LATEST=$(npm view next version); DEPRECATED=$(npm view next deprecated 2>/dev/null || true); printf "%s\n%s\n" "$LATEST" "$DEPRECATED"')"
LATEST_NEXT="$(printf "%s" "$LATEST_INFO" | sed -n '1p')"
LATEST_DEPRECATED="$(printf "%s" "$LATEST_INFO" | sed -n '2p')"

echo "[deps:next] current=$CURRENT_NEXT"
echo "[deps:next] latest=$LATEST_NEXT"
if [ -n "$LATEST_DEPRECATED" ]; then
  echo "[deps:next] latest_deprecated=$LATEST_DEPRECATED"
else
  echo "[deps:next] latest_deprecated=<none>"
fi

if [ "$CURRENT_NEXT" = "$LATEST_NEXT" ]; then
  echo "[deps:next] up-to-date"
else
  echo "[deps:next] update-recommended"
fi
