## Operator / Risk Memo

- This branch intentionally keeps the runtime default in a non-live posture: `paper_only=true` remains active in the risk policy and now blocks real live execution paths at control-plane level.
- BingX live policy is still checked in as enabled, but live execution still requires the full gate chain: env flag, provider policy, route-level live flag, trade-capable linked account, allowed system mode, and conditional instrument rules.
- Kairos live remains feature-flagged on, but it still depends on explicit env gating and control-plane live eligibility before any real handoff can execute.
- Conditional rules are now enforced instead of declarative only: `SOLUSDT` stays restricted to `TREND`, higher confidence, and tighter notional constraints.
- BingX smoke remains intentionally possible under its dedicated smoke policy path; this is separate from real live execution and should stay short-window, operator-confirmed, and immediately re-locked after use.
- Remaining operator decision before removing draft status: decide whether checked-in live policy defaults should be reset to disabled after review, and whether `preferred_live_instruments` should become a hard execution-time constraint.