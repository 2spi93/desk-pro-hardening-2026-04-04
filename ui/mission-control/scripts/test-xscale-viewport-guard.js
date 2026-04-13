const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const chartPath = path.join(__dirname, "..", "app", "terminal", "InstitutionalChart.tsx");
const perceptualPath = path.join(__dirname, "..", "app", "terminal", "chartPerceptual.ts");
const source = fs.readFileSync(chartPath, "utf8");
const perceptualSource = fs.readFileSync(perceptualPath, "utf8");

assert.match(
  source,
  /function resolveViewportVisibleBars\(/,
  "InstitutionalChart must define a viewport-based visible bar resolver",
);
assert.doesNotMatch(
  source,
  /Math\.max\(visibleBarsRef\.current, frame\.candles\.length\)/,
  "Live-frame perceptual density must not fall back to frame.candles.length",
);
assert.doesNotMatch(
  source,
  /Math\.max\(visibleBarsRef\.current, candleData\.length\)/,
  "Perceptual conflation must not fall back to candleData.length",
);
assert.match(
  source,
  /visibleBarsRef\.current = resetVisibleBars;/,
  "Timeframe resets must seed visibleBarsRef from the viewport policy",
);
assert.match(
  perceptualSource,
  /export function quantizePerceptualBarSpacing\(/,
  "The time-scale policy must quantize bar spacing onto stable zones",
);
assert.match(
  source,
  /resolveStableLogicalWidthFromSpacing\(/,
  "Zoom and range handlers must snap logical width from stable spacing zones",
);

console.log("PASS x-scale viewport guard: visible bars stay viewport-driven and spacing is snapped onto stable pixel zones");