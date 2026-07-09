#!/usr/bin/env python3
"""Shadow replay of the financial-truth finalizer over historical proof cycles.

FINANCIAL-TRUTH-ENGINE-001 steps 7-8 (cold, read-only on the DB). For each
finalized BingX proof cycle it reconciles the canonical fills with the BingX
income ledger (capital_flow_events) via proof_financial_truth, writes a
financial_truth artifact, and compares the derived net to the OLD finalizer's
decision_outcomes (fees_usd / net_result_usd). Places no order, changes no live
state, mutates no existing outcome — additive artifacts only.
"""
from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path("/opt/txt")
OUT_DIR = ROOT / "var" / "proof_renewal" / "financial_truth"
CONTAINER = "control-plane"
SYMBOLS = ("BTC-USDT", "BTCUSDT")


def _load_engine():
    spec = importlib.util.spec_from_file_location("proof_financial_truth", ROOT / "scripts" / "proof_financial_truth.py")
    m = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = m
    spec.loader.exec_module(m)
    return m


DB_QUERY = r'''
import json, os
from pathlib import Path
import psycopg
from psycopg.rows import dict_row
def dburl():
    v=os.environ.get("DATABASE_URL")
    if v: return v
    for c in (Path("/run/secrets/database_url"), Path("/workspace/secrets/database_url")):
        if c.exists(): return c.read_text().strip()
    raise RuntimeError("no db url")
out={"cycles":[], "ledger_synced_through": None}
with psycopg.connect(dburl(), row_factory=dict_row) as cn, cn.cursor() as cur:
    # ledger freshness = when the income sync last RAN successfully (advances even
    # when no new events), from the audit trail — NOT max(event occurred_at),
    # which stalls once the account goes flat.
    cur.execute("select max(created_at) as m from audit_events where category='bingx_account_state_synced'")
    m=cur.fetchone()["m"]; out["ledger_synced_through"]= m.isoformat() if m else None
    cur.execute("""select substring(decision_id from '^(.*)-(entry|exit)$') as cyc from execution_fill_events
                   where fill_type='live-broker' and venue='bingx'
                   and decision_id in (select decision_id from decision_outcomes where provider='bingx' and status='finalized')
                   group by cyc""")
    cyc_ids=[r["cyc"] for r in cur.fetchall() if r["cyc"]]
    for cyc in cyc_ids:
        cur.execute("""select decision_id, side, notional_usd, filled_at
                       from execution_fill_events where decision_id like %s and fill_type='live-broker' order by filled_at""", (cyc+'%',))
        legs=[dict(r) for r in cur.fetchall()]
        if not legs: continue
        first=min(l["filled_at"] for l in legs); last=max(l["filled_at"] for l in legs)
        # income settlement events land AFTER the fills (observed ~30-70s), so the
        # window extends forward past the last fill (and slightly back).
        from datetime import timedelta as _td
        cur.execute("""select event_type, amount_usd, occurred_at, description, external_event_id
                       from capital_flow_events
                       where source='bingx-income-history' and asset_symbol = ANY(%s)
                       and occurred_at between %s and %s order by occurred_at""",
                    (list(("BTC-USDT","BTCUSDT")), first - _td(minutes=5), last + _td(minutes=10)))
        income=[dict(r) for r in cur.fetchall()]
        # old finalizer figures
        cur.execute("select fees_usd, net_result_usd, slippage_real_bps from decision_outcomes where decision_id like %s limit 1", (cyc+'-entry',))
        old=cur.fetchone() or {}
        out["cycles"].append({"cycle_id":cyc,"legs":legs,"income":income,"old":old})
print(json.dumps(out, default=str))
'''


def _fetch() -> dict:
    r = subprocess.run(["docker", "exec", "-i", CONTAINER, "python3", "-c", DB_QUERY],
                       check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=120)
    return json.loads(r.stdout)


def _dt(v):
    return datetime.fromisoformat(str(v).replace("Z", "+00:00"))


def main() -> int:
    eng = _load_engine()
    data = _fetch()
    now = datetime.now(timezone.utc)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    ledger_through = _dt(data["ledger_synced_through"]) if data.get("ledger_synced_through") else None
    summary = []
    for c in data["cycles"]:
        legs = [eng.Leg(l["decision_id"], str(l["side"]), float(l["notional_usd"] or 0), _dt(l["filled_at"])) for l in c["legs"]]
        income = [eng.IncomeEvent(str(e["event_type"]), float(e["amount_usd"] or 0), _dt(e["occurred_at"]), str(e.get("description") or ""), str(e.get("external_event_id") or "")) for e in c["income"]]
        truth = eng.reconcile_cycle_financials(
            cycle_id=c["cycle_id"], legs=legs, income_events=income,
            ledger_synced_through=ledger_through, now=now,
        )
        old = c.get("old") or {}
        truth["old_finalizer"] = {
            "fees_usd": old.get("fees_usd"),
            "net_result_usd": old.get("net_result_usd"),
            "slippage_real_bps": old.get("slippage_real_bps"),
        }
        truth["comparison"] = {
            "old_net": old.get("net_result_usd"),
            "new_net": truth["net_result_usd"],
            "old_fees": old.get("fees_usd"),
            "new_fees": truth["trading_fees_usd"],
            "old_understated_costs": (float(old.get("fees_usd") or 0.0) == 0.0 and truth["trading_fees_usd"] != 0.0),
        }
        path = OUT_DIR / f"{c['cycle_id']}.financial_truth.json"
        path.write_text(json.dumps(truth, indent=2, sort_keys=True), encoding="utf-8")
        summary.append(truth)
        print(f"{c['cycle_id']:32s} net={truth['net_result_usd']:+.6f} "
              f"fees={truth['trading_fees_usd']:+.6f} funding={truth['financial_truth']['funding_usd']:<14s} "
              f"not_actual={truth['financial_truth_not_actual']} old_net={old.get('net_result_usd')} old_fees={old.get('fees_usd')}")
    (OUT_DIR / "replay_summary.json").write_text(json.dumps({"generated_at": now.isoformat(), "cycles": summary}, indent=2, sort_keys=True, default=str), encoding="utf-8")
    financially_actual = sum(1 for t in summary if not t["financial_truth_not_actual"])
    print(f"\ncertified_operational_outcomes={len(summary)}  financially_actual_outcomes={financially_actual}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
