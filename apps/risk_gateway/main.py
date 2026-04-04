from __future__ import annotations

import json
import os
from pathlib import Path

from fastapi import FastAPI
from pydantic import BaseModel, Field

from shared.db import ensure_schema, execute, fetch_one, json_dumps
from shared.models import RiskCheckRequest, RiskDecision

app = FastAPI(title="Risk Gateway", version="0.1.0")

POLICY_PATH = Path(os.getenv("RISK_POLICY_PATH", "/workspace/config/risk_policy.json"))
STATE = {
    "daily_notional_used_usd": 0.0,
    "exposure_by_instrument": {},
}


class Mt5OrderRiskRequest(BaseModel):
    account_id: str
    symbol: str
    side: str = Field(pattern="^(buy|sell)$")
    lots: float = Field(gt=0)
    estimated_notional_usd: float = Field(gt=0)
    max_spread_bps: int = Field(gt=0)
    system_mode: str = "suggest"


def load_policy() -> dict:
    return json.loads(POLICY_PATH.read_text())


def _normalize_instrument(symbol: object) -> str:
    return str(symbol or "").replace("-PERP", "").replace("/", "").replace("-", "").upper()


def _resolve_regime(payload: object) -> str:
    explainability = payload if isinstance(payload, dict) else {}
    return str(
        explainability.get("regime")
        or explainability.get("market_regime")
        or explainability.get("predictor_regime")
        or "UNKNOWN"
    ).strip().upper() or "UNKNOWN"


def _apply_conditional_instrument_rules(
    *,
    rules: object,
    instrument: str,
    confidence: float,
    target_notional_usd: float,
    regime: str,
) -> list[str]:
    if not isinstance(rules, dict):
        return []

    normalized_instrument = _normalize_instrument(instrument)
    matched_rule = None
    for raw_symbol, candidate_rule in rules.items():
        if _normalize_instrument(raw_symbol) == normalized_instrument and isinstance(candidate_rule, dict):
            matched_rule = candidate_rule
            break

    if not isinstance(matched_rule, dict):
        return []

    reasons: list[str] = []
    max_trade_notional_usd = float(matched_rule.get("max_trade_notional_usd") or 0.0)
    if max_trade_notional_usd > 0 and target_notional_usd > max_trade_notional_usd:
        reasons.append("conditional_trade_notional_exceeds_limit")

    min_confidence = float(matched_rule.get("min_confidence") or 0.0)
    if min_confidence > 0 and confidence < min_confidence:
        reasons.append("conditional_confidence_below_threshold")

    allowed_regimes = {
        str(item).strip().upper()
        for item in matched_rule.get("allowed_regimes", [])
        if str(item).strip()
    }
    if allowed_regimes and regime not in allowed_regimes:
        reasons.append("conditional_regime_not_allowed")

    return reasons


@app.on_event("startup")
async def startup() -> None:
    ensure_schema()
    policy = load_policy()
    execute(
        """
        INSERT INTO risk_policies (policy_version, policy, is_active)
        VALUES (%s, %s::jsonb, TRUE)
        ON CONFLICT (policy_version) DO UPDATE SET policy = EXCLUDED.policy, is_active = TRUE
        """,
        (policy["policy_version"], json_dumps(policy)),
    )


@app.get("/health")
async def health() -> dict:
    policy = load_policy()
    return {
        "status": "ok",
        "service": "risk-gateway",
        "policy_version": policy["policy_version"],
        "daily_notional_used_usd": STATE["daily_notional_used_usd"],
    }


@app.get("/v1/policies")
async def get_policy() -> dict:
    stored = fetch_one("SELECT policy FROM risk_policies WHERE is_active = TRUE ORDER BY created_at DESC LIMIT 1")
    return stored["policy"] if stored else load_policy()


@app.get("/v1/exposures")
async def exposures() -> dict:
    return STATE


@app.post("/v1/checks/pre-trade", response_model=RiskDecision)
async def pre_trade_check(request: RiskCheckRequest) -> RiskDecision:
    policy = load_policy()
    reasons: list[str] = []
    intent = request.intent
    normalized_instrument = _normalize_instrument(intent.instrument)
    normalized_blocked_instruments = {_normalize_instrument(item) for item in policy["blocked_instruments"]}
    resolved_regime = _resolve_regime(intent.explainability)

    if request.system_mode.value not in policy["allowed_system_modes"]:
        reasons.append("system_mode_not_allowed")
    if intent.target_notional_usd > policy["max_trade_notional_usd"]:
        reasons.append("trade_notional_exceeds_limit")
    if STATE["daily_notional_used_usd"] + intent.target_notional_usd > policy["daily_notional_limit_usd"]:
        reasons.append("daily_notional_limit_exceeded")
    if intent.leverage > policy["max_leverage"]:
        reasons.append("leverage_exceeds_limit")
    if intent.max_slippage_bps > policy["max_slippage_bps"]:
        reasons.append("slippage_limit_exceeded")
    if intent.confidence < policy["min_confidence"]:
        reasons.append("confidence_below_threshold")
    if intent.venue in policy["blocked_venues"]:
        reasons.append("venue_blocked")
    if normalized_instrument in normalized_blocked_instruments:
        reasons.append("instrument_blocked")
    reasons.extend(
        _apply_conditional_instrument_rules(
            rules=policy.get("conditional_instrument_rules"),
            instrument=intent.instrument,
            confidence=float(intent.confidence),
            target_notional_usd=float(intent.target_notional_usd),
            regime=resolved_regime,
        )
    )

    if reasons:
        return RiskDecision(
            decision="reject",
            reasons=reasons,
            policy_version=policy["policy_version"],
            risk_snapshot={
                "daily_notional_used_usd": STATE["daily_notional_used_usd"],
                "exposure_by_instrument": STATE["exposure_by_instrument"],
            },
        )

    STATE["daily_notional_used_usd"] += intent.target_notional_usd
    current = STATE["exposure_by_instrument"].get(intent.instrument, 0.0)
    signed_notional = intent.target_notional_usd if intent.side.value == "buy" else -intent.target_notional_usd
    STATE["exposure_by_instrument"][intent.instrument] = current + signed_notional

    return RiskDecision(
        decision="accept",
        reasons=["within_policy"],
        policy_version=policy["policy_version"],
        approved_notional_usd=intent.target_notional_usd,
        risk_snapshot={
            "daily_notional_used_usd": STATE["daily_notional_used_usd"],
            "exposure_by_instrument": STATE["exposure_by_instrument"],
            "paper_only": policy["paper_only"],
        },
    )


@app.post("/v1/checks/mt5-order")
async def mt5_order_check(request: Mt5OrderRiskRequest) -> dict:
    policy = load_policy()
    reasons: list[str] = []
    normalized_symbol = _normalize_instrument(request.symbol)
    normalized_blocked_instruments = {_normalize_instrument(item) for item in policy["blocked_instruments"]}

    if request.system_mode not in policy["allowed_system_modes"]:
        reasons.append("system_mode_not_allowed")
    if request.estimated_notional_usd > policy["max_trade_notional_usd"]:
        reasons.append("trade_notional_exceeds_limit")
    if STATE["daily_notional_used_usd"] + request.estimated_notional_usd > policy["daily_notional_limit_usd"]:
        reasons.append("daily_notional_limit_exceeded")
    if request.max_spread_bps > policy["max_slippage_bps"]:
        reasons.append("spread_too_wide")
    if normalized_symbol in normalized_blocked_instruments:
        reasons.append("instrument_blocked")
    reasons.extend(
        _apply_conditional_instrument_rules(
            rules=policy.get("conditional_instrument_rules"),
            instrument=request.symbol,
            confidence=1.0,
            target_notional_usd=float(request.estimated_notional_usd),
            regime="UNKNOWN",
        )
    )

    if reasons:
        return {
            "decision": "reject",
            "reasons": reasons,
            "policy_version": policy["policy_version"],
            "risk_snapshot": {
                "daily_notional_used_usd": STATE["daily_notional_used_usd"],
                "paper_only": policy["paper_only"],
            },
        }

    STATE["daily_notional_used_usd"] += request.estimated_notional_usd
    signed_notional = request.estimated_notional_usd if request.side == "buy" else -request.estimated_notional_usd
    current = STATE["exposure_by_instrument"].get(request.symbol, 0.0)
    STATE["exposure_by_instrument"][request.symbol] = current + signed_notional

    return {
        "decision": "accept",
        "reasons": ["within_policy"],
        "policy_version": policy["policy_version"],
        "approved_notional_usd": request.estimated_notional_usd,
        "risk_snapshot": {
            "daily_notional_used_usd": STATE["daily_notional_used_usd"],
            "exposure_by_instrument": STATE["exposure_by_instrument"],
            "paper_only": policy["paper_only"],
        },
    }
