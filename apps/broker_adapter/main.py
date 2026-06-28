from __future__ import annotations

from decimal import Decimal, InvalidOperation
from datetime import datetime, timezone
import hashlib
import hmac
import json
import math
import os
import time
from urllib.parse import urlencode

import httpx
from fastapi import FastAPI, HTTPException

from shared.db import ensure_schema, fetch_all
from shared.models import TradeProtectionRequest

app = FastAPI(title="Broker Adapter", version="0.1.0")

MARKET_DATA_URL = os.getenv("MARKET_DATA_URL", "http://127.0.0.1:8003")
REAL_BROKER_BASE_URL = os.getenv("REAL_BROKER_BASE_URL", "https://api.binance.com")
REAL_BROKER_PROVIDER = os.getenv("REAL_BROKER_PROVIDER", "binance")
REAL_BROKER_API_KEY = os.getenv("REAL_BROKER_API_KEY", "")
REAL_BROKER_API_SECRET = os.getenv("REAL_BROKER_API_SECRET", "")
BINGX_API_BASE_URL = os.getenv("BINGX_API_BASE_URL", "https://open-api.bingx.com").rstrip("/")
BYBIT_API_BASE_URL = os.getenv("BYBIT_API_BASE_URL", "https://api.bybit.com").rstrip("/")


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


def _precision_digits(value: object) -> int:
    raw = str(value or "").strip()
    if not raw:
        return 0
    try:
        exponent = Decimal(raw).normalize().as_tuple().exponent
        return max(0, -exponent)
    except (InvalidOperation, ValueError):
        rendered = f"{_to_float(value, 0.0):.16f}".rstrip("0")
        if "." in rendered:
            return len(rendered.split(".", 1)[1])
        return 0


def _bybit_timestamp_to_iso(value: object) -> str:
    timestamp_ms = _to_float(value, 0.0)
    if timestamp_ms <= 0:
        return _now_iso()
    return datetime.fromtimestamp(timestamp_ms / 1000.0, tz=timezone.utc).isoformat()


def _default_bingx_position_side(side: str, reduce_only: bool) -> str:
    if reduce_only:
        return "SHORT" if side == "buy" else "LONG"
    return "LONG" if side == "buy" else "SHORT"


def _normalize_bingx_working_type(value: object) -> str:
    raw = str(value or "MARK_PRICE").strip().upper()
    return raw if raw in {"MARK_PRICE", "CONTRACT_PRICE"} else "MARK_PRICE"


def _normalize_trade_protection_request(payload: object) -> dict[str, object]:
    if not isinstance(payload, dict) or not payload:
        return {}
    try:
        normalized = TradeProtectionRequest.model_validate(payload).model_dump(mode="json", exclude_none=True)
    except Exception as exc:
        raise ValueError(f"invalid protection request: {exc}") from exc
    if not isinstance(normalized.get("take_profit"), dict) and not isinstance(normalized.get("stop_loss"), dict):
        raise ValueError("protection requires take_profit or stop_loss")
    return normalized


def _requested_protection_leg_count(protection: dict[str, object] | None) -> int:
    if not isinstance(protection, dict):
        return 0
    return sum(1 for key in ("take_profit", "stop_loss") if isinstance(protection.get(key), dict))


def _build_bingx_attached_protection_params(
    protection: dict[str, object],
    *,
    side: str,
    reference_price: float,
) -> dict[str, str]:
    if not isinstance(protection, dict) or not protection:
        return {}

    def _validate_leg(name: str, trigger_price: float) -> None:
        if trigger_price <= 0:
            raise ValueError(f"{name} trigger_price must be > 0")
        if reference_price <= 0:
            return
        if side == "buy":
            if name == "take_profit" and trigger_price <= reference_price:
                raise ValueError("take_profit trigger_price must be above the live reference price for buy orders")
            if name == "stop_loss" and trigger_price >= reference_price:
                raise ValueError("stop_loss trigger_price must be below the live reference price for buy orders")
        else:
            if name == "take_profit" and trigger_price >= reference_price:
                raise ValueError("take_profit trigger_price must be below the live reference price for sell orders")
            if name == "stop_loss" and trigger_price <= reference_price:
                raise ValueError("stop_loss trigger_price must be above the live reference price for sell orders")

    payloads: dict[str, str] = {}
    mapping = {
        "take_profit": ("takeProfit", "TAKE_PROFIT_MARKET", "TAKE_PROFIT"),
        "stop_loss": ("stopLoss", "STOP_MARKET", "STOP"),
    }
    for request_key, (param_key, market_type, limit_type) in mapping.items():
        leg = protection.get(request_key)
        if not isinstance(leg, dict):
            continue
        trigger_price = _to_float(leg.get("trigger_price"), 0.0)
        _validate_leg(request_key, trigger_price)
        order_type = str(leg.get("order_type") or "market").strip().lower()
        # BingX parses the TP/SL leg JSON with typed fields: stopPrice/price must
        # be JSON NUMBERS (float64), not quoted strings — a quoted value is
        # rejected with "Mismatch type float64 with value string". Use _json_number
        # so json.dumps emits a bare number; type/workingType stay string enums.
        payload: dict[str, object] = {
            "type": market_type if order_type != "limit" else limit_type,
            "stopPrice": _json_number(trigger_price),
            "workingType": _normalize_bingx_working_type(leg.get("working_type")),
        }
        if order_type == "limit":
            limit_price = _to_float(leg.get("limit_price"), 0.0)
            if limit_price <= 0:
                raise ValueError(f"{request_key} limit order requires limit_price")
            payload["price"] = _json_number(limit_price)
        payloads[param_key] = json.dumps(payload, separators=(",", ":"))
    return payloads


def _extract_bingx_returned_protection_leg(raw_leg: object, *, entrust_price: object = None) -> dict[str, object] | None:
    if not isinstance(raw_leg, dict):
        return None
    venue_order_type = str(raw_leg.get("type") or "").strip().upper()
    trigger_price = _to_float(raw_leg.get("stopPrice"), 0.0)
    limit_price = _to_float(raw_leg.get("price"), _to_float(entrust_price, 0.0))
    if trigger_price <= 0 and limit_price <= 0 and not venue_order_type:
        return None
    normalized: dict[str, object] = {
        "order_type": "limit" if venue_order_type in {"TAKE_PROFIT", "STOP"} or limit_price > 0 else "market",
        "working_type": _normalize_bingx_working_type(raw_leg.get("workingType")),
        "venue_order_type": venue_order_type,
    }
    if trigger_price > 0:
        normalized["trigger_price"] = _json_number(trigger_price)
    if limit_price > 0:
        normalized["limit_price"] = _json_number(limit_price)
    return normalized


def _resolve_protection_state(requested: dict[str, object] | None, accepted: dict[str, object] | None) -> tuple[str, dict[str, object]]:
    requested_payload = requested if isinstance(requested, dict) else {}
    requested_count = _requested_protection_leg_count(requested_payload)
    if requested_count <= 0:
        return "not_requested", {}

    accepted_payload = accepted if isinstance(accepted, dict) else {}
    accepted_count = _requested_protection_leg_count(accepted_payload)
    missing: list[str] = []
    for key in ("take_profit", "stop_loss"):
        if isinstance(requested_payload.get(key), dict) and not isinstance(accepted_payload.get(key), dict):
            missing.append(key)
    status = "armed" if accepted_count >= requested_count else "protection_partial" if accepted_count > 0 else "protection_rejected"
    protection_state: dict[str, object] = {
        "mode": "native_attached",
        "status": status,
        "require_full_acceptance": bool(requested_payload.get("require_full_acceptance", True)),
        "requested": requested_payload,
        "accepted": accepted_payload,
        "reasons": [f"{name} was not acknowledged by BingX" for name in missing],
    }
    return status, protection_state


def _normalize_dry_run_accepted_legs(raw_value: object, requested: dict[str, object]) -> list[str]:
    requested_names = [name for name in ("take_profit", "stop_loss") if isinstance(requested.get(name), dict)]
    if not requested_names:
        return []
    if raw_value is None:
        return list(requested_names)
    if isinstance(raw_value, str):
        value = raw_value.strip().lower()
        if value in {"", "auto", "all"}:
            return list(requested_names)
        if value == "none":
            return []
        tokens = [part.strip().lower() for part in value.split(",") if part.strip()]
    elif isinstance(raw_value, (list, tuple, set)):
        tokens = [str(part or "").strip().lower() for part in raw_value]
    else:
        tokens = []
    normalized: list[str] = []
    for token in tokens:
        if token in {"tp", "take-profit", "take_profit"}:
            token = "take_profit"
        elif token in {"sl", "stop-loss", "stop_loss"}:
            token = "stop_loss"
        if token in requested_names and token not in normalized:
            normalized.append(token)
    return normalized


def _build_dry_run_accepted_protection(requested: dict[str, object], accepted_legs: list[str]) -> dict[str, object]:
    accepted: dict[str, object] = {}
    for leg_name in accepted_legs:
        leg = requested.get(leg_name)
        if isinstance(leg, dict):
            accepted[leg_name] = dict(leg)
    return accepted


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


def _symbol_assets(symbol: str) -> tuple[str, str]:
    normalized = _normalize_bingx_symbol(symbol)
    if "-" in normalized:
        base_asset, quote_asset = normalized.split("-", 1)
        return base_asset, quote_asset
    return normalized, ""


def _normalize_bybit_symbol(symbol: str) -> str:
    raw = str(symbol or "").strip().upper().replace("/", "").replace("-", "")
    for suffix in ("PERP", "SWAP"):
        if raw.endswith(suffix):
            raw = raw[: -len(suffix)]
            break
    return raw


def _bybit_category(symbol: str) -> str:
    normalized = _normalize_bybit_symbol(symbol)
    return "linear" if normalized.endswith(("USDT", "USDC")) else "spot"


def _default_bybit_position_idx(position_side: str, reduce_only: bool) -> int:
    normalized = str(position_side or "").strip().upper()
    if normalized == "LONG":
        return 1
    if normalized == "SHORT":
        return 2
    return 0 if not reduce_only else 0


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
    # BingX verifies the HMAC over the RAW (url-decoded) sorted "key=value&..."
    # string — exactly as their official SDK signs it — NOT the percent-encoded
    # form. For simple values raw == encoded so this is a no-op, but native TP/SL
    # legs are JSON strings whose `{ } " : ,` get percent-encoded by urlencode
    # (`%7B%22...`); signing that encoded form diverges from what BingX recomputes
    # after url-decoding, which it rejects as "signature mismatch". Sign the raw
    # canonical string; transport the url-encoded values (BingX decodes before
    # verifying, so the two round-trip back to the same raw payload).
    signing_payload = "&".join(f"{key}={value}" for key, value in sorted(query.items()))
    signature = hmac.new(api_secret.encode("utf-8"), signing_payload.encode("utf-8"), hashlib.sha256).hexdigest()
    query_string = urlencode(sorted(query.items()))
    url = f"{BINGX_API_BASE_URL}{path}?{query_string}&signature={signature}"
    # Flag-gated canonical-signature diagnostic. NEVER logs the secret, the full
    # signature, the full api_key, or auth headers — only the canonical query
    # shape so a signature mismatch can be compared at the byte/param level.
    if os.getenv("BINGX_SIGNING_DIAGNOSTICS") == "1":
        _ts = int(query.get("timestamp", "0") or 0)
        _age = int(time.time() * 1000) - _ts
        print(
            f"[SIGN_DIAG] method={method.upper()} path={path} keys={sorted(query.keys())} "
            f"sp_len={len(signing_payload)} sp_sha12={hashlib.sha256(signing_payload.encode()).hexdigest()[:12]} "
            f"cq_len={len(query_string)} cq_sha12={hashlib.sha256(query_string.encode()).hexdigest()[:12]} "
            f"ts_age_ms={_age} recvWindow={query.get('recvWindow')} key_sfx={api_key[-6:]}",
            flush=True,
        )
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


def _unwrap_bybit_response(path: str, body: object) -> object:
    if not isinstance(body, dict):
        raise RuntimeError(f"Bybit {path} returned an invalid payload")
    ret_code = body.get("retCode")
    if ret_code not in {None, 0, "0"}:
        detail = str(body.get("retMsg") or body.get("retExtInfo") or "unknown error")
        raise RuntimeError(f"Bybit {path} rejected the request: {detail}")
    result = body.get("result")
    if isinstance(result, (dict, list)):
        return result
    return body


async def _bybit_public_get(path: str, params: dict | None = None) -> object:
    query = {
        str(key): str(value)
        for key, value in (params or {}).items()
        if value is not None and str(value).strip()
    }
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(f"{BYBIT_API_BASE_URL}{path}", params=query)
    except httpx.HTTPError as exc:
        raise RuntimeError(f"Bybit {path} public request failed: {str(exc)[:300]}") from exc
    if response.status_code >= 400:
        raise RuntimeError(f"Bybit {path} public request failed with status {response.status_code}: {response.text[:300]}")
    try:
        body = response.json()
    except ValueError as exc:
        raise RuntimeError(f"Bybit {path} returned invalid JSON") from exc
    return _unwrap_bybit_response(path, body)


async def _bybit_signed_request(secret_payload: dict, method: str, path: str, params: dict | None = None, body: dict | None = None) -> object:
    api_key = str(secret_payload.get("api_key") or "").strip()
    api_secret = str(secret_payload.get("api_secret") or "").strip()
    if not api_key or not api_secret:
        raise ValueError("Bybit live trading requires an API key and secret")
    recv_window = str(secret_payload.get("recv_window") or "5000")
    timestamp = str(int(time.time() * 1000))
    query = {
        str(key): str(value)
        for key, value in (params or {}).items()
        if value is not None and str(value).strip()
    }
    body_payload = {
        str(key): value
        for key, value in (body or {}).items()
        if value is not None and (not isinstance(value, str) or value.strip())
    }
    query_string = urlencode(sorted(query.items()))
    body_string = json.dumps(body_payload, separators=(",", ":"), ensure_ascii=True)
    payload_to_sign = f"{timestamp}{api_key}{recv_window}{query_string if method.upper() == 'GET' else body_string}"
    signature = hmac.new(api_secret.encode("utf-8"), payload_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()
    headers = {
        "X-BAPI-API-KEY": api_key,
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-RECV-WINDOW": recv_window,
        "X-BAPI-SIGN": signature,
    }
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            response = await client.request(
                method.upper(),
                f"{BYBIT_API_BASE_URL}{path}",
                params=query if method.upper() == "GET" else None,
                json=body_payload if method.upper() != "GET" else None,
                headers=headers,
            )
    except httpx.HTTPError as exc:
        raise RuntimeError(f"Bybit {path} request failed: {str(exc)[:300]}") from exc
    if response.status_code >= 400:
        raise RuntimeError(f"Bybit {path} failed with status {response.status_code}: {response.text[:300]}")
    try:
        body_result = response.json()
    except ValueError as exc:
        raise RuntimeError(f"Bybit {path} returned invalid JSON") from exc
    return _unwrap_bybit_response(path, body_result)


async def _bybit_instrument_spec(symbol: str) -> dict[str, float | int | str]:
    normalized = _normalize_bybit_symbol(symbol)
    category = _bybit_category(symbol)
    payload = await _bybit_public_get("/v5/market/instruments-info", {"category": category, "symbol": normalized})
    rows = payload.get("list") if isinstance(payload, dict) else None
    item = rows[0] if isinstance(rows, list) and rows else None
    if not isinstance(item, dict):
        return {}
    lot_filter = item.get("lotSizeFilter") if isinstance(item.get("lotSizeFilter"), dict) else {}
    price_filter = item.get("priceFilter") if isinstance(item.get("priceFilter"), dict) else {}
    base_precision = max(
        _precision_digits(lot_filter.get("qtyStep")),
        _precision_digits(item.get("basePrecision")),
        0,
    )
    qty_step = _to_float(lot_filter.get("qtyStep") or lot_filter.get("basePrecision"), 0.0)
    min_qty = _to_float(lot_filter.get("minOrderQty"), 0.0)
    max_qty = _to_float(lot_filter.get("maxOrderQty"), 0.0)
    max_market_qty = _to_float(lot_filter.get("maxMktOrderQty") or lot_filter.get("maxOrderQty"), 0.0)
    min_notional = _to_float(lot_filter.get("minNotionalValue"), 0.0)
    tick_size = _to_float(price_filter.get("tickSize"), 0.0)
    min_price = _to_float(price_filter.get("minPrice"), 0.0)
    max_price = _to_float(price_filter.get("maxPrice"), 0.0)
    price_precision = max(_precision_digits(price_filter.get("tickSize")), int(_to_float(item.get("priceScale"), 0.0)), 0)
    return {
        "symbol": normalized,
        "category": category,
        "qty_step": qty_step,
        "min_qty": min_qty,
        "max_qty": max_qty,
        "max_market_qty": max_market_qty,
        "min_notional": min_notional,
        "price_precision": price_precision,
        "base_precision": base_precision,
        "tick_size": tick_size,
        "min_price": min_price,
        "max_price": max_price,
    }


def _bybit_normalize_price(price: float, instrument_spec: dict[str, float | int | str]) -> float:
    if price <= 0:
        return 0.0
    tick_size = _to_float(instrument_spec.get("tick_size"), 0.0)
    price_precision = int(instrument_spec.get("price_precision") or 0)
    min_price = _to_float(instrument_spec.get("min_price"), 0.0)
    max_price = _to_float(instrument_spec.get("max_price"), 0.0)
    if min_price > 0:
        price = max(price, min_price)
    if max_price > 0:
        price = min(price, max_price)
    if tick_size > 0:
        return _round_to_precision(_step_floor(price, tick_size), price_precision)
    return _round_to_precision(price, price_precision)


def _bybit_normalize_quantity(quantity: float, instrument_spec: dict[str, float | int | str], reference_price: float, requested_notional_usd: float) -> float:
    if quantity <= 0:
        return 0.0
    qty_step = _to_float(instrument_spec.get("qty_step"), 0.0)
    min_qty = max(_to_float(instrument_spec.get("min_qty"), 0.0), qty_step)
    max_qty = _to_float(instrument_spec.get("max_market_qty"), 0.0)
    if max_qty <= 0:
        max_qty = _to_float(instrument_spec.get("max_qty"), 0.0)
    min_notional = _to_float(instrument_spec.get("min_notional"), 0.0)
    min_notional_qty = min_notional / max(reference_price, 1e-9) if reference_price > 0 and min_notional > 0 else 0.0
    minimum_quantity = max(min_qty, min_notional_qty)
    base_precision = int(instrument_spec.get("base_precision") or 0)
    if qty_step > 0:
        quantity = _step_floor(quantity, qty_step)
        if quantity < minimum_quantity:
            quantity = _step_ceil(max(minimum_quantity, requested_notional_usd / max(reference_price, 1e-9) if reference_price > 0 else minimum_quantity), qty_step)
    else:
        quantity = max(quantity, minimum_quantity)
    if max_qty > 0:
        quantity = min(quantity, _step_floor(max_qty, qty_step) if qty_step > 0 else max_qty)
    return _round_to_precision(quantity, base_precision)


def _bybit_status(raw_status: object) -> str:
    status = str(raw_status or "").strip().upper()
    if status in {"FILLED", "FULLYFILLED", "PARTIALLYFILLED"}:
        return "filled" if status == "FILLED" or status == "FULLYFILLED" else "partially_filled"
    if status in {"CANCELLED", "CANCELED", "DEACTIVATED", "REJECTED", "FAILED"}:
        return "cancelled" if "CANCEL" in status or status == "DEACTIVATED" else "rejected"
    if status in {"NEW", "CREATED", "UNTRIGGERED", "PARTIALLYFILLEDCANCELED"}:
        return "open"
    return "unknown"


def _bybit_fill_from_execution(execution: dict, *, symbol: str, fallback_fill_id: str) -> dict | None:
    exec_price = _to_float(execution.get("execPrice") or execution.get("price"), 0.0)
    exec_qty = _to_float(execution.get("execQty") or execution.get("qty"), 0.0)
    if exec_price <= 0 or exec_qty <= 0:
        return None
    exec_value = _to_float(execution.get("execValue"), exec_price * exec_qty)
    return {
        "fill_id": str(execution.get("execId") or fallback_fill_id),
        "venue": "bybit",
        "instrument": _canonical_instrument(symbol),
        "price": exec_price,
        "size_base": exec_qty,
        "notional_usd": exec_value,
        "fill_type": "live-broker",
        "fill_latency_ms": 0,
        "filled_at": _bybit_timestamp_to_iso(execution.get("execTime") or execution.get("updatedTime") or execution.get("createdTime")),
    }


def _bybit_order_snapshot(payload: dict, *, symbol: str, side: str, requested_notional_usd: float, executions: list[dict] | None = None) -> dict:
    avg_fill_price = _to_float(payload.get("avgPrice") or payload.get("price"), 0.0)
    requested_qty = _to_float(payload.get("qty"), 0.0)
    executed_qty = _to_float(payload.get("cumExecQty"), 0.0)
    if executed_qty <= 0:
        executed_qty = requested_qty if _bybit_status(payload.get("orderStatus") or payload.get("status")) == "filled" else 0.0
    filled_notional_usd = _to_float(payload.get("cumExecValue"), 0.0)
    if filled_notional_usd <= 0 and executed_qty > 0 and avg_fill_price > 0:
        filled_notional_usd = executed_qty * avg_fill_price
    order_id = str(payload.get("orderId") or "").strip()
    client_order_id = str(payload.get("orderLinkId") or "").strip()
    raw_status = str(payload.get("orderStatus") or payload.get("status") or "").strip()
    normalized_status = _bybit_status(raw_status)
    fills: list[dict] = []
    if isinstance(executions, list):
        for index, execution in enumerate(executions):
            if not isinstance(execution, dict):
                continue
            fill = _bybit_fill_from_execution(execution, symbol=symbol, fallback_fill_id=f"{order_id or client_order_id or 'fill'}-{index}")
            if fill:
                fills.append(fill)
    if not fills and executed_qty > 0 and avg_fill_price > 0:
        fills.append(
            {
                "fill_id": order_id or client_order_id or f"fill-{int(time.time() * 1000)}",
                "venue": "bybit",
                "instrument": _canonical_instrument(symbol),
                "price": avg_fill_price,
                "size_base": executed_qty,
                "notional_usd": filled_notional_usd,
                "fill_type": "live-broker",
                "fill_latency_ms": 0,
                "filled_at": _bybit_timestamp_to_iso(payload.get("updatedTime") or payload.get("createdTime")),
            }
        )
    if fills:
        executed_qty = sum(_to_float(fill.get("size_base"), 0.0) for fill in fills)
        filled_notional_usd = sum(_to_float(fill.get("notional_usd"), 0.0) for fill in fills)
        if avg_fill_price <= 0 and executed_qty > 0:
            avg_fill_price = filled_notional_usd / max(executed_qty, 1e-9)
    return {
        "provider": "bybit",
        "venue": "bybit",
        "order_id": order_id,
        "client_order_id": client_order_id,
        "status": normalized_status,
        "raw_status": raw_status,
        "instrument": _canonical_instrument(symbol),
        "side": side,
        "order_type": str(payload.get("orderType") or "").strip().lower(),
        "requested_notional_usd": requested_notional_usd,
        "requested_quantity": requested_qty,
        "filled_quantity": executed_qty,
        "filled_notional_usd": filled_notional_usd,
        "avg_fill_price": avg_fill_price,
        "limit_price": _to_float(payload.get("price"), 0.0),
        "created_at": _bybit_timestamp_to_iso(payload.get("createdTime")),
        "updated_at": _bybit_timestamp_to_iso(payload.get("updatedTime") or payload.get("createdTime")),
        "fills": fills,
        "raw_order": payload,
    }


async def _bybit_query_order(secret_payload: dict, symbol: str, order_id: str | None, client_order_id: str | None, requested_notional_usd: float, side: str) -> dict | None:
    if not order_id and not client_order_id:
        return None
    params = {"category": _bybit_category(symbol), "symbol": _normalize_bybit_symbol(symbol)}
    if order_id:
        params["orderId"] = order_id
    if client_order_id:
        params["orderLinkId"] = client_order_id
    item: dict | None = None
    try:
        payload = await _bybit_signed_request(secret_payload, "GET", "/v5/order/realtime", params=params)
    except Exception:
        payload = None
    rows = payload.get("list") if isinstance(payload, dict) else None
    item = rows[0] if isinstance(rows, list) and rows else None
    if not isinstance(item, dict):
        try:
            payload = await _bybit_signed_request(secret_payload, "GET", "/v5/order/history", params=params)
        except Exception:
            payload = None
        rows = payload.get("list") if isinstance(payload, dict) else None
        item = rows[0] if isinstance(rows, list) and rows else None
    if not isinstance(item, dict):
        return None
    executions: list[dict] = []
    execution_params = {"category": _bybit_category(symbol), "symbol": _normalize_bybit_symbol(symbol), "limit": 50}
    if order_id:
        execution_params["orderId"] = order_id
    if client_order_id:
        execution_params["orderLinkId"] = client_order_id
    try:
        execution_payload = await _bybit_signed_request(secret_payload, "GET", "/v5/execution/list", params=execution_params)
    except Exception:
        execution_payload = None
    execution_rows = execution_payload.get("list") if isinstance(execution_payload, dict) else None
    if isinstance(execution_rows, list):
        executions = [row for row in execution_rows if isinstance(row, dict)]
    return _bybit_order_snapshot(item, symbol=symbol, side=side, requested_notional_usd=requested_notional_usd, executions=executions)


async def _bybit_place_live_order(payload: dict) -> dict:
    secret_payload = payload.get("secret_payload") if isinstance(payload.get("secret_payload"), dict) else None
    if not isinstance(secret_payload, dict):
        raise ValueError("secret_payload is required for Bybit live orders")
    side = str(payload.get("side") or "buy").strip().lower()
    if side not in {"buy", "sell"}:
        raise ValueError("side must be buy or sell")
    symbol = _normalize_bybit_symbol(str(payload.get("symbol") or ""))
    if not symbol:
        raise ValueError("symbol is required")
    order_type = str(payload.get("order_type") or "MARKET").strip().upper()
    requested_notional_usd = _to_float(payload.get("notional_usd"), 0.0)
    quantity = _to_float(payload.get("quantity"), 0.0)
    price = _to_float(payload.get("price"), 0.0)
    instrument_spec = await _bybit_instrument_spec(symbol)
    category = str(instrument_spec.get("category") or _bybit_category(symbol))
    reference_price = await _reference_price_for_market_order(symbol, side)
    sizing_reference_price = price if price > 0 else reference_price
    if quantity <= 0:
        if requested_notional_usd <= 0 or reference_price <= 0:
            raise ValueError("Bybit live orders require quantity or notional_usd with a valid reference price")
        quantity = requested_notional_usd / max(reference_price, 1e-9)
    quantity = _bybit_normalize_quantity(quantity, instrument_spec, sizing_reference_price, requested_notional_usd)
    if quantity <= 0:
        raise ValueError("normalized Bybit quantity is zero")
    max_allowed_qty = _to_float(instrument_spec.get("max_market_qty" if order_type == "MARKET" else "max_qty"), 0.0)
    if max_allowed_qty > 0 and quantity > max_allowed_qty:
        raise ValueError(f"normalized Bybit quantity {quantity} exceeds instrument limit {max_allowed_qty}")
    body: dict[str, object] = {
        "category": category,
        "symbol": symbol,
        "side": "Buy" if side == "buy" else "Sell",
        "orderType": "Market" if order_type == "MARKET" else "Limit",
        "qty": _format_decimal(quantity, max(2, int(instrument_spec.get("base_precision") or 8))),
        "orderLinkId": str(payload.get("client_order_id") or f"txt-{int(time.time() * 1000)}")[:36],
        "reduceOnly": bool(payload.get("reduce_only", False)),
    }
    position_idx = _default_bybit_position_idx(str(payload.get("position_side") or ""), bool(payload.get("reduce_only", False)))
    if category == "linear" and position_idx > 0:
        body["positionIdx"] = position_idx
    if order_type != "MARKET":
        if price <= 0:
            raise ValueError("LIMIT-style orders require price")
        normalized_price = _bybit_normalize_price(price, instrument_spec)
        if normalized_price <= 0:
            raise ValueError("normalized Bybit price is zero")
        body["price"] = _format_decimal(normalized_price, max(2, int(instrument_spec.get("price_precision") or 8)))
        body["timeInForce"] = str(payload.get("time_in_force") or "GTC").strip().upper()
    order = await _bybit_signed_request(secret_payload, "POST", "/v5/order/create", body=body)
    if not isinstance(order, dict):
        raise RuntimeError("Bybit order placement returned an invalid payload")
    snapshot = _bybit_order_snapshot(order, symbol=symbol, side=side, requested_notional_usd=requested_notional_usd)
    queried = await _bybit_query_order(secret_payload, symbol, snapshot.get("order_id"), snapshot.get("client_order_id"), requested_notional_usd, side)
    return queried or snapshot


async def _bybit_cancel_live_order(payload: dict) -> dict:
    secret_payload = payload.get("secret_payload") if isinstance(payload.get("secret_payload"), dict) else None
    if not isinstance(secret_payload, dict):
        raise ValueError("secret_payload is required for Bybit cancellations")
    symbol = _normalize_bybit_symbol(str(payload.get("symbol") or ""))
    if not symbol:
        raise ValueError("symbol is required")
    order_id = str(payload.get("order_id") or "").strip()
    client_order_id = str(payload.get("client_order_id") or "").strip()
    if not order_id and not client_order_id:
        raise ValueError("order_id or client_order_id is required")
    body: dict[str, object] = {"category": _bybit_category(symbol), "symbol": symbol}
    if order_id:
        body["orderId"] = order_id
    if client_order_id:
        body["orderLinkId"] = client_order_id
    cancelled = await _bybit_signed_request(secret_payload, "POST", "/v5/order/cancel", body=body)
    if not isinstance(cancelled, dict):
        raise RuntimeError("Bybit cancel returned an invalid payload")
    side = str(payload.get("side") or "buy").strip().lower()
    queried = await _bybit_query_order(secret_payload, symbol, str(cancelled.get("orderId") or order_id), str(cancelled.get("orderLinkId") or client_order_id), _to_float(payload.get("notional_usd"), 0.0), side)
    result = queried or _bybit_order_snapshot(cancelled, symbol=symbol, side=side, requested_notional_usd=_to_float(payload.get("notional_usd"), 0.0))
    result["cancel_ack"] = cancelled
    if result.get("status") == "unknown":
        result["status"] = "cancelled"
    return result


async def _bybit_live_order_status(payload: dict) -> dict:
    secret_payload = payload.get("secret_payload") if isinstance(payload.get("secret_payload"), dict) else None
    if not isinstance(secret_payload, dict):
        raise ValueError("secret_payload is required for Bybit order status")
    symbol = _normalize_bybit_symbol(str(payload.get("symbol") or ""))
    if not symbol:
        raise ValueError("symbol is required")
    order_id = str(payload.get("order_id") or "").strip()
    client_order_id = str(payload.get("client_order_id") or "").strip()
    if not order_id and not client_order_id:
        raise ValueError("order_id or client_order_id is required")
    result = await _bybit_query_order(
        secret_payload,
        symbol,
        order_id or None,
        client_order_id or None,
        _to_float(payload.get("notional_usd"), 0.0),
        str(payload.get("side") or "buy").strip().lower(),
    )
    if not isinstance(result, dict):
        raise RuntimeError("Bybit order not found")
    return result


async def _bybit_amend_live_order(payload: dict) -> dict:
    secret_payload = payload.get("secret_payload") if isinstance(payload.get("secret_payload"), dict) else None
    if not isinstance(secret_payload, dict):
        raise ValueError("secret_payload is required for Bybit amendments")
    side = str(payload.get("side") or "buy").strip().lower()
    symbol = _normalize_bybit_symbol(str(payload.get("symbol") or ""))
    if not symbol:
        raise ValueError("symbol is required")
    order_id = str(payload.get("order_id") or "").strip()
    client_order_id = str(payload.get("client_order_id") or "").strip()
    if not order_id and not client_order_id:
        raise ValueError("order_id or client_order_id is required")
    body: dict[str, object] = {"category": _bybit_category(symbol), "symbol": symbol}
    if order_id:
        body["orderId"] = order_id
    if client_order_id:
        body["orderLinkId"] = client_order_id
    price = _to_float(payload.get("price"), 0.0)
    quantity = _to_float(payload.get("quantity"), 0.0)
    if price <= 0 and quantity <= 0:
        raise ValueError("price or quantity is required for amendment")
    instrument_spec = await _bybit_instrument_spec(symbol)
    if price > 0:
        normalized_price = _bybit_normalize_price(price, instrument_spec)
        if normalized_price <= 0:
            raise ValueError("normalized Bybit price is zero")
        body["price"] = _format_decimal(normalized_price, max(2, int(instrument_spec.get("price_precision") or 8)))
    if quantity > 0:
        normalized_quantity = _bybit_normalize_quantity(quantity, instrument_spec, price if price > 0 else _to_float(payload.get("reference_price"), 0.0), _to_float(payload.get("notional_usd"), 0.0))
        if normalized_quantity <= 0:
            raise ValueError("normalized Bybit quantity is zero")
        body["qty"] = _format_decimal(normalized_quantity, max(2, int(instrument_spec.get("base_precision") or 8)))
    amended = await _bybit_signed_request(secret_payload, "POST", "/v5/order/amend", body=body)
    if not isinstance(amended, dict):
        raise RuntimeError("Bybit amend returned an invalid payload")
    queried = await _bybit_query_order(
        secret_payload,
        symbol,
        str(amended.get("orderId") or order_id),
        str(amended.get("orderLinkId") or client_order_id),
        _to_float(payload.get("notional_usd"), 0.0),
        side,
    )
    if not isinstance(queried, dict):
        raise RuntimeError("Bybit amended order could not be reloaded")
    queried["amend_ack"] = amended
    queried["modify_supported"] = True
    return queried


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


def _bingx_minimum_executable_notional_usd(contract_spec: dict[str, float | int | str], reference_price: float) -> float:
    minimum_quantity = _bingx_minimum_quantity(contract_spec, reference_price)
    if minimum_quantity <= 0 or reference_price <= 0:
        return 0.0
    return minimum_quantity * reference_price


def _resolve_notional_adjustment(
    requested_notional_usd: float,
    min_notional_usd: float,
    *,
    auto_adjust_enabled: bool,
) -> dict[str, object]:
    requested = max(0.0, requested_notional_usd)
    minimum = max(0.0, min_notional_usd)
    supports_requested = requested <= 0 or minimum <= requested + 1e-9
    applied = bool(auto_adjust_enabled and requested > 0 and minimum > requested + 1e-9)
    effective = minimum if applied else requested
    return {
        "enabled": bool(auto_adjust_enabled),
        "applied": applied,
        "requested_notional_usd": _json_number(requested),
        "adjusted_notional_usd": _json_number(effective),
        "min_notional_usd": _json_number(minimum),
        "supports_requested_notional": supports_requested,
        "supports_auto_adjusted_notional": requested <= 0 or supports_requested or applied,
        "reason": "venue_min_notional" if applied else "none",
    }


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


def _bingx_order_trace(payload: object, *, parser_branch: str) -> dict[str, object]:
    order_payload = payload.get("order") if isinstance(payload, dict) and isinstance(payload.get("order"), dict) else payload
    if not isinstance(order_payload, dict):
        order_payload = {}
    data = payload.get("data") if isinstance(payload, dict) else None
    return {
        "parser_branch": parser_branch,
        "payload_type": type(payload).__name__,
        "payload_keys": sorted([str(key) for key in payload.keys()]) if isinstance(payload, dict) else [],
        "data_type": type(data).__name__ if data is not None else None,
        "order_payload_keys": sorted([str(key) for key in order_payload.keys()]),
        "bingx_code": payload.get("code") if isinstance(payload, dict) else None,
        "bingx_msg": payload.get("msg") or payload.get("message") if isinstance(payload, dict) else None,
        "order_id": str(order_payload.get("orderId") or order_payload.get("orderID") or order_payload.get("id") or "").strip(),
        "order_id_numeric_seen": order_payload.get("orderId") is not None or order_payload.get("id") is not None,
        "order_id_string_seen": order_payload.get("orderID") is not None,
        "client_order_id": str(order_payload.get("clientOrderId") or order_payload.get("clientOrderID") or "").strip(),
        "raw_status": str(order_payload.get("status") or order_payload.get("orderStatus") or order_payload.get("state") or "").strip(),
    }


def _bingx_extract_items(payload: object, *keys: str) -> list[dict]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if not isinstance(payload, dict):
        return []
    for key in keys:
        value = payload.get(key)
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
    for value in payload.values():
        nested = _bingx_extract_items(value, *keys) if isinstance(value, (dict, list)) else []
        if nested:
            return nested
    return []


def _bingx_position_amount(position: dict) -> float:
    for key in ("positionAmt", "positionAmount", "availableAmt", "holdVolume", "position"):
        amount = _to_float(position.get(key), 0.0)
        if abs(amount) > 0:
            return amount
    return 0.0


async def _bingx_reconcile_flat_truth(secret_payload: dict, symbol: str) -> dict[str, object]:
    normalized_symbol = _normalize_bingx_symbol(symbol)
    truth: dict[str, object] = {
        "status": "indeterminate_hard_fail",
        "symbol": normalized_symbol,
        "open_positions": None,
        "open_orders": None,
        "errors": [],
    }
    try:
        positions_payload = await _bingx_signed_request(
            secret_payload,
            "GET",
            "/openApi/swap/v2/user/positions",
            {"symbol": normalized_symbol},
        )
        positions = _bingx_extract_items(positions_payload, "positions", "data", "list")
        open_positions = [
            item for item in positions
            if abs(_bingx_position_amount(item)) > 1e-12
        ]
        truth["open_positions"] = len(open_positions)
    except Exception as exc:
        truth["errors"].append({"stage": "positions", "class": type(exc).__name__, "message": str(exc)[:240]})

    try:
        orders_payload = await _bingx_signed_request(
            secret_payload,
            "GET",
            "/openApi/swap/v2/trade/openOrders",
            {"symbol": normalized_symbol},
        )
        open_orders = _bingx_extract_items(orders_payload, "orders", "data", "list")
        truth["open_orders"] = len(open_orders)
    except Exception as exc:
        truth["errors"].append({"stage": "open_orders", "class": type(exc).__name__, "message": str(exc)[:240]})

    if truth.get("open_positions") == 0 and truth.get("open_orders") == 0:
        truth["status"] = "no_order_found_confirmed_flat"
    return truth


def _bingx_order_snapshot(
    payload: dict,
    *,
    symbol: str,
    side: str,
    requested_notional_usd: float,
    requested_protection: dict[str, object] | None = None,
) -> dict:
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
    parser_branch = "order_wrapped" if isinstance(payload.get("order"), dict) else "direct_payload"
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
    accepted_protection: dict[str, object] = {}
    take_profit = _extract_bingx_returned_protection_leg(
        order_payload.get("takeProfit"),
        entrust_price=order_payload.get("takeProfitEntrustPrice"),
    )
    stop_loss = _extract_bingx_returned_protection_leg(
        order_payload.get("stopLoss"),
        entrust_price=order_payload.get("stopLossEntrustPrice"),
    )
    if take_profit is not None:
        accepted_protection["take_profit"] = take_profit
    if stop_loss is not None:
        accepted_protection["stop_loss"] = stop_loss
    protection_status, protection_state = _resolve_protection_state(requested_protection, accepted_protection)
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
        "protection_status": protection_status,
        "protection": protection_state,
        "fills": fills,
        "raw_order": payload,
        "reconciliation": {
            "final_classification": normalized_status,
            "trace": _bingx_order_trace(payload, parser_branch=parser_branch),
        },
    }


async def _bingx_query_order(
    secret_payload: dict,
    symbol: str,
    order_id: str | None,
    client_order_id: str | None,
    requested_notional_usd: float,
    side: str,
    requested_protection: dict[str, object] | None = None,
) -> dict | None:
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
    return _bingx_order_snapshot(
        order,
        symbol=symbol,
        side=side,
        requested_notional_usd=requested_notional_usd,
        requested_protection=requested_protection,
    )


async def _bingx_place_live_order(payload: dict) -> dict:
    dry_run = bool(payload.get("dry_run"))
    auto_adjust_notional = bool(payload.get("auto_adjust_notional"))
    secret_payload = payload.get("secret_payload") if isinstance(payload.get("secret_payload"), dict) else None
    if not dry_run and not isinstance(secret_payload, dict):
        raise ValueError("secret_payload is required for BingX live orders")
    side = str(payload.get("side") or "buy").strip().lower()
    if side not in {"buy", "sell"}:
        raise ValueError("side must be buy or sell")
    symbol = _normalize_bingx_symbol(str(payload.get("symbol") or ""))
    if not symbol:
        raise ValueError("symbol is required")

    order_type = str(payload.get("order_type") or "MARKET").strip().upper()
    requested_notional_usd = _to_float(payload.get("notional_usd"), 0.0)
    requested_protection = _normalize_trade_protection_request(payload.get("protection")) if isinstance(payload.get("protection"), dict) and payload.get("protection") else {}
    dry_run_accepted_legs = _normalize_dry_run_accepted_legs(payload.get("dry_run_accepted_legs"), requested_protection)
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
    effective_requested_notional_usd = requested_quote_notional
    sizing_telemetry: dict[str, object] = {
        "symbol": symbol,
        "side": side,
        "order_type": order_type,
        "position_side": position_side,
        "requested_notional_usd": _json_number(requested_notional_usd),
        "requested_quote_notional_usd": _json_number(requested_quote_notional),
        "effective_requested_notional_usd": _json_number(requested_quote_notional),
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

    def _resolve_effective_notional(minimum_reference_price: float) -> float:
        nonlocal effective_requested_notional_usd, requested_quote_notional
        if requested_quote_notional <= 0 or minimum_reference_price <= 0:
            return requested_quote_notional
        minimum_notional_usd = _bingx_minimum_executable_notional_usd(contract_spec, minimum_reference_price)
        sizing_telemetry["minimum_executable_notional_usd"] = _json_number(minimum_notional_usd)
        adjustment = _resolve_notional_adjustment(
            requested_quote_notional,
            minimum_notional_usd,
            auto_adjust_enabled=auto_adjust_notional,
        )
        sizing_telemetry["auto_adjustment"] = adjustment
        if not bool(adjustment.get("supports_auto_adjusted_notional")):
            raise ValueError(
                "requested notional is below BingX minimum executable size "
                f"({minimum_notional_usd:.6f} USD required, {requested_quote_notional:.6f} USD requested)"
            )
        effective_requested_notional_usd = _to_float(adjustment.get("adjusted_notional_usd"), requested_quote_notional)
        requested_quote_notional = effective_requested_notional_usd
        sizing_telemetry["effective_requested_notional_usd"] = _json_number(effective_requested_notional_usd)
        return effective_requested_notional_usd

    if order_type == "MARKET":
        reference_price = await _reference_price_for_market_order(symbol, side)
        sizing_telemetry["reference_price"] = _json_number(reference_price)
        _resolve_effective_notional(reference_price)
        if quantity > 0:
            quantity = _bingx_normalize_quantity(
                quantity,
                contract_spec=contract_spec,
                reference_price=reference_price,
                requested_notional_usd=effective_requested_notional_usd,
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
        _resolve_effective_notional(price)
        if quantity <= 0 and requested_notional_usd > 0:
            quantity = effective_requested_notional_usd / max(price, 1e-9)
            auto_sized_quantity = True
            sizing_telemetry["auto_sized_quantity"] = True
            sizing_telemetry["raw_auto_quantity"] = _json_number(quantity)
        quantity = _bingx_normalize_quantity(
            quantity,
            contract_spec=contract_spec,
            reference_price=price,
            requested_notional_usd=effective_requested_notional_usd,
        )
        sizing_telemetry["normalized_quantity"] = _json_number(quantity)
        if quantity <= 0:
            raise ValueError("LIMIT-style orders require quantity or notional_usd")
        params["price"] = _format_decimal(price)
        params["quantity"] = _format_decimal(quantity)
        params["timeInForce"] = str(payload.get("time_in_force") or "GTC").strip().upper()

    if requested_protection:
        params.update(
            _build_bingx_attached_protection_params(
                requested_protection,
                side=side,
                reference_price=reference_price,
            )
        )

    if dry_run:
        accepted_protection = _build_dry_run_accepted_protection(requested_protection, dry_run_accepted_legs)
        protection_status, protection_state = _resolve_protection_state(requested_protection, accepted_protection)
        return {
            "provider": "bingx",
            "venue": "bingx",
            "order_id": f"dry-run-{client_order_id or int(time.time() * 1000)}",
            "client_order_id": client_order_id,
            "status": "dry_run",
            "raw_status": "DRY_RUN",
            "instrument": _canonical_instrument(symbol),
            "side": side,
            "requested_notional_usd": effective_requested_notional_usd,
            "filled_notional_usd": 0.0,
            "avg_fill_price": 0.0,
            "protection_status": protection_status,
            "protection": protection_state,
            "fills": [],
            "sizing": sizing_telemetry,
            "dry_run": {
                "request": {
                    "symbol": symbol,
                    "side": side,
                    "order_type": order_type,
                    "position_side": position_side,
                    "time_in_force": params.get("timeInForce"),
                    "price": _json_number(price) if price > 0 else None,
                    "quantity": _json_number(quantity) if quantity > 0 else None,
                    "notional_usd": _json_number(effective_requested_notional_usd),
                },
                "accepted_legs": dry_run_accepted_legs,
                "request_params": {key: value for key, value in params.items() if key not in {"apiKey", "timestamp", "signature"}},
            },
        }

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
    snapshot = _bingx_order_snapshot(
        order,
        symbol=symbol,
        side=side,
        requested_notional_usd=effective_requested_notional_usd,
        requested_protection=requested_protection,
    )
    queried = await _bingx_query_order(
        secret_payload,
        symbol,
        snapshot.get("order_id"),
        snapshot.get("client_order_id"),
        effective_requested_notional_usd,
        side,
        requested_protection,
    )
    result = queried or snapshot
    if result.get("status") == "unknown" and not result.get("fills"):
        flat_truth = await _bingx_reconcile_flat_truth(secret_payload, symbol)
        reconciliation = result.get("reconciliation") if isinstance(result.get("reconciliation"), dict) else {}
        reconciliation["flat_truth"] = flat_truth
        if flat_truth.get("status") == "no_order_found_confirmed_flat":
            result["status"] = "no_order_found_confirmed_flat"
        else:
            result["status"] = "indeterminate_hard_fail"
        reconciliation["final_classification"] = result["status"]
        result["reconciliation"] = reconciliation
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


async def _bingx_live_order_status(payload: dict) -> dict:
    secret_payload = payload.get("secret_payload") if isinstance(payload.get("secret_payload"), dict) else None
    if not isinstance(secret_payload, dict):
        raise ValueError("secret_payload is required for BingX order status")
    side = str(payload.get("side") or "buy").strip().lower()
    symbol = _normalize_bingx_symbol(str(payload.get("symbol") or ""))
    order_id = str(payload.get("order_id") or "").strip()
    client_order_id = str(payload.get("client_order_id") or "").strip()
    if not symbol:
        raise ValueError("symbol is required")
    if not order_id and not client_order_id:
        raise ValueError("order_id or client_order_id is required")
    result = await _bingx_query_order(
        secret_payload,
        symbol,
        order_id or None,
        client_order_id or None,
        _to_float(payload.get("notional_usd"), 0.0),
        side,
    )
    if not isinstance(result, dict):
        raise RuntimeError("BingX order not found")
    return result


def _bingx_close_side_for_position(position_side: str) -> str:
    normalized = str(position_side or "").strip().upper()
    if normalized == "LONG":
        return "sell"
    if normalized == "SHORT":
        return "buy"
    raise ValueError("position_side must be LONG or SHORT for BingX protection amendments")


def _bingx_protection_order_leg_snapshot(
    leg_name: str,
    requested_leg: dict[str, object],
    order_result: dict[str, object] | None,
) -> dict[str, object]:
    snapshot: dict[str, object] = {
        "trigger_price": _json_number(_to_float(requested_leg.get("trigger_price"), 0.0)),
        "order_type": str(requested_leg.get("order_type") or "market").strip().lower() or "market",
        "working_type": _normalize_bingx_working_type(requested_leg.get("working_type")),
        "leg": leg_name,
    }
    limit_price = _to_float(requested_leg.get("limit_price"), 0.0)
    if limit_price > 0:
        snapshot["limit_price"] = _json_number(limit_price)
    if isinstance(order_result, dict):
        order_id = str(order_result.get("order_id") or "").strip()
        client_order_id = str(order_result.get("client_order_id") or "").strip()
        status = str(order_result.get("status") or "").strip().lower()
        if order_id:
            snapshot["order_id"] = order_id
        if client_order_id:
            snapshot["client_order_id"] = client_order_id
        if status:
            snapshot["status"] = status
        raw_order = order_result.get("raw_order") if isinstance(order_result.get("raw_order"), dict) else {}
        created_at = str(raw_order.get("createTime") or raw_order.get("time") or raw_order.get("updateTime") or "").strip()
        if created_at:
            snapshot["as_of"] = created_at
    return snapshot


def _build_bingx_standalone_protection_order_params(
    *,
    symbol: str,
    leg_name: str,
    leg: dict[str, object],
    quantity: float,
    position_side: str,
    close_side: str,
    client_order_id: str,
    contract_spec: dict[str, float | int | str],
) -> dict[str, str]:
    trigger_price = _to_float(leg.get("trigger_price"), 0.0)
    if trigger_price <= 0:
        raise ValueError(f"{leg_name} trigger_price must be > 0")
    normalized_quantity = _bingx_normalize_quantity(
        quantity,
        contract_spec=contract_spec,
        reference_price=trigger_price,
        requested_notional_usd=quantity * trigger_price,
    )
    if normalized_quantity <= 0:
        raise ValueError("normalized BingX protection quantity is zero")
    order_type = str(leg.get("order_type") or "market").strip().lower() or "market"
    params: dict[str, str] = {
        "symbol": _normalize_bingx_symbol(symbol),
        "side": "BUY" if close_side == "buy" else "SELL",
        "positionSide": str(position_side).strip().upper(),
        "quantity": _format_decimal(normalized_quantity),
        "clientOrderId": client_order_id[:40],
        "reduceOnly": "true",
        "stopPrice": _format_decimal(trigger_price),
        "workingType": _normalize_bingx_working_type(leg.get("working_type")),
    }
    if leg_name == "take_profit":
        params["type"] = "TAKE_PROFIT" if order_type == "limit" else "TAKE_PROFIT_MARKET"
    else:
        params["type"] = "STOP" if order_type == "limit" else "STOP_MARKET"
    if order_type == "limit":
        limit_price = _to_float(leg.get("limit_price"), 0.0)
        if limit_price <= 0:
            raise ValueError(f"{leg_name} limit order requires limit_price")
        params["price"] = _format_decimal(_bingx_normalize_price(limit_price, contract_spec))
    return params


def _bingx_leg_request_from_active_protection(leg_name: str, leg: dict[str, object]) -> dict[str, object]:
    trigger_price = _to_float(leg.get("trigger_price"), 0.0)
    if trigger_price <= 0:
        raise ValueError(f"{leg_name} trigger_price must be > 0 for rollback")
    payload: dict[str, object] = {
        "trigger_price": trigger_price,
        "order_type": str(leg.get("order_type") or "market").strip().lower() or "market",
        "working_type": str(leg.get("working_type") or "MARK_PRICE").strip().upper() or "MARK_PRICE",
    }
    limit_price = _to_float(leg.get("limit_price"), 0.0)
    if limit_price > 0:
        payload["limit_price"] = limit_price
    return payload


async def _bingx_amend_live_order(payload: dict) -> dict:
    secret_payload = payload.get("secret_payload") if isinstance(payload.get("secret_payload"), dict) else None
    if not isinstance(secret_payload, dict):
        raise ValueError("secret_payload is required for BingX amendments")
    symbol = _normalize_bingx_symbol(str(payload.get("symbol") or ""))
    if not symbol:
        raise ValueError("symbol is required")
    position_side = str(payload.get("position_side") or "").strip().upper()
    close_side = str(payload.get("side") or "").strip().lower() or _bingx_close_side_for_position(position_side)
    if close_side not in {"buy", "sell"}:
        raise ValueError("side must be buy or sell")
    if position_side not in {"LONG", "SHORT"}:
        if close_side == "sell":
            position_side = "LONG"
        elif close_side == "buy":
            position_side = "SHORT"
    quantity = _to_float(payload.get("quantity"), 0.0)
    if quantity <= 0:
        raise ValueError("quantity is required for BingX protection amendments")
    requested_notional_usd = _to_float(payload.get("notional_usd"), 0.0)
    replacement_protection = _normalize_trade_protection_request(payload.get("protection") or payload.get("replacement_protection"))
    active_protection = payload.get("active_protection") if isinstance(payload.get("active_protection"), dict) else {}

    cancelled_orders: list[dict[str, object]] = []
    cancelled_legs: list[tuple[str, dict[str, object]]] = []
    created_orders: list[dict[str, object]] = []
    accepted_protection: dict[str, object] = {}
    contract_spec = await _bingx_contract_spec(symbol)

    try:
        for leg_name in ("stop_loss", "take_profit"):
            active_leg = active_protection.get(leg_name) if isinstance(active_protection.get(leg_name), dict) else None
            if not isinstance(active_leg, dict):
                continue
            order_id = str(active_leg.get("order_id") or "").strip()
            client_order_id = str(active_leg.get("client_order_id") or "").strip()
            if not order_id and not client_order_id:
                continue
            cancelled_orders.append(
                await _bingx_cancel_live_order(
                    {
                        "secret_payload": secret_payload,
                        "symbol": symbol,
                        "side": close_side,
                        "order_id": order_id,
                        "client_order_id": client_order_id,
                        "notional_usd": requested_notional_usd,
                    }
                )
            )
            cancelled_legs.append((leg_name, active_leg))

        for leg_name in ("stop_loss", "take_profit"):
            requested_leg = replacement_protection.get(leg_name)
            if not isinstance(requested_leg, dict):
                continue
            client_order_id = f"txt-{leg_name[:2]}-{int(time.time() * 1000)}"
            params = _build_bingx_standalone_protection_order_params(
                symbol=symbol,
                leg_name=leg_name,
                leg=requested_leg,
                quantity=quantity,
                position_side=position_side,
                close_side=close_side,
                client_order_id=client_order_id,
                contract_spec=contract_spec,
            )
            created = await _bingx_signed_request(secret_payload, "POST", "/openApi/swap/v2/trade/order", params)
            snapshot = _bingx_order_snapshot(
                created if isinstance(created, dict) else {},
                symbol=symbol,
                side=close_side,
                requested_notional_usd=requested_notional_usd or quantity * _to_float(requested_leg.get("trigger_price"), 0.0),
            )
            queried = await _bingx_query_order(
                secret_payload,
                symbol,
                snapshot.get("order_id"),
                snapshot.get("client_order_id") or client_order_id,
                requested_notional_usd or quantity * _to_float(requested_leg.get("trigger_price"), 0.0),
                close_side,
            )
            result = queried or snapshot
            result["requested_leg"] = leg_name
            created_orders.append(result)
            accepted_protection[leg_name] = _bingx_protection_order_leg_snapshot(leg_name, requested_leg, result)
    except Exception as exc:
        rollback_cancelled_replacements: list[dict[str, object]] = []
        rollback_recreated_orders: list[dict[str, object]] = []
        rollback_errors: list[str] = []

        for created_order in created_orders:
            try:
                rollback_cancelled_replacements.append(
                    await _bingx_cancel_live_order(
                        {
                            "secret_payload": secret_payload,
                            "symbol": symbol,
                            "side": close_side,
                            "order_id": str(created_order.get("order_id") or "").strip(),
                            "client_order_id": str(created_order.get("client_order_id") or "").strip(),
                            "notional_usd": requested_notional_usd,
                        }
                    )
                )
            except Exception as rollback_exc:
                rollback_errors.append(f"cancel_replacement:{rollback_exc}")

        for leg_name, previous_leg in cancelled_legs:
            try:
                previous_request = _bingx_leg_request_from_active_protection(leg_name, previous_leg)
                rollback_client_order_id = f"txt-rb-{leg_name[:2]}-{int(time.time() * 1000)}"
                params = _build_bingx_standalone_protection_order_params(
                    symbol=symbol,
                    leg_name=leg_name,
                    leg=previous_request,
                    quantity=quantity,
                    position_side=position_side,
                    close_side=close_side,
                    client_order_id=rollback_client_order_id,
                    contract_spec=contract_spec,
                )
                recreated = await _bingx_signed_request(secret_payload, "POST", "/openApi/swap/v2/trade/order", params)
                snapshot = _bingx_order_snapshot(
                    recreated if isinstance(recreated, dict) else {},
                    symbol=symbol,
                    side=close_side,
                    requested_notional_usd=requested_notional_usd or quantity * _to_float(previous_request.get("trigger_price"), 0.0),
                )
                queried = await _bingx_query_order(
                    secret_payload,
                    symbol,
                    snapshot.get("order_id"),
                    snapshot.get("client_order_id") or rollback_client_order_id,
                    requested_notional_usd or quantity * _to_float(previous_request.get("trigger_price"), 0.0),
                    close_side,
                )
                rollback_recreated_orders.append((queried or snapshot) if isinstance(queried or snapshot, dict) else snapshot)
            except Exception as rollback_exc:
                rollback_errors.append(f"recreate_original_{leg_name}:{rollback_exc}")

        rollback_state = {
            "status": "rollback_attempted",
            "provider": "bingx",
            "symbol": symbol,
            "position_side": position_side,
            "recommended_action": "cancel_replace_rollback",
            "error": str(exc),
            "cancelled_orders": cancelled_orders,
            "created_orders": created_orders,
            "rollback": {
                "cancelled_replacements": rollback_cancelled_replacements,
                "recreated_original_orders": rollback_recreated_orders,
                "errors": rollback_errors,
                "restored": not rollback_errors,
            },
        }
        error = RuntimeError(
            "BingX protection amend failed after cancellation; rollback attempted"
        )
        setattr(error, "rollback_state", rollback_state)
        raise error from exc

    protection_status, protection_state = _resolve_protection_state(replacement_protection, accepted_protection)
    protection_state["mode"] = "cancel_replace"
    return {
        "provider": "bingx",
        "venue": "bingx",
        "instrument": _canonical_instrument(symbol),
        "symbol": symbol,
        "side": close_side,
        "position_side": position_side,
        "quantity": quantity,
        "requested_notional_usd": requested_notional_usd,
        "status": "replaced" if created_orders else "cancelled",
        "modify_supported": True,
        "protection_status": protection_status,
        "protection": protection_state,
        "cancelled_orders": cancelled_orders,
        "created_orders": created_orders,
    }


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
            elif REAL_BROKER_PROVIDER == "bybit":
                response = await client.get(f"{BYBIT_API_BASE_URL}/v5/market/time")
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
        "capabilities": ["balance", "positions", "orderbook", "bingx-live-orders", "bybit-live-orders"],
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

    if REAL_BROKER_PROVIDER == "bybit" and REAL_BROKER_API_KEY and REAL_BROKER_API_SECRET:
        secret_payload = {"api_key": REAL_BROKER_API_KEY, "api_secret": REAL_BROKER_API_SECRET}
        balance_payload = await _bybit_signed_request(secret_payload, "GET", "/v5/account/wallet-balance", params={"accountType": "UNIFIED"})
        rows = balance_payload.get("list") if isinstance(balance_payload, dict) else None
        item = rows[0] if isinstance(rows, list) and rows else None
        coins = item.get("coin") if isinstance(item, dict) else None
        balances = []
        if isinstance(coins, list):
            for coin in coins:
                if not isinstance(coin, dict):
                    continue
                wallet_balance = _to_float(coin.get("walletBalance"), 0.0)
                locked = _to_float(coin.get("locked"), 0.0)
                if wallet_balance <= 0 and locked <= 0:
                    continue
                balances.append({
                    "currency": str(coin.get("coin") or ""),
                    "free": wallet_balance,
                    "locked": locked,
                })
        return {
            "mode": "read-only",
            "provider": "bybit",
            "source": "real-credentialed",
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
            if venue.startswith("bingx") or REAL_BROKER_PROVIDER == "bingx":
                bingx_symbol = _normalize_bingx_symbol(symbol)
                payload = await _bingx_public_get("/openApi/swap/v2/quote/ticker", {"symbol": bingx_symbol})
                if isinstance(payload, dict):
                    bid = _to_float(payload.get("bidPrice"), 0.0)
                    ask = _to_float(payload.get("askPrice"), 0.0)
                    last = _to_float(payload.get("lastPrice"), (bid + ask) / 2 if bid > 0 and ask > 0 else 0.0)
                    if bid > 0 and ask > 0:
                        return {
                            "venue": "bingx-public",
                            "instrument": bingx_symbol,
                            "bid": bid,
                            "ask": ask,
                            "last": last,
                            "source": "real-read-only",
                        }
            if venue.startswith("bybit") or REAL_BROKER_PROVIDER == "bybit":
                response = await client.get(
                    f"{BYBIT_API_BASE_URL}/v5/market/tickers",
                    params={"category": _bybit_category(symbol), "symbol": _normalize_bybit_symbol(symbol)},
                )
                if response.status_code == 200:
                    data = response.json()
                    result = data.get("result") if isinstance(data, dict) else None
                    rows = result.get("list") if isinstance(result, dict) else None
                    item = rows[0] if isinstance(rows, list) and rows else None
                    if isinstance(item, dict):
                        return {
                            "venue": "bybit-public",
                            "instrument": _normalize_bybit_symbol(symbol),
                            "bid": _to_float(item.get("bid1Price"), 0.0),
                            "ask": _to_float(item.get("ask1Price"), 0.0),
                            "last": _to_float(item.get("lastPrice"), 0.0),
                            "source": "real-read-only",
                        }
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


@app.post("/v1/live/execution-constraints")
async def live_execution_constraints(payload: dict) -> dict:
    provider = str(payload.get("provider") or "").strip().lower()
    if provider != "bingx":
        raise HTTPException(status_code=400, detail="unsupported live provider")

    side = str(payload.get("side") or "buy").strip().lower()
    if side not in {"buy", "sell"}:
        raise HTTPException(status_code=400, detail="side must be buy or sell")

    symbol = _normalize_bingx_symbol(str(payload.get("symbol") or ""))
    if not symbol:
        raise HTTPException(status_code=400, detail="symbol is required")

    contract_spec = await _bingx_contract_spec(symbol)
    if not contract_spec:
        raise HTTPException(status_code=404, detail="instrument contract spec unavailable")

    ticker = await _bingx_public_get("/openApi/swap/v2/quote/ticker", {"symbol": symbol})
    ticker_payload = ticker if isinstance(ticker, dict) else {}
    bid = _to_float(ticker_payload.get("bidPrice"), 0.0)
    ask = _to_float(ticker_payload.get("askPrice"), 0.0)
    last = _to_float(ticker_payload.get("lastPrice"), (bid + ask) / 2.0 if bid > 0 and ask > 0 else 0.0)
    reference_price = ask if side == "buy" else bid
    if reference_price <= 0:
        reference_price = last
    if reference_price <= 0:
        raise HTTPException(status_code=502, detail="reference price unavailable")

    min_quantity = _bingx_minimum_quantity(contract_spec, reference_price)
    min_notional_usd = _bingx_minimum_executable_notional_usd(contract_spec, reference_price)
    requested_notional_usd = _to_float(payload.get("requested_notional_usd") or payload.get("notional_usd"), 0.0)
    notional_adjustment = _resolve_notional_adjustment(
        requested_notional_usd,
        min_notional_usd,
        auto_adjust_enabled=bool(payload.get("auto_adjust_notional")),
    )
    effective_notional_usd = _to_float(notional_adjustment.get("adjusted_notional_usd"), requested_notional_usd if requested_notional_usd > 0 else 0.0)
    supports_requested_notional = bool(notional_adjustment.get("supports_requested_notional"))
    supports_auto_adjusted_notional = bool(notional_adjustment.get("supports_auto_adjusted_notional"))
    requested_protection: dict[str, object] = {}
    protection_state: dict[str, object]
    if isinstance(payload.get("protection"), dict) and payload.get("protection"):
        try:
            requested_protection = _normalize_trade_protection_request(payload.get("protection"))
            _build_bingx_attached_protection_params(requested_protection, side=side, reference_price=reference_price)
            protection_state = {
                "mode": "native_attached",
                "status": "ready_preflight",
                "require_full_acceptance": bool(requested_protection.get("require_full_acceptance", True)),
                "requested": requested_protection,
                "accepted": {},
                "reasons": [],
            }
        except ValueError as exc:
            protection_state = {
                "mode": "native_attached",
                "status": "rejected_preflight",
                "require_full_acceptance": bool(requested_protection.get("require_full_acceptance", True)) if requested_protection else True,
                "requested": requested_protection or payload.get("protection"),
                "accepted": {},
                "reasons": [str(exc)],
            }
    else:
        protection_state = {
            "mode": "native_attached",
            "status": "not_requested",
            "require_full_acceptance": True,
            "requested": {},
            "accepted": {},
            "reasons": [],
        }
    base_asset, quote_asset = _symbol_assets(symbol)
    response = {
        "provider": provider,
        "instrument": _canonical_instrument(symbol),
        "symbol": symbol,
        "side": side,
        "base_asset": base_asset,
        "quote_asset": quote_asset,
        "status": "rejected_preflight" if requested_notional_usd > 0 and not supports_auto_adjusted_notional else "ready_preflight",
        "reference_price": _json_number(reference_price),
        "requested_notional_usd": _json_number(requested_notional_usd),
        "effective_notional_usd": _json_number(effective_notional_usd),
        "min_notional_usd": _json_number(min_notional_usd),
        "min_amount_base": _json_number(min_quantity),
        "size_step": _json_number(_to_float(contract_spec.get("size_step"), 0.0)),
        "trade_min_quantity": _json_number(_to_float(contract_spec.get("trade_min_quantity"), 0.0)),
        "trade_min_usdt": _json_number(_to_float(contract_spec.get("trade_min_usdt"), 0.0)),
        "quantity_precision": int(contract_spec.get("quantity_precision") or 0),
        "price_precision": int(contract_spec.get("price_precision") or 0),
        "supports_requested_notional": supports_requested_notional,
        "supports_auto_adjusted_notional": supports_auto_adjusted_notional,
        "auto_adjustment": notional_adjustment,
        "protection": protection_state,
    }
    if str(protection_state.get("status") or "").strip().lower() == "rejected_preflight" and bool(protection_state.get("require_full_acceptance", True)):
        response["status"] = "rejected_preflight"
    if base_asset:
        response[f"min_amount_{base_asset.lower()}"] = _json_number(min_quantity)
    return response


@app.post("/v1/live/orders")
async def place_live_order(payload: dict) -> dict:
    provider = str(payload.get("provider") or "").strip().lower()
    if provider not in {"bingx", "bybit"}:
        raise HTTPException(status_code=400, detail="unsupported live provider")
    try:
        if provider == "bybit":
            return await _bybit_place_live_order(payload)
        return await _bingx_place_live_order(payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        sizing_telemetry = getattr(exc, "sizing_telemetry", None)
        # Observability: surface the upstream venue error (the RuntimeError text
        # already carries the BingX HTTP status + response body, i.e. retCode/retMsg)
        # plus the order params, so a live-order rejection is no longer a mute 502.
        _order_dbg = {
            key: payload.get(key)
            for key in ("symbol", "side", "position_side", "order_type", "notional_usd", "quantity")
        }
        print(f"[live-order] {provider} live order FAILED: {exc} | request={_order_dbg}", flush=True)
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
    if provider not in {"bingx", "bybit"}:
        raise HTTPException(status_code=400, detail="unsupported live provider")
    try:
        if provider == "bybit":
            return await _bybit_cancel_live_order(payload)
        return await _bingx_cancel_live_order(payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.post("/v1/live/orders/status")
async def live_order_status(payload: dict) -> dict:
    provider = str(payload.get("provider") or "").strip().lower()
    if provider not in {"bingx", "bybit"}:
        raise HTTPException(status_code=400, detail="unsupported live provider")
    try:
        if provider == "bybit":
            return await _bybit_live_order_status(payload)
        return await _bingx_live_order_status(payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.post("/v1/live/orders/amend")
async def amend_live_order(payload: dict) -> dict:
    provider = str(payload.get("provider") or "").strip().lower()
    if provider not in {"bingx", "bybit"}:
        raise HTTPException(status_code=400, detail="unsupported live provider")
    try:
        if provider == "bybit":
            return await _bybit_amend_live_order(payload)
        return await _bingx_amend_live_order(payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        rollback_state = getattr(exc, "rollback_state", None)
        raise HTTPException(status_code=502, detail=rollback_state if isinstance(rollback_state, dict) else str(exc)) from exc
