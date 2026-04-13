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
          <div className="chart-perceptual-row chart-perceptual-row-range">
            <span>Diagnosis</span>
            <strong>{gpuTelemetry.diagnosis.primary[0] || "balanced_structure"}</strong>
            <em>{gpuTelemetry.diagnosis.summary}</em>
          </div>
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
            <em>{gpuTelemetry.visibleBars} visible · target {gpuTelemetry.spacing.targetVisibleBars}</em>
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
            <span>Live sync</span>
            <strong>{gpuTelemetry.continuity.renderedFrames}/{gpuTelemetry.continuity.liveFrames}</strong>
            <em>{gpuTelemetry.sync.status} · partial {gpuTelemetry.continuity.partialFrames} · coal {gpuTelemetry.continuity.coalescedFrames}</em>
          </div>
          <div className="chart-perceptual-row">
            <span>Lost states</span>
            <strong>{gpuTelemetry.continuity.lostIntermediateFrames}</strong>
            <em>ow {gpuTelemetry.continuity.schedulerOverwrites} · def {gpuTelemetry.continuity.schedulerDeferrals} · loose {gpuTelemetry.continuity.looseSyncFrames}</em>
          </div>
          <div className="chart-perceptual-row">
            <span>Jump / mode</span>
            <strong>{formatNumber(gpuTelemetry.continuity.peakJumpPx)}px peak</strong>
            <em>{gpuTelemetry.continuity.continuityMode} · evt {gpuTelemetry.continuity.jumpEvents}</em>
          </div>
          <div className="chart-perceptual-row">
            <span>Fallback redraw</span>
            <strong>{gpuTelemetry.continuity.updateFallbackRedraws}</strong>
            <em>GPU path keeps setData fallback at 0</em>
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
          <span>Snap / zone</span>
          <strong>{formatNumber(telemetry.pixel.quantizedSpacingPx)}px</strong>
          <em>{telemetry.pixel.spacingZone} · Δ {formatNumber(telemetry.pixel.snapDeltaPx, 2)}px</em>
        </div>
        <div className="chart-perceptual-row">
          <span>Body / gap</span>
          <strong>{formatNumber(telemetry.spacing.preferredBodyWidthPx)}px</strong>
          <em>{formatNumber(telemetry.spacing.minGapPx)}px</em>
        </div>
        <div className="chart-perceptual-row">
          <span>Pixel geom</span>
          <strong>{formatNumber(telemetry.pixel.preferredBodyWidthPx)}px body</strong>
          <em>{formatNumber(telemetry.pixel.wickWidthPx)}px wick · {formatNumber(telemetry.pixel.pixelRatio, 2)}x DPR</em>
        </div>
        <div className="chart-perceptual-row">
          <span>Weights</span>
          <strong>tf {formatNumber(telemetry.perceptual.timeframeWeight, 2)} · dens {formatNumber(telemetry.perceptual.densityFactor, 2)}</strong>
          <em>vol {formatNumber(telemetry.perceptual.volatilityFactor, 2)} · zoom {formatNumber(telemetry.perceptual.zoomFactor, 2)}</em>
        </div>
        <div className="chart-perceptual-row">
          <span>Width model</span>
          <strong>{formatNumber(telemetry.perceptual.baseBodyWidthPx)}px base</strong>
          <em>{formatNumber(telemetry.perceptual.minBodyWidthPx)} → {formatNumber(telemetry.perceptual.maxBodyWidthPx)}px · ratio {formatNumber(telemetry.perceptual.bodyToSpacingRatio, 2)}</em>
        </div>
        <div className="chart-perceptual-row">
          <span>Desk mode</span>
          <strong>{telemetry.desk.mode}</strong>
          <em>{telemetry.desk.authoritativeRenderer ? "V3 authoritative" : "native final bodies"} · conf {(telemetry.desk.confidence * 100).toFixed(0)}%</em>
        </div>
        <div className="chart-perceptual-row">
          <span>Flow</span>
          <strong>liq {formatNumber(telemetry.desk.liquidityScore, 2)} · exec {formatNumber(telemetry.desk.executionScore, 2)}</strong>
          <em>heat {formatNumber(telemetry.desk.heatScore, 2)} · delta {formatNumber(telemetry.desk.deltaScore, 2)}</em>
        </div>
        <div className="chart-perceptual-row">
          <span>Sim state</span>
          <strong>{telemetry.simulation.stateLabel}</strong>
          <em>{telemetry.simulation.shouldExecute ? `${telemetry.simulation.decisionAction} live` : "hold"} · conf {(telemetry.simulation.confidence * 100).toFixed(0)}%</em>
        </div>
        <div className="chart-perceptual-row">
          <span>Sim exec</span>
          <strong>fill {(telemetry.simulation.fillProbability * 100).toFixed(0)}%</strong>
          <em>slip {formatNumber(telemetry.simulation.slippageBps, 1)}bps · lat {formatNumber(telemetry.simulation.latencyMs, 0)}ms</em>
        </div>
        <div className="chart-perceptual-row chart-perceptual-row-range">
          <span>Sim cone</span>
          <strong>{formatNumber(telemetry.simulation.coneBest, 2)} / {formatNumber(telemetry.simulation.coneExpected, 2)} / {formatNumber(telemetry.simulation.coneWorst, 2)}</strong>
          <em>100 {formatNumber(telemetry.simulation.t100msPrice, 2)} · 250 {formatNumber(telemetry.simulation.t250msPrice, 2)} · 500 {formatNumber(telemetry.simulation.t500msPrice, 2)}</em>
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
        <div className="chart-perceptual-row">
          <span>Live sync</span>
          <strong>{telemetry.continuity.partialFrames} partial · {telemetry.continuity.coalescedFrames} coal</strong>
          <em>{telemetry.continuity.looseSyncFrames} loose · {telemetry.continuity.liveFrames} recv / {telemetry.continuity.renderedFrames} rend</em>
        </div>
        <div className="chart-perceptual-row">
          <span>Lost states</span>
          <strong>{telemetry.continuity.lostIntermediateFrames}</strong>
          <em>sch {telemetry.continuity.schedulerOverwrites} · raf {telemetry.continuity.rafOverwrites} · confl {telemetry.continuity.conflatedUpdates}</em>
        </div>
        <div className="chart-perceptual-row">
          <span>Redraws</span>
          <strong>{telemetry.continuity.fullRedraws} setData</strong>
          <em>fallback {telemetry.continuity.updateFallbackRedraws} · clear {telemetry.continuity.recoveryClears}</em>
        </div>
        <div className="chart-perceptual-row">
          <span>Continuity</span>
          <strong>{telemetry.continuity.continuityMode}</strong>
          <em>proj {telemetry.continuity.overlayContinuityStarts}/{telemetry.continuity.overlayContinuitySettles} · jump {formatNumber(telemetry.continuity.latestJumpPx, 1)}px peak {formatNumber(telemetry.continuity.peakJumpPx, 1)}px</em>
        </div>
      </div>
    </aside>
  );
}