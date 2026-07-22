#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${ROOT_DIR}/logs/healthwatch"
mkdir -p "$LOG_DIR"

DASHBOARD_JSON="${LOG_DIR}/dashboard.json"
DASHBOARD_MD="${LOG_DIR}/dashboard.md"
CHART_PROBE_JSON="${ROOT_DIR}/logs/healthwatch/chart-offline/latest-probe.json"
PUBLIC_DIAG_JSON="${ROOT_DIR}/logs/healthwatch/public-chart/latest/diagnostic.json"

STATE_FILE="${STATE_FILE:-/tmp/mission-control-healthwatch.state}"
CHART_CAPTURE_STATE_FILE="${CHART_CAPTURE_STATE_FILE:-${STATE_FILE}.chart_offline}"
CHART_CAPTURE_COUNT_FILE="${CHART_CAPTURE_COUNT_FILE:-${STATE_FILE}.chart_offline_count}"
CHART_CAPTURE_THRESHOLD="${CHART_OFFLINE_CAPTURE_CONSECUTIVE_FAILS:-2}"
CHART_CAPTURE_REQUIRED_FAILS_FILE="${CHART_CAPTURE_REQUIRED_FAILS_FILE:-${STATE_FILE}.chart_offline_required}"
CHART_CAPTURE_THRESHOLD_REASON_FILE="${CHART_CAPTURE_THRESHOLD_REASON_FILE:-${STATE_FILE}.chart_offline_reason}"
PUBLIC_CHART_DIAGNOSTIC_STATE_FILE="${PUBLIC_CHART_DIAGNOSTIC_STATE_FILE:-${STATE_FILE}.public_chart}"
PUBLIC_CHART_FRESHNESS_STATE_FILE="${PUBLIC_CHART_FRESHNESS_STATE_FILE:-${STATE_FILE}.public_chart_freshness}"
PUBLIC_CHART_RENDERABILITY_STATE_FILE="${PUBLIC_CHART_RENDERABILITY_STATE_FILE:-${STATE_FILE}.public_chart_renderability}"
PUBLIC_CHART_VISUAL_STATE_FILE="${PUBLIC_CHART_VISUAL_STATE_FILE:-${STATE_FILE}.public_chart_visual}"
PUBLIC_CHART_FAILURE_REASON_FILE="${PUBLIC_CHART_FAILURE_REASON_FILE:-${STATE_FILE}.public_chart_failure_reason}"
PUBLIC_CHART_FAILURE_DETAILS_FILE="${PUBLIC_CHART_FAILURE_DETAILS_FILE:-${STATE_FILE}.public_chart_failure_details.json}"
LOCAL_TERMINAL_DIAGNOSTIC_JSON="${LOCAL_TERMINAL_DIAGNOSTIC_JSON:-${ROOT_DIR}/logs/healthwatch/local-terminal-diagnostic.json}"
LOCAL_TERMINAL_STALE_STATE_FILE="${LOCAL_TERMINAL_STALE_STATE_FILE:-${STATE_FILE}.local_terminal_stale}"
LOCAL_TERMINAL_ROUTING_BLOCK_STATE_FILE="${LOCAL_TERMINAL_ROUTING_BLOCK_STATE_FILE:-${STATE_FILE}.local_terminal_routing_block}"

python3 - "$DASHBOARD_JSON" "$DASHBOARD_MD" "$STATE_FILE" "$CHART_CAPTURE_STATE_FILE" "$CHART_CAPTURE_COUNT_FILE" "$CHART_CAPTURE_THRESHOLD" "$CHART_CAPTURE_REQUIRED_FAILS_FILE" "$CHART_CAPTURE_THRESHOLD_REASON_FILE" "$PUBLIC_CHART_DIAGNOSTIC_STATE_FILE" "$PUBLIC_CHART_FRESHNESS_STATE_FILE" "$PUBLIC_CHART_RENDERABILITY_STATE_FILE" "$PUBLIC_CHART_VISUAL_STATE_FILE" "$PUBLIC_CHART_FAILURE_REASON_FILE" "$PUBLIC_CHART_FAILURE_DETAILS_FILE" "$LOCAL_TERMINAL_DIAGNOSTIC_JSON" "$LOCAL_TERMINAL_STALE_STATE_FILE" "$LOCAL_TERMINAL_ROUTING_BLOCK_STATE_FILE" "$CHART_PROBE_JSON" "$PUBLIC_DIAG_JSON" <<'PY'
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
import tempfile

(
    dashboard_json_path,
    dashboard_md_path,
    state_file,
    chart_capture_state_file,
    chart_capture_count_file,
    chart_capture_threshold,
    chart_capture_required_fails_file,
    chart_capture_threshold_reason_file,
    public_chart_state_file,
    public_chart_freshness_state_file,
    public_chart_renderability_state_file,
    public_chart_visual_state_file,
    public_chart_failure_reason_file,
    public_chart_failure_details_file,
    local_terminal_diag_path,
    local_terminal_stale_state_file,
    local_terminal_routing_block_state_file,
    chart_probe_path,
    public_diag_path,
) = sys.argv[1:20]


def read_text(path: str, default: str) -> str:
    try:
        return Path(path).read_text().strip() or default
    except Exception:
        return default


def read_json(path: str):
    try:
        return json.loads(Path(path).read_text())
    except Exception:
        return None


def atomic_write_text(path: str, value: str) -> None:
    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{destination.name}.", dir=destination.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, destination)
    finally:
        Path(temporary_name).unlink(missing_ok=True)


chart_probe = read_json(chart_probe_path) or {}
chart_incident = read_json(str(Path(chart_probe_path).with_name("incident-state.json"))) or {}
public_diag = read_json(public_diag_path) or {}
local_terminal_diag = read_json(local_terminal_diag_path) or {}
offline_alignment = chart_probe.get("public_signal_alignment") if isinstance(chart_probe, dict) else None
advisory_reasons = chart_probe.get("advisory_reasons") if isinstance(chart_probe, dict) else []
offline_reasons = chart_probe.get("offline_reasons") if isinstance(chart_probe, dict) else []

early = public_diag.get("early") if isinstance(public_diag, dict) else None
settled = public_diag.get("settled") if isinstance(public_diag, dict) else None
settled_full = public_diag.get("settledFull") if isinstance(public_diag, dict) else None
ohlcv_contract = public_diag.get("ohlcvContract") if isinstance(public_diag, dict) else None
public_chart_state = read_text(public_chart_state_file, str(public_diag.get("public_chart_state") or "healthy"))
freshness_state = read_text(public_chart_freshness_state_file, str(public_diag.get("public_chart_freshness_state") or "healthy"))
renderability_state = read_text(public_chart_renderability_state_file, str(public_diag.get("public_chart_renderability_state") or "healthy"))
visual_state = read_text(public_chart_visual_state_file, str(public_diag.get("public_chart_visual_state") or "healthy"))
failure_reason = read_text(public_chart_failure_reason_file, str(public_diag.get("failure_reason") or "none"))
failure_details = read_json(public_chart_failure_details_file)
if not isinstance(failure_details, dict):
    fallback_details = public_diag.get("failure_details") if isinstance(public_diag, dict) else None
    failure_details = fallback_details if isinstance(fallback_details, dict) else {}

local_terminal_capture = local_terminal_diag.get("latest_capture") if isinstance(local_terminal_diag, dict) and isinstance(local_terminal_diag.get("latest_capture"), dict) else {}
local_terminal_state = str(local_terminal_diag.get("state") or "unknown")
local_terminal_freshness_state = str(local_terminal_diag.get("capture_freshness_state") or "missing")
local_terminal_routing_state = str(local_terminal_diag.get("renderable_routing_block_state") or "missing")
local_terminal_reasons = local_terminal_capture.get("rejection_reasons") if isinstance(local_terminal_capture.get("rejection_reasons"), list) else []

data = {
    "generated_at": datetime.now(timezone.utc).isoformat(),
    "healthwatch": {
        "state": read_text(state_file, "healthy"),
    },
    "chart_offline_capture": {
        "state": read_text(chart_capture_state_file, "healthy"),
        "consecutive_critical_runs": int(read_text(chart_capture_count_file, "0") or 0),
        "threshold": int(chart_capture_threshold),
        "active_threshold": int(read_text(chart_capture_required_fails_file, chart_capture_threshold) or chart_capture_threshold),
        "threshold_reason": read_text(chart_capture_threshold_reason_file, "healthy"),
        "offline": bool(chart_probe.get("offline")) if isinstance(chart_probe, dict) else False,
        "offline_reasons": offline_reasons if isinstance(offline_reasons, list) else [],
        "advisory_reasons": advisory_reasons if isinstance(advisory_reasons, list) else [],
        "public_signal_alignment": offline_alignment if isinstance(offline_alignment, dict) else {},
        "captured_at": chart_probe.get("captured_at") if isinstance(chart_probe, dict) else None,
        "event_count": int(chart_incident.get("occurrences") or 0),
        "artifact_policy": "first-change-recovery-hourly",
        "incident_signature": chart_incident.get("signature"),
        "first_seen": chart_incident.get("first_seen"),
        "last_seen": chart_incident.get("last_seen"),
        "last_full_capture": chart_incident.get("last_full_capture"),
    },
    "public_chart_visibility": {
        "state": public_chart_state,
        "public_chart_state": public_chart_state,
        "failure_domain": failure_reason,
        "failure_reason": failure_reason,
        "failure_details": failure_details,
        "freshness_state": freshness_state,
        "renderability_state": renderability_state,
        "visual_state": visual_state,
        "auth_status": ((public_diag.get("authState") or {}).get("authStatus")) if isinstance(public_diag, dict) else None,
        "ohlcv_contract": ohlcv_contract,
        "thresholds": public_diag.get("thresholds") if isinstance(public_diag, dict) else None,
        "early": early,
        "settled": settled,
        "settled_full": settled_full,
    },
    "local_terminal_health": {
        "state": local_terminal_state,
        "capture_freshness_state": local_terminal_freshness_state,
        "stale_alert_state": read_text(local_terminal_stale_state_file, local_terminal_freshness_state),
        "routing_block_alert_state": read_text(local_terminal_routing_block_state_file, local_terminal_routing_state),
        "latest_client_id": local_terminal_diag.get("latest_client_id"),
        "latest_capture_at": local_terminal_diag.get("latest_capture_at"),
        "latest_publish_at": local_terminal_diag.get("latest_publish_at"),
        "latest_publish_age_sec": local_terminal_diag.get("latest_publish_age_sec"),
        "stale_after_sec": local_terminal_diag.get("stale_after_sec"),
        "capture_history_evaluated": local_terminal_diag.get("capture_history_evaluated"),
        "latest_feed_label": local_terminal_capture.get("feed_label"),
        "latest_signal": local_terminal_capture.get("signal"),
        "latest_last_bar_timestamp": local_terminal_capture.get("last_bar_timestamp"),
        "latest_bus_status": local_terminal_capture.get("bus_status"),
        "latest_routing_state": local_terminal_capture.get("routing_state"),
        "latest_rejection_reasons": local_terminal_reasons,
        "smart_state_summary": local_terminal_capture.get("smart_state_summary"),
        "truth_exchange_status": local_terminal_capture.get("truth_exchange_status"),
        "truth_exchange_age_ms": local_terminal_capture.get("truth_exchange_age_ms"),
        "auto_incident_status": local_terminal_capture.get("auto_incident_status"),
        "renderable_routing_block_state": local_terminal_routing_state,
        "renderable_routing_block_consecutive_count": local_terminal_diag.get("renderable_routing_block_consecutive_count"),
        "renderable_routing_block_threshold": local_terminal_diag.get("renderable_routing_block_threshold"),
        "renderable_routing_block_captured_at": local_terminal_diag.get("renderable_routing_block_captured_at") or [],
    },
}

atomic_write_text(dashboard_json_path, json.dumps(data, indent=2) + "\n")

chart_capture = data["chart_offline_capture"]
public_chart = data["public_chart_visibility"]
local_terminal = data["local_terminal_health"]
ohlcv_contract = public_chart.get("ohlcv_contract") or {}
alignment = chart_capture.get("public_signal_alignment") or {}
thresholds = public_chart.get("thresholds") or {}
settled_full = public_chart.get("settled_full") or {}
settled_full_state = settled_full.get("state") or {}
detailed_flow = settled_full_state.get("detailedFlow") or {}
md_lines = [
    "# Healthwatch Dashboard",
    "",
    f"Generated: {data['generated_at']}",
    "",
    "## Chart Offline Capture",
    f"- State: {chart_capture['state']}",
    f"- Consecutive critical runs: {chart_capture['consecutive_critical_runs']} / {chart_capture['active_threshold']}",
    f"- Incident event count: {chart_capture['event_count']}",
    f"- Artifact policy: {chart_capture['artifact_policy']}",
    f"- Threshold reason: {chart_capture['threshold_reason']}",
    f"- Offline: {chart_capture['offline']}",
    f"- Offline reasons: {', '.join(chart_capture['offline_reasons']) if chart_capture['offline_reasons'] else 'none'}",
    f"- Advisory reasons: {', '.join(chart_capture['advisory_reasons']) if chart_capture['advisory_reasons'] else 'none'}",
    f"- Public OHLCV offline alignment: {alignment.get('ohlcv_offline_badge', False)}",
    f"- Public candles MD hard-fail count: {alignment.get('public_candles_md_alert_count', 0)}",
    "",
    "## Public Chart Visibility",
    f"- State: {public_chart['state']}",
    f"- public_chart_state: {public_chart['public_chart_state']}",
    f"- Failure domain: {public_chart['failure_domain']}",
    f"- failure_reason: {public_chart['failure_reason']}",
    f"- public_chart_freshness_state: {public_chart['freshness_state']}",
    f"- public_chart_renderability_state: {public_chart['renderability_state']}",
    f"- public_chart_visual_state: {public_chart['visual_state']}",
    f"- failure_details: {json.dumps(public_chart.get('failure_details') or {}, sort_keys=True)}",
    f"- Auth status: {public_chart['auth_status']}",
    f"- OHLCV signal: {ohlcv_contract.get('signal')}",
    f"- OHLCV renderable: {ohlcv_contract.get('renderable')}",
    f"- OHLCV rows: {ohlcv_contract.get('renderableRows')} / {ohlcv_contract.get('fetchedRows')}",
    f"- OHLCV minimum renderable bars: {ohlcv_contract.get('minimumRenderableBars')}",
    f"- OHLCV reasons: {', '.join(ohlcv_contract.get('reasons') or []) if (ohlcv_contract.get('reasons') or []) else 'none'}",
    f"- Max BARS stale threshold ms: {thresholds.get('maxBarsStaleMs')}",
    f"- Early BUS OK: {bool(((public_chart.get('early') or {}).get('busOk')))}",
    f"- Settled BUS OK: {bool(((public_chart.get('settled') or {}).get('busOk')))}",
    f"- Early MD OK: {bool(((public_chart.get('early') or {}).get('mdOk')))}",
    f"- Settled MD OK: {bool(((public_chart.get('settled') or {}).get('mdOk')))}",
    f"- Early candle pixels: {((public_chart.get('early') or {}).get('candlePixels'))}",
    f"- Settled candle pixels: {((public_chart.get('settled') or {}).get('candlePixels'))}",
    f"- FULL BARS: {((detailed_flow.get('bars') or {}).get('state'))} {((detailed_flow.get('bars') or {}).get('age'))}",
    f"- FULL DEPTH: {((detailed_flow.get('depth') or {}).get('state'))} {((detailed_flow.get('depth') or {}).get('age'))}",
    f"- FULL TRADES: {((detailed_flow.get('trades') or {}).get('state'))} {((detailed_flow.get('trades') or {}).get('age'))}",
    "",
    "## Local Terminal Health",
    f"- State: {local_terminal['state']}",
    f"- Capture freshness: {local_terminal['capture_freshness_state']} (alert state {local_terminal['stale_alert_state']})",
    f"- Latest publish age sec: {local_terminal['latest_publish_age_sec']}",
    f"- Stale threshold sec: {local_terminal['stale_after_sec']}",
    f"- Latest capture: {local_terminal['latest_capture_at']}",
    f"- Latest feed: {local_terminal['latest_feed_label']}",
    f"- Latest signal: {local_terminal['latest_signal']}",
    f"- Latest bar timestamp: {local_terminal['latest_last_bar_timestamp']}",
    f"- Latest bus status: {local_terminal['latest_bus_status']}",
    f"- Latest routing state: {local_terminal['latest_routing_state']}",
    f"- Routing alert state: {local_terminal['routing_block_alert_state']}",
    f"- Renderable but blocked: {local_terminal['renderable_routing_block_state']}",
    f"- Consecutive renderable+blocked captures: {local_terminal['renderable_routing_block_consecutive_count']} / {local_terminal['renderable_routing_block_threshold']}",
    f"- Routing reasons: {', '.join(local_terminal['latest_rejection_reasons']) if local_terminal['latest_rejection_reasons'] else 'none'}",
    f"- Smart state summary: {local_terminal['smart_state_summary']}",
    f"- Truth exchange: {local_terminal['truth_exchange_status']} ({local_terminal['truth_exchange_age_ms']}ms)",
    f"- Auto incident status: {local_terminal['auto_incident_status']}",
]

atomic_write_text(dashboard_md_path, "\n".join(md_lines) + "\n")
PY
