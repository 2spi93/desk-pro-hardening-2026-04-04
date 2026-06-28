"""Guard: did an autonomous intent actually execute a live order? (PORTE 2.1)

Pure, unit-testable. The proof-renewal runner submits an intent via
/v1/intents/submit and must ABORT (no observe, no flatten loop, no finalize, no
retry) unless the response shows a real live execution. This catches every
non-executed terminal status seen in practice: rejected_by_risk,
rejected_preflight, accepted_waiting_opportunity_gate,
accepted_waiting_human_or_higher_mode, executed_in_paper_mode, and any
preflight-only response with no order id.
"""
from __future__ import annotations

from typing import Any, Optional

EXECUTED_LIVE_STATUS = "executed_in_live_mode"


def intent_not_executed_reason(response: Any) -> Optional[str]:
    """Return None iff the intent executed a real live order; else a reason string."""
    if not isinstance(response, dict):
        return "unparseable_intent_response"
    status = str(response.get("status") or "").strip()
    if status != EXECUTED_LIVE_STATUS:
        rd = response.get("risk_decision") if isinstance(response.get("risk_decision"), dict) else {}
        reasons = rd.get("reasons")
        base = f"intent_not_executed:status={status or 'unknown'}"
        return base + (f":risk={reasons}" if reasons else "")
    order = response.get("order") if isinstance(response.get("order"), dict) else {}
    order_id = str(order.get("order_id") or "").strip()
    if not order_id:
        return "executed_status_without_order_id"
    order_status = str(order.get("status") or "").strip().lower()
    if order_status != "filled":
        return f"executed_status_without_canonical_fill_status:{order_status or 'unknown'}"
    return None
