from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import hmac
import math
import os
import time
from urllib.parse import urlencode

import httpx
from fastapi import FastAPI, HTTPException

from shared.db import ensure_schema, fetch_all

app = FastAPI(title="Broker Adapter", version="0.1.0")

MARKET_DATA_URL = os.getenv("MARKET_DATA_URL", "http://127.0.0.1:8003")
REAL_BROKER_BASE_URL = os.getenv("REAL_BROKER_BASE_URL", "https://api.binance.com")
REAL_BROKER_PROVIDER = os.getenv("REAL_BROKER_PROVIDER", "binance")
REAL_BROKER_API_KEY = os.getenv("REAL_BROKER_API_KEY", "")
REAL_BROKER_API_SECRET = os.getenv("REAL_BROKER_API_SECRET", "")
BINGX_API_BASE_URL = os.getenv("BINGX_API_BASE_URL", "https://open-api.bingx.com").rstrip("/")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _to_float(value: object, default: float = 0.0) -> float:
    try:
        return float(value)
    except Exception:
        return default


def _format_decimal(value: float, digits: int = 8) -> str:
    rendered = f"{value:.{digits}f}".rstrip("0").rstrip(".")
    return rendered or "0"


def _json_number(value: float, digits: int = 8) -> float:
    return float(_format_decimal(value, digits))


def _default_bingx_position_side(side: str, reduce_only: bool) -> str:
    if reduce_only:
        return "SHORT" if side == "buy" else "LONG"
    return "LONG" if side == "buy" else "SHORT"


def _normalize_bingx_symbol(symbol: str) -> str:
    raw = str(symbol or "").strip().upper().replace("/", "-").replace("_", "-")
    if not raw:
        return ""
    for suffix in ("-PERP", "PERP", "-SWAP", "SWAP"):
        if raw.endswith(suffix):
            raw = raw[: -len(suffix)]
            break
    if "-" in raw:
        parts = [part for part in raw.split("-") if part]
        if len(parts) >= 2:
            return f"{parts[0]}-{parts[1]}"
        return raw.replace("--", "-")
    for suffix in ("USDT", "USDC", "USD", "BTC", "ETH"):
        if raw.endswith(suffix) and len(raw) > len(suffix):
            return f"{raw[:-len(suffix)]}-{suffix}"
    return raw


def _canonical_instrument(symbol: str) -> str:
    return str(symbol or "").replace("/", "").replace("-", "").upper()


def _unwrap_bingx_response(path: str, body: object) -> object:
    if not isinstance(body, (dict, list)):
        raise RuntimeError(f"BingX {path} returned an invalid payload")
    if isinstance(body, dict):
        code = body.get("code")
        if code not in {None, 0, "0", "", "SUCCESS", "success"}:
            detail = str(body.get("msg") or body.get("message") or "unknown error")
            raise RuntimeError(f"BingX {path} rejected the request: {detail}")
        if body.get("success") is False:
            detail = str(body.get("msg") or body.get("message") or "unknown error")
            raise RuntimeError(f"BingX {path} reported failure: {detail}")
        data = body.get("data")
        if isinstance(data, (dict, list)):
            return data
    return body


async def _bingx_public_get(path: str, params: dict | None = None) -> object:
    query = {
        str(key): str(value)
        for key, value in (params or {}).items()
        if value is not None and str(value).strip()
    }
    url = f"{BINGX_API_BASE_URL}{path}"
    if query:
        url = f"{url}?{urlencode(sorted(query.items()))}"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(url)
    except httpx.HTTPError as exc:
        raise RuntimeError(f"BingX {path} public request failed: {str(exc)[:300]}") from exc
    if response.status_code >= 400:
        raise RuntimeError(f"BingX {path} public request failed with status {response.status_code}: {response.text[:300]}")
    try:
        body = response.json()
    except ValueError as exc:
        raise RuntimeError(f"BingX {path} returned invalid JSON") from exc
    return _unwrap_bingx_response(path, body)


async def _bingx_signed_request(secret_payload: dict, method: str, path: str, params: dict | None = None) -> object:
    api_key = str(secret_payload.get("api_key") or "").strip()
    api_secret = str(secret_payload.get("api_secret") or "").strip()
    if not api_key or not api_secret:
        raise ValueError("BingX live trading requires an API key and secret")

    query = {
        str(key): str(value)
        for key, value in (params or {}).items()
        if value is not None and str(value).strip()
    }
    query["timestamp"] = str(int(time.time() * 1000))
    query.setdefault("recvWindow", "60000")
    query_string = urlencode(sorted(query.items()))
    signature = hmac.new(api_secret.encode("utf-8"), query_string.encode("utf-8"), hashlib.sha256).hexdigest()
    url = f"{BINGX_API_BASE_URL}{path}?{query_string}&signature={signature}"
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            response = await client.request(method.upper(), url, headers={"X-BX-APIKEY": api_key})
    except httpx.HTTPError as exc:
        raise RuntimeError(f"BingX {path} request failed: {str(exc)[:300]}") from exc
    if response.status_code >= 400:
        raise RuntimeError(f"BingX {path} failed with status {response.status_code}: {response.text[:300]}")
    try:
        body = response.json()
    except ValueError as exc:
        raise RuntimeError(f"BingX {path} returned invalid JSON") from exc
    return _unwrap_bingx_response(path, body)


async def _bingx_margin_snapshot(secret_payload: dict) -> dict[str, float]:
    balances = await _bingx_signed_request(secret_payload, "GET", "/openApi/swap/v2/user/balance")
    if isinstance(balances, list):
        items = balances
    elif isinstance(balances, dict) and isinstance(balances.get("balance"), dict):
        items = [balances.get("balance")]
    elif isinstance(balances, dict):
        items = [balances]
    else:
        items = []
    for item in items:
        if not isinstance(item, dict):
            continue
        asset = str(item.get("asset") or "").strip().upper()
        if asset and asset != "USDT":
            continue
        balance = _to_float(item.get("balance"), 0.0)
        equity = _to_float(item.get("equity"), balance)
        available_margin = _to_float(item.get("availableMargin"), 0.0)
        frozen_margin = _to_float(item.get("freezedMargin"), 0.0)
        return {
            "asset": asset or "USDT",
            "balance": _json_number(balance),
            "equity": _json_number(equity),
            "available_margin": _json_number(available_margin),
            "frozen_margin": _json_number(frozen_margin),
        }
    return {}


async def _reference_price_for_market_order(symbol: str, side: str) -> float:
    market_symbol = _canonical_instrument(symbol)
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(f"{REAL_BROKER_BASE_URL}/api/v3/ticker/bookTicker", params={"symbol": market_symbol})
        if response.status_code == 200:
            body = response.json()
            price = _to_float(body.get("ask") if side == "buy" else body.get("bid"), 0.0)
            if price > 0:
                return price
    except Exception:
        pass

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(f"{MARKET_DATA_URL}/v1/quotes")
        if response.status_code == 200:
            for item in response.json():
                if not isinstance(item, dict):
                    continue
                instrument = _canonical_instrument(str(item.get("instrument") or ""))
                if instrument != market_symbol:
                    continue
                price = _to_float(item.get("ask") if side == "buy" else item.get("bid"), 0.0)
                if price <= 0:
                    price = _to_float(item.get("last"), 0.0)
                if price > 0:
                    return price
    except Exception:
        pass

    return 0.0


async def _bingx_contract_spec(symbol: str) -> dict[str, float | int | str]:
    contracts = await _bingx_public_get("/openApi/swap/v2/quote/contracts")
    items = contracts if isinstance(contracts, list) else []
    normalized_symbol = _normalize_bingx_symbol(symbol)
    canonical_symbol = _canonical_instrument(symbol)
    match: dict | None = None
    for item in items:
        if not isinstance(item, dict):
            continue
        raw_symbol = str(item.get("symbol") or item.get("displayName") or item.get("contract") or "").strip()
        if not raw_symbol:
            continue
        if _normalize_bingx_symbol(raw_symbol) == normalized_symbol or _canonical_instrument(raw_symbol) == canonical_symbol:
            match = item
            break
    if not isinstance(match, dict):
        return {}
    quantity_precision = int(_to_float(match.get("quantityPrecision"), 0.0))
    price_precision = int(_to_float(match.get("pricePrecision"), 0.0))
    size_step = _to_float(match.get("size"), 0.0)
    if size_step <= 0 and quantity_precision > 0:
        size_step = 10 ** (-quantity_precision)
    return {
        "symbol": str(match.get("symbol") or normalized_symbol),
        "size_step": size_step,
        "quantity_precision": quantity_precision,
        "price_precision": price_precision,
        "trade_min_quantity": _to_float(match.get("tradeMinQuantity"), 0.0),
        "trade_min_usdt": _to_float(match.get("tradeMinUSDT"), 0.0),
    }


def _round_to_precision(value: float, digits: int) -> float:
    if digits <= 0:
        return float(round(value))
    return round(value, digits)


def _step_floor(value: float, step: float) -> float:
    if step <= 0:
        return value
    steps = math.floor((value / step) + 1e-12)
    return steps * step


def _step_ceil(value: float, step: float) -> float:
    if step <= 0:
        return value
    steps = math.ceil((value / step) - 1e-12)
    return steps * step


def _bingx_normalize_price(price: float, contract_spec: dict[str, float | int | str]) -> float:
    price_precision = int(contract_spec.get("price_precision") or 0)
    if price <= 0:
        return 0.0
    return _round_to_precision(price, price_precision)


def _bingx_normalize_quantity(
    quantity: float,
    *,
    contract_spec: dict[str, float | int | str],
    reference_price: float,
    requested_notional_usd: float,
) -> float:
    if quantity <= 0:
        return 0.0
    size_step = _to_float(contract_spec.get("size_step"), 0.0)
    quantity_precision = int(contract_spec.get("quantity_precision") or 0)
    min_quantity = max(_to_float(contract_spec.get("trade_min_quantity"), 0.0), size_step)
    min_notional_quantity = 0.0
    min_notional_usd = _to_float(contract_spec.get("trade_min_usdt"), 0.0)
    if reference_price > 0 and min_notional_usd > 0:
        min_notional_quantity = min_notional_usd / max(reference_price, 1e-9)
    minimum_quantity = max(min_quantity, min_notional_quantity)
    if size_step > 0:
        minimum_quantity = _step_ceil(minimum_quantity, size_step)
        floor_quantity = _step_floor(quantity, size_step)
        ceil_quantity = _step_ceil(quantity, size_step)
        candidates = []
        if floor_quantity >= minimum_quantity > 0:
            candidates.append(floor_quantity)
        if ceil_quantity >= minimum_quantity > 0:
            candidates.append(ceil_quantity)
        if not candidates:
            candidates.append(max(minimum_quantity, size_step or quantity))
        resolved = min(candidates, key=lambda candidate: (abs(candidate - quantity), candidate))
    else:
        resolved = max(quantity, minimum_quantity)
        resolved = _round_to_precision(resolved, quantity_precision)
    if size_step <= 0:
        return resolved
    return _round_to_precision(resolved, quantity_precision)


def _bingx_minimum_quantity(contract_spec: dict[str, float | int | str], reference_price: float) -> float:
    size_step = _to_float(contract_spec.get("size_step"), 0.0)
    min_quantity = max(_to_float(contract_spec.get("trade_min_quantity"), 0.0), size_step)
    min_notional_usd = _to_float(contract_spec.get("trade_min_usdt"), 0.0)
    min_notional_quantity = 0.0
    if reference_price > 0 and min_notional_usd > 0:
        min_notional_quantity = min_notional_usd / max(reference_price, 1e-9)
    minimum_quantity = max(min_quantity, min_notional_quantity)
    if size_step > 0:
        minimum_quantity = _step_ceil(minimum_quantity, size_step)
    quantity_precision = int(contract_spec.get("quantity_precision") or 0)
    return _round_to_precision(minimum_quantity, quantity_precision)


async def _bingx_submit_order(
    *,
    secret_payload: dict,
    params: dict[str, str],
    contract_spec: dict[str, float | int | str],
    reference_price: float,
    auto_sized_quantity: bool,
    telemetry: dict,
) -> object:
    current_params = dict(params)
    size_step = _to_float(contract_spec.get("size_step"), 0.0)
    quantity_precision = int(contract_spec.get("quantity_precision") or 0)
    minimum_quantity = _bingx_minimum_quantity(contract_spec, reference_price)
    telemetry.setdefault("attempts", [])
    telemetry.setdefault("fallbacks", [])
    while True:
        current_quantity = _to_float(current_params.get("quantity"), 0.0)
        telemetry["attempts"].append(
            {
                "quantity": _json_number(current_quantity),
                "position_side": str(current_params.get("positionSide") or ""),
            }
        )
        try:
            telemetry["submitted_quantity"] = _json_number(current_quantity)
            return await _bingx_signed_request(secret_payload, "POST", "/openApi/swap/v2/trade/order", current_params)
        except RuntimeError as exc:
            error_text = str(exc).lower()
            can_step_down = auto_sized_quantity and size_step > 0 and current_quantity - size_step >= max(minimum_quantity, size_step)
            if can_step_down and "insufficient margin" in error_text:
                next_quantity = _round_to_precision(current_quantity - size_step, quantity_precision)
                if not telemetry.get("margin_snapshot"):
                    try:
                        telemetry["margin_snapshot"] = await _bingx_margin_snapshot(secret_payload)
                    except Exception:
                        telemetry["margin_snapshot_error"] = "unavailable"
                telemetry["degraded"] = True
                telemetry["degradation_reason"] = "insufficient_margin_step_down"
                telemetry["fallbacks"].append(
                    {
                        "reason": "insufficient_margin",
                        "from_quantity": _json_number(current_quantity),
                        "to_quantity": _json_number(next_quantity),
                    }
                )
                current_params["quantity"] = _format_decimal(next_quantity)
                continue
            telemetry["final_error"] = str(exc)
            raise


def _bingx_status(raw_status: object) -> str:
    status = str(raw_status or "").strip().upper()
    if status in {"FILLED", "FULLY_FILLED"}:
        return "filled"
    if status in {"PARTIALLY_FILLED", "PARTIAL_FILLED", "PARTIALLYFILLED"}:
        return "partially_filled"
    if status in {"CANCELED", "CANCELLED", "EXPIRED", "PENDING_CANCEL"}:
        return "cancelled"
    if status in {"FAILED", "REJECTED"}:
        return "rejected"
    if status in {"NEW", "PENDING", "OPEN", "CREATED", "TRIGGERED"}:
        return "open"
    return "unknown"


def _bingx_order_snapshot(payload: dict, *, symbol: str, side: str, requested_notional_usd: float) -> dict:
    order_payload = payload.get("order") if isinstance(payload.get("order"), dict) else payload
    if not isinstance(order_payload, dict):
        order_payload = {}
    avg_fill_price = _to_float(order_payload.get("avgPrice") or order_payload.get("price") or order_payload.get("avgFilledPrice"), 0.0)
    executed_qty = _to_float(order_payload.get("executedQty") or order_payload.get("cumFilledQty") or order_payload.get("dealVolume"), 0.0)
    filled_notional_usd = _to_float(order_payload.get("cumQuote") or order_payload.get("cumFilledValue") or order_payload.get("dealTurnover"), 0.0)
    if filled_notional_usd <= 0 and executed_qty > 0 and avg_fill_price > 0:
        filled_notional_usd = executed_qty * avg_fill_price
    order_id = str(order_payload.get("orderId") or order_payload.get("orderID") or order_payload.get("id") or "").strip()
    client_order_id = str(order_payload.get("clientOrderId") or order_payload.get("clientOrderID") or "").strip()
    raw_status = str(order_payload.get("status") or order_payload.get("orderStatus") or order_payload.get("state") or "").strip()
    normalized_status = _bingx_status(raw_status)
    fills: list[dict] = []
    if executed_qty > 0 and avg_fill_price > 0:
        fills.append(
            {
                "fill_id": order_id or client_order_id or f"fill-{int(time.time() * 1000)}",
                "venue": "bingx",
                "instrument": _canonical_instrument(symbol),
                "price": avg_fill_price,
                "size_base": executed_qty,
                "notional_usd": filled_notional_usd,
                "fill_type": "live-broker",
                "fill_latency_ms": 0,
                "filled_at": _now_iso(),
            }
        )
    return {
        "provider": "bingx",
        "venue": "bingx",
        "order_id": order_id,
        "client_order_id": client_order_id,
        "status": normalized_status,
        "raw_status": raw_status,
        "instrument": _canonical_instrument(symbol),
        "side": side,
        "requested_notional_usd": requested_notional_usd,
        "filled_notional_usd": filled_notional_usd,
        "avg_fill_price": avg_fill_price,
        "fills": fills,
        "raw_order": payload,
    }


async def _bingx_query_order(secret_payload: dict, symbol: str, order_id: str | None, client_order_id: str | None, requested_notional_usd: float, side: str) -> dict | None:
    params: dict[str, str] = {"symbol": _normalize_bingx_symbol(symbol)}
    if order_id:
        params["orderId"] = order_id
    elif client_order_id:
        params["clientOrderId"] = client_order_id
    else:
        return None
    try:
        order = await _bingx_signed_request(secret_payload, "GET", "/openApi/swap/v2/trade/order", params)
    except Exception:
        return None
    if not isinstance(order, dict):
        return None
    return _bingx_order_snapshot(order, symbol=symbol, side=side, requested_notional_usd=requested_notional_usd)


async def _bingx_place_live_order(payload: dict) -> dict:
    secret_payload = payload.get("secret_payload") if isinstance(payload.get("secret_payload"), dict) else None
    if not isinstance(secret_payload, dict):
        raise ValueError("secret_payload is required for BingX live orders")
    side = str(payload.get("side") or "buy").strip().lower()
    if side not in {"buy", "sell"}:
        raise ValueError("side must be buy or sell")
    symbol = _normalize_bingx_symbol(str(payload.get("symbol") or ""))
    if not symbol:
        raise ValueError("symbol is required")

    order_type = str(payload.get("order_type") or "MARKET").strip().upper()
    requested_notional_usd = _to_float(payload.get("notional_usd"), 0.0)
    contract_spec = await _bingx_contract_spec(symbol)
    params: dict[str, str] = {
        "symbol": symbol,
        "side": "BUY" if side == "buy" else "SELL",
        "type": order_type,
    }
    client_order_id = str(payload.get("client_order_id") or f"txt-{int(time.time() * 1000)}").strip().lower()
    if client_order_id:
        params["clientOrderId"] = client_order_id[:40]

    reduce_only = payload.get("reduce_only")
    if reduce_only is True:
        params["reduceOnly"] = "true"
    position_side = str(payload.get("position_side") or "").strip().upper()
    if position_side not in {"LONG", "SHORT", "BOTH"}:
        position_side = ""
    if not position_side:
        position_side = _default_bingx_position_side(side, bool(reduce_only))
    params["positionSide"] = position_side

    quantity = _to_float(payload.get("quantity"), 0.0)
    quote_order_qty = _to_float(payload.get("quote_order_qty"), requested_notional_usd)
    price = _to_float(payload.get("price"), 0.0)
    auto_sized_quantity = False
    reference_price = 0.0
    requested_quote_notional = quote_order_qty if quote_order_qty > 0 else requested_notional_usd
    sizing_telemetry: dict[str, object] = {
        "symbol": symbol,
        "side": side,
        "order_type": order_type,
        "position_side": position_side,
        "requested_notional_usd": _json_number(requested_notional_usd),
        "requested_quote_notional_usd": _json_number(requested_quote_notional),
        "requested_quantity": _json_number(quantity),
        "auto_sized_quantity": False,
        "reference_price": 0.0,
        "contract": {
            "size_step": _json_number(_to_float(contract_spec.get("size_step"), 0.0)),
            "trade_min_quantity": _json_number(_to_float(contract_spec.get("trade_min_quantity"), 0.0)),
            "trade_min_usdt": _json_number(_to_float(contract_spec.get("trade_min_usdt"), 0.0)),
            "quantity_precision": int(contract_spec.get("quantity_precision") or 0),
            "price_precision": int(contract_spec.get("price_precision") or 0),
        },
        "degraded": False,
        "attempts": [],
        "fallbacks": [],
    }
    if order_type == "MARKET":
        reference_price = await _reference_price_for_market_order(symbol, side)
        sizing_telemetry["reference_price"] = _json_number(reference_price)
        if quantity > 0:
            quantity = _bingx_normalize_quantity(
                quantity,
                contract_spec=contract_spec,
                reference_price=reference_price,
                requested_notional_usd=requested_notional_usd,
            )
            sizing_telemetry["normalized_quantity"] = _json_number(quantity)
            params["quantity"] = _format_decimal(quantity)
        else:
            if reference_price <= 0:
                raise RuntimeError("unable to resolve reference price for BingX market order")
            quantity = requested_quote_notional / max(reference_price, 1e-9)
            sizing_telemetry["auto_sized_quantity"] = True
            sizing_telemetry["raw_auto_quantity"] = _json_number(quantity)
            quantity = _bingx_normalize_quantity(
                quantity,
                contract_spec=contract_spec,
                reference_price=reference_price,
                requested_notional_usd=requested_quote_notional,
            )
            auto_sized_quantity = True
            sizing_telemetry["normalized_quantity"] = _json_number(quantity)
            if quantity <= 0:
                raise ValueError("MARKET orders require notional_usd/quote_order_qty or quantity")
            params["quantity"] = _format_decimal(quantity)
    else:
        if price <= 0:
            raise ValueError("LIMIT-style orders require price")
        price = _bingx_normalize_price(price, contract_spec)
        reference_price = price
        sizing_telemetry["reference_price"] = _json_number(reference_price)
        sizing_telemetry["limit_price"] = _json_number(price)
        if quantity <= 0 and requested_notional_usd > 0:
            quantity = requested_notional_usd / max(price, 1e-9)
            auto_sized_quantity = True
            sizing_telemetry["auto_sized_quantity"] = True
            sizing_telemetry["raw_auto_quantity"] = _json_number(quantity)
        quantity = _bingx_normalize_quantity(
            quantity,
            contract_spec=contract_spec,
            reference_price=price,
            requested_notional_usd=requested_notional_usd,
        )
        sizing_telemetry["normalized_quantity"] = _json_number(quantity)
        if quantity <= 0:
            raise ValueError("LIMIT-style orders require quantity or notional_usd")
        params["price"] = _format_decimal(price)
        params["quantity"] = _format_decimal(quantity)
        params["timeInForce"] = str(payload.get("time_in_force") or "GTC").strip().upper()

    try:
        order = await _bingx_submit_order(
            secret_payload=secret_payload,
            params=params,
            contract_spec=contract_spec,
            reference_price=reference_price,
            auto_sized_quantity=auto_sized_quantity,
            telemetry=sizing_telemetry,
        )
    except RuntimeError as exc:
        error_text = str(exc).lower()
        needs_position_side = "positionside" in error_text and (
            "hedge mode" in error_text or "required" in error_text or "long or short" in error_text
        )
        if position_side in {"", "BOTH"} and needs_position_side:
            retry_params = dict(params)
            retry_params["positionSide"] = _default_bingx_position_side(side, bool(reduce_only))
            sizing_telemetry["position_side"] = retry_params["positionSide"]
            order = await _bingx_submit_order(
                secret_payload=secret_payload,
                params=retry_params,
                contract_spec=contract_spec,
                reference_price=reference_price,
                auto_sized_quantity=auto_sized_quantity,
                telemetry=sizing_telemetry,
            )
        else:
            sizing_telemetry["final_error"] = str(exc)
            setattr(exc, "sizing_telemetry", sizing_telemetry)
            raise
    if not isinstance(order, dict):
        raise RuntimeError("BingX order placement returned an invalid payload")
    snapshot = _bingx_order_snapshot(order, symbol=symbol, side=side, requested_notional_usd=requested_notional_usd)
    queried = await _bingx_query_order(
        secret_payload,
        symbol,
        snapshot.get("order_id"),
        snapshot.get("client_order_id"),
        requested_notional_usd,
        side,
    )
    result = queried or snapshot
    result["sizing"] = sizing_telemetry
    return result


async def _bingx_cancel_live_order(payload: dict) -> dict:
    secret_payload = payload.get("secret_payload") if isinstance(payload.get("secret_payload"), dict) else None
    if not isinstance(secret_payload, dict):
        raise ValueError("secret_payload is required for BingX cancellations")
    side = str(payload.get("side") or "buy").strip().lower()
    symbol = _normalize_bingx_symbol(str(payload.get("symbol") or ""))
    order_id = str(payload.get("order_id") or "").strip()
    client_order_id = str(payload.get("client_order_id") or "").strip()
    if not symbol:
        raise ValueError("symbol is required")
    if not order_id and not client_order_id:
        raise ValueError("order_id or client_order_id is required")
    params: dict[str, str] = {"symbol": symbol}
    if order_id:
        params["orderId"] = order_id
    if client_order_id:
        params["clientOrderId"] = client_order_id

    cancelled = await _bingx_signed_request(secret_payload, "DELETE", "/openApi/swap/v2/trade/order", params)
    snapshot = _bingx_order_snapshot(
        cancelled if isinstance(cancelled, dict) else {},
        symbol=symbol,
        side=side,
        requested_notional_usd=_to_float(payload.get("notional_usd"), 0.0),
    )
    queried = await _bingx_query_order(
        secret_payload,
        symbol,
        order_id or snapshot.get("order_id"),
        client_order_id or snapshot.get("client_order_id"),
        _to_float(payload.get("notional_usd"), 0.0),
        side,
    )
    result = queried or snapshot
    result["cancel_ack"] = cancelled
    if result.get("status") == "unknown":
        result["status"] = "cancelled"
    return result


def _binance_sign(params: dict[str, str]) -> str:
    query = urlencode(params)
    return hmac.new(REAL_BROKER_API_SECRET.encode(), query.encode(), hashlib.sha256).hexdigest()


@app.on_event("startup")
async def startup() -> None:
    ensure_schema()


@app.get("/health")
async def health() -> dict:
    real_status = "degraded"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            if REAL_BROKER_PROVIDER == "bingx":
                response = await client.get(f"{BINGX_API_BASE_URL}/openApi/swap/v2/quote/contracts")
            else:
                response = await client.get(f"{REAL_BROKER_BASE_URL}/api/v3/ping")
            if response.status_code == 200:
                real_status = "ok"
    except Exception:
        real_status = "degraded"
    return {
        "status": "ok",
        "service": "broker-adapter",
        "mode": "hybrid",
        "real_broker": REAL_BROKER_BASE_URL,
        "provider": REAL_BROKER_PROVIDER,
        "real_status": real_status,
        "credentialed": bool(REAL_BROKER_API_KEY and REAL_BROKER_API_SECRET),
        "capabilities": ["balance", "positions", "orderbook", "bingx-live-orders"],
    }


@app.get("/v1/balance")
async def balance() -> dict:
    if REAL_BROKER_PROVIDER == "binance" and REAL_BROKER_API_KEY and REAL_BROKER_API_SECRET:
        params = {
            "timestamp": str(int(time.time() * 1000)),
            "recvWindow": "5000",
        }
        signature = _binance_sign(params)
        params["signature"] = signature
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                f"{REAL_BROKER_BASE_URL}/api/v3/account",
                params=params,
                headers={"X-MBX-APIKEY": REAL_BROKER_API_KEY},
            )
        if response.status_code == 200:
            data = response.json()
            balances = [
                {
                    "currency": item["asset"],
                    "free": float(item["free"]),
                    "locked": float(item["locked"]),
                }
                for item in data.get("balances", [])
                if float(item.get("free", 0)) > 0 or float(item.get("locked", 0)) > 0
            ]
            return {
                "mode": "read-only",
                "provider": "binance",
                "source": "real-credentialed",
                "can_trade": data.get("canTrade", False),
                "can_withdraw": data.get("canWithdraw", False),
                "balances": balances,
            }

    return {
        "mode": "read-only",
        "provider": "paper",
        "source": "mock",
        "balances": [
            {"currency": "USD", "free": 100000.0, "locked": 0.0},
            {"currency": "USDT", "free": 25000.0, "locked": 0.0}
        ]
    }


@app.get("/v1/positions")
async def positions() -> list[dict]:
    return fetch_all(
        """
        SELECT instrument,
               SUM(CASE WHEN side = 'buy' THEN filled_notional_usd ELSE -filled_notional_usd END) AS net_notional_usd,
               MAX(created_at) AS updated_at
        FROM orders
        GROUP BY instrument
        ORDER BY instrument
        """
    )


@app.get("/v1/orderbook/{venue}/{instrument}")
async def orderbook(venue: str, instrument: str) -> dict:
    symbol = instrument.replace("-", "").replace("/", "").upper()
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(f"{REAL_BROKER_BASE_URL}/api/v3/ticker/bookTicker", params={"symbol": symbol})
        if response.status_code == 200:
            data = response.json()
            return {
                "venue": "binance-public",
                "instrument": symbol,
                "bid": float(data["bidPrice"]),
                "ask": float(data["askPrice"]),
                "source": "real-read-only",
            }
    except Exception:
        pass

    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.get(f"{MARKET_DATA_URL}/v1/quotes")
    for item in response.json():
        if item["venue"] == venue and item["instrument"] == instrument:
            return {"venue": venue, "instrument": instrument, "bid": item["bid"], "ask": item["ask"], "last": item["last"], "source": "paper-fallback"}
    return {"venue": venue, "instrument": instrument, "status": "unknown", "source": "none"}


@app.post("/v1/live/orders")
async def place_live_order(payload: dict) -> dict:
    provider = str(payload.get("provider") or "").strip().lower()
    if provider != "bingx":
        raise HTTPException(status_code=400, detail="unsupported live provider")
    try:
        return await _bingx_place_live_order(payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        sizing_telemetry = getattr(exc, "sizing_telemetry", None)
        if isinstance(sizing_telemetry, dict):
            raise HTTPException(
                status_code=502,
                detail={
                    "error": str(exc),
                    "sizing": sizing_telemetry,
                },
            ) from exc
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.post("/v1/live/orders/cancel")
async def cancel_live_order(payload: dict) -> dict:
    provider = str(payload.get("provider") or "").strip().lower()
    if provider != "bingx":
        raise HTTPException(status_code=400, detail="unsupported live provider")
    try:
        return await _bingx_cancel_live_order(payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
