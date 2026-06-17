#!/usr/bin/env bash
# =============================================================================
# bingx_marketable_limit_repeatability_report.sh
#
# READ-ONLY aggregator over the --print-raw audit artifacts produced by
# bingx_marketable_limit_protect_intent.sh (var/marketable_limit_captures/
# mlp-execute-*.json). Produces the Micro-live v2 repeatability report:
# fill quality, protection armed, flatten latency, residual state, audit
# cleanliness — and the campaign roll-up (consecutive clean runs vs the
# promotion threshold).
#
# This script NEVER places an order, never touches BingX, never changes any
# parameter, never resets anything. It only reads local JSON files (already
# sanitized) and re-scans them for leaks. Safe to run anytime.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CAPTURE_DIR="${CAPTURE_DIR:-/opt/txt/var/marketable_limit_captures}"
REQUIRED_CLEAN="${REQUIRED_CLEAN:-5}"     # consecutive clean runs to clear the gate
INCLUDE_PREVIEW="${INCLUDE_PREVIEW:-0}"   # preview artifacts are not real runs

usage() {
  cat <<'EOF'
Usage: bingx_marketable_limit_repeatability_report.sh [options]
  --capture-dir DIR     artifact dir (default /opt/txt/var/marketable_limit_captures)
  --required-clean N    consecutive clean runs to clear the gate (default 5)
  --include-preview     also list preview artifacts (not counted as runs)
  -h, --help
Read-only. No order, no venue call, no parameter change.
EOF
}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --capture-dir) CAPTURE_DIR="$2"; shift 2 ;;
    --required-clean) REQUIRED_CLEAN="$2"; shift 2 ;;
    --include-preview) INCLUDE_PREVIEW="1"; shift 1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 2 ;;
  esac
done

CAPTURE_DIR="$CAPTURE_DIR" REQUIRED_CLEAN="$REQUIRED_CLEAN" INCLUDE_PREVIEW="$INCLUDE_PREVIEW" python3 - <<'PY'
import json, glob, os, re

CAP = os.environ["CAPTURE_DIR"]; REQ = int(os.environ["REQUIRED_CLEAN"])
SECRET_KEY = re.compile(r'"(api_key|apikey|secret|api_secret|signature|sign|x-bx-apikey|authorization|cookie|token|access_token|password|signed_url)"\s*:', re.I)
HEX64 = re.compile(r'\b[0-9a-f]{64}\b')

def approx(a, b, tol=1e-9):
    try: return abs(float(a) - float(b)) <= max(tol, 1e-6 * max(abs(float(a)), abs(float(b))))
    except Exception: return False

def audit_clean(path):
    raw = open(path, encoding="utf-8").read()
    # the file should already be sanitized; a real key or a 64-hex (signature-like)
    # value would mean a redaction miss.
    return (SECRET_KEY.search(raw) is None) and (HEX64.search(raw) is None)

def assess(path):
    d = json.load(open(path, encoding="utf-8"))
    er = d.get("entry_response_raw") or {}
    pec = d.get("post_entry_checks") or {}
    fs = d.get("final_state") or {}
    req = d.get("entry_request_sanitized") or {}
    prot = er.get("protection") or {}
    acc = prot.get("accepted") or {}
    fills = er.get("fills") or []
    exec_qty = sum(float(f.get("size_base") or 0) for f in fills if isinstance(f, dict))
    ptruth = pec.get("position_truth") or []
    ptqty = sum(float(p.get("quantity") or 0) for p in ptruth if isinstance(p, dict))
    bb, ba = pec.get("balance_before"), pec.get("balance_after")
    cost = None
    try: cost = round(float(bb) - float(ba), 8)
    except Exception: pass
    # price improvement vs the marketable limit floor (bps), informational
    pi_bps = None
    try:
        lim = float(req.get("price")); avg = float(er.get("avg_fill_price"))
        if lim > 0 and avg > 0:
            side = str(req.get("side") or "").lower()
            pi_bps = round(((avg - lim) if side == "sell" else (lim - avg)) / lim * 1e4, 2)
    except Exception: pass
    flat_lat = pec.get("flatten_latency_ms")  # present only if harness instruments it (v2)
    checks = {
        "status_ok": str(er.get("status")) in ("filled", "partially_filled"),
        "executed_qty>0": exec_qty > 0,
        "tp_echoed": isinstance(acc.get("take_profit"), dict),
        "sl_echoed": isinstance(acc.get("stop_loss"), dict),
        "armed": er.get("protection_status") == "armed",
        "open_orders@entry==2": pec.get("open_orders") == 2,
        "position_truth~qty": approx(ptqty, exec_qty) and exec_qty > 0,
        "final_flat": bool(fs.get("flat")),
        "final_open_orders==0": fs.get("open_orders") == 0,
        "audit_clean": audit_clean(path),
    }
    return {
        "file": os.path.basename(path), "captured_at": d.get("captured_at"),
        "side": req.get("side"), "order_id": er.get("order_id"),
        "status": er.get("status"), "exec_qty": exec_qty,
        "avg_fill": er.get("avg_fill_price"), "price_improvement_bps": pi_bps,
        "armed": er.get("protection_status"), "open_orders_entry": pec.get("open_orders"),
        "cost_usdt": cost, "flatten_latency_ms": flat_lat,
        "final_flat": fs.get("flat"), "checks": checks, "clean": all(checks.values()),
    }

exec_files = sorted(glob.glob(os.path.join(CAP, "mlp-execute-*.json")))
prev_files = sorted(glob.glob(os.path.join(CAP, "mlp-preview-*.json")))

print("=" * 72)
print("BingX Marketable Limit Protection — REPEATABILITY REPORT (read-only)")
print("=" * 72)
print(f"capture_dir: {CAP}")
print(f"execute artifacts: {len(exec_files)}   preview artifacts: {len(prev_files)}")
print(f"promotion threshold: {REQ} consecutive clean runs\n")

if not exec_files:
    print("No execute artifacts yet — run a real round-trip with --print-raw first.")
    raise SystemExit(0)

rows = [assess(f) for f in exec_files]
for r in rows:
    flag = "CLEAN " if r["clean"] else "FAIL  "
    fl = f"{r['flatten_latency_ms']}ms" if r["flatten_latency_ms"] is not None else "n/a"
    print(f"[{flag}] {r['captured_at']}  side={r['side']}  order={r['order_id']}")
    print(f"         status={r['status']} qty={r['exec_qty']} avg={r['avg_fill']} "
          f"px_improve={r['price_improvement_bps']}bps armed={r['armed']} "
          f"legs@entry={r['open_orders_entry']} cost={r['cost_usdt']}USDT flatten={fl} flat={r['final_flat']}")
    if not r["clean"]:
        bad = [k for k, v in r["checks"].items() if not v]
        print(f"         FAILED CHECKS: {bad}")

# consecutive clean from the most recent backwards (no-retry: a FAIL breaks the streak)
streak = 0
for r in reversed(rows):
    if r["clean"]: streak += 1
    else: break
clean_total = sum(1 for r in rows if r["clean"])
sides = sorted({str(r["side"]) for r in rows if r["clean"]})
total_cost = round(sum(r["cost_usdt"] for r in rows if isinstance(r["cost_usdt"], (int, float))), 6)
flat_lat_missing = any(r["flatten_latency_ms"] is None for r in rows)

print("\n" + "-" * 72)
print("CAMPAIGN ROLL-UP")
print("-" * 72)
print(f"  total runs           : {len(rows)}")
print(f"  clean runs (total)    : {clean_total}")
print(f"  consecutive clean     : {streak} / {REQ}")
print(f"  clean sides covered   : {sides or '—'}  (need both buy & sell)")
print(f"  total round-trip cost : {total_cost} USDT")
print(f"  all audit-clean       : {all(r['checks']['audit_clean'] for r in rows)}")
print(f"  flatten-latency instrumented: {not flat_lat_missing}  "
      f"{'(add v2 capture field flatten_latency_ms)' if flat_lat_missing else ''}")

blockers = []
if streak < REQ: blockers.append(f"need {REQ - streak} more consecutive clean run(s)")
if not ({"buy", "sell"} <= set(sides)): blockers.append("buy side not yet validated clean")
if flat_lat_missing: blockers.append("flatten latency not instrumented in capture")
verdict = "READY for promotion review" if not blockers else "NOT ready"
print(f"\n  PROMOTION GATE: {verdict}")
for b in blockers: print(f"    - blocker: {b}")
print("\n  NOTE: clearing this gate authorizes a PROMOTION REVIEW only — never an")
print("        automatic notional increase or autonomy. Each step = separate explicit GO.")

if os.environ.get("INCLUDE_PREVIEW") == "1" and prev_files:
    print("\n  preview artifacts (not counted):")
    for f in prev_files: print(f"    - {os.path.basename(f)}")
PY
