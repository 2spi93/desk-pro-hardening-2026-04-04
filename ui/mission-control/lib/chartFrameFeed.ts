export type LiveChartCandle = {
  label: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type LiveChartFrame = {
  feedKey: string;
  candles: LiveChartCandle[];
  publishedAt: number;
  signature: string;
};

type LiveChartFrameListener = (frame: LiveChartFrame) => void;

const frameListeners = new Map<string, Set<LiveChartFrameListener>>();
const latestFrames = new Map<string, LiveChartFrame>();

function frameSignature(candles: LiveChartCandle[]): string {
  const last = candles[candles.length - 1];
  if (!last) {
    return "0";
  }
  return [
    candles.length,
    last.label,
    last.open.toFixed(8),
    last.high.toFixed(8),
    last.low.toFixed(8),
    last.close.toFixed(8),
    last.volume.toFixed(8),
  ].join("|");
}

export function publishChartFrame(feedKey: string, candles: LiveChartCandle[]): void {
  if (!feedKey) {
    return;
  }
  const signature = frameSignature(candles);
  const previous = latestFrames.get(feedKey);
  if (previous?.signature === signature) {
    return;
  }
  const frame: LiveChartFrame = {
    feedKey,
    candles,
    publishedAt: Date.now(),
    signature,
  };
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

export function clearChartFrame(feedKey: string): void {
  if (!feedKey) {
    return;
  }
  latestFrames.delete(feedKey);
}