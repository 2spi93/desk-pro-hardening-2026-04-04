# BingX Marketable Limit Protection v1 — Operator Formalization

**Status:** ✅ PROVEN on a real fill 2026-06-17T21:22 (order_id `2067357146690048000`).
**Posture after proof:** `guarded_auto`, flat, position 0, MT5 OFF. No continuation, no scaling, no auto-bot (operator close-out).

## 0. What it is / why

A single **spread-crossing LIMIT** that fills as **taker** (like MARKET) but **stays a LIMIT**, so BingX echoes the attached native TP/SL legs in the order response **and** posts them as resting conditional orders → `protection_status=armed`. This is the only single-op "filled + protected" path:

| order shape | fill | protection confirmable |
|---|---|---|
| passive LIMIT (at mid / join-best) | ❌ no fill (maker) | ✅ armed |
| MARKET direct | ✅ fill | ❌ `protection_rejected` (instant fill echoes no legs) |
| **marketable LIMIT (crossing)** | ✅ fill (taker) | ✅ **armed** |

**Architecture:** direct-broker "voie 3", **zero service-code change**. Broker `POST /v1/live/orders` already accepts `order_type=LIMIT` + numeric `protection`. No execution-AI productization (v6 has no spread-crossing action — `join_best_limit` is passive). Keeping it an operator tool, NOT an autonomous capability, is deliberate: it must not contaminate the autonomous live path.

**Scripts** (`/opt/txt/scripts/`, commits `22ba003`, `c462242`, `b365f9c`):
- `bingx_marketable_limit_probe.sh` — read-only / non-fillable validator (precheck → price → broker dry-run → optional `--probe` sub-minimal signed order).
- `bingx_marketable_limit_protect_intent.sh` — operator harness. `preview` (default) is read-only; `execute` is double-gated.

**Price source:** broker `GET /v1/orderbook/bingx/BTCUSDT` (real-time BingX public ticker, read-only, same venue).

---

## 1. Frozen parameters

These are FROZEN. Do not tune them as part of a "while we're at it" change — order structure and execution microstructure must not move together. Any change is a separate, deliberate decision with its own validation.

| param | value | notes |
|---|---|---|
| spread-cross buffer | **3 bps** | SELL limit = `best_bid·(1 − 3/1e4)`; BUY limit = `best_ask·(1 + 3/1e4)`. Hard cap `MAX_BUFFER_BPS=25`. |
| time_in_force | **IOC** | marketable remainder auto-expires; no resting maker leg left behind. |
| observe window | **8 s** | between fill and flatten. |
| notional | **7.5 USD** | `NOTIONAL_CAP=7.5` hard ceiling. BTC-USDT min ≈ 0.0001 BTC / ~6.6 USD. |
| side (default) | **sell** (SHORT) | proven side; BUY supported symmetrically. |
| symbol / account | **BTCUSDT / 29586394** | single venue, MT5 OFF. |
| protection | TP & SL native, `require_full_acceptance=true`, `working_type=MARK_PRICE` | SHORT: TP=`bid·0.99` (below), SL=`bid·1.01` (above). LONG inverse. `stopPrice` emitted as JSON **number** (`_json_number`), not string. |

---

## 2. Acceptance criteria (ALL must hold)

A real fill is VALID only if every point holds:

```
entry_order_id present
status ∈ {filled, partially_filled}
executed_qty > 0
takeProfit echoed
stopLoss echoed
protection_status = armed
open_orders @entry = 2          (the two resting TP/SL conditional orders)
position_truth ≈ executed_qty
flatten succeeds
final position = 0
final open_orders = 0
guarded_auto reverted
artifact saved + leak-clean
```

`open_orders @entry = 2` is the **strong** proof: protection legs are really posted on-venue, not merely present in a JSON echo.

Proven values (2026-06-17): marketable sell @ 64282.5 (≤ bid 64301.8) → filled taker @ 64304.1, 0.0001 BTC, armed, 2 resting legs, flattened hedge-safe → flat. Round-trip cost ~0.0054 USDT (~½ cent taker fees).

---

## 3. Artifact schema (`--print-raw`)

Written to `var/marketable_limit_captures/mlp-<mode>-<UTCstamp>.json` (**gitignored**). Sanitized, double-layer redaction (in-container before crossing the boundary + host-side).

```
{
  "mode": "execute" | "preview",
  "captured_at": "<UTC ISO>",
  "entry_request_sanitized": { symbol, side, positionSide, type, timeInForce,
                               price, quantity, notional, takeProfit, stopLoss,
                               clientOrderId },          # secret_payload stripped
  "entry_response_raw":  { order_id, status, avg_fill_price, filled_notional_usd,
                           fills[], protection{accepted{take_profit,stop_loss}},
                           raw_order{...} },             # execute only
  "post_entry_checks":   { protection_status, position_truth[], open_orders,
                           balance_before, balance_after, orderbook_snapshot_used },
  "final_state":         { open_positions, open_orders, flat }   # execute only
}
```

**Never written** (redacted to `<redacted>`): `api_key`, `apikey`, `api_secret`, `secret`, `secret_payload`, `signature`, `sign`, `x-bx-apikey`, `authorization`, `cookie`, `token`, `access_token`, `password`, `signed_url`, `url`. The HMAC signing stays internal to `_bingx_signed_request`; the signed URL is never captured. Verified vs planted secrets → zero leak.

---

## 4. Emergency stop

- **In-harness:** an `EXIT` trap ALWAYS flattens any residual position (hedge-safe) and reverts `guarded_auto`, on any error or abort.
- **Hedge-safe flatten:** close a SHORT with `BUY positionSide=SHORT` MARKET, **no `reduceOnly`** (hedge mode rejects `reduceOnly`). LONG: `SELL positionSide=LONG`.
- **Manual flatten:** `POST /v1/connectors/bingx/flatten` with `confirmation_text=BINGX_FLATTEN` (supports `dry_run`).
- **Kill switch:** `POST /v1/system/kill-switch/activate` / `/reset` (control-plane).
- **Mode:** `POST /v1/system/mode {"mode":"guarded_auto"}` (operator auth) to exit `managed_live`.

STOP conditions (any → abort + flatten + revert): signature mismatch · float64 type mismatch · TP/SL absent (`protection != armed`) · order not traced (no order_id) · position truth diverges · kill_switch · unknown fill state.

---

## 5. Risk-budget reset policy

- risk-gateway holds an **in-memory preview budget** (default **30 USD/day**, `BTCUSDT` exposure tracked). Each `accept` on `/v1/checks/pre-trade` adds the intent notional (7.5). A few aborted/preview attempts saturate it → next check returns `reject: daily_notional_limit_exceeded`.
- This budget is **phantom**: it tracks preview/check intents, NOT real fills. Real exposure and capital are independent (a saturated budget with `open_positions=0` and capital intact = phantom, safe to reset).
- **Reset = `docker compose restart risk-gateway`** → `daily_notional_used_usd` → 0. Non-trading, sanctioned (smoke scripts expose `--reset-risk-gateway-if-needed`).
- **Reset requires explicit operator authorization** — it clears a risk control's counter; never auto-reset to push an order through. Confirm real exposure is 0 and capital intact first.

---

## 6. No-retry rule

If **any** acceptance criterion (§2) breaks: **abort → flatten hedge-safe → revert `guarded_auto` → save the artifact → STOP. No automatic retry.** Investigate from the saved artifact + logs; a new attempt requires a fresh, explicit operator GO. (The two harness bugs found during the first GO — risk-gateway `accept`/`reject` literal, and the docker-internal `CONTROL_PLANE_URL` — each produced a *safe pre-order abort*, were fixed, then re-validated; that is the pattern: stop, diagnose, fix, re-GO — never blind retry.)

---

## 7. Promotion path → micro-live v2

Strictly gated; each step is its own operator decision, none implied by v1 success:

1. **Repeatability:** N operator-gated marketable-limit round-trips (same frozen params), each meeting §2, artifacts retained — before any automation.
2. **Clean-cycles:** tie promotion to the existing clean-cycle accrual (3/3) + opportunity-gate `go`, not to a fill count.
3. **Notional ramp:** only after repeatability, raise the cap deliberately (7.5 → pilot stage), one variable at a time.
4. **Autonomy (last):** only then consider exposing a marketable/aggressive action in execution-AI v6 — and only behind a managed_live + per-order live flag, never as a default route. This is the step most likely to "contaminate the live path"; treat it as the highest-bar change.
5. **MT5 / multi-venue:** out of scope for v2; MT5 stays OFF until TXT passes a clean gate on its own.

---

### Run reference

```bash
# read-only validation (safe, repeatable)
bash scripts/bingx_marketable_limit_probe.sh --side sell --probe

# operator preview (read-only, prints 10-point plan + sanitized capture)
bash scripts/bingx_marketable_limit_protect_intent.sh preview --side sell --print-raw

# REAL order — separate explicit operator GO only
bash scripts/bingx_marketable_limit_protect_intent.sh execute --side sell \
  --confirm-live MARKETABLE_LIMIT_EXECUTE --go --print-raw
```
