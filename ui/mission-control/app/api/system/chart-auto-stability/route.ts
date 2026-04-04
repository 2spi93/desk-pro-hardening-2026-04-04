import { NextResponse } from "next/server";

import {
  getChartAutoStabilitySnapshots,
  type ChartAutoStabilitySnapshot,
  upsertChartAutoStabilitySnapshot,
} from "../../../../lib/chartAutoStabilityDebug";

function isInstrumentClass(value: unknown): value is ChartAutoStabilitySnapshot["instrumentClass"] {
  return value === "btc" || value === "eth" || value === "index" || value === "default";
}

function isMotionPreset(value: unknown): value is ChartAutoStabilitySnapshot["resolvedMotionPreset"] {
  return value === "scalping" || value === "swing";
}

function sanitizeSnapshot(payload: unknown): ChartAutoStabilitySnapshot | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const candidate = payload as Record<string, unknown>;
  if (
    typeof candidate.key !== "string"
    || typeof candidate.symbol !== "string"
    || typeof candidate.timeframe !== "string"
    || !isInstrumentClass(candidate.instrumentClass)
    || !isMotionPreset(candidate.resolvedMotionPreset)
    || typeof candidate.switches5m !== "number"
    || typeof candidate.switches1h !== "number"
    || typeof candidate.updatedAt !== "string"
  ) {
    return null;
  }

  const targetBand = candidate.targetBand;
  const perfThresholds = candidate.perfThresholds;
  const perfRuntime = candidate.perfRuntime;
  const sparklineBuckets = Array.isArray(candidate.sparklineBuckets)
    ? candidate.sparklineBuckets.map((value) => Number(value)).filter((value) => Number.isFinite(value)).slice(0, 24)
    : [];

  if (
    !targetBand
    || typeof targetBand !== "object"
    || !Number.isFinite(Number((targetBand as Record<string, unknown>).okFloorSec))
    || !Number.isFinite(Number((targetBand as Record<string, unknown>).warnFloorSec))
    || !Number.isFinite(Number((targetBand as Record<string, unknown>).targetSec))
  ) {
    return null;
  }

  if (
    !perfThresholds
    || typeof perfThresholds !== "object"
    || !Number.isFinite(Number((perfThresholds as Record<string, unknown>).busyFrameMs))
    || !Number.isFinite(Number((perfThresholds as Record<string, unknown>).busyMinFps))
    || !Number.isFinite(Number((perfThresholds as Record<string, unknown>).busyCpuLoad))
    || !Number.isFinite(Number((perfThresholds as Record<string, unknown>).criticalFrameMs))
    || !Number.isFinite(Number((perfThresholds as Record<string, unknown>).criticalMinFps))
    || !Number.isFinite(Number((perfThresholds as Record<string, unknown>).criticalCpuLoad))
    || !Number.isFinite(Number((perfThresholds as Record<string, unknown>).domLevelsBusy))
    || !Number.isFinite(Number((perfThresholds as Record<string, unknown>).domLevelsNormal))
    || !Number.isFinite(Number((perfThresholds as Record<string, unknown>).heatmapBandsBusy))
    || !Number.isFinite(Number((perfThresholds as Record<string, unknown>).heatmapBandsNormal))
  ) {
    return null;
  }

  if (
    !perfRuntime
    || typeof perfRuntime !== "object"
    || !Number.isFinite(Number((perfRuntime as Record<string, unknown>).fps))
    || !Number.isFinite(Number((perfRuntime as Record<string, unknown>).frameTimeMs))
    || !Number.isFinite(Number((perfRuntime as Record<string, unknown>).cpuLoad))
    || !Number.isFinite(Number((perfRuntime as Record<string, unknown>).budgetUsedPct))
    || !(["micro", "compact", "normal", "expanded"] as const).includes(String((perfRuntime as Record<string, unknown>).lodLevel) as any)
    || !Number.isFinite(Number((perfRuntime as Record<string, unknown>).overlayCount))
    || !Number.isFinite(Number((perfRuntime as Record<string, unknown>).activeIndicatorCount))
    || !(perfRuntime as Record<string, unknown>).updateCounts
    || typeof (perfRuntime as Record<string, unknown>).updateCounts !== "object"
    || !Number.isFinite(Number(((perfRuntime as Record<string, unknown>).updateCounts as Record<string, unknown>).candle))
    || !Number.isFinite(Number(((perfRuntime as Record<string, unknown>).updateCounts as Record<string, unknown>).indicator))
    || !Number.isFinite(Number(((perfRuntime as Record<string, unknown>).updateCounts as Record<string, unknown>).overlay))
  ) {
    return null;
  }

  return {
    key: candidate.key,
    symbol: candidate.symbol,
    timeframe: candidate.timeframe,
    instrumentClass: candidate.instrumentClass,
    resolvedMotionPreset: candidate.resolvedMotionPreset,
    switches5m: Number(candidate.switches5m),
    switches1h: Number(candidate.switches1h),
    avgIntervalSec: candidate.avgIntervalSec == null ? null : Number(candidate.avgIntervalSec),
    lastSwitchAgoSec: candidate.lastSwitchAgoSec == null ? null : Number(candidate.lastSwitchAgoSec),
    targetBand: {
      okFloorSec: Number((targetBand as Record<string, unknown>).okFloorSec),
      warnFloorSec: Number((targetBand as Record<string, unknown>).warnFloorSec),
      targetSec: Number((targetBand as Record<string, unknown>).targetSec),
    },
    perfThresholds: {
      busyFrameMs: Number((perfThresholds as Record<string, unknown>).busyFrameMs),
      busyMinFps: Number((perfThresholds as Record<string, unknown>).busyMinFps),
      busyCpuLoad: Number((perfThresholds as Record<string, unknown>).busyCpuLoad),
      criticalFrameMs: Number((perfThresholds as Record<string, unknown>).criticalFrameMs),
      criticalMinFps: Number((perfThresholds as Record<string, unknown>).criticalMinFps),
      criticalCpuLoad: Number((perfThresholds as Record<string, unknown>).criticalCpuLoad),
      domLevelsBusy: Number((perfThresholds as Record<string, unknown>).domLevelsBusy),
      domLevelsNormal: Number((perfThresholds as Record<string, unknown>).domLevelsNormal),
      heatmapBandsBusy: Number((perfThresholds as Record<string, unknown>).heatmapBandsBusy),
      heatmapBandsNormal: Number((perfThresholds as Record<string, unknown>).heatmapBandsNormal),
    },
    perfRuntime: {
      fps: Number((perfRuntime as Record<string, unknown>).fps),
      frameTimeMs: Number((perfRuntime as Record<string, unknown>).frameTimeMs),
      cpuLoad: Number((perfRuntime as Record<string, unknown>).cpuLoad),
      budgetUsedPct: Number((perfRuntime as Record<string, unknown>).budgetUsedPct),
      lodLevel: String((perfRuntime as Record<string, unknown>).lodLevel) as "micro" | "compact" | "normal" | "expanded",
      overlayCount: Number((perfRuntime as Record<string, unknown>).overlayCount),
      activeIndicatorCount: Number((perfRuntime as Record<string, unknown>).activeIndicatorCount),
      updateCounts: {
        candle: Number(((perfRuntime as Record<string, unknown>).updateCounts as Record<string, unknown>).candle),
        indicator: Number(((perfRuntime as Record<string, unknown>).updateCounts as Record<string, unknown>).indicator),
        overlay: Number(((perfRuntime as Record<string, unknown>).updateCounts as Record<string, unknown>).overlay),
      },
      workerLatencyMs: (perfRuntime as Record<string, unknown>).workerLatencyMs == null
        ? null
        : Number((perfRuntime as Record<string, unknown>).workerLatencyMs),
    },
    sparklineBuckets,
    updatedAt: candidate.updatedAt,
  };
}

export async function GET() {
  return NextResponse.json(
    {
      status: "ok",
      count: getChartAutoStabilitySnapshots().length,
      snapshots: getChartAutoStabilitySnapshots(),
      timestamp: new Date().toISOString(),
    },
    {
      status: 200,
      headers: {
        "Cache-Control": "no-cache, no-store, must-revalidate",
      },
    },
  );
}

export async function POST(request: Request) {
  const payload = sanitizeSnapshot(await request.json().catch(() => null));
  if (!payload) {
    return NextResponse.json({ status: "error", message: "invalid payload" }, { status: 400 });
  }

  upsertChartAutoStabilitySnapshot(payload);
  return NextResponse.json({ status: "ok", key: payload.key, timestamp: payload.updatedAt }, { status: 200 });
}