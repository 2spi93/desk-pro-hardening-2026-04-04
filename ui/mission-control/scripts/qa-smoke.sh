#!/usr/bin/env sh
set -eu

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "[qa:smoke] 1/4 Risk workspace integration"
node scripts/risk-workspace.integration.js

echo "[qa:smoke] 2/4 TypeScript + Next production build"
npm run build

echo "[qa:smoke] 3/4 Playwright replay + seeded Kairos smoke"
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="${PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH:-}"
if [ -f /etc/alpine-release ]; then
	if ! command -v chromium-browser >/dev/null 2>&1 && ! command -v chromium >/dev/null 2>&1; then
		echo "[qa:smoke] installing Alpine Chromium runtime"
		apk add --no-cache chromium >/dev/null
	fi
	PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="${PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH:-$(command -v chromium-browser || command -v chromium)}"
elif [ -z "$PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH" ] && [ ! -d "${HOME}/.cache/ms-playwright" ]; then
	echo "[qa:smoke] installing Playwright browser runtime"
	npx playwright install chromium
fi
MC_E2E_DEV_DEGRADED="${MC_E2E_DEV_DEGRADED:-1}" \
MC_E2E_DEV_DEGRADED_SILENT="${MC_E2E_DEV_DEGRADED_SILENT:-1}" \
PLAYWRIGHT_ALLOW_INSECURE_LOCALHOST="${PLAYWRIGHT_ALLOW_INSECURE_LOCALHOST:-1}" \
PLAYWRIGHT_BASE_URL="${PLAYWRIGHT_BASE_URL:-http://127.0.0.1:3000}" \
PLAYWRIGHT_CONTROL_PLANE_URL="${PLAYWRIGHT_CONTROL_PLANE_URL:-http://control-plane:8000}" \
PLAYWRIGHT_ALLOW_INSECURE_CONTROL_PLANE="${PLAYWRIGHT_ALLOW_INSECURE_CONTROL_PLANE:-1}" \
CONTROL_PLANE_URL="${CONTROL_PLANE_URL:-${PLAYWRIGHT_CONTROL_PLANE_URL:-http://control-plane:8000}}" \
CONTROL_PLANE_FALLBACK_URL="${CONTROL_PLANE_FALLBACK_URL:-${CONTROL_PLANE_URL:-${PLAYWRIGHT_CONTROL_PLANE_URL:-http://control-plane:8000}}}" \
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="$PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH" \
npm run test:e2e -- --workers=1 tests/e2e/terminal-replay-explainability.spec.ts tests/e2e/kairos-runtime-seeded.spec.ts

echo "[qa:smoke] 4/4 Completed"
