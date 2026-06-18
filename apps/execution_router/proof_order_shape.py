"""Deterministic-fill order shaping for the autonomous proof-renewal rail (D1).

Implements SPEC_D1_DETERMINISTIC_FILL.md. A proof-renewal routed order must
produce a real canonical fill — it may NEVER take the passive-LIMIT branch of
execution-AI v6 (which can rest unfilled). For the proof cycle we force a MARKET
taker (protection is NOT required for autonomous proof). This module is pure and
unit-testable without booting the router or touching a DB/market.
"""
from __future__ import annotations

from typing import Any, Optional

DEFAULT_NOTIONAL_CAP = 7.5


def _is_truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def resolve_proof_renewal_order_shape(payload: dict, *, notional_cap: float = DEFAULT_NOTIONAL_CAP) -> Optional[dict]:
    """Return the forced order shape for a proof-renewal routed order, or None.

    None  -> not a proof-renewal order; normal routing is untouched.
    dict  -> {"order_type": "MARKET", "proof_cycle_id": ..., "decision_id": ...}
    raises ValueError on any contract violation (caller maps to HTTP 400).
    """
    if not _is_truthy(payload.get("proof_renewal")):
        return None

    # rail separation: a proof-renewal order MUST come through execution_router,
    # never the operator direct-broker rail.
    if _is_truthy(payload.get("operator_direct_broker")) or _is_truthy(payload.get("direct_broker")):
        raise ValueError("proof_renewal must route via execution_router, not the direct-broker operator rail")

    decision_id = str(payload.get("decision_id") or "").strip()
    proof_cycle_id = str(payload.get("proof_cycle_id") or "").strip()
    if not decision_id:
        raise ValueError("proof_renewal requires decision_id")
    if not proof_cycle_id:
        raise ValueError("proof_renewal requires proof_cycle_id")

    # forbid a passive LIMIT shape for the proof cycle (it can rest unfilled).
    hint = str(payload.get("order_type") or payload.get("execution_hint") or "").strip().upper()
    if hint == "LIMIT" and not _is_truthy(payload.get("marketable")):
        raise ValueError("proof_renewal forbids passive LIMIT; MARKET taker only")

    notional = 0.0
    for key in ("estimated_notional_usd", "notional_usd", "target_notional_usd"):
        try:
            notional = float(payload.get(key) or 0.0)
        except (TypeError, ValueError):
            notional = 0.0
        if notional > 0:
            break
    if notional <= 0:
        raise ValueError("proof_renewal requires a positive notional")
    if notional > notional_cap:
        raise ValueError(f"proof_renewal notional {notional} exceeds cap {notional_cap}")

    return {"order_type": "MARKET", "proof_cycle_id": proof_cycle_id, "decision_id": decision_id}
