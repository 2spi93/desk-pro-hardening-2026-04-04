#!/usr/bin/env python3
"""STRICTLY PASSIVE watch for a fresh SELL proof-renewal canary opportunity.

Flow, per fresh SELL episode:
  detect fresh SELL shadow episode
  -> freeze episode_id + snapshot to an artifact
  -> run the READ-ONLY preflight (bingx_proof_cycle_readiness_check.sh)
  -> verify edge / expiry / Binance TRADING / gate / kill / rail / budget / flat
  -> emit ONE alert line carrying the freshness deadline
  -> STOP.

HARD LIMITS (this watch can NEVER):
  - reuse a previous GO or memorize the token as a future authorization
  - consume a signal
  - pass --confirm-live
  - call the execution runner (bingx_autonomous_proof_renewal_v1.sh)
  - create an order, or retry
  - react to a BUY episode
It only reads state and runs the read-only readiness check. Execution still
requires the operator to re-issue, inside the freshness window:
  GO renew BingX autonomous proof side=sell   PROOF_RENEWAL_EXECUTE
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

OUT_DIR = Path("/opt/txt/var/proof_renewal")
ALERT_PATH = OUT_DIR / "shadow_fresh_episode_alert.json"
READINESS_REPORT = OUT_DIR / "readiness_report.json"
READINESS_SCRIPT = Path("/opt/txt/scripts/bingx_proof_cycle_readiness_check.sh")
GO_PHRASE = "GO renew BingX autonomous proof side=sell"
CONFIRM_TOKEN = "PROOF_RENEWAL_EXECUTE"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_ts(value) -> datetime | None:
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


def _run_readonly_preflight() -> dict:
    """Run the read-only readiness producer (NO_MARKET_ACTION) and return its
    report. Never touches the execution runner."""
    try:
        subprocess.run(
            ["bash", str(READINESS_SCRIPT)],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=120,
            env={"SIDE": "sell", "PATH": "/usr/bin:/bin:/usr/local/bin"},
        )
    except Exception as exc:  # noqa: BLE001
        return {"error": f"preflight_failed:{exc}"[:120]}
    try:
        return json.loads(READINESS_REPORT.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return {"error": f"readiness_report_unreadable:{exc}"[:120]}


def evaluate_fresh_sell(alert: dict, now: datetime) -> dict | None:
    """Return the fresh-SELL descriptor if the current alert is a fresh,
    non-expired SELL episode; else None. Pure (no I/O)."""
    if alert.get("status") != "FRESH_SHADOW_EPISODE":
        return None
    if str(alert.get("side")).lower() != "sell":
        return None
    expires_at = _parse_ts(alert.get("expires_at"))
    if expires_at is None or now >= expires_at:
        return None
    return {
        "episode_key": alert.get("episode_key"),
        "side": "sell",
        "net_bps": alert.get("net_expected_edge_bps"),
        "lcb_bps": alert.get("edge_lower_confidence_bound_bps"),
        "expires_at": alert.get("expires_at"),
        "seconds_left": round((expires_at - now).total_seconds(), 1),
        "snapshot_digest": alert.get("snapshot_digest"),
    }


def build_preflight_verdict(fresh: dict, readiness: dict) -> dict:
    """Combine the fresh-SELL edge with the read-only readiness into a single
    HOLD/PREFLIGHT_GREEN verdict. Never authorizes execution."""
    reasons: list[str] = []
    net = fresh.get("net_bps")
    if not isinstance(net, (int, float)) or net <= 0:
        reasons.append("edge_net_not_positive")
    ref = readiness.get("reference_venue_status") or {}
    if not ref.get("admissible") or ref.get("status") != "TRADING":
        reasons.append("binance_reference_not_trading")
    if not readiness.get("ready_for_dedicated_go"):
        for r in readiness.get("reasons") or ["readiness_not_ready"]:
            reasons.append(f"readiness:{r}")
    if readiness.get("error"):
        reasons.append(f"preflight:{readiness['error']}")
    green = not reasons
    return {
        "verdict": "PREFLIGHT_GREEN" if green else "HOLD",
        "reasons": reasons,
        "binance_reference_status": ref.get("status"),
        "readiness_ready": bool(readiness.get("ready_for_dedicated_go")),
    }


def _freeze(fresh: dict, readiness: dict, verdict: dict, now: datetime) -> Path:
    artifact = OUT_DIR / f"sell_canary_preflight_{now.strftime('%Y%m%dT%H%M%SZ')}.json"
    payload = {
        "schema": "txt.sell-canary-preflight.v1",
        "frozen_at": now.isoformat(),
        "episode": fresh,
        "preflight_verdict": verdict,
        "readiness_reference_venue_status": readiness.get("reference_venue_status"),
        "authorization_required": {"phrase": GO_PHRASE, "token": CONFIRM_TOKEN},
        "non_actions": [
            "no_confirm_live",
            "no_execution_runner",
            "no_order",
            "no_signal_consumption",
            "no_retry",
            "passive_preflight_only",
        ],
    }
    tmp = artifact.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    import os

    os.replace(tmp, artifact)
    return artifact


def process_once(handled: set[str], now: datetime | None = None) -> str | None:
    """One passive pass. Returns a NOTIFY line if a fresh SELL was newly
    detected (and its preflight run), else None."""
    now = now or _now()
    fresh = evaluate_fresh_sell(_load_alert(), now)
    if fresh is None:
        return None
    key = str(fresh.get("episode_key"))
    if key in handled:
        return None
    handled.add(key)
    readiness = _run_readonly_preflight()
    verdict = build_preflight_verdict(fresh, readiness)
    artifact = _freeze(fresh, readiness, verdict, now)
    return (
        f"SELL_CANARY_FRESH verdict={verdict['verdict']} "
        f"episode={key} net_bps={fresh.get('net_bps')} seconds_left={fresh.get('seconds_left')} "
        f"deadline={fresh.get('expires_at')} binance={verdict['binance_reference_status']} "
        f"reasons={','.join(verdict['reasons']) or 'none'} artifact={artifact.name} "
        f"| operator must re-issue within window: {GO_PHRASE} {CONFIRM_TOKEN}"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Strictly passive fresh-SELL canary preflight watch.")
    parser.add_argument("--poll-sec", type=float, default=30.0)
    parser.add_argument("--once", action="store_true", help="single pass (for tests / manual checks)")
    args = parser.parse_args()

    handled: set[str] = set()
    if args.once:
        line = process_once(handled)
        if line:
            print(line, flush=True)
        return 0
    while True:
        try:
            line = process_once(handled)
            if line:
                print(line, flush=True)
        except Exception as exc:  # noqa: BLE001 — never let the watch die silently
            print(f"SELL_CANARY_WATCH_ERROR {str(exc)[:160]}", flush=True)
        time.sleep(max(5.0, args.poll_sec))


if __name__ == "__main__":
    sys.exit(main())
