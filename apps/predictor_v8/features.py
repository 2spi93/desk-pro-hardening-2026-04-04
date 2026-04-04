from __future__ import annotations

from typing import Any

FEATURE_KEYS = [
    "spread",
    "imbalance",
    "latency",
    "slippage",
    "depth",
    "volume",
    "volatility",
    "arb_signal",
    "fill_prob",
    "momentum",
    "micro_burst",
    "quote_fade",
    "book_flip",
    "backlog_pressure",
    "render_pressure",
]


def to_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except Exception:
        return default


def clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))
    
def _parse_depth_rows(value: Any) -> list[tuple[float, float]]:
    if not isinstance(value, list):
        return []
    rows: list[tuple[float, float]] = []
    for item in value:
        if not isinstance(item, list | tuple) or len(item) < 2:
            continue
        price = to_float(item[0], 0.0)
        size = to_float(item[1], 0.0)
        if price > 0.0 and size > 0.0:
            rows.append((price, size))
    return rows

def _sum_notional(rows: list[tuple[float, float]], limit: int) -> float:
    return sum(price * size for price, size in rows[:limit])

def derive_orderbook_signals(ctx: dict[str, Any]) -> tuple[float, float]:
    bids = _parse_depth_rows(ctx.get("orderbook_bids"))
    asks = _parse_depth_rows(ctx.get("orderbook_asks"))
    if not bids or not asks:
        return (
            clamp(to_float(ctx.get("quote_fade_rate"), 0.0), 0.0, 3.0),
            clamp(to_float(ctx.get("book_flip_signal"), 0.0), -1.0, 1.0),
        )

    top3_bid = _sum_notional(bids, 3)
    top3_ask = _sum_notional(asks, 3)
    top10_bid = _sum_notional(bids, 10)
    top10_ask = _sum_notional(asks, 10)
    total_top3 = top3_bid + top3_ask
    total_top10 = top10_bid + top10_ask
    touch_density = total_top3 / max(total_top10, 1e-9)
    quote_fade = clamp((1.0 - touch_density) * 3.0, 0.0, 3.0)

    top3_imbalance = (top3_bid - top3_ask) / max(total_top3, 1e-9)
    top10_imbalance = (top10_bid - top10_ask) / max(total_top10, 1e-9)
    book_flip = clamp(top3_imbalance - top10_imbalance, -1.0, 1.0)
    return quote_fade, book_flip


def build_features(ctx: dict[str, Any], horizon_ms: int) -> list[float]:
    latency_ms = to_float(ctx.get("latency_ms"), 0.0)
    spread_bps = to_float(ctx.get("spread_bps"), 0.0)
    arb_edge = to_float(ctx.get("arb_edge_bps"), 0.0)
    slippage_bps = abs(to_float(ctx.get("slippage_bps"), 0.0))
    depth = to_float(ctx.get("available_depth_usd"), 0.0)
    volume = to_float(ctx.get("volume_30s"), 0.0)
    volatility = to_float(ctx.get("volatility_bps"), 0.0)
    fill_prob = clamp(to_float(ctx.get("fill_probability"), 0.0), 0.0, 1.0)
    imbalance = clamp(to_float(ctx.get("depth_imbalance"), 0.0), -1.5, 1.5)
    momentum = clamp(to_float(ctx.get("cvd_delta"), 0.0) / 5000.0, -2.0, 2.0)
    micro_burst = clamp(to_float(ctx.get("micro_burst_10ms"), 0.0) / 8.0, 0.0, 3.0)
    quote_fade, book_flip = derive_orderbook_signals(ctx)
    backlog_pressure = clamp(to_float(ctx.get("backlog_pressure"), 0.0), 0.0, 4.0)
    render_pressure = clamp(to_float(ctx.get("render_pressure"), 0.0), 0.0, 4.0)

    return [
        clamp(spread_bps / 12.0, -3.0, 3.0),
        imbalance,
        clamp(latency_ms / 120.0, 0.0, 5.0),
        clamp(slippage_bps / 8.0, 0.0, 4.0),
        clamp(depth / 200000.0, 0.0, 4.0),
        clamp(volume / 1000000.0, 0.0, 4.0),
        clamp(volatility / 15.0, 0.0, 4.0),
        clamp(arb_edge / 10.0, -4.0, 4.0),
        fill_prob * 2.0 - 1.0,
        momentum,
        micro_burst,
        quote_fade,
        book_flip,
        backlog_pressure,
        clamp(render_pressure + max(0.0, horizon_ms - 20.0) / 80.0, 0.0, 4.0),
    ]
