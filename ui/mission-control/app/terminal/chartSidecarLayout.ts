import type {
  ChartSidecarFloatingDefault,
  ChartSidecarId,
  ChartSidecarLayoutMode,
  ChartSidecarLayoutState,
  ChartSidecarProfile,
  ChartSidecarProfileLayout,
  DetachedChartSidecarState,
} from "./chartSidecarTypes";

const CHART_SIDECAR_FLOATING_GRID_SIZE = 16;

export const CHART_SIDECAR_PROFILE_LAYOUTS: Record<ChartSidecarProfile, ChartSidecarProfileLayout> = {
  scalping: { label: "Scalping", cards: ["execution", "localFeed", "forensic", "domTape", "footprintHeat", "policy"] },
  intraday: { label: "Intraday", cards: ["execution", "localFeed", "forensic", "domTape", "footprintHeat", "policy"] },
  swing: { label: "Swing", cards: ["execution", "localFeed", "forensic", "footprintHeat", "policy"] },
};

export const CHART_SIDECAR_FLOATING_DEFAULTS: Record<ChartSidecarId, ChartSidecarFloatingDefault> = {
  execution: { w: 328, h: 332 },
  localFeed: { w: 320, h: 336 },
  forensic: { w: 352, h: 388 },
  policy: { w: 288, h: 276 },
  domTape: { w: 296, h: 360 },
  footprintHeat: { w: 304, h: 344 },
};

function snapChartSidecarValue(value: number): number {
  return Math.round(value / CHART_SIDECAR_FLOATING_GRID_SIZE) * CHART_SIDECAR_FLOATING_GRID_SIZE;
}

export function defaultChartSidecarLayoutForPreset(preset: "scalp" | "swing" | "monitoring"): ChartSidecarLayoutState {
  const profile: ChartSidecarProfile = preset === "scalp"
    ? "scalping"
    : preset === "monitoring"
      ? "intraday"
      : "swing";
  return {
    profile,
    detached: [],
    previewOpen: false,
  };
}

export function sidecarHybridIdsForProfile(profile: ChartSidecarProfile): ChartSidecarId[] {
  if (profile === "swing") {
    return ["execution", "localFeed"];
  }
  if (profile === "scalping") {
    return ["execution", "localFeed"];
  }
  return ["execution", "localFeed"];
}

export function clampDetachedChartSidecar(panel: DetachedChartSidecarState): DetachedChartSidecarState {
  const defaults = CHART_SIDECAR_FLOATING_DEFAULTS[panel.id];
  const minW = Math.max(240, defaults.w - 40);
  const minH = Math.max(220, defaults.h - 40);
  if (typeof window === "undefined") {
    return {
      ...panel,
      x: snapChartSidecarValue(Math.max(0, panel.x)),
      y: snapChartSidecarValue(Math.max(0, panel.y)),
      w: snapChartSidecarValue(Math.max(minW, panel.w)),
      h: snapChartSidecarValue(Math.max(minH, panel.h)),
    };
  }
  const maxW = Math.max(minW, window.innerWidth - 32);
  const maxH = Math.max(minH, window.innerHeight - 48);
  const nextW = Math.min(maxW, Math.max(minW, panel.w));
  const nextH = Math.min(maxH, Math.max(minH, panel.h));
  const maxX = Math.max(0, window.innerWidth - nextW - 16);
  const maxY = Math.max(0, window.innerHeight - nextH - 16);
  return {
    ...panel,
    x: snapChartSidecarValue(Math.min(maxX, Math.max(0, panel.x))),
    y: snapChartSidecarValue(Math.min(maxY, Math.max(0, panel.y))),
    w: snapChartSidecarValue(nextW),
    h: snapChartSidecarValue(nextH),
  };
}

function normalizeDetachedChartSidecars(input: unknown, allowedIds: Set<ChartSidecarId>): DetachedChartSidecarState[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const used = new Set<ChartSidecarId>();
  const next: DetachedChartSidecarState[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const entry = raw as Partial<DetachedChartSidecarState>;
    const id = entry.id as ChartSidecarId | undefined;
    if (!id || used.has(id) || !allowedIds.has(id)) {
      continue;
    }
    used.add(id);
    const defaults = CHART_SIDECAR_FLOATING_DEFAULTS[id];
    next.push(clampDetachedChartSidecar({
      id,
      x: Number.isFinite(entry.x) ? Number(entry.x) : 128,
      y: Number.isFinite(entry.y) ? Number(entry.y) : 96,
      w: Number.isFinite(entry.w) ? Number(entry.w) : defaults.w,
      h: Number.isFinite(entry.h) ? Number(entry.h) : defaults.h,
    }));
  }
  return next;
}

export function normalizeChartSidecarLayout(raw: unknown, fallback: ChartSidecarLayoutState): ChartSidecarLayoutState {
  if (!raw || typeof raw !== "object") {
    return fallback;
  }
  const entry = raw as Partial<ChartSidecarLayoutState>;
  const profile = entry.profile === "scalping" || entry.profile === "intraday" || entry.profile === "swing"
    ? entry.profile
    : fallback.profile;
  const allowedIds = new Set(CHART_SIDECAR_PROFILE_LAYOUTS[profile].cards);
  return {
    profile,
    detached: normalizeDetachedChartSidecars(entry.detached, allowedIds),
    previewOpen: typeof entry.previewOpen === "boolean" ? entry.previewOpen : fallback.previewOpen,
  };
}

export function buildDetachedChartSidecarLayout(profile: ChartSidecarProfile, mode: Exclude<ChartSidecarLayoutMode, "custom">): DetachedChartSidecarState[] {
  if (mode === "docked") {
    return [];
  }
  const cards = mode === "hybrid"
    ? sidecarHybridIdsForProfile(profile)
    : CHART_SIDECAR_PROFILE_LAYOUTS[profile].cards;
  if (cards.length === 0) {
    return [];
  }
  const viewportWidth = typeof window === "undefined" ? 1440 : window.innerWidth;
  const columnCount = mode === "hybrid" || cards.length <= 2 ? 1 : 2;
  const columnGap = 16;
  const rowGap = 14;
  const maxCardWidth = Math.max(...cards.map((id) => CHART_SIDECAR_FLOATING_DEFAULTS[id].w));
  const totalWidth = (columnCount * maxCardWidth) + ((columnCount - 1) * columnGap);
  const baseX = Math.max(16, viewportWidth - totalWidth - 24);
  const baseY = 96;
  const columnHeights = Array.from({ length: columnCount }, () => baseY);

  return cards.map((id) => {
    const defaults = CHART_SIDECAR_FLOATING_DEFAULTS[id];
    const columnIndex = columnCount === 1 ? 0 : (columnHeights[0] <= columnHeights[1] ? 0 : 1);
    const panel = clampDetachedChartSidecar({
      id,
      x: baseX + columnIndex * (maxCardWidth + columnGap),
      y: columnHeights[columnIndex],
      w: defaults.w,
      h: defaults.h,
    });
    columnHeights[columnIndex] = panel.y + panel.h + rowGap;
    return panel;
  });
}

export function inferChartSidecarLayoutMode(profile: ChartSidecarProfile, detached: DetachedChartSidecarState[]): ChartSidecarLayoutMode {
  if (detached.length === 0) {
    return "docked";
  }
  const detachedIds = detached.map((panel) => panel.id).sort().join("|");
  const hybridIds = sidecarHybridIdsForProfile(profile).sort().join("|");
  const allIds = [...CHART_SIDECAR_PROFILE_LAYOUTS[profile].cards].sort().join("|");
  if (hybridIds && detachedIds === hybridIds) {
    return "hybrid";
  }
  if (allIds && detachedIds === allIds) {
    return "detached";
  }
  return "custom";
}