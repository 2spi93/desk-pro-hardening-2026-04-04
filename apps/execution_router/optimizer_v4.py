from __future__ import annotations

from typing import Any


def _to_float(value: object, default: float = 0.0) -> float:
    try:
        return float(value)
    except Exception:
        return default


def _clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def _to_bool(value: object, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"0", "false", "no", "off"}:
            return False
    return default


def _as_dict(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _normalized_venue(venue: object) -> str:
    return str(venue or "unknown").strip().lower()


def _soft_guard_reason_set(desk_profile: dict[str, Any]) -> set[str]:
    configured = desk_profile.get("soft_guard_reasons")
    if isinstance(configured, list):
        reasons = {str(reason).strip() for reason in configured if str(reason).strip()}
        if reasons:
            return reasons
    return {"latency_above_profile", "freshness_above_profile", "fill_score_below_profile"}


def default_execution_desk_profile(venue: str) -> dict[str, Any]:
    profile = {
        "venue": str(venue or "unknown"),
        "sample_count": 0,
        "replace_rate": 0.0,
        "amend_rate": 0.0,
        "cancel_rate": 0.0,
        "cancel_below_fill_probability": 0.4,
        "replace_below_fill_probability": 0.7,
        "upgrade_to_market_above": 0.82,
        "min_fill_probability": 0.5,
        "max_spread_bps": 12.0,
        "max_latency_ms": 350.0,
        "max_freshness_ms": 45000.0,
        "min_depth_cover_ratio": 1.4,
        "max_depth_imbalance": 0.7,
        "spoof_notional_usd": 15000.0,
        "spoof_size_multiple": 3.5,
        "spoof_lifetime_ms": 1500.0,
        "loop_interval_ms": 900.0,
        "max_lifecycle_cycles": 6,
        "replace_price_bps": 0.6,
        "latency_soft_ms": 250.0,
        "freshness_soft_ms": 20000.0,
        "entry_boost_spread_bps": 0.0,
        "entry_boost_fill_score": 0.0,
        "cancel_on_fill_score_guard": True,
        "replace_on_fill_score_guard": False,
        "replace_on_soft_guard": False,
        "replace_on_depth_imbalance_guard": False,
        "imbalance_reduce_size_ratio": 1.0,
        "queue_tail_reprice_threshold": 0.68,
        "queue_time_reprice_ms": 2000.0,
        "aggressiveness_reprice_threshold": 0.6,
        "dominance_floor": 0.4,
        "liquidity_trap_trade_intensity": 0.08,
        "liquidity_trap_decay_rate": 0.04,
        "soft_guard_reasons": ["latency_above_profile", "freshness_above_profile", "fill_score_below_profile"],
        "calibration_source": "default",
    }
    if _normalized_venue(venue).startswith("bingx"):
        profile.update(
            {
                "cancel_below_fill_probability": 0.22,
                "replace_below_fill_probability": 0.52,
                "upgrade_to_market_above": 0.88,
                "min_fill_probability": 0.3,
                "max_spread_bps": 14.0,
                "max_latency_ms": 150.0,
                "max_freshness_ms": 300.0,
                "min_depth_cover_ratio": 1.18,
                "max_depth_imbalance": 0.84,
                "spoof_notional_usd": 9000.0,
                "spoof_size_multiple": 4.0,
                "spoof_lifetime_ms": 900.0,
                "loop_interval_ms": 650.0,
                "max_lifecycle_cycles": 8,
                "replace_price_bps": 0.35,
                "latency_soft_ms": 100.0,
                "freshness_soft_ms": 220.0,
                "entry_boost_spread_bps": 2.5,
                "entry_boost_fill_score": 0.2,
                "cancel_on_fill_score_guard": False,
                "replace_on_fill_score_guard": True,
                "replace_on_soft_guard": True,
                "replace_on_depth_imbalance_guard": True,
                "imbalance_reduce_size_ratio": 0.7,
                "queue_tail_reprice_threshold": 0.62,
                "queue_time_reprice_ms": 1600.0,
                "aggressiveness_reprice_threshold": 0.52,
                "dominance_floor": 0.38,
                "liquidity_trap_trade_intensity": 0.06,
                "liquidity_trap_decay_rate": 0.035,
                "calibration_source": "default_bingx",
            }
        )
    return profile


def calibrate_execution_desk_profile(venue: str, stats: dict[str, Any]) -> dict[str, Any]:
    profile = default_execution_desk_profile(venue)
    normalized_venue = _normalized_venue(venue)
    fill_count = max(0, int(_to_float(stats.get("fill_count"), 0.0)))
    avg_slippage_bps = max(0.0, _to_float(stats.get("avg_slippage_bps"), 0.0))
    avg_fill_latency_ms = max(0.0, _to_float(stats.get("avg_fill_latency_ms"), 0.0))
    avg_fill_quality_score = max(0.0, _to_float(stats.get("avg_fill_quality_score"), 0.0))
    replace_rate = _clamp(_to_float(stats.get("replace_rate"), 0.0), 0.0, 1.0)
    amend_rate = _clamp(_to_float(stats.get("amend_rate"), 0.0), 0.0, 1.0)
    cancel_rate = _clamp(_to_float(stats.get("cancel_rate"), 0.0), 0.0, 1.0)
    confidence = _clamp(fill_count / 120.0, 0.0, 1.0)
    quality_penalty = _clamp((82.0 - avg_fill_quality_score) / 24.0, 0.0, 1.0) if avg_fill_quality_score > 0 else 0.28
    slippage_penalty = _clamp(avg_slippage_bps / 12.0, 0.0, 1.0)
    latency_penalty = _clamp(avg_fill_latency_ms / 260.0, 0.0, 1.0)
    replacement_pressure = _clamp(replace_rate * 0.75 + cancel_rate * 0.55 - amend_rate * 0.25, 0.0, 1.0)

    profile.update(
        {
            "sample_count": fill_count,
            "replace_rate": round(replace_rate, 6),
            "amend_rate": round(amend_rate, 6),
            "cancel_rate": round(cancel_rate, 6),
            "cancel_below_fill_probability": round(_clamp(0.36 + quality_penalty * 0.08 + slippage_penalty * 0.05 + replacement_pressure * 0.05, 0.32, 0.6), 6),
            "replace_below_fill_probability": round(_clamp(0.64 + quality_penalty * 0.1 + latency_penalty * 0.06 + replacement_pressure * 0.08, 0.58, 0.86), 6),
            "upgrade_to_market_above": round(_clamp(0.86 - confidence * 0.05 + slippage_penalty * 0.03, 0.72, 0.9), 6),
            "min_fill_probability": round(_clamp(0.48 + quality_penalty * 0.09 + slippage_penalty * 0.04 + replacement_pressure * 0.05, 0.42, 0.74), 6),
            "max_spread_bps": round(_clamp(12.0 - confidence * 2.5 - quality_penalty * 1.4 - slippage_penalty * 2.0 - replacement_pressure * 1.2, 4.5, 16.0), 6),
            "max_latency_ms": round(_clamp(320.0 - confidence * 40.0 - latency_penalty * 90.0 - replacement_pressure * 35.0, 100.0, 420.0), 6),
            "max_freshness_ms": round(_clamp(45000.0 - confidence * 6000.0 - latency_penalty * 12000.0, 12000.0, 60000.0), 6),
            "min_depth_cover_ratio": round(_clamp(1.3 + quality_penalty * 0.32 + slippage_penalty * 0.24, 1.1, 2.2), 6),
            "max_depth_imbalance": round(_clamp(0.72 - confidence * 0.08 + quality_penalty * 0.08, 0.45, 0.82), 6),
            "spoof_notional_usd": round(_clamp(15000.0 + avg_slippage_bps * 1800.0, 10000.0, 75000.0), 6),
            "spoof_size_multiple": round(_clamp(3.5 - confidence * 0.2 + quality_penalty * 0.35, 2.6, 4.6), 6),
            "spoof_lifetime_ms": round(_clamp(1200.0 + latency_penalty * 900.0, 800.0, 2800.0), 6),
            "loop_interval_ms": round(_clamp(900.0 - confidence * 180.0 + latency_penalty * 320.0 - amend_rate * 90.0 + replacement_pressure * 120.0, 420.0, 1600.0), 6),
            "replace_price_bps": round(_clamp(0.55 + slippage_penalty * 0.8 + replacement_pressure * 0.45 - amend_rate * 0.15, 0.3, 2.6), 6),
            "calibration_source": "execution_fill_events",
            "avg_slippage_bps": round(avg_slippage_bps, 6),
            "avg_fill_latency_ms": round(avg_fill_latency_ms, 6),
            "avg_fill_quality_score": round(avg_fill_quality_score, 6),
        }
    )
    if normalized_venue.startswith("bingx"):
        low_sample_relaxation = 1.0 - _clamp(fill_count / 90.0, 0.0, 1.0)
        profile.update(
            {
                "cancel_below_fill_probability": round(
                    _clamp(
                        _to_float(profile.get("cancel_below_fill_probability"), 0.22) - 0.1 - low_sample_relaxation * 0.05,
                        0.18,
                        0.4,
                    ),
                    6,
                ),
                "replace_below_fill_probability": round(
                    _clamp(
                        _to_float(profile.get("replace_below_fill_probability"), 0.52) - 0.08 - low_sample_relaxation * 0.04,
                        0.46,
                        0.72,
                    ),
                    6,
                ),
                "min_fill_probability": round(
                    _clamp(
                        0.30 + quality_penalty * 0.03 + replacement_pressure * 0.03 - confidence * 0.02,
                        0.28,
                        0.42,
                    ),
                    6,
                ),
                "max_latency_ms": round(
                    _clamp(
                        150.0 + latency_penalty * 15.0 + replacement_pressure * 10.0 - confidence * 8.0,
                        150.0,
                        185.0,
                    ),
                    6,
                ),
                "latency_soft_ms": round(
                    _clamp(100.0 + latency_penalty * 12.0 + replacement_pressure * 6.0, 95.0, 135.0),
                    6,
                ),
                "max_freshness_ms": round(
                    _clamp(300.0 + latency_penalty * 90.0 + replacement_pressure * 40.0 - confidence * 25.0, 300.0, 520.0),
                    6,
                ),
                "freshness_soft_ms": round(
                    _clamp(220.0 + latency_penalty * 50.0 + replacement_pressure * 25.0, 200.0, 360.0),
                    6,
                ),
                "min_depth_cover_ratio": round(
                    _clamp(_to_float(profile.get("min_depth_cover_ratio"), 1.18) - 0.12, 1.05, 1.8),
                    6,
                ),
                "max_depth_imbalance": round(
                    _clamp(_to_float(profile.get("max_depth_imbalance"), 0.84) + 0.02, 0.55, 0.86),
                    6,
                ),
                "replace_price_bps": round(
                    _clamp(_to_float(profile.get("replace_price_bps"), 0.35) - 0.1, 0.22, 1.4),
                    6,
                ),
                "cancel_on_fill_score_guard": False,
                "replace_on_fill_score_guard": True,
                "replace_on_soft_guard": True,
                "replace_on_depth_imbalance_guard": True,
                "imbalance_reduce_size_ratio": 0.7,
                "calibration_source": "execution_fill_events_bingx" if fill_count > 0 else str(profile.get("calibration_source") or "default_bingx"),
            }
        )
        if fill_count <= 0:
            profile.update(
                {
                    "min_fill_probability": 0.3,
                    "max_latency_ms": 150.0,
                    "latency_soft_ms": 100.0,
                    "max_freshness_ms": 300.0,
                    "freshness_soft_ms": 220.0,
                    "max_depth_imbalance": 0.84,
                    "replace_on_depth_imbalance_guard": True,
                    "imbalance_reduce_size_ratio": 0.7,
                }
            )
    return profile


def initialize_queue_tracker(candidate: dict[str, Any], queue_edge_snapshot: dict[str, Any]) -> dict[str, Any]:
    queue_ahead_usd = max(0.0, _to_float(queue_edge_snapshot.get("queue_ahead_usd"), 0.0))
    total_queue_usd = max(queue_ahead_usd, _to_float(candidate.get("available_depth_usd"), 0.0) * 0.16, 1.0)
    queue_rank_estimate = _clamp(queue_ahead_usd / total_queue_usd, 0.0, 1.0)
    return {
        "queue_position_usd": queue_ahead_usd,
        "total_queue_usd": total_queue_usd,
        "last_traded_volume_usd": 0.0,
        "last_canceled_volume_usd": 0.0,
        "queue_velocity_usd_per_sec": 0.0,
        "trade_intensity": 0.0,
        "cancel_rate_estimate": 0.0,
        "liquidity_decay_rate": 0.0,
        "queue_rank_estimate": round(queue_rank_estimate, 6),
        "time_in_queue_ms": 0.0,
        "updates": 0,
    }


def _best_level_notional(candidate: dict[str, Any], side: str) -> float:
    book = _as_dict(candidate.get("depth_payload"))
    key = "bids" if side == "buy" else "asks"
    rows = book.get(key)
    if not isinstance(rows, list) or not rows:
        return 0.0
    level = rows[0]
    if not (isinstance(level, list) and len(level) >= 2):
        return 0.0
    return max(0.0, _to_float(level[0], 0.0) * _to_float(level[1], 0.0))


def update_queue_tracker(
    tracker: dict[str, Any],
    previous_candidate: dict[str, Any] | None,
    current_candidate: dict[str, Any],
    side: str,
    loop_elapsed_ms: float,
) -> dict[str, Any]:
    state = dict(tracker)
    previous = previous_candidate if isinstance(previous_candidate, dict) else {}
    previous_best = _best_level_notional(previous, side)
    current_best = _best_level_notional(current_candidate, side)
    delta_negative = max(0.0, previous_best - current_best)
    elapsed_scale = max(0.25, loop_elapsed_ms / 1000.0)
    incoming_flow_usd = max(0.0, _to_float(current_candidate.get("incoming_flow_usd_per_min"), 0.0) / 60.0 * elapsed_scale)
    traded_volume_usd = incoming_flow_usd * 0.42
    queue_position_usd = max(0.0, _to_float(state.get("queue_position_usd"), 0.0) - delta_negative - traded_volume_usd)
    total_queue_usd = max(queue_position_usd, _to_float(state.get("total_queue_usd"), 0.0), current_best, 1.0)
    queue_velocity_usd_per_sec = max(0.0, (delta_negative + traded_volume_usd) / elapsed_scale)
    trade_intensity = _clamp(_to_float(current_candidate.get("incoming_flow_usd_per_min"), 0.0) / max(total_queue_usd, 1.0), 0.0, 1.0)
    cancel_rate_estimate = _clamp(delta_negative / max(previous_best, 1.0), 0.0, 1.0)
    liquidity_decay_rate = _clamp((delta_negative / max(previous_best, 1.0)) / elapsed_scale, 0.0, 1.0)
    queue_rank_estimate = _clamp(queue_position_usd / total_queue_usd, 0.0, 1.0)
    time_in_queue_ms = max(0.0, _to_float(state.get("time_in_queue_ms"), 0.0) + loop_elapsed_ms)
    state.update(
        {
            "queue_position_usd": round(queue_position_usd, 6),
            "total_queue_usd": round(total_queue_usd, 6),
            "last_traded_volume_usd": round(traded_volume_usd, 6),
            "last_canceled_volume_usd": round(delta_negative, 6),
            "queue_velocity_usd_per_sec": round(queue_velocity_usd_per_sec, 6),
            "trade_intensity": round(trade_intensity, 6),
            "cancel_rate_estimate": round(cancel_rate_estimate, 6),
            "liquidity_decay_rate": round(liquidity_decay_rate, 6),
            "queue_rank_estimate": round(queue_rank_estimate, 6),
            "time_in_queue_ms": round(time_in_queue_ms, 6),
            "updates": int(_to_float(state.get("updates"), 0.0)) + 1,
        }
    )
    return state


def _midpoint_price(candidate: dict[str, Any]) -> float:
    best_bid = _to_float(candidate.get("best_bid"), 0.0)
    best_ask = _to_float(candidate.get("best_ask"), 0.0)
    if best_bid > 0 and best_ask > 0 and best_ask >= best_bid:
        return (best_bid + best_ask) / 2.0
    return _to_float(candidate.get("mark_price"), 0.0)


def _estimate_time_to_fill_ms(queue_position_usd: float, queue_velocity_usd_per_sec: float, trade_intensity: float) -> float | None:
    effective_velocity = max(0.0, queue_velocity_usd_per_sec) + max(0.0, trade_intensity) * 45.0
    if effective_velocity <= 0:
        return None
    return max(0.0, queue_position_usd / effective_velocity * 1000.0)


def compute_live_fill_score(
    queue_tracker: dict[str, Any],
    current_candidate: dict[str, Any],
    desk_profile: dict[str, Any],
    context_adjustments: dict[str, Any] | None = None,
) -> dict[str, Any]:
    context = context_adjustments if isinstance(context_adjustments, dict) else {}
    queue_position_usd = max(0.0, _to_float(queue_tracker.get("queue_position_usd"), 0.0))
    total_queue_usd = max(1.0, _to_float(queue_tracker.get("total_queue_usd"), 1.0))
    queue_rank_estimate = _clamp(_to_float(queue_tracker.get("queue_rank_estimate"), queue_position_usd / total_queue_usd), 0.0, 1.0)
    queue_factor = 1.0 - queue_rank_estimate
    trade_flow = _clamp(_to_float(queue_tracker.get("trade_intensity"), _to_float(current_candidate.get("incoming_flow_usd_per_min"), 0.0) / max(total_queue_usd, 1.0)), 0.0, 1.0)
    cancel_rate_estimate = _clamp(_to_float(queue_tracker.get("cancel_rate_estimate"), 0.0), 0.0, 1.0)
    liquidity_decay_rate = _clamp(_to_float(queue_tracker.get("liquidity_decay_rate"), 0.0), 0.0, 1.0)
    queue_velocity_usd_per_sec = max(0.0, _to_float(queue_tracker.get("queue_velocity_usd_per_sec"), 0.0))
    time_in_queue_ms = max(0.0, _to_float(queue_tracker.get("time_in_queue_ms"), 0.0))
    latency_penalty = _clamp(_to_float(current_candidate.get("latency_ms"), 0.0) / max(_to_float(desk_profile.get("max_latency_ms"), 350.0), 1.0), 0.0, 1.0)
    freshness_penalty = _clamp(_to_float(current_candidate.get("freshness_ms"), 0.0) / max(_to_float(desk_profile.get("max_freshness_ms"), 45000.0), 1.0), 0.0, 1.0)
    depth_imbalance = abs(_to_float(current_candidate.get("depth_imbalance"), 0.0))
    volume_imbalance = abs(_to_float(current_candidate.get("volume_imbalance"), 0.0))
    spread_bps = max(0.0, _to_float(current_candidate.get("spread_bps"), 0.0))
    volatility = _clamp((depth_imbalance * 0.55) + (volume_imbalance * 0.45), 0.0, 1.0)
    entry_boost = 0.0
    if spread_bps > 0 and spread_bps <= max(0.0, _to_float(desk_profile.get("entry_boost_spread_bps"), 0.0)):
        entry_boost = max(0.0, _to_float(desk_profile.get("entry_boost_fill_score"), 0.0))
    entry_boost += max(0.0, _to_float(context.get("entry_boost_adjustment"), 0.0))
    confidence = _clamp((1.0 - latency_penalty) * 0.45 + (1.0 - freshness_penalty) * 0.35 + (1.0 - volatility) * 0.2, 0.0, 1.0)
    confidence = _clamp(confidence * 0.78 + _clamp(_to_float(context.get("confidence"), confidence), 0.0, 1.0) * 0.22, 0.0, 1.0)
    probabilistic_fill_probability = _clamp(
        queue_factor + trade_flow * 0.6 + cancel_rate_estimate * 0.4 - latency_penalty * 0.18 - freshness_penalty * 0.08 - volatility * 0.16 + entry_boost,
        0.0,
        1.0,
    )
    aggressiveness = 0.0
    if time_in_queue_ms > 1000.0:
        aggressiveness += 0.3
    if time_in_queue_ms > max(1200.0, _to_float(desk_profile.get("queue_time_reprice_ms"), 2000.0)):
        aggressiveness += 0.2
    if depth_imbalance > 0.8:
        aggressiveness += 0.4
    if 0.0 < spread_bps <= max(1.0, _to_float(desk_profile.get("entry_boost_spread_bps"), 0.0)):
        aggressiveness += 0.2
    if queue_rank_estimate > _to_float(desk_profile.get("queue_tail_reprice_threshold"), 0.68):
        aggressiveness += 0.15
    aggressiveness *= _clamp(_to_float(context.get("aggressiveness_multiplier"), 1.0), 0.5, 1.25)
    aggressiveness = _clamp(aggressiveness, 0.0, 1.0)
    adverse_selection_score = _clamp(volatility * 0.46 + latency_penalty * 0.16 + freshness_penalty * 0.1 + liquidity_decay_rate * 0.12 + aggressiveness * 0.16, 0.0, 1.0)
    dominance_score = _clamp(probabilistic_fill_probability * 0.4 + queue_factor * 0.3 + aggressiveness * 0.3, 0.0, 1.0)
    should_move_ahead = bool(
        (queue_rank_estimate > _to_float(desk_profile.get("queue_tail_reprice_threshold"), 0.68) and aggressiveness >= _to_float(desk_profile.get("aggressiveness_reprice_threshold"), 0.6))
        or (liquidity_decay_rate > 0.12 and trade_flow > 0.12)
    )
    time_to_fill_estimate_ms = _estimate_time_to_fill_ms(queue_position_usd, queue_velocity_usd_per_sec, trade_flow)
    fill_score = _clamp(
        queue_factor * 0.28
        + trade_flow * 0.22
        + probabilistic_fill_probability * 0.24
        + dominance_score * 0.08
        - latency_penalty * 0.11
        - freshness_penalty * 0.05
        - adverse_selection_score * 0.08
        + entry_boost,
        0.0,
        1.0,
    )
    effective_fill_probability = _clamp(probabilistic_fill_probability * 0.62 + fill_score * 0.38, 0.0, 1.0)
    return {
        "fill_score": round(fill_score, 6),
        "effective_fill_probability": round(effective_fill_probability, 6),
        "probabilistic_fill_probability": round(probabilistic_fill_probability, 6),
        "queue_factor": round(queue_factor, 6),
        "queue_rank_estimate": round(queue_rank_estimate, 6),
        "trade_flow_score": round(trade_flow, 6),
        "trade_intensity": round(trade_flow, 6),
        "cancel_rate_estimate": round(cancel_rate_estimate, 6),
        "latency_penalty": round(latency_penalty, 6),
        "freshness_penalty": round(freshness_penalty, 6),
        "volatility_score": round(volatility, 6),
        "entry_boost": round(entry_boost, 6),
        "confidence": round(confidence, 6),
        "aggressiveness": round(aggressiveness, 6),
        "time_in_queue_ms": round(time_in_queue_ms, 6),
        "time_to_fill_estimate_ms": round(time_to_fill_estimate_ms, 6) if time_to_fill_estimate_ms is not None else None,
        "liquidity_decay_rate": round(liquidity_decay_rate, 6),
        "adverse_selection_score": round(adverse_selection_score, 6),
        "dominance_score": round(dominance_score, 6),
        "should_move_ahead": should_move_ahead,
        "context_size_multiplier": round(_clamp(_to_float(context.get("size_multiplier"), 1.0), 0.2, 1.0), 6),
        "context_no_trade": bool(context.get("no_trade")),
        "context_no_trade_reasons": [str(reason) for reason in context.get("no_trade_reasons", []) if str(reason)],
    }


def compute_execution_timing(current_candidate: dict[str, Any], queue_edge: float, fill_score: float) -> str:
    incoming_momentum = _clamp(abs(_to_float(current_candidate.get("volume_imbalance"), 0.0)), 0.0, 1.0)
    if queue_edge > 0.8 or fill_score > 0.82:
        return "EXECUTE_NOW"
    if incoming_momentum > 0.7:
        return "FRONT_RUN_QUEUE"
    return "WAIT"


def detect_liquidity_trap(
    current_candidate: dict[str, Any],
    fill_snapshot: dict[str, Any],
    desk_profile: dict[str, Any],
) -> dict[str, Any]:
    visible_depth_usd = max(0.0, _to_float(current_candidate.get("available_depth_usd"), 0.0))
    trade_intensity = _clamp(_to_float(fill_snapshot.get("trade_intensity"), 0.0), 0.0, 1.0)
    liquidity_decay_rate = _clamp(_to_float(fill_snapshot.get("liquidity_decay_rate"), 0.0), 0.0, 1.0)
    depth_imbalance = abs(_to_float(current_candidate.get("depth_imbalance"), 0.0))
    time_in_queue_ms = max(0.0, _to_float(fill_snapshot.get("time_in_queue_ms"), 0.0))
    trap_depth_threshold = max(1500.0, _to_float(desk_profile.get("spoof_notional_usd"), 15000.0) * 0.3)
    trap_trade_threshold = _clamp(_to_float(desk_profile.get("liquidity_trap_trade_intensity"), 0.08), 0.01, 0.3)
    trap_decay_threshold = _clamp(_to_float(desk_profile.get("liquidity_trap_decay_rate"), 0.04), 0.01, 0.3)
    trap_score = _clamp(
        (visible_depth_usd / max(trap_depth_threshold, 1.0)) * 0.32
        + max(0.0, trap_trade_threshold - trade_intensity) * 4.0 * 0.28
        + max(0.0, trap_decay_threshold - liquidity_decay_rate) * 6.0 * 0.2
        + max(0.0, depth_imbalance - 0.75) * 0.2
        + (_clamp((time_in_queue_ms - 1200.0) / 2000.0, 0.0, 1.0) * 0.12),
        0.0,
        1.0,
    )
    liquidity_trap_detected = bool(
        (
            visible_depth_usd >= trap_depth_threshold
            and trade_intensity <= trap_trade_threshold
            and liquidity_decay_rate <= trap_decay_threshold
            and depth_imbalance >= 0.78
        )
        or trap_score >= 0.72
    )
    return {
        "liquidity_trap_detected": liquidity_trap_detected,
        "liquidity_trap_score": round(trap_score, 6),
    }


def detect_spoof_signal(
    previous_candidate: dict[str, Any] | None,
    current_candidate: dict[str, Any],
    side: str,
    desk_profile: dict[str, Any],
    loop_elapsed_ms: float,
) -> dict[str, Any]:
    previous = previous_candidate if isinstance(previous_candidate, dict) else {}
    previous_best = _best_level_notional(previous, side)
    current_best = _best_level_notional(current_candidate, side)
    available_depth_usd = max(0.0, _to_float(current_candidate.get("available_depth_usd"), 0.0))
    spoof_notional_usd = max(1000.0, _to_float(desk_profile.get("spoof_notional_usd"), 15000.0))
    spoof_size_multiple = max(1.0, _to_float(desk_profile.get("spoof_size_multiple"), 3.5))
    spoof_lifetime_ms = max(100.0, _to_float(desk_profile.get("spoof_lifetime_ms"), 1500.0))
    wall_size_ratio = previous_best / max(available_depth_usd, 1.0) if available_depth_usd > 0 else 0.0
    vanished_fast = loop_elapsed_ms <= spoof_lifetime_ms and previous_best > 0 and current_best <= previous_best * 0.25
    is_spoof = previous_best >= spoof_notional_usd and wall_size_ratio >= min(0.95, 1.0 / spoof_size_multiple) and vanished_fast
    return {
        "spoof_detected": bool(is_spoof),
        "wall_notional_usd": round(previous_best, 6),
        "wall_size_ratio": round(wall_size_ratio, 6),
        "lifetime_ms": round(loop_elapsed_ms, 6),
    }


def adaptive_slippage_guard(
    current_candidate: dict[str, Any],
    desk_profile: dict[str, Any],
    fill_score: float,
    spoof_signal: dict[str, Any],
    liquidity_signal: dict[str, Any] | None = None,
    execution_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    context = execution_context if isinstance(execution_context, dict) else {}
    reasons: list[str] = []
    soft_reasons: list[str] = []
    latency_ms = _to_float(current_candidate.get("latency_ms"), 0.0)
    depth_imbalance = abs(_to_float(current_candidate.get("depth_imbalance"), 0.0))
    freshness_ms = _to_float(current_candidate.get("freshness_ms"), 0.0)
    spread_bps = _to_float(current_candidate.get("spread_bps"), 0.0)
    latency_soft_ms = _to_float(desk_profile.get("latency_soft_ms"), 0.0)
    freshness_soft_ms = _to_float(desk_profile.get("freshness_soft_ms"), 0.0)

    if latency_soft_ms > 0 and latency_ms > latency_soft_ms:
        soft_reasons.append("latency_soft_watch")
    if freshness_soft_ms > 0 and freshness_ms > freshness_soft_ms:
        soft_reasons.append("freshness_soft_watch")

    if latency_ms > _to_float(desk_profile.get("max_latency_ms"), 350.0):
        reasons.append("latency_above_profile")
    if depth_imbalance > _to_float(desk_profile.get("max_depth_imbalance"), 0.7):
        reasons.append("depth_imbalance_above_profile")
    if freshness_ms > _to_float(desk_profile.get("max_freshness_ms"), 45000.0):
        reasons.append("freshness_above_profile")
    if spread_bps > _to_float(desk_profile.get("max_spread_bps"), 12.0):
        reasons.append("spread_above_profile")
    if bool(spoof_signal.get("spoof_detected")):
        reasons.append("spoof_detected")
    if bool((liquidity_signal or {}).get("liquidity_trap_detected")):
        reasons.append("liquidity_trap_detected")
    if fill_score < _to_float(desk_profile.get("min_fill_probability"), 0.5):
        reasons.append("fill_score_below_profile")
    if bool(context.get("no_trade")):
        for reason in context.get("no_trade_reasons", []):
            normalized = str(reason).strip()
            if normalized:
                reasons.append(normalized)
    soft_guard_only = bool(reasons) and set(reasons).issubset(_soft_guard_reason_set(desk_profile))
    return {
        "allowed": not reasons,
        "reasons": reasons,
        "soft_reasons": soft_reasons,
        "soft_guard_only": soft_guard_only,
    }


def decide_order_lifecycle(
    current_candidate: dict[str, Any],
    queue_tracker: dict[str, Any],
    fill_snapshot: dict[str, Any],
    spoof_signal: dict[str, Any],
    guard: dict[str, Any],
    current_order: dict[str, Any],
    desk_profile: dict[str, Any],
) -> dict[str, Any]:
    fill_score = _to_float(fill_snapshot.get("fill_score"), 0.0)
    effective_fill_probability = _clamp(_to_float(fill_snapshot.get("effective_fill_probability"), fill_score), 0.0, 1.0)
    dominance_score = _clamp(_to_float(fill_snapshot.get("dominance_score"), effective_fill_probability), 0.0, 1.0)
    aggressiveness = _clamp(_to_float(fill_snapshot.get("aggressiveness"), 0.0), 0.0, 1.0)
    adverse_selection_score = _clamp(_to_float(fill_snapshot.get("adverse_selection_score"), 0.0), 0.0, 1.0)
    queue_rank_estimate = _clamp(_to_float(fill_snapshot.get("queue_rank_estimate"), 1.0), 0.0, 1.0)
    time_in_queue_ms = max(0.0, _to_float(fill_snapshot.get("time_in_queue_ms"), 0.0))
    should_move_ahead = _to_bool(fill_snapshot.get("should_move_ahead"), False)
    liquidity_trap_detected = _to_bool(fill_snapshot.get("liquidity_trap_detected"), False)
    liquidity_trap_score = _clamp(_to_float(fill_snapshot.get("liquidity_trap_score"), 0.0), 0.0, 1.0)
    cancel_below = _to_float(desk_profile.get("cancel_below_fill_probability"), 0.4)
    replace_below = _to_float(desk_profile.get("replace_below_fill_probability"), 0.7)
    upgrade_above = _to_float(desk_profile.get("upgrade_to_market_above"), 0.82)
    queue_time_reprice_ms = max(500.0, _to_float(desk_profile.get("queue_time_reprice_ms"), 2000.0))
    aggressiveness_reprice_threshold = _clamp(_to_float(desk_profile.get("aggressiveness_reprice_threshold"), 0.6), 0.2, 1.0)
    dominance_floor = _clamp(_to_float(desk_profile.get("dominance_floor"), 0.4), 0.1, 0.8)
    guard_reasons = {str(reason).strip() for reason in (guard.get("reasons") or []) if str(reason).strip()}
    soft_guard_only = bool(guard.get("soft_guard_only")) or (bool(guard_reasons) and guard_reasons.issubset(_soft_guard_reason_set(desk_profile)))
    fill_score_guard_only = bool(guard_reasons) and guard_reasons.issubset({"fill_score_below_profile"})
    imbalance_guard = "depth_imbalance_above_profile" in guard_reasons
    side = str(current_order.get("side") or "buy").strip().lower() or "buy"
    current_price = _to_float(current_order.get("price"), 0.0)
    order_type = str(current_order.get("order_type") or "LIMIT").strip().upper() or "LIMIT"
    if side == "buy":
        best_price = _to_float(current_candidate.get("best_bid"), 0.0)
        passive_target_price = best_price if best_price > 0 else current_price
        midpoint_price = _midpoint_price(current_candidate)
        aggressive_target_price = max(passive_target_price, midpoint_price) if midpoint_price > 0 else passive_target_price
        best_ask = _to_float(current_candidate.get("best_ask"), 0.0)
        if best_ask > 0:
            aggressive_target_price = min(aggressive_target_price, best_ask)
    else:
        best_price = _to_float(current_candidate.get("best_ask"), 0.0)
        passive_target_price = best_price if best_price > 0 else current_price
        midpoint_price = _midpoint_price(current_candidate)
        aggressive_target_price = min(passive_target_price, midpoint_price) if midpoint_price > 0 else passive_target_price
        best_bid = _to_float(current_candidate.get("best_bid"), 0.0)
        if best_bid > 0:
            aggressive_target_price = max(aggressive_target_price, best_bid)
    target_limit_price = aggressive_target_price if should_move_ahead or (time_in_queue_ms >= queue_time_reprice_ms and aggressiveness >= aggressiveness_reprice_threshold) else passive_target_price
    price_shift = current_price > 0 and target_limit_price > 0 and abs(current_price - target_limit_price) / max(target_limit_price, 1e-9) * 10000.0 >= max(0.8, _to_float(desk_profile.get("replace_price_bps"), 0.6))
    timing = compute_execution_timing(current_candidate, _clamp(1.0 - _to_float(queue_tracker.get("queue_position_usd"), 0.0) / max(_to_float(queue_tracker.get("total_queue_usd"), 1.0), 1.0), 0.0, 1.0), fill_score)
    if should_move_ahead:
        timing = "MOVE_AHEAD"
    elif aggressiveness >= aggressiveness_reprice_threshold:
        timing = "WORK_MID"

    dynamic_replace_threshold = _clamp(replace_below + aggressiveness * 0.16 + max(0.0, adverse_selection_score - 0.55) * 0.14, cancel_below + 0.02, 0.94)

    if liquidity_trap_detected:
        if liquidity_trap_score >= 0.9 or effective_fill_probability <= cancel_below:
            return {
                "action": "cancel",
                "reason": "liquidity_trap_detected",
                "timing": timing,
                "target_order_type": order_type,
                "target_price": round(current_price, 8) if current_price > 0 else None,
            }
        return {
            "action": "replace",
            "reason": "liquidity_trap_reduce",
            "timing": timing,
            "target_order_type": "LIMIT",
            "target_price": round(target_limit_price, 8) if target_limit_price > 0 else (round(current_price, 8) if current_price > 0 else None),
            "target_notional_scale": 0.6,
        }

    if not bool(guard.get("allowed")):
        if imbalance_guard and _to_bool(desk_profile.get("replace_on_depth_imbalance_guard"), False):
            size_scale = _clamp(_to_float(desk_profile.get("imbalance_reduce_size_ratio"), 0.7), 0.2, 1.0)
            return {
                "action": "replace",
                "reason": "depth_imbalance_reprice",
                "timing": timing,
                "target_order_type": "LIMIT",
                "target_price": round(target_limit_price, 8) if target_limit_price > 0 else (round(current_price, 8) if current_price > 0 else None),
                "target_notional_scale": round(size_scale, 6),
            }
        if soft_guard_only and _to_bool(desk_profile.get("replace_on_soft_guard"), False):
            return {
                "action": "replace",
                "reason": "soft_guard_reprice",
                "timing": timing,
                "target_order_type": "LIMIT",
                "target_price": round(target_limit_price, 8) if target_limit_price > 0 else (round(current_price, 8) if current_price > 0 else None),
            }
        if fill_score_guard_only and _to_bool(desk_profile.get("replace_on_fill_score_guard"), False):
            return {
                "action": "replace",
                "reason": "fill_score_soft_guard",
                "timing": timing,
                "target_order_type": "LIMIT",
                "target_price": round(target_limit_price, 8) if target_limit_price > 0 else (round(current_price, 8) if current_price > 0 else None),
            }
        return {
            "action": "cancel",
            "reason": "fill_score_or_guard",
            "timing": timing,
            "target_order_type": order_type,
            "target_price": round(current_price, 8) if current_price > 0 else None,
        }
    if effective_fill_probability < cancel_below and dominance_score < dominance_floor * 0.9:
        if _to_bool(desk_profile.get("cancel_on_fill_score_guard"), True):
            return {
                "action": "cancel",
                "reason": "fill_score_or_guard",
                "timing": timing,
                "target_order_type": order_type,
                "target_price": round(current_price, 8) if current_price > 0 else None,
            }
        return {
            "action": "replace",
            "reason": "fill_score_soft_guard",
            "timing": timing,
            "target_order_type": "LIMIT",
            "target_price": round(target_limit_price, 8) if target_limit_price > 0 else (round(current_price, 8) if current_price > 0 else None),
        }
    if bool(spoof_signal.get("spoof_detected")):
        return {
            "action": "cancel",
            "reason": "spoof_detected",
            "timing": timing,
            "target_order_type": order_type,
            "target_price": round(current_price, 8) if current_price > 0 else None,
        }
    if effective_fill_probability > upgrade_above and adverse_selection_score < 0.78 and str(current_order.get("status") or "open") != "filled" and order_type != "MARKET":
        return {
            "action": "upgrade_to_market",
            "reason": "fill_score_high",
            "timing": timing,
            "target_order_type": "MARKET",
            "target_price": None,
        }
    if order_type == "LIMIT" and target_limit_price > 0 and time_in_queue_ms >= queue_time_reprice_ms and (should_move_ahead or queue_rank_estimate >= _to_float(desk_profile.get("queue_tail_reprice_threshold"), 0.68)) and price_shift:
        return {
            "action": "replace",
            "reason": "queue_reprice_mid",
            "timing": timing,
            "target_order_type": "LIMIT",
            "target_price": round(target_limit_price, 8),
        }
    if effective_fill_probability < dynamic_replace_threshold or fill_score < dynamic_replace_threshold or price_shift:
        return {
            "action": "replace",
            "reason": "price_shift_or_fill_score",
            "timing": timing,
            "target_order_type": "LIMIT",
            "target_price": round(target_limit_price, 8) if target_limit_price > 0 else None,
        }
    return {
        "action": "keep",
        "reason": "queue_and_fill_stable",
        "timing": timing,
        "target_order_type": order_type,
        "target_price": round(current_price, 8) if current_price > 0 else (round(target_limit_price, 8) if target_limit_price > 0 else None),
    }