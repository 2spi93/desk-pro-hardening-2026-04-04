export type CrossAssetPosition = {
  symbol: string;
  market: string;
  netNotionalUsd: number;
};

export type CrossAssetCandidate = {
  symbol: string;
  market: string;
  liquidityScore: number;
  spreadBps: number;
  correlation?: number | null;
};

export type CrossAssetCorrelationMatrix = Record<string, Record<string, number>>;

export type CrossAssetBetaLeg = {
  symbol: string;
  market: string;
  netNotionalUsd: number;
  correlation: number;
  betaExposureUsd: number;
};

export type CrossAssetExposureSnapshot = {
  targetSymbol: string;
  market: string;
  targetNetNotionalUsd: number;
  marketNetBetaExposureUsd: number;
  grossExposureUsd: number;
  concentration: number;
  betaPressureRatio: number;
  legs: CrossAssetBetaLeg[];
};

export type CrossAssetHedgePlan = {
  hedgeSymbol: string | null;
  hedgeSide: "buy" | "sell" | "flat";
  hedgeRatio: number;
  hedgeNotionalUsd: number;
  confidence: number;
  reasons: string[];
};

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

function toNumber(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : Number.NaN;
}

function normalizeSeries(values: unknown[]): number[] {
  return values
    .map((item) => {
      if (typeof item === "number") {
        return item;
      }
      if (item && typeof item === "object" && "value" in item) {
        return toNumber((item as { value?: unknown }).value);
      }
      return Number.NaN;
    })
    .filter((value) => Number.isFinite(value) && value > 0);
}

function computeReturns(values: number[]): number[] {
  if (values.length < 2) {
    return [];
  }
  const returns: number[] = [];
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (!(previous > 0) || !Number.isFinite(current)) {
      continue;
    }
    returns.push((current - previous) / previous);
  }
  return returns;
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function pearson(left: number[], right: number[]): number {
  const sampleSize = Math.min(left.length, right.length);
  if (sampleSize < 6) {
    return 0;
  }
  const xs = left.slice(-sampleSize);
  const ys = right.slice(-sampleSize);
  const meanX = average(xs);
  const meanY = average(ys);
  let numerator = 0;
  let denominatorX = 0;
  let denominatorY = 0;
  for (let index = 0; index < sampleSize; index += 1) {
    const dx = xs[index] - meanX;
    const dy = ys[index] - meanY;
    numerator += dx * dy;
    denominatorX += dx * dx;
    denominatorY += dy * dy;
  }
  const denominator = Math.sqrt(denominatorX * denominatorY);
  if (!(denominator > 0)) {
    return 0;
  }
  return clamp(numerator / denominator, -0.98, 0.98);
}

export function computeCorrelations(series: Record<string, unknown[]>): CrossAssetCorrelationMatrix {
  const normalizedEntries = Object.entries(series)
    .map(([symbol, values]) => [symbol, computeReturns(normalizeSeries(values))] as const)
    .filter(([, values]) => values.length >= 6);
  const matrix: CrossAssetCorrelationMatrix = {};
  for (const [symbol] of normalizedEntries) {
    matrix[symbol] = { [symbol]: 1 };
  }
  for (let leftIndex = 0; leftIndex < normalizedEntries.length; leftIndex += 1) {
    const [leftSymbol, leftSeries] = normalizedEntries[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < normalizedEntries.length; rightIndex += 1) {
      const [rightSymbol, rightSeries] = normalizedEntries[rightIndex];
      const correlation = pearson(leftSeries, rightSeries);
      matrix[leftSymbol] = { ...(matrix[leftSymbol] || {}), [rightSymbol]: correlation };
      matrix[rightSymbol] = { ...(matrix[rightSymbol] || {}), [leftSymbol]: correlation };
    }
  }
  return matrix;
}

export function computeBetaExposure(
  positions: CrossAssetPosition[],
  correlations: CrossAssetCorrelationMatrix,
): CrossAssetExposureSnapshot {
  const filtered = positions.filter((item) => item.symbol && Math.abs(item.netNotionalUsd) > 1);
  if (filtered.length === 0) {
    return {
      targetSymbol: "",
      market: "unknown",
      targetNetNotionalUsd: 0,
      marketNetBetaExposureUsd: 0,
      grossExposureUsd: 0,
      concentration: 0,
      betaPressureRatio: 0,
      legs: [],
    };
  }

  const anchor = filtered[0];
  const grossExposureUsd = filtered.reduce((sum, item) => sum + Math.abs(item.netNotionalUsd), 0);
  const legs = filtered.map((item) => {
    const correlation = item.symbol === anchor.symbol
      ? 1
      : clamp(correlations[anchor.symbol]?.[item.symbol] ?? correlations[item.symbol]?.[anchor.symbol] ?? 0, -0.98, 0.98);
    return {
      symbol: item.symbol,
      market: item.market,
      netNotionalUsd: item.netNotionalUsd,
      correlation,
      betaExposureUsd: item.netNotionalUsd * correlation,
    };
  });
  const marketNetBetaExposureUsd = legs.reduce((sum, item) => sum + item.betaExposureUsd, 0);
  return {
    targetSymbol: anchor.symbol,
    market: anchor.market,
    targetNetNotionalUsd: anchor.netNotionalUsd,
    marketNetBetaExposureUsd,
    grossExposureUsd,
    concentration: clamp(Math.abs(anchor.netNotionalUsd) / Math.max(1, grossExposureUsd), 0, 1),
    betaPressureRatio: clamp(Math.abs(marketNetBetaExposureUsd) / Math.max(1, grossExposureUsd), 0, 1.5),
    legs: legs.sort((left, right) => Math.abs(right.betaExposureUsd) - Math.abs(left.betaExposureUsd)),
  };
}

export function crossAssetHedge(
  exposure: CrossAssetExposureSnapshot,
  market: string,
  candidates: CrossAssetCandidate[] = [],
): CrossAssetHedgePlan {
  if (!exposure.targetSymbol || Math.abs(exposure.marketNetBetaExposureUsd) <= 250 || exposure.market !== market) {
    return {
      hedgeSymbol: null,
      hedgeSide: "flat",
      hedgeRatio: 0,
      hedgeNotionalUsd: 0,
      confidence: 0,
      reasons: ["beta_pressure_idle"],
    };
  }

  const bestCandidate = candidates
    .filter((item) => item.market === market && item.symbol !== exposure.targetSymbol)
    .sort((left, right) => {
      const leftScore = Math.abs(left.correlation ?? 0) * 0.58 + clamp(left.liquidityScore, 0, 1) * 0.27 + (1 - clamp(left.spreadBps / 20, 0, 1)) * 0.15;
      const rightScore = Math.abs(right.correlation ?? 0) * 0.58 + clamp(right.liquidityScore, 0, 1) * 0.27 + (1 - clamp(right.spreadBps / 20, 0, 1)) * 0.15;
      return rightScore - leftScore;
    })[0] || null;

  const bestCorrelation = clamp(Math.abs(bestCandidate?.correlation ?? exposure.legs[1]?.correlation ?? 0.45), 0.18, 0.96);
  const hedgeRatio = clamp(
    0.22
      + exposure.betaPressureRatio * 0.5
      + exposure.concentration * 0.18
      + bestCorrelation * 0.12,
    0,
    0.92,
  );
  const hedgeNotionalUsd = Math.abs(exposure.marketNetBetaExposureUsd) * hedgeRatio;
  const confidence = clamp(
    exposure.betaPressureRatio * 0.42
      + exposure.concentration * 0.16
      + bestCorrelation * 0.24
      + clamp(bestCandidate?.liquidityScore ?? 0.45, 0, 1) * 0.18,
    0,
    1,
  );
  const reasons = [
    "cross_asset_beta_pressure",
    exposure.betaPressureRatio >= 0.42 ? "systemic_exposure_cluster" : "beta_tilt_watch",
    bestCandidate ? `cross_asset_hedge_${bestCandidate.symbol.toLowerCase()}` : "proxy_hedge_missing",
  ];

  return {
    hedgeSymbol: hedgeNotionalUsd > 0 ? bestCandidate?.symbol || null : null,
    hedgeSide: hedgeNotionalUsd <= 0
      ? "flat"
      : exposure.marketNetBetaExposureUsd > 0
        ? "sell"
        : "buy",
    hedgeRatio,
    hedgeNotionalUsd,
    confidence,
    reasons,
  };
}