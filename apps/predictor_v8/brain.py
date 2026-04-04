from __future__ import annotations

from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from enum import Enum
import math
from pathlib import Path
import random
from typing import Any

try:
    from shared.feature_flags import load_feature_flags
except ImportError:
    def load_feature_flags(path: str | Path | None, defaults: dict[str, bool] | None = None) -> dict[str, bool]:
        return dict(defaults or {})


try:
    from config import PREDICTOR_V8_CAUSAL_STRICT_MIN_CONFIDENCE, PREDICTOR_V8_SAFE_DREAM_MIN_REWARD
except ImportError:
    PREDICTOR_V8_CAUSAL_STRICT_MIN_CONFIDENCE = 0.34
    PREDICTOR_V8_SAFE_DREAM_MIN_REWARD = 0.25


def _to_float(value: Any, default: float = 0.0) -> float:
    try:
        numeric = float(value)
    except Exception:
        return default
    return numeric if math.isfinite(numeric) else default


def _clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def _sigmoid(value: float) -> float:
    if value >= 0:
        factor = math.exp(-value)
        return 1.0 / (1.0 + factor)
    factor = math.exp(value)
    return factor / (1.0 + factor)


def _average(values: list[float]) -> float:
    if not values:
        return 0.0
    return sum(values) / len(values)


def _pearson_correlation(xs: list[float], ys: list[float]) -> float:
    if len(xs) != len(ys) or len(xs) < 3:
        return 0.0
    mean_x = _average(xs)
    mean_y = _average(ys)
    centered = [(left - mean_x, right - mean_y) for left, right in zip(xs, ys)]
    numerator = sum(left * right for left, right in centered)
    denom_x = math.sqrt(sum(left * left for left, _ in centered))
    denom_y = math.sqrt(sum(right * right for _, right in centered))
    denominator = denom_x * denom_y
    if denominator <= 1e-9:
        return 0.0
    return _clamp(numerator / denominator, -1.0, 1.0)


FEATURE_FAMILIES = ("orderflow", "liquidity", "vwap", "regime")

AGENT_FAMILY_MAP: dict[str, tuple[str, ...]] = {
    "scalper": ("orderflow",),
    "trend": ("vwap", "regime"),
    "liquidity": ("liquidity",),
    "execution": ("liquidity", "orderflow"),
    "risk": ("regime",),
}

FAILURE_SOURCE_AGENT_LR_MAP: dict[str, dict[str, float]] = {
    "infra": {
        "scalper": 0.42,
        "trend": 0.38,
        "liquidity": 0.74,
        "execution": 0.9,
        "risk": 1.0,
    },
    "market": {
        "scalper": 1.16,
        "trend": 1.18,
        "liquidity": 0.98,
        "execution": 0.94,
        "risk": 1.0,
    },
    "execution": {
        "scalper": 0.88,
        "trend": 0.84,
        "liquidity": 1.04,
        "execution": 1.18,
        "risk": 1.0,
    },
}

DEFAULT_RUNTIME_FEATURE_FLAGS: dict[str, bool] = {
    "kairos_live": False,
    "kairos_strategy_arena": True,
    "memory_v2_causal_strict": True,
    "auto_dream_safe_mode": True,
    "meta_governor_global": True,
    "execution_learning_required": True,
}

LATENT_FEATURE_NAMES = (
    "latent_trend",
    "latent_reversion",
    "latent_stress",
    "latent_friction",
    "latent_persistence",
    "latent_volatility",
)


def _sign(value: float, tolerance: float = 1e-9) -> int:
    if value > tolerance:
        return 1
    if value < -tolerance:
        return -1
    return 0


def _timestamp_ms_from_value(value: Any) -> int:
    if value is None:
        return 0
    if isinstance(value, (int, float)):
        numeric = float(value)
        if not math.isfinite(numeric) or numeric <= 0:
            return 0
        return int(numeric if numeric >= 1e12 else numeric * 1000)
    if isinstance(value, str):
        candidate = value.strip()
        if not candidate:
            return 0
        if candidate.isdigit():
            return _timestamp_ms_from_value(int(candidate))
        try:
            return int(datetime.fromisoformat(candidate.replace("Z", "+00:00")).timestamp() * 1000)
        except Exception:
            return 0
    return 0


def _resolve_timestamp_ms(payload: dict[str, Any] | None) -> int:
    if isinstance(payload, dict):
        for key in ("timestamp_ms", "ts_ms", "timestamp", "ts", "created_at", "closed_at", "updated_at", "decision_ts"):
            resolved = _timestamp_ms_from_value(payload.get(key))
            if resolved > 0:
                return resolved
    return int(datetime.now(tz=timezone.utc).timestamp() * 1000)


def _market_session_from_timestamp(timestamp_ms: int) -> str:
    resolved = timestamp_ms if timestamp_ms > 0 else int(datetime.now(tz=timezone.utc).timestamp() * 1000)
    hour = datetime.fromtimestamp(resolved / 1000.0, tz=timezone.utc).hour
    if 0 <= hour < 8:
        return "asia"
    if 8 <= hour < 13:
        return "london"
    if 13 <= hour < 21:
        return "new-york"
    return "off"


def _volatility_bucket(volatility: float) -> str:
    if volatility >= 25.0:
        return "extreme"
    if volatility >= 15.0:
        return "high"
    if volatility >= 7.5:
        return "medium"
    return "low"


def _spread_bucket(spread: float) -> str:
    if spread >= 12.0:
        return "stressed"
    if spread >= 6.0:
        return "wide"
    if spread >= 2.0:
        return "normal"
    return "tight"


def _normalize_network_regime(value: Any) -> str:
    normalized = str(value or "").strip().lower()
    if normalized in {"stable", "degraded", "critical"}:
        return normalized
    return "stable"


def _infer_infra_health(payload: dict[str, Any], network_metrics: dict[str, Any]) -> float:
    explicit = _to_float(payload.get("infra_health"), math.nan)
    if math.isfinite(explicit):
        return _clamp(explicit, 0.05, 1.0)
    dns_transient_rate = _to_float(network_metrics.get("dns_transient_rate"), _to_float(payload.get("dns_transient_rate"), 0.0))
    timeout_rate = _to_float(network_metrics.get("timeout_rate"), _to_float(payload.get("timeout_rate"), 0.0))
    degraded_usage_ratio = _to_float(network_metrics.get("degraded_usage_ratio"), _to_float(payload.get("degraded_usage_ratio"), 0.0))
    retry_recovered_ratio = _to_float(network_metrics.get("retry_recovered_ratio"), _to_float(payload.get("retry_recovered_ratio"), 0.0))
    return _clamp(
        1.0
        - min(dns_transient_rate * 1.15, 0.28)
        - min(timeout_rate * 1.45, 0.34)
        - min(degraded_usage_ratio * 1.9, 0.5)
        - min(retry_recovered_ratio * 0.45, 0.12),
        0.05,
        1.0,
    )


def _normalize_reason_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    reasons: list[str] = []
    for item in value:
        candidate = str(item or "").strip()
        if candidate:
            reasons.append(candidate)
    return reasons


def _classify_reason_source(reason: str) -> str:
    normalized = str(reason or "").strip().lower()
    if not normalized:
        return "market"
    if any(token in normalized for token in ("dns", "timeout", "network", "infra", "renderable", "render_", "latency_guard", "kernel_backlog", "retry", "degraded", "critical")):
        return "infra"
    if any(token in normalized for token in ("slippage", "fill_", "spread", "route", "execution", "brain_action_mismatch")):
        return "execution"
    return "market"


def _build_failure_attribution(
    state: "MarketState",
    prediction: dict[str, Any],
    action: "Action",
    should_execute: bool,
    reliable: bool,
    calibrated_confidence: float,
    execute_threshold: float,
    consensus: float,
) -> dict[str, Any]:
    source_scores = {"market": 0.0, "infra": 0.0, "execution": 0.0}
    reasons_by_source: dict[str, list[str]] = {"market": [], "infra": [], "execution": []}

    def add(source: str, reason: str, weight: float) -> None:
        normalized_reason = str(reason or "").strip()
        if normalized_reason and normalized_reason not in reasons_by_source[source]:
            reasons_by_source[source].append(normalized_reason)
        source_scores[source] += weight

    if state.network_regime == "critical":
        add("infra", "network_regime_critical", 0.9)
    elif state.network_regime == "degraded":
        add("infra", "network_regime_degraded", 0.45)
    if state.infra_health <= 0.35:
        add("infra", "infra_health_low", 0.7)
    elif state.infra_health <= 0.62:
        add("infra", "infra_health_degraded", 0.35)
    if state.timeout_rate >= 0.08:
        add("infra", "timeout_rate_elevated", 0.35)
    if state.dns_transient_rate >= 0.08:
        add("infra", "dns_transient_rate_elevated", 0.3)
    if state.degraded_usage_ratio >= 0.15:
        add("infra", "degraded_usage_ratio_high", 0.25)
    if state.backlog >= 1.0:
        add("infra", "backlog_pressure_high", 0.2)

    if state.latency >= 250.0:
        add("execution", "latency_above_250ms", 0.3)
    elif state.latency >= 180.0:
        add("execution", "latency_above_180ms", 0.18)
    if state.spread >= 12.0:
        add("execution", "spread_above_12bps", 0.35)
    elif state.spread >= 8.0:
        add("execution", "spread_above_8bps", 0.18)
    if state.fill_probability > 0.0 and state.fill_probability <= 0.42:
        add("execution", "fill_probability_low", 0.35)
    if state.slippage >= 10.0:
        add("execution", "slippage_above_10bps", 0.3)
    if state.depth <= 15000.0:
        add("execution", "available_depth_thin", 0.18)

    if action == Action.HOLD:
        add("market", "signal_hold", 0.35)
    if calibrated_confidence < execute_threshold:
        add("market", "confidence_below_execute_threshold", 0.42)
    if consensus < 0.52:
        add("market", "weak_agent_consensus", 0.22)
    if abs(state.edge) <= 1.0:
        add("market", "edge_low", 0.18)
    if state.volume <= 0.0:
        add("market", "missing_volume", 0.22)
    if state.regime == "CHOP":
        add("market", "market_regime_chop", 0.12)

    for reason in _normalize_reason_list(prediction.get("reasons")):
        add(_classify_reason_source(reason), reason, 0.2)

    if action in {Action.BUY, Action.SELL} and prediction.get("model_should_execute") is False:
        if prediction.get("reasons"):
            for reason in _normalize_reason_list(prediction.get("reasons")):
                add(_classify_reason_source(reason), reason, 0.15)
        else:
            add("market", "predictor_model_blocked", 0.2)

    dominant_source = max(source_scores, key=source_scores.get)
    dominant_score = source_scores[dominant_source]
    blocking = not should_execute
    if not blocking and dominant_score < 0.65:
        return {
            "failure_source": None,
            "failure_reasons": [],
            "failure_blocking": False,
        }
    if dominant_score <= 0.0:
        return {
            "failure_source": None,
            "failure_reasons": [],
            "failure_blocking": False,
        }
    return {
        "failure_source": dominant_source,
        "failure_reasons": reasons_by_source[dominant_source],
        "failure_blocking": blocking,
    }


def _normalize_failure_source(value: Any) -> str | None:
    normalized = str(value or "").strip().lower()
    if normalized in {"market", "infra", "execution"}:
        return normalized
    return None


def _coerce_failure_blocking(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    normalized = str(value or "").strip().lower()
    return normalized in {"1", "true", "yes", "on"}


def _apply_failure_reward_adjustment(
    raw_reward: float,
    failure_source: str | None,
    failure_blocking: bool,
    state: "MarketState",
    next_state: "MarketState",
) -> tuple[float, float]:
    if raw_reward >= 0 or failure_source != "infra":
        return raw_reward, 1.0

    infra_health = _clamp((state.infra_health + next_state.infra_health) / 2.0, 0.05, 1.0)
    network_regime = next_state.network_regime if next_state.network_regime != "stable" else state.network_regime
    scale = 0.62
    scale -= min(0.18, (1.0 - infra_health) * 0.24)
    if network_regime == "critical":
        scale -= 0.12
    elif network_regime == "degraded":
        scale -= 0.05
    if failure_blocking:
        scale -= 0.06
    scale = _clamp(scale, 0.18, 0.72)
    return raw_reward * scale, scale


def _failure_learning_rate_severity(experience: "Experience") -> float:
    if experience.failure_source is None:
        return 0.0
    if experience.raw_reward >= 0 and experience.reward >= 0:
        return 0.0
    severity = 0.26
    if experience.failure_blocking:
        severity += 0.18
    severity += min(0.12, len(experience.failure_reasons) * 0.03)
    reward_compression = _clamp(1.0 - _clamp(experience.reward_scale, 0.05, 1.0), 0.0, 0.95)
    severity += reward_compression * 0.62
    return _clamp(severity, 0.0, 1.0)


def _agent_failure_learning_rate_multiplier(
    agent_name: str,
    experience: "Experience",
    calibrator: "FailureSourceLearningRateCalibrator | None" = None,
) -> float:
    failure_source = _normalize_failure_source(experience.failure_source)
    if failure_source is None:
        return 1.0
    if calibrator is not None:
        calibrated = calibrator.multiplier_for_experience(agent_name, experience)
        if calibrated is not None:
            return calibrated
    source_map = FAILURE_SOURCE_AGENT_LR_MAP.get(failure_source)
    if source_map is None:
        return 1.0
    target_multiplier = _to_float(source_map.get(agent_name), 1.0)
    severity = _failure_learning_rate_severity(experience)
    multiplier = 1.0 + (target_multiplier - 1.0) * severity
    if failure_source == "infra" and not experience.failure_blocking and agent_name in {"scalper", "trend"}:
        multiplier += 0.06 * (1.0 - severity)
    elif failure_source == "execution" and experience.failure_blocking and agent_name == "execution":
        multiplier += 0.04
    elif failure_source == "market" and experience.reward < 0 and agent_name in {"scalper", "trend"}:
        multiplier += 0.04
    return _clamp(multiplier, 0.42, 1.22)


def _feature_learning_rate_multiplier_for_agent(
    agent_name: str,
    experience: "Experience",
    feature_tracker: "FeatureAttributionTracker | None",
) -> float:
    if feature_tracker is None:
        return 1.0
    families = AGENT_FAMILY_MAP.get(agent_name, ())
    if not families:
        return 1.0
    return _clamp(
        _average([feature_tracker.learning_rate_multiplier(family, experience) for family in families]),
        0.55,
        1.65,
    )


def _default_strategy_mode_for_context(state: "MarketState", failure_source: str | None) -> str:
    normalized_source = _normalize_failure_source(failure_source)
    if normalized_source == "infra" or state.network_regime != "stable":
        return "risk_off"
    if normalized_source == "execution":
        return "execution_protect"
    if normalized_source == "market":
        return "market_selective"
    if state.regime == "TREND":
        return "trend_follow"
    if state.regime == "CHOP":
        return "mean_reversion"
    return "balanced"


def _policy_memory_context_key(state: "MarketState", failure_source: str | None) -> str:
    normalized_source = _normalize_failure_source(failure_source) or "none"
    regime = str(state.regime or "NEUTRAL").strip().upper() or "NEUTRAL"
    session = str(state.market_session or "off").strip().lower() or "off"
    network = str(state.network_regime or "stable").strip().lower() or "stable"
    latent = str(state.latent_label or "uninitialized").strip().lower() or "uninitialized"
    return f"regime={regime}|session={session}|network={network}|latent={latent}|failure={normalized_source}"


class PolicyMemory:
    def __init__(self) -> None:
        self.records: dict[str, dict[str, Any]] = {}

    def remember_experience(self, experience: "Experience") -> None:
        if experience.synthetic:
            return
        failure_source = _normalize_failure_source(experience.failure_source)
        context_key = _policy_memory_context_key(experience.state, failure_source)
        bucket = self.records.setdefault(
            context_key,
            {
                "context_key": context_key,
                "regime": experience.state.regime,
                "market_session": experience.state.market_session,
                "network_regime": experience.state.network_regime,
                "latent_label": experience.state.latent_label,
                "failure_source": failure_source,
                "sample_count": 0,
                "win_count": 0,
                "cumulative_reward": 0.0,
                "avg_reward": 0.0,
                "best_reward": -1e9,
                "best_policy": {},
                "updated_at": datetime.now(tz=timezone.utc).isoformat(),
            },
        )
        strategy_mode = str(
            experience.context.get("strategy_mode")
            or experience.context.get("strategy_switch_mode")
            or _default_strategy_mode_for_context(experience.state, failure_source)
        ).strip() or _default_strategy_mode_for_context(experience.state, failure_source)
        route_mode_override = str(
            experience.context.get("route_mode_override")
            or experience.context.get("route_mode")
            or ("bestSingleVenue" if strategy_mode in {"risk_off", "execution_protect", "market_selective"} else "bestSingleVenue")
        ).strip() or "bestSingleVenue"
        execution_style = str(experience.context.get("execution_style") or ("primary_only" if strategy_mode == "risk_off" else "default")).strip() or "default"
        max_spread_multiplier = _clamp(
            _to_float(experience.context.get("max_spread_multiplier"), 0.72 if strategy_mode == "risk_off" else 0.82 if strategy_mode == "execution_protect" else 0.88 if strategy_mode == "market_selective" else 1.0),
            0.35,
            1.0,
        )
        size_multiplier = _clamp(_to_float(experience.context.get("size_multiplier"), 1.0), 0.0, 1.0)
        bucket["sample_count"] += 1
        if experience.reward > 0:
            bucket["win_count"] += 1
        bucket["cumulative_reward"] += experience.reward
        bucket["avg_reward"] = round(_to_float(bucket.get("cumulative_reward"), 0.0) / max(1, int(bucket.get("sample_count") or 0)), 6)
        bucket["updated_at"] = datetime.now(tz=timezone.utc).isoformat()
        if experience.reward >= _to_float(bucket.get("best_reward"), -1e9):
            bucket["best_reward"] = round(experience.reward, 6)
            bucket["best_policy"] = {
                "strategy_mode": strategy_mode,
                "route_mode_override": route_mode_override,
                "execution_style": execution_style,
                "max_spread_multiplier": round(max_spread_multiplier, 6),
                "size_multiplier": round(size_multiplier, 6),
            }

    def resolve(self, state: "MarketState", failure_source: str | None) -> dict[str, Any] | None:
        keys = [_policy_memory_context_key(state, failure_source)]
        if _normalize_failure_source(failure_source) is not None:
            keys.append(_policy_memory_context_key(state, None))
        for key in keys:
            bucket = self.records.get(key)
            if not isinstance(bucket, dict):
                continue
            sample_count = max(0, int(bucket.get("sample_count") or 0))
            avg_reward = _to_float(bucket.get("avg_reward"), 0.0)
            if sample_count < 2 or avg_reward <= 0.0:
                continue
            confidence = _clamp((sample_count / 8.0) * _clamp((avg_reward + 10.0) / 20.0, 0.0, 1.0), 0.0, 0.85)
            return {
                **bucket,
                "confidence": round(confidence, 6),
                "win_rate": round(max(0.0, int(bucket.get("win_count") or 0)) / max(1, sample_count), 6),
            }
        return None

    def summary(self) -> dict[str, Any]:
        top_contexts = sorted(
            (bucket for bucket in self.records.values() if isinstance(bucket, dict)),
            key=lambda bucket: (_to_float(bucket.get("avg_reward"), 0.0), int(bucket.get("sample_count") or 0)),
            reverse=True,
        )[:6]
        return {
            "context_count": len(self.records),
            "top_contexts": [
                {
                    "context_key": str(bucket.get("context_key") or ""),
                    "regime": str(bucket.get("regime") or "NEUTRAL"),
                    "market_session": str(bucket.get("market_session") or "off"),
                    "network_regime": str(bucket.get("network_regime") or "stable"),
                    "failure_source": bucket.get("failure_source"),
                    "sample_count": int(bucket.get("sample_count") or 0),
                    "avg_reward": round(_to_float(bucket.get("avg_reward"), 0.0), 6),
                    "best_policy": bucket.get("best_policy") if isinstance(bucket.get("best_policy"), dict) else {},
                    "updated_at": bucket.get("updated_at"),
                }
                for bucket in top_contexts
            ],
        }

    def to_dict(self) -> dict[str, Any]:
        return {
            "records": self.records,
        }

    def load(self, payload: dict[str, Any]) -> None:
        raw_records = payload.get("records") if isinstance(payload.get("records"), dict) else {}
        self.records = {
            str(key): value
            for key, value in raw_records.items()
            if isinstance(value, dict)
        }


def _strategic_memory_context_key(state: "MarketState") -> str:
    regime = str(state.regime or "NEUTRAL").strip().upper() or "NEUTRAL"
    session = str(state.market_session or "off").strip().lower() or "off"
    network = str(state.network_regime or "stable").strip().lower() or "stable"
    liquidity_state = str(state.liquidity_state or "balanced").strip().lower() or "balanced"
    return (
        f"regime={regime}|vol={_volatility_bucket(state.volatility)}|spread={_spread_bucket(state.spread)}"
        f"|session={session}|network={network}|liquidity={liquidity_state}"
    )


class StrategicMemory:
    def __init__(self) -> None:
        self.records: dict[str, dict[str, Any]] = {}

    def remember_experience(self, experience: "Experience") -> None:
        if experience.synthetic:
            return
        profile_id = str(
            experience.context.get("meta_profile_id")
            or experience.context.get("strategy_profile_id")
            or experience.context.get("strategy_mode")
            or ""
        ).strip()
        if not profile_id:
            return
        context_key = _strategic_memory_context_key(experience.state)
        bucket = self.records.setdefault(
            context_key,
            {
                "context_key": context_key,
                "regime": experience.state.regime,
                "market_session": experience.state.market_session,
                "network_regime": experience.state.network_regime,
                "liquidity_state": experience.state.liquidity_state,
                "sample_count": 0,
                "strategies": {},
                "best_strategy": "",
                "updated_at": datetime.now(tz=timezone.utc).isoformat(),
            },
        )
        strategies = bucket.setdefault("strategies", {})
        strategy_bucket = strategies.setdefault(
            profile_id,
            {
                "profile_id": profile_id,
                "sample_count": 0,
                "win_count": 0,
                "cumulative_reward": 0.0,
                "avg_reward": 0.0,
                "last_reward": 0.0,
                "updated_at": datetime.now(tz=timezone.utc).isoformat(),
            },
        )
        strategy_bucket["sample_count"] = max(0, int(strategy_bucket.get("sample_count") or 0)) + 1
        if experience.reward > 0:
            strategy_bucket["win_count"] = max(0, int(strategy_bucket.get("win_count") or 0)) + 1
        strategy_bucket["cumulative_reward"] = _to_float(strategy_bucket.get("cumulative_reward"), 0.0) + experience.reward
        strategy_bucket["avg_reward"] = round(
            _to_float(strategy_bucket.get("cumulative_reward"), 0.0) / max(1, int(strategy_bucket.get("sample_count") or 0)),
            6,
        )
        strategy_bucket["last_reward"] = round(experience.reward, 6)
        strategy_bucket["updated_at"] = datetime.now(tz=timezone.utc).isoformat()
        bucket["sample_count"] = max(0, int(bucket.get("sample_count") or 0)) + 1
        bucket["updated_at"] = datetime.now(tz=timezone.utc).isoformat()
        best_profile_id = ""
        best_score = -1e9
        for candidate_id, candidate_bucket in strategies.items():
            if not isinstance(candidate_bucket, dict):
                continue
            candidate_avg = _to_float(candidate_bucket.get("avg_reward"), 0.0)
            candidate_samples = max(0, int(candidate_bucket.get("sample_count") or 0))
            candidate_score = candidate_avg * min(1.0, 0.4 + candidate_samples / 6.0)
            if candidate_score >= best_score:
                best_score = candidate_score
                best_profile_id = str(candidate_id)
        bucket["best_strategy"] = best_profile_id

    def resolve(self, state: "MarketState") -> dict[str, Any] | None:
        bucket = self.records.get(_strategic_memory_context_key(state))
        if not isinstance(bucket, dict):
            return None
        best_profile_id = str(bucket.get("best_strategy") or "").strip()
        strategies = bucket.get("strategies") if isinstance(bucket.get("strategies"), dict) else {}
        best_bucket = strategies.get(best_profile_id) if best_profile_id else None
        if not isinstance(best_bucket, dict):
            return None
        sample_count = max(0, int(best_bucket.get("sample_count") or 0))
        avg_reward = _to_float(best_bucket.get("avg_reward"), 0.0)
        if sample_count < 3 or avg_reward <= 0.0:
            return None
        confidence = _clamp((sample_count / 10.0) * _clamp((avg_reward + 12.0) / 24.0, 0.0, 1.0), 0.0, 0.9)
        return {
            "context_key": str(bucket.get("context_key") or ""),
            "best_strategy": best_profile_id,
            "sample_count": sample_count,
            "avg_reward": round(avg_reward, 6),
            "win_rate": round(max(0.0, int(best_bucket.get("win_count") or 0)) / max(1, sample_count), 6),
            "confidence": round(confidence, 6),
        }

    def summary(self) -> dict[str, Any]:
        top_contexts = sorted(
            (bucket for bucket in self.records.values() if isinstance(bucket, dict)),
            key=lambda bucket: max(
                [_to_float(candidate.get("avg_reward"), 0.0) for candidate in (bucket.get("strategies") or {}).values() if isinstance(candidate, dict)] or [0.0]
            ),
            reverse=True,
        )[:6]
        rows: list[dict[str, Any]] = []
        for bucket in top_contexts:
            strategies = bucket.get("strategies") if isinstance(bucket.get("strategies"), dict) else {}
            best_profile_id = str(bucket.get("best_strategy") or "").strip()
            best_bucket = strategies.get(best_profile_id) if best_profile_id else None
            if not isinstance(best_bucket, dict):
                continue
            rows.append(
                {
                    "context_key": str(bucket.get("context_key") or ""),
                    "best_strategy": best_profile_id,
                    "sample_count": int(best_bucket.get("sample_count") or 0),
                    "avg_reward": round(_to_float(best_bucket.get("avg_reward"), 0.0), 6),
                    "updated_at": best_bucket.get("updated_at") or bucket.get("updated_at"),
                }
            )
        return {
            "context_count": len(self.records),
            "top_contexts": rows,
        }

    def to_dict(self) -> dict[str, Any]:
        return {
            "records": self.records,
        }

    def load(self, payload: dict[str, Any]) -> None:
        raw_records = payload.get("records") if isinstance(payload.get("records"), dict) else {}
        self.records = {
            str(key): value
            for key, value in raw_records.items()
            if isinstance(value, dict)
        }


class MemoryEngineV2:
    def __init__(self, short_term_limit: int = 128, episodic_limit: int = 4096) -> None:
        self.short_term_limit = max(16, short_term_limit)
        self.episodic_limit = max(self.short_term_limit, episodic_limit)
        self.short_term: list[dict[str, Any]] = []
        self.episodic: dict[str, dict[str, Any]] = {}
        self.episode_order: list[str] = []
        self.semantic: dict[str, dict[str, Any]] = {}
        self.causal: dict[str, dict[str, Any]] = {}

    def _context_key(self, state: "MarketState", failure_source: str | None) -> str:
        normalized_source = _normalize_failure_source(failure_source) or "none"
        regime = str(state.regime or "NEUTRAL").strip().upper() or "NEUTRAL"
        session = str(state.market_session or "off").strip().lower() or "off"
        network = str(state.network_regime or "stable").strip().lower() or "stable"
        latent = str(state.latent_label or "uninitialized").strip().lower() or "uninitialized"
        liquidity = str(state.liquidity_state or "balanced").strip().lower() or "balanced"
        return (
            f"regime={regime}|session={session}|network={network}|latent={latent}"
            f"|liquidity={liquidity}|failure={normalized_source}"
        )

    def _correction_for_experience(self, experience: "Experience") -> dict[str, Any]:
        failure_source = _normalize_failure_source(experience.failure_source)
        strategy_mode = str(
            experience.context.get("strategy_mode")
            or experience.context.get("strategy_switch_mode")
            or _default_strategy_mode_for_context(experience.state, failure_source)
        ).strip() or _default_strategy_mode_for_context(experience.state, failure_source)
        route_mode_override = str(
            experience.context.get("route_mode_override")
            or experience.context.get("route_mode")
            or "bestSingleVenue"
        ).strip() or "bestSingleVenue"
        execution_style = str(experience.context.get("execution_style") or "default").strip() or "default"
        max_spread_multiplier = _clamp(_to_float(experience.context.get("max_spread_multiplier"), 1.0), 0.35, 1.0)
        size_multiplier_cap = _clamp(
            _to_float(
                experience.context.get("size_multiplier"),
                _to_float(experience.context.get("size_multiplier_cap"), 1.0),
            ),
            0.0,
            1.0,
        )
        if failure_source == "infra":
            if experience.failure_blocking or experience.state.network_regime == "critical" or experience.state.infra_health <= 0.45:
                return {
                    "strategy_mode": "risk_off",
                    "route_mode_override": "bestSingleVenue",
                    "execution_style": "primary_only",
                    "max_spread_multiplier": 0.72,
                    "size_multiplier_cap": 0.72,
                }
            return {
                "strategy_mode": "execution_protect",
                "route_mode_override": "bestSingleVenue",
                "execution_style": "maker_passive",
                "max_spread_multiplier": 0.82,
                "size_multiplier_cap": 0.78,
            }
        if failure_source == "execution":
            return {
                "strategy_mode": "execution_protect",
                "route_mode_override": "bestSingleVenue",
                "execution_style": "maker_passive",
                "max_spread_multiplier": 0.82,
                "size_multiplier_cap": 0.78,
            }
        if failure_source == "market":
            return {
                "strategy_mode": "market_selective",
                "route_mode_override": "bestSingleVenue",
                "execution_style": "passive_selective",
                "max_spread_multiplier": 0.88 if experience.state.regime == "CHOP" else 0.84 if experience.state.regime == "VOLATILE" else 0.92,
                "size_multiplier_cap": 0.84 if experience.state.regime == "CHOP" else 0.8 if experience.state.regime == "VOLATILE" else 0.9,
            }
        return {
            "strategy_mode": strategy_mode,
            "route_mode_override": route_mode_override,
            "execution_style": execution_style,
            "max_spread_multiplier": round(max_spread_multiplier, 6),
            "size_multiplier_cap": round(size_multiplier_cap if size_multiplier_cap > 0 else 1.0, 6),
        }

    def _correction_signature(self, correction: dict[str, Any]) -> str:
        return "|".join(
            f"{key}={correction.get(key)}"
            for key in (
                "strategy_mode",
                "route_mode_override",
                "execution_style",
                "max_spread_multiplier",
                "size_multiplier_cap",
            )
        )

    def _build_episode(self, experience: "Experience") -> dict[str, Any]:
        failure_source = _normalize_failure_source(experience.failure_source)
        correction = self._correction_for_experience(experience)
        timestamp_ms = _resolve_timestamp_ms(experience.context)
        experience_id = str(experience.experience_id or f"memv2-{timestamp_ms}-{len(self.episode_order) + 1}").strip()
        context_key = self._context_key(experience.state, failure_source)
        correction_signature = self._correction_signature(correction)
        return {
            "experience_id": experience_id,
            "timestamp_ms": timestamp_ms,
            "context_key": context_key,
            "context_signature": _context_signature(experience.context),
            "regime": str(experience.state.regime or "NEUTRAL"),
            "market_session": str(experience.state.market_session or "off"),
            "network_regime": str(experience.state.network_regime or "stable"),
            "latent_label": str(experience.state.latent_label or "uninitialized"),
            "liquidity_state": str(experience.state.liquidity_state or "balanced"),
            "action": str(experience.action.value or "hold").lower(),
            "reward": round(experience.reward, 6),
            "raw_reward": round(experience.raw_reward, 6),
            "failure_source": failure_source,
            "failure_reasons": list(experience.failure_reasons),
            "failure_blocking": bool(experience.failure_blocking),
            "sample_weight": round(_clamp(experience.sample_weight, 0.05, 1.0), 6),
            "correction": correction,
            "correction_signature": correction_signature,
        }

    def _trim(self) -> None:
        if len(self.short_term) > self.short_term_limit:
            del self.short_term[:-self.short_term_limit]
        while len(self.episode_order) > self.episodic_limit:
            stale_id = self.episode_order.pop(0)
            self.episodic.pop(stale_id, None)

    def _remember_semantic(self, episode: dict[str, Any]) -> None:
        context_key = str(episode.get("context_key") or "")
        if not context_key:
            return
        bucket = self.semantic.setdefault(
            context_key,
            {
                "context_key": context_key,
                "regime": episode.get("regime"),
                "market_session": episode.get("market_session"),
                "network_regime": episode.get("network_regime"),
                "latent_label": episode.get("latent_label"),
                "liquidity_state": episode.get("liquidity_state"),
                "failure_source": episode.get("failure_source"),
                "sample_count": 0,
                "win_count": 0,
                "cumulative_reward": 0.0,
                "avg_reward": 0.0,
                "best_action": "hold",
                "dominant_failure_source": episode.get("failure_source"),
                "action_stats": {},
                "failure_counts": {},
                "correction_votes": {},
                "updated_at": datetime.now(tz=timezone.utc).isoformat(),
            },
        )
        bucket["sample_count"] = max(0, int(bucket.get("sample_count") or 0)) + 1
        if _to_float(episode.get("reward"), 0.0) > 0:
            bucket["win_count"] = max(0, int(bucket.get("win_count") or 0)) + 1
        bucket["cumulative_reward"] = _to_float(bucket.get("cumulative_reward"), 0.0) + _to_float(episode.get("reward"), 0.0)
        bucket["avg_reward"] = round(
            _to_float(bucket.get("cumulative_reward"), 0.0) / max(1, int(bucket.get("sample_count") or 0)),
            6,
        )
        action = str(episode.get("action") or "hold")
        action_stats = bucket.setdefault("action_stats", {})
        action_bucket = action_stats.setdefault(
            action,
            {
                "action": action,
                "sample_count": 0,
                "win_count": 0,
                "cumulative_reward": 0.0,
                "avg_reward": 0.0,
            },
        )
        action_bucket["sample_count"] = max(0, int(action_bucket.get("sample_count") or 0)) + 1
        if _to_float(episode.get("reward"), 0.0) > 0:
            action_bucket["win_count"] = max(0, int(action_bucket.get("win_count") or 0)) + 1
        action_bucket["cumulative_reward"] = _to_float(action_bucket.get("cumulative_reward"), 0.0) + _to_float(episode.get("reward"), 0.0)
        action_bucket["avg_reward"] = round(
            _to_float(action_bucket.get("cumulative_reward"), 0.0) / max(1, int(action_bucket.get("sample_count") or 0)),
            6,
        )
        failure_source = str(episode.get("failure_source") or "")
        if failure_source:
            failure_counts = bucket.setdefault("failure_counts", {})
            failure_counts[failure_source] = max(0, int(failure_counts.get(failure_source) or 0)) + 1
            bucket["dominant_failure_source"] = max(
                failure_counts,
                key=lambda key: int(failure_counts.get(key) or 0),
            )
        correction_signature = str(episode.get("correction_signature") or "")
        correction_votes = bucket.setdefault("correction_votes", {})
        correction_bucket = correction_votes.setdefault(
            correction_signature,
            {
                "correction": episode.get("correction") if isinstance(episode.get("correction"), dict) else {},
                "sample_count": 0,
                "failure_sample_count": 0,
                "cumulative_reward": 0.0,
                "avg_reward": 0.0,
            },
        )
        correction_bucket["sample_count"] = max(0, int(correction_bucket.get("sample_count") or 0)) + 1
        if failure_source:
            correction_bucket["failure_sample_count"] = max(0, int(correction_bucket.get("failure_sample_count") or 0)) + 1
        correction_bucket["cumulative_reward"] = _to_float(correction_bucket.get("cumulative_reward"), 0.0) + _to_float(episode.get("reward"), 0.0)
        correction_bucket["avg_reward"] = round(
            _to_float(correction_bucket.get("cumulative_reward"), 0.0) / max(1, int(correction_bucket.get("sample_count") or 0)),
            6,
        )
        best_action = max(
            action_stats.values(),
            key=lambda row: (
                _to_float(row.get("avg_reward"), 0.0) * min(1.0, 0.35 + max(0, int(row.get("sample_count") or 0)) / 5.0),
                int(row.get("sample_count") or 0),
            ),
        )
        bucket["best_action"] = str(best_action.get("action") or "hold")
        bucket["updated_at"] = datetime.now(tz=timezone.utc).isoformat()

    def _remember_causal(self, episode: dict[str, Any]) -> None:
        context_key = str(episode.get("context_key") or "")
        if not context_key:
            return
        causal_key = (
            f"{context_key}|action={episode.get('action') or 'hold'}"
            f"|cause={episode.get('failure_source') or 'none'}"
            f"|correction={episode.get('correction_signature') or 'none'}"
        )
        bucket = self.causal.setdefault(
            causal_key,
            {
                "causal_key": causal_key,
                "context_key": context_key,
                "regime": episode.get("regime"),
                "market_session": episode.get("market_session"),
                "network_regime": episode.get("network_regime"),
                "latent_label": episode.get("latent_label"),
                "liquidity_state": episode.get("liquidity_state"),
                "action": episode.get("action"),
                "failure_source": episode.get("failure_source"),
                "correction": episode.get("correction") if isinstance(episode.get("correction"), dict) else {},
                "sample_count": 0,
                "failure_sample_count": 0,
                "blocking_count": 0,
                "cumulative_reward": 0.0,
                "avg_reward": 0.0,
                "updated_at": datetime.now(tz=timezone.utc).isoformat(),
            },
        )
        bucket["sample_count"] = max(0, int(bucket.get("sample_count") or 0)) + 1
        if episode.get("failure_source"):
            bucket["failure_sample_count"] = max(0, int(bucket.get("failure_sample_count") or 0)) + 1
        if bool(episode.get("failure_blocking")):
            bucket["blocking_count"] = max(0, int(bucket.get("blocking_count") or 0)) + 1
        bucket["cumulative_reward"] = _to_float(bucket.get("cumulative_reward"), 0.0) + _to_float(episode.get("reward"), 0.0)
        bucket["avg_reward"] = round(
            _to_float(bucket.get("cumulative_reward"), 0.0) / max(1, int(bucket.get("sample_count") or 0)),
            6,
        )
        bucket["updated_at"] = datetime.now(tz=timezone.utc).isoformat()

    def remember_experience(self, experience: "Experience") -> None:
        if experience.synthetic:
            return
        episode = self._build_episode(experience)
        experience_id = str(episode.get("experience_id") or "")
        if not experience_id:
            return
        self.episodic[experience_id] = episode
        if experience_id in self.episode_order:
            self.episode_order.remove(experience_id)
        self.episode_order.append(experience_id)
        self.short_term.append(episode)
        self._remember_semantic(episode)
        self._remember_causal(episode)
        self._trim()

    def get_episode(self, experience_id: str) -> dict[str, Any] | None:
        episode = self.episodic.get(str(experience_id))
        return dict(episode) if isinstance(episode, dict) else None

    def _semantic_match(self, state: "MarketState", failure_source: str | None) -> dict[str, Any] | None:
        keys = [self._context_key(state, failure_source)]
        if _normalize_failure_source(failure_source) is not None:
            keys.append(self._context_key(state, None))
        for key in keys:
            bucket = self.semantic.get(key)
            if not isinstance(bucket, dict):
                continue
            sample_count = max(0, int(bucket.get("sample_count") or 0))
            if sample_count < 2:
                continue
            correction_votes = bucket.get("correction_votes") if isinstance(bucket.get("correction_votes"), dict) else {}
            recommended_correction = {}
            if correction_votes:
                recommended_vote = max(
                    correction_votes.values(),
                    key=lambda row: (
                        int(row.get("failure_sample_count") or 0),
                        _to_float(row.get("avg_reward"), 0.0),
                        int(row.get("sample_count") or 0),
                    ),
                )
                if isinstance(recommended_vote.get("correction"), dict):
                    recommended_correction = dict(recommended_vote.get("correction") or {})
            confidence = _clamp(
                (sample_count / 10.0) * _clamp((_to_float(bucket.get("avg_reward"), 0.0) + 10.0) / 20.0, 0.0, 1.0),
                0.0,
                0.9,
            )
            return {
                "context_key": str(bucket.get("context_key") or ""),
                "sample_count": sample_count,
                "avg_reward": round(_to_float(bucket.get("avg_reward"), 0.0), 6),
                "best_action": str(bucket.get("best_action") or "hold"),
                "dominant_failure_source": bucket.get("dominant_failure_source"),
                "recommended_correction": recommended_correction,
                "confidence": round(confidence, 6),
                "updated_at": bucket.get("updated_at"),
            }
        return None

    def _episode_similarity(self, episode: dict[str, Any], state: "MarketState", failure_source: str | None) -> float:
        score = 0.0
        if str(episode.get("regime") or "") == str(state.regime or ""):
            score += 0.3
        if str(episode.get("market_session") or "") == str(state.market_session or ""):
            score += 0.15
        if str(episode.get("network_regime") or "") == str(state.network_regime or ""):
            score += 0.2
        if str(episode.get("latent_label") or "") == str(state.latent_label or ""):
            score += 0.2
        if str(episode.get("liquidity_state") or "") == str(state.liquidity_state or ""):
            score += 0.1
        normalized_source = _normalize_failure_source(failure_source)
        if normalized_source is not None and str(episode.get("failure_source") or "") == normalized_source:
            score += 0.15
        return round(_clamp(score, 0.0, 1.0), 6)

    def _causal_match(self, state: "MarketState", failure_source: str | None) -> dict[str, Any] | None:
        normalized_source = _normalize_failure_source(failure_source)
        candidates: list[tuple[float, int, int, int, dict[str, Any]]] = []
        for bucket in self.causal.values():
            if not isinstance(bucket, dict):
                continue
            bucket_source = _normalize_failure_source(bucket.get("failure_source"))
            if normalized_source is not None and bucket_source not in {normalized_source, None}:
                continue
            similarity = self._episode_similarity(bucket, state, normalized_source)
            if similarity < 0.45:
                continue
            sample_count = max(0, int(bucket.get("sample_count") or 0))
            failure_sample_count = max(0, int(bucket.get("failure_sample_count") or 0))
            blocking_count = max(0, int(bucket.get("blocking_count") or 0))
            candidates.append((similarity, sample_count, failure_sample_count, blocking_count, bucket))
        if not candidates:
            return None
        similarity, sample_count, failure_sample_count, blocking_count, bucket = max(
            candidates,
            key=lambda item: (item[0], item[2], item[3], item[1]),
        )
        confidence = _clamp(
            (similarity * 0.35)
            + min(0.4, sample_count / 12.0)
            + min(0.17, failure_sample_count / max(1, sample_count) * 0.17)
            + min(0.1, blocking_count / max(1, sample_count) * 0.1),
            0.0,
            0.92,
        )
        return {
            "causal_key": str(bucket.get("causal_key") or ""),
            "context_key": str(bucket.get("context_key") or ""),
            "sample_count": sample_count,
            "failure_sample_count": failure_sample_count,
            "blocking_count": blocking_count,
            "avg_reward": round(_to_float(bucket.get("avg_reward"), 0.0), 6),
            "failure_source": bucket.get("failure_source"),
            "correction": dict(bucket.get("correction") or {}) if isinstance(bucket.get("correction"), dict) else {},
            "confidence": round(confidence, 6),
            "similarity": round(similarity, 6),
            "updated_at": bucket.get("updated_at"),
        }

    def resolve(self, state: "MarketState", failure_source: str | None, causal_strict: bool = False) -> dict[str, Any]:
        semantic_match = self._semantic_match(state, failure_source)
        causal_match = self._causal_match(state, failure_source)
        normalized_source = _normalize_failure_source(failure_source)
        recent_matches = []
        for episode in reversed(self.short_term):
            similarity = self._episode_similarity(episode, state, failure_source)
            if similarity < 0.35:
                continue
            recent_matches.append(
                {
                    "experience_id": episode.get("experience_id"),
                    "context_key": episode.get("context_key"),
                    "action": episode.get("action"),
                    "reward": episode.get("reward"),
                    "failure_source": episode.get("failure_source"),
                    "correction": episode.get("correction") if isinstance(episode.get("correction"), dict) else {},
                    "similarity": similarity,
                    "timestamp_ms": int(episode.get("timestamp_ms") or 0),
                }
            )
            if len(recent_matches) >= 5:
                break
        recommendation: dict[str, Any] = {}
        confidence = 0.0
        source = "none"
        strict_ready = bool(
            causal_match is not None
            and int(causal_match.get("sample_count") or 0) >= 3
            and int(causal_match.get("failure_sample_count") or 0) >= 2
            and _to_float(causal_match.get("confidence"), 0.0) >= 0.34
            and isinstance(causal_match.get("correction"), dict)
            and bool(causal_match.get("correction"))
            and str(causal_match.get("correction", {}).get("strategy_mode") or "").strip()
            and str(causal_match.get("correction", {}).get("execution_style") or "").strip()
            and str(causal_match.get("correction", {}).get("route_mode_override") or "").strip()
        )
        causal_guard = {
            "enabled": bool(causal_strict),
            "query_failure_source": normalized_source,
            "ready": strict_ready,
            "applied": False,
            "reason": "disabled",
        }
        if causal_match is not None and normalized_source is not None and (not causal_strict or strict_ready):
            recommendation = dict(causal_match.get("correction") or {})
            confidence = _to_float(causal_match.get("confidence"), 0.0)
            source = "causal_strict" if causal_strict else "causal"
            causal_guard["applied"] = bool(causal_strict)
            causal_guard["reason"] = "strict_match" if causal_strict else "causal_match"
        elif causal_strict and normalized_source is not None:
            causal_guard["reason"] = "insufficient_causal_evidence"
        elif semantic_match is not None and isinstance(semantic_match.get("recommended_correction"), dict):
            recommendation = dict(semantic_match.get("recommended_correction") or {})
            confidence = _to_float(semantic_match.get("confidence"), 0.0)
            source = "semantic"
        return {
            "context_key": self._context_key(state, failure_source),
            "semantic_key": str((semantic_match or {}).get("context_key") or ""),
            "causal_key": str((causal_match or {}).get("causal_key") or ""),
            "query_failure_source": _normalize_failure_source(failure_source),
            "semantic_match": semantic_match,
            "causal_match": causal_match,
            "episodic_matches": recent_matches,
            "recommendation": recommendation,
            "confidence": round(confidence, 6),
            "source": source,
            "causal_guard": causal_guard,
            "layer_counts": {
                "short_term": len(self.short_term),
                "episodic": len(self.episodic),
                "semantic": len(self.semantic),
                "causal": len(self.causal),
            },
        }

    def summary(self) -> dict[str, Any]:
        top_semantic = sorted(
            (bucket for bucket in self.semantic.values() if isinstance(bucket, dict)),
            key=lambda bucket: (_to_float(bucket.get("avg_reward"), 0.0), int(bucket.get("sample_count") or 0)),
            reverse=True,
        )[:6]
        top_causal = sorted(
            (bucket for bucket in self.causal.values() if isinstance(bucket, dict)),
            key=lambda bucket: (int(bucket.get("failure_sample_count") or 0), int(bucket.get("sample_count") or 0), _to_float(bucket.get("avg_reward"), 0.0)),
            reverse=True,
        )[:6]
        return {
            "short_term_count": len(self.short_term),
            "episodic_count": len(self.episodic),
            "semantic_count": len(self.semantic),
            "causal_count": len(self.causal),
            "top_semantic_contexts": [
                {
                    "context_key": str(bucket.get("context_key") or ""),
                    "sample_count": int(bucket.get("sample_count") or 0),
                    "avg_reward": round(_to_float(bucket.get("avg_reward"), 0.0), 6),
                    "best_action": str(bucket.get("best_action") or "hold"),
                    "dominant_failure_source": bucket.get("dominant_failure_source"),
                    "updated_at": bucket.get("updated_at"),
                }
                for bucket in top_semantic
            ],
            "top_causal_patterns": [
                {
                    "causal_key": str(bucket.get("causal_key") or ""),
                    "context_key": str(bucket.get("context_key") or ""),
                    "failure_source": bucket.get("failure_source"),
                    "sample_count": int(bucket.get("sample_count") or 0),
                    "failure_sample_count": int(bucket.get("failure_sample_count") or 0),
                    "blocking_count": int(bucket.get("blocking_count") or 0),
                    "avg_reward": round(_to_float(bucket.get("avg_reward"), 0.0), 6),
                    "correction": dict(bucket.get("correction") or {}) if isinstance(bucket.get("correction"), dict) else {},
                    "updated_at": bucket.get("updated_at"),
                }
                for bucket in top_causal
            ],
            "recent_episodes": [
                {
                    "experience_id": episode.get("experience_id"),
                    "context_key": episode.get("context_key"),
                    "action": episode.get("action"),
                    "reward": episode.get("reward"),
                    "failure_source": episode.get("failure_source"),
                    "timestamp_ms": int(episode.get("timestamp_ms") or 0),
                }
                for episode in self.short_term[-6:]
            ],
        }

    def to_dict(self) -> dict[str, Any]:
        return {
            "short_term": self.short_term,
            "episodic": self.episodic,
            "episode_order": self.episode_order,
            "semantic": self.semantic,
            "causal": self.causal,
        }

    def load(self, payload: dict[str, Any]) -> None:
        self.short_term = [row for row in payload.get("short_term", []) if isinstance(row, dict)][-self.short_term_limit :]
        self.episodic = {
            str(key): value
            for key, value in (payload.get("episodic") if isinstance(payload.get("episodic"), dict) else {}).items()
            if isinstance(value, dict)
        }
        self.episode_order = [
            str(item)
            for item in payload.get("episode_order", [])
            if str(item) in self.episodic
        ][-self.episodic_limit :]
        self.semantic = {
            str(key): value
            for key, value in (payload.get("semantic") if isinstance(payload.get("semantic"), dict) else {}).items()
            if isinstance(value, dict)
        }
        self.causal = {
            str(key): value
            for key, value in (payload.get("causal") if isinstance(payload.get("causal"), dict) else {}).items()
            if isinstance(value, dict)
        }
        self._trim()


@dataclass(frozen=True)
class StrategyProfile:
    profile_id: str
    global_mode: str
    strategy_mode: str
    execution_style: str
    route_mode_override: str
    exposure_multiplier: float
    max_spread_multiplier: float
    agent_biases: dict[str, float] = field(default_factory=dict)
    disabled_agents: tuple[str, ...] = ()
    venue_action: str = "stay_primary"
    execution_delay_ms: int = 0
    halt_new_exposure: bool = False
    close_only: bool = False
    simulation_profile: str = "balanced"


STRATEGY_LIBRARY: dict[str, StrategyProfile] = {
    "balanced_core": StrategyProfile(
        profile_id="balanced_core",
        global_mode="balanced",
        strategy_mode="balanced",
        execution_style="default",
        route_mode_override="",
        exposure_multiplier=1.0,
        max_spread_multiplier=1.0,
        agent_biases={"scalper": 1.0, "trend": 1.0, "liquidity": 1.0, "execution": 1.0, "risk": 1.0},
        simulation_profile="balanced",
    ),
    "trend_high_conviction": StrategyProfile(
        profile_id="trend_high_conviction",
        global_mode="trend_risk_on",
        strategy_mode="trend_follow",
        execution_style="aggressive_confirmed",
        route_mode_override="",
        exposure_multiplier=1.0,
        max_spread_multiplier=0.96,
        agent_biases={"scalper": 0.92, "trend": 1.26, "liquidity": 0.98, "execution": 1.04, "risk": 0.96},
        simulation_profile="trend_follow",
    ),
    "chop_mean_reversion": StrategyProfile(
        profile_id="chop_mean_reversion",
        global_mode="selective",
        strategy_mode="mean_reversion",
        execution_style="passive_selective",
        route_mode_override="bestSingleVenue",
        exposure_multiplier=0.84,
        max_spread_multiplier=0.9,
        agent_biases={"scalper": 1.16, "trend": 0.22, "liquidity": 1.08, "execution": 0.96, "risk": 1.06},
        disabled_agents=("trend",),
        simulation_profile="market_chop",
    ),
    "news_spike": StrategyProfile(
        profile_id="news_spike",
        global_mode="shock_control",
        strategy_mode="volatility_event",
        execution_style="passive_staggered",
        route_mode_override="bestSingleVenue",
        exposure_multiplier=0.52,
        max_spread_multiplier=0.74,
        agent_biases={"scalper": 0.54, "trend": 0.72, "liquidity": 1.16, "execution": 0.88, "risk": 1.24},
        disabled_agents=("scalper",),
        venue_action="primary_only",
        execution_delay_ms=180,
        halt_new_exposure=False,
        simulation_profile="news_spike",
    ),
    "execution_safe": StrategyProfile(
        profile_id="execution_safe",
        global_mode="execution_safe",
        strategy_mode="execution_protect",
        execution_style="maker_passive",
        route_mode_override="bestSingleVenue",
        exposure_multiplier=0.68,
        max_spread_multiplier=0.82,
        agent_biases={"scalper": 0.72, "trend": 0.74, "liquidity": 1.06, "execution": 0.66, "risk": 1.12},
        venue_action="rotate_backup",
        execution_delay_ms=140,
        simulation_profile="execution_friction",
    ),
    "risk_off": StrategyProfile(
        profile_id="risk_off",
        global_mode="risk_off",
        strategy_mode="risk_off",
        execution_style="primary_only",
        route_mode_override="bestSingleVenue",
        exposure_multiplier=0.0,
        max_spread_multiplier=0.64,
        agent_biases={"scalper": 0.0, "trend": 0.0, "liquidity": 0.56, "execution": 0.42, "risk": 1.34},
        disabled_agents=("scalper", "trend"),
        venue_action="primary_only",
        execution_delay_ms=900,
        halt_new_exposure=True,
        close_only=True,
        simulation_profile="infra_stress",
    ),
}


SIMULATION_PROFILE_LIBRARY: dict[str, dict[str, float | str]] = {
    "balanced": {
        "price_noise": 1.0,
        "spread_noise": 1.0,
        "latency_spike": 1.0,
        "backlog_spike": 1.0,
        "slippage_spike": 1.0,
        "fill_drag": 1.0,
        "spoofing_burst": 1.0,
        "partial_fill_risk": 1.0,
        "network_bias": "stable",
    },
    "trend_follow": {
        "price_noise": 1.12,
        "spread_noise": 0.92,
        "latency_spike": 0.94,
        "backlog_spike": 0.9,
        "slippage_spike": 0.94,
        "fill_drag": 0.9,
        "spoofing_burst": 0.88,
        "partial_fill_risk": 0.9,
        "network_bias": "stable",
    },
    "market_chop": {
        "price_noise": 0.92,
        "spread_noise": 1.18,
        "latency_spike": 1.04,
        "backlog_spike": 1.08,
        "slippage_spike": 1.14,
        "fill_drag": 1.08,
        "spoofing_burst": 1.16,
        "partial_fill_risk": 1.1,
        "network_bias": "stable",
    },
    "news_spike": {
        "price_noise": 1.34,
        "spread_noise": 1.28,
        "latency_spike": 1.22,
        "backlog_spike": 1.18,
        "slippage_spike": 1.3,
        "fill_drag": 1.2,
        "spoofing_burst": 1.24,
        "partial_fill_risk": 1.22,
        "network_bias": "degraded",
    },
    "execution_friction": {
        "price_noise": 1.02,
        "spread_noise": 1.32,
        "latency_spike": 1.36,
        "backlog_spike": 1.28,
        "slippage_spike": 1.4,
        "fill_drag": 1.34,
        "spoofing_burst": 1.12,
        "partial_fill_risk": 1.3,
        "network_bias": "degraded",
    },
    "infra_stress": {
        "price_noise": 0.96,
        "spread_noise": 1.42,
        "latency_spike": 1.62,
        "backlog_spike": 1.54,
        "slippage_spike": 1.24,
        "fill_drag": 1.38,
        "spoofing_burst": 1.06,
        "partial_fill_risk": 1.28,
        "network_bias": "critical",
    },
}


class Action(str, Enum):
    BUY = "BUY"
    SELL = "SELL"
    HOLD = "HOLD"
    CLOSE = "CLOSE"

    @classmethod
    def from_value(cls, value: Any) -> "Action":
        candidate = str(value or "HOLD").strip().upper()
        for action in cls:
            if action.value == candidate:
                return action
        return cls.HOLD


def calibrate(
    signal: float,
    win_rate: float,
    *,
    regime_win_rate: float | None = None,
    volatility: float = 0.0,
    spread: float = 0.0,
    latency: float = 0.0,
    fill_probability: float = 0.0,
    orderflow_quality: float = 0.0,
    consensus: float | None = None,
    infra_health: float = 1.0,
    network_regime: str | None = None,
) -> float:
    expected = _clamp(signal, 0.35, 0.97)
    empirical = _clamp(regime_win_rate if regime_win_rate is not None else win_rate, 0.25, 1.35)
    calibrated = signal * _clamp(empirical / expected, 0.45, 1.7)

    if volatility >= 25.0:
        calibrated *= 0.8
    elif volatility >= 15.0:
        calibrated *= 0.9

    if spread >= 12.0:
        calibrated *= 0.7
    elif spread >= 6.0:
        calibrated *= 0.85

    if latency >= 300.0:
        calibrated *= 0.82
    elif latency >= 180.0:
        calibrated *= 0.9

    if fill_probability > 0.0:
        calibrated *= _clamp(0.72 + fill_probability * 0.48, 0.7, 1.08)

    calibrated *= _clamp(0.9 + orderflow_quality * 0.16, 0.86, 1.12)

    calibrated *= _clamp(0.55 + _clamp(infra_health, 0.05, 1.0) * 0.5, 0.5, 1.05)

    normalized_network_regime = _normalize_network_regime(network_regime)
    if normalized_network_regime == "critical":
        calibrated *= 0.74
    elif normalized_network_regime == "degraded":
        calibrated *= 0.88

    if consensus is not None and consensus < 0.4:
        calibrated *= 0.88

    return _clamp(calibrated, 0.0, 1.0)


def compute_reward(
    pnl: float,
    drawdown: float,
    latency: float,
    sharpe: float = 0.0,
    infra_health: float = 1.0,
) -> float:
    base_reward = float(pnl) + float(sharpe) * 0.35 - float(drawdown) * 1.5 - float(latency) * 0.2
    return base_reward * _clamp(0.45 + _clamp(infra_health, 0.05, 1.0) * 0.55, 0.45, 1.0)


@dataclass
class MarketState:
    price: float
    spread: float
    imbalance: float
    volatility: float
    regime: str
    position: float
    pnl: float
    drawdown: float = 0.0
    latency: float = 0.0
    depth: float = 0.0
    volume: float = 0.0
    fill_probability: float = 0.0
    backlog: float = 0.0
    render_pressure: float = 0.0
    edge: float = 0.0
    momentum: float = 0.0
    slippage: float = 0.0
    micro_burst: float = 0.0
    quote_fade: float = 0.0
    book_flip: float = 0.0
    trend_score: float = 0.0
    model_probability: float = 0.0
    bid_volume: float = 0.0
    ask_volume: float = 0.0
    orderflow_delta: float = 0.0
    cumulative_delta: float = 0.0
    orderflow_imbalance: float = 0.0
    absorption_signal: float = 0.0
    liquidity_trap_signal: float = 0.0
    spoofing_score: float = 0.0
    distance_to_vwap: float = 0.0
    vwap_slope: float = 0.0
    orderflow_quality: float = 0.0
    session_vwap_distance: float = 0.0
    day_vwap_distance: float = 0.0
    week_vwap_distance: float = 0.0
    month_vwap_distance: float = 0.0
    swing_vwap_distance: float = 0.0
    impulse_vwap_distance: float = 0.0
    anchor_confluence: float = 0.0
    anchor_compression: float = 0.0
    liquidity_pressure: float = 0.0
    resting_imbalance: float = 0.0
    sweep_risk: float = 0.0
    liquidity_vacuum: float = 0.0
    support_score: float = 0.0
    resistance_score: float = 0.0
    liquidity_engine_score: float = 0.0
    liquidity_state: str = "balanced"
    anchor_primary: str = "n/a"
    market_session: str = "off"
    infra_health: float = 1.0
    network_regime: str = "stable"
    dns_transient_rate: float = 0.0
    timeout_rate: float = 0.0
    degraded_usage_ratio: float = 0.0
    retry_recovered_ratio: float = 0.0
    latent_vector: list[float] = field(default_factory=list)
    latent_label: str = "uninitialized"
    latent_confidence: float = 0.0
    latent_transition: float = 0.0

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "MarketState":
        price = _to_float(
            payload.get("price"),
            _to_float(
                payload.get("fusion_price"),
                _to_float(
                    payload.get("display_price"),
                    _to_float(payload.get("raw_chart_anchor_price"), _to_float(payload.get("last"), 0.0)),
                ),
            ),
        )
        spread = _to_float(payload.get("spread"), _to_float(payload.get("spread_bps"), 0.0))
        imbalance = _to_float(payload.get("imbalance"), _to_float(payload.get("depth_imbalance"), 0.0))
        volatility = _to_float(payload.get("volatility"), _to_float(payload.get("volatility_bps"), 0.0))
        regime = str(payload.get("regime") or "").strip().upper()
        network_metrics_payload = payload.get("network_metrics") if isinstance(payload.get("network_metrics"), dict) else {}
        infra_health = _infer_infra_health(payload, network_metrics_payload)
        network_regime = _normalize_network_regime(payload.get("network_regime"))
        if network_regime == "stable":
            if infra_health <= 0.45:
                network_regime = "critical"
            elif infra_health <= 0.78:
                network_regime = "degraded"
        latent_state_payload = payload.get("latent_state") if isinstance(payload.get("latent_state"), dict) else {}
        latent_vector_payload = payload.get("latent_vector") if isinstance(payload.get("latent_vector"), list) else latent_state_payload.get("vector") if isinstance(latent_state_payload.get("vector"), list) else []
        latent_vector = [_clamp(_to_float(value, 0.0), -1.0, 1.0) for value in latent_vector_payload[: len(LATENT_FEATURE_NAMES)]]
        position = _to_float(payload.get("position"), _to_float(payload.get("position_size"), 0.0))
        pnl = _to_float(payload.get("pnl"), _to_float(payload.get("realized_pnl_usd"), 0.0) + _to_float(payload.get("unrealized_pnl_usd"), 0.0))
        bid_volume = _to_float(payload.get("bid_volume"), _to_float(payload.get("buy_volume"), 0.0))
        ask_volume = _to_float(payload.get("ask_volume"), _to_float(payload.get("sell_volume"), 0.0))
        orderflow_delta = _to_float(payload.get("orderflow_delta"), bid_volume - ask_volume)
        normalized_orderflow_imbalance = orderflow_delta / max(abs(bid_volume) + abs(ask_volume), 1e-6)
        state = cls(
            price=price,
            spread=spread,
            imbalance=imbalance,
            volatility=volatility,
            regime=regime,
            position=position,
            pnl=pnl,
            drawdown=_to_float(payload.get("drawdown"), _to_float(payload.get("drawdown_pct"), _to_float(payload.get("current_drawdown_pct"), 0.0))),
            latency=_to_float(payload.get("latency"), _to_float(payload.get("latency_ms"), _to_float(payload.get("latency_e2e_ms"), 0.0))),
            depth=_to_float(payload.get("depth"), _to_float(payload.get("available_depth_usd"), 0.0)),
            volume=_to_float(payload.get("volume"), _to_float(payload.get("volume_30s"), 0.0)),
            fill_probability=_to_float(payload.get("fill_probability"), 0.0),
            backlog=_to_float(payload.get("backlog"), _to_float(payload.get("backlog_pressure"), 0.0)),
            render_pressure=_to_float(payload.get("render_pressure"), 0.0),
            edge=_to_float(payload.get("edge"), _to_float(payload.get("final_edge_bps"), _to_float(payload.get("arb_edge_bps"), 0.0))),
            momentum=_to_float(payload.get("momentum"), _to_float(payload.get("cvd_delta"), 0.0) / 5000.0),
            slippage=abs(_to_float(payload.get("slippage"), _to_float(payload.get("slippage_bps"), _to_float(payload.get("realized_slippage_bps"), 0.0)))),
            micro_burst=_to_float(payload.get("micro_burst"), _to_float(payload.get("micro_burst_10ms"), 0.0)),
            quote_fade=_to_float(payload.get("quote_fade"), _to_float(payload.get("quote_fade_rate"), 0.0)),
            book_flip=_to_float(payload.get("book_flip"), _to_float(payload.get("book_flip_signal"), 0.0)),
            trend_score=_to_float(payload.get("trend_score"), 0.0),
            model_probability=_to_float(payload.get("model_probability"), _to_float(payload.get("probability"), 0.0)),
            bid_volume=bid_volume,
            ask_volume=ask_volume,
            orderflow_delta=orderflow_delta,
            cumulative_delta=_to_float(payload.get("cumulative_delta"), _to_float(payload.get("cvd"), 0.0)),
            orderflow_imbalance=_to_float(payload.get("orderflow_imbalance"), _to_float(payload.get("flow_imbalance"), _to_float(payload.get("volume_imbalance"), normalized_orderflow_imbalance))),
            absorption_signal=_to_float(payload.get("absorption_signal"), 0.0),
            liquidity_trap_signal=_to_float(payload.get("liquidity_trap_signal"), 0.0),
            spoofing_score=_to_float(payload.get("spoofing_score"), _to_float(payload.get("book_flip_signal"), 0.0) * _clamp(_to_float(payload.get("quote_fade_rate"), 0.0) / 3.0, 0.0, 1.0)),
            distance_to_vwap=_to_float(payload.get("distance_to_vwap"), _to_float(payload.get("distance_to_vwap_bps"), 0.0)),
            vwap_slope=_to_float(payload.get("vwap_slope"), _to_float(payload.get("vwap_slope_bps"), 0.0)),
            orderflow_quality=_to_float(payload.get("orderflow_quality"), 0.0),
            session_vwap_distance=_to_float(payload.get("session_vwap_distance"), _to_float(payload.get("session_vwap_distance_bps"), 0.0)),
            day_vwap_distance=_to_float(payload.get("day_vwap_distance"), _to_float(payload.get("day_vwap_distance_bps"), 0.0)),
            week_vwap_distance=_to_float(payload.get("week_vwap_distance"), _to_float(payload.get("week_vwap_distance_bps"), 0.0)),
            month_vwap_distance=_to_float(payload.get("month_vwap_distance"), _to_float(payload.get("month_vwap_distance_bps"), 0.0)),
            swing_vwap_distance=_to_float(payload.get("swing_vwap_distance"), _to_float(payload.get("swing_vwap_distance_bps"), 0.0)),
            impulse_vwap_distance=_to_float(payload.get("impulse_vwap_distance"), _to_float(payload.get("impulse_vwap_distance_bps"), 0.0)),
            anchor_confluence=_to_float(payload.get("anchor_confluence"), 0.0),
            anchor_compression=_to_float(payload.get("anchor_compression"), _to_float(payload.get("anchor_compression_bps"), 0.0)),
            liquidity_pressure=_to_float(payload.get("liquidity_pressure"), 0.0),
            resting_imbalance=_to_float(payload.get("resting_imbalance"), 0.0),
            sweep_risk=_to_float(payload.get("sweep_risk"), 0.0),
            liquidity_vacuum=_to_float(payload.get("liquidity_vacuum"), 0.0),
            support_score=_to_float(payload.get("support_score"), 0.0),
            resistance_score=_to_float(payload.get("resistance_score"), 0.0),
            liquidity_engine_score=_to_float(payload.get("liquidity_engine_score"), 0.0),
            liquidity_state=str(payload.get("liquidity_state") or payload.get("liquidity_engine_state") or "balanced").strip().lower() or "balanced",
            anchor_primary=str(payload.get("anchor_primary") or payload.get("vwap_anchor_primary") or "n/a").strip().lower() or "n/a",
            market_session=str(payload.get("market_session") or _market_session_from_timestamp(_resolve_timestamp_ms(payload))).strip().lower() or "off",
            infra_health=infra_health,
            network_regime=network_regime,
            dns_transient_rate=_to_float(network_metrics_payload.get("dns_transient_rate"), _to_float(payload.get("dns_transient_rate"), 0.0)),
            timeout_rate=_to_float(network_metrics_payload.get("timeout_rate"), _to_float(payload.get("timeout_rate"), 0.0)),
            degraded_usage_ratio=_to_float(network_metrics_payload.get("degraded_usage_ratio"), _to_float(payload.get("degraded_usage_ratio"), 0.0)),
            retry_recovered_ratio=_to_float(network_metrics_payload.get("retry_recovered_ratio"), _to_float(payload.get("retry_recovered_ratio"), 0.0)),
            latent_vector=latent_vector,
            latent_label=str(payload.get("latent_label") or latent_state_payload.get("label") or "uninitialized").strip().lower() or "uninitialized",
            latent_confidence=_clamp(_to_float(payload.get("latent_confidence"), _to_float(latent_state_payload.get("confidence"), 0.0)), 0.0, 1.0),
            latent_transition=_clamp(_to_float(payload.get("latent_transition"), _to_float(latent_state_payload.get("transition"), 0.0)), 0.0, 1.0),
        )
        if state.orderflow_quality <= 0.0:
            state.orderflow_quality = _compute_orderflow_quality(state)
        if state.liquidity_engine_score <= 0.0:
            state.liquidity_engine_score = _compute_liquidity_engine_score(state)
        if not state.regime:
            state.regime = detect_regime(state)
        return state

    def to_dict(self) -> dict[str, Any]:
        return {
            "price": self.price,
            "spread": self.spread,
            "imbalance": self.imbalance,
            "volatility": self.volatility,
            "regime": self.regime,
            "position": self.position,
            "pnl": self.pnl,
            "drawdown": self.drawdown,
            "latency": self.latency,
            "depth": self.depth,
            "volume": self.volume,
            "fill_probability": self.fill_probability,
            "backlog": self.backlog,
            "render_pressure": self.render_pressure,
            "edge": self.edge,
            "momentum": self.momentum,
            "slippage": self.slippage,
            "micro_burst": self.micro_burst,
            "quote_fade": self.quote_fade,
            "book_flip": self.book_flip,
            "trend_score": self.trend_score,
            "model_probability": self.model_probability,
            "bid_volume": self.bid_volume,
            "ask_volume": self.ask_volume,
            "orderflow_delta": self.orderflow_delta,
            "cumulative_delta": self.cumulative_delta,
            "orderflow_imbalance": self.orderflow_imbalance,
            "absorption_signal": self.absorption_signal,
            "liquidity_trap_signal": self.liquidity_trap_signal,
            "spoofing_score": self.spoofing_score,
            "distance_to_vwap": self.distance_to_vwap,
            "vwap_slope": self.vwap_slope,
            "orderflow_quality": self.orderflow_quality,
            "session_vwap_distance": self.session_vwap_distance,
            "day_vwap_distance": self.day_vwap_distance,
            "week_vwap_distance": self.week_vwap_distance,
            "month_vwap_distance": self.month_vwap_distance,
            "swing_vwap_distance": self.swing_vwap_distance,
            "impulse_vwap_distance": self.impulse_vwap_distance,
            "anchor_confluence": self.anchor_confluence,
            "anchor_compression": self.anchor_compression,
            "liquidity_pressure": self.liquidity_pressure,
            "resting_imbalance": self.resting_imbalance,
            "sweep_risk": self.sweep_risk,
            "liquidity_vacuum": self.liquidity_vacuum,
            "support_score": self.support_score,
            "resistance_score": self.resistance_score,
            "liquidity_engine_score": self.liquidity_engine_score,
            "liquidity_state": self.liquidity_state,
            "anchor_primary": self.anchor_primary,
            "market_session": self.market_session,
            "infra_health": self.infra_health,
            "network_regime": self.network_regime,
            "dns_transient_rate": self.dns_transient_rate,
            "timeout_rate": self.timeout_rate,
            "degraded_usage_ratio": self.degraded_usage_ratio,
            "retry_recovered_ratio": self.retry_recovered_ratio,
            "latent_vector": self.latent_vector,
            "latent_label": self.latent_label,
            "latent_confidence": self.latent_confidence,
            "latent_transition": self.latent_transition,
        }


def _compute_orderflow_quality(state: MarketState) -> float:
    directional_pressure = min(1.0, abs(state.orderflow_imbalance))
    delta_pressure = min(1.0, abs(state.orderflow_delta) / max(abs(state.bid_volume) + abs(state.ask_volume), 1e-6))
    absorption_pressure = min(1.0, abs(state.absorption_signal))
    trap_pressure = min(1.0, abs(state.liquidity_trap_signal))
    spoof_pressure = min(1.0, abs(state.spoofing_score))
    return _clamp(
        directional_pressure * 0.34
        + delta_pressure * 0.2
        + absorption_pressure * 0.22
        + trap_pressure * 0.16
        + spoof_pressure * 0.08,
        0.0,
        1.0,
    )


def _compute_liquidity_engine_score(state: MarketState) -> float:
    return _clamp(
        abs(state.liquidity_pressure) * 0.34
        + abs(state.resting_imbalance) * 0.22
        + state.sweep_risk * 0.2
        + state.liquidity_vacuum * 0.12
        + state.anchor_confluence * 0.12,
        0.0,
        1.0,
    )


def _compute_feature_family_scores(state: MarketState) -> dict[str, float]:
    orderflow_score = _clamp(
        state.orderflow_quality * 0.58
        + min(1.0, abs(state.orderflow_imbalance)) * 0.18
        + min(1.0, abs(state.absorption_signal)) * 0.14
        + min(1.0, abs(state.momentum)) * 0.10,
        0.0,
        1.0,
    )
    liquidity_score = _clamp(
        state.liquidity_engine_score * 0.54
        + min(1.0, abs(state.liquidity_pressure)) * 0.16
        + min(1.0, abs(state.resting_imbalance)) * 0.14
        + state.support_score * 0.08
        + state.resistance_score * 0.08,
        0.0,
        1.0,
    )
    vwap_score = _clamp(
        state.anchor_confluence * 0.34
        + max(0.0, 1.0 - min(1.0, abs(state.distance_to_vwap) / 18.0)) * 0.24
        + max(0.0, 1.0 - min(1.0, state.anchor_compression / 35.0)) * 0.20
        + min(1.0, abs(state.vwap_slope) / 10.0) * 0.12
        + max(0.0, 1.0 - min(1.0, abs(state.impulse_vwap_distance) / 15.0)) * 0.10,
        0.0,
        1.0,
    )
    regime_base = 0.42 if state.regime == "TREND" else 0.38 if state.regime == "VOLATILE" else 0.34 if state.regime == "CHOP" else 0.30
    regime_score = _clamp(
        regime_base
        + min(0.22, abs(state.trend_score) * 0.24)
        + min(0.18, abs(state.momentum) * 0.18)
        + min(0.14, state.anchor_confluence * 0.14)
        - min(0.18, max(0.0, state.drawdown / 20.0))
        - min(0.16, max(0.0, state.latency / 500.0)),
        0.0,
        1.0,
    )
    return {
        "orderflow": round(orderflow_score, 6),
        "liquidity": round(liquidity_score, 6),
        "vwap": round(vwap_score, 6),
        "regime": round(regime_score, 6),
    }


def _compute_feature_family_directions(state: MarketState) -> dict[str, int]:
    flow_denominator = max(abs(state.bid_volume) + abs(state.ask_volume), 1e-6)
    orderflow_direction = _sign(
        state.orderflow_imbalance * 0.45
        + (state.orderflow_delta / flow_denominator) * 0.25
        + state.absorption_signal * 0.2
        + state.momentum * 0.1,
    )
    liquidity_direction = _sign(
        state.liquidity_pressure * 0.6
        + state.resting_imbalance * 0.2
        + (state.support_score - state.resistance_score) * 0.2,
    )
    vwap_direction = _sign(
        (-state.distance_to_vwap / 25.0) * 0.45
        + (state.vwap_slope / 12.0) * 0.3
        + (-state.impulse_vwap_distance / 20.0) * 0.25,
    )
    if state.regime == "TREND":
        regime_direction = _sign(state.trend_score + state.momentum * 0.8 + state.edge / 10.0)
    elif state.regime == "CHOP":
        regime_direction = _sign((-state.distance_to_vwap / 18.0) + state.liquidity_pressure * 0.3)
    else:
        regime_direction = _sign(state.edge / 10.0 + state.momentum * 0.4 + state.liquidity_pressure * 0.2)
    return {
        "orderflow": orderflow_direction,
        "liquidity": liquidity_direction,
        "vwap": vwap_direction,
        "regime": regime_direction,
    }


def _build_feature_context(state: MarketState) -> dict[str, str]:
    return {
        "regime": (state.regime or "NEUTRAL").lower(),
        "session": state.market_session or "off",
        "volatility": _volatility_bucket(state.volatility),
        "spread": _spread_bucket(state.spread),
    }


def _context_signature(context: dict[str, Any]) -> str:
    return "|".join(f"{key}={str(context.get(key) or 'n/a').lower()}" for key in ("regime", "session", "volatility", "spread"))


def _merge_feature_scores(explicit_features: dict[str, Any] | None, derived_features: dict[str, float]) -> dict[str, float]:
    merged = dict(derived_features)
    if isinstance(explicit_features, dict):
        for family in FEATURE_FAMILIES:
            for key in (family, f"{family}_score"):
                if key in explicit_features:
                    merged[family] = _clamp(_to_float(explicit_features.get(key), merged[family]), 0.0, 1.0)
                    break
    return {family: round(_clamp(merged.get(family, 0.0), 0.0, 1.0), 6) for family in FEATURE_FAMILIES}


def _build_feature_contributions(
    state: MarketState,
    action: Action,
    reward: float,
    features: dict[str, float],
    explicit_contributions: dict[str, Any] | None = None,
) -> dict[str, float]:
    contributions, _ = _build_feature_attribution(state, action, reward, features, explicit_contributions)
    return contributions


def _action_sign(action: Action, state: MarketState) -> int:
    if action == Action.BUY:
        return 1
    if action == Action.SELL:
        return -1
    if action == Action.CLOSE:
        return _sign(-state.position)
    return 0


def _ablate_feature_family_state(state: MarketState, family: str) -> MarketState:
    if family == "orderflow":
        return replace(
            state,
            bid_volume=0.0,
            ask_volume=0.0,
            orderflow_delta=0.0,
            cumulative_delta=0.0,
            orderflow_imbalance=0.0,
            absorption_signal=0.0,
            liquidity_trap_signal=0.0,
            spoofing_score=0.0,
            orderflow_quality=0.0,
        )
    if family == "liquidity":
        return replace(
            state,
            liquidity_pressure=0.0,
            resting_imbalance=0.0,
            sweep_risk=0.0,
            liquidity_vacuum=0.0,
            support_score=0.0,
            resistance_score=0.0,
            liquidity_engine_score=0.0,
            liquidity_state="balanced",
        )
    if family == "vwap":
        return replace(
            state,
            distance_to_vwap=0.0,
            vwap_slope=0.0,
            session_vwap_distance=0.0,
            day_vwap_distance=0.0,
            week_vwap_distance=0.0,
            month_vwap_distance=0.0,
            swing_vwap_distance=0.0,
            impulse_vwap_distance=0.0,
            anchor_confluence=0.0,
            anchor_compression=0.0,
            anchor_primary="n/a",
        )
    if family == "regime":
        return replace(
            state,
            regime="NEUTRAL",
            trend_score=0.0,
            momentum=0.0,
        )
    return state


def _feature_signal_for_action(
    state: MarketState,
    family: str,
    action: Action,
    features: dict[str, float],
    directions: dict[str, int],
) -> float:
    action_sign = _action_sign(action, state)
    if action_sign == 0:
        return 0.0
    direction = directions.get(family, 0)
    if direction == 0:
        alignment = 0.2
    else:
        alignment = 1.0 if direction == action_sign else -1.0
    return features.get(family, 0.0) * alignment


def _build_feature_attribution(
    state: MarketState,
    action: Action,
    reward: float,
    features: dict[str, float],
    explicit_contributions: dict[str, Any] | None = None,
) -> tuple[dict[str, float], dict[str, dict[str, Any]]]:
    contributions: dict[str, float] = {}
    diagnostics: dict[str, dict[str, Any]] = {}
    if isinstance(explicit_contributions, dict):
        for family in FEATURE_FAMILIES:
            for key in (family, f"{family}_contribution"):
                if key in explicit_contributions:
                    contributions[family] = _to_float(explicit_contributions.get(key), 0.0)
                    break
    directions = _compute_feature_family_directions(state)
    for family in FEATURE_FAMILIES:
        aligned_signal = _feature_signal_for_action(state, family, action, features, directions)
        heuristic = features.get(family, 0.0) * reward * (1.0 if aligned_signal >= 0 else -1.0 if aligned_signal < 0 else 0.0)

        ablated_state = _ablate_feature_family_state(state, family)
        ablated_features = _compute_feature_family_scores(ablated_state)
        ablated_directions = _compute_feature_family_directions(ablated_state)
        ablated_signal = _feature_signal_for_action(ablated_state, family, action, ablated_features, ablated_directions)
        marginal_signal = aligned_signal - ablated_signal
        shap_like = reward * marginal_signal
        wrong_way = aligned_signal * reward < 0 and abs(aligned_signal) > 1e-6 and abs(reward) > 1e-6
        penalty = min(abs(shap_like) * 0.24, abs(reward) * 0.18) if wrong_way else 0.0
        contribution = contributions.get(family, heuristic * 0.35 + shap_like * 0.65 - penalty)
        contributions[family] = round(contribution, 6)
        diagnostics[family] = {
            "feature_score": round(features.get(family, 0.0), 6),
            "aligned_signal": round(aligned_signal, 6),
            "heuristic": round(heuristic, 6),
            "ablated_signal": round(ablated_signal, 6),
            "marginal_signal": round(marginal_signal, 6),
            "marginal_impact": round(shap_like, 6),
            "shap_like": round(shap_like, 6),
            "wrong_way": wrong_way,
            "penalty": round(penalty, 6),
            "contribution": round(contributions[family], 6),
        }
    return contributions, diagnostics


@dataclass
class FeatureContributionStats:
    count: int = 0
    wins: int = 0
    cumulative_reward: float = 0.0
    cumulative_contribution: float = 0.0
    cumulative_marginal_impact: float = 0.0
    recent_contributions: list[float] = field(default_factory=list)
    recent_marginal_impacts: list[float] = field(default_factory=list)
    recent_aligned_signals: list[float] = field(default_factory=list)
    recent_rewards: list[float] = field(default_factory=list)
    wrong_way_count: int = 0
    contexts: dict[str, dict[str, float]] = field(default_factory=dict)

    def record(self, contribution: float, reward: float, context_key: str, *, aligned_signal: float = 0.0, marginal_impact: float = 0.0, wrong_way: bool = False) -> None:
        self.count += 1
        self.cumulative_reward += reward
        self.cumulative_contribution += contribution
        self.cumulative_marginal_impact += marginal_impact
        if contribution > 0:
            self.wins += 1
        self.recent_contributions.append(contribution)
        self.recent_marginal_impacts.append(marginal_impact)
        self.recent_aligned_signals.append(aligned_signal)
        self.recent_rewards.append(reward)
        if len(self.recent_contributions) > 128:
            del self.recent_contributions[:-128]
        if len(self.recent_marginal_impacts) > 128:
            del self.recent_marginal_impacts[:-128]
        if len(self.recent_aligned_signals) > 128:
            del self.recent_aligned_signals[:-128]
        if len(self.recent_rewards) > 128:
            del self.recent_rewards[:-128]
        if wrong_way:
            self.wrong_way_count += 1
        context_state = self.contexts.setdefault(context_key, {"count": 0.0, "reward": 0.0, "contribution": 0.0, "wins": 0.0, "marginal": 0.0, "wrong_way": 0.0})
        context_state["count"] += 1
        context_state["reward"] += reward
        context_state["contribution"] += contribution
        context_state["marginal"] += marginal_impact
        if contribution > 0:
            context_state["wins"] += 1
        if wrong_way:
            context_state["wrong_way"] += 1

    def avg_contribution(self) -> float:
        return self.cumulative_contribution / max(1, self.count)

    def avg_marginal_impact(self) -> float:
        return self.cumulative_marginal_impact / max(1, self.count)

    def context_avg(self, context_key: str) -> float:
        context_state = self.contexts.get(context_key) or {}
        return _to_float(context_state.get("contribution"), 0.0) / max(1.0, _to_float(context_state.get("count"), 0.0))

    def context_marginal_avg(self, context_key: str) -> float:
        context_state = self.contexts.get(context_key) or {}
        return _to_float(context_state.get("marginal"), 0.0) / max(1.0, _to_float(context_state.get("count"), 0.0))

    def wrong_way_rate(self) -> float:
        return self.wrong_way_count / max(1, self.count)

    def rolling_correlation(self) -> float:
        return _pearson_correlation(self.recent_aligned_signals[-64:], self.recent_rewards[-64:])

    def to_dict(self) -> dict[str, Any]:
        sorted_contexts = sorted(
            self.contexts.items(),
            key=lambda item: abs(
                (_to_float(item[1].get("contribution"), 0.0) * 0.45 + _to_float(item[1].get("marginal"), 0.0) * 0.55)
                / max(1.0, _to_float(item[1].get("count"), 0.0))
            ),
            reverse=True,
        )[:5]
        return {
            "count": self.count,
            "wins": self.wins,
            "avg_contribution": round(self.avg_contribution(), 6),
            "avg_marginal_impact": round(self.avg_marginal_impact(), 6),
            "avg_reward": round(self.cumulative_reward / max(1, self.count), 6),
            "recent_avg_contribution": round(_average(self.recent_contributions[-32:]), 6),
            "recent_avg_marginal_impact": round(_average(self.recent_marginal_impacts[-32:]), 6),
            "rolling_correlation": round(self.rolling_correlation(), 6),
            "wrong_way_rate": round(self.wrong_way_rate(), 6),
            "top_contexts": [
                {
                    "context": key,
                    "count": int(_to_float(value.get("count"), 0.0)),
                    "avg_contribution": round(_to_float(value.get("contribution"), 0.0) / max(1.0, _to_float(value.get("count"), 0.0)), 6),
                    "avg_marginal_impact": round(_to_float(value.get("marginal"), 0.0) / max(1.0, _to_float(value.get("count"), 0.0)), 6),
                    "wrong_way_rate": round(_to_float(value.get("wrong_way"), 0.0) / max(1.0, _to_float(value.get("count"), 0.0)), 6),
                }
                for key, value in sorted_contexts
            ],
        }

    def load(self, payload: dict[str, Any]) -> None:
        self.count = max(0, int(payload.get("count") or 0))
        self.wins = max(0, int(payload.get("wins") or 0))
        self.cumulative_reward = _to_float(payload.get("cumulative_reward"), _to_float(payload.get("avg_reward"), 0.0) * max(1, self.count))
        self.cumulative_contribution = _to_float(payload.get("cumulative_contribution"), _to_float(payload.get("avg_contribution"), 0.0) * max(1, self.count))
        self.cumulative_marginal_impact = _to_float(payload.get("cumulative_marginal_impact"), _to_float(payload.get("avg_marginal_impact"), 0.0) * max(1, self.count))
        recent = payload.get("recent_contributions") if isinstance(payload.get("recent_contributions"), list) else []
        self.recent_contributions = [_to_float(value, 0.0) for value in recent][-128:]
        recent_marginal = payload.get("recent_marginal_impacts") if isinstance(payload.get("recent_marginal_impacts"), list) else []
        self.recent_marginal_impacts = [_to_float(value, 0.0) for value in recent_marginal][-128:]
        recent_aligned = payload.get("recent_aligned_signals") if isinstance(payload.get("recent_aligned_signals"), list) else []
        self.recent_aligned_signals = [_to_float(value, 0.0) for value in recent_aligned][-128:]
        recent_rewards = payload.get("recent_rewards") if isinstance(payload.get("recent_rewards"), list) else []
        self.recent_rewards = [_to_float(value, 0.0) for value in recent_rewards][-128:]
        self.wrong_way_count = max(0, int(payload.get("wrong_way_count") or round(_to_float(payload.get("wrong_way_rate"), 0.0) * max(1, self.count))))
        raw_contexts = payload.get("contexts") if isinstance(payload.get("contexts"), dict) else {}
        self.contexts = {
            str(key): {
                "count": _to_float(value.get("count"), 0.0),
                "reward": _to_float(value.get("reward"), 0.0),
                "contribution": _to_float(value.get("contribution"), 0.0),
                "wins": _to_float(value.get("wins"), 0.0),
                "marginal": _to_float(value.get("marginal"), 0.0),
                "wrong_way": _to_float(value.get("wrong_way"), 0.0),
            }
            for key, value in raw_contexts.items()
            if isinstance(value, dict)
        }


class FeatureAttributionTracker:
    def __init__(self) -> None:
        self.families: dict[str, FeatureContributionStats] = {family: FeatureContributionStats() for family in FEATURE_FAMILIES}

    def record(self, experience: "Experience") -> None:
        context_key = _context_signature(experience.context)
        for family in FEATURE_FAMILIES:
            contribution = _to_float(experience.feature_contributions.get(family), _to_float(experience.features.get(family), 0.0) * experience.reward)
            diagnostics = experience.feature_diagnostics.get(family) if isinstance(experience.feature_diagnostics.get(family), dict) else {}
            self.families[family].record(
                contribution,
                experience.reward,
                context_key,
                aligned_signal=_to_float(diagnostics.get("aligned_signal"), _to_float(experience.features.get(family), 0.0)),
                marginal_impact=_to_float(diagnostics.get("marginal_impact"), contribution),
                wrong_way=bool(diagnostics.get("wrong_way", False)),
            )

    def performance_multiplier(self, family: str, state: MarketState) -> float:
        stats = self.families.get(family)
        if stats is None or stats.count <= 0:
            return 1.0
        context_key = _context_signature(_build_feature_context(state))
        global_edge = math.tanh(stats.avg_contribution() / 14.0)
        marginal_edge = math.tanh(stats.avg_marginal_impact() / 12.0)
        corr_edge = stats.rolling_correlation()
        wrong_way_penalty = stats.wrong_way_rate()
        context_state = stats.contexts.get(context_key) or {}
        context_count = _to_float(context_state.get("count"), 0.0)
        context_avg = _to_float(context_state.get("contribution"), 0.0) / max(1.0, context_count)
        context_marginal = _to_float(context_state.get("marginal"), 0.0) / max(1.0, context_count)
        context_edge = math.tanh(context_avg / 10.0)
        context_marginal_edge = math.tanh(context_marginal / 9.0)
        global_confidence = min(1.0, stats.count / 32.0)
        context_confidence = min(1.0, context_count / 12.0)
        return _clamp(
            1.0
            + global_edge * 0.18 * global_confidence
            + marginal_edge * 0.18 * global_confidence
            + context_edge * 0.16 * context_confidence
            + context_marginal_edge * 0.16 * context_confidence
            + corr_edge * 0.12
            - wrong_way_penalty * 0.16,
            0.68,
            1.44,
        )

    def learning_rate_hint(self, family: str, state: MarketState) -> float:
        stats = self.families.get(family)
        if stats is None or stats.count <= 0:
            return 1.0
        context_key = _context_signature(_build_feature_context(state))
        context_avg = stats.context_avg(context_key)
        context_marginal = stats.context_marginal_avg(context_key)
        return _clamp(
            1.0
            + math.tanh(stats.avg_contribution() / 16.0) * 0.12
            + math.tanh(stats.avg_marginal_impact() / 12.0) * 0.18
            + math.tanh(context_avg / 12.0) * 0.14
            + math.tanh(context_marginal / 10.0) * 0.18
            + stats.rolling_correlation() * 0.14
            - stats.wrong_way_rate() * 0.18,
            0.55,
            1.6,
        )

    def learning_rate_multiplier(self, family: str, experience: "Experience") -> float:
        hint = self.learning_rate_hint(family, experience.state)
        diagnostics = experience.feature_diagnostics.get(family) if isinstance(experience.feature_diagnostics.get(family), dict) else {}
        shap_like = _to_float(diagnostics.get("shap_like"), 0.0)
        marginal_signal = abs(_to_float(diagnostics.get("marginal_signal"), 0.0))
        if shap_like > 0:
            hint += min(0.14, abs(shap_like) / max(12.0, abs(experience.reward) + 1.0) * 0.14)
        if bool(diagnostics.get("wrong_way", False)):
            hint -= 0.18
        elif marginal_signal > 0.08 and experience.reward > 0:
            hint += min(0.12, marginal_signal * 0.22)
        return _clamp(hint, 0.55, 1.65)

    def summary_for_state(self, state: MarketState) -> dict[str, Any]:
        context = _build_feature_context(state)
        context_key = _context_signature(context)
        families: dict[str, Any] = {}
        top_family = "n/a"
        top_contribution = 0.0
        top_magnitude = -1.0
        for family, stats in self.families.items():
            context_state = stats.contexts.get(context_key) or {}
            context_count = int(_to_float(context_state.get("count"), 0.0))
            context_avg = _to_float(context_state.get("contribution"), 0.0) / max(1.0, _to_float(context_state.get("count"), 0.0))
            context_marginal = _to_float(context_state.get("marginal"), 0.0) / max(1.0, _to_float(context_state.get("count"), 0.0))
            avg_contribution = stats.avg_contribution()
            avg_marginal = stats.avg_marginal_impact()
            multiplier = self.performance_multiplier(family, state)
            learning_rate_hint = self.learning_rate_hint(family, state)
            alpha = (
                context_avg * 0.25
                + avg_contribution * 0.2
                + context_marginal * 0.3
                + avg_marginal * 0.25
            )
            families[family] = {
                "avg_contribution": round(avg_contribution, 6),
                "context_avg_contribution": round(context_avg, 6),
                "avg_marginal_impact": round(avg_marginal, 6),
                "context_avg_marginal_impact": round(context_marginal, 6),
                "count": stats.count,
                "context_count": context_count,
                "multiplier": round(multiplier, 6),
                "rolling_correlation": round(stats.rolling_correlation(), 6),
                "wrong_way_rate": round(stats.wrong_way_rate(), 6),
                "learning_rate_hint": round(learning_rate_hint, 6),
                "alpha": round(alpha, 6),
            }
            if abs(alpha) > top_magnitude:
                top_magnitude = abs(alpha)
                top_family = family
                top_contribution = alpha
        return {
            "context": context,
            "families": families,
            "top_family": top_family,
            "top_contribution": round(top_contribution, 6),
        }

    def to_dict(self) -> dict[str, Any]:
        return {
            "families": {family: stats.to_dict() | {
                "cumulative_reward": round(stats.cumulative_reward, 6),
                "cumulative_contribution": round(stats.cumulative_contribution, 6),
                "cumulative_marginal_impact": round(stats.cumulative_marginal_impact, 6),
                "recent_contributions": [round(value, 6) for value in stats.recent_contributions[-128:]],
                "recent_marginal_impacts": [round(value, 6) for value in stats.recent_marginal_impacts[-128:]],
                "recent_aligned_signals": [round(value, 6) for value in stats.recent_aligned_signals[-128:]],
                "recent_rewards": [round(value, 6) for value in stats.recent_rewards[-128:]],
                "wrong_way_count": stats.wrong_way_count,
                "contexts": stats.contexts,
            } for family, stats in self.families.items()}
        }

    def load(self, payload: dict[str, Any]) -> None:
        families = payload.get("families") if isinstance(payload.get("families"), dict) else {}
        for family in FEATURE_FAMILIES:
            stats = self.families.setdefault(family, FeatureContributionStats())
            if isinstance(families.get(family), dict):
                stats.load(families[family])


def detect_regime(state: MarketState) -> str:
    if state.drawdown >= 6.0 or state.volatility >= 25.0 or state.latency >= 400.0 or (state.sweep_risk >= 0.72 and state.liquidity_vacuum >= 0.45):
        return "VOLATILE"
    if abs(state.imbalance) >= 0.6 or abs(state.trend_score) >= 0.45 or abs(state.momentum) >= 0.55 or abs(state.impulse_vwap_distance) >= 9.0:
        return "TREND"
    if state.volatility <= 0.2 or (abs(state.imbalance) <= 0.15 and abs(state.momentum) <= 0.1 and state.anchor_confluence >= 0.3):
        return "CHOP"
    return "NEUTRAL"


class LatentRegimeEncoder:
    def __init__(self, memory: float = 0.58) -> None:
        self.latent_dim = len(LATENT_FEATURE_NAMES)
        self.memory = _clamp(memory, 0.15, 0.92)
        self.hidden_state: list[float] = [0.0] * self.latent_dim
        self.bias: list[float] = [0.0] * self.latent_dim
        self.context_prototypes: dict[str, list[float]] = {}
        self.label_counts: dict[str, int] = {}
        self.observations = 0
        self.transition_ema = 0.0
        self.confidence_ema = 0.0

    def _observable_vector(self, state: MarketState) -> list[float]:
        return [
            _clamp(state.imbalance, -1.5, 1.5),
            _clamp(state.volatility / 20.0, -1.0, 2.0),
            _clamp(state.momentum, -2.0, 2.0),
            _clamp(state.trend_score, -1.0, 1.0),
            _clamp(state.orderflow_imbalance, -1.5, 1.5),
            _clamp(state.liquidity_pressure, -1.5, 1.5),
            _clamp(-state.distance_to_vwap / 25.0, -2.0, 2.0),
            _clamp(state.anchor_confluence, 0.0, 1.0),
            _clamp(state.spread / 10.0, 0.0, 2.0),
            _clamp(state.latency / 250.0, 0.0, 2.0),
            _clamp(state.sweep_risk, 0.0, 1.0),
            _clamp(state.liquidity_vacuum, 0.0, 1.0),
        ]

    def _regime_bias(self, regime: str) -> list[float]:
        regime_key = regime or "NEUTRAL"
        if regime_key == "TREND":
            return [0.16, -0.06, -0.04, -0.03, 0.08, 0.02]
        if regime_key == "CHOP":
            return [-0.08, 0.14, -0.02, 0.0, -0.04, -0.02]
        if regime_key == "VOLATILE":
            return [0.02, -0.08, 0.18, 0.16, 0.04, 0.14]
        return [0.0] * self.latent_dim

    def _context_key(self, state: MarketState) -> str:
        return _context_signature(_build_feature_context(state))

    def _latent_factor(self, vector: list[float]) -> str:
        if not vector:
            return "n/a"
        dominant_index = max(range(min(len(vector), len(LATENT_FEATURE_NAMES))), key=lambda index: abs(vector[index]))
        return LATENT_FEATURE_NAMES[dominant_index].replace("latent_", "")

    def _label_for_vector(self, vector: list[float], state: MarketState | None = None) -> str:
        padded = [vector[index] if index < len(vector) else 0.0 for index in range(self.latent_dim)]
        trend, reversion, stress, friction, persistence, volatility = padded
        if max(stress, volatility, friction * 0.85) >= 0.45:
            return "stress"
        if trend >= 0.28 and persistence >= 0.12:
            return "impulse-trend"
        if reversion >= 0.26 and abs(trend) <= 0.32:
            return "mean-revert"
        if state is not None and state.anchor_confluence >= 0.35 and abs(state.distance_to_vwap) <= 18.0 and reversion >= 0.14:
            return "compression"
        if abs(persistence) >= 0.16 and abs(trend) <= 0.18 and abs(reversion) <= 0.2:
            return "auction"
        return "balanced"

    def encode(self, state: MarketState, prev_vector: list[float] | None = None, *, update_hidden: bool = False) -> tuple[list[float], str, float, float]:
        basis = (
            (0.62, 0.14, 0.12, 0.18, 0.46, 0.04, -0.18, 0.12, -0.06, -0.02, 0.0, -0.08),
            (-0.34, -0.18, 0.06, 0.12, -0.22, 0.42, 0.54, -0.06, 0.28, 0.18, -0.14, 0.0),
            (0.08, 0.44, 0.18, 0.26, 0.0, -0.12, 0.12, 0.36, 0.52, 0.34, 0.48, 0.22),
            (-0.16, 0.18, 0.06, -0.08, -0.18, 0.12, -0.12, 0.0, 0.42, 0.56, 0.18, 0.32),
            (0.32, 0.12, 0.08, 0.12, 0.26, 0.14, 0.08, 0.18, -0.06, -0.08, 0.0, 0.16),
            (0.12, 0.52, 0.18, 0.1, 0.04, -0.16, 0.08, 0.22, 0.28, 0.16, 0.58, 0.26),
        )
        previous = list(prev_vector[: self.latent_dim]) if isinstance(prev_vector, list) and prev_vector else list(self.hidden_state)
        if len(previous) < self.latent_dim:
            previous.extend([0.0] * (self.latent_dim - len(previous)))
        observable = self._observable_vector(state)
        prototype = self.context_prototypes.get(self._context_key(state), [0.0] * self.latent_dim)
        regime_bias = self._regime_bias(state.regime)
        vector: list[float] = []
        for index in range(self.latent_dim):
            projection = sum(observable[column] * basis[index][column] for column in range(len(observable)))
            raw = self.bias[index] + regime_bias[index] + previous[index] * self.memory + projection + prototype[index] * 0.22
            vector.append(_clamp(math.tanh(raw), -1.0, 1.0))
        transition = _clamp(_average([abs(vector[index] - previous[index]) for index in range(self.latent_dim)]), 0.0, 1.0)
        label = self._label_for_vector(vector, state)
        confidence = _clamp(max(abs(value) for value in vector) * 0.72 + transition * 0.35, 0.0, 1.0)
        if update_hidden:
            self.hidden_state = list(vector)
            self.observations += 1
            self.transition_ema = self.transition_ema * 0.92 + transition * 0.08
            self.confidence_ema = self.confidence_ema * 0.92 + confidence * 0.08
        return vector, label, confidence, transition

    def enrich_state(self, state: MarketState, prev_vector: list[float] | None = None, *, update_hidden: bool = False) -> MarketState:
        vector, label, confidence, transition = self.encode(state, prev_vector=prev_vector, update_hidden=update_hidden)
        return replace(
            state,
            latent_vector=[round(value, 6) for value in vector],
            latent_label=label,
            latent_confidence=round(confidence, 6),
            latent_transition=round(transition, 6),
        )

    def observe_experience(self, experience: "Experience") -> None:
        experience.state = self.enrich_state(experience.state, update_hidden=False)
        experience.next_state = self.enrich_state(experience.next_state, prev_vector=experience.state.latent_vector, update_hidden=True)
        experience.context.setdefault("latent", experience.state.latent_label)
        experience.context.setdefault("latent_next", experience.next_state.latent_label)
        self.label_counts[experience.state.latent_label] = self.label_counts.get(experience.state.latent_label, 0) + 1
        context_key = self._context_key(experience.state)
        prototype = list(self.context_prototypes.get(context_key, [0.0] * self.latent_dim))
        if len(prototype) < self.latent_dim:
            prototype.extend([0.0] * (self.latent_dim - len(prototype)))
        blend = 0.12 if experience.reward >= 0 else 0.06
        for index in range(self.latent_dim):
            prototype[index] = _clamp(prototype[index] * (1.0 - blend) + experience.next_state.latent_vector[index] * blend, -1.0, 1.0)
            delta = experience.next_state.latent_vector[index] - experience.state.latent_vector[index]
            reward_scale = _clamp(abs(experience.reward) / (12.0 + abs(experience.reward)), 0.02, 0.12) * _clamp(experience.sample_weight, 0.15, 1.0)
            reward_sign = 1.0 if experience.reward > 0 else -1.0 if experience.reward < 0 else 0.0
            self.bias[index] = _clamp(self.bias[index] + reward_sign * delta * reward_scale * 0.18, -0.75, 0.75)
        self.context_prototypes[context_key] = [round(value, 6) for value in prototype]

    def summary(self) -> dict[str, Any]:
        sorted_labels = sorted(self.label_counts.items(), key=lambda item: item[1], reverse=True)[:4]
        return {
            "observations": self.observations,
            "current_label": self._label_for_vector(self.hidden_state),
            "dominant_factor": self._latent_factor(self.hidden_state),
            "confidence_ema": round(self.confidence_ema, 6),
            "transition_ema": round(self.transition_ema, 6),
            "top_labels": [{"label": label, "count": count} for label, count in sorted_labels],
        }

    def to_dict(self) -> dict[str, Any]:
        return {
            "memory": round(self.memory, 6),
            "hidden_state": [round(value, 6) for value in self.hidden_state],
            "bias": [round(value, 6) for value in self.bias],
            "context_prototypes": {key: [round(value, 6) for value in vector[: self.latent_dim]] for key, vector in self.context_prototypes.items()},
            "label_counts": self.label_counts,
            "observations": self.observations,
            "transition_ema": round(self.transition_ema, 6),
            "confidence_ema": round(self.confidence_ema, 6),
        }

    def load(self, payload: dict[str, Any]) -> None:
        self.memory = _clamp(_to_float(payload.get("memory"), self.memory), 0.15, 0.92)
        raw_hidden = payload.get("hidden_state") if isinstance(payload.get("hidden_state"), list) else []
        self.hidden_state = [_clamp(_to_float(value, 0.0), -1.0, 1.0) for value in raw_hidden[: self.latent_dim]]
        if len(self.hidden_state) < self.latent_dim:
            self.hidden_state.extend([0.0] * (self.latent_dim - len(self.hidden_state)))
        raw_bias = payload.get("bias") if isinstance(payload.get("bias"), list) else []
        self.bias = [_clamp(_to_float(value, 0.0), -0.75, 0.75) for value in raw_bias[: self.latent_dim]]
        if len(self.bias) < self.latent_dim:
            self.bias.extend([0.0] * (self.latent_dim - len(self.bias)))
        raw_prototypes = payload.get("context_prototypes") if isinstance(payload.get("context_prototypes"), dict) else {}
        self.context_prototypes = {
            str(key): [_clamp(_to_float(value, 0.0), -1.0, 1.0) for value in vector[: self.latent_dim]]
            for key, vector in raw_prototypes.items()
            if isinstance(vector, list)
        }
        for vector in self.context_prototypes.values():
            if len(vector) < self.latent_dim:
                vector.extend([0.0] * (self.latent_dim - len(vector)))
        raw_counts = payload.get("label_counts") if isinstance(payload.get("label_counts"), dict) else {}
        self.label_counts = {str(key): max(0, int(value)) for key, value in raw_counts.items()}
        self.observations = max(0, int(payload.get("observations") or 0))
        self.transition_ema = _clamp(_to_float(payload.get("transition_ema"), 0.0), 0.0, 1.0)
        self.confidence_ema = _clamp(_to_float(payload.get("confidence_ema"), 0.0), 0.0, 1.0)


@dataclass
class Experience:
    state: MarketState
    action: Action
    reward: float
    next_state: MarketState
    experience_id: str = ""
    sample_weight: float = 1.0
    synthetic: bool = False
    dream_source: str = "real"
    features: dict[str, float] = field(default_factory=dict)
    feature_contributions: dict[str, float] = field(default_factory=dict)
    feature_diagnostics: dict[str, dict[str, Any]] = field(default_factory=dict)
    context: dict[str, Any] = field(default_factory=dict)
    raw_reward: float = 0.0
    reward_scale: float = 1.0
    agent_learning_rate_hints: dict[str, dict[str, Any]] = field(default_factory=dict)
    failure_source: str | None = None
    failure_reasons: list[str] = field(default_factory=list)
    failure_blocking: bool = False

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "Experience | None":
        candidate = payload.get("experience") if isinstance(payload.get("experience"), dict) else payload
        if not isinstance(candidate, dict):
            return None
        has_explicit_state = any(
            isinstance(candidate.get(key), dict)
            for key in ("state", "next_state", "nextState")
        )
        if candidate.get("action") is None and not has_explicit_state:
            return None
        state_payload = candidate.get("state") if isinstance(candidate.get("state"), dict) else candidate
        next_state_payload = candidate.get("next_state") if isinstance(candidate.get("next_state"), dict) else candidate.get("nextState") if isinstance(candidate.get("nextState"), dict) else state_payload
        state = MarketState.from_payload(state_payload)
        next_state = MarketState.from_payload(next_state_payload)
        action = Action.from_value(candidate.get("action"))
        reward = _to_float(candidate.get("reward"), math.nan)
        raw_reward = _to_float(candidate.get("raw_reward"), math.nan)
        reward_scale = _to_float(candidate.get("reward_scale"), math.nan)
        failure_source = _normalize_failure_source(candidate.get("failure_source"))
        failure_reasons = _normalize_reason_list(candidate.get("failure_reasons"))
        failure_blocking = _coerce_failure_blocking(candidate.get("failure_blocking"))
        raw_learning_rate_hints = candidate.get("agent_learning_rate_hints") if isinstance(candidate.get("agent_learning_rate_hints"), dict) else {}
        persisted_adjusted_reward = math.isfinite(reward_scale) or (
            math.isfinite(raw_reward)
            and math.isfinite(reward)
            and abs(raw_reward - reward) > 1e-9
        )
        if not math.isfinite(raw_reward) and math.isfinite(reward):
            raw_reward = reward
        if not math.isfinite(raw_reward):
            pnl = _to_float(candidate.get("pnl"), next_state.pnl - state.pnl)
            drawdown = _to_float(candidate.get("drawdown"), next_state.drawdown if next_state.drawdown > 0 else state.drawdown)
            latency = _to_float(candidate.get("latency"), next_state.latency if next_state.latency > 0 else state.latency)
            sharpe = _to_float(candidate.get("sharpe"), _to_float(candidate.get("sharpe_ratio"), 0.0))
            raw_reward = compute_reward(
                pnl=pnl,
                drawdown=drawdown,
                latency=latency,
                sharpe=sharpe,
                infra_health=next_state.infra_health if next_state.infra_health > 0 else state.infra_health,
            )
        if persisted_adjusted_reward and math.isfinite(reward):
            resolved_reward = reward
            resolved_scale = _clamp(
                reward_scale if math.isfinite(reward_scale) else (resolved_reward / raw_reward if abs(raw_reward) > 1e-9 else 1.0),
                0.05,
                1.0,
            )
        else:
            resolved_reward, resolved_scale = _apply_failure_reward_adjustment(
                raw_reward,
                failure_source,
                failure_blocking,
                state,
                next_state,
            )
        derived_features = _compute_feature_family_scores(state)
        explicit_features = candidate.get("features") if isinstance(candidate.get("features"), dict) else None
        features = _merge_feature_scores(explicit_features, derived_features)
        explicit_contributions = candidate.get("feature_contributions") if isinstance(candidate.get("feature_contributions"), dict) else None
        feature_contributions, feature_diagnostics = _build_feature_attribution(state, action, resolved_reward, features, explicit_contributions)
        context = _build_feature_context(state)
        if isinstance(candidate.get("context"), dict):
            for key, value in candidate.get("context", {}).items():
                context[str(key)] = str(value)
        return cls(
            experience_id=str(candidate.get("experience_id") or candidate.get("decision_id") or candidate.get("id") or candidate.get("event_id") or "").strip(),
            state=state,
            action=action,
            reward=resolved_reward,
            next_state=next_state,
            sample_weight=_clamp(_to_float(candidate.get("sample_weight"), 1.0), 0.05, 1.0),
            synthetic=bool(candidate.get("synthetic", False)),
            dream_source=str(candidate.get("dream_source") or ("synthetic" if candidate.get("synthetic") else "real")).strip() or "real",
            features=features,
            feature_contributions=feature_contributions,
            feature_diagnostics=feature_diagnostics,
            context=context,
            raw_reward=raw_reward,
            reward_scale=resolved_scale,
            agent_learning_rate_hints={
                str(agent_name): {
                    str(key): value
                    for key, value in payload.items()
                }
                for agent_name, payload in raw_learning_rate_hints.items()
                if isinstance(payload, dict)
            },
            failure_source=failure_source,
            failure_reasons=failure_reasons,
            failure_blocking=failure_blocking,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "experience_id": self.experience_id,
            "state": self.state.to_dict(),
            "action": self.action.value,
            "reward": self.reward,
            "raw_reward": self.raw_reward,
            "reward_scale": self.reward_scale,
            "agent_learning_rate_hints": self.agent_learning_rate_hints,
            "next_state": self.next_state.to_dict(),
            "sample_weight": self.sample_weight,
            "synthetic": self.synthetic,
            "dream_source": self.dream_source,
            "features": self.features,
            "feature_contributions": self.feature_contributions,
            "feature_diagnostics": self.feature_diagnostics,
            "context": self.context,
            "failure_source": self.failure_source,
            "failure_reasons": self.failure_reasons,
            "failure_blocking": self.failure_blocking,
        }


class ReplayBuffer:
    def __init__(self, capacity: int = 100000) -> None:
        self.capacity = max(1, capacity)
        self.buffer: list[Experience] = []
        self.dream_capacity = max(16, self.capacity // 3)
        self.dream_buffer: list[Experience] = []

    def push(self, exp: Experience) -> None:
        target = self.dream_buffer if exp.synthetic else self.buffer
        limit = self.dream_capacity if exp.synthetic else self.capacity
        target.append(exp)
        if len(target) > limit:
            del target[:-limit]

    def bootstrap(self, rows: list[dict[str, Any]]) -> int:
        accepted = 0
        for row in rows:
            exp = Experience.from_payload(row)
            if exp is None:
                continue
            self.push(exp)
            accepted += 1
        return accepted

    def sample(self, batch_size: int) -> list[Experience]:
        if batch_size <= 0 or (not self.buffer and not self.dream_buffer):
            return []
        if not self.buffer:
            return self._priority_sample(self.dream_buffer, min(batch_size, len(self.dream_buffer)))
        dream_target = min(len(self.dream_buffer), max(0, int(math.ceil(batch_size * 0.3))))
        real_target = min(len(self.buffer), max(1, batch_size - dream_target))
        if real_target + dream_target < batch_size:
            extra_dream = min(len(self.dream_buffer) - dream_target, batch_size - real_target - dream_target)
            dream_target += max(0, extra_dream)
        sample = self._priority_sample(self.buffer, real_target)
        sample.extend(self._priority_sample(self.dream_buffer, dream_target))
        random.shuffle(sample)
        return sample[:batch_size]

    def _priority_sample(self, source: list[Experience], count: int) -> list[Experience]:
        if count <= 0 or not source:
            return []
        scored: list[tuple[float, Experience]] = []
        total = len(source)
        for index, exp in enumerate(source):
            recency = 0.35 + 0.65 * ((index + 1) / total)
            novelty = 1.24 if exp.state.regime != exp.next_state.regime or exp.state.latent_label != exp.next_state.latent_label else 1.0
            latent_shift = 1.0 + min(0.24, exp.state.latent_transition * 0.35)
            synthetic_penalty = 0.74 if exp.synthetic else 1.0
            priority = (abs(exp.reward) + 0.25) * recency * novelty * latent_shift * _clamp(exp.sample_weight, 0.05, 1.0) * synthetic_penalty * random.uniform(0.72, 1.18)
            scored.append((priority, exp))
        scored.sort(key=lambda item: item[0], reverse=True)
        return [exp for _, exp in scored[: min(count, len(scored))]]

    def stats(self) -> dict[str, Any]:
        experiences = [*self.buffer, *self.dream_buffer]
        rewards = [exp.reward for exp in experiences]
        dream_rewards = [exp.reward for exp in self.dream_buffer]
        return {
            "size": len(experiences),
            "capacity": self.capacity,
            "real_size": len(self.buffer),
            "dream_size": len(self.dream_buffer),
            "dream_ratio": round(len(self.dream_buffer) / max(1, len(experiences)), 6),
            "avg_reward": round(_average(rewards), 6),
            "positive_ratio": round(sum(1 for reward in rewards if reward > 0) / max(1, len(rewards)), 4),
            "dream_avg_reward": round(_average(dream_rewards), 6),
            "dream_positive_ratio": round(sum(1 for reward in dream_rewards if reward > 0) / max(1, len(dream_rewards)), 4),
            "dream_avg_weight": round(_average([exp.sample_weight for exp in self.dream_buffer]), 6),
        }


@dataclass
class AgentPerformance:
    total_updates: int = 0
    wins: int = 0
    losses: int = 0
    cumulative_reward: float = 0.0
    recent_rewards: list[float] = field(default_factory=list)
    regime_stats: dict[str, dict[str, float]] = field(default_factory=dict)
    weight_multiplier: float = 1.0
    learning_rate_multiplier: float = 1.0
    feature_learning_rate_multiplier: float = 1.0
    failure_learning_rate_multiplier: float = 1.0
    effective_learning_rate: float = 0.0
    dominant_failure_source: str | None = None

    @property
    def win_rate(self) -> float:
        prior_wins = 3.0
        prior_total = 5.0
        return (self.wins + prior_wins) / max(1.0, self.total_updates + prior_total)

    def win_rate_for_regime(self, regime: str) -> float:
        regime_key = regime or "NEUTRAL"
        regime_state = self.regime_stats.get(regime_key) or {}
        prior_wins = 1.5
        prior_total = 3.0
        return (_to_float(regime_state.get("wins"), 0.0) + prior_wins) / max(1.0, _to_float(regime_state.get("count"), 0.0) + prior_total)

    def record(self, regime: str, reward: float) -> None:
        self.total_updates += 1
        self.cumulative_reward += reward
        if reward > 0:
            self.wins += 1
        elif reward < 0:
            self.losses += 1
        self.recent_rewards.append(reward)
        if len(self.recent_rewards) > 256:
            del self.recent_rewards[:-256]

        regime_key = regime or "NEUTRAL"
        regime_state = self.regime_stats.setdefault(regime_key, {"count": 0.0, "wins": 0.0, "reward": 0.0})
        regime_state["count"] += 1
        regime_state["reward"] += reward
        if reward > 0:
            regime_state["wins"] += 1

        reward_alpha = math.tanh(_average(self.recent_rewards[-32:]) / 25.0)
        self.weight_multiplier = _clamp(0.55 + self.win_rate * 0.9 + reward_alpha * 0.35, 0.25, 2.2)

    def to_dict(self) -> dict[str, Any]:
        return {
            "total_updates": self.total_updates,
            "wins": self.wins,
            "losses": self.losses,
            "cumulative_reward": self.cumulative_reward,
            "recent_rewards": self.recent_rewards[-64:],
            "regime_stats": self.regime_stats,
            "weight_multiplier": self.weight_multiplier,
            "learning_rate_multiplier": self.learning_rate_multiplier,
            "feature_learning_rate_multiplier": self.feature_learning_rate_multiplier,
            "failure_learning_rate_multiplier": self.failure_learning_rate_multiplier,
            "effective_learning_rate": self.effective_learning_rate,
            "dominant_failure_source": self.dominant_failure_source,
        }

    def load(self, payload: dict[str, Any]) -> None:
        self.total_updates = max(0, int(payload.get("total_updates") or 0))
        self.wins = max(0, int(payload.get("wins") or 0))
        self.losses = max(0, int(payload.get("losses") or 0))
        self.cumulative_reward = _to_float(payload.get("cumulative_reward"), 0.0)
        rewards = payload.get("recent_rewards") if isinstance(payload.get("recent_rewards"), list) else []
        self.recent_rewards = [_to_float(value, 0.0) for value in rewards][-64:]
        regime_stats = payload.get("regime_stats") if isinstance(payload.get("regime_stats"), dict) else {}
        self.regime_stats = {
            str(key): {
                "count": _to_float(value.get("count"), 0.0),
                "wins": _to_float(value.get("wins"), 0.0),
                "reward": _to_float(value.get("reward"), 0.0),
            }
            for key, value in regime_stats.items()
            if isinstance(value, dict)
        }
        self.weight_multiplier = _clamp(_to_float(payload.get("weight_multiplier"), 1.0), 0.25, 2.2)
        self.learning_rate_multiplier = _clamp(_to_float(payload.get("learning_rate_multiplier"), 1.0), 0.35, 1.85)
        self.feature_learning_rate_multiplier = _clamp(_to_float(payload.get("feature_learning_rate_multiplier"), 1.0), 0.55, 1.65)
        self.failure_learning_rate_multiplier = _clamp(_to_float(payload.get("failure_learning_rate_multiplier"), 1.0), 0.42, 1.22)
        self.effective_learning_rate = max(0.0, _to_float(payload.get("effective_learning_rate"), 0.0))
        self.dominant_failure_source = _normalize_failure_source(payload.get("dominant_failure_source"))


class FailureSourceLearningRateCalibrator:
    def __init__(self) -> None:
        self.sources: dict[str, dict[str, Any]] = {
            source: {
                "sample_count": 0,
                "real_count": 0,
                "synthetic_count": 0,
                "effective_sample_weight": 0.0,
                "cumulative_reward": 0.0,
                "agent_signals": {agent_name: 0.0 for agent_name in AGENT_FAMILY_MAP},
            }
            for source in FAILURE_SOURCE_AGENT_LR_MAP
        }

    def observe_experience(self, experience: "Experience") -> None:
        failure_source = _normalize_failure_source(experience.failure_source)
        if failure_source is None:
            return
        bucket = self.sources.setdefault(
            failure_source,
            {
                "sample_count": 0,
                "real_count": 0,
                "synthetic_count": 0,
                "effective_sample_weight": 0.0,
                "cumulative_reward": 0.0,
                "agent_signals": {agent_name: 0.0 for agent_name in AGENT_FAMILY_MAP},
            },
        )
        sample_weight = _clamp(experience.sample_weight, 0.05, 1.0)
        effective_weight = sample_weight * (0.32 if experience.synthetic else 1.0)
        if experience.failure_blocking:
            effective_weight *= 1.08
        bucket["sample_count"] += 1
        if experience.synthetic:
            bucket["synthetic_count"] += 1
        else:
            bucket["real_count"] += 1
        bucket["effective_sample_weight"] += effective_weight
        bucket["cumulative_reward"] += experience.reward * effective_weight
        for agent_name in AGENT_FAMILY_MAP:
            bucket["agent_signals"][agent_name] += self._agent_signal(agent_name, experience) * effective_weight

    def multiplier_for_experience(self, agent_name: str, experience: "Experience") -> float | None:
        failure_source = _normalize_failure_source(experience.failure_source)
        if failure_source is None:
            return None
        source_summary = self.source_summary(failure_source)
        multipliers = source_summary.get("multipliers") if isinstance(source_summary.get("multipliers"), dict) else {}
        return _clamp(_to_float(multipliers.get(agent_name), FAILURE_SOURCE_AGENT_LR_MAP.get(failure_source, {}).get(agent_name, 1.0)), 0.42, 1.22)

    def source_summary(self, failure_source: str | None) -> dict[str, Any]:
        normalized = _normalize_failure_source(failure_source)
        if normalized is None:
            return {
                "calibrated": False,
                "confidence": 0.0,
                "sample_count": 0,
                "real_count": 0,
                "synthetic_count": 0,
                "effective_sample_weight": 0.0,
                "average_reward": 0.0,
                "multipliers": {},
                "agent_signals": {},
            }
        bucket = self.sources.setdefault(
            normalized,
            {
                "sample_count": 0,
                "real_count": 0,
                "synthetic_count": 0,
                "effective_sample_weight": 0.0,
                "cumulative_reward": 0.0,
                "agent_signals": {agent_name: 0.0 for agent_name in AGENT_FAMILY_MAP},
            },
        )
        effective_weight = max(0.0, _to_float(bucket.get("effective_sample_weight"), 0.0))
        confidence = _clamp(effective_weight / 6.0, 0.0, 0.85)
        averaged_signals = {
            agent_name: _to_float(bucket.get("agent_signals", {}).get(agent_name), 0.0) / max(effective_weight, 1e-6)
            for agent_name in AGENT_FAMILY_MAP
        }
        signal_values = list(averaged_signals.values())
        high = max(signal_values) if signal_values else 0.0
        low = min(signal_values) if signal_values else 0.0
        spread = max(0.0, high - low)
        if spread <= 1e-9:
            normalized_signals = {
                agent_name: 0.5 if high > 0 else 0.0
                for agent_name in AGENT_FAMILY_MAP
            }
        else:
            normalized_signals = {
                agent_name: _clamp((value - low) / spread, 0.0, 1.0)
                for agent_name, value in averaged_signals.items()
            }
        multipliers: dict[str, float] = {}
        for agent_name in AGENT_FAMILY_MAP:
            prior = _to_float(FAILURE_SOURCE_AGENT_LR_MAP.get(normalized, {}).get(agent_name), 1.0)
            signal = normalized_signals.get(agent_name, 0.0)
            if normalized == "infra":
                empirical = 1.0 - 0.64 * signal
                if agent_name == "risk":
                    empirical = max(0.96, empirical)
            elif normalized == "market":
                empirical = 0.92 + 0.28 * signal
                if agent_name in {"scalper", "trend"}:
                    empirical += 0.04
            else:
                empirical = 0.88 + 0.32 * signal
                if agent_name == "execution":
                    empirical += 0.08
            multipliers[agent_name] = round(_clamp(prior * (1.0 - confidence) + empirical * confidence, 0.42, 1.22), 6)
        sample_count = max(0, int(bucket.get("sample_count") or 0))
        real_count = max(0, int(bucket.get("real_count") or 0))
        synthetic_count = max(0, int(bucket.get("synthetic_count") or 0))
        return {
            "calibrated": confidence > 0.0,
            "confidence": round(confidence, 6),
            "sample_count": sample_count,
            "real_count": real_count,
            "synthetic_count": synthetic_count,
            "effective_sample_weight": round(effective_weight, 6),
            "average_reward": round(_to_float(bucket.get("cumulative_reward"), 0.0) / max(effective_weight, 1e-6), 6) if effective_weight > 0 else 0.0,
            "multipliers": multipliers,
            "agent_signals": {agent_name: round(value, 6) for agent_name, value in averaged_signals.items()},
        }

    def summary(self) -> dict[str, Any]:
        return {
            "sources": {
                source: self.source_summary(source)
                for source in FAILURE_SOURCE_AGENT_LR_MAP
            }
        }

    def _agent_signal(self, agent_name: str, experience: "Experience") -> float:
        families = AGENT_FAMILY_MAP.get(agent_name, ())
        if not families:
            return 0.0
        family_signal = 0.0
        for family in families:
            diagnostics = experience.feature_diagnostics.get(family) if isinstance(experience.feature_diagnostics.get(family), dict) else {}
            contribution = abs(_to_float(diagnostics.get("contribution"), _to_float(experience.feature_contributions.get(family), 0.0)))
            if contribution <= 1e-9:
                contribution = abs(_to_float(experience.features.get(family), 0.0)) * 0.08
            learning_rate_hint = _to_float(diagnostics.get("learning_rate_hint"), 1.0)
            contribution *= 0.82 + min(1.35, learning_rate_hint) * 0.18
            if bool(diagnostics.get("wrong_way")):
                contribution *= 1.18
            family_signal += contribution
        family_signal /= max(1, len(families))

        infra_pressure = _clamp(1.0 - _clamp((experience.state.infra_health + experience.next_state.infra_health) / 2.0, 0.05, 1.0), 0.0, 0.95)
        execution_pressure = _clamp(
            max(experience.state.latency, experience.next_state.latency) / 350.0
            + max(experience.state.slippage, experience.next_state.slippage) / 18.0
            + max(0.0, 0.55 - max(experience.state.fill_probability, experience.next_state.fill_probability)),
            0.0,
            1.4,
        )
        market_pressure = _clamp(abs(experience.raw_reward) / 12.0, 0.0, 1.4)

        failure_source = _normalize_failure_source(experience.failure_source)
        if failure_source == "infra":
            if agent_name in {"trend", "scalper"}:
                family_signal += infra_pressure * 0.14
            elif agent_name == "liquidity":
                family_signal += infra_pressure * 0.08
        elif failure_source == "market":
            if agent_name in {"trend", "scalper"}:
                family_signal += market_pressure * 0.1
            elif agent_name == "liquidity":
                family_signal += market_pressure * 0.04
        elif failure_source == "execution":
            if agent_name == "execution":
                family_signal += 0.18 + execution_pressure * 0.18
            elif agent_name == "liquidity":
                family_signal += execution_pressure * 0.08

        if experience.failure_blocking:
            family_signal *= 1.06
        return _clamp(family_signal, 0.0, 4.0)


@dataclass
class AgentVote:
    name: str
    action: Action
    confidence: float
    calibrated_confidence: float
    raw_score: float
    weight: float
    reasoning: str
    veto_close: bool = False
    base_weight: float = 1.0
    meta_weight: float = 1.0
    disabled: bool = False
    calibration_factor: float = 1.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "action": self.action.value,
            "confidence": round(self.confidence, 6),
            "calibrated_confidence": round(self.calibrated_confidence, 6),
            "raw_score": round(self.raw_score, 6),
            "weight": round(self.weight, 6),
            "base_weight": round(self.base_weight, 6),
            "meta_weight": round(self.meta_weight, 6),
            "disabled": self.disabled,
            "calibration_factor": round(self.calibration_factor, 6),
            "reasoning": self.reasoning,
            "veto_close": self.veto_close,
        }


class SpecialistAgent:
    def __init__(self, name: str, feature_weights: dict[str, float], bias: float = 0.0, learning_rate: float = 0.018) -> None:
        self.name = name
        self.feature_weights = dict(feature_weights)
        self.bias = bias
        self.base_learning_rate = learning_rate
        self.learning_rate = learning_rate
        self.performance = AgentPerformance()

    def family_focus(self) -> tuple[str, ...]:
        return AGENT_FAMILY_MAP.get(self.name, ("regime",))

    def _feature_map(self, state: MarketState) -> dict[str, float]:
        position_sign = 0.0
        if state.position > 0:
            position_sign = 1.0
        elif state.position < 0:
            position_sign = -1.0
        feature_map = {
            "spread": _clamp(state.spread / 12.0, -3.0, 3.0),
            "imbalance": _clamp(state.imbalance, -1.5, 1.5),
            "volatility": _clamp(state.volatility / 15.0, -2.0, 4.0),
            "position": position_sign,
            "pnl": _clamp(state.pnl / 1000.0, -4.0, 4.0),
            "drawdown": _clamp(state.drawdown / 10.0, 0.0, 4.0),
            "latency": _clamp(state.latency / 120.0, 0.0, 5.0),
            "depth": _clamp(state.depth / 200000.0, 0.0, 4.0),
            "volume": _clamp(state.volume / 1000000.0, 0.0, 4.0),
            "fill_probability": _clamp(state.fill_probability * 2.0 - 1.0, -1.0, 1.0),
            "infra_health": _clamp(state.infra_health * 2.0 - 1.0, -1.0, 1.0),
            "infra_degraded": 1.0 if state.network_regime == "degraded" else 0.0,
            "infra_critical": 1.0 if state.network_regime == "critical" else 0.0,
            "backlog": _clamp(state.backlog, 0.0, 4.0),
            "render_pressure": _clamp(state.render_pressure, 0.0, 4.0),
            "edge": _clamp(state.edge / 10.0, -4.0, 4.0),
            "momentum": _clamp(state.momentum, -2.0, 2.0),
            "slippage": _clamp(state.slippage / 8.0, 0.0, 4.0),
            "micro_burst": _clamp(state.micro_burst / 8.0, 0.0, 3.0),
            "quote_fade": _clamp(state.quote_fade, 0.0, 3.0),
            "book_flip": _clamp(state.book_flip, -1.0, 1.0),
            "trend_score": _clamp(state.trend_score, -1.0, 1.0),
            "model_probability": _clamp(state.model_probability, 0.0, 1.0),
            "orderflow_delta": _clamp(state.orderflow_delta / max(state.volume, 1.0), -2.5, 2.5),
            "cumulative_delta": _clamp(state.cumulative_delta / 25000.0, -3.0, 3.0),
            "orderflow_imbalance": _clamp(state.orderflow_imbalance, -1.5, 1.5),
            "absorption_signal": _clamp(state.absorption_signal, -1.0, 1.0),
            "liquidity_trap_signal": _clamp(state.liquidity_trap_signal, -1.0, 1.0),
            "spoofing_score": _clamp(state.spoofing_score, -1.0, 1.0),
            "distance_to_vwap": _clamp(state.distance_to_vwap / 35.0, -3.0, 3.0),
            "vwap_slope": _clamp(state.vwap_slope / 20.0, -2.0, 2.0),
            "orderflow_quality": _clamp(state.orderflow_quality, 0.0, 1.0),
            "session_vwap_distance": _clamp(state.session_vwap_distance / 20.0, -3.0, 3.0),
            "day_vwap_distance": _clamp(state.day_vwap_distance / 25.0, -3.0, 3.0),
            "week_vwap_distance": _clamp(state.week_vwap_distance / 35.0, -3.0, 3.0),
            "month_vwap_distance": _clamp(state.month_vwap_distance / 45.0, -3.0, 3.0),
            "swing_vwap_distance": _clamp(state.swing_vwap_distance / 25.0, -3.0, 3.0),
            "impulse_vwap_distance": _clamp(state.impulse_vwap_distance / 20.0, -3.0, 3.0),
            "anchor_confluence": _clamp(state.anchor_confluence, 0.0, 1.0),
            "anchor_compression": _clamp(state.anchor_compression / 30.0, 0.0, 3.0),
            "liquidity_pressure": _clamp(state.liquidity_pressure, -1.5, 1.5),
            "resting_imbalance": _clamp(state.resting_imbalance, -1.5, 1.5),
            "sweep_risk": _clamp(state.sweep_risk, 0.0, 1.0),
            "liquidity_vacuum": _clamp(state.liquidity_vacuum, 0.0, 1.0),
            "support_score": _clamp(state.support_score, 0.0, 1.0),
            "resistance_score": _clamp(state.resistance_score, 0.0, 1.0),
            "liquidity_engine_score": _clamp(state.liquidity_engine_score, 0.0, 1.0),
            "regime_trend": 1.0 if state.regime == "TREND" else 0.0,
            "regime_chop": 1.0 if state.regime == "CHOP" else 0.0,
            "regime_volatile": 1.0 if state.regime == "VOLATILE" else 0.0,
            "latent_confidence": _clamp(state.latent_confidence, 0.0, 1.0),
            "latent_transition": _clamp(state.latent_transition * 2.0, 0.0, 2.0),
        }
        for index, feature_name in enumerate(LATENT_FEATURE_NAMES):
            feature_map[feature_name] = _clamp(state.latent_vector[index] if index < len(state.latent_vector) else 0.0, -1.0, 1.0)
        return feature_map

    def predict(self, state: MarketState) -> AgentVote:
        if self.name == "risk":
            return self._predict_risk(state)
        features = self._feature_map(state)
        raw_score = self.bias + sum(self.feature_weights.get(key, 0.0) * value for key, value in features.items())
        confidence = _sigmoid(abs(raw_score) * 1.45)
        regime_win_rate = self.performance.win_rate_for_regime(state.regime)
        calibrated_confidence = calibrate(
            confidence,
            self.performance.win_rate,
            regime_win_rate=regime_win_rate,
            volatility=state.volatility,
            spread=state.spread,
            latency=state.latency,
            fill_probability=state.fill_probability,
            orderflow_quality=state.orderflow_quality,
            infra_health=state.infra_health,
            network_regime=state.network_regime,
        )
        action = Action.HOLD if abs(raw_score) < 0.08 else Action.BUY if raw_score > 0 else Action.SELL
        reasoning = f"score={raw_score:.3f} regime={state.regime} edge={state.edge:.2f} drawdown={state.drawdown:.2f}"
        calibration_factor = calibrated_confidence / max(confidence, 1e-6)
        return AgentVote(
            name=self.name,
            action=action,
            confidence=confidence,
            calibrated_confidence=calibrated_confidence,
            raw_score=raw_score,
            weight=self.performance.weight_multiplier,
            base_weight=self.performance.weight_multiplier,
            meta_weight=1.0,
            calibration_factor=calibration_factor,
            reasoning=reasoning,
        )

    def _predict_risk(self, state: MarketState) -> AgentVote:
        severity = 0.0
        if state.drawdown >= 8.0:
            severity += 0.7
        elif state.drawdown >= 5.0:
            severity += 0.4
        if state.latency >= 350.0:
            severity += 0.35
        if state.infra_health <= 0.45:
            severity += 0.4
        elif state.infra_health <= 0.7:
            severity += 0.2
        if state.network_regime == "critical":
            severity += 0.25
        elif state.network_regime == "degraded":
            severity += 0.1
        if state.backlog >= 2.0:
            severity += 0.25
        if state.render_pressure >= 2.0:
            severity += 0.15
        if state.regime == "VOLATILE":
            severity += 0.1
        confidence = _clamp(severity, 0.0, 1.0)
        calibrated_confidence = calibrate(
            confidence,
            self.performance.win_rate,
            regime_win_rate=self.performance.win_rate_for_regime(state.regime),
            volatility=state.volatility,
            spread=state.spread,
            latency=state.latency,
            fill_probability=state.fill_probability,
            orderflow_quality=state.orderflow_quality,
            infra_health=state.infra_health,
            network_regime=state.network_regime,
        )
        if calibrated_confidence >= 0.65 and abs(state.position) > 0:
            action = Action.CLOSE
            veto_close = True
            reasoning = "drawdown/latence/backlog hors bande: fermeture forcee"
        elif calibrated_confidence >= 0.4:
            action = Action.HOLD
            veto_close = False
            reasoning = "risque eleve: blocage temporaire des nouvelles prises de position"
        else:
            action = Action.HOLD
            veto_close = False
            reasoning = "risque sous controle"
        return AgentVote(
            name=self.name,
            action=action,
            confidence=confidence,
            calibrated_confidence=calibrated_confidence,
            raw_score=severity,
            weight=max(1.0, self.performance.weight_multiplier),
            base_weight=max(1.0, self.performance.weight_multiplier),
            meta_weight=1.0,
            calibration_factor=calibrated_confidence / max(confidence, 1e-6) if confidence > 0 else 1.0,
            reasoning=reasoning,
            veto_close=veto_close,
        )

    def learn(
        self,
        batch: list[Experience],
        feature_tracker: FeatureAttributionTracker | None = None,
        failure_lr_calibrator: FailureSourceLearningRateCalibrator | None = None,
    ) -> None:
        if not batch:
            return
        if self.name == "risk":
            for experience in batch:
                self.performance.record(experience.state.regime, experience.reward * experience.sample_weight)
            self.performance.learning_rate_multiplier = 1.0
            self.performance.feature_learning_rate_multiplier = 1.0
            self.performance.failure_learning_rate_multiplier = 1.0
            self.performance.effective_learning_rate = 0.0
            self.performance.dominant_failure_source = None
            return

        applied_learning_rates: list[float] = []
        applied_multipliers: list[float] = []
        applied_feature_multipliers: list[float] = []
        applied_failure_multipliers: list[float] = []
        applied_failure_sources: list[str] = []
        for experience in batch:
            self.performance.record(experience.state.regime, experience.reward * experience.sample_weight)
            features = self._feature_map(experience.state)
            target = self._target_from_experience(experience)
            magnitude = _clamp(math.tanh(abs(experience.reward) / 25.0), 0.05, 1.0) * _clamp(experience.sample_weight, 0.15, 1.0)
            if target == 0.0:
                continue
            feature_lr_multiplier = _feature_learning_rate_multiplier_for_agent(self.name, experience, feature_tracker)
            failure_lr_multiplier = _agent_failure_learning_rate_multiplier(self.name, experience, failure_lr_calibrator)
            lr_multiplier = _clamp(feature_lr_multiplier * failure_lr_multiplier, 0.35, 1.85)
            effective_learning_rate = self.base_learning_rate * lr_multiplier
            applied_learning_rates.append(effective_learning_rate)
            applied_multipliers.append(lr_multiplier)
            applied_feature_multipliers.append(feature_lr_multiplier)
            applied_failure_multipliers.append(failure_lr_multiplier)
            if experience.failure_source is not None:
                applied_failure_sources.append(experience.failure_source)
            for key, value in features.items():
                updated = self.feature_weights.get(key, 0.0) + effective_learning_rate * target * magnitude * value
                self.feature_weights[key] = _clamp(updated, -3.5, 3.5)
            self.bias = _clamp(self.bias + effective_learning_rate * target * magnitude * 0.2, -2.5, 2.5)
        self.performance.learning_rate_multiplier = _average(applied_multipliers) if applied_multipliers else 1.0
        self.performance.feature_learning_rate_multiplier = _average(applied_feature_multipliers) if applied_feature_multipliers else 1.0
        self.performance.failure_learning_rate_multiplier = _average(applied_failure_multipliers) if applied_failure_multipliers else 1.0
        self.performance.effective_learning_rate = _average(applied_learning_rates) if applied_learning_rates else self.base_learning_rate
        self.performance.dominant_failure_source = None
        if applied_failure_sources:
            self.performance.dominant_failure_source = max(set(applied_failure_sources), key=applied_failure_sources.count)

    def _target_from_experience(self, experience: Experience) -> float:
        reward_sign = 1.0 if experience.reward > 0 else -1.0 if experience.reward < 0 else 0.0
        if experience.action == Action.BUY:
            return reward_sign
        if experience.action == Action.SELL:
            return -reward_sign
        if experience.action == Action.CLOSE:
            return 0.6 * reward_sign
        return 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "bias": self.bias,
            "learning_rate": self.base_learning_rate,
            "feature_weights": self.feature_weights,
            "performance": self.performance.to_dict(),
        }

    def load(self, payload: dict[str, Any]) -> None:
        self.bias = _to_float(payload.get("bias"), self.bias)
        self.base_learning_rate = _clamp(_to_float(payload.get("learning_rate"), self.base_learning_rate), 0.001, 0.2)
        self.learning_rate = self.base_learning_rate
        weights = payload.get("feature_weights") if isinstance(payload.get("feature_weights"), dict) else {}
        for key, value in weights.items():
            self.feature_weights[str(key)] = _clamp(_to_float(value, self.feature_weights.get(str(key), 0.0)), -3.5, 3.5)
        if isinstance(payload.get("performance"), dict):
            self.performance.load(payload["performance"])


class AutonomousBrain:
    def __init__(
        self,
        execution_model: Any | None = None,
        replay_capacity: int = 100000,
        batch_size: int = 64,
        min_learn_batch: int = 32,
        feature_flags_path: str | Path | None = None,
    ) -> None:
        self.execution_model = execution_model
        self.feature_flags_path = str(feature_flags_path or "").strip() or None
        self.replay_buffer = ReplayBuffer(replay_capacity)
        self.batch_size = max(1, batch_size)
        self.min_learn_batch = max(1, min_learn_batch)
        self.decisions = 0
        self.learn_steps = 0
        self.last_reward = 0.0
        self.last_decision: dict[str, Any] | None = None
        self.feature_tracker = FeatureAttributionTracker()
        self.failure_lr_calibrator = FailureSourceLearningRateCalibrator()
        self.policy_memory = PolicyMemory()
        self.policy_memory_loaded_from_state = False
        self.strategic_memory = StrategicMemory()
        self.strategic_memory_loaded_from_state = False
        self.memory_engine_v2 = MemoryEngineV2()
        self.latent_encoder = LatentRegimeEncoder()
        self.agents: dict[str, SpecialistAgent] = {
            "scalper": SpecialistAgent(
                "scalper",
                {
                    "spread": -0.62,
                    "imbalance": 0.26,
                    "micro_burst": 0.58,
                    "orderflow_delta": 0.34,
                    "orderflow_imbalance": 0.42,
                    "absorption_signal": 0.26,
                    "spoofing_score": -0.18,
                    "latency": -0.42,
                    "fill_probability": 0.34,
                    "edge": 0.24,
                    "momentum": 0.18,
                    "quote_fade": -0.16,
                    "session_vwap_distance": -0.18,
                    "liquidity_pressure": 0.22,
                    "sweep_risk": -0.18,
                    "latent_reversion": 0.18,
                    "latent_friction": -0.16,
                    "latent_persistence": 0.12,
                },
                bias=0.05,
            ),
            "trend": SpecialistAgent(
                "trend",
                {
                    "imbalance": 0.48,
                    "momentum": 0.75,
                    "trend_score": 0.64,
                    "volume": 0.22,
                    "edge": 0.3,
                    "vwap_slope": 0.38,
                    "distance_to_vwap": -0.14,
                    "orderflow_imbalance": 0.24,
                    "impulse_vwap_distance": -0.34,
                    "anchor_confluence": 0.22,
                    "anchor_compression": -0.16,
                    "regime_trend": 0.44,
                    "regime_chop": -0.32,
                    "drawdown": -0.18,
                    "latent_trend": 0.34,
                    "latent_persistence": 0.28,
                    "latent_reversion": -0.22,
                    "latent_volatility": -0.12,
                },
                bias=0.02,
            ),
            "liquidity": SpecialistAgent(
                "liquidity",
                {
                    "depth": 0.68,
                    "fill_probability": 0.52,
                    "spread": -0.34,
                    "quote_fade": -0.28,
                    "book_flip": 0.26,
                    "absorption_signal": 0.54,
                    "liquidity_trap_signal": 0.72,
                    "spoofing_score": -0.22,
                    "distance_to_vwap": -0.18,
                    "swing_vwap_distance": -0.28,
                    "liquidity_pressure": 0.58,
                    "resting_imbalance": 0.52,
                    "sweep_risk": -0.46,
                    "liquidity_vacuum": -0.34,
                    "support_score": 0.3,
                    "resistance_score": -0.24,
                    "liquidity_engine_score": 0.4,
                    "latency": -0.18,
                    "backlog": -0.16,
                    "latent_stress": 0.24,
                    "latent_friction": -0.14,
                    "latent_reversion": 0.12,
                },
                bias=0.04,
            ),
            "execution": SpecialistAgent(
                "execution",
                {
                    "model_probability": 0.9,
                    "edge": 0.42,
                    "fill_probability": 0.34,
                    "latency": -0.32,
                    "slippage": -0.36,
                    "backlog": -0.22,
                    "spread": -0.18,
                    "spoofing_score": -0.16,
                    "liquidity_trap_signal": 0.16,
                    "sweep_risk": -0.28,
                    "liquidity_vacuum": -0.24,
                    "liquidity_engine_score": 0.22,
                    "render_pressure": -0.12,
                    "latent_friction": -0.28,
                    "latent_stress": -0.12,
                    "latent_confidence": 0.08,
                },
                bias=-0.04,
            ),
            "risk": SpecialistAgent("risk", {}, bias=0.0),
        }

    def runtime_feature_flags(self) -> dict[str, bool]:
        return load_feature_flags(self.feature_flags_path, DEFAULT_RUNTIME_FEATURE_FLAGS)

    def bootstrap_experiences(self, rows: list[dict[str, Any]]) -> int:
        accepted = 0
        for row in rows:
            experience = Experience.from_payload(row)
            if experience is None:
                continue
            self._attach_latent_to_experience(experience, update_encoder=True)
            self.replay_buffer.push(experience)
            self.failure_lr_calibrator.observe_experience(experience)
            if not self.policy_memory_loaded_from_state:
                self.policy_memory.remember_experience(experience)
            if not self.strategic_memory_loaded_from_state:
                self.strategic_memory.remember_experience(experience)
            self.memory_engine_v2.remember_experience(experience)
            accepted += 1
        return accepted

    def decide(
        self,
        payload: dict[str, Any],
        prediction: dict[str, Any] | None = None,
        reliability: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        model_prediction = prediction or (self.execution_model.predict(payload) if self.execution_model is not None else {})
        state = MarketState.from_payload({**payload, "probability": model_prediction.get("probability", payload.get("probability"))})
        state.regime = detect_regime(state)
        state = self.latent_encoder.enrich_state(state, update_hidden=True)
        reliable = bool(reliability.get("data_reliable")) if isinstance(reliability, dict) else True
        votes = [agent.predict(state) for agent in self.agents.values()]
        decision = self._weighted_vote(state, votes, model_prediction, reliable)
        self.decisions += 1
        self.last_decision = decision
        return decision

    def learn_from_payloads(self, items: list[dict[str, Any]]) -> dict[str, Any]:
        experience_rows: list[dict[str, Any]] = []
        accepted_experiences = 0
        causal_dreams_generated = 0
        feature_flags = self.runtime_feature_flags()
        for item in items:
            experience = Experience.from_payload(item)
            if experience is None:
                continue
            accepted_experiences += 1
            self.last_reward = experience.reward
            self._attach_latent_to_experience(experience, update_encoder=True)
            self.replay_buffer.push(experience)
            self.feature_tracker.record(experience)
            self.failure_lr_calibrator.observe_experience(experience)
            self.policy_memory.remember_experience(experience)
            self.strategic_memory.remember_experience(experience)
            self.memory_engine_v2.remember_experience(experience)
            if self.execution_model is not None and hasattr(self.execution_model, "observe_world_model_transition"):
                try:
                    self.execution_model.observe_world_model_transition(experience.state.to_dict(), experience.next_state.to_dict())
                except Exception:
                    pass
            experience.agent_learning_rate_hints = self._build_experience_agent_learning_rate_hints(experience)
            experience_rows.append(experience.to_dict())
            dream_generator = self._generate_safe_dreams if feature_flags.get("auto_dream_safe_mode", True) else self._generate_constrained_dreams
            for dream in dream_generator(experience):
                self.replay_buffer.push(dream)
                self.failure_lr_calibrator.observe_experience(dream)
                dream.agent_learning_rate_hints = self._build_experience_agent_learning_rate_hints(dream)
                experience_rows.append(dream.to_dict())

        for dream in self._generate_causal_pattern_dreams(
            limit=3,
            strict_causal=feature_flags.get("memory_v2_causal_strict", True),
        ):
            self.replay_buffer.push(dream)
            self.failure_lr_calibrator.observe_experience(dream)
            dream.agent_learning_rate_hints = self._build_experience_agent_learning_rate_hints(dream)
            experience_rows.append(dream.to_dict())
            causal_dreams_generated += 1

        learned = False
        batch = self.replay_buffer.sample(self.batch_size)
        if len(batch) >= self.min_learn_batch:
            for agent in self.agents.values():
                agent.learn(batch, feature_tracker=self.feature_tracker, failure_lr_calibrator=self.failure_lr_calibrator)
            learned = True
            self.learn_steps += 1

        return {
            "accepted": accepted_experiences,
            "causal_dreams_generated": causal_dreams_generated,
            "learned": learned,
            "sampled": len(batch),
            "experience_rows": experience_rows,
            "stats": self.get_stats(),
        }

    def dump_state(self) -> dict[str, Any]:
        return {
            "decisions": self.decisions,
            "learn_steps": self.learn_steps,
            "last_reward": self.last_reward,
            "agents": {name: agent.to_dict() for name, agent in self.agents.items()},
            "feature_attribution": self.feature_tracker.to_dict(),
            "failure_lr_calibration": self.failure_lr_calibrator.summary(),
            "policy_memory": self.policy_memory.to_dict(),
            "strategic_memory": self.strategic_memory.to_dict(),
            "memory_engine_v2": self.memory_engine_v2.to_dict(),
            "latent_encoder": self.latent_encoder.to_dict(),
        }

    def load_state(self, payload: dict[str, Any]) -> None:
        self.decisions = max(0, int(payload.get("decisions") or 0))
        self.learn_steps = max(0, int(payload.get("learn_steps") or 0))
        self.last_reward = _to_float(payload.get("last_reward"), 0.0)
        agents = payload.get("agents") if isinstance(payload.get("agents"), dict) else {}
        for name, state in agents.items():
            if name in self.agents and isinstance(state, dict):
                self.agents[name].load(state)
        if isinstance(payload.get("feature_attribution"), dict):
            self.feature_tracker.load(payload["feature_attribution"])
        if isinstance(payload.get("policy_memory"), dict):
            self.policy_memory.load(payload["policy_memory"])
            self.policy_memory_loaded_from_state = True
        if isinstance(payload.get("strategic_memory"), dict):
            self.strategic_memory.load(payload["strategic_memory"])
            self.strategic_memory_loaded_from_state = True
        if isinstance(payload.get("memory_engine_v2"), dict):
            self.memory_engine_v2.load(payload["memory_engine_v2"])
        if isinstance(payload.get("latent_encoder"), dict):
            self.latent_encoder.load(payload["latent_encoder"])

    def get_stats(self) -> dict[str, Any]:
        global_win_rate = _average([agent.performance.win_rate for agent in self.agents.values()])
        return {
            "decisions": self.decisions,
            "learn_steps": self.learn_steps,
            "last_reward": round(self.last_reward, 6),
            "global_win_rate": round(global_win_rate, 6),
            "feature_flags": self.runtime_feature_flags(),
            "replay_buffer": self.replay_buffer.stats(),
            "feature_attribution": self.feature_tracker.to_dict(),
            "failure_lr_calibration": self.failure_lr_calibrator.summary(),
            "policy_memory": self.policy_memory.summary(),
            "strategic_memory": self.strategic_memory.summary(),
            "memory_engine_v2": self.memory_engine_v2.summary(),
            "latent_encoder": self.latent_encoder.summary(),
            "agents": {
                name: {
                    "win_rate": round(agent.performance.win_rate, 6),
                    "weight_multiplier": round(agent.performance.weight_multiplier, 6),
                    "learning_rate": round(agent.base_learning_rate, 6),
                    "learning_rate_multiplier": round(agent.performance.learning_rate_multiplier, 6),
                    "feature_learning_rate_multiplier": round(agent.performance.feature_learning_rate_multiplier, 6),
                    "failure_learning_rate_multiplier": round(agent.performance.failure_learning_rate_multiplier, 6),
                    "effective_learning_rate": round(agent.performance.effective_learning_rate, 6),
                    "dominant_failure_source": agent.performance.dominant_failure_source,
                    "total_updates": agent.performance.total_updates,
                    "cumulative_reward": round(agent.performance.cumulative_reward, 6),
                }
                for name, agent in self.agents.items()
            },
        }

    def query_memory_engine_v2(self, payload: dict[str, Any]) -> dict[str, Any]:
        experience_id = str(
            payload.get("experience_id")
            or payload.get("decision_id")
            or payload.get("episode_id")
            or ""
        ).strip()
        if experience_id:
            episode = self.memory_engine_v2.get_episode(experience_id)
            if episode is not None:
                return {
                    "status": "ok",
                    "query_type": "episode",
                    "experience_id": experience_id,
                    "episode": episode,
                    "layer_counts": self.memory_engine_v2.summary(),
                }
        state_payload = payload.get("state") if isinstance(payload.get("state"), dict) else payload
        if not isinstance(state_payload, dict):
            state_payload = {}
        state = MarketState.from_payload(state_payload)
        if not state.regime:
            state.regime = detect_regime(state)
        state = self.latent_encoder.enrich_state(state, update_hidden=False)
        feature_flags = self.runtime_feature_flags()
        failure_source = _normalize_failure_source(
            payload.get("failure_source") or state_payload.get("failure_source")
        )
        causal_strict = bool(payload.get("causal_strict", feature_flags.get("memory_v2_causal_strict", True)))
        result = self.memory_engine_v2.resolve(state, failure_source, causal_strict=causal_strict)
        result["status"] = "ok"
        result["query_type"] = "context"
        result["state"] = state.to_dict()
        result["feature_flags"] = feature_flags
        return result

    def build_strategy_arena(
        self,
        payload: dict[str, Any],
        prediction: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        feature_flags = self.runtime_feature_flags()
        state_payload = payload.get("state") if isinstance(payload.get("state"), dict) else payload
        if not isinstance(state_payload, dict):
            state_payload = {}
        state = MarketState.from_payload(state_payload)
        if not state.regime:
            state.regime = detect_regime(state)
        state = self.latent_encoder.enrich_state(state, update_hidden=False)
        model_prediction = prediction or (payload.get("prediction") if isinstance(payload.get("prediction"), dict) else {})
        current_route_mode = str(model_prediction.get("route_mode") or state_payload.get("route_mode") or "bestSingleVenue").strip() or "bestSingleVenue"
        failure_source = _normalize_failure_source(
            payload.get("failure_source")
            or state_payload.get("failure_source")
            or self._infer_meta_failure_source_from_state(state)
        )
        policy_match = self.policy_memory.resolve(state, failure_source)
        strategic_match = self.strategic_memory.resolve(state)
        memory_v2_match = self.memory_engine_v2.resolve(
            state,
            failure_source,
            causal_strict=feature_flags.get("memory_v2_causal_strict", True),
        )
        feature_summary = self.feature_tracker.summary_for_state(state)
        meta_agent = self._build_meta_agent_plan(state, feature_summary)
        memory_v2_recommendation = memory_v2_match.get("recommendation") if isinstance(memory_v2_match.get("recommendation"), dict) else {}
        policy_best = policy_match.get("best_policy") if isinstance((policy_match or {}).get("best_policy"), dict) else {}
        strategic_best = str((strategic_match or {}).get("best_strategy") or "").strip()
        strategic_confidence = _to_float((strategic_match or {}).get("confidence"), 0.0)
        model_should_execute = bool(model_prediction.get("model_should_execute", model_prediction.get("should_execute", False)))
        candidates: list[dict[str, Any]] = []
        for profile in STRATEGY_LIBRARY.values():
            score = 0.18
            reasons: list[str] = []
            if profile.profile_id == str(meta_agent.get("profile_id") or ""):
                score += 0.34
                reasons.append("meta_agent")
            if profile.profile_id == strategic_best and strategic_confidence > 0.0:
                score += 0.28 * strategic_confidence
                reasons.append("strategic_memory")
            if str(policy_best.get("strategy_mode") or "") == profile.strategy_mode:
                score += 0.18 * _to_float((policy_match or {}).get("confidence"), 0.0)
                reasons.append("policy_memory")
            if str(memory_v2_recommendation.get("strategy_mode") or "") == profile.strategy_mode:
                score += 0.24 * _to_float(memory_v2_match.get("confidence"), 0.0)
                reasons.append("memory_v2")
            if failure_source == "infra":
                if profile.profile_id == "risk_off":
                    score += 0.42
                    reasons.append("infra_hardening")
                elif profile.profile_id == "execution_safe":
                    score += 0.34
                    reasons.append("infra_execution_safe")
                else:
                    score -= 0.12
            elif failure_source == "execution":
                if profile.profile_id == "execution_safe":
                    score += 0.42
                    reasons.append("execution_friction")
                elif profile.profile_id == "risk_off":
                    score += 0.14
                    reasons.append("execution_block_fallback")
            elif failure_source == "market":
                if profile.profile_id in {"chop_mean_reversion", "news_spike"}:
                    score += 0.24
                    reasons.append("market_regime")
            if state.regime == "TREND" and profile.strategy_mode == "trend_follow":
                score += 0.24
                reasons.append("trend_alignment")
            elif state.regime == "CHOP" and profile.strategy_mode == "mean_reversion":
                score += 0.24
                reasons.append("chop_alignment")
            elif state.regime == "VOLATILE" and profile.profile_id == "news_spike":
                score += 0.2
                reasons.append("volatility_alignment")
            if state.network_regime == "critical" and profile.close_only:
                score += 0.16
                reasons.append("close_only_under_stress")
            if not model_should_execute and profile.profile_id in {"execution_safe", "risk_off"}:
                score += 0.12
                reasons.append("model_alignment_guard")
            if profile.close_only and abs(state.position) <= 0:
                score -= 0.22
            route_mode = profile.route_mode_override or current_route_mode
            execution_style = profile.execution_style or "default"
            if str(memory_v2_recommendation.get("route_mode_override") or "") == route_mode:
                score += 0.08
            if str(memory_v2_recommendation.get("execution_style") or "") == execution_style:
                score += 0.08
            deduped_reasons: list[str] = []
            for reason in reasons:
                if reason and reason not in deduped_reasons:
                    deduped_reasons.append(reason)
            candidates.append(
                {
                    "profile_id": profile.profile_id,
                    "global_mode": profile.global_mode,
                    "strategy_mode": profile.strategy_mode,
                    "execution_style": execution_style,
                    "route_mode_override": route_mode,
                    "exposure_multiplier": round(_clamp(profile.exposure_multiplier, 0.0, 1.0), 6),
                    "max_spread_multiplier": round(_clamp(profile.max_spread_multiplier, 0.35, 1.0), 6),
                    "execution_delay_ms": max(0, int(profile.execution_delay_ms)),
                    "close_only": bool(profile.close_only),
                    "halt_new_exposure": bool(profile.halt_new_exposure),
                    "simulation_profile": profile.simulation_profile,
                    "score": round(score, 6),
                    "reasons": deduped_reasons,
                }
            )
        candidates.sort(key=lambda item: (_to_float(item.get("score"), 0.0), _to_float(item.get("exposure_multiplier"), 0.0)), reverse=True)
        selected = candidates[0] if candidates else {}
        return {
            "status": "ok" if feature_flags.get("kairos_strategy_arena", True) else "disabled",
            "feature_flags": feature_flags,
            "failure_source": failure_source,
            "current_route_mode": current_route_mode,
            "meta_agent_profile": str(meta_agent.get("profile_id") or ""),
            "policy_memory_key": str((policy_match or {}).get("context_key") or ""),
            "strategic_memory_key": str((strategic_match or {}).get("context_key") or ""),
            "memory_v2_context_key": str(memory_v2_match.get("context_key") or ""),
            "memory_v2_source": str(memory_v2_match.get("source") or "none"),
            "selected": selected,
            "candidates": candidates[:6],
        }

    def _build_experience_agent_learning_rate_hints(self, experience: Experience) -> dict[str, dict[str, Any]]:
        failure_summary = self.failure_lr_calibrator.source_summary(experience.failure_source)
        failure_source = _normalize_failure_source(experience.failure_source)
        hints: dict[str, dict[str, Any]] = {}
        for agent_name, agent in self.agents.items():
            feature_multiplier = 1.0 if agent_name == "risk" else _feature_learning_rate_multiplier_for_agent(agent_name, experience, self.feature_tracker)
            failure_multiplier = 1.0 if agent_name == "risk" else _agent_failure_learning_rate_multiplier(agent_name, experience, self.failure_lr_calibrator)
            combined_multiplier = 1.0 if agent_name == "risk" else _clamp(feature_multiplier * failure_multiplier, 0.35, 1.85)
            family_labels: list[str] = []
            for family in AGENT_FAMILY_MAP.get(agent_name, ()):
                diagnostics = experience.feature_diagnostics.get(family) if isinstance(experience.feature_diagnostics.get(family), dict) else {}
                contribution = _to_float(diagnostics.get("contribution"), _to_float(experience.feature_contributions.get(family), 0.0))
                if abs(contribution) <= 1e-9 and family not in experience.feature_contributions:
                    continue
                suffix = " !" if bool(diagnostics.get("wrong_way")) else ""
                family_labels.append(f"{family} {contribution:+.2f}{suffix}")
            rationale_parts: list[str] = []
            if family_labels:
                rationale_parts.append(", ".join(family_labels[:2]))
            if failure_source is not None:
                calibration_mode = "empirical" if _to_float(failure_summary.get("confidence"), 0.0) > 0.0 else "prior"
                rationale_parts.append(
                    f"{failure_source} {calibration_mode} c={_to_float(failure_summary.get('confidence'), 0.0):.2f}"
                )
            hints[agent_name] = {
                "agent": agent_name,
                "base": round(agent.base_learning_rate, 6),
                "feature_multiplier": round(feature_multiplier, 6),
                "failure_multiplier": round(failure_multiplier, 6),
                "combined_multiplier": round(combined_multiplier, 6),
                "effective_learning_rate": round(0.0 if agent_name == "risk" else agent.base_learning_rate * combined_multiplier, 6),
                "families": family_labels,
                "failure_source": failure_source,
                "calibration_mode": "empirical" if _to_float(failure_summary.get("confidence"), 0.0) > 0.0 else "prior",
                "calibration_confidence": round(_to_float(failure_summary.get("confidence"), 0.0), 6),
                "calibration_samples": int(failure_summary.get("sample_count") or 0),
                "calibration_effective_weight": round(_to_float(failure_summary.get("effective_sample_weight"), 0.0), 6),
                "explanation": " | ".join(rationale_parts),
            }
        return hints

    def _weighted_vote(
        self,
        state: MarketState,
        votes: list[AgentVote],
        prediction: dict[str, Any],
        reliable: bool,
    ) -> dict[str, Any]:
        meta_policy = self._apply_meta_policy(state, votes)
        meta_agent = meta_policy.get("meta_agent") if isinstance(meta_policy.get("meta_agent"), dict) else {}
        meta_policy["governor"] = {
            "mode": "idle",
            "blocked": False,
            "size_multiplier": 1.0,
            "reasons": [],
            "failure_source": None,
            "calibration_confidence": 0.0,
        }
        for vote in votes:
            if vote.veto_close and abs(state.position) > 0:
                meta_policy["action_shield"] = {
                    "mode": "risk_veto_close",
                    "projected_action": Action.CLOSE.value,
                    "allow_execute": reliable,
                    "blocked": False,
                    "delay_ms": 0,
                    "size_multiplier_cap": 1.0,
                    "max_spread_multiplier_cap": 1.0,
                    "reasons": ["risk_agent_veto_close"],
                }
                failure_attribution = {
                    "failure_source": None,
                    "failure_reasons": [],
                    "failure_blocking": False,
                }
                return {
                    "state": state.to_dict(),
                    "regime": state.regime,
                    "action": Action.CLOSE.value,
                    "confidence": round(vote.calibrated_confidence, 6),
                    "consensus": 1.0,
                    "should_execute": reliable and vote.calibrated_confidence >= 0.55,
                    "reason": vote.reasoning,
                    "agent_votes": [item.to_dict() for item in votes],
                    "model_probability": round(_to_float(prediction.get("probability"), 0.0), 6),
                    "world_model": prediction.get("world_model") if isinstance(prediction.get("world_model"), dict) else {},
                    "meta_policy": meta_policy,
                    "failure_source": failure_attribution["failure_source"],
                    "failure_reasons": failure_attribution["failure_reasons"],
                    "failure_blocking": failure_attribution["failure_blocking"],
                }

        if bool(meta_agent.get("close_only")):
            forced_action = Action.CLOSE if abs(state.position) > 0 else Action.HOLD
            forced_should_execute = reliable and forced_action == Action.CLOSE
            meta_policy["action_shield"] = {
                "mode": "meta_close_only",
                "projected_action": forced_action.value,
                "allow_execute": forced_should_execute,
                "blocked": forced_action != Action.CLOSE,
                "delay_ms": max(0, int(_to_float(meta_agent.get("execution_delay_ms"), 0.0))),
                "size_multiplier_cap": 0.0 if forced_action == Action.CLOSE else 1.0,
                "max_spread_multiplier_cap": 1.0,
                "reasons": [f"meta_close_only:{meta_agent.get('profile_id') or meta_agent.get('global_mode') or 'risk_off'}"],
            }
            strategy_switch = self._resolve_strategy_switch(
                state,
                prediction,
                self._infer_meta_failure_source_from_state(state),
                meta_policy["governor"],
                meta_agent,
            )
            meta_policy["strategy_switch"] = strategy_switch
            failure_attribution = _build_failure_attribution(
                state,
                prediction,
                forced_action,
                forced_should_execute,
                reliable,
                max(0.68, _to_float(meta_agent.get("confidence_floor"), 0.68)),
                0.55,
                1.0,
            )
            return {
                "state": state.to_dict(),
                "regime": state.regime,
                "action": forced_action.value,
                "confidence": round(max(0.68, _to_float(meta_agent.get("confidence_floor"), 0.68)), 6),
                "consensus": 1.0,
                "should_execute": forced_should_execute,
                "reason": f"meta_agent_close_only:{meta_agent.get('profile_id') or meta_agent.get('global_mode') or 'risk_off'}",
                "agent_votes": [vote.to_dict() for vote in votes],
                "model_probability": round(_to_float(prediction.get("probability"), 0.0), 6),
                "world_model": prediction.get("world_model") if isinstance(prediction.get("world_model"), dict) else {},
                "meta_policy": meta_policy,
                "failure_source": failure_attribution["failure_source"],
                "failure_reasons": failure_attribution["failure_reasons"],
                "failure_blocking": failure_attribution["failure_blocking"],
            }

        buy_score = sum(vote.weight * vote.calibrated_confidence for vote in votes if vote.action == Action.BUY)
        sell_score = sum(vote.weight * vote.calibrated_confidence for vote in votes if vote.action == Action.SELL)
        hold_score = sum(vote.weight * vote.calibrated_confidence for vote in votes if vote.action == Action.HOLD)
        total_score = max(1e-6, buy_score + sell_score + hold_score)
        consensus = max(buy_score, sell_score, hold_score) / total_score
        directional_score = buy_score - sell_score

        if hold_score >= max(buy_score, sell_score) * 0.95 or abs(directional_score) <= 0.08:
            action = Action.HOLD
        else:
            action = Action.BUY if directional_score > 0 else Action.SELL

        raw_confidence = abs(directional_score) / max(1e-6, total_score)
        calibrated_confidence = calibrate(
            raw_confidence,
            _average([agent.performance.win_rate for agent in self.agents.values()]),
            regime_win_rate=_average([agent.performance.win_rate_for_regime(state.regime) for agent in self.agents.values()]),
            volatility=state.volatility,
            spread=state.spread,
            latency=state.latency,
            fill_probability=state.fill_probability,
            orderflow_quality=state.orderflow_quality,
            consensus=consensus,
            infra_health=state.infra_health,
            network_regime=state.network_regime,
        )
        execute_threshold = 0.62 if state.regime == "VOLATILE" else 0.58 if state.regime == "CHOP" else 0.55
        if state.network_regime == "critical":
            execute_threshold += 0.12
        elif state.network_regime == "degraded":
            execute_threshold += 0.05
        should_execute = reliable and action in {Action.BUY, Action.SELL} and calibrated_confidence >= execute_threshold
        if action in {Action.BUY, Action.SELL} and state.infra_health <= 0.35:
            should_execute = False
        if action in {Action.BUY, Action.SELL} and prediction.get("model_should_execute") is False and calibrated_confidence < 0.72:
            should_execute = False
        if action in {Action.BUY, Action.SELL} and bool(meta_agent.get("halt_new_exposure")):
            should_execute = False
        preliminary_failure_attribution = _build_failure_attribution(
            state,
            prediction,
            action,
            should_execute,
            reliable,
            calibrated_confidence,
            execute_threshold,
            consensus,
        )
        governor = self._apply_decision_governor(
            state,
            action,
            prediction,
            calibrated_confidence,
            execute_threshold,
            consensus,
            preliminary_failure_attribution.get("failure_source"),
        )
        meta_policy["governor"] = governor
        strategy_switch = self._resolve_strategy_switch(
            state,
            prediction,
            preliminary_failure_attribution.get("failure_source"),
            governor,
            meta_agent,
        )
        meta_policy["strategy_switch"] = strategy_switch
        action_shield = self._project_to_safe_action(
            state,
            prediction,
            action,
            should_execute,
            calibrated_confidence,
            reliable,
            governor,
            meta_agent,
        )
        meta_policy["action_shield"] = action_shield
        safe_action = Action.from_value(action_shield.get("projected_action"))
        if safe_action != action:
            action = safe_action
        if action == Action.HOLD:
            should_execute = False
        elif action == Action.CLOSE:
            should_execute = reliable and abs(state.position) > 0
        else:
            should_execute = should_execute and bool(action_shield.get("allow_execute", True))
        should_execute = should_execute and not bool(governor.get("blocked"))
        failure_attribution = _build_failure_attribution(
            state,
            prediction,
            action,
            should_execute,
            reliable,
            calibrated_confidence,
            execute_threshold,
            consensus,
        )

        reason = f"buy={buy_score:.3f} sell={sell_score:.3f} hold={hold_score:.3f} reliable={reliable} orderflow={state.orderflow_quality:.2f}"
        if governor.get("blocked"):
            governor_reasons = ",".join(str(item) for item in governor.get("reasons", []) if item)
            reason = f"{reason} | governor=blocked{f':{governor_reasons}' if governor_reasons else ''}"
        elif _to_float(governor.get("size_multiplier"), 1.0) < 0.999:
            governor_reasons = ",".join(str(item) for item in governor.get("reasons", []) if item)
            reason = f"{reason} | governor=size_x{_to_float(governor.get('size_multiplier'), 1.0):.2f}{f':{governor_reasons}' if governor_reasons else ''}"
        shield_mode = str(action_shield.get("mode") or "pass")
        if shield_mode != "pass":
            shield_reasons = ",".join(str(item) for item in action_shield.get("reasons", []) if item)
            reason = f"{reason} | shield={shield_mode}{f':{shield_reasons}' if shield_reasons else ''}"
        if meta_agent.get("profile_id"):
            reason = f"{reason} | meta={meta_agent.get('profile_id')}"
        return {
            "state": state.to_dict(),
            "regime": state.regime,
            "action": action.value,
            "confidence": round(calibrated_confidence, 6),
            "consensus": round(consensus, 6),
            "should_execute": should_execute,
            "reason": reason,
            "agent_votes": [vote.to_dict() for vote in votes],
            "model_probability": round(_to_float(prediction.get("probability"), 0.0), 6),
            "world_model": prediction.get("world_model") if isinstance(prediction.get("world_model"), dict) else {},
            "meta_policy": meta_policy,
            "failure_source": failure_attribution["failure_source"],
            "failure_reasons": failure_attribution["failure_reasons"],
            "failure_blocking": failure_attribution["failure_blocking"],
        }

    def _apply_decision_governor(
        self,
        state: MarketState,
        action: Action,
        prediction: dict[str, Any],
        calibrated_confidence: float,
        execute_threshold: float,
        consensus: float,
        failure_source: str | None,
    ) -> dict[str, Any]:
        normalized_source = _normalize_failure_source(failure_source)
        failure_summary = self.failure_lr_calibrator.source_summary(normalized_source)
        calibration_confidence = _to_float(failure_summary.get("confidence"), 0.0)
        reasons: list[str] = []
        blocked = False
        size_multiplier = 1.0
        mode = "normal"

        if action not in {Action.BUY, Action.SELL}:
            return {
                "mode": "idle",
                "blocked": False,
                "size_multiplier": 1.0,
                "reasons": [],
                "failure_source": normalized_source,
                "calibration_confidence": round(calibration_confidence, 6),
            }

        if state.network_regime == "critical" or state.infra_health <= 0.28:
            blocked = True
            size_multiplier = 0.0
            reasons.append("hard_block_infra_critical")
        elif state.network_regime == "degraded" or state.infra_health <= 0.48:
            size_multiplier = min(size_multiplier, 0.55)
            reasons.append("reduce_size_infra_degraded")

        if normalized_source == "infra":
            if calibration_confidence >= 0.15 and (state.network_regime != "stable" or state.infra_health <= 0.58):
                blocked = True
                size_multiplier = 0.0
                reasons.append("hard_block_failure_infra")
            elif calibration_confidence >= 0.15:
                size_multiplier = min(size_multiplier, 0.72)
                reasons.append("reduce_size_failure_infra")
        elif normalized_source == "execution":
            low_fill = state.fill_probability > 0.0 and state.fill_probability <= 0.34
            if calibration_confidence >= 0.18 and (state.latency >= 300.0 or low_fill):
                blocked = True
                size_multiplier = 0.0
                reasons.append("hard_block_failure_execution")
            elif state.latency >= 220.0 or state.spread >= 10.0 or low_fill:
                size_multiplier = min(size_multiplier, 0.68)
                reasons.append("reduce_size_execution_friction")
        elif normalized_source == "market":
            weak_edge = abs(state.edge) <= 1.0
            if calibration_confidence >= 0.22 and calibrated_confidence < execute_threshold + 0.04 and weak_edge and consensus < 0.58:
                blocked = True
                size_multiplier = 0.0
                reasons.append("hard_block_market_uncertain")
            elif calibration_confidence >= 0.12 and (weak_edge or consensus < 0.55):
                size_multiplier = min(size_multiplier, 0.76)
                reasons.append("reduce_size_market_uncertain")

        if prediction.get("model_should_execute") is False and calibrated_confidence < max(0.72, execute_threshold + 0.08):
            blocked = True
            size_multiplier = 0.0
            reasons.append("hard_block_model_alignment")

        if blocked:
            mode = "blocked"
        elif size_multiplier < 0.999:
            mode = "reduced"

        deduped_reasons: list[str] = []
        for reason in reasons:
            if reason and reason not in deduped_reasons:
                deduped_reasons.append(reason)
        return {
            "mode": mode,
            "blocked": blocked,
            "size_multiplier": round(size_multiplier, 6),
            "reasons": deduped_reasons,
            "failure_source": normalized_source,
            "calibration_confidence": round(calibration_confidence, 6),
        }

    def _project_to_safe_action(
        self,
        state: MarketState,
        prediction: dict[str, Any],
        action: Action,
        should_execute: bool,
        calibrated_confidence: float,
        reliable: bool,
        governor: dict[str, Any],
        meta_agent: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        world_model = prediction.get("world_model") if isinstance(prediction.get("world_model"), dict) else {}
        summary = world_model.get("summary") if isinstance(world_model.get("summary"), dict) else {}
        if action not in {Action.BUY, Action.SELL} or not summary:
            return {
                "mode": "pass",
                "projected_action": action.value,
                "allow_execute": should_execute,
                "blocked": False,
                "delay_ms": max(0, int(_to_float((meta_agent or {}).get("execution_delay_ms"), 0.0))),
                "size_multiplier_cap": 1.0,
                "max_spread_multiplier_cap": 1.0,
                "world_horizon_ms": int(_to_float(summary.get("horizon_ms"), 0.0)),
                "predicted_slippage_bps": round(_to_float(summary.get("expected_slippage_bps"), 0.0), 6),
                "predicted_fill_probability": round(_to_float(summary.get("expected_fill_probability"), 0.0), 6),
                "predicted_latency_ms": round(_to_float(summary.get("expected_latency_ms"), 0.0), 6),
                "execution_risk_score": round(_to_float(summary.get("execution_risk_score"), 0.0), 6),
                "reasons": [],
            }

        predicted_slippage_bps = max(0.0, _to_float(summary.get("expected_slippage_bps"), 0.0))
        predicted_fill_probability = _clamp(_to_float(summary.get("expected_fill_probability"), 0.0), 0.0, 1.0)
        predicted_latency_ms = max(0.0, _to_float(summary.get("expected_latency_ms"), 0.0))
        execution_risk_score = _clamp(_to_float(summary.get("execution_risk_score"), 0.0), 0.0, 1.0)
        recommended_delay_ms = max(
            max(0, int(_to_float(summary.get("recommended_delay_ms"), 0.0))),
            max(0, int(_to_float((meta_agent or {}).get("execution_delay_ms"), 0.0))),
        )

        reasons: list[str] = []
        mode = "pass"
        projected_action = action.value
        allow_execute = should_execute
        blocked = False
        size_multiplier_cap = 1.0
        max_spread_multiplier_cap = 1.0

        if execution_risk_score >= 0.92 and abs(state.position) > 0 and (state.network_regime == "critical" or predicted_latency_ms >= 520.0):
            projected_action = Action.CLOSE.value
            allow_execute = reliable
            mode = "project_close"
            reasons.append("world_model_forced_close")
        elif predicted_fill_probability <= 0.34 or predicted_latency_ms >= 420.0 or predicted_slippage_bps >= max(8.0, state.spread * 1.5):
            projected_action = Action.HOLD.value
            allow_execute = False
            blocked = True
            mode = "project_hold"
            if predicted_fill_probability <= 0.34:
                reasons.append("world_fill_probability_low")
            if predicted_latency_ms >= 420.0:
                reasons.append("world_latency_too_high")
            if predicted_slippage_bps >= max(8.0, state.spread * 1.5):
                reasons.append("world_slippage_too_high")
        elif execution_risk_score >= 0.64 or recommended_delay_ms > 0:
            mode = "delay"
            size_multiplier_cap = min(size_multiplier_cap, 0.74 if execution_risk_score >= 0.76 else 0.88)
            max_spread_multiplier_cap = min(max_spread_multiplier_cap, 0.82 if predicted_slippage_bps >= max(6.0, state.spread * 1.25) else 0.9)
            if recommended_delay_ms > 0:
                reasons.append("world_delay_execution")
            if execution_risk_score >= 0.64:
                reasons.append("world_execution_risk_elevated")

        if bool(governor.get("blocked")):
            blocked = True
            allow_execute = False

        if calibrated_confidence < 0.58 and mode == "delay":
            size_multiplier_cap = min(size_multiplier_cap, 0.8)

        deduped_reasons: list[str] = []
        for reason in reasons:
            if reason and reason not in deduped_reasons:
                deduped_reasons.append(reason)
        return {
            "mode": mode,
            "projected_action": projected_action,
            "allow_execute": allow_execute,
            "blocked": blocked,
            "delay_ms": recommended_delay_ms,
            "size_multiplier_cap": round(size_multiplier_cap, 6),
            "max_spread_multiplier_cap": round(max_spread_multiplier_cap, 6),
            "world_horizon_ms": int(_to_float(summary.get("horizon_ms"), 0.0)),
            "predicted_slippage_bps": round(predicted_slippage_bps, 6),
            "predicted_fill_probability": round(predicted_fill_probability, 6),
            "predicted_latency_ms": round(predicted_latency_ms, 6),
            "execution_risk_score": round(execution_risk_score, 6),
            "reasons": deduped_reasons,
        }

    def _resolve_strategy_switch(
        self,
        state: MarketState,
        prediction: dict[str, Any],
        failure_source: str | None,
        governor: dict[str, Any],
        meta_agent: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        normalized_source = _normalize_failure_source(failure_source)
        meta_agent_payload = meta_agent if isinstance(meta_agent, dict) else {}
        current_route_mode = str(prediction.get("route_mode") or "bestSingleVenue").strip() or "bestSingleVenue"
        strategy_mode = str(meta_agent_payload.get("strategy_mode") or _default_strategy_mode_for_context(state, normalized_source)).strip() or _default_strategy_mode_for_context(state, normalized_source)
        route_mode_override = str(meta_agent_payload.get("route_mode_override") or current_route_mode).strip() or current_route_mode
        execution_style = str(meta_agent_payload.get("execution_style") or "default").strip() or "default"
        max_spread_multiplier = _clamp(_to_float(meta_agent_payload.get("max_spread_multiplier"), 1.0), 0.35, 1.0)
        size_multiplier_cap = min(
            _clamp(_to_float(governor.get("size_multiplier"), 1.0), 0.0, 1.0),
            _clamp(_to_float(meta_agent_payload.get("exposure_multiplier"), 1.0), 0.0, 1.0),
        )
        infra_is_critical = state.network_regime == "critical" or state.infra_health <= 0.35
        infra_is_degraded = state.network_regime != "stable" or state.infra_health <= 0.62
        reasons: list[str] = []

        if meta_agent_payload.get("profile_id"):
            reasons.append(f"strategy_profile:{meta_agent_payload.get('profile_id')}")
        for item in meta_agent_payload.get("reasons", []) if isinstance(meta_agent_payload.get("reasons"), list) else []:
            candidate = str(item or "").strip()
            if candidate:
                reasons.append(f"meta:{candidate}")

        if normalized_source == "infra" and (infra_is_critical or bool(meta_agent_payload.get("close_only")) or bool(meta_agent_payload.get("halt_new_exposure"))):
            strategy_mode = "risk_off"
            route_mode_override = "bestSingleVenue"
            execution_style = "primary_only"
            max_spread_multiplier = 0.72
            size_multiplier_cap = min(size_multiplier_cap, 0.72)
            reasons.append("switch_risk_off")
        elif normalized_source == "infra" or infra_is_degraded:
            strategy_mode = str(meta_agent_payload.get("strategy_mode") or "execution_protect").strip() or "execution_protect"
            route_mode_override = str(meta_agent_payload.get("route_mode_override") or "bestSingleVenue").strip() or "bestSingleVenue"
            execution_style = str(meta_agent_payload.get("execution_style") or "maker_passive").strip() or "maker_passive"
            max_spread_multiplier = min(max_spread_multiplier, 0.82)
            size_multiplier_cap = min(size_multiplier_cap, _clamp(_to_float(meta_agent_payload.get("exposure_multiplier"), 0.78), 0.0, 1.0))
            reasons.append("switch_execution_safe")
        elif normalized_source == "execution":
            strategy_mode = "execution_protect"
            route_mode_override = "bestSingleVenue"
            execution_style = "maker_passive"
            max_spread_multiplier = 0.82
            size_multiplier_cap = min(size_multiplier_cap, 0.78)
            reasons.append("switch_execution_protect")
        elif normalized_source == "market":
            strategy_mode = "market_selective"
            route_mode_override = "bestSingleVenue"
            execution_style = "passive_selective"
            max_spread_multiplier = 0.88 if state.regime == "CHOP" else 0.84 if state.regime == "VOLATILE" else 0.92
            size_multiplier_cap = min(size_multiplier_cap, 0.84 if state.regime == "CHOP" else 0.8 if state.regime == "VOLATILE" else 0.9)
            reasons.append("switch_market_selective")
        elif state.regime == "TREND":
            strategy_mode = "trend_follow"
        elif state.regime == "CHOP":
            strategy_mode = "mean_reversion"

        memory_match = self.policy_memory.resolve(state, normalized_source)
        if memory_match is not None:
            best_policy = memory_match.get("best_policy") if isinstance(memory_match.get("best_policy"), dict) else {}
            strategy_mode = str(best_policy.get("strategy_mode") or strategy_mode).strip() or strategy_mode
            route_mode_override = str(best_policy.get("route_mode_override") or route_mode_override).strip() or route_mode_override
            execution_style = str(best_policy.get("execution_style") or execution_style).strip() or execution_style
            max_spread_multiplier = min(max_spread_multiplier, _clamp(_to_float(best_policy.get("max_spread_multiplier"), max_spread_multiplier), 0.35, 1.0))
            size_multiplier_cap = min(size_multiplier_cap, _clamp(_to_float(best_policy.get("size_multiplier"), size_multiplier_cap), 0.0, 1.0))
            reasons.append(f"policy_memory:{memory_match.get('context_key')}")

        memory_v2_match = self.memory_engine_v2.resolve(state, normalized_source)
        memory_v2_recommendation = memory_v2_match.get("recommendation") if isinstance(memory_v2_match.get("recommendation"), dict) else {}
        memory_v2_confidence = _to_float(memory_v2_match.get("confidence"), 0.0)
        memory_v2_source = str(memory_v2_match.get("source") or "")
        memory_v2_applied = False
        if memory_v2_recommendation and memory_v2_confidence >= 0.24:
            strategy_mode = str(memory_v2_recommendation.get("strategy_mode") or strategy_mode).strip() or strategy_mode
            route_mode_override = str(memory_v2_recommendation.get("route_mode_override") or route_mode_override).strip() or route_mode_override
            execution_style = str(memory_v2_recommendation.get("execution_style") or execution_style).strip() or execution_style
            max_spread_multiplier = min(
                max_spread_multiplier,
                _clamp(_to_float(memory_v2_recommendation.get("max_spread_multiplier"), max_spread_multiplier), 0.35, 1.0),
            )
            size_multiplier_cap = min(
                size_multiplier_cap,
                _clamp(_to_float(memory_v2_recommendation.get("size_multiplier_cap"), size_multiplier_cap), 0.0, 1.0),
            )
            reasons.append(
                f"memory_v2:{memory_v2_match.get('causal_key') or memory_v2_match.get('semantic_key') or memory_v2_match.get('context_key')}"
            )
            memory_v2_applied = True

        deduped_reasons: list[str] = []
        for reason in reasons:
            if reason and reason not in deduped_reasons:
                deduped_reasons.append(reason)
        return {
            "mode": "switched" if deduped_reasons else "default",
            "strategy_mode": strategy_mode,
            "route_mode_override": route_mode_override,
            "execution_style": execution_style,
            "max_spread_multiplier": round(max_spread_multiplier, 6),
            "size_multiplier_cap": round(size_multiplier_cap, 6),
            "reasons": deduped_reasons,
            "failure_source": normalized_source,
            "profile_id": str(meta_agent_payload.get("profile_id") or ""),
            "global_mode": str(meta_agent_payload.get("global_mode") or ""),
            "venue_action": str(meta_agent_payload.get("venue_action") or "stay_primary"),
            "execution_delay_ms": int(_to_float(meta_agent_payload.get("execution_delay_ms"), 0.0)),
            "halt_new_exposure": bool(meta_agent_payload.get("halt_new_exposure")),
            "close_only": bool(meta_agent_payload.get("close_only")),
            "simulation_profile": str(meta_agent_payload.get("simulation_profile") or "balanced"),
            "policy_memory_key": str(memory_match.get("context_key") or "") if memory_match is not None else "",
            "policy_memory_confidence": round(_to_float(memory_match.get("confidence"), 0.0), 6) if memory_match is not None else 0.0,
            "memory_v2_context_key": str(memory_v2_match.get("context_key") or ""),
            "memory_v2_semantic_key": str(memory_v2_match.get("semantic_key") or ""),
            "memory_v2_causal_key": str(memory_v2_match.get("causal_key") or ""),
            "memory_v2_confidence": round(memory_v2_confidence, 6),
            "memory_v2_source": memory_v2_source,
            "memory_v2_applied": memory_v2_applied,
            "applied_from_memory": memory_match is not None,
        }

    def _infer_meta_failure_source_from_state(self, state: MarketState) -> str | None:
        if state.network_regime == "critical" or state.infra_health <= 0.35:
            return "infra"
        if state.network_regime == "degraded" or state.infra_health <= 0.62:
            return "infra"
        if state.latency >= 220.0 or state.spread >= 8.0 or (state.fill_probability > 0.0 and state.fill_probability <= 0.4):
            return "execution"
        if state.regime == "CHOP" or state.volatility >= 18.0:
            return "market"
        return None

    def _build_meta_agent_plan(self, state: MarketState, feature_summary: dict[str, Any]) -> dict[str, Any]:
        inferred_failure_source = self._infer_meta_failure_source_from_state(state)
        reasons: list[str] = []
        profile_id = "balanced_core"
        strategic_memory_match = self.strategic_memory.resolve(state)

        if state.network_regime == "critical" or state.infra_health <= 0.28:
            profile_id = "risk_off"
            reasons.append("infra_critical")
        elif inferred_failure_source == "infra":
            profile_id = "execution_safe"
            reasons.append("infra_degraded")
        elif inferred_failure_source == "execution":
            profile_id = "execution_safe"
            reasons.append("execution_friction")
        elif state.volatility >= 18.0 or state.latent_label == "stress":
            profile_id = "news_spike"
            reasons.append("volatility_spike")
        elif state.regime == "CHOP" or state.latent_label in {"mean-revert", "compression", "auction"}:
            profile_id = "chop_mean_reversion"
            reasons.append("regime_chop")
        elif state.regime == "TREND" and state.orderflow_quality >= 0.42 and state.anchor_confluence >= 0.3:
            profile_id = "trend_high_conviction"
            reasons.append("trend_alignment")

        strategic_profile_id = str((strategic_memory_match or {}).get("best_strategy") or "").strip()
        strategic_confidence = _to_float((strategic_memory_match or {}).get("confidence"), 0.0)
        if strategic_profile_id in STRATEGY_LIBRARY and strategic_confidence >= 0.34:
            allow_memory_override = profile_id not in {"risk_off", "execution_safe"}
            if inferred_failure_source == "execution" and strategic_profile_id in {"execution_safe", "balanced_core"}:
                allow_memory_override = True
            if inferred_failure_source is None and state.network_regime == "stable":
                allow_memory_override = True
            if allow_memory_override:
                profile_id = strategic_profile_id
                reasons.append(f"strategic_memory:{strategic_profile_id}")

        profile = STRATEGY_LIBRARY[profile_id]
        close_only = profile.close_only and abs(state.position) > 0
        confidence_floor = 0.72 if profile_id == "risk_off" else 0.66 if profile_id == "execution_safe" else 0.58
        return {
            "profile_id": profile.profile_id,
            "global_mode": profile.global_mode,
            "strategy_mode": profile.strategy_mode,
            "execution_style": profile.execution_style,
            "route_mode_override": profile.route_mode_override,
            "exposure_multiplier": round(_clamp(profile.exposure_multiplier, 0.0, 1.0), 6),
            "max_spread_multiplier": round(_clamp(profile.max_spread_multiplier, 0.35, 1.0), 6),
            "agent_biases": profile.agent_biases,
            "disabled_agents": list(profile.disabled_agents),
            "venue_action": profile.venue_action,
            "execution_delay_ms": max(0, int(profile.execution_delay_ms)),
            "halt_new_exposure": bool(profile.halt_new_exposure),
            "close_only": bool(close_only),
            "simulation_profile": profile.simulation_profile,
            "failure_source": inferred_failure_source,
            "reasons": reasons,
            "feature_leader": str(feature_summary.get("top_family") or "n/a"),
            "strategic_memory_confidence": round(strategic_confidence, 6),
            "strategic_memory_context_key": str((strategic_memory_match or {}).get("context_key") or ""),
            "confidence_floor": confidence_floor,
        }

    def _apply_meta_policy(self, state: MarketState, votes: list[AgentVote]) -> dict[str, Any]:
        regime = state.regime or "NEUTRAL"
        disabled_agents: list[str] = []
        weights: dict[str, float] = {}
        feature_summary = self.feature_tracker.summary_for_state(state)
        meta_agent = self._build_meta_agent_plan(state, feature_summary)
        for vote in votes:
            multiplier = self._meta_weight_for_agent(vote.name, state, meta_agent)
            disabled = vote.name in meta_agent.get("disabled_agents", [])
            if disabled and vote.name != "risk":
                vote.action = Action.HOLD
                vote.disabled = True
                vote.reasoning = f"{vote.reasoning} | meta_disabled={meta_agent.get('profile_id') or regime.lower()}"
                disabled_agents.append(vote.name)
            vote.meta_weight = multiplier
            vote.weight = 0.0 if vote.disabled else _clamp(vote.base_weight * multiplier, 0.0, 3.5)
            weights[vote.name] = round(vote.weight, 6)
        return {
            "regime": regime,
            "weights": weights,
            "meta_agent": meta_agent,
            "agent_learning_rates": {
                name: {
                    "base": round(agent.base_learning_rate, 6),
                    "multiplier": round(agent.performance.learning_rate_multiplier, 6),
                    "feature_multiplier": round(agent.performance.feature_learning_rate_multiplier, 6),
                    "failure_multiplier": round(agent.performance.failure_learning_rate_multiplier, 6),
                    "effective": round(agent.performance.effective_learning_rate, 6),
                    "dominant_failure_source": agent.performance.dominant_failure_source,
                }
                for name, agent in self.agents.items()
            },
            "disabled_agents": disabled_agents,
            "orderflow_quality": round(state.orderflow_quality, 6),
            "anchor_primary": state.anchor_primary,
            "anchor_confluence": round(state.anchor_confluence, 6),
            "anchor_compression_bps": round(state.anchor_compression, 6),
            "feature_attribution": feature_summary.get("families", {}),
            "feature_context": feature_summary.get("context", {}),
            "feature_leader": feature_summary.get("top_family", "n/a"),
            "feature_leader_contribution": round(_to_float(feature_summary.get("top_contribution"), 0.0), 6),
            "distance_to_vwap": round(state.distance_to_vwap, 6),
            "vwap_slope": round(state.vwap_slope, 6),
            "liquidity_pressure": round(state.liquidity_pressure, 6),
            "sweep_risk": round(state.sweep_risk, 6),
            "liquidity_vacuum": round(state.liquidity_vacuum, 6),
            "liquidity_state": state.liquidity_state,
            "market_session": state.market_session,
            "latent_label": state.latent_label,
            "latent_confidence": round(state.latent_confidence, 6),
            "latent_transition": round(state.latent_transition, 6),
            "latent_factor": self.latent_encoder._latent_factor(state.latent_vector),
            "infra_health": round(state.infra_health, 6),
            "network_regime": state.network_regime,
        }

    def _meta_weight_for_agent(self, agent_name: str, state: MarketState, meta_agent: dict[str, Any] | None = None) -> float:
        base_map = {
            "TREND": {"scalper": 0.82, "trend": 1.32, "liquidity": 0.98, "execution": 1.08, "risk": 1.0},
            "CHOP": {"scalper": 1.22, "trend": 0.12, "liquidity": 1.18, "execution": 0.92, "risk": 1.08},
            "VOLATILE": {"scalper": 0.48, "trend": 0.68, "liquidity": 1.26, "execution": 0.78, "risk": 1.32},
            "NEUTRAL": {"scalper": 1.0, "trend": 1.0, "liquidity": 1.0, "execution": 1.0, "risk": 1.0},
        }
        multiplier = base_map.get(state.regime, base_map["NEUTRAL"]).get(agent_name, 1.0)
        multiplier *= self._feature_multiplier_for_agent(agent_name, state)
        meta_agent_payload = meta_agent if isinstance(meta_agent, dict) else {}
        agent_biases = meta_agent_payload.get("agent_biases") if isinstance(meta_agent_payload.get("agent_biases"), dict) else {}
        multiplier *= _clamp(_to_float(agent_biases.get(agent_name), 1.0), 0.0, 1.6)
        if abs(state.absorption_signal) >= 0.5:
            if agent_name == "liquidity":
                multiplier += 0.18
            elif agent_name == "scalper":
                multiplier += 0.1
        if abs(state.liquidity_trap_signal) >= 0.5:
            if agent_name == "liquidity":
                multiplier += 0.26
            elif agent_name == "trend":
                multiplier -= 0.18
        if state.anchor_confluence >= 0.45:
            if agent_name == "liquidity":
                multiplier += 0.12
            elif agent_name == "trend":
                multiplier -= 0.08 if state.regime == "CHOP" else 0.0
        if state.sweep_risk >= 0.65:
            if agent_name == "execution":
                multiplier -= 0.18
            elif agent_name == "risk":
                multiplier += 0.12
            elif agent_name == "liquidity":
                multiplier += 0.1
        if state.liquidity_vacuum >= 0.55:
            if agent_name == "scalper":
                multiplier -= 0.14
            elif agent_name == "risk":
                multiplier += 0.08
        if state.spread >= 10.0 or state.latency >= 250.0:
            if agent_name == "execution":
                multiplier -= 0.12
            elif agent_name == "risk":
                multiplier += 0.08
        if state.network_regime == "critical":
            if agent_name == "risk":
                multiplier += 0.18
            elif agent_name == "execution":
                multiplier -= 0.18
            elif agent_name == "trend":
                multiplier -= 0.1
        elif state.network_regime == "degraded":
            if agent_name == "risk":
                multiplier += 0.08
            elif agent_name == "execution":
                multiplier -= 0.08
        if state.orderflow_quality < 0.18 and agent_name == "scalper":
            multiplier -= 0.12
        if state.latent_label == "stress":
            if agent_name == "risk":
                multiplier += 0.16
            elif agent_name == "liquidity":
                multiplier += 0.12
            elif agent_name == "trend":
                multiplier -= 0.12
            elif agent_name == "execution":
                multiplier -= 0.08
        elif state.latent_label == "impulse-trend":
            if agent_name == "trend":
                multiplier += 0.18
            elif agent_name == "scalper":
                multiplier += 0.08
        elif state.latent_label in {"mean-revert", "compression", "auction"}:
            if agent_name == "scalper":
                multiplier += 0.14
            elif agent_name == "liquidity":
                multiplier += 0.08
            elif agent_name == "trend":
                multiplier -= 0.14
        return _clamp(multiplier, 0.0, 1.8)

    def _feature_multiplier_for_agent(self, agent_name: str, state: MarketState) -> float:
        families = AGENT_FAMILY_MAP.get(agent_name, ("regime",))
        return _clamp(_average([self.feature_tracker.performance_multiplier(family, state) for family in families]), 0.72, 1.38)

    def _attach_latent_to_experience(self, experience: Experience, *, update_encoder: bool) -> None:
        if update_encoder:
            self.latent_encoder.observe_experience(experience)
        else:
            experience.state = self.latent_encoder.enrich_state(experience.state, update_hidden=False)
            experience.next_state = self.latent_encoder.enrich_state(experience.next_state, prev_vector=experience.state.latent_vector, update_hidden=False)
            experience.context.setdefault("latent", experience.state.latent_label)
            experience.context.setdefault("latent_next", experience.next_state.latent_label)
        experience.context.setdefault("origin", "synthetic" if experience.synthetic else "real")

    def _dream_variation(self, state: MarketState, span: float, simulation_profile: str) -> MarketState:
        profile = SIMULATION_PROFILE_LIBRARY.get(simulation_profile, SIMULATION_PROFILE_LIBRARY["balanced"])
        price_noise = _to_float(profile.get("price_noise"), 1.0)
        spread_noise = _to_float(profile.get("spread_noise"), 1.0)
        latency_spike = _to_float(profile.get("latency_spike"), 1.0)
        backlog_spike = _to_float(profile.get("backlog_spike"), 1.0)
        slippage_spike = _to_float(profile.get("slippage_spike"), 1.0)
        fill_drag = _to_float(profile.get("fill_drag"), 1.0)
        spoofing_burst = _to_float(profile.get("spoofing_burst"), 1.0)
        partial_fill_risk = _to_float(profile.get("partial_fill_risk"), 1.0)
        network_bias = str(profile.get("network_bias") or state.network_regime or "stable")
        varied = replace(
            state,
            price=max(0.0, state.price * (1.0 + random.uniform(-span, span) * price_noise * max(0.00035, state.volatility / 6000.0))),
            spread=max(0.0, state.spread * (1.0 + random.uniform(-span, span) * 0.24 * spread_noise)),
            imbalance=_clamp(state.imbalance + random.uniform(-span, span) * 0.48, -1.5, 1.5),
            volatility=max(0.0, state.volatility * (1.0 + random.uniform(-span, span) * 0.35)),
            fill_probability=_clamp(state.fill_probability + random.uniform(-span, span) * 0.16 / max(0.2, fill_drag), 0.0, 1.0),
            momentum=_clamp(state.momentum + random.uniform(-span, span) * 0.38, -2.0, 2.0),
            slippage=max(0.0, state.slippage * (1.0 + random.uniform(-span, span) * 0.28 * slippage_spike)),
            orderflow_delta=state.orderflow_delta * (1.0 + random.uniform(-span, span) * 0.32),
            orderflow_imbalance=_clamp(state.orderflow_imbalance + random.uniform(-span, span) * 0.3, -1.5, 1.5),
            absorption_signal=_clamp(state.absorption_signal + random.uniform(-span, span) * 0.2, -1.0, 1.0),
            liquidity_trap_signal=_clamp(state.liquidity_trap_signal + random.uniform(-span, span) * 0.22, -1.0, 1.0),
            spoofing_score=_clamp(state.spoofing_score + random.uniform(-span, span) * 0.18 * spoofing_burst, -1.0, 1.0),
            distance_to_vwap=state.distance_to_vwap + random.uniform(-span, span) * 10.0,
            vwap_slope=state.vwap_slope + random.uniform(-span, span) * 5.0,
            anchor_confluence=_clamp(state.anchor_confluence + random.uniform(-span, span) * 0.12, 0.0, 1.0),
            anchor_compression=max(0.0, state.anchor_compression * (1.0 + random.uniform(-span, span) * 0.18)),
            liquidity_pressure=_clamp(state.liquidity_pressure + random.uniform(-span, span) * 0.34, -1.5, 1.5),
            resting_imbalance=_clamp(state.resting_imbalance + random.uniform(-span, span) * 0.3, -1.5, 1.5),
            sweep_risk=_clamp(state.sweep_risk + random.uniform(-span, span) * 0.14, 0.0, 1.0),
            liquidity_vacuum=_clamp(state.liquidity_vacuum + random.uniform(-span, span) * 0.14, 0.0, 1.0),
            support_score=_clamp(state.support_score + random.uniform(-span, span) * 0.12, 0.0, 1.0),
            resistance_score=_clamp(state.resistance_score + random.uniform(-span, span) * 0.12, 0.0, 1.0),
            latency=max(0.0, state.latency * (1.0 + random.uniform(-span, span) * 0.34 * latency_spike)),
            backlog=_clamp(state.backlog + random.uniform(0.0, span) * 1.4 * backlog_spike, 0.0, 4.0),
            render_pressure=_clamp(state.render_pressure + random.uniform(0.0, span) * 1.2 * backlog_spike, 0.0, 4.0),
            infra_health=_clamp(state.infra_health - random.uniform(0.0, span) * 0.42 * max(0.8, latency_spike), 0.05, 1.0),
            network_regime=_normalize_network_regime(network_bias),
            latent_vector=[],
            latent_label="uninitialized",
            latent_confidence=0.0,
            latent_transition=0.0,
        )
        varied.depth = max(0.0, varied.depth * (1.0 - random.uniform(0.0, span) * 0.18 * partial_fill_risk))
        if varied.fill_probability > 0.0:
            varied.fill_probability = _clamp(varied.fill_probability - random.uniform(0.0, span) * 0.12 * partial_fill_risk, 0.0, 1.0)
        varied.orderflow_quality = _compute_orderflow_quality(varied)
        varied.liquidity_engine_score = _compute_liquidity_engine_score(varied)
        varied.regime = detect_regime(varied)
        return varied

    def _state_from_causal_pattern(self, bucket: dict[str, Any]) -> MarketState:
        regime = str(bucket.get("regime") or "NEUTRAL").strip().upper() or "NEUTRAL"
        failure_source = _normalize_failure_source(bucket.get("failure_source"))
        network_regime = _normalize_network_regime(bucket.get("network_regime"))
        liquidity_state = str(bucket.get("liquidity_state") or "balanced").strip().lower() or "balanced"
        spread_bps = 1.4
        latency_ms = 70.0
        volatility_bps = 6.0
        fill_probability = 0.64
        slippage_bps = 1.2
        sweep_risk = 0.18
        liquidity_vacuum = 0.12
        infra_health = 0.88

        if regime == "CHOP":
            spread_bps = 2.1
            volatility_bps = 8.0
            fill_probability = 0.58
        elif regime == "VOLATILE":
            spread_bps = 3.4
            volatility_bps = 18.0
            fill_probability = 0.42
            slippage_bps = 2.6
            sweep_risk = 0.42
            liquidity_vacuum = 0.3

        if failure_source == "execution":
            spread_bps = max(spread_bps, 2.8)
            latency_ms = 180.0
            fill_probability = min(fill_probability, 0.46)
            slippage_bps = max(slippage_bps, 3.6)
        elif failure_source == "infra":
            latency_ms = 320.0
            infra_health = 0.42
            fill_probability = min(fill_probability, 0.48)
            network_regime = "critical" if network_regime == "stable" else network_regime
        elif failure_source == "market":
            spread_bps = max(spread_bps, 2.5)
            volatility_bps = max(volatility_bps, 14.0)
            slippage_bps = max(slippage_bps, 2.1)
            sweep_risk = max(sweep_risk, 0.54)
            liquidity_vacuum = max(liquidity_vacuum, 0.4)

        state = MarketState.from_payload({
            "price": 100.0,
            "spread_bps": spread_bps,
            "volatility_bps": volatility_bps,
            "regime": regime,
            "market_session": str(bucket.get("market_session") or "off").strip().lower() or "off",
            "network_regime": network_regime,
            "latency_ms": latency_ms,
            "available_depth_usd": 18000.0 if liquidity_state == "balanced" else 12000.0,
            "fill_probability": fill_probability,
            "slippage_bps": slippage_bps,
            "liquidity_state": liquidity_state,
            "latent_label": str(bucket.get("latent_label") or "uninitialized").strip().lower() or "uninitialized",
            "infra_health": infra_health,
            "sweep_risk": sweep_risk,
            "liquidity_vacuum": liquidity_vacuum,
            "anchor_confluence": 0.24 if regime == "CHOP" else 0.12,
            "liquidity_pressure": 0.18 if failure_source == "market" else 0.06,
            "resting_imbalance": 0.08,
            "support_score": 0.28,
            "resistance_score": 0.28,
            "depth_imbalance": 0.05,
            "edge": -abs(_to_float(bucket.get("avg_reward"), 0.0)),
        })
        state = self.latent_encoder.enrich_state(state, update_hidden=False)
        return replace(
            state,
            regime=regime,
            market_session=str(bucket.get("market_session") or state.market_session or "off").strip().lower() or "off",
            network_regime=network_regime,
            liquidity_state=liquidity_state,
            latent_label=str(bucket.get("latent_label") or state.latent_label or "uninitialized").strip().lower() or "uninitialized",
        )

    def _apply_causal_correction_to_state(self, state: MarketState, correction: dict[str, Any], failure_source: str | None) -> MarketState:
        spread_multiplier = _clamp(_to_float(correction.get("max_spread_multiplier"), 0.92), 0.35, 1.0)
        size_multiplier_cap = _clamp(_to_float(correction.get("size_multiplier_cap"), 0.88), 0.2, 1.0)
        execution_style = str(correction.get("execution_style") or "default").strip()
        route_mode_override = str(correction.get("route_mode_override") or "").strip()
        latency_multiplier = 0.9 if route_mode_override or execution_style in {"maker_passive", "passive_selective", "primary_only"} else 0.96
        fill_boost = 0.12 if execution_style in {"maker_passive", "passive_selective", "primary_only"} else 0.06
        infra_lift = 0.08 if failure_source == "infra" else 0.03
        next_state = replace(
            state,
            spread=max(0.0, state.spread * spread_multiplier),
            depth=max(0.0, state.depth * max(0.45, size_multiplier_cap)),
            fill_probability=_clamp(state.fill_probability + fill_boost, 0.0, 1.0),
            slippage=max(0.0, state.slippage * 0.76),
            latency=max(0.0, state.latency * latency_multiplier),
            infra_health=_clamp(state.infra_health + infra_lift, 0.05, 1.0),
            network_regime=_normalize_network_regime("degraded" if state.network_regime == "critical" else state.network_regime),
            edge=state.edge + 0.45,
            liquidity_pressure=_clamp(state.liquidity_pressure * 0.82, -1.5, 1.5),
            sweep_risk=_clamp(state.sweep_risk * 0.84, 0.0, 1.0),
            liquidity_vacuum=_clamp(state.liquidity_vacuum * 0.82, 0.0, 1.0),
        )
        next_state.orderflow_quality = _compute_orderflow_quality(next_state)
        next_state.liquidity_engine_score = _compute_liquidity_engine_score(next_state)
        next_state.regime = detect_regime(next_state)
        next_state = self.latent_encoder.enrich_state(next_state, prev_vector=state.latent_vector, update_hidden=False)
        return next_state

    def _generate_causal_pattern_dreams(self, limit: int = 3, strict_causal: bool = True) -> list[Experience]:
        candidates = [
            bucket
            for bucket in self.memory_engine_v2.causal.values()
            if isinstance(bucket, dict)
            and isinstance(bucket.get("correction"), dict)
            and bool(bucket.get("correction"))
            and int(bucket.get("sample_count") or 0) >= 3
            and int(bucket.get("failure_sample_count") or 0) >= 2
            and (
                not strict_causal
                or (
                    _to_float(bucket.get("confidence"), 0.0) >= PREDICTOR_V8_CAUSAL_STRICT_MIN_CONFIDENCE
                    and str(bucket.get("correction", {}).get("strategy_mode") or "").strip()
                    and str(bucket.get("correction", {}).get("execution_style") or "").strip()
                    and str(bucket.get("correction", {}).get("route_mode_override") or "").strip()
                )
            )
        ]
        if not candidates:
            return []

        ranked = sorted(
            candidates,
            key=lambda bucket: (
                int(bucket.get("failure_sample_count") or 0),
                int(bucket.get("blocking_count") or 0),
                _to_float(bucket.get("avg_reward"), 0.0),
                int(bucket.get("sample_count") or 0),
            ),
            reverse=True,
        )[: max(1, limit)]

        dreams: list[Experience] = []
        timestamp_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
        for index, bucket in enumerate(ranked):
            correction = dict(bucket.get("correction") or {})
            failure_source = _normalize_failure_source(bucket.get("failure_source"))
            simulation_profile = str(correction.get("simulation_profile") or "balanced").strip() or "balanced"
            base_state = self._state_from_causal_pattern(bucket)
            state = self._dream_variation(base_state, 0.028 + index * 0.01, simulation_profile)
            next_state = self._apply_causal_correction_to_state(
                self._dream_variation(base_state, 0.024 + index * 0.008, simulation_profile),
                correction,
                failure_source,
            )
            raw_reward = _clamp(
                max(0.22, abs(_to_float(bucket.get("avg_reward"), 0.0)) * 0.42)
                + min(0.85, int(bucket.get("sample_count") or 0) / 18.0),
                0.22,
                3.4,
            )
            reward, reward_scale = _apply_failure_reward_adjustment(
                raw_reward,
                failure_source,
                False,
                state,
                next_state,
            )
            features = _compute_feature_family_scores(state)
            action = Action.from_value(bucket.get("action"))
            feature_contributions, feature_diagnostics = _build_feature_attribution(state, action, reward, features)
            causal_key = str(bucket.get("causal_key") or bucket.get("context_key") or f"causal-{index + 1}")
            dream = Experience(
                experience_id=f"causal-dream:{timestamp_ms}:{index + 1}",
                state=state,
                action=action,
                reward=reward,
                next_state=next_state,
                sample_weight=_clamp(0.14 + int(bucket.get("failure_sample_count") or 0) / 40.0, 0.14, 0.38),
                synthetic=True,
                dream_source=causal_key,
                features=features,
                feature_contributions=feature_contributions,
                feature_diagnostics=feature_diagnostics,
                context={
                    "origin": "synthetic",
                    "simulation_profile": simulation_profile,
                    "causal_pattern_id": causal_key,
                    "causal_context_key": str(bucket.get("context_key") or ""),
                    "strategy_mode": str(correction.get("strategy_mode") or ""),
                    "route_mode_override": str(correction.get("route_mode_override") or ""),
                    "execution_style": str(correction.get("execution_style") or ""),
                    "max_spread_multiplier": str(correction.get("max_spread_multiplier") or ""),
                    "size_multiplier_cap": str(correction.get("size_multiplier_cap") or ""),
                    "correction_source": "memory_v2_causal",
                },
                raw_reward=raw_reward,
                reward_scale=reward_scale,
                failure_source=failure_source,
                failure_reasons=["memory_v2_causal_pattern", "offline_dream_correction"],
                failure_blocking=False,
            )
            self._attach_latent_to_experience(dream, update_encoder=False)
            dreams.append(dream)
        return dreams

    def _experience_has_execution_link(self, experience: Experience) -> bool:
        context = experience.context if isinstance(experience.context, dict) else {}
        execution_keys = (
            "order_id",
            "fill_id",
            "fill_price",
            "fill_qty",
            "fill_probability",
            "slippage_bps",
            "realized_slippage_bps",
            "latency_ms",
            "latency_e2e_ms",
            "route_mode",
            "route_mode_override",
            "execution_style",
            "broker",
            "venue",
        )
        if any(context.get(key) not in (None, "", [], {}) for key in execution_keys):
            return True
        return bool(
            experience.state.fill_probability > 0.0
            or experience.state.slippage > 0.0
            or experience.state.latency > 0.0
            or experience.next_state.fill_probability > 0.0
            or experience.next_state.slippage > 0.0
            or experience.next_state.latency > 0.0
        )

    def _generate_safe_dreams(self, experience: Experience) -> list[Experience]:
        if experience.synthetic:
            return []
        if not self._experience_has_execution_link(experience):
            return []
        if experience.reward < PREDICTOR_V8_SAFE_DREAM_MIN_REWARD:
            return []
        if experience.failure_blocking:
            return []
        if experience.state.edge <= 0.0 and experience.next_state.edge <= 0.0:
            return []
        return self._generate_constrained_dreams(experience)

    def _generate_constrained_dreams(self, experience: Experience) -> list[Experience]:
        if experience.synthetic:
            return []
        if experience.state.latent_confidence < 0.12:
            return []
        if abs(experience.reward) < 0.15 and experience.state.latent_transition < 0.08:
            return []
        dream_count = 2 if abs(experience.reward) >= 0.75 or experience.state.latent_label in {"stress", "impulse-trend"} else 1
        base_span = _clamp(0.025 + experience.state.volatility / 450.0 + experience.state.spread / 240.0, 0.025, 0.11)
        simulation_profile = str(
            experience.context.get("simulation_profile")
            or STRATEGY_LIBRARY.get(str(experience.context.get("meta_profile_id") or ""), STRATEGY_LIBRARY["balanced_core"]).simulation_profile
            or "balanced"
        ).strip() or "balanced"
        dreams: list[Experience] = []
        for index in range(dream_count):
            span = _clamp(base_span * (0.85 + index * 0.22), 0.02, 0.12)
            state = self._dream_variation(experience.state, span, simulation_profile)
            next_state = self._dream_variation(experience.next_state, span * 0.85, simulation_profile)
            sample_weight = _clamp(0.16 + experience.state.latent_confidence * 0.26 - experience.state.latent_transition * 0.08, 0.14, 0.42)
            raw_reward = experience.raw_reward * _clamp(0.88 + random.uniform(-0.08, 0.06), 0.72, 0.98)
            reward, reward_scale = _apply_failure_reward_adjustment(
                raw_reward,
                experience.failure_source,
                experience.failure_blocking,
                state,
                next_state,
            )
            features = _compute_feature_family_scores(state)
            feature_contributions, feature_diagnostics = _build_feature_attribution(state, experience.action, reward, features)
            dream = Experience(
                experience_id=f"{experience.experience_id or 'exp'}:dream:{index + 1}",
                state=state,
                action=experience.action,
                reward=reward,
                next_state=next_state,
                sample_weight=sample_weight,
                synthetic=True,
                dream_source=experience.experience_id or "real",
                features=features,
                feature_contributions=feature_contributions,
                feature_diagnostics=feature_diagnostics,
                context={**experience.context, "origin": "synthetic", "simulation_profile": simulation_profile},
                raw_reward=raw_reward,
                reward_scale=reward_scale,
                failure_source=experience.failure_source,
                failure_reasons=list(experience.failure_reasons),
                failure_blocking=experience.failure_blocking,
            )
            self._attach_latent_to_experience(dream, update_encoder=False)
            dreams.append(dream)
        return dreams