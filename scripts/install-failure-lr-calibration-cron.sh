#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_PATH="$ROOT_DIR/scripts/rebuild_failure_lr_calibration.sh"
CRON_SCHEDULE="${CRON_SCHEDULE:-*/15 * * * *}"
CRON_LOG="${CRON_LOG:-$ROOT_DIR/logs/predictor/failure-lr-calibration-cron.log}"
CRON_TAG="# mission-control-failure-lr-calibration"

if [[ ! -x "$SCRIPT_PATH" ]]; then
  echo "[install] making $SCRIPT_PATH executable"
  chmod +x "$SCRIPT_PATH"
fi

mkdir -p "$(dirname "$CRON_LOG")"

line="$CRON_SCHEDULE cd $ROOT_DIR && $SCRIPT_PATH >> $CRON_LOG 2>&1 $CRON_TAG"

tmpfile="$(mktemp)"
crontab -l 2>/dev/null | grep -v "$CRON_TAG" > "$tmpfile" || true
echo "$line" >> "$tmpfile"
crontab "$tmpfile"
rm -f "$tmpfile"

echo "[ok] failure LR calibration cron installed"