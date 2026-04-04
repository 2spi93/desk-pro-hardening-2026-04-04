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

# Comma-separated list of URLs to probe.
URLS_RAW="${HEALTHCHECK_URLS:-http://127.0.0.1:3000/,https://app.txt.gtixt.com/,http://127.0.0.1:8000/health,http://127.0.0.1:8003/health,http://127.0.0.1:8001/health,http://127.0.0.1:8004/health}"
IFS=',' read -r -a URLS <<< "$URLS_RAW"

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
  if chart_capture_output="$(CAPTURE_PERSIST_ON_CRITICAL=0 $ROOT_DIR/scripts/capture_chart_offline_context.sh 2>&1)"; then
    chart_capture_count=0
    chart_capture_required_fails="$CHART_OFFLINE_CAPTURE_CONSECUTIVE_FAILS"
    chart_capture_threshold_reason="healthy"
    echo "$chart_capture_count" > "$CHART_CAPTURE_COUNT_FILE"
    echo "$chart_capture_required_fails" > "$CHART_CAPTURE_REQUIRED_FAILS_FILE"
    echo "$chart_capture_threshold_reason" > "$CHART_CAPTURE_THRESHOLD_REASON_FILE"
    if [[ "$chart_capture_state" == "captured" ]]; then
      alert "recovery" "Chart OHLCV pipeline recovered: offline capture condition cleared."
    fi
    echo "healthy" > "$CHART_CAPTURE_STATE_FILE"
  else
    capture_exit=$?
    if [[ $capture_exit -eq 10 ]]; then
      if [[ -f "$ROOT_DIR/logs/healthwatch/chart-offline/latest-probe.json" ]]; then
        threshold_eval="$(python3 - "$ROOT_DIR/logs/healthwatch/chart-offline/latest-probe.json" "$CHART_OFFLINE_CAPTURE_CONSECUTIVE_FAILS" "$CHART_OFFLINE_CAPTURE_HARD_FAIL_CONSECUTIVE_FAILS" "$CHART_OFFLINE_CAPTURE_SNAPSHOT_CONSECUTIVE_FAILS" <<'PY'
import json
import sys
from pathlib import Path

probe_path, default_threshold, hard_fail_threshold, snapshot_threshold = sys.argv[1:5]
payload = json.loads(Path(probe_path).read_text())
reasons = payload.get("offline_reasons") if isinstance(payload, dict) else []
reasons = reasons if isinstance(reasons, list) else []

snapshot_reasons = {
    "control_plane_snapshot_unavailable",
    "control_plane_snapshot_missing",
    "snapshot_non_200",
    "snapshot_structural_data_loss",
}
hard_fail_reasons = {
    "ohlcv_component_hard_fail",
    "depth_component_hard_fail",
    "trades_component_hard_fail",
    "ohlcv_seq_missing_hard_fail",
}

if any(reason in snapshot_reasons for reason in reasons):
    print(f"{int(snapshot_threshold)} snapshot")
elif any(reason in hard_fail_reasons for reason in reasons):
    print(f"{int(hard_fail_threshold)} hard-fail")
else:
    print(f"{int(default_threshold)} default")
PY
)"
        chart_capture_required_fails="${threshold_eval%% *}"
        chart_capture_threshold_reason="${threshold_eval#* }"
      else
        chart_capture_required_fails="$CHART_OFFLINE_CAPTURE_CONSECUTIVE_FAILS"
        chart_capture_threshold_reason="default"
      fi

      chart_capture_count=$((chart_capture_count + 1))
      echo "$chart_capture_count" > "$CHART_CAPTURE_COUNT_FILE"
      echo "$chart_capture_required_fails" > "$CHART_CAPTURE_REQUIRED_FAILS_FILE"
      echo "$chart_capture_threshold_reason" > "$CHART_CAPTURE_THRESHOLD_REASON_FILE"
      printf '%s\n' "$chart_capture_output" >> "$LOG_DIR/healthwatch.log"
      if (( chart_capture_count >= chart_capture_required_fails )); then
        persisted_chart_capture_output="$(CAPTURE_PERSIST_ON_CRITICAL=1 $ROOT_DIR/scripts/capture_chart_offline_context.sh 2>&1 || true)"
        printf '%s\n' "$persisted_chart_capture_output" >> "$LOG_DIR/healthwatch.log"
        if [[ "$chart_capture_state" != "captured" ]]; then
          alert "warning" "Chart OHLCV offline context captured after ${chart_capture_count}/${chart_capture_required_fails} consecutive ${chart_capture_threshold_reason} critical runs. $(printf '%s' "$persisted_chart_capture_output" | tail -n 1)"
        fi
        echo "captured" > "$CHART_CAPTURE_STATE_FILE"
      else
        echo "pending" > "$CHART_CAPTURE_STATE_FILE"
      fi
    else
      printf '%s\n' "$chart_capture_output" >> "$LOG_DIR/healthwatch.log"
      alert "warning" "Chart OHLCV capture probe failed unexpectedly (exit=$capture_exit)."
    fi
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
bash "$ROOT_DIR/scripts/write_healthwatch_dashboard.sh" || true

echo "healthy" > "$STATE_FILE"
exit 0
