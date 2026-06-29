# TXT Opportunity Gate Recovery And Signal Source

Generated: 2026-06-29

## PORTE 3.9 Scope

PORTE 3.9 is a cold recovery and readiness step:

- targeted recovery for `owner=opportunity_gate` and `reason=consistency_kill_threshold`;
- no reset when the metric condition is still active;
- no repeated reset loop;
- no market order;
- no signal consumption;
- strategy opportunity to `txt.strategy-signal.v1` producer.

## Recovery Command

Read-only:

```bash
python3 scripts/txt_opportunity_gate_recovery.py --text --no-write
```

Targeted reset:

```bash
python3 scripts/txt_opportunity_gate_recovery.py \
  --execute-reset \
  --confirm RESET_OPPORTUNITY_GATE_CONSISTENCY_LATCH \
  --operator codex \
  --text
```

The reset script refuses unless:

```text
lock_active=true
lock_owner=opportunity_gate
lock_reason=consistency_kill_threshold
metric_condition_still_reproducible_now=false
```

After reset it observes once, then stops. If the lock returns immediately, recovery is not functional and no second reset should be attempted.

## Strategy Signal Producer

Command:

```bash
python3 scripts/txt_strategy_signal_producer.py \
  --input-json /opt/txt/var/proof_renewal/strategy_opportunity.json \
  --output /opt/txt/var/proof_renewal/next_strategy_signal.json \
  --text
```

Input schema:

```text
txt.strategy-opportunity.v1
```

Output schema:

```text
txt.strategy-signal.v1
```

The producer rejects:

```text
expired source
wrong symbol
invalid side
confidence <= 0
net_expected_edge_bps <= 0
missing strategy/version/regime/reason fields
```

The producer does not consume the signal and does not trade. Consumption remains the campaign runner's responsibility after authorization and before a live cycle.

## Expected Post-Recovery State

If recovery holds and a valid signal exists, the campaign should eventually show:

```text
authorized=false
next=await_operator_authorization

blockers:
- campaign_expiry_required
- operator_authorization_missing
- optionally budget_exhausted
```

No campaign authorization is created by this file.

## Current Post-Reset Snapshot

After the targeted recovery run:

```text
OPPORTUNITY_GATE_READINESS ready=true
lock_active=false
owner=opportunity_gate
reason=consistency_kill_threshold
consistency=100.0/65.0
metric_reproducible=false
lock_latched=false
```

The autonomous campaign now stops for non-technical launch blockers plus the absence of a real strategy signal:

```text
budget_exhausted
campaign_expiry_required
operator_authorization_missing
strategy_signal_missing
```

`promotion_relevant_incident` is no longer treated as a bootstrap blocker when the only relevant incident is the constitutional `3/100` threshold. That threshold belongs to the continuous-autonomous gate and is supposed to be populated by the bootstrap campaign.
