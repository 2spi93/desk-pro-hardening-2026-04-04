from __future__ import annotations

import unittest

from apps.market_data_plane.main import (
    _bingx_depth_book_from_message,
    _market_symbol_for_venue,
    _normalize_bingx_symbol,
)


class MarketDataPlaneBingxTests(unittest.TestCase):
    def test_market_symbol_for_bingx_uses_hyphenated_contract_symbol(self) -> None:
        self.assertEqual(_normalize_bingx_symbol("BTCUSDT"), "BTC-USDT")
        self.assertEqual(_market_symbol_for_venue("bingx-public", "BTCUSDT"), "BTC-USDT")
        self.assertEqual(_market_symbol_for_venue("bingx-public", "BTC-USDT-PERP"), "BTC-USDT")

    def test_bingx_depth_message_parser_builds_book(self) -> None:
        payload = {
            "code": 0,
            "dataType": "BTC-USDT@depth20",
            "ts": 1775843692013,
            "data": {
                "bids": [["73047.1", "3.1310"], ["73046.8", "0.2835"]],
                "asks": [["73047.3", "10.1444"], ["73047.4", "0.1622"]],
            },
        }

        book = _bingx_depth_book_from_message(payload, "BTCUSDT")

        self.assertIsInstance(book, dict)
        self.assertEqual(book["event_time"], 1775843692013)
        self.assertEqual(book["last_update_id"], 1775843692013)
        self.assertEqual(book["bids"][73047.1], 3.131)
        self.assertEqual(book["asks"][73047.3], 10.1444)


if __name__ == "__main__":
    unittest.main()