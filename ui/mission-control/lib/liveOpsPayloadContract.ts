import {
  assertCanonicalSpineHealthSnapshot,
  CANONICAL_SPINE_HEALTH_SCHEMA_VERSION,
  type CanonicalSpineHealthSnapshot,
} from "./canonicalSpineHealth";
import {
  assertHardeningAnalyticsSnapshot,
  HARDENING_ANALYTICS_SCHEMA_VERSION,
  type HardeningAnalyticsSnapshot,
} from "./hardeningAnalytics";
import {
  assertTradeLifecycleHealthSnapshot,
  TRADE_LIFECYCLE_HEALTH_SCHEMA_VERSION,
  type TradeLifecycleHealthSnapshot,
} from "./tradeLifecycleHealth";

type JsonMap = Record<string, unknown>;

export type LiveOpsPayloadSchemaVersion = "live-ops/v1";

export const LIVE_OPS_PAYLOAD_SCHEMA_VERSION: LiveOpsPayloadSchemaVersion = "live-ops/v1";

export type LiveOpsCriticalPayload = {
  schema_version: LiveOpsPayloadSchemaVersion;
  status: string;
  generated_at: string;
  canonical_spine: CanonicalSpineHealthSnapshot;
  trade_lifecycle_health: TradeLifecycleHealthSnapshot;
  hardening_analytics_30d: HardeningAnalyticsSnapshot;
  live_ops_diagnostics: JsonMap;
  controlled_live_ramp_gate?: JsonMap;
  raw: JsonMap;
};

function asRecord(value: unknown): JsonMap {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonMap
    : {};
}

export function assertLiveOpsCriticalPayload(payload: unknown): LiveOpsCriticalPayload {
  const snapshot = asRecord(payload);
  if (String(snapshot.schema_version || "") !== LIVE_OPS_PAYLOAD_SCHEMA_VERSION) {
    throw new Error(`LiveOps schema mismatch: ${String(snapshot.schema_version || "missing")}`);
  }
  if (String(snapshot.status || "") !== "ok") {
    throw new Error(`LiveOps status invalid: ${String(snapshot.status || "missing")}`);
  }
  if (!Number.isFinite(Date.parse(String(snapshot.generated_at || "")))) {
    throw new Error("LiveOps generated_at invalid");
  }
  const canonicalSpine = assertCanonicalSpineHealthSnapshot(snapshot.canonical_spine as CanonicalSpineHealthSnapshot);
  const tradeLifecycleHealth = assertTradeLifecycleHealthSnapshot(snapshot.trade_lifecycle_health as TradeLifecycleHealthSnapshot);
  const hardeningAnalytics = assertHardeningAnalyticsSnapshot(snapshot.hardening_analytics_30d as HardeningAnalyticsSnapshot);
  const diagnostics = asRecord(snapshot.live_ops_diagnostics);
  if (!Number.isFinite(Number(diagnostics.aggregate_window_days || Number.NaN))) {
    throw new Error("LiveOps aggregate_window_days invalid");
  }
  if (typeof diagnostics.projection_source_audits !== "object" || Array.isArray(diagnostics.projection_source_audits)) {
    throw new Error("LiveOps projection_source_audits invalid");
  }
  const raw = asRecord(snapshot.raw);
  const controlledLiveRampGate = asRecord(snapshot.controlled_live_ramp_gate);
  const runtimeTruth = asRecord(raw.runtime_truth);
  if (Object.keys(runtimeTruth).length > 0 && String(runtimeTruth.schema_version || "") !== "runtime-truth/v1") {
    throw new Error(`LiveOps runtime_truth schema mismatch: ${String(runtimeTruth.schema_version || "missing")}`);
  }
  if (String(asRecord(snapshot.canonical_spine).schema_version || "") !== CANONICAL_SPINE_HEALTH_SCHEMA_VERSION) {
    throw new Error("LiveOps canonical_spine contract mismatch");
  }
  if (String(asRecord(snapshot.trade_lifecycle_health).schema_version || "") !== TRADE_LIFECYCLE_HEALTH_SCHEMA_VERSION) {
    throw new Error("LiveOps trade_lifecycle_health contract mismatch");
  }
  if (String(asRecord(snapshot.hardening_analytics_30d).schema_version || "") !== HARDENING_ANALYTICS_SCHEMA_VERSION) {
    throw new Error("LiveOps hardening_analytics contract mismatch");
  }
  if (
    Object.keys(controlledLiveRampGate).length > 0
    && !["controlled-live-ramp-gate/v1", "controlled-live-ramp-gate/v1.1", "controlled-live-ramp-gate/v1.2", "controlled-live-ramp-gate/v1.3", "controlled-live-ramp-gate/v1.4", "controlled-live-ramp-gate/v1.5", "controlled-live-ramp-gate/v1.6", "controlled-live-ramp-gate/v1.7", "controlled-live-ramp-gate/v1.8", "controlled-live-ramp-gate/v1.9", "controlled-live-ramp-gate/v2.0"].includes(String(controlledLiveRampGate.schema_version || ""))
  ) {
    throw new Error(`LiveOps controlled_live_ramp_gate schema mismatch: ${String(controlledLiveRampGate.schema_version || "missing")}`);
  }
  return {
    schema_version: LIVE_OPS_PAYLOAD_SCHEMA_VERSION,
    status: "ok",
    generated_at: String(snapshot.generated_at),
    canonical_spine: canonicalSpine,
    trade_lifecycle_health: tradeLifecycleHealth,
    hardening_analytics_30d: hardeningAnalytics,
    live_ops_diagnostics: diagnostics,
    controlled_live_ramp_gate: Object.keys(controlledLiveRampGate).length > 0 ? controlledLiveRampGate : undefined,
    raw,
  };
}
