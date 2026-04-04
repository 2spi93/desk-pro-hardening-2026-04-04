#!/usr/bin/env sh
set -eu

status_code() {
	url="$1"
	curl -sS -o /dev/null -w "%{http_code}" --max-time 15 "$url"
}

echo "[verify] listener 443"
ss -ltnp | grep ':443' || true

echo "[verify] local control-plane health"
LOCAL_CP_STATUS="$(status_code "http://127.0.0.1:8000/health")"
echo "[verify] http://127.0.0.1:8000/health -> $LOCAL_CP_STATUS"

echo "[verify] public app"
APP_STATUS="$(status_code "https://app.txt.gtixt.com")"
echo "[verify] https://app.txt.gtixt.com -> $APP_STATUS"

echo "[verify] public api prod"
API_PROD_STATUS="$(status_code "https://api.txt.gtixt.com/health")"
echo "[verify] https://api.txt.gtixt.com/health -> $API_PROD_STATUS"

echo "[verify] public api staging"
API_STAGING_STATUS="$(status_code "https://api.staging.txt.gtixt.com/health")"
echo "[verify] https://api.staging.txt.gtixt.com/health -> $API_STAGING_STATUS"

echo "[verify] public control"
CONTROL_STATUS="$(status_code "https://control.txt.gtixt.com/health")"
echo "[verify] https://control.txt.gtixt.com/health -> $CONTROL_STATUS"

if [ "$LOCAL_CP_STATUS" != "200" ] || [ "$API_PROD_STATUS" != "200" ] || [ "$API_STAGING_STATUS" != "200" ] || [ "$CONTROL_STATUS" != "200" ]; then
	echo "[verify] FAIL: one or more health endpoints are not 200"
	exit 1
fi

if [ "$APP_STATUS" -ge 500 ]; then
	echo "[verify] WARN: app endpoint returned $APP_STATUS"
fi

echo "[verify] done"
