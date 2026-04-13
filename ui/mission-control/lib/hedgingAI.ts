export type HedgingAIMode = "shadow" | "live";

export type HedgingExposure = {
  symbol: string;
  market: string;
  netNotionalUsd: number;
  unrealizedPnlUsd: number;
};

export type HedgingCandidate = {
  symbol: string;
  market: string;
  liquidityScore: number;
  spreadBps: number;
  price: number;
  correlation?: number | null;
};

export type HedgingAISnapshot = {
  mode: HedgingAIMode;
  state: "IDLE" | "MONITOR" | "READY" | "HEDGE";
  targetSymbol: string;
  hedgeSymbol: string | null;
  hedgeSide: "buy" | "sell" | "flat";
  hedgeRatio: number;
  hedgeNotionalUsd: number;
  netExposureUsd: number;
  grossExposureUsd: number;
  selectedExposureUsd: number;
  clusterExposureUsd: number;
  concentration: number;
  riskReductionPct: number;
  confidence: number;
  observationCycles: number;
  readyForLive: boolean;
  reasons: string[];
};

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

function absMax(values: number[]): number {
  return values.reduce((current, value) => Math.max(current, Math.abs(value)), 0);
}

export function buildHedgingAISnapshot(input: {
  mode: HedgingAIMode;
  targetSymbol: string;
  targetMarket: string;
  exposures: HedgingExposure[];
  candidates: HedgingCandidate[];
  accountFreeUsd: number;
  drawdownPct: number;
  volatilityScore: number;
  swarmConfidence: number;
  orderflowImbalance: number;
  microNoiseScore: number;
  liquidityStress?: number;
  observationCycles: number;
}): HedgingAISnapshot {
  const exposures = input.exposures.filter((item) => Math.abs(item.netNotionalUsd) > 1);
  const targetSymbol = input.targetSymbol;
  const targetMarket = input.targetMarket;
  const marketExposures = exposures.filter((item) => item.market === targetMarket);
  const selectedExposureUsd = exposures
    .filter((item) => item.symbol === targetSymbol)
    .reduce((sum, item) => sum + item.netNotionalUsd, 0);
  const clusterExposureUsd = marketExposures.reduce((sum, item) => sum + item.netNotionalUsd, 0);
  const grossExposureUsd = marketExposures.reduce((sum, item) => sum + Math.abs(item.netNotionalUsd), 0);
  const netExposureUsd = exposures.reduce((sum, item) => sum + item.netNotionalUsd, 0);
  const accountFreeUsd = Math.max(1, input.accountFreeUsd);
  const exposurePressure = Math.abs(clusterExposureUsd) / accountFreeUsd;
  const drawdownPressure = clamp(input.drawdownPct / 3, 0, 1.2);
  const volatilityPressure = clamp(input.volatilityScore / 1.15, 0, 1.2);
  const liquidityStress = clamp(input.liquidityStress ?? 0, 0, 1.2);
  const concentration = clamp(
    Math.abs(selectedExposureUsd) / Math.max(absMax([clusterExposureUsd, grossExposureUsd, 1]), 1),
    0,
    1,
  );
  const directionalAlignment = Math.sign(clusterExposureUsd) !== 0 && Math.sign(input.orderflowImbalance) !== 0 && Math.sign(clusterExposureUsd) === Math.sign(input.orderflowImbalance)
    ? 1
    : Math.sign(clusterExposureUsd) !== 0 && Math.sign(input.orderflowImbalance) !== 0
      ? -1
      : 0;
  const candidates = input.candidates
    .filter((item) => item.market === targetMarket)
    .sort((left, right) => {
      const leftScore = left.liquidityScore * 0.65 + (1 - clamp(left.spreadBps / 18, 0, 1)) * 0.25 + clamp(Math.abs(left.correlation ?? 0), 0, 1) * 0.1;
      const rightScore = right.liquidityScore * 0.65 + (1 - clamp(right.spreadBps / 18, 0, 1)) * 0.25 + clamp(Math.abs(right.correlation ?? 0), 0, 1) * 0.1;
      return rightScore - leftScore;
    });
  const hedgeCandidate = candidates.find((item) => item.symbol !== targetSymbol) || candidates[0] || null;
  const reasons: string[] = [];

  if (marketExposures.length === 0) {
    reasons.push("no_market_exposure");
  }
  if (!hedgeCandidate && Math.abs(clusterExposureUsd) > 0) {
    reasons.push("no_cross_symbol_hedge_candidate");
  }
  if (input.microNoiseScore >= 0.7) {
    reasons.push("micro_noise_elevated");
  }
  if (input.observationCycles < 20) {
    reasons.push("shadow_observation_incomplete");
  }

  const confidence = clamp(
    exposurePressure * 0.34
      + drawdownPressure * 0.18
      + volatilityPressure * 0.16
      + liquidityStress * 0.1
      + concentration * 0.14
      + (1 - input.microNoiseScore) * 0.08
      + clamp(1 - Math.abs(directionalAlignment) * input.swarmConfidence * 0.5, 0, 1) * 0.1,
    0,
    1,
  );
  const shouldHedge = Math.abs(clusterExposureUsd) > 0
    && (exposurePressure >= 0.04 || drawdownPressure >= 0.45 || volatilityPressure >= 0.8 || concentration >= 0.65 || liquidityStress >= 0.58);
  let hedgeRatio = clamp(
    0.16
      + exposurePressure * 0.7
      + drawdownPressure * 0.18
      + volatilityPressure * 0.16
      + liquidityStress * 0.14
      + concentration * 0.12
      - (directionalAlignment > 0 ? input.swarmConfidence * 0.12 : 0)
      + (directionalAlignment < 0 ? input.swarmConfidence * 0.1 : 0)
      + input.microNoiseScore * 0.08,
    0,
    0.82,
  );

  if (!shouldHedge) {
    hedgeRatio = 0;
  }

  const hedgeNotionalUsd = Math.abs(clusterExposureUsd) * hedgeRatio;
  const hedgeSide = hedgeNotionalUsd <= 0
    ? "flat"
    : clusterExposureUsd > 0
      ? "sell"
      : "buy";
  const hedgeCorrelation = clamp(Math.abs(hedgeCandidate?.correlation ?? 0.62), 0.35, 0.95);
  const riskReductionPct = hedgeNotionalUsd > 0
    ? clamp(hedgeRatio * hedgeCorrelation * 100, 0, 100)
    : 0;
  const readyForLive = input.observationCycles >= 20 && confidence >= 0.55 && input.microNoiseScore < 0.72;

  if (shouldHedge) {
    reasons.push(exposurePressure >= 0.04 ? "cluster_exposure_pressure" : "drawdown_volatility_pressure");
  }
  if (liquidityStress >= 0.58) {
    reasons.push("predictive_liquidity_stress");
  }
  if (directionalAlignment < 0 && input.swarmConfidence >= 0.58) {
    reasons.push("swarm_orderflow_divergence");
  }
  if (hedgeNotionalUsd > 0 && hedgeCandidate) {
    reasons.push(`hedge_with_${hedgeCandidate.symbol.toLowerCase()}`);
  }

  const state = hedgeNotionalUsd <= 0
    ? marketExposures.length > 0
      ? "MONITOR"
      : "IDLE"
    : input.mode === "live" && readyForLive
      ? "HEDGE"
      : "READY";

  return {
    mode: input.mode,
    state,
    targetSymbol,
    hedgeSymbol: hedgeNotionalUsd > 0 ? hedgeCandidate?.symbol || targetSymbol : null,
    hedgeSide,
    hedgeRatio,
    hedgeNotionalUsd,
    netExposureUsd,
    grossExposureUsd,
    selectedExposureUsd,
    clusterExposureUsd,
    concentration,
    riskReductionPct,
    confidence,
    observationCycles: input.observationCycles,
    readyForLive,
    reasons,
  };
}