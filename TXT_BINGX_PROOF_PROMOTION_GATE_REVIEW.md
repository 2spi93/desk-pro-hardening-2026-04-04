# TXT — BingX Proof Promotion Gate Review

Cold review for the autonomous BingX proof-renewal layer. This is not a live
runner and not a promotion action.

## Command

```bash
python3 scripts/bingx_proof_promotion_gate_review.py --text
```

The script is read-only:

- no market order
- no broker mutation
- no mode change
- no budget reset
- no incident closure
- no promotion write

It writes a JSON report under `var/proof_renewal/promotion_gate_review_*.json`.

## Gate Semantics

`PROOF_LAYER_VALIDATED=true` means the proof rail has enough clean historical
evidence:

- at least 3 clean proof cycles
- BUY and SELL entry branches both covered
- entry and exit fills are canonical `live-broker` BingX fills
- outcome is `finalized`
- `reality_gap_samples` exists for the entry decision

`PROMOTABLE_TO_MICRO_LIVE=true` is stricter. It additionally requires the live
operational surface to be clean now:

- control-plane healthy
- `guarded_auto`
- gate `go`
- kill false
- no local execution lock
- no pending intents
- readiness is read-only and green
- rail separation `PASS`
- risk budget available
- no promotion-relevant active incident blockers

Clearing this gate authorizes a human promotion review only. It does not
authorize continuous trading, notional increase, or another cycle.

## Current Interpretation

After the 2026-06-29 BUY cycle:

```text
PROOF_LAYER_VALIDATED=true
PROMOTABLE_TO_MICRO_LIVE=false
```

The proof layer is validated, including both SELL/SHORT and BUY/LONG paths.
Promotion remains blocked while the daily risk budget is exhausted or
promotion-relevant incident tickets are still active or insufficiently resolved.
