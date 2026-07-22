#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${ROOT_DIR}/logs/healthwatch"
mkdir -p "$LOG_DIR"

STATE_FILE="${STATE_FILE:-/tmp/mission-control-healthwatch.state}"
ALERT_WEBHOOK_URL="${ALERT_WEBHOOK_URL:-}"
MAIL_TO="${MAIL_TO:-}"
HOST_HEADER="${HOST_HEADER:-app.txt.gtixt.com}"
UI_BASE_URL="${UI_BASE_URL:-https://app.txt.gtixt.com}"
UI_ASSET_CHECK_ENABLED="${UI_ASSET_CHECK_ENABLED:-1}"
CHART_OFFLINE_CAPTURE_ENABLED="${CHART_OFFLINE_CAPTURE_ENABLED:-1}"
CHART_CAPTURE_STATE_FILE="${CHART_CAPTURE_STATE_FILE:-${STATE_FILE}.chart_offline}"
CHART_CAPTURE_COUNT_FILE="${CHART_CAPTURE_COUNT_FILE:-${STATE_FILE}.chart_offline_count}"
CHART_OFFLINE_CAPTURE_CONSECUTIVE_FAILS="${CHART_OFFLINE_CAPTURE_CONSECUTIVE_FAILS:-2}"
CHART_OFFLINE_CAPTURE_HARD_FAIL_CONSECUTIVE_FAILS="${CHART_OFFLINE_CAPTURE_HARD_FAIL_CONSECUTIVE_FAILS:-2}"
CHART_OFFLINE_CAPTURE_SNAPSHOT_CONSECUTIVE_FAILS="${CHART_OFFLINE_CAPTURE_SNAPSHOT_CONSECUTIVE_FAILS:-1}"
CHART_CAPTURE_REQUIRED_FAILS_FILE="${CHART_CAPTURE_REQUIRED_FAILS_FILE:-${STATE_FILE}.chart_offline_required}"
CHART_CAPTURE_THRESHOLD_REASON_FILE="${CHART_CAPTURE_THRESHOLD_REASON_FILE:-${STATE_FILE}.chart_offline_reason}"
CHART_INCIDENT_STATE_FILE="${CHART_INCIDENT_STATE_FILE:-${ROOT_DIR}/logs/healthwatch/chart-offline/incident-state.json}"
CHART_FULL_CAPTURE_INTERVAL_SEC="${CHART_FULL_CAPTURE_INTERVAL_SEC:-3600}"
PUBLIC_CHART_DIAGNOSTIC_ENABLED="${PUBLIC_CHART_DIAGNOSTIC_ENABLED:-1}"
PUBLIC_CHART_DIAGNOSTIC_INTERVAL_SEC="${PUBLIC_CHART_DIAGNOSTIC_INTERVAL_SEC:-900}"
PUBLIC_CHART_MAX_BARS_STALE_MS="${PUBLIC_CHART_MAX_BARS_STALE_MS:-30000}"
PUBLIC_CHART_DIAGNOSTIC_STATE_FILE="${PUBLIC_CHART_DIAGNOSTIC_STATE_FILE:-${STATE_FILE}.public_chart}"
PUBLIC_CHART_FRESHNESS_STATE_FILE="${PUBLIC_CHART_FRESHNESS_STATE_FILE:-${STATE_FILE}.public_chart_freshness}"
PUBLIC_CHART_RENDERABILITY_STATE_FILE="${PUBLIC_CHART_RENDERABILITY_STATE_FILE:-${STATE_FILE}.public_chart_renderability}"
PUBLIC_CHART_VISUAL_STATE_FILE="${PUBLIC_CHART_VISUAL_STATE_FILE:-${STATE_FILE}.public_chart_visual}"
PUBLIC_CHART_FAILURE_REASON_FILE="${PUBLIC_CHART_FAILURE_REASON_FILE:-${STATE_FILE}.public_chart_failure_reason}"
PUBLIC_CHART_FAILURE_DETAILS_FILE="${PUBLIC_CHART_FAILURE_DETAILS_FILE:-${STATE_FILE}.public_chart_failure_details.json}"
PUBLIC_CHART_DIAGNOSTIC_LAST_RUN_FILE="${PUBLIC_CHART_DIAGNOSTIC_LAST_RUN_FILE:-${STATE_FILE}.public_chart_last_run}"
PUBLIC_CHART_LATEST_DIAG_JSON="${ROOT_DIR}/logs/healthwatch/public-chart/latest/diagnostic.json"
LOCAL_TERMINAL_DIAGNOSTIC_ENABLED="${LOCAL_TERMINAL_DIAGNOSTIC_ENABLED:-1}"
LOCAL_TERMINAL_CAPTURE_FILE="${LOCAL_TERMINAL_CAPTURE_FILE:-${ROOT_DIR}/logs/healthwatch/local-terminal-captures.json}"
LOCAL_TERMINAL_DIAGNOSTIC_JSON="${LOCAL_TERMINAL_DIAGNOSTIC_JSON:-${ROOT_DIR}/logs/healthwatch/local-terminal-diagnostic.json}"
LOCAL_TERMINAL_STALE_AFTER_SEC="${LOCAL_TERMINAL_STALE_AFTER_SEC:-120}"
LOCAL_TERMINAL_ROUTING_BLOCK_CONSECUTIVE_CAPTURES="${LOCAL_TERMINAL_ROUTING_BLOCK_CONSECUTIVE_CAPTURES:-3}"
LOCAL_TERMINAL_STALE_STATE_FILE="${LOCAL_TERMINAL_STALE_STATE_FILE:-${STATE_FILE}.local_terminal_stale}"
LOCAL_TERMINAL_ROUTING_BLOCK_STATE_FILE="${LOCAL_TERMINAL_ROUTING_BLOCK_STATE_FILE:-${STATE_FILE}.local_terminal_routing_block}"

# Comma-separated list of URLs to probe.
URLS_RAW="${HEALTHCHECK_URLS:-http://127.0.0.1:3000/,https://app.txt.gtixt.com/,http://127.0.0.1:8000/health}"
IFS=',' read -r -a URLS <<< "$URLS_RAW"

# Internal services not exposed on host — check via docker exec
DOCKER_HEALTH_TARGETS="risk-gateway:8001 market-data:8003 broker-adapter:8004"
check_docker_health() {
  for entry in $DOCKER_HEALTH_TARGETS; do
    local container="${entry%%:*}"
    local port="${entry##*:}"
    local result
    result="$(docker exec "$container" python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:${port}/health', timeout=5); print('ok')" 2>&1)" || result="FAIL"
    if [[ "$result" != "ok" ]]; then
      alert "WARN" "docker health FAIL: $container:$port → $result"
    fi
  done
}

alert() {
  local level="$1"
  local message="$2"
  local context_json="${3:-null}"
  local now
  now="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

  echo "[$now][$level] $message" | tee -a "$LOG_DIR/healthwatch.log"

  if [[ -n "$ALERT_WEBHOOK_URL" ]]; then
    python3 - "$level" "$message" "$now" "$context_json" <<'PY' | curl -sS --max-time 8 -X POST "$ALERT_WEBHOOK_URL" \
      -H 'content-type: application/json' \
      --data-binary @- >/dev/null || true
import json
import sys

level, message, now, context_json = sys.argv[1:5]
try:
    context = json.loads(context_json)
except Exception:
    context = {"raw": context_json}

print(json.dumps({
    "level": level,
    "message": message,
    "ts": now,
    "context": context,
}, separators=(",", ":")))
PY
  fi

  if [[ -n "$MAIL_TO" ]] && command -v mail >/dev/null 2>&1; then
    printf '%s\n' "$message" | mail -s "[mission-control][$level] healthwatch" "$MAIL_TO" || true
  fi
}

persist_public_chart_diag() {
  local diag_path="$1"
  python3 - "$diag_path" "$PUBLIC_CHART_DIAGNOSTIC_STATE_FILE" "$PUBLIC_CHART_FRESHNESS_STATE_FILE" "$PUBLIC_CHART_RENDERABILITY_STATE_FILE" "$PUBLIC_CHART_VISUAL_STATE_FILE" "$PUBLIC_CHART_FAILURE_REASON_FILE" "$PUBLIC_CHART_FAILURE_DETAILS_FILE" <<'PY'
import json
import sys
from pathlib import Path

diag_path, state_path, freshness_path, renderability_path, visual_path, reason_path, details_path = sys.argv[1:8]
payload = json.loads(Path(diag_path).read_text())

def normalized_text(key, default, allowed):
  value = payload.get(key)
  if isinstance(value, str) and value in allowed:
    return value
  return default

state = normalized_text("public_chart_state", "failed", {"healthy", "degraded", "failed"})
freshness = normalized_text("public_chart_freshness_state", "failed", {"healthy", "degraded", "failed"})
renderability = normalized_text("public_chart_renderability_state", "failed", {"healthy", "failed"})
visual = normalized_text("public_chart_visual_state", "failed", {"healthy", "failed"})
reason = normalized_text("failure_reason", "none", {"none", "freshness", "renderability", "visual"})
details = payload.get("failure_details")
if not isinstance(details, dict):
  details = {"raw": details}
probe_error = payload.get("probe_error")
if probe_error and "diagnostic_error" not in details:
  details["diagnostic_error"] = str(probe_error)

Path(state_path).write_text(f"{state}\n")
Path(freshness_path).write_text(f"{freshness}\n")
Path(renderability_path).write_text(f"{renderability}\n")
Path(visual_path).write_text(f"{visual}\n")
Path(reason_path).write_text(f"{reason}\n")
Path(details_path).write_text(json.dumps(details, separators=(",", ":")) + "\n")
PY
}

public_chart_alert_context() {
  python3 - "$public_chart_state" "$public_chart_freshness_state" "$public_chart_renderability_state" "$public_chart_visual_state" "$public_chart_failure_reason" "$PUBLIC_CHART_FAILURE_DETAILS_FILE" <<'PY'
import json
import sys
from pathlib import Path

state, freshness, renderability, visual, reason, details_path = sys.argv[1:7]
try:
  details = json.loads(Path(details_path).read_text())
except Exception:
  details = {}

print(json.dumps({
  "public_chart_state": state,
  "public_chart_freshness_state": freshness,
  "public_chart_renderability_state": renderability,
  "public_chart_visual_state": visual,
  "failure_reason": reason,
  "failure_details": details,
}, separators=(",", ":")))
PY
}

public_chart_alert_summary() {
  python3 - "$public_chart_state" "$public_chart_freshness_state" "$public_chart_renderability_state" "$public_chart_visual_state" "$public_chart_failure_reason" "$PUBLIC_CHART_FAILURE_DETAILS_FILE" <<'PY'
import json
import sys
from pathlib import Path

state, freshness, renderability, visual, reason, details_path = sys.argv[1:7]
try:
  details = json.loads(Path(details_path).read_text())
except Exception:
  details = {}

parts = [
  f"state={state}",
  f"reason={reason}",
  f"freshness={freshness}",
  f"renderability={renderability}",
  f"visual={visual}",
]

if reason == "freshness":
  stale_ms = details.get("freshness_stale_ms")
  last_bar = details.get("last_bar_timestamp")
  if stale_ms is not None:
    parts.append(f"freshness_stale_ms={stale_ms}")
  if last_bar:
    parts.append(f"last_bar_timestamp={last_bar}")
elif reason == "renderability":
  fetched = details.get("fetchedRows", details.get("fetched_rows"))
  renderable_rows = details.get("renderableRows", details.get("renderable_rows"))
  dropped = details.get("droppedRows", details.get("dropped_rows"))
  if fetched is not None and renderable_rows is not None:
    parts.append(f"rows={renderable_rows}/{fetched}")
  if dropped is not None:
    parts.append(f"dropped_rows={dropped}")
elif reason == "visual":
  candle_pixels = details.get("settledCandlePixels", details.get("settled_candle_pixels"))
  accent_pixels = details.get("accentPixels", details.get("accent_pixels"))
  color_buckets = details.get("colorBuckets", details.get("color_buckets"))
  if candle_pixels is not None:
    parts.append(f"settled_candle_pixels={candle_pixels}")
  if accent_pixels is not None:
    parts.append(f"accent_pixels={accent_pixels}")
  if color_buckets is not None:
    parts.append(f"color_buckets={color_buckets}")

diagnostic_error = details.get("diagnostic_error")
if diagnostic_error:
  parts.append(f"diagnostic_error={diagnostic_error}")

print(", ".join(parts))
PY
}

read_local_terminal_diag_field() {
  local field_name="$1"
  python3 - "$LOCAL_TERMINAL_DIAGNOSTIC_JSON" "$field_name" <<'PY'
import json
import sys
from pathlib import Path

diag_path, field_name = sys.argv[1:3]
try:
  payload = json.loads(Path(diag_path).read_text())
except Exception:
  payload = {}

value = payload.get(field_name)
if isinstance(value, list):
  print(",".join(str(item) for item in value))
elif value is None:
  print("")
else:
  print(value)
PY
}

local_terminal_alert_context() {
  local alert_kind="$1"
  python3 - "$LOCAL_TERMINAL_DIAGNOSTIC_JSON" "$alert_kind" <<'PY'
import json
import sys
from pathlib import Path

diag_path, alert_kind = sys.argv[1:3]
try:
  payload = json.loads(Path(diag_path).read_text())
except Exception:
  payload = {}

latest_capture = payload.get("latest_capture") if isinstance(payload.get("latest_capture"), dict) else {}

print(json.dumps({
  "alert_kind": alert_kind,
  "state": payload.get("state"),
  "capture_freshness_state": payload.get("capture_freshness_state"),
  "renderable_routing_block_state": payload.get("renderable_routing_block_state"),
  "latest_client_id": payload.get("latest_client_id"),
  "latest_capture_at": payload.get("latest_capture_at"),
  "latest_publish_at": payload.get("latest_publish_at"),
  "latest_publish_age_sec": payload.get("latest_publish_age_sec"),
  "stale_after_sec": payload.get("stale_after_sec"),
  "renderable_routing_block_consecutive_count": payload.get("renderable_routing_block_consecutive_count"),
  "renderable_routing_block_threshold": payload.get("renderable_routing_block_threshold"),
  "renderable_routing_block_captured_at": payload.get("renderable_routing_block_captured_at") or [],
  "latest_capture": {
    "feed_label": latest_capture.get("feed_label"),
    "signal": latest_capture.get("signal"),
    "last_bar_timestamp": latest_capture.get("last_bar_timestamp"),
    "bus_status": latest_capture.get("bus_status"),
    "routing_state": latest_capture.get("routing_state"),
    "rejection_reasons": latest_capture.get("rejection_reasons") or [],
    "smart_state_summary": latest_capture.get("smart_state_summary"),
    "truth_exchange_status": latest_capture.get("truth_exchange_status"),
    "truth_exchange_age_ms": latest_capture.get("truth_exchange_age_ms"),
    "auto_incident_status": latest_capture.get("auto_incident_status"),
  },
}, separators=(",", ":")))
PY
}

local_terminal_stale_summary() {
  python3 - "$LOCAL_TERMINAL_DIAGNOSTIC_JSON" <<'PY'
import json
import sys
from pathlib import Path

try:
  payload = json.loads(Path(sys.argv[1]).read_text())
except Exception:
  payload = {}

latest_capture = payload.get("latest_capture") if isinstance(payload.get("latest_capture"), dict) else {}
parts = [
  f"freshness={payload.get('capture_freshness_state', 'missing')}",
  f"publish_age_sec={payload.get('latest_publish_age_sec', 'n/a')}",
  f"threshold_sec={payload.get('stale_after_sec', 'n/a')}",
]
if latest_capture.get("feed_label"):
  parts.append(f"feed={latest_capture.get('feed_label')}")
if payload.get("latest_capture_at"):
  parts.append(f"captured_at={payload.get('latest_capture_at')}")
if latest_capture.get("signal"):
  parts.append(f"signal={latest_capture.get('signal')}")
print(", ".join(parts))
PY
}

local_terminal_routing_block_summary() {
  python3 - "$LOCAL_TERMINAL_DIAGNOSTIC_JSON" <<'PY'
import json
import sys
from pathlib import Path

try:
  payload = json.loads(Path(sys.argv[1]).read_text())
except Exception:
  payload = {}

latest_capture = payload.get("latest_capture") if isinstance(payload.get("latest_capture"), dict) else {}
reasons = latest_capture.get("rejection_reasons") or []
parts = [
  f"state={payload.get('renderable_routing_block_state', 'missing')}",
  f"consecutive={payload.get('renderable_routing_block_consecutive_count', 0)}/{payload.get('renderable_routing_block_threshold', 'n/a')}",
]
if latest_capture.get("feed_label"):
  parts.append(f"feed={latest_capture.get('feed_label')}")
if latest_capture.get("signal"):
  parts.append(f"signal={latest_capture.get('signal')}")
if latest_capture.get("routing_state"):
  parts.append(f"routing_state={latest_capture.get('routing_state')}")
if reasons:
  parts.append(f"reasons={','.join(str(reason) for reason in reasons)}")
if latest_capture.get("smart_state_summary"):
  parts.append(f"smart={latest_capture.get('smart_state_summary')}")
print(", ".join(parts))
PY
}

emit_public_chart_transition_alert() {
  local previous_state="$1"
  local alert_context
  local alert_summary
  alert_context="$(public_chart_alert_context)"
  alert_summary="$(public_chart_alert_summary)"

  if [[ "$public_chart_state" == "healthy" ]]; then
  if [[ "$previous_state" != "healthy" ]]; then
    alert "recovery" "Public chart visibility recovered. ${alert_summary}" "$alert_context"
  fi
  return
  fi

  if [[ "$public_chart_state" == "$previous_state" ]]; then
  return
  fi

  if [[ "$public_chart_state" == "degraded" ]]; then
  alert "warning" "Public chart degraded. ${alert_summary}" "$alert_context"
  return
  fi

  alert "critical" "Public chart failed. ${alert_summary}" "$alert_context"
}

probe_url() {
  local url="$1"
  local code
  code="$(curl -k --max-time 12 -sS -o /tmp/healthwatch_body.out -w '%{http_code}' -H "Host: $HOST_HEADER" "$url" || echo 000)"
  printf '%s %s\n' "$url" "$code"

  if [[ "$code" =~ ^5[0-9][0-9]$ ]]; then
    return 5
  fi

  if [[ "$code" == "000" ]]; then
    return 4
  fi

  return 0
}

current_state="healthy"
if [[ -f "$STATE_FILE" ]]; then
  current_state="$(cat "$STATE_FILE" 2>/dev/null || echo healthy)"
fi

chart_capture_state="healthy"
if [[ -f "$CHART_CAPTURE_STATE_FILE" ]]; then
  chart_capture_state="$(cat "$CHART_CAPTURE_STATE_FILE" 2>/dev/null || echo healthy)"
fi

chart_capture_count=0
if [[ -f "$CHART_CAPTURE_COUNT_FILE" ]]; then
  chart_capture_count="$(cat "$CHART_CAPTURE_COUNT_FILE" 2>/dev/null || echo 0)"
fi

chart_capture_required_fails="$CHART_OFFLINE_CAPTURE_CONSECUTIVE_FAILS"
if [[ -f "$CHART_CAPTURE_REQUIRED_FAILS_FILE" ]]; then
  chart_capture_required_fails="$(cat "$CHART_CAPTURE_REQUIRED_FAILS_FILE" 2>/dev/null || echo "$CHART_OFFLINE_CAPTURE_CONSECUTIVE_FAILS")"
fi

chart_capture_threshold_reason="healthy"
if [[ -f "$CHART_CAPTURE_THRESHOLD_REASON_FILE" ]]; then
  chart_capture_threshold_reason="$(cat "$CHART_CAPTURE_THRESHOLD_REASON_FILE" 2>/dev/null || echo healthy)"
fi

public_chart_state="healthy"
if [[ -f "$PUBLIC_CHART_DIAGNOSTIC_STATE_FILE" ]]; then
  public_chart_state="$(cat "$PUBLIC_CHART_DIAGNOSTIC_STATE_FILE" 2>/dev/null || echo healthy)"
fi

public_chart_freshness_state="healthy"
if [[ -f "$PUBLIC_CHART_FRESHNESS_STATE_FILE" ]]; then
  public_chart_freshness_state="$(cat "$PUBLIC_CHART_FRESHNESS_STATE_FILE" 2>/dev/null || echo healthy)"
fi

public_chart_renderability_state="healthy"
if [[ -f "$PUBLIC_CHART_RENDERABILITY_STATE_FILE" ]]; then
  public_chart_renderability_state="$(cat "$PUBLIC_CHART_RENDERABILITY_STATE_FILE" 2>/dev/null || echo healthy)"
fi

public_chart_visual_state="healthy"
if [[ -f "$PUBLIC_CHART_VISUAL_STATE_FILE" ]]; then
  public_chart_visual_state="$(cat "$PUBLIC_CHART_VISUAL_STATE_FILE" 2>/dev/null || echo healthy)"
fi

public_chart_failure_reason="none"
if [[ -f "$PUBLIC_CHART_FAILURE_REASON_FILE" ]]; then
  public_chart_failure_reason="$(cat "$PUBLIC_CHART_FAILURE_REASON_FILE" 2>/dev/null || echo none)"
fi

local_terminal_stale_state="healthy"
if [[ -f "$LOCAL_TERMINAL_STALE_STATE_FILE" ]]; then
  local_terminal_stale_state="$(cat "$LOCAL_TERMINAL_STALE_STATE_FILE" 2>/dev/null || echo healthy)"
fi

local_terminal_routing_block_state="healthy"
if [[ -f "$LOCAL_TERMINAL_ROUTING_BLOCK_STATE_FILE" ]]; then
  local_terminal_routing_block_state="$(cat "$LOCAL_TERMINAL_ROUTING_BLOCK_STATE_FILE" 2>/dev/null || echo healthy)"
fi

if [[ ! -f "$PUBLIC_CHART_FAILURE_DETAILS_FILE" ]]; then
  printf '{"diagnostic_error":null}\n' > "$PUBLIC_CHART_FAILURE_DETAILS_FILE"
fi

for u in "${URLS[@]}"; do
  if ! result="$(probe_url "$u")"; then
    code="${result##* }"
    if [[ "$current_state" != "failed" ]]; then
      alert "critical" "First 5xx detected on $u (code=$code). Immediate action required."
      echo "failed" > "$STATE_FILE"
    fi
    exit 2
  fi
done

# Check internal services via docker exec
check_docker_health

if [[ "$UI_ASSET_CHECK_ENABLED" == "1" ]]; then
  if ! asset_result="$("$ROOT_DIR/scripts/check_ui_static_assets.sh" --base-url "$UI_BASE_URL" --host "$HOST_HEADER" 2>&1)"; then
    if [[ "$current_state" != "failed" ]]; then
      alert "critical" "Next static asset check failed on $UI_BASE_URL. Details: $(printf '%s' "$asset_result" | tail -n 1)"
      echo "failed" > "$STATE_FILE"
    fi
    exit 2
  fi
  printf '%s\n' "$asset_result" >> "$LOG_DIR/healthwatch.log"
fi

if [[ "$CHART_OFFLINE_CAPTURE_ENABLED" == "1" ]]; then
  set +e
  chart_capture_output="$(CAPTURE_PERSIST_ON_CRITICAL=0 "$ROOT_DIR/scripts/capture_chart_offline_context.sh" 2>&1)"
  capture_exit=$?
  set -e
  printf '%s\n' "$chart_capture_output" >> "$LOG_DIR/healthwatch.log"

  if [[ $capture_exit -eq 0 || $capture_exit -eq 10 ]]; then
    decision_file="$(mktemp)"
    trap 'rm -f "$decision_file"' EXIT
    python3 "$ROOT_DIR/scripts/healthwatch_incident_policy.py" \
      --probe "$ROOT_DIR/logs/healthwatch/chart-offline/latest-probe.json" \
      --state "$CHART_INCIDENT_STATE_FILE" \
      --decision "$decision_file" \
      --full-capture-interval-seconds "$CHART_FULL_CAPTURE_INTERVAL_SEC" \
      --daily-summary-dir "$ROOT_DIR/logs/healthwatch/chart-offline/daily" \
      >> "$LOG_DIR/healthwatch.log"
    read -r capture_full capture_event capture_signature incident_occurrences < <(
      python3 - "$decision_file" <<'PY'
import json
import sys
from pathlib import Path

decision = json.loads(Path(sys.argv[1]).read_text())
print(
    "1" if decision.get("capture_full") else "0",
    decision.get("event") or "UNKNOWN",
    decision.get("signature") or "none",
    int(decision.get("occurrences") or 0),
)
PY
    )
    if [[ $capture_exit -eq 10 ]]; then
      echo "$incident_occurrences" > "$CHART_CAPTURE_COUNT_FILE"
    else
      echo "0" > "$CHART_CAPTURE_COUNT_FILE"
    fi
    echo "1" > "$CHART_CAPTURE_REQUIRED_FAILS_FILE"
    echo "signature-policy" > "$CHART_CAPTURE_THRESHOLD_REASON_FILE"

    if [[ "$capture_full" == "1" ]]; then
      set +e
      persisted_chart_capture_output="$(
        CAPTURE_PERSIST_ON_CRITICAL=1 \
        CAPTURE_FORCE_PERSIST=1 \
        CAPTURE_PROBE_INPUT="$ROOT_DIR/logs/healthwatch/chart-offline/latest-probe.json" \
        CAPTURE_EVENT_TYPE="$capture_event" \
        CAPTURE_INCIDENT_SIGNATURE="$capture_signature" \
        "$ROOT_DIR/scripts/capture_chart_offline_context.sh" 2>&1
      )"
      persisted_capture_exit=$?
      set -e
      if [[ $persisted_capture_exit -ne 0 && $persisted_capture_exit -ne 10 ]]; then
        alert "warning" "Chart Healthwatch event capture failed unexpectedly (exit=${persisted_capture_exit}, event=${capture_event})."
      fi
      printf '%s\n' "$persisted_chart_capture_output" >> "$LOG_DIR/healthwatch.log"
    fi

    if [[ "$capture_event" == "RECOVERY" ]]; then
      alert "recovery" "Chart OHLCV pipeline recovered; recovery evidence captured."
      echo "healthy" > "$CHART_CAPTURE_STATE_FILE"
    elif [[ $capture_exit -eq 10 ]]; then
      if [[ "$capture_event" == "FIRST_FAILURE" || "$capture_event" == "SIGNATURE_CHANGE" ]]; then
        alert "warning" "Chart Healthwatch incident ${capture_event}; full evidence captured (occurrence=${incident_occurrences})."
      fi
      echo "active" > "$CHART_CAPTURE_STATE_FILE"
    else
      echo "healthy" > "$CHART_CAPTURE_STATE_FILE"
    fi
    rm -f "$decision_file"
    trap - EXIT
  else
    alert "warning" "Chart OHLCV capture probe failed unexpectedly (exit=$capture_exit)."
  fi
fi

if [[ "$PUBLIC_CHART_DIAGNOSTIC_ENABLED" == "1" ]]; then
  now_epoch="$(date +%s)"
  last_public_chart_run=0
  if [[ -f "$PUBLIC_CHART_DIAGNOSTIC_LAST_RUN_FILE" ]]; then
    last_public_chart_run="$(cat "$PUBLIC_CHART_DIAGNOSTIC_LAST_RUN_FILE" 2>/dev/null || echo 0)"
  fi

  if (( now_epoch - last_public_chart_run >= PUBLIC_CHART_DIAGNOSTIC_INTERVAL_SEC )); then
    previous_public_chart_state="$public_chart_state"
    echo "$now_epoch" > "$PUBLIC_CHART_DIAGNOSTIC_LAST_RUN_FILE"
    if public_chart_output="$(PUBLIC_CHART_MAX_BARS_STALE_MS="$PUBLIC_CHART_MAX_BARS_STALE_MS" $ROOT_DIR/scripts/check_public_chart_visibility.sh 2>&1)"; then
      printf '%s\n' "$public_chart_output" >> "$LOG_DIR/healthwatch.log"
      if ! persist_public_chart_diag "$PUBLIC_CHART_LATEST_DIAG_JSON"; then
        echo "failed" > "$PUBLIC_CHART_DIAGNOSTIC_STATE_FILE"
        echo "failed" > "$PUBLIC_CHART_FRESHNESS_STATE_FILE"
        echo "failed" > "$PUBLIC_CHART_RENDERABILITY_STATE_FILE"
        echo "failed" > "$PUBLIC_CHART_VISUAL_STATE_FILE"
        echo "none" > "$PUBLIC_CHART_FAILURE_REASON_FILE"
        printf '{"diagnostic_error":"structured_public_chart_diagnostic_parse_failed"}\n' > "$PUBLIC_CHART_FAILURE_DETAILS_FILE"
      fi
    else
      printf '%s\n' "$public_chart_output" >> "$LOG_DIR/healthwatch.log"

      if [[ -f "$PUBLIC_CHART_LATEST_DIAG_JSON" ]] && persist_public_chart_diag "$PUBLIC_CHART_LATEST_DIAG_JSON"; then
        :
      else
        echo "failed" > "$PUBLIC_CHART_DIAGNOSTIC_STATE_FILE"
        echo "failed" > "$PUBLIC_CHART_FRESHNESS_STATE_FILE"
        echo "failed" > "$PUBLIC_CHART_RENDERABILITY_STATE_FILE"
        echo "failed" > "$PUBLIC_CHART_VISUAL_STATE_FILE"
        echo "none" > "$PUBLIC_CHART_FAILURE_REASON_FILE"
        printf '{"diagnostic_error":%s}\n' "$(python3 - "$public_chart_output" <<'PY'
import json
import sys

print(json.dumps(str(sys.argv[1]).splitlines()[-1] if str(sys.argv[1]).splitlines() else "public_chart_probe_failed"))
PY
)" > "$PUBLIC_CHART_FAILURE_DETAILS_FILE"
      fi
    fi

    public_chart_state="$(cat "$PUBLIC_CHART_DIAGNOSTIC_STATE_FILE" 2>/dev/null || echo failed)"
    public_chart_freshness_state="$(cat "$PUBLIC_CHART_FRESHNESS_STATE_FILE" 2>/dev/null || echo failed)"
    public_chart_renderability_state="$(cat "$PUBLIC_CHART_RENDERABILITY_STATE_FILE" 2>/dev/null || echo failed)"
    public_chart_visual_state="$(cat "$PUBLIC_CHART_VISUAL_STATE_FILE" 2>/dev/null || echo failed)"
    public_chart_failure_reason="$(cat "$PUBLIC_CHART_FAILURE_REASON_FILE" 2>/dev/null || echo none)"

    emit_public_chart_transition_alert "$previous_public_chart_state"
  fi
fi

if [[ "$LOCAL_TERMINAL_DIAGNOSTIC_ENABLED" == "1" ]]; then
  previous_local_terminal_stale_state="$local_terminal_stale_state"
  previous_local_terminal_routing_block_state="$local_terminal_routing_block_state"

  local_terminal_output="$(LOCAL_TERMINAL_CAPTURE_FILE="$LOCAL_TERMINAL_CAPTURE_FILE" \
    LOCAL_TERMINAL_DIAGNOSTIC_JSON="$LOCAL_TERMINAL_DIAGNOSTIC_JSON" \
    LOCAL_TERMINAL_STALE_AFTER_SEC="$LOCAL_TERMINAL_STALE_AFTER_SEC" \
    LOCAL_TERMINAL_ROUTING_BLOCK_CONSECUTIVE_CAPTURES="$LOCAL_TERMINAL_ROUTING_BLOCK_CONSECUTIVE_CAPTURES" \
    bash "$ROOT_DIR/scripts/check_local_terminal_health.sh" 2>&1 || true)"
  printf '%s\n' "$local_terminal_output" >> "$LOG_DIR/healthwatch.log"

  local_terminal_stale_state="$(read_local_terminal_diag_field capture_freshness_state)"
  local_terminal_routing_block_state="$(read_local_terminal_diag_field renderable_routing_block_state)"

  if [[ -z "$local_terminal_stale_state" ]]; then
    local_terminal_stale_state="missing"
  fi
  if [[ -z "$local_terminal_routing_block_state" ]]; then
    local_terminal_routing_block_state="missing"
  fi

  if [[ "$local_terminal_stale_state" == "healthy" ]]; then
    if [[ "$previous_local_terminal_stale_state" != "healthy" ]]; then
      alert "recovery" "Local terminal capture publishing recovered. $(local_terminal_stale_summary)" "$(local_terminal_alert_context stale)"
    fi
  elif [[ "$previous_local_terminal_stale_state" == "healthy" ]]; then
    alert "critical" "Local terminal capture publishing stalled. $(local_terminal_stale_summary)" "$(local_terminal_alert_context stale)"
  fi

  if [[ "$local_terminal_routing_block_state" == "blocked" ]]; then
    if [[ "$previous_local_terminal_routing_block_state" != "blocked" ]]; then
      alert "critical" "Local terminal OHLCV stays renderable while routing remains blocked. $(local_terminal_routing_block_summary)" "$(local_terminal_alert_context routing-blocked)"
    fi
  elif [[ "$previous_local_terminal_routing_block_state" == "blocked" ]]; then
    alert "recovery" "Local terminal renderable-but-blocked routing condition cleared. $(local_terminal_routing_block_summary)" "$(local_terminal_alert_context routing-blocked)"
  fi

  echo "$local_terminal_stale_state" > "$LOCAL_TERMINAL_STALE_STATE_FILE"
  echo "$local_terminal_routing_block_state" > "$LOCAL_TERMINAL_ROUTING_BLOCK_STATE_FILE"
fi

if [[ "$current_state" == "failed" ]]; then
  alert "recovery" "Healthwatch recovered: no 5xx on configured endpoints."
fi

STATE_FILE="$STATE_FILE" \
CHART_CAPTURE_STATE_FILE="$CHART_CAPTURE_STATE_FILE" \
CHART_CAPTURE_COUNT_FILE="$CHART_CAPTURE_COUNT_FILE" \
CHART_OFFLINE_CAPTURE_CONSECUTIVE_FAILS="$CHART_OFFLINE_CAPTURE_CONSECUTIVE_FAILS" \
CHART_CAPTURE_REQUIRED_FAILS_FILE="$CHART_CAPTURE_REQUIRED_FAILS_FILE" \
CHART_CAPTURE_THRESHOLD_REASON_FILE="$CHART_CAPTURE_THRESHOLD_REASON_FILE" \
PUBLIC_CHART_DIAGNOSTIC_STATE_FILE="$PUBLIC_CHART_DIAGNOSTIC_STATE_FILE" \
PUBLIC_CHART_FRESHNESS_STATE_FILE="$PUBLIC_CHART_FRESHNESS_STATE_FILE" \
PUBLIC_CHART_RENDERABILITY_STATE_FILE="$PUBLIC_CHART_RENDERABILITY_STATE_FILE" \
PUBLIC_CHART_VISUAL_STATE_FILE="$PUBLIC_CHART_VISUAL_STATE_FILE" \
PUBLIC_CHART_FAILURE_REASON_FILE="$PUBLIC_CHART_FAILURE_REASON_FILE" \
PUBLIC_CHART_FAILURE_DETAILS_FILE="$PUBLIC_CHART_FAILURE_DETAILS_FILE" \
LOCAL_TERMINAL_DIAGNOSTIC_JSON="$LOCAL_TERMINAL_DIAGNOSTIC_JSON" \
LOCAL_TERMINAL_STALE_STATE_FILE="$LOCAL_TERMINAL_STALE_STATE_FILE" \
LOCAL_TERMINAL_ROUTING_BLOCK_STATE_FILE="$LOCAL_TERMINAL_ROUTING_BLOCK_STATE_FILE" \
bash "$ROOT_DIR/scripts/write_healthwatch_dashboard.sh" || true

echo "healthy" > "$STATE_FILE"
exit 0
