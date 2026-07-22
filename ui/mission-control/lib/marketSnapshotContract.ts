export const MARKET_SNAPSHOT_CONTRACT_VERSION = "txt.market-bus-snapshot.v1";

export type MarketSnapshotAvailability = "AVAILABLE" | "DEGRADED" | "UNAVAILABLE";

export type MarketSnapshotAssessment = {
  state: MarketSnapshotAvailability;
  valid: boolean;
  reasons: string[];
  observedAt: string | null;
  ageMs: number | null;
};

type JsonMap = Record<string, unknown>;

function record(value: unknown): JsonMap {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonMap
    : {};
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function latestBarTimestamp(rows: unknown[]): number | null {
  let latest: number | null = null;
  for (const row of rows) {
    const item = record(row);
    const candidate = parseTimestamp(item.t ?? item.bucket_start ?? item.time ?? item.timestamp ?? item.ts);
    if (candidate !== null && (latest === null || candidate > latest)) {
      latest = candidate;
    }
  }
  return latest;
}

export function assessMarketSnapshot(
  payload: unknown,
  options: { nowMs?: number; maxSnapshotAgeMs?: number; maxBarAgeMs?: number } = {},
): MarketSnapshotAssessment {
  const body = record(payload);
  const nowMs = options.nowMs ?? Date.now();
  const maxSnapshotAgeMs = options.maxSnapshotAgeMs ?? 120_000;
  const maxBarAgeMs = options.maxBarAgeMs ?? 120_000;
  const reasons: string[] = [];

  if (body.contract_version !== MARKET_SNAPSHOT_CONTRACT_VERSION) {
    reasons.push("contract_version_missing_or_unsupported");
  }
  if (!Array.isArray(body.ohlcv_rows)) {
    reasons.push("ohlcv_rows_missing");
  } else if (body.ohlcv_rows.length === 0) {
    reasons.push("ohlcv_rows_empty");
  }

  const observedAtRaw = body.as_of ?? record(body.observation).observed_at;
  const observedAtMs = parseTimestamp(observedAtRaw);
  if (observedAtMs === null) {
    reasons.push("observation_timestamp_missing_or_invalid");
  } else if (Math.max(0, nowMs - observedAtMs) > maxSnapshotAgeMs) {
    reasons.push("snapshot_stale");
  }

  if (Array.isArray(body.ohlcv_rows) && body.ohlcv_rows.length > 0) {
    const healthComponents = record(record(record(body.meta).health).components);
    const componentFreshnessRaw = record(healthComponents.ohlcv).freshness_ms;
    const componentFreshness = typeof componentFreshnessRaw === "number" ? componentFreshnessRaw : NaN;
    const latestBar = latestBarTimestamp(body.ohlcv_rows);
    const barAgeMs = Number.isFinite(componentFreshness) && componentFreshness >= 0
      ? Math.max(0, componentFreshness)
      : (latestBar === null ? null : Math.max(0, nowMs - latestBar));
    if (barAgeMs === null) {
      reasons.push("ohlcv_timestamp_missing_or_invalid");
    } else if (barAgeMs > maxBarAgeMs) {
      reasons.push("ohlcv_stale");
    }
  }

  const fatalReasons = new Set([
    "contract_version_missing_or_unsupported",
    "ohlcv_rows_missing",
    "ohlcv_rows_empty",
    "observation_timestamp_missing_or_invalid",
    "snapshot_stale",
    "ohlcv_timestamp_missing_or_invalid",
    "ohlcv_stale",
  ]);
  if (reasons.some((reason) => fatalReasons.has(reason))) {
    return {
      state: "UNAVAILABLE",
      valid: false,
      reasons,
      observedAt: typeof observedAtRaw === "string" ? observedAtRaw : null,
      ageMs: observedAtMs === null ? null : Math.max(0, nowMs - observedAtMs),
    };
  }

  if (!body.depth_snapshot || typeof body.depth_snapshot !== "object" || Array.isArray(body.depth_snapshot)) {
    reasons.push("depth_snapshot_missing");
  }
  if (!Array.isArray(body.trades) || body.trades.length === 0) {
    reasons.push("trades_missing");
  }

  return {
    state: reasons.length > 0 ? "DEGRADED" : "AVAILABLE",
    valid: true,
    reasons,
    observedAt: typeof observedAtRaw === "string" ? observedAtRaw : null,
    ageMs: observedAtMs === null ? null : Math.max(0, nowMs - observedAtMs),
  };
}

export function shouldUseCanonicalSnapshot(responseOk: boolean, assessment: MarketSnapshotAssessment): boolean {
  return responseOk && assessment.valid;
}

export function attachMarketSnapshotAssessment(payload: unknown, assessment: MarketSnapshotAssessment): JsonMap {
  const body = record(payload);
  const meta = record(body.meta);
  return {
    ...body,
    availability: assessment.state,
    meta: {
      ...meta,
      contract: assessment,
    },
  };
}
