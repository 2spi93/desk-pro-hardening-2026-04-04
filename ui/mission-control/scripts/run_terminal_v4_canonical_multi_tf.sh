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
		echo "[terminal-v4-canonical] installing Alpine Chromium/Xvfb/Mesa runtime"
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

	echo "[terminal-v4-canonical] no local Chromium found, re-executing in mission-control-ui container"
	exec docker exec \
		-e BASE_URL="${BASE_URL:-http://127.0.0.1:3000}" \
		-e MC_OUTPUT_FILE="${MC_OUTPUT_FILE:-/workspace/artifacts/terminal-v4-canonical-multi-tf.json}" \
		-e MC_SCREENSHOT_DIR="${MC_SCREENSHOT_DIR:-/workspace/artifacts/terminal-v4-canonical-multi-tf}" \
		-e MC_HEADLESS="${MC_HEADLESS:-1}" \
		-e MC_EXPECT_GPU_V4="${MC_EXPECT_GPU_V4:-1}" \
		-e MC_USE_GL="${MC_USE_GL:-angle}" \
		-e MC_DATA_MODE="${MC_DATA_MODE:-live}" \
		-e MC_DATASET_PROFILE="${MC_DATASET_PROFILE:-reference}" \
		-e MC_SPAN_AUTHORITY="${MC_SPAN_AUTHORITY:-}" \
		-e MC_REQUIRE_REFERENCE_DATASET_SYNC="${MC_REQUIRE_REFERENCE_DATASET_SYNC:-0}" \
		-e MC_PASSWORD="${MC_PASSWORD:-}" \
		-e MC_PASSWORD_FILE="${MC_PASSWORD_FILE:-}" \
		-e MC_CHROMIUM_ARGS="${MC_CHROMIUM_ARGS:-}" \
		-e MC_TIMEFRAMES="${MC_TIMEFRAMES:-1s,1m,1h,1M}" \
		-e MC_PREFERRED_SYMBOL="${MC_PREFERRED_SYMBOL:-}" \
		-e MC_SKIP_UI_CONTAINER_REEXEC=1 \
		mission-control-ui \
		sh /workspace/ui/mission-control/scripts/run_terminal_v4_canonical_multi_tf.sh
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
		echo "[terminal-v4-canonical] warning: no Chromium executable found locally, relying on Playwright default browser resolution"
	fi
fi

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
MC_OUTPUT_FILE="${MC_OUTPUT_FILE:-$ROOT_DIR/../../artifacts/terminal-v4-canonical-multi-tf.json}"
MC_SCREENSHOT_DIR="${MC_SCREENSHOT_DIR:-$ROOT_DIR/../../artifacts/terminal-v4-canonical-multi-tf}"
MC_HEADLESS="${MC_HEADLESS:-1}"
MC_EXPECT_GPU_V4="${MC_EXPECT_GPU_V4:-1}"
MC_USE_GL="${MC_USE_GL:-angle}"
MC_DATA_MODE="${MC_DATA_MODE:-live}"
MC_DATASET_PROFILE="${MC_DATASET_PROFILE:-reference}"
MC_SPAN_AUTHORITY="${MC_SPAN_AUTHORITY:-}"
MC_REQUIRE_REFERENCE_DATASET_SYNC="${MC_REQUIRE_REFERENCE_DATASET_SYNC:-0}"
MC_TIMEFRAMES="${MC_TIMEFRAMES:-1s,1m,1h,1M}"
MC_PREFERRED_SYMBOL="${MC_PREFERRED_SYMBOL:-}"
MC_PASSWORD="$(resolve_password)"

export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
export BASE_URL
export MC_OUTPUT_FILE
export MC_SCREENSHOT_DIR
export MC_HEADLESS
export MC_EXPECT_GPU_V4
export MC_USE_GL
export MC_DATA_MODE
export MC_DATASET_PROFILE
export MC_SPAN_AUTHORITY
export MC_REQUIRE_REFERENCE_DATASET_SYNC
export MC_TIMEFRAMES
export MC_PREFERRED_SYMBOL
export MC_PASSWORD

echo "[terminal-v4-canonical] base_url=$BASE_URL"
echo "[terminal-v4-canonical] output=$MC_OUTPUT_FILE"
echo "[terminal-v4-canonical] screenshots=$MC_SCREENSHOT_DIR"
echo "[terminal-v4-canonical] timeframes=$MC_TIMEFRAMES"
echo "[terminal-v4-canonical] use_gl=$MC_USE_GL"
echo "[terminal-v4-canonical] data_mode=$MC_DATA_MODE"
echo "[terminal-v4-canonical] dataset_profile=$MC_DATASET_PROFILE"
echo "[terminal-v4-canonical] span_authority=${MC_SPAN_AUTHORITY:-auto}"
if [ -n "$PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH" ]; then
	echo "[terminal-v4-canonical] chromium=$PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"
fi

exec xvfb-run -a env \
	PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="$PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH" \
	BASE_URL="$BASE_URL" \
	MC_OUTPUT_FILE="$MC_OUTPUT_FILE" \
	MC_SCREENSHOT_DIR="$MC_SCREENSHOT_DIR" \
	MC_HEADLESS="$MC_HEADLESS" \
	MC_EXPECT_GPU_V4="$MC_EXPECT_GPU_V4" \
	MC_USE_GL="$MC_USE_GL" \
	MC_DATA_MODE="$MC_DATA_MODE" \
	MC_DATASET_PROFILE="$MC_DATASET_PROFILE" \
	MC_SPAN_AUTHORITY="$MC_SPAN_AUTHORITY" \
	MC_REQUIRE_REFERENCE_DATASET_SYNC="$MC_REQUIRE_REFERENCE_DATASET_SYNC" \
	MC_TIMEFRAMES="$MC_TIMEFRAMES" \
	MC_PREFERRED_SYMBOL="$MC_PREFERRED_SYMBOL" \
	MC_PASSWORD="$MC_PASSWORD" \
	node scripts/terminal_v4_canonical_multi_tf.js