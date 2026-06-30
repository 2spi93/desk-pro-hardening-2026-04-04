from __future__ import annotations

import importlib.util
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "txt_strategy_market_snapshot.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("txt_strategy_market_snapshot", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _rows(count: int = 72) -> list[dict]:
    start = datetime(2026, 6, 30, 8, 0, tzinfo=timezone.utc)
    return [
        {
            "bucket_start": (start + timedelta(minutes=index)).isoformat(),
            "open": 100.0 + index * 0.2,
            "high": 100.2 + index * 0.2,
            "low": 99.9 + index * 0.2,
            "close": 100.1 + index * 0.2,
            "volume": 1000.0 + index,
            "trades_count": 10 + index,
        }
        for index in range(count)
    ]


class TxtStrategyMarketSnapshotTests(unittest.TestCase):
    def test_builds_canonical_snapshot_from_ohlcv_rows(self) -> None:
        mod = _load_module()

        snapshot = mod.build_snapshot(
            _rows(),
            now=datetime(2026, 6, 30, 9, 0, tzinfo=timezone.utc),
            longest_feature_lookback=60,
        )

        self.assertEqual(snapshot["schema_version"], mod.SNAPSHOT_SCHEMA_VERSION)
        self.assertEqual(snapshot["symbol"], "BTCUSDT")
        self.assertEqual(snapshot["bar_count"], 72)
        self.assertEqual(len(snapshot["closes"]), 72)
        self.assertEqual(snapshot["estimated_fees_bps"], 10.0)
        self.assertGreater(snapshot["estimated_slippage_bps"], 0)
        self.assertTrue(snapshot["snapshot_id"].startswith("mkt-"))
        self.assertEqual(snapshot["expected_interval_seconds"], 60)
        self.assertEqual(snapshot["missing_bar_count"], 0)
        self.assertEqual(snapshot["duplicate_bar_count"], 0)
        self.assertTrue(snapshot["warmup_complete"])

    def test_normalizes_endpoint_short_keys(self) -> None:
        mod = _load_module()

        rows = mod.normalize_ohlcv_rows([
            {"t": "2026-06-30T08:00:00Z", "o": 1, "h": 2, "l": 0.8, "c": 1.5, "v": 10},
            {"t": "2026-06-30T08:01:00Z", "o": 1.5, "h": 2, "l": 1.2, "c": 1.7, "v": 11},
        ])

        self.assertEqual(rows[0]["close"], 1.5)
        self.assertEqual(rows[1]["volume"], 11)

    def test_returns_small_bar_count_for_insufficient_rows(self) -> None:
        mod = _load_module()

        snapshot = mod.build_snapshot(
            _rows(5),
            now=datetime(2026, 6, 30, 9, 0, tzinfo=timezone.utc),
        )

        self.assertEqual(snapshot["bar_count"], 5)
        self.assertEqual(len(snapshot["closes"]), 5)
        self.assertFalse(snapshot["warmup_complete"])

    def test_detects_missing_and_duplicate_bars(self) -> None:
        mod = _load_module()
        rows = _rows(80)
        rows.pop(10)
        rows.append(dict(rows[-1]))

        snapshot = mod.build_snapshot(
            rows,
            now=datetime(2026, 6, 30, 10, 0, tzinfo=timezone.utc),
            longest_feature_lookback=60,
        )

        self.assertGreater(snapshot["missing_bar_count"], 0)
        self.assertGreater(snapshot["duplicate_bar_count"], 0)
        self.assertFalse(snapshot["warmup_complete"])


if __name__ == "__main__":
    unittest.main()
