from __future__ import annotations

import asyncio
import math
import os
from datetime import datetime, timezone
from uuid import uuid4

import httpx
from fastapi import FastAPI, HTTPException

from shared.db import ensure_schema, execute, fetch_all, fetch_one, json_dumps
from shared.models import ExecutionRequest, OrderResult

app = FastAPI(title="Execution Router", version="0.1.0")

ORDERS: list[OrderResult] = []
POSITIONS: dict[str, float] = {}
MARKET_DATA_URL = os.getenv("MARKET_DATA_URL", "http://127.0.0.1:8003")
BROKER_ADAPTER_URL = os.getenv("BROKER_ADAPTER_URL", "http://127.0.0.1:8004")
VENUE_STABILITY: dict[str, dict[str, object]] = {}

VENUE_EXECUTION_PROFILES: dict[str, dict[str, object]] = {
    "binance": {
        "matching_rule": "price-time",
        "queue_priority_bias": 0.88,
        "hidden_liquidity_ratio": 0.1,
        "latency_base_ms": 16,
        "latency_jitter_ms": 4,
        "partial_fill_bias": 0.1,
    },
    "okx": {
        "matching_rule": "price-time",
        "queue_priority_bias": 0.84,
        "hidden_liquidity_ratio": 0.14,
        "latency_base_ms": 18,
        "latency_jitter_ms": 6,
        "partial_fill_bias": 0.14,
    },
    "bitget": {
        "matching_rule": "pro-rata-lite",
        "queue_priority_bias": 0.74,
        "hidden_liquidity_ratio": 0.18,
        "latency_base_ms": 21,
        "latency_jitter_ms": 8,
        "partial_fill_bias": 0.2,
    },
    "bingx": {
        "matching_rule": "pro-rata-lite",
        "queue_priority_bias": 0.7,
        "hidden_liquidity_ratio": 0.2,
        "latency_base_ms": 22,
        "latency_jitter_ms": 10,
        "partial_fill_bias": 0.24,
    },
    "hyperliquid": {
        "matching_rule": "price-time-auction",
        "queue_priority_bias": 0.78,
        "hidden_liquidity_ratio": 0.12,
        "latency_base_ms": 28,
        "latency_jitter_ms": 14,
        "partial_fill_bias": 0.16,
    },
    "default": {
        "matching_rule": "price-time",
        "queue_priority_bias": 0.8,
        "hidden_liquidity_ratio": 0.12,
        "latency_base_ms": 20,
        "latency_jitter_ms": 8,
        "partial_fill_bias": 0.16,
    },
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalize_symbol(symbol: str) -> str:
    return symbol.replace("-PERP", "").replace("/", "").replace("-", "").upper()


def _market_symbol(symbol: str) -> str:
    normalized = _normalize_symbol(symbol)
    if normalized.endswith("USD") and not normalized.endswith("USDT"):
        return f"{normalized[:-3]}USDT"
    return normalized


def _to_float(value: object, default: float = 0.0) -> float:
    try:
        return float(value)
    except Exception:
        return default


def _clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def _as_dict(value: object) -> dict[str, object]:
    return value if isinstance(value, dict) else {}


def _as_list(value: object) -> list[dict[str, object]]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def _live_execution_context(payload: dict[str, object]) -> dict[str, object]:
    live = _as_dict(payload.get("live_execution"))
    metadata = _as_dict(payload.get("metadata"))
    provider = str(live.get("provider") or metadata.get("provider") or "").strip().lower()
    account_id = str(live.get("account_id") or metadata.get("account_id") or "").strip()
    secret_payload = live.get("secret_payload") if isinstance(live.get("secret_payload"), dict) else None
    enabled = bool(live.get("enabled")) and provider == "bingx" and bool(account_id) and isinstance(secret_payload, dict)
    return {
        "enabled": enabled,
        "provider": provider,
        "account_id": account_id,
        "secret_payload": secret_payload,
        "order_type": str(live.get("order_type") or payload.get("order_type") or "MARKET").strip().upper(),
        "time_in_force": str(live.get("time_in_force") or payload.get("time_in_force") or "GTC").strip().upper(),
        "position_side": str(live.get("position_side") or payload.get("position_side") or "").strip().upper(),
        "reduce_only": bool(live.get("reduce_only", payload.get("reduce_only", False))),
        "price": _to_float(live.get("price") or payload.get("price"), 0.0),
        "quantity": _to_float(live.get("quantity") or payload.get("quantity"), 0.0),
        "notional_usd": _to_float(live.get("notional_usd") or payload.get("estimated_notional_usd"), 0.0),
        "client_order_id": str(live.get("client_order_id") or payload.get("client_order_id") or "").strip(),
    }


async def _execute_live_order(payload: dict[str, object], live_context: dict[str, object], decision_id: str) -> dict[str, object]:
    request_payload: dict[str, object] = {
        "provider": str(live_context.get("provider") or "bingx"),
        "account_id": str(live_context.get("account_id") or ""),
        "secret_payload": live_context.get("secret_payload"),
        "symbol": str(payload.get("symbol") or ""),
        "side": str(payload.get("side") or "buy"),
        "notional_usd": _to_float(live_context.get("notional_usd"), 0.0),
        "order_type": str(live_context.get("order_type") or "MARKET"),
        "time_in_force": str(live_context.get("time_in_force") or "GTC"),
        "position_side": str(live_context.get("position_side") or ""),
        "reduce_only": bool(live_context.get("reduce_only", False)),
        "client_order_id": str(live_context.get("client_order_id") or f"txt-{decision_id}")[:40],
    }
    if _to_float(live_context.get("price"), 0.0) > 0:
        request_payload["price"] = _to_float(live_context.get("price"), 0.0)
    if _to_float(live_context.get("quantity"), 0.0) > 0:
        request_payload["quantity"] = _to_float(live_context.get("quantity"), 0.0)

    async with httpx.AsyncClient(timeout=25.0) as client:
        response = await client.post(f"{BROKER_ADAPTER_URL}/v1/live/orders", json=request_payload)
    if response.status_code >= 400:
        detail: object
        try:
            detail = response.json()
        except ValueError:
            detail = response.text[:500]
        raise HTTPException(status_code=502 if response.status_code >= 500 else response.status_code, detail=detail)
    body = response.json()
    if not isinstance(body, dict):
        raise HTTPException(status_code=502, detail="broker-adapter returned invalid live order payload")
    return body


def _resolve_execution_delay_ms(payload: dict[str, object] | None = None) -> int:
    source = payload if isinstance(payload, dict) else {}
    metadata = source.get("metadata") if isinstance(source.get("metadata"), dict) else {}
    order_intent = source.get("order_intent") if isinstance(source.get("order_intent"), dict) else {}
    candidates = [
        source.get("execution_delay_ms"),
        metadata.get("execution_delay_ms"),
        order_intent.get("execution_delay_ms"),
    ]
    for candidate in candidates:
        try:
            return max(0, min(5000, int(float(candidate))))
        except Exception:
            continue
    return 0


def _normalize_route_mode_override(value: object) -> str:
    normalized = str(value or "").strip()
    lowered = normalized.lower()
    if lowered in {"", "none", "default"}:
        return ""
    if lowered in {"bestsinglevenue", "best_single_venue", "best-single-venue"}:
        return "bestSingleVenue"
    if lowered in {"dualvenueexecution", "dual_venue_execution", "dual-venue-execution"}:
        return "dualVenueExecution"
    return normalized


def _normalize_execution_style(value: object) -> str:
    normalized = str(value or "").strip().lower()
    return normalized or "default"


def _resolve_route_preferences(payload: dict[str, object] | None = None) -> dict[str, object]:
    source = payload if isinstance(payload, dict) else {}
    metadata = source.get("metadata") if isinstance(source.get("metadata"), dict) else {}
    order_intent = source.get("order_intent") if isinstance(source.get("order_intent"), dict) else {}
    memory_pretrade = metadata.get("memory_v2_pretrade") if isinstance(metadata.get("memory_v2_pretrade"), dict) else {}
    memory_applied = memory_pretrade.get("applied") if isinstance(memory_pretrade.get("applied"), dict) else {}

    preferred_venue = ""
    for candidate in (source.get("preferred_venue"), metadata.get("preferred_venue"), order_intent.get("preferred_venue")):
        value = str(candidate or "").strip()
        if value:
            preferred_venue = value
            break

    route_mode_override = ""
    for candidate in (
        source.get("route_mode_override"),
        source.get("route_mode"),
        metadata.get("route_mode_override"),
        metadata.get("route_mode"),
        order_intent.get("route_mode_override"),
        order_intent.get("route_mode"),
        memory_applied.get("route_mode_override"),
    ):
        route_mode_override = _normalize_route_mode_override(candidate)
        if route_mode_override:
            break

    execution_style = "default"
    for candidate in (
        source.get("execution_style"),
        metadata.get("execution_style"),
        order_intent.get("execution_style"),
        memory_applied.get("execution_style"),
    ):
        execution_style = _normalize_execution_style(candidate)
        if execution_style != "default":
            break

    return {
        "preferred_venue": preferred_venue,
        "route_mode_override": route_mode_override,
        "execution_style": execution_style,
    }


def _extract_pre_trade_memory_gate(payload: dict[str, object] | None = None) -> dict[str, object] | None:
    source = payload if isinstance(payload, dict) else {}
    metadata = source.get("metadata") if isinstance(source.get("metadata"), dict) else {}
    gate = metadata.get("pre_trade_memory_gate")
    return gate if isinstance(gate, dict) else None


def _best_quote_alignment(candidate: dict[str, object], side: str, best_bid: float, best_ask: float) -> float:
    if side == "buy":
        candidate_ask = _to_float(candidate.get("best_ask"), 0.0)
        if candidate_ask <= 0 or best_ask <= 0:
            return 0.0
        return _clamp(1.0 - (((candidate_ask - best_ask) / max(best_ask, 1e-9)) * 10000.0) / 18.0, 0.0, 1.0)
    candidate_bid = _to_float(candidate.get("best_bid"), 0.0)
    if candidate_bid <= 0 or best_bid <= 0:
        return 0.0
    return _clamp(1.0 - (((best_bid - candidate_bid) / max(best_bid, 1e-9)) * 10000.0) / 18.0, 0.0, 1.0)


def _route_selection_score(
    candidate: dict[str, object],
    side: str,
    preferences: dict[str, object],
    *,
    best_bid: float,
    best_ask: float,
) -> float:
    spread_score = _clamp(1.0 - min(_to_float(candidate.get("spread_bps"), 50.0), 20.0) / 20.0, 0.0, 1.0)
    latency_score = _clamp(1.0 - min(_to_float(candidate.get("latency_ms"), 500.0), 500.0) / 500.0, 0.0, 1.0)
    depth_score = _clamp(math.log10(max(10.0, _to_float(candidate.get("available_depth_usd"), 0.0))) / 6.0, 0.0, 1.0)
    fill_score = _clamp(_to_float(candidate.get("fill_probability"), 0.0), 0.0, 1.0)
    stability_score = _clamp(
        _to_float(candidate.get("stability_score"), 0.0) - _to_float(candidate.get("stability_penalty"), 0.0) * 0.35,
        0.0,
        1.0,
    )
    queue_efficiency = _clamp(1.0 - _to_float(candidate.get("queue_priority_risk"), 0.0), 0.0, 1.0)
    raw_score = _clamp(_to_float(candidate.get("raw_score"), 0.0) / 1.2, 0.0, 1.0)
    quote_alignment = _best_quote_alignment(candidate, side, best_bid, best_ask)
    execution_style = _normalize_execution_style(preferences.get("execution_style"))
    route_mode_override = _normalize_route_mode_override(preferences.get("route_mode_override"))
    preferred_venue = str(preferences.get("preferred_venue") or "").strip()

    if route_mode_override == "dualVenueExecution":
        score = (
            quote_alignment * 0.45
            + fill_score * 0.2
            + depth_score * 0.15
            + latency_score * 0.1
            + stability_score * 0.1
        )
    elif execution_style == "maker_passive":
        score = (
            spread_score * 0.26
            + stability_score * 0.24
            + queue_efficiency * 0.18
            + depth_score * 0.16
            + quote_alignment * 0.1
            + latency_score * 0.06
        )
    elif execution_style in {"passive_selective", "passive_staggered"}:
        score = (
            stability_score * 0.28
            + spread_score * 0.22
            + queue_efficiency * 0.16
            + depth_score * 0.14
            + quote_alignment * 0.1
            + fill_score * 0.1
        )
    elif execution_style == "aggressive_confirmed":
        score = (
            fill_score * 0.28
            + latency_score * 0.22
            + depth_score * 0.18
            + quote_alignment * 0.16
            + raw_score * 0.1
            + stability_score * 0.06
        )
    elif execution_style == "primary_only":
        score = (
            stability_score * 0.28
            + latency_score * 0.18
            + spread_score * 0.16
            + raw_score * 0.14
            + depth_score * 0.14
            + fill_score * 0.1
        )
    else:
        score = (
            raw_score * 0.28
            + fill_score * 0.18
            + stability_score * 0.16
            + depth_score * 0.14
            + quote_alignment * 0.12
            + latency_score * 0.12
        )

    if preferred_venue:
        if str(candidate.get("venue") or "") == preferred_venue:
            score += 0.4 if execution_style == "primary_only" else 0.16
        elif execution_style == "primary_only":
            score -= 0.3

    if execution_style in {"maker_passive", "passive_selective", "passive_staggered"}:
        if str(candidate.get("stability_state") or "watch") == "avoid":
            score *= 0.55
        if _to_float(candidate.get("spread_bps"), 0.0) >= 10.0:
            score *= 0.72
    if execution_style == "aggressive_confirmed" and fill_score <= 0.4:
        score *= 0.78

    return score


def _select_route_candidates(
    candidates: list[dict[str, object]],
    side: str,
    preferences: dict[str, object],
    default_reason: str,
) -> tuple[dict[str, object], dict[str, object] | None, str, dict[str, object]]:
    if not candidates:
        raise HTTPException(status_code=502, detail="no route candidates available")

    preferred_venue = str(preferences.get("preferred_venue") or "").strip()
    route_mode_override = _normalize_route_mode_override(preferences.get("route_mode_override"))
    execution_style = _normalize_execution_style(preferences.get("execution_style"))

    if preferred_venue and execution_style == "primary_only":
        selected = next((candidate for candidate in candidates if str(candidate.get("venue") or "") == preferred_venue), candidates[0])
        backup = next((candidate for candidate in candidates if candidate.get("venue") != selected.get("venue")), None)
        return selected, backup, "preferred_venue_primary_only", {
            "preferred_venue": preferred_venue,
            "route_mode_override": route_mode_override,
            "execution_style": execution_style,
            "ranked_venues": [str(candidate.get("venue") or "") for candidate in candidates[:5]],
        }

    if preferred_venue and execution_style == "default" and route_mode_override in {"", "bestSingleVenue"}:
        selected = next((candidate for candidate in candidates if str(candidate.get("venue") or "") == preferred_venue), candidates[0])
        backup = next((candidate for candidate in candidates if candidate.get("venue") != selected.get("venue")), None)
        return selected, backup, "preferred_venue_override", {
            "preferred_venue": preferred_venue,
            "route_mode_override": route_mode_override,
            "execution_style": execution_style,
            "ranked_venues": [str(candidate.get("venue") or "") for candidate in candidates[:5]],
        }

    best_bid = max((_to_float(candidate.get("best_bid"), 0.0) for candidate in candidates), default=0.0)
    asks = [_to_float(candidate.get("best_ask"), 0.0) for candidate in candidates if _to_float(candidate.get("best_ask"), 0.0) > 0]
    best_ask = min(asks) if asks else 0.0
    ranked = sorted(
        candidates,
        key=lambda candidate: _route_selection_score(candidate, side, preferences, best_bid=best_bid, best_ask=best_ask),
        reverse=True,
    )
    selected = ranked[0]
    backup = next((candidate for candidate in ranked if candidate.get("venue") != selected.get("venue")), None)

    route_reason = default_reason
    if route_mode_override == "dualVenueExecution":
        route_reason = f"route_mode_override_dualVenueExecution_{side}"
    elif execution_style != "default":
        route_reason = f"execution_style_{execution_style}"

    return selected, backup, route_reason, {
        "preferred_venue": preferred_venue,
        "route_mode_override": route_mode_override,
        "execution_style": execution_style,
        "ranked_venues": [str(candidate.get("venue") or "") for candidate in ranked[:5]],
    }


def _venue_execution_profile(venue: str) -> dict[str, object]:
    normalized = str(venue or "").strip().lower()
    for key, profile in VENUE_EXECUTION_PROFILES.items():
        if key != "default" and normalized.startswith(key):
            return profile
    return VENUE_EXECUTION_PROFILES["default"]


def _normalize_network_regime(value: object) -> str:
    normalized = str(value or "").strip().lower()
    if normalized in {"critical", "degraded", "stable"}:
        return normalized
    return "stable"


def _resolve_infra_context(
    payload: dict[str, object] | None = None,
    *,
    infra_health: object | None = None,
    network_regime: object | None = None,
) -> dict[str, object]:
    source = payload if isinstance(payload, dict) else {}
    resolved_infra_health = _to_float(
        infra_health if infra_health is not None else source.get("infra_health"),
        1.0,
    )
    resolved_infra_health = _clamp(resolved_infra_health, 0.05, 1.0)
    resolved_network_regime = _normalize_network_regime(
        network_regime if network_regime is not None else source.get("network_regime")
    )
    if resolved_network_regime == "stable":
        if resolved_infra_health <= 0.45:
            resolved_network_regime = "critical"
        elif resolved_infra_health <= 0.78:
            resolved_network_regime = "degraded"
    infra_factor = _clamp(
        resolved_infra_health
        - (0.22 if resolved_network_regime == "critical" else 0.08 if resolved_network_regime == "degraded" else 0.0),
        0.05,
        1.0,
    )
    return {
        "infra_health": resolved_infra_health,
        "network_regime": resolved_network_regime,
        "infra_factor": infra_factor,
    }


def _string_list(values: object) -> list[str]:
    if not isinstance(values, list):
        return []
    normalized: list[str] = []
    for value in values:
        candidate = str(value or "").strip()
        if candidate:
            normalized.append(candidate)
    return normalized


def _build_route_failure_attribution(
    candidates: list[dict],
    context: dict[str, object],
    infra_context: dict[str, object],
) -> dict[str, object]:
    infra_health = _to_float(infra_context.get("infra_health"), 1.0)
    network_regime = str(infra_context.get("network_regime") or "stable")
    best = context.get("best") if isinstance(context.get("best"), dict) else None
    if best is None:
        reasons = ["no_route_candidates"]
        if network_regime != "stable" or infra_health <= 0.78:
            if network_regime != "stable":
                reasons.append(f"network_regime_{network_regime}")
            if infra_health <= 0.78:
                reasons.append("infra_health_degraded")
            return {
                "failure_source": "infra",
                "failure_reasons": reasons,
                "failure_blocking": True,
            }
        return {
            "failure_source": "market",
            "failure_reasons": reasons,
            "failure_blocking": True,
        }

    stability_flags = set(_string_list(best.get("stability_flags")))
    stability_state = str(best.get("stability_state") or "watch")
    stability_reason = str(best.get("stability_reason") or "").strip()
    spread_bps = _to_float(best.get("spread_bps"), 0.0)
    fill_probability = _to_float(best.get("fill_probability"), 0.0)
    available_depth_usd = _to_float(best.get("available_depth_usd"), 0.0)
    freshness_ms = _to_float(best.get("freshness_ms"), 0.0)
    deviation_bps = _to_float(context.get("deviation_bps"), 0.0)

    infra_flags = {"depth_unreachable", "feed_hard_stale", "feed_degraded", "feed_aging"}
    if (
        network_regime == "critical"
        or infra_health <= 0.45
        or freshness_ms >= 60000
        or bool(stability_flags.intersection(infra_flags))
    ):
        reasons: list[str] = []
        if network_regime != "stable":
            reasons.append(f"network_regime_{network_regime}")
        if infra_health <= 0.45:
            reasons.append("infra_health_low")
        if freshness_ms >= 60000:
            reasons.append("route_feed_stale")
        if stability_reason:
            reasons.append(stability_reason)
        return {
            "failure_source": "infra",
            "failure_reasons": reasons or ["infra_degraded"],
            "failure_blocking": stability_state == "avoid" or freshness_ms >= 180000 or infra_health <= 0.35,
        }

    if stability_state == "avoid" or spread_bps >= 12.0 or fill_probability <= 0.42 or available_depth_usd <= 15000.0:
        reasons = []
        if stability_state == "avoid":
            reasons.append("route_candidate_avoid")
        if spread_bps >= 12.0:
            reasons.append("spread_above_12bps")
        if fill_probability <= 0.42:
            reasons.append("fill_probability_low")
        if available_depth_usd <= 15000.0:
            reasons.append("available_depth_thin")
        if stability_reason:
            reasons.append(stability_reason)
        return {
            "failure_source": "execution",
            "failure_reasons": reasons,
            "failure_blocking": stability_state == "avoid" or fill_probability <= 0.3,
        }

    if deviation_bps >= 22.0 or _to_float(context.get("fusion_price"), 0.0) <= 0.0:
        reasons = []
        if deviation_bps >= 22.0:
            reasons.append("cross_venue_deviation_high")
        if _to_float(context.get("fusion_price"), 0.0) <= 0.0:
            reasons.append("fusion_price_missing")
        return {
            "failure_source": "market",
            "failure_reasons": reasons,
            "failure_blocking": deviation_bps >= 35.0 or _to_float(context.get("fusion_price"), 0.0) <= 0.0,
        }

    return {
        "failure_source": None,
        "failure_reasons": [],
        "failure_blocking": False,
    }


def _timestamp_age_ms(value: object) -> int:
    if isinstance(value, datetime):
        return max(0, int((datetime.now(timezone.utc) - value.astimezone(timezone.utc)).total_seconds() * 1000))
    if isinstance(value, str) and value:
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return max(0, int((datetime.now(timezone.utc) - parsed.astimezone(timezone.utc)).total_seconds() * 1000))
        except ValueError:
            return 0
    return 0


def _record_venue_stability(venue: str, sample_score: float, reasons: list[str]) -> dict[str, object]:
    tracker = VENUE_STABILITY.get(venue, {})
    previous_score = _to_float(tracker.get("score"), 0.82)
    observations = int(tracker.get("observations", 0)) + 1
    failures = int(tracker.get("failures", 0))
    consecutive_failures = int(tracker.get("consecutive_failures", 0))

    if sample_score < 0.45:
        failures += 1
        consecutive_failures += 1
    elif sample_score >= 0.72:
        consecutive_failures = 0
    else:
        consecutive_failures = max(0, consecutive_failures - 1)

    stability_score = _clamp(previous_score * 0.72 + sample_score * 0.28 - min(consecutive_failures, 4) * 0.03, 0.02, 0.99)
    state = "stable"
    if consecutive_failures >= 3 or stability_score < 0.35:
        state = "avoid"
    elif consecutive_failures >= 1 or stability_score < 0.68:
        state = "watch"

    updated = {
        "score": stability_score,
        "observations": observations,
        "failures": failures,
        "consecutive_failures": consecutive_failures,
        "state": state,
        "last_reason": ",".join(reasons) if reasons else "healthy_depth_feed",
        "updated_at": _now_iso(),
    }
    VENUE_STABILITY[venue] = updated
    return updated


def _assess_venue_stability(
    venue: str,
    spread_bps: float,
    quote_age_ms: int,
    depth_age_ms: int,
    depth_levels: int,
    depth_ok: bool,
    has_depth: bool,
) -> dict[str, object]:
    observed_age_ms = max(quote_age_ms, depth_age_ms, 0)
    reasons: list[str] = []
    sample_score = 0.97

    if not depth_ok:
        sample_score -= 0.5
        reasons.append("depth_unreachable")
    elif not has_depth:
        sample_score -= 0.2
        reasons.append("depth_unconfirmed")

    if observed_age_ms > 180000:
        sample_score -= 0.3
        reasons.append("feed_hard_stale")
    elif observed_age_ms > 60000:
        sample_score -= 0.2
        reasons.append("feed_degraded")
    elif observed_age_ms > 15000:
        sample_score -= 0.1
        reasons.append("feed_aging")

    if depth_levels < 2:
        sample_score -= 0.08
        reasons.append("thin_book")
    if spread_bps > 18:
        sample_score -= 0.05
        reasons.append("wide_spread")

    sample_score = _clamp(sample_score, 0.02, 0.99)
    tracker = _record_venue_stability(venue, sample_score, reasons)
    stability_score = _to_float(tracker.get("score"), sample_score)
    consecutive_failures = int(tracker.get("consecutive_failures", 0))
    stability_penalty = _clamp((1.0 - stability_score) * 0.7 + min(consecutive_failures, 4) * 0.06, 0.0, 0.85)
    stability_reason = str(tracker.get("last_reason") or "healthy_depth_feed")

    return {
        "sample_score": sample_score,
        "stability_score": stability_score,
        "stability_penalty": stability_penalty,
        "stability_state": str(tracker.get("state") or "watch"),
        "stability_reason": stability_reason,
        "stability_flags": reasons,
        "consecutive_failures": consecutive_failures,
        "observations": int(tracker.get("observations", 0)),
        "quote_age_ms": quote_age_ms,
        "depth_age_ms": depth_age_ms,
    }


def _weighted_median_price(values: list[tuple[float, float]]) -> float:
    filtered = sorted(((price, max(weight, 0.000001)) for price, weight in values if price > 0), key=lambda item: item[0])
    if not filtered:
        return 0.0
    total_weight = sum(weight for _, weight in filtered)
    cumulative = 0.0
    for price, weight in filtered:
        cumulative += weight
        if cumulative >= total_weight / 2:
            return price
    return filtered[-1][0]


def _aggregate_depth(book: object) -> tuple[float, float]:
    if not isinstance(book, dict):
        return 0.0, 0.0
    bid_depth_usd = 0.0
    ask_depth_usd = 0.0
    bids = book.get("bids", [])
    asks = book.get("asks", [])
    if isinstance(bids, list):
        for level in bids[:8]:
            if isinstance(level, list) and len(level) >= 2:
                bid_depth_usd += _to_float(level[0]) * _to_float(level[1])
    if isinstance(asks, list):
        for level in asks[:8]:
            if isinstance(level, list) and len(level) >= 2:
                ask_depth_usd += _to_float(level[0]) * _to_float(level[1])
    return bid_depth_usd, ask_depth_usd


def _book_level_count(book: object) -> int:
    if not isinstance(book, dict):
        return 0
    bids = book.get("bids") if isinstance(book.get("bids"), list) else []
    asks = book.get("asks") if isinstance(book.get("asks"), list) else []
    return max(len(bids), len(asks))


def _mid_from_quote(quote: dict) -> float:
    bid = _to_float(quote.get("bid"), 0.0)
    ask = _to_float(quote.get("ask"), 0.0)
    if bid > 0 and ask > 0:
        return (bid + ask) / 2
    return _to_float(quote.get("last"), 0.0)


async def _build_route_candidates(symbol: str, infra_context: dict[str, object] | None = None) -> list[dict]:
    normalized = _normalize_symbol(symbol)
    market_symbol = _market_symbol(symbol)
    resolved_infra = _resolve_infra_context(infra_context)
    infra_health = _to_float(resolved_infra.get("infra_health"), 1.0)
    network_regime = str(resolved_infra.get("network_regime") or "stable")
    infra_factor = _to_float(resolved_infra.get("infra_factor"), infra_health)
    async with httpx.AsyncClient(timeout=10.0) as client:
        quotes_response = await client.get(f"{MARKET_DATA_URL}/v1/quotes")
        quotes = quotes_response.json() if quotes_response.status_code < 400 else []

        matching_quotes = [quote for quote in quotes if _normalize_symbol(str(quote.get("instrument", ""))) == market_symbol]
        depth_responses = await asyncio.gather(
            *[
                client.get(
                    f"{MARKET_DATA_URL}/v1/market/orderbook/depth",
                    params={"venue": str(quote.get("venue", "unknown")), "instrument": market_symbol},
                )
                for quote in matching_quotes
            ],
            return_exceptions=True,
        )

        candidates: list[dict] = []
        for quote, depth_response in zip(matching_quotes, depth_responses):
            venue = str(quote.get("venue", "unknown"))
            venue_profile = _venue_execution_profile(venue)
            spread_bps = _to_float(quote.get("spread_bps"), 9999.0)
            depth_ok = not isinstance(depth_response, Exception) and depth_response.status_code < 400
            depth_payload = depth_response.json() if depth_ok else {}
            book = (depth_payload or {}).get("depth_payload", {})
            bid_depth_usd, ask_depth_usd = _aggregate_depth(book)
            available_depth_usd = min(bid_depth_usd, ask_depth_usd) if bid_depth_usd > 0 and ask_depth_usd > 0 else max(bid_depth_usd, ask_depth_usd)
            mid = _mid_from_quote(quote)
            depth_levels = len(book.get("bids", [])) if isinstance(book, dict) and isinstance(book.get("bids", []), list) else 0
            depth_confidence = 1.0 if depth_levels >= 4 else 0.45 if depth_levels >= 1 else 0.05
            quote_age_ms = _timestamp_age_ms(quote.get("updated_at"))
            depth_age_ms = _timestamp_age_ms(depth_payload.get("snapshot_at"))
            freshness_ms = max(quote_age_ms, depth_age_ms, 0)
            latency_ms = max(15.0, min(2000.0, 20.0 + freshness_ms * 0.15))
            liquidity_score = _clamp(math.log10(max(10.0, available_depth_usd)) / 6.0, 0.0, 1.0) if available_depth_usd > 0 else depth_confidence * 0.1
            queue_priority_risk = _clamp(
                (1.0 - _to_float(venue_profile.get("queue_priority_bias"), 0.8)) * 0.45
                + (1.0 - depth_confidence) * 0.28
                + min(1.0, freshness_ms / 120000.0) * 0.12
                + min(1.0, spread_bps / 20.0) * 0.15,
                0.02,
                0.98,
            )
            hidden_liquidity_ratio = _clamp(
                _to_float(venue_profile.get("hidden_liquidity_ratio"), 0.12)
                + max(0.0, 0.12 - min(0.12, spread_bps / 300.0))
                + min(0.12, liquidity_score * 0.1),
                0.04,
                0.42,
            )
            partial_fill_risk = _clamp(
                _to_float(venue_profile.get("partial_fill_bias"), 0.16)
                + queue_priority_risk * 0.36
                + (1.0 - depth_confidence) * 0.18,
                0.04,
                0.9,
            )
            micro_latency_jitter_ms = max(0.0, _to_float(venue_profile.get("latency_jitter_ms"), 8.0) + depth_levels * 0.35)
            fill_probability = _clamp(
                (1 - min(spread_bps, 20.0) / 20.0) * 0.4
                + liquidity_score * 0.28
                + depth_confidence * 0.18
                + hidden_liquidity_ratio * 0.08
                - queue_priority_risk * 0.16
                - partial_fill_risk * 0.08,
                0.03,
                0.99,
            )
            stability = _assess_venue_stability(
                venue=venue,
                spread_bps=spread_bps,
                quote_age_ms=quote_age_ms,
                depth_age_ms=depth_age_ms,
                depth_levels=depth_levels,
                depth_ok=depth_ok,
                has_depth=bool(book),
            )
            raw_score = liquidity_score * 0.4 + depth_confidence * 0.2 + (1 / max(1.0, latency_ms)) * 100 * 0.15 + fill_probability * 0.25
            stability_factor = _clamp(
                _to_float(stability.get("stability_score"), 0.0) - _to_float(stability.get("stability_penalty"), 0.0) * 0.18,
                0.05,
                1.0,
            )
            score = max(0.01, raw_score * stability_factor * infra_factor)
            candidates.append(
                {
                    "venue": venue,
                    "instrument": market_symbol,
                    "spread_bps": spread_bps,
                    "available_depth_usd": available_depth_usd,
                    "depth_levels": depth_levels,
                    "depth_confidence": depth_confidence,
                    "best_bid": _to_float(depth_payload.get("best_bid"), _to_float(quote.get("bid"), 0.0)),
                    "best_ask": _to_float(depth_payload.get("best_ask"), _to_float(quote.get("ask"), 0.0)),
                    "last": _to_float(quote.get("last"), mid),
                    "latency_ms": latency_ms,
                    "matching_rule": str(venue_profile.get("matching_rule") or "price-time"),
                    "queue_priority_risk": queue_priority_risk,
                    "hidden_liquidity_ratio": hidden_liquidity_ratio,
                    "partial_fill_risk": partial_fill_risk,
                    "micro_latency_jitter_ms": micro_latency_jitter_ms,
                    "freshness_ms": freshness_ms,
                    "quote_age_ms": quote_age_ms,
                    "depth_age_ms": depth_age_ms,
                    "liquidity": liquidity_score,
                    "fill_probability": fill_probability,
                    "raw_score": raw_score,
                    "score": score,
                    "infra_health": infra_health,
                    "network_regime": network_regime,
                    "infra_factor": infra_factor,
                    "stability_score": _to_float(stability.get("stability_score"), 0.0),
                    "stability_penalty": _to_float(stability.get("stability_penalty"), 0.0),
                    "stability_state": str(stability.get("stability_state") or "watch"),
                    "stability_reason": str(stability.get("stability_reason") or "healthy_depth_feed"),
                    "stability_flags": stability.get("stability_flags") or [],
                    "consecutive_failures": int(stability.get("consecutive_failures", 0)),
                    "source": "v6-price-fusion-stability-infra",
                    "depth_payload": book,
                }
            )

    return sorted(candidates, key=lambda item: item["score"], reverse=True)


def _build_route_context(candidates: list[dict]) -> dict:
    price_weights = [(_to_float(candidate.get("last"), 0.0), max(_to_float(candidate.get("available_depth_usd"), 0.0), 1.0)) for candidate in candidates]
    fusion_price = _weighted_median_price(price_weights)
    best = candidates[0] if candidates else None
    backup = candidates[1] if len(candidates) > 1 else None
    best_bid = max((_to_float(candidate.get("best_bid"), 0.0) for candidate in candidates), default=0.0)
    asks = [_to_float(candidate.get("best_ask"), 0.0) for candidate in candidates if _to_float(candidate.get("best_ask"), 0.0) > 0]
    best_ask = min(asks) if asks else 0.0
    buy = next((candidate.get("venue") for candidate in candidates if _to_float(candidate.get("best_ask"), 0.0) == best_ask and best_ask > 0), "")
    sell = next((candidate.get("venue") for candidate in candidates if _to_float(candidate.get("best_bid"), 0.0) == best_bid and best_bid > 0), "")
    gross_spread = max(0.0, best_bid - best_ask) if best_bid > 0 and best_ask > 0 else 0.0
    fee_cost = (fusion_price or ((best_bid + best_ask) / 2 if best_bid > 0 and best_ask > 0 else 0.0)) * ((6.0 + 1.5) / 10000.0)
    net_spread = gross_spread - fee_cost
    mids = [price for price, _ in price_weights if price > 0]
    deviation_bps = ((max(mids) - min(mids)) / fusion_price * 10000) if len(mids) >= 2 and fusion_price > 0 else 0.0
    route_reason = "no_market_candidates"
    if best:
        best_state = str(best.get("stability_state") or "watch")
        if best_state == "stable":
            route_reason = "best_stable_route_candidate"
        elif best_state == "watch":
            route_reason = "best_route_candidate_under_watch"
        else:
            route_reason = "least_unstable_route_candidate"
    return {
        "fusion_price": fusion_price,
        "deviation_bps": deviation_bps,
        "arbitrage": {
            "opportunity": net_spread > 0,
            "spread": gross_spread,
            "net_spread": net_spread,
            "buy": buy,
            "sell": sell,
        },
        "best": best,
        "backup": backup,
        "reason": route_reason,
    }


def _simulate_fills(
    decision_id: str,
    side: str,
    notional_usd: float,
    depth_payload: dict,
    venue: str,
    instrument: str,
    execution_delay_ms: int = 0,
) -> tuple[list[dict], float]:
    book_side = depth_payload.get("asks", []) if side == "buy" else depth_payload.get("bids", [])
    venue_profile = _venue_execution_profile(venue)
    matching_rule = str(venue_profile.get("matching_rule") or "price-time")
    queue_priority_bias = _clamp(_to_float(venue_profile.get("queue_priority_bias"), 0.8), 0.35, 1.0)
    hidden_liquidity_ratio = _clamp(_to_float(venue_profile.get("hidden_liquidity_ratio"), 0.12), 0.0, 0.5)
    latency_base_ms = max(4, int(_to_float(venue_profile.get("latency_base_ms"), 20.0)))
    latency_jitter_ms = max(0, int(_to_float(venue_profile.get("latency_jitter_ms"), 8.0)))
    partial_fill_bias = _clamp(_to_float(venue_profile.get("partial_fill_bias"), 0.16), 0.0, 0.95)
    remaining = max(0.0, notional_usd)
    fills: list[dict] = []
    filled_notional = 0.0
    weighted_price = 0.0

    for level_index, level in enumerate(book_side[:20]):
        if not (isinstance(level, list) and len(level) >= 2):
            continue
        price = _to_float(level[0], 0.0)
        size_base = _to_float(level[1], 0.0)
        level_notional = price * size_base
        if price <= 0 or size_base <= 0 or level_notional <= 0:
            continue

        visible_notional = level_notional * max(0.18, queue_priority_bias - min(0.42, level_index * 0.03))
        hidden_notional = level_notional * hidden_liquidity_ratio * (0.42 if level_index <= 1 else 0.16)
        effective_level_notional = visible_notional + hidden_notional
        if matching_rule == "pro-rata-lite":
            effective_level_notional *= 0.92
        elif matching_rule == "price-time-auction":
            effective_level_notional *= 0.97 if level_index == 0 else 0.86
        effective_level_notional = max(price * 0.000001, effective_level_notional)
        intended_take_notional = min(effective_level_notional, remaining)
        take_notional = intended_take_notional
        fill_type = "book"
        if hidden_notional > 0 and intended_take_notional > visible_notional * 0.96:
            fill_type = "hidden-liquidity"
        if remaining > effective_level_notional * (1.0 - partial_fill_bias * 0.4):
            take_notional = min(intended_take_notional, effective_level_notional * (1.0 - partial_fill_bias * 0.35))
            fill_type = "partial-book" if fill_type == "book" else fill_type
        take_notional = max(0.0, min(take_notional, remaining))
        if take_notional <= 0:
            continue
        take_size_base = take_notional / price
        fill_id = f"{decision_id}-f{len(fills) + 1}"
        fill = {
            "fill_id": fill_id,
            "decision_id": decision_id,
            "venue": venue,
            "instrument": instrument,
            "side": side,
            "price": price,
            "size_base": take_size_base,
            "notional_usd": take_notional,
            "depth_level": level_index,
            "fill_type": fill_type,
            "matching_rule": matching_rule,
            "queue_priority_risk": round(1.0 - queue_priority_bias, 6),
            "hidden_liquidity_used_usd": round(max(0.0, take_notional - min(visible_notional, take_notional)), 6),
            "fill_latency_ms": execution_delay_ms + latency_base_ms + (level_index * max(2, latency_jitter_ms // 2)) + latency_jitter_ms,
            "filled_at": _now_iso(),
        }
        fills.append(fill)
        filled_notional += take_notional
        weighted_price += price * take_notional
        remaining -= take_notional
        if remaining <= 1e-9:
            break

    if remaining > 0:
        fallback_price = _to_float((book_side[0] if book_side else [1.0])[0], 1.0)
        residual_price = fallback_price * (1.0 + (0.00012 if side == "buy" else -0.00012) * (1.0 + partial_fill_bias))
        fill_id = f"{decision_id}-f{len(fills) + 1}"
        fill = {
            "fill_id": fill_id,
            "decision_id": decision_id,
            "venue": venue,
            "instrument": instrument,
            "side": side,
            "price": residual_price,
            "size_base": remaining / max(residual_price, 1e-9),
            "notional_usd": remaining,
            "depth_level": 999,
            "fill_type": "auction-cross" if matching_rule == "price-time-auction" else "residual",
            "matching_rule": matching_rule,
            "queue_priority_risk": round(1.0 - queue_priority_bias, 6),
            "hidden_liquidity_used_usd": 0.0,
            "fill_latency_ms": execution_delay_ms + latency_base_ms + 180 + latency_jitter_ms,
            "filled_at": _now_iso(),
        }
        fills.append(fill)
        filled_notional += remaining
        weighted_price += residual_price * remaining

    avg_fill_price = weighted_price / max(filled_notional, 1e-9)
    return fills, avg_fill_price


@app.on_event("startup")
async def startup() -> None:
    ensure_schema()


@app.get("/health")
async def health() -> dict:
    return {
        "status": "ok",
        "service": "execution-router",
        "orders": len(ORDERS),
        "positions": POSITIONS,
    }


@app.get("/v1/routes/score")
async def route_score(symbol: str, infra_health: float | None = None, network_regime: str | None = None) -> dict:
    resolved_infra = _resolve_infra_context(
        {"infra_health": infra_health, "network_regime": network_regime}
    )
    candidates = await _build_route_candidates(symbol, infra_context=resolved_infra)
    context = _build_route_context(candidates)
    failure_attribution = _build_route_failure_attribution(candidates, context, resolved_infra)
    return {
        "symbol": _normalize_symbol(symbol),
        "best": context.get("best"),
        "backup": context.get("backup"),
        "fusion_price": context.get("fusion_price"),
        "deviation_bps": context.get("deviation_bps"),
        "arbitrage": context.get("arbitrage"),
        "source": "v6-price-fusion-stability-infra",
        "reason": context.get("reason") or "no_market_candidates",
        "infra_health": _to_float(resolved_infra.get("infra_health"), 1.0),
        "network_regime": str(resolved_infra.get("network_regime") or "stable"),
        "failure_source": failure_attribution.get("failure_source"),
        "failure_reasons": failure_attribution.get("failure_reasons"),
        "failure_blocking": bool(failure_attribution.get("failure_blocking")),
        "candidates": candidates,
    }


@app.post("/v1/orders/routed")
async def place_routed_order(payload: dict) -> dict:
    symbol = _normalize_symbol(str(payload.get("symbol", "")))
    if not symbol:
        raise HTTPException(status_code=400, detail="symbol is required")
    side = str(payload.get("side", "buy")).lower()
    if side not in {"buy", "sell"}:
        raise HTTPException(status_code=400, detail="side must be buy/sell")
    notional = _to_float(payload.get("estimated_notional_usd"), 0.0)
    if notional <= 0:
        raise HTTPException(status_code=400, detail="estimated_notional_usd must be > 0")
    execution_delay_ms = _resolve_execution_delay_ms(payload)

    resolved_infra = _resolve_infra_context(payload)
    candidates = await _build_route_candidates(symbol, infra_context=resolved_infra)
    if not candidates:
        raise HTTPException(status_code=502, detail="no route candidates available")

    context = _build_route_context(candidates)
    failure_attribution = _build_route_failure_attribution(candidates, context, resolved_infra)
    route_preferences = _resolve_route_preferences(payload)
    pre_trade_memory_gate = _extract_pre_trade_memory_gate(payload)
    selected, backup, route_reason, route_selection = _select_route_candidates(
        candidates,
        side,
        route_preferences,
        str(context.get("reason") or "best_stable_route_candidate"),
    )

    decision_id = str(payload.get("decision_id") or f"route-{uuid4()}")
    live_context = _live_execution_context(payload)
    if execution_delay_ms > 0:
        await asyncio.sleep(execution_delay_ms / 1000.0)

    broker_order: dict[str, object] | None = None
    if bool(live_context.get("enabled")):
        broker_order = await _execute_live_order(payload, live_context, decision_id)
        fills = _as_list(broker_order.get("fills"))
        avg_fill_price = _to_float(broker_order.get("avg_fill_price"), 0.0)
        filled_notional = _to_float(broker_order.get("filled_notional_usd"), 0.0)
        order_status = str(broker_order.get("status") or "unknown")
        actual_venue = str(broker_order.get("venue") or live_context.get("provider") or selected.get("venue") or "unknown")
    else:
        fills, avg_fill_price = _simulate_fills(
            decision_id=decision_id,
            side=side,
            notional_usd=notional,
            depth_payload=(selected.get("depth_payload") or {}),
            venue=str(selected.get("venue", "unknown")),
            instrument=symbol,
            execution_delay_ms=execution_delay_ms,
        )
        filled_notional = sum(_to_float(fill.get("notional_usd"), 0.0) for fill in fills)
        order_status = "filled"
        actual_venue = str(selected.get("venue", "unknown"))

    spread_bps = _to_float(selected.get("spread_bps"), 0.0)
    reference_price = _to_float(selected.get("best_ask" if side == "buy" else "best_bid"), avg_fill_price)
    expected_slippage_bps = max(0.2, spread_bps * 0.7)
    realized_slippage_bps = abs(avg_fill_price - reference_price) / max(reference_price, 1e-9) * 10000 if avg_fill_price > 0 and reference_price > 0 else 0.0
    fill_quality_score = max(0.0, 100.0 - spread_bps * 1.6 - realized_slippage_bps * 2.0)

    if filled_notional > 0:
        signed_notional = filled_notional if side == "buy" else -filled_notional
        POSITIONS[symbol] = POSITIONS.get(symbol, 0.0) + signed_notional

    execution_mode = str(payload.get("execution_mode", "routed"))
    intent_id = str(payload.get("intent_id") or "").strip() or None
    if intent_id and not fetch_one("SELECT intent_id FROM intents WHERE intent_id = %s", (intent_id,)):
        intent_id = None
    order_id = str((broker_order or {}).get("order_id") or payload.get("order_id") or f"routed-{decision_id}")
    execute(
        """
        INSERT INTO orders (order_id, intent_id, venue, instrument, side, requested_notional_usd, filled_notional_usd, avg_fill_price, execution_mode, status)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (order_id) DO UPDATE SET
          venue = EXCLUDED.venue,
          filled_notional_usd = EXCLUDED.filled_notional_usd,
          avg_fill_price = EXCLUDED.avg_fill_price,
          execution_mode = EXCLUDED.execution_mode,
          status = EXCLUDED.status
        """,
        (
            order_id,
            intent_id,
            actual_venue,
            symbol,
            side,
            notional,
            filled_notional,
            avg_fill_price,
            execution_mode,
            order_status,
        ),
    )

    for index, fill in enumerate(fills):
        fill_payload = {
            "pre_trade_memory_gate": pre_trade_memory_gate,
            "live_execution": {
                "enabled": bool(live_context.get("enabled")),
                "provider": live_context.get("provider"),
                "account_id": live_context.get("account_id"),
                "position_side": live_context.get("position_side"),
            },
            "route": {
                "chosen": str(selected.get("venue") or actual_venue),
                "backup": str(backup.get("venue") or "") if isinstance(backup, dict) else "",
                "reason": route_reason,
            },
        }
        execute(
            """
            INSERT INTO execution_fill_events (decision_id, fill_id, venue, instrument, side, price, size_base, notional_usd, depth_level, fill_type, slippage_bps, fill_latency_ms, payload, filled_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s)
            ON CONFLICT (decision_id, fill_id) DO NOTHING
            """,
            (
                decision_id,
                str(fill.get("fill_id") or f"{order_id}-fill-{index + 1}"),
                str(fill.get("venue") or actual_venue),
                str(fill.get("instrument")),
                side,
                _to_float(fill.get("price"), 0.0),
                _to_float(fill.get("size_base"), 0.0),
                _to_float(fill.get("notional_usd"), 0.0),
                int(fill.get("depth_level", 0)),
                str(fill.get("fill_type", "book")),
                realized_slippage_bps,
                int(fill.get("fill_latency_ms", 0)),
                json_dumps(fill_payload),
                datetime.fromisoformat(str(fill.get("filled_at"))),
            ),
        )

    order = {
        "decision_id": decision_id,
        "order_id": order_id,
        "status": order_status,
        "venue": actual_venue,
        "instrument": symbol,
        "side": side,
        "requested_notional_usd": notional,
        "filled_notional_usd": filled_notional,
        "avg_fill_price": avg_fill_price,
        "execution_mode": execution_mode,
        "expected_slippage_bps": expected_slippage_bps,
        "realized_slippage_bps": realized_slippage_bps,
        "fill_quality_score": fill_quality_score,
        "execution_delay_ms_applied": execution_delay_ms,
        "route": {
            "chosen": selected,
            "backup": backup,
            "reason": route_reason,
            "preferences": route_preferences,
            "selection": route_selection,
            "mode": "live" if broker_order else "simulated",
            "execution_target": actual_venue,
            "source": "v6-price-fusion-stability-infra",
            "failure_source": failure_attribution.get("failure_source"),
            "failure_reasons": failure_attribution.get("failure_reasons"),
            "failure_blocking": bool(failure_attribution.get("failure_blocking")),
        },
        "infra_health": _to_float(resolved_infra.get("infra_health"), 1.0),
        "network_regime": str(resolved_infra.get("network_regime") or "stable"),
        "failure_source": failure_attribution.get("failure_source"),
        "failure_reasons": failure_attribution.get("failure_reasons"),
        "failure_blocking": bool(failure_attribution.get("failure_blocking")),
        "fills": fills,
        "live_execution": {
            "enabled": bool(live_context.get("enabled")),
            "provider": live_context.get("provider"),
            "account_id": live_context.get("account_id"),
            "position_side": live_context.get("position_side"),
        },
        "pre_trade_memory_gate": pre_trade_memory_gate,
        "broker_order": broker_order,
        "timestamp": _now_iso(),
    }

    ORDERS.append(
        OrderResult(
            order_id=order_id,
            status=order_status,
            venue=actual_venue,
            instrument=symbol,
            side=side,
            requested_notional_usd=notional,
            filled_notional_usd=filled_notional,
            avg_fill_price=avg_fill_price,
            execution_mode=execution_mode,
        )
    )
    return order


@app.get("/v1/orders")
async def list_orders() -> list[OrderResult]:
    rows = fetch_all(
        "SELECT order_id, venue, instrument, side, requested_notional_usd, filled_notional_usd, avg_fill_price, execution_mode, status, created_at AS timestamp FROM orders ORDER BY created_at DESC LIMIT 100"
    )
    if rows:
        for row in rows:
            row["timestamp"] = row["timestamp"].isoformat()
        return [OrderResult.model_validate(row) for row in rows]
    return ORDERS[-100:]


@app.get("/v1/positions")
async def list_positions() -> dict[str, float]:
    rows = fetch_all(
        """
        SELECT instrument, SUM(CASE WHEN side = 'buy' THEN filled_notional_usd ELSE -filled_notional_usd END) AS net_notional_usd
        FROM orders
        GROUP BY instrument
        """
    )
    if rows:
        return {row["instrument"]: row["net_notional_usd"] for row in rows}
    return POSITIONS


@app.post("/v1/orders", response_model=OrderResult)
async def place_order(request: ExecutionRequest) -> OrderResult:
    if request.risk_decision.decision != "accept":
        raise HTTPException(status_code=400, detail="Rejected intent cannot be executed")

    if getattr(request, "execution_delay_ms", 0) > 0:
        await asyncio.sleep(max(0, min(int(request.execution_delay_ms), 5000)) / 1000.0)

    intent = request.intent
    signed_notional = intent.target_notional_usd if intent.side.value == "buy" else -intent.target_notional_usd
    POSITIONS[intent.instrument] = POSITIONS.get(intent.instrument, 0.0) + signed_notional

    order = OrderResult(
        order_id=f"paper-{intent.intent_id}",
        status="filled",
        venue=intent.venue,
        instrument=intent.instrument,
        side=intent.side,
        requested_notional_usd=intent.target_notional_usd,
        filled_notional_usd=intent.target_notional_usd,
        avg_fill_price=1.0,
        execution_mode=request.execution_mode,
    )
    ORDERS.append(order)
    return order