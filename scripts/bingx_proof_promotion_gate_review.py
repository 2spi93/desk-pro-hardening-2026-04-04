#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
import subprocess
import sys
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


DEFAULT_CONTAINER = "control-plane"
DEFAULT_OUT_DIR = Path("/opt/txt/var/proof_renewal")
DEFAULT_MIN_CYCLES = 3
DEFAULT_FRESH_HOURS = 72.0
DEFAULT_SCANNER_REPORT = DEFAULT_OUT_DIR / "certified_outcomes_review_runtime_truth_matrix.json"


def _load_incident_adjudicator():
    path = Path(__file__).resolve().with_name("txt_incident_adjudication.py")
    if not path.exists():
        return None
    spec = importlib.util.spec_from_file_location("txt_incident_adjudication", path)
    if spec is None or spec.loader is None:
        return None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


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


def cycle_root(decision_id: Any) -> str:
    text = str(decision_id or "").strip()
    for suffix in ("-entry", "-exit"):
        if text.endswith(suffix):
            return text[: -len(suffix)]
    return text


def is_entry(decision_id: Any) -> bool:
    return str(decision_id or "").strip().endswith("-entry")


def is_exit(decision_id: Any) -> bool:
    return str(decision_id or "").strip().endswith("-exit")


def fetch_runtime(container: str) -> dict[str, Any]:
    code = r'''
import json
import urllib.request
import apps.control_plane.main as cp

def get(url):
    return json.loads(urllib.request.urlopen(url, timeout=8).read().decode())

out = {}
try:
    h = get("http://127.0.0.1:8000/health")
    gate = h.get("opportunity_gate") if isinstance(h.get("opportunity_gate"), dict) else {}
    out["control_plane"] = h.get("status")
    out["system_mode"] = h.get("system_mode")
    out["gate"] = gate.get("status")
    out["kill_recommended"] = gate.get("kill_switch_recommended")
    out["pending_intents"] = h.get("pending_intents")
except Exception as e:
    out["control_plane_error"] = str(e)[:120]
try:
    risk = get("http://risk-gateway:8001/health")
    out["risk_gateway"] = risk.get("status")
    out["daily_notional_used_usd"] = risk.get("daily_notional_used_usd")
    out["daily_notional_limit_usd"] = risk.get("daily_notional_limit_usd") or 30.0
except Exception as e:
    out["risk_gateway_error"] = str(e)[:120]
try:
    lock = cp._local_execution_lock_snapshot(execution_phase="promotion_gate_review")
    out["local_lock_active"] = lock.get("lock_active")
    out["local_lock_status"] = lock.get("status")
    out["local_lock_reason"] = lock.get("lock_reason")
except Exception as e:
    out["local_lock_error"] = str(e)[:120]
print(json.dumps(out, sort_keys=True))
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


def fetch_db_payload(container: str, *, limit: int) -> dict[str, list[dict[str, Any]]]:
    code = r'''
import json
import os
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

limit = max(1, min(500, int(os.environ.get("PROMOTION_GATE_LIMIT", "100"))))
pattern = "proofcyc-%"
with psycopg.connect(db_url()) as conn:
    with conn.cursor(row_factory=dict_row) as cur:
        payload = {
            "fills": rows(
                cur,
                """
                SELECT decision_id, fill_id, venue, instrument, side, price,
                       size_base, notional_usd, fill_type, slippage_bps,
                       fill_latency_ms, filled_at, created_at
                FROM execution_fill_events
                WHERE decision_id LIKE %s
                ORDER BY filled_at DESC, created_at DESC
                LIMIT %s
                """,
                (pattern, limit),
            ),
            "outcomes": rows(
                cur,
                """
                SELECT decision_id, source, provider, status, fees_usd,
                       net_result_usd, created_at, updated_at, metadata
                FROM decision_outcomes
                WHERE decision_id LIKE %s
                ORDER BY updated_at DESC NULLS LAST, created_at DESC
                LIMIT %s
                """,
                (pattern, limit),
            ),
            "gaps": rows(
                cur,
                """
                SELECT sample_id, decision_id, symbol, venue, side,
                       gap_slippage_bps, gap_latency_ms, gap_impact_bps,
                       failure_source, created_at
                FROM reality_gap_samples
                WHERE decision_id LIKE %s
                ORDER BY created_at DESC
                LIMIT %s
                """,
                (pattern, limit),
            ),
            "incidents": rows(
                cur,
                """
                SELECT ticket_key, severity, title, status, source, created_at, updated_at
                FROM incident_tickets
                WHERE COALESCE(status, '') <> 'closed'
                ORDER BY updated_at DESC NULLS LAST, created_at DESC
                LIMIT %s
                """,
                (limit,),
            ),
        }
print(json.dumps(payload, default=str, sort_keys=True))
'''
    result = subprocess.run(
        ["docker", "exec", "-i", "-e", f"PROMOTION_GATE_LIMIT={limit}", container, "python3", "-c", code],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=90,
    )
    return json.loads(result.stdout)


def load_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"missing": True, "path": str(path)}
    return data if isinstance(data, dict) else {"invalid": True, "path": str(path)}


def fetch_certification(container: str, *, scanner_report_path: Path = DEFAULT_SCANNER_REPORT) -> dict[str, Any]:
    """Delegate to the adjudicator's canonical certification probe so the
    promotion gate and the standalone adjudicator share one source of truth.
    Reads only; places no order and mutates no ticket."""
    adjudicator = _load_incident_adjudicator()
    if adjudicator is None:
        return {}
    return adjudicator.fetch_certification_runtime(container, scanner_report_path=scanner_report_path)


@dataclass
class Cycle:
    root: str
    entry_fill: dict[str, Any] | None
    exit_fill: dict[str, Any] | None
    outcome: dict[str, Any] | None
    gap: dict[str, Any] | None

    @property
    def side(self) -> str:
        return str((self.entry_fill or {}).get("side") or "").lower()

    @property
    def completed_at(self) -> datetime | None:
        candidates = [
            parse_time((self.exit_fill or {}).get("filled_at")),
            parse_time((self.outcome or {}).get("updated_at")),
            parse_time((self.gap or {}).get("created_at")),
        ]
        return max((item for item in candidates if item is not None), default=None)


def group_cycles(payload: dict[str, list[dict[str, Any]]]) -> list[Cycle]:
    fills_by_root: dict[str, dict[str, dict[str, Any]]] = defaultdict(dict)
    for row in payload.get("fills", []):
        root = cycle_root(row.get("decision_id"))
        if not root:
            continue
        if is_entry(row.get("decision_id")):
            fills_by_root[root]["entry"] = row
        elif is_exit(row.get("decision_id")):
            fills_by_root[root]["exit"] = row

    outcomes_by_root: dict[str, dict[str, Any]] = {}
    for row in payload.get("outcomes", []):
        root = cycle_root(row.get("decision_id"))
        if root and is_entry(row.get("decision_id")):
            outcomes_by_root[root] = row

    gaps_by_root: dict[str, dict[str, Any]] = {}
    for row in payload.get("gaps", []):
        root = cycle_root(row.get("decision_id"))
        if root and is_entry(row.get("decision_id")):
            gaps_by_root[root] = row

    roots = set(fills_by_root) | set(outcomes_by_root) | set(gaps_by_root)
    cycles = [
        Cycle(
            root=root,
            entry_fill=fills_by_root.get(root, {}).get("entry"),
            exit_fill=fills_by_root.get(root, {}).get("exit"),
            outcome=outcomes_by_root.get(root),
            gap=gaps_by_root.get(root),
        )
        for root in roots
    ]
    return sorted(cycles, key=lambda c: c.completed_at or datetime.min.replace(tzinfo=timezone.utc))


def clean_cycle(cycle: Cycle) -> tuple[bool, list[str]]:
    reasons: list[str] = []
    if not cycle.entry_fill:
        reasons.append("missing_entry_fill")
    if not cycle.exit_fill:
        reasons.append("missing_exit_fill")
    if cycle.side not in {"buy", "sell"}:
        reasons.append("entry_side_missing")
    for label, fill in (("entry", cycle.entry_fill), ("exit", cycle.exit_fill)):
        if fill:
            if str(fill.get("venue") or "").lower() != "bingx":
                reasons.append(f"{label}_venue_not_bingx")
            if str(fill.get("fill_type") or "").lower() != "live-broker":
                reasons.append(f"{label}_fill_type_not_live_broker")
            if float(fill.get("notional_usd") or 0.0) <= 0.0:
                reasons.append(f"{label}_notional_zero")
    if not cycle.outcome:
        reasons.append("missing_outcome")
    else:
        if str(cycle.outcome.get("status") or "").lower() != "finalized":
            reasons.append("outcome_not_finalized")
        if str(cycle.outcome.get("provider") or "").lower() != "bingx":
            reasons.append("outcome_provider_not_bingx")
        if str(cycle.outcome.get("source") or "").lower() != "intent":
            reasons.append("outcome_source_not_intent")
    if not cycle.gap:
        reasons.append("missing_reality_gap")
    else:
        if str(cycle.gap.get("venue") or "").lower() != "bingx":
            reasons.append("reality_gap_venue_not_bingx")
        if cycle.gap.get("failure_source"):
            reasons.append("reality_gap_failure_source_present")
    return len(reasons) == 0, reasons


def build_review(
    payload: dict[str, list[dict[str, Any]]],
    *,
    runtime: dict[str, Any] | None = None,
    readiness: dict[str, Any] | None = None,
    rail: dict[str, Any] | None = None,
    min_cycles: int = DEFAULT_MIN_CYCLES,
    fresh_hours: float = DEFAULT_FRESH_HOURS,
    now: datetime | None = None,
) -> dict[str, Any]:
    current = now or datetime.now(timezone.utc)
    since = current - timedelta(hours=fresh_hours) if fresh_hours > 0 else None
    cycles = group_cycles(payload)
    assessed = []
    for cycle in cycles:
        ok, reasons = clean_cycle(cycle)
        assessed.append(
            {
                "cycle_root": cycle.root,
                "side": cycle.side,
                "completed_at": cycle.completed_at.isoformat() if cycle.completed_at else None,
                "clean": ok,
                "reasons": reasons,
                "entry_decision_id": (cycle.entry_fill or {}).get("decision_id"),
                "exit_decision_id": (cycle.exit_fill or {}).get("decision_id"),
                "outcome_status": (cycle.outcome or {}).get("status"),
                "reality_gap_sample_id": (cycle.gap or {}).get("sample_id"),
            }
        )
    clean = [row for row in assessed if row["clean"]]
    fresh_clean = [
        row
        for row in clean
        if since is None or (parse_time(row.get("completed_at")) is not None and parse_time(row.get("completed_at")) >= since)
    ]
    clean_sides = sorted({row["side"] for row in clean})

    blockers: list[str] = []
    if len(clean) < min_cycles:
        blockers.append(f"clean_cycles<{min_cycles}")
    if not {"buy", "sell"} <= set(clean_sides):
        blockers.append("buy_and_sell_not_both_covered")
    if not fresh_clean:
        blockers.append("latest_proof_not_fresh")

    runtime = runtime or {}
    if runtime.get("control_plane") not in (None, "ok"):
        blockers.append("control_plane_not_ok")
    if runtime.get("system_mode") not in (None, "guarded_auto"):
        blockers.append("system_mode_not_guarded_auto")
    if runtime.get("gate") not in (None, "go"):
        blockers.append("gate_not_go")
    if runtime.get("kill_recommended") not in (None, False):
        blockers.append("kill_recommended")
    if int(runtime.get("pending_intents") or 0) != 0:
        blockers.append("pending_intents_nonzero")
    if runtime.get("local_lock_active") not in (None, False):
        blockers.append("local_execution_lock_active")
    if runtime.get("risk_gateway") not in (None, "ok"):
        blockers.append("risk_gateway_not_ok")
    used = runtime.get("daily_notional_used_usd")
    limit = runtime.get("daily_notional_limit_usd")
    try:
        if used is not None and limit is not None and float(used) >= float(limit):
            blockers.append("risk_budget_not_available_today")
    except (TypeError, ValueError):
        blockers.append("risk_budget_unparseable")

    readiness = readiness or {}
    state = readiness.get("state") if isinstance(readiness.get("state"), dict) else {}
    if readiness and not readiness.get("ready_for_dedicated_go"):
        blockers.append("readiness_not_ready")
    if readiness and not readiness.get("no_market_action"):
        blockers.append("readiness_was_not_read_only")
    if state:
        if int(state.get("open_positions") or 0) != 0:
            blockers.append("readiness_positions_nonzero")
        if int(state.get("open_orders") or 0) != 0:
            blockers.append("readiness_open_orders_nonzero")

    rail = rail or {}
    if rail and rail.get("rail_separation") != "PASS":
        blockers.append("rail_separation_not_pass")

    incidents = payload.get("incidents", [])
    incident_adjudication = None
    if incidents:
        adjudicator = _load_incident_adjudicator()
        if adjudicator is None:
            blockers.append("incident_adjudication_unavailable")
        else:
            incident_adjudication = adjudicator.build_report({"runtime": runtime, "incidents": incidents}, now=current)
            if int(incident_adjudication.get("promotion_relevant_blockers") or 0) > 0:
                blockers.append("promotion_relevant_incidents_present")

    proof_validated = len(clean) >= min_cycles and {"buy", "sell"} <= set(clean_sides)
    promotable = proof_validated and not blockers
    max_notional = 7.5 if promotable else 0.0
    max_cycles = 1 if promotable else 0

    return {
        "generated_at": current.isoformat(),
        "fresh_hours": fresh_hours,
        "min_cycles": min_cycles,
        "PROOF_LAYER_VALIDATED": proof_validated,
        "PROMOTABLE_TO_MICRO_LIVE": promotable,
        "BLOCKERS": blockers,
        "MAX_NOTIONAL": max_notional,
        "MAX_CYCLES_PER_DAY": max_cycles,
        "AUTO_STOP_RULES": [
            "no_retry",
            "abort_on_unknown_or_indeterminate",
            "require_FILLED_canonical_entry_and_exit",
            "flatten_verify_positions_0_open_orders_0",
            "stop_on_gate_not_go_or_kill_or_local_lock",
            "stop_on_rail_separation_failure",
            "stop_when_daily_risk_budget_exhausted",
        ],
        "counts": {
            "cycles_total": len(assessed),
            "clean_cycles": len(clean),
            "fresh_clean_cycles": len(fresh_clean),
            "clean_buy": sum(1 for row in clean if row["side"] == "buy"),
            "clean_sell": sum(1 for row in clean if row["side"] == "sell"),
            "active_incidents": len(incidents),
            "promotion_relevant_incident_blockers": (
                int(incident_adjudication.get("promotion_relevant_blockers") or 0)
                if isinstance(incident_adjudication, dict)
                else None
            ),
        },
        "clean_sides": clean_sides,
        "cycles": assessed,
        "runtime": runtime,
        "readiness": {
            "ready_for_dedicated_go": readiness.get("ready_for_dedicated_go"),
            "no_market_action": readiness.get("no_market_action"),
            "open_positions": state.get("open_positions"),
            "open_orders": state.get("open_orders"),
        },
        "rail_separation": rail.get("rail_separation"),
        "incidents": incidents[:20],
        "incident_adjudication": {
            "summary": incident_adjudication.get("summary"),
            "promotion_relevant_blockers": incident_adjudication.get("promotion_relevant_blockers"),
            "promotion_incident_block_clear": incident_adjudication.get("PROMOTION_INCIDENT_BLOCK_CLEAR"),
        } if isinstance(incident_adjudication, dict) else None,
        "notes": [
            "This is a cold review only; it does not place orders, reset budget, or authorize continuous live trading.",
            "PROMOTABLE_TO_MICRO_LIVE=true would authorize a human promotion review only, not automatic trading.",
        ],
    }


def format_text(review: dict[str, Any]) -> str:
    blockers = review.get("BLOCKERS") or []
    return (
        f"PROMOTION_GATE_REVIEW proof_validated={review['PROOF_LAYER_VALIDATED']} "
        f"PROMOTABLE_TO_MICRO_LIVE={review['PROMOTABLE_TO_MICRO_LIVE']} "
        f"clean={review['counts']['clean_cycles']}/{review['min_cycles']} "
        f"sides={','.join(review['clean_sides']) or 'none'} "
        f"budget={review.get('runtime', {}).get('daily_notional_used_usd')}/"
        f"{review.get('runtime', {}).get('daily_notional_limit_usd')} "
        f"blockers={','.join(blockers) if blockers else 'none'}"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Cold promotion-gate review for BingX autonomous proof cycles.")
    parser.add_argument("--input-json", help="Use a JSON payload instead of querying Docker/control-plane.")
    parser.add_argument("--docker-container", default=DEFAULT_CONTAINER)
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--min-cycles", type=int, default=DEFAULT_MIN_CYCLES)
    parser.add_argument("--fresh-hours", type=float, default=DEFAULT_FRESH_HOURS)
    parser.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR))
    parser.add_argument("--no-write", action="store_true")
    parser.add_argument("--text", action="store_true")
    parser.add_argument("--check", action="store_true", help="Exit 2 when PROMOTABLE_TO_MICRO_LIVE is false.")
    args = parser.parse_args()

    if args.input_json:
        data = json.loads(Path(args.input_json).read_text(encoding="utf-8"))
        payload = data.get("payload", data)
        runtime = data.get("runtime", {})
        readiness = data.get("readiness", {})
        rail = data.get("rail", {})
    else:
        payload = fetch_db_payload(args.docker_container, limit=args.limit)
        runtime = fetch_runtime(args.docker_container)
        runtime["certification"] = fetch_certification(args.docker_container)
        out_dir = Path(args.out_dir)
        readiness = load_json(out_dir / "readiness_report.json")
        rail = load_json(out_dir / "rail_separation_audit.json")

    review = build_review(
        payload,
        runtime=runtime,
        readiness=readiness,
        rail=rail,
        min_cycles=args.min_cycles,
        fresh_hours=args.fresh_hours,
    )

    if not args.no_write:
        out_dir = Path(args.out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        path = out_dir / f"promotion_gate_review_{stamp}.json"
        path.write_text(json.dumps(review, indent=2, sort_keys=True, default=str), encoding="utf-8")
        review["report_path"] = str(path)

    if args.text:
        print(format_text(review))
        if review.get("report_path"):
            print(f"report: {review['report_path']}")
    else:
        print(json.dumps(review, ensure_ascii=True, sort_keys=True, default=str))

    if args.check and not review["PROMOTABLE_TO_MICRO_LIVE"]:
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
