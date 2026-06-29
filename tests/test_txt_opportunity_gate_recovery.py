from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "txt_opportunity_gate_recovery.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("txt_opportunity_gate_recovery", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _review(*, active: bool = True, owner: str = "opportunity_gate", reason: str = "consistency_kill_threshold", metric_active: bool = False) -> dict:
    return {
        "OPPORTUNITY_GATE_READY": False,
        "lock": {"active": active, "owner": owner, "reason": reason},
        "occurrence_window": {"metric_condition_still_reproducible_now": metric_active},
    }


class TxtOpportunityGateRecoveryTests(unittest.TestCase):
    def test_allows_only_targeted_resolved_consistency_latch(self) -> None:
        mod = _load_module()

        allowed, blockers = mod.can_reset(_review())

        self.assertTrue(allowed)
        self.assertEqual(blockers, [])

    def test_blocks_wrong_owner_or_active_metric_condition(self) -> None:
        mod = _load_module()

        allowed_owner, blockers_owner = mod.can_reset(_review(owner="execution-router"))
        allowed_metric, blockers_metric = mod.can_reset(_review(metric_active=True))

        self.assertFalse(allowed_owner)
        self.assertIn("lock_owner_not_opportunity_gate", blockers_owner)
        self.assertFalse(allowed_metric)
        self.assertIn("metric_condition_still_reproducible", blockers_metric)

    def test_report_marks_no_market_action(self) -> None:
        mod = _load_module()

        report = mod.build_report(before=_review(), executed=False, blocked_reasons=[])

        self.assertTrue(report["NO_MARKET_ACTION"])
        self.assertFalse(report["RESET_OR_CLOSE_PERFORMED"])


if __name__ == "__main__":
    unittest.main()
