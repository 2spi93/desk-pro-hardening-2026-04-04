from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import threading
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import httpx
import websockets
from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect

from shared.db import ensure_schema, execute, execute_rowcount, fetch_all, fetch_one, json_dumps


def _secret_env(name: str, default: str = "") -> str:
    file_path = os.getenv(f"{name}_FILE", "").strip()
    if file_path:
        try:
            with open(file_path, "r", encoding="utf-8") as handle:
                value = handle.read().strip()
            if value:
                return value
        except OSError:
            pass
    return os.getenv(name, "").strip() or default

app = FastAPI(title="Market Data Plane", version="0.3.0")
APP_STARTED_AT = datetime.now(timezone.utc)
LOGGER = logging.getLogger(__name__)

DEFAULT_SYMBOLS = [symbol.strip() for symbol in os.getenv("MARKET_SYMBOLS", "BTCUSDT,ETHUSDT,SOLUSDT").split(",") if symbol.strip()]
DEFAULT_CFD_SEED_SYMBOLS = [symbol.strip().upper() for symbol in os.getenv("MARKET_CFD_SEED_SYMBOLS", "EURUSD,XAUUSD,GBPUSD,USDJPY,XAGUSD").split(",") if symbol.strip()]
CFD_AUTO_SEED_ENABLED = os.getenv("MARKET_CFD_AUTO_SEED", "0").strip().lower() in {"1", "true", "yes", "on"}
DEFAULT_VENUE = os.getenv("MARKET_PRIMARY_VENUE", "binance-public")
SYNC_SECONDS = max(4, int(os.getenv("MARKET_SYNC_SECONDS", "12")))
MAX_DEPTH_LEVELS = max(5, min(100, int(os.getenv("MARKET_DEPTH_LEVELS", "20"))))
DEPTH_STREAM_ENABLED = os.getenv("MARKET_DEPTH_STREAM_ENABLED", "1").strip().lower() not in {"0", "false", "no"}
MARKET_SHARD_INDEX = max(0, int(os.getenv("MARKET_SHARD_INDEX", "0")))
MARKET_SHARD_TOTAL = max(1, int(os.getenv("MARKET_SHARD_TOTAL", "1")))
LIVENESS_PORT = max(1024, int(os.getenv("MARKET_DATA_LIVENESS_PORT", "8010")))
MARKET_PRIMARY_WRITER = MARKET_SHARD_TOTAL <= 1 or MARKET_SHARD_INDEX == 0
CFD_WRITE_ENABLED = os.getenv("MARKET_CFD_WRITE_ENABLED", "1").strip().lower() not in {"0", "false", "no"} and MARKET_PRIMARY_WRITER
HOUSEKEEPING_ENABLED = os.getenv("MARKET_DATA_HOUSEKEEPING_ENABLED", "1").strip().lower() not in {"0", "false", "no"} and MARKET_PRIMARY_WRITER
CFD_BACKFILL_LOCK_TTL_SEC = max(60, int(os.getenv("MARKET_CFD_BACKFILL_LOCK_TTL_SEC", "900")))
GOLDAPI_API_KEY = _secret_env("GOLDAPI_API_KEY", "")
GOLDAPI_ENABLED = bool(GOLDAPI_API_KEY)
GOLDAPI_BASE_URL = os.getenv("GOLDAPI_BASE_URL", "https://www.goldapi.io/api").rstrip("/")
GOLDAPI_HISTORY_DAYS = max(3, min(90, int(os.getenv("GOLDAPI_HISTORY_DAYS", "30"))))
GOLDAPI_MAX_CALLS_PER_RUN = max(3, min(120, int(os.getenv("GOLDAPI_MAX_CALLS_PER_RUN", "40"))))
GOLDAPI_CACHE_TTL_SEC = max(30, int(os.getenv("GOLDAPI_CACHE_TTL_SEC", "21600")))
GOLDAPI_REQUEST_PAUSE_SEC = max(0.0, float(os.getenv("GOLDAPI_REQUEST_PAUSE_SEC", "0.25")))
TWELVEDATA_API_KEY = _secret_env("TWELVEDATA_API_KEY", "")
TWELVEDATA_ENABLED = bool(TWELVEDATA_API_KEY)
TWELVEDATA_BASE_URL = os.getenv("TWELVEDATA_BASE_URL", "https://api.twelvedata.com").rstrip("/")
TWELVEDATA_HISTORY_DAYS = max(3, min(365, int(os.getenv("TWELVEDATA_HISTORY_DAYS", "30"))))
TWELVEDATA_CACHE_TTL_SEC = max(30, int(os.getenv("TWELVEDATA_CACHE_TTL_SEC", "21600")))
METALSAPI_API_KEY = _secret_env("METALSAPI_API_KEY", "")
METALSAPI_ENABLED = bool(METALSAPI_API_KEY)
METALSAPI_BASE_URL = os.getenv("METALSAPI_BASE_URL", "https://metals-api.com/api").rstrip("/")
METALSAPI_HISTORY_DAYS = max(3, min(90, int(os.getenv("METALSAPI_HISTORY_DAYS", "30"))))
METALSAPI_MAX_CALLS_PER_RUN = max(3, min(120, int(os.getenv("METALSAPI_MAX_CALLS_PER_RUN", "40"))))
METALSAPI_CACHE_TTL_SEC = max(30, int(os.getenv("METALSAPI_CACHE_TTL_SEC", "21600")))
METALSAPI_REQUEST_PAUSE_SEC = max(0.0, float(os.getenv("METALSAPI_REQUEST_PAUSE_SEC", "0.15")))

SUPPORTED_VENUES = [
    "binance-public",
    "coinbase-public",
    "kraken-public",
    "okx-public",
    "bitget-public",
    "bingx-public",
    "solana-jupiter",
    "paper-bitget",
    "paper-coinbase",
    "paper-kraken",
    "paper-okx",
    "paper-bingx",
]

SNAPSHOTS = {
    "paper-bitget:BTCUSDT-PERP": {"venue": "paper-bitget", "instrument": "BTCUSDT-PERP", "bid": 68245.5, "ask": 68250.1, "last": 68247.8, "spread_bps": 0.67},
    "paper-coinbase:ETHUSDT-PERP": {"venue": "paper-coinbase", "instrument": "ETHUSDT-PERP", "bid": 3520.2, "ask": 3521.0, "last": 3520.5, "spread_bps": 2.27},
    "paper-kraken:BTCUSD-PERP": {"venue": "paper-kraken", "instrument": "BTCUSD-PERP", "bid": 68240.2, "ask": 68245.1, "last": 68242.9, "spread_bps": 0.71},
    "paper-okx:ETHUSDT-SWAP": {"venue": "paper-okx", "instrument": "ETHUSDT-SWAP", "bid": 3519.8, "ask": 3520.7, "last": 3520.1, "spread_bps": 2.56},
    "paper-bingx:SOLUSDT-PERP": {"venue": "paper-bingx", "instrument": "SOLUSDT-PERP", "bid": 184.12, "ask": 184.23, "last": 184.18, "spread_bps": 5.97},
    "solana-jupiter:SOLUSDC": {"venue": "solana-jupiter", "instrument": "SOLUSDC", "bid": 184.05, "ask": 184.16, "last": 184.1, "spread_bps": 5.97},
    "paper-polymarket:BTC-UP-THIS-WEEK": {"venue": "paper-polymarket", "instrument": "BTC-UP-THIS-WEEK", "bid": 0.57, "ask": 0.58, "last": 0.575, "spread_bps": 173.91},
}

DEPTH_BOOKS: dict[str, dict[str, Any]] = {}
DEPTH_SUBSCRIBERS: dict[str, set[WebSocket]] = {}
DERIVATIVES_CACHE: dict[str, dict[str, Any]] = {}
OHLCV_SUBSCRIBERS: dict[str, set[WebSocket]] = {}
OHLCV_STREAM_STATE: dict[str, dict[str, Any]] = {}
TRADE_SUBSCRIBERS: dict[str, set[WebSocket]] = {}
TRADE_RECENT_KEYS: dict[str, list[str]] = {}
LIVENESS_SERVER_STARTED = False
GOLDAPI_RESPONSE_CACHE: dict[str, tuple[datetime, dict[str, Any]]] = {}
TWELVEDATA_RESPONSE_CACHE: dict[str, tuple[datetime, dict[str, Any]]] = {}
METALSAPI_RESPONSE_CACHE: dict[str, tuple[datetime, dict[str, Any]]] = {}


class _LivenessHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        if self.path != "/healthz":
            self.send_response(404)
            self.end_headers()
            return
        payload = json.dumps(
            {
                "status": "ok",
                "service": "market-data-plane-liveness",
                "uptime_sec": max(0, int((_now_utc() - APP_STARTED_AT).total_seconds())),
            }
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A003
        return


def _start_liveness_server() -> None:
    global LIVENESS_SERVER_STARTED
    if LIVENESS_SERVER_STARTED:
        return
    server = ThreadingHTTPServer(("127.0.0.1", LIVENESS_PORT), _LivenessHandler)
    thread = threading.Thread(target=server.serve_forever, name="market-data-liveness", daemon=True)
    thread.start()
    LIVENESS_SERVER_STARTED = True


def _active_symbols() -> list[str]:
    normalized = [_normalize_instrument(symbol) for symbol in DEFAULT_SYMBOLS]
    if MARKET_SHARD_TOTAL <= 1:
        return normalized
    return [symbol for idx, symbol in enumerate(normalized) if idx % MARKET_SHARD_TOTAL == MARKET_SHARD_INDEX]


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _normalize_instrument(instrument: str) -> str:
    return instrument.replace("-PERP", "").replace("/", "").replace("-", "").upper()


def _stream_key(venue: str, instrument: str) -> str:
    return f"{venue}:{_normalize_instrument(instrument)}"


def _ohlcv_stream_key(venue: str, instrument: str, timeframe: str) -> str:
    return f"{venue}:{_normalize_instrument(instrument)}:{timeframe}"


def _trade_stream_key(venue: str, instrument: str) -> str:
    return f"{venue}:{_normalize_instrument(instrument)}"


def _market_symbol_for_venue(venue: str, instrument: str) -> str:
    normalized = _normalize_instrument(instrument)
    if venue in {"binance-public", "coinbase-public", "okx-public"} and normalized.endswith("USD") and not normalized.endswith("USDT"):
        return f"{normalized[:-3]}USDT"
    return normalized


def _coinbase_product_id(instrument: str) -> str | None:
    symbol = _market_symbol_for_venue("coinbase-public", instrument)
    if not symbol:
        return None
    if symbol.endswith("USDT"):
        base = symbol[:-4]
    elif symbol.endswith("USD"):
        base = symbol[:-3]
    else:
        return None
    if not base:
        return None
    return f"{base}-USD"


def _okx_inst_id(instrument: str) -> str | None:
    symbol = _market_symbol_for_venue("okx-public", instrument)
    if not symbol:
        return None
    if symbol.endswith("USDT"):
        base = symbol[:-4]
        return f"{base}-USDT"
    if symbol.endswith("USD"):
        base = symbol[:-3]
        return f"{base}-USD"
    return None


def _parse_iso_timestamp(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone(timezone.utc)
    except Exception:
        return None


def _session_label(ts: datetime) -> str:
    hour = ts.hour
    if 0 <= hour < 8:
        return "asia"
    if 8 <= hour < 14:
        return "london"
    return "new-york"


def _timeframe_delta(timeframe: str) -> timedelta:
    mapping = {
        "1m": timedelta(minutes=1),
        "5m": timedelta(minutes=5),
        "15m": timedelta(minutes=15),
        "1h": timedelta(hours=1),
        "1d": timedelta(days=1),
    }
    return mapping.get(timeframe, timedelta(minutes=1))


def _bucket_floor(ts: datetime, timeframe: str) -> datetime:
    if timeframe == "1d":
        return ts.replace(hour=0, minute=0, second=0, microsecond=0)
    if timeframe == "1h":
        return ts.replace(minute=0, second=0, microsecond=0)
    step = int(_timeframe_delta(timeframe).total_seconds() // 60)
    minute = (ts.minute // step) * step
    return ts.replace(minute=minute, second=0, microsecond=0)


def _cfd_source_symbol(instrument: str) -> str | None:
    mapping = {
        "EURUSD": "EURUSD=X",
        "GBPUSD": "GBPUSD=X",
        "AUDUSD": "AUDUSD=X",
        "NZDUSD": "NZDUSD=X",
        "USDCHF": "CHF=X",
        "USDCAD": "CAD=X",
        "USDJPY": "JPY=X",
        "XAUUSD": "GC=F",
        "XAGUSD": "SI=F",
        "USOIL": "CL=F",
        "BRENT": "BZ=F",
    }
    return mapping.get(_normalize_instrument(instrument))


def _frankfurter_pair(instrument: str) -> tuple[str, str, bool] | None:
    mapping = {
        "EURUSD": ("EUR", "USD", False),
        "GBPUSD": ("GBP", "USD", False),
        "AUDUSD": ("AUD", "USD", False),
        "NZDUSD": ("NZD", "USD", False),
        "USDJPY": ("JPY", "USD", True),
        "USDCHF": ("CHF", "USD", True),
        "USDCAD": ("CAD", "USD", True),
    }
    return mapping.get(_normalize_instrument(instrument))


def _backfill_window_for_timeframe(timeframe: str) -> tuple[str, str]:
    mapping = {
        "1m": ("1m", "7d"),
        "5m": ("5m", "30d"),
        "15m": ("15m", "60d"),
        "1h": ("60m", "60d"),
        "1d": ("1d", "365d"),
    }
    return mapping.get(timeframe, ("60m", "60d"))


def _is_metal_cfd(instrument: str) -> bool:
    return _normalize_instrument(instrument) in {"XAUUSD", "XAGUSD"}


def _goldapi_code(instrument: str) -> str | None:
    mapping = {
        "XAUUSD": "XAU",
        "XAGUSD": "XAG",
    }
    return mapping.get(_normalize_instrument(instrument))


def _goldapi_cache_get(cache_key: str) -> dict[str, Any] | None:
    cached = GOLDAPI_RESPONSE_CACHE.get(cache_key)
    if not cached:
        return None
    cached_at, payload = cached
    if (_now_utc() - cached_at).total_seconds() > GOLDAPI_CACHE_TTL_SEC:
        GOLDAPI_RESPONSE_CACHE.pop(cache_key, None)
        return None
    return payload


def _goldapi_cache_set(cache_key: str, payload: dict[str, Any]) -> None:
    GOLDAPI_RESPONSE_CACHE[cache_key] = (_now_utc(), payload)


def _twelvedata_symbol(instrument: str) -> str | None:
    mapping = {
        "XAUUSD": "XAU/USD",
        "XAGUSD": "XAG/USD",
    }
    return mapping.get(_normalize_instrument(instrument))


def _metalsapi_code(instrument: str) -> str | None:
    mapping = {
        "XAUUSD": "XAU",
        "XAGUSD": "XAG",
    }
    return mapping.get(_normalize_instrument(instrument))


def _metalsapi_cache_get(cache_key: str) -> dict[str, Any] | None:
    cached = METALSAPI_RESPONSE_CACHE.get(cache_key)
    if not cached:
        return None
    cached_at, payload = cached
    if (_now_utc() - cached_at).total_seconds() > METALSAPI_CACHE_TTL_SEC:
        METALSAPI_RESPONSE_CACHE.pop(cache_key, None)
        return None
    return payload


def _metalsapi_cache_set(cache_key: str, payload: dict[str, Any]) -> None:
    METALSAPI_RESPONSE_CACHE[cache_key] = (_now_utc(), payload)


def _twelvedata_cache_get(cache_key: str) -> dict[str, Any] | None:
    cached = TWELVEDATA_RESPONSE_CACHE.get(cache_key)
    if not cached:
        return None
    cached_at, payload = cached
    if (_now_utc() - cached_at).total_seconds() > TWELVEDATA_CACHE_TTL_SEC:
        TWELVEDATA_RESPONSE_CACHE.pop(cache_key, None)
        return None
    return payload


def _twelvedata_cache_set(cache_key: str, payload: dict[str, Any]) -> None:
    TWELVEDATA_RESPONSE_CACHE[cache_key] = (_now_utc(), payload)


async def _twelvedata_get(path: str, params: dict[str, Any]) -> dict[str, Any] | None:
    if not TWELVEDATA_ENABLED:
        return None
    cache_key = hashlib.sha256(json.dumps({"path": path, "params": params}, sort_keys=True).encode("utf-8")).hexdigest()
    cached = _twelvedata_cache_get(cache_key)
    if cached is not None:
        return cached
    request_params = {**params, "apikey": TWELVEDATA_API_KEY}
    async with httpx.AsyncClient(timeout=12.0, headers={"User-Agent": "TXT MarketData/1.0"}) as client:
        response = await client.get(f"{TWELVEDATA_BASE_URL}/{path.lstrip('/')}", params=request_params)
        response.raise_for_status()
        payload = response.json()
    if isinstance(payload, dict):
        _twelvedata_cache_set(cache_key, payload)
        return payload
    return None


async def _metalsapi_get(path: str, params: dict[str, Any]) -> dict[str, Any] | None:
    if not METALSAPI_ENABLED:
        return None
    cache_key = hashlib.sha256(json.dumps({"path": path, "params": params}, sort_keys=True).encode("utf-8")).hexdigest()
    cached = _metalsapi_cache_get(cache_key)
    if cached is not None:
        return cached
    request_params = {**params, "access_key": METALSAPI_API_KEY}
    async with httpx.AsyncClient(timeout=12.0, headers={"User-Agent": "TXT MarketData/1.0"}) as client:
        response = await client.get(f"{METALSAPI_BASE_URL}/{path.lstrip('/')}", params=request_params)
        response.raise_for_status()
        payload = response.json()
    if isinstance(payload, dict):
        _metalsapi_cache_set(cache_key, payload)
        return payload
    return None


async def _fetch_twelvedata_rows(instrument: str, timeframe: str) -> list[dict[str, Any]]:
    symbol = _twelvedata_symbol(instrument)
    if symbol is None or timeframe != "1d" or not TWELVEDATA_ENABLED:
        return []
    payload = await _twelvedata_get(
        "time_series",
        {
            "symbol": symbol,
            "interval": "1day",
            "outputsize": TWELVEDATA_HISTORY_DAYS,
        },
    )
    values = payload.get("values") if isinstance(payload, dict) else None
    if not isinstance(values, list):
        return []
    rows: list[dict[str, Any]] = []
    for item in reversed(values):
        if not isinstance(item, dict):
            continue
        bucket_raw = str(item.get("datetime") or "").strip()
        if not bucket_raw:
            continue
        try:
            bucket_date = datetime.fromisoformat(f"{bucket_raw}T00:00:00+00:00")
        except ValueError:
            continue
        open_price = _float(item.get("open"), 0.0)
        high_price = _float(item.get("high"), 0.0)
        low_price = _float(item.get("low"), 0.0)
        close_price = _float(item.get("close"), 0.0)
        if min(open_price, high_price, low_price, close_price) <= 0:
            continue
        rows.append(
            {
                "bucket_start": _bucket_floor(bucket_date, "1d"),
                "open": open_price,
                "high": max(high_price, open_price, close_price),
                "low": min(low_price, open_price, close_price),
                "close": close_price,
                "volume": 0.0,
                "quote_volume": 0.0,
                "trades_count": 0,
            }
        )
    return rows


def _metalsapi_payload_to_row(payload: dict[str, Any], bucket_date: datetime) -> dict[str, Any] | None:
    rates = payload.get("rates") if isinstance(payload, dict) else None
    if not isinstance(rates, dict):
        return None
    open_price = _float(rates.get("open"), 0.0)
    high_price = _float(rates.get("high"), 0.0)
    low_price = _float(rates.get("low"), 0.0)
    close_price = _float(rates.get("close"), 0.0)
    if min(open_price, high_price, low_price, close_price) <= 0:
        return None
    return {
        "bucket_start": _bucket_floor(bucket_date, "1d"),
        "open": open_price,
        "high": max(high_price, open_price, close_price),
        "low": min(low_price, open_price, close_price),
        "close": close_price,
        "volume": 0.0,
        "quote_volume": 0.0,
        "trades_count": 0,
    }


async def _fetch_metalsapi_rows(instrument: str, timeframe: str) -> list[dict[str, Any]]:
    code = _metalsapi_code(instrument)
    if code is None or timeframe != "1d" or not METALSAPI_ENABLED:
        return []
    rows: dict[str, dict[str, Any]] = {}
    calls = 0
    end_date = _now_utc().date() - timedelta(days=1)
    start_date = end_date - timedelta(days=max(0, METALSAPI_HISTORY_DAYS - 1))
    cursor = end_date
    while cursor >= start_date and calls < METALSAPI_MAX_CALLS_PER_RUN:
        payload = await _metalsapi_get(
            f"open-high-low-close/{cursor.isoformat()}",
            {"base": code, "symbols": "USD"},
        )
        calls += 1
        if payload:
            bucket_date = datetime(cursor.year, cursor.month, cursor.day, tzinfo=timezone.utc)
            row = _metalsapi_payload_to_row(payload, bucket_date)
            if row:
                rows[row["bucket_start"].isoformat()] = row
        if METALSAPI_REQUEST_PAUSE_SEC > 0 and cursor > start_date and calls < METALSAPI_MAX_CALLS_PER_RUN:
            await asyncio.sleep(METALSAPI_REQUEST_PAUSE_SEC)
        cursor -= timedelta(days=1)
    return [rows[key] for key in sorted(rows.keys())]


async def _goldapi_get(path: str) -> dict[str, Any] | None:
    if not GOLDAPI_ENABLED:
        return None
    cache_key = path.strip()
    cached = _goldapi_cache_get(cache_key)
    if cached is not None:
        return cached
    async with httpx.AsyncClient(timeout=12.0, headers={
        "x-access-token": GOLDAPI_API_KEY,
        "Content-Type": "application/json",
        "User-Agent": "TXT MarketData/1.0",
    }) as client:
        response = await client.get(f"{GOLDAPI_BASE_URL}/{cache_key}")
        response.raise_for_status()
        payload = response.json()
    if isinstance(payload, dict):
        _goldapi_cache_set(cache_key, payload)
        return payload
    return None


def _goldapi_payload_to_row(payload: dict[str, Any], bucket_date: datetime) -> dict[str, Any] | None:
    close_price = _float(payload.get("price") or payload.get("close") or payload.get("close_price"), 0.0)
    if close_price <= 0:
        return None
    open_price = _float(payload.get("open") or payload.get("open_price"), close_price)
    high_price = _float(payload.get("high") or payload.get("high_price"), max(open_price, close_price))
    low_price = _float(payload.get("low") or payload.get("low_price"), min(open_price, close_price))
    bucket_start = _bucket_floor(bucket_date, "1d")
    return {
        "bucket_start": bucket_start,
        "open": max(open_price, 0.0),
        "high": max(high_price, open_price, close_price),
        "low": min(value for value in (low_price, open_price, close_price) if value > 0),
        "close": close_price,
        "volume": 0.0,
        "quote_volume": 0.0,
        "trades_count": 0,
    }


async def _fetch_goldapi_rows(instrument: str, timeframe: str) -> list[dict[str, Any]]:
    code = _goldapi_code(instrument)
    if code is None or timeframe != "1d" or not GOLDAPI_ENABLED:
        return []
    rows: dict[str, dict[str, Any]] = {}
    calls = 0
    end_date = _now_utc().date() - timedelta(days=1)
    start_date = end_date - timedelta(days=max(0, GOLDAPI_HISTORY_DAYS - 1))
    cursor = end_date
    while cursor >= start_date and calls < GOLDAPI_MAX_CALLS_PER_RUN:
        if cursor.weekday() >= 5:
            cursor -= timedelta(days=1)
            continue
        payload = await _goldapi_get(f"{code}/USD/{cursor.isoformat()}")
        calls += 1
        if payload:
            bucket_date = datetime(cursor.year, cursor.month, cursor.day, tzinfo=timezone.utc)
            row = _goldapi_payload_to_row(payload, bucket_date)
            if row:
                rows[row["bucket_start"].isoformat()] = row
        if GOLDAPI_REQUEST_PAUSE_SEC > 0 and cursor > start_date and calls < GOLDAPI_MAX_CALLS_PER_RUN:
            await asyncio.sleep(GOLDAPI_REQUEST_PAUSE_SEC)
        cursor -= timedelta(days=1)
    return [rows[key] for key in sorted(rows.keys())]


def _cfd_backfill_lock_key(instrument: str) -> str:
    return f"market-data:cfd-backfill:{_normalize_instrument(instrument)}"


def _try_acquire_cfd_backfill_lock(instrument: str) -> bool:
    lock_key = _cfd_backfill_lock_key(instrument)
    existing = fetch_one(
        "SELECT config_value, updated_at FROM system_config WHERE config_key = %s",
        (lock_key,),
    )
    if existing:
        updated_at = existing.get("updated_at")
        updated_dt = updated_at if isinstance(updated_at, datetime) else _parse_iso_timestamp(updated_at)
        if updated_dt and (_now_utc() - updated_dt).total_seconds() > CFD_BACKFILL_LOCK_TTL_SEC:
            execute("DELETE FROM system_config WHERE config_key = %s", (lock_key,))
        else:
            return False
    payload = {
        "instrument": _normalize_instrument(instrument),
        "owner": f"shard-{MARKET_SHARD_INDEX}-of-{MARKET_SHARD_TOTAL}",
        "started_at": _now_utc().isoformat(),
    }
    inserted = execute_rowcount(
        """
        INSERT INTO system_config (config_key, config_value)
        VALUES (%s, %s::jsonb)
        ON CONFLICT (config_key) DO NOTHING
        """,
        (lock_key, json_dumps(payload)),
    )
    return inserted > 0


def _release_cfd_backfill_lock(instrument: str) -> None:
    execute("DELETE FROM system_config WHERE config_key = %s", (_cfd_backfill_lock_key(instrument),))


def _upsert_ohlcv_rows(venue: str, instrument: str, timeframe: str, rows: list[dict[str, Any]], source: str) -> int:
    inserted = 0
    for row in rows:
        bucket_start = row.get("bucket_start")
        if not isinstance(bucket_start, datetime):
            continue
        open_price = _float(row.get("open"), 0.0)
        high_price = _float(row.get("high"), open_price)
        low_price = _float(row.get("low"), open_price)
        close_price = _float(row.get("close"), open_price)
        if min(open_price, high_price, low_price, close_price) <= 0:
            continue
        execute(
            """
            INSERT INTO market_ohlcv (
                venue, instrument, timeframe, bucket_start, open, high, low, close, volume, quote_volume, trades_count, source
            ) VALUES (%s, %s, %s, %s::timestamptz, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (venue, instrument, timeframe, bucket_start) DO UPDATE SET
                open = EXCLUDED.open,
                high = EXCLUDED.high,
                low = EXCLUDED.low,
                close = EXCLUDED.close,
                volume = EXCLUDED.volume,
                quote_volume = EXCLUDED.quote_volume,
                trades_count = EXCLUDED.trades_count,
                source = EXCLUDED.source
            """,
            (
                venue,
                _normalize_instrument(instrument),
                timeframe,
                bucket_start.isoformat(),
                open_price,
                high_price,
                low_price,
                close_price,
                _float(row.get("volume"), 0.0),
                _float(row.get("quote_volume"), 0.0),
                int(_float(row.get("trades_count"), 0.0)),
                source,
            ),
        )
        inserted += 1
    return inserted


def _cleanup_lower_priority_metal_daily_rows(instrument: str, canonical_venue: str, rows: list[dict[str, Any]]) -> int:
    normalized = _normalize_instrument(instrument)
    if not _is_metal_cfd(normalized):
        return 0
    provider_order = ["goldapi-cfd", "twelvedata-cfd", "metalsapi-cfd", "frankfurter-cfd", "yahoo-cfd"]
    if canonical_venue not in provider_order:
        return 0
    bucket_starts = sorted(
        {
            row["bucket_start"]
            for row in rows
            if isinstance(row, dict) and isinstance(row.get("bucket_start"), datetime)
        }
    )
    if not bucket_starts:
        return 0
    lower_priority_venues = provider_order[provider_order.index(canonical_venue) + 1 :]
    if not lower_priority_venues:
        return 0
    placeholders = ", ".join(["%s"] * len(lower_priority_venues))
    delete_until = _bucket_floor(_now_utc(), "1d")
    params = (
        normalized,
        *lower_priority_venues,
        bucket_starts[0].isoformat(),
        delete_until.isoformat(),
    )
    existing = fetch_one(
        f"""
        SELECT COUNT(*) AS count
        FROM market_ohlcv
        WHERE instrument = %s
          AND timeframe = '1d'
          AND venue IN ({placeholders})
          AND bucket_start >= %s::timestamptz
          AND bucket_start <= %s::timestamptz
        """,
        params,
    ) or {"count": 0}
    count = int(existing.get("count") or 0)
    if count <= 0:
        return 0
    execute(
        f"""
        DELETE FROM market_ohlcv
        WHERE instrument = %s
          AND timeframe = '1d'
          AND venue IN ({placeholders})
          AND bucket_start >= %s::timestamptz
          AND bucket_start <= %s::timestamptz
        """,
        params,
    )
    return count


async def _fetch_yahoo_chart_rows(instrument: str, timeframe: str) -> list[dict[str, Any]]:
    source_symbol = _cfd_source_symbol(instrument)
    if not source_symbol:
        return []
    interval, range_value = _backfill_window_for_timeframe(timeframe)
    async with httpx.AsyncClient(timeout=8.0, headers={"User-Agent": "TXT MarketData/1.0"}) as client:
        response = await client.get(
            f"https://query1.finance.yahoo.com/v8/finance/chart/{source_symbol}",
            params={"interval": interval, "range": range_value, "includePrePost": "false", "events": "div,splits"},
        )
        if response.status_code >= 400:
            return []
        payload = response.json()
    result = payload.get("chart", {}).get("result") if isinstance(payload, dict) else None
    if not isinstance(result, list) or not result:
        return []
    chart = result[0] if isinstance(result[0], dict) else {}
    timestamps = chart.get("timestamp") if isinstance(chart.get("timestamp"), list) else []
    quote = (((chart.get("indicators") or {}).get("quote") or [{}])[0]) if isinstance(chart.get("indicators"), dict) else {}
    opens = quote.get("open") if isinstance(quote.get("open"), list) else []
    highs = quote.get("high") if isinstance(quote.get("high"), list) else []
    lows = quote.get("low") if isinstance(quote.get("low"), list) else []
    closes = quote.get("close") if isinstance(quote.get("close"), list) else []
    volumes = quote.get("volume") if isinstance(quote.get("volume"), list) else []
    rows: list[dict[str, Any]] = []
    for index, raw_ts in enumerate(timestamps):
        ts = datetime.fromtimestamp(int(raw_ts), tz=timezone.utc)
        open_price = _float(opens[index] if index < len(opens) else None, 0.0)
        high_price = _float(highs[index] if index < len(highs) else None, 0.0)
        low_price = _float(lows[index] if index < len(lows) else None, 0.0)
        close_price = _float(closes[index] if index < len(closes) else None, 0.0)
        volume = _float(volumes[index] if index < len(volumes) else None, 0.0)
        if min(open_price, high_price, low_price, close_price) <= 0:
            continue
        rows.append(
            {
                "bucket_start": _bucket_floor(ts, timeframe),
                "open": open_price,
                "high": high_price,
                "low": low_price,
                "close": close_price,
                "volume": volume,
                "quote_volume": close_price * volume if volume > 0 else 0.0,
                "trades_count": 0,
            }
        )
    deduped: dict[str, dict[str, Any]] = {}
    for row in rows:
        bucket = row["bucket_start"].isoformat()
        deduped[bucket] = row
    return [deduped[key] for key in sorted(deduped.keys())]


async def _fetch_frankfurter_rows(instrument: str, timeframe: str) -> list[dict[str, Any]]:
    pair = _frankfurter_pair(instrument)
    if pair is None or timeframe != "1d":
        return []
    quote_currency, base_currency, invert = pair
    end_date = _now_utc().date()
    start_date = end_date - timedelta(days=395)
    async with httpx.AsyncClient(timeout=20.0, headers={"User-Agent": "TXT MarketData/1.0"}) as client:
        response = await client.get(
            f"https://api.frankfurter.app/{start_date.isoformat()}..{end_date.isoformat()}",
            params={"from": base_currency, "to": quote_currency},
        )
        response.raise_for_status()
        payload = response.json()
    rates = payload.get("rates") if isinstance(payload, dict) else None
    if not isinstance(rates, dict):
        return []
    rows: list[dict[str, Any]] = []
    for raw_date, quote_map in sorted(rates.items()):
        if not isinstance(raw_date, str) or not isinstance(quote_map, dict):
            continue
        raw_rate = _float(quote_map.get(quote_currency), 0.0)
        if raw_rate <= 0:
            continue
        close_price = (1.0 / raw_rate) if invert else raw_rate
        if close_price <= 0:
            continue
        bucket = datetime.fromisoformat(f"{raw_date}T00:00:00+00:00")
        rows.append(
            {
                "bucket_start": _bucket_floor(bucket, timeframe),
                "open": close_price,
                "high": close_price,
                "low": close_price,
                "close": close_price,
                "volume": 0.0,
                "quote_volume": 0.0,
                "trades_count": 0,
            }
        )
    return rows


async def _fetch_cfd_rows(instrument: str, timeframe: str, preferred_venue: str | None = None) -> tuple[list[dict[str, Any]], str | None, str | None]:
    errors: list[str] = []
    requested = str(preferred_venue or "auto-cfd").strip().lower()

    if _is_metal_cfd(instrument) and requested in {"auto-cfd", "goldapi", "goldapi-cfd"}:
        try:
            rows = await _fetch_goldapi_rows(instrument, timeframe)
            if rows:
                return rows, "goldapi-cfd", None
            if timeframe == "1d":
                errors.append("goldapi returned no rows")
        except Exception as exc:
            errors.append(f"goldapi error: {exc}")
        if requested in {"goldapi", "goldapi-cfd"}:
            return [], None, "; ".join(errors) if errors else "goldapi unavailable"

    if _is_metal_cfd(instrument) and requested in {"auto-cfd", "twelvedata", "twelvedata-cfd"}:
        try:
            rows = await _fetch_twelvedata_rows(instrument, timeframe)
            if rows:
                return rows, "twelvedata-cfd", None
            if timeframe == "1d":
                errors.append("twelvedata returned no rows")
        except Exception as exc:
            errors.append(f"twelvedata error: {exc}")
        if requested in {"twelvedata", "twelvedata-cfd"}:
            return [], None, "; ".join(errors) if errors else "twelvedata unavailable"

    if _is_metal_cfd(instrument) and requested in {"auto-cfd", "metalsapi", "metalsapi-cfd"}:
        try:
            rows = await _fetch_metalsapi_rows(instrument, timeframe)
            if rows:
                return rows, "metalsapi-cfd", None
            if timeframe == "1d":
                errors.append("metalsapi returned no rows")
        except Exception as exc:
            errors.append(f"metalsapi error: {exc}")
        if requested in {"metalsapi", "metalsapi-cfd"}:
            return [], None, "; ".join(errors) if errors else "metalsapi unavailable"

    frankfurter_pair = _frankfurter_pair(instrument)
    if frankfurter_pair is not None and requested in {"auto-cfd", "frankfurter", "frankfurter-cfd"}:
        if timeframe == "1d":
            try:
                rows = await _fetch_frankfurter_rows(instrument, timeframe)
                if rows:
                    return rows, "frankfurter-cfd", None
                errors.append("frankfurter returned no rows")
            except Exception as exc:
                errors.append(f"frankfurter error: {exc}")
        else:
            return [], None, "no intraday source configured"
        if requested in {"frankfurter", "frankfurter-cfd"}:
            return [], None, "; ".join(errors) if errors else "frankfurter unavailable"

    if timeframe in {"1h", "1d"} and requested in {"auto-cfd", "yahoo", "yahoo-cfd"}:
        try:
            rows = await _fetch_yahoo_chart_rows(instrument, timeframe)
            if rows:
                return rows, "yahoo-cfd", None
            errors.append("yahoo returned no rows")
        except Exception as exc:
            errors.append(f"yahoo error: {exc}")

    error_detail = "; ".join(errors) if errors else "no source available"
    return [], None, error_detail


async def _backfill_cfd_symbol(instrument: str, venue: str = "yahoo-cfd") -> dict[str, Any]:
    normalized = _normalize_instrument(instrument)
    requested_venue = str(venue or "auto-cfd").strip().lower() or "auto-cfd"
    if not CFD_WRITE_ENABLED:
        return {
            "status": "unavailable",
            "instrument": normalized,
            "venue": venue,
            "resolved_venues": {},
            "timeframes": {},
            "source_symbol": _cfd_source_symbol(normalized),
            "errors": {"writer": "CFD writer disabled on this instance"},
        }
    if not _try_acquire_cfd_backfill_lock(normalized):
        return {
            "status": "unavailable",
            "instrument": normalized,
            "venue": venue,
            "resolved_venues": {},
            "timeframes": {},
            "source_symbol": _cfd_source_symbol(normalized),
            "errors": {"lock": "Backfill already running for this symbol"},
        }
    seeded: dict[str, int] = {}
    per_timeframe_venue: dict[str, str] = {}
    cleaned_rows: dict[str, int] = {}
    errors: dict[str, str] = {}
    successful_timeframes = 0
    try:
        for timeframe in ("1h", "1d"):
            rows, resolved_venue, error = await _fetch_cfd_rows(normalized, timeframe, preferred_venue=venue)
            if rows and resolved_venue:
                seeded[timeframe] = _upsert_ohlcv_rows(resolved_venue, normalized, timeframe, rows, source=f"{resolved_venue}-backfill")
                per_timeframe_venue[timeframe] = resolved_venue
                if (
                    timeframe == "1d"
                    and requested_venue in {"auto-cfd", "goldapi", "goldapi-cfd", "twelvedata", "twelvedata-cfd", "metalsapi", "metalsapi-cfd"}
                    and resolved_venue in {"goldapi-cfd", "twelvedata-cfd", "metalsapi-cfd"}
                ):
                    cleaned_rows[timeframe] = _cleanup_lower_priority_metal_daily_rows(normalized, resolved_venue, rows)
                successful_timeframes += 1
                continue
            seeded[timeframe] = 0
            cleaned_rows[timeframe] = 0
            if error:
                errors[timeframe] = error
    finally:
        _release_cfd_backfill_lock(normalized)
    status = "ok" if successful_timeframes == len(seeded) else ("partial" if successful_timeframes > 0 else "unavailable")
    return {
        "status": status,
        "instrument": normalized,
        "venue": venue,
        "resolved_venues": per_timeframe_venue,
        "timeframes": seeded,
        "cleaned_rows": cleaned_rows,
        "source_symbol": _cfd_source_symbol(normalized),
        "errors": errors,
    }


def _float(value: Any, fallback: float = 0.0) -> float:
    try:
        return float(value)
    except Exception:
        return fallback


def _trade_cache_signature(venue: str, instrument: str, trade: dict[str, Any]) -> str:
    trade_id = str(trade.get("trade_id") or trade.get("id") or "")
    traded_at = trade.get("traded_at")
    if isinstance(traded_at, datetime):
        traded_at_value = traded_at.isoformat()
    else:
        traded_at_value = str(traded_at or "")
    return f"{venue}|{_normalize_instrument(instrument)}|{trade_id}|{traded_at_value}|{_float(trade.get('price'), 0.0):.8f}|{_float(trade.get('size'), 0.0):.8f}"


def _remember_trade_signature(venue: str, instrument: str, trade: dict[str, Any], limit: int = 4000) -> bool:
    stream_key = _trade_stream_key(venue, instrument)
    signatures = TRADE_RECENT_KEYS.setdefault(stream_key, [])
    signature = _trade_cache_signature(venue, instrument, trade)
    if signature in signatures:
        return False
    signatures.append(signature)
    if len(signatures) > limit:
        del signatures[:-limit]
    return True


def _depth_rows_to_map(rows: list[list[float]]) -> dict[float, float]:
    return {float(price): float(size) for price, size in rows if float(size) > 0}


def _depth_map_to_rows(side_map: dict[float, float], reverse: bool, limit: int = MAX_DEPTH_LEVELS) -> list[list[float]]:
    prices = sorted(side_map.keys(), reverse=reverse)[:limit]
    return [[price, side_map[price]] for price in prices]


def _apply_side_delta(side_map: dict[float, float], delta: list[list[str]]) -> None:
    for raw_price, raw_size in delta:
        price = _float(raw_price)
        size = _float(raw_size)
        if size <= 0:
            side_map.pop(price, None)
        else:
            side_map[price] = size


def _snapshot_from_book(venue: str, symbol: str, book: dict[str, Any], reason: str, source: str) -> dict[str, Any]:
    bids = _depth_map_to_rows(book.get("bids", {}), reverse=True)
    asks = _depth_map_to_rows(book.get("asks", {}), reverse=False)
    best_bid = bids[0][0] if bids else 0.0
    best_ask = asks[0][0] if asks else 0.0
    mid = (best_bid + best_ask) / 2 if best_bid > 0 and best_ask > 0 else 0.0
    spread_bps = ((best_ask - best_bid) / mid * 10000) if mid > 0 else 0.0
    return {
        "venue": venue,
        "instrument": symbol,
        "snapshot_at": _now_utc(),
        "best_bid": best_bid,
        "best_ask": best_ask,
        "spread_bps": spread_bps,
        "depth": {
            "bids": bids,
            "asks": asks,
            "lastUpdateId": book.get("last_update_id"),
            "event_time": book.get("event_time"),
            "reason": reason,
        },
        "source": source,
    }


async def _broadcast_depth_delta(venue: str, symbol: str, payload: dict[str, Any]) -> None:
    key = _stream_key(venue, symbol)
    subscribers = DEPTH_SUBSCRIBERS.get(key, set())
    if not subscribers:
        return
    stale: list[WebSocket] = []
    for socket in list(subscribers):
        try:
            await socket.send_json(payload)
        except Exception:
            stale.append(socket)
    for socket in stale:
        subscribers.discard(socket)


def _serialize_trade(venue: str, instrument: str, trade: dict[str, Any]) -> dict[str, Any]:
    traded_at = trade.get("traded_at")
    if isinstance(traded_at, datetime):
        traded_at_iso = traded_at.isoformat()
    else:
        traded_at_iso = str(traded_at or _now_utc().isoformat())
    return {
        "venue": venue,
        "instrument": _normalize_instrument(instrument),
        "trade_id": str(trade.get("trade_id") or trade.get("id") or ""),
        "side": str(trade.get("side") or ""),
        "price": _float(trade.get("price"), 0.0),
        "size": _float(trade.get("size"), 0.0),
        "traded_at": traded_at_iso,
        "payload": trade.get("payload", {}),
    }


async def _broadcast_trade(venue: str, instrument: str, trade: dict[str, Any]) -> None:
    key = _trade_stream_key(venue, instrument)
    subscribers = TRADE_SUBSCRIBERS.get(key, set())
    if not subscribers:
        return
    payload = {
        "type": "trade",
        "venue": venue,
        "instrument": _normalize_instrument(instrument),
        "item": _serialize_trade(venue, instrument, trade),
        "as_of": _now_utc().isoformat(),
    }
    stale: list[WebSocket] = []
    for socket in list(subscribers):
        try:
            await socket.send_json(payload)
        except Exception:
            stale.append(socket)
    for socket in stale:
        subscribers.discard(socket)


async def _broadcast_trades(venue: str, instrument: str, trades: list[dict[str, Any]]) -> None:
    if not trades:
        return
    for trade in trades:
        if not _remember_trade_signature(venue, instrument, trade):
            continue
        await _broadcast_trade(venue, instrument, trade)


async def _fetch_binance_book_ticker(client: httpx.AsyncClient, symbol: str) -> dict[str, Any] | None:
    try:
        response = await client.get("https://api.binance.com/api/v3/ticker/bookTicker", params={"symbol": symbol}, timeout=8.0)
        if response.status_code >= 400:
            return None
        payload = response.json()
        bid = _float(payload.get("bidPrice"))
        ask = _float(payload.get("askPrice"))
        if bid <= 0 or ask <= 0:
            return None
        last = (bid + ask) / 2
        spread_bps = ((ask - bid) / last * 10000) if last > 0 else 0.0
        return {
            "venue": DEFAULT_VENUE,
            "instrument": symbol,
            "bid": bid,
            "ask": ask,
            "last": last,
            "spread_bps": spread_bps,
            "source": "binance-bookTicker",
        }
    except Exception:
        return None


async def _fetch_coinbase_ticker(client: httpx.AsyncClient, symbol: str) -> dict[str, Any] | None:
    product_id = _coinbase_product_id(symbol)
    if not product_id:
        return None
    try:
        response = await client.get(f"https://api.exchange.coinbase.com/products/{product_id}/ticker", timeout=8.0)
        if response.status_code >= 400:
            return None
        payload = response.json()
        bid = _float(payload.get("bid"))
        ask = _float(payload.get("ask"))
        last = _float(payload.get("price"), (bid + ask) / 2 if bid > 0 and ask > 0 else 0.0)
        if bid <= 0 or ask <= 0:
            return None
        spread_bps = ((ask - bid) / last * 10000) if last > 0 else 0.0
        return {
            "venue": "coinbase-public",
            "instrument": _market_symbol_for_venue("coinbase-public", symbol),
            "bid": bid,
            "ask": ask,
            "last": last,
            "spread_bps": spread_bps,
            "source": "coinbase-ticker",
        }
    except Exception:
        return None


async def _fetch_okx_ticker(client: httpx.AsyncClient, symbol: str) -> dict[str, Any] | None:
    inst_id = _okx_inst_id(symbol)
    if not inst_id:
        return None
    try:
        response = await client.get("https://www.okx.com/api/v5/market/ticker", params={"instId": inst_id}, timeout=8.0)
        if response.status_code >= 400:
            return None
        payload = response.json()
        data = payload.get("data") if isinstance(payload, dict) else None
        item = data[0] if isinstance(data, list) and data else None
        if not isinstance(item, dict):
            return None
        bid = _float(item.get("bidPx"))
        ask = _float(item.get("askPx"))
        last = _float(item.get("last"), (bid + ask) / 2 if bid > 0 and ask > 0 else 0.0)
        if bid <= 0 or ask <= 0:
            return None
        spread_bps = ((ask - bid) / last * 10000) if last > 0 else 0.0
        return {
            "venue": "okx-public",
            "instrument": _market_symbol_for_venue("okx-public", symbol),
            "bid": bid,
            "ask": ask,
            "last": last,
            "spread_bps": spread_bps,
            "source": "okx-ticker",
        }
    except Exception:
        return None


async def _fetch_binance_trades(client: httpx.AsyncClient, symbol: str, limit: int = 200) -> list[dict[str, Any]]:
    try:
        response = await client.get("https://api.binance.com/api/v3/trades", params={"symbol": symbol, "limit": max(1, min(limit, 500))}, timeout=8.0)
        if response.status_code >= 400:
            return []
        rows = []
        for item in response.json():
            price = _float(item.get("price"))
            qty = _float(item.get("qty"))
            traded_at = datetime.fromtimestamp(int(item.get("time", 0)) / 1000, tz=timezone.utc)
            rows.append(
                {
                    "trade_id": str(item.get("id")),
                    "price": price,
                    "size": qty,
                    "side": "sell" if bool(item.get("isBuyerMaker")) else "buy",
                    "traded_at": traded_at,
                    "payload": item,
                }
            )
        return rows
    except Exception:
        return []


async def _fetch_binance_depth_snapshot(client: httpx.AsyncClient, symbol: str) -> dict[str, Any] | None:
    try:
        response = await client.get("https://api.binance.com/api/v3/depth", params={"symbol": symbol, "limit": MAX_DEPTH_LEVELS}, timeout=8.0)
        if response.status_code >= 400:
            return None
        payload = response.json()
        bids = [[_float(level[0]), _float(level[1])] for level in payload.get("bids", [])]
        asks = [[_float(level[0]), _float(level[1])] for level in payload.get("asks", [])]
        return {
            "last_update_id": payload.get("lastUpdateId"),
            "bids": bids,
            "asks": asks,
        }
    except Exception:
        return None


async def _fetch_coinbase_depth_snapshot(client: httpx.AsyncClient, symbol: str) -> dict[str, Any] | None:
    product_id = _coinbase_product_id(symbol)
    if not product_id:
        return None
    try:
        response = await client.get(
            f"https://api.exchange.coinbase.com/products/{product_id}/book",
            params={"level": 2},
            timeout=8.0,
        )
        if response.status_code >= 400:
            return None
        payload = response.json()
        bids = [[_float(level[0]), _float(level[1])] for level in payload.get("bids", [])]
        asks = [[_float(level[0]), _float(level[1])] for level in payload.get("asks", [])]
        return {
            "last_update_id": payload.get("sequence"),
            "bids": bids,
            "asks": asks,
        }
    except Exception:
        return None


async def _fetch_okx_depth_snapshot(client: httpx.AsyncClient, symbol: str) -> dict[str, Any] | None:
    inst_id = _okx_inst_id(symbol)
    if not inst_id:
        return None
    try:
        response = await client.get(
            "https://www.okx.com/api/v5/market/books",
            params={"instId": inst_id, "sz": MAX_DEPTH_LEVELS},
            timeout=8.0,
        )
        if response.status_code >= 400:
            return None
        payload = response.json()
        data = payload.get("data") if isinstance(payload, dict) else None
        item = data[0] if isinstance(data, list) and data else None
        if not isinstance(item, dict):
            return None
        bids = [[_float(level[0]), _float(level[1])] for level in item.get("bids", [])]
        asks = [[_float(level[0]), _float(level[1])] for level in item.get("asks", [])]
        return {
            "last_update_id": item.get("seqId") or item.get("ts"),
            "bids": bids,
            "asks": asks,
            "event_time": int(_float(item.get("ts"), int(_now_utc().timestamp() * 1000))),
        }
    except Exception:
        return None


def _coinbase_changes_to_depth_rows(changes: list[list[str]], side_label: str) -> list[list[str]]:
    rows: list[list[str]] = []
    for change in changes:
        if not isinstance(change, list) or len(change) < 3:
            continue
        side = str(change[0]).strip().lower()
        if side_label == "bid" and side != "buy":
            continue
        if side_label == "ask" and side != "sell":
            continue
        rows.append([str(change[1]), str(change[2])])
    return rows


async def _sync_depth_snapshot(
    venue: str,
    symbol: str,
    snapshot: dict[str, Any] | None,
    *,
    reason: str,
    source: str,
) -> None:
    if not snapshot:
        return
    event_time = int(snapshot.get("event_time") or int(_now_utc().timestamp() * 1000))
    book = {
        "bids": _depth_rows_to_map(snapshot.get("bids", [])),
        "asks": _depth_rows_to_map(snapshot.get("asks", [])),
        "last_update_id": int(snapshot.get("last_update_id") or 0),
        "event_time": event_time,
    }
    DEPTH_BOOKS[_stream_key(venue, symbol)] = book
    await _store_depth_async(_snapshot_from_book(venue, symbol, book, reason, source))


async def _fetch_binance_derivatives_metrics(client: httpx.AsyncClient, symbol: str) -> dict[str, Any] | None:
    try:
        premium_response = await client.get("https://fapi.binance.com/fapi/v1/premiumIndex", params={"symbol": symbol}, timeout=8.0)
        oi_response = await client.get("https://fapi.binance.com/fapi/v1/openInterest", params={"symbol": symbol}, timeout=8.0)
        if premium_response.status_code >= 400 or oi_response.status_code >= 400:
            return None

        premium = premium_response.json()
        oi = oi_response.json()
        next_funding_ms = int(_float(premium.get("nextFundingTime"), 0))
        next_funding_time = datetime.fromtimestamp(next_funding_ms / 1000, tz=timezone.utc) if next_funding_ms > 0 else None
        return {
            "venue": DEFAULT_VENUE,
            "instrument": symbol,
            "funding_rate": _float(premium.get("lastFundingRate"), 0.0),
            "open_interest": _float(oi.get("openInterest"), 0.0),
            "mark_price": _float(premium.get("markPrice"), 0.0),
            "next_funding_time": next_funding_time,
            "payload": {"premiumIndex": premium, "openInterest": oi},
            "captured_at": _now_utc(),
        }
    except Exception:
        return None


def _upsert_snapshot(snapshot: dict[str, Any]) -> None:
    snapshot_key = f"{snapshot['venue']}:{snapshot['instrument']}"
    execute(
        """
        INSERT INTO market_snapshots (snapshot_key, venue, instrument, bid, ask, last, spread_bps, payload)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s::jsonb)
        ON CONFLICT (snapshot_key) DO UPDATE SET
          bid = EXCLUDED.bid,
          ask = EXCLUDED.ask,
          last = EXCLUDED.last,
          spread_bps = EXCLUDED.spread_bps,
          payload = EXCLUDED.payload,
          updated_at = NOW()
        """,
        (
            snapshot_key,
            snapshot["venue"],
            snapshot["instrument"],
            snapshot["bid"],
            snapshot["ask"],
            snapshot["last"],
            snapshot["spread_bps"],
            json_dumps(snapshot),
        ),
    )


def _store_trades(venue: str, instrument: str, trades: list[dict[str, Any]]) -> None:
    for trade in trades:
        execute(
            """
                        INSERT INTO market_trades (venue, instrument, trade_id, side, price, size, traded_at, payload)
                        SELECT %s, %s, %s, %s, %s, %s, %s, %s::jsonb
                        WHERE NOT EXISTS (
                            SELECT 1
                            FROM market_trades
                            WHERE venue = %s
                                AND instrument = %s
                                AND (
                                    (trade_id IS NOT NULL AND trade_id = %s)
                                    OR (
                                        trade_id IS NULL
                                        AND traded_at = %s
                                        AND price = %s
                                        AND size = %s
                                        AND COALESCE(side, '') = COALESCE(%s, '')
                                    )
                                )
                        )
            """,
            (
                venue,
                instrument,
                trade.get("trade_id"),
                trade.get("side"),
                trade.get("price"),
                trade.get("size"),
                trade.get("traded_at"),
                json_dumps(trade.get("payload", {})),
                venue,
                instrument,
                trade.get("trade_id"),
                trade.get("traded_at"),
                trade.get("price"),
                trade.get("size"),
                trade.get("side"),
            ),
        )


def _store_depth(depth_payload: dict[str, Any]) -> None:
    execute(
        """
        INSERT INTO market_orderbook_snapshots (venue, instrument, snapshot_at, best_bid, best_ask, spread_bps, depth_payload, source)
        VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb, %s)
        """,
        (
            depth_payload["venue"],
            depth_payload["instrument"],
            depth_payload["snapshot_at"],
            depth_payload.get("best_bid"),
            depth_payload.get("best_ask"),
            depth_payload.get("spread_bps"),
            json_dumps(depth_payload.get("depth", {})),
            depth_payload.get("source", "unknown"),
        ),
    )


def _store_derivatives(metrics: dict[str, Any]) -> None:
    execute(
        """
        INSERT INTO market_derivatives_metrics (venue, instrument, funding_rate, open_interest, mark_price, next_funding_time, payload, captured_at)
        VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb, %s)
        """,
        (
            metrics["venue"],
            metrics["instrument"],
            metrics.get("funding_rate"),
            metrics.get("open_interest"),
            metrics.get("mark_price"),
            metrics.get("next_funding_time"),
            json_dumps(metrics.get("payload", {})),
            metrics.get("captured_at", _now_utc()),
        ),
    )


async def _upsert_snapshot_async(snapshot: dict[str, Any]) -> None:
    await asyncio.to_thread(_upsert_snapshot, snapshot)


async def _store_trades_async(venue: str, instrument: str, trades: list[dict[str, Any]]) -> None:
    await asyncio.to_thread(_store_trades, venue, instrument, trades)


async def _store_depth_async(depth_payload: dict[str, Any]) -> None:
    await asyncio.to_thread(_store_depth, depth_payload)


async def _store_derivatives_async(metrics: dict[str, Any]) -> None:
    await asyncio.to_thread(_store_derivatives, metrics)


async def _upsert_ohlcv_from_trades_async(venue: str, instrument: str, trades: list[dict[str, Any]], timeframe: str) -> None:
    await asyncio.to_thread(_upsert_ohlcv_from_trades, venue, instrument, trades, timeframe)


async def _cleanup_old_rows_async() -> None:
    await asyncio.to_thread(_cleanup_old_rows)


def _upsert_ohlcv_from_trades(venue: str, instrument: str, trades: list[dict[str, Any]], timeframe: str) -> None:
    if not trades:
        return
    grouped: dict[datetime, list[dict[str, Any]]] = {}
    for trade in trades:
        ts = trade["traded_at"]
        bucket = _bucket_floor(ts, timeframe)
        grouped.setdefault(bucket, []).append(trade)

    for bucket, rows in grouped.items():
        rows_sorted = sorted(rows, key=lambda row: row["traded_at"])
        open_price = _float(rows_sorted[0]["price"])
        close_price = _float(rows_sorted[-1]["price"])
        high_price = max(_float(row["price"]) for row in rows_sorted)
        low_price = min(_float(row["price"]) for row in rows_sorted)
        volume = sum(_float(row["size"]) for row in rows_sorted)
        quote_volume = sum(_float(row["size"]) * _float(row["price"]) for row in rows_sorted)
        execute(
            """
            INSERT INTO market_ohlcv (venue, instrument, timeframe, bucket_start, open, high, low, close, volume, quote_volume, trades_count, source)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (venue, instrument, timeframe, bucket_start) DO UPDATE SET
              open = EXCLUDED.open,
              high = EXCLUDED.high,
              low = EXCLUDED.low,
              close = EXCLUDED.close,
              volume = EXCLUDED.volume,
              quote_volume = EXCLUDED.quote_volume,
              trades_count = EXCLUDED.trades_count,
              source = EXCLUDED.source,
              created_at = NOW()
            """,
            (
                venue,
                instrument,
                timeframe,
                bucket,
                open_price,
                high_price,
                low_price,
                close_price,
                volume,
                quote_volume,
                len(rows_sorted),
                "trade-resampled",
            ),
        )


def _fetch_ohlcv_rows(venue: str, instrument: str, timeframe: str, limit: int) -> list[dict[str, Any]]:
    rows = fetch_all(
        """
        SELECT venue, instrument, timeframe, bucket_start, open, high, low, close, volume, quote_volume, trades_count, source
        FROM market_ohlcv
        WHERE venue = %s AND instrument = %s AND timeframe = %s
        ORDER BY bucket_start DESC
        LIMIT %s
        """,
        (venue, _normalize_instrument(instrument), timeframe, limit),
    )
    return list(reversed(rows))


def _sequence_ohlcv_rows(venue: str, instrument: str, timeframe: str, rows: list[dict[str, Any]]) -> list[int]:
    stream_key = _ohlcv_stream_key(venue, instrument, timeframe)
    state = OHLCV_STREAM_STATE.setdefault(stream_key, {"next_seq": 1, "bucket_seq": {}, "last_signature": ""})
    bucket_seq = state.setdefault("bucket_seq", {})
    next_seq = int(state.get("next_seq", 1) or 1)
    sequences: list[int] = []

    for row in rows:
        bucket_start = row.get("bucket_start")
        if isinstance(bucket_start, datetime):
            bucket_key = bucket_start.isoformat()
        else:
            bucket_key = str(bucket_start or "")
        seq = bucket_seq.get(bucket_key)
        if not isinstance(seq, int) or seq <= 0:
            seq = next_seq
            next_seq += 1
            bucket_seq[bucket_key] = seq
        sequences.append(seq)

    active_keys = {
        bucket_start.isoformat() if isinstance(bucket_start := row.get("bucket_start"), datetime) else str(bucket_start or "")
        for row in rows
    }
    state["bucket_seq"] = {
        key: value
        for key, value in bucket_seq.items()
        if key in active_keys
    }
    state["next_seq"] = next_seq
    return sequences


def _serialize_ohlcv_rows(rows: list[dict[str, Any]], venue: str, instrument: str, timeframe: str) -> list[dict[str, Any]]:
    sequences = _sequence_ohlcv_rows(venue, instrument, timeframe, rows)
    normalized: list[dict[str, Any]] = []
    for row, seq in zip(rows, sequences):
        bucket_start = row.get("bucket_start")
        if isinstance(bucket_start, datetime):
            bucket_start_iso = bucket_start.isoformat()
        else:
            bucket_start_iso = str(bucket_start or "")

        timeframe = str(row.get("timeframe") or "")
        open_price = _float(row.get("open"), 0.0)
        high_price = _float(row.get("high"), open_price)
        low_price = _float(row.get("low"), open_price)
        close_price = _float(row.get("close"), open_price)
        volume = _float(row.get("volume"), 0.0)
        quote_volume = _float(row.get("quote_volume"), 0.0)
        trades_count = int(_float(row.get("trades_count"), 0.0))

        normalized.append(
            {
                "venue": str(row.get("venue") or DEFAULT_VENUE),
                "instrument": _normalize_instrument(str(row.get("instrument") or "")),
                "timeframe": timeframe,
                "bucket_start": bucket_start_iso,
                "open": open_price,
                "high": high_price,
                "low": low_price,
                "close": close_price,
                "volume": volume,
                "quote_volume": quote_volume,
                "trades_count": trades_count,
                "source": str(row.get("source") or "trade-resampled"),
                "t": bucket_start_iso,
                "o": open_price,
                "h": high_price,
                "l": low_price,
                "c": close_price,
                "v": volume,
                "tf": timeframe,
                "seq": seq,
            }
        )
    return normalized


async def _broadcast_ohlcv_snapshot(venue: str, instrument: str, timeframe: str, limit: int = 500) -> None:
    stream_key = _ohlcv_stream_key(venue, instrument, timeframe)
    subscribers = OHLCV_SUBSCRIBERS.get(stream_key, set())
    if not subscribers:
        return

    rows = _serialize_ohlcv_rows(_fetch_ohlcv_rows(venue, instrument, timeframe, limit), venue, instrument, timeframe)
    state = OHLCV_STREAM_STATE.setdefault(stream_key, {"next_seq": 1, "bucket_seq": {}, "last_signature": ""})
    signature = hashlib.sha256(json_dumps(rows).encode("utf-8")).hexdigest()
    if signature == str(state.get("last_signature") or ""):
        return

    payload = {
        "type": "snapshot",
        "venue": venue,
        "instrument": _normalize_instrument(instrument),
        "timeframe": timeframe,
        "items": rows,
        "as_of": _now_utc().isoformat(),
    }
    stale: list[WebSocket] = []
    for socket in list(subscribers):
        try:
            await socket.send_json(payload)
        except Exception:
            stale.append(socket)
    for socket in stale:
        subscribers.discard(socket)

    state["last_signature"] = signature


def _cleanup_old_rows() -> None:
    if not HOUSEKEEPING_ENABLED:
        return
    execute("DELETE FROM market_trades WHERE traded_at < NOW() - INTERVAL '24 hours'")
    execute("DELETE FROM market_orderbook_snapshots WHERE snapshot_at < NOW() - INTERVAL '12 hours'")
    execute(
        """
        DELETE FROM market_ohlcv
        WHERE (timeframe IN ('1m', '5m', '15m') AND bucket_start < NOW() - INTERVAL '14 days')
           OR (timeframe = '1h' AND bucket_start < NOW() - INTERVAL '120 days')
           OR (timeframe = '1d' AND bucket_start < NOW() - INTERVAL '730 days')
        """
    )
    execute("DELETE FROM market_derivatives_metrics WHERE captured_at < NOW() - INTERVAL '14 days'")


def _has_recent_trades(venue: str, instrument: str, lookback_seconds: int = 90) -> bool:
    row = fetch_one(
        """
        SELECT COUNT(*) AS count
        FROM market_trades
        WHERE venue = %s
          AND instrument = %s
          AND traded_at >= NOW() - (%s || ' seconds')::interval
        """,
        (venue, _normalize_instrument(instrument), max(5, lookback_seconds)),
    ) or {"count": 0}
    return int(row.get("count") or 0) > 0


async def _sync_symbol(client: httpx.AsyncClient, instrument: str) -> None:
    symbol = _normalize_instrument(instrument)
    quote = await _fetch_binance_book_ticker(client, symbol)
    if quote:
        await _upsert_snapshot_async(quote)

    coinbase_quote = await _fetch_coinbase_ticker(client, symbol)
    if coinbase_quote:
        await _upsert_snapshot_async(coinbase_quote)

    okx_quote = await _fetch_okx_ticker(client, symbol)
    if okx_quote:
        await _upsert_snapshot_async(okx_quote)

    trades: list[dict[str, Any]] = []
    if not _has_recent_trades(DEFAULT_VENUE, symbol):
        trades = await _fetch_binance_trades(client, symbol, limit=200)
    if trades:
        await _store_trades_async(DEFAULT_VENUE, symbol, trades)
        await _broadcast_trades(DEFAULT_VENUE, symbol, trades)
        updated_timeframes: list[str] = []
        for timeframe in ("1m", "5m", "15m", "1h"):
            await _upsert_ohlcv_from_trades_async(DEFAULT_VENUE, symbol, trades, timeframe)
            updated_timeframes.append(timeframe)
        for timeframe in updated_timeframes:
            await _broadcast_ohlcv_snapshot(DEFAULT_VENUE, symbol, timeframe)

    await _sync_depth_snapshot(
        DEFAULT_VENUE,
        symbol,
        await _fetch_binance_depth_snapshot(client, symbol),
        reason="rest-sync",
        source="binance-depth-rest",
    )
    await _sync_depth_snapshot(
        "coinbase-public",
        symbol,
        await _fetch_coinbase_depth_snapshot(client, symbol),
        reason="rest-sync",
        source="coinbase-depth-rest",
    )
    await _sync_depth_snapshot(
        "okx-public",
        symbol,
        await _fetch_okx_depth_snapshot(client, symbol),
        reason="rest-sync",
        source="okx-depth-rest",
    )

    derivatives = await _fetch_binance_derivatives_metrics(client, symbol)
    if derivatives:
        DERIVATIVES_CACHE[_stream_key(DEFAULT_VENUE, symbol)] = derivatives
        await _store_derivatives_async(derivatives)


async def _sync_loop() -> None:
    while True:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                for instrument in _active_symbols():
                    await _sync_symbol(client, instrument)
            await _cleanup_old_rows_async()
        except Exception:
            pass
        await asyncio.sleep(SYNC_SECONDS)


async def _stream_depth_symbol(symbol: str) -> None:
    stream_url = f"wss://stream.binance.com:9443/ws/{symbol.lower()}@depth@100ms"
    key = _stream_key(DEFAULT_VENUE, symbol)

    while True:
        try:
            if key not in DEPTH_BOOKS:
                async with httpx.AsyncClient(timeout=8.0) as client:
                    snapshot = await _fetch_binance_depth_snapshot(client, symbol)
                await _sync_depth_snapshot(DEFAULT_VENUE, symbol, snapshot, reason="rest-seed", source="binance-depth-rest")

            async with websockets.connect(stream_url, ping_interval=20, ping_timeout=20) as socket:
                last_persist = _now_utc()
                while True:
                    raw_message = await socket.recv()
                    payload = json.loads(raw_message)
                    book = DEPTH_BOOKS.setdefault(
                        key,
                        {
                            "bids": {},
                            "asks": {},
                            "last_update_id": 0,
                            "event_time": int(_now_utc().timestamp() * 1000),
                        },
                    )
                    _apply_side_delta(book["bids"], payload.get("b", []))
                    _apply_side_delta(book["asks"], payload.get("a", []))
                    book["last_update_id"] = int(payload.get("u", book.get("last_update_id", 0)))
                    book["event_time"] = int(payload.get("E", int(_now_utc().timestamp() * 1000)))

                    await _broadcast_depth_delta(
                        DEFAULT_VENUE,
                        symbol,
                        {
                            "type": "delta",
                            "venue": DEFAULT_VENUE,
                            "instrument": symbol,
                            "update_id": book["last_update_id"],
                            "event_time": book["event_time"],
                            "bids": payload.get("b", []),
                            "asks": payload.get("a", []),
                        },
                    )

                    if (_now_utc() - last_persist).total_seconds() >= 4:
                        await _store_depth_async(_snapshot_from_book(DEFAULT_VENUE, symbol, book, "stream-delta", "binance-depth-stream"))
                        last_persist = _now_utc()
        except Exception:
            await asyncio.sleep(2)


async def _stream_coinbase_depth_symbol(symbol: str) -> None:
    product_id = _coinbase_product_id(symbol)
    if not product_id:
        return

    stream_url = "wss://ws-feed.exchange.coinbase.com"
    subscribe_payload = {
        "type": "subscribe",
        "product_ids": [product_id],
        "channels": ["level2"],
    }
    key = _stream_key("coinbase-public", symbol)

    while True:
        try:
            if key not in DEPTH_BOOKS:
                async with httpx.AsyncClient(timeout=8.0) as client:
                    snapshot = await _fetch_coinbase_depth_snapshot(client, symbol)
                await _sync_depth_snapshot("coinbase-public", symbol, snapshot, reason="rest-seed", source="coinbase-depth-rest")

            async with websockets.connect(stream_url, ping_interval=20, ping_timeout=20) as socket:
                await socket.send(json.dumps(subscribe_payload))
                last_persist = _now_utc()
                while True:
                    raw_message = await socket.recv()
                    payload = json.loads(raw_message)
                    message_type = str(payload.get("type") or "")
                    if str(payload.get("product_id") or product_id) != product_id:
                        continue
                    if message_type == "snapshot":
                        book = {
                            "bids": _depth_rows_to_map([[ _float(level[0]), _float(level[1])] for level in payload.get("bids", [])]),
                            "asks": _depth_rows_to_map([[ _float(level[0]), _float(level[1])] for level in payload.get("asks", [])]),
                            "last_update_id": int(_float(payload.get("sequence"), 0)),
                            "event_time": int(_now_utc().timestamp() * 1000),
                        }
                        DEPTH_BOOKS[key] = book
                        await _store_depth_async(_snapshot_from_book("coinbase-public", symbol, book, "stream-snapshot", "coinbase-depth-stream"))
                        continue
                    if message_type != "l2update":
                        continue
                    book = DEPTH_BOOKS.setdefault(
                        key,
                        {"bids": {}, "asks": {}, "last_update_id": 0, "event_time": int(_now_utc().timestamp() * 1000)},
                    )
                    changes = payload.get("changes", [])
                    bid_rows = _coinbase_changes_to_depth_rows(changes, "bid")
                    ask_rows = _coinbase_changes_to_depth_rows(changes, "ask")
                    _apply_side_delta(book["bids"], bid_rows)
                    _apply_side_delta(book["asks"], ask_rows)
                    book["last_update_id"] = int(_float(payload.get("sequence"), book.get("last_update_id", 0)))
                    event_time = _parse_iso_timestamp(payload.get("time"))
                    book["event_time"] = int((event_time or _now_utc()).timestamp() * 1000)

                    await _broadcast_depth_delta(
                        "coinbase-public",
                        symbol,
                        {
                            "type": "delta",
                            "venue": "coinbase-public",
                            "instrument": symbol,
                            "update_id": book["last_update_id"],
                            "event_time": book["event_time"],
                            "bids": bid_rows,
                            "asks": ask_rows,
                        },
                    )

                    if (_now_utc() - last_persist).total_seconds() >= 4:
                        await _store_depth_async(_snapshot_from_book("coinbase-public", symbol, book, "stream-delta", "coinbase-depth-stream"))
                        last_persist = _now_utc()
        except Exception:
            await asyncio.sleep(2)


async def _stream_okx_depth_symbol(symbol: str) -> None:
    inst_id = _okx_inst_id(symbol)
    if not inst_id:
        return

    stream_url = "wss://ws.okx.com:8443/ws/v5/public"
    subscribe_payload = {"op": "subscribe", "args": [{"channel": "books5", "instId": inst_id}]}
    key = _stream_key("okx-public", symbol)

    while True:
        try:
            if key not in DEPTH_BOOKS:
                async with httpx.AsyncClient(timeout=8.0) as client:
                    snapshot = await _fetch_okx_depth_snapshot(client, symbol)
                await _sync_depth_snapshot("okx-public", symbol, snapshot, reason="rest-seed", source="okx-depth-rest")

            async with websockets.connect(stream_url, ping_interval=20, ping_timeout=20) as socket:
                await socket.send(json.dumps(subscribe_payload))
                last_persist = _now_utc()
                while True:
                    raw_message = await socket.recv()
                    payload = json.loads(raw_message)
                    arg = payload.get("arg") if isinstance(payload, dict) else None
                    if not isinstance(arg, dict) or str(arg.get("instId") or "") != inst_id:
                        continue
                    rows = payload.get("data") if isinstance(payload, dict) else None
                    if not isinstance(rows, list) or not rows:
                        continue
                    book_payload = rows[0]
                    if not isinstance(book_payload, dict):
                        continue
                    bids = [[_float(level[0]), _float(level[1])] for level in book_payload.get("bids", [])]
                    asks = [[_float(level[0]), _float(level[1])] for level in book_payload.get("asks", [])]
                    event_time = int(_float(book_payload.get("ts"), int(_now_utc().timestamp() * 1000)))
                    book = {
                        "bids": _depth_rows_to_map(bids),
                        "asks": _depth_rows_to_map(asks),
                        "last_update_id": int(_float(book_payload.get("seqId"), event_time)),
                        "event_time": event_time,
                    }
                    DEPTH_BOOKS[key] = book

                    await _broadcast_depth_delta(
                        "okx-public",
                        symbol,
                        {
                            "type": "delta",
                            "venue": "okx-public",
                            "instrument": symbol,
                            "update_id": book["last_update_id"],
                            "event_time": book["event_time"],
                            "bids": [[str(level[0]), str(level[1])] for level in bids],
                            "asks": [[str(level[0]), str(level[1])] for level in asks],
                        },
                    )

                    if (_now_utc() - last_persist).total_seconds() >= 4:
                        await _store_depth_async(_snapshot_from_book("okx-public", symbol, book, "stream-delta", "okx-depth-stream"))
                        last_persist = _now_utc()
        except Exception:
            await asyncio.sleep(2)


async def _stream_binance_trades_symbol(symbol: str) -> None:
    stream_url = f"wss://stream.binance.com:9443/ws/{symbol.lower()}@trade"

    while True:
        try:
            async with websockets.connect(stream_url, ping_interval=20, ping_timeout=20) as socket:
                pending_trades: list[dict[str, Any]] = []
                last_flush = _now_utc()
                while True:
                    raw_message = await socket.recv()
                    payload = json.loads(raw_message)
                    traded_at = datetime.fromtimestamp(int(_float(payload.get("T"), 0)) / 1000, tz=timezone.utc)
                    trade = {
                        "trade_id": str(payload.get("t") or ""),
                        "price": _float(payload.get("p"), 0.0),
                        "size": _float(payload.get("q"), 0.0),
                        "side": "sell" if bool(payload.get("m")) else "buy",
                        "traded_at": traded_at,
                        "payload": payload,
                    }
                    if trade["price"] <= 0 or trade["size"] <= 0:
                        continue
                    pending_trades.append(trade)
                    now = _now_utc()
                    should_flush = len(pending_trades) >= 24 or (now - last_flush).total_seconds() >= 1
                    if not should_flush:
                        continue
                    batch = pending_trades
                    pending_trades = []
                    await _store_trades_async(DEFAULT_VENUE, symbol, batch)
                    for timeframe in ("1m", "5m", "15m", "1h"):
                        await _upsert_ohlcv_from_trades_async(DEFAULT_VENUE, symbol, batch, timeframe)
                    await _broadcast_trades(DEFAULT_VENUE, symbol, batch)
                    last_flush = now
        except Exception:
            await asyncio.sleep(2)


def _extract_coinbase_trades(message: dict[str, Any], instrument: str) -> list[dict[str, Any]]:
    product_id = _coinbase_product_id(instrument)
    if not product_id:
        return []

    items: list[dict[str, Any]] = []
    events = message.get("events")
    if isinstance(events, list):
        for event in events:
            if not isinstance(event, dict):
                continue
            trades = event.get("trades")
            if not isinstance(trades, list):
                continue
            for trade in trades:
                if not isinstance(trade, dict):
                    continue
                if str(trade.get("product_id") or product_id) != product_id:
                    continue
                traded_at = _parse_iso_timestamp(trade.get("time"))
                if traded_at is None:
                    continue
                items.append(
                    {
                        "trade_id": str(trade.get("trade_id") or trade.get("trade_id_hash") or ""),
                        "price": _float(trade.get("price"), 0.0),
                        "size": _float(trade.get("size"), 0.0),
                        "side": str(trade.get("side") or "").lower(),
                        "traded_at": traded_at,
                        "payload": trade,
                    }
                )

    direct_trades = message.get("trades")
    if isinstance(direct_trades, list):
        for trade in direct_trades:
            if not isinstance(trade, dict):
                continue
            if str(trade.get("product_id") or product_id) != product_id:
                continue
            traded_at = _parse_iso_timestamp(trade.get("time"))
            if traded_at is None:
                continue
            items.append(
                {
                    "trade_id": str(trade.get("trade_id") or ""),
                    "price": _float(trade.get("price"), 0.0),
                    "size": _float(trade.get("size"), 0.0),
                    "side": str(trade.get("side") or "").lower(),
                    "traded_at": traded_at,
                    "payload": trade,
                }
            )

    deduped: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in items:
        signature = _trade_cache_signature("coinbase-public", instrument, item)
        if signature in seen:
            continue
        seen.add(signature)
        if item["price"] <= 0 or item["size"] <= 0:
            continue
        deduped.append(item)
    return deduped


async def _stream_coinbase_trades_symbol(symbol: str) -> None:
    product_id = _coinbase_product_id(symbol)
    if not product_id:
        return

    stream_url = "wss://advanced-trade-ws.coinbase.com"
    subscribe_payload = {
        "type": "subscribe",
        "channel": "market_trades",
        "product_ids": [product_id],
    }

    while True:
        try:
            async with websockets.connect(stream_url, ping_interval=20, ping_timeout=20) as socket:
                await socket.send(json.dumps(subscribe_payload))
                pending_trades: list[dict[str, Any]] = []
                last_flush = _now_utc()
                while True:
                    raw_message = await socket.recv()
                    payload = json.loads(raw_message)
                    trades = _extract_coinbase_trades(payload, symbol)
                    if not trades:
                        continue
                    pending_trades.extend(trades)
                    now = _now_utc()
                    should_flush = len(pending_trades) >= 24 or (now - last_flush).total_seconds() >= 1
                    if not should_flush:
                        continue
                    batch = pending_trades
                    pending_trades = []
                    await _store_trades_async("coinbase-public", symbol, batch)
                    for timeframe in ("1m", "5m", "15m", "1h"):
                        await _upsert_ohlcv_from_trades_async("coinbase-public", symbol, batch, timeframe)
                    await _broadcast_trades("coinbase-public", symbol, batch)
                    last_flush = now
        except Exception:
            await asyncio.sleep(2)


def _extract_okx_trades(message: dict[str, Any], instrument: str) -> list[dict[str, Any]]:
    inst_id = _okx_inst_id(instrument)
    arg = message.get("arg") if isinstance(message, dict) else None
    if not inst_id or not isinstance(arg, dict) or str(arg.get("instId") or "") != inst_id:
        return []
    rows = message.get("data") if isinstance(message, dict) else None
    if not isinstance(rows, list):
        return []
    trades: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        traded_ms = int(_float(row.get("ts"), 0))
        traded_at = datetime.fromtimestamp(traded_ms / 1000, tz=timezone.utc) if traded_ms > 0 else None
        if traded_at is None:
            continue
        price = _float(row.get("px"), 0.0)
        size = _float(row.get("sz"), 0.0)
        if price <= 0 or size <= 0:
            continue
        trades.append(
            {
                "trade_id": str(row.get("tradeId") or traded_ms),
                "price": price,
                "size": size,
                "side": str(row.get("side") or "").lower(),
                "traded_at": traded_at,
                "payload": row,
            }
        )
    return trades


async def _stream_okx_trades_symbol(symbol: str) -> None:
    inst_id = _okx_inst_id(symbol)
    if not inst_id:
        return

    stream_url = "wss://ws.okx.com:8443/ws/v5/public"
    subscribe_payload = {
        "op": "subscribe",
        "args": [{"channel": "trades", "instId": inst_id}],
    }

    while True:
        try:
            async with websockets.connect(stream_url, ping_interval=20, ping_timeout=20) as socket:
                await socket.send(json.dumps(subscribe_payload))
                pending_trades: list[dict[str, Any]] = []
                last_flush = _now_utc()
                while True:
                    raw_message = await socket.recv()
                    payload = json.loads(raw_message)
                    trades = _extract_okx_trades(payload, symbol)
                    if not trades:
                        continue
                    pending_trades.extend(trades)
                    now = _now_utc()
                    should_flush = len(pending_trades) >= 24 or (now - last_flush).total_seconds() >= 1
                    if not should_flush:
                        continue
                    batch = pending_trades
                    pending_trades = []
                    await _store_trades_async("okx-public", symbol, batch)
                    for timeframe in ("1m", "5m", "15m", "1h"):
                        await _upsert_ohlcv_from_trades_async("okx-public", symbol, batch, timeframe)
                    await _broadcast_trades("okx-public", symbol, batch)
                    last_flush = now
        except Exception:
            await asyncio.sleep(2)


@app.on_event("startup")
async def startup() -> None:
    ensure_schema()
    _start_liveness_server()
    for _, snapshot in SNAPSHOTS.items():
        await _upsert_snapshot_async(snapshot)
    if CFD_AUTO_SEED_ENABLED and CFD_WRITE_ENABLED:
        for instrument in DEFAULT_CFD_SEED_SYMBOLS:
            try:
                result = await _backfill_cfd_symbol(instrument)
                if result.get("status") != "ok":
                    LOGGER.warning("CFD auto-seed incomplete for %s: %s", instrument, result)
            except Exception as exc:
                LOGGER.warning("CFD auto-seed failed for %s: %s", instrument, exc)
    elif CFD_AUTO_SEED_ENABLED:
        LOGGER.info("CFD auto-seed skipped on non-writer instance shard=%s/%s", MARKET_SHARD_INDEX, MARKET_SHARD_TOTAL)
    asyncio.create_task(_sync_loop())
    for symbol in _active_symbols():
        asyncio.create_task(_stream_binance_trades_symbol(symbol))
        asyncio.create_task(_stream_coinbase_trades_symbol(symbol))
        asyncio.create_task(_stream_okx_trades_symbol(symbol))
    if DEPTH_STREAM_ENABLED:
        for symbol in _active_symbols():
            asyncio.create_task(_stream_depth_symbol(symbol))
            asyncio.create_task(_stream_coinbase_depth_symbol(symbol))
            asyncio.create_task(_stream_okx_depth_symbol(symbol))


@app.get("/health")
async def health() -> dict:
    symbols = fetch_one("SELECT COUNT(*) AS count FROM market_snapshots") or {"count": 0}
    return {
        "status": "ok",
        "service": "market-data-plane",
        "snapshots": symbols["count"],
        "symbols": DEFAULT_SYMBOLS,
        "active_symbols": _active_symbols(),
        "supported_venues": SUPPORTED_VENUES,
        "shard": {"index": MARKET_SHARD_INDEX, "total": MARKET_SHARD_TOTAL},
        "writer": {
            "primary": MARKET_PRIMARY_WRITER,
            "cfd_write_enabled": CFD_WRITE_ENABLED,
            "housekeeping_enabled": HOUSEKEEPING_ENABLED,
        },
        "goldapi": {
            "enabled": GOLDAPI_ENABLED,
            "history_days": GOLDAPI_HISTORY_DAYS,
            "max_calls_per_run": GOLDAPI_MAX_CALLS_PER_RUN,
        },
        "twelvedata": {
            "enabled": TWELVEDATA_ENABLED,
            "history_days": TWELVEDATA_HISTORY_DAYS,
        },
        "metalsapi": {
            "enabled": METALSAPI_ENABLED,
            "history_days": METALSAPI_HISTORY_DAYS,
            "max_calls_per_run": METALSAPI_MAX_CALLS_PER_RUN,
        },
        "depth_stream_enabled": DEPTH_STREAM_ENABLED,
        "depth_books": len(DEPTH_BOOKS),
        "uptime_sec": max(0, int((_now_utc() - APP_STARTED_AT).total_seconds())),
    }


@app.get("/healthz")
async def healthz() -> dict:
    return {
        "status": "ok",
        "service": "market-data-plane",
        "uptime_sec": max(0, int((_now_utc() - APP_STARTED_AT).total_seconds())),
    }


@app.post("/internal/backfill/cfd")
async def internal_backfill_cfd(payload: dict | None = None) -> dict[str, Any]:
    body = payload if isinstance(payload, dict) else {}
    raw_symbols = body.get("symbols")
    venue = str(body.get("venue") or "auto-cfd").strip() or "auto-cfd"
    if isinstance(raw_symbols, list):
        symbols = [str(item).strip().upper() for item in raw_symbols if str(item).strip()]
    elif isinstance(raw_symbols, str):
        symbols = [part.strip().upper() for part in raw_symbols.split(",") if part.strip()]
    else:
        symbols = DEFAULT_CFD_SEED_SYMBOLS
    if not symbols:
        raise HTTPException(status_code=400, detail="At least one CFD symbol is required")
    results: list[dict[str, Any]] = []
    successful = 0
    for symbol in symbols:
        result = await _backfill_cfd_symbol(symbol, venue=venue)
        results.append(result)
        if result.get("status") in {"ok", "partial"}:
            successful += 1
        resolved_venues = result.get("resolved_venues") if isinstance(result.get("resolved_venues"), dict) else {}
        for timeframe in ("1h", "1d"):
            resolved_venue = str(resolved_venues.get(timeframe) or venue)
            if int((result.get("timeframes") or {}).get(timeframe, 0)) > 0:
                await _broadcast_ohlcv_snapshot(resolved_venue, symbol, timeframe)
    overall_status = "ok" if successful == len(results) else ("partial" if successful > 0 else "unavailable")
    return {"status": overall_status, "results": results, "count": len(results), "successful": successful}


@app.get("/v1/market/venues")
async def market_venues() -> dict:
    return {
        "status": "ok",
        "primary": DEFAULT_VENUE,
        "supported_venues": SUPPORTED_VENUES,
    }


@app.get("/v1/quotes")
async def quotes() -> list[dict]:
    return fetch_all("SELECT venue, instrument, bid, ask, last, spread_bps, updated_at FROM market_snapshots ORDER BY venue, instrument")


@app.get("/v1/market/ohlcv")
async def market_ohlcv(
    instrument: str = Query(...),
    venue: str = Query(DEFAULT_VENUE),
    timeframe: str = Query("1m"),
    limit: int = Query(200, ge=1, le=1000),
) -> list[dict]:
    market_symbol = _market_symbol_for_venue(venue, instrument)
    rows = _fetch_ohlcv_rows(venue, market_symbol, timeframe, limit)
    return _serialize_ohlcv_rows(rows, venue, market_symbol, timeframe)


@app.get("/v1/market/trades")
async def market_trades(
    instrument: str = Query(...),
    venue: str = Query(DEFAULT_VENUE),
    limit: int = Query(200, ge=1, le=500),
) -> list[dict]:
    market_symbol = _market_symbol_for_venue(venue, instrument)
    return fetch_all(
        """
        SELECT venue, instrument, trade_id, side, price, size, traded_at, payload
        FROM market_trades
        WHERE venue = %s AND instrument = %s
        ORDER BY traded_at DESC
        LIMIT %s
        """,
        (venue, market_symbol, limit),
    )


@app.get("/v1/market/orderbook/depth")
async def market_depth(
    instrument: str = Query(...),
    venue: str = Query(DEFAULT_VENUE),
) -> dict:
    symbol = _market_symbol_for_venue(venue, instrument)
    key = _stream_key(venue, symbol)

    book = DEPTH_BOOKS.get(key)
    if book:
        snapshot = _snapshot_from_book(venue, symbol, book, "in-memory", f"{venue}-depth-memory")
        return {
            "venue": snapshot["venue"],
            "instrument": snapshot["instrument"],
            "snapshot_at": snapshot["snapshot_at"],
            "best_bid": snapshot["best_bid"],
            "best_ask": snapshot["best_ask"],
            "spread_bps": snapshot["spread_bps"],
            "depth_payload": snapshot["depth"],
            "source": snapshot["source"],
        }

    row = fetch_one(
        """
        SELECT venue, instrument, snapshot_at, best_bid, best_ask, spread_bps, depth_payload, source
        FROM market_orderbook_snapshots
        WHERE venue = %s AND instrument = %s
        ORDER BY snapshot_at DESC
        LIMIT 1
        """,
        (venue, symbol),
    )
    if row:
        return row

    quote = fetch_one(
        """
        SELECT venue, instrument, bid AS best_bid, ask AS best_ask, spread_bps
        FROM market_snapshots
        WHERE venue = %s AND instrument = %s
        """,
        (venue, symbol),
    )
    if not quote:
        return {"venue": venue, "instrument": symbol, "status": "unknown", "depth_payload": {"bids": [], "asks": []}}

    return {
        "venue": quote["venue"],
        "instrument": quote["instrument"],
        "snapshot_at": _now_utc(),
        "best_bid": quote["best_bid"],
        "best_ask": quote["best_ask"],
        "spread_bps": quote["spread_bps"],
        "depth_payload": {"bids": [[quote["best_bid"], 1.0]], "asks": [[quote["best_ask"], 1.0]]},
        "source": "quote-fallback",
    }


@app.websocket("/ws/v1/market/orderbook/depth/{instrument}")
async def ws_market_depth(websocket: WebSocket, instrument: str, venue: str = DEFAULT_VENUE) -> None:
    symbol = _market_symbol_for_venue(venue, instrument)
    key = _stream_key(venue, symbol)
    await websocket.accept()
    DEPTH_SUBSCRIBERS.setdefault(key, set()).add(websocket)

    initial = await market_depth(instrument=symbol, venue=venue)
    snapshot_at = initial.get("snapshot_at") if isinstance(initial, dict) else None
    if isinstance(snapshot_at, datetime):
        initial["snapshot_at"] = snapshot_at.isoformat()
    await websocket.send_json({"type": "snapshot", **initial})

    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        DEPTH_SUBSCRIBERS.get(key, set()).discard(websocket)


@app.websocket("/ws/v1/market/ohlcv/{instrument}")
async def ws_market_ohlcv(
    websocket: WebSocket,
    instrument: str,
    venue: str = DEFAULT_VENUE,
    timeframe: str = "1m",
    limit: int = 500,
) -> None:
    symbol = _market_symbol_for_venue(venue, instrument)
    safe_limit = max(50, min(limit, 1000))
    stream_key = _ohlcv_stream_key(venue, symbol, timeframe)
    await websocket.accept()
    OHLCV_SUBSCRIBERS.setdefault(stream_key, set()).add(websocket)

    rows = _serialize_ohlcv_rows(_fetch_ohlcv_rows(venue, symbol, timeframe, safe_limit), venue, symbol, timeframe)
    state = OHLCV_STREAM_STATE.setdefault(stream_key, {"next_seq": 1, "bucket_seq": {}, "last_signature": ""})
    state["last_signature"] = hashlib.sha256(json_dumps(rows).encode("utf-8")).hexdigest()
    await websocket.send_json(
        {
            "type": "snapshot",
            "venue": venue,
            "instrument": symbol,
            "timeframe": timeframe,
            "items": rows,
            "as_of": _now_utc().isoformat(),
        }
    )

    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        OHLCV_SUBSCRIBERS.get(stream_key, set()).discard(websocket)


@app.websocket("/ws/v1/market/trades/{instrument}")
async def ws_market_trades(
    websocket: WebSocket,
    instrument: str,
    venue: str = DEFAULT_VENUE,
    limit: int = 200,
) -> None:
    symbol = _market_symbol_for_venue(venue, instrument)
    safe_limit = max(20, min(limit, 500))
    stream_key = _trade_stream_key(venue, symbol)
    await websocket.accept()
    TRADE_SUBSCRIBERS.setdefault(stream_key, set()).add(websocket)

    rows = fetch_all(
        """
        SELECT venue, instrument, trade_id, side, price, size, traded_at, payload
        FROM market_trades
        WHERE venue = %s AND instrument = %s
        ORDER BY traded_at DESC
        LIMIT %s
        """,
        (venue, symbol, safe_limit),
    )
    serialized = [_serialize_trade(venue, symbol, row) for row in reversed(rows)]
    await websocket.send_json(
        {
            "type": "snapshot",
            "venue": venue,
            "instrument": symbol,
            "items": serialized,
            "as_of": _now_utc().isoformat(),
        }
    )

    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        TRADE_SUBSCRIBERS.get(stream_key, set()).discard(websocket)


@app.get("/v1/market/microstructure")
async def market_microstructure(
    instrument: str = Query(...),
    venue: str = Query(DEFAULT_VENUE),
    lookback_minutes: int = Query(60, ge=5, le=720),
) -> dict:
    symbol = _market_symbol_for_venue(venue, instrument)
    depth = await market_depth(instrument=symbol, venue=venue)
    trades = fetch_all(
        """
        SELECT side, price, size, traded_at
        FROM market_trades
        WHERE venue = %s AND instrument = %s
          AND traded_at >= NOW() - (%s || ' minutes')::interval
        ORDER BY traded_at DESC
        LIMIT 500
        """,
        (venue, symbol, lookback_minutes),
    )

    buy_volume = sum(_float(row.get("size")) for row in trades if str(row.get("side", "")).lower() == "buy")
    sell_volume = sum(_float(row.get("size")) for row in trades if str(row.get("side", "")).lower() == "sell")
    trade_count = len(trades)
    imbalance = (buy_volume - sell_volume) / max(buy_volume + sell_volume, 1e-9)

    bids = depth.get("depth_payload", {}).get("bids", []) if isinstance(depth, dict) else []
    asks = depth.get("depth_payload", {}).get("asks", []) if isinstance(depth, dict) else []
    bid_depth = sum(_float(level[1]) for level in bids[:10]) if isinstance(bids, list) else 0.0
    ask_depth = sum(_float(level[1]) for level in asks[:10]) if isinstance(asks, list) else 0.0
    depth_imbalance = (bid_depth - ask_depth) / max(bid_depth + ask_depth, 1e-9)

    spread_bps = _float(depth.get("spread_bps"), 0.0) if isinstance(depth, dict) else 0.0
    derivatives = DERIVATIVES_CACHE.get(_stream_key(venue, symbol))
    if not derivatives:
        derivatives = fetch_one(
            """
            SELECT funding_rate, open_interest, mark_price, next_funding_time, captured_at
            FROM market_derivatives_metrics
            WHERE venue = %s AND instrument = %s
            ORDER BY captured_at DESC
            LIMIT 1
            """,
            (venue, symbol),
        )

    return {
        "venue": venue,
        "instrument": symbol,
        "spread_bps": spread_bps,
        "trade_count": trade_count,
        "buy_volume": buy_volume,
        "sell_volume": sell_volume,
        "tape_acceleration": (buy_volume + sell_volume) / max(lookback_minutes, 1),
        "depth_imbalance": depth_imbalance,
        "volume_imbalance": imbalance,
        "depth_top10": {"bid": bid_depth, "ask": ask_depth},
        "funding_rate": _float((derivatives or {}).get("funding_rate"), 0.0),
        "open_interest": _float((derivatives or {}).get("open_interest"), 0.0),
        "mark_price": _float((derivatives or {}).get("mark_price"), 0.0),
        "next_funding_time": (derivatives or {}).get("next_funding_time"),
        "as_of": _now_utc().isoformat(),
    }


@app.get("/v1/market/session-state")
async def market_session_state(instrument: str = Query("BTCUSDT")) -> dict:
    symbol = _normalize_instrument(instrument)
    now = _now_utc()
    return {
        "instrument": symbol,
        "session": _session_label(now),
        "as_of": now.isoformat(),
        "next_session_change_at": (now.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)).isoformat(),
    }
