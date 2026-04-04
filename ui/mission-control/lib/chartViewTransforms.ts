import type { OhlcvBar } from "./marketDataBus";

type QuotePointLike = { label: string; value: number };
type OverlayZoneLike = {
  kind: "fvg" | "ob";
  label: string;
  x1: number;
  x2: number;
  low: number;
  high: number;
  tone: string;
};
type LiquidityZoneLike = { level: number; label: string };
type FootprintRowLike = {
  low: number;
  high: number;
  buyVolume: number;
  sellVolume: number;
  delta: number;
  timeLabel?: string;
  timeKey?: string;
};
type TapePrintLike = {
  label: string;
  price: number;
  delta: number;
  side: "buy" | "sell" | "flat";
  volume: number;
  timeKey?: string;
};
type DomLevelLike = { side: "bid" | "ask"; price: number; size: number; intensity: number };

function toNumber(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function volumeFromDelta(delta: number, index: number): number {
  return Math.max(1, Math.round(Math.abs(delta) * 140 + 14 + (index % 5) * 6));
}

function timeframeSeconds(timeframe: string): number {
  if (timeframe === "5m") {
    return 300;
  }
  if (timeframe === "15m") {
    return 900;
  }
  return 60;
}

function parseTimestampLike(value: string): number | null {
  const direct = Date.parse(value);
  if (Number.isFinite(direct)) {
    return direct;
  }

  const clockMatch = value.match(/(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!clockMatch) {
    return null;
  }

  const now = new Date();
  now.setHours(Number(clockMatch[1]), Number(clockMatch[2]), Number(clockMatch[3] || "0"), 0);
  return now.getTime();
}

function toTimeBucketKey(value: string | number, timeframe: string): string {
  const stepMs = timeframeSeconds(timeframe) * 1000;
  const parsed = typeof value === "number" ? value : parseTimestampLike(value);
  if (!parsed || !Number.isFinite(parsed)) {
    return "";
  }
  return String(Math.floor(parsed / stepMs) * stepMs);
}

function formatClock(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return `${String(parsed.getHours()).padStart(2, "0")}:${String(parsed.getMinutes()).padStart(2, "0")}:${String(parsed.getSeconds()).padStart(2, "0")}`;
}

export function buildOverlayZones(points: QuotePointLike[]): OverlayZoneLike[] {
  if (points.length < 6) {
    return [];
  }

  const values = points.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(max - min, 1);
  const zones: OverlayZoneLike[] = [];

  for (let index = 2; index < points.length - 2; index += 1) {
    const previous = points[index - 1].value;
    const current = points[index].value;
    const next = points[index + 1].value;

    if (Math.abs(current - previous) > range * 0.22 && Math.abs(next - current) > range * 0.18 && zones.filter((zone) => zone.kind === "fvg").length < 2) {
      zones.push({
        kind: "fvg",
        label: next > current ? "Bullish FVG" : "Bearish FVG",
        x1: Math.max(0, index - 1),
        x2: Math.min(points.length - 1, index + 2),
        low: Math.min(previous, current, next),
        high: Math.max(previous, current, next),
        tone: next > current ? "rgba(89, 214, 149, 0.14)" : "rgba(255, 124, 124, 0.14)",
      });
    }

    const reversal = (current - previous) * (next - current) < 0;
    if (reversal && zones.filter((zone) => zone.kind === "ob").length < 2) {
      const window = points.slice(Math.max(0, index - 2), Math.min(points.length, index + 2));
      zones.push({
        kind: "ob",
        label: next > current ? "Bullish OB" : "Bearish OB",
        x1: Math.max(0, index - 2),
        x2: Math.min(points.length - 1, index + 3),
        low: Math.min(...window.map((point) => point.value)),
        high: Math.max(...window.map((point) => point.value)),
        tone: next > current ? "rgba(88, 199, 255, 0.14)" : "rgba(255, 125, 125, 0.14)",
      });
    }
  }

  return zones.slice(0, 4);
}

export function buildLiquidityZones(points: QuotePointLike[]): LiquidityZoneLike[] {
  if (points.length === 0) {
    return [];
  }
  const counts = new Map<number, number>();
  for (const point of points) {
    const bucket = Number(point.value.toFixed(1));
    counts.set(bucket, (counts.get(bucket) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 2)
    .map(([level], index) => ({ level, label: index === 0 ? "Liquidity pool" : "Resting liquidity" }));
}

export function buildTape(points: QuotePointLike[], timeframe: string): TapePrintLike[] {
  return points.slice(-12).map((point, index, array) => {
    const previous = index === 0 ? point.value : array[index - 1].value;
    const delta = point.value - previous;
    const side: TapePrintLike["side"] = delta > 0 ? "buy" : delta < 0 ? "sell" : "flat";
    return {
      label: point.label,
      price: point.value,
      delta,
      side,
      volume: volumeFromDelta(delta, index),
      timeKey: toTimeBucketKey(point.label, timeframe),
    };
  }).reverse();
}

export function buildFootprint(points: QuotePointLike[]): FootprintRowLike[] {
  if (points.length === 0) {
    return [];
  }
  const values = points.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(max - min, 1);
  const step = range / 6;
  const rows: FootprintRowLike[] = Array.from({ length: 6 }, (_, index) => ({
    low: min + step * index,
    high: min + step * (index + 1),
    buyVolume: 0,
    sellVolume: 0,
    delta: 0,
  }));

  for (let index = 1; index < points.length; index += 1) {
    const price = points[index].value;
    const delta = price - points[index - 1].value;
    const volume = volumeFromDelta(delta, index);
    const bucket = Math.min(rows.length - 1, Math.max(0, Math.floor(((price - min) / range) * rows.length)));
    if (delta >= 0) {
      rows[bucket].buyVolume += volume;
    } else {
      rows[bucket].sellVolume += volume;
    }
    rows[bucket].delta = rows[bucket].buyVolume - rows[bucket].sellVolume;
  }

  return rows.reverse();
}

export function buildDomLevels(orderbook: Record<string, unknown> | null): DomLevelLike[] {
  const bid = toNumber(orderbook?.bid, 0);
  const ask = toNumber(orderbook?.ask, 0);
  const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : Math.max(bid, ask, 1);
  const spread = Math.max(Math.abs(ask - bid), mid * 0.0004);
  const levels: DomLevelLike[] = [];

  for (let index = 0; index < 8; index += 1) {
    const bidDistance = spread * (index + 0.5);
    const askDistance = spread * (index + 0.5);
    const bidSize = Math.round(80 - index * 8 + (index % 3) * 6);
    const askSize = Math.round(78 - index * 7 + ((index + 1) % 3) * 7);
    levels.push({ side: "bid", price: Number((mid - bidDistance).toFixed(2)), size: bidSize, intensity: Math.max(0.2, bidSize / 90) });
    levels.push({ side: "ask", price: Number((mid + askDistance).toFixed(2)), size: askSize, intensity: Math.max(0.2, askSize / 90) });
  }

  return levels.sort((left, right) => right.price - left.price);
}

export function buildDomLevelsFromDepth(depth: Record<string, unknown> | null): DomLevelLike[] {
  const payload = (depth?.depth_payload as Record<string, unknown> | undefined) || {};
  const bids = (payload.bids as unknown[] | undefined) || [];
  const asks = (payload.asks as unknown[] | undefined) || [];
  const toLevels = (rows: unknown[], side: "bid" | "ask") => rows.slice(0, 12).map((row) => {
    const level = Array.isArray(row) ? row : [];
    const price = toNumber(level[0], 0);
    const size = toNumber(level[1], 0);
    return {
      side,
      price,
      size,
      intensity: Math.max(0.15, Math.min(1, size / 40)),
    };
  });
  return [...toLevels(asks, "ask"), ...toLevels(bids, "bid")].sort((left, right) => right.price - left.price);
}

export function buildTapeFromTrades(trades: Record<string, unknown>[], timeframe: string): TapePrintLike[] {
  return trades.slice(0, 18).map((trade) => {
    const sideRaw = String(trade.side || "flat").toLowerCase();
    const side: TapePrintLike["side"] = sideRaw === "buy" || sideRaw === "sell" ? sideRaw : "flat";
    const label = String(trade.traded_at || "-");
    return {
      label,
      price: toNumber(trade.price, 0),
      delta: 0,
      side,
      volume: Math.max(1, Math.round(toNumber(trade.size, 0) * 1000)),
      timeKey: toTimeBucketKey(label, timeframe),
    };
  });
}

export function buildFootprintFromOhlcv(rows: OhlcvBar[], timeframe: string): FootprintRowLike[] {
  return rows.slice(-8).map((row) => {
    const low = toNumber(row.l, 0);
    const high = toNumber(row.h, low);
    const volume = Math.max(0, toNumber(row.v, 0));
    const open = toNumber(row.o, low);
    const close = toNumber(row.c, low);
    const bullish = close >= open;
    const buyVolume = bullish ? volume * 0.62 : volume * 0.38;
    const sellVolume = volume - buyVolume;
    const sourceTime = String(row.t || "-");
    return {
      low,
      high,
      buyVolume,
      sellVolume,
      delta: buyVolume - sellVolume,
      timeLabel: formatClock(sourceTime),
      timeKey: toTimeBucketKey(sourceTime, timeframe),
    };
  }).reverse();
}

export function resolveSignalCalibration(symbol: string, timeframe: string): {
  assetClass: "crypto" | "fx" | "index" | "other";
  label: string;
  imbalanceRatio: number;
  absorptionDeltaRatio: number;
  absorptionMovePctMax: number;
  continuationDeltaRatio: number;
  continuationMovePctMin: number;
  breakoutPct: number;
  trapSweepPct: number;
} {
  const upper = symbol.toUpperCase();
  const assetClass =
    /(BTC|ETH|SOL|XRP|DOGE|ADA|AVAX|BNB)/.test(upper) ? "crypto"
      : /^[A-Z]{6}$/.test(upper) || /(EUR|USD|JPY|GBP|CHF|AUD|NZD|CAD)/.test(upper) ? "fx"
        : /(NAS|SPX|DAX|DJI|NQ|US30|GER40|XAU|XAG)/.test(upper) ? "index"
          : "other";

  const base =
    assetClass === "crypto"
      ? { imbalanceRatio: 2.7, absorptionDeltaRatio: 0.17, absorptionMovePctMax: 0.0009, continuationDeltaRatio: 0.2, continuationMovePctMin: 0.0011, breakoutPct: 0.0008, trapSweepPct: 0.00115 }
      : assetClass === "fx"
        ? { imbalanceRatio: 3.25, absorptionDeltaRatio: 0.22, absorptionMovePctMax: 0.00045, continuationDeltaRatio: 0.25, continuationMovePctMin: 0.0007, breakoutPct: 0.00045, trapSweepPct: 0.0007 }
        : assetClass === "index"
          ? { imbalanceRatio: 2.95, absorptionDeltaRatio: 0.2, absorptionMovePctMax: 0.00065, continuationDeltaRatio: 0.23, continuationMovePctMin: 0.00095, breakoutPct: 0.00065, trapSweepPct: 0.00095 }
          : { imbalanceRatio: 3, absorptionDeltaRatio: 0.2, absorptionMovePctMax: 0.0006, continuationDeltaRatio: 0.22, continuationMovePctMin: 0.0009, breakoutPct: 0.0006, trapSweepPct: 0.0009 };
  const tfFactor = timeframe === "1m" ? 0.94 : timeframe === "5m" ? 1 : 1.1;
  return {
    assetClass,
    label: `${assetClass.toUpperCase()} ${timeframe}`,
    imbalanceRatio: base.imbalanceRatio * tfFactor,
    absorptionDeltaRatio: base.absorptionDeltaRatio * (timeframe === "15m" ? 1.08 : 1),
    absorptionMovePctMax: base.absorptionMovePctMax * (timeframe === "1m" ? 1.15 : timeframe === "15m" ? 0.9 : 1),
    continuationDeltaRatio: base.continuationDeltaRatio * (timeframe === "1m" ? 0.96 : 1.05),
    continuationMovePctMin: base.continuationMovePctMin * (timeframe === "15m" ? 1.12 : 1),
    breakoutPct: base.breakoutPct * (timeframe === "15m" ? 1.15 : 1),
    trapSweepPct: base.trapSweepPct * (timeframe === "15m" ? 1.1 : 1),
  };
}