# Execution Smart 7-Day Calibration Plan

## Objective

Freeze the V7 Smart execution logic for 7 days and measure whether the smart gate improves execution quality without degrading PnL discipline.

Primary goal:
- understand the behavior of the engine in micro-live conditions

Secondary goal:
- identify the minimum calibration changes needed before any capital scaling or global sizing integration

## Freeze Rules

Do not change during the 7-day window:
- execution smart gate logic
- smart gate allow/block thresholds
- execution size multiplier mapping
- delay mapping
- venue score formula
- fill/slippage continuation guards

Allowed changes during the window:
- logging
- dashboards
- labels and visualizations
- bug fixes only if they are clearly correctness issues and not behavioral tuning

## Core Metrics

Track these every day and by venue:
- execution score
- venue score
- context score
- realized slippage bps
- realized latency ms
- fill ratio
- blocked trades count
- reduced trades count
- delayed trades count
- PnL by execution posture: clean, reduced, delayed, blocked
- positive PnL ratio

Track these by symbol when possible:
- average execution score
- average slippage
- average latency
- average fill ratio
- total blocked count
- total reduced count
- total delayed count

## Daily Routine

### Day 1-2

Goal:
- validate instrumentation, not performance

Actions:
- verify the Execution Smart Tracker panel updates during live activity
- confirm preview values are coherent with live microstructure
- check that blocked, reduced and delayed counts move when expected
- verify venue score differs meaningfully by venue over multiple samples

Review thresholds:
- none

### Day 3-4

Goal:
- identify dominant failure modes

Actions:
- rank top block reasons
- rank worst venues by score, slippage, latency and reject rate
- compare PnL by posture
- check whether reduced trades are healthier than clean trades under stress

Review thresholds:
- none

### Day 5-6

Goal:
- estimate safe calibration candidates

Actions:
- simulate what would happen if allow/block were shifted slightly
- compare current posture mix versus hypothetical posture mix
- check whether delay is protective or simply destructive

Review thresholds:
- draft only, no deployment

### Day 7

Goal:
- decide whether calibration is justified

Actions:
- summarize 7-day metrics
- identify only the top 3 parameter candidates for adjustment
- reject all changes that do not have measurable evidence

## Allowed Calibration Knobs After Day 7

Only these may move first:
- smart gate threshold
- size multiplier mapping
- delay threshold
- venue score weight
- confidence floor

Do not change at the same time:
- execution architecture
- routing logic
- adaptive learning core
- anti-overfit logic

## Decision Rules

Keep the current system frozen if:
- execution score is stable
- slippage is stable or improving
- blocked trades are explainable
- reduced trades preserve better fill/slippage than clean trades under stress

Reduce aggressiveness after calibration if:
- blocked trades are low but slippage keeps worsening
- reduced trades still lose quality
- one venue drags down the aggregate score persistently

Do not scale capital if:
- execution score drifts materially
- venue score is unstable
- delay logic causes more harm than protection
- PnL is only supported by a tiny number of lucky clean trades

## Review Template

Daily review lines:
- day:
- sample count:
- avg execution score:
- avg venue score:
- avg slippage bps:
- avg latency ms:
- avg fill ratio:
- blocked / reduced / delayed:
- pnl clean:
- pnl reduced:
- pnl delayed:
- pnl blocked:
- dominant block reasons:
- weakest venue:
- action:

## Operational Warning

At this stage, the system is not bottlenecked by missing features.

It is bottlenecked by calibration quality.

The right sequence is:
- freeze
- measure
- compare
- calibrate
- re-measure
- only then consider plugging smart execution score into the global sizing policy