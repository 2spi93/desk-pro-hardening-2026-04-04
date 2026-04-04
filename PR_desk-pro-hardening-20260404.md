# PR Draft: Desk-Pro Hardening 2026-04-04

## Summary

This PR consolidates the current desk-pro hardening batch on `desk-pro-hardening-20260404` and adds a final risk-desk safeguard so live execution remains blocked while the active risk policy is `paper_only`.

## 1. Infra, Config, and Repo Hygiene

- Tightens repo hygiene by ignoring local runtime and build artifacts.
- Normalizes control-plane environment resolution across backend, UI, and operational scripts.
- Documents the fallback control-plane URL in `.env.example`.
- Adds shared script helpers to reduce duplicated operator auth and secret handling.

## 2. Live Routing and Risk Desk Controls

- Refactors BingX and Kairos operational scripts onto a shared control-plane helper layer.
- Preserves explicit live-smoke support while gating real live execution on policy, env, route flag, account linkage, and system mode.
- Adds a follow-up guard so `paper_only=true` now blocks real live execution paths in the control plane.
- Enforces conditional risk-policy instrument rules in the risk gateway and conditional live instrument rules in the control plane.

## 3. Predictor V8 and Reality Gap Semantics

- Extends Predictor V8 runtime modules, storage, calibration history, and training flow.
- Keeps signed latency delta semantics while introducing explicit overrun and underrun metrics for risk-sensitive consumers.
- Shifts calibration and learning pressure to use latency overrun instead of the raw signed delta.

## 4. Rust Execution Engine

- Adds the Rust execution engine crate, route selection core, hedge guard logic, and benchmark scaffolding.
- Adds CI coverage for the Rust execution engine workflow.
- Keeps the Rust execution path aligned with the broader routing and reality-gap model.

## 5. Mission Control and Operator Surfaces

- Adds or expands Mission Control routes, advanced desks, live-capital pages, and execution telemetry surfaces.
- Normalizes control-plane access from Mission Control and Playwright helpers.
- Updates Reality Gap operator labels to distinguish latency delta from overrun.

## 6. Architecture and Runbook Docs

- Adds architecture notes for accounts, microstructure simulation, memory/runtime plans, and BingX live smoke.
- Captures validated live-smoke and runtime-operating sequences for BingX and Kairos.

## Validation

- `python3 -m py_compile apps/control_plane/main.py apps/risk_gateway/main.py`
- previously validated in this branch: Mission Control production build, shell syntax checks, Predictor runtime smoke, and Rust `cargo check`

## Risk Notes

- `config/live_execution_policy.json` is currently checked in with live enabled for BingX; deployment still relies on env gates and route/account checks.
- `config/kairos_feature_flags.json` keeps `kairos_live=true`; live handoff still depends on env gating and route-level eligibility.
- `config/risk_policy.json` remains `paper_only=true`, and this PR now enforces that state on real live execution paths.

## Operator / Risk Memo

Short version ready to paste into the PR description or a review comment: see `OPERATOR_RISK_MEMO_SHORT.md`.

## Follow-up

- Re-auth GitHub on the host and push `desk-pro-hardening-20260404`.
- Open a PR from `desk-pro-hardening-20260404` and use this draft as the initial description.
- Consider a follow-up PR that resets checked-in live policy defaults to disabled after the operational review is complete.