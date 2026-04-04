"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import TxtMiniGuide from "../../../components/ui/TxtMiniGuide";

type Snapshot = {
  key: string;
  symbol: string;
  timeframe: string;
  instrumentClass: "btc" | "eth" | "index" | "default";
  resolvedMotionPreset: "scalping" | "swing";
  switches5m: number;
  switches1h: number;
  avgIntervalSec: number | null;
  lastSwitchAgoSec: number | null;
  targetBand: {
    okFloorSec: number;
    warnFloorSec: number;
    targetSec: number;
  };
  perfThresholds: {
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
  perfRuntime: {
    fps: number;
    frameTimeMs: number;
    cpuLoad: number;
    budgetUsedPct: number;
    lodLevel: "micro" | "compact" | "normal" | "expanded";
    overlayCount: number;
    activeIndicatorCount: number;
    updateCounts: {
      candle: number;
      indicator: number;
      overlay: number;
    };
    workerLatencyMs: number | null;
  };
  sparklineBuckets: number[];
  updatedAt: string;
};

type RuntimeGateHistoryEntry = {
  tone: "ok" | "warn" | "hot";
  timestamp: string;
  frameTimeMs: number;
  fps: number;
  cpuLoad: number;
  lodLevel: Snapshot["perfRuntime"]["lodLevel"];
  overlayCount: number;
  activeIndicatorCount: number;
  budgetUsedPct: number;
  updateCounts: Snapshot["perfRuntime"]["updateCounts"];
  workerLatencyMs: number | null;
};

type Payload = {
  status: string;
  count: number;
  snapshots: Snapshot[];
  timestamp: string;
};

const STALE_AFTER_MS = 60_000;
const RUNTIME_HISTORY_MAX = 10;

function formatCompactDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) {
    return "-";
  }
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

function heatFromSnapshot(snapshot: Snapshot): "ok" | "warn" | "hot" {
  if (snapshot.switches5m >= 9) {
    return "hot";
  }
  if (snapshot.switches5m >= 4) {
    return "warn";
  }
  return "ok";
}

function isSnapshotStale(snapshot: Snapshot, nowTs: number): boolean {
  const updatedAtTs = Date.parse(snapshot.updatedAt);
  if (!Number.isFinite(updatedAtTs)) {
    return true;
  }
  return nowTs - updatedAtTs > STALE_AFTER_MS;
}

function heatRank(heat: "ok" | "warn" | "hot"): number {
  if (heat === "hot") {
    return 2;
  }
  if (heat === "warn") {
    return 1;
  }
  return 0;
}

function runtimeGate(snapshot: Snapshot): {
  tone: "ok" | "warn" | "hot";
  busyBreaches: string[];
  criticalBreaches: string[];
} {
  const busyBreaches: string[] = [];
  const criticalBreaches: string[] = [];

  if (snapshot.perfRuntime.frameTimeMs > snapshot.perfThresholds.busyFrameMs) {
    busyBreaches.push("frame");
  }
  if (snapshot.perfRuntime.fps < snapshot.perfThresholds.busyMinFps) {
    busyBreaches.push("fps");
  }
  if (snapshot.perfRuntime.cpuLoad > snapshot.perfThresholds.busyCpuLoad) {
    busyBreaches.push("cpu");
  }

  if (snapshot.perfRuntime.frameTimeMs > snapshot.perfThresholds.criticalFrameMs) {
    criticalBreaches.push("frame");
  }
  if (snapshot.perfRuntime.fps < snapshot.perfThresholds.criticalMinFps) {
    criticalBreaches.push("fps");
  }
  if (snapshot.perfRuntime.cpuLoad > snapshot.perfThresholds.criticalCpuLoad) {
    criticalBreaches.push("cpu");
  }

  if (criticalBreaches.length > 0) {
    return { tone: "hot", busyBreaches, criticalBreaches };
  }
  if (busyBreaches.length > 0) {
    return { tone: "warn", busyBreaches, criticalBreaches };
  }
  return { tone: "ok", busyBreaches, criticalBreaches };
}

export default function ChartAutoStabilityDebugPage() {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [instrumentFilter, setInstrumentFilter] = useState<Snapshot["instrumentClass"] | "all">("all");
  const [timeframeFilter, setTimeframeFilter] = useState<string>("all");
  const [symbolQuery, setSymbolQuery] = useState("");
  const [hideStale, setHideStale] = useState(false);
  const [expertMode, setExpertMode] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [runtimeGateHistory, setRuntimeGateHistory] = useState<Record<string, RuntimeGateHistoryEntry[]>>({});
  const urlStateReadyRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const params = new URLSearchParams(window.location.search);
    const instrument = params.get("instrument");
    const timeframe = params.get("timeframe");
    const symbol = params.get("symbol");
    const hide = params.get("hideStale");

    if (instrument === "btc" || instrument === "eth" || instrument === "index" || instrument === "default" || instrument === "all") {
      setInstrumentFilter(instrument);
    }
    if (timeframe) {
      setTimeframeFilter(timeframe);
    }
    if (symbol) {
      setSymbolQuery(symbol);
    }
    setHideStale(hide === "1");
    urlStateReadyRef.current = true;
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !urlStateReadyRef.current) {
      return;
    }
    const params = new URLSearchParams(window.location.search);
    if (instrumentFilter !== "all") {
      params.set("instrument", instrumentFilter);
    } else {
      params.delete("instrument");
    }
    if (timeframeFilter !== "all") {
      params.set("timeframe", timeframeFilter);
    } else {
      params.delete("timeframe");
    }
    if (symbolQuery.trim()) {
      params.set("symbol", symbolQuery.trim());
    } else {
      params.delete("symbol");
    }
    if (hideStale) {
      params.set("hideStale", "1");
    } else {
      params.delete("hideStale");
    }
    const query = params.toString();
    const nextUrl = `${window.location.pathname}${query ? `?${query}` : ""}`;
    window.history.replaceState(null, "", nextUrl);
  }, [hideStale, instrumentFilter, symbolQuery, timeframeFilter]);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const response = await fetch("/api/system/chart-auto-stability", { cache: "no-store" });
        if (!response.ok) {
          throw new Error("Impossible de charger les snapshots auto-stability");
        }
        const nextPayload = await response.json() as Payload;
        if (!cancelled) {
          setPayload(nextPayload);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Erreur inconnue");
        }
      }
    };

    void load();
    const intervalId = window.setInterval(() => {
      void load();
    }, 10000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [refreshTick]);

  const snapshots = payload?.snapshots ?? [];

  useEffect(() => {
    if (!payload || snapshots.length === 0) {
      return;
    }
    setRuntimeGateHistory((current) => {
      const next: Record<string, RuntimeGateHistoryEntry[]> = {};
      for (const snapshot of snapshots) {
        const tone = runtimeGate(snapshot).tone;
        const prev = current[snapshot.key] || [];
        const nextEntry: RuntimeGateHistoryEntry = {
          tone,
          timestamp: snapshot.updatedAt,
          frameTimeMs: snapshot.perfRuntime.frameTimeMs,
          fps: snapshot.perfRuntime.fps,
          cpuLoad: snapshot.perfRuntime.cpuLoad,
          lodLevel: snapshot.perfRuntime.lodLevel,
          overlayCount: snapshot.perfRuntime.overlayCount,
          activeIndicatorCount: snapshot.perfRuntime.activeIndicatorCount,
          budgetUsedPct: snapshot.perfRuntime.budgetUsedPct,
          updateCounts: snapshot.perfRuntime.updateCounts,
          workerLatencyMs: snapshot.perfRuntime.workerLatencyMs,
        };
        next[snapshot.key] = [...prev, nextEntry].slice(-RUNTIME_HISTORY_MAX);
      }
      return next;
    });
  }, [payload?.timestamp, snapshots]);

  const nowTs = Date.now();
  const instrumentOptions = useMemo(() => Array.from(new Set(snapshots.map((snapshot) => snapshot.instrumentClass))), [snapshots]);
  const timeframeOptions = useMemo(() => Array.from(new Set(snapshots.map((snapshot) => snapshot.timeframe))).sort(), [snapshots]);
  const visibleSnapshots = useMemo(() => {
    return snapshots
      .filter((snapshot) => instrumentFilter === "all" || snapshot.instrumentClass === instrumentFilter)
      .filter((snapshot) => timeframeFilter === "all" || snapshot.timeframe === timeframeFilter)
      .filter((snapshot) => !symbolQuery.trim() || snapshot.symbol.toUpperCase().includes(symbolQuery.trim().toUpperCase()))
      .filter((snapshot) => !hideStale || !isSnapshotStale(snapshot, nowTs))
      .sort((left, right) => {
        const leftStale = isSnapshotStale(left, nowTs);
        const rightStale = isSnapshotStale(right, nowTs);
        const heatDiff = heatRank(heatFromSnapshot(right)) - heatRank(heatFromSnapshot(left));
        if (heatDiff !== 0) {
          return heatDiff;
        }
        if (leftStale !== rightStale) {
          return Number(leftStale) - Number(rightStale);
        }
        return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
      });
  }, [hideStale, instrumentFilter, nowTs, snapshots, symbolQuery, timeframeFilter]);
  const totalHot = useMemo(() => visibleSnapshots.filter((snapshot) => heatFromSnapshot(snapshot) === "hot").length, [visibleSnapshots]);
  const totalStale = useMemo(() => visibleSnapshots.filter((snapshot) => isSnapshotStale(snapshot, nowTs)).length, [nowTs, visibleSnapshots]);

  const buildFilteredUrl = (): string => {
    if (typeof window === "undefined") {
      return "";
    }
    const params = new URLSearchParams();
    if (instrumentFilter !== "all") {
      params.set("instrument", instrumentFilter);
    }
    if (timeframeFilter !== "all") {
      params.set("timeframe", timeframeFilter);
    }
    if (symbolQuery.trim()) {
      params.set("symbol", symbolQuery.trim());
    }
    if (hideStale) {
      params.set("hideStale", "1");
    }
    const query = params.toString();
    return `${window.location.origin}${window.location.pathname}${query ? `?${query}` : ""}`;
  };

  const handleCopyFilteredUrl = async () => {
    if (typeof window === "undefined") {
      return;
    }
    const nextUrl = buildFilteredUrl();
    try {
      await navigator.clipboard.writeText(nextUrl);
      setCopyState("copied");
    } catch {
      try {
        const textArea = document.createElement("textarea");
        textArea.value = nextUrl;
        textArea.style.position = "fixed";
        textArea.style.opacity = "0";
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        document.execCommand("copy");
        document.body.removeChild(textArea);
        setCopyState("copied");
      } catch {
        setCopyState("error");
      }
    }
    window.setTimeout(() => {
      setCopyState("idle");
    }, 1400);
  };

  const clearUrlParams = () => {
    if (typeof window === "undefined") {
      return;
    }
    window.history.replaceState(null, "", window.location.pathname);
  };

  const resetFilters = () => {
    setInstrumentFilter("all");
    setTimeframeFilter("all");
    setSymbolQuery("");
    setHideStale(false);
    setCopyState("idle");
  };

  const resetHistory = () => {
    setRuntimeGateHistory({});
  };

  const exportSnapshots = () => {
    if (typeof window === "undefined") {
      return;
    }
    const exported = {
      exportedAt: new Date().toISOString(),
      filters: {
        instrument: instrumentFilter,
        timeframe: timeframeFilter,
        symbol: symbolQuery.trim() || null,
        hideStale,
        expertMode,
      },
      visibleCount: visibleSnapshots.length,
      snapshots: visibleSnapshots,
      runtimeHistory: Object.fromEntries(
        visibleSnapshots.map((snapshot) => [snapshot.key, runtimeGateHistory[snapshot.key] || []]),
      ),
    };
    const blob = new Blob([JSON.stringify(exported, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `chart-auto-stability-${Date.now()}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  };

  return (
    <main className="shell txt-page-shell">
      <section className="hero txt-page-hero-grid" style={{ gridTemplateColumns: "1.35fr 1fr" }}>
        <div className="panel txt-page-hero">
          <div className="eyebrow">Ops Debug</div>
          <h1 className="title" style={{ fontSize: 34 }}>Chart Auto Stability</h1>
          <p className="subtle">Snapshots live du mode auto par symbole pour diagnostiquer l’hysteresis, la nervosite de calibration et la frequence de switch.</p>
          <TxtMiniGuide
            title="Guide Auto Stability"
            what="Vue ops compacte des snapshots publies par les charts actifs en mode auto."
            why="Voir instantanement si la calibration commute trop souvent par symbole, timeframe ou classe d’instrument."
            example="Si BTCUSD 1m passe en hot avec une sparkline dense, l’hysteresis ou les seuils auto sont trop agressifs."
            terms={["hysteresis", "sparkline", "switches/h"]}
          />
          <p>
            <Link href="/advanced">Advanced</Link>
            {" | "}
            <Link href="/terminal">Trading Terminal</Link>
            {" | "}
            <Link href="/live-readiness">Live Readiness</Link>
          </p>
          {error ? <p className="warn">{error}</p> : null}
        </div>

        <div className="panel chart-auto-debug-summary">
          <div className="eyebrow">Summary</div>
          <div className="row"><span>Visible / Total</span><span>{String(visibleSnapshots.length)} / {String(snapshots.length)}</span></div>
          <div className="row"><span>Heat hot</span><span className={totalHot > 0 ? "warn" : "good"}>{String(totalHot)}</span></div>
          <div className="row"><span>Stale</span><span className={totalStale > 0 ? "warn" : "good"}>{String(totalStale)}</span></div>
          <div className="row"><span>Endpoint</span><span>/api/system/chart-auto-stability</span></div>
          <div className="row"><span>Last refresh</span><span>{payload?.timestamp ? new Date(payload.timestamp).toLocaleTimeString() : "-"}</span></div>
          <div className="chart-auto-debug-filters">
            <label className="chart-auto-debug-filter-wide">
              <span>Symbol</span>
              <input
                type="text"
                value={symbolQuery}
                onChange={(event) => setSymbolQuery(event.target.value)}
                placeholder="BTCUSD"
              />
            </label>
            <label>
              <span>Instrument</span>
              <select value={instrumentFilter} onChange={(event) => setInstrumentFilter(event.target.value as Snapshot["instrumentClass"] | "all")}> 
                <option value="all">All</option>
                {instrumentOptions.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Timeframe</span>
              <select value={timeframeFilter} onChange={(event) => setTimeframeFilter(event.target.value)}>
                <option value="all">All</option>
                {timeframeOptions.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </label>
            <label className="chart-auto-debug-toggle">
              <span>Hide stale</span>
              <input type="checkbox" checked={hideStale} onChange={(event) => setHideStale(event.target.checked)} />
            </label>
            <label className="chart-auto-debug-toggle">
              <span>Expert mode</span>
              <input type="checkbox" checked={expertMode} onChange={(event) => setExpertMode(event.target.checked)} />
            </label>
          </div>
          <div className="chart-auto-debug-actions">
            <button type="button" onClick={() => setRefreshTick((value) => value + 1)}>Refresh</button>
            <button type="button" className="chart-auto-debug-btn-secondary" onClick={resetFilters}>Reset filters</button>
            <button type="button" className="chart-auto-debug-btn-secondary" onClick={resetHistory}>Reset history</button>
            <button type="button" className="chart-auto-debug-btn-secondary" onClick={clearUrlParams}>Clear URL params</button>
            <button type="button" className="chart-auto-debug-btn-secondary" onClick={exportSnapshots}>Export snapshot</button>
            <button type="button" className="chart-auto-debug-btn-secondary" onClick={() => void handleCopyFilteredUrl()}>
              {copyState === "copied" ? "Copied" : copyState === "error" ? "Copy failed" : "Copy filtered URL"}
            </button>
          </div>
        </div>
      </section>

      <section className="grid chart-auto-debug-grid">
        {visibleSnapshots.length === 0 ? (
          <div className="panel">
            <div className="eyebrow">No Data</div>
            <p className="subtle">Aucun snapshot pour l’instant. Ouvre un chart actif en mode auto pour commencer a publier des donnees.</p>
          </div>
        ) : null}

        {visibleSnapshots.map((snapshot) => {
          const heat = heatFromSnapshot(snapshot);
          const sparklinePath = buildSparklinePath(snapshot.sparklineBuckets || [], 120, 24);
          const stale = isSnapshotStale(snapshot, nowTs);
          const gate = runtimeGate(snapshot);
          const runtimeHistory = runtimeGateHistory[snapshot.key] || [];

          return (
            <article className="panel chart-auto-debug-card" key={snapshot.key}>
              <div className="chart-auto-debug-card-head">
                <div>
                  <div className="eyebrow">{snapshot.instrumentClass}</div>
                  <h2 className="chart-auto-debug-symbol">{snapshot.symbol}</h2>
                </div>
                <div className="chart-auto-debug-badges">
                  {stale ? <span className="chart-auto-debug-stale">stale</span> : null}
                  <span className={`chart-auto-debug-heat chart-auto-debug-heat-${heat}`}>{heat}</span>
                </div>
              </div>

              <div className="chart-auto-debug-meta">
                <span>{snapshot.timeframe}</span>
                <span>{snapshot.resolvedMotionPreset}</span>
                <span>updated {new Date(snapshot.updatedAt).toLocaleTimeString()}</span>
              </div>

              <div className="chart-auto-debug-kpis">
                <div className="row"><span>switches / 5m</span><span>{snapshot.switches5m}</span></div>
                <div className="row"><span>switches / h</span><span>{snapshot.switches1h}</span></div>
                <div className="row"><span>temps moyen</span><span>{formatCompactDuration(snapshot.avgIntervalSec)}</span></div>
                <div className="row"><span>dernier switch</span><span>{snapshot.lastSwitchAgoSec === null ? "-" : `il y a ${formatCompactDuration(snapshot.lastSwitchAgoSec)}`}</span></div>
              </div>

              <div className="chart-auto-debug-band">
                <strong>Target band</strong>
                <span>ok &gt;= {formatCompactDuration(snapshot.targetBand.okFloorSec)}</span>
                <span>warn {formatCompactDuration(snapshot.targetBand.warnFloorSec)} - {formatCompactDuration(snapshot.targetBand.okFloorSec)}</span>
                <span>hot &lt; {formatCompactDuration(snapshot.targetBand.warnFloorSec)}</span>
              </div>

              <div className="chart-auto-debug-band">
                <strong>
                  Perf Guard Profile
                  <span className={`chart-auto-debug-runtime-gate chart-auto-debug-runtime-gate-${gate.tone}`}>
                    runtime {gate.tone}
                  </span>
                </strong>
                <span>busy: &gt; {snapshot.perfThresholds.busyFrameMs.toFixed(1)}ms | &lt; {snapshot.perfThresholds.busyMinFps.toFixed(0)} fps | cpu &gt; {snapshot.perfThresholds.busyCpuLoad.toFixed(2)}</span>
                <span>critical: &gt; {snapshot.perfThresholds.criticalFrameMs.toFixed(1)}ms | &lt; {snapshot.perfThresholds.criticalMinFps.toFixed(0)} fps | cpu &gt; {snapshot.perfThresholds.criticalCpuLoad.toFixed(2)}</span>
                <span>DOM {snapshot.perfThresholds.domLevelsBusy}/{snapshot.perfThresholds.domLevelsNormal} · HM {snapshot.perfThresholds.heatmapBandsBusy}/{snapshot.perfThresholds.heatmapBandsNormal}</span>
                <span>runtime: {snapshot.perfRuntime.frameTimeMs.toFixed(1)}ms · {snapshot.perfRuntime.fps.toFixed(0)} fps · cpu {snapshot.perfRuntime.cpuLoad.toFixed(2)}</span>
                {expertMode ? <span>frameTime exact: {snapshot.perfRuntime.frameTimeMs.toFixed(3)}ms</span> : null}
                {expertMode ? <span>budget used: {snapshot.perfRuntime.budgetUsedPct.toFixed(1)}%</span> : null}
                {expertMode ? <span>LOD: {snapshot.perfRuntime.lodLevel} · overlays: {snapshot.perfRuntime.overlayCount} · indicators: {snapshot.perfRuntime.activeIndicatorCount}</span> : null}
                {expertMode ? <span>updates C/I/O: {snapshot.perfRuntime.updateCounts.candle}/{snapshot.perfRuntime.updateCounts.indicator}/{snapshot.perfRuntime.updateCounts.overlay}</span> : null}
                {expertMode ? <span>worker latency: {snapshot.perfRuntime.workerLatencyMs === null ? "-" : `${snapshot.perfRuntime.workerLatencyMs.toFixed(1)}ms`}</span> : null}
                {gate.tone === "warn" ? <span>busy breach: {gate.busyBreaches.join(", ")}</span> : null}
                {gate.tone === "hot" ? <span>critical breach: {gate.criticalBreaches.join(", ")}</span> : null}
                <div className="chart-auto-debug-runtime-history" aria-label="runtime gate history">
                  <span className="chart-auto-debug-runtime-history-label">history</span>
                  <span className="chart-auto-debug-runtime-history-dots" role="img" aria-label={`runtime history ${runtimeHistory.map((entry) => entry.tone).join(", ") || "empty"}`}>
                    {runtimeHistory.map((entry, index) => (
                      <i
                        key={`${snapshot.key}-rt-${index}`}
                        className={`chart-auto-debug-runtime-history-dot chart-auto-debug-runtime-history-dot-${entry.tone}`}
                        title={[
                          `time: ${new Date(entry.timestamp).toLocaleTimeString()}`,
                          `frameTime: ${entry.frameTimeMs.toFixed(3)}ms`,
                          `cpu: ${(entry.cpuLoad * 100).toFixed(1)}%`,
                          `lod: ${entry.lodLevel}`,
                          `overlays: ${entry.overlayCount}`,
                          `active indicators: ${entry.activeIndicatorCount}`,
                          `budget used: ${entry.budgetUsedPct.toFixed(1)}%`,
                          `updates C/I/O: ${entry.updateCounts.candle}/${entry.updateCounts.indicator}/${entry.updateCounts.overlay}`,
                          `worker latency: ${entry.workerLatencyMs === null ? "-" : `${entry.workerLatencyMs.toFixed(1)}ms`}`,
                        ].join("\n")}
                      />
                    ))}
                  </span>
                  <span className="chart-auto-debug-runtime-history-meta">{runtimeHistory.length}/{RUNTIME_HISTORY_MAX}</span>
                </div>
              </div>

              <div className="chart-auto-debug-sparkline-box">
                <div className="chart-auto-debug-sparkline-label">Switches 1h</div>
                <svg className="chart-auto-debug-sparkline" viewBox="0 0 120 24" preserveAspectRatio="none" aria-hidden="true">
                  <path d={sparklinePath} />
                </svg>
              </div>
            </article>
          );
        })}
      </section>
    </main>
  );
}