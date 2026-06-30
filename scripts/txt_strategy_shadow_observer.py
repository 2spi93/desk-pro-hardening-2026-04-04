#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable


DEFAULT_OUT_DIR = Path("/opt/txt/var/proof_renewal")


def load_brain_module():
    path = Path(__file__).resolve().with_name("txt_strategy_brain_v1.py")
    spec = importlib.util.spec_from_file_location("txt_strategy_brain_v1", path)
    module = importlib.util.module_from_spec(spec)
    if spec is None or spec.loader is None:
        raise RuntimeError("strategy brain module unavailable")
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def fetch_snapshot_via_docker(*, container: str, venue: str, symbol: str, timeframe: str, limit: int) -> dict[str, Any]:
    result = subprocess.run(
        [
            "docker",
            "exec",
            "-i",
            container,
            "python3",
            "/workspace/scripts/txt_strategy_market_snapshot.py",
            "--source",
            "db",
            "--source-table",
            "market_ohlcv_clean",
            "--venue",
            venue,
            "--symbol",
            symbol,
            "--timeframe",
            timeframe,
            "--limit",
            str(limit),
            "--no-write",
        ],
        check=True,
        text=True,
        capture_output=True,
    )
    return json.loads(result.stdout)


def observe(
    *,
    iterations: int,
    interval_sec: float,
    snapshot_provider: Callable[[], dict[str, Any]],
    brain_builder: Callable[[dict[str, Any]], dict[str, Any]],
) -> dict[str, Any]:
    started_at = datetime.now(timezone.utc)
    observations: list[dict[str, Any]] = []
    for index in range(iterations):
        observed_at = datetime.now(timezone.utc)
        snapshot = snapshot_provider()
        report = brain_builder(snapshot)
        opportunity = report.get("opportunity") if isinstance(report.get("opportunity"), dict) else {}
        observations.append(
            {
                "index": index + 1,
                "observed_at": observed_at.isoformat(),
                "status": report.get("status"),
                "market_regime": report.get("market_regime"),
                "selected_strategy_id": report.get("selected_strategy_id"),
                "side": opportunity.get("side"),
                "edge_lower_confidence_bound_bps": opportunity.get("edge_lower_confidence_bound_bps"),
                "blockers": report.get("blockers") if isinstance(report.get("blockers"), list) else [],
                "snapshot_id": snapshot.get("snapshot_id"),
            }
        )
        if index < iterations - 1 and interval_sec > 0:
            time.sleep(interval_sec)
    opportunities = [row for row in observations if row.get("status") == "OPPORTUNITY"]
    first = opportunities[0] if opportunities else None
    ended_at = datetime.now(timezone.utc)
    elapsed_sec = max(0.0, (ended_at - started_at).total_seconds())
    return {
        "schema_version": "txt-strategy-shadow-observation/v1",
        "started_at": started_at.isoformat(),
        "ended_at": ended_at.isoformat(),
        "elapsed_sec": round(elapsed_sec, 3),
        "iterations": iterations,
        "interval_sec": interval_sec,
        "opportunities_detected": len(opportunities),
        "no_opportunity_count": len(observations) - len(opportunities),
        "first_opportunity_after_sec": (
            round((datetime.fromisoformat(str(first["observed_at"])) - started_at).total_seconds(), 3)
            if first
            else None
        ),
        "latest_status": observations[-1].get("status") if observations else None,
        "latest_regime": observations[-1].get("market_regime") if observations else None,
        "latest_blockers": observations[-1].get("blockers") if observations else [],
        "observations": observations,
        "non_actions": ["no_broker_call", "no_order", "no_signal_consumption", "no_campaign_authorization"],
    }


def format_text(report: dict[str, Any]) -> str:
    return (
        f"STRATEGY_SHADOW_OBSERVATION opportunities={report.get('opportunities_detected')}/"
        f"{report.get('iterations')} first_after_sec={report.get('first_opportunity_after_sec')} "
        f"latest_status={report.get('latest_status')} latest_regime={report.get('latest_regime')} "
        f"latest_blockers={','.join(report.get('latest_blockers') or []) or 'none'}"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Observe Strategy Brain V1 in shadow mode over repeated canonical snapshots.")
    parser.add_argument("--iterations", type=int, default=1)
    parser.add_argument("--interval-sec", type=float, default=0.0)
    parser.add_argument("--container", default="control-plane")
    parser.add_argument("--venue", default="binance-public")
    parser.add_argument("--symbol", default="BTCUSDT")
    parser.add_argument("--timeframe", default="1m")
    parser.add_argument("--limit", type=int, default=240)
    parser.add_argument("--output", default=str(DEFAULT_OUT_DIR / "strategy_shadow_observation.json"))
    parser.add_argument("--no-write", action="store_true")
    parser.add_argument("--text", action="store_true")
    args = parser.parse_args()

    brain = load_brain_module()
    report = observe(
        iterations=max(1, args.iterations),
        interval_sec=max(0.0, args.interval_sec),
        snapshot_provider=lambda: fetch_snapshot_via_docker(
            container=args.container,
            venue=args.venue,
            symbol=args.symbol,
            timeframe=args.timeframe,
            limit=args.limit,
        ),
        brain_builder=lambda snapshot: brain.build_opportunity(snapshot),
    )
    if not args.no_write:
        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(report, indent=2, sort_keys=True, default=str), encoding="utf-8")
        report["output_path"] = str(output)
    if args.text:
        print(format_text(report))
        if report.get("output_path"):
            print(f"observation: {report['output_path']}")
    else:
        print(json.dumps(report, ensure_ascii=True, sort_keys=True, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
