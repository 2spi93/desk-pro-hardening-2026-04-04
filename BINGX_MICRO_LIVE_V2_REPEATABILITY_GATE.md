# TXT — Micro-live v2 Repeatability Gate

Cold-path follow-up to **[BINGX_MARKETABLE_LIMIT_PROTECTION_V1.md](BINGX_MARKETABLE_LIMIT_PROTECTION_V1.md)**.
Turns the single proven v1 fill into a **repeatable, measurable, promotable** protocol — **without changing any execution parameter and without launching a trade by default.**

**Expected start state (every run):** `guarded_auto` · position 0 · open_orders 0 · kill_switch false · MT5 OFF · BingX ON · no watcher · no latent GO.

## Frozen invariants (unchanged from v1 — do NOT touch in this task)

`buffer 3 bps` · `IOC` · `observe 8s` · `notional 7.5 USDT` · mandatory flatten · mandatory EXIT trap · mandatory risk-gateway pre-trade · mandatory `--print-raw` sanitized audit · **no-retry rule** · **no real order without a dedicated explicit phrase**.

---

## 1. Repeatability protocol

A **clean run** = a real round-trip whose audit artifact passes ALL ten checks (enforced by `bingx_marketable_limit_repeatability_report.sh`):

```
status ∈ {filled, partially_filled}      executed_qty > 0
takeProfit echoed                         stopLoss echoed
protection_status = armed                 open_orders @entry = 2
position_truth ≈ executed_qty             final_flat = true
final_open_orders = 0                      audit_clean (no secret/signature in file)
```

**Gate to clear:** **5 consecutive clean runs**, with:
- **both sides covered** — ≥1 clean `sell` (SHORT) **and** ≥1 clean `buy` (LONG); the marketable cross is symmetric and must be proven both directions.
- **distributed, not bursted** — across ≥2 distinct sessions (not 5 back-to-back in one minute).
- **only under green conditions** — opportunity-gate `go`, kill_switch false, liquid hours, fresh (non-stale) market data.

**Stop windows (do NOT run):** gate ≠ `go` · kill latch active · degraded observability · illiquid/stale-data window · risk-budget needs a reset that the operator hasn't authorized.

**Streak rule:** any non-clean run **resets the consecutive counter to 0** (no-retry, §6). The campaign is the *consecutive* tail, not the lifetime total.

---

## 2. Risk-budget reset policy

- risk-gateway holds an **in-memory preview budget** (default 30 USDT/day). Each pre-trade `accept` consumes the intent notional (7.5) → ~4 attempts saturate it → `reject: daily_notional_limit_exceeded`.
- This budget is **phantom** (tracks preview/check intents, not real fills). A saturated budget with `open_positions=0` and capital intact is safe to reset.
- **Reset = `docker compose restart risk-gateway`** (→ used = 0). **Only on explicit operator validation, and only after confirming real exposure = 0 and capital intact.** Never auto-reset to push a run through.
- **Log every reset** into the campaign record: timestamp, who authorized, used-before, real-exposure-confirmed-zero. A reset is an event, not routine.

---

## 3. Artifact aggregation

Tool: **`scripts/bingx_marketable_limit_repeatability_report.sh`** (read-only; no order, no venue call, no parameter change). It globs `var/marketable_limit_captures/mlp-execute-*.json` and emits the per-run table + campaign roll-up. Per-run fields extracted:

```
captured_at · side · order_id · status · executed_qty · avg_fill_price
price_improvement_bps (avg vs marketable-limit floor)
protection_status · open_orders@entry · cost_usdt (balance_before − after)
flatten_latency_ms (if instrumented) · final_flat · ten clean-checks · clean?
```

Roll-up: total runs · clean total · **consecutive clean / threshold** · clean sides covered · total cost · all-audit-clean · flatten-latency-instrumented · **promotion gate verdict + blocker list**. Artifacts are already sanitized; the report **re-scans each file** for secret keys / 64-hex (signature-like) values as an independent audit-cleanliness check.

---

## 4. Promotion blockers (→ micro-live v2)

Promotion review is BLOCKED while any of:
- consecutive clean runs < 5;
- any non-clean run in the current streak;
- buy side not yet validated clean (only sell proven);
- flatten latency not instrumented in the capture (see §6 pre-step);
- opportunity-gate ≠ `go` / kill latch / clean_cycles < 3/3;
- any artifact missing or failing the leak re-scan;
- risk-budget reset used without logged operator authorization;
- MT5 not OFF, or any frozen parameter changed.

Clearing the gate authorizes a **PROMOTION REVIEW (human decision) only** — never an automatic notional increase or autonomy.

---

## 5. Live order stays behind an explicit phrase

A bare **"GO" is never a real-order trigger.** A real order requires the dedicated unambiguous phrase, e.g. **`GO execute BingX marketable-limit protected side=sell`** (or `side=buy`). Anything ambiguous → doc/analysis or clarify, never a live order. (See memory `go-disambiguation-protocol`.)

---

## 6. Repeatability report metrics

The report surfaces, per run and in aggregate:
- **fill quality** — status, executed vs requested qty, avg fill vs marketable floor (`price_improvement_bps`), partial-fill flag;
- **protection armed** — `protection_status`, TP & SL echoed, `open_orders@entry = 2` (legs really resting on-venue);
- **flatten latency** — time from fill to position=0. **v1 capture does not record this.** Pre-campaign instrumentation step (additive, audit-only, NOT a parameter change): record `flatten_latency_ms` in the `--print-raw` capture (fill `filled_at` → flatten-confirmed time). Until then the report shows `n/a` and lists it as a blocker.
- **residual state** — final position 0, final open_orders 0, guarded_auto reverted;
- **audit cleanliness** — independent leak re-scan of each artifact (no api_key/secret/signature).

---

## 7. Promotion rule

**No notional increase, and no autonomy, until multiple clean v1 runs are banked** (the §1 gate). Then promotion proceeds **one variable at a time**: first repeatability (frozen params) → then a deliberate single notional step (7.5 → pilot) → only much later consider an execution-AI marketable action, behind managed_live + per-order live flag, never as a default route. MT5 stays OFF throughout.

---

## Acceptance criteria for THIS (cold) task
- ✅ no live order launched · ✅ no v1 parameter changed · ✅ clear repeatability protocol documented · ✅ explicit v2 blocker list · ✅ live path still gated by explicit confirmation · ✅ `--print-raw` artifacts aggregated without secrets · ✅ no-retry rule preserved · ✅ MT5 stays OFF.

### References
`BINGX_MARKETABLE_LIMIT_PROTECTION_V1.md` · `scripts/bingx_marketable_limit_protect_intent.sh` · `scripts/bingx_marketable_limit_repeatability_report.sh` · commits `22ba003`, `c462242`, `b365f9c`, `db96ce1`.
