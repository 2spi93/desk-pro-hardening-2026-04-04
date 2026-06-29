#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import subprocess
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DEFAULT_CONTAINER = "control-plane"
DEFAULT_OUT_DIR = Path("/opt/txt/var/proof_renewal")
DEFAULT_STALE_DAYS = 14.0

ACTIVE_CONFIRMED = "ACTIVE_CONFIRMED"
RESOLVED_BUT_UNCLOSED = "RESOLVED_BUT_UNCLOSED"
STALE_DUPLICATE = "STALE_DUPLICATE"
SUPERSEDED = "SUPERSEDED"
UNRELATED_TO_EXECUTION_ROUTER = "UNRELATED_TO_EXECUTION_ROUTER"
UNRESOLVED_INSUFFICIENT_EVIDENCE = "UNRESOLVED_INSUFFICIENT_EVIDENCE"


def parse_time(value: Any) -> datetime | None:
    if not value:
        return None
    text = str(value)
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def fetch_json(container: str) -> dict[str, Any]:
    code = r'''
import json
import os
import urllib.request
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

def db_url():
    value = os.environ.get("DATABASE_URL")
    if value:
        return value
    for candidate in (Path("/run/secrets/database_url"), Path("/workspace/secrets/database_url")):
        if candidate.exists():
            return candidate.read_text(encoding="utf-8").strip()
    raise RuntimeError("database url unavailable")

def rows(cur, sql, params=()):
    cur.execute(sql, params)
    return [dict(row) for row in cur.fetchall()]

def get(url):
    return json.loads(urllib.request.urlopen(url, timeout=8).read().decode())

runtime = {}
try:
    h = get("http://127.0.0.1:8000/health")
    gate = h.get("opportunity_gate") if isinstance(h.get("opportunity_gate"), dict) else {}
    runtime.update({
        "control_plane": h.get("status"),
        "system_mode": h.get("system_mode"),
        "gate": gate.get("status"),
        "kill_recommended": gate.get("kill_switch_recommended"),
        "pending_intents": h.get("pending_intents"),
    })
except Exception as e:
    runtime["control_plane_error"] = str(e)[:120]
try:
    risk = get("http://risk-gateway:8001/health")
    runtime["risk_gateway"] = risk.get("status")
    runtime["daily_notional_used_usd"] = risk.get("daily_notional_used_usd")
    runtime["daily_notional_limit_usd"] = risk.get("daily_notional_limit_usd") or 30.0
except Exception as e:
    runtime["risk_gateway_error"] = str(e)[:120]

with psycopg.connect(db_url()) as conn:
    with conn.cursor(row_factory=dict_row) as cur:
        incidents = rows(
            cur,
            """
            SELECT ticket_key, severity, title, status, assignee, source, payload,
                   created_by, resolution_note, closed_by, closed_at, created_at, updated_at
            FROM incident_tickets
            WHERE COALESCE(status, '') <> 'closed'
            ORDER BY updated_at DESC NULLS LAST, created_at DESC
            LIMIT 500
            """,
        )
print(json.dumps({"runtime": runtime, "incidents": incidents}, default=str, sort_keys=True))
'''
    result = subprocess.run(
        ["docker", "exec", "-i", container, "python3", "-c", code],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=90,
    )
    return json.loads(result.stdout)


def terminal_family(title: str) -> str | None:
    match = re.search(r"terminal local hard fail\s+([A-Z0-9]+)\s+([A-Za-z0-9]+)", title, re.I)
    if not match:
        return None
    symbol, timeframe = match.groups()
    return f"terminal_local_hard_fail:{symbol.upper()}:{timeframe.lower()}"


def broad_terminal_family(title: str) -> str | None:
    match = re.search(r"terminal local hard fail\s+([A-Z0-9]+)", title, re.I)
    if not match:
        return None
    return f"terminal_local_hard_fail:{match.group(1).upper()}"


def age_days(row: dict[str, Any], now: datetime) -> float | None:
    created = parse_time(row.get("created_at"))
    if created is None:
        return None
    return max(0.0, (now - created).total_seconds() / 86400.0)


def last_seen_at(row: dict[str, Any]) -> str | None:
    return str(row.get("updated_at") or row.get("created_at") or "") or None


def classify_incident(
    row: dict[str, Any],
    *,
    runtime: dict[str, Any],
    family_counts: Counter[str],
    now: datetime,
    stale_days: float,
) -> dict[str, Any]:
    title = str(row.get("title") or "")
    source = str(row.get("source") or "")
    status = str(row.get("status") or "")
    payload = row.get("payload") if isinstance(row.get("payload"), dict) else {}
    lower_blob = f"{title} {source} {json.dumps(payload, sort_keys=True, default=str)}".lower()
    days = age_days(row, now)
    family = terminal_family(title) or broad_terminal_family(title) or source or "unknown"
    broad_family = broad_terminal_family(title)

    relevant_to_execution_router = any(
        token in lower_blob
        for token in ("execution-router", "intent_execution_failed", "api_errors_threshold", "proofcyc", "bingx")
    )
    relevant_to_promotion = relevant_to_execution_router or any(
        token in lower_blob
        for token in ("certified outcomes gate", "live promotion", "opportunity_gate", "freeze runtime", "kill")
    )

    classification = UNRESOLVED_INSUFFICIENT_EVIDENCE
    reason = "no_current_recovery_evidence"
    recommended = "inspect_before_closure"

    if "certified outcomes gate" in lower_blob or "certified_outcomes_below_gate" in lower_blob:
        classification = ACTIVE_CONFIRMED
        reason = "payload_states_live_promotion_remains_blocked"
        recommended = "keep_open_until_certified_outcomes_gate_recovers"
        relevant_to_promotion = True
    elif "freeze runtime" in lower_blob or source == "opportunity_gate":
        if runtime.get("gate") == "go" and runtime.get("kill_recommended") in (False, None):
            classification = RESOLVED_BUT_UNCLOSED
            reason = "current_gate_go_and_kill_false"
            recommended = "eligible_for_operator_close_with_reset_evidence"
        else:
            classification = ACTIVE_CONFIRMED
            reason = "opportunity_gate_or_kill_still_not_clear"
            recommended = "keep_open"
        relevant_to_promotion = True
    elif terminal_family(title):
        relevant_to_execution_router = False
        if broad_family and family_counts[broad_family] > 1 and days is not None and days >= stale_days:
            classification = STALE_DUPLICATE
            reason = "old_terminal_family_duplicate"
            recommended = "bulk_merge_or_close_after_terminal_health_snapshot"
        elif days is not None and days >= stale_days:
            classification = UNRELATED_TO_EXECUTION_ROUTER
            reason = "old_terminal_ui_market_data_incident_not_bingx_execution_router"
            recommended = "separate_terminal_health_review"
        else:
            classification = UNRESOLVED_INSUFFICIENT_EVIDENCE
            reason = "recent_terminal_incident_needs_current_health_snapshot"
            recommended = "run_terminal_health_snapshot_before_close"
    elif days is not None and days >= stale_days and not relevant_to_execution_router:
        classification = UNRELATED_TO_EXECUTION_ROUTER
        reason = "old_non_execution_router_incident"
        recommended = "close_or_reassign_after_owner_review"

    return {
        "incident_id": row.get("ticket_key"),
        "source": source,
        "owner": source or None,
        "reason": title,
        "detail": reason,
        "status": status,
        "severity": row.get("severity"),
        "created_at": str(row.get("created_at") or ""),
        "last_seen_at": last_seen_at(row),
        "occurrence_count": family_counts.get(broad_family or family, 1),
        "scope": broad_family or family,
        "linked_ticket": row.get("ticket_key"),
        "runtime_condition_still_present": classification == ACTIVE_CONFIRMED,
        "evidence_of_recovery": reason if classification == RESOLVED_BUT_UNCLOSED else None,
        "classification": classification,
        "relevant_to_execution_router": relevant_to_execution_router,
        "relevant_to_promotion_gate": relevant_to_promotion,
        "recommended_disposition": recommended,
        "age_days": round(days, 2) if days is not None else None,
    }


def build_report(data: dict[str, Any], *, now: datetime | None = None, stale_days: float = DEFAULT_STALE_DAYS) -> dict[str, Any]:
    current = now or datetime.now(timezone.utc)
    incidents = [row for row in data.get("incidents", []) if isinstance(row, dict)]
    broad_counts: Counter[str] = Counter()
    for row in incidents:
        title = str(row.get("title") or "")
        broad_counts[broad_terminal_family(title) or terminal_family(title) or str(row.get("source") or "unknown")] += 1

    adjudicated = [
        classify_incident(
            row,
            runtime=data.get("runtime", {}),
            family_counts=broad_counts,
            now=current,
            stale_days=stale_days,
        )
        for row in incidents
    ]
    summary = Counter(item["classification"] for item in adjudicated)
    relevant_blockers = [
        item
        for item in adjudicated
        if item["relevant_to_promotion_gate"]
        and item["classification"] in {ACTIVE_CONFIRMED, UNRESOLVED_INSUFFICIENT_EVIDENCE}
    ]
    return {
        "generated_at": current.isoformat(),
        "mode": "read_only",
        "runtime": data.get("runtime", {}),
        "total_active_incidents": len(adjudicated),
        "summary": dict(sorted(summary.items())),
        "promotion_relevant_blockers": len(relevant_blockers),
        "RESET_OR_CLOSE_PERFORMED": False,
        "PROMOTION_INCIDENT_BLOCK_CLEAR": len(relevant_blockers) == 0,
        "items": adjudicated,
        "notes": [
            "This adjudication does not close incidents.",
            "Use recommended_disposition as operator guidance only.",
            "Promotion remains blocked while promotion_relevant_blockers > 0.",
        ],
    }


def format_text(report: dict[str, Any]) -> str:
    summary = report.get("summary") or {}
    parts = " ".join(f"{key}={value}" for key, value in summary.items())
    return (
        f"INCIDENT_ADJUDICATION active={report['total_active_incidents']} "
        f"promotion_relevant_blockers={report['promotion_relevant_blockers']} "
        f"PROMOTION_INCIDENT_BLOCK_CLEAR={report['PROMOTION_INCIDENT_BLOCK_CLEAR']} "
        f"{parts}"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Read-only incident adjudication for TXT promotion gate.")
    parser.add_argument("--input-json")
    parser.add_argument("--docker-container", default=DEFAULT_CONTAINER)
    parser.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR))
    parser.add_argument("--stale-days", type=float, default=DEFAULT_STALE_DAYS)
    parser.add_argument("--no-write", action="store_true")
    parser.add_argument("--text", action="store_true")
    parser.add_argument("--check", action="store_true", help="Exit 2 if promotion-relevant blockers remain.")
    args = parser.parse_args()

    data = json.loads(Path(args.input_json).read_text(encoding="utf-8")) if args.input_json else fetch_json(args.docker_container)
    report = build_report(data, stale_days=args.stale_days)
    if not args.no_write:
        out_dir = Path(args.out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        path = out_dir / f"incident_adjudication_{stamp}.json"
        path.write_text(json.dumps(report, indent=2, sort_keys=True, default=str), encoding="utf-8")
        report["report_path"] = str(path)

    if args.text:
        print(format_text(report))
        if report.get("report_path"):
            print(f"report: {report['report_path']}")
    else:
        print(json.dumps(report, ensure_ascii=True, sort_keys=True, default=str))

    if args.check and not report["PROMOTION_INCIDENT_BLOCK_CLEAR"]:
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
