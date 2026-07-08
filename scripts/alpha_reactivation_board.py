#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import alpha_engine_report
import money_reality_audit
import recent_real_proof_audit


DEFAULT_WINDOW_HOURS = 720.0
ALPHA_V2_MIN_REAL_TRADES = 100
ALPHA_V2_MIN_ACTIVE_DAYS = 20
ALPHA_V2_MIN_PROFIT_FACTOR = 1.0
ALPHA_V2_FIRST_ENGINE = "Alpha Attribution Engine"
ALPHA_V2_SUMMIT_OBJECTIVE = "Beat the market with sustained real-money alpha"
ALPHA_V2_SURVIVAL_RULE = "No scale-up before controlled drawdown and alpha-decay guard"
ALPHA_V2_ENGINE_ORDER = [
    "Alpha Attribution Engine",
    "Capital Allocation Engine",
    "Opportunity Cost Engine",
    "Strategy Competition Engine",
    "Opportunity Engine",
    "Regime Switching Engine V2",
    "Alpha Decay Engine",
    "Sentiment/Geopolitics/RL after measured alpha",
]
ALPHA_V2_DEFERRED_COMPLEXITY = [
    "Advanced Sentiment",
    "Geopolitics",
    "Macro News",
    "LLM Trading",
    "RL Trading",
    "Advanced Self-Evolution",
]
POST_REAL_100_AUDITS = [
    "Latency Audit",
    "Refusal Audit",
    "Attribution Audit",
]


def _status(done: bool) -> str:
    return "DONE" if done else "NEXT"


def _real_money_count(rows: list[dict[str, Any]]) -> int:
    return sum(1 for row in rows if money_reality_audit.is_real_money(row))


def _row_time(row: dict[str, Any]) -> datetime | None:
    return money_reality_audit.parse_time(row.get("ts_fill_final") or row.get("ts_intent") or row.get("labeled_at"))


def _real_money_active_days(rows: list[dict[str, Any]]) -> int:
    days = {
        row_time.date().isoformat()
        for row in rows
        if money_reality_audit.is_real_money(row) and (row_time := _row_time(row)) is not None
    }
    return len(days)


def _load_money_rows(labels: Path, *, hours: float) -> list[dict[str, Any]]:
    since = datetime.now(timezone.utc) - timedelta(hours=hours) if hours > 0 else None
    return money_reality_audit.load_rows(labels, since=since)


def build_board(
    *,
    proof_payload: dict[str, list[dict[str, Any]]],
    money_rows: list[dict[str, Any]],
    window_hours: float = DEFAULT_WINDOW_HOURS,
    alpha_days: float = 30.0,
    now: datetime | None = None,
) -> dict[str, Any]:
    # now is injectable so the recency window is deterministic under test;
    # the proof audit is the only wall-clock-dependent input here.
    current = now or datetime.now(timezone.utc)
    proof = recent_real_proof_audit.build_audit(proof_payload, hours=window_hours, now=current)
    money10 = money_reality_audit.build_audit(money_rows, min_real_trades=10)
    money50 = money_reality_audit.build_audit(money_rows, min_real_trades=50)
    money100 = money_reality_audit.build_audit(money_rows, min_real_trades=100)
    alpha = alpha_engine_report.build_report(money_rows, days=alpha_days, min_trades=50)
    proof_counts = proof["counts"]
    checks = proof["checks"]
    real_count = _real_money_count(money_rows)
    real_active_days = _real_money_active_days(money_rows)
    real_100_ready = real_count >= ALPHA_V2_MIN_REAL_TRADES
    active_days_ready = real_active_days >= ALPHA_V2_MIN_ACTIVE_DAYS
    profit_factor_ready = alpha["real_money"]["profit_factor"] > ALPHA_V2_MIN_PROFIT_FACTOR
    alpha_v2_ready = real_100_ready and active_days_ready and profit_factor_ready
    alpha_v2_missing = []
    if not real_100_ready:
        alpha_v2_missing.append("real_100_required")
    if not active_days_ready:
        alpha_v2_missing.append("active_20d_required")
    if not profit_factor_ready:
        alpha_v2_missing.append("profit_factor_gt_1_required")
    rows = [
        {
            "id": "ACK",
            "label": "1 ACK recent",
            "status": _status(checks["recent_ack"]),
            "count": proof_counts["ack"],
        },
        {
            "id": "FILL",
            "label": "1 FILL reel recent",
            "status": _status(checks["recent_fill"]),
            "count": proof_counts["real_fill"],
        },
        {
            "id": "OUTCOME",
            "label": "1 OUTCOME recent",
            "status": _status(checks["recent_outcome"]),
            "count": proof_counts["outcome"],
        },
        {
            "id": "GAP",
            "label": "1 GAP recent",
            "status": _status(checks["recent_gap"]),
            "count": proof_counts["gap"],
        },
        {
            "id": "LINKED_LOOP",
            "label": "ACK/FILL/OUTCOME/GAP lies",
            "status": _status(checks["complete_linked_loop"]),
            "count": proof_counts["complete_linked_loop"],
        },
        {
            "id": "REAL_10",
            "label": "10 trades reels",
            "status": _status(real_count >= 10),
            "count": real_count,
        },
        {
            "id": "REAL_50",
            "label": "50 trades reels",
            "status": _status(real_count >= 50),
            "count": real_count,
        },
        {
            "id": "REAL_100",
            "label": "100 trades reels",
            "status": _status(real_count >= 100),
            "count": real_count,
        },
        {
            "id": "ALPHA_30D",
            "label": "Alpha Engine 30D",
            "status": _status(alpha["status"] == "ALPHA_CANDIDATE"),
            "count": alpha["real_money"]["trade_count"],
            "profit_factor": alpha["real_money"]["profit_factor"],
            "expectancy_usd": alpha["real_money"]["expectancy_usd"],
            "drawdown_usd": alpha["real_money"]["max_drawdown_usd"],
        },
    ]
    next_items = [row for row in rows if row["status"] != "DONE"]
    return {
        "title": "TXT ALPHA REACTIVATION",
        "status": "ALPHA_REACTIVATED" if not next_items else "ALPHA_REACTIVATION_PENDING",
        "generated_at": current.isoformat(),
        "window_hours": window_hours,
        "rows": rows,
        "next": next_items[0] if next_items else None,
        "proof": proof,
        "money": {
            "real_trades": real_count,
            "gate_10": money10["status"],
            "gate_50": money50["status"],
            "gate_100": money100["status"],
        },
        "alpha": alpha,
        "alpha_v2": {
            "status": "ALPHA_V2_READY" if alpha_v2_ready else "ALPHA_V2_BLOCKED",
            "activation_gate": "REAL_100_PLUS_20_ACTIVE_DAYS_PLUS_PF_GT_1",
            "min_real_trades": ALPHA_V2_MIN_REAL_TRADES,
            "real_trades": real_count,
            "min_active_days": ALPHA_V2_MIN_ACTIVE_DAYS,
            "active_days": real_active_days,
            "min_profit_factor": ALPHA_V2_MIN_PROFIT_FACTOR,
            "profit_factor": alpha["real_money"]["profit_factor"],
            "first_engine": ALPHA_V2_FIRST_ENGINE,
            "summit_objective": ALPHA_V2_SUMMIT_OBJECTIVE,
            "survival_rule": ALPHA_V2_SURVIVAL_RULE,
            "engine_order": ALPHA_V2_ENGINE_ORDER,
            "deferred_complexity": ALPHA_V2_DEFERRED_COMPLEXITY,
            "post_real_100_audits": POST_REAL_100_AUDITS,
            "missing": alpha_v2_missing,
            "blocked_reason": None if alpha_v2_ready else ",".join(alpha_v2_missing),
        },
    }


def format_text(board: dict[str, Any]) -> str:
    lines = [
        f"{board['title']}: status={board['status']} window_hours={board['window_hours']}",
    ]
    for row in board["rows"]:
        extra = ""
        if row["id"] == "ALPHA_30D":
            extra = (
                f" pf={row['profit_factor']:.4f}"
                f" expectancy=${row['expectancy_usd']:.8f}"
                f" drawdown=${row['drawdown_usd']:.8f}"
            )
        lines.append(f"{row['status']:>4} {row['id']:<11} count={row['count']} {row['label']}{extra}")
    if board.get("next"):
        next_row = board["next"]
        lines.append(f"NEXT_ACTION: {next_row['id']} - {next_row['label']}")
    alpha_v2 = board["alpha_v2"]
    lines.append(
        "ALPHA_V2_GATE: "
        f"status={alpha_v2['status']} "
        f"activation_gate={alpha_v2['activation_gate']} "
        f"real_trades={alpha_v2['real_trades']}/{alpha_v2['min_real_trades']} "
        f"active_days={alpha_v2['active_days']}/{alpha_v2['min_active_days']} "
        f"pf={alpha_v2['profit_factor']:.4f}>{alpha_v2['min_profit_factor']:.0f} "
        f"first_engine={alpha_v2['first_engine']}"
    )
    lines.append(f"ALPHA_V2_OBJECTIVE: {alpha_v2['summit_objective']}")
    lines.append(f"ALPHA_V2_SURVIVAL_RULE: {alpha_v2['survival_rule']}")
    if alpha_v2.get("blocked_reason"):
        lines.append(f"ALPHA_V2_BLOCKED_REASON: {alpha_v2['blocked_reason']}")
    return "\n".join(lines)


def failed_checks(board: dict[str, Any], checks: list[str]) -> list[str]:
    failures: list[str] = []
    by_id = {row["id"].lower(): row for row in board["rows"]}
    for check in checks:
        if check == "board":
            if board["status"] != "ALPHA_REACTIVATED":
                failures.append(check)
            continue
        if check == "alpha-v2":
            if board["alpha_v2"]["status"] != "ALPHA_V2_READY":
                failures.append(check)
            continue
        row = by_id[check.replace("-", "_").lower()]
        if row["status"] != "DONE":
            failures.append(check)
    return failures


def main() -> int:
    parser = argparse.ArgumentParser(description="Show the single TXT Alpha Reactivation board.")
    parser.add_argument("--labels", default=str(money_reality_audit.DEFAULT_LABELS))
    parser.add_argument("--proof-json", help="Read proof rows from JSON instead of Docker/control-plane DB.")
    parser.add_argument("--docker-container", default=recent_real_proof_audit.DEFAULT_DOCKER_CONTAINER)
    parser.add_argument("--limit", type=int, default=500)
    parser.add_argument("--hours", type=float, default=DEFAULT_WINDOW_HOURS)
    parser.add_argument("--alpha-days", type=float, default=30.0)
    parser.add_argument("--json", action="store_true")
    parser.add_argument(
        "--check",
        action="append",
        choices=(
            "ack",
            "fill",
            "outcome",
            "gap",
            "linked-loop",
            "real-10",
            "real-50",
            "real-100",
            "alpha-30d",
            "alpha-v2",
            "board",
        ),
        default=[],
    )
    args = parser.parse_args()

    if args.proof_json:
        proof_payload = recent_real_proof_audit.load_payload(Path(args.proof_json))
    else:
        proof_payload = recent_real_proof_audit.fetch_from_docker(args.docker_container, limit=args.limit)
    money_rows = _load_money_rows(Path(args.labels), hours=args.hours)
    board = build_board(
        proof_payload=proof_payload,
        money_rows=money_rows,
        window_hours=args.hours,
        alpha_days=args.alpha_days,
    )
    if args.json:
        print(json.dumps(board, ensure_ascii=True, sort_keys=True, default=str))
    else:
        print(format_text(board))
    failures = failed_checks(board, args.check)
    if failures:
        print(f"failed_checks={','.join(failures)}")
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
