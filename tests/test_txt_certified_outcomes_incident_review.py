from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "txt_certified_outcomes_incident_review.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("txt_certified_outcomes_incident_review", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _incident() -> dict:
    return {
        "ticket_key": "INC-444A3CCAFA",
        "status": "open",
        "title": "[Constitutional] Certified Outcomes Gate blocked",
    }


def _promotion(validated: bool = True) -> dict:
    return {
        "PROOF_LAYER_VALIDATED": validated,
        "counts": {"clean_cycles": 3 if validated else 1},
        "clean_sides": ["buy", "sell"] if validated else ["sell"],
        "cycles": [],
    }


class TxtCertifiedOutcomesIncidentReviewTests(unittest.TestCase):
    def test_projection_incomplete_when_proof_validated_but_base_outcome_zero(self) -> None:
        mod = _load_module()
        report = {
            "schema_version": "constitutional-critical-scanner/v2",
            "generated_at_iso": "2026-06-29T10:00:00Z",
            "findings": [{"code": "certified_outcomes_below_gate"}],
            "certified_outcomes": {"certified_total": 0, "required_total": 100},
            "runtime_context": {"base_outcome_total": 0, "source_tree_certification": {"cap_pct": 0}},
        }

        projection = {
            "schema_version": "txt-certified-outcomes-projection/v1",
            "candidate_total": 3,
            "certified_total": 0,
            "rejected_total": 3,
            "base_outcome_total": 3,
            "blockers": ["replay_truth_divergence"],
            "projection_digest": "digest-1",
        }

        review = mod.build_review(
            incident=_incident(),
            scanner_report=report,
            promotion_review=_promotion(),
            projection_report=projection,
        )

        self.assertEqual(review["verdict"], mod.CERTIFICATION_INCOMPLETE)
        self.assertTrue(review["answers"]["blocker_reproducible"])
        self.assertTrue(review["proof_layer"]["validated"])
        self.assertEqual(review["projection"]["candidate_total"], 3)
        self.assertEqual(review["projection"]["certified_total"], 0)
        self.assertTrue(review["answers"]["three_clean_cycles_in_certified_outcomes"])

    def test_endpoint_still_blocked_when_certified_gate_fails_without_validated_proof(self) -> None:
        mod = _load_module()
        report = {
            "findings": [{"code": "certified_outcomes_below_gate"}],
            "certified_outcomes": {"certified_total": 7, "required_total": 100},
            "runtime_context": {"base_outcome_total": 7, "source_tree_certification": {"cap_pct": 50}},
        }

        review = mod.build_review(
            incident=_incident(),
            scanner_report=report,
            promotion_review=_promotion(False),
            projection_report={"candidate_total": 0, "certified_total": 0, "blockers": []},
        )

        self.assertEqual(review["verdict"], mod.ENDPOINT_STILL_BLOCKED)

    def test_ready_to_close_when_gate_ready_and_proof_validated(self) -> None:
        mod = _load_module()
        report = {
            "findings": [],
            "certified_outcomes": {"certified_total": 100, "required_total": 100},
            "runtime_context": {"base_outcome_total": 100, "source_tree_certification": {"cap_pct": 100}},
        }

        review = mod.build_review(
            incident=_incident(),
            scanner_report=report,
            promotion_review=_promotion(),
            projection_report={"candidate_total": 100, "certified_total": 100, "blockers": []},
        )

        self.assertEqual(review["verdict"], mod.READY_TO_CLOSE)
        self.assertFalse(review["answers"]["blocker_reproducible"])

    def test_threshold_not_reached_when_projection_certifies_three_of_hundred(self) -> None:
        mod = _load_module()
        report = {
            "findings": [{"code": "certified_outcomes_below_gate"}],
            "certified_outcomes": {"certified_total": 3, "required_total": 100},
            "runtime_context": {
                "base_outcome_total": 0,
                "source_tree_certification": {"cap_pct": 0},
                "certified_outcomes_counter": {
                    "legacy_scanner_total": 0,
                    "canonical_projection_total": 3,
                    "effective_certified_total": 3,
                    "counter_delta": 0,
                    "migration_state": "legacy_counter_superseded",
                },
            },
        }

        review = mod.build_review(
            incident=_incident(),
            scanner_report=report,
            promotion_review=_promotion(),
            projection_report={"candidate_total": 3, "certified_total": 3, "rejected_total": 0, "blockers": []},
        )

        self.assertEqual(review["verdict"], mod.THRESHOLD_NOT_REACHED)
        self.assertEqual(review["scanner"]["certified_outcomes"]["certified_total"], 3)
        self.assertEqual(
            review["scanner"]["runtime_context"]["certified_outcomes_counter"]["counter_delta"],
            0,
        )
        self.assertTrue(review["answers"]["threshold_not_reached"])
        self.assertTrue(review["answers"]["blocker_reproducible"])


if __name__ == "__main__":
    unittest.main()
