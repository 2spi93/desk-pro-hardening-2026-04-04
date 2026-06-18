"""Canonical, evidence-derived finalizer for the autonomous BingX-native proof rail.

Implements SPEC_D2_CANONICAL_OUTCOME_FINALIZATION.md.

Contract (the whole point):
  * pending -> finalized ONLY on measured, persisted reality.
  * NEVER accepts caller-supplied outcome numbers (there is no such parameter).
  * NEVER finalizes on assertion, manual SQL, operator/direct-broker evidence.
  * Idempotent: same decision_id + same evidence -> exactly one finalized row;
    re-run with identical evidence is a NO-OP; different numbers on an already
    finalized row are REFUSED (no overwrite).
  * Every finalization carries an append-only audit trail with evidence refs and
    a hash of the server-derived numbers.

Dependency-injected DB readers/writer make this unit-testable with zero DB and
zero market access. The default readers bind to shared.db lazily, so importing
this module never requires a database.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Optional

REASON = "autonomous_proof_renewal_cycle_v1"
FINALIZER_ID = "proof_finalizer.finalize_autonomous_bingx_outcome.v1"
REQUIRED_FILL_TYPE = "live-broker"
REQUIRED_VENUE = "bingx"
REQUIRED_SOURCE = "intent"
REQUIRED_PROVIDER = "bingx"


@dataclass
class FinalizeResult:
    action: str  # "finalized" | "noop" | "refused"
    reason: str
    decision_id: str
    computed: dict[str, Any] = field(default_factory=dict)
    evidence_refs: dict[str, Any] = field(default_factory=dict)
    audit: dict[str, Any] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return self.action in {"finalized", "noop"}


def _num(value: Any) -> Optional[float]:
    try:
        if value is None:
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _avg(values: list[float]) -> Optional[float]:
    vals = [v for v in values if v is not None]
    return round(sum(vals) / len(vals), 6) if vals else None


def derive_measured_outcome(entry_fills: list[dict], exit_fills: list[dict]) -> dict[str, Any]:
    """Pure: derive outcome numbers from persisted fills only.

    Round-trip net_result requires both entry and exit (flatten) fills; otherwise
    measurement_basis='entry_only' and net_result stays None. No price or pnl is
    ever taken from a caller — only from the persisted fill rows.
    """
    entry_notional = round(sum(_num(f.get("notional_usd")) or 0.0 for f in entry_fills), 8)
    entry_qty = round(sum(_num(f.get("size_base")) or 0.0 for f in entry_fills), 10)
    side = str(entry_fills[0].get("side") or "").strip().lower() if entry_fills else ""
    slippage = _avg([_num(f.get("slippage_bps")) for f in entry_fills])
    latency_vals = [_num(f.get("fill_latency_ms")) for f in entry_fills]
    latency = int(round(_avg(latency_vals))) if _avg(latency_vals) is not None else None

    def _fees(rows: list[dict]) -> float:
        total = 0.0
        for r in rows:
            payload = r.get("payload") if isinstance(r.get("payload"), dict) else {}
            total += _num(payload.get("fees_usd")) or _num(payload.get("fee_usd")) or 0.0
        return round(total, 8)

    fees = round(_fees(entry_fills) + _fees(exit_fills), 8)
    net_result = None
    basis = "entry_only"
    if exit_fills:
        exit_notional = round(sum(_num(f.get("notional_usd")) or 0.0 for f in exit_fills), 8)
        # short = sell entry / buy exit ; long = buy entry / sell exit
        if side == "sell":
            net_result = round(entry_notional - exit_notional - fees, 8)
        else:
            net_result = round(exit_notional - entry_notional - fees, 8)
        basis = "round_trip"
    return {
        "side": side,
        "entry_qty": entry_qty,
        "entry_notional_usd": entry_notional,
        "slippage_real_bps": slippage,
        "latency_ms": latency,
        "fees_usd": fees,
        "net_result_usd": net_result,
        "measurement_basis": basis,
    }


def _computed_hash(computed: dict[str, Any]) -> str:
    keys = ("side", "entry_qty", "entry_notional_usd", "slippage_real_bps",
            "latency_ms", "fees_usd", "net_result_usd", "measurement_basis")
    canon = {k: computed.get(k) for k in keys}
    return hashlib.sha256(json.dumps(canon, sort_keys=True, default=str).encode("utf-8")).hexdigest()


# ----- default readers/writer (bound to shared.db lazily; never hit in tests) -----
def _default_load_outcome(decision_id: str) -> Optional[dict]:
    from shared.db import fetch_one
    return fetch_one(
        "SELECT decision_id, source, provider, symbol, strategy_id, regime, status, metadata "
        "FROM decision_outcomes WHERE decision_id = %s",
        (decision_id,),
    )


def _default_load_fills(decision_id: str) -> list[dict]:
    from shared.db import fetch_all
    return fetch_all(
        "SELECT fill_id, venue, instrument, side, price, size_base, notional_usd, fill_type, "
        "slippage_bps, fill_latency_ms, payload, filled_at "
        "FROM execution_fill_events WHERE decision_id = %s ORDER BY filled_at ASC",
        (decision_id,),
    )


def _round_trip_coherent(entry_fills: list[dict], exit_fills: list[dict], tol: float = 1e-9) -> bool:
    """Pure: do the persisted fills prove a closed round-trip (opposite sides, matched qty)?

    This is the evidence-level proof that the position netted flat — the finalizer
    stays pure (no live position call); the runner's verified trap enforces live
    flatness separately.
    """
    if not entry_fills or not exit_fills:
        return False
    entry_side = str(entry_fills[0].get("side") or "").strip().lower()
    exit_side = str(exit_fills[0].get("side") or "").strip().lower()
    if {entry_side, exit_side} != {"buy", "sell"}:
        return False
    entry_qty = sum(_num(f.get("size_base")) or 0.0 for f in entry_fills)
    exit_qty = sum(_num(f.get("size_base")) or 0.0 for f in exit_fills)
    return entry_qty > 0 and abs(entry_qty - exit_qty) <= max(tol, 1e-6 * max(entry_qty, exit_qty))


def _default_load_reality_gap(decision_id: str) -> Optional[dict]:
    from shared.db import fetch_one
    return fetch_one(
        "SELECT sample_id FROM reality_gap_samples WHERE decision_id = %s ORDER BY created_at DESC LIMIT 1",
        (decision_id,),
    )


def _default_write_outcome(decision_id: str, existing: dict, computed: dict, metadata: dict) -> None:
    from shared.db import execute
    execute(
        """
        INSERT INTO decision_outcomes (decision_id, source, strategy_id, symbol, provider, regime,
                                       slippage_real_bps, latency_ms, fees_usd, net_result_usd,
                                       status, metadata, updated_at)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'finalized', %s::jsonb, NOW())
        ON CONFLICT (decision_id) DO UPDATE SET
            slippage_real_bps = EXCLUDED.slippage_real_bps,
            latency_ms = EXCLUDED.latency_ms,
            fees_usd = EXCLUDED.fees_usd,
            net_result_usd = EXCLUDED.net_result_usd,
            status = 'finalized',
            metadata = EXCLUDED.metadata,
            updated_at = NOW()
        WHERE decision_outcomes.status <> 'finalized'
        """,
        (
            decision_id, REQUIRED_SOURCE, existing.get("strategy_id"), existing.get("symbol"),
            REQUIRED_PROVIDER, existing.get("regime"),
            computed.get("slippage_real_bps"), computed.get("latency_ms"),
            computed.get("fees_usd"), computed.get("net_result_usd"),
            json.dumps(metadata),
        ),
    )


def _canonical_bingx_fills(fills: list[dict]) -> list[dict]:
    out = []
    for f in fills:
        if (str(f.get("fill_type") or "").strip().lower() == REQUIRED_FILL_TYPE
                and str(f.get("venue") or "").strip().lower() == REQUIRED_VENUE):
            out.append(f)
    return out


def finalize_autonomous_bingx_outcome(
    decision_id: str,
    *,
    exit_decision_id: Optional[str] = None,
    require_round_trip: bool = False,
    load_outcome: Callable[[str], Optional[dict]] = _default_load_outcome,
    load_fills: Callable[[str], list[dict]] = _default_load_fills,
    load_reality_gap: Callable[[str], Optional[dict]] = _default_load_reality_gap,
    write_outcome: Callable[..., None] = _default_write_outcome,
    now: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
) -> FinalizeResult:
    """Finalize an autonomous BingX intent outcome from measured persisted evidence.

    NOTE: there is intentionally NO parameter for pnl/slippage/status. Outcome
    numbers are derived from persisted fills only; a caller cannot assert them.
    """
    decision_id = str(decision_id or "").strip()
    if not decision_id:
        return FinalizeResult("refused", "missing_decision_id", decision_id)

    # canonical fill is the truth source; operator/direct-broker fills never persist
    # to execution_fill_events, so a live-broker/bingx fill keyed by this autonomous
    # decision_id IS the rail proof.
    entry_fills = _canonical_bingx_fills(load_fills(decision_id))
    if not entry_fills:
        return FinalizeResult("refused", "no_canonical_fill", decision_id)
    exit_fills = _canonical_bingx_fills(load_fills(exit_decision_id)) if exit_decision_id else []

    existing = load_outcome(decision_id)
    creating = not existing
    if not creating:
        source = str(existing.get("source") or "").strip().lower()
        provider = str(existing.get("provider") or "").strip().lower()
        if source != REQUIRED_SOURCE or provider != REQUIRED_PROVIDER:
            # operator/direct-broker/MT5 evidence is never finalized by this rail
            return FinalizeResult("refused", "rail_mismatch", decision_id,
                                  evidence_refs={"source": source, "provider": provider})
    else:
        # D2.3 create-if-missing: no pending decision_outcomes row exists (the
        # autonomous path persisted fills but no row). Create a finalized outcome
        # from the canonical fills ONLY — but require a complete, coherent
        # round-trip (both legs live-broker/bingx, opposite sides, matched qty)
        # so we never invent an outcome from a half/incoherent trade.
        if not exit_fills:
            return FinalizeResult("refused", "exit_fill_required", decision_id)
        if not _round_trip_coherent(entry_fills, exit_fills):
            return FinalizeResult("refused", "round_trip_incoherent", decision_id)

    computed = derive_measured_outcome(entry_fills, exit_fills)
    # D3: a proof cycle requires a complete round-trip (entry + exit canonical
    # fills) before finalizing; an entry-only measurement is incomplete proof.
    if require_round_trip and computed.get("measurement_basis") != "round_trip":
        return FinalizeResult("refused", "exit_fill_required", decision_id, computed=computed)
    new_hash = _computed_hash(computed)

    rg = load_reality_gap(decision_id) or {}
    evidence_refs = {
        "fill_ids": [str(f.get("fill_id")) for f in entry_fills],
        "exit_fill_ids": [str(f.get("fill_id")) for f in exit_fills],
        "reality_gap_sample_id": rg.get("sample_id"),
        "exit_decision_id": exit_decision_id,
    }

    existing = existing or {}
    status = str(existing.get("status") or "").strip().lower()
    if status == "finalized":
        prior_meta = existing.get("metadata") if isinstance(existing.get("metadata"), dict) else {}
        prior_hash = ((prior_meta.get("proof_finalization") or {}) if isinstance(prior_meta, dict) else {}).get("computed_values_hash")
        if prior_hash == new_hash:
            return FinalizeResult("noop", "already_finalized", decision_id,
                                  computed=computed, evidence_refs=evidence_refs)
        return FinalizeResult("refused", "overwrite_finalized", decision_id,
                              computed=computed, evidence_refs=evidence_refs)

    audit = {
        "previous_status": "absent" if creating else (status or "pending"),
        "next_status": "finalized",
        "reason": REASON,
        "finalizer": FINALIZER_ID,
        "created_from_fills": creating,
        "evidence_refs": evidence_refs,
        "computed_values_hash": new_hash,
        "measurement_basis": computed.get("measurement_basis"),
        "finalized_at": now().isoformat(),
    }
    prior_meta = existing.get("metadata") if isinstance(existing.get("metadata"), dict) else {}
    metadata = {**(prior_meta or {}), "proof_finalization": audit}

    # when creating, seed symbol from the canonical fill instrument
    write_existing = dict(existing)
    if creating and not write_existing.get("symbol"):
        write_existing["symbol"] = entry_fills[0].get("instrument")

    write_outcome(decision_id, write_existing, computed, metadata)
    return FinalizeResult("finalized", "created_finalized_from_fills" if creating else "finalized_from_evidence",
                          decision_id, computed=computed, evidence_refs=evidence_refs, audit=audit)


def assert_legacy_finalize_not_for_proof_rail(decision_id: str, payload: dict,
                                              load_outcome: Callable[[str], Optional[dict]] = _default_load_outcome) -> Optional[str]:
    """Fence helper for the legacy magic endpoint (/v1/outcomes/{id}/update).

    Returns a refusal reason if a caller tries to finalize an autonomous BingX
    intent with caller-supplied numbers via the legacy path (which must instead
    go through finalize_autonomous_bingx_outcome). Returns None if the legacy
    path is allowed (non proof-rail decisions). Wiring this into the live
    endpoint is a deliberate, separately-reviewed step.
    """
    existing = load_outcome(decision_id)
    if not existing:
        return None
    source = str(existing.get("source") or "").strip().lower()
    provider = str(existing.get("provider") or "").strip().lower()
    wants_finalize = str(payload.get("status", "finalized")).strip().lower() == "finalized"
    if wants_finalize and source == REQUIRED_SOURCE and provider == REQUIRED_PROVIDER:
        return "use_proof_finalizer_for_autonomous_bingx_rail"
    return None
