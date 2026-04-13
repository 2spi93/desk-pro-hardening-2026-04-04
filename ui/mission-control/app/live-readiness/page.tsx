"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import HelpHint from "../../components/HelpHint";
import OperatorPanelGuide from "../../components/ui/OperatorPanelGuide";

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
        <div id="global-guide-readiness-hero" className="panel txt-page-hero">
          <div className="eyebrow">Live Readiness Center</div>
          <h1 className="title" style={{ fontSize: 34 }}>Pret pour le live, derive et test memoire</h1>
          <p className="subtle txt-page-hero-copy">Cette page dit si les strategies restent assez propres pour continuer le live ou s'il faut freiner, suspendre et revalider.</p>
          <OperatorPanelGuide
            title="Guide Readiness"
            what="Les signaux qui montrent si les stratégies tiennent encore la route ou commencent à s'écarter."
            why="Éviter d'augmenter le risque alors que la qualité se dégrade déjà."
            example="Si plusieurs stratégies sont stoppées en même temps, réduis l'exposition et cherche ce qui a changé."
          />
          <div className="txt-page-guide-note">
            <strong>Regle d'usage</strong>
            Si plusieurs blocs passent au warn en meme temps, ne cherche pas a optimiser. Coupe le rythme, garde le risque bas et traite d'abord la cause de derive.
          </div>
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
          <div className="eyebrow">Etat Global <HelpHint text="Résumé rapide des signaux qui disent si le passage en live peut continuer ou doit attendre." examples={["Si des stratégies sont stoppées, n'ajoute pas plus de risque sans comprendre pourquoi.", "Si l'aide mémoire n'apporte plus grand-chose, garde-le en tête avant d'accélérer."]} /></div>
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
          <div className="eyebrow">Market Data Bus <HelpHint text="Ce bloc dit si le flux marché reste propre pour les graphiques, l'IA et l'exécution." examples={["Si les bougies ou la profondeur ne tiennent plus, considère l'écran comme dégradé.", "Un trou dans la suite des données mérite une vérification même si le flux n'est pas totalement coupé."]} /></div>
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
          <div className="eyebrow">Healthwatch Chart Capture <HelpHint text="Montre si la sonde a vu un vrai problème d'écran et si une capture doit être gardée pour analyse." examples={["Un état pending veut dire qu'un souci a été vu mais pas encore confirmé assez souvent.", "Les raisons secondaires donnent du contexte, mais ne suffisent pas toujours à déclencher une capture."]} /></div>
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
          <div className="eyebrow">Public Chart Watchdog <HelpHint text="Résumé du contrôle du graphique public pour vérifier qu'il reste bien visible après stabilisation." examples={["Si les signaux sont bons mais que l'image se vide, il faut relancer l'enquête côté rendu.", "Si les données tiennent et que l'affichage reste stable, le graphique reste utilisable."]} /></div>
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
          <div className="eyebrow">KPI Memoire <HelpHint text="Ces chiffres disent si la mémoire retrouve encore des cas utiles ou si elle aide moins qu'avant." examples={["Si la proximité moyenne monte, la mémoire retombe sur des situations plus proches.", "Si le taux de réussite des cas retrouvés baisse, l'aide mémoire perd en intérêt."]} /></div>
          <div className="row"><span>Samples</span><span>{String(memorySummary.samples || 0)}</span></div>
          <div className="row"><span>Avg vector similarity</span><span>{String(memorySummary.avg_vector_similarity || "-")}</span></div>
          <div className="row"><span>Avg final similarity</span><span>{String(memorySummary.avg_final_similarity || "-")}</span></div>
          <div className="row"><span>Avg winrate top</span><span>{String(memorySummary.avg_win_rate_top || "-")}</span></div>
        </div>

        <div className="panel">
          <div className="eyebrow">A/B Live Memory <HelpHint text="Compare simplement les résultats avec mémoire activée et mémoire coupée." examples={["Si la version avec mémoire fait mieux, continue à observer avec plus de volume.", "Si l'écart reste fragile, ne prends pas ce résultat pour une vérité définitive."]} /></div>
          <div className="row"><span>Winrate delta (on-off)</span><span>{String(withVsWithout.winrate_delta ?? "-")}</span></div>
          <div className="row"><span>p-value (2-sided)</span><span>{String(withVsWithout.p_value_two_sided ?? "-")}</span></div>
          <div className="row"><span>Significant @95%</span><span>{String(withVsWithout.significant_95 ?? false)}</span></div>
          {abArms.length === 0 ? <p className="subtle">Pas assez d'echantillons A/B.</p> : null}
          <div className="txt-scroll-shell compact">
            {abArms.map((arm) => (
              <div className="row" key={String(arm.arm)}>
                <span>{String(arm.arm)}</span>
                <span>winrate={String(arm.win_rate || "-")} | avg={String(arm.avg_outcome || "-")}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="grid" style={{ gridTemplateColumns: "1fr 1fr", marginBottom: 16 }}>
        <div className="panel">
          <div className="eyebrow">Seuils Derive par Regime <HelpHint text="Ici, tu règles à partir de quand le système doit freiner ou stopper une stratégie." examples={["Tu peux demander un minimum d'historique avant de faire confiance à une stratégie.", "Si la perte devient trop forte, la stratégie doit être stoppée plus tôt."]} /></div>
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
          <div className="eyebrow">Auto-Suspension <HelpHint text="La liste montre les stratégies déjà stoppées automatiquement pour éviter d'aggraver la situation." examples={["Si une stratégie apparaît ici, considère-la comme protégée par défaut.", "Ne la relance que si la cause du problème est comprise et traitée."]} /></div>
          {suspended.length === 0 ? <p className="subtle">Aucune strategie suspendue.</p> : null}
          <div className="txt-scroll-shell compact">
            {suspended.map((row) => (
              <div className="row" key={String(row.strategy_id)}>
                <span>{String(row.strategy_id)} | {String(row.market)}</span>
                <form method="post" action={`/api/strategies/${String(row.strategy_id)}/resume`}>
                  <button type="submit">Resume</button>
                </form>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="grid" style={{ gridTemplateColumns: "1fr" }}>
        <div className="panel">
          <div className="eyebrow">Drift Details <HelpHint text="Détail des écarts détectés pour comprendre d'où vient le problème avant de relancer." examples={["Lis la raison affichée pour voir si le souci vient du taux de réussite, de la perte ou du manque d'historique.", "Sers-toi de ce détail pour corriger le cadre plutôt que de relancer au hasard."]} /></div>
          {driftItems.length === 0 ? <p className="subtle">Aucune ligne de drift pour le moment.</p> : null}
          <div className="txt-scroll-shell">
            {driftItems.slice(0, 80).map((row, idx) => (
              <div className="row" key={`${String(row.strategy_id)}-${String(row.regime)}-${idx}`}>
                <span>{String(row.strategy_id)} | {String(row.regime)} | sample={String(row.sample_count)}</span>
                <span className={Boolean(row.drift_detected) ? "warn" : "good"}>
                  drift={String(row.drift_detected)} | win={String(row.win_rate || "-")} | dd={String(row.drawdown_usd || "-")} | {String(row.reason || "")}
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
