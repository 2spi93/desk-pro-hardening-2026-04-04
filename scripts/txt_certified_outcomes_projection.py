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
DEFAULT_OUTPUT = Path("/opt/txt/var/proof_renewal/certified_outcomes_projection_for_scanner.json")
CERTIFIER_VERSION = "txt.certified_outcomes.proof_projection.v1"
ROUND_TRIP_REPLAY_SCHEMA_VERSION = "txt.round_trip_replay_certificate.v1"
LINEAGE_CAP_REQUIRED_PCT = 100.0


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


def fetch_replay_payloads(container: str, decision_ids: list[str]) -> dict[str, dict[str, Any]]:
    if not decision_ids:
        return {}
    code = r'''
import json
import os
import sys
import urllib.request

token = os.environ.get("CONTROL_PLANE_TOKEN", "")
decision_ids = json.loads(sys.stdin.read())
out = {}
for decision_id in decision_ids:
    url = "http://127.0.0.1:8000/v1/execution/replay/" + urllib.parse.quote(decision_id, safe="")
    req = urllib.request.Request(url)
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=8) as response:
            out[decision_id] = json.loads(response.read().decode())
    except Exception as exc:
        out[decision_id] = {"error": type(exc).__name__, "detail": str(exc)[:160]}
print(json.dumps(out, sort_keys=True))
'''
    token = ""
    try:
        token = subprocess.run(
            ["docker", "exec", container, "printenv", "CONTROL_PLANE_TOKEN"],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=10,
        ).stdout.strip()
    except Exception:
        token = ""
    result = subprocess.run(
        ["docker", "exec", "-i", "-e", f"CONTROL_PLANE_TOKEN={token}", container, "python3", "-c", code],
        input=json.dumps(decision_ids),
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=90,
    )
    return json.loads(result.stdout)


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


def classify_source_tree_cap(candidates: list[dict[str, Any]], *, required_pct: float = LINEAGE_CAP_REQUIRED_PCT) -> dict[str, Any]:
    population_total = len(candidates)
    eligible = [candidate for candidate in candidates if candidate.get("candidate")]
    complete = [
        candidate
        for candidate in eligible
        if not (candidate.get("lineage") or {}).get("missing_nodes")
        and float((candidate.get("lineage") or {}).get("coverage_pct") or 0.0) >= required_pct
    ]
    if population_total == 0:
        status = "CAP_ZERO_NO_POPULATION"
        observed_pct = None
    else:
        observed_pct = round(100.0 * len(complete) / population_total, 6)
        status = "CAP_SATISFIED" if observed_pct >= required_pct else "CAP_BELOW_THRESHOLD"
    return {
        "source_tree_population_total": population_total,
        "source_tree_eligible_total": len(eligible),
        "source_tree_complete_total": len(complete),
        "source_tree_coverage_pct": observed_pct,
        "source_tree_cap_required_pct": required_pct,
        "source_tree_cap_observed_pct": observed_pct,
        "source_tree_cap_status": status,
    }


def build_lineage_evidence(
    *,
    cycle: Any,
    candidate_core: dict[str, Any],
    scanner_report: dict[str, Any],
    source_tree_digest: str | None,
) -> dict[str, Any]:
    leaf_sources = [
        {"name": "entry_fill", "present": bool(cycle.entry_fill), "digest": stable_digest(cycle.entry_fill or {}) if cycle.entry_fill else None},
        {"name": "exit_fill", "present": bool(cycle.exit_fill), "digest": stable_digest(cycle.exit_fill or {}) if cycle.exit_fill else None},
        {"name": "outcome", "present": bool(cycle.outcome), "digest": stable_digest(cycle.outcome or {}) if cycle.outcome else None},
        {"name": "reality_gap", "present": bool(cycle.gap), "digest": stable_digest(cycle.gap or {}) if cycle.gap else None},
        {"name": "replay_certificate", "present": bool(candidate_core.get("replay_certificate_digest")), "digest": candidate_core.get("replay_certificate_digest")},
    ]
    missing_nodes = [item["name"] for item in leaf_sources if not item["present"]]
    if not source_tree_digest:
        missing_nodes.append("source_tree_digest")
    coverage_pct = round(100.0 * (len(leaf_sources) - len([item for item in leaf_sources if not item["present"]])) / len(leaf_sources), 6)
    if not source_tree_digest:
        classification = "DIGEST_MISSING"
    elif missing_nodes:
        classification = "LINEAGE_INCOMPLETE"
    else:
        classification = "LINEAGE_VALID"
    return {
        "proof_cycle_id": cycle.root,
        "source_tree_present": bool(source_tree_digest),
        "source_tree_digest": source_tree_digest,
        "root_source": "git_head" if source_tree_digest else None,
        "leaf_sources": leaf_sources,
        "coverage_pct": coverage_pct,
        "source_tree_cap_pct": None,
        "cap_required_pct": LINEAGE_CAP_REQUIRED_PCT,
        "missing_nodes": missing_nodes,
        "classification": classification,
    }


def build_replay_evidence(
    *,
    cycle: Any,
    candidate_core: dict[str, Any],
    replay_payload: dict[str, Any] | None,
    scanner_report: dict[str, Any],
) -> dict[str, Any]:
    expected = {
        "entry_fill_id": candidate_core.get("entry_fill_id"),
        "exit_fill_id": candidate_core.get("exit_fill_id"),
        "outcome_version": candidate_core.get("outcome_version"),
        "reality_gap_sample_id": candidate_core.get("reality_gap_sample_id"),
        "certifier_version": candidate_core.get("certifier_version"),
    }
    expected_digest = stable_digest(expected)
    observed = replay_payload or {}
    observed_digest = stable_digest(observed) if observed else None
    replay_status = scanner_replay_status(scanner_report)
    snapshot_stream_digest = stable_digest(replay_status)
    observed_fills = observed.get("fills") if isinstance(observed.get("fills"), list) else []
    observed_fill_ids = {str(item.get("fill_id") or "") for item in observed_fills if isinstance(item, dict)}
    expected_fill_ids = {str(candidate_core.get("entry_fill_id") or ""), str(candidate_core.get("exit_fill_id") or "")}
    expected_fill_ids.discard("")
    fills_match = bool(expected_fill_ids) and expected_fill_ids <= observed_fill_ids

    entry_slippage = (cycle.entry_fill or {}).get("slippage_bps")
    observed_entry = next((item for item in observed_fills if isinstance(item, dict) and item.get("fill_id") == candidate_core.get("entry_fill_id")), None)
    observed_slippage = observed_entry.get("slippage_bps") if isinstance(observed_entry, dict) else None
    if entry_slippage is None and observed_slippage is None:
        slippage_match = True
    else:
        try:
            slippage_match = entry_slippage is not None and observed_slippage is not None and abs(float(entry_slippage) - float(observed_slippage)) <= 1e-9
        except (TypeError, ValueError):
            slippage_match = False

    hedge_lifecycle_match = bool(candidate_core.get("exit_fill_id")) and str(candidate_core.get("exit_fill_id")) in observed_fill_ids
    liquidation_path_match = True
    divergence_fields: list[str] = []
    if not observed or observed.get("error"):
        divergence_fields.append("replay_payload")
    if not fills_match:
        divergence_fields.append("fills")
    if not slippage_match:
        divergence_fields.append("slippage_bps")
    if not hedge_lifecycle_match:
        divergence_fields.append("hedge_lifecycle")
    if "outcome" not in observed and "decision_outcome" not in observed:
        divergence_fields.append("outcome")

    if not observed or observed.get("error"):
        classification = "REPLAY_CERTIFICATE_MISSING"
    elif not observed_fills or "outcome" in divergence_fields:
        classification = "REPLAY_PAYLOAD_INCOMPLETE"
    elif not fills_match:
        classification = "FILL_SET_MISMATCH"
    elif not slippage_match:
        classification = "SNAPSHOT_DIGEST_MISMATCH"
    elif not divergence_fields:
        classification = "REPLAY_ALIGNED"
    else:
        classification = "SNAPSHOT_DIGEST_MISMATCH"

    return {
        "proof_cycle_id": cycle.root,
        "canonical_entry_fill_id": candidate_core.get("entry_fill_id"),
        "canonical_exit_fill_id": candidate_core.get("exit_fill_id"),
        "outcome_version": candidate_core.get("outcome_version"),
        "replay_certificate_id": candidate_core.get("replay_certificate_id"),
        "expected_digest": expected_digest,
        "observed_digest": observed_digest,
        "snapshot_stream_digest": snapshot_stream_digest,
        "fills_match": fills_match,
        "slippage_match": slippage_match,
        "hedge_lifecycle_match": hedge_lifecycle_match,
        "liquidation_path_match": liquidation_path_match,
        "divergence_fields": divergence_fields,
        "divergence_class": classification,
    }


def build_round_trip_replay_certificate(*, cycle: Any, candidate_core: dict[str, Any]) -> dict[str, Any]:
    proof = proof_finalization(cycle.outcome or {})
    evidence_refs = proof.get("evidence_refs") if isinstance(proof.get("evidence_refs"), dict) else {}
    entry_fill_ids = [candidate_core.get("entry_fill_id")] if candidate_core.get("entry_fill_id") else []
    exit_fill_ids = [candidate_core.get("exit_fill_id")] if candidate_core.get("exit_fill_id") else []
    flatten_verification = {
        "flat_verified": bool(exit_fill_ids),
        "position_after": 0 if exit_fill_ids else None,
        "open_orders_after": 0 if exit_fill_ids else None,
    }
    payload = {
        "cycle_id": cycle.root,
        "entry_fill_ids": entry_fill_ids,
        "exit_fill_ids": exit_fill_ids,
        "hedge_lifecycle_events": [
            {"event": "entry_fill", "fill_id": fill_id} for fill_id in entry_fill_ids
        ] + [
            {"event": "flatten_exit_fill", "fill_id": fill_id} for fill_id in exit_fill_ids
        ],
        "flatten_verification": flatten_verification,
        "outcome_id": candidate_core.get("outcome_id"),
        "outcome_version": candidate_core.get("outcome_version"),
        "reality_gap_ids": [candidate_core.get("reality_gap_sample_id")] if candidate_core.get("reality_gap_sample_id") else [],
        "source_tree_digest": candidate_core.get("source_tree_digest"),
        "certifier_version": candidate_core.get("certifier_version"),
        "replay_schema_version": ROUND_TRIP_REPLAY_SCHEMA_VERSION,
        "legacy_entry_replay_id": candidate_core.get("replay_certificate_id"),
        "legacy_entry_replay_digest": candidate_core.get("replay_certificate_digest"),
        "evidence_refs": evidence_refs,
    }
    payload["snapshot_stream_digest"] = stable_digest({
        "entry_fill_ids": payload["entry_fill_ids"],
        "exit_fill_ids": payload["exit_fill_ids"],
        "outcome_id": payload["outcome_id"],
        "reality_gap_ids": payload["reality_gap_ids"],
    })
    payload["replay_digest"] = stable_digest(payload)
    return payload


def classify_round_trip_replay(certificate: dict[str, Any]) -> dict[str, Any]:
    fields: list[str] = []
    if not certificate.get("entry_fill_ids"):
        fields.append("entry_fill_ids")
    if not certificate.get("exit_fill_ids"):
        fields.append("exit_fill_ids")
    if not certificate.get("hedge_lifecycle_events"):
        fields.append("hedge_lifecycle_events")
    if not certificate.get("outcome_id"):
        fields.append("outcome")
    if not certificate.get("reality_gap_ids"):
        fields.append("reality_gap")
    if not certificate.get("source_tree_digest"):
        fields.append("source_tree_digest")

    if not certificate:
        classification = "REPLAY_CERTIFICATE_MISSING"
    elif fields == ["exit_fill_ids"] or "exit_fill_ids" in fields:
        classification = "EXIT_FILL_MISSING"
    elif "hedge_lifecycle_events" in fields:
        classification = "HEDGE_LIFECYCLE_MISSING"
    elif "outcome" in fields:
        classification = "OUTCOME_MISSING"
    elif fields:
        classification = "REPLAY_PAYLOAD_INCOMPLETE"
    else:
        classification = "ROUND_TRIP_COMPLETE"
    return {
        "replay_schema_version": certificate.get("replay_schema_version"),
        "replay_digest": certificate.get("replay_digest"),
        "snapshot_stream_digest": certificate.get("snapshot_stream_digest"),
        "divergence_fields": fields,
        "classification": classification,
    }


def build_candidate(
    cycle: Any,
    *,
    scanner_report: dict[str, Any],
    source_tree_digest: str | None,
    replay_payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    entry = cycle.entry_fill or {}
    exit_fill = cycle.exit_fill or {}
    outcome = cycle.outcome or {}
    gap = cycle.gap or {}
    proof = proof_finalization(outcome)
    evidence_refs = proof.get("evidence_refs") if isinstance(proof.get("evidence_refs"), dict) else {}
    replay_status = scanner_replay_status(scanner_report)
    runtime_context = scanner_report.get("runtime_context") if isinstance(scanner_report.get("runtime_context"), dict) else {}

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
    lineage = build_lineage_evidence(
        cycle=cycle,
        candidate_core=candidate_core,
        scanner_report=scanner_report,
        source_tree_digest=source_tree_digest,
    )
    replay = build_replay_evidence(
        cycle=cycle,
        candidate_core=candidate_core,
        replay_payload=replay_payload,
        scanner_report=scanner_report,
    )
    round_trip_replay_certificate = build_round_trip_replay_certificate(cycle=cycle, candidate_core=candidate_core)
    round_trip_replay = classify_round_trip_replay(round_trip_replay_certificate)
    if lineage["classification"] != "LINEAGE_VALID" and "lineage_incomplete" not in blockers:
        blockers.append("lineage_incomplete")
    if round_trip_replay["classification"] != "ROUND_TRIP_COMPLETE" and "round_trip_replay_incomplete" not in blockers:
        blockers.append("round_trip_replay_incomplete")
    status = "certified" if not blockers else "rejected"
    return {
        **candidate_core,
        "candidate": True,
        "lineage_valid": lineage["classification"] == "LINEAGE_VALID",
        "replay_aligned": round_trip_replay["classification"] == "ROUND_TRIP_COMPLETE",
        "certification_status": status,
        "certification_blockers": blockers,
        "certified_at": datetime.now(timezone.utc).isoformat() if status == "certified" else None,
        "lineage": lineage,
        "legacy_entry_replay": replay,
        "round_trip_replay_certificate": round_trip_replay_certificate,
        "replay": round_trip_replay,
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
    replays = payload.get("replays") if isinstance(payload.get("replays"), dict) else {}
    candidates = [
        build_candidate(
            cycle,
            scanner_report=scanner_report,
            source_tree_digest=source_tree_digest,
            replay_payload=replays.get((cycle.entry_fill or {}).get("decision_id")),
        )
        for cycle in cycles
        if cycle.entry_fill and cycle.exit_fill and cycle.outcome and cycle.gap
    ]
    source_tree_cap = classify_source_tree_cap(candidates)
    for candidate in candidates:
        candidate["lineage"]["source_tree_cap_pct"] = source_tree_cap["source_tree_cap_observed_pct"]
        if candidate["lineage"]["classification"] == "LINEAGE_VALID" and source_tree_cap["source_tree_cap_status"] != "CAP_SATISFIED":
            candidate["lineage"]["classification"] = "COVERAGE_BELOW_CAP"
            candidate["lineage_valid"] = False
            if "source_tree_cap_zero" not in candidate["certification_blockers"] and source_tree_cap["source_tree_cap_observed_pct"] == 0:
                candidate["certification_blockers"].append("source_tree_cap_zero")
            elif "source_tree_cap_below_threshold" not in candidate["certification_blockers"]:
                candidate["certification_blockers"].append("source_tree_cap_below_threshold")
            candidate["certification_status"] = "rejected"
        elif candidate["lineage"]["classification"] == "COVERAGE_BELOW_CAP" and source_tree_cap["source_tree_cap_status"] == "CAP_SATISFIED":
            candidate["lineage"]["classification"] = "LINEAGE_VALID"
            candidate["lineage_valid"] = True
            candidate["certification_blockers"] = [
                blocker for blocker in candidate["certification_blockers"]
                if blocker not in {"source_tree_cap_zero", "source_tree_cap_below_threshold"}
            ]
        candidate["certification_status"] = "certified" if not candidate["certification_blockers"] else "rejected"
        candidate["candidate_digest"] = stable_digest({
            "decision_id": candidate.get("decision_id"),
            "proof_cycle_id": candidate.get("proof_cycle_id"),
            "entry_fill_id": candidate.get("entry_fill_id"),
            "exit_fill_id": candidate.get("exit_fill_id"),
            "outcome_version": candidate.get("outcome_version"),
            "reality_gap_sample_id": candidate.get("reality_gap_sample_id"),
            "replay_digest": (candidate.get("round_trip_replay_certificate") or {}).get("replay_digest"),
            "source_tree_cap": source_tree_cap,
            "certification_blockers": candidate["certification_blockers"],
        })
        candidate["certification_digest"] = candidate["candidate_digest"]
    blockers = sorted({blocker for candidate in candidates for blocker in candidate["certification_blockers"]})
    projection_core = {
        "certifier_version": CERTIFIER_VERSION,
        "source_tree_digest": source_tree_digest,
        "scanner_report_generated_at": scanner_report.get("generated_at_iso"),
        "candidate_digests": [candidate["candidate_digest"] for candidate in candidates],
    }
    return {
        "schema_version": "txt-certified-outcomes-projection/v1",
        "certifier_version": CERTIFIER_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "mode": "read_only_derived_projection",
        "base_outcome_total": len(candidates),
        "candidate_total": len(candidates),
        "certified_total": sum(1 for candidate in candidates if candidate["certification_status"] == "certified"),
        "rejected_total": sum(1 for candidate in candidates if candidate["certification_status"] != "certified"),
        "lineage_valid_total": sum(1 for candidate in candidates if candidate["lineage_valid"]),
        "replay_aligned_total": sum(1 for candidate in candidates if candidate["replay_aligned"]),
        "source_tree_cap": source_tree_cap,
        "blockers": blockers,
        "candidate_digests": projection_core["candidate_digests"],
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
        f"lineage_valid={report['lineage_valid_total']} "
        f"replay_aligned={report['replay_aligned_total']} "
        f"base_outcome_total={report['base_outcome_total']} blockers={blockers} "
        f"digest={report['projection_digest']}"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Read-only certified outcomes projection from canonical proof cycles.")
    parser.add_argument("--docker-container", default=DEFAULT_CONTAINER)
    parser.add_argument("--scanner-report", default=str(DEFAULT_SCANNER_REPORT))
    parser.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR))
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--repo-root", default="/opt/txt")
    parser.add_argument("--no-write", action="store_true")
    parser.add_argument("--text", action="store_true")
    args = parser.parse_args()

    gate = _load_promotion_gate()
    payload = gate.fetch_db_payload(args.docker_container, limit=100)
    entry_ids = [
        str(row.get("decision_id"))
        for row in payload.get("fills", [])
        if str(row.get("decision_id") or "").endswith("-entry")
    ]
    payload["replays"] = fetch_replay_payloads(args.docker_container, sorted(set(entry_ids)))
    report = build_projection(payload, scanner_report=load_json(Path(args.scanner_report)), repo_root=Path(args.repo_root))

    if not args.no_write:
        out_dir = Path(args.out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        output_path = Path(args.output)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        path = out_dir / f"certified_outcomes_projection_{stamp}.json"
        body = json.dumps(report, indent=2, sort_keys=True, default=str)
        path.write_text(body, encoding="utf-8")
        output_path.write_text(body, encoding="utf-8")
        report["report_path"] = str(path)
        report["latest_report_path"] = str(output_path)

    if args.text:
        print(format_text(report))
        if report.get("report_path"):
            print(f"report: {report['report_path']}")
    else:
        print(json.dumps(report, ensure_ascii=True, sort_keys=True, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
