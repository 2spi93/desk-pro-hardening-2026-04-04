# TXT — Certified Outcomes Incident Review

PORTE 3.1 reviews the remaining promotion-relevant incident:

```text
INC-444A3CCAFA
[Constitutional] Certified Outcomes Gate blocked on /constitutional/certified-outcomes
```

## Command

Before running the review, refresh the runtime truth matrix read-only with
incident dispatch disabled. From the repo root:

```bash
bash scripts/run_certified_outcomes_runtime_truth_matrix.sh
```

Then:

```bash
python3 scripts/txt_certified_outcomes_incident_review.py --text \
  --scanner-report /opt/txt/var/proof_renewal/certified_outcomes_review_runtime_truth_matrix.json
```

The review is read-only:

- no incident closure
- no budget reset
- no mode change
- no trade
- no promotion

## Current Result

```text
verdict=E_CERTIFIED_OUTCOMES_THRESHOLD_NOT_REACHED
incident_state=active
certified=0/100
projected candidates=3
projected certified=3
proof_validated=true
blocker_reproducible=true
additional_blocker=replay_truth_divergence_detected
```

Interpretation:

- the BingX proof layer is valid: 3 clean cycles, BUY and SELL covered;
- the constitutional certified-outcomes gate is still blocked;
- the derived projection surfaces the proof cycles as certified candidates;
- the constitutional scanner still reports `0/100`, so the incident remains
  active until the scanner consumes the derived projection or gate scope is
  explicitly separated;
- legacy `Replay Truth` still diverges on the selected entry replay, while the
  derived round-trip replay certificate is complete.

This is not eligible for closure. The next cold fix is the projection or
certification mapping, not another live cycle.
