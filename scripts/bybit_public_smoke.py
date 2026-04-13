from __future__ import annotations

import asyncio
import json
import sys
from datetime import datetime, timezone

import httpx
import websockets


REST_BASE_URL = "https://api.bybit.com"
WS_URL = "wss://stream.bybit.com/v5/public/linear"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def fetch_rest_snapshot(client: httpx.AsyncClient, symbol: str) -> dict:
    ticker_response = await client.get(
        f"{REST_BASE_URL}/v5/market/tickers",
        params={"category": "linear", "symbol": symbol},
        timeout=10.0,
    )
    depth_response = await client.get(
        f"{REST_BASE_URL}/v5/market/orderbook",
        params={"category": "linear", "symbol": symbol, "limit": 25},
        timeout=10.0,
    )
    trades_response = await client.get(
        f"{REST_BASE_URL}/v5/market/recent-trade",
        params={"category": "linear", "symbol": symbol, "limit": 25},
        timeout=10.0,
    )
    ticker_response.raise_for_status()
    depth_response.raise_for_status()
    trades_response.raise_for_status()

    ticker_rows = ticker_response.json().get("result", {}).get("list", [])
    depth_payload = depth_response.json().get("result", {})
    trade_rows = trades_response.json().get("result", {}).get("list", [])
    ticker = ticker_rows[0] if ticker_rows else {}

    return {
        "symbol": symbol,
        "rest": {
            "bid": ticker.get("bid1Price"),
            "ask": ticker.get("ask1Price"),
            "last": ticker.get("lastPrice"),
            "depth_levels": max(len(depth_payload.get("b", [])), len(depth_payload.get("a", []))),
            "recent_trades": len(trade_rows),
            "depth_ts": depth_payload.get("ts"),
        },
    }


async def collect_ws_events(symbols: list[str], timeout_seconds: float = 12.0) -> dict[str, dict]:
    state = {
        symbol: {
            "orderbook": None,
            "trade": None,
        }
        for symbol in symbols
    }
    subscriptions = []
    for symbol in symbols:
        subscriptions.append(f"orderbook.200.{symbol}")
        subscriptions.append(f"publicTrade.{symbol}")

    async with websockets.connect(WS_URL, ping_interval=20, ping_timeout=20) as socket:
        await socket.send(json.dumps({"op": "subscribe", "args": subscriptions}))
        deadline = asyncio.get_running_loop().time() + timeout_seconds
        while asyncio.get_running_loop().time() < deadline:
            remaining = max(0.1, deadline - asyncio.get_running_loop().time())
            raw_message = await asyncio.wait_for(socket.recv(), timeout=remaining)
            payload = json.loads(raw_message)
            topic = str(payload.get("topic") or "")
            if topic.startswith("orderbook.200."):
                symbol = topic.split(".")[-1]
                data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
                state[symbol]["orderbook"] = {
                    "type": str(payload.get("type") or "snapshot"),
                    "bid_levels": len(data.get("b", [])),
                    "ask_levels": len(data.get("a", [])),
                    "ts": payload.get("ts") or data.get("ts"),
                }
            elif topic.startswith("publicTrade."):
                symbol = topic.split(".")[-1]
                data = payload.get("data") if isinstance(payload.get("data"), list) else []
                if data:
                    trade = data[0]
                    state[symbol]["trade"] = {
                        "side": trade.get("S") or trade.get("side"),
                        "price": trade.get("p"),
                        "size": trade.get("v") or trade.get("q"),
                        "ts": trade.get("T") or trade.get("ts") or payload.get("ts"),
                    }
            if all(state[symbol]["orderbook"] and state[symbol]["trade"] for symbol in symbols):
                break
    return state


async def main(args: list[str]) -> int:
    symbols = [arg.strip().upper() for arg in args if arg.strip()] or ["BTCUSDT", "ETHUSDT"]
    async with httpx.AsyncClient() as client:
        rest_results = await asyncio.gather(*(fetch_rest_snapshot(client, symbol) for symbol in symbols))
    ws_results = await collect_ws_events(symbols)
    result = {
        "status": "ok",
        "captured_at": now_iso(),
        "symbols": {
            item["symbol"]: {
                **item,
                "ws": ws_results.get(item["symbol"], {}),
            }
            for item in rest_results
        },
    }
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main(sys.argv[1:])))