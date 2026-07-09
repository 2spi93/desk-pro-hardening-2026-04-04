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


def _cycle(net, not_actual=False, reconciliation="heuristic_symbol_time_info"):
    return {"net_result_usd": net, "financial_truth_not_actual": not_actual, "reconciliation": reconciliation}


class EconomicGateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.m = _load()

    def test_current_state_blocked_heuristic_and_negative(self) -> None:
        cycles = [_cycle(-0.0042), _cycle(-0.0048), _cycle(-0.0029), _cycle(-0.0060)]
        r = self.m.evaluate_economic_promotion(cycles, min_series=100)
        self.assertEqual(r["ECONOMIC_PROMOTION"], "BLOCKED")
        self.assertIn("financial_truth_not_actual", r["blockers"])
        self.assertIn("reconciliation_not_deterministic", r["blocker_reasons"])
        self.assertIn("net_expectancy_not_positive", r["blocker_reasons"])
        self.assertEqual(r["financially_actual_outcomes"], 4)
        self.assertFalse(r["net_expectancy_positive"])

    def test_deterministic_positive_series_passes(self) -> None:
        cycles = [_cycle(0.01, reconciliation="deterministic_order_trade_id") for _ in range(100)]
        r = self.m.evaluate_economic_promotion(cycles, min_series=100)
        self.assertEqual(r["ECONOMIC_PROMOTION"], "PASS")
        self.assertEqual(r["blockers"], [])
        self.assertTrue(r["deterministic_reconciliation"])
        self.assertTrue(r["net_expectancy_positive"])

    def test_not_actual_cycle_blocks(self) -> None:
        cycles = [_cycle(0.01, reconciliation="deterministic_order_trade_id") for _ in range(99)]
        cycles.append(_cycle(0.0, not_actual=True, reconciliation="deterministic_order_trade_id"))
        r = self.m.evaluate_economic_promotion(cycles, min_series=100)
        self.assertEqual(r["ECONOMIC_PROMOTION"], "BLOCKED")
        self.assertIn("financial_truth_incomplete_for_some_cycles", r["blocker_reasons"])
        self.assertEqual(r["financially_actual_outcomes"], 99)

    def test_series_below_target_blocks_even_if_positive(self) -> None:
        cycles = [_cycle(0.02, reconciliation="deterministic_order_trade_id") for _ in range(4)]
        r = self.m.evaluate_economic_promotion(cycles, min_series=100)
        self.assertEqual(r["ECONOMIC_PROMOTION"], "BLOCKED")
        self.assertIn("series_below_100", r["blocker_reasons"])


if __name__ == "__main__":
    unittest.main()
