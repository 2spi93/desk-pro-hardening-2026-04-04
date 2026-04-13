import { applyVisualProfile, DEFAULT_VISUAL_PROFILE, type VisualProfileName } from "./visualProfiles";
import type { SmartCandleMetrics, SmartCandleRole, SmartNoiseClass } from "./smartChartTypes";

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
  qualityScore: number;
  candleRole: SmartCandleRole;
  noiseClass: SmartNoiseClass;
  microstructureNoise: number;
};

export type PerceptionCandle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  __visual?: PerceptionVisualMetadata;
  __smart?: SmartCandleMetrics;
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
  microstructureNoiseRatio?: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function timeframeSeconds(timeframe: string): number {
  const match = String(timeframe || "").trim().match(/^(\d+)([smhdwM])$/);
  if (!match) {
    return 60;
  }

  const value = Number(match[1]);
  const unit = match[2];
  if (!Number.isFinite(value) || value <= 0) {
    return 60;
  }

  switch (unit) {
    case "s":
      return value;
    case "m":
      return value * 60;
    case "h":
      return value * 3600;
    case "d":
      return value * 86400;
    case "w":
      return value * 604800;
    case "M":
      return value * 2592000;
    default:
      return 60;
  }
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

function resolveBodyRatio(candle: PerceptionCandle, minimumRange: number): number {
  const range = Math.max(candle.high - candle.low, minimumRange, 1e-6);
  return clamp(Math.abs(candle.close - candle.open) / range, 0, 1);
}

function resolveDirectionalClosePosition(candle: PerceptionCandle, minimumRange: number): number {
  const range = Math.max(candle.high - candle.low, minimumRange, 1e-6);
  if (candle.close >= candle.open) {
    return clamp((candle.close - candle.low) / range, 0, 1);
  }
  return clamp((candle.high - candle.close) / range, 0, 1);
}

function resolveAdaptiveNoiseThreshold(candle: PerceptionCandle, ctx: PerceptionContext): number {
  const seconds = timeframeSeconds(ctx.timeframe);
  const referencePrice = Math.max(Math.abs(candle.close), Math.abs(candle.open), 1);
  const atrProxyRatio = Math.max(ctx.averageRange ?? 0, resolveMinimumRange(candle, ctx)) / referencePrice;
  const base = seconds <= 5
    ? 0.25
    : seconds <= 30
      ? 0.35
      : seconds <= 300
        ? 0.24
        : 0.18;
  const lowVolBoost = clamp((0.0012 - atrProxyRatio) / 0.0012, 0, 1) * 0.08;
  const highVolRelief = clamp((atrProxyRatio - 0.0035) / 0.008, 0, 1) * 0.08;
  const densityBoost = ctx.density === "compressed" ? 0.02 : ctx.density === "balanced" ? 0.01 : -0.01;
  const microstructureBoost = clamp(ctx.microstructureNoiseRatio ?? 0, 0, 1) * (seconds <= 5 ? 0.08 : seconds <= 30 ? 0.05 : 0.02);
  const domRelief = clamp(Math.abs(ctx.domImbalance ?? 0) * 0.08, 0, 0.05);
  return clamp(base + lowVolBoost - highVolRelief + densityBoost + microstructureBoost - domRelief, 0.12, 0.58);
}

export function classifyCleanCandle(candle: PerceptionCandle, ctx: PerceptionContext): SmartNoiseClass {
  const minimumRange = resolveMinimumRange(candle, ctx);
  const bodyRatio = resolveBodyRatio(candle, minimumRange);
  const adaptiveThreshold = resolveAdaptiveNoiseThreshold(candle, ctx);
  if (bodyRatio < adaptiveThreshold * 0.72) {
    return "noise";
  }
  if (bodyRatio < adaptiveThreshold) {
    return "weak";
  }
  return "valid";
}

export function scoreCandleQuality(candle: PerceptionCandle, ctx: PerceptionContext): SmartCandleMetrics {
  const minimumRange = resolveMinimumRange(candle, ctx);
  const range = Math.max(candle.high - candle.low, minimumRange, 1e-6);
  const body = Math.abs(candle.close - candle.open);
  const bodyRatio = resolveBodyRatio(candle, minimumRange);
  const directionalClosePosition = resolveDirectionalClosePosition(candle, minimumRange);
  const averageVolume = Math.max(ctx.averageVolume ?? Math.max(1, candle.volume), 1e-6);
  const volumeRatio = Math.max(0, candle.volume) / averageVolume;
  const volumeScore = clamp(volumeRatio / (timeframeSeconds(ctx.timeframe) <= 30 ? 1.7 : 2.2), 0, 1);
  const wickSize = Math.max(0, range - body);
  const wickToBodyRatio = wickSize / Math.max(body, minimumRange * 0.08, 1e-6);
  const noiseClass = classifyCleanCandle(candle, ctx);
  const microstructurePenalty = clamp(ctx.microstructureNoiseRatio ?? 0, 0, 1) * (timeframeSeconds(ctx.timeframe) <= 5 ? 0.18 : 0.1);
  const wickOpacityPenalty = wickToBodyRatio > 2 && volumeRatio < 0.9
    ? clamp((wickToBodyRatio - 2) * 0.08 + (0.9 - volumeRatio) * 0.18, 0, 0.36)
    : 0;
  const qualityPenalty = (noiseClass === "noise" ? 0.22 : noiseClass === "weak" ? 0.1 : 0) + microstructurePenalty + wickOpacityPenalty * 0.35;
  const qualityScore = clamp(
    bodyRatio * 0.35
      + directionalClosePosition * 0.25
      + volumeScore * 0.4
      - qualityPenalty,
    0,
    1,
  );
  const role: SmartCandleRole = qualityScore < 0.4 ? "noise" : qualityScore < 0.65 ? "context" : "trigger";

  return {
    range,
    body,
    bodyRatio,
    directionalClosePosition,
    volumeRatio,
    volumeScore,
    wickToBodyRatio,
    noiseClass,
    qualityScore,
    role,
    wickOpacityPenalty,
    adaptiveThreshold: resolveAdaptiveNoiseThreshold(candle, ctx),
    microstructurePenalty,
  };
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
  const smartMetrics = scoreCandleQuality(candle, ctx);
  const importance = clamp(candleImportance(candle, ctx) * 0.58 + smartMetrics.qualityScore * 0.42, 0, 1);
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
  const roleBoost = smartMetrics.role === "trigger" ? 0.08 : smartMetrics.role === "noise" ? -0.06 : 0;
  const noiseOpacityPenalty = smartMetrics.noiseClass === "noise" ? 0.14 : smartMetrics.noiseClass === "weak" ? 0.06 : 0;
  const bodyBoost = rangeRatio * (1 + importance * 0.04 + lastCandleEmphasis * 0.8)
    + bodyPresenceBoost
    + (volumeRatio - 1) * 0.08
    + roleBoost
    - smartMetrics.microstructurePenalty * 0.12;
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
      clamp(
        baseOpacity
          - (ctx.isLast ? 0.04 : 0)
          + importance * 0.04
          + smartMetrics.qualityScore * 0.05
          + lastCandleEmphasis * 0.4
          + (lowRange ? 0.03 : 0)
          + (ctx.isLast && lowRange ? 0.03 : 0),
        opacityFloor,
        formingOpacityCap,
      ) - noiseOpacityPenalty,
      opacityFloor,
      formingOpacityCap,
    ),
    wickWidth,
    bodyBoost,
    intensity: intensity + lastCandleEmphasis + smartMetrics.qualityScore * 0.05,
    wickOpacity: clamp(
      (wickSignalPriority ? 1 : wickMediumPriority ? 0.85 : 0.4)
        + signalBoost * 0.1
        + wickWeight * (wickSignalPriority ? 0.06 : wickMediumPriority ? 0.03 : 0)
        - (lowRange && signalType === "neutral" ? 0.05 : 0)
        - (signalType === "neutral" ? densePenalty : densePenalty * 0.4)
        - smartMetrics.wickOpacityPenalty,
      wickOpacityFloor,
      wickOpacityCeiling,
    ),
    importance,
  };
}

export function enhanceWick(candle: PerceptionCandle, ctx: PerceptionContext, smartMetrics?: SmartCandleMetrics): {
  high: number;
  low: number;
  wickBoost: number;
} {
  const profile = applyVisualProfile(ctx.visualProfile ?? DEFAULT_VISUAL_PROFILE);
  const wickWeight = wickIntensity(candle, ctx);
  const wickProfile = resolveWickProfile(candle);
  const smartBoost = smartMetrics
    ? clamp(
      (smartMetrics.role === "trigger" ? 0.1 : smartMetrics.noiseClass === "noise" ? 0.08 : 0.04)
        + smartMetrics.qualityScore * 0.08
        + smartMetrics.microstructurePenalty * 0.14,
      0,
      0.24,
    )
    : 0;
  const minWick = Math.max(
    candle.close * 0.0005,
    resolveMinimumRange(candle, ctx) * (ctx.density === "compressed" ? 0.72 : 0.48) * (1 + wickWeight * 0.24 + smartBoost),
  );
  const profileBias = 1 + profile.motion.directionBounce * 0.5;
  const outwardExtension = minWick * clamp((wickWeight > 0.45 ? 0.08 : 0.03) + smartBoost * 0.4, 0.02, 0.16);
  const nextHigh = Math.max(
    candle.high,
    candle.close + minWick * profileBias,
    candle.open + minWick * 0.22,
    candle.high + outwardExtension * (wickProfile.type === "rejection" ? 1 : 0.55),
  );
  const nextLow = Math.min(
    candle.low,
    candle.close - minWick * profileBias,
    candle.open - minWick * 0.22,
    candle.low - outwardExtension * (wickProfile.type === "absorption" ? 1 : 0.55),
  );
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
  const smartMetrics = scoreCandleQuality(candle, ctx);
  const visualStyle = getCandleVisualStyle(candle, ctx);
  const momentum = momentumBoost(candle, prev, ctx);
  const signalType = wickType(candle);
  const wick = enhanceWick(candle, ctx, smartMetrics);

  return {
    ...candle,
    high: wick.high,
    low: wick.low,
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
      qualityScore: smartMetrics.qualityScore,
      candleRole: smartMetrics.role,
      noiseClass: smartMetrics.noiseClass,
      microstructureNoise: smartMetrics.microstructurePenalty,
    },
    __smart: smartMetrics,
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

export function applySmartCleanPipeline(candles: PerceptionCandle[], ctx: PerceptionContext): PerceptionCandle[] {
  return applyPerceptionPipeline(candles, ctx);
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