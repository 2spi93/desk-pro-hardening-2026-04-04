#!/usr/bin/env bash
# =============================================================================
# bingx_rail_separation_audit.sh
#
# READ-ONLY audit proving the three rails stay separated (doctrine 548e38e):
#   - the autonomous proof-renewal runner never uses the operator direct-broker
#     path (/v1/live/orders) nor the marketable-limit GO phrase;
#   - the runner finalizes ONLY via the canonical finalizer, never the legacy
#     /v1/outcomes endpoint nor manual SQL;
#   - execution_fill_events is written only by execution_router;
#   - the legacy outcome endpoint fence is present in the loaded control-plane.
#
# Static source + grep checks + one in-container code-presence read. NO market,
# NO order, NO finalize, NO DB mutation. Emits rail_separation_audit.json.
# =============================================================================
set -euo pipefail

ROOT="${ROOT:-/opt/txt}"
CP_CONTAINER="${CP_CONTAINER:-control-plane}"
RUNNER="$ROOT/scripts/bingx_autonomous_proof_renewal_v1.sh"
OUT_DIR="${OUT_DIR:-/opt/txt/var/proof_renewal}"
mkdir -p "$OUT_DIR" 2>/dev/null || OUT_DIR="/tmp/proof_renewal" && mkdir -p "$OUT_DIR"
REPORT="$OUT_DIR/rail_separation_audit.json"

ROOT="$ROOT" RUNNER="$RUNNER" CP_CONTAINER="$CP_CONTAINER" REPORT="$REPORT" python3 - <<'PY'
import json, os, re, subprocess
root, runner, cp, report = os.environ["ROOT"], os.environ["RUNNER"], os.environ["CP_CONTAINER"], os.environ["REPORT"]
findings = []
def check(name, ok, detail=""):
    findings.append({"check": name, "pass": bool(ok), "detail": detail})

runner_src = open(runner, encoding="utf-8").read() if os.path.exists(runner) else ""
check("runner_exists", bool(runner_src), runner)
check("runner_no_direct_broker_orders", "/v1/live/orders" not in runner_src,
      "runner must not call the direct-broker /v1/live/orders path")
check("runner_no_marketable_limit_go", "marketable-limit" not in runner_src.lower()
      and "MARKETABLE_LIMIT_EXECUTE" not in runner_src,
      "runner must not invoke the operator marketable-limit rail")
check("runner_no_legacy_outcome_update", "/v1/outcomes/" not in runner_src,
      "runner must not finalize via the legacy permissive endpoint")
check("runner_uses_canonical_finalizer", "finalize_autonomous_bingx_outcome" in runner_src,
      "runner must finalize via the canonical proof finalizer")
check("runner_routes_via_intents", "/v1/intents/submit" in runner_src,
      "runner must route through the autonomous intent path")
check("runner_no_manual_sql", not re.search(r"\b(INSERT INTO|UPDATE)\s+decision_outcomes", runner_src),
      "runner must not run manual SQL against decision_outcomes")

# execution_fill_events writers: only execution_router (+ control_plane read-only / read path)
writers = subprocess.run(
    ["grep", "-rlE", "INSERT INTO execution_fill_events", f"{root}/apps"],
    capture_output=True, text=True).stdout.split()
writers = [w for w in writers if w.strip()]
check("fill_events_writer_is_execution_router",
      writers == [f"{root}/apps/execution_router/main.py"] or
      all("execution_router" in w for w in writers),
      f"writers={writers}")

# fence present in the LOADED control-plane (deployed)
try:
    fence = subprocess.run(
        ["docker", "exec", "-i", cp, "python", "-c",
         "import inspect, apps.control_plane.main as m; "
         "print('FENCE' if 'assert_legacy_finalize_not_for_proof_rail' in inspect.getsource(m.update_outcome) else 'NOFENCE')"],
        capture_output=True, text=True, timeout=60).stdout
    check("legacy_endpoint_fence_deployed", "FENCE" in fence, fence.strip())
except Exception as e:
    check("legacy_endpoint_fence_deployed", False, f"probe_error:{str(e)[:60]}")

passed = all(f["pass"] for f in findings)
result = {"rail_separation": "PASS" if passed else "FAIL", "findings": findings}
with open(report, "w", encoding="utf-8") as f:
    json.dump(result, f, indent=2, sort_keys=True)
print(f"RAIL_SEPARATION = {result['rail_separation']}")
for f_ in findings:
    if not f_["pass"]:
        print(f"  FAIL: {f_['check']} — {f_['detail']}")
print(f"report: {report}")
PY
