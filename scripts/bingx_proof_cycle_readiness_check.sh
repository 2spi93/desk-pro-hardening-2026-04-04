#!/usr/bin/env bash
# =============================================================================
# bingx_proof_cycle_readiness_check.sh
#
# READ-ONLY readiness producer for the autonomous proof-renewal cycle (PORTE 1).
# Verifies every precondition + that the cold pipeline (D1/D2/D3) is present and
# the D2 fence is deployed, WITHOUT placing any order, changing any mode, or
# touching the broker. Emits readiness_report.json.
#
# NO market. NO order. NO broker call. NO mode change. NO finalization.
# =============================================================================
set -euo pipefail

ACCOUNT_ID="${ACCOUNT_ID:-29586394}"
SYMBOL="${SYMBOL:-BTCUSDT}"
NOTIONAL_CAP="${NOTIONAL_CAP:-7.5}"
CP_CONTAINER="${CP_CONTAINER:-control-plane}"
OUT_DIR="${OUT_DIR:-/opt/txt/var/proof_renewal}"
GO_PHRASE="GO renew BingX autonomous proof side=sell"

SWAP="$SYMBOL"; case "$SYMBOL" in *-*) ;; *USDT) SWAP="${SYMBOL%USDT}-USDT";; esac
mkdir -p "$OUT_DIR" 2>/dev/null || OUT_DIR="/tmp/proof_renewal" && mkdir -p "$OUT_DIR"
REPORT="$OUT_DIR/readiness_report.json"

# in-container read-only probe of state + code presence
RAW="$(docker exec -i "$CP_CONTAINER" python3 - "$ACCOUNT_ID" "$SWAP" "$SYMBOL" <<'PY' 2>/dev/null
import json, sys, urllib.request, inspect
import apps.control_plane.main as cp
acct, swap, sym = sys.argv[1], sys.argv[2], sys.argv[3]
out = {}
def get(url):
    return json.load(urllib.request.urlopen(url, timeout=8))
async def amain():
    import asyncio
    h = get("http://127.0.0.1:8000/health")
    g = h.get("opportunity_gate") if isinstance(h.get("opportunity_gate"), dict) else {}
    out["system_mode"] = h.get("system_mode")
    out["gate"] = g.get("status")
    out["kill"] = g.get("kill_switch_recommended")
    # service health
    for name, url in (("execution_router", "http://execution-router:8002/health"),
                      ("market_data_plane", "http://market-data:8003/health")):
        try:
            out[name] = get(url).get("status")
        except Exception as e:
            out[name] = f"err:{str(e)[:40]}"
    # BingX truth (read-only)
    _, sp = cp._bingx_secret_payload_for_account(acct, require_trade=False)
    pos = await cp._bingx_signed_get(sp, "/openApi/swap/v2/user/positions", {"symbol": swap})
    out["open_positions"] = len(cp._bingx_flattenable_positions(pos, acct, symbol=sym))
    oo = await cp._bingx_signed_get(sp, "/openApi/swap/v2/trade/openOrders", {"symbol": swap})
    out["open_orders"] = len(cp._bingx_extract_dict_items(oo, "orders", "data", "list"))
    asyncio_done = True
    # code presence (cold pipeline)
    out["d2_fence_in_loaded_main"] = "assert_legacy_finalize_not_for_proof_rail" in inspect.getsource(cp.update_outcome)
    try:
        from apps.control_plane.proof_finalizer import finalize_autonomous_bingx_outcome
        out["proof_finalizer_importable"] = True
    except Exception:
        out["proof_finalizer_importable"] = False
    try:
        from apps.execution_router.proof_order_shape import resolve_proof_renewal_order_shape
        out["d1_order_shape_importable"] = True
    except Exception:
        out["d1_order_shape_importable"] = False
import asyncio
asyncio.run(amain())
print(json.dumps(out))
PY
)"

if [ -z "$RAW" ]; then echo '{"error":"probe_failed"}' | tee "$REPORT"; exit 1; fi

NOTIONAL_CAP="$NOTIONAL_CAP" GO_PHRASE="$GO_PHRASE" REPORT="$REPORT" python3 - "$RAW" <<'PY'
import json, os, sys
d = json.loads(sys.argv[1])
reasons = []
def need(cond, why):
    if not cond: reasons.append(why)
need(d.get("system_mode") == "guarded_auto", "system_mode!=guarded_auto")
need(d.get("gate") == "go", "opportunity_gate!=go")
need(d.get("kill") in (False, None), "kill_switch_recommended")
need(d.get("open_positions") == 0, "not_flat")
need(d.get("open_orders") == 0, "open_orders_present")
need(d.get("execution_router") == "ok", "execution_router_unhealthy")
need(d.get("market_data_plane") == "ok", "market_data_plane_unhealthy")
need(bool(d.get("d2_fence_in_loaded_main")), "d2_fence_not_deployed")
need(bool(d.get("proof_finalizer_importable")), "proof_finalizer_missing")
need(bool(d.get("d1_order_shape_importable")), "d1_order_shape_missing")
# the dedicated GO phrase is NOT present in this read-only context -> cannot execute
report = {
    "ready_for_dedicated_go": len(reasons) == 0,
    "reasons": reasons,
    "no_market_action": True,
    "notional_cap_usd": float(os.environ["NOTIONAL_CAP"]),
    "dedicated_go_phrase": os.environ["GO_PHRASE"],
    "state": d,
}
with open(os.environ["REPORT"], "w", encoding="utf-8") as f:
    json.dump(report, f, indent=2, sort_keys=True)
print(f"READY_FOR_DEDICATED_GO = {report['ready_for_dedicated_go']}")
print("NO_MARKET_ACTION = True")
if reasons:
    print("REASONS = " + json.dumps(reasons))
print(f"report: {os.environ['REPORT']}")
print(f"dedicated GO phrase (later, separate): {os.environ['GO_PHRASE']}")
PY
