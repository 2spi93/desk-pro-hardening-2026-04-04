#!/usr/bin/env python3
"""Persist canonical runtime evidence of income pagination — FTE-001 phase-2.

Runs the DEPLOYED anti-saturation collector against a saturated window and
persists a CANONICAL, reproducible evidence record (not an ephemeral operator
observation) so the economic gate can gate `pagination_runtime_verified` on it.

Honest scope: this proves the deployed bisection RUNS and recovers a saturated
window completely — it does NOT claim a historical event loss occurred (the
production path already sliced history into 7-day windows).

Read/behaviour: signed read-only order/income GETs + a single append-only INSERT
into capital_flow_pagination_evidence (self-creating). No order, no mode change,
no posture change.
"""
from __future__ import annotations

import subprocess
import sys

CONTAINER = "control-plane"
ACCOUNT_ID = "29586394"


def _deployed_commit() -> str:
    try:
        return subprocess.run(["git", "-C", "/opt/txt", "rev-parse", "--short", "HEAD"],
                              capture_output=True, text=True, timeout=10).stdout.strip()
    except Exception:
        return "unknown"


CODE = r'''
import asyncio, json, hashlib, os
from datetime import datetime, timezone, timedelta
from pathlib import Path
import psycopg
import apps.control_plane.main as cp
def dburl():
    v=os.environ.get("DATABASE_URL")
    if v: return v
    for c in (Path("/run/secrets/database_url"), Path("/workspace/secrets/database_url")):
        if c.exists(): return c.read_text().strip()
DEPLOYED="__COMMIT__"; ACCT="__ACCT__"
async def run():
    _, sp = cp._bingx_secret_payload_for_account(ACCT, require_trade=False)
    end = datetime.now(timezone.utc)
    start = end - timedelta(days=95)
    items, cov = await cp._bingx_income_collect_bisect(sp, start, end)
    ids = sorted(str(cp._bingx_income_event_key(v)) for v in items.values())
    digest = hashlib.sha256("|".join(ids).encode()).hexdigest()
    ev = {
      "range_start": start.isoformat(), "range_end": end.isoformat(),
      "events_fetched": len(items), "slice_count": cov["slice_count"],
      "saturation_detected": len(cov["saturation_unresolved"])>0 or cov["slice_count"]>1,
      "saturation_unresolved": len(cov["saturation_unresolved"]),
      "coverage_complete": bool(cov["complete"]), "response_digest": digest,
      "deployed_commit": DEPLOYED, "verified_at": datetime.now(timezone.utc).isoformat(),
      "fetch_error": cov["fetch_error"],
    }
    with psycopg.connect(dburl()) as cn, cn.cursor() as cur:
        cur.execute("""CREATE TABLE IF NOT EXISTS capital_flow_pagination_evidence (
            id BIGSERIAL PRIMARY KEY, provider TEXT, range_start TIMESTAMPTZ, range_end TIMESTAMPTZ,
            events_fetched INTEGER, slice_count INTEGER, saturation_detected BOOLEAN,
            saturation_unresolved INTEGER, coverage_complete BOOLEAN, response_digest TEXT,
            deployed_commit TEXT, verified_at TIMESTAMPTZ, fetch_error TEXT, created_at TIMESTAMPTZ DEFAULT now())""")
        cur.execute("""INSERT INTO capital_flow_pagination_evidence
            (provider, range_start, range_end, events_fetched, slice_count, saturation_detected,
             saturation_unresolved, coverage_complete, response_digest, deployed_commit, verified_at, fetch_error)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
            ("bingx", ev["range_start"], ev["range_end"], ev["events_fetched"], ev["slice_count"],
             ev["saturation_detected"], ev["saturation_unresolved"], ev["coverage_complete"],
             ev["response_digest"], ev["deployed_commit"], ev["verified_at"], ev["fetch_error"]))
        cn.commit()
    print(json.dumps(ev))
asyncio.run(run())
'''


def main() -> int:
    code = CODE.replace("__COMMIT__", _deployed_commit()).replace("__ACCT__", ACCOUNT_ID)
    res = subprocess.run(["docker", "exec", "-i", CONTAINER, "python3", "-c", code],
                         capture_output=True, text=True, timeout=180)
    if res.returncode != 0:
        sys.stderr.write(res.stderr[-500:])
        return 1
    print(res.stdout.strip())
    return 0


if __name__ == "__main__":
    sys.exit(main())
