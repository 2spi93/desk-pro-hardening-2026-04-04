#!/usr/bin/env python3
from __future__ import annotations

import argparse
import fcntl
import importlib.util
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable
from urllib import parse, request


DEFAULT_OUT_DIR = Path("/opt/txt/var/proof_renewal")
DEFAULT_JSONL_OUTPUT = DEFAULT_OUT_DIR / "strategy_shadow_observation.jsonl"
BINGX_API_BASE_URL = "https://open-api.bingx.com"
DEFAULT_LOCK_FILE = Path("/run/lock/txt-strategy-shadow-observer.lock")
EXIT_LOCK_HELD = 3


def acquire_single_instance_lock(lock_path: Path) -> "object | None":
    """Take an exclusive non-blocking flock; return the open handle (kept for
    process lifetime) or None when another observer instance already holds it.
    The lock guards ANY launch path (systemd or manual) — one observer max."""
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    handle = open(lock_path, "a+")
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        handle.close()
        return None
    handle.seek(0)
    handle.truncate()
    handle.write(f"{os.getpid()}\n")
    handle.flush()
    return handle


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


def to_float(value: Any, default: float = 0.0) -> float:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return default
    return numeric if numeric == numeric else default


def pct_bps(new: float, old: float) -> float | None:
    if old <= 0 or new <= 0:
        return None
    return round(((new / old) - 1.0) * 10000.0, 8)


def normalize_bingx_symbol(symbol: str) -> str:
    normalized = str(symbol or "").upper().replace("-", "").replace("_", "")
    if normalized.endswith("USDT") and len(normalized) > 4:
        return f"{normalized[:-4]}-USDT"
    return str(symbol or "").upper()


def unwrap_bingx_payload(payload: Any) -> Any:
    if isinstance(payload, dict) and "data" in payload:
        data = payload.get("data")
        if isinstance(data, list) and len(data) == 1:
            return data[0]
        return data
    return payload


def fetch_bingx_executable_reference(*, symbol: str, base_url: str = BINGX_API_BASE_URL, timeout_sec: float = 8.0) -> dict[str, Any]:
    started = time.monotonic()
    bingx_symbol = normalize_bingx_symbol(symbol)
    url = f"{base_url.rstrip('/')}/openApi/swap/v2/quote/ticker?{parse.urlencode({'symbol': bingx_symbol})}"
    try:
        with request.urlopen(url, timeout=timeout_sec) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except Exception as exc:  # pragma: no cover - network availability is environment dependent
        return {
            "status": "unavailable",
            "venue": "bingx-public",
            "symbol": bingx_symbol,
            "error": exc.__class__.__name__,
            "venue_data_lag_ms": round((time.monotonic() - started) * 1000.0, 3),
        }
    item = unwrap_bingx_payload(payload)
    if not isinstance(item, dict):
        return {
            "status": "unavailable",
            "venue": "bingx-public",
            "symbol": bingx_symbol,
            "error": "payload_unparseable",
            "venue_data_lag_ms": round((time.monotonic() - started) * 1000.0, 3),
        }
    bid = to_float(item.get("bidPrice") or item.get("bid"), 0.0)
    ask = to_float(item.get("askPrice") or item.get("ask"), 0.0)
    last = to_float(item.get("lastPrice") or item.get("last"), 0.0)
    mark = to_float(item.get("markPrice"), 0.0)
    mid = (bid + ask) / 2.0 if bid > 0 and ask > 0 else 0.0
    executable = mark or mid or last
    spread_bps = pct_bps(ask, bid) if bid > 0 and ask > 0 else None
    return {
        "status": "available" if executable > 0 else "unavailable",
        "venue": "bingx-public",
        "symbol": bingx_symbol,
        "bid": bid or None,
        "ask": ask or None,
        "last": last or None,
        "mark": mark or None,
        "executable_mid_or_mark": executable or None,
        "spread_bps": spread_bps,
        "estimated_bingx_slippage_bps": round(max(1.0, (spread_bps or 2.0) / 2.0), 8) if executable > 0 else None,
        "venue_data_lag_ms": round((time.monotonic() - started) * 1000.0, 3),
    }


def refresh_clean_ohlcv_via_docker(*, container: str, venue: str, symbol: str, since_minutes: int) -> dict[str, Any]:
    since = (datetime.now(timezone.utc) - timedelta(minutes=max(1, since_minutes))).isoformat()
    result = subprocess.run(
        [
            "docker",
            "exec",
            "-i",
            container,
            "python3",
            "/workspace/scripts/backfill_market_ohlcv_clean_from_binance.py",
            "--venue",
            venue,
            "--instrument",
            symbol,
            "--timeframe-sec",
            "60",
            "--since",
            since,
            "--write-db",
            "--sleep-sec",
            "0",
        ],
        check=True,
        text=True,
        capture_output=True,
    )
    return json.loads(result.stdout)


def best_candidate(report: dict[str, Any]) -> dict[str, Any]:
    candidates = report.get("candidates") if isinstance(report.get("candidates"), list) else []
    eligible = [item for item in candidates if isinstance(item, dict) and item.get("eligible")]
    if not eligible:
        return {}
    return sorted(
        eligible,
        key=lambda item: (
            to_float(item.get("edge_lower_confidence_bound_bps")),
            to_float(item.get("net_expected_edge_bps")),
        ),
        reverse=True,
    )[0]


def load_seen_snapshot_keys(path: Path) -> set[str]:
    if not path.exists():
        return set()
    seen: set[str] = set()
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            key = str(row.get("snapshot_digest") or row.get("market_snapshot_digest") or row.get("snapshot_id") or "").strip()
            if key:
                seen.add(key)
    return seen


def append_jsonl(path: Path, row: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(row, sort_keys=True, separators=(",", ":"), default=str))
        handle.write("\n")


def build_observation_row(
    *,
    index: int,
    observed_at: datetime,
    snapshot: dict[str, Any],
    report: dict[str, Any],
    refresh_report: dict[str, Any] | None,
    venue_basis_report: dict[str, Any] | None,
) -> dict[str, Any]:
    opportunity = report.get("opportunity") if isinstance(report.get("opportunity"), dict) else {}
    selected = opportunity or best_candidate(report)
    candidates = report.get("candidates") if isinstance(report.get("candidates"), list) else []
    binance_reference = to_float(snapshot.get("latest_close"), 0.0)
    bingx_reference = to_float((venue_basis_report or {}).get("executable_mid_or_mark"), 0.0)
    venue_basis_bps = pct_bps(bingx_reference, binance_reference) if bingx_reference and binance_reference else None
    return {
        "schema_version": "txt.strategy-shadow-scan.v1",
        "index": index,
        "observed_at": observed_at.isoformat(),
        "scan_at": observed_at.isoformat(),
        "status": report.get("status"),
        "latest_bar_at": snapshot.get("latest_bar_at"),
        "market_data_lag_seconds": snapshot.get("market_data_lag_seconds"),
        "expected_interval_seconds": snapshot.get("expected_interval_seconds"),
        "missing_bar_count": snapshot.get("missing_bar_count"),
        "duplicate_bar_count": snapshot.get("duplicate_bar_count"),
        "warmup_complete": snapshot.get("warmup_complete"),
        "market_regime": report.get("market_regime"),
        "strategy_candidates": candidates,
        "decision": report.get("status"),
        "rejection_reasons": report.get("blockers") if isinstance(report.get("blockers"), list) else [],
        "blockers": report.get("blockers") if isinstance(report.get("blockers"), list) else [],
        "selected_strategy_id": report.get("selected_strategy_id"),
        "side": opportunity.get("side"),
        "gross_expected_edge_bps": selected.get("gross_expected_edge_bps"),
        "estimated_fees_bps": selected.get("estimated_fees_bps", snapshot.get("estimated_fees_bps")),
        "estimated_slippage_bps": selected.get("estimated_slippage_bps", snapshot.get("estimated_slippage_bps")),
        "estimated_funding_bps": selected.get("estimated_funding_bps", snapshot.get("estimated_funding_bps")),
        "uncertainty_buffer_bps": selected.get("uncertainty_buffer_bps", snapshot.get("uncertainty_buffer_bps")),
        "net_expected_edge_bps": selected.get("net_expected_edge_bps"),
        "edge_lower_confidence_bound_bps": selected.get("edge_lower_confidence_bound_bps"),
        "snapshot_id": snapshot.get("snapshot_id"),
        "snapshot_digest": report.get("market_snapshot_digest") or snapshot.get("snapshot_id"),
        "binance_reference_price": binance_reference or None,
        "bingx_executable_mid_or_mark": bingx_reference or None,
        "venue_basis_bps": venue_basis_bps,
        "venue_data_lag_ms": (venue_basis_report or {}).get("venue_data_lag_ms"),
        "estimated_bingx_slippage_bps": (venue_basis_report or {}).get("estimated_bingx_slippage_bps"),
        "venue_basis_status": (venue_basis_report or {}).get("status") if venue_basis_report else "not_checked",
        "refresh_inserted": refresh_report.get("inserted_total") if isinstance(refresh_report, dict) else None,
        "non_actions": ["no_broker_call", "no_order", "no_signal_consumption", "no_campaign_authorization"],
    }


def observe(
    *,
    iterations: int,
    interval_sec: float,
    snapshot_provider: Callable[[], dict[str, Any]],
    brain_builder: Callable[[dict[str, Any]], dict[str, Any]],
    pre_scan_hook: Callable[[], dict[str, Any] | None] | None = None,
    venue_basis_provider: Callable[[dict[str, Any]], dict[str, Any] | None] | None = None,
    append_jsonl_path: Path | None = None,
    seen_snapshot_keys: set[str] | None = None,
) -> dict[str, Any]:
    started_at = datetime.now(timezone.utc)
    observations: list[dict[str, Any]] = []
    duplicate_skipped_count = 0
    seen = seen_snapshot_keys if seen_snapshot_keys is not None else set()
    for index in range(iterations):
        observed_at = datetime.now(timezone.utc)
        refresh_report = pre_scan_hook() if pre_scan_hook else None
        snapshot = snapshot_provider()
        report = brain_builder(snapshot)
        venue_basis_report = venue_basis_provider(snapshot) if venue_basis_provider else None
        row = build_observation_row(
            index=index + 1,
            observed_at=observed_at,
            snapshot=snapshot,
            report=report,
            refresh_report=refresh_report,
            venue_basis_report=venue_basis_report,
        )
        key = str(row.get("snapshot_digest") or row.get("snapshot_id") or "").strip()
        if key and key in seen:
            duplicate_skipped_count += 1
        else:
            if key:
                seen.add(key)
            observations.append(row)
            if append_jsonl_path is not None:
                append_jsonl(append_jsonl_path, row)
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
        "observations_recorded": len(observations),
        "duplicates_skipped": duplicate_skipped_count,
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
        "latest_blockers": observations[-1].get("rejection_reasons") if observations else [],
        "observations": observations,
        "refresh_enabled": bool(pre_scan_hook),
        "venue_basis_enabled": bool(venue_basis_provider),
        "append_jsonl_path": str(append_jsonl_path) if append_jsonl_path is not None else None,
        "non_actions": ["no_broker_call", "no_order", "no_signal_consumption", "no_campaign_authorization"],
    }


def format_text(report: dict[str, Any]) -> str:
    return (
        f"STRATEGY_SHADOW_OBSERVATION opportunities={report.get('opportunities_detected')}/"
        f"{report.get('observations_recorded', report.get('iterations'))} "
        f"attempted={report.get('iterations')} duplicates={report.get('duplicates_skipped', 0)} "
        f"first_after_sec={report.get('first_opportunity_after_sec')} "
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
    parser.add_argument("--refresh-clean-before-scan", action="store_true")
    parser.add_argument("--refresh-since-minutes", type=int, default=360)
    parser.add_argument("--venue-basis-check", action="store_true")
    parser.add_argument("--bingx-api-base-url", default=BINGX_API_BASE_URL)
    parser.add_argument("--jsonl-output", default="")
    parser.add_argument("--no-dedupe-existing", action="store_true")
    parser.add_argument("--output", default=str(DEFAULT_OUT_DIR / "strategy_shadow_observation.json"))
    parser.add_argument("--no-write", action="store_true")
    parser.add_argument("--text", action="store_true")
    parser.add_argument("--lock-file", default=str(DEFAULT_LOCK_FILE))
    parser.add_argument("--no-lock", action="store_true", help="skip the single-instance lock (tests only)")
    args = parser.parse_args()

    if not args.no_lock:
        lock_handle = acquire_single_instance_lock(Path(args.lock_file))
        if lock_handle is None:
            print(
                f"SHADOW_OBSERVER_LOCK_HELD another observer instance holds {args.lock_file}; refusing to start",
                file=sys.stderr,
            )
            return EXIT_LOCK_HELD

    brain = load_brain_module()
    jsonl_path = Path(args.jsonl_output) if args.jsonl_output else None
    seen_snapshot_keys = load_seen_snapshot_keys(jsonl_path) if jsonl_path is not None and not args.no_dedupe_existing else set()
    report = observe(
        iterations=max(1, args.iterations),
        interval_sec=max(0.0, args.interval_sec),
        pre_scan_hook=(
            lambda: refresh_clean_ohlcv_via_docker(
                container=args.container,
                venue=args.venue,
                symbol=args.symbol,
                since_minutes=args.refresh_since_minutes,
            )
            if args.refresh_clean_before_scan
            else None
        ),
        venue_basis_provider=(
            lambda snapshot: fetch_bingx_executable_reference(
                symbol=str(snapshot.get("symbol") or args.symbol),
                base_url=args.bingx_api_base_url,
            )
            if args.venue_basis_check
            else None
        ),
        append_jsonl_path=jsonl_path,
        seen_snapshot_keys=seen_snapshot_keys,
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
