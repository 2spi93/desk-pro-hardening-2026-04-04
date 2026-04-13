export type PnlTrade = {
  id: string;
  symbol: string;
  strategyId: string | null;
  volatilityRegime?: string | null;
  pnlUsd: number;
  entryPrice: number | null;
  exitPrice: number | null;
  size: number;
  expectedPrice: number | null;
  executedPrice: number | null;
  latencyMs: number;
  filledSize: number;
  requestedSize: number;
  drawdownPct: number;
  liquidityPredictionState?: string | null;
  liquidityPredictionScore?: number | null;
  liquidityPredictionBias?: number | null;
  liquidityPredictionConfidence?: number | null;
};

export type PnlStats = {
  tradeCount: number;
  pnlUsd: number;
  winrate: number;
  avgWin: number;
  avgLoss: number;
  expectancy: number;
  sharpeLike: number;
  profitFactor: number;
  maxDrawdownPct: number;
};

export type ExecutionAnalytics = {
  avgSlippageBps: number;
  avgLatencyMs: number;
  avgFillRate: number;
  samples: number;
};

export type AutoOptimizationDecision = {
  action: "hold" | "reduce" | "disable";
  sizeMultiplier: number;
  reasons: string[];
};

export type LiquidityAnalytics = {
  accuracy: number;
  samples: number;
  supportiveHitRate: number;
  adverseHitRate: number;
};

export type RegimePerformanceAnalytics = {
  trend: PnlStats;
  chop: PnlStats;
  crash: PnlStats;
};

export type PnlAnalyticsSnapshot = {
  stats: PnlStats;
  execution: ExecutionAnalytics;
  liquidity: LiquidityAnalytics;
  regimePerformance: RegimePerformanceAnalytics;
  autoOptimization: AutoOptimizationDecision;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function average(values: number[], fallback = 0): number {
  if (values.length === 0) {
    return fallback;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values: number[]): number {
  if (values.length < 2) {
    return 0;
  }
  const mean = average(values);
  const variance = average(values.map((value) => Math.pow(value - mean, 2)));
  return Math.sqrt(Math.max(variance, 0));
}

function emptyStats(): PnlStats {
  return {
    tradeCount: 0,
    pnlUsd: 0,
    winrate: 0,
    avgWin: 0,
    avgLoss: 0,
    expectancy: 0,
    sharpeLike: 0,
    profitFactor: 0,
    maxDrawdownPct: 0,
  };
}

export function normalizeVolatilityRegime(value: unknown): "TREND" | "CHOP" | "CRASH" | null {
  const normalized = String(value || "").trim().toUpperCase();
  if (!normalized) {
    return null;
  }
  if (["TREND", "BULL", "BULLISH"].includes(normalized)) {
    return "TREND";
  }
  if (["CHOP", "RANGE", "SIDEWAYS", "MEAN_REVERSION"].includes(normalized)) {
    return "CHOP";
  }
  if (["CRASH", "RISK_OFF", "PANIC"].includes(normalized)) {
    return "CRASH";
  }
  return null;
}

export function computePnL(trades: PnlTrade[]): number {
  return trades.reduce((sum, trade) => sum + trade.pnlUsd, 0);
}

export function expectancy(trades: PnlTrade[]): number {
  const winners = trades.filter((trade) => trade.pnlUsd > 0);
  const losers = trades.filter((trade) => trade.pnlUsd <= 0);
  const winrate = trades.length > 0 ? winners.length / trades.length : 0;
  const avgWin = average(winners.map((trade) => trade.pnlUsd), 0);
  const avgLoss = average(losers.map((trade) => trade.pnlUsd), 0);
  return winrate * avgWin - (1 - winrate) * Math.abs(avgLoss);
}

function computeMaxDrawdownPct(trades: PnlTrade[]): number {
  let peak = 0;
  let equity = 0;
  let maxDrawdownPct = 0;
  for (const trade of trades) {
    equity += trade.pnlUsd;
    peak = Math.max(peak, equity);
    const drawdownPct = peak > 0 ? ((peak - equity) / peak) * 100 : Math.max(0, trade.drawdownPct);
    maxDrawdownPct = Math.max(maxDrawdownPct, drawdownPct, Math.max(0, trade.drawdownPct));
  }
  return maxDrawdownPct;
}

export function computeStats(trades: PnlTrade[]): PnlStats {
  const winners = trades.filter((trade) => trade.pnlUsd > 0);
  const losers = trades.filter((trade) => trade.pnlUsd <= 0);
  const pnlSeries = trades.map((trade) => trade.pnlUsd);
  const grossProfit = winners.reduce((sum, trade) => sum + trade.pnlUsd, 0);
  const grossLoss = Math.abs(losers.reduce((sum, trade) => sum + trade.pnlUsd, 0));
  const avgLoss = average(losers.map((trade) => trade.pnlUsd), 0);

  return {
    tradeCount: trades.length,
    pnlUsd: computePnL(trades),
    winrate: trades.length > 0 ? winners.length / trades.length : 0,
    avgWin: average(winners.map((trade) => trade.pnlUsd), 0),
    avgLoss,
    expectancy: expectancy(trades),
    sharpeLike: pnlSeries.length > 1 ? average(pnlSeries) / Math.max(standardDeviation(pnlSeries), 1e-9) : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? grossProfit : 0,
    maxDrawdownPct: computeMaxDrawdownPct(trades),
  };
}

export function analyzeExecution(trade: PnlTrade): { slippageBps: number; latencyMs: number; fillRate: number } {
  const referencePrice = trade.expectedPrice ?? trade.entryPrice ?? trade.executedPrice ?? 0;
  const executedPrice = trade.executedPrice ?? trade.exitPrice ?? trade.entryPrice ?? 0;
  const slippageBps = referencePrice > 0 && executedPrice > 0
    ? Math.abs((executedPrice - referencePrice) / referencePrice) * 10000
    : 0;
  const requestedSize = Math.max(trade.requestedSize, trade.size, 0);
  const filledSize = Math.max(trade.filledSize, trade.size, 0);
  return {
    slippageBps,
    latencyMs: Math.max(0, trade.latencyMs),
    fillRate: requestedSize > 0 ? clamp(filledSize / requestedSize, 0, 1) : 0,
  };
}

export function computeExecutionAnalytics(trades: PnlTrade[]): ExecutionAnalytics {
  const executionRows = trades
    .map((trade) => analyzeExecution(trade))
    .filter((row) => row.latencyMs > 0 || row.slippageBps > 0 || row.fillRate > 0);

  return {
    avgSlippageBps: average(executionRows.map((row) => row.slippageBps), 0),
    avgLatencyMs: average(executionRows.map((row) => row.latencyMs), 0),
    avgFillRate: average(executionRows.map((row) => row.fillRate), 0),
    samples: executionRows.length,
  };
}

function inferLiquidityBias(trade: PnlTrade): number | null {
  const directBias = trade.liquidityPredictionBias;
  if (typeof directBias === "number" && Number.isFinite(directBias)) {
    return clamp(directBias, -1, 1);
  }
  const directScore = trade.liquidityPredictionScore;
  if (typeof directScore === "number" && Number.isFinite(directScore)) {
    return clamp((directScore - 0.5) * 2, -1, 1);
  }
  const state = String(trade.liquidityPredictionState || "").trim().toLowerCase();
  if (state === "wall-forming" || state === "balanced") {
    return 1;
  }
  if (state === "vacuum" || state === "absorption-failure") {
    return -1;
  }
  return null;
}

export function computeLiquidityAnalytics(trades: PnlTrade[]): LiquidityAnalytics {
  let correct = 0;
  let samples = 0;
  let supportiveCorrect = 0;
  let supportiveSamples = 0;
  let adverseCorrect = 0;
  let adverseSamples = 0;

  for (const trade of trades) {
    const bias = inferLiquidityBias(trade);
    if (bias == null || Math.abs(bias) < 0.08) {
      continue;
    }
    const realizedDirection = trade.pnlUsd > 0.01
      ? 1
      : trade.pnlUsd < -0.01 || trade.drawdownPct > 0.75
        ? -1
        : 0;
    if (realizedDirection === 0) {
      continue;
    }
    const predictedDirection = bias >= 0 ? 1 : -1;
    const isCorrect = predictedDirection === realizedDirection;
    samples += 1;
    if (isCorrect) {
      correct += 1;
    }
    if (predictedDirection > 0) {
      supportiveSamples += 1;
      if (isCorrect) {
        supportiveCorrect += 1;
      }
    } else {
      adverseSamples += 1;
      if (isCorrect) {
        adverseCorrect += 1;
      }
    }
  }

  return {
    accuracy: samples > 0 ? correct / samples : 0,
    samples,
    supportiveHitRate: supportiveSamples > 0 ? supportiveCorrect / supportiveSamples : 0,
    adverseHitRate: adverseSamples > 0 ? adverseCorrect / adverseSamples : 0,
  };
}

export function computeRegimePerformance(trades: PnlTrade[]): RegimePerformanceAnalytics {
  const grouped = {
    TREND: [] as PnlTrade[],
    CHOP: [] as PnlTrade[],
    CRASH: [] as PnlTrade[],
  };
  for (const trade of trades) {
    const normalizedRegime = normalizeVolatilityRegime(trade.volatilityRegime);
    if (normalizedRegime) {
      grouped[normalizedRegime].push(trade);
    }
  }
  return {
    trend: grouped.TREND.length > 0 ? computeStats(grouped.TREND) : emptyStats(),
    chop: grouped.CHOP.length > 0 ? computeStats(grouped.CHOP) : emptyStats(),
    crash: grouped.CRASH.length > 0 ? computeStats(grouped.CRASH) : emptyStats(),
  };
}

export function buildAutoOptimizationDecision(stats: PnlStats, execution: ExecutionAnalytics, liquidity: LiquidityAnalytics): AutoOptimizationDecision {
  const reasons: string[] = [];
  if (stats.expectancy < 0) {
    reasons.push("negative_expectancy");
  }
  if (stats.sharpeLike < 0) {
    reasons.push("negative_sharpe_like");
  }
  if (stats.maxDrawdownPct > 6) {
    reasons.push("drawdown_above_cap");
  }
  if (execution.avgFillRate > 0 && execution.avgFillRate < 0.58) {
    reasons.push("fill_rate_degraded");
  }
  if (execution.avgSlippageBps > 10) {
    reasons.push("slippage_above_budget");
  }
  if (liquidity.samples >= 6 && liquidity.accuracy < 0.55) {
    reasons.push("liquidity_accuracy_degraded");
  }
  if (liquidity.samples >= 6 && liquidity.adverseHitRate < 0.45) {
    reasons.push("liquidity_exit_edge_weak");
  }

  if (stats.tradeCount >= 10 && ((stats.expectancy < 0 && stats.maxDrawdownPct > 4.5) || reasons.length >= 3 || (liquidity.samples >= 8 && liquidity.accuracy < 0.45))) {
    return {
      action: "disable",
      sizeMultiplier: 0,
      reasons,
    };
  }
  if (stats.tradeCount >= 5 && (stats.expectancy < 0 || execution.avgFillRate < 0.7 || execution.avgSlippageBps > 6 || (liquidity.samples >= 4 && liquidity.accuracy < 0.55))) {
    return {
      action: "reduce",
      sizeMultiplier: 0.5,
      reasons,
    };
  }
  return {
    action: "hold",
    sizeMultiplier: 1,
    reasons,
  };
}

export function buildPnlAnalyticsSnapshot(trades: PnlTrade[]): PnlAnalyticsSnapshot {
  const stats = computeStats(trades);
  const execution = computeExecutionAnalytics(trades);
  const liquidity = computeLiquidityAnalytics(trades);
  const regimePerformance = computeRegimePerformance(trades);
  return {
    stats,
    execution,
    liquidity,
    regimePerformance,
    autoOptimization: buildAutoOptimizationDecision(stats, execution, liquidity),
  };
}