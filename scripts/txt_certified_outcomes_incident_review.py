#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DEFAULT_CONTAINER = "control-plane"
DEFAULT_INCIDENT_ID = "INC-444A3CCAFA"
DEFAULT_REPORT_PATH = Path("/opt/txt/var/proof_renewal/certified_outcomes_review_runtime_truth_matrix.json")
DEFAULT_OUT_DIR = Path("/opt/txt/var/proof_renewal")

ENDPOINT_STILL_BLOCKED = "A_ENDPOINT_STILL_BLOCKED"
READY_TO_CLOSE = "B_ENDPOINT_SANE_PROOFS_COMPLETE"
CERTIFICATION_INCOMPLETE = "C_ENDPOINT_SANE_CERTIFICATION_INCOMPLETE"
UNRESOLVED_INSUFFICIENT = "D_NON_REPRODUCIBLE_PROOF_INSUFFICIENT"
THRESHOLD_NOT_REACHED = "E_CERTIFIED_OUTCOMES_THRESHOLD_NOT_REACHED"


def _load_promotion_gate():
    path = Path(__file__).resolve().with_name("bingx_proof_promotion_gate_review.py")
    spec = importlib.util.spec_from_file_location("bingx_proof_promotion_gate_review", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("promotion gate module unavailable")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _load_projection():
    path = Path(__file__).resolve().with_name("txt_certified_outcomes_projection.py")
    spec = importlib.util.spec_from_file_location("txt_certified_outcomes_projection", path)
    if spec is None or spec.loader is None:
        return None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def fetch_incident(container: str, incident_id: str) -> dict[str, Any] | None:
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

incident_id = os.environ["INCIDENT_ID"]
with psycopg.connect(db_url()) as conn:
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(
            """
            SELECT ticket_key, severity, title, status, source, payload,
                   created_at, updated_at, resolution_note, closed_at
            FROM incident_tickets
            WHERE ticket_key = %s
            """,
            (incident_id,),
        )
        row = cur.fetchone()
print(json.dumps(dict(row) if row else None, default=str, sort_keys=True))
'''
    result = subprocess.run(
        ["docker", "exec", "-i", "-e", f"INCIDENT_ID={incident_id}", container, "python3", "-c", code],
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


def finding_codes(report: dict[str, Any]) -> set[str]:
    return {str(item.get("code") or "") for item in report.get("findings", []) if isinstance(item, dict)}


def route_status(report: dict[str, Any], route: str) -> dict[str, Any] | None:
    for row in report.get("route_matrix", []):
        if isinstance(row, dict) and row.get("route") == route:
            return {
                "aligned": row.get("aligned"),
                "divergence_pct": row.get("divergence_pct"),
                "projected_jsonl": row.get("projected_jsonl"),
                "api_payload": row.get("api_payload"),
                "ui_payload": row.get("ui_payload"),
            }
    return None


def build_review(
    *,
    incident: dict[str, Any] | None,
    scanner_report: dict[str, Any],
    promotion_review: dict[str, Any],
    projection_report: dict[str, Any] | None = None,
    generated_at: datetime | None = None,
) -> dict[str, Any]:
    now = generated_at or datetime.now(timezone.utc)
    certified = scanner_report.get("certified_outcomes") if isinstance(scanner_report.get("certified_outcomes"), dict) else {}
    runtime_context = scanner_report.get("runtime_context") if isinstance(scanner_report.get("runtime_context"), dict) else {}
    source_tree = runtime_context.get("source_tree_certification") if isinstance(runtime_context.get("source_tree_certification"), dict) else {}
    codes = finding_codes(scanner_report)
    certified_blocked = "certified_outcomes_below_gate" in codes
    replay_diverged = "replay_truth_divergence_detected" in codes
    proof_validated = bool(promotion_review.get("PROOF_LAYER_VALIDATED"))
    clean_cycles = int((promotion_review.get("counts") or {}).get("clean_cycles") or 0)
    clean_sides = promotion_review.get("clean_sides") or []
    certified_total = int(certified.get("certified_total") or 0)
    required_total = int(certified.get("required_total") or 100)
    base_outcome_total = int(runtime_context.get("base_outcome_total") or 0)
    projected_candidate_total = int((projection_report or {}).get("candidate_total") or 0)
    projected_certified_total = int((projection_report or {}).get("certified_total") or 0)
    projection_blockers = list((projection_report or {}).get("blockers") or [])

    if certified_blocked and proof_validated and 0 < projected_certified_total < required_total:
        verdict = THRESHOLD_NOT_REACHED
        disposition = "keep_incident_active_until_threshold_or_gate_scope_decision"
    elif certified_blocked and proof_validated and projected_candidate_total > 0 and projected_certified_total == 0:
        verdict = CERTIFICATION_INCOMPLETE
        disposition = "fix_projection_blockers_before_closure"
    elif certified_blocked and proof_validated and base_outcome_total == 0:
        verdict = CERTIFICATION_INCOMPLETE
        disposition = "fix_projection_or_certification_mapping_before_closure"
    elif certified_blocked:
        verdict = ENDPOINT_STILL_BLOCKED
        disposition = "keep_incident_active_and_fix_reported_gate"
    elif not certified_blocked and proof_validated and certified_total >= required_total:
        verdict = READY_TO_CLOSE
        disposition = "eligible_to_close_with_scanner_and_proof_evidence_refs"
    else:
        verdict = UNRESOLVED_INSUFFICIENT
        disposition = "do_not_close_without_more_evidence"

    return {
        "generated_at": now.isoformat(),
        "mode": "read_only",
        "incident_id": (incident or {}).get("ticket_key"),
        "incident_status": (incident or {}).get("status"),
        "incident_title": (incident or {}).get("title"),
        "endpoint": {
            "route": "/constitutional/certified-outcomes",
            "kind": "scanner_virtual_gate",
            "http_control_plane_endpoint_present": False,
            "note": "The route is emitted by the constitutional scanner; it is not a control-plane HTTP endpoint.",
        },
        "scanner": {
            "report_generated_at": scanner_report.get("generated_at_iso"),
            "schema_version": scanner_report.get("schema_version"),
            "finding_codes": sorted(codes),
            "certified_outcomes": certified,
            "runtime_context": {
                "base_outcome_total": base_outcome_total,
                "selected_replay_decision_id": runtime_context.get("selected_replay_decision_id"),
                "collection_failures": runtime_context.get("collection_failures"),
                "source_tree_certification": source_tree,
                "certified_outcomes_counter": runtime_context.get("certified_outcomes_counter"),
            },
            "replay_truth": route_status(scanner_report, "/api/execution/replay/[decisionId]"),
        },
        "projection": {
            "schema_version": (projection_report or {}).get("schema_version"),
            "base_outcome_total": (projection_report or {}).get("base_outcome_total"),
            "candidate_total": projected_candidate_total,
            "certified_total": projected_certified_total,
            "rejected_total": (projection_report or {}).get("rejected_total"),
            "blockers": projection_blockers,
            "projection_digest": (projection_report or {}).get("projection_digest"),
        },
        "proof_layer": {
            "validated": proof_validated,
            "clean_cycles": clean_cycles,
            "clean_sides": clean_sides,
            "cycles": promotion_review.get("cycles"),
        },
        "answers": {
            "endpoint_responds_currently": "not_applicable_scanner_virtual_gate",
            "precise_blocking_check": (
                f"certified_outcomes {certified_total}/{required_total}; scanner_base_outcome_total={base_outcome_total}; "
                f"projected_candidates={projected_candidate_total}; projected_certified={projected_certified_total}; "
                f"projection_blockers={','.join(projection_blockers) or 'none'}; source_tree_cap_pct={source_tree.get('cap_pct')}"
            ),
            "three_clean_cycles_in_certified_outcomes": clean_cycles >= 3 and projected_candidate_total >= 3,
            "fills_outcomes_reality_gap_aligned_for_proof_cycles": proof_validated,
            "blocker_reproducible": certified_blocked,
            "incident_state": "active" if certified_blocked else "resolved_or_non_reproducible",
            "additional_blocker": "replay_truth_divergence_detected" if replay_diverged else None,
            "threshold_not_reached": 0 < projected_certified_total < required_total,
        },
        "verdict": verdict,
        "recommended_disposition": disposition,
        "RESET_OR_CLOSE_PERFORMED": False,
    }


def format_text(review: dict[str, Any]) -> str:
    certified = review["scanner"]["certified_outcomes"]
    answers = review["answers"]
    projection = review.get("projection") or {}
    return (
        f"CERTIFIED_OUTCOMES_REVIEW verdict={review['verdict']} "
        f"incident_state={answers['incident_state']} "
        f"certified={certified.get('certified_total')}/{certified.get('required_total')} "
        f"candidates={projection.get('candidate_total')} "
        f"projected_certified={projection.get('certified_total')} "
        f"proof_validated={review['proof_layer']['validated']} "
        f"blocker_reproducible={answers['blocker_reproducible']} "
        f"additional_blocker={answers['additional_blocker'] or 'none'}"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Read-only review for the certified outcomes incident.")
    parser.add_argument("--incident-id", default=DEFAULT_INCIDENT_ID)
    parser.add_argument("--docker-container", default=DEFAULT_CONTAINER)
    parser.add_argument("--scanner-report", default=str(DEFAULT_REPORT_PATH))
    parser.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR))
    parser.add_argument("--no-write", action="store_true")
    parser.add_argument("--text", action="store_true")
    args = parser.parse_args()

    gate = _load_promotion_gate()
    projector = _load_projection()
    payload = gate.fetch_db_payload(args.docker_container, limit=100)
    promotion_review = gate.build_review(payload, runtime={}, readiness={}, rail={}, fresh_hours=72.0)
    incident = fetch_incident(args.docker_container, args.incident_id)
    scanner_report = load_json(Path(args.scanner_report))
    projection_report = projector.build_projection(payload, scanner_report=scanner_report, repo_root=Path("/opt/txt")) if projector else None
    review = build_review(
        incident=incident,
        scanner_report=scanner_report,
        promotion_review=promotion_review,
        projection_report=projection_report,
    )

    if not args.no_write:
        out_dir = Path(args.out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        path = out_dir / f"certified_outcomes_incident_review_{stamp}.json"
        path.write_text(json.dumps(review, indent=2, sort_keys=True, default=str), encoding="utf-8")
        review["report_path"] = str(path)

    if args.text:
        print(format_text(review))
        if review.get("report_path"):
            print(f"report: {review['report_path']}")
    else:
        print(json.dumps(review, ensure_ascii=True, sort_keys=True, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
