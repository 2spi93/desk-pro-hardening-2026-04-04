from __future__ import annotations

from typing import Any


CONTRACT_VERSION = "txt.market-bus-snapshot.v1"


def build_market_bus_snapshot_contract(
    *,
    instrument: str,
    venue: str,
    timeframe: str,
    trades: list[Any],
    ohlcv_rows: list[Any],
    depth_snapshot: dict[str, Any] | None,
    microstructure: dict[str, Any] | None,
    session_state: dict[str, Any] | None,
    orderbook: dict[str, Any] | None,
    routing_score: dict[str, Any] | None,
    health: dict[str, Any],
    sequencing: dict[str, Any],
    trade_preprocessor: dict[str, Any],
    observed_at: str,
) -> dict[str, Any]:
    """Serialize computed market state without fabricating missing values."""

    trade_health = (health.get("components") or {}).get("trades") or {}
    return {
        "contract_version": CONTRACT_VERSION,
        "instrument": instrument,
        "symbol": instrument,
        "venue": venue,
        "timeframe": timeframe,
        "ohlcv_rows": ohlcv_rows,
        "depth_snapshot": depth_snapshot,
        "trades": trades,
        "trade_state": {
            "count": len(trades),
            "status": trade_health.get("status"),
            "freshness_ms": trade_health.get("freshness_ms"),
        },
        "microstructure": microstructure,
        "session_state": session_state,
        "orderbook": orderbook,
        "routing_score": routing_score,
        "observation": {
            "observed_at": observed_at,
            "source": "control-plane-market-bus",
            "freshness": health.get("components") or {},
        },
        "meta": {
            "health": health,
            "sequencing": sequencing,
            "preprocessor": {"trades": trade_preprocessor},
        },
        "as_of": observed_at,
    }
