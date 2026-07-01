from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "txt_strategy_shadow_observation_review.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("txt_strategy_shadow_observation_review", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _opp(minute: int, *, strategy: str = "momentum", side: str = "buy", regime: str = "BREAKOUT") -> dict:
    return {
        "scan_at": f"2026-06-30T10:{minute:02d}:00+00:00",
        "decision": "OPPORTUNITY",
        "selected_strategy_id": strategy,
        "side": side,
        "market_regime": regime,
        "edge_lower_confidence_bound_bps": 2.0 + minute,
        "net_expected_edge_bps": 4.0 + minute,
        "snapshot_digest": f"d-{minute}",
        "warmup_complete": True,
        "missing_bar_count": 0,
        "duplicate_bar_count": 0,
    }


class TxtStrategyShadowObservationReviewTests(unittest.TestCase):
    def test_groups_adjacent_matching_opportunities_into_one_episode(self) -> None:
        mod = _load_module()
        rows = [_opp(0), _opp(1), _opp(2), {**_opp(3), "decision": "NO_OPPORTUNITY", "rejection_reasons": ["no_strategy_candidate"]}, _opp(4)]

        report = mod.build_review(rows, episode_gap_minutes=5)

        self.assertEqual(report["raw_candidate_scans"], 4)
        self.assertEqual(report["unique_opportunity_episodes"], 2)
        self.assertEqual(report["cooldown_rejections"], 2)
        self.assertEqual(report["episodes"][0]["scan_count"], 3)
        self.assertEqual(report["episodes"][0]["snapshot_digest_count"], 3)

    def test_splits_episode_on_strategy_side_or_gap(self) -> None:
        mod = _load_module()
        rows = [
            _opp(0, strategy="momentum", side="buy"),
            _opp(1, strategy="momentum", side="sell"),
            _opp(9, strategy="momentum", side="sell"),
            _opp(10, strategy="breakout", side="sell"),
        ]

        report = mod.build_review(rows, episode_gap_minutes=5)

        self.assertEqual(report["unique_opportunity_episodes"], 4)
        self.assertEqual(report["cooldown_rejections"], 0)

    def test_load_jsonl_and_text_summary(self) -> None:
        mod = _load_module()
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "shadow.jsonl"
            path.write_text('{"decision":"NO_OPPORTUNITY","market_regime":"RANGE"}\n', encoding="utf-8")

            report = mod.build_review(mod.load_jsonl(path))
            text = mod.format_text(report)

            self.assertIn("raw_scans=0", text)
            self.assertEqual(report["verdict"], "STRATEGY_SELECTIVE_CONTINUE_OBSERVATION")


if __name__ == "__main__":
    unittest.main()
