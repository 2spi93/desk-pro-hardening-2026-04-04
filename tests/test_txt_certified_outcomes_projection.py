from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "txt_certified_outcomes_projection.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("txt_certified_outcomes_projection", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _payload() -> dict:
    fills = []
    outcomes = []
    gaps = []
    for root, entry_side, exit_side in (
        ("proofcyc-1", "sell", "buy"),
        ("proofcyc-2", "sell", "buy"),
        ("proofcyc-3", "buy", "sell"),
    ):
        fills.extend(
            [
                {
                    "decision_id": f"{root}-entry",
                    "fill_id": f"{root}-entry-fill",
                    "venue": "bingx",
                    "instrument": "BTCUSDT",
                    "side": entry_side,
                    "notional_usd": 6,
                    "fill_type": "live-broker",
                    "filled_at": "2026-06-29T09:00:00+00:00",
                },
                {
                    "decision_id": f"{root}-exit",
                    "fill_id": f"{root}-exit-fill",
                    "venue": "bingx",
                    "instrument": "BTCUSDT",
                    "side": exit_side,
                    "notional_usd": 6,
                    "fill_type": "live-broker",
                    "filled_at": "2026-06-29T09:01:00+00:00",
                },
            ]
        )
        outcomes.append(
            {
                "decision_id": f"{root}-entry",
                "source": "intent",
                "provider": "bingx",
                "status": "finalized",
                "updated_at": "2026-06-29T09:02:00+00:00",
                "metadata": {
                    "proof_finalization": {
                        "computed_values_hash": f"hash-{root}",
                        "evidence_refs": {"exit_decision_id": f"{root}-exit"},
                    }
                },
            }
        )
        gaps.append(
            {
                "sample_id": f"rg-{root}",
                "decision_id": f"{root}-entry",
                "venue": "bingx",
                "side": entry_side,
                "failure_source": None,
                "created_at": "2026-06-29T09:03:00+00:00",
            }
        )
    return {"fills": fills, "outcomes": outcomes, "gaps": gaps, "incidents": []}


def _scanner(diverged: bool = True, source_tree_cap: int = 0) -> dict:
    return {
        "generated_at_iso": "2026-06-29T10:00:00Z",
        "findings": [{"code": "replay_truth_divergence_detected"}] if diverged else [],
        "runtime_context": {
            "selected_replay_decision_id": "proofcyc-3-entry",
            "source_tree_certification": {"cap_pct": source_tree_cap},
        },
        "route_matrix": [
            {
                "route": "/api/execution/replay/[decisionId]",
                "aligned": not diverged,
                "divergence_pct": 33.3 if diverged else 0,
            }
        ],
    }


class TxtCertifiedOutcomesProjectionTests(unittest.TestCase):
    def test_projection_surfaces_three_rejected_candidates_when_replay_diverges(self) -> None:
        mod = _load_module()

        with patch.object(mod, "git_head", return_value="abc123"):
            report = mod.build_projection(_payload(), scanner_report=_scanner(), repo_root=ROOT)

        self.assertEqual(report["candidate_total"], 3)
        self.assertEqual(report["base_outcome_total"], 3)
        self.assertEqual(report["certified_total"], 0)
        self.assertEqual(report["rejected_total"], 3)
        self.assertIn("replay_truth_divergence", report["blockers"])
        self.assertIn("source_tree_cap_zero", report["blockers"])
        self.assertTrue(all(item["candidate"] for item in report["candidates"]))

    def test_projection_digest_is_deterministic_for_same_inputs(self) -> None:
        mod = _load_module()

        with patch.object(mod, "git_head", return_value="abc123"):
            first = mod.build_projection(_payload(), scanner_report=_scanner(), repo_root=ROOT)
            second = mod.build_projection(_payload(), scanner_report=_scanner(), repo_root=ROOT)

        self.assertEqual(first["projection_digest"], second["projection_digest"])
        self.assertEqual(
            [item["candidate_digest"] for item in first["candidates"]],
            [item["candidate_digest"] for item in second["candidates"]],
        )

    def test_projection_certifies_candidates_when_replay_and_source_tree_are_clear(self) -> None:
        mod = _load_module()

        with patch.object(mod, "git_head", return_value="abc123"):
            report = mod.build_projection(_payload(), scanner_report=_scanner(diverged=False, source_tree_cap=100), repo_root=ROOT)

        self.assertEqual(report["candidate_total"], 3)
        self.assertEqual(report["certified_total"], 3)
        self.assertEqual(report["rejected_total"], 0)
        self.assertEqual(report["blockers"], [])


if __name__ == "__main__":
    unittest.main()
