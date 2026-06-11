export const LEGACY_WATCHDOG_SUPERSESSION_SCHEMA_VERSION = "legacy-watchdog-supersession/v1" as const;

export type LegacyWatchdogSupersessionDeclaration = {
  schema_version: typeof LEGACY_WATCHDOG_SUPERSESSION_SCHEMA_VERSION;
  declared: boolean;
  stream: "txt.watchdog";
  legacy_publisher: string;
  superseded_by: string;
  declared_at: string;
  declared_by: string;
  evidence: string[];
  reason: string;
  conditions: {
    transport_must_be_online: true;
    live_observation_must_be_online: true;
    legacy_publisher_recovery_takes_precedence: true;
  };
};

// Governance artifact: formal supersession of the legacy txt.watchdog Redis
// channel by live_observation. Versioned in git on purpose — changing this
// declaration must go through review, not runtime mutation.
//
// The declaration only takes effect at scan time when its conditions hold
// (transport online AND live_observation online). If a txt.watchdog writer
// ever publishes again, legacy_publisher_recovered takes precedence and this
// declaration becomes dormant.
export const LEGACY_WATCHDOG_SUPERSESSION: LegacyWatchdogSupersessionDeclaration = {
  schema_version: LEGACY_WATCHDOG_SUPERSESSION_SCHEMA_VERSION,
  declared: true,
  stream: "txt.watchdog",
  legacy_publisher: "control-plane/runtime-headless",
  superseded_by: "live_observation:execution-router/health",
  declared_at: "2026-06-11T19:45:00+00:00",
  declared_by: "operator:2spi93",
  evidence: [
    "txt.watchdog last entry 2026-05-23T13:24:13Z, producer_id control-plane/runtime-headless (10004 entries, runtime-event/v6)",
    "no XADD writer for txt.watchdog exists in the deployed tree; writer came from unmerged headless-runtime cutover work (stash 979ec72, 2026-05-22)",
    "stream has zero consumer groups since creation: nothing ever consumed txt.watchdog (runbook classification D)",
    "kill switch BUS_OFFLINE detection already sources from live observation: execution-router observation bus age and control-plane opportunity gate refresh, not from txt.watchdog",
    "live_observation (execution-router/health) is continuous, headless, and covers the watchdog evaluation role end to end",
  ],
  reason: "live_observation_supersedes_legacy_watchdog_consumer",
  conditions: {
    transport_must_be_online: true,
    live_observation_must_be_online: true,
    legacy_publisher_recovery_takes_precedence: true,
  },
};
