const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const pagePath = path.join(__dirname, "..", "app", "terminal", "page.tsx");
const gpuSurfacePath = path.join(__dirname, "..", "app", "terminal", "GpuChartV4Surface.tsx");
const candleLayerPath = path.join(__dirname, "..", "lib", "engine", "gpu-chart", "CandleLayer.ts");

const pageSource = fs.readFileSync(pagePath, "utf8");
const gpuSurfaceSource = fs.readFileSync(gpuSurfacePath, "utf8");
const candleLayerSource = fs.readFileSync(candleLayerPath, "utf8");

assert.match(
  pageSource,
  /const label = new Date\(\)\.toISOString\(\);/,
  "page.tsx must store quoteHistory points with ISO timestamps so multi-chart feeds share real clock time",
);
assert.doesNotMatch(
  pageSource,
  /buildSyntheticMiniCandles/,
  "page.tsx must not fabricate synthetic GPU mini-candles for multi-chart comparison",
);
assert.match(
  gpuSurfaceSource,
  /function resolveMasterClockTime\(/,
  "GpuChartV4Surface.tsx must define a master-clock resolver for multi-chart sync",
);
assert.match(
  gpuSurfaceSource,
  /function syncBarsToMasterClock\(/,
  "GpuChartV4Surface.tsx must trim secondary feeds to the common master clock",
);
assert.match(
  gpuSurfaceSource,
  /function normalizeBarsForComparison\(/,
  "GpuChartV4Surface.tsx must normalize secondary feeds for cross-asset comparison",
);
assert.match(
  candleLayerSource,
  /const normalizedTime = Number\.isFinite\(bar\.time\)/,
  "CandleLayer.ts must position candles from timestamp data rather than constant index spacing",
);
assert.match(
  candleLayerSource,
  /minTime,\s*maxTime,\s*edgePadTime/,
  "CandleLayer.ts must propagate time-range metadata through the GPU packing path",
);

console.log("PASS multi-chart sync guard: ISO quote history, master-clock sync, normalized comparison, and time-based GPU spacing are present");