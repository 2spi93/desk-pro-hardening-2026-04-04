#!/usr/bin/env python3
"""One-to-one income<->order-leg matcher — FINANCIAL-TRUTH-ENGINE-001 debt 5 (cold).

Replaces the net-window cross-check (which could be contaminated by an adjacent
cycle) with a per-quantity one-to-one match on objective criteria:
  symbol + income_type + amount(=order value within documented tolerance)
  + venue timestamp near order.updated_at + candidate uniqueness.

Per-quantity result:
  unique candidate matching amount        -> ALIGNED
  multiple amount-matches                 -> AMBIGUOUS
  no candidate in time/type window        -> MISSING
  time/type candidate, amount incompatible-> DIVERGENT

An adjacent cycle is excluded by the TIME criterion (its events sit outside the
order.updated_at window), never by a hard-coded id.
"""
from __future__ import annotations

from decimal import Decimal
from typing import Any

# Documented tolerance: BingX order-level `profit` is rounded to 4 decimals and
# `commission` to 6; 1e-4 covers the coarser (profit) rounding vs the 8-decimal
# income ledger, without admitting a different micro-order's amount.
DEFAULT_AMOUNT_TOL = Decimal("0.0001")
DEFAULT_TIME_TOL_SEC = 120

_SEVERITY = {"ALIGNED": 0, "AMBIGUOUS": 1, "MISSING": 2, "DIVERGENT": 3}


def _dec(v: Any) -> Decimal:
    try:
        return Decimal(str(v))
    except (ValueError, ArithmeticError):
        return Decimal("0")


def match_quantity(
    *,
    order_value: Any,
    order_update_ms: int,
    symbol: str,
    income_type: str,
    income_events: list[dict[str, Any]],
    amount_tol: Decimal = DEFAULT_AMOUNT_TOL,
    time_tol_sec: int = DEFAULT_TIME_TOL_SEC,
) -> dict[str, Any]:
    """Match one order quantity (commission or profit) to a single income event."""
    typed = [
        e for e in income_events
        if str(e.get("income_type")) == income_type
        and str(e.get("symbol")) == symbol
        and abs(int(e.get("time_ms") or 0) - order_update_ms) <= time_tol_sec * 1000
    ]
    if not typed:
        return {"status": "MISSING", "candidates": 0}
    target = _dec(order_value)
    amount_matches = [e for e in typed if abs(_dec(e.get("amount")) - target) <= amount_tol]
    if len(amount_matches) == 1:
        return {"status": "ALIGNED", "matched_event_id": amount_matches[0].get("external_event_id"), "time_type_candidates": len(typed)}
    if len(amount_matches) > 1:
        return {"status": "AMBIGUOUS", "amount_matches": len(amount_matches)}
    return {"status": "DIVERGENT", "time_type_candidates": len(typed)}


def cross_check_cycle(
    *,
    legs: list[dict[str, Any]],
    income_events: list[dict[str, Any]],
    symbol: str,
    amount_tol: Decimal = DEFAULT_AMOUNT_TOL,
    time_tol_sec: int = DEFAULT_TIME_TOL_SEC,
) -> dict[str, Any]:
    """Cross-check at CYCLE level (per-leg fails when close legs share amounts).
    A tight window around the cycle's order updates EXCLUDES adjacent cycles by
    time; completeness is checked by event structure + Decimal sum.

    legs: [{order_update_ms, commission_usd, profit_usd}].
      MISSING   fewer events than the cycle structure expects (or none)
      AMBIGUOUS more events in the window than expected (possible contamination)
      DIVERGENT structure matches but the summed amounts do not
      ALIGNED   exact structure and sums, no extra events
    """
    ums = [int(l.get("order_update_ms") or 0) for l in legs if l.get("order_update_ms")]
    if not ums:
        return {"status": "MISSING", "aligned": False, "reason": "no_order_timestamps"}
    lo, hi = min(ums) - time_tol_sec * 1000, max(ums) + time_tol_sec * 1000
    win = [e for e in income_events
           if str(e.get("symbol")) == symbol
           and lo <= int(e.get("time_ms") or 0) <= hi
           and str(e.get("income_type")) in ("trading_fee", "realized_pnl")]
    fee_events = [e for e in win if str(e.get("income_type")) == "trading_fee"]
    pnl_events = [e for e in win if str(e.get("income_type")) == "realized_pnl"]
    expected_fees = len(legs)
    expected_pnl = sum(1 for l in legs if _dec(l.get("profit_usd")) != Decimal("0"))
    order_fee_sum = sum((_dec(l.get("commission_usd")) for l in legs), Decimal("0"))
    order_pnl_sum = sum((_dec(l.get("profit_usd")) for l in legs), Decimal("0"))
    inc_fee_sum = sum((_dec(e.get("amount")) for e in fee_events), Decimal("0"))
    inc_pnl_sum = sum((_dec(e.get("amount")) for e in pnl_events), Decimal("0"))

    detail = {
        "window_ms": [lo, hi],
        "expected_fees": expected_fees, "found_fees": len(fee_events),
        "expected_pnl": expected_pnl, "found_pnl": len(pnl_events),
        "order_fee_sum": str(order_fee_sum), "income_fee_sum": str(inc_fee_sum),
        "order_pnl_sum": str(order_pnl_sum), "income_pnl_sum": str(inc_pnl_sum),
    }
    # Fee structure is exact (one commission per leg). PnL is SUM-driven: the
    # order-level `profit` field rounds to 4 decimals, so a sub-precision realized
    # pnl (e.g. -0.00002) legitimately shows as order profit 0.0 while the ledger
    # records the tiny value — that is NOT contamination as long as the pnl SUM
    # still matches within tolerance. An adjacent cycle's (material) pnl would
    # instead push the sum out of tolerance -> DIVERGENT.
    fee_ok = abs(inc_fee_sum - order_fee_sum) <= amount_tol * max(1, expected_fees)
    pnl_ok = abs(inc_pnl_sum - order_pnl_sum) <= amount_tol * max(1, expected_fees)
    if len(fee_events) < expected_fees:
        status = "MISSING"
    elif len(fee_events) > expected_fees:
        status = "AMBIGUOUS"   # extra commission events in window -> possible overlap
    elif fee_ok and pnl_ok:
        status = "ALIGNED"
    else:
        status = "DIVERGENT"
    return {"status": status, "aligned": status == "ALIGNED", **detail}


if __name__ == "__main__":
    import json
    import sys
    print(json.dumps({"module": "income_leg_matcher", "usage": "import and call cross_check_cycle"}))
    sys.exit(0)
