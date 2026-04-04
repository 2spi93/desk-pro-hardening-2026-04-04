"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import HelpHint from "../../components/HelpHint";
import TxtMiniGuide from "../../components/ui/TxtMiniGuide";

type JsonMap = Record<string, unknown>;

function formatFreshness(value: unknown): string {
  const freshnessMs = Number(value);
  if (!Number.isFinite(freshnessMs) || freshnessMs < 0) {
    return "n/a";
  }
  if (freshnessMs <= 1000) {
    return `${Math.round(freshnessMs)}ms`;
  }
  if (freshnessMs <= 60_000) {
    return `${Math.round(freshnessMs / 1000)}s`;
  }
  if (freshnessMs <= 3_600_000) {
    return `${Math.round(freshnessMs / 60_000)}m`;
  }
  return `${Math.round(freshnessMs / 3_600_000)}h`;
}

function classifyFreshness(value: unknown): "fresh" | "stale" | "degraded" | "hard-fail" {
  const freshnessMs = Number(value);
  if (!Number.isFinite(freshnessMs) || freshnessMs < 0) {
    return "hard-fail";
  }
  if (freshnessMs <= 15_000) {
    return "fresh";
  }
  if (freshnessMs <= 60_000) {
    return "stale";
  }
  if (freshnessMs <= 180_000) {
    return "degraded";
  }
  return "hard-fail";
}

function pillTone(level: "fresh" | "stale" | "degraded" | "hard-fail" | "ok"): string {
  if (level === "fresh" || level === "ok") {
    return "good";
  }
  if (level === "stale") {
    return "warn";
  }
  return "bad";
}

export default function LiveReadinessPage() {
  const [overview, setOverview] = useState<JsonMap | null>(null);
  const [thresholds, setThresholds] = useState<JsonMap[]>([]);
  const [marketBusSnapshot, setMarketBusSnapshot] = useState<JsonMap | null>(null);
  const [healthwatchDashboard, setHealthwatchDashboard] = useState<JsonMap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [regime, setRegime] = useState("trend");
  const [minSamples, setMinSamples] = useState(25);
  const [minWinRate, setMinWinRate] = useState(0.52);
  const [maxDrawdown, setMaxDrawdown] = useState(1000);
  const [maxAvgLoss, setMaxAvgLoss] = useState(140);

  async function loadData(): Promise<void> {
    const [readinessRes, thresholdRes, marketBusRes, healthwatchRes] = await Promise.all([
      fetch("/api/live-readiness/overview", { cache: "no-store" }),
      fetch("/api/strategies/drift-thresholds", { cache: "no-store" }),
      fetch("/api/market/bus/snapshot?instrument=BTCUSDT&venue=binance-public&timeframe=1m&lookback_minutes=60&trade_limit=200", { cache: "no-store" }),
      fetch("/api/system/healthwatch/dashboard", { cache: "no-store" }),
    ]);
    if (!readinessRes.ok || !thresholdRes.ok) {
      throw new Error("Impossible de charger la vue Live Readiness");
    }
    setOverview(await readinessRes.json());
    const thresholdsPayload = await thresholdRes.json();
    setThresholds((thresholdsPayload.items as JsonMap[] | undefined) || []);
    setMarketBusSnapshot(marketBusRes.ok ? await marketBusRes.json() : null);
    setHealthwatchDashboard(healthwatchRes.ok ? await healthwatchRes.json() : null);
    setError(null);
  }

  useEffect(() => {
    let mounted = true;
    const refresh = () => {
      loadData().catch((err) => {
        if (mounted) {
          setError(err instanceof Error ? err.message : "Erreur inconnue");
        }
      });
    };
    refresh();
    const timer = window.setInterval(refresh, 15_000);
    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
  }, []);

  async function saveThreshold(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/strategies/drift-thresholds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          regime,
          min_samples: minSamples,
          min_win_rate: minWinRate,
          max_drawdown_usd: maxDrawdown,
          max_avg_loss_usd: maxAvgLoss,
        }),
      });
      if (!response.ok) {
        const payload = await response.json();
        throw new Error(String(payload?.detail || "Sauvegarde seuils echouee"));
      }
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur inconnue");
    } finally {
      setBusy(false);
    }
  }

  const memoryKpi = (overview?.memory_kpi as JsonMap | undefined) || {};
  const memorySummary = (memoryKpi.summary as JsonMap | undefined) || {};
  const drift = (overview?.drift as JsonMap | undefined) || {};
  const driftItems = (drift.items as JsonMap[] | undefined) || [];
  const suspended = (drift.suspended_strategies as JsonMap[] | undefined) || [];
  const autoResume = (drift.auto_resume as JsonMap | undefined) || {};
  const ab = (overview?.memory_ab as JsonMap | undefined) || {};
  const abArms = (ab.arms as JsonMap[] | undefined) || [];
  const withVsWithout = (ab.with_vs_without_memory as JsonMap | undefined) || {};
  const marketBusMeta = (marketBusSnapshot?.meta as JsonMap | undefined) || {};
  const marketBusHealth = (marketBusMeta.health as JsonMap | undefined) || {};
  const marketBusComponents = (marketBusHealth.components as JsonMap | undefined) || {};
  const marketBusOhlcv = (marketBusComponents.ohlcv as JsonMap | undefined) || {};
  const marketBusDepth = (marketBusComponents.depth as JsonMap | undefined) || {};
  const marketBusTrades = (marketBusComponents.trades as JsonMap | undefined) || {};
  const marketBusSequencing = (marketBusMeta.sequencing as JsonMap | undefined) || {};
  const marketBusOhlcvSeq = (marketBusSequencing.ohlcv as JsonMap | undefined) || {};
  const ohlcvState = classifyFreshness(marketBusOhlcv.freshness_ms);
  const depthState = classifyFreshness(marketBusDepth.freshness_ms);
  const tradesState = classifyFreshness(marketBusTrades.freshness_ms);
  const readinessAlerts = [
    { label: "bars", state: ohlcvState, age: formatFreshness(marketBusOhlcv.freshness_ms) },
    { label: "depth", state: depthState, age: formatFreshness(marketBusDepth.freshness_ms) },
    { label: "trades", state: tradesState, age: formatFreshness(marketBusTrades.freshness_ms) },
  ].filter((item) => item.state !== "fresh");
  const healthwatchState = (healthwatchDashboard?.healthwatch as JsonMap | undefined) || {};
  const chartOfflineCapture = (healthwatchDashboard?.chart_offline_capture as JsonMap | undefined) || {};
  const publicChartVisibility = (healthwatchDashboard?.public_chart_visibility as JsonMap | undefined) || {};
  const publicChartEarly = (publicChartVisibility.early as JsonMap | undefined) || {};
  const publicChartSettled = (publicChartVisibility.settled as JsonMap | undefined) || {};
  const publicSignalAlignment = (chartOfflineCapture.public_signal_alignment as JsonMap | undefined) || {};
  const advisoryReasons = (chartOfflineCapture.advisory_reasons as string[] | undefined) || [];
  const offlineReasons = (chartOfflineCapture.offline_reasons as string[] | undefined) || [];

  return (
    <main className="shell txt-page-shell">
      <section className="hero txt-page-hero-grid" style={{ gridTemplateColumns: "1.4fr 1fr" }}>
        <div className="panel txt-page-hero">
          <div className="eyebrow">Live Readiness Center <HelpHint text="Vue operationnelle: KPI memoire, derive strategie, auto-suspension et A/B live." examples={["Avant toute activation live, regarde d'abord Strategies suspendues, Drift detecte et A/B memory.", "Si un bloc est rouge ou instable, traite le probleme avant d'augmenter l'exposition."]} /></div>
          <h1 className="title" style={{ fontSize: 34 }}>Readiness, Drift, Memory A/B</h1>
          <p className="subtle">Calibration V3 en boucle fermee: mesure, derive, suspension auto, comparaison memory ON/OFF.</p>
          <TxtMiniGuide
            title="Guide Readiness"
            what="Indicateurs de derive, calibration et suspension automatique des strategies."
            why="Savoir si le systeme est vraiment pret avant d'augmenter le risque en live."
            example="Si plusieurs strategies sont suspendues et le drift grimpe, reduis l'exposition et investigate."
            terms={["brier", "metaRisk", "allocation"]}
          />
          <p>
            <Link href="/">Dashboard</Link>
            {" | "}
            <Link href="/terminal">Trading Terminal</Link>
            {" | "}
            <Link href="/ai">IA</Link>
            {" | "}
            <Link href="/connectors">Connecteurs</Link>
            {" | "}
            <Link href="/incidents">Incidents</Link>
          </p>
          {error ? <p className="warn">{error}</p> : null}
        </div>
        <div className="panel">
          <div className="eyebrow">Etat Global <HelpHint text="Signaux critiques pour autoriser/retarder le passage live." examples={["Si Strategies suspendues > 0, n'ouvre pas plus de risque tant que ce n'est pas compris.", "Si Retrieval avg impact est faible ou negatif, la memoire apporte peu de valeur actuellement."]} /></div>
          <div className="row"><span>Strategies suspendues</span><span className={suspended.length > 0 ? "warn" : "good"}>{String(suspended.length)}</span></div>
          <div className="row"><span>Drift detecte (lignes)</span><span>{String(driftItems.filter((x) => Boolean(x.drift_detected)).length)}</span></div>
          <div className="row"><span>Retrieval avg final sim</span><span>{String(memorySummary.avg_final_similarity || "-")}</span></div>
          <div className="row"><span>Retrieval avg impact</span><span>{String(memorySummary.avg_memory_impact || "-")}</span></div>
          <div className="row"><span>Auto-resume</span><span>{String(autoResume.enabled ?? false)}</span></div>
          <div className="row"><span>Cooldown (h)</span><span>{String(autoResume.cooldown_hours ?? "-")}</span></div>
        </div>
      </section>

      <section className="grid" style={{ gridTemplateColumns: "1fr", marginBottom: 16 }}>
        <div className="panel">
          <div className="eyebrow">Market Data Bus <HelpHint text="Observabilite homogene du bus marche partage par chart, AI et execution." examples={["Si bars ou depth passent en hard-fail, considere le terminal comme degrade et reduis l'exposition.", "SEQ GAP signifie un probleme de continuite OHLCV meme si le flux n'est pas totalement coupe."]} /></div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10, marginBottom: 10 }}>
            <span className={`chart-flow-pill tone-${pillTone(String(marketBusHealth.status || "hard-fail") === "ok" ? "ok" : "degraded")}`}>BUS {String(marketBusHealth.status || "offline").toUpperCase()}</span>
            <span className={`chart-flow-pill tone-${pillTone(ohlcvState)}`}>BARS {ohlcvState.toUpperCase()} {formatFreshness(marketBusOhlcv.freshness_ms)}</span>
            <span className={`chart-flow-pill tone-${pillTone(depthState)}`}>DEPTH {depthState.toUpperCase()} {formatFreshness(marketBusDepth.freshness_ms)}</span>
            <span className={`chart-flow-pill tone-${pillTone(tradesState)}`}>TRADES {tradesState.toUpperCase()} {formatFreshness(marketBusTrades.freshness_ms)}</span>
            <span className={`chart-flow-pill tone-${Boolean(marketBusOhlcvSeq.contiguous) ? "good" : "warn"}`}>SEQ {Boolean(marketBusOhlcvSeq.contiguous) ? "OK" : "GAP"} #{String(marketBusOhlcvSeq.latest_seq || "-")}</span>
            <span className="chart-flow-pill tone-neutral">BOOK {String(((marketBusSequencing.depth as JsonMap | undefined) || {}).last_update_id || "-")}</span>
          </div>
          {readinessAlerts.length > 0 ? (
            <div className="warn" style={{ marginBottom: 10 }}>
              Alertes fraicheur: {readinessAlerts.map((item) => `${item.label}:${item.state}@${item.age}`).join(" · ")}
            </div>
          ) : (
            <div className="good" style={{ marginBottom: 10 }}>Bus marche dans les bornes operationnelles.</div>
          )}
          <div className="row"><span>Instrument de reference</span><span>{String(marketBusSnapshot?.instrument || "BTCUSDT")}</span></div>
          <div className="row"><span>Venue</span><span>{String(marketBusSnapshot?.venue || "binance-public")}</span></div>
          <div className="row"><span>Dernier sync</span><span>{String(marketBusSnapshot?.as_of || "-")}</span></div>
          <div className="row"><span>OHLCV latest seq</span><span>{String(marketBusOhlcvSeq.latest_seq || "-")}</span></div>
          <div className="row"><span>OHLCV contiguous</span><span className={Boolean(marketBusOhlcvSeq.contiguous) ? "good" : "warn"}>{String(Boolean(marketBusOhlcvSeq.contiguous))}</span></div>
        </div>
      </section>

      <section className="grid" style={{ gridTemplateColumns: "1fr 1fr", marginBottom: 16 }}>
        <div className="panel">
          <div className="eyebrow">Healthwatch Chart Capture <HelpHint text="Etat de la sonde offline et raisons advisory/critical qui pilotent la capture forensique." examples={["Si state=pending, une panne critique a ete vue mais le seuil de repetition n'est pas encore atteint.", "Advisory reasons servent de contexte mais ne doivent pas provoquer une capture si le signal public reste sain."]} /></div>
          <div className="row"><span>Healthwatch</span><span className={String(healthwatchState.state || "healthy") === "healthy" ? "good" : "warn"}>{String(healthwatchState.state || "-")}</span></div>
          <div className="row"><span>Capture state</span><span className={String(chartOfflineCapture.state || "healthy") === "captured" ? "warn" : String(chartOfflineCapture.state || "healthy") === "pending" ? "warn" : "good"}>{String(chartOfflineCapture.state || "-")}</span></div>
          <div className="row"><span>Critical runs</span><span>{String(chartOfflineCapture.consecutive_critical_runs || 0)} / {String(chartOfflineCapture.active_threshold || chartOfflineCapture.threshold || 0)}</span></div>
          <div className="row"><span>Threshold reason</span><span>{String(chartOfflineCapture.threshold_reason || "-")}</span></div>
          <div className="row"><span>Offline</span><span className={Boolean(chartOfflineCapture.offline) ? "warn" : "good"}>{String(Boolean(chartOfflineCapture.offline))}</span></div>
          <div className="row"><span>Public OHLCV offline aligned</span><span className={Boolean(publicSignalAlignment.ohlcv_offline_badge) ? "warn" : "good"}>{String(Boolean(publicSignalAlignment.ohlcv_offline_badge))}</span></div>
          <div className="row"><span>Public candles MD hard-fail count</span><span>{String(publicSignalAlignment.public_candles_md_alert_count || 0)}</span></div>
          <div className="row"><span>Offline reasons</span><span>{offlineReasons.length > 0 ? offlineReasons.join(" · ") : "none"}</span></div>
          <div className="row"><span>Advisory reasons</span><span>{advisoryReasons.length > 0 ? advisoryReasons.join(" · ") : "none"}</span></div>
        </div>

        <div className="panel">
          <div className="eyebrow">Public Chart Watchdog <HelpHint text="Synthese du diagnostic public 5s/15s pour verifier que le chart tient apres stabilisation." examples={["Si Early BUS OK et Settled BUS OK mais les candle pixels chutent fortement, il faut re-investiguer le rendu ou les snapshots vides transitoires.", "MD OK + SEQ OK + candle pixels stables indiquent que le chart public reste exploitable." ]} /></div>
          <div className="row"><span>State</span><span className={String(publicChartVisibility.state || "healthy") === "healthy" ? "good" : "warn"}>{String(publicChartVisibility.state || "-")}</span></div>
          <div className="row"><span>Auth status</span><span>{String(publicChartVisibility.auth_status || "-")}</span></div>
          <div className="row"><span>Early BUS / MD</span><span>{String(Boolean(publicChartEarly.busOk))} / {String(Boolean(publicChartEarly.mdOk))}</span></div>
          <div className="row"><span>Settled BUS / MD</span><span>{String(Boolean(publicChartSettled.busOk))} / {String(Boolean(publicChartSettled.mdOk))}</span></div>
          <div className="row"><span>Early candle pixels</span><span>{String(publicChartEarly.candlePixels || 0)}</span></div>
          <div className="row"><span>Settled candle pixels</span><span>{String(publicChartSettled.candlePixels || 0)}</span></div>
        </div>
      </section>

      <section className="grid" style={{ gridTemplateColumns: "1fr 1fr", marginBottom: 16 }}>
        <div className="panel">
          <div className="eyebrow">KPI Memoire <HelpHint text="Qualite retrieval: similarite moyenne, impact sur score et winrate top cases." examples={["Si avg_final_similarity monte, la memoire retrouve des cas plus proches.", "Si avg_win_rate_top baisse, les souvenirs ramenes ne sont peut-etre plus utiles au regime courant."]} /></div>
          <div className="row"><span>Samples</span><span>{String(memorySummary.samples || 0)}</span></div>
          <div className="row"><span>Avg vector similarity</span><span>{String(memorySummary.avg_vector_similarity || "-")}</span></div>
          <div className="row"><span>Avg final similarity</span><span>{String(memorySummary.avg_final_similarity || "-")}</span></div>
          <div className="row"><span>Avg winrate top</span><span>{String(memorySummary.avg_win_rate_top || "-")}</span></div>
        </div>

        <div className="panel">
          <div className="eyebrow">A/B Live Memory <HelpHint text="Comparaison winrate et outcome entre bras memory_on et memory_off." examples={["Si memory_on gagne mieux que memory_off, continue l'experimentation avec plus de volume.", "Si p-value est grande, considere le resultat comme indicatif mais pas encore prouve."]} /></div>
          <div className="row"><span>Winrate delta (on-off)</span><span>{String(withVsWithout.winrate_delta ?? "-")}</span></div>
          <div className="row"><span>p-value (2-sided)</span><span>{String(withVsWithout.p_value_two_sided ?? "-")}</span></div>
          <div className="row"><span>Significant @95%</span><span>{String(withVsWithout.significant_95 ?? false)}</span></div>
          {abArms.length === 0 ? <p className="subtle">Pas assez d'echantillons A/B.</p> : null}
          {abArms.map((arm) => (
            <div className="row" key={String(arm.arm)}>
              <span>{String(arm.arm)}</span>
              <span>winrate={String(arm.win_rate || "-")} | avg={String(arm.avg_outcome || "-")}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="grid" style={{ gridTemplateColumns: "1fr 1fr", marginBottom: 16 }}>
        <div className="panel">
          <div className="eyebrow">Seuils Derive par Regime <HelpHint text="Seuils de blocage auto: min samples, min winrate, drawdown max, perte moyenne max." examples={["Exemple: pour trend, impose au moins 25 trades et 52% de winrate avant de faire confiance au regime.", "Si une strategie casse max_drawdown_usd, elle doit etre suspendue plus vite."]} /></div>
          <div className="form-grid" style={{ marginTop: 10 }}>
            <input value={regime} onChange={(e) => setRegime(e.target.value)} placeholder="regime" />
            <input type="number" value={minSamples} onChange={(e) => setMinSamples(Number(e.target.value || 0))} placeholder="min_samples" />
            <input type="number" step="0.01" value={minWinRate} onChange={(e) => setMinWinRate(Number(e.target.value || 0))} placeholder="min_win_rate" />
            <input type="number" step="1" value={maxDrawdown} onChange={(e) => setMaxDrawdown(Number(e.target.value || 0))} placeholder="max_drawdown_usd" />
            <input type="number" step="1" value={maxAvgLoss} onChange={(e) => setMaxAvgLoss(Number(e.target.value || 0))} placeholder="max_avg_loss_usd" />
            <button type="button" disabled={busy} onClick={() => void saveThreshold()}>{busy ? "Sauvegarde..." : "Sauvegarder seuil"}</button>
          </div>
          <div style={{ marginTop: 12 }}>
            {thresholds.map((row) => (
              <div className="row" key={String(row.regime)}>
                <span>{String(row.regime)}</span>
                <span>samples&gt;={String(row.min_samples)} | win&gt;={String(row.min_win_rate)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="panel">
          <div className="eyebrow">Auto-Suspension <HelpHint text="Strategies bloquees automatiquement si derive detectee selon les seuils du regime." examples={["Quand une strategie apparait ici, le systeme l'a deja stoppee pour te proteger.", "Clique Resume seulement si la cause de derive est comprise et traitee."]} /></div>
          {suspended.length === 0 ? <p className="subtle">Aucune strategie suspendue.</p> : null}
          {suspended.map((row) => (
            <div className="row" key={String(row.strategy_id)}>
              <span>{String(row.strategy_id)} | {String(row.market)}</span>
              <form method="post" action={`/api/strategies/${String(row.strategy_id)}/resume`}>
                <button type="submit">Resume</button>
              </form>
            </div>
          ))}
        </div>
      </section>

      <section className="grid" style={{ gridTemplateColumns: "1fr" }}>
        <div className="panel">
          <div className="eyebrow">Drift Details <HelpHint text="Detail regime/strategie avec raisons de derive pour investigation et recalibration." examples={["Lis la colonne reason pour savoir si le souci vient du winrate, du drawdown ou du sample count.", "Utilise ce detail pour ajuster les seuils plutot que relancer a l'aveugle."]} /></div>
          {driftItems.length === 0 ? <p className="subtle">Aucune ligne de drift pour le moment.</p> : null}
          {driftItems.slice(0, 80).map((row, idx) => (
            <div className="row" key={`${String(row.strategy_id)}-${String(row.regime)}-${idx}`}>
              <span>{String(row.strategy_id)} | {String(row.regime)} | sample={String(row.sample_count)}</span>
              <span className={Boolean(row.drift_detected) ? "warn" : "good"}>
                drift={String(row.drift_detected)} | win={String(row.win_rate || "-")} | dd={String(row.drawdown_usd || "-")} | {String(row.reason || "")}
              </span>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
