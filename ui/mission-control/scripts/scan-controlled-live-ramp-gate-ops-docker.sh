#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT_DIR="$(CDPATH= cd -- "$SCRIPT_DIR/../../.." && pwd)"
UI_DIR="/workspace/ui/mission-control"
COMPOSE_FILE="${CONTROLLED_LIVE_GATE_COMPOSE_FILE:-$ROOT_DIR/docker-compose.yml}"
REPORT_PATH="${CONSTITUTIONAL_REPORT_PATH:-artifacts/controlled-live-ramp-gate.ops-docker.report.json}"
CONTROL_PLANE_URL="${CONTROLLED_LIVE_GATE_CONTROL_PLANE_URL:-http://control-plane:8000}"
PUBLIC_URL="${CONTROLLED_LIVE_GATE_PUBLIC_URL:-https://app.txt.gtixt.com/login}"
ACTIVE_SLOT_FILE="$ROOT_DIR/data/mission-control/ui-active-slot.conf"

if [ -n "${CONTROLLED_LIVE_GATE_RUNNER_SERVICE:-}" ]; then
  SERVICE="$CONTROLLED_LIVE_GATE_RUNNER_SERVICE"
elif [ -f "$ACTIVE_SLOT_FILE" ] && grep -q 'mission-control-ui-green:3002' "$ACTIVE_SLOT_FILE"; then
  SERVICE="mission-control-ui-green"
else
  SERVICE="mission-control-ui-blue"
fi

case "$SERVICE" in
  mission-control-ui-blue)
    DEFAULT_AUTH_URL="http://mission-control-ui-blue:3001/api/system/live-ops"
    ;;
  mission-control-ui-green)
    DEFAULT_AUTH_URL="http://mission-control-ui-green:3002/api/system/live-ops"
    ;;
  *)
    DEFAULT_AUTH_URL="http://$SERVICE:3000/api/system/live-ops"
    ;;
esac

AUTH_URL="${CONTROLLED_LIVE_GATE_AUTH_URL:-$DEFAULT_AUTH_URL}"

cd "$ROOT_DIR"

docker compose -f "$COMPOSE_FILE" exec -T \
  -e CONTROLLED_LIVE_GATE_CONTEXT=ops \
  -e CONTROLLED_LIVE_GATE_RUNNER_SERVICE="$SERVICE" \
  -e CONTROLLED_LIVE_GATE_CONTROL_PLANE_URL="$CONTROL_PLANE_URL" \
  -e CONTROLLED_LIVE_GATE_PUBLIC_URL="$PUBLIC_URL" \
  -e CONTROLLED_LIVE_GATE_AUTH_URL="$AUTH_URL" \
  -e CONTROLLED_LIVE_GATE_AUTH_MODE=service \
  -e CONSTITUTIONAL_REPORT_PATH="$REPORT_PATH" \
  "$SERVICE" \
  sh -lc "cd '$UI_DIR' && export CONTROLLED_LIVE_GATE_AUTH_TOKEN=\"\${CONTROLLED_LIVE_GATE_AUTH_TOKEN:-\${CONTROL_PLANE_TOKEN:-}}\" && npm run scan:controlled-live-ramp-gate"
