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

const domHistoryBuffer = read("lib/domHistoryBuffer.ts");
assertIncludes(domHistoryBuffer, "export class DomHistoryBuffer", "DOM history buffer class");
assertIncludes(domHistoryBuffer, "push(frame: DomHistoryFrame)", "DOM history push");
assertIncludes(domHistoryBuffer, "snapshot(limit = this.maxFrames)", "DOM history snapshot");

const heatmapHistoryLayer = read("lib/engine/gpu-chart/HeatmapHistoryLayer.ts");
assertIncludes(heatmapHistoryLayer, "export class HeatmapHistoryLayer", "heatmap history GPU layer");
assertIncludes(heatmapHistoryLayer, "mix(dark, tone", "heatmap history tone mix");
assertIncludes(heatmapHistoryLayer, "historyFrames", "heatmap history input");

const tradeBubbleLayer = read("lib/engine/gpu-chart/TradeBubbleLayer.ts");
assertIncludes(tradeBubbleLayer, "export class TradeBubbleLayer", "trade bubble GPU layer");
assertIncludes(tradeBubbleLayer, "kind?: \"trade\" | \"spoof\"", "trade bubble spoof kind");
assertIncludes(tradeBubbleLayer, "vKind > 0.5", "spoof marker shader branch");

const gpuSurface = read("app/terminal/GpuChartV4Surface.tsx");
assertIncludes(gpuSurface, "normalizeDomHistory", "GPU surface DOM history normalization");
assertIncludes(gpuSurface, "normalizeTradeBubbles", "GPU surface trade bubble normalization");
assertIncludes(gpuSurface, "renderCandles: rest.mode !== \"footprint\"", "GPU surface orderflow-only candle suppression");

const multiChartManager = read("lib/engine/gpu-chart/MultiChartManager.ts");
assertIncludes(multiChartManager, "HeatmapHistoryLayer", "multi-chart heatmap history layer");
assertIncludes(multiChartManager, "TradeBubbleLayer", "multi-chart trade bubble layer");
assertIncludes(multiChartManager, "viewport.renderCandles !== false", "multi-chart candle suppression switch");

const terminalPage = read("app/terminal/page.tsx");
assertIncludes(terminalPage, "resolveDeskRenderProfile", "desk render mode resolver");
assertIncludes(terminalPage, "buildReplayDomHistoryFrames", "replay DOM history builder");
assertIncludes(terminalPage, "buildTradeBubbleVisuals", "trade bubble builder");
assertIncludes(terminalPage, "domHistoryBufferRef", "live DOM history buffer ref");
assertIncludes(terminalPage, "renderMode={effectiveChartMode}", "terminal V2 render mode forwarding");
assertIncludes(terminalPage, "chartDomHistoryWithMemoryTrail", "GPU liquidity memory trail history");
assertIncludes(terminalPage, "domHistory={chartRuntimeOrderflowEnabled ? chartDomHistoryWithMemoryTrail : undefined}", "GPU orderflow DOM history forwarding");
assertIncludes(terminalPage, "tradeBubbles={chartRuntimeOrderflowEnabled ? chartTradeBubbles : undefined}", "GPU orderflow trade bubble forwarding");

const terminalV2 = read("app/terminal/TerminalChartV2.tsx");
assertIncludes(terminalV2, "renderMode?: \"line\" | \"candles\" | \"footprint\"", "terminal V2 render mode prop");
assertIncludes(terminalV2, "domHistory={domHistory}", "terminal V2 DOM history forwarding");
assertIncludes(terminalV2, "tradeBubbles={tradeBubbles}", "terminal V2 trade bubble forwarding");

console.log("PASS gpu orderflow desk guard: DOM history buffer, temporal heatmap, trade bubbles, spoof markers, and auto orderflow mode are wired");