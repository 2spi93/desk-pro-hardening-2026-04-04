# TXT Autonomous Micro-Live Bootstrap Campaign

Generated: 2026-06-29

## PORTE 3.7 scope

PORTE 3.7 adds a bounded campaign controller for accumulating certified outcomes after the proof pipeline has been validated.

It does not start a campaign by itself. The default mode is read-only review.

```bash
python3 scripts/txt_autonomous_micro_live_bootstrap_campaign.py --text --no-write
```

## Campaign Contract

```text
mode                    bootstrap_autonomous_micro
symbol                  BTCUSDT only
max_notional            7.5 USD
max_concurrent_cycles   1
daily_budget            30 USD, unchanged
max_cycles_per_day      2 at 7.5 USD round-trip notional
campaign_expiry         required
operator_authorization  TXT_BOOTSTRAP_MICRO_LIVE_EXECUTE
continuous_promotion    forbidden
```

An authorization is bounded in time and scope. It is not a general live `GO`, not a continuous promotion, and not permission to retry indefinitely.

## Required Strategy Signal

The controller refuses to run without a strategy signal file proving that the next cycle is not artificial counter-filling:

```json
{
  "schema_version": "txt.strategy-signal.v1",
  "signal_id": "sig-example",
  "strategy_id": "bootstrap-edge-smoke",
  "strategy_version": "v1",
  "symbol": "BTCUSDT",
  "side": "buy",
  "generated_at": "2026-06-29T11:55:00Z",
  "expires_at": "2026-06-29T12:05:00Z",
  "confidence": 0.72,
  "market_regime": "liquid_micro",
  "entry_reason": "positive_micro_edge_after_costs",
  "invalidation_reason": "spread_or_consistency_degrades",
  "expected_edge_bps": 4.0,
  "estimated_fees_bps": 1.2,
  "estimated_slippage_bps": 1.0,
  "net_expected_edge_bps": 1.8,
  "consumed": false
}
```

The signal must be fresh, unconsumed, match BTCUSDT, provide `buy` or `sell`, and carry a positive `net_expected_edge_bps` after estimated fees and slippage.

## Execution Boundary

Even when the campaign controller is authorized, it can execute only one cycle at a time:

```bash
python3 scripts/txt_autonomous_micro_live_bootstrap_campaign.py execute-once \
  --campaign-expiry 2026-06-30T00:00:00Z \
  --authorize-campaign TXT_BOOTSTRAP_MICRO_LIVE_EXECUTE \
  --strategy-signal-file /opt/txt/var/proof_renewal/next_strategy_signal.json \
  --text
```

Internally it delegates to the existing single-cycle runner:

```text
bingx_autonomous_proof_renewal_v1.sh execute
  --confirm-live PROOF_RENEWAL_EXECUTE
  --go-phrase "GO renew BingX autonomous proof side=<buy|sell>"
```

The campaign wrapper does not bypass the runner's dedicated phrase, fill verification, flatten verification, proof finalizer, or reality-gap generation.

## Stop Conditions

The campaign must stop on:

```text
kill-switch active
promotion-relevant incident
unknown or indeterminate status
broker reconciliation ambiguous
position not flat after exit
open order residual
budget exhausted
daily loss exceeded
consecutive losses exceeded
slippage above cap
replay not aligned
outcome not certified
market data stale
critical service degraded
```

No retry loop is allowed. A failed cycle leaves artifacts and stops.

## Current State

```text
certified_outcomes          3 / 100
proof pipeline              validated
continuous autonomous       blocked
budget today                consumed in current runtime snapshot
campaign default action     stop
```

The campaign controller is ready as a bounded mechanism, but current runtime state still blocks execution while budget and promotion-relevant incidents remain active.
