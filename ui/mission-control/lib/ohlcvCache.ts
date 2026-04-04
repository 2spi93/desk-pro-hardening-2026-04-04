/**
 * Server-side in-memory OHLCV cache (module-level, per Next.js worker).
 *
 * TTL dynamique : timeframeMs / 2 (ex: 1m → 30s, 5m → 150s, 1h → 1800s).
 * Minimum 10s, maximum 120s pour éviter les données trop stales.
 */

import { timeframeToMs } from "./ohlcvDataEngine";

function cacheTtlMs(timeframe: string): number {
  const tfMs = timeframeToMs(timeframe);
  return Math.max(10_000, Math.min(120_000, Math.floor(tfMs / 2)));
}

type CacheEntry = {
  data: unknown[];
  cachedAt: number;
  ttlMs: number;
};

const cache = new Map<string, CacheEntry>();

export function getCachedOhlcv(instrument: string, timeframe: string): unknown[] | null {
  const key = `${instrument}:${timeframe}`;
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > entry.ttlMs) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

export function setCachedOhlcv(instrument: string, timeframe: string, data: unknown[]): void {
  const key = `${instrument}:${timeframe}`;
  cache.set(key, { data, cachedAt: Date.now(), ttlMs: cacheTtlMs(timeframe) });
  // Pruner les entrées stales (max 64)
  if (cache.size > 64) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].cachedAt - b[1].cachedAt)[0];
    if (oldest) cache.delete(oldest[0]);
  }
}
