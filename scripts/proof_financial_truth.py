#!/usr/bin/env python3
"""Financial-truth reconciliation + finalizer v2 for autonomous proof cycles.

FINANCIAL-TRUTH-ENGINE-001 (cold). Pure core: NO DB, NO network — the caller
reads the cycle legs + the BingX income ledger events + the ledger-sync coverage
and passes them in; this module reconciles them into a net result with a strict
per-field certainty status. Never substitutes a silent zero.

Reconciliation reality (from the read-only inventory):
  - the captured venue order_id (orders table) does NOT appear in BingX income
    events; income is keyed by tranId/tradeId with an unrelated prefix.
  - therefore income<->cycle is reconciled by (symbol + second-level timestamp +
    side/info consistency), which is deterministic ONLY when unambiguous.
  - a future deterministic bridge (BingX order-fills endpoint: order_id ->
    tradeId) upgrades matches to a stronger RECONCILED_ACTUAL; passed in via
    `order_trade_ids` when available.

Certainty hierarchy (strict, never ASSUMED_ZERO on a financial value):
  ACTUAL             directly from a venue ledger event, deterministic key
  RECONCILED_ACTUAL  venue ledger event matched to the cycle after the fact
  ESTIMATED          computed from notional x a known/assumed rate (documented)
  MISSING            no reliable data (e.g. ledger not synced past close)
  NOT_APPLICABLE     proven not to apply by contract (e.g. no funding boundary)
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

ACTUAL = "ACTUAL"
RECONCILED_ACTUAL = "RECONCILED_ACTUAL"
ESTIMATED = "ESTIMATED"
MISSING = "MISSING"
NOT_APPLICABLE = "NOT_APPLICABLE"

# Default reconciliation window: income settlement events land within a minute
# or two of the fill (observed ~31-71s). Kept tight to avoid cross-cycle bleed.
DEFAULT_MATCH_WINDOW_SEC = 180.0
# Ledger-freshness margin: require the income sync to have covered at least this
# long past the cycle close before trusting an "absence" as truth.
DEFAULT_LEDGER_MARGIN_SEC = 120.0
DEFAULT_FUNDING_INTERVAL_HOURS = 8  # BingX BTC-USDT perp: 00:00 / 08:00 / 16:00 UTC


def _parse_ts(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


@dataclass
class Leg:
    decision_id: str
    side: str                # "sell" (entry) / "buy" (exit) for a short cycle
    notional_usd: float
    filled_at: datetime
    venue_order_id: str | None = None


@dataclass
class IncomeEvent:
    event_type: str          # trading_fee | realized_pnl | funding_fee
    amount_usd: float        # signed (fees/pnl usually negative)
    occurred_at: datetime
    info: str = ""
    trade_id: str | None = None


def _crosses_funding_boundary(open_at: datetime, close_at: datetime, interval_hours: int) -> bool:
    """True if any funding settlement boundary (multiples of interval_hours, on
    the UTC day) lies within [open_at, close_at]."""
    if close_at < open_at:
        open_at, close_at = close_at, open_at
    day = open_at.replace(hour=0, minute=0, second=0, microsecond=0)
    while day <= close_at + timedelta(hours=interval_hours):
        for h in range(0, 24, interval_hours):
            boundary = day + timedelta(hours=h)
            if open_at <= boundary <= close_at:
                return True
        day += timedelta(days=1)
    return False


def _match_events(leg: Leg, events: list[IncomeEvent], window_sec: float, order_trade_ids: set[str] | None) -> list[IncomeEvent]:
    """Events attributable to a leg. Deterministic when the leg's order maps to
    the event trade_id; else a symbol-agnostic time-window match (caller already
    filters by symbol)."""
    matched: list[IncomeEvent] = []
    for ev in events:
        if order_trade_ids and ev.trade_id and ev.trade_id in order_trade_ids:
            matched.append(ev)
            continue
        if abs((ev.occurred_at - leg.filled_at).total_seconds()) <= window_sec:
            matched.append(ev)
    return matched


def reconcile_cycle_financials(
    *,
    cycle_id: str,
    legs: list[Leg],
    income_events: list[IncomeEvent],
    ledger_synced_through: datetime | None,
    now: datetime,
    order_trade_ids: dict[str, set[str]] | None = None,
    match_window_sec: float = DEFAULT_MATCH_WINDOW_SEC,
    ledger_margin_sec: float = DEFAULT_LEDGER_MARGIN_SEC,
    funding_interval_hours: int = DEFAULT_FUNDING_INTERVAL_HOURS,
    fallback_taker_bps_per_leg: float | None = None,
) -> dict[str, Any]:
    """Reconcile income ledger events into a cycle net result with certainty."""
    if not legs:
        return {"cycle_id": cycle_id, "error": "no_legs"}
    open_at = min(l.filled_at for l in legs)
    close_at = max(l.filled_at for l in legs)

    # Ledger freshness: has the income sync covered past the cycle close?
    ledger_fresh = (
        ledger_synced_through is not None
        and ledger_synced_through >= close_at + timedelta(seconds=ledger_margin_sec)
    )

    used_ids: set[int] = set()
    fee_events: list[IncomeEvent] = []
    pnl_events: list[IncomeEvent] = []
    funding_events: list[IncomeEvent] = []
    deterministic = False
    for leg in legs:
        leg_ids = (order_trade_ids or {}).get(leg.decision_id)
        if leg_ids:
            deterministic = True
        for ev in _match_events(leg, income_events, match_window_sec, leg_ids):
            key = id(ev)
            if key in used_ids:
                continue
            used_ids.add(key)
            if ev.event_type == "trading_fee":
                fee_events.append(ev)
            elif ev.event_type == "realized_pnl":
                pnl_events.append(ev)
            elif ev.event_type == "funding_fee":
                funding_events.append(ev)

    match_status = RECONCILED_ACTUAL
    if deterministic:
        match_status = RECONCILED_ACTUAL  # (deterministic bridge — strongest form)

    # --- fees ---
    if not ledger_fresh:
        fees_usd, fees_cert = 0.0, MISSING
    elif fee_events:
        fees_usd, fees_cert = sum(e.amount_usd for e in fee_events), match_status
    elif fallback_taker_bps_per_leg is not None:
        notional = sum(l.notional_usd for l in legs)
        fees_usd = -abs(fallback_taker_bps_per_leg) / 10000.0 * notional
        fees_cert = ESTIMATED
    else:
        fees_usd, fees_cert = 0.0, MISSING

    # --- gross (realized pnl) ---
    if not ledger_fresh:
        gross_usd, gross_cert = 0.0, MISSING
    elif pnl_events:
        gross_usd, gross_cert = sum(e.amount_usd for e in pnl_events), match_status
    else:
        gross_usd, gross_cert = 0.0, MISSING

    # --- funding ---
    if funding_events:
        funding_usd, funding_cert = sum(e.amount_usd for e in funding_events), match_status
    elif not ledger_fresh:
        funding_usd, funding_cert = 0.0, MISSING
    elif not _crosses_funding_boundary(open_at, close_at, funding_interval_hours):
        funding_usd, funding_cert = 0.0, NOT_APPLICABLE
    else:
        funding_usd, funding_cert = 0.0, MISSING

    # --- net + coverage ---
    net_usd = gross_usd + fees_usd + funding_usd
    field_cert = {
        "gross_result_usd": gross_cert,
        "trading_fees_usd": fees_cert,
        "funding_usd": funding_cert,
    }
    actual_like = {ACTUAL, RECONCILED_ACTUAL, NOT_APPLICABLE}
    missing_fields = [k for k, v in field_cert.items() if v not in actual_like]
    all_actual = not missing_fields
    net_cert = (
        (RECONCILED_ACTUAL if not deterministic else RECONCILED_ACTUAL)
        if all_actual
        else (MISSING if MISSING in field_cert.values() else ESTIMATED)
    )
    actual_coverage_pct = round(100.0 * sum(1 for v in field_cert.values() if v in actual_like) / len(field_cert), 1)

    return {
        "schema": "txt.proof-financial-truth.v2",
        "cycle_id": cycle_id,
        "open_at": open_at.isoformat(),
        "close_at": close_at.isoformat(),
        "ledger_synced_through": ledger_synced_through.isoformat() if ledger_synced_through else None,
        "ledger_fresh": ledger_fresh,
        "reconciliation": "deterministic_order_trade_id" if deterministic else "heuristic_symbol_time_info",
        "gross_result_usd": round(gross_usd, 8),
        "trading_fees_usd": round(fees_usd, 8),
        "funding_usd": round(funding_usd, 8),
        "net_result_usd": round(net_usd, 8),
        "financial_truth": {
            **field_cert,
            "net_result_usd": net_cert,
            "actual_coverage_pct": actual_coverage_pct,
            "missing_fields": missing_fields,
        },
        "matched_events": {
            "trading_fee": len(fee_events),
            "realized_pnl": len(pnl_events),
            "funding_fee": len(funding_events),
        },
        "financial_truth_not_actual": not all_actual,
    }
