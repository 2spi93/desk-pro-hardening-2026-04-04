#!/usr/bin/env bash
# TXT Strategy Brain shadow observer — systemd run wrapper.
#
# SHADOW-ONLY INVARIANTS (enforced by the observer itself, restated here):
#   no_broker_call / no_order / no_signal_consumption / no_campaign_authorization
#   no_live_execution. This wrapper only rotates files and runs the episode
#   review; a notification of an admissible episode is NEVER an authorization.
#
# One bounded 1440-scan (24h) run per service start; systemd Restart=always
# starts the next block after a clean exit. Single-instance is guaranteed by
# the observer's own flock on /run/lock/txt-strategy-shadow-observer.lock.
set -euo pipefail
cd /opt/txt

OUT_DIR=var/proof_renewal
RUN_ID=$(date -u +%Y%m%dT%H%M%SZ)
ITERATIONS=${SHADOW_OBSERVER_ITERATIONS:-1440}
INTERVAL_SEC=${SHADOW_OBSERVER_INTERVAL_SEC:-60}
JSONL="$OUT_DIR/strategy_shadow_observation_${RUN_ID}.jsonl"
OUT="$OUT_DIR/strategy_shadow_observation_${RUN_ID}.json"
REVIEW="$OUT_DIR/strategy_shadow_observation_${RUN_ID}.episode_review.json"

# systemd is the only legitimate launcher: stop any stale/manual observer so
# the flock is free for this instance (old blocked process -> stopped).
if pkill -f 'scripts/txt_strategy_shadow_observer\.py'; then
    echo "shadow-observer-service: killed stale observer instance(s)"
    sleep 3
fi

# Stable pointers for the heartbeat check and the reviewers.
ln -sfn "strategy_shadow_observation_${RUN_ID}.jsonl" "$OUT_DIR/strategy_shadow_observation_current.jsonl"
printf '%s\n' "$RUN_ID" > "$OUT_DIR/strategy_shadow_observation_current.run_id"

echo "shadow-observer-service: run_id=${RUN_ID} iterations=${ITERATIONS} interval_sec=${INTERVAL_SEC}"
python3 scripts/txt_strategy_shadow_observer.py \
    --iterations "$ITERATIONS" \
    --interval-sec "$INTERVAL_SEC" \
    --refresh-clean-before-scan \
    --venue-basis-check \
    --jsonl-output "$JSONL" \
    --output "$OUT" \
    --text

# Clean end of the 24h block: group episodes and refresh the stable pointer.
# Review failure must not block the next observation block.
if python3 scripts/txt_strategy_shadow_observation_review.py \
    --input-jsonl "$JSONL" --output "$REVIEW" --text; then
    ln -sfn "strategy_shadow_observation_${RUN_ID}.episode_review.json" \
        "$OUT_DIR/strategy_shadow_observation_latest_review.json"
else
    echo "shadow-observer-service: episode review failed for run_id=${RUN_ID} (non-blocking)" >&2
fi
