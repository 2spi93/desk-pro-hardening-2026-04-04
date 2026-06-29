#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DEFAULT_CONTAINER = "control-plane"
DEFAULT_OUT_DIR = Path("/opt/txt/var/proof_renewal")
CONFIRM_TOKEN = "RESET_OPPORTUNITY_GATE_CONSISTENCY_LATCH"


def _load_review_module():
    path = Path(__file__).resolve().with_name("txt_opportunity_gate_readiness_review.py")
    spec = importlib.util.spec_from_file_location("txt_opportunity_gate_readiness_review", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("opportunity gate review module unavailable")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def reset_latch(container: str, *, operator: str) -> dict[str, Any]:
    code = r'''
import json
import apps.control_plane.main as cp

operator = "OPERATOR_PLACEHOLDER"
state = cp._kill_switch_state()
next_state = cp._reset_kill_switch_state_payload(state, by=operator)
cp._save_kill_switch_state(next_state)
cp.execute(
    "INSERT INTO kill_switch_events (source, reason, payload, active) VALUES (%s, %s, %s::jsonb, FALSE)",
    (
        "opportunity_gate",
        "consistency_kill_threshold_recovery_reset",
        cp.json_dumps({"by": operator, "previous_reason": state.get("reason"), "previous_activation": state.get("activation")}),
    ),
)
cp.append_audit(
    "opportunity_gate_consistency_latch_reset",
    {"by": operator, "previous_reason": state.get("reason"), "previous_activation": state.get("activation")},
)
print(json.dumps({"status": "reset", "previous": state, "state": next_state}, default=str, sort_keys=True))
'''.replace("OPERATOR_PLACEHOLDER", operator.replace("\\", "\\\\").replace('"', '\\"'))
    result = subprocess.run(
        ["docker", "exec", "-i", container, "python3", "-c", code],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=90,
    )
    return json.loads(result.stdout)


def can_reset(review: dict[str, Any]) -> tuple[bool, list[str]]:
    reasons: list[str] = []
    lock = review.get("lock") if isinstance(review.get("lock"), dict) else {}
    occurrence = review.get("occurrence_window") if isinstance(review.get("occurrence_window"), dict) else {}
    if not lock.get("active"):
        reasons.append("lock_not_active")
    if lock.get("owner") != "opportunity_gate":
        reasons.append("lock_owner_not_opportunity_gate")
    if lock.get("reason") != "consistency_kill_threshold":
        reasons.append("lock_reason_not_consistency_kill_threshold")
    if occurrence.get("metric_condition_still_reproducible_now"):
        reasons.append("metric_condition_still_reproducible")
    return len(reasons) == 0, reasons


def build_report(
    *,
    before: dict[str, Any],
    after: dict[str, Any] | None = None,
    reset_result: dict[str, Any] | None = None,
    executed: bool = False,
    blocked_reasons: list[str] | None = None,
) -> dict[str, Any]:
    after = after or {}
    return {
        "schema_version": "txt-opportunity-gate-recovery/v1",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "mode": "targeted_recovery" if executed else "read_only_review",
        "target": {
            "owner": "opportunity_gate",
            "reason": "consistency_kill_threshold",
        },
        "before": {
            "ready": before.get("OPPORTUNITY_GATE_READY"),
            "lock": before.get("lock"),
            "consistency": before.get("consistency_threshold"),
            "occurrence": before.get("occurrence_window"),
            "incident_adjudication": before.get("incident_adjudication"),
        },
        "reset_executed": executed,
        "reset_blockers": blocked_reasons or [],
        "reset_result": {
            "status": (reset_result or {}).get("status"),
            "previous_reason": (((reset_result or {}).get("previous") or {}).get("reason")),
            "new_active": (((reset_result or {}).get("state") or {}).get("active")),
            "new_reason": (((reset_result or {}).get("state") or {}).get("reason")),
        } if reset_result else None,
        "after": {
            "ready": after.get("OPPORTUNITY_GATE_READY"),
            "lock": after.get("lock"),
            "consistency": after.get("consistency_threshold"),
            "occurrence": after.get("occurrence_window"),
            "incident_adjudication": after.get("incident_adjudication"),
        } if after else None,
        "RESET_OR_CLOSE_PERFORMED": executed,
        "FUNCTIONAL_RECOVERY": bool(after.get("OPPORTUNITY_GATE_READY")) if after else False,
        "NO_MARKET_ACTION": True,
    }


def format_text(report: dict[str, Any]) -> str:
    before_lock = ((report.get("before") or {}).get("lock") or {})
    after_lock = ((report.get("after") or {}).get("lock") or {}) if report.get("after") else {}
    return (
        f"OPPORTUNITY_GATE_RECOVERY reset_executed={report['reset_executed']} "
        f"functional_recovery={report['FUNCTIONAL_RECOVERY']} "
        f"before_lock={before_lock.get('active')} after_lock={after_lock.get('active')} "
        f"blockers={','.join(report.get('reset_blockers') or []) or 'none'}"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Targeted opportunity-gate consistency latch recovery.")
    parser.add_argument("--docker-container", default=DEFAULT_CONTAINER)
    parser.add_argument("--operator", default="codex")
    parser.add_argument("--execute-reset", action="store_true")
    parser.add_argument("--confirm", default="")
    parser.add_argument("--observe-seconds", type=int, default=8)
    parser.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR))
    parser.add_argument("--no-write", action="store_true")
    parser.add_argument("--text", action="store_true")
    args = parser.parse_args()

    review_module = _load_review_module()
    before = review_module.build_review(review_module.fetch_json(args.docker_container))
    allowed, blockers = can_reset(before)
    reset_result = None
    after = None
    executed = False
    if args.execute_reset:
        if args.confirm != CONFIRM_TOKEN:
            blockers.append("confirmation_missing")
        if blockers:
            report = build_report(before=before, executed=False, blocked_reasons=blockers)
        else:
            reset_result = reset_latch(args.docker_container, operator=args.operator)
            executed = True
            time.sleep(max(1, args.observe_seconds))
            after = review_module.build_review(review_module.fetch_json(args.docker_container))
            report = build_report(before=before, after=after, reset_result=reset_result, executed=True)
    else:
        report = build_report(before=before, executed=False, blocked_reasons=[] if allowed else blockers)

    if not args.no_write:
        out_dir = Path(args.out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        path = out_dir / f"opportunity_gate_recovery_{stamp}.json"
        path.write_text(json.dumps(report, indent=2, sort_keys=True, default=str), encoding="utf-8")
        report["report_path"] = str(path)
    if args.text:
        print(format_text(report))
        if report.get("report_path"):
            print(f"report: {report['report_path']}")
    else:
        print(json.dumps(report, ensure_ascii=True, sort_keys=True, default=str))
    return 0 if not report.get("reset_blockers") else 2


if __name__ == "__main__":
    raise SystemExit(main())
