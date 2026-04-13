import type { DepthRow } from "./marketDataEngineV4";
import { timeframeToMs } from "./ohlcvDataEngine";

export type OrderflowTrade = {
  price: number;
  size: number;
  side: "buy" | "sell";
  tsMs: number;
  source?: string;
};

export type OrderflowDomLevel = {
  side: "bid" | "ask";
  price: number;
  size: number;
  notional: number;
  intensity: number;
  stacked: boolean;
};

export type OrderflowDomSnapshot = {
  source: "local-orderbook";
  timestamp: string | null;
  syncStatus: "waiting-snapshot" | "live" | "desynced";
  bestBid: number | null;
  bestAsk: number | null;
  spread: number;
  spreadBps: number;
  depthBalance: number;
  domDensity: number;
  liquidityScore: number;
  liquidityWallBelow: boolean;
  liquidityWallAbove: boolean;
  liquidityVacuum: boolean;
  spoofingRisk: number;
  bids: OrderflowDomLevel[];
  asks: OrderflowDomLevel[];
  heatmapLevels: OrderflowDomLevel[];
};

export type OrderflowFootprintLevel = {
  price: number;
  bidVolume: number;
  askVolume: number;
  delta: number;
  imbalance: number;
  intensity: number;
  stacked: boolean;
};

export type OrderflowFootprintSnapshot = {
  source: "local-orderflow";
  timestamp: string | null;
  timeKey: string;
  delta: number;
  totalDelta: number;
  cumulativeDelta: number;
  imbalance: number;
  absorption: boolean;
  absorptionProb: number;
  mlAbsorptionScore: number;
  strongSignal: boolean;
  stackedImbalance: boolean;
  exhaustion: boolean;
  liquidityTrap: boolean;
  liquidityScore: number;
  domDensity: number;
  priceReaction: number;
  spread: number;
  volume: number;
  tradeCount: number;
  mlFeatures: {
    delta: number;
    imbalance: number;
    volume: number;
    spread: number;
    liquidityScore: number;
    domDensity: number;
    priceReaction: number;
  };
  levels: OrderflowFootprintLevel[];
};

export type OrderflowReplayFrame = {
  time: number;
  timeKey: string;
  footprint: OrderflowFootprintSnapshot;
  dom: OrderflowDomSnapshot;
  tradeCount: number;
  volume: number;
};

export type OrderflowRuntimeSnapshot = {
  source: "local-orderflow-engine";
  configKey: string;
  syncStatus: "waiting-snapshot" | "live" | "desynced";
  lastDepthUpdateAt: string | null;
  lastTradeUpdateAt: string | null;
  footprint: OrderflowFootprintSnapshot | null;
  dom: OrderflowDomSnapshot | null;
  replayFrames: OrderflowReplayFrame[];
  replayFrameCount: number;
  archivedFrameCount: number;
  lastReplayTimeKey: string | null;
};

type BucketLevelState = {
  bidVolume: number;
  askVolume: number;
};

type BucketState = {
  timeMs: number;
  timeKey: string;
  totalDelta: number;
  volume: number;
  tradeCount: number;
  levels: Map<number, BucketLevelState>;
};

type DepthDeltaInput = {
  bids?: DepthRow[];
  asks?: DepthRow[];
  tsMs?: number;
  sequence?: number | null;
};

type ReplayArchiveSink = (frames: OrderflowReplayFrame[]) => void;

const DEFAULT_VISIBLE_DEPTH_LEVELS = 20;
const DEFAULT_FOOTPRINT_LEVELS = 8;
const DEFAULT_MAX_REPLAY_FRAMES = 10_000;
const DEFAULT_ARCHIVE_FLUSH_SIZE = 1_000;
const MAX_BUFFERED_DELTAS = 2_048;

function toNumber(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isoFromTs(tsMs?: number | null): string | null {
  return Number.isFinite(tsMs) && Number(tsMs) > 0 ? new Date(Number(tsMs)).toISOString() : null;
}

function timeBucketKey(tsMs: number, timeframe: string): string {
  const bucketMs = Math.max(1_000, timeframeToMs(timeframe));
  return String(Math.floor(tsMs / bucketMs) * bucketMs);
}

class LocalOrderBookEngine {
  readonly bids = new Map<number, number>();
  readonly asks = new Map<number, number>();
  private bufferedDeltas: DepthDeltaInput[] = [];
  private snapshotLoaded = false;
  private lastSequence: number | null = null;
  private syncStatus: OrderflowRuntimeSnapshot["syncStatus"] = "waiting-snapshot";
  private spoofingEvents: Array<{ tsMs: number; weight: number }> = [];

  reset(): void {
    this.bids.clear();
    this.asks.clear();
    this.bufferedDeltas = [];
    this.snapshotLoaded = false;
    this.lastSequence = null;
    this.syncStatus = "waiting-snapshot";
    this.spoofingEvents = [];
  }

  ingestSnapshot(bids: DepthRow[], asks: DepthRow[], sequence?: number | null, tsMs?: number): void {
    this.bids.clear();
    this.asks.clear();
    this.applyRows(this.bids, bids, tsMs);
    this.applyRows(this.asks, asks, tsMs);
    this.snapshotLoaded = true;
    this.lastSequence = Number.isFinite(sequence) ? Number(sequence) : null;
    this.syncStatus = "live";

    if (this.bufferedDeltas.length > 0) {
      const pending = this.bufferedDeltas.slice();
      this.bufferedDeltas = [];
      pending.forEach((delta) => this.ingestDelta(delta));
    }
  }

  ingestDelta(delta: DepthDeltaInput): void {
    if (!this.snapshotLoaded) {
      this.bufferedDeltas.push(delta);
      if (this.bufferedDeltas.length > MAX_BUFFERED_DELTAS) {
        this.bufferedDeltas.shift();
      }
      this.syncStatus = "waiting-snapshot";
      return;
    }

    const nextSequence = Number.isFinite(delta.sequence) ? Number(delta.sequence) : null;
    if (nextSequence !== null && this.lastSequence !== null && nextSequence > this.lastSequence + 1) {
      this.syncStatus = "desynced";
      this.snapshotLoaded = false;
      this.bufferedDeltas = [delta];
      return;
    }

    this.applyRows(this.bids, delta.bids || [], delta.tsMs);
    this.applyRows(this.asks, delta.asks || [], delta.tsMs);
    this.lastSequence = nextSequence ?? this.lastSequence;
    this.syncStatus = "live";
  }

  getSyncStatus(): OrderflowRuntimeSnapshot["syncStatus"] {
    return this.syncStatus;
  }

  getSpoofingRisk(now = Date.now()): number {
    const cutoff = now - 8_000;
    this.spoofingEvents = this.spoofingEvents.filter((event) => event.tsMs >= cutoff);
    const sum = this.spoofingEvents.reduce((total, event) => total + event.weight, 0);
    return clamp(sum, 0, 1);
  }

  snapshot(topLevels = DEFAULT_VISIBLE_DEPTH_LEVELS): { bids: DepthRow[]; asks: DepthRow[] } {
    const bids = [...this.bids.entries()]
      .sort((left, right) => right[0] - left[0])
      .slice(0, topLevels)
      .map(([price, size]) => [price, size] as DepthRow);
    const asks = [...this.asks.entries()]
      .sort((left, right) => left[0] - right[0])
      .slice(0, topLevels)
      .map(([price, size]) => [price, size] as DepthRow);
    return { bids, asks };
  }

  private applyRows(target: Map<number, number>, rows: DepthRow[], tsMs?: number): void {
    rows.forEach((row) => {
      const price = toNumber(row[0], 0);
      const size = Math.max(0, toNumber(row[1], 0));
      if (!(price > 0)) {
        return;
      }
      const previous = target.get(price) ?? 0;
      if (size <= 0) {
        target.delete(price);
      } else {
        target.set(price, size);
      }
      const dropRatio = previous > 0 ? Math.max(0, previous - size) / previous : 0;
      if (previous >= 20 && size <= previous * 0.2 && dropRatio >= 0.7) {
        this.spoofingEvents.push({ tsMs: tsMs || Date.now(), weight: clamp(previous / 120, 0.08, 0.34) });
      }
    });
  }
}

export class OrderflowRuntimeEngine {
  private readonly configKey: string;
  private readonly timeframe: string;
  private readonly maxReplayFrames: number;
  private readonly archiveFlushSize: number;
  private readonly orderBook = new LocalOrderBookEngine();
  private readonly buckets = new Map<string, BucketState>();
  private readonly replayFrames = new Map<string, OrderflowReplayFrame>();
  private archivedFrameCount = 0;
  private cumulativeDelta = 0;
  private lastDepthUpdateAt: number | null = null;
  private lastTradeUpdateAt: number | null = null;
  private archiveSink: ReplayArchiveSink | null = null;

  constructor(input: { configKey: string; timeframe: string; maxReplayFrames?: number; archiveFlushSize?: number }) {
    this.configKey = input.configKey;
    this.timeframe = input.timeframe;
    this.maxReplayFrames = Math.max(256, Math.floor(input.maxReplayFrames || DEFAULT_MAX_REPLAY_FRAMES));
    this.archiveFlushSize = Math.max(64, Math.floor(input.archiveFlushSize || DEFAULT_ARCHIVE_FLUSH_SIZE));
  }

  setArchiveSink(sink: ReplayArchiveSink | null): void {
    this.archiveSink = sink;
  }

  reset(): void {
    this.orderBook.reset();
    this.buckets.clear();
    this.replayFrames.clear();
    this.archivedFrameCount = 0;
    this.cumulativeDelta = 0;
    this.lastDepthUpdateAt = null;
    this.lastTradeUpdateAt = null;
  }

  ingestDepthSnapshot(input: { bids: DepthRow[]; asks: DepthRow[]; tsMs?: number; sequence?: number | null }): void {
    this.orderBook.ingestSnapshot(input.bids, input.asks, input.sequence, input.tsMs);
    this.lastDepthUpdateAt = input.tsMs ?? Date.now();
    this.refreshLatestReplayFrame(this.lastDepthUpdateAt);
  }

  ingestDepthDelta(input: DepthDeltaInput): void {
    this.orderBook.ingestDelta(input);
    this.lastDepthUpdateAt = input.tsMs ?? Date.now();
    this.refreshLatestReplayFrame(this.lastDepthUpdateAt);
  }

  ingestTrades(trades: OrderflowTrade[]): void {
    trades.forEach((trade) => this.ingestTrade(trade));
  }

  ingestTrade(trade: OrderflowTrade): void {
    const tsMs = Number.isFinite(trade.tsMs) ? trade.tsMs : Date.now();
    const price = toNumber(trade.price, 0);
    const size = Math.max(0, toNumber(trade.size, 0));
    if (!(price > 0) || !(size > 0)) {
      return;
    }
    const side = trade.side === "sell" ? "sell" : "buy";
    const timeKey = timeBucketKey(tsMs, this.timeframe);
    const bucket = this.buckets.get(timeKey) || {
      timeMs: Number(timeKey),
      timeKey,
      totalDelta: 0,
      volume: 0,
      tradeCount: 0,
      levels: new Map<number, BucketLevelState>(),
    };
    const level = bucket.levels.get(price) || { bidVolume: 0, askVolume: 0 };
    if (side === "buy") {
      level.askVolume += size;
      bucket.totalDelta += size;
      this.cumulativeDelta += size;
    } else {
      level.bidVolume += size;
      bucket.totalDelta -= size;
      this.cumulativeDelta -= size;
    }
    bucket.volume += size;
    bucket.tradeCount += 1;
    bucket.levels.set(price, level);
    this.buckets.set(timeKey, bucket);
    this.lastTradeUpdateAt = tsMs;
    this.refreshReplayFrame(timeKey);
    this.pruneOldBuckets();
  }

  getSnapshot(): OrderflowRuntimeSnapshot {
    const latestTimeKey = this.resolveLatestTimeKey();
    const dom = this.buildDomSnapshot(this.lastDepthUpdateAt || this.lastTradeUpdateAt || undefined);
    const footprint = latestTimeKey ? this.buildFootprintSnapshot(latestTimeKey, dom) : null;
    const replayFrames = [...this.replayFrames.values()].sort((left, right) => left.time - right.time);
    return {
      source: "local-orderflow-engine",
      configKey: this.configKey,
      syncStatus: this.orderBook.getSyncStatus(),
      lastDepthUpdateAt: isoFromTs(this.lastDepthUpdateAt),
      lastTradeUpdateAt: isoFromTs(this.lastTradeUpdateAt),
      footprint,
      dom,
      replayFrames,
      replayFrameCount: replayFrames.length,
      archivedFrameCount: this.archivedFrameCount,
      lastReplayTimeKey: replayFrames[replayFrames.length - 1]?.timeKey || latestTimeKey || null,
    };
  }

  private refreshLatestReplayFrame(tsMs: number): void {
    const latestTimeKey = this.resolveLatestTimeKey() || timeBucketKey(tsMs, this.timeframe);
    this.refreshReplayFrame(latestTimeKey);
  }

  private refreshReplayFrame(timeKey: string): void {
    const dom = this.buildDomSnapshot(this.lastDepthUpdateAt || Date.now());
    const footprint = this.buildFootprintSnapshot(timeKey, dom);
    if (!footprint || !dom) {
      return;
    }
    this.replayFrames.set(timeKey, {
      time: Number(timeKey),
      timeKey,
      footprint,
      dom,
      tradeCount: footprint.tradeCount,
      volume: footprint.volume,
    });
    this.trimReplayFrames();
  }

  private trimReplayFrames(): void {
    if (this.replayFrames.size <= this.maxReplayFrames) {
      return;
    }
    const sortedKeys = [...this.replayFrames.keys()].sort((left, right) => Number(left) - Number(right));
    const flushCount = Math.min(this.archiveFlushSize, sortedKeys.length - this.maxReplayFrames + this.archiveFlushSize);
    const archived: OrderflowReplayFrame[] = [];
    for (let index = 0; index < flushCount; index += 1) {
      const key = sortedKeys[index];
      const frame = this.replayFrames.get(key);
      if (!frame) {
        continue;
      }
      archived.push(frame);
      this.replayFrames.delete(key);
    }
    this.archivedFrameCount += archived.length;
    if (this.archiveSink && archived.length > 0) {
      this.archiveSink(archived);
    }
  }

  private pruneOldBuckets(): void {
    const maxBuckets = this.maxReplayFrames + this.archiveFlushSize;
    if (this.buckets.size <= maxBuckets) {
      return;
    }
    const sortedKeys = [...this.buckets.keys()].sort((left, right) => Number(left) - Number(right));
    const excess = this.buckets.size - maxBuckets;
    for (let index = 0; index < excess; index += 1) {
      this.buckets.delete(sortedKeys[index]);
    }
  }

  private resolveLatestTimeKey(): string | null {
    if (this.lastTradeUpdateAt) {
      return timeBucketKey(this.lastTradeUpdateAt, this.timeframe);
    }
    const latestFrame = [...this.replayFrames.keys()].sort((left, right) => Number(right) - Number(left))[0];
    return latestFrame || null;
  }

  private buildFootprintSnapshot(timeKey: string, dom: OrderflowDomSnapshot | null): OrderflowFootprintSnapshot | null {
    const bucket = this.buckets.get(timeKey);
    if (!bucket) {
      return null;
    }
    const levels = [...bucket.levels.entries()]
      .map(([price, level]) => {
        const bidVolume = Math.max(0, level.bidVolume);
        const askVolume = Math.max(0, level.askVolume);
        const total = bidVolume + askVolume;
        return {
          price,
          bidVolume,
          askVolume,
          delta: askVolume - bidVolume,
          imbalance: askVolume / Math.max(bidVolume, 1e-6),
          intensity: total > 0 ? Math.abs(askVolume - bidVolume) / total : 0,
          stacked: false,
        } satisfies OrderflowFootprintLevel;
      })
      .sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta));

    let positiveRun = 0;
    let negativeRun = 0;
    const stackedLevels = levels.slice(0, DEFAULT_FOOTPRINT_LEVELS).map((level) => {
      const bullish = level.delta > 0 && level.imbalance >= 1.8;
      const bearish = level.delta < 0 && level.imbalance > 0 && level.imbalance <= 0.55;
      positiveRun = bullish ? positiveRun + 1 : 0;
      negativeRun = bearish ? negativeRun + 1 : 0;
      return {
        ...level,
        stacked: positiveRun >= 2 || negativeRun >= 2,
      };
    });

    const volume = bucket.volume;
    const imbalance = volume > 0 ? bucket.totalDelta / volume : 0;
    const stackedImbalance = stackedLevels.some((level) => level.stacked);
    const bucketVwap = volume > 0
      ? [...bucket.levels.entries()].reduce((total, [price, level]) => total + price * (level.askVolume + level.bidVolume), 0) / volume
      : 0;
    const midPrice = dom !== null && dom.bestBid !== null && dom.bestAsk !== null
      ? ((dom.bestBid || 0) + (dom.bestAsk || 0)) * 0.5
      : bucketVwap;
    const priceReaction = midPrice > 0 ? Math.abs(midPrice - bucketVwap) / midPrice : 0;
    const domDensity = dom?.domDensity || 0;
    const absorption = Math.abs(bucket.totalDelta) <= Math.max(volume * 0.14, 1) && (dom?.spreadBps || 0) <= 12 && volume > 0 && priceReaction <= 0.0012;
    const exhaustion = bucket.tradeCount >= 3 && Math.abs(bucket.totalDelta) <= Math.max(volume * 0.08, 0.5);
    const liquidityTrap = Boolean(dom?.liquidityVacuum && Math.abs(imbalance) < 0.12 && volume > 0);
    const liquidityScore = dom?.liquidityScore || 0;
    const absorptionProb = clamp(
      (absorption ? 0.42 : 0)
        + (1 - Math.min(1, Math.abs(imbalance))) * 0.22
        + liquidityScore * 0.18
        + domDensity * 0.14
        + clamp((0.0014 - priceReaction) / 0.0014, 0, 1) * 0.12
        + clamp((dom?.spoofingRisk || 0) * 0.12, 0, 0.12)
        + clamp((dom && dom.spreadBps <= 8 ? 0.08 : 0), 0, 0.08),
      0,
      1,
    );
    const mlAbsorptionScore = clamp(
      absorptionProb * 0.56
        + liquidityScore * 0.14
        + domDensity * 0.1
        + clamp((0.18 - Math.abs(imbalance)) / 0.18, 0, 1) * 0.08
        + clamp((0.0012 - priceReaction) / 0.0012, 0, 1) * 0.08
        + (stackedImbalance ? 0.04 : 0)
        + (exhaustion ? 0.04 : 0)
        - (liquidityTrap ? 0.03 : 0),
      0,
      1,
    );
    const strongSignal = mlAbsorptionScore >= 0.78 || absorptionProb >= 0.82;
    return {
      source: "local-orderflow",
      timestamp: isoFromTs(bucket.timeMs),
      timeKey,
      delta: bucket.totalDelta,
      totalDelta: bucket.totalDelta,
      cumulativeDelta: this.cumulativeDelta,
      imbalance,
      absorption,
      absorptionProb,
      mlAbsorptionScore,
      strongSignal,
      stackedImbalance,
      exhaustion,
      liquidityTrap,
      liquidityScore,
      domDensity,
      priceReaction,
      spread: dom?.spread || 0,
      volume,
      tradeCount: bucket.tradeCount,
      mlFeatures: {
        delta: bucket.totalDelta,
        imbalance,
        volume,
        spread: dom?.spread || 0,
        liquidityScore,
        domDensity,
        priceReaction,
      },
      levels: stackedLevels,
    };
  }

  private buildDomSnapshot(tsMs?: number): OrderflowDomSnapshot | null {
    const { bids, asks } = this.orderBook.snapshot(DEFAULT_VISIBLE_DEPTH_LEVELS);
    if (bids.length === 0 || asks.length === 0) {
      return null;
    }
    const bestBid = bids[0]?.[0] ?? null;
    const bestAsk = asks[0]?.[0] ?? null;
    const spread = bestBid !== null && bestAsk !== null ? Math.max(0, bestAsk - bestBid) : 0;
    const mid = bestBid !== null && bestAsk !== null ? Math.max((bestBid + bestAsk) * 0.5, 1e-6) : 1;
    const spreadBps = spread / mid * 10_000;
    const bidDepth = bids.slice(0, 5).reduce((sum, level) => sum + Math.max(0, level[1]), 0);
    const askDepth = asks.slice(0, 5).reduce((sum, level) => sum + Math.max(0, level[1]), 0);
    const touchDepth = bidDepth + askDepth;
    const fullDepth = bids.reduce((sum, level) => sum + Math.max(0, level[1]), 0) + asks.reduce((sum, level) => sum + Math.max(0, level[1]), 0);
    const depthBalance = (bidDepth - askDepth) / Math.max(touchDepth, 1e-9);
    const domDensity = clamp(touchDepth / Math.max(fullDepth, 1e-9), 0, 1);
    const liquidityScore = clamp((touchDepth / Math.max(fullDepth, 1e-9)) * 0.42 + (1 - clamp(spreadBps / 16, 0, 1)) * 0.34 + (1 - this.orderBook.getSpoofingRisk()) * 0.24, 0, 1);
    const maxBid = Math.max(...bids.slice(0, 8).map((level) => level[1] || 0), 0);
    const maxAsk = Math.max(...asks.slice(0, 8).map((level) => level[1] || 0), 0);
    const wallThreshold = Math.max(12, Math.max(maxBid, maxAsk) * 0.72);

    const toLevels = (rows: DepthRow[], side: "bid" | "ask") => rows.slice(0, DEFAULT_VISIBLE_DEPTH_LEVELS).map(([price, size]) => ({
      side,
      price,
      size,
      notional: price * size,
      intensity: clamp(Math.log1p(size) / Math.log(64), 0, 1),
      stacked: size >= wallThreshold,
    }));

    const bidLevels = toLevels(bids, "bid");
    const askLevels = toLevels(asks, "ask");
    const heatmapLevels = [...askLevels.slice(0, 10).reverse(), ...bidLevels.slice(0, 10)];
    return {
      source: "local-orderbook",
      timestamp: isoFromTs(tsMs || Date.now()),
      syncStatus: this.orderBook.getSyncStatus(),
      bestBid,
      bestAsk,
      spread,
      spreadBps,
      depthBalance,
      domDensity,
      liquidityScore,
      liquidityWallBelow: bidLevels.some((level) => level.stacked),
      liquidityWallAbove: askLevels.some((level) => level.stacked),
      liquidityVacuum: fullDepth < 40 || spreadBps >= 14,
      spoofingRisk: this.orderBook.getSpoofingRisk(),
      bids: bidLevels,
      asks: askLevels,
      heatmapLevels,
    };
  }
}