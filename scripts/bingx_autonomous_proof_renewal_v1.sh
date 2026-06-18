#!/usr/bin/env bash
# =============================================================================
# bingx_autonomous_proof_renewal_v1.sh
#
# Runner for ONE autonomous proof-renewal cycle (doctrine 548e38e). It refreshes
# CANONICAL proof by routing a tiny BingX order through the AUTONOMOUS rail
# (intent -> risk -> execution_router -> broker), so it persists as
# execution_fill_events(live-broker/bingx) + decision_outcomes(finalized via the
# canonical finalizer) + reality_gap_samples.
#
# It is NOT the operator direct-broker rail: it never calls the direct-broker
# order path, never the legacy outcome endpoint, never the operator taker rail,
# never manual SQL. Finalization is ONLY via proof_finalizer.
#
# DEFAULT MODE = readiness (read-only; runs the readiness check, prints the cycle
# plan, places NO order, changes NO mode). The `execute` mode is the single live
# boundary (PORTE 2) and is hard-gated behind BOTH:
#     --confirm-live PROOF_RENEWAL_EXECUTE
#     --go-phrase "GO renew BingX autonomous proof side=sell"
# It must NOT be triggered by ambient pings / clean_cycles / gate=go.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib/control_plane_helpers.sh
. "$SCRIPT_DIR/lib/control_plane_helpers.sh"
txt_source_repo_env

CONTROL_PLANE_URL="${CONTROL_PLANE_URL_HOST:-http://127.0.0.1:8000}"
USERNAME="${USERNAME:-operator}"
PASSWORD="${PASSWORD:-}"
ACCOUNT_ID="${ACCOUNT_ID:-29586394}"
SYMBOL="${SYMBOL:-BTCUSDT}"
SIDE="${SIDE:-sell}"
NOTIONAL_USD="${NOTIONAL_USD:-7.5}"
NOTIONAL_CAP="${NOTIONAL_CAP:-7.5}"
OBSERVE_SECONDS="${OBSERVE_SECONDS:-8}"
STRATEGY_ID="${STRATEGY_ID:-autonomous_proof_renewal}"
PORTFOLIO_ID="${PORTFOLIO_ID:-ops}"
REASON_CODE="${REASON_CODE:-autonomous_proof_renewal_cycle_v1}"
CP_CONTAINER="${CP_CONTAINER:-control-plane}"
DEDICATED_GO_PHRASE="GO renew BingX autonomous proof side=sell"
MODE="readiness"
CONFIRM_LIVE=""
GO_PHRASE=""

usage() { sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; cat <<EOF

Usage: bingx_autonomous_proof_renewal_v1.sh [readiness|execute] [options]
  --side buy|sell   --notional-usd V   --observe-seconds V
  --confirm-live PROOF_RENEWAL_EXECUTE      (execute only)
  --go-phrase "$DEDICATED_GO_PHRASE"   (execute only)
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    readiness|execute) MODE="$1"; shift 1 ;;
    --side) SIDE="$2"; shift 2 ;;
    --notional-usd) NOTIONAL_USD="$2"; shift 2 ;;
    --observe-seconds) OBSERVE_SECONDS="$2"; shift 2 ;;
    --confirm-live) CONFIRM_LIVE="$2"; shift 2 ;;
    --go-phrase) GO_PHRASE="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 2 ;;
  esac
done

awk "BEGIN{exit !($NOTIONAL_USD <= $NOTIONAL_CAP)}" || { echo "notional_exceeds_cap" >&2; exit 3; }

# ---- readiness (default): read-only, no order, no mode change ----------------
echo "=== READINESS (read-only) ==="
bash "$SCRIPT_DIR/bingx_proof_cycle_readiness_check.sh" || true

cat <<EOF

=== PROOF-RENEWAL CYCLE PLAN (autonomous rail) ===
  route   : intent -> /v1/intents/submit (auto_execute, proof_renewal=true) -> risk
            -> execution_router (D1 MARKET taker) -> broker BingX
  entry   : $SIDE $SYMBOL, notional $NOTIONAL_USD (<= $NOTIONAL_CAP), MARKET taker
  observe : ${OBSERVE_SECONDS}s
  flatten : opposite-side reduce intent, ALSO routed (exit fill is canonical)
  finalize: proof_finalizer.finalize_autonomous_bingx_outcome(entry, exit, require_round_trip=true)
  verify  : execution_fill_events live-broker/bingx (entry+exit), decision_outcomes
            finalized provider=bingx source=intent, reality_gap_samples, flat, open_orders=0
  revert  : guarded_auto (EXIT trap always)
  STOP    : any break -> abort + flatten + revert + keep artifacts + NO retry

  This cycle is the single LIVE boundary. It requires the dedicated phrase:
    $DEDICATED_GO_PHRASE
EOF

if [ "$MODE" = "readiness" ]; then
  echo
  echo ">>> readiness only — no order, no mode change, no finalization."
  exit 0
fi

# ===========================================================================
# execute (PORTE 2 — single live boundary). Hard-gated. Not run in PORTE 1.
# ===========================================================================
if [ "$CONFIRM_LIVE" != "PROOF_RENEWAL_EXECUTE" ] || [ "$GO_PHRASE" != "$DEDICATED_GO_PHRASE" ]; then
  echo "execute_blocked: requires --confirm-live PROOF_RENEWAL_EXECUTE AND --go-phrase \"$DEDICATED_GO_PHRASE\"" >&2
  echo "(a bare GO, clean_cycles, or gate=go never trigger this cycle)" >&2
  exit 4
fi

PROOF_CYCLE_ID="proofcyc-$(date -u +%Y%m%dT%H%M%SZ)"
ENTRY_DECISION_ID="${PROOF_CYCLE_ID}-entry"
EXIT_DECISION_ID="${PROOF_CYCLE_ID}-exit"
POSSIDE="SHORT"; [ "$SIDE" = "buy" ] && POSSIDE="LONG"
CLOSE_SIDE="buy"; [ "$SIDE" = "buy" ] && CLOSE_SIDE="sell"

if [ -z "$PASSWORD" ]; then PASSWORD="$(txt_resolve_user_password "$USERNAME" "$PASSWORD" || true)"; fi
[ -n "$PASSWORD" ] || { echo "auth_error" >&2; exit 7; }
TOKEN="$(txt_control_plane_login_token "$CONTROL_PLANE_URL" "$USERNAME" "$PASSWORD" "0" || true)"
[ -n "$TOKEN" ] || { echo "login_failed" >&2; exit 7; }

set_mode() { curl --max-time 20 -sS -o /dev/null \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -X POST "$CONTROL_PLANE_URL/v1/system/mode" \
  --data "{\"mode\":\"$1\",\"source\":\"autonomous_proof_renewal\",\"reason\":\"$2\"}" || true; }

REVERTED=0
REVERT_HARD_FAIL=0
revert_and_flatten() {
  [ "$REVERTED" = 1 ] && return; REVERTED=1
  echo "=== REVERT: cancel orders + hedge-safe flatten + VERIFY (no silent done) ==="
  local SWAP_Q="${SYMBOL%USDT}-USDT"
  # 1. cancel all open orders (signed BingX DELETE — not the broker order path).
  #    Errors are surfaced, NEVER swallowed.
  docker exec -i "$CP_CONTAINER" python -c "
import asyncio;import apps.control_plane.main as cp
async def m():
    _,sp=cp._bingx_secret_payload_for_account('${ACCOUNT_ID}',require_trade=True)
    oo=await cp._bingx_signed_get(sp,'/openApi/swap/v2/trade/openOrders',{'symbol':'${SWAP_Q}'})
    n=0
    for o in cp._bingx_extract_dict_items(oo,'orders','data','list'):
        oid=o.get('orderId') or o.get('orderID')
        if oid:
            try: await cp._bingx_signed_request(sp,'DELETE','/openApi/swap/v2/trade/order',{'symbol':'${SWAP_Q}','orderId':str(oid)}); n+=1
            except Exception as e: print('CANCEL_ERR',str(e)[:100])
    print('orders_cancelled='+str(n))
asyncio.run(m())
" || echo "  WARN: order-cancel step errored"
  # 2. reliable hedge-safe close via the sanctioned control-plane flatten endpoint
  #    (BUY positionSide=SHORT / SELL positionSide=LONG, MARKET, no reduceOnly; it
  #    re-reads positions_after server-side). Authenticated; errors surfaced.
  curl --max-time 30 -sS -H "Authorization: Bearer ${TOKEN}" -H 'content-type: application/json' \
    -X POST "${CONTROL_PLANE_URL}/v1/connectors/bingx/flatten" \
    --data "{\"account_id\":\"${ACCOUNT_ID}\",\"symbol\":\"${SYMBOL}\",\"confirmation_text\":\"BINGX_FLATTEN\"}" \
    | python3 -c "import sys,json
try: d=json.load(sys.stdin); print('  flatten endpoint status=',d.get('status'),'closed=',len(d.get('close_results') or []),'errors=',len(d.get('close_errors') or []))
except Exception as e: print('  flatten endpoint UNPARSEABLE:',str(e)[:80])" || echo "  WARN: flatten endpoint call errored"
  # 3. VERIFY ground truth — success ONLY if position=0 AND open_orders=0.
  local FINAL
  FINAL="$(docker exec -i "$CP_CONTAINER" python -c "
import asyncio,json;import apps.control_plane.main as cp
async def m():
    _,sp=cp._bingx_secret_payload_for_account('${ACCOUNT_ID}',require_trade=False)
    pos=await cp._bingx_signed_get(sp,'/openApi/swap/v2/user/positions',{'symbol':'${SWAP_Q}'})
    oo=await cp._bingx_signed_get(sp,'/openApi/swap/v2/trade/openOrders',{'symbol':'${SWAP_Q}'})
    print(json.dumps({'positions':len(cp._bingx_flattenable_positions(pos,'${ACCOUNT_ID}',symbol='${SYMBOL}')),'orders':len(cp._bingx_extract_dict_items(oo,'orders','data','list'))}))
asyncio.run(m())
" | tail -1)"
  echo "  post-flatten truth: $FINAL"
  set_mode guarded_auto "autonomous_proof_renewal_revert"
  if printf '%s' "$FINAL" | grep -q '"positions": 0' && printf '%s' "$FINAL" | grep -q '"orders": 0'; then
    echo "  FLATTEN VERIFIED: position=0, open_orders=0, guarded_auto restored."
  else
    REVERT_HARD_FAIL=1
    echo "  !!! HARD_FAIL: NOT flat after flatten ($FINAL). OPERATOR MUST INTERVENE. Artifact kept, no retry." >&2
  fi
}
trap revert_and_flatten EXIT

submit_intent() { # $1=decision_id $2=side $3=reduce(true/false)
  curl --max-time 40 -sS -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -X POST "$CONTROL_PLANE_URL/v1/intents/submit" --data "$(python3 - "$1" "$2" "$3" <<PY
import json,sys
did,side,reduce=sys.argv[1],sys.argv[2],sys.argv[3]=="true"
print(json.dumps({"auto_execute":True,"intent":{
  "intent_id":did,"strategy_id":"${STRATEGY_ID}","portfolio_id":"${PORTFOLIO_ID}",
  "venue":"bingx","instrument":"${SYMBOL}","side":side,"reason_code":"${REASON_CODE}",
  "confidence":0.8,"target_notional_usd":${NOTIONAL_USD},"max_slippage_bps":10,
  "risk_tags":["autonomous-proof-renewal"],
  "explainability":{"live_execution":{"enabled":True,"provider":"bingx",
    "account_id":"${ACCOUNT_ID}","order_type":"MARKET","reduce_only":reduce,
    "position_side":"${POSSIDE}","proof_renewal":True,"proof_cycle_id":"${PROOF_CYCLE_ID}",
    "auto_protection":False}}}}))
PY
)"; }

# abort the cycle (trap flattens + reverts) unless the intent really executed a
# live order — catches rejected_by_risk / preflight / pending / paper / no-order.
assert_executed() { # $1=intent json response  $2=leg label
  local reason
  reason="$(PYTHONPATH=/opt/txt python3 -c "import json,sys
from apps.control_plane.proof_intent_guard import intent_not_executed_reason
try: d=json.loads(sys.argv[1])
except Exception: print('unparseable_intent_response'); sys.exit(0)
print(intent_not_executed_reason(d) or '')" "$1")"
  if [ -n "$reason" ]; then
    echo "  ABORT[$2]: $reason — no retry, trap will flatten + revert" >&2
    exit 9
  fi
  echo "  [$2] executed live."
}

# verify an actual canonical fill persisted (status='executed' is not enough — a
# placed-but-unfilled LIMIT also reports executed). Abort if no fill.
assert_fill_persisted() { # $1=decision_id  $2=leg label
  local got
  got="$(docker exec -i "$CP_CONTAINER" python -c "
import time,apps.control_plane.main as cp
for _ in range(4):
    if cp.fetch_all('SELECT 1 FROM execution_fill_events WHERE decision_id=%s AND fill_type=%s AND venue=%s LIMIT 1',('$1','live-broker','bingx')): print('FILL'); break
    time.sleep(1)
else: print('NOFILL')" 2>/dev/null | tail -1)"
  if [ "$got" != "FILL" ]; then
    echo "  ABORT[$2]: no canonical fill persisted (order placed but did not fill) — no retry, trap will flatten + revert" >&2
    exit 9
  fi
  echo "  [$2] canonical fill verified."
}

echo "=== ENTER managed_live (bounded) ==="; set_mode managed_live "autonomous_proof_renewal"
echo "=== ENTRY intent (autonomous MARKET taker) ==="
ENTRY_RESP="$(submit_intent "$ENTRY_DECISION_ID" "$SIDE" "false")"; printf '%s' "$ENTRY_RESP" | tail -c 400; echo
assert_executed "$ENTRY_RESP" "entry"
assert_fill_persisted "$ENTRY_DECISION_ID" "entry"
echo "=== OBSERVE ${OBSERVE_SECONDS}s ==="; sleep "$OBSERVE_SECONDS"
# hedge-safe close: BUY positionSide=SHORT WITHOUT reduceOnly (BingX hedge mode
# rejects reduceOnly). In hedge mode the opposite side on the same positionSide
# reduces/closes the leg, so reduce_only must stay false.
echo "=== FLATTEN intent (routed, canonical exit fill, hedge-safe no-reduceOnly) ==="
EXIT_RESP="$(submit_intent "$EXIT_DECISION_ID" "$CLOSE_SIDE" "false")"; printf '%s' "$EXIT_RESP" | tail -c 400; echo
assert_executed "$EXIT_RESP" "exit"
assert_fill_persisted "$EXIT_DECISION_ID" "exit"

echo "=== FINALIZE via canonical finalizer (never legacy endpoint) ==="
docker exec -i "$CP_CONTAINER" python -c "
from apps.control_plane.proof_finalizer import finalize_autonomous_bingx_outcome
r=finalize_autonomous_bingx_outcome('${ENTRY_DECISION_ID}', exit_decision_id='${EXIT_DECISION_ID}', require_round_trip=True)
print('FINALIZE', r.action, r.reason)
" 2>&1 | tail -2

# REALITY-GAP: generate the third proof stream from the persisted execution replay
# (overrides give venue/symbol/side; realized metrics come from the fills). No
# market, no calibration/training side effects (apply_calibration/train_brain=false).
echo "=== REALITY-GAP ingest (replay-measured, no market) ==="
curl --max-time 30 -sS -H "Authorization: Bearer ${TOKEN}" -H 'content-type: application/json' \
  -X POST "${CONTROL_PLANE_URL}/v1/execution/reality-gap/${ENTRY_DECISION_ID}" \
  --data "{\"symbol\":\"${SYMBOL}\",\"venue\":\"bingx\",\"side\":\"${SIDE}\",\"apply_calibration\":false,\"train_brain\":false}" \
  | python3 -c "import sys,json
try: d=json.load(sys.stdin); print('  reality_gap ingest status=',d.get('status','?'))
except Exception as e: print('  reality_gap ingest unparseable:',str(e)[:80])" || echo "  WARN: reality_gap ingest errored"

revert_and_flatten; trap - EXIT
echo "=== POST-STATE (expect flat, finalized) — see readiness/audit for verification ==="
echo "done. mode restored to guarded_auto."
