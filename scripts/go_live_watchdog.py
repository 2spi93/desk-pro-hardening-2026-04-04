#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import socket
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib import error, parse, request


ROOT_DIR = Path(__file__).resolve().parents[1]
DEFAULT_ENV_PATHS = (
    ROOT_DIR / ".env",
    Path("/workspace/.env"),
    Path("/opt/txt/.env"),
)
DEFAULT_SECRET_PATHS = {
    "admin": (
        ROOT_DIR / "secrets/default_admin_password",
        Path("/workspace/secrets/default_admin_password"),
        Path("/opt/txt/secrets/default_admin_password"),
        Path("/root/txt/secrets/default_admin_password"),
    ),
}


def load_repo_env() -> None:
    for env_path in DEFAULT_ENV_PATHS:
        if not env_path.exists():
            continue
        for raw_line in env_path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            if not key or key in os.environ:
                continue
            os.environ[key] = value.strip().strip('"').strip("'")


def trim_trailing_slash(value: str) -> str:
    return value[:-1] if value.endswith("/") else value


def normalize_control_plane_url(value: str) -> str:
    parsed = parse.urlparse(trim_trailing_slash(value))
    hostname = parsed.hostname or ""
    if not hostname:
        return trim_trailing_slash(value)
    try:
        socket.getaddrinfo(hostname, parsed.port or (443 if parsed.scheme == "https" else 80))
        return trim_trailing_slash(value)
    except OSError:
        if hostname not in {"control-plane", "control_plane"}:
            return trim_trailing_slash(value)
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    fallback = parsed._replace(netloc=f"127.0.0.1:{port}")
    return trim_trailing_slash(parse.urlunparse(fallback))


def resolve_control_plane_url(explicit: str | None) -> str:
    resolved = (
        explicit
        or os.getenv("CONTROL_PLANE_URL")
        or os.getenv("CONTROL_PLANE_FALLBACK_URL")
        or os.getenv("KAIROS_CONTROL_PLANE_URL")
        or "http://127.0.0.1:8000"
    )
    return normalize_control_plane_url(resolved)


def resolve_secret(explicit: str | None, file_path: str | None, username: str) -> str:
    if explicit:
        return explicit
    if file_path:
        path = Path(file_path)
        if path.exists():
            return path.read_text(encoding="utf-8").strip()
        fallback = ROOT_DIR / "secrets" / path.name
        if fallback.exists():
            return fallback.read_text(encoding="utf-8").strip()
    for candidate in DEFAULT_SECRET_PATHS.get(username, ()):
        if candidate.exists():
            return candidate.read_text(encoding="utf-8").strip()
    return ""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def to_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except Exception:
        return default


def bool_from_any(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def json_log(event: str, **fields: Any) -> None:
    record = {"ts": now_iso(), "event": event, **fields}
    print(json.dumps(record, sort_keys=True), flush=True)


def first_positive(*values: Any) -> float:
    for value in values:
        numeric = to_float(value, 0.0)
        if numeric > 0:
            return numeric
    return 0.0


def requested_fill_quantity(payload: dict[str, Any] | None) -> float:
    raw = payload if isinstance(payload, dict) else {}
    order_intent = raw.get("order_intent") if isinstance(raw.get("order_intent"), dict) else {}
    raw_payload = raw.get("raw_payload") if isinstance(raw.get("raw_payload"), dict) else {}
    return first_positive(
        raw.get("size_base"),
        raw.get("quantity"),
        raw.get("qty"),
        raw.get("lots"),
        order_intent.get("size_base"),
        order_intent.get("quantity"),
        order_intent.get("qty"),
        order_intent.get("lots"),
        raw_payload.get("size_base"),
        raw_payload.get("quantity"),
        raw_payload.get("qty"),
        raw_payload.get("lots"),
    )


def realized_fill_quantity(result: dict[str, Any] | None) -> float:
    raw = result if isinstance(result, dict) else {}
    fills = raw.get("fills") if isinstance(raw.get("fills"), list) else []
    filled_qty = sum(to_float(fill.get("size_base"), 0.0) for fill in fills if isinstance(fill, dict))
    if filled_qty > 0:
        return filled_qty
    return first_positive(
        raw.get("filled_qty"),
        raw.get("filled_quantity"),
        raw.get("executed_qty"),
        raw.get("size_base"),
        raw.get("quantity"),
        raw.get("qty"),
        raw.get("lots"),
    )


class ControlPlaneClient:
    def __init__(self, base_url: str, username: str, password: str, timeout_seconds: float) -> None:
        self.base_url = trim_trailing_slash(base_url)
        self.username = username
        self.password = password
        self.timeout_seconds = timeout_seconds
        self.token = ""

    def _url(self, path: str, params: dict[str, Any] | None = None) -> str:
        query = ""
        if params:
            encoded = parse.urlencode({key: value for key, value in params.items() if value is not None})
            if encoded:
                query = f"?{encoded}"
        return f"{self.base_url}{path}{query}"

    def login(self) -> None:
        body = json.dumps({"username": self.username, "password": self.password}).encode("utf-8")
        req = request.Request(
            self._url("/v1/auth/login"),
            data=body,
            headers={"content-type": "application/json"},
            method="POST",
        )
        with request.urlopen(req, timeout=self.timeout_seconds) as response:
            payload = json.loads(response.read().decode("utf-8"))
        token = str(payload.get("access_token") or "").strip()
        if not token:
            raise RuntimeError("control-plane login did not return an access token")
        self.token = token

    def request(self, method: str, path: str, *, payload: dict[str, Any] | None = None, params: dict[str, Any] | None = None, auth: bool = True, retry: bool = True) -> Any:
        if auth and not self.token:
            self.login()
        headers = {"accept": "application/json"}
        if auth and self.token:
            headers["authorization"] = f"Bearer {self.token}"
        data = None
        if payload is not None:
            headers["content-type"] = "application/json"
            data = json.dumps(payload).encode("utf-8")
        req = request.Request(self._url(path, params), data=data, headers=headers, method=method.upper())
        try:
            with request.urlopen(req, timeout=self.timeout_seconds) as response:
                raw = response.read().decode("utf-8")
        except error.HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace")
            if exc.code == 401 and auth and retry:
                self.login()
                return self.request(method, path, payload=payload, params=params, auth=auth, retry=False)
            detail = raw
            try:
                parsed = json.loads(raw)
                if isinstance(parsed, dict) and "detail" in parsed:
                    detail = str(parsed["detail"])
            except Exception:
                pass
            raise RuntimeError(f"{method.upper()} {path} failed with {exc.code}: {detail}") from exc
        try:
            return json.loads(raw) if raw else {}
        except Exception:
            return raw


def fetch_watchdog_snapshot(client: ControlPlaneClient, recent_limit: int) -> dict[str, Any]:
    safe_limit = max(5, min(recent_limit, 50))
    kill_switch = client.request("GET", "/v1/system/kill-switch")
    telemetry = client.request("GET", "/v1/execution/telemetry/recent", params={"limit": safe_limit})
    reality_gap = client.request("GET", "/v1/execution/reality-gap/recent", params={"limit": safe_limit})
    audit = client.request("GET", "/v1/audit")
    return {
        "kill_switch": kill_switch if isinstance(kill_switch, dict) else {},
        "health": client.request("GET", "/health", auth=False),
        "mt5_health": client.request("GET", "/v1/mt5/health"),
        "kairos_shadow": client.request("GET", "/v1/ai/kairos/shadow/status"),
        "telemetry": telemetry if isinstance(telemetry, list) else [],
        "reality_gap": reality_gap if isinstance(reality_gap, dict) else {},
        "audit": audit if isinstance(audit, list) else [],
    }


def compute_block_rate(audit_rows: list[dict[str, Any]]) -> tuple[float, int]:
    decisions = []
    for row in audit_rows:
        if not isinstance(row, dict) or str(row.get("category") or "") != "go_live_hardening_decision":
            continue
        payload = row.get("payload") if isinstance(row.get("payload"), dict) else {}
        decisions.append(str(payload.get("status") or ""))
    if not decisions:
        return 0.0, 0
    blocked = sum(1 for status in decisions if status == "blocked")
    return blocked / len(decisions), len(decisions)


def compute_reality_gap_failure_streak(rows: list[dict[str, Any]]) -> int:
    streak = 0
    for row in rows:
        if not isinstance(row, dict):
            continue
        source = str(row.get("failure_source") or "").strip().lower()
        reasons = row.get("failure_reasons") if isinstance(row.get("failure_reasons"), list) else []
        if source or reasons:
            streak += 1
            continue
        break
    return streak


def compute_partial_fill_ratios(client: ControlPlaneClient, telemetry_rows: list[dict[str, Any]], sample_size: int) -> list[float]:
    ratios: list[float] = []
    for row in telemetry_rows[: max(1, min(sample_size, 10))]:
        if not isinstance(row, dict):
            continue
        decision_id = str(row.get("decision_id") or "").strip()
        if not decision_id:
            continue
        try:
            replay = client.request("GET", f"/v1/execution/replay/{parse.quote(decision_id, safe='')}")
        except Exception:
            continue
        if not isinstance(replay, dict):
            continue
        telemetry = replay.get("telemetry") if isinstance(replay.get("telemetry"), dict) else {}
        telemetry_payload = telemetry.get("payload") if isinstance(telemetry.get("payload"), dict) else {}
        requested_payload = telemetry_payload.get("webhook_execution") if isinstance(telemetry_payload.get("webhook_execution"), dict) else telemetry_payload.get("bridge_result") if isinstance(telemetry_payload.get("bridge_result"), dict) else {}
        realized_payload = {"fills": replay.get("fills") if isinstance(replay.get("fills"), list) else []}
        expected_qty = requested_fill_quantity(requested_payload)
        if expected_qty <= 0:
            expected_qty = first_positive(row.get("lots"), telemetry.get("lots"))
        realized_qty = realized_fill_quantity(realized_payload)
        if realized_qty <= 0:
            realized_qty = first_positive(telemetry.get("lots"), row.get("lots"))
        if expected_qty <= 0:
            continue
        fill_ratio = max(0.0, min(realized_qty / expected_qty, 1.0))
        ratios.append(round(max(0.0, 1.0 - fill_ratio), 6))
    return ratios


def evaluate_snapshot(snapshot: dict[str, Any], partial_fill_ratios: list[float]) -> dict[str, Any]:
    kill_switch = snapshot.get("kill_switch") if isinstance(snapshot.get("kill_switch"), dict) else {}
    hardening = kill_switch.get("go_live_hardening") if isinstance(kill_switch.get("go_live_hardening"), dict) else {}
    watchdog = hardening.get("watchdog") if isinstance(hardening.get("watchdog"), dict) else {}
    telemetry_rows = snapshot.get("telemetry") if isinstance(snapshot.get("telemetry"), list) else []
    reality_gap_rows = (snapshot.get("reality_gap") or {}).get("rows") if isinstance(snapshot.get("reality_gap"), dict) else []
    audit_rows = snapshot.get("audit") if isinstance(snapshot.get("audit"), list) else []

    max_latency_e2e_ms = int(to_float(watchdog.get("max_latency_e2e_ms"), 1500.0))
    max_realized_slippage_bps = to_float(watchdog.get("max_realized_slippage_bps"), 15.0)
    max_block_rate = to_float(watchdog.get("max_block_rate"), 0.35)
    max_partial_fill_ratio = to_float(watchdog.get("max_partial_fill_ratio"), 0.55)
    kill_on_consecutive_failures = max(1, int(to_float(watchdog.get("kill_on_consecutive_failures"), 4.0)))

    anomalies: list[dict[str, Any]] = []

    health = snapshot.get("health") if isinstance(snapshot.get("health"), dict) else {}
    if str(health.get("status") or "") != "ok":
        anomalies.append({"code": "control_plane_unhealthy", "detail": health})

    mt5_health = snapshot.get("mt5_health") if isinstance(snapshot.get("mt5_health"), dict) else {}
    if str(mt5_health.get("status") or "") != "ok":
        anomalies.append({"code": "mt5_bridge_unhealthy", "detail": mt5_health})

    kairos_shadow = snapshot.get("kairos_shadow") if isinstance(snapshot.get("kairos_shadow"), dict) else {}
    if bool_from_any(kairos_shadow.get("active"), False) and str(kairos_shadow.get("last_error") or "").strip():
        anomalies.append({"code": "kairos_shadow_error", "detail": kairos_shadow.get("last_error")})

    latency_breaches = [row for row in telemetry_rows if isinstance(row, dict) and to_float(row.get("latency_e2e_ms"), 0.0) > max_latency_e2e_ms]
    if latency_breaches:
        anomalies.append({
            "code": "latency_e2e_breach",
            "count": len(latency_breaches),
            "max_latency_e2e_ms": max(int(to_float(row.get("latency_e2e_ms"), 0.0)) for row in latency_breaches),
        })

    slippage_breaches = [row for row in telemetry_rows if isinstance(row, dict) and to_float(row.get("realized_slippage_bps"), 0.0) > max_realized_slippage_bps]
    if slippage_breaches:
        anomalies.append({
            "code": "realized_slippage_breach",
            "count": len(slippage_breaches),
            "max_realized_slippage_bps": max(round(to_float(row.get("realized_slippage_bps"), 0.0), 6) for row in slippage_breaches),
        })

    block_rate, block_samples = compute_block_rate(audit_rows)
    if block_samples >= 5 and block_rate > max_block_rate:
        anomalies.append({
            "code": "hardening_block_rate_high",
            "block_rate": round(block_rate, 6),
            "samples": block_samples,
        })

    if partial_fill_ratios:
        average_partial_fill_ratio = sum(partial_fill_ratios) / len(partial_fill_ratios)
        if average_partial_fill_ratio > max_partial_fill_ratio:
            anomalies.append({
                "code": "partial_fill_ratio_high",
                "average_partial_fill_ratio": round(average_partial_fill_ratio, 6),
                "samples": len(partial_fill_ratios),
            })

    failure_streak = compute_reality_gap_failure_streak(reality_gap_rows if isinstance(reality_gap_rows, list) else [])
    if failure_streak >= kill_on_consecutive_failures:
        anomalies.append({
            "code": "reality_gap_failure_streak",
            "streak": failure_streak,
        })

    severe_codes = {"control_plane_unhealthy", "mt5_bridge_unhealthy", "kairos_shadow_error", "reality_gap_failure_streak"}
    severe = any(item.get("code") in severe_codes for item in anomalies)
    return {
        "anomalies": anomalies,
        "severe": severe,
        "kill_on_consecutive_failures": kill_on_consecutive_failures,
        "partial_fill_ratios": partial_fill_ratios,
    }


def activate_watchdog_kill_switch(client: ControlPlaneClient, reason: str, anomalies: list[dict[str, Any]], kill_system_mode: str, dry_run: bool) -> dict[str, Any]:
    payload = {
        "source": "go-live-watchdog",
        "reason": reason,
        "system_mode": kill_system_mode,
        "payload": {
            "anomalies": anomalies,
            "watchdog": "external",
        },
    }
    if dry_run:
        return {"status": "dry_run", "request": payload}
    return client.request("POST", "/v1/system/kill-switch/activate", payload=payload)


def stop_kairos_shadow(client: ControlPlaneClient, dry_run: bool) -> dict[str, Any]:
    if dry_run:
        return {"status": "dry_run"}
    return client.request("POST", "/v1/ai/kairos/shadow/stop")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="External watchdog for go-live hardening.")
    parser.add_argument("--control-plane-url", default="", help="Control-plane base URL. Defaults to CONTROL_PLANE_URL or http://127.0.0.1:8000")
    parser.add_argument("--username", default=os.getenv("GO_LIVE_WATCHDOG_USERNAME", "admin"), help="Control-plane username. Defaults to admin")
    parser.add_argument("--password", default=os.getenv("GO_LIVE_WATCHDOG_PASSWORD", ""), help="Control-plane password. Prefer --password-file or secrets")
    parser.add_argument("--password-file", default=os.getenv("GO_LIVE_WATCHDOG_PASSWORD_FILE") or os.getenv("DEFAULT_ADMIN_PASSWORD_FILE", ""), help="Password file path")
    parser.add_argument("--interval-seconds", type=float, default=float(os.getenv("GO_LIVE_WATCHDOG_INTERVAL_SECONDS", "15")), help="Polling interval in seconds")
    parser.add_argument("--recent-limit", type=int, default=int(os.getenv("GO_LIVE_WATCHDOG_RECENT_LIMIT", "20")), help="Recent sample size for telemetry and reality gap")
    parser.add_argument("--timeout-seconds", type=float, default=float(os.getenv("GO_LIVE_WATCHDOG_TIMEOUT_SECONDS", "10")), help="HTTP timeout in seconds")
    parser.add_argument("--kill-system-mode", default=os.getenv("GO_LIVE_WATCHDOG_KILL_SYSTEM_MODE", "suggest"), help="System mode to force when kill switch activates")
    parser.add_argument("--once", action="store_true", help="Run one cycle and exit")
    parser.add_argument("--dry-run", action="store_true", help="Detect anomalies without activating kill switch or stopping Kairos")
    parser.add_argument("--no-stop-kairos", action="store_true", help="Do not stop Kairos shadow when the kill switch activates")
    return parser.parse_args()


def main() -> int:
    load_repo_env()
    args = parse_args()
    control_plane_url = resolve_control_plane_url(args.control_plane_url)
    password = resolve_secret(args.password, args.password_file, args.username)
    if not password:
        print("go_live_watchdog: missing control-plane password", file=sys.stderr)
        return 2

    client = ControlPlaneClient(control_plane_url, args.username, password, args.timeout_seconds)
    consecutive_anomaly_cycles = 0

    while True:
        try:
            snapshot = fetch_watchdog_snapshot(client, args.recent_limit)
            partial_fill_ratios = compute_partial_fill_ratios(client, snapshot.get("telemetry") if isinstance(snapshot.get("telemetry"), list) else [], max(3, min(args.recent_limit, 5)))
            evaluation = evaluate_snapshot(snapshot, partial_fill_ratios)
            anomalies = evaluation.get("anomalies") if isinstance(evaluation.get("anomalies"), list) else []
            kill_threshold = int(evaluation.get("kill_on_consecutive_failures") or 4)
            kill_switch_state = ((snapshot.get("kill_switch") or {}).get("state") if isinstance(snapshot.get("kill_switch"), dict) else {}) or {}
            kill_switch_active = bool_from_any(kill_switch_state.get("active"), False)

            if anomalies:
                consecutive_anomaly_cycles += 1
                json_log(
                    "watchdog_anomaly_detected",
                    anomalies=anomalies,
                    consecutive_anomaly_cycles=consecutive_anomaly_cycles,
                    kill_switch_active=kill_switch_active,
                )
            else:
                consecutive_anomaly_cycles = 0
                json_log("watchdog_cycle_ok", kill_switch_active=kill_switch_active)

            should_trigger_kill = bool(anomalies) and (bool(evaluation.get("severe")) or consecutive_anomaly_cycles >= kill_threshold)
            if should_trigger_kill and not kill_switch_active:
                reason = "watchdog_anomaly_detected"
                activation = activate_watchdog_kill_switch(client, reason, anomalies, args.kill_system_mode, args.dry_run)
                json_log("watchdog_kill_switch_activation", activation=activation, dry_run=args.dry_run)
                if not args.no_stop_kairos:
                    try:
                        stop_result = stop_kairos_shadow(client, args.dry_run)
                        json_log("watchdog_kairos_stop", result=stop_result, dry_run=args.dry_run)
                    except Exception as exc:
                        json_log("watchdog_kairos_stop_failed", error=str(exc))

            if args.once:
                return 1 if anomalies else 0
        except KeyboardInterrupt:
            return 130
        except Exception as exc:
            consecutive_anomaly_cycles += 1
            json_log("watchdog_cycle_failed", error=str(exc), consecutive_anomaly_cycles=consecutive_anomaly_cycles)
            if args.once:
                return 2

        time.sleep(max(1.0, args.interval_seconds))


if __name__ == "__main__":
    raise SystemExit(main())