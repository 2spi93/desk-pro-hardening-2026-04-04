#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DEFAULT_CONTAINER = "control-plane"
DEFAULT_OUT_DIR = Path("/opt/txt/var/proof_renewal")

ACTIVE_CONFIRMED = "ACTIVE_CONFIRMED"
RESOLVED_BUT_UNCLOSED = "RESOLVED_BUT_UNCLOSED"
DUPLICATE_OF_CONSISTENCY_LOCK = "DUPLICATE_OF_CONSISTENCY_LOCK"
UNRELATED = "UNRELATED"


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


def fetch_json(container: str) -> dict[str, Any]:
    code = r'''
import json
import os
import urllib.request
from pathlib import Path

import psycopg
from psycopg.rows import dict_row
import apps.control_plane.main as cp

def db_url():
    value = os.environ.get("DATABASE_URL")
    if value:
        return value
    for candidate in (Path("/run/secrets/database_url"), Path("/workspace/secrets/database_url")):
        if candidate.exists():
            return candidate.read_text(encoding="utf-8").strip()
    raise RuntimeError("database url unavailable")

def get(url):
    return json.loads(urllib.request.urlopen(url, timeout=8).read().decode())

def rows(cur, sql, params=()):
    cur.execute(sql, params)
    return [dict(row) for row in cur.fetchall()]

health = get("http://127.0.0.1:8000/health")
gate = health.get("opportunity_gate") if isinstance(health.get("opportunity_gate"), dict) else {}
lock = cp._local_execution_lock_snapshot(execution_phase="opportunity_gate_readiness_review")
with psycopg.connect(db_url()) as conn:
    with conn.cursor(row_factory=dict_row) as cur:
        incidents = rows(
            cur,
            """
            SELECT ticket_key, severity, title, status, source, payload,
                   created_at, updated_at
            FROM incident_tickets
            WHERE COALESCE(status, '') <> 'closed'
            ORDER BY updated_at DESC NULLS LAST, created_at DESC
            LIMIT 500
            """,
        )
print(json.dumps({"health": health, "gate": gate, "lock": lock, "incidents": incidents}, default=str, sort_keys=True))
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


def _incident_blob(row: dict[str, Any]) -> str:
    return f"{row.get('title') or ''} {row.get('source') or ''} {json.dumps(row.get('payload') or {}, sort_keys=True, default=str)}".lower()


def adjudicate_incidents(incidents: list[dict[str, Any]], *, lock_reason: str | None, gate_status: str | None, kill: bool) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for incident in incidents:
        blob = _incident_blob(incident)
        relevant = any(token in blob for token in ("opportunity_gate", "freeze runtime", "kill", "consistency_kill_threshold"))
        if not relevant:
            classification = UNRELATED
        elif lock_reason and lock_reason in blob:
            classification = DUPLICATE_OF_CONSISTENCY_LOCK
        elif gate_status == "go" and not kill:
            classification = RESOLVED_BUT_UNCLOSED
        else:
            classification = ACTIVE_CONFIRMED
        rows.append({
            "incident_id": incident.get("ticket_key"),
            "source": incident.get("source"),
            "reason": incident.get("title"),
            "status": incident.get("status"),
            "created_at": str(incident.get("created_at") or ""),
            "last_seen_at": str(incident.get("updated_at") or incident.get("created_at") or ""),
            "classification": classification,
            "relevant_to_opportunity_gate": relevant,
            "runtime_condition_still_present": classification in {ACTIVE_CONFIRMED, DUPLICATE_OF_CONSISTENCY_LOCK},
        })
    return rows


def build_review(data: dict[str, Any], *, now: datetime | None = None) -> dict[str, Any]:
    current = now or datetime.now(timezone.utc)
    gate = data.get("gate") if isinstance(data.get("gate"), dict) else {}
    lock = data.get("lock") if isinstance(data.get("lock"), dict) else {}
    metrics = gate.get("metrics") if isinstance(gate.get("metrics"), dict) else {}
    thresholds = gate.get("thresholds") if isinstance(gate.get("thresholds"), dict) else {}
    activation = lock.get("activation") if isinstance(lock.get("activation"), dict) else {}
    activation_payload = activation.get("payload") if isinstance(activation.get("payload"), dict) else {}
    activation_gate = activation_payload.get("gate") if isinstance(activation_payload.get("gate"), dict) else {}
    activation_metrics = activation_gate.get("metrics") if isinstance(activation_gate.get("metrics"), dict) else {}
    activation_thresholds = activation_gate.get("thresholds") if isinstance(activation_gate.get("thresholds"), dict) else {}
    lock_reason = str(lock.get("lock_reason") or gate.get("kill_switch_reason") or "")
    gate_status = str(gate.get("status") or "")
    kill = bool(gate.get("kill_switch_recommended"))
    incidents = [row for row in data.get("incidents", []) if isinstance(row, dict)]
    adjudicated = adjudicate_incidents(incidents, lock_reason=lock_reason, gate_status=gate_status, kill=kill)
    relevant = [row for row in adjudicated if row["relevant_to_opportunity_gate"]]
    summary = Counter(row["classification"] for row in relevant)

    metric_condition_active = gate_status != "go" or kill
    lock_latched = bool(lock.get("lock_active"))
    return {
        "schema_version": "txt-opportunity-gate-readiness-review/v1",
        "generated_at": current.isoformat(),
        "mode": "read_only",
        "lock": {
            "active": bool(lock.get("lock_active")),
            "owner": lock.get("lock_owner"),
            "reason": lock_reason or None,
            "status": lock.get("status"),
            "acquired_at": lock.get("acquired_at"),
            "expires_at": lock.get("expires_at"),
            "remaining_ttl_ms": lock.get("remaining_ttl_ms"),
        },
        "consistency_threshold": {
            "metric": "consistency",
            "observed": metrics.get("consistency"),
            "kill_observed_at_activation": activation_metrics.get("consistency"),
            "min_threshold": thresholds.get("min_consistency_pct"),
            "kill_threshold": thresholds.get("kill_consistency_pct"),
            "configured_window": {
                "loop_interval_sec": "1..30 runtime env, default 5",
                "candidate_count": metrics.get("candidates"),
                "min_candidates": thresholds.get("min_candidates"),
                "bus_seq": metrics.get("bus_seq"),
            },
            "activation_window": {
                "candidate_count": activation_metrics.get("candidates"),
                "min_candidates": activation_thresholds.get("min_candidates"),
                "bus_seq": activation_metrics.get("bus_seq"),
                "deviation_bps": activation_metrics.get("deviation_bps"),
                "freshness_ms": activation_metrics.get("freshness_ms"),
            },
        },
        "occurrence_window": {
            "first_observed_at": lock.get("acquired_at"),
            "last_observed_at": gate.get("updated_at") or gate.get("evaluated_at"),
            "metric_condition_still_reproducible_now": metric_condition_active,
            "lock_still_latched": lock_latched,
        },
        "sources_divergent": {
            "reasons": gate.get("reasons") or [],
            "flags": metrics.get("flags") or [],
            "source": gate.get("source"),
            "deviation_bps": metrics.get("deviation_bps"),
            "deviation_threshold": thresholds.get("max_deviation_bps"),
        },
        "incident_adjudication": {
            "summary": dict(sorted(summary.items())),
            "items": relevant,
            "promotion_relevant_incident_clear": len([
                row for row in relevant
                if row["classification"] in {ACTIVE_CONFIRMED, DUPLICATE_OF_CONSISTENCY_LOCK}
            ]) == 0,
        },
        "OPPORTUNITY_GATE_READY": gate_status == "go" and not kill and not lock_latched,
        "RESET_OR_CLOSE_PERFORMED": False,
        "recommended_disposition": (
            "keep_lock_active_and_fix_gate_condition" if metric_condition_active else "eligible_for_operator_close_or_reset_review"
        ),
    }


def format_text(report: dict[str, Any]) -> str:
    lock = report["lock"]
    consistency = report["consistency_threshold"]
    return (
        f"OPPORTUNITY_GATE_READINESS ready={report['OPPORTUNITY_GATE_READY']} "
        f"lock_active={lock['active']} owner={lock.get('owner')} reason={lock.get('reason')} "
        f"consistency={consistency.get('observed')}/{consistency.get('kill_threshold')} "
        f"metric_reproducible={report['occurrence_window']['metric_condition_still_reproducible_now']} "
        f"lock_latched={report['occurrence_window']['lock_still_latched']}"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Read-only opportunity gate readiness review.")
    parser.add_argument("--input-json")
    parser.add_argument("--docker-container", default=DEFAULT_CONTAINER)
    parser.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR))
    parser.add_argument("--no-write", action="store_true")
    parser.add_argument("--text", action="store_true")
    args = parser.parse_args()

    data = json.loads(Path(args.input_json).read_text(encoding="utf-8")) if args.input_json else fetch_json(args.docker_container)
    report = build_review(data)
    if not args.no_write:
        out_dir = Path(args.out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        path = out_dir / f"opportunity_gate_readiness_review_{stamp}.json"
        path.write_text(json.dumps(report, indent=2, sort_keys=True, default=str), encoding="utf-8")
        report["report_path"] = str(path)
    if args.text:
        print(format_text(report))
        if report.get("report_path"):
            print(f"report: {report['report_path']}")
    else:
        print(json.dumps(report, ensure_ascii=True, sort_keys=True, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
