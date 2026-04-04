# Memory V2 + Kairos Runtime Gap List

This file answers one strict question:

What is still missing to call Memory Engine V2 and Kairos "implemented" at runtime, not just "present in code"?

## Current verdict

### Memory Engine V2

Base engine is already implemented.

Evidence:

- `apps/predictor_v8/brain.py` defines `MemoryEngineV2` with `short_term`, `episodic`, `semantic`, and `causal` layers.
- `apps/predictor_v8/main.py` exposes `/brain/memory-v2` and `/brain/memory-v2/query`.
- `apps/control_plane/main.py` forwards reality-gap execution samples to `predictor-v8` via `/brain/reality-gap/ingest`.
- `apps/predictor_v8/reality_gap.py` converts predicted vs realized execution into learning payloads, then `BRAIN.learn_from_payloads(...)` stores them in Memory V2.

Strict runtime verdict: `partial`.

Reason: the engine exists and learns from execution samples, but it is not yet the mandatory online memory layer used by every live decision/execution cycle.

### Kairos

Multi-agent primitives are already implemented.

Evidence:

- `apps/ai_orchestrator/agents_framework.py` defines `TradingAgent`, `MetaAgent`, `PortfolioManager`, and `HedgeFundSystem`.
- `apps/ai_orchestrator/agents_specialized.py` defines specialized trading agents.
- `apps/ai_orchestrator/multi_agent_router.py` creates a singleton system and exposes inspection APIs.

Strict runtime verdict: `not implemented`.

Reason: there is no always-on market loop wired to live market data, predictor, execution precompute, routing, and post-trade learning. The current router initializes agents with dummy market data and serves API/websocket views around in-memory decisions.

## 1. Memory V2 gaps to reach strict runtime implemented

Definition of done:

- every decision tick can query memory before routing
- every real execution outcome writes back into memory automatically
- memory contains explicit cause -> effect -> correction structure, not only aggregated buckets
- memory recommendations can change size, delay, route mode, and execution style in production paths
- every memory-driven action is auditable

Exact gaps:

1. Add a live-state layer, not only experience snapshots.
   Current state:
   - `short_term` stores remembered episodes after learning, not a rolling live market state stream.
   Missing:
   - a real `live_state` writer fed from microstructure/orderbook/infrastructure telemetry every cycle.
   Best place:
   - `apps/predictor_v8/brain.py`
   - `apps/control_plane/main.py`
   - `apps/market_data_plane/main.py`

2. Enrich causal memory from `failure_source` buckets into explicit cause/effect/correction edges.
   Current state:
   - causal memory keys are `context + action + failure_source + correction_signature`.
   Missing:
   - normalized cause nodes such as `infra_latency`, `spread_spike`, `queue_bloat`
   - normalized effect nodes such as `slippage`, `no_fill`, `partial_fill`, `late_fill`
   - weighted edges with confidence and recency
   - multi-cause attribution per episode, not one coarse `failure_source`
   Best place:
   - `apps/predictor_v8/brain.py`
   - `apps/predictor_v8/reality_gap.py`

3. Make memory query mandatory in the pre-trade path.
   Current state:
   - Memory V2 can be queried through API.
   Missing:
   - a required query in the control-plane/execution path before final route/size/execution-style selection
   - response fields written into execution intent and audit trail
   Best place:
   - `apps/control_plane/main.py`
   - `apps/execution_router/main.py`

4. Promote memory output from advisory to executable overrides.
   Current state:
   - Memory V2 can return recommendation/correction.
   Missing:
   - hard mapping from recommendation to runtime knobs such as `size_multiplier_cap`, `delay_ms`, `route_mode_override`, `execution_style`, `symbol cooldown`, `skip trade`
   - kill-switch precedence over normal signal flow
   Best place:
   - `apps/control_plane/main.py`
   - `apps/execution_router/main.py`

5. Persist replay-grade episodic memory for fills, cancels, rejects, and no-fills.
   Current state:
   - execution-aware samples are forwarded through reality-gap ingestion.
   Missing:
   - guaranteed write for all terminal execution outcomes, including rejects/cancels/no-fill expiries
   - stable replay schema keyed by decision_id, route_id, order_id, and account_id
   Best place:
   - `apps/control_plane/main.py`
   - `shared/models.py`
   - database migrations under `database/migrations`

6. Add recency/decay and per-venue memory scoping.
   Current state:
   - memory aggregates by market context and failure source.
   Missing:
   - decay by age and regime transitions
   - venue/account scoping so BingX live memory does not pollute paper or other venues
   Best place:
   - `apps/predictor_v8/brain.py`

7. Expose operator-grade observability for memory effects.
   Current state:
   - summary and query APIs exist.
   Missing:
   - last N memory-driven overrides
   - top active causal edges
   - memory hit rate during decisioning
   - pnl delta of memory-on vs memory-off
   Best place:
   - `apps/predictor_v8/main.py`
   - `ui/mission-control`

Minimum acceptance test for Memory V2:

1. Trigger three real or shadow executions with an induced infra degradation.
2. Confirm the resulting episodes create explicit cause/effect/correction entries.
3. On the next comparable setup, confirm the pre-trade memory query returns a non-empty recommendation.
4. Confirm control-plane applies the recommendation to route/size/execution style.
5. Confirm Mission Control shows the memory hit and the exact override applied.

## 2. Kairos gaps to reach strict runtime implemented

Definition of done:

- one service owns a continuous trading loop
- loop ingests live market state on cadence
- loop calls predictor and memory before execution
- loop precomputes execution and either routes or skips
- loop feeds realized fills back into learning automatically
- loop survives restart and exposes heartbeat/state

Exact gaps:

1. Replace dummy market data bootstrap with live state ingestion.
   Current state:
   - `apps/ai_orchestrator/multi_agent_router.py` initializes agents with hardcoded dummy BTC data.
   Missing:
   - live market snapshots from `market_data_plane` or `control_plane`
   - per-symbol live state refresh on cadence

2. Add a true always-on loop.
   Current state:
   - `HedgeFundSystem.make_decision(...)` exists, but is only called through request-time flows.
   - `apps/ai_orchestrator/main.py` startup only runs schema cleanup.
   Missing:
   - background task or dedicated worker that runs continuously:

```python
while True:
    update_microstructure()
    predict_short_term()
    precompute_execution()
    query_memory()
    decide_or_skip()
    route_if_allowed()
    ingest_realized_outcome()
```

3. Wire Kairos to predictor-v8 and world model.
   Current state:
   - world model exists in `apps/predictor_v8/model.py`
   - Kairos path is not using it as a required pre-execution stage
   Missing:
   - predictor call per cycle
   - world-model simulation before order routing
   - explicit action shield on poor execution forecast

4. Wire Kairos to real execution routing.
   Current state:
   - multi-agent code produces decisions, but not a production execution intent
   Missing:
   - translation from consensus decision to control-plane route request
   - route-level `live_enabled` check
   - system-mode/live-policy/env gate enforcement in the agent runtime path

5. Make Kairos stateful across restarts.
   Current state:
   - agent system is singleton in process memory.
   Missing:
   - persisted positions/intents/cooldowns/last decision timestamp/open-order map
   - startup recovery logic and duplicate-order protection

6. Add post-trade feedback closure.
   Current state:
   - reality-gap learning path exists in the platform
   Missing:
   - Kairos-owned executed decisions automatically linked to fills, cancels, rejects, and realized PnL
   - automatic feed into `/brain/reality-gap/ingest`
   - automatic refresh of memory and policy after each terminal outcome

7. Add runtime supervision and safety.
   Current state:
   - no explicit Kairos heartbeat loop contract is visible.
   Missing:
   - heartbeat endpoint with `last_cycle_at`, `cycle_latency_ms`, `symbols_active`, `decision_rate`, `skip_rate`
   - stale-loop detector and cooldown on repeated execution failures
   - hard stop on infra-critical state

8. Add runtime observability that proves the loop is real.
   Current state:
   - websocket emits decisions from in-memory log.
   Missing:
   - cycle timeline: observe -> predict -> simulate -> memory -> decide -> route -> learn
   - per-symbol live loop status in Mission Control
   - executed-vs-skipped reasons histogram

Minimum acceptance test for Kairos:

1. Start Kairos for one symbol in shadow mode.
2. Confirm heartbeat updates every cycle.
3. Confirm each cycle consumes fresh microstructure and predictor output.
4. Confirm world-model precompute is attached to the decision.
5. Confirm memory query result is attached to the decision.
6. Confirm shadow execution writes a realized outcome back into reality-gap and Memory V2.
7. Switch one route to live-enabled and confirm one guarded live order goes create -> fill/cancel -> learning feedback without manual intervention.

## Build order

If the goal is maximum edge with minimum drift, build in this order:

1. Make Memory V2 mandatory in pre-trade and post-trade paths.
2. Replace Kairos dummy market input with live state.
3. Add Kairos continuous loop with heartbeat and restart safety.
4. Attach world-model precompute and action shield before routing.
5. Attach automatic realized-outcome feedback into reality-gap and memory.
6. Add Mission Control observability proving the loop is live.

## Short truth

- Memory V2 is real, but not yet the mandatory runtime memory spine.
- Kairos building blocks are real, but Kairos itself is not yet an always-on runtime trading agent.
- Once those two gaps are closed, the Reality Gap engine becomes much more valuable because it stops being an isolated learner and becomes part of a closed live loop.
