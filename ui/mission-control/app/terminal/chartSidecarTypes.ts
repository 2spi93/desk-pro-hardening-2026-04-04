export const CHART_SIDECAR_IDS = ["execution", "localFeed", "forensic", "policy", "domTape", "footprintHeat"] as const;
export const CHART_SIDECAR_PROFILE_IDS = ["scalping", "intraday", "swing"] as const;

export type ChartSidecarId = typeof CHART_SIDECAR_IDS[number];
export type ChartSidecarProfile = typeof CHART_SIDECAR_PROFILE_IDS[number];
export type ChartSidecarLayoutMode = "docked" | "hybrid" | "detached" | "custom";
export type ChartSidecarDepthBias = "bid" | "ask" | "balanced";
export type ChartSidecarLayoutState = {
  profile: ChartSidecarProfile;
  detached: DetachedChartSidecarState[];
  previewOpen: boolean;
};
export type ChartSidecarProfileLayout = { label: string; cards: ChartSidecarId[] };
export type ChartSidecarFloatingDefault = { w: number; h: number };

export type DetachedChartSidecarState = {
  id: ChartSidecarId;
  x: number;
  y: number;
  w: number;
  h: number;
};