#!/usr/bin/env sh
set -eu

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

MOCK_CONTROL_PLANE_PORT="${MOCK_CONTROL_PLANE_PORT:-18011}"
MOCK_CONTROL_PLANE_URL="http://127.0.0.1:${MOCK_CONTROL_PLANE_PORT}"
MOCK_CONTROL_PLANE_FALLBACK_URL="${MOCK_CONTROL_PLANE_FALLBACK_URL:-https://api.txt.gtixt.com}"
PLAYWRIGHT_BASE_URL="${PLAYWRIGHT_BASE_URL:-http://127.0.0.1:3310}"
PLAYWRIGHT_WEB_SERVER_COMMAND="${PLAYWRIGHT_WEB_SERVER_COMMAND:-npm run dev -- --hostname 127.0.0.1 --port 3310}"
PLAYWRIGHT_TEST_PATHS="${PLAYWRIGHT_TEST_PATHS:-tests/e2e/terminal-cancel-replace-flow.spec.ts tests/e2e/terminal-cancel-replace-ui.spec.ts}"

node scripts/mock-control-plane-cancel-replace.js > /tmp/mock-control-plane-cancel-replace.log 2>&1 &
MOCK_PID=$!
cleanup() {
  kill "$MOCK_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

ready=0
for _ in $(seq 1 50); do
  if curl -fsS "${MOCK_CONTROL_PLANE_URL}/healthz" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.2
done

if [ "$ready" -ne 1 ]; then
  echo "mock control-plane did not start" >&2
  exit 1
fi

PLAYWRIGHT_ALLOW_INSECURE_LOCALHOST=1 \
MC_E2E_DEV_DEGRADED=1 \
MC_E2E_DEV_DEGRADED_SILENT="${MC_E2E_DEV_DEGRADED_SILENT:-1}" \
CONTROL_PLANE_URL="${MOCK_CONTROL_PLANE_URL}" \
CONTROL_PLANE_TOKEN="${CONTROL_PLANE_TOKEN:-e2e-dev-token}" \
PLAYWRIGHT_CONTROL_PLANE_URL="${MOCK_CONTROL_PLANE_URL}" \
MOCK_CONTROL_PLANE_FALLBACK_URL="${MOCK_CONTROL_PLANE_FALLBACK_URL}" \
PLAYWRIGHT_BASE_URL="${PLAYWRIGHT_BASE_URL}" \
PLAYWRIGHT_WEB_SERVER_COMMAND="${PLAYWRIGHT_WEB_SERVER_COMMAND}" \
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="${PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH:-$(command -v chromium-browser || command -v chromium || true)}" \
./node_modules/.bin/playwright test ${PLAYWRIGHT_TEST_PATHS}