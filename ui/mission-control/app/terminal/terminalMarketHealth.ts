type JsonMap = Record<string, unknown>;

export type FreshnessState = "fresh" | "stale" | "degraded" | "hard-fail";
export type HealthTone = "good" | "warn" | "bad";

export type MarketFlowAlert = {
  label: "bars" | "depth" | "trades";
  state: FreshnessState;
  age: string;
};

export type TerminalMarketHealthSnapshot = {
  marketBusHealth: JsonMap | null;
  marketBusHealthComponents: JsonMap | null;
  marketBusSequencing: JsonMap | null;
  marketBusOhlcvHealth: JsonMap | null;
  marketBusDepthHealth: JsonMap | null;
  marketBusTradesHealth: JsonMap | null;
  marketBusHealthStatus: string;
  marketBusHealthTone: HealthTone;
  marketBusOhlcvLatestSeq: number;
  marketBusDepthUpdateId: number;
  marketBusOhlcvContiguous: boolean;
  marketBusSyncLabel: string;
  ohlcvFreshnessState: FreshnessState;
  depthFreshnessState: FreshnessState;
  tradesFreshnessState: FreshnessState;
  publicChartHardFailOnlyAlerts: boolean;
  marketFlowAlerts: MarketFlowAlert[];
  chartOverlayCompactMode: boolean;
  chartUltraCleanCandles: boolean;
  publicHostAutoCleanCandles: boolean;
  chartFlowAlertText: string;
  chartCompactAlertLabel: string;
};

function toNumber(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function formatClock(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return `${String(parsed.getHours()).padStart(2, "0")}:${String(parsed.getMinutes()).padStart(2, "0")}:${String(parsed.getSeconds()).padStart(2, "0")}`;
}

export function formatFreshness(value: unknown): string {
  const freshnessMs = Number(value);
  if (!Number.isFinite(freshnessMs) || freshnessMs < 0) {
    return "n/a";
  }
  if (freshnessMs <= 1000) {
    return `${Math.round(freshnessMs)}ms`;
  }
  if (freshnessMs <= 60_000) {
    return `${Math.round(freshnessMs / 1000)}s`;
  }
  if (freshnessMs <= 3_600_000) {
    return `${Math.round(freshnessMs / 60_000)}m`;
  }
  return `${Math.round(freshnessMs / 3_600_000)}h`;
}

export function streamStateTone(state: string): HealthTone {
  if (state === "live") {
    return "good";
  }
  if (state === "connecting") {
    return "warn";
  }
  return "bad";
}

export function classifyFreshnessState(value: unknown): FreshnessState {
  const freshnessMs = Number(value);
  if (!Number.isFinite(freshnessMs) || freshnessMs < 0) {
    return "hard-fail";
  }
  if (freshnessMs <= 15_000) {
    return "fresh";
  }
  if (freshnessMs <= 60_000) {
    return "stale";
  }
  if (freshnessMs <= 180_000) {
    return "degraded";
  }
  return "hard-fail";
}

export function classifyFreshnessTone(state: FreshnessState): HealthTone {
  if (state === "fresh") {
    return "good";
  }
  if (state === "stale") {
    return "warn";
  }
  return "bad";
}

export function deriveTerminalMarketHealth(input: {
  marketBusMeta: JsonMap | null;
  marketBusLastSyncAt: string | null;
  chartMode: "line" | "candles" | "footprint";
  chartVisualMode: "auto" | "clean" | "full";
  publicBrowserHost: boolean;
}): TerminalMarketHealthSnapshot {
  const { marketBusMeta, marketBusLastSyncAt, chartMode, chartVisualMode, publicBrowserHost } = input;
  const marketBusHealth = (marketBusMeta?.health as JsonMap | undefined) || null;
  const marketBusHealthComponents = (marketBusHealth?.components as JsonMap | undefined) || null;
  const marketBusSequencing = (marketBusMeta?.sequencing as JsonMap | undefined) || null;
  const marketBusOhlcvHealth = (marketBusHealthComponents?.ohlcv as JsonMap | undefined) || null;
  const marketBusDepthHealth = (marketBusHealthComponents?.depth as JsonMap | undefined) || null;
  const marketBusTradesHealth = (marketBusHealthComponents?.trades as JsonMap | undefined) || null;
  const marketBusHealthStatus = String(marketBusHealth?.status || "offline");
  const marketBusHealthTone = marketBusHealthStatus === "ok" ? "good" : marketBusHealthStatus === "degraded" ? "warn" : "bad";
  const marketBusOhlcvSequence = (marketBusSequencing?.ohlcv as JsonMap | undefined) || null;
  const marketBusDepthSequence = (marketBusSequencing?.depth as JsonMap | undefined) || null;
  const marketBusOhlcvLatestSeq = toNumber(marketBusOhlcvSequence?.latest_seq, 0);
  const marketBusDepthUpdateId = toNumber(marketBusDepthSequence?.last_update_id, 0);
  const marketBusOhlcvContiguous = Boolean(marketBusOhlcvSequence?.contiguous);
  const marketBusSyncLabel = marketBusLastSyncAt ? formatClock(marketBusLastSyncAt) : "--:--:--";
  const ohlcvFreshnessState = classifyFreshnessState(marketBusOhlcvHealth?.freshness_ms);
  const depthFreshnessState = classifyFreshnessState(marketBusDepthHealth?.freshness_ms);
  const tradesFreshnessState = classifyFreshnessState(marketBusTradesHealth?.freshness_ms);
  const publicChartHardFailOnlyAlerts = publicBrowserHost && chartMode === "candles";
  const marketFlowCandidates: MarketFlowAlert[] = [
    { label: "bars", state: ohlcvFreshnessState, age: formatFreshness(marketBusOhlcvHealth?.freshness_ms) },
    { label: "depth", state: depthFreshnessState, age: formatFreshness(marketBusDepthHealth?.freshness_ms) },
    { label: "trades", state: tradesFreshnessState, age: formatFreshness(marketBusTradesHealth?.freshness_ms) },
  ];
  const marketFlowAlerts = marketFlowCandidates.filter((item) => (publicChartHardFailOnlyAlerts ? item.state === "hard-fail" : item.state === "degraded" || item.state === "hard-fail"));
  const chartOverlayCompactMode = chartMode === "candles" && chartVisualMode !== "full";
  const chartUltraCleanCandles = chartMode === "candles" && chartVisualMode === "clean";
  const publicHostAutoCleanCandles = publicBrowserHost && chartMode === "candles" && chartVisualMode === "auto";
  const chartFlowAlertText = marketFlowAlerts.map((item) => `${item.label}:${item.state}@${item.age}`).join(" · ");
  const chartCompactAlertLabel = marketFlowAlerts.length > 0
    ? `MD ${marketFlowAlerts.length} ALERT${marketFlowAlerts.length > 1 ? "S" : ""}`
    : "MD OK";

  return {
    marketBusHealth,
    marketBusHealthComponents,
    marketBusSequencing,
    marketBusOhlcvHealth,
    marketBusDepthHealth,
    marketBusTradesHealth,
    marketBusHealthStatus,
    marketBusHealthTone,
    marketBusOhlcvLatestSeq,
    marketBusDepthUpdateId,
    marketBusOhlcvContiguous,
    marketBusSyncLabel,
    ohlcvFreshnessState,
    depthFreshnessState,
    tradesFreshnessState,
    publicChartHardFailOnlyAlerts,
    marketFlowAlerts,
    chartOverlayCompactMode,
    chartUltraCleanCandles,
    publicHostAutoCleanCandles,
    chartFlowAlertText,
    chartCompactAlertLabel,
  };
}