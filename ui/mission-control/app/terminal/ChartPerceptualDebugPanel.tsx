import type { ChartPerceptualTelemetry, GpuPerceptualTelemetry } from "./chartPerceptual";

type Props = {
  open: boolean;
  telemetry: ChartPerceptualTelemetry | null;
  gpuTelemetry: GpuPerceptualTelemetry | null;
  engineMode: "v3" | "v4";
};

function formatNumber(value: number | null, digits = 1): string {
  if (value === null || !Number.isFinite(value)) {
    return "--";
  }
  return value.toFixed(digits);
}

export default function ChartPerceptualDebugPanel({ open, telemetry, gpuTelemetry, engineMode }: Props) {
  if (!open) {
    return null;
  }

  if (engineMode === "v4") {
    if (!gpuTelemetry) {
      return (
        <aside className="chart-perceptual-panel" aria-label="Perceptual chart debug panel">
          <div className="chart-perceptual-head">
            <strong>Perceptual Debug</strong>
            <span className="chart-perceptual-chip tone-neutral">WAIT</span>
          </div>
          <p className="chart-perceptual-empty">Collecte des métriques perceptives V4 en cours.</p>
        </aside>
      );
    }

    const perfTone = gpuTelemetry.performance.fps >= 30
      ? "tone-good"
      : gpuTelemetry.performance.fps >= 18
        ? "tone-warn"
        : "tone-bad";
    const spacingTone = gpuTelemetry.spacing.denseMode === "micro"
      ? "tone-warn"
      : gpuTelemetry.spacing.pixelSnapping
        ? "tone-good"
        : "tone-neutral";

    return (
      <aside className="chart-perceptual-panel" aria-label="Perceptual chart debug panel">
        <div className="chart-perceptual-head">
          <strong>Perceptual Debug</strong>
          <span className={`chart-perceptual-chip ${spacingTone}`}>V4 {gpuTelemetry.grid.label}</span>
          <span className={`chart-perceptual-chip ${perfTone}`}>{gpuTelemetry.spacing.denseMode}</span>
        </div>

        <div className="chart-perceptual-grid">
          <div className="chart-perceptual-row">
            <span>Spacing</span>
            <strong>{formatNumber(gpuTelemetry.candleStepPx)}px obs</strong>
            <em>{gpuTelemetry.spacing.pixelSnapping ? "snap on" : "snap off"}</em>
          </div>
          <div className="chart-perceptual-row">
            <span>Body / wick</span>
            <strong>{formatNumber(gpuTelemetry.spacing.preferredBodyWidthPx)}px</strong>
            <em>{formatNumber(gpuTelemetry.spacing.wickWidthPx)}px wick</em>
          </div>
          <div className="chart-perceptual-row">
            <span>Gap / bars</span>
            <strong>{formatNumber(gpuTelemetry.spacing.minGapPx)}px</strong>
            <em>{gpuTelemetry.visibleBars} visible</em>
          </div>
          <div className="chart-perceptual-row">
            <span>Renderer</span>
            <strong>{gpuTelemetry.renderer ? gpuTelemetry.renderer.split(/\s+/).slice(0, 3).join(" ") : "--"}</strong>
            <em>{formatNumber(gpuTelemetry.pixelRatio, 2)}x DPR</em>
          </div>
          <div className="chart-perceptual-row">
            <span>Perf</span>
            <strong>{gpuTelemetry.performance.fps.toFixed(0)} fps</strong>
            <em>DC {gpuTelemetry.performance.drawCalls} · batch {gpuTelemetry.performance.batchSize}</em>
          </div>
          <div className="chart-perceptual-row">
            <span>Overlay / smooth</span>
            <strong>{gpuTelemetry.performance.overlayIntervalMs}ms</strong>
            <em>{gpuTelemetry.performance.smoothingMs}ms smooth</em>
          </div>
        </div>
      </aside>
    );
  }

  if (!telemetry) {
    return (
      <aside className="chart-perceptual-panel" aria-label="Perceptual chart debug panel">
        <div className="chart-perceptual-head">
          <strong>Perceptual Debug</strong>
          <span className="chart-perceptual-chip tone-neutral">WAIT</span>
        </div>
        <p className="chart-perceptual-empty">Collecte des métriques perceptives en cours.</p>
      </aside>
    );
  }

  const autoscaleTone = telemetry.autoscale.hardReframes > 0
    ? "tone-warn"
    : telemetry.autoscale.hysteresisLocked
      ? "tone-good"
      : "tone-neutral";
  const perfTone = telemetry.performance.frameTimeMs <= 16.7 && telemetry.performance.fps >= 55
    ? "tone-good"
    : telemetry.performance.frameTimeMs <= 22
      ? "tone-warn"
      : "tone-bad";

  return (
    <aside className="chart-perceptual-panel" aria-label="Perceptual chart debug panel">
      <div className="chart-perceptual-head">
        <strong>Perceptual Debug</strong>
        <span className={`chart-perceptual-chip ${autoscaleTone}`}>{telemetry.spacing.profile}</span>
        <span className={`chart-perceptual-chip ${perfTone}`}>{telemetry.densityLevel}</span>
      </div>

      <div className="chart-perceptual-grid">
        <div className="chart-perceptual-row">
          <span>Spacing</span>
          <strong>{formatNumber(telemetry.candleStepPx)}px obs</strong>
          <em>{formatNumber(telemetry.spacing.barSpacing)}px cible</em>
        </div>
        <div className="chart-perceptual-row">
          <span>Body / gap</span>
          <strong>{formatNumber(telemetry.spacing.preferredBodyWidthPx)}px</strong>
          <em>{formatNumber(telemetry.spacing.minGapPx)}px</em>
        </div>
        <div className="chart-perceptual-row">
          <span>Visible bars</span>
          <strong>{telemetry.visibleBars}</strong>
          <em>target {telemetry.spacing.targetVisibleBars}</em>
        </div>
        <div className="chart-perceptual-row">
          <span>Autoscale</span>
          <strong>{telemetry.autoscale.transitionMode}</strong>
          <em>{telemetry.autoscale.hysteresisLocked ? "hold" : "free"}</em>
        </div>
        <div className="chart-perceptual-row chart-perceptual-row-range">
          <span>Range</span>
          <strong>{formatNumber(telemetry.autoscale.min, 2)} → {formatNumber(telemetry.autoscale.max, 2)}</strong>
          <em>raw {formatNumber(telemetry.autoscale.rawMin, 2)} → {formatNumber(telemetry.autoscale.rawMax, 2)}</em>
        </div>
        <div className="chart-perceptual-row">
          <span>Padding H/B</span>
          <strong>{formatNumber(telemetry.autoscale.topPadding, 2)}</strong>
          <em>{formatNumber(telemetry.autoscale.bottomPadding, 2)}</em>
        </div>
        <div className="chart-perceptual-row">
          <span>Reframes</span>
          <strong>{telemetry.autoscale.reframeCount}</strong>
          <em>soft {telemetry.autoscale.softReframes} hard {telemetry.autoscale.hardReframes}</em>
        </div>
        <div className="chart-perceptual-row">
          <span>Shift / drift</span>
          <strong>{(telemetry.autoscale.shiftPct * 100).toFixed(1)}%</strong>
          <em>{formatNumber(telemetry.stability.lastPriceDriftPx)}px / peak {formatNumber(telemetry.stability.peakPriceDriftPx)}px</em>
        </div>
        <div className="chart-perceptual-row">
          <span>Perf</span>
          <strong>{telemetry.performance.fps.toFixed(0)} fps</strong>
          <em>{telemetry.performance.frameTimeMs.toFixed(1)}ms · cpu {telemetry.performance.cpuLoad.toFixed(2)}</em>
        </div>
      </div>
    </aside>
  );
}