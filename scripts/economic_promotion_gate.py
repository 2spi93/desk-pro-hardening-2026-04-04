#!/usr/bin/env python3
"""Economic promotion gate (SHADOW, read-only) — FINANCIAL-TRUTH-ENGINE-001 step 9.

Separates three truths, and never lets any of them arm live or touch the
operational gate:
  operational_promotion  rail reliable/flat/certified/disarmed        (PASS)
  financial_truth        venue VALUES actual vs cycle ATTRIBUTION      (PARTIAL)
  economic_promotion     complete+deterministic truth AND net edge     (BLOCKED)

Key honesty rule (operator correction): venue commissions/REALIZED_PNL are ACTUAL
values, but until a venue_trade_id links each event to the cycle, ATTRIBUTION is
heuristic. So `financially_reconciled_actual_outcomes` is 0 until the
deterministic bridge exists — heuristic matches are counted separately.
Proof cycles are OPERATIONAL_PROOF and excluded from the alpha sample.
"""
from __future__ import annotations

from typing import Any

CONSTITUTIONAL_TARGET = 100


def evaluate_economic_promotion(
    cycles: list[dict[str, Any]],
    *,
    min_series: int = CONSTITUTIONAL_TARGET,
    income_pagination_complete: bool = False,
) -> dict[str, Any]:
    """Pure: given per-cycle financial_truth dicts, decide ECONOMIC_PROMOTION."""
    operational = len(cycles)
    observed = sum(1 for c in cycles if c.get("value_truth") == "ACTUAL")
    heuristic = sum(1 for c in cycles if c.get("attribution") == "HEURISTIC_MATCH" and c.get("net_result_certainty") == "RECONCILED_HEURISTIC")
    reconciled_actual = sum(1 for c in cycles if c.get("reconciled_actual"))
    all_deterministic = bool(cycles) and all(c.get("attribution") == "DETERMINISTIC" for c in cycles)
    semantics_verified = bool(cycles) and all(c.get("realized_pnl_semantics") == "VERIFIED" for c in cycles)

    # Alpha sample: proof cycles are excluded (alpha_sample_eligible=False).
    alpha_cycles = [c for c in cycles if c.get("alpha_sample_eligible")]
    admissible = [c for c in alpha_cycles if c.get("reconciled_actual")]
    admissible_nets = [float(c.get("net_result_usd") or 0.0) for c in admissible]
    net_mean = round(sum(admissible_nets) / len(admissible_nets), 8) if admissible_nets else None
    net_positive = net_mean is not None and net_mean > 0.0

    # observed (heuristic) net expectancy — informational only, NOT admissible
    observed_nets = [float(c.get("net_result_usd") or 0.0) for c in cycles if c.get("value_truth") == "ACTUAL"]
    observed_net_mean = round(sum(observed_nets) / len(observed_nets), 8) if observed_nets else None

    blockers: list[str] = []
    if not all_deterministic:
        blockers.append("venue_trade_id_linkage_missing")
        blockers.append("financial_reconciliation_not_aligned")
    if not semantics_verified:
        blockers.append("realized_pnl_semantics_unverified")
    if not income_pagination_complete:
        blockers.append("income_pagination_incomplete")
    if len(admissible) < min_series:
        blockers.append("economic_sample_insufficient")
    if not net_positive:
        blockers.append("net_expectancy_not_positive")

    financial_truth_status = "PARTIAL" if observed > 0 and reconciled_actual < operational else ("COMPLETE" if reconciled_actual == operational and operational else "MISSING")

    return {
        "schema": "txt.economic-promotion-gate.v2",
        "mode": "shadow_read_only",
        "operational_promotion": {"status": "PASS", "certified_outcomes": operational},
        "financial_truth": {
            "status": financial_truth_status,
            "venue_values_actual": observed,
            "deterministically_reconciled": reconciled_actual,
            "heuristically_reconciled": heuristic,
            "realized_pnl_semantics_verified": semantics_verified,
            "income_pagination_complete": income_pagination_complete,
        },
        "economic_promotion": {
            "status": "BLOCKED" if blockers else "PASS",
            "admissible_outcomes": len(admissible),
            "blockers": blockers,
        },
        "counters": {
            "certified_operational_outcomes": operational,
            "financially_observed_outcomes": observed,
            "financially_heuristic_reconciled": heuristic,
            "financially_reconciled_actual_outcomes": reconciled_actual,
            "economically_admissible_outcomes": len(admissible),
        },
        "net_expectancy": {
            "admissible_mean_usd": net_mean,
            "observed_heuristic_mean_usd": observed_net_mean,
            "positive": net_positive,
        },
        # aggregate blocker retained; detailed reasons exported above to avoid opacity
        "financial_truth_not_actual": bool(blockers) or reconciled_actual < operational,
        "constitutional_target": min_series,
    }


def _main() -> int:
    import json
    from pathlib import Path

    summary_path = Path("/opt/txt/var/proof_renewal/financial_truth/replay_summary.json")
    data = json.loads(summary_path.read_text(encoding="utf-8"))
    report = evaluate_economic_promotion(data.get("cycles") or [])
    out = summary_path.with_name("economic_promotion_gate.json")
    out.write_text(json.dumps(report, indent=2, sort_keys=True), encoding="utf-8")
    ep = report["economic_promotion"]
    ct = report["counters"]
    print(
        f"ECONOMIC_PROMOTION={ep['status']} admissible={ep['admissible_outcomes']} "
        f"| operational={ct['certified_operational_outcomes']} observed={ct['financially_observed_outcomes']} "
        f"heuristic={ct['financially_heuristic_reconciled']} reconciled_actual={ct['financially_reconciled_actual_outcomes']} "
        f"| blockers={','.join(ep['blockers']) or 'none'}"
    )
    print(f"report: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
