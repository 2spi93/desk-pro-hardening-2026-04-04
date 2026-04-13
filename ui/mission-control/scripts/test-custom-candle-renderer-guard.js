const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const chartPath = path.join(__dirname, "..", "app", "terminal", "InstitutionalChart.tsx");
const source = fs.readFileSync(chartPath, "utf8");

assert.match(
  source,
  /const ENABLE_CUSTOM_V3_CANDLE_RENDERER = process\.env\.NEXT_PUBLIC_ENABLE_CUSTOM_V3_CANDLE_RENDERER === "1";/,
  "custom candle renderer must keep an env-gated escape hatch",
);
assert.ok(
  !source.includes("const ENABLE_CUSTOM_V3_CANDLE_RENDERER = true;"),
  "custom candle renderer must not silently default back to enabled",
);
assert.match(
  source,
  /const customV3RendererEnabled = mode === "candles" && \(perceptualDeskMode\.authoritativeRenderer \|\| ENABLE_CUSTOM_V3_CANDLE_RENDERER\);/,
  "desk candle mode must be able to make the perceptual V3 renderer authoritative while preserving the env override path",
);

console.log("PASS custom candle renderer guard: desk mode can make V3 authoritative and the env override path remains intact");