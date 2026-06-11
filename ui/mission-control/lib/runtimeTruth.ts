import { cpFetchJsonSafe, type ControlPlaneNetworkMeta } from "./controlPlane";
import { getControlledCollectionSessionSummary } from "./controlledCollectionWatch";
import { getRuntimeEdgeEvidenceState, type RuntimeEdgeEvidenceState } from "./edgeEvidenceState";
import { getRuntimeDecisionAnalytics } from "./runtimeDecisionAnalytics";
import { promises as fs } from "node:fs";
import path from "node:path";

if (typeof window !== "undefined") {
  throw new Error("runtimeTruth is server-only");
}

type JsonMap = Record<string, unknown>;
type CpFetchResult = Awaited<ReturnType<typeof cpFetchJsonSafe>>;
type RuntimeDecisionSummary = Awaited<ReturnType<typeof getRuntimeDecisionAnalytics>>;

type TruthVerdict = "READY" | "BLOCKED" | "DEGRADED";
type BrokerRealityState = "UNTESTED" | "CONNECTED" | "ACK_VALIDATED" | "FILL_VALIDATED" | "REALITY_GAP_MEASURING" | "REALITY_GAP_STABLE";
type QuoteRealityState = "BLIND" | "OBSERVED";
type DecisionRealityState = "UNKNOWN" | "POLICY_ONLY" | "PARTIAL_QUOTE_AWARE" | "OBSERVED";

type ProjectionSourceDiagnostics = {
  rows_scanned: number;
  rows_returned: number;
};

export type RuntimeTruthCacheAudit = {
  cache_hit: number;
  cache_miss: number;
  age_ms: number | null;
  stale: boolean;
  last_generated_at: string | null;
};

type RuntimeTruthCacheEntry = {
  createdAtMs: number;
  snapshot: RuntimeTruthSnapshot;
};

export type RuntimeTruthSnapshot = {
  schema_version: "runtime-truth/v1";
  generated_at: string;
  source_diagnostics: ProjectionSourceDiagnostics;
  scope: {
    symbol: string;
    market_instrument: string;
    timeframe: string;
    strategy: string;
  };
  verdict: TruthVerdict;
  summary: string;
  blockers: string[];
  degraded_reasons: string[];
  degraded: boolean;
  partial_data: boolean;
  layers: {
    market: JsonMap;
    execution: JsonMap;
    broker_reality: JsonMap;
    quote_reality: JsonMap;
    decision_reality: JsonMap;
    health: JsonMap;
    routing: JsonMap;
    readiness: JsonMap;
    settlement: JsonMap;
    publication: JsonMap;
    watchdog: JsonMap;
    observation: JsonMap;
  };
  raw: {
    kill_switch: unknown;
    system_config: unknown;
    opportunity_gate: unknown;
    market_session: unknown;
    mt5_health: unknown;
    settlement_truth: unknown;
    runtime_decision: RuntimeDecisionSummary | null;
    controlled_collection: Awaited<ReturnType<typeof getControlledCollectionSessionSummary>>;
    edge_evidence: RuntimeEdgeEvidenceState;
    broker_reality: JsonMap;
    quote_reality: JsonMap;
    decision_reality: JsonMap;
    network: Record<string, ControlPlaneNetworkMeta>;
  };
};

type RuntimeTruthGlobal = typeof globalThis & {
  __runtimeTruthCache__?: Map<string, RuntimeTruthCacheEntry>;
  __runtimeTruthInflight__?: Map<string, Promise<RuntimeTruthSnapshot>>;
};

const runtimeTruthGlobal = globalThis as RuntimeTruthGlobal;
const runtimeTruthCache = runtimeTruthGlobal.__runtimeTruthCache__ || new Map<string, RuntimeTruthCacheEntry>();
const runtimeTruthInflight = runtimeTruthGlobal.__runtimeTruthInflight__ || new Map<string, Promise<RuntimeTruthSnapshot>>();

runtimeTruthGlobal.__runtimeTruthCache__ = runtimeTruthCache;
runtimeTruthGlobal.__runtimeTruthInflight__ = runtimeTruthInflight;

const RUNTIME_TRUTH_CP_TIMEOUT_MS = 8_000;
const RUNTIME_TRUTH_SETTLEMENT_TIMEOUT_MS = Math.max(RUNTIME_TRUTH_CP_TIMEOUT_MS, Math.round(Number(process.env.RUNTIME_TRUTH_SETTLEMENT_TIMEOUT_MS || 45_000)));
// Must exceed RUNTIME_DECISION_ANALYTICS_LOAD_TIMEOUT_MS (20s): the inner
// budget absorbs control-plane event loop stalls and returns real telemetry;
// if this outer budget fires first, runtime_decision degrades to null and
// decision_truth goes missing, blocking kill-switch reset eligibility.
const RUNTIME_TRUTH_ANALYTICS_TIMEOUT_MS = Math.max(
  8_000,
  Number(process.env.RUNTIME_TRUTH_ANALYTICS_TIMEOUT_MS || 25_000),
);
const RUNTIME_TRUTH_EDGE_EVIDENCE_TIMEOUT_MS = 900;
const RUNTIME_TRUTH_CACHE_MS = Math.max(5_000, Math.round(Number(process.env.RUNTIME_TRUTH_SNAPSHOT_TTL_MS || 15_000)));

function asRecord(value: unknown): JsonMap {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonMap : {};
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function toNumber(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toNullableNumber(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function toIsoStringOrNull(value: unknown): string | null {
  const text = String(value || "").trim();
  return text ? text : null;
}

function average(values: number[]): number | null {
  if (!values.length) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function elapsedMinutesSince(iso: string | null, nowMs = Date.now()): number | null {
  if (!iso) {
    return null;
  }
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) {
    return null;
  }
  return Math.max(0, (nowMs - ts) / 60000);
}

function parseIsoMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function defaultControlledCollectionSummary(): Awaited<ReturnType<typeof getControlledCollectionSessionSummary>> {
  return {
    available: false,
    active: false,
    baselineSince: null,
    openedAt: null,
    lastSnapshotAt: null,
    durationMinutes: 0,
    cycles: 0,
    phase: "UNAVAILABLE",
    fillsSeen: 0,
    labelsSeen: 0,
    killSwitchRearmed: false,
    killSwitchActive: false,
    killSwitchReason: null,
    killSwitchSource: "unavailable",
    watchStale: true,
    watchAgeMinutes: null,
    gateStatus: null,
    gateHealthScore: null,
    latestFillAt: null,
    latestLabeledAt: null,
    archivePath: "",
    statePath: "",
  };
}

function defaultEdgeEvidenceState(): RuntimeEdgeEvidenceState {
  return {
    available: false,
    state: "UNAVAILABLE",
    summary: "Runtime truth snapshot warming.",
    filePath: "",
    fileUpdatedAt: null,
    matureThresholdEvents: 3,
    cellCount: 0,
    replicatedCells: 0,
    matureCells: 0,
    outcomesWithBoth: 0,
    maxCellEventCount: 0,
    nextGate: {
      name: "UNAVAILABLE",
      targetState: "UNKNOWN",
      condition: "runtime truth snapshot available",
      summary: "Runtime truth snapshot warming.",
      candidateCells: [],
    },
    topCells: [],
  };
}

function findNestedNumber(value: unknown, keys: string[]): number | null {
  if (value && typeof value === "object") {
    if (Array.isArray(value)) {
      for (const item of value) {
        const nested = findNestedNumber(item, keys);
        if (nested !== null) {
          return nested;
        }
      }
      return null;
    }
    const record = value as JsonMap;
    for (const key of keys) {
      const candidate = toNullableNumber(record[key]);
      if (candidate !== null) {
        return candidate;
      }
    }
    for (const nestedValue of Object.values(record)) {
      const nested = findNestedNumber(nestedValue, keys);
      if (nested !== null) {
        return nested;
      }
    }
  }
  return null;
}

function quoteRealityState(input: { bid: number | null; ask: number | null; spreadBps: number | null }): QuoteRealityState {
  return input.bid !== null || input.ask !== null || input.spreadBps !== null ? "OBSERVED" : "BLIND";
}

function isMt5Row(row: JsonMap): boolean {
  const accountId = String(row.account_id || row.accountId || "").trim().toLowerCase();
  const routeChosen = String(row.route_chosen || row.routeChosen || row.provider || row.venue || "").trim().toLowerCase();
  return accountId.startsWith("mt5") || routeChosen.includes("mt5");
}

function brokerRealityState(input: {
  edgeState: string;
  bridgeReachable: boolean;
  ackCount: number;
  fillCount: number;
  realityGapSamples: number;
}): BrokerRealityState {
  if (input.fillCount > 0 && input.realityGapSamples >= 20) {
    return "REALITY_GAP_STABLE";
  }
  if (input.fillCount > 0 && input.realityGapSamples > 0) {
    return "REALITY_GAP_MEASURING";
  }
  if (input.fillCount > 0) {
    return "FILL_VALIDATED";
  }
  if (input.ackCount > 0) {
    return "ACK_VALIDATED";
  }
  if (input.bridgeReachable || input.edgeState === "STRUCTURAL") {
    return "CONNECTED";
  }
  return "UNTESTED";
}

function boundedNetwork(path: string, status = 504): ControlPlaneNetworkMeta {
  return {
    network_state: "degraded",
    retry_count: 0,
    degraded_flag: true,
    failure_classification: status === 504 ? "timeout" : "network_unknown",
    failure_detail: `runtime truth bounded fetch failed for ${path}`,
    attempted_targets: [path],
    attempted_base_urls: [],
    upstream_status: status,
  };
}

function fallbackFetchResult(path: string, status = 504): CpFetchResult {
  const payload = { detail: status === 504 ? "runtime_truth_timeout" : "runtime_truth_fetch_failed", path };
  return {
    response: new Response(JSON.stringify(payload), { status }),
    payload,
    network: boundedNetwork(path, status),
  };
}

async function cpFetchBounded(path: string, timeoutMs = RUNTIME_TRUTH_CP_TIMEOUT_MS, authMode?: "auto" | "service" | "session"): Promise<CpFetchResult> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const fallback = fallbackFetchResult(path, 504);
  const timeoutPromise = new Promise<CpFetchResult>((resolve) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      resolve(fallback);
    }, timeoutMs);
  });
  const fetchPromise = cpFetchJsonSafe(path, { signal: controller.signal, ...(authMode ? { authMode } : {}) })
    .catch(() => fallbackFetchResult(path, 503))
    .finally(() => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    });
  return Promise.race([fetchPromise, timeoutPromise]);
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

async function loadLatestSpreadDecisionTraceSummary(): Promise<JsonMap | null> {
  const candidateDirs = [
    "/workspace/logs/spread_audit",
    "/opt/txt/logs/spread_audit",
    path.join(process.cwd(), "logs", "spread_audit"),
  ];
  for (const dir of candidateDirs) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const files = entries
        .filter((entry) => entry.isFile() && /^spread_decision_trace_.*\.summary\.json$/i.test(entry.name))
        .map((entry) => entry.name);
      if (!files.length) {
        continue;
      }
      const withStats = await Promise.all(
        files.map(async (name) => {
          const fullPath = path.join(dir, name);
          const stat = await fs.stat(fullPath);
          return { fullPath, mtimeMs: stat.mtimeMs };
        }),
      );
      withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);
      const latest = withStats[0];
      if (!latest) {
        continue;
      }
      const raw = await fs.readFile(latest.fullPath, "utf-8");
      const parsed = JSON.parse(raw);
      return asRecord(parsed);
    } catch {
      // Try next candidate directory.
    }
  }
  return null;
}

function deriveVerdict(input: {
  killSwitchActive: boolean;
  gateKnown: boolean;
  gateEnabled: boolean;
  marketOpen: boolean;
  marketReason: string;
  runtimeDecision: RuntimeDecisionSummary | null;
  runtimeReliabilityBlocked: boolean;
  mt5Degraded: boolean;
  controlledWatchStale: boolean;
  edgeEvidenceState: string;
  brokerRealityState: BrokerRealityState;
  quoteRealityState: QuoteRealityState;
  decisionRealityState: DecisionRealityState;
  decisionQuoteCoveragePct: number | null;
  decisionQuoteObservedIgnoredRatePct: number | null;
  decisionQuoteIgnoredGateThresholdPct: number | null;
  partialData: boolean;
}): { verdict: TruthVerdict; blockers: string[]; degradedReasons: string[]; summary: string } {
  const blockers: string[] = [];
  const degradedReasons: string[] = [];
  if (input.killSwitchActive) {
    blockers.push("kill_switch_active");
  }
  if (input.gateKnown && !input.gateEnabled) {
    blockers.push("opportunity_gate_blocked");
  }
  if (!input.marketOpen) {
    blockers.push(`market_closed:${input.marketReason || "unknown"}`);
  }
  const reliabilityState = String(input.runtimeDecision?.reliability?.state || "").trim();
  const liveState = String(input.runtimeDecision?.opportunity?.liveState || "").trim();
  if (reliabilityState && reliabilityState !== "RELIABLE") {
    if (input.runtimeReliabilityBlocked) {
      blockers.push(`runtime_reliability:${reliabilityState}`);
    } else {
      degradedReasons.push(`runtime_reliability:${reliabilityState}`);
    }
  }
  if (liveState && !["GO", "LIVE"].includes(liveState)) {
    if (["NO_DATA_AUTH", "NO_DATA_PARTIAL", "NO_DATA_EMPTY", "STALE"].includes(liveState)) {
      blockers.push(`live_state:${liveState}`);
    } else {
      degradedReasons.push(`live_state:${liveState}`);
    }
  }
  if (input.controlledWatchStale) {
    degradedReasons.push("controlled_collection_watch_stale");
  }
  if (input.mt5Degraded) {
    degradedReasons.push("mt5_health_degraded");
  }
  if (input.edgeEvidenceState === "STRUCTURAL" && ["UNTESTED", "CONNECTED"].includes(input.brokerRealityState)) {
    degradedReasons.push(`broker_reality:${input.brokerRealityState.toLowerCase()}`);
  }
  if (input.edgeEvidenceState === "STRUCTURAL" && input.brokerRealityState === "CONNECTED" && input.quoteRealityState === "BLIND") {
    degradedReasons.push("quote_reality:blind");
  }
  if (input.edgeEvidenceState === "STRUCTURAL" && input.decisionRealityState === "POLICY_ONLY") {
    degradedReasons.push("decision_reality:policy_only");
  }
  const decisionQuoteCoveragePct = typeof input.decisionQuoteCoveragePct === "number" && Number.isFinite(input.decisionQuoteCoveragePct)
    ? input.decisionQuoteCoveragePct
    : null;
  if (decisionQuoteCoveragePct !== null && decisionQuoteCoveragePct < 100) {
    degradedReasons.push(`decision_quote_coverage:${decisionQuoteCoveragePct.toFixed(1)}%`);
  }
  const decisionQuoteObservedIgnoredRatePct = typeof input.decisionQuoteObservedIgnoredRatePct === "number" && Number.isFinite(input.decisionQuoteObservedIgnoredRatePct)
    ? input.decisionQuoteObservedIgnoredRatePct
    : null;
  const decisionQuoteIgnoredGateThresholdPct = typeof input.decisionQuoteIgnoredGateThresholdPct === "number" && Number.isFinite(input.decisionQuoteIgnoredGateThresholdPct)
    ? input.decisionQuoteIgnoredGateThresholdPct
    : 5;
  if (decisionQuoteObservedIgnoredRatePct !== null && decisionQuoteObservedIgnoredRatePct > decisionQuoteIgnoredGateThresholdPct) {
    degradedReasons.push(`decision_quote_observed_ignored:${decisionQuoteObservedIgnoredRatePct.toFixed(1)}%>${decisionQuoteIgnoredGateThresholdPct.toFixed(1)}%`);
  }
  if (input.partialData) {
    degradedReasons.push("partial_data");
  }

  const verdict: TruthVerdict = blockers.length > 0
    ? "BLOCKED"
    : degradedReasons.length > 0
      ? "DEGRADED"
      : "READY";
  const summary = verdict === "READY"
    ? "Runtime truth READY: no canonical blocker detected."
    : verdict === "DEGRADED"
      ? `Runtime truth DEGRADED: ${degradedReasons.join(", ") || "partial data"}.`
      : `Runtime truth BLOCKED: ${blockers.join(", ")}.`;
  return { verdict, blockers, degradedReasons, summary };
}

function cacheKey(input: Required<RuntimeTruthInput>): string {
  return [input.symbol, input.marketInstrument, input.timeframe, input.strategy].join("::");
}

export type RuntimeTruthInput = {
  symbol?: string;
  marketInstrument?: string;
  timeframe?: string;
  strategy?: string;
  bypassCache?: boolean;
  allowStaleOnMiss?: boolean;
};

function normalizeRuntimeTruthInput(options: RuntimeTruthInput = {}): Required<RuntimeTruthInput> {
  return {
    symbol: String(options.symbol || "DESK").trim().toUpperCase() || "DESK",
    marketInstrument: String(options.marketInstrument || options.symbol || "BTCUSDT").trim().toUpperCase() || "BTCUSDT",
    timeframe: String(options.timeframe || "live").trim() || "live",
    strategy: String(options.strategy || "live-ops").trim() || "live-ops",
    bypassCache: Boolean(options.bypassCache),
    allowStaleOnMiss: Boolean(options.allowStaleOnMiss),
  };
}

function snapshotAgeMs(snapshot: RuntimeTruthSnapshot): number | null {
  const generatedAtMs = parseIsoMs(snapshot.generated_at);
  if (generatedAtMs === null) {
    return null;
  }
  return Math.max(0, Date.now() - generatedAtMs);
}

function isFreshEntry(entry: RuntimeTruthCacheEntry): boolean {
  const ageMs = snapshotAgeMs(entry.snapshot);
  if (ageMs === null) {
    return Date.now() - entry.createdAtMs <= RUNTIME_TRUTH_CACHE_MS;
  }
  return ageMs <= RUNTIME_TRUTH_CACHE_MS;
}

function snapshotFileName(input: Required<RuntimeTruthInput>): string {
  const parts = [input.symbol, input.marketInstrument, input.timeframe, input.strategy]
    .map((part) => String(part).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "default");
  return `mission-control-runtime-truth-${parts.join("-")}.json`;
}

function snapshotFilePath(input: Required<RuntimeTruthInput>): string {
  const snapshotDir = process.env.RUNTIME_TRUTH_SNAPSHOT_DIR || path.resolve(process.cwd(), "../../logs");
  return path.join(snapshotDir, snapshotFileName(input));
}

function normalizeCachedSnapshot(raw: unknown): RuntimeTruthSnapshot | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const payload = raw as Partial<RuntimeTruthSnapshot>;
  if (payload.schema_version !== "runtime-truth/v1") {
    return null;
  }
  if (typeof payload.generated_at !== "string" || !payload.generated_at.trim()) {
    return null;
  }
  return payload as RuntimeTruthSnapshot;
}

async function readSnapshotFromDisk(input: Required<RuntimeTruthInput>): Promise<RuntimeTruthCacheEntry | null> {
  const filePath = snapshotFilePath(input);
  try {
    const metadata = await fs.stat(filePath);
    const content = await fs.readFile(filePath, "utf8");
    const snapshot = normalizeCachedSnapshot(JSON.parse(content) as unknown);
    if (!snapshot) {
      return null;
    }
    const entry = {
      createdAtMs: metadata.mtimeMs,
      snapshot,
    };
    runtimeTruthCache.set(cacheKey(input), entry);
    return entry;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    return null;
  }
}

async function readCachedSnapshotEntry(input: Required<RuntimeTruthInput>): Promise<RuntimeTruthCacheEntry | null> {
  const key = cacheKey(input);
  const cached = runtimeTruthCache.get(key);
  if (cached) {
    return cached;
  }
  return readSnapshotFromDisk(input);
}

async function persistSnapshot(input: Required<RuntimeTruthInput>, snapshot: RuntimeTruthSnapshot): Promise<void> {
  const filePath = snapshotFilePath(input);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempFilePath = `${filePath}.tmp`;
  await fs.writeFile(tempFilePath, JSON.stringify(snapshot), "utf8");
  await fs.rename(tempFilePath, filePath);
}

function buildUnavailableRuntimeTruthSnapshot(input: Required<RuntimeTruthInput>): RuntimeTruthSnapshot {
  const generatedAt = new Date().toISOString();
  return {
    schema_version: "runtime-truth/v1",
    generated_at: generatedAt,
    source_diagnostics: {
      rows_scanned: 0,
      rows_returned: 0,
    },
    scope: {
      symbol: input.symbol,
      market_instrument: input.marketInstrument,
      timeframe: input.timeframe,
      strategy: input.strategy,
    },
    verdict: "DEGRADED",
    summary: "Runtime truth snapshot warming: last known snapshot unavailable.",
    blockers: [],
    degraded_reasons: ["snapshot_refresh_inflight", "partial_data"],
    degraded: true,
    partial_data: true,
    layers: {
      market: {},
      execution: {},
      broker_reality: {},
      quote_reality: {},
      decision_reality: {},
      health: {},
      routing: {},
      readiness: {},
      settlement: {},
      publication: {
        partial_data: true,
        generated_at: generatedAt,
        cache_ttl_ms: RUNTIME_TRUTH_CACHE_MS,
      },
      watchdog: {
        status: "WARNING",
        blockers: [],
        degraded_reasons: ["snapshot_refresh_inflight", "partial_data"],
        partial_data: true,
      },
      observation: {
        controlled_collection_phase: "UNAVAILABLE",
        active: false,
        watch_stale: true,
        watch_age_minutes: null,
        kill_switch_source: "unavailable",
        fills_seen: 0,
        labels_seen: 0,
        edge_evidence_state: "UNAVAILABLE",
        edge_evidence_available: false,
        mature_cells: 0,
        replicated_cells: 0,
        cell_count: 0,
        outcomes_with_both: 0,
        edge_evidence_summary: "Runtime truth snapshot warming.",
        edge_evidence_next_gate: defaultEdgeEvidenceState().nextGate,
        edge_evidence_top_cells: [],
      },
    },
    raw: {
      kill_switch: null,
      system_config: null,
      opportunity_gate: null,
      market_session: null,
      mt5_health: null,
      settlement_truth: null,
      runtime_decision: null,
      controlled_collection: defaultControlledCollectionSummary(),
      edge_evidence: defaultEdgeEvidenceState(),
      broker_reality: {},
      quote_reality: {},
      decision_reality: {},
      network: {},
    },
  };
}

export async function inspectRuntimeTruthCache(options: RuntimeTruthInput = {}): Promise<RuntimeTruthCacheAudit> {
  const input = normalizeRuntimeTruthInput(options);
  const cached = input.bypassCache ? null : await readCachedSnapshotEntry(input);
  const ageMs = cached ? snapshotAgeMs(cached.snapshot) : null;
  const cacheHit = Boolean(cached && isFreshEntry(cached));
  return {
    cache_hit: cacheHit ? 1 : 0,
    cache_miss: cacheHit ? 0 : 1,
    age_ms: ageMs,
    stale: Boolean(cached && !cacheHit),
    last_generated_at: cached?.snapshot.generated_at || null,
  };
}

async function refreshSnapshot(input: Required<RuntimeTruthInput>): Promise<RuntimeTruthSnapshot> {
  const key = cacheKey(input);
  let inflight = runtimeTruthInflight.get(key);
  if (!inflight) {
    inflight = buildRuntimeTruthSnapshotUncached(input)
      .then(async (snapshot) => {
        runtimeTruthCache.set(key, { createdAtMs: Date.now(), snapshot });
        await persistSnapshot(input, snapshot);
        return snapshot;
      })
      .finally(() => {
        runtimeTruthInflight.delete(key);
      });
    runtimeTruthInflight.set(key, inflight);
  }
  return inflight;
}

async function buildRuntimeTruthSnapshotUncached(input: Required<RuntimeTruthInput>): Promise<RuntimeTruthSnapshot> {
  const generatedAt = new Date().toISOString();
  const runtimeDecisionScope = input.symbol === "DESK"
    ? {}
    : {
        symbol: input.symbol,
        timeframe: input.timeframe,
        strategy: input.strategy,
      };
  const edgeEvidenceFallback: RuntimeEdgeEvidenceState = {
    available: false,
    state: "UNAVAILABLE",
    summary: "Edge evidence maturity snapshot timed out.",
    filePath: "",
    fileUpdatedAt: null,
    matureThresholdEvents: 3,
    cellCount: 0,
    replicatedCells: 0,
    matureCells: 0,
    outcomesWithBoth: 0,
    maxCellEventCount: 0,
    nextGate: {
      name: "UNAVAILABLE",
      targetState: "UNKNOWN",
      condition: "edge evidence maturity snapshot available",
      summary: "Edge evidence maturity snapshot timed out.",
      candidateCells: [],
    },
    topCells: [],
  };
  const [killSwitchResult, systemConfigResult, gateResult, marketSessionResult, mt5HealthResult, mt5AccountsResult, mt5RiskHistoryResult, mt5BridgeQuoteResult, spreadDecisionTraceResult, telemetryRecentResult, realityGapRecentResult, settlementTruthResult, controlledCollection, edgeEvidence, runtimeDecision, spreadDecisionTraceSummaryFile] = await Promise.all([
    cpFetchBounded("/v1/system/kill-switch"),
    cpFetchBounded("/v1/system/config"),
    cpFetchBounded("/v1/system/opportunity-gate"),
    cpFetchBounded(`/v1/market/session-state?instrument=${encodeURIComponent(input.marketInstrument)}`),
    cpFetchBounded("/v1/mt5/health"),
    cpFetchBounded("/v1/mt5/accounts"),
    cpFetchBounded("/v1/mt5/orders/risk-history?limit=120"),
    cpFetchBounded("/v1/mt5/accounts/541283177/quote/BTCUSD"),
    cpFetchBounded("/v1/mt5/orders/spread-decision-trace/summary?lookback_hours=168&limit=2500"),
    cpFetchBounded("/v1/execution/telemetry/recent?limit=120"),
    cpFetchBounded("/v1/execution/reality-gap/recent?limit=120"),
    cpFetchBounded("/v1/settlement/truth", RUNTIME_TRUTH_SETTLEMENT_TIMEOUT_MS, "service"),
    getControlledCollectionSessionSummary().catch(() => null),
    withTimeout(getRuntimeEdgeEvidenceState().catch(() => edgeEvidenceFallback), RUNTIME_TRUTH_EDGE_EVIDENCE_TIMEOUT_MS, edgeEvidenceFallback),
    withTimeout(
      getRuntimeDecisionAnalytics({
        ...runtimeDecisionScope,
        limit: 600,
        sinceDays: 7,
        samples: 1,
      }).catch(() => null),
      RUNTIME_TRUTH_ANALYTICS_TIMEOUT_MS,
      null,
    ),
    loadLatestSpreadDecisionTraceSummary().catch(() => null),
  ]);

  const killSwitchPayload = asRecord(killSwitchResult.payload);
  const killSwitchState = asRecord(killSwitchPayload.state || killSwitchPayload);
  const systemConfig = asRecord(systemConfigResult.payload);
  const gatePayload = asRecord(gateResult.payload);
  const gateState = asRecord(gatePayload.gate || gatePayload);
  const marketSession = asRecord(marketSessionResult.payload);
  const mt5Health = asRecord(mt5HealthResult.payload);
  const mt5Accounts = asArray<JsonMap>(mt5AccountsResult.payload);
  const mt5RiskHistory = asArray<JsonMap>(mt5RiskHistoryResult.payload);
  const mt5BridgeQuote = mt5BridgeQuoteResult.response.ok ? asRecord(mt5BridgeQuoteResult.payload) : {};
  const spreadDecisionTrace = asRecord(spreadDecisionTraceResult.payload);
  const spreadDecisionTraceFile = asRecord(spreadDecisionTraceSummaryFile);
  const telemetryRecent = asArray<JsonMap>(telemetryRecentResult.payload);
  const realityGapPayload = asRecord(realityGapRecentResult.payload);
  const realityGapRecent = asArray<JsonMap>(realityGapPayload.rows);
  const settlementTruth = asRecord(settlementTruthResult.payload);
  const controlled = controlledCollection || {
    available: false,
    active: false,
    baselineSince: null,
    openedAt: null,
    lastSnapshotAt: null,
    durationMinutes: 0,
    cycles: 0,
    phase: "UNAVAILABLE",
    fillsSeen: 0,
    labelsSeen: 0,
    killSwitchRearmed: false,
    killSwitchActive: false,
    killSwitchReason: null,
    killSwitchSource: "unavailable" as const,
    watchStale: true,
    watchAgeMinutes: null,
    gateStatus: null,
    gateHealthScore: null,
    latestFillAt: null,
    latestLabeledAt: null,
    archivePath: "",
    statePath: "",
  };

  const network = {
    kill_switch: killSwitchResult.network,
    system_config: systemConfigResult.network,
    opportunity_gate: gateResult.network,
    market_session: marketSessionResult.network,
    mt5_health: mt5HealthResult.network,
    mt5_accounts: mt5AccountsResult.network,
    mt5_risk_history: mt5RiskHistoryResult.network,
    mt5_spread_decision_trace: spreadDecisionTraceResult.network,
      mt5_bridge_quote: mt5BridgeQuoteResult.network,
    execution_telemetry_recent: telemetryRecentResult.network,
    execution_reality_gap_recent: realityGapRecentResult.network,
    settlement_truth: settlementTruthResult.network,
  };
  const partialData = Object.values(network).some((item) => item.degraded_flag) || runtimeDecision === null || controlled.phase === "UNAVAILABLE";
  const sourceRowsScanned = 15
    + mt5Accounts.length
    + mt5RiskHistory.length
    + telemetryRecent.length
    + realityGapRecent.length
    + (Object.keys(settlementTruth).length > 0 ? 1 : 0)
    + (runtimeDecision ? 1 : 0)
    + (Object.keys(spreadDecisionTraceFile).length > 0 ? 1 : 0);
  const killSwitchActive = Boolean(killSwitchState.active);
  const gateStatusRaw = String(gateState.status || "").trim().toLowerCase();
  const gateKnown = typeof gateState.opportunity_enabled === "boolean" || Boolean(gateStatusRaw);
  const gateEnabled = gateKnown
    ? typeof gateState.opportunity_enabled === "boolean"
      ? Boolean(gateState.opportunity_enabled)
      : gateStatusRaw === "go"
    : true;
  const marketOpen = typeof marketSession.market_open === "boolean" ? Boolean(marketSession.market_open) : true;
  const marketReason = String(marketSession.market_status_reason || "unknown");
  const mt5Degraded = !mt5HealthResult.response.ok || Boolean(mt5Health.degraded) || Boolean(mt5Health.error);
  const controlledWatchStale = Boolean(controlled.watchStale);
  const mt5TelemetryRows = telemetryRecent.filter((row) => isMt5Row(asRecord(row)));
  const ackCount = mt5TelemetryRows.filter((row) => Boolean((asRecord(row)).ts_broker_accept)).length;
  const fillRows = mt5TelemetryRows.filter((row) => Boolean((asRecord(row)).ts_fill_final));
  const fillCount = fillRows.length;
  const slippageSeries = mt5TelemetryRows
    .map((row) => toNullableNumber((asRecord(row)).realized_slippage_bps))
    .filter((value): value is number => value !== null);
  const latencySeries = mt5TelemetryRows
    .map((row) => toNullableNumber((asRecord(row)).latency_e2e_ms))
    .filter((value): value is number => value !== null);
  const lastFillIso = fillRows
    .map((row) => toIsoStringOrNull((asRecord(row)).ts_fill_final))
    .filter((value): value is string => Boolean(value))
    .sort();
  const lastFillIsoValue = lastFillIso.length > 0 ? lastFillIso[lastFillIso.length - 1] : null;
  const mt5AcceptedOrders = mt5RiskHistory.filter((row) => String((asRecord(row)).category || "") === "mt5_order_accepted").length;
  const mt5OrderAttempts = mt5RiskHistory.filter((row) => String((asRecord(row)).category || "").startsWith("mt5_order_")).length;
  const brokerAckRate = mt5TelemetryRows.length > 0
    ? ackCount / mt5TelemetryRows.length
    : mt5OrderAttempts > 0
      ? mt5AcceptedOrders / mt5OrderAttempts
      : 0;
  const fillRate = mt5TelemetryRows.length > 0 ? fillCount / mt5TelemetryRows.length : 0;
  const bridgeReachable = mt5HealthResult.response.ok || mt5HealthResult.response.status === 401;
  const brokerReality = {
    broker_ack_rate: brokerAckRate,
    fill_rate: fillRate,
    broker_latency_ms: average(latencySeries),
    slippage_bps: average(slippageSeries),
    reality_gap_samples: realityGapRecent.length,
    last_real_fill_at: lastFillIsoValue,
    last_real_fill_age_minutes: elapsedMinutesSince(lastFillIsoValue),
    mt5_orders_seen: mt5OrderAttempts,
    mt5_orders_accepted: mt5AcceptedOrders,
    state: brokerRealityState({
      edgeState: edgeEvidence.state,
      bridgeReachable,
      ackCount,
      fillCount,
      realityGapSamples: realityGapRecent.length,
    }),
  };

  const mt5HealthAccountId = String(mt5Health.account_id || mt5Health.account || "").trim();
  const preferredMt5AccountId = mt5HealthAccountId || "541283177";
  const selectedMt5Account = mt5Accounts.find((row) => String(asRecord(row).account_id || "").trim() === preferredMt5AccountId)
    || mt5Accounts.find((row) => String(asRecord(row).status || "").trim().toLowerCase() === "connected")
    || mt5Accounts[0]
    || {};
  const selectedMt5 = asRecord(selectedMt5Account);
  const selectedMt5Metadata = asRecord(selectedMt5.metadata);
  const selectedBrokerState = asRecord(selectedMt5Metadata.broker_state);
  const selectedBrokerRuntimeSession = asRecord(selectedMt5Metadata.broker_runtime_session);

  const brokerPayload = Object.keys(mt5BridgeQuote).length > 0
    ? mt5BridgeQuote
    : Object.keys(selectedBrokerState).length > 0
      ? selectedBrokerState
      : selectedBrokerRuntimeSession;
  const brokerBid = findNestedNumber(
    brokerPayload,
    ["bid", "best_bid", "bid_price", "bid1", "bid1Price"],
  );
  const brokerAsk = findNestedNumber(
    brokerPayload,
    ["ask", "best_ask", "ask_price", "ask1", "ask1Price"],
  );
  const midpoint = brokerBid !== null && brokerAsk !== null && brokerBid > 0 && brokerAsk > 0
    ? (brokerBid + brokerAsk) / 2
    : null;
  const spreadAbsolute = brokerBid !== null && brokerAsk !== null ? (brokerAsk - brokerBid) : null;
  const brokerSpreadBps = findNestedNumber(
     brokerPayload,
    ["spread_bps", "spreadBps"],
  ) ?? (spreadAbsolute !== null && midpoint !== null && midpoint > 0 ? (spreadAbsolute / midpoint) * 10000 : null);
  const quoteReality = {
    state: quoteRealityState({ bid: brokerBid, ask: brokerAsk, spreadBps: brokerSpreadBps }),
    broker_bid: brokerBid,
    broker_ask: brokerAsk,
    broker_spread_bps: brokerSpreadBps,
    broker_spread_absolute: spreadAbsolute,
    broker_quote_visible: brokerBid !== null || brokerAsk !== null || brokerSpreadBps !== null,
      broker_quote_surface: Object.keys(mt5BridgeQuote).length > 0
        ? "bridge_quote_api"
        : Object.keys(selectedBrokerState).length > 0
          ? "broker_state"
          : Object.keys(selectedBrokerRuntimeSession).length > 0
            ? "broker_runtime_session"
            : "missing",
      broker_quote_observed_at: toIsoStringOrNull(mt5BridgeQuote.tick_time)
        || toIsoStringOrNull(selectedMt5Metadata.broker_state_updated_at)
        || toIsoStringOrNull(selectedBrokerRuntimeSession.last_heartbeat_at),
    account_id: String(selectedMt5.account_id || preferredMt5AccountId || "").trim() || null,
    truth_source: String(selectedMt5Metadata.truth_source || selectedMt5Metadata.source || "").trim() || null,
  };

  const spreadDecisionTraceSource = toNumber(spreadDecisionTrace.sample_count, 0) > 0 ? spreadDecisionTrace : spreadDecisionTraceFile;
  const spreadTraceSampleCount = Math.max(
    toNumber(spreadDecisionTraceSource.sample_count, 0),
    toNumber(spreadDecisionTraceSource.rows, 0),
  );
  const spreadTracePolicyOnlyRate = toNullableNumber(spreadDecisionTraceSource.policy_only_rate_pct);
  const spreadTraceSpreadLiveUsedRate = toNullableNumber(spreadDecisionTraceSource.spread_live_used_rate_pct);
  const spreadTraceDecisionQuoteCoverageRate = toNullableNumber(spreadDecisionTraceSource.decision_quote_coverage_pct);
  const spreadTraceDecisionQuoteObservedIgnoredRate = toNullableNumber(spreadDecisionTraceSource.decision_quote_observed_ignored_rate_pct);
  const spreadTraceDecisionQuoteIgnoredGateThreshold = toNullableNumber(spreadDecisionTraceSource.decision_quote_ignored_gate_threshold_pct);
  const spreadTraceDecisionQuoteIgnoredGateAlert = Boolean(spreadDecisionTraceSource.decision_quote_ignored_gate_alert);
  const spreadTraceDecisionQuoteIgnoredPathThreshold = toNullableNumber(spreadDecisionTraceSource.decision_quote_ignored_path_threshold_pct);
  const spreadTraceDecisionQuoteIgnoredPathAlerts = asArray<{
    decision_path?: string;
    total_rows?: number;
    ignored_rows?: number;
    ignored_rate_pct?: number | null;
    threshold_pct?: number | null;
    alert?: boolean;
  }>(spreadDecisionTraceSource.decision_quote_ignored_path_alerts)
    .slice(0, 50)
    .map((item) => ({
      decision_path: String(item?.decision_path || "").trim() || "unknown_path",
      total_rows: toNumber(item?.total_rows, 0),
      ignored_rows: toNumber(item?.ignored_rows, 0),
      ignored_rate_pct: toNullableNumber(item?.ignored_rate_pct),
      threshold_pct: toNullableNumber(item?.threshold_pct),
      alert: Boolean(item?.alert),
    }))
    .filter((item) => item.total_rows > 0);
  const spreadTraceDecisionQuoteIgnoredPathReasonThreshold = toNullableNumber(spreadDecisionTraceSource.decision_quote_ignored_path_reason_threshold_pct);
  const spreadTraceDecisionQuoteIgnoredPathReasonImpactThresholdPctPoints = toNullableNumber(
    spreadDecisionTraceSource.decision_quote_ignored_path_reason_impact_threshold_pct_points,
  );
  const spreadTraceDecisionQuoteIgnoredPathReasonAlerts = asArray<{
    decision_path?: string;
    decision_reason?: string;
    total_rows?: number;
    ignored_rows?: number;
    ignored_rate_pct?: number | null;
    volume_share_pct?: number | null;
    impact_pct_points?: number | null;
    threshold_pct?: number | null;
    impact_threshold_pct_points?: number | null;
    ignored_rate_alert?: boolean;
    impact_alert?: boolean;
    alert?: boolean;
  }>(spreadDecisionTraceSource.decision_quote_ignored_path_reason_alerts)
    .slice(0, 50)
    .map((item) => ({
      decision_path: String(item?.decision_path || "").trim() || "unknown_path",
      decision_reason: String(item?.decision_reason || "").trim() || "n/a",
      total_rows: toNumber(item?.total_rows, 0),
      ignored_rows: toNumber(item?.ignored_rows, 0),
      ignored_rate_pct: toNullableNumber(item?.ignored_rate_pct),
      volume_share_pct: toNullableNumber(item?.volume_share_pct),
      impact_pct_points: toNullableNumber(item?.impact_pct_points),
      threshold_pct: toNullableNumber(item?.threshold_pct),
      impact_threshold_pct_points: toNullableNumber(item?.impact_threshold_pct_points),
      ignored_rate_alert: Boolean(item?.ignored_rate_alert),
      impact_alert: Boolean(item?.impact_alert),
      alert: Boolean(item?.alert),
    }))
    .filter((item) => item.total_rows > 0);
  const spreadTraceDecisionQuoteCoveredRows = toNumber(spreadDecisionTraceSource.decision_quote_covered_rows, 0);
  const spreadTraceDecisionQuoteUncoveredRows = toNumber(spreadDecisionTraceSource.decision_quote_uncovered_rows, 0);
  const spreadTraceDecisionQuoteObservedIgnoredRows = toNumber(spreadDecisionTraceSource.decision_quote_observed_ignored_rows, 0);
  const spreadTraceDecisionQuoteCoverageBreakdown = asArray<{
    key?: string;
    label?: string;
    count?: number;
    share_pct?: number | null;
  }>(spreadDecisionTraceSource.decision_quote_coverage_breakdown)
    .slice(0, 8)
    .map((item) => ({
      key: String(item?.key || "").trim(),
      label: String(item?.label || "").trim() || "n/a",
      count: toNumber(item?.count, 0),
      share_pct: toNullableNumber(item?.share_pct),
    }))
    .filter((item) => item.key.length > 0 || item.label !== "n/a");
  const spreadTraceDecisionQuoteIgnoredDrilldown = asArray<{
    decision_path?: string;
    source?: string;
    decision_reason?: string;
    count?: number;
    share_pct?: number | null;
    share_total_pct?: number | null;
    recent_decision_ids?: string[];
  }>(spreadDecisionTraceSource.decision_quote_ignored_drilldown)
    .slice(0, 25)
    .map((item) => ({
      decision_path: String(item?.decision_path || "").trim() || "unknown_path",
      source: String(item?.source || "").trim() || "unknown_source",
      decision_reason: String(item?.decision_reason || "").trim() || "n/a",
      count: toNumber(item?.count, 0),
      share_pct: toNullableNumber(item?.share_pct),
      share_total_pct: toNullableNumber(item?.share_total_pct),
      recent_decision_ids: asArray<string>(item?.recent_decision_ids).map((value) => String(value || "").trim()).filter(Boolean).slice(0, 5),
    }))
    .filter((item) => item.count > 0);
  const spreadTraceDecisionQuoteIgnoredReasonBreakdown = asArray<{
    reason?: string;
    count?: number;
    share_pct?: number | null;
  }>(spreadDecisionTraceSource.decision_quote_ignored_reason_breakdown)
    .slice(0, 12)
    .map((item) => ({
      reason: String(item?.reason || "").trim() || "n/a",
      count: toNumber(item?.count, 0),
      share_pct: toNullableNumber(item?.share_pct),
    }))
    .filter((item) => item.count > 0);
  const spreadTraceDecisionQuoteTopRemediationCandidates = asArray<{
    decision_path?: string;
    decision_reason?: string;
    ignored_rows?: number;
    total_rows?: number;
    ignored_rate_pct?: number | null;
    volume_share_pct?: number | null;
    impact_pct_points?: number | null;
    threshold_pct?: number | null;
    impact_threshold_pct_points?: number | null;
    ignored_rate_alert?: boolean;
    impact_alert?: boolean;
    alert?: boolean;
    suggested_action?: string;
    top_sources?: Array<{ source?: string; count?: number; share_pct?: number | null }>;
  }>(spreadDecisionTraceSource.decision_quote_top_remediation_candidates)
    .slice(0, 6)
    .map((item) => ({
      decision_path: String(item?.decision_path || "").trim() || "unknown_path",
      decision_reason: String(item?.decision_reason || "").trim() || "n/a",
      ignored_rows: toNumber(item?.ignored_rows, 0),
      total_rows: toNumber(item?.total_rows, 0),
      ignored_rate_pct: toNullableNumber(item?.ignored_rate_pct),
      volume_share_pct: toNullableNumber(item?.volume_share_pct),
      impact_pct_points: toNullableNumber(item?.impact_pct_points),
      threshold_pct: toNullableNumber(item?.threshold_pct),
      impact_threshold_pct_points: toNullableNumber(item?.impact_threshold_pct_points),
      ignored_rate_alert: Boolean(item?.ignored_rate_alert),
      impact_alert: Boolean(item?.impact_alert),
      alert: Boolean(item?.alert),
      suggested_action: String(item?.suggested_action || "").trim() || "Inspect routing condition.",
      top_sources: asArray<{ source?: string; count?: number; share_pct?: number | null }>(item?.top_sources)
        .slice(0, 3)
        .map((sourceItem) => ({
          source: String(sourceItem?.source || "").trim() || "unknown_source",
          count: toNumber(sourceItem?.count, 0),
          share_pct: toNullableNumber(sourceItem?.share_pct),
        }))
        .filter((sourceItem) => sourceItem.count > 0),
    }))
    .filter((item) => item.ignored_rows > 0);
  const spreadTraceDecisionQuoteCoverageBreakdownTrend = asRecord(spreadDecisionTraceSource.decision_quote_coverage_breakdown_trend);
  const spreadTraceDecisionQuoteTopUncoveredReasons = asArray<{ reason?: string; count?: number; share_pct?: number | null }>(spreadDecisionTraceSource.decision_quote_top_uncovered_reasons)
    .slice(0, 5)
    .map((item) => ({
      reason: String(item?.reason || "").trim(),
      count: toNumber(item?.count, 0),
      share_pct: toNullableNumber(item?.share_pct),
    }))
    .filter((item) => Boolean(item.reason));
  const spreadTraceStateRaw = String(spreadDecisionTraceSource.decision_reality_state || "").trim().toUpperCase();
  const spreadTraceLastAudit = toIsoStringOrNull(spreadDecisionTraceSource.last_audit)
    || toIsoStringOrNull(spreadDecisionTraceSource.generated_at);
  const spreadTraceHasPartialObservedRate = spreadTraceSpreadLiveUsedRate !== null
    && spreadTraceSpreadLiveUsedRate > 0
    && spreadTraceSpreadLiveUsedRate < 100;
  const spreadTraceStateDerived: DecisionRealityState = spreadTraceStateRaw === "POLICY_ONLY"
    ? "POLICY_ONLY"
    : spreadTraceStateRaw === "PARTIAL_QUOTE_AWARE" || spreadTraceStateRaw === "TRANSITIONING"
      ? "PARTIAL_QUOTE_AWARE"
    : spreadTraceStateRaw === "OBSERVED" && spreadTraceHasPartialObservedRate
      ? "PARTIAL_QUOTE_AWARE"
    : spreadTraceStateRaw === "OBSERVED"
      ? "OBSERVED"
      : spreadTraceSampleCount > 0 && spreadTracePolicyOnlyRate !== null && spreadTracePolicyOnlyRate >= 99
        ? "POLICY_ONLY"
        : spreadTraceSampleCount > 0 && spreadTraceSpreadLiveUsedRate !== null && spreadTraceSpreadLiveUsedRate > 0 && spreadTraceSpreadLiveUsedRate < 100
          ? "PARTIAL_QUOTE_AWARE"
          : spreadTraceSampleCount > 0 && spreadTraceSpreadLiveUsedRate !== null && spreadTraceSpreadLiveUsedRate >= 100
            ? "OBSERVED"
            : "UNKNOWN";
  const decisionReality: {
    state: DecisionRealityState;
    spread_decision_source: string;
    sample_count: number;
    policy_only_rate_pct: number | null;
    spread_live_used_rate_pct: number | null;
    decision_quote_coverage_pct: number | null;
    decision_quote_observed_ignored_rows: number;
    decision_quote_observed_ignored_rate_pct: number | null;
    decision_quote_ignored_gate_threshold_pct: number | null;
    decision_quote_ignored_gate_alert: boolean;
    decision_quote_ignored_path_threshold_pct: number | null;
    decision_quote_ignored_path_alerts: Array<{ decision_path: string; total_rows: number; ignored_rows: number; ignored_rate_pct: number | null; threshold_pct: number | null; alert: boolean }>;
    decision_quote_ignored_path_reason_threshold_pct: number | null;
    decision_quote_ignored_path_reason_impact_threshold_pct_points: number | null;
    decision_quote_ignored_path_reason_alerts: Array<{ decision_path: string; decision_reason: string; total_rows: number; ignored_rows: number; ignored_rate_pct: number | null; volume_share_pct: number | null; impact_pct_points: number | null; threshold_pct: number | null; impact_threshold_pct_points: number | null; ignored_rate_alert: boolean; impact_alert: boolean; alert: boolean }>;
    decision_quote_top_remediation_candidates: Array<{ decision_path: string; decision_reason: string; ignored_rows: number; total_rows: number; ignored_rate_pct: number | null; volume_share_pct: number | null; impact_pct_points: number | null; threshold_pct: number | null; impact_threshold_pct_points: number | null; ignored_rate_alert: boolean; impact_alert: boolean; alert: boolean; suggested_action: string; top_sources: Array<{ source: string; count: number; share_pct: number | null }> }>;
    decision_quote_covered_rows: number;
    decision_quote_uncovered_rows: number;
    decision_quote_coverage_breakdown: Array<{ key: string; label: string; count: number; share_pct: number | null }>;
    decision_quote_ignored_drilldown: Array<{ decision_path: string; source: string; decision_reason: string; count: number; share_pct: number | null; share_total_pct: number | null; recent_decision_ids: string[] }>;
    decision_quote_ignored_reason_breakdown: Array<{ reason: string; count: number; share_pct: number | null }>;
    decision_quote_coverage_breakdown_trend: JsonMap;
    decision_quote_top_uncovered_reasons: Array<{ reason: string; count: number; share_pct: number | null }>;
    diagnostic: string;
    last_audit: string | null;
    next_gate: string;
  } = {
    state: spreadTraceStateDerived,
    spread_decision_source: spreadTraceStateDerived === "POLICY_ONLY"
      ? "policy_only"
      : spreadTraceStateDerived === "PARTIAL_QUOTE_AWARE"
        ? "partial_quote_aware"
      : spreadTraceStateDerived === "OBSERVED"
        ? "observed"
        : "unknown",
    sample_count: spreadTraceSampleCount,
    policy_only_rate_pct: spreadTracePolicyOnlyRate,
    spread_live_used_rate_pct: spreadTraceSpreadLiveUsedRate,
    decision_quote_coverage_pct: spreadTraceDecisionQuoteCoverageRate,
    decision_quote_observed_ignored_rows: spreadTraceDecisionQuoteObservedIgnoredRows,
    decision_quote_observed_ignored_rate_pct: spreadTraceDecisionQuoteObservedIgnoredRate,
    decision_quote_ignored_gate_threshold_pct: spreadTraceDecisionQuoteIgnoredGateThreshold,
    decision_quote_ignored_gate_alert: spreadTraceDecisionQuoteIgnoredGateAlert,
    decision_quote_ignored_path_threshold_pct: spreadTraceDecisionQuoteIgnoredPathThreshold,
    decision_quote_ignored_path_alerts: spreadTraceDecisionQuoteIgnoredPathAlerts,
    decision_quote_ignored_path_reason_threshold_pct: spreadTraceDecisionQuoteIgnoredPathReasonThreshold,
    decision_quote_ignored_path_reason_impact_threshold_pct_points: spreadTraceDecisionQuoteIgnoredPathReasonImpactThresholdPctPoints,
    decision_quote_ignored_path_reason_alerts: spreadTraceDecisionQuoteIgnoredPathReasonAlerts,
    decision_quote_top_remediation_candidates: spreadTraceDecisionQuoteTopRemediationCandidates,
    decision_quote_covered_rows: spreadTraceDecisionQuoteCoveredRows,
    decision_quote_uncovered_rows: spreadTraceDecisionQuoteUncoveredRows,
    decision_quote_coverage_breakdown: spreadTraceDecisionQuoteCoverageBreakdown,
    decision_quote_ignored_drilldown: spreadTraceDecisionQuoteIgnoredDrilldown,
    decision_quote_ignored_reason_breakdown: spreadTraceDecisionQuoteIgnoredReasonBreakdown,
    decision_quote_coverage_breakdown_trend: spreadTraceDecisionQuoteCoverageBreakdownTrend,
    decision_quote_top_uncovered_reasons: spreadTraceDecisionQuoteTopUncoveredReasons,
    diagnostic: spreadTraceSampleCount > 0
      ? `Coverage ${(spreadTraceDecisionQuoteCoverageRate ?? 0).toFixed(2)}% · covered ${spreadTraceDecisionQuoteCoveredRows} · uncovered ${spreadTraceDecisionQuoteUncoveredRows}`
      : "Decision reality coverage unavailable.",
    last_audit: spreadTraceLastAudit,
    next_gate: spreadTraceStateDerived === "POLICY_ONLY"
      ? "DECISION_REALITY_PARTIAL_QUOTE_AWARE"
      : spreadTraceStateDerived === "PARTIAL_QUOTE_AWARE"
        ? "DECISION_REALITY_OBSERVED"
        : spreadTraceStateDerived === "OBSERVED"
          ? spreadTraceDecisionQuoteCoverageRate !== null && spreadTraceDecisionQuoteCoverageRate >= 100
            ? "BROKER_REALITY_ACK_VALIDATED"
            : "DECISION_REALITY_QUOTE_COVERAGE_COMPLETE"
          : "QUOTE_REALITY_OBSERVED",
  };

  const runtimeReliability = asRecord(runtimeDecision?.reliability);
  const verdict = deriveVerdict({
    killSwitchActive,
    gateKnown,
    gateEnabled,
    marketOpen,
    marketReason,
    runtimeDecision,
    runtimeReliabilityBlocked: Boolean(runtimeReliability.blocked),
    mt5Degraded,
    controlledWatchStale,
    edgeEvidenceState: edgeEvidence.state,
    brokerRealityState: brokerReality.state,
    quoteRealityState: quoteReality.state,
    decisionRealityState: decisionReality.state,
    decisionQuoteCoveragePct: decisionReality.decision_quote_coverage_pct,
    decisionQuoteObservedIgnoredRatePct: decisionReality.decision_quote_observed_ignored_rate_pct,
    decisionQuoteIgnoredGateThresholdPct: decisionReality.decision_quote_ignored_gate_threshold_pct,
    partialData,
  });
  const backendMode = String(systemConfig.system_mode || "guarded_auto");
  const runtimeSummary = runtimeDecision?.deskRead?.summary || "runtime decision unavailable";
  const gateReasons = asArray<string>(gateState.reasons);

  return {
    schema_version: "runtime-truth/v1",
    generated_at: generatedAt,
    source_diagnostics: {
      rows_scanned: sourceRowsScanned,
      rows_returned: 1,
    },
    scope: {
      symbol: input.symbol,
      market_instrument: input.marketInstrument,
      timeframe: input.timeframe,
      strategy: input.strategy,
    },
    verdict: verdict.verdict,
    summary: verdict.summary,
    blockers: verdict.blockers,
    degraded_reasons: verdict.degradedReasons,
    degraded: verdict.verdict !== "READY",
    partial_data: partialData,
    layers: {
      market: {
        status: marketOpen ? "OPEN" : "CLOSED",
        reason: marketReason,
        session: String(marketSession.session || "unknown"),
        next_open_at: marketSession.next_market_open_at || null,
        as_of: marketSession.as_of || null,
      },
      execution: {
        provider: "mt5",
        degraded: mt5Degraded,
        health_status: mt5Health.status || mt5Health.detail || (mt5Degraded ? "degraded" : "ok"),
        bridge_mode: mt5Health.mode || mt5Health.execution_mode || null,
        account_id: mt5Health.account_id || mt5Health.account || null,
      },
      broker_reality: {
        broker_reality_state: brokerReality.state,
        broker_ack_rate: brokerReality.broker_ack_rate,
        fill_rate: brokerReality.fill_rate,
        broker_latency_ms: brokerReality.broker_latency_ms,
        slippage_bps: brokerReality.slippage_bps,
        reality_gap_samples: brokerReality.reality_gap_samples,
        last_real_fill_age_minutes: brokerReality.last_real_fill_age_minutes,
      },
      quote_reality: {
        quote_reality_state: quoteReality.state,
        reason: decisionReality.state === "POLICY_ONLY"
          ? "spread_decision_source:policy_only"
          : decisionReality.state === "PARTIAL_QUOTE_AWARE"
            ? "spread_decision_source:partial_quote_aware"
            : quoteReality.state === "BLIND"
              ? "broker_quote_missing"
              : "broker_quote_observed",
        spread_decision_source: decisionReality.spread_decision_source,
        policy_only_rate_pct: decisionReality.policy_only_rate_pct,
        spread_live_used_rate_pct: decisionReality.spread_live_used_rate_pct,
        decision_quote_coverage_pct: decisionReality.decision_quote_coverage_pct,
        decision_quote_observed_ignored_rows: decisionReality.decision_quote_observed_ignored_rows,
        decision_quote_observed_ignored_rate_pct: decisionReality.decision_quote_observed_ignored_rate_pct,
        decision_quote_ignored_gate_threshold_pct: decisionReality.decision_quote_ignored_gate_threshold_pct,
        decision_quote_ignored_gate_alert: decisionReality.decision_quote_ignored_gate_alert,
        decision_quote_ignored_path_threshold_pct: decisionReality.decision_quote_ignored_path_threshold_pct,
        decision_quote_ignored_path_alerts: decisionReality.decision_quote_ignored_path_alerts,
        decision_quote_ignored_path_reason_threshold_pct: decisionReality.decision_quote_ignored_path_reason_threshold_pct,
        decision_quote_ignored_path_reason_alerts: decisionReality.decision_quote_ignored_path_reason_alerts,
        decision_quote_top_remediation_candidates: decisionReality.decision_quote_top_remediation_candidates,
        decision_quote_covered_rows: decisionReality.decision_quote_covered_rows,
        decision_quote_uncovered_rows: decisionReality.decision_quote_uncovered_rows,
        decision_quote_coverage_breakdown: decisionReality.decision_quote_coverage_breakdown,
        decision_quote_ignored_drilldown: decisionReality.decision_quote_ignored_drilldown,
        decision_quote_ignored_reason_breakdown: decisionReality.decision_quote_ignored_reason_breakdown,
        decision_quote_coverage_breakdown_trend: decisionReality.decision_quote_coverage_breakdown_trend,
        decision_quote_top_uncovered_reasons: decisionReality.decision_quote_top_uncovered_reasons,
        diagnostic: decisionReality.diagnostic,
        spread_decision_trace_sample_count: decisionReality.sample_count,
        spread_decision_trace_last_audit: decisionReality.last_audit,
        next_gate: decisionReality.next_gate,
        broker_quote_visible: quoteReality.broker_quote_visible,
        broker_quote_surface: quoteReality.broker_quote_surface,
        broker_bid: quoteReality.broker_bid,
        broker_ask: quoteReality.broker_ask,
        broker_spread_bps: quoteReality.broker_spread_bps,
        broker_spread_absolute: quoteReality.broker_spread_absolute,
        broker_quote_observed_at: quoteReality.broker_quote_observed_at,
        account_id: quoteReality.account_id,
      },
      decision_reality: {
        decision_reality_state: decisionReality.state,
        spread_decision_source: decisionReality.spread_decision_source,
        sample_count: decisionReality.sample_count,
        policy_only_rate_pct: decisionReality.policy_only_rate_pct,
        spread_live_used_rate_pct: decisionReality.spread_live_used_rate_pct,
        decision_quote_coverage_pct: decisionReality.decision_quote_coverage_pct,
        decision_quote_observed_ignored_rows: decisionReality.decision_quote_observed_ignored_rows,
        decision_quote_observed_ignored_rate_pct: decisionReality.decision_quote_observed_ignored_rate_pct,
        decision_quote_ignored_gate_threshold_pct: decisionReality.decision_quote_ignored_gate_threshold_pct,
        decision_quote_ignored_gate_alert: decisionReality.decision_quote_ignored_gate_alert,
        decision_quote_ignored_path_threshold_pct: decisionReality.decision_quote_ignored_path_threshold_pct,
        decision_quote_ignored_path_alerts: decisionReality.decision_quote_ignored_path_alerts,
        decision_quote_ignored_path_reason_threshold_pct: decisionReality.decision_quote_ignored_path_reason_threshold_pct,
        decision_quote_ignored_path_reason_alerts: decisionReality.decision_quote_ignored_path_reason_alerts,
        decision_quote_top_remediation_candidates: decisionReality.decision_quote_top_remediation_candidates,
        decision_quote_covered_rows: decisionReality.decision_quote_covered_rows,
        decision_quote_uncovered_rows: decisionReality.decision_quote_uncovered_rows,
        decision_quote_coverage_breakdown: decisionReality.decision_quote_coverage_breakdown,
        decision_quote_ignored_drilldown: decisionReality.decision_quote_ignored_drilldown,
        decision_quote_ignored_reason_breakdown: decisionReality.decision_quote_ignored_reason_breakdown,
        decision_quote_coverage_breakdown_trend: decisionReality.decision_quote_coverage_breakdown_trend,
        decision_quote_top_uncovered_reasons: decisionReality.decision_quote_top_uncovered_reasons,
        diagnostic: decisionReality.diagnostic,
        last_audit: decisionReality.last_audit,
        next_gate: decisionReality.next_gate,
      },
      health: {
        kill_switch_active: killSwitchActive,
        kill_switch_reason: killSwitchState.reason || null,
        backend_mode: backendMode,
        system_mode: killSwitchActive ? "LOCKED" : backendMode === "managed_live" ? "LIVE" : "SAFE",
      },
      routing: {
        opportunity_enabled: gateKnown ? gateEnabled : null,
        status: gateKnown ? String(gateState.status || (gateEnabled ? "go" : "no-go")) : "unknown",
        health_score: toNumber(gateState.health_score, 0),
        reasons: gateReasons,
      },
      readiness: {
        runtime_reliability: runtimeDecision?.reliability?.state || "UNAVAILABLE",
        live_state: runtimeDecision?.opportunity?.liveState || "UNAVAILABLE",
        observation_status: runtimeDecision?.observation?.status || "UNAVAILABLE",
        summary: runtimeSummary,
      },
      settlement: {
        status: String(settlementTruth.status || "missing_source"),
        source: String(settlementTruth.source || "control_plane"),
        schema_version: String(settlementTruth.schema_version || ""),
        generated_at: settlementTruth.generated_at || null,
        last_settlement_at: settlementTruth.last_settlement_at || null,
        linked_outcome_count: toNumber(settlementTruth.linked_outcome_count, 0),
        unlinked_settlement_count: toNumber(settlementTruth.unlinked_settlement_count, 0),
        stale: Boolean(settlementTruth.stale),
        contract_valid: Boolean(settlementTruth.contract_valid),
        blocking: Boolean(settlementTruth.blocking),
        repair_hint: settlementTruth.repair_hint || null,
      },
      publication: {
        partial_data: partialData,
        generated_at: generatedAt,
        cache_ttl_ms: RUNTIME_TRUTH_CACHE_MS,
      },
      watchdog: {
        status: verdict.verdict === "READY" ? "OK" : verdict.verdict === "DEGRADED" ? "WARNING" : "HALT",
        blockers: verdict.blockers,
        degraded_reasons: verdict.degradedReasons,
        partial_data: partialData,
      },
      observation: {
        controlled_collection_phase: controlled.phase,
        active: controlled.active,
        watch_stale: controlled.watchStale,
        watch_age_minutes: controlled.watchAgeMinutes,
        kill_switch_source: controlled.killSwitchSource,
        fills_seen: controlled.fillsSeen,
        labels_seen: controlled.labelsSeen,
        edge_evidence_state: edgeEvidence.state,
        edge_evidence_available: edgeEvidence.available,
        mature_cells: edgeEvidence.matureCells,
        replicated_cells: edgeEvidence.replicatedCells,
        cell_count: edgeEvidence.cellCount,
        outcomes_with_both: edgeEvidence.outcomesWithBoth,
        edge_evidence_summary: edgeEvidence.summary,
        edge_evidence_next_gate: edgeEvidence.nextGate,
        edge_evidence_top_cells: edgeEvidence.topCells,
      },
    },
    raw: {
      kill_switch: killSwitchResult.payload,
      system_config: systemConfigResult.payload,
      opportunity_gate: gateResult.payload,
      market_session: marketSessionResult.payload,
      mt5_health: mt5HealthResult.payload,
      settlement_truth: settlementTruthResult.payload,
      runtime_decision: runtimeDecision,
      controlled_collection: controlled,
      edge_evidence: edgeEvidence,
      broker_reality: {
        state: brokerReality.state,
        mt5_risk_history_rows: mt5RiskHistory,
        execution_telemetry_rows: telemetryRecent,
        reality_gap_rows: realityGapRecent,
      },
      quote_reality: {
        state: quoteReality.state,
        account: selectedMt5,
        metadata: selectedMt5Metadata,
        broker_state: selectedBrokerState,
        broker_runtime_session: selectedBrokerRuntimeSession,
        derived: quoteReality,
      },
      decision_reality: {
        state: decisionReality.state,
        source: decisionReality.spread_decision_source,
        spread_decision_trace: spreadDecisionTraceSource,
        spread_decision_trace_backend: spreadDecisionTrace,
        spread_decision_trace_file: spreadDecisionTraceFile,
      },
      network,
    },
  };
}

export async function buildRuntimeTruthSnapshot(options: RuntimeTruthInput = {}): Promise<RuntimeTruthSnapshot> {
  const input = normalizeRuntimeTruthInput(options);
  if (!input.bypassCache) {
    const cached = await readCachedSnapshotEntry(input);
    if (cached) {
      if (isFreshEntry(cached)) {
        return cached.snapshot;
      }
      void refreshSnapshot(input).catch(() => null);
      return cached.snapshot;
    }
    if (input.allowStaleOnMiss) {
      void refreshSnapshot(input).catch(() => null);
      return buildUnavailableRuntimeTruthSnapshot(input);
    }
  }
  return refreshSnapshot(input);
}
