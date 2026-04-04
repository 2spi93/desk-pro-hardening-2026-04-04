# AI Orchestrator Stack Plan

## Objective
Operate a governance-first multi-model orchestration layer for TXT workflows with deterministic routing, explicit cost controls, and safe fallbacks.

## Scope
- Task-level model routing
- Fallback policy on outage or cost constraints
- Centralized endpoint for control-plane integration
- Audit event generation for each executed orchestration request

## Routing Policy (Initial)
- `strategy_creation`: `gpt-5` primary, `claude-4.6` fallback
- `feature_extraction`: `mistral-agent` primary, `deepseek-r1` fallback
- `backtest_analysis`: `deepseek-r1` primary, `gpt-5` fallback
- default/high criticality: higher-capability model first, otherwise low-cost model

## Cost and Criticality Rules
- If estimated primary model cost exceeds `cost_limit_usd`, route to low-cost model (`deepseek-r1` then `mistral-agent`).
- If `prefer_local=true`, force local/low-cost routing before remote providers.
- Critical workloads remain operator-triggered through control-plane auth and RBAC.

## APIs
- `POST /v1/route`: returns route decision only
- `POST /v1/execute`: resolves route and executes model with fallback if unavailable
- `GET /health`: model availability matrix

## Environment Variables
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `DEEPSEEK_API_KEY`
- `MISTRAL_API_KEY`
- `MISTRAL_LOCAL_URL`

## Security and Governance
- Control-plane endpoint access restricted to operator/admin for orchestration calls.
- HMAC and session-backed auth remains enforced upstream in control-plane.
- No direct autonomous execution of trades from model outputs.

## Next Iterations
1. Replace simulated model execution with provider clients in `apps/ai_orchestrator/providers`.
2. Add per-provider timeout/retry/circuit-breaker logic.
3. Persist route decisions and execution metadata to DB for cost analytics.
4. Add allowlist of task types and validation schemas per task.
5. Introduce policy-based hard limits by mode (`observe`, `suggest`, `guarded_auto`, `managed_live`).
