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

import json
from datetime import datetime, timezone
from typing import Any

CONSTITUTIONAL_TARGET = 100


def evaluate_economic_promotion(
    cycles: list[dict[str, Any]],
    *,
    min_series: int = CONSTITUTIONAL_TARGET,
    income_pagination_complete: bool = False,
    semantics_corpus_min: int = 2,
) -> dict[str, Any]:
    """Pure: given per-cycle financial_truth dicts, decide ECONOMIC_PROMOTION.

    Order-level values are AUTHORITATIVE (deterministic order query); the
    independent income cross-check is a separate corroboration. The
    'profit gross of commission' semantic is a CORPUS property — proven once
    enough independent cross-checks align, and not un-proven by a single
    ambiguous (contaminated-window) cycle.
    """
    operational = len(cycles)
    deterministically_attributed = sum(1 for c in cycles if c.get("attribution") == "DETERMINISTIC")
    order_level_actual = sum(1 for c in cycles if c.get("order_level_actual"))
    heuristic = sum(1 for c in cycles if c.get("attribution") == "HEURISTIC_MATCH")
    cross_verified = sum(1 for c in cycles if c.get("independently_cross_verified"))
    cross_ambiguous = sum(1 for c in cycles if c.get("independent_cross_check") == "AMBIGUOUS")
    fully_reconciled_actual = cross_verified  # strict: order-level actual AND cross-verified
    # Corpus-level semantic proof: enough independent alignments demonstrate that
    # REALIZED_PNL is gross of commission (net = profit + commission).
    semantics_verified = cross_verified >= semantics_corpus_min

    # Alpha sample: proof cycles excluded (alpha_sample_eligible=False).
    alpha_cycles = [c for c in cycles if c.get("alpha_sample_eligible")]
    admissible = [c for c in alpha_cycles if c.get("reconciled_actual")]
    admissible_nets = [float(c.get("net_result_usd") or 0.0) for c in admissible]
    net_mean = round(sum(admissible_nets) / len(admissible_nets), 8) if admissible_nets else None
    net_positive = None if net_mean is None else (net_mean > 0.0)
    observed_nets = [float(c.get("net_result_usd") or 0.0) for c in cycles if c.get("order_level_actual")]
    observed_net_mean = round(sum(observed_nets) / len(observed_nets), 8) if observed_nets else None

    blockers: list[str] = []
    if deterministically_attributed < operational:
        blockers.append("venue_order_linkage_incomplete")
    if not semantics_verified:
        blockers.append("realized_pnl_semantics_unverified")
    if not income_pagination_complete:
        blockers.append("income_pagination_incomplete")
    if len(admissible) < min_series:
        blockers.append("economic_sample_insufficient")
    if not admissible:
        blockers.append("net_expectancy_unavailable")
    elif net_mean is not None and net_mean <= 0.0:
        blockers.append("net_expectancy_not_positive")

    financial_truth_status = "COMPLETE" if (order_level_actual == operational and cross_verified == operational and operational) else ("PARTIAL" if order_level_actual > 0 else "MISSING")

    return {
        "schema": "txt.economic-promotion-gate.v3",
        "mode": "shadow_read_only",
        "operational_promotion": {"status": "PASS", "certified_outcomes": operational},
        "order_level_financials": {"status": "ACTUAL" if order_level_actual == operational and operational else "PARTIAL", "actual": order_level_actual, "of": operational},
        "independent_cross_check": {"verified": cross_verified, "ambiguous": cross_ambiguous, "of": operational, "semantics_corpus_verified": semantics_verified},
        "financial_truth": {"status": financial_truth_status},
        "economic_promotion": {
            "status": "BLOCKED" if blockers else "PASS",
            "admissible_outcomes": len(admissible),
            "blockers": blockers,
        },
        "counters": {
            "certified_operational_outcomes": operational,
            "deterministically_attributed_orders": deterministically_attributed,
            "order_level_actual_outcomes": order_level_actual,
            "independently_cross_verified_outcomes": cross_verified,
            "cross_check_ambiguous_outcomes": cross_ambiguous,
            "fully_reconciled_actual_outcomes": fully_reconciled_actual,
            "financially_heuristic_reconciled": heuristic,
            "economically_admissible_outcomes": len(admissible),
        },
        "net_expectancy": {
            "admissible_mean_usd": net_mean,
            "observed_order_level_mean_usd": observed_net_mean,
            "positive": net_positive,
        },
        "financial_truth_not_actual": bool(blockers) or fully_reconciled_actual < operational,
        "constitutional_target": min_series,
    }


def read_income_checkpoint_runtime(container: str = "control-plane", *, freshness_sec: float = 900.0, deployed_commit: str | None = None) -> dict[str, Any]:
    """Read the CANONICAL income-sync checkpoint (capital_flow_sync_checkpoints)
    and derive the runtime-proof flags. All False until the wired pipeline has
    actually RUN post-deploy — so the pagination blocker cannot clear at merge."""
    import subprocess

    code = (
        "import json,os\n"
        "from pathlib import Path\n"
        "import psycopg\n"
        "from psycopg.rows import dict_row\n"
        "def u():\n"
        " v=os.environ.get('DATABASE_URL')\n"
        " if v: return v\n"
        " for c in (Path('/run/secrets/database_url'),Path('/workspace/secrets/database_url')):\n"
        "  if c.exists(): return c.read_text().strip()\n"
        "out={'checkpoint_present':False}\n"
        "try:\n"
        " with psycopg.connect(u(),row_factory=dict_row) as cn, cn.cursor() as cur:\n"
        "  if cur.execute(\"select to_regclass('public.capital_flow_sync_checkpoints') as t\") or cur.fetchone()['t'] is not None:\n"
        "   cur.execute(\"select covered_through,last_success_at,saturation_unresolved_count,status,schema_version from capital_flow_sync_checkpoints where provider='bingx' and status='success' order by last_success_at desc nulls last limit 1\")\n"
        "   r=cur.fetchone()\n"
        "   if r: out.update({'checkpoint_present':True,'covered_through':str(r['covered_through']),'last_success_at':str(r['last_success_at']),'saturation_unresolved_count':r['saturation_unresolved_count'],'schema_version':r['schema_version']})\n"
        "  cur.execute(\"select to_regclass('public.capital_flow_pagination_evidence') as t\")\n"
        "  if cur.fetchone()['t'] is not None:\n"
        "   cur.execute(\"select slice_count,coverage_complete,deployed_commit,verified_at,events_fetched from capital_flow_pagination_evidence where provider='bingx' order by verified_at desc nulls last limit 1\")\n"
        "   e=cur.fetchone()\n"
        "   if e: out['pagination_evidence']={'slice_count':e['slice_count'],'coverage_complete':e['coverage_complete'],'deployed_commit':e['deployed_commit'],'verified_at':str(e['verified_at']),'events_fetched':e['events_fetched']}\n"
        "except Exception as e:\n"
        " out['error']=str(e)[:120]\n"
        "print(json.dumps(out,default=str))\n"
    )
    try:
        res = subprocess.run(["docker", "exec", "-i", container, "python3", "-c", code],
                             capture_output=True, text=True, timeout=30)
        data = json.loads(res.stdout) if res.stdout.strip() else {}
    except Exception as exc:  # noqa: BLE001
        data = {"error": str(exc)[:120]}
    present = bool(data.get("checkpoint_present"))
    last_success = _parse_ts(data.get("last_success_at")) if present else None
    fresh = last_success is not None and (datetime.now(timezone.utc) - last_success).total_seconds() <= freshness_sec
    coverage_complete = present and (data.get("saturation_unresolved_count") in (0, None))
    # pagination_runtime_verified requires PERSISTED canonical evidence (a real
    # bisection run: slice_count>1, coverage_complete, tied to the deployed
    # commit) — NOT an ephemeral observation or merely the checkpoint schema.
    ev = data.get("pagination_evidence") or {}
    pagination_runtime_verified = bool(
        ev
        and int(ev.get("slice_count") or 0) > 1
        and bool(ev.get("coverage_complete"))
        and (deployed_commit is None or str(ev.get("deployed_commit")) == str(deployed_commit))
    )
    return {
        "checkpoint_present": present,
        "checkpoint_runtime_fresh": bool(fresh),
        "coverage_complete": bool(coverage_complete),
        "pagination_runtime_verified": pagination_runtime_verified,
        "pagination_evidence": ev or None,
        "raw": data,
    }


def _parse_ts(value):
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _main() -> int:
    import json
    from pathlib import Path

    base = Path("/opt/txt/var/proof_renewal/financial_truth")
    # Prefer the DETERMINISTIC summary (clientOrderId->orderId venue truth); fall
    # back to the heuristic replay if the bridge has not been resolved yet.
    det = base / "deterministic_summary.json"
    summary_path = det if det.exists() else base / "replay_summary.json"
    data = json.loads(summary_path.read_text(encoding="utf-8"))
    # Read the canonical income checkpoint; the pagination blocker clears ONLY on
    # runtime proof (all three flags), NOT at code merge.
    import subprocess as _sp
    try:
        _head = _sp.run(["git", "-C", "/opt/txt", "rev-parse", "--short", "HEAD"], capture_output=True, text=True, timeout=10).stdout.strip()
    except Exception:
        _head = None
    rt = read_income_checkpoint_runtime(deployed_commit=_head)
    income_pagination_complete = rt["pagination_runtime_verified"] and rt["checkpoint_runtime_fresh"] and rt["coverage_complete"]
    report = evaluate_economic_promotion(data.get("cycles") or [], income_pagination_complete=income_pagination_complete)
    report["source"] = summary_path.name
    report["income_hardening_runtime"] = rt
    out = summary_path.with_name("economic_promotion_gate.json")
    out.write_text(json.dumps(report, indent=2, sort_keys=True), encoding="utf-8")
    ep = report["economic_promotion"]
    ct = report["counters"]
    print(
        f"ECONOMIC_PROMOTION={ep['status']} admissible={ep['admissible_outcomes']} "
        f"| operational={ct['certified_operational_outcomes']} order_level_actual={ct['order_level_actual_outcomes']} "
        f"cross_verified={ct['independently_cross_verified_outcomes']} ambiguous={ct['cross_check_ambiguous_outcomes']} "
        f"| blockers={','.join(ep['blockers']) or 'none'}"
    )
    print(f"report: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
