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


def _det(net, cross="ALIGNED", alpha=False):
    verified = cross == "ALIGNED"
    return {
        "net_result_usd": net,
        "attribution": "DETERMINISTIC",
        "order_level_actual": True,
        "independent_cross_check": cross,
        "independently_cross_verified": verified,
        "reconciled_actual": verified,
        "alpha_sample_eligible": alpha,
    }


class EconomicGateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.m = _load()

    def test_current_state_3_of_4_cross_verified(self) -> None:
        cycles = [_det(-0.0042), _det(-0.0048, cross="AMBIGUOUS"), _det(-0.0029), _det(-0.0060)]
        r = self.m.evaluate_economic_promotion(cycles, min_series=100)
        c = r["counters"]
        self.assertEqual(c["certified_operational_outcomes"], 4)
        self.assertEqual(c["deterministically_attributed_orders"], 4)
        self.assertEqual(c["order_level_actual_outcomes"], 4)
        self.assertEqual(c["independently_cross_verified_outcomes"], 3)
        self.assertEqual(c["cross_check_ambiguous_outcomes"], 1)
        self.assertEqual(c["fully_reconciled_actual_outcomes"], 3)
        self.assertEqual(c["economically_admissible_outcomes"], 0)
        self.assertEqual(r["order_level_financials"]["status"], "ACTUAL")
        self.assertEqual(r["independent_cross_check"]["verified"], 3)
        # corpus semantic proven (3 >= 2) -> that blocker clears
        self.assertTrue(r["independent_cross_check"]["semantics_corpus_verified"])
        self.assertNotIn("realized_pnl_semantics_unverified", r["economic_promotion"]["blockers"])
        self.assertNotIn("venue_order_linkage_incomplete", r["economic_promotion"]["blockers"])
        # still BLOCKED for honest reasons
        self.assertEqual(r["economic_promotion"]["status"], "BLOCKED")
        for b in ("income_pagination_incomplete", "economic_sample_insufficient", "net_expectancy_unavailable"):
            self.assertIn(b, r["economic_promotion"]["blockers"])
        self.assertIsNone(r["net_expectancy"]["positive"])

    def test_too_few_cross_checks_keeps_semantics_unverified(self) -> None:
        cycles = [_det(-0.004, cross="ALIGNED"), _det(-0.004, cross="AMBIGUOUS"), _det(-0.004, cross="AMBIGUOUS")]
        r = self.m.evaluate_economic_promotion(cycles, min_series=100, semantics_corpus_min=2)
        self.assertFalse(r["independent_cross_check"]["semantics_corpus_verified"])
        self.assertIn("realized_pnl_semantics_unverified", r["economic_promotion"]["blockers"])

    def test_proof_cycles_excluded_from_alpha(self) -> None:
        cycles = [_det(0.01, alpha=False) for _ in range(100)]
        r = self.m.evaluate_economic_promotion(cycles, min_series=100, income_pagination_complete=True)
        self.assertEqual(r["counters"]["economically_admissible_outcomes"], 0)
        self.assertIn("economic_sample_insufficient", r["economic_promotion"]["blockers"])
        self.assertIn("net_expectancy_unavailable", r["economic_promotion"]["blockers"])

    def test_full_admissible_positive_series_passes(self) -> None:
        cycles = [_det(0.02, alpha=True) for _ in range(100)]
        r = self.m.evaluate_economic_promotion(cycles, min_series=100, income_pagination_complete=True)
        self.assertEqual(r["economic_promotion"]["status"], "PASS")
        self.assertEqual(r["economic_promotion"]["blockers"], [])

    def test_admissible_negative_series_blocked_not_positive(self) -> None:
        cycles = [_det(-0.01, alpha=True) for _ in range(100)]
        r = self.m.evaluate_economic_promotion(cycles, min_series=100, income_pagination_complete=True)
        self.assertIn("net_expectancy_not_positive", r["economic_promotion"]["blockers"])
        self.assertNotIn("net_expectancy_unavailable", r["economic_promotion"]["blockers"])


if __name__ == "__main__":
    unittest.main()
