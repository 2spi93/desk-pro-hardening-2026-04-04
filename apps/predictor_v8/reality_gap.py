from __future__ import annotations

from datetime import datetime, timezone
import math
from typing import Any


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _to_float(value: Any, default: float = 0.0) -> float:
    try:
        numeric = float(value)
    except Exception:
        return default
    return numeric if math.isfinite(numeric) else default


def _clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def _normalize_side(value: Any) -> str:
    candidate = str(value or "hold").strip().lower()
    return candidate if candidate in {"buy", "sell", "hold", "close"} else "hold"


def _normalize_regime(value: Any) -> str:
    candidate = str(value or "UNKNOWN").strip().upper()
    return candidate or "UNKNOWN"


def _normalize_failure_source(value: Any) -> str | None:
    candidate = str(value or "").strip().lower()
    return candidate if candidate in {"market", "execution", "infra", "policy"} else None


def _profile_key(venue: str, symbol: str, regime: str) -> str:
    return f"{venue.lower()}::{symbol.upper()}::{regime.upper()}"


def _snapshot(payload: dict[str, Any], key: str) -> dict[str, Any]:
    row = payload.get(key) if isinstance(payload.get(key), dict) else {}
    return {
        "slippage_bps": _to_float(row.get("slippage_bps"), math.nan),
        "fill_probability": _to_float(row.get("fill_probability"), math.nan),
        "fill_ratio": _to_float(row.get("fill_ratio"), math.nan),
        "latency_ms": _to_float(row.get("latency_ms"), math.nan),
        "impact_bps": _to_float(row.get("impact_bps"), math.nan),
        "queue_ahead_qty": _to_float(row.get("queue_ahead_qty"), math.nan),
        "metadata": row.get("metadata") if isinstance(row.get("metadata"), dict) else {},
    }


def _gap(predicted: dict[str, Any], realized: dict[str, Any], key: str, *, favorable_higher: bool = False) -> float:
    left = _to_float(predicted.get(key), math.nan)
    right = _to_float(realized.get(key), math.nan)
    if not math.isfinite(left) or not math.isfinite(right):
        return 0.0
    return (left - right) if favorable_higher else (right - left)


def _latency_overrun_ms(delta_ms: float) -> float:
    return max(0.0, delta_ms)


def _latency_underrun_ms(delta_ms: float) -> float:
    return max(0.0, -delta_ms)


def _build_adjustment_factors(profile: dict[str, Any]) -> dict[str, float]:
    avg_gap_slippage_bps = _to_float(profile.get("avg_gap_slippage_bps"), 0.0)
    avg_gap_fill_probability = _to_float(profile.get("avg_gap_fill_probability"), 0.0)
    avg_gap_latency_delta_ms = _to_float(profile.get("avg_gap_latency_delta_ms"), _to_float(profile.get("avg_gap_latency_ms"), 0.0))
    avg_gap_latency_overrun_ms = _to_float(profile.get("avg_gap_latency_overrun_ms"), _latency_overrun_ms(avg_gap_latency_delta_ms))
    avg_gap_impact_bps = _to_float(profile.get("avg_gap_impact_bps"), 0.0)
    avg_gap_queue_ahead_qty = _to_float(profile.get("avg_gap_queue_ahead_qty"), 0.0)
    return {
        "latency_jitter_multiplier": round(_clamp(1.0 + avg_gap_latency_overrun_ms / 80.0, 0.7, 2.4), 6),
        "impact_multiplier": round(_clamp(1.0 + (avg_gap_impact_bps + max(0.0, avg_gap_slippage_bps)) / 18.0, 0.7, 2.8), 6),
        "partial_fill_risk_delta": round(_clamp(max(0.0, -avg_gap_fill_probability) * 0.6 + max(0.0, avg_gap_queue_ahead_qty) / 25.0, 0.0, 0.75), 6),
        "hidden_liquidity_ratio_delta": round(_clamp(max(0.0, -avg_gap_fill_probability) * 0.22, 0.0, 0.35), 6),
        "queue_risk_delta": round(_clamp(max(0.0, avg_gap_queue_ahead_qty) / 12.0, 0.0, 1.0), 6),
    }


def _recommend_calibration_action(sample: dict[str, Any]) -> str:
    gap_latency_delta_ms = _to_float(sample.get("gap_latency_delta_ms"), _to_float(sample.get("gap_latency_ms"), 0.0))
    candidates = {
        "increase_latency_jitter": _latency_overrun_ms(gap_latency_delta_ms) / 40.0,
        "increase_impact_model": max(0.0, _to_float(sample.get("gap_impact_bps"), 0.0) / 6.0),
        "increase_partial_fill_risk": max(0.0, -_to_float(sample.get("gap_fill_probability"), 0.0) * 4.0),
        "increase_queue_penalty": max(0.0, _to_float(sample.get("gap_queue_ahead_qty"), 0.0) / 5.0),
        "reduce_slippage_penalty": max(0.0, -_to_float(sample.get("gap_slippage_bps"), 0.0) / 6.0),
    }
    best = max(candidates.items(), key=lambda item: item[1])
    return best[0] if best[1] > 0 else "hold_profile"


def _build_learning_payload(sample: dict[str, Any]) -> dict[str, Any]:
    predicted = sample["predicted"]
    realized = sample["realized"]
    gap_slippage_bps = _to_float(sample.get("gap_slippage_bps"), 0.0)
    gap_fill_probability = _to_float(sample.get("gap_fill_probability"), 0.0)
    gap_latency_delta_ms = _to_float(sample.get("gap_latency_delta_ms"), _to_float(sample.get("gap_latency_ms"), 0.0))
    gap_latency_overrun_ms = _to_float(sample.get("gap_latency_overrun_ms"), _latency_overrun_ms(gap_latency_delta_ms))
    gap_impact_bps = _to_float(sample.get("gap_impact_bps"), 0.0)
    gap_queue_ahead_qty = _to_float(sample.get("gap_queue_ahead_qty"), 0.0)
    reward = _clamp(
        (-gap_slippage_bps / 4.0)
        + (gap_fill_probability * 6.0)
        - (gap_latency_overrun_ms / 90.0)
        - (gap_impact_bps / 4.0)
        - (gap_queue_ahead_qty / 10.0),
        -12.0,
        12.0,
    )
    common = {
        "regime": sample["regime"],
        "latency_ms": realized.get("latency_ms") if math.isfinite(_to_float(realized.get("latency_ms"), math.nan)) else predicted.get("latency_ms"),
        "fill_probability": realized.get("fill_ratio") if math.isfinite(_to_float(realized.get("fill_ratio"), math.nan)) else realized.get("fill_probability"),
        "slippage_bps": realized.get("slippage_bps") if math.isfinite(_to_float(realized.get("slippage_bps"), math.nan)) else predicted.get("slippage_bps"),
        "available_depth_usd": _to_float(sample["metadata"].get("available_depth_usd"), 0.0),
        "spread_bps": _to_float(sample["metadata"].get("quote_spread_bps"), 0.0),
        "edge": -abs(gap_slippage_bps) - abs(gap_impact_bps),
        "render_pressure": 0.0,
        "latency_delta_ms": gap_latency_delta_ms,
        "latency_overrun_ms": gap_latency_overrun_ms,
        "latency_underrun_ms": _to_float(sample.get("gap_latency_underrun_ms"), _latency_underrun_ms(gap_latency_delta_ms)),
        "backlog_pressure": gap_latency_overrun_ms / 100.0,
        "network_regime": sample["metadata"].get("network_regime") or "stable",
        "infra_health": _clamp(_to_float(sample["metadata"].get("infra_health"), 1.0), 0.05, 1.0),
        "failure_source": sample.get("failure_source"),
        "failure_reasons": sample.get("failure_reasons") or [],
        "failure_blocking": bool(sample.get("failure_source")) and reward < -2.0,
        "symbol": sample["symbol"],
        "venue": sample["venue"],
    }
    return {
        "experience": {
            "experience_id": sample["sample_id"],
            "action": _normalize_side(sample.get("side")),
            "reward": round(reward, 6),
            "raw_reward": round(reward, 6),
            "reward_scale": 1.0,
            "sample_weight": 1.0,
            "synthetic": False,
            "dream_source": "reality_gap",
            "failure_source": sample.get("failure_source"),
            "failure_reasons": sample.get("failure_reasons") or [],
            "failure_blocking": bool(sample.get("failure_source")) and reward < -2.0,
            "state": {
                **common,
                "latency_ms": predicted.get("latency_ms"),
                "fill_probability": predicted.get("fill_probability"),
                "slippage_bps": predicted.get("slippage_bps"),
                "price": _to_float(sample["metadata"].get("price"), 0.0),
                "impact_bps": predicted.get("impact_bps"),
                "queue_ahead_qty": predicted.get("queue_ahead_qty"),
            },
            "next_state": {
                **common,
                "latency_ms": realized.get("latency_ms"),
                "fill_probability": realized.get("fill_ratio") if math.isfinite(_to_float(realized.get("fill_ratio"), math.nan)) else realized.get("fill_probability"),
                "slippage_bps": realized.get("slippage_bps"),
                "price": _to_float(sample["metadata"].get("price"), 0.0),
                "impact_bps": realized.get("impact_bps"),
                "queue_ahead_qty": realized.get("queue_ahead_qty"),
            },
        }
    }


class RealityGapEngine:
    def __init__(self) -> None:
        self.profiles: dict[str, dict[str, Any]] = {}
        self.last_ingested_at: str | None = None

    def dump_state(self) -> dict[str, Any]:
        return {
            "profiles": self.profiles,
            "last_ingested_at": self.last_ingested_at,
        }

    def load_state(self, payload: dict[str, Any]) -> None:
        self.profiles = payload.get("profiles") if isinstance(payload.get("profiles"), dict) else {}
        self.last_ingested_at = str(payload.get("last_ingested_at") or "") or None

    def profile_rows(self) -> list[dict[str, Any]]:
        return sorted(self.profiles.values(), key=lambda row: (str(row.get("venue") or ""), str(row.get("symbol") or ""), str(row.get("regime") or "")))

    def ingest_payloads(self, items: list[dict[str, Any]], *, apply_calibration: bool = True) -> dict[str, Any]:
        accepted = 0
        normalized_samples: list[dict[str, Any]] = []
        learning_payloads: list[dict[str, Any]] = []
        updated_profiles: list[dict[str, Any]] = []
        for item in items:
            sample = self._normalize_sample(item)
            if sample is None:
                continue
            accepted += 1
            normalized_samples.append(sample)
            learning_payloads.append(_build_learning_payload(sample))
            if apply_calibration:
                updated_profiles.append(self._update_profile(sample))
        if normalized_samples:
            self.last_ingested_at = _utc_now_iso()
        return {
            "accepted": accepted,
            "samples": normalized_samples,
            "profiles": updated_profiles,
            "learning_payloads": learning_payloads,
            "stats": {
                "profile_count": len(self.profiles),
                "last_ingested_at": self.last_ingested_at,
            },
        }

    def _normalize_sample(self, payload: dict[str, Any]) -> dict[str, Any] | None:
        candidate = payload.get("sample") if isinstance(payload.get("sample"), dict) else payload
        if not isinstance(candidate, dict):
            return None
        decision_id = str(candidate.get("decision_id") or "").strip()
        symbol = str(candidate.get("symbol") or "").strip().upper()
        venue = str(candidate.get("venue") or "").strip().lower()
        if not decision_id or not symbol or not venue:
            return None
        predicted = _snapshot(candidate, "predicted")
        realized = _snapshot(candidate, "realized")
        sample = {
            "sample_id": str(candidate.get("sample_id") or f"rg-{decision_id}-{venue}-{symbol}-{int(datetime.now(timezone.utc).timestamp() * 1000)}"),
            "decision_id": decision_id,
            "symbol": symbol,
            "venue": venue,
            "regime": _normalize_regime(candidate.get("regime")),
            "side": _normalize_side(candidate.get("side")),
            "predicted": predicted,
            "realized": realized,
            "failure_source": _normalize_failure_source(candidate.get("failure_source")),
            "failure_reasons": [str(reason) for reason in candidate.get("failure_reasons", []) if isinstance(reason, str)],
            "metadata": candidate.get("metadata") if isinstance(candidate.get("metadata"), dict) else {},
            "created_at": str(candidate.get("created_at") or _utc_now_iso()),
        }
        sample["gap_slippage_bps"] = round(_gap(predicted, realized, "slippage_bps"), 6)
        sample["gap_fill_probability"] = round(_gap(predicted, realized, "fill_ratio", favorable_higher=True) if math.isfinite(_to_float(realized.get("fill_ratio"), math.nan)) else _gap(predicted, realized, "fill_probability", favorable_higher=True), 6)
        latency_delta_ms = round(_gap(predicted, realized, "latency_ms"), 6)
        sample["gap_latency_ms"] = latency_delta_ms
        sample["gap_latency_delta_ms"] = latency_delta_ms
        sample["gap_latency_overrun_ms"] = round(_latency_overrun_ms(latency_delta_ms), 6)
        sample["gap_latency_underrun_ms"] = round(_latency_underrun_ms(latency_delta_ms), 6)
        sample["gap_impact_bps"] = round(_gap(predicted, realized, "impact_bps"), 6)
        sample["gap_queue_ahead_qty"] = round(_gap(predicted, realized, "queue_ahead_qty"), 6)
        sample["calibration_action"] = str(candidate.get("calibration_action") or _recommend_calibration_action(sample))
        return sample

    def _update_profile(self, sample: dict[str, Any]) -> dict[str, Any]:
        key = _profile_key(sample["venue"], sample["symbol"], sample["regime"])
        profile = self.profiles.get(key)
        if not isinstance(profile, dict):
            profile = {
                "profile_key": key,
                "venue": sample["venue"],
                "symbol": sample["symbol"],
                "regime": sample["regime"],
                "sample_count": 0,
                "avg_gap_slippage_bps": 0.0,
                "avg_gap_fill_probability": 0.0,
                "avg_gap_latency_ms": 0.0,
                "avg_gap_latency_delta_ms": 0.0,
                "avg_gap_latency_overrun_ms": 0.0,
                "avg_gap_impact_bps": 0.0,
                "avg_gap_queue_ahead_qty": 0.0,
                "adjustment_factors": {},
                "updated_at": _utc_now_iso(),
            }
        count = max(0, int(profile.get("sample_count") or 0))
        next_count = count + 1
        for metric in (
            "gap_slippage_bps",
            "gap_fill_probability",
            "gap_latency_ms",
            "gap_impact_bps",
            "gap_queue_ahead_qty",
        ):
            avg_key = f"avg_{metric}"
            current_avg = _to_float(profile.get(avg_key), 0.0)
            profile[avg_key] = round(((current_avg * count) + _to_float(sample.get(metric), 0.0)) / next_count, 6)
        latency_overrun_avg = _to_float(profile.get("avg_gap_latency_overrun_ms"), 0.0)
        profile["avg_gap_latency_overrun_ms"] = round(((latency_overrun_avg * count) + _to_float(sample.get("gap_latency_overrun_ms"), 0.0)) / next_count, 6)
        profile["avg_gap_latency_delta_ms"] = _to_float(profile.get("avg_gap_latency_ms"), 0.0)
        profile["sample_count"] = next_count
        profile["adjustment_factors"] = _build_adjustment_factors(profile)
        profile["updated_at"] = _utc_now_iso()
        self.profiles[key] = profile
        return profile