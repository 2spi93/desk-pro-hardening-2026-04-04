const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const chartPath = path.join(__dirname, "..", "app", "terminal", "InstitutionalChart.tsx");
const chartSource = fs.readFileSync(chartPath, "utf8");

assert.match(
  chartSource,
  /function resolveDynamicCandlePresentation\(/,
  "InstitutionalChart must define a dynamic candle presentation policy",
);
assert.match(
  chartSource,
  /dynamicCandlePresentation\.overlayWidthPx/,
  "Active candle overlay must use the dynamic presentation width",
);
assert.match(
  chartSource,
  /dynamicCandlePresentation\.formingWidthPx/,
  "Forming candle overlay must use the dynamic presentation width",
);
assert.match(
  chartSource,
  /"--chart-profile-wick-width": `\$\{dynamicCandlePresentation\.wickWidthPx\}px`/,
  "Chart root CSS variables must expose dynamic wick width",
);
assert.match(
  chartSource,
  /resolvePerceptualCandleStyleOptions\([\s\S]*dynamicCandlePresentation/,
  "Native candle styling must consume the dynamic presentation policy",
);

console.log("PASS dynamic candle presentation guard: native style, overlay width and forming candle share one presentation policy");
