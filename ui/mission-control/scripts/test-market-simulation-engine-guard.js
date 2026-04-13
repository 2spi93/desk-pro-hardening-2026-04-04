const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const simulationPath = path.join(__dirname, "..", "app", "terminal", "marketSimulationEngine.ts");
const pagePath = path.join(__dirname, "..", "app", "terminal", "page.tsx");
const chartPath = path.join(__dirname, "..", "app", "terminal", "InstitutionalChart.tsx");

const simulationSource = fs.readFileSync(simulationPath, "utf8");
const pageSource = fs.readFileSync(pagePath, "utf8");
const chartSource = fs.readFileSync(chartPath, "utf8");

assert.match(
  simulationSource,
  /export function simulateMarket\(/,
  "V6 simulation engine must expose simulateMarket()",
);
assert.match(
  simulationSource,
  /export function shouldExecute\(/,
  "V6 simulation engine must expose shouldExecute()",
);
assert.match(
  simulationSource,
  /export function computeExecutionCone\(/,
  "V6 simulation engine must expose computeExecutionCone()",
);
assert.match(
  pageSource,
  /const chartMarketSimulation = useMemo<MarketSimulation \| null>\(/,
  "page.tsx must derive a chartMarketSimulation state",
);
assert.match(
  pageSource,
  /simulateMarket\(\{[\s\S]*orderBook:[\s\S]*flow:[\s\S]*volatility[:,]/,
  "page.tsx must feed order book, flow, and volatility into simulateMarket()",
);
assert.match(
  pageSource,
  /marketSimulation=\{chartMode === "candles" \? chartMarketSimulation : null\}/,
  "page.tsx must forward marketSimulation into chart surfaces",
);
assert.match(
  chartSource,
  /if \(marketSimulation\) \{[\s\S]*simExpected100Y[\s\S]*simExpected250Y[\s\S]*simExpected500Y/,
  "InstitutionalChart must render the V6 multi-horizon simulation fan when simulation is available",
);
assert.match(
  chartSource,
  /simulation: \{[\s\S]*stateLabel:[\s\S]*decisionAction:[\s\S]*coneExpected:/,
  "InstitutionalChart telemetry must publish the V6 simulation block",
);

console.log("PASS market simulation V6 guard: engine, page wiring, renderer fan, and telemetry are present");