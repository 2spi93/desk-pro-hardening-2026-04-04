from __future__ import annotations

import asyncio
import base64
import csv
import hashlib
import hmac
import io
import json
import math
import os
from pathlib import Path
import random
import secrets
import time
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlencode
from uuid import uuid4

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, PlainTextResponse

from shared.auth import AuthContext, auth_context_from_token, hash_password, issue_access_token, sign_approval_payload, verify_approval_signature, verify_password
from shared.db import ensure_schema, execute, execute_rowcount, fetch_all, fetch_one, json_dumps
from shared.models import (
    AccountCreateRequest,
    ApprovalRequest,
    AuditEvent,
    ChangePasswordRequest,
    ClientCreateRequest,
    IntentSubmissionRequest,
    IntentSubmissionResponse,
    LoginRequest,
    LoginResponse,
    OrderResult,
    PortfolioAccountAttachRequest,
    PortfolioCreateRequest,
    PortfolioRiskSnapshot,
    PortfolioStateSnapshot,
    RealityGapIngestRequest,
    RiskCheckRequest,
    RiskDecision,
    StrategyCreateRequest,
    StrategyPromotionRequest,
    SystemMode,
    SystemModeChangeRequest,
    UserClientMembershipCreateRequest,
)

app = FastAPI(title="Control Plane", version="0.1.0")

RISK_GATEWAY_URL = os.getenv("RISK_GATEWAY_URL", "http://127.0.0.1:8001")
EXECUTION_ROUTER_URL = os.getenv("EXECUTION_ROUTER_URL", "http://127.0.0.1:8002")
MARKET_DATA_URL = os.getenv("MARKET_DATA_URL", "http://127.0.0.1:8003")
BROKER_ADAPTER_URL = os.getenv("BROKER_ADAPTER_URL", "http://127.0.0.1:8004")
AI_ORCHESTRATOR_URL = os.getenv("AI_ORCHESTRATOR_URL", "http://127.0.0.1:8005")
MT5_BRIDGE_URL = os.getenv("MT5_BRIDGE_URL", "http://127.0.0.1:8006")
BINANCE_API_BASE_URL = os.getenv("BINANCE_API_BASE_URL", "https://api.binance.com").rstrip("/")
BINANCE_FUTURES_API_BASE_URL = os.getenv("BINANCE_FUTURES_API_BASE_URL", "https://fapi.binance.com").rstrip("/")
BINANCE_COINM_API_BASE_URL = os.getenv("BINANCE_COINM_API_BASE_URL", "https://dapi.binance.com").rstrip("/")
BINGX_API_BASE_URL = os.getenv("BINGX_API_BASE_URL", "https://open-api.bingx.com").rstrip("/")
BITGET_API_BASE_URL = os.getenv("BITGET_API_BASE_URL", "https://api.bitget.com").rstrip("/")
OKX_API_BASE_URL = os.getenv("OKX_API_BASE_URL", "https://www.okx.com").rstrip("/")
EMBEDDINGS_SERVICE_URL = os.getenv("EMBEDDINGS_SERVICE_URL", "http://127.0.0.1:8007")
RUST_EXECUTION_ENGINE_URL = os.getenv("RUST_EXECUTION_ENGINE_URL", "http://127.0.0.1:8011")
PREDICTOR_V8_URL = os.getenv("PREDICTOR_V8_URL", "http://127.0.0.1:8008")
PREDICTOR_V8_TIMEOUT_SECONDS = max(1.0, float(os.getenv("PREDICTOR_V8_TIMEOUT_SECONDS", "3.0")))
PREDICTOR_V8_EXPERIENCES_LOG_PATH = Path(os.getenv("PREDICTOR_V8_EXPERIENCES_LOG_PATH", "/workspace/data/predictor_v8/experiences.jsonl"))
LIVE_EXECUTION_POLICY_PATH = Path(os.getenv("LIVE_EXECUTION_POLICY_PATH", "/workspace/config/live_execution_policy.json"))
RUST_EXECUTION_ENGINE_ENABLED = os.getenv("RUST_EXECUTION_ENGINE_ENABLED", "0").strip().lower() in {"1", "true", "yes", "on"}
CURRENT_SYSTEM_MODE = SystemMode(os.getenv("SYSTEM_MODE", SystemMode.SUGGEST.value))

RAW_CASH_ASSETS = {"USD", "USDT", "USDC", "BUSD", "DAI", "FDUSD", "TUSD", "USDE", "PYUSD"}

AUDIT_LOG: list[AuditEvent] = []
PENDING_INTENTS: dict[str, dict] = {}


def _normalize_account_id(value: Any) -> str:
    return str(value or "").strip().lower()


def _upstream_json_payload(response: httpx.Response) -> Any:
    try:
        return response.json()
    except ValueError:
        detail = response.text.strip()
        return {"detail": detail or response.reason_phrase or "upstream returned a non-JSON response"}


def _proxy_json_response(response: httpx.Response) -> JSONResponse:
    return JSONResponse(content=_upstream_json_payload(response), status_code=response.status_code)

CONNECTOR_CATALOG: list[dict[str, str]] = [
    {"name": "binance", "type": "crypto", "transport": "rest/ws", "health_group": "market"},
    {"name": "bybit", "type": "crypto", "transport": "rest/ws", "health_group": "market"},
    {"name": "coinbase", "type": "crypto", "transport": "rest/ws", "health_group": "market"},
    {"name": "kucoin", "type": "crypto", "transport": "rest/ws", "health_group": "market"},
    {"name": "kraken", "type": "crypto", "transport": "rest/ws", "health_group": "market"},
    {"name": "okx", "type": "crypto", "transport": "rest/ws", "health_group": "market"},
    {"name": "bitget", "type": "crypto", "transport": "rest/ws", "health_group": "market"},
    {"name": "bingx", "type": "crypto", "transport": "rest/ws", "health_group": "market"},
    {"name": "mexc", "type": "crypto", "transport": "rest/ws", "health_group": "market"},
    {"name": "gateio", "type": "crypto", "transport": "rest/ws", "health_group": "market"},
    {"name": "hyperliquid", "type": "dex", "transport": "wallet-signing", "health_group": "market"},
    {"name": "dydx", "type": "dex", "transport": "wallet-signing", "health_group": "market"},
    {"name": "pumpfun", "type": "dex", "transport": "wallet-signing", "health_group": "market"},
    {"name": "solana-jupiter", "type": "dex", "transport": "rest/ws", "health_group": "market"},
    {"name": "phantom", "type": "wallet", "transport": "wallet-adapter", "health_group": "broker"},
    {"name": "solana-wallet", "type": "wallet", "transport": "wallet-adapter", "health_group": "broker"},
    {"name": "metamask", "type": "wallet", "transport": "walletconnect", "health_group": "broker"},
    {"name": "rabby", "type": "wallet", "transport": "walletconnect", "health_group": "broker"},
    {"name": "coinbase-wallet", "type": "wallet", "transport": "walletconnect", "health_group": "broker"},
    {"name": "evm-wallet", "type": "wallet", "transport": "walletconnect", "health_group": "broker"},
    {"name": "walletconnect", "type": "wallet", "transport": "walletconnect", "health_group": "broker"},
    {"name": "btc-wallet", "type": "wallet", "transport": "watch-only-or-signing", "health_group": "broker"},
    {"name": "ledger", "type": "wallet", "transport": "hardware-wallet", "health_group": "broker"},
    {"name": "trezor", "type": "wallet", "transport": "hardware-wallet", "health_group": "broker"},
    {"name": "safe", "type": "wallet", "transport": "safe-api", "health_group": "broker"},
    {"name": "fireblocks", "type": "wallet", "transport": "custody-api", "health_group": "broker"},
    {"name": "topstep", "type": "propfirm", "transport": "broker-adapter", "health_group": "broker"},
    {"name": "ftmo", "type": "propfirm", "transport": "broker-adapter", "health_group": "broker"},
    {"name": "sabiotrade", "type": "propfirm", "transport": "broker-adapter", "health_group": "broker"},
    {"name": "ig", "type": "broker", "transport": "broker-adapter", "health_group": "broker"},
    {"name": "tradingview", "type": "charting", "transport": "webhook/ws", "health_group": "broker"},
    {"name": "quantower", "type": "terminal", "transport": "bridge/ws", "health_group": "broker"},
    {"name": "polymarket", "type": "prediction", "transport": "rest", "health_group": "market"},
    {"name": "mt5", "type": "forex-indices", "transport": "bridge", "health_group": "mt5"},
    {"name": "broker-adapter", "type": "execution", "transport": "rest", "health_group": "broker"},
    {"name": "ai-orchestrator", "type": "intelligence", "transport": "rest", "health_group": "ai"},
    {"name": "embeddings-service", "type": "memory", "transport": "rest", "health_group": "embeddings"},
]

OAUTH_PROVIDER_CONFIG: dict[str, dict[str, str]] = {
    "coinbase": {
        "auth_url": "https://www.coinbase.com/oauth/authorize",
        "token_url": "https://api.coinbase.com/oauth/token",
    },
    "kraken": {
        "auth_url": "https://www.kraken.com/oauth/authorize",
        "token_url": "https://api.kraken.com/oauth/token",
    },
    "okx": {
        "auth_url": "https://www.okx.com/oauth/authorize",
        "token_url": "https://www.okx.com/oauth/token",
    },
    "bitget": {
        "auth_url": "https://api.bitget.com/oauth/authorize",
        "token_url": "https://api.bitget.com/oauth/token",
    },
    "bingx": {
        "auth_url": "https://open-api.bingx.com/oauth/authorize",
        "token_url": "https://open-api.bingx.com/oauth/token",
    },
    "ig": {
        "auth_url": "https://api.ig.com/oauth/authorize",
        "token_url": "https://api.ig.com/oauth/token",
    },
}

CONNECTOR_MARKET_OBSERVABILITY_VENUES: dict[str, str] = {
    "binance": "binance-public",
    "bingx": "paper-bingx",
    "bitget": "paper-bitget",
    "bybit": "bybit-public",
    "coinbase": "coinbase-public",
    "okx": "okx-public",
}

CONNECTOR_RATE_LIMIT_HINTS: dict[str, dict[str, Any]] = {
    "binance": {"rest": "1200 req/min", "ws": "100ms depth stream", "burst": "high"},
    "bitget": {"rest": "10 req/s class-dependent", "ws": "private+public multiplex", "burst": "medium"},
    "bingx": {"rest": "class-dependent", "ws": "market stream", "burst": "medium"},
    "bybit": {"rest": "category bucketed", "ws": "public linear/spot", "burst": "high"},
    "coinbase": {"rest": "15 req/s profile-dependent", "ws": "ticker/depth channels", "burst": "medium"},
    "fireblocks": {"rest": "governed custody API", "ws": "n/a", "burst": "low"},
    "hyperliquid": {"rest": "dex api", "ws": "market stream", "burst": "medium"},
    "kraken": {"rest": "tier-based", "ws": "book stream", "burst": "medium"},
    "mt5": {"rest": "bridge-governed", "ws": "bridge telemetry", "burst": "medium"},
    "okx": {"rest": "rate-limit bucketed", "ws": "books5/books50", "burst": "high"},
    "safe": {"rest": "governed multisig API", "ws": "n/a", "burst": "low"},
}

CONNECTOR_REROUTE_HINTS: dict[str, str] = {
    "bingx": "bitget",
    "bitget": "okx",
    "bybit": "binance",
    "coinbase": "binance",
    "kraken": "binance",
    "okx": "binance",
    "mt5": "broker-adapter",
}

EXCHANGE_CAPABILITIES: dict[str, dict[str, Any]] = {
    "okx": {
        "data": True,
        "execution": False,
        "l2": True,
        "l3": True,
        "execution_venue": "paper-okx",
        "api_key_requires_passphrase": True,
    },
    "binance": {
        "data": True,
        "execution": False,
        "l2": True,
        "l3": False,
        "execution_venue": "binance-public",
        "api_key_requires_passphrase": False,
    },
    "bingx": {
        "data": True,
        "execution": True,
        "l2": False,
        "l3": False,
        "execution_venue": "bingx",
        "api_key_requires_passphrase": False,
    },
    "bybit": {
        "data": True,
        "execution": True,
        "l2": True,
        "l3": False,
        "execution_venue": "bybit",
        "api_key_requires_passphrase": False,
    },
    "bitget": {
        "data": True,
        "execution": False,
        "l2": True,
        "l3": False,
        "execution_venue": "paper-bitget",
        "api_key_requires_passphrase": True,
    },
}


def _build_rust_market_snapshot(routing: dict) -> dict:
    candidates = routing.get("candidates") or []
    if not isinstance(candidates, list):
        candidates = []
    total_depth_usd = 0.0
    best_bid = 0.0
    best_ask = 0.0
    best_bid_venue = ""
    best_ask_venue = ""
    midpoints: list[float] = []
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        total_depth_usd += _to_float(candidate.get("available_depth_usd"), 0.0)
        candidate_bid = _to_float(candidate.get("best_bid"), 0.0)
        candidate_ask = _to_float(candidate.get("best_ask"), 0.0)
        candidate_last = _to_float(candidate.get("last"), 0.0)
        if candidate_bid > best_bid:
            best_bid = candidate_bid
            best_bid_venue = str(candidate.get("venue", ""))
        if candidate_ask > 0 and (best_ask <= 0 or candidate_ask < best_ask):
            best_ask = candidate_ask
            best_ask_venue = str(candidate.get("venue", ""))
        midpoint = ((candidate_bid + candidate_ask) / 2.0) if candidate_bid > 0 and candidate_ask > 0 else candidate_last
        if midpoint > 0:
            midpoints.append(midpoint)
    reference_mid = ((best_bid + best_ask) / 2.0) if best_bid > 0 and best_ask > 0 else (sum(midpoints) / len(midpoints) if midpoints else 0.0)
    deviation_bps = ((max(midpoints) - min(midpoints)) / reference_mid * 10000.0) if len(midpoints) >= 2 and reference_mid > 0 else _to_float(routing.get("deviation_bps"), 0.0)
    return {
        "candidate_count": len(candidates),
        "deviation_bps": deviation_bps,
        "total_depth_usd": total_depth_usd,
        "best_bid": best_bid,
        "best_ask": best_ask,
        "buy_venue": best_ask_venue,
        "sell_venue": best_bid_venue,
    }


def _resolve_rust_route_hint(payload: dict, routing: dict) -> dict:
    route_hint = payload.get("route_hint")
    if not isinstance(route_hint, dict):
        return routing

    resolved = dict(routing)
    if isinstance(route_hint.get("best"), dict):
        resolved["best"] = route_hint.get("best")
    if isinstance(route_hint.get("backup"), dict):
        resolved["backup"] = route_hint.get("backup")
    if isinstance(route_hint.get("candidates"), list):
        resolved["candidates"] = [item for item in route_hint.get("candidates") if isinstance(item, dict)]
    if isinstance(route_hint.get("arbitrage"), dict):
        resolved["arbitrage"] = route_hint.get("arbitrage")
    if route_hint.get("deviation_bps") is not None:
        resolved["deviation_bps"] = route_hint.get("deviation_bps")
    if isinstance(route_hint.get("reason"), str):
        resolved["reason"] = route_hint.get("reason")
    if isinstance(route_hint.get("source"), str):
        resolved["source"] = route_hint.get("source")

    candidates = resolved.get("candidates") or []
    if not resolved.get("best") and candidates:
        resolved["best"] = candidates[0]
    if not resolved.get("backup") and len(candidates) > 1:
        resolved["backup"] = candidates[1]
    return resolved


def _resolve_reality_gap_regime_for_execution(payload: dict[str, Any]) -> str:
    metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
    predictor_context = _predictor_context(payload)
    for candidate in (
        payload.get("regime"),
        metadata.get("regime"),
        predictor_context.get("regime"),
        ((metadata.get("predictor_context") if isinstance(metadata.get("predictor_context"), dict) else {}) or {}).get("regime"),
    ):
        value = str(candidate or "").strip().upper()
        if value:
            return value
    return "UNKNOWN"


def _load_reality_gap_profile(venue: str, symbol: str, regime: str) -> dict[str, Any] | None:
    normalized_venue = str(venue or "").strip().lower()
    normalized_symbol = str(symbol or "").strip().upper()
    normalized_regime = str(regime or "UNKNOWN").strip().upper() or "UNKNOWN"
    if not normalized_venue or not normalized_symbol:
        return None
    row = _normalize_db_row(fetch_one(
        """
        SELECT profile_key, venue, symbol, regime, sample_count, calibration, updated_at
        FROM reality_gap_calibration_profiles
        WHERE venue = %s AND symbol = %s AND regime = %s
        LIMIT 1
        """,
        (normalized_venue, normalized_symbol, normalized_regime),
    ))
    if row is None and normalized_regime != "UNKNOWN":
        row = _normalize_db_row(fetch_one(
            """
            SELECT profile_key, venue, symbol, regime, sample_count, calibration, updated_at
            FROM reality_gap_calibration_profiles
            WHERE venue = %s AND symbol = %s AND regime = 'UNKNOWN'
            LIMIT 1
            """,
            (normalized_venue, normalized_symbol),
        ))
    return row


def _apply_reality_gap_profile_to_candidate(candidate: dict[str, Any], profile_row: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    adjusted = dict(candidate)
    calibration = profile_row.get("calibration") if isinstance(profile_row.get("calibration"), dict) else profile_row
    factors = calibration.get("adjustment_factors") if isinstance(calibration.get("adjustment_factors"), dict) else {}
    latency_multiplier = max(0.7, min(3.0, _to_float(factors.get("latency_jitter_multiplier"), 1.0)))
    impact_multiplier = max(0.7, min(3.0, _to_float(factors.get("impact_multiplier"), 1.0)))
    partial_fill_risk_delta = max(0.0, min(0.95, _to_float(factors.get("partial_fill_risk_delta"), 0.0)))
    hidden_liquidity_ratio_delta = max(0.0, min(0.5, _to_float(factors.get("hidden_liquidity_ratio_delta"), 0.0)))
    queue_risk_delta = max(0.0, min(1.0, _to_float(factors.get("queue_risk_delta"), 0.0)))

    adjusted["latency_ms"] = round(max(0.0, _to_float(candidate.get("latency_ms"), 0.0)) * latency_multiplier, 6)
    adjusted["micro_latency_jitter_ms"] = round(max(0.0, _to_float(candidate.get("micro_latency_jitter_ms"), 0.0)) * latency_multiplier, 6)
    adjusted["spread_bps"] = round(max(0.0, _to_float(candidate.get("spread_bps"), 0.0)) * impact_multiplier, 6)
    adjusted["partial_fill_risk"] = round(min(0.99, max(0.0, _to_float(candidate.get("partial_fill_risk"), 0.0) + partial_fill_risk_delta)), 6)
    adjusted["hidden_liquidity_ratio"] = round(min(0.6, max(0.0, _to_float(candidate.get("hidden_liquidity_ratio"), 0.0) + hidden_liquidity_ratio_delta)), 6)
    adjusted["queue_priority_risk"] = round(min(0.99, max(0.0, _to_float(candidate.get("queue_priority_risk"), 0.0) + queue_risk_delta)), 6)
    adjusted["fill_probability"] = round(
        min(
            0.99,
            max(
                0.01,
                _to_float(candidate.get("fill_probability"), 0.0)
                - (partial_fill_risk_delta * 0.35)
                - (queue_risk_delta * 0.08),
            ),
        ),
        6,
    )

    summary = {
        "profile_key": str(profile_row.get("profile_key") or ""),
        "venue": str(profile_row.get("venue") or adjusted.get("venue") or ""),
        "symbol": str(profile_row.get("symbol") or ""),
        "regime": str(profile_row.get("regime") or "UNKNOWN"),
        "sample_count": int(profile_row.get("sample_count") or 0),
        "adjustment_factors": factors,
    }
    adjusted["reality_gap_profile_key"] = summary["profile_key"]
    return adjusted, summary


def _apply_reality_gap_profiles_to_execution(payload: dict[str, Any], routing: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], list[dict[str, Any]]]:
    adjusted_payload = dict(payload)
    adjusted_routing = dict(routing)
    symbol = _normalize_symbol(str(adjusted_payload.get("symbol", "")))
    regime = _resolve_reality_gap_regime_for_execution(adjusted_payload)
    applied_profiles: list[dict[str, Any]] = []

    def _adjust_candidate(row: Any) -> dict[str, Any] | Any:
        if not isinstance(row, dict):
            return row
        venue = str(row.get("venue") or "").strip().lower()
        profile_row = _load_reality_gap_profile(venue, symbol, regime)
        if profile_row is None:
            return dict(row)
        adjusted_row, summary = _apply_reality_gap_profile_to_candidate(row, profile_row)
        applied_profiles.append(summary)
        return adjusted_row

    adjusted_routing["best"] = _adjust_candidate(adjusted_routing.get("best"))
    adjusted_routing["backup"] = _adjust_candidate(adjusted_routing.get("backup"))
    candidates = adjusted_routing.get("candidates") if isinstance(adjusted_routing.get("candidates"), list) else []
    adjusted_routing["candidates"] = [_adjust_candidate(candidate) for candidate in candidates]

    if applied_profiles:
        unique_profiles: dict[str, dict[str, Any]] = {}
        for profile in applied_profiles:
            key = str(profile.get("profile_key") or "")
            if key and key not in unique_profiles:
                unique_profiles[key] = profile
        applied_profiles = list(unique_profiles.values())
        max_latency_multiplier = max(
            max(1.0, _to_float(((profile.get("adjustment_factors") if isinstance(profile.get("adjustment_factors"), dict) else {}) or {}).get("latency_jitter_multiplier"), 1.0))
            for profile in applied_profiles
        )
        metadata = adjusted_payload.get("metadata") if isinstance(adjusted_payload.get("metadata"), dict) else {}
        best_latency_ms = _to_float(((adjusted_routing.get("best") if isinstance(adjusted_routing.get("best"), dict) else {}) or {}).get("latency_ms"), 0.0)
        existing_delay_ms = max(
            0,
            int(
                _to_float(
                    adjusted_payload.get("execution_delay_ms"),
                    _to_float(metadata.get("execution_delay_ms"), 0.0),
                )
            ),
        )
        calibrated_delay_ms = max(existing_delay_ms, min(5000, int(max(0.0, best_latency_ms * max(0.0, max_latency_multiplier - 1.0) * 0.1))))
        if calibrated_delay_ms > 0:
            adjusted_payload["execution_delay_ms"] = calibrated_delay_ms
            metadata["execution_delay_ms"] = calibrated_delay_ms
        metadata["reality_gap_execution_profiles"] = applied_profiles
        metadata["reality_gap_regime"] = regime
        adjusted_payload["metadata"] = metadata
    return adjusted_payload, adjusted_routing, applied_profiles


def _predictor_context(payload: dict) -> dict:
    direct_context = payload.get("predictor_context")
    if isinstance(direct_context, dict):
        return direct_context
    metadata = payload.get("metadata")
    if isinstance(metadata, dict):
        nested_context = metadata.get("predictor_context")
        if isinstance(nested_context, dict):
            return nested_context
    return {}


def _normalize_network_regime(value: Any) -> str:
    normalized = str(value or "").strip().lower()
    if normalized in {"stable", "degraded", "critical"}:
        return normalized
    return "stable"


def _resolve_infra_context(
    predictor_context: dict | None = None,
    *,
    infra_health: Any = None,
    network_regime: Any = None,
) -> dict[str, Any]:
    context = predictor_context if isinstance(predictor_context, dict) else {}
    metrics = context.get("network_metrics") if isinstance(context.get("network_metrics"), dict) else {}
    dns_transient_rate = _to_float(metrics.get("dns_transient_rate"), _to_float(context.get("dns_transient_rate"), 0.0))
    timeout_rate = _to_float(metrics.get("timeout_rate"), _to_float(context.get("timeout_rate"), 0.0))
    degraded_usage_ratio = _to_float(metrics.get("degraded_usage_ratio"), _to_float(context.get("degraded_usage_ratio"), 0.0))
    retry_recovered_ratio = _to_float(metrics.get("retry_recovered_ratio"), _to_float(context.get("retry_recovered_ratio"), 0.0))
    resolved_infra_health = _to_float(infra_health, math.nan)
    if not math.isfinite(resolved_infra_health):
        resolved_infra_health = _to_float(context.get("infra_health"), math.nan)
    if not math.isfinite(resolved_infra_health):
        resolved_infra_health = max(
            0.05,
            min(
                1.0,
                1.0
                - min(dns_transient_rate * 1.15, 0.28)
                - min(timeout_rate * 1.45, 0.34)
                - min(degraded_usage_ratio * 1.9, 0.5)
                - min(retry_recovered_ratio * 0.45, 0.12),
            ),
        )
    resolved_infra_health = max(0.05, min(1.0, resolved_infra_health))
    resolved_network_regime = _normalize_network_regime(network_regime if network_regime is not None else context.get("network_regime"))
    if resolved_network_regime == "stable":
        if resolved_infra_health <= 0.45:
            resolved_network_regime = "critical"
        elif resolved_infra_health <= 0.78:
            resolved_network_regime = "degraded"
    return {
        "infra_health": resolved_infra_health,
        "network_regime": resolved_network_regime,
        "dns_transient_rate": dns_transient_rate,
        "timeout_rate": timeout_rate,
        "degraded_usage_ratio": degraded_usage_ratio,
        "retry_recovered_ratio": retry_recovered_ratio,
    }


def _route_failure_attribution(route_payload: dict | None, infra_context: dict[str, Any]) -> dict[str, Any]:
    route = route_payload if isinstance(route_payload, dict) else {}
    best = route.get("best") if isinstance(route.get("best"), dict) else None
    infra_health = _to_float(infra_context.get("infra_health"), 1.0)
    network_regime = str(infra_context.get("network_regime") or "stable")
    if best is None:
        reasons = ["no_route_candidates"]
        if network_regime != "stable" or infra_health <= 0.78:
            if network_regime != "stable":
                reasons.append(f"network_regime_{network_regime}")
            if infra_health <= 0.78:
                reasons.append("infra_health_degraded")
            return {"failure_source": "infra", "failure_reasons": reasons, "failure_blocking": True}
        return {"failure_source": "market", "failure_reasons": reasons, "failure_blocking": True}

    spread_bps = _to_float(best.get("spread_bps"), 0.0)
    fill_probability = _to_float(best.get("fill_probability"), 0.0)
    available_depth_usd = _to_float(best.get("available_depth_usd"), 0.0)
    freshness_ms = _to_float(best.get("freshness_ms"), 0.0)
    deviation_bps = _to_float(route.get("deviation_bps"), 0.0)

    if network_regime == "critical" or infra_health <= 0.45 or freshness_ms >= 60000.0:
        reasons = []
        if network_regime != "stable":
            reasons.append(f"network_regime_{network_regime}")
        if infra_health <= 0.45:
            reasons.append("infra_health_low")
        if freshness_ms >= 60000.0:
            reasons.append("route_feed_stale")
        return {
            "failure_source": "infra",
            "failure_reasons": reasons or ["infra_degraded"],
            "failure_blocking": freshness_ms >= 180000.0 or infra_health <= 0.35,
        }

    if spread_bps >= 12.0 or fill_probability <= 0.42 or available_depth_usd <= 15000.0:
        reasons = []
        if spread_bps >= 12.0:
            reasons.append("spread_above_12bps")
        if fill_probability <= 0.42:
            reasons.append("fill_probability_low")
        if available_depth_usd <= 15000.0:
            reasons.append("available_depth_thin")
        return {
            "failure_source": "execution",
            "failure_reasons": reasons,
            "failure_blocking": fill_probability <= 0.3,
        }

    if deviation_bps >= 22.0:
        return {
            "failure_source": "market",
            "failure_reasons": ["cross_venue_deviation_high"],
            "failure_blocking": deviation_bps >= 35.0,
        }

    return {"failure_source": None, "failure_reasons": [], "failure_blocking": False}


def _normalize_failure_source(value: Any) -> str | None:
    normalized = str(value or "").strip().lower()
    if normalized in {"market", "infra", "execution"}:
        return normalized
    return None


def _normalize_failure_reasons(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    reasons: list[str] = []
    for item in value:
        candidate = str(item or "").strip()
        if candidate:
            reasons.append(candidate)
    return reasons


REPLAY_AGENT_FAMILY_MAP: dict[str, tuple[str, ...]] = {
    "scalper": ("orderflow",),
    "trend": ("vwap", "regime"),
    "liquidity": ("liquidity",),
    "execution": ("liquidity", "orderflow"),
    "risk": ("regime",),
}

REPLAY_FAILURE_SOURCE_AGENT_LR_PRIORS: dict[str, dict[str, float]] = {
    "infra": {
        "scalper": 0.42,
        "trend": 0.38,
        "liquidity": 0.74,
        "execution": 0.9,
        "risk": 1.0,
    },
    "market": {
        "scalper": 1.16,
        "trend": 1.18,
        "liquidity": 0.98,
        "execution": 0.94,
        "risk": 1.0,
    },
    "execution": {
        "scalper": 0.88,
        "trend": 0.84,
        "liquidity": 1.04,
        "execution": 1.18,
        "risk": 1.0,
    },
}


def _build_replay_failure_summary(rows: list[dict[str, Any]]) -> dict[str, Any]:
    counts = {"market": 0, "infra": 0, "execution": 0}
    blocking_count = 0
    for row in rows:
        source = _normalize_failure_source(row.get("failure_source"))
        if source is not None:
            counts[source] += 1
        if bool(row.get("failure_blocking")):
            blocking_count += 1
    dominant_source = max(counts, key=counts.get) if any(counts.values()) else None
    return {
        "counts": counts,
        "blocking_count": blocking_count,
        "dominant_source": dominant_source,
    }


def _normalize_replay_agent_learning_rates(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, dict):
        return []
    rows: list[dict[str, Any]] = []
    for agent_name, raw in value.items():
        if not isinstance(raw, dict):
            continue
        rows.append({
            "agent": str(raw.get("agent") or agent_name).strip().lower() or str(agent_name).strip().lower(),
            "base": round(_to_float(raw.get("base"), 0.0), 6),
            "featureMultiplier": round(_to_float(raw.get("feature_multiplier"), _to_float(raw.get("featureMultiplier"), 1.0)), 6),
            "failureMultiplier": round(_to_float(raw.get("failure_multiplier"), _to_float(raw.get("failureMultiplier"), 1.0)), 6),
            "combinedMultiplier": round(_to_float(raw.get("combined_multiplier"), _to_float(raw.get("combinedMultiplier"), 1.0)), 6),
            "effectiveLearningRate": round(_to_float(raw.get("effective_learning_rate"), _to_float(raw.get("effectiveLearningRate"), 0.0)), 6),
            "families": [str(item).strip() for item in raw.get("families", []) if str(item).strip()] if isinstance(raw.get("families"), list) else [],
            "failureSource": _normalize_failure_source(raw.get("failure_source")),
            "calibrationMode": str(raw.get("calibration_mode") or raw.get("calibrationMode") or "prior").strip().lower() or "prior",
            "calibrationConfidence": round(_to_float(raw.get("calibration_confidence"), _to_float(raw.get("calibrationConfidence"), 0.0)), 6),
            "calibrationSamples": max(0, int(raw.get("calibration_samples") or raw.get("calibrationSamples") or 0)),
            "calibrationEffectiveWeight": round(_to_float(raw.get("calibration_effective_weight"), _to_float(raw.get("calibrationEffectiveWeight"), 0.0)), 6),
            "explanation": str(raw.get("explanation") or "").strip(),
        })
    rows.sort(key=lambda item: abs(_to_float(item.get("combinedMultiplier"), 1.0) - 1.0), reverse=True)
    return rows


def _build_replay_agent_learning_rates(source_row: dict[str, Any], rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    stored = _normalize_replay_agent_learning_rates(source_row.get("agent_learning_rate_hints"))
    if stored:
        return stored
    failure_source = _normalize_failure_source(source_row.get("failure_source"))
    if failure_source is None:
        return []

    totals = {agent_name: 0.0 for agent_name in REPLAY_AGENT_FAMILY_MAP}
    effective_weight = 0.0
    sample_count = 0
    real_count = 0
    synthetic_count = 0
    for row in rows:
        if _normalize_failure_source(row.get("failure_source")) != failure_source:
            continue
        sample_weight = _clamp(_to_float(row.get("sample_weight"), 1.0), 0.05, 1.0)
        row_weight = sample_weight * (0.32 if bool(row.get("synthetic")) else 1.0)
        if bool(row.get("failure_blocking")):
            row_weight *= 1.08
        diagnostics = row.get("feature_diagnostics") if isinstance(row.get("feature_diagnostics"), dict) else {}
        contributions = row.get("feature_contributions") if isinstance(row.get("feature_contributions"), dict) else {}
        for agent_name, families in REPLAY_AGENT_FAMILY_MAP.items():
            signal = 0.0
            for family in families:
                family_diag = diagnostics.get(family) if isinstance(diagnostics.get(family), dict) else {}
                contribution = abs(_to_float(family_diag.get("contribution"), _to_float(contributions.get(family), 0.0)))
                if contribution <= 1e-9:
                    contribution = abs(_to_float((row.get("features") or {}).get(family), 0.0)) * 0.08 if isinstance(row.get("features"), dict) else 0.0
                if bool(family_diag.get("wrong_way")):
                    contribution *= 1.18
                signal += contribution
            signal /= max(1, len(families))
            totals[agent_name] += signal * row_weight
        effective_weight += row_weight
        sample_count += 1
        if bool(row.get("synthetic")):
            synthetic_count += 1
        else:
            real_count += 1

    confidence = _clamp(effective_weight / 4.0, 0.0, 0.75)
    averaged = {
        agent_name: value / max(effective_weight, 1e-6)
        for agent_name, value in totals.items()
    }
    high = max(averaged.values()) if averaged else 0.0
    low = min(averaged.values()) if averaged else 0.0
    spread = max(0.0, high - low)
    if spread <= 1e-9:
        normalized = {agent_name: 0.5 if high > 0 else 0.0 for agent_name in REPLAY_AGENT_FAMILY_MAP}
    else:
        normalized = {
            agent_name: _clamp((value - low) / spread, 0.0, 1.0)
            for agent_name, value in averaged.items()
        }

    replay_rows: list[dict[str, Any]] = []
    source_diagnostics = source_row.get("feature_diagnostics") if isinstance(source_row.get("feature_diagnostics"), dict) else {}
    source_contributions = source_row.get("feature_contributions") if isinstance(source_row.get("feature_contributions"), dict) else {}
    for agent_name, families in REPLAY_AGENT_FAMILY_MAP.items():
        prior = _to_float(REPLAY_FAILURE_SOURCE_AGENT_LR_PRIORS.get(failure_source, {}).get(agent_name), 1.0)
        signal = normalized.get(agent_name, 0.0)
        if failure_source == "infra":
            empirical = 1.0 - 0.64 * signal
            if agent_name == "risk":
                empirical = max(0.96, empirical)
        elif failure_source == "market":
            empirical = 0.92 + 0.28 * signal
            if agent_name in {"scalper", "trend"}:
                empirical += 0.04
        else:
            empirical = 0.88 + 0.32 * signal
            if agent_name == "execution":
                empirical += 0.08
        failure_multiplier = round(_clamp(prior * (1.0 - confidence) + empirical * confidence, 0.42, 1.22), 6)
        family_labels: list[str] = []
        for family in families:
            family_diag = source_diagnostics.get(family) if isinstance(source_diagnostics.get(family), dict) else {}
            contribution = _to_float(family_diag.get("contribution"), _to_float(source_contributions.get(family), 0.0))
            if abs(contribution) <= 1e-9 and family not in source_contributions:
                continue
            suffix = " !" if bool(family_diag.get("wrong_way")) else ""
            family_labels.append(f"{family} {contribution:+.2f}{suffix}")
        replay_rows.append({
            "agent": agent_name,
            "base": 0.0,
            "featureMultiplier": 1.0,
            "failureMultiplier": failure_multiplier,
            "combinedMultiplier": failure_multiplier,
            "effectiveLearningRate": 0.0,
            "families": family_labels,
            "failureSource": failure_source,
            "calibrationMode": "empirical" if confidence > 0.0 else "prior",
            "calibrationConfidence": round(confidence, 6),
            "calibrationSamples": sample_count,
            "calibrationEffectiveWeight": round(effective_weight, 6),
            "explanation": " | ".join(filter(None, [", ".join(family_labels[:2]), f"{failure_source} c={confidence:.2f} r={real_count} s={synthetic_count}"])),
        })
    replay_rows.sort(key=lambda item: abs(_to_float(item.get("combinedMultiplier"), 1.0) - 1.0), reverse=True)
    return replay_rows


def _build_feature_context_label(context: dict[str, Any] | None) -> str:
    context = context if isinstance(context, dict) else {}
    regime = str(context.get("regime") or "n/a").strip().lower() or "n/a"
    session = str(context.get("session") or "n/a").strip().lower() or "n/a"
    volatility = str(context.get("volatility") or "n/a").strip().lower() or "n/a"
    spread = str(context.get("spread") or "n/a").strip().lower() or "n/a"
    return f"{regime} · {session} · {volatility} · {spread}"


def _normalize_replay_latent_label(value: Any) -> str:
    normalized = str(value or "").strip().lower()
    return normalized or "uninitialized"


def _format_replay_latent_label(value: Any) -> str:
    return " ".join(
        part[:1].upper() + part[1:]
        for part in _normalize_replay_latent_label(value).split("-")
        if part
    ) or "Uninitialized"


def _build_replay_latent_shift_label(latent_label: str, latent_next_label: str) -> str:
    if latent_label == latent_next_label:
        return f"{_format_replay_latent_label(latent_label)} hold"
    return f"{_format_replay_latent_label(latent_label)} -> {_format_replay_latent_label(latent_next_label)}"


def _experience_identifier(row: dict[str, Any]) -> str:
    return str(row.get("experience_id") or row.get("decision_id") or row.get("id") or row.get("event_id") or "").strip()


def _load_predictor_experience_rows_for_decision(decision_id: str, limit: int = 64) -> list[dict[str, Any]]:
    normalized_decision_id = str(decision_id or "").strip()
    if not normalized_decision_id or limit <= 0:
        return []
    candidate_paths = [
        PREDICTOR_V8_EXPERIENCES_LOG_PATH,
        Path(__file__).resolve().parents[2] / "data" / "predictor_v8" / "experiences.jsonl",
    ]
    log_path = next((path for path in candidate_paths if path.exists()), None)
    if log_path is None:
        return []
    rows: list[dict[str, Any]] = []
    try:
        with log_path.open("r", encoding="utf-8") as handle:
            for line in handle:
                payload = line.strip()
                if not payload:
                    continue
                try:
                    parsed = json.loads(payload)
                except Exception:
                    continue
                if not isinstance(parsed, dict):
                    continue
                experience_id = _experience_identifier(parsed)
                dream_source = str(parsed.get("dream_source") or "").strip()
                if experience_id == normalized_decision_id or dream_source == normalized_decision_id:
                    rows.append(parsed)
    except Exception:
        return []
    return rows[-limit:]


def _reality_gap_sample_id_for_decision(decision_id: str) -> str:
    normalized_decision_id = str(decision_id or "").strip()
    if not normalized_decision_id:
        return ""
    row = _normalize_db_row(fetch_one(
        """
        SELECT sample_id
        FROM reality_gap_samples
        WHERE decision_id = %s
        ORDER BY created_at DESC
        LIMIT 1
        """,
        (normalized_decision_id,),
    ))
    return str((row or {}).get("sample_id") or "").strip()


def _load_predictor_experience_rows_for_memory_decision(decision_id: str, limit: int = 96) -> tuple[list[str], list[dict[str, Any]]]:
    normalized_decision_id = str(decision_id or "").strip()
    if not normalized_decision_id or limit <= 0:
        return [], []

    candidate_ids = [normalized_decision_id]
    sample_id = _reality_gap_sample_id_for_decision(normalized_decision_id)
    if sample_id and sample_id not in candidate_ids:
        candidate_ids.append(sample_id)

    rows: list[dict[str, Any]] = []
    seen: set[tuple[str, str, bool, int]] = set()
    for candidate_id in candidate_ids:
        for row in _load_predictor_experience_rows_for_decision(candidate_id, limit=limit):
            context = row.get("context") if isinstance(row.get("context"), dict) else {}
            key = (
                _experience_identifier(row),
                str(row.get("dream_source") or "").strip(),
                bool(row.get("synthetic")),
                int(_to_float(context.get("timestamp_ms"), _to_float(row.get("timestamp_ms"), 0.0))),
            )
            if key in seen:
                continue
            seen.add(key)
            rows.append(row)

    return candidate_ids, rows[-limit:]


def _select_predictor_memory_decision_row(candidate_ids: list[str], rows: list[dict[str, Any]]) -> tuple[dict[str, Any] | None, str]:
    if not rows:
        return None, "none"

    candidate_set = {str(value or "").strip() for value in candidate_ids if str(value or "").strip()}
    ordered_rows = list(reversed(rows))

    for row in ordered_rows:
        if bool(row.get("synthetic")):
            continue
        experience_id = _experience_identifier(row)
        if experience_id and experience_id in candidate_set:
            return row, "experience"

    for row in ordered_rows:
        if not bool(row.get("synthetic")):
            return row, "latest_real"

    return ordered_rows[0], "latest_any"


def _summarize_predictor_memory_rows(rows: list[dict[str, Any]], limit: int = 8) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for row in rows[-max(1, limit):]:
        state = row.get("state") if isinstance(row.get("state"), dict) else {}
        context = row.get("context") if isinstance(row.get("context"), dict) else {}
        items.append({
            "experience_id": _experience_identifier(row),
            "synthetic": bool(row.get("synthetic")),
            "dream_source": str(row.get("dream_source") or "").strip(),
            "action": str(row.get("action") or "").strip(),
            "reward": round(_to_float(row.get("reward"), 0.0), 6),
            "sample_weight": round(_to_float(row.get("sample_weight"), 0.0), 6),
            "failure_source": _normalize_failure_source(row.get("failure_source")),
            "failure_blocking": bool(row.get("failure_blocking")),
            "regime": str(state.get("regime") or "").strip().upper(),
            "market_session": str(state.get("market_session") or "").strip().lower(),
            "network_regime": str(state.get("network_regime") or "").strip().lower(),
            "latent_label": str(state.get("latent_label") or "").strip().lower(),
            "timestamp_ms": int(_to_float(context.get("timestamp_ms"), _to_float(row.get("timestamp_ms"), 0.0))),
        })
    return list(reversed(items))


async def _query_predictor_memory_v2_for_decision(decision_id: str) -> dict[str, Any] | None:
    candidate_ids, rows = _load_predictor_experience_rows_for_memory_decision(decision_id)
    if not rows:
        return None

    base_row, resolution_source = _select_predictor_memory_decision_row(candidate_ids, rows)
    if base_row is None:
        return None

    base_experience_id = _experience_identifier(base_row)
    state_payload = base_row.get("state") if isinstance(base_row.get("state"), dict) else {}
    failure_source = _normalize_failure_source(base_row.get("failure_source"))
    episode_lookup = None
    if base_experience_id:
        episode_lookup = await _call_predictor_v8("/brain/memory-v2/query", {"experience_id": base_experience_id})
    context_lookup = await _call_predictor_v8(
        "/brain/memory-v2/query",
        {
            "state": state_payload,
            "failure_source": failure_source,
        },
    )
    if episode_lookup is None and context_lookup is None:
        return None

    return {
        "status": "ok",
        "decision_id": str(decision_id or "").strip(),
        "resolution": {
            "source": resolution_source,
            "candidate_ids": candidate_ids,
            "base_experience_id": base_experience_id,
            "matched_rows": len(rows),
            "synthetic_rows": sum(1 for row in rows if bool(row.get("synthetic"))),
            "failure_source": failure_source,
        },
        "base_experience": {
            "experience_id": base_experience_id,
            "synthetic": bool(base_row.get("synthetic")),
            "dream_source": str(base_row.get("dream_source") or "").strip(),
            "action": str(base_row.get("action") or "").strip(),
            "reward": round(_to_float(base_row.get("reward"), 0.0), 6),
            "sample_weight": round(_to_float(base_row.get("sample_weight"), 0.0), 6),
            "failure_source": failure_source,
            "failure_blocking": bool(base_row.get("failure_blocking")),
            "state": state_payload,
            "context": base_row.get("context") if isinstance(base_row.get("context"), dict) else {},
        },
        "episode_lookup": episode_lookup,
        "context_lookup": context_lookup,
        "related_experiences": _summarize_predictor_memory_rows(rows),
    }


def _build_replay_attribution_families(row: dict[str, Any]) -> list[dict[str, Any]]:
    diagnostics = row.get("feature_diagnostics") if isinstance(row.get("feature_diagnostics"), dict) else {}
    contributions = row.get("feature_contributions") if isinstance(row.get("feature_contributions"), dict) else {}
    families: list[dict[str, Any]] = []
    seen: set[str] = set()

    for family, raw in diagnostics.items():
        if not isinstance(family, str):
            continue
        payload = raw if isinstance(raw, dict) else {}
        families.append({
            "family": family,
            "contribution": round(_to_float(payload.get("contribution"), _to_float(contributions.get(family), 0.0)), 6),
            "shapLike": round(_to_float(payload.get("shap_like"), 0.0), 6),
            "marginalImpact": round(_to_float(payload.get("marginal_impact"), 0.0), 6),
            "correlation": round(_to_float(payload.get("rolling_correlation"), 0.0), 6),
            "learningRateHint": round(_to_float(payload.get("learning_rate_hint"), 1.0), 6),
            "wrongWay": bool(payload.get("wrong_way")),
        })
        seen.add(family)

    for family, value in contributions.items():
        if not isinstance(family, str) or family in seen:
            continue
        families.append({
            "family": family,
            "contribution": round(_to_float(value, 0.0), 6),
            "shapLike": 0.0,
            "marginalImpact": 0.0,
            "correlation": 0.0,
            "learningRateHint": 1.0,
            "wrongWay": False,
        })

    families.sort(key=lambda item: abs(_to_float(item.get("contribution"), 0.0)), reverse=True)
    return families


def _build_replay_brain_payload(decision_id: str) -> dict[str, Any] | None:
    rows = _load_predictor_experience_rows_for_decision(decision_id)
    if not rows:
        return None

    normalized_decision_id = str(decision_id or "").strip()
    base_row = next(
        (
            row for row in reversed(rows)
            if _experience_identifier(row) == normalized_decision_id and not bool(row.get("synthetic"))
        ),
        None,
    )
    if base_row is None:
        base_row = next((row for row in reversed(rows) if _experience_identifier(row) == normalized_decision_id), None)

    dream_rows = [
        row
        for row in rows
        if str(row.get("dream_source") or "").strip() == normalized_decision_id
        and _experience_identifier(row) != normalized_decision_id
    ]
    source_row = base_row or (dream_rows[-1] if dream_rows else None)
    if source_row is None:
        return None

    context = source_row.get("context") if isinstance(source_row.get("context"), dict) else {}
    state_payload = source_row.get("state") if isinstance(source_row.get("state"), dict) else {}
    next_state_payload = source_row.get("next_state") if isinstance(source_row.get("next_state"), dict) else {}
    latent_label = _normalize_replay_latent_label(state_payload.get("latent_label") or context.get("latent") or source_row.get("latent_label"))
    latent_next_label = _normalize_replay_latent_label(next_state_payload.get("latent_label") or context.get("latent_next") or source_row.get("latent_next_label") or latent_label)
    latent_transition = round(_to_float(state_payload.get("latent_transition"), _to_float(source_row.get("latent_transition"), 0.0)), 6)
    synthetic = bool(source_row.get("synthetic"))
    families = _build_replay_attribution_families(source_row)
    top_family = str((families[0].get("family") if families else "n/a") or "n/a")
    top_contribution = round(_to_float(families[0].get("contribution") if families else 0.0, 0.0), 6)
    sample_weight = round(_to_float(source_row.get("sample_weight"), 0.2 if synthetic else 1.0), 6)
    dream_weight = round(sum(_to_float(row.get("sample_weight"), 0.0) for row in dream_rows), 4)
    attribution_id = _experience_identifier(source_row) or normalized_decision_id
    failure_summary = _build_replay_failure_summary(rows)
    agent_learning_rates = _build_replay_agent_learning_rates(source_row, rows)

    return {
        "attribution": {
            "id": attribution_id,
            "action": str(source_row.get("action") or "HOLD").strip().upper() or "HOLD",
            "reward": round(_to_float(source_row.get("reward"), 0.0), 6),
            "rawReward": round(_to_float(source_row.get("raw_reward"), _to_float(source_row.get("reward"), 0.0)), 6),
            "rewardScale": round(_to_float(source_row.get("reward_scale"), 1.0), 6),
            "contextLabel": _build_feature_context_label(context),
            "topFamily": top_family,
            "topContribution": top_contribution,
            "families": families,
            "latentLabel": latent_label,
            "latentNextLabel": latent_next_label,
            "latentTransition": latent_transition,
            "latentShiftLabel": _build_replay_latent_shift_label(latent_label, latent_next_label),
            "synthetic": synthetic,
            "dreamSource": str(source_row.get("dream_source") or ("synthetic" if synthetic else "real")).strip() or ("synthetic" if synthetic else "real"),
            "sampleWeight": sample_weight,
            "dreamCount": len(dream_rows),
            "dreamWeight": dream_weight,
            "failureSource": _normalize_failure_source(source_row.get("failure_source")),
            "failureReasons": _normalize_failure_reasons(source_row.get("failure_reasons")),
            "failureBlocking": bool(source_row.get("failure_blocking")),
            "agentLearningRates": agent_learning_rates,
        },
        "experience_rows": rows[-12:],
        "match_count": len(rows),
        "dream_count": len(dream_rows),
        "failure_summary": failure_summary,
    }


async def _call_rust_execution_engine(payload: dict, routing: dict, risk_body: dict, preferred_venue: str, path: str = "execute") -> dict | None:
    if not RUST_EXECUTION_ENGINE_ENABLED:
        return None

    effective_routing = _resolve_rust_route_hint(payload, routing)
    adjusted_payload, adjusted_routing, applied_profiles = _apply_reality_gap_profiles_to_execution(payload, effective_routing)
    market_snapshot = adjusted_payload.get("market_snapshot") if isinstance(adjusted_payload.get("market_snapshot"), dict) else _build_rust_market_snapshot(adjusted_routing)
    metadata = adjusted_payload.get("metadata") if isinstance(adjusted_payload.get("metadata"), dict) else {}
    if applied_profiles:
        metadata["reality_gap_execution_profiles"] = applied_profiles
        adjusted_payload["metadata"] = metadata

    rust_payload = {
        "decision_id": f"rust-{uuid4()}",
        "account_id": adjusted_payload.get("account_id", ""),
        "execution_delay_ms": max(
            0,
            int(
                _to_float(
                    adjusted_payload.get("execution_delay_ms"),
                    _to_float(
                        ((adjusted_payload.get("metadata") if isinstance(adjusted_payload.get("metadata"), dict) else {}) or {}).get("execution_delay_ms"),
                        _to_float(
                            ((adjusted_payload.get("order_intent") if isinstance(adjusted_payload.get("order_intent"), dict) else {}) or {}).get("execution_delay_ms"),
                            0.0,
                        ),
                    ),
                )
            ),
        ),
        "symbol": _normalize_symbol(str(adjusted_payload.get("symbol", ""))),
        "side": adjusted_payload.get("side", "buy"),
        "estimated_notional_usd": adjusted_payload.get("estimated_notional_usd", 0),
        "max_spread_bps": adjusted_payload.get("max_spread_bps", 0),
        "preferred_venue": preferred_venue or None,
        "execution_mode": "routed-mt5",
        "route_hint": {
            "best": adjusted_routing.get("best"),
            "backup": adjusted_routing.get("backup"),
            "candidates": adjusted_routing.get("candidates") or [],
            "arbitrage": adjusted_routing.get("arbitrage"),
            "deviation_bps": adjusted_routing.get("deviation_bps"),
            "reason": adjusted_routing.get("reason"),
            "source": adjusted_routing.get("source"),
        },
        "market_snapshot": market_snapshot,
        "risk_gate": risk_body,
        "metadata": adjusted_payload.get("metadata") if isinstance(adjusted_payload.get("metadata"), dict) else {},
    }

    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            response = await client.post(f"{RUST_EXECUTION_ENGINE_URL}/{path}", json=rust_payload)
        if response.status_code >= 400:
            append_audit(
                "rust_execution_engine_degraded",
                {"path": path, "status_code": response.status_code, "detail": response.text[:500]},
            )
            return None
        body = response.json()
        if not isinstance(body, dict):
            append_audit("rust_execution_engine_invalid_payload", {"body": str(body)[:500]})
            return None
        return body
    except Exception as exc:
        append_audit("rust_execution_engine_unreachable", {"detail": str(exc)[:500]})
        return None


def _derive_predictor_route_mode(routing: dict, routed_execution_result: dict | None = None) -> str:
    route = (routed_execution_result or {}).get("route") if isinstance(routed_execution_result, dict) else None
    if isinstance(route, dict) and isinstance(route.get("mode"), str):
        return str(route.get("mode"))
    arbitrage = routing.get("arbitrage") if isinstance(routing.get("arbitrage"), dict) else {}
    return "dualVenueExecution" if bool(arbitrage.get("opportunity")) else "bestSingleVenue"


def _resolve_payload_portfolio_id(payload: dict[str, Any]) -> str:
    if not isinstance(payload, dict):
        return ""
    order_intent = payload.get("order_intent") if isinstance(payload.get("order_intent"), dict) else {}
    metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
    candidates = [
        payload.get("portfolio_id"),
        order_intent.get("portfolio_id"),
        metadata.get("portfolio_id"),
    ]
    for candidate in candidates:
        value = str(candidate or "").strip()
        if value:
            return value
    account_id = _normalize_account_id(payload.get("account_id") or order_intent.get("account_id") or metadata.get("account_id"))
    if account_id:
        return str(_preferred_portfolio_id_for_account(account_id) or "").strip()
    return ""


def _build_capital_allocation_guard(payload: dict[str, Any]) -> dict[str, Any]:
    portfolio_id = _resolve_payload_portfolio_id(payload)
    if not portfolio_id:
        return {
            "portfolio_id": "",
            "snapshot_id": "",
            "capital_multiplier": 1.0,
            "blocked": False,
            "reasons": [],
        }
    risk_snapshot = _latest_portfolio_risk_snapshot(portfolio_id)
    if not isinstance(risk_snapshot, dict):
        return {
            "portfolio_id": portfolio_id,
            "snapshot_id": "",
            "capital_multiplier": 1.0,
            "blocked": False,
            "reasons": [],
        }

    capital_multiplier = 1.0
    blocked = False
    reasons: list[str] = []
    drawdown_pct = _to_float(risk_snapshot.get("drawdown_pct"), 0.0)
    leverage_gross = _to_float(risk_snapshot.get("leverage_gross"), 0.0)
    concentration_pct = _to_float(risk_snapshot.get("concentration_pct"), 0.0)
    correlation_pairs = risk_snapshot.get("correlation_pairs") if isinstance(risk_snapshot.get("correlation_pairs"), list) else []
    breaches = risk_snapshot.get("breaches") if isinstance(risk_snapshot.get("breaches"), list) else []
    high_corr_pairs = [
        row for row in correlation_pairs
        if isinstance(row, dict) and abs(_to_float(row.get("correlation_30d"), 0.0)) >= 0.82
    ]
    severe_breaches = [
        row for row in breaches
        if isinstance(row, dict) and str(row.get("severity") or "").strip().lower() in {"high", "critical"}
    ]

    if drawdown_pct >= 8.0:
        blocked = True
        capital_multiplier = 0.0
        reasons.append("capital_drawdown_critical")
    elif drawdown_pct >= 5.0:
        capital_multiplier = min(capital_multiplier, 0.54)
        reasons.append("capital_drawdown_high")
    elif drawdown_pct >= 3.5:
        capital_multiplier = min(capital_multiplier, 0.72)
        reasons.append("capital_drawdown_elevated")

    if leverage_gross >= 3.0:
        blocked = True
        capital_multiplier = 0.0
        reasons.append("capital_leverage_critical")
    elif leverage_gross >= 2.2:
        capital_multiplier = min(capital_multiplier, 0.62)
        reasons.append("capital_leverage_high")

    if concentration_pct >= 32.0:
        capital_multiplier = min(capital_multiplier, 0.68)
        reasons.append("capital_concentration_high")

    if len(high_corr_pairs) >= 2:
        capital_multiplier = min(capital_multiplier, 0.74)
        reasons.append("capital_correlation_cluster")

    if severe_breaches:
        capital_multiplier = min(capital_multiplier, 0.58)
        reasons.append("capital_risk_breach_active")

    deduped_reasons: list[str] = []
    for reason in reasons:
        if reason and reason not in deduped_reasons:
            deduped_reasons.append(reason)
    return {
        "portfolio_id": portfolio_id,
        "snapshot_id": str(risk_snapshot.get("snapshot_id") or ""),
        "capital_multiplier": round(max(0.0, min(1.0, capital_multiplier)), 6),
        "blocked": blocked,
        "reasons": deduped_reasons,
        "drawdown_pct": round(drawdown_pct, 6),
        "leverage_gross": round(leverage_gross, 6),
        "concentration_pct": round(concentration_pct, 6),
        "high_correlation_pairs": len(high_corr_pairs),
    }


def _build_predictor_execution_payload(
    payload: dict,
    routing: dict,
    risk_body: dict,
    preferred_venue: str,
    routed_execution_result: dict | None = None,
) -> dict:
    predictor_context = _predictor_context(payload)
    infra_context = _resolve_infra_context(predictor_context)
    effective_routing = _resolve_rust_route_hint(payload, routing)
    route = (routed_execution_result or {}).get("route") if isinstance(routed_execution_result, dict) else {}
    route = route if isinstance(route, dict) else {}
    selected_route = (route.get("chosen") if isinstance(route.get("chosen"), dict) else None) or (effective_routing.get("best") if isinstance(effective_routing.get("best"), dict) else {})
    backup_route = (route.get("backup") if isinstance(route.get("backup"), dict) else None) or (effective_routing.get("backup") if isinstance(effective_routing.get("backup"), dict) else {})
    market_snapshot = _build_rust_market_snapshot(effective_routing)
    best_bid = _to_float(market_snapshot.get("best_bid"), 0.0)
    best_ask = _to_float(market_snapshot.get("best_ask"), 0.0)
    midpoint = ((best_bid + best_ask) / 2.0) if best_bid > 0 and best_ask > 0 else _to_float(effective_routing.get("fusion_price"), _to_float(selected_route.get("last"), 0.0))
    arbitrage = effective_routing.get("arbitrage") if isinstance(effective_routing.get("arbitrage"), dict) else {}
    route_mode = _derive_predictor_route_mode(effective_routing, routed_execution_result)
    arbitrage_net_spread = _to_float(arbitrage.get("net_spread"), 0.0)
    v7_should_execute = route_mode != "dualVenueExecution" or (bool(arbitrage.get("opportunity")) and arbitrage_net_spread > 0)
    expected_slippage_bps = _to_float((routed_execution_result or {}).get("expected_slippage_bps"), _to_float(selected_route.get("spread_bps"), 0.0) * 0.8)
    return {
        "decision_id": str(payload.get("decision_id") or "").strip(),
        "account_id": _normalize_account_id(payload.get("account_id")),
        "portfolio_id": _resolve_payload_portfolio_id(payload),
        "symbol": str(payload.get("symbol") or "").strip(),
        "side": str(payload.get("side") or "buy").strip().lower(),
        "preferred_venue": preferred_venue or str(selected_route.get("venue") or "").strip(),
        "price": midpoint,
        "spread_bps": _to_float(selected_route.get("spread_bps"), _to_float(selected_route.get("spread"), 0.0)),
        "imbalance": _to_float(predictor_context.get("imbalance"), _to_float(predictor_context.get("depth_imbalance"), 0.0)),
        "depth_imbalance": predictor_context.get("depth_imbalance", predictor_context.get("imbalance")),
        "volatility_bps": _to_float(predictor_context.get("volatility_bps"), abs(_to_float(effective_routing.get("deviation_bps"), 0.0))),
        "position_size": _to_float(predictor_context.get("position_size"), 0.0),
        "realized_pnl_usd": _to_float(predictor_context.get("realized_pnl_usd"), 0.0),
        "unrealized_pnl_usd": _to_float(predictor_context.get("unrealized_pnl_usd"), 0.0),
        "latency_ms": _to_float(predictor_context.get("latency_ms"), _to_float(selected_route.get("latency_ms"), 0.0)),
        "available_depth_usd": _to_float(predictor_context.get("available_depth_usd"), _to_float(selected_route.get("available_depth_usd"), 0.0)),
        "volume_30s": _to_float(predictor_context.get("volume_30s"), 0.0),
        "fill_probability": _to_float(predictor_context.get("fill_probability"), _to_float(selected_route.get("fill_probability"), 0.0)),
        "backlog_pressure": _to_float(predictor_context.get("backlog_pressure"), _to_float(predictor_context.get("backlog"), 0.0)),
        "render_pressure": _to_float(predictor_context.get("render_pressure"), 0.0),
        "renderable_rows": _to_float(predictor_context.get("renderable_rows"), 0.0),
        "backlog": _to_float(predictor_context.get("backlog"), _to_float(predictor_context.get("backlog_pressure"), 0.0)),
        "arb_edge_bps": _to_float(predictor_context.get("arb_edge_bps"), arbitrage_net_spread),
        "latency_cost_bps": _to_float(predictor_context.get("latency_cost_bps"), 0.0),
        "slippage_bps": _to_float(predictor_context.get("slippage_bps"), expected_slippage_bps),
        "cvd_delta": _to_float(predictor_context.get("cvd_delta"), 0.0),
        "micro_burst_10ms": _to_float(predictor_context.get("micro_burst_10ms"), 0.0),
        "quote_fade_rate": _to_float(predictor_context.get("quote_fade_rate"), 0.0),
        "book_flip_signal": _to_float(predictor_context.get("book_flip_signal"), 0.0),
        "trend_score": _to_float(predictor_context.get("trend_score"), 0.0),
        "infra_health": _to_float(predictor_context.get("infra_health"), _to_float(effective_routing.get("infra_health"), _to_float(infra_context.get("infra_health"), 1.0))),
        "network_regime": str(predictor_context.get("network_regime") or effective_routing.get("network_regime") or infra_context.get("network_regime") or "stable"),
        "dns_transient_rate": _to_float(predictor_context.get("dns_transient_rate"), _to_float(infra_context.get("dns_transient_rate"), 0.0)),
        "timeout_rate": _to_float(predictor_context.get("timeout_rate"), _to_float(infra_context.get("timeout_rate"), 0.0)),
        "degraded_usage_ratio": _to_float(predictor_context.get("degraded_usage_ratio"), _to_float(infra_context.get("degraded_usage_ratio"), 0.0)),
        "retry_recovered_ratio": _to_float(predictor_context.get("retry_recovered_ratio"), _to_float(infra_context.get("retry_recovered_ratio"), 0.0)),
        "route_mode": str(predictor_context.get("route_mode") or route_mode),
        "v7_should_execute": bool(predictor_context.get("v7_should_execute", v7_should_execute)),
        "v7_reasons": [str(item) for item in predictor_context.get("v7_reasons", [] if v7_should_execute else ["dual_venue_not_profitable"]) if isinstance(item, str)],
        "estimated_notional_usd": _to_float(payload.get("estimated_notional_usd"), 0.0),
        "max_spread_bps": _to_float(payload.get("max_spread_bps"), 0.0),
        "risk_decision": str(risk_body.get("decision") or "").strip().lower(),
        "routing": {
            "best": selected_route,
            "backup": backup_route,
            "arbitrage": arbitrage,
            "deviation_bps": _to_float(effective_routing.get("deviation_bps"), 0.0),
        },
    }


async def _call_predictor_v8(path: str, payload: dict) -> dict | None:
    try:
        async with httpx.AsyncClient(timeout=PREDICTOR_V8_TIMEOUT_SECONDS) as client:
            response = await client.post(f"{PREDICTOR_V8_URL}{path}", json=payload)
        if response.status_code >= 400:
            append_audit(
                "predictor_v8_degraded",
                {"path": path, "status_code": response.status_code, "detail": response.text[:500]},
            )
            return None
        body = response.json()
        return body if isinstance(body, dict) else None
    except Exception as exc:
        append_audit("predictor_v8_unreachable", {"path": path, "detail": str(exc)[:500]})
        return None


async def _get_predictor_v8(path: str, params: dict[str, Any] | None = None) -> dict | None:
    try:
        async with httpx.AsyncClient(timeout=PREDICTOR_V8_TIMEOUT_SECONDS) as client:
            response = await client.get(f"{PREDICTOR_V8_URL}{path}", params=params or None)
        if response.status_code >= 400:
            append_audit(
                "predictor_v8_degraded",
                {"path": path, "status_code": response.status_code, "detail": response.text[:500]},
            )
            return None
        body = response.json()
        return body if isinstance(body, dict) else None
    except Exception as exc:
        append_audit("predictor_v8_unreachable", {"path": path, "detail": str(exc)[:500]})
        return None


def _memory_v2_session_label() -> str:
    hour = datetime.now(timezone.utc).hour
    if 0 <= hour < 8:
        return "asia"
    if 8 <= hour < 16:
        return "europe"
    return "us"


async def _probe_memory_v2_service(client: httpx.AsyncClient, name: str, url: str) -> dict[str, Any]:
    started = time.perf_counter()
    try:
        response = await client.get(url)
        latency_ms = (time.perf_counter() - started) * 1000.0
        return {
            "name": name,
            "ok": response.status_code < 500,
            "status_code": response.status_code,
            "latency_ms": round(latency_ms, 3),
        }
    except Exception as exc:
        latency_ms = (time.perf_counter() - started) * 1000.0
        return {
            "name": name,
            "ok": False,
            "status_code": None,
            "latency_ms": round(latency_ms, 3),
            "error": str(exc)[:240],
        }


def _derive_memory_v2_liquidity_state(depth_imbalance: float, spread_bps: float, available_depth_usd: float, requested_notional_usd: float) -> str:
    if spread_bps >= 10.0 or available_depth_usd <= max(25000.0, requested_notional_usd * 3.0):
        return "thin"
    if abs(depth_imbalance) >= 0.28:
        return "imbalanced"
    return "balanced"


async def _build_intent_memory_v2_query_payload(intent_payload: dict, risk_decision: RiskDecision, live_hint: dict[str, Any] | None = None) -> dict[str, Any]:
    explainability = intent_payload.get("explainability") if isinstance(intent_payload.get("explainability"), dict) else {}
    risk_snapshot = risk_decision.risk_snapshot if isinstance(getattr(risk_decision, "risk_snapshot", None), dict) else {}
    side = str(intent_payload.get("side") or "buy").strip().lower()
    symbol = str(intent_payload.get("instrument") or "").strip().upper()
    requested_notional_usd = _to_float(intent_payload.get("target_notional_usd"), 0.0)
    provider = str((live_hint or {}).get("provider") or intent_payload.get("venue") or "").strip().lower()

    route_plan = await _compute_route_plan(symbol, explainability or risk_snapshot)
    route_best = route_plan.get("best") if isinstance(route_plan.get("best"), dict) else {}
    observed_venue = str(route_best.get("venue") or provider or intent_payload.get("venue") or "binance").strip().lower() or "binance"

    async with httpx.AsyncClient(timeout=6.0) as client:
        micro_response, session_response, market_probe, router_probe, predictor_probe, ai_probe = await asyncio.gather(
            client.get(
                f"{MARKET_DATA_URL}/v1/market/microstructure",
                params={"instrument": symbol, "venue": observed_venue, "lookback_minutes": 30},
            ),
            client.get(
                f"{MARKET_DATA_URL}/v1/market/session-state",
                params={"instrument": symbol},
            ),
            _probe_memory_v2_service(client, "market-data", f"{MARKET_DATA_URL}/health"),
            _probe_memory_v2_service(client, "execution-router", f"{EXECUTION_ROUTER_URL}/health"),
            _probe_memory_v2_service(client, "predictor-v8", f"{PREDICTOR_V8_URL}/health"),
            _probe_memory_v2_service(client, "ai-orchestrator", f"{AI_ORCHESTRATOR_URL}/health"),
        )

    market_micro = micro_response.json() if micro_response.status_code < 400 and isinstance(micro_response.json(), dict) else {}
    session_state = session_response.json() if session_response.status_code < 400 and isinstance(session_response.json(), dict) else {}
    route_market_snapshot = _build_rust_market_snapshot(route_plan)
    probes = [market_probe, router_probe, predictor_probe, ai_probe]
    ok_probes = [probe for probe in probes if bool(probe.get("ok"))]
    failed_probe_count = len([probe for probe in probes if not bool(probe.get("ok"))])
    degraded_probe_count = len([probe for probe in probes if _to_float(probe.get("latency_ms"), 0.0) >= 450.0])
    average_probe_latency_ms = sum(_to_float(probe.get("latency_ms"), 0.0) for probe in ok_probes) / len(ok_probes) if ok_probes else 0.0

    regime = str(
        explainability.get("regime")
        or explainability.get("market_regime")
        or risk_snapshot.get("regime")
        or "BALANCED"
    ).strip().upper() or "BALANCED"
    price = _to_float(route_plan.get("fusion_price"), _to_float(market_micro.get("mark_price"), _to_float(explainability.get("price"), 0.0)))
    spread_bps = _to_float(route_best.get("spread_bps"), _to_float(market_micro.get("spread_bps"), _to_float(explainability.get("spread_bps"), max(0.5, _to_float(intent_payload.get("max_slippage_bps"), 0.0) * 0.35))))
    confidence = _clamp(_to_float(intent_payload.get("confidence"), 0.0), 0.0, 1.0)
    route_infra_health = _clamp(_to_float(route_plan.get("infra_health"), _to_float(explainability.get("infra_health"), _to_float(risk_snapshot.get("infra_health"), 1.0))), 0.05, 1.0)
    probe_health = 1.0 - min(0.75, failed_probe_count * 0.18 + degraded_probe_count * 0.08)
    infra_health = _clamp(route_infra_health * 0.68 + probe_health * 0.32, 0.05, 1.0)
    network_regime = str(route_plan.get("network_regime") or explainability.get("network_regime") or risk_snapshot.get("network_regime") or "stable").strip().lower() or "stable"
    available_depth_usd = _to_float(route_best.get("available_depth_usd"), _to_float(route_market_snapshot.get("total_depth_usd"), requested_notional_usd * 10.0))
    depth_imbalance = _to_float(market_micro.get("depth_imbalance"), _to_float(explainability.get("depth_imbalance"), 0.0))
    volume_imbalance = _to_float(market_micro.get("volume_imbalance"), 0.0)
    liquidity_state = str(explainability.get("liquidity_state") or risk_snapshot.get("liquidity_state") or _derive_memory_v2_liquidity_state(depth_imbalance, spread_bps, available_depth_usd, requested_notional_usd)).strip().lower() or "balanced"
    latency_ms = _to_float(route_best.get("latency_ms"), _to_float(explainability.get("latency_ms"), _to_float(risk_snapshot.get("latency_ms"), average_probe_latency_ms or 25.0)))
    fill_probability = _clamp(_to_float(route_best.get("fill_probability"), confidence), 0.0, 1.0)
    backlog_pressure = _clamp(failed_probe_count * 0.18 + degraded_probe_count * 0.06, 0.0, 1.0)
    trend_score = _clamp(
        _to_float(explainability.get("trend_score"), volume_imbalance * 0.55 + depth_imbalance * 0.45),
        -1.0,
        1.0,
    )
    book_flip_signal = _clamp(abs(volume_imbalance - depth_imbalance), 0.0, 1.0)
    quote_fade_rate = _clamp(abs(depth_imbalance) * 0.6 + max(0.0, spread_bps - 2.0) / 18.0, 0.0, 1.0)
    momentum = _clamp(_to_float(explainability.get("momentum"), volume_imbalance * 0.8 + depth_imbalance * 0.2), -1.0, 1.0)
    session_label = str(session_state.get("session") or explainability.get("market_session") or risk_snapshot.get("market_session") or _memory_v2_session_label()).strip().lower() or _memory_v2_session_label()
    network_metrics = {
        "dns_transient_rate": 0.0,
        "timeout_rate": round(failed_probe_count / max(1, len(probes)), 6),
        "degraded_usage_ratio": round(degraded_probe_count / max(1, len(probes)), 6),
        "retry_recovered_ratio": 0.0,
    }

    return {
        "state": {
            "symbol": symbol,
            "venue": provider or observed_venue,
            "price": price,
            "fusion_price": _to_float(route_plan.get("fusion_price"), price),
            "regime": regime,
            "market_session": session_label,
            "network_regime": network_regime,
            "liquidity_state": liquidity_state,
            "latency_ms": latency_ms,
            "fill_probability": fill_probability,
            "slippage_bps": _to_float(explainability.get("slippage_bps"), spread_bps * 0.6),
            "spread_bps": spread_bps,
            "available_depth_usd": available_depth_usd,
            "depth_imbalance": depth_imbalance,
            "backlog_pressure": backlog_pressure,
            "render_pressure": _to_float(explainability.get("render_pressure"), 0.0),
            "trend_score": trend_score if side == "buy" else trend_score,
            "momentum": momentum,
            "bid_volume": _to_float(market_micro.get("buy_volume"), 0.0),
            "ask_volume": _to_float(market_micro.get("sell_volume"), 0.0),
            "orderflow_imbalance": volume_imbalance,
            "quote_fade_rate": quote_fade_rate,
            "book_flip_signal": book_flip_signal,
            "volume_30s": _to_float(market_micro.get("tape_acceleration"), 0.0),
            "open_interest": _to_float(market_micro.get("open_interest"), 0.0),
            "mark_price": _to_float(market_micro.get("mark_price"), price),
            "failure_source": route_plan.get("failure_source"),
            "route_mode": str(explainability.get("route_mode") or "bestSingleVenue"),
            "infra_health": infra_health,
            "network_metrics": network_metrics,
        },
        "runtime_snapshot": {
            "route_plan": route_plan,
            "market_micro": market_micro,
            "route_market_snapshot": route_market_snapshot,
            "session": session_state,
            "service_probes": probes,
            "requested_notional_usd": requested_notional_usd,
        },
    }


def _apply_memory_v2_pretrade_overrides(intent_payload: dict, memory_lookup: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    recommendation = memory_lookup.get("recommendation") if isinstance(memory_lookup.get("recommendation"), dict) else {}
    confidence = _clamp(_to_float(memory_lookup.get("confidence"), 0.0), 0.0, 1.0)
    strategy_mode = str(recommendation.get("strategy_mode") or "").strip().lower()
    execution_style = str(recommendation.get("execution_style") or "default").strip().lower() or "default"
    route_mode_override = str(recommendation.get("route_mode_override") or "").strip() or None
    size_multiplier_cap = _clamp(_to_float(recommendation.get("size_multiplier_cap"), 1.0), 0.1, 1.0)
    max_spread_multiplier = _clamp(_to_float(recommendation.get("max_spread_multiplier"), 1.0), 0.35, 1.0)
    base_notional = _to_float(intent_payload.get("target_notional_usd"), 0.0)
    base_slippage_bps = _to_float(intent_payload.get("max_slippage_bps"), 0.0)
    adjusted_notional = round(base_notional * size_multiplier_cap, 6) if base_notional > 0 else 0.0
    adjusted_slippage_bps = max(1, int(round(base_slippage_bps * max_spread_multiplier))) if base_slippage_bps > 0 else 1

    execution_delay_ms = 0
    if strategy_mode in {"risk_off", "execution_protect"}:
        execution_delay_ms = max(200, min(5000, int(round(350 + confidence * 1150))))
    elif execution_style in {"maker_passive", "passive_selective", "primary_only"}:
        execution_delay_ms = max(120, min(2500, int(round(180 + confidence * 620))))

    block_execution = bool(strategy_mode == "risk_off" and confidence >= 0.62)
    effective_intent_payload = dict(intent_payload)
    effective_intent_payload["target_notional_usd"] = adjusted_notional if adjusted_notional > 0 else base_notional
    effective_intent_payload["max_slippage_bps"] = adjusted_slippage_bps
    explainability = effective_intent_payload.get("explainability") if isinstance(effective_intent_payload.get("explainability"), dict) else {}
    memory_applied = {
        "mandatory": True,
        "query_status": str(memory_lookup.get("status") or "unknown"),
        "source": str(memory_lookup.get("source") or "none"),
        "context_key": str(memory_lookup.get("context_key") or ""),
        "confidence": round(confidence, 6),
        "recommendation": recommendation,
        "applied": {
            "block_execution": block_execution,
            "execution_delay_ms": execution_delay_ms,
            "target_notional_usd_before": base_notional,
            "target_notional_usd_after": effective_intent_payload["target_notional_usd"],
            "max_slippage_bps_before": base_slippage_bps,
            "max_slippage_bps_after": adjusted_slippage_bps,
            "route_mode_override": route_mode_override,
            "execution_style": execution_style,
            "strategy_mode": strategy_mode,
            "size_multiplier_cap": size_multiplier_cap,
            "max_spread_multiplier": max_spread_multiplier,
        },
    }
    explainability["memory_v2_pretrade"] = memory_applied
    effective_intent_payload["explainability"] = explainability
    return effective_intent_payload, memory_applied


def _brain_action_matches_side(side: str, action: str) -> bool:
    normalized_side = str(side or "").strip().lower()
    normalized_action = str(action or "HOLD").strip().upper()
    if normalized_side == "buy":
        return normalized_action == "BUY"
    if normalized_side == "sell":
        return normalized_action == "SELL"
    return normalized_action in {"HOLD", "CLOSE"}


async def _evaluate_predictor_gate(
    payload: dict,
    routing: dict,
    risk_body: dict,
    preferred_venue: str,
    routed_execution_result: dict | None = None,
) -> dict:
    predictor_request = _build_predictor_execution_payload(payload, routing, risk_body, preferred_venue, routed_execution_result=routed_execution_result)
    predictor_response = await _call_predictor_v8("/predict", predictor_request)
    reasons: list[str] = []
    model_should_execute = True
    brain_should_execute = True
    brain_action = "HOLD"
    brain_confidence = 0.0
    brain_consensus = 0.0
    brain_governor: dict[str, Any] = {}
    brain_strategy_switch: dict[str, Any] = {}
    brain_meta_agent: dict[str, Any] = {}
    brain_action_shield: dict[str, Any] = {}
    predictor_world_model: dict[str, Any] = {}

    if isinstance(predictor_response, dict):
        model_should_execute = bool(predictor_response.get("should_execute", True))
        predictor_world_model = predictor_response.get("world_model") if isinstance(predictor_response.get("world_model"), dict) else {}
        reasons.extend(
            str(item)
            for item in predictor_response.get("reasons", [])
            if isinstance(item, str)
        )
        brain_payload = predictor_response.get("autonomous_brain") if isinstance(predictor_response.get("autonomous_brain"), dict) else None
        if isinstance(brain_payload, dict):
            brain_should_execute = bool(brain_payload.get("should_execute"))
            brain_action = str(brain_payload.get("action") or "HOLD").strip().upper()
            brain_confidence = _to_float(brain_payload.get("confidence"), 0.0)
            brain_consensus = _to_float(brain_payload.get("consensus"), 0.0)
            meta_policy = brain_payload.get("meta_policy") if isinstance(brain_payload.get("meta_policy"), dict) else {}
            brain_governor = meta_policy.get("governor") if isinstance(meta_policy.get("governor"), dict) else {}
            brain_strategy_switch = meta_policy.get("strategy_switch") if isinstance(meta_policy.get("strategy_switch"), dict) else {}
            brain_meta_agent = meta_policy.get("meta_agent") if isinstance(meta_policy.get("meta_agent"), dict) else {}
            brain_action_shield = meta_policy.get("action_shield") if isinstance(meta_policy.get("action_shield"), dict) else {}
            brain_reason = str(brain_payload.get("reason") or "").strip()
            if brain_reason and (not brain_should_execute or not _brain_action_matches_side(str(payload.get("side") or "buy"), brain_action)):
                reasons.append(brain_reason)
            if not _brain_action_matches_side(str(payload.get("side") or "buy"), brain_action):
                brain_should_execute = False
                reasons.append(f"brain_action_mismatch:{brain_action}")
        elif not model_should_execute and not reasons:
            reasons.append("predictor_model_blocked")

    deduped_reasons: list[str] = []
    for reason in reasons:
        if reason and reason not in deduped_reasons:
            deduped_reasons.append(reason)

    execution_adjustments = _build_predictor_execution_adjustments(payload, brain_governor, brain_strategy_switch, brain_meta_agent, brain_action_shield, preferred_venue, routing)

    return {
        "request": predictor_request,
        "response": predictor_response,
        "allow_execution": model_should_execute and brain_should_execute,
        "fail_open": predictor_response is None,
        "model_should_execute": model_should_execute,
        "brain_should_execute": brain_should_execute,
        "brain_action": brain_action,
        "brain_confidence": brain_confidence,
        "brain_consensus": brain_consensus,
        "brain_governor": brain_governor,
        "brain_strategy_switch": brain_strategy_switch,
        "brain_meta_agent": brain_meta_agent,
        "brain_action_shield": brain_action_shield,
        "world_model": predictor_world_model,
        "execution_adjustments": execution_adjustments,
        "reasons": deduped_reasons,
    }


def _build_predictor_execution_adjustments(
    payload: dict[str, Any],
    governor: dict[str, Any] | None,
    strategy_switch: dict[str, Any] | None,
    meta_agent: dict[str, Any] | None,
    action_shield: dict[str, Any] | None,
    preferred_venue: str,
    routing: dict[str, Any] | None = None,
) -> dict[str, Any]:
    governor_payload = governor if isinstance(governor, dict) else {}
    strategy_payload = strategy_switch if isinstance(strategy_switch, dict) else {}
    meta_agent_payload = meta_agent if isinstance(meta_agent, dict) else {}
    action_shield_payload = action_shield if isinstance(action_shield, dict) else {}
    capital_guard = _build_capital_allocation_guard(payload)
    size_multiplier = max(0.0, min(1.0, _to_float(governor_payload.get("size_multiplier"), 1.0)))
    size_cap = max(0.0, min(1.0, _to_float(strategy_payload.get("size_multiplier_cap"), 1.0)))
    shield_size_cap = max(0.0, min(1.0, _to_float(action_shield_payload.get("size_multiplier_cap"), 1.0)))
    capital_multiplier = max(0.0, min(1.0, _to_float(capital_guard.get("capital_multiplier"), 1.0)))
    applied_size_multiplier = min(size_multiplier, size_cap, shield_size_cap, capital_multiplier)
    base_notional = _to_float(payload.get("estimated_notional_usd"), 0.0)
    base_max_spread = _to_float(payload.get("max_spread_bps"), 0.0)
    max_spread_multiplier = max(0.35, min(1.0, _to_float(strategy_payload.get("max_spread_multiplier"), 1.0)))
    max_spread_multiplier = min(max_spread_multiplier, max(0.35, min(1.0, _to_float(action_shield_payload.get("max_spread_multiplier_cap"), 1.0))))
    route_mode_override = str(strategy_payload.get("route_mode_override") or payload.get("route_mode") or "").strip()
    venue_action = str(strategy_payload.get("venue_action") or meta_agent_payload.get("venue_action") or "stay_primary").strip()
    backup_route = routing.get("backup") if isinstance(routing, dict) and isinstance(routing.get("backup"), dict) else {}
    preferred_venue_override = str(strategy_payload.get("preferred_venue_override") or preferred_venue).strip()
    if venue_action == "rotate_backup" and backup_route:
        preferred_venue_override = str(backup_route.get("venue") or preferred_venue_override).strip() or preferred_venue_override
    adjusted_notional = round(base_notional * applied_size_multiplier, 6) if base_notional > 0 else 0.0
    adjusted_max_spread = round(base_max_spread * max_spread_multiplier, 6) if base_max_spread > 0 else 0.0
    execution_delay_ms = max(
        max(0, int(_to_float(strategy_payload.get("execution_delay_ms"), _to_float(meta_agent_payload.get("execution_delay_ms"), 0.0)))),
        max(0, int(_to_float(action_shield_payload.get("delay_ms"), 0.0))),
    )
    reasons = [
        str(item)
        for item in [
            *(governor_payload.get("reasons") if isinstance(governor_payload.get("reasons"), list) else []),
            *(strategy_payload.get("reasons") if isinstance(strategy_payload.get("reasons"), list) else []),
            *(action_shield_payload.get("reasons") if isinstance(action_shield_payload.get("reasons"), list) else []),
            *(capital_guard.get("reasons") if isinstance(capital_guard.get("reasons"), list) else []),
        ]
        if str(item).strip()
    ]
    blocked = bool(governor_payload.get("blocked") or capital_guard.get("blocked") or action_shield_payload.get("blocked"))
    return {
        "strategy_mode": str(strategy_payload.get("strategy_mode") or "").strip(),
        "execution_style": str(strategy_payload.get("execution_style") or "").strip(),
        "profile_id": str(strategy_payload.get("profile_id") or meta_agent_payload.get("profile_id") or "").strip(),
        "global_mode": str(strategy_payload.get("global_mode") or meta_agent_payload.get("global_mode") or "").strip(),
        "route_mode_override": route_mode_override,
        "preferred_venue": preferred_venue_override,
        "venue_action": venue_action,
        "execution_delay_ms": execution_delay_ms,
        "simulation_profile": str(strategy_payload.get("simulation_profile") or meta_agent_payload.get("simulation_profile") or "balanced").strip(),
        "halt_new_exposure": bool(strategy_payload.get("halt_new_exposure") or meta_agent_payload.get("halt_new_exposure")),
        "close_only": bool(strategy_payload.get("close_only") or meta_agent_payload.get("close_only")),
        "safe_action": str(action_shield_payload.get("projected_action") or "").strip(),
        "action_shield_mode": str(action_shield_payload.get("mode") or "pass").strip(),
        "size_multiplier": round(applied_size_multiplier, 6),
        "max_spread_multiplier": round(max_spread_multiplier, 6),
        "adjusted_notional_usd": adjusted_notional,
        "adjusted_max_spread_bps": adjusted_max_spread,
        "blocked": blocked,
        "world_horizon_ms": max(0, int(_to_float(action_shield_payload.get("world_horizon_ms"), 0.0))),
        "predicted_slippage_bps": round(_to_float(action_shield_payload.get("predicted_slippage_bps"), 0.0), 6),
        "predicted_fill_probability": round(_to_float(action_shield_payload.get("predicted_fill_probability"), 0.0), 6),
        "predicted_latency_ms": round(_to_float(action_shield_payload.get("predicted_latency_ms"), 0.0), 6),
        "execution_risk_score": round(_to_float(action_shield_payload.get("execution_risk_score"), 0.0), 6),
        "capital_multiplier": round(capital_multiplier, 6),
        "capital_allocation": capital_guard,
        "reasons": reasons,
    }


def _apply_predictor_execution_adjustments(payload: dict[str, Any], predictor_gate: dict[str, Any]) -> dict[str, Any]:
    adjustments = predictor_gate.get("execution_adjustments") if isinstance(predictor_gate.get("execution_adjustments"), dict) else {}
    adjusted_payload = dict(payload)
    adjusted_notional = _to_float(adjustments.get("adjusted_notional_usd"), _to_float(payload.get("estimated_notional_usd"), 0.0))
    adjusted_max_spread = _to_float(adjustments.get("adjusted_max_spread_bps"), _to_float(payload.get("max_spread_bps"), 0.0))
    adjusted_max_spread_int = int(max(1, round(adjusted_max_spread))) if adjusted_max_spread > 0 else 0
    route_mode_override = str(adjustments.get("route_mode_override") or payload.get("route_mode") or "").strip()
    preferred_venue = str(adjustments.get("preferred_venue") or payload.get("preferred_venue") or "").strip()
    if bool(adjustments.get("blocked")):
        adjusted_payload["estimated_notional_usd"] = 0.0
    elif adjusted_notional > 0:
        adjusted_payload["estimated_notional_usd"] = adjusted_notional
    if adjusted_max_spread_int > 0:
        adjusted_payload["max_spread_bps"] = adjusted_max_spread_int
    if route_mode_override:
        adjusted_payload["route_mode"] = route_mode_override
    if preferred_venue:
        adjusted_payload["preferred_venue"] = preferred_venue
    if _to_float(adjustments.get("execution_delay_ms"), 0.0) > 0:
        adjusted_payload["execution_delay_ms"] = int(_to_float(adjustments.get("execution_delay_ms"), 0.0))
    order_intent = adjusted_payload.get("order_intent") if isinstance(adjusted_payload.get("order_intent"), dict) else {}
    risk_preview = order_intent.get("risk_preview") if isinstance(order_intent.get("risk_preview"), dict) else {}
    if bool(adjustments.get("blocked")):
        risk_preview["notional"] = 0.0
    elif adjusted_notional > 0:
        risk_preview["notional"] = adjusted_notional
    if adjusted_max_spread_int > 0:
        risk_preview["max_spread_bps"] = adjusted_max_spread_int
    order_intent["risk_preview"] = risk_preview
    if _to_float(adjustments.get("execution_delay_ms"), 0.0) > 0:
        order_intent["execution_delay_ms"] = int(_to_float(adjustments.get("execution_delay_ms"), 0.0))
    order_intent["predictor_execution_adjustments"] = adjustments
    adjusted_payload["order_intent"] = order_intent
    metadata = adjusted_payload.get("metadata") if isinstance(adjusted_payload.get("metadata"), dict) else {}
    metadata["predictor_execution_adjustments"] = adjustments
    if _to_float(adjustments.get("execution_delay_ms"), 0.0) > 0:
        metadata["execution_delay_ms"] = int(_to_float(adjustments.get("execution_delay_ms"), 0.0))
    if adjustments.get("safe_action"):
        metadata["predictor_safe_action"] = str(adjustments.get("safe_action"))
    adjusted_payload["metadata"] = metadata
    return adjusted_payload


def _build_brain_learning_experience(decision_id: str, outcome_payload: dict, telemetry_row: dict | None) -> dict | None:
    telemetry_payload = telemetry_row.get("payload") if isinstance(telemetry_row, dict) and isinstance(telemetry_row.get("payload"), dict) else {}
    predictor_block = telemetry_payload.get("predictor") if isinstance(telemetry_payload, dict) and isinstance(telemetry_payload.get("predictor"), dict) else {}
    predictor_request = predictor_block.get("request") if isinstance(predictor_block.get("request"), dict) else {}
    predictor_response = predictor_block.get("response") if isinstance(predictor_block.get("response"), dict) else {}
    predictor_world_model = predictor_response.get("world_model") if isinstance(predictor_response.get("world_model"), dict) else {}
    predictor_world_summary = predictor_world_model.get("summary") if isinstance(predictor_world_model.get("summary"), dict) else {}
    autonomous_brain = predictor_response.get("autonomous_brain") if isinstance(predictor_response.get("autonomous_brain"), dict) else {}
    meta_policy = autonomous_brain.get("meta_policy") if isinstance(autonomous_brain.get("meta_policy"), dict) else {}
    governor = meta_policy.get("governor") if isinstance(meta_policy.get("governor"), dict) else {}
    strategy_switch = meta_policy.get("strategy_switch") if isinstance(meta_policy.get("strategy_switch"), dict) else {}
    meta_agent = meta_policy.get("meta_agent") if isinstance(meta_policy.get("meta_agent"), dict) else {}
    action_shield = meta_policy.get("action_shield") if isinstance(meta_policy.get("action_shield"), dict) else {}
    execution_adjustments = predictor_block.get("execution_adjustments") if isinstance(predictor_block.get("execution_adjustments"), dict) else {}
    routing_payload = telemetry_payload.get("routing") if isinstance(telemetry_payload.get("routing"), dict) else {}
    selected_route = routing_payload.get("best") if isinstance(routing_payload.get("best"), dict) else {}
    infra_context = _resolve_infra_context(predictor_request)
    route_failure = _route_failure_attribution(routing_payload, infra_context)
    failure_source = _normalize_failure_source(autonomous_brain.get("failure_source")) or _normalize_failure_source(routing_payload.get("failure_source")) or _normalize_failure_source(route_failure.get("failure_source"))
    failure_reasons = _normalize_failure_reasons(autonomous_brain.get("failure_reasons")) or _normalize_failure_reasons(routing_payload.get("failure_reasons")) or _normalize_failure_reasons(route_failure.get("failure_reasons"))
    failure_blocking = bool(autonomous_brain.get("failure_blocking") or routing_payload.get("failure_blocking") or route_failure.get("failure_blocking"))
    best_bid = _to_float(selected_route.get("best_bid"), 0.0)
    best_ask = _to_float(selected_route.get("best_ask"), 0.0)
    midpoint = ((best_bid + best_ask) / 2.0) if best_bid > 0 and best_ask > 0 else _to_float(selected_route.get("last"), 0.0)
    state = dict(predictor_request)
    if not state:
        state = {
            "decision_id": decision_id,
            "symbol": str(outcome_payload.get("symbol") or (telemetry_row or {}).get("symbol") or "").strip(),
            "side": str(outcome_payload.get("side") or (telemetry_row or {}).get("side") or "buy").strip().lower(),
            "price": midpoint,
            "spread_bps": _to_float((telemetry_row or {}).get("quote_spread_bps"), 0.0),
            "latency_ms": _to_float((telemetry_row or {}).get("latency_e2e_ms"), _to_float(outcome_payload.get("latency_ms"), 0.0)),
            "available_depth_usd": _to_float((telemetry_row or {}).get("available_depth_usd"), 0.0),
            "fill_probability": _to_float(selected_route.get("fill_probability"), 0.0),
            "arb_edge_bps": _to_float(((routing_payload.get("arbitrage") if isinstance(routing_payload.get("arbitrage"), dict) else {}) or {}).get("net_spread"), 0.0),
            "route_mode": _derive_predictor_route_mode(routing_payload),
            "v7_should_execute": True,
        }

    action_side = str(outcome_payload.get("side") or (telemetry_row or {}).get("side") or state.get("side") or "").strip().lower()
    if action_side not in {"buy", "sell"}:
        return None
    action = "BUY" if action_side == "buy" else "SELL"
    realized_pnl_usd = _to_float(outcome_payload.get("net_result_usd"), _to_float(outcome_payload.get("pnl_24h"), 0.0))
    drawdown = abs(min(0.0, _to_float(outcome_payload.get("mae"), realized_pnl_usd)))
    latency_ms = _to_float(outcome_payload.get("latency_ms"), _to_float((telemetry_row or {}).get("latency_e2e_ms"), _to_float(state.get("latency_ms"), 0.0)))
    slippage_bps = abs(_to_float(outcome_payload.get("slippage_real_bps"), _to_float((telemetry_row or {}).get("realized_slippage_bps"), _to_float(state.get("slippage_bps"), 0.0))))
    next_state = {
        **state,
        "realized_pnl_usd": realized_pnl_usd,
        "unrealized_pnl_usd": 0.0,
        "latency_ms": latency_ms,
        "slippage_bps": slippage_bps,
        "drawdown_pct": drawdown,
        "regime": str(outcome_payload.get("regime") or state.get("regime") or "").strip().upper(),
    }
    return {
        "experience": {
            "state": state,
            "action": action,
            "next_state": next_state,
            "pnl": realized_pnl_usd,
            "drawdown": drawdown,
            "latency": latency_ms,
            "failure_source": failure_source,
            "failure_reasons": failure_reasons,
            "failure_blocking": failure_blocking,
            "context": {
                "route_mode": str(state.get("route_mode") or _derive_predictor_route_mode(routing_payload) or "bestSingleVenue"),
                "strategy_mode": str(strategy_switch.get("strategy_mode") or strategy_switch.get("mode") or ""),
                "strategy_switch_mode": str(strategy_switch.get("mode") or ""),
                "route_mode_override": str(strategy_switch.get("route_mode_override") or ""),
                "execution_style": str(strategy_switch.get("execution_style") or ""),
                "meta_mode": str(meta_agent.get("global_mode") or ""),
                "meta_profile_id": str(meta_agent.get("profile_id") or strategy_switch.get("profile_id") or ""),
                "venue_action": str(strategy_switch.get("venue_action") or meta_agent.get("venue_action") or "stay_primary"),
                "execution_delay_ms": int(_to_float(strategy_switch.get("execution_delay_ms"), _to_float(meta_agent.get("execution_delay_ms"), 0.0))),
                "simulation_profile": str(strategy_switch.get("simulation_profile") or meta_agent.get("simulation_profile") or "balanced"),
                "action_shield_mode": str(action_shield.get("mode") or "pass"),
                "safe_action": str(action_shield.get("projected_action") or ""),
                "world_horizon_ms": int(_to_float(action_shield.get("world_horizon_ms"), _to_float(predictor_world_summary.get("horizon_ms"), 0.0))),
                "predicted_slippage_bps": _to_float(action_shield.get("predicted_slippage_bps"), _to_float(predictor_world_summary.get("expected_slippage_bps"), 0.0)),
                "predicted_fill_probability": _to_float(action_shield.get("predicted_fill_probability"), _to_float(predictor_world_summary.get("expected_fill_probability"), 0.0)),
                "predicted_latency_ms": _to_float(action_shield.get("predicted_latency_ms"), _to_float(predictor_world_summary.get("expected_latency_ms"), 0.0)),
                "world_execution_risk_score": _to_float(action_shield.get("execution_risk_score"), _to_float(predictor_world_summary.get("execution_risk_score"), 0.0)),
                "world_future_regime": str(predictor_world_summary.get("future_regime") or ""),
                "world_direction_bias": str(predictor_world_summary.get("direction_bias") or ""),
                "capital_multiplier": _to_float(execution_adjustments.get("capital_multiplier"), 1.0),
                "capital_portfolio_id": str(((execution_adjustments.get("capital_allocation") if isinstance(execution_adjustments.get("capital_allocation"), dict) else {}) or {}).get("portfolio_id") or ""),
                "max_spread_multiplier": _to_float(strategy_switch.get("max_spread_multiplier"), 1.0),
                "size_multiplier": _to_float(governor.get("size_multiplier"), 1.0),
                "policy_memory_key": str(strategy_switch.get("policy_memory_key") or ""),
            },
        }
    }


async def _dispatch_predictor_brain_learn(items: list[dict]) -> None:
    if not items:
        return
    response = await _call_predictor_v8("/brain/learn", {"items": items})
    if isinstance(response, dict):
        append_audit(
            "predictor_brain_learn_dispatched",
            {
                "accepted": int(response.get("accepted") or 0),
                "learned": bool(response.get("learned")),
                "sampled": int(response.get("sampled") or 0),
            },
        )


def _secret_env(name: str, default: str) -> str:
    file_path = os.getenv(f"{name}_FILE", "").strip()
    if file_path:
        try:
            with open(file_path, "r", encoding="utf-8") as handle:
                value = handle.read().strip()
            if value:
                return value
        except OSError:
            pass
    value = os.getenv(name, "").strip()
    return value or default


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _json_safe_value(value):
    if isinstance(value, datetime):
        return value.isoformat()
    return value


def _extract_pre_trade_memory_gate(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None

    candidates: list[Any] = [
        value.get("pre_trade_memory_gate"),
        (value.get("metadata") or {}).get("pre_trade_memory_gate") if isinstance(value.get("metadata"), dict) else None,
        (value.get("raw_payload") or {}).get("metadata", {}).get("pre_trade_memory_gate")
        if isinstance(value.get("raw_payload"), dict) and isinstance((value.get("raw_payload") or {}).get("metadata"), dict)
        else None,
        (value.get("payload") or {}).get("pre_trade_memory_gate") if isinstance(value.get("payload"), dict) else None,
        (value.get("payload") or {}).get("metadata", {}).get("pre_trade_memory_gate")
        if isinstance(value.get("payload"), dict) and isinstance((value.get("payload") or {}).get("metadata"), dict)
        else None,
        (value.get("router_execution") or {}).get("pre_trade_memory_gate") if isinstance(value.get("router_execution"), dict) else None,
    ]
    for candidate in candidates:
        if isinstance(candidate, dict):
            return {key: _json_safe_value(item) for key, item in candidate.items()}
    return None


def _extract_kairos_harness(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None

    candidates: list[Any] = [
        value.get("kairos_harness"),
        (value.get("metadata") or {}).get("kairos_harness") if isinstance(value.get("metadata"), dict) else None,
        (value.get("raw_payload") or {}).get("metadata", {}).get("kairos_harness")
        if isinstance(value.get("raw_payload"), dict) and isinstance((value.get("raw_payload") or {}).get("metadata"), dict)
        else None,
        (value.get("payload") or {}).get("kairos_harness") if isinstance(value.get("payload"), dict) else None,
        (value.get("payload") or {}).get("metadata", {}).get("kairos_harness")
        if isinstance(value.get("payload"), dict) and isinstance((value.get("payload") or {}).get("metadata"), dict)
        else None,
        (value.get("router_execution") or {}).get("kairos_harness") if isinstance(value.get("router_execution"), dict) else None,
    ]
    for candidate in candidates:
        if isinstance(candidate, dict):
            return {key: _json_safe_value(item) for key, item in candidate.items()}
    return None


def _extract_pre_trade_memory_gate_from_fills(fills: list[dict[str, Any]]) -> dict[str, Any] | None:
    for fill in fills:
        gate = _extract_pre_trade_memory_gate(fill)
        if isinstance(gate, dict):
            return gate
    return None


def _extract_kairos_harness_from_fills(fills: list[dict[str, Any]]) -> dict[str, Any] | None:
    for fill in fills:
        harness = _extract_kairos_harness(fill)
        if isinstance(harness, dict):
            return harness
    return None


def _requested_fill_quantity_from_payload(payload: dict[str, Any] | None) -> float:
    raw = payload if isinstance(payload, dict) else {}
    order_intent = raw.get("order_intent") if isinstance(raw.get("order_intent"), dict) else {}
    raw_payload = raw.get("raw_payload") if isinstance(raw.get("raw_payload"), dict) else {}
    for candidate in (
        raw.get("size_base"),
        raw.get("quantity"),
        raw.get("qty"),
        raw.get("lots"),
        order_intent.get("size_base"),
        order_intent.get("quantity"),
        order_intent.get("qty"),
        order_intent.get("lots"),
        raw_payload.get("size_base"),
        raw_payload.get("quantity"),
        raw_payload.get("qty"),
        raw_payload.get("lots"),
    ):
        numeric = _to_float(candidate, 0.0)
        if numeric > 0:
            return numeric
    return 0.0


def _realized_fill_quantity_from_result(result: dict[str, Any] | None) -> float:
    raw = result if isinstance(result, dict) else {}
    fills = raw.get("fills") if isinstance(raw.get("fills"), list) else []
    filled_qty = sum(_to_float(fill.get("size_base"), 0.0) for fill in fills if isinstance(fill, dict))
    if filled_qty > 0:
        return filled_qty
    for candidate in (
        raw.get("filled_qty"),
        raw.get("filled_quantity"),
        raw.get("executed_qty"),
        raw.get("size_base"),
        raw.get("quantity"),
        raw.get("qty"),
        raw.get("lots"),
    ):
        numeric = _to_float(candidate, 0.0)
        if numeric > 0:
            return numeric
    return 0.0


def _execution_audit_summary(
    *,
    decision_id: str,
    route: str,
    reason: str,
    expected_slippage_bps: float,
    realized_slippage_bps: float,
    latency_e2e_ms: int,
    requested_payload: dict[str, Any] | None,
    execution_result: dict[str, Any] | None,
) -> dict[str, Any]:
    expected_fill_quantity = _requested_fill_quantity_from_payload(requested_payload)
    realized_fill_quantity = _realized_fill_quantity_from_result(execution_result)
    fill_ratio = None
    partial_fill_ratio = None
    if expected_fill_quantity > 0:
        fill_ratio = round(_clamp(realized_fill_quantity / expected_fill_quantity, 0.0, 1.5), 6)
        partial_fill_ratio = round(max(0.0, 1.0 - min(fill_ratio, 1.0)), 6)
    return {
        "decision_id": str(decision_id or "").strip(),
        "route": str(route or "").strip(),
        "reason": str(reason or "").strip(),
        "expected_slippage_bps": round(_to_float(expected_slippage_bps, 0.0), 6),
        "realized_slippage_bps": round(_to_float(realized_slippage_bps, 0.0), 6),
        "latency_e2e_ms": int(max(0, latency_e2e_ms)),
        "expected_fill_quantity": round(expected_fill_quantity, 8),
        "realized_fill_quantity": round(realized_fill_quantity, 8),
        "fill_ratio": fill_ratio,
        "partial_fill_ratio": partial_fill_ratio,
    }


def _record_platform_execution_telemetry(
    source: str,
    execution_payload: dict[str, Any],
    route: dict[str, Any],
    routed: dict[str, Any],
    pre_trade_memory_gate: dict[str, Any] | None,
) -> str | None:
    if not isinstance(routed, dict):
        return None

    route_block = routed.get("route") if isinstance(routed.get("route"), dict) else {}
    chosen = route_block.get("chosen") if isinstance(route_block.get("chosen"), dict) else {}
    backup = route_block.get("backup") if isinstance(route_block.get("backup"), dict) else {}
    fills = routed.get("fills") if isinstance(routed.get("fills"), list) else []
    fill_times = [
        parsed
        for parsed in (_parse_iso_utc(str(fill.get("filled_at") or "")) for fill in fills if isinstance(fill, dict))
        if parsed is not None
    ]
    ts_decision = _now_utc()
    ts_intent = ts_decision
    ts_routing = ts_decision
    ts_broker_accept = min(fill_times) if fill_times else ts_decision
    ts_fill_partial = min(fill_times) if fill_times else ts_broker_accept
    ts_fill_final = max(fill_times) if fill_times else ts_broker_accept
    latency_e2e_ms = max(0, int((ts_fill_final - ts_decision).total_seconds() * 1000))
    telemetry_id = str(uuid4())
    execute(
        """
        INSERT INTO execution_telemetry (
          telemetry_id, decision_id, account_id, symbol, side, lots,
          route_chosen, route_backup, route_reason, route_score, backup_score,
          quote_spread_bps, available_depth_usd,
          expected_slippage_bps, realized_slippage_bps, latency_e2e_ms,
          ts_decision, ts_intent, ts_routing, ts_broker_accept, ts_fill_partial, ts_fill_final,
          payload
        ) VALUES (
          %s, %s, %s, %s, %s, %s,
          %s, %s, %s, %s, %s,
          %s, %s,
          %s, %s, %s,
          %s, %s, %s, %s, %s, %s,
          %s::jsonb
        )
        """,
        (
            telemetry_id,
            str(routed.get("decision_id") or execution_payload.get("decision_id") or ""),
            _normalize_account_id(((execution_payload.get("live_execution") or {}) if isinstance(execution_payload.get("live_execution"), dict) else {}).get("account_id") or route.get("account_id")),
            str(routed.get("instrument") or execution_payload.get("symbol") or ""),
            str(routed.get("side") or execution_payload.get("side") or ""),
            sum(_to_float(fill.get("size_base"), 0.0) for fill in fills if isinstance(fill, dict)),
            str(chosen.get("venue") or routed.get("venue") or route.get("preferred_venue") or ""),
            str(backup.get("venue") or ""),
            str(route_block.get("reason") or route.get("route_key") or source),
            _to_float(chosen.get("score"), 0.0),
            _to_float(backup.get("score"), 0.0) if backup else None,
            _to_float(chosen.get("spread_bps"), 0.0),
            _to_float(chosen.get("available_depth_usd"), 0.0),
            _to_float(routed.get("expected_slippage_bps"), 0.0),
            _to_float(routed.get("realized_slippage_bps"), 0.0),
            latency_e2e_ms,
            ts_decision,
            ts_intent,
            ts_routing,
            ts_broker_accept,
            ts_fill_partial,
            ts_fill_final,
            json_dumps(
                {
                    "source": source,
                    "route": route,
                    "webhook_execution": execution_payload,
                    "router_execution": routed,
                    "pre_trade_memory_gate": pre_trade_memory_gate,
                }
            ),
        ),
    )
    append_audit(
        "execution_telemetry_recorded",
        {
            "telemetry_id": telemetry_id,
            **_execution_audit_summary(
                decision_id=str(routed.get("decision_id") or execution_payload.get("decision_id") or ""),
                route=str(chosen.get("venue") or routed.get("venue") or route.get("preferred_venue") or ""),
                reason=str(route_block.get("reason") or route.get("route_key") or source),
                expected_slippage_bps=_to_float(routed.get("expected_slippage_bps"), 0.0),
                realized_slippage_bps=_to_float(routed.get("realized_slippage_bps"), 0.0),
                latency_e2e_ms=latency_e2e_ms,
                requested_payload=execution_payload,
                execution_result=routed,
            ),
            "source": source,
            "pre_trade_memory_gate": pre_trade_memory_gate,
        },
    )
    return telemetry_id


def _seed_kairos_harness_replay(payload: dict[str, Any], seeded_by: str) -> tuple[str, dict[str, Any], dict[str, Any], dict[str, Any], dict[str, Any]]:
    now = _now_utc()
    symbol = str(payload.get("symbol") or "SOLUSDT").strip().upper() or "SOLUSDT"
    venue = str(payload.get("venue") or "bingx").strip().lower() or "bingx"
    side = str(payload.get("side") or "buy").strip().lower() or "buy"
    decision_id = str(payload.get("decision_id") or f"kairos-harness-seed-{now.strftime('%Y%m%d%H%M%S')}-{uuid4().hex[:8]}").strip()
    account_id = _normalize_account_id(payload.get("account_id") or "kairos-shadow-harness") or "kairos-shadow-harness"
    regime = str(payload.get("regime") or "SCALP").strip().upper() or "SCALP"
    failure_source = _normalize_failure_source(payload.get("failure_source")) or "execution"
    failure_reasons = _normalize_failure_reasons(payload.get("failure_reasons")) or ["synthetic_harness_seed"]
    validation_source = str(payload.get("validation_source") or "synthetic-seed").strip() or "synthetic-seed"
    harness_mode = str(payload.get("mode") or "shadow_harness_seed").strip() or "shadow_harness_seed"
    predicted_fill_probability = _to_float(payload.get("predicted_fill_probability"), 0.74)
    realized_fill_ratio = _to_float(payload.get("realized_fill_ratio"), 0.92)
    expected_slippage_bps = _to_float(payload.get("expected_slippage_bps"), 4.6)
    realized_slippage_bps = _to_float(payload.get("realized_slippage_bps"), 7.1)
    predicted_latency_ms = _to_float(payload.get("predicted_latency_ms"), 96.0)
    realized_latency_ms = _to_float(payload.get("realized_latency_ms"), 148.0)
    predicted_impact_bps = _to_float(payload.get("predicted_impact_bps"), 3.4)
    realized_impact_bps = _to_float(payload.get("realized_impact_bps"), 5.2)
    predicted_queue_ahead_qty = _to_float(payload.get("predicted_queue_ahead_qty"), 18.0)
    realized_queue_ahead_qty = _to_float(payload.get("realized_queue_ahead_qty"), 29.0)
    quote_spread_bps = _to_float(payload.get("quote_spread_bps"), 6.2)
    available_depth_usd = _to_float(payload.get("available_depth_usd"), 24500.0)
    route_score = _to_float(payload.get("route_score"), 0.81)
    backup_score = _to_float(payload.get("backup_score"), 0.67)
    infra_health = _to_float(payload.get("infra_health"), 0.91)
    notional_usd = _to_float(payload.get("notional_usd"), 1250.0)
    base_price = _to_float(payload.get("price"), 178.25)
    quantity = _to_float(payload.get("quantity"), max(notional_usd / max(base_price, 1e-6), 0.0))
    network_regime = str(payload.get("network_regime") or "stable").strip().lower() or "stable"
    route_reason = str(payload.get("route_reason") or "synthetic_kairos_harness_seed").strip() or "synthetic_kairos_harness_seed"
    harness = {
        "mode": harness_mode,
        "status": str(payload.get("status") or "ok"),
        "validation_source": validation_source,
        "scenario": str(payload.get("scenario") or "sol_runtime_smoke"),
        "instrument": symbol,
        "venue": venue,
        "side": side,
        "decision_id": decision_id,
        "score": round(_to_float(payload.get("score"), 0.83), 4),
        "verdict": str(payload.get("verdict") or "degraded_fill_latency"),
        "failure_source": failure_source,
        "failure_reasons": failure_reasons,
        "created_at": now.isoformat(),
        "seeded": True,
        "seeded_by": seeded_by,
        "notes": payload.get("notes") or "Synthetic kairos harness replay seeded for runtime validation.",
        "metrics": {
            "predicted_fill_probability": round(predicted_fill_probability, 6),
            "realized_fill_ratio": round(realized_fill_ratio, 6),
            "expected_slippage_bps": round(expected_slippage_bps, 6),
            "realized_slippage_bps": round(realized_slippage_bps, 6),
            "predicted_latency_ms": round(predicted_latency_ms, 6),
            "realized_latency_ms": round(realized_latency_ms, 6),
        },
    }
    telemetry_payload = {
        "source": "synthetic_kairos_harness_seed",
        "routing": {
            "best": {
                "venue": venue,
                "score": route_score,
                "fill_probability": predicted_fill_probability,
                "latency_ms": predicted_latency_ms,
                "queue_priority_risk": predicted_queue_ahead_qty,
            },
            "candidates": [
                {
                    "venue": venue,
                    "score": route_score,
                    "fill_probability": predicted_fill_probability,
                    "latency_ms": predicted_latency_ms,
                    "queue_priority_risk": predicted_queue_ahead_qty,
                },
                {
                    "venue": str(payload.get("backup_venue") or "binance"),
                    "score": backup_score,
                    "fill_probability": max(0.0, predicted_fill_probability - 0.09),
                    "latency_ms": predicted_latency_ms + 22.0,
                    "queue_priority_risk": predicted_queue_ahead_qty + 7.0,
                },
            ],
        },
        "predictor": {
            "fill_probability": predicted_fill_probability,
            "impact_bps": predicted_impact_bps,
            "failure_source": failure_source,
            "failure_reasons": failure_reasons,
            "regime": regime,
            "network_regime": network_regime,
            "infra_health": infra_health,
        },
        "expected_latency_ms": predicted_latency_ms,
        "predicted_impact_bps": predicted_impact_bps,
        "failure_source": failure_source,
        "failure_reasons": failure_reasons,
        "regime": regime,
        "network_regime": network_regime,
        "infra_health": infra_health,
        "kairos_harness": harness,
        "metadata": {
            "kairos_harness": harness,
            "seed_kind": "synthetic_kairos_harness_replay",
            "seeded_by": seeded_by,
            "validation_source": validation_source,
        },
        "webhook_execution": {
            "decision_id": decision_id,
            "symbol": symbol,
            "side": side,
            "account_id": account_id,
        },
        "router_execution": {
            "decision_id": decision_id,
            "instrument": symbol,
            "side": side,
            "venue": venue,
            "expected_slippage_bps": expected_slippage_bps,
            "realized_slippage_bps": realized_slippage_bps,
            "kairos_harness": harness,
        },
    }
    telemetry_id = str(uuid4())
    ts_decision = now - timedelta(milliseconds=int(realized_latency_ms + 40.0))
    ts_intent = ts_decision + timedelta(milliseconds=8)
    ts_routing = ts_intent + timedelta(milliseconds=11)
    ts_broker_accept = ts_routing + timedelta(milliseconds=19)
    ts_fill_partial = ts_broker_accept + timedelta(milliseconds=max(5, int(realized_latency_ms * 0.35)))
    ts_fill_final = ts_decision + timedelta(milliseconds=max(1, int(realized_latency_ms)))
    execute(
        """
        INSERT INTO execution_telemetry (
          telemetry_id, decision_id, account_id, symbol, side, lots,
          route_chosen, route_backup, route_reason, route_score, backup_score,
          quote_spread_bps, available_depth_usd,
          expected_slippage_bps, realized_slippage_bps, latency_e2e_ms,
          ts_decision, ts_intent, ts_routing, ts_broker_accept, ts_fill_partial, ts_fill_final,
          payload
        ) VALUES (
          %s, %s, %s, %s, %s, %s,
          %s, %s, %s, %s, %s,
          %s, %s,
          %s, %s, %s,
          %s, %s, %s, %s, %s, %s,
          %s::jsonb
        )
        """,
        (
            telemetry_id,
            decision_id,
            account_id,
            symbol,
            side,
            quantity,
            venue,
            str(payload.get("backup_venue") or "binance"),
            route_reason,
            route_score,
            backup_score,
            quote_spread_bps,
            available_depth_usd,
            expected_slippage_bps,
            realized_slippage_bps,
            int(max(1.0, realized_latency_ms)),
            ts_decision,
            ts_intent,
            ts_routing,
            ts_broker_accept,
            ts_fill_partial,
            ts_fill_final,
            json_dumps(telemetry_payload),
        ),
    )
    overrides = {
        "sample_id": str(payload.get("sample_id") or f"rg-seed-{decision_id}"),
        "symbol": symbol,
        "venue": venue,
        "side": side,
        "regime": regime,
        "failure_source": failure_source,
        "failure_reasons": failure_reasons,
        "predicted_fill_probability": predicted_fill_probability,
        "realized_fill_ratio": realized_fill_ratio,
        "predicted_slippage_bps": expected_slippage_bps,
        "realized_slippage_bps": realized_slippage_bps,
        "predicted_latency_ms": predicted_latency_ms,
        "realized_latency_ms": realized_latency_ms,
        "predicted_impact_bps": predicted_impact_bps,
        "realized_impact_bps": realized_impact_bps,
        "predicted_queue_ahead_qty": predicted_queue_ahead_qty,
        "realized_queue_ahead_qty": realized_queue_ahead_qty,
        "metadata": {
            "seed_kind": "synthetic_kairos_harness_replay",
            "seeded_by": seeded_by,
            "validation_source": validation_source,
            "notional_usd": notional_usd,
            "price": base_price,
            "kairos_harness": harness,
        },
    }
    replay_payload = _execution_replay_payload(decision_id)
    sample = _build_reality_gap_sample_from_replay(decision_id, replay_payload, overrides)
    return decision_id, harness, replay_payload, sample, {
        "telemetry_id": telemetry_id,
        "validation_source": validation_source,
    }


def _kill_switch_thresholds() -> dict[str, float]:
    return {
        "max_api_errors": float(os.getenv("KILL_MAX_API_ERRORS", "5")),
        "max_slippage_bps": float(os.getenv("KILL_MAX_SLIPPAGE_BPS", "30")),
        "max_drawdown_intraday": float(os.getenv("KILL_MAX_DRAWDOWN_INTRADAY_USD", "1500")),
    }


def _memory_ab_enabled() -> bool:
    return os.getenv("MEMORY_AB_ENABLED", "1").strip().lower() not in {"0", "false", "no"}


def _auto_resume_enabled() -> bool:
    return os.getenv("AUTO_RESUME_ENABLED", "1").strip().lower() not in {"0", "false", "no"}


def _auto_resume_cooldown_hours() -> int:
    raw = os.getenv("AUTO_RESUME_COOLDOWN_HOURS", "24")
    try:
        return max(1, min(24 * 14, int(raw)))
    except ValueError:
        return 24


def _drift_window_hours() -> int:
    raw = os.getenv("DRIFT_WINDOW_HOURS", "168")
    try:
        return max(24, min(24 * 30, int(raw)))
    except ValueError:
        return 168


def _kill_switch_state() -> dict:
    stored = fetch_one("SELECT config_value FROM system_config WHERE config_key = 'kill_switch_state'")
    if not stored:
        return {
            "active": False,
            "reason": "",
            "activated_at": None,
            "stats": {"api_errors": 0, "high_slippage_events": 0, "drawdown_intraday_usd": 0.0},
        }
    return stored["config_value"]


def _save_kill_switch_state(state: dict) -> None:
    execute(
        """
        INSERT INTO system_config (config_key, config_value)
        VALUES ('kill_switch_state', %s::jsonb)
        ON CONFLICT (config_key) DO UPDATE SET config_value = EXCLUDED.config_value, updated_at = NOW()
        """,
        (json_dumps(state),),
    )


def _load_connector_accounts() -> list[dict]:
    row = fetch_one("SELECT config_value FROM system_config WHERE config_key = 'connector_linked_accounts'")
    if not row:
        return []
    raw = row.get("config_value")
    return raw if isinstance(raw, list) else []


def _save_connector_accounts(accounts: list[dict]) -> None:
    execute(
        """
        INSERT INTO system_config (config_key, config_value)
        VALUES ('connector_linked_accounts', %s::jsonb)
        ON CONFLICT (config_key) DO UPDATE SET config_value = EXCLUDED.config_value, updated_at = NOW()
        """,
        (json_dumps(accounts),),
    )


def _replace_connector_account_record(accounts: list[dict], record: dict) -> list[dict]:
    provider = _normalize_connector_provider(record.get("provider"))
    account_id = _normalize_account_id(record.get("account_id"))
    remaining = [
        item
        for item in accounts
        if not (
            _normalize_connector_provider(item.get("provider")) == provider
            and _normalize_account_id(item.get("account_id")) == account_id
        )
    ]
    remaining.append(record)
    return remaining


def _load_connector_credentials_store() -> dict:
    row = fetch_one("SELECT config_value FROM system_config WHERE config_key = 'connector_credentials_store_v1'")
    if not row:
        return {}
    raw = row.get("config_value")
    return raw if isinstance(raw, dict) else {}


def _save_connector_credentials_store(store: dict) -> None:
    execute(
        """
        INSERT INTO system_config (config_key, config_value)
        VALUES ('connector_credentials_store_v1', %s::jsonb)
        ON CONFLICT (config_key) DO UPDATE SET config_value = EXCLUDED.config_value, updated_at = NOW()
        """,
        (json_dumps(store),),
    )


def _load_connector_signal_routes() -> list[dict]:
    row = fetch_one("SELECT config_value FROM system_config WHERE config_key = 'connector_signal_routes_v1'")
    if not row:
        return []
    raw = row.get("config_value")
    return raw if isinstance(raw, list) else []


def _save_connector_signal_routes(routes: list[dict]) -> None:
    execute(
        """
        INSERT INTO system_config (config_key, config_value)
        VALUES ('connector_signal_routes_v1', %s::jsonb)
        ON CONFLICT (config_key) DO UPDATE SET config_value = EXCLUDED.config_value, updated_at = NOW()
        """,
        (json_dumps(routes),),
    )


def _load_oauth_state_store() -> dict:
    row = fetch_one("SELECT config_value FROM system_config WHERE config_key = 'connector_oauth_state_v1'")
    if not row:
        return {}
    raw = row.get("config_value")
    return raw if isinstance(raw, dict) else {}


def _save_oauth_state_store(store: dict) -> None:
    execute(
        """
        INSERT INTO system_config (config_key, config_value)
        VALUES ('connector_oauth_state_v1', %s::jsonb)
        ON CONFLICT (config_key) DO UPDATE SET config_value = EXCLUDED.config_value, updated_at = NOW()
        """,
        (json_dumps(store),),
    )


def _credentials_master_key() -> bytes:
    file_path = os.getenv("CONNECTOR_CREDENTIALS_KEY_FILE", "").strip()
    raw = ""
    if file_path:
        try:
            with open(file_path, "r", encoding="utf-8") as handle:
                raw = handle.read().strip()
        except OSError:
            raw = ""
    if not raw:
        raw = os.getenv("CONNECTOR_CREDENTIALS_KEY", "").strip()
    if not raw:
        # Fallback stable key derived from app secret to avoid plaintext storage.
        raw = _secret_env("APPROVAL_HMAC_SECRET", "mission-control-secret")
    return hashlib.sha256(raw.encode("utf-8")).digest()


def _xor_bytes(payload: bytes, stream: bytes) -> bytes:
    return bytes(a ^ b for a, b in zip(payload, stream))


def _derive_keystream(key: bytes, nonce: bytes, length: int) -> bytes:
    blocks: list[bytes] = []
    counter = 0
    while len(b"".join(blocks)) < length:
        blocks.append(hmac.new(key, nonce + counter.to_bytes(8, "big"), hashlib.sha256).digest())
        counter += 1
    return b"".join(blocks)[:length]


def _encrypt_secret_payload(secret_payload: dict) -> dict:
    key = _credentials_master_key()
    nonce = os.urandom(16)
    plaintext = json_dumps(secret_payload).encode("utf-8")
    keystream = _derive_keystream(key, nonce, len(plaintext))
    ciphertext = _xor_bytes(plaintext, keystream)
    mac = hmac.new(key, nonce + ciphertext, hashlib.sha256).hexdigest()
    return {
        "v": 1,
        "nonce": base64.b64encode(nonce).decode("ascii"),
        "ciphertext": base64.b64encode(ciphertext).decode("ascii"),
        "mac": mac,
    }


def _decrypt_secret_payload(envelope: dict) -> dict:
    if int(envelope.get("v", 0)) != 1:
        raise ValueError("unsupported credential envelope version")
    key = _credentials_master_key()
    nonce = base64.b64decode(str(envelope.get("nonce", "")).encode("ascii"))
    ciphertext = base64.b64decode(str(envelope.get("ciphertext", "")).encode("ascii"))
    mac = str(envelope.get("mac", ""))
    expected = hmac.new(key, nonce + ciphertext, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(mac, expected):
        raise ValueError("credential envelope integrity check failed")
    keystream = _derive_keystream(key, nonce, len(ciphertext))
    plaintext = _xor_bytes(ciphertext, keystream)
    data = json.loads(plaintext.decode("utf-8"))
    return data if isinstance(data, dict) else {}


def _store_encrypted_connector_credential(provider: str, account_id: str, auth_method: str, secret_payload: dict, created_by: str) -> str:
    store = _load_connector_credentials_store()
    credential_id = f"cred-{uuid4()}"
    store[credential_id] = {
        "provider": provider,
        "account_id": account_id,
        "auth_method": auth_method,
        "created_by": created_by,
        "created_at": _now_utc().isoformat(),
        "envelope": _encrypt_secret_payload(secret_payload),
    }
    _save_connector_credentials_store(store)
    return credential_id


def _load_decrypted_connector_credential(credential_id: str) -> dict | None:
    credential_key = str(credential_id or "").strip()
    if not credential_key:
        return None
    store = _load_connector_credentials_store()
    record = store.get(credential_key)
    if not isinstance(record, dict):
        return None
    envelope = record.get("envelope")
    if not isinstance(envelope, dict):
        return None
    try:
        secret_payload = _decrypt_secret_payload(envelope)
    except Exception as exc:
        append_audit(
            "connector_credential_decrypt_failed",
            {"credential_id": credential_key, "detail": str(exc)[:300]},
        )
        return None
    hydrated = dict(record)
    hydrated["secret_payload"] = secret_payload
    return hydrated


def _latest_connector_credential_for_account(provider: str, account_id: str) -> dict | None:
    provider_norm = _normalize_connector_provider(provider)
    account_key = _normalize_account_id(account_id)
    if not provider_norm or not account_key:
        return None
    store = _load_connector_credentials_store()
    candidates: list[dict[str, Any]] = []
    for credential_id, record in store.items():
        if not isinstance(record, dict):
            continue
        if _normalize_connector_provider(record.get("provider")) != provider_norm:
            continue
        if _normalize_account_id(record.get("account_id")) != account_key:
            continue
        hydrated = _load_decrypted_connector_credential(str(credential_id))
        if isinstance(hydrated, dict):
            candidates.append(hydrated)
    if not candidates:
        return None
    candidates.sort(key=lambda item: str(item.get("created_at") or ""), reverse=True)
    return candidates[0]


def _find_connector_account_for_canonical_account(account: dict | None) -> dict | None:
    if not isinstance(account, dict):
        return None
    account_id = _normalize_account_id(account.get("account_id"))
    account_connector_type = str(account.get("connector_type") or "").strip().lower()
    account_external_ref = _normalize_account_id(account.get("external_ref"))
    return next(
        (
            item
            for item in _load_connector_accounts()
            if _normalize_account_id(item.get("account_id")) in {account_id, account_external_ref}
            and (
                not account_connector_type
                or str(item.get("provider") or "").strip().lower() == account_connector_type
                or account_connector_type == "mt5"
            )
        ),
        None,
    )


def _connector_account_public_view(connector_account: dict | None) -> dict | None:
    connector_view = dict(connector_account) if isinstance(connector_account, dict) else None
    if connector_view is None:
        return None
    connector_view.pop("oauth_tokens", None)
    connector_view.pop("api_key", None)
    connector_view.pop("api_secret", None)
    connector_view.pop("passphrase", None)
    connector_view["has_credentials"] = bool(connector_view.get("credential_id"))
    connector_view["broker_capabilities"] = _derive_broker_capabilities_view(connector_view)
    return connector_view


def _normalize_connector_provider(value: Any) -> str:
    raw = str(value or "").strip().lower()
    aliases = {
        "binance-public": "binance",
        "coinbase-public": "coinbase",
        "okx-public": "okx",
        "paper-bingx": "bingx",
        "paper-bitget": "bitget",
        "paper-coinbase": "coinbase",
        "paper-kraken": "kraken",
        "paper-okx": "okx",
    }
    return aliases.get(raw, raw)


def _exchange_capabilities(provider: str) -> dict[str, Any]:
    provider_norm = _normalize_connector_provider(provider)
    raw = EXCHANGE_CAPABILITIES.get(provider_norm) if provider_norm else None
    capabilities = raw if isinstance(raw, dict) else {}
    return {
        "provider": provider_norm or "unknown",
        "known": isinstance(raw, dict),
        "data": _bool_from_any(capabilities.get("data"), False),
        "execution": _bool_from_any(capabilities.get("execution"), False),
        "l2": _bool_from_any(capabilities.get("l2"), False),
        "l3": _bool_from_any(capabilities.get("l3"), False),
        "preferred_venue": _provider_to_preferred_venue(provider_norm) if provider_norm else "",
        "execution_venue": str(capabilities.get("execution_venue") or "").strip(),
        "api_key_requires_passphrase": _bool_from_any(capabilities.get("api_key_requires_passphrase"), False),
        "capability_source": "exchange-capabilities",
    }


def _exchange_capability_catalog() -> dict[str, Any]:
    providers = sorted(EXCHANGE_CAPABILITIES.keys())
    provider_rows = [_exchange_capabilities(provider) for provider in providers]
    return {
        "status": "ok",
        "version": "2026-04-10",
        "capability_source": "exchange-capabilities",
        "providers": provider_rows,
        "by_provider": {
            str(item.get("provider") or "unknown"): item
            for item in provider_rows
            if isinstance(item, dict)
        },
    }


def _derive_broker_capabilities_view(connector_account: dict | None) -> dict[str, Any]:
    account = connector_account if isinstance(connector_account, dict) else {}
    provider = _normalize_connector_provider(account.get("provider"))
    exchange_capabilities = _exchange_capabilities(provider)
    mode = str(account.get("mode") or "trade").strip().lower()
    provider_type = str(account.get("provider_type") or "manual").strip().lower()
    preferred_venue = _provider_to_preferred_venue(provider) if provider else ""
    can_trade = mode == "trade" and provider_type not in {"wallet"}
    supports_execution = can_trade and _bool_from_any(exchange_capabilities.get("execution"), False)
    supports_cancel_replace = supports_execution and provider == "bingx"
    supports_modify = False
    replace_strategy = "modify" if supports_modify else "cancel_replace" if supports_cancel_replace else "reslice_only"
    capability_source = str(exchange_capabilities.get("capability_source") or ("provider-matrix" if provider else "unknown"))
    return {
        "provider": provider or "unknown",
        "preferred_venue": preferred_venue,
        "supports_execution": supports_execution,
        "supports_market_data": _bool_from_any(exchange_capabilities.get("data"), False),
        "supports_l2": _bool_from_any(exchange_capabilities.get("l2"), False),
        "supports_l3": _bool_from_any(exchange_capabilities.get("l3"), False),
        "supports_modify": supports_modify,
        "supports_cancel_replace": supports_cancel_replace,
        "supports_live_cancel": supports_cancel_replace,
        "replace_strategy": replace_strategy,
        "capability_source": capability_source,
    }


def _normalize_scope_values(raw: Any) -> list[str]:
    values: list[str] = []
    if isinstance(raw, list):
        values = [str(item).strip().lower() for item in raw if str(item).strip()]
    elif isinstance(raw, str):
        values = [part.strip().lower() for part in raw.replace(",", " ").split() if part.strip()]
    deduped: list[str] = []
    seen: set[str] = set()
    for item in values:
        if item not in seen:
            deduped.append(item)
            seen.add(item)
    return deduped


def _connector_signature_policy(provider: str, provider_type: str, auth_method: str) -> str:
    provider_norm = _normalize_connector_provider(provider)
    auth_norm = str(auth_method or "manual").strip().lower()
    provider_type_norm = str(provider_type or "manual").strip().lower()
    if provider_norm in {"ledger", "trezor"}:
        return "hardware-signer"
    if provider_norm in {"safe", "fireblocks"} or auth_norm in {"safe-api", "custody-api"}:
        return "mpc-or-governed-signer"
    if provider_type_norm == "wallet" and auth_norm in {"walletconnect", "wallet_public_key", "watch-only-or-signing"}:
        return "external-wallet-signer"
    if auth_norm == "oauth":
        return "oauth-delegated"
    if auth_norm == "api_key":
        return "api-hmac"
    return "manual-or-bridge"


def _derive_connector_permission_view(connector_account: dict | None) -> dict[str, Any]:
    if not isinstance(connector_account, dict):
        return {
            "scopes": [],
            "permissions": {"read": False, "trade": False, "withdraw": False, "transfer": False, "sign": False},
            "rate_limits": {},
            "subaccount_restrictions": [],
            "withdraw_whitelist": [],
            "signature_policy": "unknown",
        }

    provider = _normalize_connector_provider(connector_account.get("provider"))
    provider_type = str(connector_account.get("provider_type") or "manual").strip().lower()
    auth_method = str(connector_account.get("auth_method") or "manual").strip().lower()
    metadata = connector_account.get("metadata") if isinstance(connector_account.get("metadata"), dict) else {}
    credential = _load_decrypted_connector_credential(str(connector_account.get("credential_id") or ""))
    secret_payload = credential.get("secret_payload") if isinstance(credential, dict) and isinstance(credential.get("secret_payload"), dict) else {}

    scopes = _normalize_scope_values(secret_payload.get("scopes"))
    if not scopes:
        scopes = _normalize_scope_values(metadata.get("scopes"))
    if not scopes:
        if provider_type == "wallet":
            scopes = ["read", "sign"]
        elif str(connector_account.get("mode") or "trade").strip().lower() == "read":
            scopes = ["read"]
        else:
            scopes = ["read", "trade"]

    scope_set = set(scopes)
    permissions = {
        "read": bool(scope_set.intersection({"read", "view", "balance", "account"})) or True,
        "trade": bool(scope_set.intersection({"trade", "orders", "execute", "futures"})) or str(connector_account.get("mode") or "trade").strip().lower() == "trade",
        "withdraw": bool(scope_set.intersection({"withdraw", "withdrawal"})),
        "transfer": bool(scope_set.intersection({"transfer", "fund", "funding"})),
        "sign": provider_type == "wallet" or auth_method in {"walletconnect", "wallet_public_key", "safe-api", "custody-api", "watch-only-or-signing"},
    }

    withdraw_whitelist = metadata.get("withdraw_whitelist") if isinstance(metadata.get("withdraw_whitelist"), list) else metadata.get("address_whitelist") if isinstance(metadata.get("address_whitelist"), list) else []
    subaccount_restrictions = metadata.get("subaccount_restrictions") if isinstance(metadata.get("subaccount_restrictions"), list) else metadata.get("subaccounts") if isinstance(metadata.get("subaccounts"), list) else []
    rate_limits = metadata.get("rate_limits") if isinstance(metadata.get("rate_limits"), dict) else CONNECTOR_RATE_LIMIT_HINTS.get(provider, {})

    return {
        "scopes": scopes,
        "permissions": permissions,
        "rate_limits": rate_limits,
        "subaccount_restrictions": [str(item) for item in subaccount_restrictions],
        "withdraw_whitelist": [str(item) for item in withdraw_whitelist],
        "signature_policy": _connector_signature_policy(provider, provider_type, auth_method),
    }


def _incident_text_blob(row: dict | None) -> str:
    if not isinstance(row, dict):
        return ""
    payload = row.get("payload") if isinstance(row.get("payload"), dict) else {}
    parts = [
        str(row.get("ticket_key") or ""),
        str(row.get("title") or ""),
        str(row.get("source") or ""),
        json_dumps(payload) if payload else "",
    ]
    return " ".join(part for part in parts if part).lower()


def _infer_connector_provider_from_incident(row: dict | None) -> str:
    blob = _incident_text_blob(row)
    if not blob:
        return ""
    providers = sorted((str(item.get("name") or "") for item in CONNECTOR_CATALOG), key=len, reverse=True)
    for provider in providers:
        if provider and provider in blob:
            return provider
    if "429" in blob or "throttle" in blob or "nonce" in blob:
        return "broker-adapter"
    return ""


def _incident_diagnostics_from_row(row: dict | None) -> list[str]:
    blob = _incident_text_blob(row)
    diagnostics: list[str] = []
    if any(token in blob for token in {" 429", "429", "rate limit", "throttle"}):
        diagnostics.append("rest-429-throttle")
    if "nonce" in blob:
        diagnostics.append("invalid-nonce")
    if any(token in blob for token in {"websocket", "ws drop", "ws disconnect", "socket"}):
        diagnostics.append("ws-drop")
    if "timeout" in blob:
        diagnostics.append("timeout")
    if any(token in blob for token in {"auth", "signature", "credential", "permission"}):
        diagnostics.append("auth-signature")
    if any(token in blob for token in {"gap", "desync", "stale", "freshness"}):
        diagnostics.append("feed-gap-desync")
    if not diagnostics:
        diagnostics.append("operator-review")
    return diagnostics


def _incident_severity_weight(severity: str) -> float:
    return {
        "low": 1.0,
        "medium": 2.0,
        "high": 4.0,
        "critical": 7.0,
    }.get(str(severity or "").strip().lower(), 1.5)


def _uptime_from_incident_score(score: float) -> float:
    return round(max(0.0, min(100.0, 100.0 - score)), 2)


def _build_connector_incident_summary(rows: list[dict]) -> dict[str, dict[str, Any]]:
    now = _now_utc()
    grouped: dict[str, dict[str, Any]] = {}
    for row in rows:
        provider = _infer_connector_provider_from_incident(row)
        if not provider:
            continue
        diagnostics = _incident_diagnostics_from_row(row)
        created_at = _parse_iso_utc(str(row.get("created_at") or row.get("updated_at") or ""))
        summary = grouped.setdefault(
            provider,
            {
                "provider": provider,
                "active_count": 0,
                "open_count": 0,
                "closed_count": 0,
                "critical_count": 0,
                "throttling_count": 0,
                "diagnostics": {},
                "last_incident_at": None,
                "uptime_24h_pct": 100.0,
                "uptime_7d_pct": 100.0,
                "score_24h": 0.0,
                "score_7d": 0.0,
                "history": [],
            },
        )
        status = str(row.get("status") or "open").strip().lower()
        severity = str(row.get("severity") or "medium").strip().lower()
        if status != "closed":
            summary["active_count"] = int(summary.get("active_count") or 0) + 1
        if status in {"open", "assigned"}:
            summary["open_count"] = int(summary.get("open_count") or 0) + 1
        if status == "closed":
            summary["closed_count"] = int(summary.get("closed_count") or 0) + 1
        if severity == "critical":
            summary["critical_count"] = int(summary.get("critical_count") or 0) + 1
        if "rest-429-throttle" in diagnostics:
            summary["throttling_count"] = int(summary.get("throttling_count") or 0) + 1
        diagnostic_counts = summary.get("diagnostics") if isinstance(summary.get("diagnostics"), dict) else {}
        for diagnostic in diagnostics:
            diagnostic_counts[diagnostic] = int(diagnostic_counts.get(diagnostic) or 0) + 1
        summary["diagnostics"] = diagnostic_counts
        if created_at and (summary.get("last_incident_at") is None or str(created_at.isoformat()) > str(summary.get("last_incident_at") or "")):
            summary["last_incident_at"] = created_at.isoformat()
        if created_at:
            age_hours = max(0.0, (now - created_at).total_seconds() / 3600.0)
            score = _incident_severity_weight(severity) * (1.2 if status != "closed" else 0.4)
            if age_hours <= 24:
                summary["score_24h"] = _to_float(summary.get("score_24h"), 0.0) + score * 4.5
            if age_hours <= 24 * 7:
                summary["score_7d"] = _to_float(summary.get("score_7d"), 0.0) + score * 1.2
        history = summary.get("history") if isinstance(summary.get("history"), list) else []
        if len(history) < 6:
            history.append(
                {
                    "ticket_key": row.get("ticket_key"),
                    "severity": severity,
                    "status": status,
                    "title": row.get("title"),
                    "created_at": created_at.isoformat() if created_at else row.get("created_at"),
                    "diagnostics": diagnostics,
                }
            )
        summary["history"] = history

    for summary in grouped.values():
        summary["uptime_24h_pct"] = _uptime_from_incident_score(_to_float(summary.get("score_24h"), 0.0))
        summary["uptime_7d_pct"] = _uptime_from_incident_score(_to_float(summary.get("score_7d"), 0.0))
        diagnostic_counts = summary.get("diagnostics") if isinstance(summary.get("diagnostics"), dict) else {}
        summary["top_diagnostic"] = max(diagnostic_counts, key=diagnostic_counts.get) if diagnostic_counts else None
    return grouped


def _connector_market_observability(provider: str) -> dict[str, Any]:
    provider_norm = _normalize_connector_provider(provider)
    venue_candidates = [
        CONNECTOR_MARKET_OBSERVABILITY_VENUES.get(provider_norm) or "",
        _provider_to_preferred_venue(provider_norm),
        f"{provider_norm}-public" if provider_norm else "",
        f"paper-{provider_norm}" if provider_norm else "",
    ]
    seen_venues: set[str] = set()
    normalized_venues: list[str] = []
    for venue in venue_candidates:
        venue_norm = str(venue or "").strip().lower()
        if not venue_norm or venue_norm in seen_venues:
            continue
        seen_venues.add(venue_norm)
        normalized_venues.append(venue_norm)
    if not normalized_venues:
        return {
            "venue": None,
            "instrument": None,
            "ws_latency_ms": None,
            "depth_levels": None,
            "messages_per_sec": None,
            "gap_count": None,
            "desync_ms": None,
            "feed_quality_score": None,
            "feed_quality_status": "not-instrumented",
            "spread_bps": None,
        }

    latest_depth = _normalize_db_row(
        fetch_one(
            """
            SELECT venue, instrument, snapshot_at, spread_bps, depth_payload, source
            FROM market_orderbook_snapshots
            WHERE venue = ANY(%s)
            ORDER BY snapshot_at DESC
            LIMIT 1
            """,
            (normalized_venues,),
        )
    ) or {}
    observed_venue = str(latest_depth.get("venue") or "").strip().lower()
    observed_instrument = str(latest_depth.get("instrument") or "").strip()
    latest_trade_row: dict[str, Any] = {}
    latest_bar_row: dict[str, Any] = {}

    if not observed_venue or not observed_instrument:
        latest_bar_row = _normalize_db_row(
            fetch_one(
                """
                SELECT venue, instrument, bucket_start
                FROM market_ohlcv
                WHERE venue = ANY(%s) AND timeframe = '1m'
                ORDER BY bucket_start DESC
                LIMIT 1
                """,
                (normalized_venues,),
            )
        ) or {}
        observed_venue = str(latest_bar_row.get("venue") or observed_venue).strip().lower()
        observed_instrument = str(latest_bar_row.get("instrument") or observed_instrument).strip()

    if not observed_venue or not observed_instrument:
        latest_trade_row = _normalize_db_row(
            fetch_one(
                """
                SELECT venue, instrument, traded_at
                FROM market_trades
                WHERE venue = ANY(%s)
                ORDER BY traded_at DESC
                LIMIT 1
                """,
                (normalized_venues,),
            )
        ) or {}
        observed_venue = str(latest_trade_row.get("venue") or observed_venue).strip().lower()
        observed_instrument = str(latest_trade_row.get("instrument") or observed_instrument).strip()

    if not observed_venue or not observed_instrument:
        quote_fallback = _connector_market_quote_fallback(normalized_venues)
        if quote_fallback:
            return quote_fallback
        return {
            "venue": normalized_venues[0],
            "instrument": None,
            "ws_latency_ms": None,
            "depth_levels": None,
            "messages_per_sec": None,
            "gap_count": None,
            "desync_ms": None,
            "feed_quality_score": None,
            "feed_quality_status": "not-instrumented",
            "spread_bps": None,
        }

    if not latest_depth or str(latest_depth.get("venue") or "").strip().lower() != observed_venue or str(latest_depth.get("instrument") or "").strip() != observed_instrument:
        latest_depth = _normalize_db_row(
            fetch_one(
                """
                SELECT venue, instrument, snapshot_at, spread_bps, depth_payload, source
                FROM market_orderbook_snapshots
                WHERE venue = %s AND instrument = %s
                ORDER BY snapshot_at DESC
                LIMIT 1
                """,
                (observed_venue, observed_instrument),
            )
        ) or {}

    depth_rows = _normalize_db_rows(
        fetch_all(
            """
            SELECT snapshot_at
            FROM market_orderbook_snapshots
            WHERE venue = %s AND instrument = %s
              AND snapshot_at >= NOW() - INTERVAL '5 minutes'
            ORDER BY snapshot_at ASC
            """,
                        (observed_venue, observed_instrument),
        )
    )
    trade_count_row = fetch_one(
        """
        SELECT COUNT(*) AS count
        FROM market_trades
        WHERE venue = %s AND instrument = %s
          AND traded_at >= NOW() - INTERVAL '5 minutes'
        """,
        (observed_venue, observed_instrument),
    ) or {"count": 0}
    if not latest_trade_row or str(latest_trade_row.get("venue") or "").strip().lower() != observed_venue or str(latest_trade_row.get("instrument") or "").strip() != observed_instrument:
        latest_trade_row = _normalize_db_row(
            fetch_one(
                """
                SELECT traded_at
                FROM market_trades
                WHERE venue = %s AND instrument = %s
                ORDER BY traded_at DESC
                LIMIT 1
                """,
                (observed_venue, observed_instrument),
            )
        ) or {}
    ohlcv_rows = _normalize_db_rows(
        fetch_all(
            """
            SELECT bucket_start
            FROM market_ohlcv
            WHERE venue = %s AND instrument = %s AND timeframe = '1m'
              AND bucket_start >= NOW() - INTERVAL '60 minutes'
            ORDER BY bucket_start ASC
            """,
            (observed_venue, observed_instrument),
        )
    )
    if not latest_bar_row or str(latest_bar_row.get("venue") or "").strip().lower() != observed_venue or str(latest_bar_row.get("instrument") or "").strip() != observed_instrument:
        latest_bar_row = _normalize_db_row(
            fetch_one(
                """
                SELECT bucket_start
                FROM market_ohlcv
                WHERE venue = %s AND instrument = %s AND timeframe = '1m'
                ORDER BY bucket_start DESC
                LIMIT 1
                """,
                (observed_venue, observed_instrument),
            )
        ) or {}

    depth_payload = latest_depth.get("depth_payload") if isinstance(latest_depth.get("depth_payload"), dict) else {}
    bids = depth_payload.get("bids") if isinstance(depth_payload.get("bids"), list) else []
    asks = depth_payload.get("asks") if isinstance(depth_payload.get("asks"), list) else []
    depth_levels = len(bids) + len(asks) if latest_depth else 0
    latest_depth_at = _parse_iso_utc(str(latest_depth.get("snapshot_at") or ""))
    latest_trade_at = _parse_iso_utc(str(latest_trade_row.get("traded_at") or ""))
    latest_bar_at = _parse_iso_utc(str((latest_bar_row or {}).get("bucket_start") or "")) if latest_bar_row or ohlcv_rows else None
    now = _now_utc()
    feed_age_candidates = [
        max(0, int((now - latest_depth_at).total_seconds() * 1000)) if latest_depth_at else None,
        max(0, int((now - latest_trade_at).total_seconds() * 1000)) if latest_trade_at else None,
    ]
    feed_age_values = [value for value in feed_age_candidates if value is not None]
    ws_latency_ms = min(feed_age_values) if feed_age_values else None
    bar_freshness_ms = max(0, int((_now_utc() - latest_bar_at).total_seconds() * 1000)) if latest_bar_at else None
    desync_ms = abs((ws_latency_ms or 0) - (bar_freshness_ms or 0)) if ws_latency_ms is not None and bar_freshness_ms is not None else None

    bucket_times = [
        _parse_iso_utc(str(row.get("bucket_start") or ""))
        for row in ohlcv_rows
        if row.get("bucket_start")
    ]
    gap_count = 0
    if bucket_times:
        previous = None
        for bucket in bucket_times:
            if not bucket:
                continue
            if previous is not None:
                delta_minutes = int((bucket - previous).total_seconds() // 60)
                if delta_minutes > 1:
                    gap_count += delta_minutes - 1
            previous = bucket
        gap_count += max(0, 60 - len(bucket_times))
    else:
        gap_count = None
    messages_per_sec = round((len(depth_rows) + int(trade_count_row.get("count") or 0)) / 300.0, 3)
    penalty = 0.0
    if ws_latency_ms is not None:
        penalty += min(45.0, ws_latency_ms / 2500.0)
    else:
        penalty += 35.0
    if gap_count is not None:
        penalty += min(25.0, gap_count * 4.0)
    if desync_ms is not None:
        penalty += min(20.0, (desync_ms / 1000.0) * 1.2)
    if messages_per_sec <= 0.01:
        penalty += 12.0
    if depth_levels == 0:
        penalty += 6.0
    feed_quality_score = round(max(0.0, 100.0 - penalty), 2)
    if feed_quality_score >= 92:
        feed_quality_status = "clean"
    elif feed_quality_score >= 75:
        feed_quality_status = "watch"
    elif feed_quality_score >= 55:
        feed_quality_status = "degraded"
    else:
        feed_quality_status = "critical"
    return {
        "venue": observed_venue,
        "instrument": observed_instrument,
        "ws_latency_ms": ws_latency_ms,
        "depth_levels": depth_levels,
        "messages_per_sec": messages_per_sec,
        "gap_count": gap_count,
        "desync_ms": desync_ms,
        "feed_quality_score": feed_quality_score,
        "feed_quality_status": feed_quality_status,
        "spread_bps": _to_float(latest_depth.get("spread_bps"), 0.0) if latest_depth else None,
    }


def _connector_market_quote_fallback(venue_candidates: list[str]) -> dict[str, Any] | None:
    if not venue_candidates:
        return None
    try:
        with httpx.Client(timeout=3.0) as client:
            response = client.get(f"{MARKET_DATA_URL}/v1/quotes")
            if response.status_code >= 400:
                return None
            payload = response.json()
            quotes = payload if isinstance(payload, list) else []
            quote = next(
                (
                    item for item in quotes
                    if isinstance(item, dict) and str(item.get("venue") or "").strip().lower() in venue_candidates
                ),
                None,
            )
            if not isinstance(quote, dict):
                return None
            venue = str(quote.get("venue") or venue_candidates[0]).strip().lower()
            instrument = str(quote.get("instrument") or "").strip()
            depth_levels = None
            spread_bps = _to_float(quote.get("spread_bps"), None)
            try:
                depth_response = client.get(
                    f"{MARKET_DATA_URL}/v1/market/orderbook/depth",
                    params={"venue": venue, "instrument": instrument},
                )
                if depth_response.status_code < 400:
                    depth_payload = depth_response.json()
                    if isinstance(depth_payload, dict):
                        depth = depth_payload.get("depth_payload") if isinstance(depth_payload.get("depth_payload"), dict) else {}
                        bids = depth.get("bids") if isinstance(depth.get("bids"), list) else []
                        asks = depth.get("asks") if isinstance(depth.get("asks"), list) else []
                        if bids or asks:
                            depth_levels = len(bids) + len(asks)
                        if spread_bps is None:
                            spread_bps = _to_float(depth_payload.get("spread_bps"), None)
            except Exception:
                pass

            updated_at = _parse_iso_utc(str(quote.get("updated_at") or ""))
            ws_latency_ms = max(0, int((_now_utc() - updated_at).total_seconds() * 1000)) if updated_at else None
            if ws_latency_ms is None:
                feed_quality_status = "watch"
                feed_quality_score = 72.0
            elif ws_latency_ms <= 15_000:
                feed_quality_status = "watch"
                feed_quality_score = 84.0
            elif ws_latency_ms <= 60_000:
                feed_quality_status = "degraded"
                feed_quality_score = 64.0
            else:
                feed_quality_status = "critical"
                feed_quality_score = 42.0

            return {
                "venue": venue,
                "instrument": instrument or None,
                "ws_latency_ms": ws_latency_ms,
                "depth_levels": depth_levels,
                "messages_per_sec": 0.0,
                "gap_count": None,
                "desync_ms": None,
                "feed_quality_score": feed_quality_score,
                "feed_quality_status": feed_quality_status,
                "spread_bps": spread_bps,
            }
    except Exception:
        return None
    return None


def _connector_canonical_accounts(provider: str, visible_client_ids: list[str] | None) -> list[dict[str, Any]]:
    provider_norm = _normalize_connector_provider(provider)
    venue_candidates = list({provider_norm, _provider_to_preferred_venue(provider_norm), CONNECTOR_MARKET_OBSERVABILITY_VENUES.get(provider_norm) or ""})
    params: list[Any] = [provider_norm, [candidate for candidate in venue_candidates if candidate]]
    where_sql = "WHERE (LOWER(COALESCE(connector_type, '')) = %s OR LOWER(COALESCE(venue, '')) = ANY(%s))"
    if visible_client_ids is not None:
        if not visible_client_ids:
            return []
        where_sql += " AND client_id = ANY(%s)"
        params.append(visible_client_ids)
    return _normalize_db_rows(
        fetch_all(
            f"""
            SELECT account_id, client_id, venue, connector_type, display_name, external_ref, metadata
            FROM accounts_registry
            {where_sql}
            ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, account_id ASC
            """,
            tuple(params),
        )
    )


def _connector_capital_rollup(provider: str, visible_client_ids: list[str] | None) -> dict[str, Any]:
    accounts = _connector_canonical_accounts(provider, visible_client_ids)
    if not accounts:
        return {
            "account_count": 0,
            "actual_equivalent_usd": 0.0,
            "actual_raw_cash_usd": 0.0,
            "inventory_usd": 0.0,
            "gross_exposure_usd": 0.0,
            "net_exposure_usd": 0.0,
            "margin_available_usd": 0.0,
            "solvency_ratio_pct": 100.0,
            "concentration_pct": 0.0,
            "target_cap_usd": 0.0,
            "drift_vs_fund_manager_usd": 0.0,
            "net_external_cashflow_usd": 0.0,
            "funding_fee_usd": 0.0,
            "internal_transfer_usd": 0.0,
            "pockets": [],
            "accounts": [],
            "top_risks": [],
        }

    pocket_breakdown: dict[str, dict[str, Any]] = {}
    symbol_exposure: dict[str, float] = {}
    total_equivalent_usd = 0.0
    total_raw_cash_usd = 0.0
    total_gross_exposure_usd = 0.0
    total_net_exposure_usd = 0.0
    total_margin_available_usd = 0.0
    total_target_cap_usd = 0.0
    total_net_external_cashflow_usd = 0.0
    total_funding_fee_usd = 0.0
    total_internal_transfer_usd = 0.0
    account_rows: list[dict[str, Any]] = []

    for account in accounts:
        account_id = str(account.get("account_id") or "").strip()
        balances = _latest_account_balances(account_id)
        positions = _latest_account_positions(account_id)
        summary = _cash_vs_equivalent_summary(balances)
        pockets = _build_pocket_capital_views(balances)
        ledger_summary = (_account_capital_ledger(account_id, limit=60).get("summary") if account_id else {}) or {}
        gross_exposure = 0.0
        net_exposure = 0.0
        account_symbol_exposure: dict[str, float] = {}
        for position in positions:
            if not isinstance(position, dict):
                continue
            symbol = str(position.get("symbol") or position.get("instrument") or "UNKNOWN").upper()
            side = str(position.get("side") or "flat").strip().lower()
            notional = abs(_position_metric_value(position, "notional_usd"))
            gross_exposure += notional
            signed = notional if side == "long" else (-notional if side == "short" else 0.0)
            net_exposure += signed
            account_symbol_exposure[symbol] = _to_float(account_symbol_exposure.get(symbol), 0.0) + notional
            symbol_exposure[symbol] = _to_float(symbol_exposure.get(symbol), 0.0) + notional

        margin_available_usd = sum(
            _to_float(pocket.get("raw_cash_usd"), 0.0)
            for pocket in pockets
            if str(pocket.get("pocket") or "").strip().lower() in {"futures", "fund"}
        )
        if margin_available_usd <= 0:
            margin_available_usd = _to_float(summary.get("total_raw_cash_usd"), 0.0)

        target_cap_row = fetch_one(
            "SELECT COALESCE(SUM(allocation_cap_usd), 0) AS target_cap_usd FROM portfolio_accounts WHERE account_id = %s AND status = 'active'",
            (account_id,),
        ) or {"target_cap_usd": 0.0}
        target_cap_usd = _to_float(target_cap_row.get("target_cap_usd"), 0.0)

        for pocket in pockets:
            if not isinstance(pocket, dict):
                continue
            key = str(pocket.get("pocket") or "other")
            bucket = pocket_breakdown.setdefault(
                key,
                {"pocket": key, "equivalent_usd": 0.0, "raw_cash_usd": 0.0, "inventory_usd": 0.0},
            )
            bucket["equivalent_usd"] = _to_float(bucket.get("equivalent_usd"), 0.0) + _to_float(pocket.get("equivalent_usd"), 0.0)
            bucket["raw_cash_usd"] = _to_float(bucket.get("raw_cash_usd"), 0.0) + _to_float(pocket.get("raw_cash_usd"), 0.0)
            bucket["inventory_usd"] = _to_float(bucket.get("inventory_usd"), 0.0) + _to_float(pocket.get("inventory_usd"), 0.0)

        total_equivalent_usd += _to_float(summary.get("total_equivalent_usd"), 0.0)
        total_raw_cash_usd += _to_float(summary.get("total_raw_cash_usd"), 0.0)
        total_gross_exposure_usd += gross_exposure
        total_net_exposure_usd += net_exposure
        total_margin_available_usd += margin_available_usd
        total_target_cap_usd += target_cap_usd
        total_net_external_cashflow_usd += _to_float(ledger_summary.get("net_external_cashflow_usd"), 0.0)
        total_funding_fee_usd += _to_float(ledger_summary.get("funding_fee_usd"), 0.0)
        total_internal_transfer_usd += _to_float(ledger_summary.get("internal_transfer_usd"), 0.0)

        account_rows.append(
            {
                "account_id": account_id,
                "display_name": account.get("display_name") or account_id,
                "venue": account.get("venue") or account.get("connector_type") or provider,
                "equivalent_usd": round(_to_float(summary.get("total_equivalent_usd"), 0.0), 8),
                "raw_cash_usd": round(_to_float(summary.get("total_raw_cash_usd"), 0.0), 8),
                "gross_exposure_usd": round(gross_exposure, 8),
                "margin_available_usd": round(margin_available_usd, 8),
                "target_cap_usd": round(target_cap_usd, 8),
                "largest_symbol": max(account_symbol_exposure, key=account_symbol_exposure.get) if account_symbol_exposure else None,
            }
        )

    largest_symbol = max(symbol_exposure, key=symbol_exposure.get) if symbol_exposure else None
    concentration_pct = (symbol_exposure.get(largest_symbol, 0.0) / total_gross_exposure_usd * 100.0) if largest_symbol and total_gross_exposure_usd > 0 else 0.0
    solvency_ratio_pct = (total_equivalent_usd / total_gross_exposure_usd * 100.0) if total_gross_exposure_usd > 0 else 100.0
    top_risks = [
        {"symbol": symbol, "gross_notional_usd": round(value, 8)}
        for symbol, value in sorted(symbol_exposure.items(), key=lambda item: item[1], reverse=True)[:5]
    ]
    return {
        "account_count": len(accounts),
        "actual_equivalent_usd": round(total_equivalent_usd, 8),
        "actual_raw_cash_usd": round(total_raw_cash_usd, 8),
        "inventory_usd": round(total_equivalent_usd - total_raw_cash_usd, 8),
        "gross_exposure_usd": round(total_gross_exposure_usd, 8),
        "net_exposure_usd": round(total_net_exposure_usd, 8),
        "margin_available_usd": round(total_margin_available_usd, 8),
        "solvency_ratio_pct": round(solvency_ratio_pct, 4),
        "concentration_pct": round(concentration_pct, 4),
        "target_cap_usd": round(total_target_cap_usd, 8),
        "drift_vs_fund_manager_usd": round(total_equivalent_usd - total_target_cap_usd, 8),
        "net_external_cashflow_usd": round(total_net_external_cashflow_usd, 8),
        "funding_fee_usd": round(total_funding_fee_usd, 8),
        "internal_transfer_usd": round(total_internal_transfer_usd, 8),
        "pockets": sorted(pocket_breakdown.values(), key=lambda item: _to_float(item.get("equivalent_usd"), 0.0), reverse=True),
        "accounts": account_rows,
        "top_risks": top_risks,
    }


def _connector_outcome_analytics() -> dict[str, dict[str, Any]]:
    rows = _normalize_db_rows(
        fetch_all(
            """
            SELECT LOWER(COALESCE(provider, '')) AS provider,
                   COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours') AS samples_24h,
                   COALESCE(AVG(COALESCE(latency_ms, 0)) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours'), 0) AS avg_latency_ms_24h,
                   COALESCE(AVG(ABS(COALESCE(slippage_real_bps, 0))) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours'), 0) AS avg_slippage_bps_24h,
                   COUNT(*) FILTER (
                     WHERE created_at >= NOW() - INTERVAL '24 hours'
                       AND LOWER(COALESCE(status, '')) ~ '(reject|error|fail)'
                   ) AS error_count_24h
            FROM decision_outcomes
            GROUP BY LOWER(COALESCE(provider, ''))
            """
        )
    )
    analytics: dict[str, dict[str, Any]] = {}
    for row in rows:
        provider = _normalize_connector_provider(row.get("provider"))
        if not provider:
            continue
        bucket = analytics.setdefault(provider, {"samples_24h": 0, "avg_latency_ms_24h": 0.0, "avg_slippage_bps_24h": 0.0, "error_count_24h": 0})
        bucket["samples_24h"] = int(bucket.get("samples_24h") or 0) + int(row.get("samples_24h") or 0)
        bucket["error_count_24h"] = int(bucket.get("error_count_24h") or 0) + int(row.get("error_count_24h") or 0)
        bucket["avg_latency_ms_24h"] = max(_to_float(bucket.get("avg_latency_ms_24h"), 0.0), _to_float(row.get("avg_latency_ms_24h"), 0.0))
        bucket["avg_slippage_bps_24h"] = max(_to_float(bucket.get("avg_slippage_bps_24h"), 0.0), _to_float(row.get("avg_slippage_bps_24h"), 0.0))
    for provider, bucket in analytics.items():
        samples = max(1, int(bucket.get("samples_24h") or 0))
        bucket["error_rate_pct_24h"] = round(int(bucket.get("error_count_24h") or 0) / samples * 100.0, 4) if samples > 0 else 0.0
    return analytics


def _connector_health_policy() -> dict[str, Any]:
    default = {
        "block_below": 0.70,
        "reduce_below": 0.85,
        "reduce_size_multiplier": 0.65,
        "latency_warn_ms": 80.0,
        "latency_block_ms": 120.0,
        "slippage_block_bps": 15.0,
        "max_error_rate_pct": 20.0,
        "weights": {
            "feed_quality": 0.42,
            "execution_error": 0.22,
            "latency": 0.16,
            "slippage": 0.10,
            "incidents": 0.10,
        },
    }
    raw_policy = _load_live_execution_policy()
    raw = raw_policy.get("connector_health") if isinstance(raw_policy.get("connector_health"), dict) else {}
    merged = dict(default)
    merged.update({key: value for key, value in raw.items() if key != "weights"})
    weights = dict(default["weights"])
    raw_weights = raw.get("weights") if isinstance(raw.get("weights"), dict) else {}
    for key, value in raw_weights.items():
        numeric = _to_float(value, None)
        if numeric is not None and numeric >= 0:
            weights[str(key)] = numeric
    total = sum(max(0.0, _to_float(value, 0.0)) for value in weights.values()) or 1.0
    merged["weights"] = {key: round(max(0.0, _to_float(value, 0.0)) / total, 6) for key, value in weights.items()}
    block_below = _clamp(_to_float(merged.get("block_below"), default["block_below"]), 0.35, 0.95)
    reduce_below = _clamp(_to_float(merged.get("reduce_below"), default["reduce_below"]), block_below + 0.05, 0.99)
    latency_warn_ms = max(1.0, _to_float(merged.get("latency_warn_ms"), default["latency_warn_ms"]))
    merged["block_below"] = round(block_below, 6)
    merged["reduce_below"] = round(reduce_below, 6)
    merged["reduce_size_multiplier"] = round(_clamp(_to_float(merged.get("reduce_size_multiplier"), default["reduce_size_multiplier"]), 0.1, 1.0), 6)
    merged["latency_warn_ms"] = round(latency_warn_ms, 6)
    merged["latency_block_ms"] = round(max(latency_warn_ms + 1.0, _to_float(merged.get("latency_block_ms"), default["latency_block_ms"])) , 6)
    merged["slippage_block_bps"] = round(max(1.0, _to_float(merged.get("slippage_block_bps"), default["slippage_block_bps"])), 6)
    merged["max_error_rate_pct"] = round(max(1.0, _to_float(merged.get("max_error_rate_pct"), default["max_error_rate_pct"])), 6)
    return merged


def _connector_health_score_snapshot(
    *,
    healthy: bool,
    incidents: dict[str, Any],
    market: dict[str, Any],
    outcomes: dict[str, Any],
    rest_latency_ms: float | None,
    health_policy: dict[str, Any],
) -> dict[str, Any]:
    weights = health_policy.get("weights") if isinstance(health_policy.get("weights"), dict) else {}
    feed_status = str(market.get("feed_quality_status") or "not-instrumented").strip().lower()
    feed_quality_score = _to_float(market.get("feed_quality_score"), None)
    if feed_quality_score is None:
        feed_component = 0.82 if healthy else 0.58
    else:
        feed_component = _clamp(feed_quality_score / 100.0, 0.0, 1.0)
    if feed_status == "watch":
        feed_component = min(feed_component, 0.9)
    elif feed_status == "degraded":
        feed_component = min(feed_component, 0.8)
    elif feed_status == "critical":
        feed_component = min(feed_component, 0.64)

    latency_warn_ms = _to_float(health_policy.get("latency_warn_ms"), 80.0)
    latency_block_ms = max(latency_warn_ms + 1.0, _to_float(health_policy.get("latency_block_ms"), 120.0))
    latency_ms = max(_to_float(rest_latency_ms, 0.0), _to_float(outcomes.get("avg_latency_ms_24h"), 0.0))
    if latency_ms <= 0:
        latency_component = 0.9 if healthy else 0.45
    elif latency_ms <= latency_warn_ms:
        latency_component = 1.0
    elif latency_ms >= latency_block_ms:
        latency_component = 0.45
    else:
        ratio = (latency_ms - latency_warn_ms) / max(1.0, latency_block_ms - latency_warn_ms)
        latency_component = 1.0 - ratio * 0.55

    error_rate_pct = _to_float(outcomes.get("error_rate_pct_24h"), 0.0)
    max_error_rate_pct = max(1.0, _to_float(health_policy.get("max_error_rate_pct"), 20.0))
    error_component = 1.0 - min(1.0, error_rate_pct / max_error_rate_pct)

    slippage_bps = abs(_to_float(outcomes.get("avg_slippage_bps_24h"), 0.0))
    slippage_block_bps = max(1.0, _to_float(health_policy.get("slippage_block_bps"), 15.0))
    slippage_component = 1.0 - min(1.0, slippage_bps / slippage_block_bps)

    active_incidents = int(incidents.get("active_count") or 0)
    critical_incidents = int(incidents.get("critical_count") or 0)
    throttling_count = int(incidents.get("throttling_count") or 0)
    incident_pressure = min(1.0, critical_incidents * 0.42 + active_incidents * 0.08 + throttling_count * 0.04 + (0.18 if not healthy else 0.0))
    incident_component = max(0.0, 1.0 - incident_pressure)

    components = {
        "feed_quality": round(_clamp(feed_component, 0.0, 1.0), 6),
        "execution_error": round(_clamp(error_component, 0.0, 1.0), 6),
        "latency": round(_clamp(latency_component, 0.0, 1.0), 6),
        "slippage": round(_clamp(slippage_component, 0.0, 1.0), 6),
        "incidents": round(_clamp(incident_component, 0.0, 1.0), 6),
    }
    score = sum(_to_float(weights.get(key), 0.0) * value for key, value in components.items())

    block_below = _to_float(health_policy.get("block_below"), 0.70)
    reduce_below = _to_float(health_policy.get("reduce_below"), 0.85)
    if feed_status == "critical":
        score = min(score, block_below - 0.06)
    elif feed_status == "degraded":
        score = min(score, reduce_below - 0.04)
    elif feed_status == "watch":
        score = min(score, 0.92)
    if not healthy or critical_incidents > 0:
        score = min(score, block_below - 0.08)
    elif active_incidents > 0:
        score = min(score, reduce_below - 0.02)
    if error_rate_pct >= max_error_rate_pct:
        score = min(score, block_below - 0.10)
    elif error_rate_pct >= 5.0:
        score = min(score, reduce_below - 0.03)

    score = round(_clamp(score, 0.0, 1.0), 6)
    if score < block_below:
        action = "block"
        size_multiplier = 0.0
    elif score < reduce_below:
        action = "reduce_size"
        size_multiplier = _to_float(health_policy.get("reduce_size_multiplier"), 0.65)
    else:
        action = "ok"
        size_multiplier = 1.0
    return {
        "health_score": score,
        "health_action": action,
        "size_multiplier": round(_clamp(size_multiplier, 0.0, 1.0), 6),
        "score_components": components,
        "latency_ms": round(latency_ms, 4),
        "error_rate_pct_24h": round(error_rate_pct, 4),
        "avg_slippage_bps_24h": round(slippage_bps, 6),
        "thresholds": {
            "block_below": round(block_below, 6),
            "reduce_below": round(reduce_below, 6),
        },
    }


def _connector_degradation_engine(provider: str, transport: str, healthy: bool, incidents: dict[str, Any], market: dict[str, Any], capital: dict[str, Any], outcomes: dict[str, Any], rest_latency_ms: float | None = None) -> dict[str, Any]:
    provider_norm = _normalize_connector_provider(provider)
    active_incidents = int(incidents.get("active_count") or 0)
    critical_incidents = int(incidents.get("critical_count") or 0)
    throttling_rate_pct = float(incidents.get("throttling_count") or 0)
    error_rate_pct = _to_float(outcomes.get("error_rate_pct_24h"), 0.0)
    feed_quality_status = str(market.get("feed_quality_status") or "not-instrumented")
    severity = "ok"
    if (not healthy) or critical_incidents > 0 or error_rate_pct >= 20 or feed_quality_status == "critical":
        severity = "critical"
    elif active_incidents > 0 or error_rate_pct >= 5 or feed_quality_status == "degraded":
        severity = "degraded"
    elif throttling_rate_pct > 0 or feed_quality_status == "watch":
        severity = "watch"

    fallback_path: list[str]
    transport_norm = str(transport or "rest").lower()
    if "ws" in transport_norm:
        fallback_path = ["ws-primary", "rest-fallback", "stale-cache"]
    elif "wallet" in transport_norm:
        fallback_path = ["external-signer", "read-only-monitoring", "manual-approval"]
    elif "bridge" in transport_norm:
        fallback_path = ["bridge-primary", "rest-check", "manual-desk"]
    else:
        fallback_path = ["rest-primary", "cached-state", "manual-desk"]

    diagnostics: list[str] = []
    top_diagnostic = str(incidents.get("top_diagnostic") or "")
    if top_diagnostic:
        diagnostics.append(top_diagnostic)
    if error_rate_pct >= 5:
        diagnostics.append("execution-error-rate")
    if feed_quality_status in {"watch", "degraded", "critical"}:
        diagnostics.append(f"feed-{feed_quality_status}")
    if _to_float(capital.get("solvency_ratio_pct"), 100.0) < 100.0:
        diagnostics.append("capital-coverage")
    if not diagnostics:
        diagnostics.append("nominal")

    health_snapshot = _connector_health_score_snapshot(
        healthy=healthy,
        incidents=incidents,
        market=market,
        outcomes=outcomes,
        rest_latency_ms=rest_latency_ms,
        health_policy=_connector_health_policy(),
    )

    return {
        "state": severity,
        "auto_downgrade_path": fallback_path,
        "auto_disable_live": bool(health_snapshot.get("health_action") == "block" or severity == "critical"),
        "auto_reroute_target": CONNECTOR_REROUTE_HINTS.get(provider_norm),
        "diagnostic": diagnostics[0],
        "diagnostics": diagnostics,
        **health_snapshot,
    }


def _connector_catalog_entry(provider: str) -> dict[str, str]:
    provider_norm = _normalize_connector_provider(provider)
    return next(
        (
            entry
            for entry in CONNECTOR_CATALOG
            if str(entry.get("name") or "").strip().lower() == provider_norm
        ),
        {
            "name": provider_norm,
            "type": "crypto",
            "transport": "rest",
            "health_group": "market",
        },
    )


def _connector_health_by_group() -> dict[str, bool]:
    probe_urls = {
        "market": f"{MARKET_DATA_URL}/health",
        "broker": f"{BROKER_ADAPTER_URL}/health",
        "mt5": f"{MT5_BRIDGE_URL}/health",
        "ai": f"{AI_ORCHESTRATOR_URL}/health",
        "embeddings": f"{EMBEDDINGS_SERVICE_URL}/health",
    }
    health_by_group = {group: False for group in probe_urls}
    with httpx.Client(timeout=3.0) as client:
        for group, url in probe_urls.items():
            try:
                response = client.get(url)
                health_by_group[group] = response.status_code < 500
            except Exception:
                health_by_group[group] = False
    return health_by_group


def _connector_latency_by_group() -> dict[str, float | None]:
    probe_urls = {
        "market": f"{MARKET_DATA_URL}/health",
        "broker": f"{BROKER_ADAPTER_URL}/health",
        "mt5": f"{MT5_BRIDGE_URL}/health",
        "ai": f"{AI_ORCHESTRATOR_URL}/health",
        "embeddings": f"{EMBEDDINGS_SERVICE_URL}/health",
    }
    latency_by_group: dict[str, float | None] = {group: None for group in probe_urls}
    with httpx.Client(timeout=3.0) as client:
        for group, url in probe_urls.items():
            started = time.perf_counter()
            try:
                client.get(url)
                latency_by_group[group] = round((time.perf_counter() - started) * 1000.0, 4)
            except Exception:
                latency_by_group[group] = None
    return latency_by_group


def _connector_live_degradation_snapshot(provider: str, visible_client_ids: list[str] | None = None) -> dict[str, Any]:
    provider_norm = _normalize_connector_provider(provider)
    if not provider_norm:
        return {}

    connector = _connector_catalog_entry(provider_norm)
    incidents = _build_connector_incident_summary(
        _normalize_db_rows(
            fetch_all(
                """
                SELECT ticket_key, severity, title, status, assignee, source, payload, created_by,
                       resolution_note, closed_by, closed_at, created_at, updated_at,
                       ROUND(EXTRACT(EPOCH FROM (NOW() - created_at)) / 60.0, 1) AS age_minutes
                FROM incident_tickets
                WHERE created_at >= NOW() - INTERVAL '7 days'
                ORDER BY created_at DESC
                LIMIT 400
                """
            )
        )
    ).get(provider_norm, {})
    outcomes = _connector_outcome_analytics().get(provider_norm, {})
    market = _connector_market_observability(provider_norm)
    capital = _connector_capital_rollup(provider_norm, visible_client_ids)
    health_group = str(connector.get("health_group") or "market")
    healthy = bool(_connector_health_by_group().get(health_group, False))
    rest_latency_ms = _connector_latency_by_group().get(health_group)
    degradation = _connector_degradation_engine(
        provider_norm,
        str(connector.get("transport") or "rest"),
        healthy,
        incidents,
        market,
        capital,
        outcomes,
        rest_latency_ms,
    )
    return {
        **degradation,
        "provider": provider_norm,
        "healthy": healthy,
        "health_group": health_group,
        "rest_latency_ms": round(rest_latency_ms, 4) if rest_latency_ms is not None else None,
        "incident_summary": {
            "active_count": int(incidents.get("active_count") or 0),
            "critical_count": int(incidents.get("critical_count") or 0),
            "top_diagnostic": incidents.get("top_diagnostic"),
        },
        "feed_quality": {
            "status": market.get("feed_quality_status"),
            "score": market.get("feed_quality_score"),
        },
        "outcomes": {
            "samples_24h": int(outcomes.get("samples_24h") or 0),
            "error_rate_pct_24h": _to_float(outcomes.get("error_rate_pct_24h"), 0.0),
        },
    }


def _connector_row_payload(
    connector: dict[str, str],
    *,
    healthy: bool,
    rest_latency_ms: float | None,
    linked_accounts: list[dict[str, Any]],
    visible_client_ids: list[str] | None,
    incident_summary: dict[str, dict[str, Any]],
    outcome_summary: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    provider = str(connector.get("name") or "")
    incidents = incident_summary.get(provider, {})
    outcomes = outcome_summary.get(provider, {})
    market = _connector_market_observability(provider)
    capital = _connector_capital_rollup(provider, visible_client_ids)
    permission_rows = [
        {
            **(_connector_account_public_view(account) or {}),
            "permissions_view": _derive_connector_permission_view(account),
        }
        for account in linked_accounts
    ]
    aggregate_permissions = {
        "read": any(bool(((row.get("permissions_view") or {}).get("permissions") or {}).get("read")) for row in permission_rows),
        "trade": any(bool(((row.get("permissions_view") or {}).get("permissions") or {}).get("trade")) for row in permission_rows),
        "withdraw": any(bool(((row.get("permissions_view") or {}).get("permissions") or {}).get("withdraw")) for row in permission_rows),
        "transfer": any(bool(((row.get("permissions_view") or {}).get("permissions") or {}).get("transfer")) for row in permission_rows),
        "sign": any(bool(((row.get("permissions_view") or {}).get("permissions") or {}).get("sign")) for row in permission_rows),
    }
    degradation = _connector_degradation_engine(
        provider,
        str(connector.get("transport") or "rest"),
        healthy,
        incidents,
        market,
        capital,
        outcomes,
        rest_latency_ms,
    )
    throttling_events = int(incidents.get("throttling_count") or 0)
    throttling_rate_pct = round(min(100.0, throttling_events * 5.0), 4)
    sync_freshness_rows = _normalize_db_rows(
        fetch_all(
            """
            SELECT account_id, MAX(as_of) AS latest_sync_at
            FROM account_balances
            WHERE account_id = ANY(%s)
            GROUP BY account_id
            """,
            ([str(item.get("account_id") or "") for item in capital.get("accounts", []) if str(item.get("account_id") or "")],),
        )
    ) if capital.get("accounts") else []
    sync_ages = []
    for row in sync_freshness_rows:
        parsed = _parse_iso_utc(str(row.get("latest_sync_at") or ""))
        if parsed:
            sync_ages.append(max(0, int((_now_utc() - parsed).total_seconds())))

    return {
        "name": provider,
        "type": connector.get("type"),
        "transport": connector.get("transport"),
        "healthy": healthy,
        "rest_latency_ms": round(rest_latency_ms, 2) if rest_latency_ms is not None else None,
        "websocket_latency_ms": market.get("ws_latency_ms"),
        "health_score": degradation.get("health_score"),
        "health_action": degradation.get("health_action"),
        "error_rate_pct": outcomes.get("error_rate_pct_24h", 0.0),
        "throttling_rate_pct": throttling_rate_pct,
        "uptime_24h_pct": incidents.get("uptime_24h_pct", 100.0),
        "uptime_7d_pct": incidents.get("uptime_7d_pct", 100.0),
        "market_feed_venue": market.get("venue"),
        "market_feed_instrument": market.get("instrument"),
        "depth_levels": market.get("depth_levels"),
        "messages_per_sec": market.get("messages_per_sec"),
        "feed_quality": {
            "status": market.get("feed_quality_status"),
            "score": market.get("feed_quality_score"),
            "gap_count": market.get("gap_count"),
            "desync_ms": market.get("desync_ms"),
            "spread_bps": market.get("spread_bps"),
        },
        "permissions_summary": {
            "aggregate": aggregate_permissions,
            "linked_accounts": permission_rows,
        },
        "broker_capabilities": {
            **_derive_broker_capabilities_view({"provider": provider, "mode": "trade"}),
            "linked_trade_accounts": sum(
                1
                for row in permission_rows
                if bool((((row.get("permissions_view") or {}).get("permissions") or {}).get("trade")))
            ),
        },
        "capital_summary": capital,
        "incident_summary": incidents,
        "degradation_engine": degradation,
        "latest_sync_age_sec": min(sync_ages) if sync_ages else None,
    }


def _preferred_portfolio_id_for_account(account_id: str) -> str | None:
    portfolio_link = fetch_one(
        """
        SELECT pa.portfolio_id
        FROM portfolio_accounts pa
        JOIN portfolios p ON p.portfolio_id = pa.portfolio_id
        WHERE pa.account_id = %s AND pa.status = 'active'
        ORDER BY CASE WHEN pa.portfolio_id = %s THEN 1 ELSE 0 END ASC, pa.id ASC
        LIMIT 1
        """,
        (account_id, _PHASE1_INTERNAL_PORTFOLIO_ID),
    )
    return str(portfolio_link["portfolio_id"]).strip() if portfolio_link else None


def _persist_connector_account_state(
    account_id: str,
    *,
    as_of: str,
    balances: list[dict],
    positions: list[dict],
    balance_sources: list[str],
    position_source_prefixes: list[str],
) -> dict:
    for source_prefix in position_source_prefixes:
        execute(
            "DELETE FROM consolidated_positions WHERE account_id = %s AND source LIKE %s",
            (account_id, f"{source_prefix}%"),
        )

    portfolio_id = _preferred_portfolio_id_for_account(account_id)

    for balance in balances:
        if not isinstance(balance, dict):
            continue
        execute(
            """
            INSERT INTO account_balances (
                account_id, asset_symbol, available_qty, locked_qty, equity_usd,
                mark_price_usd, as_of, source, payload
            ) VALUES (%s, %s, %s, %s, %s, %s, %s::timestamptz, %s, %s::jsonb)
            ON CONFLICT (account_id, asset_symbol, as_of) DO UPDATE SET
                available_qty = EXCLUDED.available_qty,
                locked_qty = EXCLUDED.locked_qty,
                equity_usd = EXCLUDED.equity_usd,
                mark_price_usd = EXCLUDED.mark_price_usd,
                source = EXCLUDED.source,
                payload = EXCLUDED.payload
            """,
            (
                account_id,
                str(balance.get("asset_symbol") or "USD").upper(),
                _to_float(balance.get("available_qty"), 0.0),
                _to_float(balance.get("locked_qty"), 0.0),
                _to_float(balance.get("equity_usd"), 0.0),
                _to_float(balance.get("mark_price_usd"), 0.0) or None,
                str(balance.get("as_of") or as_of),
                str(balance.get("source") or "connector-sync"),
                json_dumps(balance.get("payload") if isinstance(balance.get("payload"), dict) else {}),
            ),
        )

    for position in positions:
        if not isinstance(position, dict):
            continue
        execute(
            """
            INSERT INTO consolidated_positions (
                position_id, account_id, portfolio_id, strategy_id, symbol, instrument, side,
                quantity, notional_usd, avg_entry_price, mark_price,
                pnl_unrealized_usd, pnl_realized_usd, as_of, source, payload
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::timestamptz, %s, %s::jsonb)
            ON CONFLICT (position_id) DO UPDATE SET
                account_id = EXCLUDED.account_id,
                portfolio_id = EXCLUDED.portfolio_id,
                strategy_id = EXCLUDED.strategy_id,
                symbol = EXCLUDED.symbol,
                instrument = EXCLUDED.instrument,
                side = EXCLUDED.side,
                quantity = EXCLUDED.quantity,
                notional_usd = EXCLUDED.notional_usd,
                avg_entry_price = EXCLUDED.avg_entry_price,
                mark_price = EXCLUDED.mark_price,
                pnl_unrealized_usd = EXCLUDED.pnl_unrealized_usd,
                pnl_realized_usd = EXCLUDED.pnl_realized_usd,
                as_of = EXCLUDED.as_of,
                source = EXCLUDED.source,
                payload = EXCLUDED.payload
            """,
            (
                str(position.get("position_id") or f"connector:{account_id}:{position.get('symbol', 'unknown')}").strip(),
                account_id,
                portfolio_id,
                position.get("strategy_id"),
                str(position.get("symbol") or position.get("instrument") or "").upper(),
                str(position.get("instrument") or position.get("symbol") or "").upper(),
                str(position.get("side") or "flat"),
                _to_float(position.get("quantity"), 0.0),
                _to_float(position.get("notional_usd"), 0.0),
                _to_float(position.get("avg_entry_price"), 0.0),
                _to_float(position.get("mark_price"), 0.0),
                _to_float(position.get("pnl_unrealized_usd"), 0.0),
                _to_float(position.get("pnl_realized_usd"), 0.0),
                str(position.get("as_of") or as_of),
                str(position.get("source") or "connector-sync"),
                json_dumps(position.get("payload") if isinstance(position.get("payload"), dict) else {}),
            ),
        )

    return {
        "as_of": as_of,
        "summary": {
            "equity_usd": round(sum(_to_float(item.get("equity_usd"), 0.0) for item in balances if isinstance(item, dict)), 8),
            "gross_exposure_usd": round(sum(abs(_to_float(item.get("notional_usd"), 0.0)) for item in positions if isinstance(item, dict)), 8),
            "net_exposure_usd": round(
                sum(
                    -abs(_to_float(item.get("notional_usd"), 0.0))
                    if str(item.get("side") or "").strip().lower() == "short"
                    else abs(_to_float(item.get("notional_usd"), 0.0))
                    for item in positions
                    if isinstance(item, dict)
                ),
                8,
            ),
            "position_count": len([item for item in positions if isinstance(item, dict)]),
            "balance_count": len([item for item in balances if isinstance(item, dict)]),
        },
    }


def _asset_symbol_base(value: object) -> str:
    raw = str(value or "").strip().upper()
    if not raw:
        return ""
    if "-" in raw:
        return raw.rsplit("-", 1)[0]
    return raw


def _is_raw_cash_asset(asset_symbol: object) -> bool:
    return _asset_symbol_base(asset_symbol) in RAW_CASH_ASSETS


def _balance_total_qty(balance: dict | None) -> float:
    if not isinstance(balance, dict):
        return 0.0
    return _to_float(balance.get("available_qty"), 0.0) + _to_float(balance.get("locked_qty"), 0.0)


def _balance_equivalent_usd(balance: dict | None) -> float:
    if not isinstance(balance, dict):
        return 0.0
    equity_usd = _to_float(balance.get("equity_usd"), 0.0)
    if abs(equity_usd) > 0:
        return equity_usd
    quantity = _balance_total_qty(balance)
    mark_price = _to_float(balance.get("mark_price_usd"), 0.0)
    if mark_price > 0:
        return quantity * mark_price
    if _is_raw_cash_asset(balance.get("asset_symbol")):
        return quantity
    return 0.0


def _balance_raw_cash_usd(balance: dict | None) -> float:
    if not isinstance(balance, dict) or not _is_raw_cash_asset(balance.get("asset_symbol")):
        return 0.0
    quantity = _balance_total_qty(balance)
    mark_price = _to_float(balance.get("mark_price_usd"), 1.0)
    return quantity * (mark_price if mark_price > 0 else 1.0)


def _build_balance_snapshot(rows: list[dict]) -> dict[tuple[str, str], dict[str, Any]]:
    snapshot: dict[tuple[str, str], dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        asset = _asset_symbol_base(row.get("asset_symbol") or row.get("asset"))
        pocket = _balance_pocket_name(row)
        key = (asset, pocket)
        snapshot[key] = {
            "asset": asset,
            "pocket": pocket,
            "asset_symbol": str(row.get("asset_symbol") or asset).upper(),
            "quantity": _balance_total_qty(row),
            "equivalent_usd": _balance_equivalent_usd(row),
            "raw_cash_usd": _balance_raw_cash_usd(row),
            "mark_price_usd": _to_float(row.get("mark_price_usd"), 0.0),
        }
    return snapshot


def _build_pocket_capital_views(balances: list[dict]) -> list[dict[str, Any]]:
    buckets: dict[str, dict[str, Any]] = {}
    for balance in balances:
        if not isinstance(balance, dict):
            continue
        pocket = _balance_pocket_name(balance)
        asset = _asset_symbol_base(balance.get("asset_symbol") or balance.get("asset"))
        bucket = buckets.setdefault(
            pocket,
            {
                "pocket": pocket,
                "equivalent_usd": 0.0,
                "raw_cash_usd": 0.0,
                "inventory_usd": 0.0,
                "asset_count": 0,
                "assets": set(),
            },
        )
        equivalent_usd = _balance_equivalent_usd(balance)
        raw_cash_usd = _balance_raw_cash_usd(balance)
        bucket["equivalent_usd"] = _to_float(bucket.get("equivalent_usd"), 0.0) + equivalent_usd
        bucket["raw_cash_usd"] = _to_float(bucket.get("raw_cash_usd"), 0.0) + raw_cash_usd
        bucket["inventory_usd"] = _to_float(bucket.get("inventory_usd"), 0.0) + max(equivalent_usd - raw_cash_usd, 0.0)
        assets = bucket.get("assets")
        if isinstance(assets, set) and asset:
            assets.add(asset)
    pocket_order = {"spot": 0, "fund": 1, "futures": 2, "other": 3}
    rows: list[dict[str, Any]] = []
    for pocket, payload in sorted(buckets.items(), key=lambda item: pocket_order.get(item[0], 99)):
        assets = sorted(str(asset) for asset in (payload.get("assets") or set()))
        rows.append(
            {
                "pocket": pocket,
                "equivalent_usd": round(_to_float(payload.get("equivalent_usd"), 0.0), 8),
                "raw_cash_usd": round(_to_float(payload.get("raw_cash_usd"), 0.0), 8),
                "inventory_usd": round(_to_float(payload.get("inventory_usd"), 0.0), 8),
                "asset_count": len(assets),
                "assets": assets,
            }
        )
    return rows


def _cash_vs_equivalent_summary(balances: list[dict]) -> dict[str, Any]:
    pocket_views = _build_pocket_capital_views(balances)
    total_equivalent_usd = sum(_to_float(item.get("equivalent_usd"), 0.0) for item in pocket_views)
    total_raw_cash_usd = sum(_to_float(item.get("raw_cash_usd"), 0.0) for item in pocket_views)
    return {
        "total_equivalent_usd": round(total_equivalent_usd, 8),
        "total_raw_cash_usd": round(total_raw_cash_usd, 8),
        "inventory_usd": round(total_equivalent_usd - total_raw_cash_usd, 8),
        "pockets": pocket_views,
    }


def _position_metric_value(position: dict | None, *keys: str) -> float:
    if not isinstance(position, dict):
        return 0.0
    payload = position.get("payload") if isinstance(position.get("payload"), dict) else {}
    for key in keys:
        if key in position and position.get(key) not in {None, ""}:
            return _to_float(position.get(key), 0.0)
        if isinstance(payload, dict) and key in payload and payload.get(key) not in {None, ""}:
            return _to_float(payload.get(key), 0.0)
    return 0.0


def _position_metric_by_symbol(rows: list[dict], *keys: str) -> dict[str, float]:
    totals: dict[str, float] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        symbol = str(row.get("symbol") or row.get("instrument") or "UNKNOWN").upper()
        totals[symbol] = totals.get(symbol, 0.0) + _position_metric_value(row, *keys)
    return totals


def _capital_flow_external_id(event: dict[str, Any]) -> str:
    source = str(event.get("source") or "capital-ledger")
    occurred_at = str(event.get("occurred_at") or "")
    event_type = str(event.get("event_type") or "unknown")
    asset_symbol = str(event.get("asset_symbol") or "")
    pocket = str(event.get("pocket") or "")
    counterparty = str(event.get("counterparty") or "")
    amount_usd = _to_float(event.get("amount_usd"), 0.0)
    return f"{source}:{occurred_at}:{event_type}:{asset_symbol}:{pocket}:{counterparty}:{amount_usd:.8f}"


def _persist_capital_flow_events(account_row: dict, events: list[dict[str, Any]]) -> int:
    if not isinstance(account_row, dict):
        return 0
    account_id = str(account_row.get("account_id") or "").strip()
    portfolio_id = _preferred_portfolio_id_for_account(account_id)
    venue = str(account_row.get("venue") or account_row.get("connector_type") or "unknown")
    connector_type = str(account_row.get("connector_type") or "") or None
    persisted = 0
    for event in events:
        if not isinstance(event, dict):
            continue
        source = str(event.get("source") or "capital-ledger")
        external_event_id = str(event.get("external_event_id") or _capital_flow_external_id(event))
        event_hash = hashlib.sha256(f"{account_id}|{source}|{external_event_id}".encode("utf-8")).hexdigest()
        event_id = str(event.get("event_id") or f"cfe-{event_hash[:24]}")
        execute(
            """
            INSERT INTO capital_flow_events (
                event_id, account_id, portfolio_id, venue, connector_type, pocket,
                event_type, flow_direction, asset_symbol, amount_native, amount_usd,
                raw_cash_usd, equivalent_usd, counterparty, description, external_event_id,
                source, occurred_at, payload
            ) VALUES (
                %s, %s, %s, %s, %s, %s,
                %s, %s, %s, %s, %s,
                %s, %s, %s, %s, %s,
                %s, %s::timestamptz, %s::jsonb
            )
            ON CONFLICT (account_id, source, external_event_id) DO UPDATE SET
                portfolio_id = EXCLUDED.portfolio_id,
                venue = EXCLUDED.venue,
                connector_type = EXCLUDED.connector_type,
                pocket = EXCLUDED.pocket,
                event_type = EXCLUDED.event_type,
                flow_direction = EXCLUDED.flow_direction,
                asset_symbol = EXCLUDED.asset_symbol,
                amount_native = EXCLUDED.amount_native,
                amount_usd = EXCLUDED.amount_usd,
                raw_cash_usd = EXCLUDED.raw_cash_usd,
                equivalent_usd = EXCLUDED.equivalent_usd,
                counterparty = EXCLUDED.counterparty,
                description = EXCLUDED.description,
                occurred_at = EXCLUDED.occurred_at,
                payload = EXCLUDED.payload
            """,
            (
                event_id,
                account_id,
                portfolio_id,
                venue,
                connector_type,
                str(event.get("pocket") or "") or None,
                str(event.get("event_type") or "unknown"),
                str(event.get("flow_direction") or "neutral"),
                str(event.get("asset_symbol") or "") or None,
                _to_float(event.get("amount_native"), None),
                _to_float(event.get("amount_usd"), 0.0),
                _to_float(event.get("raw_cash_usd"), None),
                _to_float(event.get("equivalent_usd"), None),
                str(event.get("counterparty") or "") or None,
                str(event.get("description") or "") or None,
                external_event_id,
                source,
                str(event.get("occurred_at") or _now_utc().isoformat()),
                json_dumps(event.get("payload") if isinstance(event.get("payload"), dict) else {}),
            ),
        )
        persisted += 1
    return persisted


def _derive_balance_delta_events(account_row: dict, provider: str, as_of: str, previous_balances: list[dict], current_balances: list[dict]) -> list[dict[str, Any]]:
    previous_snapshot = _build_balance_snapshot(previous_balances)
    current_snapshot = _build_balance_snapshot(current_balances)
    grouped: dict[str, dict[str, list[dict[str, Any]]]] = {}
    for key in sorted(set(previous_snapshot) | set(current_snapshot)):
        previous = previous_snapshot.get(key) or {}
        current = current_snapshot.get(key) or {}
        asset = str((current or previous).get("asset") or "")
        if not _is_raw_cash_asset(asset):
            continue
        delta_usd = _to_float(current.get("raw_cash_usd"), 0.0) - _to_float(previous.get("raw_cash_usd"), 0.0)
        delta_native = _to_float(current.get("quantity"), 0.0) - _to_float(previous.get("quantity"), 0.0)
        if abs(delta_usd) < 0.01:
            continue
        pocket = str((current or previous).get("pocket") or "other")
        bucket = grouped.setdefault(asset, {"positive": [], "negative": []})
        row = {
            "asset": asset,
            "pocket": pocket,
            "delta_usd": delta_usd,
            "delta_native": delta_native,
        }
        if delta_usd > 0:
            bucket["positive"].append(row)
        else:
            bucket["negative"].append(row)

    events: list[dict[str, Any]] = []
    for asset, bucket in grouped.items():
        positives = [dict(item, remaining_usd=item["delta_usd"], remaining_native=item["delta_native"]) for item in bucket["positive"]]
        negatives = [dict(item, remaining_usd=abs(item["delta_usd"]), remaining_native=abs(item["delta_native"])) for item in bucket["negative"]]
        for debit in negatives:
            for credit in positives:
                matched_usd = min(_to_float(debit.get("remaining_usd"), 0.0), _to_float(credit.get("remaining_usd"), 0.0))
                if matched_usd < 0.01:
                    continue
                debit["remaining_usd"] = _to_float(debit.get("remaining_usd"), 0.0) - matched_usd
                credit["remaining_usd"] = _to_float(credit.get("remaining_usd"), 0.0) - matched_usd
                events.append(
                    {
                        "source": f"{provider}-sync-ledger",
                        "occurred_at": as_of,
                        "event_type": "internal_transfer",
                        "flow_direction": "neutral",
                        "asset_symbol": asset,
                        "amount_usd": matched_usd,
                        "raw_cash_usd": matched_usd,
                        "equivalent_usd": matched_usd,
                        "pocket": str(debit.get("pocket") or "other"),
                        "counterparty": str(credit.get("pocket") or "other"),
                        "description": f"Internal transfer {asset} {debit.get('pocket')} -> {credit.get('pocket')}",
                        "payload": {
                            "from_pocket": debit.get("pocket"),
                            "to_pocket": credit.get("pocket"),
                            "provider": provider,
                        },
                    }
                )
        for credit in positives:
            remaining_usd = _to_float(credit.get("remaining_usd"), 0.0)
            if remaining_usd < 0.01:
                continue
            events.append(
                {
                    "source": f"{provider}-sync-ledger",
                    "occurred_at": as_of,
                    "event_type": "external_cash_in",
                    "flow_direction": "credit",
                    "asset_symbol": asset,
                    "amount_native": _to_float(credit.get("remaining_native"), 0.0),
                    "amount_usd": remaining_usd,
                    "raw_cash_usd": remaining_usd,
                    "equivalent_usd": remaining_usd,
                    "pocket": str(credit.get("pocket") or "other"),
                    "description": f"Observed external cash inflow into {credit.get('pocket')}",
                    "payload": {"provider": provider},
                }
            )
        for debit in negatives:
            remaining_usd = _to_float(debit.get("remaining_usd"), 0.0)
            if remaining_usd < 0.01:
                continue
            events.append(
                {
                    "source": f"{provider}-sync-ledger",
                    "occurred_at": as_of,
                    "event_type": "external_cash_out",
                    "flow_direction": "debit",
                    "asset_symbol": asset,
                    "amount_native": -_to_float(debit.get("remaining_native"), 0.0),
                    "amount_usd": -remaining_usd,
                    "raw_cash_usd": -remaining_usd,
                    "equivalent_usd": -remaining_usd,
                    "pocket": str(debit.get("pocket") or "other"),
                    "description": f"Observed external cash outflow from {debit.get('pocket')}",
                    "payload": {"provider": provider},
                }
            )
    return events


def _derive_position_delta_events(provider: str, as_of: str, previous_positions: list[dict], current_positions: list[dict]) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    realized_previous = _position_metric_by_symbol(previous_positions, "pnl_realized_usd", "realizedProfit", "realizedPnl", "achievedProfits", "realizedPnl")
    realized_current = _position_metric_by_symbol(current_positions, "pnl_realized_usd", "realizedProfit", "realizedPnl", "achievedProfits", "realizedPnl")
    funding_previous = _position_metric_by_symbol(previous_positions, "funding_fee_usd", "fundingFee", "funding_fee_usd", "fundingFeesUsd", "totalFee")
    funding_current = _position_metric_by_symbol(current_positions, "funding_fee_usd", "fundingFee", "funding_fee_usd", "fundingFeesUsd", "totalFee")
    for symbol in sorted(set(realized_previous) | set(realized_current)):
        delta_realized = _to_float(realized_current.get(symbol), 0.0) - _to_float(realized_previous.get(symbol), 0.0)
        if abs(delta_realized) >= 0.01:
            events.append(
                {
                    "source": f"{provider}-sync-ledger",
                    "occurred_at": as_of,
                    "event_type": "realized_pnl",
                    "flow_direction": "credit" if delta_realized >= 0 else "debit",
                    "asset_symbol": symbol,
                    "amount_usd": delta_realized,
                    "equivalent_usd": delta_realized,
                    "pocket": "futures",
                    "description": f"Realized PnL delta on {symbol}",
                    "payload": {"provider": provider},
                }
            )
    for symbol in sorted(set(funding_previous) | set(funding_current)):
        delta_funding = _to_float(funding_current.get(symbol), 0.0) - _to_float(funding_previous.get(symbol), 0.0)
        if abs(delta_funding) >= 0.01:
            events.append(
                {
                    "source": f"{provider}-sync-ledger",
                    "occurred_at": as_of,
                    "event_type": "funding_fee",
                    "flow_direction": "credit" if delta_funding >= 0 else "debit",
                    "asset_symbol": symbol,
                    "amount_usd": delta_funding,
                    "equivalent_usd": delta_funding,
                    "pocket": "futures",
                    "description": f"Funding fee delta on {symbol}",
                    "payload": {"provider": provider},
                }
            )
    return events


def _derive_capital_flow_events(
    account_row: dict,
    provider: str,
    as_of: str,
    previous_balances: list[dict],
    current_balances: list[dict],
    previous_positions: list[dict],
    current_positions: list[dict],
) -> list[dict[str, Any]]:
    events = [
        *_derive_balance_delta_events(account_row, provider, as_of, previous_balances, current_balances),
        *_derive_position_delta_events(provider, as_of, previous_positions, current_positions),
    ]
    total_previous_equivalent = sum(_balance_equivalent_usd(row) for row in previous_balances if isinstance(row, dict))
    total_current_equivalent = sum(_balance_equivalent_usd(row) for row in current_balances if isinstance(row, dict))
    accounted_delta = sum(
        _to_float(event.get("amount_usd"), 0.0)
        for event in events
        if str(event.get("event_type") or "") != "internal_transfer"
    )
    residual_delta = total_current_equivalent - total_previous_equivalent - accounted_delta
    if abs(residual_delta) >= 0.5:
        events.append(
            {
                "source": f"{provider}-sync-ledger",
                "occurred_at": as_of,
                "event_type": "reconciliation_delta",
                "flow_direction": "credit" if residual_delta >= 0 else "debit",
                "amount_usd": residual_delta,
                "equivalent_usd": residual_delta,
                "description": "Residual capital delta after cashflow, funding and realized PnL reconciliation",
                "payload": {
                    "provider": provider,
                    "total_previous_equivalent": round(total_previous_equivalent, 8),
                    "total_current_equivalent": round(total_current_equivalent, 8),
                    "accounted_delta": round(accounted_delta, 8),
                },
            }
        )
    return events


def _account_capital_ledger(account_id: str, limit: int = 40) -> dict[str, Any]:
    rows = _normalize_db_rows(
        fetch_all(
            """
            SELECT event_id, account_id, portfolio_id, venue, connector_type, pocket,
                   event_type, flow_direction, asset_symbol, amount_native, amount_usd,
                   raw_cash_usd, equivalent_usd, counterparty, description, external_event_id,
                   source, occurred_at, payload, created_at
            FROM capital_flow_events
            WHERE account_id = %s
            ORDER BY occurred_at DESC, created_at DESC
            LIMIT %s
            """,
            (account_id, max(1, min(limit, 250))),
        )
    )
    summary = {
        "event_count": len(rows),
        "net_external_cashflow_usd": 0.0,
        "internal_transfer_usd": 0.0,
        "funding_fee_usd": 0.0,
        "realized_pnl_usd": 0.0,
        "reconciliation_usd": 0.0,
        "latest_event_at": rows[0].get("occurred_at") if rows else None,
    }
    for row in rows:
        event_type = str(row.get("event_type") or "")
        amount_usd = _to_float(row.get("amount_usd"), 0.0)
        if event_type in {"external_cash_in", "external_cash_out"}:
            summary["net_external_cashflow_usd"] += amount_usd
        elif event_type == "internal_transfer":
            summary["internal_transfer_usd"] += abs(amount_usd)
        elif event_type == "funding_fee":
            summary["funding_fee_usd"] += amount_usd
        elif event_type == "realized_pnl":
            summary["realized_pnl_usd"] += amount_usd
        elif event_type == "reconciliation_delta":
            summary["reconciliation_usd"] += amount_usd
    return {
        "rows": rows,
        "summary": {key: round(value, 8) if isinstance(value, float) else value for key, value in summary.items()},
    }


def _postprocess_connector_sync(
    account_row: dict,
    provider: str,
    as_of: str,
    balances: list[dict],
    positions: list[dict],
    previous_balances: list[dict],
    previous_positions: list[dict],
    persisted: dict[str, Any],
) -> dict[str, Any]:
    capital_events = _derive_capital_flow_events(account_row, provider, as_of, previous_balances, balances, previous_positions, positions)
    persisted["capital_flow_events_persisted"] = _persist_capital_flow_events(account_row, capital_events)
    persisted["pocket_totals"] = _summarize_balance_pockets(balances)
    persisted["cash_vs_equivalent"] = _cash_vs_equivalent_summary(balances)
    persisted["pocket_views"] = persisted["cash_vs_equivalent"].get("pockets", [])
    persisted["capital_ledger"] = _account_capital_ledger(str(account_row.get("account_id") or ""))
    return persisted


class BinanceAPIError(RuntimeError):
    def __init__(self, path: str, detail: str, *, code: str | None = None, http_status: int | None = None):
        self.path = path
        self.code = str(code).strip() or None if code is not None else None
        self.http_status = http_status
        if http_status is not None:
            if self.code:
                message = f"Binance {path} failed with status {http_status} [code {self.code}]: {detail}"
            else:
                message = f"Binance {path} failed with status {http_status}: {detail}"
        else:
            if self.code:
                message = f"Binance {path} rejected the request [code {self.code}]: {detail}"
            else:
                message = f"Binance {path} rejected the request: {detail}"
        super().__init__(message)


def _binance_error_code(body: object) -> str | None:
    if not isinstance(body, dict):
        return None
    code = body.get("code")
    if code in {None, ""}:
        return None
    rendered = str(code).strip()
    return rendered or None


def _binance_error_detail(body: object, fallback: str = "unknown error") -> str:
    if not isinstance(body, dict):
        return fallback
    detail = str(body.get("msg") or body.get("message") or fallback).strip()
    return detail or fallback


def _binance_response_error(path: str, body: object, *, http_status: int | None = None, fallback: str = "unknown error") -> BinanceAPIError:
    return BinanceAPIError(
        path,
        _binance_error_detail(body, fallback=fallback),
        code=_binance_error_code(body),
        http_status=http_status,
    )


def _unwrap_binance_response(path: str, body: object) -> object:
    if not isinstance(body, (dict, list)):
        raise RuntimeError(f"Binance {path} returned an invalid payload")
    if isinstance(body, dict):
        code = _binance_error_code(body)
        if code not in {None, "0"}:
            raise _binance_response_error(path, body)
    return body


async def _binance_public_get(
    path: str,
    params: dict | None = None,
    *,
    base_url: str = BINANCE_API_BASE_URL,
    venue_label: str = "Binance",
) -> object:
    query = {
        str(key): str(value)
        for key, value in (params or {}).items()
        if value is not None and str(value).strip()
    }
    url = f"{base_url}{path}"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(url, params=query)
    except httpx.HTTPError as exc:
                raise HTTPException(
                    status_code=502 if response.status_code >= 500 else response.status_code,
                    detail=_upstream_json_payload(response),
                )
    if response.status_code >= 400:
        try:
            body = response.json()
        except ValueError:
            raise RuntimeError(f"{venue_label} {path} public request failed with status {response.status_code}: {response.text[:300]}")
        raise _binance_response_error(f"{venue_label} {path}", body, http_status=response.status_code, fallback=response.text[:300])
    try:
        body = response.json()
    except ValueError as exc:
        raise RuntimeError(f"{venue_label} {path} returned invalid JSON") from exc
    return _unwrap_binance_response(f"{venue_label} {path}", body)


async def _binance_signed_get(
    secret_payload: dict,
    path: str,
    params: dict | None = None,
    *,
    base_url: str = BINANCE_API_BASE_URL,
    venue_label: str = "Binance",
) -> object:
    api_key = str(secret_payload.get("api_key") or "").strip()
    api_secret = str(secret_payload.get("api_secret") or "").strip()
    if not api_key or not api_secret:
        raise ValueError("Binance sync requires a linked API key and secret")
    query = {
        str(key): str(value)
        for key, value in (params or {}).items()
        if value is not None and str(value).strip()
    }
    query.setdefault("recvWindow", "60000")
    query["timestamp"] = str(int(_now_utc().timestamp() * 1000))
    query_string = urlencode(sorted(query.items()))
    signature = hmac.new(api_secret.encode("utf-8"), query_string.encode("utf-8"), hashlib.sha256).hexdigest()
    url = f"{base_url}{path}?{query_string}&signature={signature}"
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.get(url, headers={"X-MBX-APIKEY": api_key})
    except httpx.HTTPError as exc:
        raise RuntimeError(f"{venue_label} {path} request failed: {str(exc)[:300]}") from exc
    if response.status_code >= 400:
        try:
            body = response.json()
        except ValueError:
            raise RuntimeError(f"{venue_label} {path} failed with status {response.status_code}: {response.text[:300]}")
        raise _binance_response_error(f"{venue_label} {path}", body, http_status=response.status_code, fallback=response.text[:300])
    try:
        body = response.json()
    except ValueError as exc:
        raise RuntimeError(f"{venue_label} {path} returned invalid JSON") from exc
    return _unwrap_binance_response(f"{venue_label} {path}", body)


async def _binance_validate_api_credentials(secret_payload: dict) -> None:
    checks = await asyncio.gather(
        _binance_signed_get(secret_payload, "/api/v3/account"),
        _binance_signed_get(secret_payload, "/fapi/v2/account", base_url=BINANCE_FUTURES_API_BASE_URL, venue_label="Binance Futures"),
        _binance_signed_get(secret_payload, "/dapi/v1/account", base_url=BINANCE_COINM_API_BASE_URL, venue_label="Binance COIN-M Futures"),
        return_exceptions=True,
    )
    if any(not isinstance(result, Exception) for result in checks):
        return
    errors = [str(result) for result in checks if isinstance(result, Exception)]
    raise RuntimeError("; ".join(errors) if errors else "Binance credential validation failed")


async def _binance_fetch_spot_market_stats(asset_symbols: list[str]) -> tuple[dict[str, float], dict[str, dict[str, float | None]]]:
    prices: dict[str, float] = {}
    stats: dict[str, dict[str, float | None]] = {}
    quote_assets = ("USDT", "USDC", "FDUSD", "BUSD")
    for asset in sorted({str(item or "").strip().upper() for item in asset_symbols if str(item or "").strip()}):
        if _is_raw_cash_asset(asset):
            prices[asset] = 1.0
            stats[asset] = {"change_24h_pct": 0.0, "quote_volume_24h": None}
            continue
        for quote_asset in quote_assets:
            symbol = f"{asset}{quote_asset}"
            try:
                payload = await _binance_public_get("/api/v3/ticker/24hr", {"symbol": symbol})
            except RuntimeError:
                continue
            if not isinstance(payload, dict):
                continue
            last_price = _to_float(payload.get("lastPrice"), 0.0)
            open_price = _to_float(payload.get("openPrice"), 0.0)
            if last_price <= 0:
                continue
            prices[asset] = last_price
            stats[asset] = {
                "change_24h_pct": ((last_price - open_price) / open_price * 100.0) if open_price > 0 else None,
                "quote_volume_24h": _to_float(payload.get("quoteVolume"), None),
            }
            break
    return prices, stats


def _normalize_binance_spot_balances(
    raw_items: list[dict],
    as_of: str,
    *,
    mark_prices: dict[str, float] | None = None,
    change_stats: dict[str, dict[str, float | None]] | None = None,
) -> list[dict]:
    normalized: list[dict] = []
    resolved_mark_prices = mark_prices or {}
    resolved_change_stats = change_stats or {}
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        asset = str(item.get("asset") or item.get("coin") or "").strip().upper()
        if not asset:
            continue
        available_qty = _to_float(item.get("free"), 0.0)
        locked_qty = _to_float(item.get("locked"), 0.0)
        total_qty = available_qty + locked_qty
        if total_qty <= 0:
            continue
        mark_price = resolved_mark_prices.get(asset)
        if (mark_price is None or mark_price <= 0) and _is_raw_cash_asset(asset):
            mark_price = 1.0
        equity_usd = total_qty * mark_price if mark_price else (total_qty if _is_raw_cash_asset(asset) else 0.0)
        asset_change = resolved_change_stats.get(asset, {}) if isinstance(resolved_change_stats.get(asset), dict) else {}
        normalized.append(
            {
                "asset_symbol": f"{asset}-SPOT",
                "available_qty": available_qty,
                "locked_qty": locked_qty,
                "equity_usd": equity_usd,
                "mark_price_usd": mark_price,
                "change_24h_pct": _to_float(asset_change.get("change_24h_pct"), None),
                "quote_volume_24h": _to_float(asset_change.get("quote_volume_24h"), None),
                "as_of": as_of,
                "source": "binance-spot",
                "payload": {
                    **item,
                    "pocket": "spot",
                    "change_24h_pct": _to_float(asset_change.get("change_24h_pct"), None),
                    "quote_volume_24h": _to_float(asset_change.get("quote_volume_24h"), None),
                },
            }
        )
    return normalized


def _normalize_binance_futures_balances(
    raw_items: list[dict],
    as_of: str,
    *,
    mark_prices: dict[str, float] | None = None,
    change_stats: dict[str, dict[str, float | None]] | None = None,
) -> list[dict]:
    resolved_mark_prices = mark_prices or {}
    resolved_change_stats = change_stats or {}
    buckets: dict[str, dict[str, Any]] = {}
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        asset = str(item.get("asset") or item.get("marginAsset") or item.get("currency") or "").strip().upper()
        if not asset:
            continue
        available_qty = _to_float(item.get("availableBalance"), _to_float(item.get("withdrawAvailable"), _to_float(item.get("walletBalance"), 0.0)))
        total_qty = _to_float(item.get("marginBalance"), _to_float(item.get("walletBalance"), _to_float(item.get("balance"), available_qty)))
        if total_qty <= 0 and available_qty <= 0:
            continue
        locked_qty = max(total_qty - available_qty, 0.0)
        mark_price = resolved_mark_prices.get(asset)
        if (mark_price is None or mark_price <= 0) and _is_raw_cash_asset(asset):
            mark_price = 1.0
        equity_usd = total_qty * mark_price if mark_price else (total_qty if _is_raw_cash_asset(asset) else 0.0)
        bucket = buckets.setdefault(
            asset,
            {
                "available_qty": 0.0,
                "locked_qty": 0.0,
                "equity_usd": 0.0,
                "mark_price_usd": mark_price,
                "market_types": set(),
                "component_count": 0,
            },
        )
        bucket["available_qty"] = _to_float(bucket.get("available_qty"), 0.0) + available_qty
        bucket["locked_qty"] = _to_float(bucket.get("locked_qty"), 0.0) + locked_qty
        bucket["equity_usd"] = _to_float(bucket.get("equity_usd"), 0.0) + equity_usd
        if mark_price and (_to_float(bucket.get("mark_price_usd"), 0.0) <= 0):
            bucket["mark_price_usd"] = mark_price
        market_types = bucket.get("market_types")
        if isinstance(market_types, set):
            market_types.add(str(item.get("market_type") or "futures"))
        bucket["component_count"] = int(bucket.get("component_count") or 0) + 1

    normalized: list[dict] = []
    for asset, bucket in sorted(buckets.items()):
        asset_change = resolved_change_stats.get(asset, {}) if isinstance(resolved_change_stats.get(asset), dict) else {}
        market_types = sorted(str(value) for value in (bucket.get("market_types") or set()))
        normalized.append(
            {
                "asset_symbol": f"{asset}-FUTURES",
                "available_qty": _to_float(bucket.get("available_qty"), 0.0),
                "locked_qty": _to_float(bucket.get("locked_qty"), 0.0),
                "equity_usd": _to_float(bucket.get("equity_usd"), 0.0),
                "mark_price_usd": _to_float(bucket.get("mark_price_usd"), None),
                "change_24h_pct": _to_float(asset_change.get("change_24h_pct"), None),
                "quote_volume_24h": _to_float(asset_change.get("quote_volume_24h"), None),
                "as_of": as_of,
                "source": "binance-futures",
                "payload": {
                    "asset": asset,
                    "pocket": "futures",
                    "market_types": market_types,
                    "component_count": int(bucket.get("component_count") or 0),
                    "change_24h_pct": _to_float(asset_change.get("change_24h_pct"), None),
                    "quote_volume_24h": _to_float(asset_change.get("quote_volume_24h"), None),
                },
            }
        )
    return normalized


def _normalize_binance_positions(raw_items: list[dict], account_id: str, as_of: str) -> list[dict]:
    positions: list[dict] = []
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        instrument = str(item.get("symbol") or item.get("pair") or "").strip().upper()
        if not instrument:
            continue
        signed_quantity = _to_float(item.get("positionAmt"), 0.0)
        side_hint = str(item.get("positionSide") or item.get("side") or "").strip().lower()
        if side_hint == "short" or signed_quantity < 0:
            side = "short"
            quantity = abs(signed_quantity)
        elif side_hint == "long" or signed_quantity > 0:
            side = "long"
            quantity = abs(signed_quantity)
        else:
            side = "flat"
            quantity = 0.0
        mark_price = _to_float(item.get("markPrice"), _to_float(item.get("price"), 0.0))
        avg_entry_price = _to_float(item.get("entryPrice"), 0.0)
        notional_usd = abs(_to_float(item.get("notional"), _to_float(item.get("notionalValue"), 0.0)))
        if notional_usd <= 0 and quantity > 0:
            reference_price = mark_price if mark_price > 0 else avg_entry_price
            notional_usd = quantity * reference_price if reference_price > 0 else 0.0
        if quantity <= 0 and notional_usd <= 0:
            continue
        market_type = str(item.get("market_type") or "futures").strip().lower() or "futures"
        position_side = str(item.get("positionSide") or "BOTH").strip().upper() or "BOTH"
        positions.append(
            {
                "position_id": f"binance:{market_type}:{account_id}:{instrument}:{position_side}",
                "symbol": instrument,
                "instrument": instrument,
                "side": side,
                "quantity": quantity,
                "notional_usd": notional_usd,
                "avg_entry_price": avg_entry_price,
                "mark_price": mark_price,
                "pnl_unrealized_usd": _to_float(item.get("unRealizedProfit"), _to_float(item.get("unrealizedProfit"), 0.0)),
                "pnl_realized_usd": _to_float(item.get("realizedProfit"), 0.0),
                "as_of": as_of,
                "source": f"binance-futures-position-{market_type}",
                "payload": item,
            }
        )
    return positions


def _bingx_pick_number(payload: dict, *keys: str) -> float | None:
    for key in keys:
        if key in payload and payload.get(key) not in {None, ""}:
            return _to_float(payload.get(key), 0.0)
    return None


def _bingx_pick_text(payload: dict, *keys: str) -> str:
    for key in keys:
        value = str(payload.get(key) or "").strip()
        if value:
            return value
    return ""


def _bingx_parse_change_pct(value: object) -> float | None:
    text = str(value or "").strip().replace("%", "")
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def _bingx_extract_dict_items(payload: object, *preferred_keys: str) -> list[dict]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if isinstance(payload, dict):
        for key in preferred_keys:
            value = payload.get(key)
            items = _bingx_extract_dict_items(value, *preferred_keys) if isinstance(value, (dict, list)) else []
            if items:
                return items
        if any(payload.get(key) is not None for key in {"asset", "coin", "currency", "symbol", "positionAmt", "balance", "equity"}):
            return [payload]
        for value in payload.values():
            if isinstance(value, (dict, list)):
                items = _bingx_extract_dict_items(value, *preferred_keys)
                if items:
                    return items
    return []


def _bingx_is_stable_asset(asset_symbol: str) -> bool:
    return asset_symbol.upper() in {"USD", "USDT", "USDC", "BUSD", "DAI", "FDUSD", "TUSD"}


def _normalize_bingx_balance_items(
    raw_items: list[dict],
    pocket: str,
    as_of: str,
    default_asset: str = "USDT",
    mark_prices: dict[str, float] | None = None,
    change_stats: dict[str, dict[str, float | None]] | None = None,
) -> list[dict]:
    normalized: list[dict] = []
    pocket_slug = pocket.strip().lower()
    resolved_mark_prices = mark_prices or {}
    resolved_change_stats = change_stats or {}
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        asset = _bingx_pick_text(item, "asset", "coin", "currency", "currencySymbol") or default_asset
        asset_key = asset.upper()
        available = _bingx_pick_number(item, "free", "available", "availableBalance", "availableMargin", "maxWithdrawAmount")
        locked = _bingx_pick_number(item, "locked", "freeze", "frozen", "freezedMargin", "occupiedMargin")
        total = _bingx_pick_number(item, "equity", "balance", "walletBalance", "marginBalance", "total", "amount")
        available_qty = available if available is not None else 0.0
        locked_qty = locked if locked is not None else 0.0
        total_qty = total if total is not None else available_qty + locked_qty
        equity_usd = _bingx_pick_number(item, "equityUsd", "equityUSDT", "usdValue", "usdtValue", "assetValue")
        mark_price = _bingx_pick_number(item, "markPrice", "price", "usdPrice")
        if (mark_price is None or mark_price <= 0) and asset_key in resolved_mark_prices:
            mark_price = resolved_mark_prices[asset_key]
        if (mark_price is None or mark_price <= 0) and _bingx_is_stable_asset(asset):
            mark_price = 1.0
        if equity_usd is None:
            equity_usd = total_qty * mark_price if mark_price else (total_qty if _bingx_is_stable_asset(asset) else 0.0)
        if not asset and abs(total_qty) <= 0 and abs(equity_usd) <= 0:
            continue
        asset_change = resolved_change_stats.get(asset_key, {}) if isinstance(resolved_change_stats.get(asset_key), dict) else {}
        change_24h_pct = _to_float(asset_change.get("change_24h_pct"), None)
        quote_volume_24h = _to_float(asset_change.get("quote_volume_24h"), None)
        normalized.append(
            {
                "asset_symbol": f"{asset}-{pocket_slug}".upper(),
                "available_qty": available_qty,
                "locked_qty": locked_qty,
                "equity_usd": equity_usd,
                "mark_price_usd": mark_price,
                "change_24h_pct": change_24h_pct,
                "quote_volume_24h": quote_volume_24h,
                "as_of": as_of,
                "source": f"bingx-{pocket_slug}",
                "payload": {
                    **item,
                    "pocket": pocket_slug,
                    "change_24h_pct": change_24h_pct,
                    "quote_volume_24h": quote_volume_24h,
                },
            }
        )
    return normalized


def _normalize_bingx_open_orders(raw_items: list[dict], as_of: str) -> list[dict]:
    orders: list[dict] = []
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        symbol = _bingx_pick_text(item, "symbol", "contract", "pair")
        order_id = _bingx_pick_text(item, "orderId", "clientOrderID", "clientOrderId", "id")
        side = _bingx_pick_text(item, "side").upper()
        position_side = _bingx_pick_text(item, "positionSide").upper()
        order_type = _bingx_pick_text(item, "type", "orderType", "priceType").upper()
        status = _bingx_pick_text(item, "status", "orderStatus").upper()
        price = _bingx_pick_number(item, "price", "stopPrice", "triggerPrice") or 0.0
        quantity = _bingx_pick_number(item, "origQty", "quantity", "qty", "orderVolume") or 0.0
        filled_qty = _bingx_pick_number(item, "executedQty", "filledQty", "dealVolume") or 0.0
        margin_mode = _bingx_pick_text(item, "marginMode", "positionMode", "margeMode")
        leverage = _bingx_pick_number(item, "leverage") or 0.0
        created_at = _bingx_pick_text(item, "createTime", "time", "timestamp", "createdAt")
        if not symbol and not order_id:
            continue
        orders.append({
            "order_id": order_id,
            "symbol": symbol.upper() if symbol else "",
            "side": side,
            "position_side": position_side,
            "order_type": order_type,
            "status": status or "NEW",
            "price": price,
            "quantity": quantity,
            "filled_qty": filled_qty,
            "margin_mode": margin_mode,
            "leverage": leverage,
            "created_at": created_at,
            "as_of": as_of,
            "source": "bingx-open-order",
            "payload": item,
        })
    return orders


def _normalize_bingx_positions(raw_items: list[dict], account_id: str, as_of: str) -> list[dict]:
    positions: list[dict] = []
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        symbol = _bingx_pick_text(item, "symbol", "contract", "pair", "displayName")
        raw_quantity = _bingx_pick_number(item, "positionAmt", "positionAmount", "positionQty", "currentQty", "holdAmount", "volume")
        mark_price = _bingx_pick_number(item, "markPrice", "lastPrice", "indexPrice") or 0.0
        avg_entry_price = _bingx_pick_number(item, "avgPrice", "avgEntryPrice", "entryPrice") or 0.0
        notional_usd = _bingx_pick_number(item, "positionValue", "notional", "notionalValue")
        side_hint = _bingx_pick_text(item, "side", "positionSide", "positionDirection").lower()
        signed_quantity = raw_quantity if raw_quantity is not None else 0.0
        if side_hint in {"sell", "short"}:
            side = "short"
            quantity = abs(signed_quantity)
        elif side_hint in {"buy", "long"}:
            side = "long"
            quantity = abs(signed_quantity)
        elif signed_quantity < 0:
            side = "short"
            quantity = abs(signed_quantity)
        elif signed_quantity > 0:
            side = "long"
            quantity = abs(signed_quantity)
        else:
            side = "flat"
            quantity = 0.0
        if notional_usd is None:
            if quantity > 0 and mark_price > 0:
                notional_usd = quantity * mark_price
            elif quantity > 0 and avg_entry_price > 0:
                notional_usd = quantity * avg_entry_price
            else:
                notional_usd = 0.0
        if quantity <= 0 and abs(notional_usd) <= 0:
            continue
        position_id = _bingx_pick_text(item, "positionId", "id") or f"bingx:{account_id}:{symbol or 'unknown'}:{side}"
        positions.append(
            {
                "position_id": position_id,
                "symbol": symbol.upper(),
                "instrument": symbol.upper(),
                "side": side,
                "quantity": quantity,
                "notional_usd": abs(notional_usd),
                "avg_entry_price": avg_entry_price,
                "mark_price": mark_price,
                "pnl_unrealized_usd": _bingx_pick_number(item, "unrealizedProfit", "unrealizedPnl", "unRealizedProfit") or 0.0,
                "pnl_realized_usd": _bingx_pick_number(item, "realizedProfit", "realisedProfit", "realizedPnl") or 0.0,
                "as_of": as_of,
                "source": "bingx-futures-position",
                "payload": item,
            }
        )
    return positions


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
    query: dict[str, str] = {
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
        raise ValueError("BingX sync requires a linked API key and secret")
    query: dict[str, str] = {
        str(key): str(value)
        for key, value in (params or {}).items()
        if value is not None and str(value).strip()
    }
    query["timestamp"] = str(int(_now_utc().timestamp() * 1000))
    query.setdefault("recvWindow", "60000")
    query_string = urlencode(sorted(query.items()))
    signature = hmac.new(api_secret.encode("utf-8"), query_string.encode("utf-8"), hashlib.sha256).hexdigest()
    url = f"{BINGX_API_BASE_URL}{path}?{query_string}&signature={signature}"
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
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


async def _bingx_signed_get(secret_payload: dict, path: str, params: dict | None = None) -> object:
    return await _bingx_signed_request(secret_payload, "GET", path, params)


async def _bingx_signed_post(secret_payload: dict, path: str, params: dict | None = None) -> object:
    return await _bingx_signed_request(secret_payload, "POST", path, params)


BINGX_ACCOUNT_TYPE_CODES: dict[str, int] = {
    "fund": 1,
    "fund_account": 1,
    "standard_futures": 2,
    "std_futures": 2,
    "stdfutures": 2,
    "usdtm_perp": 3,
    "usdtm": 3,
    "usdt_m_perp": 3,
    "perpetual_usdt_m": 3,
    "spot": 15,
    "spot_account": 15,
}

BINGX_ACCOUNT_TYPE_LABELS: dict[int, str] = {
    1: "fund",
    2: "standard_futures",
    3: "usdtm_perp",
    15: "spot",
}

BINGX_ASSET_TRANSFER_ACCOUNTS: dict[str, str] = {
    "fund": "fund",
    "spot": "spot",
    "standard_futures": "stdFutures",
    "usdtm_perp": "USDTMPerp",
}


def _bingx_account_type_code(value: object) -> int:
    text = str(value or "").strip().lower().replace("-", "_").replace(" ", "_")
    if not text:
        raise ValueError("account type is required")
    if text.isdigit():
        code = int(text)
        if code in BINGX_ACCOUNT_TYPE_LABELS:
            return code
    code = BINGX_ACCOUNT_TYPE_CODES.get(text)
    if code is None:
        supported = ", ".join(sorted(BINGX_ACCOUNT_TYPE_CODES))
        raise ValueError(f"unsupported BingX account type '{value}'. Supported values: {supported}")
    return code


def _bingx_account_type_label(value: object) -> str:
    try:
        return BINGX_ACCOUNT_TYPE_LABELS[_bingx_account_type_code(value)]
    except ValueError:
        return str(value or "").strip().lower()


def _bingx_asset_transfer_account(value: object) -> str:
    label = _bingx_account_type_label(value)
    account = BINGX_ASSET_TRANSFER_ACCOUNTS.get(label)
    if not account:
        raise ValueError(f"unsupported BingX self-transfer account '{value}'")
    return account


def _bingx_symbol_key(symbol: object) -> str:
    return str(symbol or "").strip().upper().replace("/", "").replace("-", "").replace("_", "")


def _bingx_swap_symbol(symbol: object) -> str:
    raw = str(symbol or "").strip().upper().replace("/", "-").replace("_", "-")
    if not raw:
        return ""
    if "-" in raw:
        parts = [part for part in raw.split("-") if part]
        if len(parts) >= 2:
            return f"{parts[0]}-{parts[1]}"
        return raw.replace("--", "-")
    for suffix in ("USDT", "USDC", "USD", "BTC", "ETH"):
        if raw.endswith(suffix) and len(raw) > len(suffix):
            return f"{raw[:-len(suffix)]}-{suffix}"
    return raw


def _format_decimal(value: float, digits: int = 8) -> str:
    rendered = f"{value:.{digits}f}".rstrip("0").rstrip(".")
    return rendered or "0"


def _http_error_detail(response: httpx.Response) -> object:
    content_type = str(response.headers.get("content-type") or "").lower()
    if "application/json" in content_type:
        try:
            body = response.json()
        except ValueError:
            return response.text[:500]
        if isinstance(body, dict) and set(body.keys()) == {"detail"}:
            return body.get("detail")
        return body
    return response.text[:500]


def _flatten_downstream_error(status: str, detail: object) -> dict[str, Any]:
    payload: dict[str, Any] = {"status": status}
    resolved = detail
    if isinstance(resolved, dict) and set(resolved.keys()) == {"detail"}:
        resolved = resolved.get("detail")
    if isinstance(resolved, dict):
        error_text = str(resolved.get("error") or resolved.get("message") or resolved.get("detail") or "").strip()
        if error_text:
            payload["error"] = error_text
        if isinstance(resolved.get("sizing"), dict):
            payload["sizing"] = resolved.get("sizing")
        for key in ("provider", "account_id", "symbol", "side"):
            if resolved.get(key) is not None and key not in payload:
                payload[key] = resolved.get(key)
        if len(payload) == 1:
            payload["error"] = resolved
        return payload
    payload["error"] = str(resolved)
    return payload


def _bingx_secret_payload_for_account(account_id: str, *, require_trade: bool = True) -> tuple[dict[str, Any], dict[str, Any]]:
    linked_account = _linked_connector_account("bingx", account_id)
    if not linked_account:
        raise ValueError("No linked BingX connector account found")
    if require_trade and str(linked_account.get("mode") or "read").strip().lower() != "trade":
        raise ValueError("Linked BingX account is not in trade mode")
    credential = _load_decrypted_connector_credential(str(linked_account.get("credential_id") or ""))
    secret_payload = credential.get("secret_payload") if isinstance(credential, dict) and isinstance(credential.get("secret_payload"), dict) else None
    if not isinstance(secret_payload, dict):
        raise ValueError("BingX credentials are missing or unreadable for this account")
    return linked_account, secret_payload


async def _bingx_balance_preview(secret_payload: dict) -> dict[str, Any]:
    overview_raw, futures_raw = await asyncio.gather(
        _bingx_signed_get(secret_payload, "/openApi/account/v1/allAccountBalance"),
        _bingx_fetch_futures_balances(secret_payload),
    )
    return {
        "account_overview": _bingx_extract_dict_items(overview_raw, "data", "list"),
        "futures_balances": _bingx_extract_dict_items(futures_raw, "balance", "balances", "data", "list"),
    }


def _bingx_close_side(position_side: str) -> str:
    return "sell" if position_side == "LONG" else "buy"


def _bingx_flattenable_positions(raw_positions: object, account_id: str, *, symbol: str, position_side: str = "") -> list[dict[str, Any]]:
    symbol_key = _bingx_symbol_key(symbol)
    side_filter = str(position_side or "").strip().upper()
    positions = _normalize_bingx_positions(_bingx_extract_dict_items(raw_positions, "positions", "data", "list"), account_id, _now_utc().isoformat())
    flattenable: list[dict[str, Any]] = []
    for position in positions:
        raw_payload = position.get("payload") if isinstance(position.get("payload"), dict) else {}
        raw_position_side = str(raw_payload.get("positionSide") or "").strip().upper()
        resolved_position_side = raw_position_side or ("LONG" if str(position.get("side") or "") == "long" else "SHORT")
        if symbol_key and _bingx_symbol_key(position.get("symbol") or position.get("instrument")) != symbol_key:
            continue
        if side_filter and resolved_position_side != side_filter:
            continue
        quantity = abs(_bingx_pick_number(raw_payload, "availableAmt", "positionAmt", "positionQty") or _to_float(position.get("quantity"), 0.0))
        if quantity <= 0:
            continue
        flattenable.append(
            {
                "symbol": str(position.get("symbol") or position.get("instrument") or symbol).upper(),
                "position_side": resolved_position_side,
                "quantity": quantity,
                "close_side": _bingx_close_side(resolved_position_side),
                "notional_usd": _to_float(position.get("notional_usd"), 0.0),
                "position": position,
            }
        )
    return flattenable


async def _bingx_market_probe(
    *,
    account_id: str,
    secret_payload: dict,
    symbol: str,
    side: str,
    notional_usd: float,
    position_side: str,
    flatten_after: bool,
) -> dict[str, Any]:
    normalized_symbol = str(symbol or "").strip().upper().replace("/", "").replace("-", "")
    if side not in {"buy", "sell"}:
        raise ValueError("side must be buy or sell")
    if not position_side:
        position_side = "LONG" if side == "buy" else "SHORT"
    create_payload = {
        "provider": "bingx",
        "account_id": account_id,
        "secret_payload": secret_payload,
        "symbol": normalized_symbol,
        "side": side,
        "position_side": position_side,
        "notional_usd": notional_usd,
        "order_type": "MARKET",
    }
    async with httpx.AsyncClient(timeout=25.0) as client:
        buy_response = await client.post(f"{BROKER_ADAPTER_URL}/v1/live/orders", json=create_payload)
        if buy_response.status_code >= 400:
            raise HTTPException(status_code=502, detail=_flatten_downstream_error("bingx_market_probe_failed", _http_error_detail(buy_response)))
        buy_result = buy_response.json()

        executed_qty = 0.0
        if isinstance(buy_result, dict):
            fills = buy_result.get("fills") if isinstance(buy_result.get("fills"), list) else []
            if fills and isinstance(fills[0], dict):
                executed_qty = _to_float(fills[0].get("size_base"), 0.0)
            if executed_qty <= 0:
                raw_order = buy_result.get("raw_order") if isinstance(buy_result.get("raw_order"), dict) else {}
                order_payload = raw_order.get("order") if isinstance(raw_order.get("order"), dict) else raw_order
                executed_qty = _to_float((order_payload or {}).get("executedQty"), 0.0)

        flatten_result: dict[str, Any] | None = None
        if flatten_after and executed_qty > 0:
            flatten_payload = {
                "provider": "bingx",
                "account_id": account_id,
                "secret_payload": secret_payload,
                "symbol": normalized_symbol,
                "side": _bingx_close_side(position_side),
                "position_side": position_side,
                "quantity": executed_qty,
                "order_type": "MARKET",
            }
            flatten_response = await client.post(f"{BROKER_ADAPTER_URL}/v1/live/orders", json=flatten_payload)
            if flatten_response.status_code >= 400:
                raise HTTPException(status_code=502, detail={
                    "status": "bingx_market_probe_flatten_failed",
                    "buy": buy_result,
                    "flatten": _flatten_downstream_error("bingx_market_probe_flatten_failed", _http_error_detail(flatten_response)),
                })
            flatten_result = flatten_response.json()

    raw_positions_after = await _bingx_signed_get(secret_payload, "/openApi/swap/v2/user/positions", {"symbol": _bingx_swap_symbol(normalized_symbol)})
    return {
        "status": "ok",
        "buy": buy_result,
        "flatten": flatten_result,
        "positions_after": _bingx_flattenable_positions(raw_positions_after, account_id, symbol=normalized_symbol, position_side=position_side),
    }


async def _bingx_fetch_futures_balances(secret_payload: dict) -> object:
    last_error: RuntimeError | ValueError | None = None
    for path in ("/openApi/swap/v3/user/balance", "/openApi/swap/v2/user/balance"):
        try:
            return await _bingx_signed_get(secret_payload, path, {"recvWindow": 60000})
        except (RuntimeError, ValueError) as exc:
            last_error = exc
    if last_error is not None:
        raise last_error
    raise RuntimeError("BingX futures balance endpoint unavailable")


async def _bingx_fetch_spot_mark_prices(asset_symbols: list[str]) -> dict[str, float]:
    prices: dict[str, float] = {}
    for asset in sorted({str(item or "").strip().upper() for item in asset_symbols if str(item or "").strip()}):
        if _bingx_is_stable_asset(asset):
            prices[asset] = 1.0
            continue
        for quote_asset in ("USDT", "USDC"):
            try:
                payload = await _bingx_public_get("/openApi/spot/v2/ticker/price", {"symbol": f"{asset}-{quote_asset}"})
            except RuntimeError:
                continue
            if isinstance(payload, dict):
                price = _bingx_pick_number(payload, "price")
                if price is not None and price > 0:
                    prices[asset] = price
                    break
    return prices


async def _bingx_fetch_spot_change_stats(asset_symbols: list[str]) -> dict[str, dict[str, float | None]]:
    stats: dict[str, dict[str, float | None]] = {}
    timestamp_ms = int(_now_utc().timestamp() * 1000)
    for asset in sorted({str(item or "").strip().upper() for item in asset_symbols if str(item or "").strip()}):
        if _bingx_is_stable_asset(asset):
            stats[asset] = {"change_24h_pct": 0.0, "quote_volume_24h": None}
            continue
        for quote_asset in ("USDT", "USDC"):
            try:
                payload = await _bingx_public_get(
                    "/openApi/spot/v1/ticker/24hr",
                    {"symbol": f"{asset}-{quote_asset}", "timestamp": timestamp_ms},
                )
            except RuntimeError:
                continue
            rows = payload if isinstance(payload, list) else [payload] if isinstance(payload, dict) else []
            if not rows:
                continue
            first_row = rows[0] if isinstance(rows[0], dict) else None
            if not isinstance(first_row, dict):
                continue
            change_24h_pct = _bingx_parse_change_pct(first_row.get("priceChangePercent"))
            quote_volume_24h = _to_float(first_row.get("quoteVolume"), None)
            stats[asset] = {
                "change_24h_pct": change_24h_pct,
                "quote_volume_24h": quote_volume_24h,
            }
            break
    return stats


def _balance_pocket_name(balance: dict) -> str:
    source = str(balance.get("source") or "").strip().lower()
    if source.startswith("bingx-"):
        return source.removeprefix("bingx-")
    asset_symbol = str(balance.get("asset_symbol") or balance.get("asset") or "").strip()
    if "-" in asset_symbol:
        return asset_symbol.rsplit("-", 1)[-1].strip().lower()
    return "other"


def _summarize_balance_pockets(balances: list[dict]) -> list[dict]:
    buckets: dict[str, dict[str, object]] = {}
    for balance in balances:
        if not isinstance(balance, dict):
            continue
        pocket = _balance_pocket_name(balance)
        asset_symbol = str(balance.get("asset_symbol") or balance.get("asset") or "").strip().upper()
        asset_label = asset_symbol.rsplit("-", 1)[0] if "-" in asset_symbol else asset_symbol
        equity_usd = _to_float(balance.get("equity_usd"), 0.0)
        if abs(equity_usd) <= 0:
            quantity = _to_float(balance.get("available_qty"), 0.0) + _to_float(balance.get("locked_qty"), 0.0)
            mark_price = _to_float(balance.get("mark_price_usd"), 0.0)
            if mark_price > 0:
                equity_usd = quantity * mark_price
        bucket = buckets.setdefault(
            pocket,
            {"pocket": pocket, "equity_usd": 0.0, "assets": set()},
        )
        bucket["equity_usd"] = _to_float(bucket.get("equity_usd"), 0.0) + equity_usd
        assets = bucket.get("assets")
        if isinstance(assets, set) and asset_label:
            assets.add(asset_label)
    pocket_order = {"spot": 0, "fund": 1, "futures": 2, "other": 3}
    ordered: list[dict] = []
    for bucket in sorted(buckets.values(), key=lambda item: pocket_order.get(str(item.get("pocket") or "other"), 99)):
        assets = sorted(str(asset) for asset in (bucket.get("assets") or set()))
        ordered.append(
            {
                "pocket": str(bucket.get("pocket") or "other"),
                "equity_usd": round(_to_float(bucket.get("equity_usd"), 0.0), 8),
                "asset_count": len(assets),
                "assets": assets,
            }
        )
    return ordered


async def _sync_binance_account_state(account_id: str, account: dict | None = None) -> dict:
    account_row = account if isinstance(account, dict) else fetch_one(
        "SELECT account_id, client_id, account_type, venue, connector_type, mode, base_currency, status, external_ref, display_name, metadata, created_at, updated_at FROM accounts_registry WHERE account_id = %s",
        (account_id,),
    )
    if not account_row:
        raise ValueError("Canonical account not found")
    connector_account = _find_connector_account_for_canonical_account(account_row)
    if not connector_account or str(connector_account.get("provider") or "").strip().lower() != "binance":
        raise ValueError("No linked Binance connector account found for this canonical account")
    credential = _load_decrypted_connector_credential(str(connector_account.get("credential_id") or ""))
    secret_payload = credential.get("secret_payload") if isinstance(credential, dict) else None
    if not isinstance(secret_payload, dict):
        raise ValueError("Binance credentials are missing or unreadable for this account")

    previous_balances = _latest_account_balances(account_id)
    previous_positions = _latest_account_positions(account_id)
    as_of = _now_utc().isoformat()
    fetch_results = await asyncio.gather(
        _binance_signed_get(secret_payload, "/api/v3/account"),
        _binance_signed_get(secret_payload, "/fapi/v2/account", base_url=BINANCE_FUTURES_API_BASE_URL, venue_label="Binance Futures"),
        _binance_signed_get(secret_payload, "/fapi/v2/positionRisk", base_url=BINANCE_FUTURES_API_BASE_URL, venue_label="Binance Futures"),
        _binance_signed_get(secret_payload, "/dapi/v1/account", base_url=BINANCE_COINM_API_BASE_URL, venue_label="Binance COIN-M Futures"),
        _binance_signed_get(secret_payload, "/dapi/v1/positionRisk", base_url=BINANCE_COINM_API_BASE_URL, venue_label="Binance COIN-M Futures"),
        return_exceptions=True,
    )

    errors: list[str] = []
    spot_items: list[dict] = []
    futures_balance_items: list[dict] = []
    futures_position_items: list[dict] = []

    if isinstance(fetch_results[0], Exception):
        errors.append(f"spot: {str(fetch_results[0])}")
    elif isinstance(fetch_results[0], dict):
        balances = fetch_results[0].get("balances")
        if isinstance(balances, list):
            spot_items = [item for item in balances if isinstance(item, dict)]

    if isinstance(fetch_results[1], Exception):
        errors.append(f"futures_usdm_balance: {str(fetch_results[1])}")
    elif isinstance(fetch_results[1], dict):
        assets = fetch_results[1].get("assets")
        if isinstance(assets, list):
            futures_balance_items.extend([{**item, "market_type": "usdm"} for item in assets if isinstance(item, dict)])

    if isinstance(fetch_results[2], Exception):
        errors.append(f"futures_usdm_positions: {str(fetch_results[2])}")
    elif isinstance(fetch_results[2], list):
        futures_position_items.extend([{**item, "market_type": "usdm"} for item in fetch_results[2] if isinstance(item, dict)])

    if isinstance(fetch_results[3], Exception):
        errors.append(f"futures_coinm_balance: {str(fetch_results[3])}")
    elif isinstance(fetch_results[3], dict):
        assets = fetch_results[3].get("assets")
        if isinstance(assets, list):
            futures_balance_items.extend([{**item, "market_type": "coinm"} for item in assets if isinstance(item, dict)])

    if isinstance(fetch_results[4], Exception):
        errors.append(f"futures_coinm_positions: {str(fetch_results[4])}")
    elif isinstance(fetch_results[4], list):
        futures_position_items.extend([{**item, "market_type": "coinm"} for item in fetch_results[4] if isinstance(item, dict)])

    if errors and not spot_items and not futures_balance_items and not futures_position_items:
        raise RuntimeError("; ".join(errors))

    tracked_assets = [
        *[str(item.get("asset") or "") for item in spot_items],
        *[str(item.get("asset") or item.get("marginAsset") or "") for item in futures_balance_items],
    ]
    mark_prices, change_stats = await _binance_fetch_spot_market_stats(tracked_assets)
    balances = [
        *_normalize_binance_spot_balances(spot_items, as_of, mark_prices=mark_prices, change_stats=change_stats),
        *_normalize_binance_futures_balances(futures_balance_items, as_of, mark_prices=mark_prices, change_stats=change_stats),
    ]
    positions = _normalize_binance_positions(futures_position_items, account_id, as_of)
    persisted = _persist_connector_account_state(
        account_id,
        as_of=as_of,
        balances=balances,
        positions=positions,
        balance_sources=["binance-spot", "binance-futures"],
        position_source_prefixes=["binance-futures-position"],
    )
    persisted = _postprocess_connector_sync(account_row, "binance", as_of, balances, positions, previous_balances, previous_positions, persisted)
    persisted["status"] = "partial" if errors else "ok"
    persisted["connector_account"] = _connector_account_public_view(connector_account)
    if errors:
        persisted["warnings"] = errors
    persisted["risk_snapshots"] = _refresh_portfolio_risk_snapshots_for_account(account_id)
    append_audit(
        "binance_account_state_synced",
        {
            "account_id": account_id,
            "status": persisted["status"],
            "balance_count": persisted["summary"]["balance_count"],
            "position_count": persisted["summary"]["position_count"],
        },
    )
    return persisted


async def _sync_bingx_account_state(account_id: str, account: dict | None = None) -> dict:
    account_row = account if isinstance(account, dict) else fetch_one(
        "SELECT account_id, client_id, account_type, venue, connector_type, mode, base_currency, status, external_ref, display_name, metadata, created_at, updated_at FROM accounts_registry WHERE account_id = %s",
        (account_id,),
    )
    if not account_row:
        raise ValueError("Canonical account not found")

    connector_account = _find_connector_account_for_canonical_account(account_row)
    if not connector_account or str(connector_account.get("provider") or "").strip().lower() != "bingx":
        raise ValueError("No linked BingX connector account found for this canonical account")

    credential = _load_decrypted_connector_credential(str(connector_account.get("credential_id") or ""))
    secret_payload = credential.get("secret_payload") if isinstance(credential, dict) else None
    if not isinstance(secret_payload, dict):
        raise ValueError("BingX credentials are missing or unreadable for this account")

    previous_balances = _latest_account_balances(account_id)
    previous_positions = _latest_account_positions(account_id)
    as_of = _now_utc().isoformat()
    fetch_results = await asyncio.gather(
        _bingx_signed_get(secret_payload, "/openApi/spot/v1/account/balance", {"recvWindow": 60000}),
        _bingx_signed_get(secret_payload, "/openApi/fund/v1/account/balance", {"recvWindow": 60000}),
        _bingx_signed_get(secret_payload, "/openApi/account/v1/allAccountBalance", {"recvWindow": 60000}),
        _bingx_fetch_futures_balances(secret_payload),
        _bingx_signed_get(secret_payload, "/openApi/swap/v2/user/positions", {"recvWindow": 60000}),
        _bingx_signed_get(secret_payload, "/openApi/swap/v2/trade/openOrders", {"recvWindow": 60000}),
        return_exceptions=True,
    )

    errors: list[str] = []
    spot_items: list[dict] = []
    fund_items: list[dict] = []
    account_overview_items: list[dict] = []
    futures_balance_items: list[dict] = []
    futures_position_items: list[dict] = []
    open_order_items: list[dict] = []
    result_specs = [
        ("spot", fetch_results[0], ("balances", "balance", "data", "list")),
        ("fund", fetch_results[1], ("balances", "balance", "data", "list")),
        ("account_overview", fetch_results[2], ("data", "list")),
        ("futures_balance", fetch_results[3], ("balance", "balances", "data", "list")),
        ("futures_positions", fetch_results[4], ("positions", "data", "list")),
        ("open_orders", fetch_results[5], ("orders", "data", "list")),
    ]
    for label, result, keys in result_specs:
        if isinstance(result, Exception):
            errors.append(f"{label}: {str(result)}")
            continue
        items = _bingx_extract_dict_items(result, *keys)
        if label == "spot":
            spot_items = items
        elif label == "fund":
            fund_items = items
        elif label == "account_overview":
            account_overview_items = items
        elif label == "futures_balance":
            futures_balance_items = items
        elif label == "open_orders":
            open_order_items = items
        else:
            futures_position_items = items

    if errors and not any([spot_items, fund_items, account_overview_items, futures_balance_items, futures_position_items]):
        raise RuntimeError("; ".join(errors))

    tracked_assets = [
        *[str(item.get("asset") or item.get("coin") or item.get("currency") or "") for item in spot_items],
        *[str(item.get("asset") or item.get("coin") or item.get("currency") or "") for item in fund_items],
    ]
    mark_prices = await _bingx_fetch_spot_mark_prices(tracked_assets)
    change_stats = await _bingx_fetch_spot_change_stats(tracked_assets)

    balances = [
        *_normalize_bingx_balance_items(spot_items, "spot", as_of, mark_prices=mark_prices, change_stats=change_stats),
        *_normalize_bingx_balance_items(fund_items, "fund", as_of, mark_prices=mark_prices, change_stats=change_stats),
        *_normalize_bingx_balance_items(futures_balance_items, "futures", as_of),
    ]
    positions = _normalize_bingx_positions(futures_position_items, account_id, as_of)
    open_orders = _normalize_bingx_open_orders(open_order_items, as_of)
    pocket_totals = _summarize_balance_pockets(balances)
    overview_by_type = {
        str(item.get("accountType") or "").strip().lower(): _to_float(item.get("usdtBalance"), 0.0)
        for item in account_overview_items
        if isinstance(item, dict)
    }
    diagnostic_notes: list[str] = []
    spot_total_equivalent = next((_to_float(item.get("equity_usd"), 0.0) for item in pocket_totals if str(item.get("pocket") or "") == "spot"), 0.0)
    spot_usdt_raw = overview_by_type.get("sopt")
    if spot_usdt_raw is not None and spot_total_equivalent > spot_usdt_raw + 0.5:
        spot_assets = next((item.get("assets") for item in pocket_totals if str(item.get("pocket") or "") == "spot"), [])
        asset_labels = ", ".join(str(asset) for asset in (spot_assets if isinstance(spot_assets, list) else [])[:4]) or "non-stable assets"
        diagnostic_notes.append(
            f"BingX remonte {spot_usdt_raw:.4f} USDT bruts sur le compte spot, mais les actifs spot {asset_labels} valent environ {spot_total_equivalent:.2f} USD. Le ~16.90 vu dans l'UI BingX correspond donc vraisemblablement a une valorisation USDT-equivalente, pas a un solde cash USDT pur."
        )
    persisted = _persist_connector_account_state(
        account_id,
        as_of=as_of,
        balances=balances,
        positions=positions,
        balance_sources=["bingx-spot", "bingx-fund", "bingx-futures"],
        position_source_prefixes=["bingx-futures-position"],
    )
    persisted = _postprocess_connector_sync(account_row, "bingx", as_of, balances, positions, previous_balances, previous_positions, persisted)
    persisted["status"] = "partial" if errors else "ok"
    persisted["connector_account"] = _connector_account_public_view(connector_account)
    persisted["account_overview"] = account_overview_items
    persisted["open_orders"] = open_orders
    if diagnostic_notes:
        persisted["notes"] = diagnostic_notes
    if errors:
        persisted["warnings"] = [*errors, *diagnostic_notes]
    elif diagnostic_notes:
        persisted["warnings"] = diagnostic_notes
    persisted["risk_snapshots"] = _refresh_portfolio_risk_snapshots_for_account(account_id)
    append_audit(
        "bingx_account_state_synced",
        {
            "account_id": account_id,
            "status": persisted["status"],
            "balance_count": persisted["summary"]["balance_count"],
            "position_count": persisted["summary"]["position_count"],
        },
    )
    return persisted


def _unwrap_okx_response(path: str, body: object) -> object:
    if not isinstance(body, (dict, list)):
        raise RuntimeError(f"OKX {path} returned an invalid payload")
    if isinstance(body, dict):
        code = _okx_error_code(body) or "0"
        if code not in {"0", "", "success", "SUCCESS"}:
            raise _okx_response_error(path, body)
        data = body.get("data")
        if isinstance(data, (dict, list)):
            return data
    return body


class OKXAPIError(RuntimeError):
    def __init__(self, path: str, detail: str, *, code: str | None = None, http_status: int | None = None):
        self.path = path
        self.code = str(code).strip() or None if code is not None else None
        self.http_status = http_status
        if http_status is not None:
            if self.code:
                message = f"OKX {path} failed with status {http_status} [code {self.code}]: {detail}"
            else:
                message = f"OKX {path} failed with status {http_status}: {detail}"
        else:
            if self.code:
                message = f"OKX {path} rejected the request [code {self.code}]: {detail}"
            else:
                message = f"OKX {path} rejected the request: {detail}"
        super().__init__(message)


def _okx_error_code(body: object) -> str | None:
    if not isinstance(body, dict):
        return None
    code = str(body.get("code") or "").strip()
    return code or None


def _okx_error_detail(body: object, fallback: str = "unknown error") -> str:
    if not isinstance(body, dict):
        return fallback
    detail = str(body.get("msg") or body.get("message") or fallback).strip()
    return detail or fallback


def _okx_response_error(path: str, body: object, *, http_status: int | None = None, fallback: str = "unknown error") -> OKXAPIError:
    return OKXAPIError(
        path,
        _okx_error_detail(body, fallback=fallback),
        code=_okx_error_code(body),
        http_status=http_status,
    )


async def _okx_public_get(path: str, params: dict | None = None) -> object:
    query = {
        str(key): str(value)
        for key, value in (params or {}).items()
        if value is not None and str(value).strip()
    }
    url = f"{OKX_API_BASE_URL}{path}"
    if query:
        url = f"{url}?{urlencode(query)}"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(url)
    except httpx.HTTPError as exc:
        raise RuntimeError(f"OKX {path} public request failed: {str(exc)[:300]}") from exc
    if response.status_code >= 400:
        try:
            body = response.json()
        except ValueError:
            raise RuntimeError(f"OKX {path} public request failed with status {response.status_code}: {response.text[:300]}")
        raise _okx_response_error(path, body, http_status=response.status_code, fallback=response.text[:300])
    try:
        body = response.json()
    except ValueError as exc:
        raise RuntimeError(f"OKX {path} returned invalid JSON") from exc
    return _unwrap_okx_response(path, body)


async def _okx_signed_get(secret_payload: dict, path: str, params: dict | None = None) -> object:
    api_key = str(secret_payload.get("api_key") or "").strip()
    api_secret = str(secret_payload.get("api_secret") or "").strip()
    passphrase = str(secret_payload.get("passphrase") or "").strip()
    if not api_key or not api_secret or not passphrase:
        raise ValueError("OKX sync requires api_key, api_secret and passphrase")
    query = {
        str(key): str(value)
        for key, value in (params or {}).items()
        if value is not None and str(value).strip()
    }
    query_string = urlencode(query)
    request_path = f"{path}?{query_string}" if query_string else path
    timestamp = _now_utc().isoformat(timespec="milliseconds").replace("+00:00", "Z")
    prehash = f"{timestamp}GET{request_path}"
    signature = base64.b64encode(hmac.new(api_secret.encode("utf-8"), prehash.encode("utf-8"), hashlib.sha256).digest()).decode("utf-8")
    url = f"{OKX_API_BASE_URL}{request_path}"
    headers = {
        "OK-ACCESS-KEY": api_key,
        "OK-ACCESS-SIGN": signature,
        "OK-ACCESS-TIMESTAMP": timestamp,
        "OK-ACCESS-PASSPHRASE": passphrase,
        "Content-Type": "application/json",
    }
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.get(url, headers=headers)
    except httpx.HTTPError as exc:
        raise RuntimeError(f"OKX {path} request failed: {str(exc)[:300]}") from exc
    if response.status_code >= 400:
        try:
            body = response.json()
        except ValueError:
            raise RuntimeError(f"OKX {path} failed with status {response.status_code}: {response.text[:300]}")
        raise _okx_response_error(path, body, http_status=response.status_code, fallback=response.text[:300])
    try:
        body = response.json()
    except ValueError as exc:
        raise RuntimeError(f"OKX {path} returned invalid JSON") from exc
    return _unwrap_okx_response(path, body)


async def _okx_validate_api_credentials(secret_payload: dict) -> None:
    await _okx_signed_get(secret_payload, "/api/v5/account/balance")


async def _okx_fetch_spot_market_stats(asset_symbols: list[str]) -> tuple[dict[str, float], dict[str, dict[str, float | None]]]:
    prices: dict[str, float] = {}
    stats: dict[str, dict[str, float | None]] = {}
    for asset in sorted({str(item or "").strip().upper() for item in asset_symbols if str(item or "").strip()}):
        if _is_raw_cash_asset(asset):
            prices[asset] = 1.0
            stats[asset] = {"change_24h_pct": 0.0, "quote_volume_24h": None}
            continue
        for quote_asset in ("USDT", "USDC"):
            try:
                payload = await _okx_public_get("/api/v5/market/ticker", {"instId": f"{asset}-{quote_asset}"})
            except RuntimeError:
                continue
            rows = payload if isinstance(payload, list) else [payload] if isinstance(payload, dict) else []
            if not rows or not isinstance(rows[0], dict):
                continue
            item = rows[0]
            last = _to_float(item.get("last"), 0.0)
            open_24h = _to_float(item.get("open24h"), 0.0)
            if last <= 0:
                continue
            prices[asset] = last
            stats[asset] = {
                "change_24h_pct": ((last - open_24h) / open_24h * 100.0) if open_24h > 0 else None,
                "quote_volume_24h": _to_float(item.get("volCcy24h"), None),
            }
            break
    return prices, stats


def _okx_extract_balance_items(payload: object) -> list[dict]:
    rows = payload if isinstance(payload, list) else [payload] if isinstance(payload, dict) else []
    extracted: list[dict] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        details = row.get("details")
        if isinstance(details, list):
            extracted.extend(item for item in details if isinstance(item, dict))
        elif any(row.get(key) is not None for key in {"ccy", "cashBal", "availBal", "eq"}):
            extracted.append(row)
    return extracted


def _normalize_okx_balance_items(
    raw_items: list[dict],
    as_of: str,
    mark_prices: dict[str, float] | None = None,
    change_stats: dict[str, dict[str, float | None]] | None = None,
) -> list[dict]:
    normalized: list[dict] = []
    resolved_mark_prices = mark_prices or {}
    resolved_change_stats = change_stats or {}
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        asset = str(item.get("ccy") or item.get("asset") or "").strip().upper()
        if not asset:
            continue
        available_qty = _to_float(item.get("availBal"), _to_float(item.get("cashBal"), 0.0))
        total_qty = _to_float(item.get("eq"), _to_float(item.get("cashBal"), available_qty))
        locked_qty = max(total_qty - available_qty, 0.0)
        mark_price = _to_float(item.get("markPx"), None)
        if (mark_price is None or mark_price <= 0) and asset in resolved_mark_prices:
            mark_price = resolved_mark_prices[asset]
        if (mark_price is None or mark_price <= 0) and _is_raw_cash_asset(asset):
            mark_price = 1.0
        equity_usd = _to_float(item.get("eqUsd"), None)
        if equity_usd is None:
            equity_usd = total_qty * mark_price if mark_price else (total_qty if _is_raw_cash_asset(asset) else 0.0)
        asset_change = resolved_change_stats.get(asset, {}) if isinstance(resolved_change_stats.get(asset), dict) else {}
        normalized.append(
            {
                "asset_symbol": f"{asset}-SPOT",
                "available_qty": available_qty,
                "locked_qty": locked_qty,
                "equity_usd": equity_usd,
                "mark_price_usd": mark_price,
                "change_24h_pct": _to_float(asset_change.get("change_24h_pct"), None),
                "quote_volume_24h": _to_float(asset_change.get("quote_volume_24h"), None),
                "as_of": as_of,
                "source": "okx-spot",
                "payload": {
                    **item,
                    "pocket": "spot",
                    "change_24h_pct": _to_float(asset_change.get("change_24h_pct"), None),
                    "quote_volume_24h": _to_float(asset_change.get("quote_volume_24h"), None),
                },
            }
        )
    return normalized


def _normalize_okx_positions(raw_items: list[dict], account_id: str, as_of: str) -> list[dict]:
    positions: list[dict] = []
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        instrument = str(item.get("instId") or item.get("symbol") or "").strip().upper()
        if not instrument:
            continue
        signed_quantity = _to_float(item.get("pos"), 0.0)
        side_hint = str(item.get("posSide") or item.get("side") or "").strip().lower()
        if side_hint == "short" or signed_quantity < 0:
            side = "short"
            quantity = abs(signed_quantity)
        elif side_hint == "long" or signed_quantity > 0:
            side = "long"
            quantity = abs(signed_quantity)
        else:
            side = "flat"
            quantity = 0.0
        mark_price = _to_float(item.get("markPx"), _to_float(item.get("last"), 0.0))
        avg_entry_price = _to_float(item.get("avgPx"), _to_float(item.get("openAvgPx"), 0.0))
        notional_usd = abs(_to_float(item.get("notionalUsd"), 0.0))
        if notional_usd <= 0 and quantity > 0:
            reference_price = mark_price if mark_price > 0 else avg_entry_price
            notional_usd = quantity * reference_price if reference_price > 0 else 0.0
        if quantity <= 0 and abs(notional_usd) <= 0:
            continue
        position_id = str(item.get("posId") or f"okx:{account_id}:{instrument}:{side}")
        funding_fee_usd = _to_float(item.get("fundingFee"), None)
        positions.append(
            {
                "position_id": position_id,
                "symbol": instrument,
                "instrument": instrument,
                "side": side,
                "quantity": quantity,
                "notional_usd": notional_usd,
                "avg_entry_price": avg_entry_price,
                "mark_price": mark_price,
                "pnl_unrealized_usd": _to_float(item.get("upl"), 0.0),
                "pnl_realized_usd": _to_float(item.get("realizedPnl"), _to_float(item.get("pnl"), 0.0)),
                "funding_fee_usd": funding_fee_usd,
                "as_of": as_of,
                "source": "okx-position",
                "payload": {
                    **item,
                    "funding_fee_usd": funding_fee_usd,
                },
            }
        )
    return positions


async def _sync_okx_account_state(account_id: str, account: dict | None = None) -> dict:
    account_row = account if isinstance(account, dict) else fetch_one(
        "SELECT account_id, client_id, account_type, venue, connector_type, mode, base_currency, status, external_ref, display_name, metadata, created_at, updated_at FROM accounts_registry WHERE account_id = %s",
        (account_id,),
    )
    if not account_row:
        raise ValueError("Canonical account not found")
    connector_account = _find_connector_account_for_canonical_account(account_row)
    if not connector_account or str(connector_account.get("provider") or "").strip().lower() != "okx":
        raise ValueError("No linked OKX connector account found for this canonical account")
    credential = _load_decrypted_connector_credential(str(connector_account.get("credential_id") or ""))
    secret_payload = credential.get("secret_payload") if isinstance(credential, dict) else None
    if not isinstance(secret_payload, dict):
        raise ValueError("OKX credentials are missing or unreadable for this account")

    previous_balances = _latest_account_balances(account_id)
    previous_positions = _latest_account_positions(account_id)
    as_of = _now_utc().isoformat()
    fetch_results = await asyncio.gather(
        _okx_signed_get(secret_payload, "/api/v5/account/balance"),
        _okx_signed_get(secret_payload, "/api/v5/account/positions"),
        return_exceptions=True,
    )
    errors: list[str] = []
    balance_items: list[dict] = []
    position_items: list[dict] = []
    if isinstance(fetch_results[0], Exception):
        errors.append(f"balance: {str(fetch_results[0])}")
    else:
        balance_items = _okx_extract_balance_items(fetch_results[0])
    if isinstance(fetch_results[1], Exception):
        errors.append(f"positions: {str(fetch_results[1])}")
    elif isinstance(fetch_results[1], list):
        position_items = [item for item in fetch_results[1] if isinstance(item, dict)]
    if errors and not balance_items and not position_items:
        raise RuntimeError("; ".join(errors))

    tracked_assets = [str(item.get("ccy") or "") for item in balance_items]
    mark_prices, change_stats = await _okx_fetch_spot_market_stats(tracked_assets)
    balances = _normalize_okx_balance_items(balance_items, as_of, mark_prices=mark_prices, change_stats=change_stats)
    positions = _normalize_okx_positions(position_items, account_id, as_of)
    persisted = _persist_connector_account_state(
        account_id,
        as_of=as_of,
        balances=balances,
        positions=positions,
        balance_sources=["okx-spot"],
        position_source_prefixes=["okx-position"],
    )
    persisted = _postprocess_connector_sync(account_row, "okx", as_of, balances, positions, previous_balances, previous_positions, persisted)
    persisted["status"] = "partial" if errors else "ok"
    persisted["connector_account"] = _connector_account_public_view(connector_account)
    if errors:
        persisted["warnings"] = errors
    persisted["risk_snapshots"] = _refresh_portfolio_risk_snapshots_for_account(account_id)
    append_audit(
        "okx_account_state_synced",
        {
            "account_id": account_id,
            "status": persisted["status"],
            "balance_count": persisted["summary"]["balance_count"],
            "position_count": persisted["summary"]["position_count"],
        },
    )
    return persisted


def _unwrap_bitget_response(path: str, body: object) -> object:
    if not isinstance(body, (dict, list)):
        raise RuntimeError(f"Bitget {path} returned an invalid payload")
    if isinstance(body, dict):
        code = str(body.get("code") or body.get("status") or "00000").strip()
        if code not in {"00000", "0", "", "success", "SUCCESS"}:
            detail = str(body.get("msg") or body.get("message") or "unknown error")
            raise RuntimeError(f"Bitget {path} rejected the request: {detail}")
        data = body.get("data")
        if isinstance(data, (dict, list)):
            return data
    return body


async def _bitget_public_get(path: str, params: dict | None = None) -> object:
    query = {
        str(key): str(value)
        for key, value in (params or {}).items()
        if value is not None and str(value).strip()
    }
    url = f"{BITGET_API_BASE_URL}{path}"
    if query:
        url = f"{url}?{urlencode(sorted(query.items()))}"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(url)
    except httpx.HTTPError as exc:
        raise RuntimeError(f"Bitget {path} public request failed: {str(exc)[:300]}") from exc
    if response.status_code >= 400:
        raise RuntimeError(f"Bitget {path} public request failed with status {response.status_code}: {response.text[:300]}")
    try:
        body = response.json()
    except ValueError as exc:
        raise RuntimeError(f"Bitget {path} returned invalid JSON") from exc
    return _unwrap_bitget_response(path, body)


async def _bitget_signed_get(secret_payload: dict, path: str, params: dict | None = None) -> object:
    api_key = str(secret_payload.get("api_key") or "").strip()
    api_secret = str(secret_payload.get("api_secret") or "").strip()
    passphrase = str(secret_payload.get("passphrase") or "").strip()
    if not api_key or not api_secret or not passphrase:
        raise ValueError("Bitget sync requires api_key, api_secret and passphrase")
    query = {
        str(key): str(value)
        for key, value in (params or {}).items()
        if value is not None and str(value).strip()
    }
    query_string = urlencode(sorted(query.items()))
    request_path = path
    request_suffix = f"?{query_string}" if query_string else ""
    timestamp = str(int(_now_utc().timestamp() * 1000))
    prehash = f"{timestamp}GET{request_path}{request_suffix}"
    signature = base64.b64encode(hmac.new(api_secret.encode("utf-8"), prehash.encode("utf-8"), hashlib.sha256).digest()).decode("utf-8")
    url = f"{BITGET_API_BASE_URL}{request_path}{request_suffix}"
    headers = {
        "ACCESS-KEY": api_key,
        "ACCESS-SIGN": signature,
        "ACCESS-TIMESTAMP": timestamp,
        "ACCESS-PASSPHRASE": passphrase,
        "locale": "en-US",
        "Content-Type": "application/json",
    }
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.get(url, headers=headers)
    except httpx.HTTPError as exc:
        raise RuntimeError(f"Bitget {path} request failed: {str(exc)[:300]}") from exc
    if response.status_code >= 400:
        raise RuntimeError(f"Bitget {path} failed with status {response.status_code}: {response.text[:300]}")
    try:
        body = response.json()
    except ValueError as exc:
        raise RuntimeError(f"Bitget {path} returned invalid JSON") from exc
    return _unwrap_bitget_response(path, body)


async def _bitget_fetch_spot_market_stats(asset_symbols: list[str]) -> tuple[dict[str, float], dict[str, dict[str, float | None]]]:
    prices: dict[str, float] = {}
    stats: dict[str, dict[str, float | None]] = {}
    for asset in sorted({str(item or "").strip().upper() for item in asset_symbols if str(item or "").strip()}):
        if _is_raw_cash_asset(asset):
            prices[asset] = 1.0
            stats[asset] = {"change_24h_pct": 0.0, "quote_volume_24h": None}
            continue
        for quote_asset in ("USDT", "USDC"):
            try:
                payload = await _bitget_public_get("/api/v2/spot/market/tickers", {"symbol": f"{asset}{quote_asset}"})
            except RuntimeError:
                continue
            rows = payload if isinstance(payload, list) else [payload] if isinstance(payload, dict) else []
            if not rows or not isinstance(rows[0], dict):
                continue
            item = rows[0]
            last = _to_float(item.get("lastPr"), 0.0)
            open_24h = _to_float(item.get("open"), 0.0)
            if last <= 0:
                continue
            prices[asset] = last
            stats[asset] = {
                "change_24h_pct": ((last - open_24h) / open_24h * 100.0) if open_24h > 0 else _to_float(item.get("changeUtc24h"), 0.0) * 100.0,
                "quote_volume_24h": _to_float(item.get("usdtVolume"), _to_float(item.get("quoteVolume"), None)),
            }
            break
    return prices, stats


def _normalize_bitget_spot_balances(
    raw_items: list[dict],
    as_of: str,
    mark_prices: dict[str, float] | None = None,
    change_stats: dict[str, dict[str, float | None]] | None = None,
) -> list[dict]:
    normalized: list[dict] = []
    resolved_mark_prices = mark_prices or {}
    resolved_change_stats = change_stats or {}
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        asset = str(item.get("coin") or item.get("asset") or "").strip().upper()
        if not asset:
            continue
        available_qty = _to_float(item.get("available"), 0.0)
        locked_qty = _to_float(item.get("frozen"), 0.0) + _to_float(item.get("locked"), 0.0)
        total_qty = available_qty + locked_qty
        mark_price = resolved_mark_prices.get(asset)
        if (mark_price is None or mark_price <= 0) and _is_raw_cash_asset(asset):
            mark_price = 1.0
        equity_usd = total_qty * mark_price if mark_price else (total_qty if _is_raw_cash_asset(asset) else 0.0)
        asset_change = resolved_change_stats.get(asset, {}) if isinstance(resolved_change_stats.get(asset), dict) else {}
        normalized.append(
            {
                "asset_symbol": f"{asset}-SPOT",
                "available_qty": available_qty,
                "locked_qty": locked_qty,
                "equity_usd": equity_usd,
                "mark_price_usd": mark_price,
                "change_24h_pct": _to_float(asset_change.get("change_24h_pct"), None),
                "quote_volume_24h": _to_float(asset_change.get("quote_volume_24h"), None),
                "as_of": as_of,
                "source": "bitget-spot",
                "payload": {
                    **item,
                    "pocket": "spot",
                    "change_24h_pct": _to_float(asset_change.get("change_24h_pct"), None),
                    "quote_volume_24h": _to_float(asset_change.get("quote_volume_24h"), None),
                },
            }
        )
    return normalized


def _normalize_bitget_futures_balances(
    raw_items: list[dict],
    as_of: str,
    mark_prices: dict[str, float] | None = None,
) -> list[dict]:
    normalized: list[dict] = []
    resolved_mark_prices = mark_prices or {}
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        product_type = str(item.get("productType") or "USDT-FUTURES").strip().upper()
        asset_rows = item.get("assetList") if isinstance(item.get("assetList"), list) else []
        if asset_rows:
            for asset_row in asset_rows:
                if not isinstance(asset_row, dict):
                    continue
                asset = str(asset_row.get("coin") or "").strip().upper()
                if not asset:
                    continue
                available_qty = _to_float(asset_row.get("available"), 0.0)
                total_qty = _to_float(asset_row.get("balance"), available_qty)
                locked_qty = max(total_qty - available_qty, 0.0)
                mark_price = resolved_mark_prices.get(asset)
                if (mark_price is None or mark_price <= 0) and _is_raw_cash_asset(asset):
                    mark_price = 1.0
                equity_usd = total_qty * mark_price if mark_price else (total_qty if _is_raw_cash_asset(asset) else 0.0)
                normalized.append(
                    {
                        "asset_symbol": f"{asset}-FUTURES",
                        "available_qty": available_qty,
                        "locked_qty": locked_qty,
                        "equity_usd": equity_usd,
                        "mark_price_usd": mark_price,
                        "as_of": as_of,
                        "source": "bitget-futures",
                        "payload": {
                            **asset_row,
                            "productType": product_type,
                            "pocket": "futures",
                        },
                    }
                )
            continue
        asset = str(item.get("marginCoin") or "USDT").strip().upper()
        available_qty = _to_float(item.get("available"), 0.0)
        locked_qty = _to_float(item.get("locked"), 0.0)
        total_qty = _to_float(item.get("accountEquity"), available_qty + locked_qty)
        equity_usd = _to_float(item.get("usdtEquity"), None)
        mark_price = resolved_mark_prices.get(asset)
        if (mark_price is None or mark_price <= 0) and _is_raw_cash_asset(asset):
            mark_price = 1.0
        if equity_usd is None:
            equity_usd = total_qty * mark_price if mark_price else (total_qty if _is_raw_cash_asset(asset) else 0.0)
        normalized.append(
            {
                "asset_symbol": f"{asset}-FUTURES",
                "available_qty": available_qty,
                "locked_qty": locked_qty,
                "equity_usd": equity_usd,
                "mark_price_usd": mark_price,
                "as_of": as_of,
                "source": "bitget-futures",
                "payload": {
                    **item,
                    "productType": product_type,
                    "pocket": "futures",
                },
            }
        )
    return normalized


def _normalize_bitget_positions(raw_items: list[dict], account_id: str, as_of: str) -> list[dict]:
    positions: list[dict] = []
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        instrument = str(item.get("symbol") or item.get("instId") or "").strip().upper()
        if not instrument:
            continue
        side_hint = str(item.get("holdSide") or item.get("side") or "").strip().lower()
        quantity = abs(_to_float(item.get("total"), _to_float(item.get("available"), 0.0)))
        if side_hint == "short":
            side = "short"
        elif side_hint == "long":
            side = "long"
        else:
            side = "flat"
        mark_price = _to_float(item.get("markPrice"), 0.0)
        avg_entry_price = _to_float(item.get("openPriceAvg"), 0.0)
        notional_usd = quantity * (mark_price if mark_price > 0 else avg_entry_price if avg_entry_price > 0 else 0.0)
        if quantity <= 0 and abs(notional_usd) <= 0:
            continue
        funding_fee_usd = _to_float(item.get("totalFee"), None)
        positions.append(
            {
                "position_id": str(item.get("posId") or f"bitget:{account_id}:{instrument}:{side}"),
                "symbol": instrument,
                "instrument": instrument,
                "side": side,
                "quantity": quantity,
                "notional_usd": notional_usd,
                "avg_entry_price": avg_entry_price,
                "mark_price": mark_price,
                "pnl_unrealized_usd": _to_float(item.get("unrealizedPL"), 0.0),
                "pnl_realized_usd": _to_float(item.get("achievedProfits"), 0.0),
                "funding_fee_usd": funding_fee_usd,
                "as_of": as_of,
                "source": "bitget-position",
                "payload": {
                    **item,
                    "funding_fee_usd": funding_fee_usd,
                },
            }
        )
    return positions


async def _sync_bitget_account_state(account_id: str, account: dict | None = None) -> dict:
    account_row = account if isinstance(account, dict) else fetch_one(
        "SELECT account_id, client_id, account_type, venue, connector_type, mode, base_currency, status, external_ref, display_name, metadata, created_at, updated_at FROM accounts_registry WHERE account_id = %s",
        (account_id,),
    )
    if not account_row:
        raise ValueError("Canonical account not found")
    connector_account = _find_connector_account_for_canonical_account(account_row)
    if not connector_account or str(connector_account.get("provider") or "").strip().lower() != "bitget":
        raise ValueError("No linked Bitget connector account found for this canonical account")
    credential = _load_decrypted_connector_credential(str(connector_account.get("credential_id") or ""))
    secret_payload = credential.get("secret_payload") if isinstance(credential, dict) else None
    if not isinstance(secret_payload, dict):
        raise ValueError("Bitget credentials are missing or unreadable for this account")

    previous_balances = _latest_account_balances(account_id)
    previous_positions = _latest_account_positions(account_id)
    as_of = _now_utc().isoformat()
    product_types = ["USDT-FUTURES", "COIN-FUTURES", "USDC-FUTURES"]
    futures_tasks = [
        _bitget_signed_get(secret_payload, "/api/v2/mix/account/accounts", {"productType": product_type})
        for product_type in product_types
    ]
    position_tasks = [
        _bitget_signed_get(secret_payload, "/api/v2/mix/position/all-position", {"productType": product_type})
        for product_type in product_types
    ]
    fetch_results = await asyncio.gather(
        _bitget_signed_get(secret_payload, "/api/v2/spot/account/assets", {"assetType": "all"}),
        *futures_tasks,
        *position_tasks,
        return_exceptions=True,
    )
    errors: list[str] = []
    spot_items: list[dict] = []
    futures_balance_items: list[dict] = []
    futures_position_items: list[dict] = []
    if isinstance(fetch_results[0], Exception):
        errors.append(f"spot: {str(fetch_results[0])}")
    elif isinstance(fetch_results[0], list):
        spot_items = [item for item in fetch_results[0] if isinstance(item, dict)]
    for index, product_type in enumerate(product_types, start=1):
        result = fetch_results[index]
        if isinstance(result, Exception):
            errors.append(f"futures_balance[{product_type}]: {str(result)}")
        elif isinstance(result, list):
            futures_balance_items.extend([{**item, "productType": product_type} for item in result if isinstance(item, dict)])
    offset = 1 + len(product_types)
    for index, product_type in enumerate(product_types):
        result = fetch_results[offset + index]
        if isinstance(result, Exception):
            errors.append(f"positions[{product_type}]: {str(result)}")
        elif isinstance(result, list):
            futures_position_items.extend([{**item, "productType": product_type} for item in result if isinstance(item, dict)])
    if errors and not spot_items and not futures_balance_items and not futures_position_items:
        raise RuntimeError("; ".join(errors))

    tracked_assets = [
        *[str(item.get("coin") or "") for item in spot_items],
        *[str(item.get("marginCoin") or "") for item in futures_balance_items],
    ]
    for item in futures_balance_items:
        asset_list = item.get("assetList") if isinstance(item.get("assetList"), list) else []
        tracked_assets.extend(str(asset_row.get("coin") or "") for asset_row in asset_list if isinstance(asset_row, dict))
    mark_prices, change_stats = await _bitget_fetch_spot_market_stats(tracked_assets)
    balances = [
        *_normalize_bitget_spot_balances(spot_items, as_of, mark_prices=mark_prices, change_stats=change_stats),
        *_normalize_bitget_futures_balances(futures_balance_items, as_of, mark_prices=mark_prices),
    ]
    positions = _normalize_bitget_positions(futures_position_items, account_id, as_of)
    persisted = _persist_connector_account_state(
        account_id,
        as_of=as_of,
        balances=balances,
        positions=positions,
        balance_sources=["bitget-spot", "bitget-futures"],
        position_source_prefixes=["bitget-position"],
    )
    persisted = _postprocess_connector_sync(account_row, "bitget", as_of, balances, positions, previous_balances, previous_positions, persisted)
    persisted["status"] = "partial" if errors else "ok"
    persisted["connector_account"] = _connector_account_public_view(connector_account)
    if errors:
        persisted["warnings"] = errors
    persisted["risk_snapshots"] = _refresh_portfolio_risk_snapshots_for_account(account_id)
    append_audit(
        "bitget_account_state_synced",
        {
            "account_id": account_id,
            "status": persisted["status"],
            "balance_count": persisted["summary"]["balance_count"],
            "position_count": persisted["summary"]["position_count"],
        },
    )
    return persisted


async def _sync_supported_connector_account_state(account_id: str, account: dict | None = None) -> dict | None:
    account_row = account if isinstance(account, dict) else fetch_one(
        "SELECT account_id, client_id, account_type, venue, connector_type, mode, base_currency, status, external_ref, display_name, metadata, created_at, updated_at FROM accounts_registry WHERE account_id = %s",
        (account_id,),
    )
    if not account_row:
        return None
    connector_account = _find_connector_account_for_canonical_account(account_row)
    provider = str(
        (connector_account or {}).get("provider") if isinstance(connector_account, dict) else account_row.get("connector_type") or ""
    ).strip().lower()
    syncers = {
        "binance": _sync_binance_account_state,
        "bingx": _sync_bingx_account_state,
        "bitget": _sync_bitget_account_state,
        "okx": _sync_okx_account_state,
    }
    syncer = syncers.get(provider)
    if syncer is None:
        return None
    return await syncer(account_id, account_row)


def _provider_client_config(provider: str) -> dict:
    key = provider.strip().upper().replace("-", "_")
    client_id = os.getenv(f"{key}_OAUTH_CLIENT_ID", "").strip()
    client_secret = os.getenv(f"{key}_OAUTH_CLIENT_SECRET", "").strip()
    base = OAUTH_PROVIDER_CONFIG.get(provider, {})
    return {
        "client_id": client_id,
        "client_secret": client_secret,
        "auth_url": base.get("auth_url", ""),
        "token_url": base.get("token_url", ""),
    }


def _provider_to_preferred_venue(provider: str) -> str:
    mapping = {
        "binance": "binance-public",
        "coinbase": "paper-coinbase",
        "kraken": "paper-kraken",
        "okx": "paper-okx",
        "bitget": "paper-bitget",
        "bingx": "paper-bingx",
        "ig": "paper-ig",
    }
    return mapping.get(provider, "binance-public")


def _default_live_execution_policy() -> dict[str, Any]:
    return {
        "enabled": False,
        "connector_health": {
            "block_below": 0.70,
            "reduce_below": 0.85,
            "reduce_size_multiplier": 0.65,
            "latency_warn_ms": 80.0,
            "latency_block_ms": 120.0,
            "slippage_block_bps": 15.0,
            "max_error_rate_pct": 20.0,
        },
        "go_live_hardening": {
            "enabled": True,
            "min_live_confidence": 0.7,
            "require_human_approval_above_notional_usd": 5.0,
            "approval_exposure_threshold_pct": 40.0,
            "max_total_exposure_pct": 60.0,
            "max_symbol_exposure_pct": 25.0,
            "max_pending_live_approvals": 8,
            "drawdown_warning_ratio": 0.7,
            "enforce_memory_gate": True,
            "autonomous_sources": [
                "kairos-shadow-runtime",
                "tradingview",
                "quantower",
                "webhook",
                "signal-webhook",
            ],
            "anti_loop": {
                "enabled": True,
                "lookback_minutes": 20,
                "same_signal_limit": 3,
                "block_after_repeats": 5,
                "degraded_confidence_multiplier": 0.6,
            },
            "watchdog": {
                "enabled": True,
                "max_latency_e2e_ms": 1500,
                "max_realized_slippage_bps": 15,
                "max_block_rate": 0.35,
                "max_partial_fill_ratio": 0.55,
                "kill_on_consecutive_failures": 4,
            },
        },
        "providers": {
            "bingx": {
                "enabled": False,
                "require_route_flag": True,
                "allowed_system_modes": [SystemMode.MANAGED_LIVE.value],
                "allow_smoke_test_in_modes": [SystemMode.GUARDED_AUTO.value, SystemMode.MANAGED_LIVE.value],
                "max_order_notional_usd": 10.0,
                "default_order_notional_usd": 7.0,
                "smoke_test_notional_usd": 7.0,
                "smoke_limit_offset_bps": 3500,
                "primary_live_instrument": "BTCUSDT",
                "conditional_live_rules": {
                    "SOLUSDT": {
                        "allowed_regimes": ["TREND"],
                        "min_confidence": 0.78,
                        "reason": "sol_only_in_momentum",
                    }
                },
            }
        },
    }


def _load_live_execution_policy() -> dict[str, Any]:
    policy = _default_live_execution_policy()
    try:
        if LIVE_EXECUTION_POLICY_PATH.exists():
            raw = json.loads(LIVE_EXECUTION_POLICY_PATH.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                merged = dict(policy)
                merged.update({key: value for key, value in raw.items() if key not in {"providers", "go_live_hardening"}})
                merged_providers = dict(policy.get("providers") or {})
                raw_providers = raw.get("providers") if isinstance(raw.get("providers"), dict) else {}
                for provider_key, provider_value in raw_providers.items():
                    existing = merged_providers.get(provider_key, {})
                    merged_provider = dict(existing) if isinstance(existing, dict) else {}
                    if isinstance(provider_value, dict):
                        merged_provider.update(provider_value)
                    merged_providers[provider_key] = merged_provider
                merged["providers"] = merged_providers
                default_hardening = policy.get("go_live_hardening") if isinstance(policy.get("go_live_hardening"), dict) else {}
                merged_hardening = dict(default_hardening)
                raw_hardening = raw.get("go_live_hardening") if isinstance(raw.get("go_live_hardening"), dict) else {}
                if isinstance(raw_hardening, dict):
                    merged_hardening.update({
                        key: value
                        for key, value in raw_hardening.items()
                        if key not in {"anti_loop", "watchdog"}
                    })
                    default_anti_loop = default_hardening.get("anti_loop") if isinstance(default_hardening.get("anti_loop"), dict) else {}
                    merged_anti_loop = dict(default_anti_loop)
                    raw_anti_loop = raw_hardening.get("anti_loop") if isinstance(raw_hardening.get("anti_loop"), dict) else {}
                    merged_anti_loop.update(raw_anti_loop)
                    merged_hardening["anti_loop"] = merged_anti_loop
                    default_watchdog = default_hardening.get("watchdog") if isinstance(default_hardening.get("watchdog"), dict) else {}
                    merged_watchdog = dict(default_watchdog)
                    raw_watchdog = raw_hardening.get("watchdog") if isinstance(raw_hardening.get("watchdog"), dict) else {}
                    merged_watchdog.update(raw_watchdog)
                    merged_hardening["watchdog"] = merged_watchdog
                merged["go_live_hardening"] = merged_hardening
                return merged
    except Exception:
        pass
    return policy


def _go_live_hardening_policy() -> dict[str, Any]:
    policy = _load_live_execution_policy()
    hardening = policy.get("go_live_hardening") if isinstance(policy.get("go_live_hardening"), dict) else {}
    default_hardening = _default_live_execution_policy().get("go_live_hardening")
    merged = dict(default_hardening) if isinstance(default_hardening, dict) else {}
    merged.update({key: value for key, value in hardening.items() if key not in {"anti_loop", "watchdog"}})
    default_anti_loop = merged.get("anti_loop") if isinstance(merged.get("anti_loop"), dict) else {}
    hardening_anti_loop = hardening.get("anti_loop") if isinstance(hardening.get("anti_loop"), dict) else {}
    merged["anti_loop"] = {**default_anti_loop, **hardening_anti_loop}
    default_watchdog = merged.get("watchdog") if isinstance(merged.get("watchdog"), dict) else {}
    hardening_watchdog = hardening.get("watchdog") if isinstance(hardening.get("watchdog"), dict) else {}
    merged["watchdog"] = {**default_watchdog, **hardening_watchdog}
    return merged


def _sanitize_go_live_hardening_policy(policy: dict[str, Any] | None = None) -> dict[str, Any]:
    hardening = policy if isinstance(policy, dict) else _go_live_hardening_policy()
    anti_loop = hardening.get("anti_loop") if isinstance(hardening.get("anti_loop"), dict) else {}
    watchdog = hardening.get("watchdog") if isinstance(hardening.get("watchdog"), dict) else {}
    return {
        "enabled": _bool_from_any(hardening.get("enabled"), True),
        "min_live_confidence": _to_float(hardening.get("min_live_confidence"), 0.7),
        "require_human_approval_above_notional_usd": _to_float(hardening.get("require_human_approval_above_notional_usd"), 0.0),
        "approval_exposure_threshold_pct": _to_float(hardening.get("approval_exposure_threshold_pct"), 0.0),
        "max_total_exposure_pct": _to_float(hardening.get("max_total_exposure_pct"), 0.0),
        "max_symbol_exposure_pct": _to_float(hardening.get("max_symbol_exposure_pct"), 0.0),
        "max_pending_live_approvals": int(_to_float(hardening.get("max_pending_live_approvals"), 0.0)),
        "drawdown_warning_ratio": _to_float(hardening.get("drawdown_warning_ratio"), 0.0),
        "enforce_memory_gate": _bool_from_any(hardening.get("enforce_memory_gate"), True),
        "autonomous_sources": [str(item).strip() for item in hardening.get("autonomous_sources", []) if str(item).strip()],
        "anti_loop": {
            "enabled": _bool_from_any(anti_loop.get("enabled"), True),
            "lookback_minutes": int(_to_float(anti_loop.get("lookback_minutes"), 20.0)),
            "same_signal_limit": int(_to_float(anti_loop.get("same_signal_limit"), 3.0)),
            "block_after_repeats": int(_to_float(anti_loop.get("block_after_repeats"), 5.0)),
            "degraded_confidence_multiplier": _to_float(anti_loop.get("degraded_confidence_multiplier"), 0.6),
        },
        "watchdog": {
            "enabled": _bool_from_any(watchdog.get("enabled"), True),
            "max_latency_e2e_ms": int(_to_float(watchdog.get("max_latency_e2e_ms"), 1500.0)),
            "max_realized_slippage_bps": _to_float(watchdog.get("max_realized_slippage_bps"), 15.0),
            "max_block_rate": _to_float(watchdog.get("max_block_rate"), 0.35),
            "max_partial_fill_ratio": _to_float(watchdog.get("max_partial_fill_ratio"), 0.55),
            "kill_on_consecutive_failures": int(_to_float(watchdog.get("kill_on_consecutive_failures"), 4.0)),
        },
    }


def _extract_trade_governance(payload: dict[str, Any] | None) -> dict[str, Any]:
    raw = payload if isinstance(payload, dict) else {}
    metadata = raw.get("metadata") if isinstance(raw.get("metadata"), dict) else {}
    order_intent = raw.get("order_intent") if isinstance(raw.get("order_intent"), dict) else {}
    governance = metadata.get("governance") if isinstance(metadata.get("governance"), dict) else order_intent.get("governance") if isinstance(order_intent.get("governance"), dict) else {}
    return {
        "approved": _bool_from_any(governance.get("approved"), False),
        "approver": str(governance.get("approver") or "").strip(),
        "approval_id": str(governance.get("approval_id") or "").strip(),
        "approval_mode": str(governance.get("approval_mode") or "").strip(),
        "override": _bool_from_any(governance.get("override"), False),
    }


def _account_live_exposure_snapshot(account_id: str, symbol: str, requested_notional_usd: float) -> dict[str, Any]:
    account_key = str(account_id or "").strip()
    normalized_symbol = _normalize_symbol(symbol)
    if not account_key:
        return {
            "account_id": "",
            "equity_usd": 0.0,
            "gross_exposure_usd": 0.0,
            "gross_exposure_pct": 0.0,
            "symbol_gross_exposure_usd": 0.0,
            "symbol_exposure_pct": 0.0,
            "projected_total_exposure_pct": 0.0,
            "projected_symbol_exposure_pct": 0.0,
            "portfolio_ids": [],
            "positions_count": 0,
            "exposure_known": False,
        }

    balances = _latest_account_balances(account_key)
    positions = _latest_account_positions(account_key)
    equity_usd = sum(_to_float(item.get("equity_usd"), 0.0) for item in balances if isinstance(item, dict))
    gross_exposure_usd = sum(abs(_to_float(item.get("notional_usd"), 0.0)) for item in positions if isinstance(item, dict))
    symbol_gross_exposure_usd = sum(
        abs(_to_float(item.get("notional_usd"), 0.0))
        for item in positions
        if isinstance(item, dict) and _normalize_symbol(str(item.get("symbol") or item.get("instrument") or "")) == normalized_symbol
    )
    gross_exposure_pct = (gross_exposure_usd / equity_usd * 100.0) if equity_usd > 0 else 0.0
    symbol_exposure_pct = (symbol_gross_exposure_usd / equity_usd * 100.0) if equity_usd > 0 else 0.0
    projected_total_exposure_pct = ((gross_exposure_usd + max(0.0, requested_notional_usd)) / equity_usd * 100.0) if equity_usd > 0 else 0.0
    projected_symbol_exposure_pct = ((symbol_gross_exposure_usd + max(0.0, requested_notional_usd)) / equity_usd * 100.0) if equity_usd > 0 else 0.0
    return {
        "account_id": account_key,
        "equity_usd": round(equity_usd, 8),
        "gross_exposure_usd": round(gross_exposure_usd, 8),
        "gross_exposure_pct": round(gross_exposure_pct, 4),
        "symbol_gross_exposure_usd": round(symbol_gross_exposure_usd, 8),
        "symbol_exposure_pct": round(symbol_exposure_pct, 4),
        "projected_total_exposure_pct": round(projected_total_exposure_pct, 4),
        "projected_symbol_exposure_pct": round(projected_symbol_exposure_pct, 4),
        "portfolio_ids": _portfolio_ids_for_account(account_key),
        "positions_count": len([item for item in positions if isinstance(item, dict)]),
        "exposure_known": equity_usd > 0,
    }


def _recent_pending_live_approval_count(account_id: str = "") -> int:
    if account_id:
        row = fetch_one(
            "SELECT COUNT(*) AS count FROM mt5_live_approvals WHERE status = 'pending' AND account_id = %s",
            (account_id,),
        ) or {"count": 0}
    else:
        row = fetch_one("SELECT COUNT(*) AS count FROM mt5_live_approvals WHERE status = 'pending'") or {"count": 0}
    return int(row.get("count") or 0)


def _go_live_signal_loop_snapshot(account_id: str, symbol: str, side: str, source: str, lookback_minutes: int) -> dict[str, Any]:
    safe_lookback = max(1, min(24 * 60, int(lookback_minutes or 20)))
    normalized_symbol = _normalize_symbol(symbol)
    source_key = str(source or "").strip()
    rows = fetch_all(
        """
        SELECT COALESCE(payload->>'status', '') AS status,
               COALESCE(payload->>'account_id', '') AS account_id,
               COALESCE(payload->>'symbol', '') AS symbol,
               COALESCE(payload->>'side', '') AS side,
               COALESCE(payload->>'source', '') AS source,
               created_at
        FROM audit_events
        WHERE category = 'go_live_hardening_decision'
          AND created_at >= NOW() - (%s * INTERVAL '1 minute')
          AND COALESCE(payload->>'account_id', '') = %s
          AND COALESCE(payload->>'symbol', '') = %s
          AND COALESCE(payload->>'side', '') = %s
        ORDER BY created_at DESC
        LIMIT 24
        """,
        (safe_lookback, str(account_id or "").strip(), normalized_symbol, str(side or "").strip().lower()),
    )
    same_source_repeats = sum(1 for row in rows if not source_key or str(row.get("source") or "").strip() == source_key)
    blocked_count = sum(1 for row in rows if str(row.get("status") or "") == "blocked")
    return {
        "lookback_minutes": safe_lookback,
        "repeat_count": len(rows),
        "same_source_repeat_count": same_source_repeats,
        "blocked_repeat_count": blocked_count,
    }


def _go_live_status_rank(status: str) -> int:
    return {"approved": 0, "require_human": 1, "blocked": 2}.get(str(status or "approved"), 0)


def _promote_go_live_status(current: str, candidate: str) -> str:
    return candidate if _go_live_status_rank(candidate) > _go_live_status_rank(current) else current


def _evaluate_go_live_hardening(
    *,
    source: str,
    provider: str,
    account_id: str,
    symbol: str,
    side: str,
    requested_notional_usd: float,
    confidence: float,
    live_requested: bool,
    purpose: str,
    pre_trade_memory_gate: dict[str, Any] | None = None,
    governance: dict[str, Any] | None = None,
) -> dict[str, Any]:
    policy = _sanitize_go_live_hardening_policy()
    governance_view = governance if isinstance(governance, dict) else {
        "approved": False,
        "approver": "",
        "approval_id": "",
        "approval_mode": "",
        "override": False,
    }
    normalized_symbol = _normalize_symbol(symbol)
    normalized_side = str(side or "buy").strip().lower() or "buy"
    status = "approved"
    reasons: list[str] = []
    active = _bool_from_any(policy.get("enabled"), True) and (live_requested or purpose == "smoke")
    effective_confidence = _clamp(_to_float(confidence, 0.0), 0.0, 1.0)
    exposure = _account_live_exposure_snapshot(account_id, normalized_symbol, requested_notional_usd)
    anti_loop_policy = policy.get("anti_loop") if isinstance(policy.get("anti_loop"), dict) else {}
    anti_loop = _go_live_signal_loop_snapshot(
        account_id,
        normalized_symbol,
        normalized_side,
        source,
        int(_to_float(anti_loop_policy.get("lookback_minutes"), 20.0)),
    ) if active and _bool_from_any(anti_loop_policy.get("enabled"), True) else {
        "lookback_minutes": int(_to_float(anti_loop_policy.get("lookback_minutes"), 20.0)),
        "repeat_count": 0,
        "same_source_repeat_count": 0,
        "blocked_repeat_count": 0,
    }
    kill_state = _kill_switch_state()
    drawdown_threshold = max(_kill_switch_thresholds().get("max_drawdown_intraday", 1.0), 1.0)
    drawdown_intraday_usd = _to_float(((kill_state.get("stats") or {}) if isinstance(kill_state.get("stats"), dict) else {}).get("drawdown_intraday_usd"), 0.0)
    pending_live_approvals = _recent_pending_live_approval_count(account_id)

    if active and kill_state.get("active"):
        reasons.append("kill_switch_active")
        status = _promote_go_live_status(status, "blocked")

    if active and _bool_from_any(policy.get("enforce_memory_gate"), True):
        memory_gate = pre_trade_memory_gate if isinstance(pre_trade_memory_gate, dict) else {}
        if _bool_from_any(memory_gate.get("block_execution"), False):
            reasons.append("memory_pretrade_gate_blocked")
            status = _promote_go_live_status(status, "blocked")

    same_signal_limit = max(1, int(_to_float(anti_loop_policy.get("same_signal_limit"), 3.0)))
    block_after_repeats = max(same_signal_limit, int(_to_float(anti_loop_policy.get("block_after_repeats"), 5.0)))
    degraded_confidence_multiplier = _clamp(_to_float(anti_loop_policy.get("degraded_confidence_multiplier"), 0.6), 0.1, 1.0)
    anti_loop_degraded = anti_loop.get("repeat_count", 0) >= same_signal_limit
    anti_loop_blocked = anti_loop.get("repeat_count", 0) >= block_after_repeats
    if active and anti_loop_degraded:
        effective_confidence = _clamp(effective_confidence * degraded_confidence_multiplier, 0.0, 1.0)
        reasons.append("anti_loop_confidence_degraded")
    if active and anti_loop_blocked:
        reasons.append("anti_loop_repetition_blocked")
        status = _promote_go_live_status(status, "blocked")

    min_live_confidence = _to_float(policy.get("min_live_confidence"), 0.7)
    if active and min_live_confidence > 0 and effective_confidence < min_live_confidence:
        reasons.append("confidence_below_governance_threshold")
        status = _promote_go_live_status(status, "blocked")

    max_total_exposure_pct = _to_float(policy.get("max_total_exposure_pct"), 0.0)
    max_symbol_exposure_pct = _to_float(policy.get("max_symbol_exposure_pct"), 0.0)
    approval_exposure_threshold_pct = _to_float(policy.get("approval_exposure_threshold_pct"), 0.0)
    if active and not exposure.get("exposure_known"):
        reasons.append("live_exposure_unknown")
        if not governance_view.get("approved"):
            status = _promote_go_live_status(status, "require_human")
    if active and max_total_exposure_pct > 0 and _to_float(exposure.get("projected_total_exposure_pct"), 0.0) > max_total_exposure_pct:
        reasons.append("max_total_exposure_exceeded")
        status = _promote_go_live_status(status, "blocked")
    if active and max_symbol_exposure_pct > 0 and _to_float(exposure.get("projected_symbol_exposure_pct"), 0.0) > max_symbol_exposure_pct:
        reasons.append("max_symbol_exposure_exceeded")
        status = _promote_go_live_status(status, "blocked")

    max_pending_live_approvals = max(0, int(_to_float(policy.get("max_pending_live_approvals"), 0.0)))
    if active and max_pending_live_approvals > 0 and pending_live_approvals >= max_pending_live_approvals:
        reasons.append("pending_live_approval_backlog")
        status = _promote_go_live_status(status, "blocked")

    drawdown_warning_ratio = _clamp(_to_float(policy.get("drawdown_warning_ratio"), 0.7), 0.0, 1.0)
    drawdown_ratio = drawdown_intraday_usd / drawdown_threshold if drawdown_threshold > 0 else 0.0
    if active and drawdown_warning_ratio > 0 and drawdown_ratio >= drawdown_warning_ratio and not governance_view.get("approved"):
        reasons.append("drawdown_near_limit_requires_governance")
        status = _promote_go_live_status(status, "require_human")

    autonomous_sources = {str(item).strip() for item in policy.get("autonomous_sources", []) if str(item).strip()}
    require_human_above_notional_usd = _to_float(policy.get("require_human_approval_above_notional_usd"), 0.0)
    if active and not governance_view.get("approved"):
        if require_human_above_notional_usd > 0 and requested_notional_usd >= require_human_above_notional_usd:
            reasons.append("governance_approval_required_notional")
            status = _promote_go_live_status(status, "require_human")
        if source in autonomous_sources:
            reasons.append("governance_approval_required_autonomous_source")
            status = _promote_go_live_status(status, "require_human")
        if approval_exposure_threshold_pct > 0 and _to_float(exposure.get("projected_total_exposure_pct"), 0.0) >= approval_exposure_threshold_pct:
            reasons.append("governance_approval_required_exposure")
            status = _promote_go_live_status(status, "require_human")

    result = {
        "active": active,
        "status": status,
        "source": source,
        "provider": provider,
        "account_id": str(account_id or "").strip(),
        "symbol": normalized_symbol,
        "side": normalized_side,
        "requested_notional_usd": round(max(0.0, requested_notional_usd), 8),
        "input_confidence": _clamp(_to_float(confidence, 0.0), 0.0, 1.0),
        "effective_confidence": effective_confidence,
        "reasons": sorted(set(reasons)),
        "governance": governance_view,
        "policy": policy,
        "exposure": exposure,
        "anti_loop": {
            **anti_loop,
            "degraded": anti_loop_degraded,
            "blocked": anti_loop_blocked,
            "degraded_confidence_multiplier": degraded_confidence_multiplier,
        },
        "drawdown_intraday_usd": round(drawdown_intraday_usd, 8),
        "drawdown_ratio": round(drawdown_ratio, 6),
        "kill_switch_active": bool(kill_state.get("active")),
        "pending_live_approvals": pending_live_approvals,
        "purpose": purpose,
    }
    if active:
        append_audit(
            "go_live_hardening_decision",
            {
                "status": result["status"],
                "source": source,
                "provider": provider,
                "account_id": result["account_id"],
                "symbol": normalized_symbol,
                "side": normalized_side,
                "requested_notional_usd": result["requested_notional_usd"],
                "effective_confidence": effective_confidence,
                "reasons": result["reasons"],
                "governance": governance_view,
                "anti_loop": result["anti_loop"],
                "exposure": exposure,
                "purpose": purpose,
            },
        )
    return result


def _provider_live_env_enabled(provider: str) -> bool:
    provider_key = str(provider or "").strip().upper().replace("-", "_")
    return _bool_from_any(os.getenv("TXT_ENABLE_LIVE_ROUTING"), False) or _bool_from_any(os.getenv(f"{provider_key}_LIVE_ROUTING_ENABLED"), False)


def _linked_connector_account(provider: str, account_id: str) -> dict[str, Any] | None:
    provider_norm = _normalize_connector_provider(provider)
    account_key = _normalize_account_id(account_id)
    if not provider_norm or not account_key:
        return None
    return next(
        (
            item
            for item in _load_connector_accounts()
            if str(item.get("provider", "")).strip().lower() == provider_norm
            and _normalize_account_id(item.get("account_id")) == account_key
        ),
        None,
    )


def _preferred_execution_venue(provider: str, *, live_enabled: bool = False) -> str:
    provider_norm = _normalize_connector_provider(provider)
    capabilities = _exchange_capabilities(provider_norm)
    if provider_norm and not _bool_from_any(capabilities.get("known"), False):
        return ""
    if live_enabled and _bool_from_any(capabilities.get("execution"), False):
        execution_venue = str(capabilities.get("execution_venue") or "").strip()
        if execution_venue:
            return execution_venue
    return _provider_to_preferred_venue(provider_norm)


def _sanitize_live_execution_policy(provider_policy: dict[str, Any]) -> dict[str, Any]:
    return {
        "enabled": _bool_from_any(provider_policy.get("enabled"), False),
        "require_route_flag": _bool_from_any(provider_policy.get("require_route_flag"), True),
        "allowed_system_modes": provider_policy.get("allowed_system_modes") if isinstance(provider_policy.get("allowed_system_modes"), list) else [],
        "allow_smoke_test_in_modes": provider_policy.get("allow_smoke_test_in_modes") if isinstance(provider_policy.get("allow_smoke_test_in_modes"), list) else [],
        "max_order_notional_usd": _to_float(provider_policy.get("max_order_notional_usd"), 0.0),
        "default_order_notional_usd": _to_float(provider_policy.get("default_order_notional_usd"), 0.0),
        "smoke_test_notional_usd": _to_float(provider_policy.get("smoke_test_notional_usd"), 0.0),
        "smoke_limit_offset_bps": _to_float(provider_policy.get("smoke_limit_offset_bps"), 0.0),
        "primary_live_instrument": str(provider_policy.get("primary_live_instrument") or "").strip().upper(),
        "conditional_live_rules": provider_policy.get("conditional_live_rules") if isinstance(provider_policy.get("conditional_live_rules"), dict) else {},
    }


def _resolve_live_rule_reasons(
    provider_policy: dict[str, Any],
    *,
    symbol: str,
    regime: str,
    confidence: float,
) -> list[str]:
    normalized_symbol = _normalize_symbol(symbol)
    if not normalized_symbol:
        return []

    primary_instrument = _normalize_symbol(str(provider_policy.get("primary_live_instrument") or ""))
    conditional_rules = provider_policy.get("conditional_live_rules") if isinstance(provider_policy.get("conditional_live_rules"), dict) else {}
    matched_rule = None
    for raw_symbol, candidate_rule in conditional_rules.items():
        if _normalize_symbol(str(raw_symbol)) == normalized_symbol and isinstance(candidate_rule, dict):
            matched_rule = candidate_rule
            break

    reasons: list[str] = []
    if primary_instrument and normalized_symbol != primary_instrument and not isinstance(matched_rule, dict):
        reasons.append("instrument_not_live_enabled")
        return reasons

    if not isinstance(matched_rule, dict):
        return reasons

    allowed_regimes = {
        str(item).strip().upper()
        for item in matched_rule.get("allowed_regimes", [])
        if str(item).strip()
    }
    resolved_regime = str(regime or "UNKNOWN").strip().upper() or "UNKNOWN"
    if allowed_regimes and resolved_regime not in allowed_regimes:
        reasons.append("conditional_live_regime_not_allowed")

    min_confidence = _to_float(matched_rule.get("min_confidence"), 0.0)
    if min_confidence > 0 and confidence < min_confidence:
        reasons.append("conditional_live_confidence_below_threshold")

    return reasons


def _resolve_live_execution_request(
    provider: str,
    account_id: str,
    *,
    requested_notional_usd: float,
    explicit_flag: bool,
    purpose: str = "execute",
    paper_only: bool = False,
    symbol: str = "",
    regime: str = "UNKNOWN",
    confidence: float = 0.0,
) -> dict[str, Any]:
    provider_norm = _normalize_connector_provider(provider)
    account_key = _normalize_account_id(account_id)
    exchange_capabilities = _exchange_capabilities(provider_norm)
    policy = _load_live_execution_policy()
    provider_policy = policy.get("providers", {}).get(provider_norm) if isinstance(policy.get("providers"), dict) else {}
    provider_policy = provider_policy if isinstance(provider_policy, dict) else {}
    reasons: list[str] = []
    if not _bool_from_any(exchange_capabilities.get("known"), False):
        reasons.append("unknown_provider")
    elif not _bool_from_any(exchange_capabilities.get("execution"), False):
        reasons.append("execution_not_supported")
    if not _bool_from_any(policy.get("enabled"), False):
        reasons.append("live_policy_globally_disabled")
    if not _bool_from_any(provider_policy.get("enabled"), False):
        reasons.append("provider_live_disabled")
    if _bool_from_any(provider_policy.get("require_route_flag"), True) and not explicit_flag:
        reasons.append("live_route_flag_disabled")
    if not _provider_live_env_enabled(provider_norm):
        reasons.append("live_env_flag_disabled")
    if purpose == "execute" and paper_only:
        reasons.append("risk_policy_paper_only")
    reasons.extend(
        _resolve_live_rule_reasons(
            provider_policy,
            symbol=symbol,
            regime=regime,
            confidence=confidence,
        )
    )

    connector_degradation: dict[str, Any] = {}
    try:
        connector_degradation = _connector_live_degradation_snapshot(provider_norm)
    except Exception:
        connector_degradation = {
            "provider": provider_norm,
            "state": "unknown",
            "auto_disable_live": True,
            "diagnostic": "degradation-check-failed",
            "diagnostics": ["degradation-check-failed"],
            "health_score": 0.0,
            "health_action": "block",
            "size_multiplier": 0.0,
        }
        reasons.append("connector_degradation_check_failed")
    advisories: list[str] = []
    health_action = str(connector_degradation.get("health_action") or "ok").strip().lower()
    size_multiplier = _clamp(_to_float(connector_degradation.get("size_multiplier"), 1.0), 0.0, 1.0)
    effective_notional_usd = round(requested_notional_usd * size_multiplier, 8)
    if health_action == "block":
        reasons.append("connector_health_score_blocked")
    elif health_action == "reduce_size" and requested_notional_usd > 0 and effective_notional_usd < requested_notional_usd:
        advisories.append("connector_health_reduce_size")
    if bool(connector_degradation.get("auto_disable_live")):
        reasons.append("connector_auto_disable_live")

    linked_account = _linked_connector_account(provider_norm, account_key)
    if not linked_account:
        reasons.append("linked_account_missing")
        credential = None
        secret_payload = None
    else:
        if str(linked_account.get("mode") or "read").strip().lower() != "trade":
            reasons.append("linked_account_read_only")
        credential = _load_decrypted_connector_credential(str(linked_account.get("credential_id") or ""))
        secret_payload = credential.get("secret_payload") if isinstance(credential, dict) and isinstance(credential.get("secret_payload"), dict) else None
        if not isinstance(secret_payload, dict):
            reasons.append("linked_credentials_missing")

    if purpose == "smoke":
        allowed_modes = provider_policy.get("allow_smoke_test_in_modes") if isinstance(provider_policy.get("allow_smoke_test_in_modes"), list) else []
        notional_limit = _to_float(provider_policy.get("smoke_test_notional_usd"), 0.0)
    else:
        allowed_modes = provider_policy.get("allowed_system_modes") if isinstance(provider_policy.get("allowed_system_modes"), list) else []
        notional_limit = _to_float(provider_policy.get("max_order_notional_usd"), 0.0)
    if allowed_modes and CURRENT_SYSTEM_MODE.value not in {str(item) for item in allowed_modes}:
        reasons.append("system_mode_not_live_enabled")
    if notional_limit > 0 and requested_notional_usd > notional_limit:
        reasons.append("requested_notional_exceeds_live_limit")

    enabled = len(reasons) == 0
    return {
        "enabled": enabled,
        "provider": provider_norm,
        "account_id": account_key,
        "capabilities": exchange_capabilities,
        "execution_venue": _preferred_execution_venue(provider_norm, live_enabled=enabled),
        "reasons": reasons,
        "advisories": advisories,
        "paper_only": paper_only,
        "health_score": _to_float(connector_degradation.get("health_score"), 0.0),
        "health_action": health_action,
        "size_multiplier": size_multiplier,
        "requested_notional_usd": round(requested_notional_usd, 8),
        "effective_notional_usd": effective_notional_usd,
        "policy": _sanitize_live_execution_policy(provider_policy),
        "connector_degradation": connector_degradation,
        "linked_account": _connector_account_public_view(linked_account),
        "secret_payload": secret_payload if enabled else None,
    }


def _intent_live_execution_context(intent_payload: dict[str, Any]) -> dict[str, Any]:
    explainability = intent_payload.get("explainability") if isinstance(intent_payload.get("explainability"), dict) else {}
    live = explainability.get("live_execution") if isinstance(explainability.get("live_execution"), dict) else {}
    provider = _normalize_connector_provider(live.get("provider") or intent_payload.get("venue") or "")
    account_id = _normalize_account_id(live.get("account_id") or explainability.get("account_id") or "")
    requested = _bool_from_any(live.get("enabled"), False) or _bool_from_any(live.get("requested"), False)
    return {
        "requested": requested and bool(provider) and bool(account_id),
        "provider": provider,
        "account_id": account_id,
        "order_type": str(live.get("order_type") or "MARKET").strip().upper(),
        "position_side": str(live.get("position_side") or "").strip().upper(),
        "reduce_only": _bool_from_any(live.get("reduce_only"), False),
    }


def _normalize_ui_preferences(payload: dict | None) -> dict:
    raw = payload or {}
    normalized: dict[str, object] = {}
    ui_mode = str(raw.get("uiMode") or "").strip().lower()
    if ui_mode in {"novice", "expert"}:
        normalized["uiMode"] = ui_mode
    chart_motion_preset = str(raw.get("chartMotionPreset") or "").strip().lower()
    if chart_motion_preset in {"stable", "balanced", "aggressive"}:
        normalized["chartMotionPreset"] = chart_motion_preset
    chart_snap_enabled = raw.get("chartSnapEnabled")
    if isinstance(chart_snap_enabled, bool):
        normalized["chartSnapEnabled"] = chart_snap_enabled
    chart_snap_priority = str(raw.get("chartSnapPriority") or "").strip().lower()
    if chart_snap_priority in {"execution", "vwap", "liquidity"}:
        normalized["chartSnapPriority"] = chart_snap_priority
    chart_release_send_mode = str(raw.get("chartReleaseSendMode") or "").strip().lower()
    if chart_release_send_mode in {"one-click", "confirm-required"}:
        normalized["chartReleaseSendMode"] = chart_release_send_mode
    chart_haptic_mode = str(raw.get("chartHapticMode") or "").strip().lower()
    if chart_haptic_mode in {"off", "light", "medium"}:
        normalized["chartHapticMode"] = chart_haptic_mode

    def _normalize_account_map(value: object) -> dict[str, dict]:
        if not isinstance(value, dict):
            return {}
        sanitized: dict[str, dict] = {}
        for account_key, account_value in value.items():
            key = str(account_key).strip()
            if not key or not isinstance(account_value, dict):
                continue
            sanitized[key] = account_value
        return sanitized

    layout_map = _normalize_account_map(raw.get("terminalLayoutByAccount"))
    if layout_map:
        normalized["terminalLayoutByAccount"] = layout_map

    workspace_map = _normalize_account_map(raw.get("terminalWorkspacesByAccount"))
    if workspace_map:
        normalized["terminalWorkspacesByAccount"] = workspace_map

    floating_preset_map = _normalize_account_map(raw.get("terminalFloatingPresetsByAccount"))
    if floating_preset_map:
        normalized["terminalFloatingPresetsByAccount"] = floating_preset_map
    return normalized


def _parse_iso_utc(value: str | None) -> datetime | None:
    if not value:
        return None
    normalized = value.strip().replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(normalized)
    except ValueError:
        return None


def _get_ui_preferences_row(user_id: int) -> tuple[dict, str | None]:
    row = fetch_one("SELECT preferences, updated_at FROM user_ui_preferences WHERE user_id = %s", (user_id,))
    if not row:
        return {}, None
    preferences = row.get("preferences") or {}
    updated_at = row.get("updated_at")
    updated_label = updated_at.isoformat() if updated_at else None
    return (preferences if isinstance(preferences, dict) else {}), updated_label


def _save_ui_preferences(user_id: int, preferences: dict) -> tuple[dict, str | None]:
    normalized = _normalize_ui_preferences(preferences)
    row = fetch_one(
        """
        INSERT INTO user_ui_preferences (user_id, preferences)
        VALUES (%s, %s::jsonb)
        ON CONFLICT (user_id)
        DO UPDATE SET preferences = EXCLUDED.preferences, updated_at = NOW()
        RETURNING updated_at
        """,
        (user_id, json_dumps(normalized)),
    )
    updated_at = row.get("updated_at").isoformat() if row and row.get("updated_at") else None
    return normalized, updated_at


def _normalize_self_learning_v4_scope(payload: dict | None) -> tuple[str, str, str] | None:
    if not isinstance(payload, dict):
        return None
    account_id = _normalize_account_id(payload.get("accountId") or payload.get("account_id"))
    symbol = str(payload.get("symbol") or "").strip().upper()
    timeframe = str(payload.get("timeframe") or "").strip().lower()
    if not account_id or not symbol or not timeframe:
        return None
    return account_id, symbol, timeframe


def _normalize_self_learning_v4_state(payload: dict | None) -> dict | None:
    scope = _normalize_self_learning_v4_scope(payload)
    if not scope:
        return None
    account_id, symbol, timeframe = scope
    raw = payload if isinstance(payload, dict) else {}
    filters = raw.get("filters") if isinstance(raw.get("filters"), dict) else {}
    regime_filter = str(filters.get("regime") or "all").strip().lower()
    if regime_filter not in {"all", "trend", "chop", "volatile"}:
        regime_filter = "all"
    scenario_filter = str(filters.get("scenario") or "all").strip().lower()
    if scenario_filter not in {"all", "continuation", "reversal", "balance"}:
        scenario_filter = "all"
    snapshot = raw.get("snapshot") if isinstance(raw.get("snapshot"), dict) else {}
    journal_raw = raw.get("journal") if isinstance(raw.get("journal"), list) else []
    journal: list[dict] = []
    seen_ids: set[str] = set()
    for item in journal_raw:
        if not isinstance(item, dict):
            continue
        event_id = str(item.get("id") or "").strip()
        if not event_id or event_id in seen_ids:
            continue
        seen_ids.add(event_id)
        outcome = str(item.get("outcome") or "").strip().lower()
        if outcome not in {"win", "loss"}:
            continue
        regime = str(item.get("regime") or "").strip().lower()
        scenario = str(item.get("scenario") or "").strip().lower()
        if regime not in {"trend", "chop", "volatile"} or scenario not in {"continuation", "reversal", "balance"}:
            continue
        journal.append(
            {
                "id": event_id,
                "timestampIso": str(item.get("timestampIso") or _now_utc().isoformat()),
                "symbol": symbol,
                "timeframe": timeframe,
                "regime": regime,
                "scenario": scenario,
                "outcome": outcome,
                "pnl": _to_float(item.get("pnl"), 0.0),
                "mfe": _to_float(item.get("mfe"), 0.0),
                "mae": _to_float(item.get("mae"), 0.0),
                "weights": item.get("weights") if isinstance(item.get("weights"), dict) else {},
            }
        )
        if len(journal) >= 240:
            break

    updated_at = _now_utc().isoformat()
    return {
        "version": max(1, int(raw.get("version", 1))) if str(raw.get("version", "")).strip() else 1,
        "accountId": account_id,
        "symbol": symbol,
        "timeframe": timeframe,
        "enabled": bool(raw.get("enabled", True)),
        "autoAdaptEnabled": bool(raw.get("autoAdaptEnabled", True)),
        "modelUpdatedAt": raw.get("modelUpdatedAt") if isinstance(raw.get("modelUpdatedAt"), str) else None,
        "driftAutoDemotedAt": raw.get("driftAutoDemotedAt") if isinstance(raw.get("driftAutoDemotedAt"), str) else None,
        "filters": {
            "regime": regime_filter,
            "scenario": scenario_filter,
        },
        "snapshot": snapshot if isinstance(snapshot, dict) else {},
        "journal": journal,
        "updatedAt": updated_at,
    }


def _get_self_learning_v4_state(user_id: int, account_id: str, symbol: str, timeframe: str) -> tuple[dict | None, str | None]:
    row = fetch_one(
        """
        SELECT state, updated_at
        FROM self_learning_v4_states
        WHERE user_id = %s AND account_id = %s AND symbol = %s AND timeframe = %s
        """,
        (user_id, account_id, symbol.upper(), timeframe.lower()),
    )
    if not row:
        return None, None
    state = row.get("state") if isinstance(row.get("state"), dict) else {}
    normalized = _normalize_self_learning_v4_state(
        {
            **state,
            "accountId": account_id,
            "symbol": symbol.upper(),
            "timeframe": timeframe.lower(),
        }
    )
    updated_at = row.get("updated_at")
    return normalized, (updated_at.isoformat() if updated_at else None)


def _save_self_learning_v4_state(user_id: int, payload: dict) -> tuple[dict, str]:
    normalized = _normalize_self_learning_v4_state(payload)
    if not normalized:
        raise HTTPException(status_code=400, detail="invalid self-learning-v4 payload")
    execute(
        """
        INSERT INTO self_learning_v4_states (user_id, account_id, symbol, timeframe, state)
        VALUES (%s, %s, %s, %s, %s::jsonb)
        ON CONFLICT (user_id, account_id, symbol, timeframe)
        DO UPDATE SET state = EXCLUDED.state, updated_at = NOW()
        """,
        (
            user_id,
            normalized["accountId"],
            normalized["symbol"],
            normalized["timeframe"],
            json_dumps(normalized),
        ),
    )
    row = fetch_one(
        """
        SELECT updated_at
        FROM self_learning_v4_states
        WHERE user_id = %s AND account_id = %s AND symbol = %s AND timeframe = %s
        """,
        (
            user_id,
            normalized["accountId"],
            normalized["symbol"],
            normalized["timeframe"],
        ),
    )
    updated_at = row.get("updated_at").isoformat() if row and row.get("updated_at") else _now_utc().isoformat()
    normalized["updatedAt"] = updated_at
    return normalized, updated_at


def _list_self_learning_v4_scopes(user_id: int, account_id: str = "", symbol: str = "", timeframe: str = "", limit: int = 120) -> list[dict]:
    where_clauses = ["user_id = %s"]
    params: list[object] = [user_id]
    if account_id:
        where_clauses.append("account_id = %s")
        params.append(account_id)
    if symbol:
        where_clauses.append("symbol = %s")
        params.append(symbol.upper())
    if timeframe:
        where_clauses.append("timeframe = %s")
        params.append(timeframe.lower())
    params.append(max(1, min(500, int(limit))))
    rows = fetch_all(
        f"""
        SELECT account_id, symbol, timeframe, state, updated_at
        FROM self_learning_v4_states
        WHERE {' AND '.join(where_clauses)}
        ORDER BY updated_at DESC
        LIMIT %s
        """,
        tuple(params),
    )
    items: list[dict] = []
    for row in rows:
        state = row.get("state") if isinstance(row.get("state"), dict) else {}
        drift = state.get("snapshot", {}).get("drift", {}) if isinstance(state.get("snapshot"), dict) else {}
        items.append(
            {
                "accountId": row.get("account_id"),
                "symbol": row.get("symbol"),
                "timeframe": row.get("timeframe"),
                "updatedAt": row.get("updated_at").isoformat() if row.get("updated_at") else None,
                "journalSize": len(state.get("journal") or []) if isinstance(state.get("journal"), list) else 0,
                "enabled": bool(state.get("enabled", True)),
                "autoAdaptEnabled": bool(state.get("autoAdaptEnabled", True)),
                "driftStatus": str(drift.get("status") or "WARMUP"),
            }
        )
    return items

def _normalize_self_learning_v5_scope(payload: dict | None) -> tuple[str, str, str] | None:
    if not isinstance(payload, dict):
        return None
    account_id = _normalize_account_id(payload.get("accountId") or payload.get("account_id"))
    symbol = str(payload.get("symbol") or "").strip().upper()
    timeframe = str(payload.get("timeframe") or "").strip().lower()
    if not account_id or not symbol or not timeframe:
        return None
    return account_id, symbol, timeframe

def _normalize_self_learning_v5_state(payload: dict | None) -> dict | None:
    scope = _normalize_self_learning_v5_scope(payload)
    if not scope:
        return None
    account_id, symbol, timeframe = scope
    raw = payload if isinstance(payload, dict) else {}
    snapshot = raw.get("snapshot") if isinstance(raw.get("snapshot"), dict) else {}
    cycles_raw = raw.get("cycles") if isinstance(raw.get("cycles"), list) else []
    cycles: list[dict] = []
    seen_ids: set[str] = set()
    for item in cycles_raw:
        if not isinstance(item, dict):
            continue
        cycle_id = str(item.get("id") or "").strip()
        if not cycle_id or cycle_id in seen_ids:
            continue
        seen_ids.add(cycle_id)
        cycles.append(
            {
                "id": cycle_id,
                "timestampIso": str(item.get("timestampIso") or _now_utc().isoformat()),
                "summary": str(item.get("summary") or ""),
                "bestStrategyId": item.get("bestStrategyId"),
                "acceptedVariants": int(_to_float(item.get("acceptedVariants"), 0.0)),
                "liveBlocked": bool(item.get("liveBlocked", True)),
            }
        )
        if len(cycles) >= 40:
            break

    updated_at = _now_utc().isoformat()
    return {
        "version": max(1, int(raw.get("version", 1))) if str(raw.get("version", "")).strip() else 1,
        "accountId": account_id,
        "symbol": symbol,
        "timeframe": timeframe,
        "enabled": bool(raw.get("enabled", True)),
        "strictValidation": bool(raw.get("strictValidation", True)),
        "allowLiveDeployment": bool(raw.get("allowLiveDeployment", False)),
        "modelUpdatedAt": raw.get("modelUpdatedAt") if isinstance(raw.get("modelUpdatedAt"), str) else None,
        "snapshot": snapshot if isinstance(snapshot, dict) else {},
        "cycles": cycles,
        "updatedAt": updated_at,
    }

def _get_self_learning_v5_state(user_id: int, account_id: str, symbol: str, timeframe: str) -> tuple[dict | None, str | None]:
    row = fetch_one(
        """
        SELECT state, updated_at
        FROM self_learning_v5_states
        WHERE user_id = %s AND account_id = %s AND symbol = %s AND timeframe = %s
        """,
        (user_id, account_id, symbol.upper(), timeframe.lower()),
    )
    if not row:
        return None, None
    state = row.get("state") if isinstance(row.get("state"), dict) else {}
    normalized = _normalize_self_learning_v5_state(
        {
            **state,
            "accountId": account_id,
            "symbol": symbol.upper(),
            "timeframe": timeframe.lower(),
        }
    )
    updated_at = row.get("updated_at")
    return normalized, (updated_at.isoformat() if updated_at else None)

def _save_self_learning_v5_state(user_id: int, payload: dict) -> tuple[dict, str]:
    normalized = _normalize_self_learning_v5_state(payload)
    if not normalized:
        raise HTTPException(status_code=400, detail="invalid self-learning-v5 payload")
    execute(
        """
        INSERT INTO self_learning_v5_states (user_id, account_id, symbol, timeframe, state)
        VALUES (%s, %s, %s, %s, %s::jsonb)
        ON CONFLICT (user_id, account_id, symbol, timeframe)
        DO UPDATE SET state = EXCLUDED.state, updated_at = NOW()
        """,
        (
            user_id,
            normalized["accountId"],
            normalized["symbol"],
            normalized["timeframe"],
            json_dumps(normalized),
        ),
    )
    row = fetch_one(
        """
        SELECT updated_at
        FROM self_learning_v5_states
        WHERE user_id = %s AND account_id = %s AND symbol = %s AND timeframe = %s
        """,
        (
            user_id,
            normalized["accountId"],
            normalized["symbol"],
            normalized["timeframe"],
        ),
    )
    updated_at = row.get("updated_at").isoformat() if row and row.get("updated_at") else _now_utc().isoformat()
    normalized["updatedAt"] = updated_at
    return normalized, updated_at

def _list_self_learning_v5_scopes(user_id: int, account_id: str = "", symbol: str = "", timeframe: str = "", limit: int = 120) -> list[dict]:
    where_clauses = ["user_id = %s"]
    params: list[object] = [user_id]
    if account_id:
        where_clauses.append("account_id = %s")
        params.append(account_id)
    if symbol:
        where_clauses.append("symbol = %s")
        params.append(symbol.upper())
    if timeframe:
        where_clauses.append("timeframe = %s")
        params.append(timeframe.lower())
    params.append(max(1, min(500, int(limit))))
    rows = fetch_all(
        f"""
        SELECT account_id, symbol, timeframe, state, updated_at
        FROM self_learning_v5_states
        WHERE {' AND '.join(where_clauses)}
        ORDER BY updated_at DESC
        LIMIT %s
        """,
        tuple(params),
    )
    items: list[dict] = []
    for row in rows:
        state = row.get("state") if isinstance(row.get("state"), dict) else {}
        snapshot = state.get("snapshot") if isinstance(state.get("snapshot"), dict) else {}
        registry = snapshot.get("registry") if isinstance(snapshot.get("registry"), dict) else {}
        validation = snapshot.get("validation") if isinstance(snapshot.get("validation"), dict) else {}
        items.append(
            {
                "accountId": row.get("account_id"),
                "symbol": row.get("symbol"),
                "timeframe": row.get("timeframe"),
                "updatedAt": row.get("updated_at").isoformat() if row.get("updated_at") else None,
                "cycleCount": len(state.get("cycles") or []) if isinstance(state.get("cycles"), list) else 0,
                "registryCount": len(registry.get("entries") or []) if isinstance(registry.get("entries"), list) else 0,
                "enabled": bool(state.get("enabled", True)),
                "strictValidation": bool(state.get("strictValidation", True)),
                "liveBlocked": bool(validation.get("liveBlocked", True)),
            }
        )
    return items


SELF_LEARNING_V5_PROMOTION_REQUIRED_SHADOW_CYCLES = 3
SELF_LEARNING_V5_PROMOTION_REQUIRED_OBSERVATION_HOURS = 6.0
SELF_LEARNING_V5_MANUAL_PROMOTION_ALLOWED_BLOCKERS = {
    "live_handoff_disabled_by_policy",
    "shadow_drawdown_requires_more_observation",
    "shadow_overfit_gap_requires_more_observation",
}


def _default_self_learning_v5_observation(strategy_id: str | None = None) -> dict:
    return {
        "candidateStrategyId": strategy_id,
        "requiredShadowCycles": SELF_LEARNING_V5_PROMOTION_REQUIRED_SHADOW_CYCLES,
        "requiredObservationHours": SELF_LEARNING_V5_PROMOTION_REQUIRED_OBSERVATION_HOURS,
        "observedShadowCycles": 0,
        "observedObservationHours": 0.0,
        "eligibleForPromotion": False,
        "firstObservedAt": None,
        "lastObservedAt": None,
        "reasons": ["shadow_strategy_not_found"] if strategy_id else ["no_active_shadow_strategy"],
    }


def _compute_self_learning_v5_promotion_observation(state: dict | None, strategy_id: str | None = None) -> dict:
    if not isinstance(state, dict):
        return _default_self_learning_v5_observation(strategy_id)
    snapshot = state.get("snapshot") if isinstance(state.get("snapshot"), dict) else {}
    registry = snapshot.get("registry") if isinstance(snapshot.get("registry"), dict) else {}
    entries = registry.get("entries") if isinstance(registry.get("entries"), list) else []
    cycles = state.get("cycles") if isinstance(state.get("cycles"), list) else []
    shadow_id = str(strategy_id or registry.get("activeShadowStrategyId") or "").strip() or None
    observation = _default_self_learning_v5_observation(shadow_id)
    if not shadow_id:
        return observation

    entry = next((item for item in entries if isinstance(item, dict) and str(item.get("id") or "").strip() == shadow_id), None)
    matching_cycles = [
        item for item in cycles
        if isinstance(item, dict) and str(item.get("bestStrategyId") or "").strip() == shadow_id
    ]
    cycle_times = sorted(
        [
            parsed for parsed in (
                _parse_iso_utc(str(item.get("timestampIso") or "")) for item in matching_cycles
            )
            if parsed is not None
        ]
    )
    first_observed_at = cycle_times[0].isoformat() if cycle_times else None
    last_observed_at = cycle_times[-1].isoformat() if cycle_times else None
    observed_hours = 0.0
    if len(cycle_times) >= 2:
        observed_hours = max(0.0, (cycle_times[-1] - cycle_times[0]).total_seconds() / 3600.0)

    reasons: list[str] = []
    if not isinstance(entry, dict):
        reasons.append("shadow_strategy_not_found")
    else:
        validation = entry.get("validation") if isinstance(entry.get("validation"), dict) else {}
        live_blocked_reasons = validation.get("liveBlockedReasons") if isinstance(validation.get("liveBlockedReasons"), list) else []
        if not bool(validation.get("accepted", False)):
            reasons.append("strategy_not_accepted")
        if str(registry.get("activeShadowStrategyId") or "").strip() != shadow_id:
            reasons.append("strategy_not_active_shadow")
        status = str(entry.get("status") or "registry").strip()
        if status not in {"shadow", "live-blocked"}:
            reasons.append(f"strategy_status_{status}")
        for reason in live_blocked_reasons:
            normalized = str(reason or "").strip()
            if normalized and normalized not in SELF_LEARNING_V5_MANUAL_PROMOTION_ALLOWED_BLOCKERS:
                reasons.append(normalized)

    if len(matching_cycles) < SELF_LEARNING_V5_PROMOTION_REQUIRED_SHADOW_CYCLES:
        reasons.append(f"shadow_cycle_count_below_{SELF_LEARNING_V5_PROMOTION_REQUIRED_SHADOW_CYCLES}")
    if observed_hours < SELF_LEARNING_V5_PROMOTION_REQUIRED_OBSERVATION_HOURS:
        reasons.append(f"shadow_observation_hours_below_{int(SELF_LEARNING_V5_PROMOTION_REQUIRED_OBSERVATION_HOURS)}")

    return {
        "candidateStrategyId": shadow_id,
        "requiredShadowCycles": SELF_LEARNING_V5_PROMOTION_REQUIRED_SHADOW_CYCLES,
        "requiredObservationHours": SELF_LEARNING_V5_PROMOTION_REQUIRED_OBSERVATION_HOURS,
        "observedShadowCycles": len(matching_cycles),
        "observedObservationHours": round(observed_hours, 2),
        "eligibleForPromotion": len(reasons) == 0,
        "firstObservedAt": first_observed_at,
        "lastObservedAt": last_observed_at,
        "reasons": reasons,
    }


def _promote_self_learning_v5_state(user_id: int, payload: dict, promoted_by: str) -> tuple[dict, str, dict, dict]:
    scope = _normalize_self_learning_v5_scope(payload)
    if not scope:
        raise HTTPException(status_code=400, detail="invalid self-learning-v5 scope")
    account_id, symbol, timeframe = scope
    strategy_id = str(payload.get("strategyId") or payload.get("strategy_id") or "").strip()
    rationale = str(payload.get("rationale") or "manual_shadow_to_live").strip() or "manual_shadow_to_live"
    if not strategy_id:
        raise HTTPException(status_code=400, detail="strategyId is required")

    state, _updated_at = _get_self_learning_v5_state(user_id, account_id, symbol, timeframe)
    if not isinstance(state, dict):
        raise HTTPException(status_code=404, detail="self-learning-v5 state not found")

    observation = _compute_self_learning_v5_promotion_observation(state, strategy_id)
    if not bool(observation.get("eligibleForPromotion")):
        raise HTTPException(status_code=409, detail={"promotion_blocked": observation.get("reasons", []), "observation": observation})

    snapshot = state.get("snapshot") if isinstance(state.get("snapshot"), dict) else {}
    validation = snapshot.get("validation") if isinstance(snapshot.get("validation"), dict) else {}
    registry = snapshot.get("registry") if isinstance(snapshot.get("registry"), dict) else {}
    entries = registry.get("entries") if isinstance(registry.get("entries"), list) else []
    promotion_audit_trail = registry.get("promotionAuditTrail") if isinstance(registry.get("promotionAuditTrail"), list) else []
    target_entry = next((item for item in entries if isinstance(item, dict) and str(item.get("id") or "").strip() == strategy_id), None)
    if not isinstance(target_entry, dict):
        raise HTTPException(status_code=404, detail="self-learning-v5 strategy not found")

    from_status = str(target_entry.get("status") or "shadow").strip() or "shadow"
    promoted_at = _now_utc().isoformat()
    updated_entries: list[dict] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        cloned = dict(entry)
        validation_block = cloned.get("validation") if isinstance(cloned.get("validation"), dict) else {}
        if str(cloned.get("id") or "").strip() == strategy_id:
            cloned["status"] = "live"
            cloned["validation"] = {
                **validation_block,
                "liveEligible": True,
                "liveBlockedReasons": [],
            }
        elif str(cloned.get("status") or "").strip() == "live":
            cloned["status"] = "registry"
        elif str(cloned.get("status") or "").strip() == "live-blocked":
            cloned["status"] = "shadow"
        updated_entries.append(cloned)

    audit_payload = {
        "strategyId": strategy_id,
        "promotedAt": promoted_at,
        "promotedBy": promoted_by,
        "rationale": rationale,
        "fromStatus": from_status,
        "toStatus": "live",
        "observation": {
            "requiredShadowCycles": observation.get("requiredShadowCycles"),
            "requiredObservationHours": observation.get("requiredObservationHours"),
            "observedShadowCycles": observation.get("observedShadowCycles"),
            "observedObservationHours": observation.get("observedObservationHours"),
        },
    }
    next_state = {
        **state,
        "modelUpdatedAt": promoted_at,
        "snapshot": {
            **snapshot,
            "validation": {
                **validation,
                "liveBlocked": False,
                "liveBlockReasons": [],
            },
            "registry": {
                **registry,
                "activeShadowStrategyId": None,
                "activeLiveStrategyId": strategy_id,
                "observation": {
                    **observation,
                    "eligibleForPromotion": True,
                    "reasons": [],
                },
                "promotionAuditTrail": [audit_payload, *promotion_audit_trail][:24],
                "entries": updated_entries,
            },
        },
        "updatedAt": promoted_at,
    }
    saved_state, saved_updated_at = _save_self_learning_v5_state(user_id, next_state)
    append_audit(
        "self_learning_v5_promoted_live",
        {
            "user_id": user_id,
            "account_id": account_id,
            "symbol": symbol,
            "timeframe": timeframe,
            "strategy_id": strategy_id,
            "from_status": from_status,
            "to_status": "live",
            "observation": observation,
            "rationale": rationale,
            "approved_by": promoted_by,
        },
    )
    return saved_state, saved_updated_at, {
        **observation,
        "eligibleForPromotion": True,
        "reasons": [],
    }, audit_payload


def _activate_kill_switch(source: str, reason: str, payload: dict) -> dict:
    state = _kill_switch_state()
    if state.get("active"):
        return state
    state["active"] = True
    state["reason"] = reason
    state["activated_at"] = _now_utc().isoformat()
    _save_kill_switch_state(state)
    execute(
        "INSERT INTO kill_switch_events (source, reason, payload, active) VALUES (%s, %s, %s::jsonb, TRUE)",
        (source, reason, json_dumps(payload)),
    )
    append_audit("kill_switch_activated", {"source": source, "reason": reason, "payload": payload})
    return state


def _record_api_error(source: str, detail: str) -> None:
    state = _kill_switch_state()
    stats = state.setdefault("stats", {})
    stats["api_errors"] = int(stats.get("api_errors", 0)) + 1
    _save_kill_switch_state(state)
    if stats["api_errors"] >= _kill_switch_thresholds()["max_api_errors"]:
        _activate_kill_switch(source, "api_errors_threshold", {"detail": detail, "count": stats["api_errors"]})


def _record_slippage_event(slippage_bps: float, source: str) -> None:
    state = _kill_switch_state()
    stats = state.setdefault("stats", {})
    if slippage_bps >= _kill_switch_thresholds()["max_slippage_bps"]:
        stats["high_slippage_events"] = int(stats.get("high_slippage_events", 0)) + 1
        _save_kill_switch_state(state)
        _activate_kill_switch(source, "slippage_threshold", {"slippage_bps": slippage_bps})


def _recompute_drawdown_guard() -> None:
    row = fetch_one(
        """
        SELECT COALESCE(SUM(net_result_usd), 0) AS pnl_24h
        FROM decision_outcomes
        WHERE created_at >= NOW() - INTERVAL '24 hours'
        """
    ) or {"pnl_24h": 0.0}
    pnl_24h = float(row["pnl_24h"])
    drawdown = abs(min(0.0, pnl_24h))
    state = _kill_switch_state()
    stats = state.setdefault("stats", {})
    stats["drawdown_intraday_usd"] = drawdown
    _save_kill_switch_state(state)
    if drawdown >= _kill_switch_thresholds()["max_drawdown_intraday"]:
        _activate_kill_switch("outcome_engine", "drawdown_intraday_threshold", {"drawdown_intraday_usd": drawdown})


def _assert_kill_switch_allows_execution() -> None:
    state = _kill_switch_state()
    if state.get("active"):
        raise HTTPException(status_code=423, detail={"kill_switch": state})


def _to_float(value: object, default: float = 0.0) -> float:
    try:
        return float(value)
    except Exception:
        return default


def _clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def _timestamp_age_ms(value: object) -> int:
    if isinstance(value, datetime):
        parsed = value.astimezone(timezone.utc) if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return max(0, int((_now_utc() - parsed).total_seconds() * 1000))
    if isinstance(value, str) and value:
        normalized = value.replace("Z", "+00:00")
        try:
            parsed = datetime.fromisoformat(normalized)
        except ValueError:
            return 0
        parsed_utc = parsed.astimezone(timezone.utc) if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
        return max(0, int((_now_utc() - parsed_utc).total_seconds() * 1000))
    return 0


def _weighted_median_price(values: list[tuple[float, float]]) -> float:
    filtered = sorted(((price, max(weight, 0.000001)) for price, weight in values if price > 0), key=lambda item: item[0])
    if not filtered:
        return 0.0
    total_weight = sum(weight for _, weight in filtered)
    cumulative = 0.0
    for price, weight in filtered:
        cumulative += weight
        if cumulative >= total_weight / 2:
            return price
    return filtered[-1][0]


def _mid_from_quote_payload(quote: dict) -> float:
    bid = _to_float(quote.get("bid"), 0.0)
    ask = _to_float(quote.get("ask"), 0.0)
    if bid > 0 and ask > 0:
        return (bid + ask) / 2
    return _to_float(quote.get("last"), 0.0)


def _aggregate_depth_payload(book: object) -> tuple[float, float, int]:
    if not isinstance(book, dict):
        return 0.0, 0.0, 0
    bid_depth_usd = 0.0
    ask_depth_usd = 0.0
    bid_levels = 0
    bids = book.get("bids", [])
    asks = book.get("asks", [])
    if isinstance(bids, list):
        bid_levels = len(bids)
        for level in bids[:8]:
            if isinstance(level, list) and len(level) >= 2:
                bid_depth_usd += _to_float(level[0]) * _to_float(level[1])
    if isinstance(asks, list):
        for level in asks[:8]:
            if isinstance(level, list) and len(level) >= 2:
                ask_depth_usd += _to_float(level[0]) * _to_float(level[1])
    return bid_depth_usd, ask_depth_usd, bid_levels


def _build_v6_route_context(candidates: list[dict]) -> dict:
    price_weights = [(_to_float(candidate.get("last"), 0.0), max(_to_float(candidate.get("available_depth_usd"), 0.0), 1.0)) for candidate in candidates]
    fusion_price = _weighted_median_price(price_weights)
    best = candidates[0] if candidates else None
    backup = candidates[1] if len(candidates) > 1 else None
    best_bid = max((_to_float(candidate.get("best_bid"), 0.0) for candidate in candidates), default=0.0)
    asks = [_to_float(candidate.get("best_ask"), 0.0) for candidate in candidates if _to_float(candidate.get("best_ask"), 0.0) > 0]
    best_ask = min(asks) if asks else 0.0
    buy = next((candidate.get("venue") for candidate in candidates if _to_float(candidate.get("best_ask"), 0.0) == best_ask and best_ask > 0), "")
    sell = next((candidate.get("venue") for candidate in candidates if _to_float(candidate.get("best_bid"), 0.0) == best_bid and best_bid > 0), "")
    gross_spread = max(0.0, best_bid - best_ask) if best_bid > 0 and best_ask > 0 else 0.0
    fee_cost = (fusion_price or ((best_bid + best_ask) / 2 if best_bid > 0 and best_ask > 0 else 0.0)) * ((6.0 + 1.5) / 10000.0)
    net_spread = gross_spread - fee_cost
    mids = [price for price, _ in price_weights if price > 0]
    deviation_bps = ((max(mids) - min(mids)) / fusion_price * 10000) if len(mids) >= 2 and fusion_price > 0 else 0.0
    return {
        "fusion_price": fusion_price,
        "deviation_bps": deviation_bps,
        "arbitrage": {
            "opportunity": net_spread > 0,
            "spread": gross_spread,
            "net_spread": net_spread,
            "buy": buy,
            "sell": sell,
        },
        "best": best,
        "backup": backup,
    }


def _evaluate_chart_risk_rules(order_payload: dict) -> dict:
    if not isinstance(order_payload, dict):
        return {
            "guard_enabled": False,
            "risk_usd": 0.0,
            "reward_usd": 0.0,
            "max_loss_usd": 0.0,
            "target_gain_usd": 0.0,
            "target_rr": 0.0,
            "confirm_ack": False,
            "loss_exceeded": False,
            "target_miss": False,
        }

    order_intent = order_payload.get("order_intent") or {}
    if not isinstance(order_intent, dict):
        order_intent = {}
    bracket = order_intent.get("bracket") or {}
    if not isinstance(bracket, dict):
        bracket = {}
    risk_preview = order_intent.get("risk_preview") or {}
    if not isinstance(risk_preview, dict):
        risk_preview = {}

    guard_enabled = bool(risk_preview.get("guard_enabled"))
    risk_usd = max(0.0, _to_float(bracket.get("risk_usd"), _to_float(risk_preview.get("risk_usd"), 0.0)))
    reward_usd = max(0.0, _to_float(bracket.get("reward_usd"), _to_float(risk_preview.get("reward_usd"), 0.0)))
    max_loss_usd = max(0.0, _to_float(risk_preview.get("max_loss_usd"), 0.0))
    target_gain_usd = max(0.0, _to_float(risk_preview.get("target_gain_usd"), 0.0))
    target_rr = max(0.0, _to_float(risk_preview.get("target_rr"), 0.0))
    confirm_ack = bool(risk_preview.get("confirm_ack"))

    loss_exceeded = guard_enabled and max_loss_usd > 0 and risk_usd > max_loss_usd
    target_miss = guard_enabled and target_gain_usd > 0 and reward_usd < target_gain_usd

    return {
        "guard_enabled": guard_enabled,
        "risk_usd": risk_usd,
        "reward_usd": reward_usd,
        "max_loss_usd": max_loss_usd,
        "target_gain_usd": target_gain_usd,
        "target_rr": target_rr,
        "confirm_ack": confirm_ack,
        "loss_exceeded": loss_exceeded,
        "target_miss": target_miss,
    }


def _clamp01(value: float) -> float:
    return max(0.0, min(1.0, value))


def _normal_cdf(value: float) -> float:
    return 0.5 * (1.0 + math.erf(value / math.sqrt(2.0)))


def _two_proportion_p_value(success_a: int, total_a: int, success_b: int, total_b: int) -> float | None:
    if total_a <= 0 or total_b <= 0:
        return None
    p1 = success_a / total_a
    p2 = success_b / total_b
    pooled = (success_a + success_b) / (total_a + total_b)
    variance = pooled * (1.0 - pooled) * ((1.0 / total_a) + (1.0 / total_b))
    if variance <= 0:
        return None
    z = (p1 - p2) / math.sqrt(variance)
    return max(0.0, min(1.0, 2.0 * (1.0 - _normal_cdf(abs(z)))))


def _chat_confirmation_ttl_seconds() -> int:
    raw = os.getenv("CHAT_CONFIRM_TTL_SECONDS", "600")
    try:
        return max(60, min(3600, int(raw)))
    except ValueError:
        return 600


def _incident_unassigned_alert_minutes() -> int:
    raw = os.getenv("INCIDENT_UNASSIGNED_ALERT_MINUTES", "20")
    try:
        return max(1, min(24 * 60, int(raw)))
    except ValueError:
        return 20


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _requires_safe_confirmation(action_type: str) -> bool:
    return action_type in {"apply_threshold", "run_runbook", "open_incident_ticket"}


def _create_action_confirmation(action_type: str, action_payload: dict, username: str) -> dict:
    token = uuid4().hex
    token_hash = _hash_token(token)
    expires_at = _now_utc() + timedelta(seconds=_chat_confirmation_ttl_seconds())
    execute(
        """
        INSERT INTO chatbot_action_confirmations (token_hash, action_type, action_payload, requested_by, status, expires_at)
        VALUES (%s, %s, %s::jsonb, %s, 'pending', %s)
        """,
        (token_hash, action_type, json_dumps(action_payload), username, expires_at),
    )
    return {
        "token": token,
        "action_type": action_type,
        "expires_at": expires_at.isoformat(),
        "summary": f"Confirmer action sensible: {action_type}",
    }


def _consume_action_confirmation(token: str, username: str) -> dict | None:
    row = fetch_one(
        """
        SELECT id, action_type, action_payload, requested_by, status, expires_at
        FROM chatbot_action_confirmations
        WHERE token_hash = %s
        """,
        (_hash_token(token),),
    )
    if not row:
        return None
    if str(row.get("requested_by", "")) != username:
        return None
    if str(row.get("status", "")) != "pending":
        return None
    expires_at = row.get("expires_at")
    if not expires_at or expires_at <= _now_utc():
        execute("UPDATE chatbot_action_confirmations SET status = 'expired' WHERE id = %s", (row["id"],))
        return None

    execute(
        "UPDATE chatbot_action_confirmations SET status = 'confirmed', confirmed_at = NOW() WHERE id = %s",
        (row["id"],),
    )
    payload = row.get("action_payload") or {}
    if not isinstance(payload, dict):
        payload = {}
    return {
        "id": row["id"],
        "action_type": str(row.get("action_type", "")),
        "action_payload": payload,
    }


def _mark_action_confirmation_executed(confirmation_id: int) -> None:
    execute(
        "UPDATE chatbot_action_confirmations SET status = 'executed', executed_at = NOW() WHERE id = %s",
        (confirmation_id,),
    )


async def _execute_chat_action(action: dict, auth: AuthContext) -> dict:
    action_type = str(action.get("type", "")).strip().lower()
    if action_type == "apply_threshold":
        if auth.role not in {"operator", "admin"}:
            raise HTTPException(status_code=403, detail="Operator role required")
        result = await upsert_strategy_drift_threshold(
            {
                "regime": action.get("regime", "unknown"),
                "min_samples": action.get("min_samples", 20),
                "min_win_rate": action.get("min_win_rate", 0.48),
                "max_drawdown_usd": action.get("max_drawdown_usd", 800.0),
                "max_avg_loss_usd": action.get("max_avg_loss_usd", 120.0),
            },
            auth,
        )
        return {
            "status": "ok",
            "reply": f"Seuils regime {result['item']['regime']} appliques.",
            "action_result": result,
            "actions": ["open_live_readiness"],
        }

    if action_type == "open_incident_ticket":
        ticket_key = f"INC-{uuid4().hex[:10].upper()}"
        title = str(action.get("title") or "Incident operationnel")
        severity = str(action.get("severity") or "medium").lower()
        execute(
            """
            INSERT INTO incident_tickets (ticket_key, severity, title, status, source, payload, created_by)
            VALUES (%s, %s, %s, 'open', 'ops-chatbot', %s::jsonb, %s)
            """,
            (ticket_key, severity, title, json_dumps(action.get("payload", {})), auth.username),
        )
        append_audit("incident_ticket_opened", {"ticket_key": ticket_key, "by": auth.username, "severity": severity})
        return {
            "status": "ok",
            "reply": f"Ticket incident ouvert: {ticket_key}",
            "action_result": {"ticket_key": ticket_key, "severity": severity, "title": title},
            "actions": ["open_incident_board"],
        }

    if action_type == "run_runbook":
        runbook = str(action.get("name") or "stabilize_trading").strip().lower()
        if runbook == "stabilize_trading":
            _recompute_drawdown_guard()
            _recompute_strategy_drift_state()
            snapshot = await _compute_connectors_snapshot()
            return {
                "status": "ok",
                "reply": "Runbook stabilize_trading execute: drawdown/derive recomputes et snapshot connecteurs rafraichi.",
                "action_result": {"runbook": runbook, "snapshot": snapshot},
                "actions": ["open_live_readiness", "review_suspended_strategies"],
            }
        return {
            "status": "ok",
            "reply": f"Runbook inconnu: {runbook}. Disponibles: stabilize_trading.",
            "actions": ["open_help"],
        }

    return {
        "status": "ok",
        "reply": f"Action inconnue: {action_type}",
        "actions": ["open_help"],
    }


def _upsert_default_regime_thresholds() -> None:
    defaults = [
        ("trend", 25, 0.52, 1000.0, 140.0),
        ("mean_reversion", 25, 0.50, 850.0, 120.0),
        ("range", 20, 0.49, 700.0, 110.0),
        ("volatile", 30, 0.54, 1200.0, 180.0),
        ("neutral", 20, 0.48, 800.0, 120.0),
        ("unknown", 20, 0.48, 800.0, 120.0),
    ]
    for regime, min_samples, min_win_rate, max_drawdown, max_avg_loss in defaults:
        execute(
            """
            INSERT INTO strategy_regime_thresholds (regime, min_samples, min_win_rate, max_drawdown_usd, max_avg_loss_usd)
            VALUES (%s, %s, %s, %s, %s)
            ON CONFLICT (regime) DO NOTHING
            """,
            (regime, min_samples, min_win_rate, max_drawdown, max_avg_loss),
        )


def _recompute_strategy_drift_state(strategy_id: str | None = None, regime: str | None = None) -> None:
    window = _drift_window_hours()
    if strategy_id:
        rows = fetch_all(
            """
            SELECT strategy_id, COALESCE(regime, 'unknown') AS regime,
                   COUNT(*) AS sample_count,
                   AVG(CASE WHEN COALESCE(net_result_usd, 0) > 0 THEN 1 ELSE 0 END) AS win_rate,
                   AVG(COALESCE(net_result_usd, 0)) AS avg_net_result_usd,
                   ABS(MIN(COALESCE(net_result_usd, 0))) AS drawdown_usd
            FROM decision_outcomes
            WHERE created_at >= NOW() - (%s * INTERVAL '1 hour')
              AND strategy_id = %s
              AND (%s::text IS NULL OR COALESCE(regime, 'unknown') = %s)
            GROUP BY strategy_id, COALESCE(regime, 'unknown')
            """,
            (window, strategy_id, regime, regime),
        )
    else:
        rows = fetch_all(
            """
            SELECT strategy_id, COALESCE(regime, 'unknown') AS regime,
                   COUNT(*) AS sample_count,
                   AVG(CASE WHEN COALESCE(net_result_usd, 0) > 0 THEN 1 ELSE 0 END) AS win_rate,
                   AVG(COALESCE(net_result_usd, 0)) AS avg_net_result_usd,
                   ABS(MIN(COALESCE(net_result_usd, 0))) AS drawdown_usd
            FROM decision_outcomes
            WHERE created_at >= NOW() - (%s * INTERVAL '1 hour')
              AND strategy_id IS NOT NULL
            GROUP BY strategy_id, COALESCE(regime, 'unknown')
            """,
            (window,),
        )

    for row in rows:
        sid = str(row.get("strategy_id") or "")
        reg = str(row.get("regime") or "unknown")
        sample_count = int(row.get("sample_count") or 0)
        win_rate = _to_float(row.get("win_rate"), 0.0)
        avg_loss = _to_float(row.get("avg_net_result_usd"), 0.0)
        drawdown = _to_float(row.get("drawdown_usd"), 0.0)
        thresholds = fetch_one(
            "SELECT min_samples, min_win_rate, max_drawdown_usd, max_avg_loss_usd FROM strategy_regime_thresholds WHERE regime = %s",
            (reg,),
        ) or fetch_one(
            "SELECT min_samples, min_win_rate, max_drawdown_usd, max_avg_loss_usd FROM strategy_regime_thresholds WHERE regime = 'unknown'"
        ) or {
            "min_samples": 20,
            "min_win_rate": 0.48,
            "max_drawdown_usd": 800.0,
            "max_avg_loss_usd": 120.0,
        }

        drift_reasons: list[str] = []
        if sample_count >= int(thresholds["min_samples"]):
            if win_rate < _to_float(thresholds["min_win_rate"], 0.48):
                drift_reasons.append("win_rate")
            if drawdown > _to_float(thresholds["max_drawdown_usd"], 800.0):
                drift_reasons.append("drawdown")
            if avg_loss < -abs(_to_float(thresholds["max_avg_loss_usd"], 120.0)):
                drift_reasons.append("avg_loss")

        drift_detected = len(drift_reasons) > 0
        auto_suspended = False
        auto_resumed = False
        cooldown_until: datetime | None = None
        if drift_detected and sid:
            current = fetch_one("SELECT status FROM strategies WHERE strategy_id = %s", (sid,))
            cooldown_until = _now_utc() + timedelta(hours=_auto_resume_cooldown_hours())
            if current and str(current.get("status", "")).lower() != "suspended_drift":
                execute(
                    "UPDATE strategies SET status = 'suspended_drift', updated_at = NOW() WHERE strategy_id = %s",
                    (sid,),
                )
                auto_suspended = True
                append_audit(
                    "strategy_auto_suspended_drift",
                    {
                        "strategy_id": sid,
                        "regime": reg,
                        "reasons": drift_reasons,
                        "window_hours": window,
                    },
                )
        elif sid and _auto_resume_enabled():
            current = fetch_one("SELECT status FROM strategies WHERE strategy_id = %s", (sid,))
            prior_state = fetch_one(
                "SELECT cooldown_until FROM strategy_health_state WHERE strategy_id = %s AND regime = %s AND window_hours = %s",
                (sid, reg, window),
            )
            prior_cooldown = prior_state.get("cooldown_until") if prior_state else None
            cooldown_until = prior_cooldown
            now = _now_utc()
            if current and str(current.get("status", "")).lower() == "suspended_drift" and prior_cooldown and now >= prior_cooldown:
                execute(
                    "UPDATE strategies SET status = 'active', updated_at = NOW() WHERE strategy_id = %s",
                    (sid,),
                )
                auto_resumed = True
                append_audit(
                    "strategy_auto_resumed_after_cooldown",
                    {
                        "strategy_id": sid,
                        "regime": reg,
                        "cooldown_until": prior_cooldown.isoformat(),
                        "window_hours": window,
                    },
                )

        execute(
            """
            INSERT INTO strategy_health_state (
                strategy_id, regime, window_hours, sample_count, win_rate,
                avg_net_result_usd, drawdown_usd, drift_detected, auto_suspended,
                auto_resumed, cooldown_until, reason, updated_at
            )
            VALUES (%s, %s, %s, %s, %s,
                    %s, %s, %s, %s, %s, %s, %s, NOW())
            ON CONFLICT (strategy_id, regime, window_hours) DO UPDATE SET
                sample_count = EXCLUDED.sample_count,
                win_rate = EXCLUDED.win_rate,
                avg_net_result_usd = EXCLUDED.avg_net_result_usd,
                drawdown_usd = EXCLUDED.drawdown_usd,
                drift_detected = EXCLUDED.drift_detected,
                auto_suspended = EXCLUDED.auto_suspended,
                auto_resumed = EXCLUDED.auto_resumed,
                cooldown_until = EXCLUDED.cooldown_until,
                reason = EXCLUDED.reason,
                updated_at = NOW()
            """,
            (
                sid,
                reg,
                window,
                sample_count,
                win_rate,
                avg_loss,
                drawdown,
                drift_detected,
                auto_suspended,
                auto_resumed,
                cooldown_until,
                ",".join(drift_reasons),
            ),
        )


def _pick_memory_arm(payload: dict) -> str:
    forced = str(payload.get("memory_ab_arm", "")).strip().lower()
    if forced in {"memory_on", "memory_off"}:
        return forced
    key = str(payload.get("decision_id") or payload.get("strategy_id") or "") + "|" + str(payload.get("symbol") or "")
    if not key:
        return "memory_on" if random.random() >= 0.5 else "memory_off"
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()
    return "memory_on" if int(digest[:8], 16) % 2 == 0 else "memory_off"


def _infer_memory_context(payload: dict) -> dict:
    instrument = str(payload.get("symbol") or payload.get("instrument") or "").strip()
    symbol = instrument.upper() if instrument else None
    regime = str(payload.get("regime") or payload.get("market_regime") or "").strip() or None
    strategy_id = str(payload.get("strategy_id") or "").strip() or None
    timeframe = str(payload.get("timeframe") or "").strip() or None

    features = payload.get("market_features") if isinstance(payload.get("market_features"), dict) else {}
    query_parts = [
        f"symbol={symbol or 'n/a'}",
        f"regime={regime or 'n/a'}",
        f"strategy={strategy_id or 'n/a'}",
        f"timeframe={timeframe or 'n/a'}",
    ]
    if features:
        query_parts.append(f"features={features}")

    return {
        "query": " | ".join(query_parts),
        "strategy_id": strategy_id,
        "symbol": symbol,
        "regime": regime,
        "timeframe": timeframe,
        "query_market_features": features,
        "top_k": int(payload.get("memory_top_k", 5) or 5),
        "max_age_hours": int(payload.get("memory_max_age_hours", 24 * 14) or 24 * 14),
        "compatible_strategies": payload.get("compatible_strategies", []),
    }


async def _retrieve_memory_for_payload(payload: dict) -> dict:
    body = _infer_memory_context(payload)
    async with httpx.AsyncClient(timeout=20.0) as client:
        response = await client.post(f"{EMBEDDINGS_SERVICE_URL}/v1/retrieve", json=body)
        if response.status_code >= 400:
            _record_api_error("embeddings-service", "memory_retrieve_for_decision_failed")
            return {
                "status": "degraded",
                "results": [],
                "historical_alignment_score": _to_float(payload.get("historical_match"), 0.5),
                "risk_flags": {"high_drawdown": False},
                "formatted_memory": [],
                "insights": ["Memory retrieval unavailable; using base score only."],
            }
        return response.json()


def _inject_memory_into_prompt(prompt: str, memory: dict) -> str:
    formatted = memory.get("formatted_memory", [])
    insights = memory.get("insights", [])
    if not formatted and not insights:
        return prompt
    blocks = ["", "Similar past cases:"]
    for line in formatted[:3]:
        blocks.append(f"- {line}")
    blocks.append("")
    blocks.append("Insights:")
    for insight in insights[:4]:
        blocks.append(f"- {insight}")
    return (prompt or "") + "\n" + "\n".join(blocks)


def _apply_memory_aware_score(payload: dict, memory: dict) -> tuple[dict, dict]:
    adjusted = dict(payload)
    base_hist = _to_float(payload.get("historical_match"), 0.5)
    align = _to_float(memory.get("historical_alignment_score"), base_hist)
    boost = 0.1 if align > 0.65 else 0.0
    penalty = -0.15 if bool((memory.get("risk_flags") or {}).get("high_drawdown")) else 0.0
    final_hist = _clamp01((base_hist * 0.5) + (align * 0.5) + boost + penalty)
    adjusted["historical_match"] = final_hist
    return adjusted, {
        "base_historical_match": round(base_hist, 6),
        "alignment": round(align, 6),
        "boost": boost,
        "penalty": penalty,
        "final_historical_match": round(final_hist, 6),
    }


def _resolve_auth(
    authorization: str | None,
    allowed_roles: set[str],
    require_password_fresh: bool = True,
) -> AuthContext:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    token = authorization.removeprefix("Bearer ").strip()
    auth = auth_context_from_token(token)
    if not auth or not auth.session_id:
        raise HTTPException(status_code=401, detail="Invalid token")

    user = fetch_one(
        "SELECT id, username, role, is_active, password_must_change FROM users WHERE id = %s",
        (auth.user_id,),
    )
    if not user or not user["is_active"]:
        raise HTTPException(status_code=401, detail="Inactive or missing user")

    session = fetch_one(
        "SELECT session_id, expires_at, revoked_at FROM sessions WHERE session_id = %s AND user_id = %s",
        (auth.session_id, auth.user_id),
    )
    if not session:
        raise HTTPException(status_code=401, detail="Session not found")
    if session["revoked_at"] is not None:
        raise HTTPException(status_code=401, detail="Session revoked")
    if session["expires_at"] <= _now_utc():
        raise HTTPException(status_code=401, detail="Session expired")

    if user["role"] not in allowed_roles:
        raise HTTPException(status_code=403, detail="Insufficient role")
    if require_password_fresh and user["password_must_change"]:
        raise HTTPException(status_code=403, detail="Password rotation required")

    execute(
        "UPDATE sessions SET last_seen_at = NOW() WHERE session_id = %s",
        (auth.session_id,),
    )
    return AuthContext(
        user_id=user["id"],
        principal=user["username"],
        username=user["username"],
        role=user["role"],
        session_id=auth.session_id,
    )


def viewer_auth(authorization: str | None = Header(default=None)) -> AuthContext:
    """Internal-only read access: viewer · operator · admin."""
    return _resolve_auth(authorization, {"viewer", "operator", "admin"})


def operator_auth(authorization: str | None = Header(default=None)) -> AuthContext:
    """Internal write access: operator · admin."""
    return _resolve_auth(authorization, {"operator", "admin"})


def admin_auth(authorization: str | None = Header(default=None)) -> AuthContext:
    """Admin-only access."""
    return _resolve_auth(authorization, {"admin"})


# ── Client / external roles ────────────────────────────────────────────────
_CLIENT_ROLES: set[str] = {"client", "trader", "investor", "premium", "pro"}
_INTERNAL_ROLES: set[str] = {"viewer", "operator", "admin"}
_ALL_ROLES: set[str] = _INTERNAL_ROLES | _CLIENT_ROLES
_PHASE1_INTERNAL_CLIENT_ID = "txt-internal"
_PHASE1_INTERNAL_PORTFOLIO_ID = "pf-internal-main"


def client_auth(authorization: str | None = Header(default=None)) -> AuthContext:
    """External client access: client · trader · investor · premium · pro."""
    return _resolve_auth(authorization, _CLIENT_ROLES)


def any_read_auth(authorization: str | None = Header(default=None)) -> AuthContext:
    """Any authenticated user (internal or client) — for market-data endpoints."""
    return _resolve_auth(authorization, _ALL_ROLES)


def relaxed_auth(authorization: str | None = Header(default=None)) -> AuthContext:
    """Any authenticated user, no password-freshness check. Used for auth/me, logout, etc."""
    return _resolve_auth(authorization, _ALL_ROLES, require_password_fresh=False)


def connector_manage_auth(authorization: str | None = Header(default=None)) -> AuthContext:
    """Connector management access for admins, operators, and external client roles."""
    return _resolve_auth(authorization, {"admin", "operator", "client", "trader", "investor", "premium", "pro"})


def _normalize_db_row(row: dict | None) -> dict | None:
    if row is None:
        return None
    return {key: _json_safe_value(value) for key, value in row.items()}


def _normalize_db_rows(rows: list[dict]) -> list[dict]:
    return [_normalize_db_row(row) or {} for row in rows]


def _is_internal_auth(auth: AuthContext) -> bool:
    return auth.role in _INTERNAL_ROLES


def _visible_client_ids(auth: AuthContext) -> list[str] | None:
    if _is_internal_auth(auth):
        return None
    rows = fetch_all(
        """
        SELECT client_id
        FROM user_client_memberships
        WHERE user_id = %s
        ORDER BY is_primary DESC, created_at ASC
        """,
        (auth.user_id,),
    )
    return [str(row["client_id"]) for row in rows]


def _default_client_id_for_auth(auth: AuthContext) -> str | None:
    if _is_internal_auth(auth):
        return _PHASE1_INTERNAL_CLIENT_ID
    rows = fetch_all(
        """
        SELECT client_id
        FROM user_client_memberships
        WHERE user_id = %s
        ORDER BY is_primary DESC, created_at ASC
        LIMIT 1
        """,
        (auth.user_id,),
    )
    return str(rows[0]["client_id"]) if rows else None


def _resolve_client_id_for_auth(auth: AuthContext, requested_client_id: str = "") -> str:
    requested = requested_client_id.strip()
    if requested:
        _assert_client_visible(auth, requested)
        return requested
    default_client_id = _default_client_id_for_auth(auth)
    if not default_client_id:
        raise HTTPException(status_code=400, detail="No client_id is associated with the current user")
    return default_client_id


def _filter_connector_accounts_for_auth(accounts: list[dict], auth: AuthContext) -> list[dict]:
    if _is_internal_auth(auth):
        return accounts
    visible_client_ids = set(_visible_client_ids(auth) or [])
    filtered: list[dict] = []
    for item in accounts:
        owner_user_id = int(item.get("owner_user_id", 0) or 0)
        item_client_id = str(item.get("client_id") or "").strip()
        if owner_user_id == auth.user_id or (item_client_id and item_client_id in visible_client_ids):
            filtered.append(item)
    return filtered


def _filter_mt5_accounts_for_auth(accounts: list[dict], auth: AuthContext) -> list[dict]:
    if _is_internal_auth(auth):
        return accounts
    visible_client_ids = set(_visible_client_ids(auth) or [])
    filtered: list[dict] = []
    for item in accounts:
        metadata = item.get("metadata") if isinstance(item.get("metadata"), dict) else {}
        owner_user_id = int(metadata.get("owner_user_id", 0) or 0)
        item_client_id = str(metadata.get("client_id") or "").strip()
        if owner_user_id == auth.user_id or (item_client_id and item_client_id in visible_client_ids):
            filtered.append(item)
    return filtered


def _symbol_bucket(symbol: str) -> str:
    upper = str(symbol or "").upper()
    if not upper:
        return "other"
    if upper.startswith(("BTC", "ETH", "SOL", "XRP", "ADA", "DOGE")) or upper.endswith(("USDT", "USDC")):
        return "crypto"
    if any(token in upper for token in ("XAU", "XAG", "GOLD", "SILVER", "BRENT", "WTI", "OIL", "NGAS")):
        return "commodity"
    if len(upper) == 6 and upper.isalpha():
        return "fx"
    if any(token in upper for token in ("US30", "NAS", "SPX", "DAX", "CAC", "NIKKEI", "FTSE", "DJ")):
        return "index"
    return "other"


def _pairwise_symbol_correlation(symbol_x: str, symbol_y: str) -> float:
    if symbol_x == symbol_y:
        return 1.0
    bucket_x = _symbol_bucket(symbol_x)
    bucket_y = _symbol_bucket(symbol_y)
    if bucket_x == bucket_y:
        return 0.7
    if {bucket_x, bucket_y} == {"fx", "commodity"}:
        return 0.35
    if {bucket_x, bucket_y} == {"crypto", "index"}:
        return 0.3
    if "other" in {bucket_x, bucket_y}:
        return 0.15
    return 0.2


def _sample_stddev(values: list[float]) -> float:
    if len(values) < 2:
        return 0.0
    mean_value = sum(values) / len(values)
    variance = sum((value - mean_value) ** 2 for value in values) / (len(values) - 1)
    return math.sqrt(max(variance, 0.0))


def _pearson_correlation(left: list[float], right: list[float]) -> float | None:
    if len(left) != len(right) or len(left) < 3:
        return None
    mean_left = sum(left) / len(left)
    mean_right = sum(right) / len(right)
    cov = sum((left[index] - mean_left) * (right[index] - mean_right) for index in range(len(left)))
    std_left = _sample_stddev(left)
    std_right = _sample_stddev(right)
    if std_left <= 0 or std_right <= 0:
        return None
    return cov / ((len(left) - 1) * std_left * std_right)


def _candidate_market_data_series(symbol: str) -> list[tuple[str, str]]:
    normalized = _normalize_symbol(symbol)
    candidates: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for venue in ("goldapi-cfd", "twelvedata-cfd", "metalsapi-cfd", "frankfurter-cfd", "yahoo-cfd"):
        pair = (venue, normalized)
        if pair not in seen:
            candidates.append(pair)
            seen.add(pair)
    for venue in ("binance-public", "coinbase-public", "okx-public"):
        instrument = _market_data_symbol(venue, normalized)
        pair = (venue, instrument)
        if pair not in seen:
            candidates.append(pair)
            seen.add(pair)
        raw_pair = (venue, normalized)
        if raw_pair not in seen:
            candidates.append(raw_pair)
            seen.add(raw_pair)
    return candidates


def _load_symbol_return_history(symbol: str, timeframe: str = "1h", limit: int = 240) -> dict[str, Any] | None:
    timeframes = [timeframe]
    if timeframe != "1d":
        timeframes.append("1d")
    minimum_observations = {"1h": 24, "1d": 20}
    limit_by_timeframe = {"1h": limit, "1d": max(limit, 365)}
    for venue, instrument in _candidate_market_data_series(symbol):
        for requested_timeframe in timeframes:
            rows = _normalize_db_rows(
                fetch_all(
                    """
                    SELECT bucket_start, close
                    FROM market_ohlcv
                    WHERE venue = %s AND instrument = %s AND timeframe = %s
                    ORDER BY bucket_start DESC
                    LIMIT %s
                    """,
                    (venue, instrument, requested_timeframe, limit_by_timeframe.get(requested_timeframe, limit)),
                )
            )
            if len(rows) < minimum_observations.get(requested_timeframe, 24):
                continue
            ordered_rows = list(reversed(rows))
            closes: list[tuple[str, float]] = []
            for row in ordered_rows:
                bucket_start = str(row.get("bucket_start") or "")
                close_price = _to_float(row.get("close"), 0.0)
                if not bucket_start or close_price <= 0:
                    continue
                closes.append((bucket_start, close_price))
            if len(closes) < minimum_observations.get(requested_timeframe, 24):
                continue
            returns_by_bucket: dict[str, float] = {}
            for index in range(1, len(closes)):
                prev_close = closes[index - 1][1]
                next_close = closes[index][1]
                if prev_close <= 0 or next_close <= 0:
                    continue
                returns_by_bucket[closes[index][0]] = (next_close / prev_close) - 1.0
            if len(returns_by_bucket) < minimum_observations.get(requested_timeframe, 20) - 1:
                continue
            candidate = {
                "symbol": str(symbol or "").upper(),
                "venue": venue,
                "instrument": instrument,
                "timeframe": requested_timeframe,
                "observations": len(closes),
                "return_points": len(returns_by_bucket),
                "sigma_1d": _sample_stddev(list(returns_by_bucket.values())),
                "returns_by_bucket": returns_by_bucket,
            }
            return candidate
    return None


def _portfolio_symbol_histories(symbol_exposures: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    histories: dict[str, dict[str, Any]] = {}
    for item in symbol_exposures:
        if not isinstance(item, dict):
            continue
        symbol = str(item.get("symbol") or "UNKNOWN").upper()
        history = _load_symbol_return_history(symbol)
        if history:
            histories[symbol] = history
    return histories


def _portfolio_correlation_pairs(symbol_exposures: list[dict[str, Any]], histories: dict[str, dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    history_lookup = histories or {}
    ordered = sorted(
        [item for item in symbol_exposures if isinstance(item, dict)],
        key=lambda row: abs(_to_float(row.get("net_notional_usd"), 0.0)),
        reverse=True,
    )
    pairs: list[dict[str, Any]] = []
    for index, left in enumerate(ordered):
        symbol_x = str(left.get("symbol") or "UNKNOWN").upper()
        for right in ordered[index + 1 :]:
            symbol_y = str(right.get("symbol") or "UNKNOWN").upper()
            left_history = history_lookup.get(symbol_x)
            right_history = history_lookup.get(symbol_y)
            correlation = _pairwise_symbol_correlation(symbol_x, symbol_y)
            source = "proxy-buckets"
            observations = 0
            if left_history and right_history:
                left_returns = left_history.get("returns_by_bucket") if isinstance(left_history.get("returns_by_bucket"), dict) else {}
                right_returns = right_history.get("returns_by_bucket") if isinstance(right_history.get("returns_by_bucket"), dict) else {}
                common_keys = sorted(set(left_returns.keys()) & set(right_returns.keys()))
                observations = len(common_keys)
                if observations >= 20:
                    empirical = _pearson_correlation([_to_float(left_returns[key], 0.0) for key in common_keys], [_to_float(right_returns[key], 0.0) for key in common_keys])
                    if empirical is not None:
                        correlation = max(-0.95, min(0.95, empirical))
                        source = "market_ohlcv"
            pairs.append(
                {
                    "symbol_x": symbol_x,
                    "symbol_y": symbol_y,
                    "correlation_30d": correlation,
                    "source": source,
                    "observations": observations,
                }
            )
    return pairs


def _portfolio_parametric_var(
    symbol_exposures: list[dict[str, Any]],
    correlation_pairs: list[dict[str, Any]],
    histories: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    if not symbol_exposures:
        return {
            "model": "covariance-history-v1",
            "sigma_1d": 0.0,
            "z_95": 1.65,
            "z_99": 2.33,
            "assumptions": {"base_volatility": {}, "correlation_source": "market_ohlcv_with_proxy_fallback"},
        }
    history_lookup = histories or {}
    pair_lookup = {
        tuple(sorted((str(item.get("symbol_x") or "UNKNOWN"), str(item.get("symbol_y") or "UNKNOWN")))): _to_float(item.get("correlation_30d"), 0.0)
        for item in correlation_pairs
        if isinstance(item, dict)
    }
    base_vol_by_bucket = {
        "fx": 0.006,
        "commodity": 0.012,
        "index": 0.01,
        "crypto": 0.04,
        "other": 0.015,
    }
    variance = 0.0
    historical_vol_symbols = 0
    for index, left in enumerate(symbol_exposures):
        symbol_x = str(left.get("symbol") or "UNKNOWN").upper()
        exposure_x = abs(_to_float(left.get("net_notional_usd"), _to_float(left.get("gross_notional_usd"), 0.0)))
        left_history = history_lookup.get(symbol_x)
        sigma_x = _to_float(left_history.get("sigma_1d"), 0.0) if left_history else 0.0
        if sigma_x > 0:
            historical_vol_symbols += 1
        else:
            sigma_x = base_vol_by_bucket.get(_symbol_bucket(symbol_x), 0.015)
        variance += (exposure_x * sigma_x) ** 2
        for right in symbol_exposures[index + 1 :]:
            symbol_y = str(right.get("symbol") or "UNKNOWN").upper()
            exposure_y = abs(_to_float(right.get("net_notional_usd"), _to_float(right.get("gross_notional_usd"), 0.0)))
            right_history = history_lookup.get(symbol_y)
            sigma_y = _to_float(right_history.get("sigma_1d"), 0.0) if right_history else 0.0
            if sigma_y <= 0:
                sigma_y = base_vol_by_bucket.get(_symbol_bucket(symbol_y), 0.015)
            rho = pair_lookup.get(tuple(sorted((symbol_x, symbol_y))), _pairwise_symbol_correlation(symbol_x, symbol_y))
            variance += 2.0 * exposure_x * sigma_x * exposure_y * sigma_y * rho
    return {
        "model": "covariance-history-v1",
        "sigma_1d": math.sqrt(max(variance, 0.0)),
        "z_95": 1.65,
        "z_99": 2.33,
        "assumptions": {
            "base_volatility": base_vol_by_bucket,
            "correlation_source": "market_ohlcv_with_proxy_fallback",
            "timeframe": "1h",
            "lookback_limit": 240,
            "historical_vol_symbols": historical_vol_symbols,
            "historical_symbols": sorted(history_lookup.keys()),
        },
    }


def _assert_client_visible(auth: AuthContext, client_id: str) -> dict:
    client = fetch_one(
        """
        SELECT client_id, legal_name, client_type, base_currency, status, kyc_status, metadata, created_at, updated_at
        FROM clients
        WHERE client_id = %s
        """,
        (client_id,),
    )
    if not client:
        raise HTTPException(status_code=404, detail="Client not found")
    if _is_internal_auth(auth):
        return client
    membership = fetch_one(
        """
        SELECT membership_role, is_primary, permissions, created_at
        FROM user_client_memberships
        WHERE user_id = %s AND client_id = %s
        ORDER BY is_primary DESC, created_at ASC
        LIMIT 1
        """,
        (auth.user_id, client_id),
    )
    if not membership:
        raise HTTPException(status_code=404, detail="Client not found")
    return client | {"membership_role": membership["membership_role"], "is_primary": membership["is_primary"], "permissions": membership["permissions"]}


def _assert_account_visible(auth: AuthContext, account_id: str) -> dict:
    normalized_account_id = _normalize_account_id(account_id)
    account = fetch_one(
        """
        SELECT
            LOWER(BTRIM(account_id)) AS account_id,
            client_id, account_type, venue, connector_type, mode, base_currency,
            status, LOWER(BTRIM(external_ref)) AS external_ref, display_name, metadata, created_at, updated_at,
            connector_broker, connector_server, connector_login, connector_status, connector_metadata
        FROM v_accounts_canonical
        WHERE LOWER(BTRIM(account_id)) = %s
        """,
        (normalized_account_id,),
    )
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")
    _assert_client_visible(auth, str(account["client_id"]))
    return account


def _assert_portfolio_visible(auth: AuthContext, portfolio_id: str) -> dict:
    portfolio = fetch_one(
        """
        SELECT portfolio_id, client_id, name, base_currency, mandate_type, risk_profile, benchmark_symbol, status, metadata, created_at, updated_at
        FROM portfolios
        WHERE portfolio_id = %s
        """,
        (portfolio_id,),
    )
    if not portfolio:
        raise HTTPException(status_code=404, detail="Portfolio not found")
    _assert_client_visible(auth, str(portfolio["client_id"]))
    return portfolio


def _bool_from_any(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"0", "false", "no", "off"}:
            return False
    return default


def _slugify_identifier(raw: str, fallback: str) -> str:
    cleaned: list[str] = []
    for character in raw.lower():
        if character.isalnum():
            cleaned.append(character)
        elif character in {"-", "_", ".", "/", " "}:
            cleaned.append("-")
    slug = "".join(cleaned).strip("-")
    while "--" in slug:
        slug = slug.replace("--", "-")
    return slug or fallback


def _mt5_account_business_context(account: dict[str, Any]) -> dict[str, Any]:
    metadata = account.get("metadata") if isinstance(account.get("metadata"), dict) else {}
    raw_client_id = str(metadata.get("client_id") or metadata.get("owner_client_id") or "").strip()
    raw_client_name = str(metadata.get("client_legal_name") or metadata.get("client_name") or metadata.get("client_label") or "").strip()
    if not raw_client_id and raw_client_name:
        raw_client_id = f"cl-{_slugify_identifier(raw_client_name, 'client')}"
    client_id = raw_client_id or _PHASE1_INTERNAL_CLIENT_ID
    client_type = str(metadata.get("client_type") or ("internal" if client_id == _PHASE1_INTERNAL_CLIENT_ID else "individual")).strip().lower()
    if client_type not in {"internal", "individual", "prop", "fund", "family_office"}:
        client_type = "internal" if client_id == _PHASE1_INTERNAL_CLIENT_ID else "individual"
    legal_name = raw_client_name or ("TXT Internal" if client_id == _PHASE1_INTERNAL_CLIENT_ID else f"Client {account['account_id']}")
    base_currency = str(metadata.get("base_currency") or metadata.get("currency") or "USD").upper()
    include_in_operational_risk = _bool_from_any(metadata.get("include_in_operational_risk"), default=str(account.get("mode", "paper")) == "live")
    include_in_client_portfolio = _bool_from_any(metadata.get("include_in_client_portfolio"), default=True)
    raw_portfolio_id = str(metadata.get("portfolio_id") or "").strip()
    raw_portfolio_name = str(metadata.get("portfolio_name") or "").strip()
    if raw_portfolio_id:
        portfolio_id = raw_portfolio_id
    elif client_id == _PHASE1_INTERNAL_CLIENT_ID:
        portfolio_id = _PHASE1_INTERNAL_PORTFOLIO_ID if include_in_operational_risk else "pf-internal-sandbox"
    else:
        portfolio_id = f"pf-{_slugify_identifier(client_id, 'client')}-main"
    if raw_portfolio_name:
        portfolio_name = raw_portfolio_name
    elif portfolio_id == _PHASE1_INTERNAL_PORTFOLIO_ID:
        portfolio_name = "TXT Internal Ops"
    elif portfolio_id == "pf-internal-sandbox":
        portfolio_name = "TXT Internal Sandbox"
    else:
        portfolio_name = f"{legal_name} Main"
    return {
        "client_id": client_id,
        "client_name": legal_name,
        "client_type": client_type,
        "base_currency": base_currency,
        "portfolio_id": portfolio_id,
        "portfolio_name": portfolio_name,
        "include_in_operational_risk": include_in_operational_risk,
        "include_in_client_portfolio": include_in_client_portfolio,
        "metadata": metadata,
    }


def _ensure_client_entity(context: dict[str, Any]) -> None:
    execute(
        """
        INSERT INTO clients (client_id, legal_name, client_type, base_currency, status, kyc_status, metadata)
        VALUES (%s, %s, %s, %s, 'active', %s, %s::jsonb)
        ON CONFLICT (client_id) DO UPDATE SET
            legal_name = EXCLUDED.legal_name,
            client_type = EXCLUDED.client_type,
            base_currency = EXCLUDED.base_currency,
            updated_at = NOW(),
            metadata = clients.metadata || EXCLUDED.metadata
        """,
        (
            context["client_id"],
            context["client_name"],
            context["client_type"],
            context["base_currency"],
            "not_required" if context["client_type"] == "internal" else "pending",
            json_dumps(
                {
                    "source": "mt5-sync",
                    "auto_managed": True,
                }
            ),
        ),
    )


def _ensure_portfolio_entity(context: dict[str, Any]) -> None:
    portfolio_id = context["portfolio_id"]
    if portfolio_id == _PHASE1_INTERNAL_PORTFOLIO_ID:
        metadata = {"scope": "internal-ops", "auto_managed": True, "operational_scope": "live-only"}
        mandate_type = "treasury"
        risk_profile = "balanced"
    elif context["client_id"] == _PHASE1_INTERNAL_CLIENT_ID:
        metadata = {"scope": "internal-sandbox", "auto_managed": True, "operational_scope": "paper-sandbox"}
        mandate_type = "simulation"
        risk_profile = "balanced"
    else:
        metadata = {"scope": "client-default", "auto_managed": True, "owner_client_id": context["client_id"]}
        mandate_type = "discretionary"
        risk_profile = "balanced"
    execute(
        """
        INSERT INTO portfolios (
            portfolio_id, client_id, name, base_currency, mandate_type, risk_profile, benchmark_symbol, status, metadata
        ) VALUES (%s, %s, %s, %s, %s, %s, NULL, 'active', %s::jsonb)
        ON CONFLICT (portfolio_id) DO UPDATE SET
            client_id = EXCLUDED.client_id,
            name = EXCLUDED.name,
            base_currency = EXCLUDED.base_currency,
            mandate_type = EXCLUDED.mandate_type,
            risk_profile = EXCLUDED.risk_profile,
            status = EXCLUDED.status,
            metadata = portfolios.metadata || EXCLUDED.metadata,
            updated_at = NOW()
        """,
        (
            portfolio_id,
            context["client_id"],
            context["portfolio_name"],
            context["base_currency"],
            mandate_type,
            risk_profile,
            json_dumps(metadata),
        ),
    )


def _sync_account_portfolio_links(account_id: str, context: dict[str, Any]) -> int:
    desired_portfolios: list[str] = []
    if context["include_in_client_portfolio"]:
        desired_portfolios.append(str(context["portfolio_id"]))
    if context["include_in_operational_risk"] and _PHASE1_INTERNAL_PORTFOLIO_ID not in desired_portfolios:
        desired_portfolios.append(_PHASE1_INTERNAL_PORTFOLIO_ID)

    managed_rows = fetch_all(
        """
        SELECT pa.portfolio_id
        FROM portfolio_accounts pa
        JOIN portfolios p ON p.portfolio_id = pa.portfolio_id
        WHERE pa.account_id = %s
          AND COALESCE((p.metadata->>'auto_managed')::boolean, FALSE) = TRUE
        """,
        (account_id,),
    )
    for row in managed_rows:
        existing_portfolio_id = str(row.get("portfolio_id") or "")
        if existing_portfolio_id and existing_portfolio_id not in desired_portfolios:
            execute("DELETE FROM portfolio_accounts WHERE portfolio_id = %s AND account_id = %s", (existing_portfolio_id, account_id))

    for portfolio_id in desired_portfolios:
        execute(
            """
            INSERT INTO portfolio_accounts (portfolio_id, account_id, allocation_weight, status)
            VALUES (%s, %s, 1.0, 'active')
            ON CONFLICT (portfolio_id, account_id) DO UPDATE SET status = EXCLUDED.status
            """,
            (portfolio_id, account_id),
        )
    return len(desired_portfolios)


def _sync_accounts_registry_from_mt5(account_id: str | None = None) -> int:
    params: tuple[Any, ...] = (account_id,) if account_id else ()
    where_sql = "WHERE account_id = %s" if account_id else ""
    rows = fetch_all(
        f"""
        SELECT account_id, broker, server, login, mode, status, metadata
        FROM mt5_accounts
        {where_sql}
        ORDER BY updated_at DESC, account_id ASC
        """,
        params,
    )
    processed = 0
    for row in rows:
        context = _mt5_account_business_context(row)
        _ensure_client_entity(context)
        _ensure_portfolio_entity(context)
        if context["include_in_operational_risk"]:
            _ensure_portfolio_entity(
                {
                    "portfolio_id": _PHASE1_INTERNAL_PORTFOLIO_ID,
                    "client_id": _PHASE1_INTERNAL_CLIENT_ID,
                    "portfolio_name": "TXT Internal Ops",
                    "base_currency": "USD",
                }
            )

        metadata = dict(context["metadata"])
        metadata["canonical_client_id"] = context["client_id"]
        metadata["canonical_portfolio_id"] = context["portfolio_id"]
        metadata["include_in_operational_risk"] = context["include_in_operational_risk"]
        metadata["include_in_client_portfolio"] = context["include_in_client_portfolio"]

        execute(
            """
            INSERT INTO accounts_registry (
                account_id, client_id, account_type, venue, connector_type, mode,
                base_currency, status, external_ref, display_name, metadata, updated_at
            ) VALUES (%s, %s, 'broker', %s, 'mt5', %s, %s, %s, %s, %s, %s::jsonb, NOW())
            ON CONFLICT (account_id) DO UPDATE SET
                client_id = EXCLUDED.client_id,
                venue = EXCLUDED.venue,
                connector_type = EXCLUDED.connector_type,
                mode = EXCLUDED.mode,
                base_currency = EXCLUDED.base_currency,
                status = EXCLUDED.status,
                external_ref = EXCLUDED.external_ref,
                display_name = EXCLUDED.display_name,
                metadata = EXCLUDED.metadata,
                updated_at = NOW()
            """,
            (
                row["account_id"],
                context["client_id"],
                str(row.get("broker") or "mt5"),
                str(row.get("mode") or "paper"),
                context["base_currency"],
                "active" if str(row.get("status") or "").strip().lower() in {"connected", "active", "ready"} else "pending",
                str(row.get("login") or "") or None,
                str(metadata.get("display_name") or "") or f"{str(row.get('broker') or 'mt5')} {str(row.get('login') or row['account_id'])}",
                json_dumps(metadata),
            ),
        )
        _sync_account_portfolio_links(str(row["account_id"]), context)
        processed += 1
    return processed


def _sync_internal_portfolio_accounts(account_id: str | None = None) -> int:
    return _sync_accounts_registry_from_mt5(account_id)


async def _fetch_mt5_normalized_state(account_id: str) -> dict | None:
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(f"{MT5_BRIDGE_URL}/v1/accounts/{account_id}/normalized-state")
    except Exception as exc:
        append_audit("mt5_account_state_sync_failed", {"account_id": account_id, "detail": str(exc)[:500]})
        return None

    if response.status_code == 404:
        return None
    if response.status_code >= 400:
        append_audit(
            "mt5_account_state_sync_failed",
            {"account_id": account_id, "status_code": response.status_code, "detail": response.text[:500]},
        )
        return None
    body = response.json()
    return body if isinstance(body, dict) else None


def _persist_mt5_account_state(account_id: str, payload: dict | None) -> dict | None:
    if not payload:
        return None
    summary = payload.get("summary") if isinstance(payload.get("summary"), dict) else {}
    balances = payload.get("balances") if isinstance(payload.get("balances"), list) else []
    positions = payload.get("positions") if isinstance(payload.get("positions"), list) else []
    as_of = str(payload.get("as_of") or _now_utc().isoformat())

    execute(
        "DELETE FROM consolidated_positions WHERE account_id = %s AND source = 'mt5-bridge-normalized'",
        (account_id,),
    )

    for balance in balances:
        if not isinstance(balance, dict):
            continue
        execute(
            """
            INSERT INTO account_balances (
                account_id, asset_symbol, available_qty, locked_qty, equity_usd,
                mark_price_usd, as_of, source, payload
            ) VALUES (%s, %s, %s, %s, %s, %s, %s::timestamptz, %s, %s::jsonb)
            ON CONFLICT (account_id, asset_symbol, as_of) DO UPDATE SET
                available_qty = EXCLUDED.available_qty,
                locked_qty = EXCLUDED.locked_qty,
                equity_usd = EXCLUDED.equity_usd,
                mark_price_usd = EXCLUDED.mark_price_usd,
                source = EXCLUDED.source,
                payload = EXCLUDED.payload
            """,
            (
                account_id,
                str(balance.get("asset_symbol") or "USD").upper(),
                _to_float(balance.get("available_qty"), 0.0),
                _to_float(balance.get("locked_qty"), 0.0),
                _to_float(balance.get("equity_usd"), 0.0),
                _to_float(balance.get("mark_price_usd"), 0.0) or None,
                str(balance.get("as_of") or as_of),
                str(balance.get("source") or "mt5-bridge-normalized"),
                json_dumps(balance.get("payload") if isinstance(balance.get("payload"), dict) else {}),
            ),
        )

    portfolio_link = fetch_one(
        """
        SELECT pa.portfolio_id
        FROM portfolio_accounts pa
        JOIN portfolios p ON p.portfolio_id = pa.portfolio_id
        WHERE pa.account_id = %s AND pa.status = 'active'
        ORDER BY CASE WHEN pa.portfolio_id = %s THEN 1 ELSE 0 END ASC, pa.id ASC
        LIMIT 1
        """,
        (account_id, _PHASE1_INTERNAL_PORTFOLIO_ID),
    )
    portfolio_id = str(portfolio_link["portfolio_id"]) if portfolio_link else None

    for position in positions:
        if not isinstance(position, dict):
            continue
        execute(
            """
            INSERT INTO consolidated_positions (
                position_id, account_id, portfolio_id, strategy_id, symbol, instrument, side,
                quantity, notional_usd, avg_entry_price, mark_price,
                pnl_unrealized_usd, pnl_realized_usd, as_of, source, payload
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::timestamptz, %s, %s::jsonb)
            ON CONFLICT (position_id) DO UPDATE SET
                account_id = EXCLUDED.account_id,
                portfolio_id = EXCLUDED.portfolio_id,
                strategy_id = EXCLUDED.strategy_id,
                symbol = EXCLUDED.symbol,
                instrument = EXCLUDED.instrument,
                side = EXCLUDED.side,
                quantity = EXCLUDED.quantity,
                notional_usd = EXCLUDED.notional_usd,
                avg_entry_price = EXCLUDED.avg_entry_price,
                mark_price = EXCLUDED.mark_price,
                pnl_unrealized_usd = EXCLUDED.pnl_unrealized_usd,
                pnl_realized_usd = EXCLUDED.pnl_realized_usd,
                as_of = EXCLUDED.as_of,
                source = EXCLUDED.source,
                payload = EXCLUDED.payload
            """,
            (
                str(position.get("position_id") or f"mt5:{account_id}:{position.get('symbol', 'unknown')}").strip(),
                account_id,
                portfolio_id,
                position.get("strategy_id"),
                str(position.get("symbol") or position.get("instrument") or "").upper(),
                str(position.get("instrument") or position.get("symbol") or "").upper(),
                str(position.get("side") or "flat"),
                _to_float(position.get("quantity"), 0.0),
                _to_float(position.get("notional_usd"), 0.0),
                _to_float(position.get("avg_entry_price"), 0.0),
                _to_float(position.get("mark_price"), 0.0),
                _to_float(position.get("pnl_unrealized_usd"), 0.0),
                _to_float(position.get("pnl_realized_usd"), 0.0),
                str(position.get("as_of") or as_of),
                str(position.get("source") or "mt5-bridge-normalized"),
                json_dumps(position.get("payload") if isinstance(position.get("payload"), dict) else {}),
            ),
        )

    return {
        "status": str(payload.get("status") or "ok"),
        "as_of": as_of,
        "summary": {
            "equity_usd": _to_float(summary.get("equity_usd"), 0.0),
            "gross_exposure_usd": _to_float(summary.get("gross_exposure_usd"), 0.0),
            "net_exposure_usd": _to_float(summary.get("net_exposure_usd"), 0.0),
            "position_count": len([item for item in positions if isinstance(item, dict)]),
            "balance_count": len([item for item in balances if isinstance(item, dict)]),
        },
    }


async def _sync_mt5_account_state(account_id: str) -> dict | None:
    _sync_accounts_registry_from_mt5(account_id)
    normalized_state = await _fetch_mt5_normalized_state(account_id)
    persisted = _persist_mt5_account_state(account_id, normalized_state)
    if persisted:
        persisted["risk_snapshots"] = _refresh_portfolio_risk_snapshots_for_account(account_id)
    return persisted


def _bootstrap_phase1_registry() -> None:
    execute(
        """
        INSERT INTO clients (client_id, legal_name, client_type, base_currency, status, kyc_status, metadata)
        VALUES (%s, 'TXT Internal', 'internal', 'USD', 'active', 'not_required', '{"scope":"internal"}'::jsonb)
        ON CONFLICT (client_id) DO UPDATE SET
            legal_name = EXCLUDED.legal_name,
            status = EXCLUDED.status,
            updated_at = NOW()
        """,
        (_PHASE1_INTERNAL_CLIENT_ID,),
    )
    execute(
        """
        INSERT INTO user_client_memberships (user_id, client_id, membership_role, is_primary, permissions)
        SELECT
            users.id,
            %s,
            CASE
                WHEN users.role = 'admin' THEN 'admin'
                WHEN users.role = 'operator' THEN 'operator'
                ELSE 'viewer'
            END,
            TRUE,
            CASE
                WHEN users.role = 'admin' THEN '["*"]'::jsonb
                WHEN users.role = 'operator' THEN '["read","write"]'::jsonb
                ELSE '["read"]'::jsonb
            END
        FROM users
        WHERE users.role IN ('viewer', 'operator', 'admin')
        ON CONFLICT (user_id, client_id, membership_role) DO NOTHING
        """,
        (_PHASE1_INTERNAL_CLIENT_ID,),
    )
    execute(
        """
        INSERT INTO portfolios (
            portfolio_id, client_id, name, base_currency, mandate_type, risk_profile, benchmark_symbol, status, metadata
        ) VALUES (%s, %s, 'TXT Internal Ops', 'USD', 'treasury', 'balanced', NULL, 'active', '{"scope":"internal-ops","auto_managed":true,"operational_scope":"live-only"}'::jsonb)
        ON CONFLICT (portfolio_id) DO UPDATE SET
            name = EXCLUDED.name,
            status = EXCLUDED.status,
            metadata = portfolios.metadata || EXCLUDED.metadata,
            updated_at = NOW()
        """,
        (_PHASE1_INTERNAL_PORTFOLIO_ID, _PHASE1_INTERNAL_CLIENT_ID),
    )
    _sync_accounts_registry_from_mt5()


def _latest_account_balances(account_id: str) -> list[dict]:
    normalized_account_id = _normalize_account_id(account_id)
    rows = fetch_all(
        """
        SELECT LOWER(BTRIM(account_id)) AS account_id, asset_symbol, available_qty, locked_qty, equity_usd, mark_price_usd, as_of, source, payload
        FROM (
            SELECT DISTINCT ON (account_id, asset_symbol)
                account_id, asset_symbol, available_qty, locked_qty, equity_usd, mark_price_usd, as_of, source, payload
            FROM account_balances
            WHERE LOWER(BTRIM(account_id)) = %s
            ORDER BY account_id, asset_symbol, as_of DESC, id DESC
        ) latest
        ORDER BY asset_symbol ASC
        """,
        (normalized_account_id,),
    )
    return _normalize_db_rows(rows)


def _latest_account_positions(account_id: str) -> list[dict]:
    normalized_account_id = _normalize_account_id(account_id)
    rows = fetch_all(
        """
        SELECT position_id, LOWER(BTRIM(account_id)) AS account_id, portfolio_id, strategy_id, symbol, instrument, side, quantity,
               notional_usd, avg_entry_price, mark_price, pnl_unrealized_usd, pnl_realized_usd,
               as_of, source, payload
        FROM (
            SELECT DISTINCT ON (position_id)
                position_id, account_id, portfolio_id, strategy_id, symbol, instrument, side, quantity,
                notional_usd, avg_entry_price, mark_price, pnl_unrealized_usd, pnl_realized_usd,
                as_of, source, payload
            FROM consolidated_positions
            WHERE LOWER(BTRIM(account_id)) = %s
            ORDER BY position_id, as_of DESC
        ) latest
        ORDER BY as_of DESC, symbol ASC
        """,
        (normalized_account_id,),
    )
    return _normalize_db_rows(rows)


def _portfolio_state_snapshot(portfolio_id: str) -> dict:
    portfolio = fetch_one(
        """
        SELECT portfolio_id, client_id, name, base_currency, mandate_type, risk_profile, benchmark_symbol, status, metadata, created_at, updated_at
        FROM portfolios
        WHERE portfolio_id = %s
        """,
        (portfolio_id,),
    )
    if not portfolio:
        raise HTTPException(status_code=404, detail="Portfolio not found")

    balances = fetch_all(
        """
        SELECT latest.account_id, latest.asset_symbol, latest.available_qty, latest.locked_qty,
               latest.equity_usd, latest.mark_price_usd, latest.as_of, latest.source, latest.payload
        FROM (
            SELECT DISTINCT ON (ab.account_id, ab.asset_symbol)
                ab.account_id, ab.asset_symbol, ab.available_qty, ab.locked_qty,
                ab.equity_usd, ab.mark_price_usd, ab.as_of, ab.source, ab.payload
            FROM account_balances ab
            JOIN portfolio_accounts pa ON pa.account_id = ab.account_id
            WHERE pa.portfolio_id = %s AND pa.status = 'active'
            ORDER BY ab.account_id, ab.asset_symbol, ab.as_of DESC, ab.id DESC
        ) latest
        ORDER BY latest.account_id, latest.asset_symbol
        """,
        (portfolio_id,),
    )
    positions = fetch_all(
        """
        SELECT latest.position_id, latest.account_id, latest.portfolio_id, latest.strategy_id, latest.symbol,
               latest.instrument, latest.side, latest.quantity, latest.notional_usd, latest.avg_entry_price,
               latest.mark_price, latest.pnl_unrealized_usd, latest.pnl_realized_usd, latest.as_of,
               latest.source, latest.payload
        FROM (
            SELECT DISTINCT ON (cp.position_id)
                cp.position_id, cp.account_id, cp.portfolio_id, cp.strategy_id, cp.symbol,
                cp.instrument, cp.side, cp.quantity, cp.notional_usd, cp.avg_entry_price,
                cp.mark_price, cp.pnl_unrealized_usd, cp.pnl_realized_usd, cp.as_of,
                cp.source, cp.payload
            FROM consolidated_positions cp
            JOIN portfolio_accounts pa ON pa.account_id = cp.account_id
            WHERE pa.portfolio_id = %s AND pa.status = 'active'
            ORDER BY cp.position_id, cp.as_of DESC
        ) latest
        ORDER BY latest.as_of DESC, latest.symbol ASC
        """,
        (portfolio_id,),
    )

    normalized_balances = _normalize_db_rows(balances)
    normalized_positions = _normalize_db_rows(positions)
    equity_usd = sum(float(item.get("equity_usd") or 0.0) for item in normalized_balances)
    gross_exposure_usd = sum(abs(float(item.get("notional_usd") or 0.0)) for item in normalized_positions)
    net_exposure_usd = 0.0
    current_pnl_usd = 0.0
    as_of_candidates: list[str] = []

    for item in normalized_balances:
        if item.get("as_of"):
            as_of_candidates.append(str(item["as_of"]))
    for item in normalized_positions:
        notional_usd = float(item.get("notional_usd") or 0.0)
        if item.get("side") == "short":
            net_exposure_usd -= abs(notional_usd)
        elif item.get("side") == "long":
            net_exposure_usd += abs(notional_usd)
        current_pnl_usd += float(item.get("pnl_unrealized_usd") or 0.0) + float(item.get("pnl_realized_usd") or 0.0)
        if item.get("as_of"):
            as_of_candidates.append(str(item["as_of"]))

    gross_exposure_pct = (gross_exposure_usd / equity_usd * 100.0) if equity_usd > 0 else 0.0
    net_exposure_pct = (net_exposure_usd / equity_usd * 100.0) if equity_usd > 0 else 0.0
    snapshot = PortfolioStateSnapshot(
        portfolio_id=str(portfolio["portfolio_id"]),
        client_id=str(portfolio["client_id"]),
        as_of=max(as_of_candidates) if as_of_candidates else _now_utc().isoformat(),
        equity_usd=equity_usd,
        gross_exposure_usd=gross_exposure_usd,
        net_exposure_usd=net_exposure_usd,
        gross_exposure_pct=gross_exposure_pct,
        net_exposure_pct=net_exposure_pct,
        total_notional_usd=gross_exposure_usd,
        current_pnl_usd=current_pnl_usd,
        daily_pnl_usd=0.0,
        max_drawdown_pct=0.0,
        var_95_pct=0.0,
        sharpe_ratio=None,
        correlation_matrix={},
        balances=normalized_balances,
        positions=normalized_positions,
    )
    return snapshot.model_dump()


def _portfolio_risk_snapshot(portfolio_id: str) -> dict:
    state = _portfolio_state_snapshot(portfolio_id)
    positions = state.get("positions") if isinstance(state.get("positions"), list) else []
    equity_usd = _to_float(state.get("equity_usd"), 0.0)
    long_exposure_usd = 0.0
    short_exposure_usd = 0.0
    exposures_by_symbol: dict[str, dict[str, Any]] = {}

    for item in positions:
        if not isinstance(item, dict):
            continue
        symbol = str(item.get("symbol") or item.get("instrument") or "UNKNOWN").upper()
        side = str(item.get("side") or "flat")
        notional_usd = abs(_to_float(item.get("notional_usd"), 0.0))
        signed_notional = notional_usd if side == "long" else (-notional_usd if side == "short" else 0.0)
        if side == "long":
            long_exposure_usd += notional_usd
        elif side == "short":
            short_exposure_usd += notional_usd
        bucket = exposures_by_symbol.setdefault(
            symbol,
            {
                "symbol": symbol,
                "gross_notional_usd": 0.0,
                "net_notional_usd": 0.0,
                "position_count": 0,
            },
        )
        bucket["gross_notional_usd"] += notional_usd
        bucket["net_notional_usd"] += signed_notional
        bucket["position_count"] += 1

    gross_exposure_usd = _to_float(state.get("gross_exposure_usd"), 0.0)
    net_exposure_usd = _to_float(state.get("net_exposure_usd"), 0.0)
    gross_exposure_pct = (gross_exposure_usd / equity_usd * 100.0) if equity_usd > 0 else 0.0
    net_exposure_pct = (net_exposure_usd / equity_usd * 100.0) if equity_usd > 0 else 0.0
    leverage_gross = gross_exposure_usd / equity_usd if equity_usd > 0 else 0.0
    leverage_net = abs(net_exposure_usd) / equity_usd if equity_usd > 0 else 0.0

    symbol_exposures: list[dict[str, Any]] = []
    largest_symbol = None
    concentration_pct = 0.0
    for item in sorted(exposures_by_symbol.values(), key=lambda row: float(row["gross_notional_usd"]), reverse=True):
        gross_symbol_usd = _to_float(item.get("gross_notional_usd"), 0.0)
        item["concentration_pct"] = (gross_symbol_usd / gross_exposure_usd * 100.0) if gross_exposure_usd > 0 else 0.0
        symbol_exposures.append(item)
        if largest_symbol is None:
            largest_symbol = str(item.get("symbol") or "") or None
            concentration_pct = _to_float(item.get("concentration_pct"), 0.0)

    symbol_histories = _portfolio_symbol_histories(symbol_exposures)
    correlation_pairs = _portfolio_correlation_pairs(symbol_exposures, symbol_histories)
    var_model = _portfolio_parametric_var(symbol_exposures, correlation_pairs, symbol_histories)
    sigma_1d = _to_float(var_model.get("sigma_1d"), 0.0)
    var_95_usd = sigma_1d * _to_float(var_model.get("z_95"), 1.65)
    var_99_usd = sigma_1d * _to_float(var_model.get("z_99"), 2.33)
    breaches: list[dict[str, Any]] = []
    if gross_exposure_pct >= 100:
        breaches.append({"severity": "critical", "breach_type": "gross_exposure_pct", "current_value": gross_exposure_pct, "limit_value": 100.0})
    elif gross_exposure_pct >= 70:
        breaches.append({"severity": "warn", "breach_type": "gross_exposure_pct", "current_value": gross_exposure_pct, "limit_value": 70.0})
    if abs(net_exposure_pct) >= 80:
        breaches.append({"severity": "warn", "breach_type": "net_exposure_pct", "current_value": net_exposure_pct, "limit_value": 80.0})
    if concentration_pct >= 35:
        breaches.append({"severity": "warn", "breach_type": "symbol_concentration_pct", "current_value": concentration_pct, "limit_value": 35.0, "symbol": largest_symbol})

    snapshot = PortfolioRiskSnapshot(
        portfolio_id=str(state.get("portfolio_id") or portfolio_id),
        client_id=str(state.get("client_id") or ""),
        as_of=str(state.get("as_of") or _now_utc().isoformat()),
        equity_usd=equity_usd,
        gross_exposure_usd=gross_exposure_usd,
        net_exposure_usd=net_exposure_usd,
        long_exposure_usd=long_exposure_usd,
        short_exposure_usd=short_exposure_usd,
        gross_exposure_pct=gross_exposure_pct,
        net_exposure_pct=net_exposure_pct,
        leverage_gross=leverage_gross,
        leverage_net=leverage_net,
        drawdown_pct=0.0,
        var_95_usd=var_95_usd,
        var_99_usd=var_99_usd,
        concentration_pct=concentration_pct,
        largest_symbol=largest_symbol,
        symbol_exposures=symbol_exposures,
        correlation_pairs=correlation_pairs,
        var_model=var_model,
        breaches=breaches,
    )
    return snapshot.model_dump()


def _portfolio_ids_for_account(account_id: str) -> list[str]:
    rows = fetch_all(
        "SELECT portfolio_id FROM portfolio_accounts WHERE account_id = %s AND status = 'active' ORDER BY id ASC",
        (account_id,),
    )
    return [str(row.get("portfolio_id") or "") for row in rows if str(row.get("portfolio_id") or "")]


def _persist_portfolio_risk_snapshot(portfolio_id: str) -> dict:
    snapshot = _portfolio_risk_snapshot(portfolio_id)
    snapshot_id = f"ps-{uuid4()}"
    execute(
        """
        INSERT INTO portfolio_snapshots (
            snapshot_id, portfolio_id, gross_exposure_usd, net_exposure_usd, long_exposure_usd,
            short_exposure_usd, equity_usd, pnl_day_usd, drawdown_pct, var_95_usd,
            var_99_usd, leverage_gross, leverage_net, as_of, payload
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::timestamptz, %s::jsonb)
        """,
        (
            snapshot_id,
            portfolio_id,
            _to_float(snapshot.get("gross_exposure_usd"), 0.0),
            _to_float(snapshot.get("net_exposure_usd"), 0.0),
            _to_float(snapshot.get("long_exposure_usd"), 0.0),
            _to_float(snapshot.get("short_exposure_usd"), 0.0),
            _to_float(snapshot.get("equity_usd"), 0.0),
            _to_float(snapshot.get("daily_pnl_usd"), 0.0),
            _to_float(snapshot.get("drawdown_pct"), 0.0),
            _to_float(snapshot.get("var_95_usd"), 0.0),
            _to_float(snapshot.get("var_99_usd"), 0.0),
            _to_float(snapshot.get("leverage_gross"), 0.0),
            _to_float(snapshot.get("leverage_net"), 0.0),
            str(snapshot.get("as_of") or _now_utc().isoformat()),
            json_dumps(
                {
                    "projection_source": "phase2-risk-projection",
                    "largest_symbol": snapshot.get("largest_symbol"),
                    "concentration_pct": snapshot.get("concentration_pct"),
                    "var_model": snapshot.get("var_model") or {},
                }
            ),
        ),
    )
    for item in snapshot.get("symbol_exposures", []):
        if not isinstance(item, dict):
            continue
        execute(
            """
            INSERT INTO portfolio_symbol_exposure (
                snapshot_id, symbol, net_notional_usd, gross_notional_usd, beta_weighted_notional_usd, concentration_pct
            ) VALUES (%s, %s, %s, %s, %s, %s)
            ON CONFLICT (snapshot_id, symbol) DO UPDATE SET
                net_notional_usd = EXCLUDED.net_notional_usd,
                gross_notional_usd = EXCLUDED.gross_notional_usd,
                beta_weighted_notional_usd = EXCLUDED.beta_weighted_notional_usd,
                concentration_pct = EXCLUDED.concentration_pct
            """,
            (
                snapshot_id,
                str(item.get("symbol") or "UNKNOWN"),
                _to_float(item.get("net_notional_usd"), 0.0),
                _to_float(item.get("gross_notional_usd"), 0.0),
                _to_float(item.get("beta_weighted_notional_usd"), _to_float(item.get("gross_notional_usd"), 0.0)),
                _to_float(item.get("concentration_pct"), 0.0),
            ),
        )
    for pair in snapshot.get("correlation_pairs", []):
        if not isinstance(pair, dict):
            continue
        execute(
            """
            INSERT INTO portfolio_correlation_snapshots (
                snapshot_id, symbol_x, symbol_y, correlation_30d
            ) VALUES (%s, %s, %s, %s)
            ON CONFLICT (snapshot_id, symbol_x, symbol_y) DO UPDATE SET
                correlation_30d = EXCLUDED.correlation_30d
            """,
            (
                snapshot_id,
                str(pair.get("symbol_x") or "UNKNOWN"),
                str(pair.get("symbol_y") or "UNKNOWN"),
                _to_float(pair.get("correlation_30d"), 0.0),
            ),
        )
    for breach in snapshot.get("breaches", []):
        if not isinstance(breach, dict):
            continue
        execute(
            """
            INSERT INTO risk_limit_breaches (
                breach_id, portfolio_id, account_id, scope_type, breach_type, severity,
                current_value, limit_value, action_taken, payload
            ) VALUES (%s, %s, NULL, 'portfolio', %s, %s, %s, %s, %s, %s::jsonb)
            ON CONFLICT (breach_id) DO NOTHING
            """,
            (
                f"rlb-{uuid4()}",
                portfolio_id,
                str(breach.get("breach_type") or "unknown"),
                str(breach.get("severity") or "warn"),
                _to_float(breach.get("current_value"), 0.0),
                _to_float(breach.get("limit_value"), 0.0),
                str(breach.get("action_taken") or "observe"),
                json_dumps(
                    {
                        **breach,
                        "snapshot_id": snapshot_id,
                        "projection_source": "phase2-risk-projection",
                    }
                ),
            ),
        )
    latest = _latest_portfolio_risk_snapshot(portfolio_id, snapshot_id=snapshot_id)
    return latest or snapshot


def _parse_iso_datetime(value: str | None) -> datetime:
    if not value:
        return _now_utc()
    normalized = value.strip()
    if normalized.endswith("Z"):
        normalized = f"{normalized[:-1]}+00:00"
    parsed = datetime.fromisoformat(normalized)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _coerce_period_bounds(start: str | None, end: str | None) -> tuple[datetime, datetime]:
    end_dt = _parse_iso_datetime(end) if end else _now_utc()
    start_dt = _parse_iso_datetime(start) if start else end_dt - timedelta(days=30)
    if start_dt > end_dt:
        raise HTTPException(status_code=400, detail="start must be <= end")
    return start_dt, end_dt


def _performance_scope_clause(scope_type: str, scope_id: str) -> tuple[str, list[Any]]:
    normalized_scope = (scope_type or "").strip().lower()
    mapping = {
        "client": "p.client_id = %s",
        "portfolio": "sr.portfolio_id = %s",
        "account": "et.account_id = %s",
        "strategy": "d.strategy_id = %s",
        "symbol": "d.symbol = %s",
        "provider": "d.provider = %s",
    }
    clause = mapping.get(normalized_scope)
    if not clause:
        raise HTTPException(status_code=400, detail="unsupported scope_type")
    normalized_scope_id = (scope_id or "").strip()
    if not normalized_scope_id:
        raise HTTPException(status_code=400, detail="scope_id is required")
    return clause, [normalized_scope_id]


def _performance_base_query(scope_type: str, scope_id: str, start: datetime, end: datetime) -> tuple[str, list[Any]]:
    scope_clause, scope_params = _performance_scope_clause(scope_type, scope_id)
    query = f"""
        FROM decision_outcomes d
        LEFT JOIN strategies_registry sr ON sr.strategy_id = d.strategy_id
        LEFT JOIN portfolios p ON p.portfolio_id = sr.portfolio_id
        LEFT JOIN execution_telemetry et ON et.decision_id = d.decision_id
        WHERE {scope_clause}
          AND d.created_at >= %s
          AND d.created_at <= %s
    """
    return query, scope_params + [start, end]


def _performance_sharpe_ratio(scope_type: str, scope_id: str, start: datetime, end: datetime) -> float | None:
    base_query, params = _performance_base_query(scope_type, scope_id, start, end)
    rows = _normalize_db_rows(
        fetch_all(
            f"""
            SELECT date_trunc('day', d.created_at) AS bucket_start,
                   COALESCE(SUM(COALESCE(d.net_result_usd, 0)), 0) AS pnl_realized_usd
            {base_query}
            GROUP BY 1
            ORDER BY 1 ASC
            """,
            tuple(params),
        )
    )
    daily_returns = [_to_float(row.get("pnl_realized_usd"), 0.0) for row in rows]
    if len(daily_returns) < 2:
        return None
    mean_daily = sum(daily_returns) / len(daily_returns)
    std_daily = _sample_stddev(daily_returns)
    if std_daily <= 0:
        return None
    return mean_daily / std_daily * math.sqrt(252.0)


def _performance_summary(scope_type: str, scope_id: str, start: datetime, end: datetime) -> dict[str, Any]:
    base_query, params = _performance_base_query(scope_type, scope_id, start, end)
    aggregate = _normalize_db_row(
        fetch_one(
            f"""
            SELECT COUNT(*) AS trade_count,
                   COALESCE(SUM(COALESCE(d.net_result_usd, 0)), 0) AS realized_pnl_usd,
                   COALESCE(SUM(COALESCE(d.fees_usd, 0)), 0) AS fees_usd,
                   COALESCE(AVG(COALESCE(d.slippage_real_bps, 0)), 0) AS avg_slippage_bps,
                   COALESCE(AVG(COALESCE(d.latency_ms, 0)), 0) AS avg_latency_ms,
                   COALESCE(SUM(CASE WHEN COALESCE(d.net_result_usd, 0) > 0 THEN 1 ELSE 0 END), 0) AS wins
            {base_query}
            """,
            tuple(params),
        )
    ) or {}
    trade_count = int(aggregate.get("trade_count") or 0)
    realized_pnl_usd = _to_float(aggregate.get("realized_pnl_usd"), 0.0)
    wins = _to_float(aggregate.get("wins"), 0.0)
    return {
        "scope_type": scope_type,
        "scope_id": scope_id,
        "period_start": start.isoformat(),
        "period_end": end.isoformat(),
        "trade_count": trade_count,
        "realized_pnl_usd": realized_pnl_usd,
        "unrealized_pnl_usd": 0.0,
        "fees_usd": _to_float(aggregate.get("fees_usd"), 0.0),
        "win_rate_pct": wins / trade_count * 100.0 if trade_count > 0 else 0.0,
        "expectancy_usd": realized_pnl_usd / trade_count if trade_count > 0 else 0.0,
        "avg_slippage_bps": _to_float(aggregate.get("avg_slippage_bps"), 0.0),
        "avg_latency_ms": _to_float(aggregate.get("avg_latency_ms"), 0.0),
        "sharpe_ratio": _performance_sharpe_ratio(scope_type, scope_id, start, end),
    }


def _performance_bucket_expr(bucket_granularity: str) -> str:
    normalized = (bucket_granularity or "1d").strip().lower()
    if normalized == "1h":
        return "date_trunc('hour', d.created_at)"
    if normalized == "1mo":
        return "date_trunc('month', d.created_at)"
    if normalized == "1d":
        return "date_trunc('day', d.created_at)"
    raise HTTPException(status_code=400, detail="unsupported bucket_granularity")


def _performance_group_dimensions(group_by: str | None) -> list[tuple[str, str]]:
    requested = [item.strip().lower() for item in str(group_by or "strategy,symbol,venue").split(",") if item.strip()]
    mapping = {
        "strategy": ("strategy_id", "d.strategy_id"),
        "symbol": ("symbol", "d.symbol"),
        "venue": ("venue", "d.provider"),
    }
    if not requested:
        requested = ["strategy", "symbol", "venue"]
    dimensions: list[tuple[str, str]] = []
    seen: set[str] = set()
    for item in requested:
        if item not in mapping:
            raise HTTPException(status_code=400, detail=f"unsupported attribution group: {item}")
        if item in seen:
            continue
        dimensions.append(mapping[item])
        seen.add(item)
    return dimensions


def _performance_timeseries(scope_type: str, scope_id: str, start: datetime, end: datetime, bucket_granularity: str) -> list[dict[str, Any]]:
    bucket_expr = _performance_bucket_expr(bucket_granularity)
    normalized_bucket = (bucket_granularity or "1d").strip().lower()
    base_query, params = _performance_base_query(scope_type, scope_id, start, end)
    rows = _normalize_db_rows(
        fetch_all(
            f"""
            SELECT {bucket_expr} AS bucket_start,
                   COALESCE(SUM(COALESCE(d.net_result_usd, 0)), 0) AS pnl_realized_usd,
                   COALESCE(SUM(COALESCE(d.fees_usd, 0)), 0) AS fees_usd,
                   COUNT(*) AS trade_count,
                   COALESCE(AVG(CASE WHEN COALESCE(d.net_result_usd, 0) > 0 THEN 100.0 ELSE 0.0 END), 0) AS win_rate_pct
            {base_query}
            GROUP BY 1
            ORDER BY 1 ASC
            """,
            tuple(params),
        )
    )
    return [
        {
            "bucket_start": str(row.get("bucket_start") or ""),
            "bucket_granularity": normalized_bucket,
            "pnl_realized_usd": _to_float(row.get("pnl_realized_usd"), 0.0),
            "pnl_unrealized_usd": 0.0,
            "fees_usd": _to_float(row.get("fees_usd"), 0.0),
            "trade_count": int(row.get("trade_count") or 0),
            "win_rate_pct": _to_float(row.get("win_rate_pct"), 0.0),
        }
        for row in rows
    ]


def _performance_attribution(scope_type: str, scope_id: str, start: datetime, end: datetime, group_by: str | None = None) -> list[dict[str, Any]]:
    base_query, params = _performance_base_query(scope_type, scope_id, start, end)
    dimensions = _performance_group_dimensions(group_by)
    select_dimensions = [f"{expression} AS {alias}" for alias, expression in dimensions]
    group_dimensions = [expression for _, expression in dimensions]
    for alias in ("strategy_id", "symbol", "venue"):
        if alias not in {name for name, _ in dimensions}:
            select_dimensions.append(f"NULL::text AS {alias}")
    order_dimensions = [alias for alias, _ in dimensions] or ["strategy_id", "symbol", "venue"]
    group_by_sql = ", ".join(group_dimensions)
    order_by_sql = ", ".join(f"aggregated.{alias} ASC NULLS LAST" for alias in order_dimensions)
    rows = _normalize_db_rows(
        fetch_all(
            f"""
            WITH aggregated AS (
                SELECT {', '.join(select_dimensions)},
                       COALESCE(SUM(COALESCE(d.net_result_usd, 0)), 0) AS realized_pnl_usd,
                       COALESCE(SUM(COALESCE(d.fees_usd, 0)), 0) AS fees_usd,
                       COUNT(*) AS trade_count,
                       COALESCE(AVG(CASE WHEN COALESCE(d.net_result_usd, 0) > 0 THEN 100.0 ELSE 0.0 END), 0) AS win_rate_pct,
                       COALESCE(AVG(COALESCE(d.net_result_usd, 0)), 0) AS expectancy_usd,
                       COALESCE(AVG(COALESCE(d.slippage_real_bps, 0)), 0) AS avg_slippage_bps,
                       COALESCE(AVG(COALESCE(d.latency_ms, 0)), 0) AS avg_latency_ms,
                       COALESCE(AVG(COALESCE(d.score_pre_trade, 0)), 0) AS avg_score_pre_trade,
                       COALESCE(SUM(CASE WHEN COALESCE(d.net_result_usd, 0) > 0 THEN COALESCE(d.net_result_usd, 0) ELSE 0 END), 0) AS gross_profit_usd,
                       COALESCE(ABS(SUM(CASE WHEN COALESCE(d.net_result_usd, 0) < 0 THEN COALESCE(d.net_result_usd, 0) ELSE 0 END)), 0) AS gross_loss_usd,
                       COALESCE(AVG(COALESCE(d.mae, 0)), 0) AS avg_mae,
                       COALESCE(AVG(COALESCE(d.mfe, 0)), 0) AS avg_mfe
                {base_query}
                GROUP BY {group_by_sql}
            )
            SELECT aggregated.*,
                   COALESCE(aggregated.realized_pnl_usd / NULLIF(SUM(aggregated.realized_pnl_usd) OVER (), 0) * 100.0, 0.0) AS pnl_contribution_pct,
                   CASE
                       WHEN aggregated.gross_loss_usd > 0 THEN aggregated.gross_profit_usd / aggregated.gross_loss_usd
                       ELSE NULL
                   END AS profit_factor
            FROM aggregated
            ORDER BY aggregated.realized_pnl_usd DESC, aggregated.trade_count DESC, {order_by_sql}
            LIMIT 200
            """,
            tuple(params),
        )
    )
    return [
        {
            "scope_type": scope_type,
            "scope_id": scope_id,
            "period_start": start.isoformat(),
            "period_end": end.isoformat(),
            "strategy_id": row.get("strategy_id"),
            "symbol": row.get("symbol"),
            "venue": row.get("venue"),
            "realized_pnl_usd": _to_float(row.get("realized_pnl_usd"), 0.0),
            "unrealized_pnl_usd": 0.0,
            "fees_usd": _to_float(row.get("fees_usd"), 0.0),
            "trade_count": int(row.get("trade_count") or 0),
            "win_rate_pct": _to_float(row.get("win_rate_pct"), 0.0),
            "expectancy_usd": _to_float(row.get("expectancy_usd"), 0.0),
            "avg_slippage_bps": _to_float(row.get("avg_slippage_bps"), 0.0),
            "avg_latency_ms": _to_float(row.get("avg_latency_ms"), 0.0),
            "avg_score_pre_trade": _to_float(row.get("avg_score_pre_trade"), 0.0),
            "gross_profit_usd": _to_float(row.get("gross_profit_usd"), 0.0),
            "gross_loss_usd": _to_float(row.get("gross_loss_usd"), 0.0),
            "profit_factor": _to_float(row.get("profit_factor"), None),
            "pnl_contribution_pct": _to_float(row.get("pnl_contribution_pct"), 0.0),
            "avg_mae": _to_float(row.get("avg_mae"), 0.0),
            "avg_mfe": _to_float(row.get("avg_mfe"), 0.0),
            "group_by": [alias for alias, _ in dimensions],
            "sharpe_ratio": None,
        }
        for row in rows
    ]


def _execution_pnl_trade_from_row(row: dict[str, Any]) -> dict[str, Any]:
    payload = row.get("payload") if isinstance(row.get("payload"), dict) else {}
    router_execution = payload.get("router_execution") if isinstance(payload.get("router_execution"), dict) else {}
    route = router_execution.get("route") if isinstance(router_execution.get("route"), dict) else {}
    execution_context = route.get("execution_context") if isinstance(route.get("execution_context"), dict) else {}
    if not execution_context and isinstance(router_execution.get("execution_context"), dict):
        execution_context = router_execution.get("execution_context")
    policy = execution_context.get("policy") if isinstance(execution_context.get("policy"), dict) else {}
    fallback_mode = str(execution_context.get("fallback_mode") or policy.get("fallback_mode") or "normal")
    execution_mode = str(
        router_execution.get("execution_mode")
        or payload.get("source")
        or (payload.get("webhook_execution") if isinstance(payload.get("webhook_execution"), dict) else {}).get("execution_mode")
        or row.get("source")
        or "unknown"
    ).strip() or "unknown"
    venue = str(row.get("route_chosen") or row.get("provider") or "unknown").strip() or "unknown"
    confidence = _to_float(execution_context.get("confidence"), _to_float(row.get("score_pre_trade"), 0.0))
    no_trade_reasons = [str(reason) for reason in execution_context.get("no_trade_reasons", []) if str(reason)] if isinstance(execution_context, dict) else []
    dominant_reasons = [str(reason) for reason in execution_context.get("dominant_reasons", []) if str(reason)] if isinstance(execution_context, dict) else []
    return {
        "decision_id": str(row.get("decision_id") or ""),
        "symbol": str(row.get("symbol") or ""),
        "regime": str(row.get("regime") or "UNKNOWN").strip().upper() or "UNKNOWN",
        "venue": venue,
        "execution_mode": execution_mode,
        "status": str(row.get("status") or "unknown"),
        "net_result_usd": round(_to_float(row.get("net_result_usd"), 0.0), 6),
        "fees_usd": round(_to_float(row.get("fees_usd"), 0.0), 6),
        "score_pre_trade": round(_to_float(row.get("score_pre_trade"), 0.0), 6),
        "confidence": round(confidence, 6),
        "latency_ms": int(round(_to_float(row.get("latency_ms"), _to_float(row.get("latency_e2e_ms"), 0.0)))),
        "slippage_real_bps": round(_to_float(row.get("slippage_real_bps"), _to_float(row.get("realized_slippage_bps"), 0.0)), 6),
        "expected_slippage_bps": round(_to_float(row.get("expected_slippage_bps"), 0.0), 6),
        "fallback_mode": fallback_mode,
        "no_trade_dominance": bool(execution_context.get("no_trade_dominance") or policy.get("no_trade_dominance")),
        "no_trade_state": str(execution_context.get("no_trade_state") or policy.get("no_trade_state") or "eligible"),
        "no_trade_reasons": no_trade_reasons,
        "dominant_reasons": dominant_reasons,
        "created_at": str(row.get("created_at") or ""),
    }


def _execution_pnl_group_summary(trades: list[dict[str, Any]], field_name: str) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for trade in trades:
        key = str(trade.get(field_name) or "unknown").strip() or "unknown"
        grouped.setdefault(key, []).append(trade)
    rows: list[dict[str, Any]] = []
    for key, items in grouped.items():
        trade_count = len(items)
        net_pnl_usd = sum(_to_float(item.get("net_result_usd"), 0.0) for item in items)
        rows.append(
            {
                field_name: key,
                "trade_count": trade_count,
                "net_pnl_usd": round(net_pnl_usd, 6),
                "avg_pnl_usd": round(net_pnl_usd / trade_count, 6) if trade_count > 0 else 0.0,
                "win_rate_pct": round(sum(1 for item in items if _to_float(item.get("net_result_usd"), 0.0) > 0) / trade_count * 100.0, 6) if trade_count > 0 else 0.0,
                "avg_latency_ms": round(sum(max(0.0, _to_float(item.get("latency_ms"), 0.0)) for item in items) / trade_count, 6) if trade_count > 0 else 0.0,
                "avg_slippage_bps": round(sum(abs(_to_float(item.get("slippage_real_bps"), 0.0)) for item in items) / trade_count, 6) if trade_count > 0 else 0.0,
                "high_confidence_losses": sum(1 for item in items if _to_float(item.get("net_result_usd"), 0.0) < 0 and _to_float(item.get("confidence"), 0.0) >= 0.7),
            }
        )
    return sorted(rows, key=lambda item: (-_to_float(item.get("net_pnl_usd"), 0.0), -int(item.get("trade_count") or 0), str(item.get(field_name) or "")))


def _build_execution_pnl_analyzer_payload(
    rows: list[dict[str, Any]],
    *,
    scope_type: str,
    scope_id: str,
    start: datetime,
    end: datetime,
    confidence_flag_threshold: float,
    trade_limit: int,
) -> dict[str, Any]:
    trades = [_execution_pnl_trade_from_row(row) for row in rows]
    trades.sort(key=lambda item: str(item.get("created_at") or ""), reverse=True)
    net_pnl_usd = sum(_to_float(trade.get("net_result_usd"), 0.0) for trade in trades)
    trade_count = len(trades)
    high_confidence_losses = [
        {
            **trade,
            "flag": "bad_model_high_confidence_loss",
        }
        for trade in trades
        if _to_float(trade.get("net_result_usd"), 0.0) < 0 and _to_float(trade.get("confidence"), 0.0) >= confidence_flag_threshold
    ]
    no_trade_dominance_trades = sum(1 for trade in trades if bool(trade.get("no_trade_dominance")))
    return {
        "scope_type": scope_type,
        "scope_id": scope_id,
        "period_start": start.isoformat(),
        "period_end": end.isoformat(),
        "summary": {
            "trade_count": trade_count,
            "net_pnl_usd": round(net_pnl_usd, 6),
            "avg_pnl_usd": round(net_pnl_usd / trade_count, 6) if trade_count > 0 else 0.0,
            "fees_usd": round(sum(_to_float(trade.get("fees_usd"), 0.0) for trade in trades), 6),
            "win_rate_pct": round(sum(1 for trade in trades if _to_float(trade.get("net_result_usd"), 0.0) > 0) / trade_count * 100.0, 6) if trade_count > 0 else 0.0,
            "avg_latency_ms": round(sum(max(0.0, _to_float(trade.get("latency_ms"), 0.0)) for trade in trades) / trade_count, 6) if trade_count > 0 else 0.0,
            "avg_slippage_bps": round(sum(abs(_to_float(trade.get("slippage_real_bps"), 0.0)) for trade in trades) / trade_count, 6) if trade_count > 0 else 0.0,
            "high_confidence_loss_count": len(high_confidence_losses),
            "no_trade_dominance_count": no_trade_dominance_trades,
        },
        "by_regime": _execution_pnl_group_summary(trades, "regime"),
        "by_venue": _execution_pnl_group_summary(trades, "venue"),
        "by_execution_mode": _execution_pnl_group_summary(trades, "execution_mode"),
        "bad_model_flags": high_confidence_losses[: min(max(trade_limit, 1), 200)],
        "trades": trades[: min(max(trade_limit, 1), 500)],
    }


def _execution_pnl_analyzer(
    scope_type: str,
    scope_id: str,
    start: datetime,
    end: datetime,
    *,
    trade_limit: int = 50,
    confidence_flag_threshold: float = 0.7,
) -> dict[str, Any]:
    base_query, params = _performance_base_query(scope_type, scope_id, start, end)
    rows = _normalize_db_rows(
        fetch_all(
            f"""
            SELECT d.decision_id,
                   d.symbol,
                   d.provider,
                   d.regime,
                   d.score_pre_trade,
                   d.slippage_real_bps,
                   d.latency_ms,
                   d.fees_usd,
                   d.net_result_usd,
                   d.status,
                   d.created_at,
                   et.route_chosen,
                   et.expected_slippage_bps,
                   et.realized_slippage_bps,
                   et.latency_e2e_ms,
                   et.payload
            {base_query}
              AND COALESCE(d.status, '') <> 'pending'
            ORDER BY d.created_at DESC
            LIMIT %s
            """,
            tuple([*params, max(1, min(trade_limit, 500))]),
        )
    )
    return _build_execution_pnl_analyzer_payload(
        rows,
        scope_type=scope_type,
        scope_id=scope_id,
        start=start,
        end=end,
        confidence_flag_threshold=_to_float(confidence_flag_threshold, 0.7),
        trade_limit=trade_limit,
    )


def _coerce_report_month(report_month: str | None) -> tuple[str, datetime, datetime]:
    raw = str(report_month or "").strip()
    if not raw:
        now = _now_utc()
        month_start = datetime(now.year, now.month, 1, tzinfo=timezone.utc)
    else:
        candidate = raw if len(raw) > 7 else f"{raw}-01"
        try:
            parsed = datetime.fromisoformat(candidate)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="invalid report_month format") from exc
        month_start = datetime(parsed.year, parsed.month, 1, tzinfo=timezone.utc)
    if month_start.month == 12:
        next_month = datetime(month_start.year + 1, 1, 1, tzinfo=timezone.utc)
    else:
        next_month = datetime(month_start.year, month_start.month + 1, 1, tzinfo=timezone.utc)
    month_end = min(_now_utc(), next_month - timedelta(microseconds=1))
    return month_start.date().isoformat(), month_start, month_end


def _generate_investor_report_summary(
    client_id: str,
    portfolio_id: str | None,
    report_month: str | None,
    report_type: str,
    strategy_id: str | None = None,
) -> tuple[str, dict[str, Any]]:
    month_label, start_dt, end_dt = _coerce_report_month(report_month)
    client = fetch_one(
        "SELECT client_id, legal_name, client_type, base_currency, status FROM clients WHERE client_id = %s",
        (client_id,),
    ) or {}
    portfolio = fetch_one(
        "SELECT portfolio_id, client_id, name, base_currency, mandate_type, risk_profile, benchmark_symbol, status FROM portfolios WHERE portfolio_id = %s",
        (portfolio_id,),
    ) if portfolio_id else None
    scope_type = "portfolio" if portfolio_id else "client"
    scope_id = portfolio_id or client_id
    performance_summary = _performance_summary(scope_type, scope_id, start_dt, end_dt)
    performance_timeseries = _performance_timeseries(scope_type, scope_id, start_dt, end_dt, "1d")
    attribution_rows = _performance_attribution(scope_type, scope_id, start_dt, end_dt, group_by="strategy,symbol,venue")
    top_positive = next((row for row in attribution_rows if _to_float(row.get("realized_pnl_usd"), 0.0) > 0), None)
    top_negative = next((row for row in sorted(attribution_rows, key=lambda item: _to_float(item.get("realized_pnl_usd"), 0.0)) if _to_float(row.get("realized_pnl_usd"), 0.0) < 0), None)
    supplemental_strategy = None
    if strategy_id:
        supplemental_strategy = {
            "strategy_id": strategy_id,
            "summary": _performance_summary("strategy", strategy_id, start_dt, end_dt),
            "attribution": _performance_attribution("strategy", strategy_id, start_dt, end_dt, group_by="symbol,venue")[:10],
        }
    risk_snapshot = _latest_portfolio_risk_snapshot(portfolio_id) if portfolio_id else None
    headline_scope = str((portfolio or {}).get("name") or client.get("legal_name") or scope_id)
    summary = {
        "headline": f"{headline_scope} {report_type} report {month_label[:7]}",
        "generated_at": _now_utc().isoformat(),
        "scope": {
            "client_id": client_id,
            "client_name": client.get("legal_name"),
            "portfolio_id": portfolio_id,
            "portfolio_name": (portfolio or {}).get("name") if portfolio else None,
            "report_type": report_type,
            "report_month": month_label,
            "strategy_id": strategy_id,
        },
        "performance_summary": performance_summary,
        "performance_timeseries": performance_timeseries,
        "top_attribution": attribution_rows[:12],
        "top_positive": top_positive,
        "top_negative": top_negative,
        "risk_snapshot": risk_snapshot,
        "supplemental_strategy": supplemental_strategy,
    }
    return month_label, summary


def _upsert_investor_report(
    client_id: str,
    portfolio_id: str | None,
    report_month: str | None,
    report_type: str,
    status: str,
    strategy_id: str | None = None,
) -> dict[str, Any]:
    month_label, summary = _generate_investor_report_summary(client_id, portfolio_id, report_month, report_type, strategy_id=strategy_id)
    report_id = f"report-{client_id}-{portfolio_id or 'client'}-{month_label[:7]}-{report_type}"
    storage_path = f"db://investor_reports/{report_id}"
    published_at = _now_utc().isoformat() if status == "published" else None
    execute(
        """
        INSERT INTO investor_reports (report_id, client_id, portfolio_id, report_month, report_type, status, storage_path, summary, published_at)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s)
        ON CONFLICT (report_id) DO UPDATE SET
            status = EXCLUDED.status,
            storage_path = EXCLUDED.storage_path,
            summary = EXCLUDED.summary,
            published_at = EXCLUDED.published_at
        """,
        (report_id, client_id, portfolio_id, month_label, report_type, status, storage_path, json_dumps(summary), published_at),
    )
    row = fetch_one(
        "SELECT report_id, client_id, portfolio_id, report_month, report_type, status, storage_path, summary, created_at, published_at FROM investor_reports WHERE report_id = %s",
        (report_id,),
    )
    return _normalize_db_row(row) or {}


def _latest_portfolio_risk_snapshot(portfolio_id: str, snapshot_id: str | None = None) -> dict | None:
    params: list[Any] = [portfolio_id]
    where_sql = "WHERE portfolio_id = %s"
    if snapshot_id:
        where_sql += " AND snapshot_id = %s"
        params.append(snapshot_id)
    row = fetch_one(
        f"""
        SELECT snapshot_id, portfolio_id, gross_exposure_usd, net_exposure_usd, long_exposure_usd,
               short_exposure_usd, equity_usd, pnl_day_usd, drawdown_pct, var_95_usd,
               var_99_usd, leverage_gross, leverage_net, as_of, payload
        FROM portfolio_snapshots
        {where_sql}
        ORDER BY as_of DESC, snapshot_id DESC
        LIMIT 1
        """,
        tuple(params),
    )
    if not row:
        return None
    exposures = _normalize_db_rows(
        fetch_all(
            """
            SELECT symbol, net_notional_usd, gross_notional_usd, beta_weighted_notional_usd, concentration_pct
            FROM portfolio_symbol_exposure
            WHERE snapshot_id = %s
            ORDER BY gross_notional_usd DESC, symbol ASC
            """,
            (row["snapshot_id"],),
        )
    )
    breaches = _normalize_db_rows(
        fetch_all(
            """
            SELECT breach_id, breach_type, severity, current_value, limit_value, action_taken, payload, created_at
            FROM risk_limit_breaches
            WHERE portfolio_id = %s AND payload->>'snapshot_id' = %s
            ORDER BY created_at DESC
            """,
            (portfolio_id, row["snapshot_id"]),
        )
    )
    correlations = _normalize_db_rows(
        fetch_all(
            """
            SELECT symbol_x, symbol_y, correlation_30d
            FROM portfolio_correlation_snapshots
            WHERE snapshot_id = %s
            ORDER BY ABS(correlation_30d) DESC, symbol_x ASC, symbol_y ASC
            """,
            (row["snapshot_id"],),
        )
    )
    payload = row.get("payload") if isinstance(row.get("payload"), dict) else {}
    return {
        "snapshot_id": row["snapshot_id"],
        "portfolio_id": row["portfolio_id"],
        "as_of": _json_safe_value(row["as_of"]),
        "equity_usd": _to_float(row.get("equity_usd"), 0.0),
        "gross_exposure_usd": _to_float(row.get("gross_exposure_usd"), 0.0),
        "net_exposure_usd": _to_float(row.get("net_exposure_usd"), 0.0),
        "long_exposure_usd": _to_float(row.get("long_exposure_usd"), 0.0),
        "short_exposure_usd": _to_float(row.get("short_exposure_usd"), 0.0),
        "gross_exposure_pct": (_to_float(row.get("gross_exposure_usd"), 0.0) / _to_float(row.get("equity_usd"), 0.0) * 100.0) if _to_float(row.get("equity_usd"), 0.0) > 0 else 0.0,
        "net_exposure_pct": (_to_float(row.get("net_exposure_usd"), 0.0) / _to_float(row.get("equity_usd"), 0.0) * 100.0) if _to_float(row.get("equity_usd"), 0.0) > 0 else 0.0,
        "leverage_gross": _to_float(row.get("leverage_gross"), 0.0),
        "leverage_net": _to_float(row.get("leverage_net"), 0.0),
        "drawdown_pct": _to_float(row.get("drawdown_pct"), 0.0),
        "var_95_usd": _to_float(row.get("var_95_usd"), 0.0),
        "var_99_usd": _to_float(row.get("var_99_usd"), 0.0),
        "concentration_pct": _to_float(payload.get("concentration_pct"), 0.0),
        "largest_symbol": payload.get("largest_symbol"),
        "symbol_exposures": exposures,
        "correlation_pairs": correlations,
        "var_model": payload.get("var_model") if isinstance(payload.get("var_model"), dict) else {},
        "breaches": breaches,
    }


def _portfolio_capital_integration(portfolio_id: str) -> dict[str, Any]:
    portfolio = fetch_one(
        "SELECT portfolio_id, client_id, name, mandate_type, risk_profile, metadata FROM portfolios WHERE portfolio_id = %s",
        (portfolio_id,),
    )
    if not portfolio:
        raise HTTPException(status_code=404, detail="Portfolio not found")

    links = _normalize_db_rows(
        fetch_all(
            """
            SELECT pa.account_id, pa.allocation_weight, pa.allocation_cap_usd, pa.status,
                   ar.venue, ar.connector_type, ar.display_name, ar.metadata
            FROM portfolio_accounts pa
            JOIN accounts_registry ar ON ar.account_id = pa.account_id
            WHERE pa.portfolio_id = %s AND pa.status = 'active'
            ORDER BY pa.account_id ASC
            """,
            (portfolio_id,),
        )
    )

    sleeves: dict[str, dict[str, Any]] = {}
    total_equivalent_usd = 0.0
    total_raw_cash_usd = 0.0
    total_target_cap_usd = 0.0
    account_ids: list[str] = []

    for link in links:
        account_id = str(link.get("account_id") or "").strip()
        if not account_id:
            continue
        account_ids.append(account_id)
        metadata = link.get("metadata") if isinstance(link.get("metadata"), dict) else {}
        sleeve_key = str(metadata.get("capital_sleeve") or metadata.get("sleeve") or "unassigned")
        balances = _latest_account_balances(account_id)
        positions = _latest_account_positions(account_id)
        cash_vs_equivalent = _cash_vs_equivalent_summary(balances)
        ledger = _account_capital_ledger(account_id, limit=100)
        target_cap_usd = _to_float(link.get("allocation_cap_usd"), 0.0)
        sleeve = sleeves.setdefault(
            sleeve_key,
            {
                "sleeve": sleeve_key,
                "account_count": 0,
                "actual_equivalent_usd": 0.0,
                "actual_raw_cash_usd": 0.0,
                "target_cap_usd": 0.0,
                "realized_pnl_usd": 0.0,
                "unrealized_pnl_usd": 0.0,
                "net_external_cashflow_usd": 0.0,
                "funding_fee_usd": 0.0,
                "internal_transfer_usd": 0.0,
                "venues": set(),
                "accounts": [],
                "pocket_breakdown": {},
            },
        )
        sleeve["account_count"] = int(sleeve.get("account_count") or 0) + 1
        sleeve["actual_equivalent_usd"] = _to_float(sleeve.get("actual_equivalent_usd"), 0.0) + _to_float(cash_vs_equivalent.get("total_equivalent_usd"), 0.0)
        sleeve["actual_raw_cash_usd"] = _to_float(sleeve.get("actual_raw_cash_usd"), 0.0) + _to_float(cash_vs_equivalent.get("total_raw_cash_usd"), 0.0)
        sleeve["target_cap_usd"] = _to_float(sleeve.get("target_cap_usd"), 0.0) + target_cap_usd
        sleeve["realized_pnl_usd"] = _to_float(sleeve.get("realized_pnl_usd"), 0.0) + sum(_position_metric_value(item, "pnl_realized_usd") for item in positions)
        sleeve["unrealized_pnl_usd"] = _to_float(sleeve.get("unrealized_pnl_usd"), 0.0) + sum(_position_metric_value(item, "pnl_unrealized_usd") for item in positions)
        ledger_summary = ledger.get("summary") if isinstance(ledger.get("summary"), dict) else {}
        sleeve["net_external_cashflow_usd"] = _to_float(sleeve.get("net_external_cashflow_usd"), 0.0) + _to_float(ledger_summary.get("net_external_cashflow_usd"), 0.0)
        sleeve["funding_fee_usd"] = _to_float(sleeve.get("funding_fee_usd"), 0.0) + _to_float(ledger_summary.get("funding_fee_usd"), 0.0)
        sleeve["internal_transfer_usd"] = _to_float(sleeve.get("internal_transfer_usd"), 0.0) + _to_float(ledger_summary.get("internal_transfer_usd"), 0.0)
        venues = sleeve.get("venues")
        if isinstance(venues, set):
            venues.add(str(link.get("venue") or link.get("connector_type") or "unknown"))
        pocket_breakdown = sleeve.get("pocket_breakdown") if isinstance(sleeve.get("pocket_breakdown"), dict) else {}
        for pocket in cash_vs_equivalent.get("pockets") if isinstance(cash_vs_equivalent.get("pockets"), list) else []:
            if not isinstance(pocket, dict):
                continue
            key = str(pocket.get("pocket") or "other")
            bucket = pocket_breakdown.setdefault(
                key,
                {"pocket": key, "equivalent_usd": 0.0, "raw_cash_usd": 0.0, "inventory_usd": 0.0},
            )
            bucket["equivalent_usd"] = _to_float(bucket.get("equivalent_usd"), 0.0) + _to_float(pocket.get("equivalent_usd"), 0.0)
            bucket["raw_cash_usd"] = _to_float(bucket.get("raw_cash_usd"), 0.0) + _to_float(pocket.get("raw_cash_usd"), 0.0)
            bucket["inventory_usd"] = _to_float(bucket.get("inventory_usd"), 0.0) + _to_float(pocket.get("inventory_usd"), 0.0)
        sleeve["accounts"].append(
            {
                "account_id": account_id,
                "display_name": link.get("display_name") or account_id,
                "venue": link.get("venue"),
                "connector_type": link.get("connector_type"),
                "allocation_weight": _to_float(link.get("allocation_weight"), 1.0),
                "target_cap_usd": target_cap_usd,
                "cash_vs_equivalent": cash_vs_equivalent,
                "ledger_summary": ledger_summary,
            }
        )
        total_equivalent_usd += _to_float(cash_vs_equivalent.get("total_equivalent_usd"), 0.0)
        total_raw_cash_usd += _to_float(cash_vs_equivalent.get("total_raw_cash_usd"), 0.0)
        total_target_cap_usd += target_cap_usd

    sleeve_rows: list[dict[str, Any]] = []
    for sleeve in sleeves.values():
        actual_equivalent = _to_float(sleeve.get("actual_equivalent_usd"), 0.0)
        target_cap = _to_float(sleeve.get("target_cap_usd"), 0.0)
        actual_allocation_pct = actual_equivalent / total_equivalent_usd * 100.0 if total_equivalent_usd > 0 else 0.0
        target_allocation_pct = target_cap / total_target_cap_usd * 100.0 if total_target_cap_usd > 0 else 0.0
        sleeve_rows.append(
            {
                **sleeve,
                "venues": sorted(str(item) for item in (sleeve.get("venues") or set())),
                "actual_allocation_pct": round(actual_allocation_pct, 4),
                "target_allocation_pct": round(target_allocation_pct, 4),
                "drift_pct": round(actual_allocation_pct - target_allocation_pct, 4),
                "pocket_breakdown": sorted(
                    [dict(item) for item in (sleeve.get("pocket_breakdown") or {}).values()],
                    key=lambda row: _to_float(row.get("equivalent_usd"), 0.0),
                    reverse=True,
                ),
            }
        )
    sleeve_rows.sort(key=lambda item: _to_float(item.get("actual_equivalent_usd"), 0.0), reverse=True)

    ledger_rows = _normalize_db_rows(
        fetch_all(
            """
            SELECT event_id, account_id, portfolio_id, venue, connector_type, pocket,
                   event_type, flow_direction, asset_symbol, amount_native, amount_usd,
                   raw_cash_usd, equivalent_usd, counterparty, description, external_event_id,
                   source, occurred_at, payload, created_at
            FROM capital_flow_events
            WHERE portfolio_id = %s
            ORDER BY occurred_at DESC, created_at DESC
            LIMIT 80
            """,
            (portfolio_id,),
        )
    )
    return {
        "portfolio_id": portfolio_id,
        "client_id": str(portfolio.get("client_id") or ""),
        "name": str(portfolio.get("name") or portfolio_id),
        "totals": {
            "actual_equivalent_usd": round(total_equivalent_usd, 8),
            "actual_raw_cash_usd": round(total_raw_cash_usd, 8),
            "inventory_usd": round(total_equivalent_usd - total_raw_cash_usd, 8),
            "target_cap_usd": round(total_target_cap_usd, 8),
            "account_count": len(account_ids),
        },
        "sleeves": sleeve_rows,
        "ledger_rows": ledger_rows,
    }


def _refresh_portfolio_risk_snapshots_for_account(account_id: str) -> list[dict]:
    snapshots: list[dict] = []
    for portfolio_id in _portfolio_ids_for_account(account_id):
        snapshots.append(_persist_portfolio_risk_snapshot(portfolio_id))
    return snapshots


async def _rebuild_mt5_projections(account_ids: list[str] | None = None) -> dict:
    target_rows = fetch_all(
        "SELECT account_id, mode FROM mt5_accounts WHERE (%s::text[] IS NULL OR account_id = ANY(%s)) ORDER BY updated_at DESC, account_id ASC",
        (account_ids, account_ids),
    )
    target_account_ids = [str(row.get("account_id") or "") for row in target_rows if str(row.get("account_id") or "")]
    if not target_account_ids:
        return {"status": "ok", "accounts_rebuilt": 0, "snapshots_refreshed": 0, "account_ids": []}

    execute(
        "DELETE FROM consolidated_positions WHERE source = 'mt5-bridge-normalized' AND account_id = ANY(%s)",
        (target_account_ids,),
    )
    execute(
        "DELETE FROM account_balances WHERE source = 'mt5-bridge-normalized' AND account_id = ANY(%s)",
        (target_account_ids,),
    )
    execute(
        """
        DELETE FROM portfolio_accounts pa
        USING portfolios p
        WHERE pa.portfolio_id = p.portfolio_id
          AND pa.account_id = ANY(%s)
          AND COALESCE((p.metadata->>'auto_managed')::boolean, FALSE) = TRUE
        """,
        (target_account_ids,),
    )

    refreshed_portfolio_ids: set[str] = set()
    for account_id in target_account_ids:
        _sync_accounts_registry_from_mt5(account_id)
        await _sync_mt5_account_state(account_id)
        for portfolio_id in _portfolio_ids_for_account(account_id):
            refreshed_portfolio_ids.add(portfolio_id)

    for portfolio_id in refreshed_portfolio_ids:
        _persist_portfolio_risk_snapshot(portfolio_id)

    return {
        "status": "ok",
        "accounts_rebuilt": len(target_account_ids),
        "snapshots_refreshed": len(refreshed_portfolio_ids),
        "account_ids": target_account_ids,
        "portfolio_ids": sorted(refreshed_portfolio_ids),
    }


def _resolve_websocket_user(token: str) -> dict | None:
    auth = auth_context_from_token(token)
    if not auth:
        return None

    user = fetch_one(
        "SELECT id, username, role, is_active FROM users WHERE id = %s",
        (auth.user_id,),
    )
    if not user or not user["is_active"]:
        return None

    session = fetch_one(
        "SELECT session_id, expires_at, revoked_at FROM sessions WHERE session_id = %s AND user_id = %s",
        (auth.session_id, auth.user_id),
    )
    if not session or session["revoked_at"] is not None or session["expires_at"] <= _now_utc():
        return None

    return {
        "user_id": user["id"],
        "username": user["username"],
        "role": user["role"],
        "session_id": auth.session_id,
    }


def _execution_telemetry_rows(limit: int = 50) -> list[dict]:
    safe_limit = max(1, min(limit, 500))
    rows = fetch_all(
        """
        SELECT telemetry_id, decision_id, account_id, symbol, side, lots,
               route_chosen, route_backup, route_reason, route_score, backup_score,
               quote_spread_bps, available_depth_usd,
               expected_slippage_bps, realized_slippage_bps, latency_e2e_ms,
               ts_decision, ts_intent, ts_routing, ts_broker_accept, ts_fill_partial, ts_fill_final,
               payload, created_at
        FROM execution_telemetry
        ORDER BY created_at DESC
        LIMIT %s
        """,
        (safe_limit,),
    )
    normalized: list[dict] = []
    for row in rows:
        payload = row.get("payload") if isinstance(row.get("payload"), dict) else {}
        pre_trade_memory_gate = _extract_pre_trade_memory_gate(payload)
        normalized_row = {key: _json_safe_value(value) for key, value in row.items() if key != "payload"}
        if isinstance(pre_trade_memory_gate, dict):
            normalized_row["pre_trade_memory_gate"] = _json_safe_value(pre_trade_memory_gate)
        normalized.append(normalized_row)
    return normalized


def append_audit(category: str, payload: dict) -> None:
    event = AuditEvent(category=category, payload=payload)
    AUDIT_LOG.append(event)
    execute(
        "INSERT INTO audit_events (category, payload) VALUES (%s, %s::jsonb)",
        (event.category, json_dumps(event.payload)),
    )
    prev = fetch_one("SELECT event_hash FROM audit_chain_events ORDER BY id DESC LIMIT 1")
    prev_hash = prev["event_hash"] if prev else ""
    serialized = f"{prev_hash}|{event.category}|{json_dumps(event.payload)}|{event.timestamp}"
    event_hash = hashlib.sha256(serialized.encode("utf-8")).hexdigest()
    execute(
        "INSERT INTO audit_chain_events (prev_hash, event_hash, category, payload) VALUES (%s, %s, %s, %s::jsonb)",
        (prev_hash or None, event_hash, event.category, json_dumps(event.payload)),
    )


def persist_system_mode() -> None:
    execute(
        """
        INSERT INTO system_config (config_key, config_value)
        VALUES ('system_mode', %s::jsonb)
        ON CONFLICT (config_key) DO UPDATE SET config_value = EXCLUDED.config_value, updated_at = NOW()
        """,
        (json_dumps({"mode": CURRENT_SYSTEM_MODE.value}),),
    )


def persist_intent(intent_payload: dict, status: str, risk_decision: RiskDecision | None = None) -> None:
    execute(
        """
        INSERT INTO intents (
          intent_id, strategy_id, portfolio_id, venue, instrument, side, reason_code,
          confidence, target_notional_usd, max_slippage_bps, leverage, risk_tags,
          explainability, system_mode, status, risk_decision
        ) VALUES (
          %s, %s, %s, %s, %s, %s, %s,
          %s, %s, %s, %s, %s::jsonb,
          %s::jsonb, %s, %s, %s::jsonb
        )
        ON CONFLICT (intent_id) DO UPDATE SET
                    explainability = EXCLUDED.explainability,
          status = EXCLUDED.status,
          system_mode = EXCLUDED.system_mode,
          risk_decision = EXCLUDED.risk_decision,
          updated_at = NOW()
        """,
        (
            intent_payload["intent_id"],
            intent_payload["strategy_id"],
            intent_payload["portfolio_id"],
            intent_payload["venue"],
            intent_payload["instrument"],
            intent_payload["side"],
            intent_payload["reason_code"],
            intent_payload["confidence"],
            intent_payload["target_notional_usd"],
            intent_payload["max_slippage_bps"],
            intent_payload["leverage"],
            json_dumps(intent_payload["risk_tags"]),
            json_dumps(intent_payload["explainability"]),
            CURRENT_SYSTEM_MODE.value,
            status,
            json_dumps(risk_decision.model_dump() if risk_decision else {}),
        ),
    )


@app.on_event("startup")
async def startup() -> None:
    global CURRENT_SYSTEM_MODE
    ensure_schema()
    await seed_default_users()
    _bootstrap_phase1_registry()
    existing_mt5_accounts = fetch_all("SELECT account_id FROM mt5_accounts ORDER BY updated_at DESC")
    for row in existing_mt5_accounts:
        account_id = str(row.get("account_id") or "").strip()
        if account_id:
            await _sync_mt5_account_state(account_id)
    stored = fetch_one("SELECT config_value FROM system_config WHERE config_key = 'system_mode'")
    if stored:
        CURRENT_SYSTEM_MODE = SystemMode(stored["config_value"]["mode"])
    else:
        persist_system_mode()
    _upsert_default_regime_thresholds()
    _save_kill_switch_state(_kill_switch_state())


async def seed_default_users() -> None:
    default_users = [
        # ── Internal roles (TXT team only) ────────────────────────────────
        ("admin",    _secret_env("DEFAULT_ADMIN_PASSWORD",    "admin123"),    "admin"),
        ("operator", _secret_env("DEFAULT_OPERATOR_PASSWORD", "operator123"), "operator"),
        ("viewer",   _secret_env("DEFAULT_VIEWER_PASSWORD",   "viewer123"),   "viewer"),
        # ── External / client roles ────────────────────────────────────────
        # The 'client' account is the default entry point for end-customers.
        # Its password should be overridden via DEFAULT_CLIENT_PASSWORD env var
        # or the /api/auth/client-onboard flow before going to production.
        ("client",   _secret_env("DEFAULT_CLIENT_PASSWORD",   "client123"),   "client"),
    ]
    for username, password, role in default_users:
        execute(
            """
            INSERT INTO users (username, password_hash, role, is_active)
            VALUES (%s, %s, %s, TRUE)
            ON CONFLICT (username) DO NOTHING
            """,
            (username, hash_password(password), role),
        )


def _create_session(user_id: int, user_agent: str = "", ip_address: str = "") -> tuple[str, int]:
    session_id = str(uuid4())
    token, expires_at = issue_access_token(
        user_id=user_id,
        username=str(user_id),
        role="viewer",
        session_id=session_id,
    )
    # Re-issue with true identity payload using token helper
    return session_id, expires_at


@app.post("/v1/auth/login", response_model=LoginResponse)
async def login(request: LoginRequest) -> LoginResponse:
    user = fetch_one(
        "SELECT id, username, password_hash, role, is_active, password_must_change FROM users WHERE username = %s",
        (request.username,),
    )
    if not user or not user["is_active"]:
        raise HTTPException(status_code=401, detail="Invalid credentials")
    if not verify_password(request.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    session_id = str(uuid4())
    token, expires_at = issue_access_token(
        user_id=user["id"],
        username=user["username"],
        role=user["role"],
        session_id=session_id,
    )
    execute(
        """
        INSERT INTO sessions (session_id, user_id, expires_at)
        VALUES (%s, %s, to_timestamp(%s))
        """,
        (session_id, user["id"], expires_at),
    )
    append_audit("auth_login", {"username": user["username"], "role": user["role"]})
    return LoginResponse(
        access_token=token,
        expires_at=expires_at,
        role=user["role"],
        username=user["username"],
        password_must_change=bool(user["password_must_change"]),
    )


@app.get("/v1/auth/me")
async def auth_me(auth: AuthContext = Depends(relaxed_auth)) -> dict:
    user = fetch_one(
        "SELECT password_must_change FROM users WHERE id = %s",
        (auth.user_id,),
    ) or {"password_must_change": False}
    return {
        "user_id": auth.user_id,
        "username": auth.username,
        "role": auth.role,
        "password_must_change": bool(user["password_must_change"]),
        "session_id": auth.session_id,
    }


@app.get("/v1/auth/preferences")
async def auth_preferences(auth: AuthContext = Depends(relaxed_auth)) -> dict:
    preferences, updated_at = _get_ui_preferences_row(auth.user_id)
    return {
        "user_id": auth.user_id,
        "preferences": preferences,
        "updated_at": updated_at,
    }


@app.put("/v1/auth/preferences")
async def update_auth_preferences(payload: dict, auth: AuthContext = Depends(relaxed_auth)) -> dict:
    preferences = payload.get("preferences") if isinstance(payload, dict) else {}
    base_updated_at = str(payload.get("base_updated_at") or "").strip() if isinstance(payload, dict) else ""
    client_updated_at = str(payload.get("client_updated_at") or "").strip() if isinstance(payload, dict) else ""
    current_preferences, current_updated_at = _get_ui_preferences_row(auth.user_id)
    current_dt = _parse_iso_utc(current_updated_at)
    base_dt = _parse_iso_utc(base_updated_at)
    client_dt = _parse_iso_utc(client_updated_at)
    if current_dt and base_dt and current_dt > base_dt:
        if not client_dt or client_dt <= current_dt:
            return JSONResponse(status_code=409, content={
                "status": "conflict",
                "reason": "backend_newer",
                "user_id": auth.user_id,
                "preferences": current_preferences,
                "updated_at": current_updated_at,
            })

    saved, updated_at = _save_ui_preferences(auth.user_id, preferences if isinstance(preferences, dict) else {})
    append_audit("auth_preferences_updated", {"username": auth.username, "keys": sorted(saved.keys())})
    return {
        "status": "updated",
        "user_id": auth.user_id,
        "preferences": saved,
        "updated_at": updated_at,
    }


@app.post("/v1/auth/change-password")
async def change_password(request: ChangePasswordRequest, auth: AuthContext = Depends(relaxed_auth)) -> dict:
    user = fetch_one(
        "SELECT id, username, password_hash FROM users WHERE id = %s",
        (auth.user_id,),
    )
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if not verify_password(request.old_password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Old password invalid")
    execute(
        """
        UPDATE users
        SET password_hash = %s,
            password_must_change = FALSE,
            last_password_change_at = NOW(),
            updated_at = NOW()
        WHERE id = %s
        """,
        (hash_password(request.new_password), auth.user_id),
    )
    append_audit("password_changed", {"username": auth.username})
    return {"status": "password_updated"}


@app.post("/v1/auth/logout")
async def logout(auth: AuthContext = Depends(relaxed_auth)) -> dict:
    execute(
        "UPDATE sessions SET revoked_at = NOW(), revoke_reason = 'logout' WHERE session_id = %s",
        (auth.session_id,),
    )
    append_audit("auth_logout", {"username": auth.username, "session_id": auth.session_id})
    return {"status": "logged_out"}


@app.get("/v1/auth/sessions")
async def list_my_sessions(auth: AuthContext = Depends(relaxed_auth)) -> list[dict]:
    return fetch_all(
        "SELECT session_id, issued_at, expires_at, revoked_at, revoke_reason, last_seen_at FROM sessions WHERE user_id = %s ORDER BY issued_at DESC",
        (auth.user_id,),
    )


@app.get("/v1/system/kill-switch")
async def get_kill_switch(auth: AuthContext = Depends(viewer_auth)) -> dict:
    del auth
    return {
        "status": "ok",
        "state": _kill_switch_state(),
        "thresholds": _kill_switch_thresholds(),
        "go_live_hardening": _sanitize_go_live_hardening_policy(),
    }


@app.post("/v1/system/kill-switch/activate")
async def activate_kill_switch(payload: dict | None = None, auth: AuthContext = Depends(admin_auth)) -> dict:
    global CURRENT_SYSTEM_MODE
    request_payload = payload if isinstance(payload, dict) else {}
    source = str(request_payload.get("source") or "external-watchdog").strip() or "external-watchdog"
    reason = str(request_payload.get("reason") or "manual_activation").strip() or "manual_activation"
    details = request_payload.get("payload") if isinstance(request_payload.get("payload"), dict) else {}
    state = _activate_kill_switch(
        source,
        reason,
        {
            **details,
            "by": auth.username,
        },
    )
    requested_mode = str(request_payload.get("system_mode") or "").strip().lower()
    if requested_mode in {mode.value for mode in SystemMode}:
        CURRENT_SYSTEM_MODE = SystemMode(requested_mode)
        persist_system_mode()
        append_audit("system_mode_changed", {"mode": CURRENT_SYSTEM_MODE, "source": source, "reason": reason})
    return {
        "status": "activated",
        "state": state,
        "system_mode": CURRENT_SYSTEM_MODE,
    }


@app.post("/v1/system/kill-switch/reset")
async def reset_kill_switch(auth: AuthContext = Depends(admin_auth)) -> dict:
    state = _kill_switch_state()
    state["active"] = False
    state["reason"] = "manual_reset"
    state["activated_at"] = None
    state["stats"] = {"api_errors": 0, "high_slippage_events": 0, "drawdown_intraday_usd": 0.0}
    _save_kill_switch_state(state)
    execute(
        "INSERT INTO kill_switch_events (source, reason, payload, active) VALUES (%s, %s, %s::jsonb, FALSE)",
        ("admin", "manual_reset", json_dumps({"by": auth.username})),
    )
    append_audit("kill_switch_reset", {"by": auth.username})
    return {"status": "reset", "state": state}


@app.post("/v1/admin/sessions/{session_id}/revoke")
async def revoke_session(session_id: str, auth: AuthContext = Depends(admin_auth)) -> dict:
    execute(
        "UPDATE sessions SET revoked_at = NOW(), revoke_reason = %s WHERE session_id = %s",
        (f"revoked_by:{auth.username}", session_id),
    )
    append_audit("session_revoked", {"session_id": session_id, "by": auth.username})
    return {"status": "revoked", "session_id": session_id}


@app.get("/v1/admin/users")
async def list_users(auth: AuthContext = Depends(admin_auth)) -> list[dict]:
    del auth
    return fetch_all("SELECT id, username, role, is_active, created_at FROM users ORDER BY id")


@app.post("/v1/admin/projections/mt5-rebuild")
async def rebuild_mt5_projections(payload: dict | None = None, auth: AuthContext = Depends(admin_auth)) -> dict:
    requested_ids = payload.get("account_ids") if isinstance(payload, dict) and isinstance(payload.get("account_ids"), list) else []
    account_ids = [str(item).strip() for item in requested_ids if str(item).strip()]
    result = await _rebuild_mt5_projections(account_ids or None)
    append_audit(
        "mt5_projections_rebuilt",
        {
            "by": auth.username,
            "account_ids": result.get("account_ids", []),
            "portfolio_ids": result.get("portfolio_ids", []),
        },
    )
    return result


@app.get("/health")
async def health() -> dict:
    return {
        "status": "ok",
        "service": "control-plane",
        "system_mode": CURRENT_SYSTEM_MODE,
        "audit_events": len(AUDIT_LOG),
        "pending_intents": len(PENDING_INTENTS),
    }


@app.get("/v1/audit")
async def list_audit(auth: AuthContext = Depends(viewer_auth)) -> list[dict]:
    del auth
    return fetch_all("SELECT category, payload, created_at AS timestamp FROM audit_events ORDER BY id DESC LIMIT 100")


@app.get("/v1/audit/chain")
async def list_audit_chain(limit: int = 50, auth: AuthContext = Depends(viewer_auth)) -> list[dict]:
    del auth
    safe_limit = max(1, min(limit, 500))
    return fetch_all(
        """
        SELECT id, prev_hash, event_hash, category, payload, created_at
        FROM audit_chain_events
        ORDER BY id DESC
        LIMIT %s
        """,
        (safe_limit,),
    )


@app.get("/v1/system/config")
async def get_system_config(auth: AuthContext = Depends(viewer_auth)) -> dict:
    del auth
    return {
        "system_mode": CURRENT_SYSTEM_MODE,
        "risk_gateway_url": RISK_GATEWAY_URL,
        "execution_router_url": EXECUTION_ROUTER_URL,
        "pending_intents": len(PENDING_INTENTS),
    }


@app.post("/v1/system/mode")
async def set_system_mode(request: SystemModeChangeRequest, auth: AuthContext = Depends(operator_auth)) -> dict:
    global CURRENT_SYSTEM_MODE
    del auth
    CURRENT_SYSTEM_MODE = request.mode
    persist_system_mode()
    append_audit("system_mode_changed", {"mode": CURRENT_SYSTEM_MODE})
    return {"status": "updated", "system_mode": CURRENT_SYSTEM_MODE}


@app.get("/v1/intents/pending")
async def list_pending_intents(auth: AuthContext = Depends(viewer_auth)) -> dict[str, dict]:
    del auth
    return PENDING_INTENTS


@app.get("/v1/clients")
async def list_clients(auth: AuthContext = Depends(any_read_auth)) -> list[dict]:
    if _is_internal_auth(auth):
        rows = fetch_all(
            """
            SELECT client_id, legal_name, client_type, base_currency, status, kyc_status, metadata, created_at, updated_at
            FROM clients
            ORDER BY updated_at DESC, created_at DESC
            """
        )
        return _normalize_db_rows(rows)

    rows = fetch_all(
        """
        SELECT
            c.client_id, c.legal_name, c.client_type, c.base_currency, c.status, c.kyc_status,
            c.metadata, c.created_at, c.updated_at,
            m.membership_role, m.is_primary, m.permissions
        FROM clients c
        JOIN user_client_memberships m ON m.client_id = c.client_id
        WHERE m.user_id = %s
        ORDER BY m.is_primary DESC, c.updated_at DESC, c.created_at DESC
        """,
        (auth.user_id,),
    )
    return _normalize_db_rows(rows)


@app.post("/v1/clients")
async def create_client(request: ClientCreateRequest, auth: AuthContext = Depends(operator_auth)) -> dict:
    inserted = execute_rowcount(
        """
        INSERT INTO clients (client_id, legal_name, client_type, base_currency, status, kyc_status, metadata)
        VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb)
        ON CONFLICT (client_id) DO NOTHING
        """,
        (
            request.client_id,
            request.legal_name,
            request.client_type,
            request.base_currency,
            request.status,
            request.kyc_status,
            json_dumps(request.metadata),
        ),
    )
    if inserted == 0:
        raise HTTPException(status_code=409, detail="Client already exists")
    created = fetch_one(
        "SELECT client_id, legal_name, client_type, base_currency, status, kyc_status, metadata, created_at, updated_at FROM clients WHERE client_id = %s",
        (request.client_id,),
    )
    append_audit("client_created", {"client_id": request.client_id, "by": auth.username})
    return _normalize_db_row(created) or {}


@app.get("/v1/users/me/memberships")
async def list_my_memberships(auth: AuthContext = Depends(any_read_auth)) -> dict:
    rows = fetch_all(
        """
        SELECT
            m.user_id,
            m.client_id,
            m.membership_role,
            m.is_primary,
            m.permissions,
            m.created_at,
            c.legal_name,
            c.client_type,
            c.base_currency,
            c.status AS client_status
        FROM user_client_memberships m
        JOIN clients c ON c.client_id = m.client_id
        WHERE m.user_id = %s
        ORDER BY m.is_primary DESC, m.created_at ASC
        """,
        (auth.user_id,),
    )
    return {
        "items": _normalize_db_rows(rows),
        "total": len(rows),
    }


@app.post("/v1/clients/{client_id}/memberships")
async def create_client_membership(
    client_id: str,
    request: UserClientMembershipCreateRequest,
    auth: AuthContext = Depends(operator_auth),
) -> dict:
    _assert_client_visible(auth, client_id)
    user = fetch_one("SELECT id, username, role FROM users WHERE id = %s", (request.user_id,))
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    inserted = execute_rowcount(
        """
        INSERT INTO user_client_memberships (user_id, client_id, membership_role, is_primary, permissions)
        VALUES (%s, %s, %s, %s, %s::jsonb)
        ON CONFLICT (user_id, client_id, membership_role) DO NOTHING
        """,
        (request.user_id, client_id, request.membership_role, request.is_primary, json_dumps(request.permissions)),
    )
    if inserted == 0:
        raise HTTPException(status_code=409, detail="Membership already exists")
    created = fetch_one(
        """
        SELECT user_id, client_id, membership_role, is_primary, permissions, created_at
        FROM user_client_memberships
        WHERE user_id = %s AND client_id = %s AND membership_role = %s
        """,
        (request.user_id, client_id, request.membership_role),
    )
    append_audit(
        "client_membership_created",
        {"client_id": client_id, "user_id": request.user_id, "membership_role": request.membership_role, "by": auth.username},
    )
    return _normalize_db_row(created) or {}


@app.get("/v1/accounts")
async def list_accounts(
    client_id: str = "",
    portfolio_id: str = "",
    venue: str = "",
    mode: str = "",
    status: str = "",
    auth: AuthContext = Depends(any_read_auth),
) -> list[dict]:
    params: list[Any] = []
    where_clauses: list[str] = []
    visible_client_ids = _visible_client_ids(auth)
    if client_id:
        _assert_client_visible(auth, client_id)
        where_clauses.append("accounts.client_id = %s")
        params.append(client_id)
    elif visible_client_ids is not None:
        if not visible_client_ids:
            return []
        where_clauses.append("accounts.client_id = ANY(%s)")
        params.append(visible_client_ids)
    if portfolio_id:
        _assert_portfolio_visible(auth, portfolio_id)
        where_clauses.append("EXISTS (SELECT 1 FROM portfolio_accounts pa WHERE pa.account_id = accounts.account_id AND pa.portfolio_id = %s)")
        params.append(portfolio_id)
    if venue:
        where_clauses.append("accounts.venue = %s")
        params.append(venue)
    if mode:
        where_clauses.append("accounts.mode = %s")
        params.append(mode)
    if status:
        where_clauses.append("accounts.status = %s")
        params.append(status)
    where_sql = f"WHERE {' AND '.join(where_clauses)}" if where_clauses else ""
    rows = fetch_all(
        f"""
        SELECT
            LOWER(BTRIM(accounts.account_id)) AS account_id, accounts.client_id, accounts.account_type, accounts.venue, accounts.connector_type,
            accounts.mode, accounts.base_currency, accounts.status, LOWER(BTRIM(accounts.external_ref)) AS external_ref, accounts.display_name,
            accounts.metadata, accounts.created_at, accounts.updated_at,
            accounts.connector_broker, accounts.connector_server, accounts.connector_login, accounts.connector_status,
            balance_summary.equity_usd AS latest_equity_usd,
            balance_summary.as_of AS latest_balance_as_of,
            position_summary.open_positions,
            position_summary.gross_exposure_usd,
            position_summary.net_exposure_usd,
            portfolio_summary.portfolio_id
        FROM v_accounts_canonical AS accounts
        LEFT JOIN (
            SELECT latest.account_id, SUM(latest.equity_usd) AS equity_usd, MAX(latest.as_of) AS as_of
            FROM (
                SELECT DISTINCT ON (ab.account_id, ab.asset_symbol)
                    ab.account_id, ab.asset_symbol, ab.equity_usd, ab.as_of
                FROM account_balances ab
                ORDER BY ab.account_id, ab.asset_symbol, ab.as_of DESC, ab.id DESC
            ) latest
            GROUP BY latest.account_id
        ) AS balance_summary ON LOWER(BTRIM(balance_summary.account_id)) = LOWER(BTRIM(accounts.account_id))
        LEFT JOIN (
            SELECT latest.account_id,
                   COUNT(*) AS open_positions,
                   SUM(ABS(latest.notional_usd)) AS gross_exposure_usd,
                   SUM(CASE WHEN latest.side = 'short' THEN -ABS(latest.notional_usd) ELSE ABS(latest.notional_usd) END) AS net_exposure_usd
            FROM (
                SELECT DISTINCT ON (cp.position_id)
                    cp.position_id, cp.account_id, cp.side, cp.notional_usd, cp.as_of
                FROM consolidated_positions cp
                ORDER BY cp.position_id, cp.as_of DESC
            ) latest
            GROUP BY latest.account_id
        ) AS position_summary ON LOWER(BTRIM(position_summary.account_id)) = LOWER(BTRIM(accounts.account_id))
        LEFT JOIN (
            SELECT pa.account_id, MIN(pa.portfolio_id) AS portfolio_id
            FROM portfolio_accounts pa
            WHERE pa.status = 'active'
            GROUP BY pa.account_id
        ) AS portfolio_summary ON LOWER(BTRIM(portfolio_summary.account_id)) = LOWER(BTRIM(accounts.account_id))
        {where_sql}
        ORDER BY accounts.updated_at DESC, accounts.created_at DESC
        """,
        tuple(params),
    )
    return _normalize_db_rows(rows)


@app.post("/v1/accounts")
async def create_account(request: AccountCreateRequest, auth: AuthContext = Depends(operator_auth)) -> dict:
    _assert_client_visible(auth, request.client_id)
    account_id = _normalize_account_id(request.account_id)
    external_ref = _normalize_account_id(request.external_ref) or None
    inserted = execute_rowcount(
        """
        INSERT INTO accounts_registry (
            account_id, client_id, account_type, venue, connector_type, mode,
            base_currency, status, external_ref, display_name, metadata
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)
        ON CONFLICT (account_id) DO NOTHING
        """,
        (
            account_id,
            request.client_id,
            request.account_type,
            request.venue,
            request.connector_type,
            request.mode,
            request.base_currency,
            request.status,
            external_ref,
            request.display_name,
            json_dumps(request.metadata),
        ),
    )
    if inserted == 0:
        raise HTTPException(status_code=409, detail="Account already exists")
    if request.client_id == _PHASE1_INTERNAL_CLIENT_ID:
        _sync_internal_portfolio_accounts(account_id)
    created = fetch_one(
        "SELECT account_id, client_id, account_type, venue, connector_type, mode, base_currency, status, external_ref, display_name, metadata, created_at, updated_at FROM accounts_registry WHERE account_id = %s",
        (account_id,),
    )
    append_audit("account_created", {"account_id": account_id, "client_id": request.client_id, "by": auth.username})
    return _normalize_db_row(created) or {}


@app.delete("/v1/accounts/{account_id}")
async def delete_account(account_id: str, auth: AuthContext = Depends(operator_auth)) -> dict:
    account = _assert_account_visible(auth, account_id)
    deleted = execute_rowcount(
        "DELETE FROM accounts_registry WHERE account_id = %s",
        (account_id,),
    )
    if deleted == 0:
        raise HTTPException(status_code=404, detail="Account not found")
    append_audit(
        "account_deleted",
        {
            "account_id": account_id,
            "client_id": str(account.get("client_id") or ""),
            "connector_type": str(account.get("connector_type") or ""),
            "by": auth.username,
        },
    )
    return {"status": "ok", "account_id": account_id}


@app.post("/v1/accounts/{account_id}/sync")
async def sync_account(account_id: str, auth: AuthContext = Depends(operator_auth)) -> dict:
    account = _assert_account_visible(auth, account_id)
    connector_type = str(account.get("connector_type") or "").strip().lower()
    synced_rows: list[dict] | int | None = None
    normalized_state: dict | None = None

    if connector_type == "mt5":
        synced_rows = _sync_accounts_registry_from_mt5(account_id)
        normalized_state = await _sync_mt5_account_state(account_id)
    elif connector_type:
        try:
            normalized_state = await _sync_supported_connector_account_state(account_id, account)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except RuntimeError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    synced_portfolio_rows = _sync_internal_portfolio_accounts(account_id)
    return {
        "status": str(normalized_state.get("status") or "ok") if isinstance(normalized_state, dict) else "ok",
        "account": _normalize_db_row(account),
        "synced_rows": synced_rows,
        "synced_portfolio_rows": synced_portfolio_rows,
        "normalized_state": normalized_state,
        "balances": _latest_account_balances(account_id),
        "positions": _latest_account_positions(account_id),
    }


@app.get("/v1/accounts/{account_id}/balances")
async def list_account_balances(account_id: str, auth: AuthContext = Depends(any_read_auth)) -> list[dict]:
    _assert_account_visible(auth, account_id)
    return _latest_account_balances(account_id)


@app.get("/v1/accounts/{account_id}/positions")
async def list_account_positions(account_id: str, auth: AuthContext = Depends(any_read_auth)) -> list[dict]:
    _assert_account_visible(auth, account_id)
    return _latest_account_positions(account_id)


@app.get("/v1/accounts/{account_id}/capital-flows")
async def list_account_capital_flows(account_id: str, limit: int = 80, auth: AuthContext = Depends(any_read_auth)) -> dict:
    _assert_account_visible(auth, account_id)
    return _account_capital_ledger(account_id, limit=limit)


@app.get("/v1/internal/accounts/{account_id}/verification")
async def internal_account_verification(account_id: str, auth: AuthContext = Depends(operator_auth)) -> dict:
    account = _assert_account_visible(auth, account_id)
    mt5_account = fetch_one(
        "SELECT account_id, broker, server, login, mode, status, metadata, created_at, updated_at FROM mt5_accounts WHERE account_id = %s",
        (account_id,),
    )
    connector_account = _find_connector_account_for_canonical_account(account)
    connector_view = _connector_account_public_view(connector_account)
    portfolio_links = _normalize_db_rows(
        fetch_all(
            """
            SELECT pa.portfolio_id, pa.allocation_weight, pa.status, p.client_id, p.name, p.metadata
            FROM portfolio_accounts pa
            JOIN portfolios p ON p.portfolio_id = pa.portfolio_id
            WHERE pa.account_id = %s
            ORDER BY pa.portfolio_id ASC
            """,
            (account_id,),
        )
    )
    latest_snapshots = _normalize_db_rows(
        fetch_all(
            """
            SELECT DISTINCT ON (portfolio_id)
                snapshot_id, portfolio_id, as_of, gross_exposure_usd, net_exposure_usd, equity_usd, payload
            FROM portfolio_snapshots
            WHERE portfolio_id = ANY(%s)
            ORDER BY portfolio_id, as_of DESC, snapshot_id DESC
            """,
            ([str(item.get("portfolio_id") or "") for item in portfolio_links if str(item.get("portfolio_id") or "")],),
        ) if portfolio_links else []
    )
    balances = _latest_account_balances(account_id)
    positions = _latest_account_positions(account_id)
    cash_vs_equivalent = _cash_vs_equivalent_summary(balances)
    pocket_totals = _summarize_balance_pockets(balances)
    notes: list[str] = []
    total_equivalent = _to_float(cash_vs_equivalent.get("total_equivalent_usd"), 0.0)
    total_raw_cash = _to_float(cash_vs_equivalent.get("total_raw_cash_usd"), 0.0)
    if total_equivalent > total_raw_cash + 0.5:
        notes.append(
            f"Le compte porte {total_raw_cash:.2f} USD de cash brut visible pour {total_equivalent:.2f} USD de valeur plateforme equivalente. Le delta correspond a de l'inventaire non-cash ou a du collateral valorise."
        )
    # BingX-specific diagnostic notes
    connector_type = str(account.get("connector_type") or "").strip().lower()
    if connector_type == "bingx":
        balance_sources = {str(b.get("source") or "") for b in balances}
        # Fund pocket
        has_fund = any("bingx-fund" in src for src in balance_sources)
        if not has_fund:
            notes.append(
                "Poche Fund (epargne/earn BingX) : verifiee via /openApi/fund/v1/account/balance, aucun actif trouve. "
                "Soit le compte n'a pas de position en epargne active, soit la cle API ne dispose pas de la permission 'Account Balance' pour ce sous-compte."
            )
        # Pending orders: freezedMargin > 0 but no open positions
        if not positions:
            futures_frozen = sum(
                _to_float(
                    (b.get("payload") or {}).get("freezedMargin") if isinstance(b.get("payload"), dict) else None,
                    0.0,
                )
                for b in balances
                if str(b.get("source") or "").startswith("bingx-futures")
            )
            if futures_frozen > 0.001:
                notes.append(
                    f"Marge gelee futures : {futures_frozen:.4f} USDT sans position ouverte detectee. "
                    "Cela indique probablement un ou plusieurs ordres limites en attente d'execution. "
                    "La marge est reservee mais aucun contrat n'est ouvert (aucune 'paire' ouverte)."
                )
    # BingX: fetch live open orders (best-effort, not stored in DB)
    open_orders: list[dict] = []
    if connector_type == "bingx":
        try:
            _, bingx_secret = _bingx_secret_payload_for_account(account_id, require_trade=False)
            raw_oo = await _bingx_signed_get(bingx_secret, "/openApi/swap/v2/trade/openOrders", {"recvWindow": 60000})
            open_orders = _normalize_bingx_open_orders(
                _bingx_extract_dict_items(raw_oo, "orders", "data", "list"),
                _now_utc().isoformat(),
            )
            if open_orders:
                notes.append(
                    f"{len(open_orders)} ordre(s) limite(s) en attente sur USDT-M perpetuels : "
                    + ", ".join(
                        f"{o.get('side')} {o.get('quantity')} {o.get('symbol')} @ {o.get('price')}"
                        for o in open_orders
                    )
                    + ". La marge gelee correspond a ces ordres non executes."
                )
        except Exception:
            pass  # open orders are best-effort in verification
    normalized_state = {
        "status": "ok",
        "as_of": max([str(item.get("as_of") or "") for item in balances if str(item.get("as_of") or "")], default=_now_utc().isoformat()),
        "pocket_totals": pocket_totals,
        "cash_vs_equivalent": cash_vs_equivalent,
        "pocket_views": cash_vs_equivalent.get("pockets", []),
        "notes": notes,
    }
    return {
        "status": "ok",
        "account": _normalize_db_row(account),
        "mt5_account": _normalize_db_row(mt5_account),
        "connector_account": connector_view,
        "balances": balances,
        "positions": positions,
        "open_orders": open_orders,
        "portfolio_links": portfolio_links,
        "latest_portfolio_snapshots": latest_snapshots,
        "normalized_state": normalized_state,
        "cash_vs_equivalent": cash_vs_equivalent,
        "pocket_views": cash_vs_equivalent.get("pockets", []),
        "capital_ledger": _account_capital_ledger(account_id),
    }


@app.get("/v1/portfolios")
async def list_portfolios(auth: AuthContext = Depends(any_read_auth)) -> list[dict]:
    visible_client_ids = _visible_client_ids(auth)
    if visible_client_ids is not None and not visible_client_ids:
        return []
    rows = fetch_all(
        """
        SELECT portfolio_id, client_id, name, base_currency, mandate_type, risk_profile, benchmark_symbol, status, metadata, created_at, updated_at
        FROM portfolios
        WHERE (%s::text[] IS NULL OR client_id = ANY(%s))
        ORDER BY updated_at DESC, created_at DESC
        """,
        (visible_client_ids, visible_client_ids),
    )
    return _normalize_db_rows(rows)


@app.post("/v1/portfolios")
async def create_portfolio(request: PortfolioCreateRequest, auth: AuthContext = Depends(operator_auth)) -> dict:
    _assert_client_visible(auth, request.client_id)
    inserted = execute_rowcount(
        """
        INSERT INTO portfolios (
            portfolio_id, client_id, name, base_currency, mandate_type,
            risk_profile, benchmark_symbol, status, metadata
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)
        ON CONFLICT (portfolio_id) DO NOTHING
        """,
        (
            request.portfolio_id,
            request.client_id,
            request.name,
            request.base_currency,
            request.mandate_type,
            request.risk_profile,
            request.benchmark_symbol,
            request.status,
            json_dumps(request.metadata),
        ),
    )
    if inserted == 0:
        raise HTTPException(status_code=409, detail="Portfolio already exists")
    created = fetch_one(
        "SELECT portfolio_id, client_id, name, base_currency, mandate_type, risk_profile, benchmark_symbol, status, metadata, created_at, updated_at FROM portfolios WHERE portfolio_id = %s",
        (request.portfolio_id,),
    )
    append_audit("portfolio_created", {"portfolio_id": request.portfolio_id, "client_id": request.client_id, "by": auth.username})
    return _normalize_db_row(created) or {}


@app.post("/v1/portfolios/{portfolio_id}/accounts")
async def attach_account_to_portfolio(
    portfolio_id: str,
    request: PortfolioAccountAttachRequest,
    auth: AuthContext = Depends(operator_auth),
) -> dict:
    portfolio = _assert_portfolio_visible(auth, portfolio_id)
    account = _assert_account_visible(auth, request.account_id)
    if str(portfolio["client_id"]) != str(account["client_id"]):
        raise HTTPException(status_code=400, detail="Account and portfolio must belong to the same client")
    execute(
        """
        INSERT INTO portfolio_accounts (portfolio_id, account_id, allocation_weight, allocation_cap_usd, status)
        VALUES (%s, %s, %s, %s, %s)
        ON CONFLICT (portfolio_id, account_id) DO UPDATE SET
            allocation_weight = EXCLUDED.allocation_weight,
            allocation_cap_usd = EXCLUDED.allocation_cap_usd,
            status = EXCLUDED.status
        """,
        (portfolio_id, request.account_id, request.allocation_weight, request.allocation_cap_usd, request.status),
    )
    link = fetch_one(
        "SELECT portfolio_id, account_id, allocation_weight, allocation_cap_usd, status FROM portfolio_accounts WHERE portfolio_id = %s AND account_id = %s",
        (portfolio_id, request.account_id),
    )
    append_audit(
        "portfolio_account_attached",
        {"portfolio_id": portfolio_id, "account_id": request.account_id, "by": auth.username},
    )
    return _normalize_db_row(link) or {}


@app.get("/v1/portfolios/{portfolio_id}/state")
async def get_portfolio_state(portfolio_id: str, auth: AuthContext = Depends(any_read_auth)) -> dict:
    _assert_portfolio_visible(auth, portfolio_id)
    return _portfolio_state_snapshot(portfolio_id)


@app.get("/v1/portfolios/{portfolio_id}/risk")
async def get_portfolio_risk(portfolio_id: str, auth: AuthContext = Depends(any_read_auth)) -> dict:
    _assert_portfolio_visible(auth, portfolio_id)
    latest = _latest_portfolio_risk_snapshot(portfolio_id)
    return latest or _persist_portfolio_risk_snapshot(portfolio_id)


@app.get("/v1/portfolios/{portfolio_id}/capital-integration")
async def get_portfolio_capital_integration(portfolio_id: str, auth: AuthContext = Depends(any_read_auth)) -> dict:
    _assert_portfolio_visible(auth, portfolio_id)
    return _portfolio_capital_integration(portfolio_id)


@app.get("/v1/performance/summary")
async def get_performance_summary(
    scope_type: str,
    scope_id: str,
    start: str | None = None,
    end: str | None = None,
    auth: AuthContext = Depends(any_read_auth),
) -> dict:
    del auth
    start_dt, end_dt = _coerce_period_bounds(start, end)
    return _performance_summary(scope_type, scope_id, start_dt, end_dt)


@app.get("/v1/performance/timeseries")
async def get_performance_timeseries(
    scope_type: str,
    scope_id: str,
    bucket_granularity: str = "1d",
    start: str | None = None,
    end: str | None = None,
    auth: AuthContext = Depends(any_read_auth),
) -> dict:
    del auth
    start_dt, end_dt = _coerce_period_bounds(start, end)
    return {
        "scope_type": scope_type,
        "scope_id": scope_id,
        "bucket_granularity": bucket_granularity,
        "period_start": start_dt.isoformat(),
        "period_end": end_dt.isoformat(),
        "points": _performance_timeseries(scope_type, scope_id, start_dt, end_dt, bucket_granularity),
    }


@app.get("/v1/performance/attribution")
async def get_performance_attribution(
    scope_type: str,
    scope_id: str,
    group_by: str = "strategy,symbol,venue",
    start: str | None = None,
    end: str | None = None,
    auth: AuthContext = Depends(any_read_auth),
) -> dict:
    del auth
    start_dt, end_dt = _coerce_period_bounds(start, end)
    return {
        "scope_type": scope_type,
        "scope_id": scope_id,
        "group_by": [alias for alias, _ in _performance_group_dimensions(group_by)],
        "period_start": start_dt.isoformat(),
        "period_end": end_dt.isoformat(),
        "rows": _performance_attribution(scope_type, scope_id, start_dt, end_dt, group_by=group_by),
    }


@app.get("/v1/execution/pnl-analyzer")
async def get_execution_pnl_analyzer(
    scope_type: str,
    scope_id: str,
    limit: int = 50,
    confidence_flag_threshold: float = 0.7,
    start: str | None = None,
    end: str | None = None,
    auth: AuthContext = Depends(any_read_auth),
) -> dict[str, Any]:
    del auth
    start_dt, end_dt = _coerce_period_bounds(start, end)
    return _execution_pnl_analyzer(
        scope_type,
        scope_id,
        start_dt,
        end_dt,
        trade_limit=limit,
        confidence_flag_threshold=confidence_flag_threshold,
    )


@app.get("/v1/investor-reports")
async def list_investor_reports(
    client_id: str = "",
    portfolio_id: str = "",
    limit: int = 12,
    auth: AuthContext = Depends(any_read_auth),
) -> dict:
    resolved_client_id = client_id.strip() or None
    resolved_portfolio_id = portfolio_id.strip() or None
    where_clauses: list[str] = []
    params: list[Any] = []
    if resolved_portfolio_id:
        portfolio = _assert_portfolio_visible(auth, resolved_portfolio_id)
        if resolved_client_id and resolved_client_id != str(portfolio["client_id"]):
            raise HTTPException(status_code=400, detail="client_id does not match portfolio_id")
        resolved_client_id = str(portfolio["client_id"])
        where_clauses.append("portfolio_id = %s")
        params.append(resolved_portfolio_id)
    if resolved_client_id:
        _assert_client_visible(auth, resolved_client_id)
        where_clauses.append("client_id = %s")
        params.append(resolved_client_id)
    if not where_clauses:
        raise HTTPException(status_code=400, detail="client_id or portfolio_id is required")
    rows = _normalize_db_rows(
        fetch_all(
            f"""
            SELECT report_id, client_id, portfolio_id, report_month, report_type, status, storage_path, summary, created_at, published_at
            FROM investor_reports
            WHERE {' AND '.join(where_clauses)}
            ORDER BY report_month DESC, created_at DESC
            LIMIT %s
            """,
            tuple([*params, max(1, min(100, int(limit)))]),
        )
    )
    return {
        "items": rows,
        "total": len(rows),
    }


@app.post("/v1/investor-reports")
async def generate_investor_report(payload: dict, auth: AuthContext = Depends(operator_auth)) -> dict:
    client_id = str(payload.get("client_id") or "").strip() or None
    portfolio_id = str(payload.get("portfolio_id") or "").strip() or None
    strategy_id = str(payload.get("strategy_id") or "").strip() or None
    report_month = str(payload.get("report_month") or "").strip() or None
    report_type = str(payload.get("report_type") or "monthly").strip().lower()
    status = str(payload.get("status") or "published").strip().lower()
    if report_type not in {"monthly", "quarterly", "custom"}:
        raise HTTPException(status_code=400, detail="unsupported report_type")
    if status not in {"draft", "published", "archived"}:
        raise HTTPException(status_code=400, detail="unsupported status")
    if portfolio_id:
        portfolio = _assert_portfolio_visible(auth, portfolio_id)
        if client_id and client_id != str(portfolio["client_id"]):
            raise HTTPException(status_code=400, detail="client_id does not match portfolio_id")
        client_id = str(portfolio["client_id"])
    if client_id:
        _assert_client_visible(auth, client_id)
    if not client_id:
        raise HTTPException(status_code=400, detail="client_id or portfolio_id is required")
    report = _upsert_investor_report(client_id, portfolio_id, report_month, report_type, status, strategy_id=strategy_id)
    append_audit(
        "investor_report_generated",
        {
            "report_id": report.get("report_id"),
            "client_id": client_id,
            "portfolio_id": portfolio_id,
            "strategy_id": strategy_id,
            "report_month": report.get("report_month"),
            "report_type": report_type,
            "status": status,
            "by": auth.username,
        },
    )
    return report


@app.get("/v1/strategies")
async def list_strategies(auth: AuthContext = Depends(viewer_auth)) -> list[dict]:
    del auth
    return fetch_all(
        """
        SELECT strategy_id, name, market, setup_type, notes, current_level, status, latest_metrics, created_by, created_at, updated_at
        FROM strategies
        ORDER BY updated_at DESC
        """
    )


@app.get("/v1/strategies/self-learning-v4")
async def get_self_learning_v4_state(
    account_id: str,
    symbol: str,
    timeframe: str,
    auth: AuthContext = Depends(relaxed_auth),
) -> dict:
    state, updated_at = _get_self_learning_v4_state(auth.user_id, account_id, symbol, timeframe)
    return {
        "status": "ok",
        "state": state,
        "updated_at": updated_at,
    }


@app.put("/v1/strategies/self-learning-v4")
async def put_self_learning_v4_state(payload: dict, auth: AuthContext = Depends(relaxed_auth)) -> dict:
    state, updated_at = _save_self_learning_v4_state(auth.user_id, payload)
    append_audit(
        "self_learning_v4_state_upserted",
        {
            "user_id": auth.user_id,
            "account_id": state.get("accountId"),
            "symbol": state.get("symbol"),
            "timeframe": state.get("timeframe"),
        },
    )
    return {
        "status": "ok",
        "state": state,
        "updated_at": updated_at,
    }


@app.get("/v1/strategies/self-learning-v4/scopes")
async def list_self_learning_v4_scopes(
    account_id: str = "",
    symbol: str = "",
    timeframe: str = "",
    limit: int = 120,
    auth: AuthContext = Depends(relaxed_auth),
) -> dict:
    items = _list_self_learning_v4_scopes(
        user_id=auth.user_id,
        account_id=account_id,
        symbol=symbol,
        timeframe=timeframe,
        limit=limit,
    )
    return {
        "status": "ok",
        "items": items,
        "total": len(items),
    }

@app.get("/v1/strategies/self-learning-v5")
async def get_self_learning_v5_state(
    account_id: str,
    symbol: str,
    timeframe: str,
    auth: AuthContext = Depends(relaxed_auth),
) -> dict:
    state, updated_at = _get_self_learning_v5_state(auth.user_id, account_id, symbol, timeframe)
    return {
        "status": "ok",
        "state": state,
        "updated_at": updated_at,
    }

@app.put("/v1/strategies/self-learning-v5")
async def put_self_learning_v5_state(payload: dict, auth: AuthContext = Depends(relaxed_auth)) -> dict:
    state, updated_at = _save_self_learning_v5_state(auth.user_id, payload)
    append_audit(
        "self_learning_v5_state_upserted",
        {
            "user_id": auth.user_id,
            "account_id": state.get("accountId"),
            "symbol": state.get("symbol"),
            "timeframe": state.get("timeframe"),
            "best_strategy_id": state.get("snapshot", {}).get("optimizer", {}).get("bestStrategyId") if isinstance(state.get("snapshot"), dict) else None,
        },
    )
    return {
        "status": "ok",
        "state": state,
        "updated_at": updated_at,
    }

@app.get("/v1/strategies/self-learning-v5/scopes")
async def list_self_learning_v5_scopes(
    account_id: str = "",
    symbol: str = "",
    timeframe: str = "",
    limit: int = 120,
    auth: AuthContext = Depends(relaxed_auth),
) -> dict:
    items = _list_self_learning_v5_scopes(
        user_id=auth.user_id,
        account_id=account_id,
        symbol=symbol,
        timeframe=timeframe,
        limit=limit,
    )
    return {
        "status": "ok",
        "items": items,
        "total": len(items),
    }


@app.post("/v1/strategies/self-learning-v5/promote")
async def promote_self_learning_v5_state(payload: dict, auth: AuthContext = Depends(operator_auth)) -> dict:
    state, updated_at, observation, audit_payload = _promote_self_learning_v5_state(auth.user_id, payload, auth.username)
    return {
        "status": "ok",
        "state": state,
        "updated_at": updated_at,
        "observation": observation,
        "audit": audit_payload,
    }


@app.post("/v1/strategies")
async def create_strategy(request: StrategyCreateRequest, auth: AuthContext = Depends(operator_auth)) -> dict:
    execute(
        """
        INSERT INTO strategies (strategy_id, name, market, setup_type, notes, current_level, status, latest_metrics, created_by)
        VALUES (%s, %s, %s, %s, %s, 0, 'active', '{}'::jsonb, %s)
        ON CONFLICT (strategy_id) DO NOTHING
        """,
        (request.strategy_id, request.name, request.market, request.setup_type, request.notes, auth.username),
    )
    append_audit("strategy_created", {"strategy_id": request.strategy_id, "by": auth.username})
    created = fetch_one("SELECT * FROM strategies WHERE strategy_id = %s", (request.strategy_id,))
    if not created:
        raise HTTPException(status_code=409, detail="Strategy already exists")
    return created


@app.post("/v1/strategies/{strategy_id}/promote")
async def promote_strategy(strategy_id: str, request: StrategyPromotionRequest, auth: AuthContext = Depends(operator_auth)) -> dict:
    strategy = fetch_one("SELECT strategy_id, current_level FROM strategies WHERE strategy_id = %s", (strategy_id,))
    if not strategy:
        raise HTTPException(status_code=404, detail="Strategy not found")
    current_level = int(strategy["current_level"])
    if request.to_level != current_level + 1:
        raise HTTPException(status_code=400, detail="Promotion must be sequential (Lx to Lx+1)")

    metrics = request.metrics or {}
    sample_count = int(metrics.get("sample_count", 0))
    oos_sharpe = float(metrics.get("oos_sharpe", 0.0))
    fee_impact_bps = float(metrics.get("fee_impact_bps", 9999.0))
    slippage_bps = float(metrics.get("slippage_bps", 9999.0))

    failures: list[str] = []
    if sample_count < 200:
        failures.append("sample_count_below_min_200")
    if oos_sharpe < 1.0:
        failures.append("oos_sharpe_below_1_0")
    if fee_impact_bps > 25:
        failures.append("fee_impact_bps_above_25")
    if slippage_bps > 20:
        failures.append("slippage_bps_above_20")
    if failures:
        raise HTTPException(status_code=400, detail={"promotion_blocked": failures})

    execute(
        """
        INSERT INTO strategy_promotions (strategy_id, from_level, to_level, approved_by, rationale, metrics)
        VALUES (%s, %s, %s, %s, %s, %s::jsonb)
        """,
        (strategy_id, current_level, request.to_level, auth.username, request.rationale, json_dumps(request.metrics)),
    )
    execute(
        """
        UPDATE strategies
        SET current_level = %s,
            latest_metrics = %s::jsonb,
            updated_at = NOW()
        WHERE strategy_id = %s
        """,
        (request.to_level, json_dumps(request.metrics), strategy_id),
    )
    append_audit(
        "strategy_promoted",
        {
            "strategy_id": strategy_id,
            "from_level": current_level,
            "to_level": request.to_level,
            "approved_by": auth.username,
        },
    )
    return fetch_one("SELECT * FROM strategies WHERE strategy_id = %s", (strategy_id,)) or {}


@app.get("/v1/dashboard/overview")
async def dashboard_overview(auth: AuthContext = Depends(viewer_auth)) -> dict:
    del auth
    policy = await fetch_policy()
    positions = fetch_all(
        """
        SELECT COALESCE(SUM(CASE WHEN side = 'buy' THEN filled_notional_usd ELSE -filled_notional_usd END), 0) AS net_exposure_usd
        FROM orders
        """
    )
    orders = fetch_one("SELECT COUNT(*) AS count FROM orders") or {"count": 0}
    return {
        "system_mode": CURRENT_SYSTEM_MODE.value,
        "pending_intents": len(PENDING_INTENTS),
        "orders_count": orders["count"],
        "net_exposure_usd": positions[0]["net_exposure_usd"] if positions else 0,
        "policy_version": policy["policy_version"],
        "paper_only": policy["paper_only"],
    }


@app.get("/v1/market/quotes")
async def proxy_market_quotes(auth: AuthContext = Depends(any_read_auth)) -> list[dict]:
    del auth
    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.get(f"{MARKET_DATA_URL}/v1/quotes")
        return _proxy_json_response(response)


@app.get("/v1/market/venues/telemetry")
async def proxy_market_venue_telemetry(auth: AuthContext = Depends(any_read_auth)) -> dict:
    del auth
    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.get(f"{MARKET_DATA_URL}/v1/market/venues/telemetry")
        return _proxy_json_response(response)


@app.get("/v1/routes/venues/telemetry")
async def proxy_route_venue_telemetry(
    lookback_minutes: int = 120,
    auth: AuthContext = Depends(any_read_auth),
) -> dict:
    del auth
    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.get(
            f"{EXECUTION_ROUTER_URL}/v1/routes/venues/telemetry",
            params={"lookback_minutes": max(5, min(lookback_minutes, 1440))},
        )
        return _proxy_json_response(response)


@app.get("/v1/execution/optimizer/live-state")
async def proxy_execution_optimizer_live_state(auth: AuthContext = Depends(any_read_auth)) -> dict:
    del auth
    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.get(f"{EXECUTION_ROUTER_URL}/v1/execution-optimizer/live-state")
        return _proxy_json_response(response)


async def _fetch_market_quotes() -> list[dict]:
    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.get(f"{MARKET_DATA_URL}/v1/quotes")
        return response.json()


@app.get("/v1/market/ohlcv")
async def proxy_market_ohlcv(
    instrument: str,
    venue: str = "binance-public",
    timeframe: str = "1m",
    limit: int = 200,
    auth: AuthContext = Depends(any_read_auth),
) -> list[dict]:
    del auth
    market_symbol = _market_data_symbol(venue, instrument)
    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.get(
            f"{MARKET_DATA_URL}/v1/market/ohlcv",
            params={"instrument": market_symbol, "venue": venue, "timeframe": timeframe, "limit": max(1, min(limit, 1000))},
        )
        return _proxy_json_response(response)


@app.post("/v1/system/market/ohlcv/backfill-cfd")
async def proxy_market_ohlcv_backfill_cfd(payload: dict | None = None, auth: AuthContext = Depends(operator_auth)) -> dict:
    del auth
    body = payload if isinstance(payload, dict) else {}
    last_error = "market-data backfill unavailable"
    for attempt in range(3):
        try:
            async with httpx.AsyncClient(timeout=45.0) as client:
                response = await client.post(f"{MARKET_DATA_URL}/internal/backfill/cfd", json=body)
            if response.status_code >= 400:
                detail = response.text[:500].strip()
                last_error = detail or last_error
                if response.status_code < 500:
                    raise HTTPException(status_code=502, detail=last_error)
            else:
                return response.json()
        except httpx.HTTPError as exc:
            last_error = str(exc) or last_error
        if attempt < 2:
            await asyncio.sleep(1.0 + attempt)
    raise HTTPException(status_code=502, detail=last_error)


@app.get("/v1/market/trades")
async def proxy_market_trades(
    instrument: str,
    venue: str = "binance-public",
    limit: int = 200,
    auth: AuthContext = Depends(any_read_auth),
) -> list[dict]:
    del auth
    market_symbol = _market_data_symbol(venue, instrument)
    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.get(
            f"{MARKET_DATA_URL}/v1/market/trades",
            params={"instrument": market_symbol, "venue": venue, "limit": max(1, min(limit, 500))},
        )
        return _proxy_json_response(response)


@app.get("/v1/market/orderbook/depth")
async def proxy_market_depth(
    instrument: str,
    venue: str = "binance-public",
    auth: AuthContext = Depends(any_read_auth),
) -> dict:
    del auth
    market_symbol = _market_data_symbol(venue, instrument)
    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.get(
            f"{MARKET_DATA_URL}/v1/market/orderbook/depth",
            params={"instrument": market_symbol, "venue": venue},
        )
        return _proxy_json_response(response)


@app.get("/v1/market/microstructure")
async def proxy_market_microstructure(
    instrument: str,
    venue: str = "binance-public",
    lookback_minutes: int = 60,
    auth: AuthContext = Depends(viewer_auth),
) -> dict:
    del auth
    market_symbol = _market_data_symbol(venue, instrument)
    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.get(
            f"{MARKET_DATA_URL}/v1/market/microstructure",
            params={"instrument": market_symbol, "venue": venue, "lookback_minutes": max(5, min(lookback_minutes, 720))},
        )
        return _proxy_json_response(response)


@app.get("/v1/market/session-state")
async def proxy_market_session_state(instrument: str = "BTCUSDT", auth: AuthContext = Depends(viewer_auth)) -> dict:
    del auth
    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.get(f"{MARKET_DATA_URL}/v1/market/session-state", params={"instrument": instrument})
        return _proxy_json_response(response)


@app.get("/v1/market/bus/snapshot")
async def market_bus_snapshot(
    instrument: str,
    venue: str = "binance-public",
    timeframe: str = "1m",
    lookback_minutes: int = 60,
    trade_limit: int = 200,
    auth: AuthContext = Depends(any_read_auth),
) -> dict:
    del auth
    symbol = _normalize_symbol(instrument)
    market_symbol = _market_data_symbol(venue, instrument)
    safe_lookback = max(5, min(lookback_minutes, 720))
    safe_trade_limit = max(20, min(trade_limit, 500))

    def _parse_dt(value):
        if isinstance(value, datetime):
            return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        if not isinstance(value, str) or not value.strip():
            return None
        normalized = value.strip()
        if normalized.endswith("Z"):
            normalized = normalized[:-1] + "+00:00"
        try:
            parsed = datetime.fromisoformat(normalized)
        except ValueError:
            return None
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)

    def _freshness_ms(value):
        parsed = _parse_dt(value)
        if not parsed:
            return None
        return max(0, int((_now_utc() - parsed).total_seconds() * 1000))

    def _timeframe_ms(value: str) -> int | None:
        normalized = str(value or "").strip().lower()
        if not normalized:
            return None
        unit = normalized[-1]
        try:
            amount = int(normalized[:-1])
        except ValueError:
            return None
        if amount <= 0:
            return None
        if unit == "m":
            return amount * 60_000
        if unit == "h":
            return amount * 3_600_000
        if unit == "d":
            return amount * 86_400_000
        if unit == "w":
            return amount * 604_800_000
        return None

    async with httpx.AsyncClient(timeout=10.0) as client:
        responses = await asyncio.gather(
            client.get(
                f"{MARKET_DATA_URL}/v1/market/trades",
                params={"instrument": market_symbol, "venue": venue, "limit": safe_trade_limit},
            ),
            client.get(
                f"{MARKET_DATA_URL}/v1/market/microstructure",
                params={"instrument": market_symbol, "venue": venue, "lookback_minutes": safe_lookback},
            ),
            client.get(
                f"{MARKET_DATA_URL}/v1/market/session-state",
                params={"instrument": market_symbol},
            ),
            client.get(
                f"{BROKER_ADAPTER_URL}/v1/orderbook/{venue}/{symbol}",
            ),
            client.get(
                f"{EXECUTION_ROUTER_URL}/v1/routes/score",
                params={"symbol": symbol},
            ),
            client.get(
                f"{MARKET_DATA_URL}/v1/market/ohlcv",
                params={"instrument": market_symbol, "venue": venue, "timeframe": timeframe, "limit": 500},
            ),
            client.get(
                f"{MARKET_DATA_URL}/v1/market/orderbook/depth",
                params={"instrument": market_symbol, "venue": venue},
            ),
            return_exceptions=True,
        )

    def parse_result(index: int, fallback):
        result = responses[index]
        if isinstance(result, Exception):
            return fallback
        if result.status_code >= 400:
            return fallback
        try:
            payload = result.json()
        except Exception:
            return fallback
        return payload if payload is not None else fallback

    trades = parse_result(0, [])
    microstructure = parse_result(1, None)
    session_state = parse_result(2, None)
    orderbook = parse_result(3, None)
    routing_score = parse_result(4, None)
    ohlcv_rows = parse_result(5, [])
    depth_snapshot = parse_result(6, None)

    latest_trade_at = None
    if isinstance(trades, list) and trades:
        latest_trade = trades[0] if isinstance(trades[0], dict) else None
        if latest_trade:
            latest_trade_at = latest_trade.get("traded_at")

    latest_bar = None
    if isinstance(ohlcv_rows, list) and ohlcv_rows:
        last_item = ohlcv_rows[-1]
        latest_bar = last_item if isinstance(last_item, dict) else None

    ohlcv_sequences = [
        int(item.get("seq"))
        for item in ohlcv_rows
        if isinstance(item, dict) and isinstance(item.get("seq"), int)
    ]
    ohlcv_bucket_times = [
        _parse_dt(item.get("t") or item.get("bucket_start"))
        for item in ohlcv_rows
        if isinstance(item, dict)
    ]
    ohlcv_latest_seq = max(ohlcv_sequences) if ohlcv_sequences else None
    ohlcv_first_seq = min(ohlcv_sequences) if ohlcv_sequences else None
    timeframe_ms = _timeframe_ms(timeframe)
    ohlcv_contiguous = bool(ohlcv_bucket_times)
    if ohlcv_contiguous:
        if any(bucket is None for bucket in ohlcv_bucket_times):
            ohlcv_contiguous = False
        else:
            ordered_bucket_times = [bucket for bucket in ohlcv_bucket_times if bucket is not None]
            if len({bucket.isoformat() for bucket in ordered_bucket_times}) != len(ordered_bucket_times):
                ohlcv_contiguous = False
            else:
                tolerance_ms = 1_500
                for index in range(1, len(ordered_bucket_times)):
                    delta_ms = int((ordered_bucket_times[index] - ordered_bucket_times[index - 1]).total_seconds() * 1000)
                    if delta_ms <= 0:
                        ohlcv_contiguous = False
                        break
                    if timeframe_ms is not None and abs(delta_ms - timeframe_ms) > tolerance_ms:
                        ohlcv_contiguous = False
                        break

    depth_payload = depth_snapshot.get("depth_payload") if isinstance(depth_snapshot, dict) else None
    depth_last_update_id = depth_payload.get("lastUpdateId") if isinstance(depth_payload, dict) else None

    component_health = {
        "trades": {
            "status": "ok" if isinstance(trades, list) and len(trades) > 0 else "degraded",
            "freshness_ms": _freshness_ms(latest_trade_at),
            "count": len(trades) if isinstance(trades, list) else 0,
        },
        "microstructure": {
            "status": "ok" if isinstance(microstructure, dict) else "degraded",
            "freshness_ms": _freshness_ms(microstructure.get("captured_at")) if isinstance(microstructure, dict) else None,
            "source": microstructure.get("source") if isinstance(microstructure, dict) else None,
        },
        "session_state": {
            "status": "ok" if isinstance(session_state, dict) else "degraded",
            "phase": session_state.get("phase") if isinstance(session_state, dict) else None,
        },
        "orderbook": {
            "status": "ok" if isinstance(orderbook, dict) else "degraded",
            "best_bid": orderbook.get("best_bid") if isinstance(orderbook, dict) else None,
            "best_ask": orderbook.get("best_ask") if isinstance(orderbook, dict) else None,
        },
        "routing_score": {
            "status": "ok" if isinstance(routing_score, dict) else "degraded",
            "source": routing_score.get("source") if isinstance(routing_score, dict) else None,
        },
        "ohlcv": {
            "status": "ok" if isinstance(ohlcv_rows, list) and len(ohlcv_rows) > 0 else "degraded",
            "freshness_ms": _freshness_ms(latest_bar.get("t") if isinstance(latest_bar, dict) else None),
            "bar_count": len(ohlcv_rows) if isinstance(ohlcv_rows, list) else 0,
            "timeframe": timeframe,
        },
        "depth": {
            "status": "ok" if isinstance(depth_snapshot, dict) else "degraded",
            "freshness_ms": _freshness_ms(depth_snapshot.get("snapshot_at")) if isinstance(depth_snapshot, dict) else None,
            "source": depth_snapshot.get("source") if isinstance(depth_snapshot, dict) else None,
        },
    }
    overall_status = "ok" if all(component.get("status") == "ok" for component in component_health.values()) else "degraded"

    return {
        "instrument": symbol,
        "venue": venue,
        "timeframe": timeframe,
        "trades": trades,
        "microstructure": microstructure,
        "session_state": session_state,
        "orderbook": orderbook,
        "routing_score": routing_score,
        "meta": {
            "health": {
                "status": overall_status,
                "components": component_health,
            },
            "sequencing": {
                "ohlcv": {
                    "first_seq": ohlcv_first_seq,
                    "latest_seq": ohlcv_latest_seq,
                    "bar_count": len(ohlcv_rows) if isinstance(ohlcv_rows, list) else 0,
                    "latest_bucket": latest_bar.get("t") if isinstance(latest_bar, dict) else None,
                    "contiguous": ohlcv_contiguous,
                },
                "depth": {
                    "last_update_id": depth_last_update_id,
                    "snapshot_at": depth_snapshot.get("snapshot_at") if isinstance(depth_snapshot, dict) else None,
                },
                "trades": {
                    "latest_trade_at": latest_trade_at,
                    "count": len(trades) if isinstance(trades, list) else 0,
                },
            },
        },
        "as_of": _now_utc().isoformat(),
    }


@app.get("/v1/broker/balance")
async def proxy_broker_balance(auth: AuthContext = Depends(any_read_auth)) -> dict:
    visible_client_ids = _visible_client_ids(auth)
    params: list[Any] = []
    where_sql = ""
    if visible_client_ids is not None:
        if not visible_client_ids:
            return {"mode": "canonical", "provider": "account-registry", "source": "account_balances", "balances": []}
        where_sql = "WHERE ar.client_id = ANY(%s)"
        params.append(visible_client_ids)
    rows = fetch_all(
        f"""
        SELECT latest.asset_symbol AS currency,
               SUM(latest.available_qty) AS free,
               SUM(latest.locked_qty) AS locked,
               SUM(latest.equity_usd) AS equity_usd,
               MAX(latest.as_of) AS as_of
        FROM (
            SELECT DISTINCT ON (ab.account_id, ab.asset_symbol)
                ab.account_id, ab.asset_symbol, ab.available_qty, ab.locked_qty, ab.equity_usd, ab.as_of
            FROM account_balances ab
            ORDER BY ab.account_id, ab.asset_symbol, ab.as_of DESC, ab.id DESC
        ) latest
        JOIN accounts_registry ar ON ar.account_id = latest.account_id
        {where_sql}
        GROUP BY latest.asset_symbol
        ORDER BY latest.asset_symbol ASC
        """,
        tuple(params),
    )
    if not rows:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(f"{BROKER_ADAPTER_URL}/v1/balance")
            return _proxy_json_response(response)
    return {
        "mode": "canonical",
        "provider": "account-registry",
        "source": "account_balances",
        "balances": _normalize_db_rows(rows),
    }


@app.get("/v1/broker/positions")
async def proxy_broker_positions(auth: AuthContext = Depends(any_read_auth)) -> list[dict]:
    visible_client_ids = _visible_client_ids(auth)
    params: list[Any] = []
    where_sql = ""
    if visible_client_ids is not None:
        if not visible_client_ids:
            return []
        where_sql = "WHERE ar.client_id = ANY(%s)"
        params.append(visible_client_ids)
    rows = fetch_all(
        f"""
        SELECT
            latest.instrument,
            latest.symbol,
            SUM(CASE WHEN latest.side = 'short' THEN -ABS(latest.notional_usd) ELSE ABS(latest.notional_usd) END) AS net_notional_usd,
            SUM(ABS(latest.notional_usd)) AS gross_notional_usd,
            SUM(latest.pnl_unrealized_usd) AS pnl_unrealized_usd,
            SUM(latest.pnl_realized_usd) AS pnl_realized_usd,
            MAX(latest.as_of) AS updated_at
        FROM (
            SELECT DISTINCT ON (cp.position_id)
                cp.position_id, cp.account_id, cp.instrument, cp.symbol, cp.side,
                cp.notional_usd, cp.pnl_unrealized_usd, cp.pnl_realized_usd, cp.as_of
            FROM consolidated_positions cp
            ORDER BY cp.position_id, cp.as_of DESC
        ) latest
        JOIN accounts_registry ar ON ar.account_id = latest.account_id
        {where_sql}
        GROUP BY latest.instrument, latest.symbol
        ORDER BY latest.symbol ASC
        """,
        tuple(params),
    )
    if not rows:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(f"{BROKER_ADAPTER_URL}/v1/positions")
            return _proxy_json_response(response)
    return _normalize_db_rows(rows)


@app.get("/v1/broker/orderbook/{venue}/{instrument}")
async def proxy_broker_orderbook(venue: str, instrument: str, auth: AuthContext = Depends(any_read_auth)) -> dict:
    del auth
    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.get(f"{BROKER_ADAPTER_URL}/v1/orderbook/{venue}/{instrument}")
        return _proxy_json_response(response)


@app.post("/v1/ai/route")
async def proxy_ai_route(payload: dict, auth: AuthContext = Depends(operator_auth)) -> dict:
    del auth
    enriched_payload = dict(payload)
    if isinstance(enriched_payload.get("prompt"), str):
        memory = await _retrieve_memory_for_payload(enriched_payload)
        enriched_payload["prompt"] = _inject_memory_into_prompt(str(enriched_payload.get("prompt", "")), memory)
    async with httpx.AsyncClient(timeout=15.0) as client:
        response = await client.post(f"{AI_ORCHESTRATOR_URL}/v1/route", json=enriched_payload)
        if response.status_code >= 400:
            raise HTTPException(status_code=502, detail="AI orchestrator unavailable")
        return response.json()


@app.post("/v1/ai/execute")
async def proxy_ai_execute(payload: dict, auth: AuthContext = Depends(operator_auth)) -> dict:
    del auth
    enriched_payload = dict(payload)
    if isinstance(enriched_payload.get("prompt"), str):
        memory = await _retrieve_memory_for_payload(enriched_payload)
        enriched_payload["prompt"] = _inject_memory_into_prompt(str(enriched_payload.get("prompt", "")), memory)
    try:
        async with httpx.AsyncClient(timeout=240.0) as client:
            response = await client.post(f"{AI_ORCHESTRATOR_URL}/v1/execute", json=enriched_payload)
            if response.status_code >= 400:
                raise HTTPException(status_code=502, detail="AI orchestrator unavailable")
            append_audit("ai_orchestration_executed", {"task": enriched_payload.get("task", "unknown")})
            return response.json()
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="AI orchestrator timeout") from None


@app.get("/v1/ai/health")
async def proxy_ai_health(auth: AuthContext = Depends(viewer_auth)) -> dict:
    del auth
    async with httpx.AsyncClient(timeout=12.0) as client:
        response = await client.get(f"{AI_ORCHESTRATOR_URL}/health")
        if response.status_code >= 400:
            raise HTTPException(status_code=502, detail="AI orchestrator unavailable")
        return response.json()


@app.get("/v1/ai/capacity")
async def proxy_ai_capacity(auth: AuthContext = Depends(viewer_auth)) -> dict:
    del auth
    async with httpx.AsyncClient(timeout=12.0) as client:
        response = await client.get(f"{AI_ORCHESTRATOR_URL}/v1/capacity")
        if response.status_code >= 400:
            raise HTTPException(status_code=502, detail="AI orchestrator unavailable")
        return response.json()


@app.get("/v1/ai/providers")
async def proxy_ai_providers(auth: AuthContext = Depends(viewer_auth)) -> dict:
    del auth
    async with httpx.AsyncClient(timeout=12.0) as client:
        response = await client.get(f"{AI_ORCHESTRATOR_URL}/v1/providers")
        if response.status_code >= 400:
            raise HTTPException(status_code=502, detail="AI orchestrator unavailable")
        return response.json()


@app.get("/v1/ai/history")
async def proxy_ai_history(limit: int = 30, auth: AuthContext = Depends(viewer_auth)) -> list[dict]:
    del auth
    safe_limit = max(1, min(limit, 200))
    async with httpx.AsyncClient(timeout=12.0) as client:
        response = await client.get(f"{AI_ORCHESTRATOR_URL}/v1/history", params={"limit": safe_limit})
        if response.status_code >= 400:
            raise HTTPException(status_code=502, detail="AI orchestrator unavailable")
        return response.json()


@app.get("/v1/ai/kairos/shadow/status")
async def proxy_ai_kairos_shadow_status(auth: AuthContext = Depends(viewer_auth)) -> dict:
    del auth
    async with httpx.AsyncClient(timeout=12.0) as client:
        response = await client.get(f"{AI_ORCHESTRATOR_URL}/v1/kairos/shadow/status")
        if response.status_code >= 400:
            raise HTTPException(status_code=502, detail="AI orchestrator unavailable")
        return response.json()


@app.get("/v1/ai/kairos/shadow/cycles")
async def proxy_ai_kairos_shadow_cycles(limit: int = 20, auth: AuthContext = Depends(viewer_auth)) -> dict:
    del auth
    safe_limit = max(1, min(limit, 200))
    async with httpx.AsyncClient(timeout=20.0) as client:
        response = await client.get(f"{AI_ORCHESTRATOR_URL}/v1/kairos/shadow/cycles", params={"limit": safe_limit})
        if response.status_code >= 400:
            raise HTTPException(status_code=502, detail="AI orchestrator unavailable")
        return response.json()


@app.get("/v1/ai/kairos/shadow/decisions")
async def proxy_ai_kairos_shadow_decisions(limit: int = 20, auth: AuthContext = Depends(viewer_auth)) -> dict:
    del auth
    safe_limit = max(1, min(limit, 200))
    async with httpx.AsyncClient(timeout=20.0) as client:
        response = await client.get(f"{AI_ORCHESTRATOR_URL}/v1/kairos/shadow/decisions", params={"limit": safe_limit})
        if response.status_code >= 400:
            raise HTTPException(status_code=502, detail="AI orchestrator unavailable")
        return response.json()


@app.post("/v1/ai/kairos/shadow/start")
async def proxy_ai_kairos_shadow_start(payload: dict, auth: AuthContext = Depends(operator_auth)) -> dict:
    del auth
    async with httpx.AsyncClient(timeout=20.0) as client:
        response = await client.post(f"{AI_ORCHESTRATOR_URL}/v1/kairos/shadow/start", json=payload if isinstance(payload, dict) else {})
        if response.status_code >= 400:
            raise HTTPException(status_code=502, detail="AI orchestrator unavailable")
        body = response.json()
        append_audit("kairos_shadow_started", body)
        return body


@app.post("/v1/ai/kairos/shadow/stop")
async def proxy_ai_kairos_shadow_stop(auth: AuthContext = Depends(operator_auth)) -> dict:
    del auth
    async with httpx.AsyncClient(timeout=20.0) as client:
        response = await client.post(f"{AI_ORCHESTRATOR_URL}/v1/kairos/shadow/stop")
        if response.status_code >= 400:
            raise HTTPException(status_code=502, detail="AI orchestrator unavailable")
        body = response.json()
        append_audit("kairos_shadow_stopped", body)
        return body


@app.post("/v1/ai/kairos/shadow/run-once")
async def proxy_ai_kairos_shadow_run_once(payload: dict, auth: AuthContext = Depends(operator_auth)) -> dict:
    del auth
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(f"{AI_ORCHESTRATOR_URL}/v1/kairos/shadow/run-once", json=payload if isinstance(payload, dict) else {})
        if response.status_code >= 400:
            raise HTTPException(status_code=502, detail="AI orchestrator unavailable")
        body = response.json()
        append_audit("kairos_shadow_run_once", {"result": body})
        return body


@app.post("/v1/ai/kairos/shadow/harness/run-once")
async def proxy_ai_kairos_shadow_harness_run_once(payload: dict, auth: AuthContext = Depends(operator_auth)) -> dict:
    del auth
    async with httpx.AsyncClient(timeout=45.0) as client:
        response = await client.post(f"{AI_ORCHESTRATOR_URL}/v1/kairos/shadow/harness/run-once", json=payload if isinstance(payload, dict) else {})
        if response.status_code >= 400:
            raise HTTPException(status_code=502, detail="AI orchestrator unavailable")
        body = response.json()
        append_audit("kairos_shadow_harness_run_once", {"result": body})
        return body


@app.post("/v1/ai/history/clear-old")
async def proxy_ai_history_clear_old(auth: AuthContext = Depends(operator_auth)) -> dict:
    del auth
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(f"{AI_ORCHESTRATOR_URL}/v1/history/clear-old")
        if response.status_code >= 400:
            raise HTTPException(status_code=502, detail="AI orchestrator unavailable")
        append_audit("ai_history_clear_old", response.json())
        return response.json()


@app.get("/v1/ai/local-models/health")
async def proxy_ai_local_models_health(auth: AuthContext = Depends(viewer_auth)) -> dict:
    del auth
    async with httpx.AsyncClient(timeout=20.0) as client:
        response = await client.get(f"{AI_ORCHESTRATOR_URL}/v1/local-models/health")
        if response.status_code >= 400:
            raise HTTPException(status_code=502, detail="AI orchestrator unavailable")
        return response.json()


@app.post("/v1/ai/local-models/warmup")
async def proxy_ai_local_models_warmup(payload: dict, auth: AuthContext = Depends(operator_auth)) -> dict:
    del auth
    async with httpx.AsyncClient(timeout=300.0) as client:
        response = await client.post(f"{AI_ORCHESTRATOR_URL}/v1/local-models/warmup", json=payload)
        if response.status_code >= 400:
            raise HTTPException(status_code=502, detail="AI orchestrator unavailable")
        append_audit("ai_local_warmup", {"model_key": payload.get("model_key", "all")})
        return response.json()


@app.post("/v1/ai/regimes/detect")
async def proxy_ai_regime_detect(payload: dict, auth: AuthContext = Depends(operator_auth)) -> dict:
    del auth
    async with httpx.AsyncClient(timeout=15.0) as client:
        response = await client.post(f"{AI_ORCHESTRATOR_URL}/v1/regimes/detect", json=payload)
        if response.status_code >= 400:
            raise HTTPException(status_code=502, detail="AI orchestrator unavailable")
        return response.json()


@app.post("/v1/ai/backtests/geopolitical")
async def proxy_ai_geopolitical_backtest(payload: dict, auth: AuthContext = Depends(operator_auth)) -> dict:
    del auth
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(f"{AI_ORCHESTRATOR_URL}/v1/backtests/geopolitical", json=payload)
        if response.status_code >= 400:
            raise HTTPException(status_code=502, detail="AI orchestrator unavailable")
        append_audit("ai_geopolitical_backtest", {"strategy": payload.get("strategy_name", "")})
        return response.json()


@app.post("/v1/ai/decision/score")
async def proxy_ai_decision_score(payload: dict, auth: AuthContext = Depends(operator_auth)) -> dict:
    del auth
    arm = "memory_on"
    memory = {
        "kpis": {},
        "formatted_memory": [],
        "insights": [],
        "historical_alignment_score": _to_float(payload.get("historical_match"), 0.5),
        "risk_flags": {"high_drawdown": False},
    }
    adjusted_payload = dict(payload)
    adjustments = {
        "base_historical_match": _to_float(payload.get("historical_match"), 0.5),
        "alignment": _to_float(payload.get("historical_match"), 0.5),
        "boost": 0.0,
        "penalty": 0.0,
        "final_historical_match": _to_float(payload.get("historical_match"), 0.5),
    }

    if _memory_ab_enabled():
        arm = _pick_memory_arm(payload)
    if arm == "memory_on":
        memory = await _retrieve_memory_for_payload(payload)
        adjusted_payload, adjustments = _apply_memory_aware_score(payload, memory)

    async with httpx.AsyncClient(timeout=15.0) as client:
        response = await client.post(f"{AI_ORCHESTRATOR_URL}/v1/decision/score", json=adjusted_payload)
        if response.status_code >= 400:
            raise HTTPException(status_code=502, detail="AI orchestrator unavailable")
        body = response.json()
        score_before = _to_float(payload.get("historical_match"), 0.5)
        score_after = _to_float((body.get("score") or {}).get("score_global"), score_before)
        execute(
            """
            INSERT INTO memory_ab_events (
                decision_id, source, strategy_id, symbol, regime,
                arm, score_before, score_after, action, payload
            )
            VALUES (%s, %s, %s, %s, %s,
                    %s, %s, %s, %s, %s::jsonb)
            """,
            (
                str(payload.get("decision_id", "")) or None,
                "decision_score",
                str(payload.get("strategy_id", "")) or None,
                str(payload.get("symbol") or payload.get("instrument") or "") or None,
                str(payload.get("regime", "")) or None,
                arm,
                score_before,
                score_after,
                str(body.get("action", "")) or None,
                json_dumps({"adjustments": adjustments, "memory_kpis": memory.get("kpis", {})}),
            ),
        )
        body["memory"] = {
            "kpis": memory.get("kpis", {}),
            "formatted_memory": memory.get("formatted_memory", []),
            "insights": memory.get("insights", []),
            "adjustments": adjustments,
            "ab_arm": arm,
        }
        return body


@app.post("/v1/ai/decision/vote")
async def proxy_ai_decision_vote(payload: dict, auth: AuthContext = Depends(operator_auth)) -> dict:
    del auth
    async with httpx.AsyncClient(timeout=15.0) as client:
        response = await client.post(f"{AI_ORCHESTRATOR_URL}/v1/decision/vote", json=payload)
        if response.status_code >= 400:
            raise HTTPException(status_code=502, detail="AI orchestrator unavailable")
        body = response.json()
        disagreement = float(body.get("disagreement", 0.0))
        if disagreement > float(os.getenv("KILL_MAX_AGENT_DISAGREEMENT", "0.5")):
            _activate_kill_switch("ai_vote", "agent_disagreement_threshold", body)
        return body


@app.post("/v1/embeddings/index")
async def proxy_embeddings_index(payload: dict, auth: AuthContext = Depends(operator_auth)) -> dict:
    del auth
    async with httpx.AsyncClient(timeout=90.0) as client:
        response = await client.post(f"{EMBEDDINGS_SERVICE_URL}/v1/index", json=payload)
        if response.status_code >= 400:
            _record_api_error("embeddings-service", "index_failed")
            raise HTTPException(status_code=502, detail="Embeddings service unavailable")
        return response.json()


@app.post("/v1/embeddings/retrieve")
async def proxy_embeddings_retrieve(payload: dict, auth: AuthContext = Depends(viewer_auth)) -> dict:
    del auth
    async with httpx.AsyncClient(timeout=90.0) as client:
        response = await client.post(f"{EMBEDDINGS_SERVICE_URL}/v1/retrieve", json=payload)
        if response.status_code >= 400:
            _record_api_error("embeddings-service", "retrieve_failed")
            raise HTTPException(status_code=502, detail="Embeddings service unavailable")
        return response.json()


@app.get("/v1/embeddings/kpi/retrieval")
async def proxy_embeddings_retrieval_kpi(window_hours: int = 24, auth: AuthContext = Depends(viewer_auth)) -> dict:
    del auth
    window = max(1, min(window_hours, 24 * 30))
    async with httpx.AsyncClient(timeout=20.0) as client:
        response = await client.get(f"{EMBEDDINGS_SERVICE_URL}/v1/kpi/retrieval", params={"window_hours": window})
        if response.status_code >= 400:
            _record_api_error("embeddings-service", "kpi_retrieval_failed")
            raise HTTPException(status_code=502, detail="Embeddings service unavailable")
        return response.json()


@app.get("/v1/mt5/health")
async def proxy_mt5_health(auth: AuthContext = Depends(viewer_auth)) -> dict:
    del auth
    async with httpx.AsyncClient(timeout=12.0) as client:
        response = await client.get(f"{MT5_BRIDGE_URL}/health")
        if response.status_code >= 400:
            raise HTTPException(status_code=502, detail="MT5 bridge unavailable")
        return response.json()


@app.get("/v1/mt5/accounts")
async def proxy_mt5_accounts(auth: AuthContext = Depends(viewer_auth)) -> list[dict]:
    async with httpx.AsyncClient(timeout=12.0) as client:
        response = await client.get(f"{MT5_BRIDGE_URL}/v1/accounts")
        if response.status_code >= 400:
            raise HTTPException(status_code=502, detail="MT5 bridge unavailable")
        payload = response.json()

    accounts = payload if isinstance(payload, list) else []
    visible_accounts = _filter_mt5_accounts_for_auth(accounts, auth)
    connector_by_account = {
        str(item.get("account_id") or ""): item
        for item in _filter_connector_accounts_for_auth(_load_connector_accounts(), auth)
        if str(item.get("provider") or "").strip().lower() == "mt5"
    }
    enriched: list[dict] = []
    for item in visible_accounts:
        metadata = item.get("metadata") if isinstance(item.get("metadata"), dict) else {}
        connector = connector_by_account.get(str(item.get("account_id") or ""))
        enriched.append(
            {
                **item,
                "metadata": metadata,
                "client_id": metadata.get("client_id") or (connector.get("client_id") if connector else None),
                "owner_username": metadata.get("owner_username") or (connector.get("owner_username") if connector else None),
                "has_credentials": bool(connector and connector.get("credential_id")),
            }
        )
    return enriched


@app.post("/v1/mt5/accounts")
async def proxy_mt5_connect_account(payload: dict, auth: AuthContext = Depends(connector_manage_auth)) -> dict:
    account_id = _normalize_account_id(payload.get("account_id"))
    broker = str(payload.get("broker") or "metaquotes").strip()
    server = str(payload.get("server") or "").strip()
    login = str(payload.get("login") or "").strip()
    mode = str(payload.get("mode") or "paper").strip().lower()
    password = str(payload.get("password") or "").strip()
    metadata = dict(payload.get("metadata") or {}) if isinstance(payload.get("metadata"), dict) else {}
    if not account_id or not server or not login:
        raise HTTPException(status_code=400, detail="account_id, server and login are required")
    if mode not in {"paper", "live"}:
        raise HTTPException(status_code=400, detail="mode must be paper or live")

    client_id = _resolve_client_id_for_auth(auth, str(metadata.get("client_id") or payload.get("client_id") or ""))
    metadata["client_id"] = client_id
    metadata["owner_user_id"] = auth.user_id
    metadata["owner_username"] = auth.username
    metadata["source"] = str(metadata.get("source") or "client-connections-page")

    credential_id = None
    if password:
        credential_id = _store_encrypted_connector_credential(
            provider="mt5",
            account_id=account_id,
            auth_method="password",
            secret_payload={
                "broker": broker,
                "server": server,
                "login": login,
                "password": password,
            },
            created_by=auth.username,
        )
        metadata["mt5_credential_id"] = credential_id

    bridge_payload = {
        "account_id": account_id,
        "broker": broker,
        "server": server,
        "login": login,
        "mode": mode,
        "metadata": metadata,
    }
    async with httpx.AsyncClient(timeout=15.0) as client:
        response = await client.post(f"{MT5_BRIDGE_URL}/v1/accounts", json=bridge_payload)
        if response.status_code >= 400:
            raise HTTPException(status_code=502, detail="MT5 bridge unavailable")
        body = response.json()
        if account_id:
            _sync_accounts_registry_from_mt5(account_id)
            _sync_internal_portfolio_accounts(account_id)
            await _sync_mt5_account_state(account_id)

            accounts = _replace_connector_account_record(
                _load_connector_accounts(),
                {
                    "provider": "mt5",
                    "account_id": account_id,
                    "label": str(payload.get("label") or account_id),
                    "mode": "trade" if mode == "live" else "read",
                    "auth_method": "password" if credential_id else "manual",
                    "credential_id": credential_id,
                    "client_id": client_id,
                    "provider_type": "broker",
                    "address": None,
                    "owner_user_id": auth.user_id,
                    "owner_username": auth.username,
                    "linked_by": auth.username,
                    "linked_at": _now_utc().isoformat(),
                },
            )
            _save_connector_accounts(accounts)
        append_audit("mt5_account_connected", {"by": auth.username, "account_id": payload.get("account_id", "")})
        return {**body, "credential_id": credential_id, "client_id": client_id}


@app.post("/v1/mt5/orders/filter")
async def proxy_mt5_filtered_order(payload: dict, auth: AuthContext = Depends(operator_auth)) -> dict:
    _assert_kill_switch_allows_execution()
    account_id = payload.get("account_id", "")
    if not account_id:
        raise HTTPException(status_code=400, detail="account_id is required")

    async with httpx.AsyncClient(timeout=10.0) as client:
        account_response = await client.get(f"{MT5_BRIDGE_URL}/v1/accounts/{account_id}")
        if account_response.status_code == 404:
            raise HTTPException(status_code=404, detail="MT5 account not found")
        if account_response.status_code >= 400:
            raise HTTPException(status_code=502, detail="MT5 bridge unavailable")
        account = account_response.json().get("account", {})
    account_mode = str(account.get("mode") or "paper").strip().lower() or "paper"

    payload_metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
    payload_order_intent = payload.get("order_intent") if isinstance(payload.get("order_intent"), dict) else {}
    payload_source = str(
        payload_order_intent.get("source")
        or payload_metadata.get("source")
        or "mission-control-ui"
    ).strip() or "mission-control-ui"
    payload_governance = _extract_trade_governance(payload)
    payload_memory_gate = _extract_pre_trade_memory_gate(payload)
    hardening_snapshot = _evaluate_go_live_hardening(
        source=payload_source,
        provider="mt5",
        account_id=str(account_id),
        symbol=str(payload.get("symbol") or ""),
        side=str(payload.get("side") or "buy"),
        requested_notional_usd=_to_float(payload.get("estimated_notional_usd"), 0.0),
        confidence=_to_float(
            payload.get("confidence"),
            _to_float(payload_metadata.get("confidence"), 1.0 if account_mode != "live" else 0.0),
        ),
        live_requested=account_mode == "live",
        purpose="execute",
        pre_trade_memory_gate=payload_memory_gate,
        governance=payload_governance,
    ) if account_mode == "live" else {
        "active": False,
        "status": "approved",
        "reasons": [],
        "governance": payload_governance,
        "exposure": {},
        "anti_loop": {},
    }
    if account_mode == "live" and hardening_snapshot.get("status") == "blocked":
        raise HTTPException(
            status_code=409,
            detail={
                "status": "blocked_by_go_live_hardening",
                "hardening": hardening_snapshot,
            },
        )

    risk_eval = _evaluate_chart_risk_rules(payload)
    if risk_eval["loss_exceeded"]:
        append_audit(
            "mt5_order_blocked_risk_max_loss",
            {
                "by": auth.username,
                "account_id": account_id,
                "risk_usd": risk_eval["risk_usd"],
                "max_loss_usd": risk_eval["max_loss_usd"],
                "symbol": payload.get("symbol", ""),
            },
        )
        raise HTTPException(
            status_code=422,
            detail=f"risk_guard_blocked:max_loss_exceeded risk={risk_eval['risk_usd']:.2f} limit={risk_eval['max_loss_usd']:.2f}",
        )

    account_mode = account.get("mode", "paper")
    if risk_eval["target_miss"] and account_mode != "live" and not risk_eval["confirm_ack"]:
        append_audit(
            "mt5_order_requires_confirm_target_gain",
            {
                "by": auth.username,
                "account_id": account_id,
                "reward_usd": risk_eval["reward_usd"],
                "target_gain_usd": risk_eval["target_gain_usd"],
                "symbol": payload.get("symbol", ""),
            },
        )
        raise HTTPException(
            status_code=409,
            detail=(
                "risk_confirmation_required:target_gain_below_objective "
                f"reward={risk_eval['reward_usd']:.2f} target={risk_eval['target_gain_usd']:.2f}"
            ),
        )

    risk_context = {
        "guard_enabled": risk_eval["guard_enabled"],
        "risk_usd": risk_eval["risk_usd"],
        "reward_usd": risk_eval["reward_usd"],
        "max_loss_usd": risk_eval["max_loss_usd"],
        "target_gain_usd": risk_eval["target_gain_usd"],
        "target_rr": risk_eval["target_rr"],
        "target_miss": risk_eval["target_miss"],
        "compliant": not risk_eval["loss_exceeded"] and not risk_eval["target_miss"],
        "go_live_hardening": hardening_snapshot,
    }

    payload.setdefault("metadata", {})
    if isinstance(payload.get("metadata"), dict):
        payload["metadata"]["go_live_target"] = account_mode
        payload["metadata"]["go_live_hardening"] = hardening_snapshot

    if account_mode != "live":
        body = await _execute_mt5_filtered_order(payload)
        append_audit(
            "mt5_order_accepted",
            {
                "by": auth.username,
                "result": body,
                "approval": "single",
                "account_id": account_id,
                "symbol": payload.get("symbol", ""),
                "side": payload.get("side", "buy"),
                "risk_context": risk_context,
            },
        )
        return body

    approval_id = str(uuid4())
    execute(
        """
        INSERT INTO mt5_live_approvals (approval_id, account_id, order_payload, first_approved_by, status)
        VALUES (%s, %s, %s::jsonb, %s, 'pending')
        """,
        (approval_id, account_id, json_dumps(payload), auth.username),
    )
    append_audit(
        "mt5_live_order_pending_second_approval",
        {
            "approval_id": approval_id,
            "account_id": account_id,
            "first_approved_by": auth.username,
            "symbol": payload.get("symbol", ""),
            "side": payload.get("side", "buy"),
            "risk_context": risk_context,
            "go_live_hardening": hardening_snapshot,
        },
    )
    return {
        "status": "pending_second_approval",
        "approval_id": approval_id,
        "message": "Live order requires a second approval by another operator/admin",
        "hardening": hardening_snapshot,
    }


@app.get("/v1/execution/routing/score")
async def execution_routing_score(
    symbol: str,
    infra_health: float | None = None,
    network_regime: str | None = None,
    auth: AuthContext = Depends(any_read_auth),
) -> dict:
    del auth
    return await _compute_route_plan(symbol, infra_health=infra_health, network_regime=network_regime)


@app.get("/v1/execution/telemetry/recent")
async def execution_telemetry_recent(limit: int = 50, auth: AuthContext = Depends(any_read_auth)) -> list[dict]:
    del auth
    return _execution_telemetry_rows(limit)


@app.post("/v1/execution/replay/seed/kairos-harness")
async def execution_replay_seed_kairos_harness(payload: dict | None = None, auth: AuthContext = Depends(operator_auth)) -> dict:
    request_payload = payload if isinstance(payload, dict) else {}
    apply_calibration = bool(request_payload.get("apply_calibration", False))
    train_brain = bool(request_payload.get("train_brain", False))
    decision_id, harness, replay_payload, sample, seed_meta = _seed_kairos_harness_replay(request_payload, auth.username)
    predictor_result = await _forward_reality_gap_to_predictor(sample, apply_calibration=apply_calibration, train_brain=train_brain)
    normalized_sample = predictor_result.get("samples", [sample])[0] if isinstance(predictor_result.get("samples"), list) and predictor_result.get("samples") else sample
    _persist_reality_gap_artifacts(normalized_sample, predictor_result.get("profiles") if isinstance(predictor_result.get("profiles"), list) else [])
    append_audit(
        "execution_replay_seeded_kairos_harness",
        {
            "decision_id": decision_id,
            "sample_id": normalized_sample.get("sample_id"),
            "telemetry_id": seed_meta.get("telemetry_id"),
            "validation_source": seed_meta.get("validation_source"),
            "apply_calibration": apply_calibration,
            "train_brain": train_brain,
            "by": auth.username,
        },
    )
    return {
        "status": str(predictor_result.get("status") or "ok"),
        "decision_id": decision_id,
        "harness": harness,
        "sample": normalized_sample,
        "predictor": predictor_result,
        "replay": replay_payload,
    }


@app.get("/v1/execution/replay/{decision_id}")
async def execution_replay(decision_id: str, auth: AuthContext = Depends(viewer_auth)) -> dict:
    del auth
    return _execution_replay_payload(decision_id)


@app.get("/v1/execution/reality-gap/recent")
async def execution_reality_gap_recent(limit: int = 50, auth: AuthContext = Depends(any_read_auth)) -> dict:
    del auth
    rows = _normalize_db_rows(fetch_all(
        """
        SELECT sample_id, decision_id, symbol, venue, regime, side,
               failure_source, failure_reasons, calibration_action,
               gap_slippage_bps, gap_fill_probability, gap_latency_ms, gap_impact_bps, gap_queue_ahead_qty,
               predicted_execution, realized_execution, payload, created_at
        FROM reality_gap_samples
        ORDER BY created_at DESC
        LIMIT %s
        """,
        (max(1, min(limit, 500)),),
    ))
    return {"status": "ok", "rows": rows}


@app.get("/v1/execution/reality-gap/profiles")
async def execution_reality_gap_profiles(limit: int = 50, auth: AuthContext = Depends(any_read_auth)) -> dict:
    del auth
    rows = _normalize_db_rows(fetch_all(
        """
        SELECT profile_key, venue, symbol, regime, sample_count, calibration, updated_at
        FROM reality_gap_calibration_profiles
        ORDER BY updated_at DESC
        LIMIT %s
        """,
        (max(1, min(limit, 500)),),
    ))
    return {"status": "ok", "rows": rows}


@app.get("/v1/execution/reality-gap/{decision_id}")
async def execution_reality_gap(decision_id: str, auth: AuthContext = Depends(any_read_auth)) -> dict:
    del auth
    row = _normalize_db_row(fetch_one(
        """
        SELECT sample_id, decision_id, symbol, venue, regime, side,
               failure_source, failure_reasons, calibration_action,
               gap_slippage_bps, gap_fill_probability, gap_latency_ms, gap_impact_bps, gap_queue_ahead_qty,
               predicted_execution, realized_execution, payload, created_at
        FROM reality_gap_samples
        WHERE decision_id = %s
        ORDER BY created_at DESC
        LIMIT 1
        """,
        (decision_id,),
    ))
    if row is None:
        raise HTTPException(status_code=404, detail="reality gap sample not found")
    return {"status": "ok", "sample": row}


@app.post("/v1/execution/reality-gap/{decision_id}")
async def execution_reality_gap_ingest(decision_id: str, payload: dict | None = None, auth: AuthContext = Depends(operator_auth)) -> dict:
    request_payload = payload if isinstance(payload, dict) else {}
    replay_payload = _execution_replay_payload(decision_id)
    if not replay_payload.get("telemetry") and not replay_payload.get("fills"):
        raise HTTPException(status_code=404, detail="execution replay not found")

    if isinstance(request_payload.get("sample"), dict):
        validated = RealityGapIngestRequest.model_validate(request_payload)
        sample = validated.sample.model_dump(mode="json")
        apply_calibration = validated.apply_calibration
        train_brain = validated.train_brain
    else:
        sample = _build_reality_gap_sample_from_replay(decision_id, replay_payload, request_payload)
        apply_calibration = bool(request_payload.get("apply_calibration", True))
        train_brain = bool(request_payload.get("train_brain", True))

    predictor_result = await _forward_reality_gap_to_predictor(sample, apply_calibration=apply_calibration, train_brain=train_brain)
    normalized_sample = predictor_result.get("samples", [sample])[0] if isinstance(predictor_result.get("samples"), list) and predictor_result.get("samples") else sample
    _persist_reality_gap_artifacts(normalized_sample, predictor_result.get("profiles") if isinstance(predictor_result.get("profiles"), list) else [])
    append_audit(
        "execution_reality_gap_ingested",
        {
            "decision_id": decision_id,
            "sample_id": normalized_sample.get("sample_id"),
            "failure_source": normalized_sample.get("failure_source"),
            "apply_calibration": apply_calibration,
            "train_brain": train_brain,
            "by": auth.username,
        },
    )
    return {
        "decision_id": decision_id,
        "sample": normalized_sample,
        "predictor": predictor_result,
        "replay": replay_payload,
    }


def _extract_rust_reality_gap_sample_from_replay(replay_payload: dict[str, Any]) -> dict[str, Any] | None:
    telemetry = replay_payload.get("telemetry") if isinstance(replay_payload.get("telemetry"), dict) else {}
    telemetry_payload = telemetry.get("payload") if isinstance(telemetry.get("payload"), dict) else {}
    direct = telemetry_payload.get("rust_reality_gap") if isinstance(telemetry_payload.get("rust_reality_gap"), dict) else None
    if isinstance(direct, dict):
        return direct
    routed_execution = telemetry_payload.get("router_execution") if isinstance(telemetry_payload.get("router_execution"), dict) else {}
    nested = routed_execution.get("reality_gap_sample") if isinstance(routed_execution.get("reality_gap_sample"), dict) else None
    return nested if isinstance(nested, dict) else None


def _normalize_native_rust_reality_gap_sample(
    native_sample: dict[str, Any],
    *,
    decision_id: str,
    replay_payload: dict[str, Any],
    outcome_payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    telemetry = replay_payload.get("telemetry") if isinstance(replay_payload.get("telemetry"), dict) else {}
    order_row = _normalize_db_row(fetch_one(
        """
        SELECT requested_notional_usd, filled_notional_usd
        FROM orders
        WHERE intent_id = %s
        ORDER BY created_at DESC
        LIMIT 1
        """,
        (decision_id,),
    )) or {}
    requested_notional = _to_float(order_row.get("requested_notional_usd"), 0.0)
    filled_notional = _to_float(order_row.get("filled_notional_usd"), 0.0)
    sample = dict(native_sample)
    predicted = sample.get("predicted") if isinstance(sample.get("predicted"), dict) else {}
    realized = sample.get("realized") if isinstance(sample.get("realized"), dict) else {}
    metadata = sample.get("metadata") if isinstance(sample.get("metadata"), dict) else {}
    if requested_notional > 0 and filled_notional > 0 and not math.isfinite(_to_float(realized.get("fill_ratio"), math.nan)):
        realized["fill_ratio"] = round(_safe_ratio(filled_notional, requested_notional, default=0.0), 6)
    telemetry_latency_ms = _to_float(telemetry.get("latency_e2e_ms"), math.nan)
    if math.isfinite(telemetry_latency_ms):
        realized["latency_ms"] = round(telemetry_latency_ms, 6)
    telemetry_slippage_bps = _to_float(telemetry.get("realized_slippage_bps"), math.nan)
    if math.isfinite(telemetry_slippage_bps):
        realized["slippage_bps"] = round(telemetry_slippage_bps, 6)
    if isinstance(outcome_payload, dict):
        if outcome_payload.get("latency_ms") is not None:
            realized["latency_ms"] = round(_to_float(outcome_payload.get("latency_ms"), 0.0), 6)
        if outcome_payload.get("slippage_real_bps") is not None:
            realized["slippage_bps"] = round(_to_float(outcome_payload.get("slippage_real_bps"), 0.0), 6)
        if outcome_payload.get("regime"):
            sample["regime"] = str(outcome_payload.get("regime") or sample.get("regime") or "UNKNOWN").strip().upper()
    metadata["source"] = "rust-native"
    sample["sample_id"] = str(sample.get("sample_id") or f"rg-{decision_id}")
    sample["decision_id"] = decision_id
    sample["symbol"] = str(sample.get("symbol") or telemetry.get("symbol") or "UNKNOWN").strip().upper()
    sample["venue"] = str(sample.get("venue") or telemetry.get("route_chosen") or "unknown").strip().lower()
    sample["regime"] = str(sample.get("regime") or "UNKNOWN").strip().upper()
    sample["side"] = str(sample.get("side") or telemetry.get("side") or "hold").strip().lower()
    sample["predicted"] = predicted
    sample["realized"] = realized
    sample["failure_source"] = _normalize_failure_source(sample.get("failure_source"))
    sample["failure_reasons"] = _normalize_failure_reasons(sample.get("failure_reasons"))
    sample["metadata"] = metadata
    sample["created_at"] = str(sample.get("created_at") or "")
    return sample


async def _auto_ingest_reality_gap_for_decision(
    decision_id: str,
    outcome_payload: dict[str, Any] | None = None,
    native_sample: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    existing = _normalize_db_row(fetch_one(
        """
        SELECT sample_id, decision_id, payload
        FROM reality_gap_samples
        WHERE decision_id = %s
        ORDER BY created_at DESC
        LIMIT 1
        """,
        (decision_id,),
    ))
    if existing is not None:
        return {
            "status": "skipped",
            "reason": "already_ingested",
            "decision_id": decision_id,
            "sample_id": existing.get("sample_id"),
        }

    replay_payload = _execution_replay_payload(decision_id)
    if not replay_payload.get("telemetry") and not replay_payload.get("fills"):
        return {
            "status": "skipped",
            "reason": "execution_replay_not_found",
            "decision_id": decision_id,
        }

    sample: dict[str, Any]
    native_candidate = native_sample if isinstance(native_sample, dict) else _extract_rust_reality_gap_sample_from_replay(replay_payload)
    if isinstance(native_candidate, dict):
        sample = _normalize_native_rust_reality_gap_sample(
            native_candidate,
            decision_id=decision_id,
            replay_payload=replay_payload,
            outcome_payload=outcome_payload,
        )
    else:
        overrides: dict[str, Any] = {
            "sample_id": f"rg-auto-{decision_id}",
            "metadata": {
                "ingestion_source": "outcome_update",
                "auto_ingested": True,
            },
        }
        if isinstance(outcome_payload, dict):
            if outcome_payload.get("slippage_real_bps") is not None:
                overrides["realized_slippage_bps"] = outcome_payload.get("slippage_real_bps")
            if outcome_payload.get("latency_ms") is not None:
                overrides["realized_latency_ms"] = outcome_payload.get("latency_ms")
            if outcome_payload.get("regime"):
                overrides["regime"] = outcome_payload.get("regime")
            if outcome_payload.get("symbol"):
                overrides["symbol"] = outcome_payload.get("symbol")
            if outcome_payload.get("source"):
                overrides["metadata"]["outcome_source"] = outcome_payload.get("source")
            if outcome_payload.get("status"):
                overrides["metadata"]["outcome_status"] = outcome_payload.get("status")
            if outcome_payload.get("net_result_usd") is not None:
                overrides["metadata"]["net_result_usd"] = _to_float(outcome_payload.get("net_result_usd"), 0.0)

        sample = _build_reality_gap_sample_from_replay(decision_id, replay_payload, overrides)
    predictor_result = await _forward_reality_gap_to_predictor(sample, apply_calibration=True, train_brain=True)
    normalized_sample = predictor_result.get("samples", [sample])[0] if isinstance(predictor_result.get("samples"), list) and predictor_result.get("samples") else sample
    _persist_reality_gap_artifacts(normalized_sample, predictor_result.get("profiles") if isinstance(predictor_result.get("profiles"), list) else [])
    append_audit(
        "execution_reality_gap_auto_ingested",
        {
            "decision_id": decision_id,
            "sample_id": normalized_sample.get("sample_id"),
            "predictor_status": predictor_result.get("status"),
        },
    )
    return {
        "status": str(predictor_result.get("status") or "ok"),
        "decision_id": decision_id,
        "sample_id": normalized_sample.get("sample_id"),
        "profile_count": len(predictor_result.get("profiles") or []) if isinstance(predictor_result.get("profiles"), list) else 0,
        "brain_trained": bool(((predictor_result.get("brain") or {}) if isinstance(predictor_result.get("brain"), dict) else {}).get("trained")),
    }


def _execution_replay_payload(decision_id: str) -> dict:
    telemetry = _normalize_db_row(fetch_one(
        """
        SELECT telemetry_id, decision_id, account_id, symbol, side, lots,
               route_chosen, route_backup, route_reason, route_score, backup_score,
               quote_spread_bps, available_depth_usd,
               expected_slippage_bps, realized_slippage_bps, latency_e2e_ms,
               ts_decision, ts_intent, ts_routing, ts_broker_accept, ts_fill_partial, ts_fill_final,
               payload, created_at
        FROM execution_telemetry
        WHERE decision_id = %s
        ORDER BY created_at DESC
        LIMIT 1
        """,
        (decision_id,),
    ))
    fills = _normalize_db_rows(fetch_all(
        """
        SELECT decision_id, fill_id, venue, instrument, side, price, size_base, notional_usd,
               depth_level, fill_type, slippage_bps, fill_latency_ms, payload, filled_at
        FROM execution_fill_events
        WHERE decision_id = %s
        ORDER BY filled_at ASC, id ASC
        """,
        (decision_id,),
    ))
    brain_replay = _build_replay_brain_payload(decision_id)
    pre_trade_memory_gate = _extract_pre_trade_memory_gate(telemetry) or _extract_pre_trade_memory_gate_from_fills(fills)
    kairos_harness = _extract_kairos_harness(telemetry) or _extract_kairos_harness_from_fills(fills)
    return {
        "decision_id": decision_id,
        "telemetry": telemetry,
        "fills": fills,
        "fill_count": len(fills),
        "pre_trade_memory_gate": pre_trade_memory_gate,
        "kairos_harness": kairos_harness,
        "brain_replay": brain_replay,
    }


def _safe_ratio(numerator: float, denominator: float, default: float = 0.0) -> float:
    if denominator <= 1e-9:
        return default
    return numerator / denominator


def _finite_or_none(value: float) -> float | None:
    return round(value, 6) if math.isfinite(value) else None


def _resolve_route_candidate(telemetry: dict[str, Any]) -> dict[str, Any]:
    payload = telemetry.get("payload") if isinstance(telemetry.get("payload"), dict) else {}
    routing = payload.get("routing") if isinstance(payload.get("routing"), dict) else {}
    best = routing.get("best") if isinstance(routing.get("best"), dict) else None
    if isinstance(best, dict):
        return best
    route_chosen = str(telemetry.get("route_chosen") or "").strip().lower()
    candidates = routing.get("candidates") if isinstance(routing.get("candidates"), list) else []
    for candidate in candidates:
        if isinstance(candidate, dict) and str(candidate.get("venue") or "").strip().lower() == route_chosen:
            return candidate
    return {}


def _average_fill_metric(fills: list[dict[str, Any]], key: str) -> float:
    values: list[float] = []
    for fill in fills:
        payload = fill.get("payload") if isinstance(fill.get("payload"), dict) else {}
        metric = _to_float(payload.get(key), math.nan)
        if not math.isfinite(metric):
            metric = _to_float(fill.get(key), math.nan)
        if math.isfinite(metric):
            values.append(metric)
    if not values:
        return math.nan
    return sum(values) / len(values)


def _build_reality_gap_sample_from_replay(decision_id: str, replay_payload: dict[str, Any], overrides: dict[str, Any]) -> dict[str, Any]:
    telemetry = replay_payload.get("telemetry") if isinstance(replay_payload.get("telemetry"), dict) else {}
    fills = replay_payload.get("fills") if isinstance(replay_payload.get("fills"), list) else []
    brain_replay = replay_payload.get("brain_replay") if isinstance(replay_payload.get("brain_replay"), dict) else {}
    telemetry_payload = telemetry.get("payload") if isinstance(telemetry.get("payload"), dict) else {}
    predictor_payload = telemetry_payload.get("predictor") if isinstance(telemetry_payload.get("predictor"), dict) else {}
    route_candidate = _resolve_route_candidate(telemetry)
    order_row = _normalize_db_row(fetch_one(
        """
        SELECT requested_notional_usd, filled_notional_usd, avg_fill_price
        FROM orders
        WHERE intent_id = %s
        ORDER BY created_at DESC
        LIMIT 1
        """,
        (decision_id,),
    )) or {}
    requested_notional = _to_float(order_row.get("requested_notional_usd"), 0.0)
    filled_notional = _to_float(order_row.get("filled_notional_usd"), 0.0)
    realized_fill_ratio = _to_float(overrides.get("realized_fill_ratio"), math.nan)
    if not math.isfinite(realized_fill_ratio):
        realized_fill_ratio = _safe_ratio(filled_notional, requested_notional, default=1.0 if fills else 0.0)
    route_fill_probability = _to_float(route_candidate.get("fill_probability"), math.nan)
    predictor_fill_probability = _to_float(predictor_payload.get("fill_probability"), math.nan)
    predicted_fill_probability = _to_float(overrides.get("predicted_fill_probability"), predictor_fill_probability if math.isfinite(predictor_fill_probability) else route_fill_probability)
    predicted_slippage_bps = _to_float(overrides.get("predicted_slippage_bps"), _to_float(telemetry.get("expected_slippage_bps"), math.nan))
    realized_slippage_bps = _to_float(overrides.get("realized_slippage_bps"), _to_float(telemetry.get("realized_slippage_bps"), _average_fill_metric(fills, "slippage_bps")))
    predicted_latency_ms = _to_float(overrides.get("predicted_latency_ms"), _to_float(route_candidate.get("latency_ms"), _to_float(telemetry_payload.get("expected_latency_ms"), math.nan)))
    realized_latency_ms = _to_float(overrides.get("realized_latency_ms"), _to_float(telemetry.get("latency_e2e_ms"), _average_fill_metric(fills, "fill_latency_ms")))
    predicted_impact_bps = _to_float(overrides.get("predicted_impact_bps"), _to_float(predictor_payload.get("impact_bps"), _to_float(telemetry_payload.get("predicted_impact_bps"), math.nan)))
    realized_impact_bps = _to_float(overrides.get("realized_impact_bps"), max(0.0, realized_slippage_bps - max(0.0, _to_float(telemetry.get("quote_spread_bps"), 0.0)) * 0.5) if math.isfinite(realized_slippage_bps) else math.nan)
    predicted_queue_ahead_qty = _to_float(overrides.get("predicted_queue_ahead_qty"), _to_float(route_candidate.get("queue_priority_risk"), math.nan))
    realized_queue_ahead_qty = _to_float(overrides.get("realized_queue_ahead_qty"), _average_fill_metric(fills, "queue_priority_risk"))
    failure_summary = brain_replay.get("failureSummary") if isinstance(brain_replay.get("failureSummary"), dict) else brain_replay.get("failure_summary") if isinstance(brain_replay.get("failure_summary"), dict) else {}
    failure_source = _normalize_failure_source(overrides.get("failure_source")) or _normalize_failure_source(predictor_payload.get("failure_source")) or _normalize_failure_source(telemetry_payload.get("failure_source")) or _normalize_failure_source(failure_summary.get("dominant_source"))
    failure_reasons = _normalize_failure_reasons(overrides.get("failure_reasons")) or _normalize_failure_reasons(predictor_payload.get("failure_reasons")) or _normalize_failure_reasons(telemetry_payload.get("failure_reasons"))
    regime = str(overrides.get("regime") or predictor_payload.get("regime") or brain_replay.get("regime") or telemetry_payload.get("regime") or "UNKNOWN").strip().upper() or "UNKNOWN"
    side = str(telemetry.get("side") or overrides.get("side") or "hold").strip().lower() or "hold"
    sample = {
        "decision_id": decision_id,
        "symbol": str(telemetry.get("symbol") or overrides.get("symbol") or "").strip().upper() or str(overrides.get("symbol") or "UNKNOWN").strip().upper() or "UNKNOWN",
        "venue": str(overrides.get("venue") or telemetry.get("route_chosen") or route_candidate.get("venue") or "unknown").strip().lower() or "unknown",
        "regime": regime,
        "side": side,
        "failure_source": failure_source,
        "failure_reasons": failure_reasons,
        "predicted": {
            "slippage_bps": _finite_or_none(predicted_slippage_bps),
            "fill_probability": _finite_or_none(predicted_fill_probability),
            "fill_ratio": None,
            "latency_ms": _finite_or_none(predicted_latency_ms),
            "impact_bps": _finite_or_none(predicted_impact_bps),
            "queue_ahead_qty": _finite_or_none(predicted_queue_ahead_qty),
            "metadata": {},
        },
        "realized": {
            "slippage_bps": _finite_or_none(realized_slippage_bps),
            "fill_probability": None,
            "fill_ratio": _finite_or_none(realized_fill_ratio),
            "latency_ms": _finite_or_none(realized_latency_ms),
            "impact_bps": _finite_or_none(realized_impact_bps),
            "queue_ahead_qty": _finite_or_none(realized_queue_ahead_qty),
            "metadata": {},
        },
        "metadata": {
            "available_depth_usd": _to_float(telemetry.get("available_depth_usd"), 0.0),
            "quote_spread_bps": _to_float(telemetry.get("quote_spread_bps"), 0.0),
            "price": _to_float(order_row.get("avg_fill_price"), _weighted_median_price([( _to_float(fill.get("price"), 0.0), _to_float(fill.get("notional_usd"), 0.0)) for fill in fills if _to_float(fill.get("price"), 0.0) > 0.0])),
            "network_regime": str(telemetry_payload.get("network_regime") or predictor_payload.get("network_regime") or "stable"),
            "infra_health": _to_float(telemetry_payload.get("infra_health"), _to_float(predictor_payload.get("infra_health"), 1.0)),
        },
    }
    if isinstance(overrides.get("metadata"), dict):
        sample["metadata"].update(overrides["metadata"])
    return sample


async def _forward_reality_gap_to_predictor(sample: dict[str, Any], *, apply_calibration: bool, train_brain: bool) -> dict[str, Any]:
    try:
        async with httpx.AsyncClient(timeout=max(10.0, PREDICTOR_V8_TIMEOUT_SECONDS * 4.0)) as client:
            response = await client.post(
                f"{PREDICTOR_V8_URL}/brain/reality-gap/ingest",
                json={
                    "items": [{"sample": sample}],
                    "apply_calibration": apply_calibration,
                    "train_brain": train_brain,
                },
            )
        if response.status_code >= 400:
            return {
                "status": "degraded",
                "error": f"predictor_http_{response.status_code}",
                "samples": [sample],
                "profiles": [],
                "brain": {"trained": False, "result": None},
            }
        body = response.json()
        return body if isinstance(body, dict) else {"status": "degraded", "samples": [sample], "profiles": [], "brain": {"trained": False, "result": None}}
    except Exception as exc:
        return {
            "status": "degraded",
            "error": str(exc),
            "samples": [sample],
            "profiles": [],
            "brain": {"trained": False, "result": None},
        }


def _persist_reality_gap_artifacts(sample: dict[str, Any], profiles: list[dict[str, Any]]) -> None:
    execute(
        """
        INSERT INTO reality_gap_samples (
            sample_id, decision_id, symbol, venue, regime, side,
            failure_source, failure_reasons, calibration_action,
            gap_slippage_bps, gap_fill_probability, gap_latency_ms, gap_impact_bps, gap_queue_ahead_qty,
            predicted_execution, realized_execution, payload
        ) VALUES (
            %s, %s, %s, %s, %s, %s,
            %s, %s::jsonb, %s,
            %s, %s, %s, %s, %s,
            %s::jsonb, %s::jsonb, %s::jsonb
        )
        ON CONFLICT (sample_id) DO UPDATE SET
            failure_source = EXCLUDED.failure_source,
            failure_reasons = EXCLUDED.failure_reasons,
            calibration_action = EXCLUDED.calibration_action,
            gap_slippage_bps = EXCLUDED.gap_slippage_bps,
            gap_fill_probability = EXCLUDED.gap_fill_probability,
            gap_latency_ms = EXCLUDED.gap_latency_ms,
            gap_impact_bps = EXCLUDED.gap_impact_bps,
            gap_queue_ahead_qty = EXCLUDED.gap_queue_ahead_qty,
            predicted_execution = EXCLUDED.predicted_execution,
            realized_execution = EXCLUDED.realized_execution,
            payload = EXCLUDED.payload
        """,
        (
            str(sample.get("sample_id") or f"rg-{sample.get('decision_id', '')}"),
            str(sample.get("decision_id") or ""),
            str(sample.get("symbol") or "UNKNOWN"),
            str(sample.get("venue") or "unknown"),
            str(sample.get("regime") or "UNKNOWN"),
            str(sample.get("side") or "hold"),
            sample.get("failure_source"),
            json_dumps(sample.get("failure_reasons") if isinstance(sample.get("failure_reasons"), list) else []),
            sample.get("calibration_action"),
            _to_float(sample.get("gap_slippage_bps"), 0.0),
            _to_float(sample.get("gap_fill_probability"), 0.0),
            _to_float(sample.get("gap_latency_ms"), 0.0),
            _to_float(sample.get("gap_impact_bps"), 0.0),
            _to_float(sample.get("gap_queue_ahead_qty"), 0.0),
            json_dumps(sample.get("predicted") if isinstance(sample.get("predicted"), dict) else {}),
            json_dumps(sample.get("realized") if isinstance(sample.get("realized"), dict) else {}),
            json_dumps(sample),
        ),
    )
    for profile in profiles:
        if not isinstance(profile, dict):
            continue
        execute(
            """
            INSERT INTO reality_gap_calibration_profiles (profile_key, venue, symbol, regime, sample_count, calibration, updated_at)
            VALUES (%s, %s, %s, %s, %s, %s::jsonb, NOW())
            ON CONFLICT (profile_key) DO UPDATE SET
                sample_count = EXCLUDED.sample_count,
                calibration = EXCLUDED.calibration,
                updated_at = NOW()
            """,
            (
                str(profile.get("profile_key") or ""),
                str(profile.get("venue") or "unknown"),
                str(profile.get("symbol") or "UNKNOWN"),
                str(profile.get("regime") or "UNKNOWN"),
                max(0, int(profile.get("sample_count") or 0)),
                json_dumps(profile),
            ),
        )


def _post_trade_debug_prompt(replay_payload: dict[str, Any], decision_id: str, extra_instruction: str = "") -> str:
    telemetry = replay_payload.get("telemetry") if isinstance(replay_payload.get("telemetry"), dict) else {}
    fills = replay_payload.get("fills") if isinstance(replay_payload.get("fills"), list) else []
    brain_replay = replay_payload.get("brain_replay") if isinstance(replay_payload.get("brain_replay"), dict) else {}
    telemetry_payload = telemetry.get("payload") if isinstance(telemetry.get("payload"), dict) else {}
    predictor_payload = telemetry_payload.get("predictor") if isinstance(telemetry_payload.get("predictor"), dict) else {}
    routing_payload = telemetry_payload.get("routing") if isinstance(telemetry_payload.get("routing"), dict) else {}
    payload = {
        "decision_id": decision_id,
        "telemetry": {
            "decision_id": telemetry.get("decision_id"),
            "account_id": telemetry.get("account_id"),
            "symbol": telemetry.get("symbol"),
            "side": telemetry.get("side"),
            "route_reason": telemetry.get("route_reason"),
            "route_chosen": telemetry.get("route_chosen"),
            "route_backup": telemetry.get("route_backup"),
            "quote_spread_bps": telemetry.get("quote_spread_bps"),
            "available_depth_usd": telemetry.get("available_depth_usd"),
            "expected_slippage_bps": telemetry.get("expected_slippage_bps"),
            "realized_slippage_bps": telemetry.get("realized_slippage_bps"),
            "latency_e2e_ms": telemetry.get("latency_e2e_ms"),
            "predictor": predictor_payload,
            "routing": routing_payload,
        },
        "fills": fills[:12],
        "brain_replay": brain_replay,
    }
    instruction = extra_instruction.strip()
    return (
        "You are a post-trade debugger for an autonomous execution stack. "
        "Analyze the replay payload and answer in compact JSON with keys: summary, root_cause, contributing_factors, guardrail_assessment, world_model_assessment, action_shield_assessment, capital_allocation_assessment, recommended_fixes, llm_followups. "
        "Distinguish market vs execution vs infra vs policy failures. "
        "Do not produce trading advice; focus on system diagnosis, replay interpretation, and concrete engineering fixes.\n\n"
        f"Decision: {decision_id}\n"
        f"Replay payload:\n{json_dumps(payload)}\n\n"
        f"Additional instruction: {instruction or 'none'}"
    )


@app.post("/v1/ai/post-trade-debug/{decision_id}")
async def ai_post_trade_debug(decision_id: str, payload: dict | None = None, auth: AuthContext = Depends(operator_auth)) -> dict:
    del auth
    request_payload = payload if isinstance(payload, dict) else {}
    replay_payload = _execution_replay_payload(decision_id)
    if not replay_payload.get("telemetry") and not replay_payload.get("fills") and not replay_payload.get("brain_replay"):
        raise HTTPException(status_code=404, detail="execution replay not found")

    prompt = _post_trade_debug_prompt(
        replay_payload,
        decision_id,
        extra_instruction=str(request_payload.get("instruction") or request_payload.get("prompt_suffix") or ""),
    )
    orchestrator_payload = {
        "task": str(request_payload.get("task") or "post_trade_debug"),
        "prompt": prompt,
        "criticality": str(request_payload.get("criticality") or "medium"),
        "cost_limit_usd": max(0.0, _to_float(request_payload.get("cost_limit_usd"), 0.04)),
        "prefer_local": bool(request_payload.get("prefer_local", False)),
    }
    try:
        async with httpx.AsyncClient(timeout=240.0) as client:
            response = await client.post(f"{AI_ORCHESTRATOR_URL}/v1/execute", json=orchestrator_payload)
        if response.status_code >= 400:
            raise HTTPException(status_code=502, detail="AI orchestrator unavailable")
        body = response.json()
        append_audit(
            "ai_post_trade_debug_executed",
            {
                "decision_id": decision_id,
                "task": orchestrator_payload["task"],
                "criticality": orchestrator_payload["criticality"],
                "prefer_local": orchestrator_payload["prefer_local"],
            },
        )
        return {
            "decision_id": decision_id,
            "orchestration": body,
            "replay": replay_payload,
        }
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="AI orchestrator timeout") from None


@app.post("/v1/execution/rust/preview")
async def execution_rust_preview(payload: dict, auth: AuthContext = Depends(any_read_auth)) -> dict:
    del auth
    if not RUST_EXECUTION_ENGINE_ENABLED:
        raise HTTPException(status_code=503, detail="Rust execution engine disabled")
    risk_body = await _risk_check_mt5_order(payload)
    routing = await _compute_route_plan(str(payload.get("symbol", "")), _predictor_context(payload))
    preferred_venue = str(payload.get("preferred_venue") or (routing.get("best") or {}).get("venue") or "").strip()
    predictor = await _evaluate_predictor_gate(payload, routing, risk_body, preferred_venue)
    adjusted_payload = _apply_predictor_execution_adjustments(payload, predictor)
    result = await _call_rust_execution_engine(adjusted_payload, routing, risk_body, preferred_venue, path="preview")
    if not isinstance(result, dict):
        raise HTTPException(status_code=502, detail="Rust execution engine unavailable")
    return {
        **result,
        "risk_gate": risk_body,
        "routing": routing,
        "predictor": predictor,
    }


@app.post("/v1/execution/rust/execute")
async def execution_rust_execute(payload: dict, auth: AuthContext = Depends(operator_auth)) -> dict:
    del auth
    if not RUST_EXECUTION_ENGINE_ENABLED:
        raise HTTPException(status_code=503, detail="Rust execution engine disabled")
    risk_body = await _risk_check_mt5_order(payload)
    if risk_body.get("decision") != "accept":
        raise HTTPException(status_code=400, detail=risk_body)
    routing = await _compute_route_plan(str(payload.get("symbol", "")), _predictor_context(payload))
    preferred_venue = str(payload.get("preferred_venue") or (routing.get("best") or {}).get("venue") or "").strip()
    predictor = await _evaluate_predictor_gate(payload, routing, risk_body, preferred_venue)
    if not predictor.get("allow_execution"):
        raise HTTPException(status_code=409, detail={"status": "blocked_by_predictor", "predictor": predictor})
    adjusted_payload = _apply_predictor_execution_adjustments(payload, predictor)
    result = await _call_rust_execution_engine(adjusted_payload, routing, risk_body, preferred_venue, path="execute")
    if not isinstance(result, dict):
        raise HTTPException(status_code=502, detail="Rust execution engine unavailable")
    return {**result, "predictor": predictor}


@app.get("/v1/mt5/orders/live-pending")
async def mt5_live_pending(auth: AuthContext = Depends(operator_auth)) -> list[dict]:
    del auth
    return fetch_all(
        """
        SELECT approval_id, account_id, order_payload, first_approved_by, second_approved_by, status, created_at, executed_at
        FROM mt5_live_approvals
        WHERE status = 'pending'
        ORDER BY created_at DESC
        """
    )


@app.get("/v1/mt5/orders/risk-history")
async def mt5_orders_risk_history(
    limit: int = 50,
    symbol: str | None = None,
    account_id: str | None = None,
    from_ts: str | None = None,
    to_ts: str | None = None,
    auth: AuthContext = Depends(viewer_auth),
) -> list[dict]:
    del auth
    safe_limit = max(1, min(limit, 200))
    filters: list[str] = [
        "category IN ('mt5_order_accepted', 'mt5_order_blocked_risk_max_loss', 'mt5_order_requires_confirm_target_gain')"
    ]
    params: list[object] = []
    symbol_value = (symbol or "").strip().upper()
    account_value = (account_id or "").strip()
    if symbol_value:
        filters.append("UPPER(COALESCE(payload->>'symbol', '')) = %s")
        params.append(symbol_value)
    if account_value:
        filters.append("COALESCE(payload->>'account_id', '') = %s")
        params.append(account_value)

    from_dt = _parse_iso_utc(from_ts)
    to_dt = _parse_iso_utc(to_ts)
    if from_ts and not from_dt:
        raise HTTPException(status_code=400, detail="invalid from_ts")
    if to_ts and not to_dt:
        raise HTTPException(status_code=400, detail="invalid to_ts")
    if from_dt and to_dt and from_dt > to_dt:
        raise HTTPException(status_code=400, detail="from_ts must be <= to_ts")
    if from_dt:
        filters.append("created_at >= %s")
        params.append(from_dt)
    if to_dt:
        filters.append("created_at <= %s")
        params.append(to_dt)

    params.append(safe_limit)

    return fetch_all(
        f"""
        SELECT category, payload, created_at AS timestamp
        FROM audit_events
        WHERE {' AND '.join(filters)}
        ORDER BY id DESC
        LIMIT %s
        """,
        tuple(params),
    )


@app.get("/v1/mt5/orders/risk-history/summary")
async def mt5_orders_risk_history_summary(
    window: int = 10,
    miss_threshold: int = 3,
    symbol: str | None = None,
    account_id: str | None = None,
    from_ts: str | None = None,
    to_ts: str | None = None,
    auth: AuthContext = Depends(viewer_auth),
) -> dict:
    del auth
    safe_window = max(1, min(window, 200))
    safe_miss_threshold = max(1, min(miss_threshold, safe_window))

    filters: list[str] = [
        "category IN ('mt5_order_accepted', 'mt5_order_blocked_risk_max_loss', 'mt5_order_requires_confirm_target_gain')"
    ]
    params: list[object] = []
    symbol_value = (symbol or "").strip().upper()
    account_value = (account_id or "").strip()
    if symbol_value:
        filters.append("UPPER(COALESCE(payload->>'symbol', '')) = %s")
        params.append(symbol_value)
    if account_value:
        filters.append("COALESCE(payload->>'account_id', '') = %s")
        params.append(account_value)

    from_dt = _parse_iso_utc(from_ts)
    to_dt = _parse_iso_utc(to_ts)
    if from_ts and not from_dt:
        raise HTTPException(status_code=400, detail="invalid from_ts")
    if to_ts and not to_dt:
        raise HTTPException(status_code=400, detail="invalid to_ts")
    if from_dt and to_dt and from_dt > to_dt:
        raise HTTPException(status_code=400, detail="from_ts must be <= to_ts")
    if from_dt:
        filters.append("created_at >= %s")
        params.append(from_dt)
    if to_dt:
        filters.append("created_at <= %s")
        params.append(to_dt)

    rows = fetch_all(
        f"""
        SELECT category, payload, created_at AS timestamp
        FROM audit_events
        WHERE {' AND '.join(filters)}
        ORDER BY id DESC
        LIMIT %s
        """,
        tuple([*params, 500]),
    )

    def _is_compliant(row: dict) -> bool:
        category = str(row.get("category") or "")
        payload = row.get("payload") if isinstance(row.get("payload"), dict) else {}
        risk_context = payload.get("risk_context") if isinstance(payload, dict) and isinstance(payload.get("risk_context"), dict) else {}
        if category == "mt5_order_accepted":
            return bool(risk_context.get("compliant"))
        return False

    count_ok = 0
    count_miss = 0
    last_block_reason = "none"
    for row in rows:
        category = str(row.get("category") or "")
        if _is_compliant(row):
            count_ok += 1
            continue
        count_miss += 1
        if last_block_reason == "none":
            if category == "mt5_order_blocked_risk_max_loss":
                last_block_reason = "max_loss_exceeded"
            elif category == "mt5_order_requires_confirm_target_gain":
                last_block_reason = "target_gain_below_objective"
            else:
                last_block_reason = "non_compliant_execution"

    window_rows = rows[:safe_window]
    miss_in_window = sum(1 for row in window_rows if not _is_compliant(row))
    ratio_miss_window = miss_in_window / safe_window if safe_window > 0 else 0.0
    return {
        "count_ok": count_ok,
        "count_miss": count_miss,
        "last_block_reason": last_block_reason,
        "window_size": safe_window,
        "miss_in_window": miss_in_window,
        "ratio_miss_window": ratio_miss_window,
        "miss_threshold": safe_miss_threshold,
        "alert": miss_in_window >= safe_miss_threshold,
    }


@app.get("/v1/mt5/orders/risk-history/export")
async def mt5_orders_risk_history_export(
    format: str = "json",
    limit: int = 1000,
    symbol: str | None = None,
    account_id: str | None = None,
    from_ts: str | None = None,
    to_ts: str | None = None,
    auth: AuthContext = Depends(viewer_auth),
):
    del auth
    safe_limit = max(1, min(limit, 5000))
    format_value = format.strip().lower()
    if format_value not in {"json", "csv"}:
        raise HTTPException(status_code=400, detail="format must be json or csv")

    filters: list[str] = [
        "category IN ('mt5_order_accepted', 'mt5_order_blocked_risk_max_loss', 'mt5_order_requires_confirm_target_gain')"
    ]
    params: list[object] = []
    symbol_value = (symbol or "").strip().upper()
    account_value = (account_id or "").strip()
    if symbol_value:
        filters.append("UPPER(COALESCE(payload->>'symbol', '')) = %s")
        params.append(symbol_value)
    if account_value:
        filters.append("COALESCE(payload->>'account_id', '') = %s")
        params.append(account_value)

    from_dt = _parse_iso_utc(from_ts)
    to_dt = _parse_iso_utc(to_ts)
    if from_ts and not from_dt:
        raise HTTPException(status_code=400, detail="invalid from_ts")
    if to_ts and not to_dt:
        raise HTTPException(status_code=400, detail="invalid to_ts")
    if from_dt and to_dt and from_dt > to_dt:
        raise HTTPException(status_code=400, detail="from_ts must be <= to_ts")
    if from_dt:
        filters.append("created_at >= %s")
        params.append(from_dt)
    if to_dt:
        filters.append("created_at <= %s")
        params.append(to_dt)

    rows = fetch_all(
        f"""
        SELECT category, payload, created_at AS timestamp
        FROM audit_events
        WHERE {' AND '.join(filters)}
        ORDER BY id DESC
        LIMIT %s
        """,
        tuple([*params, safe_limit]),
    )

    if format_value == "json":
        return JSONResponse(content=rows)

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(
        [
            "timestamp",
            "category",
            "symbol",
            "account_id",
            "side",
            "risk_usd",
            "reward_usd",
            "max_loss_usd",
            "target_gain_usd",
            "target_rr",
            "compliant",
            "reason",
        ]
    )
    for row in rows:
        payload = row.get("payload") if isinstance(row.get("payload"), dict) else {}
        risk_context = payload.get("risk_context") if isinstance(payload, dict) and isinstance(payload.get("risk_context"), dict) else {}
        category = str(row.get("category") or "")
        reason = ""
        if category == "mt5_order_blocked_risk_max_loss":
            reason = "max_loss_exceeded"
        elif category == "mt5_order_requires_confirm_target_gain":
            reason = "target_gain_below_objective"
        elif category == "mt5_order_accepted":
            reason = "accepted"
        writer.writerow(
            [
                str(row.get("timestamp") or ""),
                category,
                str(payload.get("symbol") or ""),
                str(payload.get("account_id") or ""),
                str(payload.get("side") or ""),
                _to_float(risk_context.get("risk_usd"), 0.0),
                _to_float(risk_context.get("reward_usd"), 0.0),
                _to_float(risk_context.get("max_loss_usd"), 0.0),
                _to_float(risk_context.get("target_gain_usd"), 0.0),
                _to_float(risk_context.get("target_rr"), 0.0),
                bool(risk_context.get("compliant")),
                reason,
            ]
        )

    return PlainTextResponse(content=output.getvalue(), media_type="text/csv")


@app.post("/v1/mt5/orders/live-approve/{approval_id}")
async def mt5_live_second_approve(approval_id: str, auth: AuthContext = Depends(operator_auth)) -> dict:
    approval = fetch_one(
        """
        SELECT approval_id, account_id, order_payload, first_approved_by, status
        FROM mt5_live_approvals
        WHERE approval_id = %s
        """,
        (approval_id,),
    )
    if not approval:
        raise HTTPException(status_code=404, detail="Approval request not found")
    if approval["status"] != "pending":
        raise HTTPException(status_code=409, detail="Approval already resolved")
    if approval["first_approved_by"] == auth.username:
        raise HTTPException(status_code=403, detail="Second approval must be from a different operator")

    order_payload = approval["order_payload"] if isinstance(approval["order_payload"], dict) else {}
    metadata = order_payload.setdefault("metadata", {}) if isinstance(order_payload, dict) else {}
    if isinstance(metadata, dict):
        metadata["governance"] = {
            "approved": True,
            "approver": auth.username,
            "approval_id": approval_id,
            "approval_mode": "mt5_double_approval",
        }
    body = await _execute_mt5_filtered_order(order_payload)
    execute(
        """
        UPDATE mt5_live_approvals
        SET second_approved_by = %s,
            status = 'executed',
            execution_result = %s::jsonb,
            executed_at = NOW()
        WHERE approval_id = %s
        """,
        (auth.username, json_dumps(body), approval_id),
    )
    append_audit(
        "mt5_live_order_executed_double_approved",
        {
            "approval_id": approval_id,
            "first_approved_by": approval["first_approved_by"],
            "second_approved_by": auth.username,
            "result": body,
        },
    )
    return {"status": "executed", "approval_id": approval_id, "result": body}


async def _risk_check_mt5_order(payload: dict) -> dict:
    risk_payload = {
        "account_id": payload.get("account_id", ""),
        "symbol": payload.get("symbol", ""),
        "side": payload.get("side", "buy"),
        "lots": payload.get("lots", 0),
        "estimated_notional_usd": payload.get("estimated_notional_usd", 0),
        "max_spread_bps": payload.get("max_spread_bps", 0),
        "system_mode": CURRENT_SYSTEM_MODE.value,
    }
    async with httpx.AsyncClient(timeout=12.0) as client:
        response = await client.post(f"{RISK_GATEWAY_URL}/v1/checks/mt5-order", json=risk_payload)
        return response.json()


def _normalize_symbol(symbol: str) -> str:
    return symbol.replace("-PERP", "").replace("/", "").replace("-", "").upper()


def _market_data_symbol(venue: str, symbol: str) -> str:
    normalized = _normalize_symbol(symbol)
    if venue in {"binance-public", "coinbase-public", "okx-public"} and normalized.endswith("USD") and not normalized.endswith("USDT"):
        return f"{normalized[:-3]}USDT"
    return normalized


async def _compute_route_plan(
    symbol: str,
    predictor_context: dict | None = None,
    *,
    infra_health: float | None = None,
    network_regime: str | None = None,
) -> dict:
    normalized_symbol = _normalize_symbol(symbol)
    resolved_infra = _resolve_infra_context(predictor_context, infra_health=infra_health, network_regime=network_regime)

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            router_response = await client.get(
                f"{EXECUTION_ROUTER_URL}/v1/routes/score",
                params={
                    "symbol": normalized_symbol,
                    "infra_health": _to_float(resolved_infra.get("infra_health"), 1.0),
                    "network_regime": str(resolved_infra.get("network_regime") or "stable"),
                },
            )
            if router_response.status_code < 400:
                payload = router_response.json()
                if isinstance(payload, dict) and payload.get("best"):
                    payload.setdefault("infra_health", _to_float(resolved_infra.get("infra_health"), 1.0))
                    payload.setdefault("network_regime", str(resolved_infra.get("network_regime") or "stable"))
                    failure_attribution = _route_failure_attribution(payload, resolved_infra)
                    payload.setdefault("failure_source", failure_attribution.get("failure_source"))
                    payload.setdefault("failure_reasons", failure_attribution.get("failure_reasons"))
                    payload.setdefault("failure_blocking", bool(failure_attribution.get("failure_blocking")))
                    return payload
    except Exception:
        pass

    candidates: list[dict] = []
    infra_factor = max(
        0.05,
        min(
            1.0,
            _to_float(resolved_infra.get("infra_health"), 1.0)
            - (0.22 if str(resolved_infra.get("network_regime") or "stable") == "critical" else 0.08 if str(resolved_infra.get("network_regime") or "stable") == "degraded" else 0.0),
        ),
    )
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            quotes_response = await client.get(f"{MARKET_DATA_URL}/v1/quotes")
            quotes = quotes_response.json() if quotes_response.status_code < 400 else []
            market_symbol = _market_data_symbol("binance-public", normalized_symbol)
            matching_quotes = [quote for quote in quotes if _normalize_symbol(str(quote.get("instrument", ""))) == market_symbol]
            depth_responses = await asyncio.gather(
                *[
                    client.get(
                        f"{MARKET_DATA_URL}/v1/market/orderbook/depth",
                        params={"venue": str(quote.get("venue", "unknown")), "instrument": _market_data_symbol(str(quote.get("venue", "unknown")), normalized_symbol)},
                    )
                    for quote in matching_quotes
                ],
                return_exceptions=True,
            )

            for quote, depth_response in zip(matching_quotes, depth_responses):
                venue = str(quote.get("venue", "unknown"))
                spread_bps = _to_float(quote.get("spread_bps"), 9999.0)
                depth_payload = depth_response.json() if not isinstance(depth_response, Exception) and depth_response.status_code < 400 else {}
                book = (depth_payload or {}).get("depth_payload", {})
                bid_depth_usd, ask_depth_usd, depth_levels = _aggregate_depth_payload(book)
                available_depth_usd = min(bid_depth_usd, ask_depth_usd) if bid_depth_usd > 0 and ask_depth_usd > 0 else max(bid_depth_usd, ask_depth_usd)
                freshness_ms = max(
                    _timestamp_age_ms(quote.get("updated_at")),
                    _timestamp_age_ms(depth_payload.get("snapshot_at")),
                    0,
                )
                latency_ms = max(15.0, min(2000.0, 20.0 + freshness_ms * 0.15))
                depth_confidence = 1.0 if depth_levels >= 4 else 0.45 if depth_levels >= 1 else 0.05
                liquidity_score = _clamp(math.log10(max(10.0, available_depth_usd)) / 6.0, 0.0, 1.0) if available_depth_usd > 0 else depth_confidence * 0.1
                fill_probability = _clamp((1 - min(spread_bps, 20.0) / 20.0) * 0.45 + liquidity_score * 0.35 + depth_confidence * 0.2, 0.03, 0.99)
                score = (liquidity_score * 0.4 + depth_confidence * 0.2 + (1 / max(1.0, latency_ms)) * 100 * 0.15 + fill_probability * 0.25) * infra_factor
                candidates.append(
                    {
                        "venue": venue,
                        "instrument": market_symbol,
                        "spread_bps": spread_bps,
                        "available_depth_usd": available_depth_usd,
                        "depth_levels": depth_levels,
                        "depth_confidence": depth_confidence,
                        "best_bid": _to_float(depth_payload.get("best_bid"), _to_float(quote.get("bid"), 0.0)),
                        "best_ask": _to_float(depth_payload.get("best_ask"), _to_float(quote.get("ask"), 0.0)),
                        "last": _to_float(quote.get("last"), _mid_from_quote_payload(quote)),
                        "latency_ms": latency_ms,
                        "freshness_ms": freshness_ms,
                        "liquidity": liquidity_score,
                        "fill_probability": fill_probability,
                        "score": score,
                        "infra_health": _to_float(resolved_infra.get("infra_health"), 1.0),
                        "network_regime": str(resolved_infra.get("network_regime") or "stable"),
                        "infra_factor": infra_factor,
                        "source": "v6-price-fusion-fallback",
                    }
                )
    except Exception:
        candidates = []

    candidates = sorted(candidates, key=lambda item: item["score"], reverse=True)
    context = _build_v6_route_context(candidates)
    reason = "best_v6_route_candidate_fallback" if context.get("best") else "no_market_candidates"
    failure_attribution = _route_failure_attribution(context, resolved_infra)
    return {
        "symbol": normalized_symbol,
        "best": context.get("best"),
        "backup": context.get("backup"),
        "fusion_price": context.get("fusion_price"),
        "deviation_bps": context.get("deviation_bps"),
        "arbitrage": context.get("arbitrage"),
        "source": "v6-price-fusion-fallback",
        "reason": reason,
        "infra_health": _to_float(resolved_infra.get("infra_health"), 1.0),
        "network_regime": str(resolved_infra.get("network_regime") or "stable"),
        "failure_source": failure_attribution.get("failure_source"),
        "failure_reasons": failure_attribution.get("failure_reasons"),
        "failure_blocking": bool(failure_attribution.get("failure_blocking")),
        "candidates": candidates,
    }


async def _execute_mt5_filtered_order(payload: dict) -> dict:
    _assert_kill_switch_allows_execution()
    ts_decision = _now_utc()
    ts_intent = _now_utc()
    payload_metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
    live_target = str(payload_metadata.get("go_live_target") or "").strip().lower()
    hardening_snapshot = None
    if live_target == "live":
        hardening_snapshot = _evaluate_go_live_hardening(
            source=str((payload.get("order_intent") or {}).get("source") if isinstance(payload.get("order_intent"), dict) else payload_metadata.get("source") or "mission-control-ui").strip() or "mission-control-ui",
            provider="mt5",
            account_id=_normalize_account_id(payload.get("account_id")),
            symbol=str(payload.get("symbol") or ""),
            side=str(payload.get("side") or "buy"),
            requested_notional_usd=_to_float(payload.get("estimated_notional_usd"), 0.0),
            confidence=_to_float(payload.get("confidence"), _to_float(payload_metadata.get("confidence"), 0.0)),
            live_requested=True,
            purpose="execute",
            pre_trade_memory_gate=_extract_pre_trade_memory_gate(payload),
            governance=_extract_trade_governance(payload),
        )
        if hardening_snapshot.get("status") != "approved":
            raise HTTPException(
                status_code=409,
                detail={
                    "status": "blocked_by_go_live_hardening",
                    "hardening": hardening_snapshot,
                },
            )

    risk_body = await _risk_check_mt5_order(payload)
    if risk_body.get("decision") != "accept":
        append_audit("mt5_order_rejected", {"risk": risk_body})
        raise HTTPException(status_code=400, detail=risk_body)

    routing = await _compute_route_plan(str(payload.get("symbol", "")), _predictor_context(payload))
    ts_routing = _now_utc()
    route_best = routing.get("best") or {}
    route_backup = routing.get("backup") or {}
    preferred_venue = str(payload.get("preferred_venue") or route_best.get("venue") or "").strip()
    predictor_gate = await _evaluate_predictor_gate(payload, routing, risk_body, preferred_venue)
    if not predictor_gate.get("allow_execution"):
        append_audit(
            "mt5_order_blocked_predictor",
            {
                "account_id": payload.get("account_id", ""),
                "symbol": payload.get("symbol", ""),
                "side": payload.get("side", "buy"),
                "reasons": predictor_gate.get("reasons", []),
                "brain_action": predictor_gate.get("brain_action"),
            },
        )
        raise HTTPException(status_code=409, detail={"status": "blocked_by_predictor", "predictor": predictor_gate})

    adjusted_payload = _apply_predictor_execution_adjustments(payload, predictor_gate)

    routed_execution_result: dict = {}
    rust_execution_result = await _call_rust_execution_engine(adjusted_payload, routing, risk_body, preferred_venue)
    if isinstance(rust_execution_result, dict) and rust_execution_result.get("accepted"):
        routed_execution_result = {
            "decision_id": rust_execution_result.get("decision_id"),
            "route": rust_execution_result.get("route"),
            "fills": rust_execution_result.get("fills") or [],
            "expected_slippage_bps": rust_execution_result.get("expected_slippage_bps"),
            "fill_quality_score": rust_execution_result.get("fill_quality_score"),
            "engine": rust_execution_result.get("engine", "rust-execution-engine"),
            "hedge_guard": rust_execution_result.get("hedge_guard") or {},
            "arb_plan": rust_execution_result.get("arb_plan"),
            "reality_gap_sample": rust_execution_result.get("reality_gap_sample") if isinstance(rust_execution_result.get("reality_gap_sample"), dict) else None,
        }
    else:
        router_decision_id = f"route-{uuid4()}"
        async with httpx.AsyncClient(timeout=12.0) as client:
            router_response = await client.post(
                f"{EXECUTION_ROUTER_URL}/v1/orders/routed",
                json={
                    "decision_id": router_decision_id,
                    "order_id": f"routed-{router_decision_id}",
                    "intent_id": adjusted_payload.get("strategy_id", "mt5-live"),
                    "execution_mode": "routed-mt5",
                    "account_id": adjusted_payload.get("account_id", ""),
                    "symbol": _normalize_symbol(str(adjusted_payload.get("symbol", ""))),
                    "side": adjusted_payload.get("side", "buy"),
                    "lots": adjusted_payload.get("lots", 0),
                    "estimated_notional_usd": adjusted_payload.get("estimated_notional_usd", 0),
                    "max_spread_bps": adjusted_payload.get("max_spread_bps", 0),
                    "preferred_venue": str(adjusted_payload.get("preferred_venue") or preferred_venue),
                    "infra_health": _to_float(_resolve_infra_context(_predictor_context(adjusted_payload)).get("infra_health"), 1.0),
                    "network_regime": str(_resolve_infra_context(_predictor_context(adjusted_payload)).get("network_regime") or "stable"),
                },
            )
            if router_response.status_code < 400:
                routed_execution_result = router_response.json()
            else:
                _record_api_error("execution-router", "routed_order_failed")
                raise HTTPException(
                    status_code=502 if router_response.status_code >= 500 else router_response.status_code,
                    detail=_upstream_json_payload(router_response),
                )

    selected_route = ((routed_execution_result.get("route") or {}).get("chosen") or route_best)
    selected_backup = ((routed_execution_result.get("route") or {}).get("backup") or route_backup)

    bridge_payload = dict(adjusted_payload)
    bridge_payload["risk_gate"] = risk_body
    bridge_payload["routing_plan"] = routing
    bridge_payload["chosen_route"] = selected_route
    bridge_payload["expected_slippage_bps"] = routed_execution_result.get("expected_slippage_bps")
    bridge_payload["predictor"] = predictor_gate
    if hardening_snapshot is not None:
        bridge_payload.setdefault("metadata", {})
        if isinstance(bridge_payload.get("metadata"), dict):
            bridge_payload["metadata"]["go_live_hardening"] = hardening_snapshot
    async with httpx.AsyncClient(timeout=12.0) as client:
        response = await client.post(f"{MT5_BRIDGE_URL}/v1/orders/filter", json=bridge_payload)
        if response.status_code >= 400:
            _record_api_error("mt5-bridge", "order_filter_failed")
            if 400 <= response.status_code < 500:
                try:
                    bridge_error: Any = response.json()
                except Exception:
                    bridge_error = response.text[:1000] or "MT5 bridge rejected order"
                if isinstance(bridge_error, dict) and "detail" in bridge_error:
                    bridge_error = bridge_error["detail"]
                raise HTTPException(status_code=response.status_code, detail=bridge_error)
            raise HTTPException(status_code=502, detail="MT5 bridge unavailable")
        result = response.json()
        _record_slippage_event(float(result.get("realized_slippage_bps", 0.0)), "mt5-bridge")
        ts_broker_accept = _now_utc()
        latency_bridge_ms = int(result.get("latency_ms", 0))
        fill_partial_ms = max(20, int(latency_bridge_ms * 0.55))
        fill_final_ms = max(fill_partial_ms, latency_bridge_ms)
        ts_fill_partial = ts_broker_accept + timedelta(milliseconds=fill_partial_ms)
        ts_fill_final = ts_broker_accept + timedelta(milliseconds=fill_final_ms)
        latency_e2e_ms = int((ts_fill_final - ts_decision).total_seconds() * 1000)
        expected_slippage_bps = float(routed_execution_result.get("expected_slippage_bps", float(payload.get("max_spread_bps", 0.0)) * 0.8))
        realized_slippage_bps = float(result.get("realized_slippage_bps", 0.0))

        execute(
            """
            INSERT INTO decision_outcomes (decision_id, source, strategy_id, symbol, provider, regime, score_pre_trade,
                                           slippage_real_bps, latency_ms, status)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, 'pending')
            ON CONFLICT (decision_id) DO NOTHING
            """,
            (
                str(result.get("broker_ticket", str(uuid4()))),
                "mt5",
                str(payload.get("strategy_id", "mt5-live")),
                str(payload.get("symbol", "")),
                "mt5-bridge",
                str(payload.get("regime", "unknown")),
                payload.get("score_pre_trade"),
                float(result.get("realized_slippage_bps", 0.0)),
                int(result.get("latency_ms", 0)),
            ),
        )

        telemetry_id = str(uuid4())
        execute(
            """
            INSERT INTO execution_telemetry (
              telemetry_id, decision_id, account_id, symbol, side, lots,
              route_chosen, route_backup, route_reason, route_score, backup_score,
              quote_spread_bps, available_depth_usd,
              expected_slippage_bps, realized_slippage_bps, latency_e2e_ms,
              ts_decision, ts_intent, ts_routing, ts_broker_accept, ts_fill_partial, ts_fill_final,
              payload
            ) VALUES (
              %s, %s, %s, %s, %s, %s,
              %s, %s, %s, %s, %s,
              %s, %s,
              %s, %s, %s,
              %s, %s, %s, %s, %s, %s,
              %s::jsonb
            )
            """,
            (
                telemetry_id,
                str(result.get("broker_ticket", str(uuid4()))),
                str(payload.get("account_id", "")),
                str(payload.get("symbol", "")),
                str(payload.get("side", "")),
                float(payload.get("lots", 0.0)),
                str(selected_route.get("venue", "mt5-default")),
                str(selected_backup.get("venue", "")),
                str(routing.get("reason", "")),
                float(selected_route.get("score", 0.0)),
                float(selected_backup.get("score", 0.0)) if selected_backup else None,
                float(selected_route.get("spread_bps", selected_route.get("spread", 0.0))),
                float(selected_route.get("available_depth_usd", 0.0)),
                expected_slippage_bps,
                realized_slippage_bps,
                latency_e2e_ms,
                ts_decision,
                ts_intent,
                ts_routing,
                ts_broker_accept,
                ts_fill_partial,
                ts_fill_final,
                json_dumps({"routing": routing, "bridge_result": result, "risk": risk_body, "router_execution": routed_execution_result, "predictor": predictor_gate, "rust_reality_gap": routed_execution_result.get("reality_gap_sample"), "go_live_hardening": hardening_snapshot}),
            ),
        )

        append_audit(
            "execution_telemetry_recorded",
            {
                "telemetry_id": telemetry_id,
                **_execution_audit_summary(
                    decision_id=str(result.get("broker_ticket", "")),
                    route=str(selected_route.get("venue", "mt5-default")),
                    reason=str(routing.get("reason", "")),
                    expected_slippage_bps=expected_slippage_bps,
                    realized_slippage_bps=realized_slippage_bps,
                    latency_e2e_ms=latency_e2e_ms,
                    requested_payload=payload,
                    execution_result=result,
                ),
            },
        )
        reality_gap_result = await _auto_ingest_reality_gap_for_decision(
            str(result.get("broker_ticket", "")),
            {
                "source": "mt5-post-trade",
                "status": "executed",
                "symbol": str(payload.get("symbol", "")),
                "regime": str(payload.get("regime", "unknown")),
                "slippage_real_bps": realized_slippage_bps,
                "latency_ms": latency_e2e_ms,
            },
            native_sample=routed_execution_result.get("reality_gap_sample") if isinstance(routed_execution_result.get("reality_gap_sample"), dict) else None,
        )
        if routed_execution_result:
            result["routed_execution"] = {
                "decision_id": routed_execution_result.get("decision_id"),
                "venue": ((routed_execution_result.get("route") or {}).get("chosen") or {}).get("venue"),
                "fill_count": len(routed_execution_result.get("fills", [])),
                "expected_slippage_bps": routed_execution_result.get("expected_slippage_bps"),
                "fill_quality_score": routed_execution_result.get("fill_quality_score"),
                "engine": routed_execution_result.get("engine", "execution-router"),
                "hedge_guard": routed_execution_result.get("hedge_guard") or {},
                "arb_plan": routed_execution_result.get("arb_plan"),
            }
        result["predictor"] = predictor_gate
        result["reality_gap"] = reality_gap_result
        if hardening_snapshot is not None:
            result["go_live_hardening"] = hardening_snapshot
        synced_state = await _sync_mt5_account_state(str(payload.get("account_id", "")).strip())
        if synced_state:
            result["canonical_account_state"] = synced_state
        return result


async def _compute_connectors_snapshot(auth: AuthContext | None = None) -> dict:
    async with httpx.AsyncClient(timeout=8.0) as client:
        async def _probe(url: str) -> tuple[bool, float | None]:
            started = time.perf_counter()
            try:
                response = await client.get(url)
                return response.status_code < 500, (time.perf_counter() - started) * 1000.0
            except Exception:
                return False, None

        mt5_ok, mt5_latency_ms = await _probe(f"{MT5_BRIDGE_URL}/health")
        market_ok, market_latency_ms = await _probe(f"{MARKET_DATA_URL}/health")
        broker_ok, broker_latency_ms = await _probe(f"{BROKER_ADAPTER_URL}/health")
        ai_ok, ai_latency_ms = await _probe(f"{AI_ORCHESTRATOR_URL}/health")
        embeddings_ok, embeddings_latency_ms = await _probe(f"{EMBEDDINGS_SERVICE_URL}/health")

    pending = fetch_one("SELECT COUNT(*) AS count FROM mt5_live_approvals WHERE status = 'pending'") or {"count": 0}
    recent_approvals = fetch_all(
        """
        SELECT approval_id, account_id, first_approved_by, second_approved_by, status, created_at, executed_at
        FROM mt5_live_approvals
        ORDER BY created_at DESC
        LIMIT 10
        """
    )
    kill_state = _kill_switch_state()
    unassigned_sla = fetch_one(
        """
        SELECT COUNT(*) AS count
        FROM incident_tickets
        WHERE status IN ('open', 'assigned')
          AND assignee IS NULL
          AND NOW() - created_at >= (%s * INTERVAL '1 minute')
        """,
        (_incident_unassigned_alert_minutes(),),
    ) or {"count": 0}
    alerts: list[dict] = []
    if kill_state.get("active"):
        alerts.append({"level": "critical", "type": "kill_switch", "message": f"Kill switch active: {kill_state.get('reason', 'unknown')}"})
    if int(pending["count"]) > 0:
        alerts.append({"level": "warning", "type": "pending_live_approvals", "message": f"{int(pending['count'])} live approval(s) pending"})
    if int(unassigned_sla["count"]) > 0:
        alerts.append(
            {
                "level": "warning",
                "type": "incidents_unassigned_sla",
                "message": f"{int(unassigned_sla['count'])} incident(s) unassigned over {_incident_unassigned_alert_minutes()} min",
            }
        )

    health_by_group = {
        "market": market_ok,
        "broker": broker_ok,
        "mt5": mt5_ok,
        "ai": ai_ok,
        "embeddings": embeddings_ok,
    }
    latency_by_group = {
        "market": market_latency_ms,
        "broker": broker_latency_ms,
        "mt5": mt5_latency_ms,
        "ai": ai_latency_ms,
        "embeddings": embeddings_latency_ms,
    }
    visible_client_ids = _visible_client_ids(auth) if auth is not None else None
    linked_accounts = _filter_connector_accounts_for_auth(_load_connector_accounts(), auth) if auth is not None else _load_connector_accounts()
    linked_accounts_by_provider: dict[str, list[dict[str, Any]]] = {}
    for account in linked_accounts:
        provider = _normalize_connector_provider(account.get("provider"))
        linked_accounts_by_provider.setdefault(provider, []).append(account)
    recent_incidents = _normalize_db_rows(
        fetch_all(
            """
            SELECT ticket_key, severity, title, status, assignee, source, payload, created_by,
                   resolution_note, closed_by, closed_at, created_at, updated_at,
                   ROUND(EXTRACT(EPOCH FROM (NOW() - created_at)) / 60.0, 1) AS age_minutes
            FROM incident_tickets
            WHERE created_at >= NOW() - INTERVAL '7 days'
            ORDER BY created_at DESC
            LIMIT 400
            """
        )
    )
    incident_summary = _build_connector_incident_summary(recent_incidents)
    outcome_summary = _connector_outcome_analytics()

    return {
        "status": "ok",
        "observed_at": _now_utc().isoformat(),
        "pending_live_approvals": int(pending["count"]),
        "incident_unassigned_sla_count": int(unassigned_sla["count"]),
        "kill_switch": kill_state,
        "recent_live_approvals": recent_approvals,
        "alerts": alerts,
        "linked_accounts_count": len(linked_accounts),
        "linked_accounts": [
            {
                **(_connector_account_public_view(account) or {}),
                "permissions_view": _derive_connector_permission_view(account),
            }
            for account in linked_accounts
        ],
        "connectors": [
            _connector_row_payload(
                connector,
                healthy=bool(health_by_group.get(connector.get("health_group", "market"), False)),
                rest_latency_ms=latency_by_group.get(connector.get("health_group", "market")),
                linked_accounts=linked_accounts_by_provider.get(_normalize_connector_provider(connector.get("name")), []),
                visible_client_ids=visible_client_ids,
                incident_summary=incident_summary,
                outcome_summary=outcome_summary,
            )
            for connector in CONNECTOR_CATALOG
        ],
    }


@app.post("/v1/outcomes/{decision_id}/update")
async def update_outcome(decision_id: str, payload: dict, auth: AuthContext = Depends(operator_auth)) -> dict:
    execute(
        """
        INSERT INTO decision_outcomes (decision_id, source, strategy_id, symbol, provider, regime, score_pre_trade,
                                       pnl_5m, pnl_1h, pnl_24h, mae, mfe, slippage_real_bps, latency_ms, fees_usd, net_result_usd, status, updated_at)
        VALUES (%s, %s, %s, %s, %s, %s, %s,
                %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW())
        ON CONFLICT (decision_id) DO UPDATE SET
            pnl_5m = EXCLUDED.pnl_5m,
            pnl_1h = EXCLUDED.pnl_1h,
            pnl_24h = EXCLUDED.pnl_24h,
            mae = EXCLUDED.mae,
            mfe = EXCLUDED.mfe,
            slippage_real_bps = EXCLUDED.slippage_real_bps,
            latency_ms = EXCLUDED.latency_ms,
            fees_usd = EXCLUDED.fees_usd,
            net_result_usd = EXCLUDED.net_result_usd,
            status = EXCLUDED.status,
            updated_at = NOW()
        """,
        (
            decision_id,
            payload.get("source", "manual"),
            payload.get("strategy_id"),
            payload.get("symbol"),
            payload.get("provider"),
            payload.get("regime"),
            payload.get("score_pre_trade"),
            payload.get("pnl_5m"),
            payload.get("pnl_1h"),
            payload.get("pnl_24h"),
            payload.get("mae"),
            payload.get("mfe"),
            payload.get("slippage_real_bps"),
            payload.get("latency_ms"),
            payload.get("fees_usd"),
            payload.get("net_result_usd"),
            payload.get("status", "finalized"),
        ),
    )
    _recompute_drawdown_guard()
    _recompute_strategy_drift_state(
        strategy_id=str(payload.get("strategy_id") or "") or None,
        regime=str(payload.get("regime") or "") or None,
    )
    execute(
        """
        UPDATE memory_ab_events
        SET outcome_net_result_usd = %s
        WHERE decision_id = %s
        """,
        (_to_float(payload.get("net_result_usd"), 0.0), decision_id),
    )
    telemetry_row = fetch_one(
        """
        SELECT decision_id, symbol, side, quote_spread_bps, available_depth_usd,
               expected_slippage_bps, realized_slippage_bps, latency_e2e_ms, payload, created_at
        FROM execution_telemetry
        WHERE decision_id = %s
        ORDER BY created_at DESC
        LIMIT 1
        """,
        (decision_id,),
    )
    learning_experience = _build_brain_learning_experience(decision_id, payload, telemetry_row)
    if learning_experience:
        await _dispatch_predictor_brain_learn([learning_experience])
    reality_gap_result = await _auto_ingest_reality_gap_for_decision(decision_id, payload)
    append_audit("outcome_updated", {"decision_id": decision_id, "by": auth.username})
    return {"status": "updated", "decision_id": decision_id, "reality_gap": reality_gap_result}


@app.get("/v1/outcomes/recent")
async def recent_outcomes(limit: int = 50, auth: AuthContext = Depends(viewer_auth)) -> list[dict]:
    del auth
    safe_limit = max(1, min(limit, 500))
    return fetch_all(
        """
        SELECT decision_id, source, strategy_id, symbol, provider, regime,
               score_pre_trade, pnl_5m, pnl_1h, pnl_24h, mae, mfe,
               slippage_real_bps, latency_ms, fees_usd, net_result_usd,
               status, created_at, updated_at
        FROM decision_outcomes
        ORDER BY updated_at DESC
        LIMIT %s
        """,
        (safe_limit,),
    )


@app.get("/v1/outcomes/calibration")
async def outcomes_calibration(auth: AuthContext = Depends(viewer_auth)) -> dict:
    del auth
    rows = fetch_all(
        """
        SELECT
            FLOOR(COALESCE(score_pre_trade, 0) * 10) / 10.0 AS score_bucket,
            COUNT(*) AS sample_count,
            AVG(COALESCE(net_result_usd, 0)) AS avg_net_result_usd,
            AVG(CASE WHEN COALESCE(net_result_usd, 0) > 0 THEN 1 ELSE 0 END) AS win_rate
        FROM decision_outcomes
        WHERE score_pre_trade IS NOT NULL
        GROUP BY score_bucket
        ORDER BY score_bucket
        """
    )
    return {"status": "ok", "buckets": rows}


@app.get("/v1/strategies/drift")
async def strategies_drift(auth: AuthContext = Depends(viewer_auth)) -> dict:
    del auth
    rows = fetch_all(
        """
        SELECT strategy_id, regime, window_hours, sample_count, win_rate,
               avg_net_result_usd, drawdown_usd, drift_detected, auto_suspended,
               auto_resumed, cooldown_until, reason, updated_at
        FROM strategy_health_state
        ORDER BY updated_at DESC
        LIMIT 200
        """
    )
    return {"status": "ok", "window_hours": _drift_window_hours(), "items": rows}


@app.get("/v1/strategies/drift-thresholds")
async def strategy_drift_thresholds(auth: AuthContext = Depends(viewer_auth)) -> dict:
    del auth
    rows = fetch_all(
        """
        SELECT regime, min_samples, min_win_rate, max_drawdown_usd, max_avg_loss_usd, updated_at
        FROM strategy_regime_thresholds
        ORDER BY regime
        """
    )
    return {"status": "ok", "items": rows}


@app.post("/v1/strategies/drift-thresholds")
async def upsert_strategy_drift_threshold(payload: dict, auth: AuthContext = Depends(operator_auth)) -> dict:
    regime = str(payload.get("regime", "")).strip().lower()
    if not regime:
        raise HTTPException(status_code=400, detail="regime is required")
    min_samples = max(5, int(payload.get("min_samples", 20)))
    min_win_rate = _clamp01(_to_float(payload.get("min_win_rate"), 0.48))
    max_drawdown_usd = max(10.0, _to_float(payload.get("max_drawdown_usd"), 800.0))
    max_avg_loss_usd = max(5.0, _to_float(payload.get("max_avg_loss_usd"), 120.0))
    execute(
        """
        INSERT INTO strategy_regime_thresholds (regime, min_samples, min_win_rate, max_drawdown_usd, max_avg_loss_usd, updated_at)
        VALUES (%s, %s, %s, %s, %s, NOW())
        ON CONFLICT (regime) DO UPDATE SET
            min_samples = EXCLUDED.min_samples,
            min_win_rate = EXCLUDED.min_win_rate,
            max_drawdown_usd = EXCLUDED.max_drawdown_usd,
            max_avg_loss_usd = EXCLUDED.max_avg_loss_usd,
            updated_at = NOW()
        """,
        (regime, min_samples, min_win_rate, max_drawdown_usd, max_avg_loss_usd),
    )
    _recompute_strategy_drift_state(regime=regime)
    append_audit("strategy_drift_threshold_updated", {"regime": regime, "by": auth.username})
    return {
        "status": "ok",
        "item": {
            "regime": regime,
            "min_samples": min_samples,
            "min_win_rate": min_win_rate,
            "max_drawdown_usd": max_drawdown_usd,
            "max_avg_loss_usd": max_avg_loss_usd,
        },
    }


@app.post("/v1/strategies/{strategy_id}/resume")
async def resume_strategy(strategy_id: str, auth: AuthContext = Depends(operator_auth)) -> dict:
    execute(
        "UPDATE strategies SET status = 'active', updated_at = NOW() WHERE strategy_id = %s",
        (strategy_id,),
    )
    append_audit("strategy_resumed_manual", {"strategy_id": strategy_id, "by": auth.username})
    return {"status": "ok", "strategy_id": strategy_id, "new_status": "active"}


@app.get("/v1/experiments/memory-ab")
async def memory_ab_stats(window_hours: int = 24 * 7, auth: AuthContext = Depends(viewer_auth)) -> dict:
    del auth
    window = max(24, min(24 * 30, window_hours))
    summary = fetch_all(
        """
        SELECT arm,
               COUNT(*) AS samples,
               AVG(COALESCE(score_after, 0)) AS avg_score_after,
               AVG(CASE WHEN COALESCE(outcome_net_result_usd, 0) > 0 THEN 1 ELSE 0 END) AS win_rate,
               AVG(COALESCE(outcome_net_result_usd, 0)) AS avg_outcome
        FROM memory_ab_events
        WHERE created_at >= NOW() - (%s * INTERVAL '1 hour')
        GROUP BY arm
        ORDER BY arm
        """,
        (window,),
    )
    by_arm = {str(row.get("arm", "")): row for row in summary}
    on_row = by_arm.get("memory_on", {})
    off_row = by_arm.get("memory_off", {})
    on_n = int(on_row.get("samples") or 0)
    off_n = int(off_row.get("samples") or 0)
    on_w = int(round(_to_float(on_row.get("win_rate"), 0.0) * on_n))
    off_w = int(round(_to_float(off_row.get("win_rate"), 0.0) * off_n))
    p_value = _two_proportion_p_value(on_w, on_n, off_w, off_n)
    effect = _to_float(on_row.get("win_rate"), 0.0) - _to_float(off_row.get("win_rate"), 0.0)

    return {
        "status": "ok",
        "window_hours": window,
        "arms": summary,
        "with_vs_without_memory": {
            "winrate_delta": round(effect, 6),
            "p_value_two_sided": round(p_value, 6) if p_value is not None else None,
            "significant_95": bool(p_value is not None and p_value < 0.05),
            "samples": {"memory_on": on_n, "memory_off": off_n},
        },
    }


@app.get("/v1/predictor/memory-v2")
async def predictor_memory_v2(auth: AuthContext = Depends(viewer_auth)) -> dict:
    del auth
    body = await _get_predictor_v8("/brain/memory-v2")
    if body is None:
        raise HTTPException(status_code=502, detail="predictor memory engine unavailable")
    return body


@app.post("/v1/predictor/memory-v2/query")
async def predictor_memory_v2_query(payload: dict, auth: AuthContext = Depends(viewer_auth)) -> dict:
    del auth
    body = await _call_predictor_v8("/brain/memory-v2/query", payload if isinstance(payload, dict) else {})
    if body is None:
        raise HTTPException(status_code=502, detail="predictor memory engine unavailable")
    return body


@app.get("/v1/predictor/memory-v2/decision/{decision_id}")
async def predictor_memory_v2_decision(decision_id: str, auth: AuthContext = Depends(viewer_auth)) -> dict:
    del auth
    body = await _query_predictor_memory_v2_for_decision(decision_id)
    if body is None:
        raise HTTPException(status_code=404, detail="predictor memory decision not found")
    return body


@app.get("/v1/incidents")
async def list_incidents(status: str = "", auth: AuthContext = Depends(viewer_auth)) -> dict:
    threshold = _incident_unassigned_alert_minutes()
    if status:
        rows = fetch_all(
            """
            SELECT ticket_key, severity, title, status, assignee, source, payload, created_by,
                   resolution_note, closed_by, closed_at, created_at, updated_at,
                   ROUND(EXTRACT(EPOCH FROM (NOW() - created_at)) / 60.0, 1) AS age_minutes,
                   CASE
                     WHEN status IN ('open', 'assigned') AND assignee IS NULL AND NOW() - created_at >= (%s * INTERVAL '1 minute')
                     THEN TRUE ELSE FALSE
                   END AS sla_breached
            FROM incident_tickets
            WHERE status = %s
            ORDER BY created_at DESC
            LIMIT 300
            """,
            (threshold, status),
        )
    else:
        rows = fetch_all(
            """
            SELECT ticket_key, severity, title, status, assignee, source, payload, created_by,
                   resolution_note, closed_by, closed_at, created_at, updated_at,
                   ROUND(EXTRACT(EPOCH FROM (NOW() - created_at)) / 60.0, 1) AS age_minutes,
                   CASE
                     WHEN status IN ('open', 'assigned') AND assignee IS NULL AND NOW() - created_at >= (%s * INTERVAL '1 minute')
                     THEN TRUE ELSE FALSE
                   END AS sla_breached
            FROM incident_tickets
            ORDER BY created_at DESC
            LIMIT 300
            """,
            (threshold,),
        )
    normalized_rows = _normalize_db_rows(rows)
    connector_summary = _build_connector_incident_summary(normalized_rows)
    enriched_items: list[dict[str, Any]] = []
    status_summary = {"open": 0, "assigned": 0, "closed": 0}
    severity_summary = {"low": 0, "medium": 0, "high": 0, "critical": 0}
    for row in normalized_rows:
        provider = _infer_connector_provider_from_incident(row)
        diagnostics = _incident_diagnostics_from_row(row)
        severity = str(row.get("severity") or "medium").strip().lower()
        current_status = str(row.get("status") or "open").strip().lower()
        if current_status in status_summary:
            status_summary[current_status] += 1
        if severity in severity_summary:
            severity_summary[severity] += 1
        provider_summary = connector_summary.get(provider, {}) if provider else {}
        row["provider"] = provider or None
        row["diagnostics"] = diagnostics
        row["connector_degradation"] = {
            "state": "critical" if severity == "critical" and current_status != "closed" else "degraded" if current_status != "closed" else "resolved",
            "fallback_path": ["ws-primary", "rest-fallback", "manual-desk"] if any("ws" in item for item in diagnostics) else ["rest-primary", "cached-state", "manual-desk"],
            "reroute_target": CONNECTOR_REROUTE_HINTS.get(provider or ""),
        }
        row["provider_uptime_24h_pct"] = provider_summary.get("uptime_24h_pct")
        row["provider_uptime_7d_pct"] = provider_summary.get("uptime_7d_pct")
        enriched_items.append(row)

    return {
        "status": "ok",
        "sla_minutes": threshold,
        "items": enriched_items,
        "summary": {
            "total": len(enriched_items),
            "sla_breached": len([item for item in enriched_items if item.get("sla_breached")]),
            "status": status_summary,
            "severity": severity_summary,
            "active_connector_incidents": sum(int(item.get("active_count") or 0) for item in connector_summary.values()),
        },
        "connector_summary": sorted(
            connector_summary.values(),
            key=lambda item: (int(item.get("active_count") or 0), int(item.get("critical_count") or 0), str(item.get("last_incident_at") or "")),
            reverse=True,
        ),
    }


@app.get("/v1/incidents/{ticket_key}")
async def get_incident(ticket_key: str, auth: AuthContext = Depends(viewer_auth)) -> dict:
    del auth
    row = fetch_one(
        """
        SELECT ticket_key, severity, title, status, assignee, source, payload, created_by,
               resolution_note, closed_by, closed_at, created_at, updated_at,
               ROUND(EXTRACT(EPOCH FROM (NOW() - created_at)) / 60.0, 1) AS age_minutes
        FROM incident_tickets
        WHERE ticket_key = %s
        """,
        (ticket_key,),
    )
    if not row:
        raise HTTPException(status_code=404, detail="Incident not found")
    return row


@app.post("/v1/incidents/{ticket_key}/assign")
async def assign_incident(ticket_key: str, payload: dict, auth: AuthContext = Depends(operator_auth)) -> dict:
    assignee = str(payload.get("assignee") or "").strip() or auth.username
    execute(
        """
        UPDATE incident_tickets
        SET assignee = %s,
            status = CASE WHEN status = 'open' THEN 'assigned' ELSE status END,
            updated_at = NOW()
        WHERE ticket_key = %s
        """,
        (assignee, ticket_key),
    )
    append_audit("incident_assigned", {"ticket_key": ticket_key, "assignee": assignee, "by": auth.username})
    return {"status": "ok", "ticket_key": ticket_key, "assignee": assignee}


@app.post("/v1/incidents/{ticket_key}/close")
async def close_incident(ticket_key: str, payload: dict, auth: AuthContext = Depends(operator_auth)) -> dict:
    note = str(payload.get("resolution_note") or "Resolved by operator").strip()
    execute(
        """
        UPDATE incident_tickets
        SET status = 'closed',
            resolution_note = %s,
            closed_by = %s,
            closed_at = NOW(),
            updated_at = NOW()
        WHERE ticket_key = %s
        """,
        (note, auth.username, ticket_key),
    )
    append_audit("incident_closed", {"ticket_key": ticket_key, "by": auth.username})
    return {"status": "ok", "ticket_key": ticket_key, "closed_by": auth.username}


@app.post("/v1/audit/events")
async def append_audit_event(payload: dict, auth: AuthContext = Depends(viewer_auth)) -> dict:
    category = str(payload.get("category") or "").strip()
    event_payload = payload.get("payload") if isinstance(payload.get("payload"), dict) else None
    allowed = {
        "local_terminal_ohlcv_unusable",
        "local_terminal_bars_hard_fail",
        "local_terminal_ohlcv_renderable_recovered",
    }
    if category not in allowed:
        raise HTTPException(status_code=400, detail="audit_category_not_allowed")
    if event_payload is None:
        raise HTTPException(status_code=400, detail="audit_payload_required")
    append_audit(category, {
        **event_payload,
        "recorded_by": auth.username,
    })
    return {"status": "ok", "category": category}


@app.get("/v1/live-readiness/overview")
async def live_readiness_overview(auth: AuthContext = Depends(viewer_auth)) -> dict:
    async with httpx.AsyncClient(timeout=20.0) as client:
        retrieval_kpi_resp = await client.get(f"{EMBEDDINGS_SERVICE_URL}/v1/kpi/retrieval", params={"window_hours": 24})
    retrieval_kpi = retrieval_kpi_resp.json() if retrieval_kpi_resp.status_code < 400 else {"status": "degraded"}

    drift_items = fetch_all(
        """
        SELECT strategy_id, regime, sample_count, win_rate, drawdown_usd,
               drift_detected, auto_suspended, auto_resumed, cooldown_until, reason, updated_at
        FROM strategy_health_state
        ORDER BY updated_at DESC
        LIMIT 100
        """
    )
    suspended = fetch_all(
        """
        SELECT strategy_id, name, market, setup_type, status, updated_at
        FROM strategies
        WHERE status = 'suspended_drift'
        ORDER BY updated_at DESC
        """
    )
    ab = await memory_ab_stats(window_hours=24 * 7, auth=auth)
    return {
        "status": "ok",
        "memory_kpi": retrieval_kpi,
        "drift": {
            "window_hours": _drift_window_hours(),
            "items": drift_items,
            "suspended_strategies": suspended,
            "auto_resume": {
                "enabled": _auto_resume_enabled(),
                "cooldown_hours": _auto_resume_cooldown_hours(),
            },
        },
        "memory_ab": ab,
    }


async def _fetch_execution_ai_v6_state_snapshot() -> dict[str, Any]:
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(f"{EXECUTION_ROUTER_URL}/v1/execution-ai/v6/state")
        if response.status_code >= 400:
            return {"status": "degraded", "detail": response.text[:200]}
        payload = response.json()
        return payload if isinstance(payload, dict) else {"status": "degraded"}
    except Exception as exc:
        return {"status": "degraded", "detail": str(exc)[:200]}


def _format_signed_usd(value: float) -> str:
    return f"+{value:.2f} USD" if value > 0 else f"{value:.2f} USD"


def _build_ops_copilot_desk_brief(
    *,
    pnl_payload: dict[str, Any],
    readiness_payload: dict[str, Any],
    incidents_payload: dict[str, Any],
    strategies_payload: list[dict[str, Any]],
    execution_ai_v6_payload: dict[str, Any],
) -> dict[str, Any]:
    pnl_summary = pnl_payload.get("summary") if isinstance(pnl_payload.get("summary"), dict) else {}
    readiness_drift = readiness_payload.get("drift") if isinstance(readiness_payload.get("drift"), dict) else {}
    incidents = incidents_payload.get("items") if isinstance(incidents_payload.get("items"), list) else []
    v6_snapshot = execution_ai_v6_payload.get("snapshot") if isinstance(execution_ai_v6_payload.get("snapshot"), dict) else {}
    v6_guardrails = v6_snapshot.get("guardrails") if isinstance(v6_snapshot.get("guardrails"), dict) else {}

    trade_count = int(_to_float(pnl_summary.get("trade_count"), 0.0))
    net_pnl_usd = _to_float(pnl_summary.get("net_pnl_usd"), 0.0)
    avg_pnl_usd = _to_float(pnl_summary.get("avg_pnl_usd"), 0.0)
    win_rate_pct = _to_float(pnl_summary.get("win_rate_pct"), 0.0)
    avg_latency_ms = _to_float(pnl_summary.get("avg_latency_ms"), 0.0)
    avg_slippage_bps = _to_float(pnl_summary.get("avg_slippage_bps"), 0.0)
    high_confidence_loss_count = int(_to_float(pnl_summary.get("high_confidence_loss_count"), 0.0))
    no_trade_dominance_count = int(_to_float(pnl_summary.get("no_trade_dominance_count"), 0.0))
    no_trade_ratio_pct = (no_trade_dominance_count / trade_count * 100.0) if trade_count > 0 else 0.0
    suspended_strategies = readiness_drift.get("suspended_strategies") if isinstance(readiness_drift.get("suspended_strategies"), list) else []
    learning_frozen = bool(v6_guardrails.get("learning_frozen"))
    reward_ema = _to_float(v6_snapshot.get("reward_ema"), 0.0)

    truth_label = "OK"
    truth_reason = "guarded micro-live remains acceptable"
    if trade_count >= 5 and (high_confidence_loss_count >= 2 or (net_pnl_usd < 0 and win_rate_pct < 40.0)):
        truth_label = "BLOCK"
        truth_reason = "PnL truth is deteriorating and the filter needs review"
    elif trade_count < 3 or learning_frozen or avg_latency_ms > 120.0 or avg_slippage_bps > 3.0 or no_trade_ratio_pct < 10.0:
        truth_label = "REDUCE"
        truth_reason = "keep size minimal and let no-trade dominate harder"

    top_strategy = None
    if strategies_payload:
        ordered = sorted(
            strategies_payload,
            key=lambda item: (int(item.get("current_level") or 0), str(item.get("updated_at") or "")),
            reverse=True,
        )
        top_strategy = ordered[0]

    parts = [
        f"Desk truth {truth_label}. {truth_reason}.",
        f"PnL net {_format_signed_usd(net_pnl_usd)} sur {trade_count} trade(s), expectancy {_format_signed_usd(avg_pnl_usd)}, win rate {win_rate_pct:.1f}%.",
        f"Execution friction: {avg_latency_ms:.0f}ms de latence moyenne, {avg_slippage_bps:.2f}bps de slippage, {high_confidence_loss_count} perte(s) haute confiance.",
        f"No-trade dominance: {no_trade_dominance_count}/{trade_count or 1} trade(s), soit {no_trade_ratio_pct:.0f}% du flux observe.",
    ]
    if learning_frozen:
        parts.append(f"V6 reste figee pour le moment, reward EMA {reward_ema:.3f}.")
    else:
        parts.append(f"V6 reste active, reward EMA {reward_ema:.3f}.")
    if suspended_strategies:
        parts.append(f"Readiness: {len(suspended_strategies)} strategie(s) suspendue(s) pour drift.")
    if incidents:
        parts.append(f"Incidents ouverts: {len(incidents)}.")
    if top_strategy:
        parts.append(
            f"Strategie la plus avancee: {top_strategy.get('strategy_id')} niveau {int(top_strategy.get('current_level') or 0)} ({top_strategy.get('status')})."
        )
    parts.append("Calibration semi-auto: reste verrouillee tant que plusieurs jours de micro-live propre et au moins 50 trades n'ont pas ete accumules.")

    return {
        "status": "ok",
        "reply": " ".join(parts),
        "data": {
            "desk_truth": {
                "label": truth_label,
                "reason": truth_reason,
            },
            "pnl": pnl_payload,
            "readiness": readiness_payload,
            "incidents": incidents_payload,
            "execution_ai_v6": execution_ai_v6_payload,
            "strategy_progress": strategies_payload[:5],
        },
        "actions": ["open_live_ops", "open_terminal_truth", "open_live_readiness"],
    }


def _build_ops_copilot_command_brief(
    *,
    pnl_payload: dict[str, Any],
    readiness_payload: dict[str, Any],
    incidents_payload: dict[str, Any],
    strategies_payload: list[dict[str, Any]],
    execution_ai_v6_payload: dict[str, Any],
) -> dict[str, Any]:
    pnl_summary = pnl_payload.get("summary") if isinstance(pnl_payload.get("summary"), dict) else {}
    readiness_drift = readiness_payload.get("drift") if isinstance(readiness_payload.get("drift"), dict) else {}
    incidents = incidents_payload.get("items") if isinstance(incidents_payload.get("items"), list) else []
    trades = pnl_payload.get("trades") if isinstance(pnl_payload.get("trades"), list) else []
    v6_snapshot = execution_ai_v6_payload.get("snapshot") if isinstance(execution_ai_v6_payload.get("snapshot"), dict) else {}
    v6_guardrails = v6_snapshot.get("guardrails") if isinstance(v6_snapshot.get("guardrails"), dict) else {}

    trade_count = int(_to_float(pnl_summary.get("trade_count"), 0.0))
    net_pnl_usd = _to_float(pnl_summary.get("net_pnl_usd"), 0.0)
    avg_latency_ms = _to_float(pnl_summary.get("avg_latency_ms"), 0.0)
    avg_slippage_bps = _to_float(pnl_summary.get("avg_slippage_bps"), 0.0)
    win_rate_pct = _to_float(pnl_summary.get("win_rate_pct"), 0.0)
    high_confidence_loss_count = int(_to_float(pnl_summary.get("high_confidence_loss_count"), 0.0))
    no_trade_dominance_count = int(_to_float(pnl_summary.get("no_trade_dominance_count"), 0.0))
    no_trade_ratio_pct = (no_trade_dominance_count / trade_count * 100.0) if trade_count > 0 else 0.0
    learning_frozen = bool(v6_guardrails.get("learning_frozen"))
    persistence_available = bool(v6_guardrails.get("persistence_available", True))
    suspended_strategies = readiness_drift.get("suspended_strategies") if isinstance(readiness_drift.get("suspended_strategies"), list) else []
    negative_streak = 0
    for trade in trades:
        if _to_float((trade or {}).get("net_result_usd"), 0.0) < 0.0:
            negative_streak += 1
            continue
        break

    decision = "ENTRY SMALL"
    risk_label = "faible"
    reasons: list[str] = []

    if not persistence_available or (trade_count >= 5 and (high_confidence_loss_count >= 2 or (net_pnl_usd < 0.0 and win_rate_pct < 40.0))):
        decision = "STOP"
        risk_label = "eleve"
        reasons = [
            "verite PnL degradee" if persistence_available else "DB V6 indisponible",
            f"latence {avg_latency_ms:.0f}ms / slippage {avg_slippage_bps:.2f}bps",
            f"streak negatif {negative_streak}" if negative_streak >= 2 else f"loss haute confiance {high_confidence_loss_count}",
        ]
    elif no_trade_ratio_pct >= 70.0 or suspended_strategies:
        decision = "WAIT"
        risk_label = "eleve"
        reasons = [
            f"no-trade dominance {no_trade_ratio_pct:.0f}%",
            f"strategies suspendues {len(suspended_strategies)}" if suspended_strategies else "le flux reste trop filtre pour entrer",
            f"incidents ouverts {len(incidents)}" if incidents else "attendre un contexte plus propre",
        ]
    elif learning_frozen or avg_latency_ms > 120.0 or avg_slippage_bps > 3.0 or trade_count < 3:
        decision = "REDUCE SIZE"
        risk_label = "moyen"
        reasons = [
            "learning gelee" if learning_frozen else "echantillon live encore faible",
            f"latence {avg_latency_ms:.0f}ms",
            f"slippage {avg_slippage_bps:.2f}bps",
        ]
    else:
        reasons = [
            f"verite PnL {_format_signed_usd(net_pnl_usd)}",
            f"no-trade dominance {no_trade_ratio_pct:.0f}%",
            f"friction {avg_latency_ms:.0f}ms / {avg_slippage_bps:.2f}bps",
        ]

    reply = "\n".join(
        [
            f"DECISION: {decision}",
            f"RISQUE: {risk_label}",
            f"RAISON: {' ; '.join(reasons)}",
            "OVERRIDE: possible mais visible. Si tu forces, reste en micro-size et journalise la raison.",
        ]
    )

    return {
        "status": "ok",
        "reply": reply,
        "data": {
            "decision": decision,
            "risk": risk_label,
            "reasons": reasons,
            "pnl": pnl_payload,
            "readiness": readiness_payload,
            "incidents": incidents_payload,
            "execution_ai_v6": execution_ai_v6_payload,
            "strategy_progress": strategies_payload[:5],
        },
        "actions": ["open_live_ops", "open_terminal_truth", "open_live_readiness"],
    }


@app.post("/v1/copilot/chat")
async def copilot_chat(payload: dict, auth: AuthContext = Depends(viewer_auth)) -> dict:
    confirm_token = str(payload.get("confirm_token", "")).strip()
    confirm_ack = bool(payload.get("confirm_ack", False))

    if confirm_token and confirm_ack:
        confirmed = _consume_action_confirmation(confirm_token, auth.username)
        if not confirmed:
            return {
                "status": "error",
                "reply": "Confirmation invalide ou expiree. Relance l'action guidee.",
                "actions": ["open_help"],
            }
        action_payload = dict(confirmed["action_payload"])
        action_payload["type"] = confirmed["action_type"]
        result = await _execute_chat_action(action_payload, auth)
        _mark_action_confirmation_executed(int(confirmed["id"]))
        result["confirmation"] = {"status": "executed", "token": confirm_token}
        return result

    action = payload.get("action") if isinstance(payload.get("action"), dict) else None
    if action:
        action_type = str(action.get("type", "")).strip().lower()
        safe_mode = bool(payload.get("safe_mode", True))
        if _requires_safe_confirmation(action_type) and safe_mode:
            confirmation = _create_action_confirmation(action_type, action, auth.username)
            return {
                "status": "confirmation_required",
                "reply": "Confirmation requise: valide une seconde fois pour executer l'action sensible.",
                "confirmation": confirmation,
                "actions": ["confirm_sensitive_action"],
            }
        return await _execute_chat_action(action, auth)

    message = str(payload.get("message", "")).strip().lower()
    if not message:
        return {
            "status": "ok",
            "reply": "Pose une question sur le desk du jour, la verite PnL, le plan journalier, readiness, drift, A/B memory, ou declenche une action guidee.",
            "actions": ["open_live_ops", "open_terminal_truth", "open_live_readiness", "open_memory_ab_panel"],
            "suggested_actions": [
                {"type": "apply_threshold", "label": "Appliquer seuil regime"},
                {"type": "open_incident_ticket", "label": "Ouvrir ticket incident"},
                {"type": "run_runbook", "label": "Lancer runbook stabilize_trading"},
            ],
        }

    if any(keyword in message for keyword in {"commandant", "que faire maintenant", "dois-je trader", "je trade", "trade maintenant", "override"}):
        end = _now_utc()
        start = end - timedelta(days=7)
        pnl_payload = _execution_pnl_analyzer("strategy", "mt5-live", start, end, trade_limit=50, confidence_flag_threshold=0.7)
        readiness_payload = await live_readiness_overview(auth)
        incidents_payload = await list_incidents(auth=auth)
        strategies_payload = await list_strategies(auth=auth)
        execution_ai_v6_payload = await _fetch_execution_ai_v6_state_snapshot()
        return _build_ops_copilot_command_brief(
            pnl_payload=pnl_payload,
            readiness_payload=readiness_payload,
            incidents_payload=incidents_payload,
            strategies_payload=strategies_payload,
            execution_ai_v6_payload=execution_ai_v6_payload,
        )

    if any(keyword in message for keyword in {"desk", "pnl", "truth", "verite", "no-trade", "journal", "plan", "priorite", "ops", "exploitation"}):
        end = _now_utc()
        start = end - timedelta(days=7)
        pnl_payload = _execution_pnl_analyzer("strategy", "mt5-live", start, end, trade_limit=50, confidence_flag_threshold=0.7)
        readiness_payload = await live_readiness_overview(auth)
        incidents_payload = await list_incidents(auth=auth)
        strategies_payload = await list_strategies(auth=auth)
        execution_ai_v6_payload = await _fetch_execution_ai_v6_state_snapshot()
        return _build_ops_copilot_desk_brief(
            pnl_payload=pnl_payload,
            readiness_payload=readiness_payload,
            incidents_payload=incidents_payload,
            strategies_payload=strategies_payload,
            execution_ai_v6_payload=execution_ai_v6_payload,
        )

    if any(keyword in message for keyword in {"news", "nouvel", "macro", "econom", "fed", "cpi", "fomc", "calendar", "geopolit"}):
        return {
            "status": "ok",
            "reply": "Je n'ai pas encore de feed macro/news live branche dans Ops Copilot. Pour l'instant je peux te rappeler le contexte macro comme filtre operationnel et te dire de bloquer ou reduire le live autour des evenements Fed/CPI/FOMC, mais pas te donner une newswire temps reel fiable.",
            "actions": ["open_live_ops", "open_ai_desk"],
        }

    if "readiness" in message or "live" in message:
        data = await live_readiness_overview(auth)
        suspended = len((data.get("drift") or {}).get("suspended_strategies", []))
        reply = f"Live Readiness: {suspended} strategie(s) suspendue(s), voir panneau readiness pour details."
        return {"status": "ok", "reply": reply, "data": data, "actions": ["open_live_readiness"]}

    if any(keyword in message for keyword in {"paper", "exchange", "wallet", "fonds", "fund", "capital", "allocation", "plateforme", "solde", "bingx", "bitget", "coinbase"}):
        accounts = await list_accounts(auth=auth)
        connector_payload = await connectors_accounts(auth=auth)
        connector_rows = connector_payload.get("accounts") if isinstance(connector_payload, dict) else []
        connectors_snapshot = await connectors_status(auth)

        live_brokers = [row for row in accounts if str(row.get("mode") or "").lower() == "live" and str(row.get("account_type") or "").lower() == "broker"]
        paper_brokers = [row for row in accounts if str(row.get("mode") or "").lower() == "paper" and str(row.get("account_type") or "").lower() == "broker"]
        exchange_rows = [row for row in accounts if str(row.get("account_type") or "").lower() == "exchange"]
        wallet_rows = [row for row in accounts if str(row.get("account_type") or "").lower() == "wallet"]
        linked_connectors = connector_rows if isinstance(connector_rows, list) else []
        linked_exchanges = [row for row in linked_connectors if str(row.get("provider_type") or "exchange").lower() != "wallet" and str(row.get("provider") or "").lower() != "mt5"]
        linked_wallets = [row for row in linked_connectors if str(row.get("provider_type") or "").lower() == "wallet"]
        live_equity = sum(float(row.get("latest_equity_usd") or 0.0) for row in live_brokers)
        paper_equity = sum(float(row.get("latest_equity_usd") or 0.0) for row in paper_brokers)
        healthy_connectors = len([row for row in ((connectors_snapshot or {}).get("connectors") or []) if row.get("healthy")])
        total_connectors = len(((connectors_snapshot or {}).get("connectors") or []))

        reply = (
            "Lecture capital: "
            f"broker live {len(live_brokers)} compte(s) / {live_equity:.0f} USD visibles, "
            f"broker paper {len(paper_brokers)} compte(s) / {paper_equity:.0f} USD, "
            f"exchange canonique {len(exchange_rows)} + connecteurs lies {len(linked_exchanges)}, "
            f"wallet canonique {len(wallet_rows)} + wallets lies {len(linked_wallets)}. "
            "Utilise Live Capital pour distinguer l'origine des fonds et Connectors/Connections pour verifier plateforme, credentials et statut d'integration. "
            f"Santé connecteurs {healthy_connectors}/{total_connectors}."
        )
        return {
            "status": "ok",
            "reply": reply,
            "data": {
                "live_brokers": live_brokers[:8],
                "paper_brokers": paper_brokers[:8],
                "exchange_accounts": exchange_rows[:8],
                "wallet_accounts": wallet_rows[:8],
                "linked_exchanges": linked_exchanges[:8],
                "linked_wallets": linked_wallets[:8],
                "connectors_status": connectors_snapshot,
            },
            "actions": ["open_live_capital", "open_connectors_hub", "open_ai_desk"],
        }

    if "drift" in message or "derive" in message:
        drift = await strategies_drift(auth)
        active_drift = [x for x in drift.get("items", []) if x.get("drift_detected")]
        return {
            "status": "ok",
            "reply": f"Drift detecte sur {len(active_drift)} ligne(s) regime/strategie.",
            "data": {"drift": active_drift[:20]},
            "actions": ["review_suspended_strategies"],
        }

    if "a/b" in message or "ab" in message or "memory" in message:
        ab = await memory_ab_stats(auth=auth)
        return {
            "status": "ok",
            "reply": "Comparatif A/B memory genere.",
            "data": ab,
            "actions": ["open_memory_ab_panel"],
        }

    if "ticket" in message or "incident" in message:
        return {
            "status": "ok",
            "reply": "Je peux ouvrir un ticket incident pour toi. Utilise l'action guidee.",
            "suggested_actions": [
                {"type": "open_incident_ticket", "label": "Ouvrir ticket incident", "severity": "high"},
            ],
            "actions": ["open_incident_board"],
        }

    if "incident list" in message or "liste incident" in message:
        incidents = await list_incidents(auth=auth)
        return {
            "status": "ok",
            "reply": f"{len(incidents.get('items', []))} incident(s) charges.",
            "data": incidents,
            "actions": ["open_incident_board"],
        }

    if "runbook" in message:
        return {
            "status": "ok",
            "reply": "Tu peux lancer le runbook stabilize_trading pour recalculer derive et readiness.",
            "suggested_actions": [
                {"type": "run_runbook", "name": "stabilize_trading", "label": "Lancer stabilize_trading"},
            ],
            "actions": ["open_live_readiness"],
        }

    if "promot" in message or ("strategie" in message and "agent" in message):
        strategies = await list_strategies(auth=auth)
        ordered = sorted(
            strategies,
            key=lambda item: (int(item.get("current_level") or 0), str(item.get("updated_at") or "")),
            reverse=True,
        )
        top = ordered[:5]
        current = top[0] if top else None
        reply = "L'agent peut proposer une promotion live, mais la decision doit rester confrontee au compte source, au cap USD et au niveau courant de la strategie."
        if current:
            reply += (
                f" Priorite actuelle: {current.get('strategy_id')} "
                f"(niveau {current.get('current_level')}, statut {current.get('status')})."
            )
        return {
            "status": "ok",
            "reply": reply,
            "data": {"strategies": top},
            "actions": ["review_strategy_promotion", "open_live_capital", "open_ai_desk"],
            "suggested_actions": [
                {"type": "run_runbook", "name": "stabilize_trading", "label": "Rafraichir readiness avant promotion"},
            ],
        }

    return {
        "status": "ok",
        "reply": "Je peux t'aider sur: live readiness, drift, A/B memory, distinction paper/live/exchange/wallet, verification plateforme et proposition de promotion live.",
        "actions": ["open_help"],
        "context": {"user": auth.username, "role": auth.role},
    }


@app.get("/v1/connectors/status")
async def connectors_status(auth: AuthContext = Depends(viewer_auth)) -> dict:
    return await _compute_connectors_snapshot(auth)


@app.get("/v1/connectors/catalog")
async def connectors_catalog(auth: AuthContext = Depends(viewer_auth)) -> dict:
    del auth
    return {"status": "ok", "connectors": CONNECTOR_CATALOG}


@app.get("/v1/connectors/exchange-capabilities")
async def connectors_exchange_capabilities(auth: AuthContext = Depends(any_read_auth)) -> dict:
    del auth
    return _exchange_capability_catalog()


@app.get("/v1/connectors/accounts")
async def connectors_accounts(auth: AuthContext = Depends(any_read_auth)) -> dict:
    accounts = _filter_connector_accounts_for_auth(_load_connector_accounts(), auth)
    redacted: list[dict] = []
    for item in accounts:
        clean = dict(item)
        clean.pop("oauth_tokens", None)
        clean.pop("api_key", None)
        clean.pop("api_secret", None)
        clean.pop("passphrase", None)
        clean["has_credentials"] = bool(clean.get("credential_id"))
        clean["permissions_view"] = _derive_connector_permission_view(item)
        redacted.append(clean)
    return {"status": "ok", "accounts": redacted}


@app.post("/v1/connectors/accounts/link")
async def connectors_link_account(payload: dict, auth: AuthContext = Depends(connector_manage_auth)) -> dict:
    provider = str(payload.get("provider") or "").strip().lower()
    account_id = _normalize_account_id(payload.get("account_id"))
    label = str(payload.get("label") or "").strip()
    mode = str(payload.get("mode") or "read").strip().lower()
    if not provider or not account_id:
        raise HTTPException(status_code=400, detail="provider and account_id are required")

    client_id = _resolve_client_id_for_auth(auth, str(payload.get("client_id") or ""))
    provider_type = str(payload.get("provider_type") or "manual").strip().lower()
    resolved_address = str(
        payload.get("address")
        or payload.get("wallet_address")
        or payload.get("wallet_public_key")
        or payload.get("WALLET_PUBLIC_KEY")
        or ""
    ).strip() or None
    auth_method = str(payload.get("auth_method") or "manual").strip() or "manual"
    credential_id = str(payload.get("credential_id") or "").strip() or None
    wallet_public_key = str(
        payload.get("wallet_public_key")
        or payload.get("WALLET_PUBLIC_KEY")
        or payload.get("public_key")
        or ""
    ).strip()
    wallet_private_key = str(
        payload.get("wallet_private_key")
        or payload.get("WALLET_PRIVATE_KEY")
        or payload.get("private_key")
        or ""
    ).strip()

    if provider_type == "wallet" and wallet_private_key:
        raise HTTPException(
            status_code=400,
            detail="wallet_private_key is not accepted in TXT; use a custody/MPC signer or wallet adapter instead",
        )
    if provider_type == "wallet" and wallet_public_key and auth_method in {"", "manual"}:
        auth_method = "wallet_public_key"

    allowed_providers = {entry["name"] for entry in CONNECTOR_CATALOG}
    if provider not in allowed_providers:
        raise HTTPException(status_code=400, detail=f"unsupported provider: {provider}")

    accounts = _load_connector_accounts()
    remaining = [
        item
        for item in accounts
        if not (
            str(item.get("provider", "")).strip().lower() == provider
            and str(item.get("account_id", "")).strip() == account_id
            and (
                _is_internal_auth(auth)
                or int(item.get("owner_user_id", 0) or 0) == auth.user_id
                or str(item.get("client_id") or "").strip() == client_id
            )
        )
    ]
    remaining.append(
        {
            "provider": provider,
            "account_id": account_id,
            "label": label,
            "mode": mode if mode in {"read", "trade"} else "read",
            "auth_method": auth_method,
            "credential_id": credential_id,
            "client_id": client_id,
            "provider_type": provider_type,
            "address": resolved_address,
            "owner_user_id": auth.user_id,
            "owner_username": auth.username,
            "linked_by": auth.username,
            "linked_at": _now_utc().isoformat(),
        }
    )
    _save_connector_accounts(remaining)
    append_audit(
        "connector_account_linked",
        {"provider": provider, "account_id": account_id, "label": label, "mode": mode, "by": auth.username},
    )
    return {"status": "ok", "accounts": remaining}


@app.post("/v1/connectors/accounts/link-api-key")
async def connectors_link_api_key(payload: dict, auth: AuthContext = Depends(connector_manage_auth)) -> dict:
    provider = str(payload.get("provider") or "").strip().lower()
    account_id = _normalize_account_id(payload.get("account_id"))
    label = str(payload.get("label") or "").strip()
    mode = str(payload.get("mode") or "trade").strip().lower()
    api_key = str(payload.get("api_key") or "").strip()
    api_secret = str(payload.get("api_secret") or "").strip()
    passphrase = str(payload.get("passphrase") or "").strip()
    if not provider or not account_id or not api_key or not api_secret:
        raise HTTPException(status_code=400, detail="provider, account_id, api_key and api_secret are required")

    client_id = _resolve_client_id_for_auth(auth, str(payload.get("client_id") or ""))

    allowed_providers = {entry["name"] for entry in CONNECTOR_CATALOG}
    if provider not in allowed_providers:
        raise HTTPException(status_code=400, detail=f"unsupported provider: {provider}")
    provider_type = next((str(entry.get("type") or "crypto") for entry in CONNECTOR_CATALOG if str(entry.get("name") or "") == provider), "crypto")

    existing_account = next(
        (
            item
            for item in _load_connector_accounts()
            if str(item.get("provider", "")).strip().lower() == provider
            and str(item.get("account_id", "")).strip() == account_id
        ),
        None,
    )
    existing_credential = _load_decrypted_connector_credential(str(existing_account.get("credential_id") or "")) if isinstance(existing_account, dict) else None
    existing_secret_payload = existing_credential.get("secret_payload") if isinstance(existing_credential, dict) and isinstance(existing_credential.get("secret_payload"), dict) else {}
    historical_credential = _latest_connector_credential_for_account(provider, account_id)
    historical_secret_payload = historical_credential.get("secret_payload") if isinstance(historical_credential, dict) and isinstance(historical_credential.get("secret_payload"), dict) else {}
    if not passphrase:
        passphrase = str(existing_secret_payload.get("passphrase") or historical_secret_payload.get("passphrase") or "").strip()
    if provider in {"okx", "bitget"} and not passphrase:
        raise HTTPException(status_code=400, detail=f"{provider.upper()} requires a passphrase for API key authentication")

    secret_payload = {
        "api_key": api_key,
        "api_secret": api_secret,
        "passphrase": passphrase,
    }
    if provider == "binance":
        try:
            await _binance_validate_api_credentials(secret_payload)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except BinanceAPIError as exc:
            status_code = 400 if exc.http_status in {400, 401, 403} or exc.code else 502
            raise HTTPException(status_code=status_code, detail=str(exc)) from exc
        except RuntimeError as exc:
            raise HTTPException(status_code=502, detail=f"Binance credential validation failed: {str(exc)}") from exc
    if provider == "okx":
        try:
            await _okx_validate_api_credentials(secret_payload)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except OKXAPIError as exc:
            status_code = 400 if exc.http_status in {400, 401, 403} or exc.code else 502
            raise HTTPException(status_code=status_code, detail=str(exc)) from exc
        except RuntimeError as exc:
            raise HTTPException(status_code=502, detail=f"OKX credential validation failed: {str(exc)}") from exc

    credential_id = _store_encrypted_connector_credential(
        provider=provider,
        account_id=account_id,
        auth_method="api_key",
        secret_payload=secret_payload,
        created_by=auth.username,
    )

    accounts = _load_connector_accounts()
    accounts = [
        item
        for item in accounts
        if not (
            str(item.get("provider", "")).strip().lower() == provider
            and str(item.get("account_id", "")).strip() == account_id
        )
    ]
    accounts.append(
        {
            "provider": provider,
            "account_id": account_id,
            "label": label,
            "mode": mode if mode in {"read", "trade"} else "trade",
            "auth_method": "api_key",
            "credential_id": credential_id,
            "client_id": client_id,
            "provider_type": provider_type,
            "owner_user_id": auth.user_id,
            "owner_username": auth.username,
            "linked_by": auth.username,
            "linked_at": _now_utc().isoformat(),
        }
    )
    _save_connector_accounts(accounts)
    append_audit(
        "connector_account_linked_api_key",
        {"provider": provider, "account_id": account_id, "credential_id": credential_id, "by": auth.username},
    )
    return {"status": "ok", "credential_id": credential_id, "accounts": accounts}


@app.post("/v1/connectors/oauth/start")
async def connectors_oauth_start(payload: dict, auth: AuthContext = Depends(connector_manage_auth)) -> dict:
    provider = str(payload.get("provider") or "").strip().lower()
    account_id = _normalize_account_id(payload.get("account_id"))
    label = str(payload.get("label") or "").strip()
    redirect_uri = str(payload.get("redirect_uri") or "").strip()
    mode = str(payload.get("mode") or "trade").strip().lower()
    if not provider or not account_id or not redirect_uri:
        raise HTTPException(status_code=400, detail="provider, account_id and redirect_uri are required")

    client_id = _resolve_client_id_for_auth(auth, str(payload.get("client_id") or ""))

    conf = _provider_client_config(provider)
    if not conf.get("client_id") or not conf.get("auth_url"):
        raise HTTPException(status_code=400, detail=f"oauth not configured for provider: {provider}")

    raw_scopes = payload.get("scopes")
    scopes: list[str]
    if isinstance(raw_scopes, list):
        scopes = [str(item).strip() for item in raw_scopes if str(item).strip()]
    elif isinstance(raw_scopes, str):
        scopes = [part.strip() for part in raw_scopes.split(" ") if part.strip()]
    else:
        scopes = ["read", "trade"]

    state = secrets.token_urlsafe(32)
    state_store = _load_oauth_state_store()
    expires_at = (_now_utc() + timedelta(minutes=10)).isoformat()
    state_store[state] = {
        "provider": provider,
        "account_id": account_id,
        "label": label,
        "client_id": client_id,
        "mode": mode if mode in {"read", "trade"} else "trade",
        "redirect_uri": redirect_uri,
        "scopes": scopes,
        "created_by": auth.username,
        "expires_at": expires_at,
    }
    # Keep store bounded.
    for key, value in list(state_store.items()):
        parsed = _parse_iso_utc(str(value.get("expires_at") or ""))
        if parsed and parsed < _now_utc():
            state_store.pop(key, None)
    _save_oauth_state_store(state_store)

    auth_params = {
        "response_type": "code",
        "client_id": conf["client_id"],
        "redirect_uri": redirect_uri,
        "scope": " ".join(scopes),
        "state": state,
    }
    auth_url = f"{conf['auth_url']}?{urlencode(auth_params)}"
    append_audit("connector_oauth_started", {"provider": provider, "account_id": account_id, "by": auth.username})
    return {"status": "ok", "provider": provider, "state": state, "expires_at": expires_at, "auth_url": auth_url}


@app.get("/v1/connectors/oauth/callback")
async def connectors_oauth_callback(provider: str, state: str, code: str | None = None, error: str | None = None) -> dict:
    provider_norm = str(provider or "").strip().lower()
    state_key = str(state or "").strip()
    if not provider_norm or not state_key:
        raise HTTPException(status_code=400, detail="provider and state are required")
    if error:
        raise HTTPException(status_code=400, detail=f"oauth error: {error}")
    if not code:
        raise HTTPException(status_code=400, detail="oauth code is required")

    state_store = _load_oauth_state_store()
    state_payload = state_store.get(state_key)
    if not state_payload:
        raise HTTPException(status_code=400, detail="invalid oauth state")
    expires_at = _parse_iso_utc(str(state_payload.get("expires_at") or ""))
    if expires_at and expires_at < _now_utc():
        state_store.pop(state_key, None)
        _save_oauth_state_store(state_store)
        raise HTTPException(status_code=400, detail="oauth state expired")

    if str(state_payload.get("provider") or "").strip().lower() != provider_norm:
        raise HTTPException(status_code=400, detail="oauth provider mismatch")

    conf = _provider_client_config(provider_norm)
    if not conf.get("token_url") or not conf.get("client_id") or not conf.get("client_secret"):
        raise HTTPException(status_code=400, detail=f"oauth token exchange not configured for provider: {provider_norm}")

    token_payload = {
        "grant_type": "authorization_code",
        "client_id": conf["client_id"],
        "client_secret": conf["client_secret"],
        "code": code,
        "redirect_uri": str(state_payload.get("redirect_uri") or "").strip(),
    }

    async with httpx.AsyncClient(timeout=15.0) as client:
        response = await client.post(conf["token_url"], data=token_payload, headers={"Content-Type": "application/x-www-form-urlencoded"})
        if response.status_code >= 400:
            raise HTTPException(status_code=502, detail=f"oauth token exchange failed for {provider_norm}")
        tokens = response.json() if isinstance(response.json(), dict) else {}

    account_id = _normalize_account_id(state_payload.get("account_id"))
    label = str(state_payload.get("label") or "").strip()
    mode = str(state_payload.get("mode") or "trade").strip().lower()
    created_by = str(state_payload.get("created_by") or "oauth-callback")
    credential_id = _store_encrypted_connector_credential(
        provider=provider_norm,
        account_id=account_id,
        auth_method="oauth",
        secret_payload={"tokens": tokens, "scopes": state_payload.get("scopes", [])},
        created_by=created_by,
    )

    accounts = _load_connector_accounts()
    accounts = [
        item
        for item in accounts
        if not (
            str(item.get("provider", "")).strip().lower() == provider_norm
            and str(item.get("account_id", "")).strip() == account_id
        )
    ]
    accounts.append(
        {
            "provider": provider_norm,
            "account_id": account_id,
            "label": label,
            "mode": mode if mode in {"read", "trade"} else "trade",
            "auth_method": "oauth",
            "credential_id": credential_id,
            "client_id": str(state_payload.get("client_id") or "").strip() or None,
            "owner_username": created_by,
            "linked_by": created_by,
            "linked_at": _now_utc().isoformat(),
        }
    )
    _save_connector_accounts(accounts)
    state_store.pop(state_key, None)
    _save_oauth_state_store(state_store)
    append_audit("connector_oauth_linked", {"provider": provider_norm, "account_id": account_id, "credential_id": credential_id})
    return {"status": "ok", "provider": provider_norm, "account_id": account_id, "credential_id": credential_id}


@app.delete("/v1/connectors/accounts/{provider}/{account_id}")
async def connectors_unlink_account(provider: str, account_id: str, auth: AuthContext = Depends(connector_manage_auth)) -> dict:
    provider_norm = str(provider or "").strip().lower()
    account_id_norm = str(account_id or "").strip()
    accounts = _load_connector_accounts()
    remaining = [
        item
        for item in accounts
        if not (
            str(item.get("provider", "")).strip().lower() == provider_norm
            and str(item.get("account_id", "")).strip() == account_id_norm
            and (
                _is_internal_auth(auth)
                or int(item.get("owner_user_id", 0) or 0) == auth.user_id
                or str(item.get("client_id") or "").strip() in set(_visible_client_ids(auth) or [])
            )
        )
    ]
    credential_ids_to_remove = {
        str(item.get("credential_id") or "").strip()
        for item in accounts
        if str(item.get("provider", "")).strip().lower() == provider_norm
        and str(item.get("account_id", "")).strip() == account_id_norm
        and str(item.get("credential_id") or "").strip()
    }
    if credential_ids_to_remove:
        store = _load_connector_credentials_store()
        for credential_id in credential_ids_to_remove:
            store.pop(credential_id, None)
        _save_connector_credentials_store(store)
    _save_connector_accounts(remaining)
    append_audit(
        "connector_account_unlinked",
        {"provider": provider_norm, "account_id": account_id_norm, "by": auth.username},
    )
    return {"status": "ok", "accounts": remaining}


@app.get("/v1/integrations/routes")
async def integrations_routes(auth: AuthContext = Depends(viewer_auth)) -> dict:
    del auth
    return {"status": "ok", "routes": _load_connector_signal_routes()}


@app.get("/v1/integrations/platforms")
async def integrations_platforms(auth: AuthContext = Depends(viewer_auth)) -> dict:
    del auth
    routes = _load_connector_signal_routes()
    platforms = sorted({str(item.get("source", "")).strip().lower() for item in routes if str(item.get("source", "")).strip()})
    return {"status": "ok", "platforms": platforms}


@app.post("/v1/integrations/routes")
async def integrations_routes_upsert(payload: dict, auth: AuthContext = Depends(operator_auth)) -> dict:
    source = str(payload.get("source") or "").strip().lower()
    provider = str(payload.get("provider") or "").strip().lower()
    account_id = _normalize_account_id(payload.get("account_id"))
    route_key = str(payload.get("route_key") or "default").strip().lower()
    if not source:
        raise HTTPException(status_code=400, detail="source is required")
    if len(source) > 64 or not all(ch.isalnum() or ch in {"-", "_"} for ch in source):
        raise HTTPException(status_code=400, detail="invalid source format")
    if not provider or not account_id:
        raise HTTPException(status_code=400, detail="provider and account_id are required")

    accounts = _load_connector_accounts()
    linked = any(
        str(item.get("provider", "")).strip().lower() == provider
        and str(item.get("account_id", "")).strip() == account_id
        for item in accounts
    )
    if not linked:
        raise HTTPException(status_code=400, detail="account is not linked for this provider")

    routes = _load_connector_signal_routes()
    routes = [
        item
        for item in routes
        if not (
            str(item.get("source", "")).strip().lower() == source
            and str(item.get("route_key", "default")).strip().lower() == route_key
        )
    ]
    routes.append(
        {
            "source": source,
            "route_key": route_key,
            "provider": provider,
            "account_id": account_id,
            "live_enabled": bool(payload.get("live_enabled", False)),
            "preferred_venue": str(
                payload.get("preferred_venue")
                or _preferred_execution_venue(provider, live_enabled=bool(payload.get("live_enabled", False)))
            ).strip(),
            "symbol_map": payload.get("symbol_map") if isinstance(payload.get("symbol_map"), dict) else {},
            "notional_usd": float(payload.get("notional_usd") or 1000.0),
            "updated_by": auth.username,
            "updated_at": _now_utc().isoformat(),
        }
    )
    _save_connector_signal_routes(routes)
    append_audit("integration_route_upserted", {"source": source, "route_key": route_key, "provider": provider, "account_id": account_id, "by": auth.username})
    return {"status": "ok", "routes": routes}


@app.delete("/v1/integrations/routes/{source}/{route_key}")
async def integrations_routes_delete(source: str, route_key: str, auth: AuthContext = Depends(operator_auth)) -> dict:
    source_norm = str(source or "").strip().lower()
    route_key_norm = str(route_key or "default").strip().lower()
    routes = _load_connector_signal_routes()
    routes = [
        item
        for item in routes
        if not (
            str(item.get("source", "")).strip().lower() == source_norm
            and str(item.get("route_key", "default")).strip().lower() == route_key_norm
        )
    ]
    _save_connector_signal_routes(routes)
    append_audit("integration_route_deleted", {"source": source_norm, "route_key": route_key_norm, "by": auth.username})
    return {"status": "ok", "routes": routes}


def _resolve_integration_route(source: str, route_key: str | None) -> dict | None:
    source_norm = str(source or "").strip().lower()
    route_key_norm = str(route_key or "").strip().lower()
    routes = _load_connector_signal_routes()
    if route_key_norm:
        for item in routes:
            if (
                str(item.get("source", "")).strip().lower() == source_norm
                and str(item.get("route_key", "default")).strip().lower() == route_key_norm
            ):
                return item
    for item in routes:
        if (
            str(item.get("source", "")).strip().lower() == source_norm
            and str(item.get("route_key", "default")).strip().lower() == "default"
        ):
            return item
    return None


def _webhook_secret_env_name(source: str) -> str:
    normalized = "".join(ch if ch.isalnum() else "_" for ch in source.upper())
    return f"{normalized}_WEBHOOK_SECRET"


async def _handle_signal_webhook(source: str, payload: dict, provided_secret: str | None) -> dict:
    expected_secret = _secret_env(_webhook_secret_env_name(source), "")
    if expected_secret and str(provided_secret or "").strip() != expected_secret:
        raise HTTPException(status_code=401, detail="invalid webhook secret")

    route_key = str(payload.get("route_key") or payload.get("strategy") or payload.get("alert_id") or "").strip().lower()
    route = _resolve_integration_route(source, route_key)
    if not route:
        raise HTTPException(status_code=400, detail="no integration route configured")

    provider = str(route.get("provider") or "").strip().lower()
    account_id = _normalize_account_id(route.get("account_id"))
    accounts = _load_connector_accounts()
    linked = next(
        (
            item
            for item in accounts
            if str(item.get("provider", "")).strip().lower() == provider
            and str(item.get("account_id", "")).strip() == account_id
        ),
        None,
    )
    if not linked:
        raise HTTPException(status_code=400, detail="mapped account is not linked")
    if str(linked.get("mode") or "read").strip().lower() != "trade":
        raise HTTPException(status_code=403, detail="mapped account is read-only")

    symbol_raw = str(payload.get("symbol") or payload.get("instrument") or "").strip().upper()
    symbol_map = route.get("symbol_map") if isinstance(route.get("symbol_map"), dict) else {}
    symbol = str(symbol_map.get(symbol_raw) or symbol_raw).replace("/", "").replace("-", "")
    if not symbol:
        raise HTTPException(status_code=400, detail="symbol is required")

    side = str(payload.get("side") or payload.get("action") or "buy").strip().lower()
    if side not in {"buy", "sell"}:
        raise HTTPException(status_code=400, detail="side must be buy or sell")
    position_side = str(payload.get("position_side") or ("LONG" if side == "buy" else "SHORT")).strip().upper()
    if position_side not in {"LONG", "SHORT", "BOTH"}:
        position_side = "LONG" if side == "buy" else "SHORT"

    requested_notional = payload.get("estimated_notional_usd") or payload.get("notional_usd") or route.get("notional_usd") or 1000.0
    try:
        notional = float(requested_notional)
    except Exception:
        raise HTTPException(status_code=400, detail="estimated_notional_usd must be numeric")
    if notional <= 0:
        raise HTTPException(status_code=400, detail="estimated_notional_usd must be > 0")

    live_requested = _bool_from_any(route.get("live_enabled"), False)
    policy = await fetch_policy()
    payload_metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
    payload_regime = str(
        payload.get("regime")
        or payload.get("market_regime")
        or payload_metadata.get("regime")
        or payload_metadata.get("market_regime")
        or "UNKNOWN"
    ).strip().upper() or "UNKNOWN"
    payload_confidence = _clamp(
        _to_float(payload.get("confidence"), _to_float(payload_metadata.get("confidence"), 0.0)),
        0.0,
        1.0,
    )
    live_execution = _resolve_live_execution_request(
        provider,
        account_id,
        requested_notional_usd=notional,
        explicit_flag=live_requested,
        purpose="execute",
        paper_only=_bool_from_any(policy.get("paper_only"), False),
        symbol=symbol,
        regime=payload_regime,
        confidence=payload_confidence,
    )
    if live_requested and not live_execution.get("enabled"):
        raise HTTPException(
            status_code=409,
            detail={
                "status": "live_execution_blocked",
                "provider": provider,
                "account_id": account_id,
                "reasons": live_execution.get("reasons"),
                "capabilities": live_execution.get("capabilities"),
                "connector_degradation": live_execution.get("connector_degradation"),
                "policy": live_execution.get("policy"),
                "paper_only": live_execution.get("paper_only"),
            },
        )
    effective_notional = _to_float(live_execution.get("effective_notional_usd"), notional)
    resolved_preferred_venue = str(route.get("preferred_venue") or "").strip()
    if bool(live_execution.get("enabled")):
        if not resolved_preferred_venue or resolved_preferred_venue.startswith("paper-"):
            resolved_preferred_venue = str(live_execution.get("execution_venue") or _preferred_execution_venue(provider, live_enabled=True)).strip()
    elif not resolved_preferred_venue:
        resolved_preferred_venue = _preferred_execution_venue(provider, live_enabled=False)

    pre_trade_memory_gate = _extract_pre_trade_memory_gate(payload)
    governance_snapshot = _extract_trade_governance(payload)
    hardening_snapshot = None
    if live_requested:
        hardening_snapshot = _evaluate_go_live_hardening(
            source=source,
            provider=provider,
            account_id=account_id,
            symbol=symbol,
            side=side,
            requested_notional_usd=effective_notional,
            confidence=payload_confidence,
            live_requested=True,
            purpose="execute",
            pre_trade_memory_gate=pre_trade_memory_gate,
            governance=governance_snapshot,
        )
        if hardening_snapshot.get("status") != "approved":
            raise HTTPException(
                status_code=409,
                detail={
                    "status": "blocked_by_go_live_hardening",
                    "provider": provider,
                    "account_id": account_id,
                    "hardening": hardening_snapshot,
                },
            )

    execution_payload = {
        "decision_id": str(payload.get("decision_id") or f"{source}-{uuid4()}"),
        "symbol": symbol,
        "side": side,
        "estimated_notional_usd": effective_notional,
        "preferred_venue": resolved_preferred_venue,
        "execution_mode": f"{source}-webhook",
        "live_execution": {
            "enabled": bool(live_execution.get("enabled")),
            "provider": provider,
            "account_id": account_id,
            "secret_payload": live_execution.get("secret_payload"),
            "order_type": "MARKET",
            "position_side": position_side,
        },
        "metadata": {
            "source": source,
            "provider": provider,
            "account_id": account_id,
            "capabilities": live_execution.get("capabilities"),
            "route_key": route_key or "default",
            "live_requested": live_requested,
            "health_score": live_execution.get("health_score"),
            "health_action": live_execution.get("health_action"),
            "size_multiplier": live_execution.get("size_multiplier"),
            "requested_notional_usd": notional,
            "effective_notional_usd": effective_notional,
            "position_side": position_side,
            "pre_trade_memory_gate": pre_trade_memory_gate,
            "go_live_hardening": hardening_snapshot,
            "raw_payload": payload,
        },
    }

    async with httpx.AsyncClient(timeout=20.0) as client:
        response = await client.post(f"{EXECUTION_ROUTER_URL}/v1/orders/routed", json=execution_payload)
        if response.status_code >= 400:
            raise HTTPException(status_code=502, detail="execution-router unavailable")
        routed = response.json()

    routed_pre_trade_memory_gate = _extract_pre_trade_memory_gate(routed) or pre_trade_memory_gate
    telemetry_id = _record_platform_execution_telemetry(source, execution_payload, route, routed, routed_pre_trade_memory_gate)

    append_audit(
        "integration_webhook_executed",
        {
            "source": source,
            "provider": provider,
            "account_id": account_id,
            "symbol": symbol,
            "side": side,
            "requested_notional_usd": notional,
            "effective_notional_usd": effective_notional,
            "decision_id": execution_payload["decision_id"],
            "live_requested": live_requested,
            "live_enabled": bool(live_execution.get("enabled")),
            "position_side": position_side,
            "telemetry_id": telemetry_id,
            "pre_trade_memory_gate": routed_pre_trade_memory_gate,
            "go_live_hardening": hardening_snapshot,
        },
    )
    return {"status": "ok", "route": route, "telemetry_id": telemetry_id, "pre_trade_memory_gate": routed_pre_trade_memory_gate, "go_live_hardening": hardening_snapshot, "execution": routed}


@app.post("/v1/connectors/bingx/transfer")
async def bingx_transfer_balance(payload: dict, auth: AuthContext = Depends(operator_auth)) -> dict:
    account_id = _normalize_account_id(payload.get("account_id"))
    if not account_id:
        raise HTTPException(status_code=400, detail="account_id is required")
    asset = str(payload.get("asset") or payload.get("coin") or "USDT").strip().upper()
    amount = _to_float(payload.get("amount"), 0.0)
    if amount <= 0:
        raise HTTPException(status_code=400, detail="amount must be > 0")
    dry_run = _bool_from_any(payload.get("dry_run"), False)
    confirmation_text = str(payload.get("confirmation_text") or "").strip()
    if not dry_run and confirmation_text != "BINGX_TRANSFER":
        raise HTTPException(status_code=400, detail="confirmation_text must equal BINGX_TRANSFER")

    try:
        linked_account, secret_payload = _bingx_secret_payload_for_account(account_id, require_trade=not dry_run)
        from_account_type = _bingx_account_type_code(payload.get("from_account_type") or "spot")
        to_account_type = _bingx_account_type_code(payload.get("to_account_type") or "usdtm_perp")
        if from_account_type == to_account_type:
            raise ValueError("from_account_type and to_account_type must differ")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    before = await _bingx_balance_preview(secret_payload)
    transfer_params = {
        "asset": asset,
        "amount": _format_decimal(amount, 8),
        "fromAccount": _bingx_asset_transfer_account(from_account_type),
        "toAccount": _bingx_asset_transfer_account(to_account_type),
    }

    if dry_run:
        return {
            "status": "dry_run",
            "provider": "bingx",
            "account_id": account_id,
            "linked_account": _connector_account_public_view(linked_account),
            "asset": asset,
            "amount": amount,
            "from_account_type": {
                "code": from_account_type,
                "label": _bingx_account_type_label(from_account_type),
            },
            "to_account_type": {
                "code": to_account_type,
                "label": _bingx_account_type_label(to_account_type),
            },
            "request": transfer_params,
            "before": before,
        }

    try:
        transfer_result = await _bingx_signed_post(secret_payload, "/openApi/api/asset/v1/transfer", transfer_params)
        after = await _bingx_balance_preview(secret_payload)
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail={
            "status": "bingx_transfer_failed",
            "error": str(exc),
            "request": transfer_params,
            "before": before,
        }) from exc

    append_audit(
        "bingx_internal_transfer_executed",
        {
            "provider": "bingx",
            "account_id": account_id,
            "asset": asset,
            "amount": amount,
            "from_account_type": from_account_type,
            "to_account_type": to_account_type,
            "operator": auth.username,
        },
    )
    return {
        "status": "ok",
        "provider": "bingx",
        "account_id": account_id,
        "linked_account": _connector_account_public_view(linked_account),
        "asset": asset,
        "amount": amount,
        "from_account_type": {
            "code": from_account_type,
            "label": _bingx_account_type_label(from_account_type),
        },
        "to_account_type": {
            "code": to_account_type,
            "label": _bingx_account_type_label(to_account_type),
        },
        "request": transfer_params,
        "transfer": transfer_result,
        "before": before,
        "after": after,
    }


@app.post("/v1/connectors/bingx/flatten")
async def bingx_flatten_positions(payload: dict, auth: AuthContext = Depends(operator_auth)) -> dict:
    account_id = _normalize_account_id(payload.get("account_id"))
    if not account_id:
        raise HTTPException(status_code=400, detail="account_id is required")
    symbol = str(payload.get("symbol") or "BTCUSDT").strip().upper().replace("/", "").replace("-", "")
    if not symbol:
        raise HTTPException(status_code=400, detail="symbol is required")
    query_symbol = _bingx_swap_symbol(symbol)
    requested_position_side = str(payload.get("position_side") or "").strip().upper()
    if requested_position_side not in {"", "LONG", "SHORT"}:
        raise HTTPException(status_code=400, detail="position_side must be LONG or SHORT when provided")
    dry_run = _bool_from_any(payload.get("dry_run"), False)
    confirmation_text = str(payload.get("confirmation_text") or "").strip()
    if not dry_run and confirmation_text != "BINGX_FLATTEN":
        raise HTTPException(status_code=400, detail="confirmation_text must equal BINGX_FLATTEN")

    try:
        linked_account, secret_payload = _bingx_secret_payload_for_account(account_id, require_trade=not dry_run)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    try:
        raw_positions_before = await _bingx_signed_get(secret_payload, "/openApi/swap/v2/user/positions", {"symbol": query_symbol})
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail={"status": "bingx_positions_failed", "error": str(exc)}) from exc

    flatten_plan = _bingx_flattenable_positions(raw_positions_before, account_id, symbol=symbol, position_side=requested_position_side)
    if dry_run:
        return {
            "status": "dry_run",
            "provider": "bingx",
            "account_id": account_id,
            "linked_account": _connector_account_public_view(linked_account),
            "symbol": symbol,
            "requested_position_side": requested_position_side or None,
            "positions_before": [item.get("position") for item in flatten_plan],
            "close_plan": [
                {
                    "symbol": item.get("symbol"),
                    "position_side": item.get("position_side"),
                    "close_side": item.get("close_side"),
                    "quantity": item.get("quantity"),
                    "notional_usd": item.get("notional_usd"),
                }
                for item in flatten_plan
            ],
        }

    close_results: list[dict[str, Any]] = []
    close_errors: list[dict[str, Any]] = []
    async with httpx.AsyncClient(timeout=25.0) as client:
        for item in flatten_plan:
            close_payload = {
                "provider": "bingx",
                "account_id": account_id,
                "secret_payload": secret_payload,
                "symbol": symbol,
                "side": item.get("close_side"),
                "position_side": item.get("position_side"),
                "quantity": item.get("quantity"),
                "order_type": "MARKET",
            }
            response = await client.post(f"{BROKER_ADAPTER_URL}/v1/live/orders", json=close_payload)
            if response.status_code >= 400:
                close_errors.append(
                    {
                        "position_side": item.get("position_side"),
                        "quantity": item.get("quantity"),
                        **_flatten_downstream_error("bingx_flatten_order_failed", _http_error_detail(response)),
                    }
                )
                continue
            body = response.json()
            close_results.append(body if isinstance(body, dict) else {"status": "unknown"})

    try:
        raw_positions_after = await _bingx_signed_get(secret_payload, "/openApi/swap/v2/user/positions", {"symbol": query_symbol})
    except RuntimeError as exc:
        raw_positions_after = {"error": str(exc)}

    positions_after = _bingx_flattenable_positions(raw_positions_after, account_id, symbol=symbol, position_side=requested_position_side) if not isinstance(raw_positions_after, dict) or not raw_positions_after.get("error") else []
    status = "ok" if not close_errors and not positions_after else "partial"
    append_audit(
        "bingx_positions_flattened",
        {
            "provider": "bingx",
            "account_id": account_id,
            "symbol": symbol,
            "position_side": requested_position_side or None,
            "closed_count": len(close_results),
            "error_count": len(close_errors),
            "operator": auth.username,
        },
    )
    return {
        "status": status,
        "provider": "bingx",
        "account_id": account_id,
        "linked_account": _connector_account_public_view(linked_account),
        "symbol": symbol,
        "requested_position_side": requested_position_side or None,
        "positions_before": [item.get("position") for item in flatten_plan],
        "close_plan": [
            {
                "symbol": item.get("symbol"),
                "position_side": item.get("position_side"),
                "close_side": item.get("close_side"),
                "quantity": item.get("quantity"),
                "notional_usd": item.get("notional_usd"),
            }
            for item in flatten_plan
        ],
        "close_results": close_results,
        "close_errors": close_errors,
        "positions_after": [item.get("position") for item in positions_after],
        "raw_positions_after": raw_positions_after if isinstance(raw_positions_after, dict) and raw_positions_after.get("error") else None,
    }


@app.post("/v1/connectors/bingx/transfer-and-smoke")
async def bingx_transfer_and_smoke(payload: dict, auth: AuthContext = Depends(operator_auth)) -> dict:
    account_id = _normalize_account_id(payload.get("account_id"))
    if not account_id:
        raise HTTPException(status_code=400, detail="account_id is required")
    symbol = str(payload.get("symbol") or "BTCUSDT").strip().upper().replace("/", "").replace("-", "")
    side = str(payload.get("side") or "buy").strip().lower()
    if side not in {"buy", "sell"}:
        raise HTTPException(status_code=400, detail="side must be buy or sell")
    notional_usd = _to_float(payload.get("notional_usd"), 20.0)
    if notional_usd <= 0:
        raise HTTPException(status_code=400, detail="notional_usd must be > 0")
    transfer_amount = _to_float(payload.get("transfer_amount"), notional_usd)
    if transfer_amount <= 0:
        raise HTTPException(status_code=400, detail="transfer_amount must be > 0")
    asset = str(payload.get("asset") or "USDT").strip().upper()
    from_account_type = payload.get("from_account_type") or "spot"
    to_account_type = payload.get("to_account_type") or "usdtm_perp"
    flatten_after = _bool_from_any(payload.get("flatten_after"), True)
    dry_run = _bool_from_any(payload.get("dry_run"), False)
    confirmation_text = str(payload.get("confirmation_text") or "").strip()
    if not dry_run and confirmation_text != "BINGX_TRANSFER_AND_SMOKE":
        raise HTTPException(status_code=400, detail="confirmation_text must equal BINGX_TRANSFER_AND_SMOKE")

    transfer_payload = {
        "account_id": account_id,
        "asset": asset,
        "amount": transfer_amount,
        "from_account_type": from_account_type,
        "to_account_type": to_account_type,
        "dry_run": dry_run,
        "confirmation_text": "BINGX_TRANSFER" if not dry_run else None,
    }
    transfer_payload = {key: value for key, value in transfer_payload.items() if value is not None}

    if dry_run:
        transfer_preview = await bingx_transfer_balance(transfer_payload, auth)
        return {
            "status": "dry_run",
            "provider": "bingx",
            "account_id": account_id,
            "transfer": transfer_preview,
            "market_probe": {
                "symbol": symbol,
                "side": side,
                "notional_usd": notional_usd,
                "position_side": str(payload.get("position_side") or ("LONG" if side == "buy" else "SHORT")).strip().upper(),
                "flatten_after": flatten_after,
            },
        }

    try:
        transfer_result = await bingx_transfer_balance(transfer_payload, auth)
    except HTTPException as exc:
        raise HTTPException(
            status_code=exc.status_code,
            detail={
                "status": "bingx_transfer_and_smoke_transfer_failed",
                "transfer": exc.detail,
            },
        ) from exc

    try:
        _, secret_payload = _bingx_secret_payload_for_account(account_id, require_trade=True)
        market_probe = await _bingx_market_probe(
            account_id=account_id,
            secret_payload=secret_payload,
            symbol=symbol,
            side=side,
            notional_usd=notional_usd,
            position_side=str(payload.get("position_side") or ("LONG" if side == "buy" else "SHORT")).strip().upper(),
            flatten_after=flatten_after,
        )
    except (ValueError, HTTPException) as exc:
        if isinstance(exc, HTTPException):
            raise HTTPException(
                status_code=exc.status_code,
                detail={
                    "status": "bingx_transfer_and_smoke_market_failed",
                    "transfer": transfer_result,
                    "market": exc.detail,
                },
            ) from exc
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    append_audit(
        "bingx_transfer_and_smoke_executed",
        {
            "provider": "bingx",
            "account_id": account_id,
            "asset": asset,
            "transfer_amount": transfer_amount,
            "symbol": symbol,
            "side": side,
            "notional_usd": notional_usd,
            "flatten_after": flatten_after,
            "operator": auth.username,
        },
    )
    return {
        "status": "ok",
        "provider": "bingx",
        "account_id": account_id,
        "transfer": transfer_result,
        "market": market_probe,
    }


@app.post("/v1/live/orders/cancel")
async def cancel_live_order(payload: dict, auth: AuthContext = Depends(operator_auth)) -> dict:
    provider = str(payload.get("provider") or "bingx").strip().lower()
    if provider != "bingx":
        raise HTTPException(status_code=400, detail="unsupported live provider")

    account_id = _normalize_account_id(payload.get("account_id"))
    if not account_id:
        raise HTTPException(status_code=400, detail="account_id is required")
    _assert_account_visible(auth, account_id)

    symbol = str(payload.get("symbol") or "").strip().upper().replace("/", "").replace("-", "")
    if not symbol:
        raise HTTPException(status_code=400, detail="symbol is required")
    side = str(payload.get("side") or "buy").strip().lower()
    if side not in {"buy", "sell"}:
        raise HTTPException(status_code=400, detail="side must be buy or sell")

    order_id = str(payload.get("order_id") or "").strip()
    client_order_id = str(payload.get("client_order_id") or "").strip()
    if not order_id and not client_order_id:
        raise HTTPException(status_code=400, detail="order_id or client_order_id is required")

    try:
        linked_account, secret_payload = _bingx_secret_payload_for_account(account_id, require_trade=True)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    cancel_payload = {
        "provider": provider,
        "account_id": account_id,
        "secret_payload": secret_payload,
        "symbol": symbol,
        "side": side,
        "order_id": order_id,
        "client_order_id": client_order_id,
        "notional_usd": _to_float(payload.get("notional_usd"), 0.0),
    }
    async with httpx.AsyncClient(timeout=25.0) as client:
        response = await client.post(f"{BROKER_ADAPTER_URL}/v1/live/orders/cancel", json=cancel_payload)
    if response.status_code >= 400:
        raise HTTPException(status_code=502, detail=_flatten_downstream_error("live_cancel_failed", _http_error_detail(response)))
    body = response.json()
    cancel_result = body if isinstance(body, dict) else {"status": "unknown"}

    append_audit(
        "live_order_cancelled",
        {
            "provider": provider,
            "account_id": account_id,
            "symbol": symbol,
            "side": side,
            "order_id": order_id or None,
            "client_order_id": client_order_id or None,
            "status": cancel_result.get("status"),
            "operator": auth.username,
        },
    )
    return {
        "status": "ok",
        "provider": provider,
        "account_id": account_id,
        "linked_account": _connector_account_public_view(linked_account),
        "cancel": cancel_result,
    }


@app.post("/v1/connectors/bingx/live-smoke")
async def bingx_live_smoke(payload: dict, auth: AuthContext = Depends(operator_auth)) -> dict:
    account_id = _normalize_account_id(payload.get("account_id"))
    symbol = str(payload.get("symbol") or "BTCUSDT").strip().upper().replace("/", "").replace("-", "")
    side = str(payload.get("side") or "buy").strip().lower()
    if side not in {"buy", "sell"}:
        raise HTTPException(status_code=400, detail="side must be buy or sell")
    confirmation_text = str(payload.get("confirmation_text") or "").strip()
    if confirmation_text != "BINGX_LIVE_SMOKE":
        raise HTTPException(status_code=400, detail="confirmation_text must equal BINGX_LIVE_SMOKE")
    if not account_id:
        raise HTTPException(status_code=400, detail="account_id is required")

    policy_hint = _resolve_live_execution_request(
        "bingx",
        account_id,
        requested_notional_usd=_to_float(payload.get("notional_usd"), 0.0),
        explicit_flag=True,
        purpose="smoke",
        symbol=symbol,
    )
    smoke_limit = _to_float((policy_hint.get("policy") or {}).get("smoke_test_notional_usd"), 20.0)
    notional = _to_float(payload.get("notional_usd"), smoke_limit if smoke_limit > 0 else 20.0)
    if notional <= 0:
        raise HTTPException(status_code=400, detail="notional_usd must be > 0")

    live_execution = _resolve_live_execution_request(
        "bingx",
        account_id,
        requested_notional_usd=notional,
        explicit_flag=True,
        purpose="smoke",
        symbol=symbol,
    )
    if not live_execution.get("enabled"):
        raise HTTPException(
            status_code=409,
            detail={
                "status": "live_smoke_blocked",
                "provider": "bingx",
                "account_id": account_id,
                "reasons": live_execution.get("reasons"),
                "connector_degradation": live_execution.get("connector_degradation"),
                "policy": live_execution.get("policy"),
            },
        )
    effective_notional = _to_float(live_execution.get("effective_notional_usd"), notional)

    hardening_snapshot = _evaluate_go_live_hardening(
        source="bingx-live-smoke",
        provider="bingx",
        account_id=account_id,
        symbol=symbol,
        side=side,
        requested_notional_usd=effective_notional,
        confidence=1.0,
        live_requested=True,
        purpose="smoke",
        pre_trade_memory_gate={},
        governance={
            "approved": True,
            "approver": auth.username,
            "approval_id": f"bingx-smoke:{account_id}:{symbol}",
            "approval_mode": "operator_confirmation_text",
            "override": False,
        },
    )
    if hardening_snapshot.get("status") != "approved":
        raise HTTPException(
            status_code=409,
            detail={
                "status": "blocked_by_go_live_hardening",
                "provider": "bingx",
                "account_id": account_id,
                "hardening": hardening_snapshot,
            },
        )

    observed_venue = _provider_to_preferred_venue("bingx")
    reference_quote: dict[str, Any] | None = None
    quoted_instrument = symbol
    for candidate_symbol in [symbol, f"{symbol}-PERP"]:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                quote_response = await client.get(f"{BROKER_ADAPTER_URL}/v1/orderbook/{observed_venue}/{candidate_symbol}")
            if quote_response.status_code < 400:
                body = quote_response.json()
                if isinstance(body, dict) and any(_to_float(body.get(key), 0.0) > 0 for key in ("bid", "ask", "last")):
                    reference_quote = body
                    quoted_instrument = candidate_symbol
                    break
        except Exception:
            reference_quote = None
    reference_price = _to_float((reference_quote or {}).get("ask" if side == "buy" else "bid"), 0.0)
    if reference_price <= 0:
        reference_price = _to_float((reference_quote or {}).get("last"), 0.0)
    if reference_price <= 0:
        raise HTTPException(status_code=502, detail="unable to resolve reference price for BingX smoke order")

    offset_bps = _to_float(payload.get("limit_offset_bps"), _to_float((live_execution.get("policy") or {}).get("smoke_limit_offset_bps"), 3500.0))
    offset_bps = max(500.0, min(offset_bps, 9000.0))
    limit_price = reference_price * (1.0 - offset_bps / 10000.0 if side == "buy" else 1.0 + offset_bps / 10000.0)
    quantity = effective_notional / max(reference_price, 1e-9)
    client_order_id = f"smoke-{uuid4().hex[:20]}"
    create_payload = {
        "provider": "bingx",
        "account_id": account_id,
        "secret_payload": live_execution.get("secret_payload"),
        "symbol": symbol,
        "side": side,
        "position_side": str(payload.get("position_side") or ("LONG" if side == "buy" else "SHORT")).strip().upper(),
        "notional_usd": effective_notional,
        "quantity": quantity,
        "price": limit_price,
        "order_type": "LIMIT",
        "time_in_force": "GTC",
        "client_order_id": client_order_id,
    }

    async with httpx.AsyncClient(timeout=25.0) as client:
        create_response = await client.post(f"{BROKER_ADAPTER_URL}/v1/live/orders", json=create_payload)
    if create_response.status_code >= 400:
        raise HTTPException(status_code=502, detail=_flatten_downstream_error("live_smoke_create_failed", _http_error_detail(create_response)))
    create_result = create_response.json()
    if not isinstance(create_result, dict):
        raise HTTPException(status_code=502, detail="broker-adapter returned invalid smoke order payload")

    cancel_result: dict[str, Any] | None = None
    create_status = str(create_result.get("status") or "unknown")
    order_id = str(create_result.get("order_id") or "").strip()
    if order_id and create_status not in {"filled", "cancelled", "rejected"}:
        cancel_payload = {
            "provider": "bingx",
            "account_id": account_id,
            "secret_payload": live_execution.get("secret_payload"),
            "symbol": symbol,
            "side": side,
            "order_id": order_id,
            "client_order_id": str(create_result.get("client_order_id") or client_order_id),
            "notional_usd": effective_notional,
        }
        async with httpx.AsyncClient(timeout=25.0) as client:
            cancel_response = await client.post(f"{BROKER_ADAPTER_URL}/v1/live/orders/cancel", json=cancel_payload)
        if cancel_response.status_code >= 400:
            raise HTTPException(status_code=502, detail=_flatten_downstream_error("live_smoke_cancel_failed", _http_error_detail(cancel_response)))
        body = cancel_response.json()
        cancel_result = body if isinstance(body, dict) else {"status": "unknown"}

    append_audit(
        "bingx_live_smoke_executed",
        {
            "provider": "bingx",
            "account_id": account_id,
            "symbol": symbol,
            "side": side,
            "requested_notional_usd": notional,
            "effective_notional_usd": effective_notional,
            "reference_price": reference_price,
            "limit_price": limit_price,
            "create_status": create_status,
            "cancel_status": cancel_result.get("status") if isinstance(cancel_result, dict) else None,
            "go_live_hardening": hardening_snapshot,
            "connector_health": live_execution.get("connector_degradation"),
            "operator": auth.username,
        },
    )
    return {
        "status": "ok",
        "provider": "bingx",
        "account_id": account_id,
        "symbol": symbol,
        "side": side,
        "requested_notional_usd": notional,
        "effective_notional_usd": effective_notional,
        "reference_price": reference_price,
        "limit_price": limit_price,
        "route": {
            "observed_venue": observed_venue,
            "observed_instrument": quoted_instrument,
            "execution_venue": live_execution.get("execution_venue"),
        },
        "policy": live_execution.get("policy"),
        "connector_degradation": live_execution.get("connector_degradation"),
        "go_live_hardening": hardening_snapshot,
        "create": create_result,
        "cancel": cancel_result,
    }


@app.post("/v1/integrations/platforms/{platform_id}/webhook")
async def generic_platform_webhook(platform_id: str, payload: dict, x_platform_secret: str | None = Header(default=None)) -> dict:
    source = str(platform_id or "").strip().lower()
    if not source:
        raise HTTPException(status_code=400, detail="platform_id is required")
    body_secret = str(payload.get("secret") or "").strip() if isinstance(payload, dict) else ""
    provided_secret = x_platform_secret or body_secret
    return await _handle_signal_webhook(source, payload if isinstance(payload, dict) else {}, provided_secret)


# Backward-compatible aliases (deprecated)
@app.post("/v1/integrations/tradingview/webhook")
async def tradingview_webhook(payload: dict, x_tradingview_secret: str | None = Header(default=None)) -> dict:
    body_secret = str(payload.get("secret") or "").strip() if isinstance(payload, dict) else ""
    provided_secret = x_tradingview_secret or body_secret
    return await _handle_signal_webhook("tradingview", payload if isinstance(payload, dict) else {}, provided_secret)


@app.post("/v1/integrations/quantower/webhook")
async def quantower_webhook(payload: dict, x_quantower_secret: str | None = Header(default=None)) -> dict:
    body_secret = str(payload.get("secret") or "").strip() if isinstance(payload, dict) else ""
    provided_secret = x_quantower_secret or body_secret
    return await _handle_signal_webhook("quantower", payload if isinstance(payload, dict) else {}, provided_secret)


@app.websocket("/v1/connectors/ws")
async def connectors_ws(websocket: WebSocket) -> None:
    token = websocket.query_params.get("token", "").strip()
    user = _resolve_websocket_user(token)
    if not user:
        await websocket.close(code=4401)
        return

    await websocket.accept()
    try:
        while True:
            snapshot = await _compute_connectors_snapshot()
            await websocket.send_json(snapshot)
            await asyncio.sleep(2)
    except WebSocketDisconnect:
        return


@app.websocket("/ws/v1/execution/telemetry")
async def execution_telemetry_ws(websocket: WebSocket) -> None:
    token = websocket.query_params.get("token", "").strip()
    user = _resolve_websocket_user(token)
    if not user:
        await websocket.close(code=4401)
        return

    try:
        limit = int(websocket.query_params.get("limit", "20"))
    except ValueError:
        limit = 20
    safe_limit = max(1, min(limit, 200))

    await websocket.accept()
    sent_ids: set[str] = set()

    try:
        snapshot = _execution_telemetry_rows(safe_limit)
        for item in snapshot:
            telemetry_id = str(item.get("telemetry_id") or "").strip()
            if telemetry_id:
                sent_ids.add(telemetry_id)
        await websocket.send_json({"type": "snapshot", "items": snapshot})

        while True:
            await asyncio.sleep(1)
            latest = _execution_telemetry_rows(safe_limit)
            new_items: list[dict] = []
            for item in reversed(latest):
                telemetry_id = str(item.get("telemetry_id") or "").strip()
                if telemetry_id and telemetry_id not in sent_ids:
                    new_items.append(item)
                    sent_ids.add(telemetry_id)

            for item in new_items:
                await websocket.send_json({"type": "telemetry", "item": item})

            if len(sent_ids) > safe_limit * 20:
                sent_ids = {
                    str(item.get("telemetry_id") or "").strip()
                    for item in latest
                    if str(item.get("telemetry_id") or "").strip()
                }
    except WebSocketDisconnect:
        return


@app.websocket("/ws/v1/market/quotes")
async def market_quotes_ws(websocket: WebSocket) -> None:
    token = websocket.query_params.get("token", "").strip()
    user = _resolve_websocket_user(token)
    if not user:
        await websocket.close(code=4401)
        return

    instrument_filter = _normalize_symbol(websocket.query_params.get("instrument", "").strip())
    if instrument_filter in {"", "-"}:
        instrument_filter = ""

    await websocket.accept()
    last_digest = ""

    try:
        while True:
            rows = await _fetch_market_quotes()
            if instrument_filter:
                rows = [row for row in rows if _normalize_symbol(str(row.get("instrument", ""))) == instrument_filter]

            digest = hashlib.sha256(json_dumps(rows).encode("utf-8")).hexdigest()
            if digest != last_digest:
                await websocket.send_json({"type": "snapshot", "items": rows})
                last_digest = digest
            await asyncio.sleep(2)
    except WebSocketDisconnect:
        return


async def fetch_policy() -> dict:
    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.get(f"{RISK_GATEWAY_URL}/v1/policies")
        return response.json()


async def execute_approved_intent(intent_payload: dict, risk_decision: RiskDecision) -> OrderResult:
    _assert_kill_switch_allows_execution()
    effective_intent_payload = dict(intent_payload)
    live_hint = _intent_live_execution_context(effective_intent_payload)
    memory_query_payload = await _build_intent_memory_v2_query_payload(effective_intent_payload, risk_decision, live_hint)
    memory_lookup = await _call_predictor_v8("/brain/memory-v2/query", memory_query_payload)
    if memory_lookup is None or str(memory_lookup.get("status") or "").strip().lower() != "ok":
        persist_intent(effective_intent_payload, "blocked_memory_unavailable", risk_decision)
        raise HTTPException(
            status_code=503,
            detail={
                "status": "memory_v2_pretrade_unavailable",
                "intent_id": effective_intent_payload.get("intent_id"),
                "required": True,
            },
        )

    effective_intent_payload, memory_pretrade = _apply_memory_v2_pretrade_overrides(effective_intent_payload, memory_lookup)
    append_audit(
        "intent_memory_v2_pretrade",
        {
            "intent_id": effective_intent_payload.get("intent_id"),
            "source": memory_pretrade.get("source"),
            "confidence": memory_pretrade.get("confidence"),
            "applied": memory_pretrade.get("applied"),
        },
    )
    applied_overrides = memory_pretrade.get("applied") if isinstance(memory_pretrade.get("applied"), dict) else {}
    if bool(applied_overrides.get("block_execution")):
        persist_intent(effective_intent_payload, "rejected_by_memory", risk_decision)
        raise HTTPException(
            status_code=409,
            detail={
                "status": "rejected_by_memory",
                "intent_id": effective_intent_payload.get("intent_id"),
                "memory": memory_pretrade,
            },
        )

    live_execution = None
    execution_endpoint = f"{EXECUTION_ROUTER_URL}/v1/orders"
    execution_body: dict[str, Any] = {
        "intent": effective_intent_payload,
        "risk_decision": risk_decision.model_dump(),
        "execution_mode": "paper",
        "execution_delay_ms": int(_to_float(applied_overrides.get("execution_delay_ms"), 0.0)),
    }
    if bool(live_hint.get("requested")):
        explainability = effective_intent_payload.get("explainability") if isinstance(effective_intent_payload.get("explainability"), dict) else {}
        requested_live_notional = _to_float(effective_intent_payload.get("target_notional_usd"), 0.0)
        live_execution = _resolve_live_execution_request(
            str(live_hint.get("provider") or ""),
            str(live_hint.get("account_id") or ""),
            requested_notional_usd=requested_live_notional,
            explicit_flag=True,
            purpose="execute",
            paper_only=_bool_from_any(risk_decision.risk_snapshot.get("paper_only"), False),
            symbol=str(effective_intent_payload.get("instrument") or ""),
            regime=str(
                effective_intent_payload.get("regime")
                or explainability.get("regime")
                or explainability.get("market_regime")
                or "UNKNOWN"
            ).strip().upper() or "UNKNOWN",
            confidence=_clamp(_to_float(effective_intent_payload.get("confidence"), 0.0), 0.0, 1.0),
        )
        if not live_execution.get("enabled"):
            raise HTTPException(
                status_code=409,
                detail={
                    "status": "live_execution_blocked",
                    "reasons": live_execution.get("reasons"),
                    "connector_degradation": live_execution.get("connector_degradation"),
                    "policy": live_execution.get("policy"),
                    "paper_only": live_execution.get("paper_only"),
                    "provider": live_execution.get("provider"),
                    "account_id": live_execution.get("account_id"),
                },
            )
        effective_live_notional = _to_float(live_execution.get("effective_notional_usd"), requested_live_notional)
        hardening_snapshot = _evaluate_go_live_hardening(
            source="approved-intent",
            provider=str(live_execution.get("provider") or ""),
            account_id=_normalize_account_id(live_execution.get("account_id")),
            symbol=str(effective_intent_payload.get("instrument") or ""),
            side=str(effective_intent_payload.get("side") or "buy"),
            requested_notional_usd=effective_live_notional,
            confidence=_clamp(_to_float(effective_intent_payload.get("confidence"), 0.0), 0.0, 1.0),
            live_requested=True,
            purpose="execute",
            pre_trade_memory_gate=memory_pretrade if isinstance(memory_pretrade, dict) else {},
            governance={
                "approved": True,
                "approver": "server-approved-intent",
                "approval_id": str(effective_intent_payload.get("intent_id") or "").strip(),
                "approval_mode": "intent_approval",
                "override": False,
            },
        )
        if hardening_snapshot.get("status") != "approved":
            raise HTTPException(
                status_code=409,
                detail={
                    "status": "blocked_by_go_live_hardening",
                    "intent_id": effective_intent_payload.get("intent_id"),
                    "hardening": hardening_snapshot,
                },
            )
        execution_endpoint = f"{EXECUTION_ROUTER_URL}/v1/orders/routed"
        execution_body = {
            "decision_id": str(effective_intent_payload.get("intent_id") or uuid4()),
            "intent_id": str(effective_intent_payload.get("intent_id") or "").strip() or None,
            "symbol": str(effective_intent_payload.get("instrument") or "").strip(),
            "side": str(effective_intent_payload.get("side") or "buy").strip().lower(),
            "estimated_notional_usd": effective_live_notional,
            "preferred_venue": str(live_execution.get("execution_venue") or _preferred_execution_venue(str(live_hint.get("provider") or ""), live_enabled=True)).strip(),
            "route_mode_override": applied_overrides.get("route_mode_override"),
            "execution_style": applied_overrides.get("execution_style"),
            "execution_mode": "live-intent",
            "execution_delay_ms": int(_to_float(applied_overrides.get("execution_delay_ms"), 0.0)),
            "live_execution": {
                "enabled": True,
                "provider": live_execution.get("provider"),
                "account_id": live_execution.get("account_id"),
                "secret_payload": live_execution.get("secret_payload"),
                "order_type": live_hint.get("order_type"),
                "position_side": live_hint.get("position_side"),
                "reduce_only": live_hint.get("reduce_only"),
            },
            "metadata": {
                "origin": "approved-intent",
                "provider": live_execution.get("provider"),
                "account_id": live_execution.get("account_id"),
                "intent_id": str(effective_intent_payload.get("intent_id") or "").strip(),
                "route_mode_override": applied_overrides.get("route_mode_override"),
                "execution_style": applied_overrides.get("execution_style"),
                "health_score": live_execution.get("health_score"),
                "health_action": live_execution.get("health_action"),
                "size_multiplier": live_execution.get("size_multiplier"),
                "requested_notional_usd": requested_live_notional,
                "effective_notional_usd": effective_live_notional,
                "memory_v2_pretrade": memory_pretrade,
                "go_live_hardening": hardening_snapshot,
            },
        }
    async with httpx.AsyncClient(timeout=10.0) as client:
        execution_response = await client.post(
            execution_endpoint,
            json=execution_body,
        )

        if execution_response.status_code >= 400:
            _record_api_error("execution-router", "intent_execution_failed")
            raise HTTPException(
                status_code=502 if execution_response.status_code >= 500 else execution_response.status_code,
                detail=_upstream_json_payload(execution_response),
            )

        response_body = execution_response.json()
        if execution_endpoint.endswith("/routed"):
            if not isinstance(response_body, dict):
                raise HTTPException(status_code=502, detail="Execution router returned invalid routed order payload")
            order = OrderResult.model_validate(
                {
                    "order_id": str(response_body.get("order_id") or effective_intent_payload.get("intent_id") or uuid4()),
                    "status": str(response_body.get("status") or "unknown"),
                    "venue": str(response_body.get("venue") or live_execution.get("execution_venue") or effective_intent_payload.get("venue") or "unknown"),
                    "instrument": str(response_body.get("instrument") or effective_intent_payload.get("instrument") or ""),
                    "side": str(response_body.get("side") or effective_intent_payload.get("side") or "buy"),
                    "requested_notional_usd": _to_float(response_body.get("requested_notional_usd"), effective_live_notional),
                    "filled_notional_usd": _to_float(response_body.get("filled_notional_usd"), 0.0),
                    "avg_fill_price": _to_float(response_body.get("avg_fill_price"), 0.0),
                    "execution_mode": str(response_body.get("execution_mode") or execution_body.get("execution_mode") or "live-intent"),
                }
            )
        else:
            order = OrderResult.model_validate(response_body)
        execute(
            """
            INSERT INTO orders (order_id, intent_id, venue, instrument, side, requested_notional_usd, filled_notional_usd, avg_fill_price, execution_mode, status)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (order_id) DO NOTHING
            """,
            (
                order.order_id,
                effective_intent_payload["intent_id"],
                order.venue,
                order.instrument,
                order.side.value,
                order.requested_notional_usd,
                order.filled_notional_usd,
                order.avg_fill_price,
                order.execution_mode,
                order.status,
            ),
        )
        persist_intent(effective_intent_payload, "executed", risk_decision)
        append_audit(
            "order_executed",
            {
                "intent_id": effective_intent_payload["intent_id"],
                "order_id": order.order_id,
                "status": order.status,
                "memory_v2_pretrade": memory_pretrade,
            },
        )
        execute(
            """
            INSERT INTO decision_outcomes (decision_id, source, strategy_id, symbol, provider, regime, score_pre_trade,
                                           slippage_real_bps, latency_ms, fees_usd, net_result_usd, status)
            VALUES (%s, %s, %s, %s, %s, %s, %s,
                    %s, %s, %s, %s, %s)
            ON CONFLICT (decision_id) DO NOTHING
            """,
            (
                order.order_id,
                "intent",
                effective_intent_payload.get("strategy_id"),
                effective_intent_payload.get("instrument"),
                order.venue,
                effective_intent_payload.get("regime", "unknown"),
                effective_intent_payload.get("confidence"),
                0.0,
                0,
                0.0,
                0.0,
                "pending",
            ),
        )
        return order


@app.post("/v1/intents/{intent_id}/approve", response_model=IntentSubmissionResponse)
async def approve_pending_intent(intent_id: str, request: ApprovalRequest, auth: AuthContext = Depends(operator_auth)) -> IntentSubmissionResponse:
    pending = PENDING_INTENTS.get(intent_id)
    if not pending:
        raise HTTPException(status_code=404, detail="Pending intent not found")

    if not verify_approval_signature(request.signed_payload, request.signature):
        raise HTTPException(status_code=403, detail="Invalid approval signature")

    execute(
        "INSERT INTO approval_events (intent_id, approver, role, signature, signed_payload) VALUES (%s, %s, %s, %s, %s)",
        (intent_id, auth.principal, auth.role, request.signature, request.signed_payload),
    )

    risk_decision = RiskDecision.model_validate(pending["risk_decision"])
    if risk_decision.decision != "accept":
        raise HTTPException(status_code=400, detail="Only accepted intents can be approved")

    order = await execute_approved_intent(pending["intent"], risk_decision)
    del PENDING_INTENTS[intent_id]
    append_audit("intent_approved", {"intent_id": intent_id, "approver": auth.principal, "role": auth.role})
    return IntentSubmissionResponse(
        intent_id=intent_id,
        system_mode=CURRENT_SYSTEM_MODE,
        status="approved_and_executed",
        risk_decision=risk_decision,
        order=order,
    )


@app.post("/v1/intents/submit", response_model=IntentSubmissionResponse)
async def submit_intent(request: IntentSubmissionRequest, auth: AuthContext = Depends(operator_auth)) -> IntentSubmissionResponse:
    del auth
    append_audit(
        "intent_received",
        {"intent_id": request.intent.intent_id, "strategy_id": request.intent.strategy_id},
    )

    async with httpx.AsyncClient(timeout=10.0) as client:
        risk_response = await client.post(
            f"{RISK_GATEWAY_URL}/v1/checks/pre-trade",
            json=RiskCheckRequest(intent=request.intent, system_mode=CURRENT_SYSTEM_MODE).model_dump(),
        )

        if risk_response.status_code >= 400:
            raise HTTPException(status_code=502, detail="Risk gateway unavailable")

        risk_decision = RiskDecision.model_validate(risk_response.json())
        append_audit(
            "risk_decision",
            {
                "intent_id": request.intent.intent_id,
                "decision": risk_decision.decision,
                "reasons": risk_decision.reasons,
            },
        )

        if risk_decision.decision != "accept":
            persist_intent(request.intent.model_dump(), "rejected_by_risk", risk_decision)
            return IntentSubmissionResponse(
                intent_id=request.intent.intent_id,
                system_mode=CURRENT_SYSTEM_MODE,
                status="rejected_by_risk",
                risk_decision=risk_decision,
            )

        if not request.auto_execute or CURRENT_SYSTEM_MODE in {SystemMode.OBSERVE, SystemMode.SUGGEST}:
            PENDING_INTENTS[request.intent.intent_id] = {
                "intent": request.intent.model_dump(),
                "risk_decision": risk_decision.model_dump(),
            }
            persist_intent(request.intent.model_dump(), "pending_approval", risk_decision)
            append_audit(
                "intent_queued_for_approval",
                {"intent_id": request.intent.intent_id, "mode": CURRENT_SYSTEM_MODE},
            )
            return IntentSubmissionResponse(
                intent_id=request.intent.intent_id,
                system_mode=CURRENT_SYSTEM_MODE,
                status="accepted_waiting_human_or_higher_mode",
                risk_decision=risk_decision,
            )

        order = await execute_approved_intent(request.intent.model_dump(), risk_decision)
        return IntentSubmissionResponse(
            intent_id=request.intent.intent_id,
            system_mode=CURRENT_SYSTEM_MODE,
            status="executed_in_paper_mode",
            risk_decision=risk_decision,
            order=order,
        )


@app.post("/v1/intents/{intent_id}/approve/server-signed", response_model=IntentSubmissionResponse)
async def approve_pending_intent_server_signed(intent_id: str, auth: AuthContext = Depends(operator_auth)) -> IntentSubmissionResponse:
    payload = f"intent_id={intent_id}|action=approve|by={auth.username}|ts={datetime.now(timezone.utc).isoformat()}"
    signature = sign_approval_payload(payload)
    request = ApprovalRequest(signed_payload=payload, signature=signature)
    return await approve_pending_intent(intent_id, request, auth)
