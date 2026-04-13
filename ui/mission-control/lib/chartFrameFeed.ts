export type LiveChartCandle = {
  label: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type LiveChartFrameMeta = {
  syncStatus: "atomic" | "loose-sync" | "coalesced";
  partial: boolean;
  coalesced: boolean;
  confidence: number;
  dynamicBufferMs: number;
  stallAgeMs: number;
  depthSequence: number | null;
  depthEventTs: number | null;
  tradeEventTs: number | null;
  batchSkewMs?: number | null;
  batchPublishedAt?: number | null;
  batchFrameCount?: number | null;
};

export type LiveChartFrame = {
  feedKey: string;
  candles: LiveChartCandle[];
  publishedAt: number;
  signature: string;
  meta: LiveChartFrameMeta;
};

export type LiveChartFrameBatch = {
  batchKey: string;
  publishedAt: number;
  frames: LiveChartFrame[];
};

type LiveChartFrameListener = (frame: LiveChartFrame) => void;
type LiveChartFrameBatchListener = (batch: LiveChartFrameBatch) => void;

const frameListeners = new Map<string, Set<LiveChartFrameListener>>();
const batchListeners = new Set<LiveChartFrameBatchListener>();
const latestFrames = new Map<string, LiveChartFrame>();
let latestBatch: LiveChartFrameBatch | null = null;

function normalizeFrameMeta(meta?: Partial<LiveChartFrameMeta>): LiveChartFrameMeta {
  return {
    syncStatus: meta?.syncStatus === "loose-sync" || meta?.syncStatus === "coalesced" ? meta.syncStatus : "atomic",
    partial: Boolean(meta?.partial),
    coalesced: Boolean(meta?.coalesced),
    confidence: Number.isFinite(meta?.confidence) ? Math.max(0, Math.min(1, Number(meta?.confidence))) : 1,
    dynamicBufferMs: Number.isFinite(meta?.dynamicBufferMs) ? Math.max(0, Math.round(Number(meta?.dynamicBufferMs))) : 50,
    stallAgeMs: Number.isFinite(meta?.stallAgeMs) ? Math.max(0, Math.round(Number(meta?.stallAgeMs))) : 0,
    depthSequence: Number.isFinite(meta?.depthSequence) ? Number(meta?.depthSequence) : null,
    depthEventTs: Number.isFinite(meta?.depthEventTs) ? Number(meta?.depthEventTs) : null,
    tradeEventTs: Number.isFinite(meta?.tradeEventTs) ? Number(meta?.tradeEventTs) : null,
    batchSkewMs: Number.isFinite(meta?.batchSkewMs) ? Math.max(0, Math.round(Number(meta?.batchSkewMs))) : null,
    batchPublishedAt: Number.isFinite(meta?.batchPublishedAt) ? Number(meta?.batchPublishedAt) : null,
    batchFrameCount: Number.isFinite(meta?.batchFrameCount) ? Math.max(1, Math.round(Number(meta?.batchFrameCount))) : null,
  };
}

function cloneCandleSnapshot(candles: LiveChartCandle[]): LiveChartCandle[] {
  const next: LiveChartCandle[] = [];
  for (const candle of candles) {
    if (!candle) {
      continue;
    }
    const open = Number(candle.open);
    const high = Number(candle.high);
    const low = Number(candle.low);
    const close = Number(candle.close);
    const volume = Number(candle.volume);
    if (!Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close) || !Number.isFinite(volume)) {
      continue;
    }
    next.push({
      label: String(candle.label || ""),
      open,
      high: Math.max(high, open, close),
      low: Math.min(low, open, close),
      close,
      volume,
    });
  }
  return next;
}

function buildFrameSnapshot(feedKey: string, candles: LiveChartCandle[], publishedAt: number, meta: LiveChartFrameMeta): LiveChartFrame {
  const candleSnapshot = cloneCandleSnapshot(candles);
  const metaSnapshot = normalizeFrameMeta(meta);
  return {
    feedKey,
    candles: candleSnapshot,
    publishedAt,
    signature: frameSignature(candleSnapshot, metaSnapshot),
    meta: metaSnapshot,
  };
}

function cloneFrameFromLatest(feedKey: string): LiveChartFrame | null {
  const latest = latestFrames.get(feedKey);
  if (!latest) {
    return null;
  }
  return buildFrameSnapshot(latest.feedKey, latest.candles, latest.publishedAt, latest.meta);
}

function frameSignature(candles: LiveChartCandle[], meta: LiveChartFrameMeta): string {
  const last = candles[candles.length - 1];
  if (!last) {
    return ["0", meta.syncStatus, meta.partial ? "p1" : "p0", meta.coalesced ? "c1" : "c0"].join("|");
  }
  return [
    candles.length,
    last.label,
    last.open.toFixed(8),
    last.high.toFixed(8),
    last.low.toFixed(8),
    last.close.toFixed(8),
    last.volume.toFixed(8),
    meta.syncStatus,
    meta.partial ? "p1" : "p0",
    meta.coalesced ? "c1" : "c0",
    meta.confidence.toFixed(3),
    meta.dynamicBufferMs,
    meta.depthSequence ?? "-",
    meta.batchSkewMs ?? "-",
    meta.batchFrameCount ?? "-",
  ].join("|");
}

export function publishChartFrame(feedKey: string, candles: LiveChartCandle[], meta?: Partial<LiveChartFrameMeta>): void {
  if (!feedKey) {
    return;
  }
  const normalizedMeta = normalizeFrameMeta(meta);
  const frame = buildFrameSnapshot(feedKey, candles, Date.now(), normalizedMeta);
  if (frame.candles.length === 0) {
    return;
  }
  const signature = frame.signature;
  const previous = latestFrames.get(feedKey);
  if (previous?.signature === signature) {
    return;
  }
  latestFrames.set(feedKey, frame);
  const listeners = frameListeners.get(feedKey);
  if (!listeners || listeners.size === 0) {
    return;
  }
  for (const listener of listeners) {
    listener(frame);
  }
}

export function subscribeChartFrame(feedKey: string, listener: LiveChartFrameListener): () => void {
  if (!feedKey) {
    return () => {};
  }
  const listeners = frameListeners.get(feedKey) || new Set<LiveChartFrameListener>();
  listeners.add(listener);
  frameListeners.set(feedKey, listeners);

  const latest = latestFrames.get(feedKey);
  if (latest) {
    listener(latest);
  }

  return () => {
    const active = frameListeners.get(feedKey);
    if (!active) {
      return;
    }
    active.delete(listener);
    if (active.size === 0) {
      frameListeners.delete(feedKey);
    }
  };
}

export function publishChartFrameBatch(batchKey: string, entries: Array<{ feedKey: string; candles: LiveChartCandle[]; meta?: Partial<LiveChartFrameMeta> }>): void {
  const normalizedKey = String(batchKey || "").trim() || `batch-${Date.now()}`;
  const publishedAt = Date.now();
  const frames: LiveChartFrame[] = [];
  for (const entry of entries) {
    if (!entry || !entry.feedKey) {
      continue;
    }
    publishChartFrame(entry.feedKey, entry.candles, {
      ...(entry.meta || {}),
      batchPublishedAt: publishedAt,
      batchFrameCount: entries.length,
    });
    const frame = cloneFrameFromLatest(entry.feedKey);
    if (frame) {
      frames.push(frame);
    }
  }
  latestBatch = {
    batchKey: normalizedKey,
    publishedAt,
    frames,
  };
  for (const listener of batchListeners) {
    listener(latestBatch);
  }
}

export function subscribeChartFrameBatch(listener: LiveChartFrameBatchListener): () => void {
  batchListeners.add(listener);
  if (latestBatch) {
    listener(latestBatch);
  }
  return () => {
    batchListeners.delete(listener);
  };
}

export function getLatestChartFrameBatch(): LiveChartFrameBatch | null {
  return latestBatch;
}

export function clearChartFrame(feedKey: string): void {
  if (!feedKey) {
    return;
  }
  latestFrames.delete(feedKey);
}