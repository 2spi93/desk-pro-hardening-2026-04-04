#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

try:
    import psycopg
    from psycopg.rows import dict_row
except ImportError:  # pragma: no cover
    psycopg = None
    dict_row = None


DEFAULT_DB_SECRET = Path("/opt/txt/secrets/database_url")
BINANCE_API_BASE = "https://api.binance.com"
TIMEFRAME_TO_BINANCE = {60: "1m", 300: "5m", 900: "15m", 3600: "1h"}
SOURCE = "binance_klines_backfill"

CREATE_CLEAN_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS market_ohlcv_clean (
    venue          TEXT NOT NULL,
    instrument     TEXT NOT NULL,
    timeframe_sec  INTEGER NOT NULL,
    bucket_start   TIMESTAMPTZ NOT NULL,
    open           DOUBLE PRECISION NOT NULL,
    high           DOUBLE PRECISION NOT NULL,
    low            DOUBLE PRECISION NOT NULL,
    close          DOUBLE PRECISION NOT NULL,
    volume         DOUBLE PRECISION NOT NULL,
    quote_volume   DOUBLE PRECISION NOT NULL,
    n_trades       INTEGER NOT NULL,
    vwap           DOUBLE PRECISION NOT NULL,
    source         TEXT NOT NULL DEFAULT 'rebuilt_from_trades',
    rebuilt_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (venue, instrument, timeframe_sec, bucket_start)
);
"""

INSERT_MISSING_SQL = """
INSERT INTO market_ohlcv_clean
    (venue, instrument, timeframe_sec, bucket_start, open, high, low, close,
     volume, quote_volume, n_trades, vwap, source)
VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
ON CONFLICT (venue, instrument, timeframe_sec, bucket_start) DO NOTHING
"""


def parse_time(value: str | None) -> datetime:
    if not value:
        raise ValueError("timestamp required")
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


def floor_time(dt: datetime, timeframe_sec: int) -> datetime:
    epoch = int(dt.timestamp())
    return datetime.fromtimestamp(epoch - (epoch % timeframe_sec), tz=timezone.utc)


def ms(dt: datetime) -> int:
    return int(dt.timestamp() * 1000)


def parse_kline(row: list[Any]) -> dict[str, Any]:
    open_time = datetime.fromtimestamp(int(row[0]) / 1000, tz=timezone.utc)
    open_price = float(row[1])
    high = float(row[2])
    low = float(row[3])
    close = float(row[4])
    volume = float(row[5])
    quote_volume = float(row[7])
    n_trades = int(row[8])
    vwap = quote_volume / volume if volume > 0 else close
    return {
        "bucket_start": open_time,
        "open": open_price,
        "high": high,
        "low": low,
        "close": close,
        "volume": volume,
        "quote_volume": quote_volume,
        "n_trades": n_trades,
        "vwap": vwap,
    }


def fetch_binance_klines(
    *,
    symbol: str,
    interval: str,
    start: datetime,
    end: datetime,
    limit: int = 1000,
    api_base: str = BINANCE_API_BASE,
) -> list[dict[str, Any]]:
    query = urllib.parse.urlencode(
        {
            "symbol": symbol.upper(),
            "interval": interval,
            "startTime": ms(start),
            "endTime": ms(end),
            "limit": max(1, min(1000, limit)),
        }
    )
    url = f"{api_base.rstrip('/')}/api/v3/klines?{query}"
    payload = json.loads(urllib.request.urlopen(url, timeout=12).read().decode("utf-8"))
    if not isinstance(payload, list):
        raise RuntimeError("unexpected Binance kline response")
    return [parse_kline(row) for row in payload if isinstance(row, list) and len(row) >= 9]


def existing_bucket_set(
    conn,
    *,
    venue: str,
    instrument: str,
    timeframe_sec: int,
    since: datetime,
    until: datetime,
) -> set[datetime]:
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(
            """
            SELECT bucket_start
            FROM market_ohlcv_clean
            WHERE venue = %s
              AND instrument = %s
              AND timeframe_sec = %s
              AND bucket_start >= %s
              AND bucket_start <= %s
            """,
            (venue, instrument, timeframe_sec, since, until),
        )
        return {row["bucket_start"].astimezone(timezone.utc) for row in cur.fetchall()}


def insert_missing(
    conn,
    *,
    venue: str,
    instrument: str,
    timeframe_sec: int,
    candles: list[dict[str, Any]],
) -> int:
    if not candles:
        return 0
    rows = [
        (
            venue,
            instrument,
            timeframe_sec,
            candle["bucket_start"],
            candle["open"],
            candle["high"],
            candle["low"],
            candle["close"],
            candle["volume"],
            candle["quote_volume"],
            candle["n_trades"],
            candle["vwap"],
            SOURCE,
        )
        for candle in candles
    ]
    with conn.cursor() as cur:
        cur.executemany(INSERT_MISSING_SQL, rows)
        return cur.rowcount if cur.rowcount is not None else 0


def backfill(
    *,
    db_url: str,
    venue: str,
    instrument: str,
    timeframe_sec: int,
    since: datetime,
    until: datetime,
    write_db: bool,
    sleep_sec: float = 0.05,
) -> dict[str, Any]:
    if psycopg is None or dict_row is None:
        raise RuntimeError("psycopg is required")
    interval = TIMEFRAME_TO_BINANCE.get(timeframe_sec)
    if not interval:
        raise RuntimeError(f"unsupported timeframe_sec {timeframe_sec}")
    since = floor_time(since, timeframe_sec)
    until = floor_time(until, timeframe_sec)
    expected_total = max(0, int((until - since).total_seconds() // timeframe_sec) + 1)
    fetched_total = 0
    inserted_total = 0
    missing_total = 0
    batches = 0
    with psycopg.connect(db_url) as conn:
        with conn.cursor() as cur:
            cur.execute(CREATE_CLEAN_TABLE_SQL)
        existing = existing_bucket_set(
            conn,
            venue=venue,
            instrument=instrument,
            timeframe_sec=timeframe_sec,
            since=since,
            until=until,
        )
        missing_total = max(0, expected_total - len(existing))
        cursor = since
        while cursor <= until:
            batch_end = min(until, cursor + timedelta(seconds=timeframe_sec * 999))
            candles = fetch_binance_klines(
                symbol=instrument,
                interval=interval,
                start=cursor,
                end=batch_end + timedelta(seconds=timeframe_sec - 1),
            )
            fetched_total += len(candles)
            missing = [
                candle
                for candle in candles
                if since <= candle["bucket_start"] <= until and candle["bucket_start"] not in existing
            ]
            if write_db and missing:
                inserted_total += insert_missing(
                    conn,
                    venue=venue,
                    instrument=instrument,
                    timeframe_sec=timeframe_sec,
                    candles=missing,
                )
                conn.commit()
                existing.update(candle["bucket_start"] for candle in missing)
            batches += 1
            if not candles:
                cursor = batch_end + timedelta(seconds=timeframe_sec)
            else:
                cursor = candles[-1]["bucket_start"] + timedelta(seconds=timeframe_sec)
            if sleep_sec > 0 and cursor <= until:
                time.sleep(sleep_sec)
    return {
        "schema_version": "txt-market-ohlcv-clean-binance-backfill/v1",
        "venue": venue,
        "instrument": instrument,
        "timeframe_sec": timeframe_sec,
        "since": since.isoformat(),
        "until": until.isoformat(),
        "expected_total": expected_total,
        "existing_before": expected_total - missing_total,
        "missing_before": missing_total,
        "fetched_total": fetched_total,
        "inserted_total": inserted_total,
        "batches": batches,
        "write_db": write_db,
        "source": SOURCE,
        "non_actions": ["no_broker_call", "no_order", "no_strategy_threshold_change"],
    }


def format_text(report: dict[str, Any]) -> str:
    return (
        f"OHLCV_CLEAN_BACKFILL write_db={report.get('write_db')} expected={report.get('expected_total')} "
        f"missing_before={report.get('missing_before')} fetched={report.get('fetched_total')} "
        f"inserted={report.get('inserted_total')} source={report.get('source')}"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Backfill missing market_ohlcv_clean rows from public Binance klines.")
    parser.add_argument("--database-url")
    parser.add_argument("--venue", default="binance-public")
    parser.add_argument("--instrument", default="BTCUSDT")
    parser.add_argument("--timeframe-sec", type=int, default=60)
    parser.add_argument("--since", required=True)
    parser.add_argument("--until")
    parser.add_argument("--write-db", action="store_true")
    parser.add_argument("--sleep-sec", type=float, default=0.05)
    parser.add_argument("--text", action="store_true")
    args = parser.parse_args()

    until = parse_time(args.until) if args.until else datetime.now(timezone.utc)
    report = backfill(
        db_url=read_db_url(args.database_url),
        venue=args.venue,
        instrument=args.instrument.upper(),
        timeframe_sec=args.timeframe_sec,
        since=parse_time(args.since),
        until=until,
        write_db=bool(args.write_db),
        sleep_sec=max(0.0, args.sleep_sec),
    )
    if args.text:
        print(format_text(report))
    else:
        print(json.dumps(report, ensure_ascii=True, sort_keys=True, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
