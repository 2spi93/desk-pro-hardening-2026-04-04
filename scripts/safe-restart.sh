#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_ROOT="$ROOT_DIR/logs/safe-restart"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
RUN_DIR="$LOG_ROOT/$TIMESTAMP"

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
HOST_HEADER="${HOST_HEADER:-app.txt.gtixt.com}"
CHECK_TIMEOUT_SEC="${CHECK_TIMEOUT_SEC:-180}"
CHECK_INTERVAL_SEC="${CHECK_INTERVAL_SEC:-2}"
WS_PATH="${WS_PATH:-/ws/v1/market/quotes}"
WS_USERNAME="${WS_USERNAME:-operator}"
WS_PASSWORD="${WS_PASSWORD:-}"
TRADES_WS_INSTRUMENT="${TRADES_WS_INSTRUMENT:-BTCUSDT}"
TRADES_WS_VENUE="${TRADES_WS_VENUE:-binance-public}"

DEFAULT_CHECKS=(
  "/terminal"
  "/api/mt5/orders/risk-history?limit=120&symbol=BTCUSD&account_id=mt5-demo-01"
  "/api/mt5/orders/risk-history/summary?window=10&miss_threshold=3&symbol=BTCUSD&account_id=mt5-demo-01"
)

COMPOSE_BIN=(docker compose)

DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: scripts/safe-restart.sh [options]

Safe restart flow:
1) Snapshot running services
2) docker compose up -d
3) Wait for services to be healthy/running
4) Run API + Next static asset checks
5) Check WebSocket connectivity
6) On failure: auto rollback + log dump
7) Export JSON summary for monitoring

Options:
  --base-url URL         Base URL for checks (default: http://127.0.0.1:3000)
  --host HOST            Host header for checks (default: app.txt.gtixt.com)
  --timeout SEC          Global wait timeout in seconds (default: 180)
  --interval SEC         Poll interval in seconds (default: 2)
  --check PATH           Extra API path to check (can be repeated)
  --compose-file FILE    Compose file path (repeatable)
  --dry-run              Simulate restart without making changes
  --help                 Show this help

Environment:
  BASE_URL, HOST_HEADER, CHECK_TIMEOUT_SEC, CHECK_INTERVAL_SEC, WS_PATH, WS_USERNAME, WS_PASSWORD

Output:
  Diagnostics saved to logs/safe-restart/<TIMESTAMP>/
  JSON summary: summary.json (success, duration, checks, latencies)
EOF
}

EXTRA_CHECKS=()
COMPOSE_FILES=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-url)
      BASE_URL="$2"
      shift 2
      ;;
    --host)
      HOST_HEADER="$2"
      shift 2
      ;;
    --timeout)
      CHECK_TIMEOUT_SEC="$2"
      shift 2
      ;;
    --interval)
      CHECK_INTERVAL_SEC="$2"
      shift 2
      ;;
    --check)
      EXTRA_CHECKS+=("$2")
      shift 2
      ;;
    --compose-file)
      COMPOSE_FILES+=("$2")
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 2
      ;;
  esac
done

if [[ ${#COMPOSE_FILES[@]} -gt 0 ]]; then
  COMPOSE_BIN+=("-f")
  for f in "${COMPOSE_FILES[@]}"; do
    COMPOSE_BIN+=("$f" "-f")
  done
  unset 'COMPOSE_BIN[${#COMPOSE_BIN[@]}-1]'
fi

mkdir -p "$RUN_DIR"

mapfile -t CHECKS < <(printf '%s\n' "${DEFAULT_CHECKS[@]}" "${EXTRA_CHECKS[@]}" | awk 'NF' | awk '!seen[$0]++')

pushd "$ROOT_DIR" >/dev/null

log() {
  printf '[safe-restart] %s\n' "$*"
}

# Timing and results tracking
RESULTS_CHECKS=()
declare -A CHECK_LATENCIES
READINESS_START_TIME=0
READINESS_END_TIME=0
CHECKS_START_TIME=0
CHECKS_END_TIME=0
STATIC_ASSETS_SUCCESS=0
WS_START_TIME=0
WS_END_TIME=0
WS_SUCCESS=0
TRADES_WS_SUCCESS=0
RUN_SUCCESS=0
ROLLBACK_TRIGGERED=0
FAILURE_STAGE=""

preflight_validate() {
  log "Running preflight validation"

  python3 -m py_compile "$ROOT_DIR/apps/market_data_plane/main.py" >"$RUN_DIR/preflight-backend.txt" 2>&1

  if docker ps --format '{{.Names}}' | grep -qx 'mission-control-ui'; then
    docker exec mission-control-ui sh -lc 'cd /workspace/ui/mission-control && npm run lint' \
      >"$RUN_DIR/preflight-ui-lint.txt" 2>&1
  else
    printf 'mission-control-ui container not running; skipped containerized lint\n' >"$RUN_DIR/preflight-ui-lint.txt"
  fi

  log "Preflight validation passed"
}

dump_logs() {
  log "Dumping diagnostics to $RUN_DIR"
  {
    echo "timestamp=$TIMESTAMP"
    echo "base_url=$BASE_URL"
    echo "host_header=$HOST_HEADER"
    echo "timeout=$CHECK_TIMEOUT_SEC"
    echo "interval=$CHECK_INTERVAL_SEC"
    echo "dry_run=$DRY_RUN"
  } >"$RUN_DIR/meta.txt"

  "${COMPOSE_BIN[@]}" ps >"$RUN_DIR/compose-ps.txt" 2>&1 || true
  docker ps -a >"$RUN_DIR/docker-ps-a.txt" 2>&1 || true
  uptime >"$RUN_DIR/uptime.txt" 2>&1 || true
  free -m >"$RUN_DIR/free-m.txt" 2>&1 || true

  while IFS= read -r svc; do
    [[ -n "$svc" ]] || continue
    "${COMPOSE_BIN[@]}" logs --no-color --tail 300 "$svc" >"$RUN_DIR/log-$svc.txt" 2>&1 || true
  done < <("${COMPOSE_BIN[@]}" config --services 2>/dev/null || true)
}

PREV_RUNNING=()
while IFS= read -r svc; do
  [[ -n "$svc" ]] && PREV_RUNNING+=("$svc")
done < <("${COMPOSE_BIN[@]}" ps --status running --services 2>/dev/null || true)

printf '%s\n' "${PREV_RUNNING[@]-}" >"$RUN_DIR/prev-running-services.txt"

rollback() {
  log "Rollback started"
  ROLLBACK_TRIGGERED=1

  CURRENT_RUNNING=()
  while IFS= read -r svc; do
    [[ -n "$svc" ]] && CURRENT_RUNNING+=("$svc")
  done < <("${COMPOSE_BIN[@]}" ps --status running --services 2>/dev/null || true)

  if [[ ${#PREV_RUNNING[@]} -gt 0 ]]; then
    log "Restoring previously running services: ${PREV_RUNNING[*]}"
    "${COMPOSE_BIN[@]}" up -d "${PREV_RUNNING[@]}" || true
  fi

  for svc in "${CURRENT_RUNNING[@]}"; do
    keep=0
    for prev in "${PREV_RUNNING[@]}"; do
      if [[ "$svc" == "$prev" ]]; then
        keep=1
        break
      fi
    done
    if [[ $keep -eq 0 ]]; then
      log "Stopping service not present before restart: $svc"
      "${COMPOSE_BIN[@]}" stop "$svc" || true
    fi
  done

  log "Rollback completed"
}

wait_for_services() {
  local deadline now
  deadline=$((SECONDS + CHECK_TIMEOUT_SEC))
  READINESS_START_TIME=$SECONDS

  mapfile -t all_services < <("${COMPOSE_BIN[@]}" config --services)
  log "Waiting services: ${all_services[*]}"

  while true; do
    local all_ready=1

    for svc in "${all_services[@]}"; do
      local cid
      cid="$("${COMPOSE_BIN[@]}" ps -q "$svc" | head -n 1)"
      if [[ -z "$cid" ]]; then
        all_ready=0
        continue
      fi

      local running health
      running="$(docker inspect -f '{{.State.Running}}' "$cid" 2>/dev/null || echo false)"
      health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid" 2>/dev/null || echo none)"

      if [[ "$running" != "true" ]]; then
        all_ready=0
        continue
      fi

      if [[ "$health" != "none" && "$health" != "healthy" ]]; then
        all_ready=0
        continue
      fi
    done

    if [[ $all_ready -eq 1 ]]; then
      READINESS_END_TIME=$SECONDS
      log "All services ready"
      return 0
    fi

    now=$SECONDS
    if (( now >= deadline )); then
      READINESS_END_TIME=$SECONDS
      log "Service readiness timeout"
      return 1
    fi

    sleep "$CHECK_INTERVAL_SEC"
  done
}

check_apis() {
  local failed=0
  : >"$RUN_DIR/check-results.txt"
  CHECKS_START_TIME=$SECONDS

  for path in "${CHECKS[@]}"; do
    local code start_time elapsed
    start_time=$SECONDS
    code="$(curl --max-time 20 -s -o /dev/null -w '%{http_code}' -H "Host: $HOST_HEADER" "$BASE_URL$path" || echo 000)"
    elapsed=$((SECONDS - start_time))
    CHECK_LATENCIES["${path:0:60}"]=$elapsed
    printf '%s %s (latency: %ds)\n' "$code" "$path" "$elapsed" | tee -a "$RUN_DIR/check-results.txt"
    RESULTS_CHECKS+=("$code:$path:$elapsed")
    if [[ "$code" != "200" ]]; then
      failed=1
    fi
  done

  CHECKS_END_TIME=$SECONDS

  if [[ $failed -ne 0 ]]; then
    log "API checks failed"
    return 1
  fi

  log "API checks passed"
  return 0
}

check_static_assets() {
  if "$ROOT_DIR/scripts/check_ui_static_assets.sh" --base-url "$BASE_URL" --host "$HOST_HEADER" >"$RUN_DIR/static-assets.txt" 2>&1; then
    STATIC_ASSETS_SUCCESS=1
    log "Next static asset checks passed"
    return 0
  fi

  STATIC_ASSETS_SUCCESS=0
  log "Next static asset checks failed"
  return 1
}

check_websocket() {
  local status=0

  WS_START_TIME=$SECONDS

  if WS_PATH="$WS_PATH" WS_E2E=1 SKIP_API_SMOKE=1 USERNAME="$WS_USERNAME" PASSWORD="$WS_PASSWORD" \
    "$ROOT_DIR/scripts/mc-auth-smoke.sh" \
      --base-url "$BASE_URL" \
      --host "$HOST_HEADER" \
      --username "$WS_USERNAME" \
      --ws-path "$WS_PATH" \
      >"$RUN_DIR/websocket-check.txt" 2>&1; then
    WS_END_TIME=$SECONDS
    WS_SUCCESS=1
    log "WebSocket check passed (latency: $((WS_END_TIME - WS_START_TIME))s)"
    return 0
  else
    status=$?
    WS_END_TIME=$SECONDS
    WS_SUCCESS=0
    log "WebSocket check failed (latency: $((WS_END_TIME - WS_START_TIME))s, exit=$status)"
    return 1
  fi
}

check_trades_websocket() {
  if TRADES_WS_INSTRUMENT="$TRADES_WS_INSTRUMENT" TRADES_WS_VENUE="$TRADES_WS_VENUE" \
    "$ROOT_DIR/scripts/smoke_market_trades_ws.sh" "$TRADES_WS_INSTRUMENT" "$TRADES_WS_VENUE" 5 \
    >"$RUN_DIR/trades-websocket-check.txt" 2>&1; then
    TRADES_WS_SUCCESS=1
    log "Trades WebSocket smoke passed"
    return 0
  fi

  TRADES_WS_SUCCESS=0
  log "Trades WebSocket smoke failed"
  return 1
}

export_json_summary() {
  local total_duration checks_duration ws_duration
  total_duration=$((SECONDS))
  checks_duration=$((CHECKS_END_TIME - CHECKS_START_TIME))
  ws_duration=$((WS_END_TIME - WS_START_TIME))
  
  local checks_json="["
  for check_result in "${RESULTS_CHECKS[@]}"; do
    IFS=':' read -r code path latency <<< "$check_result"
    checks_json+="{\"code\":$code,\"path\":\"$path\",\"latency_sec\":$latency},"
  done
  checks_json="${checks_json%,}]"
  
  cat >"$RUN_DIR/summary.json" <<EOF
{
  "timestamp": "$TIMESTAMP",
  "dry_run": $DRY_RUN,
  "success": $([[ $RUN_SUCCESS -eq 1 ]] && echo "true" || echo "false"),
  "failure_stage": "$FAILURE_STAGE",
  "rollback_triggered": $([[ $ROLLBACK_TRIGGERED -eq 1 ]] && echo "true" || echo "false"),
  "base_url": "$BASE_URL",
  "host_header": "$HOST_HEADER",
  "timings": {
    "total_duration_sec": $total_duration,
    "readiness_duration_sec": $((READINESS_END_TIME - READINESS_START_TIME)),
    "checks_duration_sec": $checks_duration,
    "websocket_duration_sec": $ws_duration
  },
  "checks": $checks_json,
  "websocket": {
    "success": $WS_SUCCESS,
    "latency_sec": $ws_duration
  },
  "trades_websocket": {
    "success": $TRADES_WS_SUCCESS,
    "instrument": "$TRADES_WS_INSTRUMENT",
    "venue": "$TRADES_WS_VENUE"
  },
  "static_assets": {
    "success": $STATIC_ASSETS_SUCCESS
  },
  "logs_directory": "$RUN_DIR"
}
EOF
  
  log "JSON summary exported to $RUN_DIR/summary.json"
}

log "Step 0/6: preflight validation"
if ! preflight_validate; then
  FAILURE_STAGE="preflight"
  dump_logs
  log "FAILED (preflight). Diagnostics in $RUN_DIR"
  export_json_summary
  exit 1
fi

log "Step 1/6: docker compose up -d"
if [[ $DRY_RUN -eq 1 ]]; then
  log "[DRY-RUN] Skipping docker compose up -d"
else
  "${COMPOSE_BIN[@]}" up -d
fi

log "Step 2/6: wait services health/running"
if ! wait_for_services; then
  FAILURE_STAGE="readiness"
  dump_logs
  if [[ $DRY_RUN -eq 0 ]]; then
    rollback
  fi
  log "FAILED (readiness). Diagnostics in $RUN_DIR"
  export_json_summary
  exit 1
fi

log "Step 3/6: API checks"
if ! check_apis; then
  FAILURE_STAGE="checks"
  dump_logs
  if [[ $DRY_RUN -eq 0 ]]; then
    rollback
  fi
  log "FAILED (checks). Diagnostics in $RUN_DIR"
  export_json_summary
  exit 1
fi

if ! check_static_assets; then
  FAILURE_STAGE="static-assets"
  dump_logs
  if [[ $DRY_RUN -eq 0 ]]; then
    rollback
  fi
  log "FAILED (static-assets). Diagnostics in $RUN_DIR"
  export_json_summary
  exit 1
fi

log "Step 4/6: WebSocket check"
if ! check_websocket; then
  log "WARNING: WebSocket check failed (continuing anyway)"
fi

log "Step 5/6: trades WebSocket smoke"
if ! check_trades_websocket; then
  log "WARNING: trades WebSocket smoke failed (continuing anyway)"
fi

log "Step 6/6: success"
log "OK - safe restart completed"
RUN_SUCCESS=1
export_json_summary

popd >/dev/null
