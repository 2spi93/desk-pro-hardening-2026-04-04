# TXT — Certification Evidence Repair

PORTE 3.3 splits certified-outcome rejection into two per-candidate dimensions:

```text
candidate -> lineage_valid -> replay_aligned -> certified
```

No threshold is changed. The constitutional `100/100` gate remains intact.

## Command

```bash
bash scripts/run_certified_outcomes_runtime_truth_matrix.sh
python3 scripts/txt_certified_outcomes_projection.py --text
```

The projection remains read-only. It reads canonical proof evidence and replay
payloads; it does not insert rows, close incidents, reset budget, or trade.

## Current Result

```text
candidates=3
lineage_valid=3
replay_aligned=3
certified=3
```

Per candidate:

```text
lineage.classification = LINEAGE_VALID
lineage.coverage_pct   = 100
source_tree_cap_status = CAP_SATISFIED

round_trip_replay.classification = ROUND_TRIP_COMPLETE
legacy_entry_replay.class        = REPLAY_PAYLOAD_INCOMPLETE
legacy_entry_replay.fields       = fills, hedge_lifecycle, outcome
slippage_match                   = true
```

Interpretation:

- all three candidates have complete local proof leaves: entry fill, exit fill,
  outcome, reality gap, replay certificate reference;
- source-tree cap is now derived from the candidate population and is satisfied;
- the legacy entry replay remains visible as incomplete;
- the new derived round-trip replay certificate covers the proof window.

The remaining blocker is policy scope/threshold, not missing evidence:

```text
projected_certified=3
required_certified_outcomes=100
reason=threshold_not_reached
```
