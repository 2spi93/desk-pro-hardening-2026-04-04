"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import HelpHint from "../../components/HelpHint";
import OperatorPanelGuide from "../../components/ui/OperatorPanelGuide";
import { openOpsCopilotPrompt } from "../../lib/opsCopilot";

type JsonMap = Record<string, unknown>;

type CapitalSourceRow = {
  id: string;
  account_id: string;
  client_id: string;
  source_type: "broker" | "exchange" | "wallet";
  venue: string;
  connector_type: string;
  environment: string;
  status: string;
  latest_equity_usd: number | null;
  canonical: boolean;
  description: string;
};

function toNumber(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function formatMoney(value: number): string {
  if (!Number.isFinite(value)) {
    return "-";
  }
  if (Math.abs(value) >= 1) {
    return `${value.toFixed(3)} USD`;
  }
  return `${value.toFixed(4)} USD`;
}

function formatPct(value: number, digits = 1): string {
  if (!Number.isFinite(value)) {
    return "-";
  }
  return `${(value * 100).toFixed(digits)}%`;
}

function formatMs(value: number | null | undefined): string {
  if (!Number.isFinite(Number(value))) {
    return "-";
  }
  return `${Number(value).toFixed(0)} ms`;
}

function formatDateTime(value: unknown): string {
  if (typeof value !== "string" || !value) {
    return "-";
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return value;
  }
  return new Date(timestamp).toLocaleString();
}

function normalizeText(value: unknown, fallback = "-"): string {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function resolveStatusTone(value: unknown): "good" | "warn" | "metric" {
  const normalized = String(value || "").trim().toLowerCase();
  if (["ok", "ready", "available", "true", "trend"].includes(normalized)) {
    return "good";
  }
  if (["degraded", "fallback", "false", "unreachable"].includes(normalized)) {
    return "warn";
  }
  return "metric";
}

function MetricCard({ title, value, detail, tone = "metric" }: { title: string; value: string; detail: string; tone?: "good" | "warn" | "metric" }) {
  return (
    <div className="panel" style={{ minHeight: 128 }}>
      <div className="eyebrow">{title}</div>
      <div className={tone} style={{ fontSize: 28, fontWeight: 700, marginTop: 8 }}>{value}</div>
      <div className="subtle" style={{ marginTop: 8 }}>{detail}</div>
    </div>
  );
}

export default function AiPage() {
  const [task, setTask] = useState("strategy_creation");
  const [prompt, setPrompt] = useState("Design a low-turnover volatility-aware crypto strategy with hard risk caps and explicit execution safeguards.");
  const [criticality, setCriticality] = useState("high");
  const [costLimit, setCostLimit] = useState(0.05);
  const [preferLocal, setPreferLocal] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<JsonMap | null>(null);
  const [health, setHealth] = useState<JsonMap | null>(null);
  const [history, setHistory] = useState<JsonMap[]>([]);
  const [localHealth, setLocalHealth] = useState<JsonMap | null>(null);
  const [warming, setWarming] = useState<string | null>(null);
  const [clearingHistory, setClearingHistory] = useState(false);
  const [memoryAb, setMemoryAb] = useState<JsonMap | null>(null);
  const [trendScore, setTrendScore] = useState(0.42);
  const [realizedVolatility, setRealizedVolatility] = useState(0.055);
  const [sentimentScore, setSentimentScore] = useState(0.18);
  const [regimeBusy, setRegimeBusy] = useState(false);
  const [regimeResult, setRegimeResult] = useState<JsonMap | null>(null);
  const [scenario, setScenario] = useState("Fed emergency hike");
  const [strategyName, setStrategyName] = useState("institutional-ai-desk");
  const [assetClass, setAssetClass] = useState("multi-asset");
  const [horizonDays, setHorizonDays] = useState(20);
  const [backtestBusy, setBacktestBusy] = useState(false);
  const [backtestResult, setBacktestResult] = useState<JsonMap | null>(null);
  const [capitalSources, setCapitalSources] = useState<CapitalSourceRow[]>([]);
  const [connectorsStatus, setConnectorsStatus] = useState<JsonMap | null>(null);
  const [selectedSourceId, setSelectedSourceId] = useState("");
  const [sourceVerification, setSourceVerification] = useState<JsonMap | null>(null);
  const [verifyingSource, setVerifyingSource] = useState(false);

  async function loadHealth(): Promise<void> {
    const response = await fetch("/api/ai/health", { cache: "no-store" });
    if (!response.ok) {
      throw new Error("Impossible de charger l'etat IA");
    }
    setHealth(await response.json());
  }

  async function loadHistory(): Promise<void> {
    const response = await fetch("/api/ai/history?limit=20", { cache: "no-store" });
    if (!response.ok) {
      throw new Error("Impossible de charger l'historique IA");
    }
    const payload = (await response.json()) as JsonMap[];
    setHistory(Array.isArray(payload) ? payload : []);
  }

  async function loadLocalHealth(): Promise<void> {
    const response = await fetch("/api/ai/local-models/health", { cache: "no-store" });
    if (!response.ok) {
      throw new Error("Impossible de charger la sante des modeles locaux");
    }
    setLocalHealth(await response.json());
  }

  async function loadMemoryAb(): Promise<void> {
    const response = await fetch("/api/experiments/memory-ab?window_hours=168", { cache: "no-store" });
    if (!response.ok) {
      throw new Error("Impossible de charger le comparatif memory A/B");
    }
    setMemoryAb(await response.json());
  }

  async function loadCapitalSources(): Promise<void> {
    const [accountsResponse, connectorsAccountsResponse, connectorsStatusResponse] = await Promise.all([
      fetch("/api/accounts", { cache: "no-store" }),
      fetch("/api/connectors/accounts", { cache: "no-store" }),
      fetch("/api/connectors/status", { cache: "no-store" }),
    ]);
    if (!accountsResponse.ok || !connectorsAccountsResponse.ok || !connectorsStatusResponse.ok) {
      throw new Error("Impossible de charger les sources de capital");
    }

    const accountsPayload = await accountsResponse.json().catch(() => []);
    const connectorAccountsPayload = await connectorsAccountsResponse.json().catch(() => ({}));
    const connectorStatusPayload = await connectorsStatusResponse.json().catch(() => ({}));
    const canonicalAccounts = Array.isArray(accountsPayload) ? accountsPayload as JsonMap[] : [];
    const linkedAccounts = Array.isArray((connectorAccountsPayload as JsonMap).accounts) ? ((connectorAccountsPayload as JsonMap).accounts as JsonMap[]) : [];
    const canonicalIds = new Set(canonicalAccounts.map((row) => String(row.account_id || "")).filter(Boolean));

    const nextSources: CapitalSourceRow[] = [
      ...canonicalAccounts.map((row) => {
        const sourceType = String(row.account_type || "broker").toLowerCase();
        const normalizedType: CapitalSourceRow["source_type"] = sourceType === "exchange" || sourceType === "wallet" ? sourceType : "broker";
        return {
          id: `canonical:${String(row.account_id || "")}`,
          account_id: String(row.account_id || ""),
          client_id: String(row.client_id || ""),
          source_type: normalizedType,
          venue: String(row.venue || row.display_name || row.account_id || ""),
          connector_type: String(row.connector_type || normalizedType),
          environment: normalizedType === "broker" ? String(row.mode || "unknown") : `${normalizedType} live`,
          status: String(row.status || "unknown"),
          latest_equity_usd: Number.isFinite(Number(row.latest_equity_usd)) ? Number(row.latest_equity_usd) : null,
          canonical: true,
          description: normalizedType === "broker"
            ? `Compte ${String(row.mode || "unknown")} gouverne par le portefeuille.`
            : `Source ${normalizedType} deja canonisee pour allocation et reporting.`,
        };
      }),
      ...linkedAccounts
        .filter((row) => {
          const provider = String(row.provider || "").toLowerCase();
          const accountId = String(row.account_id || "");
          return provider !== "mt5" && accountId && !canonicalIds.has(accountId);
        })
        .map((row) => {
          const sourceType: CapitalSourceRow["source_type"] = String(row.provider_type || "exchange").toLowerCase() === "wallet" ? "wallet" : "exchange";
          return {
            id: `linked:${String(row.provider || "")}:${String(row.account_id || "")}`,
            account_id: String(row.account_id || ""),
            client_id: String(row.client_id || ""),
            source_type: sourceType,
            venue: String(row.provider || row.label || row.account_id || ""),
            connector_type: String(row.provider || sourceType),
            environment: sourceType === "wallet" ? "wallet live" : "exchange live",
            status: String(row.mode || "linked"),
            latest_equity_usd: null,
            canonical: false,
            description: sourceType === "wallet"
              ? "Wallet connecté mais pas encore synchronisé comme source allocable canonique."
              : "Compte exchange lié, visible pour contrôle plateforme mais sans synchronisation fonds canonique.",
          };
        }),
    ];

    setCapitalSources(nextSources);
    setConnectorsStatus(connectorStatusPayload as JsonMap);
  }

  async function reloadDesk(): Promise<void> {
    await Promise.all([loadHealth(), loadHistory(), loadLocalHealth(), loadMemoryAb(), loadCapitalSources()]);
  }

  useEffect(() => {
    reloadDesk().catch((err) => setError(err instanceof Error ? err.message : "Chargement AI Desk impossible"));
  }, []);

  const providerRows = useMemo(() => {
    const providers = (health?.providers as JsonMap | undefined)?.providers;
    return Array.isArray(providers) ? providers as JsonMap[] : [];
  }, [health]);

  const healthPayload = (health?.health as JsonMap | undefined) || {};
  const capacityPayload = (health?.capacity as JsonMap | undefined) || {};
  const cap = (healthPayload.capacity as JsonMap | undefined) || {};
  const recommended = (capacityPayload.recommended_open_source as JsonMap | undefined) || {};
  const circuitBreakers = useMemo(() => {
    const source = (healthPayload.circuit_breakers as JsonMap | undefined) || {};
    return Object.entries(source);
  }, [healthPayload]);
  const localRows = Array.isArray(localHealth?.models) ? localHealth.models as JsonMap[] : [];
  const abArms = Array.isArray(memoryAb?.arms) ? memoryAb.arms as JsonMap[] : [];
  const withVsWithout = (memoryAb?.with_vs_without_memory as JsonMap | undefined) || {};
  const latestHistory = history[0] || null;

  const availableProviders = providerRows.filter((row) => Boolean(row.available));
  const degradedProviders = providerRows.filter((row) => !Boolean(row.available));
  const localReachable = Boolean(localHealth?.reachable);
  const localSuccessfulModels = localRows.filter((row) => Boolean(row.has_success));
  const timeoutSeconds = toNumber((health?.providers as JsonMap | undefined)?.timeout_seconds, 0);
  const maxRetries = toNumber((health?.providers as JsonMap | undefined)?.max_retries, 0);
  const historyDegradedCount = history.filter((row) => String(row.status || "").toLowerCase() === "degraded").length;
  const memorySamples = toNumber((withVsWithout.samples as JsonMap | undefined)?.memory_on, 0) + toNumber((withVsWithout.samples as JsonMap | undefined)?.memory_off, 0);
  const routeBudgetUsd = providerRows.reduce((sum, row) => sum + toNumber(row.estimated_cost_usd, 0), 0);
  const liveBrokerSources = capitalSources.filter((row) => row.source_type === "broker" && row.environment === "live");
  const paperBrokerSources = capitalSources.filter((row) => row.source_type === "broker" && row.environment === "paper");
  const exchangeSources = capitalSources.filter((row) => row.source_type === "exchange");
  const walletSources = capitalSources.filter((row) => row.source_type === "wallet");
  const selectedSource = capitalSources.find((row) => row.id === selectedSourceId) || capitalSources[0] || null;
  const healthyConnectors = Array.isArray(connectorsStatus?.connectors)
    ? (connectorsStatus?.connectors as JsonMap[]).filter((row) => Boolean(row.healthy)).length
    : 0;
  const totalConnectors = Array.isArray(connectorsStatus?.connectors) ? (connectorsStatus?.connectors as JsonMap[]).length : 0;

  useEffect(() => {
    if (!selectedSourceId && capitalSources.length > 0) {
      setSelectedSourceId(capitalSources[0].id);
    }
  }, [capitalSources, selectedSourceId]);

  async function verifySelectedSource(): Promise<void> {
    if (!selectedSource) {
      return;
    }
    setVerifyingSource(true);
    setError(null);
    try {
      if (!selectedSource.canonical) {
        setSourceVerification({
          status: "linked_only",
          account_id: selectedSource.account_id,
          venue: selectedSource.venue,
          source_type: selectedSource.source_type,
          note: "Cette source est visible côté connecteur, mais la vérification des fonds nécessite soit une synchronisation canonique, soit un adaptateur qui remonte des balances/positions.",
        });
        return;
      }

      if (selectedSource.source_type !== "wallet") {
        const syncResponse = await fetch(`/api/accounts/${encodeURIComponent(selectedSource.account_id)}/sync`, { method: "POST" });
        const syncPayload = await syncResponse.json().catch(() => ({}));
        if (!syncResponse.ok) {
          throw new Error(String((syncPayload as JsonMap).detail || "Sync source impossible"));
        }
      }

      const verificationResponse = await fetch(`/api/internal/accounts/${encodeURIComponent(selectedSource.account_id)}/verification`, { cache: "no-store" });
      const verificationPayload = await verificationResponse.json().catch(() => ({}));
      if (!verificationResponse.ok) {
        throw new Error(String((verificationPayload as JsonMap).detail || "Verification source impossible"));
      }
      setSourceVerification(verificationPayload as JsonMap);
      try {
        await reloadDesk();
      } catch {
        // noop: la vérification source reste valide même si un autre bloc du desk recharge mal.
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification source impossible");
    } finally {
      setVerifyingSource(false);
    }
  }

  async function onExecute(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/ai/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task,
          prompt,
          criticality,
          cost_limit_usd: costLimit,
          prefer_local: preferLocal,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(String(payload?.detail || "Execution IA echouee"));
      }
      setResult(payload);
      await reloadDesk();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur inconnue");
    } finally {
      setLoading(false);
    }
  }

  async function warmup(modelKey?: string): Promise<void> {
    setWarming(modelKey || "all");
    setError(null);
    try {
      const response = await fetch("/api/ai/local-models/warmup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(modelKey ? { model_key: modelKey } : {}),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(String(payload?.detail || "Warmup echoue"));
      }
      await Promise.all([loadLocalHealth(), loadHistory()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur inconnue");
    } finally {
      setWarming(null);
    }
  }

  async function clearOldHistory(): Promise<void> {
    setClearingHistory(true);
    setError(null);
    try {
      const response = await fetch("/api/ai/history/clear-old", { method: "POST" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(String(payload?.detail || "Clear old history echoue"));
      }
      await Promise.all([loadHistory(), loadLocalHealth()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur inconnue");
    } finally {
      setClearingHistory(false);
    }
  }

  async function detectRegime(): Promise<void> {
    setRegimeBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/ai/regimes/detect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          trend_score: trendScore,
          realized_volatility: realizedVolatility,
          sentiment_score: sentimentScore,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(String(payload?.detail || "Detection regime echouee"));
      }
      setRegimeResult(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur inconnue");
    } finally {
      setRegimeBusy(false);
    }
  }

  async function runBacktest(): Promise<void> {
    setBacktestBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/ai/backtests/geopolitical", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          strategy_name: strategyName,
          asset_class: assetClass,
          scenario,
          horizon_days: horizonDays,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(String(payload?.detail || "Backtest geopolitique echoue"));
      }
      setBacktestResult(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur inconnue");
    } finally {
      setBacktestBusy(false);
    }
  }

  return (
    <main className="shell txt-page-shell">
      <section className="hero txt-page-hero-grid" style={{ gridTemplateColumns: "1.35fr 0.85fr" }}>
        <div className="panel txt-page-hero">
          <div className="eyebrow">AI Desk Institutionnelle</div>
          <h1 className="title" style={{ fontSize: 34 }}>Desk IA operationnel</h1>
          <p className="subtle txt-page-hero-copy">Une seule page pour verifier les routes IA disponibles, preparer les modeles locaux, lancer une tache et relire ce qui s'est vraiment passe.</p>
          <OperatorPanelGuide
            title="Guide AI Desk"
            what="L'état réel des routes IA, des modèles locaux, des essais et de l'historique d'exécution."
            why="Éviter de lancer une tâche alors que la route choisie ou le modèle local n'est pas fiable."
            example="Commence par vérifier les routes disponibles, prépare le local si besoin, puis lance les tâches seulement si l'état est propre."
          />
          <div className="txt-page-guide-note">
            <strong>Ordre conseille</strong>
            1. Verifie quelles routes sont vraiment disponibles. 2. Prepare le local seulement si tu comptes l'utiliser. 3. Lance la tache. 4. Relis la route choisie, le cout et la latence avant d'utiliser le resultat.
          </div>
          <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 10 }}>
            <span className="pill">Routes actives {availableProviders.length}/{providerRows.length || 0}</span>
            <span className="pill">Local {localReachable ? "pret" : "hors ligne"}</span>
            <span className="pill">Timeout {timeoutSeconds || 0}s</span>
            <span className="pill">Essais max {maxRetries}</span>
          </div>
          <p style={{ marginTop: 12 }}>
            <Link href="/terminal">Trading Terminal</Link>
            {" | "}
            <Link href="/fund-manager">Fund Manager</Link>
            {" | "}
            <Link href="/connectors">Execution & Connectors</Link>
            {" | "}
            <Link href="/connections">Client Connection Hub</Link>
            {" | "}
            <Link href="/incidents">Incident Desk</Link>
          </p>
          {error ? <p className="warn" style={{ marginTop: 10 }}>{error}</p> : null}
        </div>

        <div className="panel">
          <div className="eyebrow">Desk Header</div>
          <div className="row"><span>Service</span><span>{normalizeText(healthPayload.service, "ai-orchestrator")}</span></div>
          <div className="row"><span>Global status</span><span className={resolveStatusTone(healthPayload.status)}>{normalizeText(healthPayload.status, "unknown")}</span></div>
          <div className="row"><span>Available routes</span><span>{availableProviders.length}/{providerRows.length || 0}</span></div>
          <div className="row"><span>Degraded history</span><span>{historyDegradedCount}/{history.length}</span></div>
          <div className="row"><span>Local endpoint</span><span>{normalizeText(localHealth?.endpoint)}</span></div>
          <div className="row"><span>Memory samples</span><span>{memorySamples}</span></div>
          <div className="row"><span>Indicative route budget</span><span>{formatMoney(routeBudgetUsd)}</span></div>
          <div className="row"><span>Latest run</span><span>{latestHistory ? formatDateTime(latestHistory.created_at) : "-"}</span></div>
        </div>
      </section>

      <section className="grid" style={{ marginTop: 16, gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
        <MetricCard title="Provider posture" value={`${availableProviders.length}/${providerRows.length || 0}`} detail={availableProviders.length > 0 ? "Remote routes available for critical tasks." : "No route currently available for critical tasks."} tone={availableProviders.length > 0 ? "good" : "warn"} />
        <MetricCard title="Local inference" value={localReachable ? "ONLINE" : "OFFLINE"} detail={localSuccessfulModels.length > 0 ? `${localSuccessfulModels.length} local routes have succeeded recently.` : "No successful local route registered yet."} tone={localReachable ? "good" : "warn"} />
        <MetricCard title="Memory experiment" value={memorySamples > 0 ? String(memorySamples) : "NO DATA"} detail={`Win delta ${formatPct(toNumber(withVsWithout.winrate_delta, 0), 1)} · p-value ${normalizeText(withVsWithout.p_value_two_sided, "n/a")}`} tone={memorySamples > 0 ? "good" : "metric"} />
        <MetricCard title="Latest execution" value={latestHistory ? normalizeText(latestHistory.status).toUpperCase() : "IDLE"} detail={latestHistory ? `${normalizeText(latestHistory.provider_used)} / ${normalizeText(latestHistory.model_used)} · ${formatMs(toNumber(latestHistory.latency_ms, 0))}` : "No recent execution yet."} tone={latestHistory && String(latestHistory.status || "").toLowerCase() === "ok" ? "good" : latestHistory ? "warn" : "metric"} />
      </section>

      <section className="grid" style={{ marginTop: 16, gridTemplateColumns: "1.15fr 0.85fr" }}>
        <div className="panel">
          <div className="eyebrow">Routes IA disponibles <HelpHint text="Ce bloc montre quelles routes IA sont disponibles, combien elles coûtent et si une protection s'est déclenchée." examples={["Si une route importante manque, il faut le voir avant de lancer une tâche.", "Si une route tombe souvent en secours, le problème vient de l'infrastructure plus que du prompt."]} /></div>
          {providerRows.length === 0 ? <p className="subtle" style={{ marginTop: 12 }}>Aucun provider detecte.</p> : null}
          <div className="txt-scroll-shell compact">
            {providerRows.map((row) => (
              <div className="row" key={`${String(row.route)}-${String(row.model)}`}>
                <span>{normalizeText(row.route)} | {normalizeText(row.provider)} | {normalizeText(row.kind)}</span>
                <span>{Boolean(row.available) ? "up" : "down"} | {formatMoney(toNumber(row.estimated_cost_usd, 0))}</span>
              </div>
            ))}
            <div className="panel" style={{ borderRadius: 14 }}>
              <div className="eyebrow">Circuit Breakers</div>
              {circuitBreakers.length === 0 ? <p className="subtle" style={{ marginTop: 12 }}>Aucun circuit breaker remonte.</p> : null}
              {circuitBreakers.map(([provider, value]) => {
                const breaker = (value || {}) as JsonMap;
                return (
                  <div className="row" key={provider}>
                    <span>{provider}</span>
                    <span>{Boolean(breaker.open) ? "open" : "closed"} | failures {toNumber(breaker.failures, 0)} | until {normalizeText(breaker.opened_until, "-")}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="panel">
          <div className="eyebrow">Capacite machine <HelpHint text="Ce bloc dit si la machine peut vraiment porter des tâches locales ou s'il vaut mieux s'appuyer sur le distant." examples={["Une machine sans GPU peut rester utile pour du léger mais pas pour du lourd.", "Si le local ne répond pas, il faut basculer vers les routes distantes prévues."]} /></div>
          <div className="row"><span>CPU</span><span>{toNumber(cap.cpus, 0)}</span></div>
          <div className="row"><span>Memory</span><span>{toNumber(cap.memory_gb, 0).toFixed(2)} GiB</span></div>
          <div className="row"><span>GPU</span><span>{String(Boolean(cap.has_gpu))}</span></div>
          <div className="row"><span>Recommended fast</span><span>{normalizeText(recommended.fast)}</span></div>
          <div className="row"><span>Recommended reasoning</span><span>{normalizeText(recommended.reasoning)}</span></div>
          <div className="row"><span>Local endpoint</span><span>{normalizeText(localHealth?.endpoint)}</span></div>
          <div className="row"><span>Reachable</span><span>{String(localReachable)}</span></div>
        </div>
      </section>

      <section className="grid" style={{ marginTop: 16, gridTemplateColumns: "1.15fr 0.85fr" }}>
        <div className="panel">
          <div className="eyebrow">Origine des fonds visibles <HelpHint text="Ce bloc rappelle d'où viennent les fonds visibles derrière le desk: test, réel, exchange ou wallet." examples={["Un montant visible en mode test n'est pas du capital réel.", "Un exchange ou un wallet peut être branché sans être encore prêt pour une vraie allocation."]} /></div>
          <div className="term-report-body" style={{ marginTop: 12, marginBottom: 12 }}>
            <span>Broker live: <strong>{liveBrokerSources.length}</strong> · Broker paper: <strong>{paperBrokerSources.length}</strong>.</span>
            <span>Exchange: <strong>{exchangeSources.length}</strong> · Wallet: <strong>{walletSources.length}</strong>.</span>
            <span>Connecteurs sains: <strong>{healthyConnectors}/{totalConnectors}</strong>.</span>
          </div>
          {capitalSources.length === 0 ? <p className="subtle">Aucune source de capital visible.</p> : null}
          <div className="txt-scroll-shell compact">
            {capitalSources.slice(0, 10).map((row) => (
              <div className="row" key={row.id}>
                <span>{row.venue} · {row.source_type} · {row.environment}</span>
                <span>{row.canonical ? "canonique" : "connecteur seul"} · {row.status} · {row.latest_equity_usd !== null ? formatMoney(row.latest_equity_usd) : "fonds non synchronises"}</span>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 12 }}>
            <button type="button" onClick={() => openOpsCopilotPrompt({ message: "Explique-moi la différence entre les fonds paper, live, exchange et wallet visibles sur cette interface.", autoSend: true })}>
              Demander la distinction au Copilot
            </button>
            <button type="button" onClick={() => window.location.assign("/live-capital")}>
              Ouvrir Live Capital
            </button>
          </div>
        </div>

        <div className="panel">
          <div className="eyebrow">Verification de la source</div>
          <div className="form-grid" style={{ marginTop: 12 }}>
            <select value={selectedSource?.id || ""} onChange={(event) => setSelectedSourceId(event.target.value)}>
              <option value="">Choisir une source</option>
              {capitalSources.map((row) => (
                <option key={row.id} value={row.id}>{row.venue} · {row.source_type} · {row.environment}</option>
              ))}
            </select>
            <button type="button" disabled={!selectedSource || verifyingSource} onClick={() => verifySelectedSource()}>
              {verifyingSource ? "Verification..." : "Verifier fonds et plateforme"}
            </button>
            <button type="button" disabled={!selectedSource} onClick={() => openOpsCopilotPrompt({ message: `Résume-moi en langage naturel la plateforme, les fonds visibles et les limites de verification pour ${selectedSource?.venue || "la source sélectionnée"}.`, autoSend: true })}>
              Demander un resume client
            </button>
          </div>
          {selectedSource ? (
            <div className="panel" style={{ marginTop: 12, borderRadius: 14 }}>
              <div className="row"><span>Source</span><span>{selectedSource.venue}</span></div>
              <div className="row"><span>Type</span><span>{selectedSource.source_type}</span></div>
              <div className="row"><span>Environnement</span><span>{selectedSource.environment}</span></div>
              <div className="row"><span>Nature</span><span>{selectedSource.description}</span></div>
            </div>
          ) : null}
          {sourceVerification ? (
            <div className="panel" style={{ marginTop: 12, borderRadius: 14 }}>
              <div className="row"><span>Status</span><span>{normalizeText(sourceVerification.status)}</span></div>
              <div className="row"><span>Balances</span><span>{Array.isArray(sourceVerification.balances) ? `${(sourceVerification.balances as unknown[]).length} ligne(s)` : normalizeText(sourceVerification.note, "-")}</span></div>
              <div className="row"><span>Positions</span><span>{Array.isArray(sourceVerification.positions) ? `${(sourceVerification.positions as unknown[]).length} ligne(s)` : "-"}</span></div>
              <div className="row"><span>Portfolio links</span><span>{Array.isArray(sourceVerification.portfolio_links) ? `${(sourceVerification.portfolio_links as unknown[]).length}` : "-"}</span></div>
            </div>
          ) : null}
        </div>
      </section>

      <section className="grid" style={{ marginTop: 16, gridTemplateColumns: "1.15fr 0.85fr" }}>
        <div className="panel">
          <div className="eyebrow">Lancer une tache IA <HelpHint text="Zone de lancement contrôlée pour les tâches IA importantes, avec limite de coût et choix de route." examples={["Pour une tâche sensible, relis la route finale avant d'utiliser la réponse.", "Le mode local n'a de sens que si le service local répond bien."]} /></div>
          <form onSubmit={onExecute} className="form-grid" style={{ marginTop: 12 }}>
            <input value={task} onChange={(event) => setTask(event.target.value)} placeholder="task" required />
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={6} required />
            <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <div className="form-grid">
                <label className="subtle">Criticality</label>
                <select value={criticality} onChange={(event) => setCriticality(event.target.value)}>
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                </select>
              </div>
              <div className="form-grid">
                <label className="subtle">Cost limit USD</label>
                <input type="number" step="0.001" value={costLimit} onChange={(event) => setCostLimit(Number(event.target.value || 0))} />
              </div>
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input type="checkbox" checked={preferLocal} onChange={(event) => setPreferLocal(event.target.checked)} />
              <span>Prefer local open-source</span>
            </label>
            <button type="submit" disabled={loading}>{loading ? "Execution..." : "Lancer la tache IA"}</button>
          </form>
        </div>

        <div className="panel">
          <div className="eyebrow">Derniere decision de route</div>
          {!result ? <p className="subtle" style={{ marginTop: 12 }}>Aucune execution depuis ce desk pour le moment.</p> : null}
          {result ? (
            <>
              <div className="row"><span>Route reason</span><span>{normalizeText((result.route as JsonMap | undefined)?.reason)}</span></div>
              <div className="row"><span>Primary model</span><span>{normalizeText((result.route as JsonMap | undefined)?.primary_model)}</span></div>
              <div className="row"><span>Fallback model</span><span>{normalizeText((result.route as JsonMap | undefined)?.fallback_model)}</span></div>
              <div className="row"><span>Provider used</span><span>{normalizeText(result.provider_used)}</span></div>
              <div className="row"><span>Model used</span><span>{normalizeText(result.model_used)}</span></div>
              <div className="row"><span>Fallback used</span><span>{String(Boolean(result.fallback_used))}</span></div>
              <div className="row"><span>Retries</span><span>{toNumber(result.retries_used, 0)}</span></div>
              <div className="row"><span>Latency</span><span>{formatMs(toNumber(result.latency_ms, 0))}</span></div>
              <div className="panel" style={{ marginTop: 12, borderRadius: 14 }}>
                <div className="eyebrow">Output</div>
                <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{normalizeText(result.output, "")}</pre>
              </div>
            </>
          ) : null}
        </div>
      </section>

      <section className="grid" style={{ marginTop: 16, gridTemplateColumns: "1fr 1fr" }}>
        <div className="panel">
          <div className="eyebrow">Modeles locaux <HelpHint text="Ce bloc sert à voir si les modèles locaux répondent et à les préparer au début de la session." examples={["Lance le préchauffage si tu comptes utiliser le local aujourd'hui.", "Si les modèles restent hors ligne, traite-le comme un souci d'infrastructure."]} /></div>
          <div className="row"><span>Endpoint</span><span>{normalizeText(localHealth?.endpoint)}</span></div>
          <div className="row"><span>Reachable</span><span>{String(localReachable)}</span></div>
          <div style={{ display: "flex", gap: 10, marginTop: 12, marginBottom: 12 }}>
            <button type="button" onClick={() => warmup()} disabled={warming !== null}>{warming === "all" ? "Preparation..." : "Preparer tous les modeles locaux"}</button>
          </div>
          {localRows.length === 0 ? <p className="subtle">Aucun modele local detecte.</p> : null}
          <div className="txt-scroll-shell compact">
            {localRows.map((row) => (
              <div className="row" key={String(row.route)}>
                <span>{normalizeText(row.route)} | {normalizeText(row.model)}</span>
                <span>{Boolean(row.available) ? "pret" : "froid"} | {formatMs(toNumber(row.avg_latency_ms, NaN))} | appels {toNumber(row.calls, 0)}</span>
                <button type="button" onClick={() => warmup(String(row.route))} disabled={warming !== null}>{warming === String(row.route) ? "Preparation..." : "Preparer"}</button>
              </div>
            ))}
          </div>
        </div>

        <div className="panel">
          <div className="eyebrow">Lecture du contexte de marche <HelpHint text="Petit laboratoire pour lire le contexte du marché et savoir quel style d'action reste le plus adapté." examples={["Si le contexte semble clairement orienté, tu peux favoriser les outils qui suivent le mouvement.", "Si la confiance reste moyenne, prends le résultat comme une aide et non comme un ordre."]} /></div>
          <div className="form-grid" style={{ marginTop: 12 }}>
            <input type="number" step="0.01" value={trendScore} onChange={(event) => setTrendScore(Number(event.target.value || 0))} placeholder="trend_score" />
            <input type="number" step="0.001" value={realizedVolatility} onChange={(event) => setRealizedVolatility(Number(event.target.value || 0))} placeholder="realized_volatility" />
            <input type="number" step="0.01" value={sentimentScore} onChange={(event) => setSentimentScore(Number(event.target.value || 0))} placeholder="sentiment_score" />
            <button type="button" onClick={() => detectRegime()} disabled={regimeBusy}>{regimeBusy ? "Analyse..." : "Lire le contexte"}</button>
          </div>
          {regimeResult ? (
            <div className="panel" style={{ marginTop: 12, borderRadius: 14 }}>
              <div className="row"><span>Status</span><span>{normalizeText(regimeResult.status)}</span></div>
              <div className="row"><span>Regime</span><span>{normalizeText(regimeResult.regime)}</span></div>
              <div className="row"><span>Confidence</span><span>{formatPct(toNumber(regimeResult.confidence, 0), 1)}</span></div>
              <div className="eyebrow" style={{ marginTop: 12 }}>Recommendations</div>
              {Array.isArray(regimeResult.recommendations) && regimeResult.recommendations.length > 0 ? (
                (regimeResult.recommendations as unknown[]).map((entry, index) => (
                  <div className="row" key={`${entry}-${index}`}><span>{normalizeText(entry)}</span><span>action</span></div>
                ))
              ) : (
                <p className="subtle" style={{ marginTop: 12 }}>Aucune recommandation retournee.</p>
              )}
            </div>
          ) : null}
        </div>
      </section>

      <section className="grid" style={{ marginTop: 16, gridTemplateColumns: "1fr 1fr" }}>
        <div className="panel">
          <div className="eyebrow">Test de scenario <HelpHint text="Ce bloc teste rapidement un scénario pour voir si le cadre d'action tient encore debout." examples={["Si le score de tenue baisse fortement, adopte une posture plus prudente.", "Ce test sert à cadrer la décision, pas à promettre l'avenir."]} /></div>
          <div className="form-grid" style={{ marginTop: 12 }}>
            <input value={strategyName} onChange={(event) => setStrategyName(event.target.value)} placeholder="strategy_name" />
            <input value={assetClass} onChange={(event) => setAssetClass(event.target.value)} placeholder="asset_class" />
            <input value={scenario} onChange={(event) => setScenario(event.target.value)} placeholder="scenario" />
            <input type="number" step="1" value={horizonDays} onChange={(event) => setHorizonDays(Number(event.target.value || 0))} placeholder="horizon_days" />
            <button type="button" onClick={() => runBacktest()} disabled={backtestBusy}>{backtestBusy ? "Stress..." : "Lancer le test"}</button>
            <button type="button" onClick={() => openOpsCopilotPrompt({ message: `Propose en langage naturel si la stratégie ${strategyName} peut être promue vers un usage live, en tenant compte des sources de capital et du scénario ${scenario}.`, autoSend: true })}>
              Demander une proposition d'agent
            </button>
          </div>
          {backtestResult ? (
            <div className="panel" style={{ marginTop: 12, borderRadius: 14 }}>
              <div className="row"><span>Status</span><span>{normalizeText(backtestResult.status)}</span></div>
              <div className="row"><span>Scenario</span><span>{normalizeText(backtestResult.scenario)}</span></div>
              <div className="row"><span>Resilience</span><span>{formatPct(toNumber(backtestResult.resilience_score, 0), 1)}</span></div>
              <div className="row"><span>Expected max DD</span><span>{formatPct(toNumber(backtestResult.expected_max_drawdown, 0), 1)}</span></div>
              <div className="eyebrow" style={{ marginTop: 12 }}>Actions</div>
              {Array.isArray(backtestResult.actions) && backtestResult.actions.length > 0 ? (
                (backtestResult.actions as unknown[]).map((entry, index) => (
                  <div className="row" key={`${entry}-${index}`}><span>{normalizeText(entry)}</span><span>scenario</span></div>
                ))
              ) : (
                <p className="subtle" style={{ marginTop: 12 }}>Aucune action retournee.</p>
              )}
            </div>
          ) : null}
        </div>

        <div className="panel">
          <div className="eyebrow">Memoire et calibration <HelpHint text="Ce bloc dit simplement si l'aide mémoire semble utile ou si le sujet reste encore ouvert." examples={["Sans assez d'exemples, il ne faut pas tirer de conclusion.", "Si l'écart reste faible ou flou, garde une lecture prudente."]} /></div>
          <div className="row"><span>Winrate delta</span><span>{formatPct(toNumber(withVsWithout.winrate_delta, 0), 1)}</span></div>
          <div className="row"><span>p-value</span><span>{normalizeText(withVsWithout.p_value_two_sided, "n/a")}</span></div>
          <div className="row"><span>Significant @95%</span><span>{String(Boolean(withVsWithout.significant_95))}</span></div>
          <div className="row"><span>Samples memory_on</span><span>{toNumber((withVsWithout.samples as JsonMap | undefined)?.memory_on, 0)}</span></div>
          <div className="row"><span>Samples memory_off</span><span>{toNumber((withVsWithout.samples as JsonMap | undefined)?.memory_off, 0)}</span></div>
          {abArms.length === 0 ? <p className="subtle" style={{ marginTop: 12 }}>Pas assez de donnees A/B pour conclure.</p> : null}
          <div className="txt-scroll-shell compact">
            {abArms.map((row) => (
              <div className="row" key={String(row.arm)}>
                <span>{normalizeText(row.arm)}</span>
                <span>n {toNumber(row.samples, 0)} | win {formatPct(toNumber(row.win_rate, 0), 1)} | avg {toNumber(row.avg_outcome, 0).toFixed(3)}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="grid" style={{ marginTop: 16, gridTemplateColumns: "1fr" }}>
        <div className="panel">
          <div className="eyebrow">Journal des taches IA <HelpHint text="Historique des tâches IA pour revoir ce qui a tourné, ce qui a échoué et ce qui mérite un tri." examples={["Si l'historique montre beaucoup de passages dégradés, il faut regarder la capacité ou les routes.", "Nettoyer l'historique sert à garder un journal lisible, pas à cacher un problème."]} /></div>
          <div style={{ display: "flex", gap: 10, marginTop: 12, marginBottom: 12 }}>
            <button type="button" onClick={() => clearOldHistory()} disabled={clearingHistory}>{clearingHistory ? "Nettoyage..." : "Nettoyer l'historique"}</button>
            <button type="button" onClick={() => reloadDesk().catch((err) => setError(err instanceof Error ? err.message : "Reload impossible"))} disabled={loading || warming !== null || clearingHistory || regimeBusy || backtestBusy}>Rafraichir</button>
          </div>
          {history.length === 0 ? <p className="subtle">Aucune execution historisee.</p> : null}
          <div className="txt-scroll-shell">
            {history.map((row) => (
              <div className="row" key={String(row.id)}>
                <span>{formatDateTime(row.created_at)} | {normalizeText(row.task)} | {normalizeText(row.provider_used)} / {normalizeText(row.model_used)}</span>
                <span>{normalizeText(row.status)} | fallback {String(Boolean(row.fallback_used))} | {formatMs(toNumber(row.latency_ms, 0))}</span>
              </div>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
