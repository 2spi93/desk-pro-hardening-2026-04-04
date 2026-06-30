#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


SIGNAL_SCHEMA_VERSION = "txt.strategy-signal.v1"
SOURCE_SCHEMA_VERSION = "txt.strategy-opportunity.v1"
DEFAULT_OUT_DIR = Path("/opt/txt/var/proof_renewal")


def parse_time(value: Any) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def stable_digest(payload: Any) -> str:
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str).encode()).hexdigest()


def to_float(value: Any, default: float = 0.0) -> float:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return default
    return numeric if numeric == numeric else default


def normalize_side(value: Any) -> str:
    side = str(value or "").strip().lower()
    return side if side in {"buy", "sell"} else ""


def build_signal(source: dict[str, Any], *, now: datetime | None = None, ttl_minutes: int = 10) -> dict[str, Any]:
    current = now or datetime.now(timezone.utc)
    blockers: list[str] = []
    if source.get("schema_version") != SOURCE_SCHEMA_VERSION:
        blockers.append("source_schema_invalid")
    strategy_id = str(source.get("strategy_id") or "").strip()
    strategy_version = str(source.get("strategy_version") or "").strip()
    symbol = str(source.get("symbol") or "").strip().upper()
    side = normalize_side(source.get("side"))
    generated_at = parse_time(source.get("generated_at")) or current
    expires_at = parse_time(source.get("expires_at")) or (generated_at + timedelta(minutes=max(1, ttl_minutes)))
    gross_expected_edge_bps = to_float(source.get("gross_expected_edge_bps"), to_float(source.get("expected_edge_bps")))
    expected_edge_bps = to_float(source.get("expected_edge_bps"), gross_expected_edge_bps)
    estimated_entry_fee_bps = to_float(source.get("estimated_entry_fee_bps"))
    estimated_exit_fee_bps = to_float(source.get("estimated_exit_fee_bps"))
    estimated_fees_bps = to_float(source.get("estimated_fees_bps"), estimated_entry_fee_bps + estimated_exit_fee_bps)
    estimated_slippage_bps = to_float(source.get("estimated_slippage_bps"))
    estimated_funding_bps = to_float(source.get("estimated_funding_bps"))
    uncertainty_buffer_bps = to_float(source.get("uncertainty_buffer_bps"))
    source_net_edge = source.get("net_expected_edge_bps")
    computed_net_edge_bps = round(gross_expected_edge_bps - estimated_fees_bps - estimated_slippage_bps - estimated_funding_bps - uncertainty_buffer_bps, 8)
    net_expected_edge_bps = to_float(source_net_edge, computed_net_edge_bps) if source_net_edge is not None else computed_net_edge_bps
    edge_lower_confidence_bound_bps = to_float(source.get("edge_lower_confidence_bound_bps"), net_expected_edge_bps)
    confidence = to_float(source.get("confidence"))

    for name, value in (
        ("strategy_id", strategy_id),
        ("strategy_version", strategy_version),
        ("symbol", symbol),
        ("side", side),
        ("market_regime", source.get("market_regime")),
        ("entry_reason", source.get("entry_reason")),
        ("invalidation_reason", source.get("invalidation_reason")),
    ):
        if not value:
            blockers.append(f"{name}_missing")
    if symbol != "BTCUSDT":
        blockers.append("symbol_not_allowed")
    if not side:
        blockers.append("side_invalid")
    if expires_at <= current:
        blockers.append("source_expired")
    if confidence <= 0:
        blockers.append("confidence_invalid")
    if net_expected_edge_bps <= 0:
        blockers.append("net_expected_edge_not_positive")
    if edge_lower_confidence_bound_bps <= 0:
        blockers.append("edge_lower_confidence_bound_not_positive")

    core = {
        "source_id": source.get("source_id") or source.get("opportunity_id"),
        "strategy_id": strategy_id,
        "strategy_version": strategy_version,
        "symbol": symbol,
        "side": side,
        "generated_at": generated_at.isoformat(),
        "expires_at": expires_at.isoformat(),
        "confidence": confidence,
        "market_regime": source.get("market_regime"),
        "entry_reason": source.get("entry_reason"),
        "invalidation_reason": source.get("invalidation_reason"),
        "gross_expected_edge_bps": gross_expected_edge_bps,
        "expected_edge_bps": expected_edge_bps,
        "estimated_entry_fee_bps": estimated_entry_fee_bps,
        "estimated_exit_fee_bps": estimated_exit_fee_bps,
        "estimated_fees_bps": estimated_fees_bps,
        "estimated_slippage_bps": estimated_slippage_bps,
        "estimated_funding_bps": estimated_funding_bps,
        "uncertainty_buffer_bps": uncertainty_buffer_bps,
        "net_expected_edge_bps": net_expected_edge_bps,
        "edge_lower_confidence_bound_bps": edge_lower_confidence_bound_bps,
        "model_version": source.get("model_version"),
        "market_snapshot_digest": source.get("market_snapshot_digest"),
        "evidence_refs": source.get("evidence_refs") if isinstance(source.get("evidence_refs"), list) else [],
    }
    signal = {
        "schema_version": SIGNAL_SCHEMA_VERSION,
        "signal_id": f"sig-{stable_digest(core)[:16]}",
        **core,
        "consumed": False,
        "producer": "txt_strategy_signal_producer",
        "source_digest": stable_digest(source),
        "admissible": len(blockers) == 0,
        "admission_blockers": blockers,
    }
    return signal


def format_text(signal: dict[str, Any]) -> str:
    return (
        f"STRATEGY_SIGNAL signal_id={signal.get('signal_id')} admissible={signal.get('admissible')} "
        f"symbol={signal.get('symbol')} side={signal.get('side')} "
        f"net_expected_edge_bps={signal.get('net_expected_edge_bps')} "
        f"blockers={','.join(signal.get('admission_blockers') or []) or 'none'}"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Produce txt.strategy-signal.v1 from a canonical strategy opportunity.")
    parser.add_argument("--input-json", required=True)
    parser.add_argument("--output", default=str(DEFAULT_OUT_DIR / "next_strategy_signal.json"))
    parser.add_argument("--ttl-minutes", type=int, default=10)
    parser.add_argument("--no-write", action="store_true")
    parser.add_argument("--text", action="store_true")
    args = parser.parse_args()

    source = json.loads(Path(args.input_json).read_text(encoding="utf-8"))
    signal = build_signal(source if isinstance(source, dict) else {}, ttl_minutes=args.ttl_minutes)
    if not args.no_write:
        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(signal, indent=2, sort_keys=True, default=str), encoding="utf-8")
        signal["output_path"] = str(output)
    if args.text:
        print(format_text(signal))
        if signal.get("output_path"):
            print(f"signal: {signal['output_path']}")
    else:
        print(json.dumps(signal, ensure_ascii=True, sort_keys=True, default=str))
    return 0 if signal.get("admissible") else 2


if __name__ == "__main__":
    raise SystemExit(main())
