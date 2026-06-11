#!/usr/bin/env bash
# Post-reset canary watch (protocol P0): polls the stop-threshold signals for
# 10-15 minutes after a supervised kill-switch reset. Any RED line means:
# stop, no trade, re-latch cleanly.
#
# Usage: bash scripts/post_reset_watch.sh [duration_minutes] [interval_seconds]
set -euo pipefail

DURATION_MIN="${1:-12}"
INTERVAL_SEC="${2:-30}"
END_TS=$(( $(date +%s) + DURATION_MIN * 60 ))
ACTIVE_SLOT_FILE="/opt/txt/data/mission-control/ui-active-slot.conf"

slot_service() {
  if grep -q 'mission-control-ui-green:3002' "$ACTIVE_SLOT_FILE" 2>/dev/null; then
    printf 'mission-control-ui-green:3002\n'
  else
    printf 'mission-control-ui-blue:3001\n'
  fi
}

RED=0
check() { # label value ok_condition
  local label="$1" value="$2" ok="$3"
  if [[ "$ok" == "1" ]]; then
    printf '  \033[32mOK \033[0m %-34s %s\n' "$label" "$value"
  else
    printf '  \033[31mRED\033[0m %-34s %s\n' "$label" "$value"
    RED=1
  fi
}

while [[ $(date +%s) -lt $END_TS ]]; do
  RED=0
  echo "=== $(date -u '+%H:%M:%S') UTC — post-reset watch ==="

  # control-plane health + opportunity gate (latency measured from host)
  CP_START=$(date +%s%3N)
  CP_JSON=$(curl -s --max-time 10 http://127.0.0.1:8000/health || echo '{}')
  CP_MS=$(( $(date +%s%3N) - CP_START ))
  GATE_STATUS=$(printf '%s' "$CP_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('opportunity_gate',{}).get('status','unreachable'))" 2>/dev/null || echo unreachable)
  GATE_FLAGS=$(printf '%s' "$CP_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(','.join(d.get('opportunity_gate',{}).get('metrics',{}).get('flags',[])) or 'none')" 2>/dev/null || echo unknown)
  KS_REC=$(printf '%s' "$CP_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('opportunity_gate',{}).get('kill_switch_recommended'))" 2>/dev/null || echo unknown)

  check "control-plane latency" "${CP_MS}ms" "$([[ $CP_MS -lt 2000 ]] && echo 1 || echo 0)"
  check "opportunity gate" "$GATE_STATUS" "$([[ "$GATE_STATUS" == "go" ]] && echo 1 || echo 0)"
  check "gate flags" "$GATE_FLAGS" "$([[ "$GATE_FLAGS" != *BUS_OFFLINE* ]] && echo 1 || echo 0)"
  check "kill_switch_recommended" "$KS_REC" "$([[ "$KS_REC" == "False" ]] && echo 1 || echo 0)"

  # kill switch persisted state
  KS_ROW=$(docker exec txt-postgres psql -U txt -d mission_control -t -A -c \
    "SELECT (config_value->>'active') || '|' || COALESCE(config_value->>'reason','none') FROM system_config WHERE config_key='kill_switch_state'" 2>/dev/null || echo "unknown|unknown")
  KS_ACTIVE="${KS_ROW%%|*}"; KS_REASON="${KS_ROW##*|}"
  check "kill switch latch" "active=$KS_ACTIVE reason=$KS_REASON" "$([[ "$KS_ACTIVE" == "false" ]] && echo 1 || echo 0)"

  # execution-router probe latency (from docker network)
  SLOT=$(slot_service); SVC="${SLOT%%:*}"; PORT="${SLOT##*:}"
  ER_MS=$(docker exec "$SVC" sh -c 'start=$(date +%s); wget -qO /dev/null -T 10 http://execution-router:8002/health; echo $(( ($(date +%s) - start) * 1000 ))' 2>/dev/null || echo 99999)
  check "execution-router probe" "~${ER_MS}ms" "$([[ $ER_MS -lt 5000 ]] && echo 1 || echo 0)"

  # live-ops API of active slot (auth probe equivalent)
  LO_CODE=$(docker exec "$SVC" sh -c "wget -qO /dev/null --server-response --header \"Authorization: Bearer \$CONTROL_PLANE_TOKEN\" http://127.0.0.1:$PORT/api/system/live-ops 2>&1 | grep -oE 'HTTP/[0-9.]+ [0-9]+' | tail -1 | grep -oE '[0-9]+$'" 2>/dev/null || echo 0)
  check "live-ops API ($SVC)" "HTTP $LO_CODE" "$([[ "$LO_CODE" == "200" ]] && echo 1 || echo 0)"

  if [[ $RED -eq 1 ]]; then
    echo ""
    echo ">>> SIGNAL ROUGE — protocole: stop, pas de trade, re-latch proprement. <<<"
  fi
  echo ""
  sleep "$INTERVAL_SEC"
done

echo "=== Fenêtre P0 terminée ($DURATION_MIN min). Relancer le scan ops Docker avant toute promotion. ==="
