# TXT — Proof-Renewal Cold Finish Report (PORTE 1)

**2026-06-18. Everything cold delivered. No market, no order, no real finalization, no restart.**
System unchanged: `guarded_auto · flat · position 0 · open_orders 0 · kill false · MT5 OFF`.

## What was built (one cold package)

| Item | Deliverable | Status |
|---|---|---|
| D1 deterministic fill | `apps/execution_router/proof_order_shape.py` + wiring (action block ~3821) + `control_plane` marker forwarding (both routed payloads) | ✅ MARKET taker forced for proof cycles; passive-LIMIT/over-cap/direct-broker refused |
| D3 measurement window | `proof_finalizer.require_round_trip` + `SPEC_D3_MEASUREMENT_WINDOW.md` | ✅ refuses entry-only; exit fill via second routed flatten intent |
| D2 wiring | runner finalizes only via `finalize_autonomous_bingx_outcome` | ✅ never `/v1/outcomes`, never SQL |
| Runner | `scripts/bingx_autonomous_proof_renewal_v1.sh` | ✅ readiness default; execute double-gated |
| Readiness check | `scripts/bingx_proof_cycle_readiness_check.sh` → `readiness_report.json` | ✅ `READY_FOR_DEDICATED_GO=true`, `NO_MARKET_ACTION=true` |
| Rail audit | `scripts/bingx_rail_separation_audit.sh` → `rail_separation_audit.json` | ✅ `RAIL_SEPARATION=PASS` |
| Specs | `SPEC_D1_DETERMINISTIC_FILL.md`, `SPEC_D3_MEASUREMENT_WINDOW.md` | ✅ |

## Tests

```
tests/test_proof_renewal_order_shape.py   (D1)            11
tests/test_proof_finalizer.py             (D2 + D3)       12
tests/test_outcome_update_fence.py        (fence)          6
tests/test_proof_cycle_wiring.py          (rail-sep)       9
TOTAL                                                     38 passed
```
Read-only smoke: `readiness_report.json` READY=true; `rail_separation_audit.json` PASS; runner readiness prints plan, places no order, changes no mode; execute gate blocks without the dedicated phrase.

## Commit chain (proof rail)

```
doctrine     548e38e   3-rail doctrine
cycle spec   849244f   proof-renewal cycle spec
D2 spec      2067496   finalization contract
D2 impl      9efbb49   evidence-derived finalizer + tests
D2 fence     1080e70   legacy endpoint fenced
fence deploy (restart, live)
D1+D3+runner 6d85fad   PORTE 1 cold finish
```

## Remaining before the first cycle (each a separate explicit step)

1. **Deploy D1** — control-plane **and** execution-router restart to load the new code (like the fence deploy; a prod op, operator word required). Until then D1/marker-forwarding live only on disk.
2. **PORTE 2 — first cycle** — the single live boundary, behind the dedicated phrase only:
   ```
   GO renew BingX autonomous proof side=sell
   ```
   → one cycle, `notional ≤ 7.5`, one attempt, no retry, mandatory flatten, abort on first break, artifacts kept, **no automatic promotion**. A bare GO / `clean_cycles 3/3` / `gate=go` never trigger it.
3. **Post-cycle proof-renewal audit** — fresh `execution_fill_events` live-broker/bingx + `decision_outcomes` finalized provider=bingx/source=intent + `reality_gap_samples`; flat; rails intact.
4. **Mechanical promotion gate** (later) — ≥3 fresh cycles, all flat, all finalized, zero rail violations.

## Doctrine held

Rails separated (operator direct-broker / legacy MT5 / autonomous BingX-native); no merge, no backfill, no operator fill in `execution_fill_events`; finalization only from measured persisted reality; the live boundary stays behind a dedicated, unambiguous GO phrase.
