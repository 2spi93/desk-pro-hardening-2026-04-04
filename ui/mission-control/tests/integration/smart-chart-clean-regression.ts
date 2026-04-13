import assert from "node:assert/strict";

import { preFilterTicks } from "../../app/terminal/preCandleFilter";
import { applyPerceptionPipeline, type PerceptionCandle } from "../../app/terminal/perceptionEngine";

const filteredTicks = preFilterTicks([
  { time: 1, price: 100, volume: 8, side: "buy" as const, kind: "trade" as const, intensity: 0.2 },
  { time: 2, price: 100.05, volume: 9, side: "sell" as const, kind: "trade" as const, intensity: 0.18 },
  { time: 3, price: 100, volume: 8, side: "buy" as const, kind: "trade" as const, intensity: 0.2 },
  { time: 4, price: 100.6, volume: 26, side: "buy" as const, kind: "trade" as const, intensity: 0.72 },
  { time: 5, price: 101.1, volume: 29, side: "buy" as const, kind: "trade" as const, intensity: 0.76 },
], {
  minPriceIncrement: 0.1,
  minRelativeMoveRatio: 0.5,
  alternatingLookback: 3,
});

assert.ok(filteredTicks.filtered.length < 5, "pre-filter should remove low-value microstructure ticks");
assert.ok(filteredTicks.telemetry.droppedRatio > 0, "pre-filter should expose a dropped-ratio noise signal");

const sourceCandles: PerceptionCandle[] = [
  {
    time: 1,
    open: 100,
    high: 100.8,
    low: 99.8,
    close: 100.45,
    volume: 12,
  },
  {
    time: 2,
    open: 100.45,
    high: 101.2,
    low: 99.7,
    close: 100.5,
    volume: 6,
  },
  {
    time: 3,
    open: 100.5,
    high: 102.1,
    low: 100.35,
    close: 101.95,
    volume: 32,
  },
];

const transformed = applyPerceptionPipeline(sourceCandles, {
  density: "compressed",
  timeframe: "5s",
  volatility: 0.0018,
  microstructureNoiseRatio: filteredTicks.telemetry.droppedRatio,
});

assert.equal(transformed[1].__smart?.noiseClass, "noise", "high-wick low-volume candle should be classified as noise");
assert.ok((transformed[1].__smart?.wickOpacityPenalty ?? 0) > 0, "noisy wick should receive an opacity penalty");
assert.equal(transformed[2].__smart?.role, "trigger", "strong impulse candle should become a trigger");
assert.ok((transformed[2].__smart?.qualityScore ?? 0) >= 0.65, "trigger candle should clear the trigger threshold");

console.log("PASS smart-chart clean regression: pre-filter noise is exposed and candle quality classifies noise vs trigger candles");