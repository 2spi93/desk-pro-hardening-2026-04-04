from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "txt_opportunity_gate_readiness_review.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("txt_opportunity_gate_readiness_review", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _data(*, ready: bool = False) -> dict:
    gate = {
        "status": "go" if ready else "no-go",
        "kill_switch_recommended": False if ready else True,
        "kill_switch_reason": None if ready else "consistency_kill_threshold",
        "source": "execution-router/health",
        "updated_at": "2026-06-29T14:11:19Z",
        "reasons": [] if ready else ["consistency_below_threshold", "deviation_above_threshold"],
        "metrics": {
            "consistency": 72.0 if ready else 63.3,
            "candidates": 5,
            "bus_seq": 428137,
            "deviation_bps": 20.2,
            "freshness_ms": 181.0,
            "flags": [],
        },
        "thresholds": {
            "min_consistency_pct": 70.0,
            "kill_consistency_pct": 65.0,
            "min_candidates": 3.0,
            "max_deviation_bps": 20.0,
        },
    }
    lock = {
        "lock_active": not ready,
        "lock_owner": "opportunity_gate" if not ready else None,
        "lock_reason": "consistency_kill_threshold" if not ready else None,
        "status": "blocked_by_local_lock" if not ready else "clear",
        "acquired_at": "2026-06-29T14:11:21Z" if not ready else None,
        "activation": {"payload": {"gate": gate}},
    }
    return {
        "gate": gate,
        "lock": lock,
        "incidents": [
            {
                "ticket_key": "INC-lock",
                "source": "opportunity_gate",
                "title": "Freeze runtime: consistency_kill_threshold",
                "status": "open",
                "created_at": "2026-06-29T14:11:22Z",
            },
            {
                "ticket_key": "INC-other",
                "source": "terminal",
                "title": "Terminal local hard fail BTCUSDT 1h",
                "status": "open",
                "created_at": "2026-06-01T00:00:00Z",
            },
        ],
    }


class TxtOpportunityGateReadinessReviewTests(unittest.TestCase):
    def test_active_consistency_lock_is_explained_and_not_reset(self) -> None:
        mod = _load_module()

        report = mod.build_review(_data(ready=False), now=mod.parse_time("2026-06-29T15:00:00Z"))

        self.assertFalse(report["OPPORTUNITY_GATE_READY"])
        self.assertTrue(report["lock"]["active"])
        self.assertEqual(report["lock"]["owner"], "opportunity_gate")
        self.assertEqual(report["lock"]["reason"], "consistency_kill_threshold")
        self.assertEqual(report["consistency_threshold"]["observed"], 63.3)
        self.assertEqual(report["consistency_threshold"]["kill_threshold"], 65.0)
        self.assertTrue(report["occurrence_window"]["metric_condition_still_reproducible_now"])
        self.assertTrue(report["occurrence_window"]["lock_still_latched"])
        self.assertFalse(report["RESET_OR_CLOSE_PERFORMED"])

    def test_incident_can_be_duplicate_of_consistency_lock(self) -> None:
        mod = _load_module()

        report = mod.build_review(_data(ready=False), now=mod.parse_time("2026-06-29T15:00:00Z"))

        item = next(row for row in report["incident_adjudication"]["items"] if row["incident_id"] == "INC-lock")
        self.assertEqual(item["classification"], mod.DUPLICATE_OF_CONSISTENCY_LOCK)
        self.assertFalse(report["incident_adjudication"]["promotion_relevant_incident_clear"])

    def test_ready_when_gate_go_kill_false_and_lock_clear(self) -> None:
        mod = _load_module()
        data = _data(ready=True)
        data["incidents"] = []

        report = mod.build_review(data, now=mod.parse_time("2026-06-29T15:00:00Z"))

        self.assertTrue(report["OPPORTUNITY_GATE_READY"])
        self.assertFalse(report["occurrence_window"]["metric_condition_still_reproducible_now"])
        self.assertFalse(report["occurrence_window"]["lock_still_latched"])
        self.assertEqual(report["recommended_disposition"], "eligible_for_operator_close_or_reset_review")


if __name__ == "__main__":
    unittest.main()
