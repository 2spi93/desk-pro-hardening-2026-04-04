docker stop ================================================================================
NEXT ACTIONS — SHADOW MODE PHASE 1 → PHASE 2 TRANSITION
Mission Control Terminal Backend Integration
Date: 2026-03-21
================================================================================

🎯 CURRENT STATE
================================================================================

✅ Phase 1 Shadow Mode Deployed
   - Backend running in parallel (non-blocking)
   - UI always uses fallback (safe)
   - Metrics collected: [TXT][SHADOW_OK], [TXT][SHADOW_FAIL], [TXT][SHADOW_DIFF]
   - 3 critical routes instrumented: auth/preferences, risk-history, risk-summary

📊 Metrics to Track (During Phase 1)

   Command: curl https://app.txt.gtixt.com/api/system/shadow-metrics | jq '.'
   
   Success Thresholds:
   - fallback_rate_pct: 0% (UI still using fallback, backend is test-only)
   - shadow_diff events per 1000 calls: < 5 (backend data close to fallback)
   - Backend error rate: < 0.5%
   - Backend latency P99: < 500ms
   
   If any metric fails:
   → Investigate backend implementation
   → Do NOT advance to Phase 2
   → Rollback and fix issues


🚀 IMMEDIATE NEXT STEPS (Week 1-2 of Phase 1: 2026-03-21 → 2026-04-04)
================================================================================

STEP 1 — Deploy/Rebuild Current Changes (Already Done)
   Status: ✅ COMPLETE
   
   What happened:
   - shadowMode.ts utility created with full infrastructure
   - 3 route handlers updated to use shadow mode
   - Metrics endpoint created (/api/system/shadow-metrics)
   - Fallback logic preserved (UI always uses fallback in Phase 1)
   
   To verify it deployed:
   $ docker compose logs mission-control-ui | grep '\[TXT\]\[SHADOW' | head -5
   
   Expected output:
   [TXT][SHADOW_OK] { route: 'auth/preferences', latency_ms: 145, timestamp: ... }
   [TXT][SHADOW_FAIL] { route: 'auth/preferences', latency_ms: 340, ... }


STEP 2 — Baseline Shadow Metrics (During Phase 1)
   Frequency: Daily (morning + end of day)
   Command:
   $ curl -s https://app.txt.gtixt.com/api/system/shadow-metrics | jq '{
       fallback_rate: .fallback_rate_pct,
       total_calls: (.metrics_snapshot | add),
       backend_ok: .metrics_snapshot.shadow_ok_auth,
       backend_fail: .metrics_snapshot.shadow_fail_auth,
       divergences: .metrics_snapshot.shadow_diff_auth
     }'
   
   Record in spreadsheet:
   | Date       | Fallback % | Backend OK | Backend Fail | Divergence |
   |------------|-----------|-----------|-------------|-----------|
   | 2026-03-21 | 0.0%      | 145       | 12          | 2         |
   | 2026-03-22 | 0.0%      | 1200      | 5           | 1         |
   
   Success = divergence trend declining, error_rate stable


STEP 3 — Backend Team: Implement Remaining Endpoints
   Required endpoints (spec in BACKEND_API_SPEC.txt):
   
   CRITICAL (Week 1):
   ☐ GET /v1/auth/preferences
   ☐ PUT /v1/auth/preferences
   ☐ GET /v1/mt5/orders/risk-history
   ☐ GET /v1/mt5/orders/risk-history/summary
   
   HIGH (Week 2):
   ☐ GET /v1/auth/ws-token
   ☐ GET /v1/risk/confirm-required
   
   Testing requirements (from BACKEND_API_SPEC.txt):
   - Response format: strict JSON (no null values)
   - Latency: P99 < 500ms
   - Error rate: < 0.5%
   - Load tested: 50 concurrent requests per endpoint
   
   Once implemented:
   1. QA tests backend in staging
   2. Measure shadow_diff (should match fallback closely)
   3. Confirm latency meets SLA
   4. Get sign-off before Phase 2


STEP 4 — Phase 1 Exit Criteria (End of Week 2, ~2026-04-04)
   Before advancing to Phase 2, verify ALL of these:
   
   ☐ Backend endpoints respond 200 OK for 24+ hours
   ☐ shadow_diff events < 5 per 1000 calls (< 0.5% divergence)
   ☐ Backend latency P99 consistently < 500ms
   ☐ Backend error_rate consistently < 0.5%
   ☐ QA team sign-off: no critical divergences
   ☐ Ops team sign-off: infrastructure stable
   ☐ Product sign-off: ready for Phase 2 canary
   
   If ANY criteria fails:
   → Do NOT proceed to Phase 2
   → Fix the issue in backend or shadow mode
   → Re-test until all criteria pass


================================================================================
🔄 PHASE 2 TRANSITION (Starting ~2026-04-05): GRADUAL ROLLOUT
================================================================================

⚠️ DO NOT EXECUTE UNTIL ALL PHASE 1 EXIT CRITERIA MET

When Phase 1 Exit Criteria ✅ Met:

STEP 5A — Update Configuration for Canary (10% Users)
   
   Files to Update:
   1. /opt/txt/ui/mission-control/app/api/auth/preferences/route.ts
   2. /opt/txt/ui/mission-control/app/api/mt5/orders/risk-history/route.ts
   3. /opt/txt/ui/mission-control/app/api/mt5/orders/risk-history/summary/route.ts
   
   Change in each file:
   ```typescript
   const SHADOW_CONFIG_* = {
     route: "...",
     enabled: true,
     shadowOnly: false,         // ← CHANGE FROM true
     dualMode: true,            // ← CHANGE FROM false (enable real backend)
     rolloutPercentage: 10,     // ← CHANGE FROM 0 (start 10% users)
   };
   ```
   
   Rationale:
   - shadowOnly=false: allow real backend to be used (if selected by rollout)
   - dualMode=true: use backend if successful, fallback if it fails
   - rolloutPercentage=10: only 10% of users get real data (canary blast radius)


STEP 5B — Rebuild & Deploy
   
   $ cd /opt/txt && docker compose up -d --build mission-control-ui
   
   Verify deployment:
   $ docker logs --tail 50 mission-control-ui | grep '\[TXT\]\[SHADOW'
   
   Expected in logs:
   [TXT][SHADOW_METRIC] { type: 'dual_success', route: 'auth/preferences', latency_ms: 120 }
   [TXT][SHADOW_METRIC] { type: 'dual_fallback', route: 'auth/preferences', reason: 'Error' }


STEP 5C — Monitor Canary (10% Users) for 24-48 Hours
   
   Commands:
   # Real-time view of dual mode activations
   $ docker logs -f mission-control-ui | grep '\[TXT\]\[SHADOW_METRIC\]'
   
   # Metrics snapshot (should show error_rate stable, latency OK)
   $ curl -s https://app.txt.gtixt.com/api/system/shadow-metrics | jq '.metrics_snapshot'
   
   # Count dual successes vs dual fallbacks
   $ docker logs --tail 1000 mission-control-ui | grep 'dual_success\|dual_fallback' | sort | uniq -c
   
   Success Criteria (24-48 hrs):
   ☐ Error rate remains < 0.5%
   ☐ Latency P99 stable (no new spikes)
   ☐ Dual success > 95% (backend working for 95%+ of canary)
   ☐ Zero user complaints / error tickets
   ☐ QA smoke test passes
   
   If any criteria fails:
   → Revert: rolloutPercentage=0, shadowOnly=true
   → Investigate root cause
   → Contact backend team


STEP 5D — Ramp to 50% (After Canary OK, 48 hrs)
   
   Similar process:
   rolloutPercentage: 50      // ← UPDATE (50% of users)
   docker compose up -d --build mission-control-ui
   
   Monitor for 2+ hours before final GA


STEP 5E — GA 100% (After Ramp OK, 48 hrs)
   
   final step:
   rolloutPercentage: 100     // ← UPDATE (all users)
   docker compose up -d --build mission-control-ui
   
   Monitor for 24+ hours to confirm stable


================================================================================
📋 DECISION TREE: WHEN TO PROCEED
================================================================================

Phase 1 → Phase 2 Readiness:
│
├─ All Phase 1 exit criteria met? (from STEP 4 above)
│  ├─ YES → Proceed to STEP 5A (Canary 10%)
│  └─ NO → Fix issues, return to Phase 1 monitoring
│
├─ Canary 10% stable for 24-48 hours?
│  ├─ YES → Proceed to STEP 5D (Ramp 50%)
│  └─ NO → Rollback (rolloutPercentage=0), investigate
│
├─ Ramp 50% stable for 24-48 hours?
│  ├─ YES → Proceed to STEP 5E (GA 100%)
│  └─ NO → Hold at 50%, investigate, or rollback
│
└─ GA 100% stable for 24+ hours?
   ├─ YES → Phase 3: Keep backend enabled, remove fallback logic (optional)
   └─ NO → Rollback to previous % or Phase 1


================================================================================
🆘 EMERGENCY PROCEDURES
================================================================================

If Things Break During Phase 2 Rollout:

IMMEDIATE ROLLBACK (< 2 minutes):
   $ cd /opt/txt && \
     sed -i 's/rolloutPercentage: [0-9]*/rolloutPercentage: 0/' \
       ui/mission-control/app/api/*/route.ts && \
     sed -i 's/shadowOnly: false/shadowOnly: true/' \
       ui/mission-control/app/api/*/route.ts && \
     docker compose up -d --build mission-control-ui
   
   Verify rollback:
   $ curl -s https://app.txt.gtixt.com/api/system/shadow-metrics | jq '.fallback_rate'
   Expected: 0% (UI back on fallback, no real backend)

INVESTIGATE:
   $ docker logs --tail 500 mission-control-ui | grep '\[TXT\]\[SHADOW' | tail -20
   
   Common issues:
   - Backend 500 errors: backend team must fix
   - Latency spikes: check backend resource usage
   - Data divergence: backend returning wrong format (check spec)
   - User errors: may indicate backend logic issue (not format)


================================================================================
📞 ESCALATION PATH
================================================================================

Issue Level 1 (Metric Anomaly, Can Wait):
   → Alert: @backend-team, @ops
   → Timeline: Within 4 hours
   → Example: shadow_diff trending up slightly

Issue Level 2 (Minor Service Degradation):
   → Alert: @backend-team, @ops, @sre (immediately)
   → Timeline: Within 1 hour
   → Example: error_rate 1-2%, latency increased 200ms
   → Response: Hold phase (don't advance), investigate

Issue Level 3 (Critical):
   → Alert: @backend-team, @ops, @sre, @product (immediately)
   → Timeline: IMMEDIATE ROLLBACK
   → Example: error_rate > 5%, users seeing errors, latency > 2s
   → Response: Revert rolloutPercentage=0 within 2 minutes


================================================================================
END NEXT ACTIONS DOCUMENT
================================================================================
