#!/usr/bin/env python3
"""ONE-SHOT autonomous SELL proof-renewal canary executor.

Operator-authorized 2026-07-08 (scope: "un seul cycle auto, puis stop").
This SUPERSEDES the passive watch's no-execute limit, but ONLY for exactly one
cycle: on the next fresh SELL episode with every gate green and enough freshness
runway, it fires the canonical runner ONCE, then disarms and hands control back.
It requires a NEW explicit authorization to run again.

Flow (per poll):
  read fresh-SELL alert -> require fresh + >= margin seconds left
  -> run READ-ONLY preflight -> require edge>0, Binance TRADING, readiness ready
  -> re-check freshness right before firing
  -> WRITE consumed marker (commit) -> invoke runner `execute` with the double
     gate (--confirm-live PROOF_RENEWAL_EXECUTE --go-phrase ...) -> capture audit
  -> DISARM + STOP.

HARD SAFETY:
  - dry-run by DEFAULT; only --arm-live actually calls the runner.
  - one-shot: a persistent CONSUMED marker blocks any second fire forever
    (written BEFORE the runner call, so a crash can never double-fire).
  - freshness margin so the live entry lands on a still-fresh signal.
  - all runner-side gates remain (D1 MARKET, fill-verify, flatten-verify,
    finalize, revert guarded_auto, NO retry). This wrapper never retries.
  - ignores BUY; never reuses a prior GO; never loops after a fire.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

OUT_DIR = Path("/opt/txt/var/proof_renewal")
ALERT_PATH = OUT_DIR / "shadow_fresh_episode_alert.json"
READINESS_REPORT = OUT_DIR / "readiness_report.json"
READINESS_SCRIPT = Path("/opt/txt/scripts/bingx_proof_cycle_readiness_check.sh")
RUNNER = Path("/opt/txt/scripts/bingx_autonomous_proof_renewal_v1.sh")
ARM_MARKER = OUT_DIR / "sell_canary_autoexec.ARMED"
CONSUMED_MARKER = OUT_DIR / "sell_canary_autoexec.CONSUMED"
GO_PHRASE = "GO renew BingX autonomous proof side=sell"
CONFIRM_TOKEN = "PROOF_RENEWAL_EXECUTE"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_ts(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def _load_alert() -> dict:
    try:
        return json.loads(ALERT_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _arm_info() -> dict:
    try:
        return json.loads(ARM_MARKER.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _arm_expires_at() -> datetime | None:
    return _parse_ts(_arm_info().get("arm_expires_at"))


def _write_outcome(result: str, now: datetime, **extra) -> Path:
    """Durable outcome artifact, written on EVERY terminal state (fired /
    aborted / error / ARM_EXPIRED) so the result survives even if Telegram is
    down. This local artifact is the source of truth for the operator."""
    path = OUT_DIR / f"sell_canary_autoexec_outcome_{now.strftime('%Y%m%dT%H%M%SZ')}.json"
    payload = {
        "schema": "txt.sell-canary-autoexec-outcome.v1",
        "result": result,
        "at": now.isoformat(),
        "arm_expires_at": _arm_info().get("arm_expires_at"),
        **extra,
    }
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    os.replace(tmp, path)
    return path


def evaluate_fresh_sell(alert: dict, now: datetime, margin_sec: float) -> dict | None:
    """Fresh, non-expired SELL with at least margin_sec of runway left. Pure."""
    if alert.get("status") != "FRESH_SHADOW_EPISODE":
        return None
    if str(alert.get("side")).lower() != "sell":
        return None
    expires_at = _parse_ts(alert.get("expires_at"))
    if expires_at is None:
        return None
    seconds_left = (expires_at - now).total_seconds()
    if seconds_left < margin_sec:
        return None
    net = alert.get("net_expected_edge_bps")
    return {
        "episode_key": alert.get("episode_key"),
        "net_bps": net,
        "seconds_left": round(seconds_left, 1),
        "expires_at": alert.get("expires_at"),
        "edge_positive": isinstance(net, (int, float)) and net > 0,
    }


def _run_readonly_preflight() -> dict:
    try:
        subprocess.run(
            ["bash", str(READINESS_SCRIPT)],
            check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120,
            env={"SIDE": "sell", "PATH": "/usr/bin:/bin:/usr/local/bin"},
        )
        return json.loads(READINESS_REPORT.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        return {"error": f"preflight_failed:{str(exc)[:100]}"}


def preflight_green(fresh: dict, readiness: dict) -> tuple[bool, list[str]]:
    reasons: list[str] = []
    if not fresh.get("edge_positive"):
        reasons.append("edge_net_not_positive")
    ref = readiness.get("reference_venue_status") or {}
    if not ref.get("admissible") or ref.get("status") != "TRADING":
        reasons.append("binance_reference_not_trading")
    if not readiness.get("ready_for_dedicated_go"):
        for r in readiness.get("reasons") or ["readiness_not_ready"]:
            reasons.append(f"readiness:{r}")
    if readiness.get("error"):
        reasons.append(f"preflight:{readiness['error']}")
    return (not reasons, reasons)


def _fire_runner(now: datetime) -> dict:
    """Invoke the canonical runner for ONE live cycle. Consumed marker is
    written by the caller BEFORE this. Captures output to an audit artifact."""
    log_path = OUT_DIR / f"sell_canary_autoexec_run_{now.strftime('%Y%m%dT%H%M%SZ')}.log"
    env = dict(os.environ)
    env["SIDE"] = "sell"
    proc = subprocess.run(
        [
            "bash", str(RUNNER), "execute",
            "--side", "sell",
            "--confirm-live", CONFIRM_TOKEN,
            "--go-phrase", GO_PHRASE,
        ],
        check=False, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=600, env=env,
    )
    log_path.write_text(proc.stdout or "", encoding="utf-8")
    return {"exit_code": proc.returncode, "log": str(log_path), "tail": (proc.stdout or "")[-800:]}


def _consume(fresh: dict, now: datetime, mode: str) -> None:
    CONSUMED_MARKER.write_text(
        json.dumps({
            "consumed_at": now.isoformat(),
            "mode": mode,
            "episode_key": fresh.get("episode_key"),
            "expires_at": fresh.get("expires_at"),
        }, indent=2, sort_keys=True),
        encoding="utf-8",
    )


def process_once(*, arm_live: bool, margin_sec: float, now: datetime | None = None) -> tuple[str, bool]:
    """One pass. Returns (line, fired). fired=True means the one-shot is spent."""
    now = now or _now()
    if CONSUMED_MARKER.exists():
        return ("SELL_AUTOEXEC disarmed=already_consumed", True)
    fresh = evaluate_fresh_sell(_load_alert(), now, margin_sec)
    if fresh is None:
        return ("", False)
    readiness = _run_readonly_preflight()
    green, reasons = preflight_green(fresh, readiness)
    if not green:
        return (f"SELL_AUTOEXEC skip episode={fresh['episode_key']} reasons={','.join(reasons)}", False)
    # Re-check freshness immediately before committing (preflight took time).
    refresh = evaluate_fresh_sell(_load_alert(), _now(), margin_sec)
    if refresh is None or refresh.get("episode_key") != fresh.get("episode_key"):
        return (f"SELL_AUTOEXEC skip episode={fresh['episode_key']} reasons=freshness_lapsed_pre_fire", False)
    if not arm_live:
        return (
            f"SELL_AUTOEXEC WOULD_FIRE (dry-run) episode={fresh['episode_key']} "
            f"net_bps={fresh['net_bps']} seconds_left={refresh['seconds_left']} "
            f"cmd=bingx_autonomous_proof_renewal_v1.sh execute --side sell --confirm-live {CONFIRM_TOKEN} --go-phrase \"{GO_PHRASE}\"",
            True,
        )
    # COMMIT POINT: write consumed marker BEFORE firing so a crash cannot
    # re-fire. From here, EVERY path (success / abort / error) is terminal:
    # write a durable outcome artifact and spend the one-shot.
    _consume(fresh, now, mode="live")
    try:
        result = _fire_runner(now)
        tail = result["tail"].splitlines()[-1] if result["tail"].strip() else "no-output"
        _write_outcome(
            "FIRED", now, episode_key=fresh["episode_key"], exit_code=result["exit_code"],
            runner_log=Path(result["log"]).name, tail=result["tail"][-1200:],
        )
        return (
            f"SELL_AUTOEXEC FIRED episode={fresh['episode_key']} exit_code={result['exit_code']} "
            f"log={Path(result['log']).name} :: {tail}",
            True,
        )
    except Exception as exc:  # noqa: BLE001 — terminal; one-shot already spent
        _write_outcome("FIRE_ERROR", now, episode_key=fresh["episode_key"], error=str(exc)[:200])
        return (f"SELL_AUTOEXEC FIRE_ERROR episode={fresh['episode_key']} error={str(exc)[:120]}", True)


def main() -> int:
    parser = argparse.ArgumentParser(description="One-shot autonomous SELL canary executor (dry-run unless --arm-live).")
    parser.add_argument("--arm-live", action="store_true", help="actually fire ONE live cycle when green (else dry-run)")
    parser.add_argument("--margin-sec", type=float, default=90.0)
    parser.add_argument("--poll-sec", type=float, default=20.0)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()

    if args.arm_live and not ARM_MARKER.exists():
        print("SELL_AUTOEXEC refuse=not_armed (ARM marker absent)", flush=True)
        return 3
    if args.arm_live and _arm_expires_at() is None:
        # A hard, short expiry is MANDATORY to arm (doctrine: expiry courte).
        print("SELL_AUTOEXEC refuse=arm_expiry_missing (hard arm_expires_at required)", flush=True)
        return 3
    if CONSUMED_MARKER.exists():
        print("SELL_AUTOEXEC refuse=already_consumed (needs new authorization)", flush=True)
        return 0

    def _disarm() -> None:
        if ARM_MARKER.exists() and args.arm_live:
            ARM_MARKER.unlink()

    def _expired(now: datetime) -> bool:
        exp = _arm_expires_at()
        return exp is not None and now >= exp

    if args.once:
        if args.arm_live and _expired(_now()):
            _write_outcome("ARM_EXPIRED", _now(), no_order=True)
            _disarm()
            print("SELL_AUTOEXEC ARM_EXPIRED disarmed=auto no_order=true", flush=True)
            return 0
        line, _ = process_once(arm_live=args.arm_live, margin_sec=args.margin_sec)
        if line:
            print(line, flush=True)
        return 0

    while True:
        try:
            # Hard ARM expiry: disarm even if no episode ever appears.
            if args.arm_live and _expired(_now()):
                _write_outcome("ARM_EXPIRED", _now(), no_order=True)
                _disarm()
                print("SELL_AUTOEXEC ARM_EXPIRED disarmed=auto no_order=true", flush=True)
                return 0
            line, fired = process_once(arm_live=args.arm_live, margin_sec=args.margin_sec)
            if line:
                print(line, flush=True)
            if fired:
                _disarm()  # one-shot: disarm and stop after a fire (or dry WOULD_FIRE)
                print("SELL_AUTOEXEC stopped=one_shot_complete", flush=True)
                return 0
        except Exception as exc:  # noqa: BLE001
            print(f"SELL_AUTOEXEC_ERROR {str(exc)[:160]}", flush=True)
        time.sleep(max(5.0, args.poll_sec))


if __name__ == "__main__":
    sys.exit(main())
