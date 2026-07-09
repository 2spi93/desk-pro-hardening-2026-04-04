from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "economic_promotion_gate.py"


def _load():
    spec = importlib.util.spec_from_file_location("economic_promotion_gate", SCRIPT)
    m = importlib.util.module_from_spec(spec)
    assert spec is not None and spec.loader is not None
    sys.modules[spec.name] = m
    spec.loader.exec_module(m)
    return m


def _heuristic_cycle(net):
    return {
        "net_result_usd": net,
        "value_truth": "ACTUAL",
        "attribution": "HEURISTIC_MATCH",
        "net_result_certainty": "RECONCILED_HEURISTIC",
        "realized_pnl_semantics": "UNVERIFIED",
        "reconciled_actual": False,
        "alpha_sample_eligible": False,
    }


def _admissible_cycle(net):
    return {
        "net_result_usd": net,
        "value_truth": "ACTUAL",
        "attribution": "DETERMINISTIC",
        "net_result_certainty": "RECONCILED_ACTUAL",
        "realized_pnl_semantics": "VERIFIED",
        "reconciled_actual": True,
        "alpha_sample_eligible": True,
    }


class EconomicGateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.m = _load()

    def test_current_state_heuristic_and_negative(self) -> None:
        cycles = [_heuristic_cycle(n) for n in (-0.0042, -0.0048, -0.0029, -0.0060)]
        r = self.m.evaluate_economic_promotion(cycles, min_series=100)
        self.assertEqual(r["economic_promotion"]["status"], "BLOCKED")
        self.assertEqual(r["financial_truth"]["status"], "PARTIAL")
        # honest counters: values observed but 0 deterministically reconciled
        c = r["counters"]
        self.assertEqual(c["certified_operational_outcomes"], 4)
        self.assertEqual(c["financially_observed_outcomes"], 4)
        self.assertEqual(c["financially_heuristic_reconciled"], 4)
        self.assertEqual(c["financially_reconciled_actual_outcomes"], 0)
        self.assertEqual(c["economically_admissible_outcomes"], 0)
        for b in ("venue_trade_id_linkage_missing", "financial_reconciliation_not_aligned",
                  "realized_pnl_semantics_unverified", "income_pagination_incomplete",
                  "economic_sample_insufficient", "net_expectancy_not_positive"):
            self.assertIn(b, r["economic_promotion"]["blockers"])

    def test_ledger_stale_style_missing_is_not_observed(self) -> None:
        stale = {"value_truth": "MISSING", "attribution": "HEURISTIC_MATCH",
                 "net_result_certainty": "MISSING", "realized_pnl_semantics": "UNVERIFIED",
                 "reconciled_actual": False, "alpha_sample_eligible": False, "net_result_usd": 0.0}
        r = self.m.evaluate_economic_promotion([stale], min_series=100)
        self.assertEqual(r["counters"]["financially_observed_outcomes"], 0)
        self.assertEqual(r["economic_promotion"]["status"], "BLOCKED")

    def test_proof_cycles_excluded_from_alpha_sample(self) -> None:
        # deterministic + verified but proof (alpha ineligible) -> still 0 admissible
        cycles = [dict(_admissible_cycle(0.01), alpha_sample_eligible=False) for _ in range(100)]
        r = self.m.evaluate_economic_promotion(cycles, min_series=100, income_pagination_complete=True)
        self.assertEqual(r["counters"]["economically_admissible_outcomes"], 0)
        self.assertIn("economic_sample_insufficient", r["economic_promotion"]["blockers"])

    def test_full_admissible_series_passes(self) -> None:
        cycles = [_admissible_cycle(0.02) for _ in range(100)]
        r = self.m.evaluate_economic_promotion(cycles, min_series=100, income_pagination_complete=True)
        self.assertEqual(r["economic_promotion"]["status"], "PASS")
        self.assertEqual(r["economic_promotion"]["blockers"], [])
        self.assertEqual(r["counters"]["economically_admissible_outcomes"], 100)

    def test_negative_admissible_series_blocked(self) -> None:
        cycles = [_admissible_cycle(-0.01) for _ in range(100)]
        r = self.m.evaluate_economic_promotion(cycles, min_series=100, income_pagination_complete=True)
        self.assertEqual(r["economic_promotion"]["status"], "BLOCKED")
        self.assertIn("net_expectancy_not_positive", r["economic_promotion"]["blockers"])


if __name__ == "__main__":
    unittest.main()
