#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_ROOT="${ROOT_DIR}/logs/healthwatch/chart-offline"
mkdir -p "$LOG_ROOT"

UI_BASE_URL="${UI_BASE_URL:-https://app.txt.gtixt.com}"
HOST_HEADER="${HOST_HEADER:-app.txt.gtixt.com}"
CAPTURE_INSTRUMENT="${CAPTURE_INSTRUMENT:-BTCUSD}"
CAPTURE_VENUE="${CAPTURE_VENUE:-binance-public}"
CAPTURE_TIMEFRAME="${CAPTURE_TIMEFRAME:-1m}"
CAPTURE_TRADE_LIMIT="${CAPTURE_TRADE_LIMIT:-5}"
CAPTURE_LOOKBACK_MINUTES="${CAPTURE_LOOKBACK_MINUTES:-60}"
CAPTURE_LOG_TAIL="${CAPTURE_LOG_TAIL:-200}"
CAPTURE_SECRET_FILE="${CAPTURE_SECRET_FILE:-${ROOT_DIR}/secrets/default_operator_password}"
CAPTURE_PERSIST_ON_CRITICAL="${CAPTURE_PERSIST_ON_CRITICAL:-1}"

TMP_JSON="$(mktemp)"
trap 'rm -f "$TMP_JSON"' EXIT

python3 - "$UI_BASE_URL" "$CAPTURE_INSTRUMENT" "$CAPTURE_VENUE" "$CAPTURE_TIMEFRAME" "$CAPTURE_LOOKBACK_MINUTES" "$CAPTURE_TRADE_LIMIT" "$CAPTURE_SECRET_FILE" > "$TMP_JSON" <<'PY'
import json
import sys
from pathlib import Path

import requests
import urllib3

urllib3.disable_warnings()

base_url, instrument, venue, timeframe, lookback_minutes, trade_limit, secret_file = sys.argv[1:8]
session = requests.Session()
password_path = Path(secret_file)
login_error = None

if password_path.exists():
    try:
        password = password_path.read_text().strip()
        if password:
            response = session.post(
                f"{base_url}/api/auth/login",
                data={"username": "operator", "password": password},
                timeout=20,
                verify=False,
            )
            response.raise_for_status()
    except Exception as exc:  # noqa: BLE001
        login_error = str(exc)

def fetch_json(path: str):
    url = f"{base_url}{path}"
    try:
        response = session.get(url, timeout=20, verify=False)
        text = response.text
        try:
            payload = response.json()
        except Exception:  # noqa: BLE001
            payload = None
        return {
            "url": url,
            "status": response.status_code,
            "ok": response.ok,
            "payload": payload,
            "body_excerpt": text[:1200],
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "url": url,
            "status": 0,
            "ok": False,
            "payload": None,
            "body_excerpt": "",
            "error": str(exc),
        }

auth_status = fetch_json("/api/auth/status")
connectors = fetch_json("/api/connectors/status")
ohlcv = fetch_json(
    f"/api/market/ohlcv?instrument={instrument}&venue={venue}&timeframe={timeframe}&limit=25"
)
snapshot = fetch_json(
    f"/api/market/bus/snapshot?instrument={instrument}&venue={venue}&timeframe={timeframe}&lookback_minutes={lookback_minutes}&trade_limit={trade_limit}"
)

offline_reasons = []
advisory_reasons = []
md_alerts = []

ohlcv_payload = ohlcv.get("payload") if isinstance(ohlcv.get("payload"), list) else []
if not ohlcv.get("ok"):
    offline_reasons.append("ohlcv_api_non_200")
elif len(ohlcv_payload) == 0:
    offline_reasons.append("ohlcv_api_empty")

snapshot_payload = snapshot.get("payload") if isinstance(snapshot.get("payload"), dict) else {}
meta = snapshot_payload.get("meta") if isinstance(snapshot_payload.get("meta"), dict) else {}
health = meta.get("health") if isinstance(meta.get("health"), dict) else {}
components = health.get("components") if isinstance(health.get("components"), dict) else {}
sequencing = meta.get("sequencing") if isinstance(meta.get("sequencing"), dict) else {}
ohlcv_component = components.get("ohlcv") if isinstance(components.get("ohlcv"), dict) else {}
depth_component = components.get("depth") if isinstance(components.get("depth"), dict) else {}
trades_component = components.get("trades") if isinstance(components.get("trades"), dict) else {}
ohlcv_seq = sequencing.get("ohlcv") if isinstance(sequencing.get("ohlcv"), dict) else {}
snapshot_health_status = str(health.get("status") or "offline")
snapshot_health_reason = str(health.get("reason") or "")

def classify_freshness(value):
    try:
        freshness_ms = float(value)
    except Exception:  # noqa: BLE001
        return "hard-fail"
    if freshness_ms < 0:
        return "hard-fail"
    if freshness_ms <= 15000:
        return "fresh"
    if freshness_ms <= 60000:
        return "stale"
    if freshness_ms <= 180000:
        return "degraded"
    return "hard-fail"

for label, component in (("bars", ohlcv_component), ("depth", depth_component), ("trades", trades_component)):
    state = classify_freshness(component.get("freshness_ms"))
    if state != "fresh":
        md_alerts.append({"label": label, "state": state, "freshness_ms": component.get("freshness_ms")})

if not snapshot.get("ok"):
    offline_reasons.append("snapshot_non_200")

snapshot_ohlcv_rows = snapshot_payload.get("ohlcv_rows") if isinstance(snapshot_payload.get("ohlcv_rows"), list) else []
snapshot_trade_rows = snapshot_payload.get("trades") if isinstance(snapshot_payload.get("trades"), list) else []
snapshot_has_depth = isinstance(snapshot_payload.get("depth_snapshot"), dict)
ohlcv_state = classify_freshness(ohlcv_component.get("freshness_ms"))
depth_state = classify_freshness(depth_component.get("freshness_ms"))
trades_state = classify_freshness(trades_component.get("freshness_ms"))
latest_seq = int(ohlcv_seq.get("latest_seq") or 0)
public_badge_ohlcv_offline = False

if ohlcv_state == "degraded":
    advisory_reasons.append("ohlcv_component_degraded")
elif ohlcv_state == "hard-fail":
    offline_reasons.append("ohlcv_component_hard_fail")
if depth_state == "hard-fail":
    offline_reasons.append("depth_component_hard_fail")
if trades_state == "hard-fail":
    offline_reasons.append("trades_component_hard_fail")
if latest_seq <= 0:
    advisory_reasons.append("ohlcv_seq_missing")

if snapshot_health_reason in {"control_plane_snapshot_unavailable", "control_plane_snapshot_missing"} and not snapshot_ohlcv_rows:
    offline_reasons.append(snapshot_health_reason)

if snapshot_health_status != "ok" and not snapshot_ohlcv_rows and not snapshot_trade_rows and not snapshot_has_depth:
    offline_reasons.append("snapshot_structural_data_loss")

if latest_seq <= 0 and not snapshot_ohlcv_rows and ohlcv_state == "hard-fail":
    offline_reasons.append("ohlcv_seq_missing_hard_fail")

public_badge_ohlcv_offline = bool(
    (ohlcv_state == "hard-fail" and (not snapshot_ohlcv_rows or latest_seq <= 0))
    or snapshot_health_reason in {"control_plane_snapshot_unavailable", "control_plane_snapshot_missing"}
    or not ohlcv.get("ok")
    or len(ohlcv_payload) == 0
)

public_candles_md_alert_count = sum(1 for item in md_alerts if item["state"] == "hard-fail")

if not snapshot_ohlcv_rows:
    advisory_reasons.append("snapshot_zero_bars")

if (
    "snapshot_zero_bars" in advisory_reasons
    and not public_badge_ohlcv_offline
    and snapshot_health_status == "ok"
    and latest_seq > 0
    and public_candles_md_alert_count == 0
):
    advisory_reasons = [reason for reason in advisory_reasons if reason != "snapshot_zero_bars"]

print(json.dumps({
    "captured_at": __import__("datetime").datetime.utcnow().isoformat() + "Z",
    "base_url": base_url,
    "instrument": instrument,
    "venue": venue,
    "timeframe": timeframe,
    "login_error": login_error,
    "offline": len(offline_reasons) > 0,
    "offline_reasons": offline_reasons,
    "advisory_reasons": advisory_reasons,
    "md_alerts": md_alerts,
    "public_signal_alignment": {
        "ohlcv_offline_badge": public_badge_ohlcv_offline,
        "bars_state": ohlcv_state,
        "depth_state": depth_state,
        "trades_state": trades_state,
        "latest_seq": latest_seq,
        "snapshot_health_status": snapshot_health_status,
        "snapshot_health_reason": snapshot_health_reason,
        "public_candles_md_alert_count": public_candles_md_alert_count,
    },
    "auth_status": auth_status,
    "connectors": connectors,
    "ohlcv": ohlcv,
    "snapshot": snapshot,
  }, indent=2))
PY

if ! python3 - "$TMP_JSON" <<'PY'
import json, sys
from pathlib import Path
data = json.loads(Path(sys.argv[1]).read_text())
raise SystemExit(0 if data.get("offline") else 1)
PY
then
    cp "$TMP_JSON" "$LOG_ROOT/latest-probe.json"
  exit 0
fi

cp "$TMP_JSON" "$LOG_ROOT/latest-probe.json"

if [[ "$CAPTURE_PERSIST_ON_CRITICAL" != "1" ]]; then
    exit 10
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
CAPTURE_DIR="${LOG_ROOT}/${STAMP}"
mkdir -p "$CAPTURE_DIR"
cp "$TMP_JSON" "$CAPTURE_DIR/summary.json"

{
  echo "captured_at=${STAMP}"
  echo "ui_base_url=${UI_BASE_URL}"
  echo "host_header=${HOST_HEADER}"
  echo "instrument=${CAPTURE_INSTRUMENT}"
  echo "venue=${CAPTURE_VENUE}"
  echo "timeframe=${CAPTURE_TIMEFRAME}"
} > "$CAPTURE_DIR/context.env"

if command -v docker >/dev/null 2>&1; then
  (
    cd "$ROOT_DIR"
    docker compose ps > "$CAPTURE_DIR/docker-compose-ps.txt" 2>&1 || true
    docker compose logs --tail "$CAPTURE_LOG_TAIL" mission-control-ui > "$CAPTURE_DIR/mission-control-ui.log" 2>&1 || true
    docker compose logs --tail "$CAPTURE_LOG_TAIL" market-data > "$CAPTURE_DIR/market-data.log" 2>&1 || true
    docker compose logs --tail "$CAPTURE_LOG_TAIL" control-plane > "$CAPTURE_DIR/control-plane.log" 2>&1 || true
    docker compose logs --tail "$CAPTURE_LOG_TAIL" execution-router > "$CAPTURE_DIR/execution-router.log" 2>&1 || true
    docker compose logs --tail "$CAPTURE_LOG_TAIL" ai-orchestrator > "$CAPTURE_DIR/ai-orchestrator.log" 2>&1 || true
    docker compose logs --tail "$CAPTURE_LOG_TAIL" broker-adapter > "$CAPTURE_DIR/broker-adapter.log" 2>&1 || true
  )
fi

ln -sfn "$CAPTURE_DIR" "$LOG_ROOT/latest"
echo "Captured chart offline context in $CAPTURE_DIR"
exit 10