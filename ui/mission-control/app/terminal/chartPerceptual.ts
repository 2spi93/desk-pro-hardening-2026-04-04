import { updateCamera } from "./cameraEngine";
import { applyVisualProfile, DEFAULT_VISUAL_PROFILE, type VisualProfileName } from "./visualProfiles";

export type PerceptualProfile = "scalping" | "intraday" | "swing" | "line" | "footprint";

export type PerceptualTransitionMode = "init" | "hold" | "soft" | "hard";

export type DenseLegibilityMode = "off" | "dense" | "micro";

export type PerceptualSpacingPolicy = {
  profile: PerceptualProfile;
  rightOffset: number;
  barSpacing: number;
  minBarSpacing: number;
  preferredBodyWidthPx: number;
  minGapPx: number;
  targetVisibleBars: number;
};

export type PerceptualAutoscaleSnapshot = {
  min: number;
  max: number;
  rawMin: number;
  rawMax: number;
  span: number;
  topPadding: number;
  bottomPadding: number;
  shiftPct: number;
  comfortZonePct: number;
  hysteresisLocked: boolean;
  transitionMode: PerceptualTransitionMode;
};

export type ChartPerceptualTelemetry = {
  engine: "v3";
  symbol: string;
  timeframe: string;
  mode: "line" | "candles" | "footprint";
  densityLevel: string;
  motionPreset: string;
  viewportWidth: number;
  visibleBars: number;
  candleStepPx: number;
  spacing: PerceptualSpacingPolicy;
  autoscale: {
    min: number | null;
    max: number | null;
    rawMin: number | null;
    rawMax: number | null;
    span: number | null;
    topPadding: number | null;
    bottomPadding: number | null;
    shiftPct: number;
    comfortZonePct: number;
    hysteresisLocked: boolean;
    transitionMode: PerceptualTransitionMode;
    reframeCount: number;
    softReframes: number;
    hardReframes: number;
  };
  stability: {
    lastPriceDriftPx: number;
    peakPriceDriftPx: number;
  };
  performance: {
    fps: number;
    frameTimeMs: number;
    cpuLoad: number;
    workerLatencyMs: number | null;
  };
  updatedAt: string;
};

export type GpuPerceptualTelemetry = {
  engine: "v4";
  symbol: string;
  timeframe: string;
  mode: "line" | "candles" | "footprint";
  renderer: string | null;
  viewportWidth: number;
  viewportHeight: number;
  pixelRatio: number;
  visibleBars: number;
  candleStepPx: number;
  grid: {
    cells: 1 | 4 | 16;
    label: string;
    viewportCount: number;
  };
  spacing: {
    pixelSnapping: boolean;
    denseMode: DenseLegibilityMode;
    preferredBodyWidthPx: number;
    wickWidthPx: number;
    minGapPx: number;
    targetVisibleBars: number;
  };
  performance: {
    fps: number;
    drawCalls: number;
    batchSize: number;
    overlayIntervalMs: number;
    smoothingMs: number;
  };
  updatedAt: string;
};

type ResolvePerceptualTimeScaleOptionsInput = {
  mode: "line" | "candles" | "footprint";
  timeframe: string;
  isLiteMode: boolean;
  containerWidth: number;
  motionPreset: string;
};

export type ResolvePerceptualAutoscaleOptions = {
  timeframe?: string;
  density?: "expanded" | "balanced" | "compressed";
  lastPrice?: number | null;
  driftPx?: number;
  visualProfile?: VisualProfileName;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundToTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

function timeframeToSeconds(timeframe: string): number {
  const match = /^([0-9]+)(s|m|h|d|w|M)$/.exec(timeframe.trim());
  if (!match) {
    return 300;
  }
  const amount = Number(match[1]);
  const unit = match[2];
  if (unit === "s") return amount;
  if (unit === "m") return amount * 60;
  if (unit === "h") return amount * 60 * 60;
  if (unit === "d") return amount * 60 * 60 * 24;
  if (unit === "w") return amount * 60 * 60 * 24 * 7;
  return amount * 60 * 60 * 24 * 30;
}

export function inferPerceptualProfile(
  mode: "line" | "candles" | "footprint",
  timeframe: string,
  motionPreset: string,
): PerceptualProfile {
  if (mode === "line") {
    return "line";
  }
  if (mode === "footprint") {
    return "footprint";
  }
  if (motionPreset === "scalping") {
    return "scalping";
  }
  if (motionPreset === "swing") {
    return "swing";
  }
  const timeframeSeconds = timeframeToSeconds(timeframe);
  if (timeframeSeconds <= 60) {
    return "scalping";
  }
  if (timeframeSeconds >= 4 * 60 * 60) {
    return "swing";
  }
  return "intraday";
}

export function resolvePerceptualTimeScaleOptions({
  mode,
  timeframe,
  isLiteMode,
  containerWidth,
  motionPreset,
}: ResolvePerceptualTimeScaleOptionsInput): PerceptualSpacingPolicy {
  const profile = inferPerceptualProfile(mode, timeframe, motionPreset);
  const safeWidth = Math.max(320, Math.floor(containerWidth || 0));
  const widthBudget = Math.max(260, safeWidth - (isLiteMode ? 28 : 48));

  if (profile === "line") {
    const targetVisibleBars = clamp(Math.round(widthBudget / (isLiteMode ? 7.8 : 8.6)), 42, isLiteMode ? 150 : 190);
    const barSpacing = roundToTenth(clamp(widthBudget / targetVisibleBars, 7, isLiteMode ? 8.5 : 9.5));
    const minBarSpacing = roundToTenth(clamp(barSpacing - 4.2, 3, barSpacing - 0.8));
    return {
      profile,
      rightOffset: isLiteMode ? 1.4 : 3,
      barSpacing,
      minBarSpacing,
      preferredBodyWidthPx: roundToTenth(Math.max(4, barSpacing - 2.1)),
      minGapPx: 1.2,
      targetVisibleBars,
    };
  }

  if (profile === "footprint") {
    const targetVisibleBars = clamp(Math.round(widthBudget / (isLiteMode ? 8.2 : 9.4)), 28, isLiteMode ? 120 : 150);
    const barSpacing = roundToTenth(clamp(widthBudget / targetVisibleBars, 8, isLiteMode ? 9.5 : 10.5));
    const minBarSpacing = roundToTenth(clamp(barSpacing - 4.4, 3, barSpacing - 0.8));
    return {
      profile,
      rightOffset: isLiteMode ? 1.2 : 3,
      barSpacing,
      minBarSpacing,
      preferredBodyWidthPx: roundToTenth(Math.max(4.8, barSpacing - 2.2)),
      minGapPx: 1.4,
      targetVisibleBars,
    };
  }

  const profileBase = profile === "scalping"
    ? { desiredStep: isLiteMode ? 10.8 : 12.8, minGap: 2.6, rightOffset: isLiteMode ? 1.1 : 2.7, minBars: 24, maxBars: isLiteMode ? 110 : 140 }
    : profile === "swing"
      ? { desiredStep: isLiteMode ? 8.8 : 10.2, minGap: 1.5, rightOffset: isLiteMode ? 1.4 : 3.1, minBars: 36, maxBars: isLiteMode ? 150 : 210 }
      : { desiredStep: isLiteMode ? 9.8 : 11.2, minGap: 2.0, rightOffset: isLiteMode ? 1.2 : 2.9, minBars: 30, maxBars: isLiteMode ? 130 : 180 };

  const timeframeSeconds = timeframeToSeconds(timeframe);
  const timeframeBias = timeframeSeconds <= 60 ? 1.1 : timeframeSeconds >= 4 * 60 * 60 ? -0.6 : 0;
  const desiredStep = profileBase.desiredStep + timeframeBias;
  const targetVisibleBars = clamp(Math.round(widthBudget / desiredStep), profileBase.minBars, profileBase.maxBars);
  const barSpacing = roundToTenth(clamp(widthBudget / targetVisibleBars, desiredStep - 1.1, desiredStep + 1.8));
  const preferredBodyWidthPx = roundToTenth(clamp(barSpacing - profileBase.minGap, 5.2, profile === "scalping" ? 13.4 : 11.6));
  const minBarSpacing = roundToTenth(clamp(preferredBodyWidthPx + 0.9, profile === "scalping" ? 6 : 4.6, barSpacing - 0.8));

  return {
    profile,
    rightOffset: profileBase.rightOffset,
    barSpacing,
    minBarSpacing,
    preferredBodyWidthPx,
    minGapPx: profileBase.minGap,
    targetVisibleBars,
  };
}

export function resolvePerceptualAutoscaleRange(
  range: { min: number; max: number } | null,
  previous: PerceptualAutoscaleSnapshot | null,
  options?: ResolvePerceptualAutoscaleOptions,
): PerceptualAutoscaleSnapshot | null {
  if (!range || !Number.isFinite(range.min) || !Number.isFinite(range.max)) {
    return previous;
  }

  const density = options?.density ?? "balanced";
  const visualProfile = applyVisualProfile(options?.visualProfile ?? DEFAULT_VISUAL_PROFILE);
  const comfortBase = visualProfile.perception.comfortZonePct;
  const comfortZonePct = density === "compressed"
    ? clamp(comfortBase - 0.04, 0.16, 0.66)
    : density === "expanded"
      ? clamp(comfortBase + 0.02, 0.16, 0.68)
      : comfortBase;

  const rawSpan = Math.max(0, range.max - range.min);
  const midpoint = (range.max + range.min) * 0.5;
  const baseline = Math.max(Math.abs(midpoint), Math.abs(range.max), Math.abs(range.min), 1);
  const minimumVisualSpan = Math.max(
    rawSpan,
    baseline >= 1000 ? baseline * 0.00012 : baseline >= 100 ? baseline * 0.00035 : baseline * 0.0012,
    baseline >= 1000 ? 1.5 : baseline >= 100 ? 0.35 : 0.02,
  );
  const expandedSpan = Math.max(rawSpan, minimumVisualSpan);
  const effectiveMin = rawSpan > 0 ? Math.min(range.min, midpoint - expandedSpan * 0.5) : midpoint - expandedSpan * 0.5;
  const effectiveMax = rawSpan > 0 ? Math.max(range.max, midpoint + expandedSpan * 0.5) : midpoint + expandedSpan * 0.5;
  const topPadding = clamp(expandedSpan * 0.18, 0.02, Math.max(expandedSpan * 0.32, baseline >= 1000 ? 3.4 : 0.3));
  const bottomPadding = clamp(expandedSpan * 0.12, 0.02, Math.max(expandedSpan * 0.22, baseline >= 1000 ? 2.2 : 0.18));

  const candidate: PerceptualAutoscaleSnapshot = {
    min: effectiveMin - bottomPadding,
    max: effectiveMax + topPadding,
    rawMin: range.min,
    rawMax: range.max,
    span: (effectiveMax + topPadding) - (effectiveMin - bottomPadding),
    topPadding,
    bottomPadding,
    shiftPct: 0,
    comfortZonePct,
    hysteresisLocked: false,
    transitionMode: previous ? "hard" : "init",
  };

  if (!previous || !Number.isFinite(previous.min) || !Number.isFinite(previous.max)) {
    return candidate;
  }

  const previousSpan = Math.max(0.000001, previous.max - previous.min);
  const previousCenter = (previous.max + previous.min) * 0.5;
  const candidateCenter = (candidate.max + candidate.min) * 0.5;
  const centerShiftPct = Math.abs(candidateCenter - previousCenter) / previousSpan;
  const disjointGap = candidate.min > previous.max
    ? candidate.min - previous.max
    : previous.min > candidate.max
      ? previous.min - candidate.max
      : 0;
  const overlapMin = Math.max(previous.min, candidate.min);
  const overlapMax = Math.min(previous.max, candidate.max);
  const overlapSpan = Math.max(0, overlapMax - overlapMin);
  const overlapRatio = overlapSpan / previousSpan;

  if (centerShiftPct > 0.42 || disjointGap > previousSpan * 0.08 || overlapRatio < 0.18) {
    return {
      ...candidate,
      shiftPct: Math.max(centerShiftPct, disjointGap / previousSpan),
      transitionMode: "hard",
      hysteresisLocked: false,
      comfortZonePct,
    };
  }

  const comfortInset = previousSpan * comfortZonePct;
  const driftRelaxation = Number.isFinite(options?.driftPx)
    ? clamp((Number(options?.driftPx) / 48) * 0.04, 0, 0.04)
    : 0;
  const relaxedComfortMin = previous.min + previousSpan * Math.max(0.08, comfortZonePct - driftRelaxation);
  const relaxedComfortMax = previous.max - previousSpan * Math.max(0.08, comfortZonePct - driftRelaxation);
  const withinComfort = range.min >= relaxedComfortMin && range.max <= relaxedComfortMax;
  const lastPrice = Number(options?.lastPrice);
  const lastPriceInsideComfort = Number.isFinite(lastPrice)
    ? lastPrice >= relaxedComfortMin && lastPrice <= relaxedComfortMax
    : true;

  if (withinComfort && lastPriceInsideComfort) {
    return {
      ...previous,
      rawMin: range.min,
      rawMax: range.max,
      hysteresisLocked: true,
      transitionMode: "hold",
      shiftPct: 0,
      comfortZonePct,
    };
  }

  const smoothed = updateCamera(
    { min: previous.min, max: previous.max },
    candidate.min,
    candidate.max,
    options?.timeframe ?? "5m",
    options?.visualProfile ?? DEFAULT_VISUAL_PROFILE,
  );
  const nextMin = smoothed.min;
  const nextMax = smoothed.max;
  const shiftPct = Math.max(Math.abs(nextMin - previous.min), Math.abs(nextMax - previous.max)) / previousSpan;
  const transitionMode: PerceptualTransitionMode = shiftPct <= 0.0005
    ? "hold"
    : shiftPct <= 0.12
      ? "soft"
      : "hard";

  if (transitionMode === "hold") {
    return {
      ...previous,
      rawMin: range.min,
      rawMax: range.max,
      hysteresisLocked: true,
      transitionMode,
      shiftPct: 0,
      comfortZonePct,
    };
  }

  return {
    ...candidate,
    min: nextMin,
    max: nextMax,
    span: nextMax - nextMin,
    shiftPct,
    transitionMode,
    comfortZonePct,
  };
}