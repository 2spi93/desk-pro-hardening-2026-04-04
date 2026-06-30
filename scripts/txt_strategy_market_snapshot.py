#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    import psycopg
    from psycopg.rows import dict_row
except ImportError:  # pragma: no cover
    psycopg = None
    dict_row = None


SNAPSHOT_SCHEMA_VERSION = "txt.strategy-market-snapshot.v1"
DEFAULT_OUT_DIR = Path("/opt/txt/var/proof_renewal")
DEFAULT_MARKET_DATA_URL = "http://127.0.0.1:8003"
DEFAULT_DB_SECRET = Path("/opt/txt/secrets/database_url")
DEFAULT_TAKER_FEE_BPS = 5.0
DEFAULT_UNCERTAINTY_BUFFER_BPS = 3.0
TIMEFRAME_TO_SEC = {"30s": 30, "1m": 60, "5m": 300, "15m": 900, "1h": 3600}
DEFAULT_LONGEST_FEATURE_LOOKBACK_BARS = 240


def parse_time(value: Any) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def stable_digest(payload: Any) -> str:
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str).encode()).hexdigest()


def to_float(value: Any, default: float = 0.0) -> float:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return default
    return numeric if numeric == numeric else default


def pct_bps(new: float, old: float) -> float:
    if old <= 0:
        return 0.0
    return ((new / old) - 1.0) * 10000.0


def stdev(values: list[float]) -> float:
    if len(values) < 2:
        return 0.0
    avg = sum(values) / len(values)
    return math.sqrt(sum((value - avg) ** 2 for value in values) / (len(values) - 1))


def timeframe_seconds(timeframe: str) -> int:
    return TIMEFRAME_TO_SEC.get(timeframe, 60)


def normalize_ohlcv_rows(payload: Any) -> list[dict[str, Any]]:
    rows = payload.get("items") if isinstance(payload, dict) and isinstance(payload.get("items"), list) else payload
    if not isinstance(rows, list):
        return []
    normalized: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        close = to_float(row.get("close", row.get("c")), 0.0)
        if close <= 0:
            continue
        open_price = to_float(row.get("open", row.get("o")), close)
        high = to_float(row.get("high", row.get("h")), max(open_price, close))
        low = to_float(row.get("low", row.get("l")), min(open_price, close))
        volume = to_float(row.get("volume", row.get("v")), 0.0)
        normalized.append(
            {
                "bucket_start": str(row.get("bucket_start") or row.get("t") or ""),
                "open": open_price,
                "high": high,
                "low": low,
                "close": close,
                "volume": max(0.0, volume),
                "trades_count": int(to_float(row.get("trades_count"), 0.0)),
                "source": str(row.get("source") or ""),
            }
        )
    normalized.sort(key=lambda item: item.get("bucket_start") or "")
    return normalized


def fetch_ohlcv(*, base_url: str, venue: str, symbol: str, timeframe: str, limit: int) -> list[dict[str, Any]]:
    query = urllib.parse.urlencode({"venue": venue, "instrument": symbol, "timeframe": timeframe, "limit": limit})
    url = f"{base_url.rstrip('/')}/v1/market/ohlcv?{query}"
    with urllib.request.urlopen(url, timeout=10) as response:
        payload = json.loads(response.read().decode("utf-8"))
    return normalize_ohlcv_rows(payload)


def read_db_url(value: str | None = None) -> str:
    if value:
        return value
    env = os.environ.get("DATABASE_URL")
    if env:
        return env
    if DEFAULT_DB_SECRET.exists():
        return DEFAULT_DB_SECRET.read_text(encoding="utf-8").strip()
    raise RuntimeError("DATABASE_URL unavailable")


def fetch_ohlcv_from_db(*, db_url: str, venue: str, symbol: str, timeframe: str, limit: int, source_table: str) -> list[dict[str, Any]]:
    if psycopg is None or dict_row is None:
        raise RuntimeError("psycopg is required for --source db")
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
            ORDER BY bucket_start DESC
            LIMIT %s
        """
        params = (venue, symbol.upper(), timeframe_sec, limit)
    elif source_table == "market_ohlcv":
        sql = """
            SELECT bucket_start, open, high, low, close, volume, trades_count, source
            FROM market_ohlcv
            WHERE venue = %s
              AND instrument = %s
              AND timeframe = %s
            ORDER BY bucket_start DESC
            LIMIT %s
        """
        params = (venue, symbol.upper(), timeframe, limit)
    else:
        raise RuntimeError("source_table must be market_ohlcv_clean or market_ohlcv")
    with psycopg.connect(db_url) as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(sql, params)
            rows = [dict(row) for row in cur.fetchall()]
    return normalize_ohlcv_rows(list(reversed(rows)))


def build_snapshot(
    rows: list[dict[str, Any]],
    *,
    symbol: str = "BTCUSDT",
    venue: str = "binance-public",
    timeframe: str = "1m",
    now: datetime | None = None,
    entry_fee_bps: float = DEFAULT_TAKER_FEE_BPS,
    exit_fee_bps: float = DEFAULT_TAKER_FEE_BPS,
    uncertainty_buffer_bps: float = DEFAULT_UNCERTAINTY_BUFFER_BPS,
    funding_bps: float = 0.0,
    longest_feature_lookback: int = DEFAULT_LONGEST_FEATURE_LOOKBACK_BARS,
) -> dict[str, Any]:
    current = now or datetime.now(timezone.utc)
    valid_rows = [row for row in rows if to_float(row.get("close")) > 0]
    closes = [float(row["close"]) for row in valid_rows]
    volumes = [float(row.get("volume") or 0.0) for row in valid_rows]
    rets = [abs(pct_bps(closes[index], closes[index - 1])) for index in range(1, len(closes))]
    ranges = [
        abs(pct_bps(to_float(row.get("high"), to_float(row.get("close"))), to_float(row.get("low"), to_float(row.get("close")))))
        for row in rows
        if to_float(row.get("high")) > 0 and to_float(row.get("low")) > 0
    ]
    realized_vol_bps = stdev(rets[-60:])
    median_range_bps = sorted(ranges[-30:])[len(ranges[-30:]) // 2] if ranges[-30:] else 0.0
    estimated_slippage_bps = round(max(1.0, min(8.0, realized_vol_bps * 0.18 + median_range_bps * 0.08)), 6)
    spread_bps = round(max(0.5, min(4.0, median_range_bps * 0.05 if median_range_bps else 1.0)), 6)
    latest_bucket = valid_rows[-1].get("bucket_start") if valid_rows else None
    latest_at = parse_time(latest_bucket)
    freshness_sec = max(0.0, (current - latest_at).total_seconds()) if latest_at else None
    expected_interval_seconds = timeframe_seconds(timeframe)
    parsed_times = [parse_time(row.get("bucket_start")) for row in valid_rows]
    parsed_times = [item for item in parsed_times if item is not None]
    duplicate_bar_count = len(parsed_times) - len(set(parsed_times))
    missing_bar_count = 0
    if len(parsed_times) >= 2:
        expected_steps = int((max(parsed_times) - min(parsed_times)).total_seconds() // expected_interval_seconds) + 1
        missing_bar_count = max(0, expected_steps - len(set(parsed_times)))
    market_data_lag_seconds = freshness_sec
    warmup_complete = (
        len(closes) >= longest_feature_lookback
        and duplicate_bar_count == 0
        and missing_bar_count == 0
        and (market_data_lag_seconds is None or market_data_lag_seconds <= expected_interval_seconds * 3)
    )
    snapshot_core = {
        "symbol": symbol.upper(),
        "venue": venue,
        "timeframe": timeframe,
        "bar_count": len(closes),
        "latest_bucket_start": latest_bucket,
        "latest_bar_at": latest_bucket,
        "latest_close": closes[-1] if closes else None,
        "realized_vol_bps": round(realized_vol_bps, 6),
        "median_range_bps": round(median_range_bps, 6),
    }
    return {
        "schema_version": SNAPSHOT_SCHEMA_VERSION,
        "snapshot_id": f"mkt-{stable_digest(snapshot_core)[:16]}",
        "generated_at": current.isoformat(),
        **snapshot_core,
        "freshness_sec": freshness_sec,
        "market_data_lag_seconds": market_data_lag_seconds,
        "expected_interval_seconds": expected_interval_seconds,
        "missing_bar_count": missing_bar_count,
        "duplicate_bar_count": duplicate_bar_count,
        "longest_feature_lookback": longest_feature_lookback,
        "warmup_complete": warmup_complete,
        "closes": closes,
        "volumes": volumes,
        "spread_bps": spread_bps,
        "estimated_entry_fee_bps": entry_fee_bps,
        "estimated_exit_fee_bps": exit_fee_bps,
        "estimated_fees_bps": round(entry_fee_bps + exit_fee_bps, 8),
        "estimated_slippage_bps": estimated_slippage_bps,
        "estimated_funding_bps": abs(funding_bps),
        "uncertainty_buffer_bps": uncertainty_buffer_bps,
        "source": "txt_strategy_market_snapshot",
        "source_digest": stable_digest(rows),
        "evidence_refs": [f"ohlcv:{venue}:{symbol.upper()}:{timeframe}:{len(closes)}"],
    }


def format_text(snapshot: dict[str, Any]) -> str:
    return (
        f"STRATEGY_MARKET_SNAPSHOT snapshot_id={snapshot.get('snapshot_id')} "
        f"symbol={snapshot.get('symbol')} venue={snapshot.get('venue')} timeframe={snapshot.get('timeframe')} "
        f"bars={snapshot.get('bar_count')} close={snapshot.get('latest_close')} "
        f"slippage_bps={snapshot.get('estimated_slippage_bps')} fees_bps={snapshot.get('estimated_fees_bps')}"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Build a canonical txt.strategy-market-snapshot.v1 for shadow strategy evaluation.")
    parser.add_argument("--source", choices=["db", "http", "json"], default="db")
    parser.add_argument("--input-json", help="Existing OHLCV JSON array/envelope. If omitted, fetches from market-data.")
    parser.add_argument("--market-data-url", default=DEFAULT_MARKET_DATA_URL)
    parser.add_argument("--database-url")
    parser.add_argument("--source-table", choices=["market_ohlcv_clean", "market_ohlcv"], default="market_ohlcv_clean")
    parser.add_argument("--symbol", default="BTCUSDT")
    parser.add_argument("--venue", default="binance-public")
    parser.add_argument("--timeframe", default="1m")
    parser.add_argument("--limit", type=int, default=240)
    parser.add_argument("--entry-fee-bps", type=float, default=DEFAULT_TAKER_FEE_BPS)
    parser.add_argument("--exit-fee-bps", type=float, default=DEFAULT_TAKER_FEE_BPS)
    parser.add_argument("--funding-bps", type=float, default=0.0)
    parser.add_argument("--uncertainty-buffer-bps", type=float, default=DEFAULT_UNCERTAINTY_BUFFER_BPS)
    parser.add_argument("--longest-feature-lookback", type=int, default=DEFAULT_LONGEST_FEATURE_LOOKBACK_BARS)
    parser.add_argument("--output", default=str(DEFAULT_OUT_DIR / "strategy_market_snapshot.json"))
    parser.add_argument("--no-write", action="store_true")
    parser.add_argument("--text", action="store_true")
    args = parser.parse_args()

    if args.source == "json" or args.input_json:
        if not args.input_json:
            raise SystemExit("ERROR: --input-json is required for --source json")
        rows = normalize_ohlcv_rows(json.loads(Path(args.input_json).read_text(encoding="utf-8")))
    elif args.source == "db":
        rows = fetch_ohlcv_from_db(
            db_url=read_db_url(args.database_url),
            venue=args.venue,
            symbol=args.symbol,
            timeframe=args.timeframe,
            limit=args.limit,
            source_table=args.source_table,
        )
    else:
        rows = fetch_ohlcv(base_url=args.market_data_url, venue=args.venue, symbol=args.symbol, timeframe=args.timeframe, limit=args.limit)
    snapshot = build_snapshot(
        rows,
        symbol=args.symbol,
        venue=args.venue,
        timeframe=args.timeframe,
        entry_fee_bps=args.entry_fee_bps,
        exit_fee_bps=args.exit_fee_bps,
        uncertainty_buffer_bps=args.uncertainty_buffer_bps,
        funding_bps=args.funding_bps,
        longest_feature_lookback=max(30, args.longest_feature_lookback),
    )
    if not args.no_write:
        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(snapshot, indent=2, sort_keys=True, default=str), encoding="utf-8")
        snapshot["output_path"] = str(output)
    if args.text:
        print(format_text(snapshot))
        if snapshot.get("output_path"):
            print(f"snapshot: {snapshot['output_path']}")
    else:
        print(json.dumps(snapshot, ensure_ascii=True, sort_keys=True, default=str))
    return 0 if snapshot.get("bar_count", 0) >= 30 else 2


if __name__ == "__main__":
    raise SystemExit(main())
