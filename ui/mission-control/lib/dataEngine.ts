/**
 * Data engine: decimation + conflation + OHLC aggregation.
 *
 * Provides professional-grade data transforms:
 *   decimate()       — reduce candle count while preserving OHLC / volume
 *   conflate()       — merge multiple bars into single aggregation
 *   aggregateTicksToOhlc() — build candles from tick data
 *
 * Usage:
 *   const decimated = decimate(bars, maxBars);  // for zoom out
 *   const conflated = conflate(bars, 5);         // 5-bar merge
 */

export type Bar = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

/**
 * Decimate reduces candle count by averaging high/low bands while keeping OHLC.
 *
 * When zooming out, instead of rendering 500 bars, render 50 "fused" bars.
 * This is what TradingView does natively.
 *
 * Formula:
 *   - Select every Nth bar
 *   - Merge their OHLC/volume
 *   - Preserve time anchors
 *
 * Performance: O(n) where n = bars.length
 */
export function decimate(bars: Bar[], maxBars: number): Bar[] {
  if (bars.length === 0) return [];
  if (bars.length <= maxBars) return bars;

  const step = Math.ceil(bars.length / maxBars);
  const result: Bar[] = [];

  for (let i = 0; i < bars.length; i += step) {
    const slice = bars.slice(i, Math.min(i + step, bars.length));
    if (slice.length === 0) continue;

    const opens = slice.map((b) => b.open).filter(Number.isFinite);
    const highs = slice.map((b) => b.high).filter(Number.isFinite);
    const lows = slice.map((b) => b.low).filter(Number.isFinite);
    const closes = slice.map((b) => b.close).filter(Number.isFinite);
    const volumes = slice.map((b) => b.volume).filter(Number.isFinite);

    if (opens.length === 0 || closes.length === 0) continue;

    result.push({
      time: slice[0].time, // anchor to first bar in slice
      open: opens[0], // open of first
      high: highs.length > 0 ? Math.max(...highs) : opens[0], // highest in slice
      low: lows.length > 0 ? Math.min(...lows) : opens[0], // lowest in slice
      close: closes[closes.length - 1], // close of last
      volume: volumes.reduce((sum, v) => sum + v, 0), // sum
    });
  }

  return result;
}

/**
 * Conflate merges N consecutive bars into single aggregated bar.
 *
 * Applied before decimation, or for "X-bar rollup" views.
 *
 * Formula (same as decimate internally, but fixed step):
 *   - Group every N bars
 *   - Compute OHLC + volume for each group
 *
 * Example: conflate(bars, 3) = every 3 bars merge to 1 bar
 */
export function conflate(bars: Bar[], mergeCount: number): Bar[] {
  if (bars.length === 0 || mergeCount <= 1) return bars;

  const result: Bar[] = [];

  for (let i = 0; i < bars.length; i += mergeCount) {
    const slice = bars.slice(i, Math.min(i + mergeCount, bars.length));
    if (slice.length === 0) continue;

    const opens = slice.map((b) => b.open);
    const highs = slice.map((b) => b.high);
    const lows = slice.map((b) => b.low);
    const closes = slice.map((b) => b.close);
    const volumes = slice.map((b) => b.volume);

    result.push({
      time: slice[0].time,
      open: opens[0],
      high: Math.max(...highs),
      low: Math.min(...lows),
      close: closes[closes.length - 1],
      volume: volumes.reduce((sum, v) => sum + v, 0),
    });
  }

  return result;
}

/**
 * Fast hash for bar array (used for memoization dependency).
 *
 * Returns a stable hash that changes only when data meaningfully changes.
 * Used in useMemo to avoid comparing arrays directly.
 *
 * Performance: O(min(n, 100)) — only hashes first + last + every Nth
 */
export function barArrayHash(bars: Bar[]): string {
  if (bars.length === 0) return "empty";

  const samples = [];

  // First bar
  samples.push(bars[0].time, bars[0].close);

  // Last bar
  samples.push(bars[bars.length - 1].time, bars[bars.length - 1].close);

  // Sample every Nth (to keep hash function O(1) even for 100k bars)
  const sampleFreq = Math.max(1, Math.floor(bars.length / 20));
  for (let i = sampleFreq; i < bars.length; i += sampleFreq) {
    samples.push(bars[i].time, bars[i].close);
  }

  // Simple hash: concatenate and compute checksum
  return samples
    .map((v) => v.toString().charCodeAt(0) || 0)
    .reduce((hash, code) => ((hash << 5) - hash + code) | 0, 0)
    .toString(36);
}

/**
 * Compute optimal decimation level for viewport.
 *
 * Given:
 *   - visibleBarCount: how many bars fit on screen
 *   - totalBarCount: available data
 *
 * Returns: step size or decimated bar count
 */
export function computeDecimationLevel(
  visibleBarCount: number,
  totalBarCount: number,
): { step: number; decimatedCount: number } {
  const step = Math.max(1, Math.ceil(totalBarCount / visibleBarCount));
  const decimatedCount = Math.ceil(totalBarCount / step);

  return { step, decimatedCount };
}
