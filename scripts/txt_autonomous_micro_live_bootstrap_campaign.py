#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DEFAULT_OUT_DIR = Path("/opt/txt/var/proof_renewal")
DEFAULT_SYMBOL = "BTCUSDT"
DEFAULT_MAX_NOTIONAL = 7.5
DEFAULT_DAILY_BUDGET = 30.0
DEFAULT_MAX_CYCLES_PER_DAY = 2
CAMPAIGN_AUTH_TOKEN = "TXT_BOOTSTRAP_MICRO_LIVE_EXECUTE"
RUNNER_CONFIRM_TOKEN = "PROOF_RENEWAL_EXECUTE"
STRATEGY_SIGNAL_SCHEMA_VERSION = "txt.strategy-signal.v1"


STOP_CONDITIONS = [
    "kill_switch_active",
    "promotion_relevant_incident",
    "unknown_or_indeterminate_status",
    "broker_reconciliation_ambiguous",
    "position_not_flat_after_exit",
    "open_order_residual",
    "budget_exhausted",
    "daily_loss_exceeded",
    "consecutive_losses_exceeded",
    "slippage_above_cap",
    "replay_not_aligned",
    "outcome_not_certified",
    "market_data_stale",
    "critical_service_degraded",
]


@dataclass(frozen=True)
class CampaignContract:
    mode: str = "bootstrap_autonomous_micro"
    symbol: str = DEFAULT_SYMBOL
    max_notional_usd: float = DEFAULT_MAX_NOTIONAL
    daily_budget_usd: float = DEFAULT_DAILY_BUDGET
    max_cycles_per_day: int = DEFAULT_MAX_CYCLES_PER_DAY
    max_concurrent_cycles: int = 1
    max_daily_loss_usd: float = 5.0
    max_consecutive_losses: int = 2
    max_slippage_bps: float = 10.0
    campaign_expiry: str | None = None
    operator_authorization: str | None = None
    proof_renewal_canary: bool = False
    continuous_promotion: bool = False

    def as_dict(self) -> dict[str, Any]:
        return {
            "mode": self.mode,
            "symbol": self.symbol,
            "max_notional_usd": self.max_notional_usd,
            "daily_budget_usd": self.daily_budget_usd,
            "max_cycles_per_day": self.max_cycles_per_day,
            "max_concurrent_cycles": self.max_concurrent_cycles,
            "max_daily_loss_usd": self.max_daily_loss_usd,
            "max_consecutive_losses": self.max_consecutive_losses,
            "max_slippage_bps": self.max_slippage_bps,
            "campaign_expiry": self.campaign_expiry,
            "operator_authorization": self.operator_authorization,
            "proof_renewal_canary": self.proof_renewal_canary,
            "continuous_promotion": self.continuous_promotion,
        }


def parse_time(value: Any) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def load_json(path: str | None) -> dict[str, Any]:
    if not path:
        return {}
    try:
        payload = json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"missing": True, "path": path}
    except json.JSONDecodeError as exc:
        return {"invalid": True, "path": path, "error": str(exc)}
    return payload if isinstance(payload, dict) else {"invalid": True, "path": path}


def run_json_command(command: list[str], *, timeout: int = 120) -> dict[str, Any]:
    result = subprocess.run(
        command,
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=timeout,
    )
    text = result.stdout.strip()
    if result.returncode != 0:
        return {
            "command": command,
            "returncode": result.returncode,
            "stdout_tail": text[-800:],
            "stderr_tail": result.stderr.strip()[-800:],
        }
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {"command": command, "returncode": result.returncode, "stdout_tail": text[-800:]}


def collect_cold_reports() -> dict[str, Any]:
    return {
        "promotion_gate": run_json_command(["python3", "scripts/bingx_proof_promotion_gate_review.py", "--no-write"]),
        "certified_outcomes": run_json_command(["python3", "scripts/txt_certified_outcomes_incident_review.py", "--no-write"]),
        "bootstrap_policy": run_json_command(["python3", "scripts/txt_bootstrap_policy_review.py", "--no-write"]),
        "opportunity_gate": run_json_command(["python3", "scripts/txt_opportunity_gate_readiness_review.py", "--no-write"]),
        "incident_adjudication": run_json_command(["python3", "scripts/txt_incident_adjudication.py", "--no-write"]),
    }


def normalize_side(value: Any) -> str:
    side = str(value or "").strip().lower()
    return side if side in {"buy", "sell"} else ""


def to_float(value: Any, fallback: float = 0.0) -> float:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return fallback
    return numeric if numeric == numeric else fallback


def evaluate_strategy_signal(
    signal: dict[str, Any],
    *,
    symbol: str,
    now: datetime | None = None,
    consumed_signal_ids: set[str] | None = None,
) -> dict[str, Any]:
    current = now or datetime.now(timezone.utc)
    if not signal:
        return {
            "admissible": False,
            "side": None,
            "reason": "strategy_signal_missing",
        }
    if signal.get("missing") or signal.get("invalid"):
        return {
            "admissible": False,
            "side": None,
            "reason": "strategy_signal_unreadable",
            "detail": signal,
        }
    side = normalize_side(signal.get("side"))
    signal_id = str(signal.get("signal_id") or "").strip()
    generated_at = parse_time(signal.get("generated_at"))
    expires_at = parse_time(signal.get("expires_at"))
    expected_edge_bps = to_float(signal.get("expected_edge_bps"))
    estimated_fees_bps = to_float(signal.get("estimated_fees_bps"))
    estimated_slippage_bps = to_float(signal.get("estimated_slippage_bps"))
    net_expected_edge_bps = to_float(
        signal.get("net_expected_edge_bps"),
        expected_edge_bps - estimated_fees_bps - estimated_slippage_bps,
    )
    reasons: list[str] = []
    if str(signal.get("schema_version") or "") != STRATEGY_SIGNAL_SCHEMA_VERSION:
        reasons.append("strategy_signal_schema_invalid")
    for required in (
        "signal_id",
        "strategy_id",
        "strategy_version",
        "generated_at",
        "expires_at",
        "confidence",
        "market_regime",
        "entry_reason",
        "invalidation_reason",
        "expected_edge_bps",
        "estimated_fees_bps",
        "estimated_slippage_bps",
        "net_expected_edge_bps",
    ):
        if signal.get(required) in (None, ""):
            reasons.append(f"{required}_missing")
    if str(signal.get("symbol") or "").strip().upper() != symbol:
        reasons.append("strategy_signal_symbol_mismatch")
    if not side:
        reasons.append("strategy_signal_side_invalid")
    if generated_at is None:
        reasons.append("strategy_signal_generated_at_invalid")
    if expires_at is None:
        reasons.append("strategy_signal_expires_at_invalid")
    elif expires_at <= current:
        reasons.append("strategy_signal_expired")
    if bool(signal.get("consumed")):
        reasons.append("strategy_signal_already_consumed")
    if signal_id and consumed_signal_ids and signal_id in consumed_signal_ids:
        reasons.append("strategy_signal_already_consumed")
    if to_float(signal.get("confidence")) <= 0:
        reasons.append("strategy_signal_confidence_invalid")
    if net_expected_edge_bps <= 0:
        reasons.append("strategy_signal_net_edge_not_positive")
    return {
        "admissible": not reasons,
        "side": side or None,
        "reason": ",".join(reasons) if reasons else "strategy_signal_admissible",
        "schema_version": signal.get("schema_version"),
        "signal_id": signal_id or None,
        "strategy_id": signal.get("strategy_id"),
        "strategy_version": signal.get("strategy_version"),
        "generated_at": signal.get("generated_at"),
        "expires_at": signal.get("expires_at"),
        "confidence": signal.get("confidence"),
        "market_regime": signal.get("market_regime"),
        "expected_edge_bps": expected_edge_bps,
        "estimated_fees_bps": estimated_fees_bps,
        "estimated_slippage_bps": estimated_slippage_bps,
        "net_expected_edge_bps": net_expected_edge_bps,
    }


def remaining_cycle_capacity(contract: CampaignContract, promotion_gate: dict[str, Any]) -> int:
    runtime = promotion_gate.get("runtime") if isinstance(promotion_gate.get("runtime"), dict) else {}
    used = float(runtime.get("daily_notional_used_usd") or 0.0)
    limit = float(runtime.get("daily_notional_limit_usd") or contract.daily_budget_usd)
    remaining_budget = max(0.0, min(contract.daily_budget_usd, limit) - used)
    round_trip_notional = max(contract.max_notional_usd * 2.0, 0.000001)
    return max(0, min(contract.max_cycles_per_day, int(remaining_budget // round_trip_notional)))


def build_review(
    *,
    contract: CampaignContract,
    reports: dict[str, Any],
    strategy_signal: dict[str, Any] | None = None,
    now: datetime | None = None,
    consumed_signal_ids: set[str] | None = None,
) -> dict[str, Any]:
    current = now or datetime.now(timezone.utc)
    promotion_gate = reports.get("promotion_gate") if isinstance(reports.get("promotion_gate"), dict) else {}
    certified_review = reports.get("certified_outcomes") if isinstance(reports.get("certified_outcomes"), dict) else {}
    bootstrap_policy = reports.get("bootstrap_policy") if isinstance(reports.get("bootstrap_policy"), dict) else {}
    opportunity_gate = reports.get("opportunity_gate") if isinstance(reports.get("opportunity_gate"), dict) else {}
    incident_adjudication = reports.get("incident_adjudication") if isinstance(reports.get("incident_adjudication"), dict) else {}
    signal_eval = evaluate_strategy_signal(
        strategy_signal or {},
        symbol=contract.symbol,
        now=current,
        consumed_signal_ids=consumed_signal_ids,
    )
    expiry = parse_time(contract.campaign_expiry)

    blockers: list[str] = []
    if contract.mode != "bootstrap_autonomous_micro":
        blockers.append("campaign_mode_invalid")
    if contract.symbol != DEFAULT_SYMBOL:
        blockers.append("symbol_not_allowed")
    if contract.max_concurrent_cycles != 1:
        blockers.append("max_concurrent_cycles_must_equal_1")
    if contract.max_notional_usd <= 0 or contract.max_notional_usd > DEFAULT_MAX_NOTIONAL:
        blockers.append("max_notional_above_micro_cap")
    if contract.daily_budget_usd > DEFAULT_DAILY_BUDGET:
        blockers.append("daily_budget_above_current_policy")
    if contract.continuous_promotion:
        blockers.append("continuous_promotion_forbidden")
    if not expiry:
        blockers.append("campaign_expiry_required")
    elif expiry <= current:
        blockers.append("campaign_expired")
    if contract.operator_authorization != CAMPAIGN_AUTH_TOKEN:
        blockers.append("operator_authorization_missing")
    if not bool(promotion_gate.get("PROOF_LAYER_VALIDATED")):
        blockers.append("proof_layer_not_validated")
    if not bool((bootstrap_policy.get("bootstrap_analysis") or {}).get("proof_gate_usable_before_threshold")):
        blockers.append("bootstrap_scope_not_separated")
    if opportunity_gate and not bool(opportunity_gate.get("OPPORTUNITY_GATE_READY")):
        blockers.append("opportunity_gate_not_ready")
    if not bool(signal_eval.get("admissible")):
        blockers.append(str(signal_eval.get("reason") or "strategy_signal_blocked"))

    promotion_blockers = promotion_gate.get("BLOCKERS") if isinstance(promotion_gate.get("BLOCKERS"), list) else []
    allowed_promotion_blockers = {"risk_budget_not_available_today", "promotion_relevant_incidents_present"}
    if contract.proof_renewal_canary:
        allowed_promotion_blockers.add("latest_proof_not_fresh")
    hard_stop_blockers = [item for item in promotion_blockers if item not in allowed_promotion_blockers]
    if hard_stop_blockers:
        blockers.extend(f"promotion_gate_{item}" for item in hard_stop_blockers)
    threshold_only_incident = (
        certified_review.get("verdict") == "E_CERTIFIED_OUTCOMES_THRESHOLD_NOT_REACHED"
        and bool((bootstrap_policy.get("bootstrap_analysis") or {}).get("proof_gate_usable_before_threshold"))
        and not bool((opportunity_gate.get("incident_adjudication") or {}).get("promotion_relevant_incident_clear") is False)
    )
    unresolved_promotion_blockers = int(incident_adjudication.get("promotion_relevant_blockers") or 0)
    if "promotion_relevant_incidents_present" in promotion_blockers and not threshold_only_incident:
        blockers.append("promotion_relevant_incident")
    elif "promotion_relevant_incidents_present" in promotion_blockers and threshold_only_incident and unresolved_promotion_blockers > 1:
        blockers.append("promotion_relevant_incident")

    capacity = remaining_cycle_capacity(contract, promotion_gate)
    if capacity <= 0:
        blockers.append("budget_exhausted")

    certified = certified_review.get("scanner", {}).get("certified_outcomes", {}) if isinstance(certified_review.get("scanner"), dict) else {}
    projected = certified_review.get("projection", {}) if isinstance(certified_review.get("projection"), dict) else {}
    certified_total = int(certified.get("certified_total") or projected.get("certified_total") or 0)
    required_total = int(certified.get("required_total") or 100)

    operator_only_blockers = {"campaign_expiry_required", "operator_authorization_missing"}
    technical_blockers = sorted(set(blockers) - operator_only_blockers)
    authorized = not blockers
    next_side = signal_eval.get("side") if authorized else None
    next_action = "execute_one_micro_cycle" if authorized else (
        "await_operator_authorization" if not technical_blockers else "stop"
    )
    return {
        "schema_version": "txt-autonomous-micro-live-bootstrap-campaign/v1",
        "generated_at": current.isoformat(),
        "mode": "read_only_campaign_review",
        "campaign_contract": contract.as_dict(),
        "proof_renewal_canary": {
            "enabled": contract.proof_renewal_canary,
            "stale_proof_is_allowed_reason": "renewal_target" if contract.proof_renewal_canary else None,
        },
        "strategy_signal": signal_eval,
        "opportunity_gate_readiness": {
            "ready": opportunity_gate.get("OPPORTUNITY_GATE_READY") if opportunity_gate else None,
            "lock": opportunity_gate.get("lock") if isinstance(opportunity_gate.get("lock"), dict) else None,
            "recommended_disposition": opportunity_gate.get("recommended_disposition") if opportunity_gate else None,
        },
        "incident_readiness": {
            "promotion_relevant_blockers": unresolved_promotion_blockers,
            "certified_outcomes_threshold_only": threshold_only_incident,
        },
        "stop_conditions": STOP_CONDITIONS,
        "current_state": {
            "certified_outcomes": certified_total,
            "required_certified_outcomes": required_total,
            "remaining_certified_outcomes": max(required_total - certified_total, 0),
            "available_cycles_today": capacity,
            "proof_layer_validated": bool(promotion_gate.get("PROOF_LAYER_VALIDATED")),
            "continuous_autonomous_blocked": certified_total < required_total,
        },
        "AUTONOMOUS_MICRO_BOOTSTRAP_AUTHORIZED": authorized,
        "NEXT_ACTION": next_action,
        "NEXT_SIDE": next_side,
        "BLOCKERS": sorted(set(blockers)),
        "non_actions": [
            "no_continuous_promotion",
            "no_threshold_change",
            "no_unbounded_go",
            "no_retry_loop",
        ],
    }


def dedicated_go_phrase(side: str) -> str:
    return f"GO renew BingX autonomous proof side={side}"


def execute_one_cycle(report: dict[str, Any], *, observe_seconds: int) -> int:
    side = normalize_side(report.get("NEXT_SIDE"))
    if not report.get("AUTONOMOUS_MICRO_BOOTSTRAP_AUTHORIZED") or not side:
        print(json.dumps({"status": "blocked", "blockers": report.get("BLOCKERS")}, sort_keys=True))
        return 2
    command = [
        "bash",
        "scripts/bingx_autonomous_proof_renewal_v1.sh",
        "execute",
        "--side",
        side,
        "--notional-usd",
        str((report.get("campaign_contract") or {}).get("max_notional_usd") or DEFAULT_MAX_NOTIONAL),
        "--observe-seconds",
        str(observe_seconds),
        "--confirm-live",
        RUNNER_CONFIRM_TOKEN,
        "--go-phrase",
        dedicated_go_phrase(side),
    ]
    result = subprocess.run(command, check=False)
    if result.returncode != 0:
        return result.returncode
    subprocess.run(["bash", "scripts/run_certified_outcomes_runtime_truth_matrix.sh"], check=False)
    post = collect_cold_reports()
    post_report = build_review(
        contract=CampaignContract(**(report.get("campaign_contract") or {})),
        reports=post,
        strategy_signal={},
    )
    if post_report["BLOCKERS"] and "strategy_signal_missing" not in post_report["BLOCKERS"]:
        print(json.dumps({"status": "post_cycle_blocked", "blockers": post_report["BLOCKERS"]}, sort_keys=True))
    return 0


def send_telegram(text: str) -> bool:
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    chat_id = os.environ.get("TELEGRAM_CHAT_ID", "").strip()
    for env_name, default_path in (
        ("TELEGRAM_BOT_TOKEN_FILE", "/opt/txt/secrets/telegram_bot_token"),
        ("TELEGRAM_CHAT_ID_FILE", "/opt/txt/secrets/telegram_chat_id"),
    ):
        if env_name.endswith("TOKEN_FILE") and not token and Path(os.environ.get(env_name, default_path)).exists():
            token = Path(os.environ.get(env_name, default_path)).read_text(encoding="utf-8").strip()
        if env_name.endswith("CHAT_ID_FILE") and not chat_id and Path(os.environ.get(env_name, default_path)).exists():
            chat_id = Path(os.environ.get(env_name, default_path)).read_text(encoding="utf-8").strip()
    if not token or not chat_id:
        return False
    data = urllib.parse.urlencode({"chat_id": chat_id, "text": text[:3500]}).encode()
    try:
        urllib.request.urlopen(f"https://api.telegram.org/bot{token}/sendMessage", data=data, timeout=15).read()
        return True
    except Exception:
        return False


def format_text(report: dict[str, Any]) -> str:
    blockers = ",".join(report.get("BLOCKERS") or []) or "none"
    state = report["current_state"]
    return (
        f"AUTONOMOUS_MICRO_BOOTSTRAP_CAMPAIGN authorized={report['AUTONOMOUS_MICRO_BOOTSTRAP_AUTHORIZED']} "
        f"next={report['NEXT_ACTION']} side={report.get('NEXT_SIDE') or 'none'} "
        f"certified={state['certified_outcomes']}/{state['required_certified_outcomes']} "
        f"available_cycles_today={state['available_cycles_today']} blockers={blockers}"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Bounded autonomous micro-live bootstrap campaign controller.")
    parser.add_argument("mode", nargs="?", choices=["review", "plan-once", "execute-once"], default="review")
    parser.add_argument("--symbol", default=DEFAULT_SYMBOL)
    parser.add_argument("--max-notional-usd", type=float, default=DEFAULT_MAX_NOTIONAL)
    parser.add_argument("--daily-budget-usd", type=float, default=DEFAULT_DAILY_BUDGET)
    parser.add_argument("--max-cycles-per-day", type=int, default=DEFAULT_MAX_CYCLES_PER_DAY)
    parser.add_argument("--max-daily-loss-usd", type=float, default=5.0)
    parser.add_argument("--max-consecutive-losses", type=int, default=2)
    parser.add_argument("--max-slippage-bps", type=float, default=10.0)
    parser.add_argument("--campaign-expiry", default="")
    parser.add_argument("--authorize-campaign", default="")
    parser.add_argument("--proof-renewal-canary", action="store_true")
    parser.add_argument("--strategy-signal-file", default="")
    parser.add_argument("--reports-file", default="")
    parser.add_argument("--observe-seconds", type=int, default=8)
    parser.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR))
    parser.add_argument("--no-write", action="store_true")
    parser.add_argument("--text", action="store_true")
    parser.add_argument("--telegram-alert", action="store_true")
    args = parser.parse_args()

    contract = CampaignContract(
        symbol=str(args.symbol or "").strip().upper(),
        max_notional_usd=args.max_notional_usd,
        daily_budget_usd=args.daily_budget_usd,
        max_cycles_per_day=args.max_cycles_per_day,
        max_daily_loss_usd=args.max_daily_loss_usd,
        max_consecutive_losses=args.max_consecutive_losses,
        max_slippage_bps=args.max_slippage_bps,
        campaign_expiry=args.campaign_expiry or None,
        operator_authorization=args.authorize_campaign or None,
        proof_renewal_canary=args.proof_renewal_canary,
    )
    reports = load_json(args.reports_file) if args.reports_file else collect_cold_reports()
    strategy_signal = load_json(args.strategy_signal_file)
    report = build_review(contract=contract, reports=reports, strategy_signal=strategy_signal)
    if not args.no_write:
        out_dir = Path(args.out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        path = out_dir / f"autonomous_micro_bootstrap_campaign_{stamp}.json"
        path.write_text(json.dumps(report, indent=2, sort_keys=True), encoding="utf-8")
        report["report_path"] = str(path)
    if args.telegram_alert:
        send_telegram(format_text(report))
    if args.text:
        print(format_text(report))
        if report.get("report_path"):
            print(f"report: {report['report_path']}")
    else:
        print(json.dumps(report, ensure_ascii=True, sort_keys=True))
    if args.mode == "execute-once":
        return execute_one_cycle(report, observe_seconds=max(1, args.observe_seconds))
    if args.mode == "plan-once" and not report["AUTONOMOUS_MICRO_BOOTSTRAP_AUTHORIZED"]:
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
