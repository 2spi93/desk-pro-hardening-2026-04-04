# SPEC — D2: canonical outcome finalization wiring

**Cold design only. Trades nothing. No market, no dry-run, no live, no merge, no backfill, no manual SQL.**
Prerequisite for [SPEC_AUTONOMOUS_PROOF_RENEWAL_CYCLE_V1.md](SPEC_AUTONOMOUS_PROOF_RENEWAL_CYCLE_V1.md) (design decision D2). Parent doctrine: [TXT_AUTONOMOUS_PROOF_DOCTRINE_BINGX_NATIVE.md](TXT_AUTONOMOUS_PROOF_DOCTRINE_BINGX_NATIVE.md). Drafted 2026-06-18.

## 0. Current wiring (read-only findings)

- **Canonical writer exists:** `POST /v1/outcomes/{decision_id}/update` (`apps/control_plane/main.py:22734`, `operator_auth`). UPSERT into `decision_outcomes` (`ON CONFLICT (decision_id) DO UPDATE`), `status` defaults to **`"finalized"`**, and **PnL/slippage/fees/net_result are taken from the CALLER payload**.
- **This is effectively a "magic finalize button":** it trusts caller-supplied numbers and finalizes by default. Using it directly for autonomous proof would be a truth-debt.
- **Measurement exists but is unwired:** `scripts/label_intent_outcomes.py` measures pnl/slippage from `execution_fill_events` → `market_ohlcv`, but is **explicitly read-only** (writes `intent_outcome_labels.jsonl`, does NOT mutate `decision_outcomes`).
- **Result:** autonomous BingX intents are inserted `status='pending'` (11 rows, `provider=bingx source=intent`, last 2026-06-17) and **nothing measures→finalizes them**. The only `finalized` rows are MT5 (March), whose own finalization wiring existed.

**D2 gap = there is no measured-from-evidence finalizer for the autonomous rail.** D2 must add a finalization **contract**, not reuse the magic button.

## 1. Canonical fill source of truth

The single truth that a fill happened = a row in **`execution_fill_events`** with:
```
decision_id = <cycle decision_id>     fill_type = 'live-broker'     venue = 'bingx'
```
written by `execution_router` on the autonomous path. No fill row ⇒ no finalization (§7). Correlation is by `decision_id` (and `fill_id`); never by operator assertion.

## 2. Finalization trigger (all required)

Finalization may fire ONLY when ALL hold:
```
1. canonical fill row present (§1)
2. post-entry checks pass (position_truth matched the fill at entry)
3. flatten evidence present (position closed → 0) + revert evidence (guarded_auto)
4. measured outcome available — pnl/slippage/fees derived from persisted reality:
     execution_fill_events (entry+exit prices, qty, fees) + execution_telemetry
     (realized_slippage_bps, latency) + the labeler measurement basis
```
The outcome numbers are **computed from persisted evidence**, never supplied by a human caller.

## 3. Forbid manual SQL

No direct `UPDATE`/`INSERT` on `decision_outcomes` by an operator or ad-hoc script. Finalization happens only through the controlled system path (§4). Manual SQL on the proof tables is a doctrine violation (truth-debt).

## 4. System path (controlled, not the magic button)

Add a **dedicated server-side finalizer** (e.g. an internal `finalize_autonomous_proof_outcome(decision_id)` invoked by the proof-renewal cycle, or a hardened variant of the existing endpoint) that:
- READS the canonical evidence (§1, §2) itself — it does NOT accept caller-supplied pnl/status;
- DERIVES pnl_5m/pnl_1h/slippage_real_bps/fees_usd/net_result_usd from that evidence;
- WRITES via the canonical upsert with `status='finalized'`, `source='intent'`, `provider='bingx'`;
- REFUSES (does not write) if any §2 condition fails.
The existing `/v1/outcomes/{decision_id}/update` magic path must be **fenced off** from the proof rail (kept for legacy/manual use, but the autonomous cycle never calls it with caller-supplied numbers).

## 5. Idempotence

```
same intent (decision_id) → same finalized outcome, exactly once.
```
`ON CONFLICT (decision_id) DO UPDATE` gives upsert; on top, the finalizer must be a **no-op if already finalized from the same evidence** (re-run is safe), and must **refuse to overwrite** a finalized outcome with different/looser evidence. No double-finalize, no silent re-write.

## 6. Audit trail (mandatory on every finalization)

```
previous_status = pending
next_status     = finalized
reason          = autonomous_proof_renewal_cycle_v1
finalizer       = <component id>            (not a human)
evidence_refs   = [ execution_fill_events.fill_id,
                    flatten_order_id,
                    reality_gap_samples.sample_id,
                    execution_telemetry ref ]
measurement_basis = <ohlcv window / immediate-close, per cycle D3>
```
Persisted into `decision_outcomes.metadata` (and/or an audit_events row), so any finalization is fully traceable to the evidence that justified it.

## 7. Tests (acceptance)

```
pending → finalized (happy path)   : real fill + flatten + measured outcome ⇒ finalized, audited
missing fill                        : no execution_fill_events row ⇒ REFUSE (stays pending)
direct-broker evidence              : fill not on autonomous rail / not persisted ⇒ REFUSE
duplicate finalize                  : second call, same evidence ⇒ NO-OP (no change)
rail mismatch                       : venue≠bingx or source≠intent ⇒ REFUSE
caller-supplied numbers             : attempt to pass pnl/status ⇒ IGNORED (evidence-derived only)
overwrite finalized                 : different numbers on finalized row ⇒ REFUSE
```

## 8. Expected output

```
decision_outcomes: status='finalized', provider='bingx', source='intent',
                   pnl/slippage/fees derived from persisted evidence,
                   metadata.evidence_refs + reason set,
                   exactly one finalized row per cycle decision_id.
proof staleness (outcome) refreshed to ~0d for the BingX autonomous rail.
```

## Red line

**D2 is a finalization CONTRACT, not a magic "finalize" button.** It must never let `pending → finalized` happen on assertion, caller-supplied numbers, manual SQL, or operator/direct-broker evidence. The monitor only writes "heartbeat validated" when the heart actually beat — measured from persisted reality.

### References
`apps/control_plane/main.py:22734` (`/v1/outcomes/{id}/update`, the magic path to fence) · `scripts/label_intent_outcomes.py` (read-only measurement, to wire) · `apps/execution_router/main.py:4004` (canonical fill persist) · `SPEC_AUTONOMOUS_PROOF_RENEWAL_CYCLE_V1.md` (D2 consumer) · doctrine commit 548e38e.

---
**Status: SPEC (design). Nothing implemented, nothing finalized, no SQL run. Implementation of the finalizer is a separate, cold, reviewed step — and the first real finalization only happens inside an authorized proof-renewal cycle (its own dedicated GO phrase).**
