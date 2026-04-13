export type TradeQuality =
  | "GOOD_EXECUTION"
  | "BAD_EXECUTION"
  | "GOOD_NO_TRADE"
  | "MISSED_OPPORTUNITY"
  | "MODEL_ERROR"
  | "MARKET_NOISE";

export type FeedbackErrorKind = "prediction" | "fill" | "slippage" | "decision" | "behavior" | "overfit";
export type FeedbackSeverity = "low" | "medium" | "high";
export type FeedbackModelHealth = "HEALTHY" | "ADAPTING" | "DEGRADING" | "BROKEN";
export type FeedbackDriftState = "CALM" | "WATCH" | "DRIFT" | "LOCK";
export type FeedbackLearningState = "ACTIVE" | "REDUCED" | "FROZEN";
export type FeedbackCalibrationTarget = "confidence_threshold" | "limit_usage" | "market_bias" | "no_trade_sensitivity" | "sizing_multiplier";

export type FeedbackError = {
  kind: FeedbackErrorKind;
  score: number;
  severity: FeedbackSeverity;
  label: string;
  detail: string;
};

export type FeedbackWindow = {
  key: "instant" | "session" | "weekly" | "monthly";
  label: string;
  sampleSize: number;
  scorePct: number;
  summary: string;
};

export type FeedbackCalibrationAction = {
  target: FeedbackCalibrationTarget;
  direction: "increase" | "decrease";
  magnitudePct: number;
  reason: string;
};

export type FeedbackShieldSummary = {
  learningState: FeedbackLearningState;
  freezeLearning: boolean;
  explorationMode: "minimal" | "frozen";
  multiRegimeValidation: "PASS" | "REVIEW" | "REJECT";
  rollingRealityRatio: number;
  contextCompression: "normal" | "compressed";
  reasons: string[];
};

export type FeedbackRewardBreakdown = {
  rawScore: number;
  scorePct: number;
  normalizedPnl: number;
  fillEfficiency: number;
  slippageQuality: number;
  decisionQuality: number;
  riskPenalty: number;
  behaviorScore: number;
  regimeBonus: number;
  regimeBiasLabel: string;
};

export type FeedbackSummary = {
  tradeCount: number;
  tradeQualityCounts: Record<TradeQuality, number>;
  dominantTradeQuality: TradeQuality;
  modelHealth: FeedbackModelHealth;
  driftState: FeedbackDriftState;
  errors: FeedbackError[];
  reward: FeedbackRewardBreakdown;
  shield: FeedbackShieldSummary;
  calibrationActions: FeedbackCalibrationAction[];
  windows: FeedbackWindow[];
  recommendations: string[];
  protections: string[];
  reduceSize: boolean;
  forceNoTrade: boolean;
  learningDisabled: boolean;
  maxAdjustmentPerDayPct: number;
};

type JournalEntry = Record<string, unknown>;
type JsonRow = Record<string, unknown>;

const TRADE_QUALITIES: TradeQuality[] = [
  "GOOD_EXECUTION",
  "BAD_EXECUTION",
  "GOOD_NO_TRADE",
  "MISSED_OPPORTUNITY",
  "MODEL_ERROR",
  "MARKET_NOISE",
];

const MAX_ADJUSTMENT_PER_DAY_PCT = 5;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function safeNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function safeRecord(value: unknown): JsonRow {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRow) : {};
}

function safeRows(value: unknown): JsonRow[] {
  return Array.isArray(value)
    ? value.filter((item): item is JsonRow => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function safeTextArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
}

function normalizeKey(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

function toneForScore(score: number): FeedbackSeverity {
  if (score >= 0.66) {
    return "high";
  }
  if (score >= 0.33) {
    return "medium";
  }
  return "low";
}

function countJournal(entries: JournalEntry[], actions: Set<string>, hours: number, nowMs: number): number {
  const windowMs = hours * 60 * 60 * 1000;
  return entries.filter((entry) => {
    if (!actions.has(normalizeKey(entry.action))) {
      return false;
    }
    const createdAt = Date.parse(String(entry.createdAtIso || entry.created_at || ""));
    return Number.isFinite(createdAt) && nowMs - createdAt <= windowMs;
  }).length;
}

function classifyTradeQuality(trade: JsonRow, badModelFlags: Set<string>): TradeQuality {
  const netResultUsd = safeNumber(trade.net_result_usd, 0);
  const confidence = safeNumber(trade.confidence, safeNumber(trade.score_pre_trade, 0));
  const latencyMs = safeNumber(trade.latency_ms, 0);
  const slippageBps = Math.abs(safeNumber(trade.slippage_real_bps, safeNumber(trade.expected_slippage_bps, 0)));
  const status = normalizeKey(trade.status);
  const decisionId = String(trade.decision_id || "").trim();
  const noTradeState = normalizeKey(trade.no_trade_state);
  const noTradeDominance = Boolean(trade.no_trade_dominance) || (noTradeState && noTradeState !== "eligible");
  const dominantReasons = safeTextArray(trade.dominant_reasons);
  const lowConviction = confidence > 0 && confidence < 0.55;
  const fragileExecution = latencyMs > 150 || slippageBps > 4 || /partial|cancel|reject|timeout|error/.test(status);

  if (noTradeDominance) {
    if (netResultUsd > 0 && confidence >= 0.55) {
      return "MISSED_OPPORTUNITY";
    }
    return "GOOD_NO_TRADE";
  }

  if (badModelFlags.has(decisionId) || (netResultUsd < 0 && confidence >= 0.7)) {
    return "MODEL_ERROR";
  }

  if (fragileExecution) {
    return "BAD_EXECUTION";
  }

  if ((Math.abs(netResultUsd) <= 0.25 && lowConviction) || (dominantReasons.length === 0 && lowConviction)) {
    return "MARKET_NOISE";
  }

  return netResultUsd >= 0 ? "GOOD_EXECUTION" : "BAD_EXECUTION";
}

function buildTradeQualityCounts(trades: JsonRow[], badModelFlags: Set<string>): {
  counts: Record<TradeQuality, number>;
  dominantTradeQuality: TradeQuality;
} {
  const counts = Object.fromEntries(TRADE_QUALITIES.map((quality) => [quality, 0])) as Record<TradeQuality, number>;
  for (const trade of trades) {
    const quality = classifyTradeQuality(trade, badModelFlags);
    counts[quality] += 1;
  }
  const dominantTradeQuality = TRADE_QUALITIES
    .slice()
    .sort((left, right) => counts[right] - counts[left] || left.localeCompare(right))[0];
  return { counts, dominantTradeQuality };
}

function buildRewardBreakdown(input: {
  summary: JsonRow;
  liveOps: JsonRow;
  tradeQualityCounts: Record<TradeQuality, number>;
  byRegime: JsonRow[];
}): FeedbackRewardBreakdown {
  const tradeCount = Math.max(1, safeNumber(input.summary.trade_count, 0));
  const avgPnlUsd = safeNumber(input.summary.avg_pnl_usd, safeNumber(input.summary.net_pnl_usd, 0) / tradeCount);
  const avgLatencyMs = safeNumber(input.summary.avg_latency_ms, 0);
  const avgSlippageBps = Math.abs(safeNumber(input.summary.avg_slippage_bps, 0));
  const highConfidenceLossCount = safeNumber(input.summary.high_confidence_loss_count, 0);
  const noTradeCount = safeNumber(input.summary.no_trade_dominance_count, 0);
  const drawdownPct = safeNumber(safeRecord(input.liveOps.risk_snapshot).dd_pct, 0);
  const normalizedPnl = clamp(avgPnlUsd / 5, -1, 1);
  const fillEfficiency = clamp(1 - avgLatencyMs / 220, 0, 1);
  const slippageQuality = clamp(1 - avgSlippageBps / 5, 0, 1);
  const decisionPenalty = clamp(
    (highConfidenceLossCount / tradeCount) * 0.7
      + (noTradeCount / tradeCount < 0.1 ? 0.18 : 0)
      + (input.tradeQualityCounts.MODEL_ERROR / tradeCount) * 0.5,
    0,
    1,
  );
  const decisionQuality = clamp(1 - decisionPenalty, 0, 1);
  const behaviorPenalty = clamp(
    (input.tradeQualityCounts.BAD_EXECUTION / tradeCount) * 0.5
      + (input.tradeQualityCounts.MISSED_OPPORTUNITY / tradeCount) * 0.35,
    0,
    1,
  );
  const behaviorScore = clamp(1 - behaviorPenalty, 0, 1);
  const riskPenalty = clamp(drawdownPct / 3 + Math.max(0, -normalizedPnl) * 0.45, 0, 1);

  const sortedRegimes = input.byRegime
    .map((row) => ({
      regime: String(row.regime || "UNKNOWN").trim().toUpperCase() || "UNKNOWN",
      netPnlUsd: safeNumber(row.net_pnl_usd, 0),
    }))
    .sort((left, right) => right.netPnlUsd - left.netPnlUsd);
  const topRegime = sortedRegimes[0]?.regime || "UNKNOWN";
  const regimeBonus = topRegime === "TREND" ? 0.05 : topRegime === "RANGE" || topRegime === "CHOP" ? 0.04 : 0;
  const regimeBiasLabel = topRegime === "TREND"
    ? "reward breakout bonus"
    : topRegime === "RANGE" || topRegime === "CHOP"
      ? "reward mean reversion bonus"
      : "reward neutral";
  const rawScore = round(
    0.35 * normalizedPnl
      + 0.2 * fillEfficiency
      + 0.15 * slippageQuality
      + 0.15 * decisionQuality
      + 0.15 * behaviorScore
      - 0.15 * riskPenalty
      + regimeBonus,
    4,
  );
  const scorePct = round(clamp(((rawScore + 0.5) / 1.35) * 100, 0, 100), 1);

  return {
    rawScore,
    scorePct,
    normalizedPnl: round(normalizedPnl, 3),
    fillEfficiency: round(fillEfficiency, 3),
    slippageQuality: round(slippageQuality, 3),
    decisionQuality: round(decisionQuality, 3),
    riskPenalty: round(riskPenalty, 3),
    behaviorScore: round(behaviorScore, 3),
    regimeBonus: round(regimeBonus, 3),
    regimeBiasLabel,
  };
}

function buildOverfitShield(input: {
  summary: JsonRow;
  liveOps: JsonRow;
  executionAiV6: JsonRow;
  byRegime: JsonRow[];
  journalEntries: JournalEntry[];
  tradeQualityCounts: Record<TradeQuality, number>;
  nowMs: number;
}): FeedbackShieldSummary {
  const tradeCount = Math.max(1, safeNumber(input.summary.trade_count, 0));
  const netPnlUsd = safeNumber(input.summary.net_pnl_usd, 0);
  const highConfidenceLossCount = safeNumber(input.summary.high_confidence_loss_count, 0);
  const memoryGap = safeRecord(input.liveOps.memory_gap);
  const governance = safeRecord(input.liveOps.governance);
  const riskSnapshot = safeRecord(input.liveOps.risk_snapshot);
  const watchdog = safeRecord(input.liveOps.watchdog_state);
  const v6Snapshot = safeRecord(input.executionAiV6.snapshot);
  const v6Guardrails = safeRecord(v6Snapshot.guardrails);
  const rewardEma = safeNumber(v6Snapshot.reward_ema, 0);
  const realityGapScore = Math.max(
    safeNumber(memoryGap.reality_gap_score, 0),
    safeNumber(watchdog.drift, 0),
  );
  const liveEdge = clamp(
    (safeNumber(input.summary.win_rate_pct, 0) / 100) * 0.45
      + (netPnlUsd >= 0 ? 0.35 : 0.1)
      + clamp(1 - Math.abs(safeNumber(input.summary.avg_slippage_bps, 0)) / 5, 0, 1) * 0.2,
    0,
    1,
  );
  const expectedEdge = clamp(rewardEma !== 0 ? (rewardEma + 1) / 2 : 1 - realityGapScore, 0.1, 1);
  const rollingRealityRatio = round(clamp(liveEdge / expectedEdge, 0, 1.5), 2);
  const profitableRegimes = input.byRegime.filter((row) => safeNumber(row.net_pnl_usd, 0) > 0);
  const totalProfitablePnl = profitableRegimes.reduce((sum, row) => sum + safeNumber(row.net_pnl_usd, 0), 0);
  const topProfitableRegimeShare = totalProfitablePnl > 0
    ? safeNumber(profitableRegimes[0]?.net_pnl_usd, 0) / totalProfitablePnl
    : 0;
  const multiRegimeValidation = profitableRegimes.length <= 1 && input.byRegime.length >= 2 && topProfitableRegimeShare >= 0.75
    ? "REJECT"
    : rollingRealityRatio < 0.6 || realityGapScore > 0.2
      ? "REVIEW"
      : "PASS";
  const negativeStreakEstimate = input.tradeQualityCounts.MODEL_ERROR + input.tradeQualityCounts.BAD_EXECUTION;
  const override24h = countJournal(input.journalEntries, new Set(["override-visible-on"]), 24, input.nowMs);
  const drawdownPct = safeNumber(riskSnapshot.dd_pct, 0);
  const watchdogLocked = normalizeKey(watchdog.status) === "halt" || normalizeKey(governance.mode) === "locked";
  const freezeLearning = watchdogLocked
    || Boolean(v6Guardrails.learning_frozen)
    || drawdownPct >= 3
    || negativeStreakEstimate >= 5
    || rollingRealityRatio < 0.6
    || (highConfidenceLossCount >= 2 && tradeCount >= 5);
  const learningState: FeedbackLearningState = freezeLearning
    ? "FROZEN"
    : multiRegimeValidation === "REVIEW" || override24h > 0 || realityGapScore > 0.15
      ? "REDUCED"
      : "ACTIVE";
  const reasons = [
    multiRegimeValidation === "REJECT" ? "positive pnl concentrated in one regime only" : null,
    rollingRealityRatio < 0.6 ? `rolling reality ratio ${rollingRealityRatio.toFixed(2)} below 0.60` : null,
    drawdownPct >= 3 ? `drawdown ${drawdownPct.toFixed(2)}% triggers learning freeze` : null,
    negativeStreakEstimate >= 5 ? `negative streak proxy ${negativeStreakEstimate.toFixed(0)} trades` : null,
    override24h > 0 ? `${override24h.toFixed(0)} visible override(s) over 24h` : null,
    realityGapScore > 0.2 ? `reality gap ${realityGapScore.toFixed(2)} is elevated` : null,
  ].filter((value): value is string => Boolean(value));

  return {
    learningState,
    freezeLearning,
    explorationMode: freezeLearning ? "frozen" : "minimal",
    multiRegimeValidation,
    rollingRealityRatio,
    contextCompression: freezeLearning || multiRegimeValidation !== "PASS" ? "compressed" : "normal",
    reasons,
  };
}

function scaleCalibrationActions(actions: FeedbackCalibrationAction[], budgetPct: number): FeedbackCalibrationAction[] {
  const sanitized = actions
    .map((action) => ({
      ...action,
      magnitudePct: clamp(action.magnitudePct, 0, budgetPct),
    }))
    .filter((action) => action.magnitudePct > 0);
  const total = sanitized.reduce((sum, action) => sum + action.magnitudePct, 0);
  if (total <= budgetPct) {
    return sanitized.map((action) => ({ ...action, magnitudePct: round(action.magnitudePct, 1) }));
  }
  const scale = budgetPct / total;
  return sanitized.map((action) => ({
    ...action,
    magnitudePct: round(action.magnitudePct * scale, 1),
  }));
}

function buildCalibrationActions(input: {
  predictionError: number;
  fillError: number;
  slippageError: number;
  decisionError: number;
  behaviorError: number;
  tradeCount: number;
  modelHealth: FeedbackModelHealth;
}): FeedbackCalibrationAction[] {
  const actions: FeedbackCalibrationAction[] = [];
  if (input.predictionError > 0.3) {
    actions.push({
      target: "confidence_threshold",
      direction: "increase",
      magnitudePct: 1.4 + (input.predictionError - 0.3) * 7,
      reason: "prediction error elevated: raise confidence threshold slowly",
    });
  }
  if (input.fillError > 0.25) {
    actions.push({
      target: "limit_usage",
      direction: "decrease",
      magnitudePct: 1.2 + (input.fillError - 0.25) * 6,
      reason: "fill error elevated: reduce passive limit usage",
    });
  }
  if (input.slippageError > 0.2) {
    actions.push({
      target: "market_bias",
      direction: "increase",
      magnitudePct: 1.1 + (input.slippageError - 0.2) * 6,
      reason: "slippage error elevated: bias routing toward faster execution",
    });
  }
  if (input.decisionError > 0.22 || input.tradeCount > 10) {
    actions.push({
      target: "no_trade_sensitivity",
      direction: "increase",
      magnitudePct: 1 + Math.max(input.decisionError - 0.22, 0) * 6 + (input.tradeCount > 10 ? 1.2 : 0),
      reason: "trade flow too loose: make no-trade dominate harder",
    });
  }
  if (input.behaviorError > 0.25 || input.modelHealth === "DEGRADING" || input.modelHealth === "BROKEN") {
    actions.push({
      target: "sizing_multiplier",
      direction: "decrease",
      magnitudePct: input.modelHealth === "BROKEN" ? 2.8 : 1.4 + Math.max(input.behaviorError - 0.25, 0) * 6,
      reason: "model health degraded: reduce size before touching structure",
    });
  }

  return scaleCalibrationActions(actions, MAX_ADJUSTMENT_PER_DAY_PCT);
}

function buildWindows(input: {
  trades: JsonRow[];
  reward: FeedbackRewardBreakdown;
  shield: FeedbackShieldSummary;
  modelHealth: FeedbackModelHealth;
}): FeedbackWindow[] {
  const latestTrade = safeRecord(input.trades[0]);
  const latestTradeScore = clamp(
    (safeNumber(latestTrade.net_result_usd, 0) >= 0 ? 55 : 30)
      + clamp(120 - safeNumber(latestTrade.latency_ms, 0), 0, 120) * 0.12
      + clamp(4 - Math.abs(safeNumber(latestTrade.slippage_real_bps, 0)), 0, 4) * 6,
    0,
    100,
  );
  const weeklyScore = clamp(
    input.reward.scorePct * 0.6
      + (input.shield.multiRegimeValidation === "PASS" ? 20 : input.shield.multiRegimeValidation === "REVIEW" ? 8 : -5)
      + (input.shield.rollingRealityRatio >= 0.6 ? 10 : -12),
    0,
    100,
  );
  const monthlyScore = clamp(
    input.reward.scorePct * 0.45
      + (input.modelHealth === "HEALTHY" ? 30 : input.modelHealth === "ADAPTING" ? 18 : input.modelHealth === "DEGRADING" ? 8 : 0)
      + (input.shield.freezeLearning ? -10 : 8),
    0,
    100,
  );

  return [
    {
      key: "instant",
      label: "Instant",
      sampleSize: Math.min(input.trades.length, 1),
      scorePct: round(latestTradeScore, 1),
      summary: latestTrade && Object.keys(latestTrade).length > 0
        ? `last trade ${safeNumber(latestTrade.net_result_usd, 0) >= 0 ? "clean" : "under pressure"}`
        : "waiting for the first live sample",
    },
    {
      key: "session",
      label: "Session",
      sampleSize: input.trades.length,
      scorePct: input.reward.scorePct,
      summary: input.reward.scorePct >= 65
        ? "session reward supports guarded learning"
        : input.reward.scorePct >= 45
          ? "session usable but still noisy"
          : "session too weak for aggressive calibration",
    },
    {
      key: "weekly",
      label: "Weekly",
      sampleSize: input.trades.length,
      scorePct: round(weeklyScore, 1),
      summary: input.shield.multiRegimeValidation === "PASS"
        ? "weekly validation spreads across regimes"
        : input.shield.multiRegimeValidation === "REVIEW"
          ? "weekly validation needs more diversified regimes"
          : "weekly validation rejects the learning update",
    },
    {
      key: "monthly",
      label: "Monthly",
      sampleSize: input.trades.length,
      scorePct: round(monthlyScore, 1),
      summary: input.shield.freezeLearning
        ? "monthly posture is defensive until drift is contained"
        : "monthly posture remains adaptive under guardrails",
    },
  ];
}

export function buildFeedbackSummary(input: {
  executionPnlPayload: Record<string, unknown> | null;
  liveOpsPayload?: Record<string, unknown> | null;
  executionAiV6Payload?: Record<string, unknown> | null;
  journalEntries?: Array<Record<string, unknown>>;
  nowMs?: number;
}): FeedbackSummary {
  const envelope = safeRecord(input.executionPnlPayload);
  const summary = safeRecord(envelope.summary);
  const trades = safeRows(envelope.trades);
  const byRegime = safeRows(envelope.by_regime);
  const liveOps = safeRecord(input.liveOpsPayload);
  const executionAiV6 = safeRecord(input.executionAiV6Payload);
  const journalEntries = Array.isArray(input.journalEntries) ? input.journalEntries.map(safeRecord) : [];
  const nowMs = input.nowMs ?? Date.now();
  const tradeCount = safeNumber(summary.trade_count, trades.length);
  const badModelFlags = new Set(
    safeRows(envelope.bad_model_flags)
      .map((row) => String(row.decision_id || "").trim())
      .filter(Boolean),
  );
  const { counts: tradeQualityCounts, dominantTradeQuality } = buildTradeQualityCounts(trades, badModelFlags);
  const override24h = countJournal(journalEntries, new Set(["override-visible-on"]), 24, nowMs);
  const forced24h = countJournal(journalEntries, new Set(["auto-reduce", "auto-close", "emergency-stop"]), 24, nowMs);
  const behaviorError = clamp((override24h * 0.18) + (forced24h * 0.2), 0, 1);
  const predictionError = clamp(
    (safeNumber(summary.high_confidence_loss_count, 0) / Math.max(tradeCount, 1)) * 0.9
      + (safeNumber(summary.win_rate_pct, 0) < 45 ? (45 - safeNumber(summary.win_rate_pct, 0)) / 100 : 0)
      + (safeNumber(summary.net_pnl_usd, 0) < 0 && tradeCount >= 5 ? 0.14 : 0),
    0,
    1,
  );
  const fillError = clamp(
    (safeNumber(summary.avg_latency_ms, 0) > 120 ? Math.min((safeNumber(summary.avg_latency_ms, 0) - 120) / 180, 0.45) : 0)
      + (tradeQualityCounts.BAD_EXECUTION / Math.max(tradeCount, 1)) * 0.45
      + (forced24h > 0 ? 0.15 : 0),
    0,
    1,
  );
  const slippageError = clamp(Math.abs(safeNumber(summary.avg_slippage_bps, 0)) / 10 + (safeNumber(summary.avg_slippage_bps, 0) > 3 ? 0.08 : 0), 0, 1);
  const noTradeRatio = tradeCount > 0 ? safeNumber(summary.no_trade_dominance_count, 0) / tradeCount : 0;
  const decisionError = clamp(
    (noTradeRatio < 0.1 ? 0.22 : noTradeRatio < 0.2 ? 0.08 : 0)
      + (tradeQualityCounts.MODEL_ERROR / Math.max(tradeCount, 1)) * 0.5
      + (tradeCount > 10 ? 0.18 : 0)
      + (override24h > 0 ? 0.12 : 0),
    0,
    1,
  );
  const reward = buildRewardBreakdown({ summary, liveOps, tradeQualityCounts, byRegime });
  const shield = buildOverfitShield({
    summary,
    liveOps,
    executionAiV6,
    byRegime,
    journalEntries,
    tradeQualityCounts,
    nowMs,
  });
  const overfitError = clamp(
    (shield.multiRegimeValidation === "REJECT" ? 0.55 : shield.multiRegimeValidation === "REVIEW" ? 0.3 : 0)
      + (shield.rollingRealityRatio < 0.6 ? 0.28 : 0)
      + (shield.contextCompression === "compressed" ? 0.12 : 0),
    0,
    1,
  );
  const errors = ([
    {
      kind: "prediction",
      score: round(predictionError, 3),
      severity: toneForScore(predictionError),
      label: "Prediction error",
      detail: predictionError > 0.3
        ? "high-confidence losses are too frequent versus live truth"
        : "prediction layer remains inside the guarded band",
    },
    {
      kind: "fill",
      score: round(fillError, 3),
      severity: toneForScore(fillError),
      label: "Fill error",
      detail: fillError > 0.25
        ? "latency or routing quality is degrading execution"
        : "fill quality remains acceptable for micro-live",
    },
    {
      kind: "slippage",
      score: round(slippageError, 3),
      severity: toneForScore(slippageError),
      label: "Slippage error",
      detail: slippageError > 0.2
        ? "slippage is large enough to bias the reward signal"
        : "slippage stays inside the expected band",
    },
    {
      kind: "decision",
      score: round(decisionError, 3),
      severity: toneForScore(decisionError),
      label: "Decision error",
      detail: decisionError > 0.25
        ? "the desk is still taking too many low-quality decisions"
        : "decision discipline is mostly aligned with no-trade dominance",
    },
    {
      kind: "behavior",
      score: round(behaviorError, 3),
      severity: toneForScore(behaviorError),
      label: "Behavior error",
      detail: behaviorError > 0.25
        ? "visible overrides or forced protections are polluting the learning loop"
        : "operator behavior remains compatible with controlled learning",
    },
    {
      kind: "overfit",
      score: round(overfitError, 3),
      severity: toneForScore(overfitError),
      label: "Overfit shield",
      detail: overfitError > 0.25
        ? "live reality diverges from the expected edge or regime mix"
        : "the shield does not see a major generalization breach yet",
    },
  ] satisfies FeedbackError[]).sort((left, right) => right.score - left.score);

  const watchdog = safeRecord(liveOps.watchdog_state);
  const governance = safeRecord(liveOps.governance);
  const riskSnapshot = safeRecord(liveOps.risk_snapshot);
  const realityGap = safeNumber(safeRecord(liveOps.memory_gap).reality_gap_score, safeNumber(watchdog.drift, 0));
  const modelHealth: FeedbackModelHealth = (
    normalizeKey(watchdog.status) === "halt"
    || normalizeKey(governance.mode) === "locked"
    || shield.freezeLearning
    || safeNumber(riskSnapshot.dd_pct, 0) >= 3
    || reward.scorePct < 35
  )
    ? "BROKEN"
    : overfitError >= 0.55 || predictionError >= 0.35 || (tradeCount >= 5 && safeNumber(summary.net_pnl_usd, 0) < 0)
      ? "DEGRADING"
      : tradeCount < 5 || errors.some((error) => error.score >= 0.25)
        ? "ADAPTING"
        : "HEALTHY";
  const driftState: FeedbackDriftState = (
    modelHealth === "BROKEN"
    || safeNumber(riskSnapshot.dd_pct, 0) >= 3
    || safeNumber(summary.high_confidence_loss_count, 0) >= 2
  )
    ? "LOCK"
    : realityGap > 0.2 || shield.multiRegimeValidation === "REJECT"
      ? "DRIFT"
      : safeNumber(summary.avg_latency_ms, 0) > 120 || Math.abs(safeNumber(summary.avg_slippage_bps, 0)) > 3 || overfitError > 0.25
        ? "WATCH"
        : "CALM";

  const calibrationActions = buildCalibrationActions({
    predictionError,
    fillError,
    slippageError,
    decisionError,
    behaviorError,
    tradeCount,
    modelHealth,
  });
  const windows = buildWindows({ trades, reward, shield, modelHealth });
  const reduceSize = modelHealth === "DEGRADING" || modelHealth === "BROKEN";
  const forceNoTrade = modelHealth === "BROKEN" || driftState === "LOCK";
  const learningDisabled = shield.freezeLearning || driftState === "LOCK";
  const protections = [
    reduceSize ? "reduce_size" : null,
    forceNoTrade ? "force_no_trade" : null,
    learningDisabled ? "disable_learning" : null,
    shield.contextCompression === "compressed" ? "compress_context" : null,
  ].filter((value): value is string => Boolean(value));
  const recommendations = [
    calibrationActions.length > 0
      ? `apply calibration with a daily cap of ${MAX_ADJUSTMENT_PER_DAY_PCT.toFixed(0)}%`
      : "keep calibration unchanged until a stronger pattern appears",
    shield.multiRegimeValidation === "REJECT"
      ? "reject the learning update until pnl spreads across more than one regime"
      : shield.multiRegimeValidation === "REVIEW"
        ? "delay promotion and collect more diversified regime samples"
        : "regime validation is acceptable for constrained learning",
    shield.rollingRealityRatio < 0.6
      ? "freeze learning and compare live truth against model expectation before the next promotion"
      : "rolling reality check stays inside the acceptable band",
    reward.scorePct < 45
      ? "reward signal is too weak: favor no-trade, lower size and inspect friction first"
      : `reward profile ${reward.regimeBiasLabel} supports guarded adaptation`,
    behaviorError > 0.25
      ? "operator overrides are contaminating feedback: keep overrides visible and rare"
      : "operator discipline remains compatible with self-rewarding updates",
  ];

  return {
    tradeCount,
    tradeQualityCounts,
    dominantTradeQuality,
    modelHealth,
    driftState,
    errors,
    reward,
    shield,
    calibrationActions,
    windows,
    recommendations,
    protections,
    reduceSize,
    forceNoTrade,
    learningDisabled,
    maxAdjustmentPerDayPct: MAX_ADJUSTMENT_PER_DAY_PCT,
  };
}