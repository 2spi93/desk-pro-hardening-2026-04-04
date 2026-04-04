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
  assert.equal(next.high, source.high, "high should remain unchanged");
  assert.equal(next.low, source.low, "low should remain unchanged");
  assert.equal(next.close, source.close, "close should remain unchanged");
  assert.equal(next.volume, source.volume, "volume should remain unchanged");
  assert.ok(next.__visual, "visual metadata should still be attached");
}

console.log("PASS perception-engine regression: visual styling preserves OHLC semantics");