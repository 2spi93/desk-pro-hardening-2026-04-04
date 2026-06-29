# TXT Opportunity Gate And Strategy Signal Readiness

Generated: 2026-06-29

## PORTE 3.8 Scope

PORTE 3.8 is a cold readiness gate before any autonomous micro-live campaign authorization.

It adds:

- opportunity-gate consistency lock review;
- incident adjudication for opportunity-gate locks;
- versioned strategy signal contract;
- net edge after fees and slippage requirement;
- signal freshness and single-use checks;
- no trade, no reset, no incident closure.

## Opportunity Gate Review

Command:

```bash
python3 scripts/txt_opportunity_gate_readiness_review.py --text
```

The review reports:

```text
owner
reason
lock status
consistency observed
consistency kill threshold
candidate count
bus sequence
deviation bps
freshness ms
first observed
last observed
incident classification
```

The current lock must not be reset merely because services are healthy. It is clear only when:

```text
OPPORTUNITY_GATE_READY=true
lock_active=false
gate=go
kill=false
promotion relevant incident clear
```

## Strategy Signal Contract

Schema:

```text
txt.strategy-signal.v1
```

Required fields:

```text
signal_id
strategy_id
strategy_version
symbol
side
generated_at
expires_at
confidence
market_regime
entry_reason
invalidation_reason
expected_edge_bps
estimated_fees_bps
estimated_slippage_bps
net_expected_edge_bps
consumed
```

Minimal gate:

```text
fresh signal
unconsumed signal
BTCUSDT only
side in buy/sell
net_expected_edge_bps > 0
campaign gate clear
no position or order conflict via existing readiness/promotion gate
```

## Expected Cold Verdict Before Campaign Authorization

The desired state after technical blockers clear is:

```text
AUTONOMOUS_MICRO_BOOTSTRAP_CAMPAIGN
authorized=false
next=await_operator_authorization

blockers:
- campaign_expiry_required
- operator_authorization_missing
- optionally budget_exhausted
```

Any of these still forces `next=stop`:

```text
opportunity_gate_not_ready
promotion_gate_local_execution_lock_active
promotion_relevant_incident
strategy_signal_missing
strategy_signal_net_edge_not_positive
strategy_signal_expired
strategy_signal_already_consumed
```

## Non-actions

- No trade.
- No reset.
- No incident closure.
- No threshold change.
- No campaign authorization.

