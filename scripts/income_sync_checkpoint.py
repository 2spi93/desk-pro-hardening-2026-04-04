#!/usr/bin/env python3
"""Explicit income-sync checkpoint — FINANCIAL-TRUTH-ENGINE-001 debt 3 (cold).

A sync-truth that is INDEPENDENT of whether new events were received: it records
how far the income ledger has actually been QUERIED, so freshness can be proven
even when the account is flat (no new events). `covered_through` and
`last_success_at` advance ONLY after a fully successful collection; a partial
failure never replaces the last valid checkpoint. RECONCILED_ACTUAL requires
`covered_through >= cycle_closed_at` and a checkpoint fresh within the threshold.

Persistence is append-only (income_sync_checkpoints.jsonl); the latest VALID
(status=success) record is the authority.
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

SCHEMA = "txt.income-sync-checkpoint.v1"
DEFAULT_LEDGER = Path("/opt/txt/var/proof_renewal/financial_truth/income_sync_checkpoints.jsonl")
DEFAULT_FRESHNESS_SEC = 900.0  # a checkpoint older than this is not "fresh" enough to grant ACTUAL


def _parse(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def build_checkpoint(
    *,
    account_id: str,
    provider: str,
    endpoint: str,
    window_start: datetime,
    window_end: datetime,
    fetched_event_count: int,
    page_or_slice_count: int,
    response_digest: str,
    status: str,               # "success" | "partial" | "error"
    error_code: str | None,
    now: datetime,
    prev_checkpoint: dict[str, Any] | None,
) -> dict[str, Any]:
    """Build the next checkpoint. covered_through / last_success_at advance ONLY
    on a fully successful collection; otherwise the last valid values are kept."""
    prev = prev_checkpoint or {}
    if status == "success":
        covered_through = window_end
        last_success_at = now
    else:
        covered_through = _parse(prev.get("covered_through"))
        last_success_at = _parse(prev.get("last_success_at"))
    return {
        "schema_version": SCHEMA,
        "account_id": account_id,
        "provider": provider,
        "endpoint": endpoint,
        "window_start": window_start.isoformat(),
        "covered_through": covered_through.isoformat() if covered_through else None,
        "last_attempt_at": now.isoformat(),
        "last_success_at": last_success_at.isoformat() if last_success_at else None,
        "fetched_event_count": int(fetched_event_count),
        "page_or_slice_count": int(page_or_slice_count),
        "response_digest": response_digest,
        "status": status,
        "error_code": error_code,
    }


def append_checkpoint(checkpoint: dict[str, Any], *, ledger: Path = DEFAULT_LEDGER) -> None:
    """Append-only, durable (flush + fsync)."""
    ledger.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(checkpoint, sort_keys=True) + "\n"
    with ledger.open("a", encoding="utf-8") as fh:
        fh.write(line)
        fh.flush()
        os.fsync(fh.fileno())


def latest_valid_checkpoint(account_id: str, provider: str, *, ledger: Path = DEFAULT_LEDGER) -> dict[str, Any] | None:
    """Most recent status=success checkpoint for the account/provider."""
    if not ledger.exists():
        return None
    best: dict[str, Any] | None = None
    best_ts: datetime | None = None
    for line in ledger.read_text(encoding="utf-8").splitlines():
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            continue
        if r.get("account_id") != account_id or r.get("provider") != provider or r.get("status") != "success":
            continue
        ts = _parse(r.get("last_success_at"))
        if ts is not None and (best_ts is None or ts > best_ts):
            best, best_ts = r, ts
    return best


def covered_reconciled_actual(
    checkpoint: dict[str, Any] | None,
    cycle_closed_at: datetime,
    *,
    now: datetime,
    freshness_sec: float = DEFAULT_FRESHNESS_SEC,
) -> dict[str, Any]:
    """RECONCILED_ACTUAL-eligibility of the ledger coverage for a cycle."""
    if not checkpoint:
        return {"covered": False, "reason": "no_valid_checkpoint"}
    covered_through = _parse(checkpoint.get("covered_through"))
    last_success_at = _parse(checkpoint.get("last_success_at"))
    if covered_through is None or last_success_at is None:
        return {"covered": False, "reason": "checkpoint_incomplete"}
    if covered_through < cycle_closed_at:
        return {"covered": False, "reason": "covered_through_before_cycle_close",
                "covered_through": covered_through.isoformat(), "cycle_closed_at": cycle_closed_at.isoformat()}
    stale = (now - last_success_at).total_seconds() > freshness_sec
    if stale:
        return {"covered": False, "reason": "checkpoint_stale",
                "age_sec": round((now - last_success_at).total_seconds(), 1), "freshness_sec": freshness_sec}
    return {"covered": True, "reason": "covered_and_fresh",
            "covered_through": covered_through.isoformat(), "last_success_at": last_success_at.isoformat()}
