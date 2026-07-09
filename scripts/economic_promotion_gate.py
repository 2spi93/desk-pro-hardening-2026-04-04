#!/usr/bin/env python3
"""Economic promotion gate — separates operational maturity from profitability.

FINANCIAL-TRUTH-ENGINE-001 step 9 (cold). OPERATIONAL_PROMOTION (rail reliable,
flat, certified, disarmed) is handled by the existing promotion gate. This gate
answers the DIFFERENT question: do we have COMPLETE financial truth AND a
positive net expectancy after real costs? Until then, ECONOMIC_PROMOTION is
BLOCKED, regardless of PROMOTABLE_TO_MICRO_LIVE.

Blocker `financial_truth_not_actual` stays active while any cycle has a
non-actual financial field, OR reconciliation is not deterministic
(reconciliation != ALIGNED), OR net expectancy is not positive.
"""
from __future__ import annotations

from typing import Any

CONSTITUTIONAL_TARGET = 100


def evaluate_economic_promotion(cycles: list[dict[str, Any]], *, min_series: int = CONSTITUTIONAL_TARGET) -> dict[str, Any]:
    """Pure: given the per-cycle financial_truth dicts, decide ECONOMIC_PROMOTION."""
    operational = len(cycles)
    financially_actual = sum(1 for c in cycles if not c.get("financial_truth_not_actual"))
    deterministic = bool(cycles) and all(
        c.get("reconciliation") == "deterministic_order_trade_id" for c in cycles
    )
    nets = [float(c.get("net_result_usd") or 0.0) for c in cycles if not c.get("financial_truth_not_actual")]
    net_sum = round(sum(nets), 8)
    net_mean = round(net_sum / len(nets), 8) if nets else None
    net_positive = net_mean is not None and net_mean > 0.0

    reasons: list[str] = []
    if financially_actual < operational:
        reasons.append("financial_truth_incomplete_for_some_cycles")
    if not deterministic:
        # heuristic reconciliation is not ALIGNED — venue order_id<->tradeId
        # bridge not yet built (see FTE-001 step 5)
        reasons.append("reconciliation_not_deterministic")
    if not net_positive:
        reasons.append("net_expectancy_not_positive")
    if operational < min_series:
        reasons.append(f"series_below_{min_series}")

    blocker_active = bool(reasons)
    return {
        "schema": "txt.economic-promotion-gate.v1",
        "OPERATIONAL_PROMOTION": "PASS",  # decided by the operational gate; restated for contrast
        "ECONOMIC_PROMOTION": "BLOCKED" if blocker_active else "PASS",
        "blockers": (["financial_truth_not_actual"] if blocker_active else []),
        "blocker_reasons": reasons,
        "certified_operational_outcomes": operational,
        "financially_actual_outcomes": financially_actual,
        "deterministic_reconciliation": deterministic,
        "net_expectancy_usd_mean": net_mean,
        "net_result_usd_sum": net_sum,
        "net_expectancy_positive": net_positive,
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
    print(
        f"ECONOMIC_PROMOTION={report['ECONOMIC_PROMOTION']} "
        f"operational={report['certified_operational_outcomes']} "
        f"financially_actual={report['financially_actual_outcomes']} "
        f"deterministic={report['deterministic_reconciliation']} "
        f"net_mean={report['net_expectancy_usd_mean']} "
        f"reasons={','.join(report['blocker_reasons']) or 'none'}"
    )
    print(f"report: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
