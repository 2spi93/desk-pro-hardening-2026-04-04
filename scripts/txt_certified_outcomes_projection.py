#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DEFAULT_CONTAINER = "control-plane"
DEFAULT_SCANNER_REPORT = Path("/opt/txt/var/proof_renewal/certified_outcomes_review_runtime_truth_matrix.json")
DEFAULT_OUT_DIR = Path("/opt/txt/var/proof_renewal")
CERTIFIER_VERSION = "txt.certified_outcomes.proof_projection.v1"


def _load_promotion_gate():
    path = Path(__file__).resolve().with_name("bingx_proof_promotion_gate_review.py")
    spec = importlib.util.spec_from_file_location("bingx_proof_promotion_gate_review", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("promotion gate module unavailable")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def load_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"missing": True, "path": str(path)}
    return data if isinstance(data, dict) else {"invalid": True, "path": str(path)}


def stable_digest(payload: Any) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def git_head(root: Path) -> str | None:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=root,
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=10,
        )
    except Exception:
        return None
    return result.stdout.strip() or None


def scanner_finding_codes(scanner_report: dict[str, Any]) -> set[str]:
    return {str(item.get("code") or "") for item in scanner_report.get("findings", []) if isinstance(item, dict)}


def scanner_replay_status(scanner_report: dict[str, Any]) -> dict[str, Any]:
    for row in scanner_report.get("route_matrix", []):
        if isinstance(row, dict) and row.get("route") == "/api/execution/replay/[decisionId]":
            return {
                "aligned": row.get("aligned"),
                "divergence_pct": row.get("divergence_pct"),
                "projected_jsonl": row.get("projected_jsonl"),
                "api_payload": row.get("api_payload"),
                "ui_payload": row.get("ui_payload"),
            }
    return {"aligned": None, "divergence_pct": None}


def proof_finalization(outcome: dict[str, Any] | None) -> dict[str, Any]:
    metadata = outcome.get("metadata") if isinstance(outcome, dict) else {}
    if isinstance(metadata, str):
        try:
            metadata = json.loads(metadata)
        except json.JSONDecodeError:
            metadata = {}
    if not isinstance(metadata, dict):
        return {}
    value = metadata.get("proof_finalization")
    return value if isinstance(value, dict) else {}


def build_candidate(
    cycle: Any,
    *,
    scanner_report: dict[str, Any],
    source_tree_digest: str | None,
) -> dict[str, Any]:
    entry = cycle.entry_fill or {}
    exit_fill = cycle.exit_fill or {}
    outcome = cycle.outcome or {}
    gap = cycle.gap or {}
    proof = proof_finalization(outcome)
    evidence_refs = proof.get("evidence_refs") if isinstance(proof.get("evidence_refs"), dict) else {}
    scanner_codes = scanner_finding_codes(scanner_report)
    replay_status = scanner_replay_status(scanner_report)
    runtime_context = scanner_report.get("runtime_context") if isinstance(scanner_report.get("runtime_context"), dict) else {}
    source_tree = runtime_context.get("source_tree_certification") if isinstance(runtime_context.get("source_tree_certification"), dict) else {}

    blockers: list[str] = []
    if not entry:
        blockers.append("missing_entry_fill")
    if not exit_fill:
        blockers.append("missing_exit_fill")
    if str(outcome.get("status") or "").lower() != "finalized":
        blockers.append("outcome_not_finalized")
    if not gap:
        blockers.append("missing_reality_gap_sample")
    if gap.get("failure_source"):
        blockers.append("reality_gap_failure_source_present")
    if "replay_truth_divergence_detected" in scanner_codes:
        blockers.append("replay_truth_divergence")
    if source_tree.get("cap_pct") in (0, 0.0):
        blockers.append("source_tree_cap_zero")
    if not source_tree_digest:
        blockers.append("missing_source_tree_digest")

    replay_certificate = {
        "decision_id": entry.get("decision_id"),
        "scanner_report_generated_at": scanner_report.get("generated_at_iso"),
        "selected_replay_decision_id": runtime_context.get("selected_replay_decision_id"),
        "replay_truth": replay_status,
    }
    replay_digest = stable_digest(replay_certificate)
    outcome_version = proof.get("computed_values_hash") or stable_digest(outcome)
    candidate_core = {
        "decision_id": entry.get("decision_id"),
        "proof_cycle_id": cycle.root,
        "entry_fill_id": entry.get("fill_id"),
        "exit_fill_id": exit_fill.get("fill_id"),
        "outcome_id": outcome.get("decision_id"),
        "outcome_version": outcome_version,
        "reality_gap_sample_id": gap.get("sample_id"),
        "replay_certificate_id": f"replay-{entry.get('decision_id')}",
        "replay_certificate_digest": replay_digest,
        "source_tree_digest": source_tree_digest,
        "certifier_version": CERTIFIER_VERSION,
    }
    status = "certified" if not blockers else "rejected"
    return {
        **candidate_core,
        "candidate": True,
        "certification_status": status,
        "certification_blockers": blockers,
        "certified_at": datetime.now(timezone.utc).isoformat() if status == "certified" else None,
        "candidate_digest": stable_digest({**candidate_core, "certification_blockers": blockers}),
    }


def build_projection(
    payload: dict[str, list[dict[str, Any]]],
    *,
    scanner_report: dict[str, Any],
    repo_root: Path,
) -> dict[str, Any]:
    gate = _load_promotion_gate()
    cycles = gate.group_cycles(payload)
    source_tree_digest = git_head(repo_root)
    candidates = [
        build_candidate(cycle, scanner_report=scanner_report, source_tree_digest=source_tree_digest)
        for cycle in cycles
        if cycle.entry_fill and cycle.exit_fill and cycle.outcome and cycle.gap
    ]
    blockers = sorted({blocker for candidate in candidates for blocker in candidate["certification_blockers"]})
    projection_core = {
        "certifier_version": CERTIFIER_VERSION,
        "source_tree_digest": source_tree_digest,
        "scanner_report_generated_at": scanner_report.get("generated_at_iso"),
        "candidate_digests": [candidate["candidate_digest"] for candidate in candidates],
    }
    return {
        "schema_version": "txt-certified-outcomes-projection/v1",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "mode": "read_only_derived_projection",
        "base_outcome_total": len(candidates),
        "candidate_total": len(candidates),
        "certified_total": sum(1 for candidate in candidates if candidate["certification_status"] == "certified"),
        "rejected_total": sum(1 for candidate in candidates if candidate["certification_status"] != "certified"),
        "blockers": blockers,
        "projection_digest": stable_digest(projection_core),
        "candidates": candidates,
        "notes": [
            "Derived from canonical execution_fill_events, decision_outcomes, and reality_gap_samples.",
            "No rows are inserted or backfilled by this projection.",
        ],
    }


def format_text(report: dict[str, Any]) -> str:
    blockers = ",".join(report.get("blockers") or []) or "none"
    return (
        f"CERTIFIED_OUTCOMES_PROJECTION candidates={report['candidate_total']} "
        f"certified={report['certified_total']} rejected={report['rejected_total']} "
        f"base_outcome_total={report['base_outcome_total']} blockers={blockers} "
        f"digest={report['projection_digest']}"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Read-only certified outcomes projection from canonical proof cycles.")
    parser.add_argument("--docker-container", default=DEFAULT_CONTAINER)
    parser.add_argument("--scanner-report", default=str(DEFAULT_SCANNER_REPORT))
    parser.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR))
    parser.add_argument("--repo-root", default="/opt/txt")
    parser.add_argument("--no-write", action="store_true")
    parser.add_argument("--text", action="store_true")
    args = parser.parse_args()

    gate = _load_promotion_gate()
    payload = gate.fetch_db_payload(args.docker_container, limit=100)
    report = build_projection(payload, scanner_report=load_json(Path(args.scanner_report)), repo_root=Path(args.repo_root))

    if not args.no_write:
        out_dir = Path(args.out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        path = out_dir / f"certified_outcomes_projection_{stamp}.json"
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
