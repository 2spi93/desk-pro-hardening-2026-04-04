"use client";

import Link from "next/link";
import JSZip from "jszip";
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps, ReactNode } from "react";
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelGroupHandle } from "react-resizable-panels";

import HelpHint from "../../components/HelpHint";
import HelpTooltip from "../../components/ui/HelpTooltip";
import ModuleGuide from "../../components/ui/ModuleGuide";
import PanelShell from "../../components/ui/PanelShell";
import {
  applyLocalUserUiPreferences,
  fetchBackendUserUiPreferences,
  readLocalUserUiPreferencesUpdatedAt,
  readLocalUserUiPreferences,
  saveBackendUserUiPreferences,
  setLocalUserUiPreferencesUpdatedAt,
  useChartHapticMode,
  useChartMotionPreset,
  useChartReleaseSendMode,
  useChartSnapEnabled,
  useChartSnapPriority,
  useUiMode,
} from "../../lib/userUiPrefs";
import type { ChartMotionPreset, ChartReleaseSendMode, ChartSnapPriority, UserUiPreferencesProfile } from "../../lib/userUiPrefs";
import {
  computeChartRoundMagnetStep,
  computeChartSnapThreshold,
  getPriceStepDecimals,
  inferChartPriceStep,
  moveChartOrderLineTicket,
  quantizePriceToStep,
  resolveSnappedChartOrderPrice,
} from "../../lib/chartOrderMath";
import {
  buildDomLevels,
  buildDomLevelsFromDepth,
  buildFootprint,
  buildFootprintFromOhlcv,
  buildLiquidityZones,
  buildOverlayZones,
  buildTape,
  buildTapeFromTrades,
  resolveSignalCalibration,
} from "../../lib/chartViewTransforms";
import { analyzeOhlcvRows, normalizeOhlcvRows } from "../../lib/ohlcvIntegrity";
import { isTimeframeSupported, SUPPORTED_TIMEFRAMES, timeframeToMs } from "../../lib/ohlcvDataEngine";
import {
  DomTapeSidecarCard,
  ExecutionSidecarCard,
  ForensicReplaySidecarCard,
  FootprintHeatSidecarCard,
  LocalFeedSidecarCard,
  PolicySidecarCard,
} from "./ChartSidecarCards";
import {
  CHART_SIDECAR_PROFILE_IDS,
  type ChartSidecarLayoutState,
  type ChartSidecarId,
  type ChartSidecarLayoutMode,
  type ChartSidecarProfile,
  type DetachedChartSidecarState,
} from "./chartSidecarTypes";
import {
  buildDetachedChartSidecarLayout,
  CHART_SIDECAR_FLOATING_DEFAULTS,
  CHART_SIDECAR_PROFILE_LAYOUTS,
  clampDetachedChartSidecar,
  defaultChartSidecarLayoutForPreset,
  inferChartSidecarLayoutMode,
  normalizeChartSidecarLayout,
} from "./chartSidecarLayout";
import {
  buildLayoutExportPayload,
  buildLayoutPreset,
  buildTerminalLayoutStorageKeys,
  clampFloatingPanel,
  DEFAULT_HARD_ALERT_RATIO_PCT,
  DEFAULT_LAYOUT_WORKSPACE_NAME,
  DEFAULT_LAYOUT_WORKSPACE_OPTIONS,
  DEFAULT_RISK_ALERT_MISS_THRESHOLD,
  DEFAULT_RISK_ALERT_WINDOW,
  DEFAULT_RISK_REFRESH_SEC,
  LOWER_PANEL_IDS,
  mergeFloatingPresetsIntoWorkspaceBundle,
  MICRO_PANEL_IDS,
  MONITORING_PANEL_IDS,
  normalizeDockLayout,
  orderMap,
  parseImportedTerminalLayouts,
  readTerminalWorkspaceBundle,
  reorderIds,
  riskAlertDefaultsForPreset,
  screenLayoutProfile,
  type DockPanelId,
  type DockZone,
  type FloatingPanelState,
  type LayoutPreset,
  type TerminalLayoutConfig,
  type TerminalWorkspaceBundle,
} from "./terminalLayoutWorkspace";
import {
  fetchTerminalAuthStatus,
  isGtixPublicHost,
  isGtixPublicBrowserHost,
  PUBLIC_AUTH_STATUS_CACHE_MS,
  PUBLIC_AUTH_STATUS_SYNC_MS,
  PUBLIC_TERMINAL_BACKGROUND_REFRESH_MS,
  PUBLIC_TERMINAL_FALLBACK_POLL_MS,
  PUBLIC_TERMINAL_GOVERNANCE_REFRESH_MS,
  shouldPausePublicOpsRefresh,
  type AuthSessionStatus,
} from "./terminalPublicRuntime";
import {
  classifyFreshnessTone,
  deriveTerminalMarketHealth,
  formatFreshness,
  streamStateTone,
} from "./terminalMarketHealth";
import { buildLocalTerminalRuntimeCapture, type LocalTerminalRuntimeCapture } from "../../lib/localTerminalCapture";
import ChartExecutionHud from "./ChartExecutionHud";
import { buildChartOrderTicketPriceLabels, buildChartSnapEnabledLabel } from "./chartHudHelpers";
import ChartHudOrderRiskPanel from "./ChartHudOrderRiskPanel";
import ChartHudSignalDecisionPanel from "./ChartHudSignalDecisionPanel";
import ChartPerceptualDebugPanel from "./ChartPerceptualDebugPanel";
import GpuChartV4Surface from "./GpuChartV4Surface";
import InstitutionalChart from "./InstitutionalChart";
import TerminalChartV2 from "./TerminalChartV2";
import type { ChartPerceptualTelemetry, GpuPerceptualTelemetry } from "./chartPerceptual";
import {
  clearTerminalComputePerf,
  measureTerminalCompute,
  snapshotTerminalComputePerf,
  type TerminalComputePerfEntry,
} from "./terminalComputePerf";
import { isWebGL2Available } from "../../lib/engine/gpu-chart/context";
import {
  AlertsDockPanel,
  BlotterDockPanel,
  BrokersDockPanel,
  DomDockPanel,
  FootprintDockPanel,
  GovernanceMonitoringPanel,
  GovernanceDockPanel,
  HeatmapDockPanel,
  IncidentsMonitoringPanel,
  IncidentsDockPanel,
  ReadinessMonitoringPanel,
  ReadinessDockPanel,
  RiskTimelineBody,
  RiskTimelineMonitoringPanel,
  TapeDockPanel,
  AlertsMonitoringPanel,
} from "./TerminalSecondaryPanels";
import { barArrayHash, type Bar } from "../../lib/dataEngine";
import { indicatorWorkerAdapter } from "../../lib/indicators/workerAdapter";
import type { ActiveIndicator, IndicatorSeriesData } from "../../lib/indicators/engine";
import { ExecutionEngineV7, type V7Decision } from "../../lib/executionEngineV7";
import { PredictorEngineV8, type PredictorEngineV8TrainingStats } from "../../lib/predictorEngineV8";
import { createMarketDataBus, type MarketDataBusKernelTelemetry, type OhlcvBar } from "../../lib/marketDataBus";
import type { SelfLearningV4Regime, SelfLearningV4Scenario } from "../../lib/selfLearningV4Store";
import { useChartExecutionHud } from "../../lib/useChartExecutionHud";

type JsonMap = Record<string, unknown>;
const V8_PREDICTOR_STORAGE_KEY = "gtixt.terminal.v8.predictor.v1";
const V8_BACKEND_PREDICT_DEBOUNCE_MS = 250;
const V8_BACKEND_STATS_POLL_MS = 15000;
const V8_BACKEND_TRAINING_FLUSH_SIZE = 100;
const V8_BACKEND_TRAINING_FLUSH_INTERVAL_MS = 5000;
const V8_DATA_RELIABILITY_MAX_BACKLOG = 384;
const V8_LATENCY_GUARD_MS = 300;
const DEFAULT_MARKET_BUS_KERNEL_TELEMETRY: MarketDataBusKernelTelemetry = {
  tickLatencyMs: 0,
  bufferBacklog: 0,
  drainedTicksPerFrame: 0,
  skippedFrames: 0,
  schedulerBudgetMs: 5,
  schedulerPullLimit: 320,
  cpuLoadHint: 1,
  fpsHint: 60,
  frameTimeHintMs: 16.7,
  backlogPressure: 0,
  framesProcessed: 0,
  benchmarkMode: false,
  benchmarkTicksPerSec: 0,
  benchmarkInjectedTicks: 0,
  receivedTicks: 0,
  candleUpdates: 0,
  syntheticHeartbeatOpens: 0,
  lastCandleUpdateAt: null,
  lastDrainAt: null,
};

type LearningRegimeV4 = SelfLearningV4Regime;
type MarketDecisionScenario = SelfLearningV4Scenario;
type QuotePoint = { label: string; value: number };
type QuoteHistoryMap = Record<string, QuotePoint[]>;
type MultiAnchorVwapSnapshot = {
  session: number;
  day: number;
  week: number;
  month: number;
  swing: number;
  impulse: number;
  sessionDistanceBps: number;
  dayDistanceBps: number;
  weekDistanceBps: number;
  monthDistanceBps: number;
  swingDistanceBps: number;
  impulseDistanceBps: number;
  primaryLabel: string;
  primaryDistanceBps: number;
  anchorCompressionBps: number;
  confluenceScore: number;
};
type LiquidityEngineSnapshot = {
  restingBidUsd: number;
  restingAskUsd: number;
  restingImbalance: number;
  touchDensity: number;
  sweepRisk: number;
  liquidityVacuum: number;
  supportScore: number;
  resistanceScore: number;
  liquidityPressure: number;
  liquidityEngineScore: number;
  stateLabel: string;
};
type OverlayZone = {
  kind: "fvg" | "ob";
  label: string;
  x1: number;
  x2: number;
  low: number;
  high: number;
  tone: string;
};
type LiquidityZone = { level: number; label: string };
type DomLevel = { side: "bid" | "ask"; price: number; size: number; intensity: number };
type FootprintRow = { low: number; high: number; buyVolume: number; sellVolume: number; delta: number; timeLabel?: string; timeKey?: string };
type TapePrint = { label: string; price: number; delta: number; side: "buy" | "sell" | "flat"; volume: number; timeKey?: string };
type MarketSignalDirection = "buy" | "sell" | "neutral";
type MarketSignalSeverity = "info" | "warn" | "critical";
type AutoExecutionMode = "assisted" | "semi-auto" | "full-auto";
type MarketSignalEvent = {
  id: "imbalance" | "absorption" | "fake-breakout" | "liquidity-trap" | "continuation" | "exhaustion";
  label: string;
  detail: string;
  reasonCode: string;
  direction: MarketSignalDirection;
  severity: MarketSignalSeverity;
  confidence: number;
};
type SignalConfidenceDrift = "UP" | "FLAT" | "DOWN";
type MarketSignalSnapshot = {
  buyPressurePct: number;
  sellPressurePct: number;
  directionalLongPct: number;
  directionalShortPct: number;
  directionalConfidencePct: number;
  directionalConfidenceLabel: "LOW" | "MEDIUM" | "HIGH";
  dominantDirection: MarketSignalDirection;
  headline: string;
  convictionLabel: string;
  focusMode: boolean;
  calibrationLabel: string;
  criticalSignalCount: number;
  criticalSignalIds: string[];
  signals: MarketSignalEvent[];
};
type MarketEvidenceComponent = {
  id: "dom" | "footprint" | "liquidity" | "price-action";
  label: string;
  scorePct: number;
  direction: MarketSignalDirection;
  detail: string;
};
type MarketConfluenceWeights = {
  dom: number;
  footprint: number;
  liquidity: number;
  "price-action": number;
};
type MarketEvidenceWeightKey = MarketEvidenceComponent["id"];
type SignalDisplayMode = "classic" | "augmented" | "ai-dominant";
type ExecutionAdaptMode = "auto" | "confirm" | "manual";
type MarketSuggestedBracket = {
  side: "buy" | "sell";
  entry: number;
  sl: number;
  tp: number;
  rr: number;
  label: string;
};
type MarketHistoricalLearning = {
  sampleSize: number;
  scopeLabel: string;
  winratePct: number;
  learnedWeights: MarketConfluenceWeights;
};
type SelfLearningV4DriftSnapshot = {
  status: "WARMUP" | "STABLE" | "DRIFT";
  shortSamples: number;
  longSamples: number;
  shortWinratePct: number;
  longWinratePct: number;
  winrateDropPct: number;
  shortBrier: number | null;
  longBrier: number | null;
  brierRise: number;
  shortLossCount: number;
  enoughSamples: boolean;
  shouldDemote: boolean;
  signature: string;
};
type SelfLearningV4PersistedState = {
  version: number;
  accountId: string;
  symbol: string;
  timeframe: string;
  enabled: boolean;
  autoAdaptEnabled: boolean;
  modelUpdatedAt: string | null;
  driftAutoDemotedAt: string | null;
  filters: {
    regime: "all" | LearningRegimeV4;
    scenario: "all" | MarketDecisionScenario;
  };
  snapshot: {
    regime: LearningRegimeV4;
    scenarioHint: MarketDecisionScenario;
    active: boolean;
    profile: MarketHistoricalLearning;
    adaptiveWeights: MarketConfluenceWeights;
    effectiveWeights: MarketConfluenceWeights;
    drift: SelfLearningV4DriftSnapshot;
  };
  journal: SelfLearningJournalEventV4[];
  updatedAt: string;
};
type SelfLearningV4ScopeSummary = {
  accountId: string;
  symbol: string;
  timeframe: string;
  updatedAt: string;
  journalSize: number;
  enabled: boolean;
  autoAdaptEnabled: boolean;
  driftStatus: "WARMUP" | "STABLE" | "DRIFT";
};
type SelfLearningV4Storage = "control-plane" | "local-fallback" | "unknown";
type SelfLearningV4PersistenceStatus = {
  storage: SelfLearningV4Storage;
  healthy: boolean;
  stateLoadedAt: string | null;
  stateSavedAt: string | null;
  scopesLoadedAt: string | null;
  scopeCount: number;
  message: string;
};
type MarketDecisionSnapshot = {
  scenario: MarketDecisionScenario;
  scenarioLabel: string;
  scenarioProbabilityPct: number;
  probableReversalZone: number | null;
  probableReversalZoneLabel: string;
  globalConfidencePct: number;
  biasDirection: MarketSignalDirection;
  criticalConfirmed: boolean;
  evidence: MarketEvidenceComponent[];
  confluenceScorePct: number;
  actionTitle: string;
  actionBody: string;
  suggestedBracket: MarketSuggestedBracket | null;
  historicalLearning: MarketHistoricalLearning;
  executionPlan: {
    snapPriority: ChartSnapPriority;
    preset: ChartOrderPreset;
    guardEnabled: boolean;
  };
};
type MarketSignalAlertToast = {
  key: string;
  title: string;
  detail: string;
  direction: MarketSignalDirection;
  zoneLabel: string;
  critical: boolean;
};
type ChartCursorPayload = { price: number; timeLabel: string; timeKey: string } | null;
type MarketMetric = {
  fundingRate: number;
  openInterest: number;
  volume: number;
  depthImbalance: number;
  tapeAcceleration: number;
  // V4 microstructure
  cvd: number;
  cvdDelta: number;
  cvdTrend: "rising" | "falling" | "flat";
  flowImbalance: number;
  spreadBps: number;
  tradeAggressiveness: number;
  avgLatencyMs: number;
  latencyTier: "fast" | "normal" | "slow";
  activeEventCount: number;
  lastEventType: string | null;
};
type LocalFeedFallbackSuggestion = {
  key: string;
  symbol: string;
  instrument: string;
  venue: string;
  timeframe: string;
  autoApplyAtMs: number;
};
type LocalTerminalCapturePersistenceStatus = {
  clientId: string | null;
  updatedAt: string | null;
  healthy: boolean;
  detail: string;
  historyCount: number;
  autoIncidentTicketKey: string | null;
  autoIncidentStatus: string | null;
  captureHistory: LocalTerminalRuntimeCapture[];
};
type MarketMetricsUniverseEntry = {
  symbolKey: string;
  venue: string;
  instrument: string;
};
type GovernanceSort = "severity" | "label" | "value";
type IncidentSort = "severity" | "status" | "sla";
type ReplaySpeed = 1 | 2 | 4 | 8;
type ReplayFrame = {
  timeKey: string;
  timeLabel: string;
  quoteValue?: number;
  tapeEvents?: TapePrint[];
  footprintRows?: FootprintRow[];
  domLevels?: DomLevel[];
  heatmapLevels?: DomLevel[];
};
type ReplayBufferMap = Record<string, ReplayFrame[]>;
type ReplayState = {
  enabled: boolean;
  playing: boolean;
  speed: ReplaySpeed;
  cursorIndex: number;
  timeKey: string | null;
};
type ChartOrderPreset = "scalp" | "swing" | "low-risk" | "custom";
type ChartOrderLineKey = "entry" | "sl" | "tp";
type ChartSnapFamily = "execution" | "vwap" | "liquidity" | "manual";
type ChartDragState = {
  line: ChartOrderLineKey;
  rectTop: number;
  rectHeight: number;
  pointerId: number;
  pointerType: string;
  startPrice: number;
  fineMode: boolean;
  moved: boolean;
};
type ChartSnapState = { label: string; price: number; family: ChartSnapFamily } | null;
type ChartReleaseTicketState = { line: ChartOrderLineKey; top: number; price: number; snapLabel: string; fineMode: boolean; armed: boolean } | null;
type ChartOrderTicket = {
  side: "buy" | "sell";
  preset: ChartOrderPreset;
  entry: number;
  sl: number;
  tp: number;
  oco: boolean;
  active: boolean;
};
type ChartSendHistoryEntry = {
  atIso: string;
  symbol: string;
  side: "buy" | "sell";
  rr: number;
  riskUsd: number;
  rewardUsd: number;
  maxLossUsd: number;
  targetGainUsd: number;
  compliant: boolean;
  outcome: "submitted" | "blocked-loss" | "confirmation-required";
  source?: "local" | "backend";
};
type RiskTimelineFilter = "all" | "compliant" | "miss";
type RiskHistorySummary = {
  count_ok: number;
  count_miss: number;
  last_block_reason: string;
  window_size: number;
  miss_in_window: number;
  ratio_miss_window: number;
  miss_threshold: number;
  alert: boolean;
};
type RiskPollingStatus = {
  lastRefreshIso: string | null;
  latencyMs: number | null;
  source: "summary" | "history" | null;
};
type PerformanceSummaryPayload = {
  scope_type: string;
  scope_id: string;
  period_start: string;
  period_end: string;
  trade_count: number;
  realized_pnl_usd: number;
  unrealized_pnl_usd: number;
  fees_usd: number;
  win_rate_pct: number;
  expectancy_usd: number;
  avg_slippage_bps: number;
  avg_latency_ms: number;
  sharpe_ratio: number | null;
};
type PerformanceAttributionItem = {
  strategy_id: string | null;
  symbol: string | null;
  venue: string | null;
  realized_pnl_usd: number;
  unrealized_pnl_usd: number;
  fees_usd: number;
  trade_count: number;
  win_rate_pct: number;
  expectancy_usd: number;
  avg_slippage_bps: number;
  avg_latency_ms: number;
  avg_score_pre_trade: number;
  gross_profit_usd: number;
  gross_loss_usd: number;
  profit_factor: number | null;
  pnl_contribution_pct: number;
  avg_mae: number;
  avg_mfe: number;
  group_by: string[];
};
type PerformanceCapitalSource = {
  key: string;
  sourceType: "broker" | "exchange" | "wallet";
  environment: string;
  platform: string;
  displayName: string;
  status: string;
  latestEquityUsd: number | null;
  canonical: boolean;
};
type InvestorReportItem = {
  report_id: string;
  client_id: string;
  portfolio_id: string | null;
  report_month: string;
  report_type: string;
  status: string;
  storage_path: string | null;
  summary: JsonMap;
  created_at: string | null;
  published_at: string | null;
};
type ReplayEventMarker = {
  id: string;
  label: string;
  kind: "intent" | "approval" | "fill" | "incident" | "routing" | "outcome" | "latent" | "other";
  timeKey: string;
  frameIndex: number;
  critical: boolean;
  detail: string;
};
type BrainReplayAttributionFamily = {
  family: string;
  contribution: number;
  shapLike: number;
  marginalImpact: number;
  correlation: number;
  learningRateHint: number;
  wrongWay: boolean;
};
type BrainReplayAgentLearningRate = {
  agent: string;
  base: number;
  featureMultiplier: number;
  failureMultiplier: number;
  combinedMultiplier: number;
  effectiveLearningRate: number;
  families: string[];
  failureSource: string | null;
  calibrationMode: string;
  calibrationConfidence: number;
  calibrationSamples: number;
  calibrationEffectiveWeight: number;
  explanation: string;
};
type BrainReplayAttributionSnapshot = {
  id: string;
  action: string;
  reward: number;
  rawReward: number;
  rewardScale: number;
  contextLabel: string;
  topFamily: string;
  topContribution: number;
  families: BrainReplayAttributionFamily[];
  latentLabel: string;
  latentNextLabel: string;
  latentTransition: number;
  latentShiftLabel: string;
  synthetic: boolean;
  dreamSource: string;
  sampleWeight: number;
  dreamCount: number;
  dreamWeight: number;
  failureSource: string | null;
  failureReasons: string[];
  failureBlocking: boolean;
  agentLearningRates: BrainReplayAgentLearningRate[];
};
type MetaRiskAuditEvent = {
  id: string;
  timestampIso: string;
  tierFrom: string;
  tierTo: string;
  capitalFromPct: number;
  capitalToPct: number;
  reason: string;
  healthScore: number;
  blockedRegimes: string[];
  venue: string;
};

function normalizePerformanceCapitalSources(accountsPayload: unknown, connectorsPayload: unknown): PerformanceCapitalSource[] {
  const sources = new Map<string, PerformanceCapitalSource>();
  const accounts = Array.isArray(accountsPayload) ? accountsPayload : [];
  for (const item of accounts) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const row = item as JsonMap;
    const accountId = String(row.account_id || "");
    if (!accountId) {
      continue;
    }
    const accountType = String(row.account_type || "broker").toLowerCase();
    const sourceType = accountType === "exchange" || accountType === "wallet" ? accountType : "broker";
    sources.set(accountId, {
      key: `canonical:${accountId}`,
      sourceType,
      environment: sourceType === "broker" ? String(row.mode || "unknown") : `${sourceType} live`,
      platform: String(row.venue || row.connector_type || accountId),
      displayName: String(row.display_name || accountId),
      status: String(row.status || "unknown"),
      latestEquityUsd: Number.isFinite(Number(row.latest_equity_usd)) ? Number(row.latest_equity_usd) : null,
      canonical: true,
    });
  }

  const connectorAccounts = connectorsPayload && typeof connectorsPayload === "object" && Array.isArray((connectorsPayload as JsonMap).accounts)
    ? ((connectorsPayload as JsonMap).accounts as unknown[])
    : [];
  for (const item of connectorAccounts) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const row = item as JsonMap;
    const accountId = String(row.account_id || "");
    const provider = String(row.provider || "");
    if (!accountId || provider.toLowerCase() === "mt5" || sources.has(accountId)) {
      continue;
    }
    const providerType = String(row.provider_type || "exchange").toLowerCase();
    const sourceType = providerType === "wallet" ? "wallet" : "exchange";
    sources.set(accountId, {
      key: `linked:${provider}:${accountId}`,
      sourceType,
      environment: sourceType === "wallet" ? "wallet live" : "exchange live",
      platform: provider || sourceType,
      displayName: String(row.label || accountId),
      status: Boolean(row.has_credentials) ? "linked" : "credential-missing",
      latestEquityUsd: null,
      canonical: false,
    });
  }

  return [...sources.values()];
}

function formatCurrency(value: number): string {
  return value.toLocaleString("fr-FR", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

type AutoTuningAuditEvent = {
  id: string;
  timestampIso: string;
  actor: string;
  dryRun: boolean;
  status: "accepted" | "rejected" | "failed";
  recommendationCount: number;
  summary: string;
};

type AutoExecutionAuditEvent = {
  id: string;
  timestampIso: string;
  symbol: string;
  timeframe: string;
  mode: AutoExecutionMode;
  gateState: "READY" | "BLOCKED" | "KILLED";
  metaPass: boolean;
  riskPass: boolean;
  sessionPass: boolean;
  symbolLossPass: boolean;
  killSwitch: boolean;
  sizeUsd: number;
  qualityScore: number;
  reasons: string[];
};

type TradeTicketOverrides = {
  symbol?: string;
  side?: "buy" | "sell";
  lots?: number;
  notional?: number;
  maxSpread?: number;
  rationale?: string;
  preferredVenue?: string;
  orderIntent?: JsonMap;
  metadata?: JsonMap;
};

type SelfLearningJournalEventV4 = {
  id: string;
  timestampIso: string;
  symbol: string;
  timeframe: string;
  regime: LearningRegimeV4;
  scenario: MarketDecisionScenario;
  outcome: "win" | "loss";
  pnl: number;
  mfe: number;
  mae: number;
  weights: MarketConfluenceWeights;
};

type RollbackGuardSession = {
  id: string;
  startedAtIso: string;
  baselineHealth: number;
  baselineBrier: number | null;
  baselineWeights: Array<{ strategyId: string; pct: number }>;
  windowMin: number;
  healthDropThreshold: number;
  brierRiseThreshold: number;
  source: string;
  reason: string;
  status: "active" | "closed";
  closeReason?: string;
  closedAtIso?: string;
  observations?: Array<{
    timestampIso: string;
    currentHealth: number;
    currentBrier: number | null;
    healthDrop: number;
    brierRise: number;
    degradeHealth: boolean;
    degradeBrier: boolean;
    shouldProposeRollback: boolean;
  }>;
};

const AUTO_TUNING_WRITEBACK_ENABLED = process.env.NEXT_PUBLIC_AUTO_TUNING_WRITEBACK === "1";
const ROLLBACK_GUARD_WINDOW_MIN = Number(process.env.NEXT_PUBLIC_ROLLBACK_GUARD_WINDOW_MIN || 90);
const ROLLBACK_GUARD_HEALTH_DROP = Number(process.env.NEXT_PUBLIC_ROLLBACK_GUARD_HEALTH_DROP || 0.08);
const ROLLBACK_GUARD_BRIER_RISE = Number(process.env.NEXT_PUBLIC_ROLLBACK_GUARD_BRIER_RISE || 0.035);
const TERMINAL_V2_DEFAULT = process.env.NEXT_PUBLIC_TERMINAL_V2 === "1";
const TERMINAL_CHART_ENGINE_DEFAULT: "v3" | "v4" = process.env.NEXT_PUBLIC_TERMINAL_ENGINE_V4 === "1" ? "v4" : "v3";
const TERMINAL_SMOOTHING_DEFAULT_MS: 0 | 80 | 140 | 220 = 140;
type TerminalFocusDeckId = "micro" | "markets" | "monitoring" | "capital" | "metaRisk" | "correlation" | "calibration";
const TERMINAL_FOCUS_DECKS: Array<{ id: TerminalFocusDeckId; label: string }> = [
  { id: "micro", label: "Micro" },
  { id: "markets", label: "Markets" },
  { id: "monitoring", label: "Ops" },
  { id: "capital", label: "Capital" },
  { id: "metaRisk", label: "Risk" },
  { id: "correlation", label: "Correlation" },
  { id: "calibration", label: "Calibration" },
];
const TERMINAL_FOCUS_DECK_THROTTLE_MS: Record<TerminalFocusDeckId, number> = {
  micro: 250,
  markets: 1200,
  monitoring: 1500,
  capital: 1500,
  metaRisk: 1500,
  correlation: 2000,
  calibration: 2000,
};

const DEBUG_TIME_SYNC = process.env.NEXT_PUBLIC_DEBUG_TIME_SYNC === "1";
const TERMINAL_COMPUTE_PERF_STORAGE_KEY = "txt.terminal.compute-perf";
const MARKET_SNAPSHOT_CACHE_TTL_MS = 20_000;
const CHART_ORDER_PRESETS: Record<Exclude<ChartOrderPreset, "custom">, { slPct: number; tpPct: number; notional: number; maxSpread: number }> = {
  scalp: { slPct: 0.003, tpPct: 0.006, notional: 10000, maxSpread: 10 },
  swing: { slPct: 0.008, tpPct: 0.016, notional: 15000, maxSpread: 18 },
  "low-risk": { slPct: 0.0025, tpPct: 0.004, notional: 8000, maxSpread: 9 },
};
const DEFAULT_CONFLUENCE_WEIGHTS: MarketConfluenceWeights = {
  dom: 1,
  footprint: 1.15,
  liquidity: 1.1,
  "price-action": 0.95,
};
const CHART_TIMEFRAMES: string[] = [...SUPPORTED_TIMEFRAMES];
const CHART_TIMEFRAME_SELECTOR_PRIMARY = ["1s", "5s", "10s", "30s", "1m", "5m", "15m"] as const;
const CHART_TIMEFRAME_SELECTOR_SECONDARY = ["30m", "1h", "4h", "8h", "1d", "1w", "1M"] as const;
const HUMAN_MODE_INDICATORS: ActiveIndicator[] = [
  { id: "ema9", params: {} },
  { id: "ema21", params: {} },
  { id: "ema50", params: {} },
  { id: "ema200", params: {} },
  { id: "vwap", params: {} },
  { id: "rsi", params: {} },
  { id: "macd", params: {} },
  { id: "atr", params: {} },
  { id: "supertrend", params: {} },
  { id: "market_structure", params: {} },
];
const HYBRID_MODE_INDICATORS: ActiveIndicator[] = [
  { id: "ema21", params: {} },
  { id: "vwap", params: {} },
  { id: "rsi", params: {} },
  { id: "supertrend", params: {} },
];

function buildMarketMetricsUniverse(quotes: JsonMap[], symbolFilter: string, marketFilter: string): MarketMetricsUniverseEntry[] {
  const normalizedSymbolFilter = symbolFilter.trim().toLowerCase();
  const deduped = new Map<string, MarketMetricsUniverseEntry>();

  for (const quote of quotes) {
    const symbolKey = instrumentLabel(quote);
    const market = classifyInstrument(symbolKey);
    const matchesSymbol = !normalizedSymbolFilter || symbolKey.toLowerCase().includes(normalizedSymbolFilter);
    const matchesMarket = marketFilter === "all" || market === marketFilter;
    if (!matchesSymbol || !matchesMarket) {
      continue;
    }

    const venue = String(quote.venue || "binance-public");
    const instrument = normalizeInstrument(String(quote.instrument || symbolKey));
    const dedupeKey = `${symbolKey}|${venue}|${instrument}`;
    if (!deduped.has(dedupeKey)) {
      deduped.set(dedupeKey, { symbolKey, venue, instrument });
    }
  }

  return [...deduped.values()]
    .sort((left, right) => (
      left.symbolKey.localeCompare(right.symbolKey)
      || left.venue.localeCompare(right.venue)
      || left.instrument.localeCompare(right.instrument)
    ))
    .slice(0, 7);
}

function cloneIndicatorPreset(preset: ActiveIndicator[]): ActiveIndicator[] {
  return preset.map((indicator) => ({
    id: indicator.id,
    params: { ...(indicator.params || {}) },
  }));
}

function normalizeInstrument(symbol: string): string {
  return symbol.replace("-PERP", "").replace("/", "").replace(/-/g, "").toUpperCase();
}

function buildIdempotencyKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-idempotency`;
}

function buildChartSymbolCandidates(symbol: string): string[] {
  const normalized = normalizeInstrument(symbol);
  if (!normalized) {
    return [];
  }

  const candidates = new Set<string>([normalized]);
  if (classifyInstrument(normalized) === "crypto") {
    if (normalized.endsWith("USD") && !normalized.endsWith("USDT")) {
      candidates.add(`${normalized}T`);
    }
    if (normalized.endsWith("USDT")) {
      candidates.add(normalized.slice(0, -1));
    }
  }

  return [...candidates];
}

function chartInstrumentsMatch(left: string, right: string): boolean {
  const leftCandidates = new Set(buildChartSymbolCandidates(left));
  for (const candidate of buildChartSymbolCandidates(right)) {
    if (leftCandidates.has(candidate)) {
      return true;
    }
  }
  return false;
}

function chartQuotePriority(item: JsonMap, preferredSymbols: string[]): number {
  const instrument = normalizeInstrument(String(item.instrument || instrumentLabel(item)));
  const venue = String(item.venue || "").toLowerCase();
  const source = String(item.source || "").toLowerCase();
  let score = 0;

  if (instrument === preferredSymbols[0]) {
    score += 80;
  } else if (preferredSymbols.includes(instrument)) {
    score += 60;
  }
  if (venue === "binance-public") {
    score += 40;
  } else if (!venue.startsWith("paper-")) {
    score += 20;
  }
  if (instrument.endsWith("USDT")) {
    score += 10;
  }
  if (source.includes("binance")) {
    score += 4;
  }
  if (toNumber(item.last, 0) > 0) {
    score += 2;
  }

  return score;
}

function pickPreferredChartQuote(quotes: JsonMap[], symbol: string, preferredVenue?: string | null): JsonMap | null {
  const preferredSymbols = buildChartSymbolCandidates(symbol);
  if (preferredSymbols.length === 0) {
    return null;
  }

  return [...quotes]
    .filter((quote) => preferredSymbols.includes(normalizeInstrument(String(quote.instrument || instrumentLabel(quote)))))
    .sort((left, right) => {
      const leftVenue = String(left.venue || "");
      const rightVenue = String(right.venue || "");
      const venueBias = preferredVenue
        ? (rightVenue === preferredVenue ? 1 : 0) - (leftVenue === preferredVenue ? 1 : 0)
        : 0;
      if (venueBias !== 0) {
        return venueBias;
      }
      return chartQuotePriority(right, preferredSymbols) - chartQuotePriority(left, preferredSymbols);
    })[0] || null;
}

function pickDefaultChartQuote(quotes: JsonMap[]): JsonMap | null {
  const defaultSymbols = ["BTCUSDT", "BTCUSD"];
  return [...quotes]
    .sort((left, right) => chartQuotePriority(right, defaultSymbols) - chartQuotePriority(left, defaultSymbols))[0] || null;
}

const TEAM_PRESETS: Record<string, TerminalLayoutConfig> = {
  "⬡ Scalp HF": buildLayoutPreset("scalp", false),
  "⬡ Swing Day": buildLayoutPreset("swing", false),
  "⬡ Risk Monitor": buildLayoutPreset("monitoring", false),
};
const TEAM_PRESET_NAMES = Object.keys(TEAM_PRESETS);

function toNumber(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function formatFeatureFamilyLabel(value: string): string {
  const normalized = String(value || "n/a").trim().toLowerCase();
  const labels: Record<string, string> = {
    orderflow: "Orderflow",
    liquidity: "Liquidity",
    vwap: "VWAP",
    regime: "Regime",
  };
  return labels[normalized] || normalized || "n/a";
}

function compactFeatureFamilyLabel(value: string): string {
  const normalized = String(value || "n/a").trim().toLowerCase();
  const labels: Record<string, string> = {
    orderflow: "OF",
    liquidity: "LQ",
    vwap: "VW",
    regime: "RG",
  };
  return labels[normalized] || normalized.slice(0, 2).toUpperCase() || "NA";
}

function formatReplayAgentLabel(value: unknown): string {
  const normalized = String(value || "").trim().toLowerCase();
  const labels: Record<string, string> = {
    scalper: "Scalper",
    trend: "Trend",
    liquidity: "Liquidity",
    execution: "Execution",
    risk: "Risk",
  };
  return labels[normalized] || (normalized ? `${normalized.slice(0, 1).toUpperCase()}${normalized.slice(1)}` : "Agent");
}

function compactReplayAgentLabel(value: unknown): string {
  const normalized = String(value || "").trim().toLowerCase();
  const labels: Record<string, string> = {
    scalper: "SC",
    trend: "TR",
    liquidity: "LQ",
    execution: "EX",
    risk: "RK",
  };
  return labels[normalized] || normalized.slice(0, 2).toUpperCase() || "AG";
}

function formatFailureSourceLabel(value: unknown): string {
  const normalized = String(value || "").trim().toLowerCase();
  const labels: Record<string, string> = {
    infra: "Infra",
    market: "Market",
    execution: "Execution",
  };
  return labels[normalized] || (normalized ? `${normalized.slice(0, 1).toUpperCase()}${normalized.slice(1)}` : "Source");
}

function formatControlPlaneStateLabel(value: unknown): string {
  const normalized = String(value || "healthy").trim().toLowerCase();
  if (normalized === "retry_recovered") {
    return "retry recovered";
  }
  if (normalized === "degraded") {
    return "degraded";
  }
  return "healthy";
}

function compactControlPlaneFailureLabel(value: unknown): string {
  const normalized = String(value || "none").trim().toLowerCase();
  const labels: Record<string, string> = {
    none: "none",
    dns_transient: "dns",
    dns_unresolved: "dns hard",
    timeout: "timeout",
    connection_refused: "refused",
    connection_reset: "reset",
    aborted: "abort",
    network_unknown: "network",
    unknown_error: "unknown",
  };
  return labels[normalized] || normalized.replace(/_/g, " ");
}

function buildFeatureContextLabel(context: JsonMap | null | undefined): string {
  const regime = String(context?.regime || "n/a").toLowerCase();
  const session = String(context?.session || "n/a").toLowerCase();
  const volatility = String(context?.volatility || "n/a").toLowerCase();
  const spread = String(context?.spread || "n/a").toLowerCase();
  return `${regime} · ${session} · ${volatility} · ${spread}`;
}

function normalizeReplayLatentLabel(value: unknown): string {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized || "uninitialized";
}

function formatReplayLatentLabel(value: unknown): string {
  return normalizeReplayLatentLabel(value)
    .split("-")
    .map((part) => part ? `${part.slice(0, 1).toUpperCase()}${part.slice(1)}` : "")
    .filter(Boolean)
    .join(" ");
}

function compactReplayLatentLabel(value: unknown): string {
  const tokens = normalizeReplayLatentLabel(value)
    .split("-")
    .map((part) => part.trim())
    .filter(Boolean);
  if (tokens.length === 0) {
    return "UN";
  }
  return tokens.map((part) => part.slice(0, 1).toUpperCase()).join("").slice(0, 3) || "UN";
}

function buildReplayLatentShiftLabel(latentLabel: string, latentNextLabel: string): string {
  return latentLabel === latentNextLabel
    ? `${formatReplayLatentLabel(latentLabel)} hold`
    : `${formatReplayLatentLabel(latentLabel)} -> ${formatReplayLatentLabel(latentNextLabel)}`;
}

function formatReplayDreamSource(value: unknown): string {
  const normalized = String(value || "").trim();
  if (!normalized || normalized === "real") {
    return "real tape";
  }
  if (normalized === "synthetic") {
    return "synthetic";
  }
  return normalized.length <= 22 ? normalized : `${normalized.slice(0, 10)}...${normalized.slice(-6)}`;
}

function buildReplayDreamSummary(snapshot: BrainReplayAttributionSnapshot | null | undefined): string {
  if (!snapshot) {
    return "real tape";
  }
  if (snapshot.synthetic) {
    return `dream from ${formatReplayDreamSource(snapshot.dreamSource)} · w x${snapshot.sampleWeight.toFixed(2)}`;
  }
  if (snapshot.dreamCount > 0) {
    return `spawned ${snapshot.dreamCount} dream${snapshot.dreamCount === 1 ? "" : "s"} · w x${snapshot.dreamWeight.toFixed(2)}`;
  }
  return `real tape · w x${snapshot.sampleWeight.toFixed(2)}`;
}

function formatReplayFailureSource(value: unknown): string {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "infra") {
    return "infra";
  }
  if (normalized === "execution") {
    return "execution";
  }
  if (normalized === "market") {
    return "market";
  }
  return "";
}

function mergeReplayDreamEcho(
  target: BrainReplayAttributionSnapshot | undefined,
  dreamSnapshot: BrainReplayAttributionSnapshot,
): BrainReplayAttributionSnapshot {
  const base = target || {
    ...dreamSnapshot,
    id: dreamSnapshot.dreamSource,
    synthetic: false,
    dreamSource: dreamSnapshot.dreamSource,
    sampleWeight: 1,
    dreamCount: 0,
    dreamWeight: 0,
    agentLearningRates: dreamSnapshot.agentLearningRates,
  };
  return {
    ...base,
    dreamCount: base.dreamCount + 1,
    dreamWeight: Number((base.dreamWeight + dreamSnapshot.sampleWeight).toFixed(4)),
  };
}

function normalizeReplayAgentLearningRates(raw: unknown): BrainReplayAgentLearningRate[] {
  const normalizedRows: BrainReplayAgentLearningRate[] = [];
  const pushRow = (value: JsonMap, fallbackAgent: string) => {
    const agent = String(value.agent || fallbackAgent).trim().toLowerCase();
    if (!agent) {
      return;
    }
    normalizedRows.push({
      agent,
      base: toNumber(value.base, 0),
      featureMultiplier: toNumber(value.featureMultiplier ?? value.feature_multiplier, 1),
      failureMultiplier: toNumber(value.failureMultiplier ?? value.failure_multiplier, 1),
      combinedMultiplier: toNumber(value.combinedMultiplier ?? value.combined_multiplier, 1),
      effectiveLearningRate: toNumber(value.effectiveLearningRate ?? value.effective_learning_rate, 0),
      families: Array.isArray(value.families) ? value.families.map((item) => String(item || "").trim()).filter(Boolean) : [],
      failureSource: formatReplayFailureSource(value.failureSource || value.failure_source) || null,
      calibrationMode: String(value.calibrationMode || value.calibration_mode || "prior").trim().toLowerCase() || "prior",
      calibrationConfidence: toNumber(value.calibrationConfidence ?? value.calibration_confidence, 0),
      calibrationSamples: Math.max(0, Math.round(toNumber(value.calibrationSamples ?? value.calibration_samples, 0))),
      calibrationEffectiveWeight: toNumber(value.calibrationEffectiveWeight ?? value.calibration_effective_weight, 0),
      explanation: String(value.explanation || "").trim(),
    });
  };

  if (Array.isArray(raw)) {
    raw.filter((item): item is JsonMap => Boolean(item) && typeof item === "object").forEach((item, index) => {
      pushRow(item, `agent-${index + 1}`);
    });
  } else if (raw && typeof raw === "object") {
    Object.entries(raw as JsonMap).forEach(([agent, value]) => {
      if (value && typeof value === "object") {
        pushRow(value as JsonMap, agent);
      }
    });
  }

  return normalizedRows.sort((left, right) => Math.abs(right.combinedMultiplier - 1) - Math.abs(left.combinedMultiplier - 1));
}

function buildReplayAttributionSnapshotFromExperience(row: JsonMap): BrainReplayAttributionSnapshot | null {
  const id = String(row.experience_id || row.decision_id || row.id || row.event_id || "").trim();
  if (!id) {
    return null;
  }
  const diagnostics = row.feature_diagnostics && typeof row.feature_diagnostics === "object"
    ? row.feature_diagnostics as Record<string, JsonMap>
    : {};
  const contributions = row.feature_contributions && typeof row.feature_contributions === "object"
    ? row.feature_contributions as Record<string, unknown>
    : {};
  const context = row.context && typeof row.context === "object"
    ? row.context as JsonMap
    : null;
  const statePayload = row.state && typeof row.state === "object"
    ? row.state as JsonMap
    : null;
  const nextStatePayload = row.next_state && typeof row.next_state === "object"
    ? row.next_state as JsonMap
    : row.nextState && typeof row.nextState === "object"
      ? row.nextState as JsonMap
      : null;
  const latentLabel = normalizeReplayLatentLabel(statePayload?.latent_label || context?.latent || row.latent_label);
  const latentNextLabel = normalizeReplayLatentLabel(nextStatePayload?.latent_label || context?.latent_next || row.latent_next || latentLabel);
  const latentTransition = toNumber(statePayload?.latent_transition ?? row.latent_transition, 0);
  const synthetic = Boolean(row.synthetic || context?.origin === "synthetic");
  const dreamSource = String(row.dream_source || row.source_experience_id || row.source_id || (synthetic ? "synthetic" : "real")).trim() || (synthetic ? "synthetic" : "real");
  const sampleWeight = toNumber(row.sample_weight, synthetic ? 0.2 : 1);
  const families = Object.entries(diagnostics)
    .map(([family, raw]) => ({
      family,
      contribution: toNumber(raw?.contribution ?? contributions[family], 0),
      shapLike: toNumber(raw?.shap_like, 0),
      marginalImpact: toNumber(raw?.marginal_impact, 0),
      correlation: toNumber(raw?.rolling_correlation, 0),
      learningRateHint: toNumber(raw?.learning_rate_hint, 1),
      wrongWay: Boolean(raw?.wrong_way),
    }))
    .sort((left, right) => Math.abs(right.contribution) - Math.abs(left.contribution));
  const fallbackFamilies = families.length > 0
    ? families
    : Object.entries(contributions)
      .map(([family, value]) => ({
        family,
        contribution: toNumber(value, 0),
        shapLike: 0,
        marginalImpact: 0,
        correlation: 0,
        learningRateHint: 1,
        wrongWay: false,
      }))
      .sort((left, right) => Math.abs(right.contribution) - Math.abs(left.contribution));
  const leader = fallbackFamilies[0] || null;
  const failureReasons = Array.isArray(row.failure_reasons)
    ? row.failure_reasons.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const agentLearningRates = normalizeReplayAgentLearningRates(row.agent_learning_rate_hints);
  return {
    id,
    action: String(row.action || "HOLD"),
    reward: toNumber(row.reward, 0),
    rawReward: toNumber(row.raw_reward ?? row.reward, 0),
    rewardScale: toNumber(row.reward_scale, 1),
    contextLabel: buildFeatureContextLabel(context),
    topFamily: leader?.family || "n/a",
    topContribution: leader?.contribution || 0,
    families: fallbackFamilies.slice(0, 4),
    latentLabel,
    latentNextLabel,
    latentTransition,
    latentShiftLabel: buildReplayLatentShiftLabel(latentLabel, latentNextLabel),
    synthetic,
    dreamSource,
    sampleWeight,
    dreamCount: 0,
    dreamWeight: 0,
    failureSource: formatReplayFailureSource(row.failure_source) || null,
    failureReasons,
    failureBlocking: Boolean(row.failure_blocking),
    agentLearningRates,
  };
}

function normalizeReplayAttributionSnapshot(raw: JsonMap | null | undefined): BrainReplayAttributionSnapshot | null {
  if (!raw) {
    return null;
  }
  const id = String(raw.id || raw.experience_id || raw.decision_id || "").trim();
  if (!id) {
    return null;
  }
  const families = Array.isArray(raw.families)
    ? raw.families
      .filter((item): item is JsonMap => Boolean(item) && typeof item === "object")
      .map((item) => ({
        family: String(item.family || "n/a").trim().toLowerCase() || "n/a",
        contribution: toNumber(item.contribution, 0),
        shapLike: toNumber(item.shapLike ?? item.shap_like, 0),
        marginalImpact: toNumber(item.marginalImpact ?? item.marginal_impact, 0),
        correlation: toNumber(item.correlation, 0),
        learningRateHint: toNumber(item.learningRateHint ?? item.learning_rate_hint, 1),
        wrongWay: Boolean(item.wrongWay ?? item.wrong_way),
      }))
      .sort((left, right) => Math.abs(right.contribution) - Math.abs(left.contribution))
    : [];
  const latentLabel = normalizeReplayLatentLabel(raw.latentLabel || raw.latent_label);
  const latentNextLabel = normalizeReplayLatentLabel(raw.latentNextLabel || raw.latent_next_label || latentLabel);
  const synthetic = Boolean(raw.synthetic);
  const failureReasonsValue = raw.failureReasons ?? raw.failure_reasons;
  const agentLearningRates = normalizeReplayAgentLearningRates(raw.agentLearningRates ?? raw.agent_learning_rates ?? raw.agent_learning_rate_hints);
  return {
    id,
    action: String(raw.action || "HOLD").trim().toUpperCase() || "HOLD",
    reward: toNumber(raw.reward, 0),
    rawReward: toNumber(raw.rawReward ?? raw.raw_reward ?? raw.reward, 0),
    rewardScale: toNumber(raw.rewardScale ?? raw.reward_scale, 1),
    contextLabel: String(raw.contextLabel || raw.context_label || "").trim() || buildFeatureContextLabel(null),
    topFamily: String(raw.topFamily || raw.top_family || families[0]?.family || "n/a").trim().toLowerCase() || "n/a",
    topContribution: toNumber(raw.topContribution ?? raw.top_contribution, families[0]?.contribution ?? 0),
    families,
    latentLabel,
    latentNextLabel,
    latentTransition: toNumber(raw.latentTransition ?? raw.latent_transition, 0),
    latentShiftLabel: String(raw.latentShiftLabel || raw.latent_shift_label || "").trim() || buildReplayLatentShiftLabel(latentLabel, latentNextLabel),
    synthetic,
    dreamSource: String(raw.dreamSource || raw.dream_source || (synthetic ? "synthetic" : "real")).trim() || (synthetic ? "synthetic" : "real"),
    sampleWeight: toNumber(raw.sampleWeight ?? raw.sample_weight, synthetic ? 0.2 : 1),
    dreamCount: Math.max(0, Math.round(toNumber(raw.dreamCount ?? raw.dream_count, 0))),
    dreamWeight: toNumber(raw.dreamWeight ?? raw.dream_weight, 0),
    failureSource: formatReplayFailureSource(raw.failureSource || raw.failure_source) || null,
    failureReasons: Array.isArray(failureReasonsValue)
      ? failureReasonsValue.map((item) => String(item || "").trim()).filter(Boolean)
      : [],
    failureBlocking: Boolean(raw.failureBlocking ?? raw.failure_blocking),
    agentLearningRates,
  };
}

function resolveRawChartAnchorPrice(
  marketMicro: JsonMap | null,
  marketDepth: JsonMap | null,
  latestQuote: JsonMap | null,
  fallback: number,
): number {
  const rawAnchor = toNumber(marketMicro?.raw_chart_anchor_price, 0);
  if (rawAnchor > 0) {
    return rawAnchor;
  }

  const microBid = toNumber(marketMicro?.best_bid, 0);
  const microAsk = toNumber(marketMicro?.best_ask, 0);
  if (microBid > 0 && microAsk > 0) {
    return (microBid + microAsk) * 0.5;
  }

  const depthBid = toNumber(marketDepth?.best_bid, 0);
  const depthAsk = toNumber(marketDepth?.best_ask, 0);
  if (depthBid > 0 && depthAsk > 0) {
    return (depthBid + depthAsk) * 0.5;
  }

  return microBid || microAsk || depthBid || depthAsk || toNumber(latestQuote?.last, fallback);
}

function clampPredictorOrderbookSignal(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function derivePredictorOrderbookSignals(marketDepth: JsonMap | null): { quoteFadeRate: number; bookFlipSignal: number; orderbookBids: number[][]; orderbookAsks: number[][] } {
  const depthPayload = (marketDepth?.depth_payload as JsonMap | undefined) || {};
  const normalizeRows = (value: unknown): number[][] => {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .map((row) => {
        const level = Array.isArray(row) ? row : [];
        const price = toNumber(level[0], 0);
        const size = toNumber(level[1], 0);
        return price > 0 && size > 0 ? [price, size] : null;
      })
      .filter((row): row is number[] => Array.isArray(row));
  };
  const orderbookBids = normalizeRows(depthPayload.bids).slice(0, 12);
  const orderbookAsks = normalizeRows(depthPayload.asks).slice(0, 12);
  if (orderbookBids.length === 0 || orderbookAsks.length === 0) {
    return { quoteFadeRate: 0, bookFlipSignal: 0, orderbookBids, orderbookAsks };
  }
  const sumNotional = (rows: number[][], limit: number) => rows.slice(0, limit).reduce((total, row) => total + row[0] * row[1], 0);
  const top3Bid = sumNotional(orderbookBids, 3);
  const top3Ask = sumNotional(orderbookAsks, 3);
  const top10Bid = sumNotional(orderbookBids, 10);
  const top10Ask = sumNotional(orderbookAsks, 10);
  const totalTop3 = top3Bid + top3Ask;
  const totalTop10 = top10Bid + top10Ask;
  const touchDensity = totalTop3 / Math.max(totalTop10, 1e-9);
  const top3Imbalance = (top3Bid - top3Ask) / Math.max(totalTop3, 1e-9);
  const top10Imbalance = (top10Bid - top10Ask) / Math.max(totalTop10, 1e-9);
  return {
    quoteFadeRate: clampPredictorOrderbookSignal((1 - touchDensity) * 3, 0, 3),
    bookFlipSignal: clampPredictorOrderbookSignal(top3Imbalance - top10Imbalance, -1, 1),
    orderbookBids,
    orderbookAsks,
  };
}

function instrumentLabel(item: JsonMap): string {
  return String(item.symbol || item.instrument || item.strategy_id || item.ticket_key || "-");
}

function classifyInstrument(symbol: string): string {
  const normalized = symbol.toUpperCase();
  if (["BTC", "ETH", "SOL", "XRP", "BNB", "AVAX", "DOGE", "ADA"].some((token) => normalized.includes(token))) {
    return "crypto";
  }
  if (/^[A-Z]{6}$/.test(normalized)) {
    return "fx";
  }
  if (["US30", "SPX", "NAS", "NQ", "DAX", "GER40", "UK100", "DJI"].some((token) => normalized.includes(token))) {
    return "indices";
  }
  if (["XAU", "XAG", "WTI", "BRENT", "OIL"].some((token) => normalized.includes(token))) {
    return "cfd";
  }
  if (["PERP", "FUT", "ES", "CL", "GC"].some((token) => normalized.includes(token))) {
    return "futures";
  }
  return "other";
}

function volumeFromDelta(delta: number, index: number): number {
  return Math.max(1, Math.round(Math.abs(delta) * 140 + 14 + (index % 5) * 6));
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function quantileSortedAsc(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const qq = Math.max(0, Math.min(1, q));
  const pos = (values.length - 1) * qq;
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  if (lower === upper) return values[lower];
  const weight = pos - lower;
  return values[lower] * (1 - weight) + values[upper] * weight;
}

function downloadJsonFile(filename: string, payload: unknown): void {
  if (typeof window === "undefined") return;
  const text = JSON.stringify(payload, null, 2);
  const blob = new Blob([text], { type: "application/json;charset=utf-8" });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(href);
}

function csvCell(value: unknown): string {
  const text = String(value ?? "");
  const escaped = text.replace(/"/g, '""');
  return /[",\n]/.test(escaped) ? `"${escaped}"` : escaped;
}

function downloadCsvFile(filename: string, rows: Array<Array<string | number>>): void {
  if (typeof window === "undefined") return;
  const csv = rows.map((row) => row.map((cell) => csvCell(cell)).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(href);
}

const SELF_LEARNING_STATE_CACHE_TTL_MS = 6000;
const SELF_LEARNING_SCOPES_CACHE_TTL_MS = 20000;

const selfLearningStateCache = new Map<string, {
  atMs: number;
  value: {
    state: SelfLearningV4PersistedState | null;
    storage: SelfLearningV4Storage;
    updatedAt: string | null;
    unauthorized: boolean;
  };
}>();
const selfLearningStateInflight = new Map<string, Promise<{
  state: SelfLearningV4PersistedState | null;
  storage: SelfLearningV4Storage;
  updatedAt: string | null;
  unauthorized: boolean;
}>>();

const selfLearningScopesCache = new Map<string, {
  atMs: number;
  value: {
    items: SelfLearningV4ScopeSummary[];
    storage: SelfLearningV4Storage;
  };
}>();
const selfLearningScopesInflight = new Map<string, Promise<{
  items: SelfLearningV4ScopeSummary[];
  storage: SelfLearningV4Storage;
}>>();

async function fetchSelfLearningV4State(scope: { accountId: string; symbol: string; timeframe: string }): Promise<{
  state: SelfLearningV4PersistedState | null;
  storage: SelfLearningV4Storage;
  updatedAt: string | null;
  unauthorized: boolean;
}> {
  const cacheKey = `${scope.accountId}::${scope.symbol}::${scope.timeframe}`;
  const nowMs = Date.now();
  const cached = selfLearningStateCache.get(cacheKey);
  if (cached && nowMs - cached.atMs <= SELF_LEARNING_STATE_CACHE_TTL_MS) {
    return cached.value;
  }
  const inflight = selfLearningStateInflight.get(cacheKey);
  if (inflight) {
    return inflight;
  }

  const params = new URLSearchParams({
    account_id: scope.accountId,
    symbol: scope.symbol,
    timeframe: scope.timeframe,
  });
  const requestPromise = (async () => {
    const response = await fetch(`/api/strategies/self-learning-v4?${params.toString()}`, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`self_learning_v4_get_${response.status}`);
    }
    const payload = await response.json() as {
      state?: SelfLearningV4PersistedState | null;
      storage?: SelfLearningV4Storage;
      updatedAt?: string | null;
      detail?: string;
      upstream_status?: number;
    };
    const unauthorized = response.status === 401
      || payload.detail === "self_learning_v4_anonymous_degraded"
      || payload.upstream_status === 401
      || payload.upstream_status === 403;
    const value = {
      state: payload.state || null,
      storage: payload.storage || "unknown",
      updatedAt: payload.updatedAt || payload.state?.updatedAt || null,
      unauthorized,
    };
    selfLearningStateCache.set(cacheKey, { atMs: Date.now(), value });
    if (selfLearningStateCache.size > 80) {
      for (const [key, entry] of selfLearningStateCache.entries()) {
        if (Date.now() - entry.atMs > SELF_LEARNING_STATE_CACHE_TTL_MS * 4) {
          selfLearningStateCache.delete(key);
        }
        if (selfLearningStateCache.size <= 60) {
          break;
        }
      }
    }
    return value;
  })();

  selfLearningStateInflight.set(cacheKey, requestPromise);
  try {
    return await requestPromise;
  } finally {
    selfLearningStateInflight.delete(cacheKey);
  }
}

async function saveSelfLearningV4State(state: Omit<SelfLearningV4PersistedState, "version" | "updatedAt">): Promise<{
  state: SelfLearningV4PersistedState;
  storage: SelfLearningV4Storage;
  updatedAt: string | null;
}> {
  const response = await fetch("/api/strategies/self-learning-v4", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(state),
  });
  if (!response.ok) {
    throw new Error(`self_learning_v4_put_${response.status}`);
  }
  const payload = await response.json() as {
    state: SelfLearningV4PersistedState;
    storage?: SelfLearningV4Storage;
    updatedAt?: string | null;
  };
  return {
    state: payload.state,
    storage: payload.storage || "unknown",
    updatedAt: payload.updatedAt || payload.state?.updatedAt || null,
  };
}

async function fetchSelfLearningV4Scopes(params: {
  accountId?: string;
  symbol?: string;
  timeframe?: string;
  limit?: number;
}): Promise<{
  items: SelfLearningV4ScopeSummary[];
  storage: SelfLearningV4Storage;
}> {
  const cacheKey = JSON.stringify({
    accountId: params.accountId || "",
    symbol: params.symbol || "",
    timeframe: params.timeframe || "",
    limit: params.limit || 120,
  });
  const nowMs = Date.now();
  const cached = selfLearningScopesCache.get(cacheKey);
  if (cached && nowMs - cached.atMs <= SELF_LEARNING_SCOPES_CACHE_TTL_MS) {
    return cached.value;
  }
  const inflight = selfLearningScopesInflight.get(cacheKey);
  if (inflight) {
    return inflight;
  }

  const query = new URLSearchParams();
  if (params.accountId) {
    query.set("account_id", params.accountId);
  }
  if (params.symbol) {
    query.set("symbol", params.symbol);
  }
  if (params.timeframe) {
    query.set("timeframe", params.timeframe);
  }
  query.set("limit", String(params.limit || 120));
  const requestPromise = (async () => {
    const response = await fetch(`/api/strategies/self-learning-v4/scopes?${query.toString()}`, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`self_learning_v4_scopes_${response.status}`);
    }
    const payload = await response.json() as {
      items?: SelfLearningV4ScopeSummary[];
      storage?: SelfLearningV4Storage;
    };
    const value = {
      items: Array.isArray(payload.items) ? payload.items : [],
      storage: payload.storage || "unknown",
    };
    selfLearningScopesCache.set(cacheKey, { atMs: Date.now(), value });
    if (selfLearningScopesCache.size > 80) {
      for (const [key, entry] of selfLearningScopesCache.entries()) {
        if (Date.now() - entry.atMs > SELF_LEARNING_SCOPES_CACHE_TTL_MS * 3) {
          selfLearningScopesCache.delete(key);
        }
        if (selfLearningScopesCache.size <= 60) {
          break;
        }
      }
    }
    return value;
  })();

  selfLearningScopesInflight.set(cacheKey, requestPromise);
  try {
    return await requestPromise;
  } finally {
    selfLearningScopesInflight.delete(cacheKey);
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function openPrintPdfReport(title: string, lines: string[]): void {
  if (typeof window === "undefined") return;
  const report = window.open("", "_blank", "noopener,noreferrer,width=900,height=700");
  if (!report) return;
  const body = lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("");
  report.document.write(`<!doctype html><html><head><title>${escapeHtml(title)}</title><style>body{font-family:Arial,sans-serif;padding:24px;color:#111}h1{font-size:20px;margin:0 0 12px}ul{padding-left:18px}li{margin:6px 0;font-size:13px}small{color:#666}</style></head><body><h1>${escapeHtml(title)}</h1><ul>${body}</ul><small>Use Print -> Save as PDF</small></body></html>`);
  report.document.close();
  report.focus();
  report.print();
}

// ── PORTFOLIO CORRELATION LAYER ───────────────────────────────────────────────
// Utilities for correlation matrix, shrinkage, and cluster detection

function pearsonCorrelation(x: number[], y: number[]): number {
  if (x.length < 2 || y.length < 2 || x.length !== y.length) return NaN;
  const n = x.length;
  const meanX = average(x);
  const meanY = average(y);
  let numerator = 0;
  let sumSqX = 0;
  let sumSqY = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    numerator += dx * dy;
    sumSqX += dx * dx;
    sumSqY += dy * dy;
  }
  const denominator = Math.sqrt(sumSqX * sumSqY);
  return denominator === 0 ? NaN : numerator / denominator;
}

function shrinkageCorrelation(rawCorr: number, sampleSize: number, shrinkStrength: number = 10): number {
  if (!Number.isFinite(rawCorr)) return NaN;
  // Shrink towards 0: corr_shrunk = rawCorr * (n / (n + k))
  const shrinkFactor = sampleSize / (sampleSize + shrinkStrength);
  return rawCorr * shrinkFactor;
}

function sigmoidPenalty(x: number, scale: number = 2): number {
  // Sigmoid-like: 1 - exp(-scale * x)
  // Smooth, no jagged transitions, asymptotic to 1
  return 1 - Math.exp(-scale * Math.max(0, x));
}

function confidenceInterval(winrate: number, n: number, zScore: number = 1.96): {low: number; high: number; width: number} {
  if (n < 2) return { low: 0, high: 1, width: 1 };
  const p = winrate;
  const margin = zScore * Math.sqrt((p * (1 - p)) / n);
  return {
    low: Math.max(0, p - margin),
    high: Math.min(1, p + margin),
    width: margin * 2,
  };
}

function emaLast(values: number[], period: number): number {
  if (!values.length) return 0;
  const alpha = 2 / (period + 1);
  let ema = values[0];
  for (let i = 1; i < values.length; i++) {
    ema = alpha * values[i] + (1 - alpha) * ema;
  }
  return ema;
}

function timeframeSeconds(timeframe: string): number {
  return Math.max(1, Math.round(timeframeToMs(timeframe) / 1000));
}

function nextChartMotionPreset(current: ChartMotionPreset): ChartMotionPreset {
  if (current === "scalping") return "swing";
  if (current === "swing") return "auto";
  if (current === "auto") return "scalping";
  if (current === "stable") return "swing";
  if (current === "aggressive") return "scalping";
  return "auto";
}

function toV41MotionPreset(preset: ChartMotionPreset): ChartMotionPreset {
  if (preset === "aggressive") return "scalping";
  if (preset === "stable") return "swing";
  if (preset === "balanced") return "auto";
  return preset;
}

function parseTimestampLike(value: string): number | null {
  const direct = Date.parse(value);
  if (Number.isFinite(direct)) {
    return direct;
  }

  const clockMatch = value.match(/(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!clockMatch) {
    return null;
  }

  const now = new Date();
  now.setHours(Number(clockMatch[1]), Number(clockMatch[2]), Number(clockMatch[3] || "0"), 0);
  return now.getTime();
}

function toTimeBucketKey(value: string | number, timeframe: string): string {
  const stepMs = timeframeSeconds(timeframe) * 1000;
  const parsed = typeof value === "number" ? value : parseTimestampLike(value);
  if (!parsed || !Number.isFinite(parsed)) {
    return "";
  }
  return String(Math.floor(parsed / stepMs) * stepMs);
}

function incidentSeverityLabel(item: JsonMap): string {
  return String(item.severity || item.level || item.priority || "info").toLowerCase();
}

function incidentSeverityRank(item: JsonMap): number {
  const severity = incidentSeverityLabel(item);
  if (["critical", "sev1", "p1", "high"].includes(severity)) {
    return 4;
  }
  if (["major", "sev2", "p2", "medium"].includes(severity)) {
    return 3;
  }
  if (["minor", "sev3", "p3", "low", "warning", "warn"].includes(severity)) {
    return 2;
  }
  return 1;
}

function incidentStatusRank(item: JsonMap): number {
  const status = String(item.status || "open").toLowerCase();
  if (["open", "new", "triggered"].includes(status)) {
    return 5;
  }
  if (["investigating", "triage", "mitigating"].includes(status)) {
    return 4;
  }
  if (["monitoring", "watching"].includes(status)) {
    return 3;
  }
  if (["resolved", "mitigated"].includes(status)) {
    return 2;
  }
  if (["closed", "done"].includes(status)) {
    return 1;
  }
  return 3;
}

function incidentSlaLabel(item: JsonMap): string {
  return Boolean(item.sla_breached) ? "breach" : "within";
}

function volatilityRegime(points: QuotePoint[]): "low" | "medium" | "high" {
  if (points.length < 6) {
    return "low";
  }
  const returns: number[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1].value;
    const current = points[index].value;
    if (previous > 0) {
      returns.push((current - previous) / previous);
    }
  }
  const mean = average(returns);
  const variance = average(returns.map((item) => (item - mean) ** 2));
  const sigma = Math.sqrt(Math.max(0, variance));
  if (sigma > 0.006) {
    return "high";
  }
  if (sigma > 0.0025) {
    return "medium";
  }
  return "low";
}

function weightedVwap(points: QuotePoint[]): number {
  if (points.length === 0) {
    return 0;
  }
  let weightedPrice = 0;
  let weightedVolume = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const previous = points[index - 1]?.value ?? current.value;
    const volume = volumeFromDelta(current.value - previous, index);
    weightedPrice += current.value * volume;
    weightedVolume += volume;
  }
  return weightedVolume === 0 ? points[points.length - 1].value : weightedPrice / weightedVolume;
}

function pointTimestamp(label: string): number {
  const value = Date.parse(label);
  return Number.isFinite(value) ? value : 0;
}

function distanceBps(price: number, reference: number): number {
  if (!(price > 0) || !(reference > 0)) {
    return 0;
  }
  return ((price - reference) / reference) * 10000;
}

function anchoredPointsFrom(points: QuotePoint[], thresholdMs: number): QuotePoint[] {
  if (!Number.isFinite(thresholdMs) || thresholdMs <= 0 || points.length === 0) {
    return points;
  }
  const filtered = points.filter((point) => pointTimestamp(point.label) >= thresholdMs);
  return filtered.length > 0 ? filtered : points;
}

function startOfUtcDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setUTCHours(0, 0, 0, 0);
  return date.getTime();
}

function startOfUtcWeek(timestamp: number): number {
  const date = new Date(timestamp);
  const day = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - day);
  date.setUTCHours(0, 0, 0, 0);
  return date.getTime();
}

function startOfUtcMonth(timestamp: number): number {
  const date = new Date(timestamp);
  date.setUTCDate(1);
  date.setUTCHours(0, 0, 0, 0);
  return date.getTime();
}

function deriveMarketSessionLabel(timestamp: number): string {
  const resolved = Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now();
  const hour = new Date(resolved).getUTCHours();
  if (hour < 8) {
    return "asia";
  }
  if (hour < 13) {
    return "london";
  }
  if (hour < 21) {
    return "new-york";
  }
  return "off";
}

function findImpulseAnchorIndex(points: QuotePoint[]): number {
  if (points.length <= 6) {
    return Math.max(0, points.length - 1);
  }
  const start = Math.max(0, points.length - 36);
  const current = points[points.length - 1]?.value || 0;
  let bestIndex = start;
  let bestScore = -1;
  for (let index = start; index < points.length - 2; index += 1) {
    const anchor = points[index]?.value || 0;
    if (!(anchor > 0)) {
      continue;
    }
    const segment = points.slice(index);
    const move = Math.abs((current - anchor) / anchor);
    const persistence = Math.min(1, segment.length / 18);
    const realizedVol = average(segment.slice(1).map((point, offset) => {
      const previous = segment[offset]?.value || point.value;
      return previous > 0 ? Math.abs((point.value - previous) / previous) : 0;
    }));
    const score = move * 0.7 + persistence * 0.2 + Math.min(0.2, realizedVol * 18);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  return bestIndex;
}

function findSwingAnchorIndex(points: QuotePoint[]): number {
  if (points.length <= 5) {
    return Math.max(0, points.length - 1);
  }
  const start = Math.max(2, points.length - 48);
  let bestIndex = start;
  let bestScore = -1;
  for (let index = start; index < points.length - 2; index += 1) {
    const left = points.slice(Math.max(0, index - 2), index).map((point) => point.value);
    const right = points.slice(index + 1, index + 3).map((point) => point.value);
    const current = points[index]?.value || 0;
    if (left.length === 0 || right.length === 0 || !(current > 0)) {
      continue;
    }
    const leftMax = Math.max(...left);
    const leftMin = Math.min(...left);
    const rightMax = Math.max(...right);
    const rightMin = Math.min(...right);
    const isPivot = current >= Math.max(leftMax, rightMax) || current <= Math.min(leftMin, rightMin);
    if (!isPivot) {
      continue;
    }
    const neighborMean = average([...left, ...right]);
    const score = Math.abs((current - neighborMean) / Math.max(Math.abs(neighborMean), 1e-9));
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  return bestIndex;
}

function buildMultiAnchorVwap(points: QuotePoint[]): MultiAnchorVwapSnapshot {
  if (points.length === 0) {
    return {
      session: 0,
      day: 0,
      week: 0,
      month: 0,
      swing: 0,
      impulse: 0,
      sessionDistanceBps: 0,
      dayDistanceBps: 0,
      weekDistanceBps: 0,
      monthDistanceBps: 0,
      swingDistanceBps: 0,
      impulseDistanceBps: 0,
      primaryLabel: "n/a",
      primaryDistanceBps: 0,
      anchorCompressionBps: 0,
      confluenceScore: 0,
    };
  }
  const lastPoint = points[points.length - 1];
  const currentPrice = lastPoint?.value || 0;
  const currentTs = pointTimestamp(lastPoint?.label || "") || Date.now();
  const sessionPoints = points.slice(-12);
  const dayPoints = anchoredPointsFrom(points, startOfUtcDay(currentTs));
  const weekPoints = anchoredPointsFrom(points, startOfUtcWeek(currentTs));
  const monthPoints = anchoredPointsFrom(points, startOfUtcMonth(currentTs));
  const swingIndex = findSwingAnchorIndex(points);
  const impulseIndex = findImpulseAnchorIndex(points);
  const swingPoints = points.slice(swingIndex);
  const impulsePoints = points.slice(impulseIndex);
  const session = weightedVwap(sessionPoints);
  const day = weightedVwap(dayPoints);
  const week = weightedVwap(weekPoints);
  const month = weightedVwap(monthPoints);
  const swing = weightedVwap(swingPoints);
  const impulse = weightedVwap(impulsePoints);
  const anchors = [
    { label: "session", value: session },
    { label: "day", value: day },
    { label: "week", value: week },
    { label: "month", value: month },
    { label: "swing", value: swing },
    { label: "impulse", value: impulse },
  ].filter((anchor) => anchor.value > 0);
  const distances = anchors.map((anchor) => ({ label: anchor.label, distance: distanceBps(currentPrice, anchor.value) }));
  const primary = distances.reduce((best, candidate) => (Math.abs(candidate.distance) < Math.abs(best.distance) ? candidate : best), distances[0] || { label: "n/a", distance: 0 });
  const anchorValues = anchors.map((anchor) => anchor.value);
  const anchorMean = average(anchorValues);
  const anchorCompressionBps = anchorValues.length > 1 && anchorMean > 0
    ? ((Math.max(...anchorValues) - Math.min(...anchorValues)) / anchorMean) * 10000
    : 0;
  const anchorsNearPrice = distances.filter((item) => Math.abs(item.distance) <= 12).length;
  const confluenceScore = clamp(
    anchorsNearPrice * 0.22 + (anchorCompressionBps <= 18 ? 0.22 : anchorCompressionBps <= 32 ? 0.1 : 0),
    0,
    1,
  );
  return {
    session,
    day,
    week,
    month,
    swing,
    impulse,
    sessionDistanceBps: distanceBps(currentPrice, session),
    dayDistanceBps: distanceBps(currentPrice, day),
    weekDistanceBps: distanceBps(currentPrice, week),
    monthDistanceBps: distanceBps(currentPrice, month),
    swingDistanceBps: distanceBps(currentPrice, swing),
    impulseDistanceBps: distanceBps(currentPrice, impulse),
    primaryLabel: primary.label,
    primaryDistanceBps: primary.distance,
    anchorCompressionBps,
    confluenceScore,
  };
}

function buildLiquidityEngineSnapshot(
  orderbookBids: number[][],
  orderbookAsks: number[][],
  spreadBps: number,
  quoteFadeRate: number,
  bookFlipSignal: number,
  orderflowImbalance: number,
  anchors: MultiAnchorVwapSnapshot,
): LiquidityEngineSnapshot {
  const sumNotional = (rows: number[][], limit: number) => rows.slice(0, limit).reduce((total, row) => total + row[0] * row[1], 0);
  const top3Bid = sumNotional(orderbookBids, 3);
  const top3Ask = sumNotional(orderbookAsks, 3);
  const top5Bid = sumNotional(orderbookBids, 5);
  const top5Ask = sumNotional(orderbookAsks, 5);
  const top10Bid = sumNotional(orderbookBids, 10);
  const top10Ask = sumNotional(orderbookAsks, 10);
  const touchDensity = (top3Bid + top3Ask) / Math.max(top10Bid + top10Ask, 1e-9);
  const restingImbalance = (top5Bid - top5Ask) / Math.max(top5Bid + top5Ask, 1e-9);
  const thinTouch = clamp(1 - touchDensity, 0, 1);
  const spreadStress = clamp(spreadBps / 12, 0, 1);
  const liquidityVacuum = clamp(thinTouch * 0.56 + clamp(quoteFadeRate / 3, 0, 1) * 0.24 + spreadStress * 0.2, 0, 1);
  const sweepRisk = clamp(
    thinTouch * 0.4
      + Math.abs(bookFlipSignal) * 0.2
      + clamp(quoteFadeRate / 3, 0, 1) * 0.16
      + spreadStress * 0.12
      + Math.abs(orderflowImbalance) * 0.12,
    0,
    1,
  );
  const liquidityPressure = clamp(
    restingImbalance * 0.46
      + orderflowImbalance * 0.24
      + bookFlipSignal * 0.14
      - Math.sign(anchors.primaryDistanceBps || 0) * Math.min(0.26, Math.abs(anchors.primaryDistanceBps) / 40)
      - Math.max(0, liquidityVacuum - 0.52) * 0.14,
    -1,
    1,
  );
  const supportScore = clamp(
    Math.max(0, restingImbalance) * 0.5
      + Math.max(0, liquidityPressure) * 0.28
      + anchors.confluenceScore * 0.22,
    0,
    1,
  );
  const resistanceScore = clamp(
    Math.max(0, -restingImbalance) * 0.5
      + Math.max(0, -liquidityPressure) * 0.28
      + anchors.confluenceScore * 0.22,
    0,
    1,
  );
  const liquidityEngineScore = clamp(
    Math.abs(liquidityPressure) * 0.34
      + Math.abs(restingImbalance) * 0.22
      + sweepRisk * 0.2
      + liquidityVacuum * 0.12
      + anchors.confluenceScore * 0.12,
    0,
    1,
  );
  const stateLabel = sweepRisk >= 0.68 && liquidityVacuum >= 0.45
    ? "vacuum"
    : liquidityPressure >= 0.18
      ? "bid-support"
      : liquidityPressure <= -0.18
        ? "ask-wall"
        : "balanced";
  return {
    restingBidUsd: top10Bid,
    restingAskUsd: top10Ask,
    restingImbalance,
    touchDensity: clamp(touchDensity, 0, 1),
    sweepRisk,
    liquidityVacuum,
    supportScore,
    resistanceScore,
    liquidityPressure,
    liquidityEngineScore,
    stateLabel,
  };
}

async function fetchJson(path: string, options?: { allowUnauthorized?: boolean }): Promise<unknown | null> {
  const response = await fetch(path, { cache: "no-store" });
  if (response.status === 401 && options?.allowUnauthorized) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Impossible de charger ${path}`);
  }
  return response.json();
}

class WSCircuitBreaker {
  private static MAX_401_RETRIES = 5;
  private static COOLDOWN_MS = 60_000;
  private static LOCKED_UNTIL = 0;
  private static FAILURES_401 = 0;

  static isLocked(): boolean {
    if (Date.now() < this.LOCKED_UNTIL) {
      return true;
    }
    if (this.LOCKED_UNTIL > 0) {
      this.LOCKED_UNTIL = 0;
      this.FAILURES_401 = 0;
    }
    return false;
  }

  static report401() {
    this.FAILURES_401++;
    if (this.FAILURES_401 >= this.MAX_401_RETRIES) {
      this.LOCKED_UNTIL = Date.now() + this.COOLDOWN_MS;
      console.warn(`[WSCircuitBreaker] 401 storm detected. Locking WS auth for ${this.COOLDOWN_MS}ms.`);
    }
  }

  static reportSuccess() {
    this.FAILURES_401 = 0;
    this.LOCKED_UNTIL = 0;
  }
}

async function fetchWsToken(): Promise<string | null> {
  if (WSCircuitBreaker.isLocked()) {
    return null;
  }
  try {
    const response = await fetch("/api/auth/ws-token", { cache: "no-store" });
    if (response.status === 401) {
      WSCircuitBreaker.report401();
      return "__UNAUTHORIZED__";
    }
    if (!response.ok) {
      return null;
    }
    const payload = await response.json();
    const token = typeof payload?.token === "string" && payload.token ? payload.token : null;
    if (token) {
      WSCircuitBreaker.reportSuccess();
    }
    return token;
  } catch {
    return null;
  }
}

function buildExecutionTelemetryWsUrl(
  token: string,
  limit: number,
  context?: {
    requestType?: string;
    priority?: string;
    volatility?: string;
    signalState?: string;
    symbol?: string;
  },
): string {
  if (typeof window === "undefined") {
    return "";
  }
  const base = buildControlPlaneWsBase();
  const params = new URLSearchParams({
    token,
    limit: String(limit),
  });
  if (context?.requestType) params.set("request_type", context.requestType);
  if (context?.priority) params.set("priority", context.priority);
  if (context?.volatility) params.set("volatility", context.volatility);
  if (context?.signalState) params.set("signal_state", context.signalState);
  if (context?.symbol) params.set("symbol", context.symbol);
  return `${base}/ws/v1/execution/telemetry?${params.toString()}`;
}

function buildControlPlaneWsBase(): string {
  const configured =
    process.env.NEXT_PUBLIC_CONTROL_PLANE_WS_BASE?.trim() ||
    process.env.NEXT_PUBLIC_CONTROL_PLANE_URL?.trim() ||
    "";

  if (typeof window === "undefined") {
    if (!configured) {
      return "";
    }
    try {
      const parsed = new URL(configured);
      const protocol = parsed.protocol === "https:" || parsed.protocol === "wss:" ? "wss" : "ws";
      return `${protocol}://${parsed.host}`;
    } catch {
      return "";
    }
  }

  const currentProtocol = window.location.protocol === "https:" ? "wss" : "ws";
  const currentBase = `${currentProtocol}://${window.location.host}`;

  if (!configured) {
    return currentBase;
  }

  try {
    const parsed = new URL(configured);
    if (["localhost", "127.0.0.1", "0.0.0.0", "control-plane"].includes(parsed.hostname)) {
      return currentBase;
    }
    const protocol = parsed.protocol === "https:" || parsed.protocol === "wss:" ? "wss" : "ws";
    if (window.location.protocol === "https:" && protocol !== "wss") {
      return currentBase;
    }
    return `${protocol}://${parsed.host}`;
  } catch {
    return currentBase;
  }
}

function buildMarketQuotesWsUrl(token: string, instrument?: string): string {
  if (typeof window === "undefined") {
    return "";
  }
  const base = buildControlPlaneWsBase();
  const instrumentPart = instrument ? `&instrument=${encodeURIComponent(instrument)}` : "";
  return `${base}/ws/v1/market/quotes?token=${encodeURIComponent(token)}${instrumentPart}`;
}

function decisionIdFrom(item: JsonMap): string {
  return String(item.decision_id || "").trim();
}

function sortIsoAscending(left: string, right: string): number {
  return new Date(left).getTime() - new Date(right).getTime();
}

function formatClock(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return `${String(parsed.getHours()).padStart(2, "0")}:${String(parsed.getMinutes()).padStart(2, "0")}:${String(parsed.getSeconds()).padStart(2, "0")}`;
}

function formatTimeKeyLabel(timeKey: string | null): string {
  if (!timeKey) {
    return "--:--:--";
  }
  const parsed = Number(timeKey);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return "--:--:--";
  }
  return formatClock(new Date(parsed).toISOString());
}

function clampIndex(value: number, maxIndex: number): number {
  return Math.max(0, Math.min(maxIndex, value));
}

function pickTimestamp(item: JsonMap, candidates: string[]): string {
  for (const key of candidates) {
    const value = String(item[key] || "").trim();
    if (value) {
      return value;
    }
  }
  return "";
}

export default function TradingTerminalPage() {
  const [layoutEditMode, setLayoutEditMode] = useState(false);
  const [isHydrated, setIsHydrated] = useState(false);
  const [snapshot, setSnapshot] = useState<JsonMap | null>(null);
  const [readiness, setReadiness] = useState<JsonMap | null>(null);
  const [aiHealth, setAiHealth] = useState<JsonMap | null>(null);
  const [overview, setOverview] = useState<JsonMap | null>(null);
  const [mt5Health, setMt5Health] = useState<JsonMap | null>(null);
  const [incidents, setIncidents] = useState<JsonMap[]>([]);
  const [pendingLive, setPendingLive] = useState<JsonMap[]>([]);
  const [outcomes, setOutcomes] = useState<JsonMap[]>([]);
  const [quotes, setQuotes] = useState<JsonMap[]>([]);
  const [positions, setPositions] = useState<JsonMap[]>([]);
  const [balance, setBalance] = useState<JsonMap | null>(null);
  const [performanceSummary, setPerformanceSummary] = useState<PerformanceSummaryPayload | null>(null);
  const [performanceAttribution, setPerformanceAttribution] = useState<PerformanceAttributionItem[]>([]);
  const [performanceCapitalSources, setPerformanceCapitalSources] = useState<PerformanceCapitalSource[]>([]);
  const [investorReports, setInvestorReports] = useState<InvestorReportItem[]>([]);
  const [orderbook, setOrderbook] = useState<JsonMap | null>(null);
  const [marketDepth, setMarketDepth] = useState<JsonMap | null>(null);
  const [marketMicro, setMarketMicro] = useState<JsonMap | null>(null);
  const [ohlcvBars, setOhlcvBars] = useState<OhlcvBar[]>([]);
  const [nativeTrades, setNativeTrades] = useState<JsonMap[]>([]);
  const [sessionState, setSessionState] = useState<JsonMap | null>(null);
  const [marketBusMeta, setMarketBusMeta] = useState<JsonMap | null>(null);
  const [marketBusKernelTelemetry, setMarketBusKernelTelemetry] = useState<MarketDataBusKernelTelemetry>(DEFAULT_MARKET_BUS_KERNEL_TELEMETRY);
  const [marketBusLastSyncAt, setMarketBusLastSyncAt] = useState<string | null>(null);
  const [routingScore, setRoutingScore] = useState<JsonMap | null>(null);
  const [executionTelemetry, setExecutionTelemetry] = useState<JsonMap[]>([]);
  const [ohlcvStreamState, setOhlcvStreamState] = useState<"offline" | "connecting" | "live">("offline");
  const [depthStreamState, setDepthStreamState] = useState<"offline" | "connecting" | "live">("offline");
  const [telemetryStreamState, setTelemetryStreamState] = useState<"offline" | "connecting" | "live">("offline");
  const [replayDecisionId, setReplayDecisionId] = useState("");
  const [replayPayload, setReplayPayload] = useState<JsonMap | null>(null);
  const [replayNetworkByDecisionId, setReplayNetworkByDecisionId] = useState<Record<string, JsonMap>>({});
  const [replayLoading, setReplayLoading] = useState(false);
  const [replayError, setReplayError] = useState<string | null>(null);
  const [authStatus, setAuthStatus] = useState<AuthSessionStatus>("unknown");
  const [authSessionRequired, setAuthSessionRequired] = useState(true);
  const [publicOpsRefreshPaused, setPublicOpsRefreshPaused] = useState(false);
  const [quoteHistory, setQuoteHistory] = useState<QuoteHistoryMap>({});
  const [error, setError] = useState<string | null>(null);
  const [signalActionToast, setSignalActionToast] = useState<MarketSignalAlertToast | null>(null);
  const [signalAlertBadgeCount, setSignalAlertBadgeCount] = useState(0);
  const [signalConfidenceDrift, setSignalConfidenceDrift] = useState<SignalConfidenceDrift>("FLAT");
  const [busy, setBusy] = useState(false);
  const [tradeResult, setTradeResult] = useState<JsonMap | null>(null);
  const [chartKernelPerf, setChartKernelPerf] = useState({ fps: 60, frameTimeMs: 16.7, cpuLoad: 1, workerLatencyMs: 0 });
  const [chartPerceptualTelemetry, setChartPerceptualTelemetry] = useState<ChartPerceptualTelemetry | null>(null);
  const [gpuPerceptualTelemetry, setGpuPerceptualTelemetry] = useState<GpuPerceptualTelemetry | null>(null);
  const [chartPerceptualDebugOpen, setChartPerceptualDebugOpen] = useState(false);
  const [terminalComputePerfEnabled, setTerminalComputePerfEnabled] = useState(false);
  const [terminalComputePerfSummary, setTerminalComputePerfSummary] = useState<TerminalComputePerfEntry[]>([]);
  const [kernelBenchmarkRate, setKernelBenchmarkRate] = useState(0);
  const [v8TrainingStats, setV8TrainingStats] = useState<PredictorEngineV8TrainingStats>({ trainedSamples: 0, updatedAt: null, weightShift: 0 });
  const [v8PersistenceLoaded, setV8PersistenceLoaded] = useState(false);
  const [backendPredictorSnapshot, setBackendPredictorSnapshot] = useState<JsonMap | null>(null);
  const [backendPredictorStats, setBackendPredictorStats] = useState<JsonMap | null>(null);
  const [replayAttributionByDecisionId, setReplayAttributionByDecisionId] = useState<Record<string, BrainReplayAttributionSnapshot>>({});

  const toggleTerminalComputePerf = useCallback(() => {
    if (typeof window === "undefined") {
      return;
    }
    setTerminalComputePerfEnabled((current) => {
      const next = !current;
      window.localStorage.setItem(TERMINAL_COMPUTE_PERF_STORAGE_KEY, next ? "1" : "0");
      if (!next) {
        clearTerminalComputePerf();
        setTerminalComputePerfSummary([]);
      }
      return next;
    });
  }, []);

  const [environmentFilter, setEnvironmentFilter] = useState("all");
  const [marketFilter, setMarketFilter] = useState("all");
  const [symbolFilter, setSymbolFilter] = useState("");
  const [severityFilter, setSeverityFilter] = useState("all");
  const [uiMode, setUiMode] = useUiMode();
  const [chartMotionPreset, setChartMotionPreset] = useChartMotionPreset();
  const chartMotionClass = chartMotionPreset === "scalping"
    ? "aggressive"
    : chartMotionPreset === "swing"
      ? "stable"
      : chartMotionPreset === "auto"
        ? "balanced"
        : chartMotionPreset;
  const [chartSnapEnabled, setChartSnapEnabled] = useChartSnapEnabled();
  const [chartSnapPriority, setChartSnapPriority] = useChartSnapPriority();
  const [chartReleaseSendMode, setChartReleaseSendMode] = useChartReleaseSendMode();
  const [chartHapticMode, setChartHapticMode] = useChartHapticMode();
  const [layoutPreset, setLayoutPreset] = useState<LayoutPreset>("swing");
  const [terminalDensityMode, setTerminalDensityMode] = useState<"focus" | "full">("focus");
  const [focusDecks, setFocusDecks] = useState<TerminalFocusDeckId[]>([]);
  const [layoutWorkspaceName, setLayoutWorkspaceName] = useState(DEFAULT_LAYOUT_WORKSPACE_NAME);
  const [layoutWorkspaceOptions, setLayoutWorkspaceOptions] = useState<string[]>(DEFAULT_LAYOUT_WORKSPACE_OPTIONS);
  const [workspaceHintBadge, setWorkspaceHintBadge] = useState<string | null>(null);
  const [localFeedFallbackSuggestion, setLocalFeedFallbackSuggestion] = useState<LocalFeedFallbackSuggestion | null>(null);
  const [localTerminalCaptureClientId, setLocalTerminalCaptureClientId] = useState<string | null>(null);
  const [localTerminalCapturePersistenceStatus, setLocalTerminalCapturePersistenceStatus] = useState<LocalTerminalCapturePersistenceStatus>({
    clientId: null,
    updatedAt: null,
    healthy: false,
    detail: "pending",
    historyCount: 0,
    autoIncidentTicketKey: null,
    autoIncidentStatus: null,
    captureHistory: [],
  });
  const [layoutScreenProfile, setLayoutScreenProfile] = useState<"sm" | "md" | "lg" | "xl">("lg");
  const [layoutCoreSplit, setLayoutCoreSplit] = useState(uiMode === "novice" ? 72 : 78);
  const [layoutMicroOrder, setLayoutMicroOrder] = useState<DockPanelId[]>([...MICRO_PANEL_IDS]);
  const [layoutLowerOrder, setLayoutLowerOrder] = useState<DockPanelId[]>([...LOWER_PANEL_IDS]);
  const [layoutMonitoringOrder, setLayoutMonitoringOrder] = useState<DockPanelId[]>([...MONITORING_PANEL_IDS]);
  const [floatingPanels, setFloatingPanels] = useState<FloatingPanelState[]>([]);
  const [layoutDropPreview, setLayoutDropPreview] = useState<{ zone: DockZone; targetId?: DockPanelId; mode: "zone" | "panel" } | null>(null);
  const [selectedChartSymbol, setSelectedChartSymbol] = useState("BTCUSD");
  const [chartVenueOverride, setChartVenueOverride] = useState<string | null>(null);
  const [chartLinkSymbolEnabled, setChartLinkSymbolEnabled] = useState(true);
  const [chartLinkTimeframeEnabled, setChartLinkTimeframeEnabled] = useState(true);
  const [chartPerfMode, setChartPerfMode] = useState<"auto" | "balanced" | "ultra">("auto");
  const [chartVisualMode, setChartVisualMode] = useState<"auto" | "clean" | "full">("auto");
  const [terminalV2Enabled, setTerminalV2Enabled] = useState(TERMINAL_V2_DEFAULT);
  const [chartEngineMode, setChartEngineMode] = useState<"v3" | "v4">(TERMINAL_CHART_ENGINE_DEFAULT);
  const [gpuViewportGrid, setGpuViewportGrid] = useState<1 | 4 | 16 | "auto">("auto");
  const [chartSmoothingMs, setChartSmoothingMs] = useState<0 | 80 | 140 | 220>(TERMINAL_SMOOTHING_DEFAULT_MS);
  const [chartSidecarProfile, setChartSidecarProfile] = useState<ChartSidecarProfile>("intraday");
  const [detachedChartSidecars, setDetachedChartSidecars] = useState<DetachedChartSidecarState[]>([]);
  const [activeIndicators, setActiveIndicators] = useState<ActiveIndicator[]>([]);
  const [showIndicatorPanel, setShowIndicatorPanel] = useState(false);
  const [indicatorSeriesForChart, setIndicatorSeriesForChart] = useState<IndicatorSeriesData[]>([]);
  const indicatorComputeSeqRef = useRef(0);
  const signalAlertSignatureRef = useRef("");
  const signalConfidenceTrailRef = useRef<number[]>([]);
  const executionAdaptationSignatureRef = useRef("");
  const localTerminalCapturePayloadRef = useRef<LocalTerminalRuntimeCapture | null>(null);
  const localTerminalCaptureLastPostedSignatureRef = useRef("");
  const localTerminalCaptureLastPostedAtRef = useRef(0);
  const localTerminalCaptureLastIncidentTicketKeyRef = useRef("");
  const terminalDensityModeRef = useRef<"focus" | "full">("focus");
  const focusDecksRef = useRef<TerminalFocusDeckId[]>([]);
  const focusDeckFeedUpdatedAtRef = useRef<Record<string, number>>({});

  const INDICATOR_CATALOG = [
    { category: "trend",      ids: ["ema9","ema21","ema50","ema200","sma","wma","dema","vwap"] },
    { category: "momentum",   ids: ["rsi","macd","stoch","cci","momentum","roc"] },
    { category: "volatility", ids: ["bb","atr","keltner","donchian"] },
    { category: "volume",     ids: ["obv","volsma","cvd","cmf"] },
    { category: "custom",     ids: ["supertrend","market_structure"] },
  ];

  function toggleIndicator(id: string) {
    setActiveIndicators((prev) => {
      const exists = prev.some((a) => a.id === id);
      return exists ? prev.filter((a) => a.id !== id) : [...prev, { id, params: {} }];
    });
  }
  const [accountId, setAccountId] = useState("mt5-demo-01");
  const [symbol, setSymbol] = useState("BTCUSD");
  const [side, setSide] = useState("buy");
  const [lots, setLots] = useState(0.1);
  const [notional, setNotional] = useState(15000);
  const [maxSpread, setMaxSpread] = useState(15);
  const [rationale, setRationale] = useState("Breakout confirme + risque controle");
  const [chartMode, setChartMode] = useState<"line" | "candles" | "footprint">("candles");
  const [chartTimeframe, setChartTimeframe] = useState("1m");
  const [chartWindow, setChartWindow] = useState(80);
  // Virtual viewport ref : évite un re-render React complet à chaque pan/zoom
  // Le scroll/zoom LightweightCharts est géré internalement ; on conserve
  // chartWindow comme source de vérité pour la fenêtre de bars visible.
  const chartViewportRef = useRef<{ window: number }>({ window: 80 });
  const [chartLoading, setChartLoading] = useState(false);
  const [chartOrderTicket, setChartOrderTicket] = useState<ChartOrderTicket>({
    side: "buy",
    preset: "scalp",
    entry: 0,
    sl: 0,
    tp: 0,
    oco: true,
    active: true,
  });
  const [chartSnapState, setChartSnapState] = useState<ChartSnapState>(null);
  const [chartActiveSnapLine, setChartActiveSnapLine] = useState<ChartOrderLineKey | null>(null);
  const [chartSnapPulseLine, setChartSnapPulseLine] = useState<ChartOrderLineKey | null>(null);
  const [chartReleaseTicket, setChartReleaseTicket] = useState<ChartReleaseTicketState>(null);
  const [chartReleaseValidationPulse, setChartReleaseValidationPulse] = useState(false);
  const [chartOrderPreviewOpen, setChartOrderPreviewOpen] = useState(false);
  const [chartRiskGuardEnabled, setChartRiskGuardEnabled] = useState(true);
  const [chartMaxLossUsd, setChartMaxLossUsd] = useState(uiMode === "novice" ? 120 : 250);
  const [chartTargetGainUsd, setChartTargetGainUsd] = useState(uiMode === "novice" ? 220 : 500);
  const [signalDisplayMode, setSignalDisplayMode] = useState<SignalDisplayMode>("augmented");
  const [confluenceWeights, setConfluenceWeights] = useState<MarketConfluenceWeights>({ ...DEFAULT_CONFLUENCE_WEIGHTS });
  const [showReasonLegend, setShowReasonLegend] = useState(false);
  const [showConfluenceTune, setShowConfluenceTune] = useState(false);
  const [showDecisionSecondary, setShowDecisionSecondary] = useState(false);
  const [executionAdaptMode, setExecutionAdaptMode] = useState<ExecutionAdaptMode>("auto");
  const [autoExecutionMode, setAutoExecutionMode] = useState<AutoExecutionMode>("semi-auto");
  const [autoExecutionKillSwitch, setAutoExecutionKillSwitch] = useState(false);
  const [autoSessionGuardEnabled, setAutoSessionGuardEnabled] = useState(true);
  const [autoSessionStartHour, setAutoSessionStartHour] = useState(7);
  const [autoSessionEndHour, setAutoSessionEndHour] = useState(22);
  const [autoSymbolLossCapUsd, setAutoSymbolLossCapUsd] = useState(600);
  const [autoSymbolAutoDisabled, setAutoSymbolAutoDisabled] = useState<Record<string, string>>({});
  const [autoExecutionAuditTrail, setAutoExecutionAuditTrail] = useState<AutoExecutionAuditEvent[]>([]);
  const [autoExecutionAuditStateFilter, setAutoExecutionAuditStateFilter] = useState<"all" | "READY" | "BLOCKED" | "KILLED">("all");
  const [autoExecutionAuditReasonSearch, setAutoExecutionAuditReasonSearch] = useState("");
  const [selfLearningV4Enabled, setSelfLearningV4Enabled] = useState(true);
  const [selfLearningAutoAdaptEnabled, setSelfLearningAutoAdaptEnabled] = useState(true);
  const [selfLearningModelUpdatedAt, setSelfLearningModelUpdatedAt] = useState<string | null>(null);
  const [selfLearningDriftAutoDemotedAt, setSelfLearningDriftAutoDemotedAt] = useState<string | null>(null);
  const [selfLearningJournalV4Trail, setSelfLearningJournalV4Trail] = useState<SelfLearningJournalEventV4[]>([]);
  const [selfLearningJournalV4RegimeFilter, setSelfLearningJournalV4RegimeFilter] = useState<"all" | LearningRegimeV4>("all");
  const [selfLearningJournalV4ScenarioFilter, setSelfLearningJournalV4ScenarioFilter] = useState<"all" | MarketDecisionScenario>("all");
  const [selfLearningV4ScopeSummaries, setSelfLearningV4ScopeSummaries] = useState<SelfLearningV4ScopeSummary[]>([]);
  const [selfLearningV4PersistenceStatus, setSelfLearningV4PersistenceStatus] = useState<SelfLearningV4PersistenceStatus>({
    storage: "unknown",
    healthy: false,
    stateLoadedAt: null,
    stateSavedAt: null,
    scopesLoadedAt: null,
    scopeCount: 0,
    message: "init",
  });
  const [pendingExecutionAdaptation, setPendingExecutionAdaptation] = useState<{
    signature: string;
    plan: MarketDecisionSnapshot["executionPlan"];
  } | null>(null);
  const [chartHudConfirmArmed, setChartHudConfirmArmed] = useState(false);

  const handleV2AutoReduce = useCallback(() => {
    setNotional((value) => Math.max(1000, Math.round(value * 0.75)));
  }, []);

  const handleV2AutoClose = useCallback(() => {
    setChartOrderTicket((current) => ({ ...current, active: false }));
    setAutoExecutionKillSwitch(true);
  }, []);

  const handleV2DomEntryFromLevel = useCallback((price: number, sideLabel: "bid" | "ask") => {
    const entry = Math.max(0.0000001, Number(price));
    const ticketSide: "buy" | "sell" = sideLabel === "ask" ? "buy" : "sell";
    const sl = ticketSide === "buy" ? entry * (1 - 0.003) : entry * (1 + 0.003);
    const tp = ticketSide === "buy" ? entry * (1 + 0.006) : entry * (1 - 0.006);
    setChartOrderTicket((current) => ({
      ...current,
      side: ticketSide,
      entry,
      sl,
      tp,
      active: true,
    }));
    setSymbol(selectedChartSymbol);
    setSide(ticketSide);
  }, [selectedChartSymbol]);

  const handleV2DomExitFromLevel = useCallback((price: number, _sideLabel: "bid" | "ask") => {
    const target = Math.max(0.0000001, Number(price));
    setChartOrderTicket((current) => {
      if (!current.active || current.entry <= 0) {
        return current;
      }
      return { ...current, tp: target };
    });
  }, []);
  const [chartSendHistory, setChartSendHistory] = useState<ChartSendHistoryEntry[]>([]);
  const [chartSendHistoryBackend, setChartSendHistoryBackend] = useState<ChartSendHistoryEntry[]>([]);
  const [riskTimelineFilter, setRiskTimelineFilter] = useState<RiskTimelineFilter>("all");
  const [riskTimelineFrom, setRiskTimelineFrom] = useState("");
  const [riskTimelineTo, setRiskTimelineTo] = useState("");
  const [riskAlertWindow, setRiskAlertWindow] = useState(DEFAULT_RISK_ALERT_WINDOW);
  const [riskAlertMissThreshold, setRiskAlertMissThreshold] = useState(DEFAULT_RISK_ALERT_MISS_THRESHOLD);
  const [riskTimelineRefreshSec, setRiskTimelineRefreshSec] = useState<5 | 15 | 30>(DEFAULT_RISK_REFRESH_SEC);
  const [riskHardAlertEnabled, setRiskHardAlertEnabled] = useState(false);
  const [riskHardAlertThresholdPct, setRiskHardAlertThresholdPct] = useState(DEFAULT_HARD_ALERT_RATIO_PCT);
  const [riskSummary, setRiskSummary] = useState<RiskHistorySummary | null>(null);
  const [riskPollingStatus, setRiskPollingStatus] = useState<RiskPollingStatus>({
    lastRefreshIso: null,
    latencyMs: null,
    source: null,
  });
  const [riskPollingFailures, setRiskPollingFailures] = useState(0);
  const [riskPollAgeSec, setRiskPollAgeSec] = useState(0);
  const [crosshair, setCrosshair] = useState<ChartCursorPayload>(null);
  const [marketMetricsBySymbol, setMarketMetricsBySymbol] = useState<Record<string, MarketMetric>>({});
  const [governanceSort, setGovernanceSort] = useState<GovernanceSort>("severity");
  const [incidentSort, setIncidentSort] = useState<IncidentSort>("severity");
  const [governanceOnlyAlerts, setGovernanceOnlyAlerts] = useState(false);
  const [governanceFilterText, setGovernanceFilterText] = useState("");
  const [showVwap, setShowVwap] = useState(true);
  const [showFvgOb, setShowFvgOb] = useState(true);
  const [showLiquidity, setShowLiquidity] = useState(true);
  const [showSessions, setShowSessions] = useState(true);
  const [replayBuffers, setReplayBuffers] = useState<ReplayBufferMap>({});
  const [replayState, setReplayState] = useState<ReplayState>({
    enabled: false,
    playing: false,
    speed: 1,
    cursorIndex: 0,
    timeKey: null,
  });
  const [replayFilterKinds, setReplayFilterKinds] = useState<string[]>([]);
  const [replayFilterCritical, setReplayFilterCritical] = useState<boolean>(false);
  const [strategyCooldowns, setStrategyCooldowns] = useState<Record<string, {demoteTime?: number, reduceTime?: number}>>({});
  const [metaRiskAuditTrail, setMetaRiskAuditTrail] = useState<MetaRiskAuditEvent[]>([]);
  const [metaRiskAuditShowOnlyDrops, setMetaRiskAuditShowOnlyDrops] = useState(false);
  const [metaRiskAuditDropSort, setMetaRiskAuditDropSort] = useState<"recent" | "largest">("recent");
  const [metaRiskHealthHistory, setMetaRiskHealthHistory] = useState<number[]>([]);
  const [autoTuningAuditTrail, setAutoTuningAuditTrail] = useState<AutoTuningAuditEvent[]>([]);
  const [autoTuningBusy, setAutoTuningBusy] = useState(false);
  const [autoTuningStatus, setAutoTuningStatus] = useState("");
  const [autoTuningAdminKey, setAutoTuningAdminKey] = useState("");
  const [autoTuningIdempotencyKey, setAutoTuningIdempotencyKey] = useState("");
  const [autoTuningMinConfidence, setAutoTuningMinConfidence] = useState(0.35);
  const [autoTuningMaxRecommendations, setAutoTuningMaxRecommendations] = useState(8);
  const [autoTuningWeightFloorPct, setAutoTuningWeightFloorPct] = useState(0);
  const [autoTuningWeightCapPct, setAutoTuningWeightCapPct] = useState(30);
  const [autoTuningRenormalize, setAutoTuningRenormalize] = useState(true);
  const [rollbackGuardSession, setRollbackGuardSession] = useState<RollbackGuardSession | null>(null);
  const [rollbackGuardHistory, setRollbackGuardHistory] = useState<RollbackGuardSession[]>([]);
  const [rollbackGuardWindowMin, setRollbackGuardWindowMin] = useState(
    Number.isFinite(ROLLBACK_GUARD_WINDOW_MIN) ? Math.max(10, Math.min(480, Math.round(ROLLBACK_GUARD_WINDOW_MIN))) : 90,
  );
  const [rollbackGuardHealthDrop, setRollbackGuardHealthDrop] = useState(
    Number.isFinite(ROLLBACK_GUARD_HEALTH_DROP) ? Math.max(0.01, Math.min(0.5, ROLLBACK_GUARD_HEALTH_DROP)) : 0.08,
  );
  const [rollbackGuardBrierRise, setRollbackGuardBrierRise] = useState(
    Number.isFinite(ROLLBACK_GUARD_BRIER_RISE) ? Math.max(0.005, Math.min(0.2, ROLLBACK_GUARD_BRIER_RISE)) : 0.035,
  );
  const rollbackGuardClosedRef = useRef<string>("");
  const decisionSecondaryRef = useRef<HTMLDivElement | null>(null);
  const chartOrderDragRef = useRef<ChartDragState | null>(null);
  const chartLongPressTimerRef = useRef<number | null>(null);
  const chartOrderTicketRef = useRef<ChartOrderTicket>(chartOrderTicket);
  const executionEngineV7Ref = useRef(new ExecutionEngineV7());
  const predictorEngineV8Ref = useRef(new PredictorEngineV8());
  const predictorTrainingBufferRef = useRef<JsonMap[]>([]);
  const predictorTrainingQueuedIdsRef = useRef(new Set<string>());
  const chartSnapStateRef = useRef<ChartSnapState>(null);
  const chartSnapHapticSignatureRef = useRef("");
  const marketMetricsAbortRef = useRef<AbortController | null>(null);
  const marketSnapshotCacheRef = useRef(new Map<string, { fetchedAt: number; payload: JsonMap | null }>());
  const marketSnapshotInflightRef = useRef(new Map<string, Promise<JsonMap | null>>());
  const marketDataBusRef = useRef<ReturnType<typeof createMarketDataBus> | null>(null);
  const quotesRef = useRef<JsonMap[]>([]);
  const backendPrefsReadyRef = useRef(false);
  const backendUpdatedAtRef = useRef<string | null>(null);
  const backendPrefsRef = useRef<Partial<UserUiPreferencesProfile> | null>(null);
  const termCoreGroupRef = useRef<ImperativePanelGroupHandle | null>(null);
  const layoutImportInputRef = useRef<HTMLInputElement | null>(null);
  const layoutDragRef = useRef<{ zone: DockZone; id: DockPanelId } | null>(null);
  const floatingDragRef = useRef<{ id: DockPanelId; startX: number; startY: number; origX: number; origY: number } | null>(null);
  const hotkeyActionsRef = useRef({
    applyLayoutPreset: (p: LayoutPreset) => { void p; },
    toggleEditMode: () => {},
    saveLayout: () => {},
    restoreLayout: () => {},
    resetFloating: () => {},
    cycleWorkspace: (_direction: 1 | -1) => {},
  });
  const metaRiskPrevRef = useRef<{
    tier: string;
    capitalMultiplier: number;
    blockedRegimesKey: string;
    venueLabel: string;
  } | null>(null);

  const {
    chartLinkStorageKey,
    chartSidecarStorageKey,
    coreSplitByScreenStorageKey,
    layoutStorageKey,
    layoutWorkspaceStorageKey,
    legacyChartLinkStorageKey,
    signalEngineStorageKey,
    termCoreAutoSaveId,
  } = buildTerminalLayoutStorageKeys(accountId, layoutWorkspaceName, layoutScreenProfile);
  const reasonLegendStorageKey = `${signalEngineStorageKey}.reason-codes-legend.v1`;
  const autoExecutionSignatureRef = useRef("");
  const autoExecutionLastAtRef = useRef(0);
  const autoExecutionAuditSignatureRef = useRef("");
  const selfLearningModelSignatureRef = useRef("");
  const selfLearningDriftSignatureRef = useRef("");
  const selfLearningJournalSignatureRef = useRef("");
  const selfLearningBackendReadyRef = useRef(false);
  const selfLearningBackendScopeRef = useRef("");
  const authBackoffUntilRef = useRef(0);
  const authStatusSyncedAtRef = useRef(0);
  const authStatusRef = useRef<AuthSessionStatus>("unknown");
  const authStatusRequestRef = useRef<Promise<boolean> | null>(null);
  const chartRestFallbackKeyRef = useRef("");
  const chartEmptyRecoveryKeyRef = useRef("");
  const localFeedDismissedFallbackKeyRef = useRef("");
  const activeChartConfigRef = useRef<{ instrument: string; venue: string; timeframe: string }>({
    instrument: "BTCUSD",
    venue: "binance-public",
    timeframe: "1m",
  });
  const chartSidecarDragRef = useRef<{ id: ChartSidecarId; startX: number; startY: number; origX: number; origY: number } | null>(null);

  const {
    chartHudBounds,
    chartHudDragging,
    chartHudMinimized,
    chartHudPosition,
    chartOrderHudRef,
    chartStageRef,
    beginChartHudDrag,
    resetChartHud,
    setChartHudMinimized,
  } = useChartExecutionHud({ layoutScreenProfile, signalDisplayMode });

  useEffect(() => {
    setAutoTuningIdempotencyKey((current) => current || buildIdempotencyKey());
  }, []);

  useEffect(() => {
    setIsHydrated(true);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }

    const syncLayoutScreenProfile = () => {
      const width = window.innerWidth;
      setLayoutScreenProfile(
        width <= 680
          ? "sm"
          : width <= 1120
            ? "md"
            : width <= 1560
              ? "lg"
              : "xl",
      );
    };

    syncLayoutScreenProfile();
    window.addEventListener("resize", syncLayoutScreenProfile);
    return () => {
      window.removeEventListener("resize", syncLayoutScreenProfile);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const query = new URLSearchParams(window.location.search);
    const forced = query.get("v2");
    const persisted = window.localStorage.getItem("txt.terminal.v2");
    const forcedEngine = query.get("engine");
    const persistedEngine = window.localStorage.getItem("txt.terminal.engine");
    const forcedGpuGrid = query.get("gpuGrid");
    const persistedGpuGrid = window.localStorage.getItem("txt.terminal.gpu-grid");
    const forcedSmoothing = query.get("smoothingMs");
    const persistedSmoothing = window.localStorage.getItem("txt.terminal.smoothing-ms");
    const forcedPerfDebug = query.get("perfDebug");
    const persistedPerfDebug = window.localStorage.getItem(TERMINAL_COMPUTE_PERF_STORAGE_KEY);
    const webgl2 = isWebGL2Available();
    if (forced === "1" || persisted === "1") {
      setTerminalV2Enabled(true);
    } else if (forced === "0" || persisted === "0") {
      setTerminalV2Enabled(false);
    }

    const requestedEngine = forcedEngine === "v4" || persistedEngine === "v4"
      ? "v4"
      : forcedEngine === "v3" || persistedEngine === "v3"
        ? "v3"
        : TERMINAL_CHART_ENGINE_DEFAULT;

    const effectiveEngine = requestedEngine === "v4" && !webgl2 ? "v3" : requestedEngine;
    setChartEngineMode(effectiveEngine);

    if (effectiveEngine !== requestedEngine) {
      window.localStorage.setItem("txt.terminal.engine", effectiveEngine);
    }

    if (forcedPerfDebug === "1" || persistedPerfDebug === "1") {
      setTerminalComputePerfEnabled(true);
    } else if (forcedPerfDebug === "0" || persistedPerfDebug === "0") {
      setTerminalComputePerfEnabled(false);
    }

    console.info("[terminal] engine runtime selection", {
      requestedEngine,
      effectiveEngine,
      webgl2,
    });

    const parsedGrid = parseGpuViewportGrid(forcedGpuGrid) ?? parseGpuViewportGrid(persistedGpuGrid);
    if (parsedGrid) {
      setGpuViewportGrid(parsedGrid);
    }

    const parsedSmoothing = parseChartSmoothingMs(forcedSmoothing) ?? parseChartSmoothingMs(persistedSmoothing);
    if (parsedSmoothing !== null) {
      setChartSmoothingMs(parsedSmoothing);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    if (!terminalComputePerfEnabled) {
      clearTerminalComputePerf();
      setTerminalComputePerfSummary([]);
      return;
    }
    clearTerminalComputePerf();
    setTerminalComputePerfSummary(snapshotTerminalComputePerf());
    const handle = window.setInterval(() => {
      setTerminalComputePerfSummary(snapshotTerminalComputePerf());
    }, 1200);
    return () => {
      window.clearInterval(handle);
    };
  }, [terminalComputePerfEnabled]);

  const toggleTerminalV2 = useCallback(() => {
    setTerminalV2Enabled((current) => {
      const next = !current;
      if (typeof window !== "undefined") {
        window.localStorage.setItem("txt.terminal.v2", next ? "1" : "0");
      }
      return next;
    });
  }, []);

  const toggleChartEngineMode = useCallback(() => {
    setChartEngineMode((current) => {
      const next = current === "v4" ? "v3" : "v4";
      if (typeof window !== "undefined") {
        window.localStorage.setItem("txt.terminal.engine", next);
      }
      return next;
    });
  }, []);

  const setGpuViewportGridMode = useCallback((next: 1 | 4 | 16 | "auto") => {
    setGpuViewportGrid(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("txt.terminal.gpu-grid", String(next));
    }
  }, []);

  const setChartSmoothingMode = useCallback((next: 0 | 80 | 140 | 220) => {
    setChartSmoothingMs(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("txt.terminal.smoothing-ms", String(next));
    }
  }, []);

  const markUnauthorizedBackoff = () => {
    authBackoffUntilRef.current = Date.now() + 30_000;
    authStatusSyncedAtRef.current = Date.now();
    authStatusRef.current = "unauthenticated";
    setAuthStatus("unauthenticated");
    setAuthSessionRequired(true);
  };

  const refreshAuthSession = async (force = false): Promise<boolean> => {
    const isPublicHost = isGtixPublicBrowserHost();
    const wasAuthenticated = authStatusRef.current === "authenticated";
    if (!force && authStatusRequestRef.current) {
      return authStatusRequestRef.current;
    }
    if (!force && authStatusRef.current === "unauthenticated" && Date.now() < authBackoffUntilRef.current) {
      setAuthSessionRequired(true);
      return false;
    }
    if (
      !force
      && isPublicHost
      && authStatusRef.current !== "unknown"
      && Date.now() - authStatusSyncedAtRef.current < PUBLIC_AUTH_STATUS_CACHE_MS
    ) {
      const authenticated = authStatusRef.current === "authenticated";
      setAuthSessionRequired(!authenticated);
      return authenticated;
    }
    const request = fetchTerminalAuthStatus(wasAuthenticated)
      .then(({ authenticated, definitive }) => {
        if (!definitive) {
          if (wasAuthenticated) {
            setAuthStatus("authenticated");
            setAuthSessionRequired(false);
            return true;
          }
          return false;
        }
        authStatusSyncedAtRef.current = Date.now();
        authStatusRef.current = authenticated ? "authenticated" : "unauthenticated";
        setAuthStatus(authenticated ? "authenticated" : "unauthenticated");
        setAuthSessionRequired(!authenticated);
        if (authenticated) {
          authBackoffUntilRef.current = 0;
        } else {
          authBackoffUntilRef.current = Math.max(authBackoffUntilRef.current, Date.now() + 15_000);
        }
        return authenticated;
      })
      .finally(() => {
        authStatusRequestRef.current = null;
      });
    authStatusRequestRef.current = request;
    return request;
  };

  const buildRoutingRequestHeaders = (requestType: "ui" | "ai" | "execution", symbolValue: string): HeadersInit => {
    const signalState = marketDecisionV1.scenario === "reversal"
      ? "reversal"
      : marketDecisionV1.criticalConfirmed
        ? "fast"
        : "normal";
    const volatility = overlayDecisionRegime === "high"
      ? "high"
      : overlayDecisionRegime === "medium"
        ? "medium"
        : "low";
    return {
      "x-mc-request-type": requestType,
      "x-mc-priority": requestType === "execution" ? "execution" : requestType === "ai" ? "high" : "low",
      "x-mc-market-volatility": volatility,
      "x-mc-signal-state": signalState,
      "x-mc-symbol": normalizeInstrument(symbolValue),
      "x-mc-origin": "terminal",
    };
  };

  useEffect(() => {
    chartOrderTicketRef.current = chartOrderTicket;
  }, [chartOrderTicket]);

  useEffect(() => {
    authStatusRef.current = authStatus;
  }, [authStatus]);

  useEffect(() => {
    chartSnapStateRef.current = chartSnapState;
  }, [chartSnapState]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      return;
    }
    if (!isGtixPublicBrowserHost()) {
      setPublicOpsRefreshPaused(false);
      return;
    }
    const syncPausedState = () => {
      setPublicOpsRefreshPaused(shouldPauseNonEssentialRefresh());
    };
    syncPausedState();
    document.addEventListener("visibilitychange", syncPausedState);
    window.addEventListener("focus", syncPausedState);
    window.addEventListener("blur", syncPausedState);
    window.addEventListener("pageshow", syncPausedState);
    return () => {
      document.removeEventListener("visibilitychange", syncPausedState);
      window.removeEventListener("focus", syncPausedState);
      window.removeEventListener("blur", syncPausedState);
      window.removeEventListener("pageshow", syncPausedState);
    };
  }, []);

  useEffect(() => {
    quotesRef.current = quotes;
  }, [quotes]);

  const selectedChartQuote = useMemo(
    () => pickPreferredChartQuote(quotes, selectedChartSymbol, chartVenueOverride),
    [chartVenueOverride, quotes, selectedChartSymbol],
  );

  const selectedChartVenue = String(selectedChartQuote?.venue || "binance-public");
  const selectedChartInstrument = normalizeInstrument(String(selectedChartQuote?.instrument || selectedChartSymbol || "BTCUSD"));
  const selectedChartMetricSymbol = selectedChartQuote ? instrumentLabel(selectedChartQuote) : selectedChartInstrument;
  const selectedChartMetricCandidates = useMemo(() => {
    const candidates = new Set<string>();
    for (const candidate of buildChartSymbolCandidates(selectedChartSymbol)) {
      candidates.add(candidate);
    }
    for (const candidate of buildChartSymbolCandidates(selectedChartInstrument)) {
      candidates.add(candidate);
    }
    candidates.add(selectedChartInstrument);
    candidates.add(normalizeInstrument(selectedChartMetricSymbol));
    return candidates;
  }, [selectedChartInstrument, selectedChartMetricSymbol, selectedChartSymbol]);
  const selectedChartMetric = useMemo<MarketMetric | null>(() => {
    return measureTerminalCompute("selectedChartMetric", terminalComputePerfEnabled, () => {
      if (!marketMicro) {
        return null;
      }
      const activeEvents = Array.isArray(marketMicro.active_events) ? marketMicro.active_events as {type: string}[] : [];
      return {
        fundingRate: toNumber(marketMicro.funding_rate, 0),
        openInterest: toNumber(marketMicro.open_interest, 0),
        volume: toNumber(marketMicro.buy_volume, 0) + toNumber(marketMicro.sell_volume, 0),
        depthImbalance: toNumber(marketMicro.depth_imbalance, 0),
        tapeAcceleration: toNumber(marketMicro.tape_acceleration, 0),
        cvd: toNumber(marketMicro.cvd, 0),
        cvdDelta: toNumber(marketMicro.cvd_delta, 0),
        cvdTrend: (String(marketMicro.cvd_trend || "flat") as MarketMetric["cvdTrend"]),
        flowImbalance: toNumber(marketMicro.flow_imbalance, 0),
        spreadBps: toNumber(marketMicro.spread_bps, 0),
        tradeAggressiveness: toNumber(marketMicro.trade_aggressiveness, 0),
        avgLatencyMs: toNumber(marketMicro.avg_latency_ms, 0),
        latencyTier: (String(marketMicro.latency_tier || "normal") as MarketMetric["latencyTier"]),
        activeEventCount: activeEvents.length,
        lastEventType: activeEvents.length > 0 ? String(activeEvents[activeEvents.length - 1].type) : null,
      };
    });
  }, [marketMicro, terminalComputePerfEnabled]);

  useEffect(() => {
    activeChartConfigRef.current = {
      instrument: selectedChartInstrument,
      venue: selectedChartVenue,
      timeframe: chartTimeframe,
    };
  }, [chartTimeframe, selectedChartInstrument, selectedChartVenue]);

  useEffect(() => {
    if (!selectedChartMetric) {
      return;
    }
    setMarketMetricsBySymbol((current) => {
      const existing = current[selectedChartMetricSymbol];
      if (
        existing
        && existing.fundingRate === selectedChartMetric.fundingRate
        && existing.openInterest === selectedChartMetric.openInterest
        && existing.volume === selectedChartMetric.volume
        && existing.depthImbalance === selectedChartMetric.depthImbalance
        && existing.tapeAcceleration === selectedChartMetric.tapeAcceleration
        && existing.cvd === selectedChartMetric.cvd
        && existing.flowImbalance === selectedChartMetric.flowImbalance
      ) {
        return current;
      }
      return {
        ...current,
        [selectedChartMetricSymbol]: selectedChartMetric,
      };
    });
  }, [selectedChartMetric, selectedChartMetricSymbol]);

  useEffect(() => {
    if (
      authSessionRequired
      || authStatus !== "authenticated"
      || chartMode !== "candles"
      || chartLoading
      || ohlcvBars.length > 0
      || quotes.length === 0
      || classifyInstrument(selectedChartSymbol) !== "crypto"
    ) {
      return;
    }

    const recoveryQuote = pickDefaultChartQuote(quotes);
    if (!recoveryQuote) {
      return;
    }

    const recoverySymbol = instrumentLabel(recoveryQuote);
    if (!recoverySymbol || normalizeInstrument(recoverySymbol) === normalizeInstrument(selectedChartSymbol)) {
      return;
    }

    const recoveryKey = `${normalizeInstrument(selectedChartSymbol)}|${chartTimeframe}|${normalizeInstrument(recoverySymbol)}`;
    if (chartEmptyRecoveryKeyRef.current === recoveryKey) {
      return;
    }

    const timer = window.setTimeout(() => {
      chartEmptyRecoveryKeyRef.current = recoveryKey;
      setSelectedChartSymbol(recoverySymbol);
      setWorkspaceHintBadge(`Chart source recovered: ${recoverySymbol}`);
    }, 2500);

    return () => {
      window.clearTimeout(timer);
    };
  }, [authSessionRequired, authStatus, chartLoading, chartMode, chartTimeframe, ohlcvBars.length, quotes, selectedChartSymbol]);

  const marketMetricsUniverseKey = useMemo(() => {
    return buildMarketMetricsUniverse(quotes, symbolFilter, marketFilter)
      .map((quote) => `${quote.symbolKey}|${quote.venue}|${quote.instrument}`)
      .join(",");
  }, [marketFilter, quotes, symbolFilter]);

  const fetchMarketBusSnapshot = useCallback(async (instrument: string, venue: string, timeframe: string) => {
    const cacheKey = `${instrument}|${venue}|${timeframe}`;
    const cached = marketSnapshotCacheRef.current.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < MARKET_SNAPSHOT_CACHE_TTL_MS) {
      return cached.payload;
    }

    const inFlight = marketSnapshotInflightRef.current.get(cacheKey);
    if (inFlight) {
      return inFlight;
    }

    const request = fetch(`/api/market/bus/snapshot?instrument=${encodeURIComponent(instrument)}&venue=${encodeURIComponent(venue)}&timeframe=${encodeURIComponent(timeframe)}&lookback_minutes=60&trade_limit=200`, {
      cache: "no-store",
      headers: buildRoutingRequestHeaders("ui", instrument),
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        const normalizedPayload = payload && typeof payload === "object" && !Array.isArray(payload)
          ? (payload as JsonMap)
          : null;
        marketSnapshotCacheRef.current.set(cacheKey, { fetchedAt: Date.now(), payload: normalizedPayload });
        return normalizedPayload;
      })
      .catch(() => null)
      .finally(() => {
        marketSnapshotInflightRef.current.delete(cacheKey);
      });

    marketSnapshotInflightRef.current.set(cacheKey, request);
    return request;
  }, []);

  useEffect(() => () => {
    if (chartLongPressTimerRef.current !== null) {
      window.clearTimeout(chartLongPressTimerRef.current);
    }
  }, []);

  useEffect(() => {
    let active = true;
    const syncAuthStatus = async (force = false) => {
      const authenticated = await refreshAuthSession(force);
      if (!active || authenticated) {
        return;
      }
      setOhlcvStreamState("offline");
      setDepthStreamState("offline");
      setTelemetryStreamState("offline");
    };
    void syncAuthStatus(true);
    const intervalMs = isGtixPublicBrowserHost() ? PUBLIC_AUTH_STATUS_SYNC_MS : 15_000;
    const timer = window.setInterval(() => {
      void syncAuthStatus(false);
    }, intervalMs);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const handleFloatingMove = (event: MouseEvent) => {
      const floatingDrag = floatingDragRef.current;
      if (floatingDrag) {
        setFloatingPanels((current) => current.map((panel) => (
          panel.id === floatingDrag.id
            ? clampFloatingPanel({
                ...panel,
                x: floatingDrag.origX + event.clientX - floatingDrag.startX,
                y: floatingDrag.origY + event.clientY - floatingDrag.startY,
              })
            : panel
        )));
      }
      const sidecarDrag = chartSidecarDragRef.current;
      if (sidecarDrag) {
        setDetachedChartSidecars((current) => current.map((panel) => (
          panel.id === sidecarDrag.id
            ? clampDetachedChartSidecar({
                ...panel,
                x: sidecarDrag.origX + event.clientX - sidecarDrag.startX,
                y: sidecarDrag.origY + event.clientY - sidecarDrag.startY,
              })
            : panel
        )));
      }
    };
    const handleFloatingUp = () => {
      floatingDragRef.current = null;
      chartSidecarDragRef.current = null;
    };
    window.addEventListener("mousemove", handleFloatingMove);
    window.addEventListener("mouseup", handleFloatingUp);
    return () => {
      window.removeEventListener("mousemove", handleFloatingMove);
      window.removeEventListener("mouseup", handleFloatingUp);
    };
  }, []);

  useEffect(() => {
    if (!showDecisionSecondary || typeof window === "undefined") {
      return;
    }
    if (!window.matchMedia("(max-width: 680px)").matches) {
      return;
    }
    const timer = window.setTimeout(() => {
      const target = decisionSecondaryRef.current;
      if (!target) {
        return;
      }
      const hud = target.closest(".chart-order-hud");
      if (hud instanceof HTMLElement) {
        const hudRect = hud.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const rawDelta = targetRect.top - hudRect.top - 34;
        const shortDelta = Math.max(-56, Math.min(118, rawDelta));
        if (Math.abs(shortDelta) > 7) {
          hud.scrollTo({ top: hud.scrollTop + shortDelta, behavior: "smooth" });
        }
        return;
      }
      target.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 90);
    return () => window.clearTimeout(timer);
  }, [showDecisionSecondary]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }
    try {
      const raw = window.localStorage.getItem(signalEngineStorageKey);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw) as {
        confluenceWeights?: Partial<MarketConfluenceWeights>;
        executionAdaptMode?: ExecutionAdaptMode;
        signalDisplayMode?: SignalDisplayMode;
        autoExecutionMode?: AutoExecutionMode;
        autoExecutionKillSwitch?: boolean;
        autoSessionGuardEnabled?: boolean;
        autoSessionStartHour?: number;
        autoSessionEndHour?: number;
        autoSymbolLossCapUsd?: number;
        autoSymbolAutoDisabled?: Record<string, string>;
        selfLearningV4Enabled?: boolean;
        selfLearningAutoAdaptEnabled?: boolean;
        selfLearningDriftAutoDemotedAt?: string | null;
      };
      if (parsed.confluenceWeights && typeof parsed.confluenceWeights === "object") {
        setConfluenceWeights({
          dom: Number(parsed.confluenceWeights.dom) || DEFAULT_CONFLUENCE_WEIGHTS.dom,
          footprint: Number(parsed.confluenceWeights.footprint) || DEFAULT_CONFLUENCE_WEIGHTS.footprint,
          liquidity: Number(parsed.confluenceWeights.liquidity) || DEFAULT_CONFLUENCE_WEIGHTS.liquidity,
          "price-action": Number(parsed.confluenceWeights["price-action"]) || DEFAULT_CONFLUENCE_WEIGHTS["price-action"],
        });
      }
      if (parsed.executionAdaptMode === "auto" || parsed.executionAdaptMode === "confirm" || parsed.executionAdaptMode === "manual") {
        setExecutionAdaptMode(parsed.executionAdaptMode);
      }
      if (parsed.signalDisplayMode === "classic" || parsed.signalDisplayMode === "augmented" || parsed.signalDisplayMode === "ai-dominant") {
        setSignalDisplayMode(parsed.signalDisplayMode);
      }
      if (parsed.autoExecutionMode === "assisted" || parsed.autoExecutionMode === "semi-auto" || parsed.autoExecutionMode === "full-auto") {
        setAutoExecutionMode(parsed.autoExecutionMode);
      }
      if (typeof parsed.autoExecutionKillSwitch === "boolean") {
        setAutoExecutionKillSwitch(parsed.autoExecutionKillSwitch);
      }
      if (typeof parsed.autoSessionGuardEnabled === "boolean") {
        setAutoSessionGuardEnabled(parsed.autoSessionGuardEnabled);
      }
      if (Number.isFinite(parsed.autoSessionStartHour)) {
        setAutoSessionStartHour(Math.max(0, Math.min(23, Number(parsed.autoSessionStartHour))));
      }
      if (Number.isFinite(parsed.autoSessionEndHour)) {
        setAutoSessionEndHour(Math.max(0, Math.min(23, Number(parsed.autoSessionEndHour))));
      }
      if (Number.isFinite(parsed.autoSymbolLossCapUsd)) {
        setAutoSymbolLossCapUsd(Math.max(50, Number(parsed.autoSymbolLossCapUsd)));
      }
      if (parsed.autoSymbolAutoDisabled && typeof parsed.autoSymbolAutoDisabled === "object") {
        setAutoSymbolAutoDisabled(parsed.autoSymbolAutoDisabled);
      }
      if (typeof parsed.selfLearningV4Enabled === "boolean") {
        setSelfLearningV4Enabled(parsed.selfLearningV4Enabled);
      }
      if (typeof parsed.selfLearningAutoAdaptEnabled === "boolean") {
        setSelfLearningAutoAdaptEnabled(parsed.selfLearningAutoAdaptEnabled);
      }
      if (typeof parsed.selfLearningDriftAutoDemotedAt === "string" || parsed.selfLearningDriftAutoDemotedAt === null) {
        setSelfLearningDriftAutoDemotedAt(parsed.selfLearningDriftAutoDemotedAt || null);
      }
    } catch {
      // noop
    }
  }, [signalEngineStorageKey]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const payload = {
      confluenceWeights,
      executionAdaptMode,
      signalDisplayMode,
      autoExecutionMode,
      autoExecutionKillSwitch,
      autoSessionGuardEnabled,
      autoSessionStartHour,
      autoSessionEndHour,
      autoSymbolLossCapUsd,
      autoSymbolAutoDisabled,
      selfLearningV4Enabled,
      selfLearningAutoAdaptEnabled,
      selfLearningDriftAutoDemotedAt,
    };
    window.localStorage.setItem(signalEngineStorageKey, JSON.stringify(payload));
  }, [
    autoExecutionKillSwitch,
    autoExecutionMode,
    autoSessionEndHour,
    autoSessionGuardEnabled,
    autoSessionStartHour,
    autoSymbolAutoDisabled,
    autoSymbolLossCapUsd,
    confluenceWeights,
    executionAdaptMode,
    selfLearningDriftAutoDemotedAt,
    selfLearningAutoAdaptEnabled,
    selfLearningV4Enabled,
    signalDisplayMode,
    signalEngineStorageKey,
  ]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    try {
      const seen = window.localStorage.getItem(reasonLegendStorageKey) === "1";
      if (!seen) {
        setShowReasonLegend(true);
        window.localStorage.setItem(reasonLegendStorageKey, "1");
      }
    } catch {
      // noop
    }
  }, [reasonLegendStorageKey]);

  useEffect(() => {
    if (!showReasonLegend || typeof window === "undefined") {
      return;
    }
    const timer = window.setTimeout(() => setShowReasonLegend(false), 4200);
    return () => window.clearTimeout(timer);
  }, [showReasonLegend]);

  useEffect(() => {
    if (signalDisplayMode === "classic") {
      setShowConfluenceTune(false);
      setShowDecisionSecondary(false);
    }
  }, [signalDisplayMode]);

  useEffect(() => {
    if (autoExecutionMode === "assisted") {
      setSignalDisplayMode("classic");
      setChartPerfMode("balanced");
      setShowVwap(true);
      setShowFvgOb(true);
      setShowLiquidity(true);
      setShowSessions(true);
      setActiveIndicators(cloneIndicatorPreset(HUMAN_MODE_INDICATORS));
      return;
    }
    if (autoExecutionMode === "semi-auto") {
      setSignalDisplayMode("augmented");
      setChartPerfMode("auto");
      setShowVwap(true);
      setShowFvgOb(true);
      setShowLiquidity(true);
      setShowSessions(false);
      setActiveIndicators(cloneIndicatorPreset(HYBRID_MODE_INDICATORS));
      return;
    }
    setSignalDisplayMode("ai-dominant");
    setChartPerfMode("ultra");
    setShowVwap(false);
    setShowFvgOb(false);
    setShowLiquidity(false);
    setShowSessions(false);
    setShowConfluenceTune(false);
    setShowDecisionSecondary(false);
    setActiveIndicators([]);
  }, [autoExecutionMode]);

  useEffect(() => {
    let cancelled = false;
    void fetchBackendUserUiPreferences().then((payload) => {
      if (cancelled) {
        return;
      }
      const profile = payload?.preferences;
      backendUpdatedAtRef.current = payload?.updatedAt || null;
      if (payload?.updatedAt) {
        setLocalUserUiPreferencesUpdatedAt(payload.updatedAt);
      }
      if (profile) {
        backendPrefsRef.current = profile;
        applyLocalUserUiPreferences(profile);
        applyBackendTerminalProfile(profile);
        if (profile.uiMode === "novice" || profile.uiMode === "expert") {
          setUiMode(profile.uiMode);
        }
        if (
          profile.chartMotionPreset === "stable"
          || profile.chartMotionPreset === "balanced"
          || profile.chartMotionPreset === "aggressive"
          || profile.chartMotionPreset === "scalping"
          || profile.chartMotionPreset === "swing"
          || profile.chartMotionPreset === "auto"
        ) {
          setChartMotionPreset(toV41MotionPreset(profile.chartMotionPreset));
        }
        if (typeof profile.chartSnapEnabled === "boolean") {
          setChartSnapEnabled(profile.chartSnapEnabled);
        }
        if (profile.chartSnapPriority === "execution" || profile.chartSnapPriority === "vwap" || profile.chartSnapPriority === "liquidity") {
          setChartSnapPriority(profile.chartSnapPriority);
        }
        if (profile.chartReleaseSendMode === "one-click" || profile.chartReleaseSendMode === "confirm-required") {
          setChartReleaseSendMode(profile.chartReleaseSendMode);
        }
        if (profile.chartHapticMode === "off" || profile.chartHapticMode === "light" || profile.chartHapticMode === "medium") {
          setChartHapticMode(profile.chartHapticMode);
        }
        restoreSavedLayout();
        restoreWorkspaceBundle();
      }
      backendPrefsReadyRef.current = true;
    }).catch(() => {
      backendPrefsReadyRef.current = true;
    });
    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, layoutStorageKey, layoutWorkspaceStorageKey]);

  useEffect(() => {
    if (!backendPrefsReadyRef.current) {
      return;
    }
    const baseProfile = backendPrefsRef.current || {};
    const accountKey = accountId || "default";
    const currentWorkspaceBundle = readCurrentAccountWorkspaceBundle() || { active: layoutWorkspaceName, workspaces: { [layoutWorkspaceName]: currentLayoutSnapshot() } };
    const floatingPresetMap = Object.entries(currentWorkspaceBundle.workspaces || {}).reduce<Record<string, unknown>>((acc, [name, layout]) => {
      const floating = Array.isArray(layout?.floatingPanels) ? layout.floatingPanels : [];
      acc[name] = floating;
      return acc;
    }, {});
    const nextProfile: UserUiPreferencesProfile = {
      ...baseProfile,
      ...readLocalUserUiPreferences(),
      terminalLayoutByAccount: {
        ...((baseProfile.terminalLayoutByAccount as Record<string, Record<string, unknown>> | undefined) || {}),
        [accountKey]: currentLayoutSnapshot() as unknown as Record<string, unknown>,
      },
      terminalWorkspacesByAccount: {
        ...((baseProfile.terminalWorkspacesByAccount as Record<string, Record<string, unknown>> | undefined) || {}),
        [accountKey]: (currentWorkspaceBundle as unknown as Record<string, unknown>),
      },
      terminalFloatingPresetsByAccount: {
        ...((baseProfile.terminalFloatingPresetsByAccount as Record<string, Record<string, unknown>> | undefined) || {}),
        [accountKey]: floatingPresetMap,
      },
    };
    backendPrefsRef.current = nextProfile;
    const clientUpdatedAt = new Date().toISOString();
    void saveBackendUserUiPreferences(nextProfile, {
      baseUpdatedAt: backendUpdatedAtRef.current,
      clientUpdatedAt,
    }).then((result) => {
      if (result.ok) {
        backendUpdatedAtRef.current = result.updatedAt;
        if (result.updatedAt) {
          setLocalUserUiPreferencesUpdatedAt(result.updatedAt);
        }
        return;
      }
      if (result.conflict && result.preferences) {
        backendPrefsRef.current = result.preferences;
        applyLocalUserUiPreferences(result.preferences);
        applyBackendTerminalProfile(result.preferences);
        restoreSavedLayout();
        restoreWorkspaceBundle();
        if (result.updatedAt) {
          backendUpdatedAtRef.current = result.updatedAt;
          setLocalUserUiPreferencesUpdatedAt(result.updatedAt);
        }
        return;
      }
      const fallbackLocalTs = readLocalUserUiPreferencesUpdatedAt() || clientUpdatedAt;
      setLocalUserUiPreferencesUpdatedAt(fallbackLocalTs);
    }).catch(() => {
      const fallbackLocalTs = readLocalUserUiPreferencesUpdatedAt() || clientUpdatedAt;
      setLocalUserUiPreferencesUpdatedAt(fallbackLocalTs);
    });
  }, [accountId, chartHapticMode, chartLinkSymbolEnabled, chartLinkTimeframeEnabled, chartMotionPreset, chartReleaseSendMode, chartSnapEnabled, chartSnapPriority, floatingPanels, layoutCoreSplit, layoutLowerOrder, layoutMicroOrder, layoutMonitoringOrder, layoutPreset, layoutWorkspaceName, riskAlertMissThreshold, riskAlertWindow, riskHardAlertEnabled, riskHardAlertThresholdPct, riskTimelineRefreshSec, uiMode]);

  useEffect(() => {
    let cancelled = false;
    if (authSessionRequired) {
      setSelfLearningV4PersistenceStatus((current) => ({
        ...current,
        healthy: true,
        message: "state-unauthorized",
      }));
      selfLearningBackendReadyRef.current = true;
      return () => {
        cancelled = true;
      };
    }
    const scope = {
      accountId: accountId || "default",
      symbol: selectedChartSymbol || "BTCUSD",
      timeframe: chartTimeframe || "1m",
    };
    const scopeKey = [scope.accountId, scope.symbol, scope.timeframe].join(":");
    selfLearningBackendReadyRef.current = false;
    selfLearningBackendScopeRef.current = scopeKey;
    setSelfLearningJournalV4Trail([]);
    setSelfLearningJournalV4RegimeFilter("all");
    setSelfLearningJournalV4ScenarioFilter("all");
    setSelfLearningModelUpdatedAt(null);
    setSelfLearningDriftAutoDemotedAt(null);

    void fetchSelfLearningV4State(scope).then((result) => {
      if (cancelled || selfLearningBackendScopeRef.current !== scopeKey) {
        return;
      }
      const persisted = result.state;
      if (result.unauthorized) {
        markUnauthorizedBackoff();
        setSelfLearningV4PersistenceStatus((current) => ({
          ...current,
          storage: result.storage,
          healthy: true,
          message: "state-unauthorized",
        }));
        selfLearningBackendReadyRef.current = true;
        return;
      }
      if (persisted) {
        setSelfLearningV4Enabled(persisted.enabled);
        setSelfLearningAutoAdaptEnabled(persisted.autoAdaptEnabled);
        setSelfLearningModelUpdatedAt(persisted.modelUpdatedAt);
        setSelfLearningDriftAutoDemotedAt(persisted.driftAutoDemotedAt);
        setSelfLearningJournalV4RegimeFilter(persisted.filters.regime);
        setSelfLearningJournalV4ScenarioFilter(persisted.filters.scenario);
        setSelfLearningJournalV4Trail(Array.isArray(persisted.journal) ? persisted.journal : []);
      }
      setSelfLearningV4PersistenceStatus((current) => ({
        ...current,
        storage: result.storage,
        healthy: true,
        stateLoadedAt: result.updatedAt || new Date().toISOString(),
        message: persisted ? "state-loaded" : "state-empty",
      }));
      selfLearningBackendReadyRef.current = true;
    }).catch(() => {
      if (cancelled || selfLearningBackendScopeRef.current !== scopeKey) {
        return;
      }
      setSelfLearningV4PersistenceStatus((current) => ({
        ...current,
        healthy: false,
        message: "state-load-failed",
      }));
      selfLearningBackendReadyRef.current = true;
    });

    return () => {
      cancelled = true;
    };
  }, [accountId, chartTimeframe, selectedChartSymbol]);

  const currentLayoutSnapshot = (): TerminalLayoutConfig => ({
    preset: layoutPreset,
    coreSplit: layoutCoreSplit,
    microOrder: layoutMicroOrder,
    lowerOrder: layoutLowerOrder,
    monitoringOrder: layoutMonitoringOrder,
    floatingPanels,
    chartSidecar: {
      profile: chartSidecarProfile,
      detached: detachedChartSidecars,
      previewOpen: chartOrderPreviewOpen,
    },
    chartLink: {
      symbol: chartLinkSymbolEnabled,
      timeframe: chartLinkTimeframeEnabled,
    },
    riskAlert: {
      window: Math.max(3, Math.min(100, riskAlertWindow)),
      missThreshold: Math.max(1, Math.min(100, riskAlertMissThreshold)),
      refreshSec: riskTimelineRefreshSec,
      hardAlertEnabled: riskHardAlertEnabled,
      hardAlertThresholdPct: Math.max(20, Math.min(95, riskHardAlertThresholdPct)),
    },
  });

  const readCurrentAccountWorkspaceBundle = (): TerminalWorkspaceBundle | null => readTerminalWorkspaceBundle(layoutWorkspaceStorageKey);

  const applyBackendTerminalProfile = (profile: Partial<UserUiPreferencesProfile>): void => {
    if (typeof window === "undefined") {
      return;
    }

      useEffect(() => {
        if (typeof window === "undefined") {
          return;
        }
        try {
          const raw = window.localStorage.getItem(coreSplitByScreenStorageKey);
          const parsed = raw ? (JSON.parse(raw) as Record<string, number>) : {};
          const key = `${layoutWorkspaceName}::${layoutScreenProfile}`;
          parsed[key] = layoutCoreSplit;
          window.localStorage.setItem(coreSplitByScreenStorageKey, JSON.stringify(parsed));
        } catch {
          // noop
        }
      }, [coreSplitByScreenStorageKey, layoutCoreSplit, layoutScreenProfile, layoutWorkspaceName]);
    const layoutMap = profile.terminalLayoutByAccount;
    const workspaceMap = profile.terminalWorkspacesByAccount;
    const floatingPresetMap = profile.terminalFloatingPresetsByAccount;
    const accountKey = accountId || "default";
    const layoutPayload = layoutMap && typeof layoutMap[accountKey] === "object" ? layoutMap[accountKey] : null;
    const workspacePayloadRaw = workspaceMap && typeof workspaceMap[accountKey] === "object" ? workspaceMap[accountKey] : null;
    const floatingPayload = floatingPresetMap && typeof floatingPresetMap[accountKey] === "object" ? floatingPresetMap[accountKey] : null;
    const workspacePayload = mergeFloatingPresetsIntoWorkspaceBundle(workspacePayloadRaw, floatingPayload) || workspacePayloadRaw;
    if (layoutPayload) {
      window.localStorage.setItem(layoutStorageKey, JSON.stringify(layoutPayload));
    }
    if (workspacePayload) {
      window.localStorage.setItem(layoutWorkspaceStorageKey, JSON.stringify(workspacePayload));
    }
  };

  const applyNormalizedLayoutState = (normalized: TerminalLayoutConfig) => {
    setLayoutPreset(normalized.preset);
    setLayoutCoreSplit(normalized.coreSplit);
    setLayoutMicroOrder(normalized.microOrder);
    setLayoutLowerOrder(normalized.lowerOrder);
    setLayoutMonitoringOrder(normalized.monitoringOrder);
    setFloatingPanels(normalized.floatingPanels);
    setChartSidecarProfile(normalized.chartSidecar.profile);
    setDetachedChartSidecars(normalized.chartSidecar.detached);
    setChartOrderPreviewOpen(normalized.chartSidecar.previewOpen);
    setChartLinkSymbolEnabled(normalized.chartLink.symbol);
    setChartLinkTimeframeEnabled(normalized.chartLink.timeframe);
    setRiskAlertWindow(normalized.riskAlert.window);
    setRiskAlertMissThreshold(Math.min(normalized.riskAlert.window, normalized.riskAlert.missThreshold));
    setRiskTimelineRefreshSec(normalized.riskAlert.refreshSec);
    setRiskHardAlertEnabled(normalized.riskAlert.hardAlertEnabled);
    setRiskHardAlertThresholdPct(normalized.riskAlert.hardAlertThresholdPct);
    if (termCoreGroupRef.current) {
      termCoreGroupRef.current.setLayout([normalized.coreSplit, 100 - normalized.coreSplit]);
    }
  };

  const applyChartLinkPayload = (payload: { symbol?: string; timeframe?: string }) => {
    if (chartLinkSymbolEnabled && typeof payload.symbol === "string") {
      const nextSymbol = payload.symbol.trim();
      if (nextSymbol) {
        setSelectedChartSymbol(nextSymbol);
      }
    }
    if (chartLinkTimeframeEnabled && payload.timeframe && CHART_TIMEFRAMES.includes(payload.timeframe)) {
      setChartTimeframe(payload.timeframe);
    }
  };

  const applyLayoutPreset = (preset: LayoutPreset) => {
    const next = buildLayoutPreset(preset, uiMode === "novice");
    setLayoutPreset(next.preset);
    setLayoutCoreSplit(next.coreSplit);
    setLayoutMicroOrder(next.microOrder);
    setLayoutLowerOrder(next.lowerOrder);
    setLayoutMonitoringOrder(next.monitoringOrder);
    setFloatingPanels(next.floatingPanels);
    setChartSidecarProfile(next.chartSidecar.profile);
    setDetachedChartSidecars(next.chartSidecar.detached);
    setChartOrderPreviewOpen(next.chartSidecar.previewOpen);
    if (termCoreGroupRef.current) {
      termCoreGroupRef.current.setLayout([next.coreSplit, 100 - next.coreSplit]);
    }
  };

  useEffect(() => {
    if (terminalDensityMode !== "focus") {
      return;
    }
    if (chartPerfMode !== "ultra") {
      setChartPerfMode("ultra");
    }
    if (chartVisualMode !== "clean") {
      setChartVisualMode("clean");
    }
    if (gpuViewportGrid !== 1) {
      setGpuViewportGrid(1);
    }
  }, [chartPerfMode, chartVisualMode, gpuViewportGrid, terminalDensityMode]);

  useEffect(() => {
    terminalDensityModeRef.current = terminalDensityMode;
  }, [terminalDensityMode]);

  useEffect(() => {
    focusDecksRef.current = focusDecks;
  }, [focusDecks]);

  const renderExtendedTerminalModules = terminalDensityMode === "full";
  const focusDeckSet = useMemo(() => new Set<TerminalFocusDeckId>(focusDecks), [focusDecks]);
  const showMicroDeck = renderExtendedTerminalModules || focusDeckSet.has("micro");
  const showMarketsDeck = renderExtendedTerminalModules || focusDeckSet.has("markets");
  const showMonitoringDeck = renderExtendedTerminalModules || focusDeckSet.has("monitoring");
  const showCapitalDeck = renderExtendedTerminalModules || focusDeckSet.has("capital");
  const showMetaRiskDeck = renderExtendedTerminalModules || focusDeckSet.has("metaRisk");
  const showCorrelationDeck = renderExtendedTerminalModules || focusDeckSet.has("correlation");
  const showCalibrationDeck = renderExtendedTerminalModules || focusDeckSet.has("calibration");
  const chartSidecarMicroRealtimeEnabled = renderExtendedTerminalModules || focusDeckSet.has("micro");
  const sidecarProfileCards = CHART_SIDECAR_PROFILE_LAYOUTS[chartSidecarProfile].cards;
  const hasDomTapeSidecarConsumer = chartSidecarMicroRealtimeEnabled && sidecarProfileCards.includes("domTape");
  const hasFootprintHeatSidecarConsumer = chartSidecarMicroRealtimeEnabled && sidecarProfileCards.includes("footprintHeat");
  const hasFastNativeTradesConsumer = showMicroDeck || hasDomTapeSidecarConsumer || hasFootprintHeatSidecarConsumer;
  const hasFastDepthConsumer = showMicroDeck || hasDomTapeSidecarConsumer || hasFootprintHeatSidecarConsumer;
  const hasFastMarketMicroConsumer = showMicroDeck;

  const toggleFocusDeck = (deckId: TerminalFocusDeckId) => {
    setFocusDecks((current) => (
      current.includes(deckId)
        ? current.filter((item) => item !== deckId)
        : [...current, deckId]
    ));
  };

  const shouldCommitThrottledChannel = useCallback((channelKey: string, throttleMs: number): boolean => {
    if (terminalDensityModeRef.current !== "focus") {
      return true;
    }
    const now = Date.now();
    const lastUpdatedAt = focusDeckFeedUpdatedAtRef.current[channelKey] || 0;
    if (now - lastUpdatedAt < throttleMs) {
      return false;
    }
    focusDeckFeedUpdatedAtRef.current[channelKey] = now;
    return true;
  }, []);

  const shouldCommitFocusDeckFeed = useCallback((deckIds: TerminalFocusDeckId[]): boolean => {
    const activeDecks = focusDecksRef.current;
    for (const deckId of deckIds) {
      if (!activeDecks.includes(deckId)) {
        continue;
      }
      if (shouldCommitThrottledChannel(`deck:${deckId}`, TERMINAL_FOCUS_DECK_THROTTLE_MS[deckId])) {
        return true;
      }
    }
    return false;
  }, [shouldCommitThrottledChannel]);

  const shouldPauseNonEssentialRefresh = useCallback((): boolean => {
    if (shouldPausePublicOpsRefresh()) {
      return true;
    }
    if (terminalDensityModeRef.current !== "focus") {
      return false;
    }
    return !focusDecksRef.current.some((deckId) => (
      deckId === "monitoring"
      || deckId === "capital"
      || deckId === "metaRisk"
      || deckId === "correlation"
      || deckId === "calibration"
    ));
  }, []);

  const resetFloatingPanels = () => {
    setFloatingPanels((current) => {
      for (const panel of current) {
        insertDockPanel(panel.fromZone, panel.id);
      }
      return [];
    });
  };

  const restoreSavedLayout = () => {
    if (typeof window === "undefined") {
      return;
    }
    try {
      const raw = window.localStorage.getItem(layoutStorageKey);
      if (!raw) {
        applyLayoutPreset("swing");
        return;
      }
      const parsed = JSON.parse(raw) as Partial<TerminalLayoutConfig>;
      const baseline = buildLayoutPreset(parsed.preset === "scalp" || parsed.preset === "monitoring" ? parsed.preset : "swing", uiMode === "novice");
      const normalized = normalizeDockLayout(parsed, baseline);
      applyNormalizedLayoutState(normalized);
    } catch {
      applyLayoutPreset("swing");
    }
  };

  const saveWorkspaceBundle = (activeName: string, layout: TerminalLayoutConfig) => {
    if (typeof window === "undefined") {
      return;
    }
    let bundle: TerminalWorkspaceBundle = { active: activeName, workspaces: {} };
    try {
      const raw = window.localStorage.getItem(layoutWorkspaceStorageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as TerminalWorkspaceBundle;
        if (parsed && parsed.workspaces && typeof parsed.workspaces === "object") {
          bundle = parsed;
        }
      }
    } catch {
      // noop: fallback to fresh bundle
    }
    const isNewWorkspace = !Object.prototype.hasOwnProperty.call(bundle.workspaces, activeName);
    let nextLayout = layout;
    if (isNewWorkspace && uiMode === "novice") {
      const noviceRiskDefaults = riskAlertDefaultsForPreset(layout.preset);
      nextLayout = {
        ...layout,
        riskAlert: noviceRiskDefaults,
      };
      setRiskAlertWindow(noviceRiskDefaults.window);
      setRiskAlertMissThreshold(noviceRiskDefaults.missThreshold);
      setRiskTimelineRefreshSec(noviceRiskDefaults.refreshSec);
      setRiskHardAlertEnabled(noviceRiskDefaults.hardAlertEnabled);
      setRiskHardAlertThresholdPct(noviceRiskDefaults.hardAlertThresholdPct);
      setWorkspaceHintBadge("Novice preset applied");
    }
    bundle.active = activeName;
    bundle.workspaces = {
      ...bundle.workspaces,
      [activeName]: nextLayout,
    };
    window.localStorage.setItem(layoutWorkspaceStorageKey, JSON.stringify(bundle));
    setLayoutWorkspaceOptions(Object.keys(bundle.workspaces));
    setLayoutWorkspaceName(activeName);
  };

  const resetWorkspaceRiskAlert = () => {
    const defaults = riskAlertDefaultsForPreset(layoutPreset);
    setRiskAlertWindow(defaults.window);
    setRiskAlertMissThreshold(defaults.missThreshold);
    setRiskTimelineRefreshSec(defaults.refreshSec);
    setRiskHardAlertEnabled(defaults.hardAlertEnabled);
    setRiskHardAlertThresholdPct(defaults.hardAlertThresholdPct);
    setWorkspaceHintBadge(`Risk alert reset: ${defaults.missThreshold}/${defaults.window}`);
  };

  const saveCustomChartSidecarLayout = () => {
    if (typeof window === "undefined") {
      return;
    }
    const payload = currentLayoutSnapshot();
    window.localStorage.setItem(layoutStorageKey, JSON.stringify(payload));
    saveWorkspaceBundle(layoutWorkspaceName, payload);
    setWorkspaceHintBadge(`Custom sidecar saved: ${layoutWorkspaceName}`);
  };

  const restoreWorkspaceBundle = () => {
    if (typeof window === "undefined") {
      return;
    }
    try {
      const raw = window.localStorage.getItem(layoutWorkspaceStorageKey);
      if (!raw) {
        setLayoutWorkspaceOptions(DEFAULT_LAYOUT_WORKSPACE_OPTIONS);
        setLayoutWorkspaceName(DEFAULT_LAYOUT_WORKSPACE_NAME);
        return;
      }
      const parsed = JSON.parse(raw) as TerminalWorkspaceBundle;
      const names = Object.keys(parsed.workspaces || {});
      if (names.length === 0) {
        setLayoutWorkspaceOptions(DEFAULT_LAYOUT_WORKSPACE_OPTIONS);
        setLayoutWorkspaceName(DEFAULT_LAYOUT_WORKSPACE_NAME);
        return;
      }
      setLayoutWorkspaceOptions(names);
      const active = parsed.active && names.includes(parsed.active) ? parsed.active : names[0];
      setLayoutWorkspaceName(active);
      const fallback = buildLayoutPreset("swing", uiMode === "novice");
      const normalized = normalizeDockLayout(parsed.workspaces[active], fallback);
      applyNormalizedLayoutState(normalized);
    } catch {
      setLayoutWorkspaceOptions(DEFAULT_LAYOUT_WORKSPACE_OPTIONS);
      setLayoutWorkspaceName(DEFAULT_LAYOUT_WORKSPACE_NAME);
    }
  };

  useEffect(() => {
    if (!workspaceHintBadge) {
      return;
    }
    const timer = window.setTimeout(() => {
      setWorkspaceHintBadge(null);
    }, 2800);
    return () => window.clearTimeout(timer);
  }, [workspaceHintBadge]);

  const setActiveChartSymbol = (symbolValue: string) => {
    const nextSymbol = symbolValue.trim();
    if (!nextSymbol) {
      return;
    }
    setSelectedChartSymbol(nextSymbol);
    setChartVenueOverride(null);
  };

  const setActiveChartSymbolVenue = (symbolValue: string, venueValue?: string) => {
    const nextSymbol = symbolValue.trim();
    if (!nextSymbol) {
      return;
    }
    setSelectedChartSymbol(nextSymbol);
    setChartVenueOverride(venueValue ? venueValue.trim() : null);
  };

  const setActiveChartTimeframe = (timeframeValue: string) => {
    if (isTimeframeSupported(timeframeValue) && CHART_TIMEFRAMES.includes(timeframeValue)) {
      setChartTimeframe(timeframeValue);
    }
  };

  useEffect(() => {
    restoreSavedLayout();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutStorageKey, uiMode]);

  useEffect(() => {
    restoreWorkspaceBundle();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutWorkspaceStorageKey, uiMode]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const payload = currentLayoutSnapshot();
    window.localStorage.setItem(layoutStorageKey, JSON.stringify(payload));
    saveWorkspaceBundle(layoutWorkspaceName, payload);
  }, [chartLinkSymbolEnabled, chartLinkTimeframeEnabled, chartOrderPreviewOpen, chartSidecarProfile, detachedChartSidecars, floatingPanels, layoutCoreSplit, layoutLowerOrder, layoutMicroOrder, layoutMonitoringOrder, layoutPreset, layoutStorageKey, riskAlertMissThreshold, riskAlertWindow, riskHardAlertEnabled, riskHardAlertThresholdPct, riskTimelineRefreshSec]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    try {
      const raw = window.localStorage.getItem(chartLinkStorageKey) || window.localStorage.getItem(legacyChartLinkStorageKey);
      if (!raw) {
        return;
      }
      const payload = JSON.parse(raw) as { symbol?: string; timeframe?: string };
      applyChartLinkPayload(payload);
    } catch {
      // noop
    }
  }, [chartLinkStorageKey, chartLinkSymbolEnabled, chartLinkTimeframeEnabled, legacyChartLinkStorageKey]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    try {
      const raw = window.localStorage.getItem(chartLinkStorageKey);
      const previous = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      const payload = {
        ...previous,
        updatedAt: new Date().toISOString(),
        workspace: layoutWorkspaceName,
        symbol: chartLinkSymbolEnabled ? selectedChartSymbol : previous.symbol,
        timeframe: chartLinkTimeframeEnabled ? chartTimeframe : previous.timeframe,
      };
      window.localStorage.setItem(chartLinkStorageKey, JSON.stringify(payload));
    } catch {
      // noop
    }
  }, [chartLinkStorageKey, chartLinkSymbolEnabled, chartLinkTimeframeEnabled, chartTimeframe, layoutWorkspaceName, selectedChartSymbol]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    try {
      const payload = {
        updatedAt: new Date().toISOString(),
        profile: chartSidecarProfile,
        previewOpen: chartOrderPreviewOpen,
        detached: detachedChartSidecars,
      };
      window.localStorage.setItem(chartSidecarStorageKey, JSON.stringify(payload));
    } catch {
      // noop
    }
  }, [chartOrderPreviewOpen, chartSidecarProfile, chartSidecarStorageKey, detachedChartSidecars]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const handleStorage = (event: StorageEvent) => {
      if ((event.key !== chartLinkStorageKey && event.key !== legacyChartLinkStorageKey) || !event.newValue) {
        return;
      }
      try {
        const payload = JSON.parse(event.newValue) as { symbol?: string; timeframe?: string };
        applyChartLinkPayload(payload);
      } catch {
        // noop
      }
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [chartLinkStorageKey, chartLinkSymbolEnabled, chartLinkTimeframeEnabled, legacyChartLinkStorageKey]);

  const saveCurrentLayout = () => {
    if (typeof window === "undefined") {
      return;
    }
    const payload = currentLayoutSnapshot();
    window.localStorage.setItem(layoutStorageKey, JSON.stringify(payload));
    saveWorkspaceBundle(layoutWorkspaceName, payload);
  };

  const saveNamedWorkspace = () => {
    const name = layoutWorkspaceName.trim();
    if (!name) {
      return;
    }
    saveWorkspaceBundle(name, currentLayoutSnapshot());
  };

  const cycleWorkspace = (direction: 1 | -1) => {
    if (layoutWorkspaceOptions.length === 0) {
      return;
    }
    const currentIndex = Math.max(0, layoutWorkspaceOptions.indexOf(layoutWorkspaceName));
    const nextIndex = (currentIndex + direction + layoutWorkspaceOptions.length) % layoutWorkspaceOptions.length;
    loadNamedWorkspace(layoutWorkspaceOptions[nextIndex]);
  };

  const loadNamedWorkspace = (name: string) => {
    if (typeof window === "undefined") {
      return;
    }
    try {
      const raw = window.localStorage.getItem(layoutWorkspaceStorageKey);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw) as TerminalWorkspaceBundle;
      const layout = parsed.workspaces?.[name];
      if (!layout) {
        return;
      }
      const fallback = buildLayoutPreset("swing", uiMode === "novice");
      const normalized = normalizeDockLayout(layout, fallback);
      setLayoutWorkspaceName(name);
      applyNormalizedLayoutState(normalized);
      saveWorkspaceBundle(name, normalized);
    } catch {
      // noop
    }
  };

  const deleteNamedWorkspace = () => {
    if (typeof window === "undefined") {
      return;
    }
    const name = layoutWorkspaceName.trim();
    if (!name) {
      return;
    }
    try {
      const raw = window.localStorage.getItem(layoutWorkspaceStorageKey);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw) as TerminalWorkspaceBundle;
      if (!parsed.workspaces?.[name]) {
        return;
      }
      delete parsed.workspaces[name];
      const names = Object.keys(parsed.workspaces);
      const nextActive = names.includes(parsed.active) ? parsed.active : names[0] || DEFAULT_LAYOUT_WORKSPACE_NAME;
      parsed.active = nextActive;
      window.localStorage.setItem(layoutWorkspaceStorageKey, JSON.stringify(parsed));
      setLayoutWorkspaceOptions(names.length > 0 ? names : DEFAULT_LAYOUT_WORKSPACE_OPTIONS);
      setLayoutWorkspaceName(nextActive);
      if (names.length > 0) {
        loadNamedWorkspace(nextActive);
      } else {
        applyLayoutPreset("swing");
      }
    } catch {
      // noop
    }
  };

  const exportLayoutsJson = () => {
    if (typeof window === "undefined") {
      return;
    }
    const layout = currentLayoutSnapshot();
    const payload = buildLayoutExportPayload(accountId, layoutWorkspaceName, layout, layoutWorkspaceStorageKey);
    downloadJsonFile(`txt-layouts-${accountId || "default"}.json`, payload);
  };

  const importLayoutsJson = async (file: File) => {
    const text = await file.text();
    const fallback = buildLayoutPreset("swing", uiMode === "novice");
    const imported = parseImportedTerminalLayouts(text, fallback);
    if (imported.kind === "workspaces") {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(layoutWorkspaceStorageKey, JSON.stringify(imported.bundle));
      }
      setLayoutWorkspaceOptions(imported.names);
      setLayoutWorkspaceName(imported.active);
      loadNamedWorkspace(imported.active);
      return;
    }
    applyNormalizedLayoutState(imported.layout);
    saveWorkspaceBundle(layoutWorkspaceName || "Imported", imported.layout);
  };

  const removeDockPanel = (sourceZone: DockZone, panelId: DockPanelId) => {
    if (sourceZone === "micro") {
      setLayoutMicroOrder((current) => current.filter((id) => id !== panelId));
      return;
    }
    if (sourceZone === "lower") {
      setLayoutLowerOrder((current) => current.filter((id) => id !== panelId));
      return;
    }
    setLayoutMonitoringOrder((current) => current.filter((id) => id !== panelId));
  };

  const insertDockPanel = (targetZone: DockZone, panelId: DockPanelId, beforeId?: DockPanelId) => {
    const insert = (current: DockPanelId[]) => {
      const base = current.filter((id) => id !== panelId);
      if (!beforeId || !base.includes(beforeId)) {
        return [...base, panelId];
      }
      const index = base.indexOf(beforeId);
      const next = [...base];
      next.splice(index, 0, panelId);
      return next;
    };

    if (targetZone === "micro") {
      setLayoutMicroOrder(insert);
      return;
    }
    if (targetZone === "lower") {
      setLayoutLowerOrder(insert);
      return;
    }
    setLayoutMonitoringOrder(insert);
  };

  const handleLayoutDrop = (zone: DockZone, targetId: DockPanelId) => {
    if (!layoutEditMode || !layoutDragRef.current) {
      return;
    }
    const drag = layoutDragRef.current;
    setLayoutDropPreview(null);
    layoutDragRef.current = null;
    if (drag.zone === zone) {
      if (zone === "micro") {
        setLayoutMicroOrder((current) => reorderIds(current, drag.id, targetId));
        return;
      }
      if (zone === "lower") {
        setLayoutLowerOrder((current) => reorderIds(current, drag.id, targetId));
        return;
      }
      setLayoutMonitoringOrder((current) => reorderIds(current, drag.id, targetId));
      return;
    }
    removeDockPanel(drag.zone, drag.id);
    insertDockPanel(zone, drag.id, targetId);
  };

  const handleLayoutDropToZone = (zone: DockZone) => {
    if (!layoutEditMode || !layoutDragRef.current) {
      return;
    }
    const drag = layoutDragRef.current;
    setLayoutDropPreview({ zone, mode: "zone" });
    layoutDragRef.current = null;
    if (drag.zone !== zone) {
      removeDockPanel(drag.zone, drag.id);
      insertDockPanel(zone, drag.id);
      setLayoutDropPreview(null);
      return;
    }
    insertDockPanel(zone, drag.id);
    setLayoutDropPreview(null);
  };


  // ─── Floating panel detach / dock ────────────────────────────────────────
  const detachPanel = (id: DockPanelId, zone: DockZone) => {
    removeDockPanel(zone, id);
    const cx = typeof window !== "undefined" ? Math.max(60, window.innerWidth / 2 - 185) : 200;
    const cy = typeof window !== "undefined" ? Math.max(60, window.innerHeight / 2 - 155) : 150;
    setFloatingPanels((prev) => [...prev.filter((fp) => fp.id !== id), clampFloatingPanel({ id, fromZone: zone, x: cx, y: cy, w: 368, h: 320 })]);
  };

  const dockPanel = (id: DockPanelId) => {
    const fp = floatingPanels.find((f) => f.id === id);
    if (!fp) {
      return;
    }
    setFloatingPanels((prev) => prev.filter((f) => f.id !== id));
    insertDockPanel(fp.fromZone, id);
  };

  const detachChartSidecar = (id: ChartSidecarId) => {
    const defaults = CHART_SIDECAR_FLOATING_DEFAULTS[id];
    const cx = typeof window !== "undefined" ? Math.max(60, window.innerWidth / 2 - defaults.w / 2) : 220;
    const cy = typeof window !== "undefined" ? Math.max(60, window.innerHeight / 2 - defaults.h / 2) : 180;
    setDetachedChartSidecars((current) => [
      ...current.filter((panel) => panel.id !== id),
      clampDetachedChartSidecar({ id, x: cx, y: cy, w: defaults.w, h: defaults.h }),
    ]);
  };

  const dockChartSidecar = (id: ChartSidecarId) => {
    setDetachedChartSidecars((current) => current.filter((panel) => panel.id !== id));
  };

  const applyChartSidecarLayout = (mode: Exclude<ChartSidecarLayoutMode, "custom">) => {
    setDetachedChartSidecars(buildDetachedChartSidecarLayout(chartSidecarProfile, mode));
  };

  const loadAll = async (force = false) => {
    if (!force && shouldPauseNonEssentialRefresh()) {
      return;
    }
    const authenticated = await refreshAuthSession();
    if (!authenticated || Date.now() < authBackoffUntilRef.current) {
      return;
    }

    let sawUnauthorized = false;
    const fetchMaybeUnauthorized = async (url: string): Promise<unknown> => {
      const response = await fetch(url, { cache: "no-store" });
      if (response.status === 401 || response.status === 403) {
        sawUnauthorized = true;
        return null;
      }
      if (!response.ok) {
        throw new Error(`${url} -> ${response.status}`);
      }
      return response.json();
    };

    const fetchArrayFallback = async (url: string): Promise<unknown[]> => {
      try {
        const payload = await fetchMaybeUnauthorized(url);
        return Array.isArray(payload) ? payload : [];
      } catch {
        return [];
      }
    };

    const [snapshotPayload, readinessPayload, aiPayload, overviewPayload, incidentPayload, pendingPayload, outcomePayload, mt5Payload, quotesPayload, positionsPayload, balancePayload, performanceSummaryPayload, performanceAttributionPayload, accountsPayload, connectorAccountsPayload, investorReportsPayload] = await Promise.all([
      fetchMaybeUnauthorized("/api/connectors/status"),
      fetchMaybeUnauthorized("/api/live-readiness/overview"),
      fetchMaybeUnauthorized("/api/ai/health"),
      fetchMaybeUnauthorized("/api/dashboard/overview"),
      fetchMaybeUnauthorized("/api/incidents"),
      fetchArrayFallback("/api/mt5/orders/live-pending"),
      fetchArrayFallback("/api/outcomes/recent?limit=20"),
      fetchMaybeUnauthorized("/api/mt5/health"),
      fetchMaybeUnauthorized("/api/market/quotes"),
      fetchMaybeUnauthorized("/api/broker/positions"),
      fetchMaybeUnauthorized("/api/broker/balance"),
      fetchMaybeUnauthorized("/api/performance/summary?scope_type=strategy&scope_id=mt5-live"),
      fetchMaybeUnauthorized("/api/performance/attribution?scope_type=strategy&scope_id=mt5-live&group_by=strategy,symbol,venue"),
      fetchMaybeUnauthorized("/api/accounts"),
      fetchMaybeUnauthorized("/api/connectors/accounts"),
      fetchMaybeUnauthorized("/api/investor-reports?portfolio_id=pf-internal-main&limit=1"),
    ]);

    if (sawUnauthorized) {
      markUnauthorizedBackoff();
      setError(null);
      return;
    }

    setAuthSessionRequired(false);
    setError(null);

    const nextQuotes = Array.isArray(quotesPayload) ? (quotesPayload as JsonMap[]) : [];

    setSnapshot(snapshotPayload && typeof snapshotPayload === "object" ? (snapshotPayload as JsonMap) : null);
    setReadiness(readinessPayload && typeof readinessPayload === "object" ? (readinessPayload as JsonMap) : null);
    setAiHealth(aiPayload && typeof aiPayload === "object" ? (aiPayload as JsonMap) : null);
    setOverview(overviewPayload && typeof overviewPayload === "object" ? (overviewPayload as JsonMap) : null);
    const incidentItems = incidentPayload && typeof incidentPayload === "object"
      ? ((((incidentPayload as JsonMap).items as JsonMap[] | undefined) || []))
      : [];
    setIncidents(incidentItems);
    setPendingLive(Array.isArray(pendingPayload) ? (pendingPayload as JsonMap[]) : []);
    setOutcomes(Array.isArray(outcomePayload) ? (outcomePayload as JsonMap[]) : []);
    setMt5Health(mt5Payload && typeof mt5Payload === "object" ? (mt5Payload as JsonMap) : null);
    setQuotes(nextQuotes);
    setPositions(Array.isArray(positionsPayload) ? (positionsPayload as JsonMap[]) : []);
    setBalance(balancePayload && typeof balancePayload === "object" ? (balancePayload as JsonMap) : null);
    setPerformanceSummary(performanceSummaryPayload && typeof performanceSummaryPayload === "object" ? (performanceSummaryPayload as PerformanceSummaryPayload) : null);
    setPerformanceAttribution(
      performanceAttributionPayload && typeof performanceAttributionPayload === "object"
        ? ((((performanceAttributionPayload as JsonMap).rows as PerformanceAttributionItem[] | undefined) || []).slice(0, 6))
        : [],
    );
    setPerformanceCapitalSources(normalizePerformanceCapitalSources(accountsPayload, connectorAccountsPayload));
    setInvestorReports(
      investorReportsPayload && typeof investorReportsPayload === "object"
        ? ((((investorReportsPayload as JsonMap).items as InvestorReportItem[] | undefined) || []).slice(0, 4))
        : [],
    );

    setQuoteHistory((current) => {
      const updated: QuoteHistoryMap = { ...current };
      const timestamp = new Date();
      const label = `${String(timestamp.getHours()).padStart(2, "0")}:${String(timestamp.getMinutes()).padStart(2, "0")}:${String(timestamp.getSeconds()).padStart(2, "0")}`;
      for (const quote of nextQuotes) {
        const quoteSymbol = instrumentLabel(quote);
        const nextPoint = { label, value: toNumber(quote.last, 0) };
        const existing = updated[quoteSymbol] || [];
        updated[quoteSymbol] = [...existing, nextPoint].slice(-40);
      }
      return updated;
    });
  };

  useEffect(() => {
    loadAll(true).catch((err) => setError(err instanceof Error ? err.message : "Erreur inconnue"));
    const intervalMs = isGtixPublicBrowserHost() ? PUBLIC_TERMINAL_BACKGROUND_REFRESH_MS : 60_000;
    const timer = window.setInterval(() => {
      void loadAll().catch((err) => setError(err instanceof Error ? err.message : "Erreur inconnue"));
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!AUTO_TUNING_WRITEBACK_ENABLED) return;

    let active = true;
    const refresh = async () => {
      if (shouldPauseNonEssentialRefresh()) {
        return;
      }
      try {
        const response = await fetch("/api/strategies/auto-tuning", { cache: "no-store" });
        if (!response.ok) return;
        const payload = await response.json();
        if (!active) return;
        const rows = Array.isArray(payload?.entries) ? payload.entries : [];
        setAutoTuningAuditTrail(rows.slice(0, 20));
      } catch {
        // keep silent in UI; write-back is optional
      }
    };

    void refresh();
    const intervalMs = isGtixPublicBrowserHost() ? PUBLIC_TERMINAL_GOVERNANCE_REFRESH_MS : 45_000;
    const timer = window.setInterval(() => {
      void refresh();
    }, intervalMs);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let pingTimer: number | null = null;
    let pollTimer: number | null = null;
    let closedByUnmount = false;

    const usePollingFallback = typeof window !== "undefined" && isGtixPublicHost(window.location.hostname);

    const applyQuoteSnapshot = (nextQuotes: JsonMap[]) => {
      setQuotes(nextQuotes);
      setQuoteHistory((current) => {
        const updated: QuoteHistoryMap = { ...current };
        const timestamp = new Date();
        const label = `${String(timestamp.getHours()).padStart(2, "0")}:${String(timestamp.getMinutes()).padStart(2, "0")}:${String(timestamp.getSeconds()).padStart(2, "0")}`;
        for (const quote of nextQuotes) {
          const quoteSymbol = instrumentLabel(quote);
          const nextPoint = { label, value: toNumber(quote.last, 0) };
          const existing = updated[quoteSymbol] || [];
          updated[quoteSymbol] = [...existing, nextPoint].slice(-160);
        }
        return updated;
      });
    };

    const schedulePoll = (delayMs: number) => {
      if (closedByUnmount) {
        return;
      }
      if (pollTimer !== null) {
        window.clearTimeout(pollTimer);
      }
      pollTimer = window.setTimeout(() => {
        void connect();
      }, delayMs);
    };

    const connect = async () => {
      if (closedByUnmount) {
        return;
      }
      const authenticated = await refreshAuthSession();
      if (!authenticated) {
        return;
      }
      setAuthSessionRequired(false);
      if (usePollingFallback) {
        const response = await fetch("/api/market/quotes", {
          cache: "no-store",
          headers: buildRoutingRequestHeaders("ui", selectedChartSymbol),
        }).catch(() => null);
        if (closedByUnmount) {
          return;
        }
        if (!response?.ok) {
          schedulePoll(PUBLIC_TERMINAL_FALLBACK_POLL_MS);
          return;
        }
        const payload = await response.json().catch(() => null);
        if (closedByUnmount) {
          return;
        }
        applyQuoteSnapshot(Array.isArray(payload) ? (payload as JsonMap[]) : []);
        schedulePoll(PUBLIC_TERMINAL_FALLBACK_POLL_MS);
        return;
      }
      const token = await fetchWsToken();
      if (token === "__UNAUTHORIZED__") {
        markUnauthorizedBackoff();
        return;
      }
      if (!token) {
        reconnectTimer = window.setTimeout(() => {
          void connect();
        }, 4000);
        return;
      }
      socket = new WebSocket(buildMarketQuotesWsUrl(token));

      socket.onopen = () => {
        pingTimer = window.setInterval(() => {
          if (socket?.readyState === WebSocket.OPEN) {
            socket.send("ping");
          }
        }, 20_000);
      };

      socket.onmessage = (event) => {
        try {
          const payload = JSON.parse(String(event.data || "{}"));
          if (!payload || payload.type !== "snapshot") {
            return;
          }
          const nextQuotes = ((payload.items as JsonMap[] | undefined) || []);
          applyQuoteSnapshot(nextQuotes);
        } catch {
          // Ignore malformed websocket frames.
        }
      };

      socket.onclose = () => {
        if (pingTimer) {
          window.clearInterval(pingTimer);
          pingTimer = null;
        }
        if (closedByUnmount) {
          return;
        }
        if (authStatusRef.current !== "authenticated" || Date.now() < authBackoffUntilRef.current) {
          return;
        }
        reconnectTimer = window.setTimeout(() => {
          void connect();
        }, 2500);
      };
    };

    void connect();

    return () => {
      closedByUnmount = true;
      if (reconnectTimer) {
        window.clearTimeout(reconnectTimer);
      }
      if (pollTimer) {
        window.clearTimeout(pollTimer);
      }
      if (pingTimer) {
        window.clearInterval(pingTimer);
      }
      socket?.close();
    };
  }, []);

  useEffect(() => {
    const hasSelected = quotes.some((quote) => instrumentLabel(quote) === selectedChartSymbol);
    if (!hasSelected && quotes.length > 0) {
      setActiveChartSymbol(instrumentLabel(quotes[0]));
    }
  }, [quotes, selectedChartSymbol]);

  useEffect(() => {
    if (!marketDataBusRef.current) {
      marketDataBusRef.current = createMarketDataBus();
    }
    const unsubscribe = marketDataBusRef.current.subscribe((snapshot) => {
      const allowFastNativeTradesFeed = hasFastNativeTradesConsumer
        && shouldCommitThrottledChannel("feed:nativeTrades:fast", 250);
      const allowSlowNativeTradesFeed = !hasFastNativeTradesConsumer
        && shouldCommitThrottledChannel("feed:nativeTrades:slow", 1800);
      const allowFastDepthFeed = hasFastDepthConsumer
        && shouldCommitThrottledChannel("feed:depth:fast", 250);
      const allowSlowDepthFeed = !hasFastDepthConsumer
        && shouldCommitThrottledChannel("feed:depth:slow", 1800);
      const allowFastMarketMicroFeed = hasFastMarketMicroConsumer
        && shouldCommitThrottledChannel("feed:marketMicro:fast", 250);
      const allowSlowMarketMicroFeed = !hasFastMarketMicroConsumer
        && shouldCommitThrottledChannel("feed:marketMicro:slow", 1800);
      const allowOpsFeed = shouldCommitFocusDeckFeed(["monitoring", "capital", "metaRisk", "correlation", "calibration"]);
      setOhlcvBars((current) => {
        const activeConfig = activeChartConfigRef.current;
        if (snapshot.ohlcvBars.length > 0) {
          const snapshotInstrument = normalizeInstrument(String(snapshot.ohlcvBars[0]?.instrument || activeConfig.instrument));
          const snapshotVenue = String(snapshot.ohlcvBars[0]?.venue || activeConfig.venue);
          const snapshotTimeframe = String(snapshot.ohlcvBars[0]?.tf || activeConfig.timeframe);
          const matchesActiveConfig = chartInstrumentsMatch(snapshotInstrument, activeConfig.instrument)
            && snapshotVenue === activeConfig.venue
            && snapshotTimeframe === activeConfig.timeframe;
          if (!matchesActiveConfig) {
            return current;
          }
          const currentLast = current[current.length - 1];
          const nextLast = snapshot.ohlcvBars[snapshot.ohlcvBars.length - 1];
          if (
            current.length === snapshot.ohlcvBars.length
            && currentLast?.t === nextLast?.t
            && currentLast?.c === nextLast?.c
            && currentLast?.v === nextLast?.v
          ) {
            return current;
          }
          return snapshot.ohlcvBars;
        }
        if (current.length === 0) {
          return current;
        }

        if (snapshot.chartLoading || snapshot.ohlcvStreamState !== "offline") {
          return current;
        }

        const currentInstrument = normalizeInstrument(String(current[0]?.instrument || activeConfig.instrument));
        const currentVenue = String(current[0]?.venue || activeConfig.venue);
        const currentTimeframe = String(current[0]?.tf || activeConfig.timeframe);

        return chartInstrumentsMatch(currentInstrument, activeConfig.instrument)
          && currentVenue === activeConfig.venue
          && currentTimeframe === activeConfig.timeframe
          ? current
          : snapshot.ohlcvBars;
      });
      if (allowFastNativeTradesFeed || allowSlowNativeTradesFeed) {
        startTransition(() => {
          setNativeTrades(snapshot.nativeTrades);
        });
      }
      if (allowFastMarketMicroFeed || allowSlowMarketMicroFeed) {
        startTransition(() => {
          setMarketMicro(snapshot.marketMicro);
          setSessionState(snapshot.sessionState);
        });
      }
      if (allowFastDepthFeed || allowSlowDepthFeed) {
        startTransition(() => {
          setOrderbook(snapshot.orderbook);
          setMarketDepth(snapshot.marketDepth);
          setDepthStreamState(snapshot.depthStreamState);
        });
      }
      if (allowOpsFeed) {
        startTransition(() => {
          setMarketBusMeta(snapshot.busMeta);
          setMarketBusKernelTelemetry(snapshot.kernelTelemetry);
          setMarketBusLastSyncAt(snapshot.lastSyncAt);
          setRoutingScore(snapshot.routingScore);
        });
      }
      setOhlcvStreamState(snapshot.ohlcvStreamState);
      setChartLoading(snapshot.chartLoading);
    });
    return () => {
      unsubscribe();
      marketDataBusRef.current?.disconnect();
    };
  }, [
    hasFastDepthConsumer,
    hasFastMarketMicroConsumer,
    hasFastNativeTradesConsumer,
    shouldCommitFocusDeckFeed,
    shouldCommitThrottledChannel,
  ]);

  useEffect(() => {
    if (authSessionRequired) {
      setOhlcvBars([]);
      setNativeTrades([]);
      setMarketMicro(null);
      setSessionState(null);
      setMarketBusMeta(null);
      setMarketBusKernelTelemetry(DEFAULT_MARKET_BUS_KERNEL_TELEMETRY);
      setMarketBusLastSyncAt(null);
      setRoutingScore(null);
      setOrderbook(null);
      setMarketDepth(null);
      setOhlcvStreamState("offline");
      setDepthStreamState("offline");
      setChartLoading(false);
      marketDataBusRef.current?.disconnect();
      return;
    }
    setChartLoading(true);
    marketDataBusRef.current?.connect({ instrument: selectedChartInstrument, venue: selectedChartVenue, timeframe: chartTimeframe });
  }, [authSessionRequired, chartTimeframe, selectedChartInstrument, selectedChartVenue]);

  useEffect(() => {
    marketDataBusRef.current?.setSchedulerHint({
      fps: chartKernelPerf.fps,
      frameTimeMs: chartKernelPerf.frameTimeMs,
      cpuLoad: chartKernelPerf.cpuLoad,
    });
  }, [chartKernelPerf.cpuLoad, chartKernelPerf.fps, chartKernelPerf.frameTimeMs]);

  useEffect(() => {
    if (chartEngineMode === "v4") {
      setChartPerceptualTelemetry(null);
      return;
    }
    setGpuPerceptualTelemetry(null);
  }, [chartEngineMode]);

  useEffect(() => {
    marketDataBusRef.current?.setBenchmarkMode(kernelBenchmarkRate > 0, kernelBenchmarkRate);
  }, [kernelBenchmarkRate]);

  useEffect(() => {
    if (authSessionRequired || authStatus !== "authenticated") {
      chartRestFallbackKeyRef.current = "";
      return;
    }
    if (ohlcvBars.length > 0) {
      return;
    }

    const fallbackKey = `${selectedChartInstrument}|${selectedChartVenue}|${chartTimeframe}`;
    if (chartRestFallbackKeyRef.current === fallbackKey) {
      return;
    }

    let active = true;
    chartRestFallbackKeyRef.current = fallbackKey;

    const hydrateChartFallback = async () => {
      try {
        const [barsResponse, depthResponse] = await Promise.all([
          fetch(`/api/market/ohlcv?instrument=${encodeURIComponent(selectedChartInstrument)}&venue=${encodeURIComponent(selectedChartVenue)}&timeframe=${encodeURIComponent(chartTimeframe)}&limit=500`, {
            cache: "no-store",
            headers: buildRoutingRequestHeaders("ui", selectedChartSymbol),
          }),
          fetch(`/api/market/orderbook/depth?instrument=${encodeURIComponent(selectedChartInstrument)}&venue=${encodeURIComponent(selectedChartVenue)}`, {
            cache: "no-store",
            headers: buildRoutingRequestHeaders("ui", selectedChartSymbol),
          }),
        ]);

        if (!active) {
          return;
        }

        const barsPayload = await barsResponse.json().catch(() => []);
        const depthPayload = await depthResponse.json().catch(() => null);

        if (Array.isArray(barsPayload) && barsPayload.length > 0) {
            setOhlcvBars((current) => {
              if (!active) {
                return current;
              }
              if (current.length > 0) {
                return current;
              }

              const activeConfig = activeChartConfigRef.current;
              const payloadInstrument = normalizeInstrument(String((barsPayload[0] as OhlcvBar | undefined)?.instrument || activeConfig.instrument));
              const payloadVenue = String((barsPayload[0] as OhlcvBar | undefined)?.venue || activeConfig.venue);
              const payloadTimeframe = String((barsPayload[0] as OhlcvBar | undefined)?.tf || activeConfig.timeframe);

              return chartInstrumentsMatch(payloadInstrument, activeConfig.instrument)
                && payloadVenue === activeConfig.venue
                && payloadTimeframe === activeConfig.timeframe
                ? (barsPayload as OhlcvBar[])
                : current;
            });
          setChartLoading(false);
          setMarketBusLastSyncAt(new Date().toISOString());
        }
        if (depthPayload && typeof depthPayload === "object") {
          setMarketDepth(depthPayload as JsonMap);
          setDepthStreamState("live");
        }
      } catch {
        chartRestFallbackKeyRef.current = "";
      }
    };

    void hydrateChartFallback();

    return () => {
      active = false;
    };
  }, [
    authSessionRequired,
    authStatus,
    chartTimeframe,
    ohlcvBars.length,
    selectedChartInstrument,
    selectedChartSymbol,
    selectedChartVenue,
  ]);

  useEffect(() => {
    marketMetricsAbortRef.current?.abort();
    const controller = new AbortController();
    marketMetricsAbortRef.current = controller;
    if (authSessionRequired || authStatus !== "authenticated" || Date.now() < authBackoffUntilRef.current) {
      controller.abort();
      return;
    }
    let closed = false;
    const loadMetrics = async () => {
      const matrixQuotes = buildMarketMetricsUniverse(quotesRef.current, symbolFilter, marketFilter)
        .filter((quote) => {
          if (quote.venue !== selectedChartVenue) {
            return true;
          }
          return !selectedChartMetricCandidates.has(quote.instrument)
            && !selectedChartMetricCandidates.has(normalizeInstrument(quote.symbolKey));
        });

      if (matrixQuotes.length === 0) {
        controller.abort();
        return;
      }

      const rows = await Promise.all(matrixQuotes.map(async (quote) => {
        const payload = await fetchMarketBusSnapshot(quote.instrument, quote.venue, chartTimeframe);
        const microstructure = payload && typeof payload === "object" && !Array.isArray(payload)
          ? ((payload as JsonMap).microstructure as JsonMap | null | undefined) || null
          : null;
        return {
          symbolKey: quote.symbolKey,
          metric: {
            fundingRate: toNumber(microstructure?.funding_rate, 0),
            openInterest: toNumber(microstructure?.open_interest, 0),
            volume: toNumber(microstructure?.buy_volume, 0) + toNumber(microstructure?.sell_volume, 0),
            depthImbalance: toNumber(microstructure?.depth_imbalance, 0),
            tapeAcceleration: toNumber(microstructure?.tape_acceleration, 0),
            cvd: toNumber(microstructure?.cvd, 0),
            cvdDelta: toNumber(microstructure?.cvd_delta, 0),
            cvdTrend: (String(microstructure?.cvd_trend || "flat") as MarketMetric["cvdTrend"]),
            flowImbalance: toNumber(microstructure?.flow_imbalance, 0),
            spreadBps: toNumber(microstructure?.spread_bps, 0),
            tradeAggressiveness: toNumber(microstructure?.trade_aggressiveness, 0),
            avgLatencyMs: toNumber(microstructure?.avg_latency_ms, 0),
            latencyTier: (String(microstructure?.latency_tier || "normal") as MarketMetric["latencyTier"]),
            activeEventCount: 0,
            lastEventType: null,
          },
        };
      }));

      if (closed || controller.signal.aborted) {
        return;
      }
      setMarketMetricsBySymbol((current) => {
        const next = { ...current };
        for (const row of rows) {
          next[row.symbolKey] = row.metric;
        }
        return next;
      });
    };

    void loadMetrics();
    const intervalMs = isGtixPublicBrowserHost() ? PUBLIC_TERMINAL_GOVERNANCE_REFRESH_MS : 30_000;
    const timer = window.setInterval(() => {
      void loadMetrics();
    }, intervalMs);

    return () => {
      closed = true;
      window.clearInterval(timer);
      controller.abort();
    };
  }, [authSessionRequired, authStatus, chartTimeframe, fetchMarketBusSnapshot, marketMetricsUniverseKey, marketFilter, selectedChartMetricCandidates, selectedChartVenue, symbolFilter]);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let pingTimer: number | null = null;
    let pollTimer: number | null = null;
    let closedByUnmount = false;

    const usePollingFallback = typeof window !== "undefined" && isGtixPublicHost(window.location.hostname);

    const schedulePoll = (delayMs: number) => {
      if (closedByUnmount) {
        return;
      }
      if (pollTimer !== null) {
        window.clearTimeout(pollTimer);
      }
      pollTimer = window.setTimeout(() => {
        void connect();
      }, delayMs);
    };

    const connect = async () => {
      if (closedByUnmount) {
        return;
      }
      setTelemetryStreamState("connecting");
      const authenticated = await refreshAuthSession();
      if (!authenticated) {
        setTelemetryStreamState("offline");
        return;
      }
      setAuthSessionRequired(false);
      if (usePollingFallback) {
        const response = await fetch("/api/execution/telemetry/recent?limit=20", {
          cache: "no-store",
          headers: buildRoutingRequestHeaders("execution", selectedChartSymbol),
        }).catch(() => null);
        if (closedByUnmount) {
          return;
        }
        if (!response?.ok) {
          setTelemetryStreamState("offline");
          schedulePoll(PUBLIC_TERMINAL_FALLBACK_POLL_MS);
          return;
        }
        const payload = await response.json().catch(() => null);
        if (closedByUnmount) {
          return;
        }
        setExecutionTelemetry(Array.isArray(payload) ? (payload as JsonMap[]).slice(0, 20) : []);
        setTelemetryStreamState("live");
        schedulePoll(PUBLIC_TERMINAL_FALLBACK_POLL_MS);
        return;
      }
      const token = await fetchWsToken();
      if (token === "__UNAUTHORIZED__") {
        markUnauthorizedBackoff();
        setTelemetryStreamState("offline");
        return;
      }
      if (!token) {
        setTelemetryStreamState("offline");
        reconnectTimer = window.setTimeout(() => {
          void connect();
        }, 4000);
        return;
      }
      const wsUrl = buildExecutionTelemetryWsUrl(token, 20, {
        requestType: "execution",
        priority: "high",
        volatility: overlayDecisionRegime === "high" ? "high" : overlayDecisionRegime === "medium" ? "medium" : "low",
        signalState: marketDecisionV1.scenario === "reversal" ? "reversal" : marketDecisionV1.criticalConfirmed ? "fast" : "normal",
        symbol: normalizeInstrument(selectedChartSymbol),
      });
      socket = new WebSocket(wsUrl);

      socket.onopen = () => {
        setTelemetryStreamState("live");
        pingTimer = window.setInterval(() => {
          if (socket?.readyState === WebSocket.OPEN) {
            socket.send("ping");
          }
        }, 20_000);
      };

      socket.onmessage = (event) => {
        try {
          const payload = JSON.parse(String(event.data || "{}"));
          if (!payload || typeof payload !== "object") {
            return;
          }
          if (payload.type === "snapshot") {
            setExecutionTelemetry(((payload.items as JsonMap[] | undefined) || []).slice(0, 20));
            return;
          }
          if (payload.type === "telemetry") {
            const item = (payload.item as JsonMap | undefined) || null;
            if (!item) {
              return;
            }
            setExecutionTelemetry((current) => {
              const currentId = String(item.telemetry_id || "");
              const nextItems = [item, ...current.filter((entry) => String(entry.telemetry_id || "") !== currentId)];
              return nextItems.slice(0, 20);
            });
          }
        } catch {
          // Ignore malformed websocket frames.
        }
      };

      socket.onerror = () => {
        setTelemetryStreamState("offline");
      };

      socket.onclose = () => {
        if (pingTimer) {
          window.clearInterval(pingTimer);
          pingTimer = null;
        }
        if (closedByUnmount) {
          return;
        }
        setTelemetryStreamState("offline");
        if (authStatusRef.current !== "authenticated" || Date.now() < authBackoffUntilRef.current) {
          return;
        }
        reconnectTimer = window.setTimeout(() => {
          void connect();
        }, 2500);
      };
    };

    void connect();

    return () => {
      closedByUnmount = true;
      if (reconnectTimer) {
        window.clearTimeout(reconnectTimer);
      }
      if (pollTimer) {
        window.clearTimeout(pollTimer);
      }
      if (pingTimer) {
        window.clearInterval(pingTimer);
      }
      socket?.close();
    };
  }, []);

  useEffect(() => {
    const candidateIds = (executionTelemetry.length > 0 ? executionTelemetry : outcomes)
      .map((item) => decisionIdFrom(item))
      .filter((id) => id.length > 0);
    if (candidateIds.length === 0) {
      setReplayDecisionId("");
      setReplayPayload(null);
      setReplayError(null);
      return;
    }
    if (!candidateIds.includes(replayDecisionId)) {
      setReplayDecisionId(candidateIds[0]);
    }
  }, [executionTelemetry, outcomes, replayDecisionId]);

  useEffect(() => {
    if (!replayDecisionId) {
      setReplayPayload(null);
      setReplayError(null);
      return;
    }
    let cancelled = false;
    setReplayLoading(true);
    setReplayError(null);
    fetch(`/api/execution/replay/${encodeURIComponent(replayDecisionId)}`, {
      cache: "no-store",
      headers: buildRoutingRequestHeaders("ai", selectedChartSymbol),
    })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Replay indisponible (${response.status})`);
        }
        return response.json();
      })
      .then((payload) => {
        if (!cancelled) {
          setReplayPayload((payload || null) as JsonMap | null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setReplayPayload(null);
          setReplayError(err instanceof Error ? err.message : "Replay indisponible");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setReplayLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [replayDecisionId]);

  useEffect(() => {
    const replayNetwork = replayPayload?.network && typeof replayPayload.network === "object"
      ? replayPayload.network as JsonMap
      : null;
    if (!replayDecisionId || !replayNetwork) {
      return;
    }
    setReplayNetworkByDecisionId((current) => ({
      ...current,
      [replayDecisionId]: {
        ...replayNetwork,
        decision_id: replayDecisionId,
      },
    }));
  }, [replayDecisionId, replayPayload]);

  useEffect(() => {
    const brainReplay = replayPayload?.brain_replay && typeof replayPayload.brain_replay === "object"
      ? replayPayload.brain_replay as JsonMap
      : null;
    if (!brainReplay) {
      return;
    }
    const attribution = brainReplay.attribution && typeof brainReplay.attribution === "object"
      ? normalizeReplayAttributionSnapshot(brainReplay.attribution as JsonMap)
      : null;
    const experienceRows = Array.isArray(brainReplay.experience_rows)
      ? brainReplay.experience_rows.filter((row): row is JsonMap => Boolean(row) && typeof row === "object")
      : [];
    if (!attribution && experienceRows.length === 0) {
      return;
    }
    setReplayAttributionByDecisionId((current) => {
      const next = { ...current };
      if (attribution?.id) {
        next[attribution.id] = attribution;
        return next;
      }
      for (const row of experienceRows) {
        const snapshot = buildReplayAttributionSnapshotFromExperience(row);
        if (!snapshot) {
          continue;
        }
        if (snapshot.synthetic && snapshot.dreamSource && snapshot.dreamSource !== snapshot.id) {
          next[snapshot.dreamSource] = mergeReplayDreamEcho(next[snapshot.dreamSource], snapshot);
        }
        const existing = next[snapshot.id];
        next[snapshot.id] = existing
          ? {
              ...snapshot,
              dreamCount: existing.dreamCount,
              dreamWeight: existing.dreamWeight,
            }
          : snapshot;
      }
      return next;
    });
  }, [replayPayload]);

  function buildTradeTicketBody(overrides?: TradeTicketOverrides): JsonMap {
    return {
      account_id: accountId,
      symbol: overrides?.symbol || symbol,
      side: overrides?.side || side,
      lots: Number.isFinite(overrides?.lots) ? overrides?.lots : lots,
      estimated_notional_usd: Number.isFinite(overrides?.notional) ? overrides?.notional : notional,
      max_spread_bps: Number.isFinite(overrides?.maxSpread) ? overrides?.maxSpread : maxSpread,
      preferred_venue: overrides?.preferredVenue,
      rationale: overrides?.rationale || rationale,
      predictor_context: predictorRequestPayload,
      order_intent: overrides?.orderIntent,
      metadata: overrides?.metadata,
    };
  }

  async function executeTradeTicketRequest(overrides?: TradeTicketOverrides): Promise<JsonMap> {
    void marketDataBusRef.current?.refreshNow("execution");
    const response = await fetch("/api/mt5/orders/filter", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...buildRoutingRequestHeaders("execution", overrides?.symbol || symbol),
      },
      body: JSON.stringify(buildTradeTicketBody(overrides)),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(String(payload?.detail || "Ticket d'ordre rejete"));
    }
    return (payload || null) as JsonMap;
  }

  async function submitTradeTicket(overrides?: TradeTicketOverrides): Promise<void> {
    if (replayState.enabled) {
      setError("Replay Mode actif — execution live desactivee.");
      return;
    }
    setBusy(true);
    setError(null);
    setTradeResult(null);
    try {
      const payload = await executeTradeTicketRequest(overrides);
      setTradeResult(payload);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur inconnue");
    } finally {
      setBusy(false);
    }
  }

  async function executeV7ArbOpportunity(decision: V7Decision, confirmAck = false): Promise<void> {
    const opportunity = decision.opportunity;
    if (!opportunity || decision.routeMode !== "dualVenueExecution") {
      await submitChartOrder(confirmAck);
      return;
    }
    if (!decision.shouldExecute) {
      setError(`V7 blocked: ${decision.reasons.join(", ") || "net edge unavailable"}`);
      pushChartSendHistory("blocked-loss");
      return;
    }
    if (replayState.enabled) {
      setError("Replay Mode actif — execution live desactivee.");
      return;
    }

    const arbNotional = Math.max(1000, autoExecutionMode === "full-auto" ? autoSizingV3.finalNotional : notional);
    const maxLegSpread = Math.max(2, Math.min(maxSpread, Math.ceil(opportunity.expectedNetEdgeBps + opportunity.expectedSlippageBps + 2)));
    const baseMetadata: JsonMap = {
      ui_feature: "v7-arb-execution",
      route_mode: decision.routeMode,
      expected_net_edge_bps: Number(opportunity.expectedNetEdgeBps.toFixed(3)),
      expected_slippage_bps: Number(opportunity.expectedSlippageBps.toFixed(3)),
      latency_cost_bps: Number(opportunity.latencyCostBps.toFixed(3)),
      confidence: Number(opportunity.confidence.toFixed(3)),
      predictor_governor_mode: backendBrainGovernorMode,
      predictor_strategy_mode: backendBrainStrategyMode,
    };
    const baseIntent: JsonMap = {
      source: "terminal-v7",
      mode: "v7-arbitrage",
      risk_preview: {
        notional: arbNotional,
        max_spread_bps: maxLegSpread,
        confirm_ack: confirmAck,
      },
      hedge: {
        enabled: true,
        buy_venue: opportunity.buyVenue,
        sell_venue: opportunity.sellVenue,
      },
      predictor_execution_adjustments: {
        governor_mode: backendBrainGovernorMode,
        size_multiplier: backendBrainGovernorSizeMultiplier,
        strategy_mode: backendBrainStrategyMode,
        strategy_switch_mode: backendBrainStrategySwitchMode,
        route_mode_override: backendBrainStrategyRouteModeOverride,
        execution_style: backendBrainStrategyExecutionStyle,
        max_spread_multiplier: backendBrainStrategyMaxSpreadMultiplier,
        size_multiplier_cap: backendBrainStrategySizeCap,
      },
    };

    setBusy(true);
    setError(null);
    setTradeResult(null);
    try {
      const result = await executionEngineV7Ref.current.executeArb({
        opportunity,
        buyOrder: {
          symbol: selectedChartSymbol,
          side: "buy",
          notionalUsd: arbNotional,
          venue: opportunity.buyVenue,
          maxSpreadBps: maxLegSpread,
          rationale: `${rationale || "V7 arbitrage"} | buy leg ${opportunity.buyVenue} edge=${opportunity.expectedNetEdgeBps.toFixed(2)}bps`,
          metadata: { ...baseMetadata, leg: "buy", preferred_venue: opportunity.buyVenue },
          orderIntent: { ...baseIntent, leg: "buy" },
        },
        sellOrder: {
          symbol: selectedChartSymbol,
          side: "sell",
          notionalUsd: arbNotional,
          venue: opportunity.sellVenue,
          maxSpreadBps: maxLegSpread,
          rationale: `${rationale || "V7 arbitrage"} | sell leg ${opportunity.sellVenue} edge=${opportunity.expectedNetEdgeBps.toFixed(2)}bps`,
          metadata: { ...baseMetadata, leg: "sell", preferred_venue: opportunity.sellVenue },
          orderIntent: { ...baseIntent, leg: "sell" },
        },
        sendOrder: async (order) => {
          try {
            const payload = await executeTradeTicketRequest({
              symbol: order.symbol,
              side: order.side,
              notional: order.notionalUsd,
              preferredVenue: order.venue,
              maxSpread: order.maxSpreadBps,
              rationale: order.rationale,
              orderIntent: order.orderIntent,
              metadata: order.metadata,
            });
            const routed = (payload.routed_execution && typeof payload.routed_execution === "object") ? (payload.routed_execution as JsonMap) : {};
            executionEngineV7Ref.current.updateFeedback({
              venue: order.venue || String(routed.venue || ""),
              latencyMs: toNumber(payload.latency_ms ?? payload.latency_e2e_ms, 0),
              realizedSlippageBps: toNumber(payload.realized_slippage_bps, 0),
            });
            return { ok: true, venue: order.venue || "", payload };
          } catch (error) {
            return { ok: false, venue: order.venue || "", error: error instanceof Error ? error.message : "order_failed" };
          }
        },
        hedgeImmediately: async (failedLeg, succeeded) => {
          const payload = succeeded.payload || {};
          const venue = String((payload.routed_execution as JsonMap | undefined)?.venue || succeeded.venue || "");
          executionEngineV7Ref.current.updateFeedback({
            venue,
            latencyMs: toNumber(payload.latency_ms ?? payload.latency_e2e_ms, 0),
            realizedSlippageBps: toNumber(payload.realized_slippage_bps, 0),
          });
          setError(`V7 hedge required: ${failedLeg} leg failed after ${venue || "counterparty"} filled.`);
        },
      });
      setTradeResult({
        mode: "v7-arbitrage",
        ok: result.ok,
        hedged: result.hedged,
        buy: result.buy.payload || { error: result.buy.error, venue: result.buy.venue },
        sell: result.sell.payload || { error: result.sell.error, venue: result.sell.venue },
        expected_net_edge_bps: opportunity.expectedNetEdgeBps,
        expected_slippage_bps: opportunity.expectedSlippageBps,
      });
      pushChartSendHistory(result.ok ? "submitted" : "blocked-loss");
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur inconnue");
    } finally {
      setBusy(false);
      setChartHudConfirmArmed(false);
      setChartOrderPreviewOpen(false);
    }
  }

  function buildV7LocalGateDecision(notionalUsd: number): V7Decision {
    const avgLatencyMs = executionTelemetry.length > 0
      ? average(executionTelemetry.map((item) => toNumber(item.latency_e2e_ms, 0)))
      : average(filteredOutcomes.map((item) => toNumber(item.latency_ms, 0)));
    const effectiveLatencyMs = Math.max(avgLatencyMs, marketBusKernelTelemetry.tickLatencyMs);
    const routingCandidates = Array.isArray(routingScore?.candidates)
      ? routingScore.candidates as JsonMap[]
      : [];
    const decision = executionEngineV7Ref.current.buildDecision({
      arbitrage: (routingScore?.arbitrage as JsonMap | undefined) || null,
      routingCandidates,
      bestRoute: (routingScore?.best as JsonMap | undefined) || null,
      backupRoute: (routingScore?.backup as JsonMap | undefined) || null,
      marketMicro,
      avgExecutionLatencyMs: avgLatencyMs,
      renderFrameMs: chartKernelPerf.frameTimeMs,
      renderFps: chartKernelPerf.fps,
      notionalUsd,
      feePenaltyBps: 6,
    });
    if (decision.routeMode === "dualVenueExecution" && !dataReliabilitySnapshot.ready) {
      return {
        ...decision,
        shouldExecute: false,
        reasons: [...decision.reasons, ...dataReliabilitySnapshot.reasons, "data_reliability_gate"],
      };
    }
    if (decision.routeMode === "dualVenueExecution" && effectiveLatencyMs >= V8_LATENCY_GUARD_MS) {
      return {
        ...decision,
        shouldExecute: false,
        reasons: [...decision.reasons, "latency_guard_arbitrage_disabled"],
      };
    }
    return decision;
  }

  function getV7LocalGateDecision(): V7Decision {
    return buildV7LocalGateDecision(autoExecutionMode === "full-auto" ? autoSizingV3.finalNotional : notional);
  }

  function getV7ExecutionDecision(): V7Decision {
    const decision = getV7LocalGateDecision();
    if (decision.routeMode !== "dualVenueExecution") {
      return decision;
    }
    if (backendBrainGovernorBlocked) {
      return {
        ...decision,
        shouldExecute: false,
        reasons: Array.from(new Set([...decision.reasons, ...backendBrainGovernorReasons, "brain_governor_blocked"])),
      };
    }
    if (backendBrainStrategyRouteModeOverride === "bestSingleVenue") {
      return {
        ...decision,
        routeMode: "bestSingleVenue",
        shouldExecute: false,
        reasons: Array.from(new Set([...decision.reasons, ...backendBrainStrategyReasons, `strategy_switch:${backendBrainStrategyMode || backendBrainStrategySwitchMode || "single_venue"}`])),
      };
    }
    const backendPredictorShouldExecute = typeof backendPredictorSnapshot?.should_execute === "boolean"
      ? Boolean(backendPredictorSnapshot.should_execute)
      : false;
    const backendPredictorReasons = Array.isArray(backendPredictorSnapshot?.reasons)
      ? (backendPredictorSnapshot.reasons as unknown[]).map((reason) => String(reason))
      : ["v8_backend_gate_pending"];
    if (decision.routeMode === "dualVenueExecution" && !backendPredictorShouldExecute) {
      return {
        ...decision,
        shouldExecute: false,
        reasons: Array.from(new Set([...decision.reasons, ...backendPredictorReasons])),
      };
    }
    return decision;
  }

  async function submitChartOrder(confirmAck = false): Promise<void> {
    if (backendBrainGovernorBlocked) {
      setError(`Brain governor blocked: ${backendBrainGovernorReasons.join(", ") || "execution disabled"}`);
      pushChartSendHistory("blocked-loss");
      return;
    }
    if (!(chartOrderTicket.entry > 0) || !(chartRiskPerUnit > 0) || !(chartRewardPerUnit > 0)) {
      setError("Bracket invalide: verifier Entry / SL / TP avant envoi.");
      return;
    }
    if (chartRiskLossExceeded) {
      setError(`Perte max depassee: ${chartRiskUsd.toFixed(2)}$ > ${chartMaxLossUsd.toFixed(2)}$`);
      pushChartSendHistory("blocked-loss");
      return;
    }
    const sideValue = chartOrderTicket.side;
    const rr = chartRiskReward > 0 ? chartRiskReward.toFixed(2) : "0.00";
    const rationaleAddon = `ChartBracket entry=${chartOrderTicket.entry.toFixed(4)} sl=${chartOrderTicket.sl.toFixed(4)} tp=${chartOrderTicket.tp.toFixed(4)} oco=${chartOrderTicket.oco ? "on" : "off"} riskUSD=${chartRiskUsd.toFixed(2)} rewardUSD=${chartRewardUsd.toFixed(2)} rr=${rr} maxLoss=${chartMaxLossUsd.toFixed(2)} targetGain=${chartTargetGainUsd.toFixed(2)} riskGuard=${chartRiskGuardEnabled ? "on" : "off"}`;
    const orderIntent: JsonMap = {
      source: "terminal-chart",
      mode: "bracket",
      preset: chartOrderTicket.preset,
      oco: {
        enabled: chartOrderTicket.oco,
        group_id: chartOrderTicket.oco ? `oco-${Date.now()}-${Math.floor(Math.random() * 100000)}` : "",
        cancel_policy: "cancel-other-on-fill",
      },
      bracket: {
        entry: chartOrderTicket.entry,
        stop_loss: chartOrderTicket.sl,
        take_profit: chartOrderTicket.tp,
        rr_ratio: chartRiskReward,
        risk_usd: chartRiskUsd,
        reward_usd: chartRewardUsd,
      },
      risk_preview: {
        qty: chartOrderQty,
        notional,
        max_spread_bps: maxSpread,
        max_loss_usd: chartMaxLossUsd,
        target_gain_usd: chartTargetGainUsd,
        target_rr: chartRiskTargetRr,
        guard_enabled: chartRiskGuardEnabled,
        confirm_ack: confirmAck,
      },
      predictor_execution_adjustments: {
        governor_mode: backendBrainGovernorMode,
        size_multiplier: backendBrainGovernorSizeMultiplier,
        strategy_mode: backendBrainStrategyMode,
        strategy_switch_mode: backendBrainStrategySwitchMode,
        route_mode_override: backendBrainStrategyRouteModeOverride,
        execution_style: backendBrainStrategyExecutionStyle,
        max_spread_multiplier: backendBrainStrategyMaxSpreadMultiplier,
        size_multiplier_cap: backendBrainStrategySizeCap,
      },
    };
    await submitTradeTicket({
      symbol: selectedChartSymbol,
      side: sideValue,
      notional,
      rationale: `${rationale || "Chart order"} | ${rationaleAddon}`,
      orderIntent,
      metadata: {
        ui_feature: "chart-trading-v2",
      },
    });
    pushChartSendHistory("submitted");
    setChartHudConfirmArmed(false);
    setChartOrderPreviewOpen(false);
  }

  const connectors = (snapshot?.connectors as JsonMap[] | undefined) || [];
  const alerts = (snapshot?.alerts as JsonMap[] | undefined) || [];
  const providerRows = (((aiHealth?.providers as JsonMap | undefined)?.providers as JsonMap[] | undefined) || []).slice(0, 8);
  const drift = (readiness?.drift as JsonMap | undefined) || {};
  const suspended = (drift.suspended_strategies as JsonMap[] | undefined) || [];
  const driftItems = (drift.items as JsonMap[] | undefined) || [];
  const memorySummary = (((readiness?.memory_kpi as JsonMap | undefined)?.summary as JsonMap | undefined) || {});
  const balances = ((balance?.balances as JsonMap[] | undefined) || []).slice(0, 6);
  const publicOpsPanelBadge = isGtixPublicBrowserHost() && publicOpsRefreshPaused
    ? <span className="monitoring-panel-state-badge paused">bg</span>
    : null;

  const filteredQuotes = quotes.filter((quote) => {
    const quoteSymbol = instrumentLabel(quote);
    const market = classifyInstrument(quoteSymbol);
    const matchesSymbol = !symbolFilter || quoteSymbol.toLowerCase().includes(symbolFilter.toLowerCase());
    const matchesMarket = marketFilter === "all" || market === marketFilter;
    return matchesSymbol && matchesMarket;
  });

  const uniqueFilteredQuotes = useMemo(() => {
    const seenSymbols = new Set<string>();
    return filteredQuotes.filter((quote) => {
      const quoteSymbol = instrumentLabel(quote);
      if (seenSymbols.has(quoteSymbol)) {
        return false;
      }
      seenSymbols.add(quoteSymbol);
      return true;
    });
  }, [filteredQuotes]);

  const filteredOutcomes = outcomes.filter((item) => {
    const outcomeSymbol = instrumentLabel(item);
    const market = classifyInstrument(outcomeSymbol);
    const matchesSymbol = !symbolFilter || outcomeSymbol.toLowerCase().includes(symbolFilter.toLowerCase());
    const matchesMarket = marketFilter === "all" || market === marketFilter;
    const status = String(item.status || "").toLowerCase();
    const matchesEnvironment = environmentFilter === "all" || status.includes(environmentFilter);
    return matchesSymbol && matchesMarket && matchesEnvironment;
  });

  const filteredAlerts = alerts.filter((item) => severityFilter === "all" || String(item.level || "").toLowerCase() === severityFilter);

  const signalHistoricalLearningBundle = useMemo(() => {
    const normalizedSymbol = normalizeInstrument(selectedChartSymbol);
    const currentMarket = classifyInstrument(selectedChartSymbol);
    const readOutcomeTf = (item: JsonMap): string | null => {
      const raw = String(item.timeframe || item.chart_timeframe || item.strategy_timeframe || item.tf || "").trim();
      return raw === "1m" || raw === "5m" || raw === "15m" ? raw : null;
    };
    const inferOutcomeScenario = (item: JsonMap): MarketDecisionScenario | null => {
      const text = [
        item.scenario,
        item.scenario_type,
        item.setup,
        item.pattern,
        item.tag,
        item.signal,
        item.strategy_name,
        item.strategy_id,
        item.strategy,
      ].map((value) => String(value || "").toLowerCase()).join(" ");
      if (/reversal|mean\s*reversion|fade|trap|sweep|absorption|fake\s*breakout/.test(text)) {
        return "reversal";
      }
      if (/continuation|breakout|momentum|trend|follow\s*through|impulse/.test(text)) {
        return "continuation";
      }
      const mfe = Math.abs(toNumber(item.mfe_bps, NaN));
      const mae = Math.abs(toNumber(item.mae_bps, NaN));
      if (Number.isFinite(mfe) && Number.isFinite(mae) && mfe > 0 && mae > 0) {
        const ratio = mfe / Math.max(1, mae);
        if (ratio >= 2.1) {
          return "continuation";
        }
        if (ratio <= 0.95) {
          return "reversal";
        }
      }
      return "balance";
    };
    const buildLearning = (sample: JsonMap[], scopeLabel: string): MarketHistoricalLearning => {
      if (sample.length === 0) {
        return {
          sampleSize: 0,
          scopeLabel,
          winratePct: 50,
          learnedWeights: { ...DEFAULT_CONFLUENCE_WEIGHTS },
        };
      }
      const winrate = sample.filter((item) => toNumber(item.pnl_usd, toNumber(item.net_result_usd, 0)) >= 0).length / sample.length;
      const avgPnlPct = average(sample.map((item) => toNumber(item.pnl_pct, 0)));
      const avgMfe = average(sample.map((item) => toNumber(item.mfe_bps, 0)));
      const avgMae = average(sample.map((item) => Math.abs(toNumber(item.mae_bps, 0))));
      const avgSlip = average(sample.map((item) => Math.abs(toNumber(item.realized_slippage_bps || item.slippage_real_bps, 0))));
      const confidence = clamp(sample.length / 28, 0.22, 1);
      const learnedWeights: MarketConfluenceWeights = {
        dom: clamp(0.9 + (winrate - 0.5) * 0.7 + Math.max(0, 12 - avgSlip) * 0.015 * confidence, 0.72, 1.35),
        footprint: clamp(0.92 + (winrate - 0.5) * 0.9 + avgPnlPct * 0.018 * confidence, 0.72, 1.42),
        liquidity: clamp(0.9 + Math.max(0, 18 - avgMae) * 0.01 * confidence + Math.max(0, 10 - avgSlip) * 0.02 * confidence, 0.74, 1.46),
        "price-action": clamp(0.9 + avgMfe * 0.002 * confidence + (winrate - 0.5) * 0.55, 0.74, 1.36),
      };
      return {
        sampleSize: sample.length,
        scopeLabel,
        winratePct: winrate * 100,
        learnedWeights,
      };
    };
    const withPnl = filteredOutcomes.filter((item) => Number.isFinite(toNumber(item.pnl_usd, NaN)) || Number.isFinite(toNumber(item.net_result_usd, NaN)));
    const exact = withPnl.filter((item) => normalizeInstrument(instrumentLabel(item)) === normalizedSymbol && (!readOutcomeTf(item) || readOutcomeTf(item) === chartTimeframe));
    const fallback = withPnl.filter((item) => classifyInstrument(instrumentLabel(item)) === currentMarket);
    const scoped = (exact.length >= 6 ? exact : fallback).slice(0, 120);
    const scopeLabel = exact.length >= 6 ? `${selectedChartSymbol} ${chartTimeframe}` : `${currentMarket} fallback`;
    const mixed = buildLearning(scoped.slice(0, 80), scopeLabel);
    const byScenario: Record<MarketDecisionScenario, MarketHistoricalLearning> = {
      reversal: buildLearning(scoped.filter((item) => inferOutcomeScenario(item) === "reversal").slice(0, 80), `${scopeLabel} · reversal`),
      continuation: buildLearning(scoped.filter((item) => inferOutcomeScenario(item) === "continuation").slice(0, 80), `${scopeLabel} · continuation`),
      balance: buildLearning(scoped.filter((item) => inferOutcomeScenario(item) === "balance").slice(0, 80), `${scopeLabel} · balance`),
    };
    for (const scenario of ["reversal", "continuation", "balance"] as const) {
      if (byScenario[scenario].sampleSize >= 4) {
        continue;
      }
      byScenario[scenario] = {
        sampleSize: mixed.sampleSize,
        scopeLabel: `${scopeLabel} · ${scenario} fallback`,
        winratePct: mixed.winratePct,
        learnedWeights: { ...mixed.learnedWeights },
      };
    }
    return { mixed, byScenario };
  }, [chartTimeframe, filteredOutcomes, selectedChartSymbol]);
  const signalHistoricalLearning = signalHistoricalLearningBundle.mixed;

  const marketBuckets = ["crypto", "fx", "indices", "cfd", "futures"].map((market) => {
    const bucketQuotes = filteredQuotes.filter((quote) => classifyInstrument(instrumentLabel(quote)) === market);
    const bucketOutcomes = filteredOutcomes.filter((item) => classifyInstrument(instrumentLabel(item)) === market);
    const bucketPositions = positions.filter((item) => classifyInstrument(instrumentLabel(item)) === market);

    const pnl = bucketOutcomes.reduce((sum, item) => sum + toNumber(item.net_result_usd, 0), 0);
    const exposure = bucketPositions.reduce((sum, item) => sum + toNumber(item.net_notional_usd, 0), 0);

    return {
      market,
      quoteCount: bucketQuotes.length,
      pnl,
      exposure,
    };
  });

  const replayTelemetry = (replayPayload?.telemetry as JsonMap | undefined) || null;
  const replayNetwork = replayPayload?.network && typeof replayPayload.network === "object"
    ? replayPayload.network as JsonMap
    : null;
  const replayGlobalNetworkMetrics = replayPayload?.network_metrics && typeof replayPayload.network_metrics === "object"
    ? replayPayload.network_metrics as JsonMap
    : null;
  const replayNetworkState = String(replayNetwork?.network_state ?? replayPayload?.network_state ?? "healthy").toLowerCase();
  const replayRetryCount = Math.max(0, toNumber(replayNetwork?.retry_count ?? replayPayload?.retry_count, 0));
  const replayDegradedFlag = Boolean(replayNetwork?.degraded_flag ?? replayPayload?.degraded_flag);
  const replayFailureClassification = String(replayNetwork?.failure_classification || replayPayload?.failure_classification || "none").toLowerCase();
  const replayFailureDetail = String(replayNetwork?.failure_detail || replayPayload?.failure_detail || "");
  const replayAttemptedTargets = Array.isArray(replayNetwork?.attempted_targets)
    ? (replayNetwork.attempted_targets as unknown[]).map((item) => String(item)).filter(Boolean)
    : [];
  const replayAttemptedBaseUrls = Array.isArray(replayNetwork?.attempted_base_urls)
    ? (replayNetwork.attempted_base_urls as unknown[]).map((item) => String(item)).filter(Boolean)
    : [];
  const replayInfraHealthScore = (() => {
    if (replayDegradedFlag) {
      return 0.2;
    }
    let score = 1;
    if (replayRetryCount > 0) {
      score -= Math.min(0.3, replayRetryCount * 0.1);
    }
    if (replayFailureClassification === "dns_transient") {
      score -= 0.12;
    } else if (replayFailureClassification === "timeout") {
      score -= 0.16;
    } else if (replayFailureClassification === "connection_reset") {
      score -= 0.1;
    } else if (replayFailureClassification === "connection_refused") {
      score -= 0.2;
    } else if (replayFailureClassification === "aborted") {
      score -= 0.08;
    } else if (replayFailureClassification === "network_unknown") {
      score -= 0.12;
    }
    return clamp(score, 0.2, 1);
  })();
  const replayInfraLabel = replayInfraHealthScore >= 0.85
    ? "stable"
    : replayInfraHealthScore >= 0.6
      ? "watch"
      : "fragile";
  const replayNetworkSamples = Object.values(replayNetworkByDecisionId);
  const replayNetworkSampleCount = replayNetworkSamples.length;
  const replayDnsTransientRateFallback = replayNetworkSampleCount > 0
    ? replayNetworkSamples.filter((row) => String(row.failure_classification || "none").toLowerCase() === "dns_transient").length / replayNetworkSampleCount
    : 0;
  const replayTimeoutRateFallback = replayNetworkSampleCount > 0
    ? replayNetworkSamples.filter((row) => String(row.failure_classification || "none").toLowerCase() === "timeout").length / replayNetworkSampleCount
    : 0;
  const replayDegradedUsageRatioFallback = replayNetworkSampleCount > 0
    ? replayNetworkSamples.filter((row) => Boolean(row.degraded_flag)).length / replayNetworkSampleCount
    : 0;
  const replayDnsTransientRate = clamp(toNumber(replayGlobalNetworkMetrics?.dns_transient_rate, replayDnsTransientRateFallback), 0, 1);
  const replayTimeoutRate = clamp(toNumber(replayGlobalNetworkMetrics?.timeout_rate, replayTimeoutRateFallback), 0, 1);
  const replayDegradedUsageRatio = clamp(toNumber(replayGlobalNetworkMetrics?.degraded_usage_ratio, replayDegradedUsageRatioFallback), 0, 1);
  const replayNetworkGlobalSampleCount = Math.max(0, toNumber(replayGlobalNetworkMetrics?.total_requests, replayNetworkSampleCount));
  const replayFills = ((replayPayload?.fills as JsonMap[] | undefined) || []).slice(0, 60);
  const replayTimeline = replayTelemetry
    ? [
      { label: "Decision", timestamp: String(replayTelemetry.ts_decision || "") },
      { label: "Intent", timestamp: String(replayTelemetry.ts_intent || "") },
      { label: "Routing", timestamp: String(replayTelemetry.ts_routing || "") },
      { label: "Approval", timestamp: String(replayTelemetry.ts_broker_accept || "") },
      { label: "Fill partial", timestamp: String(replayTelemetry.ts_fill_partial || "") },
      { label: "Fill final", timestamp: String(replayTelemetry.ts_fill_final || "") },
    ].filter((item) => item.timestamp)
      .sort((left, right) => sortIsoAscending(left.timestamp, right.timestamp))
    : [];

  const renderableOhlcvBars = useMemo(
    () => measureTerminalCompute("renderableOhlcvBars", terminalComputePerfEnabled, () => normalizeOhlcvRows(ohlcvBars, {
      instrument: selectedChartInstrument,
      venue: selectedChartVenue,
      timeframe: chartTimeframe,
    })),
    [chartTimeframe, ohlcvBars, selectedChartInstrument, selectedChartVenue, terminalComputePerfEnabled],
  );

  // V5 trades-first: les quotes live n'altèrent plus les candles canoniques.
  // Elles servent à la microstructure / latence, tandis que les candles viennent
  // du flux trades snapshot/backfill reconstruit côté moteur.
  useEffect(() => {
    const liveQuote = quotes.find((q) => instrumentLabel(q) === selectedChartSymbol);
    const tickPrice = liveQuote
      ? toNumber(
          (liveQuote as Record<string, unknown>).last
            ?? (liveQuote as Record<string, unknown>).mid
            ?? (liveQuote as Record<string, unknown>).ask,
          0,
        )
      : 0;
    if (tickPrice > 0) {
      const updatedAt = typeof (liveQuote as Record<string, unknown>)?.updated_at === "string"
        ? Date.parse((liveQuote as Record<string, unknown>).updated_at as string)
        : undefined;
      marketDataBusRef.current?.ingestPriceTick(tickPrice, updatedAt);
    }
  }, [quotes, selectedChartSymbol]);

  const localOhlcvAnalysis = useMemo(
    () => measureTerminalCompute("localOhlcvAnalysis", terminalComputePerfEnabled, () => analyzeOhlcvRows(ohlcvBars, {
      instrument: selectedChartInstrument,
      venue: selectedChartVenue,
      timeframe: chartTimeframe,
    })),
    [chartTimeframe, ohlcvBars, selectedChartInstrument, selectedChartVenue, terminalComputePerfEnabled],
  );
  const localOhlcvFeedLabel = `${selectedChartInstrument} · ${selectedChartVenue} · ${chartTimeframe}`;
  const localOhlcvSignalTone = localOhlcvAnalysis.signal === "OHLCV_RENDERABLE"
    ? "good"
    : localOhlcvAnalysis.signal === "OHLCV_PARTIAL"
      ? "warn"
      : "bad";
  const localOhlcvAlertText = localOhlcvAnalysis.signal === "OHLCV_RENDERABLE"
    ? ""
    : localOhlcvAnalysis.signal === "OHLCV_PARTIAL"
      ? `Feed local partiel: ${localOhlcvAnalysis.renderableRows}/${localOhlcvAnalysis.fetchedRows} bougies rendables sur ${localOhlcvFeedLabel}.`
      : `Feed local inutilisable: 0/${localOhlcvAnalysis.fetchedRows} bougie rendable sur ${localOhlcvFeedLabel}.`;
  const localOhlcvReasonsLabel = localOhlcvAnalysis.reasons.length > 0
    ? localOhlcvAnalysis.reasons.join(" · ")
    : "none";
  const avgExecutionLatencyForPredictor = executionTelemetry.length > 0
    ? average(executionTelemetry.map((item) => toNumber(item.latency_e2e_ms, 0)))
    : average(filteredOutcomes.map((item) => toNumber(item.latency_ms, 0)));
  const avgExecutionSlippageForPredictor = executionTelemetry.length > 0
    ? average(executionTelemetry.map((item) => Math.abs(toNumber(item.realized_slippage_bps, 0))))
    : average(filteredOutcomes.map((item) => Math.abs(toNumber(item.slippage_real_bps ?? item.realized_slippage_bps, 0))));
  const nativeTradeVolume30s = useMemo(() => {
    return measureTerminalCompute("nativeTradeVolume30s", terminalComputePerfEnabled, () => {
      const cutoff = Date.now() - 30_000;
      return nativeTrades.reduce((sum, item) => {
        const tradedAt = typeof item.traded_at === "string" ? Date.parse(item.traded_at) : NaN;
        if (!Number.isFinite(tradedAt) || tradedAt < cutoff) {
          return sum;
        }
        return sum + toNumber(item.price, 0) * toNumber(item.size, 0);
      }, 0);
    });
  }, [nativeTrades, terminalComputePerfEnabled]);
  const microBurstTrades10ms = useMemo(() => {
    return measureTerminalCompute("microBurstTrades10ms", terminalComputePerfEnabled, () => {
      const cutoff = Date.now() - 10;
      return nativeTrades.reduce((count, item) => {
        const tradedAt = typeof item.traded_at === "string" ? Date.parse(item.traded_at) : NaN;
        return Number.isFinite(tradedAt) && tradedAt >= cutoff ? count + 1 : count;
      }, 0);
    });
  }, [nativeTrades, terminalComputePerfEnabled]);
  const dataReliabilitySnapshot = useMemo(() => {
    return measureTerminalCompute("dataReliabilitySnapshot", terminalComputePerfEnabled, () => {
      const reasons: string[] = [];
      if (!localOhlcvAnalysis.renderable || localOhlcvAnalysis.renderableRows < localOhlcvAnalysis.minimumRenderableBars) {
        reasons.push("insufficient_renderable_bars");
      }
      if (marketMicro?.depth_imbalance == null) {
        reasons.push("missing_depth_imbalance");
      }
      if (chartLoading) {
        reasons.push("chart_loading");
      }
      if (Math.max(avgExecutionLatencyForPredictor, marketBusKernelTelemetry.tickLatencyMs) >= V8_LATENCY_GUARD_MS) {
        reasons.push("latency_guard");
      }
      if (marketBusKernelTelemetry.bufferBacklog >= V8_DATA_RELIABILITY_MAX_BACKLOG) {
        reasons.push("kernel_backlog_guard");
      }
      if (nativeTradeVolume30s <= 0) {
        reasons.push("missing_volume_30s");
      }
      return {
        ready: reasons.length === 0,
        reasons,
        renderableRows: localOhlcvAnalysis.renderableRows,
        minimumRenderableBars: localOhlcvAnalysis.minimumRenderableBars,
      };
    });
  }, [avgExecutionLatencyForPredictor, chartLoading, localOhlcvAnalysis, marketBusKernelTelemetry.bufferBacklog, marketBusKernelTelemetry.tickLatencyMs, marketMicro, nativeTradeVolume30s, terminalComputePerfEnabled]);
  const predictorRenderPressure = Math.max(
    0,
    ((chartKernelPerf.frameTimeMs - 16.7) / 4.8)
      + Math.max(0, 55 - chartKernelPerf.fps) / 20
      + Math.max(0, chartKernelPerf.cpuLoad - 1),
  );
  const chartSeriesForAnchors = useMemo(
    () => measureTerminalCompute("chartSeriesForAnchors", terminalComputePerfEnabled, () => renderableOhlcvBars.map((bar) => ({ label: String(bar.t || "-"), value: toNumber(bar.c, 0) }))),
    [renderableOhlcvBars, terminalComputePerfEnabled],
  );
  const multiAnchorVwap = useMemo(() => measureTerminalCompute("multiAnchorVwap", terminalComputePerfEnabled, () => buildMultiAnchorVwap(chartSeriesForAnchors)), [chartSeriesForAnchors, terminalComputePerfEnabled]);
  const predictorMarketSession = useMemo(() => deriveMarketSessionLabel(pointTimestamp(chartSeriesForAnchors[chartSeriesForAnchors.length - 1]?.label || "")), [chartSeriesForAnchors]);
  const predictorOrderbookSignals = useMemo(() => measureTerminalCompute("predictorOrderbookSignals", terminalComputePerfEnabled, () => derivePredictorOrderbookSignals(marketDepth)), [marketDepth, terminalComputePerfEnabled]);
  const predictorOrderflowSnapshot = useMemo(() => {
    return measureTerminalCompute("predictorOrderflowSnapshot", terminalComputePerfEnabled, () => {
      const bidVolume = Math.max(0, toNumber(marketMicro?.buy_volume, 0));
      const askVolume = Math.max(0, toNumber(marketMicro?.sell_volume, 0));
      const totalVolume = bidVolume + askVolume;
      const delta = bidVolume - askVolume;
      const fallbackImbalance = totalVolume > 0 ? delta / totalVolume : 0;
      const imbalance = clamp(toNumber(marketMicro?.flow_imbalance, fallbackImbalance), -1, 1);
      const cumulativeDelta = toNumber(marketMicro?.cvd, 0);
      const recentSeries = chartSeriesForAnchors.slice(-12);
      const currentPrice = recentSeries[recentSeries.length - 1]?.value || toNumber(marketMicro?.mid_price, 0);
      const firstPrice = recentSeries[0]?.value || currentPrice;
      const recentMovePct = firstPrice > 0 ? (currentPrice - firstPrice) / firstPrice : 0;
      const anchoredVwap = multiAnchorVwap.impulse || multiAnchorVwap.session || multiAnchorVwap.day;
      const distanceToVwapBps = multiAnchorVwap.primaryDistanceBps;
      const vwapSlopeBps = multiAnchorVwap.impulse > 0 && multiAnchorVwap.session > 0
        ? ((multiAnchorVwap.impulse - multiAnchorVwap.session) / multiAnchorVwap.session) * 10000
        : 0;
      const absorptionSignal = Math.abs(imbalance) >= 0.16 && Math.abs(recentMovePct) <= 0.0025 && Math.sign(delta) !== 0 && Math.sign(delta) !== Math.sign(recentMovePct)
        ? (delta >= 0 ? -1 : 1)
        : 0;
      const spoofingScore = clamp(Math.abs(predictorOrderbookSignals.bookFlipSignal) * clamp(predictorOrderbookSignals.quoteFadeRate / 3, 0, 1), 0, 1)
        * (predictorOrderbookSignals.bookFlipSignal >= 0 ? 1 : -1);
      const liquidityTrapSignal = Math.abs(absorptionSignal) > 0 && Math.abs(spoofingScore) >= 0.28
        ? absorptionSignal
        : 0;
      const liquidityEngine = buildLiquidityEngineSnapshot(
        predictorOrderbookSignals.orderbookBids,
        predictorOrderbookSignals.orderbookAsks,
        toNumber(marketMicro?.spread_bps, 0),
        predictorOrderbookSignals.quoteFadeRate,
        predictorOrderbookSignals.bookFlipSignal,
        imbalance,
        multiAnchorVwap,
      );
      const orderflowQuality = clamp(
        Math.abs(imbalance) * 0.34
          + Math.min(1, Math.abs(delta) / Math.max(totalVolume, 1)) * 0.2
          + Math.abs(absorptionSignal) * 0.22
          + Math.abs(liquidityTrapSignal) * 0.16
          + Math.min(1, Math.abs(spoofingScore)) * 0.08,
        0,
        1,
      );
      return {
        bidVolume,
        askVolume,
        delta,
        cumulativeDelta,
        imbalance,
        absorptionSignal,
        liquidityTrapSignal,
        spoofingScore,
        anchoredVwap,
        distanceToVwapBps,
        vwapSlopeBps,
        orderflowQuality: clamp(orderflowQuality * 0.78 + liquidityEngine.liquidityEngineScore * 0.22, 0, 1),
        multiAnchorVwap,
        liquidityEngine,
      };
    });
  }, [chartSeriesForAnchors, marketMicro, multiAnchorVwap, predictorOrderbookSignals, terminalComputePerfEnabled]);
  const predictorRequestPayload = useMemo(() => {
    const bestRouteCandidate = (routingScore?.best as JsonMap | undefined) || {};
    const arbitrage = (routingScore?.arbitrage as JsonMap | undefined) || {};
    const networkMetrics = routingScore?.network_metrics && typeof routingScore.network_metrics === "object"
      ? routingScore.network_metrics as JsonMap
      : null;
    const infraHealth = clamp(toNumber(routingScore?.infra_health, 1), 0.05, 1);
    const networkRegime = String(routingScore?.network_regime || "stable");
    const v7GateDecision = buildV7LocalGateDecision(notional);
    return {
      spread_bps: toNumber(bestRouteCandidate.spread_bps ?? bestRouteCandidate.spread, toNumber(marketMicro?.spread_bps, 0)),
      depth_imbalance: marketMicro?.depth_imbalance ?? null,
      latency_ms: Math.max(avgExecutionLatencyForPredictor, marketBusKernelTelemetry.tickLatencyMs),
      slippage_bps: avgExecutionSlippageForPredictor,
      latency_cost_bps: v7GateDecision.latencyCostBps,
      available_depth_usd: toNumber(bestRouteCandidate.available_depth_usd, 0),
      volume_30s: nativeTradeVolume30s,
      volatility_bps: Math.abs(toNumber(marketMicro?.fusion_deviation_bps, 0)),
      arb_edge_bps: toNumber(arbitrage.net_spread ?? marketMicro?.arbitrage_net_spread, 0),
      fill_probability: toNumber(bestRouteCandidate.fill_probability, 0),
      cvd_delta: toNumber(marketMicro?.cvd_delta, 0),
      bid_volume: predictorOrderflowSnapshot.bidVolume,
      ask_volume: predictorOrderflowSnapshot.askVolume,
      orderflow_delta: predictorOrderflowSnapshot.delta,
      cumulative_delta: predictorOrderflowSnapshot.cumulativeDelta,
      orderflow_imbalance: predictorOrderflowSnapshot.imbalance,
      absorption_signal: predictorOrderflowSnapshot.absorptionSignal,
      liquidity_trap_signal: predictorOrderflowSnapshot.liquidityTrapSignal,
      spoofing_score: predictorOrderflowSnapshot.spoofingScore,
      anchored_vwap: predictorOrderflowSnapshot.anchoredVwap,
      distance_to_vwap_bps: predictorOrderflowSnapshot.distanceToVwapBps,
      vwap_slope_bps: predictorOrderflowSnapshot.vwapSlopeBps,
      session_vwap: predictorOrderflowSnapshot.multiAnchorVwap.session,
      day_vwap: predictorOrderflowSnapshot.multiAnchorVwap.day,
      week_vwap: predictorOrderflowSnapshot.multiAnchorVwap.week,
      month_vwap: predictorOrderflowSnapshot.multiAnchorVwap.month,
      swing_vwap: predictorOrderflowSnapshot.multiAnchorVwap.swing,
      impulse_vwap: predictorOrderflowSnapshot.multiAnchorVwap.impulse,
      session_vwap_distance_bps: predictorOrderflowSnapshot.multiAnchorVwap.sessionDistanceBps,
      day_vwap_distance_bps: predictorOrderflowSnapshot.multiAnchorVwap.dayDistanceBps,
      week_vwap_distance_bps: predictorOrderflowSnapshot.multiAnchorVwap.weekDistanceBps,
      month_vwap_distance_bps: predictorOrderflowSnapshot.multiAnchorVwap.monthDistanceBps,
      swing_vwap_distance_bps: predictorOrderflowSnapshot.multiAnchorVwap.swingDistanceBps,
      impulse_vwap_distance_bps: predictorOrderflowSnapshot.multiAnchorVwap.impulseDistanceBps,
      vwap_anchor_primary: predictorOrderflowSnapshot.multiAnchorVwap.primaryLabel,
      anchor_compression_bps: predictorOrderflowSnapshot.multiAnchorVwap.anchorCompressionBps,
      anchor_confluence: predictorOrderflowSnapshot.multiAnchorVwap.confluenceScore,
      resting_bid_usd: predictorOrderflowSnapshot.liquidityEngine.restingBidUsd,
      resting_ask_usd: predictorOrderflowSnapshot.liquidityEngine.restingAskUsd,
      resting_imbalance: predictorOrderflowSnapshot.liquidityEngine.restingImbalance,
      touch_density: predictorOrderflowSnapshot.liquidityEngine.touchDensity,
      sweep_risk: predictorOrderflowSnapshot.liquidityEngine.sweepRisk,
      liquidity_vacuum: predictorOrderflowSnapshot.liquidityEngine.liquidityVacuum,
      support_score: predictorOrderflowSnapshot.liquidityEngine.supportScore,
      resistance_score: predictorOrderflowSnapshot.liquidityEngine.resistanceScore,
      liquidity_pressure: predictorOrderflowSnapshot.liquidityEngine.liquidityPressure,
      liquidity_engine_score: predictorOrderflowSnapshot.liquidityEngine.liquidityEngineScore,
      liquidity_engine_state: predictorOrderflowSnapshot.liquidityEngine.stateLabel,
      orderflow_quality: predictorOrderflowSnapshot.orderflowQuality,
      market_session: predictorMarketSession,
      micro_burst_10ms: microBurstTrades10ms,
      quote_fade_rate: predictorOrderbookSignals.quoteFadeRate,
      book_flip_signal: predictorOrderbookSignals.bookFlipSignal,
      orderbook_bids: predictorOrderbookSignals.orderbookBids,
      orderbook_asks: predictorOrderbookSignals.orderbookAsks,
      route_mode: v7GateDecision.routeMode,
      v7_should_execute: v7GateDecision.shouldExecute,
      v7_reasons: v7GateDecision.reasons,
      infra_health: infraHealth,
      network_regime: networkRegime,
      dns_transient_rate: toNumber(networkMetrics?.dns_transient_rate, 0),
      timeout_rate: toNumber(networkMetrics?.timeout_rate, 0),
      degraded_usage_ratio: toNumber(networkMetrics?.degraded_usage_ratio, 0),
      retry_recovered_ratio: toNumber(networkMetrics?.retry_recovered_ratio, 0),
      backlog_pressure: marketBusKernelTelemetry.backlogPressure,
      render_pressure: predictorRenderPressure,
      renderable_rows: localOhlcvAnalysis.renderableRows,
      backlog: marketBusKernelTelemetry.bufferBacklog,
    };
  }, [avgExecutionLatencyForPredictor, avgExecutionSlippageForPredictor, localOhlcvAnalysis.renderableRows, marketBusKernelTelemetry.backlogPressure, marketBusKernelTelemetry.bufferBacklog, marketBusKernelTelemetry.tickLatencyMs, marketMicro, microBurstTrades10ms, nativeTradeVolume30s, notional, predictorMarketSession, predictorOrderbookSignals, predictorOrderflowSnapshot, predictorRenderPressure, routingScore]);
  const hasRenderableCandles = localOhlcvAnalysis.renderable && renderableOhlcvBars.length >= localOhlcvAnalysis.minimumRenderableBars;
  const chartAuthBlocked = authSessionRequired || authStatus !== "authenticated";
  const chartRenderBlocked = !chartAuthBlocked && localOhlcvAnalysis.signal === "OHLCV_UNUSABLE" && !hasRenderableCandles;
  const localFeedSidecarMessage = localOhlcvAnalysis.signal === "OHLCV_RENDERABLE"
    ? "Ce chart et son feed local sont rendables."
    : localOhlcvAnalysis.signal === "OHLCV_PARTIAL"
      ? "Le feed local reste partiel sur cet instrument; le chart bascule en mode preview tant que le seuil canonique n'est pas atteint."
      : "Ce chart est sain, mais ce feed local n’est pas rendable.";

  const ohlcvCandles = useMemo(() => {
    // Virtual window : on transmet toujours la série complète (max 500 bars) au chart.
    // LightweightCharts gère son propre viewport → zéro re-render superflu sur pan/zoom.
    // chartWindow reste utilisé comme hint pour la fenêtre initiale visible.
    const windowSize = Math.max(20, Math.min(chartWindow, 500));
    chartViewportRef.current.window = windowSize;
    return renderableOhlcvBars.slice(-windowSize).map((bar) => ({
      label: String(bar.t || "-"),
      open: toNumber(bar.o, 0),
      high: toNumber(bar.h, 0),
      low: toNumber(bar.l, 0),
      close: toNumber(bar.c, 0),
      volume: toNumber(bar.v, 0),
    }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderableOhlcvBars, chartTimeframe]);
  const latestQuote = filteredQuotes.find((quote) => instrumentLabel(quote) === selectedChartSymbol) || quotes.find((quote) => instrumentLabel(quote) === selectedChartSymbol) || null;
  const previewAnchorPrice = resolveRawChartAnchorPrice(
    marketMicro,
    marketDepth,
    latestQuote,
    toNumber(renderableOhlcvBars[renderableOhlcvBars.length - 1]?.c, 100),
  );
  const fallbackChartCandles = !hasRenderableCandles
    ? (() => {
      // Generate 80 plausible 1-minute preview bars so the chart looks sensible
      // while market data is loading / offline. Uses a seeded pseudo-random walk
      // so the shape is stable across renders rather than jumping on every tick.
      const BARS = 80;
      const INTERVAL_MS = 60_000;
      const base = previewAnchorPrice > 0 ? previewAnchorPrice : 100;
      const now = Math.floor(Date.now() / INTERVAL_MS) * INTERVAL_MS;
      const bars: Array<{ label: string; open: number; high: number; low: number; close: number; volume: number }> = [];
      let price = base;
      // Deterministic LCG seeded on the day so shape is stable for a session
      let seed = Math.floor(now / 86_400_000) % 65536;
      const rand = () => {
        seed = (seed * 1664525 + 1013904223) & 0xffffffff;
        return (seed >>> 0) / 0xffffffff;
      };
      for (let i = BARS - 1; i >= 0; i--) {
        const t = now - i * INTERVAL_MS;
        const drift = (rand() - 0.5) * 0.003;
        const open = price;
        const close = open * (1 + drift);
        const wickPad = Math.max(open * 0.00018, Math.abs(close - open) * 0.25 + open * 0.00004);
        const high = Math.max(open, close) + wickPad;
        const low = Math.min(open, close) - wickPad;
        price = close;
        bars.push({
          label: new Date(t).toISOString(),
          open: +open.toFixed(5),
          high: +high.toFixed(5),
          low: +low.toFixed(5),
          close: +close.toFixed(5),
          volume: Math.round(50 + rand() * 200),
        });
      }
      return bars;
    })()
    : [];
  const chartCandles = ohlcvCandles;
  const chartDisplayCandles = hasRenderableCandles ? chartCandles : fallbackChartCandles;
  const chartPreviewModeActive = !hasRenderableCandles && chartDisplayCandles.length > 0;
  const chartMaskActive = (chartRenderBlocked || (chartAuthBlocked && !hasRenderableCandles)) && !chartPreviewModeActive;
  const chartSeries = chartCandles.map((candle) => ({ label: candle.label, value: candle.close }));

  // ── Memoized indicator computation (PERF) ──────────────────────────────────
  // Hash-based memoization: only recompute if bars or active indicators actually change
  const barHash = useMemo(() => barArrayHash(chartCandles.map((c) => ({
    time: Math.floor(new Date(c.label).getTime() / 1000),
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  }))), [chartCandles]);

  const barsForIndicators = useMemo(() => chartCandles.map((c) => ({
    time: Math.floor(new Date(c.label).getTime() / 1000),
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  })), [chartCandles]);
  const activeIndicatorKey = useMemo(() => activeIndicators.map((a) => `${a.id}:${JSON.stringify(a.params || {})}`).join("|"), [activeIndicators]);

  useEffect(() => {
    const seq = indicatorComputeSeqRef.current + 1;
    indicatorComputeSeqRef.current = seq;

    if (barsForIndicators.length === 0 || activeIndicators.length === 0) {
      setIndicatorSeriesForChart([]);
      return;
    }

    let cancelled = false;
    indicatorWorkerAdapter.compute(barsForIndicators as Bar[], activeIndicators)
      .then((result) => {
        if (cancelled || indicatorComputeSeqRef.current !== seq) {
          return;
        }
        setIndicatorSeriesForChart(result);
      })
      .catch(() => {
        if (!cancelled && indicatorComputeSeqRef.current === seq) {
          setIndicatorSeriesForChart([]);
        }
      });

    return () => {
      cancelled = true;
    };
    }, [barHash, activeIndicatorKey, activeIndicators]);
  const selectedQuoteRows = quotes.filter((quote) => instrumentLabel(quote) === selectedChartSymbol);
  const chartValues = chartMode === "candles"
    ? chartCandles.flatMap((candle) => [candle.low, candle.high]).filter((value) => Number.isFinite(value) && value > 0)
    : chartSeries.map((point) => point.value);
  const chartFirstValue = chartMode === "candles"
    ? (chartCandles[0]?.close ?? 0)
    : (chartSeries[0]?.value ?? 0);
  const chartLastValue = chartMode === "candles"
    ? (chartCandles[chartCandles.length - 1]?.close ?? chartFirstValue)
    : (chartSeries[chartSeries.length - 1]?.value ?? chartFirstValue);
  const chartMin = chartValues.length > 0 ? Math.min(...chartValues) : 0;
  const chartMax = chartValues.length > 0 ? Math.max(...chartValues) : 0;
  const chartChange = chartLastValue - chartFirstValue;
  const chartChangePct = chartFirstValue !== 0 ? (chartChange / chartFirstValue) * 100 : 0;
  const chartSeriesAnchorPrice = chartLastValue || chartFirstValue || 0;
  const chartLiveAnchorPrice = resolveRawChartAnchorPrice(marketMicro, marketDepth, latestQuote, chartSeriesAnchorPrice);
  const chartBarsHardFail = (() => {
    const health = (marketBusMeta?.health as JsonMap | undefined) || null;
    const components = (health?.components as JsonMap | undefined) || null;
    const ohlcvHealth = (components?.ohlcv as JsonMap | undefined) || null;
    const freshnessMs = Number(ohlcvHealth?.freshness_ms);
    return !Number.isFinite(freshnessMs) || freshnessMs < 0 || freshnessMs > 180_000;
  })();
  const chartAnchorOutOfRange = (() => {
    if (!(chartLiveAnchorPrice > 0) || !(chartMax > chartMin)) {
      return false;
    }
    const chartSpan = Math.max(chartMax - chartMin, chartSeriesAnchorPrice * 0.0012);
    return chartLiveAnchorPrice < chartMin - chartSpan * 0.35 || chartLiveAnchorPrice > chartMax + chartSpan * 0.35;
  })();
  const chartShouldLockAnchorToSeries = chartMode === "candles"
    && hasRenderableCandles
    && (chartBarsHardFail || chartAnchorOutOfRange);
  const chartAnchorPrice = chartShouldLockAnchorToSeries
    ? (chartSeriesAnchorPrice > 0 ? chartSeriesAnchorPrice : chartLiveAnchorPrice)
    : chartLiveAnchorPrice;
  const chartRangePad = chartMax > chartMin ? (chartMax - chartMin) * 0.08 : Math.max(1, chartAnchorPrice * 0.015);
  const chartPriceRangeMin = Math.max(0.0000001, (chartMin || chartAnchorPrice || 1) - chartRangePad);
  const chartPriceRangeMax = (chartMax || chartAnchorPrice || 1) + chartRangePad;
  const chartOrderQty = chartOrderTicket.entry > 0 ? Math.max(0, notional / chartOrderTicket.entry) : 0;
  const chartRiskPerUnit = chartOrderTicket.side === "buy"
    ? Math.max(0, chartOrderTicket.entry - chartOrderTicket.sl)
    : Math.max(0, chartOrderTicket.sl - chartOrderTicket.entry);
  const chartRewardPerUnit = chartOrderTicket.side === "buy"
    ? Math.max(0, chartOrderTicket.tp - chartOrderTicket.entry)
    : Math.max(0, chartOrderTicket.entry - chartOrderTicket.tp);
  const chartRiskUsd = chartRiskPerUnit * chartOrderQty;
  const chartRewardUsd = chartRewardPerUnit * chartOrderQty;
  const chartRiskReward = chartRiskUsd > 0 ? chartRewardUsd / chartRiskUsd : 0;
  const chartRiskTargetRr = chartMaxLossUsd > 0 ? chartTargetGainUsd / chartMaxLossUsd : 0;
  const chartRiskLossExceeded = chartRiskGuardEnabled && chartMaxLossUsd > 0 && chartRiskUsd > chartMaxLossUsd;
  const chartRiskTargetMiss = chartRiskGuardEnabled && chartTargetGainUsd > 0 && chartRewardUsd < chartTargetGainUsd;
  const chartEffectiveSendMode: ChartReleaseSendMode = chartRiskTargetMiss ? "confirm-required" : chartReleaseSendMode;
  const accountFreeUsd = (() => {
    const freeCandidates = [
      toNumber(balance?.free_usd, NaN),
      toNumber(balance?.equity_usd, NaN),
      toNumber(balance?.balance_usd, NaN),
    ];
    const usdBalance = ((balance?.balances as JsonMap[] | undefined) || []).find((item) => String(item.currency || "").toUpperCase() === "USD");
    if (usdBalance) {
      freeCandidates.push(toNumber(usdBalance.free, NaN));
      freeCandidates.push(toNumber(usdBalance.balance, NaN));
    }
    for (const value of freeCandidates) {
      if (Number.isFinite(value) && value > 0) {
        return value;
      }
    }
    return Math.max(1, notional * 10);
  })();
  const openTradesCount = positions.filter((position) => Math.abs(toNumber(position.net_notional_usd, 0)) > 1).length;
  const grossExposureUsd = positions.reduce((sum, position) => sum + Math.abs(toNumber(position.net_notional_usd, 0)), 0);
  const exposureRatio = grossExposureUsd / Math.max(1, accountFreeUsd);
  const dailyPnLUsd = (() => {
    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;
    return outcomes.reduce((sum, item) => {
      const ts = Date.parse(String(item.closed_at || item.timestamp || item.ts || ""));
      if (Number.isFinite(ts) && now - ts <= oneDayMs) {
        return sum + toNumber(item.pnl_usd, toNumber(item.net_result_usd, 0));
      }
      return sum;
    }, 0);
  })();
  const dailyDrawdownPct = accountFreeUsd > 0 ? Math.max(0, (-dailyPnLUsd / accountFreeUsd) * 100) : 0;
  const dayVwap = multiAnchorVwap.day;
  const weekVwap = multiAnchorVwap.week;
  const monthVwap = multiAnchorVwap.month;
  const overlayZones = buildOverlayZones(chartSeries);
  const liquidityZones = buildLiquidityZones(chartSeries);
  const chartPriceStep = inferChartPriceStep(selectedChartSymbol, chartAnchorPrice > 0 ? chartAnchorPrice : chartLastValue || chartFirstValue || 1);
  const chartPriceDigits = getPriceStepDecimals(chartPriceStep);
  const chartRoundMagnetStep = computeChartRoundMagnetStep(chartPriceStep);
  const chartSnapThreshold = computeChartSnapThreshold(chartPriceStep, chartPriceRangeMin, chartPriceRangeMax);
  const chartAtrLocalPct = useMemo(() => {
    if (chartCandles.length < 3) {
      return 0;
    }
    const sample = chartCandles.slice(-14);
    let totalTr = 0;
    for (let index = 0; index < sample.length; index += 1) {
      const current = sample[index];
      const prevClose = index > 0 ? sample[index - 1].close : current.close;
      const tr = Math.max(
        current.high - current.low,
        Math.abs(current.high - prevClose),
        Math.abs(current.low - prevClose),
      );
      totalTr += Math.max(0, tr);
    }
    const atr = totalTr / Math.max(1, sample.length);
    const reference = Math.max(0.0000001, chartLastValue || sample[sample.length - 1].close || 1);
    return atr / reference;
  }, [chartCandles, chartLastValue]);
  const modeUxProfile = autoExecutionMode === "assisted"
    ? {
        label: "Human",
        shortLabel: "MODE HUMAN",
        summary: "chart classique · full indicators · full overlays",
      }
    : autoExecutionMode === "semi-auto"
      ? {
          label: "Hybrid",
          shortLabel: "MODE HYBRID",
          summary: "mix intelligent · overlays visibles mais attenues",
        }
      : {
          label: "AI",
          shortLabel: "MODE AI",
          summary: "perception layer dominant · bruit supprime · decision visible en 0.2s",
        };
  const microOrderById = orderMap(layoutMicroOrder);
  const lowerOrderById = orderMap(layoutLowerOrder);
  const monitoringOrderById = orderMap(layoutMonitoringOrder);

  const applyChartOrderPreset = (preset: ChartOrderPreset, nextSide?: "buy" | "sell") => {
    const config = preset === "custom" ? null : CHART_ORDER_PRESETS[preset];
    const sideValue = nextSide || chartOrderTicket.side;
    const entry = chartAnchorPrice > 0 ? chartAnchorPrice : chartLastValue;
    const slPct = config?.slPct ?? (chartOrderTicket.side === "buy" ? Math.max(0.001, (chartOrderTicket.entry - chartOrderTicket.sl) / Math.max(0.0000001, chartOrderTicket.entry)) : Math.max(0.001, (chartOrderTicket.sl - chartOrderTicket.entry) / Math.max(0.0000001, chartOrderTicket.entry)));
    const tpPct = config?.tpPct ?? (chartOrderTicket.side === "buy" ? Math.max(0.001, (chartOrderTicket.tp - chartOrderTicket.entry) / Math.max(0.0000001, chartOrderTicket.entry)) : Math.max(0.001, (chartOrderTicket.entry - chartOrderTicket.tp) / Math.max(0.0000001, chartOrderTicket.entry)));
    const sl = sideValue === "buy" ? entry * (1 - slPct) : entry * (1 + slPct);
    const tp = sideValue === "buy" ? entry * (1 + tpPct) : entry * (1 - tpPct);
    setChartOrderTicket((current) => ({
      ...current,
      side: sideValue,
      preset,
      entry,
      sl,
      tp,
      active: true,
    }));
    setSymbol(selectedChartSymbol);
    setSide(sideValue);
    if (config) {
      setNotional(config.notional);
      setMaxSpread(config.maxSpread);
    }
  };

  const applyExecutionAdaptationPlan = (plan: MarketDecisionSnapshot["executionPlan"]) => {
    if (chartSnapPriority !== plan.snapPriority) {
      setChartSnapPriority(plan.snapPriority);
    }
    if (chartRiskGuardEnabled !== plan.guardEnabled) {
      setChartRiskGuardEnabled(plan.guardEnabled);
    }
    if (chartOrderTicket.preset !== "custom" && chartOrderTicket.preset !== plan.preset) {
      applyChartOrderPreset(plan.preset);
    }
  };

  const applySuggestedScenarioBracket = (bracket: MarketSuggestedBracket | null) => {
    if (!bracket) {
      return;
    }
    setChartOrderTicket((current) => ({
      ...current,
      side: bracket.side,
      preset: "custom",
      entry: bracket.entry,
      sl: bracket.sl,
      tp: bracket.tp,
      active: true,
    }));
    setSymbol(selectedChartSymbol);
    setSide(bracket.side);
  };

  const pushChartSendHistory = (outcome: ChartSendHistoryEntry["outcome"]) => {
    const entry: ChartSendHistoryEntry = {
      atIso: new Date().toISOString(),
      symbol: selectedChartSymbol,
      side: chartOrderTicket.side,
      rr: chartRiskReward,
      riskUsd: chartRiskUsd,
      rewardUsd: chartRewardUsd,
      maxLossUsd: chartMaxLossUsd,
      targetGainUsd: chartTargetGainUsd,
      compliant: !chartRiskLossExceeded && !chartRiskTargetMiss,
      outcome,
      source: "local",
    };
    setChartSendHistory((current) => [entry, ...current].slice(0, 5));
  };

  const approveAllAndSend = async (): Promise<void> => {
    if (!marketDecisionV1.suggestedBracket) {
      return;
    }
    setShowDecisionSecondary(false);
    applySuggestedScenarioBracket(marketDecisionV1.suggestedBracket);
    applyExecutionAdaptationPlan(marketDecisionV1.executionPlan);
    setPendingExecutionAdaptation(null);
    if (chartEffectiveSendMode === "confirm-required" && !chartHudConfirmArmed) {
      setChartHudConfirmArmed(true);
      pushChartSendHistory("confirmation-required");
      setError("Risk target not met: confirm-required armed. Press Approve All + Send again to confirm.");
      return;
    }
    const ack = chartEffectiveSendMode !== "confirm-required" || chartHudConfirmArmed;
    setChartHudConfirmArmed(false);
    const v7Decision = getV7ExecutionDecision();
    if (v7Decision.routeMode === "dualVenueExecution" && v7Decision.shouldExecute) {
      await executeV7ArbOpportunity(v7Decision, ack);
      return;
    }
    await submitChartOrder(ack);
  };

  useEffect(() => {
    let closed = false;
    let inFlight = false;
    const mapAuditEntry = (item: JsonMap): ChartSendHistoryEntry | null => {
      const category = String(item.category || "");
      const payload = (item.payload && typeof item.payload === "object") ? (item.payload as JsonMap) : {};
      const riskContext = (payload.risk_context && typeof payload.risk_context === "object") ? (payload.risk_context as JsonMap) : {};
      const timestamp = String(item.timestamp || "").trim();
      if (!timestamp) {
        return null;
      }

      if (category === "mt5_order_accepted") {
        return {
          atIso: timestamp,
          symbol: String(payload.symbol || selectedChartSymbol || "BTCUSD"),
          side: String(payload.side || "buy") === "sell" ? "sell" : "buy",
          rr: toNumber(riskContext.target_rr, 0),
          riskUsd: toNumber(riskContext.risk_usd, 0),
          rewardUsd: toNumber(riskContext.reward_usd, 0),
          maxLossUsd: toNumber(riskContext.max_loss_usd, 0),
          targetGainUsd: toNumber(riskContext.target_gain_usd, 0),
          compliant: Boolean(riskContext.compliant),
          outcome: "submitted",
          source: "backend",
        };
      }

      if (category === "mt5_order_blocked_risk_max_loss") {
        return {
          atIso: timestamp,
          symbol: String(payload.symbol || selectedChartSymbol || "BTCUSD"),
          side: String(payload.side || "buy") === "sell" ? "sell" : "buy",
          rr: 0,
          riskUsd: toNumber(payload.risk_usd, 0),
          rewardUsd: 0,
          maxLossUsd: toNumber(payload.max_loss_usd, 0),
          targetGainUsd: 0,
          compliant: false,
          outcome: "blocked-loss",
          source: "backend",
        };
      }

      if (category === "mt5_order_requires_confirm_target_gain") {
        return {
          atIso: timestamp,
          symbol: String(payload.symbol || selectedChartSymbol || "BTCUSD"),
          side: String(payload.side || "buy") === "sell" ? "sell" : "buy",
          rr: 0,
          riskUsd: 0,
          rewardUsd: toNumber(payload.reward_usd, 0),
          maxLossUsd: 0,
          targetGainUsd: toNumber(payload.target_gain_usd, 0),
          compliant: false,
          outcome: "confirmation-required",
          source: "backend",
        };
      }

      return null;
    };

    const loadAuditHistory = async () => {
      if (closed || inFlight) {
        return;
      }
      if (authSessionRequired || Date.now() < authBackoffUntilRef.current) {
        return;
      }
      if (shouldPauseNonEssentialRefresh()) {
        return;
      }
      inFlight = true;
      const controller = new AbortController();
      const timeout = window.setTimeout(() => {
        controller.abort();
      }, 12000);
      try {
        const startedAt = Date.now();
        const params = new URLSearchParams();
        params.set("limit", "120");
        params.set("symbol", selectedChartSymbol);
        params.set("account_id", accountId);
        if (riskTimelineFrom.trim()) {
          params.set("from", new Date(riskTimelineFrom).toISOString());
        }
        if (riskTimelineTo.trim()) {
          params.set("to", new Date(riskTimelineTo).toISOString());
        }
        const response = await fetch(`/api/mt5/orders/risk-history?${params.toString()}`, {
          cache: "no-store",
          signal: controller.signal,
          headers: buildRoutingRequestHeaders("ui", selectedChartSymbol),
        });
        if (response.status === 401) {
          markUnauthorizedBackoff();
          return;
        }
        if (!response.ok) {
          return;
        }
        const payload = await response.json();
        if (closed || !Array.isArray(payload)) {
          return;
        }
        const mapped = payload
          .map((item) => mapAuditEntry((item && typeof item === "object") ? (item as JsonMap) : {}))
          .filter((item): item is ChartSendHistoryEntry => Boolean(item))
          .sort((a, b) => new Date(b.atIso).getTime() - new Date(a.atIso).getTime())
          .slice(0, 5);
        setChartSendHistoryBackend(mapped);
        setRiskPollingStatus({
          lastRefreshIso: new Date().toISOString(),
          latencyMs: Date.now() - startedAt,
          source: "history",
        });
      } catch {
        // noop
      } finally {
        window.clearTimeout(timeout);
        inFlight = false;
      }
    };

    void loadAuditHistory();
    const timer = window.setInterval(() => {
      void loadAuditHistory();
    }, riskTimelineRefreshSec * 1000);
    return () => {
      closed = true;
      window.clearInterval(timer);
    };
  }, [accountId, authSessionRequired, riskTimelineFrom, riskTimelineRefreshSec, riskTimelineTo, selectedChartSymbol]);

  useEffect(() => {
    let closed = false;
    let inFlight = false;

    const loadRiskSummary = async () => {
      if (closed || inFlight) {
        return;
      }
      if (authSessionRequired || Date.now() < authBackoffUntilRef.current) {
        return;
      }
      if (shouldPauseNonEssentialRefresh()) {
        return;
      }
      inFlight = true;
      const controller = new AbortController();
      const timeout = window.setTimeout(() => {
        controller.abort();
      }, 12000);
      try {
        const startedAt = Date.now();
        const params = new URLSearchParams();
        params.set("window", String(Math.max(3, Math.min(100, riskAlertWindow))));
        params.set("miss_threshold", String(Math.max(1, Math.min(Math.max(3, Math.min(100, riskAlertWindow)), riskAlertMissThreshold))));
        params.set("symbol", selectedChartSymbol);
        params.set("account_id", accountId);
        if (riskTimelineFrom.trim()) {
          params.set("from", new Date(riskTimelineFrom).toISOString());
        }
        if (riskTimelineTo.trim()) {
          params.set("to", new Date(riskTimelineTo).toISOString());
        }
        const response = await fetch(`/api/mt5/orders/risk-history/summary?${params.toString()}`, {
          cache: "no-store",
          signal: controller.signal,
          headers: buildRoutingRequestHeaders("ui", selectedChartSymbol),
        });
        if (response.status === 401) {
          markUnauthorizedBackoff();
          return;
        }
        if (!response.ok) {
          setRiskPollingFailures((current) => current + 1);
          return;
        }
        const payload = await response.json();
        if (closed || !payload || typeof payload !== "object") {
          setRiskPollingFailures((current) => current + 1);
          return;
        }
        setRiskSummary(payload as RiskHistorySummary);
        setRiskPollingFailures(0);
        setRiskPollingStatus({
          lastRefreshIso: new Date().toISOString(),
          latencyMs: Date.now() - startedAt,
          source: "summary",
        });
      } catch {
        setRiskPollingFailures((current) => current + 1);
      } finally {
        window.clearTimeout(timeout);
        inFlight = false;
      }
    };

    void loadRiskSummary();
    const timer = window.setInterval(() => {
      void loadRiskSummary();
    }, riskTimelineRefreshSec * 1000);

    return () => {
      closed = true;
      window.clearInterval(timer);
    };
  }, [accountId, authSessionRequired, riskAlertMissThreshold, riskAlertWindow, riskTimelineFrom, riskTimelineRefreshSec, riskTimelineTo, selectedChartSymbol]);

  useEffect(() => {
    if (!riskPollingStatus.lastRefreshIso) {
      setRiskPollAgeSec(0);
      return;
    }
    const updateAge = () => {
      const refreshedAt = new Date(riskPollingStatus.lastRefreshIso || "").getTime();
      if (!Number.isFinite(refreshedAt)) {
        setRiskPollAgeSec(0);
        return;
      }
      const elapsedMs = Date.now() - refreshedAt;
      setRiskPollAgeSec(Math.max(0, Math.floor(elapsedMs / 1000)));
    };
    updateAge();
    const timer = window.setInterval(updateAge, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [riskPollingStatus.lastRefreshIso]);

  const buildRiskExportParams = (format: "json" | "csv"): URLSearchParams => {
    const params = new URLSearchParams();
    params.set("format", format);
    params.set("limit", "1000");
    params.set("symbol", selectedChartSymbol);
    params.set("account_id", accountId);
    if (riskTimelineFrom.trim()) {
      params.set("from", new Date(riskTimelineFrom).toISOString());
    }
    if (riskTimelineTo.trim()) {
      params.set("to", new Date(riskTimelineTo).toISOString());
    }
    return params;
  };

  const fetchRiskExport = async (format: "json" | "csv"): Promise<unknown | string | null> => {
    const response = await fetch(`/api/mt5/orders/risk-history/export?${buildRiskExportParams(format).toString()}`, { cache: "no-store" });
    if (!response.ok) {
      return null;
    }
    if (format === "json") {
      return response.json();
    }
    return response.text();
  };

  const exportRiskHistory = async (format: "json" | "csv") => {
    try {
      const payload = await fetchRiskExport(format);
      if (payload === null) {
        return;
      }
      if (format === "json") {
        downloadJsonFile(`risk-history-${selectedChartSymbol}-${accountId}.json`, payload);
        return;
      }
      if (typeof payload !== "string") {
        return;
      }
      const blob = new Blob([payload], { type: "text/csv;charset=utf-8" });
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = `risk-history-${selectedChartSymbol}-${accountId}.csv`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(href);
    } catch {
      // noop
    }
  };

  const exportComplianceZip = async () => {
    try {
      const [jsonPayload, csvPayload] = await Promise.all([
        fetchRiskExport("json"),
        fetchRiskExport("csv"),
      ]);
      const settingsPayload = {
        exportedAt: new Date().toISOString(),
        accountId,
        symbol: selectedChartSymbol,
        from: riskTimelineFrom || null,
        to: riskTimelineTo || null,
        window: riskAlertWindow,
        missThreshold: riskAlertMissThreshold,
        refreshSec: riskTimelineRefreshSec,
        hardAlertEnabled: riskHardAlertEnabled,
        hardAlertThresholdPct: riskHardAlertThresholdPct,
        layoutPreset,
        summary: riskSummary,
      };

      const zip = new JSZip();
      if (jsonPayload !== null) {
        zip.file("risk-history.json", JSON.stringify(jsonPayload, null, 2));
      }
      if (typeof csvPayload === "string") {
        zip.file("risk-history.csv", csvPayload);
      }
      zip.file("risk-settings.json", JSON.stringify(settingsPayload, null, 2));

      const zipBlob = await zip.generateAsync({ type: "blob" });
      const href = URL.createObjectURL(zipBlob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = `risk-compliance-${selectedChartSymbol}-${accountId}.zip`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(href);
    } catch {
      // noop
    }
  };

  const exportAutoExecutionAudit = (format: "json" | "csv") => {
    if (autoExecutionAuditTrail.length === 0) {
      return;
    }
    const filenameBase = `auto-exec-audit-${selectedChartSymbol}-${accountId}`;
    if (format === "json") {
      downloadJsonFile(`${filenameBase}.json`, {
        exportedAt: new Date().toISOString(),
        symbol: selectedChartSymbol,
        accountId,
        mode: autoExecutionMode,
        killSwitch: autoExecutionKillSwitch,
        sessionGuard: {
          enabled: autoSessionGuardEnabled,
          startHour: autoSessionStartHour,
          endHour: autoSessionEndHour,
        },
        symbolLossCapUsd: autoSymbolLossCapUsd,
        events: autoExecutionAuditTrail,
      });
      return;
    }
    const rows: Array<Array<string | number>> = [
      [
        "timestamp",
        "symbol",
        "timeframe",
        "mode",
        "gate_state",
        "meta_pass",
        "risk_pass",
        "session_pass",
        "symbol_loss_pass",
        "kill_switch",
        "size_usd",
        "quality_score",
        "reasons",
      ],
      ...autoExecutionAuditTrail.map((event) => [
        event.timestampIso,
        event.symbol,
        event.timeframe,
        event.mode,
        event.gateState,
        event.metaPass ? "1" : "0",
        event.riskPass ? "1" : "0",
        event.sessionPass ? "1" : "0",
        event.symbolLossPass ? "1" : "0",
        event.killSwitch ? "1" : "0",
        event.sizeUsd.toFixed(2),
        event.qualityScore.toFixed(3),
        event.reasons.join(" | "),
      ]),
    ];
    downloadCsvFile(`${filenameBase}.csv`, rows);
  };
  const exportSelfLearningJournalV4 = (format: "json" | "csv") => {
    if (selfLearningJournalV4Trail.length === 0) {
      return;
    }
    const filenameBase = `self-learning-v4-journal-${selectedChartSymbol}-${accountId}`;
    if (format === "json") {
      downloadJsonFile(`${filenameBase}.json`, {
        exportedAt: new Date().toISOString(),
        symbol: selectedChartSymbol,
        timeframe: chartTimeframe,
        drift: {
          status: selfLearningV4DriftLabel,
          winrateDropPct: selfLearningDriftV4.winrateDropPct,
          brierRise: selfLearningDriftV4.brierRise,
          shortLossCount: selfLearningDriftV4.shortLossCount,
          shortSamples: selfLearningDriftV4.shortSamples,
          longSamples: selfLearningDriftV4.longSamples,
        },
        autoDemotedAt: selfLearningDriftAutoDemotedAt,
        events: selfLearningJournalV4Trail,
      });
      return;
    }
    const rows: Array<Array<string | number>> = [
      [
        "timestamp",
        "symbol",
        "timeframe",
        "regime",
        "scenario",
        "outcome",
        "pnl_usd",
        "mfe_bps",
        "mae_bps",
        "w_dom",
        "w_footprint",
        "w_liquidity",
        "w_price_action",
      ],
      ...selfLearningJournalV4Trail.map((event) => [
        event.timestampIso,
        event.symbol,
        event.timeframe,
        event.regime,
        event.scenario,
        event.outcome,
        event.pnl.toFixed(2),
        event.mfe.toFixed(2),
        event.mae.toFixed(2),
        event.weights.dom.toFixed(4),
        event.weights.footprint.toFixed(4),
        event.weights.liquidity.toFixed(4),
        event.weights["price-action"].toFixed(4),
      ]),
    ];
    downloadCsvFile(`${filenameBase}.csv`, rows);
  };
  const filteredSelfLearningJournalV4Trail = selfLearningJournalV4Trail.filter((event) => {
    if (selfLearningJournalV4RegimeFilter !== "all" && event.regime !== selfLearningJournalV4RegimeFilter) {
      return false;
    }
    if (selfLearningJournalV4ScenarioFilter !== "all" && event.scenario !== selfLearningJournalV4ScenarioFilter) {
      return false;
    }
    return true;
  });
  const selfLearningCurrentScopeCount = selfLearningV4ScopeSummaries.filter(
    (item) => item.accountId === accountId && item.symbol === selectedChartSymbol && item.timeframe === chartTimeframe,
  ).length;
  const selfLearningStorageLabel = selfLearningV4PersistenceStatus.storage === "control-plane"
    ? "CP"
    : selfLearningV4PersistenceStatus.storage === "local-fallback"
      ? "LOCAL"
      : "UNKNOWN";
  const selfLearningStorageTone = !selfLearningV4PersistenceStatus.healthy
    ? "bad"
    : selfLearningV4PersistenceStatus.storage === "control-plane"
      ? "good"
      : selfLearningV4PersistenceStatus.storage === "local-fallback"
        ? "warn"
        : "warn";
  const filteredAutoExecutionAuditTrail = autoExecutionAuditTrail.filter((event) => {
    if (autoExecutionAuditStateFilter !== "all" && event.gateState !== autoExecutionAuditStateFilter) {
      return false;
    }
    const reasonQuery = autoExecutionAuditReasonSearch.trim().toLowerCase();
    if (!reasonQuery) {
      return true;
    }
    return event.reasons.join(" ").toLowerCase().includes(reasonQuery);
  });

  const mergedChartSendHistory = [...chartSendHistory, ...chartSendHistoryBackend]
    .sort((a, b) => new Date(b.atIso).getTime() - new Date(a.atIso).getTime())
    .slice(0, 5);
  const riskTimelineRows = [...chartSendHistoryBackend, ...chartSendHistory]
    .sort((a, b) => new Date(b.atIso).getTime() - new Date(a.atIso).getTime())
    .filter((entry) => {
      if (riskTimelineFilter === "compliant") {
        return entry.compliant;
      }
      if (riskTimelineFilter === "miss") {
        return !entry.compliant;
      }
      return true;
    })
    .slice(0, 24);

  const chartPriceToY = (price: number, height: number): number => {
    const range = Math.max(0.0000001, chartPriceRangeMax - chartPriceRangeMin);
    const pct = (chartPriceRangeMax - price) / range;
    return Math.max(0, Math.min(height, pct * height));
  };

  const chartYToPrice = (y: number, height: number): number => {
    const safeHeight = Math.max(1, height);
    const pct = Math.max(0, Math.min(1, y / safeHeight));
    return chartPriceRangeMax - (chartPriceRangeMax - chartPriceRangeMin) * pct;
  };

  const chartLongPressThresholdMs = (pointerType: string): number => {
    const coarsePointer = typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
    const base = pointerType === "pen" ? 240 : pointerType === "mouse" ? 460 : 320;
    return coarsePointer && pointerType !== "mouse" ? base + 35 : base;
  };
  const activePricePre = crosshair?.price ?? chartLastValue;

  const suggestedLiquidityHighlight = (() => {
    const bracket = marketDecisionV1?.suggestedBracket || null;
    if (!bracket || liquidityZones.length === 0) {
      return null;
    }
    if (bracket.side === "buy") {
      return liquidityZones
        .filter((zone) => zone.level >= Math.min(bracket.tp, bracket.entry))
        .sort((a, b) => Math.abs(a.level - bracket.tp) - Math.abs(b.level - bracket.tp))[0] || null;
    }
    return liquidityZones
      .filter((zone) => zone.level <= Math.max(bracket.tp, bracket.entry))
      .sort((a, b) => Math.abs(a.level - bracket.tp) - Math.abs(b.level - bracket.tp))[0] || null;
  })();
  const suggestedLiquidityExactTpMatch = (() => {
    const bracket = marketDecisionV1?.suggestedBracket || null;
    if (!bracket || !suggestedLiquidityHighlight) {
      return false;
    }
    const tolerance = Math.max(chartPriceStep * 1.5, Math.abs(bracket.tp) * 0.00005);
    return Math.abs(suggestedLiquidityHighlight.level - bracket.tp) <= tolerance;
  })();
  const perceptionTopSignal = (marketSignalV1?.signals || [])[0] || null;
  const perceptionCoreLabel = (() => {
    if (!perceptionTopSignal) {
      return "WAIT · no dominant signal";
    }
    if (perceptionTopSignal.id === "liquidity-trap") {
      return "TRAP DETECTED";
    }
    if (perceptionTopSignal.id === "absorption") {
      return perceptionTopSignal.direction === "buy" ? "BUYER ABSORPTION" : "SELLER ABSORPTION";
    }
    if (perceptionTopSignal.id === "imbalance") {
      return perceptionTopSignal.direction === "buy" ? "STRONG BUY PRESSURE" : "STRONG SELL PRESSURE";
    }
    if (perceptionTopSignal.id === "continuation") {
      return perceptionTopSignal.direction === "buy" ? "BULL CONTINUATION" : "BEAR CONTINUATION";
    }
    if (perceptionTopSignal.id === "exhaustion") {
      return perceptionTopSignal.direction === "buy" ? "SELLERS EXHAUSTED" : "BUYERS EXHAUSTED";
    }
    return perceptionTopSignal.label.toUpperCase();
  })();
  const perceptionTargetLabel = (() => {
    const bracket = marketDecisionV1?.suggestedBracket || null;
    if (!bracket) {
      return "TARGET -> pending";
    }
    const liqSuffix = suggestedLiquidityExactTpMatch ? " (LIQ)" : "";
    return `TARGET -> ${bracket.tp.toFixed(chartPriceDigits)}${liqSuffix}`;
  })();
  const perceptionActionLabel = (() => {
    const bracket = marketDecisionV1?.suggestedBracket || null;
    if (!bracket) {
      return "WAIT CONFIRMATION";
    }
    return `${bracket.side === "buy" ? "BUY" : "SELL"} ABOVE ${bracket.entry.toFixed(chartPriceDigits)} · SL ${bracket.sl.toFixed(chartPriceDigits)} · TP ${bracket.tp.toFixed(chartPriceDigits)} · RR ${bracket.rr.toFixed(2)}`;
  })();
  const perceptionMotionClass = (() => {
    const signals = marketSignalV1?.signals || [];
    const hasTrap = signals.some((signal) => signal.id === "liquidity-trap");
    const hasAbsorption = signals.some((signal) => signal.id === "absorption");
    const hasImbalance = signals.some((signal) => signal.id === "imbalance");
    const hasExhaustion = signals.some((signal) => signal.id === "exhaustion");
    if (hasTrap) {
      return "trap";
    }
    if (hasAbsorption) {
      return "absorption";
    }
    if (hasImbalance) {
      return "imbalance";
    }
    if (hasExhaustion) {
      return "exhaustion";
    }
    return "calm";
  })();
  const perceptionReasonCode = perceptionTopSignal?.reasonCode || null;
  const compactPerceptionReasonLegendThreshold = signalDisplayMode === "ai-dominant"
    ? 80
    : signalDisplayMode === "augmented"
      ? 84
      : 999;
  const compactPerceptionReasonLegend = (signalConfidenceDrift === "UP" || signalConfidenceDrift === "FLAT")
    && (marketSignalV1?.directionalConfidencePct ?? 0) >= compactPerceptionReasonLegendThreshold;
  const perceptionReasonLegend = (() => {
    if (!perceptionReasonCode) {
      return null;
    }
    const normalizedCode = perceptionReasonCode.toUpperCase();
    if (normalizedCode.startsWith("EXH")) {
      return {
        line1: perceptionTopSignal?.direction === "buy" ? "sellers exhausted" : "buyers exhausted",
        line2: null as string | null,
      };
    }
    if (normalizedCode.startsWith("TRAP")) {
      return {
        line1: "liquidity trap active",
        line2: "avoid late chase",
      };
    }
    if (normalizedCode.startsWith("ABS")) {
      return {
        line1: "passive absorption",
        line2: compactPerceptionReasonLegend ? null : "breakout conviction weaker",
      };
    }
    if (normalizedCode.startsWith("IMB")) {
      return {
        line1: "aggressive imbalance",
        line2: compactPerceptionReasonLegend ? null : (perceptionTopSignal?.direction === "buy" ? "buyers in control" : "sellers in control"),
      };
    }
    if (normalizedCode.startsWith("CONT")) {
      return {
        line1: "continuation structure",
        line2: compactPerceptionReasonLegend ? null : "favor pullback entry",
      };
    }
    return {
      line1: "signal context",
      line2: normalizedCode,
    };
  })();
  const perceptionSetupReady = (() => {
    const signals = marketSignalV1?.signals || [];
    const hasImbalance = signals.some((signal) => signal.id === "imbalance");
    const hasAbsorptionOrTrap = signals.some((signal) => signal.id === "absorption" || signal.id === "liquidity-trap");
    return hasImbalance && Boolean(suggestedLiquidityHighlight) && hasAbsorptionOrTrap;
  })();
  const signalImbalance = (marketSignalV1?.signals || []).find((signal) => signal.id === "imbalance") || null;
  const signalAbsorption = (marketSignalV1?.signals || []).find((signal) => signal.id === "absorption") || null;
  const signalTrap = (marketSignalV1?.signals || []).find((signal) => signal.id === "liquidity-trap") || null;
  const signalContinuation = (marketSignalV1?.signals || []).find((signal) => signal.id === "continuation") || null;
  const signalExhaustion = (marketSignalV1?.signals || []).find((signal) => signal.id === "exhaustion") || null;
  const nearLiquidityForEntry = (() => {
    const bracket = marketDecisionV1?.suggestedBracket || null;
    if (!bracket || !suggestedLiquidityHighlight) {
      return false;
    }
    const threshold = Math.max(chartPriceStep * 10, Math.abs(activePricePre) * 0.0012);
    return Math.abs(suggestedLiquidityHighlight.level - bracket.entry) <= threshold;
  })();
  const momentumConfirmed = Boolean(
    signalImbalance
    && signalImbalance.confidence >= 0.62
    && (marketSignalV1?.dominantDirection || "neutral") !== "neutral",
  );
  const trapConfirm = Boolean(signalTrap && signalTrap.confidence >= 0.58);
  const absorptionBlock = Boolean(signalAbsorption && !signalContinuation);
  const continuationAligned = Boolean(
    signalContinuation
    && (marketDecisionV1?.biasDirection || "neutral") !== "neutral"
    && signalContinuation.direction === (marketDecisionV1?.biasDirection || "neutral"),
  );
  const absorptionAgainstPosition = Boolean(
    signalAbsorption
    && (marketDecisionV1?.biasDirection || "neutral") !== "neutral"
    && signalAbsorption.direction !== "neutral"
    && signalAbsorption.direction !== (marketDecisionV1?.biasDirection || "neutral"),
  );
  const trapOppositeBias = Boolean(
    signalTrap
    && (marketDecisionV1?.biasDirection || "neutral") !== "neutral"
    && signalTrap.direction !== "neutral"
    && signalTrap.direction !== (marketDecisionV1?.biasDirection || "neutral"),
  );
  const entryTimingV3 = (() => {
    const baseDirectional = clamp((marketSignalV1?.directionalConfidencePct || 50) / 100, 0.45, 0.95);
    if (momentumConfirmed && nearLiquidityForEntry) {
      return {
        status: "TRIGGER",
        tone: "good",
        detail: "momentum + liquidity",
        confidence: clamp((signalImbalance?.confidence || baseDirectional) * 0.75 + 0.17, 0.62, 0.93),
      };
    }
    if (absorptionBlock && trapConfirm) {
      return {
        status: "READY",
        tone: "warn",
        detail: "absorption + trap",
        confidence: clamp(((signalAbsorption?.confidence || 0.58) + (signalTrap?.confidence || 0.58)) / 2, 0.56, 0.89),
      };
    }
    return {
      status: "WAIT",
      tone: "neutral",
      detail: "await cleaner tape",
      confidence: clamp(baseDirectional * 0.72, 0.41, 0.68),
    };
  })();
  const tradeManagementV3 = (() => {
    const baseDirectional = clamp((marketSignalV1?.directionalConfidencePct || 50) / 100, 0.45, 0.95);
    if (absorptionAgainstPosition) {
      return {
        status: "EXIT NOW",
        tone: "bad",
        detail: "absorption against",
        confidence: clamp((signalAbsorption?.confidence || 0.62) * 0.9 + 0.08, 0.62, 0.94),
      };
    }
    if (signalExhaustion && signalExhaustion.confidence >= 0.6) {
      return {
        status: "REDUCE",
        tone: "warn",
        detail: "exhaustion detected",
        confidence: clamp(signalExhaustion.confidence * 0.9 + 0.04, 0.58, 0.9),
      };
    }
    if (continuationAligned) {
      return {
        status: "HOLD",
        tone: "good",
        detail: "continuation intact",
        confidence: clamp((signalContinuation?.confidence || baseDirectional) * 0.88 + 0.06, 0.57, 0.9),
      };
    }
    return {
      status: "NEUTRAL",
      tone: "neutral",
      detail: "no strong edge",
      confidence: clamp(baseDirectional * 0.7, 0.4, 0.7),
    };
  })();
  const intelligentExitV3 = (() => {
    const baseDirectional = clamp((marketSignalV1?.directionalConfidencePct || 50) / 100, 0.45, 0.95);
    const bracket = marketDecisionV1?.suggestedBracket || null;
    const targetHit = Boolean(
      bracket
      && (
        (bracket.side === "buy" && activePricePre >= bracket.tp)
        || (bracket.side === "sell" && activePricePre <= bracket.tp)
      ),
    );
    if (targetHit) {
      return {
        status: "TAKE PROFIT",
        tone: "good",
        detail: "target liquidity hit",
        confidence: clamp(baseDirectional * 0.9 + 0.07, 0.67, 0.95),
      };
    }
    if (signalExhaustion && signalConfidenceDrift === "DOWN") {
      return {
        status: "EXIT EARLY",
        tone: "warn",
        detail: "confidence fading",
        confidence: clamp(signalExhaustion.confidence * 0.86 + 0.08, 0.6, 0.9),
      };
    }
    if (trapOppositeBias) {
      return {
        status: "REVERSE",
        tone: "bad",
        detail: "opposite trap",
        confidence: clamp((signalTrap?.confidence || 0.62) * 0.9 + 0.08, 0.62, 0.93),
      };
    }
    return {
      status: "HOLD",
      tone: "neutral",
      detail: "structure still valid",
      confidence: clamp(baseDirectional * 0.74, 0.43, 0.74),
    };
  })();
  const confidencePillTone = (value: number): "high" | "low" | "mid" => {
    if (value >= 0.8) {
      return "high";
    }
    if (value <= 0.55) {
      return "low";
    }
    return "mid";
  };
  const trailingV3 = (() => {
    const trailingAtr = Math.max(chartPriceStep * 6, Math.max(activePricePre * Math.max(chartAtrLocalPct, 0.0012), chartPriceStep * 10));
    let multiplier = 1.2;
    if (continuationAligned || momentumConfirmed) {
      multiplier = 2.0;
    }
    if (signalExhaustion) {
      multiplier = 0.8;
    }
    const side = marketDecisionV1?.suggestedBracket?.side || ((marketDecisionV1?.biasDirection || "neutral") === "sell" ? "sell" : "buy");
    const stop = side === "buy"
      ? activePricePre - trailingAtr * multiplier
      : activePricePre + trailingAtr * multiplier;
    const status = multiplier >= 1.8 ? "LOOSE" : multiplier <= 0.9 ? "TIGHT" : "ACTIVE";
    const tone = multiplier >= 1.8 ? "good" : multiplier <= 0.9 ? "warn" : "neutral";
    return {
      status,
      tone,
      detail: `${side === "buy" ? "SL" : "BS"} ${stop.toFixed(chartPriceDigits)}`,
    };
  })();
  const autoMetaFilter = (() => {
    const directionalConfidencePct = marketSignalV1?.directionalConfidencePct || 50;
    const confidencePass = directionalConfidencePct >= 60;
    const confluenceScorePct = marketDecisionV1?.confluenceScorePct || 0;
    const scenario = marketDecisionV1?.scenario || "balance";
    const confluencePass = confluenceScorePct >= 50;
    const regimeChoppy = scenario === "balance" && confluenceScorePct < 58;
    const pass = confidencePass && confluencePass && !regimeChoppy;
    return {
      pass,
      confidencePass,
      confluencePass,
      regimeChoppy,
      qualityScore: clamp(
        (directionalConfidencePct / 100) * 0.45
        + (confluenceScorePct / 100) * 0.35
        + entryTimingV3.confidence * 0.2,
        0.35,
        0.96,
      ),
    };
  })();
  const autoRiskEngine = (() => {
    const maxDailyLossPct = 3;
    const killSwitchDrawdownPct = 5;
    const maxOpenTrades = 3;
    const maxExposurePct = 10;
    const dailyLossBreached = dailyDrawdownPct > maxDailyLossPct;
    const drawdownKillTriggered = dailyDrawdownPct > killSwitchDrawdownPct;
    const openTradesBreached = openTradesCount >= maxOpenTrades;
    const exposureBreached = exposureRatio > maxExposurePct / 100;
    const riskUsdBreached = chartRiskLossExceeded;
    const hardPass = !dailyLossBreached && !openTradesBreached && !exposureBreached && !riskUsdBreached;
    const killSwitchActive = autoExecutionKillSwitch || drawdownKillTriggered;
    return {
      hardPass,
      killSwitchActive,
      maxDailyLossPct,
      maxOpenTrades,
      maxExposurePct,
      dailyLossBreached,
      openTradesBreached,
      exposureBreached,
      riskUsdBreached,
      drawdownKillTriggered,
    };
  })();
  const autoSizingV3 = (() => {
    const atrAbs = Math.max(chartPriceStep * 6, Math.max(activePricePre * Math.max(chartAtrLocalPct, 0.0012), chartPriceStep * 10));
    const stopDistance = Math.max(chartPriceStep, atrAbs * 1.5);
    const riskPerTradeUsd = accountFreeUsd * 0.01;
    const rawSizeUnits = riskPerTradeUsd / Math.max(chartPriceStep, stopDistance);
    const confidenceSize = rawSizeUnits * autoMetaFilter.qualityScore;
    const notionalEstimate = confidenceSize * Math.max(activePricePre, chartPriceStep);
    const notionalCap = accountFreeUsd * 0.1;
    const finalNotional = clamp(notionalEstimate, chartPriceStep * 50, Math.max(chartPriceStep * 50, notionalCap));
    return {
      stopDistance,
      finalNotional,
      sizeUnits: confidenceSize,
    };
  })();
  const autoSessionGuard = (() => {
    const currentHour = new Date().getHours();
    const start = Math.max(0, Math.min(23, autoSessionStartHour));
    const end = Math.max(0, Math.min(23, autoSessionEndHour));
    const inWindow = start <= end
      ? currentHour >= start && currentHour <= end
      : currentHour >= start || currentHour <= end;
    return {
      currentHour,
      inWindow,
      pass: !autoSessionGuardEnabled || inWindow,
      label: `${start.toString().padStart(2, "0")}-${end.toString().padStart(2, "0")}`,
    };
  })();
  const autoSymbolLoss = (() => {
    const normalizedSymbol = normalizeInstrument(selectedChartSymbol);
    const cumulativeLossUsd = outcomes.reduce((sum, item) => {
      if (normalizeInstrument(instrumentLabel(item)) !== normalizedSymbol) {
        return sum;
      }
      const pnl = toNumber(item.pnl_usd, toNumber(item.net_result_usd, 0));
      return pnl < 0 ? sum + Math.abs(pnl) : sum;
    }, 0);
    const overCap = cumulativeLossUsd >= Math.max(50, autoSymbolLossCapUsd);
    const disabledAtIso = autoSymbolAutoDisabled[normalizedSymbol] || null;
    const localDisabled = Boolean(disabledAtIso);
    return {
      normalizedSymbol,
      cumulativeLossUsd,
      overCap,
      localDisabled,
      disabledAtIso,
      pass: !overCap && !localDisabled,
    };
  })();
  const autoEntryReady = entryTimingV3.status === "READY" || entryTimingV3.status === "TRIGGER";
  const autoExecutionGate = (() => {
    const ready = autoMetaFilter.pass
      && autoRiskEngine.hardPass
      && !autoRiskEngine.killSwitchActive
      && autoSessionGuard.pass
      && autoSymbolLoss.pass
      && autoEntryReady
      && Boolean(marketDecisionV1?.suggestedBracket)
      && !replayState.enabled;
    const autoState = autoRiskEngine.killSwitchActive
      ? "KILLED"
      : ready
        ? "READY"
        : "BLOCKED";
    return {
      ready,
      autoState,
      riskLabel: autoRiskEngine.hardPass ? "OK" : "BLOCKED",
      sizeLabel: `${autoSizingV3.finalNotional.toFixed(0)} USD`,
      ruleLabel: autoRiskEngine.killSwitchActive
        ? "kill switch"
        : !autoSessionGuard.pass
          ? `session ${autoSessionGuard.label}`
          : !autoSymbolLoss.pass
            ? "symbol loss cap"
            : autoMetaFilter.regimeChoppy
              ? "regime choppy"
              : autoMetaFilter.pass ? "meta pass" : "meta blocked",
    };
  })();
  const selfLearningScopedOutcomesV4 = useMemo(() => {
    const normalizedSymbol = normalizeInstrument(selectedChartSymbol);
    const readOutcomeTf = (item: JsonMap): string | null => {
      const raw = String(item.timeframe || item.chart_timeframe || item.strategy_timeframe || item.tf || "").trim();
      return raw === "1m" || raw === "5m" || raw === "15m" ? raw : null;
    };
    return filteredOutcomes
      .filter((item) => normalizeInstrument(instrumentLabel(item)) === normalizedSymbol)
      .filter((item) => {
        const itemTf = readOutcomeTf(item);
        return itemTf === null || itemTf === chartTimeframe;
      })
      .map((item, index) => {
        const timestampIso = pickTimestamp(item, ["executed_at", "filled_at", "closed_at", "created_at"]) || new Date(0).toISOString();
        const pnl = toNumber(item.pnl_usd, toNumber(item.net_result_usd, 0));
        return {
          key: String(item.decision_id || item.ticket_key || `${timestampIso}-${index}`),
          timestampIso,
          pnl,
          mfe: toNumber(item.mfe_bps, 0),
          mae: toNumber(item.mae_bps, 0),
          score: clamp(toNumber(item.ai_score ?? item.score, 0.5), 0, 1),
          win: pnl >= 0,
          regimeRaw: String(item.regime || item.market_regime || item.regime_label || "").toLowerCase(),
          raw: item,
        };
      })
      .sort((left, right) => sortIsoAscending(right.timestampIso, left.timestampIso));
  }, [chartTimeframe, filteredOutcomes, selectedChartSymbol]);

  useEffect(() => {
    if (
      authSessionRequired
      || authStatus !== "authenticated"
      || chartMode !== "candles"
      || chartLoading
      || quotes.length === 0
      || classifyInstrument(selectedChartSymbol) !== "crypto"
      || localOhlcvAnalysis.signal !== "OHLCV_UNUSABLE"
    ) {
      setLocalFeedFallbackSuggestion(null);
      return;
    }

    const recoveryQuote = pickDefaultChartQuote(quotes);
    if (!recoveryQuote) {
      setLocalFeedFallbackSuggestion(null);
      return;
    }

    const recoverySymbol = instrumentLabel(recoveryQuote);
    const recoveryInstrument = normalizeInstrument(String(recoveryQuote.instrument || recoverySymbol));
    const recoveryVenue = String(recoveryQuote.venue || "binance-public");
    if (!recoverySymbol || recoveryInstrument === normalizeInstrument(selectedChartSymbol)) {
      setLocalFeedFallbackSuggestion(null);
      return;
    }

    const recoveryKey = `${normalizeInstrument(selectedChartSymbol)}|${selectedChartInstrument}|${selectedChartVenue}|${chartTimeframe}|${recoveryInstrument}`;
    if (
      chartEmptyRecoveryKeyRef.current === recoveryKey
      || localFeedDismissedFallbackKeyRef.current === recoveryKey
    ) {
      return;
    }

    setLocalFeedFallbackSuggestion((current) => {
      if (current?.key === recoveryKey) {
        return current;
      }
      return {
        key: recoveryKey,
        symbol: recoverySymbol,
        instrument: recoveryInstrument,
        venue: recoveryVenue,
        timeframe: chartTimeframe,
        autoApplyAtMs: Date.now() + 3500,
      };
    });
  }, [
    authSessionRequired,
    authStatus,
    chartLoading,
    chartMode,
    chartTimeframe,
    localOhlcvAnalysis.signal,
    quotes,
    selectedChartInstrument,
    selectedChartSymbol,
    selectedChartVenue,
  ]);

  useEffect(() => {
    if (!localFeedFallbackSuggestion) {
      return;
    }
    const delayMs = Math.max(0, localFeedFallbackSuggestion.autoApplyAtMs - Date.now());
    const timer = window.setTimeout(() => {
      chartEmptyRecoveryKeyRef.current = localFeedFallbackSuggestion.key;
      setSelectedChartSymbol(localFeedFallbackSuggestion.symbol);
      setLocalFeedFallbackSuggestion(null);
      setWorkspaceHintBadge(`Fallback applied: ${localFeedFallbackSuggestion.symbol} (${selectedChartInstrument} unusable)`);
    }, delayMs);
    return () => {
      window.clearTimeout(timer);
    };
  }, [localFeedFallbackSuggestion, selectedChartInstrument]);

  const selfLearningDriftV4 = useMemo(() => {
    const samples = selfLearningScopedOutcomesV4;
    const shortWindow = samples.slice(0, 10);
    const longWindow = samples.slice(0, 24);
    const calcWinrate = (windowItems: typeof samples) => {
      if (windowItems.length === 0) {
        return null;
      }
      return average(windowItems.map((item) => (item.win ? 1 : 0)));
    };
    const calcBrier = (windowItems: typeof samples) => {
      if (windowItems.length === 0) {
        return null;
      }
      return average(windowItems.map((item) => (item.score - (item.win ? 1 : 0)) ** 2));
    };
    const shortWinrate = calcWinrate(shortWindow);
    const longWinrate = calcWinrate(longWindow);
    const shortBrier = calcBrier(shortWindow);
    const longBrier = calcBrier(longWindow);
    const winrateDrop = shortWinrate !== null && longWinrate !== null ? Math.max(0, longWinrate - shortWinrate) : 0;
    const brierRise = shortBrier !== null && longBrier !== null ? Math.max(0, shortBrier - longBrier) : 0;
    const shortLossCount = shortWindow.filter((item) => !item.win).length;
    const enoughSamples = shortWindow.length >= 6 && longWindow.length >= 10;
    const severeDeterioration = shortLossCount >= 6 || (winrateDrop >= 0.2 && brierRise >= 0.04) || brierRise >= 0.1;
    const moderateDeterioration = winrateDrop >= 0.14 && brierRise >= 0.03;
    const shouldDemote = enoughSamples && (severeDeterioration || moderateDeterioration);
    const latestKey = shortWindow[shortWindow.length - 1]?.key || "na";
    const signature = [latestKey, shortLossCount, Math.round(winrateDrop * 100), Math.round(brierRise * 1000)].join(":");
    return {
      shortSamples: shortWindow.length,
      longSamples: longWindow.length,
      shortWinratePct: shortWinrate !== null ? shortWinrate * 100 : 0,
      longWinratePct: longWinrate !== null ? longWinrate * 100 : 0,
      winrateDropPct: winrateDrop * 100,
      shortBrier,
      longBrier,
      brierRise,
      shortLossCount,
      enoughSamples,
      shouldDemote,
      signature,
    };
  }, [selfLearningScopedOutcomesV4]);
  const selfLearningV4DriftLabel = selfLearningDriftV4.shouldDemote ? "DRIFT" : selfLearningDriftV4.enoughSamples ? "STABLE" : "WARMUP";
  const selfLearningV4Active = hasRenderableCandles && selfLearningV4Enabled && selfLearningScopedOutcomesV4.length >= 4;
  const selfLearningV4WeightsLabel = selfLearningAutoAdaptEnabled ? "ADAPTED" : "MANUAL";
  const selfLearningV4ModelLabel = selfLearningModelUpdatedAt ? "UPDATED" : "BOOTING";

  const snapChartOrderPrice = (rawPrice: number, line: ChartOrderLineKey, current: ChartOrderTicket): { price: number; label: string; family: ChartSnapFamily } => {
    return resolveSnappedChartOrderPrice({
      rawPrice,
      line,
      current,
      chartPriceRangeMin,
      chartPriceRangeMax,
      chartPriceStep,
      chartPriceDigits,
      chartSnapEnabled,
      chartRoundMagnetStep,
      chartMode,
      chartCandles,
      showVwap,
      dayVwap,
      weekVwap,
      monthVwap,
      showLiquidity,
      liquidityZones,
      crosshair,
      chartSnapPriority,
      chartSnapThreshold,
      chartAtrLocalPct,
    });
  };

  const moveChartOrderLine = (current: ChartOrderTicket, line: ChartOrderLineKey, rawPrice: number): ChartOrderTicket => {
    const snapped = snapChartOrderPrice(rawPrice, line, current);
    const referencePrice = Math.max(0.0000001, current.entry || chartAnchorPrice || chartLastValue || 1);
    const next = moveChartOrderLineTicket({ current, line, rawPrice, referencePrice, chartPriceStep, snapped });

    chartOrderTicketRef.current = next;
    if (snapped.family !== "manual") {
      triggerChartHaptic(`${snapped.label}:${snapped.price.toFixed(chartPriceDigits)}`);
      setChartSnapPulseLine(line);
    }
    chartSnapStateRef.current = { label: snapped.label, price: snapped.price, family: snapped.family };
    setChartSnapState(chartSnapStateRef.current);
    return next;
  };

  const clearChartLongPressTimer = () => {
    if (chartLongPressTimerRef.current !== null) {
      window.clearTimeout(chartLongPressTimerRef.current);
      chartLongPressTimerRef.current = null;
    }
  };

  useEffect(() => {
    if (!chartSnapPulseLine) {
      return;
    }
    const timer = window.setTimeout(() => setChartSnapPulseLine(null), 240);
    return () => {
      window.clearTimeout(timer);
    };
  }, [chartSnapPulseLine]);

  useEffect(() => {
    if (!chartReleaseValidationPulse) {
      return;
    }
    const timer = window.setTimeout(() => setChartReleaseValidationPulse(false), 380);
    return () => {
      window.clearTimeout(timer);
    };
  }, [chartReleaseValidationPulse]);

  const triggerChartHaptic = (signature: string, pattern?: number | number[]) => {
    if (chartHapticMode === "off") {
      return;
    }
    if (chartSnapHapticSignatureRef.current === signature) {
      return;
    }
    chartSnapHapticSignatureRef.current = signature;
    const resolvedPattern = pattern ?? (chartHapticMode === "medium" ? [16, 30, 16] : 12);
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      navigator.vibrate(resolvedPattern);
    }
  };

  const openChartReleaseTicket = (line: ChartOrderLineKey, snapLabel: string, fineMode: boolean) => {
    const rectHeight = chartStageRef.current?.clientHeight || 500;
    const top = Math.max(14, Math.min(rectHeight - 132, chartPriceToY(chartOrderTicketRef.current[line], rectHeight) - 38));
    setChartReleaseTicket({
      line,
      top,
      price: chartOrderTicketRef.current[line],
      snapLabel,
      fineMode,
      armed: false,
    });
  };

  const beginChartOrderDrag = (event: React.PointerEvent<HTMLDivElement | HTMLButtonElement>, line: ChartOrderLineKey, forceFineMode = false) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = chartStageRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    clearChartLongPressTimer();
    chartSnapHapticSignatureRef.current = "";
    setChartReleaseTicket(null);
    setChartActiveSnapLine(line);
    const nextDrag: ChartDragState = {
      line,
      rectTop: rect.top,
      rectHeight: rect.height,
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      startPrice: chartOrderTicketRef.current[line],
      fineMode: forceFineMode,
      moved: false,
    };
    chartOrderDragRef.current = nextDrag;
    if ((event.pointerType === "touch" || event.pointerType === "pen") && !forceFineMode) {
      const holdThresholdMs = chartLongPressThresholdMs(event.pointerType);
      chartLongPressTimerRef.current = window.setTimeout(() => {
        const activeDrag = chartOrderDragRef.current;
        if (activeDrag && activeDrag.pointerId === event.pointerId) {
          activeDrag.fineMode = true;
          triggerChartHaptic(`fine:${line}`, [8, 24, 8]);
          chartSnapStateRef.current = { label: "FINE", price: chartOrderTicketRef.current[line], family: "manual" };
          setChartSnapState(chartSnapStateRef.current);
        }
      }, holdThresholdMs);
    } else {
      chartSnapStateRef.current = forceFineMode ? { label: "FINE", price: chartOrderTicketRef.current[line], family: "manual" } : null;
      setChartSnapState(chartSnapStateRef.current);
    }
  };

  useEffect(() => {
    if (chartOrderTicket.entry > 0 && chartOrderTicket.active) {
      return;
    }
    if (chartAnchorPrice <= 0) {
      return;
    }
    applyChartOrderPreset(chartOrderTicket.preset === "custom" ? "scalp" : chartOrderTicket.preset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartAnchorPrice, selectedChartSymbol]);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const drag = chartOrderDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) {
        return;
      }
      const y = Math.max(0, Math.min(drag.rectHeight, event.clientY - drag.rectTop));
      const rawPrice = chartYToPrice(y, drag.rectHeight);
      const adjustedPrice = drag.fineMode
        ? drag.startPrice + (rawPrice - drag.startPrice) * 0.28
        : rawPrice;
      drag.moved = true;
      clearChartLongPressTimer();
      setChartOrderTicket((current) => moveChartOrderLine(current, drag.line, adjustedPrice));
    };
    const onUp = (event: PointerEvent) => {
      const drag = chartOrderDragRef.current;
      if (drag && drag.pointerId !== event.pointerId) {
        return;
      }
      clearChartLongPressTimer();
      if (drag?.moved) {
        openChartReleaseTicket(drag.line, chartSnapStateRef.current?.label || (drag.fineMode ? "FINE" : "MANUAL"), drag.fineMode);
      }
      chartOrderDragRef.current = null;
      chartSnapHapticSignatureRef.current = "";
      chartSnapStateRef.current = null;
      setChartActiveSnapLine(null);
      setChartSnapState(null);
    };
    const onCancel = () => {
      clearChartLongPressTimer();
      chartOrderDragRef.current = null;
      chartSnapHapticSignatureRef.current = "";
      chartSnapStateRef.current = null;
      setChartActiveSnapLine(null);
      setChartSnapState(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  }, [chartPriceDigits, chartPriceRangeMax, chartPriceRangeMin, chartPriceStep, chartRoundMagnetStep, chartSnapEnabled, chartSnapThreshold, chartAnchorPrice, chartLastValue, crosshair, showLiquidity, showVwap, dayVwap, weekVwap, monthVwap, liquidityZones, chartSnapState]);
  const chartSignalComputationEnabled = replayState.enabled || hasRenderableCandles;
  const {
    tape,
    footprintRows,
    domLevels,
    domDisplayLevels,
    heatmapLevels,
    tapeByTimeKey,
    footprintByTimeKey,
  } = useMemo(() => {
    if (!chartSignalComputationEnabled) {
      return {
        tape: [] as TapePrint[],
        footprintRows: [] as FootprintRow[],
        domLevels: [] as DomLevel[],
        domDisplayLevels: [] as DomLevel[],
        heatmapLevels: [] as DomLevel[],
        tapeByTimeKey: new Map<string, TapePrint[]>(),
        footprintByTimeKey: new Map<string, FootprintRow[]>(),
      };
    }

    const nextTape = nativeTrades.length > 0 ? buildTapeFromTrades(nativeTrades, chartTimeframe) : buildTape(chartSeries, chartTimeframe);
    const nextFootprintRows = buildFootprintFromOhlcv(hasRenderableCandles ? renderableOhlcvBars : [], chartTimeframe);
    const domLevels = marketDepth ? buildDomLevelsFromDepth(marketDepth) : buildDomLevels(orderbook);
    const nextDomDisplayLevels = domLevels.slice(0, 14);
    const buyLevels = domLevels.filter((level) => level.side === "bid");
    const sellLevels = domLevels.filter((level) => level.side === "ask");
    const nextHeatmapLevels = [...[...sellLevels].reverse(), ...buyLevels].slice(0, 20);
    const nextTapeByTimeKey = nextTape.reduce((acc, entry) => {
      if (entry.timeKey) {
        acc.set(entry.timeKey, [...(acc.get(entry.timeKey) || []), entry]);
      }
      return acc;
    }, new Map<string, TapePrint[]>());
    const nextFootprintByTimeKey = nextFootprintRows.reduce((acc, entry) => {
      if (entry.timeKey) {
        acc.set(entry.timeKey, [...(acc.get(entry.timeKey) || []), entry]);
      }
      return acc;
    }, new Map<string, FootprintRow[]>());

    return {
      tape: nextTape,
      footprintRows: nextFootprintRows,
      domLevels,
      domDisplayLevels: nextDomDisplayLevels,
      heatmapLevels: nextHeatmapLevels,
      tapeByTimeKey: nextTapeByTimeKey,
      footprintByTimeKey: nextFootprintByTimeKey,
    };
  }, [chartSeries, chartSignalComputationEnabled, chartTimeframe, hasRenderableCandles, marketDepth, nativeTrades, orderbook, renderableOhlcvBars]);
  const displayDepthStreamState: "offline" | "connecting" | "live" = depthStreamState === "live"
    || marketDepth !== null
    || orderbook !== null
    ? "live"
    : depthStreamState;
  const depthPayload = (marketDepth?.depth_payload as JsonMap | undefined) || {};
  const depthEventTime = toNumber(depthPayload.event_time, 0);
  const depthSnapshotAt = String(marketDepth?.snapshot_at || "");
  const depthTimeKey = depthEventTime > 0
    ? toTimeBucketKey(depthEventTime, chartTimeframe)
    : depthSnapshotAt
      ? toTimeBucketKey(depthSnapshotAt, chartTimeframe)
      : "";
  const replayBufferKey = `${selectedChartSymbol}:${chartTimeframe}`;

  useEffect(() => {
    const nextFramesByKey = chartSeries
      .map((point) => ({
        timeKey: toTimeBucketKey(point.label, chartTimeframe),
        timeLabel: formatClock(point.label),
        quoteValue: point.value,
      }))
      .filter((frame) => frame.timeKey);

    setReplayBuffers((current) => {
      const existing = current[replayBufferKey] || [];
      const frameMap = new Map<string, ReplayFrame>(existing.map((frame) => [frame.timeKey, { ...frame }]));

      for (const frame of nextFramesByKey) {
        const currentFrame = frameMap.get(frame.timeKey) || { timeKey: frame.timeKey, timeLabel: frame.timeLabel };
        currentFrame.timeLabel = frame.timeLabel;
        currentFrame.quoteValue = frame.quoteValue;
        if (tapeByTimeKey.has(frame.timeKey)) {
          currentFrame.tapeEvents = (tapeByTimeKey.get(frame.timeKey) || []).slice(0, 12);
        }
        if (footprintByTimeKey.has(frame.timeKey)) {
          currentFrame.footprintRows = (footprintByTimeKey.get(frame.timeKey) || []).slice(0, 8);
        }
        frameMap.set(frame.timeKey, currentFrame);
      }

      if (depthTimeKey) {
        const depthFrame = frameMap.get(depthTimeKey) || { timeKey: depthTimeKey, timeLabel: formatTimeKeyLabel(depthTimeKey) };
        depthFrame.domLevels = domDisplayLevels.slice(0, 14);
        depthFrame.heatmapLevels = heatmapLevels.slice(0, 20);
        frameMap.set(depthTimeKey, depthFrame);
      }

      const nextFrames = [...frameMap.values()]
        .sort((left, right) => Number(left.timeKey) - Number(right.timeKey))
        .slice(-320);

      const unchanged = existing.length === nextFrames.length
        && existing.every((frame, index) => {
          const next = nextFrames[index];
          if (!next) {
            return false;
          }
          return frame.timeKey === next.timeKey
            && frame.timeLabel === next.timeLabel
            && frame.quoteValue === next.quoteValue
            && (frame.tapeEvents?.length || 0) === (next.tapeEvents?.length || 0)
            && (frame.footprintRows?.length || 0) === (next.footprintRows?.length || 0)
            && (frame.domLevels?.length || 0) === (next.domLevels?.length || 0)
            && (frame.heatmapLevels?.length || 0) === (next.heatmapLevels?.length || 0);
        });

      if (unchanged) {
        return current;
      }

      return { ...current, [replayBufferKey]: nextFrames };
    });
  }, [chartSeries, chartTimeframe, depthTimeKey, domDisplayLevels, footprintByTimeKey, heatmapLevels, replayBufferKey, tapeByTimeKey]);

  const replayFrames = replayBuffers[replayBufferKey] || [];
  const replayMaxIndex = Math.max(0, replayFrames.length - 1);
  const frameIndexByTimeKey = replayFrames.reduce((acc, frame, index) => {
    acc.set(frame.timeKey, index);
    return acc;
  }, new Map<string, number>());

  const resolveFrameIndexForEvent = (timeKey: string): number => {
    const exact = frameIndexByTimeKey.get(timeKey);
    if (typeof exact === "number") {
      return exact;
    }
    if (replayFrames.length === 0) {
      return 0;
    }
    const target = Number(timeKey);
    if (!Number.isFinite(target)) {
      return replayMaxIndex;
    }
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < replayFrames.length; index += 1) {
      const candidate = Number(replayFrames[index].timeKey);
      const distance = Math.abs(candidate - target);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }
    return bestIndex;
  };

  const replayEventMarkers = (() => {
    const markers: ReplayEventMarker[] = [];

    for (const [index, item] of replayTimeline.entries()) {
      const timeKey = toTimeBucketKey(item.timestamp, chartTimeframe);
      if (!timeKey) {
        continue;
      }
      const lower = item.label.toLowerCase();
      const kind = lower.includes("intent")
        ? "intent"
        : lower.includes("approval") || lower.includes("broker")
          ? "approval"
          : lower.includes("fill")
            ? "fill"
            : lower.includes("routing")
              ? "routing"
              : "other";
      markers.push({
        id: `timeline-${index}-${timeKey}`,
        label: item.label,
        kind,
        timeKey,
        frameIndex: resolveFrameIndexForEvent(timeKey),
        critical: false,
        detail: `${item.label} ${formatClock(item.timestamp)}`,
      });
    }

    for (const [index, fill] of replayFills.slice(0, 12).entries()) {
      const fillTime = String(fill.traded_at || fill.created_at || "");
      const timeKey = toTimeBucketKey(fillTime, chartTimeframe);
      if (!timeKey) {
        continue;
      }
      const venue = String(fill.venue || "venue");
      markers.push({
        id: `fill-${index}-${timeKey}`,
        label: "Fill",
        kind: "fill",
        timeKey,
        frameIndex: resolveFrameIndexForEvent(timeKey),
        critical: false,
        detail: `${venue} ${toNumber(fill.price, 0).toFixed(2)} ${toNumber(fill.size, 0).toFixed(3)}`,
      });
    }

    for (const [index, approval] of pendingLive.slice(0, 10).entries()) {
      const approvalTs = pickTimestamp(approval, ["approved_at", "created_at", "submitted_at", "timestamp"]);
      const timeKey = toTimeBucketKey(approvalTs, chartTimeframe);
      if (!timeKey) {
        continue;
      }
      markers.push({
        id: `approval-${index}-${timeKey}`,
        label: "Approval",
        kind: "approval",
        timeKey,
        frameIndex: resolveFrameIndexForEvent(timeKey),
        critical: false,
        detail: String(approval.approval_id || approval.id || "approval"),
      });
    }

    for (const [index, incident] of incidents.slice(0, 16).entries()) {
      const incidentTs = pickTimestamp(incident, ["created_at", "opened_at", "updated_at", "timestamp"]);
      const timeKey = toTimeBucketKey(incidentTs, chartTimeframe);
      if (!timeKey) {
        continue;
      }
      const severity = incidentSeverityLabel(incident);
      const critical = incidentSeverityRank(incident) >= 4 || Boolean(incident.sla_breached);
      markers.push({
        id: `incident-${index}-${timeKey}`,
        label: "Incident",
        kind: "incident",
        timeKey,
        frameIndex: resolveFrameIndexForEvent(timeKey),
        critical,
        detail: `${String(incident.ticket_key || "incident")} ${severity}`,
      });
    }

    // ── OUTCOME markers ─────────────────────────────────────────────────
    for (const [index, outcome] of filteredOutcomes.slice(0, 15).entries()) {
      const outcomeTs = pickTimestamp(outcome, ["executed_at", "filled_at", "closed_at", "created_at"]);
      const timeKey = toTimeBucketKey(outcomeTs, chartTimeframe);
      if (!timeKey) {
        continue;
      }
      const outcomeId = decisionIdFrom(outcome);
      const outcomeAttribution = outcomeId ? replayAttributionByDecisionId[outcomeId] || null : null;
      const pnl = toNumber(outcome.pnl_usd, NaN);
      const pnlPct = toNumber(outcome.pnl_pct, 0);
      const pnlSign = Number.isFinite(pnl) ? (pnl >= 0 ? "+" : "") : "";
      const familySuffix = outcomeAttribution ? ` ${compactFeatureFamilyLabel(outcomeAttribution.topFamily)}` : "";
      const label = Number.isFinite(pnl) ? `${pnlSign}${pnl.toFixed(0)}$${familySuffix}` : `PnL${familySuffix}`;
      const dreamDetail = outcomeAttribution ? ` · ${buildReplayDreamSummary(outcomeAttribution)}` : "";
      markers.push({
        id: `outcome-${index}-${timeKey}`,
        label,
        kind: "outcome",
        timeKey,
        frameIndex: resolveFrameIndexForEvent(timeKey),
        critical: Number.isFinite(pnl) && pnl < -500,
        detail: `${instrumentLabel(outcome)} ${pnlSign}${pnlPct.toFixed(2)}% MAE:${toNumber(outcome.mae_bps, 0).toFixed(0)}bps MFE:${toNumber(outcome.mfe_bps, 0).toFixed(0)}bps${outcomeAttribution ? ` · ${formatFeatureFamilyLabel(outcomeAttribution.topFamily)} ${outcomeAttribution.topContribution >= 0 ? "+" : ""}${outcomeAttribution.topContribution.toFixed(2)} · ${outcomeAttribution.contextLabel}` : ""}${dreamDetail}`,
      });
      if (
        outcomeAttribution
        && (
          outcomeAttribution.latentLabel !== outcomeAttribution.latentNextLabel
          || outcomeAttribution.latentTransition >= 0.12
          || outcomeAttribution.dreamCount > 0
          || outcomeAttribution.synthetic
        )
      ) {
        const latentCompact = outcomeAttribution.latentLabel === outcomeAttribution.latentNextLabel
          ? compactReplayLatentLabel(outcomeAttribution.latentLabel)
          : `${compactReplayLatentLabel(outcomeAttribution.latentLabel)}→${compactReplayLatentLabel(outcomeAttribution.latentNextLabel)}`;
        const provenanceCompact = outcomeAttribution.synthetic
          ? " SYN"
          : outcomeAttribution.dreamCount > 0
            ? ` D${outcomeAttribution.dreamCount}`
            : "";
        markers.push({
          id: `latent-${index}-${timeKey}`,
          label: `${latentCompact}${provenanceCompact}`,
          kind: "latent",
          timeKey,
          frameIndex: resolveFrameIndexForEvent(timeKey),
          critical: outcomeAttribution.latentLabel !== outcomeAttribution.latentNextLabel && outcomeAttribution.latentTransition >= 0.38,
          detail: `${outcomeAttribution.latentShiftLabel} · shift ${(outcomeAttribution.latentTransition * 100).toFixed(0)}% · ${buildReplayDreamSummary(outcomeAttribution)}`,
        });
      }
    }

    return markers
      .filter((marker, index, rows) => rows.findIndex((candidate) => candidate.id === marker.id) === index)
      .sort((left, right) => left.frameIndex - right.frameIndex)
      .slice(0, 60);
  })();

  const criticalReplayFrameIndexes = replayEventMarkers
    .filter((marker) => marker.critical)
    .map((marker) => marker.frameIndex);
  const criticalReplayFrameSet = new Set<number>(criticalReplayFrameIndexes);
  const criticalReplayFrameKey = criticalReplayFrameIndexes.join(",");

  const visibleReplayMarkers = replayEventMarkers.filter((m) => {
    if (replayFilterCritical && !m.critical) return false;
    if (replayFilterKinds.length > 0 && !replayFilterKinds.includes(m.kind)) return false;
    return true;
  });
  const toggleReplayFilterKind = (kind: string) =>
    setReplayFilterKinds((prev) => prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind]);

  useEffect(() => {
    if (replayFrames.length === 0) {
      if (replayState.enabled || replayState.playing || replayState.cursorIndex !== 0 || replayState.timeKey) {
        setReplayState((current) => ({ ...current, enabled: false, playing: false, cursorIndex: 0, timeKey: null }));
      }
      return;
    }

    if (!replayState.enabled) {
      return;
    }

    const nextIndex = clampIndex(replayState.cursorIndex, replayMaxIndex);
    const nextTimeKey = replayFrames[nextIndex]?.timeKey || null;
    if (nextIndex !== replayState.cursorIndex || nextTimeKey !== replayState.timeKey) {
      setReplayState((current) => ({ ...current, cursorIndex: nextIndex, timeKey: nextTimeKey }));
    }
  }, [replayFrames, replayMaxIndex, replayState.cursorIndex, replayState.enabled, replayState.playing, replayState.timeKey]);

  useEffect(() => {
    if (!replayState.enabled || !replayState.playing || replayFrames.length === 0) {
      return;
    }

    const intervalMs = Math.max(125, Math.floor(1000 / replayState.speed));
    const timer = window.setInterval(() => {
      setReplayState((current) => {
        const maxIndex = Math.max(0, replayFrames.length - 1);
        const nextIndex = clampIndex(current.cursorIndex + 1, maxIndex);
        const reachedEnd = nextIndex >= maxIndex;
        const reachedCritical = criticalReplayFrameSet.has(nextIndex);
        return {
          ...current,
          cursorIndex: nextIndex,
          timeKey: replayFrames[nextIndex]?.timeKey || current.timeKey,
          playing: reachedEnd || reachedCritical ? false : current.playing,
        };
      });
    }, intervalMs);

    return () => {
      window.clearInterval(timer);
    };
  }, [criticalReplayFrameKey, replayFrames, replayState.enabled, replayState.playing, replayState.speed]);

  const liveTimeKey = depthTimeKey || (chartSeries.length > 0 ? toTimeBucketKey(chartSeries[chartSeries.length - 1].label, chartTimeframe) : "");
  const crosshairTimeKey = crosshair?.timeKey || "";
  const replayTimeKey = replayState.enabled ? replayState.timeKey || "" : "";
  const activeTimeKey = replayState.enabled ? replayTimeKey : (crosshairTimeKey || liveTimeKey);
  const replayFrame = replayState.enabled && replayFrames.length > 0
    ? replayFrames[clampIndex(replayState.cursorIndex, replayMaxIndex)] || null
    : null;
  const chartHeavyFeaturesEnabled = chartSignalComputationEnabled;
  const activeDomLevels = replayState.enabled
    ? (replayFrame?.domLevels || [])
    : (chartHeavyFeaturesEnabled ? domDisplayLevels : []);
  const activeHeatmapLevels = replayState.enabled
    ? (replayFrame?.heatmapLevels || [])
    : (chartHeavyFeaturesEnabled ? heatmapLevels : []);
  const activeFootprintRows = replayState.enabled
    ? (replayFrame?.footprintRows || [])
    : (chartHeavyFeaturesEnabled ? footprintRows.slice(0, 8) : []);
  const activeTape = replayState.enabled
    ? (replayFrame?.tapeEvents || [])
    : (chartHeavyFeaturesEnabled ? tape.slice(0, 12) : []);
  const activePrice = replayState.enabled
    ? toNumber(replayFrame?.quoteValue, chartLastValue)
    : (crosshair?.price ?? chartLastValue);
  var marketSignalV1 = useMemo<MarketSignalSnapshot>(() => {
    if (!chartSignalComputationEnabled) {
      return {
        buyPressurePct: 50,
        sellPressurePct: 50,
        directionalLongPct: 50,
        directionalShortPct: 50,
        directionalConfidencePct: 50,
        directionalConfidenceLabel: "LOW",
        dominantDirection: "neutral",
        headline: "Signal standby while chart is partial",
        convictionLabel: "standby",
        focusMode: false,
        calibrationLabel: resolveSignalCalibration(selectedChartSymbol, chartTimeframe).label,
        criticalSignalCount: 0,
        criticalSignalIds: [],
        signals: [],
      };
    }

    const calibration = resolveSignalCalibration(selectedChartSymbol, chartTimeframe);
    const bidDepth = activeDomLevels
      .filter((level) => level.side === "bid")
      .reduce((sum, level) => sum + Math.max(0, level.size), 0);
    const askDepth = activeDomLevels
      .filter((level) => level.side === "ask")
      .reduce((sum, level) => sum + Math.max(0, level.size), 0);
    const domImbalanceRatio = (bidDepth + 1) / (askDepth + 1);

    const footprintBuy = activeFootprintRows.reduce((sum, row) => sum + Math.max(0, row.buyVolume), 0);
    const footprintSell = activeFootprintRows.reduce((sum, row) => sum + Math.max(0, row.sellVolume), 0);
    const footprintTotal = footprintBuy + footprintSell;
    const footprintDelta = footprintBuy - footprintSell;
    const deltaRatio = footprintTotal > 0 ? Math.abs(footprintDelta) / footprintTotal : 0;

    const recentPoints = chartSeries.slice(-8);
    const firstRecent = recentPoints[0]?.value ?? activePrice;
    const lastRecent = recentPoints[recentPoints.length - 1]?.value ?? activePrice;
    const recentMove = lastRecent - firstRecent;
    const recentMovePct = firstRecent > 0 ? Math.abs(recentMove) / firstRecent : 0;
    const lowDisplacementThreshold = Math.max(calibration.absorptionMovePctMax, chartAtrLocalPct * 0.36);
    const continuationThreshold = Math.max(calibration.continuationMovePctMin, chartAtrLocalPct * 0.46);

    const lastCandle = chartCandles[chartCandles.length - 1];
    const prevCandle = chartCandles[chartCandles.length - 2];

    const aboveLiquidity = liquidityZones
      .filter((zone) => zone.level > activePrice)
      .sort((a, b) => a.level - b.level)[0] || null;
    const belowLiquidity = liquidityZones
      .filter((zone) => zone.level < activePrice)
      .sort((a, b) => b.level - a.level)[0] || null;
    const nearestLiquidityDistance = Math.min(
      aboveLiquidity ? Math.abs(aboveLiquidity.level - activePrice) : Number.POSITIVE_INFINITY,
      belowLiquidity ? Math.abs(activePrice - belowLiquidity.level) : Number.POSITIVE_INFINITY,
    );
    const nearKeyLevel = Number.isFinite(nearestLiquidityDistance)
      && nearestLiquidityDistance <= Math.max(chartPriceStep * 8, activePrice * 0.0008);
    const deltaOppositePrice = Math.sign(footprintDelta) !== 0 && Math.sign(recentMove) !== 0
      && Math.sign(footprintDelta) !== Math.sign(recentMove);
    const stackedImbalanceStrength = Math.max(0, Math.abs(Math.log(domImbalanceRatio)) - Math.log(Math.max(1.0001, calibration.imbalanceRatio)));

    const signals: MarketSignalEvent[] = [];

    if (domImbalanceRatio >= calibration.imbalanceRatio) {
      signals.push({
        id: "imbalance",
        label: "Strong Buy Pressure",
        detail: `bid/ask ${domImbalanceRatio.toFixed(2)}x`,
        reasonCode: "IMB↑",
        direction: "buy",
        severity: "warn",
        confidence: clamp((domImbalanceRatio - calibration.imbalanceRatio) / calibration.imbalanceRatio, 0.45, 1),
      });
    } else if (domImbalanceRatio <= 1 / calibration.imbalanceRatio) {
      signals.push({
        id: "imbalance",
        label: "Strong Sell Pressure",
        detail: `ask/bid ${(1 / Math.max(domImbalanceRatio, 0.0001)).toFixed(2)}x`,
        reasonCode: "IMB↓",
        direction: "sell",
        severity: "warn",
        confidence: clamp(((1 / Math.max(domImbalanceRatio, 0.0001)) - calibration.imbalanceRatio) / calibration.imbalanceRatio, 0.45, 1),
      });
    }

    const hasAbsorption = footprintTotal > 0 && deltaRatio >= calibration.absorptionDeltaRatio && recentMovePct <= lowDisplacementThreshold;
    if (hasAbsorption) {
      const absorptionDirection: MarketSignalDirection = footprintDelta >= 0 ? "sell" : "buy";
      const absorptionContextBoost =
        (nearKeyLevel ? 0.12 : 0)
        + (deltaOppositePrice ? 0.1 : 0)
        + Math.min(0.08, stackedImbalanceStrength * 0.22);
      const absorptionConfidence = clamp(
        (deltaRatio - calibration.absorptionDeltaRatio) / 0.24 + absorptionContextBoost,
        0.5,
        1,
      );
      signals.push({
        id: "absorption",
        label: absorptionDirection === "sell" ? "Seller Absorbing V2" : "Buyer Absorbing V2",
        detail: `delta ${footprintDelta >= 0 ? "+" : ""}${footprintDelta.toFixed(0)} / move ${(recentMovePct * 100).toFixed(2)}%${nearKeyLevel ? " · key level" : ""}${deltaOppositePrice ? " · divergence" : ""}`,
        reasonCode: deltaOppositePrice ? "ABS↔" : absorptionDirection === "buy" ? "ABS↑" : "ABS↓",
        direction: absorptionDirection,
        severity: "critical",
        confidence: absorptionConfidence,
      });
    }

    const brokeAbove = Boolean(aboveLiquidity && lastCandle && lastCandle.high > aboveLiquidity.level * (1 + calibration.breakoutPct));
    const brokeBelow = Boolean(belowLiquidity && lastCandle && lastCandle.low < belowLiquidity.level * (1 - calibration.breakoutPct));
    const absorptionSignal = signals.find((signal) => signal.id === "absorption") || null;
    if (absorptionSignal && brokeAbove && absorptionSignal.direction === "sell") {
      signals.push({
        id: "fake-breakout",
        label: "Fake Breakout Up",
        detail: `break above ${aboveLiquidity?.level.toFixed(2) || "level"} then absorb`,
        reasonCode: "TRAP!",
        direction: "sell",
        severity: "critical",
        confidence: clamp(absorptionSignal.confidence + 0.12, 0.55, 1),
      });
    } else if (absorptionSignal && brokeBelow && absorptionSignal.direction === "buy") {
      signals.push({
        id: "fake-breakout",
        label: "Fake Breakout Down",
        detail: `break below ${belowLiquidity?.level.toFixed(2) || "level"} then absorb`,
        reasonCode: "TRAP!",
        direction: "buy",
        severity: "critical",
        confidence: clamp(absorptionSignal.confidence + 0.12, 0.55, 1),
      });
    }

    if (lastCandle && prevCandle && aboveLiquidity) {
      const sweptAbove = lastCandle.high > aboveLiquidity.level * (1 + calibration.trapSweepPct);
      const rejectedAbove = lastCandle.close < aboveLiquidity.level && prevCandle.close <= aboveLiquidity.level * (1 + calibration.breakoutPct * 0.82);
      const rejectionMovePct = lastCandle.high > 0 ? Math.abs((lastCandle.high - lastCandle.close) / lastCandle.high) : 0;
      const fastRejection = rejectionMovePct >= Math.max(chartAtrLocalPct * 0.26, calibration.breakoutPct * 0.9);
      const absorptionAfterBreakout = Boolean(absorptionSignal && absorptionSignal.direction === "sell");
      if (sweptAbove && rejectedAbove) {
        signals.push({
          id: "liquidity-trap",
          label: "Liquidity Trap Above V2",
          detail: `sweep ${aboveLiquidity.level.toFixed(2)} then reject${fastRejection ? " fast" : ""}${absorptionAfterBreakout ? " + absorb" : ""}`,
          reasonCode: "TRAP!",
          direction: "sell",
          severity: "critical",
          confidence: clamp(0.68 + (fastRejection ? 0.14 : 0) + Math.min(0.1, stackedImbalanceStrength * 0.28) + (absorptionAfterBreakout ? 0.12 : 0), 0.62, 0.97),
        });
      }
    }
    if (lastCandle && prevCandle && belowLiquidity) {
      const sweptBelow = lastCandle.low < belowLiquidity.level * (1 - calibration.trapSweepPct);
      const rejectedBelow = lastCandle.close > belowLiquidity.level && prevCandle.close >= belowLiquidity.level * (1 - calibration.breakoutPct * 0.82);
      const rejectionMovePct = lastCandle.low > 0 ? Math.abs((lastCandle.close - lastCandle.low) / lastCandle.low) : 0;
      const fastRejection = rejectionMovePct >= Math.max(chartAtrLocalPct * 0.26, calibration.breakoutPct * 0.9);
      const absorptionAfterBreakout = Boolean(absorptionSignal && absorptionSignal.direction === "buy");
      if (sweptBelow && rejectedBelow) {
        signals.push({
          id: "liquidity-trap",
          label: "Liquidity Trap Below V2",
          detail: `sweep ${belowLiquidity.level.toFixed(2)} then reject${fastRejection ? " fast" : ""}${absorptionAfterBreakout ? " + absorb" : ""}`,
          reasonCode: "TRAP!",
          direction: "buy",
          severity: "critical",
          confidence: clamp(0.68 + (fastRejection ? 0.14 : 0) + Math.min(0.1, stackedImbalanceStrength * 0.28) + (absorptionAfterBreakout ? 0.12 : 0), 0.62, 0.97),
        });
      }
    }

    const candleVolumes = chartCandles
      .slice(-12)
      .map((candle) => toNumber((candle as unknown as JsonMap).volume, NaN))
      .filter((volume) => Number.isFinite(volume) && volume > 0);
    const lastVolume = candleVolumes[candleVolumes.length - 1] || 0;
    const avgVolume = average(candleVolumes.slice(0, -1));
    const volumeDrop = lastVolume > 0 && avgVolume > 0 && lastVolume < avgVolume * 0.62;
    const tapeAbsDelta = activeTape.map((item) => Math.abs(toNumber(item.delta, 0))).filter((value) => value > 0);
    const recentTapeDeltaAbs = average(tapeAbsDelta.slice(-3));
    const baselineTapeDeltaAbs = average(tapeAbsDelta.slice(-9, -3).length > 0 ? tapeAbsDelta.slice(-9, -3) : tapeAbsDelta);
    const deltaDrop = recentTapeDeltaAbs > 0 && baselineTapeDeltaAbs > 0 && recentTapeDeltaAbs < baselineTapeDeltaAbs * 0.55;
    const priceStillMoving = recentMovePct >= Math.max(chartAtrLocalPct * 0.34, 0.0012);
    if (volumeDrop && deltaDrop && priceStillMoving) {
      const exhaustionDirection: MarketSignalDirection = recentMove > 0 ? "sell" : recentMove < 0 ? "buy" : "neutral";
      if (exhaustionDirection !== "neutral") {
        const exhaustionConfidence = clamp(
          0.6
          + (deltaOppositePrice ? 0.2 : 0)
          + (nearKeyLevel ? 0.08 : 0)
          + Math.min(0.1, stackedImbalanceStrength * 0.24),
          0.52,
          0.94,
        );
        signals.push({
          id: "exhaustion",
          label: exhaustionDirection === "sell" ? "Buyers Exhausted" : "Sellers Exhausted",
          detail: `vol drop ${(lastVolume / Math.max(1, avgVolume)).toFixed(2)}x · delta drop ${(recentTapeDeltaAbs / Math.max(1, baselineTapeDeltaAbs)).toFixed(2)}x${deltaOppositePrice ? " · divergence" : ""}`,
          reasonCode: deltaOppositePrice ? "EXH↔" : exhaustionDirection === "buy" ? "EXH↑" : "EXH↓",
          direction: exhaustionDirection,
          severity: deltaOppositePrice ? "critical" : "warn",
          confidence: exhaustionConfidence,
        });
      }
    }

    const moveDirection: MarketSignalDirection = recentMove > 0 ? "buy" : recentMove < 0 ? "sell" : "neutral";
    if (
      moveDirection !== "neutral"
      && deltaRatio >= calibration.continuationDeltaRatio
      && recentMovePct >= continuationThreshold
      && Math.sign(recentMove) === Math.sign(footprintDelta)
    ) {
      signals.push({
        id: "continuation",
        label: moveDirection === "buy" ? "Momentum Continuation Up" : "Momentum Continuation Down",
        detail: `delta sync ${(deltaRatio * 100).toFixed(0)}%`,
        reasonCode: moveDirection === "buy" ? "CONT↑" : "CONT↓",
        direction: moveDirection,
        severity: "info",
        confidence: clamp((deltaRatio - calibration.continuationDeltaRatio) / 0.26, 0.45, 1),
      });
    }

    const weightedScore = signals.reduce((score, signal) => {
      const weight =
        signal.id === "imbalance" ? 18
          : signal.id === "absorption" ? 21
            : signal.id === "fake-breakout" ? 18
              : signal.id === "liquidity-trap" ? 22
                : signal.id === "exhaustion" ? 19
                : 16;
      if (signal.direction === "buy") {
        return score + weight * signal.confidence;
      }
      if (signal.direction === "sell") {
        return score - weight * signal.confidence;
      }
      return score;
    }, 0);

    const buyPressurePct = clamp(50 + weightedScore, 0, 100);
    const sellPressurePct = 100 - buyPressurePct;
    const directionalLongPct = Math.round(buyPressurePct);
    const directionalShortPct = Math.round(sellPressurePct);
    const directionalConfidencePct = Math.round(Math.max(buyPressurePct, sellPressurePct));
    const directionalConfidenceLabel: MarketSignalSnapshot["directionalConfidenceLabel"] =
      directionalConfidencePct >= 72 ? "HIGH"
        : directionalConfidencePct >= 61 ? "MEDIUM"
          : "LOW";
    const conviction = Math.abs(buyPressurePct - 50);
    const dominantDirection: MarketSignalDirection =
      buyPressurePct >= 56 ? "buy"
        : buyPressurePct <= 44 ? "sell"
          : "neutral";

    const headline =
      dominantDirection === "buy" ? `Strong Buy Pressure ${buyPressurePct.toFixed(0)}%`
        : dominantDirection === "sell" ? `Strong Sell Pressure ${sellPressurePct.toFixed(0)}%`
          : `Balanced Flow ${buyPressurePct.toFixed(0)} / ${sellPressurePct.toFixed(0)}`;

    const convictionLabel =
      conviction >= 22 ? "high conviction"
        : conviction >= 12 ? "moderate conviction"
          : "low conviction";

    const focusMode = signals.some((signal) => signal.severity === "critical") || conviction >= 12;
    const sortedSignals = signals
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 4);
    const criticalSignals = sortedSignals.filter((signal) => signal.severity === "critical");

    return {
      buyPressurePct,
      sellPressurePct,
      directionalLongPct,
      directionalShortPct,
      directionalConfidencePct,
      directionalConfidenceLabel,
      dominantDirection,
      headline,
      convictionLabel,
      focusMode,
      calibrationLabel: calibration.label,
      criticalSignalCount: criticalSignals.length,
      criticalSignalIds: criticalSignals.map((signal) => signal.id),
      signals: sortedSignals,
    };
  }, [activeDomLevels, activeFootprintRows, activePrice, chartAtrLocalPct, chartCandles, chartPriceStep, chartSeries, chartSignalComputationEnabled, chartTimeframe, liquidityZones, selectedChartSymbol]);
  const selfLearningComputationEnabled = chartSignalComputationEnabled && selfLearningV4Enabled;
  const selfLearningRegimeV4 = useMemo<LearningRegimeV4>(() => {
    if (!selfLearningComputationEnabled) {
      return "chop";
    }
    const points = chartSeries.slice(-24);
    if (points.length < 8) {
      return "chop";
    }
    const prices = points.map((point) => point.value).filter((value) => Number.isFinite(value) && value > 0);
    if (prices.length < 8) {
      return "chop";
    }
    const returns: number[] = [];
    for (let index = 1; index < prices.length; index += 1) {
      const prev = prices[index - 1];
      const next = prices[index];
      returns.push((next - prev) / Math.max(0.0000001, prev));
    }
    const vol = Math.sqrt(average(returns.map((value) => value * value)));
    const xMean = (prices.length - 1) / 2;
    const yMean = average(prices);
    let num = 0;
    let den = 0;
    for (let index = 0; index < prices.length; index += 1) {
      const dx = index - xMean;
      num += dx * (prices[index] - yMean);
      den += dx * dx;
    }
    const slopePct = yMean > 0 ? Math.abs((num / Math.max(1, den)) / yMean) : 0;
    if (vol >= 0.0045 && slopePct <= 0.0009) {
      return "volatile";
    }
    if (slopePct >= 0.0018) {
      return "trend";
    }
    return "chop";
  }, [chartSeries, selfLearningComputationEnabled]);
  const selfLearningScenarioHint: MarketDecisionScenario = !selfLearningComputationEnabled
    ? "balance"
    : marketSignalV1.signals.some((signal) => signal.id === "continuation")
      ? "continuation"
      : marketSignalV1.signals.some((signal) => signal.id === "absorption" || signal.id === "fake-breakout" || signal.id === "liquidity-trap" || signal.id === "exhaustion")
        ? "reversal"
        : "balance";
  const selfLearningProfile = !selfLearningComputationEnabled
    ? signalHistoricalLearningBundle.mixed
    : signalHistoricalLearningBundle.byScenario[selfLearningScenarioHint] || signalHistoricalLearningBundle.mixed;
  const selfLearningRegimeTemplate: MarketConfluenceWeights = selfLearningRegimeV4 === "trend"
    ? { dom: 1.18, footprint: 1.04, liquidity: 0.88, "price-action": 1.22 }
    : selfLearningRegimeV4 === "chop"
      ? { dom: 0.9, footprint: 1.15, liquidity: 1.2, "price-action": 0.88 }
      : { dom: 0.82, footprint: 1.2, liquidity: 1.24, "price-action": 0.94 };
  const selfLearningAdaptiveWeights: MarketConfluenceWeights = !selfLearningComputationEnabled
    ? { dom: 1, footprint: 1, liquidity: 1, "price-action": 1 }
    : {
      dom: clamp(selfLearningProfile.learnedWeights.dom * selfLearningRegimeTemplate.dom, 0.72, 1.55),
      footprint: clamp(selfLearningProfile.learnedWeights.footprint * selfLearningRegimeTemplate.footprint, 0.72, 1.6),
      liquidity: clamp(selfLearningProfile.learnedWeights.liquidity * selfLearningRegimeTemplate.liquidity, 0.72, 1.62),
      "price-action": clamp(selfLearningProfile.learnedWeights["price-action"] * selfLearningRegimeTemplate["price-action"], 0.72, 1.58),
    };
  const selfLearningEffectiveWeights: MarketConfluenceWeights = selfLearningComputationEnabled && selfLearningAutoAdaptEnabled
    ? {
      dom: clamp(confluenceWeights.dom * selfLearningAdaptiveWeights.dom, 0.2, 2.4),
      footprint: clamp(confluenceWeights.footprint * selfLearningAdaptiveWeights.footprint, 0.2, 2.4),
      liquidity: clamp(confluenceWeights.liquidity * selfLearningAdaptiveWeights.liquidity, 0.2, 2.4),
      "price-action": clamp(confluenceWeights["price-action"] * selfLearningAdaptiveWeights["price-action"], 0.2, 2.4),
    }
    : { ...confluenceWeights };

  var marketDecisionV1 = useMemo<MarketDecisionSnapshot>(() => {
    if (!chartSignalComputationEnabled) {
      return {
        scenario: "balance",
        scenarioLabel: "Signal standby",
        scenarioProbabilityPct: 50,
        probableReversalZone: null,
        probableReversalZoneLabel: "No reversal zone",
        globalConfidencePct: 44,
        biasDirection: "neutral",
        criticalConfirmed: false,
        evidence: [
          { id: "dom", label: "DOM", scorePct: 0, direction: "neutral", detail: "suspended while chart is partial" },
          { id: "footprint", label: "Footprint", scorePct: 0, direction: "neutral", detail: "suspended while chart is partial" },
          { id: "liquidity", label: "Liquidity", scorePct: 0, direction: "neutral", detail: "waiting for renderable candles" },
          { id: "price-action", label: "Price", scorePct: 0, direction: "neutral", detail: "waiting for renderable candles" },
        ],
        confluenceScorePct: 0,
        actionTitle: "Wait for renderable candles",
        actionBody: "DOM, footprint and confluence calculations stay paused until the chart returns to a renderable state.",
        suggestedBracket: null,
        historicalLearning: signalHistoricalLearning,
        executionPlan: {
          snapPriority: "vwap",
          preset: chartTimeframe === "15m" ? "swing" : "scalp",
          guardEnabled: true,
        },
      };
    }

    const topSignal = marketSignalV1.signals[0] || null;
    const hasAbsorption = marketSignalV1.criticalSignalIds.includes("absorption");
    const hasTrap = marketSignalV1.criticalSignalIds.includes("liquidity-trap");
    const hasFakeBreakout = marketSignalV1.criticalSignalIds.includes("fake-breakout");
    const hasContinuation = marketSignalV1.signals.some((signal) => signal.id === "continuation");
    const hasImbalance = marketSignalV1.signals.some((signal) => signal.id === "imbalance");
    const criticalConfirmed = marketSignalV1.criticalSignalCount >= 2 && hasAbsorption && (hasTrap || hasFakeBreakout);

    const bidDepth = activeDomLevels
      .filter((level) => level.side === "bid")
      .reduce((sum, level) => sum + Math.max(0, level.size), 0);
    const askDepth = activeDomLevels
      .filter((level) => level.side === "ask")
      .reduce((sum, level) => sum + Math.max(0, level.size), 0);
    const domRatio = (bidDepth + 1) / (askDepth + 1);
    const domDirection: MarketSignalDirection = domRatio >= 1.06 ? "buy" : domRatio <= 0.94 ? "sell" : "neutral";
    const domScorePct = Math.round(clamp(Math.abs(Math.log(domRatio)) * 72, 8, 96));

    const footprintBuy = activeFootprintRows.reduce((sum, row) => sum + Math.max(0, row.buyVolume), 0);
    const footprintSell = activeFootprintRows.reduce((sum, row) => sum + Math.max(0, row.sellVolume), 0);
    const footprintTotal = footprintBuy + footprintSell;
    const footprintDelta = footprintBuy - footprintSell;
    const footprintRatio = footprintTotal > 0 ? Math.abs(footprintDelta) / footprintTotal : 0;
    const footprintDirection: MarketSignalDirection = footprintDelta > 0 ? "buy" : footprintDelta < 0 ? "sell" : "neutral";
    const footprintScorePct = Math.round(clamp(footprintRatio * 220, 6, 95));

    const recentPoints = chartSeries.slice(-8);
    const firstRecent = recentPoints[0]?.value ?? activePrice;
    const lastRecent = recentPoints[recentPoints.length - 1]?.value ?? activePrice;
    const recentMove = lastRecent - firstRecent;
    const recentMovePct = firstRecent > 0 ? Math.abs(recentMove) / firstRecent : 0;
    const priceActionDirection: MarketSignalDirection = recentMove > 0 ? "buy" : recentMove < 0 ? "sell" : "neutral";
    const priceActionScorePct = Math.round(clamp((chartAtrLocalPct > 0 ? recentMovePct / chartAtrLocalPct : 0.35) * 42, 8, 94));

    const aboveLiquidity = liquidityZones
      .filter((zone) => zone.level > activePrice)
      .sort((a, b) => a.level - b.level)[0] || null;
    const belowLiquidity = liquidityZones
      .filter((zone) => zone.level < activePrice)
      .sort((a, b) => b.level - a.level)[0] || null;
    const nearestLiquidity = [aboveLiquidity, belowLiquidity]
      .filter((zone): zone is LiquidityZone => Boolean(zone))
      .sort((a, b) => Math.abs(a.level - activePrice) - Math.abs(b.level - activePrice))[0] || null;
    const liquidityDirection: MarketSignalDirection =
      hasTrap || hasFakeBreakout
        ? (topSignal?.direction || marketSignalV1.dominantDirection)
        : nearestLiquidity && nearestLiquidity.level > activePrice ? "buy" : nearestLiquidity && nearestLiquidity.level < activePrice ? "sell" : "neutral";
    const liquidityScorePct = Math.round(clamp(
      (hasTrap || hasFakeBreakout ? 78 : 42)
      + (nearestLiquidity ? Math.max(0, 22 - Math.abs(nearestLiquidity.level - activePrice) / Math.max(chartPriceStep, activePrice * 0.0004)) : 0),
      12,
      95,
    ));

    const evidence: MarketEvidenceComponent[] = [
      { id: "dom", label: "DOM", scorePct: domScorePct, direction: domDirection, detail: `depth ${domRatio.toFixed(2)}x` },
      { id: "footprint", label: "Footprint", scorePct: footprintScorePct, direction: footprintDirection, detail: `delta ${footprintDelta >= 0 ? "+" : ""}${footprintDelta.toFixed(0)}` },
      { id: "liquidity", label: "Liquidity", scorePct: liquidityScorePct, direction: liquidityDirection, detail: nearestLiquidity ? `near ${nearestLiquidity.level.toFixed(2)}` : "no nearby pool" },
      { id: "price-action", label: "Price", scorePct: priceActionScorePct, direction: priceActionDirection, detail: `${recentMove >= 0 ? "+" : ""}${(recentMovePct * 100).toFixed(2)}%` },
    ];
    const resolveScenario = (confluenceScorePct: number): { scenario: MarketDecisionScenario; scenarioLabel: string; scenarioProbabilityPct: number } => {
      let scenario: MarketDecisionScenario = "balance";
      let scenarioLabel = "Balanced auction";
      let scenarioProbabilityPct = Math.round(clamp(confluenceScorePct * 0.52 + Math.abs(marketSignalV1.buyPressurePct - 50) * 0.6, 48, 90));
      if (criticalConfirmed) {
        scenario = "reversal";
        scenarioLabel = "Probable reversal zone";
        scenarioProbabilityPct = Math.round(clamp(64 + confluenceScorePct * 0.22 + marketSignalV1.criticalSignalCount * 6, 68, 94));
      } else if (hasContinuation && hasImbalance && marketSignalV1.dominantDirection !== "neutral") {
        scenario = "continuation";
        scenarioLabel = marketSignalV1.dominantDirection === "buy" ? "Continuation haussiere probable" : "Continuation baissiere probable";
        scenarioProbabilityPct = Math.round(clamp(56 + confluenceScorePct * 0.3 + Math.abs(marketSignalV1.buyPressurePct - 50) * 0.28, 62, 90));
      }
      return { scenario, scenarioLabel, scenarioProbabilityPct };
    };
    const computeConfluence = (learning: MarketHistoricalLearning): number => {
      const effectiveWeights = evidence.reduce((acc, item) => {
        acc[item.id] = Math.max(0.2, selfLearningEffectiveWeights[item.id] * learning.learnedWeights[item.id]);
        return acc;
      }, {} as MarketConfluenceWeights);
      const weightSum = evidence.reduce((sum, item) => sum + effectiveWeights[item.id], 0);
      return Math.round(evidence.reduce((sum, item) => {
        const weight = effectiveWeights[item.id];
        return sum + item.scorePct * weight;
      }, 0) / Math.max(1, weightSum));
    };
    const baselineScore = computeConfluence(signalHistoricalLearning);
    const provisionalScenario = resolveScenario(baselineScore);
    const provisionalLearning = signalHistoricalLearningBundle.byScenario[provisionalScenario.scenario] || signalHistoricalLearning;
    const firstPassConfluence = computeConfluence(provisionalLearning);
    const firstPassScenario = resolveScenario(firstPassConfluence);
    const scenarioLearning = signalHistoricalLearningBundle.byScenario[firstPassScenario.scenario] || provisionalLearning;
    const confluenceScorePct = computeConfluence(scenarioLearning);
    const { scenario, scenarioLabel, scenarioProbabilityPct } = resolveScenario(confluenceScorePct);
    const selectedLearning = signalHistoricalLearningBundle.byScenario[scenario] || scenarioLearning;

    const probableReversalZone = (() => {
      if (liquidityZones.length === 0) {
        return null;
      }
      if (scenario === "reversal") {
        if (marketSignalV1.dominantDirection === "buy") {
          return liquidityZones.filter((zone) => zone.level < activePrice).sort((a, b) => b.level - a.level)[0]?.level ?? null;
        }
        if (marketSignalV1.dominantDirection === "sell") {
          return liquidityZones.filter((zone) => zone.level > activePrice).sort((a, b) => a.level - b.level)[0]?.level ?? null;
        }
      }
      return liquidityZones.reduce((closest, zone) => {
        if (closest === null) {
          return zone.level;
        }
        return Math.abs(zone.level - activePrice) < Math.abs(closest - activePrice) ? zone.level : closest;
      }, null as number | null);
    })();

    const probableReversalZoneLabel = probableReversalZone !== null
      ? `Reversal zone ${probableReversalZone.toFixed(2)}`
      : "No reversal zone";
    const globalConfidencePct = Math.round(clamp(scenarioProbabilityPct * 0.52 + confluenceScorePct * 0.3 + (topSignal?.confidence || 0.5) * 18, 44, 95));
    const biasDirection =
      scenario === "reversal"
        ? (topSignal?.direction && topSignal.direction !== "neutral" ? topSignal.direction : marketSignalV1.dominantDirection)
        : marketSignalV1.dominantDirection;
    const atrAbs = Math.max(chartPriceStep * 6, Math.max(activePrice * Math.max(chartAtrLocalPct, 0.0012), chartPriceStep * 10));
    const suggestedBracket = (() => {
      if (biasDirection === "neutral") {
        return null;
      }
      const side: MarketSuggestedBracket["side"] = biasDirection === "buy" ? "buy" : "sell";
      let entry = activePrice;
      let sl = activePrice;
      let tp = activePrice;
      if (scenario === "reversal") {
        entry = probableReversalZone ?? (side === "buy" ? (belowLiquidity?.level ?? activePrice) : (aboveLiquidity?.level ?? activePrice));
        sl = side === "buy" ? entry - atrAbs * 0.9 : entry + atrAbs * 0.9;
        tp = side === "buy"
          ? (aboveLiquidity?.level ?? entry + atrAbs * 1.9)
          : (belowLiquidity?.level ?? entry - atrAbs * 1.9);
      } else if (scenario === "continuation") {
        entry = activePrice;
        sl = side === "buy" ? entry - atrAbs * 0.8 : entry + atrAbs * 0.8;
        tp = side === "buy"
          ? (aboveLiquidity?.level ?? entry + atrAbs * 1.7)
          : (belowLiquidity?.level ?? entry - atrAbs * 1.7);
      } else {
        entry = activePrice;
        sl = side === "buy" ? entry - atrAbs * 0.75 : entry + atrAbs * 0.75;
        tp = side === "buy" ? entry + atrAbs * 1.2 : entry - atrAbs * 1.2;
      }
      const risk = side === "buy" ? Math.max(chartPriceStep, entry - sl) : Math.max(chartPriceStep, sl - entry);
      const reward = side === "buy" ? Math.max(chartPriceStep, tp - entry) : Math.max(chartPriceStep, entry - tp);
      return {
        side,
        entry: Number(entry.toFixed(chartPriceDigits)),
        sl: Number(sl.toFixed(chartPriceDigits)),
        tp: Number(tp.toFixed(chartPriceDigits)),
        rr: reward / Math.max(chartPriceStep, risk),
        label: scenario === "reversal" ? "Reversal bracket" : scenario === "continuation" ? "Continuation bracket" : "Balanced bracket",
      } satisfies MarketSuggestedBracket;
    })();

    const actionTitle = (() => {
      if (hasAbsorption && aboveLiquidity && topSignal?.direction === "sell") {
        return `Seller absorbing above ${aboveLiquidity.level.toFixed(2)}`;
      }
      if (hasAbsorption && belowLiquidity && topSignal?.direction === "buy") {
        return `Buyer absorbing below ${belowLiquidity.level.toFixed(2)}`;
      }
      if (hasTrap && aboveLiquidity) {
        return `Liquidity swept above ${aboveLiquidity.level.toFixed(2)}`;
      }
      if (hasTrap && belowLiquidity) {
        return `Liquidity swept below ${belowLiquidity.level.toFixed(2)}`;
      }
      if (hasContinuation && biasDirection === "buy") {
        return `Buy continuation through ${activePrice.toFixed(2)}`;
      }
      if (hasContinuation && biasDirection === "sell") {
        return `Sell continuation through ${activePrice.toFixed(2)}`;
      }
      return "Wait for auction confirmation";
    })();

    const actionBody = criticalConfirmed
      ? `Two critical sources aligned. Favor ${biasDirection === "buy" ? "long response" : biasDirection === "sell" ? "short response" : "selective execution"} near ${probableReversalZone !== null ? probableReversalZone.toFixed(2) : activePrice.toFixed(2)}.`
      : scenario === "continuation"
        ? `DOM and footprint are aligned. Use tighter execution and hold above ${activePrice.toFixed(2)} only if price action confirms.`
        : `Auction is mixed. Reduce aggression and wait for confirmation around ${probableReversalZone !== null ? probableReversalZone.toFixed(2) : activePrice.toFixed(2)}.`;

    const executionPlan = {
      snapPriority: scenario === "reversal" ? "liquidity" : scenario === "continuation" ? "execution" : "vwap",
      preset: scenario === "reversal" ? "low-risk" : chartTimeframe === "15m" ? "swing" : scenario === "continuation" ? "scalp" : "swing",
      guardEnabled: scenario !== "continuation" || globalConfidencePct < 78,
    } satisfies MarketDecisionSnapshot["executionPlan"];

    return {
      scenario,
      scenarioLabel,
      scenarioProbabilityPct,
      probableReversalZone,
      probableReversalZoneLabel,
      globalConfidencePct,
      biasDirection,
      criticalConfirmed,
      evidence,
      confluenceScorePct,
      actionTitle,
      actionBody,
      suggestedBracket,
      historicalLearning: selectedLearning,
      executionPlan,
    };
  }, [activeDomLevels, activeFootprintRows, activePrice, chartAtrLocalPct, chartPriceDigits, chartPriceStep, chartSeries, chartSignalComputationEnabled, chartTimeframe, liquidityZones, marketSignalV1, selfLearningEffectiveWeights, signalHistoricalLearning, signalHistoricalLearningBundle]);
  useEffect(() => {
    signalConfidenceTrailRef.current = [];
    setSignalConfidenceDrift("FLAT");
  }, [selectedChartSymbol, chartTimeframe]);
  useEffect(() => {
    const value = marketSignalV1.directionalConfidencePct;
    if (!Number.isFinite(value)) {
      return;
    }
    const nextTrail = [...signalConfidenceTrailRef.current, value].slice(-6);
    signalConfidenceTrailRef.current = nextTrail;
    if (nextTrail.length < 3) {
      setSignalConfidenceDrift("FLAT");
      return;
    }
    const driftRaw = nextTrail[nextTrail.length - 1] - nextTrail[0];
    if (driftRaw >= 2.5) {
      setSignalConfidenceDrift("UP");
    } else if (driftRaw <= -2.5) {
      setSignalConfidenceDrift("DOWN");
    } else {
      setSignalConfidenceDrift("FLAT");
    }
  }, [marketSignalV1.directionalConfidencePct]);
  useEffect(() => {
    if (!selfLearningV4Enabled || !selfLearningComputationEnabled) {
      return;
    }
    const signature = [
      selectedChartSymbol,
      chartTimeframe,
      selfLearningRegimeV4,
      selfLearningScenarioHint,
      selfLearningProfile.sampleSize,
      selfLearningProfile.winratePct.toFixed(1),
      selfLearningAutoAdaptEnabled ? "adapt" : "manual",
    ].join(":");
    if (!selfLearningModelSignatureRef.current) {
      selfLearningModelSignatureRef.current = signature;
      setSelfLearningModelUpdatedAt(new Date().toISOString());
      return;
    }
    if (selfLearningModelSignatureRef.current !== signature) {
      selfLearningModelSignatureRef.current = signature;
      setSelfLearningModelUpdatedAt(new Date().toISOString());
    }
  }, [
    chartTimeframe,
    selfLearningAutoAdaptEnabled,
    selfLearningComputationEnabled,
    selfLearningProfile.sampleSize,
    selfLearningProfile.winratePct,
    selfLearningRegimeV4,
    selfLearningScenarioHint,
    selfLearningV4Enabled,
    selectedChartSymbol,
  ]);
  useEffect(() => {
    if (!selfLearningV4Enabled || !selfLearningComputationEnabled || !selfLearningAutoAdaptEnabled || !selfLearningDriftV4.shouldDemote) {
      return;
    }
    const signature = [selectedChartSymbol, chartTimeframe, selfLearningDriftV4.signature].join(":");
    if (selfLearningDriftSignatureRef.current === signature) {
      return;
    }
    selfLearningDriftSignatureRef.current = signature;
    const nowIso = new Date().toISOString();
    setSelfLearningAutoAdaptEnabled(false);
    setSelfLearningDriftAutoDemotedAt(nowIso);
    setSelfLearningModelUpdatedAt(nowIso);
  }, [
    chartTimeframe,
    selfLearningAutoAdaptEnabled,
    selfLearningComputationEnabled,
    selfLearningDriftV4.shouldDemote,
    selfLearningDriftV4.signature,
    selfLearningV4Enabled,
    selectedChartSymbol,
  ]);
  useEffect(() => {
    if (!selfLearningV4Enabled || !selfLearningComputationEnabled || selfLearningScopedOutcomesV4.length === 0) {
      return;
    }
    const latest = selfLearningScopedOutcomesV4[0];
    const signature = [selectedChartSymbol, chartTimeframe, latest.key, latest.timestampIso].join(":");
    if (selfLearningJournalSignatureRef.current === signature) {
      return;
    }
    selfLearningJournalSignatureRef.current = signature;
    const inferScenario = (item: JsonMap): MarketDecisionScenario => {
      const text = [
        item.scenario,
        item.scenario_type,
        item.setup,
        item.pattern,
        item.tag,
        item.signal,
        item.strategy_name,
        item.strategy_id,
        item.strategy,
      ].map((value) => String(value || "").toLowerCase()).join(" ");
      if (/reversal|mean\s*reversion|fade|trap|sweep|absorption|fake\s*breakout/.test(text)) {
        return "reversal";
      }
      if (/continuation|breakout|momentum|trend|follow\s*through|impulse/.test(text)) {
        return "continuation";
      }
      return "balance";
    };
    const regime: LearningRegimeV4 = latest.regimeRaw.includes("trend")
      ? "trend"
      : latest.regimeRaw.includes("vol")
        ? "volatile"
        : latest.regimeRaw.includes("chop") || latest.regimeRaw.includes("range")
          ? "chop"
          : selfLearningRegimeV4;
    setSelfLearningJournalV4Trail((current) => {
      if (current.some((event) => event.id === latest.key)) {
        return current;
      }
      return [
        {
          id: latest.key,
          timestampIso: latest.timestampIso,
          symbol: selectedChartSymbol,
          timeframe: chartTimeframe,
          regime,
          scenario: inferScenario(latest.raw),
          outcome: (latest.win ? "win" : "loss") as "win" | "loss",
          pnl: latest.pnl,
          mfe: latest.mfe,
          mae: latest.mae,
          weights: {
            dom: selfLearningEffectiveWeights.dom,
            footprint: selfLearningEffectiveWeights.footprint,
            liquidity: selfLearningEffectiveWeights.liquidity,
            "price-action": selfLearningEffectiveWeights["price-action"],
          },
        },
        ...current,
      ].slice(0, 240);
    });
  }, [
    chartTimeframe,
    selfLearningComputationEnabled,
    selfLearningEffectiveWeights,
    selfLearningRegimeV4,
    selfLearningScopedOutcomesV4,
    selfLearningV4Enabled,
    selectedChartSymbol,
  ]);
  useEffect(() => {
    if (!selfLearningComputationEnabled) {
      return;
    }
    if (typeof window === "undefined") {
      return;
    }
    const scope = {
      accountId: accountId || "default",
      symbol: selectedChartSymbol || "BTCUSD",
      timeframe: chartTimeframe || "1m",
    };
    const scopeKey = [scope.accountId, scope.symbol, scope.timeframe].join(":");
    if (!selfLearningBackendReadyRef.current || selfLearningBackendScopeRef.current !== scopeKey) {
      return;
    }
    const timer = window.setTimeout(() => {
      void saveSelfLearningV4State({
        accountId: scope.accountId,
        symbol: scope.symbol,
        timeframe: scope.timeframe,
        enabled: selfLearningV4Enabled,
        autoAdaptEnabled: selfLearningAutoAdaptEnabled,
        modelUpdatedAt: selfLearningModelUpdatedAt,
        driftAutoDemotedAt: selfLearningDriftAutoDemotedAt,
        filters: {
          regime: selfLearningJournalV4RegimeFilter,
          scenario: selfLearningJournalV4ScenarioFilter,
        },
        snapshot: {
          regime: selfLearningRegimeV4,
          scenarioHint: selfLearningScenarioHint,
          active: selfLearningV4Active,
          profile: selfLearningProfile,
          adaptiveWeights: selfLearningAdaptiveWeights,
          effectiveWeights: selfLearningEffectiveWeights,
          drift: {
            status: selfLearningV4DriftLabel,
            shortSamples: selfLearningDriftV4.shortSamples,
            longSamples: selfLearningDriftV4.longSamples,
            shortWinratePct: selfLearningDriftV4.shortWinratePct,
            longWinratePct: selfLearningDriftV4.longWinratePct,
            winrateDropPct: selfLearningDriftV4.winrateDropPct,
            shortBrier: selfLearningDriftV4.shortBrier,
            longBrier: selfLearningDriftV4.longBrier,
            brierRise: selfLearningDriftV4.brierRise,
            shortLossCount: selfLearningDriftV4.shortLossCount,
            enoughSamples: selfLearningDriftV4.enoughSamples,
            shouldDemote: selfLearningDriftV4.shouldDemote,
            signature: selfLearningDriftV4.signature,
          },
        },
        journal: selfLearningJournalV4Trail,
      }).then((result) => {
        setSelfLearningV4PersistenceStatus((current) => ({
          ...current,
          storage: result.storage,
          healthy: true,
          stateSavedAt: result.updatedAt || new Date().toISOString(),
          message: "state-saved",
        }));
      }).catch(() => {
        setSelfLearningV4PersistenceStatus((current) => ({
          ...current,
          healthy: false,
          message: "state-save-failed",
        }));
      });
    }, 650);
    return () => {
      window.clearTimeout(timer);
    };
  }, [accountId, chartTimeframe, selectedChartSymbol, selfLearningAdaptiveWeights, selfLearningAutoAdaptEnabled, selfLearningComputationEnabled, selfLearningDriftAutoDemotedAt, selfLearningDriftV4, selfLearningEffectiveWeights, selfLearningJournalV4RegimeFilter, selfLearningJournalV4ScenarioFilter, selfLearningJournalV4Trail, selfLearningModelUpdatedAt, selfLearningProfile, selfLearningRegimeV4, selfLearningScenarioHint, selfLearningV4Active, selfLearningV4DriftLabel, selfLearningV4Enabled]);
  useEffect(() => {
    let cancelled = false;
    if (authSessionRequired) {
      setSelfLearningV4ScopeSummaries([]);
      setSelfLearningV4PersistenceStatus((current) => ({
        ...current,
        healthy: true,
        message: "scopes-unauthorized",
      }));
      return () => {
        cancelled = true;
      };
    }
    const loadScopes = async () => {
      if (shouldPauseNonEssentialRefresh()) {
        return;
      }
      try {
        const result = await fetchSelfLearningV4Scopes({
          accountId: accountId || "default",
          limit: 180,
        });
        if (cancelled) {
          return;
        }
        setSelfLearningV4ScopeSummaries(result.items);
        setSelfLearningV4PersistenceStatus((current) => ({
          ...current,
          storage: result.storage === "unknown" ? current.storage : result.storage,
          healthy: true,
          scopesLoadedAt: new Date().toISOString(),
          scopeCount: result.items.length,
          message: "scopes-loaded",
        }));
      } catch {
        if (cancelled) {
          return;
        }
        setSelfLearningV4PersistenceStatus((current) => ({
          ...current,
          healthy: false,
          message: "scopes-load-failed",
        }));
      }
    };
    void loadScopes();
    const intervalMs = isGtixPublicBrowserHost() ? PUBLIC_TERMINAL_GOVERNANCE_REFRESH_MS : 45000;
    const timer = window.setInterval(() => {
      void loadScopes();
    }, intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [accountId, authSessionRequired]);
  useEffect(() => {
    if (!marketDecisionV1.criticalConfirmed) {
      return;
    }
    const signature = [selectedChartSymbol, chartTimeframe, marketDecisionV1.scenario, marketSignalV1.criticalSignalIds.join("+"), marketDecisionV1.probableReversalZone?.toFixed(2) || "na"].join(":");
    if (signalAlertSignatureRef.current === signature) {
      return;
    }
    signalAlertSignatureRef.current = signature;
    setSignalAlertBadgeCount((count) => count + 1);
    setSignalActionToast({
      key: signature,
      title: marketDecisionV1.scenario === "reversal" ? "Critical reversal setup" : "Critical market setup",
      detail: `${marketSignalV1.criticalSignalIds.join(" + ")} confirmed on ${selectedChartSymbol} ${chartTimeframe}`,
      direction: marketDecisionV1.biasDirection,
      zoneLabel: marketDecisionV1.probableReversalZoneLabel,
      critical: true,
    });
  }, [chartTimeframe, marketDecisionV1, marketSignalV1.criticalSignalIds, selectedChartSymbol]);
  useEffect(() => {
    if (!signalActionToast) {
      return;
    }
    const timer = window.setTimeout(() => setSignalActionToast(null), 5200);
    return () => window.clearTimeout(timer);
  }, [signalActionToast]);
  useEffect(() => {
    if (replayState.enabled) {
      return;
    }
    const plan = marketDecisionV1.executionPlan;
    const signature = [selectedChartSymbol, chartTimeframe, marketDecisionV1.scenario, plan.snapPriority, plan.preset, plan.guardEnabled ? "guard-on" : "guard-off"].join(":");
    if (executionAdaptationSignatureRef.current === signature) {
      return;
    }
    executionAdaptationSignatureRef.current = signature;
    if (executionAdaptMode === "manual") {
      setPendingExecutionAdaptation(null);
      return;
    }
    if (executionAdaptMode === "confirm") {
      setPendingExecutionAdaptation({ signature, plan });
      return;
    }
    setPendingExecutionAdaptation(null);
    applyExecutionAdaptationPlan(plan);
  }, [chartTimeframe, executionAdaptMode, marketDecisionV1, replayState.enabled, selectedChartSymbol]);
  useEffect(() => {
    if (!autoSymbolLoss.overCap || autoSymbolLoss.localDisabled) {
      return;
    }
    setAutoSymbolAutoDisabled((current) => {
      if (current[autoSymbolLoss.normalizedSymbol]) {
        return current;
      }
      return {
        ...current,
        [autoSymbolLoss.normalizedSymbol]: new Date().toISOString(),
      };
    });
  }, [autoSymbolLoss.localDisabled, autoSymbolLoss.normalizedSymbol, autoSymbolLoss.overCap]);
  useEffect(() => {
    if (autoExecutionMode === "assisted") {
      return;
    }
    const v7Decision = getV7ExecutionDecision();
    const signature = [
      selectedChartSymbol,
      chartTimeframe,
      autoExecutionMode,
      autoExecutionGate.autoState,
      autoExecutionGate.ruleLabel,
      autoMetaFilter.pass ? "m1" : "m0",
      autoRiskEngine.hardPass ? "r1" : "r0",
      autoSessionGuard.pass ? "s1" : "s0",
      autoSymbolLoss.pass ? "l1" : "l0",
      autoExecutionKillSwitch ? "k1" : "k0",
      autoSizingV3.finalNotional.toFixed(0),
      v7Decision.routeMode,
      v7Decision.shouldExecute ? "v71" : "v70",
      v7Decision.expectedNetEdgeBps.toFixed(2),
    ].join(":");
    if (autoExecutionAuditSignatureRef.current === signature) {
      return;
    }
    autoExecutionAuditSignatureRef.current = signature;
    const reasons: string[] = [];
    if (!autoMetaFilter.pass) reasons.push("meta");
    if (!autoRiskEngine.hardPass) reasons.push("risk");
    if (!autoSessionGuard.pass) reasons.push(`session:${autoSessionGuard.label}`);
    if (!autoSymbolLoss.pass) reasons.push("symbol-loss-cap");
    if (autoRiskEngine.killSwitchActive) reasons.push("kill-switch");
    if (!autoEntryReady) reasons.push("entry-not-ready");
    if (v7Decision.routeMode === "dualVenueExecution" && !v7Decision.shouldExecute) {
      reasons.push(...v7Decision.reasons.map((reason) => `v7:${reason}`));
    }
    setAutoExecutionAuditTrail((current) => [
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestampIso: new Date().toISOString(),
        symbol: selectedChartSymbol,
        timeframe: chartTimeframe,
        mode: autoExecutionMode,
        gateState: autoExecutionGate.autoState as "READY" | "BLOCKED" | "KILLED",
        metaPass: autoMetaFilter.pass,
        riskPass: autoRiskEngine.hardPass,
        sessionPass: autoSessionGuard.pass,
        symbolLossPass: autoSymbolLoss.pass,
        killSwitch: autoRiskEngine.killSwitchActive,
        sizeUsd: autoSizingV3.finalNotional,
        qualityScore: autoMetaFilter.qualityScore,
        reasons,
      },
      ...current,
    ].slice(0, 80));
  }, [
    autoEntryReady,
    autoExecutionGate.autoState,
    autoExecutionGate.ruleLabel,
    autoExecutionKillSwitch,
    autoExecutionMode,
    autoMetaFilter.pass,
    autoMetaFilter.qualityScore,
    autoRiskEngine.hardPass,
    autoRiskEngine.killSwitchActive,
    autoSessionGuard.label,
    autoSessionGuard.pass,
    autoSizingV3.finalNotional,
    autoSymbolLoss.pass,
    chartTimeframe,
    selectedChartSymbol,
    executionTelemetry,
    filteredOutcomes,
    marketMicro,
    notional,
    routingScore,
  ]);
  useEffect(() => {
    if (replayState.enabled || autoExecutionMode === "assisted" || autoExecutionKillSwitch) {
      return;
    }
    if (!marketDecisionV1.suggestedBracket) {
      return;
    }
    const baseSignature = [
      selectedChartSymbol,
      chartTimeframe,
      marketDecisionV1.scenario,
      marketDecisionV1.suggestedBracket.side,
      marketDecisionV1.suggestedBracket.entry.toFixed(chartPriceDigits),
      marketDecisionV1.suggestedBracket.sl.toFixed(chartPriceDigits),
      marketDecisionV1.suggestedBracket.tp.toFixed(chartPriceDigits),
      autoExecutionGate.autoState,
      autoExecutionGate.ruleLabel,
    ].join(":");

    if (autoExecutionMode === "semi-auto") {
      if (!autoExecutionGate.ready) {
        return;
      }
      if (autoExecutionSignatureRef.current === baseSignature) {
        return;
      }
      autoExecutionSignatureRef.current = baseSignature;
      applySuggestedScenarioBracket(marketDecisionV1.suggestedBracket);
      applyExecutionAdaptationPlan(marketDecisionV1.executionPlan);
      return;
    }

    if (!autoExecutionGate.ready || autoExecutionMode !== "full-auto") {
      return;
    }
    const v7Decision = getV7ExecutionDecision();
    if (v7Decision.routeMode === "dualVenueExecution" && !v7Decision.shouldExecute) {
      return;
    }
    const now = Date.now();
    if (now - autoExecutionLastAtRef.current < 45000) {
      return;
    }
    const stagedSignature = `${baseSignature}:${chartHudConfirmArmed ? "armed" : "cold"}`;
    if (autoExecutionSignatureRef.current === stagedSignature) {
      return;
    }
    autoExecutionSignatureRef.current = stagedSignature;
    void (async () => {
      if (v7Decision.routeMode === "dualVenueExecution") {
        const ack = chartEffectiveSendMode !== "confirm-required" || chartHudConfirmArmed;
        await executeV7ArbOpportunity(v7Decision, ack);
      } else {
        await approveAllAndSend();
      }
      if (chartHudConfirmArmed || chartEffectiveSendMode !== "confirm-required") {
        autoExecutionLastAtRef.current = Date.now();
      }
    })();
  }, [
    approveAllAndSend,
    autoExecutionGate.autoState,
    autoExecutionGate.ready,
    autoExecutionGate.ruleLabel,
    autoExecutionKillSwitch,
    autoExecutionMode,
    chartEffectiveSendMode,
    chartHudConfirmArmed,
    chartPriceDigits,
    chartTimeframe,
    executeV7ArbOpportunity,
    marketDecisionV1.executionPlan,
    marketDecisionV1.scenario,
    marketDecisionV1.suggestedBracket,
    replayState.enabled,
    selectedChartSymbol,
    executionTelemetry,
    filteredOutcomes,
    marketMicro,
    notional,
    routingScore,
  ]);
  const strictDepthTimeMatch = replayState.enabled
    ? Boolean(replayFrame && activeTimeKey && replayFrame.timeKey === activeTimeKey)
    : Boolean(activeTimeKey && depthTimeKey && activeTimeKey === depthTimeKey);
  const timeSyncDiagnostics = (() => {
    const issues: string[] = [];
    if (!activeTimeKey) {
      return { mismatchCount: 0, issues };
    }

    if (!replayState.enabled && depthTimeKey && activeTimeKey !== depthTimeKey) {
      issues.push("depth");
    }
    if (replayState.enabled && replayFrame?.timeKey && activeTimeKey !== replayFrame.timeKey) {
      issues.push("replay");
    }

    const hasFootprintSample = activeFootprintRows.length > 0;
    const hasFootprintMatch = activeFootprintRows.some((row) => row.timeKey === activeTimeKey);
    if (hasFootprintSample && !hasFootprintMatch) {
      issues.push("footprint");
    }

    const hasTapeSample = activeTape.length > 0;
    const hasTapeMatch = activeTape.some((print) => print.timeKey === activeTimeKey);
    if (hasTapeSample && !hasTapeMatch) {
      issues.push("tape");
    }

    const hasDomSample = activeDomLevels.length > 0;
    if (hasDomSample && !strictDepthTimeMatch) {
      issues.push("dom/heatmap");
    }

    return {
      mismatchCount: issues.length,
      issues,
    };
  })();
  const timeSyncMismatchLabel = timeSyncDiagnostics.issues.join(", ");
  const replayCurrentIndex = replayState.enabled ? clampIndex(replayState.cursorIndex, replayMaxIndex) : replayMaxIndex;
  const replayCurrentTimeLabel = replayState.enabled
    ? (replayFrame?.timeLabel || formatTimeKeyLabel(activeTimeKey || null))
    : formatTimeKeyLabel(activeTimeKey || null);

  useEffect(() => {
    if (!DEBUG_TIME_SYNC || timeSyncDiagnostics.mismatchCount === 0) {
      return;
    }
    console.warn("[time-sync] mismatch", {
      activeTimeKey,
      replayEnabled: replayState.enabled,
      replayFrameTimeKey: replayFrame?.timeKey || null,
      depthTimeKey,
      mismatchCount: timeSyncDiagnostics.mismatchCount,
      issues: timeSyncDiagnostics.issues,
    });
  }, [
    activeTimeKey,
    depthTimeKey,
    replayFrame?.timeKey,
    replayState.enabled,
    timeSyncDiagnostics.issues,
    timeSyncDiagnostics.mismatchCount,
  ]);

  const enableReplay = () => {
    if (replayFrames.length === 0) {
      return;
    }
    const startIndex = replayMaxIndex;
    setReplayState((current) => ({
      ...current,
      enabled: true,
      playing: false,
      cursorIndex: startIndex,
      timeKey: replayFrames[startIndex]?.timeKey || null,
    }));
  };

  const exitReplayMode = () => {
    setReplayState((current) => ({
      ...current,
      enabled: false,
      playing: false,
      timeKey: null,
      cursorIndex: replayMaxIndex,
    }));
  };

  const stepReplay = (delta: number) => {
    if (replayFrames.length === 0) {
      return;
    }
    setReplayState((current) => {
      const nextIndex = clampIndex(current.cursorIndex + delta, replayMaxIndex);
      return {
        ...current,
        enabled: true,
        playing: false,
        cursorIndex: nextIndex,
        timeKey: replayFrames[nextIndex]?.timeKey || null,
      };
    });
  };

  const jumpToReplayFrame = (frameIndex: number) => {
    if (replayFrames.length === 0) {
      return;
    }
    const nextIndex = clampIndex(frameIndex, replayMaxIndex);
    setReplayState((current) => ({
      ...current,
      enabled: true,
      playing: false,
      cursorIndex: nextIndex,
      timeKey: replayFrames[nextIndex]?.timeKey || null,
    }));
  };

  const setReplaySpeed = (speed: ReplaySpeed) => {
    setReplayState((current) => ({ ...current, speed }));
  };

  const toggleReplayPlayback = () => {
    if (replayFrames.length === 0) {
      return;
    }
    setReplayState((current) => ({
      ...current,
      enabled: true,
      playing: !current.playing,
      timeKey: replayFrames[clampIndex(current.cursorIndex, replayMaxIndex)]?.timeKey || current.timeKey,
    }));
  };
  const avgSlippage = executionTelemetry.length > 0
    ? average(executionTelemetry.map((item) => toNumber(item.realized_slippage_bps, 0)))
    : average(filteredOutcomes.map((item) => toNumber(item.slippage_real_bps, 0)));
  const avgLatency = executionTelemetry.length > 0
    ? average(executionTelemetry.map((item) => toNumber(item.latency_e2e_ms, 0)))
    : average(filteredOutcomes.map((item) => toNumber(item.latency_ms, 0)));
  const routeCandidates = selectedQuoteRows
    .map((quote) => {
      const bid = toNumber(quote.bid, 0);
      const ask = toNumber(quote.ask, 0);
      return {
        venue: String(quote.venue || "unknown"),
        instrument: String(quote.instrument || selectedChartSymbol),
        spread: ask > 0 && bid > 0 ? ask - bid : Number.MAX_SAFE_INTEGER,
        last: toNumber(quote.last, 0),
      };
    })
    .sort((left, right) => left.spread - right.spread);
  const routingCandidatesV6 = Array.isArray(routingScore?.candidates)
    ? routingScore.candidates as JsonMap[]
    : [];
  const executionRouteCandidates = routingCandidatesV6.length > 0
    ? routingCandidatesV6
    : routeCandidates.map((candidate) => ({
      venue: candidate.venue,
      instrument: candidate.instrument,
      score: 0,
      spread_bps: candidate.spread,
      available_depth_usd: 0,
      freshness_ms: 0,
      fill_probability: 0,
      liquidity: 0,
      stability_score: 0,
      stability_state: "n/a",
    }));
  const preferredRoute = (routingScore?.best as JsonMap | undefined) || routeCandidates[0] || null;
  const backupRoute = (routingScore?.backup as JsonMap | undefined) || routeCandidates[1] || null;
  const routingReasonLabel = String(routingScore?.reason || (routingCandidatesV6.length > 0 ? "best_route_candidate" : "best_quote_spread")).replace(/_/g, " ");
  const routingInfraHealth = clamp(toNumber(routingScore?.infra_health, 1), 0.05, 1);
  const routingNetworkRegime = String(routingScore?.network_regime || "stable");
  const preferredRouteStability = toNumber((preferredRoute as JsonMap | null)?.stability_score, 0);
  const preferredRouteState = String((preferredRoute as JsonMap | null)?.stability_state || (preferredRouteStability > 0 ? "watch" : "n/a"));
  const backupRouteStability = toNumber((backupRoute as JsonMap | null)?.stability_score, 0);
  const backupRouteState = String((backupRoute as JsonMap | null)?.stability_state || (backupRouteStability > 0 ? "watch" : "n/a"));
  const replayItems = executionTelemetry.length > 0 ? executionTelemetry.slice(0, 6) : filteredOutcomes.slice(0, 6);
  const replayOptions = replayItems.reduce((acc, item) => {
    const id = decisionIdFrom(item);
    if (!id || acc.some((entry) => entry.id === id)) {
      return acc;
    }
    return [...acc, { id, item }];
  }, [] as Array<{ id: string; item: JsonMap }>);
  const replayRoute = replayTelemetry ? String(replayTelemetry.route_chosen || "-") : "-";
  const replaySlippage = replayTelemetry ? toNumber(replayTelemetry.realized_slippage_bps, 0) : 0;
  const replayLatency = replayTelemetry ? toNumber(replayTelemetry.latency_e2e_ms, 0) : 0;
  const replayVenueAggregates = [...replayFills.reduce((acc, fill) => {
    const venue = String(fill.venue || "unknown");
    const existing = acc.get(venue) || { venue, fills: 0, notional: 0, slippage: 0 };
    existing.fills += 1;
    existing.notional += toNumber(fill.notional_usd, 0);
    existing.slippage += toNumber(fill.slippage_bps, 0);
    acc.set(venue, existing);
    return acc;
  }, new Map<string, { venue: string; fills: number; notional: number; slippage: number }>()).values()]
    .map((item) => ({ ...item, avgSlippage: item.fills > 0 ? item.slippage / item.fills : 0 }))
    .sort((left, right) => right.notional - left.notional);
  const replayHistogram = [...replayFills.reduce((acc, fill) => {
    const bucket = Math.round(toNumber(fill.slippage_bps, 0));
    acc.set(bucket, (acc.get(bucket) || 0) + 1);
    return acc;
  }, new Map<number, number>()).entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([bucket, count]) => ({ bucket, count }));
  const replayHistogramMax = replayHistogram.reduce((max, item) => Math.max(max, item.count), 1);
  const replayDurationMs = replayTimeline.length > 1
    ? Math.max(1, new Date(replayTimeline[replayTimeline.length - 1].timestamp).getTime() - new Date(replayTimeline[0].timestamp).getTime())
    : 1;
  const activeVenueMetrics = replayVenueAggregates.find((v) => v.venue === replayRoute) || replayVenueAggregates[0] || null;
  const venueQualityScore = (() => {
    if (!activeVenueMetrics) return 0.75;
    const slip = Math.abs(toNumber(activeVenueMetrics.avgSlippage, 0));
    const latency = replayLatency;
    const fills = Math.max(1, toNumber(activeVenueMetrics.fills, 1));
    const slipScore =
      slip <= 1.5 ? 1
      : slip <= 3 ? 0.85
      : slip <= 6 ? 0.65
      : 0.45;
    const latencyScore =
      latency <= 120 ? 1
      : latency <= 220 ? 0.85
      : latency <= 380 ? 0.65
      : 0.4;
    const reliabilityScore = Math.min(1, 0.55 + fills / 20);
    return Math.max(0.35, Math.min(1, slipScore * 0.5 + latencyScore * 0.35 + reliabilityScore * 0.15));
  })();
  const venueQualityMultiplier = Math.max(0.6, Math.min(1, venueQualityScore));
  const venueQualityLabel =
    venueQualityScore >= 0.85 ? "good"
    : venueQualityScore >= 0.65 ? "fair"
    : "poor";
  const preferredSpread = preferredRoute
    ? toNumber((preferredRoute as JsonMap).spread, toNumber((preferredRoute as JsonMap).spread_bps, 0))
    : 0;
  const backupScore = backupRoute ? toNumber((backupRoute as JsonMap).score, 0) : 0;
  const fusionPrice = toNumber(marketMicro?.fusion_price, toNumber(routingScore?.fusion_price, 0));
  const predictedPrice = toNumber(marketMicro?.predicted_price, 0);
  const fusionVenueCount = Math.max(0, toNumber(marketMicro?.fusion_venue_count, 0));
  const fusionDeviationBps = toNumber(marketMicro?.fusion_deviation_bps, toNumber(routingScore?.deviation_bps, 0));
  const predictedDeltaBps = fusionPrice > 0 && predictedPrice > 0
    ? ((predictedPrice - fusionPrice) / fusionPrice) * 10000
    : 0;
  const v8Prediction = predictorEngineV8Ref.current.assess({
    marketMicro,
    routingScore,
    executionTelemetry: executionTelemetry.length > 0 ? executionTelemetry : outcomes,
    kernelTelemetry: marketBusKernelTelemetry,
    horizonMs: marketBusKernelTelemetry.tickLatencyMs > 45 ? 100 : 50,
    notionalUsd: autoExecutionMode === "full-auto" ? autoSizingV3.finalNotional : notional,
  });
  const backendMultiHorizon = backendPredictorSnapshot?.multi_horizon && typeof backendPredictorSnapshot.multi_horizon === "object"
    ? backendPredictorSnapshot.multi_horizon as JsonMap
    : null;
  const backendP20 = toNumber((backendMultiHorizon?.["20"] as JsonMap | undefined)?.probability, 0);
  const backendP50 = toNumber((backendMultiHorizon?.["50"] as JsonMap | undefined)?.probability, 0);
  const backendP100 = toNumber((backendMultiHorizon?.["100"] as JsonMap | undefined)?.probability, 0);
  const backendBrainDecision = backendPredictorSnapshot?.autonomous_brain && typeof backendPredictorSnapshot.autonomous_brain === "object"
    ? backendPredictorSnapshot.autonomous_brain as JsonMap
    : null;
  const backendBrainMetaPolicy = backendBrainDecision?.meta_policy && typeof backendBrainDecision.meta_policy === "object"
    ? backendBrainDecision.meta_policy as JsonMap
    : null;
  const backendBrainStats = backendPredictorStats?.brain && typeof backendPredictorStats.brain === "object"
    ? backendPredictorStats.brain as JsonMap
    : null;
  const backendBrainAction = String(backendBrainDecision?.action || "n/a").toUpperCase();
  const backendBrainConfidence = toNumber(backendBrainDecision?.confidence, 0);
  const backendBrainConsensus = toNumber(backendBrainDecision?.consensus, 0);
  const backendBrainShouldExecute = typeof backendBrainDecision?.should_execute === "boolean"
    ? Boolean(backendBrainDecision.should_execute)
    : false;
  const backendBrainRegime = String(backendBrainDecision?.regime || ((backendBrainDecision?.state as JsonMap | undefined)?.regime) || "n/a").toUpperCase();
  const backendBrainReason = String(backendBrainDecision?.reason || "");
  const backendBrainOrderflowQuality = toNumber(backendBrainMetaPolicy?.orderflow_quality, 0);
  const backendBrainDisabledAgents = Array.isArray(backendBrainMetaPolicy?.disabled_agents)
    ? (backendBrainMetaPolicy?.disabled_agents as unknown[]).map((item) => String(item)).filter(Boolean)
    : [];
  const backendBrainFeatureContext = backendBrainMetaPolicy?.feature_context && typeof backendBrainMetaPolicy.feature_context === "object"
    ? backendBrainMetaPolicy.feature_context as JsonMap
    : null;
  const backendBrainFeatureLeader = String(backendBrainMetaPolicy?.feature_leader || "n/a");
  const backendBrainFeatureLeaderContribution = toNumber(backendBrainMetaPolicy?.feature_leader_contribution, 0);
  const backendBrainFeatureSession = String(backendBrainFeatureContext?.session || backendBrainMetaPolicy?.market_session || predictorMarketSession || "n/a");
  const backendBrainFeatureVolatility = String(backendBrainFeatureContext?.volatility || "n/a");
  const backendBrainFeatureSpread = String(backendBrainFeatureContext?.spread || "n/a");
  const backendBrainFeatureAttribution = backendBrainMetaPolicy?.feature_attribution && typeof backendBrainMetaPolicy.feature_attribution === "object"
    ? backendBrainMetaPolicy.feature_attribution as Record<string, JsonMap>
    : {};
  const backendBrainAnchorPrimary = String(backendBrainMetaPolicy?.anchor_primary || predictorOrderflowSnapshot.multiAnchorVwap.primaryLabel || "n/a");
  const backendBrainAnchorCompression = toNumber(backendBrainMetaPolicy?.anchor_compression_bps, predictorOrderflowSnapshot.multiAnchorVwap.anchorCompressionBps);
  const backendBrainAnchorConfluence = toNumber(backendBrainMetaPolicy?.anchor_confluence, predictorOrderflowSnapshot.multiAnchorVwap.confluenceScore);
  const backendBrainLiquidityPressure = toNumber(backendBrainMetaPolicy?.liquidity_pressure, predictorOrderflowSnapshot.liquidityEngine.liquidityPressure);
  const backendBrainSweepRisk = toNumber(backendBrainMetaPolicy?.sweep_risk, predictorOrderflowSnapshot.liquidityEngine.sweepRisk);
  const backendBrainLiquidityVacuum = toNumber(backendBrainMetaPolicy?.liquidity_vacuum, predictorOrderflowSnapshot.liquidityEngine.liquidityVacuum);
  const backendBrainLiquidityState = String(backendBrainMetaPolicy?.liquidity_state || predictorOrderflowSnapshot.liquidityEngine.stateLabel || "balanced");
  const backendBrainReplayStats = (backendBrainStats?.replay_buffer as JsonMap | undefined) || null;
  const backendBrainLatentStats = (backendBrainStats?.latent_encoder as JsonMap | undefined) || null;
  const backendBrainReplaySize = toNumber(backendBrainReplayStats?.size, 0);
  const backendBrainLearnSteps = toNumber(backendBrainStats?.learn_steps, 0);
  const backendBrainWinRate = toNumber(backendBrainStats?.global_win_rate, 0);
  const backendBrainDreamSize = toNumber(backendBrainReplayStats?.dream_size, 0);
  const backendBrainDreamRatio = toNumber(backendBrainReplayStats?.dream_ratio, 0);
  const backendBrainDreamWeight = toNumber(backendBrainReplayStats?.dream_avg_weight, 0);
  const backendBrainLatentLabel = String(backendBrainMetaPolicy?.latent_label || backendBrainLatentStats?.current_label || "uninitialized");
  const backendBrainLatentConfidence = toNumber(backendBrainMetaPolicy?.latent_confidence, toNumber(backendBrainLatentStats?.confidence_ema, 0));
  const backendBrainLatentTransition = toNumber(backendBrainMetaPolicy?.latent_transition, toNumber(backendBrainLatentStats?.transition_ema, 0));
  const backendBrainLatentFactor = String(backendBrainMetaPolicy?.latent_factor || backendBrainLatentStats?.dominant_factor || "n/a");
  const backendBrainLatentObservations = toNumber(backendBrainLatentStats?.observations, 0);
  const backendBrainVotes = Array.isArray(backendBrainDecision?.agent_votes)
    ? [...(backendBrainDecision.agent_votes as JsonMap[])].sort((left, right) => {
      const leftScore = toNumber(left.calibrated_confidence, 0) * Math.max(1, toNumber(left.weight, 0));
      const rightScore = toNumber(right.calibrated_confidence, 0) * Math.max(1, toNumber(right.weight, 0));
      return rightScore - leftScore;
    })
    : [];
  const backendBrainTopVotes = backendBrainVotes.slice(0, 3);
  const backendBrainAttributionRows = Object.entries(backendBrainFeatureAttribution)
    .map(([family, raw]) => ({
      family,
      alpha: toNumber(raw?.alpha, toNumber(raw?.avg_contribution, 0)),
      marginal: toNumber(raw?.context_avg_marginal_impact ?? raw?.avg_marginal_impact, 0),
      correlation: toNumber(raw?.rolling_correlation, 0),
      learningRateHint: toNumber(raw?.learning_rate_hint, 1),
      wrongWayRate: toNumber(raw?.wrong_way_rate, 0),
    }))
    .sort((left, right) => Math.abs(right.alpha) - Math.abs(left.alpha))
    .slice(0, 4);
  const backendBrainAttributionPills = backendBrainAttributionRows.map((row) => (
    `${compactFeatureFamilyLabel(row.family)} α${row.alpha >= 0 ? "+" : ""}${row.alpha.toFixed(2)} · SHAP ${row.marginal >= 0 ? "+" : ""}${row.marginal.toFixed(2)} · ρ ${row.correlation.toFixed(2)} · lr x${row.learningRateHint.toFixed(2)}${row.wrongWayRate >= 0.4 ? " · risk" : ""}`
  ));
  const backendBrainLearningRates = backendBrainMetaPolicy?.agent_learning_rates && typeof backendBrainMetaPolicy.agent_learning_rates === "object"
    ? backendBrainMetaPolicy.agent_learning_rates as Record<string, JsonMap>
    : {};
  const backendBrainGovernor = backendBrainMetaPolicy?.governor && typeof backendBrainMetaPolicy.governor === "object"
    ? backendBrainMetaPolicy.governor as JsonMap
    : null;
  const backendBrainGovernorMode = String(backendBrainGovernor?.mode || "idle");
  const backendBrainGovernorBlocked = Boolean(backendBrainGovernor?.blocked);
  const backendBrainGovernorSizeMultiplier = toNumber(backendBrainGovernor?.size_multiplier, 1);
  const backendBrainGovernorReasons = Array.isArray(backendBrainGovernor?.reasons)
    ? (backendBrainGovernor?.reasons as unknown[]).map((item) => String(item)).filter(Boolean)
    : [];
  const backendBrainGovernorFailureSource = String(backendBrainGovernor?.failure_source || "");
  const backendBrainGovernorCalibrationConfidence = toNumber(backendBrainGovernor?.calibration_confidence, 0);
  const backendBrainMetaAgent = backendBrainMetaPolicy?.meta_agent && typeof backendBrainMetaPolicy.meta_agent === "object"
    ? backendBrainMetaPolicy.meta_agent as JsonMap
    : null;
  const backendBrainMetaMode = String(backendBrainMetaAgent?.global_mode || "");
  const backendBrainMetaProfileId = String(backendBrainMetaAgent?.profile_id || "");
  const backendBrainMetaVenueAction = String(backendBrainMetaAgent?.venue_action || "");
  const backendBrainMetaExecutionDelayMs = toNumber(backendBrainMetaAgent?.execution_delay_ms, 0);
  const backendBrainMetaSimulationProfile = String(backendBrainMetaAgent?.simulation_profile || "");
  const backendBrainMetaCloseOnly = Boolean(backendBrainMetaAgent?.close_only);
  const backendBrainMetaHaltNewExposure = Boolean(backendBrainMetaAgent?.halt_new_exposure);
  const backendBrainMetaReasons = Array.isArray(backendBrainMetaAgent?.reasons)
    ? (backendBrainMetaAgent?.reasons as unknown[]).map((item) => String(item)).filter(Boolean)
    : [];
  const backendBrainActionShield = backendBrainMetaPolicy?.action_shield && typeof backendBrainMetaPolicy.action_shield === "object"
    ? backendBrainMetaPolicy.action_shield as JsonMap
    : null;
  const backendBrainActionShieldMode = String(backendBrainActionShield?.mode || "pass");
  const backendBrainSafeAction = String(backendBrainActionShield?.projected_action || "");
  const backendBrainShieldDelayMs = toNumber(backendBrainActionShield?.delay_ms, 0);
  const backendBrainShieldRisk = toNumber(backendBrainActionShield?.execution_risk_score, 0);
  const backendBrainShieldReasons = Array.isArray(backendBrainActionShield?.reasons)
    ? (backendBrainActionShield?.reasons as unknown[]).map((item) => String(item)).filter(Boolean)
    : [];
  const backendBrainWorldModel = backendBrainDecision?.world_model && typeof backendBrainDecision.world_model === "object"
    ? backendBrainDecision.world_model as JsonMap
    : null;
  const backendBrainWorldSummary = backendBrainWorldModel?.summary && typeof backendBrainWorldModel.summary === "object"
    ? backendBrainWorldModel.summary as JsonMap
    : null;
  const backendBrainWorldFutureRegime = String(backendBrainWorldSummary?.future_regime || "");
  const backendBrainWorldDirectionBias = String(backendBrainWorldSummary?.direction_bias || "");
  const backendBrainWorldHorizonMs = toNumber(backendBrainWorldSummary?.horizon_ms, 0);
  const backendBrainWorldPredictedSlippage = toNumber(backendBrainWorldSummary?.expected_slippage_bps, 0);
  const backendBrainWorldPredictedFill = toNumber(backendBrainWorldSummary?.expected_fill_probability, 0);
  const backendBrainWorldPredictedLatency = toNumber(backendBrainWorldSummary?.expected_latency_ms, 0);
  const backendBrainWorldRecommendedDelayMs = toNumber(backendBrainWorldSummary?.recommended_delay_ms, 0);
  const backendBrainStrategySwitch = backendBrainMetaPolicy?.strategy_switch && typeof backendBrainMetaPolicy.strategy_switch === "object"
    ? backendBrainMetaPolicy.strategy_switch as JsonMap
    : null;
  const backendBrainStrategyMode = String(backendBrainStrategySwitch?.strategy_mode || "");
  const backendBrainStrategySwitchMode = String(backendBrainStrategySwitch?.mode || "default");
  const backendBrainStrategyRouteModeOverride = String(backendBrainStrategySwitch?.route_mode_override || "");
  const backendBrainStrategyExecutionStyle = String(backendBrainStrategySwitch?.execution_style || "");
  const backendBrainStrategyMaxSpreadMultiplier = toNumber(backendBrainStrategySwitch?.max_spread_multiplier, 1);
  const backendBrainStrategySizeCap = toNumber(backendBrainStrategySwitch?.size_multiplier_cap, 1);
  const backendBrainStrategyMemoryConfidence = toNumber(backendBrainStrategySwitch?.policy_memory_confidence, 0);
  const backendBrainStrategyReasons = Array.isArray(backendBrainStrategySwitch?.reasons)
    ? (backendBrainStrategySwitch?.reasons as unknown[]).map((item) => String(item)).filter(Boolean)
    : [];
  const backendBrainLearningRatePills = Object.entries(backendBrainLearningRates)
    .map(([name, raw]) => ({
      name,
      effective: toNumber(raw?.effective, 0),
      multiplier: toNumber(raw?.multiplier, 1),
    }))
    .sort((left, right) => right.effective - left.effective)
    .slice(0, 4)
    .map((row) => `${row.name} lr x${row.multiplier.toFixed(2)} → ${row.effective.toFixed(3)}`);
  const backendBrainFailureCalibration = backendBrainStats?.failure_lr_calibration && typeof backendBrainStats.failure_lr_calibration === "object"
    ? backendBrainStats.failure_lr_calibration as JsonMap
    : null;
  const backendBrainFailureCalibrationSources = backendBrainFailureCalibration?.sources && typeof backendBrainFailureCalibration.sources === "object"
    ? backendBrainFailureCalibration.sources as Record<string, JsonMap>
    : {};
  const backendBrainCalibrationRows = ["infra", "market", "execution"].map((source) => {
    const raw = backendBrainFailureCalibrationSources[source] && typeof backendBrainFailureCalibrationSources[source] === "object"
      ? backendBrainFailureCalibrationSources[source]
      : {};
    const multipliersRaw = raw?.multipliers && typeof raw.multipliers === "object"
      ? raw.multipliers as Record<string, unknown>
      : {};
    const multiplierRows = Object.entries(multipliersRaw)
      .map(([agent, value]) => ({
        agent,
        multiplier: toNumber(value, 1),
      }))
      .sort((left, right) => left.multiplier - right.multiplier || left.agent.localeCompare(right.agent));
    return {
      source,
      calibrated: Boolean(raw?.calibrated),
      confidence: toNumber(raw?.confidence, 0),
      sampleCount: Math.max(0, Math.round(toNumber(raw?.sample_count, 0))),
      realCount: Math.max(0, Math.round(toNumber(raw?.real_count, 0))),
      syntheticCount: Math.max(0, Math.round(toNumber(raw?.synthetic_count, 0))),
      effectiveSampleWeight: toNumber(raw?.effective_sample_weight, 0),
      averageReward: toNumber(raw?.average_reward, 0),
      multiplierRows,
    };
  });
  const backendBrainCalibrationLeader = [...backendBrainCalibrationRows]
    .sort((left, right) => right.confidence - left.confidence || right.sampleCount - left.sampleCount)[0] || null;
  const backendBrainCalibrationHeadline = backendBrainCalibrationLeader && backendBrainCalibrationLeader.confidence > 0
    ? `${formatFailureSourceLabel(backendBrainCalibrationLeader.source)} ${(backendBrainCalibrationLeader.confidence * 100).toFixed(0)}% conf · n ${backendBrainCalibrationLeader.sampleCount}`
    : "Priors only · awaiting real failure slice";
  const effectiveV8Probability = toNumber(backendPredictorSnapshot?.probability, v8Prediction.probability);
  const effectiveV8ShouldExecute = typeof backendPredictorSnapshot?.should_execute === "boolean"
    ? Boolean(backendPredictorSnapshot.should_execute)
    : v8Prediction.shouldExecute;
  const effectiveV8DataReliable = typeof backendPredictorSnapshot?.data_reliable === "boolean"
    ? Boolean(backendPredictorSnapshot.data_reliable)
    : dataReliabilitySnapshot.ready;
  const arbPayload = (routingScore?.arbitrage as JsonMap | undefined) || null;
  const arbOpportunity = Boolean(arbPayload?.opportunity ?? marketMicro?.arbitrage_opportunity);
  const arbNetSpread = toNumber(arbPayload?.net_spread ?? marketMicro?.arbitrage_net_spread, 0);
  const arbBuyVenue = String(arbPayload?.buy ?? marketMicro?.arbitrage_buy_venue ?? "").replace("-public", "").replace("paper-", "");
  const arbSellVenue = String(arbPayload?.sell ?? marketMicro?.arbitrage_sell_venue ?? "").replace("-public", "").replace("paper-", "");
  const v7ExecutionDecision = getV7ExecutionDecision();
  const backendEdgeNetBps = toNumber(backendPredictorSnapshot?.edge_net_bps, arbNetSpread);
  const backendLatencyCostBps = toNumber(backendPredictorSnapshot?.latency_cost_bps, v7ExecutionDecision.latencyCostBps);
  const backendFinalEdgeBps = toNumber(backendPredictorSnapshot?.final_edge_bps, v7ExecutionDecision.expectedNetEdgeBps);
  const backendPredictorReasonsLabel = Array.isArray(backendPredictorSnapshot?.reasons)
    ? (backendPredictorSnapshot.reasons as unknown[]).slice(0, 3).map((item) => String(item)).join(" · ")
    : dataReliabilitySnapshot.reasons.slice(0, 3).join(" · ");
  const v7StatusTone = v7ExecutionDecision.shouldExecute
    ? "good"
    : arbOpportunity
      ? "warn"
      : "neutral";
  const v7StatusLabel = v7ExecutionDecision.routeMode === "dualVenueExecution"
    ? `V7 ARB ${v7ExecutionDecision.expectedNetEdgeBps.toFixed(1)}bps`
    : `V7 ROUTE ${toNumber(v7ExecutionDecision.bestCandidate?.score, 0).toFixed(2)}`;
  const preferredRouteLabel = preferredRoute
    ? String(preferredRoute.venue || "–").replace("-public", "").replace("paper-", "")
    : "–";
  const preferredRouteScore = preferredRoute ? toNumber((preferredRoute as JsonMap).score, 0) : 0;
  const fusionChipTone = fusionPrice > 0 ? (fusionDeviationBps <= 8 ? "good" : "warn") : "neutral";
  const predictedChipTone = predictedPrice > 0 ? (Math.abs(predictedDeltaBps) <= 6 ? "good" : "warn") : "neutral";
  const arbChipTone = arbOpportunity ? "warn" : "neutral";
  const routeChipTone = preferredRoute ? "good" : "neutral";
  const kernelChipTone = marketBusKernelTelemetry.tickLatencyMs <= 14 && marketBusKernelTelemetry.bufferBacklog <= 64
    ? "good"
    : marketBusKernelTelemetry.tickLatencyMs <= 28 && marketBusKernelTelemetry.bufferBacklog <= 180
      ? "warn"
      : "neutral";
  const schedulerChipTone = marketBusKernelTelemetry.backlogPressure <= 0.8 && chartKernelPerf.frameTimeMs <= 16.7
    ? "good"
    : marketBusKernelTelemetry.backlogPressure <= 1.8
      ? "warn"
      : "neutral";
  const v8ChipTone = effectiveV8ShouldExecute ? (v8Prediction.confidence === "high" ? "good" : "warn") : effectiveV8DataReliable ? "neutral" : "warn";
  const benchmarkChipTone = kernelBenchmarkRate > 0 ? "warn" : "neutral";
  const kernelTelemetryLabel = `KERN ${marketBusKernelTelemetry.tickLatencyMs.toFixed(1)}ms q${marketBusKernelTelemetry.bufferBacklog} d${marketBusKernelTelemetry.drainedTicksPerFrame} sk${marketBusKernelTelemetry.skippedFrames}`;
  const schedulerLabel = `SCHED ${marketBusKernelTelemetry.schedulerBudgetMs.toFixed(1)}ms/${marketBusKernelTelemetry.schedulerPullLimit}`;
  const candleProbeAgeMs = marketBusKernelTelemetry.lastCandleUpdateAt
    ? Math.max(0, Date.now() - Date.parse(marketBusKernelTelemetry.lastCandleUpdateAt))
    : -1;
  const candleLastUpdateAgeLabel = candleProbeAgeMs >= 0 ? formatFreshness(candleProbeAgeMs) : "n/a";
  const candleProbeTone = candleProbeAgeMs < 0
    ? "neutral"
    : candleProbeAgeMs <= 15_000
      ? "good"
      : candleProbeAgeMs <= 60_000
        ? "warn"
        : "bad";
  const candleProbeLabel = `CANDLE t${marketBusKernelTelemetry.receivedTicks} u${marketBusKernelTelemetry.candleUpdates} hb${marketBusKernelTelemetry.syntheticHeartbeatOpens} age ${candleLastUpdateAgeLabel}`;
  const v8Label = `V8 HOLD ${(effectiveV8Probability * 100).toFixed(0)}% ${backendP20 > 0 ? "20/50/100" : v8Prediction.horizonMs}ms`;
  const benchmarkLabel = kernelBenchmarkRate > 0 ? `BENCH ${kernelBenchmarkRate}tps` : "BENCH OFF";
  const v8TopDrivers = v8Prediction.contributions.slice(0, 3);
  const v8TrainingFreshnessMs = v8TrainingStats.updatedAt ? Math.max(0, Date.now() - Date.parse(v8TrainingStats.updatedAt)) : -1;
  const v8TrainingFreshnessLabel = v8TrainingFreshnessMs >= 0 ? formatFreshness(v8TrainingFreshnessMs) : "n/a";
  const v8PersistenceLabel = !v8PersistenceLoaded
    ? "loading"
    : v8TrainingStats.updatedAt
      ? `persisted ${v8TrainingFreshnessLabel}`
      : "session-only";
  const availableAgentCount = providerRows.filter((item) => Boolean(item.available)).length;
  const lifecycleTelemetry = executionTelemetry.length > 0 ? executionTelemetry : filteredOutcomes.slice(0, 20);
  const omsLifecycleLastEventIso = lifecycleTelemetry.reduce<string | null>((latest, item) => {
    const candidate = pickTimestamp(item, ["ts_fill_final", "ts_fill_partial", "ts_broker_accept", "closed_at", "timestamp", "created_at", "ts"]);
    if (!candidate) {
      return latest;
    }
    if (!latest) {
      return candidate;
    }
    const latestTs = Date.parse(latest);
    const candidateTs = Date.parse(candidate);
    if (Number.isFinite(candidateTs) && (!Number.isFinite(latestTs) || candidateTs > latestTs)) {
      return candidate;
    }
    return latest;
  }, null);
  const omsLifecycleSummary = {
    pendingApprovals: pendingLive.length,
    routedCount: lifecycleTelemetry.filter((item) => String(item.route_chosen || item.route || "").trim().length > 0).length,
    acceptedCount: lifecycleTelemetry.filter((item) => {
      const status = String(item.status || "").toLowerCase();
      return Boolean(item.ts_broker_accept) || /accept|ack|submit|work|partial|fill/.test(status);
    }).length,
    partialCount: lifecycleTelemetry.filter((item) => {
      const status = String(item.status || "").toLowerCase();
      const fillRatio = toNumber(item.fill_ratio ?? item.executed_ratio, NaN);
      return Boolean(item.ts_fill_partial) || /partial/.test(status) || (Number.isFinite(fillRatio) && fillRatio > 0 && fillRatio < 0.99);
    }).length,
    filledCount: lifecycleTelemetry.filter((item) => {
      const status = String(item.status || "").toLowerCase();
      const fillRatio = toNumber(item.fill_ratio ?? item.executed_ratio, NaN);
      return Boolean(item.ts_fill_final) || /fill|closed|done|complete/.test(status) || (Number.isFinite(fillRatio) && fillRatio >= 0.99);
    }).length,
    blockedCount: lifecycleTelemetry.filter((item) => /reject|block|cancel|error|fail/.test(String(item.status || "").toLowerCase())).length,
    avgLatencyMs: avgLatency,
    avgSlippageBps: avgSlippage,
    lastEventIso: omsLifecycleLastEventIso,
    agentReadyCount: availableAgentCount,
    agentTotalCount: providerRows.length,
  };
  const dominantPortfolioBook = [...marketBuckets]
    .sort((left, right) => Math.abs(right.exposure) - Math.abs(left.exposure) || Math.abs(right.pnl) - Math.abs(left.pnl))
    .find((bucket) => bucket.quoteCount > 0 || Math.abs(bucket.exposure) > 0 || Math.abs(bucket.pnl) > 0);
  const portfolioOverlaySummary = {
    accountFreeUsd,
    openTradesCount,
    grossExposureUsd,
    exposureRatioPct: exposureRatio * 100,
    dailyPnLUsd,
    dailyDrawdownPct,
    dominantBookLabel: dominantPortfolioBook
      ? `${dominantPortfolioBook.market} | expo ${dominantPortfolioBook.exposure.toFixed(0)} | pnl ${dominantPortfolioBook.pnl.toFixed(0)}`
      : "no active market bucket",
  };
  const aiBridgeSummary = {
    routeLabel: preferredRouteLabel,
    routeScore: preferredRouteScore,
    v7Label: v7StatusLabel,
    v7Tone: v7StatusTone as "good" | "warn" | "neutral",
    edgeBps: backendFinalEdgeBps,
    v8Execute: effectiveV8ShouldExecute,
    v8ProbabilityPct: effectiveV8Probability * 100,
    brainAction: backendBrainAction,
    brainConfidencePct: backendBrainConfidence * 100,
    brainRegime: backendBrainRegime,
    reasonLabel: backendPredictorReasonsLabel || backendBrainReason,
  };

  const refreshBackendPredictorStats = useCallback(async () => {
    try {
      const response = await fetch("/api/predictor/stats", { cache: "no-store" });
      const payload = await response.json().catch(() => null);
      if (response.ok && payload && typeof payload === "object") {
        setBackendPredictorStats(payload as JsonMap);
      }
    } catch {
      // Ignore predictor stats refresh failures.
    }
  }, []);

  const flushBackendPredictorTrainingBuffer = useCallback(async () => {
    const batch = predictorTrainingBufferRef.current.splice(0, V8_BACKEND_TRAINING_FLUSH_SIZE);
    if (batch.length === 0) {
      return;
    }
    try {
      const response = await fetch("/api/predictor/train", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: batch }),
      });
      if (!response.ok) {
        predictorTrainingBufferRef.current.unshift(...batch);
        return;
      }
      const payload = await response.json().catch(() => null);
      const degradedTrainResponse = Boolean(
        payload
        && typeof payload === "object"
        && (
          (payload as JsonMap).degraded_flag === true
          || (
            (payload as JsonMap).network
            && typeof (payload as JsonMap).network === "object"
            && ((payload as JsonMap).network as JsonMap).degraded_flag === true
          )
        )
      );
      if (degradedTrainResponse) {
        predictorTrainingBufferRef.current.unshift(...batch);
        return;
      }
      const brainPayload = payload && typeof payload === "object" && (payload as JsonMap).brain && typeof (payload as JsonMap).brain === "object"
        ? (payload as JsonMap).brain as JsonMap
        : null;
      const experienceRows = Array.isArray(brainPayload?.experience_rows)
        ? brainPayload.experience_rows as JsonMap[]
        : [];
      if (experienceRows.length > 0) {
        setReplayAttributionByDecisionId((current) => {
          const next = { ...current };
          for (const row of experienceRows) {
            const snapshot = buildReplayAttributionSnapshotFromExperience(row);
            if (snapshot) {
              if (snapshot.synthetic && snapshot.dreamSource && snapshot.dreamSource !== snapshot.id) {
                next[snapshot.dreamSource] = mergeReplayDreamEcho(next[snapshot.dreamSource], snapshot);
              }
              const existing = next[snapshot.id];
              next[snapshot.id] = existing
                ? {
                    ...snapshot,
                    dreamCount: existing.dreamCount,
                    dreamWeight: existing.dreamWeight,
                  }
                : snapshot;
            }
          }
          return next;
        });
      }
      await refreshBackendPredictorStats();
    } catch {
      predictorTrainingBufferRef.current.unshift(...batch);
    }
  }, [refreshBackendPredictorStats]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch("/api/predictor/predict", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...buildRoutingRequestHeaders("execution", selectedChartSymbol),
            },
            body: JSON.stringify(predictorRequestPayload),
            signal: controller.signal,
          });
          const payload = await response.json().catch(() => null);
          if (!controller.signal.aborted) {
            setBackendPredictorSnapshot(payload && typeof payload === "object" ? payload as JsonMap : null);
          }
        } catch {
          if (!controller.signal.aborted) {
            setBackendPredictorSnapshot(null);
          }
        }
      })();
    }, V8_BACKEND_PREDICT_DEBOUNCE_MS);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [predictorRequestPayload, selectedChartSymbol]);

  useEffect(() => {
    void refreshBackendPredictorStats();
    const timer = window.setInterval(() => {
      void refreshBackendPredictorStats();
    }, V8_BACKEND_STATS_POLL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [refreshBackendPredictorStats]);

  useEffect(() => {
    if (typeof window === "undefined") {
      setV8PersistenceLoaded(true);
      return;
    }
    const raw = window.localStorage.getItem(V8_PREDICTOR_STORAGE_KEY);
    if (!raw) {
      setV8PersistenceLoaded(true);
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      if (predictorEngineV8Ref.current.loadState(parsed)) {
        setV8TrainingStats(predictorEngineV8Ref.current.getTrainingStats());
      }
    } catch {
      window.localStorage.removeItem(V8_PREDICTOR_STORAGE_KEY);
    }
    setV8PersistenceLoaded(true);
  }, []);

  useEffect(() => {
    executionTelemetry.slice(0, 8).forEach((item) => {
      executionEngineV7Ref.current.updateFeedback({
        venue: String(item.route_chosen || ""),
        latencyMs: toNumber(item.latency_e2e_ms, 0),
        realizedSlippageBps: toNumber(item.realized_slippage_bps, 0),
      });
    });
  }, [executionTelemetry]);

  useEffect(() => {
    if (!v8PersistenceLoaded) {
      return;
    }
    predictorEngineV8Ref.current.trainFromTelemetry(executionTelemetry);
    predictorEngineV8Ref.current.trainFromTelemetry(outcomes.slice(0, 24));
    const stats = predictorEngineV8Ref.current.getTrainingStats();
    setV8TrainingStats(stats);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(V8_PREDICTOR_STORAGE_KEY, JSON.stringify(predictorEngineV8Ref.current.getState()));
    }
  }, [executionTelemetry, outcomes, v8PersistenceLoaded]);

  useEffect(() => {
    const telemetryItems = [...executionTelemetry, ...outcomes.slice(0, 24)];
    for (const item of telemetryItems) {
      const sampleId = String(item.decision_id || item.id || item.event_id || "").trim();
      if (!sampleId || predictorTrainingQueuedIdsRef.current.has(sampleId)) {
        continue;
      }
      predictorTrainingQueuedIdsRef.current.add(sampleId);
      const predictorContext = item.predictor_context && typeof item.predictor_context === "object"
        ? item.predictor_context as JsonMap
        : predictorRequestPayload;
      const pnlBps = toNumber(item.pnl_bps ?? item.realized_pnl_bps, 0);
      const pnlUsd = toNumber(item.pnl_usd ?? item.net_result_usd ?? item.realized_pnl_usd, 0);
      const slippageBps = Math.abs(toNumber(item.realized_slippage_bps ?? item.slippage_real_bps, avgExecutionSlippageForPredictor));
      const latencyMs = toNumber(item.latency_e2e_ms ?? item.latency_ms, avgExecutionLatencyForPredictor);
      const arbEdgeBps = toNumber(item.expected_net_edge_bps ?? item.net_edge_bps, predictorRequestPayload.arb_edge_bps);
      const fillProbability = clamp(toNumber(item.fill_ratio ?? item.fill_probability, predictorRequestPayload.fill_probability), 0, 1);
      const label = pnlBps > 0 && slippageBps <= Math.max(1, arbEdgeBps * 1.15 + 1.5) && latencyMs < V8_LATENCY_GUARD_MS ? 1 : 0;
      const rawAction = String(item.action || item.side || item.intent_side || item.order_side || item.direction || item.position_side || "HOLD").trim().toUpperCase();
      const experienceAction = rawAction.includes("SELL") || rawAction === "SHORT"
        ? "SELL"
        : rawAction.includes("BUY") || rawAction === "LONG"
          ? "BUY"
          : "HOLD";
      const experienceReward = pnlBps - slippageBps * 0.75 - Math.max(0, latencyMs - 25) * 0.04;
      const experienceState = {
        ...predictorContext,
        probability: effectiveV8Probability,
        model_probability: effectiveV8Probability,
        final_edge_bps: arbEdgeBps,
        fill_probability: fillProbability,
        market_session: String(predictorContext.market_session || predictorMarketSession || "off"),
      };
      const experienceNextState = {
        ...experienceState,
        latency_ms: latencyMs,
        latency_e2e_ms: latencyMs,
        slippage_bps: slippageBps,
        realized_slippage_bps: slippageBps,
        pnl: pnlBps,
        realized_pnl_usd: pnlUsd,
        drawdown_pct: toNumber(item.drawdown_pct ?? item.current_drawdown_pct ?? item.drawdown, 0),
        position_size: toNumber(item.position_size ?? item.position, 0),
      };
      predictorTrainingBufferRef.current.push({
        id: sampleId,
        features: {
          ...predictorContext,
          latency_ms: latencyMs,
          slippage_bps: slippageBps,
          arb_edge_bps: arbEdgeBps,
          fill_probability: fillProbability,
          venue: String(item.route_chosen || item.venue || ""),
          notional_usd: toNumber(item.notional_usd ?? item.estimated_notional_usd, notional),
        },
        experience_id: sampleId,
        action: experienceAction,
        reward: experienceReward,
        state: experienceState,
        next_state: experienceNextState,
        prediction: toNumber(item.v8_probability ?? item.prediction_probability, effectiveV8Probability),
        outcome: {
          pnl_bps: pnlBps,
          latency_ms: latencyMs,
          slippage_bps: slippageBps,
          status: String(item.status || "filled"),
        },
        latency: latencyMs,
        pnl: pnlBps,
        slippage: slippageBps,
        venue: String(item.route_chosen || item.venue || ""),
        label,
      });
    }
    if (predictorTrainingBufferRef.current.length >= V8_BACKEND_TRAINING_FLUSH_SIZE) {
      void flushBackendPredictorTrainingBuffer();
    }
  }, [avgExecutionLatencyForPredictor, avgExecutionSlippageForPredictor, effectiveV8Probability, executionTelemetry, flushBackendPredictorTrainingBuffer, notional, outcomes, predictorRequestPayload]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void flushBackendPredictorTrainingBuffer();
    }, V8_BACKEND_TRAINING_FLUSH_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [flushBackendPredictorTrainingBuffer]);

  const cycleKernelBenchmark = useCallback(() => {
    setKernelBenchmarkRate((current) => {
      if (current === 0) {
        return 400;
      }
      if (current === 400) {
        return 800;
      }
      return 0;
    });
  }, []);

  // ── OVERLAY COMPUTED VARS ─────────────────────────────────────────────
  const overlayAiDecision = (replayPayload?.ai_decision as JsonMap | undefined) || null;
  const overlayDecisionScore = overlayAiDecision
    ? toNumber(overlayAiDecision.score, 0)
    : toNumber(replayTelemetry?.ai_score, 0);
  const overlayDecisionRegime = (() => {
    const raw = overlayAiDecision?.regime || replayTelemetry?.regime;
    return raw && String(raw) !== "null" ? String(raw) : "–";
  })();
  const overlayDecisionConsensus = overlayAiDecision
    ? toNumber(overlayAiDecision.consensus_pct, 0)
    : toNumber(replayTelemetry?.consensus_pct, 0);
  const overlayDecisionMemorySim = toNumber(
    overlayAiDecision?.memory_similarity ?? replayTelemetry?.memory_similarity,
    0,
  );
  const overlayDecisionMemoryCases = toNumber(
    overlayAiDecision?.memory_cases ?? replayTelemetry?.memory_cases_used,
    0,
  );
  const overlayDecisionRationale = String(
    overlayAiDecision?.rationale || replayTelemetry?.rationale || "",
  );
  const overlayAgentVotes = ((overlayAiDecision?.agent_votes as JsonMap[] | undefined) || []).slice(0, 5);
  const overlayDecisionTs = String(replayTelemetry?.ts_decision || "");
  const overlaySlippageExpected = toNumber(replayTelemetry?.slippage_expected_bps, 0);
  const overlaySlippageDelta = replaySlippage - overlaySlippageExpected;
  const overlayRouteAlt = String(replayTelemetry?.route_alternative || "–");
  const overlayLatDecision = toNumber(replayTelemetry?.latency_decision_ms, 0);
  const overlayLatRouting = toNumber(replayTelemetry?.latency_routing_ms, 0);
  const showDecisionOverlay = replayState.enabled && replayTelemetry !== null;
  const showExecOverlay = replayTelemetry !== null;

  // ── CALIBRATION INTELLIGENCE LAYER ─────────────────────────────────────────
  // Score vs Outcome: find the matching outcome for this decision
  const calibMatchedOutcome = (() => {
    if (!replayDecisionId) return null;
    return filteredOutcomes.find(
      (item) => decisionIdFrom(item) === replayDecisionId,
    ) || filteredOutcomes[0] || null;
  })();
  const calibOutcomePnl = calibMatchedOutcome
    ? toNumber(calibMatchedOutcome.pnl_usd, NaN)
    : NaN;
  const calibOutcomePnlPct = calibMatchedOutcome
    ? toNumber(calibMatchedOutcome.pnl_pct, 0)
    : 0;
  const calibOutcomePositive = Number.isFinite(calibOutcomePnl) && calibOutcomePnl >= 0;
  const calibExpectedPositive = overlayDecisionScore >= 0.5;
  const calibMismatch =
    Number.isFinite(calibOutcomePnl) &&
    overlayDecisionScore > 0 &&
    calibExpectedPositive !== calibOutcomePositive;
  const calibMismatchLabel = calibMismatch
    ? (calibExpectedPositive ? "Expected +, Got −" : "Expected −, Got +")
    : null;

  // Confidence calibration: bucket historical outcomes by score range
  const calibBuckets = (() => {
    const buckets = [
      { label: "0.9+", min: 0.9, wins: 0, total: 0 },
      { label: "0.8", min: 0.8, wins: 0, total: 0 },
      { label: "0.7", min: 0.7, wins: 0, total: 0 },
      { label: "<0.7", min: 0, wins: 0, total: 0 },
    ];
    for (const item of filteredOutcomes) {
      const sc = toNumber(item.ai_score ?? item.score, 0);
      const pnl = toNumber(item.pnl_usd, NaN);
      if (!Number.isFinite(pnl) || sc === 0) continue;
      const bucket = buckets.find((b) => sc >= b.min) || buckets[buckets.length - 1];
      bucket.total++;
      if (pnl >= 0) bucket.wins++;
    }
    return buckets.filter((b) => b.total > 0);
  })();
  const calibBadge = (() => {
    if (!calibBuckets.length || overlayDecisionScore === 0) return null;
    const scoreBucket = calibBuckets.find((b) => {
      const minScore = b.min;
      const nextMin = calibBuckets.find((cb) => cb.min > minScore)?.min ?? 1;
      return overlayDecisionScore >= minScore && overlayDecisionScore < nextMin;
    }) || calibBuckets[calibBuckets.length - 1];
    if (scoreBucket.total < 3) return null;
    const winrate = scoreBucket.wins / scoreBucket.total;
    const scoreIsHigh = overlayDecisionScore >= 0.7;
    if (scoreIsHigh && winrate < 0.45) return "overconfident";
    if (!scoreIsHigh && winrate > 0.65) return "underconfident";
    if (winrate >= 0.45 && winrate <= 0.65) return "well-calibrated";
    return null;
  })();

  // Memory validation: memory-backed winrate and avg pnl
  const calibMemoryWinrate = (() => {
    const withScore = filteredOutcomes.filter(
      (item) => toNumber(item.memory_similarity ?? item.memory_cases, 0) > 0,
    );
    if (withScore.length === 0) return null;
    const wins = withScore.filter((item) => toNumber(item.pnl_usd, NaN) >= 0).length;
    return (wins / withScore.length) * 100;
  })();
  const calibMemoryAvgPnlPct = (() => {
    const withScore = filteredOutcomes.filter(
      (item) => toNumber(item.memory_similarity ?? item.memory_cases, 0) > 0,
    );
    if (withScore.length === 0) return null;
    return average(withScore.map((item) => toNumber(item.pnl_pct, 0)));
  })();
  const calibMemoryPredictWin = overlayDecisionMemorySim >= 0.7 || overlayDecisionMemoryCases >= 3;
  const calibMemoryMismatch = calibMemoryPredictWin && Number.isFinite(calibOutcomePnl) && calibOutcomePnl < 0;

  // Execution vs Decision blame
  const calibBlame = (() => {
    if (!replayTelemetry || !Number.isFinite(calibOutcomePnl)) return null;
    const slipDelta = replaySlippage - overlaySlippageExpected;
    if (overlaySlippageExpected > 0 && slipDelta > overlaySlippageExpected * 0.5) {
      return "bad_execution";
    }
    if (overlayDecisionScore >= 0.7 && calibOutcomePnl < 0) {
      return "bad_decision";
    }
    if (calibOutcomePnl < 0) {
      return "market_noise";
    }
    return null;
  })();
  const activeReplayAttributionId = replayDecisionId || (calibMatchedOutcome ? decisionIdFrom(calibMatchedOutcome) : "") || "";
  const replayAttributionSnapshot = activeReplayAttributionId ? replayAttributionByDecisionId[activeReplayAttributionId] || null : null;
  const replayAttributionHeadline = replayAttributionSnapshot
    ? `${formatFeatureFamilyLabel(replayAttributionSnapshot.topFamily)} ${replayAttributionSnapshot.topContribution >= 0 ? "+" : ""}${replayAttributionSnapshot.topContribution.toFixed(2)} · reward ${replayAttributionSnapshot.reward >= 0 ? "+" : ""}${replayAttributionSnapshot.reward.toFixed(2)}${replayAttributionSnapshot.failureSource ? ` · ${replayAttributionSnapshot.failureSource}${replayAttributionSnapshot.rewardScale < 0.999 ? ` x${replayAttributionSnapshot.rewardScale.toFixed(2)}` : ""}` : ""}`
    : `Live leader ${formatFeatureFamilyLabel(backendBrainFeatureLeader)} ${backendBrainFeatureLeaderContribution >= 0 ? "+" : ""}${backendBrainFeatureLeaderContribution.toFixed(2)}`;
  const replayAttributionPills = replayAttributionSnapshot
    ? [
        ...replayAttributionSnapshot.families.map((family) => `${compactFeatureFamilyLabel(family.family)} ${family.contribution >= 0 ? "+" : ""}${family.contribution.toFixed(2)} · SH ${family.shapLike >= 0 ? "+" : ""}${family.shapLike.toFixed(2)}${family.wrongWay ? " · penalized" : ""}`),
        replayAttributionSnapshot.failureSource
          ? `cause ${replayAttributionSnapshot.failureSource}${replayAttributionSnapshot.failureBlocking ? " · blocked" : ""}${replayAttributionSnapshot.rewardScale < 0.999 ? ` · x${replayAttributionSnapshot.rewardScale.toFixed(2)}` : ""}`
          : "",
        replayAttributionSnapshot.failureReasons[0] ? `why ${replayAttributionSnapshot.failureReasons[0]}` : "",
      ].filter(Boolean)
    : backendBrainAttributionPills;
  const replayAttributionContextLabel = replayAttributionSnapshot?.contextLabel || buildFeatureContextLabel(backendBrainFeatureContext);
  const replayLatentHeadline = replayAttributionSnapshot
    ? `${replayAttributionSnapshot.latentShiftLabel} · shift ${(replayAttributionSnapshot.latentTransition * 100).toFixed(0)}%`
    : `${formatReplayLatentLabel(backendBrainLatentLabel)} · shift ${(backendBrainLatentTransition * 100).toFixed(0)}%`;
  const replayDreamHeadline = replayAttributionSnapshot
    ? buildReplayDreamSummary(replayAttributionSnapshot)
    : `desk ${backendBrainDreamSize} synth · w x${backendBrainDreamWeight.toFixed(2)}`;
  const replayAgentLearningRows = replayAttributionSnapshot?.agentLearningRates || [];
  const replaySlowestAgentLearning = replayAgentLearningRows.length > 0
    ? [...replayAgentLearningRows].sort((left, right) => left.combinedMultiplier - right.combinedMultiplier)[0] || null
    : null;
  const replayFastestAgentLearning = replayAgentLearningRows.length > 0
    ? [...replayAgentLearningRows].sort((left, right) => right.combinedMultiplier - left.combinedMultiplier)[0] || null
    : null;
  const replayAgentLearningHeadline = replaySlowestAgentLearning && replayFastestAgentLearning
    ? `${formatReplayAgentLabel(replaySlowestAgentLearning.agent)} x${replaySlowestAgentLearning.combinedMultiplier.toFixed(2)} slow · ${formatReplayAgentLabel(replayFastestAgentLearning.agent)} x${replayFastestAgentLearning.combinedMultiplier.toFixed(2)} fast`
    : "Agent LR warming up";
  const replayAgentLearningPills = replayAgentLearningRows.map((row) => {
    const familyLead = row.families[0] ? ` · ${row.families[0]}` : "";
    return `${compactReplayAgentLabel(row.agent)} x${row.combinedMultiplier.toFixed(2)} = F${row.featureMultiplier.toFixed(2)} · S${row.failureMultiplier.toFixed(2)}${row.failureSource ? ` · ${row.failureSource}` : ""}${familyLead}`;
  });
  const replayLatentPills = replayAttributionSnapshot
    ? [
        `latent ${compactReplayLatentLabel(replayAttributionSnapshot.latentLabel)}${replayAttributionSnapshot.latentLabel !== replayAttributionSnapshot.latentNextLabel ? ` -> ${compactReplayLatentLabel(replayAttributionSnapshot.latentNextLabel)}` : ""}`,
        `shift ${(replayAttributionSnapshot.latentTransition * 100).toFixed(0)}%`,
        replayAttributionSnapshot.synthetic ? `synthetic x${replayAttributionSnapshot.sampleWeight.toFixed(2)}` : `real x${replayAttributionSnapshot.sampleWeight.toFixed(2)}`,
        replayAttributionSnapshot.dreamCount > 0 ? `spawn ${replayAttributionSnapshot.dreamCount} · x${replayAttributionSnapshot.dreamWeight.toFixed(2)}` : `source ${formatReplayDreamSource(replayAttributionSnapshot.dreamSource)}`,
      ]
    : [
        `latent ${compactReplayLatentLabel(backendBrainLatentLabel)}`,
        `shift ${(backendBrainLatentTransition * 100).toFixed(0)}%`,
        `dream ${backendBrainDreamSize}`,
        `weight x${backendBrainDreamWeight.toFixed(2)}`,
      ];

  // Agent accuracy tracking across historical outcomes
  const calibAgentAccuracy = (() => {
    if (!filteredOutcomes.length) return [] as Array<{ name: string; accuracy: number; total: number }>;
    const agentMap = new Map<string, { wins: number; total: number }>();
    for (const item of filteredOutcomes) {
      const votes = (item.agent_votes as JsonMap[] | undefined) || [];
      const pnl = toNumber(item.pnl_usd, NaN);
      if (!Number.isFinite(pnl)) continue;
      for (const vote of votes) {
        const name = String(vote.agent || vote.name || "?").slice(0, 10);
        const direction = String(vote.direction || vote.vote || "").toLowerCase();
        const side = String(item.side || "").toLowerCase();
        const correct =
          (direction.includes("buy") && side.includes("buy") && pnl >= 0) ||
          (direction.includes("sell") && side.includes("sell") && pnl >= 0);
        const entry = agentMap.get(name) || { wins: 0, total: 0 };
        entry.total++;
        if (correct) entry.wins++;
        agentMap.set(name, entry);
      }
    }
    return [...agentMap.entries()]
      .map(([name, { wins, total }]) => ({ name, accuracy: total > 0 ? (wins / total) * 100 : 0, total }))
      .filter((a) => a.total >= 2)
      .sort((a, b) => b.accuracy - a.accuracy)
      .slice(0, 4);
  })();

  // Trade lifecycle (Decision → Fill → Outcome) with timestamps
  const calibLifecycle = (() => {
    const steps: Array<{ label: string; ts: string; kind: string }> = [];
    if (replayTelemetry?.ts_decision) steps.push({ label: "Decision", ts: String(replayTelemetry.ts_decision), kind: "decision" });
    if (replayTelemetry?.ts_intent) steps.push({ label: "Intent", ts: String(replayTelemetry.ts_intent), kind: "intent" });
    if (replayTelemetry?.ts_routing) steps.push({ label: "Route", ts: String(replayTelemetry.ts_routing), kind: "routing" });
    if (replayTelemetry?.ts_broker_accept) steps.push({ label: "Approval", ts: String(replayTelemetry.ts_broker_accept), kind: "approval" });
    if (replayTelemetry?.ts_fill_partial) steps.push({ label: "Fill", ts: String(replayTelemetry.ts_fill_partial), kind: "fill" });
    if (replayTelemetry?.ts_fill_final || replayFills.length > 0) {
      const ts = String(replayTelemetry?.ts_fill_final || replayFills[replayFills.length - 1]?.executed_at || "");
      if (ts) steps.push({ label: "Final", ts, kind: "fill" });
    }
    if (calibMatchedOutcome) {
      const outcomeTs = pickTimestamp(calibMatchedOutcome, ["executed_at", "filled_at", "closed_at", "created_at"]);
      if (outcomeTs) steps.push({ label: Number.isFinite(calibOutcomePnl) ? `${calibOutcomePnl >= 0 ? "+" : ""}${calibOutcomePnl.toFixed(0)}$` : "Outcome", ts: outcomeTs, kind: calibOutcomePositive ? "outcome-win" : "outcome-loss" });
    }
    return steps.sort((a, b) => {
      const ta = new Date(a.ts).getTime();
      const tb = new Date(b.ts).getTime();
      return ta - tb;
    });
  })();
  const calibLifecycleDurationMs = calibLifecycle.length > 1
    ? Math.max(1, new Date(calibLifecycle[calibLifecycle.length - 1].ts).getTime() - new Date(calibLifecycle[0].ts).getTime())
    : 1;

  // ── DYNAMIC SCORE CORRECTION ─────────────────────────────────────────────────
  // Derive calibration factor: empirical bucket winrate / model score (expected win rate)
  const calibCurrentBucket = (() => {
    if (!calibBuckets.length || overlayDecisionScore === 0) return null;
    // Sort buckets high→low min so the first matching bucket wins correctly
    const sorted = [...calibBuckets].sort((a, b) => b.min - a.min);
    return sorted.find((b) => overlayDecisionScore >= b.min) ?? null;
  })();
  const calibCurrentWinrate =
    calibCurrentBucket && calibCurrentBucket.total >= 3
      ? calibCurrentBucket.wins / calibCurrentBucket.total
      : null;
  // factor = empirical_winrate / model_score  (clipped [0.3 … 1.8] to avoid runaway)
  const calibFactor =
    calibCurrentWinrate !== null && overlayDecisionScore > 0
      ? Math.max(0.3, Math.min(1.8, calibCurrentWinrate / overlayDecisionScore))
      : 1;
  const adjustedScore = Math.max(0, Math.min(1, overlayDecisionScore * calibFactor));
  const scoreWasAdjusted = Math.abs(adjustedScore - overlayDecisionScore) > 0.02;

  // ── AGENT WEIGHTED VOTE (REGIME-AWARE) ────────────────────────────────────────
  const agentWeightedVotes = overlayAgentVotes.map((vote) => {
    const name = String(vote.agent || vote.name || "").slice(0, 10);
    // Use regime-aware accuracy if available, fall back to global
    const regimeAccuracies = calibAgentAccuracyByRegime[overlayDecisionRegime] || [];
    const regimeAccuracy = regimeAccuracies.find((a) => a.name === name)?.accuracy;
    const accuracy = regimeAccuracy ?? calibAgentAccuracy.find((a) => a.name === name)?.accuracy ?? 50;
    const weight = accuracy / 100;
    return { vote, weight, accuracyPct: accuracy };
  });
  const totalWeight = agentWeightedVotes.reduce((s, v) => s + v.weight, 0);
  const weightedBuyScore = agentWeightedVotes
    .filter((v) => String(v.vote.direction || v.vote.vote || "").toLowerCase().includes("buy"))
    .reduce((s, v) => s + v.weight, 0);
  const weightedSellScore = agentWeightedVotes
    .filter((v) => String(v.vote.direction || v.vote.vote || "").toLowerCase().includes("sell"))
    .reduce((s, v) => s + v.weight, 0);
  const weightedConsensus =
    totalWeight > 0
      ? (Math.max(weightedBuyScore, weightedSellScore) / totalWeight) * 100
      : null;

  // ── CONFIDENCE DECAY ─────────────────────────────────────────────────────────
  const decayHighLatency = replayLatency > 300;
  const decayHighVolatility = overlayDecisionRegime === "high";
  const confidenceDecay = (decayHighLatency ? 0.08 : 0) + (decayHighVolatility ? 0.06 : 0);
  const effectiveScore = Math.max(0, adjustedScore - confidenceDecay);

  // ── CONSENSUS PENALTY ────────────────────────────────────────────────────────
  const consensusPenaltyActive =
    (overlayDecisionConsensus > 0 && overlayDecisionConsensus < 40) ||
    (weightedConsensus !== null && weightedConsensus < 40);

  // ── HIGH RISK BADGE ───────────────────────────────────────────────────────────
  // High model confidence but very low memory alignment → uncharted territory
  const isHighRisk =
    overlayDecisionScore >= 0.7 &&
    overlayDecisionMemorySim < 0.4 &&
    overlayDecisionMemoryCases < 2;

  // ── STRATEGY SURVIVAL ENGINE W/ HYSTERESIS ────────────────────────────────────
  // Hysteresis/cooldown: demote/reduce status locked for 48h to prevent oscillation
  const HYSTERESIS_WINDOW_MS = 48 * 60 * 60 * 1000; // 48 hours
  const strategyPerformance = (() => {
    const stratMap = new Map<
      string,
      { wins: number; total: number; pnlSum: number; mismatches: number; regime: string }
    >();
    for (const item of filteredOutcomes) {
      const sid = String(item.strategy_id || "unknown");
      const pnl = toNumber(item.pnl_usd, NaN);
      const sc = toNumber((item.ai_score ?? item.score) as number | undefined, 0);
      const regime = String(item.regime || "unknown");
      if (!Number.isFinite(pnl)) continue;
      const entry = stratMap.get(sid) || { wins: 0, total: 0, pnlSum: 0, mismatches: 0, regime };
      entry.total++;
      if (pnl >= 0) entry.wins++;
      entry.pnlSum += pnl;
      // Mismatch: model expected win (score ≥ 0.5) but got loss
      if (sc >= 0.5 && pnl < 0) entry.mismatches++;
      stratMap.set(sid, entry);
    }
    const now = Date.now();
    return [...stratMap.entries()]
      .map(([id, { wins, total, pnlSum, mismatches, regime }]) => {
        const wr = total > 0 ? wins / total : 0;
        const mismatchRate = total > 0 ? mismatches / total : 0;
        // Calculate live status (what it should be)
        const liveStatus: "demote" | "reduce" | "overconfident" | "ok" = (() => {
          if (wr < 0.35 && total >= 5) return "demote";
          if (wr < 0.45 && total >= 3) return "reduce";
          if (mismatchRate > 0.4 && total >= 4) return "overconfident";
          return "ok";
        })();
        // Apply hysteresis: check if strategy is in cooldown
        const cooldown = strategyCooldowns[id];
        let currentStatus = liveStatus;
        let cooldownRemaining = 0;
        if (liveStatus === "ok" && (cooldown?.demoteTime || cooldown?.reduceTime)) {
          // Strategy wants to exit demote/reduce
          const exitTime = cooldown.demoteTime || cooldown.reduceTime || 0;
          const elapsed = now - exitTime;
          if (elapsed < HYSTERESIS_WINDOW_MS) {
            // Still in cooldown: keep old status
            currentStatus = cooldown.demoteTime ? "demote" : "reduce";
            cooldownRemaining = Math.ceil((HYSTERESIS_WINDOW_MS - elapsed) / (60 * 60 * 1000)); // hours
          }
        }
        // Update cooldown entries when entering demote/reduce
        if (currentStatus === "demote" && !cooldown?.demoteTime) {
          setStrategyCooldowns((prev) => ({
            ...prev,
            [id]: { ...prev[id], demoteTime: now },
          }));
        } else if (currentStatus === "reduce" && !cooldown?.reduceTime && !cooldown?.demoteTime) {
          setStrategyCooldowns((prev) => ({
            ...prev,
            [id]: { ...prev[id], reduceTime: now },
          }));
        }
        return {
          id,
          winrate: wr * 100,
          total,
          avgPnl: total > 0 ? pnlSum / total : 0,
          mismatchRate: mismatchRate * 100,
          status: currentStatus,
          liveStatus,
          cooldownRemaining,
          regime,
        };
      })
      .filter((s) => s.total >= 2)
      .sort((a, b) => b.total - a.total)
      .slice(0, 6);
  })();
  const strategyDemoteCount = strategyPerformance.filter((s) => s.status === "demote").length;
  const strategyReduceCount = strategyPerformance.filter(
    (s) => s.status === "reduce" || s.status === "overconfident",
  ).length;

  // ── REGIME-AWARE CALIBRATION BUCKETS ─────────────────────────────────────────
  // Segment calibration by regime (low/medium/high/unknown) to catch regime-specific overconfidence
  const calibBucketsByRegime = (() => {
    const regimeIndex = new Map<string, typeof calibBuckets>();
    for (const item of filteredOutcomes) {
      const regime = String(item.regime || "unknown");
      const sc = toNumber(item.ai_score ?? item.score, 0);
      const pnl = toNumber(item.pnl_usd, NaN);
      if (!Number.isFinite(pnl) || sc === 0) continue;
      if (!regimeIndex.has(regime)) {
        regimeIndex.set(regime, [
          { label: "0.9+", min: 0.9, wins: 0, total: 0 },
          { label: "0.8", min: 0.8, wins: 0, total: 0 },
          { label: "0.7", min: 0.7, wins: 0, total: 0 },
          { label: "<0.7", min: 0, wins: 0, total: 0 },
        ]);
      }
      const buckets = regimeIndex.get(regime)!;
      const bucket = buckets.find((b) => sc >= b.min) || buckets[buckets.length - 1];
      bucket.total++;
      if (pnl >= 0) bucket.wins++;
    }
    const result: Record<string, typeof calibBuckets> = {};
    for (const [regime, buckets] of regimeIndex.entries()) {
      result[regime] = buckets.filter((b) => b.total > 0);
    }
    return result;
  })();

  // ── REGIME-AWARE AGENT ACCURACY ───────────────────────────────────────────────
  // Track agent prediction accuracy per regime
  const calibAgentAccuracyByRegime = (() => {
    const regimeIndex = new Map<string, Map<string, { wins: number; total: number }>>();
    for (const item of filteredOutcomes) {
      const regime = String(item.regime || "unknown");
      const votes = (item.agent_votes as JsonMap[] | undefined) || [];
      const pnl = toNumber(item.pnl_usd, NaN);
      if (!Number.isFinite(pnl)) continue;
      if (!regimeIndex.has(regime)) {
        regimeIndex.set(regime, new Map());
      }
      const agentMap = regimeIndex.get(regime)!;
      for (const vote of votes) {
        const name = String(vote.agent || vote.name || "?").slice(0, 10);
        const direction = String(vote.direction || vote.vote || "").toLowerCase();
        const side = String(item.side || "").toLowerCase();
        const correct =
          (direction.includes("buy") && side.includes("buy") && pnl >= 0) ||
          (direction.includes("sell") && side.includes("sell") && pnl >= 0);
        const entry = agentMap.get(name) || { wins: 0, total: 0 };
        entry.total++;
        if (correct) entry.wins++;
        agentMap.set(name, entry);
      }
    }
    const result: Record<string, Array<{ name: string; accuracy: number; total: number }>> = {};
    for (const [regime, agentMap] of regimeIndex.entries()) {
      result[regime] = [...agentMap.entries()]
        .map(([name, { wins, total }]) => ({ name, accuracy: total > 0 ? (wins / total) * 100 : 0, total }))
        .filter((a) => a.total >= 2)
        .sort((a, b) => b.accuracy - a.accuracy)
        .slice(0, 5);
    }
    return result;
  })();

  // ── REGIME-AWARE EMA STRATEGY WIN RATE ────────────────────────────────────────
  // EMA WR per strategy per regime for more granular allocation
  const strategyEmaWRByRegime = (() => {
    const regimeIndex = new Map<string, Map<string, number>>();
    const sorted = [...filteredOutcomes]
      .filter((o) => Number.isFinite(toNumber(o.pnl_usd, NaN)))
      .sort((a, b) => {
        const ta = new Date(String(a.executed_at || a.filled_at || "")).getTime() || 0;
        const tb = new Date(String(b.executed_at || b.filled_at || "")).getTime() || 0;
        return ta - tb;
      });
    const EMA_ALPHA = 0.3;
    for (const item of sorted) {
      const regime = String(item.regime || "unknown");
      const sid = String(item.strategy_id || "unknown");
      const win = toNumber(item.pnl_usd, 0) >= 0 ? 1 : 0;
      if (!regimeIndex.has(regime)) {
        regimeIndex.set(regime, new Map());
      }
      const stratMap = regimeIndex.get(regime)!;
      const prev = stratMap.get(sid) ?? 0.5;
      stratMap.set(sid, prev + EMA_ALPHA * (win - prev));
    }
    const result: Record<string, Map<string, number>> = {};
    for (const [regime, stratMap] of regimeIndex.entries()) {
      result[regime] = stratMap;
    }
    return result;
  })();

  // ── BRIER SCORE & CALIBRATION ERROR TRACKING ──────────────────────────────────
  // Quantify model calibration quality and systematic over/under-confidence
  const brierAnalysis = (() => {
    const calcBrier = (items: JsonMap[]) => {
      if (items.length === 0) return { brierScore: null, overconfidence: 0 };
      let brierSum = 0;
      let overconfidenceSum = 0;
      for (const item of items) {
        const score = toNumber(item.ai_score ?? item.score, 0.5);
        const pnl = toNumber(item.pnl_usd, NaN);
        if (!Number.isFinite(pnl)) continue;
        const outcome = pnl >= 0 ? 1 : 0;
        // Brier = (predicted - actual)²
        brierSum += (score - outcome) ** 2;
        // Overconfidence: how much did we overestimate at this score?
        // Positive = overconfident (predicted > actual), Negative = underconfident
        overconfidenceSum += score - outcome;
      }
      return { brierScore: brierSum / items.length, overconfidence: overconfidenceSum / items.length };
    };
    const overall = calcBrier(filteredOutcomes);
    const byRegime: Record<string, { brierScore: number | null; overconfidence: number }> = {};
    for (const regime of Object.keys(calibBucketsByRegime)) {
      const regimeOutcomes = filteredOutcomes.filter((o) => String(o.regime || "unknown") === regime);
      byRegime[regime] = calcBrier(regimeOutcomes);
    }
    return { overall, byRegime };
  })();

  // ── REGIME AUTO-BLOCKING (BRIER DEGRADATION) ───────────────────────────────
  const regimeRiskMonitor = (() => {
    const byRegime: Record<string, {
      recentBrier: number | null;
      previousBrier: number | null;
      delta: number;
      nRecent: number;
      nPrevious: number;
      blocked: boolean;
      reason: string | null;
    }> = {};
    const regimes = new Set(filteredOutcomes.map((o) => String(o.regime || "unknown")));
    for (const regime of regimes) {
      const samples = [...filteredOutcomes]
        .filter((o) => String(o.regime || "unknown") === regime)
        .filter((o) => Number.isFinite(toNumber(o.pnl_usd, NaN)))
        .sort((a, b) => {
          const ta = new Date(String(a.executed_at || a.filled_at || "")).getTime() || 0;
          const tb = new Date(String(b.executed_at || b.filled_at || "")).getTime() || 0;
          return ta - tb;
        });
      const previous = samples.slice(-20, -10);
      const recent = samples.slice(-10);
      const brierOf = (arr: JsonMap[]) => {
        if (!arr.length) return null;
        const sum = arr.reduce((s, it) => {
          const score = toNumber(it.ai_score ?? it.score, 0.5);
          const pnl = toNumber(it.pnl_usd, NaN);
          const out = Number.isFinite(pnl) && pnl >= 0 ? 1 : 0;
          return s + (score - out) ** 2;
        }, 0);
        return sum / arr.length;
      };
      const prevBrier = brierOf(previous);
      const recBrier = brierOf(recent);
      const delta =
        recBrier !== null && prevBrier !== null
          ? recBrier - prevBrier
          : 0;
      const blocked =
        recent.length >= 6 &&
        previous.length >= 6 &&
        recBrier !== null &&
        recBrier > 0.38 &&
        delta > 0.1;
      byRegime[regime] = {
        recentBrier: recBrier,
        previousBrier: prevBrier,
        delta,
        nRecent: recent.length,
        nPrevious: previous.length,
        blocked,
        reason: blocked
          ? `Brier degrade ${prevBrier?.toFixed(2)}→${recBrier?.toFixed(2)} (Δ${delta.toFixed(2)})`
          : null,
      };
    }
    const blockedRegimes = Object.entries(byRegime)
      .filter(([, v]) => v.blocked)
      .map(([k]) => k);
    return { byRegime, blockedRegimes };
  })();
  const isCurrentRegimeBlocked =
    overlayDecisionRegime !== "–" && regimeRiskMonitor.blockedRegimes.includes(overlayDecisionRegime);

  // ── CALIBRATION ERROR BY CONFIDENCE BUCKET ────────────────────────────────────
  // Identify which confidence ranges are over/under-calibrated
  const calibrationErrorBuckets = (() => {
    const buckets = [
      { rangeLabel: "0.0-0.1", min: 0.0, max: 0.1, wins: 0, total: 0 },
      { rangeLabel: "0.1-0.2", min: 0.1, max: 0.2, wins: 0, total: 0 },
      { rangeLabel: "0.2-0.3", min: 0.2, max: 0.3, wins: 0, total: 0 },
      { rangeLabel: "0.3-0.4", min: 0.3, max: 0.4, wins: 0, total: 0 },
      { rangeLabel: "0.4-0.5", min: 0.4, max: 0.5, wins: 0, total: 0 },
      { rangeLabel: "0.5-0.6", min: 0.5, max: 0.6, wins: 0, total: 0 },
      { rangeLabel: "0.6-0.7", min: 0.6, max: 0.7, wins: 0, total: 0 },
      { rangeLabel: "0.7-0.8", min: 0.7, max: 0.8, wins: 0, total: 0 },
      { rangeLabel: "0.8-0.9", min: 0.8, max: 0.9, wins: 0, total: 0 },
      { rangeLabel: "0.9-1.0", min: 0.9, max: 1.0, wins: 0, total: 0 },
    ];
    for (const item of filteredOutcomes) {
      const score = toNumber(item.ai_score ?? item.score, 0);
      const pnl = toNumber(item.pnl_usd, NaN);
      if (!Number.isFinite(pnl)) continue;
      const bucket = buckets.find((b) => score >= b.min && score <= b.max);
      if (bucket) {
        bucket.total++;
        if (pnl >= 0) bucket.wins++;
      }
    }
    // Calculate calibration error = expected WR - actual WR
    // Positive = overconfident (model expected too high), Negative = underconfident
    return buckets.map((b) => {
      const expectedWR = b.min + (b.max - b.min) / 2; // midpoint of range as expected WR
      const actualWR = b.total > 0 ? b.wins / b.total : 0;
      const calibError = expectedWR - actualWR;
      const isOverconfident = calibError > 0.1; // > 10% off
      const isUnderconfident = calibError < -0.1;
      return {
        ...b,
        expectedWR: Math.round(expectedWR * 100),
        actualWR: Math.round(actualWR * 100),
        calibError: Math.round(calibError * 100),
        isOverconfident,
        isUnderconfident,
      };
    }).filter((b) => b.total > 0);
  })();

  // ── PORTFOLIO CORRELATION LAYER ────────────────────────────────────────────────
  // Strategy correlation matrix with shrinkage to prevent overfitting on small samples
  
  // 1. Strategy Pairwise Correlation Matrix (shrinkage-adjusted)
  const strategyCorrelationMatrix = (() => {
    const matrix: Record<string, Record<string, {corr: number; n: number; flag: string}>> = {};
    const strategies = strategyPerformance.filter(s => s.total >= 5); // Only stable strategies
    
    for (const s1 of strategies) {
      if (!matrix[s1.id]) matrix[s1.id] = {};
      
      for (const s2 of strategies) {
        if (s1.id === s2.id) {
          matrix[s1.id][s2.id] = { corr: 1.0, n: s1.total, flag: 'self' };
          continue;
        }
        if (matrix[s1.id][s2.id]) continue; // Already computed
        
        // Get trades for both strategies
        const s1Trades = filteredOutcomes
          .filter(o => o.strategy_id === s1.id)
          .sort((a, b) => {
            const ta = new Date(String(a.executed_at || a.filled_at || "")).getTime() || 0;
            const tb = new Date(String(b.executed_at || b.filled_at || "")).getTime() || 0;
            return ta - tb;
          })
          .slice(-20); // Last 20 trades
        
        const s2Trades = filteredOutcomes
          .filter(o => o.strategy_id === s2.id)
          .sort((a, b) => {
            const ta = new Date(String(a.executed_at || a.filled_at || "")).getTime() || 0;
            const tb = new Date(String(b.executed_at || b.filled_at || "")).getTime() || 0;
            return ta - tb;
          })
          .slice(-20);
        
        // Guard: must have min samples
        if (s1Trades.length < 5 || s2Trades.length < 5) {
          matrix[s1.id][s2.id] = { corr: NaN, n: Math.min(s1Trades.length, s2Trades.length), flag: 'LOW_SAMPLE' };
          continue;
        }
        
        // Align by time: match trades in overlapping windows
        const s1PnL = s1Trades.map(t => toNumber(t.pnl_usd, 0));
        const s2PnL = s2Trades.map(t => toNumber(t.pnl_usd, 0));
        
        // Pearson correlation
        const rawCorr = pearsonCorrelation(s1PnL, s2PnL);
        
        // Guard: correlation must be valid
        if (!Number.isFinite(rawCorr)) {
          matrix[s1.id][s2.id] = { corr: NaN, n: Math.min(s1Trades.length, s2Trades.length), flag: 'INVALID' };
          continue;
        }
        
        // Apply shrinkage to reduce false positives on small n
        const n = Math.min(s1Trades.length, s2Trades.length);
        const shrunkCorr = shrinkageCorrelation(rawCorr, n, 10); // k=10 shrinkage strength
        
        // Classify correlation level
        const flag = Math.abs(shrunkCorr) > 0.7 ? 'REDUNDANT' : Math.abs(shrunkCorr) > 0.5 ? 'MODERATE' : 'INDEPENDENT';
        
        matrix[s1.id][s2.id] = { corr: shrunkCorr, n, flag };
        matrix[s2.id][s1.id] = { corr: shrunkCorr, n, flag }; // Symmetric
      }
    }
    return matrix;
  })();

  // 2. Cluster Detection: Find groups of highly correlated strategies
  const strategyClusterGroups = (() => {
    const visited = new Set<string>();
    const clusters: string[][] = [];
    const strategies = Object.keys(strategyCorrelationMatrix);
    
    for (const strat of strategies) {
      if (visited.has(strat)) continue;
      
      const cluster = [strat];
      visited.add(strat);
      
      for (const other of strategies) {
        if (visited.has(other) || other === strat) continue;
        
        const corrData = strategyCorrelationMatrix[strat]?.[other];
        if (corrData && Math.abs(corrData.corr) > 0.7) {
          cluster.push(other);
          visited.add(other);
        }
      }
      
      if (cluster.length > 1) {
        clusters.push(cluster);
      }
    }
    return clusters;
  })();

  // 3. Market Exposure Mapping will be calculated after allocSoftmax (deferred)
  // 4. Sample Size Confidence will be calculated after allocActiveStratId (deferred)
  
  // 5. Correlation Penalty will be calculated after allocActiveStratId (deferred)

  // ── BAYESIAN SHRINKAGE ────────────────────────────────────────────────────────
  // Prior β=0.5 (50% WR), k=8 (prior strength = 8 equivalent trades)
  // Prevents overfit on small samples while converging to empirical on large ones
  const SHRINK_K = 8;
  const PRIOR_BETA = 0.5;
  const bayesianWR = calibCurrentBucket
    ? (calibCurrentBucket.wins + SHRINK_K * PRIOR_BETA) /
      (calibCurrentBucket.total + SHRINK_K)
    : null;
  const calibFactorBayes =
    bayesianWR !== null && overlayDecisionScore > 0
      ? Math.max(0.3, Math.min(1.8, bayesianWR / overlayDecisionScore))
      : calibFactor;
  const adjustedScoreBayes = Math.max(0, Math.min(1, overlayDecisionScore * calibFactorBayes));
  // Wilson 90% CI — exposes uncertainty to the operator (WR: 62% ±18%)
  const calibWinrateCI =
    calibCurrentBucket && calibCurrentBucket.total >= 2
      ? (() => {
          const n = calibCurrentBucket.total;
          const p = calibCurrentBucket.wins / n;
          const z = 1.645;
          const margin = z * Math.sqrt((p * (1 - p)) / Math.max(1, n));
          return { low: Math.max(0, p - margin), high: Math.min(1, p + margin) };
        })()
      : null;

  // ── MICROSTRUCTURE DECAY ──────────────────────────────────────────────────────
  // Use spread_bps from microstructure API; fall back to latestQuote price-spread ÷ mid
  const microSpreadBps = (() => {
    const fromMicro = toNumber(marketMicro?.spread_bps, NaN);
    if (Number.isFinite(fromMicro)) return fromMicro;
    const ask = toNumber(latestQuote?.ask, 0);
    const bid = toNumber(latestQuote?.bid, 0);
    const mid = ask > 0 && bid > 0 ? (ask + bid) / 2 : 0;
    return mid > 0 ? ((ask - bid) / mid) * 10_000 : 0;
  })();
  const microImbalance = Math.abs(toNumber(marketMicro?.depth_imbalance, 0));
  const decayWideSpread = microSpreadBps > 8;
  const decayExtremeImbalance = microImbalance > 0.6;
  const microDecay = (decayWideSpread ? 0.04 : 0) + (decayExtremeImbalance ? 0.03 : 0);
  // Full effective score = Bayesian-adjusted minus ALL decay sources
  const effectiveScoreFull = Math.max(0, adjustedScoreBayes - confidenceDecay - microDecay);

  // ── EXECUTION QUALITY SCORE ───────────────────────────────────────────────────
  const execQualityScore = replayTelemetry
    ? (() => {
        const slipRatio =
          overlaySlippageExpected > 0 ? replaySlippage / overlaySlippageExpected : 1;
        const latScore =
          replayLatency < 100 ? 1.0
          : replayLatency < 200 ? 0.85
          : replayLatency < 400 ? 0.6
          : 0.3;
        const slipScore =
          slipRatio <= 1.0 ? 1.0
          : slipRatio <= 1.5 ? 0.75
          : slipRatio <= 2.5 ? 0.5
          : 0.2;
        const spreadScore =
          microSpreadBps < 4 ? 1.0
          : microSpreadBps < 8 ? 0.8
          : microSpreadBps < 15 ? 0.55
          : 0.3;
        return (
          latScore * 0.28
          + slipScore * 0.28
          + spreadScore * 0.14
          + venueQualityScore * 0.1
          + replayInfraHealthScore * 0.2
        );
      })()
    : null;
  const execQualityLabel =
    execQualityScore === null ? null
    : execQualityScore >= 0.8 ? "good"
    : execQualityScore >= 0.55 ? "fair"
    : "poor";

  // ── EXTENDED BLAME TAGS ───────────────────────────────────────────────────────
  // regime_mismatch / memory_bias / latency_spike added to existing blame logic
  const extendedBlame: string | null = (() => {
    if (!replayTelemetry || !Number.isFinite(calibOutcomePnl)) return null;
    if (replayLatency > 500) return "latency_spike";
    if (
      calibMatchedOutcome &&
      overlayDecisionRegime !== "–" &&
      String(calibMatchedOutcome.regime || "") !== "" &&
      String(calibMatchedOutcome.regime || "") !== overlayDecisionRegime
    )
      return "regime_mismatch";
    if (calibMemoryMismatch) return "memory_bias";
    return calibBlame;
  })();

  // ── EMA-SMOOTHED STRATEGY WIN RATE ────────────────────────────────────────────
  // Recency-weighted WR (α=0.3) — more stable than raw ratio for allocation weights
  const strategyEmaWR = (() => {
    const EMA_ALPHA = 0.3;
    const emaMap = new Map<string, number>();
    const sorted = [...filteredOutcomes]
      .filter((o) => Number.isFinite(toNumber(o.pnl_usd, NaN)))
      .sort((a, b) => {
        const ta =
          new Date(String(a.executed_at || a.filled_at || "")).getTime() || 0;
        const tb =
          new Date(String(b.executed_at || b.filled_at || "")).getTime() || 0;
        return ta - tb;
      });
    for (const item of sorted) {
      const sid = String(item.strategy_id || "unknown");
      const win = toNumber(item.pnl_usd, 0) >= 0 ? 1 : 0;
      const prev = emaMap.get(sid) ?? 0.5;
      emaMap.set(sid, prev + EMA_ALPHA * (win - prev));
    }
    return emaMap;
  })();

  // ── CONSENSUS GATING ─────────────────────────────────────────────────────────
  const requiresHumanApprovalBase =
    consensusPenaltyActive ||
    isHighRisk ||
    (extendedBlame === "latency_spike" && effectiveScoreFull > 0.6);

  // ── CAPITAL ALLOCATION ENGINE V1 (REGIME-AWARE) ────────────────────────────────
  const ALLOC_GLOBAL_CAP = 0.02;  // 2% max exposure per decision
  const ALLOC_STRAT_CAP  = 0.015; // 1.5% max per strategy
  // Regime fit: how well current regime matches model's training distribution
  const allocRegimeFit =
    overlayDecisionRegime === "low"    ? 1.0
    : overlayDecisionRegime === "medium" ? 0.8
    : overlayDecisionRegime === "high"   ? 0.55
    : 0.7;
  // Regime calibration multiplier: apply Brier-based confidence penalty if regime is poorly calibrated
  const regimeCalibMultiplier = (() => {
    const regimeBrier = brierAnalysis.byRegime[overlayDecisionRegime];
    if (!regimeBrier?.brierScore) return 1.0;
    // Brier score 0.25 = perfect, 0.5 = random, clamp to [0.15, 0.5]
    const brier = Math.max(0.15, Math.min(0.5, regimeBrier.brierScore));
    // Map: 0.15 (perfect) → 1.0x, 0.5 (random) → 0.5x
    return 1.0 - (brier - 0.15) / (0.35);
  })();
  const allocActiveStratId = calibMatchedOutcome
    ? String(calibMatchedOutcome.strategy_id || "")
    : "";
  const allocActiveStrat = strategyPerformance.find((s) => s.id === allocActiveStratId);
  const allocDrawdownPenalty =
    allocActiveStrat?.status === "demote"        ? 0.8
    : allocActiveStrat?.status === "reduce"       ? 0.45
    : allocActiveStrat?.status === "overconfident" ? 0.25
    : 0;
  // Use regime-aware EMA WR if available, fall back to global
  const allocEmaWR = allocActiveStratId
    ? (strategyEmaWRByRegime[overlayDecisionRegime]?.get(allocActiveStratId) ?? strategyEmaWR.get(allocActiveStratId) ?? 0.5)
    : 0.5;
  const allocHealthWeight = Math.max(0.1, allocEmaWR * 1.6 - 0.3);
  const allocHighRiskFactor = isHighRisk ? 0.5 : 1.0;
  // Initial raw signal (before correlation/sample penalties, which are computed later)
  const allocRawSignalBase =
    effectiveScoreFull *
    allocRegimeFit *
    regimeCalibMultiplier *
    (1 - allocDrawdownPenalty) *
    allocHealthWeight *
    allocHighRiskFactor;
  // Softmax distribution across strategies (temperature=3 sharpens winners)
  const allocSoftmax = (() => {
    if (!strategyPerformance.length)
      return [] as Array<{ id: string; pct: number; factors?: Record<string, number> }>;
    const TEMP = 3;
    const entries = strategyPerformance.map((s) => {
      // Use regime-aware EMA WR
      const ew = strategyEmaWRByRegime[overlayDecisionRegime]?.get(s.id) ?? strategyEmaWR.get(s.id) ?? s.winrate / 100;
      const pen =
        s.status === "demote"        ? 0.1
        : s.status === "reduce"       ? 0.5
        : s.status === "overconfident" ? 0.65
        : 1.0;
      return { id: s.id, raw: Math.max(0.001, ew * pen) };
    });
    const expSum = entries.reduce((sum, e) => sum + Math.exp(e.raw * TEMP), 0);
    return entries.map((e) => ({
      id: e.id,
      pct: Math.min(
        ALLOC_STRAT_CAP * 100,
        expSum > 0 ? (Math.exp(e.raw * TEMP) / expSum) * ALLOC_GLOBAL_CAP * 100 * 2 : 0,
      ),
    }));
  })();

  // ── DEFERRED CALCULATIONS (after allocSoftmax and allocActiveStratId) ──────
  
  // 3. Market Exposure Mapping (weighted by allocation)
  const marketExposureByCluster = (() => {
    const markets = ['crypto', 'fx', 'indices', 'cfd', 'futures'];
    const result: Record<string, {
      exposure: number;
      strategyCount: number;
      cap: number;
      flag: boolean;
      flagLabel: string;
    }> = {};
    
    for (const market of markets) {
      const activaStratsInMarket = strategyPerformance.filter(s => {
        const outcomes = filteredOutcomes.filter(o => o.strategy_id === s.id);
        return outcomes.some(o => classifyInstrument(instrumentLabel(o)) === market);
      });
      
      // Calculate exposure: sum of allocations for strategies in this market
      const totalExposure = activaStratsInMarket.reduce((sum, s) => {
        const alloc = allocSoftmax.find(a => a.id === s.id)?.pct || 0;
        return sum + alloc / 100; // Convert pct to decimal
      }, 0);
      
      const cap = 0.04; // 4% max per market
      const flag = totalExposure > cap;
      
      result[market] = {
        exposure: totalExposure,
        strategyCount: activaStratsInMarket.length,
        cap,
        flag,
        flagLabel: flag ? `⚠️ OVER CAP (${(totalExposure * 100).toFixed(1)}% > 4%)` : `✓ ${(totalExposure * 100).toFixed(1)}%`,
      };
    }
    return result;
  })();

  // 4. Sample Size Confidence Intervals (per active strategy)
  const sampleConfidenceInfo = (() => {
    if (!allocActiveStratId) return null;
    
    const outcomes = filteredOutcomes.filter(o => o.strategy_id === allocActiveStratId);
    const n = outcomes.filter(o => Number.isFinite(toNumber(o.pnl_usd, NaN))).length;
    
    if (n === 0) return null;
    
    const wins = outcomes.filter(o => toNumber(o.pnl_usd, 0) >= 0).length;
    const wr = wins / n;
    
    // Determine confidence tier
    let tier: 'LOW' | 'MEDIUM' | 'HIGH' = 'HIGH';
    let allocModifier = 1.0;
    let displayLabel = `✓ (n=${n})`;
    
    if (n < 5) {
      tier = 'LOW';
      allocModifier = 0.5; // Cap at 50%
      displayLabel = `⚠️ LOW SAMPLE (n=${n}, 50% cap)`;
    } else if (n < 15) {
      tier = 'MEDIUM';
      allocModifier = 0.75; // Cap at 75%
      displayLabel = `⚠️ LOW CONF (n=${n}, 75% cap)`;
    }
    
    const ci = confidenceInterval(wr, n, 1.96); // 95% CI
    
    return {
      n,
      wr,
      wrPct: Math.round(wr * 100),
      ciLow: Math.round(ci.low * 100),
      ciHigh: Math.round(ci.high * 100),
      ciWidth: Math.round(ci.width * 100),
      tier,
      allocModifier,
      displayLabel,
    };
  })();

  // 5. Correlation Penalty (sigmoid-like formula - smooth, stable)
  const corrPenalty = (() => {
    // Find all strategies correlated with active strategy
    if (!allocActiveStratId) return 0;
    
    const correlatedStrategies = Object.keys(strategyCorrelationMatrix[allocActiveStratId] || {})
      .filter(otherId => {
        const data = strategyCorrelationMatrix[allocActiveStratId]?.[otherId];
        return data && Math.abs(data.corr) > 0.7; // Only high correlation
      })
      .filter(otherId => {
        // Only penalize if we also have low sample for either
        const data = strategyCorrelationMatrix[allocActiveStratId]?.[otherId];
        return !data?.flag?.includes('LOW_SAMPLE');
      });
    
    if (correlatedStrategies.length === 0) return 0;
    
    // Sum allocations of correlated strategies
    const correlatedAllocSum = correlatedStrategies.reduce((sum, otherId) => {
      const alloc = allocSoftmax.find(a => a.id === otherId)?.pct || 0;
      return sum + alloc / 100;
    }, 0);
    
    // Current strategy allocation
    const currentAlloc = (allocSoftmax.find(a => a.id === allocActiveStratId)?.pct || 0) / 100;
    
    // Total cluster size
    const clusterSize = correlatedAllocSum + currentAlloc;
    
    // Sigmoid-like penalty: 1 - exp(-2 * (clusterSize / 5%))
    // asymptotic to 1.0, smooth, no jumps
    const penalty = sigmoidPenalty(clusterSize / 0.05, 2);
    
    // Cap at 0.4 to avoid extinction
    return Math.min(0.4, penalty);
  })();

  // ── META-RISK OFFICER ───────────────────────────────────────────────────────
  const metaRiskOfficer = (() => {
    let health = 1;
    const issues: string[] = [];
    const runbooks: Array<{ type: string; severity: "low" | "medium" | "high" | "critical"; auto: boolean; recommendedAction: string }> = [];

    const overallBrier = brierAnalysis.overall.brierScore;
    if (overallBrier !== null && overallBrier > 0.35) {
      health -= 0.2;
      issues.push("brier_high");
      runbooks.push({ type: "calibration_drift", severity: "high", auto: false, recommendedAction: "raise confidence threshold + reduce size" });
    }

    const currentRegimeRisk = regimeRiskMonitor.byRegime[overlayDecisionRegime];
    if (currentRegimeRisk?.blocked) {
      health -= 0.22;
      issues.push("regime_blocked");
      runbooks.push({ type: "regime_block", severity: "critical", auto: true, recommendedAction: `block regime ${overlayDecisionRegime}` });
    }

    const maxClusterExposure = Object.values(marketExposureByCluster).reduce((m, e) => Math.max(m, e.exposure), 0);
    if (maxClusterExposure > 0.05) {
      health -= 0.18;
      issues.push("cluster_concentration");
      runbooks.push({ type: "cluster_exposure", severity: "high", auto: false, recommendedAction: "reduce correlated strategies exposure" });
    }

    const cooldownCount = strategyPerformance.filter((s) => s.cooldownRemaining > 0).length;
    if (cooldownCount >= 3) {
      health -= 0.12;
      issues.push("strategy_churn");
      runbooks.push({ type: "strategy_churn", severity: "medium", auto: false, recommendedAction: "freeze new strategy promotions" });
    }

    if (venueQualityScore < 0.55) {
      health -= 0.15;
      issues.push("venue_degradation");
      runbooks.push({ type: "venue_degradation", severity: "high", auto: false, recommendedAction: "switch broker / route backup" });
    }

    if (consensusPenaltyActive) {
      health -= 0.08;
      issues.push("consensus_unstable");
    }

    // Health momentum: EMA(10) - EMA(30) on decision quality proxy
    const healthProxySeries = [...filteredOutcomes]
      .filter((o) => Number.isFinite(toNumber(o.pnl_usd, NaN)))
      .sort((a, b) => {
        const ta = new Date(String(a.executed_at || a.filled_at || "")).getTime() || 0;
        const tb = new Date(String(b.executed_at || b.filled_at || "")).getTime() || 0;
        return ta - tb;
      })
      .slice(-80)
      .map((o) => {
        const score = toNumber(o.ai_score ?? o.score, 0.5);
        const pnl = toNumber(o.pnl_usd, NaN);
        const outcome = Number.isFinite(pnl) && pnl >= 0 ? 1 : 0;
        const brier = (score - outcome) ** 2;
        return Math.max(0, 1 - brier * 1.3);
      });
    const ema10 = emaLast(healthProxySeries, 10);
    const ema30 = emaLast(healthProxySeries, 30);
    const healthMomentum = ema10 - ema30;
    if (healthMomentum < -0.05) {
      health -= 0.1;
      issues.push("health_downtrend");
      runbooks.push({ type: "health_momentum_drop", severity: "medium", auto: false, recommendedAction: "tighten approval and reduce aggressiveness" });
    }

    const bounded = Math.max(0.1, Math.min(1, health));
    const tier =
      bounded < 0.25 ? "kill-switch"
      : bounded < 0.35 ? "force-suggest"
      : bounded < 0.5 ? "critical"
      : bounded < 0.7 ? "high"
      : bounded < 0.85 ? "medium"
      : "normal";
    const globalCapitalMultiplier =
      tier === "kill-switch" ? 0
      : tier === "force-suggest" ? 0.25
      : tier === "critical" ? 0.5
      : tier === "high" ? 0.7
      : tier === "medium" ? 0.85
      : 1;
    const mustHumanApprove = tier !== "normal";
    return {
      healthScore: bounded,
      healthMomentum,
      tier,
      globalCapitalMultiplier,
      mustHumanApprove,
      issues,
      runbooks,
    };
  })();

  useEffect(() => {
    const blockedRegimes = regimeRiskMonitor.blockedRegimes;
    const blockedRegimesKey = blockedRegimes.slice().sort().join("|");
    const venueLabel = activeVenueMetrics?.venue || "n/a";
    const current = {
      tier: metaRiskOfficer.tier,
      capitalMultiplier: metaRiskOfficer.globalCapitalMultiplier,
      blockedRegimesKey,
      venueLabel,
    };

    if (!metaRiskPrevRef.current) {
      metaRiskPrevRef.current = current;
      return;
    }

    const previous = metaRiskPrevRef.current;
    const changed =
      previous.tier !== current.tier ||
      Math.abs(previous.capitalMultiplier - current.capitalMultiplier) > 0.001 ||
      previous.blockedRegimesKey !== current.blockedRegimesKey ||
      previous.venueLabel !== current.venueLabel;

    if (!changed) return;

    const reasons: string[] = [];
    if (previous.tier !== current.tier) reasons.push(`tier ${previous.tier}→${current.tier}`);
    if (Math.abs(previous.capitalMultiplier - current.capitalMultiplier) > 0.001) {
      reasons.push(`capital ${(previous.capitalMultiplier * 100).toFixed(0)}→${(current.capitalMultiplier * 100).toFixed(0)}%`);
    }
    if (previous.blockedRegimesKey !== current.blockedRegimesKey) {
      reasons.push(current.blockedRegimesKey ? `blocked regimes: ${current.blockedRegimesKey}` : "regime blocks cleared");
    }
    if (previous.venueLabel !== current.venueLabel) reasons.push(`venue ${previous.venueLabel}→${current.venueLabel}`);
    if (metaRiskOfficer.issues.length) reasons.push(`issues: ${metaRiskOfficer.issues.join(",")}`);

    const timestampIso = new Date().toISOString();
    const event: MetaRiskAuditEvent = {
      id: `${timestampIso}-${current.tier}-${Math.round(current.capitalMultiplier * 100)}`,
      timestampIso,
      tierFrom: previous.tier,
      tierTo: current.tier,
      capitalFromPct: previous.capitalMultiplier * 100,
      capitalToPct: current.capitalMultiplier * 100,
      reason: reasons.join(" · "),
      healthScore: metaRiskOfficer.healthScore,
      blockedRegimes,
      venue: venueLabel,
    };

    setMetaRiskAuditTrail((prev) => [event, ...prev].slice(0, 40));
    metaRiskPrevRef.current = current;
  }, [
    activeVenueMetrics?.venue,
    metaRiskOfficer.globalCapitalMultiplier,
    metaRiskOfficer.healthScore,
    metaRiskOfficer.issues,
    metaRiskOfficer.tier,
    regimeRiskMonitor.blockedRegimes,
  ]);

  useEffect(() => {
    setMetaRiskHealthHistory((prev) => [...prev, metaRiskOfficer.healthScore].slice(-30));
  }, [metaRiskOfficer.healthScore]);

  // Now apply sample modifier and correlation penalty to final allocation signal
  const allocSampleModifier = sampleConfidenceInfo?.allocModifier ?? 1.0;
  const allocRegimeBlockMultiplier = isCurrentRegimeBlocked ? 0 : 1;
  const allocMetaRiskMultiplier = metaRiskOfficer.globalCapitalMultiplier;
  const allocRawSignal =
    allocRawSignalBase *
    (1 - corrPenalty) *
    allocSampleModifier *
    venueQualityMultiplier *
    allocRegimeBlockMultiplier *
    allocMetaRiskMultiplier;

  const requiresHumanApproval =
    requiresHumanApprovalBase ||
    isCurrentRegimeBlocked ||
    metaRiskOfficer.mustHumanApprove;

  const filteredMetaRiskAuditTrail = metaRiskAuditShowOnlyDrops
    ? metaRiskAuditTrail.filter((evt) => evt.capitalToPct < evt.capitalFromPct)
    : metaRiskAuditTrail;
  const sortedMetaRiskAuditTrail = (() => {
    const rows = [...filteredMetaRiskAuditTrail];
    if (metaRiskAuditDropSort === "largest") {
      rows.sort((a, b) => {
        const dropA = a.capitalFromPct - a.capitalToPct;
        const dropB = b.capitalFromPct - b.capitalToPct;
        if (Math.abs(dropB - dropA) > 0.001) return dropB - dropA;
        return new Date(b.timestampIso).getTime() - new Date(a.timestampIso).getTime();
      });
      return rows;
    }
    rows.sort((a, b) => new Date(b.timestampIso).getTime() - new Date(a.timestampIso).getTime());
    return rows;
  })();

  const portfolioRiskV3 = (() => {
    const pnlPctSeries = filteredOutcomes
      .map((item) => toNumber(item.pnl_pct, NaN))
      .filter((value) => Number.isFinite(value));
    const pnlUsdSeries = filteredOutcomes
      .map((item) => toNumber(item.pnl_usd, NaN))
      .filter((value) => Number.isFinite(value));
    const sortedPct = [...pnlPctSeries].sort((a, b) => a - b);
    const sortedUsd = [...pnlUsdSeries].sort((a, b) => a - b);
    const tailCount = Math.max(1, Math.floor(sortedPct.length * 0.05));
    const var95Pct = sortedPct.length ? quantileSortedAsc(sortedPct, 0.05) : 0;
    const es95Pct = sortedPct.length ? average(sortedPct.slice(0, tailCount)) : 0;
    const var95Usd = sortedUsd.length ? quantileSortedAsc(sortedUsd, 0.05) : 0;
    const es95Usd = sortedUsd.length ? average(sortedUsd.slice(0, Math.max(1, Math.floor(sortedUsd.length * 0.05)))) : 0;

    const byMarket: Record<string, number> = { crypto: 0, fx: 0, indices: 0, cfd: 0, futures: 0, other: 0 };
    let grossExposureUsd = 0;
    let netExposureUsd = 0;
    for (const pos of positions) {
      const notional = toNumber(pos.net_notional_usd, 0);
      const absNotional = Math.abs(notional);
      const market = classifyInstrument(instrumentLabel(pos));
      byMarket[market] = (byMarket[market] || 0) + absNotional;
      grossExposureUsd += absNotional;
      netExposureUsd += notional;
    }

    const marketShareRows = Object.entries(byMarket)
      .filter(([, usd]) => usd > 0)
      .map(([market, usd]) => ({ market, usd, share: grossExposureUsd > 0 ? usd / grossExposureUsd : 0 }))
      .sort((a, b) => b.usd - a.usd);
    const topMarket = marketShareRows[0] || null;

    const riskByMarket = ["crypto", "fx", "indices", "cfd", "futures", "other"]
      .map((market) => {
        const marketOutcomes = filteredOutcomes.filter(
          (item) => classifyInstrument(instrumentLabel(item)) === market,
        );
        const pct = marketOutcomes
          .map((item) => toNumber(item.pnl_pct, NaN))
          .filter((value) => Number.isFinite(value))
          .sort((a, b) => a - b);
        const usd = marketOutcomes
          .map((item) => toNumber(item.pnl_usd, NaN))
          .filter((value) => Number.isFinite(value))
          .sort((a, b) => a - b);
        const tail = Math.max(1, Math.floor(pct.length * 0.05));
        return {
          market,
          sample: pct.length,
          var95Pct: pct.length ? quantileSortedAsc(pct, 0.05) : 0,
          es95Pct: pct.length ? average(pct.slice(0, tail)) : 0,
          var95Usd: usd.length ? quantileSortedAsc(usd, 0.05) : 0,
          es95Usd: usd.length ? average(usd.slice(0, Math.max(1, Math.floor(usd.length * 0.05)))) : 0,
        };
      })
      .filter((row) => row.sample > 0)
      .sort((a, b) => b.sample - a.sample);

    const activeId = allocActiveStratId;
    let dynamicCorrMax = 0;
    let dynamicCorrMean = 0;
    let dynamicCorrPeers = 0;
    if (activeId) {
      const activeSeriesRaw = filteredOutcomes
        .filter((o) => String(o.strategy_id || "") === activeId)
        .map((o) => toNumber(o.pnl_pct, NaN))
        .filter((v) => Number.isFinite(v));
      const activeSeries = activeSeriesRaw.slice(-24);
      const corrAbsValues: number[] = [];

      for (const s of strategyPerformance) {
        if (s.id === activeId) continue;
        const peerSeriesRaw = filteredOutcomes
          .filter((o) => String(o.strategy_id || "") === s.id)
          .map((o) => toNumber(o.pnl_pct, NaN))
          .filter((v) => Number.isFinite(v));
        const peerSeries = peerSeriesRaw.slice(-24);
        const n = Math.min(activeSeries.length, peerSeries.length);
        if (n < 6) continue;
        const corr = pearsonCorrelation(activeSeries.slice(-n), peerSeries.slice(-n));
        if (!Number.isFinite(corr)) continue;
        corrAbsValues.push(Math.abs(corr));
      }

      if (corrAbsValues.length) {
        dynamicCorrPeers = corrAbsValues.length;
        dynamicCorrMax = Math.max(...corrAbsValues);
        dynamicCorrMean = average(corrAbsValues);
      }
    }

    return {
      sampleSize: sortedPct.length,
      var95Pct,
      es95Pct,
      var95Usd,
      es95Usd,
      grossExposureUsd,
      netExposureUsd,
      marketShareRows,
      topMarket,
      riskByMarket,
      dynamicCorrMax,
      dynamicCorrMean,
      dynamicCorrPeers,
    };
  })();

  const learningLoopShadow = (() => {
    const stable = strategyPerformance.filter((s) => s.total >= 8);
    if (!stable.length) return [] as Array<{
      id: string;
      wr: number;
      pnlPerTrade: number;
      confidence: number;
      score: number;
      targetWeightPct: number;
      deltaVsEqualPct: number;
      recommendation: "increase" | "decrease" | "hold";
    }>;

    const scored = stable.map((s) => {
      const wr = Math.max(0, Math.min(1, s.winrate / 100));
      const pnlPerTrade = s.avgPnl;
      const conf = Math.max(0, Math.min(1, s.total / 40));
      const pnlNorm = 1 / (1 + Math.exp(-pnlPerTrade / 120));
      const score = Math.max(0.0001, (wr * 0.65 + pnlNorm * 0.35) * (0.6 + conf * 0.4));
      return { id: s.id, wr, pnlPerTrade, confidence: conf, score };
    });

    const sumScore = scored.reduce((sum, row) => sum + row.score, 0);
    const equalWeightPct = 100 / scored.length;
    return scored
      .map((row) => {
        const targetWeightPct = sumScore > 0 ? (row.score / sumScore) * 100 : equalWeightPct;
        const deltaVsEqualPct = targetWeightPct - equalWeightPct;
        const recommendation =
          deltaVsEqualPct > 2 ? "increase"
          : deltaVsEqualPct < -2 ? "decrease"
          : "hold";
        return {
          ...row,
          targetWeightPct,
          deltaVsEqualPct,
          recommendation,
        };
      })
      .sort((a, b) => b.targetWeightPct - a.targetWeightPct)
      .slice(0, 8);
  })();

  const investorSnapshot = {
    generatedAt: new Date().toISOString(),
    riskEngineV3: portfolioRiskV3,
    metaRiskOfficer: {
      tier: metaRiskOfficer.tier,
      healthScore: metaRiskOfficer.healthScore,
      globalCapitalMultiplier: metaRiskOfficer.globalCapitalMultiplier,
      issues: metaRiskOfficer.issues,
    },
    regimeBlock: {
      blockedRegimes: regimeRiskMonitor.blockedRegimes,
    },
    allocation: {
      rawSignal: allocRawSignal,
      corrPenalty,
      sampleModifier: allocSampleModifier,
      venueQualityMultiplier,
      regimeBlockMultiplier: allocRegimeBlockMultiplier,
      metaRiskMultiplier: allocMetaRiskMultiplier,
    },
  };

  const autoTuningRecommendations = learningLoopShadow.map((row) => ({
    strategyId: row.id,
    targetWeightPct: Number(row.targetWeightPct.toFixed(2)),
    confidence: Number(row.confidence.toFixed(3)),
    recommendation: row.recommendation,
    rationale: `wr=${(row.wr * 100).toFixed(1)}%, pnl/trade=${row.pnlPerTrade.toFixed(1)}`,
  }));

  const effectiveAutoTuningRecommendations = (() => {
    let rows = autoTuningRecommendations
      .filter((row) => (row.confidence ?? 1) >= autoTuningMinConfidence)
      .slice(0, autoTuningMaxRecommendations)
      .map((row) => ({
        ...row,
        targetWeightPct: Math.max(autoTuningWeightFloorPct, Math.min(autoTuningWeightCapPct, row.targetWeightPct)),
      }));

    if (autoTuningRenormalize && rows.length > 0) {
      const total = rows.reduce((sum, row) => sum + row.targetWeightPct, 0);
      if (total > 0) {
        rows = rows.map((row) => ({
          ...row,
          targetWeightPct: Number(((row.targetWeightPct / total) * 100).toFixed(4)),
        }));
      }
    }
    return rows;
  })();

  const autoTuningDiffPreview = effectiveAutoTuningRecommendations
    .map((rec) => {
      const fromPct = allocSoftmax.find((a) => a.id === rec.strategyId)?.pct || 0;
      const toPct = rec.targetWeightPct;
      return {
        strategyId: rec.strategyId,
        fromPct,
        toPct,
        deltaPct: toPct - fromPct,
      };
    })
    .sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct))
    .slice(0, 10);

  const shadowApplyMetrics = (() => {
    const wrByStrategy = new Map(strategyPerformance.map((s) => [s.id, s.winrate / 100]));
    const pnlByStrategy = new Map(strategyPerformance.map((s) => [s.id, s.avgPnl]));
    const currentRows = allocSoftmax.filter((row) => wrByStrategy.has(row.id));
    const shadowRows = effectiveAutoTuningRecommendations.filter((row) => wrByStrategy.has(row.strategyId));

    const currentWeight = currentRows.reduce((sum, row) => sum + row.pct, 0);
    const shadowWeight = shadowRows.reduce((sum, row) => sum + row.targetWeightPct, 0);

    const currentWr = currentWeight > 0
      ? currentRows.reduce((sum, row) => sum + row.pct * (wrByStrategy.get(row.id) || 0), 0) / currentWeight
      : 0;
    const shadowWr = shadowWeight > 0
      ? shadowRows.reduce((sum, row) => sum + row.targetWeightPct * (wrByStrategy.get(row.strategyId) || 0), 0) / shadowWeight
      : 0;

    const currentPnl = currentWeight > 0
      ? currentRows.reduce((sum, row) => sum + row.pct * (pnlByStrategy.get(row.id) || 0), 0) / currentWeight
      : 0;
    const shadowPnl = shadowWeight > 0
      ? shadowRows.reduce((sum, row) => sum + row.targetWeightPct * (pnlByStrategy.get(row.strategyId) || 0), 0) / shadowWeight
      : 0;

    const currentHhi = currentRows.reduce((sum, row) => sum + Math.pow(row.pct / 100, 2), 0);
    const shadowHhi = shadowRows.reduce((sum, row) => sum + Math.pow(row.targetWeightPct / 100, 2), 0);

    return {
      currentWr,
      shadowWr,
      deltaWr: shadowWr - currentWr,
      currentPnl,
      shadowPnl,
      deltaPnl: shadowPnl - currentPnl,
      currentHhi,
      shadowHhi,
      deltaHhi: shadowHhi - currentHhi,
      sampleStrategies: currentRows.length,
    };
  })();

  const rollbackGuard = (() => {
    if (!rollbackGuardSession) {
      return {
        active: false,
        elapsedMin: 0,
        remainingMin: 0,
        healthDrop: 0,
        brierRise: 0,
        degradeHealth: false,
        degradeBrier: false,
        shouldProposeRollback: false,
      };
    }
    const now = Date.now();
    const startedAt = new Date(rollbackGuardSession.startedAtIso).getTime();
    const elapsedMin = Math.max(0, (now - startedAt) / 60000);
    const remainingMin = Math.max(0, rollbackGuardWindowMin - elapsedMin);
    const baselineHealth = rollbackGuardSession.baselineHealth;
    const baselineBrier = rollbackGuardSession.baselineBrier;
    const currentHealth = metaRiskOfficer.healthScore;
    const currentBrier = brierAnalysis.overall.brierScore;

    const healthDrop = Math.max(0, baselineHealth - currentHealth);
    const brierRise = baselineBrier !== null && currentBrier !== null
      ? Math.max(0, currentBrier - baselineBrier)
      : 0;
    const degradeHealth = healthDrop >= rollbackGuardHealthDrop;
    const degradeBrier = brierRise >= rollbackGuardBrierRise;
    const active = remainingMin > 0;
    const shouldProposeRollback = active && (degradeHealth || degradeBrier);

    return {
      active,
      elapsedMin,
      remainingMin,
      healthDrop,
      brierRise,
      degradeHealth,
      degradeBrier,
      shouldProposeRollback,
    };
  })();

  const rollbackProposalRecommendations = rollbackGuardSession
    ? rollbackGuardSession.baselineWeights.map((row) => ({
      strategyId: row.strategyId,
      targetWeightPct: Number(row.pct.toFixed(2)),
      confidence: 1,
      recommendation: "rollback",
      rationale: "rollback_guard_baseline",
    }))
    : [];

  async function refreshRollbackGuardState(): Promise<void> {
    if (!AUTO_TUNING_WRITEBACK_ENABLED) return;
    try {
      const response = await fetch("/api/strategies/auto-tuning/rollback-guard", { cache: "no-store" });
      if (!response.ok) return;
      const payload = await response.json();
      const active = (payload?.activeSession || null) as RollbackGuardSession | null;
      const history = (Array.isArray(payload?.history) ? payload.history : []) as RollbackGuardSession[];
      setRollbackGuardSession(active);
      setRollbackGuardHistory(history.slice(0, 20));
      if (active) {
        setRollbackGuardWindowMin(Math.max(10, Math.min(480, Math.round(active.windowMin || rollbackGuardWindowMin))));
        setRollbackGuardHealthDrop(Math.max(0.01, Math.min(0.5, active.healthDropThreshold || rollbackGuardHealthDrop)));
        setRollbackGuardBrierRise(Math.max(0.005, Math.min(0.2, active.brierRiseThreshold || rollbackGuardBrierRise)));
      }
    } catch {
      // Optional ops sync; keep UI functional if backend state can't be read.
    }
  }

  async function submitAutoTuningWriteback(
    dryRun: boolean,
    overrideRecommendations?: Array<{
      strategyId: string;
      targetWeightPct: number;
      confidence?: number;
      recommendation?: string;
      rationale?: string;
    }>,
    reasonOverride?: string,
  ): Promise<void> {
    const recommendations = overrideRecommendations && overrideRecommendations.length > 0
      ? overrideRecommendations
      : effectiveAutoTuningRecommendations;

    if (!AUTO_TUNING_WRITEBACK_ENABLED || autoTuningBusy || recommendations.length === 0) {
      return;
    }
    setAutoTuningBusy(true);
    setAutoTuningStatus("");
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (autoTuningIdempotencyKey.trim()) {
        headers["x-idempotency-key"] = autoTuningIdempotencyKey.trim();
      }
      if (autoTuningAdminKey.trim()) {
        headers["x-auto-tuning-admin-key"] = autoTuningAdminKey.trim();
      }
      const requestPayload = {
        dryRun,
        reason: reasonOverride || "mission-control learning loop",
        recommendations,
        minConfidence: autoTuningMinConfidence,
        maxRecommendations: autoTuningMaxRecommendations,
        weightFloorPct: autoTuningWeightFloorPct,
        weightCapPct: autoTuningWeightCapPct,
        renormalizeTo100: autoTuningRenormalize,
      };
      const bodyText = JSON.stringify(requestPayload);
      const response = await fetch("/api/strategies/auto-tuning", {
        method: "POST",
        headers,
        body: bodyText,
      });
      const payload = await response.json();
      if (!response.ok) {
        setAutoTuningStatus(`Write-back refused (${response.status})`);
        return;
      }
      setAutoTuningStatus(String(payload?.message || (dryRun ? "Dry-run accepted" : "Write-back accepted")));
      if (!dryRun) {
        const sessionPayload: RollbackGuardSession = {
          id: `rg-${Date.now()}`,
          startedAtIso: new Date().toISOString(),
          baselineHealth: metaRiskOfficer.healthScore,
          baselineBrier: brierAnalysis.overall.brierScore,
          baselineWeights: allocSoftmax.map((row) => ({ strategyId: row.id, pct: row.pct })),
          windowMin: rollbackGuardWindowMin,
          healthDropThreshold: rollbackGuardHealthDrop,
          brierRiseThreshold: rollbackGuardBrierRise,
          source: "mission-control-ui",
          reason: "writeback-apply",
          status: "active",
          observations: [],
        };
        setRollbackGuardSession(sessionPayload);
        await fetch("/api/strategies/auto-tuning/rollback-guard", {
          method: "POST",
          headers,
          body: JSON.stringify({ action: "start", session: sessionPayload }),
        });
        await refreshRollbackGuardState();
      }
      const refresh = await fetch("/api/strategies/auto-tuning", { cache: "no-store" });
      if (refresh.ok) {
        const next = await refresh.json();
        const rows = Array.isArray(next?.entries) ? next.entries : [];
        setAutoTuningAuditTrail(rows.slice(0, 20));
      }
      setAutoTuningIdempotencyKey(
        buildIdempotencyKey(),
      );
    } catch {
      setAutoTuningStatus("Write-back error");
    } finally {
      setAutoTuningBusy(false);
    }
  }

  useEffect(() => {
    if (!AUTO_TUNING_WRITEBACK_ENABLED) return;
    if (!shouldPauseNonEssentialRefresh()) {
      void refreshRollbackGuardState();
    }
    const intervalMs = isGtixPublicBrowserHost() ? PUBLIC_TERMINAL_BACKGROUND_REFRESH_MS : 60_000;
    const timer = window.setInterval(() => {
      if (shouldPauseNonEssentialRefresh()) {
        return;
      }
      void refreshRollbackGuardState();
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!AUTO_TUNING_WRITEBACK_ENABLED || !rollbackGuardSession || rollbackGuardSession.status !== "active") return;

    const pushObservation = async () => {
      if (shouldPauseNonEssentialRefresh()) {
        return;
      }
      try {
        await fetch("/api/strategies/auto-tuning/rollback-guard", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(autoTuningAdminKey.trim() ? { "x-auto-tuning-admin-key": autoTuningAdminKey.trim() } : {}),
          },
          body: JSON.stringify({
            action: "observe",
            observation: {
              timestampIso: new Date().toISOString(),
              currentHealth: metaRiskOfficer.healthScore,
              currentBrier: brierAnalysis.overall.brierScore,
              healthDrop: rollbackGuard.healthDrop,
              brierRise: rollbackGuard.brierRise,
              degradeHealth: rollbackGuard.degradeHealth,
              degradeBrier: rollbackGuard.degradeBrier,
              shouldProposeRollback: rollbackGuard.shouldProposeRollback,
            },
          }),
        });
      } catch {
        // best effort ops heartbeat
      }
    };

    void pushObservation();
    const intervalMs = isGtixPublicBrowserHost() ? PUBLIC_TERMINAL_BACKGROUND_REFRESH_MS : 60_000;
    const timer = window.setInterval(() => {
      void pushObservation();
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [
    autoTuningAdminKey,
    brierAnalysis.overall.brierScore,
    metaRiskOfficer.healthScore,
    rollbackGuard.brierRise,
    rollbackGuard.degradeBrier,
    rollbackGuard.degradeHealth,
    rollbackGuard.healthDrop,
    rollbackGuard.shouldProposeRollback,
    rollbackGuardSession?.id,
    rollbackGuardSession?.status,
  ]);

  useEffect(() => {
    if (!AUTO_TUNING_WRITEBACK_ENABLED || !rollbackGuardSession || rollbackGuardSession.status !== "active") return;
    if (rollbackGuard.active) {
      rollbackGuardClosedRef.current = "";
      return;
    }
    if (rollbackGuardClosedRef.current === rollbackGuardSession.id) return;
    rollbackGuardClosedRef.current = rollbackGuardSession.id;
    void fetch("/api/strategies/auto-tuning/rollback-guard", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(autoTuningAdminKey.trim() ? { "x-auto-tuning-admin-key": autoTuningAdminKey.trim() } : {}),
      },
      body: JSON.stringify({ action: "close", reason: "window_elapsed" }),
    }).then(() => {
      void refreshRollbackGuardState();
    });
  }, [AUTO_TUNING_WRITEBACK_ENABLED, autoTuningAdminKey, rollbackGuard.active, rollbackGuardSession?.id, rollbackGuardSession?.status]);

  const dropPressure24h = (() => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const drops = metaRiskAuditTrail.filter(
      (e) => e.capitalToPct < e.capitalFromPct && new Date(e.timestampIso).getTime() >= cutoff,
    );
    const total = drops.reduce((sum, e) => sum + (e.capitalFromPct - e.capitalToPct), 0);
    const largest = drops.reduce((m, e) => Math.max(m, e.capitalFromPct - e.capitalToPct), 0);
    return { count: drops.length, totalContraction: total, largestDrop: largest };
  })();

  const recommendedAllocPct = Math.min(
    ALLOC_GLOBAL_CAP * 100,
    Math.max(0, allocRawSignal * ALLOC_GLOBAL_CAP * 100 * 4),
  );
  const allocTier =
    recommendedAllocPct >= 1.5 ? "full"
    : recommendedAllocPct >= 0.7 ? "reduced"
    : "minimal";

  const dominantFootprint = footprintRows[0] || null;
  const uniqueOverlayZones = overlayZones.filter((zone, index, zones) => zones.findIndex((candidate) => (
    candidate.kind === zone.kind
    && candidate.label === zone.label
    && Math.abs(candidate.low - zone.low) < 0.01
    && Math.abs(candidate.high - zone.high) < 0.01
  )) === index);
  const activeOverlayZones = showFvgOb ? uniqueOverlayZones : [];
  const activeLiquidityZones = showLiquidity ? liquidityZones : [];
  const overlaySummary = activeOverlayZones.map((zone) => zone.label).join(" · ");
  const liquiditySummary = activeLiquidityZones.map((zone) => zone.level.toFixed(0)).join(" / ");
  const chartHeaderSpread = latestQuote
    ? Math.max(0, toNumber(latestQuote.ask, 0) - toNumber(latestQuote.bid, 0))
    : 0;
  const marketMatrixRows = filteredQuotes
    .filter((quote, index, rows) => rows.findIndex((candidate) => instrumentLabel(candidate) === instrumentLabel(quote)) === index)
    .slice(0, 7)
    .map((quote) => {
      const symbol = instrumentLabel(quote);
      const metrics = marketMetricsBySymbol[symbol];
      const history = quoteHistory[symbol] || [];
      const first = history[0]?.value ?? toNumber(quote.last, 0);
      const last = history[history.length - 1]?.value ?? toNumber(quote.last, 0);
      const deltaPct = first > 0 ? ((last - first) / first) * 100 : 0;
      const spread = Math.max(0, toNumber(quote.ask, 0) - toNumber(quote.bid, 0));
      const regime = volatilityRegime(history);
      const sentimentScore = (metrics?.depthImbalance ?? 0)
        + (metrics?.flowImbalance ?? 0) * 0.5
        + (metrics?.cvdDelta ?? 0 > 0 ? 0.1 : metrics?.cvdDelta ?? 0 < 0 ? -0.1 : 0)
        + deltaPct / 100;
      return {
        symbol,
        price: toNumber(quote.last, 0),
        deltaPct,
        spread,
        venue: String(quote.venue || "–"),
        funding: metrics ? `${(metrics.fundingRate * 100).toFixed(3)}%` : "–",
        openInterest: metrics && metrics.openInterest > 0 ? metrics.openInterest.toFixed(0) : "–",
        volume: metrics ? metrics.volume : 0,
        volatilityRegime: regime,
        sentiment: sentimentScore >= 0 ? "risk-on" : "risk-off",
      };
    });
  const gpuMatrixRows = filteredQuotes
    .filter((quote, index, rows) => rows.findIndex((candidate) => instrumentLabel(candidate) === instrumentLabel(quote)) === index)
    .slice(0, 16)
    .map((quote) => {
      const symbol = instrumentLabel(quote);
      const history = quoteHistory[symbol] || [];
      const first = history[0]?.value ?? toNumber(quote.last, 0);
      const last = history[history.length - 1]?.value ?? toNumber(quote.last, 0);
      const deltaPct = first > 0 ? ((last - first) / first) * 100 : 0;
      const spread = Math.max(0, toNumber(quote.ask, 0) - toNumber(quote.bid, 0));
      return {
        symbol,
        price: toNumber(quote.last, 0),
        deltaPct,
        spread,
        venue: String(quote.venue || "-"),
      };
    });
  const buildSyntheticMiniCandles = useCallback((symbol: string, price: number) => {
    const bars: Array<{ label: string; open: number; high: number; low: number; close: number; volume: number }> = [];
    const safePrice = price > 0 ? price : 100;
    const now = Math.floor(Date.now() / 60_000) * 60_000;
    let seed = symbol.split("").reduce((acc, char, index) => acc + char.charCodeAt(0) * (index + 17), 0) || 1;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) & 0xffffffff;
      return (seed >>> 0) / 0xffffffff;
    };
    let lastPrice = safePrice;
    for (let index = 47; index >= 0; index -= 1) {
      const drift = (rand() - 0.5) * 0.004;
      const open = lastPrice;
      const close = Math.max(0.0001, open * (1 + drift));
      const wick = Math.max(0.0001, Math.abs(close - open) * (0.4 + rand() * 0.7));
      bars.push({
        label: new Date(now - index * 60_000).toISOString(),
        open: Number(open.toFixed(5)),
        high: Number((Math.max(open, close) + wick).toFixed(5)),
        low: Number((Math.min(open, close) - wick * 0.65).toFixed(5)),
        close: Number(close.toFixed(5)),
        volume: Math.round(20 + rand() * 80),
      });
      lastPrice = close;
    }
    return bars;
  }, []);
  const gpuMultiSymbolFeeds = useMemo(() => (
    gpuMatrixRows.map((row) => {
      const history = quoteHistory[row.symbol] || [];
      const candles = history.length >= 4
        ? history.map((point, index) => {
            const prev = history[index - 1] || point;
            const open = Number(prev.value);
            const close = Number(point.value);
            const high = Math.max(open, close) * 1.0006;
            const low = Math.min(open, close) * 0.9994;
            return {
              label: point.label,
              open,
              high,
              low,
              close,
              volume: Math.abs(close - open) * 1000 + 1,
            };
          })
        : buildSyntheticMiniCandles(row.symbol, row.price);
      return {
        id: `${row.symbol}-${row.venue}`,
        symbol: row.symbol,
        candles,
      };
    })
  ), [buildSyntheticMiniCandles, gpuMatrixRows, quoteHistory]);
  const activeGpuMultiSymbolFeeds = renderExtendedTerminalModules ? gpuMultiSymbolFeeds : [];
  const {
    marketBusHealth,
    marketBusHealthComponents,
    marketBusSequencing,
    marketBusOhlcvHealth,
    marketBusDepthHealth,
    marketBusTradesHealth,
    marketBusHealthStatus,
    marketBusHealthTone,
    marketBusOhlcvLatestSeq,
    marketBusDepthUpdateId,
    marketBusOhlcvContiguous,
    marketBusSyncLabel,
    ohlcvFreshnessState,
    depthFreshnessState,
    tradesFreshnessState,
    marketFlowAlerts,
    chartOverlayCompactMode,
    chartUltraCleanCandles,
    publicHostAutoCleanCandles,
    chartFlowAlertText,
    chartCompactAlertLabel,
  } = deriveTerminalMarketHealth({
    marketBusMeta,
    marketBusLastSyncAt,
    chartMode,
    chartVisualMode,
    publicBrowserHost: isGtixPublicBrowserHost(),
  });
  const localTerminalCapturePayload = useMemo(
    () => (localTerminalCaptureClientId ? buildLocalTerminalRuntimeCapture({
      clientId: localTerminalCaptureClientId,
      capturedAt: "",
      authStatus,
      authSessionRequired,
      symbol: selectedChartSymbol,
      instrument: selectedChartInstrument,
      venue: selectedChartVenue,
      timeframe: chartTimeframe,
      chartMode,
      chartVisualMode,
      feedLabel: localOhlcvFeedLabel,
      localFeedSignal: localOhlcvAnalysis.signal,
      localFeedMessage: localFeedSidecarMessage,
      fetchedRows: localOhlcvAnalysis.fetchedRows,
      renderableRows: localOhlcvAnalysis.renderableRows,
      droppedRows: localOhlcvAnalysis.droppedRows,
      duplicateTimestamps: localOhlcvAnalysis.duplicateTimestamps,
      firstTimestamp: localOhlcvAnalysis.firstTimestamp,
      lastTimestamp: localOhlcvAnalysis.lastTimestamp,
      reasons: localOhlcvAnalysis.reasons,
      droppedReasonKinds: localOhlcvAnalysis.droppedReasonKinds,
      marketBusHealthStatus,
      marketBusHealthTone,
      ohlcvStreamState,
      displayDepthStreamState,
      marketBusOhlcvContiguous,
      marketBusOhlcvLatestSeq,
      ohlcvFreshnessState,
      depthFreshnessState,
      tradesFreshnessState,
      barsAge: formatFreshness(marketBusOhlcvHealth?.freshness_ms),
      depthAge: formatFreshness(marketBusDepthHealth?.freshness_ms),
      tradesAge: formatFreshness(marketBusTradesHealth?.freshness_ms),
      candleTicks: marketBusKernelTelemetry.receivedTicks,
      candleUpdates: marketBusKernelTelemetry.candleUpdates,
      syntheticHeartbeatOpens: marketBusKernelTelemetry.syntheticHeartbeatOpens,
      candleLastUpdateAge: candleLastUpdateAgeLabel,
      chartCompactAlertLabel,
      chartFlowAlertText,
      perceptual: chartEngineMode === "v4"
        ? (gpuPerceptualTelemetry ? {
          engine: gpuPerceptualTelemetry.engine,
          densityLevel: gpuPerceptualTelemetry.spacing.denseMode,
          visibleBars: gpuPerceptualTelemetry.visibleBars,
          candleStepPx: gpuPerceptualTelemetry.candleStepPx,
          profile: null,
          renderer: gpuPerceptualTelemetry.renderer,
          gridLabel: gpuPerceptualTelemetry.grid.label,
          pixelSnapping: gpuPerceptualTelemetry.spacing.pixelSnapping,
          denseMode: gpuPerceptualTelemetry.spacing.denseMode,
          preferredBodyWidthPx: gpuPerceptualTelemetry.spacing.preferredBodyWidthPx,
          wickWidthPx: gpuPerceptualTelemetry.spacing.wickWidthPx,
          minGapPx: gpuPerceptualTelemetry.spacing.minGapPx,
          fps: gpuPerceptualTelemetry.performance.fps,
          frameTimeMs: gpuPerceptualTelemetry.performance.fps > 0 ? 1000 / gpuPerceptualTelemetry.performance.fps : null,
          cpuLoad: null,
          workerLatencyMs: null,
          drawCalls: gpuPerceptualTelemetry.performance.drawCalls,
          batchSize: gpuPerceptualTelemetry.performance.batchSize,
          reframeCount: null,
          transitionMode: null,
          lastPriceDriftPx: null,
          peakPriceDriftPx: null,
          updatedAt: gpuPerceptualTelemetry.updatedAt,
        } : null)
        : (chartPerceptualTelemetry ? {
          engine: chartPerceptualTelemetry.engine,
          densityLevel: chartPerceptualTelemetry.densityLevel,
          visibleBars: chartPerceptualTelemetry.visibleBars,
          candleStepPx: chartPerceptualTelemetry.candleStepPx,
          profile: chartPerceptualTelemetry.spacing.profile,
          renderer: null,
          gridLabel: null,
          pixelSnapping: false,
          denseMode: chartPerceptualTelemetry.densityLevel,
          preferredBodyWidthPx: chartPerceptualTelemetry.spacing.preferredBodyWidthPx,
          wickWidthPx: null,
          minGapPx: chartPerceptualTelemetry.spacing.minGapPx,
          fps: chartPerceptualTelemetry.performance.fps,
          frameTimeMs: chartPerceptualTelemetry.performance.frameTimeMs,
          cpuLoad: chartPerceptualTelemetry.performance.cpuLoad,
          workerLatencyMs: chartPerceptualTelemetry.performance.workerLatencyMs,
          drawCalls: null,
          batchSize: null,
          reframeCount: chartPerceptualTelemetry.autoscale.reframeCount,
          transitionMode: chartPerceptualTelemetry.autoscale.transitionMode,
          lastPriceDriftPx: chartPerceptualTelemetry.stability.lastPriceDriftPx,
          peakPriceDriftPx: chartPerceptualTelemetry.stability.peakPriceDriftPx,
          updatedAt: chartPerceptualTelemetry.updatedAt,
        } : null),
    }) : null),
    [
      authSessionRequired,
      authStatus,
      chartCompactAlertLabel,
      chartEngineMode,
      chartFlowAlertText,
      chartMode,
      chartPerceptualTelemetry,
      chartTimeframe,
      chartVisualMode,
      depthFreshnessState,
      displayDepthStreamState,
      gpuPerceptualTelemetry,
      localFeedSidecarMessage,
      localOhlcvAnalysis,
      localOhlcvFeedLabel,
      localTerminalCaptureClientId,
      marketBusDepthHealth,
      marketBusHealthStatus,
      marketBusHealthTone,
      marketBusKernelTelemetry.candleUpdates,
      marketBusKernelTelemetry.receivedTicks,
      marketBusKernelTelemetry.syntheticHeartbeatOpens,
      marketBusOhlcvContiguous,
      marketBusOhlcvHealth,
      marketBusOhlcvLatestSeq,
      marketBusTradesHealth,
      ohlcvFreshnessState,
      ohlcvStreamState,
      selectedChartInstrument,
      selectedChartSymbol,
      selectedChartVenue,
      candleLastUpdateAgeLabel,
      tradesFreshnessState,
    ],
  );
  const localTerminalCapturePayloadSignature = useMemo(
    () => (localTerminalCapturePayload ? JSON.stringify(localTerminalCapturePayload) : ""),
    [localTerminalCapturePayload],
  );

  useEffect(() => {
    try {
      const storageKey = "mc_terminal_capture_client_id";
      const existing = window.sessionStorage.getItem(storageKey);
      if (existing) {
        setLocalTerminalCaptureClientId(existing);
        setLocalTerminalCapturePersistenceStatus((current) => ({ ...current, clientId: existing }));
        return;
      }
      const generated = window.crypto?.randomUUID?.() || `terminal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      window.sessionStorage.setItem(storageKey, generated);
      setLocalTerminalCaptureClientId(generated);
      setLocalTerminalCapturePersistenceStatus((current) => ({ ...current, clientId: generated }));
    } catch {
      const fallback = `terminal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      setLocalTerminalCaptureClientId(fallback);
      setLocalTerminalCapturePersistenceStatus((current) => ({ ...current, clientId: fallback, detail: "ephemeral" }));
    }
  }, []);

  useEffect(() => {
    if (!localTerminalCaptureClientId || authStatus !== "authenticated") {
      return;
    }
    let active = true;
    void fetch(`/api/health/local-terminal?client_id=${encodeURIComponent(localTerminalCaptureClientId)}`, { cache: "no-store" })
      .then((response) => response.json().catch(() => null))
      .then((payload) => {
        if (!active || !payload || typeof payload !== "object") {
          return;
        }
        setLocalTerminalCapturePersistenceStatus((current) => ({
          ...current,
          historyCount: Array.isArray((payload as { capture_history?: unknown[] }).capture_history) ? ((payload as { capture_history?: unknown[] }).capture_history?.length || 0) : current.historyCount,
          autoIncidentTicketKey: typeof (payload as { auto_incident?: { ticketKey?: unknown } }).auto_incident?.ticketKey === "string"
            ? (payload as { auto_incident?: { ticketKey?: string } }).auto_incident?.ticketKey || null
            : current.autoIncidentTicketKey,
          autoIncidentStatus: typeof (payload as { auto_incident?: { status?: unknown } }).auto_incident?.status === "string"
            ? (payload as { auto_incident?: { status?: string } }).auto_incident?.status || null
            : current.autoIncidentStatus,
          captureHistory: Array.isArray((payload as { capture_history?: LocalTerminalRuntimeCapture[] }).capture_history)
            ? ((payload as { capture_history?: LocalTerminalRuntimeCapture[] }).capture_history || [])
            : current.captureHistory,
        }));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [authStatus, localTerminalCaptureClientId]);

  useEffect(() => {
    localTerminalCapturePayloadRef.current = localTerminalCapturePayload;
  }, [localTerminalCapturePayload]);

  const persistLocalTerminalCapture = useCallback(async (baseCapture: LocalTerminalRuntimeCapture, force = false) => {
    if (authStatus !== "authenticated" || authSessionRequired) {
      setLocalTerminalCapturePersistenceStatus((current) => ({
        ...current,
        healthy: false,
        detail: authSessionRequired ? "session-required" : `auth-${authStatus}`,
      }));
      return;
    }

    const signature = JSON.stringify(baseCapture);
    const now = Date.now();
    if (!force && signature === localTerminalCaptureLastPostedSignatureRef.current && now - localTerminalCaptureLastPostedAtRef.current < 15_000) {
      return;
    }

    const snapshot: LocalTerminalRuntimeCapture = {
      ...baseCapture,
      capturedAt: new Date(now).toISOString(),
    };

    try {
      const response = await fetch("/api/health/local-terminal", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(snapshot),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const detail = typeof payload?.detail === "string" ? payload.detail : `http-${response.status}`;
        throw new Error(detail);
      }
      localTerminalCaptureLastPostedSignatureRef.current = signature;
      localTerminalCaptureLastPostedAtRef.current = now;
      setLocalTerminalCapturePersistenceStatus({
        clientId: snapshot.clientId,
        updatedAt: typeof payload?.updated_at === "string" ? payload.updated_at : snapshot.capturedAt,
        healthy: true,
        detail: "persisted",
        historyCount: Array.isArray(payload?.capture_history) ? payload.capture_history.length : 0,
        autoIncidentTicketKey: typeof payload?.auto_incident?.ticketKey === "string" ? payload.auto_incident.ticketKey : null,
        autoIncidentStatus: typeof payload?.auto_incident?.status === "string" ? payload.auto_incident.status : null,
        captureHistory: Array.isArray(payload?.capture_history) ? payload.capture_history : [],
      });
      if (typeof payload?.auto_incident?.ticketKey === "string"
        && payload.auto_incident.ticketKey
        && payload.auto_incident.ticketKey !== localTerminalCaptureLastIncidentTicketKeyRef.current) {
        localTerminalCaptureLastIncidentTicketKeyRef.current = payload.auto_incident.ticketKey;
        setWorkspaceHintBadge(`Incident opened: ${payload.auto_incident.ticketKey} (${snapshot.chart.instrument})`);
      }
    } catch (error) {
      setLocalTerminalCapturePersistenceStatus((current) => ({
        clientId: baseCapture.clientId,
        updatedAt: current.updatedAt,
        healthy: false,
        detail: error instanceof Error ? error.message : "persist-failed",
        historyCount: current.historyCount,
        autoIncidentTicketKey: current.autoIncidentTicketKey,
        autoIncidentStatus: current.autoIncidentStatus,
        captureHistory: current.captureHistory,
      }));
    }
  }, [authSessionRequired, authStatus]);

  useEffect(() => {
    if (!localTerminalCapturePayload || !localTerminalCaptureClientId) {
      return;
    }
    if (authStatus !== "authenticated" || authSessionRequired) {
      setLocalTerminalCapturePersistenceStatus((current) => ({
        ...current,
        clientId: localTerminalCaptureClientId,
        healthy: false,
        detail: authSessionRequired ? "session-required" : `auth-${authStatus}`,
      }));
      return;
    }
    const now = Date.now();
    if (localTerminalCapturePayloadSignature === localTerminalCaptureLastPostedSignatureRef.current && now - localTerminalCaptureLastPostedAtRef.current < 15_000) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      void persistLocalTerminalCapture(localTerminalCapturePayload, false);
    }, 2500);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [
    authSessionRequired,
    authStatus,
    localTerminalCaptureClientId,
    localTerminalCapturePayload,
    localTerminalCapturePayloadSignature,
    persistLocalTerminalCapture,
  ]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      if (!localTerminalCapturePayloadRef.current) {
        return;
      }
      void persistLocalTerminalCapture(localTerminalCapturePayloadRef.current, true);
    }, 30_000);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [persistLocalTerminalCapture]);

  useEffect(() => {
    if (!publicHostAutoCleanCandles) {
      return;
    }
    setChartVisualMode("clean");
  }, [publicHostAutoCleanCandles]);

  useEffect(() => {
    if (!chartOverlayCompactMode) {
      return;
    }
    setChartHudMinimized(true);
  }, [chartOverlayCompactMode, setChartHudMinimized]);

  const chartSnapEnabledLabel = buildChartSnapEnabledLabel(
    chartSnapEnabled,
    chartSnapPriority,
    chartSnapState?.label,
    chartAtrLocalPct,
  );
  const chartOrderTicketPriceLabels = buildChartOrderTicketPriceLabels(chartOrderTicket);

  const handleConfluenceWeightChange = (key: MarketEvidenceWeightKey, next: number) => {
    setConfluenceWeights((current) => ({ ...current, [key]: next }));
  };

  const handleToggleSelfLearningAutoAdaptEnabled = () => {
    setSelfLearningAutoAdaptEnabled((value) => {
      const next = !value;
      if (next) {
        selfLearningDriftSignatureRef.current = "";
        setSelfLearningDriftAutoDemotedAt(null);
      }
      return next;
    });
  };

  const handleApplyPendingExecutionAdaptation = () => {
    if (!pendingExecutionAdaptation) {
      return;
    }
    applyExecutionAdaptationPlan(pendingExecutionAdaptation.plan);
    setPendingExecutionAdaptation(null);
  };

  const handleResetAutoSymbolLoss = () => {
    setAutoSymbolAutoDisabled((current) => {
      const next = { ...current };
      delete next[autoSymbolLoss.normalizedSymbol];
      return next;
    });
  };

  const handleChartHudSubmit = () => {
    if (chartEffectiveSendMode === "confirm-required" && !chartHudConfirmArmed) {
      setError("Confirmation requise: armez d’abord l’envoi.");
      return;
    }
    const ack = chartEffectiveSendMode !== "confirm-required" || chartHudConfirmArmed;
    setChartHudConfirmArmed(false);
    void submitChartOrder(ack);
  };

  const healthyConnectors = connectors.filter((item) => Boolean(item.healthy)).length;
  const brokersDown = connectors.filter((item) => !Boolean(item.healthy)).length;
  const criticalAlerts = alerts.filter((item) => String(item.level || "") === "critical").length;
  const openIncidents = incidents.filter((item) => String(item.status || "") !== "closed").length;
  const riskGateway = connectors.find((item) => String(item.name || "") === "risk-gateway");
  const agentsHealthy = providerRows.filter((item) => Boolean(item.available)).length;

  const governanceRows = [
    { label: "Kill switch", value: String(overview?.kill_switch_active || "off"), severity: String(overview?.kill_switch_active) === "true" ? 3 : 1 },
    { label: "Agents suspendus", value: String(suspended.length), severity: suspended.length > 0 ? 3 : 1 },
    { label: "Brokers down", value: String(brokersDown), severity: brokersDown > 0 ? 3 : 1 },
    { label: "Approvals", value: String(pendingLive.length), severity: pendingLive.length > 0 ? 2 : 1 },
    { label: "MT5 bridge", value: String(mt5Health?.status || "–"), severity: String(mt5Health?.status || "") === "ok" ? 1 : 2 },
    { label: "Drift", value: String(driftItems.filter((d) => Boolean(d.drift_detected)).length), severity: driftItems.some((d) => Boolean(d.drift_detected)) ? 2 : 1 },
    { label: "Similarity", value: String(memorySummary.avg_final_similarity || "–"), severity: 1 },
    { label: "Memory impact", value: String(memorySummary.avg_memory_impact || "–"), severity: 1 },
    { label: "SLA breach", value: String(incidents.filter((i) => Boolean(i.sla_breached)).length), severity: incidents.some((i) => Boolean(i.sla_breached)) ? 3 : 1 },
  ];
  const governanceQuery = governanceFilterText.trim().toLowerCase();
  const governanceFiltered = governanceRows
    .filter((row) => !governanceOnlyAlerts || row.severity >= 2)
    .filter((row) => !governanceQuery || row.label.toLowerCase().includes(governanceQuery) || row.value.toLowerCase().includes(governanceQuery))
    .sort((left, right) => {
      if (governanceSort === "label") {
        return left.label.localeCompare(right.label);
      }
      if (governanceSort === "value") {
        return right.value.localeCompare(left.value, undefined, { numeric: true });
      }
      return right.severity - left.severity;
    });
  const incidentRows = incidents
    .map((item) => ({
      item,
      status: String(item.status || "open"),
      severityLabel: incidentSeverityLabel(item),
      severityRank: incidentSeverityRank(item),
      slaLabel: incidentSlaLabel(item),
    }))
    .filter((row) => !governanceOnlyAlerts || row.severityRank >= 3 || row.slaLabel === "breach")
    .filter((row) => {
      if (!governanceQuery) {
        return true;
      }

      const ticket = String(row.item.ticket_key || "").toLowerCase();
      const title = String(row.item.title || "").toLowerCase();
      const status = row.status.toLowerCase();
      return ticket.includes(governanceQuery)
        || title.includes(governanceQuery)
        || status.includes(governanceQuery)
        || row.severityLabel.includes(governanceQuery)
        || row.slaLabel.includes(governanceQuery);
    })
    .sort((left, right) => {
      if (incidentSort === "status") {
        return incidentStatusRank(right.item) - incidentStatusRank(left.item);
      }
      if (incidentSort === "sla") {
        return Number(Boolean(right.item.sla_breached)) - Number(Boolean(left.item.sla_breached));
      }
      return right.severityRank - left.severityRank;
    });
  const topPerformanceAttribution = performanceAttribution.slice(0, 4);
  const performanceCapitalBreakdown = [
    {
      label: "Broker live",
      tone: "go",
      rows: performanceCapitalSources.filter((row) => row.sourceType === "broker" && row.environment === "live"),
    },
    {
      label: "Broker paper",
      tone: "caution",
      rows: performanceCapitalSources.filter((row) => row.sourceType === "broker" && row.environment === "paper"),
    },
    {
      label: "Exchange",
      tone: "watch",
      rows: performanceCapitalSources.filter((row) => row.sourceType === "exchange"),
    },
    {
      label: "Wallet",
      tone: "watch",
      rows: performanceCapitalSources.filter((row) => row.sourceType === "wallet"),
    },
  ].map((group) => ({
    ...group,
    count: group.rows.length,
    equityUsd: group.rows.reduce((sum, row) => sum + (row.latestEquityUsd || 0), 0),
  }));
  const performanceCapitalPreview = performanceCapitalSources.slice(0, 4);
  const latestInvestorReport = investorReports[0] || null;
  const latestInvestorReportSummary = latestInvestorReport?.summary && typeof latestInvestorReport.summary === "object"
    ? latestInvestorReport.summary
    : null;
  const performanceDeskTone = performanceSummary && performanceSummary.trade_count > 0
    ? (performanceSummary.realized_pnl_usd < 0 ? "caution" : "go")
    : "watch";

  const highlightedFootprintIndex = activeTimeKey
    ? activeFootprintRows.findIndex((row) => row.timeKey === activeTimeKey)
    : -1;
  const highlightedDomIndex = strictDepthTimeMatch && Number.isFinite(activePrice)
    ? activeDomLevels.findIndex((level) => Math.abs(level.price - activePrice) < Math.max(2, activePrice * 0.0005))
    : -1;
  const highlightedHeatmapIndex = strictDepthTimeMatch && Number.isFinite(activePrice)
    ? activeHeatmapLevels.findIndex((level) => Math.abs(level.price - activePrice) < Math.max(2, activePrice * 0.0005))
    : -1;
  const highlightedTapeIndex = activeTimeKey
    ? activeTape.findIndex((print) => print.timeKey === activeTimeKey)
    : -1;
  const chartVisualPresetLabel = chartMotionClass === "stable"
    ? "stable"
    : chartMotionClass === "aggressive"
      ? "aggressive"
      : "balanced";
  const chartVisualPolicyLabel = chartVisualMode === "full"
    ? "full overlays"
    : chartVisualMode === "clean"
      ? "forced clean"
      : `auto ${chartVisualPresetLabel}`;
  const chartSidecarVisible = layoutScreenProfile !== "sm";
  const chartSidecarDomRows = activeDomLevels.slice(0, 6);
  const chartSidecarTapeRows = activeTape.slice(0, 6);
  const chartSidecarFootprintRows = activeFootprintRows.slice(0, 5);
  const chartSidecarHeatRows = activeHeatmapLevels.slice(0, 5);
  const chartSidecarBidDepth = chartSidecarDomRows
    .filter((level) => level.side === "bid")
    .reduce((sum, level) => sum + Math.max(0, level.size), 0);
  const chartSidecarAskDepth = chartSidecarDomRows
    .filter((level) => level.side === "ask")
    .reduce((sum, level) => sum + Math.max(0, level.size), 0);
  const chartSidecarDepthBias = chartSidecarBidDepth === chartSidecarAskDepth
    ? "balanced"
    : chartSidecarBidDepth > chartSidecarAskDepth
      ? "bid"
      : "ask";
  const chartSidecarFootprintDelta = chartSidecarFootprintRows.reduce((sum, row) => sum + toNumber(row.delta, 0), 0);
  const chartSidecarTapeDelta = chartSidecarTapeRows.reduce((sum, print) => sum + toNumber(print.delta, 0), 0);
  const chartSidecarProfileConfig = CHART_SIDECAR_PROFILE_LAYOUTS[chartSidecarProfile];
  const chartSidecarLayoutMode = inferChartSidecarLayoutMode(chartSidecarProfile, detachedChartSidecars);
  const detachedChartSidecarIds = new Set(detachedChartSidecars.map((panel) => panel.id));
  const dockedChartSidecarIds = chartSidecarProfileConfig.cards.filter((id) => !detachedChartSidecarIds.has(id));

  useEffect(() => {
    const allowed = new Set(CHART_SIDECAR_PROFILE_LAYOUTS[chartSidecarProfile].cards);
    setDetachedChartSidecars((current) => current.filter((panel) => allowed.has(panel.id)));
  }, [chartSidecarProfile]);

  const renderChartSidecarCard = (id: ChartSidecarId, floating = false): ReactNode => {
    const headActions = floating ? null : (
      <div className="chart-sidecar-actions">
        <button type="button" className="chart-sidecar-head-btn" onClick={() => detachChartSidecar(id)}>Float</button>
      </div>
    );

    const approveAllAndSendLabel = chartEffectiveSendMode === "confirm-required" && !chartHudConfirmArmed
      ? "Approve + Arm Send"
      : "Approve All + Send";

    if (id === "policy") {
      return (
        <PolicySidecarCard
          headActions={headActions}
          profileLabel={chartSidecarProfileConfig.label}
          profileOptions={CHART_SIDECAR_PROFILE_IDS.map((profile) => ({
            id: profile,
            label: CHART_SIDECAR_PROFILE_LAYOUTS[profile].label,
            active: chartSidecarProfile === profile,
            onSelect: () => setChartSidecarProfile(profile),
          }))}
          layoutMode={chartSidecarLayoutMode}
          onApplyLayout={applyChartSidecarLayout}
          onSaveCustom={saveCustomChartSidecarLayout}
          pills={[
            { text: `preset ${chartVisualPresetLabel}` },
            { text: `perf ${chartPerfMode}` },
            { text: `mode ${chartMode}` },
            { text: `ind ${activeIndicators.length}` },
            { text: `snap ${marketDecisionV1.executionPlan.snapPriority}` },
            { text: `plan ${marketDecisionV1.executionPlan.preset}` },
            { text: `guard ${marketDecisionV1.executionPlan.guardEnabled ? "on" : "off"}` },
            { text: `ticket ${chartOrderTicket.active ? "on-chart" : "off"}`, className: chartOrderTicket.active ? "chart-action-pill-status good" : "chart-action-pill-status warn" },
            { text: "SL/TP chart-native" },
            {
              text: `auth ${authStatus === "authenticated" ? "ready" : authStatus === "unknown" ? "check" : "session"}`,
              className: authStatus === "authenticated"
                ? "chart-action-pill-status good"
                : authStatus === "unknown"
                  ? "chart-action-pill-status warn"
                  : "chart-action-pill-status bad",
            },
          ]}
        />
      );
    }

    if (id === "localFeed") {
      return (
        <LocalFeedSidecarCard
          headActions={headActions}
          message={localFeedSidecarMessage}
          captureClientId={localTerminalCapturePersistenceStatus.clientId}
          captureUpdatedAt={localTerminalCapturePersistenceStatus.updatedAt}
          captureHealthy={localTerminalCapturePersistenceStatus.healthy}
          captureDetail={localTerminalCapturePersistenceStatus.detail}
          captureHistoryCount={localTerminalCapturePersistenceStatus.historyCount}
          autoIncidentTicketKey={localTerminalCapturePersistenceStatus.autoIncidentTicketKey}
          autoIncidentStatus={localTerminalCapturePersistenceStatus.autoIncidentStatus}
          feedLabel={localOhlcvFeedLabel}
          signal={localOhlcvAnalysis.signal}
          fetchedRows={localOhlcvAnalysis.fetchedRows}
          renderableRows={localOhlcvAnalysis.renderableRows}
          droppedRows={localOhlcvAnalysis.droppedRows}
          duplicateTimestamps={localOhlcvAnalysis.duplicateTimestamps}
          firstTimestamp={localOhlcvAnalysis.firstTimestamp}
          lastTimestamp={localOhlcvAnalysis.lastTimestamp}
          reasons={localOhlcvAnalysis.reasons}
          droppedReasonKinds={localOhlcvAnalysis.droppedReasonKinds}
          fallbackSuggestion={localFeedFallbackSuggestion ? {
            symbol: localFeedFallbackSuggestion.symbol,
            instrument: localFeedFallbackSuggestion.instrument,
            venue: localFeedFallbackSuggestion.venue,
            timeframe: localFeedFallbackSuggestion.timeframe,
            autoFallback: true,
          } : null}
          onApplyFallback={() => {
            if (!localFeedFallbackSuggestion) {
              return;
            }
            chartEmptyRecoveryKeyRef.current = localFeedFallbackSuggestion.key;
            setSelectedChartSymbol(localFeedFallbackSuggestion.symbol);
            setLocalFeedFallbackSuggestion(null);
            setWorkspaceHintBadge(`Fallback applied: ${localFeedFallbackSuggestion.symbol}`);
          }}
          onDismissFallback={() => {
            if (!localFeedFallbackSuggestion) {
              return;
            }
            localFeedDismissedFallbackKeyRef.current = localFeedFallbackSuggestion.key;
            setLocalFeedFallbackSuggestion(null);
            setWorkspaceHintBadge(`Fallback dismissed: ${selectedChartSymbol}`);
          }}
        />
      );
    }

    if (id === "forensic") {
      return (
        <ForensicReplaySidecarCard
          headActions={headActions}
          captureClientId={localTerminalCapturePersistenceStatus.clientId}
          autoIncidentTicketKey={localTerminalCapturePersistenceStatus.autoIncidentTicketKey}
          autoIncidentStatus={localTerminalCapturePersistenceStatus.autoIncidentStatus}
          attributionHeadline={replayAttributionHeadline}
          attributionContextLabel={replayAttributionContextLabel}
          attributionPills={replayAttributionPills}
          agentLearningHeadline={replayAgentLearningHeadline}
          agentLearningPills={replayAgentLearningPills}
          latentHeadline={replayLatentHeadline}
          provenanceHeadline={replayDreamHeadline}
          latentPills={replayLatentPills}
          frames={localTerminalCapturePersistenceStatus.captureHistory
            .slice(-12)
            .reverse()
            .map((capture) => ({
              capturedAt: capture.capturedAt,
              feedLabel: capture.chart.feedLabel,
              signal: capture.localFeed.signal,
              blockedByFiveStateFailure: capture.runtime.blockedByFiveStateFailure,
              noCandlesExpected: capture.runtime.noCandlesExpected,
              exactStateVector: capture.runtime.exactStateVector,
              replayLatentLabel: replayLatentHeadline,
              replayOriginLabel: replayDreamHeadline,
            }))}
        />
      );
    }

    if (id === "domTape") {
      return (
        <DomTapeSidecarCard
          headActions={headActions}
          depthBias={chartSidecarDepthBias}
          bidDepth={chartSidecarBidDepth}
          askDepth={chartSidecarAskDepth}
          tapeDelta={chartSidecarTapeDelta}
          domRows={chartSidecarDomRows.map((level, index) => ({
            key: `side-dom-${index}-${level.price}`,
            side: level.side,
            price: level.price,
            size: level.size,
            intensity: level.intensity,
            highlighted: highlightedDomIndex === index,
          }))}
          tapeRows={chartSidecarTapeRows.map((print, index) => ({
            key: `side-tape-${index}-${print.label}`,
            side: print.side,
            label: print.label,
            price: print.price,
            volume: print.volume,
            highlighted: highlightedTapeIndex === index,
          }))}
        />
      );
    }

    if (id === "footprintHeat") {
      return (
        <FootprintHeatSidecarCard
          headActions={headActions}
          footprintDelta={chartSidecarFootprintDelta}
          strictDepthTimeMatch={strictDepthTimeMatch}
          footprintRows={chartSidecarFootprintRows.map((row, index) => ({
            key: `side-fp-${index}-${row.low}-${row.high}`,
            timeLabel: row.timeLabel || "",
            buyVolume: row.buyVolume,
            sellVolume: row.sellVolume,
            delta: row.delta,
            highlighted: highlightedFootprintIndex === index,
          }))}
          heatRows={chartSidecarHeatRows.map((level, index) => ({
            key: `side-heat-${index}-${level.price}`,
            side: level.side,
            price: level.price,
            size: level.size,
            intensity: level.intensity,
            highlighted: highlightedHeatmapIndex === index,
          }))}
        />
      );
    }

    return (
      <ExecutionSidecarCard
        headActions={headActions}
        sideLabel={chartOrderTicket.side.toUpperCase()}
        entry={chartOrderTicket.entry}
        sl={chartOrderTicket.sl}
        tp={chartOrderTicket.tp}
        chartPriceDigits={chartPriceDigits}
        chartRiskReward={chartRiskReward}
        chartRiskUsd={chartRiskUsd}
        chartMaxLossUsd={chartMaxLossUsd}
        chartRewardUsd={chartRewardUsd}
        chartTargetGainUsd={chartTargetGainUsd}
        suggestedBracket={marketDecisionV1.suggestedBracket}
        suggestedLiquidityHighlight={suggestedLiquidityHighlight ? { level: suggestedLiquidityHighlight.level, exactTpMatch: suggestedLiquidityExactTpMatch } : null}
        onApplyBracket={() => {
          if (marketDecisionV1.suggestedBracket) {
            applySuggestedScenarioBracket(marketDecisionV1.suggestedBracket);
          }
        }}
        onApproveAll={() => {
          if (!marketDecisionV1.suggestedBracket) {
            return;
          }
          applySuggestedScenarioBracket(marketDecisionV1.suggestedBracket);
          applyExecutionAdaptationPlan(marketDecisionV1.executionPlan);
          setPendingExecutionAdaptation(null);
        }}
        onApproveAllAndSend={() => {
          void approveAllAndSend();
        }}
        approveAllAndSendLabel={approveAllAndSendLabel}
        showCriticalActions={marketDecisionV1.criticalConfirmed}
        previewOpen={chartOrderPreviewOpen}
        onTogglePreview={() => setChartOrderPreviewOpen((value) => !value)}
        selectedChartSymbol={selectedChartSymbol}
        ocoEnabled={chartOrderTicket.oco}
        chartSnapEnabled={chartSnapEnabled}
        chartSnapPriorityLabel={chartSnapPriority.toUpperCase()}
      />
    );
  };

  const buildRiskTimelineBodyProps = (rowLimit: number, keyPrefix: string): ComponentProps<typeof RiskTimelineBody> => ({
    hardAlertLocal: Boolean(riskHardAlertEnabled) && toNumber(riskSummary?.ratio_miss_window, 0) * 100 >= Math.max(20, Math.min(95, riskHardAlertThresholdPct)),
    riskTimelineFilter,
    onSetRiskTimelineFilter: setRiskTimelineFilter,
    riskSummary,
    thresholdAtLimit: riskAlertMissThreshold >= riskAlertWindow,
    pollingStale: riskPollingFailures > 2,
    riskPollingStatus,
    riskPollAgeSec,
    riskTimelineFrom,
    onRiskTimelineFromChange: setRiskTimelineFrom,
    riskTimelineTo,
    onRiskTimelineToChange: setRiskTimelineTo,
    riskAlertWindow,
    onRiskAlertWindowChange: (value) => {
      const nextWindow = Math.max(3, Math.min(100, value || DEFAULT_RISK_ALERT_WINDOW));
      setRiskAlertWindow(nextWindow);
      setRiskAlertMissThreshold((current) => Math.min(nextWindow, Math.max(1, current)));
    },
    riskAlertMissThreshold,
    onRiskAlertMissThresholdChange: (value) => {
      const nextThreshold = Math.max(1, Math.min(riskAlertWindow, value || DEFAULT_RISK_ALERT_MISS_THRESHOLD));
      setRiskAlertMissThreshold(nextThreshold);
    },
    riskTimelineRefreshSec,
    onRiskTimelineRefreshSecChange: setRiskTimelineRefreshSec,
    riskHardAlertEnabled,
    onRiskHardAlertEnabledChange: setRiskHardAlertEnabled,
    riskHardAlertThresholdPct,
    onRiskHardAlertThresholdPctChange: (value) => {
      const nextHardThreshold = Math.max(20, Math.min(95, value || DEFAULT_HARD_ALERT_RATIO_PCT));
      setRiskHardAlertThresholdPct(nextHardThreshold);
    },
    onExportRiskHistoryJson: () => { void exportRiskHistory("json"); },
    onExportRiskHistoryCsv: () => { void exportRiskHistory("csv"); },
    onExportComplianceZip: () => { void exportComplianceZip(); },
    onResetWorkspaceRiskAlert: resetWorkspaceRiskAlert,
    presetLabel: layoutPreset === "scalp" ? "Scalp 4/12" : layoutPreset === "monitoring" ? "Monitoring 2/8" : "Swing 3/10",
    riskTimelineRows,
    rowLimit,
    keyPrefix,
    formatClock,
  });

  const renderRiskTimelineBody = (rowLimit: number, keyPrefix: string): ReactNode => {
    return <RiskTimelineBody {...buildRiskTimelineBodyProps(rowLimit, keyPrefix)} />;
  };

  const chartExecutionHudPanel = (
    <ChartExecutionHud
      chartHudDragging={chartHudDragging}
      chartHudMinimized={chartHudMinimized}
      chartHudPosition={chartHudPosition}
      chartMotionClass={chartMotionClass}
      chartMotionPreset={chartMotionPreset}
      chartOrderHudRef={chartOrderHudRef}
      compactMode={chartOverlayCompactMode}
      detached={chartOverlayCompactMode}
      layoutScreenProfile={layoutScreenProfile}
      modeShortLabel={modeUxProfile.shortLabel}
      onBeginChartHudDrag={beginChartHudDrag}
      onResetChartHud={resetChartHud}
      onToggleChartHudMinimized={() => setChartHudMinimized((value) => !value)}
      signalDisplayMode={signalDisplayMode}
      signalFocusMode={marketSignalV1.focusMode}
    >
      <ChartHudSignalDecisionPanel
        signalDisplayMode={signalDisplayMode}
        marketSignal={marketSignalV1}
        perceptionMotionClass={perceptionMotionClass}
        perceptionSetupReady={perceptionSetupReady}
        perceptionCoreLabel={perceptionCoreLabel}
        perceptionReasonCode={perceptionReasonCode}
        showReasonLegend={showReasonLegend}
        onToggleShowReasonLegend={() => setShowReasonLegend((value) => !value)}
        perceptionReasonLegend={perceptionReasonLegend}
        perceptionTargetLabel={perceptionTargetLabel}
        perceptionActionLabel={perceptionActionLabel}
        signalConfidenceDrift={signalConfidenceDrift}
        marketDecision={marketDecisionV1}
        showConfluenceTune={showConfluenceTune}
        onToggleShowConfluenceTune={() => setShowConfluenceTune((value) => !value)}
        showDecisionSecondary={showDecisionSecondary}
        onToggleShowDecisionSecondary={() => setShowDecisionSecondary((value) => !value)}
        confluenceWeights={confluenceWeights}
        onChangeConfluenceWeight={handleConfluenceWeightChange}
        decisionSecondaryRef={decisionSecondaryRef}
        entryTimingV3={entryTimingV3}
        tradeManagementV3={tradeManagementV3}
        intelligentExitV3={intelligentExitV3}
        trailingV3={trailingV3}
        confidencePillTone={confidencePillTone}
        autoExecutionMode={autoExecutionMode}
        onSetAutoExecutionMode={setAutoExecutionMode}
        autoExecutionKillSwitch={autoExecutionKillSwitch}
        onToggleAutoExecutionKillSwitch={() => setAutoExecutionKillSwitch((value) => !value)}
        autoSessionGuardEnabled={autoSessionGuardEnabled}
        onToggleAutoSessionGuardEnabled={() => setAutoSessionGuardEnabled((value) => !value)}
        autoSessionStartHour={autoSessionStartHour}
        onSetAutoSessionStartHour={(value) => setAutoSessionStartHour(Math.max(0, Math.min(23, value)))}
        autoSessionEndHour={autoSessionEndHour}
        onSetAutoSessionEndHour={(value) => setAutoSessionEndHour(Math.max(0, Math.min(23, value)))}
        autoSymbolLossCapUsd={autoSymbolLossCapUsd}
        onSetAutoSymbolLossCapUsd={(value) => setAutoSymbolLossCapUsd(Math.max(50, value))}
        autoSymbolLoss={autoSymbolLoss}
        onResetAutoSymbolLoss={handleResetAutoSymbolLoss}
        autoExecutionGate={autoExecutionGate}
        autoMetaPass={autoMetaFilter.pass}
        autoRiskEngine={autoRiskEngine}
        openTradesCount={openTradesCount}
        exposureRatio={exposureRatio}
        dailyDrawdownPct={dailyDrawdownPct}
        autoSessionGuard={autoSessionGuard}
        filteredAutoExecutionAuditTrail={filteredAutoExecutionAuditTrail}
        autoExecutionAuditTrailLength={autoExecutionAuditTrail.length}
        autoExecutionAuditStateFilter={autoExecutionAuditStateFilter}
        onSetAutoExecutionAuditStateFilter={setAutoExecutionAuditStateFilter}
        autoExecutionAuditReasonSearch={autoExecutionAuditReasonSearch}
        onSetAutoExecutionAuditReasonSearch={setAutoExecutionAuditReasonSearch}
        onExportAutoExecutionAuditJson={() => exportAutoExecutionAudit("json")}
        onExportAutoExecutionAuditCsv={() => exportAutoExecutionAudit("csv")}
        onClearAutoExecutionAuditTrail={() => setAutoExecutionAuditTrail([])}
        formatClock={formatClock}
        selfLearningV4Enabled={selfLearningV4Enabled}
        onToggleSelfLearningV4Enabled={() => setSelfLearningV4Enabled((value) => !value)}
        selfLearningAutoAdaptEnabled={selfLearningAutoAdaptEnabled}
        onToggleSelfLearningAutoAdaptEnabled={handleToggleSelfLearningAutoAdaptEnabled}
        selfLearningDriftV4={selfLearningDriftV4}
        selfLearningV4DriftLabel={selfLearningV4DriftLabel}
        filteredSelfLearningJournalV4Trail={filteredSelfLearningJournalV4Trail}
        selfLearningJournalV4TrailLength={selfLearningJournalV4Trail.length}
        onExportSelfLearningJournalV4Json={() => exportSelfLearningJournalV4("json")}
        onExportSelfLearningJournalV4Csv={() => exportSelfLearningJournalV4("csv")}
        onClearSelfLearningJournalV4Trail={() => setSelfLearningJournalV4Trail([])}
        selfLearningJournalV4RegimeFilter={selfLearningJournalV4RegimeFilter}
        onSetSelfLearningJournalV4RegimeFilter={setSelfLearningJournalV4RegimeFilter}
        selfLearningJournalV4ScenarioFilter={selfLearningJournalV4ScenarioFilter}
        onSetSelfLearningJournalV4ScenarioFilter={setSelfLearningJournalV4ScenarioFilter}
        selfLearningV4Active={selfLearningV4Active}
        selfLearningStorageTone={selfLearningStorageTone}
        selfLearningStorageLabel={selfLearningStorageLabel}
        selfLearningV4PersistenceStatus={selfLearningV4PersistenceStatus}
        selfLearningCurrentScopeCount={selfLearningCurrentScopeCount}
        selfLearningRegimeV4={selfLearningRegimeV4}
        selfLearningV4WeightsLabel={selfLearningV4WeightsLabel}
        selfLearningV4ModelLabel={selfLearningV4ModelLabel}
        selfLearningProfile={selfLearningProfile}
        selfLearningModelUpdatedAt={selfLearningModelUpdatedAt}
        selfLearningDriftAutoDemotedAt={selfLearningDriftAutoDemotedAt}
        selfLearningAdaptiveWeights={selfLearningAdaptiveWeights}
        brainAttributionHeadline={`${formatFeatureFamilyLabel(backendBrainFeatureLeader)} ${backendBrainFeatureLeaderContribution >= 0 ? "+" : ""}${backendBrainFeatureLeaderContribution.toFixed(2)} · ${backendBrainFeatureSession}/${backendBrainFeatureVolatility}/${backendBrainFeatureSpread}`}
        brainAttributionPills={backendBrainAttributionPills}
        brainLearningRatePills={backendBrainLearningRatePills}
        executionAdaptMode={executionAdaptMode}
        onSetExecutionAdaptMode={setExecutionAdaptMode}
        pendingExecutionAdaptation={pendingExecutionAdaptation}
        onApplyPendingExecutionAdaptation={handleApplyPendingExecutionAdaptation}
      />
      <ChartHudOrderRiskPanel
        chartOrderTicket={chartOrderTicket}
        onApplyChartOrderPreset={applyChartOrderPreset}
        onToggleChartOrderOco={() => setChartOrderTicket((value) => ({ ...value, oco: !value.oco }))}
        chartSnapEnabled={chartSnapEnabled}
        onToggleChartSnapEnabled={() => setChartSnapEnabled(!chartSnapEnabled)}
        chartSnapPriority={chartSnapPriority}
        onSetChartSnapPriority={setChartSnapPriority}
        chartRiskUsd={chartRiskUsd}
        chartRewardUsd={chartRewardUsd}
        chartRiskReward={chartRiskReward}
        chartMaxLossUsd={chartMaxLossUsd}
        onSetChartMaxLossUsd={setChartMaxLossUsd}
        chartTargetGainUsd={chartTargetGainUsd}
        onSetChartTargetGainUsd={setChartTargetGainUsd}
        chartRiskGuardEnabled={chartRiskGuardEnabled}
        onToggleChartRiskGuardEnabled={() => setChartRiskGuardEnabled((value) => !value)}
        uiMode={uiMode}
        onApplySafeRiskPreset={() => { setChartMaxLossUsd(80); setChartTargetGainUsd(160); }}
        onApplyBalancedRiskPreset={() => { setChartMaxLossUsd(120); setChartTargetGainUsd(240); }}
        onApplyDeskRiskPreset={() => { setChartMaxLossUsd(250); setChartTargetGainUsd(500); }}
        chartRiskLossExceeded={chartRiskLossExceeded}
        chartRiskTargetMiss={chartRiskTargetMiss}
        chartRiskTargetRr={chartRiskTargetRr}
        chartPriceStep={chartPriceStep}
        chartPriceDigits={chartPriceDigits}
        chartSnapEnabledLabel={chartSnapEnabledLabel}
        chartSnapState={chartSnapState}
        chartOrderTicketEntryLabel={chartOrderTicketPriceLabels.entry}
        chartOrderTicketSlLabel={chartOrderTicketPriceLabels.sl}
        chartOrderTicketTpLabel={chartOrderTicketPriceLabels.tp}
        chartEffectiveSendMode={chartEffectiveSendMode}
        chartHudConfirmArmed={chartHudConfirmArmed}
        onToggleChartHudConfirmArmed={() => setChartHudConfirmArmed((value) => !value)}
        onSubmitChartOrder={handleChartHudSubmit}
        mergedChartSendHistory={mergedChartSendHistory}
        formatClock={formatClock}
      />
    </ChartExecutionHud>
  );

  // ─── Floating panel content renderer ─────────────────────────────────────
  function renderDockPanelContent(id: DockPanelId): ReactNode {
    switch (id) {
      case "dom":
        return <DomDockPanel depthStreamState={displayDepthStreamState} activeDomLevels={activeDomLevels} />;
      case "footprint":
        return <FootprintDockPanel activeFootprintRows={activeFootprintRows} />;
      case "tape":
        return <TapeDockPanel activeTape={activeTape} />;
      case "heatmap":
        return <HeatmapDockPanel activeHeatmapLevels={activeHeatmapLevels} sessionLabel={String(sessionState?.session || "–")} />;
      case "blotter":
        return <BlotterDockPanel filteredOutcomes={filteredOutcomes} instrumentLabel={instrumentLabel} />;
      case "brokers":
        return <BrokersDockPanel providerRows={providerRows} balances={balances} positions={positions} instrumentLabel={instrumentLabel} omsLifecycle={omsLifecycleSummary} portfolioOverlay={portfolioOverlaySummary} aiBridge={aiBridgeSummary} />;
      case "alerts":
        return <AlertsDockPanel filteredAlerts={filteredAlerts} />;
      case "incidents":
        return <IncidentsDockPanel incidentRows={incidentRows} />;
      case "governance":
        return <GovernanceDockPanel governanceFiltered={governanceFiltered} />;
      case "readiness":
        return <ReadinessDockPanel driftItems={driftItems} suspendedCount={suspended.length} memorySummary={memorySummary} incidents={incidents} />;
      case "risktimeline":
        return (
          <div className="monitoring-col" style={{ height: "100%", overflow: "auto" }}>
            <div className="eyebrow" style={{ marginBottom: 8 }}>Risk Compliance Timeline</div>
            <RiskTimelineBody {...buildRiskTimelineBodyProps(10, "rt")} />
          </div>
        );
      default:
        return null;
    }
  }

  const hardAlertThreshold = Math.max(20, Math.min(95, riskHardAlertThresholdPct));
  const hardAlertActive = Boolean(riskHardAlertEnabled) && toNumber(riskSummary?.ratio_miss_window, 0) * 100 >= hardAlertThreshold;
  const riskMissRatioPct = toNumber(riskSummary?.ratio_miss_window, 0) * 100;
  const killSwitchActive = String(overview?.kill_switch_active) === "true";
  const mt5Healthy = String(mt5Health?.status || "") === "ok";
  const routeDeviationBps = toNumber(routingScore?.deviation_bps, 0);
  const decisionBracket = marketDecisionV1.suggestedBracket;
  const topDecisionEvidence = [...marketDecisionV1.evidence]
    .sort((left, right) => right.scorePct - left.scorePct)
    .slice(0, 3);
  const decisionGateTone = (() => {
    if (killSwitchActive || hardAlertActive) {
      return "blocked";
    }
    if (!chartSignalComputationEnabled || marketDecisionV1.biasDirection === "neutral" || !decisionBracket) {
      return "watch";
    }
    if (!mt5Healthy || openIncidents > 0 || Boolean(riskSummary?.alert)) {
      return "caution";
    }
    if (marketDecisionV1.globalConfidencePct >= 72 && marketDecisionV1.confluenceScorePct >= 58 && displayDepthStreamState === "live") {
      return "go";
    }
    return "watch";
  })();
  const decisionGateLabel = decisionGateTone === "blocked"
    ? "NO-GO"
    : decisionGateTone === "caution"
      ? "CAUTION"
      : decisionGateTone === "go"
        ? "GO"
        : "MONITOR";
  const decisionGateBody = (() => {
    if (decisionGateTone === "blocked") {
      return killSwitchActive
        ? "Kill switch actif: aucune exécution discrétionnaire ne doit partir tant que le contrôle central reste verrouillé."
        : `Hard alert risque: miss ratio ${riskMissRatioPct.toFixed(0)}%. Réduire immédiatement l’agression et stopper les nouveaux envois.`;
    }
    if (decisionGateTone === "caution") {
      return "Signal exploitable mais infrastructure dégradée. Vérifier MT5, incidents ouverts et budget de risque avant tout envoi.";
    }
    if (decisionGateTone === "go") {
      return `${marketDecisionV1.actionBody} Priorité à une exécution disciplinée sur ${preferredRouteLabel || "la meilleure route disponible"}.`;
    }
    return `${marketDecisionV1.actionBody} L’objectif est d’attendre confirmation, pas de sur-trader.`;
  })();
  const executionGuardLabel = marketDecisionV1.executionPlan.guardEnabled ? "Guard ON" : "Guard OFF";
  const persistenceTone = !selfLearningV4PersistenceStatus.healthy
    ? "caution"
    : displayDepthStreamState === "live" && mt5Healthy
      ? "go"
      : "watch";

  if (!isHydrated) {
    return (
      <main className={`term-root ui-${uiMode}`}>
        <header className="term-topbar gtix-panel-shell">
          <span className="eyebrow term-topbar-brand">TXT Trading Terminal</span>
        </header>
        <div className="gtix-panel-shell" style={{ margin: "18px 22px", minHeight: 240, display: "grid", placeItems: "center" }}>
          <div className="term-empty-state">Loading terminal...</div>
        </div>
      </main>
    );
  }

  return (
    <main className={`term-root ui-${uiMode}`}>
      {hardAlertActive ? (
        <div className="hard-alert-banner">
          HARD ALERT: ratio miss {(toNumber(riskSummary?.ratio_miss_window, 0) * 100).toFixed(0)}% ≥ {hardAlertThreshold}%
        </div>
      ) : null}

      {/* ═══════════════ HEADER INSTITUTIONNEL ═══════════════ */}
      <header className="term-topbar gtix-panel-shell">
        <span className="eyebrow term-topbar-brand">TXT Trading Terminal</span>
        <div className="th-kpis">
          <span className={`th-kpi ${healthyConnectors < connectors.length ? "th-warn" : ""}`}>
            <span className={`th-dot ${healthyConnectors < connectors.length ? "th-dot-warn" : ""}`} />
            {healthyConnectors}/{connectors.length} conn.
          </span>
          <span className={`th-kpi ${criticalAlerts > 0 ? "th-warn" : ""}`}>{criticalAlerts} crit.</span>
          <span className={`th-kpi ${openIncidents > 0 ? "th-warn" : ""}`}>{openIncidents} incidents</span>
          {riskSummary ? (
            <span className={`th-kpi ${riskSummary.alert ? "th-warn" : ""}`}>
              miss {riskSummary.miss_in_window}/{riskSummary.window_size} ({(toNumber(riskSummary.ratio_miss_window, 0) * 100).toFixed(0)}%)
            </span>
          ) : null}
          <span className="th-kpi expert-only">{agentsHealthy}/{providerRows.length} agents</span>
          <span className="th-kpi expert-only">±{toNumber(overview?.net_exposure_usd, 0).toFixed(0)} USD expo</span>
          <span className={`th-kpi expert-only ${String(riskGateway?.healthy) === "false" ? "th-warn" : ""}`}>RG {String(riskGateway?.healthy ?? "–")}</span>
          <span className={`th-kpi expert-only ${pendingLive.length > 0 ? "th-warn" : ""}`}>{pendingLive.length} approvals</span>
          <span className={`th-kpi ${String(mt5Health?.status || "") === "ok" ? "" : "th-warn"}`}>MT5 {String(mt5Health?.status || "–")}</span>
        </div>
        <div className="th-nav">
          <Link href="/">Dashboard</Link>
          <Link href="/ai">IA</Link>
          <Link href="/connectors">Connecteurs</Link>
          <Link href="/live-readiness">Readiness</Link>
          <Link href="/incidents">Incidents</Link>
          <div className="th-mode-toggle" role="tablist" aria-label="Display mode">
            <button type="button" className={`th-mode-btn${uiMode === "novice" ? " active" : ""}`} onClick={() => setUiMode("novice")}>
              Novice
            </button>
            <button type="button" className={`th-mode-btn${uiMode === "expert" ? " active" : ""}`} onClick={() => setUiMode("expert")}>
              Expert
            </button>
          </div>
          <div className="th-mode-toggle" role="group" aria-label="Layout controls">
            <button type="button" className={`th-mode-btn${layoutEditMode ? " active" : ""}`} onClick={() => setLayoutEditMode((v) => !v)}>
              Layout Edit <span className="th-hotkey">Alt+E</span>
            </button>
            <button
              type="button"
              className={`th-mode-btn${terminalDensityMode === "focus" ? " active" : ""}`}
              onClick={() => setTerminalDensityMode("focus")}
              title="Principal chart only"
            >
              Live Focus
            </button>
            <button
              type="button"
              className={`th-mode-btn${terminalDensityMode === "full" ? " active" : ""}`}
              onClick={() => setTerminalDensityMode("full")}
              title="All modules"
            >
              Full Surface
            </button>
            <button type="button" className={`th-mode-btn${layoutPreset === "scalp" ? " active" : ""}`} onClick={() => applyLayoutPreset("scalp")} title="Alt+1">Scalp <span className="th-hotkey">1</span></button>
            <button type="button" className={`th-mode-btn${layoutPreset === "swing" ? " active" : ""}`} onClick={() => applyLayoutPreset("swing")} title="Alt+2">Swing <span className="th-hotkey">2</span></button>
            <button type="button" className={`th-mode-btn${layoutPreset === "monitoring" ? " active" : ""}`} onClick={() => applyLayoutPreset("monitoring")} title="Alt+3">Monitoring <span className="th-hotkey">3</span></button>
            <button type="button" className="th-mode-btn" onClick={saveCurrentLayout} title="Alt+S">Save <span className="th-hotkey">S</span></button>
            <button type="button" className="th-mode-btn" onClick={restoreSavedLayout} title="Alt+R">Restore <span className="th-hotkey">R</span></button>
            <button type="button" className="th-mode-btn" onClick={resetFloatingPanels} title="Alt+0">Reset Floating <span className="th-hotkey">0</span></button>
          </div>
          {terminalDensityMode === "focus" ? (
            <div className="th-mode-toggle" role="group" aria-label="Focus panel controls">
              {TERMINAL_FOCUS_DECKS.map((deck) => {
                const toggleTestId = deck.id === "micro"
                  ? "terminal-focus-toggle-micro"
                  : deck.id === "markets"
                    ? "terminal-focus-toggle-markets"
                    : deck.id === "monitoring"
                      ? "terminal-focus-toggle-ops"
                      : undefined;
                return (
                  <button
                    key={deck.id}
                    type="button"
                    data-testid={toggleTestId}
                    className={`th-mode-btn${focusDeckSet.has(deck.id) ? " active" : ""}`}
                    onClick={() => toggleFocusDeck(deck.id)}
                    title="Reactivate this panel family in focus mode"
                  >
                    {deck.label}
                  </button>
                );
              })}
            </div>
          ) : null}
          <div className="th-mode-toggle" role="group" aria-label="Workspace controls">
            <button type="button" className="th-mode-btn" onClick={() => cycleWorkspace(-1)} title="Alt+Left">◀</button>
            <input
              value={layoutWorkspaceName}
              onChange={(event) => setLayoutWorkspaceName(event.target.value)}
              className="layout-workspace-input"
              placeholder="Workspace"
              aria-label="Workspace name"
            />
            <button type="button" className="th-mode-btn" onClick={saveNamedWorkspace}>Save WS</button>
            <select
              value={layoutWorkspaceOptions.includes(layoutWorkspaceName) ? layoutWorkspaceName : ""}
              className="layout-workspace-select"
              onChange={(event) => {
                const v = event.target.value;
                if (v.startsWith("__team__:")) {
                  const presetName = v.slice("__team__:".length);
                  const preset = TEAM_PRESETS[presetName];
                  if (preset) {
                    const fb = buildLayoutPreset("swing", uiMode === "novice");
                    const n = normalizeDockLayout(preset, fb);
                    applyNormalizedLayoutState(n);
                    const copyName = `Copy of ${presetName.replace("⬡ ", "")}`;
                    setLayoutWorkspaceName(copyName);
                    saveWorkspaceBundle(copyName, n);
                    setLayoutWorkspaceOptions((prev) => prev.includes(copyName) ? prev : [...prev, copyName]);
                  }
                } else {
                  loadNamedWorkspace(v);
                }
              }}
              aria-label="Load workspace"
            >
              <option value="" disabled>Load…</option>
              <optgroup label="My Workspaces">
                {layoutWorkspaceOptions.map((name) => <option key={name} value={name}>{name}</option>)}
              </optgroup>
              <optgroup label="── Team Templates ──">
                {TEAM_PRESET_NAMES.map((name) => (
                  <option key={`team-${name}`} value={`__team__:${name}`}>{name}</option>
                ))}
              </optgroup>
            </select>
            <button type="button" className="th-mode-btn" onClick={deleteNamedWorkspace}>Delete</button>
            <button type="button" className="th-mode-btn" onClick={exportLayoutsJson}>Export</button>
            <button type="button" className="th-mode-btn" onClick={() => layoutImportInputRef.current?.click()}>Import</button>
            <button type="button" className="th-mode-btn" onClick={() => cycleWorkspace(1)} title="Alt+Right">▶</button>
            {workspaceHintBadge ? <span className="layout-workspace-hint-badge">{workspaceHintBadge}</span> : null}
            <input
              ref={layoutImportInputRef}
              type="file"
              accept="application/json"
              style={{ display: "none" }}
              onChange={async (event) => {
                const file = event.target.files?.[0];
                if (!file) {
                  return;
                }
                try {
                  await importLayoutsJson(file);
                } catch {
                  setError("Import layout JSON impossible");
                } finally {
                  event.target.value = "";
                }
              }}
            />
          </div>
          <button type="button" onClick={() => void loadAll()} disabled={busy} className="chart-chip" style={{ fontSize: 11, padding: "4px 10px" }}>↻</button>
        </div>
      </header>

      {error ? <div className="term-error-bar warn">{error}</div> : null}

      {/* ═══════════════ SYNTHÈSE OPÉRATEUR ═══════════════════ */}
      <section className="panel term-synth-bar">
        <div className="synth-items">
          <div className="synth-item"><span className="synth-icon">◎</span><span className="synth-label">Route</span><span className="synth-val">{preferredRoute ? String(preferredRoute.venue || "–") : "–"}</span></div>
          <div className="synth-item"><span className="synth-icon">↔</span><span className="synth-label">Spread</span><span className={`synth-val ${preferredSpread > 2 ? "warn" : "good"}`}>{preferredSpread.toFixed(4)}</span></div>
          <div className="synth-item"><span className="synth-icon">≈</span><span className="synth-label">Slip</span><span className={`synth-val ${avgSlippage > 15 ? "warn" : "good"}`}>{avgSlippage.toFixed(1)} bps</span></div>
          <div className="synth-item"><span className="synth-icon">◔</span><span className="synth-label">Latence</span><span className={`synth-val ${avgLatency > 200 ? "warn" : "good"}`}>{avgLatency.toFixed(0)} ms</span></div>
          <div className="synth-item"><span className="synth-icon">▤</span><span className="synth-label">DOM</span><span className={`synth-val ${displayDepthStreamState === "live" ? "good" : "warn"}`}>{displayDepthStreamState}</span></div>
          <div className="synth-item"><span className="synth-icon">Δ</span><span className="synth-label">Footprint</span><span className={`synth-val ${toNumber(dominantFootprint?.delta, 0) >= 0 ? "good" : "warn"}`}>{toNumber(dominantFootprint?.delta, 0).toFixed(0)}</span></div>
          <div className="synth-item"><span className="synth-icon">!</span><span className="synth-label">Incidents</span><span className={`synth-val ${openIncidents > 0 ? "warn" : "good"}`}>{openIncidents}</span></div>
          <div className="synth-item"><span className="synth-icon">×</span><span className="synth-label">Kill</span><span className={`synth-val ${String(overview?.kill_switch_active) === "true" ? "warn" : "good"}`}>{String(overview?.kill_switch_active || "off")}</span></div>
        </div>
      </section>

      <section className="term-decision-layer">
        <article className={`term-decision-card tone-${decisionGateTone}`}>
          <div className="term-decision-card-head">
            <div>
              <span className="eyebrow">Decision Layer</span>
              <div className="term-decision-title">{decisionGateLabel} · {marketDecisionV1.scenarioLabel}</div>
            </div>
            <span className={`term-decision-badge tone-${decisionGateTone}`}>{decisionGateLabel}</span>
          </div>
          <div className="term-decision-metrics">
            <span className="term-decision-metric"><strong>{marketDecisionV1.globalConfidencePct}%</strong><span>confidence</span></span>
            <span className="term-decision-metric"><strong>{marketDecisionV1.confluenceScorePct}%</strong><span>confluence</span></span>
            <span className="term-decision-metric"><strong>{marketDecisionV1.scenarioProbabilityPct}%</strong><span>probabilité</span></span>
            <span className="term-decision-metric"><strong>{executionGuardLabel}</strong><span>discipline</span></span>
          </div>
          <div className="term-decision-summary">{marketDecisionV1.actionTitle}</div>
          <div className="term-decision-body">{decisionGateBody}</div>
          {decisionBracket ? (
            <div className="term-decision-bracket">
              <span className={`term-decision-side ${decisionBracket.side}`}>{decisionBracket.side === "buy" ? "Acheter" : "Vendre"}</span>
              <span>Entry {decisionBracket.entry.toFixed(chartPriceDigits)}</span>
              <span>SL {decisionBracket.sl.toFixed(chartPriceDigits)}</span>
              <span>TP {decisionBracket.tp.toFixed(chartPriceDigits)}</span>
              <span>RR {decisionBracket.rr.toFixed(2)}</span>
            </div>
          ) : (
            <div className="term-decision-bracket inactive">
              <span>Aucun bracket tant que le biais reste neutre ou insuffisamment confirmé.</span>
            </div>
          )}
          <div className="term-decision-evidence-list">
            {topDecisionEvidence.map((item) => (
              <div key={`decision-evidence-${item.id}`} className="term-decision-evidence-row">
                <span className={`term-decision-evidence-direction ${item.direction}`}>{item.label}</span>
                <span className="term-decision-evidence-detail">{item.detail}</span>
                <span className="term-decision-evidence-score">{item.scorePct}%</span>
              </div>
            ))}
          </div>
        </article>

        <div className="term-state-stack">
          <div className="term-state-grid">
            <article className="term-state-card">
              <span className="term-state-card-label">Signal</span>
              <strong>{marketDecisionV1.biasDirection === "neutral" ? "Neutre" : marketDecisionV1.biasDirection === "buy" ? "Long bias" : "Short bias"}</strong>
              <span>{marketDecisionV1.probableReversalZoneLabel}</span>
              <span>{marketDecisionV1.historicalLearning.sampleSize} samples · WR {marketDecisionV1.historicalLearning.winratePct.toFixed(0)}%</span>
            </article>
            <article className={`term-state-card tone-${riskSummary?.alert || hardAlertActive ? "caution" : "go"}`}>
              <span className="term-state-card-label">Risk</span>
              <strong>{hardAlertActive ? "Escalade" : riskSummary?.alert ? "Sous surveillance" : "Contrôlé"}</strong>
              <span>Miss {riskSummary ? `${riskSummary.miss_in_window}/${riskSummary.window_size}` : "–"}</span>
              <span>Kill {killSwitchActive ? "ON" : "OFF"} · incidents {openIncidents}</span>
            </article>
            <article className={`term-state-card tone-${avgLatency > 200 || avgSlippage > 15 ? "caution" : "go"}`}>
              <span className="term-state-card-label">Execution</span>
              <strong>{preferredRouteLabel || "Route indisponible"}</strong>
              <span>Spread {preferredSpread.toFixed(4)} · slip {avgSlippage.toFixed(1)} bps</span>
              <span>Lat {avgLatency.toFixed(0)} ms · deviation {routeDeviationBps.toFixed(2)} bps</span>
            </article>
            <article className={`term-state-card tone-${persistenceTone}`}>
              <span className="term-state-card-label">Etat système</span>
              <strong>{displayDepthStreamState === "live" ? "Market bus live" : "Flux dégradé"}</strong>
              <span>MT5 {String(mt5Health?.status || "–")} · RG {String(riskGateway?.healthy ?? "–")}</span>
              <span>Persist {selfLearningStorageLabel} · {selfLearningV4PersistenceStatus.message || "ready"}</span>
            </article>
          </div>

          <div className="term-performance-grid">
            <article className={`term-performance-card tone-${performanceDeskTone}`}>
              <div className="term-performance-head">
                <div>
                  <span className="eyebrow">Performance Desk <HelpHint text="Le Performance Desk relie les chiffres de performance au type de capital sous-jacent: broker live, broker paper, exchange ou wallet." examples={["Avant de lire une bonne perf comme du vrai live, regarde la ligne source-capital juste en dessous.", "Si une source exchange n'est pas canonique, elle ne doit pas etre lue comme du capital pleinement gouverne."]} /></span>
                  <div className="term-performance-title">Attribution stratégie · symbole · venue</div>
                </div>
                <span className={`term-decision-badge tone-${performanceDeskTone}`}>{performanceSummary?.trade_count || 0} trades</span>
              </div>
              <div className="term-report-body" style={{ marginBottom: 12 }}>
                <span>Scope agrégé: <strong>strategy = mt5-live</strong>, mais lecture source-capital désormais explicitée ci-dessous.</span>
                <span>Le desk distingue les comptes broker live, broker paper, les sources exchange et les wallets pour éviter une lecture client ambiguë.</span>
                <span><Link href="/live-capital">Ouvrir Live Capital</Link> pour canoniser une source, vérifier ses fonds et poser un cap USD portefeuille.</span>
              </div>
              <div className="term-performance-metrics">
                <span><strong>{performanceSummary ? performanceSummary.realized_pnl_usd.toLocaleString("fr-FR", { style: "currency", currency: "USD", maximumFractionDigits: 0 }) : "–"}</strong><span>PnL réalisé</span></span>
                <span><strong>{performanceSummary ? `${performanceSummary.win_rate_pct.toFixed(0)}%` : "–"}</strong><span>win rate</span></span>
                <span><strong>{performanceSummary ? `${performanceSummary.avg_slippage_bps.toFixed(1)} bps` : "–"}</strong><span>slippage</span></span>
                <span><strong>{performanceSummary ? `${performanceSummary.avg_latency_ms.toFixed(0)} ms` : "–"}</strong><span>latence</span></span>
              </div>
              <div className="term-performance-table">
                {performanceCapitalBreakdown.map((group) => (
                  <div key={group.label} className="term-performance-row">
                    <span>{group.label}</span>
                    <span>{group.count} source(s)</span>
                    <span>{group.equityUsd > 0 ? formatCurrency(group.equityUsd) : "-"}</span>
                    <span>{group.rows.some((row) => !row.canonical) ? "linked" : "canonique"}</span>
                    <strong>{group.rows.length > 0 ? group.rows.map((row) => row.displayName).slice(0, 2).join(", ") : "aucune source"}</strong>
                  </div>
                ))}
                {performanceCapitalPreview.length > 0 ? performanceCapitalPreview.map((row) => (
                  <div key={row.key} className="term-performance-row">
                    <span>{row.displayName}</span>
                    <span>{row.platform}</span>
                    <span>{row.environment}</span>
                    <span>{row.status}</span>
                    <strong>{row.latestEquityUsd != null ? formatCurrency(row.latestEquityUsd) : (row.canonical ? "canonique" : "à canoniser")}</strong>
                  </div>
                )) : null}
                {topPerformanceAttribution.length > 0 ? topPerformanceAttribution.map((row, index) => (
                  <div key={`perf-row-${row.strategy_id || "none"}-${row.symbol || "none"}-${row.venue || "none"}-${index}`} className="term-performance-row">
                    <span>{row.symbol || row.strategy_id || "n/a"}</span>
                    <span>{row.venue || "–"}</span>
                    <span>{row.trade_count} tr</span>
                    <span>{`${row.pnl_contribution_pct.toFixed(0)}%`}</span>
                    <strong>{row.realized_pnl_usd.toLocaleString("fr-FR", { style: "currency", currency: "USD", maximumFractionDigits: 0 })}</strong>
                  </div>
                )) : (
                  <div className="term-performance-empty">Aucune attribution exploitable sur le scope courant.</div>
                )}
              </div>
            </article>

            <article className={`term-performance-card tone-${latestInvestorReport ? "go" : "watch"}`}>
              <div className="term-performance-head">
                <div>
                  <span className="eyebrow">Investor Report <HelpHint text="Résumé du dernier reporting investisseur généré pour donner une lecture client ou comité du portefeuille." examples={["Si aucun rapport n'apparait, le desk reste lisible pour l'ops mais pas encore pour un reporting client propre.", "Le scope du rapport aide a comprendre quel portefeuille ou quelle strategie est couverte."]} /></span>
                  <div className="term-performance-title">Dernier rapport généré</div>
                </div>
                <span className={`term-decision-badge tone-${latestInvestorReport ? "go" : "watch"}`}>{latestInvestorReport?.status || "none"}</span>
              </div>
              <div className="term-report-body">
                <strong>{latestInvestorReportSummary ? String(latestInvestorReportSummary.headline || latestInvestorReport?.report_id || "Rapport") : "Aucun rapport généré"}</strong>
                <span>{latestInvestorReport ? `${latestInvestorReport.report_type} · ${latestInvestorReport.report_month}` : "Génère un report via l’endpoint investor-reports pour alimenter cette zone."}</span>
                <span>{latestInvestorReport?.published_at ? `Publié ${new Date(latestInvestorReport.published_at).toLocaleString("fr-FR")}` : "Pas encore publié"}</span>
                <span>{latestInvestorReportSummary ? String((((latestInvestorReportSummary.supplemental_strategy as JsonMap | undefined)?.strategy_id) || ((latestInvestorReportSummary.scope as JsonMap | undefined)?.portfolio_name) || "Scope interne")) : "Scope interne"}</span>
              </div>
            </article>
          </div>
        </div>
      </section>

      {/* ═══════════════ CORE: CHART + EXECUTION LANE ══════════ */}
      <section className="term-core">
        <PanelGroup
          ref={termCoreGroupRef}
          direction="horizontal"
          autoSaveId={termCoreAutoSaveId}
          className="txt-split-group"
          onLayout={(sizes) => {
            const left = Number(sizes[0] || 0);
            if (Number.isFinite(left) && left > 0) {
              setLayoutCoreSplit(Math.max(52, Math.min(85, left)));
            }
          }}
        >
          <Panel defaultSize={layoutCoreSplit} minSize={52} className="txt-split-panel txt-split-panel-left">

        {/* ── CHART PREMIUM ── */}
        <PanelShell className="panel term-chart-panel chart-container gtix-panel-resizable">
          <div className="chart-top-row">
            <div className="chart-top-left">
              <span className="eyebrow" style={{ marginRight: 8 }}>Chart premium</span>
              <span className="chart-symbol-badge">{selectedChartSymbol}</span>
              <span className="chart-inline-timeframe">{chartTimeframe}</span>
              {signalAlertBadgeCount > 0 ? (
                <button type="button" className={`chart-signal-badge chart-signal-badge-${marketDecisionV1.biasDirection}`} onClick={() => setSignalAlertBadgeCount(0)}>
                  Signal {signalAlertBadgeCount}
                </button>
              ) : null}
              <span className={`chart-change-pill ${chartChange >= 0 ? "bull" : "bear"}`}>{chartChange >= 0 ? "+" : ""}{chartChangePct.toFixed(2)}%</span>
              <span className={`chart-price-live ${chartChange >= 0 ? "bull" : "bear"}`}>{String(latestQuote?.last || "–")}</span>
            </div>
            <div className="chart-toolbar-right">
              <select value={selectedChartSymbol} onChange={(event) => setActiveChartSymbol(event.target.value)} className="chart-symbol-selector" aria-label="Symbol selector">
                {uniqueFilteredQuotes.slice(0, 18).map((quote) => {
                  const symbolValue = instrumentLabel(quote);
                  return <option key={`sel-${symbolValue}`} value={symbolValue}>{symbolValue}</option>;
                })}
              </select>
              <span className="chart-chip active">1 Chart</span>
              {(["assisted", "semi-auto", "full-auto"] as const).map((mode) => (
                <button
                  key={`top-mode-${mode}`}
                  type="button"
                  className={`chart-chip ${autoExecutionMode === mode ? "active" : ""}`}
                  onClick={() => setAutoExecutionMode(mode)}
                >
                  {mode === "assisted" ? "Human" : mode === "semi-auto" ? "Hybrid" : "AI"}
                </button>
              ))}
              {(["auto", "balanced", "ultra"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={`chart-chip ${chartPerfMode === mode ? "active" : ""}`}
                  title={mode === "auto" ? "Auto: standard chart interaction" : mode === "balanced" ? "Balanced: full chart interaction" : "Ultra: reduced rendering overhead"}
                  onClick={() => {
                    setChartPerfMode(mode);
                  }}
                >
                  {mode === "auto" ? "Perf:A" : mode === "balanced" ? "Perf:B" : "Perf:U"}
                </button>
              ))}
              <button
                type="button"
                className={`chart-chip ${chartPerceptualDebugOpen ? "active" : ""}`}
                onClick={() => setChartPerceptualDebugOpen((current) => !current)}
                title="Afficher le panneau debug perceptif du chart"
              >
                Percept {chartPerceptualDebugOpen ? "ON" : "OFF"}
              </button>
              <button
                type="button"
                data-testid="terminal-compute-perf-toggle"
                className={`chart-chip ${terminalComputePerfEnabled ? "active" : ""}`}
                onClick={toggleTerminalComputePerf}
                title="Activer le profiling des derives Terminal cote navigateur"
              >
                CPU {terminalComputePerfEnabled ? "ON" : "OFF"}
              </button>
              {terminalComputePerfEnabled ? (
                <span
                  data-testid="terminal-compute-perf-summary"
                  className={`chart-chip ${terminalComputePerfSummary.length > 0 ? "active" : ""}`}
                  title={terminalComputePerfSummary.length > 0
                    ? terminalComputePerfSummary
                      .slice(0, 3)
                      .map((entry) => `${entry.label}: total ${entry.totalMs.toFixed(1)}ms avg ${entry.avgMs.toFixed(1)}ms count ${entry.count}`)
                      .join(" | ")
                    : "Profiling actif, attente d'un cycle de calcul"}
                >
                  {terminalComputePerfSummary[0]
                    ? `${terminalComputePerfSummary[0].label} ${terminalComputePerfSummary[0].totalMs.toFixed(1)}ms`
                    : "CPU warming"}
                </span>
              ) : null}
              {(["auto", "clean", "full"] as const).map((mode) => (
                <button
                  key={`visual-${mode}`}
                  type="button"
                  className={`chart-chip ${chartVisualMode === mode ? "active" : ""}`}
                  title={mode === "auto" ? "Adaptive clean policy driven by preset and viewport" : mode === "clean" ? "Force cleaner chart view and rely on sidecars" : "Keep premium overlays visible"}
                  onClick={() => setChartVisualMode(mode)}
                >
                  {mode === "auto" ? "View:A" : mode === "clean" ? "View:C" : "View:F"}
                </button>
              ))}
              {(["line", "candles", "footprint"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`chart-chip ${chartMode === m ? "active" : ""}`}
                  onClick={() => {
                    setChartMode(m);
                    if (m === "candles" && isGtixPublicBrowserHost() && chartVisualMode !== "full") {
                      setChartVisualMode("clean");
                    }
                  }}
                >
                  {m === "line" ? "L" : m === "candles" ? "C" : "FP"}
                </button>
              ))}
              {CHART_TIMEFRAME_SELECTOR_PRIMARY.map((tf) => (
                <button key={tf} type="button" className={`chart-chip ${chartTimeframe === tf ? "active" : ""}`} aria-pressed={chartTimeframe === tf} onClick={() => setActiveChartTimeframe(tf)}>{tf}</button>
              ))}
              {CHART_TIMEFRAME_SELECTOR_SECONDARY.map((tf) => (
                <button key={tf} type="button" className={`chart-chip ${chartTimeframe === tf ? "active" : ""}`} aria-pressed={chartTimeframe === tf} onClick={() => setActiveChartTimeframe(tf)}>{tf}</button>
              ))}
              <button type="button" className="chart-chip" onClick={() => setChartWindow((v) => Math.max(30, v - 20))}>+</button>
              <button type="button" className="chart-chip" onClick={() => setChartWindow((v) => Math.min(500, v + 20))}>−</button>
              {/* ── Indicator active pills ── */}
              {activeIndicators.map((ind) => (
                <span key={`ind-pill-${ind.id}`} className="chart-chip chart-chip-indicator active">
                  {ind.id}
                  <button
                    type="button"
                    className="chart-chip-remove"
                    aria-label={`Remove ${ind.id}`}
                    onClick={(e) => { e.stopPropagation(); toggleIndicator(ind.id); }}
                  >×</button>
                </span>
              ))}
              {/* ── Indicator picker button ── */}
              <div className="chart-indicator-picker-wrap">
                <button
                  type="button"
                  className={`chart-chip ${showIndicatorPanel ? "active" : ""}`}
                  onClick={() => setShowIndicatorPanel((v) => !v)}
                  aria-expanded={showIndicatorPanel}
                  aria-label="Add indicator"
                >
                  Ind {showIndicatorPanel ? "▲" : "▼"}
                </button>
                {showIndicatorPanel && (
                  <div className="chart-indicator-panel" role="menu">
                    {INDICATOR_CATALOG.map(({ category, ids }) => (
                      <div key={category} className="chart-indicator-group">
                        <span className="chart-indicator-group-label">{category}</span>
                        <div className="chart-indicator-group-chips">
                          {ids.map((id) => {
                            const on = activeIndicators.some((a) => a.id === id);
                            return (
                              <button
                                key={id}
                                type="button"
                                className={`chart-chip ${on ? "active" : ""}`}
                                onClick={() => toggleIndicator(id)}
                                role="menuitemcheckbox"
                                aria-checked={on}
                              >
                                {id}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                    <button
                      type="button"
                      className="chart-chip chart-indicator-panel-close"
                      onClick={() => setShowIndicatorPanel(false)}
                    >
                      close
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className={`chart-meta-strip ${marketSignalV1.focusMode ? "signal-focus" : ""}`}>
            <span className="chart-overlay-chip chart-overlay-chip-emphasis">{selectedChartSymbol}</span>
            <span className="chart-overlay-chip">{chartTimeframe}</span>
            <span className={`chart-overlay-chip ${localOhlcvAnalysis.signal === "OHLCV_RENDERABLE" ? "chart-overlay-chip-good" : "chart-overlay-chip-warn"}`}>Feed {selectedChartInstrument} @ {selectedChartVenue}</span>
            <span className={`chart-overlay-chip ${localOhlcvAnalysis.signal === "OHLCV_RENDERABLE" ? "chart-overlay-chip-good" : "chart-overlay-chip-warn"}`}>OHLCV {localOhlcvAnalysis.signal === "OHLCV_RENDERABLE" ? "RENDERABLE" : localOhlcvAnalysis.signal === "OHLCV_PARTIAL" ? "PARTIAL" : "UNUSABLE"}</span>
            <span className={`chart-overlay-chip chart-overlay-chip-signal chart-overlay-chip-signal-${marketSignalV1.dominantDirection}`}>{marketSignalV1.headline}</span>
            <span className="chart-overlay-chip chart-overlay-chip-good">Buy Pressure {marketSignalV1.buyPressurePct.toFixed(0)}%</span>
            <span className={`chart-overlay-chip chart-overlay-chip-signal chart-overlay-chip-signal-${marketDecisionV1.biasDirection}`}>{marketDecisionV1.scenarioLabel} {marketDecisionV1.scenarioProbabilityPct}%</span>
            <span className="chart-overlay-chip">Confidence {marketDecisionV1.globalConfidencePct}%</span>
            <span className="chart-overlay-chip">Calib {marketSignalV1.calibrationLabel}</span>
            {marketDecisionV1.probableReversalZone !== null ? <span className="chart-overlay-chip chart-overlay-chip-warn">{marketDecisionV1.probableReversalZoneLabel}</span> : null}
            {marketSignalV1.signals.slice(0, 2).map((signal) => (
              <span
                key={`signal-chip-${signal.id}-${signal.direction}`}
                className={`chart-overlay-chip ${signal.severity === "critical" ? "chart-overlay-chip-warn" : signal.direction === "buy" ? "chart-overlay-chip-good" : signal.direction === "sell" ? "chart-overlay-chip-warn" : ""}`}
                title={signal.detail}
              >
                {signal.label}
              </span>
            ))}
            <span className="chart-overlay-chip">1 Chart · 3 Modes</span>
            <span className="chart-overlay-chip">{modeUxProfile.shortLabel}</span>
            <span className="chart-overlay-chip">{modeUxProfile.summary}</span>
            <span className={`chart-overlay-chip ${replayState.enabled ? "chart-overlay-chip-warn" : "chart-overlay-chip-good"}`}>{replayState.enabled ? "REPLAY MODE" : "LIVE MODE"}</span>
            <span className="chart-overlay-chip chart-overlay-chip-good">VWAP D/W/M {dayVwap > 0 ? dayVwap.toFixed(2) : "–"} / {weekVwap > 0 ? weekVwap.toFixed(2) : "–"} / {monthVwap > 0 ? monthVwap.toFixed(2) : "–"}</span>
            {uiMode === "expert" ? <span className="chart-overlay-chip">Sessions Asia / London / New York</span> : null}
            <span className="chart-overlay-chip">FVG/OB {overlaySummary || "–"}</span>
            {uiMode === "expert" ? <span className="chart-overlay-chip">Liquidity {liquiditySummary || "–"}</span> : null}
            <span className="chart-overlay-chip">Range {chartMin > 0 ? `${chartMin.toFixed(0)}–${chartMax.toFixed(0)}` : "–"}</span>
            <span className={`chart-overlay-chip ${chartChange >= 0 ? "chart-overlay-chip-good" : "chart-overlay-chip-warn"}`}>Δ {chartChange >= 0 ? "+" : ""}{chartChangePct.toFixed(2)}%</span>
            <span className="chart-overlay-chip">Spread {chartHeaderSpread > 0 ? chartHeaderSpread.toFixed(2) : "–"}</span>
            {uiMode === "expert" ? <span className="chart-overlay-chip">active tKey {activeTimeKey || "–"}</span> : null}
          </div>

          <div className={`replay-control-strip ${replayState.enabled ? "active" : ""}`}>
            <span className="replay-badge">{replayState.enabled ? "REPLAY MODE" : "LIVE"}</span>
            <span className="replay-time">{replayCurrentTimeLabel}</span>
            {uiMode === "expert" ? <span className="replay-frame-index">frame {replayCurrentIndex + 1}/{Math.max(1, replayFrames.length)}</span> : null}
            <div className="replay-slider-wrap">
              <input
                type="range"
                min={0}
                max={replayMaxIndex}
                value={replayCurrentIndex}
                disabled={replayFrames.length === 0}
                onChange={(event) => {
                  const nextIndex = clampIndex(Number(event.target.value || 0), replayMaxIndex);
                  setReplayState((current) => ({
                    ...current,
                    enabled: true,
                    playing: false,
                    cursorIndex: nextIndex,
                    timeKey: replayFrames[nextIndex]?.timeKey || null,
                  }));
                }}
                className="replay-slider"
              />
              <div className="replay-tick-layer" aria-hidden="true">
                {visibleReplayMarkers.map((marker) => {
                  const leftPct = replayMaxIndex > 0 ? (marker.frameIndex / replayMaxIndex) * 100 : 0;
                  return (
                    <span
                      key={`tick-${marker.id}`}
                      className={["replay-tick-item", `replay-tick-${marker.kind}`, marker.kind === "outcome" ? (marker.label.startsWith("+") ? "replay-tick-outcome-profit" : "replay-tick-outcome-loss") : "", marker.critical ? "critical" : "", marker.frameIndex === replayCurrentIndex ? "active" : ""].filter(Boolean).join(" ")}
                      style={{ left: `${Math.max(0, Math.min(100, leftPct))}%` }}
                    />
                  );
                })}
              </div>
            </div>
            <button type="button" className="chart-chip" onClick={() => stepReplay(-10)} disabled={replayFrames.length === 0}>-10</button>
            <button type="button" className="chart-chip" onClick={() => stepReplay(-1)} disabled={replayFrames.length === 0}>◀</button>
            <button type="button" className="chart-chip" onClick={() => stepReplay(1)} disabled={replayFrames.length === 0}>▶</button>
            <button type="button" className="chart-chip" onClick={() => stepReplay(10)} disabled={replayFrames.length === 0}>+10</button>
            {[1, 2, 4, 8].map((speed) => (
              <button key={`sp-${speed}`} type="button" className={`chart-chip ${replayState.speed === speed ? "active" : ""}`} onClick={() => setReplaySpeed(speed as ReplaySpeed)} disabled={!replayState.enabled && replayFrames.length === 0}>x{speed}</button>
            ))}
            {!replayState.enabled ? (
              <button type="button" className="chart-chip" onClick={enableReplay} disabled={replayFrames.length === 0}>Enable Replay</button>
            ) : (
              <button type="button" className="chart-chip" onClick={exitReplayMode}>Back Live</button>
            )}
            {uiMode === "expert" ? <span className="replay-critical-note">critical auto-stop {criticalReplayFrameIndexes.length > 0 ? "on" : "none"}</span> : null}
            {timeSyncDiagnostics.mismatchCount > 0 && (
              <span className="replay-time-sync-warning" title={`time sync mismatch: ${timeSyncMismatchLabel}`}>
                sync drift {timeSyncDiagnostics.mismatchCount}
              </span>
            )}
            {uiMode === "expert" ? <div className="replay-marker-filter-row">
              <button type="button" className={`replay-filter-toggle${replayFilterKinds.length === 0 && !replayFilterCritical ? " active" : ""}`} onClick={() => { setReplayFilterKinds([]); setReplayFilterCritical(false); }}>All</button>
              {(["intent", "routing", "approval", "fill", "incident", "outcome", "latent"] as const).map((kind) => (
                <button key={kind} type="button" className={`replay-filter-toggle replay-filter-${kind}${replayFilterKinds.includes(kind) ? " active" : ""}`} onClick={() => toggleReplayFilterKind(kind)}>{kind}</button>
              ))}
              <button type="button" className={`replay-filter-toggle replay-filter-critical${replayFilterCritical ? " active" : ""}`} onClick={() => setReplayFilterCritical((v) => !v)}>★ critical</button>
            </div> : null}
            <div className="replay-events-track" role="list" aria-label="Replay events timeline">
              {visibleReplayMarkers.map((marker) => {
                const leftPct = replayMaxIndex > 0 ? (marker.frameIndex / replayMaxIndex) * 100 : 0;
                return (
                  <button
                    key={marker.id}
                    type="button"
                    role="listitem"
                    className={["replay-event-marker", `replay-event-${marker.kind}`, marker.kind === "outcome" ? (marker.label.startsWith("+") ? "profit" : "loss") : "", marker.critical ? "critical" : "", marker.frameIndex === replayCurrentIndex ? "active" : ""].filter(Boolean).join(" ")}
                    style={{ left: `${Math.max(0, Math.min(100, leftPct))}%` }}
                    onClick={() => jumpToReplayFrame(marker.frameIndex)}
                    title={`${marker.label} · ${marker.detail}`}
                  >
                    <span>{marker.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="chart-symbol-chips">
            {uniqueFilteredQuotes.slice(0, 8).map((quote) => {
              const s = instrumentLabel(quote);
              return (
                <button key={s} type="button" className={`chart-chip ${selectedChartSymbol === s ? "active" : ""}`} onClick={() => setActiveChartSymbol(s)}>{s}</button>
              );
            })}
          </div>

          <ModuleGuide
            mode={uiMode}
            title="Chart guide"
            what="Le chart réunit prix, zones techniques, liquidité et contexte de décision dans la même vue."
            why="Il permet de confirmer rapidement si le signal reste cohérent avec la structure et le flux d'exécution."
            example="Si le prix reprend la VWAP, défend une zone de liquidité et garde un delta positif, le contexte reste plus favorable."
          />
          <div className="chart-v2-flag-row">
            <button type="button" className={`chart-chip ${terminalV2Enabled ? "active" : ""}`} onClick={toggleTerminalV2}>
              V2 Surface {terminalV2Enabled ? "ON" : "OFF"}
            </button>
            <button type="button" className={`chart-chip ${chartEngineMode === "v4" ? "active" : ""}`} onClick={toggleChartEngineMode}>
              Engine {chartEngineMode.toUpperCase()}
            </button>
            <button type="button" className={`chart-chip ${gpuViewportGrid === "auto" ? "active" : ""}`} onClick={() => setGpuViewportGridMode("auto")}>
              Grid AUTO
            </button>
            <button type="button" className={`chart-chip ${gpuViewportGrid === 1 ? "active" : ""}`} onClick={() => setGpuViewportGridMode(1)}>
              Grid 1x1
            </button>
            <button type="button" className={`chart-chip ${gpuViewportGrid === 4 ? "active" : ""}`} onClick={() => setGpuViewportGridMode(4)}>
              Grid 2x2
            </button>
            <button type="button" className={`chart-chip ${gpuViewportGrid === 16 ? "active" : ""}`} onClick={() => setGpuViewportGridMode(16)}>
              Grid 4x4
            </button>
            <button type="button" className={`chart-chip ${chartSmoothingMs === 0 ? "active" : ""}`} onClick={() => setChartSmoothingMode(0)}>
              Smooth OFF
            </button>
            <button type="button" className={`chart-chip ${chartSmoothingMs === 80 ? "active" : ""}`} onClick={() => setChartSmoothingMode(80)}>
              Smooth 80ms
            </button>
            <button type="button" className={`chart-chip ${chartSmoothingMs === 140 ? "active" : ""}`} onClick={() => setChartSmoothingMode(140)}>
              Smooth 140ms
            </button>
            <button type="button" className={`chart-chip ${chartSmoothingMs === 220 ? "active" : ""}`} onClick={() => setChartSmoothingMode(220)}>
              Smooth 220ms
            </button>
            <button type="button" className={`chart-chip ${kernelBenchmarkRate > 0 ? "active" : ""}`} onClick={cycleKernelBenchmark}>
              {benchmarkLabel}
            </button>
            <span className="chart-overlay-chip">Feature flag: NEXT_PUBLIC_TERMINAL_V2 or ?v2=1</span>
            <span className="chart-overlay-chip">Engine flag: NEXT_PUBLIC_TERMINAL_ENGINE_V4 or ?engine=v4</span>
          </div>

          {terminalV2Enabled ? (
            <TerminalChartV2
              enabled={terminalV2Enabled}
              onToggleEnabled={toggleTerminalV2}
              symbol={selectedChartSymbol}
              timeframe={chartTimeframe}
              liveFeedKey={`${selectedChartInstrument}|${selectedChartVenue}|${chartTimeframe}`}
              onTimeframeChange={setActiveChartTimeframe}
              chartWindow={chartWindow}
              onZoomIn={() => setChartWindow((value) => Math.max(30, value - 20))}
              onZoomOut={() => setChartWindow((value) => Math.min(500, value + 20))}
              candles={chartDisplayCandles}
              fallbackPrice={chartAnchorPrice > 0 ? chartAnchorPrice : (chartLastValue > 0 ? chartLastValue : 1)}
              loading={chartLoading}
              uiMode={uiMode}
              onUiModeChange={setUiMode}
              autoExecutionMode={autoExecutionMode}
              onAutoExecutionModeChange={setAutoExecutionMode}
              routingCandidates={routeCandidates.map((route) => ({
                venue: String(route.venue || "unknown"),
                instrument: String(route.instrument || selectedChartSymbol),
                spread: Number.isFinite(route.spread) ? route.spread : Number.MAX_SAFE_INTEGER,
                last: Number.isFinite(route.last) ? route.last : 0,
                score: Number.isFinite((route as JsonMap).score as number)
                  ? Number((route as JsonMap).score)
                  : Number.isFinite(route.spread) && route.spread > 0
                    ? Math.max(0, Math.min(100, 100 - route.spread * 10))
                    : 0,
              }))}
              routeVenue={preferredRoute ? String(preferredRoute.venue || "--") : "--"}
              routeScorePct={toNumber((preferredRoute as JsonMap | null)?.score, NaN)}
              depthState={displayDepthStreamState}
              domLevels={activeDomLevels}
              heatmapLevels={activeHeatmapLevels}
              riskMissRatioPct={toNumber(riskSummary?.ratio_miss_window, 0) * 100}
              riskHardAlert={hardAlertActive}
              riskGuardEnabled={chartRiskGuardEnabled}
              onToggleRiskGuard={() => setChartRiskGuardEnabled((value) => !value)}
              maxLossUsd={chartMaxLossUsd}
              onSetMaxLossUsd={setChartMaxLossUsd}
              targetGainUsd={chartTargetGainUsd}
              onSetTargetGainUsd={setChartTargetGainUsd}
              riskLossExceeded={chartRiskLossExceeded}
              riskTargetMiss={chartRiskTargetMiss}
              strategyLabel={chartOrderTicket.preset}
              onAutoReduce={handleV2AutoReduce}
              onAutoClose={handleV2AutoClose}
              onDomEntryFromLevel={handleV2DomEntryFromLevel}
              onDomExitFromLevel={handleV2DomExitFromLevel}
              chartLinkSymbolEnabled={chartLinkSymbolEnabled}
              onToggleChartLinkSymbol={() => setChartLinkSymbolEnabled((value) => !value)}
              chartLinkTimeframeEnabled={chartLinkTimeframeEnabled}
              onToggleChartLinkTimeframe={() => setChartLinkTimeframeEnabled((value) => !value)}
              selectedVenue={selectedChartVenue}
              availableVenues={Array.from(new Set(selectedQuoteRows.map((row) => String(row.venue || ""))).values()).filter(Boolean)}
              onSelectVenue={(venue) => setChartVenueOverride(venue || null)}
              multiChartRows={gpuMatrixRows.map((row) => ({
                symbol: row.symbol,
                price: row.price,
                deltaPct: row.deltaPct,
                spread: row.spread,
                venue: row.venue,
              }))}
              quoteHistory={quoteHistory}
              gpuViewportGrid={gpuViewportGrid}
              onSelectSymbol={setActiveChartSymbol}
              onSelectSymbolVenue={setActiveChartSymbolVenue}
              aiHeadline={marketSignalV1.headline}
              aiScenario={`${marketDecisionV1.scenarioLabel} ${marketDecisionV1.scenarioProbabilityPct}%`}
              aiConfidencePct={marketDecisionV1.globalConfidencePct}
              aiExplanation={overlayDecisionRationale || marketSignalV1.signals[0]?.detail || "No contextual explanation available."}
              indicatorSeries={indicatorSeriesForChart}
              chartEngineMode={chartEngineMode}
              chartSmoothingMs={chartSmoothingMs}
            />
          ) : (
            <div className={`chart-shell chart-shell-premium chart-shell-${chartMotionClass} chart-shell-signal-mode-${signalDisplayMode}`}>
            <aside className="chart-tools-panel" aria-label="Chart tools">
              <div className="chart-signal-kicker">1 CHART - 3 MODES</div>
              <div className="chart-mode-switch" role="group" aria-label="Execution mode">
                <button type="button" className={`chart-tool-btn chart-mode-btn ${autoExecutionMode === "assisted" ? "active" : ""}`} onClick={() => setAutoExecutionMode("assisted")}>HUMAN</button>
                <button type="button" className={`chart-tool-btn chart-mode-btn ${autoExecutionMode === "semi-auto" ? "active" : ""}`} onClick={() => setAutoExecutionMode("semi-auto")}>HYBRID</button>
                <button type="button" className={`chart-tool-btn chart-mode-btn ${autoExecutionMode === "full-auto" ? "active" : ""}`} onClick={() => setAutoExecutionMode("full-auto")}>AI</button>
              </div>
              <div className="chart-mode-label">{modeUxProfile.shortLabel}</div>
              <div className="chart-action-pill">{modeUxProfile.summary}</div>
              <div className="chart-tools-visual-group" role="group" aria-label="Chart visual mode">
                <button type="button" className={`chart-tool-btn ${chartVisualMode === "auto" ? "active" : ""}`} onClick={() => setChartVisualMode("auto")}>AUTO</button>
                <button type="button" className={`chart-tool-btn ${chartVisualMode === "clean" ? "active" : ""}`} onClick={() => setChartVisualMode("clean")}>CLEAN</button>
                <button type="button" className={`chart-tool-btn ${chartVisualMode === "full" ? "active" : ""}`} onClick={() => setChartVisualMode("full")}>FULL</button>
              </div>
              <div className="chart-tools-visual-note">{chartVisualPolicyLabel}</div>
              <button type="button" className={`chart-tool-btn ${showVwap ? "active" : ""}`} onClick={() => setShowVwap((v) => !v)}>VWAP</button>
              <button type="button" className={`chart-tool-btn ${showFvgOb ? "active" : ""}`} onClick={() => setShowFvgOb((v) => !v)}>FVG/OB</button>
              <button type="button" className={`chart-tool-btn ${showLiquidity ? "active" : ""}`} onClick={() => setShowLiquidity((v) => !v)}>LIQ</button>
              <button type="button" className={`chart-tool-btn ${showSessions ? "active" : ""}`} onClick={() => setShowSessions((v) => !v)}>SESS</button>
              <Link
                href={`/settings?chartPreset=${nextChartMotionPreset(chartMotionPreset)}#chart-motion-preset`}
                className={`chart-preset-reminder chart-preset-reminder-link chart-preset-reminder-${chartMotionClass}`}
                aria-label={`Preset actif: ${chartMotionPreset}. Cliquer pour appliquer ${nextChartMotionPreset(chartMotionPreset)} et ouvrir Settings.`}
                title={`Apply ${nextChartMotionPreset(chartMotionPreset)} and open Settings`}
              >
                <span className="chart-preset-reminder-kicker">Preset</span>
                <span className="chart-preset-reminder-value">{chartMotionPreset}</span>
              </Link>
            </aside>
            <div className={`chart-stage-wrap chart-stage-wrap-premium chart-stage-wrap-${chartMotionClass} ${chartOverlayCompactMode ? "chart-stage-wrap-compact-overlays" : ""} ${chartActiveSnapLine ? "is-execution-focus" : ""} ${marketSignalV1.focusMode ? "is-signal-focus" : ""} ${chartMaskActive ? "is-chart-invalid" : ""}`} ref={chartStageRef}>
              {chartOverlayCompactMode ? (
                <div className="chart-flow-banner chart-flow-banner-compact" aria-live="polite">
                  <span className={`chart-flow-pill tone-${marketBusHealthTone}`}>BUS {marketBusHealthStatus.toUpperCase()}</span>
                  <span className={`chart-flow-pill tone-${marketBusOhlcvContiguous ? "good" : "warn"}`}>{marketBusOhlcvContiguous ? "SEQ OK" : "SEQ GAP"} {marketBusOhlcvLatestSeq > 0 ? `#${marketBusOhlcvLatestSeq}` : "#-"}</span>
                  <span className={`chart-flow-pill tone-${marketFlowAlerts.length > 0 ? "warn" : "good"}`}>{chartCompactAlertLabel}</span>
                  <span className={`chart-flow-pill tone-${fusionChipTone}`}>FUSION {fusionPrice > 0 ? `${fusionPrice.toFixed(2)} · ${fusionVenueCount}V` : "OFF"}</span>
                  <span className={`chart-flow-pill tone-${predictedChipTone}`}>PRED {predictedPrice > 0 ? `${predictedPrice.toFixed(2)} ${predictedDeltaBps >= 0 ? "+" : ""}${predictedDeltaBps.toFixed(1)}bps` : "IDLE"}</span>
                  <span className={`chart-flow-pill tone-${arbChipTone}`}>ARB {arbOpportunity ? `${arbBuyVenue || "?"}→${arbSellVenue || "?"} ${arbNetSpread.toFixed(2)}` : "NONE"}</span>
                  <span className={`chart-flow-pill tone-${kernelChipTone}`}>{kernelTelemetryLabel}</span>
                  <span className={`chart-flow-pill tone-${schedulerChipTone}`}>{schedulerLabel}</span>
                  <span className={`chart-flow-pill tone-${candleProbeTone}`}>{candleProbeLabel}</span>
                  <span className={`chart-flow-pill tone-${v8ChipTone}`}>{v8Label}</span>
                  <span className={`chart-flow-pill tone-${benchmarkChipTone}`}>{benchmarkLabel}</span>
                  <span className={`chart-flow-pill tone-${v7StatusTone}`}>{v7StatusLabel}</span>
                  <span className={`chart-flow-pill tone-${routeChipTone}`}>ROUTE {preferredRoute ? `${preferredRouteLabel} ${preferredRouteScore.toFixed(2)}` : "NONE"}</span>
                </div>
              ) : (
                <div className="chart-flow-banner" aria-live="polite">
                  <span className={`chart-flow-pill tone-${marketBusHealthTone}`}>BUS {marketBusHealthStatus.toUpperCase()}</span>
                  <span className={`chart-flow-pill tone-${streamStateTone(ohlcvStreamState)}`}>OHLCV {ohlcvStreamState.toUpperCase()}</span>
                  <span className={`chart-flow-pill tone-${localOhlcvSignalTone}`}>LOCAL {localOhlcvAnalysis.signal === "OHLCV_RENDERABLE" ? "RENDERABLE" : localOhlcvAnalysis.signal === "OHLCV_PARTIAL" ? "PARTIAL" : "UNUSABLE"} {localOhlcvAnalysis.renderableRows}/{localOhlcvAnalysis.fetchedRows}</span>
                  <span className={`chart-flow-pill tone-${marketBusOhlcvContiguous ? "good" : "warn"}`}>{marketBusOhlcvContiguous ? "SEQ OK" : "SEQ GAP"} {marketBusOhlcvLatestSeq > 0 ? `#${marketBusOhlcvLatestSeq}` : "#-"}</span>
                  <span className={`chart-flow-pill tone-${streamStateTone(displayDepthStreamState)}`}>DOM {displayDepthStreamState.toUpperCase()}</span>
                  <span className={`chart-flow-pill tone-${classifyFreshnessTone(ohlcvFreshnessState)}`}>BARS {ohlcvFreshnessState.toUpperCase()} {formatFreshness(marketBusOhlcvHealth?.freshness_ms)}</span>
                  <span className={`chart-flow-pill tone-${classifyFreshnessTone(depthFreshnessState)}`}>DEPTH {depthFreshnessState.toUpperCase()} {formatFreshness(marketBusDepthHealth?.freshness_ms)}</span>
                  <span className={`chart-flow-pill tone-${classifyFreshnessTone(tradesFreshnessState)}`}>TRADES {tradesFreshnessState.toUpperCase()} {formatFreshness(marketBusTradesHealth?.freshness_ms)}</span>
                  <span className="chart-flow-pill tone-neutral">SYNC {marketBusSyncLabel}</span>
                  <span className="chart-flow-pill tone-neutral">BOOK {marketBusDepthUpdateId > 0 ? marketBusDepthUpdateId : "-"}</span>
                  <span className="chart-flow-pill tone-neutral" title={localTerminalCapturePersistenceStatus.clientId || "no-client-id"}>CLIENT {localTerminalCapturePersistenceStatus.clientId || "pending"}</span>
                  <span className={`chart-flow-pill tone-${fusionChipTone}`}>FUSION {fusionPrice > 0 ? `${fusionPrice.toFixed(2)} · dev ${fusionDeviationBps.toFixed(1)}bps · ${fusionVenueCount} venues` : "OFF"}</span>
                  <span className={`chart-flow-pill tone-${predictedChipTone}`}>PRED {predictedPrice > 0 ? `${predictedPrice.toFixed(2)} (${predictedDeltaBps >= 0 ? "+" : ""}${predictedDeltaBps.toFixed(1)}bps)` : "IDLE"}</span>
                  <span className={`chart-flow-pill tone-${arbChipTone}`}>ARB {arbOpportunity ? `${arbBuyVenue || "?"}→${arbSellVenue || "?"} net ${arbNetSpread.toFixed(2)}` : "NONE"}</span>
                  <span className={`chart-flow-pill tone-${kernelChipTone}`}>{kernelTelemetryLabel}</span>
                  <span className={`chart-flow-pill tone-${schedulerChipTone}`}>{schedulerLabel}</span>
                  <span className={`chart-flow-pill tone-${candleProbeTone}`}>{candleProbeLabel}</span>
                  <span className={`chart-flow-pill tone-${v8ChipTone}`}>{v8Label}</span>
                  <span className={`chart-flow-pill tone-${benchmarkChipTone}`}>{benchmarkLabel}</span>
                  <span className={`chart-flow-pill tone-${v7StatusTone}`}>{v7StatusLabel}{v7ExecutionDecision.renderThrottleActive ? " THROTTLED" : ""}</span>
                  <span className={`chart-flow-pill tone-${routeChipTone}`}>BEST {preferredRoute ? `${preferredRouteLabel} score ${preferredRouteScore.toFixed(2)}` : "NONE"}</span>
                </div>
              )}
              <ChartPerceptualDebugPanel
                open={chartPerceptualDebugOpen}
                telemetry={chartPerceptualTelemetry}
                gpuTelemetry={gpuPerceptualTelemetry}
                engineMode={chartEngineMode}
              />
              {marketFlowAlerts.length > 0 && !chartUltraCleanCandles ? (
                <div className={`chart-flow-alert ${chartOverlayCompactMode ? "chart-flow-alert-compact" : ""}`} aria-live="assertive">
                  <strong>{chartOverlayCompactMode ? "Data" : "Market data alert"}</strong>
                  <span>{chartFlowAlertText}</span>
                </div>
              ) : null}
              {localOhlcvAnalysis.signal !== "OHLCV_RENDERABLE" && !chartUltraCleanCandles && !chartAuthBlocked ? (
                <div className={`chart-flow-alert ${chartOverlayCompactMode ? "chart-flow-alert-compact" : ""}`} aria-live="assertive">
                  <strong>Local OHLCV</strong>
                  <span>{localOhlcvAlertText} Reasons: {localOhlcvReasonsLabel}. Feed: {localOhlcvFeedLabel}.</span>
                </div>
              ) : null}
              {chartPreviewModeActive ? (
                <div className={`chart-flow-alert ${chartOverlayCompactMode ? "chart-flow-alert-compact" : ""}`} aria-live="polite">
                  <strong>Preview candles</strong>
                  <span>{chartAuthBlocked ? "Session non authentifiee: affichage de bougies de previsualisation." : `Feed indisponible (${localOhlcvFeedLabel}): affichage de bougies de previsualisation.`}</span>
                </div>
              ) : null}
              {chartLoading ? <div className="chart-loader">Switching symbol…</div> : null}
              {chartEngineMode === "v4" ? (
                <GpuChartV4Surface
                  key={`${selectedChartInstrument}|${selectedChartVenue}|${chartTimeframe}|v4|${chartMode}`}
                  className={`chart-stage-premium ${chartActiveSnapLine ? "execution-focus" : ""} ${marketSignalV1.focusMode ? "signal-focus" : ""}`}
                  symbol={selectedChartSymbol}
                  timeframe={chartTimeframe}
                  liveFeedKey={`${selectedChartInstrument}|${selectedChartVenue}|${chartTimeframe}`}
                  mode={chartMode}
                  chartMotionPreset={chartMotionPreset}
                  visualMode={chartVisualMode}
                  candles={chartDisplayCandles}
                  overlayZones={activeOverlayZones}
                  liquidityZones={activeLiquidityZones}
                  domLevels={chartMode === "candles" ? activeDomLevels : undefined}
                  heatmapLevels={chartMode === "candles" ? activeHeatmapLevels : undefined}
                  dayVwap={showVwap ? dayVwap : 0}
                  weekVwap={showVwap ? weekVwap : 0}
                  monthVwap={showVwap ? monthVwap : 0}
                  showSessions={showSessions}
                  indicatorSeries={indicatorSeriesForChart}
                  footprintRows={chartMode === "footprint" ? activeFootprintRows : undefined}
                  candleTransform="none"
                  onCrosshairMove={(payload) => setCrosshair(payload)}
                  engineMode="v4"
                  viewportGrid={gpuViewportGrid}
                  smoothingMs={chartSmoothingMs}
                  multiSymbolFeeds={activeGpuMultiSymbolFeeds}
                  onPerceptualTelemetry={setGpuPerceptualTelemetry}
                />
              ) : (
                <InstitutionalChart
                  key={`${selectedChartInstrument}|${selectedChartVenue}|${chartTimeframe}|v3|${chartMode}`}
                  className={`chart-stage-premium ${chartActiveSnapLine ? "execution-focus" : ""} ${marketSignalV1.focusMode ? "signal-focus" : ""}`}
                  symbol={selectedChartSymbol}
                  timeframe={chartTimeframe}
                  liveFeedKey={`${selectedChartInstrument}|${selectedChartVenue}|${chartTimeframe}`}
                  mode={chartMode}
                  chartMotionPreset={chartMotionPreset}
                  visualMode={chartVisualMode}
                  candles={chartDisplayCandles}
                  overlayZones={activeOverlayZones}
                  liquidityZones={activeLiquidityZones}
                  domLevels={chartMode === "candles" ? activeDomLevels : undefined}
                  heatmapLevels={chartMode === "candles" ? activeHeatmapLevels : undefined}
                  dayVwap={showVwap ? dayVwap : 0}
                  weekVwap={showVwap ? weekVwap : 0}
                  monthVwap={showVwap ? monthVwap : 0}
                  showSessions={showSessions}
                  indicatorSeries={indicatorSeriesForChart}
                  footprintRows={chartMode === "footprint" ? activeFootprintRows : undefined}
                  candleTransform="none"
                  onCrosshairMove={(payload) => setCrosshair(payload)}
                  onPerformanceTelemetry={(payload) => {
                    setChartKernelPerf({
                      fps: payload.fps,
                      frameTimeMs: payload.frameTimeMs,
                      cpuLoad: payload.cpuLoad,
                      workerLatencyMs: payload.workerLatencyMs || 0,
                    });
                  }}
                  onPerceptualTelemetry={setChartPerceptualTelemetry}
                />
              )}
              {chartMaskActive ? (
                <div className="chart-render-blocked-state" data-render-blocked="true" role="status" aria-live="polite">
                  <span className="chart-render-blocked-kicker">{chartAuthBlocked ? "Authentication required" : "Render blocked"}</span>
                  <strong>{chartAuthBlocked ? "Session required" : "No renderable candles"}</strong>
                  <span className="chart-render-blocked-summary">{chartAuthBlocked ? "Connectez-vous pour charger les flux marche et rendre les bougies du terminal." : (localOhlcvAlertText || `No renderable candles for ${localOhlcvFeedLabel}.`)}</span>
                  <div className="chart-render-blocked-meta">
                    {chartAuthBlocked ? (
                      <>
                        <span className="chart-flow-pill tone-warn">AUTH {authStatus === "unknown" ? "CHECK" : "SESSION"}</span>
                        <span className="chart-flow-pill tone-neutral">LOGIN REQUIRED</span>
                      </>
                    ) : (
                      <>
                        <span className={`chart-flow-pill tone-${marketBusHealthTone}`}>BUS {marketBusHealthStatus.toUpperCase()}</span>
                        <span className={`chart-flow-pill tone-${streamStateTone(ohlcvStreamState)}`}>OHLCV {ohlcvStreamState.toUpperCase()}</span>
                        <span className={`chart-flow-pill tone-${localOhlcvSignalTone}`}>LOCAL UNUSABLE {localOhlcvAnalysis.renderableRows}/{localOhlcvAnalysis.fetchedRows}</span>
                      </>
                    )}
                  </div>
                  <span className="chart-render-blocked-reasons">{chartAuthBlocked ? "La session terminal n'est pas authentifiee. Le chart ne charge pas les endpoints marche tant que l'authentification n'est pas etablie." : `Reasons: ${localOhlcvReasonsLabel}. Feed: ${localOhlcvFeedLabel}.`}</span>
                </div>
              ) : null}
              {signalActionToast && (signalDisplayMode !== "classic" || signalActionToast.critical) ? (
                <div className={`chart-signal-toast chart-signal-toast-${signalActionToast.direction}`} key={signalActionToast.key}>
                  <div className="chart-signal-toast-head">
                    <strong>{signalActionToast.title}</strong>
                    <button type="button" className="chart-signal-toast-close" onClick={() => setSignalActionToast(null)}>×</button>
                  </div>
                  <div className="chart-signal-toast-detail">{signalActionToast.detail}</div>
                  <div className="chart-signal-toast-zone">{signalActionToast.zoneLabel}</div>
                </div>
              ) : null}
              {!replayState.enabled && chartOrderTicket.active && (
                <>
                  <div className="chart-trading-overlay" aria-hidden="true">
                    {(["entry", "sl", "tp"] as const).map((lineKey) => {
                      const value = chartOrderTicket[lineKey];
                      const stageHeight = chartStageRef.current?.clientHeight || 500;
                      const stageWidth = chartStageRef.current?.clientWidth || 0;
                      const y = chartPriceToY(value, stageHeight);
                      const lineLabel = lineKey === "entry" ? "ENTRY" : lineKey === "sl" ? "SL" : "TP";
                      const activeSnapFamily = chartActiveSnapLine === lineKey ? chartSnapState?.family || null : null;
                      const delta = lineKey === "entry"
                        ? value - chartAnchorPrice
                        : value - chartOrderTicket.entry;
                      const pct = (lineKey === "entry" ? chartAnchorPrice : chartOrderTicket.entry) > 0
                        ? (delta / Math.max(0.0000001, lineKey === "entry" ? chartAnchorPrice : chartOrderTicket.entry)) * 100
                        : 0;
                      const hudMaskPad = 10;
                      const overlapsHud = Boolean(
                        chartHudBounds
                        && y >= chartHudBounds.top - 12
                        && y <= chartHudBounds.top + chartHudBounds.height + 12,
                      );
                      const leftSegmentWidth = overlapsHud && chartHudBounds
                        ? Math.max(0, chartHudBounds.left - hudMaskPad)
                        : stageWidth;
                      const rightSegmentLeft = overlapsHud && chartHudBounds
                        ? Math.min(stageWidth, chartHudBounds.left + chartHudBounds.width + hudMaskPad)
                        : stageWidth;
                      const rightSegmentWidth = overlapsHud && chartHudBounds
                        ? Math.max(0, stageWidth - rightSegmentLeft)
                        : 0;
                      return (
                        <div
                          key={`chart-line-${lineKey}`}
                          className={[
                            `chart-order-line chart-order-line-${lineKey}`,
                            chartActiveSnapLine === lineKey ? "is-active" : "",
                            chartSnapPulseLine === lineKey ? "is-snap-pulse" : "",
                            activeSnapFamily && activeSnapFamily !== "manual" ? `snap-family-${activeSnapFamily}` : "",
                          ].filter(Boolean).join(" ")}
                          style={{ top: `${y}px` }}
                          onPointerDown={(event) => beginChartOrderDrag(event, lineKey)}
                        >
                          <span className="chart-order-line-segment chart-order-line-segment-left" style={{ width: `${leftSegmentWidth}px` }} />
                          {rightSegmentWidth > 0 ? (
                            <span
                              className="chart-order-line-segment chart-order-line-segment-right"
                              style={{ left: `${rightSegmentLeft}px`, width: `${rightSegmentWidth}px` }}
                            />
                          ) : null}
                          <span className={`chart-order-line-label ${chartOverlayCompactMode ? "is-compact-label" : ""}`}>
                            <strong>
                              {chartOverlayCompactMode
                                ? `${lineKey === "entry" ? "E" : lineKey.toUpperCase()} ${value.toFixed(chartPriceDigits)}`
                                : `${lineLabel} ${value.toFixed(2)}`}
                            </strong>
                            {!chartOverlayCompactMode ? <em>{delta >= 0 ? "+" : ""}{delta.toFixed(2)} · {pct >= 0 ? "+" : ""}{pct.toFixed(2)}%</em> : null}
                            {!chartOverlayCompactMode && activeSnapFamily && activeSnapFamily !== "manual" ? <span className={`chart-order-line-snap-badge ${activeSnapFamily}`}>{activeSnapFamily}</span> : null}
                            {!chartOverlayCompactMode ? (
                              <button
                                type="button"
                                className="chart-order-line-handle"
                                aria-label={`Fine drag ${lineLabel}`}
                                onPointerDown={(event) => beginChartOrderDrag(event, lineKey, true)}
                              >
                                Fine
                              </button>
                            ) : null}
                          </span>
                        </div>
                      );
                    })}

                    {chartReleaseTicket && (
                      <div className={`chart-order-release-ticket${chartReleaseTicket.armed ? " is-armed" : ""}${chartReleaseValidationPulse ? " release-validate-pulse" : ""}`} style={{ top: `${chartReleaseTicket.top}px` }}>
                        <div className="chart-order-release-title">{chartReleaseTicket.line.toUpperCase()} adjusted</div>
                        <div className="chart-order-release-meta">
                          <span>{chartReleaseTicket.price.toFixed(chartPriceDigits)}</span>
                          <span>{chartReleaseTicket.snapLabel}</span>
                          <span>{chartReleaseTicket.fineMode ? "Fine" : "Fast"}</span>
                        </div>
                        <div className="chart-order-release-actions chart-order-release-mode-row">
                          <button type="button" className={`chart-chip ${chartReleaseSendMode === "one-click" ? "active" : ""}`} onClick={() => setChartReleaseSendMode("one-click")}>One-click</button>
                          <button type="button" className={`chart-chip ${chartReleaseSendMode === "confirm-required" ? "active" : ""}`} onClick={() => setChartReleaseSendMode("confirm-required")}>Confirm-required</button>
                        </div>
                        <div className="chart-order-release-note">
                          {chartEffectiveSendMode === "one-click"
                            ? "Send lance l’ordre immédiatement depuis ce ticket."
                            : chartReleaseTicket.armed
                              ? "Deuxieme action activee: Send va confirmer l’ordre."
                              : "Armez d’abord l’envoi avant confirmation finale."}
                        </div>
                        {chartRiskTargetMiss && (
                          <div className="chart-order-release-note chart-order-release-note-warn">Auto confirm-required force tant que le gain cible n’est pas atteint.</div>
                        )}
                        <div className="chart-order-release-actions">
                          {chartEffectiveSendMode === "confirm-required" ? (
                            <button
                              type="button"
                              className={`chart-chip ${chartReleaseTicket.armed ? "active" : ""}`}
                              onClick={() => setChartReleaseTicket((current) => current ? { ...current, armed: !current.armed } : current)}
                            >
                              {chartReleaseTicket.armed ? "Armed" : "Arm Send"}
                            </button>
                          ) : (
                            <button type="button" className="chart-chip" onClick={() => setChartReleaseTicket(null)}>Close</button>
                          )}
                          <button
                            type="button"
                            className="chart-chip chart-buy-btn"
                            disabled={chartEffectiveSendMode === "confirm-required" && !chartReleaseTicket.armed}
                            onClick={() => {
                              setChartReleaseValidationPulse(true);
                              setChartReleaseTicket(null);
                              setChartHudConfirmArmed(false);
                              const ack = chartEffectiveSendMode !== "confirm-required" || chartReleaseTicket.armed;
                              void submitChartOrder(ack);
                            }}
                          >
                            {chartEffectiveSendMode === "one-click" ? "Send Now" : "Confirm Send"}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                  {!chartOverlayCompactMode ? chartExecutionHudPanel : null}
                </>
              )}
            </div>
            {chartOverlayCompactMode ? chartExecutionHudPanel : null}
            {chartSidecarVisible ? (
              <aside className="chart-sidecar-stack" aria-label="Market structure sidecars">
                {dockedChartSidecarIds.map((id) => (
                  <div key={`chart-sidecar-${id}`}>{renderChartSidecarCard(id)}</div>
                ))}
              </aside>
            ) : null}
            {showDecisionOverlay && (
              <aside className="decision-overlay-panel" role="complementary" aria-label="AI Decision Analysis">
                <div className="dov-header">
                  <span className="dov-title">AI Decision</span>
                  <span className="dov-ts">{overlayDecisionTs ? overlayDecisionTs.replace("T", " ").slice(0, 19).slice(-8) : "–"}</span>
                </div>
                {overlayDecisionRegime !== "–" && (
                  <span className={`dov-regime-badge${overlayDecisionRegime === "high" ? " high" : overlayDecisionRegime === "medium" ? " medium" : " low"}`}>{overlayDecisionRegime}</span>
                )}
                  {overlayDecisionConsensus > 0 && (
                  <div className="dov-row">
                    <span className="dov-label">Consensus</span>
                    <div className="dov-bar-wrap"><div className="dov-bar dov-bar-consensus" style={{ width: `${Math.min(100, overlayDecisionConsensus).toFixed(0)}%` }} /></div>
                    <span className="dov-val">{overlayDecisionConsensus.toFixed(0)}%</span>
                  </div>
                )}
                {(overlayDecisionMemorySim > 0 || overlayDecisionMemoryCases > 0) && (
                  <div className="dov-row">
                    <span className="dov-label">Memory</span>
                    <span className="dov-val">
                      {overlayDecisionMemorySim > 0 ? `sim ${overlayDecisionMemorySim.toFixed(2)}` : ""}
                      {overlayDecisionMemoryCases > 0 ? ` ${overlayDecisionMemoryCases}c` : ""}
                    </span>
                  </div>
                )}
                {agentWeightedVotes.length > 0 && (
                  <>
                    <div className="dov-agents">
                      {agentWeightedVotes.map((wv, i) => {
                        const dir = String(wv.vote.direction || wv.vote.vote || "").toLowerCase();
                        const isSuppressed = wv.accuracyPct < 45;
                        return (
                          <span
                            key={`av-${i}`}
                            className={`dov-agent-vote${dir.includes("buy") ? " buy" : dir.includes("sell") ? " sell" : ""}${isSuppressed ? " suppressed" : ""}`}
                            title={`accuracy ${wv.accuracyPct.toFixed(0)}%`}
                          >
                            {String(wv.vote.agent || wv.vote.name || `A${i + 1}`).slice(0, 5)}{" "}
                            {String(wv.vote.direction || wv.vote.vote || "–").slice(0, 4)}
                            {!isSuppressed && <span className="adv-weight">{(wv.weight * 100).toFixed(0)}</span>}
                            {isSuppressed && <span className="adv-suppressed">↓</span>}
                          </span>
                        );
                      })}
                    </div>
                    {weightedConsensus !== null && (
                      <div className="dov-row">
                        <span className="dov-label">W.Cons</span>
                        <div className="dov-bar-wrap">
                          <div className="dov-bar dov-bar-consensus" style={{ width: `${Math.min(100, weightedConsensus).toFixed(0)}%` }} />
                        </div>
                        <span className={`dov-val${weightedConsensus < 40 ? " warn" : ""}`}>{weightedConsensus.toFixed(0)}%</span>
                      </div>
                    )}
                    {consensusPenaltyActive && (
                      <div className="consensus-penalty-flag">⚠ Low consensus — signal unreliable</div>
                    )}
                  </>
                )}
                {/* ── CALIBRATION LAYER ── */}
                {calibMismatch && calibMismatchLabel && (
                  <div className={`dov-mismatch${calibBlame === "bad_decision" ? " decision" : ""}`}>
                    <span className="dov-mismatch-icon">⚠</span>
                    <span>MISMATCH</span>
                    <span className="dov-mismatch-detail">{calibMismatchLabel}</span>
                  </div>
                )}
                {isHighRisk && (
                  <span className="high-risk-badge">⚠ HIGH RISK</span>
                )}
                {requiresHumanApproval && (
                  <div className="human-approval-gate">
                    🔒 APPROBATION REQUISE
                    <span className="hag-reason">
                      {extendedBlame === "latency_spike"
                        ? "latency spike"
                        : isHighRisk
                        ? "non cartographié"
                        : "consensus faible"}
                    </span>
                  </div>
                )}
                {overlayDecisionScore > 0 && (
                  <>
                    <div className="dov-row">
                      <span className="dov-label">Score</span>
                      <div className="dov-bar-wrap">
                        <div className="dov-bar" style={{ width: `${Math.min(100, effectiveScoreFull * 100).toFixed(0)}%`, background: effectiveScoreFull >= 0.7 ? "#6ee7a7" : effectiveScoreFull >= 0.5 ? "#ffd166" : "#ff7d7d" }} />
                      </div>
                      <span className="dov-val">
                        {effectiveScoreFull.toFixed(2)}
                        {scoreWasAdjusted && <span className="dov-adjust-tag">adj</span>}
                      </span>
                    </div>
                    {calibWinrateCI && calibCurrentBucket && (
                      <div className="calib-ci">
                        WR {((calibCurrentBucket.wins / calibCurrentBucket.total) * 100).toFixed(0)}%
                        {" "}±{((calibWinrateCI.high - calibWinrateCI.low) * 50).toFixed(0)}pts
                        <span className="calib-ci-sub">
                          90% CI ({(calibWinrateCI.low * 100).toFixed(0)}–{(calibWinrateCI.high * 100).toFixed(0)}%)
                        </span>
                      </div>
                    )}
                    {scoreWasAdjusted && (
                      <div className="dov-row">
                        <span className="dov-label">Raw</span>
                        <span className="dov-val">{overlayDecisionScore.toFixed(2)}</span>
                        <span className="dov-val" style={{ color: "rgba(225,233,244,0.35)" }}>×{calibFactorBayes.toFixed(2)} Bayes</span>
                      </div>
                    )}
                    {(confidenceDecay > 0 || microDecay > 0) && (
                      <div className="decay-note">
                        ↓{decayHighLatency ? " lat" : ""}{decayHighVolatility ? " vol" : ""}{decayWideSpread ? " spread" : ""}{decayExtremeImbalance ? " imb" : ""} −{((confidenceDecay + microDecay) * 100).toFixed(0)}pts
                      </div>
                    )}
                  </>
                )}
                {calibAgentAccuracy.length > 0 && (
                  <div style={{ borderTop: "1px solid rgba(120,147,188,0.1)", paddingTop: 5, marginTop: 2 }}>
                    <div className="dov-label" style={{ marginBottom: 3 }}>Agent accuracy</div>
                    {calibAgentAccuracy.map((agent) => (
                      <div key={agent.name} className="dov-row" style={{ gap: 4 }}>
                        <span className="dov-label" style={{ width: 44 }}>{agent.name}</span>
                        <div className="dov-bar-wrap"><div className="dov-bar" style={{ width: `${agent.accuracy.toFixed(0)}%`, background: agent.accuracy >= 60 ? "#6ee7a7" : agent.accuracy >= 45 ? "#ffd166" : "#ff7d7d" }} /></div>
                        <span className="dov-val">{agent.accuracy.toFixed(0)}%</span>
                      </div>
                    ))}
                  </div>
                )}
                {calibBuckets.length > 0 && (
                  <div style={{ borderTop: "1px solid rgba(120,147,188,0.1)", paddingTop: 5, marginTop: 2 }}>
                    <div className="dov-label" style={{ marginBottom: 3 }}>Score calibration</div>
                    {calibBuckets.map((b) => (
                      <div key={b.label} className="dov-row" style={{ gap: 4 }}>
                        <span className="dov-label" style={{ width: 32 }}>{b.label}</span>
                        <div className="dov-bar-wrap"><div className="dov-bar" style={{ width: `${((b.wins / b.total) * 100).toFixed(0)}%`, background: (b.wins / b.total) >= 0.55 ? "#6ee7a7" : "#ffd166" }} /></div>
                        <span className="dov-val">{((b.wins / b.total) * 100).toFixed(0)}%/{b.total}</span>
                      </div>
                    ))}
                  </div>
                )}
                {strategyPerformance.length > 0 && (
                  <div style={{ borderTop: "1px solid rgba(120,147,188,0.1)", paddingTop: 5, marginTop: 2 }}>
                    <div className="dov-label" style={{ marginBottom: 3 }}>Strategy survival</div>
                    <div className="strategy-survival-table">
                      {strategyPerformance.map((s) => (
                        <div key={s.id} className={`ssrow ssrow-${s.status}`}>
                          <span className="ssr-id">{s.id.slice(0, 12)}</span>
                          <span className="ssr-wr">{s.winrate.toFixed(0)}%</span>
                          <span className="ssr-pnl">{s.avgPnl >= 0 ? "+" : ""}{s.avgPnl.toFixed(0)}$</span>
                          <span className="ssr-status">
                            {s.status}
                            {s.cooldownRemaining > 0 && (
                              <span className={`hysteresis-badge${s.status === "reduce" ? " reduced" : ""}`} style={{ marginLeft: 4 }}>
                                🔒 {s.cooldownRemaining}h
                              </span>
                            )}
                          </span>
                        </div>
                      ))}
                    </div>
                    {(strategyDemoteCount > 0 || strategyReduceCount > 0) && (
                      <div className="dov-row" style={{ marginTop: 3 }}>
                        {strategyDemoteCount > 0 && <span className="dov-val warn">{strategyDemoteCount} demote</span>}
                        {strategyReduceCount > 0 && <span className="dov-val" style={{ color: "#ffd166" }}>{strategyReduceCount} reduce</span>}
                      </div>
                    )}
                  </div>
                )}
                {overlayDecisionRationale && (
                  <div className="dov-rationale" title={overlayDecisionRationale}>{overlayDecisionRationale.slice(0, 110)}</div>
                )}
              </aside>
            )}
          </div>
          )}

          {!terminalV2Enabled ? <div className="overlay-legend-compact">
            <span className="olc">Route {preferredRoute ? String(preferredRoute.venue || "–") : "–"}</span>
            <span className="olc">DOM {displayDepthStreamState}</span>
            <span className={`olc ${toNumber(marketMicro?.depth_imbalance, 0) >= 0 ? "olc-green" : "olc-red"}`}>Imb {toNumber(marketMicro?.depth_imbalance, 0).toFixed(3)}</span>
            <span className="olc">Tape {activeTape.length}</span>
            {uiMode === "expert" ? <span className="olc" style={{ marginLeft: "auto" }}>Bid {toNumber(orderbook?.bid, 0).toFixed(2)} / Ask {toNumber(orderbook?.ask, 0).toFixed(2)}</span> : null}
            <button type="button" className="chart-chip chart-buy-btn" onClick={() => applyChartOrderPreset(chartOrderTicket.preset === "custom" ? "scalp" : chartOrderTicket.preset, "buy")} disabled={replayState.enabled}>▲ Buy</button>
            <button type="button" className="chart-chip chart-sell-btn" onClick={() => applyChartOrderPreset(chartOrderTicket.preset === "custom" ? "scalp" : chartOrderTicket.preset, "sell")} disabled={replayState.enabled}>▼ Sell</button>
          </div> : null}
        </PanelShell>
          </Panel>
          <PanelResizeHandle
          className="term-core-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize execution lane"
          title="Drag to resize. Double click to reset."
          onDoubleClick={() => {
            if (termCoreGroupRef.current) {
              const left = uiMode === "novice" ? 72 : 78;
              setLayoutCoreSplit(left);
              termCoreGroupRef.current.setLayout([left, 100 - left]);
            }
          }}
        >
          <span className="term-core-resize-grip" aria-hidden="true" />
          </PanelResizeHandle>
          <Panel defaultSize={Math.max(15, 100 - layoutCoreSplit)} minSize={20} className="txt-split-panel txt-split-panel-right">

        {/* ── EXECUTION LANE ── */}
        <PanelShell className="panel term-exec-panel gtix-panel-resizable-y">
          <div className="exec-lane-header"><span className="eyebrow">Execution Lane</span><span className={`status-chip ${avgLatency > 200 ? "alert-chip" : ""}`}>live {avgLatency.toFixed(0)} ms</span><HelpHint text="Route préférée, surveillance slippage/latence, replay et ticket d'ordre gouverné." examples={["Route préférée = venue avec le plus petit spread.", "Replay = dernier fill series avec timeline et histogramme slippage."]} /></div>
          {showExecOverlay && (
            <div className="exec-overlay-strip">
              <div className="eov-block">
                <span className="eov-label">Route</span>
                <span className="eov-value">{replayRoute}</span>
                {overlayRouteAlt !== "–" && <span className="eov-alt">alt: {overlayRouteAlt}</span>}
              </div>
              <div className="eov-block">
                <span className="eov-label">Slip exp.</span>
                <span className="eov-value">{overlaySlippageExpected > 0 ? `${overlaySlippageExpected.toFixed(1)}bps` : "–"}</span>
              </div>
              <div className="eov-block">
                <span className="eov-label">Slip réel</span>
                <span className={`eov-value ${replaySlippage > 15 ? "warn" : "good"}`}>{replaySlippage.toFixed(1)}bps</span>
              </div>
              <div className="eov-block">
                <span className="eov-label">Δslip</span>
                <span className={`eov-value ${overlaySlippageDelta > 5 ? "warn" : overlaySlippageDelta < 0 ? "good" : ""}`}>{overlaySlippageDelta >= 0 ? "+" : ""}{overlaySlippageDelta.toFixed(1)}bps</span>
              </div>
              {overlayLatDecision > 0 && (
                <div className="eov-block">
                  <span className="eov-label">Lat dec.</span>
                  <span className="eov-value">{overlayLatDecision.toFixed(0)}ms</span>
                </div>
              )}
              {overlayLatRouting > 0 && (
                <div className="eov-block">
                  <span className="eov-label">Lat rout.</span>
                  <span className="eov-value">{overlayLatRouting.toFixed(0)}ms</span>
                </div>
              )}
              <div className="eov-block">
                <span className="eov-label">e2e</span>
                <span className={`eov-value ${replayLatency > 200 ? "warn" : "good"}`}>{replayLatency.toFixed(0)}ms</span>
              </div>
              <div className="eov-block">
                <span className="eov-label">Net</span>
                <span className={`eov-value ${replayNetworkState === "healthy" ? "good" : "warn"}`}>{formatControlPlaneStateLabel(replayNetworkState)}</span>
              </div>
              <div className="eov-block">
                <span className="eov-label">Retry</span>
                <span className={`eov-value ${replayRetryCount > 0 || replayDegradedFlag ? "warn" : "good"}`}>{replayRetryCount} · {compactControlPlaneFailureLabel(replayFailureClassification)}</span>
              </div>
              {execQualityScore !== null && (
                <div className="eov-block">
                  <span className="eov-label">Reliability</span>
                  <span className={`eov-value exec-qual-${execQualityLabel}`}>
                    {execQualityLabel} {(execQualityScore * 100).toFixed(0)}%
                  </span>
                </div>
              )}
              <span className="eov-fills">{replayFills.length} fills</span>
            </div>
          )}
          <div className="exec-route-block">
            <div className="exec-route-label">Route préférée</div>
            <div className="exec-route-value">{preferredRoute ? String(preferredRoute.venue || "–") : "–"}</div>
            <div className="subtle mini">spread {preferredSpread.toFixed(4)}</div>
            <div className="subtle mini">reason {routingReasonLabel}</div>
            <div className="subtle mini">
              stability {preferredRouteStability > 0 ? `${preferredRouteState} ${(preferredRouteStability * 100).toFixed(0)}%` : preferredRouteState}
            </div>
            <div className="subtle mini">
              infra {routingNetworkRegime} {(routingInfraHealth * 100).toFixed(0)}%
            </div>
            <div className="subtle mini">
              Backup: {backupRoute ? `${String(backupRoute.venue || "–")} · score ${backupScore.toFixed(1)} · ${backupRouteStability > 0 ? `${backupRouteState} ${(backupRouteStability * 100).toFixed(0)}%` : backupRouteState}` : "n/a"}
            </div>
          </div>
          <div className="exec-route-block" style={{ gap: 6 }}>
            <div className="chart-stat-label" style={{ marginBottom: 2 }}>Candidats V6</div>
            <div style={{ display: "grid", gridTemplateColumns: "1.2fr 0.7fr 0.9fr 0.9fr 0.8fr 0.8fr", gap: 6, fontSize: 10, opacity: 0.7 }}>
              <span>Venue</span>
              <span>Score</span>
              <span>Stable</span>
              <span>Depth</span>
              <span>Fresh</span>
              <span>Fill</span>
            </div>
            {executionRouteCandidates.map((candidate, index) => {
              const score = toNumber(candidate.score, 0);
              const depthUsd = toNumber(candidate.available_depth_usd, 0);
              const freshnessMs = toNumber(candidate.freshness_ms, 0);
              const fillProbability = toNumber(candidate.fill_probability, 0);
              const stabilityScore = toNumber(candidate.stability_score, 0);
              const stabilityState = String(candidate.stability_state || (stabilityScore > 0 ? "watch" : "n/a"));
              const isBest = index === 0 && routingCandidatesV6.length > 0;
              const venueLabel = String(candidate.venue || "–").replace("-public", "").replace("paper-", "");
              const stabilityColor = stabilityState === "stable"
                ? "#cfe9b9"
                : stabilityState === "watch"
                  ? "#f2cb88"
                  : stabilityState === "avoid"
                    ? "#f0a0a0"
                    : undefined;
              return (
                <div
                  key={`exec-route-candidate-${venueLabel}-${index}`}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1.2fr 0.7fr 0.9fr 0.9fr 0.8fr 0.8fr",
                    gap: 6,
                    fontSize: 11,
                    padding: "6px 0",
                    borderTop: index === 0 ? "1px solid rgba(255,255,255,0.08)" : "1px solid rgba(255,255,255,0.05)",
                    color: isBest ? "#f4f1d0" : undefined,
                  }}
                >
                  <span>{isBest ? `${venueLabel} *` : venueLabel}</span>
                  <strong>{score.toFixed(2)}</strong>
                  <span style={{ color: stabilityColor }}>{stabilityScore > 0 ? `${(stabilityScore * 100).toFixed(0)}%` : stabilityState}</span>
                  <span>{depthUsd > 0 ? `$${(depthUsd / 1000).toFixed(1)}k` : "n/a"}</span>
                  <span>{freshnessMs > 0 ? formatFreshness(freshnessMs) : "n/a"}</span>
                  <span>{fillProbability > 0 ? `${(fillProbability * 100).toFixed(0)}%` : "n/a"}</span>
                </div>
              );
            })}
          </div>
          <div className="exec-route-block" style={{ gap: 6 }}>
            <div className="chart-stat-label" style={{ marginBottom: 2 }}>Predictor V8</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, fontSize: 11 }}>
              <div>
                <div className="subtle mini">Hold probability</div>
                <strong style={{ color: effectiveV8ShouldExecute ? "#d7f7cf" : "#f1d498" }}>
                  {(effectiveV8Probability * 100).toFixed(1)}%
                </strong>
              </div>
              <div>
                <div className="subtle mini">Confidence</div>
                <strong>{v8Prediction.confidence.toUpperCase()}</strong>
              </div>
              <div>
                <div className="subtle mini">Threshold / horizon</div>
                <span>{(v8Prediction.threshold * 100).toFixed(0)}% / {backendP20 > 0 ? "20|50|100" : `${v8Prediction.horizonMs}ms`}</span>
              </div>
              <div>
                <div className="subtle mini">Training</div>
                <span>{v8TrainingStats.trainedSamples} local · {toNumber(backendPredictorStats?.samples, 0)} backend</span>
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, fontSize: 10 }}>
              <span>P20 {backendP20 > 0 ? `${(backendP20 * 100).toFixed(0)}%` : "n/a"}</span>
              <span>P50 {backendP50 > 0 ? `${(backendP50 * 100).toFixed(0)}%` : "n/a"}</span>
              <span>P100 {backendP100 > 0 ? `${(backendP100 * 100).toFixed(0)}%` : "n/a"}</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, fontSize: 10 }}>
              <span style={{ color: backendBrainShouldExecute ? "#cfe9b9" : "#efc28f" }}>BRAIN {backendBrainAction}</span>
              <span>{backendBrainRegime !== "N/A" ? backendBrainRegime : "REGIME n/a"}</span>
              <span>{(backendBrainConfidence * 100).toFixed(0)}% conf · {(backendBrainConsensus * 100).toFixed(0)}% vote</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, fontSize: 10 }}>
              <span style={{ color: backendEdgeNetBps >= 0 ? "#cfe9b9" : "#efc28f" }}>EDGE NET {backendEdgeNetBps >= 0 ? "+" : ""}{backendEdgeNetBps.toFixed(2)}bps</span>
              <span style={{ color: "#efc28f" }}>LAT COST -{backendLatencyCostBps.toFixed(2)}bps</span>
              <span style={{ color: backendFinalEdgeBps >= 0 ? "#cfe9b9" : "#efc28f" }}>FINAL EDGE {backendFinalEdgeBps >= 0 ? "+" : ""}{backendFinalEdgeBps.toFixed(2)}bps</span>
            </div>
            <div className="subtle mini" data-testid="terminal-brain-stats">Brain stats: replay {backendBrainReplaySize} · learns {backendBrainLearnSteps} · win {(backendBrainWinRate * 100).toFixed(1)}%</div>
            <div className="subtle mini">Governor {backendBrainGovernorMode}{backendBrainGovernorBlocked ? " · blocked" : backendBrainGovernorSizeMultiplier < 0.999 ? ` · size x${backendBrainGovernorSizeMultiplier.toFixed(2)}` : " · pass"}{backendBrainGovernorFailureSource ? ` · ${backendBrainGovernorFailureSource}` : ""}{backendBrainGovernorCalibrationConfidence > 0 ? ` · c ${(backendBrainGovernorCalibrationConfidence * 100).toFixed(0)}%` : ""}{backendBrainGovernorReasons.length > 0 ? ` · ${backendBrainGovernorReasons.join(",")}` : ""}</div>
            <div className="subtle mini">Meta {backendBrainMetaMode || backendBrainMetaProfileId || "balanced"}{backendBrainMetaProfileId ? ` · ${backendBrainMetaProfileId}` : ""}{backendBrainMetaVenueAction ? ` · venue ${backendBrainMetaVenueAction}` : ""}{backendBrainMetaExecutionDelayMs > 0 ? ` · delay ${backendBrainMetaExecutionDelayMs}ms` : ""}{backendBrainMetaSimulationProfile ? ` · sim ${backendBrainMetaSimulationProfile}` : ""}{backendBrainMetaCloseOnly ? " · close-only" : backendBrainMetaHaltNewExposure ? " · halt-new" : ""}{backendBrainMetaReasons.length > 0 ? ` · ${backendBrainMetaReasons.join(",")}` : ""}</div>
            <div className="subtle mini">Strategy {backendBrainStrategyMode || backendBrainStrategySwitchMode}{backendBrainStrategyRouteModeOverride ? ` · route ${backendBrainStrategyRouteModeOverride}` : ""}{backendBrainStrategyExecutionStyle ? ` · ${backendBrainStrategyExecutionStyle}` : ""}{backendBrainStrategyMaxSpreadMultiplier < 0.999 ? ` · spread x${backendBrainStrategyMaxSpreadMultiplier.toFixed(2)}` : ""}{backendBrainStrategySizeCap < 0.999 ? ` · cap x${backendBrainStrategySizeCap.toFixed(2)}` : ""}{backendBrainStrategyMemoryConfidence > 0 ? ` · mem ${(backendBrainStrategyMemoryConfidence * 100).toFixed(0)}%` : ""}{backendBrainStrategyReasons.length > 0 ? ` · ${backendBrainStrategyReasons.join(",")}` : ""}</div>
            <div className="subtle mini">World {backendBrainWorldFutureRegime || "n/a"}{backendBrainWorldDirectionBias ? ` · ${backendBrainWorldDirectionBias}` : ""}{backendBrainWorldHorizonMs > 0 ? ` · ${backendBrainWorldHorizonMs}ms` : ""}{backendBrainWorldPredictedSlippage > 0 ? ` · slip ${backendBrainWorldPredictedSlippage.toFixed(2)}bps` : ""}{backendBrainWorldPredictedFill > 0 ? ` · fill ${(backendBrainWorldPredictedFill * 100).toFixed(0)}%` : ""}{backendBrainWorldPredictedLatency > 0 ? ` · lat ${backendBrainWorldPredictedLatency.toFixed(0)}ms` : ""}{backendBrainWorldRecommendedDelayMs > 0 ? ` · delay ${backendBrainWorldRecommendedDelayMs}ms` : ""}</div>
            <div className="subtle mini">Shield {backendBrainActionShieldMode}{backendBrainSafeAction ? ` · ${backendBrainSafeAction}` : ""}{backendBrainShieldDelayMs > 0 ? ` · wait ${backendBrainShieldDelayMs}ms` : ""}{backendBrainShieldRisk > 0 ? ` · risk ${(backendBrainShieldRisk * 100).toFixed(0)}%` : ""}{backendBrainShieldReasons.length > 0 ? ` · ${backendBrainShieldReasons.join(",")}` : ""}</div>
            <div style={{ display: "grid", gap: 6 }} data-testid="terminal-brain-calibration">
              <div className="subtle mini">LR calibration: {backendBrainCalibrationHeadline}</div>
              {backendBrainCalibrationRows.map((row) => {
                const sourceColor = row.confidence >= 0.5
                  ? "#cfe9b9"
                  : row.confidence > 0
                    ? "#efc28f"
                    : "#9fb0c3";
                return (
                  <div
                    key={`brain-calibration-${row.source}`}
                    style={{
                      display: "grid",
                      gap: 4,
                      padding: "6px 8px",
                      borderRadius: 8,
                      border: "1px solid rgba(148, 163, 184, 0.18)",
                      background: "rgba(15, 23, 42, 0.26)",
                    }}
                  >
                    <div style={{ display: "grid", gridTemplateColumns: "0.8fr 1.15fr 1.15fr", gap: 6, fontSize: 10 }}>
                      <span style={{ color: sourceColor }}>
                        {formatFailureSourceLabel(row.source).toUpperCase()} {(row.confidence * 100).toFixed(0)}%
                      </span>
                      <span>n {row.sampleCount} · real {row.realCount} · synth {row.syntheticCount}</span>
                      <span>w {row.effectiveSampleWeight.toFixed(2)} · reward {row.averageReward >= 0 ? "+" : ""}{row.averageReward.toFixed(2)}</span>
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                      {row.multiplierRows.map((item) => {
                        const pillTone = item.multiplier >= 1.02
                          ? "good"
                          : item.multiplier <= 0.75
                            ? "warn"
                            : "neutral";
                        return (
                          <span key={`brain-calibration-${row.source}-${item.agent}`} className={`chart-action-pill chart-action-pill-status ${pillTone}`}>
                            {compactReplayAgentLabel(item.agent)} x{item.multiplier.toFixed(2)}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="subtle mini">Persistence: {v8PersistenceLabel} · drift {v8TrainingStats.weightShift.toFixed(3)}</div>
            <div className="subtle mini">Reliability: {effectiveV8DataReliable ? `OK ${dataReliabilitySnapshot.renderableRows}/${dataReliabilitySnapshot.minimumRenderableBars}+` : `SKIP ${backendPredictorReasonsLabel || dataReliabilitySnapshot.reasons.join(" · ") || "gate"}`}</div>
            <div className="subtle mini">Orderflow {backendBrainOrderflowQuality > 0 ? `${(backendBrainOrderflowQuality * 100).toFixed(0)}%` : "n/a"}{backendBrainDisabledAgents.length > 0 ? ` · disabled ${backendBrainDisabledAgents.join(",")}` : ""}</div>
            <div className="subtle mini">Attribution {backendBrainFeatureLeader} {backendBrainFeatureLeaderContribution >= 0 ? "+" : ""}{backendBrainFeatureLeaderContribution.toFixed(2)} · ctx {backendBrainFeatureSession}/{backendBrainFeatureVolatility}/{backendBrainFeatureSpread}</div>
            <div className="subtle mini">Anchors {backendBrainAnchorPrimary} · compression {backendBrainAnchorCompression.toFixed(1)}bps · confluence {(backendBrainAnchorConfluence * 100).toFixed(0)}%</div>
            <div className="subtle mini">Liquidity {backendBrainLiquidityState} · pressure {backendBrainLiquidityPressure >= 0 ? "+" : ""}{backendBrainLiquidityPressure.toFixed(2)} · sweep {(backendBrainSweepRisk * 100).toFixed(0)}% · vacuum {(backendBrainLiquidityVacuum * 100).toFixed(0)}%</div>
            <div className="subtle mini">Latent {backendBrainLatentLabel} · conf {(backendBrainLatentConfidence * 100).toFixed(0)}% · shift {(backendBrainLatentTransition * 100).toFixed(0)}% · factor {backendBrainLatentFactor}</div>
            <div className="subtle mini">Dream {backendBrainDreamSize} synth · ratio {(backendBrainDreamRatio * 100).toFixed(0)}% · weight x{backendBrainDreamWeight.toFixed(2)} · obs {backendBrainLatentObservations}</div>
            <div style={{ display: "grid", gap: 4 }}>
              {v8TopDrivers.map((driver) => (
                <div key={`v8-driver-${driver.label}`} style={{ display: "grid", gridTemplateColumns: "1.2fr 0.8fr", gap: 6, fontSize: 10 }}>
                  <span className="subtle mini">{driver.label}</span>
                  <span style={{ color: driver.value >= 0 ? "#cfe9b9" : "#efc28f" }}>{driver.value >= 0 ? "+" : ""}{driver.value.toFixed(3)}</span>
                </div>
              ))}
            </div>
            {backendBrainTopVotes.length > 0 ? (
              <div style={{ display: "grid", gap: 4 }}>
                {backendBrainTopVotes.map((vote, index) => {
                  const voteName = String(vote.name || `agent-${index + 1}`);
                  const voteAction = String(vote.action || "HOLD").toUpperCase();
                  const voteConfidence = toNumber(vote.calibrated_confidence, toNumber(vote.confidence, 0));
                  const voteWeight = toNumber(vote.weight, 0);
                  return (
                    <div key={`brain-vote-${voteName}-${index}`} style={{ display: "grid", gridTemplateColumns: "1fr 0.7fr 1fr", gap: 6, fontSize: 10 }}>
                      <span className="subtle mini">{voteName}</span>
                      <span style={{ color: voteAction === "BUY" ? "#cfe9b9" : voteAction === "SELL" ? "#efc28f" : "#d7dbe0" }}>{voteAction}</span>
                      <span>{(voteConfidence * 100).toFixed(0)}% · w{voteWeight.toFixed(2)}</span>
                    </div>
                  );
                })}
              </div>
            ) : null}
            {backendBrainReason ? <div className="subtle mini">Brain: {backendBrainReason}</div> : null}
            <div className="subtle mini">Decision: {effectiveV8ShouldExecute ? "execute-eligible" : "hold / skip bias"}</div>
          </div>
          <div className="exec-kpis">
            <span className={`status-chip ${avgSlippage > 15 ? "alert-chip" : ""}`}>slip {avgSlippage.toFixed(1)} bps</span>
            <span className={`status-chip ${avgLatency > 200 ? "alert-chip" : ""}`}>lat {avgLatency.toFixed(0)} ms</span>
          </div>
          <div className="exec-mini-dom">
            {domLevels.slice(0, 6).map((lvl, index) => (
              <div key={`exec-dom-${index}`} className={`exec-mini-dom-row ${lvl.side}`}>
                <span>{lvl.side === "ask" ? "A" : "B"}</span>
                <strong>{lvl.price.toFixed(1)}</strong>
                <span>{lvl.size}</span>
              </div>
            ))}
          </div>
          <div className="exec-replay-block">
            <div className="chart-stat-label" style={{ marginBottom: 6 }}>Replay decision</div>
            <select value={replayDecisionId} onChange={(e) => setReplayDecisionId(e.target.value)} style={{ width: "100%", fontSize: 11, marginBottom: 8 }}>
              {replayOptions.length === 0 ? <option value="">Aucune décision</option> : null}
              {replayOptions.map((opt) => <option key={opt.id} value={opt.id}>{opt.id.slice(0, 24)}</option>)}
            </select>
            {replayError ? <div className="warn mini">{replayError}</div> : null}
            {replayLoading ? <div className="subtle mini">Chargement…</div> : null}
{/* ── BLAME TAG ── */}
            {!replayLoading && extendedBlame && (
              <div className={`blame-tag blame-${extendedBlame}`}>
                <span className="blame-icon">
                  {extendedBlame === "bad_execution"  ? "⚙"
                   : extendedBlame === "bad_decision"  ? "🧠"
                   : extendedBlame === "latency_spike" ? "⚡"
                   : extendedBlame === "regime_mismatch" ? "↔"
                   : extendedBlame === "memory_bias"   ? "📚"
                   : "〜"}
                </span>
                <span className="blame-label">LOSS CAUSE</span>
                <span className="blame-value">{extendedBlame.replace(/_/g, " ")}</span>
              </div>
            )}
            {!replayLoading && replayTelemetry ? (
              <div className="replay-mini-grid">
                <div><div className="chart-stat-label">Route</div><div style={{ fontSize: 12 }}>{replayRoute}</div></div>
                <div><div className="chart-stat-label">Slip</div><div style={{ fontSize: 12 }}>{replaySlippage.toFixed(2)} bps</div></div>
                <div><div className="chart-stat-label">Lat</div><div style={{ fontSize: 12 }}>{replayLatency.toFixed(0)} ms</div></div>
                <div><div className="chart-stat-label">Fills</div><div style={{ fontSize: 12 }}>{replayFills.length}</div></div>
                <div><div className="chart-stat-label">Net</div><div style={{ fontSize: 12 }}>{formatControlPlaneStateLabel(replayNetworkState)}</div></div>
                <div><div className="chart-stat-label">Retry</div><div style={{ fontSize: 12 }}>{replayRetryCount}</div></div>
              </div>
            ) : null}
            {!replayLoading ? (
              <div style={{ marginTop: 8 }}>
                <div className="chart-stat-label" style={{ marginBottom: 6 }}>Infra-aware replay</div>
                <div className="exec-explainability-pills">
                  <span className="chart-action-pill chart-action-pill-status neutral">network {formatControlPlaneStateLabel(replayNetworkState)} · {(replayInfraHealthScore * 100).toFixed(0)}%</span>
                  <span className="chart-action-pill">retry {replayRetryCount} · degraded {replayDegradedFlag ? "yes" : "no"}</span>
                  <span className="chart-action-pill">dns transient rate {(replayDnsTransientRate * 100).toFixed(0)}%</span>
                  <span className="chart-action-pill">timeout rate {(replayTimeoutRate * 100).toFixed(0)}%</span>
                  <span className="chart-action-pill">degraded usage {(replayDegradedUsageRatio * 100).toFixed(0)}%</span>
                </div>
                <div className="subtle mini" style={{ marginTop: 6 }}>
                  Infra {replayInfraLabel} · {replayFailureDetail || compactControlPlaneFailureLabel(replayFailureClassification)}
                  {replayNetworkGlobalSampleCount > 0 ? ` · sample ${replayNetworkGlobalSampleCount}` : ""}
                </div>
                {replayAttemptedTargets.length > 0 || replayAttemptedBaseUrls.length > 0 ? (
                  <div className="subtle mini">
                    Path {replayAttemptedTargets.slice(0, 3).join(" -> ") || replayAttemptedBaseUrls.slice(0, 2).join(" -> ")}
                  </div>
                ) : null}
              </div>
            ) : null}
            {!replayLoading ? (
              <div className="exec-explainability-block">
                <div className="chart-stat-label" style={{ marginBottom: 6 }}>Attribution Replay</div>
                <div className="exec-explainability-pills">
                  <span className="chart-action-pill chart-action-pill-status neutral">Explainable RL {replayAttributionHeadline}</span>
                  <span className="chart-action-pill">{replayAttributionContextLabel}</span>
                  <span className="chart-action-pill">{replayLatentHeadline}</span>
                  <span className="chart-action-pill">{replayDreamHeadline}</span>
                  {replayAgentLearningRows.length > 0 ? <span className="chart-action-pill">{replayAgentLearningHeadline}</span> : null}
                  {replayAttributionPills.slice(0, 2).map((pill) => (
                    <span key={`exec-replay-attr-${pill}`} className="chart-action-pill">{pill}</span>
                  ))}
                  {replayAgentLearningPills.slice(0, 2).map((pill) => (
                    <span key={`exec-replay-agent-${pill}`} className="chart-action-pill">{pill}</span>
                  ))}
                  {replayLatentPills.slice(0, 2).map((pill) => (
                    <span key={`exec-replay-latent-${pill}`} className="chart-action-pill">{pill}</span>
                  ))}
                </div>
              </div>
            ) : null}
            {/* ── TRADE LIFECYCLE ── */}
            {!replayLoading && calibLifecycle.length > 0 ? (
              <div style={{ marginTop: 8 }}>
                <div className="chart-stat-label" style={{ marginBottom: 6 }}>Trade lifecycle</div>
                <div className="lifecycle-strip">
                  {calibLifecycle.map((step, i) => {
                    const offset = calibLifecycle.length > 1
                      ? ((new Date(step.ts).getTime() - new Date(calibLifecycle[0].ts).getTime()) / calibLifecycleDurationMs) * 100
                      : (i / Math.max(1, calibLifecycle.length - 1)) * 100;
                    return (
                      <div key={`lc-${i}`} className={`lifecycle-point lifecycle-${step.kind}`} style={{ left: `${Math.max(0, Math.min(96, offset))}%` }}>
                        <span className="lifecycle-dot" />
                        <div className="lifecycle-label">{step.label}<br /><small>{formatClock(step.ts)}</small></div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}
            {!replayLoading && replayHistogram.length > 0 ? (
              <div style={{ marginTop: 10 }}>
                <div className="chart-stat-label" style={{ marginBottom: 4 }}>Histogramme slippage</div>
                {replayHistogram.slice(0, 5).map((it) => (
                  <div className="histogram-row" key={`rh-${it.bucket}`}>
                    <span style={{ minWidth: 36, fontSize: 11 }}>{it.bucket}bps</span>
                    <span className="histogram-bar"><span style={{ width: `${(it.count / replayHistogramMax) * 100}%` }} /></span>
                    <strong style={{ fontSize: 11 }}>{it.count}</strong>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
          <div className="exec-recent-block">
            <div className="chart-stat-label" style={{ marginBottom: 4 }}>Récentes</div>
            {replayItems.slice(0, 4).map((item, rri) => (
              <div className="exec-recent-row" key={`er-${rri}`}>
                <span className="exec-recent-sym">{instrumentLabel(item).slice(0, 10)}</span>
                <span className="subtle mini">{String(item.route_chosen || item.strategy_id || "–").slice(0, 12)}</span>
                <span className={`subtle mini ${toNumber(item.realized_slippage_bps || item.slippage_real_bps, 0) > 15 ? "warn" : ""}`}>{toNumber(item.realized_slippage_bps || item.slippage_real_bps, 0).toFixed(1)}bps</span>
              </div>
            ))}
          </div>
          <div className="exec-ticket-block">
            <div className="eyebrow" style={{ fontSize: 10, marginBottom: 8 }}>Ticket gouverné</div>
            {replayState.enabled ? <div className="replay-exec-guard">Replay Mode — execution disabled</div> : null}
            <div className="ticket-grid">
              <input value={accountId} onChange={(e) => setAccountId(e.target.value)} placeholder="account_id" disabled={replayState.enabled} />
              <input value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="symbol" disabled={replayState.enabled} />
              <select value={side} onChange={(e) => setSide(e.target.value)} disabled={replayState.enabled}>
                <option value="buy">buy</option>
                <option value="sell">sell</option>
              </select>
              <input type="number" step="0.01" value={lots} onChange={(e) => setLots(Number(e.target.value || 0))} placeholder="lots" disabled={replayState.enabled} />
              <input type="number" step="1" value={notional} onChange={(e) => setNotional(Number(e.target.value || 0))} placeholder="notional USD" disabled={replayState.enabled} />
              <input type="number" step="1" value={maxSpread} onChange={(e) => setMaxSpread(Number(e.target.value || 0))} placeholder="max spread bps" disabled={replayState.enabled} />
              <input value={rationale} onChange={(e) => setRationale(e.target.value)} placeholder="rationale" style={{ gridColumn: "1 / -1" }} disabled={replayState.enabled} />
              <button type="button" onClick={() => void submitTradeTicket()} disabled={busy || replayState.enabled} className="exec-send-order" style={{ gridColumn: "1 / -1" }}>{busy ? "Envoi…" : "Send Order"}</button>
            </div>
            {tradeResult ? (
              <details style={{ marginTop: 8 }}>
                <summary className="subtle mini">Résultat</summary>
                <pre style={{ fontSize: 10, whiteSpace: "pre-wrap", margin: 0, overflow: "hidden" }}>{JSON.stringify(tradeResult, null, 2)}</pre>
              </details>
            ) : null}
          </div>
        </PanelShell>
          </Panel>
        </PanelGroup>
      </section>

      {showMicroDeck || showMarketsDeck ? (
      <>
      {showMicroDeck ? (
      <>
      {/* ═══════════════ MICROSTRUCTURE 2×2 ════════════════════ */}
      <section
        className={`term-micro-shell${layoutDropPreview?.zone === "micro" ? " is-drop-zone-active" : ""}`}
        onDragOver={(event) => {
          if (layoutEditMode) {
            event.preventDefault();
            setLayoutDropPreview({ zone: "micro", mode: "zone" });
          }
        }}
        onDragLeave={() => {
          if (layoutDropPreview?.zone === "micro" && layoutDropPreview.mode === "zone") {
            setLayoutDropPreview(null);
          }
        }}
        onDrop={() => handleLayoutDropToZone("micro")}
      >
        <div className="micro-overview-bar">
          <span className="micro-overview-title">Microstructure</span>
          <span className="micro-overview-chip">DOM</span>
          <span className="micro-overview-chip">Footprint</span>
          <span className="micro-overview-chip">Tape</span>
          <span className="micro-overview-chip">Heatmap</span>
        </div>

      <div className="term-micro-grid">

        {/* DOM */}
        <div
          className={`layout-draggable-card${layoutEditMode ? " is-edit" : ""}${layoutDropPreview?.zone === "micro" && layoutDropPreview.targetId === "dom" ? " is-drop-target" : ""}`}
          draggable={layoutEditMode}
          onDragStart={() => { layoutDragRef.current = { zone: "micro", id: "dom" }; setLayoutDropPreview({ zone: "micro", targetId: "dom", mode: "panel" }); }}
          onDragEnd={() => { layoutDragRef.current = null; setLayoutDropPreview(null); }}
          onDragOver={(event) => { if (layoutEditMode) { event.preventDefault(); setLayoutDropPreview({ zone: "micro", targetId: "dom", mode: "panel" }); } }}
          onDrop={() => handleLayoutDrop("micro", "dom")}
          style={{ order: microOrderById.dom ?? 0, display: floatingPanels.some((fp) => fp.id === "dom") ? "none" : undefined }}
        >
        <PanelShell className="panel micro-panel gtix-panel-resizable-y">
          <div className="eyebrow micro-panel-title">
            DOM <span className={`micro-stream-badge micro-stream-${displayDepthStreamState}`}>{displayDepthStreamState}</span>
            <HelpTooltip termKey="dom" mode={uiMode} />
            {layoutEditMode && <button type="button" className="panel-detach-btn" title="Floating" onClick={() => detachPanel("dom", "micro")}>⤡</button>}
          </div>
          <div className="dom-table-compact">
            <div className="dom-header-row"><span>Side</span><span>Prix</span><span>Taille</span><span>Profondeur</span></div>
            {activeDomLevels.map((lvl, di) => (
              <div key={`dom-${di}`} className={`dom-row-compact ${lvl.side} ${di === highlightedDomIndex ? "row-highlight" : ""}`}>
                <span className={`dom-side-label ${lvl.side}`}>{lvl.side === "ask" ? "A" : "B"}</span>
                <span className="dom-price">{lvl.price.toFixed(1)}</span>
                <span className="dom-size">{lvl.size}</span>
                <span className="dom-bar-cell"><span style={{ width: `${Math.min(100, lvl.intensity * 100)}%` }} /></span>
              </div>
            ))}
          </div>
        </PanelShell>
        </div>

        {/* Footprint */}
        <div
          className={`layout-draggable-card${layoutEditMode ? " is-edit" : ""}${layoutDropPreview?.zone === "micro" && layoutDropPreview.targetId === "footprint" ? " is-drop-target" : ""}`}
          draggable={layoutEditMode}
          onDragStart={() => { layoutDragRef.current = { zone: "micro", id: "footprint" }; setLayoutDropPreview({ zone: "micro", targetId: "footprint", mode: "panel" }); }}
          onDragEnd={() => { layoutDragRef.current = null; setLayoutDropPreview(null); }}
          onDragOver={(event) => { if (layoutEditMode) { event.preventDefault(); setLayoutDropPreview({ zone: "micro", targetId: "footprint", mode: "panel" }); } }}
          onDrop={() => handleLayoutDrop("micro", "footprint")}
          style={{ order: microOrderById.footprint ?? 1, display: floatingPanels.some((fp) => fp.id === "footprint") ? "none" : undefined }}
        >
        <PanelShell className="panel micro-panel gtix-panel-resizable-y">
          <div className="eyebrow micro-panel-title">
            Footprint <HelpTooltip termKey="footprint" mode={uiMode} />
            {layoutEditMode && <button type="button" className="panel-detach-btn" title="Floating" onClick={() => detachPanel("footprint", "micro")}>⤡</button>}
          </div>
          <div className="footprint-compact">
            <div className="fp-header-row"><span>Niveau</span><span className="good">Buy</span><span className="warn">Sell</span><span>Δ</span></div>
            {activeFootprintRows.map((row, fpi) => (
              <div key={`fpc-${fpi}`} className={`fp-row-compact ${fpi === highlightedFootprintIndex ? "row-highlight" : ""}`}>
                <span className="fp-level">{row.timeLabel ? `${row.timeLabel} · ` : ""}{row.high.toFixed(0)}–{row.low.toFixed(0)}</span>
                <span className="good fp-num">{row.buyVolume.toFixed(0)}</span>
                <span className="warn fp-num">{row.sellVolume.toFixed(0)}</span>
                <span className={`fp-num ${row.delta >= 0 ? "good" : "warn"}`}>{row.delta.toFixed(0)}</span>
              </div>
            ))}
          </div>
        </PanelShell>
        </div>

        {/* Tape */}
        <div
          className={`layout-draggable-card${layoutEditMode ? " is-edit" : ""}${layoutDropPreview?.zone === "micro" && layoutDropPreview.targetId === "tape" ? " is-drop-target" : ""}`}
          draggable={layoutEditMode}
          onDragStart={() => { layoutDragRef.current = { zone: "micro", id: "tape" }; setLayoutDropPreview({ zone: "micro", targetId: "tape", mode: "panel" }); }}
          onDragEnd={() => { layoutDragRef.current = null; setLayoutDropPreview(null); }}
          onDragOver={(event) => { if (layoutEditMode) { event.preventDefault(); setLayoutDropPreview({ zone: "micro", targetId: "tape", mode: "panel" }); } }}
          onDrop={() => handleLayoutDrop("micro", "tape")}
          style={{ order: microOrderById.tape ?? 2, display: floatingPanels.some((fp) => fp.id === "tape") ? "none" : undefined }}
        >
        <PanelShell className="panel micro-panel gtix-panel-resizable-y">
          <div className="eyebrow micro-panel-title">
            Tape <HelpTooltip termKey="tape" mode={uiMode} />
            {layoutEditMode && <button type="button" className="panel-detach-btn" title="Floating" onClick={() => detachPanel("tape", "micro")}>⤡</button>}
          </div>
          <div className="tape-compact">
            {activeTape.map((print, ti) => (
              <div key={`tp-${ti}`} className={`tape-row-compact ${print.side} ${ti === highlightedTapeIndex ? "row-highlight" : ""}`}>
                <span className="tape-time">{print.label.slice(-8)}</span>
                <span className="tape-price">{print.price.toFixed(1)}</span>
                <span className="tape-vol">{print.volume}</span>
                <span className={`tape-badge ${print.side}`}>{print.side === "buy" ? "B" : print.side === "sell" ? "S" : "–"}</span>
              </div>
            ))}
          </div>
        </PanelShell>
        </div>

        {/* Heatmap */}
        <div
          className={`layout-draggable-card${layoutEditMode ? " is-edit" : ""}${layoutDropPreview?.zone === "micro" && layoutDropPreview.targetId === "heatmap" ? " is-drop-target" : ""}`}
          draggable={layoutEditMode}
          onDragStart={() => { layoutDragRef.current = { zone: "micro", id: "heatmap" }; setLayoutDropPreview({ zone: "micro", targetId: "heatmap", mode: "panel" }); }}
          onDragEnd={() => { layoutDragRef.current = null; setLayoutDropPreview(null); }}
          onDragOver={(event) => { if (layoutEditMode) { event.preventDefault(); setLayoutDropPreview({ zone: "micro", targetId: "heatmap", mode: "panel" }); } }}
          onDrop={() => handleLayoutDrop("micro", "heatmap")}
          style={{ order: microOrderById.heatmap ?? 3, display: floatingPanels.some((fp) => fp.id === "heatmap") ? "none" : undefined }}
        >
        <PanelShell className="panel micro-panel gtix-panel-resizable-y">
          <div className="eyebrow micro-panel-title">
            Heatmap <span className="subtle mini" style={{ marginLeft: 6 }}>{String(sessionState?.session || "–")} · imb {toNumber(marketMicro?.depth_imbalance, 0).toFixed(3)}</span>
            <HelpTooltip termKey="heatmap" mode={uiMode} />
            {layoutEditMode && <button type="button" className="panel-detach-btn" title="Floating" onClick={() => detachPanel("heatmap", "micro")}>⤡</button>}
          </div>
          <div className="heatmap-compact">
            {activeHeatmapLevels.map((lvl, hi) => (
              <div key={`hm-${hi}`} className={`hm-row ${lvl.side} ${hi === highlightedHeatmapIndex ? "row-highlight" : ""}`} style={{ opacity: Math.max(0.2, lvl.intensity) }}>
                <span className="hm-price">{lvl.price.toFixed(1)}</span>
                <div className="hm-bar-wrap"><div className={`hm-bar ${lvl.side}`} style={{ width: `${Math.min(100, lvl.intensity * 100)}%` }} /></div>
                <span className="hm-size">{lvl.size}</span>
              </div>
            ))}
          </div>
        </PanelShell>
        </div>
      </div>
      </section>
      </>
      ) : null}

      {/* ═══════════════ MATRICE MULTI-MARCHÉS ═════════════════ */}
      {showMarketsDeck ? (
      <section className="term-markets-strip">
        <div className="panel market-matrix-panel">
          <div className="eyebrow">Market Matrix</div>
          <div className="market-matrix-table">
            <div className="market-matrix-head"><span>Market</span><span>Px</span><span>Δ</span><span>Spread</span><span>Funding</span><span>OI</span><span>Volume</span><span>Regime</span><span>Sent.</span></div>
            {marketMatrixRows.map((row) => (
              <div key={row.symbol} className="market-matrix-row">
                <span className="market-matrix-symbol">{row.symbol}</span>
                <span>{row.price > 0 ? row.price.toFixed(2) : "–"}</span>
                <span className={row.deltaPct >= 0 ? "good" : "warn"}>{row.deltaPct >= 0 ? "+" : ""}{row.deltaPct.toFixed(2)}%</span>
                <span>{row.spread > 0 ? row.spread.toFixed(3) : "–"}</span>
                <span>{row.funding}</span>
                <span>{row.openInterest}</span>
                <span>{row.volume > 0 ? row.volume.toFixed(0) : "–"}</span>
                <span className={row.volatilityRegime === "high" ? "warn" : row.volatilityRegime === "medium" ? "subtle" : "good"}>{row.volatilityRegime}</span>
                <span className={row.sentiment === "risk-on" ? "good" : "warn"}>{row.sentiment}</span>
              </div>
            ))}
          </div>
        </div>
      </section>
      ) : null}
      </>
      ) : null}

      {/* ═══════════════ LOWER: BLOTTER + BROKERS ══════════════ */}
      <section
        className={`term-lower${layoutDropPreview?.zone === "lower" ? " is-drop-zone-active" : ""}`}
        onDragOver={(event) => {
          if (layoutEditMode) {
            event.preventDefault();
            setLayoutDropPreview({ zone: "lower", mode: "zone" });
          }
        }}
        onDragLeave={() => {
          if (layoutDropPreview?.zone === "lower" && layoutDropPreview.mode === "zone") {
            setLayoutDropPreview(null);
          }
        }}
        onDrop={() => handleLayoutDropToZone("lower")}
      >
        <div
          className={`layout-draggable-card${layoutEditMode ? " is-edit" : ""}${layoutDropPreview?.zone === "lower" && layoutDropPreview.targetId === "blotter" ? " is-drop-target" : ""}`}
          draggable={layoutEditMode}
          onDragStart={() => { layoutDragRef.current = { zone: "lower", id: "blotter" }; setLayoutDropPreview({ zone: "lower", targetId: "blotter", mode: "panel" }); }}
          onDragEnd={() => { layoutDragRef.current = null; setLayoutDropPreview(null); }}
          onDragOver={(event) => { if (layoutEditMode) { event.preventDefault(); setLayoutDropPreview({ zone: "lower", targetId: "blotter", mode: "panel" }); } }}
          onDrop={() => handleLayoutDrop("lower", "blotter")}
          style={{ order: lowerOrderById.blotter ?? 0, display: floatingPanels.some((fp) => fp.id === "blotter") ? "none" : undefined }}
        >
        <PanelShell className="panel term-blotter-panel gtix-panel-resizable-y">
          <div className="eyebrow">Blotter d'exécution <HelpHint text="Journal des exécutions récentes." examples={["Si slippage monte brutalement, suspecte broker ou routeur dégradé."]} />
            {layoutEditMode && <button type="button" className="panel-detach-btn" title="Floating" onClick={() => detachPanel("blotter", "lower")}>⤡</button>}
          </div>
          {filteredOutcomes.length === 0 ? <p className="subtle mini" style={{ marginTop: 8 }}>Aucune exécution.</p> : null}
          {filteredOutcomes.length > 0 ? (
            <div className="blotter-scroll">
              <table className="blotter-table" style={{ marginTop: 8 }}>
                <thead>
                  <tr>
                    <th>Time</th><th>Symbol</th><th>Strategy</th><th>Regime</th><th>PnL</th><th>Slip</th><th>Lat</th><th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredOutcomes.slice(0, 6).map((item, bi) => (
                    <tr key={`bl-${bi}`}>
                      <td>{String(item.created_at || "–").slice(11, 19)}</td>
                      <td>{instrumentLabel(item)}</td>
                      <td style={{ maxWidth: 80, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{String(item.strategy_id || "–").slice(0, 10)}</td>
                      <td>{String(item.regime || "–").slice(0, 8)}</td>
                      <td className={toNumber(item.net_result_usd, 0) >= 0 ? "good" : "warn"}>{toNumber(item.net_result_usd, 0).toFixed(2)}</td>
                      <td>{toNumber(item.slippage_real_bps, 0).toFixed(1)}bps</td>
                      <td>{toNumber(item.latency_ms, 0).toFixed(0)}ms</td>
                      <td>{String(item.status || "–").slice(0, 8)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </PanelShell>
        </div>

        <div
          className={`layout-draggable-card${layoutEditMode ? " is-edit" : ""}${layoutDropPreview?.zone === "lower" && layoutDropPreview.targetId === "brokers" ? " is-drop-target" : ""}`}
          draggable={layoutEditMode}
          onDragStart={() => { layoutDragRef.current = { zone: "lower", id: "brokers" }; setLayoutDropPreview({ zone: "lower", targetId: "brokers", mode: "panel" }); }}
          onDragEnd={() => { layoutDragRef.current = null; setLayoutDropPreview(null); }}
          onDragOver={(event) => { if (layoutEditMode) { event.preventDefault(); setLayoutDropPreview({ zone: "lower", targetId: "brokers", mode: "panel" }); } }}
          onDrop={() => handleLayoutDrop("lower", "brokers")}
          style={{ order: lowerOrderById.brokers ?? 1, display: floatingPanels.some((fp) => fp.id === "brokers") ? "none" : undefined }}
        >
        <PanelShell className="panel term-brokers-panel gtix-panel-resizable-y">
          <div className="eyebrow">Desk Bridge · OMS · Overlay <HelpTooltip termKey="brokers" mode={uiMode} />
            {layoutEditMode && <button type="button" className="panel-detach-btn" title="Floating" onClick={() => detachPanel("brokers", "lower")}>⤡</button>}
          </div>
          <div className="brokers-grid">
            <div className="brokers-section">
              <div className="chart-stat-label" style={{ marginBottom: 6 }}>OMS Lifecycle</div>
              <div className="row"><span>Approvals</span><span className={omsLifecycleSummary.pendingApprovals > 0 ? "warn" : "good"}>{omsLifecycleSummary.pendingApprovals}</span></div>
              <div className="row"><span>Routed / ack</span><span>{omsLifecycleSummary.routedCount} / {omsLifecycleSummary.acceptedCount}</span></div>
              <div className="row"><span>Partial / final</span><span>{omsLifecycleSummary.partialCount} / {omsLifecycleSummary.filledCount}</span></div>
              <div className="row"><span>Blocked</span><span className={omsLifecycleSummary.blockedCount > 0 ? "warn" : "good"}>{omsLifecycleSummary.blockedCount}</span></div>
              <div className="row"><span>Latency / slip</span><span>{omsLifecycleSummary.avgLatencyMs.toFixed(0)} ms | {omsLifecycleSummary.avgSlippageBps.toFixed(1)} bps</span></div>
              <div className="row"><span>Agents live</span><span className={omsLifecycleSummary.agentReadyCount >= Math.max(1, omsLifecycleSummary.agentTotalCount) ? "good" : "subtle"}>{omsLifecycleSummary.agentReadyCount}/{omsLifecycleSummary.agentTotalCount}</span></div>
            </div>
            <div className="brokers-section">
              <div className="chart-stat-label" style={{ marginBottom: 6 }}>Portfolio Overlay</div>
              <div className="row"><span>Free equity</span><span>{toNumber(portfolioOverlaySummary.accountFreeUsd, 0).toFixed(0)} USD</span></div>
              <div className="row"><span>Open books</span><span>{portfolioOverlaySummary.openTradesCount}</span></div>
              <div className="row"><span>Gross exposure</span><span>{toNumber(portfolioOverlaySummary.grossExposureUsd, 0).toFixed(0)} USD</span></div>
              <div className="row"><span>Exposure / cash</span><span className={portfolioOverlaySummary.exposureRatioPct >= 100 ? "warn" : portfolioOverlaySummary.exposureRatioPct >= 70 ? "subtle" : "good"}>{portfolioOverlaySummary.exposureRatioPct.toFixed(0)}%</span></div>
              <div className="row"><span>PnL 24h</span><span className={portfolioOverlaySummary.dailyPnLUsd >= 0 ? "good" : "warn"}>{toNumber(portfolioOverlaySummary.dailyPnLUsd, 0).toFixed(0)} USD</span></div>
              <div className="row"><span>Intraday DD</span><span className={portfolioOverlaySummary.dailyDrawdownPct >= 2 ? "warn" : portfolioOverlaySummary.dailyDrawdownPct >= 1 ? "subtle" : "good"}>{portfolioOverlaySummary.dailyDrawdownPct.toFixed(2)}%</span></div>
            </div>
            <div className="brokers-section">
              <div className="chart-stat-label" style={{ marginBottom: 6 }}>AI Execution Bridge</div>
              <div className="row"><span>V7 gate</span><span className={aiBridgeSummary.v7Tone === "good" ? "good" : aiBridgeSummary.v7Tone === "warn" ? "warn" : "subtle"}>{aiBridgeSummary.v7Label}</span></div>
              <div className="row"><span>Route</span><span>{aiBridgeSummary.routeLabel} | {aiBridgeSummary.routeScore.toFixed(2)}</span></div>
              <div className="row"><span>Final edge</span><span className={aiBridgeSummary.edgeBps >= 0 ? "good" : "warn"}>{aiBridgeSummary.edgeBps.toFixed(1)} bps</span></div>
              <div className="row"><span>V8 execute</span><span className={aiBridgeSummary.v8Execute ? "good" : "subtle"}>{aiBridgeSummary.v8Execute ? "yes" : "hold"} | {aiBridgeSummary.v8ProbabilityPct.toFixed(0)}%</span></div>
              <div className="row"><span>Brain</span><span>{aiBridgeSummary.brainAction} | {aiBridgeSummary.brainConfidencePct.toFixed(0)}%</span></div>
              <div className="row"><span>Regime</span><span>{aiBridgeSummary.brainRegime}</span></div>
            </div>
          </div>
          <div style={{ marginTop: 10, borderTop: "1px solid var(--line)", paddingTop: 8, fontSize: 12 }}>
            <div className="row"><span className="chart-stat-label">Last OMS event</span><span>{omsLifecycleSummary.lastEventIso ? formatClock(omsLifecycleSummary.lastEventIso) : "–"}</span></div>
            <div className="row"><span className="chart-stat-label">Dominant book</span><span className="gtix-ellipsis">{portfolioOverlaySummary.dominantBookLabel}</span></div>
            <div className="row"><span className="chart-stat-label">Predictor rationale</span><span className="gtix-ellipsis">{aiBridgeSummary.reasonLabel || "–"}</span></div>
          </div>
        </PanelShell>
        </div>
      </section>

      {showMonitoringDeck ? (
      <>
      {/* ═══════════════ MONITORING ════════════════════════════ */}
      <section className="panel term-monitoring">
        <div className="term-monitoring-bar">
          <span className="term-monitoring-title">Ops Widgets</span>
          {publicOpsRefreshPaused ? <span className="monitoring-state-badge paused">background paused</span> : <span className="monitoring-state-badge live">live refresh</span>}
        </div>
        <div
          className={`monitoring-cols${layoutDropPreview?.zone === "monitoring" ? " is-drop-zone-active" : ""}`}
          onDragOver={(event) => {
            if (layoutEditMode) {
              event.preventDefault();
              setLayoutDropPreview({ zone: "monitoring", mode: "zone" });
            }
          }}
          onDragLeave={() => {
            if (layoutDropPreview?.zone === "monitoring" && layoutDropPreview.mode === "zone") {
              setLayoutDropPreview(null);
            }
          }}
          onDrop={() => handleLayoutDropToZone("monitoring")}
        >
          <div
            className={`layout-draggable-card${layoutEditMode ? " is-edit" : ""}${layoutDropPreview?.zone === "monitoring" && layoutDropPreview.targetId === "alerts" ? " is-drop-target" : ""}`}
            draggable={layoutEditMode}
            onDragStart={() => { layoutDragRef.current = { zone: "monitoring", id: "alerts" }; setLayoutDropPreview({ zone: "monitoring", targetId: "alerts", mode: "panel" }); }}
            onDragEnd={() => { layoutDragRef.current = null; setLayoutDropPreview(null); }}
            onDragOver={(event) => { if (layoutEditMode) { event.preventDefault(); setLayoutDropPreview({ zone: "monitoring", targetId: "alerts", mode: "panel" }); } }}
            onDrop={() => handleLayoutDrop("monitoring", "alerts")}
            style={{ order: monitoringOrderById.alerts ?? 0, display: floatingPanels.some((fp) => fp.id === "alerts") ? "none" : undefined }}
          >
          <AlertsMonitoringPanel badge={publicOpsPanelBadge} layoutEditMode={layoutEditMode} onDetach={() => detachPanel("alerts", "monitoring")} filteredAlerts={filteredAlerts} />
          </div>
          <div
            className={`layout-draggable-card${layoutEditMode ? " is-edit" : ""}${layoutDropPreview?.zone === "monitoring" && layoutDropPreview.targetId === "incidents" ? " is-drop-target" : ""}`}
            draggable={layoutEditMode}
            onDragStart={() => { layoutDragRef.current = { zone: "monitoring", id: "incidents" }; setLayoutDropPreview({ zone: "monitoring", targetId: "incidents", mode: "panel" }); }}
            onDragEnd={() => { layoutDragRef.current = null; setLayoutDropPreview(null); }}
            onDragOver={(event) => { if (layoutEditMode) { event.preventDefault(); setLayoutDropPreview({ zone: "monitoring", targetId: "incidents", mode: "panel" }); } }}
            onDrop={() => handleLayoutDrop("monitoring", "incidents")}
            style={{ order: monitoringOrderById.incidents ?? 1, display: floatingPanels.some((fp) => fp.id === "incidents") ? "none" : undefined }}
          >
          <IncidentsMonitoringPanel badge={publicOpsPanelBadge} layoutEditMode={layoutEditMode} onDetach={() => detachPanel("incidents", "monitoring")} incidents={incidents} incidentRows={incidentRows} />
          </div>
          <div
            className={`layout-draggable-card${layoutEditMode ? " is-edit" : ""}${layoutDropPreview?.zone === "monitoring" && layoutDropPreview.targetId === "governance" ? " is-drop-target" : ""}`}
            draggable={layoutEditMode}
            onDragStart={() => { layoutDragRef.current = { zone: "monitoring", id: "governance" }; setLayoutDropPreview({ zone: "monitoring", targetId: "governance", mode: "panel" }); }}
            onDragEnd={() => { layoutDragRef.current = null; setLayoutDropPreview(null); }}
            onDragOver={(event) => { if (layoutEditMode) { event.preventDefault(); setLayoutDropPreview({ zone: "monitoring", targetId: "governance", mode: "panel" }); } }}
            onDrop={() => handleLayoutDrop("monitoring", "governance")}
            style={{ order: monitoringOrderById.governance ?? 2, display: floatingPanels.some((fp) => fp.id === "governance") ? "none" : undefined }}
          >
          <GovernanceMonitoringPanel
            badge={publicOpsPanelBadge}
            layoutEditMode={layoutEditMode}
            onDetach={() => detachPanel("governance", "monitoring")}
            governanceSort={governanceSort}
            onGovernanceSortChange={setGovernanceSort}
            incidentSort={incidentSort}
            onIncidentSortChange={setIncidentSort}
            governanceOnlyAlerts={governanceOnlyAlerts}
            onGovernanceOnlyAlertsChange={setGovernanceOnlyAlerts}
            governanceFilterText={governanceFilterText}
            onGovernanceFilterTextChange={setGovernanceFilterText}
            governanceFiltered={governanceFiltered}
          />
          </div>
          <div
            className={`layout-draggable-card${layoutEditMode ? " is-edit" : ""}${layoutDropPreview?.zone === "monitoring" && layoutDropPreview.targetId === "readiness" ? " is-drop-target" : ""}`}
            draggable={layoutEditMode}
            onDragStart={() => { layoutDragRef.current = { zone: "monitoring", id: "readiness" }; setLayoutDropPreview({ zone: "monitoring", targetId: "readiness", mode: "panel" }); }}
            onDragEnd={() => { layoutDragRef.current = null; setLayoutDropPreview(null); }}
            onDragOver={(event) => { if (layoutEditMode) { event.preventDefault(); setLayoutDropPreview({ zone: "monitoring", targetId: "readiness", mode: "panel" }); } }}
            onDrop={() => handleLayoutDrop("monitoring", "readiness")}
            style={{ order: monitoringOrderById.readiness ?? 3, display: floatingPanels.some((fp) => fp.id === "readiness") ? "none" : undefined }}
          >
          <ReadinessMonitoringPanel badge={publicOpsPanelBadge} layoutEditMode={layoutEditMode} onDetach={() => detachPanel("readiness", "monitoring")} driftItems={driftItems} suspendedCount={suspended.length} memorySummary={memorySummary} incidents={incidents} />
          </div>
          <div
            className={`layout-draggable-card${layoutEditMode ? " is-edit" : ""}${layoutDropPreview?.zone === "monitoring" && layoutDropPreview.targetId === "risktimeline" ? " is-drop-target" : ""}`}
            draggable={layoutEditMode}
            onDragStart={() => { layoutDragRef.current = { zone: "monitoring", id: "risktimeline" }; setLayoutDropPreview({ zone: "monitoring", targetId: "risktimeline", mode: "panel" }); }}
            onDragEnd={() => { layoutDragRef.current = null; setLayoutDropPreview(null); }}
            onDragOver={(event) => { if (layoutEditMode) { event.preventDefault(); setLayoutDropPreview({ zone: "monitoring", targetId: "risktimeline", mode: "panel" }); } }}
            onDrop={() => handleLayoutDrop("monitoring", "risktimeline")}
            style={{ order: monitoringOrderById.risktimeline ?? 4, display: floatingPanels.some((fp) => fp.id === "risktimeline") ? "none" : undefined }}
          >
          <RiskTimelineMonitoringPanel badge={publicOpsPanelBadge} layoutEditMode={layoutEditMode} onDetach={() => detachPanel("risktimeline", "monitoring")} body={renderRiskTimelineBody(6, "rt-mon")} />
          </div>
        </div>
      </section>
      </>
      ) : null}

      {/* ═══════════════ CAPITAL ALLOCATION ENGINE ═══════════════════════════ */}
      {showCapitalDeck && (strategyPerformance.length > 0 || showDecisionOverlay) && (
        <section className="panel term-alloc-panel">
          <div className="eyebrow">
            Capital Allocation Engine{" "}
            <HelpHint
              text="Score calibré (Bayes) × régime fit × santé stratégie EMA → allocation recommandée par décision."
              examples={[
                "Full ≥ 1.5% : score fort + régime favorable + stratégie saine.",
                "Minimal < 0.7% : high risk, consensus faible, ou drawdown actif.",
              ]}
            />
          </div>
          <ModuleGuide
            mode={uiMode}
            title="Allocation guide"
            what="Ce moteur convertit la qualité du signal en taille de risque recommandée."
            why="Il empêche de sur-allouer un signal fragile et protège le portefeuille quand le contexte global se dégrade."
            example="Un signal peut rester intéressant mais être forcé en taille minimale si le meta-risk abaisse le capital disponible."
          />
          {showDecisionOverlay && requiresHumanApproval && (
            <div className="human-approval-gate hag-panel">
              🔒 APPROBATION HUMAINE REQUISE
              <span className="hag-reason">
                {isCurrentRegimeBlocked
                  ? `régime ${overlayDecisionRegime} bloqué (degradation Brier)`
                  : metaRiskOfficer.tier === "kill-switch"
                  ? "meta-risk: kill-switch"
                  : metaRiskOfficer.tier === "force-suggest"
                  ? "meta-risk: force suggest"
                  : extendedBlame === "latency_spike"
                  ? "latency spike d\u00e9tect\u00e9"
                  : isHighRisk
                  ? "territoire non cartographi\u00e9"
                  : "consensus faible"}
              </span>
            </div>
          )}
          <div className="alloc-grid">
            {showDecisionOverlay && (
              <>
                <div className="alloc-block">
                  <div className="alloc-label">Allocation recommand\u00e9e</div>
                  <div className="alloc-gauge-wrap">
                    <div
                      className={`alloc-gauge alloc-tier-${allocTier}`}
                      style={{ width: `${Math.min(100, (recommendedAllocPct / 2) * 100).toFixed(0)}%` }}
                    />
                  </div>
                  <div className="alloc-pct-row">
                    <span className={`alloc-pct alloc-tier-${allocTier}`}>
                      {recommendedAllocPct.toFixed(2)}%
                    </span>
                    <span className={`alloc-tier-badge alloc-tier-${allocTier}`}>
                      {allocTier}
                    </span>
                  </div>
                </div>
                <div className="alloc-block">
                  <div className="alloc-label">Facteurs d&apos;ajustement</div>
                  <div className="alloc-factor-row">
                    <span>Score eff.</span>
                    <span>{effectiveScoreFull.toFixed(2)}</span>
                  </div>
                  <div className="alloc-factor-row">
                    <span>Régime fit</span>
                    <span>{(allocRegimeFit * 100).toFixed(0)}%</span>
                  </div>
                  <div className="alloc-factor-row">
                    <span>Régime calib</span>
                    <span className={regimeCalibMultiplier >= 0.9 ? "good" : regimeCalibMultiplier >= 0.7 ? "" : "warn"}>
                      {(regimeCalibMultiplier * 100).toFixed(0)}%
                    </span>
                  </div>
                  <div className="alloc-factor-row">
                    <span>EMA WR</span>
                    <span className={allocEmaWR >= 0.5 ? "good" : "warn"}>
                      {(allocEmaWR * 100).toFixed(0)}%
                    </span>
                  </div>
                  <div className="alloc-factor-row">
                    <span>Venue score</span>
                    <span className={venueQualityLabel === "good" ? "good" : venueQualityLabel === "fair" ? "subtle" : "warn"}>
                      {(venueQualityScore * 100).toFixed(0)}% ({activeVenueMetrics?.venue || "n/a"})
                    </span>
                  </div>
                  <div className="alloc-factor-row">
                    <span>Meta capital</span>
                    <span className={allocMetaRiskMultiplier >= 0.85 ? "good" : allocMetaRiskMultiplier >= 0.6 ? "subtle" : "warn"}>
                      {(allocMetaRiskMultiplier * 100).toFixed(0)}% ({metaRiskOfficer.tier})
                    </span>
                  </div>
                  {allocDrawdownPenalty > 0 && (
                    <div className="alloc-factor-row">
                      <span>Drawdown Δ</span>
                      <span className="warn">−{(allocDrawdownPenalty * 100).toFixed(0)}%</span>
                    </div>
                  )}
                  {isHighRisk && (
                    <div className="alloc-factor-row">
                      <span>High Risk</span>
                      <span className="warn">−50%</span>
                    </div>
                  )}
                  {corrPenalty > 0 && (
                    <div className="alloc-factor-row">
                      <span>Corr Penalty</span>
                      <span className="warn">−{(corrPenalty * 100).toFixed(0)}%</span>
                    </div>
                  )}
                  {sampleConfidenceInfo && allocSampleModifier < 1.0 && (
                    <div className="alloc-factor-row">
                      <span>Sample Cap</span>
                      <span className={sampleConfidenceInfo.tier === 'LOW' ? 'warn' : ''}>{(allocSampleModifier * 100).toFixed(0)}%</span>
                    </div>
                  )}
                  {sampleConfidenceInfo && (
                    <div className="alloc-factor-row" style={{ fontSize: '8px', color: 'rgba(255,255,255,0.5)' }}>
                      <span>{sampleConfidenceInfo.displayLabel}</span>
                      <span>{sampleConfidenceInfo.wrPct}% ±{sampleConfidenceInfo.ciWidth}%</span>
                    </div>
                  )}
                  {isCurrentRegimeBlocked && (
                    <div className="alloc-factor-row">
                      <span>Regime block</span>
                      <span className="warn">ACTIVE (alloc=0)</span>
                    </div>
                  )}
                </div>
              </>
            )}
            {allocSoftmax.length > 0 && (
              <div className="alloc-block">
                <div className="alloc-label">Distribution stratégies (softmax)</div>
                {allocSoftmax.map((s) => (
                  <div key={s.id} className="alloc-strat-row">
                    <span className="asr-id">{s.id.slice(0, 12)}</span>
                    <div className="alloc-gauge-wrap">
                      <div
                        className="alloc-gauge alloc-tier-reduced"
                        style={{ width: `${Math.min(100, (s.pct / 1.5) * 100).toFixed(0)}%` }}
                      />
                    </div>
                    <span className="asr-pct">{s.pct.toFixed(2)}%</span>
                  </div>
                ))}
              </div>
            )}
            {showDecisionOverlay && execQualityScore !== null && (
              <div className="alloc-block">
                <div className="alloc-label">Qualité exécution</div>
                <div className="alloc-gauge-wrap">
                  <div
                    className={`alloc-gauge exec-qual-${execQualityLabel}`}
                    style={{ width: `${(execQualityScore * 100).toFixed(0)}%` }}
                  />
                </div>
                <span className={`exec-qual-badge exec-qual-${execQualityLabel}`}>
                  {execQualityLabel} · {(execQualityScore * 100).toFixed(0)}%
                </span>
              </div>
            )}
          </div>
        </section>
      )}

      {/* ── META-RISK OFFICER ────────────────────────────────────────────────── */}
      {showMetaRiskDeck && (showDecisionOverlay || filteredOutcomes.length > 0) && (
        <section className="kpi-calib-panel">
          <div className="kpi-calib-title">🛡️ Meta-Risk Officer</div>
          <ModuleGuide
            mode={uiMode}
            title="Meta-risk guide"
            what="Le meta-risk mesure la santé globale du moteur et réduit l'exposition quand les signaux se dégradent."
            why="Cette couche protège contre une dérive systémique qui ne serait pas visible en regardant une seule stratégie."
            example="Si plusieurs drops apparaissent, que la santé baisse et que le Brier monte, le capital global peut être contracté ou un régime bloqué."
          />
          <div className="calib-kpi-block">
            <div className="calib-kpi-block-title">System Health</div>
            <div className="brier-score-container">
              <div
                className={`brier-score-display${
                  metaRiskOfficer.healthScore >= 0.85 ? ""
                  : metaRiskOfficer.healthScore >= 0.6 ? " overfit"
                  : " poor"
                }`}
              >
                {(metaRiskOfficer.healthScore * 100).toFixed(0)}
              </div>
              <div className="brier-score-info">
                <div className="brier-score-info-label">Tier: {metaRiskOfficer.tier}</div>
                <div className="brier-score-info-value">
                  Momentum: {metaRiskOfficer.healthMomentum >= 0 ? "+" : ""}{(metaRiskOfficer.healthMomentum * 100).toFixed(1)}
                </div>
                <div className="brier-score-info-value">
                  Capital cap: {(metaRiskOfficer.globalCapitalMultiplier * 100).toFixed(0)}%
                </div>
              </div>
            </div>
            {metaRiskOfficer.issues.length > 0 && (
              <div style={{ marginTop: 6, fontSize: 10, color: "rgba(255,255,255,0.7)" }}>
                Issues: {metaRiskOfficer.issues.join(" · ")}
              </div>
            )}
            {metaRiskHealthHistory.length >= 3 && (() => {
              const W = 80, H = 18;
              const N = metaRiskHealthHistory.length;
              const min = Math.min(...metaRiskHealthHistory);
              const max = Math.max(...metaRiskHealthHistory);
              const range = max - min || 0.01;
              const pts = metaRiskHealthHistory
                .map((v, i) => `${(i / (N - 1)) * W},${H - ((v - min) / range) * H}`)
                .join(" ");
              const trend = metaRiskHealthHistory[N - 1] >= metaRiskHealthHistory[0] ? "#4ade80" : "#f87171";
              return (
                <div className="meta-risk-sparkline-wrap" title={`Health history (${N} pts)`}>
                  <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="meta-risk-sparkline">
                    <polyline points={pts} fill="none" stroke={trend} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
              );
            })()}
          </div>

          <div className="calib-kpi-block">
            <div className="calib-kpi-block-title">Runbooks</div>
            {metaRiskOfficer.runbooks.length === 0 ? (
              <div className="subtle mini">Aucun runbook actif.</div>
            ) : (
              metaRiskOfficer.runbooks.map((rb, idx) => (
                <div key={`rb-${idx}`} className="alloc-factor-row" style={{ gridTemplateColumns: "110px 1fr 56px", gap: 8 }}>
                  <span className={rb.severity === "critical" || rb.severity === "high" ? "warn" : rb.severity === "medium" ? "subtle" : "good"}>
                    {rb.severity}
                  </span>
                  <span style={{ color: "rgba(255,255,255,0.75)", fontSize: 10 }}>
                    {rb.type}: {rb.recommendedAction}
                  </span>
                  <span className={rb.auto ? "warn" : "subtle"}>{rb.auto ? "AUTO" : "MANUAL"}</span>
                </div>
              ))
            )}
          </div>

          <div className="calib-kpi-block">
            <div className="calib-kpi-block-title">Regime Auto-Blocking</div>
            <div className="regime-buckets-container">
              {Object.entries(regimeRiskMonitor.byRegime).map(([regime, info]) => (
                <div key={`regime-risk-${regime}`} className="regime-bucket-card">
                  <div className="regime-bucket-label">{regime}</div>
                  <div className="regime-bucket-metric">
                    <span>Brier prev/recent</span>
                    <span className="regime-bucket-metric-value">
                      {info.previousBrier !== null ? info.previousBrier.toFixed(2) : "–"} / {info.recentBrier !== null ? info.recentBrier.toFixed(2) : "–"}
                    </span>
                  </div>
                  <div className="regime-bucket-metric">
                    <span>Delta</span>
                    <span className={info.delta > 0.1 ? "warn" : "good"}>{info.delta >= 0 ? "+" : ""}{info.delta.toFixed(2)}</span>
                  </div>
                  <div className="regime-bucket-metric">
                    <span>Status</span>
                    <span className={info.blocked ? "warn" : "good"}>{info.blocked ? "BLOCKED" : "active"}</span>
                  </div>
                  {info.reason && <div style={{ fontSize: 9, color: "rgba(255,180,180,0.8)" }}>{info.reason}</div>}
                </div>
              ))}
            </div>
          </div>

          <div className="calib-kpi-block">
            <div className="calib-kpi-block-title">Meta-Risk Audit Trail</div>
            {metaRiskAuditTrail.length > 0 && (
              <div className="meta-risk-drop-pressure">
                <span className="meta-risk-drop-pressure-kpi">
                  <span className="meta-risk-drop-pressure-label">Drops (24h)</span>
                  <span className="meta-risk-drop-pressure-value">{dropPressure24h.count}</span>
                </span>
                <span className="meta-risk-drop-pressure-kpi">
                  <span className="meta-risk-drop-pressure-label">Total contraction</span>
                  <span className={`meta-risk-drop-pressure-value${dropPressure24h.totalContraction > 0 ? " warn" : ""}`}>
                    {dropPressure24h.totalContraction > 0 ? `-${dropPressure24h.totalContraction.toFixed(0)}%` : "–"}
                  </span>
                </span>
                <span className="meta-risk-drop-pressure-kpi">
                  <span className="meta-risk-drop-pressure-label">Largest drop</span>
                  <span className={`meta-risk-drop-pressure-value${dropPressure24h.largestDrop > 0 ? " warn" : ""}`}>
                    {dropPressure24h.largestDrop > 0 ? `-${dropPressure24h.largestDrop.toFixed(0)}%` : "–"}
                  </span>
                </span>
              </div>
            )}
            <div className="meta-risk-audit-toolbar">
              <button
                type="button"
                className={`meta-risk-audit-filter-btn${!metaRiskAuditShowOnlyDrops ? " active" : ""}`}
                onClick={() => setMetaRiskAuditShowOnlyDrops(false)}
              >
                All
              </button>
              <button
                type="button"
                className={`meta-risk-audit-filter-btn danger${metaRiskAuditShowOnlyDrops ? " active" : ""}`}
                onClick={() => setMetaRiskAuditShowOnlyDrops(true)}
              >
                show only size drops
              </button>
              <button
                type="button"
                className={`meta-risk-audit-filter-btn${metaRiskAuditDropSort === "recent" ? " active" : ""}`}
                onClick={() => setMetaRiskAuditDropSort("recent")}
              >
                most recent drop first
              </button>
              <button
                type="button"
                className={`meta-risk-audit-filter-btn${metaRiskAuditDropSort === "largest" ? " active" : ""}`}
                onClick={() => setMetaRiskAuditDropSort("largest")}
              >
                largest drop first
              </button>
              <span className="meta-risk-audit-count">
                {sortedMetaRiskAuditTrail.length} event{sortedMetaRiskAuditTrail.length === 1 ? "" : "s"}
              </span>
            </div>
            {sortedMetaRiskAuditTrail.length === 0 ? (
              <div className="subtle mini">Aucune transition enregistrée pour l’instant.</div>
            ) : (
              <div className="meta-risk-audit-table">
                <div className="meta-risk-audit-head">
                  <span>Time</span>
                  <span>Tier</span>
                  <span>Capital</span>
                  <span>Reason</span>
                </div>
                {sortedMetaRiskAuditTrail.slice(0, 12).map((evt) => {
                  const dropPct =
                    evt.capitalFromPct > 0
                      ? Math.max(0, ((evt.capitalFromPct - evt.capitalToPct) / evt.capitalFromPct) * 100)
                      : 0;
                  const dropSeverity =
                    dropPct > 40 ? "critical"
                    : dropPct >= 15 ? "major"
                    : "minor";
                  const capTitle = `from ${(evt.capitalFromPct / 100).toFixed(2)}x to ${(evt.capitalToPct / 100).toFixed(2)}x\nreason: ${evt.reason || "state change"}`;
                  const r = (evt.reason || "").toLowerCase();
                  const dominantCause =
                    r.includes("cluster") ? "CLUSTER"
                    : r.includes("brier") ? "BRIER"
                    : r.includes("regime") ? "REGIME"
                    : r.includes("venue") ? "VENUE"
                    : r.includes("consensus") ? "CONSENSUS"
                    : "OTHER";
                  return (
                    <div key={evt.id} className={`meta-risk-audit-row${evt.capitalToPct < evt.capitalFromPct ? " size-drop" : ""}`}>
                      <span className="meta-risk-audit-time">{formatClock(evt.timestampIso)}</span>
                      <span className="meta-risk-audit-tier">
                        {evt.tierFrom} → {evt.tierTo}
                      </span>
                      <span className="meta-risk-audit-cap" title={capTitle}>
                        <span className="meta-risk-audit-cap-target">{evt.capitalToPct.toFixed(0)}%</span>
                        {dropPct > 0 && (
                          <span className={`meta-risk-drop-badge ${dropSeverity}`}>
                            DROP -{dropPct.toFixed(0)}%
                          </span>
                        )}
                        <span className={`meta-risk-cause-tag cause-${dominantCause.toLowerCase()}`}>{dominantCause}</span>
                      </span>
                      <span className="meta-risk-audit-reason" title={evt.reason}>
                        {evt.reason || "state change"}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>
      )}

      {/* ── PORTFOLIO CORRELATION DASHBOARD ───────────────────────────────────── */}
      {showCorrelationDeck && strategyPerformance.length > 1 && (
        <section className="kpi-calib-panel">
          <div className="kpi-calib-title">🔗 Portfolio Correlation & Exposure</div>
          
          {/* Correlation Matrix Heatmap */}
          {Object.keys(strategyCorrelationMatrix).length > 0 && (
            <div className="calib-kpi-block">
              <div className="calib-kpi-block-title">Strategy Correlation Matrix (shrinkage-adjusted)</div>
              <div className="corr-heatmap-container">
                <div className="corr-heatmap-matrix">
                  {/* Header row */}
                  <div className="corr-heatmap-row">
                    <div className="corr-heatmap-label">–</div>
                    {Object.keys(strategyCorrelationMatrix).slice(0, 6).map((stratId) => (
                      <div key={`header-${stratId}`} className="corr-heatmap-label">
                        {stratId.slice(0, 6)}
                      </div>
                    ))}
                  </div>
                  {/* Data rows */}
                  {Object.entries(strategyCorrelationMatrix).slice(0, 6).map(([s1Id, row]) => (
                    <div key={`row-${s1Id}`} className="corr-heatmap-row">
                      <div className="corr-heatmap-label">{s1Id.slice(0, 6)}</div>
                      {Object.entries(row).slice(0, 6).map(([s2Id, data]) => (
                        <div
                          key={`cell-${s1Id}-${s2Id}`}
                          className={`corr-heatmap-cell corr-cell-${
                            data.flag === 'LOW_SAMPLE' ? 'low-sample'
                            : data.flag === 'self' ? 'self'
                            : data.flag === 'REDUNDANT' ? 'redundant'
                            : data.flag === 'MODERATE' ? 'moderate'
                            : 'independent'
                          }`}
                          title={`${s1Id} ↔ ${s2Id}: ${Number.isFinite(data.corr) ? data.corr.toFixed(2) : 'N/A'} (n=${data.n})`}
                        >
                          {Number.isFinite(data.corr) ? data.corr.toFixed(2) : '–'}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
                <div style={{ fontSize: '8px', color: 'rgba(255,255,255,0.4)', marginTop: 4 }}>
                  🟢 Independent (&lt;0.5) | 🟡 Moderate (0.5-0.7) | 🔴 Redundant (&gt;0.7)
                </div>
              </div>
            </div>
          )}

          {/* Cluster Groups */}
          {strategyClusterGroups.length > 0 && (
            <div className="calib-kpi-block">
              <div className="calib-kpi-block-title">Detected Clusters (corr &gt; 0.7)</div>
              <div className="cluster-groups-container">
                {strategyClusterGroups.map((group, idx) => (
                  <div key={`cluster-${idx}`} className="cluster-group">
                    <span className="cluster-group-icon">🔴</span>
                    <span className="cluster-group-members">
                      {group.map(s => s.slice(0, 8)).join(' + ')}
                    </span>
                    <span style={{ marginLeft: 'auto', color: '#ff7d7d' }}>
                      ⚠️ Redundant cluster detected
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Market Exposure by Market Type */}
          {Object.keys(marketExposureByCluster).length > 0 && (
            <div className="calib-kpi-block">
              <div className="calib-kpi-block-title">Market Exposure (per market cluster)</div>
              <div className="market-exposure-container">
                {Object.entries(marketExposureByCluster).map(([market, data]) => (
                  <div key={`market-${market}`} className="market-exposure-card">
                    <div className="market-exposure-name">{market}</div>
                    <div className="market-exposure-bar">
                      <div
                        className={`market-exposure-fill${data.flag ? ' over-cap' : ''}`}
                        style={{ width: `${Math.min(100, (data.exposure / data.cap) * 100)}%` }}
                      />
                    </div>
                    <div className="market-exposure-metric">
                      <span>Exposure:</span>
                      <span className={data.flag ? 'market-exposure-flag' : ''}>
                        {(data.exposure * 100).toFixed(1)}%
                      </span>
                    </div>
                    <div className="market-exposure-metric">
                      <span>Cap:</span>
                      <span>{(data.cap * 100).toFixed(0)}%</span>
                    </div>
                    <div style={{ fontSize: '8px', color: 'rgba(255,255,255,0.4)' }}>
                      {data.strategyCount} strategies
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Portfolio Risk Engine V3 */}
          {(portfolioRiskV3.sampleSize > 0 || portfolioRiskV3.grossExposureUsd > 0) && (
            <div className="calib-kpi-block">
              <div className="calib-kpi-block-title">Portfolio Risk Engine V3</div>
              <div className="portfolio-risk-v3-grid">
                <div className="portfolio-risk-v3-card">
                  <div className="portfolio-risk-v3-label">VaR 95%</div>
                  <div className={`portfolio-risk-v3-value${portfolioRiskV3.var95Pct < 0 ? " risk" : ""}`}>
                    {portfolioRiskV3.var95Pct >= 0 ? "+" : ""}{portfolioRiskV3.var95Pct.toFixed(2)}%
                  </div>
                  <div className="portfolio-risk-v3-sub">
                    {portfolioRiskV3.var95Usd >= 0 ? "+" : ""}${portfolioRiskV3.var95Usd.toFixed(0)}
                  </div>
                </div>
                <div className="portfolio-risk-v3-card">
                  <div className="portfolio-risk-v3-label">Expected Shortfall 95%</div>
                  <div className={`portfolio-risk-v3-value${portfolioRiskV3.es95Pct < 0 ? " risk" : ""}`}>
                    {portfolioRiskV3.es95Pct >= 0 ? "+" : ""}{portfolioRiskV3.es95Pct.toFixed(2)}%
                  </div>
                  <div className="portfolio-risk-v3-sub">
                    {portfolioRiskV3.es95Usd >= 0 ? "+" : ""}${portfolioRiskV3.es95Usd.toFixed(0)}
                  </div>
                </div>
                <div className="portfolio-risk-v3-card">
                  <div className="portfolio-risk-v3-label">Live Gross Exposure</div>
                  <div className="portfolio-risk-v3-value">
                    ${portfolioRiskV3.grossExposureUsd.toFixed(0)}
                  </div>
                  <div className="portfolio-risk-v3-sub">
                    Net {portfolioRiskV3.netExposureUsd >= 0 ? "+" : ""}${portfolioRiskV3.netExposureUsd.toFixed(0)}
                  </div>
                </div>
                <div className="portfolio-risk-v3-card">
                  <div className="portfolio-risk-v3-label">Intra-Trade Dynamic Corr</div>
                  <div className={`portfolio-risk-v3-value${portfolioRiskV3.dynamicCorrMax >= 0.7 ? " risk" : portfolioRiskV3.dynamicCorrMax >= 0.5 ? " warn" : ""}`}>
                    {(portfolioRiskV3.dynamicCorrMax * 100).toFixed(0)}%
                  </div>
                  <div className="portfolio-risk-v3-sub">
                    avg {(portfolioRiskV3.dynamicCorrMean * 100).toFixed(0)}% · peers {portfolioRiskV3.dynamicCorrPeers}
                  </div>
                </div>
              </div>
              <div className="portfolio-risk-v3-strip">
                <span>
                  Top live exposure: {portfolioRiskV3.topMarket ? `${portfolioRiskV3.topMarket.market} ${(portfolioRiskV3.topMarket.share * 100).toFixed(0)}%` : "–"}
                </span>
                <span>
                  Sample: {portfolioRiskV3.sampleSize} outcomes
                </span>
                <div className="portfolio-risk-export-group">
                  <button
                    type="button"
                    className="portfolio-risk-export-btn"
                    onClick={() => {
                      downloadJsonFile(
                        `investor-risk-snapshot-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.json`,
                        investorSnapshot,
                      );
                    }}
                  >
                    Export JSON
                  </button>
                  <button
                    type="button"
                    className="portfolio-risk-export-btn"
                    onClick={() => {
                      const rows: Array<Array<string | number>> = [
                        ["generated_at", investorSnapshot.generatedAt],
                        ["var95_pct", portfolioRiskV3.var95Pct.toFixed(4)],
                        ["es95_pct", portfolioRiskV3.es95Pct.toFixed(4)],
                        ["var95_usd", portfolioRiskV3.var95Usd.toFixed(2)],
                        ["es95_usd", portfolioRiskV3.es95Usd.toFixed(2)],
                        ["gross_exposure_usd", portfolioRiskV3.grossExposureUsd.toFixed(2)],
                        ["net_exposure_usd", portfolioRiskV3.netExposureUsd.toFixed(2)],
                        ["top_market", portfolioRiskV3.topMarket?.market || "-"],
                      ];
                      for (const row of portfolioRiskV3.riskByMarket) {
                        rows.push([
                          `market_${row.market}`,
                          `sample=${row.sample};var95_pct=${row.var95Pct.toFixed(4)};es95_pct=${row.es95Pct.toFixed(4)};var95_usd=${row.var95Usd.toFixed(2)};es95_usd=${row.es95Usd.toFixed(2)}`,
                        ]);
                      }
                      downloadCsvFile(
                        `investor-risk-snapshot-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.csv`,
                        [["metric", "value"], ...rows],
                      );
                    }}
                  >
                    Export CSV
                  </button>
                  <button
                    type="button"
                    className="portfolio-risk-export-btn"
                    onClick={() => {
                      openPrintPdfReport("Investor Risk Snapshot", [
                        `Generated at: ${investorSnapshot.generatedAt}`,
                        `VaR95: ${portfolioRiskV3.var95Pct.toFixed(2)}% (${portfolioRiskV3.var95Usd.toFixed(0)} USD)`,
                        `ES95: ${portfolioRiskV3.es95Pct.toFixed(2)}% (${portfolioRiskV3.es95Usd.toFixed(0)} USD)`,
                        `Gross exposure: ${portfolioRiskV3.grossExposureUsd.toFixed(0)} USD`,
                        `Net exposure: ${portfolioRiskV3.netExposureUsd.toFixed(0)} USD`,
                        `Top market: ${portfolioRiskV3.topMarket ? `${portfolioRiskV3.topMarket.market} ${(portfolioRiskV3.topMarket.share * 100).toFixed(0)}%` : "-"}`,
                        `Dynamic corr max: ${(portfolioRiskV3.dynamicCorrMax * 100).toFixed(0)}%`,
                      ]);
                    }}
                  >
                    Export PDF
                  </button>
                </div>
              </div>
              {portfolioRiskV3.riskByMarket.length > 0 && (
                <div className="portfolio-risk-v3-market">
                  <div className="portfolio-risk-v3-market-title">VaR / ES by market</div>
                  <div className="portfolio-risk-v3-market-head">
                    <span>Market</span>
                    <span>Sample</span>
                    <span>VaR95%</span>
                    <span>ES95%</span>
                    <span>VaR95$</span>
                    <span>ES95$</span>
                  </div>
                  {portfolioRiskV3.riskByMarket.map((row) => (
                    <div key={`risk-market-${row.market}`} className="portfolio-risk-v3-market-row">
                      <span>{row.market}</span>
                      <span>{row.sample}</span>
                      <span className={row.var95Pct < 0 ? "warn" : "good"}>{row.var95Pct.toFixed(2)}%</span>
                      <span className={row.es95Pct < 0 ? "warn" : "good"}>{row.es95Pct.toFixed(2)}%</span>
                      <span>{row.var95Usd.toFixed(0)}</span>
                      <span>{row.es95Usd.toFixed(0)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Learning Loop (shadow mode + secure write-back) */}
          {learningLoopShadow.length > 0 && (
            <div className="calib-kpi-block">
              <div className="calib-kpi-block-title">Learning Loop (Shadow Auto-Tuning)</div>
              <div className="learning-loop-shadow-note">
                {AUTO_TUNING_WRITEBACK_ENABLED
                  ? "Secure write-back available (feature-flag gated, backend-audited, server-side signing)."
                  : "Suggestions only. Enable NEXT_PUBLIC_AUTO_TUNING_WRITEBACK=1 to expose write-back controls."}
              </div>
              {AUTO_TUNING_WRITEBACK_ENABLED && (
                <div className="learning-loop-shadow-controls">
                  <input
                    type="password"
                    className="learning-loop-shadow-input"
                    placeholder="admin key (optional)"
                    value={autoTuningAdminKey}
                    onChange={(e) => setAutoTuningAdminKey(e.target.value)}
                  />
                  <label className="learning-loop-shadow-label">
                    min conf
                    <input
                      type="number"
                      step={0.05}
                      min={0}
                      max={1}
                      className="learning-loop-shadow-input small"
                      value={autoTuningMinConfidence}
                      onChange={(e) => setAutoTuningMinConfidence(Math.max(0, Math.min(1, Number(e.target.value) || 0)))}
                    />
                  </label>
                  <label className="learning-loop-shadow-label">
                    max recs
                    <input
                      type="number"
                      step={1}
                      min={1}
                      max={32}
                      className="learning-loop-shadow-input small"
                      value={autoTuningMaxRecommendations}
                      onChange={(e) => setAutoTuningMaxRecommendations(Math.max(1, Math.min(32, Math.round(Number(e.target.value) || 1))))}
                    />
                  </label>
                  <label className="learning-loop-shadow-label">
                    floor%
                    <input
                      type="number"
                      step={0.5}
                      min={0}
                      max={100}
                      className="learning-loop-shadow-input small"
                      value={autoTuningWeightFloorPct}
                      onChange={(e) => setAutoTuningWeightFloorPct(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
                    />
                  </label>
                  <label className="learning-loop-shadow-label">
                    cap%
                    <input
                      type="number"
                      step={0.5}
                      min={0}
                      max={100}
                      className="learning-loop-shadow-input small"
                      value={autoTuningWeightCapPct}
                      onChange={(e) => setAutoTuningWeightCapPct(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
                    />
                  </label>
                  <label className="learning-loop-shadow-check">
                    <input
                      type="checkbox"
                      checked={autoTuningRenormalize}
                      onChange={(e) => setAutoTuningRenormalize(e.target.checked)}
                    />
                    renormalize 100%
                  </label>
                  <label className="learning-loop-shadow-label">
                    idem key
                    <input
                      type="text"
                      className="learning-loop-shadow-input"
                      value={autoTuningIdempotencyKey}
                      onChange={(e) => setAutoTuningIdempotencyKey(e.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    className="learning-loop-shadow-btn"
                    disabled={autoTuningBusy || autoTuningRecommendations.length === 0}
                    onClick={() => {
                      void submitAutoTuningWriteback(true);
                    }}
                  >
                    {autoTuningBusy ? "running..." : "Dry-run write-back"}
                  </button>
                  <button
                    type="button"
                    className="learning-loop-shadow-btn danger"
                    disabled={autoTuningBusy || autoTuningRecommendations.length === 0}
                    onClick={() => {
                      void submitAutoTuningWriteback(false);
                    }}
                  >
                    {autoTuningBusy ? "applying..." : "Apply write-back"}
                  </button>
                  <span className="learning-loop-shadow-status">{autoTuningStatus || ""}</span>
                </div>
              )}
              <div className="learning-loop-shadow-metrics">
                <div className="learning-loop-shadow-audit-title">Shadow-apply metrics (old/new)</div>
                <div className="learning-loop-shadow-metrics-grid">
                  <div className="learning-loop-shadow-metric-card">
                    <span className="learning-loop-shadow-metric-label">Weighted WR</span>
                    <span className="learning-loop-shadow-metric-values">
                      {(shadowApplyMetrics.currentWr * 100).toFixed(1)}% → {(shadowApplyMetrics.shadowWr * 100).toFixed(1)}%
                    </span>
                    <span className={shadowApplyMetrics.deltaWr >= 0 ? "good" : "warn"}>
                      {shadowApplyMetrics.deltaWr >= 0 ? "+" : ""}{(shadowApplyMetrics.deltaWr * 100).toFixed(2)}%
                    </span>
                  </div>
                  <div className="learning-loop-shadow-metric-card">
                    <span className="learning-loop-shadow-metric-label">Weighted PnL/trade</span>
                    <span className="learning-loop-shadow-metric-values">
                      {shadowApplyMetrics.currentPnl.toFixed(1)} → {shadowApplyMetrics.shadowPnl.toFixed(1)}
                    </span>
                    <span className={shadowApplyMetrics.deltaPnl >= 0 ? "good" : "warn"}>
                      {shadowApplyMetrics.deltaPnl >= 0 ? "+" : ""}{shadowApplyMetrics.deltaPnl.toFixed(2)}
                    </span>
                  </div>
                  <div className="learning-loop-shadow-metric-card">
                    <span className="learning-loop-shadow-metric-label">Concentration (HHI)</span>
                    <span className="learning-loop-shadow-metric-values">
                      {shadowApplyMetrics.currentHhi.toFixed(3)} → {shadowApplyMetrics.shadowHhi.toFixed(3)}
                    </span>
                    <span className={shadowApplyMetrics.deltaHhi <= 0 ? "good" : "warn"}>
                      {shadowApplyMetrics.deltaHhi >= 0 ? "+" : ""}{shadowApplyMetrics.deltaHhi.toFixed(4)}
                    </span>
                  </div>
                </div>
              </div>
              {rollbackGuardSession && (
                <div className="learning-loop-rollback-guard">
                  <div className="learning-loop-shadow-audit-title">Rollback guard automatique</div>
                  <div className="learning-loop-rollback-status">
                    <span>session {rollbackGuardSession.id.slice(0, 12)}</span>
                    <span>persisted backend</span>
                    <span>{rollbackGuardHistory.length} snapshots</span>
                    <span>started {formatClock(rollbackGuardSession.startedAtIso)}</span>
                  </div>
                  <div className="learning-loop-rollback-controls">
                    <label className="learning-loop-shadow-label">
                      window min
                      <input
                        type="number"
                        min={10}
                        max={480}
                        className="learning-loop-shadow-input small"
                        value={rollbackGuardWindowMin}
                        onChange={(e) => setRollbackGuardWindowMin(Math.max(10, Math.min(480, Math.round(Number(e.target.value) || 10))))}
                      />
                    </label>
                    <label className="learning-loop-shadow-label">
                      health drop
                      <input
                        type="number"
                        step={0.01}
                        min={0.01}
                        max={0.5}
                        className="learning-loop-shadow-input small"
                        value={rollbackGuardHealthDrop}
                        onChange={(e) => setRollbackGuardHealthDrop(Math.max(0.01, Math.min(0.5, Number(e.target.value) || 0.01)))}
                      />
                    </label>
                    <label className="learning-loop-shadow-label">
                      brier rise
                      <input
                        type="number"
                        step={0.005}
                        min={0.005}
                        max={0.2}
                        className="learning-loop-shadow-input small"
                        value={rollbackGuardBrierRise}
                        onChange={(e) => setRollbackGuardBrierRise(Math.max(0.005, Math.min(0.2, Number(e.target.value) || 0.005)))}
                      />
                    </label>
                    <span className="learning-loop-shadow-status">
                      {rollbackGuard.active
                        ? `monitoring ${rollbackGuard.remainingMin.toFixed(0)}m left`
                        : `window closed (${rollbackGuard.elapsedMin.toFixed(0)}m elapsed)`}
                    </span>
                    <button
                      type="button"
                      className="learning-loop-shadow-btn"
                      disabled={autoTuningBusy}
                      onClick={() => {
                        void fetch("/api/strategies/auto-tuning/rollback-guard", {
                          method: "POST",
                          headers: {
                            "Content-Type": "application/json",
                            ...(autoTuningAdminKey.trim() ? { "x-auto-tuning-admin-key": autoTuningAdminKey.trim() } : {}),
                          },
                          body: JSON.stringify({ action: "close", reason: "manual-close-ui" }),
                        }).then(() => {
                          void refreshRollbackGuardState();
                        });
                      }}
                    >
                      Close guard session
                    </button>
                  </div>
                  <div className="learning-loop-rollback-status">
                    <span>Health drop: {rollbackGuard.healthDrop.toFixed(3)}</span>
                    <span>Brier rise: {rollbackGuard.brierRise.toFixed(3)}</span>
                    <span className={rollbackGuard.shouldProposeRollback ? "warn" : "good"}>
                      {rollbackGuard.shouldProposeRollback ? "rollback proposed" : "no rollback trigger"}
                    </span>
                  </div>
                  {rollbackGuard.shouldProposeRollback && (
                    <div className="learning-loop-rollback-actions">
                      <button
                        type="button"
                        className="learning-loop-shadow-btn"
                        disabled={autoTuningBusy || rollbackProposalRecommendations.length === 0}
                        onClick={() => {
                          void submitAutoTuningWriteback(
                            true,
                            rollbackProposalRecommendations,
                            "rollback-guard proposal",
                          );
                        }}
                      >
                        Propose rollback (dry-run)
                      </button>
                      <button
                        type="button"
                        className="learning-loop-shadow-btn danger"
                        disabled={autoTuningBusy || rollbackProposalRecommendations.length === 0}
                        onClick={() => {
                          void submitAutoTuningWriteback(
                            false,
                            rollbackProposalRecommendations,
                            "rollback-guard apply",
                          );
                        }}
                      >
                        Apply rollback
                      </button>
                    </div>
                  )}
                </div>
              )}
              {autoTuningDiffPreview.length > 0 && (
                <div className="learning-loop-shadow-diff">
                  <div className="learning-loop-shadow-audit-title">Write-back diff preview</div>
                  {autoTuningDiffPreview.map((row) => (
                    <div key={`ll-diff-${row.strategyId}`} className="learning-loop-shadow-diff-row">
                      <span className="learning-loop-shadow-strat">{row.strategyId.slice(0, 10)}</span>
                      <span>{row.fromPct.toFixed(1)}%</span>
                      <span>→</span>
                      <span>{row.toPct.toFixed(1)}%</span>
                      <span className={row.deltaPct >= 0 ? "good" : "warn"}>
                        {row.deltaPct >= 0 ? "+" : ""}{row.deltaPct.toFixed(1)}%
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {AUTO_TUNING_WRITEBACK_ENABLED && autoTuningAuditTrail.length > 0 && (
                <div className="learning-loop-shadow-audit">
                  <div className="learning-loop-shadow-audit-title">Auto-tuning audit trail</div>
                  {autoTuningAuditTrail.slice(0, 6).map((evt) => (
                    <div key={evt.id} className="learning-loop-shadow-audit-row">
                      <span>{formatClock(evt.timestampIso)}</span>
                      <span>{evt.dryRun ? "DRY" : "APPLY"}</span>
                      <span className={evt.status === "accepted" ? "good" : "warn"}>{evt.status}</span>
                      <span>{evt.recommendationCount} recs</span>
                      <span title={evt.summary}>{evt.summary}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="learning-loop-shadow-table">
                <div className="learning-loop-shadow-head">
                  <span>Strategy</span>
                  <span>WR</span>
                  <span>Target</span>
                  <span>Delta</span>
                  <span>Action</span>
                </div>
                {learningLoopShadow.map((row) => (
                  <div key={`ll-shadow-${row.id}`} className="learning-loop-shadow-row">
                    <span className="learning-loop-shadow-strat">{row.id.slice(0, 10)}</span>
                    <span>{(row.wr * 100).toFixed(0)}%</span>
                    <span>{row.targetWeightPct.toFixed(1)}%</span>
                    <span className={row.deltaVsEqualPct >= 0 ? "good" : "warn"}>
                      {row.deltaVsEqualPct >= 0 ? "+" : ""}{row.deltaVsEqualPct.toFixed(1)}%
                    </span>
                    <span className={
                      row.recommendation === "increase" ? "good"
                      : row.recommendation === "decrease" ? "warn"
                      : "subtle"
                    }>
                      {row.recommendation}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Correlation Panel Allocation Impact */}
          {corrPenalty > 0 && (
            <div className="calib-kpi-block">
              <div className="calib-kpi-block-title">Correlation Impact on Allocation</div>
              <div className="alloc-explain-factors">
                <div className="alloc-explain-factor-row">
                  <span className="alloc-explain-factor-label">Corr Penalty:</span>
                  <span className="alloc-explain-factor-value penalty">
                    <span className="alloc-corr-penalty-display">
                      −{(corrPenalty * 100).toFixed(1)}%
                    </span>
                  </span>
                </div>
                <div style={{ fontSize: '8px', color: 'rgba(255,255,255,0.4)', lineHeight: 1.3 }}>
                  Strategy is correlated (&gt;0.7) with {
                    Object.keys(strategyCorrelationMatrix[allocActiveStratId] || {})
                      .filter(otherId => {
                        const data = strategyCorrelationMatrix[allocActiveStratId]?.[otherId];
                        return data && Math.abs(data.corr) > 0.7;
                      }).length
                  } other strategy{Object.keys(strategyCorrelationMatrix[allocActiveStratId] || {}).filter(otherId => {const data = strategyCorrelationMatrix[allocActiveStratId]?.[otherId]; return data && Math.abs(data.corr) > 0.7;}).length !== 1 ? 'ies' : ''}.
                </div>
              </div>
            </div>
          )}
        </section>
      )}

      {/* ── CALIBRATION KPI PANEL ─────────────────────────────────────────────── */}
      {showCalibrationDeck && filteredOutcomes.length > 0 && (
        <section className="kpi-calib-panel">
          <div className="kpi-calib-title">📊 Calibration KPI</div>
          
          {/* ── BRIER SCORE BLOCK ─────────────────────────────────────────────── */}
          {brierAnalysis.overall.brierScore !== null && (
            <div className="calib-kpi-block">
              <div className="calib-kpi-block-title">Brier Score (overall)</div>
              <div className="brier-score-container">
                <div
                  className={`brier-score-display${
                    brierAnalysis.overall.brierScore < 0.2 ? ""
                    : brierAnalysis.overall.brierScore < 0.3 ? " overfit"
                    : " poor"
                  }`}
                >
                  {(brierAnalysis.overall.brierScore * 100).toFixed(1)}
                </div>
                <div className="brier-score-info">
                  <div className="brier-score-info-label">
                    {brierAnalysis.overall.brierScore < 0.2 ? "Excellent"
                    : brierAnalysis.overall.brierScore < 0.3 ? "Good"
                    : brierAnalysis.overall.brierScore < 0.35 ? "Fair"
                    : "Poor"}
                  </div>
                  <div className="brier-score-info-value">
                    Overconfidence: {(brierAnalysis.overall.overconfidence * 100).toFixed(1)}%
                  </div>
                  <div className="brier-score-info-value" style={{ fontSize: "9px" }}>
                    {filteredOutcomes.length} trades analyzed
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ── REGIME-SPECIFIC BRIER SCORES ──────────────────────────────────── */}
          {Object.keys(brierAnalysis.byRegime).length > 1 && (
            <div className="calib-kpi-block">
              <div className="calib-kpi-block-title">Brier Score by Regime</div>
              <div className="regime-buckets-container">
                {Object.entries(brierAnalysis.byRegime).map(([regime, data]) => (
                  <div key={regime} className="regime-bucket-card">
                    <div className="regime-bucket-label">{regime}</div>
                    {data.brierScore !== null ? (
                      <>
                        <div className="regime-bucket-metric">
                          <span>Brier:</span>
                          <span className="regime-bucket-metric-value">
                            {(data.brierScore * 100).toFixed(1)}
                          </span>
                        </div>
                        <div className="regime-bucket-metric">
                          <span>Overconf:</span>
                          <span className="regime-bucket-metric-value" style={{ color: data.overconfidence > 0.05 ? "#ffd600" : "#6ee7a7" }}>
                            {(data.overconfidence * 100).toFixed(1)}%
                          </span>
                        </div>
                      </>
                    ) : (
                      <div style={{ color: "rgba(255,255,255,0.3)", fontSize: "9px" }}>–</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── CALIBRATION ERROR BY CONFIDENCE BUCKET ────────────────────────── */}
          {calibrationErrorBuckets.length > 0 && (
            <div className="calib-kpi-block">
              <div className="calib-kpi-block-title">Calibration Error by Confidence Range</div>
              <table className="calib-error-table">
                <thead>
                  <tr>
                    <th style={{ width: "30%" }}>Range</th>
                    <th style={{ width: "20%" }}>Expected</th>
                    <th style={{ width: "20%" }}>Actual</th>
                    <th style={{ width: "30%" }}>Error</th>
                  </tr>
                </thead>
                <tbody>
                  {calibrationErrorBuckets.map((bucket) => (
                    <tr key={bucket.rangeLabel}>
                      <td className="calib-error-bucket-label">{bucket.rangeLabel}</td>
                      <td className="calib-error-expected">{bucket.expectedWR}%</td>
                      <td className="calib-error-actual">{bucket.actualWR}%</td>
                      <td className={`calib-error-delta${bucket.isOverconfident ? " overconfident" : bucket.isUnderconfident ? " underconfident" : ""}`}>
                        {bucket.calibError > 0 ? "+" : ""}{bucket.calibError}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ marginTop: 6, fontSize: "9px", color: "rgba(255,255,255,0.5)" }}>
                📌 Positive = overconfident (predicted too high), Negative = underconfident
              </div>
            </div>
          )}
        </section>
      )}

      {/* ═══════════════ FLOATING PANELS OVERLAY ════════════════════════════ */}
      {floatingPanels.map((fp) => (
        <div
          key={`float-${fp.id}`}
          className="floating-panel-window"
          style={{ left: fp.x, top: fp.y, width: fp.w, height: fp.h }}
        >
          <div
            className="floating-panel-titlebar"
            onMouseDown={(e) => {
              e.preventDefault();
              floatingDragRef.current = { id: fp.id, startX: e.clientX, startY: e.clientY, origX: fp.x, origY: fp.y };
            }}
          >
            <span className="floating-panel-title">{fp.id.toUpperCase()}</span>
            <span className="floating-panel-zone-badge">{fp.fromZone}</span>
            <div className="floating-panel-actions">
              <button
                type="button"
                className="floating-panel-resize-btn"
                title="Agrandir"
                onClick={() =>
                  setFloatingPanels((prev) =>
                    prev.map((f) => f.id === fp.id ? { ...f, w: Math.min(f.w + 80, 900), h: Math.min(f.h + 60, 700) } : f),
                  )
                }
              >□+</button>
              <button
                type="button"
                className="floating-panel-dock-btn"
                title={`Redocker dans ${fp.fromZone}`}
                onClick={() => dockPanel(fp.id)}
              >⤢ Dock</button>
              <button
                type="button"
                className="floating-panel-close-btn"
                title="Fermer la fenêtre et redocker"
                onClick={() => dockPanel(fp.id)}
              >✕</button>
            </div>
          </div>
          <div className="floating-panel-body">
            {renderDockPanelContent(fp.id)}
          </div>
          <div
            className="floating-panel-resize-handle"
            onMouseDown={(e) => {
              e.stopPropagation();
              const startW = fp.w;
              const startH = fp.h;
              const startX = e.clientX;
              const startY = e.clientY;
              const onMove = (ev: MouseEvent) => {
                setFloatingPanels((prev) =>
                  prev.map((f) =>
                    f.id === fp.id
                      ? clampFloatingPanel({ ...f, w: startW + ev.clientX - startX, h: startH + ev.clientY - startY })
                      : f,
                  ),
                );
              };
              const onUp = () => {
                window.removeEventListener("mousemove", onMove);
                window.removeEventListener("mouseup", onUp);
              };
              window.addEventListener("mousemove", onMove);
              window.addEventListener("mouseup", onUp);
            }}
          />
        </div>
      ))}
      {detachedChartSidecars.map((panel) => (
        <div
          key={`chart-sidecar-float-${panel.id}`}
          className="floating-panel-window chart-sidecar-floating-window"
          style={{ left: panel.x, top: panel.y, width: panel.w, height: panel.h }}
        >
          <div
            className="floating-panel-titlebar"
            onMouseDown={(event) => {
              event.preventDefault();
              chartSidecarDragRef.current = { id: panel.id, startX: event.clientX, startY: event.clientY, origX: panel.x, origY: panel.y };
            }}
          >
            <span className="floating-panel-title">{panel.id.toUpperCase()}</span>
            <span className="floating-panel-zone-badge">chart sidecar</span>
            <div className="floating-panel-actions">
              <button
                type="button"
                className="floating-panel-resize-btn"
                title="Agrandir"
                onClick={() => setDetachedChartSidecars((current) => current.map((entry) => (
                  entry.id === panel.id
                    ? clampDetachedChartSidecar({ ...entry, w: Math.min(entry.w + 72, 920), h: Math.min(entry.h + 52, 720) })
                    : entry
                )))}
              >□+</button>
              <button type="button" className="floating-panel-dock-btn" title="Redocker" onClick={() => dockChartSidecar(panel.id)}>⤢ Dock</button>
              <button type="button" className="floating-panel-close-btn" title="Fermer la fenêtre et redocker" onClick={() => dockChartSidecar(panel.id)}>✕</button>
            </div>
          </div>
          <div className="floating-panel-body">
            {renderChartSidecarCard(panel.id, true)}
          </div>
          <div
            className="floating-panel-resize-handle"
            onMouseDown={(event) => {
              event.stopPropagation();
              const startW = panel.w;
              const startH = panel.h;
              const startX = event.clientX;
              const startY = event.clientY;
              const onMove = (moveEvent: MouseEvent) => {
                setDetachedChartSidecars((current) => current.map((entry) => (
                  entry.id === panel.id
                    ? clampDetachedChartSidecar({ ...entry, w: startW + moveEvent.clientX - startX, h: startH + moveEvent.clientY - startY })
                    : entry
                )));
              };
              const onUp = () => {
                window.removeEventListener("mousemove", onMove);
                window.removeEventListener("mouseup", onUp);
              };
              window.addEventListener("mousemove", onMove);
              window.addEventListener("mouseup", onUp);
            }}
          />
        </div>
      ))}
    </main>
  );
}

function parseGpuViewportGrid(value: string | null): 1 | 4 | 16 | "auto" | null {
  if (value === "auto") {
    return "auto";
  }
  if (value === "1") {
    return 1;
  }
  if (value === "4") {
    return 4;
  }
  if (value === "16") {
    return 16;
  }
  return null;
}

function parseChartSmoothingMs(value: string | null): 0 | 80 | 140 | 220 | null {
  if (value === "off" || value === "0") {
    return 0;
  }
  if (value === "80") {
    return 80;
  }
  if (value === "140") {
    return 140;
  }
  if (value === "220") {
    return 220;
  }
  return null;
}
