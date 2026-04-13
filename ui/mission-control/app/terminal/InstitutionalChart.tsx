"use client";

import { CSSProperties, PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AreaSeriesPartialOptions,
  CandlestickSeriesPartialOptions,
  ColorType,
  CrosshairMode,
  IChartApi,
  IPriceLine,
  ISeriesApi,
  LineSeriesPartialOptions,
  MouseEventParams,
  Time,
  UTCTimestamp,
  createChart,
} from "lightweight-charts";

import { createDirtyState } from "../../lib/dirtyFlags";
import { createInteractionEngine } from "../../lib/chartInteraction";
import { applyDynamicLod } from "../../lib/lodEngine";
import { timeframeToMs } from "../../lib/ohlcvDataEngine";
import { RenderScheduler } from "../../lib/renderScheduler";
import { getDensityLevel, getDensityConfig, type DensityLevel } from "../../lib/densityEngine";
import type { IndicatorSeriesData } from "../../lib/indicators/engine";
import { heikinAshi, volumeProfile } from "../../lib/indicators/transforms";
import { subscribeChartFrame, type LiveChartFrame, type LiveChartFrameMeta } from "../../lib/chartFrameFeed";
import {
  type ChartPerceptualTelemetry,
  type PerceptualAutoscaleSnapshot,
  type PerceptualSpacingPolicy,
  type ResolvePerceptualAutoscaleOptions,
  type PerceptualTransitionMode,
  quantizePerceptualBarSpacing,
  resolvePerceptualAutoscaleRange,
  resolvePerceptualTimeScaleOptions,
} from "./chartPerceptual";
import {
  computePerceptualCandle,
  computePerceptualWickWidth,
  resolvePerceptualDeskMode,
  type PerceptualCandleFlowState,
  type PerceptualExecutionSignal,
  type PerceptualHeatSegment,
} from "./chartPerceptualEngine";
import type { MarketSimulation } from "./marketSimulationEngine";
import { applyPerceptionPipeline, resolvePerceptionDensity, shouldConflatePerceptualUpdate, type PerceptionVisualMetadata } from "./perceptionEngine";
import { createLatestFrameScheduler } from "./frameEngine";
import { applyVisualProfile, DEFAULT_VISUAL_PROFILE, mixColors, withAlpha, type VisualProfile, type VisualProfileName } from "./visualProfiles";
import type { ChartLiquidityZone as LiquidityZone, ChartOverlayZone as OverlayZone } from "./chartOverlayTypes";
import type { PriceSignalBand } from "../../lib/engine/gpu-chart/PriceSignalLayer";

type CandlePoint = { label: string; open: number; high: number; low: number; close: number; volume: number };
type ChartMotionPreset = "stable" | "balanced" | "aggressive" | "scalping" | "swing" | "auto";
type ChartVisualMode = "auto" | "clean" | "full";

type Props = {
  className?: string;
  symbol: string;
  timeframe: string;
  visualProfile?: VisualProfileName;
  mode: "line" | "candles" | "footprint";
  interactionMode?: "full" | "lite";
  frozen?: boolean;
  chartMotionPreset?: ChartMotionPreset;
  visualMode?: ChartVisualMode;
  liveFeedKey?: string;
  candles: CandlePoint[];
  overlayZones: OverlayZone[];
  liquidityZones: LiquidityZone[];
  domLevels?: Array<{ side: "bid" | "ask"; price: number; size: number; intensity: number }>;
  heatmapLevels?: Array<{ side: "bid" | "ask"; price: number; size: number; intensity: number }>;
  domHistory?: Array<{ time: number; levels: Array<{ side: "bid" | "ask"; price: number; size: number; intensity: number }>; spoofingRisk?: number }>;
  tradeBubbles?: Array<{ time: number; price: number; volume: number; side: "buy" | "sell"; intensity?: number; kind?: "trade" | "spoof" }>;
  priceSignalBands?: PriceSignalBand[];
  dayVwap: number;
  weekVwap: number;
  monthVwap: number;
  showSessions?: boolean;
  /** Pre-computed indicator series from computeAllIndicators().  Overlay (pane="main") only rendered here. */
  indicatorSeries?: IndicatorSeriesData[];
  /** Optional compact footprint rows from terminal context (buy/sell delta by price slice). */
  footprintRows?: Array<{ low: number; high: number; buyVolume: number; sellVolume: number; delta: number; timeLabel?: string; timeKey?: string }>;
  executionSignals?: PerceptualExecutionSignal[];
  marketSimulation?: MarketSimulation | null;
  /** Apply a candle transform — "heikin-ashi" transforms OHLCV data before rendering. */
  candleTransform?: "none" | "heikin-ashi";
  onCrosshairMove?: (payload: { price: number; timeLabel: string; timeKey: string } | null) => void;
  onPerformanceTelemetry?: (payload: { fps: number; frameTimeMs: number; cpuLoad: number; workerLatencyMs: number | null }) => void;
  onPerceptualTelemetry?: (payload: ChartPerceptualTelemetry) => void;
};

type OverlayBadge = {
  key: string;
  left: number;
  top: number;
  text: string;
  tone: string;
  kind: "zone" | "liquidity";
  detail: string;
  price: number;
};

type CursorState = {
  visible: boolean;
  left: number;
  top: number;
  priceTop: number;
  timeLeft: number;
  price: string;
  time: string;
};

type ActiveCandleOverlay = {
  left: number;
  width: number;
  source: "crosshair" | "live";
};

type LivePulseState = {
  left: number;
  top: number;
  priceLabel: string;
  tick: number;
};

type LivePulseMeta = {
  left: number;
  top: number;
  updatedAt: number;
  lastPulseAt: number;
};

type FormingCandleState = {
  left: number;
  width: number;
  openY: number;
  closeY: number;
  highY: number;
  lowY: number;
  opacity: number;
  wickOpacity: number;
  radiusPx: number;
  direction: "up" | "down" | "flat";
};

type DynamicCandlePresentation = {
  preferredBodyWidthPx: number;
  formingWidthPx: number;
  overlayWidthPx: number;
  wickWidthPx: number;
  bodyRadiusPx: number;
  baseBodyWidthPx: number;
  timeframeWeight: number;
  densityFactor: number;
  volatilityFactor: number;
  zoomFactor: number;
  minBodyWidthPx: number;
  maxBodyWidthPx: number;
  bodyToSpacingRatio: number;
  bodyOpacity: number;
  wickOpacity: number;
  borderOpacity: number;
  lastBrightness: number;
};

type InertiaState = {
  driftX: number;
  driftY: number;
};

type ChartFeelState = {
  inertiaOpacity: number;
  inertiaScale: number;
};

type OverlayOffset = {
  x: number;
  y: number;
};

type DragState = {
  key: string;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
};

type CandleRenderPoint = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  timeKey?: string;
  color?: string;
  borderColor?: string;
  wickColor?: string;
  wickType?: PerceptionVisualMetadata["wickType"];
  emphasis?: number;
  styleKey?: string;
  flow?: PerceptualCandleFlowState;
};

type CandleSeriesPoint = {
  time: number | UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
  timeKey?: string;
  color?: string;
  borderColor?: string;
  wickColor?: string;
  wickType?: PerceptionVisualMetadata["wickType"];
  emphasis?: number;
  styleKey?: string;
  flow?: PerceptualCandleFlowState;
};

type GhostWickState = {
  time: number;
  high: number;
  low: number;
  color: string;
  createdAt: number;
  expiresAt: number;
};

type PerceptualRenderInput = CandleRenderPoint & {
  volume?: number;
};

function isFiniteCandleRenderPoint(point: CandleRenderPoint | null | undefined): point is CandleRenderPoint {
  return Boolean(
    point
    && Number.isFinite(point.time)
    && Number.isFinite(point.open)
    && Number.isFinite(point.high)
    && Number.isFinite(point.low)
    && Number.isFinite(point.close)
  );
}

function normalizeRenderPoint(point: CandleRenderPoint): CandleRenderPoint {
  const open = Number(point.open);
  const close = Number(point.close);
  const high = Math.max(Number(point.high), open, close);
  const low = Math.min(Number(point.low), open, close);
  return {
    time: Number(point.time),
    open,
    high,
    low,
    close,
    timeKey: point.timeKey,
    color: point.color,
    borderColor: point.borderColor,
    wickColor: point.wickColor,
    wickType: point.wickType,
    emphasis: point.emphasis,
    styleKey: point.styleKey,
    flow: point.flow,
  };
}

function hasSameRenderStyle(previous: CandleRenderPoint | null | undefined, next: CandleRenderPoint | null | undefined): boolean {
  if (!previous || !next) {
    return false;
  }

  return previous.color === next.color
    && previous.borderColor === next.borderColor
    && previous.wickColor === next.wickColor
    && previous.wickType === next.wickType
    && previous.emphasis === next.emphasis
    && previous.styleKey === next.styleKey;
}

function mergeRenderPointWithPrevious(
  previous: CandleRenderPoint | null | undefined,
  next: CandleRenderPoint,
): CandleRenderPoint {
  return normalizeRenderPoint({
    ...previous,
    ...next,
    timeKey: next.timeKey ?? previous?.timeKey,
    color: next.color ?? previous?.color,
    borderColor: next.borderColor ?? previous?.borderColor,
    wickColor: next.wickColor ?? previous?.wickColor,
    wickType: next.wickType ?? previous?.wickType,
    emphasis: next.emphasis ?? previous?.emphasis,
    styleKey: next.styleKey ?? previous?.styleKey,
    flow: next.flow ?? previous?.flow,
  });
}

function resolvePerBarCandleColors(
  profile: VisualProfile,
  visual: PerceptionVisualMetadata | undefined,
  domImbalanceRatio: number,
): Pick<CandleRenderPoint, "color" | "borderColor" | "wickColor" | "wickType" | "emphasis" | "styleKey"> {
  const direction = visual?.direction === -1 ? "down" : "up";
  const baseColor = direction === "up" ? profile.palette.up : profile.palette.down;
  const opacity = clamp(visual?.opacity ?? profile.rendering.bodyOpacity, 0.6, 0.92);
  const borderColor = withAlpha(baseColor, opacity);
  const wickSignalColor = visual?.wickType === "rejection"
    ? profile.palette.down
    : visual?.wickType === "absorption"
      ? profile.palette.up
      : resolveProfileWickColor(profile, direction, domImbalanceRatio, visual?.wickOpacity ?? 0.88);

  return {
    color: withAlpha(baseColor, opacity),
    borderColor,
    wickColor: visual?.wickType === "neutral"
      ? resolveProfileWickColor(profile, direction, domImbalanceRatio, visual?.wickOpacity ?? 0.88)
      : withAlpha(wickSignalColor, clamp((visual?.wickOpacity ?? 0.88) + 0.08, 0, 1)),
    wickType: visual?.wickType,
    emphasis: visual?.lastCandleEmphasis,
    styleKey: [
      direction,
      visual?.wickType ?? "neutral",
      Math.round((visual?.importance ?? 0) * 100),
      Math.round((visual?.lastCandleEmphasis ?? 0) * 1000),
      Math.round(opacity * 1000),
      Math.round((visual?.wickOpacity ?? 0.88) * 1000),
    ].join(":"),
  };
}

function applyPerceptualRenderPipeline(
  source: PerceptualRenderInput[],
  input: {
    densityLevel: DensityLevel;
    visibleBars: number;
    timeframe: string;
    volatility: number;
    visualProfile: VisualProfileName;
    domImbalanceRatio?: number;
  },
): CandleSeriesPoint[] {
  if (source.length === 0) {
    return [];
  }

  const density = resolvePerceptionDensity({
    densityLevel: input.densityLevel,
    visibleBars: input.visibleBars,
  });
  const profile = applyVisualProfile(input.visualProfile);
  const transformed = applyPerceptionPipeline(
    source.map((bar) => ({
      time: Number(bar.time),
      open: Number(bar.open),
      high: Number(bar.high),
      low: Number(bar.low),
      close: Number(bar.close),
      volume: Number.isFinite(bar.volume) ? Number(bar.volume) : 0,
    })),
    {
      density,
      timeframe: input.timeframe,
      volatility: input.volatility,
      visualProfile: input.visualProfile,
      domImbalance: input.domImbalanceRatio ?? 0,
    },
  );

  return transformed.map((bar) => {
    const open = Number(bar.open);
    const close = Number(bar.close);
    const high = Number(bar.high);
    const low = Number(bar.low);
    const colors = resolvePerBarCandleColors(profile, bar.__visual, input.domImbalanceRatio ?? 0);
    const sourceBar = source.find((candidate) => Number(candidate.time) === Number(bar.time));
    return {
      time: Number(bar.time) as UTCTimestamp,
      high: Math.max(high, open, close),
      low: Math.min(low, open, close),
      open,
      close,
      timeKey: sourceBar?.timeKey,
      color: colors.color,
      borderColor: colors.borderColor,
      wickColor: colors.wickColor,
      wickType: colors.wickType,
      emphasis: colors.emphasis,
      styleKey: colors.styleKey,
      flow: sourceBar?.flow,
    };
  });
}

function resolveViewportVisibleBars(currentVisibleBars: number, fallbackVisibleBars: number): number {
  const current = Math.max(0, Math.round(currentVisibleBars || 0));
  if (current > 0) {
    return current;
  }
  return Math.max(1, Math.round(fallbackVisibleBars || 0));
}

function classifySpacingZone(spacingPx: number): "micro" | "normal" | "macro" {
  if (spacingPx <= 4) {
    return "micro";
  }
  if (spacingPx <= 8) {
    return "normal";
  }
  return "macro";
}

function buildPerceptualAutoscaleOptions(input: {
  timeframe: string;
  densityLevel: DensityLevel;
  visibleBars: number;
  lastPrice: number | null;
  driftPx: number;
  visualProfile: VisualProfileName;
}): ResolvePerceptualAutoscaleOptions {
  const liveFormingAutoscaleDisabled = isFastFormingAutoscaleDisabled(input.timeframe);
  return {
    timeframe: input.timeframe,
    density: resolvePerceptionDensity({
      densityLevel: input.densityLevel,
      visibleBars: input.visibleBars,
    }),
    lastPrice: liveFormingAutoscaleDisabled ? null : input.lastPrice,
    driftPx: liveFormingAutoscaleDisabled ? 0 : input.driftPx,
    visualProfile: input.visualProfile,
  };
}

function isFastFormingAutoscaleDisabled(timeframe: string): boolean {
  const normalized = String(timeframe || "").trim();
  if (!normalized) {
    return false;
  }
  if (normalized === "1m") {
    return true;
  }
  const match = normalized.match(/^(\d+)([smhdwM])$/);
  if (!match) {
    return false;
  }
  const value = Number(match[1]);
  const unit = match[2];
  if (!Number.isFinite(value) || value <= 0) {
    return false;
  }
  if (unit === "s") {
    return true;
  }
  return unit === "m" && value <= 1;
}

function shouldConflateRenderPointUpdate(
  previous: CandleRenderPoint | null,
  next: CandleRenderPoint,
  input: {
    densityLevel: DensityLevel;
    visibleBars: number;
    timeframe: string;
    volatility: number;
    visualProfile: VisualProfileName;
  },
): boolean {
  if (previous && !hasSameRenderStyle(previous, next)) {
    return false;
  }

  return shouldConflatePerceptualUpdate(previous, next, {
    density: resolvePerceptionDensity({
      densityLevel: input.densityLevel,
      visibleBars: input.visibleBars,
    }),
    timeframe: input.timeframe,
    volatility: input.volatility,
    visualProfile: input.visualProfile,
  });
}

function resolveDomImbalanceRatio(domLevels: Props["domLevels"]): number {
  if (!domLevels || domLevels.length === 0) {
    return 0;
  }

  let bidTotal = 0;
  let askTotal = 0;
  for (const level of domLevels) {
    const weighted = Math.max(0, level.size) * Math.max(0.25, level.intensity || 0);
    if (level.side === "bid") {
      bidTotal += weighted;
    } else {
      askTotal += weighted;
    }
  }

  const denom = Math.max(1e-6, bidTotal + askTotal);
  return Math.min(1, Math.max(-1, (bidTotal - askTotal) / denom));
}

function resolveProfileWickColor(
  profile: VisualProfile,
  direction: "up" | "down",
  domImbalanceRatio: number,
  opacity: number,
): string {
  const domColor = domImbalanceRatio >= 0 ? profile.palette.up : profile.palette.down;
  const domShift = profile.perception.domWickSmoothing
    ? Math.min(Math.abs(domImbalanceRatio), 1) * profile.perception.wickDomShiftPct
    : 0;
  const directionalMix = direction === "up" ? 0.26 : 0.24;
  const liftedBase = mixColors(profile.palette.wick, profile.palette.text, 0.22);
  const shifted = mixColors(liftedBase, domColor, domShift);
  return withAlpha(mixColors(shifted, direction === "up" ? profile.palette.up : profile.palette.down, directionalMix), opacity);
}

type ManagedPriceLineSpec = {
  price: number;
  color: string;
  fadedColor: string;
  title: string;
  compactTitle: string;
  lineStyle: number;
  lineWidth: number;
  priority: number;
  preserveNearLastLabel?: boolean;
  hideNearLastLabel?: boolean;
};

type ChartMotionTuning = {
  smoothingBase: number;
  smoothingDistanceScale: number;
  smoothingMax: number;
  snapDistance: number;
  inertiaDecayX: number;
  inertiaDecayY: number;
  inertiaImpulseX: number;
  inertiaImpulseY: number;
  inertiaImpulseClamp: number;
  inertiaDriftClampX: number;
  inertiaDriftClampY: number;
  inertiaBlend: number;
  feelBaseOpacity: number;
  feelMaxExtraOpacity: number;
  feelMaxScale: number;
  formingWidthFactor: number;
  formingWidthMax: number;
};

const OVERLAY_OFFSET_STORAGE_PREFIX = "gtix.overlay.offsets.v1";
const DOM_LOCK_STORAGE_PREFIX = "gtix.dom.locked-walls.v1";
const USE_NATIVE_WHEEL_NAV = false;
const OVERLAY_UPDATE_INTERVAL_MS = 120;
const CANDLE_UPDATE_INTERVAL_MS = 16;
const HEATMAP_UPDATE_INTERVAL_MS = 160;
const DOM_UPDATE_INTERVAL_MS = 180;
const FOOTPRINT_UPDATE_INTERVAL_MS = 220;
const VOLUME_PROFILE_UPDATE_INTERVAL_MS = 260;
const STALE_CHART_LAYOUT_SETTLE_MS = 60;
const MAX_STALE_CHART_RECOVERY_ATTEMPTS = 2;
const MIN_STABLE_LAYOUT_FRAMES = 3;
const STABLE_LAYOUT_FALLBACK_MS = 120;

const AREA_OPTIONS: AreaSeriesPartialOptions = {
  lineColor: "#7ed7ff",
  lineWidth: 3,
  topColor: "rgba(88,199,255,0.38)",
  bottomColor: "rgba(88,199,255,0.03)",
  priceLineVisible: false,
  lastValueVisible: false,
};

const CANDLE_OPTIONS: CandlestickSeriesPartialOptions = {
  upColor: "#00ffa3",
  downColor: "#ff3b3b",
  wickUpColor: "#00ffa3",
  wickDownColor: "#ff3b3b",
  wickVisible: true,
  borderVisible: false,
  borderUpColor: "#00ffa3",
  borderDownColor: "#ff3b3b",
  priceLineVisible: false,
  lastValueVisible: false,
};

const ENABLE_CUSTOM_V3_CANDLE_RENDERER = process.env.NEXT_PUBLIC_ENABLE_CUSTOM_V3_CANDLE_RENDERER === "1";
const HIDDEN_NATIVE_CANDLE_COLOR = "rgba(0,0,0,0)";

const DOM_HOLD_THRESHOLD_MS = {
  touch: 340,
  pen: 260,
  mouse: 420,
} as const;

const LAYER_PRIORITY = {
  candle: 3,
  indicator: 2,
  overlay: 1,
};

type AssetContrastClass = "crypto" | "fx" | "other";

function inferAssetContrastClass(symbol: string): AssetContrastClass {
  const normalized = symbol.toUpperCase().replace(/[^A-Z]/g, "");
  if (normalized.includes("BTC") || normalized.includes("ETH") || normalized.includes("SOL") || normalized.includes("XRP") || normalized.includes("DOGE")) {
    return "crypto";
  }
  const fxMajors = ["USD", "EUR", "JPY", "GBP", "AUD", "NZD", "CAD", "CHF"];
  if (normalized.length >= 6) {
    const base = normalized.slice(0, 3);
    const quote = normalized.slice(3, 6);
    if (fxMajors.includes(base) && fxMajors.includes(quote)) {
      return "fx";
    }
  }
  return "other";
}

function inferTimeframeContrastBand(timeframe: string): "scalp" | "fast" | "swing" {
  if (timeframe === "1m") {
    return "scalp";
  }
  return timeframe === "5m" ? "fast" : "swing";
}

function resolveCandleContrastOptions(symbol: string, timeframe: string): Partial<CandlestickSeriesPartialOptions> {
  const assetClass = inferAssetContrastClass(symbol);
  const band = inferTimeframeContrastBand(timeframe);
  if (assetClass === "crypto") {
    return band === "scalp"
      ? {
        upColor: "#00ffa3",
        downColor: "#ff2e2e",
        wickUpColor: "#00ffa3",
        wickDownColor: "#ff2e2e",
        borderUpColor: "#00ffa3",
        borderDownColor: "#ff2e2e",
      }
      : band === "fast"
      ? {
        upColor: "rgba(14, 224, 138, 1)",
        downColor: "rgba(250, 74, 74, 1)",
        wickUpColor: "rgba(14, 224, 138, 1)",
        wickDownColor: "rgba(250, 74, 74, 1)",
        borderUpColor: "rgba(252, 255, 253, 1)",
        borderDownColor: "rgba(255, 246, 246, 1)",
      }
      : {
        upColor: "rgba(22, 208, 134, 1)",
        downColor: "rgba(240, 82, 82, 1)",
        wickUpColor: "rgba(22, 208, 134, 1)",
        wickDownColor: "rgba(240, 82, 82, 1)",
        borderUpColor: "rgba(244, 255, 249, 1)",
        borderDownColor: "rgba(255, 240, 240, 1)",
      };
  }
  if (assetClass === "fx") {
    return band === "scalp"
      ? {
        upColor: "rgba(86, 220, 255, 1)",
        downColor: "rgba(255, 104, 122, 1)",
        wickUpColor: "rgba(86, 220, 255, 1)",
        wickDownColor: "rgba(255, 104, 122, 1)",
        borderUpColor: "rgba(245, 252, 255, 1)",
        borderDownColor: "rgba(255, 241, 244, 1)",
      }
      : band === "fast"
      ? {
        upColor: "rgba(58, 191, 236, 1)",
        downColor: "rgba(255, 118, 124, 1)",
        wickUpColor: "rgba(58, 191, 236, 1)",
        wickDownColor: "rgba(255, 118, 124, 1)",
        borderUpColor: "rgba(240, 250, 255, 1)",
        borderDownColor: "rgba(255, 238, 238, 1)",
      }
      : {
        upColor: "rgba(74, 182, 224, 0.98)",
        downColor: "rgba(242, 136, 136, 0.98)",
        wickUpColor: "rgba(74, 182, 224, 0.98)",
        wickDownColor: "rgba(242, 136, 136, 0.98)",
        borderUpColor: "rgba(232, 247, 255, 1)",
        borderDownColor: "rgba(255, 232, 232, 1)",
      };
  }
  return {};
}

function resolvePerceptualCandleStyleOptions(
  symbol: string,
  timeframe: string,
  densityLevel: DensityLevel,
  volatility: number,
  visualProfileName: VisualProfileName,
  domImbalanceRatio: number,
  presentation: DynamicCandlePresentation,
): Partial<CandlestickSeriesPartialOptions> {
  const profile = applyVisualProfile(visualProfileName);
  const assetClass = inferAssetContrastClass(symbol);
  const densityBorderBias = densityLevel === "micro" ? 0.18 : densityLevel === "compact" ? 0.08 : 0;
  const hasDeskBorders = visualProfileName === "institutional"
    || presentation.preferredBodyWidthPx + densityBorderBias >= 4.2
    || volatility >= 0.0035
    || timeframe === "1m"
    || timeframe.includes("s");
  const baseUpColor = withAlpha(profile.palette.up, presentation.bodyOpacity);
  const baseDownColor = withAlpha(profile.palette.down, presentation.bodyOpacity);
  const vividFx = {
    upColor: assetClass === "fx" && visualProfileName === "institutional" ? withAlpha(mixColors(profile.palette.up, "#5CE3FF", 0.2), presentation.bodyOpacity) : baseUpColor,
    downColor: assetClass === "fx" && visualProfileName === "institutional" ? withAlpha(mixColors(profile.palette.down, "#FF8AA6", 0.12), presentation.bodyOpacity) : baseDownColor,
    wickUpColor: resolveProfileWickColor(profile, "up", domImbalanceRatio, presentation.wickOpacity),
    wickDownColor: resolveProfileWickColor(profile, "down", domImbalanceRatio, presentation.wickOpacity),
    borderUpColor: withAlpha(profile.palette.up, presentation.borderOpacity),
    borderDownColor: withAlpha(profile.palette.down, presentation.borderOpacity),
  };
  const vividCrypto = {
    upColor: baseUpColor,
    downColor: baseDownColor,
    wickUpColor: resolveProfileWickColor(profile, "up", domImbalanceRatio, presentation.wickOpacity),
    wickDownColor: resolveProfileWickColor(profile, "down", domImbalanceRatio, presentation.wickOpacity),
    borderUpColor: withAlpha(profile.palette.up, presentation.borderOpacity),
    borderDownColor: withAlpha(profile.palette.down, presentation.borderOpacity),
  };

  return {
    ...(assetClass === "fx" ? vividFx : vividCrypto),
    borderVisible: hasDeskBorders,
    wickVisible: true,
  };
}

function resolveDynamicCandlePresentation(input: {
  spacingPolicy: PerceptualSpacingPolicy;
  slotWidthPx: number;
  visibleBars: number;
  densityLevel: DensityLevel;
  timeframe: string;
  volatility: number;
  visualProfileName: VisualProfileName;
  deskMode: ReturnType<typeof resolvePerceptualDeskMode>;
}): DynamicCandlePresentation {
  const profile = applyVisualProfile(input.visualProfileName);
  const tfSeconds = timeframeSeconds(input.timeframe);
  const devicePixelRatio = typeof window === "undefined" ? 1 : Math.max(1, window.devicePixelRatio || 1);
  const stableSpacingPx = quantizePerceptualBarSpacing(clamp(
    Number.isFinite(input.slotWidthPx) && input.slotWidthPx > 0 ? input.slotWidthPx : input.spacingPolicy.barSpacing,
    2,
    80,
  ));
  const slotWidth = stableSpacingPx;
  const perceptualCandle = computePerceptualCandle({
    barSpacingPx: stableSpacingPx,
    targetSpacingPx: input.spacingPolicy.barSpacing,
    visibleBars: input.visibleBars,
    timeframe: input.timeframe,
    volatility: input.volatility,
    devicePixelRatio,
    densityLevel: input.densityLevel,
    preferredBodyWidthPx: input.spacingPolicy.preferredBodyWidthPx,
    minGapPx: input.spacingPolicy.minGapPx,
  });
  const preferredBodyWidthPx = clamp(
    perceptualCandle.bodyWidthPx * input.deskMode.bodyWeight,
    Math.max(perceptualCandle.minBodyWidthPx, input.densityLevel === "micro" ? 2.8 : 3.2),
    Math.min(12, perceptualCandle.maxBodyWidthPx),
  );
  const wickWidthPx = clamp(
    Math.max(
      profile.rendering.wickWidthPx,
      preferredBodyWidthPx * 0.4,
      perceptualCandle.wickWidthPx * input.deskMode.wickWeight,
    ),
    1 / devicePixelRatio,
    Math.max(1.4, preferredBodyWidthPx - 1 / devicePixelRatio),
  );
  const bodyOpacity = clamp(
    profile.rendering.bodyOpacity
      + 0.03
      + (input.densityLevel === "micro" ? 0.05 : input.densityLevel === "compact" ? 0.04 : 0.02)
      + (tfSeconds <= 5 * 60 ? 0.02 : 0.01),
    0.94,
    0.99,
  );
  const wickOpacity = clamp(
    0.9
      + (tfSeconds <= 5 * 60 ? 0.05 : 0.03)
      + (input.volatility >= 0.0032 ? 0.03 : 0)
      + (input.densityLevel === "micro" ? 0.03 : 0),
    0.9,
    0.99,
  );
  const borderOpacity = clamp(
    bodyOpacity + (input.visualProfileName === "institutional" ? 0.02 : 0.01) - (slotWidth < 6 ? 0.01 : 0),
    0.9,
    1,
  );
  const bodyRadiusPx = slotWidth < 4.2 || input.densityLevel === "micro"
    ? 0
    : clamp(Math.min(profile.rendering.bodyRadiusPx, preferredBodyWidthPx * 0.18), 0, 2);
  const formingWidthPx = clamp(
    perceptualCandle.formingWidthPx * input.deskMode.bodyWeight,
    perceptualCandle.minBodyWidthPx,
    perceptualCandle.maxBodyWidthPx,
  );
  const overlayWidthPx = clamp(
    perceptualCandle.overlayWidthPx * input.deskMode.overlayWeight,
    10,
    64,
  );
  const lastBrightness = clamp(
    1
      + profile.perception.lastCandleGlow
      + (tfSeconds <= 5 * 60 ? 0.03 : 0.015)
      + (input.densityLevel === "micro" ? 0.015 : 0)
      + (input.deskMode.mode === "execution" ? 0.02 : 0),
    1.01,
    1.1,
  );

  return {
    preferredBodyWidthPx,
    formingWidthPx,
    overlayWidthPx,
    wickWidthPx,
    bodyRadiusPx,
    baseBodyWidthPx: perceptualCandle.baseBodyWidthPx,
    timeframeWeight: perceptualCandle.timeframeWeight,
    densityFactor: perceptualCandle.densityFactor,
    volatilityFactor: perceptualCandle.volatilityFactor,
    zoomFactor: perceptualCandle.zoomFactor,
    minBodyWidthPx: perceptualCandle.minBodyWidthPx,
    maxBodyWidthPx: perceptualCandle.maxBodyWidthPx,
    bodyToSpacingRatio: perceptualCandle.bodyToSpacingRatio,
    bodyOpacity,
    wickOpacity,
    borderOpacity,
    lastBrightness,
  };
}

function resolveStableLogicalWidthFromSpacing(input: {
  containerWidth: number;
  requestedVisibleBars: number;
  spacingPolicy: PerceptualSpacingPolicy;
}): number {
  const containerWidth = Math.max(1, Number.isFinite(input.containerWidth) ? input.containerWidth : 1);
  const requestedVisibleBars = Number.isFinite(input.requestedVisibleBars) && input.requestedVisibleBars > 0
    ? input.requestedVisibleBars
    : input.spacingPolicy.targetVisibleBars;
  const boundedVisibleBars = clamp(
    requestedVisibleBars,
    input.spacingPolicy.minVisibleBars,
    input.spacingPolicy.maxVisibleBars,
  );
  const rawSpacingPx = clamp(
    containerWidth / boundedVisibleBars,
    input.spacingPolicy.minBarSpacing,
    80,
  );
  const stableSpacingPx = clamp(
    quantizePerceptualBarSpacing(rawSpacingPx),
    input.spacingPolicy.minBarSpacing,
    80,
  );
  return clamp(
    containerWidth / stableSpacingPx,
    input.spacingPolicy.minVisibleBars,
    input.spacingPolicy.maxVisibleBars,
  );
}

type AutoscaleTelemetryState = {
  signature: string;
  reframeCount: number;
  softReframes: number;
  hardReframes: number;
  lastTransitionMode: PerceptualTransitionMode;
  lastShiftPct: number;
};

function chartCanvasBitmapLooksStale(host: HTMLDivElement, width: number, height: number): boolean {
  if (width <= 320 && height <= 180) {
    return false;
  }

  const canvases = Array.from(host.querySelectorAll("canvas"))
    .filter((canvas) => canvas.clientWidth > 0 && canvas.clientHeight > 0)
    .sort((left, right) => (right.clientWidth * right.clientHeight) - (left.clientWidth * left.clientHeight));

  const plotCanvases = canvases.filter((canvas) => (
    canvas.clientWidth >= width * 0.55
    && canvas.clientHeight >= height * 0.55
  ));

  return plotCanvases.some((canvas) => (
    canvas.width < Math.floor(canvas.clientWidth * 0.85)
    || canvas.height < Math.floor(canvas.clientHeight * 0.85)
  ));
}

function resolveManagedPriceLines(
  activeSeries: ISeriesApi<"Area"> | ISeriesApi<"Candlestick">,
  specs: ManagedPriceLineSpec[],
  mode: Props["mode"],
  lastValue: number | null,
  maxRelativeDistance: number | null = null,
  preferCompactTitles = false,
  maxVisibleLines: number | null = null,
) {
  const crowdedLabelGapPx = mode === "candles" ? 22 : 16;
  const nearLastLabelGapPx = mode === "candles" ? 26 : 18;
  const lastY = Number.isFinite(lastValue) ? activeSeries.priceToCoordinate(Number(lastValue)) : null;
  const placedLabelYs: number[] = [];

  const filteredSpecs = Number.isFinite(lastValue) && Number.isFinite(maxRelativeDistance) && maxRelativeDistance !== null && maxRelativeDistance > 0
    ? specs.filter((spec) => {
      const relativeDistance = Math.abs(spec.price - Number(lastValue)) / Math.max(1, Math.abs(Number(lastValue)));
      return relativeDistance <= maxRelativeDistance || (spec.priority >= 5 && relativeDistance <= maxRelativeDistance * 1.35);
    })
    : specs;

  const rankedSpecs = [...filteredSpecs]
    .sort((left, right) => {
      if (right.priority !== left.priority) {
        return right.priority - left.priority;
      }
      if (Number.isFinite(lastValue)) {
        return Math.abs(left.price - Number(lastValue)) - Math.abs(right.price - Number(lastValue));
      }
      return right.price - left.price;
    });

  const visibleSpecs = Number.isFinite(maxVisibleLines) && maxVisibleLines !== null && maxVisibleLines > 0
    ? rankedSpecs.slice(0, maxVisibleLines)
    : rankedSpecs;

  return visibleSpecs
    .map((spec) => {
      const y = activeSeries.priceToCoordinate(spec.price);
      const nearLast = y !== null && lastY !== null && Math.abs(y - lastY) < nearLastLabelGapPx;
      const crowded = y !== null && placedLabelYs.some((placedY) => Math.abs(placedY - y) < crowdedLabelGapPx);
      const axisLabelVisible = y === null
        ? true
        : spec.preserveNearLastLabel && nearLast
          ? !crowded
          : !(crowded || (nearLast && (spec.hideNearLastLabel || spec.priority < 4)));
      if (axisLabelVisible && y !== null) {
        placedLabelYs.push(y);
      }

      const compact = nearLast || crowded;
      return {
        price: spec.price,
        color: compact ? spec.fadedColor : spec.color,
        lineStyle: spec.lineStyle,
        lineWidth: compact ? Math.max(1, spec.lineWidth - 1) : spec.lineWidth,
        title: axisLabelVisible ? ((preferCompactTitles || compact) ? spec.compactTitle : spec.title) : "",
        axisLabelVisible,
        lineVisible: true,
      };
    });
}

function timeframeSeconds(timeframe: string): number {
  const match = timeframe.trim().match(/^(\d+)(s|m|h|d|w|M)$/i);
  if (!match) {
    return 60;
  }
  const value = Math.max(1, Number(match[1]));
  const unit = match[2];
  switch (unit) {
    case "s":
    case "S":
      return value;
    case "m":
      return value * 60;
    case "h":
      return value * 3600;
    case "d":
      return value * 86400;
    case "w":
      return value * 604800;
    case "M":
      return value * 2592000;
    default:
      return 60;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function domHoldThresholdMs(pointerType: string, viewportWidth: number): number {
  const normalized = pointerType === "pen" ? "pen" : pointerType === "mouse" ? "mouse" : "touch";
  const coarseViewportBoost = viewportWidth < 780 && normalized !== "mouse" ? 35 : 0;
  return DOM_HOLD_THRESHOLD_MS[normalized] + coarseViewportBoost;
}

function formatCursorTime(time: Time, timeframe = "1m"): string {
  const showSeconds = timeframeSeconds(timeframe) < 60;
  if (typeof time === "number") {
    return new Date(time * 1000).toISOString().slice(11, showSeconds ? 19 : 16);
  }
  if (typeof time === "string") {
    return time.includes("T") ? time.slice(11, showSeconds ? 19 : 16) : time.slice(-(showSeconds ? 8 : 5));
  }
  if ("day" in time) {
    const day = String(time.day).padStart(2, "0");
    const month = String(time.month).padStart(2, "0");
    return `${day}/${month}`;
  }
  return "--:--";
}

function timeToBucketKey(time: Time | number, timeframe: string): string {
  const step = timeframeSeconds(timeframe);
  if (typeof time === "number") {
    return String(Math.floor(time / step) * step * 1000);
  }
  if (typeof time === "string") {
    const parsed = Date.parse(time);
    if (Number.isFinite(parsed)) {
      return String(Math.floor(parsed / (step * 1000)) * step * 1000);
    }
    return "";
  }
  if ("day" in time) {
    const parsed = Date.UTC(time.year, time.month - 1, time.day);
    return String(Math.floor(parsed / (step * 1000)) * step * 1000);
  }
  return "";
}

function createNeutralExecutionSignal(timeKey: string): PerceptualExecutionSignal {
  return {
    timeKey,
    fillProbability: 0,
    slippageBps: 0,
    latencyMs: 0,
    routeScore: 0,
    edgeBps: 0,
    blockedRatio: 0,
    partialFillRatio: 0,
    confidence: 0,
  };
}

function resolveFootprintAbsorption(totalVolume: number, deltaRatio: number, baselineVolume: number): number {
  if (!Number.isFinite(totalVolume) || totalVolume <= 0) {
    return 0;
  }
  const relativeVolume = totalVolume / Math.max(1, baselineVolume);
  const compression = clamp(1 - Math.abs(deltaRatio) / 0.18, 0, 1);
  return clamp(relativeVolume * 0.42 + compression * 0.58 - 0.35, 0, 1);
}

function buildPerceptualHeatSegmentsFromFootprint(input: {
  buyVolume: number;
  sellVolume: number;
  deltaRatio: number;
  absorption: number;
  baselineVolume: number;
}): PerceptualHeatSegment[] {
  const totalVolume = Math.max(0, input.buyVolume) + Math.max(0, input.sellVolume);
  if (totalVolume <= 0) {
    return [];
  }

  const buyShare = clamp(input.buyVolume / Math.max(1, totalVolume), 0, 1);
  const relativeVolume = clamp(totalVolume / Math.max(1, input.baselineVolume), 0.25, 1.9);
  const directionalBias = clamp((input.deltaRatio + 1) * 0.5, 0, 1);

  return new Array(4).fill(null).map((_, index) => {
    const progress = (index + 0.5) / 4;
    const segmentBias = input.deltaRatio >= 0 ? progress : 1 - progress;
    const intensity = clamp(
      0.12 + relativeVolume * 0.22 + Math.abs(input.deltaRatio) * (0.28 + segmentBias * 0.36) + input.absorption * 0.18,
      0.08,
      1,
    );
    const segmentDeltaRatio = clamp(
      input.deltaRatio * (0.72 + segmentBias * 0.55),
      -1,
      1,
    );
    const segmentBuyShare = clamp(
      buyShare + (directionalBias - 0.5) * 0.22 + (segmentBias - 0.5) * input.deltaRatio * 0.3,
      0,
      1,
    );
    return {
      intensity,
      deltaRatio: segmentDeltaRatio,
      buyShare: segmentBuyShare,
      absorption: input.absorption,
    };
  });
}

function resolvePerceptualFlowState(input: {
  time: number;
  timeframe: string;
  volume: number;
  footprintRowsByTimeKey: Map<string, Array<{ buyVolume: number; sellVolume: number; delta: number }>>;
  footprintBaselineVolume: number;
  executionSignalByTimeKey: Map<string, PerceptualExecutionSignal>;
}): PerceptualCandleFlowState | undefined {
  const timeKey = timeToBucketKey(input.time, input.timeframe);
  if (!timeKey) {
    return undefined;
  }

  const rows = input.footprintRowsByTimeKey.get(timeKey) || [];
  const buyVolume = rows.reduce((sum, row) => sum + Math.max(0, row.buyVolume), 0);
  const sellVolume = rows.reduce((sum, row) => sum + Math.max(0, row.sellVolume), 0);
  const footprintVolume = buyVolume + sellVolume;
  const volume = Math.max(0, Number.isFinite(input.volume) ? input.volume : 0, footprintVolume);
  const delta = rows.length > 0
    ? rows.reduce((sum, row) => sum + (Number.isFinite(row.delta) ? row.delta : (row.buyVolume - row.sellVolume)), 0)
    : 0;
  const deltaRatio = volume > 0 ? clamp(delta / volume, -1, 1) : 0;
  const imbalance = volume > 0 ? clamp(Math.abs(delta) / volume, 0, 1) : 0;
  const absorption = resolveFootprintAbsorption(volume, deltaRatio, input.footprintBaselineVolume);
  const execution = input.executionSignalByTimeKey.get(timeKey) || createNeutralExecutionSignal(timeKey);
  const heatSegments = buildPerceptualHeatSegmentsFromFootprint({
    buyVolume,
    sellVolume,
    deltaRatio,
    absorption,
    baselineVolume: input.footprintBaselineVolume,
  });

  if (volume <= 0 && heatSegments.length === 0 && execution.confidence <= 0) {
    return undefined;
  }

  return {
    timeKey,
    volume,
    delta,
    imbalance,
    absorption,
    liquidity: {
      bid: buyVolume,
      ask: sellVolume,
      absorption,
    },
    execution,
    heatSegments,
  };
}

function formatCompactPrice(value: number): string {
  if (!Number.isFinite(value)) {
    return "-";
  }
  if (Math.abs(value) >= 1000) {
    return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  }
  if (Math.abs(value) >= 100) {
    return value.toFixed(2);
  }
  return value.toFixed(4);
}

function drawCanvasLivePriceHud(
  ctx: CanvasRenderingContext2D,
  {
    width,
    candleSeries,
    lastPrice,
    lastOpen,
    liveFrameMeta,
  }: {
    width: number;
    candleSeries: ISeriesApi<"Candlestick">;
    lastPrice: number;
    lastOpen: number;
    liveFrameMeta: LiveChartFrameMeta | null;
  },
): void {
  if (!Number.isFinite(lastPrice)) {
    return;
  }

  const y = candleSeries.priceToCoordinate(lastPrice);
  if (y === null) {
    return;
  }

  const priceUp = lastPrice >= lastOpen;
  const accent = priceUp ? "#00ffa3" : "#ff5d5d";
  const accentSoft = priceUp ? "rgba(0,255,163,0.16)" : "rgba(255,93,93,0.16)";
  const label = formatCompactPrice(lastPrice);

  ctx.save();
  ctx.font = '12px ui-monospace, "SFMono-Regular", Menlo, monospace';
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, y + 0.5);
  ctx.lineTo(Math.max(0, width - 92), y + 0.5);
  ctx.stroke();

  ctx.fillStyle = accentSoft;
  ctx.fillRect(0, y - 9, Math.max(0, width - 92), 18);

  const badgeWidth = Math.ceil(ctx.measureText(label).width) + 18;
  const badgeHeight = 20;
  const badgeX = Math.max(8, width - badgeWidth - 10);
  const badgeY = y - badgeHeight * 0.5;
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.roundRect(badgeX, badgeY, badgeWidth, badgeHeight, 8);
  ctx.fill();

  ctx.fillStyle = "#051018";
  ctx.fillText(label, badgeX + 9, badgeY + badgeHeight * 0.5);

  if (liveFrameMeta) {
    const status = `${liveFrameMeta.syncStatus.toUpperCase()} ${Math.round(liveFrameMeta.confidence * 100)}%`;
    ctx.font = '10px ui-monospace, "SFMono-Regular", Menlo, monospace';
    const pillWidth = Math.ceil(ctx.measureText(status).width) + 14;
    ctx.fillStyle = "rgba(6, 14, 24, 0.78)";
    ctx.beginPath();
    ctx.roundRect(10, Math.max(8, badgeY - 26), pillWidth, 18, 8);
    ctx.fill();
    ctx.fillStyle = "rgba(222, 235, 247, 0.9)";
    ctx.fillText(status, 17, Math.max(8, badgeY - 26) + 9);
  }

  ctx.restore();
}

function formatCompactDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) {
    return `${total}s`;
  }
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  if (mins < 60) {
    return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  }
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
}

function normalizeTimes(labels: string[], timeframe: string): UTCTimestamp[] {
  const step = timeframeSeconds(timeframe);
  const fallbackStart = Math.floor(Date.now() / 1000) - Math.max(0, labels.length - 1) * step;
  let previous = 0;

  return labels.map((label, index) => {
    const parsed = Date.parse(label);
    let value = Number.isFinite(parsed)
      ? Math.floor(parsed / 1000)
      : fallbackStart + index * step;

    if (value <= previous) {
      value = previous + step;
    }

    previous = value;
    return value as UTCTimestamp;
  });
}

function sanitizeLiveFeedCandles(candles: CandlePoint[], timeframe: string): Array<{ time: UTCTimestamp; open: number; high: number; low: number; close: number }> {
  if (candles.length === 0) {
    return [];
  }

  const times = normalizeTimes(candles.map((candle) => candle.label), timeframe);
  const sanitized: Array<{ time: UTCTimestamp; open: number; high: number; low: number; close: number }> = [];
  let previousTime = Number.NEGATIVE_INFINITY;

  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    const time = Number(times[index] ?? 0);
    const open = Number(candle.open);
    const close = Number(candle.close);
    const high = Math.max(Number(candle.high), open, close);
    const low = Math.min(Number(candle.low), open, close);
    if (!Number.isFinite(time) || !Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
      continue;
    }
    if (time <= previousTime) {
      continue;
    }
    sanitized.push({ time: time as UTCTimestamp, open, high, low, close });
    previousTime = time;
  }

  return sanitized;
}

function isLiveFrameCompatibleWithProps(liveCandles: CandlePoint[], propCandles: CandlePoint[], timeframe: string): boolean {
  if (liveCandles.length === 0 || propCandles.length === 0) {
    return true;
  }

  const step = Math.max(1, timeframeSeconds(timeframe));
  const liveTimes = normalizeTimes(liveCandles.map((candle) => candle.label), timeframe);
  const propTimes = normalizeTimes(propCandles.map((candle) => candle.label), timeframe);
  const liveLastTime = Number(liveTimes[liveTimes.length - 1] ?? 0);
  const propLastTime = Number(propTimes[propTimes.length - 1] ?? 0);
  if (Number.isFinite(liveLastTime) && Number.isFinite(propLastTime)) {
    if (liveLastTime < propLastTime - step * 3 || liveLastTime > propLastTime + step * 3) {
      return false;
    }
  }

  const propCloses = propCandles
    .map((candle) => Number(candle.close))
    .filter((value) => Number.isFinite(value) && value > 0);
  const liveLastClose = Number(liveCandles[liveCandles.length - 1]?.close ?? 0);
  const propLastClose = propCloses[propCloses.length - 1] ?? 0;
  if (!(liveLastClose > 0) || !(propLastClose > 0) || propCloses.length === 0) {
    return true;
  }

  const propMin = Math.min(...propCloses);
  const propMax = Math.max(...propCloses);
  const propRange = Math.max(propMax - propMin, propLastClose * 0.0012);
  const lowerBound = propMin - propRange * 0.5;
  const upperBound = propMax + propRange * 0.5;
  if (liveLastClose < lowerBound || liveLastClose > upperBound) {
    return false;
  }

  const deviationRatio = Math.abs(liveLastClose - propLastClose) / Math.max(propLastClose, 0.0000001);
  const allowedDeviationRatio = Math.max(0.02, (propRange / Math.max(propLastClose, 0.0000001)) * 2.5);
  return deviationRatio <= allowedDeviationRatio;
}

function buildSeriesAutoscaleInfo(
  baseImplementation: (() => { margins?: { above: number; below: number } } | null) | undefined,
  range: { min: number; max: number } | null,
  autoscaleSnapshotRef: { current: PerceptualAutoscaleSnapshot | null },
  autoscaleTelemetryRef: { current: AutoscaleTelemetryState },
  options?: ResolvePerceptualAutoscaleOptions,
) {
  const baseInfo = baseImplementation?.() ?? null;
  const resolved = resolvePerceptualAutoscaleRange(range, autoscaleSnapshotRef.current, options);
  if (!resolved) {
    return baseInfo;
  }

  autoscaleSnapshotRef.current = resolved;
  const signature = `${resolved.transitionMode}|${resolved.min.toFixed(6)}|${resolved.max.toFixed(6)}|${resolved.rawMin.toFixed(6)}|${resolved.rawMax.toFixed(6)}`;
  if (signature !== autoscaleTelemetryRef.current.signature) {
    autoscaleTelemetryRef.current.signature = signature;
    autoscaleTelemetryRef.current.lastTransitionMode = resolved.transitionMode;
    autoscaleTelemetryRef.current.lastShiftPct = resolved.shiftPct;
    if (resolved.transitionMode === "soft" || resolved.transitionMode === "hard") {
      autoscaleTelemetryRef.current.reframeCount += 1;
      if (resolved.transitionMode === "soft") {
        autoscaleTelemetryRef.current.softReframes += 1;
      } else {
        autoscaleTelemetryRef.current.hardReframes += 1;
      }
    }
  }

  return {
    priceRange: {
      minValue: resolved.min,
      maxValue: resolved.max,
    },
    margins: baseInfo?.margins,
  };
}

function resolveStableAutoscaleCandleData(candleData: CandleSeriesPoint[], timeframe?: string): CandleSeriesPoint[] {
  if (!isFastFormingAutoscaleDisabled(String(timeframe || "")) || candleData.length <= 1) {
    return candleData;
  }
  return candleData.slice(0, -1);
}

function resolveCandleAutoscaleRange(candleData: CandleSeriesPoint[], timeframe?: string): { min: number; max: number } | null {
  const autoscaleSource = resolveStableAutoscaleCandleData(candleData, timeframe);
  const lows = autoscaleSource.map((bar) => Number(bar.low)).filter((value) => Number.isFinite(value));
  const highs = autoscaleSource.map((bar) => Number(bar.high)).filter((value) => Number.isFinite(value));
  return lows.length > 0 && highs.length > 0
    ? {
      min: Math.min(...lows),
      max: Math.max(...highs),
    }
    : null;
}

function resolveAreaAutoscaleRange(areaData: Array<{ time: number; value: number }>, timeframe?: string): { min: number; max: number } | null {
  const autoscaleSource = isFastFormingAutoscaleDisabled(String(timeframe || "")) && areaData.length > 1
    ? areaData.slice(0, -1)
    : areaData;
  const values = autoscaleSource.map((point) => Number(point.value)).filter((value) => Number.isFinite(value));
  return values.length > 0
    ? {
      min: Math.min(...values),
      max: Math.max(...values),
    }
    : null;
}

function syncCandleAutoscaleState(
  candleData: CandleSeriesPoint[],
  candleAutoscaleRangeRef: { current: { min: number; max: number } | null },
  lastPriceRef: { current: number | null },
  timeframe?: string,
): void {
  const autoscaleSource = resolveStableAutoscaleCandleData(candleData, timeframe);
  candleAutoscaleRangeRef.current = resolveCandleAutoscaleRange(candleData, timeframe);
  const lastCandle = autoscaleSource[autoscaleSource.length - 1] ?? candleData[candleData.length - 1];
  const lastClose = Number(lastCandle?.close);
  if (Number.isFinite(lastClose)) {
    lastPriceRef.current = lastClose;
  }
}

function estimateRecentVolatility(candles: CandlePoint[]): number {
  const source = candles.slice(-120).map((c) => c.close);
  if (source.length < 6) {
    return 0;
  }
  const returns: number[] = [];
  for (let idx = 1; idx < source.length; idx += 1) {
    const prev = source[idx - 1];
    const next = source[idx];
    if (Number.isFinite(prev) && prev > 0 && Number.isFinite(next)) {
      returns.push((next - prev) / prev);
    }
  }
  if (returns.length < 4) {
    return 0;
  }
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / returns.length;
  return Math.sqrt(Math.max(0, variance));
}

type AutoMotionInstrumentClass = "btc" | "eth" | "index" | "default";
type AutoMotionMode = "scalping" | "swing";
type AutoStabilityTone = "ok" | "warn" | "hot";
type AutoTargetBand = {
  okFloorSec: number;
  warnFloorSec: number;
  targetSec: number;
};
type AutoStabilityMetrics = {
  switches5m: number;
  switches1h: number;
  avgIntervalSec: number | null;
  lastSwitchAgoSec: number | null;
  sparklineBuckets: number[];
};

type FramePerfState = {
  fps: number;
  frameTimeMs: number;
  cpuLoad: number;
};

type RenderUpdateCounts = {
  candle: number;
  indicator: number;
  overlay: number;
};

type ContinuityMode = "idle" | "series-and-overlay" | "overlay-only";

type LiveRenderContinuityStats = {
  liveFrames: number;
  renderedFrames: number;
  partialFrames: number;
  coalescedFrames: number;
  looseSyncFrames: number;
  rafOverwrites: number;
  duplicateFrameSkips: number;
  throttleDeferrals: number;
  conflatedUpdates: number;
  partialUpdates: number;
  fullRedraws: number;
  updateFallbackRedraws: number;
  recoveryClears: number;
  overlayContinuityStarts: number;
  overlayContinuityFrames: number;
  overlayContinuitySettles: number;
  jumpEvents: number;
  latestJumpPx: number;
  peakJumpPx: number;
  continuityMode: ContinuityMode;
};

function createLiveRenderContinuityStats(): LiveRenderContinuityStats {
  return {
    liveFrames: 0,
    renderedFrames: 0,
    partialFrames: 0,
    coalescedFrames: 0,
    looseSyncFrames: 0,
    rafOverwrites: 0,
    duplicateFrameSkips: 0,
    throttleDeferrals: 0,
    conflatedUpdates: 0,
    partialUpdates: 0,
    fullRedraws: 0,
    updateFallbackRedraws: 0,
    recoveryClears: 0,
    overlayContinuityStarts: 0,
    overlayContinuityFrames: 0,
    overlayContinuitySettles: 0,
    jumpEvents: 0,
    latestJumpPx: 0,
    peakJumpPx: 0,
    continuityMode: "idle",
  };
}

type VolumeProfileOverlayRow = {
  key: string;
  top: number;
  height: number;
  priceMid: number;
  totalVol: number;
  widthPct: number;
  buyPct: number;
  imbalance: number;
  isPoc: boolean;
  isVah: boolean;
  isVal: boolean;
  sessionBias: "asia" | "london" | "newyork" | "mixed";
  sessionConfidence: number;
};

type VolumeProfileOverlayState = {
  rows: VolumeProfileOverlayRow[];
  vahY: number | null;
  valY: number | null;
  pocY: number | null;
  degraded: boolean;
  pausedReason: "perf" | "density" | "mode" | "lite" | "frozen" | null;
};

type FootprintOverlayRow = {
  key: string;
  top: number;
  height: number;
  price: number;
  buyVolume: number;
  sellVolume: number;
  delta: number;
  deltaRatio: number;
  imbalanceSide: "buy" | "sell" | "none";
  imbalanceStrength: number;
  absorption: boolean;
  timeLabel: string;
};

type FootprintOverlayState = {
  rows: FootprintOverlayRow[];
  degraded: boolean;
  pausedReason: "perf" | "density" | "mode" | "lite" | "frozen" | null;
};

type DomOverlayLevel = {
  key: string;
  lockKey: string;
  side: "bid" | "ask";
  price: number;
  size: number;
  intensity: number;
  isWall: boolean;
};

type DomOverlayState = {
  levels: DomOverlayLevel[];
  imbalanceRatio: number;
  degraded: boolean;
  pausedReason: "perf" | "density" | "mode" | "lite" | "frozen" | null;
};

type HeatmapOverlayBand = {
  key: string;
  top: number;
  height: number;
  opacity: number;
  side: "bid" | "ask";
  focus: "core" | "near" | "far";
};

type HeatmapOverlayState = {
  bands: HeatmapOverlayBand[];
  degraded: boolean;
  pausedReason: "perf" | "density" | "mode" | "lite" | "frozen" | null;
};

type OverlayPerfProfile = {
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

function autoMotionTargetIntervalSec(symbol: string, timeframe: string): number {
  const instrumentClass = classifyAutoMotionInstrument(symbol);
  const targets: Record<AutoMotionInstrumentClass, { m1: number; m5: number; m15: number }> = {
    btc: { m1: 9 * 60, m5: 15 * 60, m15: 22 * 60 },
    eth: { m1: 8 * 60, m5: 13 * 60, m15: 20 * 60 },
    index: { m1: 14 * 60, m5: 22 * 60, m15: 32 * 60 },
    default: { m1: 10 * 60, m5: 16 * 60, m15: 24 * 60 },
  };
  const target = targets[instrumentClass];
  const tfSeconds = timeframeSeconds(timeframe);
  if (tfSeconds <= 60) {
    return target.m1;
  }
  if (tfSeconds <= 300) {
    return target.m5;
  }
  return target.m15;
}

function autoMotionTargetBand(symbol: string, timeframe: string): AutoTargetBand {
  const targetSec = autoMotionTargetIntervalSec(symbol, timeframe);
  return {
    targetSec,
    okFloorSec: targetSec * 0.85,
    warnFloorSec: targetSec * 0.6,
  };
}

function autoMotionIntervalTone(avgIntervalSec: number | null, targetIntervalSec: number): AutoStabilityTone {
  if (avgIntervalSec === null) {
    return "ok";
  }
  if (avgIntervalSec < targetIntervalSec * 0.6) {
    return "hot";
  }
  if (avgIntervalSec < targetIntervalSec * 0.85) {
    return "warn";
  }
  return "ok";
}

function buildSparklinePath(values: number[], width: number, height: number): string {
  if (values.length === 0) {
    return "";
  }
  const maxValue = Math.max(1, ...values);
  const stepX = values.length > 1 ? width / (values.length - 1) : width;
  return values.map((value, index) => {
    const x = Number((index * stepX).toFixed(2));
    const y = Number((height - (value / maxValue) * height).toFixed(2));
    return `${index === 0 ? "M" : "L"}${x},${y}`;
  }).join(" ");
}

function autoMotionBaseThreshold(symbol: string, timeframe: string): number {
  const instrumentClass = classifyAutoMotionInstrument(symbol);
  const thresholds: Record<AutoMotionInstrumentClass, { m1: number; m5: number; m15: number }> = {
    btc: { m1: 0.0018, m5: 0.0028, m15: 0.0036 },
    eth: { m1: 0.0022, m5: 0.0032, m15: 0.0042 },
    index: { m1: 0.00075, m5: 0.00125, m15: 0.0019 },
    default: { m1: 0.0016, m5: 0.0024, m15: 0.0032 },
  };
  const threshold = thresholds[instrumentClass];
  const tfSeconds = timeframeSeconds(timeframe);
  if (tfSeconds <= 60) {
    return threshold.m1;
  }
  if (tfSeconds <= 300) {
    return threshold.m5;
  }
  return threshold.m15;
}

function autoMotionHysteresisBand(threshold: number, sigma: number): number {
  const floor = threshold * 0.09;
  const ceiling = threshold * 0.34;
  const adaptive = threshold * 0.075 + Math.abs(sigma - threshold) * 0.55;
  return clamp(adaptive, floor, ceiling);
}

function classifyAutoMotionInstrument(symbol: string): AutoMotionInstrumentClass {
  const upper = symbol.toUpperCase();
  if (upper.includes("BTC")) {
    return "btc";
  }
  if (upper.includes("ETH")) {
    return "eth";
  }
  if (
    upper.includes("SPX") || upper.includes("SP500") || upper.includes("US500")
    || upper.includes("NAS100") || upper.includes("USTEC") || upper.includes("NDX")
    || upper.includes("US30") || upper.includes("DJI")
    || upper.includes("GER40") || upper.includes("DAX")
    || upper.includes("UK100") || upper.includes("FTSE")
    || upper.includes("JPN225") || upper.includes("N225")
    || upper.includes("HK50") || upper.includes("AUS200")
    || upper.includes("CAC40") || upper.includes("EU50") || upper.includes("STOXX50")
  ) {
    return "index";
  }
  return "default";
}

function resolveAutoMotionPreset(
  symbol: string,
  timeframe: string,
  volatilitySigma: number,
  previousMode?: AutoMotionMode,
): AutoMotionMode {
  const threshold = autoMotionBaseThreshold(symbol, timeframe);
  if (!previousMode) {
    return volatilitySigma >= threshold ? "scalping" : "swing";
  }

  // Adaptive hysteresis: require a stronger move to switch modes, and loosen
  // or tighten the band based on current distance from threshold.
  const band = autoMotionHysteresisBand(threshold, volatilitySigma);
  const enterScalping = threshold + band * 0.5;
  const exitScalping = threshold - band * 0.5;

  if (previousMode === "swing") {
    return volatilitySigma >= enterScalping ? "scalping" : "swing";
  }
  return volatilitySigma <= exitScalping ? "swing" : "scalping";
}

function getChartMotionTuning(preset: ChartMotionPreset): ChartMotionTuning {
  if (preset === "stable" || preset === "swing") {
    return {
      smoothingBase: 0.092,
      smoothingDistanceScale: 0.0105,
      smoothingMax: 0.225,
      snapDistance: 0.26,
      inertiaDecayX: 0.848,
      inertiaDecayY: 0.832,
      inertiaImpulseX: 0.024,
      inertiaImpulseY: 0.018,
      inertiaImpulseClamp: 2.45,
      inertiaDriftClampX: 10,
      inertiaDriftClampY: 7.5,
      inertiaBlend: 0.24,
      feelBaseOpacity: 0.13,
      feelMaxExtraOpacity: 0.18,
      feelMaxScale: 1.008,
      formingWidthFactor: 0.7,
      formingWidthMax: 32,
    };
  }

  if (preset === "aggressive" || preset === "scalping") {
    return {
      smoothingBase: 0.195,
      smoothingDistanceScale: 0.021,
      smoothingMax: 0.47,
      snapDistance: 0.14,
      inertiaDecayX: 0.928,
      inertiaDecayY: 0.908,
      inertiaImpulseX: 0.062,
      inertiaImpulseY: 0.044,
      inertiaImpulseClamp: 6.2,
      inertiaDriftClampX: 26,
      inertiaDriftClampY: 19,
      inertiaBlend: 0.41,
      feelBaseOpacity: 0.25,
      feelMaxExtraOpacity: 0.54,
      feelMaxScale: 1.034,
      formingWidthFactor: 0.94,
      formingWidthMax: 44,
    };
  }

  return {
    smoothingBase: 0.14,
    smoothingDistanceScale: 0.015,
    smoothingMax: 0.34,
    snapDistance: 0.2,
    inertiaDecayX: 0.9,
    inertiaDecayY: 0.88,
    inertiaImpulseX: 0.042,
    inertiaImpulseY: 0.03,
    inertiaImpulseClamp: 4.5,
    inertiaDriftClampX: 18,
    inertiaDriftClampY: 14,
    inertiaBlend: 0.34,
    feelBaseOpacity: 0.2,
    feelMaxExtraOpacity: 0.35,
    feelMaxScale: 1.018,
    formingWidthFactor: 0.8,
    formingWidthMax: 38,
  };
}

function snapCssToDevicePixel(value: number): number {
  if (typeof window === "undefined") {
    return Math.round(value * 2) / 2;
  }
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  return Math.round(value * dpr) / dpr;
}

function resolveDeskBodyWidthPx(slotWidthPx: number, densityLevel: DensityLevel): number {
  const factor = densityLevel === "micro" ? 0.9 : densityLevel === "compact" ? 0.75 : 0.6;
  if (!Number.isFinite(slotWidthPx) || slotWidthPx <= 0) {
    return 1;
  }
  if (slotWidthPx < 2) {
    return densityLevel === "micro" || densityLevel === "compact" ? 2 : 1;
  }
  const minWidth = densityLevel === "micro" ? 2 : densityLevel === "compact" ? 2 : 1;
  return Math.max(minWidth, Math.floor(slotWidthPx * factor));
}

function resolveDeskBodyRadiusPx(slotWidthPx: number): number {
  return slotWidthPx < 4 ? 0 : 1;
}

function resolveDeskWickWidthPx(rangeRatio: number): number {
  if (rangeRatio > 1.45) {
    return 1.8;
  }
  if (rangeRatio > 1.15) {
    return 1.5;
  }
  return 1.2;
}

function resolveDeskCandlePriority(input: {
  open: number;
  high: number;
  low: number;
  close: number;
  wickType?: PerceptionVisualMetadata["wickType"];
  averageRange: number;
  lastPrice: number;
  activeZoneHalfRange: number;
  densityLevel: DensityLevel;
  slotWidthPx: number;
  visibleCount: number;
  viewportWidth: number;
}): {
  isLowRange: boolean;
  wickClass: "rejection" | "absorption" | "neutral";
  crowdedDensity: boolean;
  densityScore: number;
  importance: number;
  deadZone: boolean;
  suppressNoise: boolean;
  focusBoost: number;
} {
  const range = Math.max(0, input.high - input.low);
  const body = Math.abs(input.close - input.open);
  const referencePrice = Math.max(Math.abs(input.close), Math.abs(input.open), 1);
  const rangeRatio = range / Math.max(input.averageRange, 1e-6);
  const rangePct = range / referencePrice;
  const upperWick = Math.max(0, input.high - Math.max(input.open, input.close));
  const lowerWick = Math.max(0, Math.min(input.open, input.close) - input.low);
  const wickSignalRatio = Math.max(upperWick, lowerWick) / Math.max(range, 1e-6);
  const densityScore = clamp((input.visibleCount / Math.max(input.viewportWidth, 1)) * 7, 0, 1);
  const crowdedDensity = densityScore > 0.7 || input.densityLevel === "micro" || input.slotWidthPx < 12;
  const focusBoost = clamp(1 - Math.abs(input.close - input.lastPrice) / Math.max(input.activeZoneHalfRange, 1e-6), 0, 1);
  const wickClass = input.wickType
    ?? (wickSignalRatio > 0.6
      ? (upperWick >= lowerWick ? "rejection" : "absorption")
      : wickSignalRatio > 0.35
        ? (upperWick >= lowerWick ? "rejection" : "absorption")
        : "neutral");
  const importance = clamp(rangeRatio * 0.5 + wickSignalRatio * 0.4 + focusBoost * 0.1, 0, 1);
  const deadZone = densityScore > 0.6 && rangeRatio < 0.1;
  const suppressNoise = densityScore > 0.65 && rangeRatio < 0.2 && wickClass === "neutral";

  return {
    isLowRange: rangePct < 0.0015 || rangeRatio < 0.18 || body < Math.max(range * 0.22, referencePrice * 0.00008),
    wickClass,
    crowdedDensity,
    densityScore,
    importance,
    deadZone,
    suppressNoise,
    focusBoost,
  };
}

function resolveDeskExtremeCapWidthPx(bodyWidthPx: number, wickWidthPx: number, densityLevel: DensityLevel): number {
  const base = densityLevel === "micro"
    ? Math.max(2, bodyWidthPx + 1)
    : Math.max(3, bodyWidthPx * 0.72);
  return clamp(base, Math.max(2, wickWidthPx * 1.8), 8);
}

function hideNativeCandlePoint<T extends CandleRenderPoint | CandleSeriesPoint>(point: T): T {
  return {
    ...point,
    color: HIDDEN_NATIVE_CANDLE_COLOR,
    borderColor: HIDDEN_NATIVE_CANDLE_COLOR,
    wickColor: HIDDEN_NATIVE_CANDLE_COLOR,
  } as T;
}

function drawDeskRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  if (width <= 0 || height <= 0) {
    return;
  }
  if (radius <= 0) {
    ctx.fillRect(x, y, width, height);
    return;
  }
  const cappedRadius = Math.min(radius, width * 0.5, height * 0.5);
  ctx.beginPath();
  ctx.moveTo(x + cappedRadius, y);
  ctx.arcTo(x + width, y, x + width, y + height, cappedRadius);
  ctx.arcTo(x + width, y + height, x, y + height, cappedRadius);
  ctx.arcTo(x, y + height, x, y, cappedRadius);
  ctx.arcTo(x, y, x + width, y, cappedRadius);
  ctx.closePath();
  ctx.fill();
}

function strokeDeskRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  if (width <= 0 || height <= 0) {
    return;
  }
  if (radius <= 0) {
    ctx.strokeRect(x, y, width, height);
    return;
  }
  const cappedRadius = Math.min(radius, width * 0.5, height * 0.5);
  ctx.beginPath();
  ctx.moveTo(x + cappedRadius, y);
  ctx.arcTo(x + width, y, x + width, y + height, cappedRadius);
  ctx.arcTo(x + width, y + height, x, y + height, cappedRadius);
  ctx.arcTo(x, y + height, x, y, cappedRadius);
  ctx.arcTo(x, y, x + width, y, cappedRadius);
  ctx.closePath();
  ctx.stroke();
}

function getOverlayPerfProfile(
  preset: ChartMotionPreset,
  resolvedPreset: "stable" | "balanced" | "aggressive" | "scalping" | "swing",
  autoSwitches5m: number,
): OverlayPerfProfile {
  const resolved = resolvedPreset === "aggressive"
    ? "scalping"
    : resolvedPreset === "stable"
      ? "swing"
      : resolvedPreset;

  // Base profile by explicit user intent, then by resolved runtime behavior.
  const profileKey = preset === "auto"
    ? (resolved === "scalping" ? "auto-scalping" : "auto-swing")
    : resolved;

  let profile: OverlayPerfProfile;
  if (profileKey === "scalping" || profileKey === "auto-scalping") {
    profile = {
      busyFrameMs: 18.1,
      busyMinFps: 51,
      busyCpuLoad: 1.08,
      criticalFrameMs: 22.0,
      criticalMinFps: 43,
      criticalCpuLoad: 1.28,
      domLevelsBusy: 12,
      domLevelsNormal: 20,
      heatmapBandsBusy: 10,
      heatmapBandsNormal: 16,
    };
  } else if (profileKey === "swing" || profileKey === "auto-swing") {
    profile = {
      busyFrameMs: 16.6,
      busyMinFps: 56,
      busyCpuLoad: 1.0,
      criticalFrameMs: 19.4,
      criticalMinFps: 48,
      criticalCpuLoad: 1.16,
      domLevelsBusy: 8,
      domLevelsNormal: 16,
      heatmapBandsBusy: 8,
      heatmapBandsNormal: 12,
    };
  } else {
    // balanced / fallback
    profile = {
      busyFrameMs: 17.2,
      busyMinFps: 54,
      busyCpuLoad: 1.04,
      criticalFrameMs: 20.5,
      criticalMinFps: 46,
      criticalCpuLoad: 1.22,
      domLevelsBusy: 10,
      domLevelsNormal: 18,
      heatmapBandsBusy: 9,
      heatmapBandsNormal: 14,
    };
  }

  if (preset === "auto" && autoSwitches5m >= 6) {
    // Auto mode becomes slightly more conservative when switching too often.
    return {
      ...profile,
      busyFrameMs: profile.busyFrameMs - 0.5,
      busyMinFps: profile.busyMinFps + 2,
      busyCpuLoad: profile.busyCpuLoad - 0.03,
      criticalFrameMs: profile.criticalFrameMs - 0.6,
      criticalMinFps: profile.criticalMinFps + 2,
      criticalCpuLoad: profile.criticalCpuLoad - 0.03,
      domLevelsBusy: Math.max(8, profile.domLevelsBusy - 2),
      domLevelsNormal: Math.max(12, profile.domLevelsNormal - 2),
      heatmapBandsBusy: Math.max(6, profile.heatmapBandsBusy - 1),
      heatmapBandsNormal: Math.max(10, profile.heatmapBandsNormal - 1),
    };
  }

  return profile;
}

/**
 * Determine if we can use incremental update() instead of full setData().
 *
 * Returns { useUpdate: true, lastCandle } if only the last candle changed (realtime tick).
 * Returns { useUpdate: false } if data structure changed (new candle or transform).
 */
function shouldUsePartialUpdate(
  newCandles: CandleSeriesPoint[],
  prevCandles: CandleSeriesPoint[] | null,
): { useUpdate: boolean; lastCandle?: CandleSeriesPoint } {
  if (!prevCandles || prevCandles.length === 0) {
    return { useUpdate: false };
  }

  if (newCandles.length === 0) {
    return { useUpdate: false };
  }

  // Same number of candles + same time → only last candle data changed (live tick)
  if (newCandles.length === prevCandles.length) {
    const lastPrev = prevCandles[prevCandles.length - 1];
    const lastNew = newCandles[newCandles.length - 1];

    if (lastPrev.time === lastNew.time) {
      if (!hasSameRenderStyle(lastPrev, lastNew)) {
        return { useUpdate: true, lastCandle: lastNew };
      }

      // ✅ Same time = same candle, just OHLC update (realtime)
      // This is 60x faster than setData()
      return { useUpdate: true, lastCandle: lastNew };
    }
  }

  // Different number or timestamps → full redraw needed (new candle)
  return { useUpdate: false };
}

function resolveBadgeCollisions(badges: OverlayBadge[], width: number, height: number): OverlayBadge[] {
  if (badges.length <= 1) {
    return badges;
  }

  const verticalGap = 24;
  const horizontalBand = 144;
  const topLimit = 14;
  const bottomLimit = Math.max(topLimit, height - 34);

  const placed: OverlayBadge[] = [];
  const sorted = [...badges].sort((a, b) => a.top - b.top);

  for (const badge of sorted) {
    let nextTop = clamp(badge.top, topLimit, bottomLimit);
    const nextLeft = clamp(badge.left, 48, Math.max(48, width - 96));

    for (let pass = 0; pass < 10; pass += 1) {
      const collision = placed.find((candidate) => (
        Math.abs(candidate.left - nextLeft) < horizontalBand
        && Math.abs(candidate.top - nextTop) < verticalGap
      ));
      if (!collision) {
        break;
      }
      nextTop = collision.top + verticalGap;
      if (nextTop > bottomLimit) {
        nextTop = clamp(collision.top - verticalGap, topLimit, bottomLimit);
      }
    }

    placed.push({
      ...badge,
      left: nextLeft,
      top: clamp(nextTop, topLimit, bottomLimit),
    });
  }

  const byKey = new Map(placed.map((badge) => [badge.key, badge]));
  return badges.map((badge) => byKey.get(badge.key) || badge);
}

export default function InstitutionalChart({
  className,
  symbol,
  timeframe,
  visualProfile = DEFAULT_VISUAL_PROFILE,
  mode,
  interactionMode = "full",
  frozen = false,
  chartMotionPreset = "auto",
  visualMode = "auto",
  liveFeedKey,
  candles,
  overlayZones,
  liquidityZones,
  domLevels,
  heatmapLevels,
  dayVwap,
  weekVwap,
  monthVwap,
  showSessions = true,
  indicatorSeries,
  footprintRows,
  executionSignals,
  marketSimulation,
  candleTransform = "none",
  onCrosshairMove,
  onPerformanceTelemetry,
  onPerceptualTelemetry,
}: Props) {
  const resolvedVisualProfile = useMemo(() => applyVisualProfile(visualProfile), [visualProfile]);
  const isLiteMode = interactionMode === "lite";
  const autoMotionModeRef = useRef<{ key: string; mode: AutoMotionMode } | null>(null);
  const autoSwitchHistoryRef = useRef<number[]>([]);
  const autoSwitchModeRef = useRef<AutoMotionMode | null>(null);
  const autoSwitchKeyRef = useRef("");
  const autoDebugPostSignatureRef = useRef("");
  const onCrosshairMoveRef = useRef(onCrosshairMove);
  const resolvedMotionPreset = useMemo<"stable" | "balanced" | "aggressive" | "scalping" | "swing">(() => {
    if (chartMotionPreset !== "auto") {
      return chartMotionPreset;
    }
    const autoKey = `${classifyAutoMotionInstrument(symbol)}|${timeframe}`;
    const previousMode = autoMotionModeRef.current && autoMotionModeRef.current.key === autoKey
      ? autoMotionModeRef.current.mode
      : undefined;
    const sigma = estimateRecentVolatility(candles);
    const nextMode = resolveAutoMotionPreset(symbol, timeframe, sigma, previousMode);
    autoMotionModeRef.current = { key: autoKey, mode: nextMode };
    return nextMode;
  }, [candles, chartMotionPreset, symbol, timeframe]);
  const motionTuning = useMemo(() => getChartMotionTuning(resolvedMotionPreset), [resolvedMotionPreset]);
  const microTimeframeLock = useMemo(() => timeframeToMs(timeframe) <= 5_000, [timeframe]);
  const marketVolatility = useMemo(() => estimateRecentVolatility(candles), [candles]);
  const domImbalanceRatio = useMemo(() => resolveDomImbalanceRatio(domLevels), [domLevels]);
  const [autoStabilityMetrics, setAutoStabilityMetrics] = useState<AutoStabilityMetrics>({
    switches5m: 0,
    switches1h: 0,
    avgIntervalSec: null,
    lastSwitchAgoSec: null,
    sparklineBuckets: new Array(12).fill(0),
  });
  const overlayPerfProfile = useMemo(
    () => getOverlayPerfProfile(chartMotionPreset, resolvedMotionPreset, autoStabilityMetrics.switches5m),
    [autoStabilityMetrics.switches5m, chartMotionPreset, resolvedMotionPreset],
  );

  useEffect(() => {
    onCrosshairMoveRef.current = onCrosshairMove;
  }, [onCrosshairMove]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const customCandleCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const customCandleOverlayRafRef = useRef<number | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const areaSeriesRef = useRef<ISeriesApi<"Area"> | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const propCandlesRef = useRef(candles);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const indicatorSeriesMapRef = useRef<Map<string, ISeriesApi<"Line"> | ISeriesApi<"Histogram">>>(new Map());
  const [cursor, setCursor] = useState<CursorState>({
    visible: false,
    left: 0,
    top: 0,
    priceTop: 0,
    timeLeft: 0,
    price: "--",
    time: "--:--",
  });
  const cursorVisibleRef = useRef(false);
  useEffect(() => {
    propCandlesRef.current = candles;
  }, [candles]);
  useEffect(() => {
    cursorVisibleRef.current = cursor.visible;
  }, [cursor.visible]);
  const [activeCandleOverlay, setActiveCandleOverlay] = useState<ActiveCandleOverlay | null>(null);
  const [livePulse, setLivePulse] = useState<LivePulseState | null>(null);
  const [smoothedLivePulse, setSmoothedLivePulse] = useState<LivePulseState | null>(null);
  const [formingCandleTarget, setFormingCandleTarget] = useState<FormingCandleState | null>(null);
  const [formingCandle, setFormingCandle] = useState<FormingCandleState | null>(null);
  const [inertia, setInertia] = useState<InertiaState>({ driftX: 0, driftY: 0 });
  const [chartFeel, setChartFeel] = useState<ChartFeelState>({ inertiaOpacity: motionTuning.feelBaseOpacity, inertiaScale: 1 });
  const [overlayBadges, setOverlayBadges] = useState<OverlayBadge[]>([]);
  const [activeBadgeKey, setActiveBadgeKey] = useState<string | null>(null);
  const [overlayOffsets, setOverlayOffsets] = useState<Record<string, OverlayOffset>>({});
  const [draggingBadgeKey, setDraggingBadgeKey] = useState<string | null>(null);
  const [densityLevel, setDensityLevel] = useState<DensityLevel>("normal");
  const [newCandleFlash, setNewCandleFlash] = useState(0);
  const [framePerf, setFramePerf] = useState<FramePerfState>({ fps: 60, frameTimeMs: 16.7, cpuLoad: 1 });
  const [volumeProfileOverlay, setVolumeProfileOverlay] = useState<VolumeProfileOverlayState>({
    rows: [],
    vahY: null,
    valY: null,
    pocY: null,
    degraded: false,
    pausedReason: null,
  });
  const [footprintOverlay, setFootprintOverlay] = useState<FootprintOverlayState>({
    rows: [],
    degraded: false,
    pausedReason: null,
  });
  const [domOverlay, setDomOverlay] = useState<DomOverlayState>({
    levels: [],
    imbalanceRatio: 0,
    degraded: false,
    pausedReason: null,
  });
  const [heatmapOverlay, setHeatmapOverlay] = useState<HeatmapOverlayState>({
    bands: [],
    degraded: false,
    pausedReason: null,
  });
  const [chartViewportWidth, setChartViewportWidth] = useState(1280);
  const [domSelectedKey, setDomSelectedKey] = useState<string | null>(null);
  const [domLockedWalls, setDomLockedWalls] = useState<Record<string, boolean>>({});
  const [domAnchorPrice, setDomAnchorPrice] = useState<number | null>(null);
  const [domAnchorSide, setDomAnchorSide] = useState<"bid" | "ask" | null>(null);
  const [domHoverKey, setDomHoverKey] = useState<string | null>(null);
  const [domTouchPulseKey, setDomTouchPulseKey] = useState<string | null>(null);
  const [domTouchPrimedKey, setDomTouchPrimedKey] = useState<string | null>(null);
  const [vpHoverKey, setVpHoverKey] = useState<string | null>(null);
  const formingCandleSettledRef = useRef(false);

  const updateActiveCandleOverlay = useCallback((next: ActiveCandleOverlay | null) => {
    setActiveCandleOverlay((current) => {
      if (current === next) {
        return current;
      }
      if (!current || !next) {
        return next;
      }

      const leftThreshold = next.source === "crosshair" ? 1.6 : 0.9;
      const widthThreshold = next.source === "crosshair" ? 1.1 : 0.7;
      if (
        current.source === next.source
        && Math.abs(current.left - next.left) < leftThreshold
        && Math.abs(current.width - next.width) < widthThreshold
      ) {
        return current;
      }

      return next;
    });
  }, []);

  const clearCrosshairActiveOverlay = useCallback(() => {
    setActiveCandleOverlay((current) => (current?.source === "crosshair" ? null : current));
  }, []);
  const [domToast, setDomToast] = useState<{ id: number; message: string } | null>(null);
  const [isUserInteracting, setIsUserInteracting] = useState(false);
  const [workerLatencyMs, setWorkerLatencyMs] = useState<number | null>(null);
  const [gpuSafeMode, setGpuSafeMode] = useState(false);
  const [chartRecoveryEpoch, setChartRecoveryEpoch] = useState(0);
  const [layoutStableReady, setLayoutStableReady] = useState(false);
  const densityConfig = useMemo(() => getDensityConfig(densityLevel), [densityLevel]);
  const perceptualSpacingPolicy = useMemo(() => resolvePerceptualTimeScaleOptions({
    mode,
    timeframe,
    isLiteMode,
    containerWidth: chartViewportWidth,
    motionPreset: resolvedMotionPreset,
  }), [chartViewportWidth, isLiteMode, mode, resolvedMotionPreset, timeframe]);
  const [presentationStepPx, setPresentationStepPx] = useState(perceptualSpacingPolicy.barSpacing);
  const [presentationVisibleBars, setPresentationVisibleBars] = useState(perceptualSpacingPolicy.targetVisibleBars);
  const footprintRowsByTimeKey = useMemo(() => {
    const grouped = new Map<string, Array<{ buyVolume: number; sellVolume: number; delta: number }>>();
    for (const row of footprintRows || []) {
      if (!row.timeKey) {
        continue;
      }
      grouped.set(row.timeKey, [...(grouped.get(row.timeKey) || []), {
        buyVolume: Math.max(0, row.buyVolume),
        sellVolume: Math.max(0, row.sellVolume),
        delta: Number.isFinite(row.delta) ? row.delta : row.buyVolume - row.sellVolume,
      }]);
    }
    return grouped;
  }, [footprintRows]);
  const footprintBaselineVolume = useMemo(() => {
    const totals = (footprintRows || [])
      .map((row) => Math.max(0, row.buyVolume) + Math.max(0, row.sellVolume))
      .filter((value) => Number.isFinite(value) && value > 0)
      .sort((left, right) => left - right);
    if (totals.length === 0) {
      return 1;
    }
    return totals[Math.min(totals.length - 1, Math.floor(totals.length * 0.6))] || totals[totals.length - 1] || 1;
  }, [footprintRows]);
  const executionSignalByTimeKey = useMemo(() => {
    const grouped = new Map<string, PerceptualExecutionSignal>();
    for (const signal of executionSignals || []) {
      if (!signal.timeKey) {
        continue;
      }
      grouped.set(signal.timeKey, signal);
    }
    return grouped;
  }, [executionSignals]);
  const perceptualDeskMode = useMemo(() => resolvePerceptualDeskMode({
    chartMode: mode,
    timeframe,
    visibleBars: presentationVisibleBars,
    volatility: marketVolatility,
    domImbalanceRatio,
    domLevels,
    heatmapLevels,
    footprintRows,
    isLiteMode,
  }), [domImbalanceRatio, domLevels, footprintRows, heatmapLevels, isLiteMode, marketVolatility, mode, presentationVisibleBars, timeframe]);
  const dynamicCandlePresentation = useMemo(() => resolveDynamicCandlePresentation({
    spacingPolicy: perceptualSpacingPolicy,
    slotWidthPx: presentationStepPx,
    visibleBars: presentationVisibleBars,
    densityLevel,
    timeframe,
    volatility: marketVolatility,
    visualProfileName: visualProfile,
    deskMode: perceptualDeskMode,
  }), [densityLevel, marketVolatility, perceptualDeskMode, perceptualSpacingPolicy, presentationStepPx, presentationVisibleBars, timeframe, visualProfile]);
  const dragStateRef = useRef<DragState | null>(null);
  const candleStepPxRef = useRef(12);
  const lastPriceRef = useRef<number | null>(null);
  const pulseTickRef = useRef(0);
  const livePulseMetaRef = useRef<LivePulseMeta | null>(null);
  const interactionRafRef = useRef<number | null>(null);
  const hasInitializedRangeRef = useRef(false);
  const lastRangeIdentityRef = useRef("");
  const userAdjustedTimeScaleRef = useRef(false);
  const schedulerRef = useRef<RenderScheduler | null>(null);
  const chartGenerationRef = useRef(0);
  const dirtyStateRef = useRef(createDirtyState());
  // sqrt curve + tanh soft-cap → TradingView-like velocity feel
  const interactionXRef = useRef(createInteractionEngine({ friction: 0.9, sensitivity: 0.002, curve: "sqrt", maxVelocity: 0.9 }));
  const interactionYRef = useRef(createInteractionEngine({ friction: 0.92, sensitivity: 0.0024, curve: "sqrt", maxVelocity: 0.7 }));
  const wheelCursorXRef = useRef(0.5);
  const rightDragActiveRef = useRef(false);
  const rightDragLastXRef = useRef(0);
  const suppressContextMenuUntilRef = useRef(0);
  const densityLevelRef = useRef<DensityLevel>("normal");
  const prevCandleLengthRef = useRef(0);
  const renderUpdateCountsRef = useRef<RenderUpdateCounts>({ candle: 0, indicator: 0, overlay: 0 });
  const indicatorRequestTsRef = useRef(0);
  const intraCandleRafRef = useRef<number | null>(null);
  const intraCandleCurrentRef = useRef<CandleRenderPoint | null>(null);
  const intraCandleTargetRef = useRef<CandleRenderPoint | null>(null);
  const intraCandleFrameTsRef = useRef(0);
  const toastSeqRef = useRef(0);
  const domHoldTimerRef = useRef<number | null>(null);
  const domPressHandledRef = useRef(false);
  const interactionIdleTimerRef = useRef<number | null>(null);
  const overlayLastUpdateTsRef = useRef(0);
  const overlayContextKeyRef = useRef("");
  const heatmapLastComputeTsRef = useRef(0);
  const domLastComputeTsRef = useRef(0);
  const footprintLastComputeTsRef = useRef(0);
  const volumeProfileLastComputeTsRef = useRef(0);
  const lastSeriesUpdateTsRef = useRef(0);
  const lastAppliedLiveFrameSignatureRef = useRef("");
  const pendingLiveFrameSignatureRef = useRef("");
  const candleAutoscaleRangeRef = useRef<{ min: number; max: number } | null>(null);
  const areaAutoscaleRangeRef = useRef<{ min: number; max: number } | null>(null);
  const chartRecoveryAttemptsRef = useRef<Record<string, number>>({});
  const layoutWaitRafRef = useRef<number | null>(null);
  const layoutWaitTimeoutRef = useRef<number | null>(null);
  const currentTimeScalePolicyRef = useRef<PerceptualSpacingPolicy>(perceptualSpacingPolicy);
  const visibleBarsRef = useRef(0);
  const candleAutoscaleSnapshotRef = useRef<PerceptualAutoscaleSnapshot | null>(null);
  const areaAutoscaleSnapshotRef = useRef<PerceptualAutoscaleSnapshot | null>(null);
  const candleAutoscaleTelemetryRef = useRef<AutoscaleTelemetryState>({
    signature: "",
    reframeCount: 0,
    softReframes: 0,
    hardReframes: 0,
    lastTransitionMode: "init",
    lastShiftPct: 0,
  });
  const areaAutoscaleTelemetryRef = useRef<AutoscaleTelemetryState>({
    signature: "",
    reframeCount: 0,
    softReframes: 0,
    hardReframes: 0,
    lastTransitionMode: "init",
    lastShiftPct: 0,
  });
  const lastPriceDriftPxRef = useRef(0);
  const peakPriceDriftPxRef = useRef(0);
  const markUserInteraction = useCallback((holdMs = 900) => {
    if (typeof window === "undefined") {
      return;
    }
    setIsUserInteracting(true);
    if (interactionIdleTimerRef.current !== null) {
      window.clearTimeout(interactionIdleTimerRef.current);
    }
    interactionIdleTimerRef.current = window.setTimeout(() => {
      setIsUserInteracting(false);
      interactionIdleTimerRef.current = null;
    }, holdMs);
  }, []);


  // ── Partial update tracking (setData vs update) ──────────────────────────────
  const prevCandlesRef = useRef<CandleSeriesPoint[] | null>(null);
  const prevAreaDataRef = useRef<Array<{ time: number; value: number }> | null>(null);
  const hasSeededSeriesRef = useRef(false);
  const liveFrameRef = useRef<LiveChartFrame | null>(null);
  const liveFrameRafRef = useRef<number | null>(null);
  const liveFrameMetaRef = useRef<LiveChartFrameMeta | null>(null);
  const liveFramePublishedAtRef = useRef(0);
  const ghostWickRef = useRef<GhostWickState | null>(null);
  const liveFrameSchedulerRef = useRef(createLatestFrameScheduler<LiveChartFrame>({
    minFrameMs: resolvedVisualProfile.frame.minFrameMs,
    strictBucketAlignment: resolvedVisualProfile.perception.strictBucketAlignment,
  }));
  const frozenRef = useRef(frozen);
  const liveRenderContinuityRef = useRef<LiveRenderContinuityStats>(createLiveRenderContinuityStats());
  const intraCandleContinuityModeRef = useRef<ContinuityMode>("idle");
  const lastCommittedCandleRef = useRef<CandleRenderPoint | null>(null);
  const volatilityRef = useRef(marketVolatility);
  const customV3RendererEnabled = mode === "candles" && (perceptualDeskMode.authoritativeRenderer || ENABLE_CUSTOM_V3_CANDLE_RENDERER);
  const nativeCandlesAuthoritative = mode === "candles" && !customV3RendererEnabled;
  const customCandleCanvasActive = mode === "candles";

  const captureGhostWick = useCallback((previous: CandleRenderPoint | null, next: CandleRenderPoint | null) => {
    if (!isFiniteCandleRenderPoint(previous) || !isFiniteCandleRenderPoint(next) || previous.time !== next.time) {
      return;
    }
    const wickChanged = Math.abs(previous.high - next.high) > 1e-6 || Math.abs(previous.low - next.low) > 1e-6;
    if (!wickChanged) {
      return;
    }
    const color = previous.wickColor || previous.borderColor || previous.color || resolvedVisualProfile.palette.crosshair;
    ghostWickRef.current = {
      time: previous.time,
      high: previous.high,
      low: previous.low,
      color,
      createdAt: Date.now(),
      expiresAt: Date.now() + 180,
    };
  }, [resolvedVisualProfile.palette.crosshair]);

  const trackRenderJump = useCallback((previous: CandleRenderPoint | null, next: CandleRenderPoint | null) => {
    if (!previous || !next || previous.time !== next.time) {
      return;
    }
    const candleSeries = candleSeriesRef.current;
    if (!candleSeries) {
      return;
    }
    const ranges = [
      [previous.open, next.open],
      [previous.high, next.high],
      [previous.low, next.low],
      [previous.close, next.close],
    ] as const;
    let jumpPx = 0;
    for (const [fromPrice, toPrice] of ranges) {
      const fromY = candleSeries.priceToCoordinate(fromPrice);
      const toY = candleSeries.priceToCoordinate(toPrice);
      if (fromY === null || toY === null) {
        continue;
      }
      jumpPx = Math.max(jumpPx, Math.abs(toY - fromY));
    }
    liveRenderContinuityRef.current.latestJumpPx = jumpPx;
    liveRenderContinuityRef.current.peakJumpPx = Math.max(liveRenderContinuityRef.current.peakJumpPx, jumpPx);
    if (jumpPx >= 1.5) {
      liveRenderContinuityRef.current.jumpEvents += 1;
    }
  }, []);

  const drawCustomV3CandleOverlay = useCallback(() => {
    const canvas = customCandleCanvasRef.current;
    const container = containerRef.current;
    const chart = chartRef.current;
    const candleSeries = candleSeriesRef.current;
    if (!canvas || !container) {
      return;
    }

    const width = container.clientWidth;
    const height = container.clientHeight;
    const dpr = typeof window === "undefined" ? 1 : Math.max(1, window.devicePixelRatio || 1);
    const targetWidth = Math.max(1, Math.round(width * dpr));
    const targetHeight = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth;
      canvas.height = targetHeight;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (!chart || !candleSeries) {
      return;
    }

    const source = prevCandlesRef.current ?? [];
    if (source.length === 0) {
      return;
    }

    const animatedLast = intraCandleCurrentRef.current ?? lastCommittedCandleRef.current;
    const visible: Array<{
      x: number;
      open: number;
      high: number;
      low: number;
      close: number;
      timeKey?: string;
      color: string;
      wickColor: string;
      wickType?: PerceptionVisualMetadata["wickType"];
      flow?: PerceptualCandleFlowState;
      isLast: boolean;
    }> = [];
    let minVisiblePrice = Number.POSITIVE_INFINITY;
    let maxVisiblePrice = Number.NEGATIVE_INFINITY;
    let rangeSum = 0;
    let rangeCount = 0;

    for (const point of source) {
      const x = chart.timeScale().timeToCoordinate(point.time as Time);
      if (x === null || x < -48 || x > width + 48) {
        continue;
      }

      const isLast = animatedLast ? Number(point.time) === animatedLast.time : false;
      const open = isLast ? animatedLast.open : Number(point.open);
      const high = isLast ? animatedLast.high : Number(point.high);
      const low = isLast ? animatedLast.low : Number(point.low);
      const close = isLast ? animatedLast.close : Number(point.close);
      if (!Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
        continue;
      }

      visible.push({
        x,
        open,
        high,
        low,
        close,
        timeKey: point.timeKey,
        color: point.color || withAlpha(close >= open ? resolvedVisualProfile.palette.up : resolvedVisualProfile.palette.down, 0.92),
        wickColor: point.wickColor || point.color || withAlpha(close >= open ? resolvedVisualProfile.palette.up : resolvedVisualProfile.palette.down, 0.86),
        wickType: point.wickType,
        flow: point.flow,
        isLast,
      });
      minVisiblePrice = Math.min(minVisiblePrice, low);
      maxVisiblePrice = Math.max(maxVisiblePrice, high);
      rangeSum += Math.max(0, high - low);
      rangeCount += 1;
    }

    if (visible.length === 0 || !Number.isFinite(minVisiblePrice) || !Number.isFinite(maxVisiblePrice)) {
      return;
    }

    const liveFrameMeta = liveFrameMetaRef.current;
    const staleAgeMs = liveFramePublishedAtRef.current > 0 ? Math.max(0, Date.now() - liveFramePublishedAtRef.current) : 0;
    const visualHeartbeatActive = staleAgeMs >= 2_500;

    const lastPrice = visible[visible.length - 1]?.close ?? Number(source[source.length - 1]?.close ?? 0);
    if (!customV3RendererEnabled) {
      drawCanvasLivePriceHud(ctx, {
        width,
        candleSeries,
        lastPrice,
        lastOpen: visible[visible.length - 1]?.open ?? lastPrice,
        liveFrameMeta,
      });
      return;
    }
    const visibleRange = Math.max(1e-6, maxVisiblePrice - minVisiblePrice);
    const averageRange = rangeCount > 0 ? rangeSum / rangeCount : visibleRange;
    const activeZoneHalfRange = clamp(
      Math.max(averageRange * 2.2, visibleRange * 0.028),
      visibleRange * 0.02,
      visibleRange * 0.09,
    );
    const zoneTop = candleSeries.priceToCoordinate(lastPrice + activeZoneHalfRange);
    const zoneBottom = candleSeries.priceToCoordinate(lastPrice - activeZoneHalfRange);
    if (zoneTop !== null && zoneBottom !== null) {
      const top = Math.max(0, Math.min(zoneTop, zoneBottom));
      const bottom = Math.min(height, Math.max(zoneTop, zoneBottom));
      const gradient = ctx.createLinearGradient(0, top, 0, bottom);
      gradient.addColorStop(0, "rgba(0,0,0,0)");
      gradient.addColorStop(0.5, withAlpha(resolvedVisualProfile.palette.crosshair, densityLevelRef.current === "micro" ? 0.03 : 0.05));
      gradient.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, top, width, Math.max(1, bottom - top));
    }

    const drawEntries = [...visible].sort((left, right) => {
      const rank = (wickType?: PerceptionVisualMetadata["wickType"]): number => {
        if (wickType === "rejection") return 3;
        if (wickType === "absorption") return 2;
        return 1;
      };
      const rankDelta = rank(left.wickType) - rank(right.wickType);
      if (rankDelta !== 0) {
        return rankDelta;
      }
      return Number(left.isLast) - Number(right.isLast);
    });

    ctx.imageSmoothingEnabled = false;
    for (const entry of drawEntries) {
      const openY = candleSeries.priceToCoordinate(entry.open);
      const highY = candleSeries.priceToCoordinate(entry.high);
      const lowY = candleSeries.priceToCoordinate(entry.low);
      const closeY = candleSeries.priceToCoordinate(entry.close);
      if (openY === null || highY === null || lowY === null || closeY === null) {
        continue;
      }

      const centerX = snapCssToDevicePixel(entry.x);
      const rangeRatio = averageRange > 1e-6 ? clamp((entry.high - entry.low) / averageRange, 0.8, 1.8) : 1;
      const inActiveZone = Math.abs(entry.close - lastPrice) <= activeZoneHalfRange * 0.48;
      const priority = resolveDeskCandlePriority({
        open: entry.open,
        high: entry.high,
        low: entry.low,
        close: entry.close,
        wickType: entry.wickType,
        averageRange,
        lastPrice,
        activeZoneHalfRange,
        densityLevel: densityLevelRef.current,
        slotWidthPx: candleStepPxRef.current,
        visibleCount: drawEntries.length,
        viewportWidth: width,
      });
      const visualBoost = Math.pow(priority.importance, 1.8);
      let visualScale = 0.94 + visualBoost * 0.42;
      const baseBodyWidth = dynamicCandlePresentation.preferredBodyWidthPx;
      const nearLastPrice = Math.abs(entry.close - lastPrice) < Math.max((entry.high - entry.low) * 0.2, activeZoneHalfRange * 0.2);
      if (nearLastPrice) {
        visualScale *= 1.14;
      }
      if (priority.crowdedDensity && !priority.deadZone) {
        visualScale *= 1.06;
      }
      if (inActiveZone) {
        visualScale *= 1.08;
      }
      const bodyWidth = Math.max(
        priority.isLowRange ? 3 : densityLevelRef.current === "micro" ? 2.5 : 3,
        Math.round(baseBodyWidth * visualScale * (rangeRatio > 1.3 ? 0.96 : rangeRatio < 0.92 ? 1.1 : 1.03) * (1 + priority.focusBoost * 0.08)),
      );
      const radius = densityLevelRef.current === "micro" || bodyWidth < 4 ? 0 : dynamicCandlePresentation.bodyRadiusPx;
      const bodyTop = snapCssToDevicePixel(Math.min(openY, closeY));
      const bodyBottom = snapCssToDevicePixel(Math.max(openY, closeY));
      const rawBodyHeight = bodyBottom - bodyTop;
      let bodyHeight = Math.max(priority.isLowRange ? 2 : densityLevelRef.current === "micro" ? 1.5 : 2, rawBodyHeight);
      const bodyLeft = snapCssToDevicePixel(centerX - bodyWidth * 0.5);
      const wickTop = snapCssToDevicePixel(Math.min(highY, lowY));
      const wickBottom = snapCssToDevicePixel(Math.max(highY, lowY));
      const wickWidth = clamp(
        computePerceptualWickWidth(
          bodyWidth,
          typeof window === "undefined" ? 1 : Math.max(1, window.devicePixelRatio || 1),
          priority.wickClass === "rejection" ? 1.15 : priority.wickClass === "absorption" ? 1 : 0.92,
        ),
        dynamicCandlePresentation.wickWidthPx,
        Math.max(dynamicCandlePresentation.wickWidthPx, bodyWidth - 1),
      );
      const capWidth = resolveDeskExtremeCapWidthPx(bodyWidth, wickWidth, densityLevelRef.current);
      const capHalfWidth = capWidth * 0.5;
      let wickAlpha = priority.wickClass === "rejection"
        ? 1
        : priority.wickClass === "absorption"
          ? 0.85
          : 0.4;
      if (priority.isLowRange && priority.wickClass === "neutral") {
        wickAlpha *= 0.9;
      }
      if (priority.crowdedDensity && priority.wickClass === "neutral") {
        wickAlpha *= 0.52;
      }
      if (priority.deadZone) {
        wickAlpha *= 0.58;
      }
      if (priority.suppressNoise) {
        wickAlpha *= 0.72;
      }
      wickAlpha = clamp(wickAlpha * (1 + priority.focusBoost * 0.4), 0.08, 1);
      let capAlpha = inActiveZone ? 0.97 : entry.isLast ? 0.95 : 0.92;
      if (priority.wickClass === "rejection") {
        capAlpha = Math.max(capAlpha, 0.98);
      } else if (priority.crowdedDensity && priority.wickClass === "neutral") {
        capAlpha *= 0.5;
      }
      let bodyAlpha = 0.2 + priority.importance * 0.8;
      if (inActiveZone) {
        bodyAlpha = Math.max(bodyAlpha, 0.92);
      }
      if (entry.isLast) {
        bodyAlpha = Math.max(bodyAlpha, 0.9);
      }
      if (nearLastPrice) {
        bodyAlpha *= 1.5;
      }
      if (priority.isLowRange) {
        bodyAlpha = 0.85;
      }
      if (priority.deadZone) {
        bodyAlpha *= 0.62;
      }
      if (priority.suppressNoise) {
        bodyAlpha *= 0.76;
      }
      if (rawBodyHeight < 1.5) {
        bodyHeight = Math.max(bodyHeight, 1.5);
        bodyAlpha = Math.max(bodyAlpha, 0.9);
      }
      bodyAlpha = clamp(bodyAlpha * (1 + priority.focusBoost * 0.4), priority.isLowRange ? 0.84 : 0.26, 1);
      const liveFrameConfidence = entry.isLast ? liveFrameMeta?.confidence ?? 1 : 1;
      if (entry.isLast && liveFrameConfidence < 0.8) {
        const fadePenalty = liveFrameConfidence < 0.5 ? 0.58 : 0.82;
        bodyAlpha *= fadePenalty;
        wickAlpha *= fadePenalty;
        capAlpha *= fadePenalty;
      }
      const outlineAlpha = clamp((entry.isLast ? 0.3 : inActiveZone ? 0.24 : 0.2) + (priority.isLowRange ? 0.05 : 0), 0.2, 0.36);

      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.globalAlpha = wickAlpha;
      ctx.strokeStyle = entry.wickColor;
      ctx.lineWidth = wickWidth;
      ctx.globalAlpha *= rangeRatio > 1.3 ? 1.02 : 1;
      ctx.beginPath();
      ctx.moveTo(centerX, wickTop);
      ctx.lineTo(centerX, wickBottom);
      ctx.stroke();
      if (priority.wickClass === "rejection") {
        ctx.globalAlpha = Math.min(0.18, wickAlpha * 0.18);
        ctx.strokeStyle = "rgba(255,255,255,0.92)";
        ctx.lineWidth = Math.max(1, wickWidth * 0.56);
        ctx.beginPath();
        ctx.moveTo(centerX, wickTop);
        ctx.lineTo(centerX, wickBottom);
        ctx.stroke();
      }

      ctx.globalAlpha = capAlpha;
      ctx.beginPath();
      ctx.moveTo(centerX - capHalfWidth, wickTop);
      ctx.lineTo(centerX + capHalfWidth, wickTop);
      ctx.moveTo(centerX - capHalfWidth, wickBottom);
      ctx.lineTo(centerX + capHalfWidth, wickBottom);
      ctx.stroke();

      ctx.globalAlpha = bodyAlpha;
      ctx.fillStyle = entry.color;
      drawDeskRoundRect(ctx, bodyLeft, bodyTop, bodyWidth, bodyHeight, radius);

      const internalHeatAlpha = clamp(
        perceptualDeskMode.heatAlpha * (0.55 + priority.importance * 0.45) * (entry.isLast ? 1.12 : 1),
        0,
        0.28,
      );
      if (internalHeatAlpha > 0.01 && bodyHeight > 2 && bodyWidth > 2) {
        ctx.globalAlpha = 1;
        if ((entry.flow?.heatSegments.length || 0) > 0) {
          const heatSegments = entry.flow?.heatSegments || [];
          const innerLeft = bodyLeft + 0.5;
          const innerWidth = Math.max(1, bodyWidth - 1);
          const segmentHeight = Math.max(1, (Math.max(1, bodyHeight - 1)) / heatSegments.length);
          for (const [segmentIndex, segment] of heatSegments.entries()) {
            const segmentTop = bodyTop + 0.5 + segmentIndex * segmentHeight;
            const segmentBottom = segmentIndex === heatSegments.length - 1
              ? bodyBottom - 0.5
              : Math.min(bodyBottom - 0.5, segmentTop + segmentHeight);
            const segmentColor = mixColors(
              resolvedVisualProfile.palette.down,
              resolvedVisualProfile.palette.up,
              clamp(segment.buyShare + segment.deltaRatio * 0.08, 0, 1),
            );
            const segmentTint = mixColors(segmentColor, "#f8fbff", clamp(0.12 + segment.absorption * 0.24, 0.12, 0.42));
            ctx.fillStyle = withAlpha(
              segmentTint,
              internalHeatAlpha * clamp(0.42 + segment.intensity * 0.92, 0.22, 1),
            );
            ctx.fillRect(innerLeft, segmentTop, innerWidth, Math.max(1, segmentBottom - segmentTop));
          }
        } else {
          const heatGradient = ctx.createLinearGradient(bodyLeft, bodyTop, bodyLeft + bodyWidth, bodyBottom);
          heatGradient.addColorStop(0, withAlpha(entry.close >= entry.open ? resolvedVisualProfile.palette.up : resolvedVisualProfile.palette.down, internalHeatAlpha * 1.15));
          heatGradient.addColorStop(0.5, withAlpha("#f8fbff", internalHeatAlpha * 0.42));
          heatGradient.addColorStop(1, withAlpha(entry.close >= entry.open ? resolvedVisualProfile.palette.up : resolvedVisualProfile.palette.down, internalHeatAlpha * 0.18));
          ctx.fillStyle = heatGradient;
          drawDeskRoundRect(ctx, bodyLeft + 0.5, bodyTop + 0.5, Math.max(1, bodyWidth - 1), Math.max(1, bodyHeight - 1), Math.max(0, radius - 0.25));
        }
      }

      ctx.globalAlpha = outlineAlpha;
      ctx.strokeStyle = "rgba(244, 251, 255, 0.92)";
      ctx.lineWidth = 1;
      strokeDeskRoundRect(ctx, bodyLeft, bodyTop, bodyWidth, bodyHeight, radius);

      if (entry.isLast && (liveFrameMeta?.partial || liveFrameConfidence < 0.5)) {
        ctx.globalAlpha = clamp(0.26 + (1 - liveFrameMeta.confidence) * 0.44, 0.26, 0.72);
        ctx.strokeStyle = "rgba(212, 221, 231, 0.96)";
        ctx.lineWidth = 1.2;
        ctx.setLineDash([3, 2]);
        strokeDeskRoundRect(ctx, bodyLeft - 0.5, bodyTop - 0.5, bodyWidth + 1, bodyHeight + 1, radius);
        ctx.setLineDash([]);
      }

      if (entry.isLast && visualHeartbeatActive) {
        const beat = 0.5 + Math.sin(Date.now() / 280) * 0.5;
        ctx.globalAlpha = 0.08 + beat * 0.1;
        ctx.strokeStyle = withAlpha(resolvedVisualProfile.palette.crosshair, 0.9);
        ctx.lineWidth = 1;
        strokeDeskRoundRect(ctx, bodyLeft - 2, bodyTop - 2, bodyWidth + 4, bodyHeight + 4, Math.max(0, radius + 1));
      }

      if (entry.isLast) {
        ctx.globalAlpha = 0.12;
        ctx.fillStyle = "#ffffff";
        drawDeskRoundRect(ctx, bodyLeft, bodyTop, bodyWidth, bodyHeight, radius);
        if (perceptualDeskMode.mode === "execution" && perceptualDeskMode.coneAlpha > 0.01) {
          if (marketSimulation) {
            const horizonX100 = centerX + dynamicCandlePresentation.overlayWidthPx * 0.72;
            const horizonX250 = centerX + dynamicCandlePresentation.overlayWidthPx * 1.18;
            const horizonX500 = centerX + dynamicCandlePresentation.overlayWidthPx * 1.72;
            const simExpected100Y = candleSeries.priceToCoordinate(marketSimulation.t100ms.price);
            const simExpected250Y = candleSeries.priceToCoordinate(marketSimulation.t250ms.price);
            const simExpected500Y = candleSeries.priceToCoordinate(marketSimulation.t500ms.price);
            const simBestY = candleSeries.priceToCoordinate(marketSimulation.cone.best);
            const simExpectedY = candleSeries.priceToCoordinate(marketSimulation.cone.expected);
            const simWorstY = candleSeries.priceToCoordinate(marketSimulation.cone.worst);
            if (
              simExpected100Y !== null
              && simExpected250Y !== null
              && simExpected500Y !== null
              && simBestY !== null
              && simExpectedY !== null
              && simWorstY !== null
            ) {
              const simulationColor = marketSimulation.decision.action === "sell"
                ? resolvedVisualProfile.palette.down
                : resolvedVisualProfile.palette.up;
              const simulationAlpha = clamp(
                perceptualDeskMode.coneAlpha * (0.38 + marketSimulation.confidence * 0.44 + marketSimulation.execution.fillProb * 0.18),
                0.12,
                0.76,
              );
              const startX = centerX + bodyWidth * 0.45;
              const startY = (bodyTop + bodyBottom) * 0.5;
              const fanGradient = ctx.createLinearGradient(startX, startY, horizonX500, simExpectedY);
              fanGradient.addColorStop(0, withAlpha(simulationColor, simulationAlpha * 0.92));
              fanGradient.addColorStop(0.6, withAlpha(mixColors(simulationColor, "#f8fbff", 0.18), simulationAlpha * 0.42));
              fanGradient.addColorStop(1, withAlpha(simulationColor, 0));
              ctx.globalAlpha = 1;
              ctx.fillStyle = fanGradient;
              ctx.beginPath();
              ctx.moveTo(startX, startY);
              ctx.lineTo(horizonX100, simExpected100Y);
              ctx.lineTo(horizonX250, simExpected250Y);
              ctx.lineTo(horizonX500, simBestY);
              ctx.lineTo(horizonX500, simWorstY);
              ctx.lineTo(horizonX250, simExpected250Y);
              ctx.lineTo(horizonX100, simExpected100Y);
              ctx.closePath();
              ctx.fill();
              ctx.strokeStyle = withAlpha(simulationColor, simulationAlpha * 0.94);
              ctx.lineWidth = 1.1;
              ctx.beginPath();
              ctx.moveTo(startX, startY);
              ctx.lineTo(horizonX100, simExpected100Y);
              ctx.lineTo(horizonX250, simExpected250Y);
              ctx.lineTo(horizonX500, simExpected500Y);
              ctx.stroke();
              for (const [dotX, dotY] of [[horizonX100, simExpected100Y], [horizonX250, simExpected250Y], [horizonX500, simExpected500Y]] as const) {
                ctx.fillStyle = withAlpha(simulationColor, simulationAlpha);
                ctx.beginPath();
                ctx.arc(dotX, dotY, 2.4, 0, Math.PI * 2);
                ctx.fill();
              }
              ctx.strokeStyle = withAlpha(simulationColor, simulationAlpha * 0.6);
              ctx.setLineDash([3, 3]);
              ctx.beginPath();
              ctx.moveTo(horizonX500 - 2, simBestY);
              ctx.lineTo(horizonX500 + 10, simBestY);
              ctx.moveTo(horizonX500 - 2, simWorstY);
              ctx.lineTo(horizonX500 + 10, simWorstY);
              ctx.stroke();
              ctx.setLineDash([]);
              ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace';
              ctx.fillStyle = withAlpha("#f4fbff", 0.92);
              const simLabel = `${marketSimulation.stateLabel.toUpperCase()} ${marketSimulation.decision.shouldExecute ? marketSimulation.decision.action.toUpperCase() : "HOLD"}`;
              ctx.fillText(simLabel, horizonX100, Math.min(height - 8, Math.max(12, simBestY - 8)));
            }
          } else {
            const executionSignal = entry.flow?.execution || createNeutralExecutionSignal(entry.timeKey || "");
            const fillProbability = clamp(executionSignal.fillProbability, 0, 1);
            const riskPenalty = clamp(
              Math.abs(executionSignal.slippageBps) / Math.max(12, Math.abs(executionSignal.edgeBps) + 12) * 0.34
                + executionSignal.blockedRatio * 0.48
                + executionSignal.partialFillRatio * 0.18
                + executionSignal.latencyMs / 900 * 0.24,
              0,
              1,
            );
            const coneWidth = dynamicCandlePresentation.overlayWidthPx
              * (0.92 + perceptualDeskMode.executionScore * 0.92 + fillProbability * 0.9 + executionSignal.confidence * 0.68);
            const coneRight = centerX + coneWidth;
            const coneMidY = (bodyTop + bodyBottom) * 0.5;
            const coneTop = coneMidY - Math.max(4, bodyHeight * (0.72 + executionSignal.partialFillRatio * 0.35 + fillProbability * 0.2));
            const coneBottom = coneMidY + Math.max(4, bodyHeight * (0.72 + executionSignal.blockedRatio * 0.3 + (1 - fillProbability) * 0.18));
            const executionColor = executionSignal.edgeBps >= 0
              ? resolvedVisualProfile.palette.up
              : resolvedVisualProfile.palette.down;
            const coneAlpha = clamp(
              perceptualDeskMode.coneAlpha * (0.45 + fillProbability * 0.34 + executionSignal.confidence * 0.24) * (1 - riskPenalty * 0.42),
              0.08,
              0.72,
            );
            const coneGradient = ctx.createLinearGradient(centerX, coneMidY, coneRight, coneMidY);
            coneGradient.addColorStop(0, withAlpha(executionColor, coneAlpha));
            coneGradient.addColorStop(0.45, withAlpha(mixColors(executionColor, "#f8fbff", 0.2), coneAlpha * 0.42));
            coneGradient.addColorStop(1, withAlpha(executionColor, 0));
            ctx.globalAlpha = 1;
            ctx.fillStyle = coneGradient;
            ctx.beginPath();
            ctx.moveTo(centerX + bodyWidth * 0.45, coneTop);
            ctx.lineTo(coneRight, coneMidY);
            ctx.lineTo(centerX + bodyWidth * 0.45, coneBottom);
            ctx.closePath();
            ctx.fill();
            ctx.strokeStyle = withAlpha(executionColor, coneAlpha * 0.8);
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(centerX + bodyWidth * 0.35, coneMidY);
            ctx.lineTo(coneRight - 2, coneMidY);
            ctx.stroke();
          }
        }
      }
      ctx.restore();
    }

    const ghost = ghostWickRef.current;
    const lastVisible = visible[visible.length - 1];
    if (ghost && lastVisible && ghost.time === Number(lastVisible.isLast ? source[source.length - 1]?.time ?? ghost.time : ghost.time)) {
      const now = Date.now();
      if (ghost.expiresAt <= now) {
        ghostWickRef.current = null;
      } else {
        const highY = candleSeries.priceToCoordinate(ghost.high);
        const lowY = candleSeries.priceToCoordinate(ghost.low);
        if (highY !== null && lowY !== null) {
          const fade = 1 - (now - ghost.createdAt) / Math.max(1, ghost.expiresAt - ghost.createdAt);
          const centerX = snapCssToDevicePixel(lastVisible.x);
          ctx.save();
          ctx.lineCap = "round";
          ctx.strokeStyle = withAlpha(ghost.color, clamp(fade * 0.42, 0.08, 0.42));
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(centerX, snapCssToDevicePixel(Math.min(highY, lowY)));
          ctx.lineTo(centerX, snapCssToDevicePixel(Math.max(highY, lowY)));
          ctx.stroke();
          ctx.restore();
        }
      }
    }
  }, [customV3RendererEnabled, dynamicCandlePresentation.overlayWidthPx, perceptualDeskMode.coneAlpha, perceptualDeskMode.executionScore, perceptualDeskMode.heatAlpha, perceptualDeskMode.mode, resolvedVisualProfile, marketSimulation]);

  const scheduleCustomV3CandleOverlayDraw = useCallback(() => {
    if (typeof window === "undefined") {
      return;
    }
    if (customCandleOverlayRafRef.current !== null) {
      return;
    }
    customCandleOverlayRafRef.current = window.requestAnimationFrame(() => {
      customCandleOverlayRafRef.current = null;
      drawCustomV3CandleOverlay();
    });
  }, [drawCustomV3CandleOverlay]);

  const armOverlayOnlyContinuity = useCallback((previous: CandleRenderPoint | null, target: CandleRenderPoint | null) => {
    if (!customV3RendererEnabled || !previous || !target || previous.time !== target.time) {
      intraCandleCurrentRef.current = target;
      intraCandleTargetRef.current = target;
      intraCandleContinuityModeRef.current = "idle";
      liveRenderContinuityRef.current.continuityMode = "idle";
      scheduleCustomV3CandleOverlayDraw();
      return;
    }

    if (intraCandleRafRef.current) {
      window.cancelAnimationFrame(intraCandleRafRef.current);
      intraCandleRafRef.current = null;
    }

    intraCandleFrameTsRef.current = 0;
    intraCandleCurrentRef.current = normalizeRenderPoint(previous);
    intraCandleTargetRef.current = normalizeRenderPoint(target);
    intraCandleContinuityModeRef.current = "overlay-only";
    liveRenderContinuityRef.current.continuityMode = "overlay-only";
    liveRenderContinuityRef.current.overlayContinuityStarts += 1;
    trackRenderJump(previous, target);

    const animate = (frameTs: number) => {
      const current = intraCandleCurrentRef.current;
      const nextTarget = intraCandleTargetRef.current;
      if (!current || !nextTarget || !customV3RendererEnabled) {
        intraCandleRafRef.current = null;
        intraCandleFrameTsRef.current = 0;
        intraCandleContinuityModeRef.current = "idle";
        liveRenderContinuityRef.current.continuityMode = "idle";
        return;
      }

      const frameDeltaMs = intraCandleFrameTsRef.current > 0 ? frameTs - intraCandleFrameTsRef.current : 16.7;
      intraCandleFrameTsRef.current = frameTs;
      const frameScale = clamp(frameDeltaMs / 16.7, 0.65, 1.9);
      const spread = Math.max(
        Math.abs(nextTarget.open - current.open),
        Math.abs(nextTarget.high - current.high),
        Math.abs(nextTarget.low - current.low),
        Math.abs(nextTarget.close - current.close),
      );
      const alphaBase = clamp(0.2 + spread * 0.01, 0.18, 0.6);
      const alpha = 1 - Math.pow(1 - alphaBase, frameScale);

      const next: CandleRenderPoint = {
        time: nextTarget.time,
        open: current.open + (nextTarget.open - current.open) * alpha,
        high: current.high + (nextTarget.high - current.high) * alpha,
        low: current.low + (nextTarget.low - current.low) * alpha,
        close: current.close + (nextTarget.close - current.close) * alpha,
        timeKey: nextTarget.timeKey ?? current.timeKey,
        color: nextTarget.color ?? current.color,
        borderColor: nextTarget.borderColor ?? current.borderColor,
        wickColor: nextTarget.wickColor ?? current.wickColor,
        wickType: nextTarget.wickType ?? current.wickType,
        emphasis: nextTarget.emphasis ?? current.emphasis,
        styleKey: nextTarget.styleKey ?? current.styleKey,
        flow: nextTarget.flow ?? current.flow,
      };
      next.high = Math.max(next.high, next.open, next.close);
      next.low = Math.min(next.low, next.open, next.close);
      intraCandleCurrentRef.current = next;
      liveRenderContinuityRef.current.overlayContinuityFrames += 1;
      scheduleCustomV3CandleOverlayDraw();

      const settled = Math.max(
        Math.abs(next.open - nextTarget.open),
        Math.abs(next.high - nextTarget.high),
        Math.abs(next.low - nextTarget.low),
        Math.abs(next.close - nextTarget.close),
      ) < 1e-4;

      if (settled) {
        intraCandleRafRef.current = null;
        intraCandleFrameTsRef.current = 0;
        intraCandleCurrentRef.current = nextTarget;
        intraCandleContinuityModeRef.current = "idle";
        liveRenderContinuityRef.current.continuityMode = "idle";
        liveRenderContinuityRef.current.overlayContinuitySettles += 1;
        scheduleCustomV3CandleOverlayDraw();
        return;
      }

      intraCandleRafRef.current = window.requestAnimationFrame(animate);
    };

    intraCandleRafRef.current = window.requestAnimationFrame(animate);
  }, [customV3RendererEnabled, mode, scheduleCustomV3CandleOverlayDraw, trackRenderJump]);

  const overlayStorageKey = `${OVERLAY_OFFSET_STORAGE_PREFIX}.${symbol}.${timeframe}`;
  const domLockStorageKey = `${DOM_LOCK_STORAGE_PREFIX}.${symbol}.${timeframe}`;

  useEffect(() => {
    frozenRef.current = frozen;
  }, [frozen]);

  useEffect(() => {
    volatilityRef.current = marketVolatility;
  }, [marketVolatility]);

  useEffect(() => {
    liveFrameSchedulerRef.current.configure({
      minFrameMs: resolvedVisualProfile.frame.minFrameMs,
      strictBucketAlignment: resolvedVisualProfile.perception.strictBucketAlignment,
    });
  }, [resolvedVisualProfile]);

  useEffect(() => {
    scheduleCustomV3CandleOverlayDraw();
  }, [chartViewportWidth, customV3RendererEnabled, densityLevel, scheduleCustomV3CandleOverlayDraw]);

  useEffect(() => {
    if (typeof window === "undefined" || !customV3RendererEnabled) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      const ghostActive = Boolean(ghostWickRef.current && ghostWickRef.current.expiresAt > Date.now());
      const heartbeatActive = liveFramePublishedAtRef.current > 0 && Date.now() - liveFramePublishedAtRef.current >= 2_500;
      if (ghostActive || heartbeatActive) {
        scheduleCustomV3CandleOverlayDraw();
      }
    }, 120);
    return () => {
      window.clearInterval(timer);
    };
  }, [customV3RendererEnabled, scheduleCustomV3CandleOverlayDraw]);

  useEffect(() => {
    if (!schedulerRef.current) {
      schedulerRef.current = new RenderScheduler({ frameBudgetMs: 16 });
    }
    return () => {
      schedulerRef.current?.clear();
      if (interactionRafRef.current) {
        window.cancelAnimationFrame(interactionRafRef.current);
        interactionRafRef.current = null;
      }
      if (interactionIdleTimerRef.current !== null) {
        window.clearTimeout(interactionIdleTimerRef.current);
        interactionIdleTimerRef.current = null;
      }
      if (intraCandleRafRef.current) {
        window.cancelAnimationFrame(intraCandleRafRef.current);
        intraCandleRafRef.current = null;
      }
      if (customCandleOverlayRafRef.current !== null) {
        window.cancelAnimationFrame(customCandleOverlayRafRef.current);
        customCandleOverlayRafRef.current = null;
      }
      liveFrameSchedulerRef.current.cancel();
    };
  }, []);

  useEffect(() => {
    if (!liveFeedKey) {
      return undefined;
    }

    const flushLiveFrame = () => {
      liveFrameRafRef.current = null;
      if (frozenRef.current) {
        return;
      }
      const frame = liveFrameRef.current;
      const candleSeries = candleSeriesRef.current;
      if (!frame || !candleSeries || mode === "line") {
        return;
      }
      if (!isLiveFrameCompatibleWithProps(frame.candles, propCandlesRef.current, timeframe)) {
        return;
      }
      if (frame.signature && frame.signature === lastAppliedLiveFrameSignatureRef.current) {
        liveRenderContinuityRef.current.duplicateFrameSkips += 1;
        return;
      }
      const nowMs = typeof performance !== "undefined" ? performance.now() : Date.now();
      if (nowMs - lastSeriesUpdateTsRef.current < CANDLE_UPDATE_INTERVAL_MS) {
        liveRenderContinuityRef.current.throttleDeferrals += 1;
        liveFrameRafRef.current = window.requestAnimationFrame(flushLiveFrame);
        return;
      }
      liveRenderContinuityRef.current.renderedFrames += 1;

      const candleData = applyPerceptualRenderPipeline(
        sanitizeLiveFeedCandles(frame.candles, timeframe).map((bar) => ({
          ...bar,
          volume: 0,
        })),
        {
          densityLevel: densityLevelRef.current,
          visibleBars: resolveViewportVisibleBars(visibleBarsRef.current, currentTimeScalePolicyRef.current.targetVisibleBars),
          timeframe,
          volatility: volatilityRef.current,
          visualProfile,
          domImbalanceRatio,
        },
      );
      if (candleData.length === 0) {
        return;
      }
      syncCandleAutoscaleState(candleData, candleAutoscaleRangeRef, lastPriceRef, timeframe);

      if (intraCandleRafRef.current) {
        window.cancelAnimationFrame(intraCandleRafRef.current);
        intraCandleRafRef.current = null;
      }

      const safeSetCandleData = (source: CandleSeriesPoint[]) => {
        liveRenderContinuityRef.current.fullRedraws += 1;
        try {
          candleSeries.setData((customV3RendererEnabled ? source.map((point) => hideNativeCandlePoint(point)) : source) as any);
          lastSeriesUpdateTsRef.current = typeof performance !== "undefined" ? performance.now() : Date.now();
          const lastPoint = source[source.length - 1];
          lastCommittedCandleRef.current = lastPoint
            ? normalizeRenderPoint({
              time: Number(lastPoint.time),
              open: Number(lastPoint.open),
              high: Number(lastPoint.high),
              low: Number(lastPoint.low),
              close: Number(lastPoint.close),
              color: lastPoint.color,
              borderColor: lastPoint.borderColor,
              wickColor: lastPoint.wickColor,
              wickType: lastPoint.wickType,
              emphasis: lastPoint.emphasis,
              styleKey: lastPoint.styleKey,
            })
            : null;
        } catch {
          liveRenderContinuityRef.current.recoveryClears += 1;
          candleSeries.setData([] as any);
          lastSeriesUpdateTsRef.current = typeof performance !== "undefined" ? performance.now() : Date.now();
          lastCommittedCandleRef.current = null;
        }
      };

      const safeSeriesUpdate = (next: CandleRenderPoint): boolean => {
        try {
          candleSeries.update((customV3RendererEnabled ? hideNativeCandlePoint(next) : next) as any);
          lastSeriesUpdateTsRef.current = typeof performance !== "undefined" ? performance.now() : Date.now();
          lastCommittedCandleRef.current = normalizeRenderPoint(next);
          return true;
        } catch {
          return false;
        }
      };

      const { useUpdate, lastCandle } = shouldUsePartialUpdate(candleData as any, prevCandlesRef.current);
      const lastCandleValid = lastCandle
        && Number.isFinite(lastCandle.open)
        && Number.isFinite(lastCandle.high)
        && Number.isFinite(lastCandle.low)
        && Number.isFinite(lastCandle.close)
        && Number.isFinite(lastCandle.time as number);

      if (useUpdate && lastCandleValid && hasSeededSeriesRef.current) {
        const lastPoint = mergeRenderPointWithPrevious(lastCommittedCandleRef.current, {
          time: Number(lastCandle.time),
          open: Number(lastCandle.open),
          high: Number(lastCandle.high),
          low: Number(lastCandle.low),
          close: Number(lastCandle.close),
          color: lastCandle.color,
          borderColor: lastCandle.borderColor,
          wickColor: lastCandle.wickColor,
          wickType: lastCandle.wickType,
          emphasis: lastCandle.emphasis,
          styleKey: lastCandle.styleKey,
        });
        if (shouldConflateRenderPointUpdate(lastCommittedCandleRef.current, lastPoint, {
          densityLevel: densityLevelRef.current,
          visibleBars: resolveViewportVisibleBars(visibleBarsRef.current, currentTimeScalePolicyRef.current.targetVisibleBars),
          timeframe,
          volatility: volatilityRef.current,
          visualProfile,
        })) {
          liveRenderContinuityRef.current.conflatedUpdates += 1;
          hasSeededSeriesRef.current = true;
          prevCandlesRef.current = candleData as any;
          prevCandleLengthRef.current = candleData.length;
          intraCandleTargetRef.current = lastPoint;
          lastAppliedLiveFrameSignatureRef.current = frame.signature || pendingLiveFrameSignatureRef.current;
          return;
        }
        liveRenderContinuityRef.current.partialUpdates += 1;
        captureGhostWick(lastCommittedCandleRef.current, lastPoint);
        trackRenderJump(lastCommittedCandleRef.current, lastPoint);
        const priorVisualPoint = intraCandleCurrentRef.current ?? lastCommittedCandleRef.current;
        if (!isFiniteCandleRenderPoint(lastPoint) || !safeSeriesUpdate(lastPoint)) {
          liveRenderContinuityRef.current.updateFallbackRedraws += 1;
          safeSetCandleData(candleData);
        } else if (microTimeframeLock && customV3RendererEnabled) {
          armOverlayOnlyContinuity(priorVisualPoint, lastPoint);
        } else {
          intraCandleCurrentRef.current = lastPoint;
          intraCandleTargetRef.current = lastPoint;
        }
      } else {
        const finalPointPreview = (candleData[candleData.length - 1] ?? null) as CandleSeriesPoint | null;
        captureGhostWick(
          lastCommittedCandleRef.current,
          finalPointPreview
            ? {
              time: Number(finalPointPreview.time),
              open: Number(finalPointPreview.open),
              high: Number(finalPointPreview.high),
              low: Number(finalPointPreview.low),
              close: Number(finalPointPreview.close),
              color: finalPointPreview.color,
              borderColor: finalPointPreview.borderColor,
              wickColor: finalPointPreview.wickColor,
              wickType: finalPointPreview.wickType,
              emphasis: finalPointPreview.emphasis,
              styleKey: finalPointPreview.styleKey,
            }
            : null,
        );
        safeSetCandleData(candleData);
        const finalPoint = (candleData[candleData.length - 1] ?? null) as CandleSeriesPoint | null;
        intraCandleCurrentRef.current = finalPoint
          ? {
            time: Number(finalPoint.time),
            open: Number(finalPoint.open),
            high: Number(finalPoint.high),
            low: Number(finalPoint.low),
            close: Number(finalPoint.close),
            color: finalPoint.color,
            borderColor: finalPoint.borderColor,
            wickColor: finalPoint.wickColor,
            wickType: finalPoint.wickType,
            emphasis: finalPoint.emphasis,
            styleKey: finalPoint.styleKey,
          }
          : null;
        intraCandleTargetRef.current = intraCandleCurrentRef.current;
      }

      hasSeededSeriesRef.current = true;
      prevCandlesRef.current = candleData as any;
      prevCandleLengthRef.current = candleData.length;
      lastAppliedLiveFrameSignatureRef.current = frame.signature || pendingLiveFrameSignatureRef.current;
      scheduleCustomV3CandleOverlayDraw();
    };

    const unsubscribe = subscribeChartFrame(liveFeedKey, (frame) => {
      liveRenderContinuityRef.current.liveFrames += 1;
      if (frame.meta.partial) {
        liveRenderContinuityRef.current.partialFrames += 1;
      }
      if (frame.meta.coalesced) {
        liveRenderContinuityRef.current.coalescedFrames += 1;
      }
      if (frame.meta.syncStatus === "loose-sync") {
        liveRenderContinuityRef.current.looseSyncFrames += 1;
      }
      liveFrameSchedulerRef.current.schedule(frame, (latestFrame) => {
        if (frozenRef.current) {
          return;
        }
        if (latestFrame.signature && latestFrame.signature === pendingLiveFrameSignatureRef.current) {
          liveRenderContinuityRef.current.duplicateFrameSkips += 1;
          return;
        }
        liveFrameRef.current = latestFrame;
        liveFrameMetaRef.current = latestFrame.meta;
        liveFramePublishedAtRef.current = latestFrame.publishedAt;
        pendingLiveFrameSignatureRef.current = latestFrame.signature || "";
        if (liveFrameRafRef.current !== null) {
          liveRenderContinuityRef.current.rafOverwrites += 1;
          return;
        }
        liveFrameRafRef.current = window.requestAnimationFrame(flushLiveFrame);
      });
    });

    return () => {
      unsubscribe();
      liveFrameSchedulerRef.current.cancel();
      if (liveFrameRafRef.current !== null) {
        window.cancelAnimationFrame(liveFrameRafRef.current);
        liveFrameRafRef.current = null;
      }
      liveFrameRef.current = null;
      liveFrameMetaRef.current = null;
      liveFramePublishedAtRef.current = 0;
      pendingLiveFrameSignatureRef.current = "";
      lastAppliedLiveFrameSignatureRef.current = "";
    };
  }, [captureGhostWick, customV3RendererEnabled, liveFeedKey, mode, scheduleCustomV3CandleOverlayDraw, timeframe, visualProfile]);

  useEffect(() => {
    if (typeof window === "undefined" || isLiteMode || frozen) {
      setFramePerf({ fps: 60, frameTimeMs: 16.7, cpuLoad: 1 });
      return undefined;
    }

    let rafId = 0;
    let lastTs = 0;
    let emaFrameMs = 16.7;
    let accFrames = 0;
    let accMs = 0;
    let publishAt = performance.now();

    const tick = (frameTs: number) => {
      if (lastTs > 0) {
        const delta = Math.max(1, frameTs - lastTs);
        emaFrameMs = emaFrameMs * 0.88 + delta * 0.12;
        accFrames += 1;
        accMs += delta;
      }
      lastTs = frameTs;

      if (frameTs - publishAt >= 1200) {
        const fps = accMs > 0 ? (accFrames * 1000) / accMs : 60;
        const frameTimeMs = emaFrameMs;
        const cpuLoad = clamp(frameTimeMs / 16.7, 0, 3);
        setFramePerf((prev) => {
          if (
            Math.abs(prev.fps - fps) < 0.6
            && Math.abs(prev.frameTimeMs - frameTimeMs) < 0.25
            && Math.abs(prev.cpuLoad - cpuLoad) < 0.04
          ) {
            return prev;
          }
          return { fps, frameTimeMs, cpuLoad };
        });
        accFrames = 0;
        accMs = 0;
        publishAt = frameTs;
      }

      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);
    return () => {
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, [frozen, isLiteMode]);

  useEffect(() => {
    if (typeof performance === "undefined" || isLiteMode || frozen) {
      return;
    }
    indicatorRequestTsRef.current = performance.now();
  }, [candles, frozen, isLiteMode, symbol, timeframe]);

  useEffect(() => {
    if (typeof performance === "undefined") {
      return;
    }
    if (!indicatorSeries || indicatorSeries.length === 0) {
      return;
    }
    if (indicatorRequestTsRef.current <= 0) {
      return;
    }
    const sampleMs = Math.max(0, performance.now() - indicatorRequestTsRef.current);
    setWorkerLatencyMs((prev) => (prev === null ? sampleMs : prev * 0.72 + sampleMs * 0.28));
  }, [indicatorSeries]);

  useEffect(() => {
    const shortWindowMs = 5 * 60 * 1000;
    const hourWindowMs = 60 * 60 * 1000;
    const sparklineBucketsCount = 12;
    const pruneAndSync = (nowTs: number) => {
      autoSwitchHistoryRef.current = autoSwitchHistoryRef.current.filter((ts) => nowTs - ts <= hourWindowMs);
      const history = autoSwitchHistoryRef.current;
      const switches5m = history.filter((ts) => nowTs - ts <= shortWindowMs).length;
      const switches1h = history.length;

      let avgIntervalSec: number | null = null;
      if (history.length >= 2) {
        let totalGapMs = 0;
        for (let idx = 1; idx < history.length; idx += 1) {
          totalGapMs += history[idx] - history[idx - 1];
        }
        avgIntervalSec = totalGapMs / (history.length - 1) / 1000;
      }

      const lastSwitchTs = history.length > 0 ? history[history.length - 1] : null;
      const lastSwitchAgoSec = lastSwitchTs ? (nowTs - lastSwitchTs) / 1000 : null;
      const bucketSpanMs = hourWindowMs / sparklineBucketsCount;
      const windowStartTs = nowTs - hourWindowMs;
      const sparklineBuckets = new Array(sparklineBucketsCount).fill(0) as number[];
      for (const ts of history) {
        const bucketIndex = clamp(Math.floor((ts - windowStartTs) / bucketSpanMs), 0, sparklineBucketsCount - 1);
        sparklineBuckets[bucketIndex] += 1;
      }

      setAutoStabilityMetrics({
        switches5m,
        switches1h,
        avgIntervalSec,
        lastSwitchAgoSec,
        sparklineBuckets,
      });
    };

    if (chartMotionPreset !== "auto") {
      autoSwitchHistoryRef.current = [];
      autoSwitchModeRef.current = null;
      autoSwitchKeyRef.current = "";
      setAutoStabilityMetrics({
        switches5m: 0,
        switches1h: 0,
        avgIntervalSec: null,
        lastSwitchAgoSec: null,
        sparklineBuckets: new Array(12).fill(0),
      });
      return undefined;
    }

    const mode = resolvedMotionPreset === "scalping" || resolvedMotionPreset === "swing"
      ? resolvedMotionPreset
      : null;
    const nextKey = `${symbol.toUpperCase()}|${classifyAutoMotionInstrument(symbol)}|${timeframe}`;
    const now = Date.now();

    if (autoSwitchKeyRef.current !== nextKey) {
      autoSwitchKeyRef.current = nextKey;
      autoSwitchHistoryRef.current = [];
      autoSwitchModeRef.current = mode;
      setAutoStabilityMetrics({
        switches5m: 0,
        switches1h: 0,
        avgIntervalSec: null,
        lastSwitchAgoSec: null,
        sparklineBuckets: new Array(12).fill(0),
      });
    } else {
      if (mode && autoSwitchModeRef.current && mode !== autoSwitchModeRef.current) {
        autoSwitchHistoryRef.current.push(now);
      }
      autoSwitchModeRef.current = mode;
      pruneAndSync(now);
    }

    const intervalId = window.setInterval(() => {
      pruneAndSync(Date.now());
    }, 10000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [chartMotionPreset, resolvedMotionPreset, symbol, timeframe]);

  useEffect(() => {
    if (typeof window === "undefined" || chartMotionPreset !== "auto" || isLiteMode || frozen) {
      autoDebugPostSignatureRef.current = "";
      return;
    }

    const targetBand = autoMotionTargetBand(symbol, timeframe);
    const activeIndicatorCount = indicatorSeriesMapRef.current.size;
    const overlayCount =
      overlayBadges.length
      + volumeProfileOverlay.rows.length
      + footprintOverlay.rows.length
      + domOverlay.levels.length
      + heatmapOverlay.bands.length;
    const budgetUsedPct = clamp((framePerf.frameTimeMs / Math.max(1, overlayPerfProfile.busyFrameMs)) * 100, 0, 200);
    const payload = {
      key: `${symbol.toUpperCase()}|${classifyAutoMotionInstrument(symbol)}|${timeframe}`,
      symbol,
      timeframe,
      instrumentClass: classifyAutoMotionInstrument(symbol),
      resolvedMotionPreset,
      switches5m: autoStabilityMetrics.switches5m,
      switches1h: autoStabilityMetrics.switches1h,
      avgIntervalSec: autoStabilityMetrics.avgIntervalSec,
      lastSwitchAgoSec: autoStabilityMetrics.lastSwitchAgoSec,
      targetBand,
      perfThresholds: {
        busyFrameMs: overlayPerfProfile.busyFrameMs,
        busyMinFps: overlayPerfProfile.busyMinFps,
        busyCpuLoad: overlayPerfProfile.busyCpuLoad,
        criticalFrameMs: overlayPerfProfile.criticalFrameMs,
        criticalMinFps: overlayPerfProfile.criticalMinFps,
        criticalCpuLoad: overlayPerfProfile.criticalCpuLoad,
        domLevelsBusy: overlayPerfProfile.domLevelsBusy,
        domLevelsNormal: overlayPerfProfile.domLevelsNormal,
        heatmapBandsBusy: overlayPerfProfile.heatmapBandsBusy,
        heatmapBandsNormal: overlayPerfProfile.heatmapBandsNormal,
      },
      perfRuntime: {
        fps: framePerf.fps,
        frameTimeMs: framePerf.frameTimeMs,
        cpuLoad: framePerf.cpuLoad,
        budgetUsedPct,
        lodLevel: densityLevel,
        overlayCount,
        activeIndicatorCount,
        updateCounts: {
          candle: renderUpdateCountsRef.current.candle,
          indicator: renderUpdateCountsRef.current.indicator,
          overlay: renderUpdateCountsRef.current.overlay,
        },
        workerLatencyMs,
      },
      sparklineBuckets: autoStabilityMetrics.sparklineBuckets,
      updatedAt: new Date().toISOString(),
    };
    const signature = JSON.stringify(payload);
    if (signature === autoDebugPostSignatureRef.current) {
      return;
    }
    autoDebugPostSignatureRef.current = signature;

    void fetch("/api/system/chart-auto-stability", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: signature,
      keepalive: true,
      cache: "no-store",
    }).catch(() => {
      // Debug endpoint is best-effort only.
    });
  }, [
    autoStabilityMetrics.avgIntervalSec,
    autoStabilityMetrics.lastSwitchAgoSec,
    autoStabilityMetrics.sparklineBuckets,
    autoStabilityMetrics.switches1h,
    autoStabilityMetrics.switches5m,
    chartMotionPreset,
    densityLevel,
    domOverlay.levels.length,
    footprintOverlay.rows.length,
    frozen,
    isLiteMode,
    heatmapOverlay.bands.length,
    framePerf.cpuLoad,
    framePerf.fps,
    framePerf.frameTimeMs,
    overlayBadges.length,
    overlayPerfProfile.busyCpuLoad,
    overlayPerfProfile.busyFrameMs,
    overlayPerfProfile.busyMinFps,
    overlayPerfProfile.criticalCpuLoad,
    overlayPerfProfile.criticalFrameMs,
    overlayPerfProfile.criticalMinFps,
    overlayPerfProfile.domLevelsBusy,
    overlayPerfProfile.domLevelsNormal,
    overlayPerfProfile.heatmapBandsBusy,
    overlayPerfProfile.heatmapBandsNormal,
    volumeProfileOverlay.rows.length,
    workerLatencyMs,
    resolvedMotionPreset,
    symbol,
    timeframe,
  ]);

  useEffect(() => {
    if (typeof window === "undefined") {
      setOverlayOffsets({});
      return;
    }

    try {
      const serialized = window.localStorage.getItem(overlayStorageKey);
      if (!serialized) {
        setOverlayOffsets({});
      } else {
        const parsed = JSON.parse(serialized) as Record<string, OverlayOffset>;
        const sanitized = Object.entries(parsed || {}).reduce((acc, [key, value]) => {
          if (!value || typeof value !== "object") {
            return acc;
          }
          const x = Number((value as OverlayOffset).x);
          const y = Number((value as OverlayOffset).y);
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            return acc;
          }
          acc[key] = { x: clamp(x, -180, 180), y: clamp(y, -140, 140) };
          return acc;
        }, {} as Record<string, OverlayOffset>);
        setOverlayOffsets(sanitized);
      }
    } catch {
      setOverlayOffsets({});
    }

    setActiveBadgeKey(null);
    setDraggingBadgeKey(null);
    dragStateRef.current = null;
  }, [overlayStorageKey]);

  useEffect(() => {
    currentTimeScalePolicyRef.current = perceptualSpacingPolicy;
  }, [perceptualSpacingPolicy]);

  useEffect(() => {
    const resetVisibleBars = resolveViewportVisibleBars(0, perceptualSpacingPolicy.targetVisibleBars);
    visibleBarsRef.current = resetVisibleBars;
    candleStepPxRef.current = clamp(
      chartViewportWidth > 0 ? chartViewportWidth / resetVisibleBars : perceptualSpacingPolicy.barSpacing,
      2,
      80,
    );
    setPresentationStepPx(candleStepPxRef.current);
    setPresentationVisibleBars(resetVisibleBars);

    const chart = chartRef.current;
    if (!chart) {
      return;
    }

    userAdjustedTimeScaleRef.current = false;
    hasInitializedRangeRef.current = false;
    chart.timeScale().applyOptions({
      rightOffset: perceptualSpacingPolicy.rightOffset,
      barSpacing: perceptualSpacingPolicy.barSpacing,
      minBarSpacing: perceptualSpacingPolicy.minBarSpacing,
    });
  }, [chartViewportWidth, mode, perceptualSpacingPolicy.barSpacing, perceptualSpacingPolicy.minBarSpacing, perceptualSpacingPolicy.rightOffset, perceptualSpacingPolicy.targetVisibleBars, symbol, timeframe]);

  useEffect(() => {
    setPresentationStepPx((current) => (
      Math.abs(current - perceptualSpacingPolicy.barSpacing) < 0.35
        ? current
        : perceptualSpacingPolicy.barSpacing
    ));
  }, [perceptualSpacingPolicy.barSpacing]);

  useEffect(() => {
    setPresentationVisibleBars((current) => (
      Math.abs(current - perceptualSpacingPolicy.targetVisibleBars) < 1
        ? current
        : perceptualSpacingPolicy.targetVisibleBars
    ));
  }, [perceptualSpacingPolicy.targetVisibleBars]);

  useEffect(() => {
    if (!candleSeriesRef.current) {
      return;
    }
    candleSeriesRef.current.applyOptions({
      ...resolvePerceptualCandleStyleOptions(
        symbol,
        timeframe,
        densityLevel,
        marketVolatility,
        visualProfile,
        domImbalanceRatio,
        dynamicCandlePresentation,
      ),
      visible: mode !== "line",
    });
  }, [densityLevel, domImbalanceRatio, dynamicCandlePresentation, marketVolatility, mode, symbol, timeframe, visualProfile]);

  useEffect(() => {
    candleAutoscaleSnapshotRef.current = null;
    areaAutoscaleSnapshotRef.current = null;
    candleAutoscaleTelemetryRef.current = {
      signature: "",
      reframeCount: 0,
      softReframes: 0,
      hardReframes: 0,
      lastTransitionMode: "init",
      lastShiftPct: 0,
    };
    areaAutoscaleTelemetryRef.current = {
      signature: "",
      reframeCount: 0,
      softReframes: 0,
      hardReframes: 0,
      lastTransitionMode: "init",
      lastShiftPct: 0,
    };
    visibleBarsRef.current = 0;
    lastPriceDriftPxRef.current = 0;
    peakPriceDriftPxRef.current = 0;
    liveRenderContinuityRef.current = createLiveRenderContinuityStats();
    intraCandleContinuityModeRef.current = "idle";
  }, [mode, symbol, timeframe]);

  useEffect(() => {
    onPerformanceTelemetry?.({
      fps: framePerf.fps,
      frameTimeMs: framePerf.frameTimeMs,
      cpuLoad: framePerf.cpuLoad,
      workerLatencyMs,
    });
  }, [framePerf.cpuLoad, framePerf.fps, framePerf.frameTimeMs, onPerformanceTelemetry, workerLatencyMs]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }

    const publish = () => {
      const schedulerDiagnostics = liveFrameSchedulerRef.current.getDiagnostics();
      const activeAutoscaleSnapshot = mode === "line"
        ? areaAutoscaleSnapshotRef.current
        : candleAutoscaleSnapshotRef.current;
      const activeAutoscaleTelemetry = mode === "line"
        ? areaAutoscaleTelemetryRef.current
        : candleAutoscaleTelemetryRef.current;
      const pixelRatio = typeof window === "undefined" ? 1 : Math.max(1, window.devicePixelRatio || 1);
      const rawSpacingPx = candleStepPxRef.current;
      const quantizedSpacingPx = quantizePerceptualBarSpacing(rawSpacingPx);

      const payload: ChartPerceptualTelemetry = {
        engine: "v3",
        symbol,
        timeframe,
        mode,
        densityLevel,
        motionPreset: resolvedMotionPreset,
        viewportWidth: chartViewportWidth,
        visibleBars: Math.max(0, Math.round(visibleBarsRef.current || 0)),
        candleStepPx: candleStepPxRef.current,
        spacing: currentTimeScalePolicyRef.current,
        pixel: {
          pixelRatio,
          rawSpacingPx,
          quantizedSpacingPx,
          snapDeltaPx: quantizedSpacingPx - rawSpacingPx,
          spacingZone: classifySpacingZone(quantizedSpacingPx),
          preferredBodyWidthPx: dynamicCandlePresentation.preferredBodyWidthPx,
          wickWidthPx: dynamicCandlePresentation.wickWidthPx,
          overlayWidthPx: dynamicCandlePresentation.overlayWidthPx,
          bodyRadiusPx: dynamicCandlePresentation.bodyRadiusPx,
        },
        perceptual: {
          baseBodyWidthPx: dynamicCandlePresentation.baseBodyWidthPx,
          timeframeWeight: dynamicCandlePresentation.timeframeWeight,
          densityFactor: dynamicCandlePresentation.densityFactor,
          volatilityFactor: dynamicCandlePresentation.volatilityFactor,
          zoomFactor: dynamicCandlePresentation.zoomFactor,
          minBodyWidthPx: dynamicCandlePresentation.minBodyWidthPx,
          maxBodyWidthPx: dynamicCandlePresentation.maxBodyWidthPx,
          bodyToSpacingRatio: dynamicCandlePresentation.bodyToSpacingRatio,
        },
        desk: {
          mode: perceptualDeskMode.mode,
          authoritativeRenderer: perceptualDeskMode.authoritativeRenderer,
          liquidityScore: perceptualDeskMode.liquidityScore,
          heatScore: perceptualDeskMode.heatScore,
          deltaScore: perceptualDeskMode.deltaScore,
          executionScore: perceptualDeskMode.executionScore,
          confidence: perceptualDeskMode.confidence,
        },
        simulation: {
          stateLabel: marketSimulation?.stateLabel || "neutral",
          decisionAction: marketSimulation?.decision.action || "hold",
          shouldExecute: marketSimulation?.decision.shouldExecute || false,
          confidence: marketSimulation?.confidence || 0,
          liquidityCollapse: marketSimulation?.liquidityCollapse || false,
          imbalance: marketSimulation?.imbalance || 0,
          fillProbability: marketSimulation?.execution.fillProb || 0,
          slippageBps: marketSimulation?.execution.slippage || 0,
          latencyMs: marketSimulation?.execution.latency || 0,
          t100msPrice: marketSimulation?.t100ms.price ?? null,
          t250msPrice: marketSimulation?.t250ms.price ?? null,
          t500msPrice: marketSimulation?.t500ms.price ?? null,
          coneBest: marketSimulation?.cone.best ?? null,
          coneExpected: marketSimulation?.cone.expected ?? null,
          coneWorst: marketSimulation?.cone.worst ?? null,
        },
        autoscale: {
          min: activeAutoscaleSnapshot?.min ?? null,
          max: activeAutoscaleSnapshot?.max ?? null,
          rawMin: activeAutoscaleSnapshot?.rawMin ?? null,
          rawMax: activeAutoscaleSnapshot?.rawMax ?? null,
          span: activeAutoscaleSnapshot?.span ?? null,
          topPadding: activeAutoscaleSnapshot?.topPadding ?? null,
          bottomPadding: activeAutoscaleSnapshot?.bottomPadding ?? null,
          shiftPct: activeAutoscaleTelemetry.lastShiftPct,
          comfortZonePct: activeAutoscaleSnapshot?.comfortZonePct ?? 0.14,
          hysteresisLocked: activeAutoscaleSnapshot?.hysteresisLocked ?? false,
          transitionMode: activeAutoscaleTelemetry.lastTransitionMode,
          reframeCount: activeAutoscaleTelemetry.reframeCount,
          softReframes: activeAutoscaleTelemetry.softReframes,
          hardReframes: activeAutoscaleTelemetry.hardReframes,
        },
        stability: {
          lastPriceDriftPx: lastPriceDriftPxRef.current,
          peakPriceDriftPx: peakPriceDriftPxRef.current,
        },
        performance: {
          fps: framePerf.fps,
          frameTimeMs: framePerf.frameTimeMs,
          cpuLoad: framePerf.cpuLoad,
          workerLatencyMs,
        },
        continuity: {
          liveFrames: liveRenderContinuityRef.current.liveFrames,
          renderedFrames: liveRenderContinuityRef.current.renderedFrames,
          partialFrames: liveRenderContinuityRef.current.partialFrames,
          coalescedFrames: liveRenderContinuityRef.current.coalescedFrames,
          looseSyncFrames: liveRenderContinuityRef.current.looseSyncFrames,
          schedulerOverwrites: schedulerDiagnostics.overwrittenPendingCount,
          schedulerDeferrals: schedulerDiagnostics.minFrameDeferralCount,
          rafOverwrites: liveRenderContinuityRef.current.rafOverwrites,
          duplicateFrameSkips: liveRenderContinuityRef.current.duplicateFrameSkips,
          throttleDeferrals: liveRenderContinuityRef.current.throttleDeferrals,
          conflatedUpdates: liveRenderContinuityRef.current.conflatedUpdates,
          partialUpdates: liveRenderContinuityRef.current.partialUpdates,
          fullRedraws: liveRenderContinuityRef.current.fullRedraws,
          updateFallbackRedraws: liveRenderContinuityRef.current.updateFallbackRedraws,
          recoveryClears: liveRenderContinuityRef.current.recoveryClears,
          overlayContinuityStarts: liveRenderContinuityRef.current.overlayContinuityStarts,
          overlayContinuityFrames: liveRenderContinuityRef.current.overlayContinuityFrames,
          overlayContinuitySettles: liveRenderContinuityRef.current.overlayContinuitySettles,
          lostIntermediateFrames: schedulerDiagnostics.overwrittenPendingCount + liveRenderContinuityRef.current.rafOverwrites + liveRenderContinuityRef.current.conflatedUpdates,
          jumpEvents: liveRenderContinuityRef.current.jumpEvents,
          latestJumpPx: liveRenderContinuityRef.current.latestJumpPx,
          peakJumpPx: liveRenderContinuityRef.current.peakJumpPx,
          continuityMode: liveRenderContinuityRef.current.continuityMode,
        },
        updatedAt: new Date().toISOString(),
      };

      const host = containerRef.current;
      if (host) {
        host.setAttribute("data-chart-perceptual-telemetry", JSON.stringify(payload));
        host.setAttribute("data-chart-perceptual-timeframe", timeframe);
        host.setAttribute("data-chart-perceptual-updated-at", payload.updatedAt);
      }

      (window as Window & {
        __MC_CHART_PERCEPTUAL_TELEMETRY__?: ChartPerceptualTelemetry | null;
      }).__MC_CHART_PERCEPTUAL_TELEMETRY__ = payload;
      onPerceptualTelemetry?.(payload);
    };

    publish();
    const intervalId = window.setInterval(publish, 1000);
    return () => {
      const host = containerRef.current;
      if (host) {
        host.removeAttribute("data-chart-perceptual-telemetry");
        host.removeAttribute("data-chart-perceptual-timeframe");
        host.removeAttribute("data-chart-perceptual-updated-at");
      }
      window.clearInterval(intervalId);
    };
  }, [
    chartViewportWidth,
    densityLevel,
    framePerf.cpuLoad,
    framePerf.fps,
    framePerf.frameTimeMs,
    mode,
    onPerceptualTelemetry,
    perceptualDeskMode.authoritativeRenderer,
    perceptualDeskMode.confidence,
    perceptualDeskMode.deltaScore,
    perceptualDeskMode.executionScore,
    perceptualDeskMode.heatScore,
    perceptualDeskMode.liquidityScore,
    perceptualDeskMode.mode,
    resolvedMotionPreset,
    marketSimulation,
    symbol,
    timeframe,
    dynamicCandlePresentation.bodyRadiusPx,
    dynamicCandlePresentation.overlayWidthPx,
    dynamicCandlePresentation.preferredBodyWidthPx,
    dynamicCandlePresentation.wickWidthPx,
    workerLatencyMs,
  ]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    try {
      window.localStorage.setItem(overlayStorageKey, JSON.stringify(overlayOffsets));
    } catch {
      // Ignore storage write errors (private mode/quota).
    }
  }, [overlayOffsets, overlayStorageKey]);

  useEffect(() => {
    if (typeof window === "undefined") {
      setDomLockedWalls({});
      return;
    }

    try {
      const serialized = window.localStorage.getItem(domLockStorageKey);
      if (!serialized) {
        setDomLockedWalls({});
      } else {
        const parsed = JSON.parse(serialized) as Record<string, unknown>;
        const sanitized = Object.entries(parsed || {}).reduce((acc, [key, value]) => {
          if (typeof value === "boolean") {
            acc[key] = value;
          }
          return acc;
        }, {} as Record<string, boolean>);
        setDomLockedWalls(sanitized);
      }
    } catch {
      setDomLockedWalls({});
    }

    setDomSelectedKey(null);
    setDomAnchorPrice(null);
    setDomAnchorSide(null);
  }, [domLockStorageKey]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    try {
      window.localStorage.setItem(domLockStorageKey, JSON.stringify(domLockedWalls));
    } catch {
      // Ignore storage write errors (private mode/quota).
    }
  }, [domLockedWalls, domLockStorageKey]);

  useEffect(() => {
    if (typeof window === "undefined" || isLiteMode) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      if (event.altKey || event.metaKey || event.ctrlKey) {
        return;
      }
      const key = event.key.toLowerCase();

      if (key === "escape") {
        if (!domSelectedKey && domAnchorPrice === null) {
          return;
        }
        event.preventDefault();
        setDomSelectedKey(null);
        setDomAnchorPrice(null);
        toastSeqRef.current += 1;
        setDomToast({ id: toastSeqRef.current, message: "dom focus cleared" });
        return;
      }

      if (key === "r") {
        const hasAnyLocks = Object.values(domLockedWalls).some(Boolean);
        if (!hasAnyLocks) {
          return;
        }
        event.preventDefault();
        setDomLockedWalls({});
        toastSeqRef.current += 1;
        setDomToast({ id: toastSeqRef.current, message: "locks reset" });
        return;
      }

      if (key !== "l") {
        return;
      }

      const visibleWallKeys = domOverlay.levels.filter((level) => level.isWall).map((level) => level.lockKey);
      if (visibleWallKeys.length === 0) {
        return;
      }
      event.preventDefault();
      setDomLockedWalls((current) => {
        const allLocked = visibleWallKeys.every((key) => current[key]);
        const next = { ...current };
        for (const key of visibleWallKeys) {
          next[key] = !allLocked;
        }
        toastSeqRef.current += 1;
        setDomToast({
          id: toastSeqRef.current,
          message: `${allLocked ? "unlock" : "lock"} ${visibleWallKeys.length} walls`,
        });
        return next;
      });
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [domAnchorPrice, domLockedWalls, domOverlay.levels, domSelectedKey, isLiteMode]);

  useEffect(() => {
    if (!domToast || typeof window === "undefined") {
      return undefined;
    }
    const timeoutId = window.setTimeout(() => {
      setDomToast((current) => (current?.id === domToast.id ? null : current));
    }, 1350);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [domToast]);

  useEffect(() => () => {
    if (domHoldTimerRef.current !== null && typeof window !== "undefined") {
      window.clearTimeout(domHoldTimerRef.current);
      domHoldTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!draggingBadgeKey) {
      return undefined;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const dragState = dragStateRef.current;
      if (!dragState) {
        return;
      }

      const deltaX = event.clientX - dragState.startX;
      const deltaY = event.clientY - dragState.startY;
      setOverlayOffsets((current) => ({
        ...current,
        [dragState.key]: {
          x: clamp(dragState.originX + deltaX, -180, 180),
          y: clamp(dragState.originY + deltaY, -140, 140),
        },
      }));
    };

    const handlePointerUp = () => {
      dragStateRef.current = null;
      setDraggingBadgeKey(null);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [draggingBadgeKey]);

  useEffect(() => {
    if (!livePulse) {
      return undefined;
    }

    let rafId = 0;
    let previousFrameTs = 0;
    const animate = (frameTs: number) => {
      const frameDeltaMs = previousFrameTs > 0 ? frameTs - previousFrameTs : 16.7;
      previousFrameTs = frameTs;
      const frameScale = clamp(frameDeltaMs / 16.7, 0.65, 1.8);

      setSmoothedLivePulse((current) => {
        if (!current) {
          return livePulse;
        }
        const dx = livePulse.left - current.left;
        const dy = livePulse.top - current.top;
        const distance = Math.hypot(dx, dy);
        const smoothingDistanceScale = Math.min(motionTuning.smoothingDistanceScale, 0.0085);
        const alphaBase = clamp(
          motionTuning.smoothingBase + distance * smoothingDistanceScale,
          motionTuning.smoothingBase,
          motionTuning.smoothingMax,
        );
        const alpha = 1 - Math.pow(1 - alphaBase, frameScale);
        const nextLeft = current.left + dx * alpha;
        const nextTop = current.top + dy * alpha;
        const closeEnough =
          distance < motionTuning.snapDistance * 0.66
          || (
            Math.abs(nextLeft - livePulse.left) < motionTuning.snapDistance
            && Math.abs(nextTop - livePulse.top) < motionTuning.snapDistance
          );
        if (closeEnough) {
          return { ...livePulse };
        }
        return {
          left: nextLeft,
          top: nextTop,
          priceLabel: livePulse.priceLabel,
          tick: livePulse.tick,
        };
      });
      rafId = window.requestAnimationFrame(animate);
    };

    rafId = window.requestAnimationFrame(animate);
    return () => {
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, [livePulse, motionTuning]);

  useEffect(() => {
    if (isLiteMode) {
      formingCandleSettledRef.current = false;
      setFormingCandle(null);
      return undefined;
    }

    if (!formingCandleTarget) {
      formingCandleSettledRef.current = false;
      setFormingCandle(null);
      return undefined;
    }

    let rafId = 0;
    let previousFrameTs = 0;

    const animate = (frameTs: number) => {
      const frameDeltaMs = previousFrameTs > 0 ? frameTs - previousFrameTs : 16.7;
      previousFrameTs = frameTs;
      const frameScale = clamp(frameDeltaMs / 16.7, 0.65, 1.9);

      let shouldContinue = true;
      setFormingCandle((current) => {
        if (!current) {
          formingCandleSettledRef.current = false;
          return formingCandleTarget;
        }

        const deltaMax = Math.max(
          Math.abs(formingCandleTarget.left - current.left),
          Math.abs(formingCandleTarget.width - current.width),
          Math.abs(formingCandleTarget.openY - current.openY),
          Math.abs(formingCandleTarget.closeY - current.closeY),
          Math.abs(formingCandleTarget.highY - current.highY),
          Math.abs(formingCandleTarget.lowY - current.lowY),
        );
        if (formingCandleSettledRef.current && deltaMax < 1.35) {
          shouldContinue = false;
          return formingCandleTarget;
        }
        if (deltaMax >= 1.35) {
          formingCandleSettledRef.current = false;
        }
        const alphaBase = clamp(0.18 + deltaMax * 0.011, 0.16, 0.54);
        const alpha = 1 - Math.pow(1 - alphaBase, frameScale);

        const next = {
          left: current.left + (formingCandleTarget.left - current.left) * alpha,
          width: current.width + (formingCandleTarget.width - current.width) * alpha,
          openY: current.openY + (formingCandleTarget.openY - current.openY) * alpha,
          closeY: current.closeY + (formingCandleTarget.closeY - current.closeY) * alpha,
          highY: current.highY + (formingCandleTarget.highY - current.highY) * alpha,
          lowY: current.lowY + (formingCandleTarget.lowY - current.lowY) * alpha,
          opacity: current.opacity + (formingCandleTarget.opacity - current.opacity) * alpha,
          wickOpacity: current.wickOpacity + (formingCandleTarget.wickOpacity - current.wickOpacity) * alpha,
          radiusPx: formingCandleTarget.radiusPx,
          direction: formingCandleTarget.direction,
        };

        const settled = Math.max(
          Math.abs(next.left - formingCandleTarget.left),
          Math.abs(next.width - formingCandleTarget.width),
          Math.abs(next.openY - formingCandleTarget.openY),
          Math.abs(next.closeY - formingCandleTarget.closeY),
          Math.abs(next.highY - formingCandleTarget.highY),
          Math.abs(next.lowY - formingCandleTarget.lowY),
        ) < 0.5;

        if (settled) {
          formingCandleSettledRef.current = true;
          shouldContinue = false;
          return formingCandleTarget;
        }

        return next;
      });

      if (shouldContinue) {
        rafId = window.requestAnimationFrame(animate);
      }
    };

    rafId = window.requestAnimationFrame(animate);
    return () => {
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, [formingCandleTarget, isLiteMode]);

  useEffect(() => {
    if (isLiteMode || frozen) {
      return undefined;
    }

    if (USE_NATIVE_WHEEL_NAV) {
      return undefined;
    }

    const host = containerRef.current;
    if (!host) {
      return undefined;
    }

    const applyWheelTransform = (driftX: number, driftY: number) => {
      const chart = chartRef.current;
      if (!chart) {
        return;
      }
      const timeScale = chart.timeScale();
      const containerWidth = Math.max(1, containerRef.current?.clientWidth ?? 800);
      const spacingPolicy = currentTimeScalePolicyRef.current;
      if (Math.abs(driftX) > 0.001) {
        const currentScroll = timeScale.scrollPosition();
        const scrollImpulse = Math.sign(driftX) * Math.pow(Math.abs(driftX), 0.92);
        timeScale.scrollToPosition(currentScroll + scrollImpulse * 0.022, false);
      }
      if (Math.abs(driftY) > 0.001) {
        const range = timeScale.getVisibleLogicalRange();
        if (range) {
          const width = Math.max(1, range.to - range.from);
          const stepPxCurrent = clamp(containerWidth / width, 2, 80);
          // Non-linear zoom impulse: calmer micro-steps, stronger long wheel moves
          const zoomImpulse = Math.sign(driftY) * Math.pow(Math.abs(driftY), 1.12);
          const zoomingOut = zoomImpulse > 0;
          // Differentiated easing: zoom-in feels precise, zoom-out feels broader.
          const adaptiveK = zoomingOut
            ? 0.00315 + Math.log1p(width) * 0.00037
            : 0.00245 + Math.log1p(width) * 0.00031;
          // Stronger zoom multiplier for responsive wheel feel
          const boostK = adaptiveK * 1.6;
          const zoomFactor = Math.exp(zoomImpulse * boostK);
          let nextWidth = resolveStableLogicalWidthFromSpacing({
            containerWidth,
            requestedVisibleBars: width * zoomFactor,
            spacingPolicy,
          });
          // Soft snap: finer grid with very tight threshold (almost free zoom)
          const spacingTargets = [2, 4, 6, 8, 10, 12, 16, 20, 24, 28, 32, 40, 52, 64];
          const nextStepPx = clamp(containerWidth / nextWidth, 2, 80);
          let bestStep = nextStepPx;
          let bestGap = Number.POSITIVE_INFINITY;
          for (const step of spacingTargets) {
            const gap = Math.abs(step - nextStepPx);
            if (gap < bestGap) {
              bestGap = gap;
              bestStep = step;
            }
          }
          const snapThreshold = clamp(stepPxCurrent * 0.04, 0.15, 0.6);
          if (bestGap <= snapThreshold) {
            nextWidth = resolveStableLogicalWidthFromSpacing({
              containerWidth,
              requestedVisibleBars: containerWidth / bestStep,
              spacingPolicy,
            });
          }
          // Cursor-centered zoom: anchored at mouse position, not chart center
          const cursorFrac = clamp(wheelCursorXRef.current / containerWidth, 0, 1);
          const cursorLogical = range.from + cursorFrac * width;
          const leftFrac = (cursorLogical - range.from) / width;
          const rightFrac = (range.to - cursorLogical) / width;
          timeScale.setVisibleLogicalRange({
            from: cursorLogical - leftFrac * nextWidth,
            to: cursorLogical + rightFrac * nextWidth,
          });
        }
      }
    };

    const settle = () => {
      const x = interactionXRef.current.update();
      const y = interactionYRef.current.update();
      const targetDriftX = clamp(x.delta * 35, -motionTuning.inertiaDriftClampX, motionTuning.inertiaDriftClampX);
      const targetDriftY = clamp(y.delta * 42, -motionTuning.inertiaDriftClampY, motionTuning.inertiaDriftClampY);

      if (Math.abs(x.velocity) < 0.0002 && Math.abs(y.velocity) < 0.0002) {
        setInertia({ driftX: 0, driftY: 0 });
        setChartFeel({ inertiaOpacity: motionTuning.feelBaseOpacity, inertiaScale: 1 });
        interactionRafRef.current = null;
        return;
      }

      applyWheelTransform(targetDriftX, targetDriftY);
      setInertia((current) => ({
        driftX: current.driftX + (targetDriftX - current.driftX) * motionTuning.inertiaBlend,
        driftY: current.driftY + (targetDriftY - current.driftY) * motionTuning.inertiaBlend,
      }));

      const driftPower = clamp(Math.abs(x.velocity) + Math.abs(y.velocity), 0, 1);
      setChartFeel({
        inertiaOpacity: motionTuning.feelBaseOpacity + driftPower * motionTuning.feelMaxExtraOpacity,
        inertiaScale: 1 + driftPower * (motionTuning.feelMaxScale - 1),
      });
      interactionRafRef.current = window.requestAnimationFrame(settle);
    };

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      markUserInteraction(920);
      const chart = chartRef.current;
      if (!chart) return;
      const rect = host.getBoundingClientRect();
      const cursorX = clamp(event.clientX - rect.left, 0, rect.width);
      const containerWidth = Math.max(1, rect.width);
      wheelCursorXRef.current = cursorX;

      const adx = Math.abs(event.deltaX);
      const ady = Math.abs(event.deltaY);
      const hasHorizontalIntent = adx > 1;
      const hasVerticalIntent = ady > 0.5;
      const isPrecisionZoomGesture = event.ctrlKey || event.metaKey;
      const axisRatio = Math.max(adx, ady) / Math.max(1, Math.min(adx, ady));
      const nearDiagonalGesture = hasHorizontalIntent && hasVerticalIntent && axisRatio < 1.18;

      // Prefer explicit pinch/meta gestures for zoom; for diagonal trackpad motion,
      // avoid forcing pan when the intent is likely zoom.
      const shouldZoom = isPrecisionZoomGesture
        || (hasVerticalIntent && !hasHorizontalIntent)
        || (hasVerticalIntent && ady > adx * 1.08)
        || (nearDiagonalGesture && ady >= adx * 0.92);
      const shouldPan = !shouldZoom && hasHorizontalIntent;

      // ── Horizontal scroll (panning) with inertia ──
      if (shouldPan) {
        userAdjustedTimeScaleRef.current = true;
        interactionXRef.current.onWheel(-event.deltaX);
        if (!interactionRafRef.current) {
          const scrollSettle = () => {
            const x = interactionXRef.current.update();
            if (Math.abs(x.velocity) < 0.0002) {
              interactionRafRef.current = null;
              return;
            }
            const scrollDrift = clamp(x.delta * 35, -motionTuning.inertiaDriftClampX, motionTuning.inertiaDriftClampX);
            if (Math.abs(scrollDrift) > 0.001) {
              const ts = chart.timeScale();
              const curPos = ts.scrollPosition();
              const impulse = Math.sign(scrollDrift) * Math.pow(Math.abs(scrollDrift), 0.92);
              ts.scrollToPosition(curPos + impulse * 0.022, false);
            }
            interactionRafRef.current = window.requestAnimationFrame(scrollSettle);
          };
          interactionRafRef.current = window.requestAnimationFrame(scrollSettle);
        }
        return; // don't also zoom when panning
      }

      // ── Vertical zoom (direct, NO inertia — sticks where you leave it) ──
      if (shouldZoom) {
        const ts = chart.timeScale();
        const range = ts.getVisibleLogicalRange();
        if (range) {
          userAdjustedTimeScaleRef.current = true;
          const width = Math.max(1, range.to - range.from);
          const spacingPolicy = currentTimeScalePolicyRef.current;
          // Zoom direction: scroll-up (deltaY<0) = zoom IN (fewer bars); scroll-down = zoom OUT
          const zoomDelta = event.deltaY;
          const zoomK = 0.0012;
          const zoomFactor = Math.exp(zoomDelta * zoomK);
          const nextWidth = resolveStableLogicalWidthFromSpacing({
            containerWidth,
            requestedVisibleBars: width * zoomFactor,
            spacingPolicy,
          });
          // Cursor-centered zoom
          const cursorFrac = clamp(cursorX / containerWidth, 0, 1);
          const cursorLogical = range.from + cursorFrac * width;
          const leftFrac = (cursorLogical - range.from) / width;
          const rightFrac = (range.to - cursorLogical) / width;
          ts.setVisibleLogicalRange({
            from: cursorLogical - leftFrac * nextWidth,
            to: cursorLogical + rightFrac * nextWidth,
          });
        }
      }
    };

    const shouldHandleChartPointer = (target: EventTarget | null) => {
      if (!(target instanceof Element)) {
        return false;
      }
      return Boolean(target.closest(".chart-canvas-host"));
    };

    const stopRightDrag = () => {
      if (!rightDragActiveRef.current) {
        return;
      }
      rightDragActiveRef.current = false;
      host.classList.remove("chart-time-pan-active");
    };

    const onMouseDown = (event: MouseEvent) => {
      if (event.button !== 0 || !shouldHandleChartPointer(event.target)) {
        return;
      }
      rightDragActiveRef.current = true;
      rightDragLastXRef.current = event.clientX;
      userAdjustedTimeScaleRef.current = true;
      markUserInteraction(1200);
      host.classList.add("chart-time-pan-active");
      event.preventDefault();
    };

    const onMouseMove = (event: MouseEvent) => {
      if (rightDragActiveRef.current) {
        event.preventDefault();
        const chart = chartRef.current;
        if (!chart) {
          return;
        }
        const deltaX = event.clientX - rightDragLastXRef.current;
        rightDragLastXRef.current = event.clientX;
        if (Math.abs(deltaX) > 0.25) {
          event.preventDefault();
          userAdjustedTimeScaleRef.current = true;
          markUserInteraction(1200);
          const timeScale = chart.timeScale();
          const currentScroll = timeScale.scrollPosition();
          const impulse = clamp(deltaX / 10, -5, 5);
          timeScale.scrollToPosition(currentScroll - impulse, false);
        }
        return;
      }

      if ((event.buttons & 1) === 1) {
        userAdjustedTimeScaleRef.current = true;
        markUserInteraction(900);
      }
    };

    const onMouseUp = (event: MouseEvent) => {
      if (event.button === 0 || rightDragActiveRef.current) {
        stopRightDrag();
      }
    };

    const onContextMenu = (event: MouseEvent) => {
      if (rightDragActiveRef.current) {
        event.preventDefault();
      }
    };

    host.addEventListener("wheel", onWheel, { passive: false });
    host.addEventListener("mousedown", onMouseDown);
    host.addEventListener("contextmenu", onContextMenu);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("contextmenu", onContextMenu);
    window.addEventListener("blur", stopRightDrag);

    return () => {
      host.removeEventListener("wheel", onWheel);
      host.removeEventListener("mousedown", onMouseDown);
      host.removeEventListener("contextmenu", onContextMenu);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("contextmenu", onContextMenu);
      window.removeEventListener("blur", stopRightDrag);
      stopRightDrag();
      if (interactionRafRef.current) {
        window.cancelAnimationFrame(interactionRafRef.current);
        interactionRafRef.current = null;
      }
      interactionXRef.current.reset();
      interactionYRef.current.reset();
    };
  }, [frozen, isLiteMode, markUserInteraction, motionTuning]);

  // ── Indicator series lifecycle with viewport culling ─────────────────────────
  // Sync the indicatorSeriesMap with the current `indicatorSeries` prop.
  // Creates new LineSeries for new indicator outputs, removes stale ones.
  // VIEWPORT CULLING: Skip rendering hidden indicators (lite mode / frozen).
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) {
      return;
    }

    const suppressMainPaneIndicators = mode === "candles" && chartViewportWidth < 480;

    // Filter: overlay indicators, but SKIP if in lite mode (viewport culling)
    // Only render overlays in full mode
    const overlayOnly = (indicatorSeries ?? [])
      .filter((s) => s.pane === "main")
      .filter((s) => !isLiteMode && !suppressMainPaneIndicators); // ← VIEWPORT CULLING: skip overlay indicators if lite or compact mobile

    // This chart instance has no dedicated sub-pane. Rendering sub indicators on the
    // main right price scale corrupts autoscale with oscillator domains.
    const allDesiredSeries = overlayOnly;
    const desiredKeys = new Set(allDesiredSeries.map((s) => `${s.indicatorId}:${s.outputKey}`));
    const existingMap = indicatorSeriesMapRef.current;

    // Remove series no longer in the desired set (or in viewport)
    for (const [key, series] of existingMap.entries()) {
      if (!desiredKeys.has(key)) {
        try {
          chart.removeSeries(series);
        } catch {
          // Series may already be removed if chart was recreated
        }
        existingMap.delete(key);
      }
    }

    const pendingIndicatorUpdates: Array<{ series: ISeriesApi<"Line">; data: Array<{ time: UTCTimestamp; value: number }> }> = [];

    // Add or update series (only those in viewport)
    for (const s of allDesiredSeries) {
      const key = `${s.indicatorId}:${s.outputKey}`;
      let lwSeries = existingMap.get(key) as ISeriesApi<"Line"> | undefined;
      const options: LineSeriesPartialOptions & {
        autoscaleInfoProvider?: (baseImplementation: (() => { margins?: { above: number; below: number } } | null) | undefined) => { priceRange?: { minValue: number; maxValue: number }; margins?: { above: number; below: number } } | null;
      } = {
        color: s.color,
        lineWidth: (s.lineWidth ?? 1) as 1 | 2 | 3 | 4,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        priceScaleId: "right",
      };

      if (!lwSeries) {
        lwSeries = chart.addLineSeries(options);
        existingMap.set(key, lwSeries);
      } else {
        lwSeries.applyOptions(options);
      }

      const formattedData = s.data.map((point) => ({
        time: point.time as UTCTimestamp,
        value: point.value,
      }));
      pendingIndicatorUpdates.push({ series: lwSeries, data: formattedData });
    }

    if (pendingIndicatorUpdates.length > 0) {
      dirtyStateRef.current.indicator = true;
      const scheduler = schedulerRef.current;
      const chartGeneration = chartGenerationRef.current;
      const applyUpdates = () => {
        if (!dirtyStateRef.current.indicator) {
          return;
        }
        if (chartGenerationRef.current !== chartGeneration || chartRef.current !== chart) {
          return;
        }
        for (const update of pendingIndicatorUpdates) {
          try {
            update.series.setData(update.data);
          } catch {
            // Ignore malformed or transient data order issues.
          }
        }
        renderUpdateCountsRef.current.indicator += 1;
        dirtyStateRef.current.indicator = false;
      };
      if (scheduler) {
        scheduler.enqueue({ type: "indicator", priority: LAYER_PRIORITY.indicator, callback: applyUpdates });
      } else {
        applyUpdates();
      }
    }
  }, [frozen, isLiteMode, indicatorSeries, mode, chartViewportWidth]);

  useEffect(() => {
    const host = containerRef.current;
    setLayoutStableReady(false);

    if (layoutWaitRafRef.current !== null) {
      window.cancelAnimationFrame(layoutWaitRafRef.current);
      layoutWaitRafRef.current = null;
    }
    if (layoutWaitTimeoutRef.current !== null) {
      window.clearTimeout(layoutWaitTimeoutRef.current);
      layoutWaitTimeoutRef.current = null;
    }

    if (!host) {
      return undefined;
    }

    let cancelled = false;
    let stableFrames = 0;
    let lastWidth = -1;
    let lastHeight = -1;

    const markReady = () => {
      if (cancelled) {
        return;
      }
      setLayoutStableReady(true);
      if (layoutWaitRafRef.current !== null) {
        window.cancelAnimationFrame(layoutWaitRafRef.current);
        layoutWaitRafRef.current = null;
      }
      if (layoutWaitTimeoutRef.current !== null) {
        window.clearTimeout(layoutWaitTimeoutRef.current);
        layoutWaitTimeoutRef.current = null;
      }
    };

    const waitForStableLayout = () => {
      if (cancelled) {
        return;
      }
      const width = Math.max(0, Math.floor(host.offsetWidth || host.clientWidth || 0));
      const height = Math.max(0, Math.floor(host.offsetHeight || host.clientHeight || 0));
      const hasSize = width > 0 && height > 0;

      if (hasSize && width === lastWidth && height === lastHeight) {
        stableFrames += 1;
      } else {
        stableFrames = 0;
      }

      lastWidth = width;
      lastHeight = height;

      if (hasSize && stableFrames >= MIN_STABLE_LAYOUT_FRAMES) {
        markReady();
        return;
      }

      layoutWaitRafRef.current = window.requestAnimationFrame(waitForStableLayout);
    };

    layoutWaitRafRef.current = window.requestAnimationFrame(waitForStableLayout);
    layoutWaitTimeoutRef.current = window.setTimeout(() => {
      const width = Math.max(0, Math.floor(host.offsetWidth || host.clientWidth || 0));
      const height = Math.max(0, Math.floor(host.offsetHeight || host.clientHeight || 0));
      if (width > 0 && height > 0) {
        markReady();
      }
    }, STABLE_LAYOUT_FALLBACK_MS);

    return () => {
      cancelled = true;
      if (layoutWaitRafRef.current !== null) {
        window.cancelAnimationFrame(layoutWaitRafRef.current);
        layoutWaitRafRef.current = null;
      }
      if (layoutWaitTimeoutRef.current !== null) {
        window.clearTimeout(layoutWaitTimeoutRef.current);
        layoutWaitTimeoutRef.current = null;
      }
    };
  }, [chartRecoveryEpoch, isLiteMode, mode, symbol, timeframe]);

  useEffect(() => {
    if (!containerRef.current) {
      return undefined;
    }
    if (!layoutStableReady) {
      return undefined;
    }

    const chartGeneration = chartGenerationRef.current + 1;
    chartGenerationRef.current = chartGeneration;
    const autoSizeSupported = typeof ResizeObserver !== "undefined";
    const enableAutoSize = autoSizeSupported;

    const initialRect = containerRef.current.getBoundingClientRect();
    const initialWidth = Math.max(1, Math.floor(initialRect.width || containerRef.current.clientWidth || 1));
    const initialHeight = Math.max(1, Math.floor(initialRect.height || containerRef.current.clientHeight || 1));
    const timeScalePolicy = resolvePerceptualTimeScaleOptions({
      mode,
      timeframe,
      isLiteMode,
      containerWidth: initialWidth,
      motionPreset: resolvedMotionPreset,
    });
    currentTimeScalePolicyRef.current = timeScalePolicy;

    const chart = createChart(containerRef.current, {
      ...(enableAutoSize ? { autoSize: true } : { width: initialWidth, height: initialHeight }),
      layout: {
        background: { type: ColorType.Solid, color: resolvedVisualProfile.palette.background },
        textColor: withAlpha(resolvedVisualProfile.palette.text, 0.65),
        fontSize: 12,
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.025)" },
        horzLines: { color: "rgba(255,255,255,0.025)" },
      },
      rightPriceScale: {
        borderColor: "rgba(255,255,255,0.08)",
        scaleMargins: { top: 0.1, bottom: 0.12 },
      },
      timeScale: {
        visible: true,
        borderColor: "rgba(255,255,255,0.08)",
        timeVisible: true,
        secondsVisible: true,
        ticksVisible: true,
        fixLeftEdge: false,
        fixRightEdge: false,
        rightOffset: timeScalePolicy.rightOffset,
        barSpacing: timeScalePolicy.barSpacing,
        minBarSpacing: timeScalePolicy.minBarSpacing,
        minimumHeight: isLiteMode ? 24 : 30,
        tickMarkFormatter: (time: Time) => formatCursorTime(time, timeframe),
      },
      localization: {
        priceFormatter: formatCompactPrice,
      },
      crosshair: {
        mode: CrosshairMode.Magnet,
        vertLine: {
          color: withAlpha(resolvedVisualProfile.palette.crosshair, 0.72),
          width: 1,
          labelBackgroundColor: resolvedVisualProfile.palette.labelBackground,
        },
        horzLine: {
          color: withAlpha(resolvedVisualProfile.palette.crosshair, 0.72),
          width: 1,
          labelBackgroundColor: resolvedVisualProfile.palette.labelBackground,
        },
      },
      handleScroll: {
        mouseWheel: USE_NATIVE_WHEEL_NAV,
        pressedMouseMove: !isLiteMode,
        horzTouchDrag: true,
        vertTouchDrag: false,
      },
      handleScale: {
        mouseWheel: USE_NATIVE_WHEEL_NAV,
        pinch: !isLiteMode,
        axisPressedMouseMove: !isLiteMode,
      },
    });

    const candleSeries = chart.addCandlestickSeries({
      ...CANDLE_OPTIONS,
      autoscaleInfoProvider: (baseImplementation: (() => { margins?: { above: number; below: number } } | null) | undefined) => (
        buildSeriesAutoscaleInfo(
          baseImplementation,
          candleAutoscaleRangeRef.current,
          candleAutoscaleSnapshotRef,
          candleAutoscaleTelemetryRef,
          buildPerceptualAutoscaleOptions({
            timeframe,
            densityLevel: densityLevelRef.current,
            visibleBars: visibleBarsRef.current,
            lastPrice: lastPriceRef.current,
            driftPx: lastPriceDriftPxRef.current,
            visualProfile,
          }),
        )
      ),
    } as any);
    const areaSeries = chart.addAreaSeries({
      ...AREA_OPTIONS,
      autoscaleInfoProvider: (baseImplementation: (() => { margins?: { above: number; below: number } } | null) | undefined) => (
        buildSeriesAutoscaleInfo(
          baseImplementation,
          areaAutoscaleRangeRef.current,
          areaAutoscaleSnapshotRef,
          areaAutoscaleTelemetryRef,
          buildPerceptualAutoscaleOptions({
            timeframe,
            densityLevel: densityLevelRef.current,
            visibleBars: visibleBarsRef.current,
            lastPrice: lastPriceRef.current,
            driftPx: lastPriceDriftPxRef.current,
            visualProfile,
          }),
        )
      ),
    } as any);
    if (typeof (candleSeries as any).setSeriesOrder === "function") {
      (candleSeries as any).setSeriesOrder(10);
    }
    if (typeof (areaSeries as any).setSeriesOrder === "function") {
      (areaSeries as any).setSeriesOrder(5);
    }
    chartRef.current = chart;
    areaSeriesRef.current = areaSeries;
    candleSeriesRef.current = candleSeries;

    let resizeRecoveryRaf: number | null = null;
    let staleChartRecoveryRaf: number | null = null;
    let staleChartRecoveryTimer: number | null = null;
    let lastMeasuredSize = { width: initialWidth, height: initialHeight };
    const recoveryScopeKey = `${symbol}|${timeframe}|${mode}|${isLiteMode ? "lite" : "full"}`;

    const chartUsesAutoSize = (liveChart: IChartApi) => {
      const candidate = liveChart as IChartApi & { autoSizeActive?: () => boolean };
      if (typeof candidate.autoSizeActive === "function") {
        return candidate.autoSizeActive();
      }
      return enableAutoSize;
    };

    const queueChartRecreation = (width: number, height: number) => {
      const signature = `${recoveryScopeKey}|${width}x${height}`;
      const attempts = chartRecoveryAttemptsRef.current[signature] ?? 0;
      if (attempts >= MAX_STALE_CHART_RECOVERY_ATTEMPTS) {
        return;
      }
      if (staleChartRecoveryRaf !== null) {
        window.cancelAnimationFrame(staleChartRecoveryRaf);
      }
      if (staleChartRecoveryTimer !== null) {
        window.clearTimeout(staleChartRecoveryTimer);
      }
      staleChartRecoveryRaf = window.requestAnimationFrame(() => {
        staleChartRecoveryRaf = null;
        staleChartRecoveryTimer = window.setTimeout(() => {
          staleChartRecoveryTimer = null;
          const host = containerRef.current;
          if (!host) {
            return;
          }
          const rect = host.getBoundingClientRect();
          const stableWidth = Math.max(1, Math.floor(rect.width || host.clientWidth || 1));
          const stableHeight = Math.max(1, Math.floor(rect.height || host.clientHeight || 1));
          if (Math.abs(stableWidth - width) > 2 || Math.abs(stableHeight - height) > 2) {
            return;
          }
          if (!chartCanvasBitmapLooksStale(host, stableWidth, stableHeight)) {
            return;
          }
          chartRecoveryAttemptsRef.current[signature] = attempts + 1;
          setChartRecoveryEpoch((value) => value + 1);
        }, STALE_CHART_LAYOUT_SETTLE_MS);
      });
    };

    const resizeChart = (liveChart: IChartApi, width: number, height: number) => {
      if (chartUsesAutoSize(liveChart)) {
        return;
      }
      try {
        (liveChart as IChartApi & { resize: (width: number, height: number, forceRepaint?: boolean) => void }).resize(width, height, true);
      } catch {
        liveChart.resize(width, height);
      }
    };

    const syncChartSize = (attempt = 0) => {
      const host = containerRef.current;
      const liveChart = chartRef.current;
      if (!host || !liveChart) {
        return;
      }
      const rect = host.getBoundingClientRect();
      const width = Math.max(1, Math.floor(rect.width || host.clientWidth || 1));
      const height = Math.max(1, Math.floor(rect.height || host.clientHeight || 1));
      lastMeasuredSize = { width, height };
      setChartViewportWidth(width);
      resizeChart(liveChart, width, height);

      if (chartCanvasBitmapLooksStale(host, width, height)) {
        if (!chartUsesAutoSize(liveChart) && attempt < 5) {
          resizeRecoveryRaf = window.requestAnimationFrame(() => syncChartSize(attempt + 1));
          return;
        }
        queueChartRecreation(width, height);
      }
    };

    const scheduleResizeRecovery = (attempt = 0) => {
      if (resizeRecoveryRaf !== null) {
        window.cancelAnimationFrame(resizeRecoveryRaf);
      }
      resizeRecoveryRaf = window.requestAnimationFrame(() => syncChartSize(attempt));
    };

    syncChartSize();
    const initialResizeRaf = window.requestAnimationFrame(syncChartSize);
    const secondResizeRaf = window.requestAnimationFrame(() => syncChartSize(1));

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry || !chartRef.current) {
        return;
      }
      const width = Math.max(1, Math.floor(entry.contentRect.width));
      const height = Math.max(1, Math.floor(entry.contentRect.height));
      const sizeChanged = width !== lastMeasuredSize.width || height !== lastMeasuredSize.height;
      lastMeasuredSize = { width, height };
      setChartViewportWidth(width);
      const nextTimeScalePolicy = resolvePerceptualTimeScaleOptions({
        mode,
        timeframe,
        isLiteMode,
        containerWidth: width,
        motionPreset: resolvedMotionPreset,
      });
      currentTimeScalePolicyRef.current = nextTimeScalePolicy;
      chartRef.current.timeScale().applyOptions({
        rightOffset: nextTimeScalePolicy.rightOffset,
        minBarSpacing: nextTimeScalePolicy.minBarSpacing,
        ...(!userAdjustedTimeScaleRef.current ? { barSpacing: nextTimeScalePolicy.barSpacing } : {}),
      });
      resizeChart(chartRef.current, width, height);
      if (containerRef.current && chartCanvasBitmapLooksStale(containerRef.current, width, height)) {
        if (!chartUsesAutoSize(chartRef.current)) {
          scheduleResizeRecovery(sizeChanged ? 0 : 1);
        }
        queueChartRecreation(width, height);
      }
      if (!hasInitializedRangeRef.current) {
        chartRef.current.timeScale().fitContent();
      }
    });
    resizeObserver.observe(containerRef.current);

    const handleCrosshair = (param: MouseEventParams<Time>) => {
      if (isLiteMode || frozen) {
        return;
      }

      const container = containerRef.current;
      if (!container || !param.point || !param.time) {
        setCursor((current) => ({ ...current, visible: false }));
        clearCrosshairActiveOverlay();
        if (onCrosshairMoveRef.current) {
          onCrosshairMoveRef.current(null);
        }
        return;
      }

      const activeSeries = mode === "line" ? areaSeriesRef.current : candleSeriesRef.current;
      const rawPrice: unknown = activeSeries ? (param.seriesData as Map<unknown, unknown>).get(activeSeries) : null;
      let price = "--";

      if (typeof rawPrice === "number") {
        price = rawPrice.toFixed(2);
      } else if (rawPrice && typeof rawPrice === "object" && "close" in (rawPrice as Record<string, unknown>)) {
        price = Number((rawPrice as { close: number }).close || 0).toFixed(2);
      }

      setCursor({
        visible: true,
        left: clamp(param.point.x, 0, container.clientWidth),
        top: clamp(param.point.y, 0, container.clientHeight),
        priceTop: clamp(param.point.y, 18, Math.max(18, container.clientHeight - 18)),
        timeLeft: clamp(param.point.x, 58, Math.max(58, container.clientWidth - 58)),
        price,
        time: formatCursorTime(param.time, timeframe),
      });

      const timeCoord = chart.timeScale().timeToCoordinate(param.time);
      if (timeCoord !== null) {
        updateActiveCandleOverlay({
          left: clamp(timeCoord, 0, container.clientWidth),
          width: dynamicCandlePresentation.overlayWidthPx,
          source: "crosshair",
        });
      }

      if (onCrosshairMoveRef.current) {
        const numericPrice = Number(price);
        onCrosshairMoveRef.current(Number.isFinite(numericPrice)
          ? { price: numericPrice, timeLabel: formatCursorTime(param.time, timeframe), timeKey: timeToBucketKey(param.time, timeframe) }
          : null);
      }
    };

    if (!isLiteMode) {
      chart.subscribeCrosshairMove(handleCrosshair);
    }

    // ── Density: update overlay complexity on every zoom/scroll ──────────
    const handleRangeChange = () => {
      const c = containerRef.current;
      if (!c) return;
      const r = chart.timeScale().getVisibleLogicalRange();
      if (!r) return;
      const spacingPolicy = currentTimeScalePolicyRef.current;
      const barsVisible = Math.max(1, r.to - r.from);
      if (barsVisible > spacingPolicy.maxVisibleBars + 1) {
        const center = (r.from + r.to) * 0.5;
        const nextWidth = spacingPolicy.maxVisibleBars;
        chart.timeScale().setVisibleLogicalRange({
          from: center - nextWidth * 0.5,
          to: center + nextWidth * 0.5,
        });
        return;
      }
      if (barsVisible < spacingPolicy.minVisibleBars - 1) {
        const center = (r.from + r.to) * 0.5;
        const nextWidth = spacingPolicy.minVisibleBars;
        chart.timeScale().setVisibleLogicalRange({
          from: center - nextWidth * 0.5,
          to: center + nextWidth * 0.5,
        });
        return;
      }
      visibleBarsRef.current = barsVisible;
      const estStepPx = Math.max(2, c.clientWidth / barsVisible);
      const stableVisibleWidth = resolveStableLogicalWidthFromSpacing({
        containerWidth: c.clientWidth,
        requestedVisibleBars: barsVisible,
        spacingPolicy,
      });
      if (Math.abs(stableVisibleWidth - barsVisible) > 1.2) {
        const center = (r.from + r.to) * 0.5;
        chart.timeScale().setVisibleLogicalRange({
          from: center - stableVisibleWidth * 0.5,
          to: center + stableVisibleWidth * 0.5,
        });
        return;
      }
      candleStepPxRef.current = clamp(estStepPx, 2, 80);
      const nextPresentation = resolveDynamicCandlePresentation({
        spacingPolicy,
        slotWidthPx: candleStepPxRef.current,
        visibleBars: barsVisible,
        densityLevel: densityLevelRef.current,
        timeframe,
        volatility: volatilityRef.current,
        visualProfileName: visualProfile,
        deskMode: perceptualDeskMode,
      });
      const nextOverlayWidth = nextPresentation.overlayWidthPx;
      setPresentationStepPx((current) => (
        Math.abs(current - candleStepPxRef.current) < 0.35
          ? current
          : candleStepPxRef.current
      ));
      setPresentationVisibleBars((current) => (
        Math.abs(current - barsVisible) < 1
          ? current
          : barsVisible
      ));
      setActiveCandleOverlay((current) => {
        if (!current) {
          return current;
        }
        if (Math.abs(current.width - nextOverlayWidth) < 0.75) {
          return current;
        }
        return { ...current, width: nextOverlayWidth };
      });
      const next = getDensityLevel(estStepPx);
      if (next !== densityLevelRef.current) {
        densityLevelRef.current = next;
        setDensityLevel(next);
      }
      scheduleCustomV3CandleOverlayDraw();
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(handleRangeChange);

    return () => {
      schedulerRef.current?.clear();
      window.cancelAnimationFrame(initialResizeRaf);
      window.cancelAnimationFrame(secondResizeRaf);
      if (resizeRecoveryRaf !== null) {
        window.cancelAnimationFrame(resizeRecoveryRaf);
        resizeRecoveryRaf = null;
      }
      if (staleChartRecoveryRaf !== null) {
        window.cancelAnimationFrame(staleChartRecoveryRaf);
        staleChartRecoveryRaf = null;
      }
      if (staleChartRecoveryTimer !== null) {
        window.clearTimeout(staleChartRecoveryTimer);
        staleChartRecoveryTimer = null;
      }
      resizeObserver.disconnect();
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(handleRangeChange);
      if (intraCandleRafRef.current) {
        window.cancelAnimationFrame(intraCandleRafRef.current);
        intraCandleRafRef.current = null;
      }
      intraCandleCurrentRef.current = null;
      intraCandleTargetRef.current = null;
      intraCandleFrameTsRef.current = 0;
      if (!isLiteMode) {
        chart.unsubscribeCrosshairMove(handleCrosshair);
      }
      // Clear all indicator series refs; the chart will be destroyed anyway
      indicatorSeriesMapRef.current.clear();
      chart.remove();
      if (chartGenerationRef.current === chartGeneration) {
        chartGenerationRef.current = chartGeneration + 1;
      }
      chartRef.current = null;
      areaSeriesRef.current = null;
      candleSeriesRef.current = null;
      prevCandlesRef.current = null;
      prevAreaDataRef.current = null;
      hasSeededSeriesRef.current = false;
    };
  }, [chartRecoveryEpoch, clearCrosshairActiveOverlay, customV3RendererEnabled, frozen, isLiteMode, layoutStableReady, mode, resolvedMotionPreset, scheduleCustomV3CandleOverlayDraw, symbol, timeframe, updateActiveCandleOverlay]);

  useEffect(() => {
    const chart = chartRef.current;
    const areaSeries = areaSeriesRef.current;
    const candleSeries = candleSeriesRef.current;
    const container = containerRef.current;
    if (!chart || !areaSeries || !candleSeries || !container) {
      return;
    }

    if (frozen) {
      return;
    }

    const lineSource = candles.map((candle) => ({ label: candle.label, value: candle.close }));
    const pointTimes = normalizeTimes(lineSource.map((point) => point.label), timeframe);
    const candleLabels = candles.map((candle) => candle.label);
    const candleTimes = normalizeTimes(candleLabels, timeframe);

    const areaData = lineSource.map((point, index) => ({
      time: pointTimes[index],
      value: point.value,
    }));

    // Build raw OHLCV array then apply LOD + transform if requested
    const rawCandleSource = (candles.length > 0 ? candles : lineSource.map((point) => ({
      label: point.label,
      open: point.value,
      high: point.value,
      low: point.value,
      close: point.value,
      volume: 0,
    })));

    const rawBarsForRender = rawCandleSource.map((c, i) => ({
      time: Number(candleTimes[i]),
      open: Number.isFinite(c.open) ? c.open : c.close ?? 0,
      high: Number.isFinite(c.high) ? c.high : c.close ?? 0,
      low: Number.isFinite(c.low) ? c.low : c.close ?? 0,
      close: Number.isFinite(c.close) ? c.close : 0,
      volume: Number.isFinite(c.volume) ? c.volume : 0,
    }));

    const range = chart.timeScale().getVisibleLogicalRange();
    const visibleBars = range
      ? Math.max(1, Math.ceil(range.to - range.from))
      : resolveViewportVisibleBars(visibleBarsRef.current, currentTimeScalePolicyRef.current.targetVisibleBars);
    const shouldGpuSafe = densityLevel === "micro" || visibleBars > 150;
    setGpuSafeMode((current) => (current === shouldGpuSafe ? current : shouldGpuSafe));

    const densityBlocksVolumeProfile = densityLevel === "micro";
    const isScalpingCandleMode = mode === "candles" && timeframe === "1m";
    const scalpingPerfOverBudget = framePerf.frameTimeMs > 16 || framePerf.fps < 55;
    const prioritizeCandleLegibility = isScalpingCandleMode && densityLevel !== "expanded";
    const suppressHeavyCandlesOverlays = prioritizeCandleLegibility || (isScalpingCandleMode && scalpingPerfOverBudget);
    const perfBusy =
      framePerf.frameTimeMs > overlayPerfProfile.busyFrameMs
      || framePerf.fps < overlayPerfProfile.busyMinFps
      || framePerf.cpuLoad > overlayPerfProfile.busyCpuLoad;
    const perfCritical =
      framePerf.frameTimeMs > overlayPerfProfile.criticalFrameMs
      || framePerf.fps < overlayPerfProfile.criticalMinFps
      || framePerf.cpuLoad > overlayPerfProfile.criticalCpuLoad;
    const canRenderVolumeProfile = !isLiteMode && !frozen && mode !== "line" && mode !== "footprint" && !densityBlocksVolumeProfile && !perfCritical && !suppressHeavyCandlesOverlays && !shouldGpuSafe;
    const canRenderFootprint = !isLiteMode && !frozen && mode === "footprint" && !densityBlocksVolumeProfile && !perfCritical && !suppressHeavyCandlesOverlays && !shouldGpuSafe;
    const canRenderDom = !isLiteMode && !frozen && mode === "candles" && !densityBlocksVolumeProfile && !perfCritical && !suppressHeavyCandlesOverlays && !shouldGpuSafe;
    const canRenderHeatmap = !isLiteMode && !frozen && mode === "candles" && !densityBlocksVolumeProfile && !perfCritical && !suppressHeavyCandlesOverlays && !shouldGpuSafe;
    const overlayContextKey = `${symbol}|${timeframe}|${mode}|${isLiteMode ? 1 : 0}|${frozen ? 1 : 0}|${densityLevel}|${chartViewportWidth}`;
    const forceOverlayCompute = overlayContextKeyRef.current !== overlayContextKey;
    if (forceOverlayCompute) {
      overlayContextKeyRef.current = overlayContextKey;
    }
    const nowMs = typeof performance !== "undefined" ? performance.now() : Date.now();
    const allowOverlayCompute = forceOverlayCompute || nowMs - overlayLastUpdateTsRef.current >= OVERLAY_UPDATE_INTERVAL_MS;
    if (allowOverlayCompute) {
      overlayLastUpdateTsRef.current = nowMs;
    }

    const overlayBudgetStartMs = nowMs;
    const overlayBudgetMs = shouldGpuSafe ? 1.4 : 2.6;
    const hasOverlayHeadroom = () => {
      const ts = typeof performance !== "undefined" ? performance.now() : Date.now();
      return ts - overlayBudgetStartMs <= overlayBudgetMs;
    };

    const allowHeatmapComputeThisCycle = allowOverlayCompute
      && (forceOverlayCompute || nowMs - heatmapLastComputeTsRef.current >= HEATMAP_UPDATE_INTERVAL_MS)
      && hasOverlayHeadroom();
    const allowDomComputeThisCycle = allowOverlayCompute
      && (forceOverlayCompute || nowMs - domLastComputeTsRef.current >= DOM_UPDATE_INTERVAL_MS)
      && hasOverlayHeadroom();
    const allowFootprintComputeThisCycle = allowOverlayCompute
      && (forceOverlayCompute || nowMs - footprintLastComputeTsRef.current >= FOOTPRINT_UPDATE_INTERVAL_MS)
      && hasOverlayHeadroom();
    const allowVolumeProfileComputeThisCycle = allowOverlayCompute
      && (forceOverlayCompute || nowMs - volumeProfileLastComputeTsRef.current >= VOLUME_PROFILE_UPDATE_INTERVAL_MS)
      && hasOverlayHeadroom();

    if (allowHeatmapComputeThisCycle && canRenderHeatmap && heatmapLevels && heatmapLevels.length > 0) {
      heatmapLastComputeTsRef.current = nowMs;
      const referencePrice = rawBarsForRender[rawBarsForRender.length - 1]?.close ?? lineSource[lineSource.length - 1]?.value ?? 0;
      const maxBands = perfBusy ? overlayPerfProfile.heatmapBandsBusy : overlayPerfProfile.heatmapBandsNormal;
      const levels = [...heatmapLevels]
        .sort((left, right) => right.intensity - left.intensity)
        .slice(0, maxBands);
      const nextBands: HeatmapOverlayBand[] = [];
      for (let index = 0; index < levels.length; index += 1) {
        const level = levels[index];
        const y = candleSeries.priceToCoordinate(level.price);
        if (y === null) {
          continue;
        }
        const distanceRatio = referencePrice > 0 ? Math.abs(level.price - referencePrice) / referencePrice : 0;
        const focus: HeatmapOverlayBand["focus"] = distanceRatio <= 0.001
          ? "core"
          : distanceRatio <= 0.0025
            ? "near"
            : "far";
        const bandHeight = focus === "core" ? (perfBusy ? 9 : 11) : (perfBusy ? 8 : 10);
        const top = clamp(y - bandHeight * 0.5, 0, Math.max(0, container.clientHeight - bandHeight));
        const focusBoost = focus === "core" ? 0.12 : focus === "near" ? 0.05 : -0.04;
        const opacity = clamp(level.intensity * (perfBusy ? 0.33 : 0.42) + focusBoost, 0.08, 0.62);
        nextBands.push({
          key: `hm-${index}-${level.side}`,
          top,
          height: bandHeight,
          opacity,
          side: level.side,
          focus,
        });
      }

      setHeatmapOverlay({
        bands: nextBands,
        degraded: perfBusy,
        pausedReason: null,
      });
    } else if (allowOverlayCompute && !canRenderHeatmap) {
      const pausedReason: HeatmapOverlayState["pausedReason"] = isLiteMode
        ? "lite"
        : frozen
          ? "frozen"
          : mode !== "candles"
            ? "mode"
            : densityBlocksVolumeProfile
              ? "density"
              : "perf";
      setHeatmapOverlay({ bands: [], degraded: false, pausedReason });
    }

    if (allowDomComputeThisCycle && canRenderDom && domLevels && domLevels.length > 0) {
      domLastComputeTsRef.current = nowMs;
      const levelsLimit = perfBusy ? overlayPerfProfile.domLevelsBusy : overlayPerfProfile.domLevelsNormal;
      const perSide = Math.max(4, Math.floor(levelsLimit / 2));
      const asks = domLevels
        .filter((level) => level.side === "ask")
        .sort((left, right) => left.price - right.price)
        .slice(0, perSide);
      const bids = domLevels
        .filter((level) => level.side === "bid")
        .sort((left, right) => right.price - left.price)
        .slice(0, perSide);
      const merged = [...asks.reverse(), ...bids].slice(0, levelsLimit);

      const askTotal = asks.reduce((sum, level) => sum + Math.max(0, level.size), 0);
      const bidTotal = bids.reduce((sum, level) => sum + Math.max(0, level.size), 0);
      const denom = Math.max(1, askTotal + bidTotal);
      const imbalanceRatio = clamp((bidTotal - askTotal) / denom, -1, 1);
      const maxDomSize = Math.max(1, ...merged.map((level) => Math.max(0, level.size)));

      setDomOverlay({
        levels: merged.map((level, index) => ({
          key: `dom-${index}-${level.side}`,
          lockKey: `${level.side}-${level.price.toFixed(5)}`,
          side: level.side,
          price: level.price,
          size: level.size,
          intensity: clamp(level.intensity, 0.12, 1),
          isWall: level.size >= maxDomSize * 0.74 || level.intensity >= (perfBusy ? 0.88 : 0.82),
        })),
        imbalanceRatio,
        degraded: perfBusy,
        pausedReason: null,
      });
    } else if (allowOverlayCompute && !canRenderDom) {
      const pausedReason: DomOverlayState["pausedReason"] = isLiteMode
        ? "lite"
        : frozen
          ? "frozen"
          : mode !== "candles"
            ? "mode"
            : densityBlocksVolumeProfile
              ? "density"
              : "perf";
      setDomOverlay({ levels: [], imbalanceRatio: 0, degraded: false, pausedReason });
    }

    if (allowFootprintComputeThisCycle && canRenderFootprint) {
      footprintLastComputeTsRef.current = nowMs;
      const fallbackRows = rawBarsForRender.slice(-(perfBusy ? 6 : 8)).map((bar) => {
        const bullish = bar.close >= bar.open;
        const buyVolume = (bullish ? 0.62 : 0.38) * Math.max(0, bar.volume || 0);
        const sellVolume = Math.max(0, bar.volume || 0) - buyVolume;
        return {
          low: bar.low,
          high: bar.high,
          buyVolume,
          sellVolume,
          delta: buyVolume - sellVolume,
          timeLabel: formatCursorTime(bar.time as UTCTimestamp, timeframe),
        };
      });
      const sourceRows = (footprintRows && footprintRows.length > 0 ? footprintRows : fallbackRows).slice(0, perfBusy ? 6 : 8);
      const mappedRows: FootprintOverlayRow[] = [];
      const totalVolumes = sourceRows
        .map((row) => Math.max(0, row.buyVolume) + Math.max(0, row.sellVolume))
        .filter((value) => Number.isFinite(value) && value > 0)
        .sort((left, right) => left - right);
      const baselineTotalVolume = totalVolumes.length > 0
        ? totalVolumes[Math.min(totalVolumes.length - 1, Math.floor(totalVolumes.length * 0.6))]
        : 0;
      const absorptionMinVolume = Math.max(1, baselineTotalVolume * 1.15);

      for (let index = 0; index < sourceRows.length; index += 1) {
        const row = sourceRows[index];
        const yHigh = candleSeries.priceToCoordinate(row.high);
        const yLow = candleSeries.priceToCoordinate(row.low);
        if (yHigh === null || yLow === null) {
          continue;
        }
        const top = clamp(Math.min(yHigh, yLow), 0, container.clientHeight);
        const height = clamp(Math.abs(yLow - yHigh), 18, 54);
        const buyVolume = Math.max(0, row.buyVolume);
        const sellVolume = Math.max(0, row.sellVolume);
        const total = Math.max(1, buyVolume + sellVolume);
        const deltaRatio = clamp(row.delta / total, -1, 1);
        const dominant = Math.max(buyVolume, sellVolume);
        const weaker = Math.max(1, Math.min(buyVolume, sellVolume));
        const dominanceRatio = dominant / weaker;
        const imbalanceSide: FootprintOverlayRow["imbalanceSide"] = buyVolume > sellVolume * 1.8
          ? "buy"
          : sellVolume > buyVolume * 1.8
            ? "sell"
            : "none";
        const imbalanceStrength = imbalanceSide === "none"
          ? 0
          : clamp((dominanceRatio - 1.8) / 2.8, 0, 1);
        const absorption = total >= absorptionMinVolume && Math.abs(deltaRatio) <= 0.16;
        mappedRows.push({
          key: `fp-${index}`,
          top,
          height,
          price: (row.low + row.high) / 2,
          buyVolume,
          sellVolume,
          delta: row.delta,
          deltaRatio,
          imbalanceSide,
          imbalanceStrength,
          absorption,
          timeLabel: row.timeLabel || "-",
        });
      }

      setFootprintOverlay({
        rows: mappedRows,
        degraded: perfBusy,
        pausedReason: null,
      });
    } else if (allowOverlayCompute && !canRenderFootprint) {
      const pausedReason: FootprintOverlayState["pausedReason"] = isLiteMode
        ? "lite"
        : frozen
          ? "frozen"
          : mode !== "footprint"
            ? "mode"
            : densityBlocksVolumeProfile
              ? "density"
              : "perf";
      setFootprintOverlay({ rows: [], degraded: false, pausedReason });
    }

    if (allowVolumeProfileComputeThisCycle && canRenderVolumeProfile) {
      volumeProfileLastComputeTsRef.current = nowMs;
      const profileLookback = perfBusy
        ? (densityLevel === "expanded" ? 88 : densityLevel === "normal" ? 72 : 56)
        : (densityLevel === "expanded" ? 120 : densityLevel === "normal" ? 96 : 72);
      const profileBins = perfBusy
        ? (densityLevel === "expanded" ? 16 : densityLevel === "normal" ? 14 : 10)
        : (densityLevel === "expanded" ? 22 : densityLevel === "normal" ? 18 : 14);
      const profileBars = rawBarsForRender.slice(-profileLookback);
      const profile = volumeProfile(profileBars, profileBins);
      const profileRows: VolumeProfileOverlayRow[] = [];
      const totalProfileVolume = profile.reduce((sum, bin) => sum + Math.max(0, bin.totalVol), 0);
      const pocIndex = profile.findIndex((bin) => bin.isPoc);
      const valueAreaTarget = totalProfileVolume * 0.7;
      const includedIndexes = new Set<number>();
      let vahIndex = -1;
      let valIndex = -1;

      if (profile.length > 0 && pocIndex >= 0) {
        let includedVolume = Math.max(0, profile[pocIndex].totalVol);
        includedIndexes.add(pocIndex);
        let left = pocIndex - 1;
        let right = pocIndex + 1;

        while (includedVolume < valueAreaTarget && (left >= 0 || right < profile.length)) {
          const leftVol = left >= 0 ? Math.max(0, profile[left].totalVol) : -1;
          const rightVol = right < profile.length ? Math.max(0, profile[right].totalVol) : -1;
          if (rightVol > leftVol) {
            includedIndexes.add(right);
            includedVolume += Math.max(0, profile[right].totalVol);
            right += 1;
          } else {
            includedIndexes.add(left);
            includedVolume += Math.max(0, profile[left].totalVol);
            left -= 1;
          }
        }

        const included = [...includedIndexes];
        vahIndex = Math.max(...included);
        valIndex = Math.min(...included);
      }

      const sessionBinTotals: number[][] = [
        Array.from({ length: profile.length }, () => 0),
        Array.from({ length: profile.length }, () => 0),
        Array.from({ length: profile.length }, () => 0),
      ];
      const profileLow = profile.length > 0 ? profile[0].priceLow : 0;
      const profileBinSize = profile.length > 0
        ? Math.max(profile[0].priceHigh - profile[0].priceLow, 0.0001)
        : 1;

      if (profile.length > 0 && profileBars.length > 0) {
        const cut1 = Math.floor(profileBars.length / 3);
        const cut2 = Math.floor((profileBars.length * 2) / 3);
        for (let barIdx = 0; barIdx < profileBars.length; barIdx += 1) {
          const bar = profileBars[barIdx];
          const sessionIndex = barIdx < cut1 ? 0 : barIdx < cut2 ? 1 : 2;
          const startBin = clamp(Math.floor((bar.low - profileLow) / profileBinSize), 0, Math.max(0, profile.length - 1));
          const endBin = clamp(Math.floor((bar.high - profileLow) / profileBinSize), 0, Math.max(0, profile.length - 1));
          const span = Math.max(1, endBin - startBin + 1);
          for (let binIdx = startBin; binIdx <= endBin; binIdx += 1) {
            sessionBinTotals[sessionIndex][binIdx] += Math.max(0, bar.volume) / span;
          }
        }
      }

      let vahY: number | null = null;
      let valY: number | null = null;
      let pocY: number | null = null;

      for (let index = 0; index < profile.length; index += 1) {
        const bin = profile[index];
        if (!Number.isFinite(bin.totalVol) || bin.totalVol <= 0 || bin.pct < 0.025) {
          continue;
        }
        const yHigh = candleSeries.priceToCoordinate(bin.priceHigh);
        const yLow = candleSeries.priceToCoordinate(bin.priceLow);
        if (yHigh === null || yLow === null) {
          continue;
        }
        const top = clamp(Math.min(yHigh, yLow), 0, container.clientHeight);
        const height = clamp(Math.abs(yLow - yHigh), 1.5, 40);
        const buyPct = bin.totalVol > 0 ? clamp(bin.buyVol / bin.totalVol, 0, 1) : 0.5;
        const imbalance = buyPct * 2 - 1;
        const asiaVol = sessionBinTotals[0][index] || 0;
        const londonVol = sessionBinTotals[1][index] || 0;
        const newYorkVol = sessionBinTotals[2][index] || 0;
        const sortedSession = [
          { key: "asia" as const, vol: asiaVol },
          { key: "london" as const, vol: londonVol },
          { key: "newyork" as const, vol: newYorkVol },
        ].sort((left, right) => right.vol - left.vol);
        const primary = sortedSession[0];
        const secondary = sortedSession[1];
        const sessionBias: VolumeProfileOverlayRow["sessionBias"] = primary.vol > 0 && primary.vol > secondary.vol * 1.15
          ? primary.key
          : "mixed";
        const sessionTotal = Math.max(1, asiaVol + londonVol + newYorkVol);
        const sessionConfidence = clamp(primary.vol / sessionTotal, 0, 1);
        const centerY = top + height * 0.5;
        if (bin.isPoc) {
          pocY = centerY;
        }
        if (index === vahIndex) {
          vahY = centerY;
        }
        if (index === valIndex) {
          valY = centerY;
        }
        profileRows.push({
          key: `vp-${index}`,
          top,
          height,
          priceMid: bin.priceMid,
          totalVol: Math.max(0, bin.totalVol),
          widthPct: clamp(bin.pct, 0.04, 1),
          buyPct,
          imbalance,
          isPoc: bin.isPoc,
          isVah: index === vahIndex,
          isVal: index === valIndex,
          sessionBias,
          sessionConfidence,
        });
      }

      setVolumeProfileOverlay({
        rows: profileRows,
        vahY,
        valY,
        pocY,
        degraded: perfBusy,
        pausedReason: null,
      });
    } else if (allowOverlayCompute && !canRenderVolumeProfile) {
      const pausedReason: VolumeProfileOverlayState["pausedReason"] = isLiteMode
        ? "lite"
        : frozen
          ? "frozen"
          : mode === "line"
            ? "mode"
            : densityBlocksVolumeProfile
              ? "density"
              : "perf";
      setVolumeProfileOverlay({ rows: [], vahY: null, valY: null, pocY: null, degraded: false, pausedReason });
    }

    const compactRecentBarLimit = mode === "candles"
      ? Math.max(currentTimeScalePolicyRef.current.targetVisibleBars + 10, 32)
      : rawBarsForRender.length;
    const barsForRender = mode === "candles" && container.clientWidth < 860
      ? rawBarsForRender.slice(-compactRecentBarLimit)
      : rawBarsForRender;
    const lodBars = applyDynamicLod(barsForRender, visibleBars);

    let candleData: CandleSeriesPoint[];

    const buildFlowState = (time: number, volume: number) => resolvePerceptualFlowState({
      time,
      timeframe,
      volume,
      footprintRowsByTimeKey,
      footprintBaselineVolume,
      executionSignalByTimeKey,
    });

    if (candleTransform === "heikin-ashi" && lodBars.length > 0) {
      const ha = heikinAshi(lodBars);
      candleData = applyPerceptualRenderPipeline(
        ha.map((bar, index) => ({
          time: Number(bar.time),
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          volume: lodBars[index]?.volume ?? 0,
          timeKey: timeToBucketKey(Number(bar.time), timeframe),
          flow: buildFlowState(Number(bar.time), lodBars[index]?.volume ?? 0),
        })),
        {
          densityLevel,
          visibleBars,
          timeframe,
          volatility: marketVolatility,
          visualProfile,
          domImbalanceRatio,
        },
      );
    } else {
      candleData = applyPerceptualRenderPipeline(lodBars.map((bar) => ({
        ...bar,
        timeKey: timeToBucketKey(Number(bar.time), timeframe),
        flow: buildFlowState(Number(bar.time), bar.volume ?? 0),
      })), {
        densityLevel,
        visibleBars,
        timeframe,
        volatility: marketVolatility,
        visualProfile,
        domImbalanceRatio,
      });
    }

    // Guard: keep only finite, strictly increasing-time bars for LWC.
    // Duplicate / out-of-order timestamps can still crash candlestick rendering.
    const sanitizedCandleData: CandleSeriesPoint[] = [];
    let prevTime = Number.NEGATIVE_INFINITY;
    for (const bar of candleData) {
      const time = Number(bar.time as number);
      const open = Number(bar.open);
      const close = Number(bar.close);
      const high = Math.max(Number(bar.high), open, close);
      const low = Math.min(Number(bar.low), open, close);
      if (!Number.isFinite(time) || !Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
        continue;
      }
      if (time <= prevTime) {
        continue;
      }
      sanitizedCandleData.push({
        time: time as UTCTimestamp,
        open,
        high,
        low,
        close,
        timeKey: bar.timeKey,
        color: bar.color,
        borderColor: bar.borderColor,
        wickColor: bar.wickColor,
        wickType: bar.wickType,
        emphasis: bar.emphasis,
        styleKey: bar.styleKey,
        flow: bar.flow,
      });
      prevTime = time;
    }
    candleData = sanitizedCandleData;

    syncCandleAutoscaleState(candleData, candleAutoscaleRangeRef, lastPriceRef, timeframe);
    areaAutoscaleRangeRef.current = resolveAreaAutoscaleRange(areaData, timeframe);

    // ── New candle flash: detect when a new bar opens ──────────────────
    if (prevCandleLengthRef.current > 0 && candleData.length > prevCandleLengthRef.current) {
      setNewCandleFlash((v) => v + 1);
    }
    prevCandleLengthRef.current = candleData.length;

    dirtyStateRef.current.candle = true;
    const scheduler = schedulerRef.current;

    const stopIntraCandleInterpolation = () => {
      if (intraCandleRafRef.current) {
        window.cancelAnimationFrame(intraCandleRafRef.current);
        intraCandleRafRef.current = null;
      }
      intraCandleFrameTsRef.current = 0;
      intraCandleContinuityModeRef.current = "idle";
      liveRenderContinuityRef.current.continuityMode = "idle";
    };

    const safeSeriesUpdate = (next: CandleRenderPoint, force = false): boolean => {
      const nowMs = typeof performance !== "undefined" ? performance.now() : Date.now();
      if (!force && nowMs - lastSeriesUpdateTsRef.current < CANDLE_UPDATE_INTERVAL_MS) {
        liveRenderContinuityRef.current.throttleDeferrals += 1;
        return false;
      }
      try {
        candleSeries.update((customV3RendererEnabled ? hideNativeCandlePoint(next) : next) as any);
        lastSeriesUpdateTsRef.current = nowMs;
        lastCommittedCandleRef.current = normalizeRenderPoint(next);
        return true;
      } catch {
        return false;
      }
    };

    const startIntraCandleInterpolation = () => {
      if (intraCandleRafRef.current) {
        return;
      }

      intraCandleContinuityModeRef.current = "series-and-overlay";
      liveRenderContinuityRef.current.continuityMode = "series-and-overlay";

      const chartGeneration = chartGenerationRef.current;

      const animate = (frameTs: number) => {
        const target = intraCandleTargetRef.current;
        const current = intraCandleCurrentRef.current;
        const series = candleSeriesRef.current;
        if (!target || !current || !series || mode === "line") {
          intraCandleRafRef.current = null;
          intraCandleFrameTsRef.current = 0;
          intraCandleContinuityModeRef.current = "idle";
          liveRenderContinuityRef.current.continuityMode = "idle";
          return;
        }
        if (!isFiniteCandleRenderPoint(target) || !isFiniteCandleRenderPoint(current)) {
          intraCandleRafRef.current = null;
          intraCandleFrameTsRef.current = 0;
          intraCandleContinuityModeRef.current = "idle";
          liveRenderContinuityRef.current.continuityMode = "idle";
          return;
        }
        if (chartGenerationRef.current !== chartGeneration || series !== candleSeriesRef.current) {
          intraCandleRafRef.current = null;
          intraCandleFrameTsRef.current = 0;
          intraCandleContinuityModeRef.current = "idle";
          liveRenderContinuityRef.current.continuityMode = "idle";
          return;
        }

        const frameDeltaMs = intraCandleFrameTsRef.current > 0 ? frameTs - intraCandleFrameTsRef.current : 16.7;
        intraCandleFrameTsRef.current = frameTs;
        const frameScale = clamp(frameDeltaMs / 16.7, 0.65, 1.9);

        const spread = Math.max(
          Math.abs(target.open - current.open),
          Math.abs(target.high - current.high),
          Math.abs(target.low - current.low),
          Math.abs(target.close - current.close),
        );
        const alphaBase = clamp(0.2 + spread * 0.01, 0.18, 0.6);
        const alpha = 1 - Math.pow(1 - alphaBase, frameScale);

        const next: CandleRenderPoint = {
          time: target.time,
          open: current.open + (target.open - current.open) * alpha,
          high: current.high + (target.high - current.high) * alpha,
          low: current.low + (target.low - current.low) * alpha,
          close: current.close + (target.close - current.close) * alpha,
          timeKey: target.timeKey ?? current.timeKey,
          color: target.color ?? current.color,
          borderColor: target.borderColor ?? current.borderColor,
          wickColor: target.wickColor ?? current.wickColor,
          wickType: target.wickType ?? current.wickType,
          emphasis: target.emphasis ?? current.emphasis,
          styleKey: target.styleKey ?? current.styleKey,
          flow: target.flow ?? current.flow,
        };
        next.high = Math.max(next.high, next.open, next.close);
        next.low = Math.min(next.low, next.open, next.close);
        if (!isFiniteCandleRenderPoint(next)) {
          intraCandleRafRef.current = null;
          intraCandleFrameTsRef.current = 0;
          return;
        }

        const committed = safeSeriesUpdate(next, false);
        if (!committed) {
          intraCandleCurrentRef.current = next;
          scheduleCustomV3CandleOverlayDraw();
          intraCandleRafRef.current = window.requestAnimationFrame(animate);
          return;
        }

        if (!isFiniteCandleRenderPoint(next)) {
          intraCandleRafRef.current = null;
          intraCandleFrameTsRef.current = 0;
          return;
        }

        intraCandleCurrentRef.current = next;
        scheduleCustomV3CandleOverlayDraw();
        const settled = Math.max(
          Math.abs(next.open - target.open),
          Math.abs(next.high - target.high),
          Math.abs(next.low - target.low),
          Math.abs(next.close - target.close),
        ) < 1e-4;

        if (settled) {
          intraCandleRafRef.current = null;
          intraCandleFrameTsRef.current = 0;
          intraCandleCurrentRef.current = target;
          intraCandleContinuityModeRef.current = "idle";
          liveRenderContinuityRef.current.continuityMode = "idle";
          scheduleCustomV3CandleOverlayDraw();
          return;
        }

        intraCandleRafRef.current = window.requestAnimationFrame(animate);
      };

      intraCandleRafRef.current = window.requestAnimationFrame(animate);
    };

    const safeSetCandleData = (source: CandleSeriesPoint[]) => {
      const sanitized: CandleSeriesPoint[] = [];
      let prevTime = Number.NEGATIVE_INFINITY;
      for (const bar of source) {
        const time = Number(bar.time as number);
        const open = Number(bar.open);
        const close = Number(bar.close);
        const high = Math.max(Number(bar.high), open, close);
        const low = Math.min(Number(bar.low), open, close);
        if (!Number.isFinite(time) || !Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
          continue;
        }
        if (time <= prevTime) {
          continue;
        }
        sanitized.push({
          time: time as UTCTimestamp,
          open,
          high,
          low,
          close,
          timeKey: bar.timeKey,
          color: bar.color,
          borderColor: bar.borderColor,
          wickColor: bar.wickColor,
          wickType: bar.wickType,
          emphasis: bar.emphasis,
          styleKey: bar.styleKey,
          flow: bar.flow,
        });
        prevTime = time;
      }

      liveRenderContinuityRef.current.fullRedraws += 1;
      try {
        candleSeries.setData((customV3RendererEnabled ? sanitized.map((point) => hideNativeCandlePoint(point)) : sanitized) as any);
        lastSeriesUpdateTsRef.current = typeof performance !== "undefined" ? performance.now() : Date.now();
        const lastPoint = sanitized[sanitized.length - 1];
        lastCommittedCandleRef.current = lastPoint
          ? normalizeRenderPoint({
            time: Number(lastPoint.time),
            open: Number(lastPoint.open),
            high: Number(lastPoint.high),
            low: Number(lastPoint.low),
            close: Number(lastPoint.close),
            timeKey: lastPoint.timeKey,
            color: lastPoint.color,
            borderColor: lastPoint.borderColor,
            wickColor: lastPoint.wickColor,
            wickType: lastPoint.wickType,
            emphasis: lastPoint.emphasis,
            styleKey: lastPoint.styleKey,
            flow: lastPoint.flow,
          })
          : null;
      } catch {
        // Last-resort fallback: clear malformed frame instead of crashing render loop.
        liveRenderContinuityRef.current.recoveryClears += 1;
        candleSeries.setData([] as any);
        lastSeriesUpdateTsRef.current = typeof performance !== "undefined" ? performance.now() : Date.now();
        lastCommittedCandleRef.current = null;
      }
    };

    const applyCandleUpdate = () => {
      if (!dirtyStateRef.current.candle) {
        return;
      }
      if (
        chartRef.current !== chart
        || areaSeriesRef.current !== areaSeries
        || candleSeriesRef.current !== candleSeries
      ) {
        return;
      }

      if (mode === "line") {
        try {
          areaSeries.setData(areaData);
        } catch {
          // Ignore transient line-series ordering issues; the candlestick path remains authoritative.
        }
      }

      // Partial updates (series.update) are 60x faster than setData and prevent flicker.
      // Always prefer partial when possible — no forced full redraw on narrow viewports.
      const forceFullCandleSetData = false;
      const { useUpdate, lastCandle } = shouldUsePartialUpdate(candleData as any, prevCandlesRef.current);
      const lastCandleValid = lastCandle && Number.isFinite(lastCandle.open) && Number.isFinite(lastCandle.high) && Number.isFinite(lastCandle.low) && Number.isFinite(lastCandle.close) && Number.isFinite(lastCandle.time as number);
      if (!forceFullCandleSetData && useUpdate && lastCandleValid && mode !== "line" && hasSeededSeriesRef.current) {
        const rawLastPoint = mergeRenderPointWithPrevious(lastCommittedCandleRef.current, {
          time: Number(lastCandle.time),
          open: Number(lastCandle.open),
          high: Number(lastCandle.high),
          low: Number(lastCandle.low),
          close: Number(lastCandle.close),
          timeKey: lastCandle.timeKey,
          color: lastCandle.color,
          borderColor: lastCandle.borderColor,
          wickColor: lastCandle.wickColor,
          wickType: lastCandle.wickType,
          emphasis: lastCandle.emphasis,
          styleKey: lastCandle.styleKey,
          flow: lastCandle.flow,
        });
        const lastPoint = normalizeRenderPoint(rawLastPoint);
        if (!isFiniteCandleRenderPoint(lastPoint)) {
          stopIntraCandleInterpolation();
          safeSetCandleData(candleData as any);
          hasSeededSeriesRef.current = true;
          return;
        }
        if (shouldConflateRenderPointUpdate(lastCommittedCandleRef.current, lastPoint, {
          densityLevel,
          visibleBars,
          timeframe,
          volatility: marketVolatility,
          visualProfile,
        })) {
          liveRenderContinuityRef.current.conflatedUpdates += 1;
          prevCandlesRef.current = candleData as any;
          prevAreaDataRef.current = areaData;
          renderUpdateCountsRef.current.candle += 1;
          dirtyStateRef.current.candle = false;
          intraCandleTargetRef.current = lastPoint;
          return;
        }
        liveRenderContinuityRef.current.partialUpdates += 1;
        trackRenderJump(lastCommittedCandleRef.current, lastPoint);
        const previousPoint = intraCandleCurrentRef.current;
        try {
          if (isFiniteCandleRenderPoint(previousPoint) && previousPoint.time === lastPoint.time) {
            if (microTimeframeLock) {
              stopIntraCandleInterpolation();
              if (!safeSeriesUpdate(lastPoint, true)) {
                liveRenderContinuityRef.current.updateFallbackRedraws += 1;
                safeSetCandleData(candleData as any);
                intraCandleCurrentRef.current = lastPoint;
                intraCandleTargetRef.current = lastPoint;
                hasSeededSeriesRef.current = true;
                return;
              }
              hasSeededSeriesRef.current = true;
              armOverlayOnlyContinuity(previousPoint, lastPoint);
            } else {
              intraCandleTargetRef.current = lastPoint;
              startIntraCandleInterpolation();
            }
          } else {
            stopIntraCandleInterpolation();
            if (!safeSeriesUpdate(lastPoint, true)) {
              liveRenderContinuityRef.current.updateFallbackRedraws += 1;
              safeSetCandleData(candleData as any);
              intraCandleCurrentRef.current = lastPoint;
              intraCandleTargetRef.current = lastPoint;
              hasSeededSeriesRef.current = true;
              return;
            }
            hasSeededSeriesRef.current = true;
            intraCandleCurrentRef.current = lastPoint;
            intraCandleTargetRef.current = lastPoint;
          }
        } catch {
          stopIntraCandleInterpolation();
          liveRenderContinuityRef.current.updateFallbackRedraws += 1;
          safeSetCandleData(candleData as any);
          hasSeededSeriesRef.current = true;
          intraCandleCurrentRef.current = lastPoint;
          intraCandleTargetRef.current = lastPoint;
        }
      } else {
        stopIntraCandleInterpolation();
        if (mode === "line") {
          areaSeries.setData(areaData);
        }
        safeSetCandleData(candleData as any);
        hasSeededSeriesRef.current = true;
        const finalPoint = (candleData.length > 0 ? candleData[candleData.length - 1] : null) as CandleSeriesPoint | null;
        intraCandleCurrentRef.current = finalPoint
          ? {
            time: Number(finalPoint.time),
            open: Number(finalPoint.open),
            high: Number(finalPoint.high),
            low: Number(finalPoint.low),
            close: Number(finalPoint.close),
            color: finalPoint.color,
            borderColor: finalPoint.borderColor,
            wickColor: finalPoint.wickColor,
            wickType: finalPoint.wickType,
            emphasis: finalPoint.emphasis,
            styleKey: finalPoint.styleKey,
          }
          : null;
        intraCandleTargetRef.current = intraCandleCurrentRef.current;
      }

      const seriesStyleKey = `${mode}|${symbol}|${timeframe}|${visualProfile}|${densityLevel}|${Math.round(marketVolatility * 10000)}|${Math.round(domImbalanceRatio * 100)}|${Math.round(dynamicCandlePresentation.preferredBodyWidthPx * 10)}|${Math.round(dynamicCandlePresentation.wickWidthPx * 10)}|${Math.round(dynamicCandlePresentation.bodyOpacity * 100)}`;
      if ((candleSeries as any).__prevStyleKey !== seriesStyleKey) {
        areaSeries.applyOptions({
          visible: mode === "line",
          lineWidth: mode === "line" ? 3 : 2,
          lineColor: mode === "line" ? withAlpha(resolvedVisualProfile.palette.crosshair, 0.98) : withAlpha(resolvedVisualProfile.palette.crosshair, 0.92),
          topColor: mode === "line" ? withAlpha(resolvedVisualProfile.palette.up, 0.38) : withAlpha(resolvedVisualProfile.palette.up, 0.12),
          bottomColor: mode === "line" ? withAlpha(resolvedVisualProfile.palette.backgroundAccent, 0.3) : withAlpha(resolvedVisualProfile.palette.backgroundAccent, 0.08),
        });
        candleSeries.applyOptions({
          ...resolvePerceptualCandleStyleOptions(symbol, timeframe, densityLevel, marketVolatility, visualProfile, domImbalanceRatio, dynamicCandlePresentation),
          visible: mode !== "line",
        });
        (candleSeries as any).__prevStyleKey = seriesStyleKey;
      }
      prevCandlesRef.current = candleData as any;
      prevAreaDataRef.current = areaData;
      renderUpdateCountsRef.current.candle += 1;
      dirtyStateRef.current.candle = false;
      scheduleCustomV3CandleOverlayDraw();
    };
    if (scheduler) {
      scheduler.enqueue({ type: "candle", priority: LAYER_PRIORITY.candle, callback: applyCandleUpdate });
    } else {
      applyCandleUpdate();
    }

    const activeSeries = mode === "line" ? areaSeries : candleSeries;
    const timeScale = chart.timeScale();
    const overlaySourceTimes = pointTimes;
    const nextBadges: OverlayBadge[] = [];

    const renderedCandleTimes = candleData.map((entry) => entry.time);
    const activeTimes = mode === "line" ? pointTimes : renderedCandleTimes;
    const activeValues = mode === "line"
      ? areaData.map((entry) => entry.value)
      : candleData.map((entry) => entry.close);

    // rangeIdentity ne contient QUE symbol|timeframe — changer mode ou transform
    // ne réinitialise PAS la caméra (évite le snap-back lors des changements d'affichage).
    const rangeIdentity = `${symbol}|${timeframe}`;
    if (lastRangeIdentityRef.current !== rangeIdentity) {
      hasInitializedRangeRef.current = false;
      userAdjustedTimeScaleRef.current = false;
      lastRangeIdentityRef.current = rangeIdentity;
    }

    if (!hasInitializedRangeRef.current && activeTimes.length > 12) {
      const rightPad = isLiteMode ? 1 : 2;
      const visibleBars = clamp(
        currentTimeScalePolicyRef.current.targetVisibleBars,
        currentTimeScalePolicyRef.current.minVisibleBars,
        currentTimeScalePolicyRef.current.maxVisibleBars,
      );
      const to = activeTimes.length - 1 + rightPad;
      const from = Math.max(0, to - visibleBars);
      chart.timeScale().setVisibleLogicalRange({ from, to });
      hasInitializedRangeRef.current = true;
    }

    // Self-heal : récupère uniquement les cas vraiment cassés (< 4 barres visibles)
    // sans jamais interférer avec un zoom utilisateur intentionnel.
    if (!userAdjustedTimeScaleRef.current && activeTimes.length > 24) {
      const currentRange = chart.timeScale().getVisibleLogicalRange();
      if (currentRange) {
        const visibleNow = Math.max(1, Math.ceil(currentRange.to - currentRange.from));
        // Seuil très bas : intervient uniquement si vraiment cassé (layout collapse)
        const minExpectedVisible = 4;
        if (visibleNow < minExpectedVisible) {
          const baselineVisible = clamp(
            currentTimeScalePolicyRef.current.targetVisibleBars,
            currentTimeScalePolicyRef.current.minVisibleBars,
            currentTimeScalePolicyRef.current.maxVisibleBars,
          );
          const rightPad = isLiteMode ? 1 : 2;
          const to = activeTimes.length - 1 + rightPad;
          const from = Math.max(0, to - baselineVisible);
          chart.timeScale().setVisibleLogicalRange({ from, to });
          hasInitializedRangeRef.current = true;
        }
      }
    }

    const coordinates = activeTimes.reduce<number[]>((acc, time) => {
      const coordinate = timeScale.timeToCoordinate(time as Time);
      if (coordinate !== null) {
        acc.push(Number(coordinate));
      }
      return acc;
    }, []);
    if (coordinates.length >= 2) {
      const deltas: number[] = [];
      for (let idx = 1; idx < coordinates.length; idx += 1) {
        const delta = coordinates[idx] - coordinates[idx - 1];
        if (Number.isFinite(delta) && delta > 0) {
          deltas.push(delta);
        }
      }
      if (deltas.length > 0) {
        const avgDelta = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
        const tfSeconds = timeframeSeconds(timeframe);
        const minStep = mode === "candles"
          ? (tfSeconds < 60 ? 2 : 10)
          : (tfSeconds < 60 ? 2 : 8);
        candleStepPxRef.current = clamp(avgDelta, minStep, 64);
      }
    }

    const lastTime = activeTimes.length > 0 ? activeTimes[activeTimes.length - 1] : null;
    const lastValue = activeValues.length > 0 ? activeValues[activeValues.length - 1] : null;
    if (!isLiteMode && lastTime && Number.isFinite(lastValue)) {
      const lastX = timeScale.timeToCoordinate(lastTime as Time);
      const lastY = activeSeries.priceToCoordinate(Number(lastValue));
      if (lastX !== null && lastY !== null) {
        const nowMs = typeof performance !== "undefined" ? performance.now() : Date.now();
        const clampedLeft = clamp(lastX, 0, container.clientWidth);
        const clampedTop = clamp(lastY, 0, container.clientHeight);
        const prevMeta = livePulseMetaRef.current;
        const deltaFromPrev = prevMeta ? Math.hypot(clampedLeft - prevMeta.left, clampedTop - prevMeta.top) : Number.POSITIVE_INFINITY;
        const priceDriftPx = prevMeta ? Math.abs(clampedTop - prevMeta.top) : 0;
        lastPriceDriftPxRef.current = priceDriftPx;
        peakPriceDriftPxRef.current = Math.max(peakPriceDriftPxRef.current, priceDriftPx);
        const updateIntervalMs = prevMeta ? nowMs - prevMeta.updatedAt : Number.POSITIVE_INFINITY;

        const skipPulseUpdate = Boolean(prevMeta && updateIntervalMs < 45 && deltaFromPrev < 0.45);

        if (skipPulseUpdate) {
          lastPriceRef.current = Number(lastValue);
        }

        if (!skipPulseUpdate) {
          const significantPriceMove = lastPriceRef.current !== null && Math.abs(Number(lastValue) - lastPriceRef.current) > 1e-9;
          const shouldPulse =
            significantPriceMove
            && (!prevMeta || (deltaFromPrev >= 1.4 && nowMs - prevMeta.lastPulseAt >= 120));

          if (shouldPulse) {
            pulseTickRef.current += 1;
          }

          lastPriceRef.current = Number(lastValue);
          livePulseMetaRef.current = {
            left: clampedLeft,
            top: clampedTop,
            updatedAt: nowMs,
            lastPulseAt: shouldPulse ? nowMs : (prevMeta?.lastPulseAt ?? nowMs),
          };

          setLivePulse({
            left: clampedLeft,
            top: clampedTop,
            priceLabel: formatCompactPrice(Number(lastValue)),
            tick: pulseTickRef.current,
          });
          if (!cursorVisibleRef.current) {
            updateActiveCandleOverlay({
              left: clamp(lastX, 0, container.clientWidth),
              width: dynamicCandlePresentation.overlayWidthPx,
              source: "live",
            });
          }
        }
      }
    }

    if (!isLiteMode && customV3RendererEnabled && candleData.length > 0) {
      const forming = candleData[candleData.length - 1];
      const formingX = timeScale.timeToCoordinate(forming.time as Time);
      const openY = activeSeries.priceToCoordinate(forming.open);
      const closeY = activeSeries.priceToCoordinate(forming.close);
      const highY = activeSeries.priceToCoordinate(forming.high);
      const lowY = activeSeries.priceToCoordinate(forming.low);
      if (formingX !== null && openY !== null && closeY !== null && highY !== null && lowY !== null) {
        const direction = forming.close > forming.open ? "up" : forming.close < forming.open ? "down" : "flat";
        const range = Math.max(0, forming.high - forming.low);
        const referencePrice = Math.max(Math.abs(forming.close), Math.abs(forming.open), 1);
        const lowRangeForming = range / referencePrice < 0.0015;
        const snappedLeft = snapCssToDevicePixel(clamp(formingX, 0, container.clientWidth));
        const snappedOpenY = snapCssToDevicePixel(clamp(openY, 0, container.clientHeight));
        const snappedCloseY = snapCssToDevicePixel(clamp(closeY, 0, container.clientHeight));
        const snappedHighY = snapCssToDevicePixel(clamp(highY, 0, container.clientHeight));
        const snappedLowY = snapCssToDevicePixel(clamp(lowY, 0, container.clientHeight));
        setFormingCandleTarget({
          left: snappedLeft,
          width: clamp(dynamicCandlePresentation.formingWidthPx, lowRangeForming ? 2 : densityLevel === "micro" ? 1 : 3, motionTuning.formingWidthMax + 3),
          openY: snappedOpenY,
          closeY: snappedCloseY,
          highY: snappedHighY,
          lowY: snappedLowY,
          opacity: clamp(dynamicCandlePresentation.bodyOpacity - (lowRangeForming ? 0.16 : 0.13), lowRangeForming ? 0.75 : 0.72, 0.84),
          wickOpacity: clamp(dynamicCandlePresentation.wickOpacity - (lowRangeForming ? 0.28 : 0.12), lowRangeForming ? 0.6 : 0.74, 0.92),
          radiusPx: dynamicCandlePresentation.bodyRadiusPx,
          direction,
        });
      }
    } else {
      setFormingCandleTarget(null);
    }

    if (!isLiteMode) {
      for (const [index, zone] of overlayZones.entries()) {
        const startTime = overlaySourceTimes[Math.max(0, Math.min(overlaySourceTimes.length - 1, zone.x1))];
        const endTime = overlaySourceTimes[Math.max(0, Math.min(overlaySourceTimes.length - 1, zone.x2))];
        const startX = startTime ? timeScale.timeToCoordinate(startTime) : null;
        const endX = endTime ? timeScale.timeToCoordinate(endTime) : null;
        const y = activeSeries.priceToCoordinate(zone.high);
        if (startX === null || endX === null || y === null) {
          continue;
        }
        nextBadges.push({
          key: `zone-${index}`,
          left: clamp((startX + endX) / 2, 48, container.clientWidth - 128),
          top: clamp(y - 28, 14, container.clientHeight - 56),
          text: zone.label,
          tone: zone.kind === "fvg" ? "good" : "accent",
          kind: "zone",
          detail: `${zone.kind.toUpperCase()} ${zone.low.toFixed(1)}-${zone.high.toFixed(1)}`,
          price: zone.high,
        });
      }

      for (const [index, zone] of liquidityZones.entries()) {
        const y = activeSeries.priceToCoordinate(zone.level);
        if (y === null) {
          continue;
        }
        nextBadges.push({
          key: `liq-${index}`,
          left: clamp(container.clientWidth - 106, 48, container.clientWidth - 106),
          top: clamp(y - 11, 14, container.clientHeight - 34),
          text: `Liq ${zone.level.toFixed(0)}`,
          tone: "warn",
          kind: "liquidity",
          detail: `${zone.label} ${zone.level.toFixed(2)}`,
          price: zone.level,
        });
      }
    }

    if (allowOverlayCompute) {
      dirtyStateRef.current.overlay = true;
    }
    const schedulerForOverlay = schedulerRef.current;
    const applyOverlayUpdate = () => {
      if (!allowOverlayCompute) {
        return;
      }
      if (!dirtyStateRef.current.overlay) {
        return;
      }

      for (const priceLine of priceLinesRef.current) {
        activeSeries.removePriceLine(priceLine);
      }
      priceLinesRef.current = [];

      const lineSpecs: ManagedPriceLineSpec[] = [];

      for (const [value, color, fadedColor, title, compactTitle, priority, preserveNearLastLabel, hideNearLastLabel] of [
        [dayVwap, "#67e8a5", "rgba(103, 232, 165, 0.58)", "VWAP D", "VD", 4, true, false],
        [weekVwap, "#58c7ff", "rgba(88, 199, 255, 0.56)", "VWAP W", "VW", 2, false, true],
        [monthVwap, "#ffd166", "rgba(255, 209, 102, 0.54)", "VWAP M", "VM", 1, false, true],
      ] as Array<[number, string, string, string, string, number, boolean, boolean]>) {
        if (value > 0) {
          lineSpecs.push({
            price: value,
            color,
            fadedColor,
            title,
            compactTitle,
            lineStyle: 2,
            lineWidth: 1,
            priority,
            preserveNearLastLabel,
            hideNearLastLabel,
          });
        }
      }

      for (const zone of liquidityZones) {
        const compactTitle = /resting/i.test(zone.label)
          ? "RL"
          : /pool/i.test(zone.label)
            ? "LQ"
            : "LIQ";
        lineSpecs.push({
          price: zone.level,
          color: "#ff8d8d",
          fadedColor: "rgba(255, 141, 141, 0.52)",
          title: zone.label,
          compactTitle,
          lineStyle: 1,
          lineWidth: 1,
          priority: 4,
        });
      }

      if (domAnchorPrice !== null && domAnchorSide) {
        lineSpecs.push({
          price: domAnchorPrice,
          color: domAnchorSide === "ask" ? "#ff8f8f" : "#7beab4",
          fadedColor: domAnchorSide === "ask" ? "rgba(255, 143, 143, 0.58)" : "rgba(123, 234, 180, 0.58)",
          title: domAnchorSide === "ask" ? "DOM ASK" : "DOM BID",
          compactTitle: domAnchorSide === "ask" ? "DA" : "DB",
          lineStyle: 2,
          lineWidth: 2,
          priority: 5,
        });
      }

      const managedPriceLines = resolveManagedPriceLines(
        activeSeries,
        lineSpecs,
        mode,
        Number.isFinite(lastValue) ? Number(lastValue) : null,
        mode === "candles"
          ? (chartViewportWidth < 680 || densityLevel === "micro"
            ? 0.0018
            : chartViewportWidth < 860
              ? 0.0022
            : densityLevel === "compact" || chartViewportWidth < 1180
              ? 0.0038
              : null)
          : null,
        mode === "candles" && (chartViewportWidth < 860 || densityLevel === "compact" || densityLevel === "micro"),
        mode === "candles"
          ? (chartViewportWidth < 680 || densityLevel === "micro"
            ? 2
            : chartViewportWidth < 860 || densityLevel === "compact"
              ? 3
              : null)
          : null,
      );

      for (const line of managedPriceLines) {
        priceLinesRef.current.push(activeSeries.createPriceLine(line as any));
      }

      setOverlayBadges(resolveBadgeCollisions(nextBadges, container.clientWidth, container.clientHeight));
      renderUpdateCountsRef.current.overlay += 1;
      dirtyStateRef.current.overlay = false;
    };

    if (allowOverlayCompute) {
      if (schedulerForOverlay) {
        schedulerForOverlay.enqueue({ type: "overlay", priority: LAYER_PRIORITY.overlay, callback: applyOverlayUpdate });
      } else {
        applyOverlayUpdate();
      }
    }
  }, [
    frozen,
    isLiteMode,
    candles,
    candleTransform,
    dayVwap,
    liquidityZones,
    mode,
    monthVwap,
    motionTuning.formingWidthFactor,
    motionTuning.formingWidthMax,
    framePerf.cpuLoad,
    framePerf.fps,
    framePerf.frameTimeMs,
    overlayPerfProfile.busyCpuLoad,
    overlayPerfProfile.busyFrameMs,
    overlayPerfProfile.busyMinFps,
    overlayPerfProfile.criticalCpuLoad,
    overlayPerfProfile.criticalFrameMs,
    overlayPerfProfile.criticalMinFps,
    overlayPerfProfile.domLevelsBusy,
    overlayPerfProfile.domLevelsNormal,
    overlayPerfProfile.heatmapBandsBusy,
    overlayPerfProfile.heatmapBandsNormal,
    overlayZones,
    footprintRows,
    footprintBaselineVolume,
    footprintRowsByTimeKey,
    executionSignalByTimeKey,
    domLevels,
    heatmapLevels,
    densityLevel,
    timeframe,
    weekVwap,
    domAnchorPrice,
    domAnchorSide,
    chartViewportWidth,
    updateActiveCandleOverlay,
  ]);

  const handleDomRowClick = (level: DomOverlayLevel) => {
    markUserInteraction(1000);
    if (domPressHandledRef.current) {
      domPressHandledRef.current = false;
      return;
    }
    setDomSelectedKey(level.key);
    setDomAnchorPrice(level.price);
    setDomAnchorSide(level.side);
    if (level.isWall) {
      setDomLockedWalls((current) => ({
        ...current,
        [level.lockKey]: !current[level.lockKey],
      }));
      toastSeqRef.current += 1;
      setDomToast({
        id: toastSeqRef.current,
        message: `${domLockedWalls[level.lockKey] ? "unlock" : "lock"} wall ${formatCompactPrice(level.price)}`,
      });
    } else {
      toastSeqRef.current += 1;
      setDomToast({
        id: toastSeqRef.current,
        message: `anchor ${level.side.toUpperCase()} ${formatCompactPrice(level.price)}`,
      });
    }
  };

  const handleDomRowDoubleClick = useCallback(() => {
    markUserInteraction(1000);
    setDomSelectedKey(null);
    setDomAnchorPrice(null);
    setDomAnchorSide(null);
    toastSeqRef.current += 1;
    setDomToast({ id: toastSeqRef.current, message: "anchor cleared" });
  }, [markUserInteraction]);

  const handleDomResetLocks = useCallback(() => {
    markUserInteraction(1000);
    setDomLockedWalls({});
    toastSeqRef.current += 1;
    setDomToast({ id: toastSeqRef.current, message: "locks reset" });
  }, [markUserInteraction]);

  const clearDomHoldTimer = useCallback(() => {
    if (domHoldTimerRef.current !== null && typeof window !== "undefined") {
      window.clearTimeout(domHoldTimerRef.current);
      domHoldTimerRef.current = null;
    }
  }, []);

  const handleDomRowPointerDown = (level: DomOverlayLevel, event: ReactPointerEvent<HTMLButtonElement>) => {
    markUserInteraction(1100);
    if (event.pointerType !== "touch" && event.pointerType !== "pen") {
      return;
    }
    if (!level.isWall || isLiteMode) {
      return;
    }
    setDomTouchPrimedKey(level.key);
    clearDomHoldTimer();
    const holdThresholdMs = domHoldThresholdMs(event.pointerType, chartViewportWidth);
    domHoldTimerRef.current = window.setTimeout(() => {
      domPressHandledRef.current = true;
      setDomSelectedKey(level.key);
      setDomAnchorPrice(level.price);
      setDomAnchorSide(level.side);
      setDomLockedWalls((current) => {
        const nextLocked = !current[level.lockKey];
        toastSeqRef.current += 1;
        setDomToast({
          id: toastSeqRef.current,
          message: `${nextLocked ? "lock" : "unlock"} wall ${formatCompactPrice(level.price)} (hold)`,
        });
        return {
          ...current,
          [level.lockKey]: nextLocked,
        };
      });
      setDomTouchPulseKey(level.key);
      if (typeof window !== "undefined") {
        window.setTimeout(() => {
          setDomTouchPulseKey((current) => (current === level.key ? null : current));
        }, 420);
      }
      setDomTouchPrimedKey(null);
      domHoldTimerRef.current = null;
    }, holdThresholdMs);
  };

  const handleDomRowPointerUp = useCallback(() => {
    markUserInteraction(750);
    clearDomHoldTimer();
    setDomTouchPrimedKey(null);
  }, [clearDomHoldTimer, markUserInteraction]);

  const handleDomRowsPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (domOverlay.levels.length === 0) {
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.height <= 0) {
      return;
    }
    const localY = clamp(event.clientY - rect.top, 0, rect.height - 1);
    const rowHeight = rect.height / domOverlay.levels.length;
    const rowIndex = clamp(Math.floor(localY / Math.max(rowHeight, 1)), 0, domOverlay.levels.length - 1);
    const snappedKey = domOverlay.levels[rowIndex]?.key ?? null;
    setDomHoverKey((current) => (current === snappedKey ? current : snappedKey));
  }, [domOverlay.levels]);

  const handleVpPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (volumeProfileOverlay.rows.length === 0) {
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const rowsPer100px = rect.height > 0 ? (volumeProfileOverlay.rows.length / rect.height) * 100 : 0;
    const zoomDensityBoost = clamp(rowsPer100px / 7.5, 0.15, 1.55);
    const zoomCompression = clamp(14 / Math.max(candleStepPxRef.current, 6), 0.72, 1.66);
    const pointerY = event.clientY - rect.top;
    if (vpHoverKey) {
      const currentRow = volumeProfileOverlay.rows.find((row) => row.key === vpHoverKey);
      if (currentRow) {
        const hysteresis = clamp(currentRow.height * 0.34 * zoomDensityBoost * zoomCompression, 2, 18);
        if (pointerY >= currentRow.top - hysteresis && pointerY <= currentRow.top + currentRow.height + hysteresis) {
          return;
        }
      }
    }
    let closestRow = volumeProfileOverlay.rows[0];
    let closestDistance = Math.abs((closestRow.top + closestRow.height * 0.5) - pointerY);
    for (let index = 1; index < volumeProfileOverlay.rows.length; index += 1) {
      const candidate = volumeProfileOverlay.rows[index];
      const distance = Math.abs((candidate.top + candidate.height * 0.5) - pointerY);
      if (distance < closestDistance) {
        closestDistance = distance;
        closestRow = candidate;
      }
    }
    setVpHoverKey((current) => (current === closestRow.key ? current : closestRow.key));
  }, [volumeProfileOverlay.rows, vpHoverKey]);

  const handleBadgePointerDown = (badgeKey: string) => (event: ReactPointerEvent<HTMLSpanElement>) => {
    event.preventDefault();
    event.stopPropagation();
    markUserInteraction(1100);
    const offset = overlayOffsets[badgeKey] || { x: 0, y: 0 };
    dragStateRef.current = {
      key: badgeKey,
      startX: event.clientX,
      startY: event.clientY,
      originX: offset.x,
      originY: offset.y,
    };
    setDraggingBadgeKey(badgeKey);
    setActiveBadgeKey(badgeKey);
  };

  const nudgeBadge = (badgeKey: string, deltaX: number, deltaY: number) => {
    markUserInteraction(1000);
    setOverlayOffsets((current) => {
      const prev = current[badgeKey] || { x: 0, y: 0 };
      return {
        ...current,
        [badgeKey]: {
          x: clamp(prev.x + deltaX, -180, 180),
          y: clamp(prev.y + deltaY, -140, 140),
        },
      };
    });
  };

  const autoSwitchHeat = autoStabilityMetrics.switches5m >= 9 ? "hot" : autoStabilityMetrics.switches5m >= 4 ? "warn" : "ok";
  const autoTargetBand = chartMotionPreset === "auto" ? autoMotionTargetBand(symbol, timeframe) : null;
  const autoTargetIntervalSec = autoTargetBand?.targetSec ?? null;
  const autoIntervalTone = autoMotionIntervalTone(autoStabilityMetrics.avgIntervalSec, autoTargetIntervalSec ?? 0);
  const autoSparklinePath = buildSparklinePath(autoStabilityMetrics.sparklineBuckets, 120, 24);
  const autoStabilityTooltip = [
    `switches/h: ${autoStabilityMetrics.switches1h}`,
    `band cible: ${autoTargetBand ? `ok >= ${formatCompactDuration(autoTargetBand.okFloorSec)} · warn ${formatCompactDuration(autoTargetBand.warnFloorSec)}-${formatCompactDuration(autoTargetBand.okFloorSec)} · hot < ${formatCompactDuration(autoTargetBand.warnFloorSec)}` : "-"}`,
    `temps moyen entre switches: ${autoStabilityMetrics.avgIntervalSec === null ? "-" : formatCompactDuration(autoStabilityMetrics.avgIntervalSec)}${autoTargetIntervalSec ? ` (cible ${formatCompactDuration(autoTargetIntervalSec)})` : ""}`,
    `dernier switch: ${autoStabilityMetrics.lastSwitchAgoSec === null ? "-" : `il y a ${formatCompactDuration(autoStabilityMetrics.lastSwitchAgoSec)}`}`,
  ].join("\n");

  const cleanPresetBand = (() => {
    const basePreset = chartMotionPreset === "auto" ? resolvedMotionPreset : chartMotionPreset;
    if (basePreset === "scalping" || basePreset === "aggressive") {
      return "aggressive" as const;
    }
    if (basePreset === "swing" || basePreset === "stable") {
      return "stable" as const;
    }
    return "balanced" as const;
  })();

  const cleanThresholds = cleanPresetBand === "stable"
    ? {
      hardWidth: 840,
      softWidth: 1080,
      hardFrameMs: overlayPerfProfile.criticalFrameMs * 1.08,
      softFrameMs: overlayPerfProfile.busyFrameMs * 1.1,
      hardMinFps: Math.max(overlayPerfProfile.criticalMinFps - 3, 18),
      softMinFps: Math.max(overlayPerfProfile.busyMinFps - 2, 26),
      softCpuLoad: overlayPerfProfile.busyCpuLoad * 1.06,
    }
    : cleanPresetBand === "aggressive"
      ? {
        hardWidth: 1040,
        softWidth: 1340,
        hardFrameMs: overlayPerfProfile.criticalFrameMs * 0.9,
        softFrameMs: overlayPerfProfile.busyFrameMs * 0.92,
        hardMinFps: overlayPerfProfile.criticalMinFps + 4,
        softMinFps: overlayPerfProfile.busyMinFps + 3,
        softCpuLoad: overlayPerfProfile.busyCpuLoad * 0.92,
      }
      : {
        hardWidth: 920,
        softWidth: 1180,
        hardFrameMs: overlayPerfProfile.criticalFrameMs,
        softFrameMs: overlayPerfProfile.busyFrameMs,
        hardMinFps: overlayPerfProfile.criticalMinFps,
        softMinFps: overlayPerfProfile.busyMinFps,
        softCpuLoad: overlayPerfProfile.busyCpuLoad,
      };

  const overlayLayoutMode = chartViewportWidth < 860 ? "compact" : chartViewportWidth < 1080 ? "tight" : "full";
  const isTradingFocus = mode === "candles" && timeframe === "1m";
  const focusOverlayAlpha = isTradingFocus
    ? (isUserInteracting ? 0.03 : 0.25)
    : densityConfig.overlayAlpha;
  const overBudgetFrame = framePerf.frameTimeMs > 16 || framePerf.fps < 55;
  const candlesCleanLevel: "off" | "soft" | "hard" = (() => {
    if (visualMode === "full") {
      return "off";
    }
    if (isLiteMode || frozen || mode !== "candles") {
      return "off";
    }
    if (visualMode === "clean") {
      return densityLevel === "micro" || chartViewportWidth < cleanThresholds.softWidth ? "hard" : "soft";
    }
    if (
      densityLevel === "micro"
      || chartViewportWidth < cleanThresholds.hardWidth
      || framePerf.frameTimeMs > cleanThresholds.hardFrameMs
      || framePerf.fps < cleanThresholds.hardMinFps
    ) {
      return "hard";
    }
    if (
      densityLevel === "compact"
      || chartViewportWidth < cleanThresholds.softWidth
      || framePerf.frameTimeMs > cleanThresholds.softFrameMs
      || framePerf.fps < cleanThresholds.softMinFps
      || framePerf.cpuLoad > cleanThresholds.softCpuLoad
    ) {
      return "soft";
    }
    return "off";
  })();
  const hideDomOverlay = gpuSafeMode || overlayLayoutMode === "compact" || candlesCleanLevel === "hard" || (isTradingFocus && overBudgetFrame);
  const hideFootprintOverlay = gpuSafeMode || chartViewportWidth < 980 || candlesCleanLevel !== "off" || (isTradingFocus && overBudgetFrame);
  const hideVolumeProfileOverlay = gpuSafeMode || chartViewportWidth < 920 || candlesCleanLevel === "hard" || (isTradingFocus && overBudgetFrame);
  const suppressHeatmapOverlay = gpuSafeMode || candlesCleanLevel === "hard" || (isTradingFocus && overBudgetFrame);
  const ultraCleanCandles = visualMode === "clean" && mode === "candles";
  const suppressLivePulse = gpuSafeMode || candlesCleanLevel !== "off" || (isTradingFocus && overBudgetFrame);
  const suppressNewCandleFlash = gpuSafeMode || candlesCleanLevel !== "off" || (isTradingFocus && overBudgetFrame);
  const suppressFormingCandle = gpuSafeMode || candlesCleanLevel === "hard" || (isTradingFocus && overBudgetFrame);
  const deskHideDomOverlay = hideDomOverlay || (perceptualDeskMode.mode === "macro" && !isUserInteracting);
  const deskHideFootprintOverlay = hideFootprintOverlay || (perceptualDeskMode.mode === "macro" && !isUserInteracting);
  const deskSuppressHeatmapOverlay = suppressHeatmapOverlay || (perceptualDeskMode.mode === "macro" && !isUserInteracting);
  const deskSuppressFormingCandle = suppressFormingCandle || (perceptualDeskMode.mode === "micro" && overBudgetFrame);
  const showOverlayBadges = densityConfig.showBadges && candlesCleanLevel === "off";
  const visibleWallKeys = domOverlay.levels.filter((level) => level.isWall).map((level) => level.lockKey);
  const lockedVisibleWallCount = visibleWallKeys.reduce((count, key) => count + (domLockedWalls[key] ? 1 : 0), 0);
  const vpHoverIndex = vpHoverKey ? volumeProfileOverlay.rows.findIndex((row) => row.key === vpHoverKey) : -1;
  const vpHoverRow = vpHoverKey ? (volumeProfileOverlay.rows.find((row) => row.key === vpHoverKey) || null) : null;
  const vpNeighborhoodRows = vpHoverIndex >= 0
    ? volumeProfileOverlay.rows.slice(Math.max(0, vpHoverIndex - 3), Math.min(volumeProfileOverlay.rows.length, vpHoverIndex + 4))
    : [];
  const vpNeighborhoodPath = buildSparklinePath(vpNeighborhoodRows.map((row) => row.totalVol), 64, 18);
  const vpConfidenceTone = vpHoverRow
    ? (vpHoverRow.sessionConfidence >= 0.66 ? "high" : vpHoverRow.sessionConfidence >= 0.5 ? "medium" : "low")
    : "low";
  const collapsedOverlaySet = new Set<string>();
  if (candlesCleanLevel !== "off") {
    if (heatmapOverlay.bands.length > 0) collapsedOverlaySet.add("HEAT");
    if (domOverlay.levels.length > 0) collapsedOverlaySet.add("DOM");
    if (volumeProfileOverlay.rows.length > 0) collapsedOverlaySet.add("VP");
    if (footprintOverlay.rows.length > 0) collapsedOverlaySet.add("FP");
  }
  if (deskHideDomOverlay && domOverlay.levels.length > 0) collapsedOverlaySet.add("DOM");
  if (deskHideFootprintOverlay && footprintOverlay.rows.length > 0) collapsedOverlaySet.add("FP");
  if (hideVolumeProfileOverlay && volumeProfileOverlay.rows.length > 0) collapsedOverlaySet.add("VP");
  const collapsedOverlays = [...collapsedOverlaySet];

  const assetContrastClass = inferAssetContrastClass(symbol);
  const timeframeContrastBand = inferTimeframeContrastBand(timeframe);
  const chartRootStyle = useMemo(() => ({
    "--chart-profile-bg": resolvedVisualProfile.palette.background,
    "--chart-profile-bg-accent": resolvedVisualProfile.palette.backgroundAccent,
    "--chart-profile-text": withAlpha(resolvedVisualProfile.palette.text, 0.94),
    "--chart-profile-up": withAlpha(resolvedVisualProfile.palette.up, dynamicCandlePresentation.bodyOpacity),
    "--chart-profile-down": withAlpha(resolvedVisualProfile.palette.down, dynamicCandlePresentation.bodyOpacity),
    "--chart-profile-wick": withAlpha(resolvedVisualProfile.palette.wick, 0.94),
    "--chart-profile-wick-up": resolveProfileWickColor(resolvedVisualProfile, "up", domImbalanceRatio, dynamicCandlePresentation.wickOpacity),
    "--chart-profile-wick-down": resolveProfileWickColor(resolvedVisualProfile, "down", domImbalanceRatio, dynamicCandlePresentation.wickOpacity),
    "--chart-profile-border-up": withAlpha(resolvedVisualProfile.palette.up, dynamicCandlePresentation.borderOpacity),
    "--chart-profile-border-down": withAlpha(resolvedVisualProfile.palette.down, dynamicCandlePresentation.borderOpacity),
    "--chart-profile-transition-ms": `${resolvedVisualProfile.motion.transitionMs}ms`,
    "--chart-profile-easing": resolvedVisualProfile.motion.easing,
    "--chart-profile-wick-width": `${dynamicCandlePresentation.wickWidthPx}px`,
    "--chart-profile-body-radius": `${dynamicCandlePresentation.bodyRadiusPx}px`,
    "--chart-profile-body-opacity": String(dynamicCandlePresentation.bodyOpacity),
    "--chart-profile-breathe-scale": String(resolvedVisualProfile.motion.breathePx > 0 ? 0.015 : 0),
    "--chart-profile-wick-glow": String(resolvedVisualProfile.rendering.extremeWickGlow),
    "--chart-profile-last-glow": String(resolvedVisualProfile.perception.lastCandleGlow),
    "--chart-profile-last-brightness": String(dynamicCandlePresentation.lastBrightness),
    "--chart-profile-micro-pulse": String(visualProfile === "txt-signature" ? 0.01 : 0),
  }) as CSSProperties, [domImbalanceRatio, dynamicCandlePresentation, resolvedVisualProfile, visualProfile]);

  return (
    <div className={[
      "institutional-chart-root",
      `visual-profile-${visualProfile}`,
      `mode-${mode}`,
      `contrast-${assetContrastClass}-${timeframeContrastBand}`,
      `density-${densityLevel}`,
      `overlay-layout-${overlayLayoutMode}`,
      `candles-clean-${candlesCleanLevel}`,
      `desk-mode-${perceptualDeskMode.mode}`,
      perceptualDeskMode.authoritativeRenderer ? "desk-renderer-authoritative" : "",
      gpuSafeMode ? "gpu-safe" : "",
      isTradingFocus ? "price-first-focus" : "",
      className,
    ].filter(Boolean).join(" ")} style={chartRootStyle}>
      <div className="chart-sessions-layer" aria-hidden="true">
        {showSessions && densityConfig.showSessionBands ? (
          <>
            <div className="chart-session-band chart-session-band-asia"><span>Asia</span></div>
            <div className="chart-session-band chart-session-band-london"><span>London</span></div>
            <div className="chart-session-band chart-session-band-newyork"><span>New York</span></div>
          </>
        ) : null}
      </div>
      <div className="chart-underlay-layer">
        <div className="chart-underlay-inner" style={{ "--overlay-alpha": focusOverlayAlpha } as CSSProperties}>
          {!isLiteMode && heatmapOverlay.bands.length > 0 && !deskSuppressHeatmapOverlay ? (
            <div className={`chart-heatmap-minimal-grid ${heatmapOverlay.degraded ? "chart-heatmap-minimal-grid-degraded" : ""}`} aria-hidden="true">
              {heatmapOverlay.bands.map((band) => (
                <div
                  key={band.key}
                  className={`chart-heatmap-minimal-band ${band.side} focus-${band.focus}`}
                  style={{ top: band.top, height: band.height, opacity: band.opacity }}
                />
              ))}
            </div>
          ) : null}
        </div>
      </div>
      <div ref={containerRef} className="chart-canvas-host" aria-label={`${symbol} chart`} />
      <div className="chart-timezone-pill" aria-hidden="true">UTC | drag pan | {perceptualDeskMode.mode.toUpperCase()} {Math.round(perceptualDeskMode.confidence * 100)}%</div>
      <div className="chart-microstructure-layer">
        <div className="chart-microstructure-inner" style={{ "--overlay-alpha": focusOverlayAlpha } as CSSProperties}>
        <div className="chart-microstructure-right-rail">
          {!isLiteMode && !ultraCleanCandles && heatmapOverlay.pausedReason === "perf" && mode === "candles" ? (
            <div className="chart-heatmap-minimal-paused" aria-live="polite">Heatmap paused: frame budget</div>
          ) : null}
          {!isLiteMode && domOverlay.levels.length > 0 && !deskHideDomOverlay ? (
            <div className={`chart-dom-ladder-lite ${domOverlay.degraded ? "chart-dom-ladder-lite-degraded" : ""}`}>
            <div className="chart-dom-ladder-lite-head">
              <span className="chart-dom-ladder-lite-kicker">DOM LITE</span>
              <span className={`chart-dom-ladder-lite-imbalance ${domOverlay.imbalanceRatio >= 0 ? "pos" : "neg"}`}>
                imb {domOverlay.imbalanceRatio >= 0 ? "+" : ""}{Math.round(domOverlay.imbalanceRatio * 100)}%
              </span>
              <span className="chart-dom-ladder-lite-lock-count">locks {lockedVisibleWallCount}/{visibleWallKeys.length}</span>
              <button type="button" className="chart-dom-ladder-lite-reset" onClick={handleDomResetLocks}>reset</button>
              <span className="chart-dom-ladder-lite-hotkey">L lock / R reset / Esc clear</span>
            </div>
            <div className="chart-dom-ladder-lite-rows" onMouseMove={handleDomRowsPointerMove} onMouseLeave={() => setDomHoverKey(null)}>
              {domOverlay.levels.map((level) => (
                <button
                  key={level.key}
                  type="button"
                  className={`chart-dom-ladder-lite-row ${level.side} ${level.isWall ? "is-wall" : ""} ${domHoverKey === level.key ? "is-hovered" : ""} ${domSelectedKey === level.key ? "is-selected" : ""} ${domLockedWalls[level.lockKey] ? "is-locked" : ""} ${domTouchPrimedKey === level.key ? "is-hold-primed" : ""} ${domTouchPulseKey === level.key ? "is-hold-pulse" : ""}`}
                  onPointerDown={(event) => handleDomRowPointerDown(level, event)}
                  onPointerUp={handleDomRowPointerUp}
                  onPointerCancel={handleDomRowPointerUp}
                  onClick={() => handleDomRowClick(level)}
                  onDoubleClick={handleDomRowDoubleClick}
                  title={`${level.side.toUpperCase()} ${formatCompactPrice(level.price)} | size ${Math.round(level.size)}${level.isWall ? " | wall" : ""}`}
                >
                  <span className="chart-dom-ladder-lite-side">{level.side === "ask" ? "A" : "B"}{domLockedWalls[level.lockKey] ? "*" : ""}</span>
                  <span className="chart-dom-ladder-lite-price">{formatCompactPrice(level.price)}</span>
                  <span className="chart-dom-ladder-lite-size">{Math.round(level.size)}</span>
                  <span className="chart-dom-ladder-lite-bar"><i style={{ width: `${Math.round(level.intensity * 100)}%` }} /></span>
                </button>
              ))}
            </div>
            </div>
          ) : null}
          {!isLiteMode && domOverlay.pausedReason === "perf" && mode === "candles" && !deskHideDomOverlay ? (
            <div className="chart-dom-ladder-lite-paused" aria-live="polite">DOM paused: frame budget</div>
          ) : null}
          {!isLiteMode && domToast ? <div className="chart-dom-action-toast" aria-live="polite">{domToast.message}</div> : null}
          {!isLiteMode && volumeProfileOverlay.rows.length > 0 && !hideVolumeProfileOverlay ? (
            <div
              className={`chart-volume-profile ${volumeProfileOverlay.degraded ? "chart-volume-profile-degraded" : ""}`}
              onMouseMove={handleVpPointerMove}
              onMouseLeave={() => setVpHoverKey(null)}
            >
              <div className="chart-volume-profile-kicker">VP{volumeProfileOverlay.degraded ? " LITE" : ""}</div>
              <div className="chart-volume-profile-session-split" aria-hidden="true">
                <span className="asia">ASIA</span>
                <span className="london">LON</span>
                <span className="newyork">NY</span>
              </div>
              {volumeProfileOverlay.vahY !== null ? (
                <span className="chart-volume-profile-guide chart-volume-profile-guide-vah" style={{ top: volumeProfileOverlay.vahY }}>VAH</span>
              ) : null}
              {volumeProfileOverlay.valY !== null ? (
                <span className="chart-volume-profile-guide chart-volume-profile-guide-val" style={{ top: volumeProfileOverlay.valY }}>VAL</span>
              ) : null}
              {volumeProfileOverlay.pocY !== null ? (
                <span className="chart-volume-profile-guide chart-volume-profile-guide-poc" style={{ top: volumeProfileOverlay.pocY }}>POC</span>
              ) : null}
              {volumeProfileOverlay.rows.map((row) => (
                <div
                  key={row.key}
                  className={`chart-volume-profile-row ${vpHoverKey === row.key ? "chart-volume-profile-row-hovered" : ""} ${row.isPoc ? "chart-volume-profile-row-poc" : ""} ${row.isVah ? "chart-volume-profile-row-vah" : ""} ${row.isVal ? "chart-volume-profile-row-val" : ""} chart-volume-profile-row-session-${row.sessionBias}`}
                  title={`price ${formatCompactPrice(row.priceMid)} · buy ${(row.buyPct * 100).toFixed(0)}% · ${row.sessionBias}`}
                  style={{ top: row.top, height: row.height, width: `${Math.round(row.widthPct * 100)}%` }}
                  onMouseEnter={() => setVpHoverKey(row.key)}
                >
                  <span className="chart-volume-profile-row-buy" style={{ width: `${Math.round(row.buyPct * 100)}%` }} />
                  <span className="chart-volume-profile-row-sell" style={{ width: `${Math.round((1 - row.buyPct) * 100)}%` }} />
                </div>
              ))}
              {vpHoverRow ? (
                <div className={`chart-volume-profile-hover-panel tone-${vpConfidenceTone} session-${vpHoverRow.sessionBias}`} style={{ top: vpHoverRow.top + vpHoverRow.height * 0.5 }}>
                  <strong>{formatCompactPrice(vpHoverRow.priceMid)}</strong>
                  <span>total: {Math.round(vpHoverRow.totalVol)}</span>
                  <span>buy/sell: {(vpHoverRow.buyPct * 100).toFixed(0)}% / {(100 - vpHoverRow.buyPct * 100).toFixed(0)}%</span>
                  <span>imbalance: {vpHoverRow.imbalance >= 0 ? "+" : ""}{(vpHoverRow.imbalance * 100).toFixed(1)}%</span>
                  <span>session: {vpHoverRow.sessionBias} ({(vpHoverRow.sessionConfidence * 100).toFixed(0)}%)</span>
                  <span className={`chart-volume-profile-confidence chart-volume-profile-confidence-${vpConfidenceTone}`}>confidence {vpConfidenceTone}</span>
                  {vpNeighborhoodRows.length > 1 ? (
                    <span className="chart-volume-profile-mini-sparkline" aria-hidden="true">
                      <svg viewBox="0 0 64 18" preserveAspectRatio="none">
                        <path d={vpNeighborhoodPath} />
                      </svg>
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
          {!isLiteMode && volumeProfileOverlay.pausedReason === "perf" && !hideVolumeProfileOverlay ? (
            <div className="chart-volume-profile-paused" aria-live="polite">VP paused: frame budget</div>
          ) : null}
        </div>
        <div className="chart-microstructure-left-rail">
        {!isLiteMode && footprintOverlay.rows.length > 0 && !deskHideFootprintOverlay ? (
          <div className={`chart-footprint-compact-overlay ${footprintOverlay.degraded ? "chart-footprint-compact-overlay-degraded" : ""}`} aria-hidden="true">
            <div className="chart-footprint-compact-kicker">FP{footprintOverlay.degraded ? " LITE" : ""}</div>
            <div className="chart-footprint-compact-head">
              <span>P</span>
              <span>BID</span>
              <span>ASK</span>
              <span>DELTA</span>
              <span>SIG</span>
            </div>
            {footprintOverlay.rows.map((row) => (
              <div key={row.key} className="chart-footprint-compact-row" style={{ top: row.top, minHeight: row.height }}>
                <span className="chart-footprint-compact-price">{formatCompactPrice(row.price)}</span>
                <span className="chart-footprint-compact-buy">{Math.round(row.buyVolume)}</span>
                <span className="chart-footprint-compact-sell">{Math.round(row.sellVolume)}</span>
                <span
                  className={`chart-footprint-compact-delta ${row.delta >= 0 ? "pos" : "neg"}`}
                  style={{ "--fp-delta-abs": String(Math.abs(row.deltaRatio)) } as CSSProperties}
                >
                  {row.delta >= 0 ? "+" : ""}{Math.round(row.delta)}
                </span>
                <span className="chart-footprint-compact-signal-stack">
                  {row.imbalanceSide !== "none" ? (
                    <i
                      className={`chart-footprint-compact-signal chart-footprint-compact-signal-imbalance ${row.imbalanceSide}`}
                      style={{ "--fp-imbalance": String(row.imbalanceStrength) } as CSSProperties}
                    >
                      {row.imbalanceSide === "buy" ? "IMB+" : "IMB-"}
                    </i>
                  ) : null}
                  {row.absorption ? <i className="chart-footprint-compact-signal chart-footprint-compact-signal-absorption">ABS</i> : null}
                </span>
                <span
                  className="chart-footprint-compact-delta-bar"
                  style={{
                    "--fp-delta": String(row.deltaRatio),
                    "--fp-delta-abs": String(Math.abs(row.deltaRatio)),
                  } as CSSProperties}
                />
              </div>
            ))}
          </div>
        ) : null}
        </div>
        {!isLiteMode && footprintOverlay.pausedReason === "perf" && mode === "footprint" && !deskHideFootprintOverlay ? (
          <div className="chart-footprint-compact-paused" aria-live="polite">Footprint paused: frame budget</div>
        ) : null}
        {!isLiteMode && collapsedOverlays.length > 0 ? (
          <div className="chart-overlay-collapse-hint" aria-live="polite">
            auto-collapse: {collapsedOverlays.join(" / ")}
          </div>
        ) : null}
        {!isLiteMode && chartMotionPreset === "auto" ? (
          <div
            className={`chart-auto-stability chart-auto-stability-${autoSwitchHeat}`}
            aria-live="polite"
            aria-label={`auto switches in 5 minutes: ${autoStabilityMetrics.switches5m}`}
            title={autoStabilityTooltip}
          >
            <span className="chart-auto-stability-kicker">AUTO</span>
            <strong>{resolvedMotionPreset.toUpperCase()}</strong>
            <em>{autoStabilityMetrics.switches5m} switches / 5m</em>
            <span className="chart-auto-stability-tooltip" role="tooltip">
              <span className="chart-auto-stability-tooltip-band">
                band cible: {autoTargetBand ? `ok >= ${formatCompactDuration(autoTargetBand.okFloorSec)} · warn ${formatCompactDuration(autoTargetBand.warnFloorSec)}-${formatCompactDuration(autoTargetBand.okFloorSec)} · hot < ${formatCompactDuration(autoTargetBand.warnFloorSec)}` : "-"}
              </span>
              <span>switches/h: {autoStabilityMetrics.switches1h}</span>
              <span className={`chart-auto-stability-tooltip-${autoIntervalTone}`}>
                temps moyen: {autoStabilityMetrics.avgIntervalSec === null ? "-" : formatCompactDuration(autoStabilityMetrics.avgIntervalSec)}
                {autoTargetIntervalSec ? ` (cible ${formatCompactDuration(autoTargetIntervalSec)})` : ""}
              </span>
              <span>dernier switch: {autoStabilityMetrics.lastSwitchAgoSec === null ? "-" : `il y a ${formatCompactDuration(autoStabilityMetrics.lastSwitchAgoSec)}`}</span>
              <span className="chart-auto-stability-sparkline-wrap" aria-hidden="true">
                <svg className="chart-auto-stability-sparkline" viewBox="0 0 120 24" preserveAspectRatio="none">
                  <path d={autoSparklinePath} />
                </svg>
              </span>
            </span>
          </div>
        ) : null}
        </div>
      </div>
      <div className="chart-execution-layer">
        <div className="chart-execution-inner" style={{ "--overlay-alpha": focusOverlayAlpha } as CSSProperties}>
        {!isLiteMode ? (
          <div
            className="chart-inertia-layer"
            style={{
              transform: `translate(${inertia.driftX.toFixed(2)}px, ${inertia.driftY.toFixed(2)}px) scale(${chartFeel.inertiaScale.toFixed(3)})`,
              opacity: Number(chartFeel.inertiaOpacity.toFixed(3)),
            }}
            aria-hidden="true"
          />
        ) : null}
        <canvas ref={customCandleCanvasRef} className={`chart-custom-candle-canvas ${customCandleCanvasActive ? "is-active" : ""}`} aria-hidden="true" />
        {activeCandleOverlay ? (
          <div
            className={`chart-active-candle-band ${activeCandleOverlay.source === "crosshair" ? "is-crosshair" : "is-live"}`}
            style={{ left: activeCandleOverlay.left, width: activeCandleOverlay.width }}
            aria-hidden="true"
          >
            {activeCandleOverlay.source === "crosshair" ? <span className="chart-active-candle-core" /> : null}
          </div>
        ) : null}
        {newCandleFlash > 0 && !isLiteMode && !suppressNewCandleFlash ? (
          <div key={`ncf-${newCandleFlash}`} className="chart-new-candle-flash" aria-hidden="true" />
        ) : null}
        {!customV3RendererEnabled && !nativeCandlesAuthoritative && !isLiteMode && formingCandle && densityConfig.showFormingCandle && !deskSuppressFormingCandle ? (
          <div
            className={`chart-forming-candle chart-forming-candle-${formingCandle.direction} ${Math.abs(formingCandle.closeY - formingCandle.openY) >= 14 ? "is-volatile" : "is-calm"}`}
            style={{ left: formingCandle.left }}
            aria-hidden="true"
          >
            <span className="chart-forming-candle-wick" style={{ top: formingCandle.highY, height: Math.max(3, formingCandle.lowY - formingCandle.highY), opacity: formingCandle.wickOpacity }} />
            <span
              className="chart-forming-candle-body"
              style={{
                width: formingCandle.width,
                top: Math.min(formingCandle.openY, formingCandle.closeY),
                height: Math.max(2, Math.abs(formingCandle.closeY - formingCandle.openY)),
                opacity: formingCandle.opacity,
                borderRadius: formingCandle.radiusPx,
              }}
            />
            <span className="chart-forming-candle-label">forming</span>
          </div>
        ) : null}
        {!isLiteMode && smoothedLivePulse && !suppressLivePulse ? (
          <div
            key={`live-pulse-${smoothedLivePulse.tick}`}
            className="chart-live-pulse"
            style={{ left: smoothedLivePulse.left, top: smoothedLivePulse.top }}
            aria-hidden="true"
          >
            <span className="chart-live-pulse-dot" />
            <span className="chart-live-pulse-ring" />
            <span className="chart-live-pulse-ring chart-live-pulse-ring-secondary" />
            <span className="chart-live-pulse-label"><strong>LIVE</strong><em>{smoothedLivePulse.priceLabel}</em></span>
          </div>
        ) : null}
        {!isLiteMode && showOverlayBadges ? overlayBadges.map((badge) => {
          const offset = overlayOffsets[badge.key] || { x: 0, y: 0 };
          const anchorPrice = lastPriceRef.current ?? badge.price;
          const relativeDistance = Math.abs(badge.price - anchorPrice) / Math.max(1, Math.abs(anchorPrice) * 0.0045);
          const proximity = clamp(1 - relativeDistance, 0.2, 1);
          const baseIntensity = badge.kind === "liquidity" ? 0.95 : badge.tone === "accent" ? 0.72 : 0.58;
          const intensity = clamp(baseIntensity * 0.72 + proximity * 0.28, 0.35, 1);
          const style = {
            left: badge.left,
            top: badge.top,
            "--badge-dx": `${offset.x}px`,
            "--badge-dy": `${offset.y}px`,
            "--badge-intensity": String(intensity),
            "--badge-scale": String(densityConfig.badgeScale),
          } as CSSProperties;

          return (
            <button
              key={badge.key}
              type="button"
              className={`chart-zone-label chart-zone-label-${badge.tone} chart-zone-label-${badge.kind} ${activeBadgeKey === badge.key ? "chart-zone-label-active" : ""} ${draggingBadgeKey === badge.key ? "chart-zone-label-dragging" : ""}`}
              style={style}
              onMouseEnter={() => setActiveBadgeKey(badge.key)}
              onMouseLeave={() => setActiveBadgeKey((current) => (current === badge.key && draggingBadgeKey !== badge.key ? null : current))}
              onFocus={() => setActiveBadgeKey(badge.key)}
              onBlur={() => setActiveBadgeKey((current) => (current === badge.key ? null : current))}
              onClick={() => setActiveBadgeKey((current) => (current === badge.key ? null : badge.key))}
              onKeyDown={(event) => {
                const step = event.shiftKey ? 12 : 4;
                if (event.key === "ArrowLeft") {
                  event.preventDefault();
                  nudgeBadge(badge.key, -step, 0);
                } else if (event.key === "ArrowRight") {
                  event.preventDefault();
                  nudgeBadge(badge.key, step, 0);
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  nudgeBadge(badge.key, 0, -step);
                } else if (event.key === "ArrowDown") {
                  event.preventDefault();
                  nudgeBadge(badge.key, 0, step);
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  setActiveBadgeKey(null);
                }
              }}
              aria-label={`${badge.text} ${badge.detail}`}
              aria-description="Use arrow keys to nudge this badge. Hold Shift for larger moves."
            >
              <span className="chart-zone-handle" onPointerDown={handleBadgePointerDown(badge.key)} aria-hidden="true" />
              {badge.text}
              {activeBadgeKey === badge.key ? (
                <span className="chart-zone-tooltip">{badge.detail} · px {badge.price.toFixed(2)} · drag handle</span>
              ) : null}
            </button>
          );
        }) : null}
        </div>
      </div>
      <div className="chart-overlay-layer">
        <div className="chart-overlay-inner">
          {cursor.visible ? (
            <>
              <div className="chart-cursor-v" style={{ left: cursor.left }} />
              <div className="chart-cursor-h" style={{ top: cursor.top }} />
              <div className="chart-cursor-focus" style={{ left: cursor.left, top: cursor.top }} />
              <div className="chart-cursor-price" style={{ top: cursor.priceTop }}>{cursor.price}</div>
              <div className="chart-cursor-time" style={{ left: cursor.timeLeft }}>{cursor.time}</div>
            </>
          ) : null}
        </div>
      </div>
      {/* TXT branded watermark — replaces TV attribution */}
      <div className="chart-txt-watermark" aria-hidden="true">
        <span className="chart-txt-watermark-logo">TXT</span>
        <span className="chart-txt-watermark-sub">INSTITUTIONAL</span>
      </div>
    </div>
  );
}