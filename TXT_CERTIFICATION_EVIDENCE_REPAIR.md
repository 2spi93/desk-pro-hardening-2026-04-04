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
lineage_valid=0
replay_aligned=0
certified=0
```

Per candidate:

```text
lineage.classification = COVERAGE_BELOW_CAP
lineage.coverage_pct   = 100
source_tree_cap_pct    = 0

replay.divergence_class  = REPLAY_PAYLOAD_INCOMPLETE
replay.divergence_fields = fills, hedge_lifecycle, outcome
slippage_match           = true
```

Interpretation:

- all three candidates have complete local proof leaves: entry fill, exit fill,
  outcome, reality gap, replay certificate reference;
- source-tree cap is still zero globally, so lineage cannot become valid yet;
- replay currently represents the entry payload, not the full round-trip
  measurement window, so exit lifecycle and outcome are missing from replay.

The next repair is not another live cycle. It is:

1. make source-tree certification cap calculable for these derived candidates;
2. extend or map replay certification so the replay certificate covers the
   round-trip proof window: entry fill, exit fill, finalized outcome, reality
   gap, and certifier version.
