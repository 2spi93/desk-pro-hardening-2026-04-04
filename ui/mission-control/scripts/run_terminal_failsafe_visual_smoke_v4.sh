#!/usr/bin/env sh
set -eu

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

ensure_alpine_v4_runtime() {
	if [ ! -f /etc/alpine-release ]; then
		return 0
	fi

	need_install=0
	for binary in chromium-browser xvfb-run Xvfb; do
		if ! command -v "$binary" >/dev/null 2>&1; then
			need_install=1
			break
		fi
	done

	if [ "$need_install" = "1" ]; then
		echo "[terminal-v4-smoke] installing Alpine Chromium/Xvfb/Mesa runtime"
		apk add --no-cache chromium xvfb xvfb-run mesa-egl mesa-dri-gallium mesa-gl mesa-gles mesa-gbm libx11 >/dev/null
	fi
}

resolve_chromium_path() {
	for candidate in chromium-browser chromium; do
		if command -v "$candidate" >/dev/null 2>&1; then
			command -v "$candidate"
			return 0
		fi
	done
	return 1
}

reexec_in_ui_container_if_needed() {
	if [ -n "${MC_SKIP_UI_CONTAINER_REEXEC:-}" ]; then
		return 1
	fi
	if resolve_chromium_path >/dev/null 2>&1; then
		return 1
	fi
	if ! command -v docker >/dev/null 2>&1; then
		return 1
	fi
	if ! docker inspect mission-control-ui >/dev/null 2>&1; then
		return 1
	fi
	if [ "$(docker inspect -f '{{.State.Running}}' mission-control-ui 2>/dev/null)" != "true" ]; then
		return 1
	fi

	echo "[terminal-v4-smoke] no local Chromium found, re-executing in mission-control-ui container"
	exec docker exec \
		-e BASE_URL="${BASE_URL:-http://127.0.0.1:3000}" \
		-e MC_OUTPUT_FILE="${MC_OUTPUT_FILE:-/workspace/artifacts/terminal-visual-smoke-v4.json}" \
		-e MC_SCREENSHOT_DIR="${MC_SCREENSHOT_DIR:-/workspace/artifacts/terminal-visual-smoke-v4}" \
		-e MC_HEADLESS="${MC_HEADLESS:-1}" \
		-e MC_EXPECT_GPU_V4="${MC_EXPECT_GPU_V4:-1}" \
		-e MC_USE_GL="${MC_USE_GL:-angle}" \
		-e MC_PASSWORD="${MC_PASSWORD:-}" \
		-e MC_PASSWORD_FILE="${MC_PASSWORD_FILE:-}" \
		-e MC_CHROMIUM_ARGS="${MC_CHROMIUM_ARGS:-}" \
		-e MC_SKIP_UI_CONTAINER_REEXEC=1 \
		mission-control-ui \
		sh /workspace/ui/mission-control/scripts/run_terminal_failsafe_visual_smoke_v4.sh
}

resolve_password() {
	if [ -n "${MC_PASSWORD:-}" ]; then
		printf '%s' "$MC_PASSWORD"
		return 0
	fi
	for candidate in \
		"${MC_PASSWORD_FILE:-}" \
		"$ROOT_DIR/../../secrets/default_operator_password" \
		"/workspace/secrets/default_operator_password" \
		"/opt/txt/secrets/default_operator_password"
	do
		if [ -n "$candidate" ] && [ -f "$candidate" ]; then
			cat "$candidate"
			return 0
		fi
	done
	return 1
}

ensure_alpine_v4_runtime
reexec_in_ui_container_if_needed || true

PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="${PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH:-}"
if [ -z "$PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH" ]; then
	PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="$(resolve_chromium_path || true)"
	if [ -z "$PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH" ]; then
		echo "[terminal-v4-smoke] warning: no Chromium executable found locally, relying on Playwright default browser resolution"
	fi
fi
BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
MC_OUTPUT_FILE="${MC_OUTPUT_FILE:-$ROOT_DIR/../../artifacts/terminal-visual-smoke-v4.json}"
MC_SCREENSHOT_DIR="${MC_SCREENSHOT_DIR:-$ROOT_DIR/../../artifacts/terminal-visual-smoke-v4}"
MC_HEADLESS="${MC_HEADLESS:-1}"
MC_EXPECT_GPU_V4="${MC_EXPECT_GPU_V4:-1}"
MC_USE_GL="${MC_USE_GL:-angle}"
MC_PASSWORD="$(resolve_password)"

export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
export BASE_URL
export MC_OUTPUT_FILE
export MC_SCREENSHOT_DIR
export MC_HEADLESS
export MC_EXPECT_GPU_V4
export MC_USE_GL
export MC_PASSWORD

echo "[terminal-v4-smoke] base_url=$BASE_URL"
echo "[terminal-v4-smoke] output=$MC_OUTPUT_FILE"
echo "[terminal-v4-smoke] screenshots=$MC_SCREENSHOT_DIR"
echo "[terminal-v4-smoke] use_gl=$MC_USE_GL"
if [ -n "$PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH" ]; then
	echo "[terminal-v4-smoke] chromium=$PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"
fi

exec xvfb-run -a env \
	PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="$PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH" \
	BASE_URL="$BASE_URL" \
	MC_OUTPUT_FILE="$MC_OUTPUT_FILE" \
	MC_SCREENSHOT_DIR="$MC_SCREENSHOT_DIR" \
	MC_HEADLESS="$MC_HEADLESS" \
	MC_EXPECT_GPU_V4="$MC_EXPECT_GPU_V4" \
	MC_USE_GL="$MC_USE_GL" \
	MC_PASSWORD="$MC_PASSWORD" \
	node scripts/terminal_failsafe_visual_smoke.js