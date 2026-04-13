import type { ChartOverlayZone } from "./chartOverlayTypes";

export type StructureTag = "HH" | "HL" | "LH" | "LL" | "EQH" | "EQL";
export type StructureSwingSide = "high" | "low";
export type MarketStructureState = "trend-up" | "trend-down" | "range" | "transition";

export type StructureCandle = {
  label: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type StructureSwing = {
  index: number;
  label: string;
  price: number;
  side: StructureSwingSide;
  tag: StructureTag;
  strength: number;
  impulseScore: number;
};

export type StructureSnapshot = {
  state: MarketStructureState;
  sequence: StructureTag[];
  swings: StructureSwing[];
  activeRangeHigh: number | null;
  activeRangeLow: number | null;
  rangeStartIndex: number;
  rangeEndIndex: number;
  breakDirection: "up" | "down" | "none";
  confidence: number;
  impulseScore: number;
  trendBias: "bullish" | "bearish" | "neutral";
  summaryLabel: string;
};

type DetectStructureOptions = {
  pivotWindow?: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function resolvePriceTolerance(candles: StructureCandle[]): number {
  if (candles.length === 0) {
    return 0;
  }
  const averageRange = average(candles.map((candle) => Math.max(0, candle.high - candle.low)));
  const referencePrice = Math.max(1, candles[candles.length - 1]?.close || candles[0]?.close || 1);
  return Math.max(referencePrice * 0.0006, averageRange * 0.12, 0.000001);
}

function classifySwingTag(side: StructureSwingSide, price: number, previousPrice: number | null, tolerance: number): StructureTag {
  if (previousPrice === null) {
    return side === "high" ? "HH" : "HL";
  }
  if (Math.abs(price - previousPrice) <= tolerance) {
    return side === "high" ? "EQH" : "EQL";
  }
  if (side === "high") {
    return price > previousPrice ? "HH" : "LH";
  }
  return price > previousPrice ? "HL" : "LL";
}

function resolveImpulseScore(candles: StructureCandle[], index: number, averageRange: number, averageVolume: number): number {
  const candle = candles[index];
  if (!candle) {
    return 0;
  }
  const previous = candles[Math.max(0, index - 1)] || candle;
  const candleRange = Math.max(0, candle.high - candle.low);
  const rangeExpansion = averageRange > 0 ? clamp(candleRange / averageRange, 0, 2) / 2 : 0;
  const volumeExpansion = averageVolume > 0 ? clamp(candle.volume / averageVolume, 0, 2) / 2 : 0;
  const breakSpeed = averageRange > 0 ? clamp(Math.abs(candle.close - previous.close) / averageRange, 0, 2) / 2 : 0;
  return clamp(rangeExpansion * 0.45 + volumeExpansion * 0.25 + breakSpeed * 0.3, 0, 1);
}

function isPivotHigh(candles: StructureCandle[], index: number, pivotWindow: number): boolean {
  const current = candles[index];
  if (!current) {
    return false;
  }
  for (let offset = 1; offset <= pivotWindow; offset += 1) {
    const previous = candles[index - offset];
    const next = candles[index + offset];
    if (!previous || !next) {
      return false;
    }
    if (current.high < previous.high || current.high < next.high) {
      return false;
    }
  }
  return true;
}

function isPivotLow(candles: StructureCandle[], index: number, pivotWindow: number): boolean {
  const current = candles[index];
  if (!current) {
    return false;
  }
  for (let offset = 1; offset <= pivotWindow; offset += 1) {
    const previous = candles[index - offset];
    const next = candles[index + offset];
    if (!previous || !next) {
      return false;
    }
    if (current.low > previous.low || current.low > next.low) {
      return false;
    }
  }
  return true;
}

function resolveSummaryLabel(state: MarketStructureState, highTag: StructureTag | null, lowTag: StructureTag | null): string {
  if (state === "trend-up") {
    return `Trend up ${highTag || "HH"} / ${lowTag || "HL"}`;
  }
  if (state === "trend-down") {
    return `Trend down ${highTag || "LH"} / ${lowTag || "LL"}`;
  }
  if (state === "range") {
    return "Range EQH / EQL";
  }
  return `Transition ${highTag || "--"} / ${lowTag || "--"}`;
}

export function detectStructure(candles: StructureCandle[], options: DetectStructureOptions = {}): StructureSnapshot {
  const pivotWindow = Math.max(1, Math.floor(options.pivotWindow ?? 1));
  if (!Array.isArray(candles) || candles.length < pivotWindow * 2 + 1) {
    return {
      state: "transition",
      sequence: [],
      swings: [],
      activeRangeHigh: null,
      activeRangeLow: null,
      rangeStartIndex: 0,
      rangeEndIndex: Math.max(0, candles.length - 1),
      breakDirection: "none",
      confidence: 0,
      impulseScore: 0,
      trendBias: "neutral",
      summaryLabel: "Transition -- / --",
    };
  }

  const averageRange = average(candles.map((candle) => Math.max(0, candle.high - candle.low)));
  const averageVolume = average(candles.map((candle) => Math.max(0, candle.volume)));
  const tolerance = resolvePriceTolerance(candles);
  const swings: StructureSwing[] = [];
  let previousHigh: number | null = null;
  let previousLow: number | null = null;

  for (let index = pivotWindow; index < candles.length - pivotWindow; index += 1) {
    if (isPivotHigh(candles, index, pivotWindow)) {
      const price = candles[index].high;
      const impulseScore = resolveImpulseScore(candles, index, averageRange, averageVolume);
      swings.push({
        index,
        label: candles[index].label,
        price,
        side: "high",
        tag: classifySwingTag("high", price, previousHigh, tolerance),
        strength: clamp(impulseScore * 0.7 + 0.3, 0, 1),
        impulseScore,
      });
      previousHigh = price;
    }
    if (isPivotLow(candles, index, pivotWindow)) {
      const price = candles[index].low;
      const impulseScore = resolveImpulseScore(candles, index, averageRange, averageVolume);
      swings.push({
        index,
        label: candles[index].label,
        price,
        side: "low",
        tag: classifySwingTag("low", price, previousLow, tolerance),
        strength: clamp(impulseScore * 0.7 + 0.3, 0, 1),
        impulseScore,
      });
      previousLow = price;
    }
  }

  swings.sort((left, right) => left.index - right.index);

  const recentSwings = swings.slice(-6);
  const recentHigh = [...recentSwings].reverse().find((swing) => swing.side === "high") || null;
  const recentLow = [...recentSwings].reverse().find((swing) => swing.side === "low") || null;
  const equalHighCount = recentSwings.filter((swing) => swing.tag === "EQH").length;
  const equalLowCount = recentSwings.filter((swing) => swing.tag === "EQL").length;
  const lastHighTag = recentHigh?.tag ?? null;
  const lastLowTag = recentLow?.tag ?? null;
  const rangeEndIndex = candles.length - 1;
  const rangeStartIndex = Math.max(0, rangeEndIndex - Math.min(candles.length - 1, 11));
  const rangeSlice = candles.slice(rangeStartIndex, rangeEndIndex + 1);
  const activeRangeHigh = rangeSlice.length > 0 ? Math.max(...rangeSlice.map((candle) => candle.high)) : null;
  const activeRangeLow = rangeSlice.length > 0 ? Math.min(...rangeSlice.map((candle) => candle.low)) : null;
  let state: MarketStructureState = "transition";
  if ((lastHighTag === "HH" || lastHighTag === "EQH") && (lastLowTag === "HL" || lastLowTag === "EQL")) {
    state = "trend-up";
  } else if ((lastHighTag === "LH" || lastHighTag === "EQH") && (lastLowTag === "LL" || lastLowTag === "EQL")) {
    state = "trend-down";
  }
  if (equalHighCount > 0 && equalLowCount > 0) {
    state = "range";
  }

  const lastClose = candles[candles.length - 1]?.close ?? 0;
  const breakDirection = activeRangeHigh !== null && activeRangeLow !== null
    ? lastClose > activeRangeHigh + tolerance * 0.18
      ? "up"
      : lastClose < activeRangeLow - tolerance * 0.18
        ? "down"
        : "none"
    : "none";
  const impulseScore = recentSwings.length > 0 ? average(recentSwings.map((swing) => swing.impulseScore)) : 0;
  const trendConsistency = recentSwings.length > 0
    ? recentSwings.filter((swing) => (
      state === "trend-up"
        ? swing.tag === "HH" || swing.tag === "HL" || swing.tag === "EQH" || swing.tag === "EQL"
        : state === "trend-down"
          ? swing.tag === "LH" || swing.tag === "LL" || swing.tag === "EQH" || swing.tag === "EQL"
          : swing.tag === "EQH" || swing.tag === "EQL"
    )).length / recentSwings.length
    : 0;
  const confidence = clamp(trendConsistency * 0.58 + impulseScore * 0.42, 0, 1);
  const trendBias = state === "trend-up" ? "bullish" : state === "trend-down" ? "bearish" : "neutral";

  return {
    state,
    sequence: recentSwings.map((swing) => swing.tag),
    swings,
    activeRangeHigh,
    activeRangeLow,
    rangeStartIndex,
    rangeEndIndex,
    breakDirection,
    confidence,
    impulseScore,
    trendBias,
    summaryLabel: resolveSummaryLabel(state, lastHighTag, lastLowTag),
  };
}

export function buildStructureOverlayZones(snapshot: StructureSnapshot): ChartOverlayZone[] {
  if (snapshot.swings.length === 0) {
    return [];
  }

  const zones: ChartOverlayZone[] = [];
  const recentSwings = snapshot.swings.slice(-4);
  if (snapshot.state === "trend-up" || snapshot.state === "trend-down") {
    const x1 = Math.max(0, Math.min(...recentSwings.map((swing) => swing.index)));
    const x2 = Math.max(x1 + 1, Math.max(...recentSwings.map((swing) => swing.index)));
    const low = Math.min(...recentSwings.map((swing) => swing.price));
    const high = Math.max(...recentSwings.map((swing) => swing.price));
    zones.push({
      kind: "structure",
      label: snapshot.state === "trend-up" ? "Structure trend up" : "Structure trend down",
      x1,
      x2,
      low,
      high,
      tone: snapshot.state === "trend-up" ? "rgba(89, 214, 149, 0.14)" : "rgba(255, 124, 124, 0.14)",
    });
  }

  if (snapshot.state === "range" && snapshot.activeRangeHigh !== null && snapshot.activeRangeLow !== null) {
    zones.push({
      kind: "structure",
      label: "Structure range",
      x1: snapshot.rangeStartIndex,
      x2: snapshot.rangeEndIndex,
      low: snapshot.activeRangeLow,
      high: snapshot.activeRangeHigh,
      tone: "rgba(88, 199, 255, 0.12)",
    });
  }

  if (snapshot.breakDirection !== "none" && snapshot.activeRangeHigh !== null && snapshot.activeRangeLow !== null) {
    const buffer = Math.max((snapshot.activeRangeHigh - snapshot.activeRangeLow) * 0.18, 0.000001);
    zones.push({
      kind: "structure",
      label: snapshot.breakDirection === "up" ? "Structure break up" : "Structure break down",
      x1: Math.max(0, snapshot.rangeEndIndex - 2),
      x2: snapshot.rangeEndIndex,
      low: snapshot.breakDirection === "up" ? snapshot.activeRangeHigh - buffer * 0.4 : snapshot.activeRangeLow - buffer,
      high: snapshot.breakDirection === "up" ? snapshot.activeRangeHigh + buffer : snapshot.activeRangeLow + buffer * 0.4,
      tone: snapshot.breakDirection === "up" ? "rgba(103, 232, 165, 0.12)" : "rgba(255, 141, 141, 0.12)",
    });
  }

  return zones.slice(0, 3);
}