# Memory V2 Runtime File Plan

This plan is scoped to one goal only:

Make Memory V2 a required runtime component in the live decision loop, not just an available learning subsystem.

## Runtime target

Definition of done:

- every pre-trade decision path queries Memory V2 before final route/size/execution-style selection
- every post-trade terminal outcome writes back a replay-grade episode into Memory V2 automatically
- Memory V2 stores explicit cause -> effect -> correction structures with venue/account scope
- runtime can prove when memory changed a decision

## File-by-file plan

### 1. `apps/predictor_v8/brain.py`

Status now:

- already contains `MemoryEngineV2`
- already stores `short_term`, `episodic`, `semantic`, and `causal`
- already exposes `remember_experience(...)` and `resolve(...)`

Required changes:

1. Add a distinct `live_state` layer.
   - Keep it separate from episodic trade memory.
   - Store rolling market/infrastructure snapshots keyed by `symbol + venue + account + session`.

2. Upgrade causal memory from bucketed `failure_source` to explicit graph edges.
   - Add `cause_labels`, `effect_labels`, and `correction_labels` lists per episode.
   - Maintain weighted edge counters and recency scores.

3. Add venue/account scoping to context keys.
   - Prevent BingX live memory from contaminating paper or other venues.

4. Add decay and freshness weighting.
   - Recent episodes must dominate stale regimes.

5. Add runtime override contract.
   - `resolve(...)` should return executable fields such as `delay_ms`, `skip_trade`, `route_mode_override`, `execution_style`, `size_multiplier_cap`, and `cooldown_seconds`.

6. Add audit-ready metadata.
   - Return `matched_episode_ids`, `matched_causal_edges`, and `why_this_recommendation`.

Acceptance check:

- given comparable context after repeated infra/execution failures, `resolve(...)` returns a non-empty executable override with provenance.

### 2. `apps/predictor_v8/reality_gap.py`

Status now:

- already computes predicted vs realized gaps
- already emits reward-bearing learning payloads
- already carries coarse `failure_source`

Required changes:

1. Emit explicit cause/effect labels.
   - Example causes: `infra_latency`, `spread_spike`, `queue_bloat`, `thin_book`, `timeout_burst`.
   - Example effects: `slippage`, `late_fill`, `partial_fill`, `no_fill`, `cancelled_after_open`.

2. Emit correction hints at sample level.
   - Example corrections: `reduce_size`, `delay_execution`, `force_passive`, `single_venue_only`, `skip_trade`.

3. Preserve route/account/order identifiers.
   - Required for replay-grade linking and operator drill-down.

4. Add multi-cause attribution.
   - One sample should support multiple causes with confidence, not one flattened source.

Acceptance check:

- one ingested sample can explain `why` the failure happened and suggest a machine-actionable correction, not only a scalar reward.

### 3. `apps/predictor_v8/main.py`

Status now:

- already exposes `/brain/memory-v2`, `/brain/memory-v2/query`, and `/brain/reality-gap/ingest`

Required changes:

1. Add `/brain/memory-v2/live-state` write endpoint.
   - This is for rolling market/infra snapshots, not post-trade experiences.

2. Add `/brain/memory-v2/runtime-feedback` endpoint.
   - Accept pre-trade context, memory recommendation, final route decision, and realized outcome.

3. Extend `/brain/memory-v2/query` response.
   - Include executable override fields and provenance.

4. Add observability endpoints.
   - memory hit rate
   - last runtime overrides
   - top causal edges
   - venue/account scoped stats

Acceptance check:

- control-plane can call one endpoint pre-trade and one endpoint post-trade without custom glue logic per caller.

### 4. `apps/control_plane/main.py`

Status now:

- already proxies predictor memory endpoints
- already forwards reality-gap samples after execution

Required changes:

1. Make Memory V2 query mandatory in the pre-trade path.
   - Insert query before final route and execution intent assembly.

2. Apply memory overrides to runtime knobs.
   - route mode
   - execution style
   - max spread
   - size cap
   - skip/delay/cooldown

3. Persist a `memory_applied` audit block alongside the decision.
   - include query context, returned recommendation, confidence, and applied fields.

4. On terminal outcome, send runtime feedback back to predictor.
   - include `decision_id`, `route_id`, `order_id`, `account_id`, and `memory_applied`.

5. Expose operator endpoints for memory-driven decisions.
   - recent memory hits
   - recent memory-forced skips
   - recent memory-driven size reductions

Acceptance check:

- for a comparable bad context, control-plane visibly changes the final execution intent because of Memory V2 and records that fact.

### 5. `apps/execution_router/main.py`

Status now:

- already handles execution-oriented market data and fill telemetry

Required changes:

1. Accept Memory V2 override fields from control-plane.
2. Apply them deterministically in route and style selection.
3. Emit detailed execution outcome metadata that preserves whether memory changed the route.
4. Return reject reasons that can be fed back as effects into Memory V2.

Acceptance check:

- when control-plane passes a memory override, execution-router reflects it in actual routing behavior and telemetry.

### 6. `apps/broker_adapter/main.py`

Status now:

- already normalizes live order creation/cancel flows

Required changes:

1. Guarantee terminal outcome normalization.
   - open
   - partial fill
   - full fill
   - cancel
   - reject
   - no fill timeout

2. Preserve exchange-native reject/cancel causes.
   - these become effect labels in Memory V2.

3. Preserve `account_id`, `client_order_id`, `order_id`, and venue-specific execution metadata.

Acceptance check:

- every terminal broker outcome can be replayed into a Memory V2 episode with full identifiers and causal context.

### 7. `shared/models.py`

Required changes:

1. Add typed runtime-memory audit structures.
2. Add a stable schema for `memory_applied`, `memory_query_context`, and `memory_feedback`.

Acceptance check:

- the same memory payload structure is reused across control-plane, execution-router, and persistence.

### 8. `database/migrations/*`

Required changes:

1. Add tables or columns for:
   - live state snapshots
   - memory runtime audit
   - replay-grade terminal execution outcomes
   - causal edge aggregates

2. Index by:
   - decision_id
   - route_id
   - order_id
   - account_id
   - symbol
   - venue
   - created_at

Acceptance check:

- operators can reconstruct one memory-influenced trade end to end from SQL alone.

### 9. `ui/mission-control/*`

Required changes:

1. Add Memory V2 runtime panels.
   - memory hit/miss per decision
   - top active causal edges
   - latest overrides applied
   - memory-forced skips/delays/downsizing

2. Link each displayed override to the underlying decision and execution outcome.

Acceptance check:

- Mission Control can show not just that memory exists, but when it changed real runtime behavior.

## Recommended implementation order

1. `apps/predictor_v8/brain.py`
2. `apps/predictor_v8/reality_gap.py`
3. `apps/predictor_v8/main.py`
4. `apps/control_plane/main.py`
5. `apps/execution_router/main.py`
6. `apps/broker_adapter/main.py`
7. `shared/models.py`
8. `database/migrations/*`
9. `ui/mission-control/*`

## Short truth

- The learning substrate is already real.
- The missing piece is forcing that substrate into the pre-trade and post-trade runtime contract.
- Once those file changes are done, Memory V2 stops being an analysis feature and becomes a trading edge.
