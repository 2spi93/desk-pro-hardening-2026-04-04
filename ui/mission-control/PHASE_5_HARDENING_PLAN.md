# Phase 5 - Product Hardening

Status: Completed

## Objective

Harden mission-control UI runtime quality for production by upgrading vulnerable dependencies and reducing noisy non-blocking backend errors during dev e2e.

## Scope

1. Security patching
- Upgrade Next.js from 14.2.30 to a patched 14.2.x release.
- Keep lockfile in sync and validate build integrity.

2. E2E backend-warning consolidation
- Introduce a controlled degraded mode for control-plane fetches during e2e dev.
- Replace repetitive stack traces with compact deduplicated warnings.
- Preserve non-blocking behavior while keeping test determinism.

3. QA hardening
- Validate with host-independent wrapper command:
  - `sh /opt/txt/qa-mission-control.sh`

## Exit Criteria

- Next.js patched version is active in package and lockfile.
- Smoke QA passes.
- Playwright docker regression passes.
- E2E dev output no longer floods with repeated `TypeError: fetch failed` stack traces from control-plane unavailability.

## Work Log

- 2026-03-21: Phase 5 opened.
- 2026-03-21: Upgraded Next.js target to 15.5.10 (non-deprecated secure target; avoids Next 16 route-handler breaking changes) and enabled e2e-dev degraded control-plane fetch mode with deduplicated warnings.
- 2026-03-21: Next 15 compatibility fixes applied (dynamic route params Promise context + async cookies API), full wrapper QA green; Phase 5 closed.
