# TXT Healthwatch Contract and Retention 001

## Scope

This rail repairs the control-plane market snapshot contract and prevents
Healthwatch from persisting a complete diagnostic bundle for every repetition
of the same incident.

It does not change trading, execution, risk, order routing, market ingestion,
PostgreSQL, or broker behavior.

## Root cause

The control plane calculated OHLCV and depth data but omitted `ohlcv_rows` and
`depth_snapshot` from the serialized response. Mission Control treated the
missing fields as `control_plane_snapshot_unavailable`. Healthwatch then
persisted a full diagnostic capture every minute.

## Snapshot contract

The canonical contract is `txt.market-bus-snapshot.v1`.

- `AVAILABLE`: OHLCV is present and fresh, depth and trades are present, and
  the observation timestamp is valid.
- `DEGRADED`: OHLCV remains usable but a non-fatal component such as depth is
  absent.
- `UNAVAILABLE`: OHLCV is absent, empty, stale, malformed, or the contract
  version/observation timestamp is invalid.

The consumer fails closed. It never invents missing market data.

## Incident artifact policy

- First failure: one full capture.
- Same signature: increment the occurrence counter only.
- Signature change: one full capture.
- Recovery: one full capture.
- Unchanged active incident: at most one full capture per hour.
- Active incident: at most one compact daily summary.

Event count and artifact count are distinct. The historical false-positive
sequence of 78,931 occurrences remains documented separately from the new
governed incident sequence.

Latest state files use same-filesystem temporary files, flush/fsync, and
`os.replace()` so readers never observe a partially written JSON document.

## Retention policy prepared, not activated

- Raw full diagnostics: 7 days.
- Incident transitions: 90 days, compressed.
- Traditional logs: daily rotation and early rotation at 100 MiB.
- Latest state: always retained.

The retention planner and logrotate configuration are source-only in this
rail. They must not be activated before a separate, timestamped historical
cohort is frozen and explicitly authorized for deletion.

## Runtime evidence

- Source patch SHA-256:
  `bca46691eab0e499d6753329d0f3ba1ec17d29f1e828b1c63be7f40ccf950823`
- Rollback manifest SHA-256:
  `6c9c0a14fac529db7bb7c73fd377b95c0b27f742ed2a090d6158050d4af46456`
- Runtime checkpoint SHA-256:
  `48f9fc63bc229ba043856f69b29fd4e29621b388ef61af969a2cbbc41d17192d`

The bounded runtime activation passed 15 consecutive Healthwatch cycles:

- false offline resolved;
- TXT 18/18 healthy;
- no repeated critical capture after the recovery transition;
- GTIXT, PostgreSQL, MinIO, and ingress remained healthy;
- rollback was not used.

## Validation status

- Targeted Python tests: PASS.
- Targeted Mission Control contract tests: PASS.
- Modified TypeScript rail errors: 0.
- Global TypeScript check: FAIL because of 18 pre-existing errors in unrelated
  E2E tests.

The unrelated TypeScript debt must remain explicit and be handled in a
separate rail. This change must remain a draft and must not be merged solely to
make the repository appear globally green.

## Rollback

The byte-for-byte rollback manifest is stored outside the repository at:

`/opt/decommission/txt-storage/healthwatch-gate2b-rollback/ROLLBACK_MANIFEST.json`

Rollback restores the seven previous files, removes only the four paths that
were absent before activation, restarts only `control-plane` if necessary, and
flips Mission Control back to the preserved green slot.
