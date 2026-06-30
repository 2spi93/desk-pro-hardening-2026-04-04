#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


OPPORTUNITY_SCHEMA_VERSION = "txt.strategy-opportunity.v1"
SNAPSHOT_SCHEMA_VERSION = "txt.strategy-market-snapshot.v1"
DEFAULT_OUT_DIR = Path("/opt/txt/var/proof_renewal")

TAKER_FEE_BPS = 5.0
DEFAULT_ROUND_TRIP_TAKER_FEES_BPS = 10.0
DEFAULT_UNCERTAINTY_BUFFER_BPS = 3.0
MIN_LCB_BPS = 0.5
MIN_CONFIDENCE = 0.55
MAX_SPREAD_BPS = 4.0
MAX_SLIPPAGE_BPS = 8.0


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


def to_floats(values: Any) -> list[float]:
    if not isinstance(values, list):
        return []
    out: list[float] = []
    for value in values:
        numeric = to_float(value, float("nan"))
        if numeric == numeric and numeric > 0:
            out.append(numeric)
    return out


def pct_bps(new: float, old: float) -> float:
    if old <= 0:
        return 0.0
    return ((new / old) - 1.0) * 10000.0


def mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def stdev(values: list[float]) -> float:
    if len(values) < 2:
        return 0.0
    avg = mean(values)
    return math.sqrt(sum((value - avg) ** 2 for value in values) / (len(values) - 1))


def ema(values: list[float], span: int) -> float:
    if not values:
        return 0.0
    alpha = 2.0 / (span + 1.0)
    current = values[0]
    for value in values[1:]:
        current = alpha * value + (1.0 - alpha) * current
    return current


def returns_bps(closes: list[float]) -> list[float]:
    return [pct_bps(closes[index], closes[index - 1]) for index in range(1, len(closes))]


def direction_ratio(rets: list[float]) -> float:
    gross = sum(abs(value) for value in rets)
    return abs(sum(rets)) / gross if gross > 0 else 0.0


def classify_regime(closes: list[float], volumes: list[float]) -> dict[str, Any]:
    rets = returns_bps(closes)
    if len(closes) < 30 or len(rets) < 20:
        return {"market_regime": "INSUFFICIENT_DATA", "confidence": 0.0, "reason": "not_enough_bars"}
    vol_bps = stdev(rets[-30:])
    direct = direction_ratio(rets[-30:])
    fast_slope_bps = pct_bps(ema(closes[-12:], 6), ema(closes[-24:], 12))
    medium_slope_bps = pct_bps(ema(closes[-24:], 12), ema(closes[-48:], 24)) if len(closes) >= 48 else fast_slope_bps
    recent_range_bps = pct_bps(max(closes[-20:]), min(closes[-20:]))
    volume_ratio = 1.0
    if len(volumes) >= 40 and mean(volumes[-40:-10]) > 0:
        volume_ratio = mean(volumes[-10:]) / mean(volumes[-40:-10])

    if vol_bps >= 45.0 and direct < 0.45:
        regime = "CHAOTIC"
        confidence = min(1.0, 0.45 + vol_bps / 120.0)
    elif recent_range_bps < max(20.0, vol_bps * 1.2) and volume_ratio < 1.25:
        regime = "RANGE"
        confidence = min(1.0, 0.5 + (1.0 - min(1.0, direct)) * 0.4)
    elif abs(fast_slope_bps) >= 8.0 and abs(medium_slope_bps) >= 5.0 and direct >= 0.55:
        regime = "TREND_UP" if fast_slope_bps > 0 else "TREND_DOWN"
        confidence = min(1.0, 0.5 + direct * 0.35 + min(abs(fast_slope_bps), 40.0) / 200.0)
    elif volume_ratio >= 1.35 and recent_range_bps >= max(25.0, vol_bps * 1.4):
        regime = "BREAKOUT"
        confidence = min(1.0, 0.45 + min(volume_ratio - 1.0, 1.0) * 0.25 + direct * 0.3)
    elif vol_bps >= 30.0:
        regime = "HIGH_VOLATILITY"
        confidence = min(1.0, 0.45 + vol_bps / 120.0)
    else:
        regime = "RANGE"
        confidence = 0.55

    return {
        "market_regime": regime,
        "confidence": round(confidence, 4),
        "vol_bps": round(vol_bps, 6),
        "direction_ratio": round(direct, 6),
        "fast_slope_bps": round(fast_slope_bps, 6),
        "medium_slope_bps": round(medium_slope_bps, 6),
        "recent_range_bps": round(recent_range_bps, 6),
        "volume_ratio": round(volume_ratio, 6),
    }


def trend_strategy(closes: list[float], regime: dict[str, Any]) -> dict[str, Any]:
    market_regime = str(regime.get("market_regime") or "")
    if market_regime not in {"TREND_UP", "TREND_DOWN"}:
        return {"strategy_id": "trend_multi_horizon", "eligible": False, "reason": "regime_not_trend"}
    side = "buy" if market_regime == "TREND_UP" else "sell"
    slope = abs(to_float(regime.get("fast_slope_bps")))
    direct = to_float(regime.get("direction_ratio"))
    gross = min(45.0, slope * 0.9 + direct * 18.0)
    confidence = min(0.92, to_float(regime.get("confidence")) + 0.08)
    return {
        "strategy_id": "trend_multi_horizon",
        "strategy_version": "v1",
        "model_version": "strategy-brain-v1",
        "eligible": True,
        "side": side,
        "gross_expected_edge_bps": round(gross, 6),
        "confidence": round(confidence, 4),
        "entry_reason": f"{market_regime.lower()}_multi_horizon_slope_confirmed",
        "invalidation_reason": "trend_slope_or_liquidity_degrades",
    }


def mean_reversion_strategy(closes: list[float], regime: dict[str, Any]) -> dict[str, Any]:
    if str(regime.get("market_regime") or "") != "RANGE" or len(closes) < 30:
        return {"strategy_id": "range_mean_reversion", "eligible": False, "reason": "regime_not_range"}
    anchor = mean(closes[-30:])
    current = closes[-1]
    distance = pct_bps(current, anchor)
    if abs(distance) < 12.0:
        return {"strategy_id": "range_mean_reversion", "eligible": False, "reason": "distance_to_anchor_too_small"}
    side = "sell" if distance > 0 else "buy"
    gross = min(30.0, abs(distance) * 0.55)
    return {
        "strategy_id": "range_mean_reversion",
        "strategy_version": "v1",
        "model_version": "strategy-brain-v1",
        "eligible": True,
        "side": side,
        "gross_expected_edge_bps": round(gross, 6),
        "confidence": round(min(0.82, to_float(regime.get("confidence"))), 4),
        "entry_reason": "range_distance_to_anchor_mean_reversion",
        "invalidation_reason": "breakout_or_spread_degrades",
    }


def breakout_strategy(closes: list[float], volumes: list[float], regime: dict[str, Any]) -> dict[str, Any]:
    if str(regime.get("market_regime") or "") != "BREAKOUT" or len(closes) < 30:
        return {"strategy_id": "volatility_breakout", "eligible": False, "reason": "regime_not_breakout"}
    current = closes[-1]
    prior_high = max(closes[-25:-1])
    prior_low = min(closes[-25:-1])
    if current > prior_high:
        side = "buy"
        breakout_bps = pct_bps(current, prior_high)
    elif current < prior_low:
        side = "sell"
        breakout_bps = pct_bps(prior_low, current)
    else:
        return {"strategy_id": "volatility_breakout", "eligible": False, "reason": "breakout_not_confirmed"}
    gross = min(40.0, 12.0 + abs(breakout_bps) * 1.2)
    return {
        "strategy_id": "volatility_breakout",
        "strategy_version": "v1",
        "model_version": "strategy-brain-v1",
        "eligible": True,
        "side": side,
        "gross_expected_edge_bps": round(gross, 6),
        "confidence": round(min(0.88, to_float(regime.get("confidence"))), 4),
        "entry_reason": "volatility_expansion_breakout_confirmed",
        "invalidation_reason": "breakout_fails_or_slippage_degrades",
    }


def momentum_strategy(closes: list[float], volumes: list[float], regime: dict[str, Any]) -> dict[str, Any]:
    if len(closes) < 25:
        return {"strategy_id": "liquidity_confirmed_momentum", "eligible": False, "reason": "not_enough_bars"}
    momentum = pct_bps(closes[-1], closes[-10])
    volume_ratio = to_float(regime.get("volume_ratio"), 1.0)
    if abs(momentum) < 14.0 or volume_ratio < 1.1 or str(regime.get("market_regime")) in {"CHAOTIC", "INSUFFICIENT_DATA"}:
        return {"strategy_id": "liquidity_confirmed_momentum", "eligible": False, "reason": "momentum_or_liquidity_not_confirmed"}
    side = "buy" if momentum > 0 else "sell"
    gross = min(35.0, abs(momentum) * 0.75 + min(volume_ratio - 1.0, 1.0) * 5.0)
    return {
        "strategy_id": "liquidity_confirmed_momentum",
        "strategy_version": "v1",
        "model_version": "strategy-brain-v1",
        "eligible": True,
        "side": side,
        "gross_expected_edge_bps": round(gross, 6),
        "confidence": round(min(0.85, 0.5 + abs(momentum) / 120.0 + min(volume_ratio - 1.0, 1.0) * 0.15), 4),
        "entry_reason": "momentum_volume_liquidity_confirmed",
        "invalidation_reason": "momentum_reversal_or_liquidity_degrades",
    }


def enrich_with_costs(candidate: dict[str, Any], snapshot: dict[str, Any]) -> dict[str, Any]:
    fees = to_float(snapshot.get("estimated_fees_bps"), DEFAULT_ROUND_TRIP_TAKER_FEES_BPS)
    entry_fee = to_float(snapshot.get("estimated_entry_fee_bps"), TAKER_FEE_BPS)
    exit_fee = to_float(snapshot.get("estimated_exit_fee_bps"), TAKER_FEE_BPS)
    if "estimated_fees_bps" not in snapshot:
        fees = entry_fee + exit_fee
    slippage = to_float(snapshot.get("estimated_slippage_bps"), to_float(snapshot.get("slippage_bps"), 2.0))
    funding = abs(to_float(snapshot.get("estimated_funding_bps"), to_float(snapshot.get("funding_bps"), 0.0)))
    buffer = to_float(snapshot.get("uncertainty_buffer_bps"), DEFAULT_UNCERTAINTY_BUFFER_BPS)
    gross = to_float(candidate.get("gross_expected_edge_bps"))
    confidence = to_float(candidate.get("confidence"))
    net = round(gross - fees - slippage - funding - buffer, 8)
    lower_bound = round(net - (1.0 - confidence) * max(4.0, gross * 0.35), 8)
    enriched = {
        **candidate,
        "estimated_entry_fee_bps": entry_fee,
        "estimated_exit_fee_bps": exit_fee,
        "estimated_fees_bps": fees,
        "estimated_slippage_bps": slippage,
        "estimated_funding_bps": funding,
        "uncertainty_buffer_bps": buffer,
        "net_expected_edge_bps": net,
        "edge_lower_confidence_bound_bps": lower_bound,
    }
    return enriched


def select_candidate(candidates: list[dict[str, Any]]) -> dict[str, Any] | None:
    eligible = [item for item in candidates if item.get("eligible")]
    if not eligible:
        return None
    eligible.sort(
        key=lambda item: (
            to_float(item.get("edge_lower_confidence_bound_bps")),
            to_float(item.get("net_expected_edge_bps")) * to_float(item.get("confidence")),
        ),
        reverse=True,
    )
    return eligible[0]


def build_opportunity(snapshot: dict[str, Any], *, now: datetime | None = None, ttl_minutes: int = 5) -> dict[str, Any]:
    current = now or datetime.now(timezone.utc)
    symbol = str(snapshot.get("symbol") or "BTCUSDT").strip().upper()
    generated_at = parse_time(snapshot.get("generated_at")) or current
    closes = to_floats(snapshot.get("closes"))
    volumes = to_floats(snapshot.get("volumes"))
    blockers: list[str] = []
    if snapshot.get("schema_version") not in {SNAPSHOT_SCHEMA_VERSION, None}:
        blockers.append("snapshot_schema_invalid")
    if symbol != "BTCUSDT":
        blockers.append("symbol_not_allowed")
    if len(closes) < 30:
        blockers.append("insufficient_market_history")
    if snapshot.get("warmup_complete") is False:
        blockers.append("market_data_not_warm")
    if to_float(snapshot.get("market_data_lag_seconds"), 0.0) > to_float(snapshot.get("expected_interval_seconds"), 60.0) * 3:
        blockers.append("market_data_stale")
    if to_float(snapshot.get("missing_bar_count"), 0.0) > 0:
        blockers.append("market_data_missing_bars")
    if to_float(snapshot.get("duplicate_bar_count"), 0.0) > 0:
        blockers.append("market_data_duplicate_bars")
    spread_bps = to_float(snapshot.get("spread_bps"), 0.0)
    slippage_bps = to_float(snapshot.get("estimated_slippage_bps"), to_float(snapshot.get("slippage_bps"), 2.0))
    if spread_bps > MAX_SPREAD_BPS:
        blockers.append("spread_above_cap")
    if slippage_bps > MAX_SLIPPAGE_BPS:
        blockers.append("slippage_above_cap")

    regime = classify_regime(closes, volumes)
    raw_candidates = [
        trend_strategy(closes, regime),
        mean_reversion_strategy(closes, regime),
        breakout_strategy(closes, volumes, regime),
        momentum_strategy(closes, volumes, regime),
    ]
    candidates = [enrich_with_costs(candidate, snapshot) if candidate.get("eligible") else candidate for candidate in raw_candidates]
    selected = select_candidate(candidates)
    if not selected:
        blockers.append("no_strategy_candidate")
    elif to_float(selected.get("confidence")) < MIN_CONFIDENCE:
        blockers.append("confidence_below_threshold")
    elif to_float(selected.get("net_expected_edge_bps")) <= 0:
        blockers.append("net_expected_edge_not_positive")
    elif to_float(selected.get("edge_lower_confidence_bound_bps")) <= MIN_LCB_BPS:
        blockers.append("edge_lower_confidence_bound_below_threshold")

    snapshot_digest = stable_digest(snapshot)
    base = {
        "schema_version": "txt.strategy-brain-review.v1",
        "generated_at": generated_at.isoformat(),
        "symbol": symbol,
        "market_regime": regime.get("market_regime"),
        "regime": regime,
        "market_snapshot_digest": snapshot_digest,
        "candidates": candidates,
        "selected_strategy_id": selected.get("strategy_id") if selected else None,
        "admissible": not blockers,
        "blockers": blockers,
        "non_actions": ["no_broker_call", "no_order", "no_signal_consumption"],
    }
    if blockers or not selected:
        return {**base, "status": "NO_OPPORTUNITY"}

    core = {
        "strategy_id": selected["strategy_id"],
        "strategy_version": selected["strategy_version"],
        "model_version": selected["model_version"],
        "symbol": symbol,
        "side": selected["side"],
        "generated_at": generated_at.isoformat(),
        "market_regime": regime.get("market_regime"),
        "market_snapshot_digest": snapshot_digest,
        "gross_expected_edge_bps": selected["gross_expected_edge_bps"],
        "net_expected_edge_bps": selected["net_expected_edge_bps"],
        "edge_lower_confidence_bound_bps": selected["edge_lower_confidence_bound_bps"],
    }
    opportunity = {
        "schema_version": OPPORTUNITY_SCHEMA_VERSION,
        "opportunity_id": f"opp-{stable_digest(core)[:16]}",
        **core,
        "expires_at": (generated_at + timedelta(minutes=max(1, ttl_minutes))).isoformat(),
        "confidence": selected["confidence"],
        "entry_reason": selected["entry_reason"],
        "invalidation_reason": selected["invalidation_reason"],
        "expected_edge_bps": selected["gross_expected_edge_bps"],
        "estimated_entry_fee_bps": selected["estimated_entry_fee_bps"],
        "estimated_exit_fee_bps": selected["estimated_exit_fee_bps"],
        "estimated_fees_bps": selected["estimated_fees_bps"],
        "estimated_slippage_bps": selected["estimated_slippage_bps"],
        "estimated_funding_bps": selected["estimated_funding_bps"],
        "uncertainty_buffer_bps": selected["uncertainty_buffer_bps"],
        "evidence_refs": snapshot.get("evidence_refs") if isinstance(snapshot.get("evidence_refs"), list) else [],
        "producer": "txt_strategy_brain_v1",
    }
    return {**base, "status": "OPPORTUNITY", "opportunity": opportunity}


def format_text(report: dict[str, Any]) -> str:
    opportunity = report.get("opportunity") if isinstance(report.get("opportunity"), dict) else {}
    return (
        f"STRATEGY_BRAIN_V1 status={report.get('status')} admissible={report.get('admissible')} "
        f"regime={report.get('market_regime')} strategy={report.get('selected_strategy_id') or 'none'} "
        f"side={opportunity.get('side') or 'none'} "
        f"lcb_bps={opportunity.get('edge_lower_confidence_bound_bps', 'n/a')} "
        f"blockers={','.join(report.get('blockers') or []) or 'none'}"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Produce read-only txt.strategy-opportunity.v1 candidates from a market snapshot.")
    parser.add_argument("--input-json", required=True)
    parser.add_argument("--output", default=str(DEFAULT_OUT_DIR / "strategy_opportunity.json"))
    parser.add_argument("--ttl-minutes", type=int, default=5)
    parser.add_argument("--no-write", action="store_true")
    parser.add_argument("--text", action="store_true")
    args = parser.parse_args()

    snapshot = json.loads(Path(args.input_json).read_text(encoding="utf-8"))
    report = build_opportunity(snapshot if isinstance(snapshot, dict) else {}, ttl_minutes=args.ttl_minutes)
    if not args.no_write and report.get("status") == "OPPORTUNITY":
        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(report["opportunity"], indent=2, sort_keys=True, default=str), encoding="utf-8")
        report["output_path"] = str(output)
    if args.text:
        print(format_text(report))
        if report.get("output_path"):
            print(f"opportunity: {report['output_path']}")
    else:
        print(json.dumps(report, ensure_ascii=True, sort_keys=True, default=str))
    return 0 if report.get("status") == "OPPORTUNITY" else 2


if __name__ == "__main__":
    raise SystemExit(main())
