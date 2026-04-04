from __future__ import annotations

import os
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from shared.db import ensure_schema, execute, fetch_all, fetch_one, json_dumps

app = FastAPI(title="MT5 Bridge", version="0.1.0")


class Mt5AccountCreateRequest(BaseModel):
    account_id: str
    broker: str = "metaquotes"
    server: str
    login: str
    mode: str = Field(default="paper", pattern="^(paper|live)$")
    metadata: dict[str, Any] = Field(default_factory=dict)


class Mt5OrderFilterRequest(BaseModel):
    account_id: str
    symbol: str
    side: str = Field(pattern="^(buy|sell)$")
    lots: float = Field(gt=0)
    estimated_notional_usd: float = Field(gt=0)
    max_spread_bps: int = Field(gt=0)
    rationale: str = ""
    risk_gate: dict[str, Any] = Field(default_factory=dict)
    routing_plan: dict[str, Any] = Field(default_factory=dict)
    chosen_route: dict[str, Any] = Field(default_factory=dict)
    expected_slippage_bps: float | None = None


def _to_float(value: Any, fallback: float = 0.0) -> float:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return fallback
    if numeric != numeric:
        return fallback
    return numeric


def _json_safe_row(row: dict[str, Any]) -> dict[str, Any]:
    normalized: dict[str, Any] = {}
    for key, value in row.items():
        normalized[key] = value.isoformat() if isinstance(value, datetime) else value
    return normalized


def _default_mark_price(symbol: str, metadata: dict[str, Any]) -> float:
    marks = metadata.get("marks") if isinstance(metadata.get("marks"), dict) else {}
    if symbol in marks:
        return max(0.0001, _to_float(marks.get(symbol), 0.0))
    normalized = symbol.upper()
    defaults = {
        "EURUSD": 1.08,
        "GBPUSD": 1.27,
        "USDJPY": 151.4,
        "XAUUSD": 2185.0,
        "BTCUSD": 69000.0,
        "BTCUSDT": 69000.0,
        "ETHUSD": 3500.0,
        "ETHUSDT": 3500.0,
        "NAS100": 18240.0,
        "US30": 39200.0,
        "GER40": 18350.0,
    }
    if normalized in defaults:
        return defaults[normalized]
    if len(normalized) == 6 and normalized.endswith("USD"):
        return 1.0
    return 1.0


def _default_contract_size(symbol: str, metadata: dict[str, Any]) -> float:
    contract_sizes = metadata.get("contract_sizes") if isinstance(metadata.get("contract_sizes"), dict) else {}
    if symbol in contract_sizes:
        return max(1.0, _to_float(contract_sizes.get(symbol), 1.0))
    normalized = symbol.upper()
    if normalized in {"XAUUSD", "XAGUSD"}:
        return 100.0
    if len(normalized) == 6 and normalized.isalpha():
        return 100000.0
    if normalized.startswith("BTC") or normalized.startswith("ETH"):
        return 1.0
    return 1.0


def _normalized_balances_from_account(account: dict[str, Any]) -> list[dict[str, Any]]:
    metadata = account.get("metadata") if isinstance(account.get("metadata"), dict) else {}
    as_of = _now_iso()
    source = "mt5-bridge-normalized"
    balances_raw = metadata.get("balances")
    normalized: list[dict[str, Any]] = []
    if isinstance(balances_raw, list):
        for item in balances_raw:
            if not isinstance(item, dict):
                continue
            asset_symbol = str(item.get("asset_symbol") or item.get("currency") or item.get("asset") or metadata.get("currency") or "USD").upper()
            available_qty = _to_float(item.get("available_qty", item.get("free", item.get("available", item.get("balance", 0.0)))), 0.0)
            locked_qty = _to_float(item.get("locked_qty", item.get("locked", 0.0)), 0.0)
            mark_price_usd = _to_float(item.get("mark_price_usd"), 1.0 if asset_symbol in {"USD", "USDT"} else 0.0)
            equity_usd = _to_float(item.get("equity_usd"), (available_qty + locked_qty) * (mark_price_usd or 1.0))
            normalized.append(
                {
                    "asset_symbol": asset_symbol,
                    "available_qty": available_qty,
                    "locked_qty": locked_qty,
                    "equity_usd": equity_usd,
                    "mark_price_usd": mark_price_usd or None,
                    "as_of": as_of,
                    "source": source,
                    "payload": item,
                }
            )
    if normalized:
        return normalized

    currency = str(metadata.get("base_currency") or metadata.get("currency") or "USD").upper()
    default_equity_usd = 100000.0 if str(account.get("mode", "paper")) == "paper" else 25000.0
    raw_balance = metadata.get("balance")
    raw_equity = metadata.get("equity")
    raw_available = metadata.get("free_margin", metadata.get("available_balance"))
    available_qty = _to_float(raw_available, -1.0)
    locked_qty = max(0.0, _to_float(metadata.get("margin_used", 0.0), 0.0))
    equity_usd = _to_float(raw_equity if raw_equity is not None else raw_balance, default_equity_usd)
    if equity_usd <= 0:
        equity_usd = default_equity_usd
    if available_qty <= 0:
        available_qty = max(0.0, equity_usd - locked_qty)
    return [
        {
            "asset_symbol": currency,
            "available_qty": available_qty,
            "locked_qty": locked_qty,
            "equity_usd": equity_usd,
            "mark_price_usd": 1.0 if currency in {"USD", "USDT"} else None,
            "as_of": as_of,
            "source": source,
            "payload": metadata,
        }
    ]


def _normalized_positions_from_orders(account: dict[str, Any]) -> list[dict[str, Any]]:
    metadata = account.get("metadata") if isinstance(account.get("metadata"), dict) else {}
    rows = fetch_all(
        """
        SELECT id, symbol, side, lots, created_at, execution_context
        FROM mt5_order_events
        WHERE account_id = %s AND status = 'accepted'
        ORDER BY created_at ASC, id ASC
        """,
        (account["account_id"],),
    )
    grouped: dict[str, dict[str, Any]] = defaultdict(lambda: {
        "net_lots": 0.0,
        "weighted_lots": 0.0,
        "weighted_entry": 0.0,
        "last_created_at": None,
        "payload_rows": [],
    })
    for row in rows:
        symbol = str(row.get("symbol") or "").upper()
        if not symbol:
            continue
        lots = _to_float(row.get("lots"), 0.0)
        signed_lots = lots if str(row.get("side") or "buy") == "buy" else -lots
        execution_context = row.get("execution_context") if isinstance(row.get("execution_context"), dict) else {}
        mark_price = _default_mark_price(symbol, metadata)
        route = execution_context.get("chosen_route") if isinstance(execution_context.get("chosen_route"), dict) else {}
        implied_entry = _to_float(route.get("last") or route.get("mid") or route.get("reference_price"), mark_price)
        bucket = grouped[symbol]
        bucket["net_lots"] += signed_lots
        bucket["weighted_lots"] += abs(lots)
        bucket["weighted_entry"] += abs(lots) * implied_entry
        bucket["last_created_at"] = row.get("created_at")
        bucket["payload_rows"].append(_json_safe_row(row))

    positions: list[dict[str, Any]] = []
    for symbol, bucket in grouped.items():
        net_lots = _to_float(bucket.get("net_lots"), 0.0)
        if abs(net_lots) < 1e-9:
            continue
        mark_price = _default_mark_price(symbol, metadata)
        contract_size = _default_contract_size(symbol, metadata)
        avg_entry_price = _to_float(bucket.get("weighted_entry"), 0.0) / max(_to_float(bucket.get("weighted_lots"), 0.0), 1e-9)
        quantity = abs(net_lots)
        notional_usd = quantity * contract_size * mark_price
        entry_notional_usd = quantity * contract_size * (avg_entry_price or mark_price)
        side = "long" if net_lots > 0 else "short"
        direction = 1.0 if side == "long" else -1.0
        pnl_unrealized_usd = direction * (mark_price - (avg_entry_price or mark_price)) * quantity * contract_size
        last_created_at = bucket.get("last_created_at")
        as_of = last_created_at.isoformat() if isinstance(last_created_at, datetime) else _now_iso()
        positions.append(
            {
                "position_id": f"mt5:{account['account_id']}:{symbol}",
                "account_id": account["account_id"],
                "symbol": symbol,
                "instrument": symbol,
                "side": side,
                "quantity": quantity,
                "notional_usd": notional_usd,
                "avg_entry_price": avg_entry_price or mark_price,
                "mark_price": mark_price,
                "pnl_unrealized_usd": pnl_unrealized_usd,
                "pnl_realized_usd": 0.0,
                "entry_notional_usd": entry_notional_usd,
                "as_of": as_of,
                "source": "mt5-bridge-normalized",
                "payload": {
                    "contract_size": contract_size,
                    "mode": account.get("mode"),
                    "events": bucket.get("payload_rows", []),
                },
            }
        )
    positions.sort(key=lambda item: (str(item["symbol"]), str(item["as_of"])), reverse=False)
    return positions


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@app.on_event("startup")
async def startup() -> None:
    ensure_schema()


@app.get("/health")
async def health() -> dict[str, Any]:
    accounts = fetch_one("SELECT COUNT(*) AS count FROM mt5_accounts") or {"count": 0}
    return {
        "status": "ok",
        "service": "mt5-bridge",
        "mode": os.getenv("MT5_BRIDGE_MODE", "paper"),
        "accounts": int(accounts["count"]),
        "ts": _now_iso(),
    }


@app.get("/v1/accounts")
async def list_accounts() -> list[dict[str, Any]]:
    return fetch_all(
        """
        SELECT account_id, broker, server, login, mode, status, metadata, created_at, updated_at
        FROM mt5_accounts
        ORDER BY updated_at DESC
        """
    )


@app.post("/v1/accounts")
async def upsert_account(request: Mt5AccountCreateRequest) -> dict[str, Any]:
    execute(
        """
        INSERT INTO mt5_accounts (account_id, broker, server, login, mode, status, metadata)
        VALUES (%s, %s, %s, %s, %s, 'connected', %s::jsonb)
        ON CONFLICT (account_id) DO UPDATE SET
            broker = EXCLUDED.broker,
            server = EXCLUDED.server,
            login = EXCLUDED.login,
            mode = EXCLUDED.mode,
            status = 'connected',
            metadata = EXCLUDED.metadata,
            updated_at = NOW()
        """,
        (
            request.account_id,
            request.broker,
            request.server,
            request.login,
            request.mode,
            json_dumps(request.metadata),
        ),
    )
    row = fetch_one("SELECT * FROM mt5_accounts WHERE account_id = %s", (request.account_id,))
    return {"status": "connected", "account": row}


@app.get("/v1/accounts/{account_id}")
async def account_status(account_id: str) -> dict[str, Any]:
    account = fetch_one("SELECT * FROM mt5_accounts WHERE account_id = %s", (account_id,))
    if not account:
        raise HTTPException(status_code=404, detail="MT5 account not found")
    return {"status": "ok", "account": account}


@app.get("/v1/accounts/{account_id}/normalized-state")
async def account_normalized_state(account_id: str) -> dict[str, Any]:
    account = fetch_one("SELECT * FROM mt5_accounts WHERE account_id = %s", (account_id,))
    if not account:
        raise HTTPException(status_code=404, detail="MT5 account not found")
    balances = _normalized_balances_from_account(account)
    positions = _normalized_positions_from_orders(account)
    equity_usd = sum(_to_float(item.get("equity_usd"), 0.0) for item in balances)
    gross_exposure_usd = sum(abs(_to_float(item.get("notional_usd"), 0.0)) for item in positions)
    net_exposure_usd = sum(
        abs(_to_float(item.get("notional_usd"), 0.0)) if str(item.get("side")) == "long" else -abs(_to_float(item.get("notional_usd"), 0.0))
        for item in positions
    )
    as_of_candidates = [str(item.get("as_of")) for item in balances + positions if item.get("as_of")]
    return {
        "status": "ok",
        "service": "mt5-bridge",
        "account": _json_safe_row(account),
        "as_of": max(as_of_candidates) if as_of_candidates else _now_iso(),
        "balances": balances,
        "positions": positions,
        "summary": {
            "equity_usd": equity_usd,
            "gross_exposure_usd": gross_exposure_usd,
            "net_exposure_usd": net_exposure_usd,
            "position_count": len(positions),
            "balance_count": len(balances),
        },
    }


@app.post("/v1/orders/filter")
async def filter_order(request: Mt5OrderFilterRequest) -> dict[str, Any]:
    account = fetch_one("SELECT account_id, mode, status FROM mt5_accounts WHERE account_id = %s", (request.account_id,))
    if not account:
        raise HTTPException(status_code=404, detail="MT5 account not found")
    if account["status"] != "connected":
        raise HTTPException(status_code=409, detail="MT5 account disconnected")

    started_at = datetime.now(timezone.utc)
    chosen_venue = str((request.chosen_route or {}).get("venue") or "mt5-default")
    ticket = f"{chosen_venue}-{int(datetime.now(timezone.utc).timestamp() * 1000)}"
    route_spread_bps = float((request.chosen_route or {}).get("spread_bps") or (request.chosen_route or {}).get("spread") or 0.0)
    baseline_slippage = route_spread_bps if route_spread_bps > 0 else float(request.max_spread_bps) * 0.72
    realized_slippage_bps = round(min(float(request.max_spread_bps), max(0.5, baseline_slippage * 1.05)), 3)
    latency_ms = int((datetime.now(timezone.utc) - started_at).total_seconds() * 1000) + 30
    execute(
        """
        INSERT INTO mt5_order_events (account_id, symbol, side, lots, mode, status, risk_gate, broker_ticket, notes, chosen_route, expected_slippage_bps, execution_context)
        VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s, %s, %s, %s::jsonb)
        """,
        (
            request.account_id,
            request.symbol,
            request.side,
            request.lots,
            account["mode"],
            "accepted",
            json_dumps(request.risk_gate),
            ticket,
            request.rationale,
            chosen_venue,
            request.expected_slippage_bps,
            json_dumps({"routing_plan": request.routing_plan, "chosen_route": request.chosen_route}),
        ),
    )

    return {
        "status": "accepted",
        "bridge_mode": account["mode"],
        "broker_ticket": ticket,
        "account_id": request.account_id,
        "symbol": request.symbol,
        "side": request.side,
        "lots": request.lots,
        "chosen_route": request.chosen_route,
        "realized_slippage_bps": realized_slippage_bps,
        "expected_slippage_bps": request.expected_slippage_bps,
        "latency_ms": latency_ms,
    }


@app.get("/v1/orders/history")
async def order_history(limit: int = 30) -> list[dict[str, Any]]:
    safe_limit = max(1, min(limit, 200))
    return fetch_all(
        """
        SELECT id, account_id, symbol, side, lots, mode, status, risk_gate, broker_ticket, notes, chosen_route, expected_slippage_bps, execution_context, created_at
        FROM mt5_order_events
        ORDER BY created_at DESC
        LIMIT %s
        """,
        (safe_limit,),
    )
