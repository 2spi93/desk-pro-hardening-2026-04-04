from __future__ import annotations

import importlib.util
from datetime import datetime, timezone
from pathlib import Path
import sys
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "txt_strategy_brain_v1.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("txt_strategy_brain_v1", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _trend_snapshot(**overrides) -> dict:
    closes = [100.0 + index * 0.35 for index in range(72)]
    payload = {
        "schema_version": "txt.strategy-market-snapshot.v1",
        "symbol": "BTCUSDT",
        "generated_at": "2026-06-30T08:00:00Z",
        "closes": closes,
        "volumes": [100.0 + (index % 8) for index in range(72)],
        "spread_bps": 1.0,
        "estimated_entry_fee_bps": 5.0,
        "estimated_exit_fee_bps": 5.0,
        "estimated_slippage_bps": 1.0,
        "estimated_funding_bps": 0.0,
        "uncertainty_buffer_bps": 2.0,
        "warmup_complete": True,
        "market_data_lag_seconds": 0,
        "expected_interval_seconds": 60,
        "missing_bar_count": 0,
        "duplicate_bar_count": 0,
        "evidence_refs": ["unit:test"],
    }
    payload.update(overrides)
    return payload


class TxtStrategyBrainV1Tests(unittest.TestCase):
    def test_trend_snapshot_produces_canonical_opportunity(self) -> None:
        mod = _load_module()

        report = mod.build_opportunity(
            _trend_snapshot(),
            now=datetime(2026, 6, 30, 8, 0, tzinfo=timezone.utc),
        )

        self.assertEqual(report["status"], "OPPORTUNITY")
        opportunity = report["opportunity"]
        self.assertEqual(opportunity["schema_version"], mod.OPPORTUNITY_SCHEMA_VERSION)
        self.assertEqual(opportunity["symbol"], "BTCUSDT")
        self.assertEqual(opportunity["side"], "buy")
        self.assertGreater(opportunity["net_expected_edge_bps"], 0)
        self.assertGreater(opportunity["edge_lower_confidence_bound_bps"], 0)
        self.assertEqual(opportunity["estimated_fees_bps"], 10.0)
        self.assertEqual(opportunity["producer"], "txt_strategy_brain_v1")

    def test_cost_gate_rejects_edge_that_does_not_clear_lcb(self) -> None:
        mod = _load_module()

        report = mod.build_opportunity(
            _trend_snapshot(estimated_slippage_bps=20.0),
            now=datetime(2026, 6, 30, 8, 0, tzinfo=timezone.utc),
        )

        self.assertEqual(report["status"], "NO_OPPORTUNITY")
        self.assertIn("slippage_above_cap", report["blockers"])

    def test_insufficient_history_never_creates_opportunity(self) -> None:
        mod = _load_module()

        report = mod.build_opportunity(
            _trend_snapshot(closes=[100.0, 100.1, 100.2], volumes=[1.0, 1.0, 1.0]),
            now=datetime(2026, 6, 30, 8, 0, tzinfo=timezone.utc),
        )

        self.assertEqual(report["status"], "NO_OPPORTUNITY")
        self.assertIn("insufficient_market_history", report["blockers"])

    def test_not_warm_snapshot_never_creates_opportunity(self) -> None:
        mod = _load_module()

        report = mod.build_opportunity(
            _trend_snapshot(warmup_complete=False),
            now=datetime(2026, 6, 30, 8, 0, tzinfo=timezone.utc),
        )

        self.assertEqual(report["status"], "NO_OPPORTUNITY")
        self.assertIn("market_data_not_warm", report["blockers"])

    def test_snapshot_digest_is_stable_for_same_input(self) -> None:
        mod = _load_module()
        snapshot = _trend_snapshot()

        first = mod.build_opportunity(snapshot, now=datetime(2026, 6, 30, 8, 0, tzinfo=timezone.utc))
        second = mod.build_opportunity(snapshot, now=datetime(2026, 6, 30, 8, 0, tzinfo=timezone.utc))

        self.assertEqual(first["market_snapshot_digest"], second["market_snapshot_digest"])
        self.assertEqual(first["opportunity"]["opportunity_id"], second["opportunity"]["opportunity_id"])


if __name__ == "__main__":
    unittest.main()
