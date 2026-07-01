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


def fetch_detailed_lock(container: str) -> dict[str, Any]:
    code = r'''
import json
import apps.control_plane.main as cp

print(json.dumps(cp._local_execution_lock_snapshot(execution_phase="opportunity_gate_recovery"), default=str, sort_keys=True))
'''
    result = subprocess.run(
        ["docker", "exec", "-i", container, "python3", "-c", code],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=90,
    )
    payload = json.loads(result.stdout)
    return payload if isinstance(payload, dict) else {}


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


def latch_provenance_from_lock(lock: dict[str, Any]) -> dict[str, Any]:
    activation = lock.get("activation") if isinstance(lock.get("activation"), dict) else {}
    payload = activation.get("payload") if isinstance(activation.get("payload"), dict) else {}
    gate = payload.get("gate") if isinstance(payload.get("gate"), dict) else {}
    metrics = gate.get("metrics") if isinstance(gate.get("metrics"), dict) else {}
    thresholds = gate.get("thresholds") if isinstance(gate.get("thresholds"), dict) else {}
    precedence = payload.get("trigger_precedence") if isinstance(payload.get("trigger_precedence"), dict) else {}
    metric_observed = precedence.get("metric_observed", metrics.get("consistency"))
    threshold = precedence.get("threshold", thresholds.get("kill_consistency_pct"))
    try:
        metric_value = float(metric_observed)
        threshold_value = float(threshold)
    except (TypeError, ValueError):
        metric_value = None
        threshold_value = None
    if metric_value is None or threshold_value is None:
        classification = "UNKNOWN_TRIGGER"
    elif metric_value < threshold_value:
        classification = "LEGITIMATE_THRESHOLD_BREACH"
    else:
        classification = "HEALTHY_OR_STALE_TRIGGER_REGRESSION"
    return {
        "lock_event_id": lock.get("lock_event_id"),
        "trigger_event_id": precedence.get("source_event_id") or activation.get("event_id"),
        "trigger_observed_at": precedence.get("trigger_observed_at") or gate.get("evaluated_at") or gate.get("updated_at"),
        "metric_observed_at_trigger": metric_observed,
        "threshold_at_trigger": threshold,
        "producer_id": precedence.get("producer_id") or gate.get("source") or activation.get("source"),
        "latest_reset_id": precedence.get("reset_event_id"),
        "latest_reset_at": precedence.get("reset_completed_at"),
        "classification": classification,
        "precedence_classification": precedence.get("classification"),
        "precedence_allowed": precedence.get("allowed"),
        "gate_updated_at": gate.get("updated_at"),
        "gate_evaluated_at": gate.get("evaluated_at"),
    }


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
            "lock": before.get("detailed_lock") if isinstance(before.get("detailed_lock"), dict) else before.get("lock"),
            "latch_provenance": latch_provenance_from_lock(
                before.get("detailed_lock")
                if isinstance(before.get("detailed_lock"), dict)
                else before.get("lock")
                if isinstance(before.get("lock"), dict)
                else {}
            ),
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
            "lock": after.get("detailed_lock") if isinstance(after.get("detailed_lock"), dict) else after.get("lock"),
            "latch_provenance": latch_provenance_from_lock(
                after.get("detailed_lock")
                if isinstance(after.get("detailed_lock"), dict)
                else after.get("lock")
                if isinstance(after.get("lock"), dict)
                else {}
            ),
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
    before_active = before_lock.get("active") if "active" in before_lock else before_lock.get("lock_active")
    after_active = after_lock.get("active") if "active" in after_lock else after_lock.get("lock_active")
    return (
        f"OPPORTUNITY_GATE_RECOVERY reset_executed={report['reset_executed']} "
        f"functional_recovery={report['FUNCTIONAL_RECOVERY']} "
        f"before_lock={before_active} after_lock={after_active} "
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
    before["detailed_lock"] = fetch_detailed_lock(args.docker_container)
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
            after["detailed_lock"] = fetch_detailed_lock(args.docker_container)
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
