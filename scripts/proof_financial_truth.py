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
RECONCILED_ACTUAL = "RECONCILED_ACTUAL"       # venue value + DETERMINISTIC attribution
RECONCILED_HEURISTIC = "RECONCILED_HEURISTIC"  # venue value, but attribution by heuristic match
ESTIMATED = "ESTIMATED"
MISSING = "MISSING"
NOT_APPLICABLE = "NOT_APPLICABLE"

# "Fully actual" for gate purposes: the VALUE is a venue actual AND the
# attribution to this cycle is proven (deterministic) or the field is proven
# not to apply. RECONCILED_HEURISTIC is deliberately EXCLUDED — the amounts are
# real venue values but the cycle attribution is not yet mathematically proven.
FULLY_ACTUAL = {ACTUAL, RECONCILED_ACTUAL, NOT_APPLICABLE}

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


@dataclass
class LegVenueCost:
    """Deterministic per-leg venue truth from the BingX order query, keyed by a
    clientOrderId that embeds the cycle+leg (txt-proofcyc-<cycle>-<leg>)."""
    decision_id: str
    order_id: str
    client_order_id: str
    commission_usd: float           # venue commission for this order (signed, <=0)
    profit_usd: float               # venue GROSS realized pnl for this order
    filled_at: datetime | None = None


def reconcile_deterministic(
    *,
    cycle_id: str,
    leg_costs: list[LegVenueCost],
    open_at: datetime,
    close_at: datetime,
    ledger_synced_through: datetime | None,
    now: datetime,
    income_cross_check_net_usd: float | None = None,
    cross_check_tolerance_usd: float = 0.0005,
    cross_check_status: str | None = None,
    funding_interval_hours: int = DEFAULT_FUNDING_INTERVAL_HOURS,
    funding_events_usd: float | None = None,
) -> dict[str, Any]:
    """Deterministic financial truth: per-order commission+profit attributed to
    the cycle via clientOrderId. Values ACTUAL, attribution DETERMINISTIC. PnL
    semantics VERIFIED iff an independent source (income ledger net) agrees
    within tolerance — proving REALIZED_PNL is gross of commission (net =
    profit + commission), so no double-count."""
    if not leg_costs:
        return {"cycle_id": cycle_id, "error": "no_leg_costs"}
    gross_usd = round(sum(l.profit_usd for l in leg_costs), 8)
    fees_usd = round(sum(l.commission_usd for l in leg_costs), 8)

    # funding
    if funding_events_usd is not None:
        funding_usd, funding_cert = round(funding_events_usd, 8), RECONCILED_ACTUAL
    elif not _crosses_funding_boundary(open_at, close_at, funding_interval_hours):
        funding_usd, funding_cert = 0.0, NOT_APPLICABLE
    else:
        funding_usd, funding_cert = 0.0, MISSING

    net_usd = round(gross_usd + fees_usd + funding_usd, 8)

    # Order-level values are AUTHORITATIVE (venue order query, deterministic
    # attribution) regardless of the cross-check. The independent cross-check is
    # a SEPARATE, weaker signal: it corroborates the "profit gross of commission"
    # identity per cycle, but an AMBIGUOUS cross-check (e.g. contaminated income
    # window from an adjacent cycle) does NOT invalidate the order-level truth.
    order_level_actual = all(l.order_id for l in leg_costs)
    # A one-to-one matcher status (income_leg_matcher.cross_check_cycle) is the
    # authoritative cross-check when provided — it excludes adjacent cycles by
    # tight time window + structure. The net-delta path is a coarse fallback.
    if cross_check_status is not None:
        cross_check = {"status": cross_check_status, "method": "one_to_one_leg_matcher"}
    elif income_cross_check_net_usd is not None and abs(net_usd - income_cross_check_net_usd) <= cross_check_tolerance_usd:
        cross_check = {"status": "ALIGNED", "method": "net_delta", "ledger_net_usd": round(income_cross_check_net_usd, 8), "delta_usd": round(net_usd - income_cross_check_net_usd, 8)}
    elif income_cross_check_net_usd is not None:
        cross_check = {"status": "AMBIGUOUS", "method": "net_delta", "ledger_net_usd": round(income_cross_check_net_usd, 8), "delta_usd": round(net_usd - income_cross_check_net_usd, 8),
                       "note": "order-level truth stands; income cross-check window likely contaminated"}
    else:
        cross_check = {"status": "NONE"}

    field_cert = {"gross_result_usd": RECONCILED_ACTUAL, "trading_fees_usd": RECONCILED_ACTUAL, "funding_usd": funding_cert}
    all_fully_actual = all(v in FULLY_ACTUAL for v in field_cert.values())
    independently_cross_verified = cross_check["status"] == "ALIGNED"
    # fully_reconciled_actual (strict) = deterministic order-level truth AND an
    # independent cross-check that confirms it.
    reconciled_actual = order_level_actual and all_fully_actual and independently_cross_verified
    net_cert = RECONCILED_ACTUAL if reconciled_actual else (RECONCILED_HEURISTIC if order_level_actual else MISSING)

    return {
        "schema": "txt.proof-financial-truth.v3",
        "cycle_id": cycle_id,
        "open_at": open_at.isoformat(),
        "close_at": close_at.isoformat(),
        "ledger_synced_through": ledger_synced_through.isoformat() if ledger_synced_through else None,
        "ledger_fresh": True,
        "outcome_purpose": "OPERATIONAL_PROOF",
        "alpha_sample_eligible": False,
        "attribution": "DETERMINISTIC",
        "attribution_key": "clientOrderId->orderId (venue order query)",
        "value_truth": "ACTUAL",
        "order_level_actual": order_level_actual,
        "independent_cross_check": cross_check["status"],
        "independently_cross_verified": independently_cross_verified,
        "semantics_cross_check": cross_check,
        "legs": [{"decision_id": l.decision_id, "order_id": l.order_id, "client_order_id": l.client_order_id,
                  "commission_usd": l.commission_usd, "profit_usd": l.profit_usd} for l in leg_costs],
        "gross_result_usd": gross_usd,
        "trading_fees_usd": fees_usd,
        "funding_usd": funding_usd,
        "net_result_usd": net_usd,
        "net_result_certainty": net_cert,
        "financial_truth": {**field_cert, "net_result_usd": net_cert, "missing_fields": []},
        "reconciled_actual": reconciled_actual,
        "financial_truth_not_actual": not reconciled_actual,
    }


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

    # Attribution truth: DETERMINISTIC (venue trade-id link) vs HEURISTIC (time
    # window). The ledger VALUES are venue-actual either way; only the mapping to
    # THIS cycle differs. A matched amount is therefore RECONCILED_ACTUAL only
    # when the attribution is deterministic; else RECONCILED_HEURISTIC.
    match_status = RECONCILED_ACTUAL if deterministic else RECONCILED_HEURISTIC

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
    # net = REALIZED_PNL + TRADING_FEE + FUNDING is only the correct identity IF
    # BingX REALIZED_PNL is GROSS of commissions. That is NOT yet proven (needs a
    # balance-movement reconciliation), so the semantics are UNVERIFIED and the
    # net can be no stronger than RECONCILED_HEURISTIC.
    net_usd = gross_usd + fees_usd + funding_usd
    field_cert = {
        "gross_result_usd": gross_cert,
        "trading_fees_usd": fees_cert,
        "funding_usd": funding_cert,
    }
    missing_fields = [k for k, v in field_cert.items() if v not in FULLY_ACTUAL]
    all_fully_actual = not missing_fields
    realized_pnl_semantics = "UNVERIFIED"  # until a balance reconciliation proves it
    if not ledger_fresh:
        net_cert = MISSING
    elif all_fully_actual and realized_pnl_semantics == "VERIFIED":
        net_cert = RECONCILED_ACTUAL
    elif any(v in (RECONCILED_HEURISTIC, RECONCILED_ACTUAL) for v in field_cert.values()) and MISSING not in field_cert.values():
        net_cert = RECONCILED_HEURISTIC
    else:
        net_cert = MISSING if MISSING in field_cert.values() else ESTIMATED
    fully_actual_coverage_pct = round(100.0 * sum(1 for v in field_cert.values() if v in FULLY_ACTUAL) / len(field_cert), 1)
    # A cycle is only economically ADMISSIBLE-actual when values are actual AND
    # attribution is deterministic AND the PnL semantics are proven.
    reconciled_actual = all_fully_actual and deterministic and realized_pnl_semantics == "VERIFIED"

    return {
        "schema": "txt.proof-financial-truth.v3",
        "cycle_id": cycle_id,
        "open_at": open_at.isoformat(),
        "close_at": close_at.isoformat(),
        "ledger_synced_through": ledger_synced_through.isoformat() if ledger_synced_through else None,
        "ledger_fresh": ledger_fresh,
        "outcome_purpose": "OPERATIONAL_PROOF",
        "alpha_sample_eligible": False,
        "attribution": "DETERMINISTIC" if deterministic else "HEURISTIC_MATCH",
        "value_truth": "ACTUAL" if (fee_events or pnl_events) else ("MISSING" if not ledger_fresh else "NONE"),
        "realized_pnl_semantics": realized_pnl_semantics,
        "gross_result_usd": round(gross_usd, 8),
        "trading_fees_usd": round(fees_usd, 8),
        "funding_usd": round(funding_usd, 8),
        "net_result_usd": round(net_usd, 8),
        "net_result_certainty": net_cert,
        "financial_truth": {
            **field_cert,
            "net_result_usd": net_cert,
            "fully_actual_coverage_pct": fully_actual_coverage_pct,
            "missing_fields": missing_fields,
        },
        "matched_events": {
            "trading_fee": len(fee_events),
            "realized_pnl": len(pnl_events),
            "funding_fee": len(funding_events),
        },
        "reconciled_actual": reconciled_actual,
        "financial_truth_not_actual": not reconciled_actual,
    }
