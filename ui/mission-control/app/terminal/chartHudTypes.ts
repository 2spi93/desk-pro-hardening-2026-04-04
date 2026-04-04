import type { RefObject } from "react";

import type { ChartReleaseSendMode, ChartSnapPriority, UiMode } from "../../lib/userUiPrefs";

export type SignalDirection = "buy" | "sell" | "neutral";
export type SignalSeverity = "info" | "warn" | "critical";
export type EvidenceKey = "dom" | "footprint" | "liquidity" | "price-action";
export type AutoExecutionMode = "assisted" | "semi-auto" | "full-auto";
export type ExecutionAdaptMode = "auto" | "confirm" | "manual";
export type LearningRegimeFilter = "all" | "trend" | "chop" | "volatile";
export type LearningScenarioFilter = "all" | "reversal" | "continuation" | "balance";
export type ChartOrderPreset = "scalp" | "swing" | "low-risk" | "custom";

export type MarketSignalEventShape = {
  id: string;
  label: string;
  detail: string;
  direction: SignalDirection;
  severity: SignalSeverity;
};

export type MarketSignalSnapshotShape = {
  buyPressurePct: number;
  sellPressurePct: number;
  directionalLongPct: number;
  directionalShortPct: number;
  directionalConfidenceLabel: string;
  dominantDirection: SignalDirection;
  headline: string;
  convictionLabel: string;
  signals: MarketSignalEventShape[];
};

export type MarketConfluenceWeightsShape = {
  dom: number;
  footprint: number;
  liquidity: number;
  "price-action": number;
};

export type MarketEvidenceShape = {
  id: EvidenceKey;
  label: string;
  scorePct: number;
  direction: SignalDirection;
  detail: string;
};

export type MarketDecisionShape = {
  scenarioLabel: string;
  scenarioProbabilityPct: number;
  globalConfidencePct: number;
  confluenceScorePct: number;
  probableReversalZoneLabel: string;
  criticalConfirmed: boolean;
  biasDirection: SignalDirection;
  actionTitle: string;
  actionBody: string;
  evidence: MarketEvidenceShape[];
  historicalLearning: {
    scopeLabel: string;
    sampleSize: number;
    winratePct: number;
    learnedWeights: MarketConfluenceWeightsShape;
  };
};

export type ExecutionBrainStatusShape = {
  status: string;
  detail: string;
  tone: string;
  confidence: number;
};

export type ExecutionBrainTrailingShape = {
  status: string;
  detail: string;
  tone: string;
};

export type AutoExecutionGateShape = {
  autoState: string;
  riskLabel: string;
  sizeLabel: string;
  ruleLabel: string;
};

export type AutoRiskEngineShape = {
  hardPass: boolean;
  maxOpenTrades: number;
  maxExposurePct: number;
  maxDailyLossPct: number;
};

export type AutoSessionGuardShape = {
  pass: boolean;
  label: string;
};

export type AutoSymbolLossShape = {
  normalizedSymbol: string;
  pass: boolean;
  cumulativeLossUsd: number;
};

export type AutoExecutionAuditEntryShape = {
  id: string;
  timestampIso: string;
  gateState: string;
  mode: string;
  sizeUsd: number;
  reasons: string[];
};

export type SelfLearningDriftShape = {
  shouldDemote: boolean;
  enoughSamples: boolean;
  longWinratePct: number;
  shortWinratePct: number;
  winrateDropPct: number;
  longBrier: number | null;
  shortBrier: number | null;
  brierRise: number;
};

export type SelfLearningPersistenceStatusShape = {
  scopeCount: number;
  stateLoadedAt: string | null;
  stateSavedAt: string | null;
  scopesLoadedAt: string | null;
  message: string;
};

export type SelfLearningProfileShape = {
  sampleSize: number;
  winratePct: number;
};

export type SelfLearningAdaptiveWeightsShape = {
  dom: number;
  footprint: number;
  liquidity: number;
  "price-action": number;
};

export type SelfLearningJournalEntryShape = {
  id: string;
  timestampIso: string;
  regime: string;
  scenario: string;
  outcome: string;
  pnl: number;
};

export type PendingExecutionAdaptationShape = {
  plan: {
    snapPriority: string;
    preset: string;
    guardEnabled: boolean;
  };
};

export type ChartOrderTicketShape = {
  side: "buy" | "sell";
  preset: ChartOrderPreset;
  entry: number;
  sl: number;
  tp: number;
  oco: boolean;
};

export type ChartSnapStateShape = { label: string; price: number } | null;

export type ChartSendHistoryEntryShape = {
  atIso: string;
  symbol: string;
  side: "buy" | "sell";
  rr: number;
  compliant: boolean;
  source?: "local" | "backend";
  outcome: "submitted" | "blocked-loss" | "confirmation-required";
};

export type ChartHudSignalDecisionPanelProps = {
  signalDisplayMode: string;
  marketSignal: MarketSignalSnapshotShape;
  perceptionMotionClass: string;
  perceptionSetupReady: boolean;
  perceptionCoreLabel: string;
  perceptionReasonCode: string | null;
  showReasonLegend: boolean;
  onToggleShowReasonLegend: () => void;
  perceptionReasonLegend?: { line1?: string; line2?: string } | null;
  perceptionTargetLabel: string;
  perceptionActionLabel: string;
  signalConfidenceDrift: "UP" | "FLAT" | "DOWN";
  marketDecision: MarketDecisionShape;
  showConfluenceTune: boolean;
  onToggleShowConfluenceTune: () => void;
  showDecisionSecondary: boolean;
  onToggleShowDecisionSecondary: () => void;
  confluenceWeights: MarketConfluenceWeightsShape;
  onChangeConfluenceWeight: (key: EvidenceKey, next: number) => void;
  decisionSecondaryRef: RefObject<HTMLDivElement | null>;
  entryTimingV3: ExecutionBrainStatusShape;
  tradeManagementV3: ExecutionBrainStatusShape;
  intelligentExitV3: ExecutionBrainStatusShape;
  trailingV3: ExecutionBrainTrailingShape;
  confidencePillTone: (value: number) => string;
  autoExecutionMode: AutoExecutionMode;
  onSetAutoExecutionMode: (mode: AutoExecutionMode) => void;
  autoExecutionKillSwitch: boolean;
  onToggleAutoExecutionKillSwitch: () => void;
  autoSessionGuardEnabled: boolean;
  onToggleAutoSessionGuardEnabled: () => void;
  autoSessionStartHour: number;
  onSetAutoSessionStartHour: (value: number) => void;
  autoSessionEndHour: number;
  onSetAutoSessionEndHour: (value: number) => void;
  autoSymbolLossCapUsd: number;
  onSetAutoSymbolLossCapUsd: (value: number) => void;
  autoSymbolLoss: AutoSymbolLossShape;
  onResetAutoSymbolLoss: () => void;
  autoExecutionGate: AutoExecutionGateShape;
  autoMetaPass: boolean;
  autoRiskEngine: AutoRiskEngineShape;
  openTradesCount: number;
  exposureRatio: number;
  dailyDrawdownPct: number;
  autoSessionGuard: AutoSessionGuardShape;
  filteredAutoExecutionAuditTrail: AutoExecutionAuditEntryShape[];
  autoExecutionAuditTrailLength: number;
  autoExecutionAuditStateFilter: "all" | "READY" | "BLOCKED" | "KILLED";
  onSetAutoExecutionAuditStateFilter: (value: "all" | "READY" | "BLOCKED" | "KILLED") => void;
  autoExecutionAuditReasonSearch: string;
  onSetAutoExecutionAuditReasonSearch: (value: string) => void;
  onExportAutoExecutionAuditJson: () => void;
  onExportAutoExecutionAuditCsv: () => void;
  onClearAutoExecutionAuditTrail: () => void;
  formatClock: (value: string) => string;
  selfLearningV4Enabled: boolean;
  onToggleSelfLearningV4Enabled: () => void;
  selfLearningAutoAdaptEnabled: boolean;
  onToggleSelfLearningAutoAdaptEnabled: () => void;
  selfLearningDriftV4: SelfLearningDriftShape;
  selfLearningV4DriftLabel: string;
  filteredSelfLearningJournalV4Trail: SelfLearningJournalEntryShape[];
  selfLearningJournalV4TrailLength: number;
  onExportSelfLearningJournalV4Json: () => void;
  onExportSelfLearningJournalV4Csv: () => void;
  onClearSelfLearningJournalV4Trail: () => void;
  selfLearningJournalV4RegimeFilter: LearningRegimeFilter;
  onSetSelfLearningJournalV4RegimeFilter: (value: LearningRegimeFilter) => void;
  selfLearningJournalV4ScenarioFilter: LearningScenarioFilter;
  onSetSelfLearningJournalV4ScenarioFilter: (value: LearningScenarioFilter) => void;
  selfLearningV4Active: boolean;
  selfLearningStorageTone: string;
  selfLearningStorageLabel: string;
  selfLearningV4PersistenceStatus: SelfLearningPersistenceStatusShape;
  selfLearningCurrentScopeCount: number;
  selfLearningRegimeV4: string;
  selfLearningV4WeightsLabel: string;
  selfLearningV4ModelLabel: string;
  selfLearningProfile: SelfLearningProfileShape;
  selfLearningModelUpdatedAt: string | null;
  selfLearningDriftAutoDemotedAt: string | null;
  selfLearningAdaptiveWeights: SelfLearningAdaptiveWeightsShape;
  brainAttributionHeadline: string;
  brainAttributionPills: string[];
  brainLearningRatePills: string[];
  executionAdaptMode: ExecutionAdaptMode;
  onSetExecutionAdaptMode: (mode: ExecutionAdaptMode) => void;
  pendingExecutionAdaptation: PendingExecutionAdaptationShape | null;
  onApplyPendingExecutionAdaptation: () => void;
};

export type ChartHudOrderRiskPanelProps = {
  chartOrderTicket: ChartOrderTicketShape;
  onApplyChartOrderPreset: (preset: ChartOrderPreset, side?: "buy" | "sell") => void;
  onToggleChartOrderOco: () => void;
  chartSnapEnabled: boolean;
  onToggleChartSnapEnabled: () => void;
  chartSnapPriority: ChartSnapPriority;
  onSetChartSnapPriority: (priority: ChartSnapPriority) => void;
  chartRiskUsd: number;
  chartRewardUsd: number;
  chartRiskReward: number;
  chartMaxLossUsd: number;
  onSetChartMaxLossUsd: (value: number) => void;
  chartTargetGainUsd: number;
  onSetChartTargetGainUsd: (value: number) => void;
  chartRiskGuardEnabled: boolean;
  onToggleChartRiskGuardEnabled: () => void;
  uiMode: UiMode;
  onApplySafeRiskPreset: () => void;
  onApplyBalancedRiskPreset: () => void;
  onApplyDeskRiskPreset: () => void;
  chartRiskLossExceeded: boolean;
  chartRiskTargetMiss: boolean;
  chartRiskTargetRr: number;
  chartPriceStep: number;
  chartPriceDigits: number;
  chartSnapEnabledLabel: string;
  chartSnapState: ChartSnapStateShape;
  chartOrderTicketEntryLabel: string;
  chartOrderTicketSlLabel: string;
  chartOrderTicketTpLabel: string;
  chartEffectiveSendMode: ChartReleaseSendMode;
  chartHudConfirmArmed: boolean;
  onToggleChartHudConfirmArmed: () => void;
  onSubmitChartOrder: () => void;
  mergedChartSendHistory: ChartSendHistoryEntryShape[];
  formatClock: (value: string) => string;
};