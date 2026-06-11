import { NextResponse } from "next/server";

import { requireControlPlaneSession } from "../../../../lib/apiAuth";
import { buildCanonicalSpineHealthSnapshot, inspectCanonicalSpineSnapshotCache } from "../../../../lib/canonicalSpineHealth";
import { cpFetchJsonSafe, getControlPlaneNetworkMetricsSnapshot, type ControlPlaneNetworkMeta } from "../../../../lib/controlPlane";
import { buildControlledLiveRampGateReport, buildLifecyclePublishGateReportFromSnapshot, toNumber as toControlledLiveRampGateNumber } from "../../../../lib/controlledLiveRampGate";
import { getEdgeObservationSummary, type EdgeObservationSummary } from "../../../../lib/edgeObservation";
import { buildHardeningAnalyticsSnapshot } from "../../../../lib/hardeningAnalytics";
import { appendLiveOpsDiagnosticsSample, readLiveOpsDiagnosticsWindowSummary } from "../../../../lib/liveOpsDiagnosticsJournal";
import { assertLiveOpsCriticalPayload, LIVE_OPS_PAYLOAD_SCHEMA_VERSION, type LiveOpsCriticalPayload } from "../../../../lib/liveOpsPayloadContract";
import { computeExecutionDomination } from "../../../../lib/liveOps/executionDominationEngine";
import { classifyMarketState } from "../../../../lib/liveOps/marketStateEngine";
import { detectSmartMoney } from "../../../../lib/liveOps/smartMoneyDetector";
import { detectSpoofing } from "../../../../lib/liveOps/spoofDetectionEngine";
import { evaluateVenueArbitrage, type VenueQuoteSnapshot } from "../../../../lib/liveOps/venueArbitrageEngine";
import { buildRuntimeTruthSnapshot, inspectRuntimeTruthCache } from "../../../../lib/runtimeTruth";
import { getMetricsSnapshot } from "../../../../lib/shadowMode";
import { readSourceTreeProvenanceAudit } from "../../../../lib/sourceTreeProvenance";
import { buildTradeLifecycleHealthSnapshot } from "../../../../lib/tradeLifecycleHealth";
import { buildTruthReliabilitySnapshot, type TruthReliabilitySnapshot } from "../../../../lib/truthReliabilityIndex";

type JsonMap = Record<string, unknown>;

function asRecord(value: unknown): JsonMap {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonMap) : {};
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function toNumber(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function average(values: number[], fallback = 0): number {
  if (values.length === 0) {
    return fallback;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function dedupeNonEmptyStrings(values: Array<unknown>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

const WATCHDOG_FRESHNESS_WINDOW_MS = 30 * 60 * 1000;
const LIVE_OPS_CORE_CP_FETCH_TIMEOUT_MS = 3_500;
const LIVE_OPS_OPTIONAL_CP_FETCH_TIMEOUT_MS = 1_800;
const LIVE_OPS_EDGE_OBSERVATION_TIMEOUT_MS = 700;
const LIVE_OPS_SERVER_TRUTH_TIMEOUT_MS = 1_800;
// Projections call control-plane and Postgres; 1.5s turned any contention
// (ops scans, deploy warmups) into null snapshots that crashed the contract.
const LIVE_OPS_SERVER_PROJECTION_TIMEOUT_MS = Math.max(
  1_500,
  Number(process.env.LIVE_OPS_SERVER_PROJECTION_TIMEOUT_MS || 8_000),
);
const LIVE_OPS_SOURCE_TREE_PROVENANCE_TIMEOUT_MS = 700;
const LIVE_OPS_DIAGNOSTICS_HISTORY_TIMEOUT_MS = 250;
const LIVE_OPS_UI_CACHE_TTL_MS = Math.max(1_000, Math.min(15_000, toNumber(process.env.LIVE_OPS_UI_CACHE_TTL_MS, 5_000)));
const RUNTIME_TRUTH_TRI_TTL_MS = Math.max(1_000, toNumber(process.env.RUNTIME_TRUTH_SNAPSHOT_TTL_MS, 15_000));
const CANONICAL_SPINE_TRI_TTL_MS = Math.max(1_000, toNumber(process.env.CANONICAL_SPINE_SNAPSHOT_TTL_MS, 60_000));

type LiveOpsResponseCacheEntry = {
  payload: LiveOpsCriticalPayload;
  expiresAtMs: number;
  generatedAtMs: number;
};

type LiveOpsRouteRequestMetrics = {
  total: number;
  ui_hit: number;
  ui_miss: number;
  bypass: number;
  updated_at: string;
};

const liveOpsRouteGlobal = globalThis as typeof globalThis & {
  __mcLiveOpsUiResponseCache?: Map<string, LiveOpsResponseCacheEntry>;
  __mcLiveOpsRouteRequestMetrics?: LiveOpsRouteRequestMetrics;
};
const liveOpsUiResponseCache = liveOpsRouteGlobal.__mcLiveOpsUiResponseCache || new Map<string, LiveOpsResponseCacheEntry>();
if (!liveOpsRouteGlobal.__mcLiveOpsUiResponseCache) {
  liveOpsRouteGlobal.__mcLiveOpsUiResponseCache = liveOpsUiResponseCache;
}
const liveOpsRouteRequestMetrics = liveOpsRouteGlobal.__mcLiveOpsRouteRequestMetrics || {
  total: 0,
  ui_hit: 0,
  ui_miss: 0,
  bypass: 0,
  updated_at: new Date(0).toISOString(),
};
if (!liveOpsRouteGlobal.__mcLiveOpsRouteRequestMetrics) {
  liveOpsRouteGlobal.__mcLiveOpsRouteRequestMetrics = liveOpsRouteRequestMetrics;
}

type CpFetchJsonSafeResult = Awaited<ReturnType<typeof cpFetchJsonSafe>>;

function timedOutNetworkMeta(path: string): ControlPlaneNetworkMeta {
  return {
    network_state: "degraded",
    retry_count: 0,
    degraded_flag: true,
    failure_classification: "timeout",
    failure_detail: `Live Ops bounded fetch timed out for ${path}`,
    attempted_targets: [path],
    attempted_base_urls: [],
    upstream_status: 504,
  };
}

function timedOutCpFetchResult(path: string): CpFetchJsonSafeResult {
  const payload = { detail: "live_ops_control_plane_timeout", path };
  return {
    response: new Response(JSON.stringify(payload), { status: 504 }),
    payload,
    network: timedOutNetworkMeta(path),
  };
}

function normalizeLiveOpsRequestSource(value: unknown): "ui" | "scanner" | "service" | "unknown" {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "ui" || normalized === "scanner" || normalized === "service") {
    return normalized;
  }
  return "unknown";
}

function liveOpsCacheKey(input: { auditFilter: string; requestSource: string }): string {
  return JSON.stringify({
    auditFilter: input.auditFilter,
    requestSource: input.requestSource,
  });
}

function buildLiveOpsResponse(
  payload: LiveOpsCriticalPayload,
  input: { cacheStatus: "hit" | "miss" | "stored" | "bypass"; requestSource: string; ageMs?: number },
): NextResponse {
  return NextResponse.json(payload, {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "X-Live-Ops-Cache": input.cacheStatus,
      "X-Live-Ops-Request-Source": input.requestSource,
      ...(typeof input.ageMs === "number" ? { "X-Live-Ops-Cache-Age-Ms": String(Math.max(0, Math.round(input.ageMs))) } : {}),
    },
  });
}

function recordLiveOpsRouteRequest(status: "ui_hit" | "ui_miss" | "bypass"): LiveOpsRouteRequestMetrics {
  liveOpsRouteRequestMetrics.total += 1;
  liveOpsRouteRequestMetrics[status] += 1;
  liveOpsRouteRequestMetrics.updated_at = new Date().toISOString();
  return { ...liveOpsRouteRequestMetrics };
}

function timedOutEdgeObservationSummary(): EdgeObservationSummary {
  return {
    available: false,
    filePath: "timeout",
    fileUpdatedAt: null,
    latestIntentAt: null,
    latestClassifiedIntentAt: null,
    staleness: {
      ageHours: null,
      level: "NO_CLASSIFIED_LABEL",
      summary: "Observation edge indisponible pendant le refresh Live Ops.",
    },
    windowHours: 24,
    totals: {
      totalRows: 0,
      classifiedRows: 0,
      unclassifiedRows: 0,
      recentRows: 0,
      recentClassifiedRows: 0,
      previousRows: 0,
      previousClassifiedRows: 0,
      classifiedPct: 0,
      recentClassifiedPct: 0,
    },
    labelProgress: {
      targetMin: 50,
      targetMax: 100,
      classifiedCount: 0,
      recentClassifiedCount: 0,
      toTargetMin: 50,
      toTargetMax: 100,
      progressToMinPct: 0,
      progressToMaxPct: 0,
      stage: "BOOTSTRAP",
      summary: "Observation edge indisponible pendant le refresh Live Ops.",
    },
    liveConfidence: {
      scorePct: 0,
      level: "LOW",
      summary: "Observation edge indisponible pendant le refresh Live Ops.",
    },
    recentDeltas: [],
    allTimeMap: [],
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<T>((resolve) => {
    timeoutId = setTimeout(() => resolve(fallback), timeoutMs);
  });
  return Promise.race([
    promise.finally(() => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }),
    timeoutPromise,
  ]);
}

async function withTimingAndTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  fallback: T,
): Promise<{
  value: T;
  duration_ms: number;
  timed_out: boolean;
  failed: boolean;
}> {
  const startedAtMs = Date.now();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<{
    value: T;
    duration_ms: number;
    timed_out: boolean;
    failed: boolean;
  }>((resolve) => {
    timeoutId = setTimeout(() => {
      resolve({
        value: fallback,
        duration_ms: Date.now() - startedAtMs,
        timed_out: true,
        failed: false,
      });
    }, timeoutMs);
  });
  const operationPromise = operation()
    .then((value) => ({
      value,
      duration_ms: Date.now() - startedAtMs,
      timed_out: false,
      failed: false,
    }))
    .catch(() => ({
      value: fallback,
      duration_ms: Date.now() - startedAtMs,
      timed_out: false,
      failed: true,
    }))
    .finally(() => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    });
  return Promise.race([operationPromise, timeoutPromise]);
}

function cpFetchJsonSafeBounded(path: string, timeoutMs = LIVE_OPS_CORE_CP_FETCH_TIMEOUT_MS): Promise<CpFetchJsonSafeResult> {
  const fallback = timedOutCpFetchResult(path);
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<CpFetchJsonSafeResult>((resolve) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      resolve(fallback);
    }, timeoutMs);
  });
  const fetchPromise = cpFetchJsonSafe(path, { signal: controller.signal })
    .catch(() => fallback)
    .finally(() => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    });
  return Promise.race([fetchPromise, timeoutPromise]);
}

function getEdgeObservationSummaryBounded(): Promise<EdgeObservationSummary> {
  return withTimeout(getEdgeObservationSummary(), LIVE_OPS_EDGE_OBSERVATION_TIMEOUT_MS, timedOutEdgeObservationSummary());
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function hasSyntheticHarnessMarker(row: JsonMap): boolean {
  const decisionId = String(row.decision_id || "").trim().toLowerCase();
  if (decisionId.startsWith("kairos-harness-seed")) {
    return true;
  }
  return asArray<string>(row.failure_reasons).some((reason) => String(reason).trim().toLowerCase() === "synthetic_harness_seed");
}

function isFreshOperationalRow(row: JsonMap, nowMs: number): boolean {
  const timestampMs = parseTimestampMs(row.created_at ?? row.timestamp ?? row.updated_at);
  return timestampMs !== null && timestampMs <= nowMs && (nowMs - timestampMs) <= WATCHDOG_FRESHNESS_WINDOW_MS;
}

function computeAdverseExecutionDriftScore(row: JsonMap): number {
  const gapSlippageBps = toNumber(row.gap_slippage_bps, 0);
  const gapFillProbability = toNumber(row.gap_fill_probability, 0);
  const gapLatencyMs = toNumber(row.gap_latency_ms, 0);
  return (Math.max(0, gapSlippageBps) * 0.04)
    + (Math.max(0, gapFillProbability) * 1.6)
    + (Math.max(0, gapLatencyMs) / 400);
}

function mapSystemMode(mode: string, killSwitchActive: boolean): "SAFE" | "LIVE" | "LOCKED" {
  if (killSwitchActive) {
    return "LOCKED";
  }
  if (mode === "managed_live") {
    return "LIVE";
  }
  return "SAFE";
}

function deriveExposureBySymbol(telemetryRows: JsonMap[]): Array<{ symbol: string; notionalUsd: number }> {
  const exposures = new Map<string, number>();
  for (const row of telemetryRows) {
    const symbol = String(row.symbol || "UNKNOWN").trim().toUpperCase() || "UNKNOWN";
    exposures.set(symbol, (exposures.get(symbol) || 0) + Math.abs(toNumber(row.lots, 0)));
  }
  return [...exposures.entries()]
    .map(([symbol, notionalUsd]) => ({ symbol, notionalUsd: Number(notionalUsd.toFixed(6)) }))
    .sort((left, right) => right.notionalUsd - left.notionalUsd)
    .slice(0, 6);
}

function buildRiskTimeline(outcomes: JsonMap[], exposures: Array<{ symbol: string; notionalUsd: number }>): JsonMap[] {
  const rows = [...outcomes].reverse();
  const dominantExposure = exposures[0]?.notionalUsd || 0;
  let cumulativePnLUsd = 0;
  let peakPnLUsd = 0;
  return rows.slice(-12).map((row) => {
    cumulativePnLUsd += toNumber(row.net_result_usd, 0);
    peakPnLUsd = Math.max(peakPnLUsd, cumulativePnLUsd);
    const drawdownUsd = peakPnLUsd - cumulativePnLUsd;
    const drawdownPct = dominantExposure > 0 ? (drawdownUsd / dominantExposure) * 100 : 0;
    return {
      at: String(row.updated_at || row.created_at || ""),
      dd_usd: Number(drawdownUsd.toFixed(4)),
      dd_pct: Number(drawdownPct.toFixed(4)),
      exposure_symbol: String(row.symbol || exposures[0]?.symbol || "UNKNOWN"),
      exposure_proxy: Number(Math.abs(toNumber(row.net_result_usd, 0)).toFixed(4)),
      decision: String(row.status || row.source || "UNKNOWN"),
    };
  });
}

function buildAuditTrail(auditRows: JsonMap[], telemetryRows: JsonMap[], realityGapRows: JsonMap[]): JsonMap[] {
  const telemetryByDecision = new Map<string, JsonMap>();
  for (const row of telemetryRows) {
    telemetryByDecision.set(String(row.decision_id || ""), row);
  }
  const gapByDecision = new Map<string, JsonMap>();
  for (const row of realityGapRows) {
    gapByDecision.set(String(row.decision_id || ""), row);
  }

  return auditRows
    .filter((row) => {
      const category = String(row.category || "");
      return category === "execution_telemetry_recorded" || category === "go_live_hardening_decision" || category === "live_order_cancelled";
    })
    .slice(0, 16)
    .map((row) => {
      const payload = asRecord(row.payload);
      const decisionId = String(payload.decision_id || "");
      const telemetry = telemetryByDecision.get(decisionId) || {};
      const gap = gapByDecision.get(decisionId) || {};
      const memoryGate = asRecord(asRecord(telemetry).pre_trade_memory_gate);
      return {
        at: String(row.timestamp || row.created_at || ""),
        decision_id: decisionId,
        decision: String(payload.route || payload.status || row.category || "UNKNOWN"),
        memory: memoryGate.block_execution ? "BLOCKED" : memoryGate.status ? String(memoryGate.status).toUpperCase() : "OK",
        risk: asArray<string>(asRecord(gap).failure_reasons).length > 0 ? "WATCH" : "OK",
        execution: String(payload.reason || payload.route || "AGGRESSIVE"),
        result: String(payload.status || row.category || "UNKNOWN").toUpperCase(),
        pnl: Number(toNumber(asRecord(gap).gap_impact_bps, 0).toFixed(4)),
        route: String(payload.route || asRecord(telemetry).route_chosen || "n/a"),
        slippage_bps: Number(toNumber(payload.realized_slippage_bps || asRecord(telemetry).realized_slippage_bps, 0).toFixed(4)),
        latency_ms: Number(toNumber(payload.latency_e2e_ms || asRecord(telemetry).latency_e2e_ms, 0).toFixed(0)),
      };
    });
}

function filterAuditTrailRows(rows: JsonMap[], auditFilter: string): JsonMap[] {
  const normalized = auditFilter.trim().toLowerCase();
  if (!normalized) {
    return rows;
  }
  return rows.filter((row) => {
    const decisionId = String(row.decision_id || "").toLowerCase();
    const decision = String(row.decision || "").toLowerCase();
    const route = String(row.route || "").toLowerCase();
    const execution = String(row.execution || "").toLowerCase();
    const result = String(row.result || "").toLowerCase();
    const compact = `${decisionId}|${decision}|${route}|${execution}|${result}`;
    return compact.includes(normalized);
  });
}

function computeDrawdownUsd(outcomes: JsonMap[]): number {
  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const row of [...outcomes].reverse()) {
    cumulative += toNumber(row.net_result_usd, 0);
    peak = Math.max(peak, cumulative);
    maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
  }
  return maxDrawdown;
}

export async function GET(request: Request): Promise<NextResponse> {
  const authError = await requireControlPlaneSession(request, { allowServiceProbe: true });
  if (authError) {
    return authError;
  }
  const url = new URL(request.url);
  const auditFilter = String(url.searchParams.get("audit_filter") || "").trim();
  const requestSource = normalizeLiveOpsRequestSource(url.searchParams.get("source") || request.headers.get("x-txt-request-source"));
  const shouldUseUiCache = requestSource === "ui" && !url.searchParams.has("fresh");
  const cacheKey = liveOpsCacheKey({ auditFilter, requestSource });
  const nowAtStartMs = Date.now();
  if (shouldUseUiCache) {
    const cached = liveOpsUiResponseCache.get(cacheKey);
    if (cached && cached.expiresAtMs > nowAtStartMs) {
      const routeRequestMetrics = recordLiveOpsRouteRequest("ui_hit");
      const cachedDiagnostics = {
        ...cached.payload.live_ops_diagnostics,
        request_source: requestSource,
        response_cache_status: "hit",
        response_cache_ttl_ms: LIVE_OPS_UI_CACHE_TTL_MS,
        response_cache_age_ms: nowAtStartMs - cached.generatedAtMs,
        route_request_metrics: routeRequestMetrics,
      };
      return buildLiveOpsResponse(
        {
          ...cached.payload,
          live_ops_diagnostics: cachedDiagnostics,
        },
        { cacheStatus: "hit", requestSource, ageMs: nowAtStartMs - cached.generatedAtMs },
      );
    }
  }
  const routeRequestMetrics = recordLiveOpsRouteRequest(shouldUseUiCache ? "ui_miss" : "bypass");
  const shadowSnapshot = getMetricsSnapshot();
  const networkSnapshot = getControlPlaneNetworkMetricsSnapshot();
  const runtimeTruthInput = { symbol: "DESK", marketInstrument: "BTCUSDT", timeframe: "live", strategy: "live-ops" } as const;
  const [runtimeTruthCacheAudit, canonicalSpineCacheAudit] = await Promise.all([
    inspectRuntimeTruthCache(runtimeTruthInput),
    inspectCanonicalSpineSnapshotCache({ sinceDays: 30 }),
  ]);
  const [killSwitchResult, systemConfigResult, gateResult, telemetryResult, realityGapResult, auditResult, outcomesResult, dashboardResult, connectorsStatusResult, mt5HealthResult, microLiveStageResult, edgeObservationSummary, runtimeTruthTimed, canonicalSpineTimed, tradeLifecycleHealthTimed, hardeningAnalytics30dTimed, sourceTreeProvenanceTimed] = await Promise.all([
    cpFetchJsonSafeBounded("/v1/system/kill-switch"),
    cpFetchJsonSafeBounded("/v1/system/config"),
    cpFetchJsonSafeBounded("/v1/system/opportunity-gate"),
    cpFetchJsonSafeBounded("/v1/execution/telemetry/recent?limit=40", LIVE_OPS_OPTIONAL_CP_FETCH_TIMEOUT_MS),
    cpFetchJsonSafeBounded("/v1/execution/reality-gap/recent?limit=40", LIVE_OPS_OPTIONAL_CP_FETCH_TIMEOUT_MS),
    cpFetchJsonSafeBounded("/v1/audit?limit=16", LIVE_OPS_OPTIONAL_CP_FETCH_TIMEOUT_MS),
    cpFetchJsonSafeBounded("/v1/outcomes/recent?limit=40", LIVE_OPS_OPTIONAL_CP_FETCH_TIMEOUT_MS),
    cpFetchJsonSafeBounded("/v1/dashboard/overview", LIVE_OPS_OPTIONAL_CP_FETCH_TIMEOUT_MS),
    cpFetchJsonSafeBounded("/v1/connectors/status", LIVE_OPS_OPTIONAL_CP_FETCH_TIMEOUT_MS),
    cpFetchJsonSafeBounded("/v1/mt5/health", LIVE_OPS_OPTIONAL_CP_FETCH_TIMEOUT_MS),
    cpFetchJsonSafeBounded("/v1/system/micro-live-stage?provider=mt5", LIVE_OPS_OPTIONAL_CP_FETCH_TIMEOUT_MS),
    getEdgeObservationSummaryBounded(),
    withTimingAndTimeout(
      () => buildRuntimeTruthSnapshot({ ...runtimeTruthInput, allowStaleOnMiss: true }),
      LIVE_OPS_SERVER_TRUTH_TIMEOUT_MS,
      null,
    ),
    withTimingAndTimeout(
      () => buildCanonicalSpineHealthSnapshot({ sinceDays: 30, allowStaleOnMiss: true }),
      LIVE_OPS_SERVER_PROJECTION_TIMEOUT_MS,
      null,
    ),
    withTimingAndTimeout(
      () => buildTradeLifecycleHealthSnapshot({
        sinceDays: 30,
        truthReliabilityInput: {
          spineMatchRatePct: 0,
          runtimeTruthSnapshotAgeMs: runtimeTruthCacheAudit.age_ms,
          canonicalSpineSnapshotAgeMs: canonicalSpineCacheAudit.age_ms,
          runtimeTruthTtlMs: RUNTIME_TRUTH_TRI_TTL_MS,
          canonicalSpineTtlMs: CANONICAL_SPINE_TRI_TTL_MS,
        },
      }),
      LIVE_OPS_SERVER_PROJECTION_TIMEOUT_MS,
      null,
    ),
    withTimingAndTimeout(
      () => buildHardeningAnalyticsSnapshot({ sinceDays: 30 }),
      LIVE_OPS_SERVER_PROJECTION_TIMEOUT_MS,
      null,
    ),
    withTimingAndTimeout(
      () => readSourceTreeProvenanceAudit(),
      LIVE_OPS_SOURCE_TREE_PROVENANCE_TIMEOUT_MS,
      {
        workspace_commit: null,
        runtime_commit: null,
        build_commit: null,
        active_slot_commit: null,
        commit_alignment_rate: 0,
        status: "UNKNOWN",
        observable_commit_count: 0,
        aligned_commit_count: 0,
        publish_blocked: true,
      },
    ),
  ]);
  const runtimeTruth = runtimeTruthTimed.value;
  const canonicalSpine = canonicalSpineTimed.value;
  let tradeLifecycleHealth = tradeLifecycleHealthTimed.value;
  const hardeningAnalytics30d = hardeningAnalytics30dTimed.value;
  const boundedTimeoutPaths = [
    ["/v1/system/kill-switch", killSwitchResult],
    ["/v1/system/config", systemConfigResult],
    ["/v1/system/opportunity-gate", gateResult],
    ["/v1/execution/telemetry/recent", telemetryResult],
    ["/v1/execution/reality-gap/recent", realityGapResult],
    ["/v1/audit", auditResult],
    ["/v1/outcomes/recent", outcomesResult],
    ["/v1/dashboard/overview", dashboardResult],
    ["/v1/connectors/status", connectorsStatusResult],
    ["/v1/mt5/health", mt5HealthResult],
    ["/v1/system/micro-live-stage?provider=mt5", microLiveStageResult],
  ].filter(([, result]) => (result as CpFetchJsonSafeResult).network.failure_classification === "timeout")
    .map(([path]) => String(path));
  if (edgeObservationSummary.filePath === "timeout") {
    boundedTimeoutPaths.push("edge_observation_summary");
  }
  const localProjectionTimeoutPaths = [
    runtimeTruthTimed.timed_out ? "runtime_truth" : null,
    canonicalSpineTimed.timed_out ? "canonical_spine" : null,
    tradeLifecycleHealthTimed.timed_out ? "trade_lifecycle_health" : null,
    hardeningAnalytics30dTimed.timed_out ? "hardening_analytics_30d" : null,
    sourceTreeProvenanceTimed.timed_out ? "source_tree_provenance" : null,
  ].filter(Boolean) as string[];
  const localProjectionFailedPaths = [
    runtimeTruthTimed.failed ? "runtime_truth" : null,
    canonicalSpineTimed.failed ? "canonical_spine" : null,
    tradeLifecycleHealthTimed.failed ? "trade_lifecycle_health" : null,
    hardeningAnalytics30dTimed.failed ? "hardening_analytics_30d" : null,
    sourceTreeProvenanceTimed.failed ? "source_tree_provenance" : null,
  ].filter(Boolean) as string[];
  const degradedProjectionPaths = [...new Set([...localProjectionTimeoutPaths, ...localProjectionFailedPaths])];
  const runtimeTruthSourceDiagnostics = asRecord(asRecord(runtimeTruth).source_diagnostics);
  const canonicalSpineSourceDiagnostics = asRecord(asRecord(canonicalSpine).source_diagnostics);
  const tradeLifecycleHealthSourceDiagnostics = asRecord(asRecord(tradeLifecycleHealth).source_diagnostics);
  const hardeningAnalyticsSourceDiagnostics = asRecord(asRecord(hardeningAnalytics30d).source_diagnostics);
  const computedTruthReliability = buildTruthReliabilitySnapshot({
    decisionContinuityPct: toNumber(asRecord(tradeLifecycleHealth).decision_continuity_score_pct, 0),
    evidenceQualityPct: toNumber(asRecord(asRecord(tradeLifecycleHealth).decision_evidence_quality).score_pct, 0),
    spineMatchRatePct: toNumber(asRecord(canonicalSpine).spine_match_rate_pct, 0),
    runtimeTruthSnapshotAgeMs: runtimeTruthCacheAudit.age_ms,
    canonicalSpineSnapshotAgeMs: canonicalSpineCacheAudit.age_ms,
    runtimeTruthTtlMs: RUNTIME_TRUTH_TRI_TTL_MS,
    canonicalSpineTtlMs: CANONICAL_SPINE_TRI_TTL_MS,
  });
  if (tradeLifecycleHealth && typeof tradeLifecycleHealth === "object") {
    tradeLifecycleHealth = {
      ...tradeLifecycleHealth,
      tri_score: computedTruthReliability.score_pct,
      tri_status: computedTruthReliability.status,
      tri_cap: computedTruthReliability.cap_pct,
      tri_continuity: computedTruthReliability.components.decision_continuity_pct,
      tri_evidence: computedTruthReliability.components.evidence_quality_pct,
      tri_spine_match: computedTruthReliability.components.spine_match_rate_pct,
      tri_freshness: computedTruthReliability.components.snapshot_freshness_pct,
      truth_reliability_index: computedTruthReliability,
    };
  }
  const decisionJourneyCompletion = asRecord(asRecord(tradeLifecycleHealth).decision_journey_completion);
  const decisionGovernance = asRecord(asRecord(tradeLifecycleHealth).decision_governance);
  const journeyCompletionRatePct = toNumber(
    decisionJourneyCompletion.completion_rate_pct,
    toNumber(asRecord(tradeLifecycleHealth).decision_continuity_score_pct, 0),
  );
  const createdDecisionTotal = toNumber(decisionJourneyCompletion.created_decision_total, 0);
  const completeDecisionTotal = toNumber(decisionJourneyCompletion.complete_decision_total, 0);
  const sourceTreeCertificationCapPct = sourceTreeProvenanceTimed.value.observable_commit_count < 4
    ? 0
    : sourceTreeProvenanceTimed.value.commit_alignment_rate;
  const certifiedTriPct = Math.min(computedTruthReliability.score_pct, sourceTreeCertificationCapPct);
  const certifiedJourneyCompletionPct = Math.min(journeyCompletionRatePct, sourceTreeCertificationCapPct);
  const criticalControlPlaneTimeout = boundedTimeoutPaths.some((path) => path === "/v1/system/kill-switch" || path === "/v1/system/config");

  const killSwitchPayload = asRecord(killSwitchResult.payload);
  const killSwitchState = asRecord(killSwitchPayload.state);
  const gatePayload = asRecord(gateResult.payload);
  const gateState = asRecord(gatePayload.gate || gatePayload);
  const gateReasons = asArray<string>(gateState.reasons);
  const hardening = asRecord(killSwitchPayload.go_live_hardening);
  const watchdogPolicy = asRecord(hardening.watchdog);
  const telemetryRows = asArray<JsonMap>(telemetryResult.payload);
  const realityGapRows = asArray<JsonMap>(asRecord(realityGapResult.payload).rows);
  const auditRows = asArray<JsonMap>(auditResult.payload);
  const outcomesRows = asArray<JsonMap>(outcomesResult.payload);
  const systemConfig = asRecord(systemConfigResult.payload);
  const dashboard = asRecord(dashboardResult.payload);
  const connectorsStatusRows = asArray<JsonMap>(connectorsStatusResult.payload);
  const mt5Health = asRecord(mt5HealthResult.payload);
  const microLiveStage = asRecord(microLiveStageResult.payload);
  const microLiveEnvelope = asRecord(microLiveStage.micro_live);
  const microLiveState = asRecord(microLiveEnvelope.state);
  const microLiveCurrentStageConfig = asRecord(microLiveEnvelope.current_stage_config);
  const microLiveCurrentStageAutoSizing = asRecord(microLiveCurrentStageConfig.auto_sizing);
  const microLiveStageBuckets = asArray<JsonMap>(microLiveCurrentStageAutoSizing.buckets);
  const microLivePhaseHistory = asArray<JsonMap>(microLiveState.history);
  const microLiveHardening = asRecord(microLiveStage.go_live_hardening);
  const microLiveNoTradePolicy = asRecord(microLiveHardening.no_trade_policy);
  const microLiveDrawdownVelocity = asRecord(microLiveHardening.drawdown_velocity);
  const microLiveOracleStability = asRecord(microLiveHardening.oracle_stability);

  const nowMs = Date.now();
  const operationalTelemetryRows = telemetryRows.filter((row) => isFreshOperationalRow(row, nowMs) && !hasSyntheticHarnessMarker(row));
  const operationalRealityGapRows = realityGapRows.filter((row) => isFreshOperationalRow(row, nowMs) && !hasSyntheticHarnessMarker(row));

  const avgLatencyMs = average(operationalTelemetryRows.map((row) => toNumber(row.latency_e2e_ms, 0)), 0);
  const avgSlippageBps = average(operationalTelemetryRows.map((row) => toNumber(row.realized_slippage_bps, 0)), 0);
  const avgDriftScore = average(
    operationalRealityGapRows.map((row) => computeAdverseExecutionDriftScore(row)),
    0,
  );
  const maxRealizedSlippageBps = Math.max(1, toNumber(watchdogPolicy.max_realized_slippage_bps, 15));
  const blockRate = operationalTelemetryRows.length > 0
    ? operationalTelemetryRows.filter((row) => toNumber(row.realized_slippage_bps, 0) > maxRealizedSlippageBps).length / operationalTelemetryRows.length
    : 0;
  const errorRate = clamp(Math.max(networkSnapshot.degraded_usage_ratio, networkSnapshot.timeout_rate, blockRate, boundedTimeoutPaths.length > 0 ? 0.35 : 0), 0, 1);
  const killSwitchActive = Boolean(killSwitchState.active);
  const gateStatusRaw = String(gateState.status || "").trim().toLowerCase();
  const gateKnown = typeof gateState.opportunity_enabled === "boolean" || Boolean(gateStatusRaw);
  const gateEnabled = gateKnown
    ? typeof gateState.opportunity_enabled === "boolean"
      ? Boolean(gateState.opportunity_enabled)
      : gateStatusRaw === "go"
    : true;
  const gateHealthScore = toNumber(gateState.health_score, 0);
  const anomalyScore = clamp(
    (avgLatencyMs / Math.max(1, toNumber(watchdogPolicy.max_latency_e2e_ms, 1500))) * 0.28
      + avgDriftScore * 0.32
      + errorRate * 0.24
      + (killSwitchActive ? 0.4 : 0),
    0,
    1,
  );
  const derivedHealthScore = clamp((1 - anomalyScore) * 100, 0, 100);
  const healthScore = gateHealthScore > 0 ? Math.min(derivedHealthScore, gateHealthScore) : derivedHealthScore;
  const watchdogStatus = criticalControlPlaneTimeout || killSwitchActive || (gateKnown && !gateEnabled) || anomalyScore >= 0.8 ? "HALT" : boundedTimeoutPaths.length > 0 || anomalyScore >= 0.4 ? "WARNING" : "OK";
  const runtimeTruthRecord = asRecord(runtimeTruth);
  const runtimeTruthVerdict = String(runtimeTruthRecord.verdict || "").trim().toUpperCase();
  const runtimeTruthBlockers = asArray<string>(runtimeTruthRecord.blockers).map((item) => String(item)).filter(Boolean);
  const runtimeTruthDegradedReasons = asArray<string>(runtimeTruthRecord.degraded_reasons).map((item) => String(item)).filter(Boolean);
  const runtimeTruthDetails = runtimeTruthVerdict === "BLOCKED" ? runtimeTruthBlockers : runtimeTruthDegradedReasons;
  const effectiveWatchdogStatus = runtimeTruthVerdict === "BLOCKED"
    ? "HALT"
    : runtimeTruthVerdict === "DEGRADED" && watchdogStatus === "OK"
      ? "WARNING"
      : watchdogStatus;
  const effectiveHealthScore = runtimeTruthVerdict === "BLOCKED"
    ? Math.min(healthScore, 25)
    : runtimeTruthVerdict === "DEGRADED"
      ? Math.min(healthScore, 65)
      : healthScore;

  const exposures = deriveExposureBySymbol(operationalTelemetryRows);
  const dailyUsedUsd = toNumber(dashboard.net_exposure_usd, 0);
  const drawdownUsd = computeDrawdownUsd(outcomesRows);
  const dominantExposure = exposures[0]?.notionalUsd || 0;
  const drawdownPct = dominantExposure > 0 ? (drawdownUsd / dominantExposure) * 100 : 0;
  const latestGap = operationalRealityGapRows[0] || {};
  const lastTelemetry = operationalTelemetryRows[0] || {};
  const preTradeMemoryGate = asRecord(asRecord(lastTelemetry).pre_trade_memory_gate);
  const memoryDecision = preTradeMemoryGate.block_execution
    ? "BLOCKED"
    : preTradeMemoryGate.status
      ? String(preTradeMemoryGate.status).toUpperCase()
      : "OK";
  const dominantCause = String(asRecord(latestGap).failure_source || (asArray<string>(asRecord(latestGap).failure_reasons)[0] || "none")).trim() || "none";
  const mt5BridgeHealthy = String(mt5Health.status || "").trim().toLowerCase() === "healthy";
  const degradedConnectors = connectorsStatusRows
    .filter((row) => !Boolean(row.healthy))
    .map((row) => String(row.name || row.provider || row.transport || "unknown").trim() || "unknown")
    .slice(0, 8);
  const microLiveCurrentStage = String(microLiveEnvelope.current_stage || microLiveState.current_stage || "").trim();
  const microLiveStageCapUsd = toNumber(microLiveCurrentStageConfig.max_order_notional_usd, 0);
  const microLiveStageAvailable = Boolean(microLiveCurrentStage) && microLiveStageCapUsd > 0;
  const microLiveHardeningStatus = String(microLiveHardening.status || hardening.status || "unknown").trim().toUpperCase();
  const microLiveHardeningReasons = asArray<string>(microLiveHardening.reasons).map((item) => String(item)).filter(Boolean);
  const microLiveEntryReasons = dedupeNonEmptyStrings([
    !mt5BridgeHealthy ? `mt5_bridge_${String(mt5Health.status || "unknown").toLowerCase() || "unknown"}` : null,
    degradedConnectors.length > 0 ? `connecteurs_degrades:${degradedConnectors.join(",")}` : null,
    Boolean(dashboard.paper_only) ? "paper_only_active" : null,
    !microLiveStageAvailable ? "micro_live_stage_unavailable" : null,
  ]);
  const microLiveCutSwitches = dedupeNonEmptyStrings([
    killSwitchActive ? `kill_switch_active:${String(killSwitchState.reason || "execution_locked")}` : null,
    gateKnown && !gateEnabled ? `opportunity_gate_blocked:${String(gateState.status || "no-go")}` : null,
    runtimeTruthVerdict === "BLOCKED" ? `runtime_truth_blocked:${runtimeTruthBlockers.join(",") || String(runtimeTruthRecord.summary || "canonical truth blocked")}` : null,
    effectiveWatchdogStatus === "HALT" ? "watchdog_halt" : null,
    microLiveHardeningStatus === "BLOCKED" ? `hardening_blocked:${microLiveHardeningReasons.join(",") || "hardening"}` : null,
    Boolean(microLiveDrawdownVelocity.blocked) ? "drawdown_velocity_blocked" : null,
    Boolean(microLiveOracleStability.blocked) ? "oracle_stability_blocked" : null,
  ]);
  const microLiveWarningReasons = dedupeNonEmptyStrings([
    runtimeTruthVerdict === "DEGRADED" ? `runtime_truth_degraded:${runtimeTruthDetails.join(",") || String(runtimeTruthRecord.summary || "runtime truth degraded")}` : null,
    effectiveWatchdogStatus === "WARNING" ? "watchdog_warning" : null,
    avgLatencyMs > 120 ? `latency_${avgLatencyMs.toFixed(0)}ms` : null,
    avgSlippageBps > 3 ? `slippage_${avgSlippageBps.toFixed(2)}bps` : null,
  ]);
  const microLiveEntryStatus = microLiveCutSwitches.length > 0 || microLiveEntryReasons.length > 0
    ? "BLOCKED"
    : microLiveWarningReasons.length > 0
      ? "REDUCE"
      : "OPEN";

  const quotes: VenueQuoteSnapshot[] = operationalTelemetryRows.slice(0, 4).map((row, index) => ({
    venue: String(row.route_chosen || row.route_backup || `venue-${index + 1}`).trim().toLowerCase() || `venue-${index + 1}`,
    bid: 100 + index * 0.15 + Math.max(0, 0.1 - toNumber(row.realized_slippage_bps, 0) * 0.001),
    ask: 100 + index * 0.15 + 0.2 + Math.max(0, toNumber(row.realized_slippage_bps, 0) * 0.001),
    latencyMs: toNumber(row.latency_e2e_ms, 0),
    slippageBps: toNumber(row.realized_slippage_bps, 0),
    feeBps: 1.5,
    availableDepthUsd: Math.max(0, toNumber(row.available_depth_usd, 0)),
  }));
  const arbitrage = evaluateVenueArbitrage(quotes);
  const smartMoney = detectSmartMoney({
    absorption: clamp(1 - Math.abs(toNumber(asRecord(latestGap).gap_fill_probability, 0)), 0, 1),
    deltaDivergence: clamp(Math.abs(toNumber(asRecord(latestGap).gap_impact_bps, 0)) / 12, 0, 1),
    priceStability: clamp(1 - Math.abs(toNumber(asRecord(latestGap).gap_slippage_bps, 0)) / 12, 0, 1),
    liquidityHold: clamp(sum(exposures.map((item) => item.notionalUsd)) / 100, 0, 1),
    volumeImpulse: clamp(Math.abs(dailyUsedUsd) / 100, 0, 1),
  });
  const spoof = detectSpoofing({
    largeOrdersRemovedRatio: clamp(networkSnapshot.retry_recovered_ratio * 2.4, 0, 1),
    liquidityFakeScore: clamp(networkSnapshot.degraded_usage_ratio * 2.8, 0, 1),
    reversalSpeed: clamp(avgDriftScore, 0, 1),
    tradeFollowThrough: clamp(1 - blockRate, 0, 1),
    cancelVelocity: clamp(networkSnapshot.dns_transient_rate * 3, 0, 1),
  });
  const marketState = classifyMarketState({
    trendStrength: clamp(arbitrage.netEdgeBps / 12, 0, 1),
    volatility: clamp(avgDriftScore, 0, 1),
    liquidityScore: clamp(sum(exposures.map((item) => item.notionalUsd)) / 120, 0, 1),
    spoofState: spoof.state,
    smartMoneyState: smartMoney.state,
    trapProbability: clamp(spoof.score * 0.6 + blockRate * 0.4, 0, 1),
  });
  const domination = computeExecutionDomination({
    latencyEdgeMs: Math.max(0, 25 - avgLatencyMs),
    liquidityAdvantage: clamp(sum(exposures.map((item) => item.notionalUsd)) / 120, 0, 1),
    executionQuality: clamp(1 - avgDriftScore, 0, 1),
    fillProbability: clamp(1 - blockRate, 0, 1),
    slippageBps: avgSlippageBps,
    riskScore: clamp(drawdownPct / 10, 0, 1),
  });

  const alerts = [
    runtimeTruthVerdict === "BLOCKED" ? { severity: "critical", code: "runtime_truth_blocked", message: "Runtime truth blocked", detail: runtimeTruthBlockers.join(", ") || String(runtimeTruthRecord.summary || "canonical truth blocked") } : null,
    runtimeTruthVerdict === "DEGRADED" ? { severity: "warn", code: "runtime_truth_degraded", message: "Runtime truth degraded", detail: runtimeTruthDetails.join(", ") || String(runtimeTruthRecord.summary || "canonical truth degraded") } : null,
    boundedTimeoutPaths.length > 0 ? { severity: criticalControlPlaneTimeout ? "critical" : "warn", code: "live_ops_partial_data", message: "Live Ops partial data", detail: boundedTimeoutPaths.join(", ") } : null,
    localProjectionTimeoutPaths.length > 0 ? { severity: "warn", code: "live_ops_projection_timeout", message: "Live Ops local projections timed out", detail: localProjectionTimeoutPaths.join(", ") } : null,
    localProjectionFailedPaths.length > 0 ? { severity: "warn", code: "live_ops_projection_failed", message: "Live Ops local projections failed", detail: localProjectionFailedPaths.join(", ") } : null,
    avgDriftScore > 0.2 ? { severity: "warn", code: "execution_drift", message: "Execution drift detected", detail: `drift=${avgDriftScore.toFixed(3)}` } : null,
    avgSlippageBps > 10 ? { severity: "warn", code: "slippage_spike", message: "Slippage spike", detail: `${avgSlippageBps.toFixed(2)} bps` } : null,
    gateKnown && !gateEnabled ? { severity: "critical", code: "opportunity_gate_blocked", message: "Opportunity gate blocked", detail: String(gateReasons.join(", ") || "gate blocked") } : null,
    killSwitchActive ? { severity: "critical", code: "kill_switch_active", message: "System critical", detail: String(killSwitchState.reason || "kill switch active") } : null,
    anomalyScore > 0.8 ? { severity: "critical", code: "preemptive_shutdown", message: "Preemptive shutdown ready", detail: `anomaly_score=${anomalyScore.toFixed(3)}` } : null,
  ].filter(Boolean);

  const controlledCollectionStatus = killSwitchActive
    ? "LOCKED"
    : gateKnown && !gateEnabled
      ? "BLOCKED"
      : Boolean(dashboard.paper_only)
        ? "PAPER_ONLY"
        : "READY";
  const controlledCollectionNextAction = controlledCollectionStatus === "LOCKED"
    ? "Manual kill switch reset required before any controlled collection session."
    : controlledCollectionStatus === "BLOCKED"
      ? "Wait for opportunity gate GO before opening a controlled collection session."
      : controlledCollectionStatus === "PAPER_ONLY"
        ? "Paper-only remains active: keep observing until live permissions are restored."
        : "Run controlled collection only: BingX, BTCUSDT, micro-size 7-7.5 USD, no strategy tweak.";

  const auditTrail = buildAuditTrail(auditRows, telemetryRows, realityGapRows);
  const filteredAuditTrail = filterAuditTrailRows(auditTrail, auditFilter);
  const controlledLiveRampGateReport = await buildControlledLiveRampGateReport({
    context: String(process.env.CONTROLLED_LIVE_GATE_CONTEXT || "ops").trim().toLowerCase() === "ci" ? "ci" : "ops",
    sinceDays: 30,
    lifecycleReport: buildLifecyclePublishGateReportFromSnapshot(tradeLifecycleHealth),
    replayArtifact: null,
    runtimeTruth,
    publicUrl: String(process.env.CONTROLLED_LIVE_GATE_PUBLIC_URL || "").trim(),
    authProbeUrl: String(process.env.CONTROLLED_LIVE_GATE_AUTH_URL || "").trim(),
    authMode: String(process.env.CONTROLLED_LIVE_GATE_AUTH_MODE || "").trim().toLowerCase() === "service"
      ? "service"
      : String(process.env.CONTROLLED_LIVE_GATE_AUTH_MODE || "").trim().toLowerCase() === "cookie"
        ? "cookie"
        : "auto",
    authCookie: String(process.env.CONTROLLED_LIVE_GATE_AUTH_COOKIE || "").trim(),
    authToken: String(process.env.CONTROLLED_LIVE_GATE_AUTH_TOKEN || "").trim(),
    currentCleanCycles: Math.max(0, toControlledLiveRampGateNumber(process.env.CONTROLLED_LIVE_GATE_CURRENT_CLEAN_CYCLES, 0)),
    reviewRequiredBaseline: process.env.CONTROLLED_LIVE_GATE_REVIEW_REQUIRED_BASELINE === undefined
      ? null
      : Math.max(0, toControlledLiveRampGateNumber(process.env.CONTROLLED_LIVE_GATE_REVIEW_REQUIRED_BASELINE, 0)),
  });
  const responseBody = {
    schema_version: LIVE_OPS_PAYLOAD_SCHEMA_VERSION,
    status: "ok",
    generated_at: new Date().toISOString(),
    controlled_live_ramp_gate: controlledLiveRampGateReport,
    watchdog_state: {
      latency: Number(avgLatencyMs.toFixed(2)),
      drift: Number(avgDriftScore.toFixed(4)),
      error_rate: Number(errorRate.toFixed(4)),
      anomaly_score: Number(anomalyScore.toFixed(4)),
      status: effectiveWatchdogStatus,
      triggers: alerts.map((item) => asRecord(item).code),
      health_score: Number(effectiveHealthScore.toFixed(2)),
      opportunity_gate_status: gateKnown ? String(gateState.status || (gateEnabled ? "go" : "no-go")) : "unknown",
    },
    risk_snapshot: {
      dd_pct: Number(drawdownPct.toFixed(4)),
      dd_usd: Number(drawdownUsd.toFixed(4)),
      exposure_by_symbol: exposures,
      daily_used_usd: Number(dailyUsedUsd.toFixed(4)),
      avg_slippage_bps: Number(avgSlippageBps.toFixed(4)),
      notional_proxy_usd: Number(sum(exposures.map((item) => item.notionalUsd)).toFixed(4)),
    },
    risk_timeline: buildRiskTimeline(outcomesRows, exposures),
    audit_filter: auditFilter || null,
    audit_trail: filteredAuditTrail,
    audit_trail_total_rows: auditTrail.length,
    audit_trail_filtered_rows: filteredAuditTrail.length,
    memory_gap: {
      memory_decision: memoryDecision,
      reality_gap_score: Number(avgDriftScore.toFixed(4)),
      drift_detected: avgDriftScore > 0.2,
      dominant_cause: dominantCause,
      last_failure_reasons: asArray<string>(asRecord(latestGap).failure_reasons),
    },
    governance: {
      mode: mapSystemMode(String(systemConfig.system_mode || dashboard.system_mode || "guarded_auto"), killSwitchActive),
      backend_mode: String(systemConfig.system_mode || dashboard.system_mode || "guarded_auto"),
      operator_override: !killSwitchActive,
      high_risk_trades_blocked: killSwitchActive || mapSystemMode(String(systemConfig.system_mode || dashboard.system_mode || "guarded_auto"), killSwitchActive) !== "LIVE",
      paper_only: Boolean(dashboard.paper_only),
      advanced_programs_frozen: Array.isArray(decisionGovernance.freeze_controls)
        ? decisionGovernance.freeze_controls.some((entry) => Boolean(asRecord(entry).frozen))
        : false,
      decision_system: decisionGovernance,
      opportunity_gate: gateState,
    },
    recovery: {
      active: killSwitchActive || effectiveWatchdogStatus === "HALT",
      mode: killSwitchActive ? "RECOVERY_LOCKDOWN" : effectiveWatchdogStatus === "WARNING" ? "SAFE_RECOVERY" : effectiveWatchdogStatus === "HALT" ? "TRUTH_LOCKDOWN" : "NOMINAL",
      reduced_risk: killSwitchActive || avgDriftScore > 0.2 || runtimeTruthVerdict === "DEGRADED" || runtimeTruthVerdict === "BLOCKED",
      blocked_trades: killSwitchActive || blockRate > 0.35 || runtimeTruthVerdict === "BLOCKED",
    },
    controlled_collection: {
      status: controlledCollectionStatus,
      thesis: "Collect labels, not profit. Each micro-trade is a data point for reaction x regime x outcome.",
      next_action: controlledCollectionNextAction,
      manual_reset_required: killSwitchActive,
      constraints: [
        "Venue locked: BingX only",
        "Instrument locked: BTCUSDT only",
        "Micro-size only: 7.0-7.5 USD notional",
        "No strategy change during the collection window",
        "No threshold tweak, no scalping chase, no venue rotation",
      ],
      forbidden: [
        "Do not optimize for profit during collection",
        "Do not change strategy or execution model mid-session",
        "Do not widen size after a clean fill",
        "Do not override no-trade dominance just to force a label",
      ],
      stop_conditions: [
        "Kill switch re-triggered",
        "Opportunity gate no longer GO",
        "Execution anomaly or suspicious routing behavior",
        `Realized slippage above ${maxRealizedSlippageBps.toFixed(2)} bps`,
        `Latency above ${Math.max(1, toNumber(watchdogPolicy.max_latency_e2e_ms, 1500)).toFixed(0)} ms ceiling`,
      ],
      label_progress: edgeObservationSummary.labelProgress,
      edge_confidence: edgeObservationSummary.liveConfidence,
      staleness: edgeObservationSummary.staleness,
      latest_classified_intent_at: edgeObservationSummary.latestClassifiedIntentAt,
    },
    micro_live_program: {
      provider: "mt5",
      entry_status: microLiveEntryStatus,
      entry_reasons: microLiveEntryReasons,
      warning_reasons: microLiveWarningReasons,
      active_cut_switches: microLiveCutSwitches,
      infrastructure: {
        mt5_bridge_status: String(mt5Health.status || "unknown"),
        mt5_accounts: toNumber(mt5Health.accounts, 0),
        degraded_connector_count: degradedConnectors.length,
        degraded_connectors: degradedConnectors,
        opportunity_gate_status: gateKnown ? String(gateState.status || (gateEnabled ? "go" : "no-go")) : "unknown",
        paper_only: Boolean(dashboard.paper_only),
        watchdog_status: effectiveWatchdogStatus,
        backend_mode: String(systemConfig.system_mode || dashboard.system_mode || "guarded_auto"),
      },
      session_targets: {
        created_decisions_target: 100,
        complete_decisions_target: 50,
        micro_executions_target_min: 100,
        micro_executions_target_max: 500,
      },
      progress: {
        created_decisions: createdDecisionTotal,
        complete_decisions: completeDecisionTotal,
        created_progress_pct: Number(((Math.min(createdDecisionTotal, 100) / 100) * 100).toFixed(1)),
        complete_progress_pct: Number(((Math.min(completeDecisionTotal, 50) / 50) * 100).toFixed(1)),
      },
      stage: {
        current_stage: microLiveCurrentStage || null,
        max_order_notional_usd: microLiveStageCapUsd,
        max_notional_pct_of_exploitable_capital: toNumber(microLiveCurrentStageConfig.max_notional_pct_of_exploitable_capital, 0),
        buckets: microLiveStageBuckets,
        transition_history: microLivePhaseHistory.slice(0, 8),
      },
      hardening: {
        status: microLiveHardeningStatus,
        reasons: microLiveHardeningReasons,
        no_trade_policy: microLiveNoTradePolicy,
        drawdown_velocity: microLiveDrawdownVelocity,
        oracle_stability: microLiveOracleStability,
      },
    },
    canonical_spine: canonicalSpine,
    trade_lifecycle_health: tradeLifecycleHealth,
    source_tree_provenance: sourceTreeProvenanceTimed.value,
    source_tree_certification: {
      cap_pct: Number(sourceTreeCertificationCapPct.toFixed(1)),
      certified_tri_pct: Number(certifiedTriPct.toFixed(1)),
      certified_journey_completion_pct: Number(certifiedJourneyCompletionPct.toFixed(1)),
      blocked: sourceTreeProvenanceTimed.value.publish_blocked,
      rule: sourceTreeProvenanceTimed.value.publish_blocked
        ? "commit_alignment_rate < 100 or observability < 4 forbids promotion and caps certified KPIs"
        : "full provenance alignment allows uncapped certified KPIs",
    },
    hardening_analytics_30d: hardeningAnalytics30d,
    live_ops_diagnostics: {
      aggregate_window_days: 30,
      runtime_truth_ms: runtimeTruthTimed.duration_ms,
      canonical_spine_ms: canonicalSpineTimed.duration_ms,
      trade_lifecycle_ms: tradeLifecycleHealthTimed.duration_ms,
      source_tree_provenance_ms: sourceTreeProvenanceTimed.duration_ms,
      hardening_analytics_ms: hardeningAnalytics30dTimed.duration_ms,
      timeout_projections: localProjectionTimeoutPaths,
      degraded_projections: degradedProjectionPaths,
      control_plane_timeout_paths: boundedTimeoutPaths,
      local_projection_timeout_paths: localProjectionTimeoutPaths,
      local_projection_failed_paths: localProjectionFailedPaths,
      projection_durations_ms: {
        runtime_truth: runtimeTruthTimed.duration_ms,
        canonical_spine: canonicalSpineTimed.duration_ms,
        trade_lifecycle_health: tradeLifecycleHealthTimed.duration_ms,
        source_tree_provenance: sourceTreeProvenanceTimed.duration_ms,
        hardening_analytics_30d: hardeningAnalytics30dTimed.duration_ms,
      },
      projection_source_audits: {
        runtime_truth: {
          rows_scanned: toNumber(runtimeTruthSourceDiagnostics.rows_scanned, 0),
          rows_returned: toNumber(runtimeTruthSourceDiagnostics.rows_returned, 0),
          cache_hit: runtimeTruthCacheAudit.cache_hit,
          cache_miss: runtimeTruthCacheAudit.cache_miss,
          cache_age_ms: runtimeTruthCacheAudit.age_ms,
        },
        canonical_spine: {
          rows_scanned: toNumber(canonicalSpineSourceDiagnostics.rows_scanned, 0),
          rows_returned: toNumber(canonicalSpineSourceDiagnostics.rows_returned, 0),
          cache_hit: canonicalSpineCacheAudit.cache_hit,
          cache_miss: canonicalSpineCacheAudit.cache_miss,
          cache_age_ms: canonicalSpineCacheAudit.age_ms,
        },
        trade_lifecycle_health: {
          rows_scanned: toNumber(tradeLifecycleHealthSourceDiagnostics.rows_scanned, 0),
          rows_returned: toNumber(tradeLifecycleHealthSourceDiagnostics.rows_returned, 0),
          cache_hit: 0,
          cache_miss: 1,
          cache_age_ms: null,
        },
        source_tree_provenance: {
          rows_scanned: 4,
          rows_returned: [
            sourceTreeProvenanceTimed.value.workspace_commit,
            sourceTreeProvenanceTimed.value.runtime_commit,
            sourceTreeProvenanceTimed.value.build_commit,
            sourceTreeProvenanceTimed.value.active_slot_commit,
          ].filter(Boolean).length,
          cache_hit: 0,
          cache_miss: 1,
          cache_age_ms: null,
        },
        hardening_analytics_30d: {
          rows_scanned: toNumber(hardeningAnalyticsSourceDiagnostics.rows_scanned, 0),
          rows_returned: toNumber(hardeningAnalyticsSourceDiagnostics.rows_returned, 0),
          cache_hit: 0,
          cache_miss: 1,
          cache_age_ms: null,
        },
      },
      measurement_window_7d: null,
      runtime_truth_cache_hit_rate_24h: 0,
      canonical_spine_cache_hit_rate_24h: 0,
      runtime_truth_rebuild_count_24h: 0,
      canonical_spine_rebuild_count_24h: 0,
      runtime_truth_avg_snapshot_age_ms_24h: 0,
      runtime_truth_max_snapshot_age_ms_24h: 0,
      canonical_spine_avg_snapshot_age_ms_24h: 0,
      canonical_spine_max_snapshot_age_ms_24h: 0,
      truth_reliability_index_pct: 0,
      truth_reliability_index: {
        score_pct: 0,
        raw_score_pct: 0,
        status: "unusable",
        cap_pct: null,
        cap_reasons: [],
        components: {
          decision_continuity_pct: 0,
          evidence_quality_pct: 0,
          spine_match_rate_pct: 0,
          snapshot_freshness_pct: 0,
          runtime_truth_snapshot_age_ms: null,
          canonical_spine_snapshot_age_ms: null,
        },
      },
      payload_size_bytes: 0,
      payload_bytes: 0,
      measurement_window_30d: null,
    },
    alerts,
    warfare_core: {
      arbitrage,
      smart_money: smartMoney,
      spoof,
      market_state: marketState,
      domination,
    },
    raw: {
      runtime_truth: runtimeTruth,
      kill_switch: killSwitchPayload,
      opportunity_gate: gatePayload,
      connectors_status: connectorsStatusRows,
      mt5_health: mt5Health,
      micro_live_stage: microLiveStage,
      network: networkSnapshot,
      shadow: {
        fallback_rate: shadowSnapshot.fallback_rate,
        metrics: shadowSnapshot.metrics,
      },
    },
  };
  const tradeLifecycleTruthReliability = asRecord(asRecord(tradeLifecycleHealth).truth_reliability_index);
  const truthReliability = Object.keys(tradeLifecycleTruthReliability).length > 0
    ? tradeLifecycleTruthReliability as unknown as TruthReliabilitySnapshot
    : computedTruthReliability;
  responseBody.live_ops_diagnostics.truth_reliability_index_pct = truthReliability.score_pct;
  responseBody.live_ops_diagnostics.truth_reliability_index = truthReliability;
  const diagnosticsHistoryTimed = await withTimingAndTimeout(
    () => readLiveOpsDiagnosticsWindowSummary({ sinceDays: 7, limit: 5000 }),
    LIVE_OPS_DIAGNOSTICS_HISTORY_TIMEOUT_MS,
    null,
  );
  const diagnosticsHistory30dTimed = await withTimingAndTimeout(
    () => readLiveOpsDiagnosticsWindowSummary({ sinceDays: 30, limit: 10000 }),
    LIVE_OPS_DIAGNOSTICS_HISTORY_TIMEOUT_MS,
    null,
  );
  const diagnosticsHistory24hTimed = await withTimingAndTimeout(
    () => readLiveOpsDiagnosticsWindowSummary({ sinceDays: 1, limit: 2000 }),
    LIVE_OPS_DIAGNOSTICS_HISTORY_TIMEOUT_MS,
    null,
  );
  if (diagnosticsHistoryTimed.value) {
    responseBody.live_ops_diagnostics.measurement_window_7d = diagnosticsHistoryTimed.value;
  }
  if (diagnosticsHistory30dTimed.value) {
    responseBody.live_ops_diagnostics.measurement_window_30d = diagnosticsHistory30dTimed.value;
  }
  if (diagnosticsHistory24hTimed.value) {
    const runtimeTruth24h = diagnosticsHistory24hTimed.value.projection_source_audits.runtime_truth;
    const canonicalSpine24h = diagnosticsHistory24hTimed.value.projection_source_audits.canonical_spine;
    responseBody.live_ops_diagnostics.runtime_truth_cache_hit_rate_24h = runtimeTruth24h.cache_hit_rate_pct;
    responseBody.live_ops_diagnostics.canonical_spine_cache_hit_rate_24h = canonicalSpine24h.cache_hit_rate_pct;
    responseBody.live_ops_diagnostics.runtime_truth_rebuild_count_24h = runtimeTruth24h.rebuild_count;
    responseBody.live_ops_diagnostics.canonical_spine_rebuild_count_24h = canonicalSpine24h.rebuild_count;
    responseBody.live_ops_diagnostics.runtime_truth_avg_snapshot_age_ms_24h = runtimeTruth24h.cache_age_ms_avg;
    responseBody.live_ops_diagnostics.runtime_truth_max_snapshot_age_ms_24h = runtimeTruth24h.cache_age_ms_max;
    responseBody.live_ops_diagnostics.canonical_spine_avg_snapshot_age_ms_24h = canonicalSpine24h.cache_age_ms_avg;
    responseBody.live_ops_diagnostics.canonical_spine_max_snapshot_age_ms_24h = canonicalSpine24h.cache_age_ms_max;
  }
  const responseDiagnostics = responseBody.live_ops_diagnostics as JsonMap;
  responseDiagnostics.request_source = requestSource;
  responseDiagnostics.response_cache_status = shouldUseUiCache ? "stored" : "bypass";
  responseDiagnostics.response_cache_ttl_ms = shouldUseUiCache ? LIVE_OPS_UI_CACHE_TTL_MS : 0;
  responseDiagnostics.route_request_metrics = routeRequestMetrics;
  responseDiagnostics.payload_bytes = new TextEncoder().encode(JSON.stringify(responseBody)).length;
  responseDiagnostics.payload_size_bytes = responseDiagnostics.payload_bytes;
  await withTimingAndTimeout(
    () => appendLiveOpsDiagnosticsSample({
      timestamp_iso: String(responseBody.generated_at || new Date().toISOString()),
      aggregate_window_days: 30,
      runtime_truth_ms: runtimeTruthTimed.duration_ms,
      canonical_spine_ms: canonicalSpineTimed.duration_ms,
      trade_lifecycle_ms: tradeLifecycleHealthTimed.duration_ms,
      hardening_analytics_ms: hardeningAnalytics30dTimed.duration_ms,
      payload_size_bytes: toNumber(responseDiagnostics.payload_size_bytes, 0),
      tri_score: toNumber(truthReliability.score_pct, 0),
      tri_status: String(truthReliability.status || "unusable"),
      tri_cap: truthReliability.cap_pct,
      tri_continuity: toNumber(asRecord(truthReliability.components).decision_continuity_pct, 0),
      tri_evidence: toNumber(asRecord(truthReliability.components).evidence_quality_pct, 0),
      tri_spine_match: toNumber(asRecord(truthReliability.components).spine_match_rate_pct, 0),
      tri_freshness: toNumber(asRecord(truthReliability.components).snapshot_freshness_pct, 0),
      source_tree_provenance: {
        status: sourceTreeProvenanceTimed.value.status,
        commit_alignment_rate: sourceTreeProvenanceTimed.value.commit_alignment_rate,
        observable_commit_count: sourceTreeProvenanceTimed.value.observable_commit_count,
        aligned_commit_count: sourceTreeProvenanceTimed.value.aligned_commit_count,
        publish_blocked: sourceTreeProvenanceTimed.value.publish_blocked,
      },
      decision_gap_reduction: {
        incomplete_decision_total: toNumber(asRecord(asRecord(tradeLifecycleHealth).decision_gap_reduction).incomplete_decision_total, 0),
        by_stage: (() => {
          const gapReduction = asRecord(asRecord(tradeLifecycleHealth).decision_gap_reduction);
          return asArray<Record<string, unknown>>(gapReduction.by_stage).map((stage) => ({
            stage_key: String(stage.stage_key || "").trim(),
            label: String(stage.label || "").trim(),
            gap_label: String(stage.gap_label || "").trim(),
            blocked_decision_total: toNumber(stage.blocked_decision_total, 0),
            share_pct: toNumber(stage.share_pct, 0),
            exemplar_decision_ids: asArray<Record<string, unknown>>(stage.exemplar_decisions).map((item) => String(item.decision_id || "").trim()).filter(Boolean).slice(0, 12),
          }));
        })(),
      },
      decision_gap_resolution: {
        open_gap_total: toNumber(asRecord(asRecord(tradeLifecycleHealth).decision_gap_resolution).open_gap_total, 0),
        resolved_gap_total: toNumber(asRecord(asRecord(tradeLifecycleHealth).decision_gap_resolution).resolved_gap_total, 0),
        gap_resolution_rate_pct: toNumber(asRecord(asRecord(tradeLifecycleHealth).decision_gap_resolution).gap_resolution_rate_pct, 0),
        mean_time_to_continuity_hours: Number.isFinite(Number(asRecord(asRecord(tradeLifecycleHealth).decision_gap_resolution).mean_time_to_continuity_hours))
          ? toNumber(asRecord(asRecord(tradeLifecycleHealth).decision_gap_resolution).mean_time_to_continuity_hours, 0)
          : null,
        dominant_open_gap_stage_key: String(asRecord(asRecord(tradeLifecycleHealth).decision_gap_resolution).dominant_open_gap_stage_key || "").trim() || null,
        dominant_open_gap_label: String(asRecord(asRecord(tradeLifecycleHealth).decision_gap_resolution).dominant_open_gap_label || "").trim() || null,
        dominant_open_gap_total: toNumber(asRecord(asRecord(tradeLifecycleHealth).decision_gap_resolution).dominant_open_gap_total, 0),
        dominant_open_gap_share_pct: toNumber(asRecord(asRecord(tradeLifecycleHealth).decision_gap_resolution).dominant_open_gap_share_pct, 0),
        backlog_age_buckets: (() => {
          const gapResolution = asRecord(asRecord(tradeLifecycleHealth).decision_gap_resolution);
          return asArray<Record<string, unknown>>(gapResolution.backlog_age_buckets).map((bucket) => ({
            bucket_key: String(bucket.bucket_key || "").trim(),
            label: String(bucket.label || "").trim(),
            open_gap_total: toNumber(bucket.open_gap_total, 0),
            share_pct: toNumber(bucket.share_pct, 0),
          }));
        })(),
        oldest_open_gap: (() => {
          const oldestOpenGap = asRecord(asRecord(asRecord(tradeLifecycleHealth).decision_gap_resolution).oldest_open_gap);
          if (Object.keys(oldestOpenGap).length === 0) {
            return null;
          }
          return {
            decision_id: String(oldestOpenGap.decision_id || "").trim() || null,
            gap_label: String(oldestOpenGap.gap_label || "").trim() || null,
            open_age_hours: toNumber(oldestOpenGap.open_age_hours, 0),
            root_cause_code: String(oldestOpenGap.root_cause_code || "").trim() || null,
          };
        })(),
        dominant_gap_cardinality: (() => {
          const cardinality = asRecord(asRecord(asRecord(tradeLifecycleHealth).decision_gap_resolution).dominant_gap_cardinality);
          if (Object.keys(cardinality).length === 0) {
            return null;
          }
          return {
            gap_occurrence_total: toNumber(cardinality.gap_occurrence_total, 0),
            unique_decision_total: toNumber(cardinality.unique_decision_total, 0),
            unique_trade_lifecycle_total: toNumber(cardinality.unique_trade_lifecycle_total, 0),
            unique_root_cause_total: toNumber(cardinality.unique_root_cause_total, 0),
            by_root_cause: asArray<Record<string, unknown>>(cardinality.by_root_cause).map((cause) => ({
              root_cause_code: String(cause.root_cause_code || "").trim(),
              label: String(cause.label || "").trim(),
              open_gap_total: toNumber(cause.open_gap_total, 0),
              share_pct: toNumber(cause.share_pct, 0),
            })).filter((cause) => cause.root_cause_code.length > 0).slice(0, 12),
          };
        })(),
      },
      control_plane_timeout_paths: boundedTimeoutPaths,
      local_projection_timeout_paths: localProjectionTimeoutPaths,
      local_projection_failed_paths: localProjectionFailedPaths,
      timeout_projections: localProjectionTimeoutPaths,
      degraded_projections: degradedProjectionPaths,
      projection_durations_ms: {
        runtime_truth: runtimeTruthTimed.duration_ms,
        canonical_spine: canonicalSpineTimed.duration_ms,
        trade_lifecycle_health: tradeLifecycleHealthTimed.duration_ms,
        hardening_analytics_30d: hardeningAnalytics30dTimed.duration_ms,
      },
      projection_source_audits: {
        runtime_truth: {
          rows_scanned: toNumber(runtimeTruthSourceDiagnostics.rows_scanned, 0),
          rows_returned: toNumber(runtimeTruthSourceDiagnostics.rows_returned, 0),
          cache_hit: runtimeTruthCacheAudit.cache_hit,
          cache_miss: runtimeTruthCacheAudit.cache_miss,
          cache_age_ms: runtimeTruthCacheAudit.age_ms,
        },
        canonical_spine: {
          rows_scanned: toNumber(canonicalSpineSourceDiagnostics.rows_scanned, 0),
          rows_returned: toNumber(canonicalSpineSourceDiagnostics.rows_returned, 0),
          cache_hit: canonicalSpineCacheAudit.cache_hit,
          cache_miss: canonicalSpineCacheAudit.cache_miss,
          cache_age_ms: canonicalSpineCacheAudit.age_ms,
        },
        trade_lifecycle_health: {
          rows_scanned: toNumber(tradeLifecycleHealthSourceDiagnostics.rows_scanned, 0),
          rows_returned: toNumber(tradeLifecycleHealthSourceDiagnostics.rows_returned, 0),
          cache_hit: 0,
          cache_miss: 1,
          cache_age_ms: null,
        },
        hardening_analytics_30d: {
          rows_scanned: toNumber(hardeningAnalyticsSourceDiagnostics.rows_scanned, 0),
          rows_returned: toNumber(hardeningAnalyticsSourceDiagnostics.rows_returned, 0),
          cache_hit: 0,
          cache_miss: 1,
          cache_age_ms: null,
        },
      },
    }).then(() => true),
    LIVE_OPS_DIAGNOSTICS_HISTORY_TIMEOUT_MS,
    false,
  );

  if (!canonicalSpine || !tradeLifecycleHealth || !hardeningAnalytics30d) {
    // A projection timed out: answer with an explicit degraded status instead
    // of letting the payload contract crash on a null snapshot (HTTP 500).
    const missing = [
      !canonicalSpine ? "canonical_spine" : null,
      !tradeLifecycleHealth ? "trade_lifecycle_health" : null,
      !hardeningAnalytics30d ? "hardening_analytics_30d" : null,
    ].filter(Boolean);
    return NextResponse.json(
      { status: "degraded", reason: "projection_timeout", missing_projections: missing, retry: true },
      { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "2" } },
    );
  }
  const validatedResponseBody = assertLiveOpsCriticalPayload(responseBody);
  if (shouldUseUiCache) {
    liveOpsUiResponseCache.set(cacheKey, {
      payload: validatedResponseBody,
      expiresAtMs: Date.now() + LIVE_OPS_UI_CACHE_TTL_MS,
      generatedAtMs: Date.now(),
    });
  }
  return buildLiveOpsResponse(validatedResponseBody, {
    cacheStatus: shouldUseUiCache ? "stored" : "bypass",
    requestSource,
    ageMs: 0,
  });
}
