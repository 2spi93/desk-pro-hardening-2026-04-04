#!/usr/bin/env sh
set -eu

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

PLAYWRIGHT_DOCKER_IMAGE="${PLAYWRIGHT_DOCKER_IMAGE:-mcr.microsoft.com/playwright:v1.58.2-jammy}"
PLAYWRIGHT_BASE_URL="${PLAYWRIGHT_BASE_URL:-http://localhost:3310}"
PLAYWRIGHT_WEB_SERVER_COMMAND="${PLAYWRIGHT_WEB_SERVER_COMMAND:-npm run dev -- --hostname localhost --port 3310}"
PLAYWRIGHT_TEST_PATH="${PLAYWRIGHT_TEST_PATH:-}"
PLAYWRIGHT_TEST_GREP="${PLAYWRIGHT_TEST_GREP:-}"
PLAYWRIGHT_OPERATOR_PASSWORD="${PLAYWRIGHT_OPERATOR_PASSWORD:-}"
MC_E2E_DEV_DEGRADED="${MC_E2E_DEV_DEGRADED:-1}"
MC_E2E_DEV_DEGRADED_SILENT="${MC_E2E_DEV_DEGRADED_SILENT:-1}"
CONTROL_PLANE_URL="${CONTROL_PLANE_URL:-https://api.txt.gtixt.com}"
PLAYWRIGHT_CONTROL_PLANE_URL="${PLAYWRIGHT_CONTROL_PLANE_URL:-$CONTROL_PLANE_URL}"
CONTROL_PLANE_TOKEN="${CONTROL_PLANE_TOKEN:-}"
DOCKER_NETWORK_ARGS=""

if [ "$(uname -s)" = "Linux" ]; then
	DOCKER_NETWORK_ARGS="--network host"
fi

if ! command -v docker >/dev/null 2>&1; then
	echo "[qa:ui] docker is required to run reproducible Playwright regression"
	exit 1
fi

echo "[qa:ui] Running UI regression in ${PLAYWRIGHT_DOCKER_IMAGE}"
if [ -n "$PLAYWRIGHT_TEST_PATH" ]; then
	echo "[qa:ui] Target spec: ${PLAYWRIGHT_TEST_PATH}"
fi
if [ -n "$PLAYWRIGHT_TEST_GREP" ]; then
	echo "[qa:ui] Grep filter: ${PLAYWRIGHT_TEST_GREP}"
fi
docker run --rm \
	${DOCKER_NETWORK_ARGS} \
	--add-host=host.docker.internal:host-gateway \
	-e PLAYWRIGHT_BASE_URL="$PLAYWRIGHT_BASE_URL" \
	-e PLAYWRIGHT_WEB_SERVER_COMMAND="$PLAYWRIGHT_WEB_SERVER_COMMAND" \
	-e PLAYWRIGHT_TEST_PATH="$PLAYWRIGHT_TEST_PATH" \
	-e PLAYWRIGHT_TEST_GREP="$PLAYWRIGHT_TEST_GREP" \
	-e PLAYWRIGHT_OPERATOR_PASSWORD="$PLAYWRIGHT_OPERATOR_PASSWORD" \
	-e MC_E2E_DEV_DEGRADED="$MC_E2E_DEV_DEGRADED" \
	-e MC_E2E_DEV_DEGRADED_SILENT="$MC_E2E_DEV_DEGRADED_SILENT" \
	-e CONTROL_PLANE_URL="$CONTROL_PLANE_URL" \
	-e PLAYWRIGHT_CONTROL_PLANE_URL="$PLAYWRIGHT_CONTROL_PLANE_URL" \
	-e CONTROL_PLANE_TOKEN="$CONTROL_PLANE_TOKEN" \
	-v "$ROOT_DIR:/work" \
	-w /work \
	"$PLAYWRIGHT_DOCKER_IMAGE" \
	/bin/bash -lc 'set -eu
	npm ci --no-audit --no-fund
	cmd=(npm run test:e2e --)
	if [ -n "$PLAYWRIGHT_TEST_PATH" ]; then
		cmd+=("$PLAYWRIGHT_TEST_PATH")
	fi
	if [ -n "$PLAYWRIGHT_TEST_GREP" ]; then
		cmd+=("--grep" "$PLAYWRIGHT_TEST_GREP")
	fi
	"${cmd[@]}"'
