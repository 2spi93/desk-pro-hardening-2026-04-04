================================================================================
SHADOW MODE MIGRATION STRATEGY
Mission Control Terminal Backend Integration (Phase-Based Rollout)
================================================================================

Status: PHASE 1 — Shadow Mode Testing (ACTIVE)
Deployment Date: 2026-03-21
Target Completion: 2026-04-04 (2 weeks)

================================================================================
🎯 OVERALL STRATEGY
================================================================================

Objective:
  Migrate from UI fallbacks → Backend-driven data
  WITHOUT ANY production incidents or UX disruptions

Safety Gates:
  ✅ Shadow mode: backend runs silently, doesn't impact UI
  ✅ Divergence detection: alerts if backend differs from fallback
  ✅ Metrics: measure fallback_rate, latency, error rates
  ✅ Gradual rollout: 10% → 50% → 100% of users
  ✅ Automatic rollback: if error_rate > 5%, revert to fallback


================================================================================
📊 PHASE 1 — SHADOW MODE TESTING (CURRENT)
================================================================================

Duration: Week 1-2 (2026-03-21 → 2026-04-04)

Goal:
  Backend running in parallel (non-blocking)
  UI always uses fallback (safe for users)
  Collect divergence data to identify issues
  Measure backend latency & error rates

Configuration:
  shadowOnly: true           (backend test-only, UI uses fallback)
  dualMode: false            (not active yet)
  rolloutPercentage: 0       (0% of users get real data)

Endpoints in Shadow Mode:
  ✓ /api/auth/preferences (GET/PUT)
  ✓ /api/mt5/orders/risk-history (GET)
  ✓ /api/mt5/orders/risk-history/summary (GET)

Success Metrics:
  - Backend responds 200 OK for all 3 endpoints
  - shadow_diff < 2% (real data matches fallback closely)
  - Backend latency P99 < 500ms
  - Backend error_rate < 0.5%

Monitoring Commands:
  # Check shadow metrics endpoint
  curl https://app.txt.gtixt.com/api/system/shadow-metrics | jq .

  # Watch shadow logs in real-time
  docker logs -f mission-control-ui | grep '\[TXT\]\[SHADOW'

  # Dashboard: shadow OK events (backend working)
  docker logs --tail 500 mission-control-ui | grep '\[TXT\]\[SHADOW_OK\]' | wc -l

  # Dashboard: shadow FAIL events (backend errors)
  docker logs --tail 500 mission-control-ui | grep '\[TXT\]\[SHADOW_FAIL\]' | wc -l

  # Dashboard: shadow DIFF events (data divergence)
  docker logs --tail 500 mission-control-ui | grep '\[TXT\]\[SHADOW_DIFF\]' | wc -l

Exit Criteria for Phase 1:
  ✅ Backend endpoints all implemented (no 404s)
  ✅ shadow_diff events < 5 per 1000 calls
  ✅ Backend latency P99 < 500ms consistently
  ✅ Error rate < 0.5% for 24+ hours
  ✅ QA sign-off: no divergence issues critical enough to block


================================================================================
📊 PHASE 2 — GRADUAL ROLLOUT (DUAL MODE)
================================================================================

Duration: Week 3 (2026-04-05 → 2026-04-11)

Goal:
  Start using real backend for subset of users
  Detect issues early with real traffic (small blast radius)
  Validate data matches fallback in production conditions

Configuration Change:
  shadowOnly: false          ← CHANGE
  dualMode: true             ← ENABLE
  rolloutPercentage: 10      ← START 10% USERS

Rollout Stages:
  1. 10% users (canary)    — 2026-04-06
  2. 50% users (ramp)      — 2026-04-08 (if canary OK)
  3. 100% users (GA)       — 2026-04-10 (if ramp OK)

For Each Stage Change:
  1. Update SHADOW_CONFIG rolloutPercentage in route handlers
  2. Rebuild Next.js container: docker compose up -d --build mission-control-ui
  3. Monitor metrics for 30+ minutes before next stage
  4. Check: error_rate still < 0.5%, latency stable, no new divergence patterns

Success Metrics (Per Stage):
  - Error rate remains < 0.5%
  - Latency P99 stable (no spikes)
  - New divergence issues < 2% of calls
  - User complaints = 0

Monitoring During Rollout:
  # Real-time dual mode usage
  docker logs -f mission-control-ui | grep '\[TXT\]\[SHADOW_METRIC\]' | grep 'dual'

  # Count dual success vs fallback
  docker logs --tail 1000 mission-control-ui | \
    grep '\[TXT\]\[SHADOW_METRIC\]' | \
    jq -r '.type' | sort | uniq -c

  # Latency check (per route)
  docker logs --tail 500 mission-control-ui | \
    grep '\[TXT\]\[SHADOW_METRIC\]' | \
    jq '.latency_ms' | awk '{sum+=$1; count++} END {print "Avg:", sum/count}'

Rollback Procedure (if issues):
  # Immediately revert to shadow mode
  1. Set rolloutPercentage: 0 in SHADOW_CONFIG
  2. Set shadowOnly: true
  3. Rebuild UI: docker compose up -d --build mission-control-ui
  4. Verify: docker logs mission-control-ui | grep '\[TXT\]\[SHADOW'
  5. Alert: notify team of rollback reason


================================================================================
📊 PHASE 3 — PRODUCTION (FULL BACKEND)
================================================================================

Duration: Week 4+ (2026-04-12 → )

Goal:
  100% traffic on real backend
  Remove fallback code (keep for emergencies only)
  Stabilize platform long-term

Configuration Final:
  shadowOnly: false
  dualMode: false            ← DISABLE (no more fallback logic)
  rolloutPercentage: 100     ← ALL USERS

Steps:
  1. Monitor Phase 2 (100% users) for 48+ hours
  2. Confirm: zero fallback_rate (< 0.1%), error_rate stable
  3. Remove fallback handlers from route files (optional, keep for safety)
  4. Simplify shadowMode logic (or keep for emergency bypasses)
  5. Document lessons learned, update runbooks


================================================================================
🔧 CONCRETE IMPLEMENTATION STEPS
================================================================================

Step 1 — Deploy to Production (Already Done)
  ✓ shadowMode.ts utility implemented
  ✓ Route handlers updated (auth/preferences, risk-history, summary)
  ✓ Metrics endpoint (/api/system/shadow-metrics) created
  ✓ Phase 1: shadowOnly=true, rolloutPercentage=0

Step 2 — Verify Shadow Mode Working (During Phase 1)
  docker logs mission-control-ui | grep '\[TXT\]\[SHADOW' | head -20
  Expected: [TXT][SHADOW_OK] and [TXT][SHADOW_FAIL] events visible

Step 3 — Measure Baseline (End of Week 1, Phase 1)
  curl -s https://app.txt.gtixt.com/api/system/shadow-metrics | jq '.'
  Expected fallback_rate: 0% (UI still using fallback)
  Expected shadow_diff: < 2%

Step 4 — Prepare for Phase 2 Rollout
  # File: /opt/txt/ui/mission-control/app/api/auth/preferences/route.ts
  # File: /opt/txt/ui/mission-control/app/api/mt5/orders/risk-history/route.ts
  # File: /opt/txt/ui/mission-control/app/api/mt5/orders/risk-history/summary/route.ts
  
  Change in each file:
  const SHADOW_CONFIG = {
    shadowOnly: false,         ← CHANGE (enable real data)
    dualMode: true,            ← ENABLE (fallback if backend fails)
    rolloutPercentage: 10,     ← START 10%
  };

Step 5 — Deploy Phase 2 (Canary 10%)
  # Update files with new config
  # Rebuild container
  docker compose up -d --build mission-control-ui
  
  # Verify active
  curl https://app.txt.gtixt.com/api/system/shadow-metrics | jq '.phases.current'
  Expected: "Phase 2: Gradual Rollout (10% users)"
  
  # Monitor for 1 hour
  watch -n 10 "docker logs --tail 500 mission-control-ui | grep '\[TXT\]\[SHADOW_METRIC\]' | tail -20"

Step 6 — Ramp to 50% (After Canary OK, 48 hrs)
  # Same update process
  rolloutPercentage: 50
  docker compose up -d --build mission-control-ui
  
  # Monitor for 2+ hours
  watch -n 10 "curl -s https://app.txt.gtixt.com/api/system/shadow-metrics | jq '.metrics_snapshot'"

Step 7 — GA 100% (After Ramp OK, 48 hrs)
  # Final config
  rolloutPercentage: 100
  docker compose up -d --build mission-control-ui
  
  # Monitor for 24+ hours
  # Confirm: zero incidents, error_rate < 0.5%

Step 8 — Optional: Remove Fallback Code (Week 4+)
  # If fully stable for 1+ weeks, can simplify:
  # - Remove fallback logic from shadow mode
  # - Keep routes as-is but no more comparison
  # - Fallback remains as emergency escape hatch


================================================================================
⚠️ INCIDENT RESPONSE (If Things Go Wrong)
================================================================================

Scenario 1: Backend throws 500 errors
  Severity: HIGH
  Action: Immediate rollback to Phase 1 (shadowOnly=true, rolloutPercentage=0)
  Procedure:
    1. Set rolloutPercentage: 0 in all SHADOW_CONFIG
    2. docker compose up -d --build mission-control-ui
    3. Verify: curl api/system/shadow-metrics | jq '.fallback_rate'
              Should show 0% (UI back on fallback)
    4. Alert backend team

Scenario 2: Data divergence > 5% of calls
  Severity: MEDIUM
  Action: Hold Phase 2 rollout at current %
  Procedure:
    1. Halt rollout (don't increase rolloutPercentage)
    2. Investigate shadow_diff logs
    3. Run QA suite to isolate issue
    4. Fix backend or adjust comparison logic
    5. Resume after fix confirmed

Scenario 3: Latency spike (P99 > 1s)
  Severity: MEDIUM
  Action: Gradual regression (drop % of users on backend)
  Procedure:
    1. If Phase 2: reduce rolloutPercentage (e.g., 50% → 10%)
    2. docker compose up -d --build mission-control-ui
    3. Monitor latency recovery
    4. Contact backend team

Scenario 4: User reports stale data / cache issues
  Severity: LOW-MEDIUM
  Action: Check backend vs fallback cache headers
  Procedure:
    1. Verify response Cache-Control headers
    2. Check if backend respects stale-while-revalidate
    3. Adjust cache strategy if needed


================================================================================
🎯 SUCCESS LOOKS LIKE (2-Week Checkpoint)
================================================================================

✅ Phase 1 Complete (End of Week 2):
   - Backend endpoints respond 200 OK consistently
   - shadow_diff events < 1 per 100 calls
   - Fallback rate: 0% (UI using fallback, not real data)
   - Error rate: < 0.2%
   - Team confidence: HIGH

✅ Phase 2 Complete (End of Week 3):
   - 100% canary (10% users) sees real data
   - No new incidents reported
   - Latency P99: < 500ms
   - User satisfaction: unchanged (imperceptible swap)

✅ Phase 3 Complete (End of Week 4):
   - 100% users on real backend
   - Fallback only for emergencies (not triggered)
   - System stable, predictable
   - Ready for feature development


================================================================================
📋 CHECKLIST FOR SRE / OPS TEAM
================================================================================

Phase 1 Checklist (Week 1-2):
  ☐ Deploy shadow mode code to production
  ☐ Verify shadow logs visible in docker
  ☐ Run metrics endpoint: /api/system/shadow-metrics
  ☐ Set up alerts for shadow_diff > 5%
  ☐ Set up alerts for shadow error_rate > 1%
  ☐ Daily review: shadow metrics snapshot
  ☐ Backend team: confirm endpoints stable

Phase 2 Canary (Week 3, Day 1):
  ☐ Prepare config changes (rolloutPercentage: 10)
  ☐ PR review & approval
  ☐ Deploy to staging first (verify no build errors)
  ☐ Deploy to production (10% rollout)
  ☐ Watch metrics for 1 hour
  ☐ Check error_rate, latency, divergence
  ☐ Decision: proceed or rollback?

Phase 2 Ramp (Week 3, Day 3):
  ☐ Canary metrics look good?
  ☐ Deploy to 50%
  ☐ Watch for 2 hours
  ☐ Decision: proceed to 100% or investigate?

Phase 2 GA (Week 3, Day 5):
  ☐ Ramp metrics look good?
  ☐ Deploy to 100%
  ☐ Watch for 24 hours
  ☐ Confirm: error_rate stable, latency OK, no user complaints

Phase 3 (Week 4+):
  ☐ Monitor Phase 2 GA for 48+ hours
  ☐ All clear? Archive fallback code (optional cleanup)
  ☐ Update runbooks: remove "rollback to fallback" procedures
  ☐ Celebrate! 🚀


================================================================================
END STRATEGY DOCUMENT
================================================================================
