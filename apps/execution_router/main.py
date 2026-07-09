from __future__ import annotations

import asyncio
from collections import deque
from contextlib import suppress
from enum import Enum
import math
import os
import threading
import time
from datetime import datetime, timezone
from uuid import uuid4

import httpx
from fastapi import FastAPI, HTTPException

from apps.execution_router.context_v1 import (
    apply_execution_context_to_fill_snapshot,
    build_execution_context,
    build_market_structure_snapshot,
)
from apps.execution_router.proof_order_shape import resolve_proof_renewal_order_shape
from apps.execution_router.optimizer_v3 import (
    apply_order_management_to_live_context,
    build_execution_optimizer_snapshot,
    execution_optimizer_allows_trade,
)
from apps.execution_router.optimizer_v4 import (
    adaptive_slippage_guard,
    calibrate_execution_desk_profile,
    compute_live_fill_score,
    decide_order_lifecycle,
    detect_liquidity_trap,
    detect_spoof_signal,
    initialize_queue_tracker,
    update_queue_tracker,
)

from shared.db import ensure_schema, execute, fetch_all, fetch_one, json_dumps
from shared.models import ExecutionRequest, OrderResult, TradeProtectionRequest

app = FastAPI(title="Execution Router", version="0.1.0")

ORDERS: list[OrderResult] = []
POSITIONS: dict[str, float] = {}
MARKET_DATA_URL = os.getenv("MARKET_DATA_URL", "http://127.0.0.1:8003")
BROKER_ADAPTER_URL = os.getenv("BROKER_ADAPTER_URL", "http://127.0.0.1:8004")
VENUE_STABILITY: dict[str, dict[str, object]] = {}
EXECUTION_OPTIMIZER_PROFILE_CACHE: dict[str, object] = {"expires_at": 0.0, "profiles": {}, "updated_at": None}
EXECUTION_OPTIMIZER_PROFILE_REFRESH_LOCK = threading.Lock()
EXECUTION_OPTIMIZER_PROFILE_METRICS: dict[str, object] = {
    "cache_hit": 0,
    "cache_miss": 0,
    "stale_served": 0,
    "cold_miss": 0,
    "refresh_count": 0,
    "refresh_errors": 0,
    "last_refresh_ms": None,
    "last_error": None,
}


def _optimizer_profile_ttl_sec() -> float:
    try:
        return max(5.0, float(os.getenv("EXECUTION_OPTIMIZER_PROFILE_TTL_SEC", "45")))
    except ValueError:
        return 45.0
ACTIVE_EXECUTION_ORDERS: dict[str, dict[str, object]] = {}
ACTIVE_EXECUTION_ORDER_TASKS: dict[str, asyncio.Task] = {}
RECENT_EXECUTION_OPTIMIZER_EVENTS: list[dict[str, object]] = []
OBSERVATION_TASK: asyncio.Task | None = None
EXECUTION_AI_V6_STATE: dict[str, object] = {
    "episodes": [],
    "actions": {},
    "contexts": {},
    "reward_ema": 0.0,
    "reward_peak": 0.0,
    "reward_drawdown": 0.0,
    "reward_volatility": 0.0,
    "negative_streak": 0,
    "learning_frozen": False,
    "freeze_reasons": [],
    "loaded": False,
    "loaded_at": None,
    "persistence_available": True,
    "last_persist_error": None,
    "updated_at": None,
}


def _normalize_trade_side(value: object, default: str = "buy") -> str:
    candidate = value.value if isinstance(value, Enum) else value
    normalized = str(candidate or "").strip().lower()
    if "." in normalized:
        normalized = normalized.rsplit(".", 1)[-1]
    if normalized in {"buy", "sell"}:
        return normalized
    return default

def _env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


_OBS_WINDOW_SIZE = max(30, min(600, int(_env_float("ROUTING_OBSERVATION_WINDOW_CYCLES", 120.0))))
_OBSERVATION_INTERVAL_SEC = max(0.5, min(10.0, _env_float("ROUTING_OBSERVATION_INTERVAL_SEC", 2.0)))
_OBSERVATION_BUS_WARN_AFTER_SEC = max(1.0, min(10.0, _env_float("ROUTING_OBSERVATION_BUS_WARN_AFTER_SEC", 3.0)))
_OBSERVATION_BUS_OFFLINE_AFTER_SEC = max(
    _OBSERVATION_BUS_WARN_AFTER_SEC,
    min(30.0, _env_float("ROUTING_OBSERVATION_BUS_OFFLINE_AFTER_SEC", 8.0)),
)
_OBSERVATION_NO_TRADES_AFTER_SEC = max(5.0, min(600.0, _env_float("ROUTING_OBSERVATION_NO_TRADES_AFTER_SEC", 60.0)))
_OBSERVATION_READY_GRACE_SEC = max(_OBSERVATION_INTERVAL_SEC, min(30.0, _env_float("ROUTING_OBSERVATION_READY_GRACE_SEC", 12.0)))
_OBSERVATION_SYMBOLS_RAW = os.getenv("ROUTING_OBSERVATION_SYMBOLS", "BTCUSDT")
_ROUTING_INCLUDE_PAPER_VENUES = os.getenv("ROUTING_INCLUDE_PAPER_VENUES", "0").strip().lower() in {"1", "true", "yes", "on"}
_ROUTE_CANDIDATE_MAX_FRESHNESS_MS = max(5_000.0, min(3_600_000.0, _env_float("ROUTE_CANDIDATE_MAX_FRESHNESS_MS", 120_000.0)))
_obs_cycle_results: deque[bool] = deque(maxlen=_OBS_WINDOW_SIZE)
_obs_last_bus_event_ts: float = 0.0
_obs_last_trade_ts: float = 0.0
_obs_last_error: str | None = None
_obs_last_ready_ts: float = 0.0
_obs_last_ready_snapshot: dict[str, object] | None = None
OBSERVATION_STATE: dict[str, object] = {
    "bus_seq": 0,
    "consistency": None,
    "flags": ["OBSERVATION_WARMING_UP", "SEQ_ZERO"],
    "candidate_count": 0,
    "freshness_ms": None,
    "deviation_bps": None,
    "failure_blocking": False,
    "updated_at": None,
    "symbols": [],
}


def _observation_symbols() -> list[str]:
    symbols: list[str] = []
    seen: set[str] = set()
    for item in _OBSERVATION_SYMBOLS_RAW.split(","):
        normalized = _normalize_symbol(item)
        if normalized and normalized not in seen:
            symbols.append(normalized)
            seen.add(normalized)
    if not symbols:
        return ["BTCUSDT"]
    return symbols


def _mark_bus_event(*, trade_seen: bool = False) -> None:
    global _obs_last_bus_event_ts, _obs_last_trade_ts
    now_ts = time.time()
    _obs_last_bus_event_ts = now_ts
    if trade_seen:
        _obs_last_trade_ts = now_ts


def _observation_flags(candidate_count: int) -> list[str]:
    now_ts = time.time()
    flags: list[str] = []
    bus_age = now_ts - _obs_last_bus_event_ts if _obs_last_bus_event_ts > 0 else None
    trade_age = now_ts - _obs_last_trade_ts if _obs_last_trade_ts > 0 else None

    if int(OBSERVATION_STATE.get("bus_seq", 0)) == 0:
        flags.append("SEQ_ZERO")
    if candidate_count <= 0:
        flags.append("NO_CANDIDATES")
    if bus_age is None or bus_age >= _OBSERVATION_BUS_OFFLINE_AFTER_SEC:
        flags.append("BUS_OFFLINE")
    elif bus_age >= _OBSERVATION_BUS_WARN_AFTER_SEC:
        flags.append("BUS_DEGRADED")
    if trade_age is not None and trade_age >= _OBSERVATION_NO_TRADES_AFTER_SEC:
        flags.append("NO_TRADES")
    if OBSERVATION_STATE.get("updated_at") is None:
        flags.append("OBSERVATION_WARMING_UP")
    if _obs_last_error:
        flags.append("OBSERVATION_ERROR")
    return flags


def _observation_snapshot() -> dict[str, object]:
    snapshot = {
        "bus_seq": int(OBSERVATION_STATE.get("bus_seq", 0)),
        "consistency": OBSERVATION_STATE.get("consistency"),
        "flags": list(OBSERVATION_STATE.get("flags") or []),
        "candidate_count": int(OBSERVATION_STATE.get("candidate_count", 0)),
        "deviation_bps": OBSERVATION_STATE.get("deviation_bps"),
        "failure_blocking": bool(OBSERVATION_STATE.get("failure_blocking", False)),
        "freshness_ms": OBSERVATION_STATE.get("freshness_ms"),
        "updated_at": OBSERVATION_STATE.get("updated_at"),
        "symbols": OBSERVATION_STATE.get("symbols") if isinstance(OBSERVATION_STATE.get("symbols"), list) else [],
    }
    if _obs_last_error:
        snapshot["observation_error"] = _obs_last_error
    return snapshot


def _remember_ready_observation(snapshot: dict[str, object]) -> None:
    global _obs_last_ready_snapshot, _obs_last_ready_ts
    _obs_last_ready_snapshot = {
        "candidate_count": int(snapshot.get("candidate_count", 0)),
        "deviation_bps": snapshot.get("deviation_bps"),
        "failure_blocking": bool(snapshot.get("failure_blocking", False)),
        "freshness_ms": snapshot.get("freshness_ms"),
        "symbols": [dict(item) for item in snapshot.get("symbols", []) if isinstance(item, dict)],
    }
    _obs_last_ready_ts = time.time()


def _recent_ready_observation() -> dict[str, object] | None:
    if not _obs_last_ready_snapshot or _obs_last_ready_ts <= 0:
        return None
    if (time.time() - _obs_last_ready_ts) > _OBSERVATION_READY_GRACE_SEC:
        return None
    return {
        "candidate_count": int(_obs_last_ready_snapshot.get("candidate_count", 0)),
        "deviation_bps": _obs_last_ready_snapshot.get("deviation_bps"),
        "failure_blocking": bool(_obs_last_ready_snapshot.get("failure_blocking", False)),
        "freshness_ms": _obs_last_ready_snapshot.get("freshness_ms"),
        "symbols": [dict(item) for item in _obs_last_ready_snapshot.get("symbols", []) if isinstance(item, dict)],
    }


async def _refresh_observation_state() -> None:
    global _obs_last_error

    symbols = _observation_symbols()
    resolved_infra = _resolve_infra_context({"infra_health": 1.0, "network_regime": "stable"})
    symbol_snapshots: list[dict[str, object]] = []

    for symbol in symbols:
        candidates = await _build_route_candidates(symbol, infra_context=resolved_infra)
        context = _build_route_context(candidates)
        failure_attribution = _build_route_failure_attribution(candidates, context, resolved_infra)
        freshest_ms = min((_to_float(item.get("freshness_ms"), 999999.0) for item in candidates), default=999999.0)
        symbol_snapshots.append(
            {
                "symbol": symbol,
                "candidate_count": len(candidates),
                "deviation_bps": _to_float(context.get("deviation_bps"), 0.0),
                "freshness_ms": None if freshest_ms >= 999999.0 else round(freshest_ms, 3),
                "failure_blocking": bool(failure_attribution.get("failure_blocking")),
            }
        )

    candidate_count = min((int(item.get("candidate_count", 0)) for item in symbol_snapshots), default=0)
    deviation_bps = max((_to_float(item.get("deviation_bps"), 0.0) for item in symbol_snapshots), default=0.0)
    freshness_values = [_to_float(item.get("freshness_ms"), 0.0) for item in symbol_snapshots if item.get("freshness_ms") is not None]
    freshness_ms = max(freshness_values) if freshness_values else None
    failure_blocking = any(bool(item.get("failure_blocking")) for item in symbol_snapshots)
    grace_applied = False
    if candidate_count <= 0:
        ready_snapshot = _recent_ready_observation()
        if ready_snapshot is not None:
            candidate_count = int(ready_snapshot.get("candidate_count", 0))
            deviation_bps = _to_float(ready_snapshot.get("deviation_bps"), 0.0)
            freshness_ms = ready_snapshot.get("freshness_ms")
            failure_blocking = bool(ready_snapshot.get("failure_blocking", False))
            symbol_snapshots = [dict(item) for item in ready_snapshot.get("symbols", []) if isinstance(item, dict)]
            grace_applied = True
    valid = candidate_count >= 3 and deviation_bps < 20.0 and not failure_blocking
    _obs_cycle_results.append(valid)

    total = len(_obs_cycle_results)
    OBSERVATION_STATE.update(
        {
            "bus_seq": int(OBSERVATION_STATE.get("bus_seq", 0)) + 1,
            "consistency": round(sum(_obs_cycle_results) / total * 100, 1) if total > 0 else None,
            "candidate_count": candidate_count,
            "freshness_ms": None if freshness_ms is None else round(freshness_ms, 3),
            "deviation_bps": round(deviation_bps, 6),
            "failure_blocking": failure_blocking,
            "updated_at": _now_iso(),
            "symbols": symbol_snapshots,
        }
    )
    OBSERVATION_STATE["flags"] = _observation_flags(candidate_count)
    if grace_applied:
        flags = [flag for flag in OBSERVATION_STATE["flags"] if flag not in {"BUS_OFFLINE", "NO_CANDIDATES"}]
        if "BUS_DEGRADED" not in flags:
            flags.append("BUS_DEGRADED")
        if "OBSERVATION_GRACE" not in flags:
            flags.append("OBSERVATION_GRACE")
        OBSERVATION_STATE["flags"] = flags
    elif candidate_count > 0 and not failure_blocking:
        _remember_ready_observation({
            "candidate_count": candidate_count,
            "deviation_bps": round(deviation_bps, 6),
            "failure_blocking": failure_blocking,
            "freshness_ms": None if freshness_ms is None else round(freshness_ms, 3),
            "symbols": symbol_snapshots,
        })
    _obs_last_error = None


async def _observation_loop() -> None:
    global _obs_last_error

    while True:
        try:
            await _refresh_observation_state()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            _obs_last_error = str(exc)
            OBSERVATION_STATE["bus_seq"] = int(OBSERVATION_STATE.get("bus_seq", 0)) + 1
            OBSERVATION_STATE["updated_at"] = _now_iso()
            OBSERVATION_STATE["flags"] = _observation_flags(int(OBSERVATION_STATE.get("candidate_count", 0)))
        await asyncio.sleep(_OBSERVATION_INTERVAL_SEC)


VENUE_EXECUTION_PROFILES: dict[str, dict[str, object]] = {
    "binance": {
        "matching_rule": "price-time",
        "queue_priority_bias": 0.88,
        "hidden_liquidity_ratio": 0.1,
        "latency_base_ms": 16,
        "latency_jitter_ms": 4,
        "partial_fill_bias": 0.1,
    },
    "bybit": {
        "matching_rule": "price-time",
        "queue_priority_bias": 0.82,
        "hidden_liquidity_ratio": 0.12,
        "latency_base_ms": 17,
        "latency_jitter_ms": 5,
        "partial_fill_bias": 0.12,
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

VENUE_FEE_BPS: dict[str, float] = {
    "binance": 4.0,
    "bybit": 4.8,
    "okx": 4.5,
    "bitget": 5.8,
    "bingx": 6.2,
    "hyperliquid": 5.0,
    "default": 6.5,
}

VENUE_PREFERENCE_ALIASES: dict[str, str] = {
    "binance": "binance-public",
    "binance-public": "binance-public",
    "bybit": "bybit-public",
    "bybit-public": "bybit-public",
    "coinbase": "coinbase-public",
    "coinbase-public": "coinbase-public",
    "okx": "okx-public",
    "okx-public": "okx-public",
    "bingx": "bingx-public",
    "bingx-public": "bingx-public",
    "bitget": "bitget-public",
    "bitget-public": "bitget-public",
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalize_symbol(symbol: str) -> str:
    return symbol.replace("-PERP", "").replace("/", "").replace("-", "").upper()


def _normalize_market_venue_name(value: object) -> str:
    normalized = str(value or "").strip().lower()
    return VENUE_PREFERENCE_ALIASES.get(normalized, normalized)


def _venue_matches_preference(candidate_venue: object, preferred_venue: object) -> bool:
    candidate = _normalize_market_venue_name(candidate_venue)
    preferred = _normalize_market_venue_name(preferred_venue)
    if not candidate or not preferred:
        return False
    if candidate == preferred:
        return True
    return candidate.startswith(preferred) or preferred.startswith(candidate)


def _market_symbol(symbol: str) -> str:
    normalized = _normalize_symbol(symbol)
    if normalized.endswith("USD") and not normalized.endswith("USDT"):
        return f"{normalized[:-3]}USDT"
    return normalized


def _venue_fee_bps(venue: object) -> float:
    normalized = str(venue or "").strip().lower()
    for key, fee_bps in VENUE_FEE_BPS.items():
        if key != "default" and normalized.startswith(key):
            return fee_bps
    return VENUE_FEE_BPS["default"]


def _to_float(value: object, default: float = 0.0) -> float:
    try:
        return float(value)
    except Exception:
        return default


def _clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def _median_value(values: list[float], default: float = 0.0) -> float:
    cleaned = sorted(value for value in values if math.isfinite(value))
    if not cleaned:
        return default
    midpoint = len(cleaned) // 2
    if len(cleaned) % 2:
        return cleaned[midpoint]
    return (cleaned[midpoint - 1] + cleaned[midpoint]) / 2.0


def _normalize_requested_notional_usd(value: object, default: float = 1000.0) -> float:
    return max(25.0, _to_float(value, default))


def _as_dict(value: object) -> dict[str, object]:
    return value if isinstance(value, dict) else {}


def _as_list(value: object) -> list[dict[str, object]]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def _append_execution_optimizer_event(event: dict[str, object]) -> None:
    RECENT_EXECUTION_OPTIMIZER_EVENTS.insert(0, event)
    del RECENT_EXECUTION_OPTIMIZER_EVENTS[80:]


def _reset_execution_ai_v6_runtime_state(*, loaded: bool = False) -> None:
    EXECUTION_AI_V6_STATE.clear()
    EXECUTION_AI_V6_STATE.update(
        {
            "episodes": [],
            "actions": {},
            "contexts": {},
            "reward_ema": 0.0,
            "reward_peak": 0.0,
            "reward_drawdown": 0.0,
            "reward_volatility": 0.0,
            "negative_streak": 0,
            "learning_frozen": False,
            "freeze_reasons": [],
            "loaded": loaded,
            "loaded_at": _now_iso() if loaded else None,
            "persistence_available": True,
            "last_persist_error": None,
            "updated_at": None,
        }
    )


def _persist_execution_ai_v6_episode(episode: dict[str, object]) -> bool:
    if not bool(EXECUTION_AI_V6_STATE.get("persistence_available", True)):
        return False
    reward_components = episode.get("reward_components") if isinstance(episode.get("reward_components"), dict) else {}
    try:
        execute(
            """
            INSERT INTO execution_ai_v6_episodes (
              decision_id,
              context_key,
              action,
              reward,
              learning_applied,
              state,
              reward_components,
              created_at
            ) VALUES (%s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s)
            """,
            (
                str(episode.get("decision_id") or "") or None,
                str(episode.get("context_key") or "unknown"),
                str(episode.get("action") or "hold"),
                _to_float(episode.get("reward"), 0.0),
                bool(episode.get("learning_applied", True)),
                json_dumps(episode.get("state") if isinstance(episode.get("state"), dict) else {}),
                json_dumps(reward_components),
                datetime.fromisoformat(str(episode.get("timestamp") or _now_iso())),
            ),
        )
    except Exception as exc:
        EXECUTION_AI_V6_STATE.update(
            {
                "persistence_available": False,
                "last_persist_error": str(exc)[:240],
                "updated_at": _now_iso(),
            }
        )
        return False
    EXECUTION_AI_V6_STATE.update(
        {
            "persistence_available": True,
            "last_persist_error": None,
        }
    )
    return True


def _load_execution_ai_v6_episodes(limit: int = 240) -> list[dict[str, object]]:
    if not bool(EXECUTION_AI_V6_STATE.get("persistence_available", True)):
        return []
    try:
        rows = fetch_all(
            """
            SELECT decision_id, context_key, action, reward, learning_applied, state, reward_components, created_at
            FROM execution_ai_v6_episodes
            ORDER BY created_at DESC, id DESC
            LIMIT %s
            """,
            (max(1, limit),),
        )
    except Exception as exc:
        EXECUTION_AI_V6_STATE.update(
            {
                "persistence_available": False,
                "last_persist_error": str(exc)[:240],
                "updated_at": _now_iso(),
            }
        )
        return []
    episodes: list[dict[str, object]] = []
    for row in rows:
        state = row.get("state") if isinstance(row.get("state"), dict) else {}
        reward_components = row.get("reward_components") if isinstance(row.get("reward_components"), dict) else {}
        created_at = row.get("created_at")
        episodes.append(
            {
                "decision_id": row.get("decision_id"),
                "timestamp": created_at.isoformat() if isinstance(created_at, datetime) else _now_iso(),
                "context_key": str(row.get("context_key") or "unknown"),
                "state": state,
                "action": str(row.get("action") or "hold"),
                "reward": round(_to_float(row.get("reward"), 0.0), 6),
                "learning_applied": bool(row.get("learning_applied", True)),
                "reward_components": reward_components,
            }
        )
    EXECUTION_AI_V6_STATE.update(
        {
            "persistence_available": True,
            "last_persist_error": None,
        }
    )
    return episodes


def _rebuild_execution_ai_v6_state_from_episodes(episodes: list[dict[str, object]]) -> None:
    _reset_execution_ai_v6_runtime_state(loaded=True)
    if not episodes:
        return

    action_buckets: dict[str, dict[str, object]] = {}
    context_buckets: dict[str, dict[str, object]] = {}
    chronological = list(reversed(episodes))
    reward_ema = 0.0
    reward_peak = 0.0
    negative_streak = 0
    replayed: list[dict[str, object]] = []

    for episode in chronological:
        reward = _to_float(episode.get("reward"), 0.0)
        action = str(episode.get("action") or "hold")
        context_key = str(episode.get("context_key") or "unknown")
        learning_applied = bool(episode.get("learning_applied", True))
        replayed.append(episode)
        reward_ema = reward if len(replayed) == 1 else reward_ema * 0.82 + reward * 0.18
        reward_peak = max(reward_peak, reward_ema)
        negative_streak = 0 if reward > 0 else negative_streak + 1

        if learning_applied:
            action_bucket = action_buckets.get(action)
            if not isinstance(action_bucket, dict):
                action_bucket = _execution_ai_v6_bucket()
                action_buckets[action] = action_bucket
            _execution_ai_v6_update_bucket(action_bucket, reward)

            context_bucket = context_buckets.get(context_key)
            if not isinstance(context_bucket, dict):
                context_bucket = {"actions": {}, "sample_count": 0, "last_updated_at": None}
                context_buckets[context_key] = context_bucket
            context_actions = context_bucket.get("actions") if isinstance(context_bucket.get("actions"), dict) else {}
            context_action_bucket = context_actions.get(action)
            if not isinstance(context_action_bucket, dict):
                context_action_bucket = _execution_ai_v6_bucket()
                context_actions[action] = context_action_bucket
            _execution_ai_v6_update_bucket(context_action_bucket, reward)
            context_bucket["actions"] = context_actions
            context_bucket["sample_count"] = int(_to_float(context_bucket.get("sample_count"), 0.0)) + 1
            context_bucket["last_updated_at"] = str(episode.get("timestamp") or _now_iso())

    EXECUTION_AI_V6_STATE.update(
        {
            "episodes": list(reversed(replayed))[:240],
            "actions": action_buckets,
            "contexts": context_buckets,
            "reward_ema": round(reward_ema, 6),
            "reward_peak": round(reward_peak, 6),
            "negative_streak": negative_streak,
            "loaded": True,
            "loaded_at": _now_iso(),
            "updated_at": str(episodes[0].get("timestamp") or _now_iso()),
        }
    )
    _execution_ai_v6_recompute_guardrails()


def _ensure_execution_ai_v6_state_loaded(force: bool = False) -> None:
    if bool(EXECUTION_AI_V6_STATE.get("loaded")) and not force:
        return
    persisted = _load_execution_ai_v6_episodes(limit=240)
    _rebuild_execution_ai_v6_state_from_episodes(persisted)


def _compact_persisted_execution_optimizer_order(row: dict[str, object]) -> dict[str, object]:
    payload = row.get("payload") if isinstance(row.get("payload"), dict) else {}
    if isinstance(payload, dict) and payload:
        return payload
    return {
        "decision_id": row.get("decision_id"),
        "order_id": row.get("order_id"),
        "symbol": row.get("instrument"),
        "side": row.get("side"),
        "market_venue": row.get("market_venue"),
        "broker_provider": row.get("broker_provider"),
        "status": row.get("status"),
        "remaining_notional_usd": round(_to_float(row.get("remaining_notional_usd"), 0.0), 6),
        "queue_edge": round(_to_float(row.get("queue_edge"), 0.0), 6),
        "predicted_fill_probability": round(_to_float(row.get("predicted_fill_probability"), 0.0), 6),
        "fill_score": round(_to_float(row.get("fill_score"), 0.0), 6),
        "spoof_detected": bool(row.get("spoof_detected")),
        "lifecycle_action": row.get("lifecycle_action"),
        "lifecycle_reason": row.get("lifecycle_reason"),
        "desk_profile": row.get("desk_profile") if isinstance(row.get("desk_profile"), dict) else {},
        "updated_at": row.get("updated_at"),
        "history": row.get("history") if isinstance(row.get("history"), list) else [],
    }


def _persist_execution_optimizer_active_order(state: dict[str, object]) -> None:
    latest_snapshot = state.get("latest_snapshot") if isinstance(state.get("latest_snapshot"), dict) else {}
    latest_v4 = state.get("latest_v4") if isinstance(state.get("latest_v4"), dict) else {}
    latest_lifecycle = latest_v4.get("lifecycle") if isinstance(latest_v4.get("lifecycle"), dict) else {}
    compact_payload = _compact_execution_optimizer_live_order(state)
    execute(
        """
        INSERT INTO execution_optimizer_active_orders (
          decision_id,
          order_id,
          account_id,
          broker_provider,
          market_venue,
          instrument,
          side,
          status,
          active,
          requested_notional_usd,
          filled_notional_usd,
          remaining_notional_usd,
          lifecycle_action,
          lifecycle_reason,
          queue_edge,
          predicted_fill_probability,
          fill_score,
          spoof_detected,
          desk_profile,
          latest_snapshot,
          latest_v4,
          history,
          payload,
          updated_at,
          finalized_at
        ) VALUES (
          %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
          %s::jsonb, %s::jsonb, %s::jsonb, %s::jsonb, %s::jsonb, NOW(), %s
        )
        ON CONFLICT (decision_id) DO UPDATE SET
          order_id = EXCLUDED.order_id,
          account_id = EXCLUDED.account_id,
          broker_provider = EXCLUDED.broker_provider,
          market_venue = EXCLUDED.market_venue,
          instrument = EXCLUDED.instrument,
          side = EXCLUDED.side,
          status = EXCLUDED.status,
          active = EXCLUDED.active,
          requested_notional_usd = EXCLUDED.requested_notional_usd,
          filled_notional_usd = EXCLUDED.filled_notional_usd,
          remaining_notional_usd = EXCLUDED.remaining_notional_usd,
          lifecycle_action = EXCLUDED.lifecycle_action,
          lifecycle_reason = EXCLUDED.lifecycle_reason,
          queue_edge = EXCLUDED.queue_edge,
          predicted_fill_probability = EXCLUDED.predicted_fill_probability,
          fill_score = EXCLUDED.fill_score,
          spoof_detected = EXCLUDED.spoof_detected,
          desk_profile = EXCLUDED.desk_profile,
          latest_snapshot = EXCLUDED.latest_snapshot,
          latest_v4 = EXCLUDED.latest_v4,
          history = EXCLUDED.history,
          payload = EXCLUDED.payload,
          updated_at = NOW(),
          finalized_at = EXCLUDED.finalized_at
        """,
        (
            str(state.get("decision_id") or ""),
            str(state.get("order_id") or "") or None,
            str(state.get("account_id") or "") or None,
            str(state.get("broker_provider") or "unknown"),
            str(state.get("market_venue") or "unknown"),
            str(state.get("symbol") or "unknown"),
            str(state.get("side") or "buy"),
            str(state.get("status") or "unknown"),
            bool(state.get("active", False)),
            _to_float(state.get("requested_notional_usd"), 0.0),
            _to_float(state.get("filled_notional_usd"), 0.0),
            _to_float(state.get("remaining_notional_usd"), 0.0),
            str(latest_lifecycle.get("action") or "") or None,
            str(latest_lifecycle.get("reason") or "") or None,
            _to_float(compact_payload.get("queue_edge"), 0.0),
            _to_float(compact_payload.get("predicted_fill_probability"), 0.0),
            _to_float(compact_payload.get("fill_score"), 0.0),
            bool(compact_payload.get("spoof_detected")),
            json_dumps(state.get("desk_profile") if isinstance(state.get("desk_profile"), dict) else {}),
            json_dumps(latest_snapshot),
            json_dumps(latest_v4),
            json_dumps(state.get("history") if isinstance(state.get("history"), list) else []),
            json_dumps(compact_payload),
            datetime.now(timezone.utc) if not bool(state.get("active", False)) else None,
        ),
    )


def _persist_execution_optimizer_event(
    state: dict[str, object],
    *,
    event_type: str,
    cycle_index: int | None = None,
    action: str | None = None,
    reason: str | None = None,
    payload_extra: dict[str, object] | None = None,
) -> None:
    compact_payload = _compact_execution_optimizer_live_order(state)
    latest_snapshot = state.get("latest_snapshot") if isinstance(state.get("latest_snapshot"), dict) else {}
    latest_v4 = state.get("latest_v4") if isinstance(state.get("latest_v4"), dict) else {}
    latest_lifecycle = latest_v4.get("lifecycle") if isinstance(latest_v4.get("lifecycle"), dict) else {}
    payload = dict(compact_payload)
    payload["event_type"] = event_type
    if cycle_index is not None:
        payload["cycle_index"] = cycle_index
    if payload_extra:
        payload.update(payload_extra)
    execute(
        """
        INSERT INTO execution_optimizer_lifecycle_events (
          decision_id,
          order_id,
          account_id,
          broker_provider,
          market_venue,
          instrument,
          side,
          cycle_index,
          event_type,
          action,
          reason,
          status,
          queue_edge,
          predicted_fill_probability,
          fill_score,
          expected_slippage_bps,
          spoof_detected,
          payload
        ) VALUES (
          %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb
        )
        """,
        (
            str(state.get("decision_id") or ""),
            str(state.get("order_id") or "") or None,
            str(state.get("account_id") or "") or None,
            str(state.get("broker_provider") or "unknown"),
            str(state.get("market_venue") or "unknown"),
            str(state.get("symbol") or "unknown"),
            str(state.get("side") or "buy"),
            cycle_index,
            event_type,
            action or str(latest_lifecycle.get("action") or "") or None,
            reason or str(latest_lifecycle.get("reason") or "") or None,
            str(state.get("status") or "unknown"),
            _to_float(compact_payload.get("queue_edge"), 0.0),
            _to_float(compact_payload.get("predicted_fill_probability"), 0.0),
            _to_float(compact_payload.get("fill_score"), 0.0),
            _to_float(latest_snapshot.get("expected_slippage_bps"), 0.0),
            bool(compact_payload.get("spoof_detected")),
            json_dumps(payload),
        ),
    )
    event_summary = dict(payload)
    event_summary["updated_at"] = state.get("updated_at")
    _append_execution_optimizer_event(event_summary)


def _load_persisted_active_execution_orders(limit: int = 20) -> list[dict[str, object]]:
    rows = fetch_all(
        """
        SELECT *
        FROM execution_optimizer_active_orders
        WHERE active = TRUE
        ORDER BY updated_at DESC
        LIMIT %s
        """,
        (max(1, limit),),
    )
    return [_compact_persisted_execution_optimizer_order(row) for row in rows if isinstance(row, dict)]


def _load_recent_execution_optimizer_events(limit: int = 20) -> list[dict[str, object]]:
    rows = fetch_all(
        """
        SELECT payload, created_at
        FROM execution_optimizer_lifecycle_events
        ORDER BY created_at DESC, id DESC
        LIMIT %s
        """,
        (max(1, limit),),
    )
    events: list[dict[str, object]] = []
    for row in rows:
        payload = row.get("payload") if isinstance(row.get("payload"), dict) else {}
        if not isinstance(payload, dict):
            continue
        event = dict(payload)
        event.setdefault("updated_at", row.get("created_at"))
        events.append(event)
    return events


def _provider_supports_native_amend(provider: str, current_order: dict[str, object], lifecycle: dict[str, object]) -> bool:
    normalized_provider = str(provider or "").strip().lower()
    order_type = str(current_order.get("order_type") or "").strip().upper()
    target_order_type = str(lifecycle.get("target_order_type") or "").strip().upper()
    return normalized_provider == "bybit" and order_type == "LIMIT" and target_order_type == "LIMIT"


def _live_order_open(status: object) -> bool:
    normalized = str(status or "").strip().lower()
    return normalized in {"open", "partially_filled"}


def _refresh_execution_optimizer_profiles() -> None:
    # Singleflight : une seule reconstruction à la fois, les appels concurrents servent le last_good.
    if not EXECUTION_OPTIMIZER_PROFILE_REFRESH_LOCK.acquire(blocking=False):
        return
    started = time.perf_counter()
    try:
        rows = fetch_all(
        """
                WITH fill_stats AS (
                    SELECT
                        venue,
                        COUNT(*) AS fill_count,
                        AVG(COALESCE(slippage_bps, 0.0)) AS avg_slippage_bps,
                        AVG(COALESCE(fill_latency_ms, 0.0)) AS avg_fill_latency_ms,
                        AVG(COALESCE(NULLIF(payload->>'fill_quality_score', '')::double precision, GREATEST(0.0, 100.0 - COALESCE(slippage_bps, 0.0) * 2.0))) AS avg_fill_quality_score,
                        MAX(filled_at) AS last_fill_at
                    FROM execution_fill_events
                    WHERE filled_at >= NOW() - INTERVAL '7 days'
                    GROUP BY venue
                ),
                lifecycle_stats AS (
                    SELECT
                        market_venue AS venue,
                        COALESCE(AVG(CASE WHEN event_type = 'cycle_evaluation' AND action = 'replace' THEN 1.0 ELSE 0.0 END)
                            FILTER (WHERE event_type = 'cycle_evaluation'), 0.0) AS replace_rate,
                        COALESCE(
                            COUNT(*) FILTER (WHERE event_type = 'order_amend')::double precision /
                            NULLIF(COUNT(*) FILTER (WHERE event_type IN ('order_amend', 'order_cancel_replace', 'cycle_evaluation')), 0),
                            0.0
                        ) AS amend_rate,
                        COALESCE(AVG(CASE WHEN event_type = 'cycle_evaluation' AND action = 'cancel' THEN 1.0 ELSE 0.0 END)
                            FILTER (WHERE event_type = 'cycle_evaluation'), 0.0) AS cancel_rate
                    FROM execution_optimizer_lifecycle_events
                    WHERE created_at >= NOW() - INTERVAL '7 days'
                    GROUP BY market_venue
                )
                SELECT
                    COALESCE(fill_stats.venue, lifecycle_stats.venue) AS venue,
                    COALESCE(fill_stats.fill_count, 0) AS fill_count,
                    COALESCE(fill_stats.avg_slippage_bps, 0.0) AS avg_slippage_bps,
                    COALESCE(fill_stats.avg_fill_latency_ms, 0.0) AS avg_fill_latency_ms,
                    COALESCE(fill_stats.avg_fill_quality_score, 0.0) AS avg_fill_quality_score,
                    fill_stats.last_fill_at AS last_fill_at,
                    COALESCE(lifecycle_stats.replace_rate, 0.0) AS replace_rate,
                    COALESCE(lifecycle_stats.amend_rate, 0.0) AS amend_rate,
                    COALESCE(lifecycle_stats.cancel_rate, 0.0) AS cancel_rate
                FROM fill_stats
                FULL OUTER JOIN lifecycle_stats ON lifecycle_stats.venue = fill_stats.venue
                ORDER BY COALESCE(fill_stats.venue, lifecycle_stats.venue)
        """
        )
        profiles: dict[str, dict[str, object]] = {}
        for row in rows:
            venue = str(row.get("venue") or "unknown")
            profiles[venue] = calibrate_execution_desk_profile(venue, row)
        EXECUTION_OPTIMIZER_PROFILE_CACHE.update(
            {
                "expires_at": time.time() + _optimizer_profile_ttl_sec(),
                "profiles": profiles,
                "updated_at": _now_iso(),
            }
        )
        EXECUTION_OPTIMIZER_PROFILE_METRICS["refresh_count"] = int(EXECUTION_OPTIMIZER_PROFILE_METRICS.get("refresh_count") or 0) + 1
        EXECUTION_OPTIMIZER_PROFILE_METRICS["last_refresh_ms"] = round((time.perf_counter() - started) * 1000.0, 1)
    except Exception as exc:
        EXECUTION_OPTIMIZER_PROFILE_METRICS["refresh_errors"] = int(EXECUTION_OPTIMIZER_PROFILE_METRICS.get("refresh_errors") or 0) + 1
        EXECUTION_OPTIMIZER_PROFILE_METRICS["last_error"] = f"{type(exc).__name__}: {exc}"
        # Échec : on garde le last_good et on retente au plus tôt dans 10s pour éviter une tempête de refresh.
        EXECUTION_OPTIMIZER_PROFILE_CACHE["expires_at"] = time.time() + 10.0
    finally:
        EXECUTION_OPTIMIZER_PROFILE_REFRESH_LOCK.release()


def _load_execution_optimizer_profiles(force: bool = False) -> dict[str, dict[str, object]]:
    now = time.time()
    cached_profiles = EXECUTION_OPTIMIZER_PROFILE_CACHE.get("profiles")
    has_last_good = isinstance(cached_profiles, dict) and EXECUTION_OPTIMIZER_PROFILE_CACHE.get("updated_at") is not None
    if not force and has_last_good and now < _to_float(EXECUTION_OPTIMIZER_PROFILE_CACHE.get("expires_at"), 0.0):
        EXECUTION_OPTIMIZER_PROFILE_METRICS["cache_hit"] = int(EXECUTION_OPTIMIZER_PROFILE_METRICS.get("cache_hit") or 0) + 1
        return cached_profiles  # type: ignore[return-value]
    EXECUTION_OPTIMIZER_PROFILE_METRICS["cache_miss"] = int(EXECUTION_OPTIMIZER_PROFILE_METRICS.get("cache_miss") or 0) + 1
    # La reconstruction (requête lourde) part en thread pour ne jamais bloquer l'event loop ;
    # l'appelant repart immédiatement avec le last_good, ou les profils par défaut à froid.
    threading.Thread(target=_refresh_execution_optimizer_profiles, name="optimizer-profile-refresh", daemon=True).start()
    if has_last_good:
        EXECUTION_OPTIMIZER_PROFILE_METRICS["stale_served"] = int(EXECUTION_OPTIMIZER_PROFILE_METRICS.get("stale_served") or 0) + 1
        return cached_profiles  # type: ignore[return-value]
    EXECUTION_OPTIMIZER_PROFILE_METRICS["cold_miss"] = int(EXECUTION_OPTIMIZER_PROFILE_METRICS.get("cold_miss") or 0) + 1
    return {}


def _execution_optimizer_profile_for_venue(venue: str) -> dict[str, object]:
    profiles = _load_execution_optimizer_profiles()
    normalized = str(venue or "").strip().lower()
    exact = profiles.get(normalized)
    if isinstance(exact, dict):
        return exact
    prefixed = next((profile for key, profile in profiles.items() if normalized and key.startswith(normalized)), None)
    if isinstance(prefixed, dict):
        return prefixed
    return calibrate_execution_desk_profile(normalized or "unknown", {})


def _remaining_notional_usd(order_payload: dict[str, object]) -> float:
    requested = max(0.0, _to_float(order_payload.get("requested_notional_usd"), 0.0))
    filled = max(0.0, _to_float(order_payload.get("filled_notional_usd"), 0.0))
    return max(0.0, requested - filled)


def _normalize_trade_protection_request(payload: object) -> dict[str, object]:
    if not isinstance(payload, dict) or not payload:
        return {}
    try:
        normalized = TradeProtectionRequest.model_validate(payload).model_dump(mode="json", exclude_none=True)
    except Exception:
        return {}
    return normalized if isinstance(normalized.get("take_profit"), dict) or isinstance(normalized.get("stop_loss"), dict) else {}


def _requested_protection_leg_count(payload: dict[str, object]) -> int:
    count = 0
    for key in ("take_profit", "stop_loss"):
        if isinstance(payload.get(key), dict):
            count += 1
    return count


def _normalize_live_order_protection(order_payload: dict[str, object], requested: dict[str, object]) -> dict[str, object]:
    if not requested:
        return order_payload
    normalized = dict(order_payload)
    raw_protection = normalized.get("protection") if isinstance(normalized.get("protection"), dict) else {}
    requested_payload = raw_protection.get("requested") if isinstance(raw_protection.get("requested"), dict) else requested
    accepted_payload = raw_protection.get("accepted") if isinstance(raw_protection.get("accepted"), dict) else {}
    requested_count = _requested_protection_leg_count(requested_payload)
    if requested_count <= 0:
        return normalized
    accepted_count = _requested_protection_leg_count(accepted_payload)
    missing = [
        leg_name
        for leg_name in ("take_profit", "stop_loss")
        if isinstance(requested_payload.get(leg_name), dict) and not isinstance(accepted_payload.get(leg_name), dict)
    ]
    existing_reasons = raw_protection.get("reasons") if isinstance(raw_protection.get("reasons"), list) else []
    reasons: list[str] = []
    for item in [*existing_reasons, *[f"{name} was not acknowledged by BingX" for name in missing]]:
        text = str(item or "").strip()
        if text and text not in reasons:
            reasons.append(text)
    if accepted_count >= requested_count:
        protection_status = "armed"
    elif accepted_count > 0:
        protection_status = "protection_partial"
    else:
        existing_status = str(normalized.get("protection_status") or raw_protection.get("status") or "").strip().lower()
        protection_status = existing_status if existing_status in {"protection_rejected", "rejected_preflight"} else "protection_rejected"
    normalized["protection_status"] = protection_status
    normalized["protection"] = {
        "mode": str(raw_protection.get("mode") or "native_attached"),
        "status": protection_status,
        "require_full_acceptance": bool(raw_protection.get("require_full_acceptance", requested_payload.get("require_full_acceptance", True))),
        "requested": requested_payload,
        "accepted": accepted_payload,
        "reasons": reasons,
    }
    return normalized


def _live_execution_context(payload: dict[str, object]) -> dict[str, object]:
    live = _as_dict(payload.get("live_execution"))
    metadata = _as_dict(payload.get("metadata"))
    provider = str(live.get("provider") or metadata.get("provider") or "").strip().lower()
    account_id = str(live.get("account_id") or metadata.get("account_id") or "").strip()
    secret_payload = live.get("secret_payload") if isinstance(live.get("secret_payload"), dict) else None
    enabled = bool(live.get("enabled")) and provider in {"bingx", "bybit"} and bool(account_id) and isinstance(secret_payload, dict)
    protection = _normalize_trade_protection_request(live.get("protection") if isinstance(live.get("protection"), dict) else payload.get("protection"))
    return {
        "enabled": enabled,
        "provider": provider,
        "account_id": account_id,
        "secret_payload": secret_payload,
        "order_type": str(live.get("order_type") or payload.get("order_type") or "MARKET").strip().upper(),
        "time_in_force": str(live.get("time_in_force") or payload.get("time_in_force") or "GTC").strip().upper(),
        "position_side": str(live.get("position_side") or payload.get("position_side") or "").strip().upper(),
        "reduce_only": bool(live.get("reduce_only", payload.get("reduce_only", False))),
        "auto_adjust_notional": bool(live.get("auto_adjust_notional", live.get("auto_size", payload.get("auto_adjust_notional", True)))),
        "price": _to_float(live.get("price") or payload.get("price"), 0.0),
        "quantity": _to_float(live.get("quantity") or payload.get("quantity"), 0.0),
        "notional_usd": _to_float(live.get("notional_usd") or payload.get("estimated_notional_usd"), 0.0),
        "client_order_id": str(live.get("client_order_id") or payload.get("client_order_id") or "").strip(),
        "dry_run": bool(live.get("dry_run", payload.get("dry_run", False))),
        "dry_run_accepted_legs": live.get("dry_run_accepted_legs") if isinstance(live.get("dry_run_accepted_legs"), (list, tuple, set, str)) else payload.get("dry_run_accepted_legs"),
        "protection": protection,
    }


def _resolve_live_execution_notional(
    payload: dict[str, object],
    live_context: dict[str, object],
    selected_execution_context: dict[str, object],
) -> tuple[float, float, bool]:
    requested_notional = _to_float(payload.get("estimated_notional_usd"), _to_float(live_context.get("notional_usd"), 0.0))
    context_adjusted_notional = _to_float(selected_execution_context.get("target_notional_usd"), requested_notional)
    if context_adjusted_notional <= 0:
        context_adjusted_notional = requested_notional
    metadata = _as_dict(payload.get("metadata"))
    execution_mode = str(payload.get("execution_mode") or "").strip().lower()
    preserve_approved_live_notional = bool(live_context.get("enabled")) and (
        execution_mode == "live-intent" or str(metadata.get("origin") or "").strip().lower() == "approved-intent"
    )
    execution_notional = requested_notional if preserve_approved_live_notional and requested_notional > 0 else context_adjusted_notional
    if execution_notional <= 0:
        execution_notional = requested_notional
    return execution_notional, context_adjusted_notional, preserve_approved_live_notional


def _compact_execution_optimizer_candidate(candidate: dict[str, object], snapshot: dict[str, object]) -> dict[str, object]:
    queue = snapshot.get("queue") if isinstance(snapshot.get("queue"), dict) else {}
    guard = snapshot.get("slippage_guard") if isinstance(snapshot.get("slippage_guard"), dict) else {}
    order_management = snapshot.get("order_management") if isinstance(snapshot.get("order_management"), dict) else {}
    market_structure = snapshot.get("market_structure") if isinstance(snapshot.get("market_structure"), dict) else {}
    execution_context = snapshot.get("execution_context") if isinstance(snapshot.get("execution_context"), dict) else {}
    return {
        "venue": str(candidate.get("venue") or "unknown"),
        "spread_bps": round(_to_float(candidate.get("spread_bps"), 0.0), 6),
        "available_depth_usd": round(_to_float(candidate.get("available_depth_usd"), 0.0), 6),
        "predicted_fill_probability": round(_to_float(snapshot.get("predicted_fill_probability"), 0.0), 6),
        "expected_slippage_bps": round(_to_float(snapshot.get("expected_slippage_bps"), 0.0), 6),
        "queue_edge": round(_to_float(queue.get("queue_edge"), 0.0), 6),
        "slippage_guard": guard,
        "order_management": order_management,
        "market_structure": market_structure,
        "execution_context": execution_context,
        "desk_profile": snapshot.get("desk_profile") if isinstance(snapshot.get("desk_profile"), dict) else {},
    }


def _enrich_execution_optimizer_snapshot(
    candidate: dict[str, object],
    snapshot: dict[str, object],
    side: str,
    notional_usd: float,
) -> dict[str, object]:
    enriched = dict(snapshot)
    market_structure = build_market_structure_snapshot(candidate, side)
    fill_prediction = snapshot.get("fill_prediction") if isinstance(snapshot.get("fill_prediction"), dict) else {}
    execution_context = build_execution_context(candidate, market_structure, fill_prediction, side, notional_usd)
    enriched["market_structure"] = market_structure
    enriched["execution_context"] = execution_context
    return enriched


async def _execute_live_order(payload: dict[str, object], live_context: dict[str, object], decision_id: str) -> dict[str, object]:
    side = _normalize_trade_side(payload.get("side"))
    requested_protection = live_context.get("protection") if isinstance(live_context.get("protection"), dict) else {}
    request_payload: dict[str, object] = {
        "provider": str(live_context.get("provider") or "bingx"),
        "account_id": str(live_context.get("account_id") or ""),
        "secret_payload": live_context.get("secret_payload"),
        "symbol": str(payload.get("symbol") or ""),
        "side": side,
        "notional_usd": _to_float(live_context.get("notional_usd"), 0.0),
        "order_type": str(live_context.get("order_type") or "MARKET"),
        "time_in_force": str(live_context.get("time_in_force") or "GTC"),
        "position_side": str(live_context.get("position_side") or ""),
        "reduce_only": bool(live_context.get("reduce_only", False)),
        "auto_adjust_notional": bool(live_context.get("auto_adjust_notional", True)),
        "client_order_id": str(live_context.get("client_order_id") or f"txt-{decision_id}")[:40],
    }
    if bool(live_context.get("dry_run")):
        request_payload["dry_run"] = True
    if live_context.get("dry_run_accepted_legs") is not None:
        request_payload["dry_run_accepted_legs"] = live_context.get("dry_run_accepted_legs")
    if _to_float(live_context.get("price"), 0.0) > 0:
        request_payload["price"] = _to_float(live_context.get("price"), 0.0)
    if _to_float(live_context.get("quantity"), 0.0) > 0:
        request_payload["quantity"] = _to_float(live_context.get("quantity"), 0.0)
    if requested_protection:
        request_payload["protection"] = requested_protection

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
    return _normalize_live_order_protection(body, requested_protection)


async def _query_live_order_status(live_context: dict[str, object], payload: dict[str, object], order_payload: dict[str, object]) -> dict[str, object]:
    side = _normalize_trade_side(payload.get("side"))
    requested_protection = live_context.get("protection") if isinstance(live_context.get("protection"), dict) else {}
    request_payload: dict[str, object] = {
        "provider": str(live_context.get("provider") or ""),
        "account_id": str(live_context.get("account_id") or ""),
        "secret_payload": live_context.get("secret_payload"),
        "symbol": str(payload.get("symbol") or ""),
        "side": side,
        "order_id": order_payload.get("order_id"),
        "client_order_id": order_payload.get("client_order_id"),
        "notional_usd": _to_float(order_payload.get("requested_notional_usd"), _to_float(live_context.get("notional_usd"), 0.0)),
    }
    async with httpx.AsyncClient(timeout=20.0) as client:
        response = await client.post(f"{BROKER_ADAPTER_URL}/v1/live/orders/status", json=request_payload)
    if response.status_code >= 400:
        detail: object
        try:
            detail = response.json()
        except ValueError:
            detail = response.text[:500]
        raise HTTPException(status_code=502 if response.status_code >= 500 else response.status_code, detail=detail)
    body = response.json()
    if not isinstance(body, dict):
        raise HTTPException(status_code=502, detail="broker-adapter returned invalid order status payload")
    return _normalize_live_order_protection(body, requested_protection)


async def _cancel_live_order(live_context: dict[str, object], payload: dict[str, object], order_payload: dict[str, object]) -> dict[str, object]:
    side = _normalize_trade_side(payload.get("side"))
    request_payload: dict[str, object] = {
        "provider": str(live_context.get("provider") or ""),
        "account_id": str(live_context.get("account_id") or ""),
        "secret_payload": live_context.get("secret_payload"),
        "symbol": str(payload.get("symbol") or ""),
        "side": side,
        "order_id": order_payload.get("order_id"),
        "client_order_id": order_payload.get("client_order_id"),
        "notional_usd": _to_float(order_payload.get("requested_notional_usd"), _to_float(live_context.get("notional_usd"), 0.0)),
    }
    async with httpx.AsyncClient(timeout=20.0) as client:
        response = await client.post(f"{BROKER_ADAPTER_URL}/v1/live/orders/cancel", json=request_payload)
    if response.status_code >= 400:
        detail: object
        try:
            detail = response.json()
        except ValueError:
            detail = response.text[:500]
        raise HTTPException(status_code=502 if response.status_code >= 500 else response.status_code, detail=detail)
    body = response.json()
    if not isinstance(body, dict):
        raise HTTPException(status_code=502, detail="broker-adapter returned invalid cancel payload")
    return body


async def _amend_live_order(
    live_context: dict[str, object],
    payload: dict[str, object],
    order_payload: dict[str, object],
    *,
    target_price: float,
    target_quantity: float = 0.0,
) -> dict[str, object]:
    side = _normalize_trade_side(payload.get("side"))
    request_payload: dict[str, object] = {
        "provider": str(live_context.get("provider") or ""),
        "account_id": str(live_context.get("account_id") or ""),
        "secret_payload": live_context.get("secret_payload"),
        "symbol": str(payload.get("symbol") or ""),
        "side": side,
        "order_id": order_payload.get("order_id"),
        "client_order_id": order_payload.get("client_order_id"),
        "notional_usd": _to_float(order_payload.get("requested_notional_usd"), _to_float(live_context.get("notional_usd"), 0.0)),
        "price": target_price,
    }
    if target_quantity > 0:
        request_payload["quantity"] = target_quantity
    async with httpx.AsyncClient(timeout=20.0) as client:
        response = await client.post(f"{BROKER_ADAPTER_URL}/v1/live/orders/amend", json=request_payload)
    if response.status_code >= 400:
        detail: object
        try:
            detail = response.json()
        except ValueError:
            detail = response.text[:500]
        raise HTTPException(status_code=502 if response.status_code >= 500 else response.status_code, detail=detail)
    body = response.json()
    if not isinstance(body, dict):
        raise HTTPException(status_code=502, detail="broker-adapter returned invalid amend payload")
    return body


async def _candidate_for_market_venue(symbol: str, market_venue: str, infra_context: dict[str, object]) -> dict[str, object]:
    candidates = await _build_route_candidates(symbol, infra_context=infra_context)
    normalized_venue = str(market_venue or "").strip().lower()
    exact = next((candidate for candidate in candidates if str(candidate.get("venue") or "").strip().lower() == normalized_venue), None)
    if isinstance(exact, dict):
        return exact
    startswith = next((candidate for candidate in candidates if normalized_venue and str(candidate.get("venue") or "").strip().lower().startswith(normalized_venue)), None)
    if isinstance(startswith, dict):
        return startswith
    return candidates[0] if candidates else {}


def _compact_execution_optimizer_live_order(state: dict[str, object]) -> dict[str, object]:
    latest_snapshot = state.get("latest_snapshot") if isinstance(state.get("latest_snapshot"), dict) else {}
    latest_v4 = state.get("latest_v4") if isinstance(state.get("latest_v4"), dict) else {}
    latest_guard = latest_v4.get("guard") if isinstance(latest_v4.get("guard"), dict) else {}
    latest_spoof = latest_v4.get("spoof") if isinstance(latest_v4.get("spoof"), dict) else {}
    latest_lifecycle = latest_v4.get("lifecycle") if isinstance(latest_v4.get("lifecycle"), dict) else {}
    latest_context = latest_v4.get("context") if isinstance(latest_v4.get("context"), dict) else {}
    latest_market_structure = latest_v4.get("market_structure") if isinstance(latest_v4.get("market_structure"), dict) else {}
    queue = latest_snapshot.get("queue") if isinstance(latest_snapshot.get("queue"), dict) else {}
    queue_tracker = latest_v4.get("queue_tracker") if isinstance(latest_v4.get("queue_tracker"), dict) else {}
    fill_state = latest_v4.get("fill") if isinstance(latest_v4.get("fill"), dict) else {}
    candidate_metrics = latest_v4.get("candidate_metrics") if isinstance(latest_v4.get("candidate_metrics"), dict) else {}
    return {
        "decision_id": state.get("decision_id"),
        "order_id": state.get("order_id"),
        "symbol": state.get("symbol"),
        "side": state.get("side"),
        "market_venue": state.get("market_venue"),
        "broker_provider": state.get("broker_provider"),
        "status": state.get("status"),
        "remaining_notional_usd": round(_to_float(state.get("remaining_notional_usd"), 0.0), 6),
        "queue_edge": round(_to_float(queue.get("queue_edge"), 0.0), 6),
        "queue_position_usd": round(_to_float(queue_tracker.get("queue_position_usd"), 0.0), 6),
        "queue_rank_estimate": round(_to_float(fill_state.get("queue_rank_estimate"), _to_float(queue_tracker.get("queue_rank_estimate"), 0.0)), 6),
        "predicted_fill_probability": round(_to_float(fill_state.get("effective_fill_probability"), _to_float(latest_snapshot.get("predicted_fill_probability"), 0.0)), 6),
        "fill_score": round(_to_float(fill_state.get("fill_score"), 0.0), 6),
        "aggressiveness": round(_to_float(fill_state.get("aggressiveness"), 0.0), 6),
        "dominance_score": round(_to_float(fill_state.get("dominance_score"), 0.0), 6),
        "time_in_queue_ms": round(_to_float(fill_state.get("time_in_queue_ms"), _to_float(queue_tracker.get("time_in_queue_ms"), 0.0)), 6),
        "time_to_fill_estimate_ms": round(_to_float(fill_state.get("time_to_fill_estimate_ms"), 0.0), 6) if fill_state.get("time_to_fill_estimate_ms") is not None else None,
        "adverse_selection_score": round(_to_float(fill_state.get("adverse_selection_score"), 0.0), 6),
        "liquidity_decay_rate": round(_to_float(fill_state.get("liquidity_decay_rate"), _to_float(queue_tracker.get("liquidity_decay_rate"), 0.0)), 6),
        "latency_ms": round(_to_float(candidate_metrics.get("latency_ms"), 0.0), 6),
        "freshness_ms": round(_to_float(candidate_metrics.get("freshness_ms"), 0.0), 6),
        "guard_reasons": latest_guard.get("reasons") or [],
        "spoof_detected": bool(latest_spoof.get("spoof_detected")),
        "liquidity_trap_detected": bool(fill_state.get("liquidity_trap_detected")),
        "should_move_ahead": bool(fill_state.get("should_move_ahead")),
        "lifecycle_action": latest_lifecycle.get("action"),
        "lifecycle_reason": latest_lifecycle.get("reason"),
        "timing": latest_lifecycle.get("timing"),
        "market_structure": latest_market_structure,
        "execution_context": latest_context,
        "desk_profile": state.get("desk_profile") if isinstance(state.get("desk_profile"), dict) else {},
        "updated_at": state.get("updated_at"),
        "history": state.get("history") if isinstance(state.get("history"), list) else [],
    }


def _update_active_execution_order(decision_id: str, state: dict[str, object]) -> None:
    ACTIVE_EXECUTION_ORDERS[decision_id] = state
    _persist_execution_optimizer_active_order(state)


def _finalize_active_execution_order(decision_id: str, state: dict[str, object]) -> None:
    state["updated_at"] = _now_iso()
    state["active"] = False
    _persist_execution_optimizer_active_order(state)
    _persist_execution_optimizer_event(state, event_type="loop_finalized")
    ACTIVE_EXECUTION_ORDERS.pop(decision_id, None)
    ACTIVE_EXECUTION_ORDER_TASKS.pop(decision_id, None)


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


async def _run_execution_optimizer_live_loop(
    *,
    payload: dict[str, object],
    live_context: dict[str, object],
    broker_order: dict[str, object],
    selected_candidate: dict[str, object],
    route_preferences: dict[str, object],
    decision_id: str,
) -> None:
    side = _normalize_trade_side(payload.get("side"))
    payload["side"] = side
    market_venue = str(selected_candidate.get("venue") or live_context.get("provider") or "unknown")
    broker_provider = str(live_context.get("provider") or broker_order.get("venue") or "unknown")
    desk_profile = _execution_optimizer_profile_for_venue(market_venue)
    latest_snapshot = _enrich_execution_optimizer_snapshot(
        selected_candidate,
        build_execution_optimizer_snapshot(
            selected_candidate,
            side,
            _remaining_notional_usd(broker_order),
            str(route_preferences.get("execution_style") or "default"),
            str(live_context.get("order_type") or "LIMIT"),
            _to_float(live_context.get("price"), 0.0),
            desk_profile=desk_profile,
        ),
        side,
        _remaining_notional_usd(broker_order),
    )
    queue_tracker = initialize_queue_tracker(selected_candidate, latest_snapshot.get("queue") if isinstance(latest_snapshot.get("queue"), dict) else {})
    state: dict[str, object] = {
        "active": True,
        "decision_id": decision_id,
        "order_id": broker_order.get("order_id"),
        "account_id": live_context.get("account_id"),
        "symbol": payload.get("symbol"),
        "side": payload.get("side"),
        "market_venue": market_venue,
        "broker_provider": broker_provider,
        "status": broker_order.get("status"),
        "requested_notional_usd": _to_float(broker_order.get("requested_notional_usd"), _to_float(live_context.get("notional_usd"), 0.0)),
        "filled_notional_usd": _to_float(broker_order.get("filled_notional_usd"), 0.0),
        "remaining_notional_usd": _remaining_notional_usd(broker_order),
        "desk_profile": desk_profile,
        "history": [],
        "latest_snapshot": latest_snapshot,
        "latest_v4": {},
        "updated_at": _now_iso(),
    }
    _update_active_execution_order(decision_id, state)
    _persist_execution_optimizer_event(state, event_type="loop_started", action="monitor")

    current_order = dict(broker_order)
    previous_candidate = selected_candidate
    last_cycle_started = time.perf_counter()
    max_cycles = max(1, int(_to_float(desk_profile.get("max_lifecycle_cycles"), 6.0)))
    loop_interval_seconds = max(0.25, _to_float(desk_profile.get("loop_interval_ms"), 900.0) / 1000.0)

    try:
        for cycle in range(1, max_cycles + 1):
            await asyncio.sleep(loop_interval_seconds)
            current_order = await _query_live_order_status(live_context, payload, current_order)
            state["status"] = current_order.get("status")
            state["filled_notional_usd"] = _to_float(current_order.get("filled_notional_usd"), _to_float(state.get("filled_notional_usd"), 0.0))
            state["remaining_notional_usd"] = _remaining_notional_usd(current_order)
            if not _live_order_open(current_order.get("status")) or _to_float(state.get("remaining_notional_usd"), 0.0) <= 1.0:
                _persist_execution_optimizer_event(state, event_type="order_closed", cycle_index=cycle, action="closed")
                _finalize_active_execution_order(decision_id, state)
                return

            current_candidate = await _candidate_for_market_venue(str(payload.get("symbol") or ""), market_venue, _resolve_infra_context(payload))
            loop_elapsed_ms = max(1.0, (time.perf_counter() - last_cycle_started) * 1000.0)
            last_cycle_started = time.perf_counter()
            queue_tracker = update_queue_tracker(queue_tracker, previous_candidate, current_candidate, side, loop_elapsed_ms)
            latest_snapshot = _enrich_execution_optimizer_snapshot(
                current_candidate,
                build_execution_optimizer_snapshot(
                    current_candidate,
                    side,
                    _to_float(state.get("remaining_notional_usd"), 0.0),
                    str(route_preferences.get("execution_style") or "default"),
                    str(current_order.get("order_type") or live_context.get("order_type") or "LIMIT"),
                    _to_float(current_order.get("limit_price"), _to_float(live_context.get("price"), 0.0)),
                    desk_profile=desk_profile,
                ),
                side,
                _to_float(state.get("remaining_notional_usd"), 0.0),
            )
            market_structure = latest_snapshot.get("market_structure") if isinstance(latest_snapshot.get("market_structure"), dict) else {}
            execution_context = latest_snapshot.get("execution_context") if isinstance(latest_snapshot.get("execution_context"), dict) else {}
            spoof_signal = detect_spoof_signal(previous_candidate, current_candidate, side, desk_profile, loop_elapsed_ms)
            live_fill = compute_live_fill_score(queue_tracker, current_candidate, desk_profile, execution_context)
            liquidity_signal = detect_liquidity_trap(current_candidate, live_fill, desk_profile)
            live_signal = apply_execution_context_to_fill_snapshot({**live_fill, **liquidity_signal}, execution_context, market_structure)
            v4_guard = adaptive_slippage_guard(current_candidate, desk_profile, _to_float(live_signal.get("fill_score"), 0.0), spoof_signal, liquidity_signal, execution_context)
            lifecycle = decide_order_lifecycle(
                current_candidate,
                queue_tracker,
                live_signal,
                spoof_signal,
                v4_guard,
                {
                    "side": payload.get("side"),
                    "status": current_order.get("status"),
                    "order_type": current_order.get("order_type") or live_context.get("order_type") or "LIMIT",
                    "price": current_order.get("limit_price") or current_order.get("avg_fill_price") or live_context.get("price"),
                },
                desk_profile,
            )
            previous_candidate = current_candidate
            state["latest_snapshot"] = latest_snapshot
            state["latest_v4"] = {
                "queue_tracker": queue_tracker,
                "fill": live_signal,
                "spoof": spoof_signal,
                "guard": v4_guard,
                "market_structure": market_structure,
                "context": execution_context,
                "candidate_metrics": {
                    "latency_ms": _to_float(current_candidate.get("latency_ms"), 0.0),
                    "freshness_ms": _to_float(current_candidate.get("freshness_ms"), 0.0),
                    "spread_bps": _to_float(current_candidate.get("spread_bps"), 0.0),
                    "available_depth_usd": _to_float(current_candidate.get("available_depth_usd"), 0.0),
                    "depth_imbalance": _to_float(current_candidate.get("depth_imbalance"), 0.0),
                    "volume_imbalance": _to_float(current_candidate.get("volume_imbalance"), 0.0),
                    "best_bid": _to_float(current_candidate.get("best_bid"), 0.0),
                    "best_ask": _to_float(current_candidate.get("best_ask"), 0.0),
                    "queue_rank_estimate": _to_float(live_signal.get("queue_rank_estimate"), 0.0),
                    "aggressiveness": _to_float(live_signal.get("aggressiveness"), 0.0),
                    "dominance_score": _to_float(live_signal.get("dominance_score"), 0.0),
                    "adverse_selection_score": _to_float(live_signal.get("adverse_selection_score"), 0.0),
                    "liquidity_decay_rate": _to_float(live_signal.get("liquidity_decay_rate"), 0.0),
                    "context_confidence": _to_float(execution_context.get("confidence"), 0.0),
                },
                "lifecycle": lifecycle,
            }
            state["updated_at"] = _now_iso()
            history = state.get("history") if isinstance(state.get("history"), list) else []
            history.insert(
                0,
                {
                    "cycle": cycle,
                    "at": state["updated_at"],
                    "latency_ms": _to_float(current_candidate.get("latency_ms"), 0.0),
                    "freshness_ms": _to_float(current_candidate.get("freshness_ms"), 0.0),
                    "spread_bps": _to_float(current_candidate.get("spread_bps"), 0.0),
                    "available_depth_usd": _to_float(current_candidate.get("available_depth_usd"), 0.0),
                    "fill_score": live_signal.get("fill_score"),
                    "confidence": live_signal.get("confidence"),
                    "entry_boost": live_signal.get("entry_boost"),
                    "predicted_fill_probability": live_signal.get("effective_fill_probability"),
                    "queue_position_usd": queue_tracker.get("queue_position_usd"),
                    "queue_rank_estimate": live_signal.get("queue_rank_estimate"),
                    "time_in_queue_ms": live_signal.get("time_in_queue_ms"),
                    "time_to_fill_estimate_ms": live_signal.get("time_to_fill_estimate_ms"),
                    "aggressiveness": live_signal.get("aggressiveness"),
                    "dominance_score": live_signal.get("dominance_score"),
                    "adverse_selection_score": live_signal.get("adverse_selection_score"),
                    "liquidity_decay_rate": live_signal.get("liquidity_decay_rate"),
                    "market_bias": execution_context.get("bias"),
                    "volatility_regime": execution_context.get("volatility_regime"),
                    "liquidity_state": execution_context.get("liquidity_state"),
                    "zone": execution_context.get("zone"),
                    "context_confidence": execution_context.get("confidence"),
                    "context_no_trade": execution_context.get("no_trade"),
                    "guard_reasons": v4_guard.get("reasons"),
                    "spoof_detected": spoof_signal.get("spoof_detected"),
                    "liquidity_trap_detected": live_signal.get("liquidity_trap_detected"),
                    "action": lifecycle.get("action"),
                    "reason": lifecycle.get("reason"),
                },
            )
            del history[12:]
            state["history"] = history
            _update_active_execution_order(decision_id, state)
            _persist_execution_optimizer_event(state, event_type="cycle_evaluation", cycle_index=cycle)

            action = str(lifecycle.get("action") or "keep")
            if action == "keep":
                continue

            target_price = _to_float(lifecycle.get("target_price"), 0.0)
            if action == "replace" and target_price > 0 and _provider_supports_native_amend(str(live_context.get("provider") or ""), current_order, lifecycle):
                amended_order = await _amend_live_order(live_context, payload, current_order, target_price=target_price)
                current_order = amended_order
                state["order_id"] = current_order.get("order_id")
                state["status"] = current_order.get("status")
                state["filled_notional_usd"] = _to_float(current_order.get("filled_notional_usd"), _to_float(state.get("filled_notional_usd"), 0.0))
                state["remaining_notional_usd"] = _remaining_notional_usd(current_order)
                state["latest_v4"] = {
                    **(state.get("latest_v4") if isinstance(state.get("latest_v4"), dict) else {}),
                    "lifecycle": {**lifecycle, "action": "amend", "reason": "native_limit_amend"},
                }
                state["updated_at"] = _now_iso()
                _update_active_execution_order(decision_id, state)
                _persist_execution_optimizer_event(state, event_type="order_amend", cycle_index=cycle, action="amend", reason="native_limit_amend")
                if not _live_order_open(current_order.get("status")):
                    _finalize_active_execution_order(decision_id, state)
                    return
                continue

            current_order = await _cancel_live_order(live_context, payload, current_order)
            if action == "cancel":
                state["status"] = current_order.get("status") or "cancelled"
                _persist_execution_optimizer_event(state, event_type="order_cancelled", cycle_index=cycle, action="cancel")
                _finalize_active_execution_order(decision_id, state)
                return

            next_live_context = dict(live_context)
            notional_scale = _clamp(_to_float(lifecycle.get("target_notional_scale"), _to_float(live_signal.get("context_size_multiplier"), 1.0)), 0.2, 1.0)
            next_live_context["notional_usd"] = _to_float(state.get("remaining_notional_usd"), 0.0) * notional_scale
            next_live_context["client_order_id"] = f"txt-{decision_id[:18]}-v4-{cycle}"[:40]
            target_order_type = str(lifecycle.get("target_order_type") or "LIMIT").strip().upper() or "LIMIT"
            next_live_context["order_type"] = target_order_type
            if target_order_type == "LIMIT" and target_price > 0:
                next_live_context["price"] = target_price
            else:
                next_live_context.pop("price", None)

            replacement = await _execute_live_order(payload, next_live_context, f"{decision_id}-v4-{cycle}")
            current_order = replacement
            live_context = next_live_context
            state["order_id"] = current_order.get("order_id")
            state["status"] = current_order.get("status")
            state["filled_notional_usd"] = _to_float(current_order.get("filled_notional_usd"), _to_float(state.get("filled_notional_usd"), 0.0))
            state["remaining_notional_usd"] = _remaining_notional_usd(current_order)
            state["updated_at"] = _now_iso()
            _update_active_execution_order(decision_id, state)
            _persist_execution_optimizer_event(state, event_type="order_cancel_replace", cycle_index=cycle, action=action)
            if not _live_order_open(current_order.get("status")):
                _finalize_active_execution_order(decision_id, state)
                return
    except Exception as exc:
        state["status"] = "lifecycle_error"
        state["updated_at"] = _now_iso()
        state["error"] = str(exc)[:400]
        _persist_execution_optimizer_event(state, event_type="loop_error", reason=str(exc)[:200])
        _finalize_active_execution_order(decision_id, state)
        return

    state["status"] = current_order.get("status") or "timeout"
    _persist_execution_optimizer_event(state, event_type="loop_timeout", action="timeout")
    _finalize_active_execution_order(decision_id, state)


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
            preferred_venue = _normalize_market_venue_name(value)
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


def _annotate_multi_venue_dominance(candidates: list[dict[str, object]]) -> list[dict[str, object]]:
    if not candidates:
        return candidates

    latency_baseline_ms = _median_value([_to_float(candidate.get("latency_ms"), math.nan) for candidate in candidates], 45.0)
    depth_baseline_usd = _median_value([_to_float(candidate.get("available_depth_usd"), math.nan) for candidate in candidates], 5000.0)
    fill_baseline = _median_value([_to_float(candidate.get("fill_probability"), math.nan) for candidate in candidates], 0.5)
    legacy_score_baseline = _median_value([_to_float(candidate.get("score"), math.nan) for candidate in candidates], 0.25)

    for candidate in candidates:
        available_depth_usd = max(0.0, _to_float(candidate.get("available_depth_usd"), 0.0))
        fill_probability = _clamp(_to_float(candidate.get("fill_probability"), 0.0), 0.0, 1.0)
        queue_position = _clamp(_to_float(candidate.get("queue_priority_risk"), 0.5), 0.0, 1.0)
        spread_bps = max(0.0, _to_float(candidate.get("spread_bps"), 0.0))
        latency_ms = max(1.0, _to_float(candidate.get("latency_ms"), latency_baseline_ms))
        depth_confidence = _clamp(_to_float(candidate.get("depth_confidence"), 0.0), 0.0, 1.0)
        partial_fill_risk = _clamp(_to_float(candidate.get("partial_fill_risk"), 0.0), 0.0, 1.0)
        legacy_score = _clamp(_to_float(candidate.get("score"), 0.0), 0.0, 1.0)

        depth_score = _clamp(math.log10(max(50.0, available_depth_usd)) / 5.2, 0.0, 1.0)
        depth_pressure = available_depth_usd / max(depth_baseline_usd, 1.0)
        depth_edge_score = _clamp(0.5 + (depth_pressure - 1.0) * 0.35, 0.0, 1.0)
        queue_execution_score = _clamp((1.0 - queue_position) * 0.5 + fill_probability * 0.5, 0.0, 1.0)
        latency_penalty = _clamp(latency_ms / max(120.0, latency_baseline_ms * 2.5), 0.0, 1.0)
        latency_edge_ms = latency_baseline_ms - latency_ms
        latency_edge_score = _clamp(0.5 + latency_edge_ms / max(60.0, latency_baseline_ms * 1.5), 0.0, 1.0)
        slippage_cost_bps = (
            spread_bps * (0.58 + queue_position * 0.42)
            + partial_fill_risk * 2.5
            + latency_penalty * 1.6
            + (1.0 - depth_confidence) * 1.4
        )
        slippage_score = _clamp(1.0 - min(slippage_cost_bps, 14.0) / 14.0, 0.0, 1.0)
        fill_edge = fill_probability - fill_baseline
        fill_edge_score = _clamp(0.5 + fill_edge / 0.4, 0.0, 1.0)
        dominance_score = _clamp(
            fill_probability * 0.28
            + depth_score * 0.18
            + depth_edge_score * 0.12
            + queue_execution_score * 0.18
            + latency_edge_score * 0.14
            + slippage_score * 0.1
            + fill_edge_score * 0.08,
            0.0,
            1.0,
        )
        smart_router_score = _clamp(
            dominance_score * 0.72
            + _clamp((legacy_score + legacy_score_baseline) / 2.0, 0.0, 1.0) * 0.28,
            0.0,
            1.0,
        )
        candidate["legacy_score"] = legacy_score
        candidate["depth_score"] = depth_score
        candidate["depth_edge_score"] = depth_edge_score
        candidate["queue_position"] = queue_position
        candidate["queue_execution_score"] = queue_execution_score
        candidate["latency_penalty"] = latency_penalty
        candidate["latency_baseline_ms"] = latency_baseline_ms
        candidate["latency_edge_ms"] = latency_edge_ms
        candidate["latency_edge_score"] = latency_edge_score
        candidate["slippage_cost_bps"] = slippage_cost_bps
        candidate["slippage_score"] = slippage_score
        candidate["fill_edge"] = fill_edge
        candidate["dominance_score"] = dominance_score
        candidate["smart_router_score"] = smart_router_score
        candidate["score"] = smart_router_score
        candidate["source"] = "v5-multi-venue-dominance"

    return candidates


def _build_multi_venue_split_plan(
    candidates: list[dict[str, object]],
    side: str,
    requested_notional_usd: float,
    *,
    max_slices: int = 3,
) -> dict[str, object]:
    target_notional_usd = _normalize_requested_notional_usd(requested_notional_usd)
    if not candidates:
        return {
            "mode": "singleVenue",
            "slices": [],
            "total_notional_usd": 0.0,
            "remaining_notional_usd": target_notional_usd,
            "coverage_ratio": 0.0,
            "estimated_average_price": 0.0,
            "estimated_slippage_bps": 0.0,
            "primary_venue": None,
            "venue_count": 0,
        }

    eligible: list[dict[str, object]] = []
    for candidate in candidates[: max(2, max_slices + 1)]:
        dominance_score = _clamp(_to_float(candidate.get("dominance_score"), _to_float(candidate.get("score"), 0.0)), 0.0, 1.0)
        fill_probability = _clamp(_to_float(candidate.get("fill_probability"), 0.0), 0.0, 1.0)
        queue_position = _clamp(_to_float(candidate.get("queue_position"), _to_float(candidate.get("queue_priority_risk"), 0.5)), 0.0, 1.0)
        available_depth_usd = max(0.0, _to_float(candidate.get("available_depth_usd"), 0.0))
        depth_confidence = _clamp(_to_float(candidate.get("depth_confidence"), 0.0), 0.0, 1.0)
        capacity_usd = available_depth_usd * _clamp(fill_probability * 0.95 + depth_confidence * 0.35 - queue_position * 0.2, 0.18, 0.92)
        if dominance_score < 0.18 or fill_probability < 0.22 or capacity_usd < 25.0:
            continue
        eligible.append(
            {
                "candidate": candidate,
                "capacity_usd": capacity_usd,
                "weight": max(1e-6, dominance_score * (0.85 + _to_float(candidate.get("depth_score"), 0.0) * 0.15)),
            }
        )

    if not eligible:
        leader = candidates[0]
        return {
            "mode": "singleVenue",
            "slices": [
                {
                    "venue": str(leader.get("venue") or "unknown"),
                    "notional_usd": round(target_notional_usd, 6),
                    "share_pct": 1.0,
                    "expected_latency_ms": round(_to_float(leader.get("latency_ms"), 0.0), 3),
                    "fill_probability": round(_to_float(leader.get("fill_probability"), 0.0), 6),
                    "route_score": round(_to_float(leader.get("dominance_score"), _to_float(leader.get("score"), 0.0)), 6),
                    "queue_position": round(_to_float(leader.get("queue_position"), _to_float(leader.get("queue_priority_risk"), 0.0)), 6),
                    "slippage_cost_bps": round(_to_float(leader.get("slippage_cost_bps"), 0.0), 6),
                }
            ],
            "total_notional_usd": round(target_notional_usd, 6),
            "remaining_notional_usd": 0.0,
            "coverage_ratio": 1.0,
            "estimated_average_price": round(_to_float(leader.get("best_ask" if side == "buy" else "best_bid"), _to_float(leader.get("last"), 0.0)), 8),
            "estimated_slippage_bps": round(_to_float(leader.get("slippage_cost_bps"), 0.0), 6),
            "primary_venue": str(leader.get("venue") or "unknown"),
            "venue_count": 1,
        }

    eligible = sorted(eligible, key=lambda item: item["weight"], reverse=True)[:max_slices]
    total_weight = sum(_to_float(item.get("weight"), 0.0) for item in eligible)
    remaining_notional_usd = target_notional_usd
    allocations: list[dict[str, object]] = []

    for item in eligible:
        candidate = item["candidate"]
        capacity_usd = max(0.0, _to_float(item.get("capacity_usd"), 0.0))
        proportional_notional = target_notional_usd * (_to_float(item.get("weight"), 0.0) / max(total_weight, 1e-9))
        allocated_notional = min(capacity_usd, proportional_notional)
        allocations.append({"candidate": candidate, "allocated_notional": allocated_notional, "capacity_usd": capacity_usd})
        remaining_notional_usd -= allocated_notional

    if remaining_notional_usd > 25.0:
        for item in allocations:
            if remaining_notional_usd <= 1e-9:
                break
            spare_capacity = max(0.0, _to_float(item.get("capacity_usd"), 0.0) - _to_float(item.get("allocated_notional"), 0.0))
            if spare_capacity <= 0:
                continue
            top_up = min(spare_capacity, remaining_notional_usd)
            item["allocated_notional"] = _to_float(item.get("allocated_notional"), 0.0) + top_up
            remaining_notional_usd -= top_up

    slices: list[dict[str, object]] = []
    for item in allocations:
        allocated_notional = max(0.0, _to_float(item.get("allocated_notional"), 0.0))
        if allocated_notional < 25.0:
            continue
        candidate = item["candidate"]
        slices.append(
            {
                "venue": str(candidate.get("venue") or "unknown"),
                "notional_usd": round(allocated_notional, 6),
                "share_pct": round(allocated_notional / max(target_notional_usd, 1e-9), 6),
                "expected_latency_ms": round(_to_float(candidate.get("latency_ms"), 0.0), 3),
                "fill_probability": round(_to_float(candidate.get("fill_probability"), 0.0), 6),
                "route_score": round(_to_float(candidate.get("dominance_score"), _to_float(candidate.get("score"), 0.0)), 6),
                "queue_position": round(_to_float(candidate.get("queue_position"), _to_float(candidate.get("queue_priority_risk"), 0.0)), 6),
                "slippage_cost_bps": round(_to_float(candidate.get("slippage_cost_bps"), 0.0), 6),
            }
        )

    slices.sort(key=lambda item: _to_float(item.get("notional_usd"), 0.0), reverse=True)
    total_notional_usd = sum(_to_float(item.get("notional_usd"), 0.0) for item in slices)
    reference_price = min(
        (
            _to_float(candidate.get("best_ask"), 0.0)
            for candidate in candidates
            if side == "buy" and _to_float(candidate.get("best_ask"), 0.0) > 0
        ),
        default=0.0,
    ) if side == "buy" else max((_to_float(candidate.get("best_bid"), 0.0) for candidate in candidates), default=0.0)
    weighted_price = 0.0
    weighted_slippage = 0.0
    for slice_item in slices:
        venue = str(slice_item.get("venue") or "unknown")
        candidate = next((entry for entry in candidates if str(entry.get("venue") or "") == venue), None)
        if candidate is None:
            continue
        route_price = _to_float(candidate.get("best_ask" if side == "buy" else "best_bid"), _to_float(candidate.get("last"), 0.0))
        slice_notional = _to_float(slice_item.get("notional_usd"), 0.0)
        weighted_price += route_price * slice_notional
        weighted_slippage += _to_float(slice_item.get("slippage_cost_bps"), 0.0) * slice_notional

    estimated_average_price = weighted_price / max(total_notional_usd, 1e-9)
    estimated_slippage_bps = weighted_slippage / max(total_notional_usd, 1e-9)
    if reference_price > 0 and estimated_average_price > 0:
        estimated_slippage_bps = max(
            estimated_slippage_bps,
            abs(estimated_average_price - reference_price) / max(reference_price, 1e-9) * 10000.0,
        )

    return {
        "mode": "multiVenueSplit" if len(slices) >= 2 else "singleVenue",
        "slices": slices,
        "total_notional_usd": round(total_notional_usd, 6),
        "remaining_notional_usd": round(max(0.0, target_notional_usd - total_notional_usd), 6),
        "coverage_ratio": round(_clamp(total_notional_usd / max(target_notional_usd, 1e-9), 0.0, 1.0), 6),
        "estimated_average_price": round(estimated_average_price, 8),
        "estimated_slippage_bps": round(estimated_slippage_bps, 6),
        "primary_venue": slices[0]["venue"] if slices else None,
        "venue_count": len(slices),
    }


def _build_arb_execution_plan(opportunity: dict[str, object], requested_notional_usd: float) -> dict[str, object] | None:
    buy_price = _to_float(opportunity.get("buy_price"), 0.0)
    sell_price = _to_float(opportunity.get("sell_price"), 0.0)
    if buy_price <= 0 or sell_price <= 0:
        return None

    total_notional_usd = min(
        _normalize_requested_notional_usd(requested_notional_usd),
        max(25.0, _to_float(opportunity.get("max_executable_usd"), 0.0)),
    )
    if total_notional_usd <= 0:
        return None

    slice_count = max(1, min(3, int(math.ceil(total_notional_usd / 2500.0))))
    slice_weights = [0.52, 0.3, 0.18][:slice_count]
    weight_total = sum(slice_weights) or 1.0
    latency_gap_ms = max(0.0, _to_float(opportunity.get("latency_gap_ms"), 0.0))
    gross_spread = _to_float(opportunity.get("gross_spread"), 0.0)
    gross_spread_bps = _to_float(opportunity.get("gross_spread_bps"), 0.0)
    net_spread_bps = _to_float(opportunity.get("net_spread_bps"), 0.0)
    fill_probability = _clamp(_to_float(opportunity.get("fill_probability"), 0.0), 0.0, 1.0)
    route_score = _clamp(_to_float(opportunity.get("opportunity_score"), 0.0) / 100.0, 0.0, 1.0)
    slices: list[dict[str, object]] = []
    weighted_buy_price = 0.0
    weighted_sell_price = 0.0

    for index, weight in enumerate(slice_weights):
        slice_notional_usd = total_notional_usd * (weight / weight_total)
        weighted_buy_price += buy_price * slice_notional_usd
        weighted_sell_price += sell_price * slice_notional_usd
        slices.append(
            {
                "id": f"slice-{index + 1}",
                "notionalUsd": round(slice_notional_usd, 6),
                "quantity": round(slice_notional_usd / max(buy_price, 1e-9), 8),
                "grossSpread": round(gross_spread, 8),
                "grossSpreadBps": round(gross_spread_bps, 6),
                "netSpreadBps": round(net_spread_bps, 6),
                "latencyGapMs": round(latency_gap_ms * (1.0 + index * 0.08), 6),
                "buy": {
                    "venue": str(opportunity.get("buy") or opportunity.get("buy_venue") or ""),
                    "price": round(buy_price, 8),
                    "size": round(slice_notional_usd / max(buy_price, 1e-9), 8),
                    "notionalUsd": round(slice_notional_usd, 6),
                    "latencyMs": round(_to_float(opportunity.get("buy_latency_ms"), 0.0), 6),
                    "feeBps": round(_to_float(opportunity.get("buy_fee_bps"), 0.0), 6),
                    "fillProbability": round(fill_probability, 6),
                    "routeScore": round(route_score, 6),
                    "levelIndex": index,
                },
                "sell": {
                    "venue": str(opportunity.get("sell") or opportunity.get("sell_venue") or ""),
                    "price": round(sell_price, 8),
                    "size": round(slice_notional_usd / max(sell_price, 1e-9), 8),
                    "notionalUsd": round(slice_notional_usd, 6),
                    "latencyMs": round(_to_float(opportunity.get("sell_latency_ms"), 0.0), 6),
                    "feeBps": round(_to_float(opportunity.get("sell_fee_bps"), 0.0), 6),
                    "fillProbability": round(fill_probability, 6),
                    "routeScore": round(route_score, 6),
                    "levelIndex": index,
                },
            }
        )

    return {
        "slices": slices,
        "totalNotionalUsd": round(total_notional_usd, 6),
        "weightedBuyPrice": round(weighted_buy_price / max(total_notional_usd, 1e-9), 8),
        "weightedSellPrice": round(weighted_sell_price / max(total_notional_usd, 1e-9), 8),
        "weightedGrossSpreadBps": round(gross_spread_bps, 6),
        "weightedNetSpreadBps": round(net_spread_bps, 6),
        "weightedLatencyGapMs": round(latency_gap_ms, 6),
    }


def _detect_cross_exchange_arbitrage(
    candidates: list[dict[str, object]],
    requested_notional_usd: float,
) -> dict[str, object]:
    opportunities: list[dict[str, object]] = []
    for buy_candidate in candidates:
        buy_venue = str(buy_candidate.get("venue") or "")
        buy_price = _to_float(buy_candidate.get("best_ask"), 0.0)
        if buy_price <= 0:
            continue
        buy_depth_usd = max(0.0, _to_float(buy_candidate.get("available_depth_usd"), 0.0))
        buy_fill_probability = _clamp(_to_float(buy_candidate.get("fill_probability"), 0.0), 0.0, 1.0)
        buy_queue_position = _clamp(_to_float(buy_candidate.get("queue_position"), _to_float(buy_candidate.get("queue_priority_risk"), 0.5)), 0.0, 1.0)
        for sell_candidate in candidates:
            sell_venue = str(sell_candidate.get("venue") or "")
            if not sell_venue or sell_venue == buy_venue:
                continue
            sell_price = _to_float(sell_candidate.get("best_bid"), 0.0)
            if sell_price <= 0 or sell_price <= buy_price:
                continue
            sell_depth_usd = max(0.0, _to_float(sell_candidate.get("available_depth_usd"), 0.0))
            sell_fill_probability = _clamp(_to_float(sell_candidate.get("fill_probability"), 0.0), 0.0, 1.0)
            sell_queue_position = _clamp(_to_float(sell_candidate.get("queue_position"), _to_float(sell_candidate.get("queue_priority_risk"), 0.5)), 0.0, 1.0)
            midpoint = max((buy_price + sell_price) / 2.0, 1e-9)
            gross_spread = sell_price - buy_price
            gross_spread_bps = gross_spread / midpoint * 10000.0
            latency_gap_ms = abs(_to_float(buy_candidate.get("latency_ms"), 0.0) - _to_float(sell_candidate.get("latency_ms"), 0.0))
            latency_cost_bps = latency_gap_ms / 90.0
            queue_penalty_bps = (buy_queue_position + sell_queue_position) * 2.4
            fee_bps = _venue_fee_bps(buy_venue) + _venue_fee_bps(sell_venue)
            net_spread_bps = gross_spread_bps - fee_bps - latency_cost_bps - queue_penalty_bps
            net_spread_price = gross_spread - midpoint * ((fee_bps + latency_cost_bps + queue_penalty_bps) / 10000.0)
            max_executable_usd = min(buy_depth_usd, sell_depth_usd) * _clamp(
                (buy_fill_probability + sell_fill_probability) * 0.4 + 0.18,
                0.18,
                0.82,
            )
            execution_confidence = _clamp((buy_fill_probability + sell_fill_probability) * 0.5, 0.0, 1.0)
            latency_score = _clamp(1.0 - latency_gap_ms / 450.0, 0.0, 1.0)
            depth_score = _clamp(math.log10(max(50.0, max_executable_usd)) / 5.2, 0.0, 1.0)
            opportunity_score = net_spread_bps * 0.78 + execution_confidence * 6.0 + depth_score * 4.0 + latency_score * 3.0
            opportunity = {
                "buy": buy_venue,
                "sell": sell_venue,
                "buy_venue": buy_venue,
                "sell_venue": sell_venue,
                "buyVenue": buy_venue,
                "sellVenue": sell_venue,
                "buy_price": round(buy_price, 8),
                "sell_price": round(sell_price, 8),
                "gross_spread": round(gross_spread, 8),
                "net_spread": round(net_spread_price, 8),
                "gross_spread_bps": round(gross_spread_bps, 6),
                "net_spread_bps": round(net_spread_bps, 6),
                "latency_gap_ms": round(latency_gap_ms, 6),
                "latency_cost_bps": round(latency_cost_bps, 6),
                "queue_penalty_bps": round(queue_penalty_bps, 6),
                "max_executable_usd": round(max_executable_usd, 6),
                "fill_probability": round(execution_confidence, 6),
                "buy_latency_ms": round(_to_float(buy_candidate.get("latency_ms"), 0.0), 6),
                "sell_latency_ms": round(_to_float(sell_candidate.get("latency_ms"), 0.0), 6),
                "buy_fee_bps": round(_venue_fee_bps(buy_venue), 6),
                "sell_fee_bps": round(_venue_fee_bps(sell_venue), 6),
                "opportunity_score": round(opportunity_score, 6),
                "executable": bool(net_spread_bps > 0 and max_executable_usd >= 25.0),
            }
            opportunity["execution_plan"] = _build_arb_execution_plan(opportunity, requested_notional_usd)
            opportunity["executionPlan"] = opportunity["execution_plan"]
            opportunities.append(opportunity)

    opportunities.sort(
        key=lambda item: (
            bool(item.get("executable")),
            _to_float(item.get("opportunity_score"), 0.0),
            _to_float(item.get("net_spread_bps"), 0.0),
        ),
        reverse=True,
    )
    best = opportunities[0] if opportunities else None
    if not isinstance(best, dict):
        return {
            "opportunity": False,
            "executable": False,
            "spread": 0.0,
            "net_spread": 0.0,
            "gross_spread_bps": 0.0,
            "net_spread_bps": 0.0,
            "buy": "",
            "sell": "",
            "buy_venue": "",
            "sell_venue": "",
            "buyVenue": None,
            "sellVenue": None,
            "latency_gap_ms": 0.0,
            "latency_cost_bps": 0.0,
            "queue_penalty_bps": 0.0,
            "max_executable_usd": 0.0,
            "opportunity_score": 0.0,
            "execution_plan": None,
            "executionPlan": None,
            "opportunities": [],
        }

    return {
        "opportunity": bool(best.get("executable")),
        "executable": bool(best.get("executable")),
        "spread": _to_float(best.get("gross_spread"), 0.0),
        "net_spread": _to_float(best.get("net_spread"), 0.0),
        "gross_spread_bps": _to_float(best.get("gross_spread_bps"), 0.0),
        "net_spread_bps": _to_float(best.get("net_spread_bps"), 0.0),
        "buy": str(best.get("buy") or ""),
        "sell": str(best.get("sell") or ""),
        "buy_venue": str(best.get("buy_venue") or ""),
        "sell_venue": str(best.get("sell_venue") or ""),
        "buyVenue": best.get("buyVenue"),
        "sellVenue": best.get("sellVenue"),
        "buy_price": _to_float(best.get("buy_price"), 0.0),
        "sell_price": _to_float(best.get("sell_price"), 0.0),
        "latency_gap_ms": _to_float(best.get("latency_gap_ms"), 0.0),
        "latency_cost_bps": _to_float(best.get("latency_cost_bps"), 0.0),
        "queue_penalty_bps": _to_float(best.get("queue_penalty_bps"), 0.0),
        "max_executable_usd": _to_float(best.get("max_executable_usd"), 0.0),
        "opportunity_score": _to_float(best.get("opportunity_score"), 0.0),
        "execution_plan": best.get("execution_plan"),
        "executionPlan": best.get("executionPlan"),
        "opportunities": opportunities[:5],
    }


def _build_hedge_recommendation(
    side: str,
    requested_notional_usd: float,
    selected: dict[str, object] | None,
    backup: dict[str, object] | None,
    split_plan: dict[str, object] | None,
    arbitrage: dict[str, object] | None,
) -> dict[str, object]:
    target_notional_usd = _normalize_requested_notional_usd(requested_notional_usd)
    if isinstance(arbitrage, dict) and bool(arbitrage.get("opportunity")):
        return {
            "enabled": True,
            "mode": "crossExchangeLock",
            "buy_venue": arbitrage.get("buy"),
            "sell_venue": arbitrage.get("sell"),
            "trigger_delta_usd": round(target_notional_usd * 0.08, 6),
            "hedge_notional_usd": round(min(target_notional_usd, _to_float(arbitrage.get("max_executable_usd"), target_notional_usd)), 6),
            "reasons": ["cross_exchange_arbitrage_positive", "delta_neutral_lock_recommended"],
        }

    slices = split_plan.get("slices") if isinstance(split_plan, dict) and isinstance(split_plan.get("slices"), list) else []
    primary_slice = slices[0] if slices else {}
    dominant_share = _to_float(primary_slice.get("share_pct"), 1.0 if selected else 0.0)
    backup_venue = str((backup or {}).get("venue") or "").strip()
    if backup_venue and target_notional_usd >= 250.0 and dominant_share >= 0.7:
        return {
            "enabled": True,
            "mode": "inventoryDeltaGuard",
            "venue": backup_venue,
            "side": "sell" if str(side).lower() == "buy" else "buy",
            "trigger_delta_usd": round(target_notional_usd * 0.2, 6),
            "hedge_notional_usd": round(target_notional_usd * min(0.35, max(0.12, dominant_share - 0.45)), 6),
            "reasons": ["venue_concentration_high", "backup_venue_ready_for_delta_hedge"],
        }

    return {
        "enabled": False,
        "mode": "standby",
        "trigger_delta_usd": round(target_notional_usd * 0.25, 6),
        "hedge_notional_usd": 0.0,
        "reasons": [],
    }


def _simulate_split_fills(
    decision_id: str,
    side: str,
    instrument: str,
    split_plan: dict[str, object],
    candidates_by_venue: dict[str, dict[str, object]],
    execution_delay_ms: int = 0,
) -> tuple[list[dict[str, object]], float]:
    slices = split_plan.get("slices") if isinstance(split_plan.get("slices"), list) else []
    all_fills: list[dict[str, object]] = []
    weighted_price = 0.0
    total_notional = 0.0

    for slice_index, slice_item in enumerate(slices):
        venue = str(slice_item.get("venue") or "")
        candidate = candidates_by_venue.get(venue)
        if candidate is None:
            continue
        slice_notional = max(0.0, _to_float(slice_item.get("notional_usd"), 0.0))
        if slice_notional <= 0.0:
            continue
        slice_fills, _ = _simulate_fills(
            decision_id=f"{decision_id}-mv-{slice_index + 1}",
            side=side,
            notional_usd=slice_notional,
            depth_payload=(candidate.get("depth_payload") or {}),
            venue=venue,
            instrument=instrument,
            execution_delay_ms=execution_delay_ms + slice_index * max(4, execution_delay_ms // 2),
        )
        for fill in slice_fills:
            fill_notional = _to_float(fill.get("notional_usd"), 0.0)
            fill_price = _to_float(fill.get("price"), 0.0)
            weighted_price += fill_price * fill_notional
            total_notional += fill_notional
            fill["decision_id"] = decision_id
            fill["fill_id"] = f"{decision_id}-mv-{len(all_fills) + 1}"
            all_fills.append(fill)

    avg_fill_price = weighted_price / max(total_notional, 1e-9)
    return all_fills, avg_fill_price


def _execution_ai_v6_bucket() -> dict[str, object]:
    return {
        "sample_count": 0,
        "wins": 0,
        "cumulative_reward": 0.0,
        "avg_reward": 0.0,
        "last_reward": 0.0,
        "last_updated_at": None,
    }


def _execution_ai_v6_market_regime(state: dict[str, object]) -> str:
    if bool(state.get("arbitrage_executable")):
        return "arb"
    if _to_float(state.get("slippage_cost_bps"), 0.0) >= 8.0 or _to_float(state.get("latency_ms"), 0.0) >= 95.0:
        return "stressed"
    if _to_float(state.get("queue_position"), 0.0) >= 0.72 or _to_float(state.get("liquidity_pressure"), 0.0) >= 0.88:
        return "fragile"
    if _to_float(state.get("dominance_score"), 0.0) >= 0.72 and _to_float(state.get("fill_probability"), 0.0) >= 0.7:
        return "dominant"
    return "balanced"


def _build_execution_ai_v6_state(
    side: str,
    requested_notional_usd: float,
    selected: dict[str, object] | None,
    backup: dict[str, object] | None,
    context: dict[str, object] | None,
    route_preferences: dict[str, object] | None = None,
) -> dict[str, object]:
    selected = selected if isinstance(selected, dict) else {}
    backup = backup if isinstance(backup, dict) else {}
    context = context if isinstance(context, dict) else {}
    route_preferences = route_preferences if isinstance(route_preferences, dict) else {}
    split_plan = context.get("split_plan") if isinstance(context.get("split_plan"), dict) else {}
    arbitrage = context.get("arbitrage") if isinstance(context.get("arbitrage"), dict) else {}
    hedge = context.get("hedge_recommendation") if isinstance(context.get("hedge_recommendation"), dict) else {}
    target_notional_usd = _normalize_requested_notional_usd(requested_notional_usd)
    available_depth_usd = max(25.0, _to_float(selected.get("available_depth_usd"), target_notional_usd))
    state = {
        "side": str(side or "buy").lower(),
        "notional_usd": round(target_notional_usd, 6),
        "venue": str(selected.get("venue") or "unknown"),
        "backup_venue": str(backup.get("venue") or ""),
        "fill_probability": round(_clamp(_to_float(selected.get("fill_probability"), 0.0), 0.0, 1.0), 6),
        "dominance_score": round(_clamp(_to_float(selected.get("dominance_score"), _to_float(selected.get("score"), 0.0)), 0.0, 1.0), 6),
        "route_score": round(_clamp(_to_float(selected.get("score"), 0.0), 0.0, 1.0), 6),
        "backup_score": round(_clamp(_to_float(backup.get("score"), 0.0), 0.0, 1.0), 6),
        "queue_position": round(_clamp(_to_float(selected.get("queue_position"), _to_float(selected.get("queue_priority_risk"), 0.0)), 0.0, 1.0), 6),
        "spread_bps": round(max(0.0, _to_float(selected.get("spread_bps"), 0.0)), 6),
        "slippage_cost_bps": round(max(0.0, _to_float(selected.get("slippage_cost_bps"), 0.0)), 6),
        "latency_ms": round(max(0.0, _to_float(selected.get("latency_ms"), 0.0)), 6),
        "flow_intensity": round(max(0.0, _to_float(selected.get("incoming_flow_usd_per_min"), 0.0)), 6),
        "available_depth_usd": round(available_depth_usd, 6),
        "liquidity_pressure": round(_clamp(target_notional_usd / max(available_depth_usd, 1e-9), 0.0, 2.0), 6),
        "depth_imbalance": round(_to_float(selected.get("depth_imbalance"), 0.0), 6),
        "volume_imbalance": round(_to_float(selected.get("volume_imbalance"), 0.0), 6),
        "split_mode": str(split_plan.get("mode") or "singleVenue"),
        "split_coverage": round(_clamp(_to_float(split_plan.get("coverage_ratio"), 0.0), 0.0, 1.0), 6),
        "split_venue_count": int(max(0, _to_float(split_plan.get("venue_count"), 0.0))),
        "arbitrage_executable": bool(arbitrage.get("executable") or arbitrage.get("opportunity")),
        "arb_net_spread_bps": round(_to_float(arbitrage.get("net_spread_bps"), 0.0), 6),
        "hedge_mode": str(hedge.get("mode") or "standby"),
        "execution_style": str(route_preferences.get("execution_style") or "default"),
    }
    state["market_regime"] = _execution_ai_v6_market_regime(state)
    return state


def _execution_ai_v6_context_key(state: dict[str, object]) -> str:
    queue_bucket = "late" if _to_float(state.get("queue_position"), 0.0) >= 0.66 else "mid" if _to_float(state.get("queue_position"), 0.0) >= 0.33 else "front"
    liquidity_bucket = "thin" if _to_float(state.get("liquidity_pressure"), 0.0) >= 0.8 else "normal"
    return "|".join(
        [
            str(state.get("market_regime") or "balanced"),
            str(state.get("split_mode") or "singleVenue"),
            queue_bucket,
            liquidity_bucket,
            str(state.get("venue") or "unknown"),
        ]
    )


def _execution_ai_v6_guardrails() -> dict[str, object]:
    return {
        "learning_frozen": bool(EXECUTION_AI_V6_STATE.get("learning_frozen")),
        "freeze_reasons": list(EXECUTION_AI_V6_STATE.get("freeze_reasons") or []),
        "reward_ema": round(_to_float(EXECUTION_AI_V6_STATE.get("reward_ema"), 0.0), 6),
        "reward_drawdown": round(_to_float(EXECUTION_AI_V6_STATE.get("reward_drawdown"), 0.0), 6),
        "reward_volatility": round(_to_float(EXECUTION_AI_V6_STATE.get("reward_volatility"), 0.0), 6),
        "negative_streak": int(_to_float(EXECUTION_AI_V6_STATE.get("negative_streak"), 0.0)),
        "loaded": bool(EXECUTION_AI_V6_STATE.get("loaded")),
        "loaded_at": EXECUTION_AI_V6_STATE.get("loaded_at"),
        "persistence_available": bool(EXECUTION_AI_V6_STATE.get("persistence_available", True)),
        "last_persist_error": EXECUTION_AI_V6_STATE.get("last_persist_error"),
        "updated_at": EXECUTION_AI_V6_STATE.get("updated_at"),
    }


def _execution_ai_v6_snapshot() -> dict[str, object]:
    actions = EXECUTION_AI_V6_STATE.get("actions") if isinstance(EXECUTION_AI_V6_STATE.get("actions"), dict) else {}
    action_rows = []
    for action, payload in actions.items():
        if not isinstance(payload, dict):
            continue
        action_rows.append(
            {
                "action": str(action),
                "sample_count": int(_to_float(payload.get("sample_count"), 0.0)),
                "avg_reward": round(_to_float(payload.get("avg_reward"), 0.0), 6),
                "win_rate": round(_to_float(payload.get("wins"), 0.0) / max(1, int(_to_float(payload.get("sample_count"), 0.0))), 6),
            }
        )
    action_rows.sort(key=lambda item: (item["avg_reward"], item["sample_count"]), reverse=True)
    return {
        "guardrails": _execution_ai_v6_guardrails(),
        "top_actions": action_rows[:5],
        "recent_episodes": list(EXECUTION_AI_V6_STATE.get("episodes") or [])[:8],
        "context_count": len(EXECUTION_AI_V6_STATE.get("contexts") or {}),
        "updated_at": EXECUTION_AI_V6_STATE.get("updated_at"),
    }


def _execution_ai_v6_preferred_action(state: dict[str, object]) -> tuple[str | None, float, int]:
    contexts = EXECUTION_AI_V6_STATE.get("contexts") if isinstance(EXECUTION_AI_V6_STATE.get("contexts"), dict) else {}
    context_bucket = contexts.get(_execution_ai_v6_context_key(state)) if isinstance(contexts.get(_execution_ai_v6_context_key(state)), dict) else {}
    action_buckets = context_bucket.get("actions") if isinstance(context_bucket.get("actions"), dict) else {}
    best_action = None
    best_reward = -1e9
    best_count = 0
    for action, payload in action_buckets.items():
        if not isinstance(payload, dict):
            continue
        avg_reward = _to_float(payload.get("avg_reward"), 0.0)
        sample_count = int(_to_float(payload.get("sample_count"), 0.0))
        if sample_count <= 0:
            continue
        if avg_reward > best_reward or (avg_reward == best_reward and sample_count > best_count):
            best_action = str(action)
            best_reward = avg_reward
            best_count = sample_count
    return best_action, best_reward if best_action else 0.0, best_count


def _execution_ai_v6_decide(state: dict[str, object]) -> dict[str, object]:
    scores = {
        "hold": 0.0,
        "join_best_limit": 0.0,
        "move_to_mid": 0.0,
        "cancel_replace": 0.0,
        "market_sweep": 0.0,
        "split_ioc": 0.0,
    }
    fill_probability = _to_float(state.get("fill_probability"), 0.0)
    dominance_score = _to_float(state.get("dominance_score"), 0.0)
    queue_position = _to_float(state.get("queue_position"), 0.0)
    slippage_cost_bps = _to_float(state.get("slippage_cost_bps"), 0.0)
    latency_ms = _to_float(state.get("latency_ms"), 0.0)
    liquidity_pressure = _to_float(state.get("liquidity_pressure"), 0.0)
    split_mode = str(state.get("split_mode") or "singleVenue")
    split_coverage = _to_float(state.get("split_coverage"), 0.0)
    split_venue_count = max(0, int(_to_float(state.get("split_venue_count"), 0.0)))
    arbitrage_executable = bool(state.get("arbitrage_executable"))
    arb_net_spread_bps = _to_float(state.get("arb_net_spread_bps"), 0.0)
    flow_intensity = _to_float(state.get("flow_intensity"), 0.0)

    scores["hold"] = (0.5 - fill_probability) * 2.6 + max(0.0, slippage_cost_bps - 6.0) * 0.2
    scores["join_best_limit"] = dominance_score * 3.1 + fill_probability * 2.2 - queue_position * 1.5 - liquidity_pressure * 0.8 - latency_ms / 220.0
    scores["move_to_mid"] = queue_position * 2.0 + (1.0 - fill_probability) * 1.2 + (1.0 if _to_float(state.get("spread_bps"), 0.0) <= 4.0 else -0.8)
    scores["cancel_replace"] = (1.6 if queue_position >= 0.7 else 0.0) + (1.0 if latency_ms >= 90.0 else 0.0) + (1.0 if slippage_cost_bps >= 8.0 else 0.0)
    scores["market_sweep"] = (2.4 if arbitrage_executable else 0.0) + arb_net_spread_bps * 0.08 + min(1.0, flow_intensity / 15000.0) - slippage_cost_bps * 0.18
    scores["split_ioc"] = (2.6 if split_mode == "multiVenueSplit" else -1.0) + split_coverage * 1.8 + min(1.2, split_venue_count * 0.28) + (0.8 if arbitrage_executable else 0.0)

    learned_action, learned_reward, learned_count = _execution_ai_v6_preferred_action(state)
    contexts = EXECUTION_AI_V6_STATE.get("contexts") if isinstance(EXECUTION_AI_V6_STATE.get("contexts"), dict) else {}
    context_bucket = contexts.get(_execution_ai_v6_context_key(state)) if isinstance(contexts.get(_execution_ai_v6_context_key(state)), dict) else {}
    action_buckets = context_bucket.get("actions") if isinstance(context_bucket.get("actions"), dict) else {}
    for action, payload in action_buckets.items():
        if not isinstance(payload, dict) or action not in scores:
            continue
        sample_count = int(_to_float(payload.get("sample_count"), 0.0))
        avg_reward = _to_float(payload.get("avg_reward"), 0.0)
        if sample_count <= 0:
            continue
        scores[str(action)] += _clamp(avg_reward / 6.0, -1.2, 1.2) * min(1.0, sample_count / 6.0)

    ranked = sorted(scores.items(), key=lambda item: item[1], reverse=True)
    best_action, best_score = ranked[0]
    second_score = ranked[1][1] if len(ranked) > 1 else ranked[0][1]
    reasons = [
        f"regime:{state.get('market_regime')}",
        f"queue:{queue_position:.2f}",
        f"fill:{fill_probability:.2f}",
        f"slip:{slippage_cost_bps:.2f}",
    ]
    if learned_action:
        reasons.append(f"memory:{learned_action}:{learned_reward:.2f}:{learned_count}")

    guardrails = _execution_ai_v6_guardrails()
    if bool(guardrails.get("learning_frozen")) and best_action in {"market_sweep", "split_ioc"} and not arbitrage_executable:
        best_action = "join_best_limit" if dominance_score >= 0.45 else "hold"
        reasons.append("guardrails_safe_downgrade")
        best_score = scores.get(best_action, best_score)

    confidence = _clamp(0.42 + max(0.0, best_score - second_score) * 0.18 + dominance_score * 0.15 + fill_probability * 0.12, 0.0, 0.99)
    should_execute = best_action != "hold" and (best_score > 0.15 or arbitrage_executable)
    return {
        "action": best_action,
        "should_execute": should_execute,
        "confidence": round(confidence, 6),
        "projected_reward": round(best_score, 6),
        "context_key": _execution_ai_v6_context_key(state),
        "learning_enabled": not bool(guardrails.get("learning_frozen")),
        "guardrails": guardrails,
        "ranked_actions": [{"action": action, "score": round(score, 6)} for action, score in ranked],
        "reasons": reasons,
        "learned_bias": {
            "action": learned_action,
            "avg_reward": round(learned_reward, 6),
            "sample_count": learned_count,
        },
    }


def _compute_execution_ai_v6_reward(
    state: dict[str, object],
    *,
    action: str,
    requested_notional_usd: float,
    filled_notional_usd: float,
    realized_slippage_bps: float,
    fill_latency_ms: float,
    adverse_selection_score: float = 0.0,
    edge_bps: float = 0.0,
) -> dict[str, object]:
    fill_ratio = _clamp(filled_notional_usd / max(requested_notional_usd, 1e-9), 0.0, 1.0)
    completion_bonus = fill_ratio * 14.0
    edge_bonus = _clamp(edge_bps, -12.0, 12.0) * 0.8
    split_bonus = 1.6 if action == "split_ioc" and str(state.get("split_mode") or "") == "multiVenueSplit" else 0.0
    slippage_penalty = max(0.0, realized_slippage_bps) * 0.95
    latency_penalty = max(0.0, fill_latency_ms) / 48.0
    toxicity_penalty = max(0.0, adverse_selection_score) * 6.0
    incompletion_penalty = max(0.0, 1.0 - fill_ratio) * 8.0
    reward = completion_bonus + edge_bonus + split_bonus - slippage_penalty - latency_penalty - toxicity_penalty - incompletion_penalty
    return {
        "reward": round(reward, 6),
        "fill_ratio": round(fill_ratio, 6),
        "completion_bonus": round(completion_bonus, 6),
        "edge_bonus": round(edge_bonus, 6),
        "split_bonus": round(split_bonus, 6),
        "slippage_penalty": round(slippage_penalty, 6),
        "latency_penalty": round(latency_penalty, 6),
        "toxicity_penalty": round(toxicity_penalty, 6),
        "incompletion_penalty": round(incompletion_penalty, 6),
    }


def _execution_ai_v6_recompute_guardrails() -> None:
    episodes = EXECUTION_AI_V6_STATE.get("episodes") if isinstance(EXECUTION_AI_V6_STATE.get("episodes"), list) else []
    recent_rewards = [_to_float(item.get("reward"), 0.0) for item in episodes[:12] if isinstance(item, dict)]
    reward_ema = _to_float(EXECUTION_AI_V6_STATE.get("reward_ema"), 0.0)
    reward_peak = _to_float(EXECUTION_AI_V6_STATE.get("reward_peak"), 0.0)
    negative_streak = int(_to_float(EXECUTION_AI_V6_STATE.get("negative_streak"), 0.0))
    reward_volatility = 0.0
    if recent_rewards:
        reward_volatility = math.sqrt(sum((reward - (sum(recent_rewards) / len(recent_rewards))) ** 2 for reward in recent_rewards) / len(recent_rewards))
    freeze_reasons: list[str] = []
    reward_drawdown = max(0.0, reward_peak - reward_ema)
    if len(recent_rewards) >= 5 and reward_ema <= -1.75:
        freeze_reasons.append("reward_ema_breach")
    if len(recent_rewards) >= 6 and reward_volatility >= 5.5:
        freeze_reasons.append("reward_volatility_unstable")
    if reward_drawdown >= 10.0:
        freeze_reasons.append("reward_drawdown_limit")
    if negative_streak >= 4:
        freeze_reasons.append("negative_streak_limit")
    EXECUTION_AI_V6_STATE.update(
        {
            "reward_drawdown": round(reward_drawdown, 6),
            "reward_volatility": round(reward_volatility, 6),
            "learning_frozen": bool(freeze_reasons),
            "freeze_reasons": freeze_reasons,
            "updated_at": _now_iso(),
        }
    )


def _execution_ai_v6_update_bucket(bucket: dict[str, object], reward: float) -> None:
    sample_count = int(_to_float(bucket.get("sample_count"), 0.0)) + 1
    wins = int(_to_float(bucket.get("wins"), 0.0)) + (1 if reward > 0 else 0)
    cumulative_reward = _to_float(bucket.get("cumulative_reward"), 0.0) + reward
    bucket.update(
        {
            "sample_count": sample_count,
            "wins": wins,
            "cumulative_reward": round(cumulative_reward, 6),
            "avg_reward": round(cumulative_reward / max(1, sample_count), 6),
            "last_reward": round(reward, 6),
            "last_updated_at": _now_iso(),
        }
    )


def _execution_ai_v6_learn(
    state: dict[str, object],
    decision: dict[str, object],
    *,
    decision_id: str | None = None,
    requested_notional_usd: float,
    filled_notional_usd: float,
    realized_slippage_bps: float,
    fill_latency_ms: float,
    adverse_selection_score: float = 0.0,
    edge_bps: float = 0.0,
    policy_context: dict[str, object] | None = None,
) -> dict[str, object]:
    policy = policy_context if isinstance(policy_context, dict) else {}
    policy_freeze_learning = bool(policy.get("freeze_learning"))
    policy_freeze_reasons = [str(reason) for reason in policy.get("freeze_learning_reasons", []) if str(reason)]
    reward_payload = _compute_execution_ai_v6_reward(
        state,
        action=str(decision.get("action") or "hold"),
        requested_notional_usd=requested_notional_usd,
        filled_notional_usd=filled_notional_usd,
        realized_slippage_bps=realized_slippage_bps,
        fill_latency_ms=fill_latency_ms,
        adverse_selection_score=adverse_selection_score,
        edge_bps=edge_bps,
    )
    reward = _to_float(reward_payload.get("reward"), 0.0)
    learning_was_frozen = bool(EXECUTION_AI_V6_STATE.get("learning_frozen")) or policy_freeze_learning
    episode = {
        "decision_id": decision_id,
        "timestamp": _now_iso(),
        "context_key": _execution_ai_v6_context_key(state),
        "state": state,
        "action": str(decision.get("action") or "hold"),
        "reward": round(reward, 6),
        "learning_applied": not learning_was_frozen,
        "policy_freeze_learning": policy_freeze_learning,
        "policy_freeze_reasons": policy_freeze_reasons,
        "reward_components": reward_payload,
    }
    episodes = EXECUTION_AI_V6_STATE.get("episodes") if isinstance(EXECUTION_AI_V6_STATE.get("episodes"), list) else []
    episodes.insert(0, episode)
    del episodes[240:]
    reward_ema = _to_float(EXECUTION_AI_V6_STATE.get("reward_ema"), 0.0)
    reward_ema = reward if not episodes[1:] else reward_ema * 0.82 + reward * 0.18
    reward_peak = max(_to_float(EXECUTION_AI_V6_STATE.get("reward_peak"), reward_ema), reward_ema)
    negative_streak = 0 if reward > 0 else int(_to_float(EXECUTION_AI_V6_STATE.get("negative_streak"), 0.0)) + 1
    EXECUTION_AI_V6_STATE.update(
        {
            "episodes": episodes,
            "reward_ema": round(reward_ema, 6),
            "reward_peak": round(reward_peak, 6),
            "negative_streak": negative_streak,
            "updated_at": _now_iso(),
        }
    )

    if not learning_was_frozen:
        actions = EXECUTION_AI_V6_STATE.get("actions") if isinstance(EXECUTION_AI_V6_STATE.get("actions"), dict) else {}
        action_key = str(decision.get("action") or "hold")
        action_bucket = actions.get(action_key)
        if not isinstance(action_bucket, dict):
            action_bucket = _execution_ai_v6_bucket()
            actions[action_key] = action_bucket
        _execution_ai_v6_update_bucket(action_bucket, reward)

        contexts = EXECUTION_AI_V6_STATE.get("contexts") if isinstance(EXECUTION_AI_V6_STATE.get("contexts"), dict) else {}
        context_key = _execution_ai_v6_context_key(state)
        context_bucket = contexts.get(context_key)
        if not isinstance(context_bucket, dict):
            context_bucket = {"actions": {}, "sample_count": 0, "last_updated_at": None}
            contexts[context_key] = context_bucket
        context_actions = context_bucket.get("actions") if isinstance(context_bucket.get("actions"), dict) else {}
        context_action_bucket = context_actions.get(action_key)
        if not isinstance(context_action_bucket, dict):
            context_action_bucket = _execution_ai_v6_bucket()
            context_actions[action_key] = context_action_bucket
        _execution_ai_v6_update_bucket(context_action_bucket, reward)
        context_bucket["actions"] = context_actions
        context_bucket["sample_count"] = int(_to_float(context_bucket.get("sample_count"), 0.0)) + 1
        context_bucket["last_updated_at"] = _now_iso()
        EXECUTION_AI_V6_STATE["actions"] = actions
        EXECUTION_AI_V6_STATE["contexts"] = contexts

    _persist_execution_ai_v6_episode(episode)
    EXECUTION_AI_V6_STATE["loaded"] = True
    EXECUTION_AI_V6_STATE["loaded_at"] = EXECUTION_AI_V6_STATE.get("loaded_at") or _now_iso()
    _execution_ai_v6_recompute_guardrails()
    return {
        "reward": round(reward, 6),
        "episode": episode,
        "guardrails": _execution_ai_v6_guardrails(),
        "learning_applied": not learning_was_frozen,
        "policy_freeze_learning": policy_freeze_learning,
        "policy_freeze_reasons": policy_freeze_reasons,
    }


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
    dominance_score = _clamp(_to_float(candidate.get("dominance_score"), _to_float(candidate.get("score"), 0.0)), 0.0, 1.0)
    queue_execution_score = _clamp(_to_float(candidate.get("queue_execution_score"), (queue_efficiency + fill_score) * 0.5), 0.0, 1.0)
    latency_edge_score = _clamp(_to_float(candidate.get("latency_edge_score"), latency_score), 0.0, 1.0)
    slippage_score = _clamp(_to_float(candidate.get("slippage_score"), spread_score), 0.0, 1.0)
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

    score = score * 0.72 + dominance_score * 0.18 + queue_execution_score * 0.06 + latency_edge_score * 0.04
    if execution_style == "aggressive_confirmed":
        score = score * 0.92 + slippage_score * 0.08

    if preferred_venue:
        if _venue_matches_preference(candidate.get("venue"), preferred_venue):
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


def _rank_route_candidates(
    candidates: list[dict[str, object]],
    side: str,
    preferences: dict[str, object],
) -> list[dict[str, object]]:
    best_bid = max((_to_float(candidate.get("best_bid"), 0.0) for candidate in candidates), default=0.0)
    asks = [_to_float(candidate.get("best_ask"), 0.0) for candidate in candidates if _to_float(candidate.get("best_ask"), 0.0) > 0]
    best_ask = min(asks) if asks else 0.0
    return sorted(
        candidates,
        key=lambda candidate: _route_selection_score(candidate, side, preferences, best_bid=best_bid, best_ask=best_ask),
        reverse=True,
    )


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
        selected = next((candidate for candidate in candidates if _venue_matches_preference(candidate.get("venue"), preferred_venue)), candidates[0])
        backup = next((candidate for candidate in candidates if candidate.get("venue") != selected.get("venue")), None)
        return selected, backup, "preferred_venue_primary_only", {
            "preferred_venue": preferred_venue,
            "route_mode_override": route_mode_override,
            "execution_style": execution_style,
            "ranked_venues": [str(candidate.get("venue") or "") for candidate in candidates[:5]],
        }

    if preferred_venue and execution_style == "default" and route_mode_override in {"", "bestSingleVenue"}:
        selected = next((candidate for candidate in candidates if _venue_matches_preference(candidate.get("venue"), preferred_venue)), candidates[0])
        backup = next((candidate for candidate in candidates if candidate.get("venue") != selected.get("venue")), None)
        return selected, backup, "preferred_venue_override", {
            "preferred_venue": preferred_venue,
            "route_mode_override": route_mode_override,
            "execution_style": execution_style,
            "ranked_venues": [str(candidate.get("venue") or "") for candidate in candidates[:5]],
        }

    ranked = _rank_route_candidates(candidates, side, preferences)
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
    selected_profile = VENUE_EXECUTION_PROFILES["default"]
    for key, profile in VENUE_EXECUTION_PROFILES.items():
        if key != "default" and normalized.startswith(key):
            selected_profile = profile
            break
    enriched = dict(selected_profile)
    latency_base_ms = _to_float(enriched.get("latency_base_ms"), 20.0)
    latency_jitter_ms = _to_float(enriched.get("latency_jitter_ms"), 8.0)
    partial_fill_bias = _to_float(enriched.get("partial_fill_bias"), 0.16)
    fee_bps = _to_float(VENUE_FEE_BPS.get(normalized.split("-")[0], VENUE_FEE_BPS.get("default", 5.0)), 5.0)
    enriched.setdefault("expected_slippage_bps", round(max(0.35, latency_jitter_ms * 0.08 + partial_fill_bias * 2.0), 3))
    enriched.setdefault("max_spread_bps", round(max(5.0, fee_bps + 2.0), 3))
    enriched.setdefault("max_latency_ms", round(latency_base_ms + latency_jitter_ms + 120.0, 3))
    enriched.setdefault("profile_source", "venue_execution_profile")
    return enriched


def _profile_execution_baseline(venue: str) -> dict[str, object]:
    profile = _venue_execution_profile(venue)
    latency_base_ms = _to_float(profile.get("latency_base_ms"), 20.0)
    latency_jitter_ms = _to_float(profile.get("latency_jitter_ms"), 8.0)
    expected_slippage_bps = max(0.0, _to_float(profile.get("expected_slippage_bps"), 0.8))
    avg_fill_latency_ms = max(1.0, latency_base_ms + latency_jitter_ms)
    return {
        "fill_count": 0,
        "instrument_count": 0,
        "avg_slippage_bps": round(expected_slippage_bps, 3),
        "avg_fill_latency_ms": round(avg_fill_latency_ms, 1),
        "avg_fill_quality_score": round(max(0.0, 100.0 - expected_slippage_bps * 2.0), 2),
        "last_fill_at": None,
        "observed": False,
        "source": "venue_execution_profile",
    }


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
        if quotes_response.status_code < 400:
            _mark_bus_event()

        matching_quotes = [
            quote
            for quote in quotes
            if _normalize_symbol(str(quote.get("instrument", ""))) == market_symbol
            and (_ROUTING_INCLUDE_PAPER_VENUES or not str(quote.get("venue") or "").startswith("paper-"))
        ]
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
        micro_responses = await asyncio.gather(
            *[
                client.get(
                    f"{MARKET_DATA_URL}/v1/market/microstructure",
                    params={"venue": str(quote.get("venue", "unknown")), "instrument": market_symbol, "lookback_minutes": 30},
                )
                for quote in matching_quotes
            ],
            return_exceptions=True,
        )

        candidates: list[dict] = []
        for quote, depth_response, micro_response in zip(matching_quotes, depth_responses, micro_responses):
            venue = str(quote.get("venue", "unknown"))
            venue_profile = _venue_execution_profile(venue)
            spread_bps = _to_float(quote.get("spread_bps"), 9999.0)
            depth_ok = not isinstance(depth_response, Exception) and depth_response.status_code < 400
            depth_payload = depth_response.json() if depth_ok else {}
            micro_ok = not isinstance(micro_response, Exception) and micro_response.status_code < 400
            micro_payload = micro_response.json() if micro_ok else {}
            book = (depth_payload or {}).get("depth_payload", {})
            bid_depth_usd, ask_depth_usd = _aggregate_depth(book)
            available_depth_usd = min(bid_depth_usd, ask_depth_usd) if bid_depth_usd > 0 and ask_depth_usd > 0 else max(bid_depth_usd, ask_depth_usd)
            mid = _mid_from_quote(quote)
            depth_levels = len(book.get("bids", [])) if isinstance(book, dict) and isinstance(book.get("bids", []), list) else 0
            depth_confidence = 1.0 if depth_levels >= 4 else 0.45 if depth_levels >= 1 else 0.05
            quote_age_ms = _timestamp_age_ms(quote.get("updated_at"))
            depth_age_ms = _timestamp_age_ms(depth_payload.get("snapshot_at"))
            if depth_ok and depth_levels >= 4 and depth_age_ms <= 5000:
                quote_age_ms = min(quote_age_ms, depth_age_ms) if quote_age_ms > 0 else depth_age_ms
            freshness_ms = max(quote_age_ms, depth_age_ms, 0)
            latency_ms = max(15.0, min(2000.0, 20.0 + freshness_ms * 0.15))
            reference_price = _to_float((micro_payload or {}).get("mark_price"), mid)
            tape_acceleration = _to_float((micro_payload or {}).get("tape_acceleration"), 0.0)
            incoming_flow_usd_per_min = tape_acceleration * max(reference_price, 0.0)
            depth_imbalance = _to_float((micro_payload or {}).get("depth_imbalance"), 0.0)
            volume_imbalance = _to_float((micro_payload or {}).get("volume_imbalance"), 0.0)
            trade_count = int(_to_float((micro_payload or {}).get("trade_count"), 0.0))
            if quote_age_ms <= 5000 and trade_count > 0:
                _mark_bus_event(trade_seen=True)
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
                    "queue_priority_bias": _to_float(venue_profile.get("queue_priority_bias"), 0.8),
                    "incoming_flow_usd_per_min": incoming_flow_usd_per_min,
                    "tape_acceleration": tape_acceleration,
                    "depth_imbalance": depth_imbalance,
                    "volume_imbalance": volume_imbalance,
                    "trade_count": trade_count,
                    "mark_price": reference_price,
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
                    "microstructure": micro_payload if isinstance(micro_payload, dict) else {},
                    "depth_payload": book,
                }
            )

    candidates = [c for c in candidates if _to_float(c.get("freshness_ms"), 0.0) <= _ROUTE_CANDIDATE_MAX_FRESHNESS_MS]

    ranked_candidates = sorted(_annotate_multi_venue_dominance(candidates), key=lambda item: item["score"], reverse=True)
    for index, candidate in enumerate(ranked_candidates):
        candidate["dominance_rank"] = index + 1
    return ranked_candidates


def _build_route_context(candidates: list[dict], requested_notional_usd: float | None = None) -> dict:
    price_weights = [(_to_float(candidate.get("last"), 0.0), max(_to_float(candidate.get("available_depth_usd"), 0.0), 1.0)) for candidate in candidates]
    fusion_price = _weighted_median_price(price_weights)
    best = candidates[0] if candidates else None
    backup = candidates[1] if len(candidates) > 1 else None
    best_bid = max((_to_float(candidate.get("best_bid"), 0.0) for candidate in candidates), default=0.0)
    asks = [_to_float(candidate.get("best_ask"), 0.0) for candidate in candidates if _to_float(candidate.get("best_ask"), 0.0) > 0]
    best_ask = min(asks) if asks else 0.0
    buy = next((candidate.get("venue") for candidate in candidates if _to_float(candidate.get("best_ask"), 0.0) == best_ask and best_ask > 0), "")
    sell = next((candidate.get("venue") for candidate in candidates if _to_float(candidate.get("best_bid"), 0.0) == best_bid and best_bid > 0), "")
    mids = [price for price, _ in price_weights if price > 0]
    deviation_bps = ((max(mids) - min(mids)) / fusion_price * 10000) if len(mids) >= 2 and fusion_price > 0 else 0.0
    target_notional_usd = _normalize_requested_notional_usd(requested_notional_usd, 1000.0)
    split_plan = _build_multi_venue_split_plan(candidates, "buy", target_notional_usd)
    arbitrage = _detect_cross_exchange_arbitrage(candidates, target_notional_usd)
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
        "arbitrage": arbitrage,
        "dominance": {
            "leader_venue": str((best or {}).get("venue") or ""),
            "runner_up_venue": str((backup or {}).get("venue") or ""),
            "leader_score": round(_to_float((best or {}).get("dominance_score"), _to_float((best or {}).get("score"), 0.0)), 6),
            "runner_up_score": round(_to_float((backup or {}).get("dominance_score"), _to_float((backup or {}).get("score"), 0.0)), 6),
            "score_gap": round(
                _to_float((best or {}).get("dominance_score"), _to_float((best or {}).get("score"), 0.0))
                - _to_float((backup or {}).get("dominance_score"), _to_float((backup or {}).get("score"), 0.0)),
                6,
            ),
            "latency_edge_ms": round(_to_float((best or {}).get("latency_edge_ms"), 0.0), 6),
            "queue_position": round(_to_float((best or {}).get("queue_position"), _to_float((best or {}).get("queue_priority_risk"), 0.0)), 6),
            "mode": str(split_plan.get("mode") or "singleVenue"),
        },
        "split_plan": split_plan,
        "best": best,
        "backup": backup,
        "reason": route_reason,
        "hedge_recommendation": _build_hedge_recommendation("buy", target_notional_usd, best, backup, split_plan, arbitrage),
    }


async def _fetch_market_venue_telemetry() -> dict[str, dict[str, object]]:
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(f"{MARKET_DATA_URL}/v1/market/venues/telemetry")
        if response.status_code >= 400:
            return {}
        payload = response.json()
        venues = payload.get("venues") if isinstance(payload, dict) else None
        if not isinstance(venues, list):
            return {}
        return {
            str(item.get("venue") or "unknown"): item
            for item in venues
            if isinstance(item, dict)
        }
    except Exception:
        return {}


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
    global OBSERVATION_TASK
    ensure_schema()
    # Warmup à froid : les premiers ordres routés servent les profils par défaut
    # pendant que cette reconstruction remplit le cache en arrière-plan.
    threading.Thread(target=_refresh_execution_optimizer_profiles, name="optimizer-profile-warmup", daemon=True).start()
    if OBSERVATION_TASK is None or OBSERVATION_TASK.done():
        OBSERVATION_TASK = asyncio.create_task(_observation_loop())


@app.on_event("shutdown")
async def shutdown() -> None:
    global OBSERVATION_TASK
    if OBSERVATION_TASK is not None:
        OBSERVATION_TASK.cancel()
        with suppress(asyncio.CancelledError):
            await OBSERVATION_TASK
        OBSERVATION_TASK = None


@app.get("/health")
async def health() -> dict:
    return {
        "status": "ok",
        "service": "execution-router",
        "orders": len(ORDERS),
        "positions": POSITIONS,
        "observation": _observation_snapshot(),
        "optimizer_profile_metrics": {
            **EXECUTION_OPTIMIZER_PROFILE_METRICS,
            "ttl_sec": _optimizer_profile_ttl_sec(),
            "profiles_updated_at": EXECUTION_OPTIMIZER_PROFILE_CACHE.get("updated_at"),
        },
    }


@app.get("/v1/routes/venues/telemetry")
async def route_venue_telemetry(lookback_minutes: int = 120) -> dict:
    window_minutes = max(5, min(1440, int(lookback_minutes)))
    market_venues = await _fetch_market_venue_telemetry()
    execution_rows = fetch_all(
        """
        SELECT
          venue,
          COUNT(*) AS fill_count,
          COUNT(DISTINCT instrument) AS instrument_count,
          AVG(COALESCE(slippage_bps, 0.0)) AS avg_slippage_bps,
          AVG(COALESCE(fill_latency_ms, 0)) AS avg_fill_latency_ms,
          AVG(COALESCE(NULLIF(payload->>'fill_quality_score', '')::double precision, GREATEST(0.0, 100.0 - COALESCE(slippage_bps, 0.0) * 2.0))) AS avg_fill_quality_score,
          MAX(filled_at) AS last_fill_at
        FROM execution_fill_events
        WHERE filled_at >= NOW() - (%s || ' minutes')::interval
        GROUP BY venue
        ORDER BY venue
        """,
        (window_minutes,),
    )
    execution_by_venue = {
        str(row.get("venue") or "unknown"): row
        for row in execution_rows
    }
    all_venues = sorted(set(market_venues.keys()) | set(execution_by_venue.keys()) | set(VENUE_STABILITY.keys()))
    return {
        "status": "ok",
        "lookback_minutes": window_minutes,
        "venues": [
            {
                "venue": venue,
                "market": market_venues.get(venue),
                "execution": (
                    {
                        "fill_count": int(execution_by_venue[venue].get("fill_count") or 0),
                        "instrument_count": int(execution_by_venue[venue].get("instrument_count") or 0),
                        "avg_slippage_bps": round(_to_float(execution_by_venue[venue].get("avg_slippage_bps"), 0.0), 3),
                        "avg_fill_latency_ms": round(_to_float(execution_by_venue[venue].get("avg_fill_latency_ms"), 0.0), 1),
                        "avg_fill_quality_score": round(_to_float(execution_by_venue[venue].get("avg_fill_quality_score"), 0.0), 2),
                        "last_fill_at": execution_by_venue[venue].get("last_fill_at"),
                        "observed": True,
                        "source": "execution_fill_events",
                    }
                    if venue in execution_by_venue
                    else _profile_execution_baseline(venue)
                ),
                "stability": VENUE_STABILITY.get(venue),
                "profile": _venue_execution_profile(venue),
            }
            for venue in all_venues
        ],
        "updated_at": _now_iso(),
    }


@app.get("/v1/execution-optimizer/live-state")
async def execution_optimizer_live_state() -> dict:
    profiles = _load_execution_optimizer_profiles()
    persisted_active_orders = _load_persisted_active_execution_orders(limit=20)
    persisted_recent_events = _load_recent_execution_optimizer_events(limit=20)
    return {
        "status": "ok",
        "updated_at": _now_iso(),
        "profiles_updated_at": EXECUTION_OPTIMIZER_PROFILE_CACHE.get("updated_at"),
        "profiles": profiles,
        "active_orders": persisted_active_orders,
        "recent_events": persisted_recent_events,
    }


@app.get("/v1/execution-ai/v6/state")
async def execution_ai_v6_state() -> dict:
    _ensure_execution_ai_v6_state_loaded()
    return {
        "status": "ok",
        "snapshot": _execution_ai_v6_snapshot(),
    }


@app.get("/v1/routes/score")
async def route_score(
    symbol: str,
    infra_health: float | None = None,
    network_regime: str | None = None,
    estimated_notional_usd: float | None = None,
) -> dict:
    _ensure_execution_ai_v6_state_loaded()
    resolved_infra = _resolve_infra_context(
        {"infra_health": infra_health, "network_regime": network_regime}
    )
    candidates = await _build_route_candidates(symbol, infra_context=resolved_infra)
    context = _build_route_context(candidates, requested_notional_usd=estimated_notional_usd)
    execution_ai_v6_context = {
        "split_plan": context.get("split_plan"),
        "arbitrage": context.get("arbitrage"),
        "hedge_recommendation": context.get("hedge_recommendation"),
    }
    execution_ai_v6_state = _build_execution_ai_v6_state(
        "buy",
        _to_float(estimated_notional_usd, 0.0),
        context.get("best") if isinstance(context.get("best"), dict) else None,
        context.get("backup") if isinstance(context.get("backup"), dict) else None,
        execution_ai_v6_context,
        {},
    )
    execution_ai_v6_decision = _execution_ai_v6_decide(execution_ai_v6_state)
    failure_attribution = _build_route_failure_attribution(candidates, context, resolved_infra)
    best_candidate = context.get("best") if isinstance(context.get("best"), dict) else None
    best_optimizer_snapshot = _enrich_execution_optimizer_snapshot(
        best_candidate,
        build_execution_optimizer_snapshot(
            best_candidate,
            "buy",
            _to_float(estimated_notional_usd, 0.0),
            "default",
            "MARKET",
            0.0,
            desk_profile=_execution_optimizer_profile_for_venue(str(best_candidate.get("venue") or "unknown")),
        ) if isinstance(best_candidate, dict) else {},
        "buy",
        _to_float(estimated_notional_usd, 0.0),
    ) if isinstance(best_candidate, dict) else {}
    return {
        "symbol": _normalize_symbol(symbol),
        "best": context.get("best"),
        "backup": context.get("backup"),
        "fusion_price": context.get("fusion_price"),
        "deviation_bps": context.get("deviation_bps"),
        "arbitrage": context.get("arbitrage"),
        "dominance": context.get("dominance"),
        "split_plan": context.get("split_plan"),
        "hedge_recommendation": context.get("hedge_recommendation"),
        "source": "v5-multi-venue-dominance",
        "reason": context.get("reason") or "no_market_candidates",
        "execution_ai_v6": {
            "state": execution_ai_v6_state,
            "decision": execution_ai_v6_decision,
            "snapshot": _execution_ai_v6_snapshot(),
        },
        "market_structure": best_optimizer_snapshot.get("market_structure") if isinstance(best_optimizer_snapshot.get("market_structure"), dict) else {},
        "execution_context": best_optimizer_snapshot.get("execution_context") if isinstance(best_optimizer_snapshot.get("execution_context"), dict) else {},
        "execution_optimizer_v3": best_optimizer_snapshot,
        "infra_health": _to_float(resolved_infra.get("infra_health"), 1.0),
        "network_regime": str(resolved_infra.get("network_regime") or "stable"),
        "failure_source": failure_attribution.get("failure_source"),
        "failure_reasons": failure_attribution.get("failure_reasons"),
        "failure_blocking": bool(failure_attribution.get("failure_blocking")),
        "candidates": candidates,
        **_observation_snapshot(),
    }


@app.post("/v1/orders/routed")
async def place_routed_order(payload: dict) -> dict:
    _ensure_execution_ai_v6_state_loaded()
    symbol = _normalize_symbol(str(payload.get("symbol", "")))
    if not symbol:
        raise HTTPException(status_code=400, detail="symbol is required")
    side = _normalize_trade_side(payload.get("side"))
    if side not in {"buy", "sell"}:
        raise HTTPException(status_code=400, detail="side must be buy/sell")
    payload["side"] = side
    notional = _to_float(payload.get("estimated_notional_usd"), 0.0)
    if notional <= 0:
        raise HTTPException(status_code=400, detail="estimated_notional_usd must be > 0")
    execution_delay_ms = _resolve_execution_delay_ms(payload)

    resolved_infra = _resolve_infra_context(payload)
    candidates = await _build_route_candidates(symbol, infra_context=resolved_infra)
    if not candidates:
        raise HTTPException(status_code=502, detail="no route candidates available")

    context = _build_route_context(candidates, requested_notional_usd=notional)
    failure_attribution = _build_route_failure_attribution(candidates, context, resolved_infra)
    route_preferences = _resolve_route_preferences(payload)
    pre_trade_memory_gate = _extract_pre_trade_memory_gate(payload)
    ranked_candidates = _rank_route_candidates(candidates, side, route_preferences)
    selected, backup, route_reason, route_selection = _select_route_candidates(
        candidates,
        side,
        route_preferences,
        str(context.get("reason") or "best_stable_route_candidate"),
    )

    decision_id = str(payload.get("decision_id") or f"route-{uuid4()}")
    live_context = _live_execution_context(payload)
    evaluated_candidates = [
        {
            "candidate": candidate,
            "snapshot": _enrich_execution_optimizer_snapshot(
                candidate,
                build_execution_optimizer_snapshot(
                    candidate,
                    side,
                    notional,
                    str(route_preferences.get("execution_style") or "default"),
                    str(live_context.get("order_type") or "MARKET"),
                    _to_float(live_context.get("price"), 0.0),
                    desk_profile=_execution_optimizer_profile_for_venue(str(candidate.get("venue") or "unknown")),
                ),
                side,
                notional,
            ),
        }
        for candidate in ranked_candidates
    ]
    split_plan = context.get("split_plan") if isinstance(context.get("split_plan"), dict) else {}
    if _normalize_execution_style(route_preferences.get("execution_style")) == "primary_only":
        split_plan = {
            "mode": "singleVenueOverride",
            "slices": [],
            "total_notional_usd": round(notional, 6),
            "remaining_notional_usd": 0.0,
            "coverage_ratio": 1.0,
            "estimated_average_price": 0.0,
            "estimated_slippage_bps": 0.0,
            "primary_venue": str(selected.get("venue") or "unknown"),
            "venue_count": 1,
        }
    hedge_recommendation = _build_hedge_recommendation(
        side,
        notional,
        selected if isinstance(selected, dict) else None,
        backup if isinstance(backup, dict) else None,
        split_plan,
        context.get("arbitrage") if isinstance(context.get("arbitrage"), dict) else None,
    )
    execution_ai_v6_context = {
        "split_plan": split_plan,
        "arbitrage": context.get("arbitrage"),
        "hedge_recommendation": hedge_recommendation,
    }
    execution_ai_v6_state = _build_execution_ai_v6_state(
        side,
        notional,
        selected if isinstance(selected, dict) else None,
        backup if isinstance(backup, dict) else None,
        execution_ai_v6_context,
        route_preferences,
    )
    execution_ai_v6_decision = _execution_ai_v6_decide(execution_ai_v6_state)
    selected_entry = next(
        (
            entry
            for entry in evaluated_candidates
            if str(entry["candidate"].get("venue") or "") == str(selected.get("venue") or "")
        ),
        None,
    )
    if selected_entry is None or not execution_optimizer_allows_trade(selected_entry["snapshot"]):
        selected_entry = next((entry for entry in evaluated_candidates if execution_optimizer_allows_trade(entry["snapshot"])), None)
        if selected_entry is None:
            raise HTTPException(
                status_code=409,
                detail={
                    "status": "execution_optimizer_v3_blocked",
                    "decision_id": decision_id,
                    "symbol": symbol,
                    "side": side,
                    "requested_notional_usd": notional,
                    "selected_venue": str(selected.get("venue") or ""),
                    "execution_style": str(route_preferences.get("execution_style") or "default"),
                    "candidates": [
                        _compact_execution_optimizer_candidate(entry["candidate"], entry["snapshot"])
                        for entry in evaluated_candidates[:5]
                    ],
                },
            )
        if str(selected.get("venue") or "") != str(selected_entry["candidate"].get("venue") or ""):
            route_reason = f"execution_optimizer_v3_fallback_{route_reason}"
        selected = selected_entry["candidate"]
    selected_optimizer_v3 = selected_entry["snapshot"] if isinstance(selected_entry, dict) else {}
    backup_entry = next(
        (
            entry
            for entry in evaluated_candidates
            if str(entry["candidate"].get("venue") or "") != str(selected.get("venue") or "")
            and execution_optimizer_allows_trade(entry["snapshot"])
        ),
        None,
    )
    if backup_entry is not None:
        backup = backup_entry["candidate"]
    backup_optimizer_v3 = backup_entry["snapshot"] if isinstance(backup_entry, dict) else {}
    selected_execution_context = selected_optimizer_v3.get("execution_context") if isinstance(selected_optimizer_v3.get("execution_context"), dict) else {}
    selected_market_structure = selected_optimizer_v3.get("market_structure") if isinstance(selected_optimizer_v3.get("market_structure"), dict) else {}
    execution_notional_usd, context_adjusted_notional_usd, preserve_approved_live_notional = _resolve_live_execution_notional(
        payload,
        live_context,
        selected_execution_context,
    )
    route_selection["execution_optimizer_v3"] = {
        "selected_venue": str(selected.get("venue") or "unknown"),
        "fallback_used": str(selected.get("venue") or "") != str((context.get("best") or {}).get("venue") or ""),
        "evaluated": [
            _compact_execution_optimizer_candidate(entry["candidate"], entry["snapshot"])
            for entry in evaluated_candidates[:5]
        ],
        "preserve_approved_live_notional": preserve_approved_live_notional,
    }
    route_selection["market_structure"] = selected_market_structure
    route_selection["execution_context"] = selected_execution_context
    route_selection["dominance"] = context.get("dominance") if isinstance(context.get("dominance"), dict) else {}
    route_selection["split_plan"] = split_plan
    route_selection["hedge_recommendation"] = hedge_recommendation
    route_selection["execution_ai_v6"] = {
        "state": execution_ai_v6_state,
        "decision": execution_ai_v6_decision,
    }
    effective_live_context = apply_order_management_to_live_context(live_context, selected_optimizer_v3) if bool(live_context.get("enabled")) else live_context
    if _to_float(effective_live_context.get("notional_usd"), 0.0) > 0:
        if preserve_approved_live_notional:
            effective_live_context["notional_usd"] = execution_notional_usd
        else:
            effective_live_context["notional_usd"] = min(_to_float(effective_live_context.get("notional_usd"), 0.0), execution_notional_usd)
    execution_ai_action = str(execution_ai_v6_decision.get("action") or "hold")
    best_bid = _to_float(selected.get("best_bid"), 0.0)
    best_ask = _to_float(selected.get("best_ask"), 0.0)
    midpoint_price = (best_bid + best_ask) / 2.0 if best_bid > 0 and best_ask > 0 else 0.0
    if bool(effective_live_context.get("enabled")):
        # D1 — autonomous proof-renewal: force a MARKET taker so the cycle yields a
        # real canonical fill; never let it take the passive-LIMIT branch (which can
        # rest unfilled). Contract validated in proof_order_shape (raises on violation).
        try:
            _proof_shape = resolve_proof_renewal_order_shape(payload)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=f"proof_renewal: {exc}") from exc
        if _proof_shape is not None:
            effective_live_context["order_type"] = "MARKET"
            effective_live_context.pop("price", None)
            effective_live_context["proof_cycle_id"] = _proof_shape["proof_cycle_id"]
        elif execution_ai_action == "market_sweep":
            effective_live_context["order_type"] = "MARKET"
            effective_live_context.pop("price", None)
        elif execution_ai_action in {"join_best_limit", "cancel_replace"}:
            effective_live_context["order_type"] = "LIMIT"
            target_limit_price = best_bid if side == "buy" else best_ask
            if target_limit_price > 0:
                effective_live_context["price"] = target_limit_price
        elif execution_ai_action == "move_to_mid" and midpoint_price > 0:
            effective_live_context["order_type"] = "LIMIT"
            effective_live_context["price"] = midpoint_price
    if execution_delay_ms > 0:
        await asyncio.sleep(execution_delay_ms / 1000.0)

    broker_order: dict[str, object] | None = None
    if bool(live_context.get("enabled")):
        broker_order = await _execute_live_order(payload, effective_live_context, decision_id)
        fills = _as_list(broker_order.get("fills"))
        avg_fill_price = _to_float(broker_order.get("avg_fill_price"), 0.0)
        filled_notional = _to_float(broker_order.get("filled_notional_usd"), 0.0)
        order_status = str(broker_order.get("status") or "unknown")
        actual_venue = str(broker_order.get("venue") or effective_live_context.get("provider") or selected.get("venue") or "unknown")
        if _live_order_open(order_status):
            ACTIVE_EXECUTION_ORDER_TASKS[decision_id] = asyncio.create_task(
                _run_execution_optimizer_live_loop(
                    payload=payload,
                    live_context=effective_live_context,
                    broker_order=broker_order,
                    selected_candidate=selected,
                    route_preferences=route_preferences,
                    decision_id=decision_id,
                )
            )
    else:
        split_slices = split_plan.get("slices") if isinstance(split_plan, dict) and isinstance(split_plan.get("slices"), list) else []
        use_split_simulation = (
            len(split_slices) >= 2
            and _normalize_execution_style(route_preferences.get("execution_style")) != "primary_only"
            and _normalize_route_mode_override(route_preferences.get("route_mode_override")) != "dualVenueExecution"
        )
        if execution_ai_action == "split_ioc" and len(split_slices) >= 2:
            use_split_simulation = True
        if use_split_simulation:
            fills, avg_fill_price = _simulate_split_fills(
                decision_id=decision_id,
                side=side,
                instrument=symbol,
                split_plan={
                    **split_plan,
                    "total_notional_usd": round(execution_notional_usd, 6),
                },
                candidates_by_venue={str(candidate.get("venue") or ""): candidate for candidate in candidates},
                execution_delay_ms=execution_delay_ms,
            )
        else:
            fills, avg_fill_price = _simulate_fills(
                decision_id=decision_id,
                side=side,
                notional_usd=execution_notional_usd,
                depth_payload=(selected.get("depth_payload") or {}),
                venue=str(selected.get("venue", "unknown")),
                instrument=symbol,
                execution_delay_ms=execution_delay_ms,
            )
        filled_notional = sum(_to_float(fill.get("notional_usd"), 0.0) for fill in fills)
        order_status = "filled"
        actual_venue = str(split_plan.get("primary_venue") or selected.get("venue", "unknown"))

    spread_bps = _to_float(selected.get("spread_bps"), 0.0)
    reference_price = _to_float(selected.get("best_ask" if side == "buy" else "best_bid"), avg_fill_price)
    expected_slippage_bps = max(
        0.2,
        _to_float(selected_optimizer_v3.get("expected_slippage_bps"), 0.0),
        spread_bps * 0.7,
        _to_float(split_plan.get("estimated_slippage_bps"), 0.0),
    )
    realized_slippage_bps = abs(avg_fill_price - reference_price) / max(reference_price, 1e-9) * 10000 if avg_fill_price > 0 and reference_price > 0 else 0.0
    fill_quality_score = max(0.0, 100.0 - spread_bps * 1.6 - realized_slippage_bps * 2.0)
    average_fill_latency_ms = (
        sum(_to_float(fill.get("fill_latency_ms"), 0.0) for fill in fills) / max(1, len(fills))
        if fills
        else 0.0
    )
    adverse_selection_score = _clamp(
        (
            _to_float(selected.get("partial_fill_risk"), 0.0)
            + _to_float(selected.get("queue_position"), _to_float(selected.get("queue_priority_risk"), 0.0))
        )
        / 2.0,
        0.0,
        1.0,
    )
    edge_bps = _to_float((context.get("arbitrage") or {}).get("net_spread_bps"), 0.0)
    if edge_bps == 0.0:
        edge_bps = expected_slippage_bps - realized_slippage_bps
    execution_ai_v6_learning = _execution_ai_v6_learn(
        execution_ai_v6_state,
        execution_ai_v6_decision,
        decision_id=decision_id,
        requested_notional_usd=execution_notional_usd,
        filled_notional_usd=filled_notional,
        realized_slippage_bps=realized_slippage_bps,
        fill_latency_ms=average_fill_latency_ms,
        adverse_selection_score=adverse_selection_score,
        edge_bps=edge_bps,
        policy_context=selected_execution_context,
    )

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
            execution_notional_usd,
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
                "provider": effective_live_context.get("provider"),
                "account_id": effective_live_context.get("account_id"),
                "position_side": effective_live_context.get("position_side"),
                "order_type": effective_live_context.get("order_type"),
                "price": effective_live_context.get("price"),
                "protection": effective_live_context.get("protection") if isinstance(effective_live_context.get("protection"), dict) else {},
                # FTE-001 step 5: persist the venue order id on the fill so post-trade
                # income-ledger events can be reconciled to this cycle (deterministic
                # order_id->tradeId bridge). Absent on the book/split path (None).
                "venue_order_id": str((broker_order or {}).get("order_id") or "") or None,
                "client_order_id": str((broker_order or {}).get("client_order_id") or "") or None,
            },
            "route": {
                "chosen": str(selected.get("venue") or actual_venue),
                "backup": str(backup.get("venue") or "") if isinstance(backup, dict) else "",
                "reason": route_reason,
                "split_plan": split_plan,
                "hedge_recommendation": hedge_recommendation,
                "market_structure": selected_market_structure,
                "execution_context": selected_execution_context,
                "original_requested_notional_usd": notional,
                "context_adjusted_notional_usd": context_adjusted_notional_usd,
                "preserve_approved_live_notional": preserve_approved_live_notional,
            },
            "execution_optimizer_v3": {
                "selected": selected_optimizer_v3,
                "backup": backup_optimizer_v3,
                "profile": selected_optimizer_v3.get("desk_profile") if isinstance(selected_optimizer_v3.get("desk_profile"), dict) else {},
            },
            "execution_ai_v6": {
                "state": execution_ai_v6_state,
                "decision": execution_ai_v6_decision,
                "learning": execution_ai_v6_learning,
            },
            "expected_slippage_bps": expected_slippage_bps,
            "realized_slippage_bps": realized_slippage_bps,
            "fill_quality_score": fill_quality_score,
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
        "requested_notional_usd": execution_notional_usd,
        "original_requested_notional_usd": notional,
        "context_adjusted_notional_usd": context_adjusted_notional_usd,
        "filled_notional_usd": filled_notional,
        "avg_fill_price": avg_fill_price,
        "execution_mode": execution_mode,
        "protection_status": str((broker_order or {}).get("protection_status") or "not_requested"),
        "protection": (broker_order or {}).get("protection") if isinstance((broker_order or {}).get("protection"), dict) else {},
        "expected_slippage_bps": expected_slippage_bps,
        "realized_slippage_bps": realized_slippage_bps,
        "fill_quality_score": fill_quality_score,
        "execution_delay_ms_applied": execution_delay_ms,
        "execution_ai_v6": {
            "state": execution_ai_v6_state,
            "decision": execution_ai_v6_decision,
            "learning": execution_ai_v6_learning,
            "snapshot": _execution_ai_v6_snapshot(),
        },
        "route": {
            "chosen": selected,
            "backup": backup,
            "reason": route_reason,
            "preferences": route_preferences,
            "selection": route_selection,
            "market_structure": selected_market_structure,
            "execution_context": selected_execution_context,
            "original_requested_notional_usd": notional,
            "context_adjusted_notional_usd": context_adjusted_notional_usd,
            "preserve_approved_live_notional": preserve_approved_live_notional,
            "mode": "live" if broker_order else "simulated",
            "execution_target": actual_venue,
            "source": "v5-multi-venue-dominance",
            "dominance": context.get("dominance") if isinstance(context.get("dominance"), dict) else {},
            "split_plan": split_plan,
            "hedge_recommendation": hedge_recommendation,
            "arbitrage": context.get("arbitrage"),
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
            "provider": effective_live_context.get("provider"),
            "account_id": effective_live_context.get("account_id"),
            "position_side": effective_live_context.get("position_side"),
            "order_type": effective_live_context.get("order_type"),
            "price": effective_live_context.get("price"),
            "protection": effective_live_context.get("protection") if isinstance(effective_live_context.get("protection"), dict) else {},
        },
        "execution_optimizer_v3": {
            "selected": selected_optimizer_v3,
            "backup": backup_optimizer_v3,
            "profile": selected_optimizer_v3.get("desk_profile") if isinstance(selected_optimizer_v3.get("desk_profile"), dict) else {},
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
            requested_notional_usd=execution_notional_usd,
            filled_notional_usd=filled_notional,
            avg_fill_price=avg_fill_price,
            execution_mode=execution_mode,
            protection_status=str((broker_order or {}).get("protection_status") or "not_requested"),
            protection=(broker_order or {}).get("protection") if isinstance((broker_order or {}).get("protection"), dict) else {},
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
    requested_protection = intent.protection.model_dump(mode="json", exclude_none=True) if intent.protection else {}

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
        protection_status="simulated" if requested_protection else "not_requested",
        protection={"mode": "paper", "requested": requested_protection} if requested_protection else {},
    )
    ORDERS.append(order)
    return order