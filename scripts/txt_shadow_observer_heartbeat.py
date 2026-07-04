#!/usr/bin/env python3
"""Heartbeat check for the permanent shadow observer (watch the watcher).

Runs every 2 minutes from txt-shadow-observer-heartbeat.timer. Read-only on
trading: it only inspects the service, the current run's JSONL and market-bar
freshness, writes shadow_observer_heartbeat.json, and — in exactly one case —
restarts the observer service: process alive but no scan for > 3x cadence.

States:
  ok                      service active, 1 instance, fresh scan, fresh bars
  observer_down           service/process not running (systemd Restart=always
                          owns recovery; we only record + alert)
  stale_scans_restarted   alive but silent > 3x cadence -> controlled restart
  degraded_market_data    scans continue but market bars are stale -> shadow
                          degraded, NO restart, no fake episodes possible
  multiple_instances      >1 observer process (flock should prevent this) ->
                          controlled restart (wrapper kills strays)
Never places orders, never touches broker/campaign state.
"""
from __future__ import annotations

import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

OUT_DIR = Path("/opt/txt/var/proof_renewal")
CURRENT_JSONL = OUT_DIR / "strategy_shadow_observation_current.jsonl"
CURRENT_RUN_ID = OUT_DIR / "strategy_shadow_observation_current.run_id"
HEARTBEAT = OUT_DIR / "shadow_observer_heartbeat.json"
SERVICE = "txt-strategy-shadow-observer.service"
CADENCE_SEC = 60.0
STALE_SCAN_SEC = 3 * CADENCE_SEC
STALE_MARKET_BAR_SEC = 300.0
STARTUP_GRACE_SEC = 180.0


def _run(cmd: list[str]) -> str:
    return subprocess.run(cmd, capture_output=True, text=True, check=False).stdout.strip()


def _parse_ts(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def _last_scan_row(path: Path) -> dict | None:
    try:
        with path.open("rb") as handle:
            handle.seek(0, 2)
            size = handle.tell()
            handle.seek(max(0, size - 65536))
            lines = handle.read().decode("utf-8", errors="replace").strip().splitlines()
        for line in reversed(lines):
            try:
                row = json.loads(line)
                if isinstance(row, dict):
                    return row
            except json.JSONDecodeError:
                continue
    except OSError:
        return None
    return None


def _service_active_seconds(now: datetime) -> float | None:
    raw = _run(["systemctl", "show", SERVICE, "--property=ActiveEnterTimestamp", "--value"])
    if not raw or raw in {"", "n/a"}:
        return None
    try:
        entered = datetime.strptime(raw, "%a %Y-%m-%d %H:%M:%S %Z").replace(tzinfo=timezone.utc)
    except ValueError:
        return None
    return (now - entered).total_seconds()


def main() -> int:
    now = datetime.now(timezone.utc)
    service_state = _run(["systemctl", "is-active", SERVICE]) or "unknown"
    pids = [p for p in _run(["pgrep", "-f", r"scripts/txt_strategy_shadow_observer\.py"]).splitlines() if p]
    run_id = CURRENT_RUN_ID.read_text(encoding="utf-8").strip() if CURRENT_RUN_ID.exists() else None

    row = _last_scan_row(CURRENT_JSONL) if CURRENT_JSONL.exists() else None
    last_scan_at = _parse_ts(row.get("scan_at")) if row else None
    last_bar_at = _parse_ts(str(row.get("latest_bar_at"))) if row else None
    scan_age = (now - last_scan_at).total_seconds() if last_scan_at else None
    bar_age = (now - last_bar_at).total_seconds() if last_bar_at else None
    active_secs = _service_active_seconds(now)
    in_grace = active_secs is not None and active_secs < STARTUP_GRACE_SEC

    action = "none"
    if service_state != "active" or not pids:
        status = "observer_down"
    elif len(pids) > 1:
        status = "multiple_instances"
        action = "restart"
    elif scan_age is None or scan_age > STALE_SCAN_SEC:
        if in_grace:
            status = "ok_startup_grace"
        else:
            status = "stale_scans_restarted"
            action = "restart"
    elif bar_age is not None and bar_age > STALE_MARKET_BAR_SEC:
        status = "degraded_market_data"
    else:
        status = "ok"

    if action == "restart":
        subprocess.run(["systemctl", "restart", SERVICE], check=False)

    heartbeat = {
        "schema_version": "txt-shadow-observer-heartbeat/v1",
        "checked_at": now.isoformat(),
        "status": status,
        "action": action,
        "service": SERVICE,
        "service_state": service_state,
        "service_active_seconds": active_secs,
        "service_pid": int(pids[0]) if pids else None,
        "instance_count": len(pids),
        "run_id": run_id,
        "last_scan_at": last_scan_at.isoformat() if last_scan_at else None,
        "last_market_bar_at": last_bar_at.isoformat() if last_bar_at else None,
        "scan_age_seconds": round(scan_age, 3) if scan_age is not None else None,
        "market_bar_age_seconds": round(bar_age, 3) if bar_age is not None else None,
        "thresholds": {
            "cadence_sec": CADENCE_SEC,
            "stale_scan_sec": STALE_SCAN_SEC,
            "stale_market_bar_sec": STALE_MARKET_BAR_SEC,
        },
        "non_actions": [
            "no_broker_call",
            "no_order",
            "no_signal_consumption",
            "no_campaign_authorization",
            "no_live_execution",
        ],
    }
    HEARTBEAT.write_text(json.dumps(heartbeat, indent=2, sort_keys=True), encoding="utf-8")
    print(
        f"SHADOW_OBSERVER_HEARTBEAT status={status} action={action} run_id={run_id} "
        f"instances={len(pids)} scan_age={heartbeat['scan_age_seconds']} bar_age={heartbeat['market_bar_age_seconds']}"
    )
    return 0 if status in {"ok", "ok_startup_grace"} else 1


if __name__ == "__main__":
    sys.exit(main())
