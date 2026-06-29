# TXT — Certified Outcomes Projection And Gate Scope

PORTE 3.2 separates two questions that were previously mixed:

1. Are the real BingX proof cycles visible as certified-outcome candidates?
2. Does the constitutional `100/100` certified-outcomes threshold apply to the
   current micro-live proof layer or to a later continuous-autonomous gate?

## Projection

Command:

```bash
python3 scripts/txt_certified_outcomes_projection.py --text
```

The projection is read-only and derived from canonical tables:

- `execution_fill_events`
- `decision_outcomes`
- `reality_gap_samples`

It does not insert certification rows and does not backfill the event store.
Every candidate carries a stable `candidate_digest`, and the report carries a
stable `projection_digest` over the candidate digests and source-tree digest.

Each candidate includes:

- `decision_id`
- `proof_cycle_id`
- `entry_fill_id`
- `exit_fill_id`
- `outcome_id`
- `outcome_version`
- `reality_gap_sample_id`
- `replay_certificate_id`
- `replay_certificate_digest`
- `source_tree_digest`
- `certification_status`
- `certification_blockers`
- `certifier_version`

## Current Scope

The proof-layer gate and the constitutional certified-outcomes gate are distinct:

```text
MICRO_LIVE_PROOF_GATE
  required_clean_cycles=3
  required_sides=buy,sell
  operator_authorization=required
  no automatic promotion

CONTINUOUS_AUTONOMOUS_GATE
  required_certified_outcomes=100
  replay_alignment=required
  source_tree_cap=required
```

This file does not lower `100` to `3`. It only makes the three proof cycles
visible as candidates, so the system can distinguish:

```text
no projected data
!=
projected candidates rejected by replay/source-tree blockers
```

## Current Expected Result

With the current scanner state:

```text
candidates=3
certified=3
blockers=none
lineage_valid=3
replay_aligned=3
```

So `INC-444A3CCAFA` remains active only because the constitutional threshold is
still `100`, not because the three proof cycles are invisible or uncertifiable.
