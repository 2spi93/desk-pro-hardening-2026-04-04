# Hard Alert Validation With Product Team

## Scope

Validate hard-alert behavior by preset and workspace, including persistence, reset behavior, and banner activation thresholds.

## Preconditions

- Terminal page is reachable.
- At least one account is loaded.
- Risk timeline panel visible.

## Functional Matrix

1. Swing preset baseline
- Set preset to Swing.
- Confirm Threshold = 3, Window = 10 after reset.
- Confirm Hard alert toggle = off.
- Confirm Hard % = 60.

2. Scalp preset baseline
- Set preset to Scalp.
- Confirm Threshold = 4, Window = 12 after reset.
- Confirm Hard alert toggle = off.
- Confirm Hard % = 60.

3. Monitoring preset baseline
- Set preset to Monitoring.
- Confirm Threshold = 2, Window = 8 after reset.
- Confirm Hard alert toggle = off.
- Confirm Hard % = 60.

4. Workspace persistence
- In workspace A, set Hard alert = on and Hard % = 72.
- Save/switch to workspace B; set Hard alert = off and Hard % = 60.
- Return to workspace A and confirm on/72 restored.
- Return to workspace B and confirm off/60 restored.

5. Reset behavior per active preset
- In active workspace, click reset.
- Confirm values return to preset defaults including Hard alert and Hard %.
- Reload page and confirm values remain defaulted.

6. Hard-alert activation logic
- With Hard alert = on and Hard % set to a known value (e.g. 65), ensure local/global hard-alert banners appear only when ratio miss >= Hard %.
- Lower ratio below threshold and confirm banners disappear.

## Product Sign-off Table

| Item | Product Owner | Status | Notes | Date |
| --- | --- | --- | --- | --- |
| Swing baseline |  | Pending |  |  |
| Scalp baseline |  | Pending |  |  |
| Monitoring baseline |  | Pending |  |  |
| Workspace persistence |  | Pending |  |  |
| Reset behavior |  | Pending |  |  |
| Activation logic |  | Pending |  |  |

## Current Automation Coverage

- Integration smoke: risk workspace reset/persistence flow includes hard-alert fields.
- E2E UI: reset/reload flow includes Hard alert toggle and Hard % assertions.
