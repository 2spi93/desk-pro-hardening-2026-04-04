import { CandleLayer } from "./CandleLayer";
import { GridLayer } from "./GridLayer";
import { OverlayLayer } from "./OverlayLayer";
import type { OhlcBar } from "./sharedBuffer";

export type ChartViewport = {
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
};

export class MultiChartManager {
  private gl: WebGL2RenderingContext;
  private candleLayer: CandleLayer;
  private gridLayer: GridLayer;
  private overlayLayer: OverlayLayer;
  private viewports: ChartViewport[] = [];
  private _drawCallCount = 0;
  private _lastBatchSize = 0;
  private previousFrameMs: number | null = null;
  private frameBudgetMs = 16.7;
  private skipOverlayForFrame = false;
  private overlayIntervalMs = 250;
  private overlayLastDrawMs = new Map<string, number>();
  private uploadCursor = 0;
  private lastBarSmoothingMs = 140;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.candleLayer = new CandleLayer(gl);
    this.gridLayer = new GridLayer(gl);
    this.overlayLayer = new OverlayLayer(gl);
  }

  dispose(): void {
    this.candleLayer.dispose();
    this.gridLayer.dispose();
    this.overlayLayer.dispose();
  }

  setViewports(viewports: ChartViewport[]): void {
    this.viewports = viewports;
  }

  render(frameTimeMs: number): void {
    const gl = this.gl;
    this._drawCallCount = 0;
    this._lastBatchSize = 0;
    if (this.previousFrameMs === null) {
      this.previousFrameMs = frameTimeMs;
    }
    const frameDelta = Math.max(0, frameTimeMs - this.previousFrameMs);
    this.previousFrameMs = frameTimeMs;
    this.skipOverlayForFrame = frameDelta > this.frameBudgetMs;

    // Evict GPU buffers for viewports no longer in this frame
    const activeIds = new Set(this.viewports.map((v) => v.id));
    this.candleLayer.evictUnusedViewports(activeIds);

    gl.enable(gl.SCISSOR_TEST);

    gl.clearColor(0.02, 0.05, 0.09, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const uploadBudget = this.viewports.length >= 16 ? 4 : this.viewports.length;
    const uploadSet = this.resolveUploadSet(uploadBudget);

    for (const viewport of this.viewports) {
      if (viewport.width <= 0 || viewport.height <= 0) {
        continue;
      }

      for (const id of this.overlayLastDrawMs.keys()) {
        if (!activeIds.has(id)) this.overlayLastDrawMs.delete(id);
      }

      gl.scissor(viewport.x, viewport.y, viewport.width, viewport.height);

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      this.gridLayer.draw({
        alpha: viewport.gridAlpha,
        verticalLines: viewport.gridVerticalLines,
        horizontalLines: viewport.gridHorizontalLines,
      });
      this._drawCallCount += 1;

      gl.disable(gl.BLEND);
      this.candleLayer.draw(viewport.id, viewport.candles, {
        allowUpload: uploadSet.has(viewport.id),
        frameTimeMs,
        smoothingMs: this.lastBarSmoothingMs,
        canvasWidth: gl.canvas.width,
        canvasHeight: gl.canvas.height,
      });
      this._drawCallCount += 1;
      if (viewport.candles.length > this._lastBatchSize) {
        this._lastBatchSize = viewport.candles.length;
      }

      // Stagger: initialise first-draw time for each viewport so they are
      // spread evenly across the overlay interval rather than all firing at
      // the same frame (which would burst DC to viewports×3 at once).
      if (!this.skipOverlayForFrame) {
        const viewportIndex = this.viewports.indexOf(viewport);
        const staggerOffset = this.overlayIntervalMs * (viewportIndex / Math.max(1, this.viewports.length));
        const defaultLastMs = frameTimeMs - staggerOffset;
        const lastOverlayMs = this.overlayLastDrawMs.has(viewport.id)
          ? this.overlayLastDrawMs.get(viewport.id)!
          : defaultLastMs;
        if (frameTimeMs - lastOverlayMs >= this.overlayIntervalMs) {
          const last = viewport.candles[viewport.candles.length - 1];
          const focusY = resolveFocusY(viewport.candles, last?.close ?? 0);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          this.overlayLayer.draw(
            frameTimeMs,
            viewport.overlayAlpha,
            focusY,
            viewport.overlayDiscardThreshold,
          );
          this._drawCallCount += 1;
          this.overlayLastDrawMs.set(viewport.id, frameTimeMs);
        }
      }
    }

    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
  }

  getMetrics(): { drawCalls: number; batchSize: number; overlayIntervalMs: number } {
    const viewports = this.viewports.length;
    const adaptiveOverlayInterval = viewports >= 16
      ? 420
      : viewports >= 4
        ? 320
        : 250;
    if (this.overlayIntervalMs !== adaptiveOverlayInterval) {
      this.overlayIntervalMs = adaptiveOverlayInterval;
    }
    return { drawCalls: this._drawCallCount, batchSize: this._lastBatchSize, overlayIntervalMs: this.overlayIntervalMs };
  }

  setFrameBudgetMs(value: number): void {
    if (Number.isFinite(value) && value > 0) {
      this.frameBudgetMs = value;
    }
  }

  setLastBarSmoothingMs(value: number): void {
    if (!Number.isFinite(value) || value < 0) {
      return;
    }
    this.lastBarSmoothingMs = value;
  }

  private resolveUploadSet(limit: number): Set<string> {
    const count = this.viewports.length;
    if (count === 0 || limit <= 0) {
      return new Set();
    }
    if (limit >= count) {
      return new Set(this.viewports.map((viewport) => viewport.id));
    }

    const selected = new Set<string>();
    const primary = this.viewports.find((viewport) => viewport.id === "primary");
    if (primary) {
      selected.add(primary.id);
    }

    const slots = Math.max(0, limit - selected.size);
    if (slots === 0) {
      return selected;
    }

    let scanned = 0;
    let picked = 0;
    while (scanned < count && picked < slots) {
      const viewport = this.viewports[(this.uploadCursor + scanned) % count];
      scanned += 1;
      if (!viewport || selected.has(viewport.id)) {
        continue;
      }
      selected.add(viewport.id);
      picked += 1;
    }

    this.uploadCursor = (this.uploadCursor + Math.max(1, slots)) % Math.max(1, count);
    return selected;
  }
}

function resolveFocusY(candles: OhlcBar[], lastClose: number): number {
  if (candles.length === 0) {
    return 0.5;
  }

  let minPrice = Number.POSITIVE_INFINITY;
  let maxPrice = Number.NEGATIVE_INFINITY;
  for (const candle of candles) {
    minPrice = Math.min(minPrice, candle.low, candle.open, candle.close);
    maxPrice = Math.max(maxPrice, candle.high, candle.open, candle.close);
  }

  if (!Number.isFinite(minPrice) || !Number.isFinite(maxPrice) || minPrice === maxPrice) {
    return 0.5;
  }

  return Math.min(1, Math.max(0, (lastClose - minPrice) / Math.max(1e-6, maxPrice - minPrice)));
}
