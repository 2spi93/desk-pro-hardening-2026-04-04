from __future__ import annotations

import asyncio
from collections import deque
import os
import socket
from datetime import datetime, timedelta, timezone
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from time import perf_counter
from urllib.parse import urlparse
from uuid import uuid4

import httpx
from fastapi import FastAPI
from pydantic import BaseModel, Field

from shared.db import ensure_schema, execute as db_execute, execute_rowcount, fetch_all, fetch_one, json_dumps

try:
    from shared.feature_flags import load_feature_flags
except ImportError:
    def load_feature_flags(path: str | Path | None, defaults: dict[str, bool] | None = None) -> dict[str, bool]:
        return dict(defaults or {})

try:
    from .multi_agent_router import router as multi_agent_router, get_hf_system
except ImportError:
    from multi_agent_router import router as multi_agent_router, get_hf_system

app = FastAPI(title="AI Orchestrator", version="0.1.0")
app.include_router(multi_agent_router)


DEFAULT_KAIROS_RUNTIME_FEATURE_FLAGS: dict[str, bool] = {
    "kairos_live": False,
    "kairos_strategy_arena": True,
    "memory_v2_causal_strict": True,
    "auto_dream_safe_mode": True,
    "meta_governor_global": True,
    "execution_learning_required": True,
    "mutation_engine": False,
    "aggressive_mode": False,
    "risk_off_mode": False,
    "multi_venue_arbitrage": False,
}

KAIROS_FEATURE_FLAGS_PATH = Path(os.getenv("TXT_FEATURE_FLAGS_PATH", "/workspace/config/kairos_feature_flags.json"))


class OrchestrateRequest(BaseModel):
    task: str
    prompt: str
    criticality: str = Field(default="medium")
    cost_limit_usd: float = Field(default=0.05, ge=0)
    prefer_local: bool = False


class RouteDecision(BaseModel):
    primary_model: str
    fallback_model: str
    primary_provider: str
    fallback_provider: str
    reason: str
    estimated_cost_usd: float


class OrchestrateResponse(BaseModel):
    route: RouteDecision
    model_used: str
    provider_used: str
    output: str
    latency_ms: int
    retries_used: int = 0
    fallback_used: bool = False


class WarmupRequest(BaseModel):
    model_key: str | None = None


class RegimeDetectRequest(BaseModel):
    trend_score: float = Field(ge=-1.0, le=1.0)
    realized_volatility: float = Field(ge=0.0)
    sentiment_score: float = Field(ge=-1.0, le=1.0)


class GeopoliticalBacktestRequest(BaseModel):
    strategy_name: str
    asset_class: str
    scenario: str
    horizon_days: int = Field(default=20, ge=1, le=365)


class DecisionScoreRequest(BaseModel):
    confidence: float = Field(ge=0.0, le=1.0)
    consistency: float = Field(ge=0.0, le=1.0)
    risk_alignment: float = Field(ge=0.0, le=1.0)
    historical_match: float = Field(ge=0.0, le=1.0)
    threshold: float = Field(default=0.7, ge=0.0, le=1.0)


class MultiAgentVoteRequest(BaseModel):
    votes: dict[str, str]
    disagreement_threshold: float = Field(default=0.34, ge=0.0, le=1.0)


class KairosShadowStartRequest(BaseModel):
    symbol: str | None = None
    venue: str | None = None
    cycle_seconds: float | None = Field(default=None, ge=1.0, le=300.0)


class KairosShadowHarnessRequest(KairosShadowStartRequest):
    synthetic_snapshot: dict[str, Any] | None = None
    seed_price_history: list[float] = Field(default_factory=list)
    seed_volume_history: list[float] = Field(default_factory=list)
    allow_live_handoff: bool = False
    isolate_runtime: bool = True


def _env_flag(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _float_env(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except Exception:
        return default


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except Exception:
        return default


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except Exception:
        return default


def _sanitize_history_seed(values: list[float] | None, *, allow_zero: bool = False, maxlen: int = 64) -> list[float]:
    if not isinstance(values, list):
        return []
    sanitized: list[float] = []
    for item in values[-maxlen:]:
        numeric = _safe_float(item, 0.0)
        if numeric > 0 or (allow_zero and numeric >= 0):
            sanitized.append(numeric)
    return sanitized[-maxlen:]


def _clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def _symbol_key(symbol: str | None) -> str:
    return str(symbol or "").strip().upper().replace("/", "").replace("-", "")


def _kairos_regime(instrument_data: dict[str, Any]) -> str:
    volatility = _safe_float(instrument_data.get("volatility"), 0.0)
    trend_strength = _safe_float(instrument_data.get("trend_strength"), 0.0)
    chop_index = _safe_float(instrument_data.get("chop_index"), 50.0)
    if volatility > 0.04:
        return "VOLATILE"
    if trend_strength > 0.6:
        return "TREND"
    if chop_index > 60.0:
        return "CHOP"
    return "BALANCED"


def _kairos_decision_constraints(symbol: str) -> dict[str, float]:
    symbol_key = _symbol_key(symbol)
    min_consensus_pct = _float_env("KAIROS_MIN_CONSENSUS_PCT", 60.0)
    min_confidence = _float_env("KAIROS_MIN_META_CONFIDENCE", 0.70)
    if symbol_key == "SOLUSDT" and _env_flag("KAIROS_SOL_MOMENTUM_ONLY", True):
        min_confidence = max(min_confidence, _float_env("KAIROS_SOL_MIN_META_CONFIDENCE", 0.78))
    return {
        "min_consensus_pct": min_consensus_pct,
        "min_confidence": min_confidence,
    }


def _sol_momentum_gate(symbol: str, side: str, confidence: float, instrument_data: dict[str, Any]) -> str | None:
    if _symbol_key(symbol) != "SOLUSDT" or not _env_flag("KAIROS_SOL_MOMENTUM_ONLY", True):
        return None
    regime = _kairos_regime(instrument_data)
    trend_strength = _safe_float(instrument_data.get("trend_strength"), 0.0)
    momentum_roc = _safe_float(instrument_data.get("momentum_roc"), 0.0)
    min_trend_strength = _float_env("KAIROS_SOL_TREND_STRENGTH_MIN", 0.60)
    min_momentum_roc = _float_env("KAIROS_SOL_MOMENTUM_ROC_MIN", 0.003)
    min_confidence = _float_env("KAIROS_SOL_MIN_META_CONFIDENCE", 0.78)

    if regime != "TREND" or trend_strength < min_trend_strength:
        return "sol_requires_momentum_regime"
    if confidence < min_confidence:
        return "sol_requires_higher_confidence"
    if side == "long" and momentum_roc < min_momentum_roc:
        return "sol_long_requires_positive_momentum"
    if side == "short" and momentum_roc > -min_momentum_roc:
        return "sol_short_requires_negative_momentum"
    return None


def _build_pre_trade_memory_gate(memory_query: dict[str, Any], feature_flags: dict[str, bool]) -> dict[str, Any]:
    raw_response = memory_query if isinstance(memory_query, dict) else {}
    recommendation = raw_response.get("recommendation") if isinstance(raw_response.get("recommendation"), dict) else {}
    causal_guard = raw_response.get("causal_guard") if isinstance(raw_response.get("causal_guard"), dict) else {}
    confidence = _safe_float(raw_response.get("confidence"), 0.0)
    size_multiplier_cap = _clamp(_safe_float(recommendation.get("size_multiplier_cap"), 1.0), 0.0, 1.0)
    strict_causal = bool(feature_flags.get("memory_v2_causal_strict", True))
    status = str(raw_response.get("status") or "ok").strip().lower() or "ok"
    strategy_mode = str(recommendation.get("strategy_mode") or "").strip().lower()

    reasons: list[str] = []
    risk_off = confidence >= 0.55 and strategy_mode == "risk_off"
    size_cap_active = confidence >= 0.55 and size_multiplier_cap <= 0.75
    causal_thin = bool(causal_guard.get("enabled")) and str(causal_guard.get("reason") or "").strip() == "insufficient_causal_evidence"
    query_not_ok = status != "ok"

    if risk_off:
        reasons.append("memory_risk_off")
    if size_cap_active:
        reasons.append("memory_size_multiplier_capped")
    if causal_thin:
        reasons.append("memory_causal_evidence_thin")
    if query_not_ok:
        reasons.append("memory_query_not_ok")

    block_execution = risk_off or size_cap_active or (strict_causal and (causal_thin or query_not_ok))
    gate_status = "blocked" if block_execution else ("advisory" if reasons else "pass")
    return {
        "required": True,
        "strict_causal": strict_causal,
        "status": gate_status,
        "block_execution": block_execution,
        "reasons": reasons,
        "source": raw_response.get("source"),
        "confidence": confidence,
        "recommendation": recommendation,
        "causal_guard": causal_guard,
        "size_multiplier_cap": size_multiplier_cap,
        "memory_query_status": status,
    }


class KairosShadowRuntime:
    def __init__(self) -> None:
        self.symbol = str(os.getenv("KAIROS_SYMBOL", "BTCUSDT")).strip().upper() or "BTCUSDT"
        self.venue = str(os.getenv("KAIROS_VENUE", "binance-public")).strip().lower() or "binance-public"
        self.cycle_seconds = max(1.0, _float_env("KAIROS_CYCLE_SECONDS", 5.0))
        self.lookback_minutes = max(5, _int_env("KAIROS_LOOKBACK_MINUTES", 30))
        self.market_data_url = os.getenv("KAIROS_MARKET_DATA_URL", "http://market-data:8003").rstrip("/")
        self.predictor_url = os.getenv("KAIROS_PREDICTOR_URL", "http://predictor-v8:8008").rstrip("/")
        self.control_plane_url = str(
            os.getenv("KAIROS_CONTROL_PLANE_URL")
            or os.getenv("CONTROL_PLANE_URL")
            or os.getenv("CONTROL_PLANE_FALLBACK_URL")
            or "http://control-plane:8000"
        ).rstrip("/")
        self.platform_id = str(os.getenv("KAIROS_PLATFORM_ID", "kairos")).strip().lower() or "kairos"
        self.route_key = str(os.getenv("KAIROS_ROUTE_KEY", "default")).strip().lower() or "default"
        self.active = False
        self.task: asyncio.Task[None] | None = None
        self.last_cycle_at: str | None = None
        self.last_error: str | None = None
        self.cycles_total = 0
        self.proposed_total = 0
        self.skipped_total = 0
        self.price_history: deque[float] = deque(maxlen=64)
        self.volume_history: deque[float] = deque(maxlen=64)
        self.recent_cycles: deque[dict[str, Any]] = deque(maxlen=max(20, _int_env("KAIROS_RECENT_CYCLES_LIMIT", 50)))

    def runtime_feature_flags(self) -> dict[str, bool]:
        return load_feature_flags(KAIROS_FEATURE_FLAGS_PATH, DEFAULT_KAIROS_RUNTIME_FEATURE_FLAGS)

    def status(self) -> dict[str, Any]:
        persisted = _fetch_kairos_shadow_counts()
        return {
            "status": "ok",
            "active": self.active,
            "configured_enabled": _env_flag("KAIROS_SHADOW_ENABLED", False),
            "symbol": self.symbol,
            "venue": self.venue,
            "cycle_seconds": self.cycle_seconds,
            "lookback_minutes": self.lookback_minutes,
            "last_cycle_at": self.last_cycle_at,
            "last_error": self.last_error,
            "cycles_total": self.cycles_total,
            "proposed_total": self.proposed_total,
            "skipped_total": self.skipped_total,
            "recent_cycles": len(self.recent_cycles),
            "history_points": {
                "prices": len(self.price_history),
                "volumes": len(self.volume_history),
            },
            "feature_flags": self.runtime_feature_flags(),
            "execution_handoff": {
                "enabled": _env_flag("KAIROS_LIVE_ROUTING_ENABLED", False),
                "platform_id": self.platform_id,
                "route_key": self.route_key,
                "control_plane_url": self.control_plane_url,
                "estimated_notional_usd": _float_env("KAIROS_ESTIMATED_NOTIONAL_USD", 0.0),
            },
            "persisted": persisted,
        }

    def reconfigure(self, request: KairosShadowStartRequest) -> None:
        if isinstance(request.symbol, str) and request.symbol.strip():
            self.symbol = request.symbol.strip().upper()
        if isinstance(request.venue, str) and request.venue.strip():
            self.venue = request.venue.strip().lower()
        if request.cycle_seconds is not None:
            self.cycle_seconds = max(1.0, float(request.cycle_seconds))

    async def start(self) -> None:
        if self.active and self.task and not self.task.done():
            return
        self.active = True
        self.last_error = None
        get_hf_system(self.symbol)
        self.task = asyncio.create_task(self._loop(), name="kairos-shadow-loop")

    async def stop(self) -> None:
        self.active = False
        task = self.task
        self.task = None
        if task is None:
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    async def run_once(self) -> dict[str, Any]:
        return await self._run_cycle()

    async def run_harness_once(self, request: KairosShadowHarnessRequest) -> dict[str, Any]:
        original_symbol = self.symbol
        original_venue = self.venue
        original_cycle_seconds = self.cycle_seconds
        original_prices = deque(self.price_history, maxlen=self.price_history.maxlen)
        original_volumes = deque(self.volume_history, maxlen=self.volume_history.maxlen)

        self.reconfigure(request)
        if request.seed_price_history:
            self.price_history.clear()
            self.price_history.extend(_sanitize_history_seed(request.seed_price_history, allow_zero=False, maxlen=self.price_history.maxlen))
        if request.seed_volume_history:
            self.volume_history.clear()
            self.volume_history.extend(_sanitize_history_seed(request.seed_volume_history, allow_zero=True, maxlen=self.volume_history.maxlen))

        harness_input = {
            "mode": "synthetic-one-shot",
            "symbol": self.symbol,
            "venue": self.venue,
            "allow_live_handoff": bool(request.allow_live_handoff),
            "isolate_runtime": bool(request.isolate_runtime),
            "seed_price_history_count": len(request.seed_price_history),
            "seed_volume_history_count": len(request.seed_volume_history),
            "synthetic_snapshot": request.synthetic_snapshot if isinstance(request.synthetic_snapshot, dict) else {},
        }

        try:
            cycle = await self._run_cycle(
                snapshot_override=request.synthetic_snapshot if isinstance(request.synthetic_snapshot, dict) else None,
                allow_live_handoff=bool(request.allow_live_handoff),
                harness_input=harness_input,
            )
            return {"status": "ok", "cycle": cycle, "runtime": self.status()}
        finally:
            if request.isolate_runtime:
                self.symbol = original_symbol
                self.venue = original_venue
                self.cycle_seconds = original_cycle_seconds
                self.price_history = deque(original_prices, maxlen=original_prices.maxlen)
                self.volume_history = deque(original_volumes, maxlen=original_volumes.maxlen)

    async def _loop(self) -> None:
        while self.active:
            started = perf_counter()
            try:
                await self._run_cycle()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.last_error = str(exc)
            elapsed = perf_counter() - started
            sleep_seconds = max(0.25, self.cycle_seconds - elapsed)
            try:
                await asyncio.sleep(sleep_seconds)
            except asyncio.CancelledError:
                raise

    async def _run_cycle(
        self,
        *,
        snapshot_override: dict[str, Any] | None = None,
        allow_live_handoff: bool | None = None,
        harness_input: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        feature_flags = self.runtime_feature_flags()
        market_snapshot = snapshot_override if isinstance(snapshot_override, dict) else await self._fetch_market_snapshot()
        instrument_data = self._build_instrument_data(market_snapshot)
        predictor_payload = self._build_predictor_payload(instrument_data, market_snapshot)
        predictor = await self._post_json(f"{self.predictor_url}/predict", predictor_payload)
        autonomous_brain = predictor.get("autonomous_brain") if isinstance(predictor.get("autonomous_brain"), dict) else {}
        meta_policy = autonomous_brain.get("meta_policy") if isinstance(autonomous_brain.get("meta_policy"), dict) else {}
        governor = meta_policy.get("governor") if isinstance(meta_policy.get("governor"), dict) else {}
        action_shield = meta_policy.get("action_shield") if isinstance(meta_policy.get("action_shield"), dict) else {}
        strategy_switch = meta_policy.get("strategy_switch") if isinstance(meta_policy.get("strategy_switch"), dict) else {}
        failure_source = str(autonomous_brain.get("failure_source") or "").strip() or None
        memory_query_payload = self._build_memory_query_payload(instrument_data, market_snapshot, predictor, feature_flags)
        memory_query = await self._post_json(
            f"{self.predictor_url}/brain/memory-v2/query",
            memory_query_payload,
        )
        strategy_arena: dict[str, Any] = {
            "status": "disabled",
            "feature_flags": feature_flags,
            "selected": {},
            "candidates": [],
        }
        if feature_flags.get("kairos_strategy_arena", True):
            strategy_arena = await self._post_json(
                f"{self.predictor_url}/brain/strategy-arena",
                {
                    "state": memory_query_payload.get("state", {}),
                    "prediction": predictor,
                    "failure_source": failure_source,
                },
            )

        system = get_hf_system(self.symbol)
        decision = system.make_decision(instrument_data, _kairos_decision_constraints(self.symbol))
        decision_summary = {
            "decision_id": decision.decision_id,
            "timestamp": decision.timestamp,
            "direction": decision.direction.value,
            "meta_confidence": round(_safe_float(decision.meta_confidence), 6),
            "agent_consensus_pct": round(_safe_float(decision.agent_consensus_pct), 6),
            "risk_approved": bool(decision.risk_approved),
            "risk_reason": decision.risk_reason,
        }

        memory_recommendation = memory_query.get("recommendation") if isinstance(memory_query.get("recommendation"), dict) else {}
        memory_confidence = _safe_float(memory_query.get("confidence"), 0.0)
        causal_guard = memory_query.get("causal_guard") if isinstance(memory_query.get("causal_guard"), dict) else {}
        pre_trade_memory_gate = _build_pre_trade_memory_gate(memory_query, feature_flags)
        memory_guard = bool(pre_trade_memory_gate.get("block_execution"))
        arena_selected = strategy_arena.get("selected") if isinstance(strategy_arena.get("selected"), dict) else {}
        governor_blocked = feature_flags.get("meta_governor_global", True) and bool(governor.get("blocked"))
        shield_allows_execute = bool(action_shield.get("allow_execute", True))
        brain_action = str(autonomous_brain.get("action") or "hold").strip().lower()
        brain_should_execute = bool(autonomous_brain.get("should_execute"))
        decision_direction = str(decision.direction.value)
        brain_alignment = (
            (decision_direction == "long" and brain_action == "buy")
            or (decision_direction == "short" and brain_action == "sell")
        )

        predictor_should_execute = bool(predictor.get("should_execute"))
        shadow_reasons: list[str] = []
        shadow_reasons.extend(str(reason) for reason in predictor.get("reasons", []) if isinstance(reason, str))
        if not decision.risk_approved and decision.risk_reason:
            shadow_reasons.append(str(decision.risk_reason))
        if memory_guard:
            shadow_reasons.append("memory_guard_active")
        for reason in pre_trade_memory_gate.get("reasons", []):
            if isinstance(reason, str) and reason not in shadow_reasons:
                shadow_reasons.append(reason)
        if governor_blocked:
            shadow_reasons.extend(str(reason) for reason in governor.get("reasons", []) if isinstance(reason, str))
        if not shield_allows_execute:
            shadow_reasons.extend(str(reason) for reason in action_shield.get("reasons", []) if isinstance(reason, str))
        if decision_direction in {"long", "short"} and not brain_alignment:
            shadow_reasons.append("brain_action_mismatch")

        shadow_action = "skip"
        proposed_trade: dict[str, Any] | None = None
        sol_regime_block = _sol_momentum_gate(self.symbol, decision_direction, decision_summary["meta_confidence"], instrument_data)
        if sol_regime_block:
            shadow_reasons.append(sol_regime_block)

        if (
            decision_direction in {"long", "short"}
            and decision.risk_approved
            and predictor_should_execute
            and brain_should_execute
            and brain_alignment
            and shield_allows_execute
            and not governor_blocked
            and not memory_guard
            and not sol_regime_block
        ):
            shadow_action = "proposed"
            size_multiplier = min(
                _clamp(_safe_float(memory_recommendation.get("size_multiplier_cap"), 1.0), 0.1, 1.0),
                _clamp(_safe_float(governor.get("size_multiplier"), 1.0), 0.0, 1.0),
                _clamp(_safe_float(action_shield.get("size_multiplier_cap"), 1.0), 0.0, 1.0),
                _clamp(_safe_float(arena_selected.get("exposure_multiplier"), 1.0), 0.0, 1.0),
                _clamp(_safe_float(strategy_switch.get("size_multiplier_cap"), 1.0), 0.0, 1.0),
            )
            proposed_trade = {
                "side": decision_direction,
                "symbol": self.symbol,
                "venue": self.venue,
                "reference_price": instrument_data.get("price"),
                "confidence": decision_summary["meta_confidence"],
                "position_size_pct": round(min(15.0, decision.meta_confidence * 25.0) * size_multiplier, 4),
                "execution_style": arena_selected.get("execution_style") or strategy_switch.get("execution_style") or memory_recommendation.get("execution_style") or "default",
                "route_mode_override": arena_selected.get("route_mode_override") or strategy_switch.get("route_mode_override") or memory_recommendation.get("route_mode_override") or "bestSingleVenue",
                "max_spread_multiplier": min(
                    _clamp(_safe_float(memory_recommendation.get("max_spread_multiplier"), 1.0), 0.35, 1.0),
                    _clamp(_safe_float(action_shield.get("max_spread_multiplier_cap"), 1.0), 0.35, 1.0),
                    _clamp(_safe_float(strategy_switch.get("max_spread_multiplier"), 1.0), 0.35, 1.0),
                    _clamp(_safe_float(arena_selected.get("max_spread_multiplier"), 1.0), 0.35, 1.0),
                ),
                "governor_mode": governor.get("mode") or "idle",
            }
            self.proposed_total += 1
        else:
            self.skipped_total += 1

        self.cycles_total += 1
        self.last_cycle_at = datetime.now(timezone.utc).isoformat()
        execution_result = self._default_execution_result(feature_flags, proposed_trade, allow_live_handoff=allow_live_handoff)
        cycle = {
            "cycle_id": f"kairos-shadow-{int(datetime.now(timezone.utc).timestamp() * 1000)}-{uuid4().hex[:10]}",
            "cycle_at": self.last_cycle_at,
            "symbol": self.symbol,
            "venue": self.venue,
            "shadow_action": shadow_action,
            "shadow_reasons": shadow_reasons,
            "instrument_data": {
                "price": instrument_data.get("price"),
                "spread_bps": instrument_data.get("spread_bps"),
                "volume": instrument_data.get("volume"),
                "trend_strength": instrument_data.get("trend_strength"),
                "volatility": instrument_data.get("volatility"),
            },
            "decision": decision_summary,
            "predictor": {
                "should_execute": predictor_should_execute,
                "reasons": [str(reason) for reason in predictor.get("reasons", []) if isinstance(reason, str)],
                "model_should_execute": bool(predictor.get("model_should_execute")),
                "fill_probability": predictor.get("fill_probability"),
                "slippage_bps": predictor.get("slippage_bps"),
                "latency_ms": predictor.get("latency_ms"),
                "autonomous_brain": autonomous_brain,
            },
            "memory": {
                "source": memory_query.get("source"),
                "confidence": memory_confidence,
                "causal_guard": causal_guard,
                "recommendation": memory_recommendation,
                "pre_trade_gate": pre_trade_memory_gate,
                "query_payload": memory_query_payload,
                "raw_response": memory_query,
            },
            "pre_trade_memory_gate": pre_trade_memory_gate,
            "strategy_arena": strategy_arena,
            "meta_governor": governor,
            "action_shield": action_shield,
            "strategy_switch": strategy_switch,
            "feature_flags": feature_flags,
            "proposed_trade": proposed_trade,
            "execution": execution_result,
        }
        if harness_input:
            cycle["harness"] = harness_input
        live_handoff_enabled = (
            feature_flags.get("kairos_live", False)
            and _env_flag("KAIROS_LIVE_ROUTING_ENABLED", False)
            and (allow_live_handoff if allow_live_handoff is not None else True)
        )
        if proposed_trade and live_handoff_enabled:
            cycle["execution"] = await self._submit_control_plane_handoff(cycle)
        self.recent_cycles.append(cycle)
        _persist_kairos_shadow_cycle(cycle)
        return cycle

    async def _fetch_market_snapshot(self) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=12.0) as client:
            depth_response, micro_response, session_response = await asyncio.gather(
                client.get(
                    f"{self.market_data_url}/v1/market/orderbook/depth",
                    params={"instrument": self.symbol, "venue": self.venue},
                ),
                client.get(
                    f"{self.market_data_url}/v1/market/microstructure",
                    params={"instrument": self.symbol, "venue": self.venue, "lookback_minutes": self.lookback_minutes},
                ),
                client.get(
                    f"{self.market_data_url}/v1/market/session-state",
                    params={"instrument": self.symbol},
                ),
            )
        depth_response.raise_for_status()
        micro_response.raise_for_status()
        session_response.raise_for_status()
        return {
            "depth": depth_response.json(),
            "micro": micro_response.json(),
            "session": session_response.json(),
        }

    async def _post_json(self, url: str, payload: dict[str, Any]) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.post(url, json=payload)
        response.raise_for_status()
        body = response.json()
        return body if isinstance(body, dict) else {}

    def _default_execution_result(
        self,
        feature_flags: dict[str, bool],
        proposed_trade: dict[str, Any] | None,
        *,
        allow_live_handoff: bool | None = None,
    ) -> dict[str, Any]:
        if not proposed_trade:
            return {
                "requested": False,
                "submitted": False,
                "status": "no_trade",
                "platform_id": self.platform_id,
                "route_key": self.route_key,
            }
        if not feature_flags.get("kairos_live", False):
            return {
                "requested": False,
                "submitted": False,
                "status": "disabled_feature_flag",
                "platform_id": self.platform_id,
                "route_key": self.route_key,
            }
        if allow_live_handoff is False:
            return {
                "requested": False,
                "submitted": False,
                "status": "disabled_harness_live_handoff",
                "platform_id": self.platform_id,
                "route_key": self.route_key,
            }
        if not _env_flag("KAIROS_LIVE_ROUTING_ENABLED", False):
            return {
                "requested": False,
                "submitted": False,
                "status": "disabled_env_gate",
                "platform_id": self.platform_id,
                "route_key": self.route_key,
            }
        return {
            "requested": True,
            "submitted": False,
            "status": "pending",
            "platform_id": self.platform_id,
            "route_key": self.route_key,
        }

    async def _submit_control_plane_handoff(self, cycle: dict[str, Any]) -> dict[str, Any]:
        proposed_trade = cycle.get("proposed_trade") if isinstance(cycle.get("proposed_trade"), dict) else {}
        decision = cycle.get("decision") if isinstance(cycle.get("decision"), dict) else {}
        predictor = cycle.get("predictor") if isinstance(cycle.get("predictor"), dict) else {}
        memory = cycle.get("memory") if isinstance(cycle.get("memory"), dict) else {}
        feature_flags = cycle.get("feature_flags") if isinstance(cycle.get("feature_flags"), dict) else {}
        pre_trade_memory_gate = cycle.get("pre_trade_memory_gate") if isinstance(cycle.get("pre_trade_memory_gate"), dict) else _build_pre_trade_memory_gate(
            memory.get("raw_response") if isinstance(memory.get("raw_response"), dict) else {},
            feature_flags,
        )
        estimated_notional = _float_env("KAIROS_ESTIMATED_NOTIONAL_USD", 0.0)
        normalized_side = "buy" if str(proposed_trade.get("side") or "").strip().lower() == "long" else "sell"

        if bool(pre_trade_memory_gate.get("block_execution")):
            shadow_reasons = cycle.get("shadow_reasons") if isinstance(cycle.get("shadow_reasons"), list) else []
            if "memory_pretrade_gate_blocked" not in shadow_reasons:
                shadow_reasons.append("memory_pretrade_gate_blocked")
            cycle["shadow_reasons"] = shadow_reasons
            return {
                "requested": True,
                "submitted": False,
                "status": "blocked_memory_pretrade",
                "platform_id": self.platform_id,
                "route_key": self.route_key,
                "detail": {
                    "status": "blocked_memory_pretrade",
                    "memory_gate": pre_trade_memory_gate,
                },
            }

        payload: dict[str, Any] = {
            "route_key": self.route_key,
            "decision_id": str(decision.get("decision_id") or cycle.get("cycle_id") or f"kairos-{uuid4()}"),
            "symbol": str(proposed_trade.get("symbol") or self.symbol),
            "side": normalized_side,
            "metadata": {
                "source": "kairos-shadow-runtime",
                "cycle_id": cycle.get("cycle_id"),
                "confidence": proposed_trade.get("confidence"),
                "position_size_pct": proposed_trade.get("position_size_pct"),
                "execution_style": proposed_trade.get("execution_style"),
                "route_mode_override": proposed_trade.get("route_mode_override"),
                "governor_mode": proposed_trade.get("governor_mode"),
                "predictor_should_execute": predictor.get("should_execute"),
                "memory_confidence": memory.get("confidence"),
                "pre_trade_memory_gate": pre_trade_memory_gate,
            },
        }
        if isinstance(cycle.get("harness"), dict):
            payload["metadata"]["kairos_harness"] = cycle.get("harness")
        if estimated_notional > 0:
            payload["estimated_notional_usd"] = estimated_notional

        headers: dict[str, str] = {}
        webhook_secret = _secret("KAIROS_WEBHOOK_SECRET")
        if webhook_secret:
            headers["X-Platform-Secret"] = webhook_secret

        webhook_url = f"{self.control_plane_url}/v1/integrations/platforms/{self.platform_id}/webhook"
        try:
            async with httpx.AsyncClient(timeout=20.0) as client:
                response = await client.post(webhook_url, json=payload, headers=headers)
            try:
                body = response.json()
            except Exception:
                body = {"detail": response.text[:1000]}

            if response.status_code >= 400:
                detail = body.get("detail") if isinstance(body, dict) else body
                return {
                    "requested": True,
                    "submitted": False,
                    "status": "blocked" if response.status_code == 409 else "error",
                    "http_status": response.status_code,
                    "platform_id": self.platform_id,
                    "route_key": self.route_key,
                    "detail": detail,
                }

            return {
                "requested": True,
                "submitted": True,
                "status": "submitted",
                "http_status": response.status_code,
                "platform_id": self.platform_id,
                "route_key": self.route_key,
                "detail": body,
            }
        except Exception as exc:
            return {
                "requested": True,
                "submitted": False,
                "status": "error",
                "platform_id": self.platform_id,
                "route_key": self.route_key,
                "detail": str(exc),
            }

    def _build_instrument_data(self, snapshot: dict[str, Any]) -> dict[str, Any]:
        depth = snapshot.get("depth") if isinstance(snapshot.get("depth"), dict) else {}
        micro = snapshot.get("micro") if isinstance(snapshot.get("micro"), dict) else {}
        session = snapshot.get("session") if isinstance(snapshot.get("session"), dict) else {}

        best_bid = _safe_float(depth.get("best_bid"), 0.0)
        best_ask = _safe_float(depth.get("best_ask"), 0.0)
        mark_price = _safe_float(micro.get("mark_price"), 0.0)
        price = mark_price or ((best_bid + best_ask) / 2.0 if best_bid > 0 and best_ask > 0 else max(best_bid, best_ask, 0.0))

        buy_volume = _safe_float(micro.get("buy_volume"), 0.0)
        sell_volume = _safe_float(micro.get("sell_volume"), 0.0)
        volume = max(0.0, buy_volume + sell_volume)
        self.price_history.append(price)
        self.volume_history.append(volume)

        prices = [value for value in self.price_history if value > 0]
        volumes = [value for value in self.volume_history if value >= 0]
        sma_20 = self._average(prices[-20:]) or price
        sma_50 = self._average(prices[-50:]) or sma_20
        volume_avg = self._average(volumes[-30:]) or volume or 1.0
        hma_slope = self._slope(prices, window=5)
        momentum_roc = ((price / prices[-6]) - 1.0) if len(prices) >= 6 and prices[-6] > 0 else 0.0
        volatility = self._volatility(prices)
        rsi = self._rsi(prices)
        atr = self._atr(prices)
        vwap = self._weighted_average(prices[-20:], volumes[-20:]) or price
        rolling_high = max(prices[-50:] or [price])
        rolling_low = min(prices[-50:] or [price])
        depth_top10 = micro.get("depth_top10") if isinstance(micro.get("depth_top10"), dict) else {}
        bid_volume_top = _safe_float(depth_top10.get("bid"), buy_volume)
        ask_volume_top = _safe_float(depth_top10.get("ask"), sell_volume)
        volume_imbalance = _safe_float(micro.get("volume_imbalance"), 0.0)
        depth_imbalance = _safe_float(micro.get("depth_imbalance"), 0.0)
        trend_strength = _clamp(abs(hma_slope) * 120.0 + abs(volume_imbalance) * 0.35 + abs(depth_imbalance) * 0.3, 0.0, 1.0)
        chop_index = _clamp(100.0 - (trend_strength * 65.0) + min(20.0, volatility * 1800.0), 10.0, 90.0)
        distance_from_vwap = ((price - vwap) / max(vwap, 1e-9)) * 100.0 if vwap > 0 else 0.0
        exhaustion_score = _clamp(abs(distance_from_vwap) / 4.0 + max(0.0, 1.0 - abs(momentum_roc) * 40.0) * 0.25, 0.0, 1.0)
        fake_breakout_score = _clamp(abs(volume_imbalance - depth_imbalance), 0.0, 1.0)
        breakout_direction = None
        if price >= rolling_high * 0.999 and momentum_roc < 0:
            breakout_direction = "up"
        elif price <= rolling_low * 1.001 and momentum_roc > 0:
            breakout_direction = "down"
        recent_low_touches = 0
        if prices:
            recent_low = min(prices[-20:])
            recent_low_touches = sum(1 for value in prices[-20:] if abs(value - recent_low) / max(recent_low, 1e-9) <= 0.0015)

        return {
            "symbol": self.symbol,
            "price": price,
            "open": prices[0] if prices else price,
            "prev_close": prices[-2] if len(prices) >= 2 else price,
            "bid_volume": bid_volume_top,
            "ask_volume": ask_volume_top,
            "vwap": vwap,
            "sma_20": sma_20,
            "sma_50": sma_50,
            "hma_slope": hma_slope,
            "volume": volume,
            "avg_volume_30d": volume_avg,
            "rsi_14": rsi,
            "bb_upper": vwap + (2.0 * volatility * max(price, 1.0)),
            "bb_lower": vwap - (2.0 * volatility * max(price, 1.0)),
            "exhaustion_score": exhaustion_score,
            "atr": atr,
            "swing_high_50": rolling_high,
            "swing_low_50": rolling_low,
            "momentum_roc": momentum_roc,
            "volatility": volatility,
            "chop_index": chop_index,
            "adx": trend_strength * 40.0,
            "trend_strength": trend_strength,
            "recent_low_touches": recent_low_touches,
            "liquidity_trap_score": fake_breakout_score,
            "fake_breakout_score": fake_breakout_score,
            "last_breakout_direction": breakout_direction,
            "spread_bps": _safe_float(micro.get("spread_bps"), _safe_float(depth.get("spread_bps"), 0.0)),
            "market_session": str(session.get("session") or "off"),
            "depth_imbalance": depth_imbalance,
            "volume_imbalance": volume_imbalance,
        }

    def _build_predictor_payload(self, instrument_data: dict[str, Any], snapshot: dict[str, Any]) -> dict[str, Any]:
        micro = snapshot.get("micro") if isinstance(snapshot.get("micro"), dict) else {}
        available_depth_usd = (
            (_safe_float(micro.get("depth_top10", {}).get("bid"), 0.0) + _safe_float(micro.get("depth_top10", {}).get("ask"), 0.0))
            * max(_safe_float(instrument_data.get("price"), 0.0), 1.0)
        )
        book_flip_signal = _clamp(
            _safe_float(instrument_data.get("depth_imbalance"), 0.0) - _safe_float(instrument_data.get("volume_imbalance"), 0.0),
            -1.0,
            1.0,
        )
        fill_probability = _clamp(
            0.5 + (_safe_float(instrument_data.get("depth_imbalance"), 0.0) * 0.2) - (_safe_float(instrument_data.get("spread_bps"), 0.0) / 250.0),
            0.05,
            0.95,
        )
        return {
            "symbol": self.symbol,
            "venue": self.venue,
            "price": instrument_data.get("price"),
            "latency_ms": 25.0,
            "spread_bps": instrument_data.get("spread_bps"),
            "available_depth_usd": round(available_depth_usd, 6),
            "depth_imbalance": instrument_data.get("depth_imbalance"),
            "volume_30s": instrument_data.get("volume"),
            "volatility_bps": round(_safe_float(instrument_data.get("volatility"), 0.0) * 10000.0, 6),
            "fill_probability": round(fill_probability, 6),
            "backlog_pressure": 0.0,
            "render_pressure": 0.0,
            "quote_fade_rate": round(abs(_safe_float(instrument_data.get("volume_imbalance"), 0.0) - _safe_float(instrument_data.get("depth_imbalance"), 0.0)), 6),
            "book_flip_signal": round(book_flip_signal, 6),
            "trend_score": round((_safe_float(instrument_data.get("trend_strength"), 0.0) * 2.0 - 1.0), 6),
            "momentum": instrument_data.get("momentum_roc"),
            "network_regime": "stable",
            "market_session": instrument_data.get("market_session"),
            "route_mode": "bestSingleVenue",
            "v7_should_execute": True,
            "v7_reasons": [],
        }

    def _build_memory_query_payload(
        self,
        instrument_data: dict[str, Any],
        snapshot: dict[str, Any],
        predictor: dict[str, Any],
        feature_flags: dict[str, bool],
    ) -> dict[str, Any]:
        autonomous_brain = predictor.get("autonomous_brain") if isinstance(predictor.get("autonomous_brain"), dict) else {}
        regime = "BALANCED"
        if _safe_float(instrument_data.get("volatility"), 0.0) > 0.04:
            regime = "VOLATILE"
        elif _safe_float(instrument_data.get("trend_strength"), 0.0) > 0.6:
            regime = "TREND"
        elif _safe_float(instrument_data.get("chop_index"), 50.0) > 60.0:
            regime = "CHOP"
        liquidity_state = "balanced"
        if abs(_safe_float(instrument_data.get("depth_imbalance"), 0.0)) > 0.3:
            liquidity_state = "imbalanced"
        return {
            "causal_strict": bool(feature_flags.get("memory_v2_causal_strict", True)),
            "failure_source": autonomous_brain.get("failure_source"),
            "state": {
                "symbol": self.symbol,
                "venue": self.venue,
                "regime": regime,
                "market_session": instrument_data.get("market_session"),
                "network_regime": "stable",
                "liquidity_state": liquidity_state,
                "latency_ms": predictor.get("latency_ms", 25.0),
                "fill_probability": predictor.get("fill_probability", 0.0),
                "slippage_bps": predictor.get("slippage_bps", _safe_float(instrument_data.get("spread_bps"), 0.0) * 0.5),
                "spread_bps": instrument_data.get("spread_bps"),
                "depth_imbalance": instrument_data.get("depth_imbalance"),
                "backlog_pressure": 0.0,
                "render_pressure": 0.0,
                "book_flip": predictor.get("book_flip_signal", 0.0),
                "trend_score": predictor.get("trend_score", 0.0),
                "route_mode": predictor.get("route_mode") or "bestSingleVenue",
                "execution_style": autonomous_brain.get("meta_policy", {}).get("strategy_switch", {}).get("execution_style") if isinstance(autonomous_brain.get("meta_policy"), dict) else None,
            }
        }

    def _average(self, values: list[float]) -> float:
        return sum(values) / len(values) if values else 0.0

    def _weighted_average(self, prices: list[float], volumes: list[float]) -> float:
        usable = [(price, volume) for price, volume in zip(prices, volumes) if price > 0 and volume > 0]
        total_weight = sum(volume for _, volume in usable)
        if total_weight <= 0:
            return self._average([price for price, _ in usable]) if usable else 0.0
        return sum(price * volume for price, volume in usable) / total_weight

    def _slope(self, prices: list[float], window: int) -> float:
        if len(prices) < window * 2:
            return 0.0
        recent = self._average(prices[-window:])
        previous = self._average(prices[-window * 2:-window])
        if previous <= 0:
            return 0.0
        return (recent - previous) / previous

    def _volatility(self, prices: list[float]) -> float:
        if len(prices) < 3:
            return 0.0
        returns = []
        for left, right in zip(prices[:-1], prices[1:]):
            if left > 0 and right > 0:
                returns.append((right - left) / left)
        if len(returns) < 2:
            return 0.0
        avg = self._average(returns)
        variance = sum((value - avg) ** 2 for value in returns) / len(returns)
        return variance ** 0.5

    def _rsi(self, prices: list[float], period: int = 14) -> float:
        if len(prices) < 2:
            return 50.0
        deltas = [right - left for left, right in zip(prices[:-1], prices[1:])][-period:]
        if not deltas:
            return 50.0
        gains = sum(max(delta, 0.0) for delta in deltas)
        losses = sum(max(-delta, 0.0) for delta in deltas)
        if losses <= 0:
            return 100.0 if gains > 0 else 50.0
        rs = gains / losses
        return 100.0 - (100.0 / (1.0 + rs))

    def _atr(self, prices: list[float], period: int = 14) -> float:
        if len(prices) < 2:
            return 0.0
        ranges = [abs(right - left) for left, right in zip(prices[:-1], prices[1:])][-period:]
        return self._average(ranges)


KAIROS_SHADOW = KairosShadowRuntime()


@dataclass
class ModelConfig:
    name: str
    provider: str
    kind: str
    estimated_cost_usd: float
    model: str
    available: bool


@dataclass
class CircuitState:
    failures: int = 0
    opened_until: datetime | None = None


_CIRCUITS: dict[str, CircuitState] = {}


def _secret(name: str) -> str:
    direct = os.getenv(name, "").strip()
    if direct:
        return direct
    file_path = os.getenv(f"{name}_FILE", "").strip()
    if not file_path:
        return ""
    try:
        with open(file_path, "r", encoding="utf-8") as handle:
            return handle.read().strip()
    except Exception:
        return ""


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _timeout_s() -> float:
    return float(os.getenv("AI_TIMEOUT_SECONDS", "8"))


def _local_timeout_s() -> float:
    return float(os.getenv("AI_LOCAL_TIMEOUT_SECONDS", "90"))


def _max_retries() -> int:
    return int(os.getenv("AI_MAX_RETRIES", "0"))


def _cb_threshold() -> int:
    return int(os.getenv("AI_CB_FAILURE_THRESHOLD", "3"))


def _cb_reset_seconds() -> int:
    return int(os.getenv("AI_CB_RESET_SECONDS", "30"))


def _history_retention_days() -> int:
    return int(os.getenv("AI_HISTORY_RETENTION_DAYS", "30"))


def _detect_capacity() -> dict[str, Any]:
    cpus = os.cpu_count() or 1
    mem_gb = 0.0
    try:
        with open("/proc/meminfo", "r", encoding="utf-8") as handle:
            for line in handle:
                if line.startswith("MemTotal:"):
                    kb = int(line.split()[1])
                    mem_gb = kb / 1024 / 1024
                    break
    except Exception:
        mem_gb = 0.0
    has_gpu = bool(os.getenv("NVIDIA_VISIBLE_DEVICES", ""))
    return {
        "cpus": cpus,
        "memory_gb": round(mem_gb, 2),
        "has_gpu": has_gpu,
    }


def _recommended_open_source_models() -> dict[str, str]:
    cap = _detect_capacity()
    mem_gb = float(cap["memory_gb"])

    if mem_gb < 8:
        fast_model = "qwen2.5:3b-instruct"
        reasoning_model = "deepseek-r1:1.5b"
    elif mem_gb < 16:
        fast_model = "qwen2.5:7b-instruct"
        reasoning_model = "deepseek-r1:7b"
    else:
        fast_model = "qwen2.5:14b-instruct"
        reasoning_model = "deepseek-r1:14b"

    return {
        "fast": os.getenv("LOCAL_MODEL_FAST", fast_model),
        "reasoning": os.getenv("LOCAL_MODEL_REASONING", reasoning_model),
    }


def _ollama_endpoint_reachable() -> bool:
    endpoint = os.getenv("MISTRAL_LOCAL_URL", "").strip()
    if not endpoint:
        return False
    parsed = urlparse(endpoint)
    host = parsed.hostname
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    if not host:
        return False
    try:
        socket.getaddrinfo(host, port)
    except OSError:
        return False
    try:
        with socket.create_connection((host, port), timeout=0.6):
            pass
    except OSError:
        return False
    return True


def _config() -> dict[str, ModelConfig]:
    openai_available = bool(_secret("OPENAI_API_KEY"))
    claude_available = bool(_secret("ANTHROPIC_API_KEY"))
    deepseek_available = bool(_secret("DEEPSEEK_API_KEY"))
    mistral_available = bool(_secret("MISTRAL_API_KEY"))
    local_available = _ollama_endpoint_reachable()
    local_models = _recommended_open_source_models()

    return {
        "gpt-5": ModelConfig("gpt-5", "openai", "remote", 0.06, os.getenv("OPENAI_MODEL", "gpt-4.1-mini"), openai_available),
        "claude-4.6": ModelConfig("claude-4.6", "anthropic", "remote", 0.05, os.getenv("ANTHROPIC_MODEL", "claude-3-5-sonnet-latest"), claude_available),
        "deepseek-r1": ModelConfig("deepseek-r1", "deepseek", "remote", 0.01, os.getenv("DEEPSEEK_MODEL", "deepseek-reasoner"), deepseek_available),
        "mistral-large": ModelConfig("mistral-large", "mistral", "remote", 0.008, os.getenv("MISTRAL_MODEL", "mistral-large-latest"), mistral_available),
        "open-source-fast": ModelConfig("open-source-fast", "ollama", "local", 0.001, local_models["fast"], local_available),
        "open-source-reasoning": ModelConfig("open-source-reasoning", "ollama", "local", 0.0015, local_models["reasoning"], local_available),
    }


def _purge_old_history() -> None:
    db_execute(
        """
        DELETE FROM ai_orchestration_events
        WHERE created_at < NOW() - (%s || ' days')::interval
        """,
        (str(_history_retention_days()),),
    )


def _clear_old_history() -> int:
    return execute_rowcount(
        """
        DELETE FROM ai_orchestration_events
        WHERE created_at < NOW() - (%s || ' days')::interval
        """,
        (str(_history_retention_days()),),
    )


def _parse_iso_datetime(value: Any) -> datetime:
    try:
        return datetime.fromisoformat(str(value))
    except Exception:
        return _now_utc()


def _fetch_kairos_shadow_counts() -> dict[str, Any]:
    row = fetch_one(
        """
        SELECT
            COALESCE((SELECT COUNT(*) FROM kairos_shadow_cycles), 0) AS cycle_count,
            COALESCE((SELECT COUNT(*) FROM kairos_shadow_decisions), 0) AS decision_count,
            (SELECT MAX(cycle_at) FROM kairos_shadow_cycles) AS last_cycle_at,
            (SELECT MAX(decision_at) FROM kairos_shadow_decisions) AS last_decision_at
        """
    ) or {}
    return {
        "cycle_count": int(row.get("cycle_count") or 0),
        "decision_count": int(row.get("decision_count") or 0),
        "last_cycle_at": row.get("last_cycle_at").isoformat() if isinstance(row.get("last_cycle_at"), datetime) else row.get("last_cycle_at"),
        "last_decision_at": row.get("last_decision_at").isoformat() if isinstance(row.get("last_decision_at"), datetime) else row.get("last_decision_at"),
    }


def _fetch_kairos_shadow_cycles(limit: int) -> list[dict[str, Any]]:
    rows = fetch_all(
        """
        SELECT cycle_payload
        FROM kairos_shadow_cycles
        ORDER BY cycle_at DESC
        LIMIT %s
        """,
        (max(1, min(limit, 200)),),
    )
    items: list[dict[str, Any]] = []
    for row in rows:
        payload = row.get("cycle_payload") if isinstance(row.get("cycle_payload"), dict) else None
        if isinstance(payload, dict):
            items.append(payload)
    return items


def _fetch_kairos_shadow_decisions(limit: int) -> list[dict[str, Any]]:
    rows = fetch_all(
        """
        SELECT decision_payload
        FROM kairos_shadow_decisions
        ORDER BY decision_at DESC
        LIMIT %s
        """,
        (max(1, min(limit, 200)),),
    )
    items: list[dict[str, Any]] = []
    for row in rows:
        payload = row.get("decision_payload") if isinstance(row.get("decision_payload"), dict) else None
        if isinstance(payload, dict):
            items.append(payload)
    return items


def _persist_kairos_shadow_cycle(cycle: dict[str, Any]) -> None:
    decision = cycle.get("decision") if isinstance(cycle.get("decision"), dict) else {}
    predictor = cycle.get("predictor") if isinstance(cycle.get("predictor"), dict) else {}
    memory = cycle.get("memory") if isinstance(cycle.get("memory"), dict) else {}
    proposed_trade = cycle.get("proposed_trade") if isinstance(cycle.get("proposed_trade"), dict) else None
    cycle_id = str(cycle.get("cycle_id") or f"kairos-shadow-{uuid4().hex}").strip() or f"kairos-shadow-{uuid4().hex}"
    decision_id = str(decision.get("decision_id") or f"kairos-decision-{uuid4().hex}").strip() or f"kairos-decision-{uuid4().hex}"

    db_execute(
        """
        INSERT INTO kairos_shadow_cycles (
            cycle_id, cycle_at, symbol, venue, shadow_action, shadow_reasons,
            decision_id, decision_direction, predictor_should_execute,
            memory_source, memory_confidence, memory_recommendation,
            proposed_trade, cycle_payload
        ) VALUES (
            %s, %s, %s, %s, %s, %s::jsonb,
            %s, %s, %s,
            %s, %s, %s::jsonb,
            %s::jsonb, %s::jsonb
        )
        ON CONFLICT (cycle_id) DO UPDATE SET
            cycle_at = EXCLUDED.cycle_at,
            shadow_action = EXCLUDED.shadow_action,
            shadow_reasons = EXCLUDED.shadow_reasons,
            decision_id = EXCLUDED.decision_id,
            decision_direction = EXCLUDED.decision_direction,
            predictor_should_execute = EXCLUDED.predictor_should_execute,
            memory_source = EXCLUDED.memory_source,
            memory_confidence = EXCLUDED.memory_confidence,
            memory_recommendation = EXCLUDED.memory_recommendation,
            proposed_trade = EXCLUDED.proposed_trade,
            cycle_payload = EXCLUDED.cycle_payload
        """,
        (
            cycle_id,
            _parse_iso_datetime(cycle.get("cycle_at")),
            str(cycle.get("symbol") or ""),
            str(cycle.get("venue") or ""),
            str(cycle.get("shadow_action") or "skip"),
            json_dumps(cycle.get("shadow_reasons") if isinstance(cycle.get("shadow_reasons"), list) else []),
            decision_id,
            str(decision.get("direction") or "wait"),
            bool(predictor.get("should_execute")),
            str(memory.get("source") or "none"),
            _safe_float(memory.get("confidence"), 0.0),
            json_dumps(memory.get("recommendation") if isinstance(memory.get("recommendation"), dict) else {}),
            json_dumps(proposed_trade if isinstance(proposed_trade, dict) else None),
            json_dumps(cycle),
        ),
    )

    db_execute(
        """
        INSERT INTO kairos_shadow_decisions (
            decision_id, cycle_id, decision_at, symbol, venue, direction,
            meta_confidence, agent_consensus_pct, risk_approved, risk_reason,
            predictor_should_execute, memory_source, memory_confidence,
            recommended_execution, decision_payload
        ) VALUES (
            %s, %s, %s, %s, %s, %s,
            %s, %s, %s, %s,
            %s, %s, %s,
            %s::jsonb, %s::jsonb
        )
        ON CONFLICT (decision_id) DO UPDATE SET
            cycle_id = EXCLUDED.cycle_id,
            decision_at = EXCLUDED.decision_at,
            direction = EXCLUDED.direction,
            meta_confidence = EXCLUDED.meta_confidence,
            agent_consensus_pct = EXCLUDED.agent_consensus_pct,
            risk_approved = EXCLUDED.risk_approved,
            risk_reason = EXCLUDED.risk_reason,
            predictor_should_execute = EXCLUDED.predictor_should_execute,
            memory_source = EXCLUDED.memory_source,
            memory_confidence = EXCLUDED.memory_confidence,
            recommended_execution = EXCLUDED.recommended_execution,
            decision_payload = EXCLUDED.decision_payload
        """,
        (
            decision_id,
            cycle_id,
            _parse_iso_datetime(decision.get("timestamp") or cycle.get("cycle_at")),
            str(cycle.get("symbol") or ""),
            str(cycle.get("venue") or ""),
            str(decision.get("direction") or "wait"),
            _safe_float(decision.get("meta_confidence"), 0.0),
            _safe_float(decision.get("agent_consensus_pct"), 0.0),
            bool(decision.get("risk_approved")),
            str(decision.get("risk_reason") or ""),
            bool(predictor.get("should_execute")),
            str(memory.get("source") or "none"),
            _safe_float(memory.get("confidence"), 0.0),
            json_dumps(proposed_trade if isinstance(proposed_trade, dict) else None),
            json_dumps(
                {
                    "cycle_id": cycle_id,
                    "symbol": cycle.get("symbol"),
                    "venue": cycle.get("venue"),
                    "shadow_action": cycle.get("shadow_action"),
                    "decision": decision,
                    "predictor": predictor,
                    "memory": memory,
                    "proposed_trade": proposed_trade,
                    "shadow_reasons": cycle.get("shadow_reasons") if isinstance(cycle.get("shadow_reasons"), list) else [],
                }
            ),
        ),
    )


def _local_model_rows() -> list[dict[str, Any]]:
    cfg = _config()
    rows = fetch_all(
        """
        SELECT model_used, COUNT(*) AS calls, AVG(latency_ms)::INT AS avg_latency_ms,
               MAX(created_at) AS last_used_at,
               MAX(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS has_success
        FROM ai_orchestration_events
        WHERE provider_used = 'ollama'
        GROUP BY model_used
        """
    )
    metrics = {row["model_used"]: row for row in rows}
    result: list[dict[str, Any]] = []
    for route_name in ["open-source-fast", "open-source-reasoning"]:
        route = cfg[route_name]
        metric = metrics.get(route_name, {})
        result.append(
            {
                "route": route_name,
                "model": route.model,
                "available": route.available,
                "avg_latency_ms": metric.get("avg_latency_ms"),
                "calls": metric.get("calls", 0),
                "last_used_at": metric.get("last_used_at"),
                "has_success": bool(metric.get("has_success", 0)),
            }
        )
    return result


def _route(task: str, criticality: str, cost_limit_usd: float, prefer_local: bool) -> RouteDecision:
    cfg = _config()

    if prefer_local:
        primary = "open-source-reasoning" if cfg["open-source-reasoning"].available else "open-source-fast"
        fallback = "open-source-fast"
        return RouteDecision(
            primary_model=primary,
            fallback_model=fallback,
            primary_provider=cfg.get(primary, cfg["open-source-fast"]).provider,
            fallback_provider=cfg.get(fallback, cfg["open-source-fast"]).provider,
            reason="prefer_local_enabled",
            estimated_cost_usd=cfg.get(primary, cfg["open-source-fast"]).estimated_cost_usd,
        )

    if task == "strategy_creation":
        primary = "gpt-5" if cfg["gpt-5"].available else "open-source-reasoning"
        fallback = "open-source-fast" if primary == "gpt-5" else "open-source-fast"
    elif task == "feature_extraction":
        primary = "open-source-fast" if cfg["open-source-fast"].available else "deepseek-r1"
        fallback = "deepseek-r1" if cfg["deepseek-r1"].available else "open-source-reasoning"
    elif task == "backtest_analysis":
        primary = "deepseek-r1" if cfg["deepseek-r1"].available else "open-source-reasoning"
        fallback = "open-source-reasoning" if primary == "deepseek-r1" else "gpt-5"
    elif task == "post_trade_debug":
        primary = "deepseek-r1" if cfg["deepseek-r1"].available else "open-source-reasoning"
        fallback = "gpt-5" if cfg["gpt-5"].available else "open-source-fast"
    else:
        primary = "gpt-5" if criticality == "high" and cfg["gpt-5"].available else "open-source-fast"
        fallback = "open-source-reasoning"

    if cfg.get(primary) and cfg[primary].estimated_cost_usd > cost_limit_usd:
        primary = "open-source-fast" if cfg["open-source-fast"].available else "open-source-reasoning"
        fallback = "open-source-reasoning"
        reason = "cost_limit_enforced"
    else:
        reason = "task_based_routing"

    primary_cfg = cfg.get(primary, cfg["open-source-fast"])
    fallback_cfg = cfg.get(fallback, cfg["open-source-reasoning"])
    return RouteDecision(
        primary_model=primary,
        fallback_model=fallback,
        primary_provider=primary_cfg.provider,
        fallback_provider=fallback_cfg.provider,
        reason=reason,
        estimated_cost_usd=primary_cfg.estimated_cost_usd,
    )


def _circuit_for(provider: str) -> CircuitState:
    if provider not in _CIRCUITS:
        _CIRCUITS[provider] = CircuitState()
    return _CIRCUITS[provider]


def _is_circuit_open(provider: str) -> bool:
    state = _circuit_for(provider)
    return bool(state.opened_until and state.opened_until > _now_utc())


def _record_failure(provider: str) -> None:
    state = _circuit_for(provider)
    state.failures += 1
    if state.failures >= _cb_threshold():
        state.opened_until = _now_utc() + timedelta(seconds=_cb_reset_seconds())


def _record_success(provider: str) -> None:
    state = _circuit_for(provider)
    state.failures = 0
    state.opened_until = None


async def _call_openai(model: str, prompt: str) -> str:
    api_key = _secret("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("openai_key_missing")
    payload = {
        "model": model,
        "max_tokens": 450,
        "messages": [{"role": "user", "content": prompt}],
    }
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=_timeout_s()) as client:
        response = await client.post("https://api.openai.com/v1/chat/completions", headers=headers, json=payload)
        response.raise_for_status()
        data = response.json()
        return data["choices"][0]["message"]["content"]


async def _call_anthropic(model: str, prompt: str) -> str:
    api_key = _secret("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError("anthropic_key_missing")
    payload = {
        "model": model,
        "max_tokens": 700,
        "messages": [{"role": "user", "content": prompt}],
    }
    headers = {
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
    }
    async with httpx.AsyncClient(timeout=_timeout_s()) as client:
        response = await client.post("https://api.anthropic.com/v1/messages", headers=headers, json=payload)
        response.raise_for_status()
        data = response.json()
        chunks = [c.get("text", "") for c in data.get("content", []) if c.get("type") == "text"]
        return "".join(chunks).strip()


async def _call_deepseek(model: str, prompt: str) -> str:
    api_key = _secret("DEEPSEEK_API_KEY")
    if not api_key:
        raise RuntimeError("deepseek_key_missing")
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
    }
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=_timeout_s()) as client:
        response = await client.post("https://api.deepseek.com/v1/chat/completions", headers=headers, json=payload)
        response.raise_for_status()
        data = response.json()
        return data["choices"][0]["message"]["content"]


async def _call_mistral(model: str, prompt: str) -> str:
    api_key = _secret("MISTRAL_API_KEY")
    if not api_key:
        raise RuntimeError("mistral_key_missing")
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
    }
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=_timeout_s()) as client:
        response = await client.post("https://api.mistral.ai/v1/chat/completions", headers=headers, json=payload)
        response.raise_for_status()
        data = response.json()
        return data["choices"][0]["message"]["content"]


async def _call_ollama(model: str, prompt: str) -> str:
    base_url = os.getenv("MISTRAL_LOCAL_URL", "http://host.docker.internal:11434").rstrip("/")
    payload = {"model": model, "prompt": prompt, "stream": False}
    async with httpx.AsyncClient(timeout=_local_timeout_s()) as client:
        response = await client.post(f"{base_url}/api/generate", json=payload)
        response.raise_for_status()
        data = response.json()
        text = str(data.get("response", "")).strip()
        if not text:
            raise RuntimeError("ollama_empty_response")
        return text


async def _invoke_provider(provider: str, model: str, prompt: str) -> str:
    if provider == "openai":
        return await _call_openai(model, prompt)
    if provider == "anthropic":
        return await _call_anthropic(model, prompt)
    if provider == "deepseek":
        return await _call_deepseek(model, prompt)
    if provider == "mistral":
        return await _call_mistral(model, prompt)
    if provider == "ollama":
        return await _call_ollama(model, prompt)
    raise RuntimeError("unknown_provider")


async def _run_with_resilience(provider: str, model: str, prompt: str) -> tuple[str, int]:
    if _is_circuit_open(provider):
        raise RuntimeError("circuit_open")

    retries = _max_retries()
    last_error: Exception | None = None
    for attempt in range(retries + 1):
        try:
            text = await _invoke_provider(provider, model, prompt)
            _record_success(provider)
            return text, attempt
        except Exception as exc:
            last_error = exc
            _record_failure(provider)
            if attempt >= retries:
                break
            await asyncio.sleep(0.35 * (2**attempt))

    raise RuntimeError(f"provider_failed:{provider}:{type(last_error).__name__}")


@app.on_event("startup")
async def startup() -> None:
    ensure_schema()
    _purge_old_history()
    if _env_flag("KAIROS_SHADOW_ENABLED", False):
        await KAIROS_SHADOW.start()


@app.on_event("shutdown")
async def shutdown() -> None:
    await KAIROS_SHADOW.stop()


@app.get("/health")
async def health() -> dict:
    cfg = _config()
    return {
        "status": "ok",
        "service": "ai-orchestrator",
        "models": {
            name: {
                "available": item.available,
                "provider": item.provider,
                "kind": item.kind,
                "model": item.model,
            }
            for name, item in cfg.items()
        },
        "capacity": _detect_capacity(),
        "circuit_breakers": {
            name: {
                "failures": _circuit_for(name).failures,
                "open": _is_circuit_open(name),
                "opened_until": _circuit_for(name).opened_until.isoformat() if _circuit_for(name).opened_until else None,
            }
            for name in ["openai", "anthropic", "deepseek", "mistral", "ollama"]
        },
        "kairos_shadow": KAIROS_SHADOW.status(),
    }


@app.get("/v1/capacity")
async def capacity() -> dict:
    return {
        "capacity": _detect_capacity(),
        "recommended_open_source": _recommended_open_source_models(),
    }


@app.get("/v1/providers")
async def providers() -> dict:
    cfg = _config()
    return {
        "providers": [
            {
                "route": route_name,
                "provider": route.provider,
                "model": route.model,
                "kind": route.kind,
                "available": route.available,
                "estimated_cost_usd": route.estimated_cost_usd,
            }
            for route_name, route in cfg.items()
        ],
        "timeout_seconds": _timeout_s(),
        "max_retries": _max_retries(),
        "circuit_breaker": {
            "failure_threshold": _cb_threshold(),
            "reset_seconds": _cb_reset_seconds(),
        },
    }


@app.get("/v1/local-models/health")
async def local_models_health() -> dict:
    return {
        "endpoint": os.getenv("MISTRAL_LOCAL_URL", "http://host.docker.internal:11434"),
        "reachable": _ollama_endpoint_reachable(),
        "models": _local_model_rows(),
    }


@app.post("/v1/local-models/warmup")
async def warmup_local_models(request: WarmupRequest) -> dict:
    cfg = _config()
    targets = [request.model_key] if request.model_key else ["open-source-fast", "open-source-reasoning"]
    results: list[dict[str, Any]] = []

    for target in targets:
        if target not in {"open-source-fast", "open-source-reasoning"}:
            results.append({"route": target, "status": "invalid_model_key"})
            continue

        route = cfg[target]
        if not route.available:
            results.append({"route": target, "model": route.model, "status": "unavailable"})
            continue

        start = perf_counter()
        status = "ok"
        error_summary = None
        try:
            await _run_with_resilience(route.provider, route.model, "Warmup. Reply with OK only.")
        except Exception as exc:
            status = "error"
            error_summary = str(exc)
        latency_ms = int((perf_counter() - start) * 1000)

        db_execute(
            """
            INSERT INTO ai_orchestration_events (
                task, prompt_preview, criticality, route, provider_used, model_used,
                estimated_cost_usd, retries_used, fallback_used, latency_ms, status, error_summary
            ) VALUES (
                %s, %s, %s, %s::jsonb, %s, %s,
                %s, %s, %s, %s, %s, %s
            )
            """,
            (
                "warmup_local_model",
                f"Warmup {target}",
                "low",
                json_dumps({"primary_model": target, "fallback_model": target, "primary_provider": route.provider, "fallback_provider": route.provider, "reason": "warmup", "estimated_cost_usd": route.estimated_cost_usd}),
                route.provider if status == "ok" else "none",
                target if status == "ok" else "degraded-template",
                route.estimated_cost_usd,
                0,
                False,
                latency_ms,
                status,
                error_summary,
            ),
        )

        results.append(
            {
                "route": target,
                "model": route.model,
                "status": status,
                "latency_ms": latency_ms,
                "error_summary": error_summary,
            }
        )

    _purge_old_history()
    return {"results": results, "models": _local_model_rows()}


@app.post("/v1/history/clear-old")
async def clear_old_history() -> dict:
    deleted = _clear_old_history()
    return {"status": "ok", "deleted": deleted, "retention_days": _history_retention_days()}


@app.get("/v1/history")
async def history(limit: int = 30) -> list[dict[str, Any]]:
    safe_limit = max(1, min(limit, 200))
    return fetch_all(
        """
        SELECT id, task, prompt_preview, criticality, route, provider_used, model_used,
               estimated_cost_usd, retries_used, fallback_used, latency_ms,
               status, error_summary, created_at
        FROM ai_orchestration_events
        ORDER BY created_at DESC
        LIMIT %s
        """,
        (safe_limit,),
    )


@app.post("/v1/regimes/detect")
async def detect_market_regime(request: RegimeDetectRequest) -> dict[str, Any]:
    if request.realized_volatility > 0.06 and request.trend_score > 0.2:
        regime = "high_vol_trend"
    elif request.realized_volatility > 0.06:
        regime = "high_vol_range"
    elif request.trend_score > 0.35:
        regime = "trend"
    elif request.trend_score < -0.35:
        regime = "downtrend"
    else:
        regime = "range"

    recommendations = {
        "high_vol_trend": ["reduce_leverage", "favor_breakout", "wider_stops"],
        "high_vol_range": ["decrease_size", "mean_reversion_only", "tight_risk_limits"],
        "trend": ["enable_trend_robots", "disable_countertrend_scalping"],
        "downtrend": ["bias_short_setups", "hedge_beta_exposure"],
        "range": ["enable_scalping", "disable_breakout_strategies"],
    }
    return {
        "status": "ok",
        "regime": regime,
        "confidence": round(min(0.99, 0.55 + request.realized_volatility + abs(request.trend_score) * 0.2), 3),
        "recommendations": recommendations.get(regime, []),
    }


@app.post("/v1/backtests/geopolitical")
async def geopolitical_backtest(request: GeopoliticalBacktestRequest) -> dict[str, Any]:
    scenario = request.scenario.lower()
    scenario_penalty = 0.0
    if "fed" in scenario:
        scenario_penalty += 0.15
    if "war" in scenario or "conflict" in scenario:
        scenario_penalty += 0.22
    if "sanction" in scenario:
        scenario_penalty += 0.12

    base_score = 0.78
    resilience_score = max(0.05, round(base_score - scenario_penalty, 3))
    expected_drawdown = round(0.06 + scenario_penalty * 0.5, 3)

    return {
        "status": "ok",
        "strategy_name": request.strategy_name,
        "asset_class": request.asset_class,
        "scenario": request.scenario,
        "horizon_days": request.horizon_days,
        "resilience_score": resilience_score,
        "expected_max_drawdown": expected_drawdown,
        "actions": [
            "reduce_position_size_if_score_below_0_6",
            "enable_event_risk_kill_switch",
            "switch_to_capital_preservation_regime",
        ],
    }


@app.post("/v1/decision/score")
async def score_decision(request: DecisionScoreRequest) -> dict[str, Any]:
    score_global = (
        request.confidence * 0.3
        + request.consistency * 0.25
        + request.risk_alignment * 0.3
        + request.historical_match * 0.15
    )
    score_global = round(score_global, 4)
    return {
        "status": "ok",
        "score": {
            "confidence": request.confidence,
            "consistency": request.consistency,
            "risk_alignment": request.risk_alignment,
            "historical_match": request.historical_match,
            "score_global": score_global,
        },
        "threshold": request.threshold,
        "action": "execute" if score_global >= request.threshold else "human_required",
    }


@app.post("/v1/decision/vote")
async def vote_decision(request: MultiAgentVoteRequest) -> dict[str, Any]:
    if not request.votes:
        return {"status": "ok", "decision": "human_required", "reason": "no_votes"}

    counts: dict[str, int] = {}
    for decision in request.votes.values():
        key = str(decision).strip().lower()
        counts[key] = counts.get(key, 0) + 1

    winner = sorted(counts.items(), key=lambda item: item[1], reverse=True)[0][0]
    total = sum(counts.values())
    disagreement = 1.0 - (counts[winner] / total)

    return {
        "status": "ok",
        "winner": winner,
        "votes": request.votes,
        "distribution": counts,
        "disagreement": round(disagreement, 4),
        "decision": "human_required" if disagreement > request.disagreement_threshold else winner,
    }


@app.post("/v1/route", response_model=RouteDecision)
async def route_only(request: OrchestrateRequest) -> RouteDecision:
    return _route(request.task, request.criticality, request.cost_limit_usd, request.prefer_local)


@app.post("/v1/execute", response_model=OrchestrateResponse)
async def execute(request: OrchestrateRequest) -> OrchestrateResponse:
    route = _route(request.task, request.criticality, request.cost_limit_usd, request.prefer_local)
    cfg = _config()
    start = perf_counter()

    model_used = route.primary_model
    provider_used = route.primary_provider
    fallback_used = False
    retries_used = 0

    primary_cfg = cfg.get(route.primary_model)
    fallback_cfg = cfg.get(route.fallback_model)

    if not primary_cfg:
        raise RuntimeError("primary_route_missing")
    if not fallback_cfg:
        raise RuntimeError("fallback_route_missing")

    errors: list[str] = []
    output = ""
    if not primary_cfg.available:
        errors.append(f"primary_unavailable:{primary_cfg.provider}")
    else:
        try:
            output, retries_used = await _run_with_resilience(primary_cfg.provider, primary_cfg.model, request.prompt)
        except Exception as exc:
            errors.append(str(exc))

    if not output:
        model_used = route.fallback_model
        provider_used = route.fallback_provider
        fallback_used = True
        if fallback_cfg.available:
            try:
                output, retries_used = await _run_with_resilience(fallback_cfg.provider, fallback_cfg.model, request.prompt)
            except Exception as exc:
                errors.append(str(exc))
        else:
            errors.append(f"fallback_unavailable:{fallback_cfg.provider}")

    if not output:
        model_used = "degraded-template"
        provider_used = "none"
        fallback_used = True
        output = (
            "Degraded mode: no provider available. "
            "Check OPENAI/ANTHROPIC/DEEPSEEK/MISTRAL keys or run local Ollama. "
            f"task={request.task}; criticality={request.criticality}; errors={';'.join(errors)}"
        )

    latency_ms = int((perf_counter() - start) * 1000)
    response_payload = OrchestrateResponse(
        route=route,
        model_used=model_used,
        provider_used=provider_used,
        output=output,
        latency_ms=latency_ms,
        retries_used=retries_used,
        fallback_used=fallback_used,
    )
    db_execute(
        """
        INSERT INTO ai_orchestration_events (
            task, prompt_preview, criticality, route, provider_used, model_used,
            estimated_cost_usd, retries_used, fallback_used, latency_ms, status, error_summary
        ) VALUES (
            %s, %s, %s, %s::jsonb, %s, %s,
            %s, %s, %s, %s, %s, %s
        )
        """,
        (
            request.task,
            request.prompt[:280],
            request.criticality,
            json_dumps(route.model_dump()),
            response_payload.provider_used,
            response_payload.model_used,
            route.estimated_cost_usd,
            response_payload.retries_used,
            response_payload.fallback_used,
            response_payload.latency_ms,
            "ok" if response_payload.provider_used != "none" else "degraded",
            ";".join(errors) if errors else None,
        ),
    )
    _purge_old_history()
    return response_payload


@app.get("/v1/kairos/shadow/status")
async def kairos_shadow_status() -> dict[str, Any]:
    return KAIROS_SHADOW.status()


@app.post("/v1/kairos/shadow/start")
async def kairos_shadow_start(request: KairosShadowStartRequest) -> dict[str, Any]:
    await KAIROS_SHADOW.stop()
    KAIROS_SHADOW.reconfigure(request)
    await KAIROS_SHADOW.start()
    return KAIROS_SHADOW.status()


@app.post("/v1/kairos/shadow/stop")
async def kairos_shadow_stop() -> dict[str, Any]:
    await KAIROS_SHADOW.stop()
    return KAIROS_SHADOW.status()


@app.post("/v1/kairos/shadow/run-once")
async def kairos_shadow_run_once(request: KairosShadowStartRequest) -> dict[str, Any]:
    KAIROS_SHADOW.reconfigure(request)
    cycle = await KAIROS_SHADOW.run_once()
    return {"status": "ok", "cycle": cycle, "runtime": KAIROS_SHADOW.status()}


@app.post("/v1/kairos/shadow/harness/run-once")
async def kairos_shadow_harness_run_once(request: KairosShadowHarnessRequest) -> dict[str, Any]:
    return await KAIROS_SHADOW.run_harness_once(request)


@app.get("/v1/kairos/shadow/cycles")
async def kairos_shadow_cycles(limit: int = 20) -> dict[str, Any]:
    safe_limit = max(1, min(limit, 200))
    cycles = _fetch_kairos_shadow_cycles(safe_limit)
    if not cycles:
        fallback_limit = max(1, min(safe_limit, len(KAIROS_SHADOW.recent_cycles) or 1))
        cycles = list(KAIROS_SHADOW.recent_cycles)[-fallback_limit:]
    return {"status": "ok", "cycles": cycles, "runtime": KAIROS_SHADOW.status()}


@app.get("/v1/kairos/shadow/decisions")
async def kairos_shadow_decisions(limit: int = 20) -> dict[str, Any]:
    safe_limit = max(1, min(limit, 200))
    return {
        "status": "ok",
        "decisions": _fetch_kairos_shadow_decisions(safe_limit),
        "runtime": KAIROS_SHADOW.status(),
    }