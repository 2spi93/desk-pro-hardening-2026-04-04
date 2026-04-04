#!/bin/sh
set -eu

instrument="${1:-BTCUSDT}"
venue="${2:-binance-public}"
limit="${3:-5}"
gateway_host="${GATEWAY_HOST:-mission-control-gateway}"
gateway_port="${GATEWAY_PORT:-3000}"

docker exec market-data python - "$instrument" "$venue" "$limit" "$gateway_host" "$gateway_port" <<'PY'
import asyncio
import json
import sys

import websockets

instrument = sys.argv[1]
venue = sys.argv[2]
limit = int(sys.argv[3])
gateway_host = sys.argv[4]
gateway_port = sys.argv[5]

url = f"ws://{gateway_host}:{gateway_port}/ws/v1/market/trades/{instrument}?venue={venue}&limit={limit}"


async def main() -> None:
    async with websockets.connect(url, ping_interval=20, ping_timeout=20, open_timeout=20) as socket:
        first_message = json.loads(await asyncio.wait_for(socket.recv(), timeout=20))
        print(json.dumps({"phase": "snapshot", "payload": first_message}, default=str))

        if first_message.get("type") != "snapshot":
            raise SystemExit("expected initial snapshot frame")

        items = first_message.get("items") or []
        if not isinstance(items, list):
            raise SystemExit("snapshot items is not a list")

        if venue == "coinbase-public" and len(items) == 0:
            # Coinbase snapshot can be empty immediately after restart. Wait for a live trade.
            pass
        elif len(items) == 0:
            raise SystemExit("snapshot contains no trades")

        await socket.send("ping")

        live_message = json.loads(await asyncio.wait_for(socket.recv(), timeout=25))
        print(json.dumps({"phase": "live", "payload": live_message}, default=str))

        if live_message.get("type") != "trade":
            raise SystemExit("expected live trade frame")

        item = live_message.get("item") or {}
        if float(item.get("price") or 0) <= 0 or float(item.get("size") or 0) <= 0:
            raise SystemExit("live trade frame missing positive price/size")


asyncio.run(main())
PY