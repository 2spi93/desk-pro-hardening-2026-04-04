#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DEFAULT_OUT_DIR = Path("/opt/txt/var/proof_renewal")

OUTCOME_CLASSES: tuple[dict[str, Any], ...] = (
    {
        "outcome_class": "proof-cycle live micro",
        "admissible": True,
        "gate_concerned": ["PROOF_PIPELINE_GATE", "CONTINUOUS_AUTONOMOUS_GATE"],
        "rationale": "Canonical live-broker entry/exit fills with finalized outcome, reality gap, lineage, and round-trip replay.",
    },
    {
        "outcome_class": "controlled simulated outcome",
        "admissible": False,
        "gate_concerned": ["PROOF_PIPELINE_GATE"],
        "rationale": "Useful for harness validation, but not counted as real certified outcome for autonomous live threshold.",
    },
    {
        "outcome_class": "broker dry-run",
        "admissible": False,
        "gate_concerned": ["PROOF_PIPELINE_GATE"],
        "rationale": "Validates routing/contracts without broker exposure; no canonical live fill exists.",
    },
    {
        "outcome_class": "historical replay certified",
        "admissible": False,
        "gate_concerned": ["CONTINUOUS_AUTONOMOUS_GATE"],
        "rationale": "Can support replay alignment and regression checks, but cannot replace real-money certified outcomes.",
    },
    {
        "outcome_class": "operator direct-broker",
        "admissible": False,
        "gate_concerned": [],
        "rationale": "External manual broker actions bypass TXT lineage and are not constitutional TXT outcomes.",
    },
    {
        "outcome_class": "legacy MT5 intent",
        "admissible": False,
        "gate_concerned": [],
        "rationale": "Legacy intents without the proof-cycle lineage/replay/fill contract are not admissible for this counter.",
    },
)

GATES: dict[str, dict[str, Any]] = {
    "PROOF_PIPELINE_GATE": {
        "required_clean_cycles": 3,
        "required_sides": ["buy", "sell"],
        "lineage_replay_certified": True,
        "max_notional": "micro",
        "operator_authorization": "required",
        "threshold_100_applies": False,
        "authorizes": "human_micro_live_promotion_review_only",
    },
    "CONTINUOUS_AUTONOMOUS_GATE": {
        "required_certified_outcomes": 100,
        "required_outcome_class": "proof-cycle live micro",
        "replay_alignment": "required",
        "source_tree_cap": "required",
        "incidents": "closed_or_formally_dispositioned",
        "threshold_100_applies": True,
        "authorizes": "future_continuous_autonomous_live_review_only",
    },
}


def build_review(
    *,
    projected_certified_total: int = 3,
    threshold: int = 100,
    proof_layer_validated: bool = True,
    generated_at: datetime | None = None,
) -> dict[str, Any]:
    now = generated_at or datetime.now(timezone.utc)
    admissible_live_classes = [
        row["outcome_class"]
        for row in OUTCOME_CLASSES
        if row.get("admissible") and "CONTINUOUS_AUTONOMOUS_GATE" in row.get("gate_concerned", [])
    ]
    proof_gate_usable_before_threshold = (
        bool(proof_layer_validated)
        and not GATES["PROOF_PIPELINE_GATE"]["threshold_100_applies"]
    )
    circular_lock_detected = not proof_gate_usable_before_threshold and projected_certified_total < threshold
    if circular_lock_detected:
        verdict = "BOOTSTRAP_CIRCULAR_LOCK_RISK"
        disposition = "do_not_promote_until_gate_scope_is_repaired"
    else:
        verdict = "BOOTSTRAP_SCOPE_SEPARATED"
        disposition = "threshold_100_remains_for_continuous_autonomous_gate"

    return {
        "schema_version": "txt-bootstrap-policy-review/v1",
        "generated_at": now.isoformat(),
        "mode": "read_only_policy_review",
        "outcome_admissibility_matrix": list(OUTCOME_CLASSES),
        "gates": GATES,
        "current_counts": {
            "projected_certified_total": projected_certified_total,
            "constitutional_threshold": threshold,
            "remaining_to_continuous_autonomous": max(threshold - projected_certified_total, 0),
            "proof_layer_validated": proof_layer_validated,
        },
        "bootstrap_analysis": {
            "admissible_continuous_outcome_classes": admissible_live_classes,
            "proof_gate_usable_before_threshold": proof_gate_usable_before_threshold,
            "continuous_gate_can_be_populated_by_micro_live": "proof-cycle live micro" in admissible_live_classes,
            "circular_lock_detected": circular_lock_detected,
        },
        "verdict": verdict,
        "recommended_disposition": disposition,
        "non_actions": [
            "no_threshold_change",
            "no_live_trade",
            "no_incident_closure",
            "no_promotion",
            "no_broker_mutation",
        ],
    }


def format_text(report: dict[str, Any]) -> str:
    counts = report["current_counts"]
    analysis = report["bootstrap_analysis"]
    return (
        f"BOOTSTRAP_POLICY_REVIEW verdict={report['verdict']} "
        f"proof_gate_usable_before_threshold={analysis['proof_gate_usable_before_threshold']} "
        f"continuous_populatable={analysis['continuous_gate_can_be_populated_by_micro_live']} "
        f"circular_lock={analysis['circular_lock_detected']} "
        f"certified={counts['projected_certified_total']}/{counts['constitutional_threshold']}"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Cold bootstrap policy review for TXT certified-outcomes gates.")
    parser.add_argument("--projected-certified-total", type=int, default=3)
    parser.add_argument("--threshold", type=int, default=100)
    parser.add_argument("--proof-layer-validated", choices=["true", "false"], default="true")
    parser.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR))
    parser.add_argument("--no-write", action="store_true")
    parser.add_argument("--text", action="store_true")
    args = parser.parse_args()

    report = build_review(
        projected_certified_total=max(0, args.projected_certified_total),
        threshold=max(1, args.threshold),
        proof_layer_validated=args.proof_layer_validated == "true",
    )
    if not args.no_write:
        out_dir = Path(args.out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        path = out_dir / f"bootstrap_policy_review_{stamp}.json"
        path.write_text(json.dumps(report, indent=2, sort_keys=True), encoding="utf-8")
        report["report_path"] = str(path)
    if args.text:
        print(format_text(report))
        if report.get("report_path"):
            print(f"report: {report['report_path']}")
    else:
        print(json.dumps(report, ensure_ascii=True, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
