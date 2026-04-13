"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import OperatorPanelGuide from "../../../components/ui/OperatorPanelGuide";

type JsonMap = Record<string, unknown>;

type CalibrationSourceSummary = {
  calibrated: boolean;
  confidence: number;
  sample_count: number;
  real_count: number;
  synthetic_count: number;
  effective_sample_weight: number;
  average_reward: number;
  multipliers: Record<string, number>;
};

type CalibrationWindowSnapshot = {
  label: string;
  generated_at: string;
  start_at: string | null;
  end_at: string;
  experience_rows: number;
  real_rows: number;
  synthetic_rows: number;
  failure_rows: number;
  real_failure_rows: number;
  oldest_experience_at: string | null;
  newest_experience_at: string | null;
  sources: Record<string, CalibrationSourceSummary>;
};

type CalibrationHistoryEntry = {
  generated_at: string;
  row_count: number;
  windows: Record<string, CalibrationWindowSnapshot>;
};

type CalibrationPayload = {
  status?: string;
  service?: string;
  generated_at: string;
  source_path: string;
  history_path: string;
  row_count: number;
  history_limit: number;
  window_order: string[];
  windows: Record<string, CalibrationWindowSnapshot>;
  history: CalibrationHistoryEntry[];
};

const WINDOW_LABELS: Record<string, string> = {
  "24h": "24h",
  "7d": "7 jours",
  "30d": "30 jours",
  all: "All replay",
};

const SOURCE_LABELS: Record<string, string> = {
  infra: "Infra",
  market: "Market",
  execution: "Execution",
};

function toNumber(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "-";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Date(timestamp).toLocaleString();
}

function formatSourceLabel(value: string): string {
  return SOURCE_LABELS[value] || value;
}

function formatWindowLabel(value: string): string {
  return WINDOW_LABELS[value] || value;
}

function formatSigned(value: number, digits = 2, suffix = ""): string {
  const normalized = Number.isFinite(value) ? value : 0;
  return `${normalized >= 0 ? "+" : ""}${normalized.toFixed(digits)}${suffix}`;
}

function buildSparklinePath(values: number[], width: number, height: number): string {
  if (values.length === 0) return "";
  const maxValue = Math.max(0.01, ...values);
  const stepX = values.length > 1 ? width / (values.length - 1) : width;
  return values.map((value, index) => {
    const x = Number((index * stepX).toFixed(2));
    const y = Number((height - (value / maxValue) * height).toFixed(2));
    return `${index === 0 ? "M" : "L"}${x},${y}`;
  }).join(" ");
}

function normalizeSourceSummary(raw: unknown): CalibrationSourceSummary {
  const source = raw && typeof raw === "object" ? raw as JsonMap : {};
  const multipliersRaw = source.multipliers && typeof source.multipliers === "object"
    ? source.multipliers as Record<string, unknown>
    : {};
  return {
    calibrated: Boolean(source.calibrated),
    confidence: toNumber(source.confidence, 0),
    sample_count: Math.max(0, Math.round(toNumber(source.sample_count, 0))),
    real_count: Math.max(0, Math.round(toNumber(source.real_count, 0))),
    synthetic_count: Math.max(0, Math.round(toNumber(source.synthetic_count, 0))),
    effective_sample_weight: toNumber(source.effective_sample_weight, 0),
    average_reward: toNumber(source.average_reward, 0),
    multipliers: Object.fromEntries(
      Object.entries(multipliersRaw).map(([agent, value]) => [agent, toNumber(value, 1)]),
    ),
  };
}

function normalizeWindowSnapshot(label: string, raw: unknown): CalibrationWindowSnapshot {
  const window = raw && typeof raw === "object" ? raw as JsonMap : {};
  const sourcesRaw = window.sources && typeof window.sources === "object"
    ? window.sources as Record<string, unknown>
    : {};
  return {
    label,
    generated_at: String(window.generated_at || ""),
    start_at: typeof window.start_at === "string" ? window.start_at : null,
    end_at: String(window.end_at || ""),
    experience_rows: Math.max(0, Math.round(toNumber(window.experience_rows, 0))),
    real_rows: Math.max(0, Math.round(toNumber(window.real_rows, 0))),
    synthetic_rows: Math.max(0, Math.round(toNumber(window.synthetic_rows, 0))),
    failure_rows: Math.max(0, Math.round(toNumber(window.failure_rows, 0))),
    real_failure_rows: Math.max(0, Math.round(toNumber(window.real_failure_rows, 0))),
    oldest_experience_at: typeof window.oldest_experience_at === "string" ? window.oldest_experience_at : null,
    newest_experience_at: typeof window.newest_experience_at === "string" ? window.newest_experience_at : null,
    sources: Object.fromEntries(
      Object.entries(sourcesRaw).map(([source, summary]) => [source, normalizeSourceSummary(summary)]),
    ),
  };
}

function normalizePayload(raw: unknown): CalibrationPayload {
  const payload = raw && typeof raw === "object" ? raw as JsonMap : {};
  const windowsRaw = payload.windows && typeof payload.windows === "object"
    ? payload.windows as Record<string, unknown>
    : {};
  const historyRaw = Array.isArray(payload.history) ? payload.history : [];
  const windowOrder = Array.isArray(payload.window_order)
    ? payload.window_order.map((value) => String(value)).filter(Boolean)
    : Object.keys(windowsRaw);
  return {
    status: typeof payload.status === "string" ? payload.status : undefined,
    service: typeof payload.service === "string" ? payload.service : undefined,
    generated_at: String(payload.generated_at || ""),
    source_path: String(payload.source_path || ""),
    history_path: String(payload.history_path || ""),
    row_count: Math.max(0, Math.round(toNumber(payload.row_count, 0))),
    history_limit: Math.max(0, Math.round(toNumber(payload.history_limit, 0))),
    window_order: windowOrder,
    windows: Object.fromEntries(windowOrder.map((label) => [label, normalizeWindowSnapshot(label, windowsRaw[label])])),
    history: historyRaw
      .filter((entry): entry is JsonMap => Boolean(entry) && typeof entry === "object")
      .map((entry) => {
        const entryWindows = entry.windows && typeof entry.windows === "object"
          ? entry.windows as Record<string, unknown>
          : {};
        return {
          generated_at: String(entry.generated_at || ""),
          row_count: Math.max(0, Math.round(toNumber(entry.row_count, 0))),
          windows: Object.fromEntries(windowOrder.map((label) => [label, normalizeWindowSnapshot(label, entryWindows[label])])),
        };
      }),
  };
}

export default function PredictorCalibrationClient() {
  const [payload, setPayload] = useState<CalibrationPayload | null>(null);
  const [selectedSource, setSelectedSource] = useState("infra");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  async function loadPayload(refresh = false): Promise<void> {
    try {
      if (refresh) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      setError(null);
      const response = await fetch(`/api/predictor/brain/calibration/history${refresh ? "?refresh=1" : ""}`, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Impossible de charger la calibration predictor (${response.status})`);
      }
      const body = normalizePayload(await response.json());
      setPayload(body);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "Impossible de charger la calibration predictor");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    void loadPayload();
  }, []);

  const selectedSourceHistory = useMemo(() => {
    if (!payload) return [] as Array<{ label: string; points: number[] }>;
    return payload.window_order.map((windowLabel) => ({
      label: windowLabel,
      points: payload.history.map((entry) => toNumber(entry.windows[windowLabel]?.sources[selectedSource]?.confidence, 0)),
    }));
  }, [payload, selectedSource]);

  const latestRuns = useMemo(() => {
    if (!payload) return [] as CalibrationHistoryEntry[];
    return [...payload.history].reverse().slice(0, 12);
  }, [payload]);

  const windowComparison = useMemo(() => {
    if (!payload) return [] as Array<{
      label: string;
      snapshot: CalibrationWindowSnapshot;
      source: CalibrationSourceSummary;
      deltaConfidenceVsAll: number;
      deltaSamplesVsAll: number;
      deltaConfidenceVsPrevRun: number;
      deltaSamplesVsPrevRun: number;
    }>;
    const allSource = payload.windows.all?.sources[selectedSource] || normalizeSourceSummary(null);
    const previousEntry = payload.history.length > 1 ? payload.history[payload.history.length - 2] : null;
    return payload.window_order.map((windowLabel) => ({
      label: windowLabel,
      snapshot: payload.windows[windowLabel],
      source: payload.windows[windowLabel]?.sources[selectedSource] || normalizeSourceSummary(null),
      deltaConfidenceVsAll: toNumber(payload.windows[windowLabel]?.sources[selectedSource]?.confidence, 0) - allSource.confidence,
      deltaSamplesVsAll: toNumber(payload.windows[windowLabel]?.sources[selectedSource]?.sample_count, 0) - allSource.sample_count,
      deltaConfidenceVsPrevRun: previousEntry
        ? toNumber(payload.windows[windowLabel]?.sources[selectedSource]?.confidence, 0) - toNumber(previousEntry.windows[windowLabel]?.sources[selectedSource]?.confidence, 0)
        : 0,
      deltaSamplesVsPrevRun: previousEntry
        ? toNumber(payload.windows[windowLabel]?.sources[selectedSource]?.sample_count, 0) - toNumber(previousEntry.windows[windowLabel]?.sources[selectedSource]?.sample_count, 0)
        : 0,
    }));
  }, [payload, selectedSource]);

  return (
    <main className="shell txt-page-shell">
      <section className="panel txt-page-hero">
        <div className="eyebrow">Predictor Admin</div>
        <h1 className="title" style={{ fontSize: 34 }}>Failure LR Calibration</h1>
        <p className="subtle">Vue admin des fenetres de calibration offline, comparaison par source et historique des snapshots periodiques.</p>
        <OperatorPanelGuide
          title="Guide Calibration"
          what="Compare les fenetres 24h/7j/30j/all replay et la confiance empirique par source d'echec."
          why="Verifier que les multiplicateurs sortent progressivement du prior-blended a mesure que le replay reel s'enrichit."
          example="Si Infra monte sur 30j mais reste faible sur 24h, le signal est stable mais peu recent."
          terms={["confidence", "effective sample weight", "rolling window"]}
        />
        <p>
          <Link href="/advanced">Advanced</Link>
          {" | "}
          <Link href="/terminal">Trading Terminal</Link>
        </p>
      </section>

      <section className="grid" style={{ gridTemplateColumns: "1.1fr 1.9fr", gap: 16, alignItems: "start" }}>
        <article className="panel">
          <div className="eyebrow">Snapshot</div>
          {loading ? <p className="subtle">Chargement...</p> : null}
          {error ? <p className="warn">{error}</p> : null}
          {!loading && payload ? (
            <div style={{ display: "grid", gap: 10 }}>
              <div className="row"><span>Generated</span><span>{formatDateTime(payload.generated_at)}</span></div>
              <div className="row"><span>Replay rows</span><span>{payload.row_count}</span></div>
              <div className="row"><span>History depth</span><span>{payload.history.length}/{payload.history_limit}</span></div>
              <div className="row"><span>Replay path</span><span style={{ textAlign: "right", wordBreak: "break-all" }}>{payload.source_path || "-"}</span></div>
              <div className="row"><span>History file</span><span style={{ textAlign: "right", wordBreak: "break-all" }}>{payload.history_path || "-"}</span></div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {Object.keys(SOURCE_LABELS).map((source) => {
                  const active = selectedSource === source;
                  return (
                    <button
                      key={source}
                      type="button"
                      onClick={() => setSelectedSource(source)}
                      style={{
                        borderRadius: 999,
                        border: active ? "1px solid rgba(207, 233, 185, 0.55)" : "1px solid rgba(148, 163, 184, 0.22)",
                        background: active ? "rgba(34, 197, 94, 0.14)" : "rgba(15, 23, 42, 0.32)",
                        color: active ? "#d7f7cf" : "#d7dbe0",
                        padding: "6px 10px",
                        fontSize: 12,
                        cursor: "pointer",
                      }}
                    >
                      {formatSourceLabel(source)}
                    </button>
                  );
                })}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" onClick={() => void loadPayload(true)} disabled={refreshing}>
                  {refreshing ? "Rebuilding..." : "Rebuild now"}
                </button>
                <button type="button" onClick={() => void loadPayload(false)} disabled={loading || refreshing}>Refresh view</button>
              </div>
            </div>
          ) : null}
        </article>

        <article className="panel">
          <div className="eyebrow">Window Compare</div>
          <div className="subtle" style={{ marginBottom: 10 }}>Comparaison live de {formatSourceLabel(selectedSource)} sur toutes les fenetres.</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))", gap: 12 }}>
            {windowComparison.map(({ label, snapshot, source, deltaConfidenceVsAll, deltaSamplesVsAll, deltaConfidenceVsPrevRun, deltaSamplesVsPrevRun }) => {
              const multiplierEntries = Object.entries(source.multipliers).sort((left, right) => left[1] - right[1]);
              return (
                <div key={label} style={{ border: "1px solid rgba(148,163,184,0.18)", borderRadius: 12, padding: 12, background: "rgba(15,23,42,0.22)", display: "grid", gap: 8 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <strong>{formatWindowLabel(label)}</strong>
                    <span style={{ color: source.confidence >= 0.5 ? "#cfe9b9" : source.confidence > 0 ? "#efc28f" : "#9fb0c3" }}>
                      {(source.confidence * 100).toFixed(0)}% conf
                    </span>
                  </div>
                  <div className="row"><span>Rows</span><span>{snapshot.experience_rows} total · {snapshot.real_rows} real</span></div>
                  <div className="row"><span>Failures</span><span>{snapshot.failure_rows} total · {snapshot.real_failure_rows} real</span></div>
                  <div className="row"><span>Samples</span><span>{source.sample_count} · synth {source.synthetic_count}</span></div>
                  <div className="row"><span>Weight</span><span>{source.effective_sample_weight.toFixed(2)}</span></div>
                  <div className="row"><span>Avg reward</span><span>{source.average_reward >= 0 ? "+" : ""}{source.average_reward.toFixed(2)}</span></div>
                  <div className="row"><span>Delta vs all</span><span>{formatSigned(deltaConfidenceVsAll * 100, 0, " pts")} · n {formatSigned(deltaSamplesVsAll, 0)}</span></div>
                  <div className="row"><span>Delta vs prev run</span><span>{formatSigned(deltaConfidenceVsPrevRun * 100, 0, " pts")} · n {formatSigned(deltaSamplesVsPrevRun, 0)}</span></div>
                  <div className="subtle mini">Window {snapshot.start_at ? `${formatDateTime(snapshot.start_at)} -> ${formatDateTime(snapshot.end_at)}` : `all replay -> ${formatDateTime(snapshot.end_at)}`}</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {multiplierEntries.map(([agent, value]) => (
                      <span key={`${label}-${agent}`} className={`chart-action-pill chart-action-pill-status ${value >= 1.02 ? "good" : value <= 0.75 ? "warn" : "neutral"}`}>
                        {agent} x{value.toFixed(2)}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </article>
      </section>

      <section className="grid" style={{ gridTemplateColumns: "1.15fr 1.85fr", gap: 16, marginTop: 16, alignItems: "start" }}>
        <article className="panel">
          <div className="eyebrow">History</div>
          <div className="subtle" style={{ marginBottom: 10 }}>Evolution de la confidence {formatSourceLabel(selectedSource)} par fenetre de recalcul.</div>
          <div style={{ display: "grid", gap: 10 }}>
            {selectedSourceHistory.map((series) => {
              const path = buildSparklinePath(series.points, 180, 28);
              const latest = series.points[series.points.length - 1] || 0;
              return (
                <div key={series.label} style={{ display: "grid", gap: 4 }}>
                  <div className="row"><span>{formatWindowLabel(series.label)}</span><span>{(latest * 100).toFixed(0)}%</span></div>
                  <svg viewBox="0 0 180 28" preserveAspectRatio="none" style={{ width: "100%", height: 28, borderRadius: 8, background: "rgba(15,23,42,0.18)" }}>
                    <path d={path} fill="none" stroke="#cfe9b9" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                </div>
              );
            })}
          </div>
        </article>

        <article className="panel">
          <div className="eyebrow">Recent Runs</div>
          <div className="subtle" style={{ marginBottom: 10 }}>Derniers snapshots offline avec comparaison rapide des fenetres sur {formatSourceLabel(selectedSource)}.</div>
          <div style={{ display: "grid", gap: 8 }}>
            {latestRuns.map((entry, index) => (
              <div key={`${entry.generated_at}-${index}`} style={{ borderTop: index === 0 ? "1px solid rgba(255,255,255,0.08)" : "1px solid rgba(255,255,255,0.05)", paddingTop: 8, display: "grid", gap: 6 }}>
                <div className="row"><strong>{formatDateTime(entry.generated_at)}</strong><span>{entry.row_count} rows</span></div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 8 }}>
                  {payload?.window_order.map((windowLabel) => {
                    const source = entry.windows[windowLabel]?.sources[selectedSource] || normalizeSourceSummary(null);
                    const previousRun = latestRuns[index + 1] || null;
                    const previousSource = previousRun?.windows[windowLabel]?.sources[selectedSource] || null;
                    const deltaVsPrevious = previousSource ? source.confidence - previousSource.confidence : 0;
                    return (
                      <div key={`${entry.generated_at}-${windowLabel}`} style={{ borderRadius: 10, padding: "8px 10px", background: "rgba(15,23,42,0.18)" }}>
                        <div className="row"><span>{formatWindowLabel(windowLabel)}</span><span>{(source.confidence * 100).toFixed(0)}%</span></div>
                        <div className="subtle mini">n {source.sample_count} · w {source.effective_sample_weight.toFixed(2)}</div>
                        <div className="subtle mini">delta prev {previousRun ? formatSigned(deltaVsPrevious * 100, 0, " pts") : "-"}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </article>
      </section>
    </main>
  );
}