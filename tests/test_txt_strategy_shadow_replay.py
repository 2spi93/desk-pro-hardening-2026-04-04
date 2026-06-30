from __future__ import annotations

import importlib.util
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "txt_strategy_shadow_replay.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("txt_strategy_shadow_replay", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _rows(count: int = 360) -> list[dict]:
    rows: list[dict] = []
    price = 100.0
    start = datetime(2026, 6, 30, 0, 0, tzinfo=timezone.utc)
    for index in range(count):
        price += 0.12 if index < 260 else -0.03
        rows.append(
            {
                "bucket_start": (start + timedelta(minutes=index)).isoformat(),
                "open": price - 0.05,
                "high": price + 0.08,
                "low": price - 0.08,
                "close": price,
                "volume": 1000.0 + index,
                "trades_count": 20,
            }
        )
    return rows


class TxtStrategyShadowReplayTests(unittest.TestCase):
    def test_replay_reports_scan_and_rejection_counts_without_orders(self) -> None:
        mod = _load_module()

        report = mod.replay(
            rows=_rows(),
            venue="binance-public",
            symbol="BTCUSDT",
            timeframe="1m",
            lookback_bars=120,
            step_bars=15,
            longest_feature_lookback=120,
        )

        self.assertEqual(report["schema_version"], "txt-strategy-shadow-replay/v1")
        self.assertEqual(report["status"], "OK")
        self.assertGreater(report["scans_total"], 0)
        self.assertIn("regime_counts", report)
        self.assertIn("rejection_reason_counts", report)
        self.assertIn("no_order", report["non_actions"])

    def test_replay_handles_insufficient_history(self) -> None:
        mod = _load_module()

        report = mod.replay(
            rows=_rows(20),
            venue="binance-public",
            symbol="BTCUSDT",
            timeframe="1m",
            lookback_bars=120,
            step_bars=5,
            longest_feature_lookback=120,
        )

        self.assertEqual(report["status"], "INSUFFICIENT_HISTORY")
        self.assertEqual(report["scans_total"], 0)


if __name__ == "__main__":
    unittest.main()
