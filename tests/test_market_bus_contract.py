from __future__ import annotations

import asyncio
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from apps.control_plane.market_bus_contract import CONTRACT_VERSION, build_market_bus_snapshot_contract
from apps.control_plane import main as control_plane


class MarketBusContractTests(unittest.TestCase):
    def test_exports_computed_payload_without_default_fabrication(self) -> None:
        rows = [{"seq": index + 1, "t": f"2026-07-22T00:{index:02d}:00Z"} for index in range(5)]
        depth = {"snapshot_at": "2026-07-22T00:05:00Z", "depth_payload": {"lastUpdateId": 7}}
        trades = [{"traded_at": "2026-07-22T00:05:00Z"}]
        health = {"status": "ok", "components": {"trades": {"status": "ok", "freshness_ms": 12}}}

        result = build_market_bus_snapshot_contract(
            instrument="BTCUSDT",
            venue="binance-public",
            timeframe="1m",
            trades=trades,
            ohlcv_rows=rows,
            depth_snapshot=depth,
            microstructure=None,
            session_state=None,
            orderbook=None,
            routing_score=None,
            health=health,
            sequencing={"ohlcv": {"latest_seq": 5}},
            trade_preprocessor={},
            observed_at="2026-07-22T00:05:01+00:00",
        )

        self.assertEqual(result["contract_version"], CONTRACT_VERSION)
        self.assertIs(result["ohlcv_rows"], rows)
        self.assertIs(result["depth_snapshot"], depth)
        self.assertIs(result["trades"], trades)
        self.assertEqual(result["trade_state"], {"count": 1, "status": "ok", "freshness_ms": 12})
        self.assertEqual(result["symbol"], "BTCUSDT")
        self.assertEqual(result["observation"]["source"], "control-plane-market-bus")

    def test_missing_depth_remains_explicitly_missing(self) -> None:
        result = build_market_bus_snapshot_contract(
            instrument="BTCUSD",
            venue="binance-public",
            timeframe="1m",
            trades=[],
            ohlcv_rows=[],
            depth_snapshot=None,
            microstructure=None,
            session_state=None,
            orderbook=None,
            routing_score=None,
            health={"status": "degraded", "components": {}},
            sequencing={},
            trade_preprocessor={},
            observed_at="2026-07-22T00:00:00+00:00",
        )
        self.assertEqual(result["ohlcv_rows"], [])
        self.assertIsNone(result["depth_snapshot"])
        self.assertEqual(result["trade_state"]["count"], 0)

    def test_endpoint_exports_real_500_rows_and_depth_for_both_symbols(self) -> None:
        now = datetime(2026, 7, 22, 12, 0, tzinfo=timezone.utc)
        rows = [
            {
                "seq": index + 1,
                "t": (now - timedelta(minutes=499 - index)).isoformat(),
                "close": 100 + index,
            }
            for index in range(500)
        ]
        depth = {
            "snapshot_at": (now - timedelta(seconds=1)).isoformat(),
            "source": "market-data",
            "depth_payload": {"lastUpdateId": 99},
        }

        class Response:
            status_code = 200

            def __init__(self, payload):
                self.payload = payload

            def json(self):
                return self.payload

        class Client:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return None

            async def get(self, url, **_kwargs):
                if url.endswith("/v1/market/trades/preprocessed"):
                    return Response({"items": [{"traded_at": (now - timedelta(seconds=1)).isoformat()}]})
                if url.endswith("/v1/market/trades/preprocessor/journal"):
                    return Response({"items": [], "summary": {}})
                if url.endswith("/v1/market/trades/preprocessor/analytics"):
                    return Response({"windows": {}, "thresholds": {}})
                if url.endswith("/v1/market/ohlcv"):
                    return Response(rows)
                if url.endswith("/v1/market/orderbook/depth"):
                    return Response(depth)
                return Response({"captured_at": now.isoformat(), "phase": "OPEN"})

        with patch.object(control_plane.httpx, "AsyncClient", return_value=Client()), \
             patch.object(control_plane, "_now_utc", return_value=now):
            for symbol in ("BTCUSD", "BTCUSDT"):
                result = asyncio.run(control_plane.market_bus_snapshot(symbol, auth=None))
                self.assertEqual(result["instrument"], symbol)
                self.assertEqual(len(result["ohlcv_rows"]), 500)
                self.assertEqual(result["ohlcv_rows"][-1]["close"], 599)
                self.assertEqual(result["depth_snapshot"], depth)
                self.assertEqual(result["contract_version"], CONTRACT_VERSION)


if __name__ == "__main__":
    unittest.main()
