import type { ChartLiquidityZone } from "./chartOverlayTypes";
import type { StructureCandle, StructureSnapshot } from "./structureEngine";

export type LiquidityCluster = {
  side: "highs" | "lows";
  price: number;
  touches: number;
  strength: number;
  sweepDetected: boolean;
  rejectionDetected: boolean;
  startIndex: number;
  endIndex: number;
  lastTouchIndex: number;
};

export type LiquiditySnapshot = {
  equalHighs: LiquidityCluster[];
  equalLows: LiquidityCluster[];
  stopClusters: LiquidityCluster[];
  fakeBreakoutRisk: boolean;
};

type LiquidityCandidate = {
  index: number;
  price: number;
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

function resolveClusterTolerance(candles: StructureCandle[]): number {
  if (candles.length === 0) {
    return 0;
  }
  const averageRange = average(candles.map((candle) => Math.max(0, candle.high - candle.low)));
  const referencePrice = Math.max(1, candles[candles.length - 1]?.close || candles[0]?.close || 1);
  return Math.max(referencePrice * 0.00055, averageRange * 0.1, 0.000001);
}

function clusterCandidates(
  candidates: LiquidityCandidate[],
  side: LiquidityCluster["side"],
  candles: StructureCandle[],
  tolerance: number,
): LiquidityCluster[] {
  const sorted = [...candidates].sort((left, right) => left.index - right.index);
  const groups: Array<{ prices: number[]; indexes: number[] }> = [];

  for (const candidate of sorted) {
    const existing = groups.find((group) => Math.abs(average(group.prices) - candidate.price) <= tolerance);
    if (existing) {
      existing.prices.push(candidate.price);
      existing.indexes.push(candidate.index);
    } else {
      groups.push({ prices: [candidate.price], indexes: [candidate.index] });
    }
  }

  return groups
    .filter((group) => group.prices.length >= 2)
    .map((group) => {
      const price = average(group.prices);
      const startIndex = Math.min(...group.indexes);
      const endIndex = Math.max(...group.indexes);
      const lastTouchIndex = endIndex;
      const recency = 1 - Math.max(0, candles.length - 1 - lastTouchIndex) / Math.max(1, candles.length - 1);
      const compactness = 1 - clamp((Math.max(...group.prices) - Math.min(...group.prices)) / Math.max(tolerance, 0.000001), 0, 1);
      const strength = clamp((group.prices.length / 4) * 0.5 + recency * 0.25 + compactness * 0.25, 0, 1);
      const recentCandles = candles.slice(Math.max(0, candles.length - 3));
      const sweepDetected = side === "highs"
        ? recentCandles.some((candle) => candle.high > price + tolerance * 0.3)
        : recentCandles.some((candle) => candle.low < price - tolerance * 0.3);
      const rejectionDetected = side === "highs"
        ? recentCandles.some((candle) => candle.high > price + tolerance * 0.3 && candle.close < price - tolerance * 0.05)
        : recentCandles.some((candle) => candle.low < price - tolerance * 0.3 && candle.close > price + tolerance * 0.05);
      return {
        side,
        price,
        touches: group.prices.length,
        strength,
        sweepDetected,
        rejectionDetected,
        startIndex,
        endIndex,
        lastTouchIndex,
      } satisfies LiquidityCluster;
    })
    .sort((left, right) => right.strength - left.strength)
    .slice(0, 3);
}

function buildCandidates(candles: StructureCandle[], structureSnapshot: StructureSnapshot | null): {
  highs: LiquidityCandidate[];
  lows: LiquidityCandidate[];
} {
  if (structureSnapshot && structureSnapshot.swings.length > 0) {
    const recentWindowStart = Math.max(0, candles.length - 6);
    const recentRawHighs = candles.slice(recentWindowStart).map((candle, offset) => ({
      index: recentWindowStart + offset,
      price: candle.high,
    }));
    const recentRawLows = candles.slice(recentWindowStart).map((candle, offset) => ({
      index: recentWindowStart + offset,
      price: candle.low,
    }));
    return {
      highs: structureSnapshot.swings
        .filter((swing) => swing.side === "high")
        .map((swing) => ({ index: swing.index, price: swing.price }))
        .concat(recentRawHighs),
      lows: structureSnapshot.swings
        .filter((swing) => swing.side === "low")
        .map((swing) => ({ index: swing.index, price: swing.price }))
        .concat(recentRawLows),
    };
  }

  return {
    highs: candles.map((candle, index) => ({ index, price: candle.high })),
    lows: candles.map((candle, index) => ({ index, price: candle.low })),
  };
}

export function detectLiquidity(candles: StructureCandle[], structureSnapshot: StructureSnapshot | null = null): LiquiditySnapshot {
  if (!Array.isArray(candles) || candles.length < 4) {
    return {
      equalHighs: [],
      equalLows: [],
      stopClusters: [],
      fakeBreakoutRisk: false,
    };
  }

  const tolerance = resolveClusterTolerance(candles);
  const candidates = buildCandidates(candles, structureSnapshot);
  const equalHighs = clusterCandidates(candidates.highs, "highs", candles, tolerance);
  const equalLows = clusterCandidates(candidates.lows, "lows", candles, tolerance);
  const stopClusters = [...equalHighs, ...equalLows]
    .sort((left, right) => right.strength - left.strength)
    .slice(0, 4);
  const fakeBreakoutRisk = stopClusters.some((cluster) => cluster.sweepDetected && cluster.rejectionDetected);

  return {
    equalHighs,
    equalLows,
    stopClusters,
    fakeBreakoutRisk,
  };
}

export function buildLiquidityOverlayZones(snapshot: LiquiditySnapshot): ChartLiquidityZone[] {
  const zones: ChartLiquidityZone[] = [];

  snapshot.equalHighs.forEach((cluster) => {
    zones.push({
      level: cluster.price,
      label: cluster.sweepDetected && cluster.rejectionDetected ? `Equal highs sweep ${cluster.touches}x` : `Equal highs ${cluster.touches}x`,
      kind: cluster.sweepDetected && cluster.rejectionDetected ? "sweep" : "equal-highs",
      strength: cluster.strength,
      tone: cluster.sweepDetected && cluster.rejectionDetected ? "warn" : "subtle",
    });
  });

  snapshot.equalLows.forEach((cluster) => {
    zones.push({
      level: cluster.price,
      label: cluster.sweepDetected && cluster.rejectionDetected ? `Equal lows sweep ${cluster.touches}x` : `Equal lows ${cluster.touches}x`,
      kind: cluster.sweepDetected && cluster.rejectionDetected ? "sweep" : "equal-lows",
      strength: cluster.strength,
      tone: cluster.sweepDetected && cluster.rejectionDetected ? "warn" : "subtle",
    });
  });

  return zones
    .sort((left, right) => (right.strength ?? 0) - (left.strength ?? 0))
    .slice(0, 4);
}