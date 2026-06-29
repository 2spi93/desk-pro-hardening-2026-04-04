# TXT Constitutional Scanner Convergence

Generated: 2026-06-29

## PORTE 3.5 verdict

PORTE 3.5 is a cold scanner convergence change. It does not reset incidents, change the constitutional threshold, open orders, or authorize live promotion.

The certified outcomes scanner now consumes the canonical certified-outcomes projection when the projection artifact is present:

- `certified_outcomes_projection_version=txt-certified-outcomes-projection/v1`
- `certifier_version=txt.certified_outcomes.proof_projection.v1`
- `candidate_population_total=3`
- `projected_certified_total=3`
- `scanner_certified_total=3`
- `counter_delta=0`
- `legacy_scanner_total=0`
- `canonical_projection_total=3`
- `effective_certified_total=3`
- `migration_state=legacy_counter_superseded`

The scanner still preserves the legacy counter for audit, but it no longer treats that superseded empty counter as the effective certified-outcomes truth.

## Counting contract

Certified outcomes are counted by the unique derived key:

```text
proof_cycle_id + certifier_version + certification_digest
```

This prevents the legacy entry-only replay and the round-trip replay projection from being counted twice for the same proof root.

## Current expected scanner state

```text
certified=3/100
projected_certified=3
scanner_projection_delta=0
incident_state=active
incident_reason=threshold_not_reached
```

`INC-444A3CCAFA` remains open because the constitutional threshold is still 100 certified outcomes. The reason is now honest: 97 certified outcomes are missing. It is no longer caused by the scanner reading a stale empty counter.

## Non-actions

- No threshold change from 100 to 3.
- No incident closure.
- No administrative reset.
- No live cycle.
- No broker mutation.
- No promotion.

