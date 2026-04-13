export type AdaptiveState = {
  performance: number;
  errors: number;
  confidence: number;
  regime: string;
  winRate: number;
  lossStreak: number;
  adaptSpeed: number;
  realityGapPressure: number;
};

export type AdaptiveOutcome = {
  success: boolean;
  pnlBps: number;
  fillProbability: number;
  slippageBps: number;
  latencyMs: number;
  regime?: string;
  failureSource?: string | null;
};

export type RealityGapFeedback = {
  slippageGapBps: number;
  fillProbabilityGap: number;
  latencyGapMs: number;
  impactGapBps: number;
  queueAheadQty: number;
  calibrationAction?: string;
  failureSource?: string;
  regime?: string;
};

export type AdaptiveStrategy = {
  mode: "offensive" | "balanced" | "defensive";
  riskMultiplier: number;
  executionStyle: "aggressive" | "balanced" | "passive";
  sizeMultiplier: number;
};

export type AdaptiveCorrection = {
  sizeMultiplier: number;
  executionStyle: "aggressive" | "balanced" | "passive";
  blocked: boolean;
  dominantFailureSource: string;
  reasons: string[];
};

export type AdaptiveMetaLearning = {
  bestStrategy: string;
  worstCondition: string;
  adaptSpeed: number;
};

export type AdaptiveDecision = {
  action: "execute" | "hold" | "reduce" | "skip";
  shouldExecute: boolean;
  confidence: number;
  sizeMultiplier: number;
  executionStyle: "aggressive" | "balanced" | "passive";
  reasons: string[];
};

export type AdaptiveSnapshot = {
  state: AdaptiveState;
  strategy: AdaptiveStrategy;
  correction: AdaptiveCorrection;
  meta: AdaptiveMetaLearning;
  decision: AdaptiveDecision;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function safeAverage(values: number[], fallback = 0): number {
  if (values.length === 0) {
    return fallback;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function updateModel(state: AdaptiveState, outcome: AdaptiveOutcome): AdaptiveState {
  const nextErrors = state.errors + (outcome.success ? 0 : 1);
  const nextLossStreak = outcome.success ? 0 : state.lossStreak + 1;
  const rewardBias = clamp(outcome.pnlBps / 20, -0.18, 0.18);
  const fillSupport = clamp(outcome.fillProbability, 0, 1) * 0.03;
  const frictionPenalty = clamp(outcome.slippageBps / 30, 0, 1) * 0.05 + clamp(outcome.latencyMs / 900, 0, 1) * 0.04;
  const confidenceDrift = outcome.success
    ? 0.05 + rewardBias + fillSupport - frictionPenalty * 0.4
    : -0.1 + rewardBias - frictionPenalty;
  return {
    ...state,
    errors: nextErrors,
    confidence: clamp(state.confidence + confidenceDrift, 0.05, 1),
    lossStreak: nextLossStreak,
  };
}

export function detectRegime(input: {
  volatility: number;
  imbalance: number;
  volume: number;
  liquidityCollapse?: boolean;
  regimeHint?: string;
}): string {
  const hint = String(input.regimeHint || "").trim().toLowerCase();
  if (hint && hint !== "n/a" && hint !== "unknown") {
    if (hint.includes("chaos") || hint.includes("stress")) return "chaos";
    if (hint.includes("trend") || hint.includes("aggressive")) return "trend";
    if (hint.includes("dead") || hint.includes("idle")) return "dead";
    if (hint.includes("breakout")) return "breakout";
  }
  if (input.volatility > 0.0075) return "chaos";
  if (input.liquidityCollapse) return "breakout";
  if (Math.abs(input.imbalance) > 0.6) return "trend";
  if (input.volume < 100) return "dead";
  return "neutral";
}

export function applyRealityCorrection(strategy: AdaptiveStrategy, gap: RealityGapFeedback | null): AdaptiveCorrection {
  if (!gap) {
    return {
      sizeMultiplier: strategy.sizeMultiplier,
      executionStyle: strategy.executionStyle,
      blocked: false,
      dominantFailureSource: "none",
      reasons: [],
    };
  }

  let sizeMultiplier = strategy.sizeMultiplier;
  let executionStyle = strategy.executionStyle;
  let blocked = false;
  const reasons: string[] = [];

  if (gap.slippageGapBps > 6) {
    sizeMultiplier *= 0.7;
    reasons.push("reality_gap_slippage");
  }
  if (gap.fillProbabilityGap > 0.18) {
    executionStyle = "passive";
    sizeMultiplier *= 0.82;
    reasons.push("reality_gap_fill");
  }
  if (gap.latencyGapMs > 180) {
    executionStyle = "passive";
    reasons.push("reality_gap_latency");
  }
  if (gap.impactGapBps > 8) {
    sizeMultiplier *= 0.8;
    reasons.push("reality_gap_impact");
  }
  if (gap.queueAheadQty > 0 && gap.fillProbabilityGap > 0.28 && gap.latencyGapMs > 240) {
    blocked = true;
    reasons.push("queue_blocked");
  }

  return {
    sizeMultiplier: clamp(sizeMultiplier, 0.25, 1.4),
    executionStyle,
    blocked,
    dominantFailureSource: String(gap.failureSource || gap.calibrationAction || "market").trim() || "market",
    reasons,
  };
}

export function mutateStrategy(strategy: AdaptiveStrategy, feedback: {
  lossStreak: number;
  winRate: number;
  regime: string;
  confidence: number;
}): AdaptiveStrategy {
  let riskMultiplier = strategy.riskMultiplier;
  let mode = strategy.mode;
  let executionStyle = strategy.executionStyle;

  if (feedback.lossStreak > 3) {
    riskMultiplier *= 0.5;
    mode = "defensive";
    executionStyle = "passive";
  }
  if (feedback.winRate > 0.7 && feedback.confidence > 0.62) {
    riskMultiplier *= 1.2;
    mode = "offensive";
  }
  if (feedback.regime === "chaos") {
    riskMultiplier *= 0.58;
    mode = "defensive";
    executionStyle = "passive";
  } else if (feedback.regime === "dead") {
    riskMultiplier *= 0.72;
    executionStyle = "passive";
  } else if (feedback.regime === "trend" && feedback.winRate >= 0.55) {
    executionStyle = "aggressive";
  }

  return {
    mode,
    riskMultiplier: clamp(riskMultiplier, 0.2, 1.5),
    executionStyle,
    sizeMultiplier: clamp(riskMultiplier, 0.2, 1.5),
  };
}

export function metaLearning(history: {
  regime: string;
  outcomes: AdaptiveOutcome[];
  gaps: RealityGapFeedback[];
}): AdaptiveMetaLearning {
  const failuresBySource = new Map<string, number>();
  for (const gap of history.gaps) {
    const source = String(gap.failureSource || gap.calibrationAction || gap.regime || "market").trim() || "market";
    failuresBySource.set(source, (failuresBySource.get(source) || 0) + 1);
  }
  const worstCondition = [...failuresBySource.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] || history.regime;
  const winRate = history.outcomes.length > 0
    ? history.outcomes.filter((item) => item.success).length / history.outcomes.length
    : 0.5;
  const bestStrategy = history.regime === "trend" && winRate >= 0.58
    ? "trend-press"
    : history.regime === "chaos"
      ? "survival-passive"
      : history.gaps.length > 0 && safeAverage(history.gaps.map((item) => item.fillProbabilityGap), 0) > 0.14
        ? "queue-aware-passive"
        : "balanced-liquidity";
  const adaptSpeed = clamp(
    history.gaps.length * 0.03
      + Math.abs(winRate - 0.5) * 0.65
      + (history.regime === "chaos" ? 0.18 : 0.08),
    0.05,
    1,
  );
  return {
    bestStrategy,
    worstCondition,
    adaptSpeed,
  };
}

export function dynamicRisk(state: Pick<AdaptiveState, "confidence" | "performance">): number {
  if (state.confidence < 0.4) return 0.5;
  if (state.performance > 0.7) return 1.2;
  return 1.0;
}

export function buildAdaptiveSnapshot(input: {
  regimeHint?: string;
  baseConfidence: number;
  volatility: number;
  imbalance: number;
  volume: number;
  liquidityCollapse?: boolean;
  executionViable: boolean;
  outcomes: AdaptiveOutcome[];
  realityGaps: RealityGapFeedback[];
}): AdaptiveSnapshot {
  const regime = detectRegime({
    volatility: input.volatility,
    imbalance: input.imbalance,
    volume: input.volume,
    liquidityCollapse: input.liquidityCollapse,
    regimeHint: input.regimeHint,
  });

  let state: AdaptiveState = {
    performance: 0.5,
    errors: 0,
    confidence: clamp(input.baseConfidence, 0.05, 1),
    regime,
    winRate: 0.5,
    lossStreak: 0,
    adaptSpeed: 0.2,
    realityGapPressure: 0,
  };

  let rollingLossStreak = 0;
  for (const outcome of input.outcomes.slice(0, 16)) {
    state = updateModel(state, outcome);
    rollingLossStreak = outcome.success ? 0 : rollingLossStreak + 1;
  }

  const winRate = input.outcomes.length > 0
    ? input.outcomes.filter((item) => item.success).length / input.outcomes.length
    : 0.5;
  const averagePnlBps = safeAverage(input.outcomes.map((item) => item.pnlBps), 0);
  const averageFillProbability = safeAverage(input.outcomes.map((item) => item.fillProbability), 0.5);
  const averageSlippageBps = safeAverage(input.outcomes.map((item) => item.slippageBps), 0);
  const averageLatencyMs = safeAverage(input.outcomes.map((item) => item.latencyMs), 0);
  const gapPressure = clamp(
    safeAverage(input.realityGaps.map((gap) => (
      Math.abs(gap.slippageGapBps) * 0.08
      + Math.abs(gap.fillProbabilityGap) * 2.2
      + Math.abs(gap.latencyGapMs) / 220
      + Math.abs(gap.impactGapBps) * 0.05
    )), 0),
    0,
    1,
  );
  const performance = clamp(
    winRate * 0.56
      + clamp((averagePnlBps + 10) / 20, 0, 1) * 0.18
      + averageFillProbability * 0.12
      + Math.max(0, 1 - averageSlippageBps / 20) * 0.08
      + Math.max(0, 1 - averageLatencyMs / 900) * 0.06,
    0,
    1,
  );

  state = {
    ...state,
    performance,
    winRate,
    lossStreak: rollingLossStreak,
    realityGapPressure: gapPressure,
  };

  const meta = metaLearning({
    regime,
    outcomes: input.outcomes,
    gaps: input.realityGaps,
  });
  state.adaptSpeed = meta.adaptSpeed;

  let strategy: AdaptiveStrategy = {
    mode: "balanced",
    riskMultiplier: dynamicRisk(state),
    executionStyle: "balanced",
    sizeMultiplier: dynamicRisk(state),
  };
  strategy = mutateStrategy(strategy, {
    lossStreak: state.lossStreak,
    winRate: state.winRate,
    regime,
    confidence: state.confidence,
  });

  const dominantGap = [...input.realityGaps].sort((left, right) => (
    Math.abs(right.slippageGapBps) + Math.abs(right.fillProbabilityGap) * 10 + Math.abs(right.latencyGapMs) / 50
  ) - (
    Math.abs(left.slippageGapBps) + Math.abs(left.fillProbabilityGap) * 10 + Math.abs(left.latencyGapMs) / 50
  ))[0] || null;
  const correction = applyRealityCorrection(strategy, dominantGap);
  const riskMultiplier = clamp(strategy.riskMultiplier * correction.sizeMultiplier, 0.18, 1.5);
  const correctedConfidence = clamp(state.confidence - state.realityGapPressure * 0.18, 0.05, 1);
  const decisionReasons = [...correction.reasons];

  let action: AdaptiveDecision["action"] = "execute";
  if (!input.executionViable) {
    action = "skip";
    decisionReasons.push("execution_not_viable");
  } else if (correction.blocked) {
    action = "hold";
    decisionReasons.push("reality_gap_blocked");
  } else if (correctedConfidence < 0.5 || state.realityGapPressure > 0.72) {
    action = "hold";
    decisionReasons.push("adaptive_confidence_low");
  } else if (regime === "chaos" || state.lossStreak > 2) {
    action = "reduce";
    decisionReasons.push(regime === "chaos" ? "chaos_regime_reduce" : "loss_streak_reduce");
  }

  return {
    state: {
      ...state,
      confidence: correctedConfidence,
    },
    strategy: {
      ...strategy,
      riskMultiplier,
      sizeMultiplier: riskMultiplier,
      executionStyle: correction.executionStyle,
    },
    correction,
    meta,
    decision: {
      action,
      shouldExecute: input.executionViable && action !== "skip" && action !== "hold",
      confidence: correctedConfidence,
      sizeMultiplier: riskMultiplier,
      executionStyle: correction.executionStyle,
      reasons: decisionReasons,
    },
  };
}