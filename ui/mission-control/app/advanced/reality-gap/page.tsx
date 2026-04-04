"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import HelpHint from "../../../components/HelpHint";
import TxtMiniGuide from "../../../components/ui/TxtMiniGuide";

type JsonMap = Record<string, unknown>;

function asMap(value: unknown): JsonMap {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonMap : {};
}

function asList(value: unknown): JsonMap[] {
  return Array.isArray(value) ? value.filter((item): item is JsonMap => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}

function formatNumber(value: unknown, digits: number = 2): string {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(digits) : "-";
}

function formatTs(value: unknown): string {
  if (typeof value !== "string" || !value) return "-";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Date(timestamp).toLocaleString();
}

function formatRatio(value: unknown): string {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `${(numeric * 100).toFixed(1)}%` : "-";
}

function formatJson(value: unknown): string {
  if (value === null || value === undefined) return "{}";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function toneClass(metric: string, value: unknown): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "subtle";
  if (metric === "gap_fill_probability") {
    return numeric >= 0 ? "good" : Math.abs(numeric) <= 0.1 ? "subtle" : "warn";
  }
  return numeric <= 0 ? "good" : numeric < 10 ? "subtle" : "warn";
}

function metricDigits(label: string): number {
  return label.includes("Latency") ? 0 : label.includes("Fill") ? 3 : 2;
}

function metricDisplay(label: string, value: unknown): string {
  if (label.includes("Fill")) return formatRatio(value);
  return `${formatNumber(value, metricDigits(label))}${label.includes("Latency") ? "ms" : ""}`;
}

function StatChip({ label, value, tone = "subtle" }: { label: string; value: string; tone?: string }) {
  return (
    <div className="panel" style={{ padding: 10, display: "grid", gap: 4 }}>
      <span className="eyebrow">{label}</span>
      <strong className={tone}>{value}</strong>
    </div>
  );
}

function JsonDetails({ title, value, defaultOpen = false }: { title: string; value: unknown; defaultOpen?: boolean }) {
  return (
    <details open={defaultOpen} className="panel" style={{ padding: 12 }}>
      <summary style={{ cursor: "pointer", fontWeight: 600 }}>{title}</summary>
      <pre style={{ margin: "10px 0 0", whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 220, overflow: "auto" }}>
        {formatJson(value)}
      </pre>
    </details>
  );
}

export default function RealityGapPage() {
  const [samples, setSamples] = useState<JsonMap[]>([]);
  const [profiles, setProfiles] = useState<JsonMap[]>([]);
  const [selectedDecisionId, setSelectedDecisionId] = useState<string | null>(null);
  const [selectedSample, setSelectedSample] = useState<JsonMap | null>(null);
  const [selectedReplay, setSelectedReplay] = useState<JsonMap | null>(null);
  const [memorySummary, setMemorySummary] = useState<JsonMap | null>(null);
  const [selectedMemoryDecision, setSelectedMemoryDecision] = useState<JsonMap | null>(null);
  const [decisionQuery, setDecisionQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [memoryError, setMemoryError] = useState<string | null>(null);
  const [memoryDetailError, setMemoryDetailError] = useState<string | null>(null);

  const loadDecisionDetail = useCallback(async (decisionId: string) => {
    setDetailBusy(true);
    setDetailError(null);
    setMemoryDetailError(null);
    try {
      const [sampleResponse, replayResponse, memoryResponse] = await Promise.all([
        fetch(`/api/execution/reality-gap/${encodeURIComponent(decisionId)}`, { cache: "no-store" }),
        fetch(`/api/execution/replay/${encodeURIComponent(decisionId)}`, { cache: "no-store" }),
        fetch(`/api/predictor/memory-v2/decision/${encodeURIComponent(decisionId)}`, { cache: "no-store" }),
      ]);
      if (!sampleResponse.ok || !replayResponse.ok) {
        throw new Error("Impossible de charger le detail de la decision");
      }
      const samplePayload = asMap(await sampleResponse.json());
      const replayPayload = asMap(await replayResponse.json());
      setSelectedSample(asMap(samplePayload.sample));
      setSelectedReplay(replayPayload);
      if (memoryResponse.ok) {
        setSelectedMemoryDecision(asMap(await memoryResponse.json()));
      } else {
        setSelectedMemoryDecision(null);
        if (memoryResponse.status !== 404) {
          setMemoryDetailError("Memory V2 indisponible pour cette decision");
        }
      }
    } catch (loadError) {
      setDetailError(loadError instanceof Error ? loadError.message : "Erreur detail inconnue");
      setSelectedSample(null);
      setSelectedReplay(null);
      setSelectedMemoryDecision(null);
    } finally {
      setDetailBusy(false);
    }
  }, []);

  const loadData = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const [samplesResponse, profilesResponse, memoryResponse] = await Promise.all([
        fetch("/api/execution/reality-gap/recent?limit=24", { cache: "no-store" }),
        fetch("/api/execution/reality-gap/profiles?limit=24", { cache: "no-store" }),
        fetch("/api/predictor/memory-v2", { cache: "no-store" }),
      ]);
      if (!samplesResponse.ok || !profilesResponse.ok) {
        throw new Error("Impossible de charger la vue Reality Gap");
      }
      const samplesPayload = asMap(await samplesResponse.json());
      const profilesPayload = asMap(await profilesResponse.json());
      const nextSamples = asList(samplesPayload.rows);
      const nextProfiles = asList(profilesPayload.rows);
      setSamples(nextSamples);
      setProfiles(nextProfiles);
      if (memoryResponse.ok) {
        setMemorySummary(asMap(await memoryResponse.json()));
        setMemoryError(null);
      } else {
        setMemorySummary(null);
        setMemoryError("Memory V2 summary indisponible");
      }
      const activeDecisionId = selectedDecisionId && nextSamples.some((sample) => String(sample.decision_id || "") === selectedDecisionId)
        ? selectedDecisionId
        : String(nextSamples[0]?.decision_id || "") || null;
      setSelectedDecisionId(activeDecisionId);
      setDecisionQuery(activeDecisionId || "");
      if (activeDecisionId) {
        await loadDecisionDetail(activeDecisionId);
      } else {
        setSelectedSample(null);
        setSelectedReplay(null);
        setSelectedMemoryDecision(null);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Erreur inconnue");
    } finally {
      setBusy(false);
    }
  }, [loadDecisionDetail, selectedDecisionId]);

  useEffect(() => {
    let mounted = true;
    const refresh = async () => {
      if (!mounted) return;
      await loadData();
    };
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 15_000);
    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
  }, [loadData]);

  const latestSample = samples[0] || null;
  const latestProfile = profiles[0] || null;
  const predictedExecution = asMap(selectedSample?.predicted_execution);
  const realizedExecution = asMap(selectedSample?.realized_execution);
  const samplePayload = asMap(selectedSample?.payload);
  const replayTelemetry = asMap(selectedReplay?.telemetry);
  const replayPayload = asMap(replayTelemetry.payload);
  const replayFills = asList(selectedReplay?.fills);
  const replayPreTradeMemoryGate = asMap(selectedReplay?.pre_trade_memory_gate || replayPayload.pre_trade_memory_gate);
  const replayKairosHarness = asMap(selectedReplay?.kairos_harness || replayPayload.kairos_harness);
  const replayBrain = asMap(selectedReplay?.brain_replay);
  const samplePredicted = asMap(latestSample?.predicted_execution);
  const sampleRealized = asMap(latestSample?.realized_execution);
  const memorySummaryPayload = asMap(memorySummary);
  const topSemanticContexts = asList(memorySummaryPayload.top_semantic_contexts);
  const topCausalPatterns = asList(memorySummaryPayload.top_causal_patterns);
  const selectedMemoryPayload = asMap(selectedMemoryDecision);
  const memoryResolution = asMap(selectedMemoryPayload.resolution);
  const memoryBaseExperience = asMap(selectedMemoryPayload.base_experience);
  const memoryEpisodeLookup = asMap(selectedMemoryPayload.episode_lookup);
  const memoryEpisode = asMap(memoryEpisodeLookup.episode);
  const memoryContextLookup = asMap(selectedMemoryPayload.context_lookup);
  const memorySemanticMatch = asMap(memoryContextLookup.semantic_match);
  const memoryCausalMatch = asMap(memoryContextLookup.causal_match);
  const memoryRecommendation = asMap(memoryContextLookup.recommendation);
  const memoryRelatedExperiences = asList(selectedMemoryPayload.related_experiences);
  const comparisonRows: Array<[string, unknown, unknown, unknown]> = [
    ["Slippage", predictedExecution.slippage_bps, realizedExecution.slippage_bps, selectedSample?.gap_slippage_bps],
    ["Fill probability", predictedExecution.fill_probability, realizedExecution.fill_probability, selectedSample?.gap_fill_probability],
    ["Fill ratio", predictedExecution.fill_ratio, realizedExecution.fill_ratio, null],
    ["Latency delta", predictedExecution.latency_ms, realizedExecution.latency_ms, selectedSample?.gap_latency_ms],
    ["Impact", predictedExecution.impact_bps, realizedExecution.impact_bps, selectedSample?.gap_impact_bps],
    ["Queue ahead", predictedExecution.queue_ahead_qty, realizedExecution.queue_ahead_qty, selectedSample?.gap_queue_ahead_qty],
  ];

  return (
    <main className="shell txt-page-shell">
      <section className="hero txt-page-hero-grid" style={{ gridTemplateColumns: "1.2fr 0.9fr", gap: 14 }}>
        <div className="panel txt-page-hero">
          <div className="eyebrow">Reality Gap <HelpHint text="Compare prediction d'execution vs realise, puis montre la calibration appliquee au profil." examples={["Si la latence reelle depasse souvent la prediction, le multiplicateur de jitter doit monter.", "Si le fill ratio reel tombe sous la prediction, surveille partial_fill_risk_delta et queue_risk_delta."]} /></div>
          <h1 className="title" style={{ fontSize: 30, marginBottom: 8 }}>Recent Samples & Profiles</h1>
          <p className="subtle" style={{ marginBottom: 12 }}>Vue ops dense pour suivre le flux reality-gap, verifier l'auto-ingestion post-trade et lire rapidement le diff predicted vs realized.</p>
          <TxtMiniGuide
            title="Guide Reality Gap"
            what="Mesure l'ecart entre execution predite et execution realisee."
            why="Transformer les replays post-trade en calibration exploitable par le predicteur et le moteur d'execution."
            example="Quand gap latency et gap impact montent ensemble, le profil du venue devient plus conservateur."
            terms={["slippage", "fill ratio", "queue risk"]}
          />
          <div className="grid" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10, marginTop: 12 }}>
            <StatChip label="Samples" value={String(samples.length)} />
            <StatChip label="Profiles" value={String(profiles.length)} />
            <StatChip label="Decision active" value={selectedDecisionId || "-"} />
            <StatChip label="Artifact" value={samplePayload.rust_reality_gap ? "native" : "replay-only"} tone={samplePayload.rust_reality_gap ? "good" : "subtle"} />
          </div>
          <p style={{ marginTop: 12, marginBottom: 0 }}>
            <Link href="/advanced">Advanced</Link>
            {" | "}
            <Link href="/advanced/predictor-calibration">Predictor Calibration</Link>
            {" | "}
            <Link href="/terminal">Terminal</Link>
          </p>
          {error ? <p className="warn">{error}</p> : null}
        </div>
        <div className="panel">
          <div className="eyebrow">Etat du Flux</div>
          <div className="row"><span>Samples charges</span><span>{samples.length}</span></div>
          <div className="row"><span>Profiles charges</span><span>{profiles.length}</span></div>
          <div className="row"><span>Derniere decision</span><span>{String(latestSample?.decision_id || "-")}</span></div>
          <div className="row"><span>Dernier profil</span><span>{String(latestProfile?.profile_key || "-")}</span></div>
          <div className="row"><span>Mode</span><span>{busy ? "refresh" : "live"}</span></div>
          <div className="row"><span>Derniere calibration</span><span>{String(latestSample?.calibration_action || "-")}</span></div>
          <div className="row"><span>Rust artifact</span><span>{samplePayload.rust_reality_gap ? "native" : "replay-only"}</span></div>
          <button type="button" onClick={() => void loadData()} disabled={busy}>{busy ? "Refresh..." : "Refresh now"}</button>
        </div>
      </section>

      <section className="grid" style={{ gridTemplateColumns: "1.35fr 0.95fr", marginBottom: 14, gap: 14 }}>
        <div className="panel">
          <div className="eyebrow">Recent Samples</div>
          <div className="subtle" style={{ display: "grid", gridTemplateColumns: "1.35fr 0.7fr 0.8fr 0.8fr 0.9fr 1fr", gap: 10, padding: "0 10px 6px" }}>
            <span>Decision</span>
            <span>Regime</span>
            <span>Slip</span>
            <span>Fill</span>
            <span>Latency delta</span>
            <span>Action</span>
          </div>
          <div className="table-like" style={{ display: "grid", gap: 6, maxHeight: 430, overflow: "auto" }}>
            {samples.map((sample) => (
              <button
                key={String(sample.sample_id)}
                type="button"
                className="row"
                onClick={() => {
                  const nextDecisionId = String(sample.decision_id || "");
                  setSelectedDecisionId(nextDecisionId);
                  setDecisionQuery(nextDecisionId);
                  void loadDecisionDetail(nextDecisionId);
                }}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1.35fr 0.7fr 0.8fr 0.8fr 0.9fr 1fr",
                  gap: 10,
                  alignItems: "start",
                  textAlign: "left",
                  border: String(sample.decision_id || "") === selectedDecisionId ? "1px solid rgba(255,255,255,0.35)" : undefined,
                  borderRadius: 12,
                  padding: "8px 10px",
                }}
              >
                <div>
                  <strong>{String(sample.decision_id || "-")}</strong>
                  <div className="subtle">{String(sample.symbol || "-")} · {String(sample.venue || "-")}</div>
                </div>
                <span>{String(sample.regime || "-")}</span>
                <span className={toneClass("gap_slippage_bps", sample.gap_slippage_bps)}>slip {formatNumber(sample.gap_slippage_bps)}</span>
                <span className={toneClass("gap_fill_probability", sample.gap_fill_probability)}>fill {formatNumber(sample.gap_fill_probability, 3)}</span>
                <span className={toneClass("gap_latency_ms", sample.gap_latency_ms)}>delta {formatNumber(sample.gap_latency_ms, 0)}ms</span>
                <div>
                  <strong>{String(sample.calibration_action || "-")}</strong>
                  <div className="subtle">{formatTs(sample.created_at)}</div>
                </div>
              </button>
            ))}
            {samples.length === 0 ? <div className="subtle">Aucun sample reality-gap recent.</div> : null}
          </div>
        </div>

        <div className="panel">
          <div className="eyebrow">Latest Sample Detail</div>
          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <StatChip label="Decision" value={String(latestSample?.decision_id || "-")} />
            <StatChip label="Failure" value={String(latestSample?.failure_source || "none")} />
            <StatChip label="Gap impact" value={formatNumber(latestSample?.gap_impact_bps)} tone={toneClass("gap_impact_bps", latestSample?.gap_impact_bps)} />
            <StatChip label="Gap queue" value={formatNumber(latestSample?.gap_queue_ahead_qty)} tone={toneClass("gap_queue_ahead_qty", latestSample?.gap_queue_ahead_qty)} />
            <StatChip label="Predicted" value={`${formatNumber(samplePredicted.slippage_bps)}/${formatNumber(samplePredicted.latency_ms, 0)}ms`} />
            <StatChip label="Realized" value={`${formatNumber(sampleRealized.slippage_bps)}/${formatNumber(sampleRealized.latency_ms, 0)}ms`} />
          </div>
        </div>
      </section>

      <section className="grid" style={{ gridTemplateColumns: "1.05fr 0.95fr", marginBottom: 14, gap: 14 }}>
        <div className="panel">
          <div className="eyebrow">Decision Drill-down</div>
          <div className="grid" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10, marginBottom: 12 }}>
            <StatChip label="Selection" value={selectedDecisionId || "-"} />
            <StatChip label="Venue" value={String(selectedSample?.venue || "-")} />
            <StatChip label="Replay fills" value={String(replayFills.length || 0)} />
            <StatChip label="Detail mode" value={detailBusy ? "refresh" : "ready"} tone={detailBusy ? "warn" : "good"} />
          </div>
          <div className="row"><span>Symbol</span><span>{String(selectedSample?.symbol || "-")}</span></div>
          <div className="row"><span>Failure source</span><span>{String(selectedSample?.failure_source || "none")}</span></div>
          <div className="row"><span>Calibration</span><span>{String(selectedSample?.calibration_action || "-")}</span></div>
          {detailError ? <p className="warn">{detailError}</p> : null}
          <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            <input
              type="text"
              value={decisionQuery}
              onChange={(event) => setDecisionQuery(event.target.value)}
              placeholder="decision_id precise"
              style={{ flex: "1 1 280px", minWidth: 220 }}
            />
            <button
              type="button"
              onClick={() => {
                const nextDecisionId = decisionQuery.trim();
                if (!nextDecisionId) {
                  return;
                }
                setSelectedDecisionId(nextDecisionId);
                void loadDecisionDetail(nextDecisionId);
              }}
            >
              Explore decision_id
            </button>
          </div>
          <div className="panel" style={{ padding: 12, marginTop: 12 }}>
            <div className="subtle" style={{ display: "grid", gridTemplateColumns: "1.1fr 1fr 1fr 0.8fr", gap: 10, paddingBottom: 6 }}>
              <span>Metric</span>
              <span>Predicted</span>
              <span>Realized</span>
              <span>Gap</span>
            </div>
            <div style={{ display: "grid", gap: 6 }}>
              {comparisonRows.map(([label, predicted, realized, gap]) => (
                <div key={String(label)} className="row" style={{ display: "grid", gridTemplateColumns: "1.1fr 1fr 1fr 0.8fr", gap: 10, alignItems: "center" }}>
                  <strong>{String(label)}</strong>
                  <span>{metricDisplay(String(label), predicted)}</span>
                  <span>{metricDisplay(String(label), realized)}</span>
                  <span className={gap === null ? "subtle" : toneClass(`gap_${String(label).toLowerCase().replace(/\s+/g, "_")}`, gap)}>{gap === null ? "-" : metricDisplay(String(label), gap)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="panel">
          <div className="eyebrow">Replay Detail</div>
          <div className="row"><span>Route chosen</span><span>{String(replayTelemetry.route_chosen || "-")}</span></div>
          <div className="row"><span>Route reason</span><span>{String(replayTelemetry.route_reason || "-")}</span></div>
          <div className="row"><span>Expected slip</span><span>{formatNumber(replayTelemetry.expected_slippage_bps)}</span></div>
          <div className="row"><span>Realized slip</span><span>{formatNumber(replayTelemetry.realized_slippage_bps)}</span></div>
          <div className="row"><span>E2E latency</span><span>{formatNumber(replayTelemetry.latency_e2e_ms, 0)}ms</span></div>
          <div className="row"><span>Memory gate</span><span>{String(replayPreTradeMemoryGate.status || "-")}</span></div>
          <div className="row"><span>Gate blocking</span><span>{Object.keys(replayPreTradeMemoryGate).length ? (replayPreTradeMemoryGate.block_execution ? "yes" : "no") : "-"}</span></div>
          <div className="row"><span>Kairos harness</span><span>{Object.keys(replayKairosHarness).length ? String(replayKairosHarness.mode || "present") : "live execution"}</span></div>
          <div className="row"><span>Validation source</span><span>{Object.keys(replayKairosHarness).length ? String(replayKairosHarness.validation_source || "-") : "-"}</span></div>
          <div className="row"><span>Brain regime</span><span>{String(replayBrain.regime || samplePayload.regime || "-")}</span></div>
          <div className="row"><span>Rust artifact</span><span>{samplePayload.rust_reality_gap ? "native" : "replay-only"}</span></div>
          <div className="panel" style={{ marginTop: 12, padding: 12 }}>
            <div className="eyebrow">Replay Fills</div>
            <div style={{ display: "grid", gap: 6 }}>
              {replayFills.slice(0, 6).map((fill, index) => (
                <article key={String(fill.fill_id || index)} className="row" style={{ display: "grid", gridTemplateColumns: "0.9fr 0.8fr 0.9fr 1.2fr", gap: 10 }}>
                  <span>{String(fill.venue || "-")}</span>
                  <span>{formatNumber(fill.price, 4)}</span>
                  <span>{formatNumber(fill.notional_usd, 2)} USD</span>
                  <span>{formatTs(fill.filled_at)}</span>
                </article>
              ))}
              {replayFills.length === 0 ? <div className="subtle">Aucun fill capture pour cette decision.</div> : null}
            </div>
          </div>
          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
            <JsonDetails title="Predicted Metadata" value={predictedExecution.metadata} />
            <JsonDetails title="Realized Metadata" value={realizedExecution.metadata} />
          </div>
          <div style={{ marginTop: 12 }}>
            <JsonDetails title="Pre-trade Memory Gate" value={replayPreTradeMemoryGate} defaultOpen />
          </div>
          <div style={{ marginTop: 12 }}>
            <JsonDetails title="Kairos Harness" value={replayKairosHarness} defaultOpen={Object.keys(replayKairosHarness).length > 0} />
          </div>
          <div style={{ marginTop: 12 }}>
            <JsonDetails title="Replay Payload" value={{
              kairos_harness: replayKairosHarness,
              pre_trade_memory_gate: replayPreTradeMemoryGate,
              telemetry_payload: replayPayload,
              brain_replay: replayBrain,
              sample_payload: samplePayload,
            }} />
          </div>
        </div>
      </section>

      <section className="grid" style={{ gridTemplateColumns: "1fr", marginBottom: 16 }}>
        <div className="panel">
          <div className="eyebrow">Calibration Profiles</div>
          <div className="subtle" style={{ display: "grid", gridTemplateColumns: "1.4fr 0.6fr 1fr 1fr 1fr", gap: 10, padding: "0 10px 6px" }}>
            <span>Profile</span>
            <span>Samples</span>
            <span>Latency</span>
            <span>Impact</span>
            <span>Queue</span>
          </div>
          <div className="table-like" style={{ display: "grid", gap: 6 }}>
            {profiles.map((profile) => {
              const calibration = asMap(profile.calibration);
              const adjustment = asMap(calibration.adjustment_factors);
              return (
                <article key={String(profile.profile_key)} className="row" style={{ display: "grid", gridTemplateColumns: "1.4fr 0.6fr 1fr 1fr 1fr", gap: 10, alignItems: "start", padding: "8px 10px" }}>
                  <div>
                    <strong>{String(profile.profile_key || "-")}</strong>
                    <div className="subtle">updated {formatTs(profile.updated_at)}</div>
                  </div>
                  <span>n={String(profile.sample_count || 0)}</span>
                  <span>lat x{formatNumber(adjustment.latency_jitter_multiplier, 2)}</span>
                  <span>impact x{formatNumber(adjustment.impact_multiplier, 2)}</span>
                  <span>queue +{formatNumber(adjustment.queue_risk_delta, 2)}</span>
                </article>
              );
            })}
            {profiles.length === 0 ? <div className="subtle">Aucun profil reality-gap calibre.</div> : null}
          </div>
        </div>
      </section>

      <section className="grid" style={{ gridTemplateColumns: "0.9fr 1.1fr", marginBottom: 16, gap: 14 }}>
        <div className="panel">
          <div className="eyebrow">Memory V2 Overview</div>
          <div className="grid" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10, marginBottom: 12 }}>
            <StatChip label="Short term" value={String(memorySummaryPayload.short_term_count || 0)} />
            <StatChip label="Episodic" value={String(memorySummaryPayload.episodic_count || 0)} />
            <StatChip label="Semantic" value={String(memorySummaryPayload.semantic_count || 0)} />
            <StatChip label="Causal" value={String(memorySummaryPayload.causal_count || 0)} />
          </div>
          {memoryError ? <p className="warn">{memoryError}</p> : null}
          <div className="panel" style={{ padding: 12, marginBottom: 12 }}>
            <div className="eyebrow">Top Semantic Contexts</div>
            <div style={{ display: "grid", gap: 6 }}>
              {topSemanticContexts.slice(0, 4).map((item, index) => (
                <article key={String(item.context_key || index)} className="row" style={{ display: "grid", gridTemplateColumns: "1.35fr 0.75fr 0.85fr", gap: 10, padding: "8px 10px" }}>
                  <div>
                    <strong>{String(item.best_action || "hold")}</strong>
                    <div className="subtle">{String(item.context_key || "-")}</div>
                  </div>
                  <span>{String(item.sample_count || 0)} samples</span>
                  <span className={toneClass("gap_fill_probability", item.avg_reward)}>{formatNumber(item.avg_reward, 3)}</span>
                </article>
              ))}
              {topSemanticContexts.length === 0 ? <div className="subtle">Aucun contexte semantic dominant.</div> : null}
            </div>
          </div>
          <div className="panel" style={{ padding: 12 }}>
            <div className="eyebrow">Top Causal Patterns</div>
            <div style={{ display: "grid", gap: 6 }}>
              {topCausalPatterns.slice(0, 4).map((item, index) => {
                const correction = asMap(item.correction);
                return (
                  <article key={String(item.causal_key || index)} className="row" style={{ display: "grid", gridTemplateColumns: "1.15fr 0.8fr 0.95fr", gap: 10, padding: "8px 10px" }}>
                    <div>
                      <strong>{String(item.failure_source || "none")}</strong>
                      <div className="subtle">{String(item.context_key || "-")}</div>
                    </div>
                    <span>{String(item.failure_sample_count || 0)} fail</span>
                    <span>{String(correction.strategy_mode || correction.execution_style || "-")}</span>
                  </article>
                );
              })}
              {topCausalPatterns.length === 0 ? <div className="subtle">Aucun pattern causal dominant.</div> : null}
            </div>
          </div>
        </div>

        <div className="panel">
          <div className="eyebrow">Decision Memory V2</div>
          <div className="grid" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10, marginBottom: 12 }}>
            <StatChip label="Decision" value={selectedDecisionId || "-"} />
            <StatChip label="Resolution" value={String(memoryResolution.source || "-")} tone={memoryResolution.source ? "good" : "subtle"} />
            <StatChip label="Base experience" value={String(memoryResolution.base_experience_id || "-")} />
            <StatChip label="Matched rows" value={String(memoryResolution.matched_rows || 0)} />
          </div>
          {memoryDetailError ? <p className="subtle">{memoryDetailError}</p> : null}
          <div className="row"><span>Failure source</span><span>{String(memoryResolution.failure_source || memoryBaseExperience.failure_source || "none")}</span></div>
          <div className="row"><span>Base reward</span><span>{formatNumber(memoryBaseExperience.reward, 3)}</span></div>
          <div className="row"><span>Query source</span><span>{String(memoryContextLookup.source || "-")}</span></div>
          <div className="row"><span>Confidence</span><span>{formatNumber(memoryContextLookup.confidence, 3)}</span></div>
          <div className="row"><span>Semantic key</span><span>{String(memoryContextLookup.semantic_key || "-")}</span></div>
          <div className="row"><span>Causal key</span><span>{String(memoryContextLookup.causal_key || "-")}</span></div>
          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
            <JsonDetails title="Episode Lookup" value={memoryEpisode} />
            <JsonDetails title="Recommended Correction" value={memoryRecommendation} defaultOpen />
          </div>
          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
            <JsonDetails title="Semantic Match" value={memorySemanticMatch} />
            <JsonDetails title="Causal Match" value={memoryCausalMatch} />
          </div>
          <div className="panel" style={{ padding: 12, marginTop: 12 }}>
            <div className="eyebrow">Related Experiences</div>
            <div style={{ display: "grid", gap: 6 }}>
              {memoryRelatedExperiences.slice(0, 6).map((item, index) => (
                <article key={String(item.experience_id || index)} className="row" style={{ display: "grid", gridTemplateColumns: "1.25fr 0.7fr 0.7fr 0.8fr", gap: 10, padding: "8px 10px" }}>
                  <div>
                    <strong>{String(item.experience_id || "-")}</strong>
                    <div className="subtle">{String(item.synthetic ? item.dream_source || "synthetic" : item.regime || "real")}</div>
                  </div>
                  <span>{String(item.action || "-")}</span>
                  <span className={toneClass("gap_fill_probability", item.reward)}>{formatNumber(item.reward, 3)}</span>
                  <span>{String(item.failure_source || "none")}</span>
                </article>
              ))}
              {memoryRelatedExperiences.length === 0 ? <div className="subtle">Aucune experience reliee retrouvee.</div> : null}
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}