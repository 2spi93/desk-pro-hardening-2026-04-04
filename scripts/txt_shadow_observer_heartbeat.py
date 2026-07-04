#!/usr/bin/env python3
"""Heartbeat check for the permanent shadow observer (watch the watcher).

Runs every 2 minutes from txt-shadow-observer-heartbeat.timer. Read-only on
trading: it inspects the service, the current run's JSONL and market-bar
freshness, writes shadow_observer_heartbeat.json, and — in exactly one case —
restarts the observer service: process alive but no scan for > 3x cadence.

Liveness states:
  ok                      service active, 1 instance, fresh scan, fresh bars
  observer_down           service/process not running (systemd Restart=always
                          owns recovery; we only record + alert)
  stale_scans_restarted   alive but silent > 3x cadence -> controlled restart
  degraded_market_data    scans continue but market bars are stale -> shadow
                          degraded, NO restart, no fake episodes possible
  multiple_instances      >1 observer process (flock should prevent this) ->
                          controlled restart (wrapper kills strays)

FRESH-EPISODE ALERT PASS (strictly passive):
  current shadow JSONL -> new OPPORTUNITY scans (incremental, offset-tracked)
  -> grouped with the SAME episode key/gap logic as
     txt_strategy_shadow_observation_review.py (imported, not re-defined)
  -> freshness check (age <= 300s)
  -> atomic write of shadow_fresh_episode_alert.json + log line
  -> STOP.
The alert only says: a recent shadow episode deserves a read-only preflight.
It is NEVER an admissibility claim, a txt.strategy-signal.v1, or an
authorization. No broker call, no order, no signal consumption, no campaign
authorization, no live execution — here nor anywhere in this script.
"""
from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib import parse, request
from urllib.error import HTTPError

OUT_DIR = Path("/opt/txt/var/proof_renewal")
CURRENT_JSONL = OUT_DIR / "strategy_shadow_observation_current.jsonl"
CURRENT_RUN_ID = OUT_DIR / "strategy_shadow_observation_current.run_id"
HEARTBEAT = OUT_DIR / "shadow_observer_heartbeat.json"
ALERT_PATH = OUT_DIR / "shadow_fresh_episode_alert.json"
ALERT_STATE_PATH = OUT_DIR / "shadow_episode_alert_state.json"
SERVICE = "txt-strategy-shadow-observer.service"
CADENCE_SEC = 60.0
STALE_SCAN_SEC = 3 * CADENCE_SEC
STALE_MARKET_BAR_SEC = 300.0
STARTUP_GRACE_SEC = 180.0
FRESH_EPISODE_MAX_AGE_SEC = 300.0
EPISODE_GAP_MINUTES = 5.0  # must match the review default; the key/continuity
# semantics themselves come from the imported review module.

ALERT_NON_ACTIONS = {
    "broker_call": False,
    "order": False,
    "signal_consumption": False,
    "campaign_authorization": False,
}

# Passive remote delivery of an OPEN alert (one Telegram message per episode).
# Same secrets as telegram_chat_probe.sh; a dead token (401) degrades to a
# logged failure — the LOCAL alert file stays the source of truth.
TELEGRAM_TOKEN_FILE = Path("/opt/txt/secrets/telegram_bot_token")
TELEGRAM_CHAT_ID_FILE = Path("/opt/txt/secrets/telegram_chat_id")
TELEGRAM_API_BASE_URL = os.environ.get("TELEGRAM_API_BASE_URL", "https://api.telegram.org")

_REVIEW_MODULE = None


def _review_module():
    """Load txt_strategy_shadow_observation_review.py so the episode key and
    time parsing are THE review's definitions (never a second one)."""
    global _REVIEW_MODULE
    if _REVIEW_MODULE is None:
        path = Path(__file__).resolve().with_name("txt_strategy_shadow_observation_review.py")
        spec = importlib.util.spec_from_file_location("txt_strategy_shadow_observation_review", path)
        if spec is None or spec.loader is None:
            raise RuntimeError("shadow observation review module unavailable")
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        _REVIEW_MODULE = module
    return _REVIEW_MODULE


def _run(cmd: list[str]) -> str:
    return subprocess.run(cmd, capture_output=True, text=True, check=False).stdout.strip()


def _parse_ts(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def _atomic_write_json(path: Path, payload: dict) -> None:
    """Temp file + os.replace so readers never see a partially written JSON."""
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    os.replace(tmp, path)


def _load_json(path: Path) -> dict:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(payload, dict):
            return payload
    except (OSError, json.JSONDecodeError):
        pass
    return {}


def _read_new_rows(path: Path, offset: int) -> tuple[list[tuple[int, dict]], int, dict]:
    """Read complete JSONL lines from byte offset. A trailing line without a
    newline is NOT consumed (fail-closed: it will be re-read once complete);
    complete-but-invalid JSON lines are skipped and counted, never alerted."""
    info = {"invalid_lines": 0, "offset_reset": False}
    try:
        size = path.stat().st_size
    except OSError:
        return [], offset, info
    if size < offset:
        offset = 0
        info["offset_reset"] = True
    with path.open("rb") as handle:
        handle.seek(offset)
        data = handle.read()
    rows: list[tuple[int, dict]] = []
    pos = 0
    consumed = 0
    while True:
        newline = data.find(b"\n", pos)
        if newline == -1:
            break
        line_start = offset + pos
        text = data[pos:newline].decode("utf-8", errors="replace").strip()
        pos = newline + 1
        consumed = pos
        if not text:
            continue
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            info["invalid_lines"] += 1
            continue
        if isinstance(payload, dict):
            rows.append((line_start, payload))
    return rows, offset + consumed, info


def _build_alert(*, now: datetime, run_id: str, episode: dict, age_seconds: float, jsonl_path: Path) -> dict:
    review = _review_module()
    row = episode.get("last_row") or {}
    key = episode.get("key") or ["UNKNOWN", "UNKNOWN", "UNKNOWN"]
    last_at = review.parse_time(episode.get("last_scan_at"))
    return {
        "schema": "txt.shadow-fresh-episode-alert.v1",
        "status": "FRESH_SHADOW_EPISODE",
        "run_id": run_id,
        "episode_key": "|".join(key) + "@" + str(episode.get("first_scan_at")),
        "strategy_id": key[0],
        "side": key[1],
        "market_regime": key[2],
        "first_scan_at": episode.get("first_scan_at"),
        "opportunity_generated_at": episode.get("last_scan_at"),
        "detected_at": now.isoformat(),
        "age_seconds": round(age_seconds, 3),
        "expires_at": (last_at + timedelta(seconds=FRESH_EPISODE_MAX_AGE_SEC)).isoformat() if last_at else None,
        "scan_count": episode.get("scan_count"),
        "edge_lower_confidence_bound_bps": row.get("edge_lower_confidence_bound_bps"),
        "net_expected_edge_bps": row.get("net_expected_edge_bps"),
        "venue_basis_bps": row.get("venue_basis_bps"),
        "snapshot_digest": row.get("snapshot_digest"),
        "journal_path": str(jsonl_path),
        "journal_offset": episode.get("last_row_offset"),
        "non_actions": dict(ALERT_NON_ACTIONS),
        "note": (
            "a recent shadow episode deserves a read-only preflight; this alert is "
            "NOT admissibility, NOT a strategy signal, NOT an authorization — edge, "
            "basis, budget and gates must be recomputed before any decision"
        ),
    }


def _read_secret(path: Path) -> str | None:
    try:
        value = path.read_text(encoding="utf-8").strip()
        return value or None
    except OSError:
        return None


def _format_fresh_episode_message(alert: dict, now: datetime) -> str:
    """Passive operator notice: no command, no implicit authorization."""
    review = _review_module()
    expires_at = review.parse_time(alert.get("expires_at"))
    remaining = int(max(0.0, (expires_at - now).total_seconds())) if expires_at else 0
    return (
        "TXT SHADOW — épisode shadow frais détecté\n"
        f"strategy={alert.get('strategy_id')} side={alert.get('side')} regime={alert.get('market_regime')}\n"
        f"LCB={alert.get('edge_lower_confidence_bound_bps')} bps | basis={alert.get('venue_basis_bps')} bps | scans={alert.get('scan_count')}\n"
        f"episode={alert.get('episode_key')}\n"
        "Préflight read-only requis.\n"
        "Aucun ordre lancé.\n"
        "Autorisation live absente.\n"
        f"Expiration dans {remaining} secondes."
    )


def _send_telegram_passive_notice(
    message: str,
    *,
    token_file: Path = TELEGRAM_TOKEN_FILE,
    chat_id_file: Path = TELEGRAM_CHAT_ID_FILE,
    api_base_url: str = TELEGRAM_API_BASE_URL,
    opener=request.urlopen,
) -> str:
    """Best-effort delivery; every failure degrades to a status string and a
    log line — never an exception, never a retry storm (one attempt per
    OPEN alert), never anything but sendMessage."""
    token = _read_secret(token_file)
    chat_id = _read_secret(chat_id_file)
    if not token or not chat_id:
        return "skipped_no_secrets"
    payload = parse.urlencode({"chat_id": chat_id, "text": message}).encode("utf-8")
    req = request.Request(f"{api_base_url}/bot{token}/sendMessage", data=payload, method="POST")
    try:
        with opener(req, timeout=10) as response:
            json.load(response)
        return "sent"
    except HTTPError as exc:
        return "failed_auth" if exc.code == 401 else f"failed_http_{exc.code}"
    except Exception:  # noqa: BLE001 — delivery is best-effort by design
        return "failed"


def process_episode_alerts(
    *,
    now: datetime,
    run_id: str,
    jsonl_path: Path,
    state: dict,
    alert_path: Path = ALERT_PATH,
) -> tuple[dict, str, str | None]:
    """One passive incremental pass. Returns (new_state, action, episode_key)
    with action in none|opened|updated|expired. Never touches broker, orders,
    signals or campaign state."""
    review = _review_module()

    if state.get("run_id") != run_id:
        state = {
            "schema_version": "txt-shadow-episode-alert-state/v1",
            "run_id": run_id,
            "last_read_offset": 0,
            "open_episode": None,
            "last_alert": state.get("last_alert"),
        }

    rows, new_offset, read_info = _read_new_rows(jsonl_path, int(state.get("last_read_offset") or 0))
    open_episode = state.get("open_episode")

    for line_offset, row in rows:
        if row.get("decision") != "OPPORTUNITY":
            open_episode = None
            continue
        scan_at_raw = row.get("scan_at") or row.get("observed_at")
        scan_at = review.parse_time(scan_at_raw)
        key = list(review.opportunity_key(row))
        continue_current = False
        if open_episode and open_episode.get("key") == key and scan_at:
            last_at = review.parse_time(open_episode.get("last_scan_at"))
            if last_at and (scan_at - last_at).total_seconds() <= EPISODE_GAP_MINUTES * 60.0:
                continue_current = True
        if not continue_current:
            open_episode = {
                "key": key,
                "first_scan_at": scan_at_raw,
                "scan_count": 0,
                "alerted": False,
                "last_alerted_scan_at": None,
            }
        open_episode["scan_count"] = int(open_episode.get("scan_count") or 0) + 1
        open_episode["last_scan_at"] = scan_at_raw
        open_episode["last_row_offset"] = line_offset
        open_episode["last_row"] = {
            field: row.get(field)
            for field in (
                "edge_lower_confidence_bound_bps",
                "net_expected_edge_bps",
                "venue_basis_bps",
                "snapshot_digest",
                "latest_bar_at",
            )
        }

    action = "none"
    episode_key: str | None = None

    if open_episode:
        last_at = review.parse_time(open_episode.get("last_scan_at"))
        age = (now - last_at).total_seconds() if last_at else None
        if age is not None and 0 <= age <= FRESH_EPISODE_MAX_AGE_SEC:
            alert = _build_alert(
                now=now, run_id=run_id, episode=open_episode, age_seconds=age, jsonl_path=jsonl_path
            )
            episode_key = alert["episode_key"]
            if not open_episode.get("alerted"):
                action = "opened"
            elif open_episode.get("last_alerted_scan_at") != open_episode.get("last_scan_at"):
                action = "updated"
            if action != "none":
                _atomic_write_json(alert_path, alert)
                open_episode["alerted"] = True
                open_episode["last_alerted_scan_at"] = open_episode.get("last_scan_at")
                state["last_alert"] = {
                    "episode_key": episode_key,
                    "status": "FRESH_SHADOW_EPISODE",
                    "alerted_at": now.isoformat(),
                    "last_scan_at": open_episode.get("last_scan_at"),
                }

    # One-time expiry transition: the alert must not keep claiming freshness.
    last_alert = state.get("last_alert")
    if action == "none" and last_alert and last_alert.get("status") == "FRESH_SHADOW_EPISODE":
        alerted_scan_at = review.parse_time(last_alert.get("last_scan_at"))
        if alerted_scan_at and (now - alerted_scan_at).total_seconds() > FRESH_EPISODE_MAX_AGE_SEC:
            stale_alert = _load_json(alert_path)
            if stale_alert:
                stale_alert["status"] = "EXPIRED"
                stale_alert["expired_at"] = now.isoformat()
                _atomic_write_json(alert_path, stale_alert)
            last_alert["status"] = "EXPIRED"
            action = "expired"
            episode_key = last_alert.get("episode_key")

    state["last_read_offset"] = new_offset
    state["open_episode"] = open_episode
    state["read_info"] = read_info
    return state, action, episode_key


def _last_scan_row(path: Path) -> dict | None:
    try:
        with path.open("rb") as handle:
            handle.seek(0, 2)
            size = handle.tell()
            handle.seek(max(0, size - 65536))
            lines = handle.read().decode("utf-8", errors="replace").strip().splitlines()
        for line in reversed(lines):
            try:
                row = json.loads(line)
                if isinstance(row, dict):
                    return row
            except json.JSONDecodeError:
                continue
    except OSError:
        return None
    return None


def _service_active_seconds(now: datetime) -> float | None:
    raw = _run(["systemctl", "show", SERVICE, "--property=ActiveEnterTimestamp", "--value"])
    if not raw or raw in {"", "n/a"}:
        return None
    try:
        entered = datetime.strptime(raw, "%a %Y-%m-%d %H:%M:%S %Z").replace(tzinfo=timezone.utc)
    except ValueError:
        return None
    return (now - entered).total_seconds()


def _observer_pids() -> list[int]:
    """Real observer processes only: cmdline matches AND the process is a
    python interpreter (a shell merely quoting the path must not count —
    a false double would trigger an unjustified restart)."""
    pids: list[int] = []
    for raw in _run(["pgrep", "-f", r"scripts/txt_strategy_shadow_observer\.py"]).splitlines():
        try:
            pid = int(raw)
            comm = Path(f"/proc/{pid}/comm").read_text(encoding="utf-8").strip()
        except (ValueError, OSError):
            continue
        if comm.startswith("python"):
            pids.append(pid)
    return pids


def main() -> int:
    now = datetime.now(timezone.utc)
    service_state = _run(["systemctl", "is-active", SERVICE]) or "unknown"
    pids = _observer_pids()
    run_id = CURRENT_RUN_ID.read_text(encoding="utf-8").strip() if CURRENT_RUN_ID.exists() else None

    row = _last_scan_row(CURRENT_JSONL) if CURRENT_JSONL.exists() else None
    last_scan_at = _parse_ts(row.get("scan_at")) if row else None
    last_bar_at = _parse_ts(str(row.get("latest_bar_at"))) if row else None
    scan_age = (now - last_scan_at).total_seconds() if last_scan_at else None
    bar_age = (now - last_bar_at).total_seconds() if last_bar_at else None
    active_secs = _service_active_seconds(now)
    in_grace = active_secs is not None and active_secs < STARTUP_GRACE_SEC

    action = "none"
    if service_state != "active" or not pids:
        status = "observer_down"
    elif len(pids) > 1:
        status = "multiple_instances"
        action = "restart"
    elif scan_age is None or scan_age > STALE_SCAN_SEC:
        if in_grace:
            status = "ok_startup_grace"
        else:
            status = "stale_scans_restarted"
            action = "restart"
    elif bar_age is not None and bar_age > STALE_MARKET_BAR_SEC:
        status = "degraded_market_data"
    else:
        status = "ok"

    if action == "restart":
        subprocess.run(["systemctl", "restart", SERVICE], check=False)

    # Passive fresh-episode alert pass. Its failure must never break the
    # liveness heartbeat (fail-closed: log only, no alert).
    episode_alert = {"action": "skipped", "episode_key": None, "delivery": "not_attempted"}
    if run_id and CURRENT_JSONL.exists():
        try:
            jsonl_real = CURRENT_JSONL.resolve()
            alert_state = _load_json(ALERT_STATE_PATH)
            alert_state, alert_action, episode_key = process_episode_alerts(
                now=now, run_id=run_id, jsonl_path=jsonl_real, state=alert_state
            )
            delivery = "not_attempted"
            if alert_action == "opened":
                # One passive Telegram notice per episode, on OPEN only.
                alert_payload = _load_json(ALERT_PATH)
                delivery = _send_telegram_passive_notice(_format_fresh_episode_message(alert_payload, now))
                alert_state["last_delivery"] = {
                    "episode_key": episode_key,
                    "status": delivery,
                    "attempted_at": now.isoformat(),
                }
                if delivery != "sent":
                    print(
                        f"fresh-episode Telegram delivery {delivery} — LOCAL alert file remains authoritative",
                        file=sys.stderr,
                    )
            _atomic_write_json(ALERT_STATE_PATH, alert_state)
            episode_alert = {"action": alert_action, "episode_key": episode_key, "delivery": delivery}
        except Exception as exc:  # noqa: BLE001 — fail-closed by design
            print(f"shadow-episode-alert pass failed (fail-closed, no alert): {exc}", file=sys.stderr)
            episode_alert = {"action": "error", "episode_key": None, "delivery": "not_attempted"}

    heartbeat = {
        "schema_version": "txt-shadow-observer-heartbeat/v1",
        "checked_at": now.isoformat(),
        "status": status,
        "action": action,
        "service": SERVICE,
        "service_state": service_state,
        "service_active_seconds": active_secs,
        "service_pid": pids[0] if pids else None,
        "instance_count": len(pids),
        "run_id": run_id,
        "last_scan_at": last_scan_at.isoformat() if last_scan_at else None,
        "last_market_bar_at": last_bar_at.isoformat() if last_bar_at else None,
        "scan_age_seconds": round(scan_age, 3) if scan_age is not None else None,
        "market_bar_age_seconds": round(bar_age, 3) if bar_age is not None else None,
        "episode_alert": episode_alert,
        "thresholds": {
            "cadence_sec": CADENCE_SEC,
            "stale_scan_sec": STALE_SCAN_SEC,
            "stale_market_bar_sec": STALE_MARKET_BAR_SEC,
            "fresh_episode_max_age_sec": FRESH_EPISODE_MAX_AGE_SEC,
            "episode_gap_minutes": EPISODE_GAP_MINUTES,
        },
        "non_actions": [
            "no_broker_call",
            "no_order",
            "no_signal_consumption",
            "no_campaign_authorization",
            "no_live_execution",
        ],
    }
    _atomic_write_json(HEARTBEAT, heartbeat)
    print(
        f"SHADOW_OBSERVER_HEARTBEAT status={status} action={action} run_id={run_id} "
        f"instances={len(pids)} scan_age={heartbeat['scan_age_seconds']} "
        f"bar_age={heartbeat['market_bar_age_seconds']} "
        f"episode_alert={episode_alert['action']}"
        + (f" episode={episode_alert['episode_key']}" if episode_alert.get("episode_key") else "")
    )
    return 0 if status in {"ok", "ok_startup_grace"} else 1


if __name__ == "__main__":
    sys.exit(main())
