import assert from "node:assert/strict";

import { applyPerceptionPipeline, type PerceptionCandle } from "../../app/terminal/perceptionEngine";

const sourceCandles: PerceptionCandle[] = [
  {
    time: 1,
    open: 100,
    high: 103,
    low: 99,
    close: 102,
    volume: 12,
  },
  {
    time: 2,
    open: 102,
    high: 104,
    low: 101,
    close: 101.5,
    volume: 15,
  },
  {
    time: 3,
    open: 101.5,
    high: 105,
    low: 100.5,
    close: 104.25,
    volume: 18,
  },
];

const transformed = applyPerceptionPipeline(sourceCandles, {
  density: "compressed",
  timeframe: "1m",
  volatility: 0.0025,
  domImbalance: 0.18,
});

assert.equal(transformed.length, sourceCandles.length, "perception pipeline should preserve candle count");

for (let index = 0; index < sourceCandles.length; index += 1) {
  const source = sourceCandles[index];
  const next = transformed[index];
  assert.equal(next.time, source.time, "time should remain unchanged");
  assert.equal(next.open, source.open, "open should remain unchanged");
  assert.equal(next.close, source.close, "close should remain unchanged");
  assert.equal(next.volume, source.volume, "volume should remain unchanged");
  assert.ok(next.high >= source.high, "high should preserve or extend wick geometry");
  assert.ok(next.low <= source.low, "low should preserve or extend wick geometry");
  assert.ok(next.high >= Math.max(next.open, next.close), "high should remain above body");
  assert.ok(next.low <= Math.min(next.open, next.close), "low should remain below body");
  assert.ok(next.__visual, "visual metadata should still be attached");
  assert.ok(next.__smart, "smart metrics should be attached");
  assert.ok((next.__smart?.qualityScore ?? -1) >= 0 && (next.__smart?.qualityScore ?? 2) <= 1, "quality score should be normalized");
  assert.ok(next.__smart?.noiseClass === "noise" || next.__smart?.noiseClass === "weak" || next.__smart?.noiseClass === "valid", "noise class should be resolved");
}

assert.ok(
  transformed.some((next, index) => next.high > sourceCandles[index].high || next.low < sourceCandles[index].low),
  "compressed 1m perception should now propagate at least one enhanced wick envelope",
);

console.log("PASS perception-engine regression: visual styling preserves body semantics and propagates wick envelopes");