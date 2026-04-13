export type ChartOverlayZoneKind = "fvg" | "ob" | "structure";

export type ChartOverlayZone = {
  kind: ChartOverlayZoneKind;
  label: string;
  x1: number;
  x2: number;
  low: number;
  high: number;
  tone: string;
};

export type ChartLiquidityZoneKind = "equal-highs" | "equal-lows" | "sweep" | "resting-liquidity";

export type ChartLiquidityZone = {
  level: number;
  label: string;
  kind?: ChartLiquidityZoneKind;
  strength?: number;
  tone?: "good" | "warn" | "subtle";
};