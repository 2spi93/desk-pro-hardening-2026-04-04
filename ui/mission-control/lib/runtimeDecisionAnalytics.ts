import {
  EXECUTION_DECISION_POLICY_VERSION,
  resolveExecutionDecisionCodeFromJournalAction,
  validateExecutionDecisionAudit,
  type ExecutionDecisionAudit,
  type ExecutionDecisionCode,
} from "./executionDecisionSchema";
import { cpFetchJsonSafe, getControlPlaneToken, getControlPlaneUrl } from "./controlPlane";
import {
  createRuntimeDecisionKpiSnapshot,
  readRuntimeDecisionKpiSnapshots,
} from "./runtimeDecisionKpiStore";
import {
  defaultLocalTerminalCaptureStore,
  type LocalTerminalRuntimeCapture,
  type PersistedLocalTerminalCaptureStore,
} from "./localTerminalCapture";
import { readLocalTerminalCaptureStore } from "./localTerminalCaptureStore";
import { readV2RiskJournalEntries, type V2RiskJournalEntry } from "./v2RiskJournal";

export type RuntimeDecisionBucket = "market" | "runtime" | "policy" | "broker" | "confidence" | "external-governance" | "post-trade" | "legacy" | "unknown";
export type RuntimeDecisionFamily = "routing" | "runtime" | "policy" | "broker" | "confidence" | "external-governance" | "post-trade" | "legacy" | "unknown";
export type RuntimeDecisionTone = "good" | "subtle" | "warn";
export type RuntimeDecisionDriftMetricKey = "routingZeroRate" | "fallbackRate" | "runtimeBlockRate" | "policyBlockRate" | "falsePositiveRate";
export type RuntimeDecisionDriftWindowKey = "1h" | "6h" | "24h";
export type RuntimeDecisionDriftState = "CALM" | "WATCH" | "DRIFT" | "CRITICAL";
export type RuntimeDecisionDriftType = "MARKET_MICROSTRUCTURE" | "MARKET_REGIME" | "EXECUTION_LATENCY" | "EXECUTION_ROUTING" | "SYSTEM_HEALTH" | "MIXED" | "UNKNOWN";
export type RuntimeDecisionOpportunityLiveState = "LIVE" | "NO_EDGE" | "NO_DATA_AUTH" | "NO_DATA_EMPTY" | "NO_DATA_PARTIAL" | "STALE";
export type RuntimeDecisionOpportunityGuardState = "OK" | "PARTIAL_DATA" | "UNTRUSTED" | "BLOCKED_BY_DATA";
export type RuntimeDecisionOpportunityBreakdownKey = "spread" | "depth" | "latency" | "regime";
export type RuntimeDecisionObservationStatus = "INSUFFICIENT" | "OBSERVE" | "READY_FOR_REVIEW";
export type RuntimeDecisionMonitoringSeverity = "info" | "warning" | "critical";
export type RuntimeDecisionObservationWindowStatus = "BUILDING" | "OBSERVING" | "READY";
export type RuntimeDecisionObservationIntegrityStatus = "OK" | "DEGRADED" | "CRITICAL";
export type RuntimeDecisionReliabilityState = "RELIABLE" | "DEGRADED" | "BLOCKED_BY_DATA";
export type RuntimeDecisionOpportunityConfidenceState = "EXPLORATORY" | "WATCHLIST" | "ACTIONABLE_LATER";
export type RuntimeDecisionTelemetryAuthState = "OK" | "MISSING" | "INVALID" | "UNKNOWN";
export type RuntimeDecisionTelemetryRootCause = "LIVE" | "AUTH_FAILURE" | "EMPTY_PAYLOAD" | "PARTIAL_PAYLOAD" | "STALE_TELEMETRY" | "NETWORK_FAILURE";
export type RuntimeDecisionTelemetryIntegrityCode = "NO_MARKET_SPREAD" | "NO_MARKET_DEPTH" | "NO_ROUTE_VENUES" | "NO_EXECUTION_STATS" | "NO_EXECUTION_LATENCY" | "NO_EXECUTION_SLIPPAGE" | "NO_EXECUTION_BUDGET" | "NO_EXECUTION_PROFILE" | "RAW_EXECUTION_PROFILE";

export type RuntimeDecisionTelemetryIntegrityItem = {
  code: RuntimeDecisionTelemetryIntegrityCode;
  label: string;
  detail: string;
  severity: RuntimeDecisionMonitoringSeverity;
  source: "market" | "route";
  affectedVenueCount?: number;
};

export type RuntimeDecisionTelemetryIntegrity = {
  state: "OK" | "PARTIAL" | "UNAVAILABLE";
  summary: string;
  routeCoveragePct: number;
  executionVenueCount: number;
  routeVenueCount: number;
  marketVenueCount: number;
  items: RuntimeDecisionTelemetryIntegrityItem[];
};

export type RuntimeDecisionTelemetryDebug = {
  request: {
    url: string;
    tokenPreview: string;
    hasToken: boolean;
  };
  response: {
    status: number;
    ok: boolean;
    latencyMs: number;
  };
  payload: {
    rawSize: number;
    hasVenues: boolean;
    venuesCount: number;
    hasSpread: boolean;
    hasLatency: boolean;
    topLevelKeys: string[];
    firstRowKeys: string[];
    firstRowNestedKeys: {
      market: string[];
      execution: string[];
      profile: string[];
    };
  };
  parsing: {
    parsedOk: boolean;
    missingFields: string[];
    fallbackUsed: boolean;
    firstRowNormalized: Record<string, unknown> | null;
  };
};

export type RuntimeDecisionReliability = {
  state: RuntimeDecisionReliabilityState;
  blocked: boolean;
  dataCompleteness: number;
  dataCompletenessPct: number;
  observationCoverageHours: number;
  freshnessMs: number | null;
  anomalyRate: number;
  anomalyRatePct: number;
  signalConsistency: number;
  signalConsistencyPct: number;
  summary: string;
  reasons: string[];
  degradedReasons: string[];
  blockingReasons: string[];
};

export type RuntimeDecisionOpportunityConfidence = {
  state: RuntimeDecisionOpportunityConfidenceState;
  sampleSize: number;
  stability: number;
  stabilityPct: number;
  summary: string;
};

export type RuntimeDecisionAnalyticsSample = {
  createdAtIso: string;
  action: string;
  code: string;
  oracleFingerprint: string | null;
  family: RuntimeDecisionFamily;
  bucket: RuntimeDecisionBucket;
  attentionState: string;
  volatilityRegime: string;
  busSeq: number;
  depthAgeMs: number | null;
  detail: string;
};

export type RuntimeDecisionDriftWindowMetrics = {
  label: RuntimeDecisionDriftWindowKey;
  hours: number;
  executionRows: number;
  noTradeRows: number;
  highVolatilityRate: number;
  routingZeroRate: number;
  fallbackRate: number;
  runtimeBlockRate: number;
  policyBlockRate: number;
  falsePositiveRate: number;
  driftScore: number;
  driftScorePct: number;
  type: RuntimeDecisionDriftType;
};

export type RuntimeDecisionDriftAlert = {
  metric: RuntimeDecisionDriftMetricKey;
  currentWindow: Exclude<RuntimeDecisionDriftWindowKey, "24h">;
  baselineWindow: "24h";
  currentRate: number;
  baselineRate: number;
  drift: number;
  type: RuntimeDecisionDriftType;
  score: number;
  scorePct: number;
  severity: "warning" | "critical";
};

export type RuntimeDecisionDriftStatistics = {
  confirmed: boolean;
  ksScore: number;
  ksMetric: RuntimeDecisionDriftMetricKey | "none";
  adwinTriggered: boolean;
  adwinDelta: number;
  adwinSignal: number;
  currentSampleSize: number;
  baselineSampleSize: number;
  sampleSizeFactor: number;
  probability: number;
  probabilityPct: number;
  reliability: number;
  reliabilityPct: number;
  windowConsistency: number;
  windowConsistencyPct: number;
  noiseLevel: number;
  noiseLevelPct: number;
  signalVariance: number;
  confidence: number;
  confidencePct: number;
};

export type RuntimeDecisionDriftCauseFactor = {
  key: "spread" | "routeLatency" | "fillLatency" | "depthLatency" | "routingZeroRate" | "fallbackRate" | "runtimeBlockRate" | "policyBlockRate" | "falsePositiveRate" | "highVolatilityRate";
  label: string;
  current: number | null;
  reference: number | null;
  deltaPct: number | null;
  tone: RuntimeDecisionTone;
  note: string;
};

export type RuntimeDecisionDriftCause = {
  summary: string;
  factors: RuntimeDecisionDriftCauseFactor[];
};

export type RuntimeDecisionDriftAlertFeedEntry = {
  t: number;
  iso: string;
  state: RuntimeDecisionDriftState;
  type: RuntimeDecisionDriftType;
  metric: RuntimeDecisionDriftMetricKey | "none";
  severity: "info" | "warning" | "critical";
  score: number;
  scorePct: number;
  currentRate: number;
  baselineRate: number;
  summary: string;
  source: "active-window" | "history";
};

export type RuntimeDecisionDriftHistoryEntry = {
  t: number;
  iso: string;
  state: RuntimeDecisionDriftState;
  type: RuntimeDecisionDriftType;
  metric: RuntimeDecisionDriftMetricKey | "none";
  score: number;
  scorePct: number;
  currentRate: number;
  baselineRate: number;
  drift: number;
  noTradeRows: number;
};

export type RuntimeDecisionSeriesPoint = {
  t: number;
  iso: string;
  executionRows: number;
  noTradeRate: number;
  routingZeroRate: number;
  fallbackRate: number;
  runtimeBlockRate: number;
  policyBlockRate: number;
  falsePositiveRate: number;
  opportunityRate: number;
  missedOpportunityRate: number;
  executionEfficiency: number;
  driftScore: number;
  driftScorePct: number;
};

export type RuntimeDecisionOpportunityBreakdownItem = {
  key: RuntimeDecisionOpportunityBreakdownKey;
  label: string;
  score: number;
  scorePct: number;
  tone: RuntimeDecisionTone;
  detail: string;
  available?: boolean;
};

export type RuntimeDecisionOpportunityRankedItem = {
  createdAtIso: string;
  code: string;
  oracleFingerprint: string | null;
  bucket: RuntimeDecisionBucket;
  score: number;
  scorePct: number;
  attentionState: string;
  volatilityRegime: string;
  status: "BLOCKED" | "EXECUTED";
  breakdown: RuntimeDecisionOpportunityBreakdownItem[];
  rationale: string;
  confidence?: number;
  confidencePct?: number;
  missing?: RuntimeDecisionOpportunityBreakdownKey[];
};

type RuntimeDecisionOpportunityTelemetry = {
  source: "venue-telemetry" | "context-only";
  availability: "ready" | "partial" | "unavailable";
  venueCount: number;
  marketVenueCount: number;
  routeVenueCount: number;
  avgSpreadBps: number | null;
  avgAvailableDepthUsd: number | null;
  avgDepthLatencyMs: number | null;
  avgFillProbability: number | null;
  avgStabilityScore: number | null;
  avgRouteLatencyMs: number | null;
  avgFillLatencyMs: number | null;
  avgSlippageBps: number | null;
  spreadBudgetBps: number | null;
  latencyBudgetMs: number | null;
  summary: string;
  authState?: RuntimeDecisionTelemetryAuthState;
  rootCause?: RuntimeDecisionTelemetryRootCause;
  missingFields?: string[];
  integrity?: RuntimeDecisionTelemetryIntegrity;
  isStale?: boolean;
  debug?: {
    market: RuntimeDecisionTelemetryDebug;
    route: RuntimeDecisionTelemetryDebug;
  };
};

export type RuntimeDecisionOperatorLiveMetrics = {
  source: "local-terminal-capture" | "unavailable";
  latestCaptureAtIso: string | null;
  latestCaptureAgeSec: number | null;
  latestFeedLabel: string | null;
  latestXchStatus: "LIVE" | "STALE" | "UNKNOWN";
  latestXchAgeLabel: string;
  latestXchSourceLabel: string | null;
  staleRateXchPct: number | null;
  xchSampleCount: number;
  avgBusLagMs: number | null;
  latestBusLagMs: number | null;
  latestEndToEndLagMs: number | null;
  latestBusState: string | null;
  driftProbabilityPct: number;
  driftReliabilityPct: number;
  driftType: RuntimeDecisionDriftType;
  opportunityScorePct: number;
  opportunityCount: number;
  limitingFactor: { label: string; scorePct: number; tone: RuntimeDecisionTone } | null;
  decisionConsistencyPct: number;
  multiChart: RuntimeDecisionFeatureIntegrity;
  v5: RuntimeDecisionFeatureIntegrity & {
    enabled: boolean;
    mode: string;
    drawdownPaused: boolean;
    sourceLabel: string;
    promotionReady: boolean;
    requiredShadowCycles: number;
    observedShadowCycles: number;
    requiredObservationHours: number;
    observedObservationHours: number;
    missingExecutionMetrics: boolean;
  };
  summary: string;
};

export type RuntimeDecisionIntegrityState = "HIGH" | "DEGRADED" | "BROKEN";
export type RuntimeDecisionFeatureIntegrityState = RuntimeDecisionIntegrityState | "INACTIVE";

export type RuntimeDecisionFeatureIntegrity = {
  state: RuntimeDecisionFeatureIntegrityState;
  score: number;
  scorePct: number;
  reasons: string[];
  summary: string;
  activeTiles?: number;
  expectedTiles?: number;
  syncAgeMs?: number | null;
  sourceDivergenceCount?: number;
  masterClockDriftMs?: number | null;
};

export type RuntimeDecisionIntegrity = {
  state: RuntimeDecisionIntegrityState;
  score: number;
  scorePct: number;
  summary: string;
  reasons: string[];
  coverageScore: number;
  freshnessScore: number;
  consistencyScore: number;
  continuityScore: number;
  coverageScorePct: number;
  freshnessScorePct: number;
  consistencyScorePct: number;
  continuityScorePct: number;
  multiChart: RuntimeDecisionFeatureIntegrity;
  v5: RuntimeDecisionOperatorLiveMetrics["v5"];
};

export type RuntimeDecisionMonitoringAlert = {
  id: string;
  severity: RuntimeDecisionMonitoringSeverity;
  label: string;
  summary: string;
  action: string;
  source: "live-capture" | "drift" | "opportunity" | "observation" | "integrity";
};

export type RuntimeDecisionNoTradeHeatmapCell = {
  timeframe: string;
  count: number;
  sharePct: number;
  tone: RuntimeDecisionTone;
  topCode: string;
  topCodeSharePct: number;
  topFalseContextFamily: string | null;
  topFalseContextSharePct: number;
};

export type RuntimeDecisionNoTradeHeatmapRow = {
  regime: string;
  totalCount: number;
  totalSharePct: number;
  cells: RuntimeDecisionNoTradeHeatmapCell[];
};

export type RuntimeDecisionObservationWindowPoint = {
  bucketStartIso: string;
  driftProbability: number;
  reliability: number;
  opportunityScore: number;
  driftFalsePositiveRate: number;
  opportunityHitRate: number;
  decisionConsistency: number;
  driftStability: number;
  driftReliabilityMean: number;
  observationStatus: RuntimeDecisionObservationStatus;
  reliabilityState: RuntimeDecisionReliabilityState | "UNKNOWN";
  observationIntegrityStatus: RuntimeDecisionObservationIntegrityStatus | "UNKNOWN";
  integrityState: RuntimeDecisionIntegrityState | "UNKNOWN";
  integrityScorePct: number;
  gapDensityPct: number;
  noTradeConcentrationPct: number;
  noTradeConcentrationLabel: string | null;
  manualCalibrationEligible: boolean;
};

export type RuntimeDecisionTemporalTrend = {
  direction: "UP" | "DOWN" | "STABLE" | "UNKNOWN";
  deltaPct: number | null;
  baselineScorePct: number | null;
  latestScorePct: number | null;
  summary: string;
};

export type RuntimeDecisionIntegrityRealityCheck = {
  status: "OK" | "WATCH" | "FAIL";
  summary: string;
  reasons: string[];
};

export type RuntimeDecisionTemporalReliabilityDistribution = {
  state: RuntimeDecisionReliabilityState;
  count: number;
  sharePct: number;
  tone: RuntimeDecisionTone;
};

export type RuntimeDecisionTemporalThreshold = {
  key: "reliableShareCeiling" | "driftStabilityFloor" | "gapDensityCeiling" | "noTradeConcentrationFloor" | "integrityVolatilityCeiling";
  label: string;
  status: "PASS" | "WATCH" | "FAIL";
  value: number;
  threshold: number;
  summary: string;
};

export type RuntimeDecisionTemporalValidation = {
  reliabilityDistribution: RuntimeDecisionTemporalReliabilityDistribution[];
  unknownReliabilityCount: number;
  latestReliabilityState: RuntimeDecisionReliabilityState | "UNKNOWN";
  latestIntegrityState: RuntimeDecisionIntegrityState | "UNKNOWN";
  latestIntegrityScorePct: number | null;
  averageIntegrityScorePct: number | null;
  integrityTrend: RuntimeDecisionTemporalTrend;
  integrityVolatilityPct: number | null;
  realityCheck: RuntimeDecisionIntegrityRealityCheck;
  latestGapDensityPct: number;
  averageGapDensityPct: number;
  latestDriftStability: number | null;
  averageDriftStability: number | null;
  latestNoTradeConcentrationPct: number;
  averageNoTradeConcentrationPct: number;
  latestNoTradeConcentrationLabel: string | null;
  thresholds: RuntimeDecisionTemporalThreshold[];
  summary: string;
};

export type RuntimeDecisionGovernanceBudget = {
  state: "NO_CONCLUSION" | "OBSERVE_ONLY" | "MANUAL_REVIEW_ONLY";
  conclusionBudgetPct: number;
  autoPromotionAllowed: false;
  summary: string;
  reasons: string[];
  falseContextMotifs: Array<{ family: string; count: number; sharePct: number }>;
};

export type RuntimeDecisionFalseContextMotif = {
  family: string;
  count: number;
  sharePct: number;
  topReasons: string[];
};

export type RuntimeDecisionObservationGap = {
  startIso: string;
  endIso: string;
  gapHours: number;
};

export type RuntimeDecisionObservationIntegrity = {
  status: RuntimeDecisionObservationIntegrityStatus;
  score: number;
  scorePct: number;
  expectedHours: number;
  coveredHours: number;
  missingHours: number;
  maxGapHours: number;
  anomalies: RuntimeDecisionObservationGap[];
  summary: string;
};

export type RuntimeDecisionObservationWindowDelta = {
  metric: "driftFalsePositiveRate" | "opportunityHitRate" | "decisionConsistency" | "driftReliabilityMean";
  current: number;
  baseline: number | null;
  delta: number | null;
};

export type RuntimeDecisionObservationWindow = {
  status: RuntimeDecisionObservationWindowStatus;
  sampleCount: number;
  coverageHours: number;
  minObservationHours: number;
  maxObservationHours: number;
  points: RuntimeDecisionObservationWindowPoint[];
  latest: RuntimeDecisionObservationWindowPoint | null;
  deltas: RuntimeDecisionObservationWindowDelta[];
  validation: RuntimeDecisionTemporalValidation;
  gateSummary: string;
};

export type RuntimeDecisionAnalyticsSummary = {
  scope: {
    symbol: string;
    timeframe: string;
    strategy: string;
    limit: number;
    sinceDays: number;
  };
  policyVersion: string;
  totals: {
    totalRows: number;
    executionRows: number;
    noTradeRows: number;
    noTradePctWithinExecution: number;
    canonicalRows: number;
    normalizedLegacyRows: number;
    unclassifiedLegacyRows: number;
    canonicalCoveragePct: number;
    effectiveCanonicalCoveragePct: number;
  };
  topCodes: Array<{ code: string; family: RuntimeDecisionFamily; bucket: RuntimeDecisionBucket; count: number; sharePct: number }>;
  byBucket: Array<{ bucket: RuntimeDecisionBucket; count: number; sharePct: number }>;
  byFamily: Array<{ family: RuntimeDecisionFamily; count: number; sharePct: number }>;
  marketContext: {
    volatilityRegime: Array<{ label: string; count: number; sharePct: number }>;
    attentionState: Array<{ label: string; count: number; sharePct: number }>;
    tripleValidationState: Array<{ label: string; count: number; sharePct: number }>;
  };
  semanticMismatchCandidates: {
    count: number;
    sharePct: number;
    samples: RuntimeDecisionAnalyticsSample[];
  };
  falsePositiveCandidates: {
    count: number;
    sharePct: number;
    samples: RuntimeDecisionAnalyticsSample[];
  };
  reliability: RuntimeDecisionReliability;
  opportunity: {
    candidateCount: number;
    blockedCount: number;
    executedCount: number;
    opportunityRate: number;
    missedOpportunityRate: number;
    executionEfficiency: number;
    avgScore: number;
    confidencePct: number;
    highQualityRate: number;
    missingSignals: RuntimeDecisionOpportunityBreakdownKey[];
    blockedByBucket: Array<{ bucket: RuntimeDecisionBucket; count: number; sharePct: number }>;
    topBlockedBucket: { label: RuntimeDecisionBucket; count: number; sharePct: number };
    liveState: RuntimeDecisionOpportunityLiveState;
    liveSummary: string;
    guard: {
      state: RuntimeDecisionOpportunityGuardState;
      blocked: boolean;
      trustScorePct: number;
      summary: string;
      reasons: string[];
    };
    confidenceEngine: RuntimeDecisionOpportunityConfidence;
    telemetry: RuntimeDecisionOpportunityTelemetry;
    breakdown: RuntimeDecisionOpportunityBreakdownItem[];
    topRanked: RuntimeDecisionOpportunityRankedItem[];
    summary: string;
  };
  drift: {
    detected: boolean;
    tone: RuntimeDecisionTone;
    state: RuntimeDecisionDriftState;
    type: RuntimeDecisionDriftType;
    score: number;
    scorePct: number;
    stats: RuntimeDecisionDriftStatistics;
    cause: RuntimeDecisionDriftCause;
    windows: Record<RuntimeDecisionDriftWindowKey, RuntimeDecisionDriftWindowMetrics>;
    alerts: RuntimeDecisionDriftAlert[];
    history: RuntimeDecisionDriftHistoryEntry[];
    alertFeed: RuntimeDecisionDriftAlertFeedEntry[];
    headline: string;
    summary: string;
  };
  series: {
    bucketHours: number;
    windowHours: number;
    points: RuntimeDecisionSeriesPoint[];
  };
  dominant: {
    bucket: { label: RuntimeDecisionBucket; count: number; sharePct: number };
    code: { label: string; count: number; sharePct: number };
    attentionState: { label: string; count: number; sharePct: number };
    volatilityRegime: { label: string; count: number; sharePct: number };
  };
  observation: {
    status: RuntimeDecisionObservationStatus;
    windowDays: number;
    sampleHours: number;
    minObservationHours: number;
    maxObservationHours: number;
    decisionOutcomeCoveragePct: number;
    driftFalsePositiveRate: number;
    driftDetectionRate: number;
    driftStability: number;
    opportunityHitRate: number;
    decisionConsistency: number;
    driftReliabilityMean: number;
    manualCalibrationEligible: boolean;
    autoCalibrationAllowed: false;
    integrity: RuntimeDecisionObservationIntegrity;
    recommendation: string;
  };
  integrity: RuntimeDecisionIntegrity;
  monitoring: {
    live: RuntimeDecisionOperatorLiveMetrics;
    observationWindow: RuntimeDecisionObservationWindow;
    governanceBudget: RuntimeDecisionGovernanceBudget;
    anomalies: {
      activeCount: number;
      rows: RuntimeDecisionMonitoringAlert[];
    };
    noTradeHeatmap: {
      timeframes: string[];
      rows: RuntimeDecisionNoTradeHeatmapRow[];
      summary: string;
    };
    falseContextMotifs: RuntimeDecisionFalseContextMotif[];
  };
  deskRead: {
    tone: RuntimeDecisionTone;
    headline: string;
    summary: string;
    nextAction: string;
  };
};

type DerivedExecutionRow = {
  entry: V2RiskJournalEntry;
  timestampMs: number;
  code: string;
  oracleFingerprint: string | null;
  family: RuntimeDecisionFamily;
  bucket: RuntimeDecisionBucket;
  context: ReturnType<typeof extractContext>;
  hasCanonicalAudit: boolean;
  isNoTrade: boolean;
  semanticMismatch: boolean;
  falsePositiveCandidate: boolean;
  opportunityCandidate: boolean;
};

type DriftSignal = {
  metric: RuntimeDecisionDriftMetricKey | "none";
  currentRate: number;
  baselineRate: number;
  drift: number;
  state: RuntimeDecisionDriftState;
};

const DRIFT_WINDOWS: Array<{ label: RuntimeDecisionDriftWindowKey; hours: number }> = [
  { label: "1h", hours: 1 },
  { label: "6h", hours: 6 },
  { label: "24h", hours: 24 },
];
const DRIFT_CURRENT_WINDOWS: Array<Exclude<RuntimeDecisionDriftWindowKey, "24h">> = ["1h", "6h"];
const DRIFT_WATCH_THRESHOLD = 0.15;
const DRIFT_WARNING_THRESHOLD = 0.3;
const DRIFT_CRITICAL_THRESHOLD = 0.6;
const MIN_CURRENT_NO_TRADE_ROWS = 3;
const MIN_BASELINE_NO_TRADE_ROWS = 10;
const SERIES_BUCKET_HOURS = 1;
const SERIES_WINDOW_HOURS = 24;
const DEFAULT_SPREAD_BUDGET_BPS = 6;
const DEFAULT_ROUTE_LATENCY_BUDGET_MS = 140;
const DEFAULT_FILL_LATENCY_BUDGET_MS = 220;
const DEFAULT_DEPTH_LATENCY_BUDGET_MS = 250;
const DEFAULT_AVAILABLE_DEPTH_REFERENCE_USD = 100_000;

function buildTokenPreview(token: string): string {
  const normalized = String(token || "").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= 12) {
    return normalized;
  }
  return `${normalized.slice(0, 8)}...${normalized.slice(-3)}`;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function safeJsonSize(value: unknown): number {
  try {
    return JSON.stringify(value || {}).length;
  } catch {
    return 0;
  }
}

function safeObjectKeys(value: unknown): string[] {
  return Object.keys(safeRecord(value));
}

function classifyTelemetryAuthState(token: string, statuses: number[]): RuntimeDecisionTelemetryAuthState {
  if (!token) {
    return "MISSING";
  }
  if (statuses.some((status) => status === 401 || status === 403)) {
    return "INVALID";
  }
  if (statuses.length > 0 && statuses.every((status) => status >= 200 && status < 300)) {
    return "OK";
  }
  return "UNKNOWN";
}

function isTelemetryStatusUnauthorized(status: number): boolean {
  return status === 401 || status === 403;
}

function isOpportunityTelemetryStale(telemetry: Pick<RuntimeDecisionOpportunityTelemetry, "avgDepthLatencyMs" | "availability">): boolean {
  if (telemetry.availability === "unavailable") {
    return false;
  }
  return telemetry.avgDepthLatencyMs != null && telemetry.avgDepthLatencyMs > DEFAULT_DEPTH_LATENCY_BUDGET_MS * 4;
}

function safeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function safeRows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function toNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function firstPositiveNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value;
    }
  }
  return null;
}

function toNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function averageNullableNumbers(values: Array<number | null>): number | null {
  const filtered = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (filtered.length === 0) {
    return null;
  }
  return Number((filtered.reduce((sum, value) => sum + value, 0) / filtered.length).toFixed(2));
}

function averageNumbers(values: number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function standardDeviation(values: number[]): number {
  if (values.length <= 1) {
    return 0;
  }
  const mean = averageNumbers(values);
  const variance = averageNumbers(values.map((value) => (value - mean) ** 2));
  return Number(Math.sqrt(variance).toFixed(4));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function toneFromScore(score: number): RuntimeDecisionTone {
  if (score >= 0.72) {
    return "good";
  }
  if (score >= 0.48) {
    return "subtle";
  }
  return "warn";
}

function percent(part: number, total: number): number {
  return total > 0 ? Number(((part / total) * 100).toFixed(2)) : 0;
}

function sortedEntries(map: Map<string, number>): Array<[string, number]> {
  return Array.from(map.entries()).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
}

function parseTimestamp(iso: string): number {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toHourBucketStartIso(timestampMs: number): string | null {
  if (!Number.isFinite(timestampMs)) {
    return null;
  }
  const bucketMs = Math.floor(timestampMs / (60 * 60 * 1000)) * 60 * 60 * 1000;
  return new Date(bucketMs).toISOString();
}

function toHourBucketStartMs(timestampMs: number): number | null {
  if (!Number.isFinite(timestampMs)) {
    return null;
  }
  return Math.floor(timestampMs / (60 * 60 * 1000)) * 60 * 60 * 1000;
}

function countCoveredHourBucketsFromTimestamps(timestamps: number[]): number {
  const buckets = new Set<string>();
  for (const timestampMs of timestamps) {
    const bucketStartIso = toHourBucketStartIso(timestampMs);
    if (bucketStartIso) {
      buckets.add(bucketStartIso);
    }
  }
  return buckets.size;
}

function buildObservationIntegrity(timestamps: number[]): RuntimeDecisionObservationIntegrity {
  const bucketStarts = Array.from(new Set(
    timestamps
      .map((timestampMs) => toHourBucketStartMs(timestampMs))
      .filter((value): value is number => value != null),
  )).sort((left, right) => left - right);
  const coveredHours = bucketStarts.length;

  if (coveredHours === 0) {
    return {
      status: "CRITICAL",
      score: 0,
      scorePct: 0,
      expectedHours: 0,
      coveredHours: 0,
      missingHours: 0,
      maxGapHours: 0,
      anomalies: [],
      summary: "Observation integrity unavailable: aucun bucket horaire couvre la fenetre analysee.",
    };
  }

  const expectedHours = Math.max(1, Math.round((bucketStarts[coveredHours - 1] - bucketStarts[0]) / (60 * 60 * 1000)) + 1);
  const missingHours = Math.max(0, expectedHours - coveredHours);
  const anomalies: RuntimeDecisionObservationGap[] = [];
  let maxGapHours = 0;

  for (let index = 1; index < bucketStarts.length; index += 1) {
    const gapHours = Math.max(0, Math.round((bucketStarts[index] - bucketStarts[index - 1]) / (60 * 60 * 1000)) - 1);
    if (gapHours <= 0) {
      continue;
    }
    maxGapHours = Math.max(maxGapHours, gapHours);
    if (gapHours > 2) {
      anomalies.push({
        startIso: new Date(bucketStarts[index - 1]).toISOString(),
        endIso: new Date(bucketStarts[index]).toISOString(),
        gapHours,
      });
    }
  }

  const score = Number((coveredHours / Math.max(expectedHours, 1)).toFixed(4));
  const scorePct = Number((score * 100).toFixed(1));
  const status: RuntimeDecisionObservationIntegrityStatus = score >= 0.97 && maxGapHours <= 1
    ? "OK"
    : score >= 0.9 && maxGapHours <= 2
      ? "DEGRADED"
      : "CRITICAL";
  const summary = status === "OK"
    ? `Observation integrity OK · coverage ${coveredHours}/${expectedHours}h · max gap ${maxGapHours}h.`
    : status === "DEGRADED"
      ? `Observation integrity degraded · coverage ${coveredHours}/${expectedHours}h · missing ${missingHours}h · max gap ${maxGapHours}h.`
      : `Observation integrity critical · coverage ${coveredHours}/${expectedHours}h · missing ${missingHours}h · max gap ${maxGapHours}h${anomalies.length > 0 ? ` · gaps>2h ${anomalies.length}` : ""}.`;

  return {
    status,
    score,
    scorePct,
    expectedHours,
    coveredHours,
    missingHours,
    maxGapHours,
    anomalies,
    summary,
  };
}

function countCoveredHourBucketsFromIso(buckets: string[]): number {
  const normalized = buckets
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  return new Set(normalized).size;
}

const RELIABILITY_REQUIRED_TELEMETRY_FIELDS = ["spread", "depth", "execution", "latency", "slippage", "budget_profile"] as const;

function buildReliability(input: {
  telemetry: RuntimeDecisionOpportunityTelemetry;
  observation: Pick<RuntimeDecisionAnalyticsSummary["observation"], "status" | "integrity" | "sampleHours" | "decisionConsistency">;
  liveState: RuntimeDecisionOpportunityLiveState;
}): RuntimeDecisionReliability {
  const missingFields = Array.isArray(input.telemetry.missingFields)
    ? input.telemetry.missingFields.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
  const missingRequiredCount = RELIABILITY_REQUIRED_TELEMETRY_FIELDS.filter((field) => missingFields.includes(field)).length;
  const dataCompleteness = clamp01((RELIABILITY_REQUIRED_TELEMETRY_FIELDS.length - missingRequiredCount) / RELIABILITY_REQUIRED_TELEMETRY_FIELDS.length);
  const dataCompletenessPct = Number((dataCompleteness * 100).toFixed(1));
  const freshnessCandidates = [
    input.telemetry.avgRouteLatencyMs,
    input.telemetry.avgFillLatencyMs,
    input.telemetry.avgDepthLatencyMs,
  ].filter((value): value is number => Number.isFinite(value));
  const freshnessMs = freshnessCandidates.length > 0 ? Math.max(...freshnessCandidates) : null;
  const observationCoverageHours = Number(input.observation.sampleHours || 0);
  const expectedHours = Math.max(1, input.observation.integrity.expectedHours || 0);
  const anomalyRate = clamp01(Math.max(
    input.observation.integrity.anomalies.length / expectedHours,
    input.observation.integrity.missingHours / expectedHours,
  ));
  const anomalyRatePct = Number((anomalyRate * 100).toFixed(1));
  const signalConsistency = clamp01((input.observation.decisionConsistency || 0) / 100);
  const signalConsistencyPct = Number((signalConsistency * 100).toFixed(1));
  const blockingReasons: string[] = [];
  const degradedReasons: string[] = [];

  if (dataCompleteness < 0.8) {
    blockingReasons.push(`data completeness ${dataCompletenessPct}%`);
  }
  if (["NO_DATA_AUTH", "NO_DATA_PARTIAL", "NO_DATA_EMPTY", "STALE"].includes(input.liveState)) {
    blockingReasons.push(`live telemetry ${input.liveState.toLowerCase()}`);
  }
  if (input.observation.integrity.score < 0.9) {
    blockingReasons.push(`observation coverage ${input.observation.integrity.coveredHours}/${input.observation.integrity.expectedHours}h`);
  }

  if (observationCoverageHours < 24) {
    degradedReasons.push(`observation window ${observationCoverageHours.toFixed(1)}h < 24h`);
  }
  if (anomalyRate > 0.3) {
    degradedReasons.push(`anomaly rate ${anomalyRatePct}%`);
  }
  if (freshnessMs != null && freshnessMs > 5_000) {
    degradedReasons.push(`freshness ${Math.round(freshnessMs)}ms`);
  }
  if (signalConsistency < 0.65) {
    degradedReasons.push(`signal consistency ${signalConsistencyPct}%`);
  }

  const reasons = Array.from(new Set([...blockingReasons, ...degradedReasons]));
  const state: RuntimeDecisionReliabilityState = blockingReasons.length > 0
    ? "BLOCKED_BY_DATA"
    : degradedReasons.length > 0
      ? "DEGRADED"
      : "RELIABLE";
  const summary = state === "BLOCKED_BY_DATA"
    ? `BLOCKED_BY_DATA · ${blockingReasons.slice(0, 4).join(" · ") || input.observation.integrity.summary}`
    : state === "DEGRADED"
      ? `DEGRADED · ${degradedReasons.slice(0, 4).join(" · ")}`
      : `RELIABLE · completeness ${dataCompletenessPct}% · coverage ${observationCoverageHours.toFixed(1)}h · consistency ${signalConsistencyPct}%`;

  return {
    state,
    blocked: state === "BLOCKED_BY_DATA",
    dataCompleteness,
    dataCompletenessPct,
    observationCoverageHours,
    freshnessMs,
    anomalyRate,
    anomalyRatePct,
    signalConsistency,
    signalConsistencyPct,
    summary,
    reasons,
    degradedReasons,
    blockingReasons,
  };
}

function buildOpportunityConfidence(input: {
  signalScore: number;
  reliability: RuntimeDecisionReliabilityState;
  sampleSize: number;
  stability: number;
}): RuntimeDecisionOpportunityConfidence {
  const signalScorePct = Number((clamp01(input.signalScore) * 100).toFixed(1));
  const stability = clamp01(input.stability);
  const stabilityPct = Number((stability * 100).toFixed(1));

  if (input.reliability !== "RELIABLE") {
    return {
      state: "EXPLORATORY",
      sampleSize: input.sampleSize,
      stability,
      stabilityPct,
      summary: `EXPLORATORY · reliability ${input.reliability} impose une lecture non actionnable.`,
    };
  }
  if (input.sampleSize < 50) {
    return {
      state: "EXPLORATORY",
      sampleSize: input.sampleSize,
      stability,
      stabilityPct,
      summary: `EXPLORATORY · sample size ${input.sampleSize} < 50.`,
    };
  }
  if (stability < 0.6) {
    return {
      state: "WATCHLIST",
      sampleSize: input.sampleSize,
      stability,
      stabilityPct,
      summary: `WATCHLIST · stability ${stabilityPct}% encore insuffisante pour une lecture actionnable.`,
    };
  }
  return {
    state: "ACTIONABLE_LATER",
    sampleSize: input.sampleSize,
    stability,
    stabilityPct,
    summary: `ACTIONABLE_LATER · signal ${signalScorePct}% stabilise mais reserve a la phase post-calibration.`,
  };
}

function timeframeSortValue(value: string): number {
  const match = value.trim().toLowerCase().match(/^(\d+)(s|m|h|d|w|mo)$/);
  if (!match) {
    return Number.MAX_SAFE_INTEGER;
  }
  const amount = Number(match[1]);
  const unit = match[2];
  const multiplier = unit === "s"
    ? 1
    : unit === "m"
      ? 60
      : unit === "h"
        ? 3_600
        : unit === "d"
          ? 86_400
          : unit === "w"
            ? 604_800
            : 2_592_000;
  return amount * multiplier;
}

function isHighVolatilityRegime(value: string): boolean {
  return /(high|extreme|volatile|stress)/.test(value.trim().toLowerCase());
}

function formatCompactUsd(value: number | null): string {
  if (value == null || !Number.isFinite(value)) {
    return "n/a";
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M USD`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 1_000)}k USD`;
  }
  return `${Math.round(value)} USD`;
}

function formatCompactLag(value: number | null): string {
  if (value == null || !Number.isFinite(value)) {
    return "n/a";
  }
  if (value < 1_000) {
    return `${Math.round(value)}ms`;
  }
  if (value < 60_000) {
    return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}s`;
  }
  return `${Math.round(value / 60_000)}m`;
}

function monitoringSeverityRank(value: RuntimeDecisionMonitoringSeverity): number {
  if (value === "critical") {
    return 3;
  }
  if (value === "warning") {
    return 2;
  }
  return 1;
}

function heatmapTone(count: number, sharePct: number): RuntimeDecisionTone {
  if (count <= 0) {
    return "subtle";
  }
  if (sharePct >= 15) {
    return "warn";
  }
  if (sharePct >= 5) {
    return "subtle";
  }
  return "good";
}

function driftTypeLabel(value: RuntimeDecisionDriftType): string {
  switch (value) {
    case "MARKET_MICROSTRUCTURE":
      return "market microstructure";
    case "MARKET_REGIME":
      return "market regime";
    case "EXECUTION_LATENCY":
      return "execution latency";
    case "EXECUTION_ROUTING":
      return "execution routing";
    case "SYSTEM_HEALTH":
      return "system health";
    case "MIXED":
      return "mixed";
    default:
      return "unknown";
  }
}

function normalizeExecutionOutcomeCode(value: string): ExecutionDecisionCode {
  const normalized = value.trim().toLowerCase();
  if (/(good|positive|profit|win|clean|ok|success)/.test(normalized)) {
    return "execution-v7-outcome-positive";
  }
  if (/(bad|negative|loss|fail|blocked|reject|degraded|warn)/.test(normalized)) {
    return "execution-v7-outcome-negative";
  }
  return "execution-v7-outcome-neutral";
}

function extractFinalDecisionTruth(entry: V2RiskJournalEntry): Record<string, unknown> {
  const meta = safeRecord(entry.meta);
  const tradeResult = safeRecord(meta.trade_result);
  const tradeMetadata = safeRecord(tradeResult.metadata);
  const orderIntent = safeRecord(tradeResult.order_intent);
  const direct = safeRecord(meta.final_decision_truth);
  if (Object.keys(direct).length > 0) {
    return direct;
  }
  const nested = safeRecord(tradeResult.final_decision_truth);
  if (Object.keys(nested).length > 0) {
    return nested;
  }
  const metadataNested = safeRecord(tradeMetadata.final_decision_truth);
  if (Object.keys(metadataNested).length > 0) {
    return metadataNested;
  }
  return safeRecord(orderIntent.final_decision_truth);
}

function deriveFinalDecisionCode(finalDecisionTruth: Record<string, unknown>): string | null {
  const action = String(finalDecisionTruth.action || "").trim().toUpperCase();
  const blockingLayer = String(finalDecisionTruth.blocking_layer || "").trim().toLowerCase();
  if (!action) {
    return null;
  }
  if (action === "EXECUTE") {
    return "final-decision-execute";
  }
  if (action === "REDUCE") {
    return blockingLayer ? `final-decision-${blockingLayer}-reduce` : "final-decision-reduce";
  }
  if (action === "WAIT") {
    return blockingLayer ? `final-decision-${blockingLayer}-wait` : "final-decision-wait";
  }
  if (action === "BLOCK") {
    return blockingLayer ? `final-decision-${blockingLayer}-block` : "final-decision-block";
  }
  return null;
}

function deriveCanonicalCode(entry: V2RiskJournalEntry): string {
  const meta = safeRecord(entry.meta);
  const audit = validateExecutionDecisionAudit(meta.decision_audit);
  if (audit) {
    return audit.code;
  }

  const finalDecisionTruth = extractFinalDecisionTruth(entry);
  const finalDecisionCode = deriveFinalDecisionCode(finalDecisionTruth);
  if (finalDecisionCode) {
    return finalDecisionCode;
  }

  const action = String(entry.action || "").trim().toLowerCase();
  const detail = String(entry.detail || "").trim().toLowerCase();
  const executionLock = safeRecord(meta.execution_lock);
  const resolved = resolveExecutionDecisionCodeFromJournalAction(action, { executionLockCode: executionLock.code });
  if (resolved) {
    return resolved;
  }
  if (action.startsWith("execution-v7-outcome-")) {
    return normalizeExecutionOutcomeCode(action.slice("execution-v7-outcome-".length));
  }
  if (action === "execution-disabled-routing") {
    if (detail.includes("routing score 0")) return "routing-score-zero";
    if (detail.includes("routing remains blocked")) return "routing-blocked";
    if (detail.includes("recovery") && detail.includes("actif")) return "runtime-recovery-lockdown";
    if (detail.includes("watchdog halt")) return "runtime-watchdog-halt";
    if (detail.includes("readiness degraded") || detail.includes("live readiness")) return "runtime-live-readiness-degraded";
    if (detail.includes("mt5 bridge")) return "runtime-mt5-bridge-degraded";
  }
  return "legacy-unclassified";
}

function extractOracleFingerprint(
  audit: ExecutionDecisionAudit | null,
  finalDecisionTruth: Record<string, unknown>,
): string | null {
  const auditFingerprint = String(audit?.oracleFingerprint || "").trim();
  if (auditFingerprint) {
    return auditFingerprint;
  }
  const truthFingerprint = String(finalDecisionTruth.oracle_fingerprint || "").trim();
  return truthFingerprint || null;
}

function classifyCode(code: string): { family: RuntimeDecisionFamily; bucket: RuntimeDecisionBucket } {
  if (code.startsWith("final-decision-")) {
    if (code.includes("-confidence-")) {
      return { family: "confidence", bucket: "confidence" };
    }
    if (code.includes("-router-")) {
      return { family: "routing", bucket: "market" };
    }
    if (code.includes("-attention-")) {
      return { family: "runtime", bucket: "market" };
    }
    if (code.includes("-truth-")) {
      return { family: "runtime", bucket: "runtime" };
    }
    if (code.includes("-feedback-")) {
      return { family: "post-trade", bucket: "post-trade" };
    }
    if (code.includes("-execution-lock-") || code.includes("-smart-decision-") || code.includes("-risk-")) {
      return { family: "policy", bucket: "policy" };
    }
    if (code === "final-decision-execute") {
      return { family: "post-trade", bucket: "post-trade" };
    }
    return { family: "policy", bucket: "policy" };
  }
  switch (code) {
    case "runtime-kill-switch-active":
    case "runtime-watchdog-halt":
    case "runtime-recovery-lockdown":
    case "runtime-live-readiness-degraded":
      return { family: "runtime", bucket: "runtime" };
    case "runtime-external-kill-switch-active":
      return { family: "external-governance", bucket: "external-governance" };
    case "runtime-mt5-bridge-degraded":
      return { family: "broker", bucket: "broker" };
    case "engine-v4-off":
    case "execution-v7-blocked":
      return { family: "policy", bucket: "policy" };
    case "routing-score-zero":
    case "routing-blocked":
      return { family: "routing", bucket: "market" };
    case "fallback-mode":
      return { family: "routing", bucket: "runtime" };
    case "execution-v7-outcome-positive":
    case "execution-v7-outcome-neutral":
    case "execution-v7-outcome-negative":
      return { family: "post-trade", bucket: "post-trade" };
    case "legacy-unclassified":
      return { family: "legacy", bucket: "legacy" };
    default:
      if (code.includes("confidence")) {
        return { family: "confidence", bucket: "confidence" };
      }
      if (/(broker|mt5|bridge)/i.test(code)) {
        return { family: "broker", bucket: "broker" };
      }
      return { family: "unknown", bucket: "unknown" };
  }
}

function extractContext(entry: V2RiskJournalEntry) {
  const meta = safeRecord(entry.meta);
  const attention = safeRecord(meta.attention_context);
  const context = safeRecord(attention.context);
  const sync = safeRecord(meta.sync_diagnostics);
  const finalDecisionTruth = extractFinalDecisionTruth(entry);
  const falseContext = safeRecord(finalDecisionTruth.false_context);
  const depthAgeRaw = sync.depth_age_ms;
  const temporalDriftRaw = context.temporalDriftMs ?? context.temporal_drift_ms;
  return {
    attentionState: String(attention.state || "unknown"),
    volatilityRegime: String(context.volatilityRegime || "unknown"),
    tripleValidationState: String(context.triple_validation_state || safeRecord(meta.triple_validation).state || "unknown"),
    shouldBlockTrading: Boolean(attention.shouldBlockTrading || attention.should_block_trading),
    executionQualityScore: toNumber(context.executionQualityScore ?? context.execution_quality_score, 0),
    temporalDriftMs: typeof temporalDriftRaw === "number" && Number.isFinite(temporalDriftRaw) ? temporalDriftRaw : null,
    manipulationRisk: toNumber(context.manipulationRisk ?? context.manipulation_risk, 0),
    busSeq: Math.max(0, Math.round(toNumber(sync.bus_seq, 0))),
    depthAgeMs: typeof depthAgeRaw === "number" && Number.isFinite(depthAgeRaw) ? Math.max(0, Math.round(depthAgeRaw)) : null,
    falseContextFamily: String(falseContext.family || "").trim().toUpperCase() || null,
    falseContextNoTrade: Boolean(falseContext.no_trade),
    falseContextReasonTags: Array.isArray(falseContext.reasons)
      ? falseContext.reasons.map((reason) => String(reason || "").trim()).filter(Boolean)
      : [],
  };
}

function isExecutionRow(entry: V2RiskJournalEntry): boolean {
  return String(entry.action || "").trim().toLowerCase().startsWith("execution-");
}

function isNoTradeAction(entry: V2RiskJournalEntry): boolean {
  const action = String(entry.action || "").trim().toLowerCase();
  return action.includes("disabled") || action.includes("blocked");
}

function detectSemanticMismatch(code: string, detail: string): boolean {
  const normalizedDetail = detail.trim().toLowerCase();
  if (!normalizedDetail) {
    return false;
  }
  if (code === "runtime-live-readiness-degraded" && (normalizedDetail.includes("healthy") || normalizedDetail.includes("failure none"))) {
    return true;
  }
  if (code === "runtime-mt5-bridge-degraded" && normalizedDetail.includes("ok")) {
    return true;
  }
  if (code === "fallback-mode" && !normalizedDetail.includes("fallback")) {
    return true;
  }
  return false;
}

function isOpportunityCandidate(context: ReturnType<typeof extractContext>): boolean {
  return context.attentionState === "stable"
    && !context.shouldBlockTrading
    && context.busSeq > 0
    && context.manipulationRisk < 0.35;
}

function buildSample(row: DerivedExecutionRow): RuntimeDecisionAnalyticsSample {
  return {
    createdAtIso: row.entry.createdAtIso,
    action: row.entry.action,
    code: row.code,
    oracleFingerprint: row.oracleFingerprint,
    family: row.family,
    bucket: row.bucket,
    attentionState: row.context.attentionState,
    volatilityRegime: row.context.volatilityRegime,
    busSeq: row.context.busSeq,
    depthAgeMs: row.context.depthAgeMs,
    detail: row.entry.detail,
  };
}

function toLabelRows(entries: Array<[string, number]>, total: number): Array<{ label: string; count: number; sharePct: number }> {
  return entries.map(([label, count]) => ({ label, count, sharePct: percent(count, total) }));
}

function topRow<T extends string>(rows: Array<{ label: T; count: number; sharePct: number }>, fallback: T) {
  return rows[0] || { label: fallback, count: 0, sharePct: 0 };
}

function toDriftRate(count: number, noTradeRows: number): number {
  return percent(count, noTradeRows);
}

function computeDrift(currentRate: number, baselineRate: number): number {
  if (baselineRate <= 0) {
    return currentRate > 0 ? 1 : 0;
  }
  return Number(((currentRate - baselineRate) / baselineRate).toFixed(4));
}

function deltaPct(current: number | null, reference: number | null): number | null {
  if (current == null || reference == null || reference <= 0) {
    return null;
  }
  return Number((((current - reference) / reference) * 100).toFixed(1));
}

function toneFromDelta(delta: number | null, positiveWarnThreshold = 10): RuntimeDecisionTone {
  if (delta == null) {
    return "subtle";
  }
  if (delta >= positiveWarnThreshold) {
    return "warn";
  }
  if (delta >= 0) {
    return "subtle";
  }
  return "good";
}

function computeGlobalDriftScore(metrics: Pick<RuntimeDecisionDriftWindowMetrics, "routingZeroRate" | "runtimeBlockRate" | "fallbackRate" | "policyBlockRate">): number {
  return Number((
    clamp01(metrics.routingZeroRate / 100) * 0.4
    + clamp01(metrics.runtimeBlockRate / 100) * 0.3
    + clamp01(metrics.fallbackRate / 100) * 0.2
    + clamp01(metrics.policyBlockRate / 100) * 0.1
  ).toFixed(4));
}

function ksTest(sampleA: number[], sampleB: number[]): number {
  if (sampleA.length === 0 || sampleB.length === 0) {
    return 0;
  }
  const sortedA = sampleA.slice().sort((left, right) => left - right);
  const sortedB = sampleB.slice().sort((left, right) => left - right);
  let indexA = 0;
  let indexB = 0;
  let maxDiff = 0;

  while (indexA < sortedA.length && indexB < sortedB.length) {
    const value = Math.min(sortedA[indexA], sortedB[indexB]);
    while (indexA < sortedA.length && sortedA[indexA] <= value) {
      indexA += 1;
    }
    while (indexB < sortedB.length && sortedB[indexB] <= value) {
      indexB += 1;
    }
    maxDiff = Math.max(maxDiff, Math.abs(indexA / sortedA.length - indexB / sortedB.length));
  }

  return Number(maxDiff.toFixed(4));
}

function detectAdwinDrift(values: number[]): { detected: boolean; delta: number } {
  if (values.length < 8) {
    return { detected: false, delta: 0 };
  }
  const midpoint = Math.floor(values.length / 2);
  const first = values.slice(0, midpoint);
  const second = values.slice(midpoint);
  if (first.length === 0 || second.length === 0) {
    return { detected: false, delta: 0 };
  }
  const delta = Math.abs(averageNumbers(second) - averageNumbers(first));
  return {
    detected: delta > 0.15,
    delta: Number(delta.toFixed(4)),
  };
}

function extractTelemetryItems(payload: unknown): Record<string, unknown>[] {
  const envelope = safeRecord(payload);
  const directVenues = safeRows(envelope.venues);
  if (directVenues.length > 0) {
    return directVenues;
  }
  const directItems = safeRows(envelope.items);
  if (directItems.length > 0) {
    return directItems;
  }
  const nestedPayload = safeRecord(envelope.payload);
  const nestedVenues = safeRows(nestedPayload.venues);
  if (nestedVenues.length > 0) {
    return nestedVenues;
  }
  return safeRows(nestedPayload.items);
}

function normalizeMarketTelemetryRow(row: Record<string, unknown>) {
  const nestedMarket = safeRecord(row.market);
  const market = Object.keys(nestedMarket).length > 0 ? nestedMarket : row;
  const instruments = safeRows(market.instruments);
  const instrumentSpreadBps = averageNullableNumbers(instruments.map((item) => toNullableNumber(item.spread_bps)));
  const instrumentDepthUsd = averageNullableNumbers(instruments.map((item) => toNullableNumber(item.available_depth_usd)));
  const instrumentFillProbability = averageNullableNumbers(instruments.map((item) => toNullableNumber(item.fill_probability)));
  const instrumentStabilityScore = averageNullableNumbers(instruments.map((item) => toNullableNumber(item.stability_score)));
  return {
    venue: String(row.venue || market.venue || "unknown").trim() || "unknown",
    avgSpreadBps: firstNumber(market.avg_spread_bps, market.spread_bps, instrumentSpreadBps),
    avgAvailableDepthUsd: firstNumber(market.avg_available_depth_usd, market.available_depth_usd, instrumentDepthUsd),
    avgDepthLatencyMs: firstNumber(market.avg_depth_latency_ms, market.depth_latency_ms, market.max_depth_freshness_ms, market.freshness_ms),
    avgFillProbability: firstNumber(market.avg_fill_probability, market.fill_probability, instrumentFillProbability),
    avgStabilityScore: firstNumber(market.avg_stability_score, market.stability_score, instrumentStabilityScore),
  };
}

function normalizeRouteTelemetryRow(row: Record<string, unknown>) {
  const execution = safeRecord(row.execution);
  const profile = safeRecord(row.profile);
  const hasExecutionStats = Object.keys(execution).length > 0;
  const profileLatencyBaseMs = firstPositiveNumber(profile.latency_base_ms, row.latency_base_ms);
  const profileLatencyJitterMs = firstPositiveNumber(profile.latency_jitter_ms, row.latency_jitter_ms);
  const spreadBudgetBps = firstPositiveNumber(profile.max_spread_bps, row.max_spread_bps);
  const latencyBudgetMs = firstPositiveNumber(profile.max_latency_ms, row.max_latency_ms);
  const profileShape = spreadBudgetBps != null || latencyBudgetMs != null
    ? "budgeted"
    : profileLatencyBaseMs != null || profileLatencyJitterMs != null
      ? "venue-latency-baseline"
      : Object.keys(profile).length > 0
        ? "raw"
        : "none";
  return {
    venue: String(row.venue || execution.venue || "unknown").trim() || "unknown",
    avgRouteLatencyMs: firstNumber(row.latency_ms, row.avg_latency_ms, execution.avg_latency_ms, execution.avg_fill_latency_ms),
    avgFillLatencyMs: firstNumber(execution.avg_fill_latency_ms, execution.latency_ms, row.avg_fill_latency_ms),
    avgSlippageBps: firstNumber(execution.avg_slippage_bps, row.avg_slippage_bps),
    spreadBudgetBps,
    latencyBudgetMs,
    hasExecutionStats,
    profileShape,
    profileLatencyBaseMs,
    profileLatencyJitterMs,
    profileMatchingRule: String(profile.matching_rule || "").trim() || null,
    profileKeys: safeObjectKeys(profile),
  };
}

function buildTelemetryIntegrity(input: {
  marketRows: Array<ReturnType<typeof normalizeMarketTelemetryRow>>;
  routeRows: Array<ReturnType<typeof normalizeRouteTelemetryRow>>;
  hasSpread: boolean;
  hasDepth: boolean;
  hasRouteExecution: boolean;
  hasRouteLatency: boolean;
  hasRouteSlippage: boolean;
  hasRouteBudget: boolean;
  hasRouteProfileShape: boolean;
  routeBaselineProfileDetected: boolean;
}): RuntimeDecisionTelemetryIntegrity {
  const items: RuntimeDecisionTelemetryIntegrityItem[] = [];
  const executionVenueCount = input.routeRows.filter((row) => row.hasExecutionStats).length;
  const routeProfileKeys = uniqueStrings(input.routeRows.flatMap((row) => row.profileKeys || []));

  if (!input.hasSpread) {
    items.push({
      code: "NO_MARKET_SPREAD",
      label: "NO_MARKET_SPREAD",
      detail: "spread market absent",
      severity: "warning",
      source: "market",
      affectedVenueCount: input.marketRows.length,
    });
  }
  if (!input.hasDepth) {
    items.push({
      code: "NO_MARKET_DEPTH",
      label: "NO_MARKET_DEPTH",
      detail: "depth/fill probability market absente",
      severity: "warning",
      source: "market",
      affectedVenueCount: input.marketRows.length,
    });
  }
  if (input.routeRows.length === 0) {
    items.push({
      code: "NO_ROUTE_VENUES",
      label: "NO_ROUTE_VENUES",
      detail: "aucune venue route exploitable dans la payload",
      severity: "critical",
      source: "route",
      affectedVenueCount: 0,
    });
  } else {
    if (!input.hasRouteExecution) {
      items.push({
        code: "NO_EXECUTION_STATS",
        label: "NO_EXECUTION_STATS",
        detail: `stats execution route absentes sur ${input.routeRows.length} venue(s)`,
        severity: "critical",
        source: "route",
        affectedVenueCount: input.routeRows.length,
      });
    }
    if (!input.hasRouteLatency) {
      items.push({
        code: "NO_EXECUTION_LATENCY",
        label: "NO_EXECUTION_LATENCY",
        detail: "latence execution/route non observee",
        severity: "critical",
        source: "route",
        affectedVenueCount: input.routeRows.length,
      });
    }
    if (!input.hasRouteSlippage) {
      items.push({
        code: "NO_EXECUTION_SLIPPAGE",
        label: "NO_EXECUTION_SLIPPAGE",
        detail: "slippage execution absent",
        severity: "critical",
        source: "route",
        affectedVenueCount: input.routeRows.length,
      });
    }
    if (!input.hasRouteBudget) {
      if (input.routeBaselineProfileDetected || input.hasRouteProfileShape) {
        items.push({
          code: "RAW_EXECUTION_PROFILE",
          label: "RAW_EXECUTION_PROFILE",
          detail: routeProfileKeys.length > 0
            ? `profile route brut detecte (${routeProfileKeys.slice(0, 4).join(", ")})`
            : "profile route brut detecte",
          severity: "warning",
          source: "route",
          affectedVenueCount: input.routeRows.length,
        });
        items.push({
          code: "NO_EXECUTION_BUDGET",
          label: "NO_EXECUTION_BUDGET",
          detail: "budgets route max_* absents",
          severity: "warning",
          source: "route",
          affectedVenueCount: input.routeRows.length,
        });
      } else {
        items.push({
          code: "NO_EXECUTION_PROFILE",
          label: "NO_EXECUTION_PROFILE",
          detail: "profile route absent",
          severity: "warning",
          source: "route",
          affectedVenueCount: input.routeRows.length,
        });
      }
    }
  }

  const state: RuntimeDecisionTelemetryIntegrity["state"] = items.length === 0
    ? "OK"
    : input.marketRows.length === 0 && input.routeRows.length === 0
      ? "UNAVAILABLE"
      : "PARTIAL";
  const routeCoveragePct = input.routeRows.length > 0 ? percent(executionVenueCount, input.routeRows.length) : 0;
  const summary = items.length === 0
    ? `execution telemetry OK · route ${executionVenueCount}/${input.routeRows.length || 0} venue(s) avec stats execution`
    : `execution telemetry ${state.toLowerCase()} · route ${executionVenueCount}/${input.routeRows.length || 0} venue(s) avec stats execution · ${items.slice(0, 5).map((item) => item.label).join(" · ")}`;

  return {
    state,
    summary,
    routeCoveragePct,
    executionVenueCount,
    routeVenueCount: input.routeRows.length,
    marketVenueCount: input.marketRows.length,
    items,
  };
}

function detectMarketTelemetryMissingFields(rows: Array<ReturnType<typeof normalizeMarketTelemetryRow>>): string[] {
  const missingFields: string[] = [];
  if (rows.length === 0) {
    missingFields.push("venues");
  }
  if (!rows.some((row) => row.avgSpreadBps != null)) {
    missingFields.push("spread");
  }
  if (!rows.some((row) => row.avgDepthLatencyMs != null)) {
    missingFields.push("latency");
  }
  return uniqueStrings(missingFields);
}

function detectRouteTelemetryMissingFields(rows: Array<ReturnType<typeof normalizeRouteTelemetryRow>>): string[] {
  const missingFields: string[] = [];
  if (rows.length === 0) {
    missingFields.push("venues");
  }
  if (!rows.some((row) => row.hasExecutionStats)) {
    missingFields.push("execution");
  }
  if (!rows.some((row) => row.avgRouteLatencyMs != null || row.avgFillLatencyMs != null)) {
    missingFields.push("latency");
  }
  if (!rows.some((row) => row.avgSlippageBps != null)) {
    missingFields.push("slippage");
  }
  if (!rows.some((row) => row.spreadBudgetBps != null || row.latencyBudgetMs != null)) {
    missingFields.push(rows.some((row) => row.profileShape !== "none") ? "budget_profile" : "profile");
  }
  return uniqueStrings(missingFields);
}

async function readMarketTelemetryDebug(path: string, token: string): Promise<{
  rows: Array<ReturnType<typeof normalizeMarketTelemetryRow>>;
  status: number;
  ok: boolean;
  debug: RuntimeDecisionTelemetryDebug;
}> {
  const startedAt = Date.now();
  const requestUrl = `${getControlPlaneUrl()}${path}`;
  const tokenPreview = buildTokenPreview(token);
  const hasToken = Boolean(token);

  try {
    const { response, payload } = await cpFetchJsonSafe(path);
    const rows = response.ok ? extractTelemetryItems(payload).map(normalizeMarketTelemetryRow) : [];
    const missingFields = detectMarketTelemetryMissingFields(rows);
    const rawRows = extractTelemetryItems(payload);
    const firstRow = rawRows[0] || null;
    return {
      rows,
      status: response.status,
      ok: response.ok,
      debug: {
        request: {
          url: requestUrl,
          tokenPreview,
          hasToken,
        },
        response: {
          status: response.status,
          ok: response.ok,
          latencyMs: Date.now() - startedAt,
        },
        payload: {
          rawSize: safeJsonSize(payload),
          hasVenues: rows.length > 0,
          venuesCount: rows.length,
          hasSpread: rows.some((row) => row.avgSpreadBps != null),
          hasLatency: rows.some((row) => row.avgDepthLatencyMs != null),
          topLevelKeys: safeObjectKeys(payload),
          firstRowKeys: safeObjectKeys(firstRow),
          firstRowNestedKeys: {
            market: safeObjectKeys(safeRecord(firstRow).market),
            execution: [],
            profile: [],
          },
        },
        parsing: {
          parsedOk: rows.length > 0,
          missingFields,
          fallbackUsed: !response.ok || missingFields.length > 0,
          firstRowNormalized: rows[0] || null,
        },
      },
    };
  } catch {
    return {
      rows: [],
      status: 0,
      ok: false,
      debug: {
        request: {
          url: requestUrl,
          tokenPreview,
          hasToken,
        },
        response: {
          status: 0,
          ok: false,
          latencyMs: Date.now() - startedAt,
        },
        payload: {
          rawSize: 0,
          hasVenues: false,
          venuesCount: 0,
          hasSpread: false,
          hasLatency: false,
          topLevelKeys: [],
          firstRowKeys: [],
          firstRowNestedKeys: {
            market: [],
            execution: [],
            profile: [],
          },
        },
        parsing: {
          parsedOk: false,
          missingFields: ["network"],
          fallbackUsed: true,
          firstRowNormalized: null,
        },
      },
    };
  }
}

async function readRouteTelemetryDebug(path: string, token: string): Promise<{
  rows: Array<ReturnType<typeof normalizeRouteTelemetryRow>>;
  status: number;
  ok: boolean;
  debug: RuntimeDecisionTelemetryDebug;
}> {
  const startedAt = Date.now();
  const requestUrl = `${getControlPlaneUrl()}${path}`;
  const tokenPreview = buildTokenPreview(token);
  const hasToken = Boolean(token);

  try {
    const { response, payload } = await cpFetchJsonSafe(path);
    const rows = response.ok ? extractTelemetryItems(payload).map(normalizeRouteTelemetryRow) : [];
    const missingFields = detectRouteTelemetryMissingFields(rows);
    const rawRows = extractTelemetryItems(payload);
    const firstRow = rawRows[0] || null;
    return {
      rows,
      status: response.status,
      ok: response.ok,
      debug: {
        request: {
          url: requestUrl,
          tokenPreview,
          hasToken,
        },
        response: {
          status: response.status,
          ok: response.ok,
          latencyMs: Date.now() - startedAt,
        },
        payload: {
          rawSize: safeJsonSize(payload),
          hasVenues: rows.length > 0,
          venuesCount: rows.length,
          hasSpread: false,
          hasLatency: rows.some((row) => row.avgRouteLatencyMs != null || row.avgFillLatencyMs != null),
          topLevelKeys: safeObjectKeys(payload),
          firstRowKeys: safeObjectKeys(firstRow),
          firstRowNestedKeys: {
            market: safeObjectKeys(safeRecord(firstRow).market),
            execution: safeObjectKeys(safeRecord(firstRow).execution),
            profile: safeObjectKeys(safeRecord(firstRow).profile),
          },
        },
        parsing: {
          parsedOk: rows.length > 0,
          missingFields,
          fallbackUsed: !response.ok || missingFields.length > 0,
          firstRowNormalized: rows[0] || null,
        },
      },
    };
  } catch {
    return {
      rows: [],
      status: 0,
      ok: false,
      debug: {
        request: {
          url: requestUrl,
          tokenPreview,
          hasToken,
        },
        response: {
          status: 0,
          ok: false,
          latencyMs: Date.now() - startedAt,
        },
        payload: {
          rawSize: 0,
          hasVenues: false,
          venuesCount: 0,
          hasSpread: false,
          hasLatency: false,
          topLevelKeys: [],
          firstRowKeys: [],
          firstRowNestedKeys: {
            market: [],
            execution: [],
            profile: [],
          },
        },
        parsing: {
          parsedOk: false,
          missingFields: ["network"],
          fallbackUsed: true,
          firstRowNormalized: null,
        },
      },
    };
  }
}

async function readOpportunityTelemetry(): Promise<RuntimeDecisionOpportunityTelemetry> {
  const token = await getControlPlaneToken();
  const [marketResult, routeResult] = await Promise.all([
    readMarketTelemetryDebug("/v1/market/venues/telemetry", token),
    readRouteTelemetryDebug("/v1/routes/venues/telemetry?lookback_minutes=240", token),
  ]);

  const marketRows = marketResult.rows;
  const routeRows = routeResult.rows;
  const venueCount = new Set([...marketRows.map((row) => row.venue), ...routeRows.map((row) => row.venue)]).size;
  const avgSpreadBps = averageNullableNumbers(marketRows.map((row) => row.avgSpreadBps));
  const avgAvailableDepthUsd = averageNullableNumbers(marketRows.map((row) => row.avgAvailableDepthUsd));
  const avgDepthLatencyMs = averageNullableNumbers(marketRows.map((row) => row.avgDepthLatencyMs));
  const avgFillProbability = averageNullableNumbers(marketRows.map((row) => row.avgFillProbability));
  const avgStabilityScore = averageNullableNumbers(marketRows.map((row) => row.avgStabilityScore));
  const avgRouteLatencyMs = averageNullableNumbers(routeRows.map((row) => row.avgRouteLatencyMs));
  const avgFillLatencyMs = averageNullableNumbers(routeRows.map((row) => row.avgFillLatencyMs));
  const avgSlippageBps = averageNullableNumbers(routeRows.map((row) => row.avgSlippageBps));
  const spreadBudgetBps = averageNullableNumbers(routeRows.map((row) => row.spreadBudgetBps));
  const latencyBudgetMs = averageNullableNumbers(routeRows.map((row) => row.latencyBudgetMs));
  const hasSpread = avgSpreadBps != null;
  const hasDepth = avgAvailableDepthUsd != null || avgFillProbability != null || avgStabilityScore != null || avgDepthLatencyMs != null;
  const hasRouteExecution = routeRows.some((row) => row.hasExecutionStats);
  const hasRouteLatency = avgRouteLatencyMs != null || avgFillLatencyMs != null;
  const hasRouteSlippage = avgSlippageBps != null;
  const hasRouteBudget = spreadBudgetBps != null || latencyBudgetMs != null;
  const hasRouteProfileShape = routeRows.some((row) => row.profileShape !== "none");
  const availability: RuntimeDecisionOpportunityTelemetry["availability"] = marketRows.length > 0 && routeRows.length > 0 && hasSpread && hasDepth && hasRouteExecution && hasRouteLatency
    ? "ready"
    : marketRows.length > 0 || routeRows.length > 0
      ? "partial"
      : "unavailable";
  const authState = classifyTelemetryAuthState(token, [marketResult.status, routeResult.status]);
  const missingFields = uniqueStrings([
    ...marketResult.debug.parsing.missingFields,
    ...routeResult.debug.parsing.missingFields,
    ...(hasDepth ? [] : ["depth"]),
  ]);
  const provisionalTelemetry = {
    availability,
    avgDepthLatencyMs,
  } as Pick<RuntimeDecisionOpportunityTelemetry, "availability" | "avgDepthLatencyMs">;
  const isStale = isOpportunityTelemetryStale(provisionalTelemetry);

  let rootCause: RuntimeDecisionTelemetryRootCause = "LIVE";
  let summary = `venues ${venueCount} · spread ${avgSpreadBps?.toFixed(2) ?? "n/a"}bp · depth ${formatCompactUsd(avgAvailableDepthUsd)} · route ${avgRouteLatencyMs?.toFixed(0) ?? "n/a"}ms · fill ${(avgFillProbability != null ? `${(avgFillProbability * 100).toFixed(0)}%` : "n/a")}`;
  const routeExecutionMissingCount = routeRows.filter((row) => !row.hasExecutionStats).length;
  const routeBaselineProfileDetected = routeRows.some((row) => row.profileShape === "venue-latency-baseline");
  const integrity = buildTelemetryIntegrity({
    marketRows,
    routeRows,
    hasSpread,
    hasDepth,
    hasRouteExecution,
    hasRouteLatency,
    hasRouteSlippage,
    hasRouteBudget,
    hasRouteProfileShape,
    routeBaselineProfileDetected,
  });
  const partialReasons: string[] = [];

  if (!hasSpread) {
    partialReasons.push("spread market absent");
  }
  if (!hasDepth) {
    partialReasons.push("depth market absente");
  }
  if (routeRows.length === 0) {
    partialReasons.push("venues route absentes");
  } else {
    if (!hasRouteExecution) {
      partialReasons.push(`stats execution route absentes sur ${routeExecutionMissingCount || routeRows.length} venue(s)`);
    }
    if (!hasRouteLatency) {
      partialReasons.push("latence route non observee");
    }
    if (!hasRouteSlippage) {
      partialReasons.push("slippage route absent");
    }
    if (!hasRouteBudget) {
      partialReasons.push(
        routeBaselineProfileDetected
          ? "profile route brut detecte (latency_base_ms) sans budgets max_*"
          : hasRouteProfileShape
            ? "profile route sans budgets max_*"
            : "profile route absent",
      );
    }
  }

  if (isTelemetryStatusUnauthorized(marketResult.status) || isTelemetryStatusUnauthorized(routeResult.status)) {
    rootCause = "AUTH_FAILURE";
    summary = `Telemetry auth failure: market ${marketResult.status || 0} · route ${routeResult.status || 0}.`;
  } else if ((marketResult.status === 0 || routeResult.status === 0) && venueCount === 0) {
    rootCause = "NETWORK_FAILURE";
    summary = "Control-plane telemetry unreachable: fallback lecture structurelle uniquement.";
  } else if (venueCount === 0) {
    rootCause = "EMPTY_PAYLOAD";
    summary = "Telemetry endpoints answered without venue rows: aucune venue exploitable dans la payload.";
  } else if (partialReasons.length > 0) {
    rootCause = "PARTIAL_PAYLOAD";
    summary = `Telemetry partielle: ${partialReasons.slice(0, 4).join(" · ")}.`;
  } else if (isStale) {
    rootCause = "STALE_TELEMETRY";
    summary = `Telemetry stale: freshness ${avgDepthLatencyMs?.toFixed(0) ?? "n/a"}ms vs budget ${DEFAULT_DEPTH_LATENCY_BUDGET_MS}ms.`;
  }

  return {
    source: availability === "unavailable" ? "context-only" : "venue-telemetry",
    availability,
    venueCount,
    marketVenueCount: marketRows.length,
    routeVenueCount: routeRows.length,
    avgSpreadBps,
    avgAvailableDepthUsd,
    avgDepthLatencyMs,
    avgFillProbability,
    avgStabilityScore,
    avgRouteLatencyMs,
    avgFillLatencyMs,
    avgSlippageBps,
    spreadBudgetBps,
    latencyBudgetMs,
    summary,
    authState,
    rootCause,
    missingFields,
    integrity,
    isStale,
    debug: {
      market: marketResult.debug,
      route: routeResult.debug,
    },
  };
}

function evaluateOpportunityLiveState(input: {
  telemetry: RuntimeDecisionOpportunityTelemetry;
  candidateCount: number;
  avgOpportunityScore: number;
  confidencePct: number;
}): {
  state: RuntimeDecisionOpportunityLiveState;
  summary: string;
} {
  const telemetry = input.telemetry;

  switch (telemetry.rootCause) {
    case "AUTH_FAILURE":
      return {
        state: "NO_DATA_AUTH",
        summary: `NO_DATA_AUTH · ${telemetry.summary}`,
      };
    case "EMPTY_PAYLOAD":
      return {
        state: "NO_DATA_EMPTY",
        summary: `NO_DATA_EMPTY · ${telemetry.summary}`,
      };
    case "PARTIAL_PAYLOAD":
    case "NETWORK_FAILURE":
      return {
        state: "NO_DATA_PARTIAL",
        summary: `NO_DATA_PARTIAL · ${telemetry.summary}`,
      };
    case "STALE_TELEMETRY":
      return {
        state: "STALE",
        summary: `STALE · ${telemetry.summary}`,
      };
    default:
      break;
  }

  if (input.candidateCount === 0 || input.avgOpportunityScore <= 0) {
    return {
      state: "NO_EDGE",
      summary: `NO_EDGE · score ${input.avgOpportunityScore}% · confidence ${input.confidencePct}% · aucun contexte structurellement tradable stable sur la fenetre chargee.`,
    };
  }

  return {
    state: "LIVE",
    summary: `LIVE · score ${input.avgOpportunityScore}% · confidence ${input.confidencePct}% · ${telemetry.summary}`,
  };
}

function buildOpportunityGuard(input: {
  telemetry: RuntimeDecisionOpportunityTelemetry;
  observation: Pick<RuntimeDecisionAnalyticsSummary["observation"], "status" | "integrity">;
  liveState: RuntimeDecisionOpportunityLiveState;
  reliability: RuntimeDecisionReliability;
}): RuntimeDecisionAnalyticsSummary["opportunity"]["guard"] {
  const reasons = [...input.reliability.reasons];
  const telemetryIntegrityState = input.telemetry.integrity?.state || "UNAVAILABLE";
  const telemetryPartial = Array.isArray(input.telemetry.missingFields) && input.telemetry.missingFields.length > 0;
  const observationDegraded = input.observation.integrity.status === "DEGRADED";
  const telemetryTrust = input.liveState === "LIVE"
    ? telemetryPartial || telemetryIntegrityState !== "OK"
      ? 0.55
      : 1
    : input.liveState === "NO_EDGE"
      ? 0.75
      : 0.25;
  const observationTrust = input.reliability.state === "BLOCKED_BY_DATA"
    ? 0.2
    : observationDegraded
      ? 0.72
      : input.observation.integrity.score;
  let trustScorePct = Number(((telemetryTrust * 0.6 + observationTrust * 0.4) * 100).toFixed(1));

  if (input.reliability.state === "BLOCKED_BY_DATA") {
    if (telemetryPartial && input.telemetry.missingFields) {
      reasons.push(`missing ${input.telemetry.missingFields.join(", ")}`);
    }
    if (telemetryIntegrityState !== "OK") {
      reasons.push(`telemetry integrity ${telemetryIntegrityState.toLowerCase()}`);
    }
    trustScorePct = Math.min(trustScorePct, 35);
    return {
      state: "BLOCKED_BY_DATA",
      blocked: true,
      trustScorePct,
      summary: reasons.length > 0
        ? `BLOCKED_BY_DATA · ${reasons.slice(0, 4).join(" · ")}`
        : `BLOCKED_BY_DATA · ${input.reliability.summary}`,
      reasons,
    };
  }

  if (telemetryPartial || ["NO_DATA_PARTIAL", "NO_DATA_AUTH", "NO_DATA_EMPTY", "STALE"].includes(input.liveState)) {
    if (telemetryPartial && input.telemetry.missingFields) {
      reasons.push(`missing ${input.telemetry.missingFields.join(", ")}`);
    }
    if (telemetryIntegrityState !== "OK") {
      reasons.push(`telemetry integrity ${telemetryIntegrityState.toLowerCase()}`);
    }
    if (input.liveState !== "LIVE") {
      reasons.push(`live gate ${input.liveState.toLowerCase()}`);
    }
    trustScorePct = Math.min(trustScorePct, 45);
    return {
      state: "PARTIAL_DATA",
      blocked: true,
      trustScorePct,
      summary: reasons.length > 0
        ? `PARTIAL_DATA · ${reasons.slice(0, 4).join(" · ")}`
        : "PARTIAL_DATA · live telemetry remains incomplete or unavailable.",
      reasons,
    };
  }

  if (input.reliability.state === "DEGRADED") {
    trustScorePct = Math.min(trustScorePct, 72);
    return {
      state: "UNTRUSTED",
      blocked: false,
      trustScorePct,
      summary: `UNTRUSTED · ${input.reliability.summary}`,
      reasons,
    };
  }

  return {
    state: "OK",
    blocked: false,
    trustScorePct,
    summary: observationDegraded
      ? `OK · observation still degraded but usable (${input.observation.integrity.summary})`
      : `OK · ${input.observation.integrity.summary}`,
    reasons,
  };
}

function classifyScoreState(score: number): RuntimeDecisionDriftState {
  if (score >= 0.7) {
    return "CRITICAL";
  }
  if (score >= 0.45) {
    return "DRIFT";
  }
  if (score >= 0.25) {
    return "WATCH";
  }
  return "CALM";
}

function stateFromWeight(weight: number): RuntimeDecisionDriftState {
  if (weight >= 3) {
    return "CRITICAL";
  }
  if (weight >= 2) {
    return "DRIFT";
  }
  if (weight >= 1) {
    return "WATCH";
  }
  return "CALM";
}

function classifyDriftType(
  metrics: Pick<RuntimeDecisionDriftWindowMetrics, "routingZeroRate" | "fallbackRate" | "runtimeBlockRate" | "policyBlockRate" | "falsePositiveRate" | "highVolatilityRate">,
  telemetry: RuntimeDecisionOpportunityTelemetry,
  dominantMetric: RuntimeDecisionDriftMetricKey | "none",
): RuntimeDecisionDriftType {
  const spreadBudgetBps = telemetry.spreadBudgetBps ?? DEFAULT_SPREAD_BUDGET_BPS;
  const routeBudgetMs = telemetry.latencyBudgetMs ?? DEFAULT_ROUTE_LATENCY_BUDGET_MS;
  const spreadElevated = (telemetry.avgSpreadBps ?? 0) > spreadBudgetBps;
  const routeElevated = (telemetry.avgRouteLatencyMs ?? 0) > routeBudgetMs;
  const fillElevated = (telemetry.avgFillLatencyMs ?? 0) > Math.max(routeBudgetMs, DEFAULT_FILL_LATENCY_BUDGET_MS);
  const depthElevated = (telemetry.avgDepthLatencyMs ?? 0) > DEFAULT_DEPTH_LATENCY_BUDGET_MS;
  const depthThin = (telemetry.avgAvailableDepthUsd ?? DEFAULT_AVAILABLE_DEPTH_REFERENCE_USD) < DEFAULT_AVAILABLE_DEPTH_REFERENCE_USD * 0.65;
  const fillWeak = (telemetry.avgFillProbability ?? 0.82) < 0.75;
  const stabilityWeak = (telemetry.avgStabilityScore ?? 0.82) < 0.75;

  const signals: RuntimeDecisionDriftType[] = [];
  const marketSignal = (spreadElevated && (depthElevated || depthThin || fillWeak || stabilityWeak))
    || ((dominantMetric === "routingZeroRate" || metrics.routingZeroRate >= 45) && spreadElevated)
    ? "MARKET_MICROSTRUCTURE"
    : metrics.highVolatilityRate >= 45 && (spreadElevated || dominantMetric === "routingZeroRate")
      ? "MARKET_REGIME"
      : null;
  const executionSignal = (routeElevated || fillElevated || depthElevated) && (dominantMetric === "fallbackRate" || metrics.fallbackRate >= 18)
    ? "EXECUTION_LATENCY"
    : (dominantMetric === "routingZeroRate" || metrics.routingZeroRate >= 25 || metrics.fallbackRate >= 25)
      ? "EXECUTION_ROUTING"
      : null;
  const systemSignal = (
    metrics.runtimeBlockRate >= 20
    || metrics.policyBlockRate >= 12
    || metrics.falsePositiveRate >= 10
    || dominantMetric === "runtimeBlockRate"
    || dominantMetric === "policyBlockRate"
    || dominantMetric === "falsePositiveRate"
    || (telemetry.availability === "unavailable" && metrics.fallbackRate >= 20)
  )
    ? "SYSTEM_HEALTH"
    : null;

  if (marketSignal) {
    signals.push(marketSignal);
  }
  if (executionSignal) {
    signals.push(executionSignal);
  }
  if (systemSignal) {
    signals.push(systemSignal);
  }

  const uniqueSignals = Array.from(new Set(signals));
  if (uniqueSignals.length === 0) {
    if (dominantMetric === "routingZeroRate") {
      return spreadElevated ? "MARKET_MICROSTRUCTURE" : "EXECUTION_ROUTING";
    }
    if (dominantMetric === "fallbackRate") {
      return routeElevated || fillElevated ? "EXECUTION_LATENCY" : "EXECUTION_ROUTING";
    }
    if (dominantMetric === "runtimeBlockRate" || dominantMetric === "policyBlockRate" || dominantMetric === "falsePositiveRate") {
      return "SYSTEM_HEALTH";
    }
    return "UNKNOWN";
  }
  return uniqueSignals.length > 1 ? "MIXED" : uniqueSignals[0];
}

function buildDriftCause(
  type: RuntimeDecisionDriftType,
  current: RuntimeDecisionDriftWindowMetrics,
  baseline: RuntimeDecisionDriftWindowMetrics,
  telemetry: RuntimeDecisionOpportunityTelemetry,
): RuntimeDecisionDriftCause {
  const spreadBudgetBps = telemetry.spreadBudgetBps ?? DEFAULT_SPREAD_BUDGET_BPS;
  const routeBudgetMs = telemetry.latencyBudgetMs ?? DEFAULT_ROUTE_LATENCY_BUDGET_MS;
  const fillBudgetMs = Math.max(routeBudgetMs, DEFAULT_FILL_LATENCY_BUDGET_MS);
  const depthBudgetMs = DEFAULT_DEPTH_LATENCY_BUDGET_MS;

  const factors: RuntimeDecisionDriftCauseFactor[] = [
    {
      key: "spread",
      label: "Spread",
      current: telemetry.avgSpreadBps,
      reference: spreadBudgetBps,
      deltaPct: deltaPct(telemetry.avgSpreadBps, spreadBudgetBps),
      tone: toneFromDelta(deltaPct(telemetry.avgSpreadBps, spreadBudgetBps), 5),
      note: telemetry.avgSpreadBps == null ? "spread n/a" : `spread ${telemetry.avgSpreadBps.toFixed(2)}bp vs budget ${spreadBudgetBps.toFixed(2)}bp`,
    },
    {
      key: "routeLatency",
      label: "Route latency",
      current: telemetry.avgRouteLatencyMs,
      reference: routeBudgetMs,
      deltaPct: deltaPct(telemetry.avgRouteLatencyMs, routeBudgetMs),
      tone: toneFromDelta(deltaPct(telemetry.avgRouteLatencyMs, routeBudgetMs), 10),
      note: telemetry.avgRouteLatencyMs == null ? "route latency n/a" : `route ${telemetry.avgRouteLatencyMs.toFixed(0)}ms vs budget ${routeBudgetMs.toFixed(0)}ms`,
    },
    {
      key: "fillLatency",
      label: "Fill latency",
      current: telemetry.avgFillLatencyMs,
      reference: fillBudgetMs,
      deltaPct: deltaPct(telemetry.avgFillLatencyMs, fillBudgetMs),
      tone: toneFromDelta(deltaPct(telemetry.avgFillLatencyMs, fillBudgetMs), 10),
      note: telemetry.avgFillLatencyMs == null ? "fill latency n/a" : `fill ${telemetry.avgFillLatencyMs.toFixed(0)}ms vs budget ${fillBudgetMs.toFixed(0)}ms`,
    },
    {
      key: "depthLatency",
      label: "Depth latency",
      current: telemetry.avgDepthLatencyMs,
      reference: depthBudgetMs,
      deltaPct: deltaPct(telemetry.avgDepthLatencyMs, depthBudgetMs),
      tone: toneFromDelta(deltaPct(telemetry.avgDepthLatencyMs, depthBudgetMs), 10),
      note: telemetry.avgDepthLatencyMs == null ? "depth latency n/a" : `depth ${telemetry.avgDepthLatencyMs.toFixed(0)}ms vs budget ${depthBudgetMs.toFixed(0)}ms`,
    },
    {
      key: "highVolatilityRate",
      label: "High-vol regime",
      current: current.highVolatilityRate,
      reference: baseline.highVolatilityRate,
      deltaPct: deltaPct(current.highVolatilityRate, baseline.highVolatilityRate),
      tone: toneFromDelta(deltaPct(current.highVolatilityRate, baseline.highVolatilityRate), 10),
      note: `high-vol ${current.highVolatilityRate}% vs 24h ${baseline.highVolatilityRate}%`,
    },
    {
      key: "routingZeroRate",
      label: "Routing zero",
      current: current.routingZeroRate,
      reference: baseline.routingZeroRate,
      deltaPct: deltaPct(current.routingZeroRate, baseline.routingZeroRate),
      tone: toneFromDelta(deltaPct(current.routingZeroRate, baseline.routingZeroRate), 10),
      note: `routing zero ${current.routingZeroRate}% vs 24h ${baseline.routingZeroRate}%`,
    },
    {
      key: "fallbackRate",
      label: "Fallback",
      current: current.fallbackRate,
      reference: baseline.fallbackRate,
      deltaPct: deltaPct(current.fallbackRate, baseline.fallbackRate),
      tone: toneFromDelta(deltaPct(current.fallbackRate, baseline.fallbackRate), 10),
      note: `fallback ${current.fallbackRate}% vs 24h ${baseline.fallbackRate}%`,
    },
    {
      key: "runtimeBlockRate",
      label: "Runtime block",
      current: current.runtimeBlockRate,
      reference: baseline.runtimeBlockRate,
      deltaPct: deltaPct(current.runtimeBlockRate, baseline.runtimeBlockRate),
      tone: toneFromDelta(deltaPct(current.runtimeBlockRate, baseline.runtimeBlockRate), 10),
      note: `runtime block ${current.runtimeBlockRate}% vs 24h ${baseline.runtimeBlockRate}%`,
    },
    {
      key: "policyBlockRate",
      label: "Policy block",
      current: current.policyBlockRate,
      reference: baseline.policyBlockRate,
      deltaPct: deltaPct(current.policyBlockRate, baseline.policyBlockRate),
      tone: toneFromDelta(deltaPct(current.policyBlockRate, baseline.policyBlockRate), 10),
      note: `policy block ${current.policyBlockRate}% vs 24h ${baseline.policyBlockRate}%`,
    },
    {
      key: "falsePositiveRate",
      label: "False positive",
      current: current.falsePositiveRate,
      reference: baseline.falsePositiveRate,
      deltaPct: deltaPct(current.falsePositiveRate, baseline.falsePositiveRate),
      tone: toneFromDelta(deltaPct(current.falsePositiveRate, baseline.falsePositiveRate), 10),
      note: `false positive ${current.falsePositiveRate}% vs 24h ${baseline.falsePositiveRate}%`,
    },
  ];

  const priorities: Record<RuntimeDecisionDriftType, RuntimeDecisionDriftCauseFactor["key"][]> = {
    MARKET_MICROSTRUCTURE: ["spread", "depthLatency", "routingZeroRate", "highVolatilityRate", "routeLatency", "fallbackRate", "fillLatency", "runtimeBlockRate", "policyBlockRate", "falsePositiveRate"],
    MARKET_REGIME: ["highVolatilityRate", "spread", "routingZeroRate", "depthLatency", "fallbackRate", "routeLatency", "fillLatency", "runtimeBlockRate", "policyBlockRate", "falsePositiveRate"],
    EXECUTION_LATENCY: ["routeLatency", "fillLatency", "depthLatency", "fallbackRate", "spread", "routingZeroRate", "runtimeBlockRate", "policyBlockRate", "falsePositiveRate", "highVolatilityRate"],
    EXECUTION_ROUTING: ["routingZeroRate", "fallbackRate", "routeLatency", "depthLatency", "spread", "fillLatency", "runtimeBlockRate", "policyBlockRate", "falsePositiveRate", "highVolatilityRate"],
    SYSTEM_HEALTH: ["runtimeBlockRate", "policyBlockRate", "falsePositiveRate", "fallbackRate", "routeLatency", "spread", "depthLatency", "routingZeroRate", "fillLatency", "highVolatilityRate"],
    MIXED: ["spread", "highVolatilityRate", "routeLatency", "runtimeBlockRate", "routingZeroRate", "fallbackRate", "policyBlockRate", "falsePositiveRate", "depthLatency", "fillLatency"],
    UNKNOWN: ["routingZeroRate", "fallbackRate", "runtimeBlockRate", "policyBlockRate", "falsePositiveRate", "spread", "highVolatilityRate", "routeLatency", "depthLatency", "fillLatency"],
  };
  const order = priorities[type] || priorities.UNKNOWN;
  const ranked = factors.slice().sort((left, right) => order.indexOf(left.key) - order.indexOf(right.key));
  const highlighted = ranked.filter((factor) => factor.tone !== "good").slice(0, 3);

  return {
    summary: highlighted.length > 0
      ? highlighted.map((factor) => factor.note).join(" · ")
      : ranked.slice(0, 2).map((factor) => factor.note).join(" · "),
    factors: ranked,
  };
}

function opportunityRegimeScore(value: string): number {
  switch (value.trim().toLowerCase()) {
    case "low":
      return 0.58;
    case "medium":
    case "normal":
      return 0.82;
    case "high":
      return 0.7;
    case "extreme":
      return 0.38;
    default:
      return 0.5;
  }
}

function buildOpportunityBreakdown(
  row: Pick<DerivedExecutionRow, "context">,
  telemetry: RuntimeDecisionOpportunityTelemetry,
): RuntimeDecisionOpportunityBreakdownItem[] {
  const spreadBudgetBps = telemetry.spreadBudgetBps ?? DEFAULT_SPREAD_BUDGET_BPS;
  const latencyBudgetMs = telemetry.latencyBudgetMs ?? DEFAULT_ROUTE_LATENCY_BUDGET_MS;
  const fillBudgetMs = Math.max(latencyBudgetMs, DEFAULT_FILL_LATENCY_BUDGET_MS);
  const spreadAvailable = telemetry.avgSpreadBps != null;
  const spreadQuality = spreadAvailable ? clamp01(1 - telemetry.avgSpreadBps / Math.max(spreadBudgetBps, 1)) : 0;
  const depthReferenceMs = row.context.depthAgeMs ?? telemetry.avgDepthLatencyMs ?? null;
  const depthParts = [
    {
      weight: 0.45,
      value: depthReferenceMs != null ? clamp01(1 - depthReferenceMs / DEFAULT_DEPTH_LATENCY_BUDGET_MS) : null,
    },
    {
      weight: 0.2,
      value: telemetry.avgAvailableDepthUsd != null ? clamp01(telemetry.avgAvailableDepthUsd / DEFAULT_AVAILABLE_DEPTH_REFERENCE_USD) : null,
    },
    {
      weight: 0.2,
      value: telemetry.avgFillProbability != null ? clamp01(telemetry.avgFillProbability) : null,
    },
    {
      weight: 0.15,
      value: telemetry.avgStabilityScore != null ? clamp01(telemetry.avgStabilityScore) : null,
    },
  ];
  const depthAvailableWeight = depthParts.reduce((sum, part) => sum + (part.value != null ? part.weight : 0), 0);
  const depthAvailable = depthAvailableWeight > 0;
  const depthQuality = depthAvailable
    ? Number((depthParts.reduce((sum, part) => sum + (part.value != null ? part.value * part.weight : 0), 0) / depthAvailableWeight).toFixed(4))
    : 0;
  const latencyCandidates = [telemetry.avgRouteLatencyMs, telemetry.avgFillLatencyMs].filter((value): value is number => value != null);
  const latencyReferenceMs = latencyCandidates.length > 0 ? Math.max(...latencyCandidates) : null;
  const latencyAvailable = latencyReferenceMs != null;
  const latencyQuality = latencyAvailable ? clamp01(1 - latencyReferenceMs / fillBudgetMs) : 0;
  const regimeAvailable = Boolean(String(row.context.volatilityRegime || "").trim());
  const regimeQuality = regimeAvailable ? opportunityRegimeScore(row.context.volatilityRegime) : 0;

  return [
    {
      key: "spread",
      label: "Spread",
      score: spreadQuality,
      scorePct: Number((spreadQuality * 100).toFixed(1)),
      tone: spreadAvailable ? toneFromScore(spreadQuality) : "warn",
      detail: telemetry.avgSpreadBps == null
        ? "spread missing"
        : `${telemetry.avgSpreadBps.toFixed(2)}bp vs budget ${spreadBudgetBps.toFixed(2)}bp`,
      available: spreadAvailable,
    },
    {
      key: "depth",
      label: "Depth",
      score: depthQuality,
      scorePct: Number((depthQuality * 100).toFixed(1)),
      tone: depthAvailable ? toneFromScore(depthQuality) : "warn",
      detail: depthAvailable
        ? `fresh ${Math.round(depthReferenceMs ?? 0)}ms · ${formatCompactUsd(telemetry.avgAvailableDepthUsd)} · fill ${telemetry.avgFillProbability != null ? `${(telemetry.avgFillProbability * 100).toFixed(0)}%` : "n/a"}`
        : "depth missing",
      available: depthAvailable,
    },
    {
      key: "latency",
      label: "Latency",
      score: latencyQuality,
      scorePct: Number((latencyQuality * 100).toFixed(1)),
      tone: latencyAvailable ? toneFromScore(latencyQuality) : "warn",
      detail: latencyAvailable
        ? `route ${telemetry.avgRouteLatencyMs?.toFixed(0) ?? "n/a"}ms · fill ${telemetry.avgFillLatencyMs?.toFixed(0) ?? "n/a"}ms`
        : "latency missing",
      available: latencyAvailable,
    },
    {
      key: "regime",
      label: "Regime",
      score: regimeQuality,
      scorePct: Number((regimeQuality * 100).toFixed(1)),
      tone: regimeAvailable ? toneFromScore(regimeQuality) : "warn",
      detail: regimeAvailable ? `vol ${row.context.volatilityRegime || "unknown"}` : "regime missing",
      available: regimeAvailable,
    },
  ];
}

function computeOpportunityScore(
  row: Pick<DerivedExecutionRow, "context" | "isNoTrade" | "code" | "bucket" | "entry" | "oracleFingerprint">,
  telemetry: RuntimeDecisionOpportunityTelemetry,
): RuntimeDecisionOpportunityRankedItem {
  const breakdown = buildOpportunityBreakdown(row, telemetry);
  const weights: Record<RuntimeDecisionOpportunityBreakdownKey, number> = {
    spread: 0.4,
    depth: 0.3,
    latency: 0.2,
    regime: 0.1,
  };
  const availableBreakdown = breakdown.filter((item) => item.available !== false);
  const availableWeight = availableBreakdown.reduce((sum, item) => sum + weights[item.key], 0);
  const score = Number((availableWeight > 0
    ? availableBreakdown.reduce((sum, item) => sum + item.score * weights[item.key], 0) / availableWeight
    : 0).toFixed(4));
  const confidence = Number(availableWeight.toFixed(4));
  const missing = breakdown.filter((item) => item.available === false).map((item) => item.key);
  const constraints = availableBreakdown.filter((item) => item.score < 0.55).map((item) => item.label.toLowerCase());
  const strengths = availableBreakdown.filter((item) => item.score >= 0.72).map((item) => item.label.toLowerCase());
  const reasons: string[] = [];
  reasons.push(constraints.length > 0 ? `constraint ${constraints.slice(0, 2).join(" + ")}` : "no hard constraint");
  if (strengths.length > 0) {
    reasons.push(`support ${strengths.slice(0, 2).join(" + ")}`);
  }
  reasons.push(missing.length > 0 ? `missing ${missing.slice(0, 2).join(" + ")}` : "full telemetry");
  reasons.push(`vol ${row.context.volatilityRegime || "unknown"}`);

  return {
    createdAtIso: row.entry.createdAtIso,
    code: row.code,
    oracleFingerprint: row.oracleFingerprint,
    bucket: row.bucket,
    score,
    scorePct: Number((score * 100).toFixed(1)),
    attentionState: row.context.attentionState,
    volatilityRegime: row.context.volatilityRegime,
    status: row.isNoTrade ? "BLOCKED" : "EXECUTED",
    breakdown,
    rationale: reasons.join(" · "),
    confidence,
    confidencePct: Number((confidence * 100).toFixed(1)),
    missing,
  };
}

function aggregateOpportunityBreakdown(items: RuntimeDecisionOpportunityRankedItem[]): RuntimeDecisionOpportunityBreakdownItem[] {
  const keys: RuntimeDecisionOpportunityBreakdownKey[] = ["spread", "depth", "latency", "regime"];
  const labels: Record<RuntimeDecisionOpportunityBreakdownKey, string> = {
    spread: "Spread",
    depth: "Depth",
    latency: "Latency",
    regime: "Regime",
  };

  return keys.map((key) => {
    const parts = items
      .map((item) => item.breakdown.find((part) => part.key === key) || null)
      .filter((value): value is RuntimeDecisionOpportunityBreakdownItem => Boolean(value));
    const scores = parts
      .filter((part) => part.available !== false)
      .map((part) => part.score);
    const score = scores.length > 0 ? Number(averageNumbers(scores).toFixed(4)) : 0;
    const missingCount = parts.filter((part) => part.available === false).length;
    const detail = missingCount === parts.length
      ? `${labels[key]} missing across live telemetry.`
      : score >= 0.72
        ? `${labels[key]} supports execution.`
        : score >= 0.48
          ? `${labels[key]} is manageable but not clean.`
          : `${labels[key]} is the current binding constraint.`;
    return {
      key,
      label: labels[key],
      score,
      scorePct: Number((score * 100).toFixed(1)),
      tone: missingCount === parts.length ? "warn" : toneFromScore(score),
      detail,
      available: missingCount < parts.length,
    };
  });
}

function deriveRows(entries: V2RiskJournalEntry[]): DerivedExecutionRow[] {
  return entries
    .filter(isExecutionRow)
    .map((entry) => {
      const timestampMs = parseTimestamp(entry.createdAtIso);
      const meta = safeRecord(entry.meta);
      const audit = validateExecutionDecisionAudit(meta.decision_audit);
      const finalDecisionTruth = extractFinalDecisionTruth(entry);
      const code = deriveCanonicalCode(entry);
      const classification = classifyCode(code);
      const context = extractContext(entry);
      const isNoTrade = isNoTradeAction(entry);
      const semanticMismatch = isNoTrade && detectSemanticMismatch(code, String(entry.detail || ""));
      const falsePositiveCandidate = isNoTrade
        && context.attentionState === "stable"
        && context.busSeq > 0
        && (context.depthAgeMs == null || context.depthAgeMs <= 2_000)
        && (classification.bucket === "policy" || classification.bucket === "runtime");
      return {
        entry,
        timestampMs,
        code,
        oracleFingerprint: extractOracleFingerprint(audit, finalDecisionTruth),
        family: classification.family,
        bucket: classification.bucket,
        context,
        hasCanonicalAudit: Boolean(audit) || Object.keys(finalDecisionTruth).length > 0,
        isNoTrade,
        semanticMismatch,
        falsePositiveCandidate,
        opportunityCandidate: isOpportunityCandidate(context),
      };
    })
    .filter((row) => row.timestampMs > 0)
    .sort((left, right) => left.timestampMs - right.timestampMs);
}

function summarizeRows(rows: DerivedExecutionRow[], sampleLimit: number) {
  const byCode = new Map<string, number>();
  const byFamily = new Map<string, number>();
  const byBucket = new Map<string, number>();
  const byAttentionState = new Map<string, number>();
  const byVolatilityRegime = new Map<string, number>();
  const byTripleValidationState = new Map<string, number>();
  const blockedOpportunityByBucket = new Map<string, number>();

  let noTradeRows = 0;
  let canonicalRows = 0;
  let normalizedLegacyRows = 0;
  let unclassifiedLegacyRows = 0;
  let candidateCount = 0;
  let blockedCount = 0;
  let executedCount = 0;

  const semanticMismatchCandidates: RuntimeDecisionAnalyticsSample[] = [];
  const falsePositiveCandidates: RuntimeDecisionAnalyticsSample[] = [];

  for (const row of rows) {
    if (row.opportunityCandidate) {
      candidateCount += 1;
      if (row.isNoTrade) {
        blockedCount += 1;
        blockedOpportunityByBucket.set(row.bucket, (blockedOpportunityByBucket.get(row.bucket) || 0) + 1);
      } else {
        executedCount += 1;
      }
    }

    if (!row.isNoTrade) {
      continue;
    }

    noTradeRows += 1;
    if (row.hasCanonicalAudit) {
      canonicalRows += 1;
    } else if (row.code === "legacy-unclassified") {
      unclassifiedLegacyRows += 1;
    } else {
      normalizedLegacyRows += 1;
    }

    byCode.set(row.code, (byCode.get(row.code) || 0) + 1);
    byFamily.set(row.family, (byFamily.get(row.family) || 0) + 1);
    byBucket.set(row.bucket, (byBucket.get(row.bucket) || 0) + 1);
    byAttentionState.set(row.context.attentionState, (byAttentionState.get(row.context.attentionState) || 0) + 1);
    byVolatilityRegime.set(row.context.volatilityRegime, (byVolatilityRegime.get(row.context.volatilityRegime) || 0) + 1);
    byTripleValidationState.set(row.context.tripleValidationState, (byTripleValidationState.get(row.context.tripleValidationState) || 0) + 1);

    if (row.semanticMismatch) {
      semanticMismatchCandidates.push(buildSample(row));
    }
    if (row.falsePositiveCandidate) {
      falsePositiveCandidates.push(buildSample(row));
    }
  }

  const falsePositiveSemanticOverlapCount = rows.filter((row) => row.falsePositiveCandidate && row.semanticMismatch).length;

  const topCodes = sortedEntries(byCode).map(([code, count]) => {
    const classification = classifyCode(code);
    return {
      code,
      family: classification.family,
      bucket: classification.bucket,
      count,
      sharePct: percent(count, noTradeRows),
    };
  });
  const byBucketRows = sortedEntries(byBucket).map(([bucket, count]) => ({ bucket: bucket as RuntimeDecisionBucket, count, sharePct: percent(count, noTradeRows) }));
  const byFamilyRows = sortedEntries(byFamily).map(([family, count]) => ({ family: family as RuntimeDecisionFamily, count, sharePct: percent(count, noTradeRows) }));
  const attentionRows = toLabelRows(sortedEntries(byAttentionState), noTradeRows);
  const volatilityRows = toLabelRows(sortedEntries(byVolatilityRegime), noTradeRows);
  const tripleValidationRows = toLabelRows(sortedEntries(byTripleValidationState), noTradeRows);
  const blockedByBucketRows = sortedEntries(blockedOpportunityByBucket).map(([bucket, count]) => ({ bucket: bucket as RuntimeDecisionBucket, count, sharePct: percent(count, blockedCount) }));

  return {
    executionRows: rows.length,
    noTradeRows,
    canonicalRows,
    normalizedLegacyRows,
    unclassifiedLegacyRows,
    topCodes,
    byBucketRows,
    byFamilyRows,
    attentionRows,
    volatilityRows,
    tripleValidationRows,
    semanticMismatchCandidates: semanticMismatchCandidates.slice(0, sampleLimit),
    semanticMismatchCount: semanticMismatchCandidates.length,
    falsePositiveCandidates: falsePositiveCandidates.slice(0, sampleLimit),
    falsePositiveCount: falsePositiveCandidates.length,
    falsePositiveSemanticOverlapCount,
    candidateCount,
    blockedCount,
    executedCount,
    blockedByBucketRows,
  };
}

function buildDriftWindowMetrics(label: RuntimeDecisionDriftWindowKey, hours: number, rows: DerivedExecutionRow[]): RuntimeDecisionDriftWindowMetrics {
  const noTradeRows = rows.filter((row) => row.isNoTrade).length;
  const highVolatilityCount = rows.filter((row) => isHighVolatilityRegime(row.context.volatilityRegime)).length;
  const routingZeroCount = rows.filter((row) => row.isNoTrade && row.code === "routing-score-zero").length;
  const fallbackCount = rows.filter((row) => row.isNoTrade && row.code === "fallback-mode").length;
  const runtimeCount = rows.filter((row) => row.isNoTrade && row.bucket === "runtime").length;
  const policyCount = rows.filter((row) => row.isNoTrade && row.bucket === "policy").length;
  const falsePositiveCount = rows.filter((row) => row.falsePositiveCandidate).length;
  const routingZeroRate = toDriftRate(routingZeroCount, noTradeRows);
  const fallbackRate = toDriftRate(fallbackCount, noTradeRows);
  const runtimeBlockRate = toDriftRate(runtimeCount, noTradeRows);
  const policyBlockRate = toDriftRate(policyCount, noTradeRows);
  const falsePositiveRate = toDriftRate(falsePositiveCount, noTradeRows);
  const driftScore = computeGlobalDriftScore({ routingZeroRate, fallbackRate, runtimeBlockRate, policyBlockRate });
  return {
    label,
    hours,
    executionRows: rows.length,
    noTradeRows,
    highVolatilityRate: percent(highVolatilityCount, rows.length),
    routingZeroRate,
    fallbackRate,
    runtimeBlockRate,
    policyBlockRate,
    falsePositiveRate,
    driftScore,
    driftScorePct: Number((driftScore * 100).toFixed(1)),
    type: "UNKNOWN",
  };
}

function classifyDriftState(drift: number): RuntimeDecisionDriftState {
  if (drift >= DRIFT_CRITICAL_THRESHOLD) {
    return "CRITICAL";
  }
  if (drift >= DRIFT_WARNING_THRESHOLD) {
    return "DRIFT";
  }
  if (drift >= DRIFT_WATCH_THRESHOLD) {
    return "WATCH";
  }
  return "CALM";
}

function driftStateWeight(state: RuntimeDecisionDriftState): number {
  switch (state) {
    case "CRITICAL":
      return 3;
    case "DRIFT":
      return 2;
    case "WATCH":
      return 1;
    default:
      return 0;
  }
}

function strongestDriftSignal(current: RuntimeDecisionDriftWindowMetrics, baseline: RuntimeDecisionDriftWindowMetrics): DriftSignal {
  if (current.noTradeRows < MIN_CURRENT_NO_TRADE_ROWS || baseline.noTradeRows < MIN_BASELINE_NO_TRADE_ROWS) {
    return {
      metric: "none",
      currentRate: 0,
      baselineRate: 0,
      drift: 0,
      state: "CALM",
    };
  }

  const metricKeys: RuntimeDecisionDriftMetricKey[] = ["routingZeroRate", "fallbackRate", "runtimeBlockRate", "policyBlockRate", "falsePositiveRate"];
  let strongest: DriftSignal = {
    metric: "none",
    currentRate: 0,
    baselineRate: 0,
    drift: 0,
    state: "CALM",
  };

  for (const metric of metricKeys) {
    const drift = Math.max(0, computeDrift(current[metric], baseline[metric]));
    if (drift > strongest.drift) {
      strongest = {
        metric,
        currentRate: current[metric],
        baselineRate: baseline[metric],
        drift,
        state: classifyDriftState(drift),
      };
    }
  }

  return strongest;
}

function buildDrift(rows: DerivedExecutionRow[], nowMs: number, telemetry: RuntimeDecisionOpportunityTelemetry) {
  const windows = Object.fromEntries(DRIFT_WINDOWS.map((windowConfig) => {
    const threshold = nowMs - windowConfig.hours * 60 * 60 * 1000;
    const windowRows = rows.filter((row) => row.timestampMs >= threshold);
    return [windowConfig.label, buildDriftWindowMetrics(windowConfig.label, windowConfig.hours, windowRows)];
  })) as Record<RuntimeDecisionDriftWindowKey, RuntimeDecisionDriftWindowMetrics>;

  const alerts: RuntimeDecisionDriftAlert[] = [];
  const baseline = windows["24h"];
  const metricKeys: RuntimeDecisionDriftMetricKey[] = ["routingZeroRate", "fallbackRate", "runtimeBlockRate", "policyBlockRate", "falsePositiveRate"];

  for (const windowKey of DRIFT_WINDOWS.map((windowConfig) => windowConfig.label)) {
    const windowMetrics = windows[windowKey];
    const dominantSignal = strongestDriftSignal(windowMetrics, baseline);
    windows[windowKey] = {
      ...windowMetrics,
      type: classifyDriftType(windowMetrics, telemetry, dominantSignal.metric),
    };
  }

  for (const currentWindow of DRIFT_CURRENT_WINDOWS) {
    const current = windows[currentWindow];
    if (current.noTradeRows < MIN_CURRENT_NO_TRADE_ROWS || baseline.noTradeRows < MIN_BASELINE_NO_TRADE_ROWS) {
      continue;
    }
    for (const metric of metricKeys) {
      const drift = computeDrift(current[metric], baseline[metric]);
      if (drift <= DRIFT_WARNING_THRESHOLD) {
        continue;
      }
      alerts.push({
        metric,
        currentWindow,
        baselineWindow: "24h",
        currentRate: current[metric],
        baselineRate: baseline[metric],
        drift,
        type: classifyDriftType(current, telemetry, metric),
        score: current.driftScore,
        scorePct: current.driftScorePct,
        severity: drift > DRIFT_CRITICAL_THRESHOLD ? "critical" : "warning",
      });
    }
  }

  alerts.sort((left, right) => right.drift - left.drift);

  const strongestActiveSignal = DRIFT_CURRENT_WINDOWS
    .map((windowKey) => strongestDriftSignal(windows[windowKey], baseline))
    .sort((left, right) => driftStateWeight(right.state) - driftStateWeight(left.state) || right.drift - left.drift)[0] || {
      metric: "none",
      currentRate: 0,
      baselineRate: 0,
      drift: 0,
      state: "CALM" as RuntimeDecisionDriftState,
    };

  const bucketMs = SERIES_BUCKET_HOURS * 60 * 60 * 1000;
  const alignedNow = Math.ceil(nowMs / bucketMs) * bucketMs;
  const historyPointCount = Math.max(1, Math.round(SERIES_WINDOW_HOURS / SERIES_BUCKET_HOURS));
  const history: RuntimeDecisionDriftHistoryEntry[] = [];
  const hourlyMetrics: Array<{ t: number; iso: string; metrics: RuntimeDecisionDriftWindowMetrics; signal: DriftSignal }> = [];
  for (let index = historyPointCount - 1; index >= 0; index -= 1) {
    const bucketEnd = alignedNow - index * bucketMs;
    const bucketStart = bucketEnd - bucketMs;
    const bucketRows = rows.filter((row) => row.timestampMs >= bucketStart && row.timestampMs < bucketEnd);
    const bucketMetricsBase = buildDriftWindowMetrics("1h", 1, bucketRows);
    const signal = strongestDriftSignal(bucketMetricsBase, baseline);
    const bucketMetrics = {
      ...bucketMetricsBase,
      type: classifyDriftType(bucketMetricsBase, telemetry, signal.metric),
    };
    hourlyMetrics.push({ t: Math.floor(bucketEnd / 1000), iso: new Date(bucketEnd).toISOString(), metrics: bucketMetrics, signal });
    history.push({
      t: Math.floor(bucketEnd / 1000),
      iso: new Date(bucketEnd).toISOString(),
      state: signal.state,
      type: bucketMetrics.type,
      metric: signal.metric,
      score: bucketMetrics.driftScore,
      scorePct: bucketMetrics.driftScorePct,
      currentRate: signal.currentRate,
      baselineRate: signal.baselineRate,
      drift: signal.drift,
      noTradeRows: bucketMetrics.noTradeRows,
    });
  }

  const shortHorizon = hourlyMetrics.slice(-6);
  const baselineHorizon = hourlyMetrics.slice(0, Math.max(0, hourlyMetrics.length - shortHorizon.length));
  const strongestWindow = DRIFT_CURRENT_WINDOWS
    .map((windowKey) => windows[windowKey])
    .sort((left, right) => right.driftScore - left.driftScore)[0] || windows["1h"];
  const strongestWindowSignal = strongestDriftSignal(strongestWindow, baseline);
  let ksMetric: RuntimeDecisionDriftMetricKey | "none" = "none";
  let ksScore = 0;
  for (const metric of metricKeys) {
    const currentSamples = shortHorizon.map((item) => item.metrics[metric]);
    const baselineSamples = baselineHorizon.map((item) => item.metrics[metric]);
    const candidate = ksTest(currentSamples, baselineSamples);
    if (candidate > ksScore) {
      ksScore = candidate;
      ksMetric = metric;
    }
  }
  const adwin = detectAdwinDrift(hourlyMetrics.map((item) => item.metrics.driftScore));
  const sampleSizeFactor = Number((clamp01(shortHorizon.length / 6) * 0.5 + clamp01(baselineHorizon.length / 18) * 0.5).toFixed(4));
  const adwinSignal = adwin.detected ? 1 : Number(clamp01(adwin.delta / 0.15).toFixed(4));
  const signalVariance = standardDeviation(shortHorizon.map((item) => item.metrics.driftScore));
  const windowTypeAgreement = windows["1h"].type === windows["6h"].type && windows["1h"].type !== "UNKNOWN"
    ? 1
    : windows["1h"].type === "UNKNOWN" || windows["6h"].type === "UNKNOWN"
      ? 0.55
      : 0.2;
  const metricAgreement = strongestActiveSignal.metric !== "none" && strongestActiveSignal.metric === strongestWindowSignal.metric
    ? 1
    : strongestActiveSignal.metric === "none" || strongestWindowSignal.metric === "none"
      ? 0.55
      : 0.25;
  const scoreDistance = Math.abs(windows["1h"].driftScore - windows["6h"].driftScore);
  const windowConsistency = Number(clamp01((1 - clamp01(scoreDistance / 0.35)) * 0.5 + windowTypeAgreement * 0.3 + metricAgreement * 0.2).toFixed(4));
  const driftSignalStrength = clamp01(Math.max(strongestWindow.driftScore, strongestActiveSignal.drift));
  const noiseLevel = Number(clamp01((signalVariance / 0.12) * 0.65 + clamp01(strongestWindow.falsePositiveRate / 18) * 0.35).toFixed(4));
  const probability = Number(clamp01(
    ksScore * 0.25
    + adwinSignal * 0.2
    + driftSignalStrength * 0.2
    + strongestWindow.driftScore * 0.15
    + windowConsistency * 0.12
    + sampleSizeFactor * 0.08
  ).toFixed(4));
  const reliability = Number(clamp01(windowConsistency * 0.42 + (1 - noiseLevel) * 0.33 + sampleSizeFactor * 0.25).toFixed(4));
  const confidence = Number(clamp01(probability * 0.68 + reliability * 0.32).toFixed(4));
  const confirmed = (probability >= 0.55 && reliability >= 0.45) || ksScore >= 0.3 || adwin.detected;
  const stats: RuntimeDecisionDriftStatistics = {
    confirmed,
    ksScore,
    ksMetric,
    adwinTriggered: adwin.detected,
    adwinDelta: adwin.delta,
    adwinSignal,
    currentSampleSize: shortHorizon.length,
    baselineSampleSize: baselineHorizon.length,
    sampleSizeFactor,
    probability,
    probabilityPct: Number((probability * 100).toFixed(1)),
    reliability,
    reliabilityPct: Number((reliability * 100).toFixed(1)),
    windowConsistency,
    windowConsistencyPct: Number((windowConsistency * 100).toFixed(1)),
    noiseLevel,
    noiseLevelPct: Number((noiseLevel * 100).toFixed(1)),
    signalVariance,
    confidence,
    confidencePct: Number((confidence * 100).toFixed(1)),
  };
  const heuristicWeight = driftStateWeight(strongestActiveSignal.state);
  const scoreWeight = driftStateWeight(classifyScoreState(Math.max(strongestWindow.driftScore, probability)));
  const statisticalWeight = driftStateWeight(classifyScoreState(confidence));
  let stateWeight = Math.max(heuristicWeight, stats.confirmed ? Math.max(scoreWeight, statisticalWeight) : Math.min(Math.max(scoreWeight, statisticalWeight), 1));
  if (reliability < 0.45 && stateWeight > 1) {
    stateWeight -= 1;
  }
  const state = !stats.confirmed && heuristicWeight >= 2
    ? "WATCH"
    : stateFromWeight(stateWeight);
  const type = classifyDriftType(strongestWindow, telemetry, strongestWindowSignal.metric);
  const score = strongestWindow.driftScore;
  const scorePct = strongestWindow.driftScorePct;
  const cause = buildDriftCause(type, strongestWindow, baseline, telemetry);
  const tone: RuntimeDecisionTone = state === "CALM" ? "good" : state === "WATCH" ? "subtle" : "warn";
  const driftLabel = driftTypeLabel(type);
  const headline = state === "CRITICAL"
    ? `${driftLabel} drift critical`
    : state === "DRIFT"
      ? `${driftLabel} drift confirmed`
      : state === "WATCH"
        ? `${driftLabel} drift watch`
        : "No material drift vs 24h baseline";
  const summary = state === "CALM"
    ? `Les fenetres 1h et 6h restent proches de la baseline 24h. Drift score ${scorePct.toFixed(1)}% · prob ${stats.probabilityPct.toFixed(1)}% · reliability ${stats.reliabilityPct.toFixed(1)}% · confidence ${stats.confidencePct.toFixed(1)}%.`
    : strongestActiveSignal.metric === "none"
      ? `Lecture drift en surveillance, sans signal dominant exploitable. Score ${scorePct.toFixed(1)}% · prob ${stats.probabilityPct.toFixed(1)}% · reliability ${stats.reliabilityPct.toFixed(1)}% · confidence ${stats.confidencePct.toFixed(1)}% · KS ${ksScore.toFixed(2)}${stats.adwinTriggered ? " · ADWIN on" : ""}. Cause: ${cause.summary}.`
      : `${strongestActiveSignal.metric} ${strongestActiveSignal.drift > 0 ? "+" : ""}${(strongestActiveSignal.drift * 100).toFixed(0)}% vs 24h (${strongestActiveSignal.currentRate}% vs ${strongestActiveSignal.baselineRate}%). Score ${scorePct.toFixed(1)}% · prob ${stats.probabilityPct.toFixed(1)}% · reliability ${stats.reliabilityPct.toFixed(1)}% · confidence ${stats.confidencePct.toFixed(1)}% · KS ${ksScore.toFixed(2)}${stats.adwinTriggered ? " · ADWIN on" : ""}. Cause: ${cause.summary}.`;

  const alertFeed = [
    ...alerts.map((alert) => ({
      t: nowMs,
      iso: new Date(nowMs).toISOString(),
      state,
      type: alert.type,
      metric: alert.metric,
      severity: alert.severity,
      score: alert.score,
      scorePct: alert.scorePct,
      currentRate: alert.currentRate,
      baselineRate: alert.baselineRate,
      summary: `${alert.currentWindow} ${alert.metric} ${alert.currentRate}% vs ${alert.baselineRate}%`,
      source: "active-window" as const,
    })),
    ...history
      .filter((item) => item.state !== "CALM")
      .slice(-8)
      .map((item) => {
        const severity: RuntimeDecisionDriftAlertFeedEntry["severity"] = item.state === "CRITICAL" || item.state === "DRIFT"
          ? "critical"
          : "info";
        return {
          t: item.t * 1000,
          iso: item.iso,
          state: item.state,
          type: item.type,
          metric: item.metric,
          severity,
          score: item.score,
          scorePct: item.scorePct,
          currentRate: item.currentRate,
          baselineRate: item.baselineRate,
          summary: `${item.metric} ${item.currentRate}% vs ${item.baselineRate}%`,
          source: "history" as const,
        };
      }),
  ].sort((left, right) => right.t - left.t);

  return {
    detected: alerts.length > 0 || (stats.confirmed && Math.max(score, stats.probability) >= 0.25),
    tone,
    state,
    type,
    score,
    scorePct,
    stats,
    cause,
    windows,
    alerts,
    history,
    alertFeed,
    headline,
    summary,
  };
}

function buildSeries(rows: DerivedExecutionRow[], nowMs: number) {
  const bucketMs = SERIES_BUCKET_HOURS * 60 * 60 * 1000;
  const alignedNow = Math.ceil(nowMs / bucketMs) * bucketMs;
  const pointCount = Math.max(1, Math.round(SERIES_WINDOW_HOURS / SERIES_BUCKET_HOURS));
  const points: RuntimeDecisionSeriesPoint[] = [];

  for (let index = pointCount - 1; index >= 0; index -= 1) {
    const bucketEnd = alignedNow - index * bucketMs;
    const bucketStart = bucketEnd - bucketMs;
    const bucketRows = rows.filter((row) => row.timestampMs >= bucketStart && row.timestampMs < bucketEnd);
    const executionRows = bucketRows.length;
    const noTradeRows = bucketRows.filter((row) => row.isNoTrade).length;
    const candidateRows = bucketRows.filter((row) => row.opportunityCandidate);
    const blockedCandidates = candidateRows.filter((row) => row.isNoTrade).length;
    const executedCandidates = candidateRows.filter((row) => !row.isNoTrade).length;
    points.push({
      t: Math.floor(bucketEnd / 1000),
      iso: new Date(bucketEnd).toISOString(),
      executionRows,
      noTradeRate: percent(noTradeRows, executionRows),
      routingZeroRate: percent(bucketRows.filter((row) => row.isNoTrade && row.code === "routing-score-zero").length, noTradeRows),
      fallbackRate: percent(bucketRows.filter((row) => row.isNoTrade && row.code === "fallback-mode").length, noTradeRows),
      runtimeBlockRate: percent(bucketRows.filter((row) => row.isNoTrade && row.bucket === "runtime").length, noTradeRows),
      policyBlockRate: percent(bucketRows.filter((row) => row.isNoTrade && row.bucket === "policy").length, noTradeRows),
      falsePositiveRate: percent(bucketRows.filter((row) => row.falsePositiveCandidate).length, noTradeRows),
      opportunityRate: percent(candidateRows.length, executionRows),
      missedOpportunityRate: percent(blockedCandidates, candidateRows.length),
      executionEfficiency: percent(executedCandidates, candidateRows.length),
      driftScore: computeGlobalDriftScore({
        routingZeroRate: percent(bucketRows.filter((row) => row.isNoTrade && row.code === "routing-score-zero").length, noTradeRows),
        fallbackRate: percent(bucketRows.filter((row) => row.isNoTrade && row.code === "fallback-mode").length, noTradeRows),
        runtimeBlockRate: percent(bucketRows.filter((row) => row.isNoTrade && row.bucket === "runtime").length, noTradeRows),
        policyBlockRate: percent(bucketRows.filter((row) => row.isNoTrade && row.bucket === "policy").length, noTradeRows),
      }),
      driftScorePct: Number((computeGlobalDriftScore({
        routingZeroRate: percent(bucketRows.filter((row) => row.isNoTrade && row.code === "routing-score-zero").length, noTradeRows),
        fallbackRate: percent(bucketRows.filter((row) => row.isNoTrade && row.code === "fallback-mode").length, noTradeRows),
        runtimeBlockRate: percent(bucketRows.filter((row) => row.isNoTrade && row.bucket === "runtime").length, noTradeRows),
        policyBlockRate: percent(bucketRows.filter((row) => row.isNoTrade && row.bucket === "policy").length, noTradeRows),
      }) * 100).toFixed(1)),
    });
  }

  return {
    bucketHours: SERIES_BUCKET_HOURS,
    windowHours: SERIES_WINDOW_HOURS,
    points,
  };
}

function flattenLocalTerminalCaptures(store: PersistedLocalTerminalCaptureStore): LocalTerminalRuntimeCapture[] {
  const deduped = new Map<string, LocalTerminalRuntimeCapture>();
  const allCaptures = [
    ...Object.values(store.captures),
    ...Object.values(store.captureHistory).flat(),
  ];

  for (const capture of allCaptures) {
    if (!capture || typeof capture !== "object" || typeof capture.clientId !== "string" || typeof capture.capturedAt !== "string") {
      continue;
    }
    const key = `${capture.clientId}:${capture.capturedAt}`;
    if (!deduped.has(key)) {
      deduped.set(key, capture);
    }
  }

  return Array.from(deduped.values()).sort((left, right) => String(right.capturedAt).localeCompare(String(left.capturedAt)));
}

function toRuntimeIntegrityState(score: number): RuntimeDecisionIntegrityState {
  if (score >= 0.8) {
    return "HIGH";
  }
  if (score >= 0.5) {
    return "DEGRADED";
  }
  return "BROKEN";
}

function toFeatureIntegrityState(value: unknown): RuntimeDecisionFeatureIntegrityState {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "high") {
    return "HIGH";
  }
  if (normalized === "degraded") {
    return "DEGRADED";
  }
  if (normalized === "broken") {
    return "BROKEN";
  }
  return "INACTIVE";
}

function featureIntegrityScore(state: RuntimeDecisionFeatureIntegrityState): number {
  if (state === "HIGH" || state === "INACTIVE") {
    return 1;
  }
  if (state === "DEGRADED") {
    return 0.55;
  }
  return 0.2;
}

function buildMultiChartFeatureIntegrity(capture: LocalTerminalRuntimeCapture | null): RuntimeDecisionFeatureIntegrity {
  const feature = capture?.runtime.multiChartIntegrity;
  const state = toFeatureIntegrityState(feature?.state);
  const score = featureIntegrityScore(state);
  return {
    state,
    score,
    scorePct: Number((score * 100).toFixed(1)),
    reasons: Array.isArray(feature?.reasons) ? feature.reasons.slice(0, 6) : [],
    summary: typeof feature?.summary === "string" && feature.summary.trim().length > 0
      ? feature.summary
      : state === "INACTIVE"
        ? "multi-chart inactive"
        : "multi-chart integrity unavailable",
    activeTiles: typeof feature?.activeTiles === "number" ? feature.activeTiles : undefined,
    expectedTiles: typeof feature?.expectedTiles === "number" ? feature.expectedTiles : undefined,
    syncAgeMs: typeof feature?.syncAgeMs === "number" ? feature.syncAgeMs : null,
    sourceDivergenceCount: typeof feature?.sourceDivergenceCount === "number" ? feature.sourceDivergenceCount : undefined,
    masterClockDriftMs: typeof feature?.masterClockDriftMs === "number" ? feature.masterClockDriftMs : null,
  };
}

function buildV5FeatureIntegrity(capture: LocalTerminalRuntimeCapture | null): RuntimeDecisionOperatorLiveMetrics["v5"] {
  const feature = capture?.runtime.v5Observation;
  const state = toFeatureIntegrityState(feature?.state);
  const score = featureIntegrityScore(state);
  return {
    state,
    score,
    scorePct: Number((score * 100).toFixed(1)),
    reasons: Array.isArray(feature?.blockedReasons) ? feature.blockedReasons.slice(0, 8) : [],
    summary: typeof feature?.summary === "string" && feature.summary.trim().length > 0
      ? feature.summary
      : state === "INACTIVE"
        ? "v5 inactive"
        : "v5 observation unavailable",
    enabled: Boolean(feature?.enabled),
    mode: typeof feature?.mode === "string" ? feature.mode : "inactive",
    drawdownPaused: Boolean(feature?.drawdownPaused),
    sourceLabel: typeof feature?.sourceLabel === "string" ? feature.sourceLabel : "inactive",
    promotionReady: Boolean(feature?.promotionReady),
    requiredShadowCycles: typeof feature?.requiredShadowCycles === "number" ? feature.requiredShadowCycles : 0,
    observedShadowCycles: typeof feature?.observedShadowCycles === "number" ? feature.observedShadowCycles : 0,
    requiredObservationHours: typeof feature?.requiredObservationHours === "number" ? feature.requiredObservationHours : 0,
    observedObservationHours: typeof feature?.observedObservationHours === "number" ? feature.observedObservationHours : 0,
    missingExecutionMetrics: Boolean(feature?.missingExecutionMetrics),
  };
}

function buildRuntimeIntegrity(input: {
  live: RuntimeDecisionOperatorLiveMetrics;
  observation: RuntimeDecisionAnalyticsSummary["observation"];
  reliability: RuntimeDecisionReliability;
  semanticMismatchSharePct: number;
}): RuntimeDecisionIntegrity {
  const reasons: string[] = [];
  const coverageHours = Number(input.observation.sampleHours || 0);
  const expectedHours = Math.max(1, input.observation.integrity.expectedHours || 0);
  const gapDensity = expectedHours > 0 ? input.observation.integrity.missingHours / expectedHours : 1;
  const effectiveLatencyMs = input.live.latestEndToEndLagMs
    ?? input.reliability.freshnessMs
    ?? input.live.avgBusLagMs
    ?? Number.POSITIVE_INFINITY;
  const staleRate = (input.live.staleRateXchPct ?? 100) / 100;
  const coverageScore = coverageHours >= 72 ? 1 : coverageHours >= 24 ? 0.7 : coverageHours >= 6 ? 0.4 : 0;
  const freshnessScore = effectiveLatencyMs < 200 && staleRate < 0.1
    ? 1
    : effectiveLatencyMs < 500 && staleRate < 0.35
      ? 0.6
      : 0.2;
  const consistencyScore = input.observation.driftStability >= 70 && input.observation.decisionConsistency >= 72 && input.semanticMismatchSharePct <= 5
    ? 1
    : input.observation.driftStability >= 55 && input.observation.decisionConsistency >= 60 && input.semanticMismatchSharePct <= 12
      ? 0.6
      : 0.2;
  let continuityScore = gapDensity < 0.1 ? 1 : gapDensity < 0.3 ? 0.5 : 0;
  if ((input.live.latestCaptureAgeSec ?? Number.POSITIVE_INFINITY) > 90) {
    continuityScore = Math.min(continuityScore, 0.2);
    reasons.push("capture_not_alive");
  }
  if (String(input.live.latestBusState || "").trim().toLowerCase() !== "ok") {
    continuityScore = Math.min(continuityScore, continuityScore >= 1 ? 0.6 : continuityScore);
    reasons.push("websocket_unstable");
  }
  if (coverageScore < 1) {
    reasons.push(coverageHours < 24 ? "coverage_window_short" : "coverage_window_building");
  }
  if (freshnessScore < 1) {
    if (staleRate >= 0.1) {
      reasons.push("xch_stale_rate_high");
    }
    if (effectiveLatencyMs >= 200) {
      reasons.push("latency_elevated");
    }
  }
  if (consistencyScore < 1) {
    if (input.observation.driftStability < 70) {
      reasons.push("drift_stability_low");
    }
    if (input.observation.decisionConsistency < 72) {
      reasons.push("decision_consistency_low");
    }
    if (input.semanticMismatchSharePct > 5) {
      reasons.push("signal_alignment_partial");
    }
  }
  if (gapDensity >= 0.1) {
    reasons.push(gapDensity >= 0.3 ? "gap_density_high" : "missing_snapshots");
  }
  const baseScore = (coverageScore + freshnessScore + consistencyScore + continuityScore) / 4;
  let penalty = 0;
  if (input.live.multiChart.state === "BROKEN") {
    penalty += 0.2;
    reasons.push(...input.live.multiChart.reasons.slice(0, 2));
  } else if (input.live.multiChart.state === "DEGRADED") {
    penalty += 0.1;
    reasons.push(...input.live.multiChart.reasons.slice(0, 2));
  }
  if (input.live.v5.state === "BROKEN") {
    penalty += 0.2;
    reasons.push(...input.live.v5.reasons.slice(0, 2));
  } else if (input.live.v5.state === "DEGRADED") {
    penalty += 0.1;
    reasons.push(...input.live.v5.reasons.slice(0, 2));
  }
  const score = clamp01(baseScore - penalty);
  const state = toRuntimeIntegrityState(score);
  const uniqueReasons = Array.from(new Set(reasons)).slice(0, 6);
  return {
    state,
    score: Number(score.toFixed(3)),
    scorePct: Number((score * 100).toFixed(1)),
    summary: `${state} ${Number((score * 100).toFixed(0))}% · ${uniqueReasons.slice(0, 3).join(" · ") || "signals aligned"}`,
    reasons: uniqueReasons,
    coverageScore: Number(coverageScore.toFixed(3)),
    freshnessScore: Number(freshnessScore.toFixed(3)),
    consistencyScore: Number(consistencyScore.toFixed(3)),
    continuityScore: Number(continuityScore.toFixed(3)),
    coverageScorePct: Number((coverageScore * 100).toFixed(1)),
    freshnessScorePct: Number((freshnessScore * 100).toFixed(1)),
    consistencyScorePct: Number((consistencyScore * 100).toFixed(1)),
    continuityScorePct: Number((continuityScore * 100).toFixed(1)),
    multiChart: input.live.multiChart,
    v5: input.live.v5,
  };
}

function buildOperatorLiveMetrics(input: {
  nowMs: number;
  localCaptures: LocalTerminalRuntimeCapture[];
  drift: RuntimeDecisionAnalyticsSummary["drift"];
  opportunity: RuntimeDecisionAnalyticsSummary["opportunity"];
  observation: RuntimeDecisionAnalyticsSummary["observation"];
}): RuntimeDecisionOperatorLiveMetrics {
  const latestCapture = input.localCaptures[0] || null;
  const multiChart = buildMultiChartFeatureIntegrity(latestCapture);
  const v5 = buildV5FeatureIntegrity(latestCapture);
  const latestTruth = latestCapture?.runtime.truth;
  const latestCaptureAtMs = latestCapture ? parseTimestamp(latestCapture.capturedAt) : 0;
  const latestCaptureAgeSec = latestCaptureAtMs > 0
    ? Math.max(0, Math.round((input.nowMs - latestCaptureAtMs) / 1000))
    : null;
  const xchCaptures = input.localCaptures.filter((capture) => capture.runtime.truth && capture.runtime.truth.exchangeStatus !== "unknown");
  const staleCount = xchCaptures.filter((capture) => capture.runtime.truth?.exchangeStatus === "stale").length;
  const staleRateXchPct = xchCaptures.length > 0 ? Number(((staleCount / xchCaptures.length) * 100).toFixed(1)) : null;
  const busLagValues = input.localCaptures.map((capture) => {
    const truthBusLag = capture.runtime.truth?.busLagMs;
    if (truthBusLag != null && Number.isFinite(truthBusLag)) {
      return truthBusLag;
    }
    const routingBusLag = capture.runtime.routingDiagnostics?.bus_lag_ms;
    if (routingBusLag != null && Number.isFinite(routingBusLag)) {
      return routingBusLag;
    }
    return capture.dataset?.market_state?.bus_lag_ms ?? null;
  });
  const avgBusLagMs = averageNullableNumbers(busLagValues);
  const limitingFactor = input.opportunity.breakdown
    .slice()
    .sort((left, right) => left.score - right.score || left.label.localeCompare(right.label))[0] || null;
  const latestXchStatus = latestTruth
    ? latestTruth.exchangeStatus.toUpperCase() as RuntimeDecisionOperatorLiveMetrics["latestXchStatus"]
    : "UNKNOWN";
  const latestBusLagMs = latestTruth?.busLagMs
    ?? latestCapture?.runtime.routingDiagnostics?.bus_lag_ms
    ?? latestCapture?.dataset?.market_state?.bus_lag_ms
    ?? null;
  const latestEndToEndLagMs = latestTruth?.endToEndLagMs ?? null;
  const summary = latestCapture
    ? `capture ${latestCapture.chart.feedLabel} · xch ${latestXchStatus.toLowerCase()} ${latestTruth?.exchangeAgeLabel || "n/a"} · stale ${staleRateXchPct != null ? `${staleRateXchPct}%` : "n/a"} · bus ${formatCompactLag(latestBusLagMs)} · consistency ${input.observation.decisionConsistency}%${multiChart.state !== "INACTIVE" ? ` · grid ${multiChart.state.toLowerCase()}` : ""}${v5.state !== "INACTIVE" ? ` · v5 ${v5.state.toLowerCase()}` : ""}`
    : `Aucune capture terminal locale recente. Drift ${input.drift.stats.probabilityPct}% · consistency ${input.observation.decisionConsistency}% uniquement.`;

  return {
    source: latestCapture ? "local-terminal-capture" : "unavailable",
    latestCaptureAtIso: latestCapture?.capturedAt || null,
    latestCaptureAgeSec,
    latestFeedLabel: latestCapture?.chart.feedLabel || null,
    latestXchStatus,
    latestXchAgeLabel: latestTruth?.exchangeAgeLabel || "n/a",
    latestXchSourceLabel: latestTruth?.exchangeSourceLabel || null,
    staleRateXchPct,
    xchSampleCount: xchCaptures.length,
    avgBusLagMs,
    latestBusLagMs,
    latestEndToEndLagMs,
    latestBusState: latestCapture?.runtime.bus.status || null,
    driftProbabilityPct: input.drift.stats.probabilityPct,
    driftReliabilityPct: input.drift.stats.reliabilityPct,
    driftType: input.drift.type,
    opportunityScorePct: input.opportunity.avgScore,
    opportunityCount: input.opportunity.candidateCount,
    limitingFactor: limitingFactor
      ? {
        label: limitingFactor.label,
        scorePct: limitingFactor.scorePct,
        tone: limitingFactor.tone,
      }
      : null,
    decisionConsistencyPct: input.observation.decisionConsistency,
    multiChart,
    v5,
    summary,
  };
}

function buildMonitoringAlerts(input: {
  live: RuntimeDecisionOperatorLiveMetrics;
  reliability: RuntimeDecisionReliability;
  drift: RuntimeDecisionAnalyticsSummary["drift"];
  opportunity: RuntimeDecisionAnalyticsSummary["opportunity"];
  observation: RuntimeDecisionAnalyticsSummary["observation"];
  integrity: RuntimeDecisionIntegrity;
  semanticMismatchSharePct: number;
  falsePositiveSharePct: number;
}): RuntimeDecisionMonitoringAlert[] {
  const alerts: RuntimeDecisionMonitoringAlert[] = [];
  const observationIntegrity = input.observation.integrity || null;
  const opportunityGuard = input.opportunity.guard || null;

  if (input.reliability.state !== "RELIABLE") {
    alerts.push({
      id: "interpretation-reliability-gate",
      severity: input.reliability.state === "BLOCKED_BY_DATA" ? "critical" : "warning",
      label: `Reliability ${input.reliability.state}`,
      summary: input.reliability.summary,
      action: "Traiter les causes de blocage/degradation avant d'utiliser le drift ou l'opportunity comme signal interpretable.",
      source: "observation",
    });
  }

  if (input.integrity.state !== "HIGH") {
    alerts.push({
      id: "runtime-integrity-gate",
      severity: input.integrity.state === "BROKEN" ? "critical" : "warning",
      label: `Integrity ${input.integrity.state}`,
      summary: input.integrity.summary,
      action: "Traiter les raisons d'integrite avant d'utiliser les signaux observes comme realite exploitable.",
      source: "integrity",
    });
  }

  if (input.live.latestXchStatus === "STALE" || (input.live.staleRateXchPct != null && input.live.staleRateXchPct >= 35)) {
    alerts.push({
      id: "xch-stale-rate",
      severity: input.live.staleRateXchPct != null && input.live.staleRateXchPct >= 55 ? "critical" : "warning",
      label: "XCH freshness degraded",
      summary: `XCH stale rate ${input.live.staleRateXchPct != null ? `${input.live.staleRateXchPct}%` : "n/a"} · latest ${input.live.latestXchStatus.toLowerCase()} ${input.live.latestXchAgeLabel}.`,
      action: "Verifier la source quote/depth active avant d'interpreter bus/UI comme un bug runtime.",
      source: "live-capture",
    });
  }

  if ((input.live.latestBusLagMs ?? 0) >= 2_500 || (input.live.avgBusLagMs ?? 0) >= 1_200) {
    alerts.push({
      id: "bus-lag-elevated",
      severity: (input.live.latestBusLagMs ?? 0) >= 2_500 ? "critical" : "warning",
      label: "Bus lag elevated",
      summary: `bus latest ${formatCompactLag(input.live.latestBusLagMs)} · avg ${formatCompactLag(input.live.avgBusLagMs)}.`,
      action: "Inspecter sequence bus, upstream market feed et pressure UI avant toute lecture execution-ready.",
      source: "live-capture",
    });
  }

  if (input.drift.state === "CRITICAL" || input.drift.state === "DRIFT") {
    alerts.push({
      id: "drift-confirmed",
      severity: input.drift.state === "CRITICAL" ? "critical" : "warning",
      label: `Drift ${input.drift.state.toLowerCase()}`,
      summary: `${input.drift.headline} · prob ${input.drift.stats.probabilityPct}% · reliability ${input.drift.stats.reliabilityPct}%.`,
      action: "Traiter la derive comportementale avant de recalibrer policy, score ou execution engine.",
      source: "drift",
    });
  }

  if (input.opportunity.missedOpportunityRate >= 50 && (input.opportunity.topBlockedBucket.label === "runtime" || input.opportunity.topBlockedBucket.label === "policy")) {
    alerts.push({
      id: "missed-opportunity-block",
      severity: input.opportunity.missedOpportunityRate >= 70 ? "critical" : "warning",
      label: "Tradable contexts still blocked",
      summary: `${input.opportunity.missedOpportunityRate}% des contextes tradables restent bloques cote ${input.opportunity.topBlockedBucket.label}.`,
      action: "Comparer runtime guards et policy blocks avant d'ajuster la sensibilite de detection.",
      source: "opportunity",
    });
  }

  if (input.observation.decisionConsistency < 65 || input.semanticMismatchSharePct > 5) {
    alerts.push({
      id: "decision-consistency-low",
      severity: input.observation.decisionConsistency < 55 ? "critical" : "warning",
      label: "Decision consistency under target",
      summary: `consistency ${input.observation.decisionConsistency}% · mismatch ${input.semanticMismatchSharePct}%.`,
      action: "Nettoyer la narration journal/runtime avant toute conclusion sur un probleme de marche ou de policy.",
      source: "observation",
    });
  }

  if (input.falsePositiveSharePct > 10) {
    alerts.push({
      id: "false-positive-watch",
      severity: input.falsePositiveSharePct > 15 ? "warning" : "info",
      label: "False positive watch",
      summary: `false positive candidates ${input.falsePositiveSharePct}% sur la fenetre active.`,
      action: "Rejouer les refus en contexte stable avant de renforcer les blocs runtime/policy.",
      source: "observation",
    });
  }

  if (observationIntegrity && observationIntegrity.status !== "OK") {
    alerts.push({
      id: "observation-integrity-gap",
      severity: observationIntegrity.status === "CRITICAL" ? "critical" : "warning",
      label: "Observation integrity gaps",
      summary: observationIntegrity.summary,
      action: "Mesurer et traiter les trous de snapshots avant de lire READY comme un vrai signal de fiabilite.",
      source: "observation",
    });
  }

  if (opportunityGuard && opportunityGuard.state !== "OK") {
    alerts.push({
      id: "opportunity-guard-active",
      severity: ["UNTRUSTED", "BLOCKED_BY_DATA"].includes(opportunityGuard.state) ? "critical" : "warning",
      label: `Guard ${opportunityGuard.state}`,
      summary: opportunityGuard.summary,
      action: "Bloquer toute lecture confiante du score opportunity tant que le guard reste actif.",
      source: "opportunity",
    });
  }

  return alerts
    .sort((left, right) => monitoringSeverityRank(right.severity) - monitoringSeverityRank(left.severity) || left.label.localeCompare(right.label))
    .slice(0, 8);
}

function buildNoTradeHeatmap(rows: DerivedExecutionRow[], noTradeRows: number): RuntimeDecisionAnalyticsSummary["monitoring"]["noTradeHeatmap"] {
  const noTradeOnly = rows.filter((row) => row.isNoTrade);
  if (noTradeOnly.length === 0) {
    return {
      timeframes: [],
      rows: [],
      summary: "Aucun blocage NO_TRADE recent pour construire la heatmap.",
    };
  }

  const timeframeCounts = new Map<string, number>();
  const regimeCounts = new Map<string, number>();
  for (const row of noTradeOnly) {
    timeframeCounts.set(row.entry.timeframe, (timeframeCounts.get(row.entry.timeframe) || 0) + 1);
    regimeCounts.set(row.context.volatilityRegime, (regimeCounts.get(row.context.volatilityRegime) || 0) + 1);
  }

  const timeframes = sortedEntries(timeframeCounts)
    .slice(0, 6)
    .map(([timeframe]) => timeframe)
    .sort((left, right) => timeframeSortValue(left) - timeframeSortValue(right) || left.localeCompare(right));
  const regimes = sortedEntries(regimeCounts)
    .slice(0, 5)
    .map(([regime]) => regime);

  const heatmapRows = regimes.map((regime) => {
    const regimeRows = noTradeOnly.filter((row) => row.context.volatilityRegime === regime);
    const cells = timeframes.map((timeframe) => {
      const cellRows = regimeRows.filter((row) => row.entry.timeframe === timeframe);
      const codeCounts = new Map<string, number>();
      const falseContextCounts = new Map<string, number>();
      for (const row of cellRows) {
        codeCounts.set(row.code, (codeCounts.get(row.code) || 0) + 1);
        if (row.context.falseContextFamily) {
          falseContextCounts.set(row.context.falseContextFamily, (falseContextCounts.get(row.context.falseContextFamily) || 0) + 1);
        }
      }
      const topCodeEntry = sortedEntries(codeCounts)[0] || ["n/a", 0];
      const topFalseContextEntry = sortedEntries(falseContextCounts)[0] || ["", 0];
      const sharePct = percent(cellRows.length, noTradeRows);
      return {
        timeframe,
        count: cellRows.length,
        sharePct,
        tone: heatmapTone(cellRows.length, sharePct),
        topCode: topCodeEntry[0],
        topCodeSharePct: percent(topCodeEntry[1], cellRows.length),
        topFalseContextFamily: topFalseContextEntry[0] || null,
        topFalseContextSharePct: percent(topFalseContextEntry[1], cellRows.length),
      };
    });

    return {
      regime,
      totalCount: regimeRows.length,
      totalSharePct: percent(regimeRows.length, noTradeRows),
      cells,
    };
  });

  const dominantRow = heatmapRows[0] || null;
  const dominantCell = dominantRow
    ? dominantRow.cells.slice().sort((left, right) => right.count - left.count || left.timeframe.localeCompare(right.timeframe))[0] || null
    : null;
  const dominantFalseContextCounts = new Map<string, number>();
  for (const row of noTradeOnly) {
    if (row.context.falseContextFamily) {
      dominantFalseContextCounts.set(row.context.falseContextFamily, (dominantFalseContextCounts.get(row.context.falseContextFamily) || 0) + 1);
    }
  }
  const topFalseContext = sortedEntries(dominantFalseContextCounts)[0] || null;

  return {
    timeframes,
    rows: heatmapRows,
    summary: dominantRow && dominantCell
      ? `${dominantRow.regime} domine ${dominantRow.totalSharePct}% des NO_TRADE, avec ${dominantCell.count} cas sur ${dominantCell.timeframe} surtout via ${dominantCell.topCode}${topFalseContext ? ` · motif ${topFalseContext[0]}` : ""}.`
      : "Heatmap NO_TRADE disponible mais sans cluster dominant net.",
  };
}

function buildFalseContextMotifs(rows: DerivedExecutionRow[], noTradeRows: number): RuntimeDecisionFalseContextMotif[] {
  const grouped = new Map<string, { count: number; reasons: string[] }>();
  for (const row of rows) {
    const family = row.context.falseContextFamily;
    if (!row.isNoTrade || !family) {
      continue;
    }
    const bucket = grouped.get(family) || { count: 0, reasons: [] };
    bucket.count += 1;
    bucket.reasons.push(...row.context.falseContextReasonTags);
    grouped.set(family, bucket);
  }
  return [...grouped.entries()]
    .map(([family, bucket]) => ({
      family,
      count: bucket.count,
      sharePct: percent(bucket.count, noTradeRows),
      topReasons: uniqueStrings(bucket.reasons).slice(0, 4),
    }))
    .sort((left, right) => right.count - left.count || left.family.localeCompare(right.family));
}

function buildObservationWindow(input: {
  snapshots?: Array<{
    bucketStartIso: string;
    driftProbability: number;
    reliability: number;
    opportunityScore: number;
    driftFalsePositiveRate: number;
    opportunityHitRate: number;
    decisionConsistency: number;
    driftStability: number;
    driftReliabilityMean: number;
    observationStatus: RuntimeDecisionObservationStatus;
    reliabilityState?: RuntimeDecisionReliabilityState | "UNKNOWN";
    observationIntegrityStatus?: RuntimeDecisionObservationIntegrityStatus | "UNKNOWN";
    integrityState?: RuntimeDecisionIntegrityState | "UNKNOWN";
    integrityScorePct?: number;
    observationGapDensityPct?: number;
    observationMissingHours?: number;
    observationExpectedHours?: number;
    noTradeConcentrationPct?: number;
    noTradeConcentrationLabel?: string | null;
    manualCalibrationEligible: boolean;
  }>;
  observation: RuntimeDecisionAnalyticsSummary["observation"];
}): RuntimeDecisionObservationWindow {
  const snapshots = input.snapshots || [];
  const points = snapshots
    .slice()
    .sort((left, right) => left.bucketStartIso.localeCompare(right.bucketStartIso))
    .map((snapshot) => ({
      bucketStartIso: snapshot.bucketStartIso,
      driftProbability: snapshot.driftProbability,
      reliability: snapshot.reliability,
      opportunityScore: snapshot.opportunityScore,
      driftFalsePositiveRate: snapshot.driftFalsePositiveRate,
      opportunityHitRate: snapshot.opportunityHitRate,
      decisionConsistency: snapshot.decisionConsistency,
      driftStability: snapshot.driftStability,
      driftReliabilityMean: snapshot.driftReliabilityMean,
      observationStatus: snapshot.observationStatus,
      reliabilityState: snapshot.reliabilityState || "UNKNOWN",
      observationIntegrityStatus: snapshot.observationIntegrityStatus || "UNKNOWN",
      integrityState: snapshot.integrityState || "UNKNOWN",
      integrityScorePct: Number(snapshot.integrityScorePct || 0),
      gapDensityPct: Number(snapshot.observationGapDensityPct || 0),
      noTradeConcentrationPct: Number(snapshot.noTradeConcentrationPct || 0),
      noTradeConcentrationLabel: typeof snapshot.noTradeConcentrationLabel === "string" && snapshot.noTradeConcentrationLabel.trim().length > 0
        ? snapshot.noTradeConcentrationLabel.trim()
        : null,
      manualCalibrationEligible: snapshot.manualCalibrationEligible,
    }));
  const latest = points[points.length - 1] || null;
  const first = points[0] || null;
  const coverageHours = countCoveredHourBucketsFromIso(points.map((point) => point.bucketStartIso));
  const status: RuntimeDecisionObservationWindowStatus = coverageHours >= input.observation.maxObservationHours
    ? "READY"
    : coverageHours >= input.observation.minObservationHours
      ? "OBSERVING"
      : "BUILDING";
  const baselinePoint = points.length > 1
    ? points[Math.max(0, points.length - Math.min(points.length, 24))]
    : null;
  const deltas: RuntimeDecisionObservationWindowDelta[] = latest
    ? [
      {
        metric: "driftFalsePositiveRate",
        current: latest.driftFalsePositiveRate,
        baseline: baselinePoint?.driftFalsePositiveRate ?? null,
        delta: baselinePoint ? Number((latest.driftFalsePositiveRate - baselinePoint.driftFalsePositiveRate).toFixed(1)) : null,
      },
      {
        metric: "opportunityHitRate",
        current: latest.opportunityHitRate,
        baseline: baselinePoint?.opportunityHitRate ?? null,
        delta: baselinePoint ? Number((latest.opportunityHitRate - baselinePoint.opportunityHitRate).toFixed(1)) : null,
      },
      {
        metric: "decisionConsistency",
        current: latest.decisionConsistency,
        baseline: baselinePoint?.decisionConsistency ?? null,
        delta: baselinePoint ? Number((latest.decisionConsistency - baselinePoint.decisionConsistency).toFixed(1)) : null,
      },
      {
        metric: "driftReliabilityMean",
        current: latest.driftReliabilityMean,
        baseline: baselinePoint?.driftReliabilityMean ?? null,
        delta: baselinePoint ? Number((latest.driftReliabilityMean - baselinePoint.driftReliabilityMean).toFixed(1)) : null,
      },
    ]
    : [];
  const knownReliabilityStates = points.filter((point) => point.reliabilityState !== "UNKNOWN");
  const knownIntegrityPoints = points.filter((point) => point.integrityState !== "UNKNOWN");
  const unknownReliabilityCount = points.length - knownReliabilityStates.length;
  const reliabilityDistribution: RuntimeDecisionTemporalReliabilityDistribution[] = ([
    { state: "RELIABLE", tone: "good" },
    { state: "DEGRADED", tone: "subtle" },
    { state: "BLOCKED_BY_DATA", tone: "warn" },
  ] as const).map((item) => {
    const count = knownReliabilityStates.filter((point) => point.reliabilityState === item.state).length;
    return {
      state: item.state,
      count,
      sharePct: knownReliabilityStates.length > 0 ? Number(((count / knownReliabilityStates.length) * 100).toFixed(1)) : 0,
      tone: item.tone,
    };
  });
  const latestGapDensityPct = latest ? Number(latest.gapDensityPct.toFixed(1)) : 0;
  const latestIntegrityState = latest?.integrityState || "UNKNOWN";
  const latestIntegrityScorePct = latest && latest.integrityState !== "UNKNOWN"
    ? Number(latest.integrityScorePct.toFixed(1))
    : null;
  const averageIntegrityScorePct = knownIntegrityPoints.length > 0
    ? Number(averageNumbers(knownIntegrityPoints.map((point) => point.integrityScorePct)).toFixed(1))
    : null;
  const integrityBaselinePoint = knownIntegrityPoints.length > 1
    ? knownIntegrityPoints[Math.max(0, knownIntegrityPoints.length - Math.min(knownIntegrityPoints.length, 24))]
    : null;
  const integrityDeltaPct = latestIntegrityScorePct != null && integrityBaselinePoint
    ? Number((latestIntegrityScorePct - integrityBaselinePoint.integrityScorePct).toFixed(1))
    : null;
  const integrityTrend: RuntimeDecisionTemporalTrend = {
    direction: integrityDeltaPct == null
      ? "UNKNOWN"
      : integrityDeltaPct >= 6
        ? "UP"
        : integrityDeltaPct <= -6
          ? "DOWN"
          : "STABLE",
    deltaPct: integrityDeltaPct,
    baselineScorePct: integrityBaselinePoint ? Number(integrityBaselinePoint.integrityScorePct.toFixed(1)) : null,
    latestScorePct: latestIntegrityScorePct,
    summary: integrityDeltaPct == null
      ? "Integrity trend unavailable"
      : integrityDeltaPct >= 6
        ? `Integrity improving ${integrityDeltaPct > 0 ? "+" : ""}${integrityDeltaPct}%`
        : integrityDeltaPct <= -6
          ? `Integrity degrading ${integrityDeltaPct}%`
          : `Integrity stable ${integrityDeltaPct > 0 ? "+" : ""}${integrityDeltaPct}%`,
  };
  const integrityVolatilityPct = knownIntegrityPoints.length > 1
    ? Number(averageNumbers(knownIntegrityPoints.slice(1).map((point, index) => Math.abs(point.integrityScorePct - knownIntegrityPoints[index].integrityScorePct))).toFixed(1))
    : null;
  const averageGapDensityPct = points.length > 0 ? Number((averageNumbers(points.map((point) => point.gapDensityPct)) * 1).toFixed(1)) : 0;
  const latestDriftStability = latest ? latest.driftStability : null;
  const averageDriftStability = points.length > 0 ? Number(averageNumbers(points.map((point) => point.driftStability)).toFixed(1)) : null;
  const latestNoTradeConcentrationPct = latest ? Number(latest.noTradeConcentrationPct.toFixed(1)) : 0;
  const averageNoTradeConcentrationPct = points.length > 0 ? Number(averageNumbers(points.map((point) => point.noTradeConcentrationPct)).toFixed(1)) : 0;
  const realityCheckReasons: string[] = [];
  if (latestIntegrityState === "HIGH" && latest?.observationIntegrityStatus !== "OK") {
    realityCheckReasons.push("integrity_high_vs_partial_observation");
  }
  if (latestIntegrityState === "HIGH" && (latest?.reliabilityState === "BLOCKED_BY_DATA" || latestGapDensityPct > 5)) {
    realityCheckReasons.push("integrity_high_vs_data_gap");
  }
  if (latestIntegrityState === "HIGH" && latest?.reliabilityState === "DEGRADED") {
    realityCheckReasons.push("integrity_high_vs_reliability_degraded");
  }
  const realityCheck: RuntimeDecisionIntegrityRealityCheck = {
    status: realityCheckReasons.includes("integrity_high_vs_partial_observation") || realityCheckReasons.includes("integrity_high_vs_data_gap")
      ? "FAIL"
      : realityCheckReasons.length > 0
        ? "WATCH"
        : "OK",
    summary: realityCheckReasons.includes("integrity_high_vs_partial_observation")
      ? "Integrity HIGH conflicts with partial observation coverage."
      : realityCheckReasons.includes("integrity_high_vs_data_gap")
        ? "Integrity HIGH conflicts with live data gaps or blocked reliability."
        : realityCheckReasons.includes("integrity_high_vs_reliability_degraded")
          ? "Integrity HIGH stays under watch while reliability remains degraded."
          : "Integrity remains coherent with observed reality.",
    reasons: realityCheckReasons,
  };
  const reliableShare = reliabilityDistribution.find((item) => item.state === "RELIABLE")?.sharePct || 0;
  const thresholds: RuntimeDecisionTemporalThreshold[] = [
    {
      key: "reliableShareCeiling",
      label: "Reliable share ceiling",
      status: reliableShare > 65 ? "FAIL" : reliableShare > 45 ? "WATCH" : "PASS",
      value: reliableShare,
      threshold: 45,
      summary: reliableShare > 65
        ? `RELIABLE ${reliableShare}%: le systeme devient trop confiant.`
        : reliableShare > 45
          ? `RELIABLE ${reliableShare}%: surveiller une confiance trop rapide.`
          : `RELIABLE ${reliableShare}%: la prudence reste dominante.`,
    },
    {
      key: "driftStabilityFloor",
      label: "Drift stability floor",
      status: (averageDriftStability ?? 0) < 50 ? "FAIL" : (averageDriftStability ?? 0) < 65 ? "WATCH" : "PASS",
      value: Number((averageDriftStability ?? 0).toFixed(1)),
      threshold: 65,
      summary: (averageDriftStability ?? 0) < 50
        ? `Drift stability moyenne ${(averageDriftStability ?? 0).toFixed(1)}%: bruit dominant.`
        : (averageDriftStability ?? 0) < 65
          ? `Drift stability moyenne ${(averageDriftStability ?? 0).toFixed(1)}%: validation encore fragile.`
          : `Drift stability moyenne ${(averageDriftStability ?? 0).toFixed(1)}%: comportement temporel coherent.`,
    },
    {
      key: "gapDensityCeiling",
      label: "Gap density ceiling",
      status: latestGapDensityPct > 20 ? "FAIL" : latestGapDensityPct > 5 ? "WATCH" : "PASS",
      value: latestGapDensityPct,
      threshold: 5,
      summary: latestGapDensityPct > 20
        ? `Gap density ${latestGapDensityPct}%: couverture trop trouee.`
        : latestGapDensityPct > 5
          ? `Gap density ${latestGapDensityPct}%: trous visibles a surveiller.`
          : `Gap density ${latestGapDensityPct}%: couverture temporelle saine.`,
    },
    {
      key: "noTradeConcentrationFloor",
      label: "NO_TRADE concentration floor",
      status: latestNoTradeConcentrationPct < 15 ? "FAIL" : latestNoTradeConcentrationPct < 35 ? "WATCH" : "PASS",
      value: latestNoTradeConcentrationPct,
      threshold: 35,
      summary: latestNoTradeConcentrationPct < 15
        ? `NO_TRADE concentration ${latestNoTradeConcentrationPct}%: dispersion trop forte, bruit probable.`
        : latestNoTradeConcentrationPct < 35
          ? `NO_TRADE concentration ${latestNoTradeConcentrationPct}%: pattern encore diffus.`
          : `NO_TRADE concentration ${latestNoTradeConcentrationPct}%: cluster localise exploitable.`,
    },
    {
      key: "integrityVolatilityCeiling",
      label: "Integrity volatility ceiling",
      status: (integrityVolatilityPct ?? 0) > 18 ? "FAIL" : (integrityVolatilityPct ?? 0) > 10 ? "WATCH" : "PASS",
      value: Number((integrityVolatilityPct ?? 0).toFixed(1)),
      threshold: 10,
      summary: (integrityVolatilityPct ?? 0) > 18
        ? `Integrity volatility ${(integrityVolatilityPct ?? 0).toFixed(1)}%: score trop instable.`
        : (integrityVolatilityPct ?? 0) > 10
          ? `Integrity volatility ${(integrityVolatilityPct ?? 0).toFixed(1)}%: variations rapides a surveiller.`
          : `Integrity volatility ${(integrityVolatilityPct ?? 0).toFixed(1)}%: evolution stable.`,
    },
  ];
  const validation: RuntimeDecisionTemporalValidation = {
    reliabilityDistribution,
    unknownReliabilityCount,
    latestReliabilityState: latest?.reliabilityState || "UNKNOWN",
    latestIntegrityState,
    latestIntegrityScorePct,
    averageIntegrityScorePct,
    integrityTrend,
    integrityVolatilityPct,
    realityCheck,
    latestGapDensityPct,
    averageGapDensityPct,
    latestDriftStability,
    averageDriftStability,
    latestNoTradeConcentrationPct,
    averageNoTradeConcentrationPct,
    latestNoTradeConcentrationLabel: latest?.noTradeConcentrationLabel || null,
    thresholds,
    summary: `Reliability mix ${reliabilityDistribution.map((item) => `${item.state} ${item.sharePct}%`).join(" · ")} · integrity ${latestIntegrityState}${latestIntegrityScorePct != null ? ` ${latestIntegrityScorePct}%` : ""} · ${integrityTrend.direction !== "UNKNOWN" ? integrityTrend.summary.toLowerCase() : "integrity trend unavailable"} · gaps latest ${latestGapDensityPct}% · NO_TRADE concentration ${latestNoTradeConcentrationPct}%${unknownReliabilityCount > 0 ? ` · legacy snapshots ${unknownReliabilityCount}` : ""}`,
  };
  const gateSummary = status === "BUILDING"
    ? `Observation building ${coverageHours.toFixed(1)}h/${input.observation.minObservationHours}h: suivre FP, hit rate et consistency avant toute lecture de calibration.`
    : status === "OBSERVING"
      ? `Observation active ${coverageHours.toFixed(1)}h/${input.observation.maxObservationHours}h: verifier que FP baisse et que hit rate + consistency restent stables.`
      : input.observation.manualCalibrationEligible
        ? `Fenetre 3-7 jours couverte: revue manuelle possible, jamais auto-calibration.`
        : `Fenetre 3-7 jours couverte mais gate encore ferme: prolonger l'observation ou nettoyer runtime/journal.`;

  return {
    status,
    sampleCount: points.length,
    coverageHours,
    minObservationHours: input.observation.minObservationHours,
    maxObservationHours: input.observation.maxObservationHours,
    points,
    latest,
    deltas,
    validation,
    gateSummary,
  };
}

function buildGovernanceBudget(input: {
  observationWindow: RuntimeDecisionObservationWindow;
  observation: RuntimeDecisionAnalyticsSummary["observation"];
  reliability: RuntimeDecisionReliability;
  falseContextMotifs?: RuntimeDecisionFalseContextMotif[];
}): RuntimeDecisionGovernanceBudget {
  const failThresholds = input.observationWindow.validation.thresholds.filter((item) => item.status === "FAIL");
  const watchThresholds = input.observationWindow.validation.thresholds.filter((item) => item.status === "WATCH");
  const reasons: string[] = [];

  if (input.reliability.state === "BLOCKED_BY_DATA") {
    reasons.push(`reliability ${input.reliability.state}`);
  }
  if (input.observationWindow.status === "BUILDING") {
    reasons.push(`window ${input.observationWindow.coverageHours.toFixed(1)}h < ${input.observationWindow.minObservationHours}h`);
  }
  if (failThresholds.length > 0) {
    reasons.push(...failThresholds.map((item) => item.label));
  }
  if (watchThresholds.length > 0) {
    reasons.push(...watchThresholds.map((item) => item.label));
  }
  const falseContextMotifs = (input.falseContextMotifs || []).slice(0, 3);
  if (falseContextMotifs.length > 0) {
    reasons.push(...falseContextMotifs.map((item) => `${item.family} ${item.sharePct}%`));
  }

  if (input.reliability.state === "BLOCKED_BY_DATA" || input.observationWindow.status === "BUILDING" || failThresholds.length > 0) {
    return {
      state: "NO_CONCLUSION",
      conclusionBudgetPct: 0,
      autoPromotionAllowed: false,
      summary: "Governance budget 0%: le systeme gagne le droit de ne pas conclure tant que la fenetre ou la fiabilite restent insuffisantes.",
      reasons: Array.from(new Set(reasons)).slice(0, 5),
      falseContextMotifs: falseContextMotifs.map(({ family, count, sharePct }) => ({ family, count, sharePct })),
    };
  }

  if (
    input.reliability.state === "DEGRADED"
    || input.observationWindow.status === "OBSERVING"
    || !input.observation.manualCalibrationEligible
    || watchThresholds.length > 1
  ) {
    return {
      state: "OBSERVE_ONLY",
      conclusionBudgetPct: 15,
      autoPromotionAllowed: false,
      summary: "Governance budget 15%: observation et annotation manuelle seulement, sans conclusion forte ni durcissement du score.",
      reasons: Array.from(new Set(reasons.length > 0 ? reasons : ["observation still active"])).slice(0, 5),
      falseContextMotifs: falseContextMotifs.map(({ family, count, sharePct }) => ({ family, count, sharePct })),
    };
  }

  return {
    state: "MANUAL_REVIEW_ONLY",
    conclusionBudgetPct: 35,
    autoPromotionAllowed: false,
    summary: "Governance budget 35%: une conclusion humaine bornee est autorisee, jamais une escalation automatique ni une agressivite supplementaire.",
    reasons: Array.from(new Set(reasons.length > 0 ? reasons : ["manual review gate open"])).slice(0, 5),
    falseContextMotifs: falseContextMotifs.map(({ family, count, sharePct }) => ({ family, count, sharePct })),
  };
}

function buildOperatorMonitoring(input: {
  rows: DerivedExecutionRow[];
  noTradeRows: number;
  nowMs: number;
  localCaptures: LocalTerminalRuntimeCapture[];
  kpiSnapshots?: Array<{
    bucketStartIso: string;
    driftProbability: number;
    reliability: number;
    opportunityScore: number;
    driftFalsePositiveRate: number;
    opportunityHitRate: number;
    decisionConsistency: number;
    driftStability: number;
    driftReliabilityMean: number;
    observationStatus: RuntimeDecisionObservationStatus;
    reliabilityState?: RuntimeDecisionReliabilityState | "UNKNOWN";
    observationIntegrityStatus?: RuntimeDecisionObservationIntegrityStatus | "UNKNOWN";
    integrityState?: RuntimeDecisionIntegrityState | "UNKNOWN";
    integrityScorePct?: number;
    observationGapDensityPct?: number;
    observationMissingHours?: number;
    observationExpectedHours?: number;
    noTradeConcentrationPct?: number;
    noTradeConcentrationLabel?: string | null;
    manualCalibrationEligible: boolean;
  }>;
  reliability: RuntimeDecisionReliability;
  drift: RuntimeDecisionAnalyticsSummary["drift"];
  opportunity: RuntimeDecisionAnalyticsSummary["opportunity"];
  observation: RuntimeDecisionAnalyticsSummary["observation"];
  integrity: RuntimeDecisionIntegrity;
  semanticMismatchSharePct: number;
  falsePositiveSharePct: number;
}): RuntimeDecisionAnalyticsSummary["monitoring"] {
  const observationWindow = buildObservationWindow({
    snapshots: input.kpiSnapshots || [],
    observation: input.observation,
  });
  const live = buildOperatorLiveMetrics({
    nowMs: input.nowMs,
    localCaptures: input.localCaptures,
    drift: input.drift,
    opportunity: input.opportunity,
    observation: input.observation,
  });
  const anomalyRows = buildMonitoringAlerts({
    live,
    reliability: input.reliability,
    drift: input.drift,
    opportunity: input.opportunity,
    observation: input.observation,
    integrity: input.integrity,
    semanticMismatchSharePct: input.semanticMismatchSharePct,
    falsePositiveSharePct: input.falsePositiveSharePct,
  });
  const falseContextMotifs = buildFalseContextMotifs(input.rows, input.noTradeRows);

  return {
    live,
    observationWindow,
    governanceBudget: buildGovernanceBudget({
      observationWindow,
      observation: input.observation,
      reliability: input.reliability,
      falseContextMotifs,
    }),
    anomalies: {
      activeCount: anomalyRows.length,
      rows: anomalyRows,
    },
    noTradeHeatmap: buildNoTradeHeatmap(input.rows, input.noTradeRows),
    falseContextMotifs,
  };
}

function buildObservationSummary(input: {
  rows: DerivedExecutionRow[];
  noTradeRows: number;
  effectiveCanonicalCoveragePct: number;
  semanticMismatchSharePct: number;
  falsePositiveSharePct: number;
  exclusiveFalsePositiveSharePct?: number;
  drift: RuntimeDecisionAnalyticsSummary["drift"];
  opportunityHitRate: number;
  seriesPoints: RuntimeDecisionSeriesPoint[];
  windowDays: number;
}): RuntimeDecisionAnalyticsSummary["observation"] {
  const minObservationHours = 72;
  const maxObservationHours = 168;
  const timestamps = input.rows.map((row) => row.timestampMs).filter((value) => Number.isFinite(value));
  const integrity = buildObservationIntegrity(timestamps);
  const sampleHours = countCoveredHourBucketsFromTimestamps(timestamps);
  const decisionOutcomeRows = input.rows.filter((row) => row.isNoTrade && row.entry.decisionOutcome);
  const decisionOutcomeCoveragePct = percent(decisionOutcomeRows.length, input.noTradeRows);
  const activeSeriesPoints = input.seriesPoints.filter((point) => point.executionRows > 0);
  const driftDetectionRate = percent(
    activeSeriesPoints.filter((point) => point.driftScore >= DRIFT_WATCH_THRESHOLD).length,
    activeSeriesPoints.length,
  );
  const driftStdDev = activeSeriesPoints.length > 1 ? standardDeviation(activeSeriesPoints.map((point) => point.driftScore)) : 0;
  const historyStates = input.drift.history.filter((item) => item.noTradeRows > 0).map((item) => item.state);
  const transitionCount = Math.max(0, historyStates.length - 1);
  let stateChanges = 0;
  for (let index = 1; index < historyStates.length; index += 1) {
    if (historyStates[index] !== historyStates[index - 1]) {
      stateChanges += 1;
    }
  }
  const stateFlipRate = transitionCount > 0 ? stateChanges / transitionCount : 0;
  const driftStability = Number((clamp01((1 - clamp01(driftStdDev / 0.18)) * 0.7 + (1 - stateFlipRate) * 0.3) * 100).toFixed(1));
  const exclusiveFalsePositiveSharePct = Number.isFinite(input.exclusiveFalsePositiveSharePct)
    ? Number(input.exclusiveFalsePositiveSharePct)
    : input.falsePositiveSharePct;
  const decisionConsistency = Number((clamp01(
    (input.effectiveCanonicalCoveragePct / 100) * 0.4
    + clamp01(1 - input.semanticMismatchSharePct / 100) * 0.25
    + clamp01(1 - exclusiveFalsePositiveSharePct / 100) * 0.15
    + input.drift.stats.windowConsistency * 0.2
  ) * 100).toFixed(1));
  const driftReliabilityMean = Number((averageNumbers([
    input.drift.stats.reliability,
    input.drift.stats.windowConsistency,
    1 - input.drift.stats.noiseLevel,
  ]) * 100).toFixed(1));
  const status: RuntimeDecisionObservationStatus = sampleHours < minObservationHours
    ? "INSUFFICIENT"
    : sampleHours < maxObservationHours
      ? "OBSERVE"
      : "READY_FOR_REVIEW";
  const manualCalibrationEligible = sampleHours >= maxObservationHours
    && integrity.status === "OK"
    && decisionConsistency >= 70
    && driftReliabilityMean >= 60
    && driftStability >= 65
    && input.falsePositiveSharePct <= 12;
  const recommendation = status === "INSUFFICIENT"
    ? `Continuer l'observation live jusqu'a ${minObservationHours}h minimum avant toute calibration. Aucun changement de policy ni auto-calibration.`
    : status === "OBSERVE"
      ? `Fenetre active ${sampleHours.toFixed(1)}h/${maxObservationHours}h. ${integrity.summary} Suivre driftFalsePositiveRate, driftStability, opportunityHitRate, decisionConsistency et driftReliabilityMean sans toucher a l'automatisation.`
      : manualCalibrationEligible
        ? "La fenetre 3-7 jours est couverte. Gate de revue manuelle ouvert: calibration bornee, un seul ajustement a la fois, aucune automatisation."
        : `La fenetre 3-7 jours est couverte, mais le gate reste ferme. ${integrity.summary} Prolonger l'observation ou nettoyer narration/runtime avant toute calibration manuelle.`;

  return {
    status,
    windowDays: input.windowDays,
    sampleHours,
    minObservationHours,
    maxObservationHours,
    decisionOutcomeCoveragePct,
    driftFalsePositiveRate: input.falsePositiveSharePct,
    driftDetectionRate,
    driftStability,
    opportunityHitRate: input.opportunityHitRate,
    decisionConsistency,
    driftReliabilityMean,
    manualCalibrationEligible,
    autoCalibrationAllowed: false,
    integrity,
    recommendation,
  };
}

function buildDeskRead(summary: RuntimeDecisionAnalyticsSummary): RuntimeDecisionAnalyticsSummary["deskRead"] {
  if (summary.opportunity.liveState === "NO_DATA_AUTH") {
    return {
      tone: "warn",
      headline: "Control-plane telemetry auth failed",
      summary: summary.opportunity.liveSummary,
      nextAction: "Restaurer un vrai bearer/session control-plane avec sid valide avant de comparer payload reelle et parseur opportunity.",
    };
  }
  if (summary.reliability.state === "BLOCKED_BY_DATA") {
    return {
      tone: "warn",
      headline: "Interpretation blocked by data",
      summary: summary.reliability.summary,
      nextAction: summary.reliability.blockingReasons.length > 0
        ? `WHY BLOCKED: ${summary.reliability.blockingReasons.slice(0, 4).join(" · ")}`
        : "Completer la data critique avant toute interpretation du drift ou de l'opportunity.",
    };
  }
  if (summary.reliability.state === "DEGRADED") {
    return {
      tone: "subtle",
      headline: "Interpretation remains degraded",
      summary: summary.reliability.summary,
      nextAction: summary.reliability.degradedReasons.length > 0
        ? `WHY DEGRADED: ${summary.reliability.degradedReasons.slice(0, 4).join(" · ")}`
        : "Continuer la collecte sans tuning tant que la fiabilite reste degradee.",
    };
  }
  if (summary.integrity.state === "BROKEN") {
    return {
      tone: "warn",
      headline: "Observed reality is not exploitable right now",
      summary: summary.integrity.summary,
      nextAction: `WHY INTEGRITY: ${summary.integrity.reasons.slice(0, 4).join(" · ") || "capture or continuity degraded"}`,
    };
  }
  if (summary.integrity.state === "DEGRADED") {
    return {
      tone: "subtle",
      headline: "Observed reality remains usable but degraded",
      summary: summary.integrity.summary,
      nextAction: `WHY INTEGRITY: ${summary.integrity.reasons.slice(0, 4).join(" · ") || "minor integrity pressure"}`,
    };
  }
  if (summary.semanticMismatchCandidates.count > 0) {
    return {
      tone: "warn",
      headline: "Journal truth needs cleanup",
      summary: `${summary.semanticMismatchCandidates.sharePct}% des NO_TRADE montrent une incoherence semantique.`,
      nextAction: "Stabiliser la narration runtime avant toute adaptation automatique ou auto-calibration.",
    };
  }
  if (summary.opportunity.liveState === "NO_DATA_EMPTY") {
    return {
      tone: "subtle",
      headline: "Live telemetry returned empty payloads",
      summary: summary.opportunity.liveSummary,
      nextAction: "Verifier l'ingestion venue/route avant d'interpreter l'opportunity engine ou de parler calibration.",
    };
  }
  if (summary.opportunity.liveState === "NO_DATA_PARTIAL") {
    return {
      tone: "warn",
      headline: "Live telemetry is partial",
      summary: summary.opportunity.liveSummary,
      nextAction: "Restaurer les stats execution route ou adapter le parseur a la shape profile brute avant toute lecture du gate live ou du score opportunity.",
    };
  }
  if (summary.opportunity.guard.state === "PARTIAL_DATA") {
    return {
      tone: "warn",
      headline: "Opportunity telemetry remains partial",
      summary: summary.opportunity.guard.summary,
      nextAction: "Ne traite pas le score opportunity comme un signal fiable tant que des champs runtime critiques restent partiels.",
    };
  }
  if (summary.opportunity.liveState === "STALE") {
    return {
      tone: "warn",
      headline: "Live telemetry is stale",
      summary: summary.opportunity.liveSummary,
      nextAction: "Traiter d'abord la fraicheur market/route avant de conclure a un manque d'edge ou a un drift policy.",
    };
  }
  if (summary.opportunity.guard.state === "UNTRUSTED") {
    return {
      tone: "warn",
      headline: "Observation integrity does not support trust",
      summary: summary.opportunity.guard.summary,
      nextAction: "Traiter les trous de couverture et les gaps de snapshots avant de parler systeme decisionnel fiable.",
    };
  }
  if (summary.drift.state !== "CALM") {
    return {
      tone: summary.drift.tone,
      headline: summary.drift.headline,
      summary: summary.drift.summary,
      nextAction: "Traiter d'abord la derive comportementale avant de conclure a un probleme de policy ou de marche.",
    };
  }
  if (summary.opportunity.liveState === "NO_EDGE") {
    return {
      tone: "subtle",
      headline: "Market is not tradable right now",
      summary: summary.opportunity.liveSummary,
      nextAction: "Ne touche pas a la policy: confirme d'abord si le marche reste reellement pauvre en edge sur plusieurs buckets.",
    };
  }
  if (summary.opportunity.missedOpportunityRate >= 50 && (summary.dominant.bucket.label === "runtime" || summary.dominant.bucket.label === "policy")) {
    return {
      tone: "warn",
      headline: "Tradable contexts are still being blocked",
      summary: `${summary.opportunity.missedOpportunityRate}% des contextes tradables sont bloques, surtout cote ${summary.dominant.bucket.label}.`,
      nextAction: "Observer plusieurs jours, faire baisser mismatch et faux positifs, puis seulement discuter calibration.",
    };
  }
  return {
    tone: summary.falsePositiveCandidates.count > 0 ? "subtle" : "good",
    headline: "Opportunity scarcity dominates",
    summary: `Les refus viennent d'abord du marche/routing: ${summary.dominant.bucket.sharePct}% sur la fenetre chargee.`,
    nextAction: summary.falsePositiveCandidates.count > 0
      ? "Rejouer les refus en contexte stable avant toute calibration automatique."
      : "Le systeme est lisible: tu peux etendre l'observabilite sans toucher a la policy.",
  };
}

// control-plane runs a single uvicorn worker whose event loop stalls for
// ~10-13s windows (periodic background reconcile); the telemetry budget must
// survive one full stall or liveState degrades to NO_DATA_PARTIAL and blocks
// kill-switch reset eligibility.
const RUNTIME_DECISION_ANALYTICS_LOAD_TIMEOUT_MS = Math.max(
  3_500,
  Number(process.env.RUNTIME_DECISION_ANALYTICS_LOAD_TIMEOUT_MS || 20_000),
);

async function withRuntimeDecisionTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timeoutId = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function unavailableOpportunityTelemetry(): RuntimeDecisionOpportunityTelemetry {
  return {
    source: "context-only",
    availability: "unavailable",
    venueCount: 0,
    marketVenueCount: 0,
    routeVenueCount: 0,
    avgSpreadBps: null,
    avgAvailableDepthUsd: null,
    avgDepthLatencyMs: null,
    avgFillProbability: null,
    avgStabilityScore: null,
    avgRouteLatencyMs: null,
    avgFillLatencyMs: null,
    avgSlippageBps: null,
    spreadBudgetBps: null,
    latencyBudgetMs: null,
    summary: "Runtime telemetry timeout: dashboard fallback lecture structurelle uniquement.",
    rootCause: "NETWORK_FAILURE",
    missingFields: ["telemetry"],
    isStale: true,
  };
}

export async function getRuntimeDecisionAnalytics(options?: {
  symbol?: string;
  timeframe?: string;
  strategy?: string;
  limit?: number;
  sinceDays?: number;
  samples?: number;
}): Promise<RuntimeDecisionAnalyticsSummary> {
  const symbol = String(options?.symbol || "").trim().toUpperCase();
  const timeframe = String(options?.timeframe || "").trim();
  const strategy = String(options?.strategy || "").trim();
  const limit = Math.max(1, Math.min(2_000, Math.round(Number(options?.limit || 1_200))));
  const sinceDays = Math.max(1, Math.min(90, Math.round(Number(options?.sinceDays || 7))));
  const samples = Math.max(1, Math.min(10, Math.round(Number(options?.samples || 3))));
  // Lecture pour la couverture d'observation : bornée par la fenêtre temporelle (cutoff sinceDays)
  // + maxBytes côté reader, PAS par le petit `limit` d'affichage. Sans ce découplage, coveredHours
  // plafonne à ~limit/débit heures (le bug du plateau ~7h vs 24h/72h requis).
  const observationReadLimit = (() => {
    const raw = Number(process.env.RUNTIME_DECISION_OBSERVATION_MAX_LINES);
    return Number.isFinite(raw) ? Math.max(2_000, Math.min(100_000, Math.round(raw))) : 12_000;
  })();

  const [entries, opportunityTelemetry, localTerminalCaptureStore, kpiSnapshotHistory] = await Promise.all([
    withRuntimeDecisionTimeout(
      readV2RiskJournalEntries({ symbol, timeframe, strategy, limit: observationReadLimit, sinceDays }).catch(() => []),
      RUNTIME_DECISION_ANALYTICS_LOAD_TIMEOUT_MS,
      [],
    ),
    withRuntimeDecisionTimeout(
      readOpportunityTelemetry().catch(() => unavailableOpportunityTelemetry()),
      RUNTIME_DECISION_ANALYTICS_LOAD_TIMEOUT_MS,
      unavailableOpportunityTelemetry(),
    ),
    withRuntimeDecisionTimeout(
      readLocalTerminalCaptureStore().catch(() => defaultLocalTerminalCaptureStore()),
      RUNTIME_DECISION_ANALYTICS_LOAD_TIMEOUT_MS,
      defaultLocalTerminalCaptureStore(),
    ),
    withRuntimeDecisionTimeout(
      readRuntimeDecisionKpiSnapshots({ symbol, timeframe, strategy, limit: 168, sinceDays }).catch(() => []),
      RUNTIME_DECISION_ANALYTICS_LOAD_TIMEOUT_MS,
      [],
    ),
  ]);
  const rows = deriveRows(entries);
  const localTerminalCaptures = flattenLocalTerminalCaptures(localTerminalCaptureStore);
  const nowMs = rows.length > 0 ? rows[rows.length - 1].timestampMs : Date.now();
  const core = summarizeRows(rows, samples);
  const rankedOpportunities = rows
    .filter((row) => row.opportunityCandidate)
    .map((row) => computeOpportunityScore(row, opportunityTelemetry))
    .sort((left, right) => right.score - left.score || right.createdAtIso.localeCompare(left.createdAtIso));
  const opportunityBreakdown = aggregateOpportunityBreakdown(rankedOpportunities);
  const leadingOpportunityConstraint = opportunityBreakdown
    .slice()
    .sort((left, right) => left.score - right.score || left.label.localeCompare(right.label))[0] || null;
  const topOpportunity = rankedOpportunities[0] || null;
  const avgOpportunityScore = rankedOpportunities.length > 0 ? Number((averageNumbers(rankedOpportunities.map((item) => item.score)) * 100).toFixed(1)) : 0;
  const opportunityConfidencePct = rankedOpportunities.length > 0
    ? Number((averageNumbers(rankedOpportunities.map((item) => item.confidence ?? 0)) * 100).toFixed(1))
    : 0;
  const highQualityRate = rankedOpportunities.length > 0
    ? Number(((rankedOpportunities.filter((item) => item.score >= 0.65).length / rankedOpportunities.length) * 100).toFixed(1))
    : 0;
  const drift = buildDrift(rows, nowMs, opportunityTelemetry);
  const series = buildSeries(rows, nowMs);
  const dominantBucket = topRow(core.byBucketRows.map((row) => ({ label: row.bucket, count: row.count, sharePct: row.sharePct })), "unknown");
  const dominantCode = topRow(core.topCodes.map((row) => ({ label: row.code, count: row.count, sharePct: row.sharePct })), "unknown");
  const dominantAttention = topRow(core.attentionRows, "unknown");
  const dominantVolatility = topRow(core.volatilityRows, "unknown");
  const topBlockedBucket = topRow(core.blockedByBucketRows.map((row) => ({ label: row.bucket, count: row.count, sharePct: row.sharePct })), "unknown");
  const liveOpportunity = evaluateOpportunityLiveState({
    telemetry: opportunityTelemetry,
    candidateCount: core.candidateCount,
    avgOpportunityScore,
    confidencePct: opportunityConfidencePct,
  });
  const latestDecisionOutcome = rows
    .filter((row) => row.isNoTrade && row.entry.decisionOutcome)
    .map((row) => row.entry.decisionOutcome || null)
    .slice(-1)[0] || null;
  const semanticMismatchSharePct = percent(core.semanticMismatchCount, core.noTradeRows);
  const falsePositiveSharePct = percent(core.falsePositiveCount, core.noTradeRows);

  const opportunity: RuntimeDecisionAnalyticsSummary["opportunity"] = {
    candidateCount: core.candidateCount,
    blockedCount: core.blockedCount,
    executedCount: core.executedCount,
    opportunityRate: percent(core.candidateCount, core.executionRows),
    missedOpportunityRate: percent(core.blockedCount, core.candidateCount),
    executionEfficiency: percent(core.executedCount, core.candidateCount),
    avgScore: avgOpportunityScore,
    confidencePct: opportunityConfidencePct,
    highQualityRate,
    missingSignals: topOpportunity?.missing || [],
    blockedByBucket: core.blockedByBucketRows,
    topBlockedBucket,
    liveState: liveOpportunity.state,
    liveSummary: liveOpportunity.summary,
    guard: {
      state: "OK",
      blocked: false,
      trustScorePct: 100,
      summary: "OK",
      reasons: [],
    },
    confidenceEngine: {
      state: "EXPLORATORY",
      sampleSize: 0,
      stability: 0,
      stabilityPct: 0,
      summary: "EXPLORATORY · runtime confidence unavailable.",
    },
    telemetry: opportunityTelemetry,
    breakdown: opportunityBreakdown,
    topRanked: rankedOpportunities.slice(0, samples + 2),
    summary: core.candidateCount === 0
      ? `${liveOpportunity.summary} Aucun contexte structurel suffisamment tradable sur la fenetre chargee.`
      : core.blockedCount === 0
        ? `${liveOpportunity.summary} Score moyen ${avgOpportunityScore}% · confiance ${opportunityConfidencePct}% · ${topOpportunity?.rationale || "profil balanced"}.`
        : `${liveOpportunity.summary} Score moyen ${avgOpportunityScore}% · confiance ${opportunityConfidencePct}% · contrainte dominante ${leadingOpportunityConstraint?.label.toLowerCase() || "flow"} ${leadingOpportunityConstraint?.scorePct.toFixed(0) || "0"}% · ${percent(core.blockedCount, core.candidateCount)}% des contextes structurellement tradables restent bloques, principalement cote ${topBlockedBucket.label}.`,
  };

  const observation = buildObservationSummary({
    rows,
    noTradeRows: core.noTradeRows,
    effectiveCanonicalCoveragePct: percent(core.canonicalRows + core.normalizedLegacyRows, core.noTradeRows),
    semanticMismatchSharePct,
    falsePositiveSharePct,
    exclusiveFalsePositiveSharePct: percent(
      Math.max(0, core.falsePositiveCount - core.falsePositiveSemanticOverlapCount),
      core.noTradeRows,
    ),
    drift,
    opportunityHitRate: opportunity.executionEfficiency,
    seriesPoints: series.points,
    windowDays: sinceDays,
  });
  const reliability = buildReliability({
    telemetry: opportunityTelemetry,
    observation,
    liveState: opportunity.liveState,
  });
  opportunity.guard = buildOpportunityGuard({
    telemetry: opportunityTelemetry,
    observation,
    liveState: opportunity.liveState,
    reliability,
  });
  opportunity.confidenceEngine = buildOpportunityConfidence({
    signalScore: opportunity.avgScore / 100,
    reliability: reliability.state,
    sampleSize: opportunity.candidateCount,
    stability: clamp01((observation.driftStability / 100) * 0.6 + (observation.decisionConsistency / 100) * 0.4),
  });
  const live = buildOperatorLiveMetrics({
    nowMs,
    localCaptures: localTerminalCaptures,
    drift,
    opportunity,
    observation,
  });
  const integrity = buildRuntimeIntegrity({
    live,
    observation,
    reliability,
    semanticMismatchSharePct,
  });
  const currentKpiSnapshot = createRuntimeDecisionKpiSnapshot({
    scope: { symbol, timeframe, strategy, limit, sinceDays },
    policyVersion: EXECUTION_DECISION_POLICY_VERSION,
    totals: {
      totalRows: entries.length,
      executionRows: core.executionRows,
      noTradeRows: core.noTradeRows,
      noTradePctWithinExecution: percent(core.noTradeRows, core.executionRows),
      canonicalRows: core.canonicalRows,
      normalizedLegacyRows: core.normalizedLegacyRows,
      unclassifiedLegacyRows: core.unclassifiedLegacyRows,
      canonicalCoveragePct: percent(core.canonicalRows, core.noTradeRows),
      effectiveCanonicalCoveragePct: percent(core.canonicalRows + core.normalizedLegacyRows, core.noTradeRows),
    },
    topCodes: core.topCodes,
    byBucket: core.byBucketRows,
    byFamily: core.byFamilyRows,
    marketContext: {
      volatilityRegime: core.volatilityRows,
      attentionState: core.attentionRows,
      tripleValidationState: core.tripleValidationRows,
    },
    semanticMismatchCandidates: {
      count: core.semanticMismatchCount,
      sharePct: percent(core.semanticMismatchCount, core.noTradeRows),
      samples: core.semanticMismatchCandidates,
    },
    falsePositiveCandidates: {
      count: core.falsePositiveCount,
      sharePct: percent(core.falsePositiveCount, core.noTradeRows),
      samples: core.falsePositiveCandidates,
    },
    reliability,
    opportunity,
    drift,
    series,
    dominant: {
      bucket: dominantBucket,
      code: dominantCode,
      attentionState: dominantAttention,
      volatilityRegime: dominantVolatility,
    },
    observation,
    integrity,
    monitoring: {
      live,
      observationWindow: {
        status: "BUILDING",
        sampleCount: 0,
        coverageHours: 0,
        minObservationHours: observation.minObservationHours,
        maxObservationHours: observation.maxObservationHours,
        points: [],
        latest: null,
        deltas: [],
        validation: {
          reliabilityDistribution: [
            { state: "RELIABLE", count: 0, sharePct: 0, tone: "good" },
            { state: "DEGRADED", count: 0, sharePct: 0, tone: "subtle" },
            { state: "BLOCKED_BY_DATA", count: 0, sharePct: 0, tone: "warn" },
          ],
          unknownReliabilityCount: 0,
          latestReliabilityState: "UNKNOWN",
          latestIntegrityState: "UNKNOWN",
          latestIntegrityScorePct: null,
          averageIntegrityScorePct: null,
          integrityTrend: {
            direction: "UNKNOWN",
            deltaPct: null,
            baselineScorePct: null,
            latestScorePct: null,
            summary: "Integrity trend unavailable",
          },
          integrityVolatilityPct: null,
          realityCheck: {
            status: "OK",
            summary: "Integrity remains coherent with observed reality.",
            reasons: [],
          },
          latestGapDensityPct: 0,
          averageGapDensityPct: 0,
          latestDriftStability: null,
          averageDriftStability: null,
          latestNoTradeConcentrationPct: 0,
          averageNoTradeConcentrationPct: 0,
          latestNoTradeConcentrationLabel: null,
          thresholds: [],
          summary: "",
        },
        gateSummary: "",
      },
      governanceBudget: {
        state: "NO_CONCLUSION",
        conclusionBudgetPct: 0,
        autoPromotionAllowed: false,
        summary: "Governance budget 0%: runtime monitoring unavailable, aucune conclusion autorisee.",
        reasons: ["monitoring unavailable"],
        falseContextMotifs: [],
      },
      anomalies: {
        activeCount: 0,
        rows: [],
      },
      noTradeHeatmap: {
        timeframes: [],
        rows: [],
        summary: "",
      },
      falseContextMotifs: [],
    },
    deskRead: {
      tone: "good",
      headline: "Decision reading is stable",
      summary: "",
      nextAction: "",
    },
  } as RuntimeDecisionAnalyticsSummary, latestDecisionOutcome);
  const monitoring = buildOperatorMonitoring({
    rows,
    noTradeRows: core.noTradeRows,
    nowMs,
    localCaptures: localTerminalCaptures,
    kpiSnapshots: [...kpiSnapshotHistory, currentKpiSnapshot],
    drift,
    opportunity,
    observation,
    reliability,
    integrity,
    semanticMismatchSharePct,
    falsePositiveSharePct,
  });

  const summary: RuntimeDecisionAnalyticsSummary = {
    scope: { symbol, timeframe, strategy, limit, sinceDays },
    policyVersion: EXECUTION_DECISION_POLICY_VERSION,
    totals: {
      totalRows: entries.length,
      executionRows: core.executionRows,
      noTradeRows: core.noTradeRows,
      noTradePctWithinExecution: percent(core.noTradeRows, core.executionRows),
      canonicalRows: core.canonicalRows,
      normalizedLegacyRows: core.normalizedLegacyRows,
      unclassifiedLegacyRows: core.unclassifiedLegacyRows,
      canonicalCoveragePct: percent(core.canonicalRows, core.noTradeRows),
      effectiveCanonicalCoveragePct: percent(core.canonicalRows + core.normalizedLegacyRows, core.noTradeRows),
    },
    topCodes: core.topCodes,
    byBucket: core.byBucketRows,
    byFamily: core.byFamilyRows,
    marketContext: {
      volatilityRegime: core.volatilityRows,
      attentionState: core.attentionRows,
      tripleValidationState: core.tripleValidationRows,
    },
    semanticMismatchCandidates: {
      count: core.semanticMismatchCount,
      sharePct: percent(core.semanticMismatchCount, core.noTradeRows),
      samples: core.semanticMismatchCandidates,
    },
    falsePositiveCandidates: {
      count: core.falsePositiveCount,
      sharePct: percent(core.falsePositiveCount, core.noTradeRows),
      samples: core.falsePositiveCandidates,
    },
    reliability,
    opportunity,
    drift,
    series,
    dominant: {
      bucket: dominantBucket,
      code: dominantCode,
      attentionState: dominantAttention,
      volatilityRegime: dominantVolatility,
    },
    observation,
    integrity,
    monitoring,
    deskRead: {
      tone: "good",
      headline: "Decision reading is stable",
      summary: "",
      nextAction: "",
    },
  };

  summary.deskRead = buildDeskRead(summary);
  return summary;
}

export const runtimeDecisionAnalyticsTestables = {
  deriveRows,
  buildSample,
  buildDrift,
  buildReliability,
  buildOpportunityConfidence,
  buildOpportunityBreakdown,
  buildOpportunityGuard,
  buildGovernanceBudget,
  computeOpportunityScore,
  aggregateOpportunityBreakdown,
  computeGlobalDriftScore,
  buildObservationIntegrity,
  buildObservationSummary,
  buildObservationWindow,
  buildOperatorLiveMetrics,
  buildRuntimeIntegrity,
  buildMonitoringAlerts,
  buildNoTradeHeatmap,
  buildOperatorMonitoring,
};