# Benchmark: Quantower / TradingView / TradeLocker vs Mission Control (TXT Identity)

Date: 2026-03-21
Scope: terminal UX, chart readability under load, workflow speed, and institutional identity consistency.

## Evaluation Rubric

Scale per criterion:
- 0 = missing
- 1 = below market baseline
- 2 = baseline parity
- 3 = premium edge

Primary criteria:
- Dense-data readability (crosshair labels, overlap handling, micro-contrast)
- Interaction quality (zoom/pan inertia, wheel behavior, pointer stability)
- Workspace productivity (risk panel persistence, threshold controls, reset flows)
- Feedback clarity (alerts, badges, latency/poll diagnostics)
- Mobile/tablet resilience (layout, target sizes, reduced visual load)
- Identity coherence (TXT design language consistency across states)

## Comparison Matrix

| Criterion | Quantower | TradingView | TradeLocker | Mission Control (TXT) | Notes |
|---|---:|---:|---:|---:|---|
| Dense-data readability | 3 | 3 | 2 | 3 | Phase 4 anti-overlap and aggressive-mode micro-contrast keep labels legible under pressure. |
| Interaction quality | 3 | 3 | 2 | 3 | Motion smoothing/noise gating and frame-aware throttling now match premium desktop feel. |
| Workspace productivity | 2 | 2 | 3 | 3 | Workspace-scoped hard-alert thresholds with reset/reload persistence are strong differentiators. |
| Feedback clarity | 2 | 2 | 2 | 3 | Poll-age KPI and concise degraded warnings improve operational observability. |
| Mobile/tablet resilience | 2 | 2 | 2 | 3 | Tranche 3 responsive polish and coarse-pointer guardrails reduce visual overload. |
| Identity coherence (TXT) | 1 | 1 | 1 | 3 | Mission Control intentionally preserves TXT institutional language rather than generic retail chart styling. |

## Current Position

Mission Control is at parity-or-better for the defined scope, with strongest advantage in institutional workflow and TXT identity coherence.

## Remaining Gaps

- Validate parity with real control-plane latency profiles (degraded mode disabled).
- Continue periodic contrast audits on newly added overlays after each visual tranche.
- Add screenshot-based visual regression snapshots for dense/aggressive mode on tablet breakpoints.

## Validation Procedure

1. Run baseline reproducible QA:

```bash
sh /opt/txt/qa-mission-control.sh
```

2. Run real control-plane validation:

```bash
MC_E2E_DEV_DEGRADED=0 sh /opt/txt/qa-mission-control.sh
```

3. Manual visual checklist:
- Verify crosshair price/time labels do not collide with edge badges in stable/balanced/aggressive.
- Verify reduced-motion behavior on mobile/coarse-pointer contexts.
- Verify risk panel hard-alert controls persist across reload for each preset/workspace.

## Decision

Status: PASS (conditional on real control-plane run confirmation each release cycle)
Recommendation: keep TXT visual identity as primary axis while maintaining parity checks against mainstream platforms.
