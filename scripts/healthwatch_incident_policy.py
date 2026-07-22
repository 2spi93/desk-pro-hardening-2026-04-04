#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    from .healthwatch_atomic import atomic_write_json
except ImportError:  # direct script execution
    from healthwatch_atomic import atomic_write_json


STATE_VERSION = "txt.healthwatch-incident.v1"


def parse_time(value: str | datetime) -> datetime:
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc)
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return (parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)).astimezone(timezone.utc)


def incident_signature(probe: dict[str, Any]) -> str:
    raw_reasons = probe.get("offline_reasons")
    reasons = raw_reasons if isinstance(raw_reasons, list) else ["malformed_offline_reasons"]
    raw_connectors = probe.get("connectors")
    connectors = raw_connectors if isinstance(raw_connectors, dict) else {}
    signature_input = {
        "offline_reasons": sorted(str(value) for value in reasons),
        "connector_statuses": {
            key: (value or {}).get("status")
            for key, value in sorted(connectors.items())
            if isinstance(value, dict)
        },
    }
    encoded = json.dumps(signature_input, separators=(",", ":"), sort_keys=True).encode()
    return hashlib.sha256(encoded).hexdigest()


def evaluate_incident(
    probe: dict[str, Any],
    previous: dict[str, Any] | None,
    now: datetime,
    full_capture_interval_seconds: int = 3600,
) -> tuple[dict[str, Any], dict[str, Any]]:
    now = now.astimezone(timezone.utc)
    now_text = now.isoformat().replace("+00:00", "Z")
    state = dict(previous or {})
    state.setdefault("version", STATE_VERSION)
    state.setdefault("state", "HEALTHY")
    state.setdefault("incident_sequence", 0)
    offline = bool(probe.get("offline"))

    decision = {
        "capture_full": False,
        "event": "HEALTHY_NO_CHANGE",
        "signature": None,
        "occurrences": 0,
        "evaluated_at": now_text,
        "write_daily_summary": False,
    }

    def finish() -> tuple[dict[str, Any], dict[str, Any]]:
        current_day = now.date().isoformat()
        if state.get("state") == "ACTIVE" and state.get("last_daily_summary_date") != current_day:
            state["last_daily_summary_date"] = current_day
            decision["write_daily_summary"] = True
        return state, decision

    if not offline:
        if state.get("state") == "ACTIVE":
            decision.update({
                "capture_full": True,
                "event": "RECOVERY",
                "signature": state.get("signature"),
                "occurrences": int(state.get("occurrences") or 0),
            })
            state["last_recovery_at"] = now_text
            state["last_event"] = "RECOVERY"
        state.update({"state": "HEALTHY", "last_seen": now_text})
        return finish()

    signature = incident_signature(probe)
    same_active_incident = state.get("state") == "ACTIVE" and state.get("signature") == signature
    if not same_active_incident:
        previous_active = state.get("state") == "ACTIVE"
        sequence = int(state.get("incident_sequence") or 0) + 1
        event = "SIGNATURE_CHANGE" if previous_active else "FIRST_FAILURE"
        state.update({
            "state": "ACTIVE",
            "incident_sequence": sequence,
            "signature": signature,
            "first_seen": now_text,
            "last_seen": now_text,
            "occurrences": 1,
            "last_full_capture": now_text,
            "last_event": event,
        })
        decision.update({"capture_full": True, "event": event, "signature": signature, "occurrences": 1})
        return finish()

    occurrences = int(state.get("occurrences") or 0) + 1
    state.update({"last_seen": now_text, "occurrences": occurrences})
    last_full = parse_time(str(state["last_full_capture"]))
    if (now - last_full).total_seconds() >= full_capture_interval_seconds:
        state.update({"last_full_capture": now_text, "last_event": "HOURLY_EVIDENCE"})
        decision.update({"capture_full": True, "event": "HOURLY_EVIDENCE"})
    else:
        state["last_event"] = "COUNTER_ONLY"
        decision["event"] = "COUNTER_ONLY"
    decision.update({"signature": signature, "occurrences": occurrences})
    return finish()


def main() -> int:
    parser = argparse.ArgumentParser(description="Evaluate signature-based Healthwatch incident capture policy.")
    parser.add_argument("--probe", type=Path, required=True)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--decision", type=Path, required=True)
    parser.add_argument("--now")
    parser.add_argument("--full-capture-interval-seconds", type=int, default=3600)
    parser.add_argument("--daily-summary-dir", type=Path)
    arguments = parser.parse_args()

    probe = json.loads(arguments.probe.read_text())
    try:
        previous = json.loads(arguments.state.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        previous = None
    now = parse_time(arguments.now) if arguments.now else datetime.now(timezone.utc)
    state, decision = evaluate_incident(probe, previous, now, arguments.full_capture_interval_seconds)
    atomic_write_json(arguments.state, state)
    atomic_write_json(arguments.decision, decision)
    if arguments.daily_summary_dir and decision.get("write_daily_summary"):
        daily_path = arguments.daily_summary_dir / f"{now.date().isoformat()}.json"
        atomic_write_json(daily_path, {
            "event": "DAILY_SUMMARY",
            "date": now.date().isoformat(),
            "state": state.get("state"),
            "signature": state.get("signature"),
            "first_seen": state.get("first_seen"),
            "last_seen": state.get("last_seen"),
            "occurrences": state.get("occurrences"),
            "last_full_capture": state.get("last_full_capture"),
        })
    print(json.dumps(decision, separators=(",", ":"), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
