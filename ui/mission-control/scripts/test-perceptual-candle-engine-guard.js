const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const enginePath = path.join(__dirname, "..", "app", "terminal", "chartPerceptualEngine.ts");
const chartPath = path.join(__dirname, "..", "app", "terminal", "InstitutionalChart.tsx");

const engineSource = fs.readFileSync(enginePath, "utf8");
const chartSource = fs.readFileSync(chartPath, "utf8");

assert.match(
  engineSource,
  /export function computePerceptualCandle\(/,
  "Perceptual candle engine must expose a computePerceptualCandle() entry point",
);
assert.match(
  engineSource,
  /export function computeTimeframeWeight\(/,
  "Perceptual candle engine must include timeframe weighting",
);
assert.match(
  engineSource,
  /export function computeDensityFactor\(/,
  "Perceptual candle engine must include density compensation",
);
assert.match(
  engineSource,
  /export function computePerceptualWickWidth\(/,
  "Perceptual candle engine must expose wick sizing from body width",
);
assert.match(
  chartSource,
  /computePerceptualCandle\([\s\S]*visibleBars: input\.visibleBars[\s\S]*timeframe: input\.timeframe/,
  "InstitutionalChart must compute presentation width from visibleBars and timeframe",
);
assert.match(
  chartSource,
  /computePerceptualWickWidth\([\s\S]*bodyWidth/,
  "Custom V3 renderer must derive wick width from the final body width",
);
assert.match(
  engineSource,
  /export function resolvePerceptualDeskMode\(/,
  "Perceptual candle engine must expose a flow-aware Micro\/Macro\/Execution mode resolver",
);
assert.match(
  chartSource,
  /perceptualDeskMode\.authoritativeRenderer \|\| ENABLE_CUSTOM_V3_CANDLE_RENDERER/,
  "InstitutionalChart must allow the perceptual desk mode to make V3 authoritative",
);

console.log("PASS perceptual candle engine guard: timeframe, density, zoom and wick/body sync drive V3 width presentation");