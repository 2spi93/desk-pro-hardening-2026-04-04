export type VolatilityRegime = "TREND" | "CHOP" | "CRASH";

export type VolatilityLevel = "LOW" | "MEDIUM" | "HIGH" | "EXTREME";

export type RegimeStrategyAffinity = "trend" | "mean_reversion" | "defensive" | "neutral";

export type RegimeStrategyAction = "boost" | "reduce" | "disable" | "neutral";

export type RegimeFeatures = {
  volatility: number;
  spread: number;
  volume: number;
  delta: number;
  imbalance: number;
  trendStrength: number;
  liquidity: number;
};

export type RegimeProbabilities = {
  trend: number;
  chop: number;
  crash: number;
};

export type VolatilityRegimeSnapshot = {
  regime: VolatilityRegime;
  confidence: number;
  volatilityLevel: VolatilityLevel;
  features: RegimeFeatures;
  probabilities: RegimeProbabilities;
  riskMultiplier: number;
  allocatorMultiplier: number;
  hedgeBias: "normal" | "max";
  executionMode: "mean_reversion" | "momentum_entry" | "aggressive_exit";
  actionMap: {
    boosted: string[];
    reduced: string[];
    disabled: string[];
    byStrategy: Record<string, RegimeStrategyAction>;
  };
  strategyMultipliers: Record<string, number>;
  reasons: string[];
};

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }
  return Math.min(maximum, Math.max(minimum, value));
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value));
}

function normalizeSigned(value: number, scale: number): number {
  return clamp(value / Math.max(scale, 1e-6), -1, 1);
}

function normalizeUnsigned(value: number, scale: number): number {
  return clamp(value / Math.max(scale, 1e-6), 0, 1.5);
}

export function buildRegimeFeatures(frame: {
  volatility?: number;
  spread?: number;
  volume?: number;
  trendStrength?: number;
  footprint?: { delta?: number; imbalance?: number } | null;
  dom?: { liquidityScore?: number } | null;
}): RegimeFeatures {
  return {
    volatility: clamp(Number(frame.volatility || 0), 0, 1.5),
    spread: clamp(Number(frame.spread || 0), 0, 1.5),
    volume: clamp(Number(frame.volume || 0), 0, 1.5),
    delta: Number(frame.footprint?.delta || 0),
    imbalance: clamp(Number(frame.footprint?.imbalance || 0), -1, 1),
    trendStrength: clamp(Number(frame.trendStrength || 0), 0, 1),
    liquidity: clamp(Number(frame.dom?.liquidityScore || 0), 0, 1),
  };
}

export function detectRegime(features: RegimeFeatures): VolatilityRegime {
  if (features.volatility > 0.9 && features.delta < -1000) {
    return "CRASH";
  }
  if (features.trendStrength > 0.7 && features.volatility > 0.5) {
    return "TREND";
  }
  return "CHOP";
}

export function regimeProbabilities(features: RegimeFeatures): RegimeProbabilities {
  const trendSignal = (
    features.trendStrength * 2.2
    + normalizeSigned(features.imbalance, 0.35) * 0.7
    + normalizeUnsigned(features.volume, 1) * 0.35
    - normalizeUnsigned(features.spread, 1) * 0.25
    + normalizeUnsigned(features.liquidity, 1) * 0.2
  );
  const chopSignal = (
    (1 - features.trendStrength) * 2.1
    + normalizeUnsigned(features.liquidity, 1) * 0.45
    - normalizeUnsigned(features.volatility, 1) * 0.55
    - Math.abs(normalizeSigned(features.imbalance, 0.35)) * 0.35
  );
  const crashSignal = (
    normalizeUnsigned(features.volatility, 1) * 2.4
    + normalizeUnsigned(Math.max(0, -features.delta), 1000) * 1.5
    + normalizeUnsigned(features.spread, 1) * 0.55
    + normalizeUnsigned(1 - features.liquidity, 1) * 0.7
  );
  return {
    trend: sigmoid(trendSignal),
    chop: sigmoid(chopSignal),
    crash: sigmoid(crashSignal),
  };
}

export function classifyStrategyAffinity(strategyId: string): RegimeStrategyAffinity {
  const normalized = String(strategyId || "").trim().toLowerCase();
  if (!normalized) {
    return "neutral";
  }
  if (/breakout|momentum|trend|follow|miro|flash|scalp_trend|continuation/.test(normalized)) {
    return "trend";
  }
  if (/reversal|mean|range|fade|revert|counter|snapback/.test(normalized)) {
    return "mean_reversion";
  }
  if (/hedge|risk|defen|protect|crash|vol|arb|router/.test(normalized)) {
    return "defensive";
  }
  return "neutral";
}

export function resolveStrategyActionForRegime(
  regime: VolatilityRegime,
  affinity: RegimeStrategyAffinity,
): RegimeStrategyAction {
  if (regime === "TREND") {
    if (affinity === "trend") return "boost";
    if (affinity === "mean_reversion") return "reduce";
    return "neutral";
  }
  if (regime === "CHOP") {
    if (affinity === "mean_reversion") return "boost";
    if (affinity === "trend") return "reduce";
    return "neutral";
  }
  if (affinity === "defensive") {
    return "boost";
  }
  if (affinity === "neutral") {
    return "reduce";
  }
  return "disable";
}

export function resolveStrategyMultiplierForAction(action: RegimeStrategyAction): number {
  if (action === "boost") return 1.25;
  if (action === "reduce") return 0.6;
  if (action === "disable") return 0.05;
  return 1;
}

function resolveVolatilityLevel(volatility: number): VolatilityLevel {
  if (volatility >= 1.1) return "EXTREME";
  if (volatility >= 0.85) return "HIGH";
  if (volatility >= 0.45) return "MEDIUM";
  return "LOW";
}

export function buildVolatilityRegimeSnapshot(
  frame: {
    volatility?: number;
    spread?: number;
    volume?: number;
    trendStrength?: number;
    footprint?: { delta?: number; imbalance?: number } | null;
    dom?: { liquidityScore?: number } | null;
  },
  strategyIds: string[],
): VolatilityRegimeSnapshot {
  const features = buildRegimeFeatures(frame);
  const probabilities = regimeProbabilities(features);
  const regime = detectRegime(features);
  const topProbability = regime === "TREND"
    ? probabilities.trend
    : regime === "CRASH"
      ? probabilities.crash
      : probabilities.chop;
  const secondaryProbability = regime === "TREND"
    ? Math.max(probabilities.chop, probabilities.crash)
    : regime === "CRASH"
      ? Math.max(probabilities.trend, probabilities.chop)
      : Math.max(probabilities.trend, probabilities.crash);
  const confidence = clamp(0.5 + (topProbability - secondaryProbability) * 0.5, 0.5, 0.99);
  const actionMap = {
    boosted: [] as string[],
    reduced: [] as string[],
    disabled: [] as string[],
    byStrategy: {} as Record<string, RegimeStrategyAction>,
  };
  const strategyMultipliers: Record<string, number> = {};
  for (const strategyId of strategyIds) {
    const affinity = classifyStrategyAffinity(strategyId);
    const action = resolveStrategyActionForRegime(regime, affinity);
    actionMap.byStrategy[strategyId] = action;
    strategyMultipliers[strategyId] = resolveStrategyMultiplierForAction(action);
    if (action === "boost") actionMap.boosted.push(strategyId);
    if (action === "reduce") actionMap.reduced.push(strategyId);
    if (action === "disable") actionMap.disabled.push(strategyId);
  }

  const reasons: string[] = [];
  if (regime === "CRASH") {
    reasons.push("risk_off_detected", "aggressive_exit", "hedge_max");
  } else if (regime === "TREND") {
    reasons.push("trend_strength_confirmed", "momentum_entry");
  } else {
    reasons.push("range_state_detected", "mean_reversion_bias");
  }
  if (features.spread > 0.75) {
    reasons.push("spread_expanded");
  }
  if (Math.abs(features.imbalance) > 0.55) {
    reasons.push("orderflow_imbalance");
  }

  return {
    regime,
    confidence,
    volatilityLevel: resolveVolatilityLevel(features.volatility),
    features,
    probabilities,
    riskMultiplier: regime === "CRASH" ? 0.2 : regime === "CHOP" ? 0.78 : 1.05,
    allocatorMultiplier: regime === "CRASH" ? 0.3 : regime === "CHOP" ? 0.9 : 1.1,
    hedgeBias: regime === "CRASH" ? "max" : "normal",
    executionMode: regime === "CRASH" ? "aggressive_exit" : regime === "TREND" ? "momentum_entry" : "mean_reversion",
    actionMap,
    strategyMultipliers,
    reasons,
  };
}
