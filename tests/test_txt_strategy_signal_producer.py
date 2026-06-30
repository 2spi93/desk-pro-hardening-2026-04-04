from __future__ import annotations

import importlib.util
from datetime import datetime, timezone
from pathlib import Path
import sys
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "txt_strategy_signal_producer.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("txt_strategy_signal_producer", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _source(**overrides) -> dict:
    payload = {
        "schema_version": "txt.strategy-opportunity.v1",
        "source_id": "opp-1",
        "strategy_id": "bootstrap-edge-smoke",
        "strategy_version": "v1",
        "symbol": "BTCUSDT",
        "side": "buy",
        "generated_at": "2026-06-29T12:00:00Z",
        "expires_at": "2026-06-29T12:10:00Z",
        "confidence": 0.73,
        "market_regime": "liquid_micro",
        "entry_reason": "positive_micro_edge_after_costs",
        "invalidation_reason": "spread_or_consistency_degrades",
        "expected_edge_bps": 4.0,
        "estimated_fees_bps": 1.2,
        "estimated_slippage_bps": 1.0,
    }
    payload.update(overrides)
    return payload


class TxtStrategySignalProducerTests(unittest.TestCase):
    def test_produces_admissible_signal_when_net_edge_positive(self) -> None:
        mod = _load_module()

        signal = mod.build_signal(_source(), now=datetime(2026, 6, 29, 12, 1, tzinfo=timezone.utc))

        self.assertTrue(signal["admissible"])
        self.assertEqual(signal["schema_version"], mod.SIGNAL_SCHEMA_VERSION)
        self.assertEqual(signal["net_expected_edge_bps"], 1.8)
        self.assertFalse(signal["consumed"])
        self.assertEqual(signal["admission_blockers"], [])

    def test_rejects_expired_or_negative_net_edge(self) -> None:
        mod = _load_module()

        expired = mod.build_signal(_source(expires_at="2026-06-29T12:00:30Z"), now=datetime(2026, 6, 29, 12, 1, tzinfo=timezone.utc))
        negative = mod.build_signal(_source(expected_edge_bps=1.0, estimated_fees_bps=1.2, estimated_slippage_bps=1.0), now=datetime(2026, 6, 29, 12, 1, tzinfo=timezone.utc))

        self.assertFalse(expired["admissible"])
        self.assertIn("source_expired", expired["admission_blockers"])
        self.assertFalse(negative["admissible"])
        self.assertIn("net_expected_edge_not_positive", negative["admission_blockers"])

    def test_rejects_wrong_symbol_or_side(self) -> None:
        mod = _load_module()

        wrong = mod.build_signal(_source(symbol="ETHUSDT", side="hold"), now=datetime(2026, 6, 29, 12, 1, tzinfo=timezone.utc))

        self.assertFalse(wrong["admissible"])
        self.assertIn("symbol_not_allowed", wrong["admission_blockers"])
        self.assertIn("side_invalid", wrong["admission_blockers"])

    def test_full_opportunity_contract_uses_funding_buffer_and_lower_bound(self) -> None:
        mod = _load_module()

        signal = mod.build_signal(
            _source(
                gross_expected_edge_bps=21.0,
                expected_edge_bps=None,
                estimated_entry_fee_bps=5.0,
                estimated_exit_fee_bps=5.0,
                estimated_fees_bps=None,
                estimated_slippage_bps=2.0,
                estimated_funding_bps=1.0,
                uncertainty_buffer_bps=3.0,
                net_expected_edge_bps=None,
                edge_lower_confidence_bound_bps=0.75,
                model_version="strategy-brain-v1",
                market_snapshot_digest="digest-1",
                evidence_refs=["unit:test"],
            ),
            now=datetime(2026, 6, 29, 12, 1, tzinfo=timezone.utc),
        )

        self.assertTrue(signal["admissible"])
        self.assertEqual(signal["estimated_fees_bps"], 10.0)
        self.assertEqual(signal["net_expected_edge_bps"], 5.0)
        self.assertEqual(signal["edge_lower_confidence_bound_bps"], 0.75)
        self.assertEqual(signal["model_version"], "strategy-brain-v1")

    def test_full_opportunity_contract_requires_positive_lower_bound(self) -> None:
        mod = _load_module()

        signal = mod.build_signal(
            _source(
                gross_expected_edge_bps=25.0,
                estimated_entry_fee_bps=5.0,
                estimated_exit_fee_bps=5.0,
                estimated_fees_bps=None,
                estimated_slippage_bps=2.0,
                estimated_funding_bps=0.0,
                uncertainty_buffer_bps=3.0,
                edge_lower_confidence_bound_bps=-0.2,
            ),
            now=datetime(2026, 6, 29, 12, 1, tzinfo=timezone.utc),
        )

        self.assertFalse(signal["admissible"])
        self.assertIn("edge_lower_confidence_bound_not_positive", signal["admission_blockers"])


if __name__ == "__main__":
    unittest.main()
