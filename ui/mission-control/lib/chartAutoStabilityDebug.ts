type AutoTargetBandSnapshot = {
  okFloorSec: number;
  warnFloorSec: number;
  targetSec: number;
};

type PerfThresholdsSnapshot = {
  busyFrameMs: number;
  busyMinFps: number;
  busyCpuLoad: number;
  criticalFrameMs: number;
  criticalMinFps: number;
  criticalCpuLoad: number;
  domLevelsBusy: number;
  domLevelsNormal: number;
  heatmapBandsBusy: number;
  heatmapBandsNormal: number;
};

type PerfRuntimeSnapshot = {
  fps: number;
  frameTimeMs: number;
  cpuLoad: number;
  budgetUsedPct: number;
  lodLevel: "micro" | "compact" | "normal" | "expanded";
  overlayCount: number;
  activeIndicatorCount: number;
  updateCounts: {
    candle: number;
    indicator: number;
    overlay: number;
  };
  workerLatencyMs: number | null;
};

export type ChartAutoStabilitySnapshot = {
  key: string;
  symbol: string;
  timeframe: string;
  instrumentClass: "btc" | "eth" | "index" | "default";
  resolvedMotionPreset: "scalping" | "swing";
  switches5m: number;
  switches1h: number;
  avgIntervalSec: number | null;
  lastSwitchAgoSec: number | null;
  targetBand: AutoTargetBandSnapshot;
  perfThresholds: PerfThresholdsSnapshot;
  perfRuntime: PerfRuntimeSnapshot;
  sparklineBuckets: number[];
  updatedAt: string;
};

type ChartAutoStabilityStore = {
  snapshots: Map<string, ChartAutoStabilitySnapshot>;
};

const STORE_KEY = "__gtixChartAutoStabilityStore";

function getStore(): ChartAutoStabilityStore {
  const globalState = globalThis as typeof globalThis & { [STORE_KEY]?: ChartAutoStabilityStore };
  if (!globalState[STORE_KEY]) {
    globalState[STORE_KEY] = { snapshots: new Map<string, ChartAutoStabilitySnapshot>() };
  }
  return globalState[STORE_KEY] as ChartAutoStabilityStore;
}

export function upsertChartAutoStabilitySnapshot(snapshot: ChartAutoStabilitySnapshot): void {
  const store = getStore();
  store.snapshots.set(snapshot.key, snapshot);

  const entries = Array.from(store.snapshots.entries())
    .sort((a, b) => Date.parse(b[1].updatedAt) - Date.parse(a[1].updatedAt));
  if (entries.length > 64) {
    for (const [key] of entries.slice(64)) {
      store.snapshots.delete(key);
    }
  }
}

export function getChartAutoStabilitySnapshots(): ChartAutoStabilitySnapshot[] {
  const store = getStore();
  return Array.from(store.snapshots.values())
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}