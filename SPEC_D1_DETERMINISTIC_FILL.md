# SPEC — D1: deterministic fill on the autonomous proof rail

**Cold design. Trades nothing.** Part of PORTE 1. Parent: [SPEC_AUTONOMOUS_PROOF_RENEWAL_CYCLE_V1.md](SPEC_AUTONOMOUS_PROOF_RENEWAL_CYCLE_V1.md), doctrine 548e38e.

## Problem

The autonomous rail routes via execution-AI v6, which can pick a **passive LIMIT** (`join_best_limit` / `move_to_mid`) that rests unfilled. A proof-renewal cycle needs a **deterministic canonical fill** (`execution_fill_events` live-broker/bingx) or it renews nothing. Protection (TP/SL) is NOT required for autonomous proof.

## Decision

For a proof-renewal routed order, **force a MARKET taker** (simplest deterministic fill; reuses the existing `market_sweep → order_type=MARKET` path). The fill still routes through `execution_router`, so it persists canonically.

## Contract (`apps/execution_router/proof_order_shape.py:resolve_proof_renewal_order_shape`)

A routed order is a proof-renewal order iff `payload.proof_renewal` is truthy. Then:
```
require  decision_id            (else ValueError)
require  proof_cycle_id         (else ValueError)
require  notional 0 < n ≤ 7.5   (estimated_notional_usd / notional_usd / target_notional_usd)
refuse   passive LIMIT hint     (order_type=LIMIT without marketable -> ValueError)
refuse   direct-broker marker   (operator_direct_broker / direct_broker -> ValueError)
return   {"order_type":"MARKET", "proof_cycle_id", "decision_id"}
```
Non-proof orders return `None` (normal routing untouched).

## Wiring (`apps/execution_router/main.py`, action block ~3821)

At the top of the `if effective_live_context.enabled` block: call the helper; on a proof-renewal order force `order_type=MARKET`, drop any `price`, tag `proof_cycle_id`, and **bypass** the execution-AI passive-LIMIT branches. `ValueError → HTTP 400`. Markers (`proof_renewal`, `proof_cycle_id`, `decision_id`) are forwarded from the intent through `_prepare_live_execution_intent` into the `/v1/orders/routed` payload (runner sets them on the intent).

## Guards layering

- Order shape + notional cap + rail marker: enforced here (execution_router, D1).
- Flat / kill / gate / managed_live preconditions: enforced by the runner + risk-gateway before submission (PORTE 1 runner / readiness check). execution_router does not re-check flatness.

## Tests (`tests/test_proof_renewal_order_shape.py`, pure)

refuses passive LIMIT · accepts MARKET-taker shape · refuses missing decision_id · refuses missing proof_cycle_id · refuses notional > cap · refuses zero/negative notional · refuses direct-broker marker · returns None for non-proof orders · forces MARKET regardless of execution-AI action.
