#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

try:
    from .healthwatch_atomic import atomic_write_json
except ImportError:  # direct script execution
    from healthwatch_atomic import atomic_write_json


TRANSITION_EVENTS = {"FIRST_FAILURE", "SIGNATURE_CHANGE", "RECOVERY"}


@dataclass(frozen=True)
class RetentionPolicy:
    raw_days: int = 7
    transition_days: int = 90


def parse_time(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return (parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)).astimezone(timezone.utc)


def retention_action(captured_at: datetime, event: str, now: datetime, policy: RetentionPolicy) -> str:
    age = now - captured_at
    if age <= timedelta(days=policy.raw_days):
        return "KEEP_RAW"
    if event in TRANSITION_EVENTS and age <= timedelta(days=policy.transition_days):
        return "COMPRESS_TRANSITION"
    if event == "DAILY_SUMMARY" and age <= timedelta(days=policy.transition_days):
        return "KEEP_DAILY_SUMMARY"
    return "DELETE_CANDIDATE"


def build_plan(records: list[dict[str, Any]], now: datetime, policy: RetentionPolicy) -> dict[str, Any]:
    actions = []
    counts: dict[str, int] = {}
    for record in records:
        captured_at = parse_time(str(record["captured_at"]))
        event = str(record.get("event") or "HOURLY_EVIDENCE")
        action = retention_action(captured_at, event, now, policy)
        counts[action] = counts.get(action, 0) + 1
        actions.append({**record, "action": action})
    return {
        "version": "txt.healthwatch-retention.v1",
        "generated_at": now.isoformat().replace("+00:00", "Z"),
        "policy": {
            "raw_full_diagnostics_days": policy.raw_days,
            "incident_transitions_days": policy.transition_days,
            "identical_active_incident_full_capture_seconds": 3600,
            "long_term_summary": "one-per-day",
            "latest_state": "always",
        },
        "counts": counts,
        "actions": actions,
        "deletion_executed": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Create a fail-closed Healthwatch retention plan; never deletes files.")
    parser.add_argument("--inventory", type=Path, required=True, help="JSON array of capture records")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--now")
    arguments = parser.parse_args()
    now = parse_time(arguments.now) if arguments.now else datetime.now(timezone.utc)
    records = json.loads(arguments.inventory.read_text())
    plan = build_plan(records, now, RetentionPolicy())
    atomic_write_json(arguments.output, plan)
    print(json.dumps(plan["counts"], sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
