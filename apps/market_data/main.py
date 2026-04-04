from __future__ import annotations

from fastapi import FastAPI

from shared.db import ensure_schema, execute, fetch_all, json_dumps

app = FastAPI(title="Market Data", version="0.1.0")

SNAPSHOTS = {
    "paper-bitget:BTCUSDT-PERP": {"venue": "paper-bitget", "instrument": "BTCUSDT-PERP", "bid": 68245.5, "ask": 68250.1, "last": 68247.8, "spread_bps": 0.67},
    "paper-coinbase:ETHUSDT-PERP": {"venue": "paper-coinbase", "instrument": "ETHUSDT-PERP", "bid": 3520.2, "ask": 3521.0, "last": 3520.5, "spread_bps": 2.27},
    "paper-polymarket:BTC-UP-THIS-WEEK": {"venue": "paper-polymarket", "instrument": "BTC-UP-THIS-WEEK", "bid": 0.57, "ask": 0.58, "last": 0.575, "spread_bps": 173.91}
}


@app.on_event("startup")
async def startup() -> None:
    ensure_schema()
    for key, snapshot in SNAPSHOTS.items():
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
            (key, snapshot["venue"], snapshot["instrument"], snapshot["bid"], snapshot["ask"], snapshot["last"], snapshot["spread_bps"], json_dumps(snapshot)),
        )


@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "service": "market-data", "snapshots": len(SNAPSHOTS)}


@app.get("/v1/quotes")
async def quotes() -> list[dict]:
    return fetch_all("SELECT venue, instrument, bid, ask, last, spread_bps, updated_at FROM market_snapshots ORDER BY venue, instrument")
