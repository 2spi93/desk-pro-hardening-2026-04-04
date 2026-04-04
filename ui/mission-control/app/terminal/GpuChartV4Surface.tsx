"use client";

import { useEffect, useMemo, useRef, useState, type ComponentProps } from "react";

import InstitutionalChart from "./InstitutionalChart";
import type { DenseLegibilityMode, GpuPerceptualTelemetry } from "./chartPerceptual";
import { applyPerceptionPipeline, resolvePerceptionDensity } from "./perceptionEngine";
import { createLatestFrameScheduler } from "./frameEngine";
import { applyVisualProfile, DEFAULT_VISUAL_PROFILE, type VisualProfileName } from "./visualProfiles";
import { createGpuContext, resizeGpuCanvas } from "../../lib/engine/gpu-chart/context";
import { MultiChartManager } from "../../lib/engine/gpu-chart/MultiChartManager";
import type { OhlcBar } from "../../lib/engine/gpu-chart/sharedBuffer";
import { subscribeChartFrame } from "../../lib/chartFrameFeed";

type InstitutionalChartProps = Omit<ComponentProps<typeof InstitutionalChart>, "onPerceptualTelemetry">;

type CandleLike = {
  label: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
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
  onPerceptualTelemetry?: (payload: GpuPerceptualTelemetry) => void;
};

type GpuMetrics = {
  fps: number;
  drawCalls: number;
  batchSize: number;
  renderer: string | null;
  overlayIntervalMs: number;
};

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

export default function GpuChartV4Surface({
  engineMode = "v4",
  viewportGrid = "auto",
  multiSymbolFeeds = [],
  smoothingMs = 140,
  onPerceptualTelemetry,
  className,
  liveFeedKey,
  timeframe,
  visualProfile = DEFAULT_VISUAL_PROFILE,
  candles,
  ...rest
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const initCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const managerRef = useRef<MultiChartManager | null>(null);
  const barsRef = useRef<OhlcBar[]>([]);
  const propCandlesRef = useRef(candles);
  const feedBarsRef = useRef<Array<{ id: string; symbol: string; bars: OhlcBar[] }>>([]);
  const timeframeRef = useRef(timeframe);
  const visualProfileRef = useRef(visualProfile);
  const subscribedLiveFeedKeyRef = useRef<string | null>(null);
  const visualProfileConfig = useMemo(() => applyVisualProfile(visualProfile), [visualProfile]);
  const liveFrameSchedulerRef = useRef(createLatestFrameScheduler<CandleLike[]>({
    minFrameMs: visualProfileConfig.frame.minFrameMs,
    strictBucketAlignment: visualProfileConfig.perception.strictBucketAlignment,
  }));
  const targetGridRef = useRef<1 | 4 | 16>(1);
  const diagnosticsLoggedRef = useRef(false);
  const fpsSamplesRef = useRef<number[]>([]);
  const liveMetricsRef = useRef<GpuMetrics>({ fps: 0, drawCalls: 0, batchSize: 0, renderer: null, overlayIntervalMs: 250 });

  // ── Input Engine: camera state (bar-index window), inertia, drag ──────────
  const cameraRef = useRef<{ from: number; to: number } | null>(null);
  const panVelocityRef = useRef(0);
  const rightDragActiveRef = useRef(false);
  const rightDragLastXRef = useRef(0);
  const wheelCursorFracRef = useRef(0.5);
  const suppressContextMenuUntilRef = useRef(0);

  const [gpuReady, setGpuReady] = useState(false);
  const [gpuReason, setGpuReason] = useState<"ok" | "unsupported" | "context-lost">("unsupported");
  const [initPhase, setInitPhase] = useState<"canvas-init" | "webgl-live" | "fallback">("canvas-init");
  const [gpuMetrics, setGpuMetrics] = useState<GpuMetrics>({ fps: 0, drawCalls: 0, batchSize: 0, renderer: null, overlayIntervalMs: 250 });
  const [gpuRecoveryEpoch, setGpuRecoveryEpoch] = useState(0);

  const gpuBars = useMemo(() => toGpuBars(candles, timeframe, visualProfile), [candles, timeframe, visualProfile]);

  const feedBars = useMemo(() => {
    return multiSymbolFeeds
      .filter((feed) => Array.isArray(feed.candles) && feed.candles.length > 1)
      .map((feed) => ({
        id: feed.id,
        symbol: feed.symbol,
        bars: toGpuBars(feed.candles, timeframe, visualProfile),
      }))
      .filter((feed) => feed.bars.length > 1);
  }, [multiSymbolFeeds, timeframe, visualProfile]);

  useEffect(() => {
    liveFrameSchedulerRef.current.configure({
      minFrameMs: visualProfileConfig.frame.minFrameMs,
      strictBucketAlignment: visualProfileConfig.perception.strictBucketAlignment,
    });
  }, [visualProfileConfig]);

  const targetGrid = useMemo<1 | 4 | 16>(() => {
    if (viewportGrid === 1 || viewportGrid === 4 || viewportGrid === 16) {
      return viewportGrid;
    }
    if (feedBars.length >= 15) {
      return 16;
    }
    if (feedBars.length >= 3) {
      return 4;
    }
    return 1;
  }, [feedBars.length, viewportGrid]);

  useEffect(() => {
    barsRef.current = gpuBars;
  }, [gpuBars]);

  useEffect(() => {
    propCandlesRef.current = candles;
  }, [candles]);

  useEffect(() => {
    timeframeRef.current = timeframe;
    visualProfileRef.current = visualProfile;
  }, [timeframe, visualProfile]);

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
      if (!isLiveFrameCompatibleWithProps(frame.candles, propCandlesRef.current, timeframeRef.current)) {
        return;
      }
      liveFrameSchedulerRef.current.schedule(frame.candles, (nextCandles) => {
        barsRef.current = toGpuBars(nextCandles, timeframeRef.current, visualProfileRef.current);
      });
    });

    return () => {
      if (subscribedLiveFeedKeyRef.current === liveFeedKey) {
        subscribedLiveFeedKeyRef.current = null;
      }
      unsubscribe();
      liveFrameSchedulerRef.current.cancel();
    };
  }, [liveFeedKey]);

  useEffect(() => {
    feedBarsRef.current = feedBars;
  }, [feedBars]);

  useEffect(() => {
    targetGridRef.current = targetGrid;
  }, [targetGrid]);

  useEffect(() => {
    const manager = managerRef.current;
    if (!manager) {
      return;
    }
    manager.setLastBarSmoothingMs(Number.isFinite(smoothingMs) ? Math.max(0, smoothingMs) : 140);
  }, [smoothingMs]);

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
      let minP = Infinity;
      let maxP = -Infinity;
      for (const b of bars) {
        if (b.low < minP) minP = b.low;
        if (b.high > maxP) maxP = b.high;
      }
      const priceRange = Math.max(1e-6, maxP - minP);
      const bw = Math.max(1, Math.floor(w / bars.length) - 1);
      for (let i = 0; i < bars.length; i++) {
        const b = bars[i];
        const bx = Math.floor((i / bars.length) * w);
        const openY = h - ((b.open - minP) / priceRange) * h;
        const closeY = h - ((b.close - minP) / priceRange) * h;
        const highY = h - ((b.high - minP) / priceRange) * h;
        const lowY = h - ((b.low - minP) / priceRange) * h;
        const isUp = b.close >= b.open;

        ctx.strokeStyle = isUp ? "rgba(0,230,128,0.4)" : "rgba(255,80,80,0.4)";
        ctx.fillStyle = isUp ? "rgba(0,230,128,0.25)" : "rgba(255,80,80,0.25)";
        ctx.lineWidth = 1;

        ctx.beginPath();
        ctx.moveTo(bx + bw / 2, highY);
        ctx.lineTo(bx + bw / 2, lowY);
        ctx.stroke();

        const bodyTop = Math.min(openY, closeY);
        const bodyH = Math.max(1, Math.abs(closeY - openY));
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
      manager.setLastBarSmoothingMs(Number.isFinite(smoothingMs) ? Math.max(0, smoothingMs) : 140);
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
        const allBars = barsRef.current;
        if (cameraRef.current === null && allBars.length > 0) {
          const defaultVisible = Math.min(allBars.length, 80);
          cameraRef.current = { from: allBars.length - defaultVisible, to: allBars.length };
        }
        // Track live edge: if camera was pinned to the right edge, advance it
        if (cameraRef.current !== null && allBars.length > 0) {
          const cam = cameraRef.current;
          const span = cam.to - cam.from;
          // "pinned to edge" = to was within 2 bars of previous total
          if (cam.to >= allBars.length - 2) {
            cameraRef.current = { from: Math.max(0, allBars.length - span), to: allBars.length };
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
        manager.setViewports(
          buildViewports({
            width,
            height,
            grid: targetGridRef.current,
            primaryBars,
            feeds: feedBarsRef.current,
          }),
        );
        manager.render(frameTs);

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
        setGpuMetrics(nextMetrics);

        if (!onPerceptualTelemetry) {
          return;
        }

        const canvasWidth = host.clientWidth || canvas.clientWidth || 0;
        const canvasHeight = host.clientHeight || canvas.clientHeight || 0;
        const pixelRatio = canvasWidth > 0 ? canvas.width / canvasWidth : Math.max(1, window.devicePixelRatio || 1);
        const visibleBars = Math.max(0, Math.round(cameraRef.current ? (cameraRef.current.to - cameraRef.current.from) : barsRef.current.length));
        const candleStepPx = visibleBars > 0 && canvasWidth > 0 ? canvasWidth / visibleBars : 0;
        const spacing = resolveGpuSpacingTelemetry(candleStepPx, visibleBars);

        onPerceptualTelemetry({
          engine: "v4",
          symbol: rest.symbol,
          timeframe,
          mode: rest.mode,
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
          spacing,
          performance: {
            fps: nextMetrics.fps,
            drawCalls: nextMetrics.drawCalls,
            batchSize: nextMetrics.batchSize,
            overlayIntervalMs: nextMetrics.overlayIntervalMs,
            smoothingMs,
          },
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
  }, [gpuRecoveryEpoch, onPerceptualTelemetry, rest.mode, rest.symbol, smoothingMs, timeframe]);

  // ── Input Engine: wheel zoom + right-drag pan + inertia ──────────────────
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

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

      // Vertical wheel / trackpad pinch → zoom centred on cursor
      if (shouldZoom) {
        const span = cam.to - cam.from;
        const allLen = barsRef.current.length;
        const zoomFactor = Math.exp(-e.deltaY * 0.0012);
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
      if (e.button !== 2) return;
      e.preventDefault();
      rightDragActiveRef.current = true;
      rightDragLastXRef.current = e.clientX;
      suppressContextMenuUntilRef.current = Date.now() + 400;
      host.classList.add("chart-time-pan-active");
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!rightDragActiveRef.current) return;
      e.preventDefault();
      const cam = cameraRef.current;
      if (!cam) return;
      const rect = host.getBoundingClientRect();
      const deltaX = e.clientX - rightDragLastXRef.current;
      rightDragLastXRef.current = e.clientX;
      if (Math.abs(deltaX) < 0.25) return;
      e.preventDefault();
      suppressContextMenuUntilRef.current = Date.now() + 400;
      const barsPerPixel = (cam.to - cam.from) / Math.max(1, rect.width);
      const deltaBars = -deltaX * barsPerPixel;
      // Seed inertia with a fraction of this frame's velocity
      panVelocityRef.current = deltaBars * 0.15;
      applyPan(deltaBars);
    };

    const stopDrag = () => {
      if (!rightDragActiveRef.current) return;
      rightDragActiveRef.current = false;
      host.classList.remove("chart-time-pan-active");
    };

    const onMouseUp = (e: MouseEvent) => {
      if (e.button === 2 || rightDragActiveRef.current) {
        suppressContextMenuUntilRef.current = Date.now() + 400;
        stopDrag();
      }
    };

    const onContextMenu = (e: MouseEvent) => {
      if (rightDragActiveRef.current || Date.now() < suppressContextMenuUntilRef.current) e.preventDefault();
    };

    host.addEventListener("wheel", onWheel, { passive: false });
    host.addEventListener("mousedown", onMouseDown);
    host.addEventListener("contextmenu", onContextMenu);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("contextmenu", onContextMenu);
    window.addEventListener("blur", stopDrag);

    return () => {
      host.removeEventListener("wheel", onWheel);
      host.removeEventListener("mousedown", onMouseDown);
      host.removeEventListener("contextmenu", onContextMenu);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("contextmenu", onContextMenu);
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
      {/* Status badge */}
      <div className={`gpu-chart-v4-status ${gpuReady ? "ready" : "fallback"}`}>
        <span className="gpu-chart-v4-kicker">Engine {engineMode.toUpperCase()}</span>
        <span>
          {gpuReady
            ? `GPU renderer live \u2022 ${targetGrid === 16 ? "4x4" : targetGrid === 4 ? "2x2" : "1x1"} \u2022 feeds ${Math.max(1, feedBars.length + 1)}`
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
      <div className="chart-timezone-pill" aria-hidden="true">UTC | RMB drag pan</div>
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

function resolveGpuSpacingTelemetry(candleStepPx: number, visibleBars: number): GpuPerceptualTelemetry["spacing"] {
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
    targetVisibleBars: Math.max(visibleBars, 0),
  };
}

function toGpuBars(candles: CandleLike[], timeframe: string, visualProfile: VisualProfileName): OhlcBar[] {
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
  return applyPerceptionPipeline(rawBars, { density, timeframe, volatility: 0, visualProfile }).map((bar) => ({
    time: bar.time,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
  }));
}

function buildViewports(input: {
  width: number;
  height: number;
  grid: 1 | 4 | 16;
  primaryBars: OhlcBar[];
  feeds: Array<{ id: string; symbol: string; bars: OhlcBar[] }>;
}) {
  const { width, height, grid, primaryBars, feeds } = input;
  const cells = grid === 16 ? 4 : grid === 4 ? 2 : 1;
  const cellWidth = Math.max(1, Math.floor(width / cells));
  const cellHeight = Math.max(1, Math.floor(height / cells));

  const viewports: Array<{
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    candles: OhlcBar[];
    overlayAlpha: number;
    overlayDiscardThreshold: number;
    gridAlpha: number;
    gridVerticalLines: number;
    gridHorizontalLines: number;
  }> = [];

  const overlayAlpha = grid === 16 ? 0.08 : grid === 4 ? 0.12 : 0.18;
  const overlayDiscardThreshold = grid === 16 ? 0.03 : grid === 4 ? 0.024 : 0.018;
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
        x,
        y,
        width: w,
        height: h,
        candles: bars,
        overlayAlpha,
        overlayDiscardThreshold,
        gridAlpha,
        gridVerticalLines,
        gridHorizontalLines,
      });
    }
  }

  return viewports;
}
