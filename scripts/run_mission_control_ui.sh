#!/bin/sh
set -eu

cd /workspace/ui/mission-control

force_bootstrap="${FORCE_UI_BOOTSTRAP:-0}"
force_rebuild_on_boot="${FORCE_UI_REBUILD_ON_BOOT:-1}"
dist_dir="${NEXT_DIST_DIR:-.next-runtime}"
export NEXT_DIST_DIR="$dist_dir"
install_chromium_on_boot="${INSTALL_PLAYWRIGHT_CHROMIUM_ON_BOOT:-1}"

ensure_system_chromium() {
  if command -v chromium-browser >/dev/null 2>&1 || command -v chromium >/dev/null 2>&1; then
    return 0
  fi
  if ! command -v apk >/dev/null 2>&1; then
    return 0
  fi
  apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont >/dev/null
}

build_is_complete() {
  [ -f "$dist_dir/BUILD_ID" ] || return 1
  [ -f "$dist_dir/prerender-manifest.json" ] || return 1
  [ -f "$dist_dir/build-manifest.json" ] || return 1
  [ -f "$dist_dir/app-build-manifest.json" ] || return 1
  [ -d "$dist_dir/static" ] || return 1
  return 0
}

needs_install=0
if [ "$force_bootstrap" = "1" ] || [ ! -d node_modules ]; then
  needs_install=1
fi

needs_build=0
if [ "$force_bootstrap" = "1" ] || [ "$force_rebuild_on_boot" = "1" ] || ! build_is_complete; then
  needs_build=1
fi

if [ "$needs_install" = "1" ]; then
  npm install
fi

if [ "$install_chromium_on_boot" = "1" ]; then
  ensure_system_chromium
fi

if [ "$needs_build" = "1" ]; then
  rm -rf "$dist_dir"
  npm run build
fi

build_id_file="$dist_dir/BUILD_ID"
current_build_id="$(cat "$build_id_file" 2>/dev/null || true)"
app_pid=""

start_server() {
  npm run start &
  app_pid=$!
}

stop_server() {
  if [ -n "$app_pid" ] && kill -0 "$app_pid" 2>/dev/null; then
    kill "$app_pid" 2>/dev/null || true
    wait "$app_pid" 2>/dev/null || true
  fi
  app_pid=""
}

trap 'stop_server; exit 0' INT TERM EXIT

start_server

while true; do
  if [ -n "$app_pid" ] && ! kill -0 "$app_pid" 2>/dev/null; then
    wait "$app_pid" 2>/dev/null || true
    start_server
  fi

  if ! build_is_complete; then
    stop_server
    rm -rf "$dist_dir"
    npm run build
    current_build_id="$(cat "$build_id_file" 2>/dev/null || true)"
    start_server
    sleep 2
    continue
  fi

  next_build_id="$(cat "$build_id_file" 2>/dev/null || true)"
  if [ -n "$next_build_id" ] && [ "$next_build_id" != "$current_build_id" ]; then
    current_build_id="$next_build_id"
    stop_server
    start_server
  fi

  sleep 2
done