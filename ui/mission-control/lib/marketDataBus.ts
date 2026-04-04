type JsonMap = Record<string, unknown>;

import { normalizeOhlcvRows, type NormalizedOhlcvBar } from "./ohlcvIntegrity";
import { MarketDataEngineV5, type GapRange } from "./marketDataEngineV5";
import type { DepthRow } from "./marketDataEngineV4";
import { clearChartFrame, publishChartFrame, type LiveChartCandle } from "./chartFrameFeed";
import { PriceFusionEngineV6, type RouteCandidate, type VenueQuote } from "./priceFusionEngineV6";
import { timeframeToMs } from "./ohlcvDataEngine";

export type OhlcvBar = NormalizedOhlcvBar;

export type MarketBusRequestType = "ui" | "ai" | "execution";

export type MarketDataBusConfig = {
  instrument: string;
  venue: string;
  timeframe: string;
};

export type MarketDataBusSnapshot = {
  configKey: string;
  ohlcvBars: OhlcvBar[];
  nativeTrades: JsonMap[];
  marketMicro: JsonMap | null;
  sessionState: JsonMap | null;
  orderbook: JsonMap | null;
  marketDepth: JsonMap | null;
  routingScore: JsonMap | null;
  busMeta: JsonMap | null;
  chartLoading: boolean;
  ohlcvStreamState: "offline" | "connecting" | "live";
  depthStreamState: "offline" | "connecting" | "live";
  kernelTelemetry: MarketDataBusKernelTelemetry;
  lastSyncAt: string | null;
};

export type MarketDataBusSchedulerHint = {
  fps?: number;
  frameTimeMs?: number;
  cpuLoad?: number;
};

export type MarketDataBusKernelTelemetry = {
  tickLatencyMs: number;
  bufferBacklog: number;
  drainedTicksPerFrame: number;
  skippedFrames: number;
  schedulerBudgetMs: number;
  schedulerPullLimit: number;
  cpuLoadHint: number;
  fpsHint: number;
  frameTimeHintMs: number;
  backlogPressure: number;
  framesProcessed: number;
  benchmarkMode: boolean;
  benchmarkTicksPerSec: number;
  benchmarkInjectedTicks: number;
  receivedTicks: number;
  candleUpdates: number;
  syntheticHeartbeatOpens: number;
  lastCandleUpdateAt: string | null;
  lastDrainAt: string | null;
};

type MarketDataBusListener = (snapshot: MarketDataBusSnapshot) => void;

const SIDE_REFRESH_MS = 2_500;
const PUBLIC_SIDE_REFRESH_MS = 5_000;
const SNAPSHOT_RETRY_COOLDOWN_MS = 30_000;
const STREAM_FAILURE_THRESHOLD = 3;
const STREAM_FAILURE_COOLDOWN_MS = 60_000;
const LIVE_REACT_BAR_COMMIT_MS = 750;
const LIVE_REACT_FORCE_COMMIT_MS = 2_000;
const LIVE_NATIVE_TRADES_LIMIT = 200;
const FUSION_PUBLIC_VENUES = ["binance-public", "coinbase-public", "okx-public"] as const;
const TRADE_RING_CAPACITY = 2048;
const TRADE_PULL_LIMIT_PER_FRAME = 320;
const TRADE_PULL_BUDGET_MS = 5;
const SYNTHETIC_HEARTBEAT_MS = 1_000;
const MICRO_TF_HEARTBEAT_MAX_MS = 10_000;

type StreamKind = "ohlcv" | "depth";

function toNumber(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function buildRequestHeaders(requestType: MarketBusRequestType, instrument: string): HeadersInit {
  return {
    "x-mc-request-type": requestType,
    "x-mc-priority": requestType === "execution" ? "execution" : requestType === "ai" ? "high" : "low",
    "x-mc-symbol": instrument,
    "x-mc-origin": "terminal",
  };
}

function isGtixPublicHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized === "app.txt.gtixt.com"
    || normalized === "staging.txt.gtixt.com"
    || normalized === "api.txt.gtixt.com"
    || normalized === "api.staging.txt.gtixt.com";
}

function buildMarketOhlcvWsUrl(instrument: string, venue: string, timeframe: string, limit = 500): string {
  if (typeof window === "undefined") {
    return "";
  }
  if (isGtixPublicHost(window.location.hostname)) {
    return "";
  }
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const base = `${protocol}://${window.location.host}`;
  const params = new URLSearchParams({
    venue,
    timeframe,
    limit: String(limit),
  });
  return `${base}/ws/v1/market/ohlcv/${encodeURIComponent(instrument)}?${params.toString()}`;
}

function canonicalInstrumentForVenue(instrument: string, venue: string): string {
  const normalized = String(instrument || "").replace("-PERP", "").replace(/[/-]/g, "").toUpperCase();
  if (
    ["binance-public", "coinbase-public", "okx-public"].includes(venue)
    && normalized.endsWith("USD")
    && !normalized.endsWith("USDT")
  ) {
    return `${normalized.slice(0, -3)}USDT`;
  }
  return normalized;
}

function fusionInstrumentCandidates(instrument: string): string[] {
  const normalized = canonicalInstrumentForVenue(instrument, "binance-public");
  const candidates = new Set<string>([normalized]);
  if (normalized.endsWith("USDT")) {
    candidates.add(`${normalized.slice(0, -4)}USD`);
  } else if (normalized.endsWith("USD")) {
    candidates.add(`${normalized.slice(0, -3)}USDT`);
  }
  return [...candidates];
}

function buildMarketDepthWsUrl(instrument: string, venue: string): string {
  if (typeof window === "undefined") {
    return "";
  }
  if (isGtixPublicHost(window.location.hostname)) {
    return "";
  }
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const base = `${protocol}://${window.location.host}`;
  return `${base}/ws/v1/market/orderbook/depth/${encodeURIComponent(canonicalInstrumentForVenue(instrument, venue))}?venue=${encodeURIComponent(venue)}`;
}

function buildMarketTradesWsUrl(instrument: string, venue: string, limit = 200): string {
  if (typeof window === "undefined") {
    return "";
  }
  if (isGtixPublicHost(window.location.hostname)) {
    return "";
  }
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const base = `${protocol}://${window.location.host}`;
  const params = new URLSearchParams({
    venue,
    limit: String(limit),
  });
  return `${base}/ws/v1/market/trades/${encodeURIComponent(canonicalInstrumentForVenue(instrument, venue))}?${params.toString()}`;
}

function tradeTimestampMs(trade: JsonMap): number {
  const raw = trade.traded_at;
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return toNumber(trade.tsMs ?? trade.ts ?? trade.T, Date.now());
}

function tradeSignature(trade: JsonMap): string {
  const venue = String(trade.venue || "unknown");
  const instrument = String(trade.instrument || "unknown");
  const tradeId = String(trade.trade_id || trade.id || "");
  const tradedAt = tradeTimestampMs(trade);
  const price = toNumber(trade.price ?? trade.p, 0).toFixed(8);
  const size = toNumber(trade.size ?? trade.q ?? trade.qty, 0).toFixed(8);
  return `${venue}|${instrument}|${tradeId}|${tradedAt}|${price}|${size}`;
}

class TradeRingBuffer {
  private readonly stride = 4;
  private readonly capacity: number;
  private readonly storage: Float64Array;
  private readIndex = 0;
  private writeIndex = 0;

  constructor(capacity = TRADE_RING_CAPACITY) {
    this.capacity = Math.max(64, capacity);
    this.storage = new Float64Array(this.capacity * this.stride);
  }

  clear(): void {
    this.readIndex = 0;
    this.writeIndex = 0;
  }

  hasData(): boolean {
    return this.writeIndex > this.readIndex;
  }

  size(): number {
    return Math.max(0, this.writeIndex - this.readIndex);
  }

  push(price: number, size: number, sideFlag: number, tsMs: number): void {
    const slot = this.writeIndex % this.capacity;
    const offset = slot * this.stride;
    this.storage[offset] = price;
    this.storage[offset + 1] = size;
    this.storage[offset + 2] = sideFlag;
    this.storage[offset + 3] = tsMs;
    this.writeIndex += 1;
    if (this.writeIndex - this.readIndex > this.capacity) {
      this.readIndex = this.writeIndex - this.capacity;
    }
  }

  shiftInto(target: Float64Array): boolean {
    if (!this.hasData()) {
      return false;
    }
    const slot = this.readIndex % this.capacity;
    const offset = slot * this.stride;
    target[0] = this.storage[offset];
    target[1] = this.storage[offset + 1];
    target[2] = this.storage[offset + 2];
    target[3] = this.storage[offset + 3];
    this.readIndex += 1;
    return true;
  }
}

function tradeVenuePriority(venue: string): number {
  switch (venue) {
    case "binance-public":
      return 1;
    case "coinbase-public":
      return 2;
    case "okx-public":
      return 3;
    default:
      return 9;
  }
}

function enqueueTradePayloadIntoRing(payload: JsonMap, ring: TradeRingBuffer): number {
  const price = toNumber(payload.price ?? payload.p, 0);
  const size = toNumber(payload.size ?? payload.q ?? payload.qty, 0);
  const tsMs = tradeTimestampMs(payload);
  const sideFlag = payload.m === true || String(payload.side || "").toLowerCase() === "sell" ? 1 : 0;
  if (!(price > 0) || !(size > 0) || !(tsMs > 0)) {
    return 0;
  }
  ring.push(price, size, sideFlag, tsMs);
  return 1;
}

function barsToLiveCandles(bars: OhlcvBar[]): LiveChartCandle[] {
  return bars.map((bar) => ({
    label: typeof bar.t === "string" ? bar.t : new Date().toISOString(),
    open: toNumber(bar.o, 0),
    high: toNumber(bar.h, 0),
    low: toNumber(bar.l, 0),
    close: toNumber(bar.c, 0),
    volume: toNumber(bar.v, 0),
  }));
}

function resolveSideRefreshMs(): number {
  if (typeof window !== "undefined" && isGtixPublicHost(window.location.hostname)) {
    return PUBLIC_SIDE_REFRESH_MS;
  }
  return SIDE_REFRESH_MS;
}

function depthRowToTuple(row: unknown): [number, number] | null {
  if (!Array.isArray(row)) {
    return null;
  }
  const price = toNumber(row[0], 0);
  const size = toNumber(row[1], 0);
  if (price <= 0) {
    return null;
  }
  return [price, Math.max(0, size)];
}

function mapToDepthRows(sideMap: Map<string, number>, side: "bid" | "ask"): Array<[number, number]> {
  return [...sideMap.entries()]
    .map(([price, size]) => [toNumber(price, 0), size] as [number, number])
    .filter(([price, size]) => price > 0 && size > 0)
    .sort((left, right) => (side === "bid" ? right[0] - left[0] : left[0] - right[0]));
}

function mergeDepthDelta(currentDepth: JsonMap | null, deltaPayload: JsonMap): JsonMap {
  const currentPayload = ((currentDepth?.depth_payload as JsonMap | undefined) || {});
  const bidsMap = new Map<string, number>();
  const asksMap = new Map<string, number>();

  const seedSide = (rows: unknown, sideMap: Map<string, number>) => {
    if (!Array.isArray(rows)) {
      return;
    }
    for (const row of rows) {
      const parsed = depthRowToTuple(row);
      if (!parsed) {
        continue;
      }
      const [price, size] = parsed;
      sideMap.set(price.toFixed(8), size);
    }
  };

  seedSide(currentPayload.bids, bidsMap);
  seedSide(currentPayload.asks, asksMap);

  const applySide = (rows: unknown, sideMap: Map<string, number>) => {
    if (!Array.isArray(rows)) {
      return;
    }
    for (const row of rows) {
      const parsed = depthRowToTuple(row);
      if (!parsed) {
        continue;
      }
      const [price, size] = parsed;
      const key = price.toFixed(8);
      if (size <= 0) {
        sideMap.delete(key);
      } else {
        sideMap.set(key, size);
      }
    }
  };

  applySide(deltaPayload.bids, bidsMap);
  applySide(deltaPayload.asks, asksMap);

  const bids = mapToDepthRows(bidsMap, "bid");
  const asks = mapToDepthRows(asksMap, "ask");
  const bestBid = bids.length > 0 ? toNumber(bids[0][0], 0) : 0;
  const bestAsk = asks.length > 0 ? toNumber(asks[0][0], 0) : 0;
  const mid = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : 0;
  const spreadBps = mid > 0 ? ((bestAsk - bestBid) / mid) * 10_000 : 0;
  const eventTime = toNumber(deltaPayload.event_time, Date.now());

  return {
    ...(currentDepth || {}),
    venue: String(deltaPayload.venue || currentDepth?.venue || "binance-public"),
    instrument: String(deltaPayload.instrument || currentDepth?.instrument || "UNKNOWN"),
    snapshot_at: new Date(eventTime).toISOString(),
    best_bid: bestBid,
    best_ask: bestAsk,
    spread_bps: spreadBps,
    depth_payload: {
      bids,
      asks,
      lastUpdateId: toNumber(deltaPayload.update_id, toNumber((currentPayload as JsonMap).lastUpdateId, 0)),
      event_time: eventTime,
      reason: "ws-delta",
    },
    source: "depth-ws-delta",
  };
}

function mergeDepthRowsIntoMap(rows: unknown, sideMap: Map<string, number>): void {
  if (!Array.isArray(rows)) {
    return;
  }
  for (const row of rows) {
    const parsed = depthRowToTuple(row);
    if (!parsed) {
      continue;
    }
    const [price, size] = parsed;
    const key = price.toFixed(8);
    sideMap.set(key, (sideMap.get(key) || 0) + size);
  }
}

function buildDepthSnapshotFromMaps(
  venue: string,
  instrument: string,
  bidsMap: Map<string, number>,
  asksMap: Map<string, number>,
  eventTime: number,
  source: string,
  reason: string,
  venues: string[],
): JsonMap {
  const bids = mapToDepthRows(bidsMap, "bid");
  const asks = mapToDepthRows(asksMap, "ask");
  const bestBid = bids.length > 0 ? toNumber(bids[0][0], 0) : 0;
  const bestAsk = asks.length > 0 ? toNumber(asks[0][0], 0) : 0;
  const mid = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : 0;
  const spreadBps = mid > 0 ? ((bestAsk - bestBid) / mid) * 10_000 : 0;
  return {
    venue,
    instrument,
    snapshot_at: new Date(eventTime || Date.now()).toISOString(),
    best_bid: bestBid,
    best_ask: bestAsk,
    spread_bps: spreadBps,
    depth_payload: {
      bids,
      asks,
      lastUpdateId: eventTime,
      event_time: eventTime || Date.now(),
      reason,
      venues,
      venue_count: venues.length,
    },
    source,
  };
}

function aggregateDepthSnapshots(primaryVenue: string, instrument: string, snapshots: JsonMap[]): JsonMap | null {
  if (snapshots.length === 0) {
    return null;
  }
  if (snapshots.length === 1) {
    return snapshots[0];
  }
  const bidsMap = new Map<string, number>();
  const asksMap = new Map<string, number>();
  let latestEventTime = 0;
  const venues: string[] = [];

  for (const snapshot of snapshots) {
    const payload = snapshot.depth_payload as JsonMap | undefined;
    mergeDepthRowsIntoMap(payload?.bids, bidsMap);
    mergeDepthRowsIntoMap(payload?.asks, asksMap);
    latestEventTime = Math.max(latestEventTime, toNumber(payload?.event_time, Date.now()));
    venues.push(String(snapshot.venue || "unknown"));
  }

  return buildDepthSnapshotFromMaps(
    primaryVenue,
    instrument,
    bidsMap,
    asksMap,
    latestEventTime || Date.now(),
    "v6-multi-venue-depth",
    "fused-depth",
    venues,
  );
}

function hasUsableSnapshotData(payload: JsonMap): boolean {
  const health = payload.meta && typeof payload.meta === "object"
    ? (payload.meta as JsonMap).health
    : null;
  const status = health && typeof health === "object"
    ? String((health as JsonMap).status || "")
    : "";
  const hasOhlcvRows = Array.isArray(payload.ohlcv_rows) && payload.ohlcv_rows.length > 0;
  const hasDepthSnapshot = Boolean(payload.depth_snapshot && typeof payload.depth_snapshot === "object");
  const hasTrades = Array.isArray(payload.trades) && payload.trades.length > 0;
  const hasMicro = Boolean(payload.microstructure && typeof payload.microstructure === "object");

  if (status !== "degraded") {
    return hasOhlcvRows || hasDepthSnapshot || hasTrades || hasMicro;
  }

  return hasOhlcvRows || hasDepthSnapshot;
}

class MarketDataBus {
  private listeners = new Set<MarketDataBusListener>();
  private snapshot: MarketDataBusSnapshot = {
    configKey: "",
    ohlcvBars: [],
    nativeTrades: [],
    marketMicro: null,
    sessionState: null,
    orderbook: null,
    marketDepth: null,
    routingScore: null,
    busMeta: null,
    chartLoading: false,
    ohlcvStreamState: "offline",
    depthStreamState: "offline",
    kernelTelemetry: {
      tickLatencyMs: 0,
      bufferBacklog: 0,
      drainedTicksPerFrame: 0,
      skippedFrames: 0,
      schedulerBudgetMs: TRADE_PULL_BUDGET_MS,
      schedulerPullLimit: TRADE_PULL_LIMIT_PER_FRAME,
      cpuLoadHint: 1,
      fpsHint: 60,
      frameTimeHintMs: 16.7,
      backlogPressure: 0,
      framesProcessed: 0,
      benchmarkMode: false,
      benchmarkTicksPerSec: 0,
      benchmarkInjectedTicks: 0,
      receivedTicks: 0,
      candleUpdates: 0,
      syntheticHeartbeatOpens: 0,
      lastCandleUpdateAt: null,
      lastDrainAt: null,
    },
    lastSyncAt: null,
  };
  private config: MarketDataBusConfig | null = null;
  // ── MarketDataEngine V5 : pipeline unifié (candles + microstructure + gaps) ──
  private engine: MarketDataEngineV5 | null = null;
  private fusionEngine: PriceFusionEngineV6 | null = null;
  private pendingGaps: GapRange[] = [];
  private sideRefreshTimer: number | null = null;
  private sideFetchController: AbortController | null = null;
  private sideFetchConfigKey = "";
  private ohlcvSocket: WebSocket | null = null;
  private ohlcvReconnectTimer: number | null = null;
  private ohlcvPingTimer: number | null = null;
  private depthSocket: WebSocket | null = null;
  private depthReconnectTimer: number | null = null;
  private depthPingTimer: number | null = null;
  private auxDepthSockets = new Map<string, WebSocket>();
  private auxDepthReconnectTimers = new Map<string, number>();
  private auxDepthPingTimers = new Map<string, number>();
  private auxTradeSockets = new Map<string, WebSocket>();
  private auxTradeReconnectTimers = new Map<string, number>();
  private auxTradePingTimers = new Map<string, number>();
  private tradeRingsByVenue = new Map<string, TradeRingBuffer>();
  private tradeDrainRaf: number | null = null;
  private tradeDrainScratch = new Float64Array(4);
  private schedulerHint: Required<MarketDataBusSchedulerHint> = { fps: 60, frameTimeMs: 16.7, cpuLoad: 1 };
  private benchmarkTimer: number | null = null;
  private benchmarkTick = 0;
  private syntheticHeartbeatTimer: number | null = null;
  private depthSnapshotsByVenue = new Map<string, JsonMap>();
  private snapshotFailureCooldownUntil = 0;
  private streamFailureCount: Record<StreamKind, number> = { ohlcv: 0, depth: 0 };
  private streamCooldownUntil: Record<StreamKind, number> = { ohlcv: 0, depth: 0 };
  private seenTradeKeys = new Set<string>();
  private seenTradeQueue: string[] = [];
  private lastLiveReactCommitAt = 0;
  private lastLiveReactBarTime = "";

  subscribe(listener: MarketDataBusListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => {
      this.listeners.delete(listener);
    };
  }

  connect(config: MarketDataBusConfig): void {
    const nextKey = `${config.instrument}|${config.venue}|${config.timeframe}`;
    if (this.snapshot.configKey === nextKey) {
      return;
    }

    const previousConfig = this.config;
    const sameInstrumentAndVenue = Boolean(
      previousConfig
      && previousConfig.instrument === config.instrument
      && previousConfig.venue === config.venue
      && this.engine,
    );

    if (sameInstrumentAndVenue && this.engine) {
      const previousKey = this.snapshot.configKey;
      clearChartFrame(previousKey);
      this.config = config;
      this.engine.setActiveTimeframe(config.timeframe);
      this.configureSyntheticHeartbeat();
      const nextBars = this.engine.getSeries(config.timeframe);
      this.snapshot = {
        ...this.snapshot,
        configKey: nextKey,
        ohlcvBars: nextBars,
        chartLoading: nextBars.length === 0,
        kernelTelemetry: {
          ...this.snapshot.kernelTelemetry,
          lastCandleUpdateAt: nextBars.length > 0 ? new Date().toISOString() : this.snapshot.kernelTelemetry.lastCandleUpdateAt,
        },
      };
      this.publishEngineFrame(nextBars, nextKey);
      this.emit();
      void this.refreshNow("ai");
      return;
    }

    const previousKey = this.snapshot.configKey;
    this.disconnectSockets();
    clearChartFrame(previousKey);
    this.depthSnapshotsByVenue.clear();
    this.tradeRingsByVenue.clear();
    this.seenTradeKeys.clear();
    this.seenTradeQueue = [];
    this.lastLiveReactCommitAt = 0;
    this.lastLiveReactBarTime = "";
    this.config = config;
    // Engine V5 : pipeline unifié (candles depuis trades + microstructure)
    this.engine = new MarketDataEngineV5(config.timeframe, config.instrument, config.venue);
    this.fusionEngine = new PriceFusionEngineV6();
    // Backfill callback : V5 nous notifie quand des gaps sont détectés
    this.engine.onGapDetected((startMs, endMs) => {
      this.pendingGaps.push({ startMs, endMs, missingSlots: 0 });
    });
    // Engine V4 : nouveau singleton par config (repart de zéro sur chaque changement)
    // (engine V4 est intégré dans V5, plus besoin de variable séparée)
    this.snapshot = {
      ...this.snapshot,
      configKey: nextKey,
      ohlcvBars: [],
      nativeTrades: [],
      marketMicro: null,
      sessionState: null,
      orderbook: null,
      marketDepth: null,
      routingScore: null,
      busMeta: null,
      chartLoading: true,
      ohlcvStreamState: "connecting",
      depthStreamState: "connecting",
      kernelTelemetry: {
        ...this.snapshot.kernelTelemetry,
        bufferBacklog: 0,
        drainedTicksPerFrame: 0,
        skippedFrames: 0,
        backlogPressure: 0,
        framesProcessed: 0,
        benchmarkInjectedTicks: 0,
        receivedTicks: 0,
        candleUpdates: 0,
        syntheticHeartbeatOpens: 0,
        lastCandleUpdateAt: null,
      },
      lastSyncAt: null,
    };
    this.emit();
    this.configureSyntheticHeartbeat();
    this.connectOhlcvSocket();
    this.connectDepthSocket();
    void this.refreshNow("ai");
  }

  disconnect(): void {
    const previousKey = this.snapshot.configKey;
    this.disconnectSockets();
    this.config = null;
    this.engine = null;
    this.fusionEngine = null;
    this.pendingGaps = [];
    this.stopSyntheticHeartbeat();
    this.snapshot = {
      ...this.snapshot,
      configKey: "",
      ohlcvBars: [],
      nativeTrades: [],
      marketMicro: null,
      sessionState: null,
      orderbook: null,
      marketDepth: null,
      routingScore: null,
      busMeta: null,
      chartLoading: false,
      ohlcvStreamState: "offline",
      depthStreamState: "offline",
      kernelTelemetry: {
        ...this.snapshot.kernelTelemetry,
        bufferBacklog: 0,
        drainedTicksPerFrame: 0,
        backlogPressure: 0,
        benchmarkInjectedTicks: 0,
        receivedTicks: 0,
        candleUpdates: 0,
        syntheticHeartbeatOpens: 0,
        lastCandleUpdateAt: null,
        lastDrainAt: null,
      },
      lastSyncAt: null,
    };
    clearChartFrame(previousKey);
    this.depthSnapshotsByVenue.clear();
    this.tradeRingsByVenue.clear();
    this.seenTradeKeys.clear();
    this.seenTradeQueue = [];
    this.lastLiveReactCommitAt = 0;
    this.lastLiveReactBarTime = "";
    this.emit();
  }

  private resolveObservableMarketPrice(): number {
    const microBid = toNumber(this.snapshot.marketMicro?.best_bid, 0);
    const microAsk = toNumber(this.snapshot.marketMicro?.best_ask, 0);
    if (microBid > 0 && microAsk > 0) {
      return (microBid + microAsk) * 0.5;
    }

    const depthBid = toNumber(this.snapshot.marketDepth?.best_bid, 0);
    const depthAsk = toNumber(this.snapshot.marketDepth?.best_ask, 0);
    if (depthBid > 0 && depthAsk > 0) {
      return (depthBid + depthAsk) * 0.5;
    }

    return microBid
      || microAsk
      || depthBid
      || depthAsk
      || toNumber(this.snapshot.ohlcvBars[this.snapshot.ohlcvBars.length - 1]?.c, 0);
  }

  private resolveSyntheticHeartbeatPrice(): number {
    const lastClose = toNumber(this.snapshot.ohlcvBars[this.snapshot.ohlcvBars.length - 1]?.c, 0);
    return lastClose > 0 ? lastClose : this.resolveObservableMarketPrice();
  }

  private stopSyntheticHeartbeat(): void {
    if (this.syntheticHeartbeatTimer !== null) {
      window.clearInterval(this.syntheticHeartbeatTimer);
      this.syntheticHeartbeatTimer = null;
    }
  }

  private configureSyntheticHeartbeat(): void {
    this.stopSyntheticHeartbeat();
    const config = this.config;
    if (!config) {
      return;
    }
    if (timeframeToMs(config.timeframe) > MICRO_TF_HEARTBEAT_MAX_MS) {
      return;
    }

    this.syntheticHeartbeatTimer = window.setInterval(() => {
      const heartbeatPrice = this.resolveSyntheticHeartbeatPrice();
      if (!(heartbeatPrice > 0)) {
        return;
      }
      this.ingestPriceTick(heartbeatPrice, Date.now(), "synthetic-heartbeat");
    }, SYNTHETIC_HEARTBEAT_MS);
  }

  async refreshNow(requestType: MarketBusRequestType = "ai"): Promise<void> {
    const config = this.config;
    if (!config) {
      return;
    }

    const sideFetchConfigKey = `${config.instrument}|${config.venue}|${config.timeframe}`;
    if (this.sideFetchController && this.sideFetchConfigKey === sideFetchConfigKey) {
      return;
    }

    if (Date.now() < this.snapshotFailureCooldownUntil) {
      this.scheduleSideRefresh(Math.max(5_000, this.snapshotFailureCooldownUntil - Date.now()));
      return;
    }

    if (this.sideFetchController) {
      this.sideFetchController.abort();
    }
    const controller = new AbortController();
    this.sideFetchController = controller;
    this.sideFetchConfigKey = sideFetchConfigKey;

    const releaseSideFetch = () => {
      if (this.sideFetchController === controller) {
        this.sideFetchController = null;
        this.sideFetchConfigKey = "";
      }
    };

    const { instrument, venue } = config;
    const headers = buildRequestHeaders(requestType, instrument);
    const [snapshotResponse, quotesPayload] = await Promise.all([
      fetch(`/api/market/bus/snapshot?instrument=${encodeURIComponent(instrument)}&venue=${encodeURIComponent(venue)}&timeframe=${encodeURIComponent(config.timeframe)}&lookback_minutes=60&trade_limit=200`, {
      cache: "no-store",
      signal: controller.signal,
      headers,
    }).then(async (response) => ({
      ok: response.ok,
      status: response.status,
      payload: response.ok ? await response.json() : null,
    })).catch(() => ({ ok: false, status: 0, payload: null as unknown })),
      fetch("/api/market/quotes", {
        cache: "no-store",
        signal: controller.signal,
        headers,
      }).then((response) => (response.ok ? response.json() : [])).catch(() => []),
    ]);

    if (controller.signal.aborted || this.config?.instrument !== instrument || this.config?.timeframe !== config.timeframe || this.config?.venue !== venue) {
      releaseSideFetch();
      return;
    }

    let payload = snapshotResponse.payload;
    const snapshotPayload = payload && typeof payload === "object" ? payload as JsonMap : {};
    const snapshotHasBars = Array.isArray(snapshotPayload.ohlcv_rows) && snapshotPayload.ohlcv_rows.length > 0;
    const snapshotHasDepth = Boolean(
      (snapshotPayload.depth_snapshot && typeof snapshotPayload.depth_snapshot === "object")
      || (snapshotPayload.orderbook && typeof snapshotPayload.orderbook === "object"),
    );
    const needsBarsFallback = !snapshotHasBars;
    const needsDepthFallback = !snapshotHasDepth;
    const shouldFetchSideFallbacks = !snapshotResponse.ok || !hasUsableSnapshotData(snapshotPayload) || needsBarsFallback || needsDepthFallback;

    if (shouldFetchSideFallbacks) {
      const [ohlcvPayload, depthPayload] = await Promise.all([
        needsBarsFallback
          ? fetch(`/api/market/ohlcv?instrument=${encodeURIComponent(instrument)}&venue=${encodeURIComponent(venue)}&timeframe=${encodeURIComponent(config.timeframe)}&limit=500`, {
            cache: "no-store",
            signal: controller.signal,
            headers,
          }).then((response) => (response.ok ? response.json() : null)).catch(() => null)
          : Promise.resolve(null),
        needsDepthFallback
          ? fetch(`/api/market/orderbook/depth?instrument=${encodeURIComponent(instrument)}&venue=${encodeURIComponent(venue)}`, {
            cache: "no-store",
            signal: controller.signal,
            headers,
          }).then((response) => (response.ok ? response.json() : null)).catch(() => null)
          : Promise.resolve(null),
      ]);

      const existingHealth = (snapshotPayload.meta && typeof snapshotPayload.meta === "object"
        ? (snapshotPayload.meta as JsonMap).health
        : null) as JsonMap | null;

      payload = {
        ...snapshotPayload,
        orderbook: snapshotPayload.orderbook || (depthPayload && typeof depthPayload === "object" ? depthPayload : null),
        meta: {
          ...((snapshotPayload.meta && typeof snapshotPayload.meta === "object") ? snapshotPayload.meta : {}),
          health: {
            ...((existingHealth && typeof existingHealth === "object") ? existingHealth : {}),
            status: snapshotResponse.ok ? String((((snapshotPayload.meta as JsonMap | undefined)?.health as JsonMap | undefined)?.status) || "degraded") : "degraded",
            reason: snapshotResponse.ok
              ? String((((snapshotPayload.meta as JsonMap | undefined)?.health as JsonMap | undefined)?.reason) || "snapshot_partial_payload")
              : (snapshotResponse.status === 404 ? "snapshot_route_unavailable" : "snapshot_unavailable"),
          },
        },
        as_of: typeof snapshotPayload.as_of === "string" ? snapshotPayload.as_of : new Date().toISOString(),
        ohlcv_rows: Array.isArray(snapshotPayload.ohlcv_rows) && snapshotPayload.ohlcv_rows.length > 0
          ? snapshotPayload.ohlcv_rows
          : (Array.isArray(ohlcvPayload) ? ohlcvPayload : []),
        depth_snapshot: snapshotPayload.depth_snapshot && typeof snapshotPayload.depth_snapshot === "object"
          ? snapshotPayload.depth_snapshot
          : (depthPayload && typeof depthPayload === "object" ? depthPayload : null),
      };

      this.snapshotFailureCooldownUntil = snapshotResponse.ok ? 0 : Date.now() + SNAPSHOT_RETRY_COOLDOWN_MS;
    } else {
      this.snapshotFailureCooldownUntil = 0;
    }

    const busPayload = payload && typeof payload === "object" ? payload as JsonMap : {};
    this.syncFusionQuotes(Array.isArray(quotesPayload) ? quotesPayload as JsonMap[] : []);
    const fallbackBars = normalizeOhlcvRows(Array.isArray(busPayload.ohlcv_rows) ? busPayload.ohlcv_rows : [], { timeframe: config.timeframe });
    const rawTrades = Array.isArray(busPayload.trades) ? busPayload.trades as JsonMap[] : [];
    // Engine V5 : bootstrap complet (OHLCV + trades REST → prebuild avant render)
    if (this.engine) {
      const v5Trades = rawTrades.map((t) => ({
        price: Number(t.p ?? t.price ?? 0),
        size: Number(t.q ?? t.size ?? t.qty ?? 0),
        side: String(t.side || "") || (t.m === true ? "sell" : "buy"),
        tsMs: Number(t.T ?? t.ts ?? t.tsMs ?? Date.now()),
        exchangeTs: Number(t.T ?? t.ts ?? 0) || undefined,
      }));
      this.engine.bootstrap({ ohlcvBars: fallbackBars, trades: v5Trades });
      // Sync latency offset depuis V4
      this.engine.syncLatencyFromV4();
    }
    const canonicalBars = this.engine ? this.engine.getSeries(config.timeframe) : fallbackBars;
    this.publishEngineFrame(canonicalBars, sideFetchConfigKey);
    const fallbackDepth = busPayload.depth_snapshot && typeof busPayload.depth_snapshot === "object"
      ? busPayload.depth_snapshot as JsonMap
      : null;
    const effectiveDepth = fallbackDepth
      ? (this.setVenueDepthSnapshot(config.venue, fallbackDepth) || fallbackDepth)
      : this.snapshot.marketDepth;
    const hasFallbackBars = fallbackBars.length > 0;
    const hasFallbackDepth = fallbackDepth !== null || ((busPayload.orderbook as JsonMap | null | undefined) || null) !== null;

    this.snapshot = {
      ...this.snapshot,
      ohlcvBars: canonicalBars.length > 0 ? canonicalBars : this.snapshot.ohlcvBars,
      nativeTrades: rawTrades,
      marketMicro: this._enrichMicroV5(
        (busPayload.microstructure as JsonMap | null | undefined) || null,
      ),
      sessionState: (busPayload.session_state as JsonMap | null | undefined) || null,
      orderbook: (busPayload.orderbook as JsonMap | null | undefined) || null,
      marketDepth: effectiveDepth,
      routingScore: this._buildRoutingScore((busPayload.routing_score as JsonMap | null | undefined) || null),
      busMeta: (busPayload.meta as JsonMap | null | undefined) || null,
      chartLoading: canonicalBars.length > 0 ? false : this.snapshot.chartLoading,
      ohlcvStreamState: canonicalBars.length > 0 || rawTrades.length > 0 ? "live" : this.snapshot.ohlcvStreamState,
      depthStreamState: this.snapshot.depthStreamState === "live" || hasFallbackDepth ? "live" : this.snapshot.depthStreamState,
      lastSyncAt: typeof busPayload.as_of === "string" ? busPayload.as_of : new Date().toISOString(),
    };
    releaseSideFetch();
    this.emit();
    this.scheduleSideRefresh();
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener(this.snapshot);
    }
  }

  setSchedulerHint(hint: MarketDataBusSchedulerHint): void {
    this.schedulerHint = {
      fps: toNumber(hint.fps, this.schedulerHint.fps),
      frameTimeMs: toNumber(hint.frameTimeMs, this.schedulerHint.frameTimeMs),
      cpuLoad: toNumber(hint.cpuLoad, this.schedulerHint.cpuLoad),
    };
    this.snapshot = {
      ...this.snapshot,
      kernelTelemetry: {
        ...this.snapshot.kernelTelemetry,
        fpsHint: this.schedulerHint.fps,
        frameTimeHintMs: this.schedulerHint.frameTimeMs,
        cpuLoadHint: this.schedulerHint.cpuLoad,
      },
    };
    this.emit();
  }

  setBenchmarkMode(enabled: boolean, ticksPerSec = 0): void {
    if (!enabled || ticksPerSec <= 0) {
      if (this.benchmarkTimer !== null) {
        window.clearInterval(this.benchmarkTimer);
        this.benchmarkTimer = null;
      }
      this.snapshot = {
        ...this.snapshot,
        kernelTelemetry: {
          ...this.snapshot.kernelTelemetry,
          benchmarkMode: false,
          benchmarkTicksPerSec: 0,
        },
      };
      this.emit();
      return;
    }

    if (this.benchmarkTimer !== null) {
      window.clearInterval(this.benchmarkTimer);
      this.benchmarkTimer = null;
    }

    this.snapshot = {
      ...this.snapshot,
      kernelTelemetry: {
        ...this.snapshot.kernelTelemetry,
        benchmarkMode: true,
        benchmarkTicksPerSec: Math.max(120, Math.round(ticksPerSec)),
      },
    };
    this.emit();

    const cadenceMs = 50;
    this.benchmarkTimer = window.setInterval(() => {
      if (!this.config) {
        return;
      }
      const venue = this.config.venue;
      const ring = this.ensureTradeRing(venue);
      const ticksThisSlice = Math.max(1, Math.round((this.snapshot.kernelTelemetry.benchmarkTicksPerSec * cadenceMs) / 1000));
      const anchorPrice = this.resolveObservableMarketPrice()
        || toNumber(this.snapshot.ohlcvBars[this.snapshot.ohlcvBars.length - 1]?.c, 0)
        || 100;
      const now = Date.now();
      for (let index = 0; index < ticksThisSlice; index += 1) {
        this.benchmarkTick += 1;
        const wave = Math.sin((this.benchmarkTick + index) / 9) * 0.18;
        const microJitter = ((this.benchmarkTick + index) % 7 - 3) * 0.006;
        const price = Math.max(0.0001, anchorPrice + wave + microJitter);
        const size = 0.03 + (((this.benchmarkTick + index) % 11) + 1) * 0.008;
        const sideFlag = (this.benchmarkTick + index) % 2;
        ring.push(price, size, sideFlag, now - ((ticksThisSlice - index) % 5));
      }
      this.snapshot = {
        ...this.snapshot,
        kernelTelemetry: {
          ...this.snapshot.kernelTelemetry,
          benchmarkInjectedTicks: this.snapshot.kernelTelemetry.benchmarkInjectedTicks + ticksThisSlice,
          receivedTicks: this.snapshot.kernelTelemetry.receivedTicks + ticksThisSlice,
          bufferBacklog: this.computeTradeBacklog(),
        },
      };
      this.scheduleTradeDrain();
    }, cadenceMs);
  }

  /**
   * Injection d'un tick prix live (depuis quotes WS).
   * L'engine met à jour la bougie active et émet seulement si changed.
   */
  ingestPriceTick(price: number, tsMs?: number, source: "live" | "synthetic-heartbeat" = "live"): void {
    if (!this.engine || !this.config) return;
    const ts = tsMs ?? Date.now();
    const previousBarTime = this.engine.getCurrentBar(this.config.timeframe)?.t || null;
    const changed = this.engine.ingestTick(price, ts, this.config.venue);
    this.fusionEngine?.updateTick({ venue: this.config.venue, price, size: 1, tsMs: ts });
    const nextBars = changed ? this.engine.getSeries(this.config.timeframe) : null;
    const nextBarTime = nextBars && nextBars.length > 0 ? nextBars[nextBars.length - 1]?.t || null : previousBarTime;
    const syntheticHeartbeatOpenedBar = source === "synthetic-heartbeat" && changed && previousBarTime !== null && nextBarTime !== previousBarTime;
    const lastCandleUpdateAt = changed ? new Date().toISOString() : this.snapshot.kernelTelemetry.lastCandleUpdateAt;
    this.snapshot = {
      ...this.snapshot,
      marketMicro: this._enrichMicroV5(this.snapshot.marketMicro),
      routingScore: this._buildRoutingScore(this.snapshot.routingScore),
      kernelTelemetry: {
        ...this.snapshot.kernelTelemetry,
        receivedTicks: this.snapshot.kernelTelemetry.receivedTicks + 1,
        candleUpdates: this.snapshot.kernelTelemetry.candleUpdates + (changed ? 1 : 0),
        syntheticHeartbeatOpens: this.snapshot.kernelTelemetry.syntheticHeartbeatOpens + (syntheticHeartbeatOpenedBar ? 1 : 0),
        lastCandleUpdateAt,
      },
      lastSyncAt: changed ? new Date().toISOString() : this.snapshot.lastSyncAt,
    };
    if (changed) {
      this.snapshot = {
        ...this.snapshot,
        ohlcvBars: nextBars || [],
      };
      this.publishEngineFrame(nextBars || []);
    }
    this.emit();
  }

  private publishEngineFrame(sourceBars?: OhlcvBar[], feedKey?: string): OhlcvBar[] {
    const bars = sourceBars || (this.engine ? this.engine.getSeries() : this.snapshot.ohlcvBars);
    const activeFeedKey = feedKey || this.snapshot.configKey;
    if (!bars.length || !activeFeedKey) {
      return bars;
    }
    if (this.engine) {
      this.engine.prepareFrame(bars, this.config?.timeframe);
      const swapped = this.engine.swapFrame(this.config?.timeframe);
      if (swapped.length > 0) {
        publishChartFrame(activeFeedKey, barsToLiveCandles(swapped));
        return swapped;
      }
    }
    publishChartFrame(activeFeedKey, barsToLiveCandles(bars));
    return bars;
  }

  private rememberTrade(trade: JsonMap): boolean {
    const signature = tradeSignature(trade);
    if (this.seenTradeKeys.has(signature)) {
      return false;
    }
    this.seenTradeKeys.add(signature);
    this.seenTradeQueue.push(signature);
    while (this.seenTradeQueue.length > 4_000) {
      const oldest = this.seenTradeQueue.shift();
      if (oldest) {
        this.seenTradeKeys.delete(oldest);
      }
    }
    return true;
  }

  private commitLiveBarsToReact(bars: OhlcvBar[]): void {
    const lastBar = bars[bars.length - 1];
    const lastBarTime = String(lastBar?.t || "");
    const now = Date.now();
    const isNewBar = Boolean(lastBarTime) && lastBarTime !== this.lastLiveReactBarTime;
    const shouldCommit = this.snapshot.ohlcvBars.length === 0
      || isNewBar
      || (now - this.lastLiveReactCommitAt) >= LIVE_REACT_FORCE_COMMIT_MS
      || (now - this.lastLiveReactCommitAt) >= LIVE_REACT_BAR_COMMIT_MS;

    this.snapshot = {
      ...this.snapshot,
      chartLoading: false,
      ohlcvStreamState: "live",
      lastSyncAt: new Date(now).toISOString(),
      marketMicro: this._enrichMicroV5(this.snapshot.marketMicro),
    };

    if (!shouldCommit) {
      return;
    }

    this.snapshot = {
      ...this.snapshot,
      ohlcvBars: bars,
    };
    this.lastLiveReactCommitAt = now;
    this.lastLiveReactBarTime = lastBarTime;
    this.emit();
  }

  private ingestTradeRows(rows: JsonMap[]): void {
    if (!this.engine || rows.length === 0) {
      return;
    }

    const acceptedTrades: JsonMap[] = [];
    for (const row of rows) {
      if (!this.rememberTrade(row)) {
        continue;
      }
      const price = toNumber(row.price ?? row.p, 0);
      const size = toNumber(row.size ?? row.q ?? row.qty, 0);
      const tsMs = tradeTimestampMs(row);
      const venue = String(row.venue || this.config?.venue || "unknown");
      if (!(price > 0) || !(size > 0) || !(tsMs > 0)) {
        continue;
      }
      this.engine.ingestTick(price, tsMs, venue);
      const fusionSnapshot = this.fusionEngine?.updateTick({ venue, price, size, tsMs }) || null;
      this.engine.ingestTrade({
        price,
        size,
        side: String(row.side || (row.m === true ? "sell" : "buy")),
        tsMs,
        exchangeTs: tsMs,
      });
      const fusionMetaPrice = toNumber(fusionSnapshot?.fusionPrice, 0);
      acceptedTrades.push({
        ...row,
        ...(fusionMetaPrice > 0 ? { fusion_meta_price: fusionMetaPrice } : {}),
        raw_price: price,
        raw_price_source: venue,
        venue,
      });
    }

    if (acceptedTrades.length === 0) {
      return;
    }

    this.engine.syncLatencyFromV4();
    const mergedBars = this.publishEngineFrame();
    this.snapshot = {
      ...this.snapshot,
      nativeTrades: [...acceptedTrades.reverse(), ...this.snapshot.nativeTrades].slice(0, LIVE_NATIVE_TRADES_LIMIT),
      marketMicro: this._enrichMicroV5(this.snapshot.marketMicro),
      routingScore: this._buildRoutingScore(this.snapshot.routingScore),
    };
    this.commitLiveBarsToReact(mergedBars);
  }

  private activeFusionVenues(): string[] {
    const config = this.config;
    if (!config) {
      return [];
    }
    if (!FUSION_PUBLIC_VENUES.includes(config.venue as typeof FUSION_PUBLIC_VENUES[number])) {
      return [config.venue];
    }
    const candidates = [config.venue, ...FUSION_PUBLIC_VENUES.filter((venue) => venue !== config.venue)];
    return [...new Set(candidates)];
  }

  private syncFusionQuotes(quotes: JsonMap[]): void {
    const config = this.config;
    if (!config || !this.fusionEngine) {
      return;
    }
    const candidates = new Set(fusionInstrumentCandidates(config.instrument));
    const now = Date.now();
    for (const item of quotes) {
      const instrument = String(item.instrument || "").toUpperCase();
      if (!candidates.has(instrument)) {
        continue;
      }
      const venue = String(item.venue || "");
      if (!this.activeFusionVenues().includes(venue)) {
        continue;
      }
      const updatedAt = typeof item.updated_at === "string" ? Date.parse(item.updated_at) : NaN;
      this.fusionEngine.updateQuote({
        venue,
        bid: toNumber(item.bid, 0),
        ask: toNumber(item.ask, 0),
        last: toNumber(item.last, 0),
        tsMs: Number.isFinite(updatedAt) ? updatedAt : now,
      });
    }
  }

  // ── V5 Helpers ────────────────────────────────────────────────────────────

  private static _toDepthRows(arr: unknown): DepthRow[] {
    if (!Array.isArray(arr)) return [];
    return (arr as unknown[]).map((r) => {
      if (Array.isArray(r) && r.length >= 2) return [Number(r[0]), Number(r[1])] as DepthRow;
      return null;
    }).filter(Boolean) as DepthRow[];
  }

  /**
   * Injecte un snapshot de profondeur dans le moteur V5.
   */
  private _feedDepthToV5(depthPayload: JsonMap): void {
    if (!this.engine) return;
    const dp = depthPayload.depth_payload as JsonMap | undefined;
    const bids = MarketDataBus._toDepthRows((dp?.bids ?? depthPayload.bids));
    const asks = MarketDataBus._toDepthRows((dp?.asks ?? depthPayload.asks));
    this.engine.ingestDepthSnapshot(bids, asks);
  }

  /**
   * Applique un delta de profondeur dans le moteur V5.
   */
  private _feedDepthDeltaToV5(deltaPayload: JsonMap): void {
    if (!this.engine) return;
    this.engine.ingestDepth({
      bids: MarketDataBus._toDepthRows(deltaPayload.bids),
      asks: MarketDataBus._toDepthRows(deltaPayload.asks),
    });
  }

  /**
   * Enrichit marketMicro avec les données calculées par V5 (microstructure + flow score).
   * Les champs backend restent prioritaires ; V5 ajoute/complète.
   */
  private _enrichMicroV5(baseMicro: JsonMap | null): JsonMap | null {
    if (!this.engine) return baseMicro;

    const snap = this.engine.getMicrostructure();
    const flow = this.engine.getFlowScore();
    const rawBestBid = toNumber(snap.bestBid, toNumber(baseMicro?.best_bid, toNumber(this.snapshot.marketDepth?.best_bid, 0)));
    const rawBestAsk = toNumber(snap.bestAsk, toNumber(baseMicro?.best_ask, toNumber(this.snapshot.marketDepth?.best_ask, 0)));
    const rawLastClose = toNumber(this.snapshot.ohlcvBars[this.snapshot.ohlcvBars.length - 1]?.c, 0);
    const rawChartAnchorPrice = this.resolveObservableMarketPrice();

    const v5Extra: JsonMap = {
      depth_imbalance: snap.depthImbalance,
      bid_volume: snap.bidVolume,
      ask_volume: snap.askVolume,
      spread_bps: snap.spreadBps,
      best_bid: snap.bestBid,
      best_ask: snap.bestAsk,
      cvd: snap.cvd,
      cvd_delta: snap.cvdDelta,
      cvd_trend: snap.cvdTrend,
      buy_volume_30s: snap.buyVolume30s,
      sell_volume_30s: snap.sellVolume30s,
      flow_imbalance: snap.flowImbalance,
      trade_aggressiveness: snap.tradeAggressiveness,
      best_venue: snap.bestVenue,
      vwap_price: snap.vwapPrice,
      price_deviation_bps: snap.priceDeviation,
      avg_latency_ms: snap.avgLatencyMs,
      max_latency_ms: snap.maxLatencyMs,
      latency_tier: snap.latencyTier,
      active_events: snap.activeEvents as unknown as JsonMap[],
      last_event_ts: snap.lastEventTs,
      // V5 flow score (unifié)
      flow_score: flow.score,
      flow_direction: flow.direction,
      v5_stable: this.engine.isStable(),
      v5_gap_count: this.engine.getGaps().length,
      v5_latency_offset_ms: this.engine.getLatencyOffset(),
      raw_best_bid: rawBestBid,
      raw_best_ask: rawBestAsk,
      raw_last_close: rawLastClose,
      raw_chart_anchor_price: rawChartAnchorPrice,
      raw_chart_anchor_source: rawBestBid > 0 && rawBestAsk > 0
        ? "observable-mid"
        : rawLastClose > 0
          ? "last-close"
          : "unknown",
    };

    const fusion = this.fusionEngine?.getSnapshot() || null;
    if (fusion) {
      v5Extra.fusion_price = fusion.fusionPrice;
      v5Extra.display_price = fusion.displayPrice;
      v5Extra.predicted_price = fusion.predictedPrice;
      v5Extra.fusion_best_bid = fusion.bestBid;
      v5Extra.fusion_best_ask = fusion.bestAsk;
      v5Extra.fusion_deviation_bps = fusion.deviationBps;
      v5Extra.fusion_venue_count = fusion.venueCount;
      v5Extra.fusion_venue_prices = fusion.venues as unknown as JsonMap;
      v5Extra.arbitrage_opportunity = fusion.arbitrage.opportunity;
      v5Extra.arbitrage_spread = fusion.arbitrage.spread;
      v5Extra.arbitrage_net_spread = fusion.arbitrage.netSpread;
      v5Extra.arbitrage_buy_venue = fusion.arbitrage.buy;
      v5Extra.arbitrage_sell_venue = fusion.arbitrage.sell;
    }

    if (baseMicro) {
      const merged: JsonMap = { ...v5Extra };
      for (const [k, v] of Object.entries(baseMicro)) {
        if (v !== null && v !== undefined) merged[k] = v;
      }
      return merged;
    }
    return v5Extra;
  }

  private scheduleSideRefresh(delayMs = resolveSideRefreshMs()): void {
    if (this.sideRefreshTimer !== null) {
      window.clearTimeout(this.sideRefreshTimer);
    }
    this.sideRefreshTimer = window.setTimeout(() => {
      void this.refreshNow("ai");
    }, delayMs);
  }

  private isStreamCoolingDown(kind: StreamKind): boolean {
    return Date.now() < this.streamCooldownUntil[kind];
  }

  private resetStreamFailures(kind: StreamKind): void {
    this.streamFailureCount[kind] = 0;
    this.streamCooldownUntil[kind] = 0;
  }

  private registerStreamFailure(kind: StreamKind): void {
    this.streamFailureCount[kind] += 1;
    if (this.streamFailureCount[kind] >= STREAM_FAILURE_THRESHOLD) {
      this.streamCooldownUntil[kind] = Date.now() + STREAM_FAILURE_COOLDOWN_MS;
    }
  }

  private disconnectSockets(): void {
    if (this.sideRefreshTimer !== null) {
      window.clearTimeout(this.sideRefreshTimer);
      this.sideRefreshTimer = null;
    }
    if (this.sideFetchController) {
      this.sideFetchController.abort();
      this.sideFetchController = null;
    }
    this.sideFetchConfigKey = "";
    if (this.ohlcvReconnectTimer !== null) {
      window.clearTimeout(this.ohlcvReconnectTimer);
      this.ohlcvReconnectTimer = null;
    }
    if (this.ohlcvPingTimer !== null) {
      window.clearInterval(this.ohlcvPingTimer);
      this.ohlcvPingTimer = null;
    }
    this.safeCloseSocket(this.ohlcvSocket);
    this.ohlcvSocket = null;
    if (this.depthReconnectTimer !== null) {
      window.clearTimeout(this.depthReconnectTimer);
      this.depthReconnectTimer = null;
    }
    if (this.depthPingTimer !== null) {
      window.clearInterval(this.depthPingTimer);
      this.depthPingTimer = null;
    }
    this.safeCloseSocket(this.depthSocket);
    this.depthSocket = null;
    for (const timer of this.auxDepthReconnectTimers.values()) {
      window.clearTimeout(timer);
    }
    this.auxDepthReconnectTimers.clear();
    for (const timer of this.auxDepthPingTimers.values()) {
      window.clearInterval(timer);
    }
    this.auxDepthPingTimers.clear();
    for (const socket of this.auxDepthSockets.values()) {
      this.safeCloseSocket(socket);
    }
    this.auxDepthSockets.clear();
    this.depthSnapshotsByVenue.clear();
    for (const timer of this.auxTradeReconnectTimers.values()) {
      window.clearTimeout(timer);
    }
    this.auxTradeReconnectTimers.clear();
    for (const timer of this.auxTradePingTimers.values()) {
      window.clearInterval(timer);
    }
    this.auxTradePingTimers.clear();
    for (const socket of this.auxTradeSockets.values()) {
      this.safeCloseSocket(socket);
    }
    this.auxTradeSockets.clear();
    for (const ring of this.tradeRingsByVenue.values()) {
      ring.clear();
    }
    this.tradeRingsByVenue.clear();
    if (this.tradeDrainRaf !== null) {
      window.cancelAnimationFrame(this.tradeDrainRaf);
      this.tradeDrainRaf = null;
    }
    if (this.benchmarkTimer !== null) {
      window.clearInterval(this.benchmarkTimer);
      this.benchmarkTimer = null;
    }
  }

  private safeCloseSocket(socket: WebSocket | null): void {
    if (!socket) {
      return;
    }
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    if (socket.readyState === WebSocket.OPEN) {
      socket.close(1000, "reconfiguring");
    }
  }

  private connectAuxTradeSockets(): void {
    const config = this.config;
    if (!config) {
      return;
    }
    const venues = this.activeFusionVenues().filter((venue) => venue !== config.venue);
    const keep = new Set(venues);
    for (const [venue, socket] of this.auxTradeSockets.entries()) {
      if (!keep.has(venue)) {
        this.safeCloseSocket(socket);
        this.auxTradeSockets.delete(venue);
      }
    }
    for (const venue of venues) {
      if (this.auxTradeSockets.has(venue)) {
        continue;
      }
      this.connectTradeSocketForVenue(venue, true);
    }
  }

  private ensureTradeRing(venue: string): TradeRingBuffer {
    const existing = this.tradeRingsByVenue.get(venue);
    if (existing) {
      return existing;
    }
    const ring = new TradeRingBuffer();
    this.tradeRingsByVenue.set(venue, ring);
    return ring;
  }

  private computeTradeBacklog(): number {
    let backlog = 0;
    for (const ring of this.tradeRingsByVenue.values()) {
      backlog += ring.size();
    }
    return backlog;
  }

  private resolveAdaptiveScheduler(backlog: number): { budgetMs: number; pullLimit: number; backlogPressure: number } {
    const backlogPressure = Math.min(6, Math.max(0, backlog / Math.max(TRADE_PULL_LIMIT_PER_FRAME, 1)));
    const framePenalty = Math.min(3, Math.max(0, (this.schedulerHint.frameTimeMs - 16.7) / 4.5));
    const cpuPenalty = Math.min(3, Math.max(0, (this.schedulerHint.cpuLoad - 1) * 1.35));
    const fpsPenalty = Math.min(3, Math.max(0, (55 - this.schedulerHint.fps) / 7));
    const loadPenalty = framePenalty + cpuPenalty + fpsPenalty;
    const budgetMs = Math.min(11, Math.max(2, TRADE_PULL_BUDGET_MS + backlogPressure * 1.4 - loadPenalty * 0.9));
    const pullLimit = Math.round(Math.min(960, Math.max(96, TRADE_PULL_LIMIT_PER_FRAME + backlog * 0.32 - loadPenalty * 84)));
    return { budgetMs, pullLimit, backlogPressure };
  }

  private scheduleTradeDrain(): void {
    if (this.tradeDrainRaf !== null) {
      return;
    }
    this.tradeDrainRaf = window.requestAnimationFrame((frameTs) => {
      this.tradeDrainRaf = null;
      this.drainTradeRings(frameTs);
      for (const ring of this.tradeRingsByVenue.values()) {
        if (ring.hasData()) {
          this.scheduleTradeDrain();
          break;
        }
      }
    });
  }

  private drainTradeRings(frameTs: number): void {
    if (!this.engine || !this.config) {
      return;
    }
    const backlogBeforeDrain = this.computeTradeBacklog();
    const adaptive = this.resolveAdaptiveScheduler(backlogBeforeDrain);
    const venues = [...this.tradeRingsByVenue.keys()].sort((left, right) => tradeVenuePriority(left) - tradeVenuePriority(right));
    const previewTrades: JsonMap[] = [];
    let processed = 0;
    const startedAt = typeof performance !== "undefined" ? performance.now() : frameTs;

    for (const venue of venues) {
      const ring = this.tradeRingsByVenue.get(venue);
      if (!ring) {
        continue;
      }
      while (ring.hasData() && processed < adaptive.pullLimit) {
        const nowMs = typeof performance !== "undefined" ? performance.now() : Date.now();
        if (nowMs - startedAt >= adaptive.budgetMs) {
          break;
        }
        if (!ring.shiftInto(this.tradeDrainScratch)) {
          break;
        }
        const price = this.tradeDrainScratch[0];
        const size = this.tradeDrainScratch[1];
        const sideFlag = this.tradeDrainScratch[2];
        const tsMs = this.tradeDrainScratch[3];
        this.engine.ingestTradeFast(price, size, sideFlag, tsMs, venue);
        this.fusionEngine?.updateTickFast(venue, price, size, tsMs);
        if (previewTrades.length < 24) {
          previewTrades.push({
            venue,
            instrument: canonicalInstrumentForVenue(this.config.instrument, venue),
            price,
            size,
            side: sideFlag > 0 ? "sell" : "buy",
            traded_at: new Date(tsMs).toISOString(),
            tsMs,
          });
        }
        const latencySampleMs = Math.max(0, nowMs - tsMs);
        const currentLatency = this.snapshot.kernelTelemetry.tickLatencyMs;
        this.snapshot = {
          ...this.snapshot,
          kernelTelemetry: {
            ...this.snapshot.kernelTelemetry,
            tickLatencyMs: currentLatency > 0 ? currentLatency * 0.82 + latencySampleMs * 0.18 : latencySampleMs,
          },
        };
        processed += 1;
      }
      if (processed >= adaptive.pullLimit) {
        break;
      }
    }

    if (processed <= 0) {
      this.snapshot = {
        ...this.snapshot,
        kernelTelemetry: {
          ...this.snapshot.kernelTelemetry,
          bufferBacklog: backlogBeforeDrain,
          schedulerBudgetMs: adaptive.budgetMs,
          schedulerPullLimit: adaptive.pullLimit,
          backlogPressure: adaptive.backlogPressure,
        },
      };
      return;
    }

    const backlogAfterDrain = this.computeTradeBacklog();
    const skippedFrames = backlogAfterDrain > 0
      ? this.snapshot.kernelTelemetry.skippedFrames + 1
      : this.snapshot.kernelTelemetry.skippedFrames;

    this.engine.syncLatencyFromV4();
    const mergedBars = this.publishEngineFrame();
    this.snapshot = {
      ...this.snapshot,
      nativeTrades: [...previewTrades.reverse(), ...this.snapshot.nativeTrades].slice(0, LIVE_NATIVE_TRADES_LIMIT),
      marketMicro: this._enrichMicroV5(this.snapshot.marketMicro),
      routingScore: this._buildRoutingScore(this.snapshot.routingScore),
      kernelTelemetry: {
        ...this.snapshot.kernelTelemetry,
        bufferBacklog: backlogAfterDrain,
        drainedTicksPerFrame: processed,
        skippedFrames,
        schedulerBudgetMs: adaptive.budgetMs,
        schedulerPullLimit: adaptive.pullLimit,
        cpuLoadHint: this.schedulerHint.cpuLoad,
        fpsHint: this.schedulerHint.fps,
        frameTimeHintMs: this.schedulerHint.frameTimeMs,
        backlogPressure: adaptive.backlogPressure,
        framesProcessed: this.snapshot.kernelTelemetry.framesProcessed + 1,
        candleUpdates: this.snapshot.kernelTelemetry.candleUpdates + processed,
        lastCandleUpdateAt: new Date().toISOString(),
        lastDrainAt: new Date().toISOString(),
      },
    };
    this.commitLiveBarsToReact(mergedBars);
  }

  private connectAuxDepthSockets(): void {
    const config = this.config;
    if (!config) {
      return;
    }
    const venues = this.activeFusionVenues().filter((venue) => venue !== config.venue);
    const keep = new Set(venues);
    for (const [venue, socket] of this.auxDepthSockets.entries()) {
      if (!keep.has(venue)) {
        this.safeCloseSocket(socket);
        this.auxDepthSockets.delete(venue);
        this.depthSnapshotsByVenue.delete(venue);
      }
    }
    for (const venue of venues) {
      if (this.auxDepthSockets.has(venue)) {
        continue;
      }
      this.connectDepthSocketForVenue(venue, true);
    }
  }

  private setVenueDepthSnapshot(venue: string, depthSnapshot: JsonMap | null): JsonMap | null {
    if (!this.config) {
      return depthSnapshot;
    }
    if (depthSnapshot) {
      this.depthSnapshotsByVenue.set(venue, depthSnapshot);
    } else {
      this.depthSnapshotsByVenue.delete(venue);
    }
    return aggregateDepthSnapshots(
      this.config.venue,
      canonicalInstrumentForVenue(this.config.instrument, this.config.venue),
      [...this.depthSnapshotsByVenue.values()],
    );
  }

  private connectTradeSocketForVenue(venue: string, auxiliary = false): void {
    const config = this.config;
    if (!config) {
      return;
    }
    const wsUrl = buildMarketTradesWsUrl(config.instrument, venue);
    if (!wsUrl) {
      return;
    }
    const socket = new WebSocket(wsUrl);
    if (auxiliary) {
      this.auxTradeSockets.set(venue, socket);
    } else {
      this.ohlcvSocket = socket;
    }
    let opened = false;
    const pingMap = auxiliary ? this.auxTradePingTimers : null;
    const reconnectMap = auxiliary ? this.auxTradeReconnectTimers : null;
    const tradeRing = this.ensureTradeRing(venue);

    socket.onopen = () => {
      opened = true;
      if (!auxiliary) {
        this.resetStreamFailures("ohlcv");
        this.snapshot = { ...this.snapshot, ohlcvStreamState: "live" };
        this.emit();
      }
      const timer = window.setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send("ping");
        }
      }, 20_000);
      if (auxiliary) {
        pingMap?.set(venue, timer);
      } else {
        this.ohlcvPingTimer = timer;
      }
    };

    socket.onmessage = (event) => {
      try {
        const payload = JSON.parse(String(event.data || "{}")) as JsonMap;
        if (!payload || typeof payload !== "object") {
          return;
        }
        if (payload.type === "snapshot") {
          const items = Array.isArray(payload.items) ? payload.items as JsonMap[] : [];
          let queued = 0;
          for (let index = 0; index < items.length; index += 1) {
            queued += enqueueTradePayloadIntoRing(items[index], tradeRing);
          }
          if (queued > 0) {
            this.snapshot = {
              ...this.snapshot,
              kernelTelemetry: {
                ...this.snapshot.kernelTelemetry,
                receivedTicks: this.snapshot.kernelTelemetry.receivedTicks + queued,
                bufferBacklog: this.computeTradeBacklog(),
              },
            };
            this.scheduleTradeDrain();
          }
          return;
        }
        if (payload.type === "trade") {
          const item = payload.item && typeof payload.item === "object"
            ? payload.item as JsonMap
            : null;
          if (item) {
            const queued = enqueueTradePayloadIntoRing(item, tradeRing);
            if (queued > 0) {
              this.snapshot = {
                ...this.snapshot,
                kernelTelemetry: {
                  ...this.snapshot.kernelTelemetry,
                  receivedTicks: this.snapshot.kernelTelemetry.receivedTicks + queued,
                  bufferBacklog: this.computeTradeBacklog(),
                },
              };
              this.scheduleTradeDrain();
            }
          }
        }
      } catch {
        // Ignore malformed websocket frames.
      }
    };

    socket.onerror = () => {
      if (!auxiliary && !opened) {
        this.registerStreamFailure("ohlcv");
        this.snapshot = { ...this.snapshot, ohlcvStreamState: this.snapshot.ohlcvBars.length > 0 ? "live" : "offline" };
        this.emit();
      }
    };

    socket.onclose = () => {
      if (auxiliary) {
        const pingTimer = this.auxTradePingTimers.get(venue);
        if (pingTimer !== undefined) {
          window.clearInterval(pingTimer);
          this.auxTradePingTimers.delete(venue);
        }
        if (this.auxTradeSockets.get(venue) !== socket) {
          return;
        }
        this.auxTradeSockets.delete(venue);
        const timer = window.setTimeout(() => {
          if (this.config) {
            this.connectTradeSocketForVenue(venue, true);
          }
        }, 2500);
        reconnectMap?.set(venue, timer);
        return;
      }
      if (this.ohlcvPingTimer !== null) {
        window.clearInterval(this.ohlcvPingTimer);
        this.ohlcvPingTimer = null;
      }
      if (this.ohlcvSocket !== socket) {
        return;
      }
      if (!opened) {
        this.registerStreamFailure("ohlcv");
      }
      this.snapshot = { ...this.snapshot, ohlcvStreamState: this.snapshot.ohlcvBars.length > 0 ? "live" : "offline" };
      this.emit();
      this.ohlcvReconnectTimer = window.setTimeout(() => {
        if (this.config) {
          this.connectOhlcvSocket();
        }
      }, 2500);
    };
  }

  private _buildRoutingScore(baseRouting: JsonMap | null): JsonMap | null {
    const fusion = this.fusionEngine?.getSnapshot() || null;
    if (!fusion) {
      return baseRouting;
    }
    const baseCandidates = Array.isArray(baseRouting?.candidates)
      ? baseRouting.candidates as JsonMap[]
      : [];
    const baseCandidateByVenue = new Map(baseCandidates.map((candidate) => [String(candidate.venue || "unknown"), candidate]));
    const candidates = fusion.routeCandidates.map((candidate) => ({
      ...(baseCandidateByVenue.get(candidate.venue) || {}),
      venue: candidate.venue,
      score: candidate.score,
      liquidity: candidate.liquidity,
      latency_ms: candidate.latency,
      fill_probability: candidate.fillProbability,
      spread_bps: candidate.spreadBps,
      last: candidate.last,
      bid: candidate.bid,
      ask: candidate.ask,
      freshness_ms: candidate.freshnessMs,
      source: "v6-price-fusion",
    }));
    return {
      ...(baseRouting || {}),
      source: "v6-price-fusion",
      fusion_price: fusion.fusionPrice,
      display_price: fusion.displayPrice,
      arbitrage: {
        opportunity: fusion.arbitrage.opportunity,
        spread: fusion.arbitrage.spread,
        net_spread: fusion.arbitrage.netSpread,
        buy: fusion.arbitrage.buy,
        sell: fusion.arbitrage.sell,
      },
      best: candidates[0] || ((baseRouting?.best as JsonMap | undefined) || null),
      backup: candidates[1] || ((baseRouting?.backup as JsonMap | undefined) || null),
      candidates,
    };
  }

  private connectOhlcvSocket(): void {
    const config = this.config;
    if (!config) {
      return;
    }
    if (this.isStreamCoolingDown("ohlcv")) {
      this.snapshot = { ...this.snapshot, ohlcvStreamState: "offline" };
      this.emit();
      void this.refreshNow("execution");
      this.ohlcvReconnectTimer = window.setTimeout(() => {
        if (this.config) {
          this.connectOhlcvSocket();
        }
      }, Math.max(5_000, this.streamCooldownUntil.ohlcv - Date.now()));
      return;
    }

    const wsUrl = buildMarketTradesWsUrl(config.instrument, config.venue);
    if (!wsUrl) {
      this.snapshot = { ...this.snapshot, ohlcvStreamState: this.snapshot.ohlcvBars.length > 0 ? "live" : "offline" };
      this.emit();
      return;
    }

    this.snapshot = { ...this.snapshot, ohlcvStreamState: this.snapshot.ohlcvBars.length > 0 ? "live" : "connecting" };
    this.emit();
    this.connectTradeSocketForVenue(config.venue, false);
    this.connectAuxTradeSockets();
  }

  private connectDepthSocketForVenue(venue: string, auxiliary = false): void {
    const config = this.config;
    if (!config) {
      return;
    }
    const wsUrl = buildMarketDepthWsUrl(config.instrument, venue);
    if (!wsUrl) {
      return;
    }
    const socket = new WebSocket(wsUrl);
    if (auxiliary) {
      this.auxDepthSockets.set(venue, socket);
    } else {
      this.depthSocket = socket;
    }
    let opened = false;
    let failureRecorded = false;

    socket.onopen = () => {
      opened = true;
      if (!auxiliary) {
        this.resetStreamFailures("depth");
        this.snapshot = { ...this.snapshot, depthStreamState: "live" };
        this.emit();
      }
      const timer = window.setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send("ping");
        }
      }, 20_000);
      if (auxiliary) {
        this.auxDepthPingTimers.set(venue, timer);
      } else {
        this.depthPingTimer = timer;
      }
    };

    socket.onmessage = (event) => {
      try {
        const payload = JSON.parse(String(event.data || "{}")) as JsonMap;
        if (!payload || typeof payload !== "object") {
          return;
        }
        const currentVenueDepth = (this.depthSnapshotsByVenue.get(venue) as JsonMap | undefined) || null;
        if (payload.type === "snapshot") {
          const mergedDepth = this.setVenueDepthSnapshot(venue, payload);
          const effectiveDepth = mergedDepth || payload;
          this._feedDepthToV5(effectiveDepth);
          const nextBars = this.publishEngineFrame(this.snapshot.ohlcvBars);
          this.snapshot = {
            ...this.snapshot,
            marketDepth: effectiveDepth,
            ohlcvBars: nextBars,
            marketMicro: this._enrichMicroV5(this.snapshot.marketMicro),
          };
          this.emit();
          return;
        }
        if (payload.type === "delta") {
          const nextVenueDepth = mergeDepthDelta(currentVenueDepth, payload);
          const mergedDepth = this.setVenueDepthSnapshot(venue, nextVenueDepth);
          const effectiveDepth = mergedDepth || nextVenueDepth;
          this._feedDepthToV5(effectiveDepth);
          const nextBars = this.publishEngineFrame(this.snapshot.ohlcvBars);
          this.snapshot = {
            ...this.snapshot,
            marketDepth: effectiveDepth,
            ohlcvBars: nextBars,
            marketMicro: this._enrichMicroV5(this.snapshot.marketMicro),
          };
          this.emit();
        }
      } catch {
        // Ignore malformed websocket frames.
      }
    };

    socket.onerror = () => {
      if (!auxiliary && !opened && !failureRecorded) {
        failureRecorded = true;
        this.registerStreamFailure("depth");
        this.snapshot = { ...this.snapshot, depthStreamState: "offline" };
        this.emit();
      }
    };

    socket.onclose = () => {
      if (auxiliary) {
        const pingTimer = this.auxDepthPingTimers.get(venue);
        if (pingTimer !== undefined) {
          window.clearInterval(pingTimer);
          this.auxDepthPingTimers.delete(venue);
        }
        if (this.auxDepthSockets.get(venue) !== socket) {
          return;
        }
        this.auxDepthSockets.delete(venue);
        const mergedDepth = this.setVenueDepthSnapshot(venue, null);
        this.snapshot = {
          ...this.snapshot,
          marketDepth: mergedDepth,
          marketMicro: this._enrichMicroV5(this.snapshot.marketMicro),
        };
        this.emit();
        const timer = window.setTimeout(() => {
          if (this.config) {
            this.connectDepthSocketForVenue(venue, true);
          }
        }, 2500);
        this.auxDepthReconnectTimers.set(venue, timer);
        return;
      }

      if (this.depthPingTimer !== null) {
        window.clearInterval(this.depthPingTimer);
        this.depthPingTimer = null;
      }
      if (this.depthSocket !== socket) {
        return;
      }
      if (!opened && !failureRecorded) {
        failureRecorded = true;
        this.registerStreamFailure("depth");
      }
      const mergedDepth = this.setVenueDepthSnapshot(venue, null);
      this.snapshot = { ...this.snapshot, marketDepth: mergedDepth, depthStreamState: "offline" };
      this.emit();
      this.depthReconnectTimer = window.setTimeout(() => {
        if (this.config) {
          this.connectDepthSocket();
        }
      }, 2500);
    };
  }

  private connectDepthSocket(): void {
    const config = this.config;
    if (!config) {
      return;
    }
    if (this.isStreamCoolingDown("depth")) {
      this.snapshot = { ...this.snapshot, depthStreamState: "offline" };
      this.emit();
      void this.refreshNow("execution");
      this.depthReconnectTimer = window.setTimeout(() => {
        if (this.config) {
          this.connectDepthSocket();
        }
      }, Math.max(5_000, this.streamCooldownUntil.depth - Date.now()));
      return;
    }
    const wsUrl = buildMarketDepthWsUrl(config.instrument, config.venue);
    if (!wsUrl) {
      this.snapshot = { ...this.snapshot, depthStreamState: "offline" };
      this.emit();
      return;
    }

    this.snapshot = { ...this.snapshot, depthStreamState: "connecting" };
    this.emit();
    this.connectDepthSocketForVenue(config.venue, false);
    this.connectAuxDepthSockets();
  }
}

export function createMarketDataBus(): {
  subscribe: (listener: MarketDataBusListener) => () => void;
  connect: (config: MarketDataBusConfig) => void;
  disconnect: () => void;
  refreshNow: (requestType?: MarketBusRequestType) => Promise<void>;
  ingestPriceTick: (price: number, tsMs?: number) => void;
  setSchedulerHint: (hint: MarketDataBusSchedulerHint) => void;
  setBenchmarkMode: (enabled: boolean, ticksPerSec?: number) => void;
} {
  const bus = new MarketDataBus();
  return {
    subscribe: (listener) => bus.subscribe(listener),
    connect: (config) => bus.connect(config),
    disconnect: () => bus.disconnect(),
    refreshNow: (requestType) => bus.refreshNow(requestType),
    ingestPriceTick: (price, tsMs) => bus.ingestPriceTick(price, tsMs),
    setSchedulerHint: (hint) => bus.setSchedulerHint(hint),
    setBenchmarkMode: (enabled, ticksPerSec) => bus.setBenchmarkMode(enabled, ticksPerSec),
  };
}