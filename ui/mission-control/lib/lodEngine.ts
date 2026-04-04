import { decimate, type Bar } from "./dataEngine";

export function getLODLevel(visibleBars: number): number {
  // Relaxed thresholds: preserve 1:1 fidelity for most zoom levels
  // Only decimate at extreme zoom-out to keep candles smooth & continuous
  if (visibleBars < 400) return 1;
  if (visibleBars < 800) return 2;
  return 3;
}

export function applyDynamicLod(rawBars: Bar[], visibleBars: number): Bar[] {
  const lod = getLODLevel(Math.max(1, visibleBars));
  if (lod <= 1 || rawBars.length <= 300) {
    return rawBars;
  }

  const targetBars = Math.max(120, Math.floor(rawBars.length / lod));
  return decimate(rawBars, targetBars);
}
