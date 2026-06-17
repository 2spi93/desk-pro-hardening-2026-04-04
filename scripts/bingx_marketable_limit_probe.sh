#!/usr/bin/env bash
# =============================================================================
# bingx_marketable_limit_probe.sh
#
# READ-ONLY / NON-FILLABLE validation harness for the "BingX Marketable Limit
# Protection v1" path.  Proves — WITHOUT creating any fillable order, position
# or resting working order — that a spread-CROSSING LIMIT with native numeric
# TP/SL legs signs correctly and is well-formed, and that the ONLY thing BingX
# objects to is the sub-minimal size.
#
# It runs four stages, ALL non-mutating:
#   1. PRECHECK  : guarded_auto, flat, kill=false, opportunity-gate=go, balance
#   2. PRICE     : real-time best_bid/best_ask (broker public read) + the
#                  computed marketable-limit price and bounded buffer
#   3. DRYRUN    : broker /v1/live/orders dry_run=true LIMIT(marketable)+TP/SL
#                  -> returns the exact assembled request_params + accepted
#                  protection legs.  Never touches BingX.
#   4. PROBE     : in-container control-plane _bingx_signed_request POST of a
#                  LIMIT(marketable)+numeric TP/SL order with quantity
#                  0.00001 (<< 0.0001 BTC-USDT min).  BingX REJECTS it for
#                  "minimum order amount" => zero fill, zero position, nothing
#                  to cancel.  The rejection is then CLASSIFIED.
#
# Verdict logic for stage 4:
#   MIN_AMOUNT_ONLY  -> GOOD: signing + float64 types + TP/SL param shape all
#                       accepted; only the size blocks.  A real >=min marketable
#                       LIMIT would be accepted and (being a LIMIT) echo the legs.
#   SIGNATURE_*      -> STOP: signing regressed.
#   TYPE_MISMATCH    -> STOP: a TP/SL field went out as a quoted string.
#   PROTECTION_*     -> STOP: TP/SL params malformed / rejected.
#   UNEXPECTED_FILL  -> STOP: order accepted (must not happen at sub-min).
#
# NEVER prints the secret, api_key or HMAC signature.  No real fillable order is
# ever placed by this script.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ACCOUNT_ID="${ACCOUNT_ID:-29586394}"
SYMBOL="${SYMBOL:-BTCUSDT}"
SIDE="${SIDE:-sell}"                 # proven micro-live side (SHORT)
NOTIONAL_USD="${NOTIONAL_USD:-7.5}"  # cap for the dry-run sizing only
BUFFER_BPS="${BUFFER_BPS:-3}"        # how far through the touch the limit crosses
MAX_BUFFER_BPS="${MAX_BUFFER_BPS:-25}"
PROBE_QTY="${PROBE_QTY:-0.00001}"    # << 0.0001 min -> guaranteed venue rejection
CONTROL_PLANE_CONTAINER="${CONTROL_PLANE_CONTAINER:-control-plane}"
BROKER_CONTAINER="${BROKER_CONTAINER:-broker-adapter}"
RUN_PROBE="${RUN_PROBE:-0}"          # stage 4 (real signed sub-min order) is opt-in

usage() {
  cat <<'EOF'
Usage: bingx_marketable_limit_probe.sh [options]

Stages 1-3 are pure reads / dry-run (no BingX order). Stage 4 (--probe) sends a
single SUB-MINIMAL signed LIMIT order that BingX rejects for minimum order
amount (zero fill, zero position) and classifies the rejection.

Options:
  --account-id VALUE     Linked BingX account id (default: 29586394)
  --symbol VALUE         Symbol (default: BTCUSDT)
  --side buy|sell        Order side (default: sell)
  --notional-usd VALUE   Dry-run notional cap (default: 7.5)
  --buffer-bps VALUE     Marketable cross buffer in bps (default: 3)
  --max-buffer-bps VALUE Hard cap on buffer (default: 25)
  --probe-qty VALUE      Sub-minimal probe quantity (default: 0.00001)
  --probe                Run stage 4 (the non-fillable signed probe)
  -h, --help             Show help
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --account-id) ACCOUNT_ID="$2"; shift 2 ;;
    --symbol) SYMBOL="$2"; shift 2 ;;
    --side) SIDE="$2"; shift 2 ;;
    --notional-usd) NOTIONAL_USD="$2"; shift 2 ;;
    --buffer-bps) BUFFER_BPS="$2"; shift 2 ;;
    --max-buffer-bps) MAX_BUFFER_BPS="$2"; shift 2 ;;
    --probe-qty) PROBE_QTY="$2"; shift 2 ;;
    --probe) RUN_PROBE="1"; shift 1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 2 ;;
  esac
done

if [ "$SIDE" != "buy" ] && [ "$SIDE" != "sell" ]; then
  echo "invalid_side: expected buy or sell" >&2; exit 3
fi

python3 - "$ACCOUNT_ID" "$SYMBOL" "$SIDE" "$NOTIONAL_USD" "$BUFFER_BPS" "$MAX_BUFFER_BPS" \
            "$PROBE_QTY" "$CONTROL_PLANE_CONTAINER" "$BROKER_CONTAINER" "$RUN_PROBE" <<'PY'
import json, subprocess, sys, time

ACCOUNT_ID, SYMBOL, SIDE, NOTIONAL, BUFFER_BPS, MAX_BUFFER_BPS, PROBE_QTY, \
    CP_CONTAINER, BROKER_CONTAINER, RUN_PROBE = sys.argv[1:11]
NOTIONAL = float(NOTIONAL); BUFFER_BPS = float(BUFFER_BPS); MAX_BUFFER_BPS = float(MAX_BUFFER_BPS)
if BUFFER_BPS > MAX_BUFFER_BPS:
    raise SystemExit(f"buffer_bps {BUFFER_BPS} exceeds max {MAX_BUFFER_BPS}")
SWAP = SYMBOL if "-" in SYMBOL else (SYMBOL[:-4] + "-" + SYMBOL[-4:] if SYMBOL.endswith("USDT") else SYMBOL)

def dex(container, code, timeout=60):
    p = subprocess.run(["docker", "exec", "-i", container, "python", "-c", code],
                       capture_output=True, text=True, timeout=timeout)
    if p.returncode != 0:
        raise RuntimeError((p.stderr or p.stdout or f"exit {p.returncode}").strip())
    return p.stdout.strip()

def banner(t): print(f"\n========== {t} ==========")

# ---- stage 1: PRECHECK (read-only) ----------------------------------------
banner("1. PRECHECK (read-only state)")
health = json.loads(dex(CP_CONTAINER,
    "import json,urllib.request;"
    "print(json.dumps(json.load(urllib.request.urlopen('http://127.0.0.1:8000/health',timeout=10))))").splitlines()[-1])
gate = health.get("opportunity_gate") if isinstance(health.get("opportunity_gate"), dict) else {}
mode = health.get("system_mode")
pos_code = (
    "import asyncio,json;import apps.control_plane.main as cp\n"
    "async def m():\n"
    f" info,sp=cp._bingx_secret_payload_for_account({ACCOUNT_ID!r},require_trade=False)\n"
    f" pos=await cp._bingx_signed_get(sp,'/openApi/swap/v2/user/positions',{{'symbol':{SWAP!r}}})\n"
    f" flat=cp._bingx_flattenable_positions(pos,{ACCOUNT_ID!r},symbol={SYMBOL!r})\n"
    " bal=await cp._bingx_fetch_futures_balances(sp)\n"
    " items=cp._bingx_extract_dict_items(bal,'balance','balances','data','list')\n"
    " usdt=next((b for b in items if str(b.get('asset') or '').upper()=='USDT'),{})\n"
    " print('POS='+json.dumps({'open':flat,'avail_margin':usdt.get('availableMargin'),'equity':usdt.get('equity')}))\n"
    "asyncio.run(m())"
)
posinfo = json.loads([l for l in dex(CP_CONTAINER, pos_code).splitlines() if l.startswith("POS=")][-1][4:])
open_positions = posinfo.get("open") or []
checks = {
    "system_mode": mode,
    "mode_is_guarded_auto": mode == "guarded_auto",
    "gate_status": gate.get("status"),
    "kill_switch_recommended": gate.get("kill_switch_recommended"),
    "deviation_kill_streak": (gate.get("kill_switch_detail") or {}).get("deviation_kill_streak"),
    "open_positions": len(open_positions),
    "is_flat": len(open_positions) == 0,
    "avail_margin_usdt": posinfo.get("avail_margin"),
}
for k, v in checks.items():
    print(f"  {k:28s}= {v}")
precheck_ok = checks["mode_is_guarded_auto"] and checks["is_flat"] and not checks["kill_switch_recommended"]
print(f"  PRECHECK_OK                 = {precheck_ok}")

# ---- stage 2: PRICE (read-only) -------------------------------------------
banner("2. PRICE (real-time best bid/ask + marketable price)")
ob = json.loads(dex(BROKER_CONTAINER,
    "import json,urllib.request;"
    f"print(json.dumps(json.load(urllib.request.urlopen('http://127.0.0.1:8004/v1/orderbook/bingx/{SYMBOL}',timeout=12))))").splitlines()[-1])
best_bid = float(ob.get("bid") or 0.0); best_ask = float(ob.get("ask") or 0.0)
if best_bid <= 0 or best_ask <= 0:
    raise SystemExit(f"could not resolve bid/ask: {ob}")
spread_bps = (best_ask - best_bid) / ((best_bid + best_ask) / 2) * 1e4
# SELL crosses at/below bid; BUY crosses at/above ask.  Buffer pushes THROUGH
# the touch so the limit is marketable (fills as taker) yet remains a LIMIT.
if SIDE == "sell":
    marketable_price = round(best_bid * (1 - BUFFER_BPS / 1e4), 1)
    tp_trigger = round(best_bid * 0.99, 1)   # SHORT TP below entry
    sl_trigger = round(best_bid * 1.01, 1)   # SHORT SL above entry
    position_side = "SHORT"
else:
    marketable_price = round(best_ask * (1 + BUFFER_BPS / 1e4), 1)
    tp_trigger = round(best_ask * 1.01, 1)   # LONG TP above entry
    sl_trigger = round(best_ask * 0.99, 1)   # LONG SL below entry
    position_side = "LONG"
print(f"  best_bid={best_bid}  best_ask={best_ask}  spread={spread_bps:.2f}bps  source={ob.get('source')}")
print(f"  side={SIDE}  position_side={position_side}  buffer={BUFFER_BPS}bps (<= {MAX_BUFFER_BPS})")
print(f"  marketable_limit_price={marketable_price}  tp_trigger={tp_trigger}  sl_trigger={sl_trigger}")

# ---- stage 3: DRYRUN (broker assembles params; no BingX) -------------------
banner("3. DRYRUN (broker param assembly + protection acceptance, no BingX)")
dry_payload = {
    "provider": "bingx", "account_id": ACCOUNT_ID, "dry_run": True,
    "symbol": SYMBOL, "side": SIDE, "position_side": position_side,
    "order_type": "LIMIT", "price": marketable_price, "notional_usd": NOTIONAL,
    "time_in_force": "IOC",
    "protection": {
        "take_profit": {"trigger_price": tp_trigger, "order_type": "market", "working_type": "MARK_PRICE"},
        "stop_loss":   {"trigger_price": sl_trigger, "order_type": "market", "working_type": "MARK_PRICE"},
        "require_full_acceptance": True,
    },
}
dry_code = (
    "import json,urllib.request;"
    f"d={json.dumps(dry_payload)!r};"  # already-serialized JSON as a python str literal
    "r=urllib.request.Request('http://127.0.0.1:8004/v1/live/orders',data=d.encode(),headers={'content-type':'application/json'});"
    "print(json.dumps(json.load(urllib.request.urlopen(r,timeout=30))))"
)
try:
    dry = json.loads(dex(BROKER_CONTAINER, dry_code).splitlines()[-1])
    rp = (dry.get("dry_run") or {}).get("request_params") or {}
    print(f"  status={dry.get('status')}  protection_status={dry.get('protection_status')}")
    print(f"  assembled order_type={rp.get('type')}  price={rp.get('price')}  timeInForce={rp.get('timeInForce')}")
    print(f"  takeProfit={rp.get('takeProfit')}")
    print(f"  stopLoss  ={rp.get('stopLoss')}")
    dryrun_armed = dry.get("protection_status") == "armed"
    print(f"  DRYRUN_PROTECTION_ARMED      = {dryrun_armed}")
except Exception as e:
    print(f"  DRYRUN_ERROR={str(e)[:400]}")
    dryrun_armed = False

# ---- stage 4: PROBE (real signed, sub-minimal -> rejected) -----------------
if RUN_PROBE != "1":
    banner("4. PROBE  (skipped — pass --probe to run the non-fillable signed order)")
    raise SystemExit(0)

banner("4. PROBE (signed sub-minimal LIMIT(marketable)+TP/SL -> BingX rejects)")
client_oid = f"txt-mlp-probe-{int(time.time())}"
tp_json = json.dumps({"type": "TAKE_PROFIT_MARKET", "stopPrice": tp_trigger, "workingType": "MARK_PRICE"}, separators=(",", ":"))
sl_json = json.dumps({"type": "STOP_MARKET", "stopPrice": sl_trigger, "workingType": "MARK_PRICE"}, separators=(",", ":"))
params = {
    "symbol": SWAP, "side": SIDE.upper(), "type": "LIMIT",
    "positionSide": position_side, "price": marketable_price,
    "quantity": PROBE_QTY, "timeInForce": "GTC",
    "takeProfit": tp_json, "stopLoss": sl_json, "clientOrderId": client_oid,
}
probe_code = (
    "import asyncio,json;import apps.control_plane.main as cp\n"
    f"params={json.dumps(params)!r}\n"  # noqa
    "params=json.loads(params)\n"
    "async def m():\n"
    f" info,sp=cp._bingx_secret_payload_for_account({ACCOUNT_ID!r},require_trade=True)\n"
    " print('PROBE_PARAMS='+json.dumps(params,separators=(',',':')))\n"  # no secret/sig
    " try:\n"
    "  resp=await cp._bingx_signed_request(sp,'POST','/openApi/swap/v2/trade/order',params)\n"
    "  print('PROBE_OUTCOME=ACCEPTED')\n"
    "  print('PROBE_RESP='+json.dumps(resp,separators=(',',':'))[:800])\n"
    " except Exception as e:\n"
    "  print('PROBE_OUTCOME=REJECTED')\n"
    "  print('PROBE_ERR='+str(e)[:600])\n"
    "asyncio.run(m())"
)
out = dex(CP_CONTAINER, probe_code, timeout=90)
lines = {l.split("=", 1)[0]: l.split("=", 1)[1] for l in out.splitlines() if "=" in l and l.split("=",1)[0].startswith("PROBE_")}
print("  params: " + lines.get("PROBE_PARAMS", "?"))
outcome = lines.get("PROBE_OUTCOME", "?")
err = (lines.get("PROBE_ERR", "") or "").lower()

if outcome == "ACCEPTED":
    verdict = "UNEXPECTED_FILL"
elif "signature" in err or "100413" in err:
    verdict = "SIGNATURE_MISMATCH"
elif "mismatch type" in err or "float64" in err:
    verdict = "TYPE_MISMATCH"
elif "takeprofit" in err or "stoploss" in err or "take_profit" in err or "stop_loss" in err:
    verdict = "PROTECTION_REJECTED"
elif ("minimum" in err or "min " in err or "at least" in err or "less than" in err
      or "80014" in err or "80012" in err or "quantity" in err or "amount" in err):
    verdict = "MIN_AMOUNT_ONLY"
else:
    verdict = "UNCLASSIFIED"

print(f"  outcome={outcome}")
if outcome == "REJECTED":
    print(f"  venue_error={lines.get('PROBE_ERR','')[:300]}")
else:
    print(f"  venue_resp={lines.get('PROBE_RESP','')[:300]}")
print(f"\n  >>> PROBE VERDICT = {verdict}")
GOOD = verdict == "MIN_AMOUNT_ONLY"
print(f"  >>> SIGNING + TYPES + PROTECTION SHAPE OK = {GOOD}")
if verdict == "UNEXPECTED_FILL":
    print("  !!! sub-minimal order was ACCEPTED — investigate & flatten before any real order.")
raise SystemExit(0 if GOOD else 1)
PY
