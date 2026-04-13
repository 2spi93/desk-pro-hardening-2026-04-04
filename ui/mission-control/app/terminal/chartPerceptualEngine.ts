type DensityLevel = "micro" | "compact" | "normal" | "expanded";

export type ComputePerceptualCandleInput = {
  barSpacingPx: number;
  targetSpacingPx: number;
  visibleBars: number;
  timeframe: string;
  volatility: number;
  devicePixelRatio: number;
  densityLevel: DensityLevel;
  preferredBodyWidthPx?: number;
  minGapPx?: number;
};

export type ComputePerceptualCandleResult = {
  baseBodyWidthPx: number;
  bodyWidthPx: number;
  wickWidthPx: number;
  overlayWidthPx: number;
  formingWidthPx: number;
  timeframeWeight: number;
  densityFactor: number;
  volatilityFactor: number;
  zoomFactor: number;
  minBodyWidthPx: number;
  maxBodyWidthPx: number;
  bodyToSpacingRatio: number;
};

export type PerceptualDeskMode = "micro" | "macro" | "execution";

export type PerceptualExecutionSignal = {
  timeKey: string;
  fillProbability: number;
  slippageBps: number;
  latencyMs: number;
  routeScore: number;
  edgeBps: number;
  blockedRatio: number;
  partialFillRatio: number;
  confidence: number;
};

export type PerceptualHeatSegment = {
  intensity: number;
  deltaRatio: number;
  buyShare: number;
  absorption: number;
};

export type PerceptualCandleFlowState = {
  timeKey: string;
  volume: number;
  delta: number;
  imbalance: number;
  absorption: number;
  liquidity: {
    bid: number;
    ask: number;
    absorption: number;
  };
  execution: PerceptualExecutionSignal;
  heatSegments: PerceptualHeatSegment[];
};

export type ResolvePerceptualDeskModeInput = {
  chartMode: "line" | "candles" | "footprint";
  timeframe: string;
  visibleBars: number;
  volatility: number;
  domImbalanceRatio: number;
  domLevels?: Array<{ side: "bid" | "ask"; size: number; intensity: number }>;
  heatmapLevels?: Array<{ side: "bid" | "ask"; size: number; intensity: number }>;
  footprintRows?: Array<{ buyVolume: number; sellVolume: number; delta: number }>;
  isLiteMode: boolean;
};

export type ResolvePerceptualDeskModeResult = {
  mode: PerceptualDeskMode;
  authoritativeRenderer: boolean;
  liquidityScore: number;
  heatScore: number;
  deltaScore: number;
  executionScore: number;
  confidence: number;
  bodyWeight: number;
  wickWeight: number;
  overlayWeight: number;
  heatAlpha: number;
  coneAlpha: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function timeframeToSeconds(timeframe: string): number {
  const match = timeframe.trim().match(/^(\d+)(s|m|h|d|w|M)$/i);
  if (!match) {
    return 300;
  }

  const amount = Math.max(1, Number(match[1]));
  const unit = match[2];
  switch (unit) {
    case "s":
    case "S":
      return amount;
    case "m":
      return amount * 60;
    case "h":
      return amount * 3600;
    case "d":
      return amount * 86400;
    case "w":
      return amount * 604800;
    case "M":
      return amount * 2592000;
    default:
      return 300;
  }
}

export function alignToPixelGrid(width: number, devicePixelRatio: number): number {
  const dpr = Math.max(1, devicePixelRatio || 1);
  return Math.round(width * dpr) / dpr;
}

export function computeTimeframeWeight(timeframe: string): number {
  const exactMap: Record<string, number> = {
    "1m": 0.75,
    "5m": 0.9,
    "15m": 1.05,
    "1h": 1.25,
    "4h": 1.4,
    "1d": 1.6,
  };
  if (exactMap[timeframe]) {
    return exactMap[timeframe];
  }

  const seconds = timeframeToSeconds(timeframe);
  if (seconds <= 60) return 0.75;
  if (seconds <= 5 * 60) return 0.9;
  if (seconds <= 15 * 60) return 1.05;
  if (seconds <= 60 * 60) return 1.25;
  if (seconds <= 4 * 60 * 60) return 1.4;
  if (seconds <= 24 * 60 * 60) return 1.6;
  return 1.72;
}

export function computeDensityFactor(visibleBars: number): number {
  if (visibleBars > 400) return 0.6;
  if (visibleBars > 250) return 0.75;
  if (visibleBars > 150) return 0.9;
  if (visibleBars > 80) return 1;
  if (visibleBars > 40) return 1.12;
  return 1.25;
}

export function computeVolatilityFactor(volatility: number): number {
  if (!Number.isFinite(volatility) || volatility <= 0) {
    return 1;
  }
  if (volatility > 0.0075) return 1.16;
  if (volatility > 0.0045) return 1.08;
  if (volatility < 0.001) return 0.9;
  if (volatility < 0.0018) return 0.95;
  return 1;
}

export function computeZoomFactor(barSpacingPx: number, targetSpacingPx: number): number {
  const safeSpacing = Math.max(2, barSpacingPx || 2);
  const safeTarget = Math.max(2, targetSpacingPx || safeSpacing);
  const ratio = safeSpacing / safeTarget;
  return clamp(1 + (1 - ratio) * 0.24, 0.88, 1.16);
}

export function computePerceptualWickWidth(bodyWidthPx: number, devicePixelRatio: number, emphasis = 1): number {
  const dpr = Math.max(1, devicePixelRatio || 1);
  const minWickWidthPx = 1 / dpr;
  const maxWickWidthPx = Math.max(minWickWidthPx, bodyWidthPx - minWickWidthPx);
  const ratio = clamp(0.4 * Math.max(0.82, emphasis), bodyWidthPx >= 6 ? 0.3 : 0.24, 0.48);
  const rawWidthPx = bodyWidthPx * ratio;
  return clamp(alignToPixelGrid(rawWidthPx, dpr), minWickWidthPx, maxWickWidthPx);
}

export function computePerceptualCandle(input: ComputePerceptualCandleInput): ComputePerceptualCandleResult {
  const safeSpacingPx = clamp(input.barSpacingPx, 2, 80);
  const safeTargetSpacingPx = clamp(input.targetSpacingPx, 2, 80);
  const safeVisibleBars = Math.max(1, Math.round(input.visibleBars || 1));
  const minimumReadableBodyWidthPx = input.densityLevel === "micro" ? 2.6 : 3;
  const baseBodyWidthPx = clamp(
    Number.isFinite(input.preferredBodyWidthPx) && Number(input.preferredBodyWidthPx) > 0
      ? Number(input.preferredBodyWidthPx)
      : safeSpacingPx * 0.78,
    minimumReadableBodyWidthPx,
    Math.max(minimumReadableBodyWidthPx, Math.min(12, safeSpacingPx * 0.88)),
  );
  const timeframeWeight = computeTimeframeWeight(input.timeframe);
  const densityFactor = computeDensityFactor(safeVisibleBars);
  const volatilityFactor = computeVolatilityFactor(input.volatility);
  const zoomFactor = computeZoomFactor(safeSpacingPx, safeTargetSpacingPx);
  const minBodyWidthPx = minimumReadableBodyWidthPx;
  const maxBodyWidthPx = clamp(Math.min(12, safeSpacingPx * 0.94), minBodyWidthPx, 14);
  const rawBodyWidthPx = baseBodyWidthPx * timeframeWeight * densityFactor * volatilityFactor * zoomFactor;
  const bodyWidthPx = alignToPixelGrid(clamp(rawBodyWidthPx, minBodyWidthPx, maxBodyWidthPx), input.devicePixelRatio);
  const wickWidthPx = computePerceptualWickWidth(bodyWidthPx, input.devicePixelRatio);
  const minGapPx = Math.max(1.1, input.minGapPx || 1.1);
  const overlayWidthPx = alignToPixelGrid(
    clamp(Math.max(safeSpacingPx, bodyWidthPx + minGapPx), 10, 64),
    input.devicePixelRatio,
  );
  const formingWidthPx = alignToPixelGrid(
    clamp(Math.min(bodyWidthPx, safeSpacingPx * 0.94), minBodyWidthPx, maxBodyWidthPx),
    input.devicePixelRatio,
  );

  return {
    baseBodyWidthPx,
    bodyWidthPx,
    wickWidthPx,
    overlayWidthPx,
    formingWidthPx,
    timeframeWeight,
    densityFactor,
    volatilityFactor,
    zoomFactor,
    minBodyWidthPx,
    maxBodyWidthPx,
    bodyToSpacingRatio: bodyWidthPx / safeSpacingPx,
  };
}

function normalizeScore(value: number, ceiling: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return clamp(value / Math.max(1, ceiling), 0, 1);
}

export function resolvePerceptualDeskMode(input: ResolvePerceptualDeskModeInput): ResolvePerceptualDeskModeResult {
  const tfSeconds = timeframeToSeconds(input.timeframe);
  const visibleBars = Math.max(1, Math.round(input.visibleBars || 1));
  const domLiquidity = (input.domLevels || []).reduce((sum, level) => sum + Math.max(0, level.size) * Math.max(0.2, level.intensity || 0), 0);
  const heatLiquidity = (input.heatmapLevels || []).reduce((sum, level) => sum + Math.max(0, level.size) * Math.max(0.2, level.intensity || 0), 0);
  const footprint = (input.footprintRows || []).reduce((acc, row) => {
    acc.total += Math.max(0, row.buyVolume) + Math.max(0, row.sellVolume);
    acc.delta += Math.abs(row.delta);
    return acc;
  }, { total: 0, delta: 0 });
  const liquidityScore = clamp(
    normalizeScore(domLiquidity, 32000) * 0.7 + normalizeScore(heatLiquidity, 42000) * 0.3,
    0,
    1,
  );
  const heatScore = normalizeScore(heatLiquidity, 42000);
  const deltaScore = footprint.total > 0 ? clamp(footprint.delta / footprint.total, 0, 1) : 0;
  const volatilityScore = clamp(normalizeScore(input.volatility, 0.0085), 0, 1);
  const executionScore = clamp(
    Math.abs(input.domImbalanceRatio) * 0.34 + liquidityScore * 0.28 + heatScore * 0.14 + deltaScore * 0.14 + volatilityScore * 0.1,
    0,
    1,
  );
  const microScore = clamp(
    (tfSeconds <= 5 * 60 ? 0.56 : tfSeconds <= 15 * 60 ? 0.34 : 0.14)
    + (visibleBars >= 100 ? 0.22 : visibleBars >= 72 ? 0.14 : 0.05)
    + executionScore * 0.18,
    0,
    1,
  );
  const macroScore = clamp(
    (tfSeconds >= 4 * 60 * 60 ? 0.58 : tfSeconds >= 60 * 60 ? 0.36 : 0.08)
    + (visibleBars <= 64 ? 0.2 : visibleBars <= 88 ? 0.1 : 0)
    + (1 - executionScore) * 0.1,
    0,
    1,
  );

  let mode: PerceptualDeskMode = "micro";
  if (input.chartMode !== "candles") {
    mode = tfSeconds >= 60 * 60 ? "macro" : "micro";
  } else if (executionScore >= 0.52 && tfSeconds <= 4 * 60 * 60) {
    mode = "execution";
  } else if (macroScore > microScore + 0.04) {
    mode = "macro";
  }

  const profile = mode === "execution"
    ? { bodyWeight: 1.04, wickWeight: 1.24, overlayWeight: 1.08, heatAlpha: 0.22, coneAlpha: 0.16, confidence: executionScore }
    : mode === "macro"
      ? { bodyWeight: 1.12, wickWeight: 0.92, overlayWeight: 1.02, heatAlpha: 0.08, coneAlpha: 0.05, confidence: macroScore }
      : { bodyWeight: 0.98, wickWeight: 1.08, overlayWeight: 1.04, heatAlpha: 0.14, coneAlpha: 0.08, confidence: microScore };

  return {
    mode,
    authoritativeRenderer: false,
    liquidityScore,
    heatScore,
    deltaScore,
    executionScore,
    confidence: clamp(profile.confidence, 0, 1),
    bodyWeight: profile.bodyWeight,
    wickWeight: profile.wickWeight,
    overlayWeight: profile.overlayWeight,
    heatAlpha: profile.heatAlpha,
    coneAlpha: profile.coneAlpha,
  };
}