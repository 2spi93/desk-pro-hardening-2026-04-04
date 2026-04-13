from __future__ import annotations

from typing import Any

PASSIVE_EXECUTION_STYLES = {"maker_passive", "passive_selective", "passive_staggered", "primary_only"}


def _to_float(value: object, default: float = 0.0) -> float:
    try:
        return float(value)
    except Exception:
        return default


def _clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def _as_dict(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _desk_profile_value(desk_profile: dict[str, Any] | None, key: str, fallback: float) -> float:
    if not isinstance(desk_profile, dict):
        return fallback
    return _to_float(desk_profile.get(key), fallback)


def _depth_rows(book: dict[str, Any], side: str) -> list[list[object]]:
    key = "bids" if side == "buy" else "asks"
    rows = book.get(key)
    return rows if isinstance(rows, list) else []


def _reference_price(candidate: dict[str, Any]) -> float:
    mark_price = _to_float(candidate.get("mark_price"), 0.0)
    if mark_price > 0:
        return mark_price
    best_bid = _to_float(candidate.get("best_bid"), 0.0)
    best_ask = _to_float(candidate.get("best_ask"), 0.0)
    if best_bid > 0 and best_ask > 0:
        return (best_bid + best_ask) / 2.0
    return _to_float(candidate.get("last"), 0.0)


def _queue_ahead_usd(candidate: dict[str, Any], side: str) -> float:
    book = _as_dict(candidate.get("depth_payload"))
    levels = _depth_rows(book, side)
    if not levels:
        return 0.0
    queue_priority_bias = _clamp(_to_float(candidate.get("queue_priority_bias"), 0.8), 0.35, 1.0)
    weighted_notional = 0.0
    for index, level in enumerate(levels[:3]):
        if not (isinstance(level, list) and len(level) >= 2):
            continue
        price = _to_float(level[0], 0.0)
        size = _to_float(level[1], 0.0)
        if price <= 0 or size <= 0:
            continue
        weight = 1.0 if index == 0 else 0.35 if index == 1 else 0.15
        weighted_notional += price * size * weight
    return max(0.0, weighted_notional * (0.78 + queue_priority_bias * 0.22))


def _incoming_flow_usd_per_min(candidate: dict[str, Any]) -> float:
    flow_usd = _to_float(candidate.get("incoming_flow_usd_per_min"), 0.0)
    if flow_usd > 0:
        return flow_usd
    tape_acceleration = _to_float(candidate.get("tape_acceleration"), 0.0)
    return max(0.0, tape_acceleration * max(_reference_price(candidate), 0.0))


def compute_queue_edge(candidate: dict[str, Any], side: str, notional_usd: float) -> dict[str, float]:
    queue_ahead_usd = _queue_ahead_usd(candidate, side)
    incoming_flow_usd_per_min = _incoming_flow_usd_per_min(candidate)
    freshness_ms = max(0.0, _to_float(candidate.get("freshness_ms"), 0.0))
    queue_priority_bias = _clamp(_to_float(candidate.get("queue_priority_bias"), 0.8), 0.35, 1.0)
    queue_anchor_usd = max(1.0, queue_ahead_usd, max(1.0, notional_usd) * 0.65)
    raw_edge = min(1.0, incoming_flow_usd_per_min / queue_anchor_usd) if incoming_flow_usd_per_min > 0 else 0.0
    freshness_penalty = _clamp(freshness_ms / 60000.0, 0.0, 1.0)
    edge = _clamp(raw_edge * (0.58 + queue_priority_bias * 0.42) * (1.0 - freshness_penalty * 0.22), 0.0, 1.0)
    return {
        "queue_ahead_usd": round(queue_ahead_usd, 6),
        "incoming_flow_usd_per_min": round(incoming_flow_usd_per_min, 6),
        "queue_edge": round(edge, 6),
    }


def _volatility_score(candidate: dict[str, Any]) -> float:
    spread_bps = abs(_to_float(candidate.get("spread_bps"), 0.0))
    depth_imbalance = abs(_to_float(candidate.get("depth_imbalance"), 0.0))
    volume_imbalance = abs(_to_float(candidate.get("volume_imbalance"), 0.0))
    freshness_ms = max(0.0, _to_float(candidate.get("freshness_ms"), 0.0))
    spread_component = _clamp(spread_bps / 12.0, 0.0, 1.0)
    imbalance_component = _clamp(abs(depth_imbalance - volume_imbalance), 0.0, 1.0)
    pressure_component = _clamp((depth_imbalance + volume_imbalance) / 2.0, 0.0, 1.0)
    freshness_component = _clamp(freshness_ms / 60000.0, 0.0, 1.0)
    return _clamp(
        spread_component * 0.34
        + imbalance_component * 0.31
        + pressure_component * 0.17
        + freshness_component * 0.18,
        0.0,
        1.0,
    )


def predict_fill_probability(candidate: dict[str, Any], side: str, notional_usd: float, queue_edge: float) -> dict[str, float]:
    baseline_fill_probability = _clamp(_to_float(candidate.get("fill_probability"), 0.0), 0.0, 1.0)
    spread_bps = max(0.0, _to_float(candidate.get("spread_bps"), 0.0))
    latency_ms = max(0.0, _to_float(candidate.get("latency_ms"), 0.0))
    available_depth_usd = max(0.0, _to_float(candidate.get("available_depth_usd"), 0.0))
    depth_cover_ratio = available_depth_usd / max(notional_usd, 1e-9) if notional_usd > 0 else 0.0
    depth_support = _clamp(depth_cover_ratio / 4.0, 0.0, 1.0)
    volatility_score = _volatility_score(candidate)
    spread_penalty = _clamp(spread_bps / 12.0, 0.0, 1.0)
    latency_penalty = _clamp(latency_ms / 350.0, 0.0, 1.0)
    flow_alignment = _to_float(candidate.get("volume_imbalance"), 0.0)
    if side == "sell":
        flow_alignment *= -1.0
    flow_bonus = _clamp(flow_alignment, -1.0, 1.0) * 0.08
    predicted_fill_probability = _clamp(
        baseline_fill_probability * 0.32
        + queue_edge * 0.32
        + depth_support * 0.16
        + (1.0 - spread_penalty) * 0.12
        + flow_bonus
        - volatility_score * 0.18
        - latency_penalty * 0.12,
        0.0,
        1.0,
    )
    expected_slippage_bps = max(
        0.2,
        spread_bps * (0.42 + volatility_score * 0.58)
        + max(0.0, 1.35 - depth_cover_ratio) * 2.2
        + max(0.0, latency_ms - 80.0) / 180.0,
    )
    return {
        "baseline_fill_probability": round(baseline_fill_probability, 6),
        "predicted_fill_probability": round(predicted_fill_probability, 6),
        "volatility_score": round(volatility_score, 6),
        "depth_cover_ratio": round(depth_cover_ratio, 6),
        "expected_slippage_bps": round(expected_slippage_bps, 6),
    }


def slippage_guard(candidate: dict[str, Any], fill_prediction: dict[str, float], desk_profile: dict[str, Any] | None = None) -> dict[str, Any]:
    reasons: list[str] = []
    spread_bps = max(0.0, _to_float(candidate.get("spread_bps"), 0.0))
    volatility_score = _to_float(fill_prediction.get("volatility_score"), 0.0)
    depth_cover_ratio = _to_float(fill_prediction.get("depth_cover_ratio"), 0.0)
    latency_ms = max(0.0, _to_float(candidate.get("latency_ms"), 0.0))
    fill_probability = _clamp(_to_float(fill_prediction.get("predicted_fill_probability"), 0.0), 0.0, 1.0)
    freshness_ms = max(0.0, _to_float(candidate.get("freshness_ms"), 0.0))
    max_spread_bps = _desk_profile_value(desk_profile, "max_spread_bps", 12.0)
    max_latency_ms = _desk_profile_value(desk_profile, "max_latency_ms", 350.0)
    min_depth_cover_ratio = _desk_profile_value(desk_profile, "min_depth_cover_ratio", 1.4)
    max_freshness_ms = _desk_profile_value(desk_profile, "max_freshness_ms", 45000.0)
    min_fill_probability = _desk_profile_value(desk_profile, "min_fill_probability", 0.5)

    if spread_bps > max_spread_bps:
        reasons.append("spread_too_wide")
    if volatility_score > 0.82:
        reasons.append("volatility_too_high")
    if depth_cover_ratio < min_depth_cover_ratio:
        reasons.append("depth_too_thin")
    if latency_ms > max_latency_ms:
        reasons.append("latency_too_high")
    if freshness_ms > max_freshness_ms:
        reasons.append("market_data_too_stale")
    if fill_probability < min_fill_probability:
        reasons.append("fill_probability_below_0_5")

    risk_score = _clamp(
        spread_bps / 18.0 * 0.24
        + volatility_score * 0.3
        + max(0.0, 1.4 - depth_cover_ratio) * 0.22
        + min(1.0, latency_ms / 400.0) * 0.14
        + min(1.0, freshness_ms / 60000.0) * 0.1,
        0.0,
        1.0,
    )
    return {
        "allowed": not reasons,
        "reasons": reasons,
        "risk_score": round(risk_score, 6),
        "expected_slippage_bps": round(_to_float(fill_prediction.get("expected_slippage_bps"), 0.0), 6),
    }


def _passive_target_price(candidate: dict[str, Any], side: str) -> float:
    if side == "buy":
        return max(0.0, _to_float(candidate.get("best_bid"), 0.0))
    return max(0.0, _to_float(candidate.get("best_ask"), 0.0))


def _protective_limit_price(candidate: dict[str, Any], side: str) -> float:
    spread_bps = max(0.0, _to_float(candidate.get("spread_bps"), 0.0))
    best_ask = max(0.0, _to_float(candidate.get("best_ask"), 0.0))
    best_bid = max(0.0, _to_float(candidate.get("best_bid"), 0.0))
    offset_bps = max(0.4, min(4.0, spread_bps * 0.35))
    if side == "buy":
        if best_ask <= 0:
            return 0.0
        return best_ask * (1.0 + offset_bps / 10000.0)
    if best_bid <= 0:
        return 0.0
    return best_bid * (1.0 - offset_bps / 10000.0)


def manage_order(
    candidate: dict[str, Any],
    fill_prediction: dict[str, float],
    guard: dict[str, Any],
    execution_style: str,
    live_order_type: str,
    live_limit_price: float,
    side: str,
    desk_profile: dict[str, Any] | None = None,
) -> dict[str, Any]:
    fill_probability = _clamp(_to_float(fill_prediction.get("predicted_fill_probability"), 0.0), 0.0, 1.0)
    normalized_order_type = str(live_order_type or "MARKET").strip().upper() or "MARKET"
    normalized_style = str(execution_style or "default").strip().lower() or "default"
    passive_style = normalized_style in PASSIVE_EXECUTION_STYLES
    passive_target_price = _passive_target_price(candidate, side)
    protective_limit_price = _protective_limit_price(candidate, side)
    target_price = passive_target_price if passive_style and passive_target_price > 0 else protective_limit_price
    price_moved = False
    if target_price > 0 and live_limit_price > 0:
        price_moved = abs(live_limit_price - target_price) / max(target_price, 1e-9) * 10000.0 >= max(1.2, _to_float(candidate.get("spread_bps"), 0.0) * 0.55)
    cancel_below = _desk_profile_value(desk_profile, "cancel_below_fill_probability", 0.4)
    replace_below = _desk_profile_value(desk_profile, "replace_below_fill_probability", 0.7)

    if not bool(guard.get("allowed")) or fill_probability < cancel_below:
        return {
            "action": "cancel",
            "fill_band": "cancel",
            "reason": "fill_probability_or_slippage_guard",
            "target_order_type": normalized_order_type,
            "limit_price": round(live_limit_price, 8) if live_limit_price > 0 else None,
            "price_moved": price_moved,
        }

    if fill_probability < replace_below:
        return {
            "action": "replace",
            "fill_band": "adapt",
            "reason": "adapt_to_protective_limit",
            "target_order_type": "LIMIT",
            "limit_price": round(target_price, 8) if target_price > 0 else None,
            "price_moved": price_moved,
        }

    if passive_style and target_price > 0 and (normalized_order_type != "LIMIT" or live_limit_price <= 0 or price_moved):
        return {
            "action": "replace",
            "fill_band": "execute",
            "reason": "passive_queue_join",
            "target_order_type": "LIMIT",
            "limit_price": round(target_price, 8),
            "price_moved": price_moved,
        }

    return {
        "action": "keep",
        "fill_band": "execute",
        "reason": "fill_probability_confirmed",
        "target_order_type": normalized_order_type,
        "limit_price": round(live_limit_price, 8) if live_limit_price > 0 else (round(target_price, 8) if normalized_order_type == "LIMIT" and target_price > 0 else None),
        "price_moved": price_moved,
    }


def build_execution_optimizer_snapshot(
    candidate: dict[str, Any],
    side: str,
    notional_usd: float,
    execution_style: str,
    live_order_type: str,
    live_limit_price: float = 0.0,
    desk_profile: dict[str, Any] | None = None,
) -> dict[str, Any]:
    queue = compute_queue_edge(candidate, side, notional_usd)
    fill_prediction = predict_fill_probability(candidate, side, notional_usd, _to_float(queue.get("queue_edge"), 0.0))
    guard = slippage_guard(candidate, fill_prediction, desk_profile=desk_profile)
    order_management = manage_order(
        candidate,
        fill_prediction,
        guard,
        execution_style,
        live_order_type,
        live_limit_price,
        side,
        desk_profile=desk_profile,
    )
    return {
        "queue": queue,
        "fill_prediction": fill_prediction,
        "slippage_guard": guard,
        "order_management": order_management,
        "desk_profile": desk_profile if isinstance(desk_profile, dict) else {},
        "expected_slippage_bps": round(_to_float(fill_prediction.get("expected_slippage_bps"), 0.0), 6),
        "predicted_fill_probability": round(_to_float(fill_prediction.get("predicted_fill_probability"), 0.0), 6),
    }


def execution_optimizer_allows_trade(snapshot: dict[str, Any]) -> bool:
    guard = _as_dict(snapshot.get("slippage_guard"))
    order_management = _as_dict(snapshot.get("order_management"))
    execution_context = _as_dict(snapshot.get("execution_context"))
    return (
        bool(guard.get("allowed"))
        and str(order_management.get("action") or "keep") != "cancel"
        and not bool(execution_context.get("no_trade"))
    )


def apply_order_management_to_live_context(live_context: dict[str, Any], snapshot: dict[str, Any]) -> dict[str, Any]:
    order_management = _as_dict(snapshot.get("order_management"))
    execution_context = _as_dict(snapshot.get("execution_context"))
    if not order_management:
        return dict(live_context)
    adapted = dict(live_context)
    target_order_type = str(order_management.get("target_order_type") or adapted.get("order_type") or "MARKET").strip().upper() or "MARKET"
    adapted["order_type"] = target_order_type
    limit_price = _to_float(order_management.get("limit_price"), 0.0)
    if target_order_type == "LIMIT" and limit_price > 0:
        adapted["price"] = limit_price
    elif target_order_type == "MARKET":
        adapted.pop("price", None)
    target_notional_usd = _to_float(execution_context.get("target_notional_usd"), 0.0)
    current_notional_usd = _to_float(adapted.get("notional_usd"), 0.0)
    if target_notional_usd > 0 and current_notional_usd > 0:
        adapted["notional_usd"] = min(current_notional_usd, target_notional_usd)
    return adapted