import { applyVisualProfile, DEFAULT_VISUAL_PROFILE, type VisualProfileName } from "./visualProfiles";

export type PerceptionDensity = "expanded" | "balanced" | "compressed";

export type PerceptionVisualMetadata = {
  intensity: number;
  direction: 1 | -1;
  wickBoost: number;
  smoothingAlpha: number;
  opacity: number;
  wickWidth: number;
  bodyBoost: number;
  momentumScale: number;
  wickOpacity: number;
  importance: number;
  wickType: "absorption" | "rejection" | "neutral";
  lastCandleEmphasis: number;
};

export type PerceptionCandle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  __visual?: PerceptionVisualMetadata;
};

export type PerceptionContext = {
  density: PerceptionDensity;
  timeframe: string;
  volatility: number;
  visualProfile?: VisualProfileName;
  domImbalance?: number;
  averageRange?: number;
  averageVolume?: number;
  isLast?: boolean;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function resolveSmoothingAlpha(ctx: PerceptionContext): number {
  const profile = applyVisualProfile(ctx.visualProfile ?? DEFAULT_VISUAL_PROFILE);
  const timeframe = ctx.timeframe.trim();
  const isFast = timeframe.includes("1m") || timeframe.includes("s");
  const isUltraFast = timeframe.includes("s");
  const densityAdjustment = ctx.density === "compressed" ? 0.04 : ctx.density === "balanced" ? 0.02 : -0.01;
  const volatilityBoost = clamp(ctx.volatility * 8, 0, isFast ? 0.08 : 0.05);
  return clamp(profile.perception.intraCandleSmoothing + densityAdjustment + volatilityBoost - (isUltraFast ? 0.03 : 0), 0.06, 0.4);
}

function resolveMinimumRange(candle: PerceptionCandle, ctx: PerceptionContext): number {
  const reference = Math.max(Math.abs(candle.close), Math.abs(candle.open), 1);
  const densityFactor = ctx.density === "compressed" ? 0.00014 : ctx.density === "balanced" ? 0.0001 : 0.00008;
  const volatilityFloor = clamp(ctx.volatility * reference * 0.55, reference * 0.00002, reference * 0.0014);
  return Math.max(reference * densityFactor, volatilityFloor);
}

function resolveWickProfile(candle: PerceptionCandle): {
  type: "absorption" | "rejection" | "neutral";
  dominantRatio: number;
} {
  const range = Math.max(0, candle.high - candle.low);
  if (range <= 0) {
    return { type: "neutral", dominantRatio: 0 };
  }

  const upperWick = Math.max(0, candle.high - Math.max(candle.open, candle.close));
  const lowerWick = Math.max(0, Math.min(candle.open, candle.close) - candle.low);
  const dominantRatio = Math.max(upperWick, lowerWick) / range;

  if (dominantRatio > 0.6) {
    return {
      type: upperWick >= lowerWick ? "rejection" : "absorption",
      dominantRatio,
    };
  }

  if (dominantRatio > 0.35) {
    return {
      type: upperWick >= lowerWick ? "rejection" : "absorption",
      dominantRatio,
    };
  }

  return { type: "neutral", dominantRatio };
}

export function wickIntensity(candle: PerceptionCandle, ctx: PerceptionContext): number {
  const profile = applyVisualProfile(ctx.visualProfile ?? DEFAULT_VISUAL_PROFILE);
  const range = Math.max(0, candle.high - candle.low);
  const body = Math.abs(candle.close - candle.open);
  const wickProfile = resolveWickProfile(candle);
  const bodyCompression = clamp((range - body) / Math.max(range, 1e-6), 0, 1);
  const domBias = profile.perception.domWickSmoothing ? Math.abs(ctx.domImbalance ?? 0) * 0.18 : 0;
  return clamp(wickProfile.dominantRatio * 1.1 + bodyCompression * 0.28 + domBias, 0, 1.5);
}

export function candleImportance(candle: PerceptionCandle, ctx: PerceptionContext): number {
  const averageRange = Math.max(ctx.averageRange ?? 0, resolveMinimumRange(candle, ctx), 1e-6);
  const rawRange = Math.max(0, candle.high - candle.low);
  const priceMoveScore = clamp(rawRange / averageRange, 0, 1);
  const averageVolume = Math.max(ctx.averageVolume ?? 0, 1e-6);
  const avgVolumeScore = clamp(Math.max(0, candle.volume) / averageVolume, 0, 1);
  const domImbalanceScore = clamp(Math.abs(ctx.domImbalance ?? 0) / 0.35, 0, 1);

  return clamp(
    priceMoveScore * 0.56
      + avgVolumeScore * 0.24
      + domImbalanceScore * 0.2,
    0,
    1,
  );
}

export function wickType(candle: PerceptionCandle): "absorption" | "rejection" | "neutral" {
  return resolveWickProfile(candle).type;
}

export function getCandleVisualStyle(candle: PerceptionCandle, ctx: PerceptionContext): {
  opacity: number;
  wickWidth: number;
  bodyBoost: number;
  intensity: number;
  wickOpacity: number;
  importance: number;
} {
  const profile = applyVisualProfile(ctx.visualProfile ?? DEFAULT_VISUAL_PROFILE);
  const importance = candleImportance(candle, ctx);
  const wickProfile = resolveWickProfile(candle);
  const wickWeight = wickIntensity(candle, ctx);
  const signalType = wickProfile.type;
  const signalBoost = signalType === "neutral" ? 0 : 0.12;
  const intensity = clamp(1 + importance * 0.26 + wickWeight * 0.08, 1, 1.45);
  const lastCandleEmphasis = ctx.isLast ? 0.03 + profile.perception.lastCandleGlow : 0;
  const formingOpacityCap = ctx.isLast ? 0.82 : 0.94;
  const baseOpacity = ctx.density === "compressed" ? 0.92 : 0.94;
  const wickOpacityBase = ctx.isLast ? 0.72 : 0.8;
  const avgRange = Math.max(ctx.averageRange ?? 0, resolveMinimumRange(candle, ctx), 1e-6);
  const rawRange = Math.max(0, candle.high - candle.low);
  const body = Math.abs(candle.close - candle.open);
  const referencePrice = Math.max(Math.abs(candle.close), Math.abs(candle.open), 1);
  const rangeRatio = clamp(rawRange / avgRange, 0.8, 1.4);
  const lowRangeRatio = rawRange / avgRange;
  const rangePct = rawRange / referencePrice;
  const isUltraFast = ctx.timeframe.includes("s");
  const lowRange = rangePct < (isUltraFast ? 0.0009 : 0.0015) || lowRangeRatio < (isUltraFast ? 0.1 : 0.18);
  const densePenalty = (ctx.density === "compressed" ? 0.12 : ctx.density === "balanced" ? 0.05 : 0) * (isUltraFast ? 0.55 : 1);
  const wickSignalPriority = wickProfile.dominantRatio > 0.6;
  const wickMediumPriority = !wickSignalPriority && wickProfile.dominantRatio > 0.35;
  const averageVolume = Math.max(ctx.averageVolume ?? 0, 1e-6);
  const volumeRatio = clamp(Math.max(0, candle.volume) / averageVolume, 0.65, 1.35);
  const bodyPresenceBoost = lowRange ? (ctx.isLast ? 0.22 : 0.16) : 0;
  const bodyBoost = rangeRatio * (1 + importance * 0.04 + lastCandleEmphasis * 0.8)
    + bodyPresenceBoost
    + (volumeRatio - 1) * 0.08;
  const wickWidth = wickSignalPriority
    ? 1.8
    : wickMediumPriority
      ? 1.2
      : 1;
  const opacityFloor = ctx.isLast
    ? (lowRange ? 0.8 : 0.74)
    : (lowRange ? 0.78 : 0.74);
  const wickOpacityFloor = ctx.isLast
    ? (wickSignalPriority ? 0.9 : wickMediumPriority ? 0.72 : 0.4)
    : (wickSignalPriority ? 0.9 : wickMediumPriority ? 0.76 : 0.4);
  const wickOpacityCeiling = wickSignalPriority ? 1 : wickMediumPriority ? 0.88 : 0.52;

  return {
    opacity: clamp(
      baseOpacity
        - (ctx.isLast ? 0.04 : 0)
        + importance * 0.04
        + lastCandleEmphasis * 0.4
        + (lowRange ? 0.03 : 0)
        + (ctx.isLast && lowRange ? 0.03 : 0),
      opacityFloor,
      formingOpacityCap,
    ),
    wickWidth,
    bodyBoost,
    intensity: intensity + lastCandleEmphasis,
    wickOpacity: clamp(
      (wickSignalPriority ? 1 : wickMediumPriority ? 0.85 : 0.4)
        + signalBoost * 0.1
        + wickWeight * (wickSignalPriority ? 0.06 : wickMediumPriority ? 0.03 : 0)
        - (lowRange && signalType === "neutral" ? 0.05 : 0)
        - (signalType === "neutral" ? densePenalty : densePenalty * 0.4),
      wickOpacityFloor,
      wickOpacityCeiling,
    ),
    importance,
  };
}

export function enhanceWick(candle: PerceptionCandle, ctx: PerceptionContext): {
  high: number;
  low: number;
  wickBoost: number;
} {
  const profile = applyVisualProfile(ctx.visualProfile ?? DEFAULT_VISUAL_PROFILE);
  const wickWeight = wickIntensity(candle, ctx);
  const minWick = Math.max(
    candle.close * 0.0005,
    resolveMinimumRange(candle, ctx) * (ctx.density === "compressed" ? 0.72 : 0.48) * (1 + wickWeight * 0.24),
  );
  const profileBias = 1 + profile.motion.directionBounce * 0.5;
  const nextHigh = Math.max(candle.high, candle.close + minWick * profileBias, candle.open + minWick * 0.22);
  const nextLow = Math.min(candle.low, candle.close - minWick * profileBias, candle.open - minWick * 0.22);
  const wickBoost = Math.max(nextHigh - candle.high, candle.low - nextLow, 0);

  return {
    high: nextHigh,
    low: nextLow,
    wickBoost,
  };
}

export function momentumBoost(
  current: PerceptionCandle,
  prev: PerceptionCandle | null,
  ctx: PerceptionContext,
): { scale: number } {
  const profile = applyVisualProfile(ctx.visualProfile ?? DEFAULT_VISUAL_PROFILE);
  if (!prev) {
    return { scale: 1 };
  }

  const delta = current.close - prev.close;
  const speed = Math.abs(delta) / Math.max(Math.abs(current.close), 1);
  return {
    scale: 1 + Math.min(speed * 50, 0.15 + profile.motion.bodyInertia * 0.2),
  };
}

export function resolvePerceptionDensity(input: { densityLevel?: string; visibleBars?: number }): PerceptionDensity {
  if (input.densityLevel === "micro" || input.densityLevel === "compact") {
    return "compressed";
  }
  if (input.densityLevel === "normal") {
    return "balanced";
  }
  if (input.densityLevel === "expanded") {
    return "expanded";
  }

  const visibleBars = Math.max(0, Math.round(input.visibleBars || 0));
  if (visibleBars >= 150) {
    return "compressed";
  }
  if (visibleBars >= 50) {
    return "balanced";
  }
  return "expanded";
}

export function perceptionTransform(
  candle: PerceptionCandle,
  prev: PerceptionCandle | null,
  ctx: PerceptionContext,
): PerceptionCandle {
  const smoothingAlpha = resolveSmoothingAlpha(ctx);
  const direction: 1 | -1 = candle.close >= candle.open ? 1 : -1;
  const profile = applyVisualProfile(ctx.visualProfile ?? DEFAULT_VISUAL_PROFILE);
  const visualStyle = getCandleVisualStyle(candle, ctx);
  const momentum = momentumBoost(candle, prev, ctx);
  const signalType = wickType(candle);
  const wick = enhanceWick(candle, ctx);

  return {
    ...candle,
    __visual: {
      intensity: visualStyle.intensity,
      direction,
      wickBoost: wick.wickBoost,
      smoothingAlpha,
      opacity: visualStyle.opacity,
      wickWidth: visualStyle.wickWidth,
      bodyBoost: visualStyle.bodyBoost,
      momentumScale: momentum.scale,
      wickOpacity: visualStyle.wickOpacity,
      importance: visualStyle.importance,
      wickType: signalType,
      lastCandleEmphasis: ctx.isLast ? 0.03 + profile.perception.lastCandleGlow : 0,
    },
  };
}

export function applyPerceptionPipeline(candles: PerceptionCandle[], ctx: PerceptionContext): PerceptionCandle[] {
  const transformed: PerceptionCandle[] = [];
  let averageRange = 0;
  let averageVolume = 0;

  for (let index = 0; index < candles.length; index += 1) {
    const current = candles[index];
    const currentRange = Math.max(0, current.high - current.low);
    const currentVolume = Math.max(0, current.volume);
    averageRange = averageRange > 0
      ? averageRange * 0.88 + currentRange * 0.12
      : currentRange;
    averageVolume = averageVolume > 0
      ? averageVolume * 0.88 + currentVolume * 0.12
      : currentVolume;
    const next = perceptionTransform(current, transformed[index - 1] ?? null, {
      ...ctx,
      averageRange,
      averageVolume,
      isLast: index === candles.length - 1,
    });
    transformed.push(next);
  }

  return transformed;
}

export function shouldConflatePerceptualUpdate(
  previous: Pick<PerceptionCandle, "time" | "open" | "high" | "low" | "close"> | null,
  next: Pick<PerceptionCandle, "time" | "open" | "high" | "low" | "close">,
  ctx: PerceptionContext,
): boolean {
  if (!previous || previous.time !== next.time || ctx.density === "expanded") {
    return false;
  }

  const reference = Math.max(Math.abs(next.close), Math.abs(previous.close), 1);
  const densityFactor = ctx.density === "compressed" ? 0.00016 : 0.00008;
  const volatilityFactor = clamp(ctx.volatility * 12, 0, ctx.density === "compressed" ? 0.8 : 0.45);
  const epsilon = Math.max(reference * densityFactor * (1 + volatilityFactor), reference * 0.00001);
  const maxDrift = Math.max(
    Math.abs(next.open - previous.open),
    Math.abs(next.high - previous.high),
    Math.abs(next.low - previous.low),
    Math.abs(next.close - previous.close),
  );

  return maxDrift < epsilon;
}