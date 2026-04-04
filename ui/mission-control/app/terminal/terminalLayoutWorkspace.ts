import {
  defaultChartSidecarLayoutForPreset,
  normalizeChartSidecarLayout,
} from "./chartSidecarLayout";
import type { ChartSidecarLayoutState } from "./chartSidecarTypes";

export type LayoutPreset = "scalp" | "swing" | "monitoring";
export type DockZone = "micro" | "lower" | "monitoring";
export type DockPanelId = "dom" | "footprint" | "tape" | "heatmap" | "blotter" | "brokers" | "alerts" | "incidents" | "governance" | "readiness" | "risktimeline";
export type FloatingPanelState = { id: DockPanelId; fromZone: DockZone; x: number; y: number; w: number; h: number };

export type TerminalLayoutConfig = {
  preset: LayoutPreset;
  coreSplit: number;
  microOrder: DockPanelId[];
  lowerOrder: DockPanelId[];
  monitoringOrder: DockPanelId[];
  floatingPanels: FloatingPanelState[];
  chartSidecar: ChartSidecarLayoutState;
  chartLink: {
    symbol: boolean;
    timeframe: boolean;
  };
  riskAlert: {
    window: number;
    missThreshold: number;
    refreshSec: 5 | 15 | 30;
    hardAlertEnabled: boolean;
    hardAlertThresholdPct: number;
  };
};

export type TerminalWorkspaceBundle = {
  active: string;
  workspaces: Record<string, TerminalLayoutConfig>;
};

export const TERMINAL_LAYOUT_STORAGE_PREFIX = "txt.terminal.layout.v1";
export const TERMINAL_WORKSPACES_STORAGE_PREFIX = "txt.terminal.workspaces.v1";
export const TERMINAL_CHART_LINK_STORAGE_PREFIX = "txt.terminal.chart-link.v1";
export const TERMINAL_CHART_SIDECAR_STORAGE_PREFIX = "txt.terminal.chart-sidecar.v1";
export const LEGACY_PRIMARY_CHART_LINK_SCOPE = "A";
export const DEFAULT_RISK_ALERT_WINDOW = 10;
export const DEFAULT_RISK_ALERT_MISS_THRESHOLD = 3;
export const DEFAULT_RISK_REFRESH_SEC: 5 | 15 | 30 = 15;
export const DEFAULT_HARD_ALERT_RATIO_PCT = 60;
export const DEFAULT_LAYOUT_WORKSPACE_NAME = "Swing-NY";
export const DEFAULT_LAYOUT_WORKSPACE_OPTIONS = ["Scalp-1", "Swing-NY", "Monitoring-Risk"];

const FLOATING_GRID_SIZE = 16;
const FLOATING_MIN_W = 260;
const FLOATING_MIN_H = 180;
const DEFAULT_CHART_LINK = {
  symbol: true,
  timeframe: true,
};

export const MICRO_PANEL_IDS: DockPanelId[] = ["dom", "footprint", "tape", "heatmap"];
export const LOWER_PANEL_IDS: DockPanelId[] = ["blotter", "brokers"];
export const MONITORING_PANEL_IDS: DockPanelId[] = ["alerts", "incidents", "governance", "readiness", "risktimeline"];
export const ALL_DOCK_PANEL_IDS: DockPanelId[] = [
  "dom",
  "footprint",
  "tape",
  "heatmap",
  "blotter",
  "brokers",
  "alerts",
  "incidents",
  "governance",
  "readiness",
  "risktimeline",
];

export function screenLayoutProfile(width: number): "sm" | "md" | "lg" | "xl" {
  if (width < 900) return "sm";
  if (width < 1300) return "md";
  if (width < 1760) return "lg";
  return "xl";
}

export function buildTerminalLayoutStorageKeys(
  accountId: string,
  layoutWorkspaceName: string,
  layoutScreenProfile: "sm" | "md" | "lg" | "xl",
) {
  const accountKey = accountId || "default";
  const layoutStorageKey = `${TERMINAL_LAYOUT_STORAGE_PREFIX}.${accountKey}`;
  return {
    layoutStorageKey,
    layoutWorkspaceStorageKey: `${TERMINAL_WORKSPACES_STORAGE_PREFIX}.${accountKey}`,
    chartLinkStorageKey: `${TERMINAL_CHART_LINK_STORAGE_PREFIX}.${accountKey}`,
    chartSidecarStorageKey: `${TERMINAL_CHART_SIDECAR_STORAGE_PREFIX}.${accountKey}`,
    legacyChartLinkStorageKey: `${TERMINAL_CHART_LINK_STORAGE_PREFIX}.${accountKey}.${LEGACY_PRIMARY_CHART_LINK_SCOPE}`,
    coreSplitByScreenStorageKey: `${layoutStorageKey}.core-split-by-screen.v1`,
    signalEngineStorageKey: `${layoutStorageKey}.signal-engine.v1.${layoutWorkspaceName}`,
    termCoreAutoSaveId: `txt-terminal-core-split-v2.${accountKey}.${layoutWorkspaceName}.${layoutScreenProfile}`,
  };
}

export function riskAlertDefaultsForPreset(preset: LayoutPreset): TerminalLayoutConfig["riskAlert"] {
  if (preset === "scalp") {
    return { window: 12, missThreshold: 4, refreshSec: DEFAULT_RISK_REFRESH_SEC, hardAlertEnabled: false, hardAlertThresholdPct: DEFAULT_HARD_ALERT_RATIO_PCT };
  }
  if (preset === "monitoring") {
    return { window: 8, missThreshold: 2, refreshSec: DEFAULT_RISK_REFRESH_SEC, hardAlertEnabled: false, hardAlertThresholdPct: DEFAULT_HARD_ALERT_RATIO_PCT };
  }
  return { window: 10, missThreshold: 3, refreshSec: DEFAULT_RISK_REFRESH_SEC, hardAlertEnabled: false, hardAlertThresholdPct: DEFAULT_HARD_ALERT_RATIO_PCT };
}

export function buildLayoutPreset(preset: LayoutPreset, novice: boolean): TerminalLayoutConfig {
  const defaultRiskAlert = riskAlertDefaultsForPreset(preset);
  const defaultChartSidecar = defaultChartSidecarLayoutForPreset(preset);
  if (preset === "scalp") {
    return {
      preset,
      coreSplit: novice ? 70 : 76,
      microOrder: ["dom", "tape", "footprint", "heatmap"],
      lowerOrder: ["blotter", "brokers"],
      monitoringOrder: ["alerts", "governance", "incidents", "readiness", "risktimeline"],
      floatingPanels: [],
      chartSidecar: defaultChartSidecar,
      chartLink: { ...DEFAULT_CHART_LINK },
      riskAlert: defaultRiskAlert,
    };
  }
  if (preset === "monitoring") {
    return {
      preset,
      coreSplit: novice ? 62 : 66,
      microOrder: ["heatmap", "dom", "footprint", "tape"],
      lowerOrder: ["brokers", "blotter"],
      monitoringOrder: ["governance", "incidents", "alerts", "readiness", "risktimeline"],
      floatingPanels: [],
      chartSidecar: defaultChartSidecar,
      chartLink: { ...DEFAULT_CHART_LINK },
      riskAlert: defaultRiskAlert,
    };
  }
  return {
    preset: "swing",
    coreSplit: novice ? 72 : 78,
    microOrder: ["dom", "footprint", "tape", "heatmap"],
    lowerOrder: ["blotter", "brokers"],
    monitoringOrder: ["alerts", "incidents", "governance", "readiness", "risktimeline"],
    floatingPanels: [],
    chartSidecar: defaultChartSidecar,
    chartLink: { ...DEFAULT_CHART_LINK },
    riskAlert: defaultRiskAlert,
  };
}

function normalizeChartLinkConfig(raw: unknown, fallback: TerminalLayoutConfig["chartLink"]): TerminalLayoutConfig["chartLink"] {
  if (!raw || typeof raw !== "object") {
    return fallback;
  }
  const entry = raw as Partial<TerminalLayoutConfig["chartLink"]>;
  return {
    symbol: typeof entry.symbol === "boolean" ? entry.symbol : fallback.symbol,
    timeframe: typeof entry.timeframe === "boolean" ? entry.timeframe : fallback.timeframe,
  };
}

export function reorderIds(ids: DockPanelId[], sourceId: DockPanelId, targetId: DockPanelId): DockPanelId[] {
  if (sourceId === targetId) {
    return ids;
  }
  const sourceIndex = ids.indexOf(sourceId);
  const targetIndex = ids.indexOf(targetId);
  if (sourceIndex < 0 || targetIndex < 0) {
    return ids;
  }
  const next = [...ids];
  const [moved] = next.splice(sourceIndex, 1);
  next.splice(targetIndex, 0, moved);
  return next;
}

export function orderMap(ids: DockPanelId[]): Record<string, number> {
  return ids.reduce<Record<string, number>>((acc, id, index) => {
    acc[id] = index;
    return acc;
  }, {});
}

function snapFloatingValue(value: number): number {
  return Math.round(value / FLOATING_GRID_SIZE) * FLOATING_GRID_SIZE;
}

export function clampFloatingPanel(panel: FloatingPanelState): FloatingPanelState {
  if (typeof window === "undefined") {
    return {
      ...panel,
      x: snapFloatingValue(Math.max(0, panel.x)),
      y: snapFloatingValue(Math.max(0, panel.y)),
      w: snapFloatingValue(Math.max(FLOATING_MIN_W, panel.w)),
      h: snapFloatingValue(Math.max(FLOATING_MIN_H, panel.h)),
    };
  }
  const maxW = Math.max(FLOATING_MIN_W, window.innerWidth - 32);
  const maxH = Math.max(FLOATING_MIN_H, window.innerHeight - 48);
  const nextW = Math.min(maxW, Math.max(FLOATING_MIN_W, panel.w));
  const nextH = Math.min(maxH, Math.max(FLOATING_MIN_H, panel.h));
  const maxX = Math.max(0, window.innerWidth - nextW - 16);
  const maxY = Math.max(0, window.innerHeight - nextH - 16);
  return {
    ...panel,
    x: snapFloatingValue(Math.min(maxX, Math.max(0, panel.x))),
    y: snapFloatingValue(Math.min(maxY, Math.max(0, panel.y))),
    w: snapFloatingValue(nextW),
    h: snapFloatingValue(nextH),
  };
}

function normalizeFloatingPanels(input: unknown): FloatingPanelState[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const used = new Set<DockPanelId>();
  const next: FloatingPanelState[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const entry = raw as Partial<FloatingPanelState>;
    const id = entry.id as DockPanelId | undefined;
    const fromZone = entry.fromZone as DockZone | undefined;
    if (!id || used.has(id) || !ALL_DOCK_PANEL_IDS.includes(id)) {
      continue;
    }
    if (fromZone !== "micro" && fromZone !== "lower" && fromZone !== "monitoring") {
      continue;
    }
    used.add(id);
    next.push(clampFloatingPanel({
      id,
      fromZone,
      x: Number.isFinite(entry.x) ? Number(entry.x) : 128,
      y: Number.isFinite(entry.y) ? Number(entry.y) : 96,
      w: Number.isFinite(entry.w) ? Number(entry.w) : 368,
      h: Number.isFinite(entry.h) ? Number(entry.h) : 320,
    }));
  }
  return next;
}

export function normalizeDockLayout(parsed: Partial<TerminalLayoutConfig>, fallback: TerminalLayoutConfig): TerminalLayoutConfig {
  const used = new Set<DockPanelId>();
  const floatingPanels = normalizeFloatingPanels(parsed.floatingPanels);
  for (const panel of floatingPanels) {
    used.add(panel.id);
  }
  const pickZone = (input: unknown, fallbackZone: DockPanelId[]): DockPanelId[] => {
    const source = Array.isArray(input) ? input : fallbackZone;
    const next: DockPanelId[] = [];
    for (const raw of source) {
      const id = raw as DockPanelId;
      if (!ALL_DOCK_PANEL_IDS.includes(id)) {
        continue;
      }
      if (used.has(id)) {
        continue;
      }
      used.add(id);
      next.push(id);
    }
    return next;
  };

  const microOrder = pickZone(parsed.microOrder, fallback.microOrder);
  const lowerOrder = pickZone(parsed.lowerOrder, fallback.lowerOrder);
  const monitoringOrder = pickZone(parsed.monitoringOrder, fallback.monitoringOrder);

  for (const panelId of ALL_DOCK_PANEL_IDS) {
    if (used.has(panelId)) {
      continue;
    }
    if (microOrder.length <= lowerOrder.length && microOrder.length <= monitoringOrder.length) {
      microOrder.push(panelId);
    } else if (lowerOrder.length <= monitoringOrder.length) {
      lowerOrder.push(panelId);
    } else {
      monitoringOrder.push(panelId);
    }
  }

  const resolvedPreset: LayoutPreset = parsed.preset === "scalp" || parsed.preset === "monitoring"
    ? parsed.preset
    : (parsed.preset === "swing" ? "swing" : fallback.preset);
  const riskDefaults = riskAlertDefaultsForPreset(resolvedPreset);
  const riskWindow = Number.isFinite(parsed.riskAlert?.window)
    ? Math.max(3, Math.min(100, Number(parsed.riskAlert?.window)))
    : riskDefaults.window;
  const riskThresholdRaw = Number.isFinite(parsed.riskAlert?.missThreshold)
    ? Math.max(1, Math.min(100, Number(parsed.riskAlert?.missThreshold)))
    : riskDefaults.missThreshold;
  const refreshRaw = Number(parsed.riskAlert?.refreshSec);
  const riskRefreshSec: 5 | 15 | 30 = refreshRaw === 5 || refreshRaw === 30 ? refreshRaw : 15;
  const riskHardAlertEnabled = typeof parsed.riskAlert?.hardAlertEnabled === "boolean"
    ? parsed.riskAlert.hardAlertEnabled
    : riskDefaults.hardAlertEnabled;
  const riskHardAlertThresholdPct = Number.isFinite(parsed.riskAlert?.hardAlertThresholdPct)
    ? Math.max(20, Math.min(95, Number(parsed.riskAlert?.hardAlertThresholdPct)))
    : riskDefaults.hardAlertThresholdPct;

  return {
    preset: parsed.preset === "scalp" || parsed.preset === "monitoring" ? parsed.preset : fallback.preset,
    coreSplit: Number.isFinite(parsed.coreSplit) ? Math.max(52, Math.min(85, Number(parsed.coreSplit))) : fallback.coreSplit,
    microOrder,
    lowerOrder,
    monitoringOrder,
    floatingPanels,
    chartSidecar: normalizeChartSidecarLayout(parsed.chartSidecar, fallback.chartSidecar),
    chartLink: normalizeChartLinkConfig(parsed.chartLink, fallback.chartLink),
    riskAlert: {
      window: riskWindow,
      missThreshold: Math.min(riskWindow, riskThresholdRaw),
      refreshSec: riskRefreshSec,
      hardAlertEnabled: riskHardAlertEnabled,
      hardAlertThresholdPct: riskHardAlertThresholdPct,
    },
  };
}

export function readTerminalWorkspaceBundle(storageKey: string): TerminalWorkspaceBundle | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as TerminalWorkspaceBundle;
  } catch {
    return null;
  }
}

export function mergeFloatingPresetsIntoWorkspaceBundle(
  workspacePayloadRaw: unknown,
  floatingPayload: unknown,
): TerminalWorkspaceBundle | null {
  if (!workspacePayloadRaw || typeof workspacePayloadRaw !== "object") {
    return null;
  }
  const source = workspacePayloadRaw as { active?: string; workspaces?: Record<string, { floatingPanels?: unknown[] }> };
  if (!source.workspaces || typeof source.workspaces !== "object") {
    return null;
  }
  const floatingByWorkspace = floatingPayload && typeof floatingPayload === "object"
    ? (floatingPayload as Record<string, unknown[]>)
    : {};
  const mergedWorkspaces = Object.entries(source.workspaces).reduce<Record<string, TerminalLayoutConfig>>((acc, [name, layout]) => {
    const floatingPanels = Array.isArray(layout?.floatingPanels) && layout.floatingPanels.length > 0
      ? normalizeFloatingPanels(layout.floatingPanels)
      : normalizeFloatingPanels(floatingByWorkspace[name]);
    acc[name] = {
      ...(layout as TerminalLayoutConfig),
      floatingPanels,
    };
    return acc;
  }, {});
  return {
    active: typeof source.active === "string" ? source.active : DEFAULT_LAYOUT_WORKSPACE_NAME,
    workspaces: mergedWorkspaces,
  };
}

export function buildLayoutExportPayload(
  accountId: string,
  activeWorkspace: string,
  currentLayout: TerminalLayoutConfig,
  workspaceStorageKey: string,
) {
  return {
    exportedAt: new Date().toISOString(),
    activeWorkspace,
    currentLayout,
    workspaceStorageKey,
    accountId: accountId || "default",
  };
}

export function parseImportedTerminalLayouts(
  text: string,
  fallback: TerminalLayoutConfig,
):
  | { kind: "workspaces"; active: string; names: string[]; bundle: TerminalWorkspaceBundle }
  | { kind: "layout"; layout: TerminalLayoutConfig } {
  const parsed = JSON.parse(text) as {
    activeWorkspace?: string;
    currentLayout?: Partial<TerminalLayoutConfig>;
    workspaces?: Record<string, Partial<TerminalLayoutConfig>>;
  };

  if (parsed.workspaces && Object.keys(parsed.workspaces).length > 0) {
    const normalizedWorkspaces = Object.entries(parsed.workspaces).reduce<Record<string, TerminalLayoutConfig>>((acc, [name, layout]) => {
      if (!name.trim()) {
        return acc;
      }
      acc[name] = normalizeDockLayout(layout, fallback);
      return acc;
    }, {});
    const names = Object.keys(normalizedWorkspaces);
    const active = parsed.activeWorkspace && names.includes(parsed.activeWorkspace) ? parsed.activeWorkspace : names[0];
    return {
      kind: "workspaces",
      active,
      names,
      bundle: {
        active,
        workspaces: normalizedWorkspaces,
      },
    };
  }

  return {
    kind: "layout",
    layout: normalizeDockLayout(parsed.currentLayout || {}, fallback),
  };
}