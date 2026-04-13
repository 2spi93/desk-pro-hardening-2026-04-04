const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const perceptualPath = path.join(__dirname, "..", "app", "terminal", "chartPerceptual.ts");
const chartPath = path.join(__dirname, "..", "app", "terminal", "InstitutionalChart.tsx");

const perceptualSource = fs.readFileSync(perceptualPath, "utf8");
const chartSource = fs.readFileSync(chartPath, "utf8");

assert.match(
  perceptualSource,
  /minVisibleBars: number;\s+maxVisibleBars: number;/m,
  "Perceptual time-scale policy must expose minVisibleBars and maxVisibleBars",
);
assert.match(
  chartSource,
  /resolveStableLogicalWidthFromSpacing\([\s\S]*requestedVisibleBars: width \* zoomFactor[\s\S]*spacingPolicy/,
  "Wheel zoom must snap visible width through the stable logical-width resolver",
);
assert.match(
  chartSource,
  /barsVisible > spacingPolicy\.maxVisibleBars \+ 1/,
  "Visible range handler must heal excessive zoom-out beyond perceptual maxVisibleBars",
);

console.log("PASS dynamic candle scaling guard: wheel zoom and visible range are clamped by perceptual min/max visible bars");