#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_TERMINAL_CAPTURE_FILE="${LOCAL_TERMINAL_CAPTURE_FILE:-${ROOT_DIR}/logs/healthwatch/local-terminal-captures.json}"
LOCAL_TERMINAL_DIAGNOSTIC_JSON="${LOCAL_TERMINAL_DIAGNOSTIC_JSON:-${ROOT_DIR}/logs/healthwatch/local-terminal-diagnostic.json}"
LOCAL_TERMINAL_STALE_AFTER_SEC="${LOCAL_TERMINAL_STALE_AFTER_SEC:-120}"
LOCAL_TERMINAL_ROUTING_BLOCK_CONSECUTIVE_CAPTURES="${LOCAL_TERMINAL_ROUTING_BLOCK_CONSECUTIVE_CAPTURES:-3}"

mkdir -p "$(dirname "$LOCAL_TERMINAL_DIAGNOSTIC_JSON")"

python3 - "$LOCAL_TERMINAL_CAPTURE_FILE" "$LOCAL_TERMINAL_DIAGNOSTIC_JSON" "$LOCAL_TERMINAL_STALE_AFTER_SEC" "$LOCAL_TERMINAL_ROUTING_BLOCK_CONSECUTIVE_CAPTURES" <<'PY'
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
import tempfile

capture_file, output_file, stale_after_raw, routing_block_threshold_raw = sys.argv[1:5]


def parse_iso(value):
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def load_json(path):
    try:
        return json.loads(Path(path).read_text())
    except Exception:
        return None


def atomic_write_text(path, value):
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


def normalize_int(value, default):
    try:
        normalized = int(value)
        return normalized if normalized > 0 else default
    except Exception:
        return default


def capture_sort_key(capture):
    return str((capture or {}).get("capturedAt") or "")


def get_latest_capture(store):
    captures = store.get("captures") if isinstance(store, dict) else {}
    captures = captures if isinstance(captures, dict) else {}
    latest_client_id = store.get("latestClientId") if isinstance(store, dict) else None
    if isinstance(latest_client_id, str) and latest_client_id in captures and isinstance(captures[latest_client_id], dict):
        return latest_client_id, captures[latest_client_id]

    ordered = [capture for capture in captures.values() if isinstance(capture, dict)]
    ordered.sort(key=capture_sort_key, reverse=True)
    if not ordered:
        return None, None
    latest_capture = ordered[0]
    client_id = latest_capture.get("clientId") if isinstance(latest_capture.get("clientId"), str) else None
    return client_id, latest_capture


def dedupe_history(captures):
    seen = set()
    deduped = []
    for capture in captures:
        if not isinstance(capture, dict):
            continue
        capture_id = f"{capture.get('clientId') or ''}:{capture.get('capturedAt') or ''}"
        if capture_id in seen:
            continue
        seen.add(capture_id)
        deduped.append(capture)
    deduped.sort(key=capture_sort_key, reverse=True)
    return deduped


def rejection_reasons(capture):
    routing = ((capture or {}).get("runtime") or {}).get("routingDiagnostics") or {}
    reasons = routing.get("rejection_reasons")
    if not isinstance(reasons, list):
        return []
    return [str(reason) for reason in reasons if str(reason)]


def is_renderable_routing_block(capture):
    if not isinstance(capture, dict):
        return False
    local_feed = capture.get("localFeed") or {}
    runtime = capture.get("runtime") or {}
    routing = runtime.get("routingDiagnostics") or {}
    reasons = set(rejection_reasons(capture))
    return (
        local_feed.get("signal") == "OHLCV_RENDERABLE"
        and routing.get("routing_state") == "BLOCKED"
        and "BUS_OFFLINE" in reasons
        and "SEQ_ZERO" in reasons
    )


stale_after_sec = normalize_int(stale_after_raw, 120)
routing_block_threshold = normalize_int(routing_block_threshold_raw, 3)
now = datetime.now(timezone.utc)
store = load_json(capture_file)

result = {
    "generated_at": now.isoformat(),
    "source_file": capture_file,
    "available": False,
    "state": "failed",
    "capture_freshness_state": "missing",
    "renderable_routing_block_state": "missing",
    "stale_after_sec": stale_after_sec,
    "renderable_routing_block_threshold": routing_block_threshold,
    "latest_client_id": None,
    "latest_capture_at": None,
    "latest_capture_age_sec": None,
    "latest_publish_at": None,
    "latest_publish_age_sec": None,
    "capture_history_evaluated": 0,
    "renderable_routing_block_consecutive_count": 0,
    "renderable_routing_block_captured_at": [],
    "latest_capture": {
        "feed_label": None,
        "signal": None,
        "last_bar_timestamp": None,
        "bus_status": None,
        "routing_state": None,
        "rejection_reasons": [],
        "smart_state_summary": None,
        "truth_exchange_status": None,
        "truth_exchange_age_ms": None,
        "auto_incident_status": None,
    },
}

if isinstance(store, dict):
    latest_client_id, latest_capture = get_latest_capture(store)
    history_map = store.get("captureHistory") if isinstance(store.get("captureHistory"), dict) else {}
    latest_history = history_map.get(latest_client_id) if isinstance(history_map, dict) and latest_client_id else []
    ordered_history = dedupe_history([latest_capture, *(latest_history if isinstance(latest_history, list) else [])])

    published_at_raw = None
    store_updated_at = store.get("updatedAt")
    capture_published_at = latest_capture.get("capturedAt") if isinstance(latest_capture, dict) else None
    candidate_publish_times = [value for value in [store_updated_at, capture_published_at] if isinstance(value, str) and value]
    if candidate_publish_times:
        published_at_raw = max(candidate_publish_times)

    published_at = parse_iso(published_at_raw)
    capture_at = parse_iso(capture_published_at)

    result["available"] = isinstance(latest_capture, dict)
    result["latest_client_id"] = latest_client_id
    result["latest_capture_at"] = capture_published_at if isinstance(capture_published_at, str) else None
    result["latest_publish_at"] = published_at_raw
    result["capture_history_evaluated"] = len(ordered_history)

    if published_at is not None:
        publish_age_sec = max(0, int((now - published_at).total_seconds()))
        result["latest_publish_age_sec"] = publish_age_sec
        result["capture_freshness_state"] = "stale" if publish_age_sec > stale_after_sec else "healthy"
    elif isinstance(latest_capture, dict):
        result["capture_freshness_state"] = "invalid"

    if capture_at is not None:
        result["latest_capture_age_sec"] = max(0, int((now - capture_at).total_seconds()))

    if isinstance(latest_capture, dict):
        local_feed = latest_capture.get("localFeed") or {}
        runtime = latest_capture.get("runtime") or {}
        routing = runtime.get("routingDiagnostics") or {}
        truth = runtime.get("truth") or {}
        auto_incidents = store.get("autoIncidents") if isinstance(store.get("autoIncidents"), dict) else {}
        auto_incident = auto_incidents.get(latest_client_id) if isinstance(auto_incidents, dict) and latest_client_id else {}
        result["latest_capture"] = {
            "feed_label": ((latest_capture.get("chart") or {}).get("feedLabel")),
            "signal": local_feed.get("signal"),
            "last_bar_timestamp": local_feed.get("lastTimestamp"),
            "bus_status": ((runtime.get("bus") or {}).get("status")),
            "routing_state": routing.get("routing_state"),
            "rejection_reasons": rejection_reasons(latest_capture),
            "smart_state_summary": ((runtime.get("smartState") or {}).get("summary")),
            "truth_exchange_status": truth.get("exchangeStatus"),
            "truth_exchange_age_ms": truth.get("exchangeAgeMs"),
            "auto_incident_status": auto_incident.get("status") if isinstance(auto_incident, dict) else None,
        }

    consecutive_matches = []
    for capture in ordered_history:
        if not is_renderable_routing_block(capture):
            break
        consecutive_matches.append(str(capture.get("capturedAt") or ""))

    consecutive_count = len(consecutive_matches)
    result["renderable_routing_block_consecutive_count"] = consecutive_count
    result["renderable_routing_block_captured_at"] = consecutive_matches

    if isinstance(latest_capture, dict):
        if consecutive_count >= routing_block_threshold:
            result["renderable_routing_block_state"] = "blocked"
        elif consecutive_count > 0:
            result["renderable_routing_block_state"] = "tracking"
        else:
            result["renderable_routing_block_state"] = "healthy"

    if result["capture_freshness_state"] == "healthy" and result["renderable_routing_block_state"] in {"healthy", "tracking"}:
        result["state"] = "healthy" if result["renderable_routing_block_state"] == "healthy" else "degraded"
    elif result["capture_freshness_state"] == "healthy":
        result["state"] = "failed"
    elif result["capture_freshness_state"] in {"stale", "invalid"}:
        result["state"] = "failed"

atomic_write_text(output_file, json.dumps(result, indent=2) + "\n")
print(
    "local_terminal_state={state} freshness={freshness} publish_age_sec={publish_age} routing_block={routing_block} consecutive={count}/{threshold}".format(
        state=result["state"],
        freshness=result["capture_freshness_state"],
        publish_age=result["latest_publish_age_sec"] if result["latest_publish_age_sec"] is not None else "n/a",
        routing_block=result["renderable_routing_block_state"],
        count=result["renderable_routing_block_consecutive_count"],
        threshold=result["renderable_routing_block_threshold"],
    )
)
PY
