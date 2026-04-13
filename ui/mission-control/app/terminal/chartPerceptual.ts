import { updateCamera } from "./cameraEngine";
import { applyVisualProfile, DEFAULT_VISUAL_PROFILE, type VisualProfileName } from "./visualProfiles";

export type PerceptualProfile = "scalping" | "intraday" | "swing" | "line" | "footprint";

export type PerceptualTransitionMode = "init" | "hold" | "soft" | "hard";

export type DenseLegibilityMode = "off" | "dense" | "micro";

export type PerceptualContinuityMode = "idle" | "series-and-overlay" | "overlay-only" | "latest-only";

export type PerceptualContinuityTelemetry = {
  liveFrames: number;
  renderedFrames: number;
  partialFrames: number;
  coalescedFrames: number;
  looseSyncFrames: number;
  schedulerOverwrites: number;
  schedulerDeferrals: number;
  rafOverwrites: number;
  duplicateFrameSkips: number;
  throttleDeferrals: number;
  conflatedUpdates: number;
  partialUpdates: number;
  fullRedraws: number;
  updateFallbackRedraws: number;
  recoveryClears: number;
  overlayContinuityStarts: number;
  overlayContinuityFrames: number;
  overlayContinuitySettles: number;
  lostIntermediateFrames: number;
  jumpEvents: number;
  latestJumpPx: number;
  peakJumpPx: number;
  continuityMode: PerceptualContinuityMode;
};

export type PerceptualSpacingPolicy = {
  profile: PerceptualProfile;
  rightOffset: number;
  barSpacing: number;
  minBarSpacing: number;
  preferredBodyWidthPx: number;
  minGapPx: number;
  targetVisibleBars: number;
  minVisibleBars: number;
  maxVisibleBars: number;
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
  pixel: {
    pixelRatio: number;
    rawSpacingPx: number;
    quantizedSpacingPx: number;
    snapDeltaPx: number;
    spacingZone: "micro" | "normal" | "macro";
    preferredBodyWidthPx: number;
    wickWidthPx: number;
    overlayWidthPx: number;
    bodyRadiusPx: number;
  };
  perceptual: {
    baseBodyWidthPx: number;
    timeframeWeight: number;
    densityFactor: number;
    volatilityFactor: number;
    zoomFactor: number;
    minBodyWidthPx: number;
    maxBodyWidthPx: number;
    bodyToSpacingRatio: number;
  };
  desk: {
    mode: "micro" | "macro" | "execution";
    authoritativeRenderer: boolean;
    liquidityScore: number;
    heatScore: number;
    deltaScore: number;
    executionScore: number;
    confidence: number;
  };
  simulation: {
    stateLabel: "aggressive_buy" | "aggressive_sell" | "breakout" | "chaos" | "neutral";
    decisionAction: "buy" | "sell" | "hold";
    shouldExecute: boolean;
    confidence: number;
    liquidityCollapse: boolean;
    imbalance: number;
    fillProbability: number;
    slippageBps: number;
    latencyMs: number;
    t100msPrice: number | null;
    t250msPrice: number | null;
    t500msPrice: number | null;
    coneBest: number | null;
    coneExpected: number | null;
    coneWorst: number | null;
  };
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
  continuity: PerceptualContinuityTelemetry;
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
  sync: {
    status: "atomic" | "loose-sync" | "coalesced" | "unavailable";
    confidence: number | null;
    partial: boolean;
    coalesced: boolean;
    stallAgeMs: number | null;
    dynamicBufferMs: number | null;
  };
  worker: {
    batchActive: boolean;
    mode: "worker" | "best-effort";
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
  continuity: PerceptualContinuityTelemetry;
  diagnosis: {
    primary: string[];
    summary: string;
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

const PERCEPTUAL_SPACING_SNAP_ZONES = [2, 4, 6, 8, 10, 12, 16, 20, 24, 28, 32, 40, 52, 64] as const;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundToTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

export function quantizePerceptualBarSpacing(rawSpacing: number): number {
  const safeSpacing = clamp(Number.isFinite(rawSpacing) ? rawSpacing : 4, 2, 80);
  let best: number = PERCEPTUAL_SPACING_SNAP_ZONES[0];
  let bestGap = Math.abs(best - safeSpacing);

  for (const zone of PERCEPTUAL_SPACING_SNAP_ZONES) {
    const gap = Math.abs(zone - safeSpacing);
    if (gap < bestGap) {
      best = zone;
      bestGap = gap;
    }
  }

  if (safeSpacing > PERCEPTUAL_SPACING_SNAP_ZONES[PERCEPTUAL_SPACING_SNAP_ZONES.length - 1]) {
    return Math.max(best, Math.round(safeSpacing));
  }

  return best;
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

function resolveAutoscaleTimeframeProfile(timeframe: string): {
  minimumSpanMultiplier: number;
  comfortBoostPct: number;
  holdShiftPct: number;
  envelopeSlackPct: number;
  softShiftPct: number;
} {
  const seconds = timeframeToSeconds(timeframe);
  if (seconds <= 5) {
    return {
      minimumSpanMultiplier: 1.35,
      comfortBoostPct: 0.09,
      holdShiftPct: 0.008,
      envelopeSlackPct: 0.045,
      softShiftPct: 0.18,
    };
  }
  if (seconds <= 30) {
    return {
      minimumSpanMultiplier: 1.22,
      comfortBoostPct: 0.07,
      holdShiftPct: 0.006,
      envelopeSlackPct: 0.036,
      softShiftPct: 0.16,
    };
  }
  if (seconds <= 60) {
    return {
      minimumSpanMultiplier: 1.12,
      comfortBoostPct: 0.05,
      holdShiftPct: 0.004,
      envelopeSlackPct: 0.028,
      softShiftPct: 0.14,
    };
  }
  if (seconds <= 5 * 60) {
    return {
      minimumSpanMultiplier: 1.05,
      comfortBoostPct: 0.02,
      holdShiftPct: 0.0022,
      envelopeSlackPct: 0.018,
      softShiftPct: 0.13,
    };
  }
  return {
    minimumSpanMultiplier: 1,
    comfortBoostPct: 0,
    holdShiftPct: 0.0005,
    envelopeSlackPct: 0.012,
    softShiftPct: 0.12,
  };
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
    let targetVisibleBars = clamp(Math.round(widthBudget / (isLiteMode ? 7.8 : 8.6)), 42, isLiteMode ? 150 : 190);
    const barSpacing = quantizePerceptualBarSpacing(clamp(widthBudget / targetVisibleBars, 7, isLiteMode ? 8.5 : 9.5));
    targetVisibleBars = clamp(Math.round(widthBudget / barSpacing), 42, isLiteMode ? 150 : 190);
    const minBarSpacing = roundToTenth(clamp(barSpacing - 4.2, 3, barSpacing - 0.8));
    return {
      profile,
      rightOffset: isLiteMode ? 1.4 : 3,
      barSpacing,
      minBarSpacing,
      preferredBodyWidthPx: roundToTenth(Math.max(4, barSpacing - 2.1)),
      minGapPx: 1.2,
      targetVisibleBars,
      minVisibleBars: 18,
      maxVisibleBars: isLiteMode ? 180 : 220,
    };
  }

  if (profile === "footprint") {
    let targetVisibleBars = clamp(Math.round(widthBudget / (isLiteMode ? 8.2 : 9.4)), 28, isLiteMode ? 120 : 150);
    const barSpacing = quantizePerceptualBarSpacing(clamp(widthBudget / targetVisibleBars, 8, isLiteMode ? 9.5 : 10.5));
    targetVisibleBars = clamp(Math.round(widthBudget / barSpacing), 28, isLiteMode ? 120 : 150);
    const minBarSpacing = roundToTenth(clamp(barSpacing - 4.4, 3, barSpacing - 0.8));
    return {
      profile,
      rightOffset: isLiteMode ? 1.2 : 3,
      barSpacing,
      minBarSpacing,
      preferredBodyWidthPx: roundToTenth(Math.max(4.8, barSpacing - 2.2)),
      minGapPx: 1.4,
      targetVisibleBars,
      minVisibleBars: 16,
      maxVisibleBars: isLiteMode ? 132 : 170,
    };
  }

  const profileBase = profile === "scalping"
    ? { desiredStep: isLiteMode ? 12.6 : 14.8, minGap: 2.8, rightOffset: isLiteMode ? 1.1 : 2.7, minBars: 20, maxBars: isLiteMode ? 96 : 124 }
    : profile === "swing"
      ? { desiredStep: isLiteMode ? 9.8 : 11.4, minGap: 1.8, rightOffset: isLiteMode ? 1.4 : 3.1, minBars: 28, maxBars: isLiteMode ? 132 : 168 }
      : { desiredStep: isLiteMode ? 11.1 : 12.9, minGap: 2.3, rightOffset: isLiteMode ? 1.2 : 2.9, minBars: 24, maxBars: isLiteMode ? 108 : 144 };

  const timeframeSeconds = timeframeToSeconds(timeframe);
  const timeframeBias = timeframeSeconds <= 60
    ? 2.4
    : timeframeSeconds <= 5 * 60
      ? 1.1
      : timeframeSeconds >= 24 * 60 * 60
        ? -0.45
        : timeframeSeconds >= 4 * 60 * 60
          ? -0.2
          : 0;
  const desiredStep = profileBase.desiredStep + timeframeBias;
          let targetVisibleBars = clamp(Math.round(widthBudget / desiredStep), profileBase.minBars, profileBase.maxBars);
          const barSpacing = quantizePerceptualBarSpacing(clamp(widthBudget / targetVisibleBars, desiredStep - 1.1, desiredStep + 1.8));
          targetVisibleBars = clamp(Math.round(widthBudget / barSpacing), profileBase.minBars, profileBase.maxBars);
  const preferredBodyWidthPx = roundToTenth(clamp(barSpacing - profileBase.minGap, 5.2, profile === "scalping" ? 13.4 : 11.6));
  const minBarSpacing = roundToTenth(clamp(preferredBodyWidthPx + 0.9, profile === "scalping" ? 6 : 4.6, barSpacing - 0.8));
  const minVisibleBars = Math.max(8, Math.round(profileBase.minBars * 0.72));
  const maxVisibleBars = Math.round(profileBase.maxBars * (profile === "scalping" ? 1.08 : 1.12));

  return {
    profile,
    rightOffset: profileBase.rightOffset,
    barSpacing,
    minBarSpacing,
    preferredBodyWidthPx,
    minGapPx: profileBase.minGap,
    targetVisibleBars,
    minVisibleBars,
    maxVisibleBars,
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
  const timeframeProfile = resolveAutoscaleTimeframeProfile(options?.timeframe ?? "5m");
  const comfortZonePct = clamp((density === "compressed"
    ? clamp(comfortBase - 0.04, 0.16, 0.66)
    : density === "expanded"
      ? clamp(comfortBase + 0.02, 0.16, 0.68)
      : comfortBase) + timeframeProfile.comfortBoostPct, 0.16, 0.76);

  const rawSpan = Math.max(0, range.max - range.min);
  const midpoint = (range.max + range.min) * 0.5;
  const baseline = Math.max(Math.abs(midpoint), Math.abs(range.max), Math.abs(range.min), 1);
  const minimumVisualFloor = Math.max(
    rawSpan,
    baseline >= 1000 ? baseline * 0.00012 : baseline >= 100 ? baseline * 0.00035 : baseline * 0.0012,
    baseline >= 1000 ? 1.5 : baseline >= 100 ? 0.35 : 0.02,
  );
  const minimumVisualSpan = Math.max(rawSpan, minimumVisualFloor * timeframeProfile.minimumSpanMultiplier);
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
  const envelopeSlack = previousSpan * timeframeProfile.envelopeSlackPct;
  const withinPreviousEnvelope = candidate.min >= previous.min - envelopeSlack && candidate.max <= previous.max + envelopeSlack;
  const previousInset = previousSpan * Math.max(0.04, comfortZonePct * 0.22);
  const lastPriceInsidePreviousEnvelope = Number.isFinite(lastPrice)
    ? lastPrice >= previous.min + previousInset && lastPrice <= previous.max - previousInset
    : true;

  if (
    (withinComfort && lastPriceInsideComfort)
    || (withinPreviousEnvelope && lastPriceInsidePreviousEnvelope && centerShiftPct <= timeframeProfile.holdShiftPct * 1.35)
  ) {
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
  const transitionMode: PerceptualTransitionMode = shiftPct <= timeframeProfile.holdShiftPct
    ? "hold"
    : shiftPct <= timeframeProfile.softShiftPct
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