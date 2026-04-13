import type { OhlcBar } from "./sharedBuffer";

const SPACING_ZONES = [2, 4, 6, 8, 10, 12, 16, 20, 24, 28, 32, 40, 52, 64] as const;

export type PerceptualDominanceContext = {
  spacingPx: number;
  volatility: number;
  density: number;
  zoom: number;
  devicePixelRatio: number;
};

export type PerceptualDominance = {
  bodyWidthPx: number;
  wickWidthPx: number;
  minBodyHeightPx: number;
  opacity: number;
  contrast: number;
  glow: number;
};

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function quantizeSpacing(spacingPx: number): number {
  const safeSpacing = clamp(Number.isFinite(spacingPx) ? spacingPx : 4, 2, 80);
  let best: number = SPACING_ZONES[0];
  let bestGap = Math.abs(best - safeSpacing);

  for (const zone of SPACING_ZONES) {
    const gap = Math.abs(zone - safeSpacing);
    if (gap < bestGap) {
      best = zone;
      bestGap = gap;
    }
  }

  if (safeSpacing > SPACING_ZONES[SPACING_ZONES.length - 1]) {
    return Math.round(safeSpacing);
  }

  return best;
}

export function pixelAlign(value: number, devicePixelRatio: number): number {
  const dpr = Math.max(1, devicePixelRatio || 1);
  return Math.round(value * dpr) / dpr;
}

function isMacroTimeframeHint(timeframeHint: string): boolean {
  return /^(1d|1w|1M)$/i.test(String(timeframeHint || "").trim());
}

function isMacroExtendedTimeframeHint(timeframeHint: string): boolean {
  return /^(4h|8h|1d|1w|1M)$/i.test(String(timeframeHint || "").trim());
}

function timeframeHintToSeconds(timeframeHint: string): number {
  const match = /^([0-9]+)(s|m|h|d|w|M)$/i.exec(String(timeframeHint || "").trim());
  if (!match) {
    return 0;
  }
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === "s") return amount;
  if (unit === "m") return amount * 60;
  if (unit === "h") return amount * 60 * 60;
  if (unit === "d") return amount * 60 * 60 * 24;
  if (unit === "w") return amount * 60 * 60 * 24 * 7;
  return amount * 60 * 60 * 24 * 30;
}

function resolvePerceptualRangeTimeframeSeconds(bars: OhlcBar[], count: number): number {
  const hinted = timeframeHintToSeconds(String(bars[Math.max(0, count - 1)]?.__visual?.timeframeHint || ""));
  if (hinted > 0) {
    return hinted;
  }

  let smallestDelta = Number.POSITIVE_INFINITY;
  const start = Math.max(1, count - 24);
  for (let index = start; index < count; index += 1) {
    const current = Number(bars[index]?.time);
    const previous = Number(bars[index - 1]?.time);
    const delta = current - previous;
    if (Number.isFinite(delta) && delta > 0 && delta < smallestDelta) {
      smallestDelta = delta;
    }
  }

  return Number.isFinite(smallestDelta) ? smallestDelta : 300;
}

function resolveBodyDominanceRatio(density: number, timeframeHint: string): number {
  let ratio = 0.8;

  if (density < 0.4) {
    ratio += 0.12;
  }
  if (density < 0.25) {
    ratio += 0.08;
  }

  if (isMacroTimeframeHint(timeframeHint)) {
    ratio += 0.1;
  } else if (isMacroExtendedTimeframeHint(timeframeHint)) {
    ratio += 0.05;
  }

  return ratio;
}

function resolveSpacingCompressionRatio(density: number): number {
  if (density < 0.3) {
    return 0.72;
  }
  if (density < 0.5) {
    return 0.85;
  }
  return 1;
}

export function resolvePerceptualDominance(_candle: OhlcBar, context: PerceptualDominanceContext): PerceptualDominance {
  const visual = _candle.__visual;
  const timeframeHint = String(visual?.timeframeHint || "").trim();
  const macroTimeframe = isMacroTimeframeHint(timeframeHint);
  const macroExtendedTimeframe = isMacroExtendedTimeframeHint(timeframeHint);
  const rawSpacingPx = clamp(Number.isFinite(context.spacingPx) ? context.spacingPx : 4, 2, 80);
  const quantizedSpacingPx = quantizeSpacing(rawSpacingPx);
  const spacingCompressionRatio = resolveSpacingCompressionRatio(context.density);
  const effectiveSpacingPx = rawSpacingPx * spacingCompressionRatio;
  const perceptualSpacingPx = quantizedSpacingPx * 0.32 + effectiveSpacingPx * 0.68;
  const dominanceRatio = clamp(resolveBodyDominanceRatio(context.density, timeframeHint), 0.8, macroTimeframe ? 1.1 : macroExtendedTimeframe ? 1.02 : 0.98);
  const visualImportance = clamp(visual?.importance ?? 0, 0, 1);
  const lastCandleEmphasis = clamp(visual?.lastCandleEmphasis ?? 0, 0, 0.3);
  const bodyBoostRatio = clamp((visual?.bodyBoost ?? 1) - 1, 0, 1.25);
  const referencePrice = Math.max(Math.abs(_candle.close), Math.abs(_candle.open), 1);
  const wickExtensionRatio = clamp((visual?.wickBoost ?? 0) / Math.max(referencePrice * 0.0015, 1e-6), 0, 1);
  const wickSignalBoost = visual?.wickType === "neutral"
    ? 0
    : visual?.wickType === "rejection"
      ? 0.18
      : 0.14;
  let bodyWidthPx = rawSpacingPx * dominanceRatio * context.zoom;

  if (context.volatility > 0.7) {
    bodyWidthPx *= 1.12;
  } else if (context.volatility > 0.45) {
    bodyWidthPx *= 1.06;
  }

  if (context.density < 0.4) {
    bodyWidthPx *= 1.08;
  } else if (context.density < 0.5) {
    bodyWidthPx *= 1.04;
  } else if (context.density > 0.86) {
    bodyWidthPx *= 0.96;
  }

  if (macroTimeframe) {
    bodyWidthPx *= 1.08;
  } else if (macroExtendedTimeframe) {
    bodyWidthPx *= 1.04;
  }

  bodyWidthPx *= 1 + visualImportance * 0.06 + bodyBoostRatio * 0.08 + lastCandleEmphasis * 0.4;
  bodyWidthPx = Math.max(bodyWidthPx, effectiveSpacingPx * dominanceRatio);

  const minimumBodyFloorPx = macroExtendedTimeframe ? 3.2 : context.density > 0.92 ? 2.8 : 3.6;
  bodyWidthPx = Math.max(minimumBodyFloorPx, bodyWidthPx);
  bodyWidthPx = Math.min(
    rawSpacingPx * (macroTimeframe ? 1.1 : macroExtendedTimeframe ? 1.04 : 0.98),
    bodyWidthPx,
  );
  bodyWidthPx = pixelAlign(bodyWidthPx, context.devicePixelRatio);

  let wickWidthPx = Math.max(1.2, bodyWidthPx * 0.3);
  wickWidthPx = Math.max(wickWidthPx, (visual?.wickWidth ?? 1) * (1 + visualImportance * 0.12 + wickSignalBoost + wickExtensionRatio * 0.12));
  wickWidthPx = Math.min(Math.max(1.2, perceptualSpacingPx * 0.28), wickWidthPx);
  wickWidthPx = pixelAlign(wickWidthPx, context.devicePixelRatio);

  const lowVolatilityBoost = (1 - clamp(context.volatility, 0, 1)) * 1.35;
  const bodyLegibilityFloorPx = bodyWidthPx * (context.density > 0.86 ? 1.3 : 1.14);
  const minBodyHeightPx = pixelAlign(
    clamp(
      Math.max(
        bodyLegibilityFloorPx,
        4.4
          + context.volatility * 1.15
          + (1 - context.density) * 1.25
          + lowVolatilityBoost,
        4.6
          + bodyBoostRatio * 1.6
          + visualImportance * 0.8
          + lastCandleEmphasis * 6
          + wickExtensionRatio * 0.65,
      ),
      context.density > 0.92 ? 4.1 : 4.8,
      10.4,
    ),
    context.devicePixelRatio,
  );

  return {
    bodyWidthPx,
    wickWidthPx,
    minBodyHeightPx,
    opacity: clamp(0.9 + context.volatility * 0.08 - context.density * 0.05 + (visual?.opacity ?? 0.92) * 0.02, 0.88, 0.99),
    contrast: clamp(1 + context.volatility * 0.14 + (1 - context.density) * 0.1 + visualImportance * 0.05 + wickSignalBoost * 0.08, 1, 1.28),
    glow: clamp(context.volatility * 0.28 + (1 - context.density) * 0.12 + lastCandleEmphasis * 0.75 + wickExtensionRatio * 0.08, 0.04, 0.4),
  };
}

function resolveTrimmedBounds(values: number[], trimFraction: number): { min: number; max: number } {
  if (values.length === 0) {
    return { min: 0, max: 1 };
  }

  const sorted = [...values].sort((left, right) => left - right);
  const maxTrim = Math.max(0, Math.floor((sorted.length - 1) * 0.2));
  const trim = clamp(Math.floor(sorted.length * trimFraction), 0, maxTrim);

  return {
    min: sorted[Math.min(trim, sorted.length - 1)],
    max: sorted[Math.max(0, sorted.length - trim - 1)],
  };
}

export function resolvePerceptualRange(bars: OhlcBar[], count: number): { minPrice: number; maxPrice: number } {
  if (count <= 0) {
    return { minPrice: 0, maxPrice: 1 };
  }

  const timeframeSeconds = resolvePerceptualRangeTimeframeSeconds(bars, count);
  const lows: number[] = [];
  const highs: number[] = [];
  const recentLows: number[] = [];
  const recentHighs: number[] = [];
  const recentLookback = Math.max(32, Math.min(count, Math.round(count * 0.58), 72));
  const recentStart = Math.max(0, count - recentLookback);
  const recentRanges: number[] = [];

  for (let index = 0; index < count; index += 1) {
    const bar = bars[index];
    if (!Number.isFinite(bar.low) || !Number.isFinite(bar.high)) {
      continue;
    }

    const bodyLow = Math.min(bar.low, bar.open, bar.close);
    const bodyHigh = Math.max(bar.high, bar.open, bar.close);
    lows.push(bodyLow);
    highs.push(bodyHigh);
    recentRanges.push(Math.max(0, bodyHigh - bodyLow));

    if (index >= recentStart) {
      recentLows.push(bodyLow);
      recentHighs.push(bodyHigh);
    }
  }

  if (lows.length === 0 || highs.length === 0) {
    return { minPrice: 0, maxPrice: 1 };
  }

  const latest = bars[Math.max(0, count - 1)];
  const sourceLows = recentLows.length >= 12 ? recentLows : lows;
  const sourceHighs = recentHighs.length >= 12 ? recentHighs : highs;
  const trimFraction = sourceLows.length >= 72 ? 0.14 : sourceLows.length >= 36 ? 0.1 : 0.06;
  const trimmed = resolveTrimmedBounds(sourceLows, trimFraction);
  const trimmedHighs = resolveTrimmedBounds(sourceHighs, trimFraction);
  const sortedRecentRanges = recentRanges.filter((value) => Number.isFinite(value) && value > 0).sort((left, right) => left - right);
  const medianRecentRange = sortedRecentRanges.length > 0
    ? sortedRecentRanges[Math.floor(sortedRecentRanges.length * 0.5)]
    : Math.max(1e-6, trimmedHighs.max - trimmed.min) * 0.06;

  const latestOpen = latest?.open ?? trimmed.min;
  const latestClose = latest?.close ?? latestOpen;
  const latestBodyLow = Math.min(latest?.low ?? latestOpen, latestOpen, latestClose);
  const latestBodyHigh = Math.max(latest?.high ?? latestClose, latestOpen, latestClose);
  const latestHigh = latest?.high ?? latestBodyHigh;
  const latestLow = latest?.low ?? latestBodyLow;
  const latestRange = Math.max(0, latestHigh - latestLow);
  const microShockMultiplier = timeframeSeconds <= 5
    ? 1.35
    : timeframeSeconds <= 30
      ? 1.55
      : timeframeSeconds <= 60
        ? 1.75
        : 2.1;
  const latestWickWeight = timeframeSeconds <= 5
    ? 0.22
    : timeframeSeconds <= 30
      ? 0.28
      : timeframeSeconds <= 60
        ? 0.32
        : 0.35;
  const activeShockCap = Math.max(medianRecentRange * microShockMultiplier, Math.abs(latestClose || latestOpen || 1) * 0.00032);
  const dominantLatestHigh = latestRange > activeShockCap
    ? latestBodyHigh + Math.min(latestHigh - latestBodyHigh, activeShockCap * latestWickWeight)
    : latestHigh;
  const dominantLatestLow = latestRange > activeShockCap
    ? latestBodyLow - Math.min(latestBodyLow - latestLow, activeShockCap * latestWickWeight)
    : latestLow;

  let minPrice = Math.min(trimmed.min, dominantLatestLow, latestOpen, latestClose);
  let maxPrice = Math.max(trimmedHighs.max, dominantLatestHigh, latestOpen, latestClose);

  if (!Number.isFinite(minPrice) || !Number.isFinite(maxPrice) || minPrice === maxPrice) {
    return { minPrice: 0, maxPrice: 1 };
  }

  const span = Math.max(1e-6, maxPrice - minPrice);
  const anchor = Math.max(Math.abs(latestClose), Math.abs(latestOpen), 1);
  const paddingMultiplier = timeframeSeconds <= 5
    ? 1.35
    : timeframeSeconds <= 30
      ? 1.2
      : timeframeSeconds <= 60
        ? 1.1
        : 1;
  const padding = Math.max(span * 0.035, medianRecentRange * 0.26 * paddingMultiplier, anchor * 0.00008 * paddingMultiplier);

  minPrice -= padding;
  maxPrice += padding;

  const minVisibleRangeMultiplier = timeframeSeconds <= 5
    ? 2.65
    : timeframeSeconds <= 30
      ? 2.35
      : timeframeSeconds <= 60
        ? 2.1
        : 1.85;
  if (maxPrice - minPrice < Math.max(anchor * 0.00045, medianRecentRange * minVisibleRangeMultiplier)) {
    const minVisibleSpan = Math.max(anchor * 0.00045, medianRecentRange * minVisibleRangeMultiplier);
    const mid = (minPrice + maxPrice) * 0.5;
    minPrice = mid - minVisibleSpan * 0.5;
    maxPrice = mid + minVisibleSpan * 0.5;
  }

  return { minPrice, maxPrice };
}