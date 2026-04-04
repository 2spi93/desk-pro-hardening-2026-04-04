from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Any

from .features import FEATURE_KEYS, build_features

HORIZONS_MS = (20, 50, 100)
WORLD_MODEL_HORIZONS_MS = (100, 250, 500)


def _clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def _sigmoid(value: float) -> float:
    if value >= 0:
        z = math.exp(-value)
        return 1.0 / (1.0 + z)
    z = math.exp(value)
    return z / (1.0 + z)


def _dot(left: list[float], right: list[float]) -> float:
    return sum(l * r for l, r in zip(left, right))


class MicrostructureWorldModel:
    def __init__(self) -> None:
        self.observations = 0
        self.avg_abs_error = {
            "slippage_bps": 0.0,
            "fill_probability": 0.0,
            "latency_ms": 0.0,
            "spread_bps": 0.0,
        }
        self.updated_at: str | None = None

    def _ctx_float(self, ctx: dict[str, Any], *keys: str, default: float = 0.0) -> float:
        for key in keys:
            value = ctx.get(key)
            try:
                return float(value)
            except Exception:
                continue
        return default

    def _world_snapshot(self, ctx: dict[str, Any], *, horizon_ms: int, probability: float) -> dict[str, Any]:
        spread_bps = self._ctx_float(ctx, "spread_bps", "spread", default=0.0)
        slippage_bps = abs(self._ctx_float(ctx, "slippage_bps", "slippage", default=0.0))
        fill_probability = _clamp(self._ctx_float(ctx, "fill_probability", default=0.0), 0.0, 1.0)
        latency_ms = max(0.0, self._ctx_float(ctx, "latency_ms", "latency", default=0.0))
        depth_imbalance = self._ctx_float(ctx, "depth_imbalance", "imbalance", default=0.0)
        volatility_bps = abs(self._ctx_float(ctx, "volatility_bps", "volatility", default=0.0))
        backlog_pressure = max(0.0, self._ctx_float(ctx, "backlog_pressure", "backlog", default=0.0))
        render_pressure = max(0.0, self._ctx_float(ctx, "render_pressure", default=0.0))
        orderflow_quality = _clamp(self._ctx_float(ctx, "orderflow_quality", default=0.0), 0.0, 1.0)
        trend_score = self._ctx_float(ctx, "trend_score", default=0.0)
        momentum = self._ctx_float(ctx, "momentum", "cvd_delta", default=0.0)
        infra_health = _clamp(self._ctx_float(ctx, "infra_health", default=1.0), 0.05, 1.0)
        timeout_rate = _clamp(self._ctx_float(ctx, "timeout_rate", default=0.0), 0.0, 1.0)
        dns_transient_rate = _clamp(self._ctx_float(ctx, "dns_transient_rate", default=0.0), 0.0, 1.0)
        degraded_usage_ratio = _clamp(self._ctx_float(ctx, "degraded_usage_ratio", default=0.0), 0.0, 1.0)
        quote_fade_rate = max(0.0, self._ctx_float(ctx, "quote_fade_rate", default=0.0))
        micro_burst = max(0.0, self._ctx_float(ctx, "micro_burst_10ms", default=0.0))
        liquidity_pressure = abs(self._ctx_float(ctx, "liquidity_pressure", default=0.0))
        sweep_risk = _clamp(self._ctx_float(ctx, "sweep_risk", default=0.0), 0.0, 1.0)
        liquidity_vacuum = _clamp(self._ctx_float(ctx, "liquidity_vacuum", default=0.0), 0.0, 1.0)
        network_regime = str(ctx.get("network_regime") or "stable").strip().lower() or "stable"

        horizon_scale = horizon_ms / 500.0
        queue_priority_risk = _clamp(
            spread_bps / 18.0 * 0.22
            + abs(depth_imbalance) * 0.16
            + backlog_pressure / 4.0 * 0.18
            + quote_fade_rate / 4.0 * 0.16
            + micro_burst / 12.0 * 0.12
            + liquidity_pressure * 0.08
            + sweep_risk * 0.08,
            0.0,
            1.0,
        )
        hidden_liquidity_ratio = _clamp(
            0.52
            + max(0.0, orderflow_quality - 0.35) * 0.26
            - min(0.24, volatility_bps / 80.0)
            - min(0.12, liquidity_vacuum * 0.16),
            0.12,
            0.88,
        )
        venue_stability = _clamp(
            infra_health * 0.62
            + (1.0 - timeout_rate) * 0.16
            + (1.0 - dns_transient_rate) * 0.12
            + (1.0 - degraded_usage_ratio) * 0.1,
            0.05,
            1.0,
        )
        expected_latency_ms = max(
            0.0,
            latency_ms
            + horizon_scale * (18.0 + 42.0 * backlog_pressure + 21.0 * render_pressure)
            + (1.0 - infra_health) * 160.0
            + degraded_usage_ratio * 90.0,
        )
        expected_spread_bps = max(
            0.1,
            spread_bps * (1.0 + horizon_scale * 0.08)
            + volatility_bps * 0.055
            + queue_priority_risk * 1.8
            + (1.0 - venue_stability) * 2.8,
        )
        expected_slippage_bps = max(
            0.0,
            slippage_bps * (1.0 + horizon_scale * 0.18)
            + expected_spread_bps * 0.34
            + queue_priority_risk * 3.4
            + liquidity_vacuum * 2.1
            + (1.0 - hidden_liquidity_ratio) * 1.5,
        )
        expected_fill_probability = _clamp(
            fill_probability
            - horizon_scale * 0.08
            - queue_priority_risk * 0.22
            - liquidity_vacuum * 0.12
            + hidden_liquidity_ratio * 0.06
            + orderflow_quality * 0.04,
            0.02,
            0.99,
        )
        expected_mid_price_change_bps = _clamp(
            trend_score * 7.5 * horizon_scale
            + momentum * 2.2 * horizon_scale
            + (probability - 0.5) * 14.0 * horizon_scale
            - liquidity_pressure * 1.8,
            -18.0,
            18.0,
        )
        execution_risk_score = _clamp(
            expected_slippage_bps / 12.0 * 0.34
            + (1.0 - expected_fill_probability) * 0.28
            + min(1.0, expected_latency_ms / 420.0) * 0.16
            + queue_priority_risk * 0.1
            + (1.0 - venue_stability) * 0.12,
            0.0,
            1.0,
        )
        recommended_delay_ms = 0
        if execution_risk_score >= 0.56:
            recommended_delay_ms = min(900, int(30 + expected_latency_ms * 0.28 + horizon_ms * 0.24 + execution_risk_score * 180.0))
        future_regime = "stable"
        if execution_risk_score >= 0.84 or network_regime == "critical":
            future_regime = "critical"
        elif execution_risk_score >= 0.66 or network_regime == "degraded":
            future_regime = "stressed"
        elif abs(expected_mid_price_change_bps) >= 6.0:
            future_regime = "trend"
        direction_bias = "flat"
        if expected_mid_price_change_bps >= 1.25:
            direction_bias = "up"
        elif expected_mid_price_change_bps <= -1.25:
            direction_bias = "down"
        return {
            "horizon_ms": horizon_ms,
            "future_regime": future_regime,
            "direction_bias": direction_bias,
            "expected_mid_price_change_bps": round(expected_mid_price_change_bps, 6),
            "expected_spread_bps": round(expected_spread_bps, 6),
            "expected_slippage_bps": round(expected_slippage_bps, 6),
            "expected_fill_probability": round(expected_fill_probability, 6),
            "expected_latency_ms": round(expected_latency_ms, 6),
            "queue_priority_risk": round(queue_priority_risk, 6),
            "hidden_liquidity_ratio": round(hidden_liquidity_ratio, 6),
            "venue_stability": round(venue_stability, 6),
            "execution_risk_score": round(execution_risk_score, 6),
            "recommended_delay_ms": recommended_delay_ms,
        }

    def predict(self, ctx: dict[str, Any], *, probability: float) -> dict[str, Any]:
        horizons = {
            str(horizon): self._world_snapshot(ctx, horizon_ms=horizon, probability=probability)
            for horizon in WORLD_MODEL_HORIZONS_MS
        }
        summary = horizons[str(WORLD_MODEL_HORIZONS_MS[-1])]
        return {
            "summary": summary,
            "horizons": horizons,
            "observations": self.observations,
            "avg_abs_error": {metric: round(value, 6) for metric, value in self.avg_abs_error.items()},
            "updated_at": self.updated_at,
        }

    def observe_transition(self, current_ctx: dict[str, Any], next_ctx: dict[str, Any]) -> None:
        summary = self.predict(current_ctx, probability=float(current_ctx.get("probability") or current_ctx.get("model_probability") or 0.5)).get("summary", {})
        if not isinstance(summary, dict):
            return
        observed = {
            "slippage_bps": abs(self._ctx_float(next_ctx, "slippage_bps", "slippage", default=self._ctx_float(current_ctx, "slippage_bps", "slippage", default=0.0))),
            "fill_probability": _clamp(self._ctx_float(next_ctx, "fill_probability", default=self._ctx_float(current_ctx, "fill_probability", default=0.0)), 0.0, 1.0),
            "latency_ms": max(0.0, self._ctx_float(next_ctx, "latency_ms", "latency", default=self._ctx_float(current_ctx, "latency_ms", "latency", default=0.0))),
            "spread_bps": max(0.0, self._ctx_float(next_ctx, "spread_bps", "spread", default=self._ctx_float(current_ctx, "spread_bps", "spread", default=0.0))),
        }
        predicted = {
            "slippage_bps": float(summary.get("expected_slippage_bps") or 0.0),
            "fill_probability": float(summary.get("expected_fill_probability") or 0.0),
            "latency_ms": float(summary.get("expected_latency_ms") or 0.0),
            "spread_bps": float(summary.get("expected_spread_bps") or 0.0),
        }
        self.observations += 1
        for metric, observed_value in observed.items():
            error = abs(observed_value - predicted[metric])
            previous = self.avg_abs_error.get(metric, 0.0)
            self.avg_abs_error[metric] = previous * 0.92 + error * 0.08 if self.observations > 1 else error
        self.updated_at = datetime.now(timezone.utc).isoformat()

    def load_state(self, payload: dict[str, Any]) -> None:
        self.observations = max(0, int(payload.get("observations") or 0))
        raw_errors = payload.get("avg_abs_error") if isinstance(payload.get("avg_abs_error"), dict) else {}
        for metric in self.avg_abs_error:
            try:
                self.avg_abs_error[metric] = float(raw_errors.get(metric) or 0.0)
            except Exception:
                self.avg_abs_error[metric] = 0.0
        self.updated_at = payload.get("updated_at") if isinstance(payload.get("updated_at"), str) else None

    def dump_state(self) -> dict[str, Any]:
        return {
            "observations": self.observations,
            "avg_abs_error": {metric: value for metric, value in self.avg_abs_error.items()},
            "updated_at": self.updated_at,
        }

    def get_stats(self) -> dict[str, Any]:
        return {
            "observations": self.observations,
            "avg_abs_error": {metric: round(value, 6) for metric, value in self.avg_abs_error.items()},
            "updated_at": self.updated_at,
        }


class V8Model:
    def __init__(self) -> None:
        self.weights_by_horizon: dict[int, list[float]] = {
            20: [0.55, 0.34, -0.82, -0.40, 0.28, 0.11, -0.17, 0.76, 0.44, 0.25, 0.22, -0.20, 0.13, -0.35, -0.21],
            50: [0.48, 0.30, -0.95, -0.46, 0.33, 0.14, -0.22, 0.88, 0.51, 0.29, 0.18, -0.24, 0.10, -0.42, -0.28],
            100: [0.41, 0.24, -1.08, -0.54, 0.36, 0.17, -0.26, 0.79, 0.45, 0.26, 0.12, -0.27, 0.08, -0.48, -0.36],
        }
        self.bias_by_horizon: dict[int, float] = {20: -0.05, 50: -0.12, 100: -0.18}
        self.world_model = MicrostructureWorldModel()
        self.samples = 0
        self.updated_at: str | None = None

    def predict(self, ctx: dict[str, Any]) -> dict[str, Any]:
        multi_horizon: dict[str, Any] = {}
        p20 = 0.0
        p50 = 0.0
        p100 = 0.0
        for horizon in HORIZONS_MS:
            features = build_features(ctx, horizon)
            score = _dot(self.weights_by_horizon[horizon], features) + self.bias_by_horizon[horizon]
            probability = _sigmoid(score)
            multi_horizon[str(horizon)] = {
                "probability": probability,
                "confidence": abs(probability - 0.5) * 2.0,
                "features": dict(zip(FEATURE_KEYS, features)),
            }
            if horizon == 20:
                p20 = probability
            elif horizon == 50:
                p50 = probability
            else:
                p100 = probability

        edge_net_bps = float(ctx.get("arb_edge_bps") or 0.0)
        latency_cost_bps = float(ctx.get("latency_cost_bps") or 0.0)
        final_edge_bps = edge_net_bps - latency_cost_bps
        world_model = self.world_model.predict(ctx, probability=p50)
        world_summary = world_model.get("summary") if isinstance(world_model.get("summary"), dict) else {}
        reasons: list[str] = []
        if p50 <= 0.7:
            reasons.append("p50_below_threshold")
        if p20 <= 0.6:
            reasons.append("p20_below_threshold")
        if final_edge_bps <= 0.0:
            reasons.append("final_edge_non_positive")
        if float(world_summary.get("expected_slippage_bps") or 0.0) >= max(6.0, float(ctx.get("max_spread_bps") or 0.0) * 0.72 if float(ctx.get("max_spread_bps") or 0.0) > 0 else 6.0):
            reasons.append("world_slippage_above_threshold")
        if float(world_summary.get("expected_fill_probability") or 1.0) <= 0.34:
            reasons.append("world_fill_probability_low")
        if float(world_summary.get("execution_risk_score") or 0.0) >= 0.82:
            reasons.append("world_execution_risk_high")
        should_execute = len(reasons) == 0
        return {
            "probability": p50,
            "should_execute": should_execute,
            "model_should_execute": should_execute,
            "confidence": abs(p50 - 0.5) * 2.0,
            "multi_horizon": multi_horizon,
            "world_model": world_model,
            "edge_net_bps": edge_net_bps,
            "latency_cost_bps": latency_cost_bps,
            "final_edge_bps": final_edge_bps,
            "model_reasons": reasons,
        }

    def update(self, ctx: dict[str, Any], label: float) -> None:
        learning_rate = 0.01
        for horizon in HORIZONS_MS:
            features = build_features(ctx, horizon)
            score = _dot(self.weights_by_horizon[horizon], features) + self.bias_by_horizon[horizon]
            prediction = _sigmoid(score)
            error = label - prediction
            self.weights_by_horizon[horizon] = [
                weight + learning_rate * error * feature
                for weight, feature in zip(self.weights_by_horizon[horizon], features)
            ]
            self.bias_by_horizon[horizon] += learning_rate * error
        self.samples += 1
        self.updated_at = datetime.now(timezone.utc).isoformat()

    def observe_world_model_transition(self, current_ctx: dict[str, Any], next_ctx: dict[str, Any]) -> None:
        self.world_model.observe_transition(current_ctx, next_ctx)

    def load_state(self, payload: dict[str, Any]) -> None:
        weights = payload.get("weights_by_horizon")
        bias = payload.get("bias_by_horizon")
        if isinstance(weights, dict):
            for horizon in HORIZONS_MS:
                row = weights.get(str(horizon)) or weights.get(horizon)
                if isinstance(row, list) and len(row) == len(FEATURE_KEYS):
                    self.weights_by_horizon[horizon] = [float(value) for value in row]
        if isinstance(bias, dict):
            for horizon in HORIZONS_MS:
                value = bias.get(str(horizon)) or bias.get(horizon)
                if value is not None:
                    self.bias_by_horizon[horizon] = float(value)
        self.samples = int(payload.get("samples") or 0)
        self.updated_at = payload.get("updated_at") if isinstance(payload.get("updated_at"), str) else None
        if isinstance(payload.get("world_model"), dict):
            self.world_model.load_state(payload["world_model"])

    def dump_state(self) -> dict[str, Any]:
        return {
            "weights_by_horizon": {str(horizon): weights for horizon, weights in self.weights_by_horizon.items()},
            "bias_by_horizon": {str(horizon): bias for horizon, bias in self.bias_by_horizon.items()},
            "world_model": self.world_model.dump_state(),
            "samples": self.samples,
            "updated_at": self.updated_at,
        }

    def get_stats(self) -> dict[str, Any]:
        weights_norm = math.sqrt(sum(weight * weight for row in self.weights_by_horizon.values() for weight in row))
        return {
            "samples": self.samples,
            "weights_norm": weights_norm,
            "world_model": self.world_model.get_stats(),
            "updated_at": self.updated_at,
        }
