from __future__ import annotations

import importlib.util
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "proof_financial_truth.py"


def _load():
    spec = importlib.util.spec_from_file_location("proof_financial_truth", SCRIPT)
    m = importlib.util.module_from_spec(spec)
    assert spec is not None and spec.loader is not None
    sys.modules[spec.name] = m
    spec.loader.exec_module(m)
    return m


UTC = timezone.utc
OPEN = datetime(2026, 7, 9, 0, 4, 45, tzinfo=UTC)
CLOSE = datetime(2026, 7, 9, 0, 5, 56, tzinfo=UTC)
NOW = datetime(2026, 7, 9, 0, 30, 0, tzinfo=UTC)


def _legs(m):
    return [
        m.Leg("proofcyc-x-entry", "sell", 6.0, OPEN),
        m.Leg("proofcyc-x-exit", "buy", 6.0, CLOSE),
    ]


def _income(m):
    return [
        m.IncomeEvent("trading_fee", -0.00248615, OPEN + timedelta(seconds=31), "Position opening fee"),
        m.IncomeEvent("trading_fee", -0.00248656, CLOSE, "Position closing fee"),
        m.IncomeEvent("realized_pnl", -0.00103, CLOSE, "Buy to Close"),
    ]


class FundingBoundaryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.m = _load()

    def test_no_boundary_in_short_window(self) -> None:
        self.assertFalse(self.m._crosses_funding_boundary(OPEN, CLOSE, 8))

    def test_boundary_crossed_at_0800(self) -> None:
        a = datetime(2026, 7, 9, 7, 59, tzinfo=UTC)
        b = datetime(2026, 7, 9, 8, 1, tzinfo=UTC)
        self.assertTrue(self.m._crosses_funding_boundary(a, b, 8))

    def test_boundary_crossed_at_midnight(self) -> None:
        a = datetime(2026, 7, 8, 23, 59, tzinfo=UTC)
        b = datetime(2026, 7, 9, 0, 1, tzinfo=UTC)
        self.assertTrue(self.m._crosses_funding_boundary(a, b, 8))


class ReconcileTests(unittest.TestCase):
    def setUp(self) -> None:
        self.m = _load()

    def test_real_cycle_values_actual_attribution_heuristic(self) -> None:
        r = self.m.reconcile_cycle_financials(
            cycle_id="proofcyc-x", legs=_legs(self.m), income_events=_income(self.m),
            ledger_synced_through=CLOSE + timedelta(minutes=20), now=NOW,
        )
        # venue VALUES are real
        self.assertAlmostEqual(r["gross_result_usd"], -0.00103, places=6)
        self.assertAlmostEqual(r["trading_fees_usd"], -0.00497271, places=6)
        self.assertAlmostEqual(r["net_result_usd"], -0.00600271, places=6)
        self.assertEqual(r["financial_truth"]["funding_usd"], "NOT_APPLICABLE")
        # but attribution is heuristic -> NOT reconciled-actual, and PnL semantics unverified
        self.assertEqual(r["attribution"], "HEURISTIC_MATCH")
        self.assertEqual(r["financial_truth"]["gross_result_usd"], "RECONCILED_HEURISTIC")
        self.assertEqual(r["net_result_certainty"], "RECONCILED_HEURISTIC")
        self.assertEqual(r["realized_pnl_semantics"], "UNVERIFIED")
        self.assertFalse(r["reconciled_actual"])
        self.assertTrue(r["financial_truth_not_actual"])
        self.assertFalse(r["alpha_sample_eligible"])
        self.assertEqual(r["outcome_purpose"], "OPERATIONAL_PROOF")

    def test_ledger_not_fresh_forces_missing(self) -> None:
        r = self.m.reconcile_cycle_financials(
            cycle_id="proofcyc-x", legs=_legs(self.m), income_events=_income(self.m),
            ledger_synced_through=CLOSE - timedelta(seconds=10), now=NOW,  # not past close+margin
        )
        self.assertEqual(r["financial_truth"]["trading_fees_usd"], "MISSING")
        self.assertEqual(r["financial_truth"]["gross_result_usd"], "MISSING")
        self.assertTrue(r["financial_truth_not_actual"])

    def test_funding_boundary_without_event_is_missing_not_na(self) -> None:
        legs = [
            self.m.Leg("c-entry", "sell", 6.0, datetime(2026, 7, 9, 7, 59, tzinfo=UTC)),
            self.m.Leg("c-exit", "buy", 6.0, datetime(2026, 7, 9, 8, 1, tzinfo=UTC)),
        ]
        r = self.m.reconcile_cycle_financials(
            cycle_id="c", legs=legs, income_events=[], ledger_synced_through=datetime(2026, 7, 9, 8, 30, tzinfo=UTC), now=NOW,
        )
        self.assertEqual(r["financial_truth"]["funding_usd"], "MISSING")

    def test_funding_event_present_is_counted(self) -> None:
        income = _income(self.m) + [self.m.IncomeEvent("funding_fee", -0.0004, CLOSE, "funding")]
        r = self.m.reconcile_cycle_financials(
            cycle_id="proofcyc-x", legs=_legs(self.m), income_events=income,
            ledger_synced_through=CLOSE + timedelta(minutes=20), now=NOW,
        )
        self.assertAlmostEqual(r["funding_usd"], -0.0004, places=6)
        self.assertEqual(r["financial_truth"]["funding_usd"], "RECONCILED_HEURISTIC")

    def test_no_fee_events_with_fallback_is_estimated_never_zero(self) -> None:
        r = self.m.reconcile_cycle_financials(
            cycle_id="c", legs=_legs(self.m), income_events=[],
            ledger_synced_through=CLOSE + timedelta(minutes=20), now=NOW,
            fallback_taker_bps_per_leg=5.0,
        )
        self.assertEqual(r["financial_truth"]["trading_fees_usd"], "ESTIMATED")
        self.assertLess(r["trading_fees_usd"], 0.0)
        # gross has no event and no fallback -> MISSING, never a silent zero-actual
        self.assertEqual(r["financial_truth"]["gross_result_usd"], "MISSING")
        self.assertTrue(r["financial_truth_not_actual"])

    def test_deterministic_bridge_marks_attribution_actual_but_semantics_still_gate(self) -> None:
        income = [self.m.IncomeEvent("realized_pnl", -0.001, CLOSE, "Buy to Close", trade_id="T9940546")]
        r = self.m.reconcile_cycle_financials(
            cycle_id="proofcyc-x", legs=_legs(self.m), income_events=income,
            ledger_synced_through=CLOSE + timedelta(minutes=20), now=NOW,
            order_trade_ids={"proofcyc-x-exit": {"T9940546"}},
        )
        self.assertEqual(r["attribution"], "DETERMINISTIC")
        self.assertEqual(r["financial_truth"]["gross_result_usd"], "RECONCILED_ACTUAL")
        # even deterministic attribution is NOT economically admissible until the
        # REALIZED_PNL-vs-fees semantics are proven (balance reconciliation)
        self.assertEqual(r["realized_pnl_semantics"], "UNVERIFIED")
        self.assertFalse(r["reconciled_actual"])


class DeterministicReconcileTests(unittest.TestCase):
    def setUp(self) -> None:
        self.m = _load()

    def _legs(self):
        return [
            self.m.LegVenueCost("proofcyc-x-entry", "OID1", "txt-proofcyc-x-entry", -0.002486, 0.0, OPEN),
            self.m.LegVenueCost("proofcyc-x-exit", "OID2", "txt-proofcyc-x-exit", -0.002487, -0.0010, CLOSE),
        ]

    def test_deterministic_aligned_cross_check_is_reconciled_actual(self) -> None:
        r = self.m.reconcile_deterministic(
            cycle_id="proofcyc-x", leg_costs=self._legs(), open_at=OPEN, close_at=CLOSE,
            ledger_synced_through=CLOSE + timedelta(minutes=20), now=NOW,
            income_cross_check_net_usd=-0.00600271,
        )
        self.assertEqual(r["attribution"], "DETERMINISTIC")
        self.assertTrue(r["order_level_actual"])
        self.assertEqual(r["independent_cross_check"], "ALIGNED")
        self.assertTrue(r["independently_cross_verified"])
        self.assertTrue(r["reconciled_actual"])
        self.assertEqual(r["net_result_certainty"], "RECONCILED_ACTUAL")
        self.assertAlmostEqual(r["net_result_usd"], -0.005973, places=6)
        self.assertEqual(r["financial_truth"]["funding_usd"], "NOT_APPLICABLE")

    def test_ambiguous_cross_check_keeps_order_level_actual(self) -> None:
        r = self.m.reconcile_deterministic(
            cycle_id="proofcyc-x", leg_costs=self._legs(), open_at=OPEN, close_at=CLOSE,
            ledger_synced_through=NOW, now=NOW,
            income_cross_check_net_usd=-0.05,  # contaminated / way off
        )
        # order-level truth STANDS; only the independent cross-check is ambiguous
        self.assertEqual(r["independent_cross_check"], "AMBIGUOUS")
        self.assertTrue(r["order_level_actual"])
        self.assertFalse(r["independently_cross_verified"])
        self.assertFalse(r["reconciled_actual"])

    def test_no_cross_check_is_order_level_actual_not_verified(self) -> None:
        r = self.m.reconcile_deterministic(
            cycle_id="proofcyc-x", leg_costs=self._legs(), open_at=OPEN, close_at=CLOSE,
            ledger_synced_through=NOW, now=NOW,
        )
        self.assertEqual(r["independent_cross_check"], "NONE")
        self.assertTrue(r["order_level_actual"])
        self.assertFalse(r["reconciled_actual"])


if __name__ == "__main__":
    unittest.main()
