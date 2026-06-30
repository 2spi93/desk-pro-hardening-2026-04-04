#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import statistics
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

try:
    import psycopg
    from psycopg.rows import dict_row
except ImportError:  # pragma: no cover
    psycopg = None
    dict_row = None


DEFAULT_OUT_DIR = Path("/opt/txt/var/proof_renewal")
DEFAULT_DB_SECRET = Path("/opt/txt/secrets/database_url")
TIMEFRAME_TO_SEC = {"1m": 60, "5m": 300, "15m": 900, "1h": 3600}


def load_module(name: str, filename: str):
    path = Path(__file__).resolve().with_name(filename)
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"{name} unavailable")
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    parsed = datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def read_db_url(value: str | None = None) -> str:
    if value:
        return value
    env = os.environ.get("DATABASE_URL")
    if env:
        return env
    if DEFAULT_DB_SECRET.exists():
        return DEFAULT_DB_SECRET.read_text(encoding="utf-8").strip()
    raise RuntimeError("DATABASE_URL unavailable")


def fetch_rows(
    *,
    db_url: str,
    venue: str,
    symbol: str,
    timeframe: str,
    since: datetime,
    until: datetime,
    source_table: str,
) -> list[dict[str, Any]]:
    if psycopg is None or dict_row is None:
        raise RuntimeError("psycopg is required")
    if source_table == "market_ohlcv_clean":
        timeframe_sec = TIMEFRAME_TO_SEC.get(timeframe)
        if not timeframe_sec:
            raise RuntimeError(f"unsupported clean timeframe: {timeframe}")
        sql = """
            SELECT bucket_start, open, high, low, close, volume, n_trades AS trades_count, source
            FROM market_ohlcv_clean
            WHERE venue = %s
              AND instrument = %s
              AND timeframe_sec = %s
              AND bucket_start >= %s
              AND bucket_start <= %s
            ORDER BY bucket_start ASC
        """
        params = (venue, symbol.upper(), timeframe_sec, since, until)
    elif source_table == "market_ohlcv":
        sql = """
            SELECT bucket_start, open, high, low, close, volume, trades_count, source
            FROM market_ohlcv
            WHERE venue = %s
              AND instrument = %s
              AND timeframe = %s
              AND bucket_start >= %s
              AND bucket_start <= %s
            ORDER BY bucket_start ASC
        """
        params = (venue, symbol.upper(), timeframe, since, until)
    else:
        raise RuntimeError("source_table must be market_ohlcv_clean or market_ohlcv")
    with psycopg.connect(db_url) as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(sql, params)
            return [dict(row) for row in cur.fetchall()]


def percentile(values: list[float], pct: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, int(round((pct / 100.0) * (len(ordered) - 1)))))
    return round(ordered[index], 8)


def signed_return_bps(entry: float, future: float, side: str) -> float | None:
    if entry <= 0 or future <= 0:
        return None
    raw = ((future / entry) - 1.0) * 10000.0
    return round(raw if side == "buy" else -raw, 8)


def future_metrics(rows: list[dict[str, Any]], index: int, side: str, total_cost_bps: float) -> dict[str, Any]:
    entry = float(rows[index]["close"])
    out: dict[str, Any] = {}
    for minutes in (5, 15, 30):
        target = index + minutes
        value = signed_return_bps(entry, float(rows[target]["close"]), side) if target < len(rows) else None
        out[f"future_return_after_{minutes}m"] = value
    horizon = rows[index + 1 : min(len(rows), index + 31)]
    signed_path = [signed_return_bps(entry, float(row["close"]), side) for row in horizon]
    signed_path = [value for value in signed_path if value is not None]
    out["max_favorable_excursion"] = round(max(signed_path), 8) if signed_path else None
    out["max_adverse_excursion"] = round(min(signed_path), 8) if signed_path else None
    exit_return = out.get("future_return_after_15m")
    out["hypothetical_net_result_after_costs"] = round(exit_return - total_cost_bps, 8) if exit_return is not None else None
    return out


def replay(
    *,
    rows: list[dict[str, Any]],
    venue: str,
    symbol: str,
    timeframe: str,
    lookback_bars: int,
    step_bars: int,
    longest_feature_lookback: int,
    now_override: datetime | None = None,
) -> dict[str, Any]:
    snapshot_mod = load_module("txt_strategy_market_snapshot", "txt_strategy_market_snapshot.py")
    brain_mod = load_module("txt_strategy_brain_v1", "txt_strategy_brain_v1.py")
    if len(rows) <= lookback_bars + 30:
        return {
            "schema_version": "txt-strategy-shadow-replay/v1",
            "status": "INSUFFICIENT_HISTORY",
            "scans_total": 0,
            "opportunities_total": 0,
            "rows_total": len(rows),
            "non_actions": ["no_broker_call", "no_order", "no_signal_consumption", "no_threshold_change"],
        }
    scans: list[dict[str, Any]] = []
    opportunities: list[dict[str, Any]] = []
    start_index = max(lookback_bars - 1, longest_feature_lookback - 1)
    end_index = len(rows) - 31
    for index in range(start_index, end_index + 1, max(1, step_bars)):
        window = rows[index - lookback_bars + 1 : index + 1]
        simulated_now = snapshot_mod.parse_time(window[-1].get("bucket_start")) or now_override or datetime.now(timezone.utc)
        snapshot = snapshot_mod.build_snapshot(
            snapshot_mod.normalize_ohlcv_rows(window),
            symbol=symbol,
            venue=venue,
            timeframe=timeframe,
            now=simulated_now,
            longest_feature_lookback=longest_feature_lookback,
        )
        report = brain_mod.build_opportunity(snapshot, now=simulated_now)
        opportunity = report.get("opportunity") if isinstance(report.get("opportunity"), dict) else {}
        scan = {
            "scan_time": window[-1].get("bucket_start"),
            "status": report.get("status"),
            "market_regime": report.get("market_regime"),
            "selected_strategy_id": report.get("selected_strategy_id"),
            "blockers": report.get("blockers") if isinstance(report.get("blockers"), list) else [],
            "snapshot_id": snapshot.get("snapshot_id"),
        }
        scans.append(scan)
        if report.get("status") == "OPPORTUNITY" and opportunity:
            total_cost_bps = (
                float(opportunity.get("estimated_fees_bps") or 0.0)
                + float(opportunity.get("estimated_slippage_bps") or 0.0)
                + float(opportunity.get("estimated_funding_bps") or 0.0)
                + float(opportunity.get("uncertainty_buffer_bps") or 0.0)
            )
            opportunities.append(
                {
                    "opportunity_time": window[-1].get("bucket_start"),
                    "opportunity_id": opportunity.get("opportunity_id"),
                    "strategy_id": opportunity.get("strategy_id"),
                    "side": opportunity.get("side"),
                    "market_regime": opportunity.get("market_regime"),
                    "gross_expected_edge_bps": opportunity.get("gross_expected_edge_bps"),
                    "net_expected_edge_bps": opportunity.get("net_expected_edge_bps"),
                    "edge_lower_confidence_bound_bps": opportunity.get("edge_lower_confidence_bound_bps"),
                    "estimated_fee_bps": opportunity.get("estimated_fees_bps"),
                    "estimated_slippage_bps": opportunity.get("estimated_slippage_bps"),
                    **future_metrics(rows, index, str(opportunity.get("side") or ""), total_cost_bps),
                }
            )
    intervals: list[float] = []
    parsed_opportunity_times = [parse_time(str(item["opportunity_time"])) for item in opportunities]
    parsed_opportunity_times = [item for item in parsed_opportunity_times if item is not None]
    for prev, nxt in zip(parsed_opportunity_times, parsed_opportunity_times[1:]):
        intervals.append((nxt - prev).total_seconds() / 60.0)
    regime_counts = Counter(str(scan.get("market_regime") or "UNKNOWN") for scan in scans)
    rejection_reason_counts: Counter[str] = Counter()
    for scan in scans:
        if scan.get("status") != "OPPORTUNITY":
            for blocker in scan.get("blockers") or ["unknown"]:
                rejection_reason_counts[str(blocker)] += 1
    by_regime = Counter(str(item.get("market_regime") or "UNKNOWN") for item in opportunities)
    by_strategy = Counter(str(item.get("strategy_id") or "UNKNOWN") for item in opportunities)
    days = 0.0
    if rows:
        first = parse_time(str(rows[0].get("bucket_start")))
        last = parse_time(str(rows[-1].get("bucket_start")))
        if first and last:
            days = max(1 / 1440, (last - first).total_seconds() / 86400.0)
    return {
        "schema_version": "txt-strategy-shadow-replay/v1",
        "status": "OK",
        "venue": venue,
        "symbol": symbol,
        "timeframe": timeframe,
        "rows_total": len(rows),
        "scans_total": len(scans),
        "opportunities_total": len(opportunities),
        "opportunities_per_day": round(len(opportunities) / days, 6) if days else 0.0,
        "first_opportunity_after": (
            round((parsed_opportunity_times[0] - (parse_time(str(rows[0].get("bucket_start"))) or parsed_opportunity_times[0])).total_seconds() / 60.0, 6)
            if parsed_opportunity_times and rows
            else None
        ),
        "median_time_between_opportunities": round(statistics.median(intervals), 6) if intervals else None,
        "p90_time_between_opportunities": percentile(intervals, 90),
        "regime_counts": dict(regime_counts),
        "opportunities_by_regime": dict(by_regime),
        "opportunities_by_strategy": dict(by_strategy),
        "buy_count": sum(1 for item in opportunities if item.get("side") == "buy"),
        "sell_count": sum(1 for item in opportunities if item.get("side") == "sell"),
        "rejection_reason_counts": dict(rejection_reason_counts),
        "gross_edge_distribution": {
            "p50": percentile([float(item.get("gross_expected_edge_bps") or 0.0) for item in opportunities], 50),
            "p90": percentile([float(item.get("gross_expected_edge_bps") or 0.0) for item in opportunities], 90),
        },
        "net_edge_distribution": {
            "p50": percentile([float(item.get("net_expected_edge_bps") or 0.0) for item in opportunities], 50),
            "p90": percentile([float(item.get("net_expected_edge_bps") or 0.0) for item in opportunities], 90),
        },
        "lower_confidence_bound_distribution": {
            "p50": percentile([float(item.get("edge_lower_confidence_bound_bps") or 0.0) for item in opportunities], 50),
            "p90": percentile([float(item.get("edge_lower_confidence_bound_bps") or 0.0) for item in opportunities], 90),
        },
        "estimated_fee_bps": {
            "p50": percentile([float(item.get("estimated_fee_bps") or 0.0) for item in opportunities], 50),
        },
        "estimated_slippage_bps": {
            "p50": percentile([float(item.get("estimated_slippage_bps") or 0.0) for item in opportunities], 50),
        },
        "opportunities": opportunities,
        "non_actions": ["no_broker_call", "no_order", "no_signal_consumption", "no_threshold_change"],
    }


def format_text(report: dict[str, Any]) -> str:
    return (
        f"STRATEGY_SHADOW_REPLAY status={report.get('status')} scans={report.get('scans_total')} "
        f"opportunities={report.get('opportunities_total')} per_day={report.get('opportunities_per_day')} "
        f"first_after_min={report.get('first_opportunity_after')} "
        f"top_rejection={next(iter((report.get('rejection_reason_counts') or {'none': 0}).keys()))}"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Replay Strategy Brain V1 over historical OHLCV windows without future leakage.")
    parser.add_argument("--database-url")
    parser.add_argument("--venue", default="binance-public")
    parser.add_argument("--symbol", default="BTCUSDT")
    parser.add_argument("--timeframe", default="1m")
    parser.add_argument("--source-table", choices=["market_ohlcv_clean", "market_ohlcv"], default="market_ohlcv_clean")
    parser.add_argument("--since")
    parser.add_argument("--until")
    parser.add_argument("--days", type=int, default=30)
    parser.add_argument("--lookback-bars", type=int, default=240)
    parser.add_argument("--step-bars", type=int, default=5)
    parser.add_argument("--longest-feature-lookback", type=int, default=240)
    parser.add_argument("--output", default=str(DEFAULT_OUT_DIR / "strategy_shadow_replay.json"))
    parser.add_argument("--no-write", action="store_true")
    parser.add_argument("--text", action="store_true")
    args = parser.parse_args()

    until = parse_time(args.until) or datetime.now(timezone.utc)
    since = parse_time(args.since) or (until - timedelta(days=max(1, args.days)))
    rows = fetch_rows(
        db_url=read_db_url(args.database_url),
        venue=args.venue,
        symbol=args.symbol,
        timeframe=args.timeframe,
        since=since,
        until=until,
        source_table=args.source_table,
    )
    report = replay(
        rows=rows,
        venue=args.venue,
        symbol=args.symbol,
        timeframe=args.timeframe,
        lookback_bars=max(30, args.lookback_bars),
        step_bars=max(1, args.step_bars),
        longest_feature_lookback=max(30, args.longest_feature_lookback),
    )
    if not args.no_write:
        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(report, indent=2, sort_keys=True, default=str), encoding="utf-8")
        report["output_path"] = str(output)
    if args.text:
        print(format_text(report))
        if report.get("output_path"):
            print(f"replay: {report['output_path']}")
    else:
        print(json.dumps(report, ensure_ascii=True, sort_keys=True, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
