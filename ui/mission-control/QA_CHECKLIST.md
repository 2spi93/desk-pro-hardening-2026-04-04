# QA Checklist (Executable)

This checklist is designed for repeatable smoke and UI regression validation before deploying terminal risk/compliance changes.

## Prerequisites

- Node.js and npm installed
- Docker installed and running
- Control-plane API reachable for terminal risk endpoints

## Smoke QA

Run:

```bash
npm run qa:smoke
```

What it executes:

1. `node scripts/risk-workspace.integration.js`
2. `npm run build`

Acceptance criteria:

- Integration script exits with code 0
- Next.js production build succeeds with no compile errors
- No runtime exceptions related to risk timeline configuration persistence

## UI Regression QA

Run:

```bash
npm run qa:ui-regression
```

What it executes:

1. Runs Playwright tests inside pinned image `mcr.microsoft.com/playwright:v1.58.2-jammy`
2. Executes `npm ci --no-audit --no-fund && npm run test:e2e` in that container

Acceptance criteria:

- Playwright docker image starts and test command executes in-container
- E2E suite passes, including risk workspace persistence behavior
- No blocking visual regression in risk timeline controls or hard-alert indicators

Notes:

- This avoids host/compose OS binary mismatches that can cause `chrome-headless-shell ENOENT` false negatives.
- You can override image and base URL if needed with `PLAYWRIGHT_DOCKER_IMAGE`, `PLAYWRIGHT_BASE_URL`, and `PLAYWRIGHT_WEB_SERVER_COMMAND`.
- E2E dev runs set `MC_E2E_DEV_DEGRADED=1` by default to consolidate non-blocking control-plane fetch noise into deduplicated degraded warnings.

## Full Pass

Run:

```bash
npm run qa:all
```

Host-independent (recommended, no host npm required):

```bash
sh /opt/txt/qa-mission-control.sh
```

Real control-plane validation (staging/prod-like):

```bash
MC_E2E_DEV_DEGRADED=0 sh /opt/txt/qa-mission-control.sh
```

Strict real control-plane gate (fails on connection/refusal or degraded markers):

```bash
npm run qa:real-control-plane
```

Profiled strict gate (staging/prod):

```bash
# default profile is staging
npm run qa:real-control-plane

# explicit profile
sh scripts/qa-real-control-plane.sh staging
sh scripts/qa-real-control-plane.sh prod
```

Profile files to inject:

- `ui/mission-control/.env.control-plane.staging`
- `ui/mission-control/.env.control-plane.prod`

Acceptance criteria:

- Smoke and UI regression both pass in a single run
- Strict real control-plane gate passes without `ECONNREFUSED` or degraded fallback markers
- Ready to proceed to Sprint 1 continuation and premium chart visual pass
