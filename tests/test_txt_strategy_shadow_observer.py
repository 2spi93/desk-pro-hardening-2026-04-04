from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "txt_strategy_shadow_observer.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("txt_strategy_shadow_observer", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class TxtStrategyShadowObserverTests(unittest.TestCase):
    def test_observe_counts_no_opportunity_and_opportunity(self) -> None:
        mod = _load_module()
        snapshots = [{"snapshot_id": "s1"}, {"snapshot_id": "s2"}]
        reports = [
            {"status": "NO_OPPORTUNITY", "market_regime": "RANGE", "blockers": ["no_strategy_candidate"]},
            {
                "status": "OPPORTUNITY",
                "market_regime": "TREND_UP",
                "selected_strategy_id": "trend_multi_horizon",
                "blockers": [],
                "opportunity": {"side": "buy", "edge_lower_confidence_bound_bps": 1.5},
            },
        ]

        report = mod.observe(
            iterations=2,
            interval_sec=0,
            snapshot_provider=lambda: snapshots.pop(0),
            brain_builder=lambda _snapshot: reports.pop(0),
        )

        self.assertEqual(report["opportunities_detected"], 1)
        self.assertEqual(report["no_opportunity_count"], 1)
        self.assertEqual(report["latest_status"], "OPPORTUNITY")
        self.assertEqual(report["observations"][1]["side"], "buy")
        self.assertIn("no_order", report["non_actions"])

    def test_format_text_is_compact(self) -> None:
        mod = _load_module()
        text = mod.format_text(
            {
                "opportunities_detected": 0,
                "iterations": 3,
                "first_opportunity_after_sec": None,
                "latest_status": "NO_OPPORTUNITY",
                "latest_regime": "RANGE",
                "latest_blockers": ["no_strategy_candidate"],
            }
        )

        self.assertIn("opportunities=0/3", text)
        self.assertIn("latest_status=NO_OPPORTUNITY", text)

    def test_observe_can_record_pre_scan_refresh(self) -> None:
        mod = _load_module()
        calls = {"refresh": 0}

        def refresh():
            calls["refresh"] += 1
            return {"inserted_total": 2}

        report = mod.observe(
            iterations=1,
            interval_sec=0,
            pre_scan_hook=refresh,
            snapshot_provider=lambda: {"snapshot_id": "s1"},
            brain_builder=lambda _snapshot: {"status": "NO_OPPORTUNITY", "market_regime": "RANGE", "blockers": []},
        )

        self.assertTrue(report["refresh_enabled"])
        self.assertEqual(calls["refresh"], 1)
        self.assertEqual(report["observations"][0]["refresh_inserted"], 2)


if __name__ == "__main__":
    unittest.main()
