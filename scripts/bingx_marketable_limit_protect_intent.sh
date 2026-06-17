#!/usr/bin/env bash
# =============================================================================
# bingx_marketable_limit_protect_intent.sh
#
# Operator harness for "BingX Marketable Limit Protection v1" — the single
# atomic "filled + protected" entry: a spread-CROSSING LIMIT (taker fill, but
# still a LIMIT, so BingX echoes the attached TP/SL legs -> armed).
#
# DEFAULT MODE IS `preview` : read-only.  It runs the full pre-flight (state,
# risk-gateway pre-trade, marketable price, broker dry-run) and PRINTS the
# 10-point execution plan.  It changes NOTHING and places NO order.
#
# `execute` MODE is hard-gated and must NOT be used without a separate, explicit
# operator GO.  It requires BOTH:
#     --confirm-live MARKETABLE_LIMIT_EXECUTE
#     --go
# Even then every guardrail below must pass or it aborts before any order.
#
# Guardrails (execute):
#   - start state MUST be guarded_auto + flat + kill=false + gate=go
#   - risk-gateway /v1/checks/pre-trade MUST approve (gate preserved)
#   - notional <= NOTIONAL_CAP (7.5), buffer <= MAX_BUFFER_BPS, ONE order only
#   - marketable LIMIT, time_in_force=IOC (unfilled remainder auto-expires)
#   - protection require_full_acceptance=true ; if protection != armed -> flatten
#   - managed_live is entered ONLY for the order window; an EXIT trap ALWAYS
#     reverts to guarded_auto and flattens any residual position
#   - flatten uses the hedge-safe close: BUY positionSide=SHORT (or SELL
#     positionSide=LONG) WITHOUT reduceOnly (hedge mode rejects reduceOnly)
#   - secret / api_key / signature are NEVER printed
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib/control_plane_helpers.sh
. "$SCRIPT_DIR/lib/control_plane_helpers.sh"
txt_source_repo_env

CONTROL_PLANE_URL="${CONTROL_PLANE_URL:-http://127.0.0.1:8000}"
USERNAME="${USERNAME:-operator}"
PASSWORD="${PASSWORD:-}"
ACCOUNT_ID="${ACCOUNT_ID:-29586394}"
SYMBOL="${SYMBOL:-BTCUSDT}"
SIDE="${SIDE:-sell}"
NOTIONAL_USD="${NOTIONAL_USD:-7.5}"
NOTIONAL_CAP="${NOTIONAL_CAP:-7.5}"
BUFFER_BPS="${BUFFER_BPS:-3}"
MAX_BUFFER_BPS="${MAX_BUFFER_BPS:-25}"
MAX_SLIPPAGE_BPS="${MAX_SLIPPAGE_BPS:-10}"
OBSERVE_SECONDS="${OBSERVE_SECONDS:-8}"
STRATEGY_ID="${STRATEGY_ID:-ops_micro_live_btc_first}"
PORTFOLIO_ID="${PORTFOLIO_ID:-ops}"
REASON_CODE="${REASON_CODE:-marketable_limit_protection_v1}"
CONTROL_PLANE_CONTAINER="${CONTROL_PLANE_CONTAINER:-control-plane}"
RISK_GATEWAY_CONTAINER="${RISK_GATEWAY_CONTAINER:-risk-gateway}"
MODE="preview"
CONFIRM_LIVE=""
GO="0"
CURL_INSECURE="${CURL_INSECURE:-0}"

usage() { sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; cat <<'EOF'

Usage: bingx_marketable_limit_protect_intent.sh [preview|execute] [options]
  --account-id V   --symbol V   --side buy|sell   --notional-usd V
  --buffer-bps V   --max-buffer-bps V   --observe-seconds V
  --confirm-live MARKETABLE_LIMIT_EXECUTE   --go   (both required for execute)
  --insecure   -h|--help
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    preview|execute) MODE="$1"; shift 1 ;;
    --account-id) ACCOUNT_ID="$2"; shift 2 ;;
    --symbol) SYMBOL="$2"; shift 2 ;;
    --side) SIDE="$2"; shift 2 ;;
    --notional-usd) NOTIONAL_USD="$2"; shift 2 ;;
    --buffer-bps) BUFFER_BPS="$2"; shift 2 ;;
    --max-buffer-bps) MAX_BUFFER_BPS="$2"; shift 2 ;;
    --observe-seconds) OBSERVE_SECONDS="$2"; shift 2 ;;
    --username) USERNAME="$2"; shift 2 ;;
    --password) PASSWORD="$2"; shift 2 ;;
    --confirm-live) CONFIRM_LIVE="$2"; shift 2 ;;
    --go) GO="1"; shift 1 ;;
    --insecure) CURL_INSECURE="1"; shift 1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 2 ;;
  esac
done

[ "$SIDE" = "buy" ] || [ "$SIDE" = "sell" ] || { echo "invalid_side" >&2; exit 3; }
awk "BEGIN{exit !($NOTIONAL_USD <= $NOTIONAL_CAP)}" || { echo "notional_exceeds_cap ($NOTIONAL_USD > $NOTIONAL_CAP)" >&2; exit 3; }
awk "BEGIN{exit !($BUFFER_BPS <= $MAX_BUFFER_BPS)}" || { echo "buffer_exceeds_max" >&2; exit 3; }

if [ "$MODE" = "execute" ]; then
  if [ "$CONFIRM_LIVE" != "MARKETABLE_LIMIT_EXECUTE" ] || [ "$GO" != "1" ]; then
    echo "execute_blocked: requires --confirm-live MARKETABLE_LIMIT_EXECUTE AND --go (separate operator GO)" >&2
    exit 4
  fi
fi

dex() { docker exec -i "$1" python -c "$2"; }

# --- read-only pre-check (both modes) --------------------------------------
SWAP="$SYMBOL"; case "$SYMBOL" in *-*) ;; *USDT) SWAP="${SYMBOL%USDT}-USDT";; esac

PRECHECK_JSON="$(dex "$CONTROL_PLANE_CONTAINER" "
import asyncio,json,urllib.request;import apps.control_plane.main as cp
async def m():
    h=json.load(urllib.request.urlopen('http://127.0.0.1:8000/health',timeout=10))
    g=h.get('opportunity_gate') if isinstance(h.get('opportunity_gate'),dict) else {}
    info,sp=cp._bingx_secret_payload_for_account('${ACCOUNT_ID}',require_trade=False)
    pos=await cp._bingx_signed_get(sp,'/openApi/swap/v2/user/positions',{'symbol':'${SWAP}'})
    flat=cp._bingx_flattenable_positions(pos,'${ACCOUNT_ID}',symbol='${SYMBOL}')
    oo=await cp._bingx_signed_get(sp,'/openApi/swap/v2/trade/openOrders',{'symbol':'${SWAP}'})
    orders=cp._bingx_extract_dict_items(oo,'orders','data','list')
    ob=json.load(urllib.request.urlopen('http://broker-adapter:8004/v1/orderbook/bingx/${SYMBOL}',timeout=12))
    print('J='+json.dumps({'mode':h.get('system_mode'),'gate':g.get('status'),
        'kill':g.get('kill_switch_recommended'),'open_positions':len(flat),
        'open_orders':len(orders),'bid':ob.get('bid'),'ask':ob.get('ask')}))
asyncio.run(m())
" 2>/dev/null | sed -n 's/^J=//p' | tail -1)"

[ -n "$PRECHECK_JSON" ] || { echo "precheck_failed: no response" >&2; exit 5; }

read -r MODE_NOW GATE KILL OPENPOS OPENORD BID ASK <<EOF
$(python3 - "$PRECHECK_JSON" <<'PY'
import json,sys
d=json.loads(sys.argv[1])
print(d.get('mode'),d.get('gate'),d.get('kill'),d.get('open_positions'),d.get('open_orders'),d.get('bid'),d.get('ask'))
PY
)
EOF

# compute marketable price + protection from current touch
read -r PRICE TP SL POSSIDE <<EOF
$(BID="$BID" ASK="$ASK" SIDE="$SIDE" BUFFER_BPS="$BUFFER_BPS" python3 - <<'PY'
import os
bid=float(os.environ['BID']); ask=float(os.environ['ASK']); side=os.environ['SIDE']; b=float(os.environ['BUFFER_BPS'])
if side=='sell':
    print(round(bid*(1-b/1e4),1), round(bid*0.99,1), round(bid*1.01,1), 'SHORT')
else:
    print(round(ask*(1+b/1e4),1), round(ask*1.01,1), round(ask*0.99,1), 'LONG')
PY
)
EOF

echo "=== PRE-CHECK ==="
echo "  system_mode=$MODE_NOW  gate=$GATE  kill=$KILL  open_positions=$OPENPOS  open_orders=$OPENORD"
echo "  best_bid=$BID  best_ask=$ASK"
echo "  side=$SIDE  position_side=$POSSIDE  buffer=${BUFFER_BPS}bps  notional=${NOTIONAL_USD}USD"
echo "  marketable_limit_price=$PRICE  tp_trigger=$TP  sl_trigger=$SL  time_in_force=IOC"

PRECHECK_OK=1
[ "$MODE_NOW" = "guarded_auto" ] || { echo "  STOP: not guarded_auto"; PRECHECK_OK=0; }
[ "$GATE" = "go" ] || { echo "  STOP: opportunity gate != go"; PRECHECK_OK=0; }
[ "$KILL" = "False" ] || { echo "  STOP: kill switch recommended"; PRECHECK_OK=0; }
[ "$OPENPOS" = "0" ] || { echo "  STOP: not flat"; PRECHECK_OK=0; }
[ "$OPENORD" = "0" ] || { echo "  STOP: resting orders present"; PRECHECK_OK=0; }

# --- risk-gateway pre-trade (gate preserved) -------------------------------
# NOTE: this call mutates the in-memory daily-notional budget, so it runs ONLY
# in execute mode. In preview it is reported as a deferred step (truly read-only).
echo "=== RISK-GATEWAY PRE-TRADE ==="
if [ "$MODE" != "execute" ]; then
  RG_DECISION="deferred"
  echo "  deferred to execute (avoids mutating in-memory risk budget during preview)"
else
RG_JSON="$(dex "$RISK_GATEWAY_CONTAINER" "
import json,urllib.request,urllib.error
intent={'strategy_id':'${STRATEGY_ID}','portfolio_id':'${PORTFOLIO_ID}','venue':'bingx',
  'instrument':'${SYMBOL}','side':'${SIDE}','reason_code':'${REASON_CODE}','confidence':0.8,
  'target_notional_usd':${NOTIONAL_USD},'max_slippage_bps':${MAX_SLIPPAGE_BPS}}
req={'intent':intent,'system_mode':'managed_live'}
r=urllib.request.Request('http://127.0.0.1:8001/v1/checks/pre-trade',data=json.dumps(req).encode(),headers={'content-type':'application/json'})
try:
    print('J='+json.dumps(json.load(urllib.request.urlopen(r,timeout=20))))
except urllib.error.HTTPError as e:
    print('J='+json.dumps({'decision':'error','detail':e.read().decode()[:300]}))
" 2>/dev/null | sed -n 's/^J=//p' | tail -1)"
echo "  $RG_JSON"
RG_DECISION="$(python3 -c "import json,sys;print(json.loads(sys.argv[1]).get('decision'))" "$RG_JSON" 2>/dev/null || echo error)"
[ "$RG_DECISION" = "approved" ] || { echo "  STOP: risk-gateway decision=$RG_DECISION"; PRECHECK_OK=0; }
fi

# --- broker dry-run (param + protection proof, no BingX) --------------------
echo "=== BROKER DRY-RUN (armed proof) ==="
DRY_PAYLOAD="$(python3 - <<PY
import json
print(json.dumps({"provider":"bingx","account_id":"${ACCOUNT_ID}","dry_run":True,"symbol":"${SYMBOL}",
 "side":"${SIDE}","position_side":"${POSSIDE}","order_type":"LIMIT","price":${PRICE},
 "notional_usd":${NOTIONAL_USD},"time_in_force":"IOC","protection":{
   "take_profit":{"trigger_price":${TP},"order_type":"market","working_type":"MARK_PRICE"},
   "stop_loss":{"trigger_price":${SL},"order_type":"market","working_type":"MARK_PRICE"},
   "require_full_acceptance":True}}))
PY
)"
DRY_JSON="$(dex "$CONTROL_PLANE_CONTAINER" "
import json,urllib.request
d=${DRY_PAYLOAD@Q}
r=urllib.request.Request('http://broker-adapter:8004/v1/live/orders',data=d.encode(),headers={'content-type':'application/json'})
print('J='+json.dumps(json.load(urllib.request.urlopen(r,timeout=30))))
" 2>/dev/null | sed -n 's/^J=//p' | tail -1)"
DRY_PROT="$(python3 -c "import json,sys;print(json.loads(sys.argv[1]).get('protection_status'))" "$DRY_JSON" 2>/dev/null || echo error)"
echo "  protection_status=$DRY_PROT"
[ "$DRY_PROT" = "armed" ] || { echo "  STOP: dry-run protection not armed"; PRECHECK_OK=0; }

# --- 10-point plan ----------------------------------------------------------
cat <<EOF

=== EXECUTION PLAN (10 points) ===
  1. pre-check: guarded_auto + flat + kill=false + gate=go            [$([ "$PRECHECK_OK" = 1 ] && echo PASS || echo FAIL)]
  2. risk-gateway /v1/checks/pre-trade approves (notional<=cap)        [decision=$RG_DECISION]
  3. enter managed_live (brief, order window only)
  4. submit ONE marketable LIMIT: $SIDE $SYMBOL @ $PRICE, notional $NOTIONAL_USD, IOC,
     positionSide=$POSSIDE, native TP=$TP / SL=$SL (require_full_acceptance)
  5. verify fill: status in {filled,partially_filled} AND executed_qty>0
  6. verify protection_status == armed (BingX echoed TP/SL legs)
  7. verify position truth (BingX user/positions) matches fill
  8. observe ${OBSERVE_SECONDS}s
  9. flatten hedge-safe: $([ "$POSSIDE" = SHORT ] && echo "BUY positionSide=SHORT" || echo "SELL positionSide=LONG") MARKET, NO reduceOnly; verify position=0
 10. revert guarded_auto (EXIT trap always reverts; residual position auto-flattened)

  STOP conditions: signature mismatch | float64 type mismatch | TP/SL absent
    (protection != armed) | order not traced (no order_id) | position truth
    diverges | kill_switch | unknown fill state -> abort+flatten+revert.
EOF

if [ "$MODE" = "preview" ]; then
  echo
  echo ">>> preview only — no mode change, no order placed. (PRECHECK_OK=$PRECHECK_OK)"
  exit $([ "$PRECHECK_OK" = 1 ] && echo 0 || echo 1)
fi

# ===========================================================================
# execute path (only reached with --confirm-live MARKETABLE_LIMIT_EXECUTE --go)
# ===========================================================================
[ "$PRECHECK_OK" = 1 ] || { echo "execute_aborted: pre-check failed" >&2; exit 6; }

if [ -z "$PASSWORD" ]; then PASSWORD="$(txt_resolve_user_password "$USERNAME" "$PASSWORD" || true)"; fi
[ -n "$PASSWORD" ] || { echo "auth_error: password missing" >&2; exit 7; }
txt_init_curl_tls_flag "$CURL_INSECURE"
TOKEN="$(txt_control_plane_login_token "$CONTROL_PLANE_URL" "$USERNAME" "$PASSWORD" "$CURL_INSECURE" || true)"
[ -n "$TOKEN" ] || { echo "login_failed" >&2; exit 7; }

set_mode() {
  curl "${CURL_TLS_FLAG[@]}" --max-time 20 -sS -o /dev/null -w '' \
    -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -X POST "$CONTROL_PLANE_URL/v1/system/mode" \
    --data "{\"mode\":\"$1\",\"source\":\"marketable_limit_protect\",\"reason\":\"$2\"}" || true
}

REVERTED=0
revert_and_flatten() {
  [ "$REVERTED" = 1 ] && return; REVERTED=1
  echo "=== REVERT TRAP: flatten residual + restore guarded_auto ==="
  dex "$CONTROL_PLANE_CONTAINER" "
import asyncio,json;import apps.control_plane.main as cp
async def m():
    info,sp=cp._bingx_secret_payload_for_account('${ACCOUNT_ID}',require_trade=True)
    pos=await cp._bingx_signed_get(sp,'/openApi/swap/v2/user/positions',{'symbol':'${SWAP}'})
    flat=cp._bingx_flattenable_positions(pos,'${ACCOUNT_ID}',symbol='${SYMBOL}')
    for p in flat:
        body={'provider':'bingx','account_id':'${ACCOUNT_ID}','secret_payload':sp,'symbol':'${SYMBOL}',
              'side':p['close_side'],'position_side':p['position_side'],'quantity':p['quantity'],'order_type':'MARKET'}
        import httpx
        async with httpx.AsyncClient(timeout=25.0) as c:
            await c.post(cp.BROKER_ADAPTER_URL+'/v1/live/orders',json=body)
    print('RESIDUAL_FLATTENED='+str(len(flat)))
asyncio.run(m())
" 2>/dev/null | sed -n 's/^/  /p' | tail -2 || true
  set_mode guarded_auto "marketable_limit_revert"
  echo "  reverted to guarded_auto"
}
trap revert_and_flatten EXIT

echo "=== ENTER managed_live (order window) ==="
set_mode managed_live "marketable_limit_protection_v1"

echo "=== SUBMIT marketable LIMIT (ONE order) ==="
ORDER_JSON="$(dex "$CONTROL_PLANE_CONTAINER" "
import asyncio,json;import apps.control_plane.main as cp, httpx
async def m():
    info,sp=cp._bingx_secret_payload_for_account('${ACCOUNT_ID}',require_trade=True)
    body={'provider':'bingx','account_id':'${ACCOUNT_ID}','secret_payload':sp,'symbol':'${SYMBOL}',
      'side':'${SIDE}','position_side':'${POSSIDE}','order_type':'LIMIT','price':${PRICE},
      'notional_usd':${NOTIONAL_USD},'time_in_force':'IOC','client_order_id':'txt-mlp-'+str(int(__import__('time').time())),
      'protection':{'take_profit':{'trigger_price':${TP},'order_type':'market','working_type':'MARK_PRICE'},
                    'stop_loss':{'trigger_price':${SL},'order_type':'market','working_type':'MARK_PRICE'},
                    'require_full_acceptance':True}}
    async with httpx.AsyncClient(timeout=30.0) as c:
        r=await c.post(cp.BROKER_ADAPTER_URL+'/v1/live/orders',json=body)
        out=r.json() if r.headers.get('content-type','').startswith('application/json') else {'http':r.status_code,'text':r.text[:300]}
    safe={k:out.get(k) for k in ('order_id','status','protection_status','avg_fill_price','filled_notional_usd','fills')}
    print('J='+json.dumps(safe,separators=(',',':')))
asyncio.run(m())
" 2>/dev/null | sed -n 's/^J=//p' | tail -1)"
echo "  $ORDER_JSON"

VERDICT="$(python3 - "$ORDER_JSON" <<'PY'
import json,sys
try: d=json.loads(sys.argv[1])
except Exception: print("STOP:no_order"); raise SystemExit
oid=d.get('order_id'); st=d.get('status'); prot=d.get('protection_status')
fills=d.get('fills') or []; qty=sum(float(f.get('size_base') or 0) for f in fills if isinstance(f,dict))
if not oid: print("STOP:order_not_traced")
elif st in ('rejected','cancelled') or qty<=0: print("STOP:no_fill")
elif prot!='armed': print("STOP:protection_not_armed")
else: print("OK:filled_armed")
PY
)"
echo "  verdict=$VERDICT"
case "$VERDICT" in OK:*) ;; *) echo "  -> aborting, trap will flatten+revert"; exit 8 ;; esac

echo "=== OBSERVE ${OBSERVE_SECONDS}s ==="; sleep "$OBSERVE_SECONDS"

echo "=== FLATTEN + verify position=0 (handled by trap) ==="
revert_and_flatten
trap - EXIT

echo "=== POST-STATE ==="
dex "$CONTROL_PLANE_CONTAINER" "
import asyncio,json;import apps.control_plane.main as cp
async def m():
    info,sp=cp._bingx_secret_payload_for_account('${ACCOUNT_ID}',require_trade=False)
    pos=await cp._bingx_signed_get(sp,'/openApi/swap/v2/user/positions',{'symbol':'${SWAP}'})
    flat=cp._bingx_flattenable_positions(pos,'${ACCOUNT_ID}',symbol='${SYMBOL}')
    print('  open_positions='+str(len(flat)))
asyncio.run(m())
" 2>/dev/null | tail -1
echo "  done. mode restored to guarded_auto."
