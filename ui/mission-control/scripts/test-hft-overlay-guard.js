const fs = require("node:fs");
const path = require("node:path");

function read(relativePath) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function assertIncludes(source, snippet, label) {
  if (!source.includes(snippet)) {
    throw new Error(`Missing ${label}: ${snippet}`);
  }
}

const priceSignalLayer = read("lib/engine/gpu-chart/PriceSignalLayer.ts");
assertIncludes(priceSignalLayer, "export class PriceSignalLayer", "price signal GPU layer");
assertIncludes(priceSignalLayer, 'kind: "execution-expected" | "execution-actual" | "slippage" | "wall" | "vacuum" | "trap" | "flow-sweep" | "flow-absorption" | "flow-exhaustion" | "flow-spoof" | "flow-memory" | "arb-buy" | "arb-sell"', "price signal kinds");
assertIncludes(priceSignalLayer, "signals?: PriceSignalBand[]", "price signal input");

const multiChartManager = read("lib/engine/gpu-chart/MultiChartManager.ts");
assertIncludes(multiChartManager, "PriceSignalLayer", "multi-chart price signal layer wiring");
assertIncludes(multiChartManager, "priceSignalBands?: PriceSignalBand[]", "viewport price signal bands");
assertIncludes(multiChartManager, "this.priceSignalLayer.draw", "price signal draw call");

const gpuSurface = read("app/terminal/GpuChartV4Surface.tsx");
assertIncludes(gpuSurface, "normalizePriceSignalBands", "GPU surface price signal normalization");
assertIncludes(gpuSurface, "primaryPriceSignalBands: gpuPriceSignalBands", "GPU surface price signal viewport injection");

const terminalPage = read("app/terminal/page.tsx");
assertIncludes(terminalPage, "buildExecutionOverlaySnapshot", "execution overlay snapshot builder");
assertIncludes(terminalPage, "buildExecutionSlippageBands", "execution slippage band builder");
assertIncludes(terminalPage, "buildLiquidityPredictionLevels", "liquidity prediction builder");
assertIncludes(terminalPage, "buildFlowSignalBands", "flow signal band builder");
assertIncludes(terminalPage, "buildArbitrageSignalBands", "arbitrage signal band builder");
assertIncludes(terminalPage, "const chartPriceSignalBands = useMemo(() => buildPriceSignalBands", "chart price signal aggregation");
assertIncludes(terminalPage, "priceSignalBands={chartRuntimeOrderflowEnabled ? chartPriceSignalBands : undefined}", "GPU page price signal forwarding");

const terminalV2 = read("app/terminal/TerminalChartV2.tsx");
assertIncludes(terminalV2, "priceSignalBands?: PriceSignalBand[]", "terminal V2 price signal prop");
assertIncludes(terminalV2, "priceSignalBands={priceSignalBands}", "terminal V2 price signal forwarding");

console.log("PASS hft overlay guard: execution overlay, slippage bands, and liquidity prediction levels are wired into the GPU chart stack");