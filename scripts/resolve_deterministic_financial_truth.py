#!/usr/bin/env python3
"""Deterministic financial-truth resolver — FINANCIAL-TRUTH-ENGINE-001 step 5/bridge.

For each finalized BingX proof cycle, resolve the venue truth DETERMINISTICALLY:
  cycle_id -> clientOrderId (txt-proofcyc-<cycle>-<leg>) -> BingX order query
  -> {orderId, commission, profit}
attributed to the cycle by the clientOrderId (which embeds cycle+leg). Then
cross-check the order-level net against the income ledger net (independent
source) to VERIFY that REALIZED_PNL is gross of commission (net =
profit + commission). Writes a deterministic financial_truth artifact.

READ-ONLY: signed BingX GET (order query) only — NO order placement, NO mutation
of existing outcomes, NO live arming. Runs the signed calls inside the
control-plane container via a here-doc.
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
ACCOUNT_ID = "29586394"
SWAP = "BTC-USDT"


def _load_engine():
    spec = importlib.util.spec_from_file_location("proof_financial_truth", ROOT / "scripts" / "proof_financial_truth.py")
    m = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = m
    spec.loader.exec_module(m)
    return m


# In-container: list cycles + income-ledger net per cycle, then signed order query
# per leg by clientOrderId. Read-only.
CONTAINER_CODE = r'''
import asyncio, json, os
from pathlib import Path
import psycopg
from psycopg.rows import dict_row
import apps.control_plane.main as cp
def dburl():
    v=os.environ.get("DATABASE_URL")
    if v: return v
    for c in (Path("/run/secrets/database_url"), Path("/workspace/secrets/database_url")):
        if c.exists(): return c.read_text().strip()
    raise RuntimeError("no db url")
ACCT="__ACCT__"; SWAP="__SWAP__"
async def run():
    out={"cycles":[]}
    with psycopg.connect(dburl(), row_factory=dict_row) as cn, cn.cursor() as cur:
        cur.execute("""select substring(decision_id from '^(.*)-(entry|exit)$') as cyc
                       from execution_fill_events where fill_type='live-broker' and venue='bingx'
                       and decision_id in (select decision_id from decision_outcomes where provider='bingx' and status='finalized')
                       group by cyc""")
        cycs=[r["cyc"] for r in cur.fetchall() if r["cyc"]]
        _, sp = cp._bingx_secret_payload_for_account(ACCT, require_trade=False)
        for cyc in cycs:
            cur.execute("""select decision_id, side, filled_at from execution_fill_events
                           where decision_id like %s and fill_type='live-broker' order by filled_at""",(cyc+'%',))
            legfills=[dict(r) for r in cur.fetchall()]
            first=min(l["filled_at"] for l in legfills); last=max(l["filled_at"] for l in legfills)
            cur.execute("""select coalesce(sum(amount_usd),0) as net from capital_flow_events
                           where source='bingx-income-history' and asset_symbol = ANY(%s)
                           and event_type in ('trading_fee','realized_pnl','funding_fee')
                           and occurred_at between %s and %s""",
                        (['BTC-USDT','BTCUSDT'], first - __import__('datetime').timedelta(minutes=5), last + __import__('datetime').timedelta(minutes=10)))
            ledger_net=float(cur.fetchone()["net"])
            legs=[]
            for lf in legfills:
                did=lf["decision_id"]; leg='entry' if did.endswith('-entry') else 'exit'
                coid=('txt-'+cyc+'-'+leg).lower()
                import hashlib
                try:
                    r=await cp._bingx_signed_get(sp,'/openApi/swap/v2/trade/order',{'symbol':SWAP,'clientOrderId':coid})
                    o=r.get('order') if isinstance(r,dict) else {}
                except Exception as e:
                    o={"error":str(e)[:100]}
                raw_hash=hashlib.sha256(json.dumps(o,sort_keys=True,default=str).encode()).hexdigest()
                legs.append({"decision_id":did,"leg":leg,"client_order_id":coid,"order_id":str(o.get("orderId") or ""),
                             "commission_usd":float(o.get("commission") or 0),"commission_asset":"USDT",
                             "profit_usd":float(o.get("profit") or 0),"executed_qty":str(o.get("executedQty") or ""),
                             "avg_price":str(o.get("avgPrice") or ""),"order_status":str(o.get("status") or ""),
                             "venue_updated_at_ms":int(o.get("updateTime") or 0),
                             "filled_at":lf["filled_at"].isoformat(),"resolved":bool(o.get("orderId")),
                             "raw_payload_hash":raw_hash,"source_endpoint":"/openApi/swap/v2/trade/order?clientOrderId"})
            out["cycles"].append({"cycle_id":cyc,"open_at":first.isoformat(),"close_at":last.isoformat(),
                                  "ledger_net_usd":ledger_net,"legs":legs})
    print(json.dumps(out, default=str))
asyncio.run(run())
'''.replace("__ACCT__", ACCOUNT_ID).replace("__SWAP__", SWAP)


def _fetch() -> dict:
    r = subprocess.run(["docker", "exec", "-i", CONTAINER, "python3", "-c", CONTAINER_CODE],
                       check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=180)
    return json.loads(r.stdout)


def _dt(v):
    return datetime.fromisoformat(str(v).replace("Z", "+00:00"))


ORDER_LEVEL_LEDGER = OUT_DIR / "order_level_truth.jsonl"


def _persist_order_level(cycle: dict, now: datetime) -> int:
    """Append-only durable persistence of the venue order-level truth, so it is
    captured BEFORE BingX history queries may stop returning old orders. Deduped
    by (cycle_id, leg, order_id)."""
    seen = set()
    if ORDER_LEVEL_LEDGER.exists():
        for line in ORDER_LEVEL_LEDGER.read_text(encoding="utf-8").splitlines():
            try:
                r = json.loads(line)
                seen.add((r.get("cycle_id"), r.get("leg"), r.get("order_id")))
            except json.JSONDecodeError:
                continue
    written = 0
    with ORDER_LEVEL_LEDGER.open("a", encoding="utf-8") as fh:
        for leg in cycle["legs"]:
            if not leg.get("resolved"):
                continue
            key = (cycle["cycle_id"], leg.get("leg"), leg.get("order_id"))
            if key in seen:
                continue
            rec = {"schema": "txt.order-level-financial-truth.v1", "cycle_id": cycle["cycle_id"],
                   "retrieved_at": now.isoformat(), **leg}
            fh.write(json.dumps(rec, sort_keys=True, default=str) + "\n")
            seen.add(key)
            written += 1
    return written


def main() -> int:
    eng = _load_engine()
    data = _fetch()
    now = datetime.now(timezone.utc)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    summary = []
    total_persisted = 0
    for c in data["cycles"]:
        unresolved = [l for l in c["legs"] if not l.get("resolved")]
        leg_costs = [eng.LegVenueCost(l["decision_id"], l["order_id"], l["client_order_id"],
                                      float(l["commission_usd"]), float(l["profit_usd"]), _dt(l["filled_at"])) for l in c["legs"]]
        truth = eng.reconcile_deterministic(
            cycle_id=c["cycle_id"], leg_costs=leg_costs, open_at=_dt(c["open_at"]), close_at=_dt(c["close_at"]),
            ledger_synced_through=now, now=now,
            income_cross_check_net_usd=float(c["ledger_net_usd"]),
        )
        truth["unresolved_legs"] = len(unresolved)
        if unresolved:
            truth["reconciled_actual"] = False
            truth["financial_truth_not_actual"] = True
            truth["attribution"] = "DETERMINISTIC_INCOMPLETE"
        total_persisted += _persist_order_level(c, now)
        path = OUT_DIR / f"{c['cycle_id']}.deterministic.json"
        path.write_text(json.dumps(truth, indent=2, sort_keys=True, default=str), encoding="utf-8")
        summary.append(truth)
        print(f"{c['cycle_id']:32s} net={truth['net_result_usd']:+.6f} attr={truth['attribution']:<24s} "
              f"order_level_actual={truth.get('order_level_actual')} xcheck={truth['independent_cross_check']:<9s} "
              f"reconciled_actual={truth['reconciled_actual']}")
    (OUT_DIR / "deterministic_summary.json").write_text(json.dumps({"generated_at": now.isoformat(), "cycles": summary}, indent=2, sort_keys=True, default=str), encoding="utf-8")
    ra = sum(1 for t in summary if t["reconciled_actual"])
    ola = sum(1 for t in summary if t.get("order_level_actual"))
    print(f"\norder_level_actual={ola}/{len(summary)}  cross_verified(reconciled_actual)={ra}/{len(summary)}  persisted_new_records={total_persisted}")
    print(f"durable ledger: {ORDER_LEVEL_LEDGER}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
