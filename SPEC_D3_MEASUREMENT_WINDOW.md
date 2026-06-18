# SPEC — D3: measurement window + mandatory flatten

**Cold design. Trades nothing.** Part of PORTE 1. Parent: [SPEC_AUTONOMOUS_PROOF_RENEWAL_CYCLE_V1.md](SPEC_AUTONOMOUS_PROOF_RENEWAL_CYCLE_V1.md).

## Decision (first proof cycle)

```
measurement_window_seconds = 8        # observe, then flatten immediately
flatten_required            = true    # no strategy hold
no_position_after_cycle     = true    # mandatory
mandatory TP/SL             = no      # protection not required for autonomous proof
outcome basis               = entry fill + exit fill (+ fees/slippage)
exit fill absent            => stale/fail (abort, no finalize)
```

## Mechanism (canonical exit fill)

The exit (flatten) must ALSO route through `execution_router` — a **second routed intent**, opposite side, `proof_renewal=true`, its own `exit_decision_id` — so the exit fill persists as canonical `execution_fill_events` (live-broker/bingx). The finalizer is then called:
```
finalize_autonomous_bingx_outcome(entry_decision_id, exit_decision_id=exit_decision_id)
```
The finalizer (`apps/control_plane/proof_finalizer.py`) computes `net_result_usd` as a `round_trip` (short = entry_notional − exit_notional − fees; long = inverse) only when both entry and exit canonical fills exist; otherwise `measurement_basis="entry_only"` and `net_result_usd=None`.

## D3 ↔ finalizer / runner contract

- **Finalizer**: with exit fills → `round_trip` (net_result computed); without exit fills → `entry_only` (net_result None). This is the measurable truth, never caller-asserted.
- **Runner** (PORTE 1 `bingx_autonomous_proof_renewal_v1.sh`): treats a missing/`entry_only` exit as an **abort** (the cycle must leave the book flat and only finalize a complete round-trip). On window timeout → abort + flatten + revert. `final flat` (position 0, open_orders 0) is a hard success condition.

## Tests

`tests/test_proof_finalizer.py` covers: `round_trip` net_result with entry+exit (happy path); `entry_only` basis when exit fills absent (net_result None) — which the runner treats as incomplete. Runner-level timeout→abort→flatten is exercised by the readiness/dry path (no market).
