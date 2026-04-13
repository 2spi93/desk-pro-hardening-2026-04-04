from __future__ import annotations

from typing import Any


def _to_float(value: object, default: float = 0.0) -> float:
    try:
        return float(value)
    except Exception:
        return default


def _clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def _as_dict(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_rows(value: object) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [row for row in value if isinstance(row, dict)]


def _percentile(values: list[float], ratio: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = int(round((len(ordered) - 1) * _clamp(ratio, 0.0, 1.0)))
    return ordered[index]


def _reference_price(candidate: dict[str, Any]) -> float:
    mark_price = _to_float(candidate.get("mark_price"), 0.0)
    if mark_price > 0:
        return mark_price
    best_bid = _to_float(candidate.get("best_bid"), 0.0)
    best_ask = _to_float(candidate.get("best_ask"), 0.0)
    if best_bid > 0 and best_ask > 0 and best_ask >= best_bid:
        return (best_bid + best_ask) / 2.0
    return max(best_bid, best_ask, _to_float(candidate.get("last"), 0.0), 0.0)


def _resolve_volume_profile(candidate: dict[str, Any], reference_price: float) -> dict[str, Any]:
    explicit = _as_dict(candidate.get("volume_profile"))
    if explicit:
        return {
            "poc": round(_to_float(explicit.get("poc"), reference_price), 8) if reference_price > 0 else round(_to_float(explicit.get("poc"), 0.0), 8),
            "value_area_high": round(_to_float(explicit.get("value_area_high"), reference_price), 8) if reference_price > 0 else round(_to_float(explicit.get("value_area_high"), 0.0), 8),
            "value_area_low": round(_to_float(explicit.get("value_area_low"), reference_price), 8) if reference_price > 0 else round(_to_float(explicit.get("value_area_low"), 0.0), 8),
            "hvn_zones": [round(_to_float(item, 0.0), 8) for item in explicit.get("hvn_zones", []) if _to_float(item, 0.0) > 0],
            "lvn_zones": [round(_to_float(item, 0.0), 8) for item in explicit.get("lvn_zones", []) if _to_float(item, 0.0) > 0],
            "source": str(explicit.get("source") or "explicit"),
        }

    book = _as_dict(candidate.get("depth_payload"))
    levels: list[tuple[float, float]] = []
    for side_key in ("bids", "asks"):
        side_rows = book.get(side_key)
        if not isinstance(side_rows, list):
            continue
        for raw_level in side_rows[:8]:
            if not (isinstance(raw_level, list) and len(raw_level) >= 2):
                continue
            price = _to_float(raw_level[0], 0.0)
            size = _to_float(raw_level[1], 0.0)
            if price <= 0 or size <= 0:
                continue
            levels.append((price, price * size))
    if not levels:
        return {
            "poc": round(reference_price, 8),
            "value_area_high": round(reference_price, 8),
            "value_area_low": round(reference_price, 8),
            "hvn_zones": [round(reference_price, 8)] if reference_price > 0 else [],
            "lvn_zones": [],
            "source": "depth_fallback",
        }

    prices = [price for price, _ in levels]
    weights = [weight for _, weight in levels]
    total_weight = sum(weights) or 1.0
    poc_index = max(range(len(weights)), key=lambda idx: weights[idx])
    poc = prices[poc_index]
    high_threshold = _percentile(weights, 0.8)
    low_threshold = _percentile(weights, 0.2)
    hvn = sorted({round(prices[idx], 8) for idx, weight in enumerate(weights) if weight >= high_threshold and prices[idx] > 0})
    lvn = sorted({round(prices[idx], 8) for idx, weight in enumerate(weights) if weight <= low_threshold and prices[idx] > 0})

    ranked = sorted(levels, key=lambda item: item[1], reverse=True)
    accepted_prices: list[float] = []
    accepted_weight = 0.0
    for price, weight in ranked:
        accepted_prices.append(price)
        accepted_weight += weight
        if accepted_weight / total_weight >= 0.7:
            break

    return {
        "poc": round(poc, 8),
        "value_area_high": round(max(accepted_prices), 8),
        "value_area_low": round(min(accepted_prices), 8),
        "hvn_zones": hvn,
        "lvn_zones": lvn,
        "source": "depth_payload",
    }


def _resolve_volatility(candidate: dict[str, Any]) -> dict[str, Any]:
    explicit = str(candidate.get("volatility_regime") or "").strip().lower()
    spread_bps = max(0.0, _to_float(candidate.get("spread_bps"), 0.0))
    depth_imbalance = abs(_to_float(candidate.get("depth_imbalance"), 0.0))
    volume_imbalance = abs(_to_float(candidate.get("volume_imbalance"), 0.0))
    freshness_ms = max(0.0, _to_float(candidate.get("freshness_ms"), 0.0))
    score = _clamp(
        (spread_bps / 12.0) * 0.34
        + depth_imbalance * 0.28
        + volume_imbalance * 0.24
        + min(1.0, freshness_ms / 45_000.0) * 0.14,
        0.0,
        1.0,
    )
    if explicit in {"high", "high_vol", "volatile"}:
        regime = "high"
    elif explicit in {"low", "compressed", "calm"}:
        regime = "low"
    elif score >= 0.62:
        regime = "high"
    elif score <= 0.28:
        regime = "low"
    else:
        regime = "normal"
    return {
        "score": round(score, 6),
        "regime": regime,
    }


def _resolve_bias(candidate: dict[str, Any]) -> dict[str, Any]:
    explicit = candidate.get("multi_timeframe_bias")
    if isinstance(explicit, str):
        normalized = explicit.strip().lower()
        if normalized in {"bullish", "bearish", "neutral"}:
            score = 0.75 if normalized == "bullish" else -0.75 if normalized == "bearish" else 0.0
            return {"state": normalized, "score": round(score, 6), "source": "explicit"}
    if isinstance(explicit, dict):
        htf = _to_float(explicit.get("htf"), 0.0)
        mtf = _to_float(explicit.get("mtf"), 0.0)
        ltf = _to_float(explicit.get("ltf"), 0.0)
        score = _clamp(htf * 0.5 + mtf * 0.3 + ltf * 0.2, -1.0, 1.0)
        state = "bullish" if score >= 0.18 else "bearish" if score <= -0.18 else "neutral"
        return {"state": state, "score": round(score, 6), "source": "multi_timeframe_bias"}

    depth_imbalance = _to_float(candidate.get("depth_imbalance"), 0.0)
    volume_imbalance = _to_float(candidate.get("volume_imbalance"), 0.0)
    dominance = _to_float(candidate.get("dominance_score"), 0.0)
    score = _clamp(depth_imbalance * 0.42 + volume_imbalance * 0.38 + dominance * 0.2, -1.0, 1.0)
    state = "bullish" if score >= 0.16 else "bearish" if score <= -0.16 else "neutral"
    return {"state": state, "score": round(score, 6), "source": "imbalances"}


def _resolve_zone(candidate: dict[str, Any]) -> dict[str, Any]:
    explicit = str(candidate.get("active_zone") or candidate.get("zone") or "").strip().lower()
    if explicit in {"supply", "demand", "rejection", "none"}:
        return {"state": explicit, "source": "explicit"}
    zone_rows = _as_rows(candidate.get("zones"))
    if zone_rows:
        row = zone_rows[-1]
        state = str(row.get("type") or row.get("state") or "none").strip().lower()
        if state in {"supply", "demand", "rejection"}:
            return {"state": state, "source": "zones"}

    depth_imbalance = _to_float(candidate.get("depth_imbalance"), 0.0)
    volume_imbalance = _to_float(candidate.get("volume_imbalance"), 0.0)
    avg_pressure = (depth_imbalance + volume_imbalance) / 2.0
    if depth_imbalance * volume_imbalance < -0.18 and max(abs(depth_imbalance), abs(volume_imbalance)) >= 0.35:
        return {"state": "rejection", "source": "imbalances"}
    if avg_pressure >= 0.24:
        return {"state": "demand", "source": "imbalances"}
    if avg_pressure <= -0.24:
        return {"state": "supply", "source": "imbalances"}
    return {"state": "none", "source": "imbalances"}


def build_market_structure_snapshot(candidate: dict[str, Any], side: str = "buy") -> dict[str, Any]:
    reference_price = _reference_price(candidate)
    volume_profile = _resolve_volume_profile(candidate, reference_price)
    volatility = _resolve_volatility(candidate)
    bias = _resolve_bias(candidate)
    zone = _resolve_zone(candidate)
    return {
        "reference_price": round(reference_price, 8),
        "side": str(side or "buy").strip().lower() or "buy",
        "bias": bias,
        "volatility": volatility,
        "zone": zone,
        "volume_profile": volume_profile,
    }


def build_execution_context(
    candidate: dict[str, Any],
    market_structure: dict[str, Any],
    flow_metrics: dict[str, Any] | None,
    side: str,
    notional_usd: float,
) -> dict[str, Any]:
    normalized_side = str(side or "buy").strip().lower() or "buy"
    structure_bias = _as_dict(market_structure.get("bias"))
    volatility = _as_dict(market_structure.get("volatility"))
    zone = _as_dict(market_structure.get("zone"))
    fill = _as_dict(flow_metrics)
    policy_overrides = _as_dict(candidate.get("context_policy"))
    policy_overrides = {**policy_overrides, **_as_dict(fill.get("context_policy"))}

    fill_probability = _clamp(
        _to_float(fill.get("effective_fill_probability"), _to_float(fill.get("predicted_fill_probability"), _to_float(candidate.get("fill_probability"), 0.0))),
        0.0,
        1.0,
    )
    spread_bps = max(0.0, _to_float(candidate.get("spread_bps"), 0.0))
    latency_ms = max(0.0, _to_float(candidate.get("latency_ms"), 0.0))
    freshness_ms = max(0.0, _to_float(candidate.get("freshness_ms"), 0.0))
    available_depth_usd = max(0.0, _to_float(candidate.get("available_depth_usd"), 0.0))
    depth_cover_ratio = available_depth_usd / max(notional_usd, 1e-9) if notional_usd > 0 else 0.0
    queue_edge = _clamp(_to_float(fill.get("queue_edge"), _to_float(candidate.get("queue_edge"), 0.0)), 0.0, 1.0)
    queue_pressure = _clamp(
        _to_float(candidate.get("queue_position"), _to_float(candidate.get("queue_priority_risk"), 1.0 - queue_edge)),
        0.0,
        1.0,
    )
    daily_loss_pct = max(
        0.0,
        _to_float(candidate.get("daily_loss_pct"), 0.0),
        _to_float(candidate.get("daily_drawdown_pct"), 0.0),
        _to_float(fill.get("daily_loss_pct"), 0.0),
        _to_float(fill.get("daily_drawdown_pct"), 0.0),
    )

    desk_thresholds = {
        "confidence_floor": _clamp(_to_float(policy_overrides.get("confidence_floor"), 0.4), 0.15, 0.85),
        "high_vol_spread_bps": _clamp(_to_float(policy_overrides.get("high_vol_spread_bps"), 4.5), 1.0, 18.0),
        "latency_ceiling_ms": _clamp(_to_float(policy_overrides.get("latency_ceiling_ms"), 200.0), 40.0, 1000.0),
        "fill_probability_floor": _clamp(_to_float(policy_overrides.get("fill_probability_floor"), 0.3), 0.05, 0.9),
        "daily_loss_limit_pct": _clamp(_to_float(policy_overrides.get("daily_loss_limit_pct"), 2.0), 0.2, 25.0),
        "stale_market_ms": _clamp(_to_float(policy_overrides.get("stale_market_ms"), 20_000.0), 500.0, 120_000.0),
        "clean_spread_bps": _clamp(_to_float(policy_overrides.get("clean_spread_bps"), 3.0), 0.1, 12.0),
        "boost_fill_probability": _clamp(_to_float(policy_overrides.get("boost_fill_probability"), 0.7), 0.3, 0.95),
        "queue_pressure_boost_ceiling": _clamp(_to_float(policy_overrides.get("queue_pressure_boost_ceiling"), 0.35), 0.05, 0.95),
        "dominance_soft_signals_limit": _clamp(_to_float(policy_overrides.get("dominance_soft_signals_limit"), 3.0), 1.0, 5.0),
        "dominance_confidence_buffer": _clamp(_to_float(policy_overrides.get("dominance_confidence_buffer"), 0.08), 0.0, 0.25),
        "dominance_high_queue_pressure": _clamp(_to_float(policy_overrides.get("dominance_high_queue_pressure"), 0.72), 0.3, 0.98),
    }

    if freshness_ms >= desk_thresholds["stale_market_ms"]:
        liquidity_state = "stale"
    elif depth_cover_ratio < 1.0:
        liquidity_state = "thin"
    elif abs(_to_float(candidate.get("depth_imbalance"), 0.0)) >= 0.82:
        liquidity_state = "imbalanced"
    else:
        liquidity_state = "balanced"

    latency_penalty = _clamp(latency_ms / 250.0, 0.0, 1.0)
    spread_penalty = _clamp(spread_bps / 8.0, 0.0, 1.0)
    freshness_penalty = _clamp(freshness_ms / 20_000.0, 0.0, 1.0)
    confidence = _clamp(
        fill_probability * 0.46
        + (1.0 - latency_penalty) * 0.22
        + (1.0 - spread_penalty) * 0.14
        + (1.0 - freshness_penalty) * 0.1
        + min(1.0, depth_cover_ratio / 2.2) * 0.08,
        0.0,
        1.0,
    )

    bias_state = str(structure_bias.get("state") or "neutral")
    zone_state = str(zone.get("state") or "none")
    volatility_regime = str(volatility.get("regime") or "normal")
    directional_mismatch = bool((normalized_side == "buy" and bias_state == "bearish") or (normalized_side == "sell" and bias_state == "bullish"))
    aligned_zone = bool((normalized_side == "buy" and zone_state == "demand") or (normalized_side == "sell" and zone_state == "supply") or zone_state == "rejection")

    volatility_sizing_multiplier = 1.0
    if volatility_regime == "high":
        volatility_sizing_multiplier = 0.5
    elif volatility_regime == "low":
        volatility_sizing_multiplier = 1.2
    else:
        volatility_sizing_multiplier = 0.9

    size_multiplier = volatility_sizing_multiplier
    aggressiveness_multiplier = 1.0
    dynamic_entry_boost = 0.0
    reasons: list[str] = []
    no_trade_reasons: list[str] = []
    freeze_learning_reasons: list[str] = []

    if volatility_regime == "high":
        aggressiveness_multiplier *= 0.82
        reasons.append("high_volatility_reduce")
    elif volatility_regime == "low":
        aggressiveness_multiplier *= 1.05
        reasons.append("low_volatility_expand")
    else:
        reasons.append("normal_volatility_reduce")

    if liquidity_state == "thin":
        size_multiplier *= 0.75
        aggressiveness_multiplier *= 0.9
        reasons.append("thin_depth_reduce")
    elif liquidity_state == "stale":
        size_multiplier *= 0.5
        aggressiveness_multiplier *= 0.74
        reasons.append("stale_market_reduce")

    if directional_mismatch:
        size_multiplier *= 0.7
        aggressiveness_multiplier *= 0.88
        reasons.append("directional_bias_mismatch")

    if zone_state == "rejection":
        dynamic_entry_boost += 0.1
        reasons.append("rejection_zone_boost")
    elif aligned_zone:
        dynamic_entry_boost += 0.07
        aggressiveness_multiplier *= 1.08
        reasons.append("zone_alignment_boost")

    if fill_probability >= desk_thresholds["boost_fill_probability"]:
        dynamic_entry_boost += 0.08
        reasons.append("fill_probability_boost")
    if spread_bps <= desk_thresholds["clean_spread_bps"]:
        dynamic_entry_boost += 0.06
        reasons.append("clean_spread_boost")
    if queue_pressure <= desk_thresholds["queue_pressure_boost_ceiling"]:
        dynamic_entry_boost += 0.04
        reasons.append("queue_priority_boost")

    dynamic_entry_boost = _clamp(dynamic_entry_boost, 0.0, 0.3)

    if confidence < desk_thresholds["confidence_floor"]:
        no_trade_reasons.append("low_confidence")
    if volatility_regime == "high" and spread_bps > desk_thresholds["high_vol_spread_bps"]:
        no_trade_reasons.append("high_volatility_spread")
    if latency_ms > desk_thresholds["latency_ceiling_ms"]:
        no_trade_reasons.append("latency_too_high")
    if fill_probability < desk_thresholds["fill_probability_floor"]:
        no_trade_reasons.append("low_fill_probability")
    if daily_loss_pct >= desk_thresholds["daily_loss_limit_pct"]:
        no_trade_reasons.append("daily_loss_limit")
    if liquidity_state == "stale" and fill_probability < max(0.45, desk_thresholds["fill_probability_floor"] + 0.15):
        no_trade_reasons.append("stale_liquidity_context")
    if depth_cover_ratio < 0.75:
        no_trade_reasons.append("depth_cover_too_thin")
    if directional_mismatch and confidence < 0.45:
        no_trade_reasons.append("directional_context_mismatch")

    dominance_soft_signals: list[str] = []
    if volatility_regime == "high":
        dominance_soft_signals.append("high_volatility_regime")
    if liquidity_state in {"thin", "stale", "imbalanced"}:
        dominance_soft_signals.append(f"liquidity_{liquidity_state}")
    if directional_mismatch:
        dominance_soft_signals.append("directional_bias_mismatch")
    if queue_pressure >= desk_thresholds["dominance_high_queue_pressure"]:
        dominance_soft_signals.append("queue_pressure_high")
    if confidence <= desk_thresholds["confidence_floor"] + desk_thresholds["dominance_confidence_buffer"]:
        dominance_soft_signals.append("confidence_near_floor")
    if fill_probability <= desk_thresholds["fill_probability_floor"] + 0.08:
        dominance_soft_signals.append("fill_probability_near_floor")
    if len(dominance_soft_signals) >= int(round(desk_thresholds["dominance_soft_signals_limit"])):
        no_trade_reasons.append("dominance_environment_stack")

    hard_no_trade_reasons = {
        "daily_loss_limit",
        "latency_too_high",
        "high_volatility_spread",
        "stale_liquidity_context",
        "depth_cover_too_thin",
    }
    dominant_reasons = [reason for reason in no_trade_reasons if reason in hard_no_trade_reasons]
    if not dominant_reasons and "dominance_environment_stack" in no_trade_reasons:
        dominant_reasons = ["dominance_environment_stack", *dominance_soft_signals[:3]]
    no_trade_dominance = bool(dominant_reasons)
    no_trade_state = (
        "hard_block"
        if any(reason in hard_no_trade_reasons for reason in dominant_reasons)
        else "dominant_block"
        if no_trade_dominance
        else "soft_block"
        if no_trade_reasons
        else "eligible"
    )
    no_trade_dominance_score = _clamp(
        len(dominance_soft_signals) / max(1.0, desk_thresholds["dominance_soft_signals_limit"])
        + (0.45 if no_trade_state == "hard_block" else 0.28 if no_trade_state == "dominant_block" else 0.0)
        + max(0.0, desk_thresholds["confidence_floor"] - confidence) * 0.8,
        0.0,
        1.0,
    )

    fallback_mode = "normal"
    if daily_loss_pct >= desk_thresholds["daily_loss_limit_pct"]:
        fallback_mode = "halt"
    elif latency_ms > desk_thresholds["latency_ceiling_ms"] * 1.1 or liquidity_state == "stale" or (volatility_regime == "high" and spread_bps > desk_thresholds["high_vol_spread_bps"]):
        fallback_mode = "rules_only"
    elif volatility_regime == "high" or liquidity_state in {"thin", "imbalanced"} or directional_mismatch:
        fallback_mode = "degraded"

    if fallback_mode in {"rules_only", "halt"}:
        freeze_learning_reasons.append(f"fallback_{fallback_mode}")
    if daily_loss_pct >= desk_thresholds["daily_loss_limit_pct"] * 0.85:
        freeze_learning_reasons.append("daily_loss_guard")
    if "low_confidence" in no_trade_reasons:
        freeze_learning_reasons.append("confidence_guard")
    if "latency_too_high" in no_trade_reasons:
        freeze_learning_reasons.append("latency_guard")
    if "high_volatility_spread" in no_trade_reasons:
        freeze_learning_reasons.append("volatility_spread_guard")
    freeze_learning = bool(freeze_learning_reasons)

    size_multiplier = _clamp(size_multiplier, 0.2, 1.35)
    aggressiveness_multiplier = _clamp(aggressiveness_multiplier, 0.5, 1.25)
    target_notional_usd = round(max(0.0, notional_usd * size_multiplier), 6)
    policy = {
        "thresholds": {key: round(value, 6) for key, value in desk_thresholds.items()},
        "no_trade": bool(no_trade_reasons),
        "no_trade_reasons": no_trade_reasons,
        "no_trade_state": no_trade_state,
        "no_trade_dominance": no_trade_dominance,
        "no_trade_dominance_score": round(no_trade_dominance_score, 6),
        "dominant_reasons": dominant_reasons,
        "dominance_soft_signals": dominance_soft_signals,
        "fallback_mode": fallback_mode,
        "freeze_learning": freeze_learning,
        "freeze_learning_reasons": freeze_learning_reasons,
        "learning_mode": "frozen" if freeze_learning else "online",
        "dynamic_entry_boost": round(dynamic_entry_boost, 6),
        "volatility_sizing_multiplier": round(volatility_sizing_multiplier, 6),
        "daily_loss_pct": round(daily_loss_pct, 6),
    }
    return {
        "bias": bias_state,
        "bias_score": round(_to_float(structure_bias.get("score"), 0.0), 6),
        "volatility_regime": volatility_regime,
        "volatility_score": round(_to_float(volatility.get("score"), 0.0), 6),
        "liquidity_state": liquidity_state,
        "zone": zone_state,
        "confidence": round(confidence, 6),
        "fill_probability": round(fill_probability, 6),
        "depth_cover_ratio": round(depth_cover_ratio, 6),
        "directional_mismatch": directional_mismatch,
        "allow_long": bias_state != "bearish",
        "allow_short": bias_state != "bullish",
        "size_multiplier": round(size_multiplier, 6),
        "aggressiveness_multiplier": round(aggressiveness_multiplier, 6),
        "entry_boost_adjustment": round(dynamic_entry_boost, 6),
        "target_notional_usd": target_notional_usd,
        "reasons": reasons,
        "no_trade": bool(no_trade_reasons),
        "no_trade_reasons": no_trade_reasons,
        "no_trade_state": no_trade_state,
        "no_trade_dominance": no_trade_dominance,
        "no_trade_dominance_score": round(no_trade_dominance_score, 6),
        "dominant_reasons": dominant_reasons,
        "dominance_soft_signals": dominance_soft_signals,
        "fallback_mode": fallback_mode,
        "freeze_learning": freeze_learning,
        "freeze_learning_reasons": freeze_learning_reasons,
        "learning_mode": "frozen" if freeze_learning else "online",
        "policy": policy,
    }


def apply_execution_context_to_fill_snapshot(
    fill_snapshot: dict[str, Any],
    execution_context: dict[str, Any],
    market_structure: dict[str, Any] | None = None,
) -> dict[str, Any]:
    updated = dict(fill_snapshot)
    context = execution_context if isinstance(execution_context, dict) else {}
    fill_score = _clamp(_to_float(updated.get("fill_score"), 0.0), 0.0, 1.0)
    probabilistic_fill = _clamp(_to_float(updated.get("probabilistic_fill_probability"), _to_float(updated.get("effective_fill_probability"), 0.0)), 0.0, 1.0)
    entry_boost = max(0.0, _to_float(updated.get("entry_boost"), 0.0) + _to_float(context.get("entry_boost_adjustment"), 0.0))
    confidence = _clamp(_to_float(updated.get("confidence"), 0.0) * 0.78 + _to_float(context.get("confidence"), 0.0) * 0.22, 0.0, 1.0)
    aggressiveness = _clamp(_to_float(updated.get("aggressiveness"), 0.0) * _to_float(context.get("aggressiveness_multiplier"), 1.0), 0.0, 1.0)
    context_penalty = 0.08 if bool(context.get("no_trade")) else 0.0
    fill_score = _clamp(fill_score + entry_boost * 0.18 + max(0.0, confidence - 0.5) * 0.06 - context_penalty, 0.0, 1.0)
    probabilistic_fill = _clamp(probabilistic_fill + entry_boost * 0.15 + max(0.0, confidence - 0.5) * 0.05 - context_penalty, 0.0, 1.0)
    effective_fill = _clamp(probabilistic_fill * 0.62 + fill_score * 0.38, 0.0, 1.0)
    updated.update(
        {
            "fill_score": round(fill_score, 6),
            "probabilistic_fill_probability": round(probabilistic_fill, 6),
            "effective_fill_probability": round(effective_fill, 6),
            "entry_boost": round(entry_boost, 6),
            "confidence": round(confidence, 6),
            "aggressiveness": round(aggressiveness, 6),
            "context_applied": True,
            "context_size_multiplier": round(_to_float(context.get("size_multiplier"), 1.0), 6),
            "context_target_notional_usd": round(_to_float(context.get("target_notional_usd"), 0.0), 6),
            "context_bias": str(context.get("bias") or "neutral"),
            "context_volatility_regime": str(context.get("volatility_regime") or "normal"),
            "context_liquidity_state": str(context.get("liquidity_state") or "balanced"),
            "context_zone": str(context.get("zone") or "none"),
            "context_reasons": list(context.get("reasons") or []),
            "context_no_trade": bool(context.get("no_trade")),
            "context_no_trade_reasons": list(context.get("no_trade_reasons") or []),
            "context_no_trade_state": str(context.get("no_trade_state") or "eligible"),
            "context_no_trade_dominance": bool(context.get("no_trade_dominance")),
            "context_dominant_reasons": list(context.get("dominant_reasons") or []),
            "context_fallback_mode": str(context.get("fallback_mode") or "normal"),
            "context_freeze_learning": bool(context.get("freeze_learning")),
            "context_freeze_learning_reasons": list(context.get("freeze_learning_reasons") or []),
            "context_policy": _as_dict(context.get("policy")),
        }
    )
    if isinstance(market_structure, dict):
        updated["market_structure"] = market_structure
    return updated