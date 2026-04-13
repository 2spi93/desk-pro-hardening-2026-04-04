"use client";

import { useEffect, useMemo, useRef, useState, type ComponentProps } from "react";

import InstitutionalChart from "./InstitutionalChart";
import { preFilterTicks } from "./preCandleFilter";
import type { DenseLegibilityMode, GpuPerceptualTelemetry, PerceptualContinuityTelemetry } from "./chartPerceptual";
import { applyPerceptionPipeline, resolvePerceptionDensity } from "./perceptionEngine";
import { createLatestFrameScheduler } from "./frameEngine";
import { applyVisualProfile, DEFAULT_VISUAL_PROFILE, type VisualProfileName } from "./visualProfiles";
import perceptualDiagnosisTaxonomy from "../../config/perceptual-diagnosis-taxonomy.json";
import { createGpuContext, resizeGpuCanvas } from "../../lib/engine/gpu-chart/context";
import { clamp, pixelAlign, resolvePerceptualDominance, resolvePerceptualRange } from "../../lib/engine/gpu-chart/chartPerceptualDominance";
import { MultiChartManager } from "../../lib/engine/gpu-chart/MultiChartManager";
import type { PriceSignalBand } from "../../lib/engine/gpu-chart/PriceSignalLayer";
import type { TradeBubblePoint } from "../../lib/engine/gpu-chart/TradeBubbleLayer";
import type { OhlcBar } from "../../lib/engine/gpu-chart/sharedBuffer";
import { publishChartFrameBatch, subscribeChartFrame, type LiveChartFrameMeta } from "../../lib/chartFrameFeed";
import type { DomHistoryFrame } from "../../lib/domHistoryBuffer";
import { GoldenFrameWorkerAdapter, type GoldenFrameWorkerEvent } from "../../lib/goldenFrameWorkerAdapter";
import { timeframeToMs } from "../../lib/ohlcvDataEngine";

type InstitutionalChartProps = Omit<ComponentProps<typeof InstitutionalChart>, "onPerceptualTelemetry">;

type CandleLike = {
  label: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  executionFootprint?: {
    delta: number;
    imbalance: number;
    absorption: boolean;
    mlAbsorptionScore?: number;
    stackedImbalance: boolean;
    exhaustion: boolean;
    liquidityScore: number;
  } | null;
  domSnapshot?: {
    depthBalance: number;
    liquidityScore: number;
  } | null;
};

type HeatmapLevelLike = {
  side: "bid" | "ask";
  price: number;
  size: number;
  intensity: number;
};

type GpuViewportFeed = {
  id: string;
  symbol: string;
  candles: CandleLike[];
};

type Props = InstitutionalChartProps & {
  engineMode?: "v3" | "v4";
  viewportGrid?: 1 | 4 | 16 | "auto";
  multiSymbolFeeds?: GpuViewportFeed[];
  smoothingMs?: number;
  heatIntensity?: number;
  heatmapDiscardThreshold?: number;
  domHistory?: DomHistoryFrame[];
  tradeBubbles?: TradeBubblePoint[];
  priceSignalBands?: PriceSignalBand[];
  isPreviewMode?: boolean;
  onPerceptualTelemetry?: (payload: GpuPerceptualTelemetry) => void;
  onViewportFrameMetaChange?: (payload: Record<string, LiveChartFrameMeta>) => void;
};

type GpuMetrics = {
  fps: number;
  drawCalls: number;
  batchSize: number;
  renderer: string | null;
  overlayIntervalMs: number;
};

type NormalizedTradeBubbleState = {
  bubbles: TradeBubblePoint[];
  noiseRatio: number;
};

function createGpuContinuityTelemetry(): PerceptualContinuityTelemetry {
  return {
    liveFrames: 0,
    renderedFrames: 0,
    partialFrames: 0,
    coalescedFrames: 0,
    looseSyncFrames: 0,
    schedulerOverwrites: 0,
    schedulerDeferrals: 0,
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
    lostIntermediateFrames: 0,
    jumpEvents: 0,
    latestJumpPx: 0,
    peakJumpPx: 0,
    continuityMode: "latest-only",
  };
}

function measureGpuLastBarJumpPx(previousBar: OhlcBar | null, nextBar: OhlcBar | null, bars: OhlcBar[], viewportHeight: number): number {
  if (!previousBar || !nextBar || previousBar.time !== nextBar.time || bars.length === 0 || viewportHeight <= 0) {
    return 0;
  }

  let minPrice = Number.POSITIVE_INFINITY;
  let maxPrice = Number.NEGATIVE_INFINITY;
  for (const bar of bars) {
    minPrice = Math.min(minPrice, bar.low, bar.open, bar.close);
    maxPrice = Math.max(maxPrice, bar.high, bar.open, bar.close);
  }

  if (!Number.isFinite(minPrice) || !Number.isFinite(maxPrice)) {
    return 0;
  }

  const rawRange = Math.max(1e-6, maxPrice - minPrice);
  const paddedRange = rawRange * 1.08;
  const pad = (paddedRange - rawRange) * 0.5;
  const domainMin = minPrice - pad;
  const domainMax = maxPrice + pad;
  const priceToY = (price: number) => ((domainMax - price) / Math.max(1e-6, domainMax - domainMin)) * viewportHeight;
  const ranges = [
    [previousBar.open, nextBar.open],
    [previousBar.high, nextBar.high],
    [previousBar.low, nextBar.low],
    [previousBar.close, nextBar.close],
  ] as const;

  let jumpPx = 0;
  for (const [fromPrice, toPrice] of ranges) {
    jumpPx = Math.max(jumpPx, Math.abs(priceToY(fromPrice) - priceToY(toPrice)));
  }

  return jumpPx;
}

type SpanAuthorityMode = "off" | "benchmark";

const AUTHORITATIVE_SPAN_TARGETS: Record<string, number> = {
  "1m": 110,
  "5m": 100,
  "1h": 90,
  "1d": 80,
};

function resolveSpanAuthorityMode(): SpanAuthorityMode {
  if (typeof window === "undefined") {
    return "off";
  }
  const query = new URLSearchParams(window.location.search);
  return query.get("spanAuthority") === "benchmark" ? "benchmark" : "off";
}

function resolveAuthoritativeSpanTarget(timeframe: string, count: number, mode: SpanAuthorityMode): number | null {
  if (mode !== "benchmark") {
    return null;
  }
  const target = AUTHORITATIVE_SPAN_TARGETS[String(timeframe || "").trim()];
  if (!Number.isFinite(target) || target <= 0) {
    return null;
  }
  return Math.max(8, Math.min(count, target));
}

function timeframeSeconds(timeframe: string): number {
  const match = String(timeframe || "").trim().match(/^(\d+)([smhdwM])$/);
  if (!match) {
    return 60;
  }
  const value = Number(match[1]);
  const unit = match[2];
  if (!Number.isFinite(value) || value <= 0) {
    return 60;
  }
  switch (unit) {
    case "s":
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


function formatGpuHudPrice(value: number): string {
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

function formatGpuHudTime(epochSeconds: number, timeframe: string): string {
  if (!Number.isFinite(epochSeconds)) {
    return "--:--";
  }
  const date = new Date(epochSeconds * 1000);
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return timeframeSeconds(timeframe) >= 86_400 ? `${month}/${day}` : `${hours}:${minutes}`;
}

function resolveFeedCandleTimestampMs(candles: CandleLike[]): number | null {
  const label = candles[candles.length - 1]?.label;
  if (!label) {
    return null;
  }
  const parsed = Date.parse(label);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeViewportFeedsForComparison(
  primaryBars: OhlcBar[],
  feeds: Array<{ id: string; symbol: string; bars: OhlcBar[] }>,
): Array<{ id: string; symbol: string; bars: OhlcBar[] }> {
  const filteredFeeds = feeds.filter((feed) => feed.bars.length > 1);
  const masterTime = resolveMasterClockTime(primaryBars, filteredFeeds);
  return filteredFeeds
    .map((feed) => ({
      ...feed,
      bars: normalizeBarsForComparison(syncBarsToMasterClock(feed.bars, masterTime)),
    }))
    .filter((feed) => feed.bars.length > 1);
}

function drawGpuCanvasHud(
  ctx: CanvasRenderingContext2D,
  {
    bars,
    width,
    height,
    timeframe,
    liveFrameMeta,
    viewports,
    viewportMetaMap,
  }: {
    bars: OhlcBar[];
    width: number;
    height: number;
    timeframe: string;
    liveFrameMeta: LiveChartFrameMeta | null;
    viewports: Array<{ id: string; symbol?: string; x: number; y: number; width: number; height: number }>;
    viewportMetaMap: Record<string, LiveChartFrameMeta>;
  },
): void {
  ctx.clearRect(0, 0, width, height);
  if (bars.length === 0 || width < 120 || height < 80) {
    return;
  }

  const rightAxisWidth = 88;
  const bottomAxisHeight = 26;
  const leftPad = 8;
  const topPad = 10;
  const plotLeft = leftPad;
  const plotTop = topPad;
  const plotRight = Math.max(plotLeft + 24, width - rightAxisWidth);
  const plotBottom = Math.max(plotTop + 24, height - bottomAxisHeight);
  const plotWidth = plotRight - plotLeft;
  const plotHeight = plotBottom - plotTop;
  if (plotWidth <= 24 || plotHeight <= 24) {
    return;
  }

  const minPrice = Math.min(...bars.map((bar) => bar.low));
  const maxPrice = Math.max(...bars.map((bar) => bar.high));
  const rawRange = Math.max(1e-6, maxPrice - minPrice);
  const paddedRange = rawRange * 1.08;
  const pad = (paddedRange - rawRange) * 0.5;
  const domainMin = minPrice - pad;
  const domainMax = maxPrice + pad;
  const priceToY = (price: number) => {
    const ratio = (domainMax - price) / Math.max(1e-6, domainMax - domainMin);
    return plotTop + ratio * plotHeight;
  };

  const lastBar = bars[bars.length - 1];
  const lastPrice = lastBar.close;
  const priceLineY = Math.max(plotTop, Math.min(plotBottom, priceToY(lastPrice)));
  const priceUp = lastBar.close >= lastBar.open;
  const accent = priceUp ? "#00ffa3" : "#ff5d5d";
  const accentSoft = priceUp ? "rgba(0,255,163,0.18)" : "rgba(255,93,93,0.18)";

  ctx.save();
  ctx.font = '11px ui-monospace, "SFMono-Regular", Menlo, monospace';
  ctx.textBaseline = "middle";
  ctx.lineWidth = 1;

  const priceTicks = 5;
  for (let index = 0; index < priceTicks; index += 1) {
    const ratio = index / (priceTicks - 1);
    const price = domainMax - ratio * (domainMax - domainMin);
    const y = plotTop + ratio * plotHeight;
    ctx.strokeStyle = index === Math.round((priceTicks - 1) / 2)
      ? "rgba(126, 215, 255, 0.14)"
      : "rgba(126, 215, 255, 0.08)";
    ctx.beginPath();
    ctx.moveTo(plotLeft, y + 0.5);
    ctx.lineTo(plotRight, y + 0.5);
    ctx.stroke();

    ctx.fillStyle = "rgba(214, 228, 243, 0.74)";
    ctx.fillText(formatGpuHudPrice(price), plotRight + 10, y);
  }

  const timeTicks = Math.min(4, Math.max(2, bars.length));
  for (let index = 0; index < timeTicks; index += 1) {
    const barIndex = timeTicks === 1 ? bars.length - 1 : Math.round((index * (bars.length - 1)) / (timeTicks - 1));
    const bar = bars[Math.max(0, Math.min(bars.length - 1, barIndex))];
    const x = plotLeft + (barIndex / Math.max(1, bars.length - 1)) * plotWidth;
    ctx.strokeStyle = "rgba(126, 215, 255, 0.08)";
    ctx.beginPath();
    ctx.moveTo(x + 0.5, plotTop);
    ctx.lineTo(x + 0.5, plotBottom);
    ctx.stroke();

    ctx.textAlign = index === 0 ? "left" : index === timeTicks - 1 ? "right" : "center";
    ctx.fillStyle = "rgba(214, 228, 243, 0.7)";
    ctx.fillText(formatGpuHudTime(bar.time, timeframe), x, plotBottom + 14);
  }

  ctx.strokeStyle = accent;
  ctx.fillStyle = accentSoft;
  ctx.beginPath();
  ctx.moveTo(plotLeft, priceLineY + 0.5);
  ctx.lineTo(plotRight, priceLineY + 0.5);
  ctx.stroke();
  ctx.fillRect(plotLeft, priceLineY - 9, plotRight - plotLeft, 18);

  const badgeText = formatGpuHudPrice(lastPrice);
  ctx.font = '12px ui-monospace, "SFMono-Regular", Menlo, monospace';
  const badgeWidth = Math.ceil(ctx.measureText(badgeText).width) + 18;
  const badgeHeight = 20;
  const badgeX = plotRight + 6;
  const badgeY = Math.max(plotTop, Math.min(plotBottom - badgeHeight, priceLineY - badgeHeight * 0.5));
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.roundRect(badgeX, badgeY, badgeWidth, badgeHeight, 8);
  ctx.fill();
  ctx.fillStyle = "#051018";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(badgeText, badgeX + 9, badgeY + badgeHeight * 0.5);

  if (liveFrameMeta) {
    const statusText = `${liveFrameMeta.syncStatus.toUpperCase()} ${Math.round(liveFrameMeta.confidence * 100)}%`;
    ctx.font = '10px ui-monospace, "SFMono-Regular", Menlo, monospace';
    const statusWidth = Math.ceil(ctx.measureText(statusText).width) + 14;
    ctx.fillStyle = "rgba(6, 14, 24, 0.78)";
    ctx.beginPath();
    ctx.roundRect(plotLeft, plotTop, statusWidth, 18, 8);
    ctx.fill();
    ctx.fillStyle = "rgba(222, 235, 247, 0.88)";
    ctx.textAlign = "left";
    ctx.fillText(statusText, plotLeft + 7, plotTop + 9);
  }

  if (viewports.length > 1) {
    ctx.font = '9px ui-monospace, "SFMono-Regular", Menlo, monospace';
    for (const viewport of viewports) {
      const meta = viewportMetaMap[viewport.id] || null;
      if (!meta || viewport.width < 84 || viewport.height < 48) {
        continue;
      }
      const top = Math.max(0, height - viewport.y - viewport.height);
      const pillX = viewport.x + 6;
      const pillY = top + 6;
      const tone = meta.syncStatus === "atomic" && !meta.partial
        ? { fill: "rgba(8, 22, 18, 0.86)", stroke: "rgba(0, 255, 163, 0.42)", text: "rgba(194, 255, 228, 0.94)" }
        : meta.confidence >= 0.55
          ? { fill: "rgba(29, 22, 8, 0.86)", stroke: "rgba(255, 209, 102, 0.42)", text: "rgba(255, 234, 180, 0.94)" }
          : { fill: "rgba(28, 10, 10, 0.88)", stroke: "rgba(255, 116, 116, 0.42)", text: "rgba(255, 214, 214, 0.94)" };
      const label = `${String(viewport.symbol || viewport.id).slice(0, 8)} ${meta.syncStatus === "atomic" && !meta.partial ? "AT" : meta.partial ? "PT" : "CO"} ${Math.round(meta.confidence * 100)}%`;
      const skewLabel = meta.batchSkewMs != null ? ` ${meta.batchSkewMs}ms` : "";
      const text = `${label}${skewLabel}`;
      const pillWidth = Math.ceil(ctx.measureText(text).width) + 12;
      ctx.fillStyle = tone.fill;
      ctx.strokeStyle = tone.stroke;
      ctx.beginPath();
      ctx.roundRect(pillX, pillY, pillWidth, 16, 7);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = tone.text;
      ctx.fillText(text, pillX + 6, pillY + 8);
    }
  }

  ctx.restore();
}
function normalizeTimes(labels: string[], timeframe: string): number[] {
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
    return value;
  });
}

function isLiveFrameCompatibleWithProps(liveCandles: CandleLike[], propCandles: CandleLike[], timeframe: string): boolean {
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

function resolveDefaultVisibleBarsForTimeframe(
  timeframe: string,
  count: number,
  viewportWidth = 0,
  viewportHeight = 0,
  gridCells: 1 | 4 | 16 = 1,
): number {
  const seconds = timeframeSeconds(timeframe);
  const columnCount = gridCells >= 16 ? 4 : gridCells >= 4 ? 2 : 1;
  const rowCount = gridCells >= 16 ? 4 : gridCells >= 4 ? 2 : 1;
  const effectiveViewportWidth = Math.max(240, viewportWidth > 0 ? viewportWidth / columnCount : 0);
  const effectiveViewportHeight = Math.max(180, viewportHeight > 0 ? viewportHeight / rowCount : 0);
  const viewportAspectRatio = effectiveViewportHeight / Math.max(1, effectiveViewportWidth);
  let targetStepPx = 7.8;
  let minBars = 96;
  let maxBars = 136;

  if (seconds >= 2592000) {
    targetStepPx = 30;
    minBars = 12;
    maxBars = 32;
  } else if (seconds >= 604800) {
    targetStepPx = 24;
    minBars = 18;
    maxBars = 44;
  } else if (seconds >= 86400) {
    targetStepPx = 20;
    minBars = 24;
    maxBars = 56;
  } else if (seconds >= 28800) {
    targetStepPx = 17;
    minBars = 34;
    maxBars = 68;
  } else if (seconds >= 14400) {
    targetStepPx = 15.5;
    minBars = 40;
    maxBars = 76;
  } else if (seconds >= 3600) {
    targetStepPx = 13.5;
    minBars = 48;
    maxBars = 90;
  } else if (seconds >= 1800) {
    targetStepPx = 12;
    minBars = 60;
    maxBars = 104;
  } else if (seconds >= 900) {
    targetStepPx = 11;
    minBars = 72;
    maxBars = 118;
  } else if (seconds >= 300) {
    targetStepPx = 9.8;
    minBars = 84;
    maxBars = 128;
  } else if (seconds >= 60) {
    targetStepPx = 8.8;
    minBars = 96;
    maxBars = 136;
  }

  if (seconds >= 86400) {
    const shortLayoutBoost = clamp((0.62 - viewportAspectRatio) / 0.24, 0, 1);
    const tallLayoutRelief = clamp((viewportAspectRatio - 0.92) / 0.32, 0, 1);
    targetStepPx *= 1 + shortLayoutBoost * 0.3 - tallLayoutRelief * 0.08;
    minBars = Math.max(8, Math.round(minBars * (1 - shortLayoutBoost * 0.18)));
    maxBars = Math.max(minBars + 4, Math.round(maxBars * (1 - shortLayoutBoost * 0.14 + tallLayoutRelief * 0.04)));
  }

  const enforceMinimumVisualDensity = (visibleBars: number, widthPx: number): number => {
    if (!(widthPx > 0) || visibleBars <= 0) {
      return visibleBars;
    }
    const maxPxPerBar = seconds >= 86400 ? 19.25 : seconds >= 14400 ? 13.5 : 11.2;
    const pxPerBar = widthPx / visibleBars;
    if (pxPerBar <= maxPxPerBar) {
      return visibleBars;
    }
    const densityFloorBars = Math.round(widthPx / maxPxPerBar);
    return Math.max(visibleBars, Math.min(count, densityFloorBars));
  };

  const widthAdaptiveBars = effectiveViewportWidth > 0
    ? Math.round(effectiveViewportWidth / targetStepPx)
    : maxBars;
  const boundedBars = Math.max(8, Math.min(count, clamp(widthAdaptiveBars, minBars, maxBars)));
  return enforceMinimumVisualDensity(boundedBars, effectiveViewportWidth);
}

function resolveGpuDiagnosis(input: {
  timeframe: string;
  visibleBars: number;
  targetVisibleBars: number;
  candleStepPx: number;
  bodyWidthPx: number;
  wickWidthPx: number;
}): GpuPerceptualTelemetry["diagnosis"] {
  const primary: string[] = [];
  const runtimeMap = perceptualDiagnosisTaxonomy.runtime as Record<string, string>;
  const canonicalOrder = perceptualDiagnosisTaxonomy.canonicalOrder as string[];
  const safeStep = Math.max(1e-6, input.candleStepPx);
  const bodyToStepRatio = input.bodyWidthPx / safeStep;
  const wickToBodyRatio = input.wickWidthPx / Math.max(1, input.bodyWidthPx);
  const timeframeSec = timeframeSeconds(input.timeframe);
  const isMacro = timeframeSec >= 86400;

  if ((isMacro && (input.bodyWidthPx < 10 || bodyToStepRatio < 0.56)) || bodyToStepRatio < 0.5) {
    primary.push("too_thin_bodies");
  } else if (bodyToStepRatio > 0.9) {
    primary.push("too_thick_bodies");
  }

  if (input.visibleBars < input.targetVisibleBars * 0.84 || (safeStep > 10 && bodyToStepRatio < 0.66)) {
    primary.push("too_loose_spacing");
  } else if (input.visibleBars > input.targetVisibleBars * 1.18) {
    primary.push("too_dense_spacing");
  }

  if (wickToBodyRatio < 0.18 || input.wickWidthPx < 1.35) {
    primary.push("underdeveloped_wicks");
  } else if (wickToBodyRatio > 0.55) {
    primary.push("overgrown_wicks");
  }

  const deduped = canonicalOrder
    .filter((tag) => primary.map((value) => runtimeMap[value] || value).includes(tag))
    .slice(0, 3);
  return {
    primary: deduped.length > 0 ? deduped : ["balanced_structure"],
    summary: (deduped.length > 0 ? deduped : ["balanced_structure"]).join(", "),
  };
}

export default function GpuChartV4Surface({
  engineMode = "v4",
  viewportGrid = "auto",
  multiSymbolFeeds = [],
  smoothingMs = 140,
  heatIntensity = 1,
  heatmapDiscardThreshold = 0.018,
  isPreviewMode = false,
  onPerceptualTelemetry,
  className,
  liveFeedKey,
  timeframe,
  visualProfile = DEFAULT_VISUAL_PROFILE,
  candles,
  heatmapLevels,
  domHistory,
  tradeBubbles,
  priceSignalBands,
  onViewportFrameMetaChange,
  ...rest
}: Props) {
  const spanAuthorityMode = useMemo<SpanAuthorityMode>(() => resolveSpanAuthorityMode(), []);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const initCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const managerRef = useRef<MultiChartManager | null>(null);
  const barsRef = useRef<OhlcBar[]>([]);
  const propCandlesRef = useRef(candles);
  const feedBarsRef = useRef<Array<{ id: string; symbol: string; bars: OhlcBar[] }>>([]);
  const secondarySourceFeedsRef = useRef<Array<{ id: string; symbol: string; bars: OhlcBar[] }>>([]);
  const secondaryBatchedFeedsRef = useRef<Array<{ id: string; symbol: string; bars: OhlcBar[] }>>([]);
  const viewportLayoutRef = useRef<Array<{ id: string; symbol?: string; x: number; y: number; width: number; height: number }>>([]);
  const viewportMetaRef = useRef<Record<string, LiveChartFrameMeta>>({});
  const batchWorkerRef = useRef<GoldenFrameWorkerAdapter | null>(null);
  const multiFeedSourceMapRef = useRef<Map<string, GpuViewportFeed>>(new Map());
  const onViewportFrameMetaChangeRef = useRef(onViewportFrameMetaChange);
  const timeframeRef = useRef(timeframe);
  const visualProfileRef = useRef(visualProfile);
  const subscribedLiveFeedKeyRef = useRef<string | null>(null);
  const visualProfileConfig = useMemo(() => applyVisualProfile(visualProfile), [visualProfile]);
  const effectiveSmoothingMs = useMemo(
    () => (timeframeToMs(timeframe) <= 5_000 ? 0 : (Number.isFinite(smoothingMs) ? Math.max(0, smoothingMs) : 140)),
    [smoothingMs, timeframe],
  );
  const liveFrameSchedulerRef = useRef(createLatestFrameScheduler<CandleLike[]>({
    minFrameMs: visualProfileConfig.frame.minFrameMs,
    strictBucketAlignment: visualProfileConfig.perception.strictBucketAlignment,
  }));
  const targetGridRef = useRef<1 | 4 | 16>(1);
  const diagnosticsLoggedRef = useRef(false);
  const fpsSamplesRef = useRef<number[]>([]);
  const liveMetricsRef = useRef<GpuMetrics>({ fps: 0, drawCalls: 0, batchSize: 0, renderer: null, overlayIntervalMs: 250 });
  const continuityRef = useRef<PerceptualContinuityTelemetry>(createGpuContinuityTelemetry());
  const liveFrameMetaRef = useRef<LiveChartFrameMeta | null>(null);
  const previousRenderedBarRef = useRef<OhlcBar | null>(null);
  const microstructureNoiseRatioRef = useRef(0);
  const frozenRef = useRef(Boolean(rest.frozen));
  const cameraDatasetRef = useRef<{ timeframe: string; liveFeedKey: string | null; count: number }>({
    timeframe,
    liveFeedKey: liveFeedKey ?? null,
    count: 0,
  });

  // ── Input Engine: camera state (bar-index window), inertia, drag ──────────
  const cameraRef = useRef<{ from: number; to: number } | null>(null);
  const panVelocityRef = useRef(0);
  const dragActiveRef = useRef(false);
  const dragLastXRef = useRef(0);
  const wheelCursorFracRef = useRef(0.5);

  const [gpuReady, setGpuReady] = useState(false);
  const [gpuReason, setGpuReason] = useState<"ok" | "unsupported" | "context-lost">("unsupported");
  const [initPhase, setInitPhase] = useState<"canvas-init" | "webgl-live" | "fallback">("canvas-init");
  const [gpuMetrics, setGpuMetrics] = useState<GpuMetrics>({ fps: 0, drawCalls: 0, batchSize: 0, renderer: null, overlayIntervalMs: 250 });
  const [gpuRecoveryEpoch, setGpuRecoveryEpoch] = useState(0);
  const [liveFrameMeta, setLiveFrameMeta] = useState<LiveChartFrameMeta | null>(null);

  const gpuTradeBubbleState = useMemo(() => normalizeTradeBubbles(tradeBubbles), [tradeBubbles]);
  const gpuTradeBubbles = gpuTradeBubbleState.bubbles;
  const gpuBars = useMemo(
    () => toGpuBars(candles, timeframe, visualProfile, gpuTradeBubbleState.noiseRatio),
    [candles, timeframe, visualProfile, gpuTradeBubbleState.noiseRatio],
  );
  const gpuHeatmapLevels = useMemo(() => normalizeHeatmapLevels(heatmapLevels), [heatmapLevels]);
  const gpuDomHistory = useMemo(() => normalizeDomHistory(domHistory), [domHistory]);
  const gpuPriceSignalBands = useMemo(() => normalizePriceSignalBands(priceSignalBands), [priceSignalBands]);

  const secondarySourceFeeds = useMemo(() => {
    return multiSymbolFeeds
      .filter((feed) => Array.isArray(feed.candles) && feed.candles.length > 1)
      .map((feed) => ({
        id: feed.id,
        symbol: feed.symbol,
        bars: toGpuBars(feed.candles, timeframe, visualProfile),
      }))
      .filter((feed) => feed.bars.length > 1);
  }, [multiSymbolFeeds, timeframe, visualProfile]);

  const fallbackFeedBars = useMemo(
    () => normalizeViewportFeedsForComparison(gpuBars, secondarySourceFeeds),
    [gpuBars, secondarySourceFeeds],
  );

  useEffect(() => {
    liveFrameSchedulerRef.current.configure({
      minFrameMs: visualProfileConfig.frame.minFrameMs,
      strictBucketAlignment: visualProfileConfig.perception.strictBucketAlignment,
    });
  }, [visualProfileConfig]);

  useEffect(() => {
    onViewportFrameMetaChangeRef.current = onViewportFrameMetaChange;
  }, [onViewportFrameMetaChange]);

  const targetGrid = useMemo<1 | 4 | 16>(() => {
    if (viewportGrid === 1 || viewportGrid === 4 || viewportGrid === 16) {
      return viewportGrid;
    }
    if (fallbackFeedBars.length >= 15) {
      return 16;
    }
    if (fallbackFeedBars.length >= 3) {
      return 4;
    }
    return 1;
  }, [fallbackFeedBars.length, viewportGrid]);

  useEffect(() => {
    microstructureNoiseRatioRef.current = gpuTradeBubbleState.noiseRatio;
  }, [gpuTradeBubbleState.noiseRatio]);

  useEffect(() => {
    barsRef.current = gpuBars;
  }, [gpuBars]);

  useEffect(() => {
    secondarySourceFeedsRef.current = secondarySourceFeeds;
    multiFeedSourceMapRef.current = new Map(multiSymbolFeeds.map((feed) => [feed.id, feed]));
    if (secondaryBatchedFeedsRef.current.length === 0) {
      feedBarsRef.current = normalizeViewportFeedsForComparison(
        barsRef.current.length > 0 ? barsRef.current : gpuBars,
        secondarySourceFeeds,
      );
    }
  }, [gpuBars, multiSymbolFeeds, secondarySourceFeeds]);

  useEffect(() => {
    const nextCount = gpuBars.length;
    const previous = cameraDatasetRef.current;
    cameraDatasetRef.current = {
      timeframe,
      liveFeedKey: liveFeedKey ?? null,
      count: nextCount,
    };

    if (nextCount <= 0) {
      cameraRef.current = null;
      panVelocityRef.current = 0;
      return;
    }

    const hostWidth = hostRef.current?.clientWidth || 0;
    const hostHeight = hostRef.current?.clientHeight || 0;
    const densityVisibleBars = resolveDefaultVisibleBarsForTimeframe(timeframe, nextCount, hostWidth, hostHeight, targetGrid);
    const authoritativeSpanTarget = resolveAuthoritativeSpanTarget(timeframe, nextCount, spanAuthorityMode);
    const defaultVisibleBars = authoritativeSpanTarget ?? densityVisibleBars;
    const currentCamera = cameraRef.current;
    const hardReset = !currentCamera
      || previous.timeframe !== timeframe
      || previous.liveFeedKey !== (liveFeedKey ?? null)
      || previous.count <= 0
      || Math.abs(previous.count - nextCount) > Math.max(24, previous.count * 0.45);

    if (hardReset) {
      cameraRef.current = {
        from: Math.max(0, nextCount - defaultVisibleBars),
        to: nextCount,
      };
      panVelocityRef.current = 0;
      return;
    }

    const previousSpan = Math.max(8, currentCamera.to - currentCamera.from);
    const nextSpan = Math.max(8, Math.min(nextCount, previousSpan));
    const pinnedRight = currentCamera.to >= previous.count - 2;
    if (pinnedRight) {
      cameraRef.current = {
        from: Math.max(0, nextCount - (authoritativeSpanTarget ?? nextSpan)),
        to: nextCount,
      };
      return;
    }

    const previousCenter = (currentCamera.from + currentCamera.to) * 0.5;
    const previousCenterRatio = previous.count > 0 ? previousCenter / previous.count : 1;
    const nextCenter = clamp(previousCenterRatio * nextCount, nextSpan * 0.5, Math.max(nextSpan * 0.5, nextCount - nextSpan * 0.5));
    cameraRef.current = {
      from: Math.max(0, nextCenter - nextSpan * 0.5),
      to: Math.min(nextCount, nextCenter + nextSpan * 0.5),
    };
  }, [gpuBars, liveFeedKey, spanAuthorityMode, targetGrid, timeframe]);

  useEffect(() => {
    propCandlesRef.current = candles;
  }, [candles]);

  useEffect(() => {
    timeframeRef.current = timeframe;
    visualProfileRef.current = visualProfile;
  }, [timeframe, visualProfile]);

  useEffect(() => {
    frozenRef.current = Boolean(rest.frozen);
  }, [rest.frozen]);

  useEffect(() => {
    if (!liveFeedKey) {
      subscribedLiveFeedKeyRef.current = null;
      return undefined;
    }
    if (subscribedLiveFeedKeyRef.current === liveFeedKey) {
      return undefined;
    }
    subscribedLiveFeedKeyRef.current = liveFeedKey;
    const unsubscribe = subscribeChartFrame(liveFeedKey, (frame) => {
      if (frozenRef.current) {
        return;
      }
      if (!isLiveFrameCompatibleWithProps(frame.candles, propCandlesRef.current, timeframeRef.current)) {
        return;
      }
      continuityRef.current.liveFrames += 1;
      if (frame.meta.partial) {
        continuityRef.current.partialFrames += 1;
      }
      if (frame.meta.coalesced || frame.meta.syncStatus === "coalesced") {
        continuityRef.current.coalescedFrames += 1;
      }
      if (frame.meta.syncStatus === "loose-sync") {
        continuityRef.current.looseSyncFrames += 1;
      }
      liveFrameMetaRef.current = frame.meta;
      viewportMetaRef.current = {
        ...viewportMetaRef.current,
        primary: frame.meta,
      };
      onViewportFrameMetaChangeRef.current?.({ ...viewportMetaRef.current });
      setLiveFrameMeta(frame.meta);
      liveFrameSchedulerRef.current.schedule(frame.candles, (nextCandles) => {
        const nextPrimaryBars = toGpuBars(
          nextCandles,
          timeframeRef.current,
          visualProfileRef.current,
          microstructureNoiseRatioRef.current,
        );
        continuityRef.current.renderedFrames += 1;
        const jumpPx = measureGpuLastBarJumpPx(
          previousRenderedBarRef.current,
          nextPrimaryBars[nextPrimaryBars.length - 1] ?? null,
          nextPrimaryBars,
          hostRef.current?.clientHeight || canvasRef.current?.clientHeight || 0,
        );
        continuityRef.current.latestJumpPx = jumpPx;
        continuityRef.current.peakJumpPx = Math.max(continuityRef.current.peakJumpPx, jumpPx);
        if (jumpPx >= 1.5) {
          continuityRef.current.jumpEvents += 1;
        }
        previousRenderedBarRef.current = nextPrimaryBars[nextPrimaryBars.length - 1] ?? null;
        barsRef.current = nextPrimaryBars;
        feedBarsRef.current = normalizeViewportFeedsForComparison(
          nextPrimaryBars,
          secondaryBatchedFeedsRef.current.length > 0 ? secondaryBatchedFeedsRef.current : secondarySourceFeedsRef.current,
        );
      });
    });

    return () => {
      if (subscribedLiveFeedKeyRef.current === liveFeedKey) {
        subscribedLiveFeedKeyRef.current = null;
      }
      unsubscribe();
      liveFrameSchedulerRef.current.cancel();
      liveFrameMetaRef.current = null;
      previousRenderedBarRef.current = null;
      viewportMetaRef.current = Object.fromEntries(
        Object.entries(viewportMetaRef.current).filter(([key]) => key !== "primary"),
      );
      onViewportFrameMetaChangeRef.current?.({ ...viewportMetaRef.current });
      setLiveFrameMeta(null);
    };
  }, [liveFeedKey]);

  useEffect(() => {
    feedBarsRef.current = normalizeViewportFeedsForComparison(
      barsRef.current.length > 0 ? barsRef.current : gpuBars,
      secondaryBatchedFeedsRef.current.length > 0 ? secondaryBatchedFeedsRef.current : secondarySourceFeeds,
    );
  }, [fallbackFeedBars, gpuBars, secondarySourceFeeds]);

  useEffect(() => {
    const worker = new GoldenFrameWorkerAdapter((event: GoldenFrameWorkerEvent) => {
      if (event.type !== "publish-frame-batch") {
        return;
      }
      const nextMeta: Record<string, LiveChartFrameMeta> = viewportMetaRef.current.primary
        ? { primary: viewportMetaRef.current.primary }
        : {};
      const nextFeeds: Array<{ id: string; symbol: string; bars: OhlcBar[] }> = [];

      for (const frame of event.batch.frames) {
        const source = multiFeedSourceMapRef.current.get(frame.feedKey);
        if (!source) {
          continue;
        }
        nextMeta[frame.feedKey] = frame.meta;
        nextFeeds.push({
          id: source.id,
          symbol: source.symbol,
          bars: toGpuBars(frame.candles, timeframeRef.current, visualProfileRef.current),
        });
      }

      publishChartFrameBatch(event.batch.batchKey, event.batch.frames.map((frame) => ({
        feedKey: frame.feedKey,
        candles: frame.candles,
        meta: frame.meta,
      })));

      viewportMetaRef.current = nextMeta;
      secondaryBatchedFeedsRef.current = nextFeeds;
      feedBarsRef.current = normalizeViewportFeedsForComparison(
        barsRef.current,
        nextFeeds.length > 0 ? nextFeeds : secondarySourceFeedsRef.current,
      );
      onViewportFrameMetaChangeRef.current?.({ ...viewportMetaRef.current });
    });

    batchWorkerRef.current = worker;
    return () => {
      if (batchWorkerRef.current === worker) {
        batchWorkerRef.current = null;
      }
      worker.terminate();
    };
  }, []);

  useEffect(() => {
    const worker = batchWorkerRef.current;
    const sourceFeeds = multiSymbolFeeds.filter((feed) => Array.isArray(feed.candles) && feed.candles.length > 1);
    if (sourceFeeds.length === 0) {
      secondaryBatchedFeedsRef.current = [];
      viewportMetaRef.current = viewportMetaRef.current.primary ? { primary: viewportMetaRef.current.primary } : {};
      feedBarsRef.current = normalizeViewportFeedsForComparison(barsRef.current, secondarySourceFeedsRef.current);
      onViewportFrameMetaChangeRef.current?.({ ...viewportMetaRef.current });
      return;
    }
    if (!worker || !worker.isAvailable()) {
      secondaryBatchedFeedsRef.current = [];
      feedBarsRef.current = normalizeViewportFeedsForComparison(barsRef.current, secondarySourceFeedsRef.current);
      return;
    }
    const dynamicBufferMs = liveFrameMetaRef.current?.dynamicBufferMs ?? 50;
    const adaptiveGraceMs = Math.max(1, Math.round(dynamicBufferMs * 0.1));
    worker.queueFrameBatch({
      batchKey: `${timeframe}|${sourceFeeds.map((feed) => feed.id).join(",")}`,
      frames: sourceFeeds.map((feed) => ({
        feedKey: feed.id,
        candles: feed.candles,
        createdAt: Date.now(),
        tradeTsMs: resolveFeedCandleTimestampMs(feed.candles),
        depthTsMs: resolveFeedCandleTimestampMs(feed.candles),
        depthSequence: null,
        coalesced: false,
        dynamicBufferMs,
        adaptiveGraceMs,
        backlog: 0,
      })),
    });
  }, [multiSymbolFeeds, timeframe]);

  useEffect(() => {
    targetGridRef.current = targetGrid;
  }, [targetGrid]);

  useEffect(() => {
    const manager = managerRef.current;
    if (!manager) {
      return;
    }
    manager.setLastBarSmoothingMs(effectiveSmoothingMs);
  }, [effectiveSmoothingMs]);

  // ── Phase 1: draw a static 2D frame immediately so the panel is never blank ──
  useEffect(() => {
    const canvas = initCanvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host) return;

    const w = Math.max(1, host.clientWidth);
    const h = Math.max(1, host.clientHeight);
    canvas.width = w;
    canvas.height = h;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.fillStyle = "#050d15";
    ctx.fillRect(0, 0, w, h);

    // Subtle horizontal grid lines
    ctx.strokeStyle = "rgba(100, 180, 255, 0.06)";
    ctx.lineWidth = 1;
    for (let i = 1; i < 6; i++) {
      const y = Math.round((h / 6) * i) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    // Static candle bars — last 80 primary bars for instant visual feedback
    const bars = gpuBars.slice(-80);
    if (bars.length > 1) {
      const { minPrice: minP, maxPrice: maxP } = resolvePerceptualRange(bars, bars.length);
      const priceRange = Math.max(1e-6, maxP - minP);
      const spacingPx = w / bars.length;
      const devicePixelRatio = w / Math.max(1, host.clientWidth || w);
      for (let i = 0; i < bars.length; i++) {
        const b = bars[i];
        const dominance = resolvePerceptualDominance(b, {
          spacingPx,
          volatility: Math.min(1, Math.max(0, ((b.high - b.low) / Math.max(1e-6, priceRange)) * 5)),
          density: Math.min(1, bars.length / 80),
          zoom: 1,
          devicePixelRatio,
        });
        const bw = Math.max(2, Math.round(dominance.bodyWidthPx));
        const bx = Math.floor((i / bars.length) * w + spacingPx * 0.5 - bw * 0.5);
        const openY = h - ((b.open - minP) / priceRange) * h;
        const closeY = h - ((b.close - minP) / priceRange) * h;
        const highY = h - ((b.high - minP) / priceRange) * h;
        const lowY = h - ((b.low - minP) / priceRange) * h;
        const isUp = b.close >= b.open;

        ctx.strokeStyle = isUp ? "rgba(0,255,136,0.68)" : "rgba(255,59,59,0.72)";
        ctx.fillStyle = isUp ? "rgba(0,255,136,0.38)" : "rgba(255,59,59,0.4)";
        ctx.lineWidth = pixelAlign(dominance.wickWidthPx, devicePixelRatio);

        ctx.beginPath();
        ctx.moveTo(bx + bw / 2, highY);
        ctx.lineTo(bx + bw / 2, lowY);
        ctx.stroke();

        const bodyTop = Math.min(openY, closeY);
        const bodyH = Math.max(dominance.minBodyHeightPx, Math.abs(closeY - openY));
        ctx.fillRect(bx, bodyTop, bw, bodyH);
      }
    }

    ctx.fillStyle = "rgba(100, 200, 255, 0.45)";
    ctx.font = "10px monospace";
    ctx.fillText("\u26a1 GPU init\u2026", 8, h - 8);
  }, [gpuBars]);

  // ── Phase 2: init WebGL2 deferred 1 tick so 2D frame paints first ────────
  useEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host) return;

    let metricsInterval: ReturnType<typeof setInterval> | null = null;
    let contextLostHandler: ((e: Event) => void) | null = null;
    let contextRestoredHandler: (() => void) | null = null;

    const initTimer = setTimeout(() => {
      const result = createGpuContext(canvas);
      setGpuReason(result.reason);
      if (!diagnosticsLoggedRef.current) {
        diagnosticsLoggedRef.current = true;
        console.info("[gpu-chart-v4] runtime", {
          webgl2: result.webgl2,
          reason: result.reason,
          renderer: result.renderer,
          vendor: result.vendor,
        });
      }
      if (!result.gl) {
        setGpuReady(false);
        setInitPhase("fallback");
        return;
      }

      const gl = result.gl;
      const manager = new MultiChartManager(gl);
      managerRef.current = manager;
      manager.setLastBarSmoothingMs(effectiveSmoothingMs);
      liveMetricsRef.current.renderer = result.renderer;
      liveMetricsRef.current.overlayIntervalMs = manager.getMetrics().overlayIntervalMs;
      setGpuReady(true);
      setInitPhase("webgl-live");

      // ── Context loss / restore ────────────────────────────────────────────
      const handleContextLost = (e: Event) => {
        e.preventDefault();
        if (rafRef.current !== null) {
          window.cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
        continuityRef.current.recoveryClears += 1;
        previousRenderedBarRef.current = null;
        setGpuReady(false);
        setGpuReason("context-lost");
        setInitPhase("fallback");
        console.warn("[gpu-chart-v4] context lost — waiting for restore");
      };

      const handleContextRestored = () => {
        console.info("[gpu-chart-v4] context restored — reinitialising");
        setInitPhase("canvas-init");
        setGpuReady(false);
        setGpuReason("ok");
        fpsSamplesRef.current = [];
        liveMetricsRef.current = { fps: 0, drawCalls: 0, batchSize: 0, renderer: null, overlayIntervalMs: 250 };
        setGpuMetrics({ fps: 0, drawCalls: 0, batchSize: 0, renderer: null, overlayIntervalMs: 250 });
        diagnosticsLoggedRef.current = false;
        setGpuRecoveryEpoch((current) => current + 1);
      };

      contextLostHandler = handleContextLost;
      contextRestoredHandler = handleContextRestored;
      canvas.addEventListener("webglcontextlost", contextLostHandler);
      canvas.addEventListener("webglcontextrestored", contextRestoredHandler);
      // ────────────────────────────────────────────────────────────────────

      const draw = (frameTs: number) => {
        // Rolling 60-sample FPS counter
        const samples = fpsSamplesRef.current;
        samples.push(frameTs);
        if (samples.length > 60) samples.shift();
        if (samples.length >= 2) {
          const elapsed = samples[samples.length - 1] - samples[0];
          liveMetricsRef.current.fps = Math.round(((samples.length - 1) / elapsed) * 1000);
        }

        // ── Camera boot: init on first frame that has bars ────────────────
        const frameSnapshot = {
          bars: barsRef.current,
          feeds: feedBarsRef.current,
          heatmapLevels: gpuHeatmapLevels,
          domHistory: gpuDomHistory,
          tradeBubbles: gpuTradeBubbles,
          priceSignalBands: gpuPriceSignalBands,
          liveFrameMeta: liveFrameMetaRef.current,
          viewportMetaMap: { ...viewportMetaRef.current },
          timeframe: timeframeRef.current,
          mode: rest.mode,
          symbol: rest.symbol,
        };
        const allBars = frameSnapshot.bars;
        if (cameraRef.current === null && allBars.length > 0) {
          const densityVisible = resolveDefaultVisibleBarsForTimeframe(
            timeframeRef.current,
            allBars.length,
            canvas.clientWidth || host.clientWidth || 0,
            canvas.clientHeight || host.clientHeight || 0,
            targetGridRef.current,
          );
          const defaultVisible = resolveAuthoritativeSpanTarget(timeframeRef.current, allBars.length, spanAuthorityMode) ?? densityVisible;
          cameraRef.current = { from: allBars.length - defaultVisible, to: allBars.length };
        }
        // Track live edge: if camera was pinned to the right edge, advance it
        if (cameraRef.current !== null && allBars.length > 0) {
          const cam = cameraRef.current;
          const span = cam.to - cam.from;
          const authoritativeSpanTarget = resolveAuthoritativeSpanTarget(timeframeRef.current, allBars.length, spanAuthorityMode);
          // "pinned to edge" = to was within 2 bars of previous total
          if (cam.to >= allBars.length - 2) {
            cameraRef.current = { from: Math.max(0, allBars.length - (authoritativeSpanTarget ?? span)), to: allBars.length };
          }
        }
        // Apply pan inertia (decay 0.90/frame ≈ stops in ~20 frames)
        if (Math.abs(panVelocityRef.current) > 0.004) {
          panVelocityRef.current *= 0.90;
          const cam = cameraRef.current;
          if (cam !== null) {
            const span = cam.to - cam.from;
            let nf = cam.from + panVelocityRef.current;
            let nt = cam.to + panVelocityRef.current;
            if (nf < 0) { nt -= nf; nf = 0; }
            if (nt > allBars.length) { nf -= (nt - allBars.length); nt = allBars.length; }
            cameraRef.current = { from: Math.max(0, nf), to: Math.min(allBars.length, nt) };
            void span;
          }
        } else {
          panVelocityRef.current = 0;
        }
        // Resolve visible primary bars from camera window
        const cam = cameraRef.current;
        const primaryBars = cam !== null && cam.to > cam.from
          ? allBars.slice(Math.max(0, Math.round(cam.from)), Math.min(allBars.length, Math.round(cam.to)))
          : allBars.slice(-80);

        const renderScale = targetGridRef.current === 16 ? 0.7 : targetGridRef.current === 4 ? 0.85 : 1;
        resizeGpuCanvas(canvas, gl, renderScale);
        const width = canvas.width;
        const height = canvas.height;
        const nextViewports = buildViewports({
          width,
          height,
          grid: targetGridRef.current,
          primarySymbol: frameSnapshot.symbol,
          primaryBars,
          renderCandles: frameSnapshot.mode !== "footprint",
          primaryHeatmapLevels: frameSnapshot.heatmapLevels,
          primaryDomHistory: frameSnapshot.domHistory,
          primaryTradeBubbles: frameSnapshot.tradeBubbles,
          primaryPriceSignalBands: frameSnapshot.priceSignalBands,
          heatIntensity,
          heatmapDiscardThreshold,
          feeds: frameSnapshot.feeds,
        });
        viewportLayoutRef.current = nextViewports.map((viewport) => ({
          id: viewport.id,
          symbol: viewport.symbol,
          x: viewport.x,
          y: viewport.y,
          width: viewport.width,
          height: viewport.height,
        }));
        manager.setViewports(nextViewports);
        manager.render(frameTs);

        const overlayCanvas = overlayCanvasRef.current;
        if (overlayCanvas) {
          const overlayWidthCss = Math.max(1, host.clientWidth || canvas.clientWidth || 1);
          const overlayHeightCss = Math.max(1, host.clientHeight || canvas.clientHeight || 1);
          const overlayDpr = Math.max(1, window.devicePixelRatio || 1);
          const overlayWidth = Math.max(1, Math.round(overlayWidthCss * overlayDpr));
          const overlayHeight = Math.max(1, Math.round(overlayHeightCss * overlayDpr));
          if (overlayCanvas.width !== overlayWidth || overlayCanvas.height !== overlayHeight) {
            overlayCanvas.width = overlayWidth;
            overlayCanvas.height = overlayHeight;
          }
          const overlayCtx = overlayCanvas.getContext("2d");
          if (overlayCtx) {
            overlayCtx.setTransform(overlayDpr, 0, 0, overlayDpr, 0, 0);
            drawGpuCanvasHud(overlayCtx, {
              bars: primaryBars,
              width: overlayWidthCss,
              height: overlayHeightCss,
              timeframe: frameSnapshot.timeframe,
              liveFrameMeta: frameSnapshot.liveFrameMeta,
              viewports: viewportLayoutRef.current,
              viewportMetaMap: frameSnapshot.viewportMetaMap,
            });
          }
        }

        const m = manager.getMetrics();
        liveMetricsRef.current.drawCalls = m.drawCalls;
        liveMetricsRef.current.batchSize = m.batchSize;
        liveMetricsRef.current.overlayIntervalMs = m.overlayIntervalMs;

        rafRef.current = window.requestAnimationFrame(draw);
      };

      rafRef.current = window.requestAnimationFrame(draw);

      // Push live metrics → React state every 500ms (avoids per-frame re-renders)
      metricsInterval = setInterval(() => {
        const nextMetrics = { ...liveMetricsRef.current };
        const schedulerDiagnostics = liveFrameSchedulerRef.current.getDiagnostics();
        const continuity = continuityRef.current;
        const continuitySnapshot: PerceptualContinuityTelemetry = {
          ...continuity,
          schedulerOverwrites: schedulerDiagnostics.overwrittenPendingCount,
          schedulerDeferrals: schedulerDiagnostics.minFrameDeferralCount,
          lostIntermediateFrames: schedulerDiagnostics.overwrittenPendingCount,
        };
        setGpuMetrics(nextMetrics);

        const canvasWidth = host.clientWidth || canvas.clientWidth || 0;
        const canvasHeight = host.clientHeight || canvas.clientHeight || 0;
        const pixelRatio = canvasWidth > 0 ? canvas.width / canvasWidth : Math.max(1, window.devicePixelRatio || 1);
        const telemetrySnapshot = {
          timeframe: timeframeRef.current,
          symbol: rest.symbol,
          mode: rest.mode,
          liveFrameMeta: liveFrameMetaRef.current,
        };
        const visibleBars = Math.max(0, Math.round(cameraRef.current ? (cameraRef.current.to - cameraRef.current.from) : barsRef.current.length));
        const candleStepPx = visibleBars > 0 && canvasWidth > 0 ? canvasWidth / visibleBars : 0;
        const densityVisibleBars = resolveDefaultVisibleBarsForTimeframe(
          telemetrySnapshot.timeframe,
          Math.max(visibleBars, barsRef.current.length),
          canvasWidth,
          canvasHeight,
          targetGridRef.current,
        );
        const authoritativeTargetBars = resolveAuthoritativeSpanTarget(telemetrySnapshot.timeframe, Math.max(visibleBars, barsRef.current.length), spanAuthorityMode);
        const recommendedVisibleBars = authoritativeTargetBars ?? densityVisibleBars;
        const spacing = resolveGpuSpacingTelemetry(candleStepPx, visibleBars, recommendedVisibleBars);
        const diagnosis = resolveGpuDiagnosis({
          timeframe: telemetrySnapshot.timeframe,
          visibleBars,
          targetVisibleBars: recommendedVisibleBars,
          candleStepPx,
          bodyWidthPx: spacing.preferredBodyWidthPx,
          wickWidthPx: spacing.wickWidthPx,
        });
        const camera = cameraRef.current;

        host.setAttribute("data-gpu-timeframe", telemetrySnapshot.timeframe);
        host.setAttribute("data-gpu-pan-mode", "left-drag");
        host.setAttribute("data-gpu-visible-bars", String(visibleBars));
        host.setAttribute("data-gpu-target-visible-bars", String(recommendedVisibleBars));
        host.setAttribute("data-gpu-span-authority-mode", spanAuthorityMode);
        host.setAttribute("data-gpu-span-authority-target-bars", authoritativeTargetBars != null ? String(authoritativeTargetBars) : "");
        host.setAttribute("data-gpu-span-authority-status", authoritativeTargetBars != null && visibleBars >= authoritativeTargetBars ? "PASS" : authoritativeTargetBars != null ? "FAIL" : "OFF");
        host.setAttribute("data-gpu-diagnosis-summary", diagnosis.summary);
        host.setAttribute("data-gpu-diagnosis-primary", diagnosis.primary.join(","));
        if (camera) {
          host.setAttribute("data-gpu-camera-from", String(camera.from));
          host.setAttribute("data-gpu-camera-to", String(camera.to));
        }

        if (!onPerceptualTelemetry) {
          return;
        }

        onPerceptualTelemetry({
          engine: "v4",
          symbol: telemetrySnapshot.symbol,
          timeframe: telemetrySnapshot.timeframe,
          mode: telemetrySnapshot.mode,
          renderer: nextMetrics.renderer,
          viewportWidth: canvasWidth,
          viewportHeight: canvasHeight,
          pixelRatio,
          visibleBars,
          candleStepPx,
          grid: {
            cells: targetGridRef.current,
            label: targetGridRef.current === 16 ? "4x4" : targetGridRef.current === 4 ? "2x2" : "1x1",
            viewportCount: Math.max(1, feedBarsRef.current.length + 1),
          },
          sync: telemetrySnapshot.liveFrameMeta
            ? {
              status: telemetrySnapshot.liveFrameMeta.syncStatus,
              confidence: telemetrySnapshot.liveFrameMeta.confidence,
              partial: telemetrySnapshot.liveFrameMeta.partial,
              coalesced: telemetrySnapshot.liveFrameMeta.coalesced,
              stallAgeMs: telemetrySnapshot.liveFrameMeta.stallAgeMs,
              dynamicBufferMs: telemetrySnapshot.liveFrameMeta.dynamicBufferMs,
            }
            : {
              status: "unavailable",
              confidence: null,
              partial: false,
              coalesced: false,
              stallAgeMs: null,
              dynamicBufferMs: null,
            },
          worker: {
            batchActive: Boolean(batchWorkerRef.current?.isAvailable()),
            mode: batchWorkerRef.current?.isAvailable() ? "worker" : "best-effort",
          },
          spacing,
          performance: {
            fps: nextMetrics.fps,
            drawCalls: nextMetrics.drawCalls,
            batchSize: nextMetrics.batchSize,
            overlayIntervalMs: nextMetrics.overlayIntervalMs,
            smoothingMs: effectiveSmoothingMs,
          },
          continuity: continuitySnapshot,
          diagnosis,
          updatedAt: new Date().toISOString(),
        });
      }, 500);
    }, 0);

    return () => {
      clearTimeout(initTimer);
      if (metricsInterval !== null) clearInterval(metricsInterval);
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (contextLostHandler) {
        canvas.removeEventListener("webglcontextlost", contextLostHandler);
      }
      if (contextRestoredHandler) {
        canvas.removeEventListener("webglcontextrestored", contextRestoredHandler);
      }
      managerRef.current?.dispose();
      managerRef.current = null;
    };
  }, [effectiveSmoothingMs, gpuDomHistory, gpuHeatmapLevels, gpuPriceSignalBands, gpuRecoveryEpoch, gpuTradeBubbles, heatIntensity, heatmapDiscardThreshold, onPerceptualTelemetry, rest.mode, rest.symbol, timeframe]);

  // ── Input Engine: wheel zoom + left-drag pan + inertia ───────────────────
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const shouldHandleChartPointer = (target: EventTarget | null) => {
      if (!(target instanceof Element)) {
        return false;
      }
      return Boolean(target.closest(".gpu-chart-v4-canvas, .gpu-chart-v4-init-canvas"));
    };

    const applyPan = (deltaBars: number) => {
      const cam = cameraRef.current;
      if (!cam) return;
      const allLen = barsRef.current.length;
      let nf = cam.from + deltaBars;
      let nt = cam.to + deltaBars;
      if (nf < 0) { nt -= nf; nf = 0; }
      if (nt > allLen) { nf -= (nt - allLen); nt = allLen; }
      cameraRef.current = { from: Math.max(0, nf), to: Math.min(allLen, nt) };
    };

    const onWheel = (e: WheelEvent) => {
      // Only handle wheel events that originate from within the chart canvas area
      if ((e.target as Element)?.closest(".panel, .terminal-v2-ai-hud, .terminal-v2-execution-strip")) return;
      e.preventDefault();
      e.stopPropagation();

      const cam = cameraRef.current;
      if (!cam) return;

      const rect = host.getBoundingClientRect();
      const cursorFrac = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
      wheelCursorFracRef.current = cursorFrac;

      const adx = Math.abs(e.deltaX);
      const ady = Math.abs(e.deltaY);
      const hasHorizontalIntent = adx > 1;
      const hasVerticalIntent = ady > 0.5;
      const isPrecisionZoomGesture = e.ctrlKey || e.metaKey;
      const axisRatio = Math.max(adx, ady) / Math.max(1, Math.min(adx, ady));
      const nearDiagonalGesture = hasHorizontalIntent && hasVerticalIntent && axisRatio < 1.18;
      const shouldZoom = isPrecisionZoomGesture
        || (hasVerticalIntent && !hasHorizontalIntent)
        || (hasVerticalIntent && ady > adx * 1.08)
        || (nearDiagonalGesture && ady >= adx * 0.92);
      const shouldPan = !shouldZoom && hasHorizontalIntent;

      // Trackpad horizontal swipe (deltaX dominant) → pan only
      if (shouldPan) {
        const barsPerPixel = (cam.to - cam.from) / Math.max(1, rect.width);
        const deltaBars = e.deltaX * barsPerPixel * 0.5;
        panVelocityRef.current = deltaBars * 0.25;
        applyPan(deltaBars);
        return;
      }

      // Vertical wheel / trackpad pinch → zoom centred on cursor.
      // Scroll-up (deltaY < 0) narrows the visible span for a conventional zoom-in feel.
      if (shouldZoom) {
        const span = cam.to - cam.from;
        const allLen = barsRef.current.length;
        const zoomFactor = Math.exp(e.deltaY * 0.0012);
        const nextSpan = Math.max(8, Math.min(allLen, span * zoomFactor));
        const cursorBar = cam.from + cursorFrac * span;
        const leftFrac = (cursorBar - cam.from) / span;
        const rightFrac = (cam.to - cursorBar) / span;
        let nf = cursorBar - leftFrac * nextSpan;
        let nt = cursorBar + rightFrac * nextSpan;
        if (nf < 0) { nt -= nf; nf = 0; }
        if (nt > allLen) { nf -= (nt - allLen); nt = allLen; }
        cameraRef.current = { from: Math.max(0, nf), to: Math.min(allLen, nt) };
      }
    };

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0 || !shouldHandleChartPointer(e.target)) return;
      e.preventDefault();
      dragActiveRef.current = true;
      dragLastXRef.current = e.clientX;
      host.classList.add("chart-time-pan-active");
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!dragActiveRef.current) return;
      e.preventDefault();
      const cam = cameraRef.current;
      if (!cam) return;
      const rect = host.getBoundingClientRect();
      const deltaX = e.clientX - dragLastXRef.current;
      dragLastXRef.current = e.clientX;
      if (Math.abs(deltaX) < 0.25) return;
      e.preventDefault();
      const barsPerPixel = (cam.to - cam.from) / Math.max(1, rect.width);
      const deltaBars = -deltaX * barsPerPixel;
      // Seed inertia with a fraction of this frame's velocity
      panVelocityRef.current = deltaBars * 0.15;
      applyPan(deltaBars);
    };

    const stopDrag = () => {
      if (!dragActiveRef.current) return;
      dragActiveRef.current = false;
      host.classList.remove("chart-time-pan-active");
    };

    const onMouseUp = (e: MouseEvent) => {
      if (e.button === 0 || dragActiveRef.current) {
        stopDrag();
      }
    };

    host.addEventListener("wheel", onWheel, { passive: false });
    host.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("blur", stopDrag);

    return () => {
      host.removeEventListener("wheel", onWheel);
      host.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("blur", stopDrag);
    };
  }, []);

  const showFallback = engineMode !== "v4" || initPhase === "fallback";

  return (
    <div ref={hostRef} data-phase={initPhase} className={`gpu-chart-v4-shell ${className || ""}`}>
      {/* 2D static init frame — fades out when WebGL2 takes over */}
      <canvas ref={initCanvasRef} className="gpu-chart-v4-init-canvas" aria-hidden="true" />
      {/* WebGL2 live canvas — fades in once context is ready */}
      <canvas ref={canvasRef} className="gpu-chart-v4-canvas" aria-hidden="true" />
      <canvas ref={overlayCanvasRef} className="gpu-chart-v4-overlay-canvas" aria-hidden="true" />
      {/* Status badge */}
      <div className={`gpu-chart-v4-status ${gpuReady ? "ready" : "fallback"}`}>
        <span className="gpu-chart-v4-kicker">Engine {engineMode.toUpperCase()}</span>
        <span>
          {gpuReady
            ? `GPU renderer live \u2022 ${targetGrid === 16 ? "4x4" : targetGrid === 4 ? "2x2" : "1x1"} \u2022 feeds ${Math.max(1, (secondaryBatchedFeedsRef.current.length > 0 ? secondaryBatchedFeedsRef.current.length : fallbackFeedBars.length) + 1)}${liveFrameMeta ? ` \u2022 ${liveFrameMeta.syncStatus.toUpperCase()} ${(liveFrameMeta.confidence * 100).toFixed(0)}%` : ""}`
            : initPhase === "canvas-init"
            ? "Initializing GPU\u2026"
            : initPhase === "fallback"
            ? `Fallback V3 \u2022 ${gpuReason}`
            : `Fallback V3 \u2022 ${gpuReason}`}
        </span>
      </div>
      {/* GPU metrics panel — visible only when WebGL2 is live */}
      {gpuReady && (
        <div className="gpu-metrics-panel">
          <span className="gpu-metric">
            <span className="gm-label">FPS</span>
            <span
              className={`gm-value ${gpuMetrics.fps >= 30 ? "gm-good" : gpuMetrics.fps >= 15 ? "gm-warn" : gpuMetrics.fps > 0 ? "gm-bad" : ""}`}
            >
              {gpuMetrics.fps > 0 ? gpuMetrics.fps : "\u2014"}
            </span>
          </span>
          <span className="gm-sep" />
          <span className="gpu-metric">
            <span className="gm-label">DC</span>
            <span className="gm-value">{gpuMetrics.drawCalls > 0 ? gpuMetrics.drawCalls : "\u2014"}</span>
          </span>
          <span className="gm-sep" />
          <span className="gpu-metric">
            <span className="gm-label">BATCH</span>
            <span className="gm-value">{gpuMetrics.batchSize > 0 ? gpuMetrics.batchSize : "\u2014"}</span>
          </span>
          {gpuMetrics.renderer && (
            <>
              <span className="gm-sep" />
              <span className="gpu-metric gpu-metric--renderer">
                <span className="gm-label">GPU</span>
                <span className="gm-value gm-renderer">
                  {gpuMetrics.renderer.split(/\s+/).slice(0, 3).join(" ")}
                </span>
              </span>
            </>
          )}
        </div>
      )}
      <div className="chart-timezone-pill" aria-hidden="true">UTC | drag pan</div>
      {gpuReady && isPreviewMode ? (
        <div className="gpu-chart-v4-preview-banner" aria-live="polite">
          <strong>Preview candles</strong>
          <span>Feed degraded: display-only candles, perception and execution remain suspended.</span>
        </div>
      ) : null}
      {showFallback ? (
        <InstitutionalChart
          {...rest}
          className={`gpu-chart-v4-fallback ${className || ""}`}
          liveFeedKey={liveFeedKey}
          timeframe={timeframe}
          visualProfile={visualProfile}
          candles={candles}
        />
      ) : null}
    </div>
  );
}

function resolveGpuSpacingTelemetry(candleStepPx: number, visibleBars: number, targetVisibleBars = visibleBars): GpuPerceptualTelemetry["spacing"] {
  const safeStep = Number.isFinite(candleStepPx) ? Math.max(0, candleStepPx) : 0;
  const denseMode: DenseLegibilityMode = safeStep > 0 && safeStep <= 1.7
    ? "micro"
    : safeStep > 0 && safeStep <= 3.2
      ? "dense"
      : "off";
  const pixelSnapping = safeStep > 0 && safeStep <= 8;
  const minGapPx = denseMode === "micro"
    ? 0.35
    : denseMode === "dense"
      ? 0.65
      : Math.max(1.1, safeStep * 0.18);
  const preferredBodyWidthPx = safeStep > 0
    ? Math.max(1, Math.floor(safeStep * (denseMode === "micro" ? 0.9 : denseMode === "dense" ? 0.75 : 0.6)))
    : 0;
  const wickWidthPx = 1;

  return {
    pixelSnapping,
    denseMode,
    preferredBodyWidthPx,
    wickWidthPx,
    minGapPx,
    targetVisibleBars: Math.max(targetVisibleBars, 0),
  };
}

function toGpuBars(
  candles: CandleLike[],
  timeframe: string,
  visualProfile: VisualProfileName,
  microstructureNoiseRatio = 0,
): OhlcBar[] {
  const rawBars = candles.map((candle, index) => {
    const parsed = Date.parse(candle.label);
    return {
      time: Number.isFinite(parsed) ? parsed / 1000 : index,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
    };
  });

  const density = resolvePerceptionDensity({ visibleBars: rawBars.length });
  return applyPerceptionPipeline(rawBars, {
    density,
    timeframe,
    volatility: 0,
    visualProfile,
    microstructureNoiseRatio,
  }).map((bar, index) => {
    const source = candles[index];
    const footprint = source?.executionFootprint || null;
    const dom = source?.domSnapshot || null;
    const bias = clamp(footprint?.imbalance ?? dom?.depthBalance ?? 0, -1, 1);
    const liquidityScore = clamp(Math.max(footprint?.liquidityScore ?? 0, dom?.liquidityScore ?? 0), 0, 1);
    const mlAbsorptionScore = clamp(footprint?.mlAbsorptionScore ?? (footprint?.absorption ? 0.62 : 0), 0, 1);
    const footprintSignal = footprint?.absorption
      ? "absorption"
      : footprint?.stackedImbalance
        ? "stacked-imbalance"
        : footprint?.exhaustion
          ? "exhaustion"
          : "neutral";
    const footprintHeat = clamp(
      Math.abs(bias) * 0.5
        + liquidityScore * 0.34
        + (footprint?.stackedImbalance ? 0.16 : 0)
        + (footprint?.absorption ? 0.12 : 0)
        + mlAbsorptionScore * 0.18,
      0,
      1,
    );
    return {
      time: bar.time,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
      __visual: {
        ...(bar.__visual || {}),
        importance: clamp((bar.__visual?.importance ?? 1) + liquidityScore * 0.36 + Math.abs(bias) * 0.22 + mlAbsorptionScore * 0.12, 0.8, 1.95),
        bodyBoost: clamp((bar.__visual?.bodyBoost ?? 1) + (footprint?.stackedImbalance ? 0.22 : 0) + Math.abs(bias) * 0.06 + mlAbsorptionScore * 0.08, 1, 1.45),
        wickBoost: clamp((bar.__visual?.wickBoost ?? 0) + (footprint?.absorption ? 0.16 : 0) + (footprint?.exhaustion ? 0.1 : 0) + mlAbsorptionScore * 0.08, 0, 0.42),
        wickType: footprint?.absorption ? "absorption" : footprint?.exhaustion ? "rejection" : (bar.__visual?.wickType || "neutral"),
        lastCandleEmphasis: clamp((bar.__visual?.lastCandleEmphasis ?? 0) + footprintHeat * 0.22, 0, 0.42),
        footprintSignal,
        footprintBias: bias,
        footprintHeat,
        liquidityScore,
        absorptionScore: mlAbsorptionScore,
        timeframeHint: timeframe,
      },
    };
  });
}

function normalizeHeatmapLevels(levels: HeatmapLevelLike[] | undefined): HeatmapLevelLike[] {
  if (!Array.isArray(levels) || levels.length === 0) {
    return [];
  }

  return levels
    .filter((level) => Number.isFinite(level.price) && Number.isFinite(level.size) && level.size > 0)
    .map((level) => ({
      side: (level.side === "bid" ? "bid" : "ask") as HeatmapLevelLike["side"],
      price: Number(level.price),
      size: Math.max(0, Number(level.size)),
      intensity: Number.isFinite(level.intensity) ? Math.max(0, Number(level.intensity)) : Math.max(0, Number(level.size)),
    }))
    .sort((left, right) => {
      const leftScore = Math.max(left.intensity, left.size);
      const rightScore = Math.max(right.intensity, right.size);
      return rightScore - leftScore;
    })
    .slice(0, 50);
}

function normalizeDomHistory(history: DomHistoryFrame[] | undefined): DomHistoryFrame[] {
  if (!Array.isArray(history) || history.length === 0) {
    return [];
  }

  return history
    .filter((frame) => Number.isFinite(frame.time) && frame.time > 0 && Array.isArray(frame.levels) && frame.levels.length > 0)
    .map((frame) => ({
      time: Number(frame.time),
      spoofingRisk: Number.isFinite(frame.spoofingRisk) ? Math.max(0, Math.min(1, Number(frame.spoofingRisk))) : 0,
      levels: normalizeHeatmapLevels(frame.levels),
    }))
    .filter((frame) => frame.levels.length > 0)
    .slice(-64);
}

function normalizeTradeBubbles(bubbles: TradeBubblePoint[] | undefined): NormalizedTradeBubbleState {
  if (!Array.isArray(bubbles) || bubbles.length === 0) {
    return { bubbles: [], noiseRatio: 0 };
  }

  const normalized = bubbles
    .filter((bubble) => Number.isFinite(bubble.time) && bubble.time > 0 && Number.isFinite(bubble.price) && bubble.price > 0 && Number.isFinite(bubble.volume) && bubble.volume > 0)
    .map((bubble) => ({
      time: Number(bubble.time),
      price: Number(bubble.price),
      volume: Math.max(0, Number(bubble.volume)),
      side: (bubble.side === "sell" ? "sell" : "buy") as TradeBubblePoint["side"],
      intensity: Number.isFinite(bubble.intensity) ? Math.max(0, Math.min(1, Number(bubble.intensity))) : undefined,
      kind: (bubble.kind === "spoof" ? "spoof" : "trade") as TradeBubblePoint["kind"],
    }))
    .sort((left, right) => left.time - right.time)
    .slice(-320);

  const referenceTickSize = resolveTradeBubbleTickSize(normalized);
  const filtered = preFilterTicks(normalized.map((bubble, index, array) => ({
    ...bubble,
    deltaPrice: index > 0 ? bubble.price - array[index - 1].price : 0,
  })), {
    minPriceIncrement: referenceTickSize,
    minRelativeMoveRatio: 0.5,
    alternatingLookback: 3,
  });

  return {
    bubbles: filtered.filtered.map(({ deltaPrice: _deltaPrice, ...bubble }) => bubble),
    noiseRatio: filtered.telemetry.droppedRatio,
  };
}

function resolveTradeBubbleTickSize(bubbles: TradeBubblePoint[]): number {
  let minPositiveDelta = Number.POSITIVE_INFINITY;
  for (let index = 1; index < bubbles.length; index += 1) {
    const delta = Math.abs(bubbles[index].price - bubbles[index - 1].price);
    if (delta > 0 && delta < minPositiveDelta) {
      minPositiveDelta = delta;
    }
  }
  return Number.isFinite(minPositiveDelta) ? minPositiveDelta : 0;
}

function normalizePriceSignalBands(signals: PriceSignalBand[] | undefined): PriceSignalBand[] {
  if (!Array.isArray(signals) || signals.length === 0) {
    return [];
  }

  return signals
    .filter((signal) => Number.isFinite(signal.price) && signal.price > 0 && Number.isFinite(signal.strength))
    .map((signal) => ({
      price: Number(signal.price),
      strength: clamp(Number(signal.strength), 0.05, 1),
      kind: signal.kind,
      xStart: Number.isFinite(signal.xStart) ? clamp(Number(signal.xStart), -1, 1) : undefined,
      xEnd: Number.isFinite(signal.xEnd) ? clamp(Number(signal.xEnd), -1, 1) : undefined,
      thickness: Number.isFinite(signal.thickness) ? Math.max(0.0025, Math.min(0.045, Number(signal.thickness))) : undefined,
    }))
    .slice(0, 96);
}

function resolveMasterClockTime(primaryBars: OhlcBar[], feeds: Array<{ bars: OhlcBar[] }>): number | null {
  const candidates = [
    primaryBars[primaryBars.length - 1]?.time,
    ...feeds.map((feed) => feed.bars[feed.bars.length - 1]?.time),
  ].filter((value): value is number => Number.isFinite(value) && value > 0);
  if (candidates.length === 0) {
    return null;
  }
  return Math.min(...candidates);
}

function syncBarsToMasterClock(bars: OhlcBar[], masterTime: number | null): OhlcBar[] {
  if (!(masterTime && Number.isFinite(masterTime) && masterTime > 0) || bars.length <= 1) {
    return bars;
  }
  const synced = bars.filter((bar) => Number(bar.time) <= masterTime);
  return synced.length >= 2 ? synced : bars;
}

function normalizeBarsForComparison(bars: OhlcBar[]): OhlcBar[] {
  if (bars.length === 0) {
    return bars;
  }
  const base = bars.find((bar) => Number(bar.close) > 0)?.close ?? bars[0].close;
  if (!(base > 0) || !Number.isFinite(base)) {
    return bars;
  }
  return bars.map((bar) => ({
    ...bar,
    open: ((bar.open / base) - 1) * 100,
    high: ((bar.high / base) - 1) * 100,
    low: ((bar.low / base) - 1) * 100,
    close: ((bar.close / base) - 1) * 100,
  }));
}

function buildViewports(input: {
  width: number;
  height: number;
  grid: 1 | 4 | 16;
  primarySymbol: string;
  primaryBars: OhlcBar[];
  renderCandles: boolean;
  primaryHeatmapLevels: HeatmapLevelLike[];
  primaryDomHistory: DomHistoryFrame[];
  primaryTradeBubbles: TradeBubblePoint[];
  primaryPriceSignalBands: PriceSignalBand[];
  heatIntensity: number;
  heatmapDiscardThreshold: number;
  feeds: Array<{ id: string; symbol: string; bars: OhlcBar[] }>;
}) {
  const { width, height, grid, primarySymbol, primaryBars, renderCandles, primaryHeatmapLevels, primaryDomHistory, primaryTradeBubbles, primaryPriceSignalBands, heatIntensity, heatmapDiscardThreshold, feeds } = input;
  const cells = grid === 16 ? 4 : grid === 4 ? 2 : 1;
  const cellWidth = Math.max(1, Math.floor(width / cells));
  const cellHeight = Math.max(1, Math.floor(height / cells));

  const viewports: Array<{
    id: string;
    symbol?: string;
    x: number;
    y: number;
    width: number;
    height: number;
    candles: OhlcBar[];
    renderCandles?: boolean;
    overlayAlpha: number;
    overlayHeatIntensity: number;
    overlayDiscardThreshold: number;
    gridAlpha: number;
    gridVerticalLines: number;
    gridHorizontalLines: number;
    heatmapLevels?: HeatmapLevelLike[];
    domHistory?: DomHistoryFrame[];
    tradeBubbles?: TradeBubblePoint[];
    priceSignalBands?: PriceSignalBand[];
  }> = [];

  const overlayAlpha = grid === 16 ? 0.08 : grid === 4 ? 0.12 : 0.18;
  const overlayDiscardThreshold = clamp(heatmapDiscardThreshold, 0.01, 0.2);
  const overlayHeatIntensity = clamp(heatIntensity, 0.5, 3);
  const gridAlpha = grid === 16 ? 0.02 : grid === 4 ? 0.035 : 0.055;
  const gridVerticalLines = grid === 16 ? 4 : grid === 4 ? 6 : 8;
  const gridHorizontalLines = grid === 16 ? 3 : grid === 4 ? 5 : 6;

  for (let row = 0; row < cells; row += 1) {
    for (let col = 0; col < cells; col += 1) {
      const index = row * cells + col;
      const feed = feeds[index - 1];
      const bars = index === 0 ? primaryBars : (feed?.bars || primaryBars);
      const x = col * cellWidth;
      const yTop = row * cellHeight;
      const y = Math.max(0, height - yTop - cellHeight);
      const w = col === cells - 1 ? Math.max(1, width - x) : cellWidth;
      const h = row === cells - 1 ? Math.max(1, height - yTop) : cellHeight;

      viewports.push({
        id: index === 0 ? "primary" : (feed?.id || `feed-${index}`),
        symbol: index === 0 ? primarySymbol : (feed?.symbol || `feed-${index}`),
        x,
        y,
        width: w,
        height: h,
        candles: bars,
        renderCandles,
        overlayAlpha,
        overlayHeatIntensity,
        overlayDiscardThreshold,
        gridAlpha,
        gridVerticalLines,
        gridHorizontalLines,
        heatmapLevels: index === 0 ? primaryHeatmapLevels : undefined,
        domHistory: index === 0 ? primaryDomHistory : undefined,
        tradeBubbles: index === 0 ? primaryTradeBubbles : undefined,
        priceSignalBands: index === 0 ? primaryPriceSignalBands : undefined,
      });
    }
  }

  return viewports;
}
