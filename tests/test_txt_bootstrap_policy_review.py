from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "txt_bootstrap_policy_review.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("txt_bootstrap_policy_review", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class TxtBootstrapPolicyReviewTests(unittest.TestCase):
    def test_scope_separates_micro_proof_from_continuous_threshold(self) -> None:
        mod = _load_module()

        report = mod.build_review(projected_certified_total=3, threshold=100, proof_layer_validated=True)

        self.assertEqual(report["verdict"], "BOOTSTRAP_SCOPE_SEPARATED")
        self.assertFalse(report["gates"]["PROOF_PIPELINE_GATE"]["threshold_100_applies"])
        self.assertTrue(report["gates"]["CONTINUOUS_AUTONOMOUS_GATE"]["threshold_100_applies"])
        self.assertTrue(report["bootstrap_analysis"]["proof_gate_usable_before_threshold"])
        self.assertTrue(report["bootstrap_analysis"]["continuous_gate_can_be_populated_by_micro_live"])
        self.assertFalse(report["bootstrap_analysis"]["circular_lock_detected"])
        self.assertEqual(report["current_counts"]["remaining_to_continuous_autonomous"], 97)

    def test_only_live_proof_cycle_is_admissible_for_continuous_counter(self) -> None:
        mod = _load_module()

        report = mod.build_review()
        matrix = {row["outcome_class"]: row for row in report["outcome_admissibility_matrix"]}

        self.assertTrue(matrix["proof-cycle live micro"]["admissible"])
        self.assertFalse(matrix["controlled simulated outcome"]["admissible"])
        self.assertFalse(matrix["broker dry-run"]["admissible"])
        self.assertFalse(matrix["historical replay certified"]["admissible"])
        self.assertFalse(matrix["operator direct-broker"]["admissible"])
        self.assertFalse(matrix["legacy MT5 intent"]["admissible"])

    def test_detects_circular_lock_when_micro_gate_is_not_usable_before_threshold(self) -> None:
        mod = _load_module()

        report = mod.build_review(projected_certified_total=3, threshold=100, proof_layer_validated=False)

        self.assertEqual(report["verdict"], "BOOTSTRAP_CIRCULAR_LOCK_RISK")
        self.assertTrue(report["bootstrap_analysis"]["circular_lock_detected"])


if __name__ == "__main__":
    unittest.main()
