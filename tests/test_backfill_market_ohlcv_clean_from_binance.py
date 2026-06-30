from __future__ import annotations

import importlib.util
from datetime import datetime, timezone
from pathlib import Path
import sys
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "backfill_market_ohlcv_clean_from_binance.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("backfill_market_ohlcv_clean_from_binance", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class BackfillMarketOhlcvCleanFromBinanceTests(unittest.TestCase):
    def test_parse_kline_converts_public_payload(self) -> None:
        mod = _load_module()
        row = [
            1782808800000,
            "59259.94000000",
            "59279.18000000",
            "59257.63000000",
            "59262.09000000",
            "10.72792000",
            1782808859999,
            "635812.91894790",
            3101,
        ]

        candle = mod.parse_kline(row)

        self.assertEqual(candle["bucket_start"], datetime(2026, 6, 30, 8, 40, tzinfo=timezone.utc))
        self.assertEqual(candle["open"], 59259.94)
        self.assertEqual(candle["n_trades"], 3101)
        self.assertGreater(candle["vwap"], 0)

    def test_floor_time_aligns_to_timeframe(self) -> None:
        mod = _load_module()

        floored = mod.floor_time(datetime(2026, 6, 30, 10, 7, 42, tzinfo=timezone.utc), 300)

        self.assertEqual(floored, datetime(2026, 6, 30, 10, 5, tzinfo=timezone.utc))

    def test_format_text_exposes_write_and_insert_counts(self) -> None:
        mod = _load_module()

        text = mod.format_text(
            {
                "write_db": False,
                "expected_total": 10,
                "missing_before": 3,
                "fetched_total": 10,
                "inserted_total": 0,
                "source": mod.SOURCE,
            }
        )

        self.assertIn("write_db=False", text)
        self.assertIn("missing_before=3", text)
        self.assertIn(mod.SOURCE, text)


if __name__ == "__main__":
    unittest.main()
