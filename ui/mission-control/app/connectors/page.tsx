"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import HelpHint from "../../components/HelpHint";
import OperatorPanelGuide from "../../components/ui/OperatorPanelGuide";
import {
  BROKER_CONNECTION_CATALOG,
  EXCHANGE_CONNECTION_CATALOG,
  WALLET_CONNECTION_CATALOG,
  type ConnectionProviderType,
} from "../../lib/connectionCatalog";
import { getConnectorHealthView } from "../../lib/connectorHealth";

type JsonMap = Record<string, unknown>;

function asMap(value: unknown): JsonMap {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonMap : {};
}

function asList(value: unknown): JsonMap[] {
  return Array.isArray(value) ? value.filter((item): item is JsonMap => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}

function formatUsd(value: unknown): string {
  const amount = Number(value || 0);
  return `${amount.toFixed(Math.abs(amount) >= 100 ? 0 : 2)} USD`;
}

function formatPct(value: unknown, digits = 1): string {
  const amount = Number(value || 0);
  return `${amount.toFixed(digits)}%`;
}

function formatMs(value: unknown): string {
  const amount = Number(value);
  return Number.isFinite(amount) ? `${amount.toFixed(amount >= 100 ? 0 : 1)} ms` : "n/a";
}

function formatRate(value: unknown): string {
  const amount = Number(value);
  return Number.isFinite(amount) ? `${amount.toFixed(2)} msg/s` : "n/a";
}

function formatBps(value: unknown): string {
  const amount = Number(value);
  return Number.isFinite(amount) ? `${amount.toFixed(2)} bps` : "n/a";
}

function formatMaybeInt(value: unknown, suffix = ""): string {
  const amount = Number(value);
  return Number.isFinite(amount) ? `${Math.round(amount)}${suffix}` : "n/a";
}

function formatCapabilityLabel(value: unknown): string {
  const label = String(value || "").trim();
  return label ? label.replace(/_/g, " ").toUpperCase() : "N/A";
}

function toneClass(value: string): string {
  if (["clean", "ok", "resolved"].includes(value)) {
    return "good";
  }
  if (["watch", "degraded"].includes(value)) {
    return "subtle";
  }
  return "warn";
}

function buildConnectorsWsUrl(token: string, controlPlaneUrl?: string): string {
  if (typeof window === "undefined") {
    return "";
  }
  const currentProtocol = window.location.protocol === "https:" ? "wss" : "ws";
  const currentBase = `${currentProtocol}://${window.location.host}`;
  const configured = String(controlPlaneUrl || "").trim();
  if (!configured) {
    return `${currentBase}/v1/connectors/ws?token=${encodeURIComponent(token)}`;
  }
  try {
    const parsed = new URL(configured);
    if (["localhost", "127.0.0.1", "0.0.0.0", "control-plane"].includes(parsed.hostname)) {
      return `${currentBase}/v1/connectors/ws?token=${encodeURIComponent(token)}`;
    }
    const protocol = parsed.protocol === "https:" ? "wss" : "ws";
    return `${protocol}://${parsed.host}/v1/connectors/ws?token=${encodeURIComponent(token)}`;
  } catch {
    return `${currentBase}/v1/connectors/ws?token=${encodeURIComponent(token)}`;
  }
}

export default function ConnectorsPage() {
  const [status, setStatus] = useState<JsonMap | null>(null);
  const [mt5Health, setMt5Health] = useState<JsonMap | null>(null);
  const [mt5Accounts, setMt5Accounts] = useState<JsonMap[]>([]);
  const [canonicalAccounts, setCanonicalAccounts] = useState<JsonMap[]>([]);
  const [portfolioRisk, setPortfolioRisk] = useState<JsonMap | null>(null);
  const [pendingLive, setPendingLive] = useState<JsonMap[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<JsonMap | null>(null);
  const [voiceAvailable, setVoiceAvailable] = useState(false);
  const [voiceListening, setVoiceListening] = useState(false);
  const [voiceTranscript, setVoiceTranscript] = useState("");
  const [lastAlertSignature, setLastAlertSignature] = useState("");

  const [accountId, setAccountId] = useState("mt5-demo-01");
  const [broker, setBroker] = useState("metaquotes");
  const [server, setServer] = useState("MetaQuotes-Demo");
  const [login, setLogin] = useState("10001234");
  const [mode, setMode] = useState("paper");
  const [clientId, setClientId] = useState("");
  const [clientName, setClientName] = useState("");
  const [portfolioId, setPortfolioId] = useState("");

  const [orderSymbol, setOrderSymbol] = useState("EURUSD");
  const [orderSide, setOrderSide] = useState("buy");
  const [orderLots, setOrderLots] = useState(0.1);
  const [orderNotional, setOrderNotional] = useState(12000);
  const [orderSpread, setOrderSpread] = useState(12);
  const [orderWhy, setOrderWhy] = useState("Regime aligned entry");

  const [trendScore, setTrendScore] = useState(0.4);
  const [realizedVolatility, setRealizedVolatility] = useState(0.05);
  const [sentimentScore, setSentimentScore] = useState(0.2);
  const [regimeResult, setRegimeResult] = useState<JsonMap | null>(null);

  const [scenario, setScenario] = useState("Fed emergency hike");
  const [backtestResult, setBacktestResult] = useState<JsonMap | null>(null);
  const [connectionProviderType, setConnectionProviderType] = useState<ConnectionProviderType>("broker");
  const [connectionProviderName, setConnectionProviderName] = useState("MT5 / MetaTrader 5");
  const [connectionMarketScope, setConnectionMarketScope] = useState("CFD / forex / futures / commodities / stocks");
  const [connectionMode, setConnectionMode] = useState("bridge-direct");
  const [connectionReference, setConnectionReference] = useState("");
  const [connectionNotes, setConnectionNotes] = useState("");
  const [connectionRequestBusy, setConnectionRequestBusy] = useState(false);
  const [connectionRequestResult, setConnectionRequestResult] = useState<JsonMap | null>(null);

  async function loadAll(): Promise<void> {
    const [statusRes, healthRes, mt5AccountsRes, canonicalAccountsRes, portfolioRiskRes, pendingRes] = await Promise.all([
      fetch("/api/connectors/status", { cache: "no-store" }),
      fetch("/api/mt5/health", { cache: "no-store" }),
      fetch("/api/mt5/accounts", { cache: "no-store" }),
      fetch("/api/accounts", { cache: "no-store" }),
      fetch("/api/portfolios/pf-internal-main/risk", { cache: "no-store" }),
      fetch("/api/mt5/orders/live-pending", { cache: "no-store" }),
    ]);

    if (!statusRes.ok || !healthRes.ok || !mt5AccountsRes.ok || !canonicalAccountsRes.ok || !portfolioRiskRes.ok || !pendingRes.ok) {
      throw new Error("Impossible de charger les connecteurs");
    }

    setStatus(await statusRes.json());
    setMt5Health(await healthRes.json());
    setMt5Accounts(await mt5AccountsRes.json());
    setCanonicalAccounts(await canonicalAccountsRes.json());
    setPortfolioRisk(await portfolioRiskRes.json());
    setPendingLive(await pendingRes.json());
  }

  useEffect(() => {
    loadAll().catch((err) => setError(err instanceof Error ? err.message : "Erreur inconnue"));

    let ws: WebSocket | null = null;
    let cancelled = false;

    (async () => {
      try {
        const tokenRes = await fetch("/api/auth/ws-token", { cache: "no-store" });
        if (!tokenRes.ok) {
          return;
        }
        const tokenPayload = await tokenRes.json();
        const token = String(tokenPayload.token || "");
        if (!token) {
          return;
        }

        const wsUrl = buildConnectorsWsUrl(token, String(tokenPayload.controlPlaneUrl || ""));
        ws = new WebSocket(wsUrl);
        ws.onmessage = (event) => {
          if (cancelled) {
            return;
          }
          try {
            const payload = JSON.parse(String(event.data || "{}"));
            setStatus(payload);
          } catch {
            // ignore malformed frames
          }
        };
      } catch {
        // keep HTTP fallback only
      }
    })();

    return () => {
      cancelled = true;
      if (ws) {
        ws.close();
      }
    };
  }, []);

  useEffect(() => {
    const alerts = (status?.alerts as JsonMap[] | undefined) || [];
    if (alerts.length === 0) {
      return;
    }
    const signature = JSON.stringify(alerts.map((a) => `${String(a.type)}:${String(a.message)}`));
    if (!signature || signature === lastAlertSignature) {
      return;
    }
    setLastAlertSignature(signature);

    // Short non-intrusive alert beep for new websocket alerts.
    try {
      const audioCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      const oscillator = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(880, audioCtx.currentTime);
      gain.gain.setValueAtTime(0.0001, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.08, audioCtx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.18);
      oscillator.connect(gain);
      gain.connect(audioCtx.destination);
      oscillator.start();
      oscillator.stop(audioCtx.currentTime + 0.2);
    } catch {
      // Ignore environments where WebAudio is unavailable.
    }
  }, [status, lastAlertSignature]);

  useEffect(() => {
    const speech = typeof window !== "undefined" ? (window as unknown as { SpeechRecognition?: any; webkitSpeechRecognition?: any }) : null;
    const SpeechRecognition = speech?.SpeechRecognition || speech?.webkitSpeechRecognition;
    setVoiceAvailable(Boolean(SpeechRecognition));
  }, []);

  async function connectMt5(): Promise<void> {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch("/api/mt5/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account_id: accountId,
          broker,
          server,
          login,
          mode,
          metadata: {
            source: "mission-control-ui",
            ...(clientId ? { client_id: clientId } : {}),
            ...(clientName ? { client_name: clientName } : {}),
            ...(portfolioId ? { portfolio_id: portfolioId } : {}),
          },
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(String(payload?.detail || "Connexion MT5 echouee"));
      }
      setResult(payload);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur inconnue");
    } finally {
      setBusy(false);
    }
  }

  async function rebuildMt5Projections(): Promise<void> {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch("/api/system/mt5-rebuild", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(String((payload as JsonMap)?.detail || "Rebuild MT5 impossible"));
      }
      setResult((payload || null) as JsonMap | null);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Rebuild MT5 impossible");
    } finally {
      setBusy(false);
    }
  }

  async function sendFilteredOrder(): Promise<void> {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch("/api/mt5/orders/filter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account_id: accountId,
          symbol: orderSymbol,
          side: orderSide,
          lots: orderLots,
          estimated_notional_usd: orderNotional,
          max_spread_bps: orderSpread,
          rationale: orderWhy,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(String(payload?.detail || "Ordre filtre rejete"));
      }
      setResult(payload);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur inconnue");
    } finally {
      setBusy(false);
    }
  }

  async function approveLiveOrder(approvalId: string): Promise<void> {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch(`/api/mt5/orders/live-approve/${approvalId}`, {
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(String(payload?.detail || "Validation live echouee"));
      }
      setResult(payload);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur inconnue");
    } finally {
      setBusy(false);
    }
  }

  async function detectRegime(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/ai/regimes/detect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trend_score: trendScore, realized_volatility: realizedVolatility, sentiment_score: sentimentScore }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(String(payload?.detail || "Detection de regime echouee"));
      }
      setRegimeResult(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur inconnue");
    } finally {
      setBusy(false);
    }
  }

  async function runBacktest(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/ai/backtests/geopolitical", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          strategy_name: "mt5-regime-allocator",
          asset_class: "forex-indices",
          scenario,
          horizon_days: 20,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(String(payload?.detail || "Backtest geopol echoue"));
      }
      setBacktestResult(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur inconnue");
    } finally {
      setBusy(false);
    }
  }

  async function requestConnectionOnboarding(): Promise<void> {
    setConnectionRequestBusy(true);
    setError(null);
    setConnectionRequestResult(null);
    try {
      const response = await fetch("/api/incidents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: `connection_onboarding:${connectionProviderName}`,
          severity: "medium",
          payload: {
            type: connectionProviderType,
            provider: connectionProviderName,
            market_scope: connectionMarketScope,
            connection_mode: connectionMode,
            reference: connectionReference,
            notes: connectionNotes,
            source: "connectors-page",
          },
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(String(payload?.detail || "Demande d'onboarding impossible"));
      }
      setConnectionRequestResult((payload || null) as JsonMap | null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Demande d'onboarding impossible");
    } finally {
      setConnectionRequestBusy(false);
    }
  }

  function startVoiceCommand(): void {
    const speech = typeof window !== "undefined" ? (window as unknown as { SpeechRecognition?: any; webkitSpeechRecognition?: any }) : null;
    const SpeechRecognition = speech?.SpeechRecognition || speech?.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setError("Commande vocale non supportee sur ce navigateur");
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = "fr-FR";
    recognition.continuous = false;
    recognition.interimResults = false;
    setVoiceListening(true);

    recognition.onresult = (event: any) => {
      const transcript = String(event?.results?.[0]?.[0]?.transcript || "").toLowerCase();
      setVoiceTranscript(transcript);

      if (transcript.includes("connect") && transcript.includes("mt5")) {
        void connectMt5();
      } else if (transcript.includes("regime")) {
        void detectRegime();
      } else if (transcript.includes("backtest")) {
        void runBacktest();
      } else {
        setError("Commande vocale non reconnue. Exemples: connect mt5, detecte regime, lance backtest.");
      }
    };

    recognition.onerror = () => {
      setVoiceListening(false);
    };
    recognition.onend = () => {
      setVoiceListening(false);
    };
    recognition.start();
  }

  const connectors = (status?.connectors as JsonMap[] | undefined) || [];
  const alerts = (status?.alerts as JsonMap[] | undefined) || [];
  const recentApprovals = (status?.recent_live_approvals as JsonMap[] | undefined) || [];
  const pendingCount = Number(status?.pending_live_approvals || 0);
  const linkedConnectorAccounts = asList(status?.linked_accounts);
  const connectorDeskRows = connectors.filter((item) => {
    const capitalSummary = asMap(item.capital_summary);
    const incidentSummary = asMap(item.incident_summary);
    return Number(capitalSummary.account_count || 0) > 0 || Number(incidentSummary.active_count || 0) > 0 || Boolean(item.healthy);
  });
  const connectorCapitalRows = connectorDeskRows.filter((item) => Number(asMap(item.capital_summary).account_count || 0) > 0);
  const connectorIncidentRows = connectorDeskRows.filter((item) => Number(asMap(item.incident_summary).active_count || 0) > 0 || getConnectorHealthView(item).action !== "ok");
  const canonicalByAccount = new Map(canonicalAccounts.map((item) => [String(item.account_id || ""), item]));
  const brokerCapabilityRows = linkedConnectorAccounts.map((account) => {
    const permissionsView = asMap(account.permissions_view);
    const permissionFlags = asMap(permissionsView.permissions);
    const brokerCapabilities = asMap(account.broker_capabilities);
    const accountKey = String(account.account_id || account.reference || "n/a");
    const canonical = canonicalByAccount.get(accountKey);
    return {
      accountId: accountKey,
      provider: String(account.provider || brokerCapabilities.provider || "unknown"),
      preferredVenue: String(brokerCapabilities.preferred_venue || account.provider || "n/a"),
      replaceStrategy: String(brokerCapabilities.replace_strategy || "reslice_only"),
      supportsModify: Boolean(brokerCapabilities.supports_modify),
      supportsCancelReplace: Boolean(brokerCapabilities.supports_cancel_replace),
      supportsLiveCancel: Boolean(brokerCapabilities.supports_live_cancel),
      capabilitySource: String(brokerCapabilities.capability_source || "unknown"),
      canTrade: Boolean(permissionFlags.trade),
      authMethod: String(account.auth_method || "manual"),
      clientId: String(canonical?.client_id || account.client_id || "-"),
      portfolioId: String(canonical?.portfolio_id || account.portfolio_id || "-"),
      mode: String(canonical?.mode || account.mode || "n/a"),
    };
  }).sort((left, right) => {
    if (left.supportsCancelReplace !== right.supportsCancelReplace) {
      return Number(right.supportsCancelReplace) - Number(left.supportsCancelReplace);
    }
    if (left.supportsModify !== right.supportsModify) {
      return Number(right.supportsModify) - Number(left.supportsModify);
    }
    return `${left.provider}:${left.accountId}`.localeCompare(`${right.provider}:${right.accountId}`);
  });
  const brokerCapabilitySummary = brokerCapabilityRows.reduce((summary, item) => {
    summary.totalAccounts += 1;
    summary.tradableAccounts += Number(item.canTrade);
    summary.cancelReplaceAccounts += Number(item.supportsCancelReplace);
    summary.modifyAccounts += Number(item.supportsModify);
    summary.liveCancelAccounts += Number(item.supportsLiveCancel);
    summary.resliceOnlyAccounts += Number(item.replaceStrategy === "reslice_only");
    return summary;
  }, {
    totalAccounts: 0,
    tradableAccounts: 0,
    cancelReplaceAccounts: 0,
    modifyAccounts: 0,
    liveCancelAccounts: 0,
    resliceOnlyAccounts: 0,
  });
  const clientPortfolioSummaries = Array.from(
    canonicalAccounts.reduce((map, item) => {
      const clientKey = String(item.client_id || "unknown-client");
      const portfolioKey = String(item.portfolio_id || "unassigned");
      const key = `${clientKey}:${portfolioKey}`;
      const current = map.get(key) || {
        client_id: clientKey,
        portfolio_id: portfolioKey,
        account_count: 0,
        equity_usd: 0,
        gross_exposure_usd: 0,
        net_exposure_usd: 0,
        open_positions: 0,
      };
      current.account_count += 1;
      current.equity_usd += Number(item.latest_equity_usd || 0);
      current.gross_exposure_usd += Number(item.gross_exposure_usd || 0);
      current.net_exposure_usd += Number(item.net_exposure_usd || 0);
      current.open_positions += Number(item.open_positions || 0);
      map.set(key, current);
      return map;
    }, new Map<string, { client_id: string; portfolio_id: string; account_count: number; equity_usd: number; gross_exposure_usd: number; net_exposure_usd: number; open_positions: number }>())
  ).sort((left, right) => right[1].equity_usd - left[1].equity_usd).map((entry) => entry[1]);

  return (
    <main className="shell txt-page-shell" data-testid="mission-control-connectors-page">
      <section className="hero txt-page-hero-grid" style={{ gridTemplateColumns: "1.4fr 1fr" }}>
        <div id="global-guide-connectors-hero" className="panel txt-page-hero">
          <div className="eyebrow">Horizon Quantique</div>
          <h1 className="title" style={{ fontSize: 34 }}>Connecteurs trading augmentes</h1>
          <p className="subtle txt-page-hero-copy">
            Cette page dit si l'infrastructure d'execution tient vraiment: connecteurs sains, comptes visibles, capacites d'ordre et plans de secours par venue.
          </p>
          <OperatorPanelGuide
            title="Guide Connecteurs"
            what="Etat temps reel des ponts broker, execution et flux de marche."
            why="Eviter d'envoyer des ordres quand l'infrastructure est degradee."
            example="Si MT5 status n'est pas healthy et qu'une alerte critique apparait, stoppe les executions live."
            terms={["spread", "slippage", "latency"]}
          />
          <div className="txt-page-guide-note">
            <strong>Lecture rapide</strong>
            1. Verifie que le bridge et les connecteurs sont sains. 2. Controle les comptes et les droits. 3. Confirme le chemin de modification d'ordre. 4. Seulement ensuite, laisse le desk executer.
          </div>
          <p>
            <Link href="/">Retour dashboard</Link> | <Link href="/ai">Ecran IA</Link>
            {" | "}
            <Link href="/terminal">Trading Terminal</Link>
            {" | "}
            <Link href="/live-capital">Live Capital</Link>
            {" | "}
            <Link href="/connections">Parcours client Connections</Link>
            {" | "}
            <Link href="/live-readiness">Live Readiness</Link>
            {" | "}
            <Link href="/incidents">Incidents</Link>
          </p>
          {error ? <p className="warn">{error}</p> : null}
        </div>

        <div className="panel">
          <div className="eyebrow">MT5 Bridge <HelpHint text="Sante bridge MT5 et compteur des validations live en attente." examples={["Si Pending live approvals monte, un second validateur doit venir ici ou sur le terminal.", "Si status n'est pas healthy, n'envoie pas de nouvel ordre live."]} /></div>
          <div className="row"><span>Status</span><span>{String(mt5Health?.status || "-")}</span></div>
          <div className="row"><span>Mode</span><span>{String(mt5Health?.mode || "-")}</span></div>
          <div className="row"><span>Accounts</span><span>{String(mt5Health?.accounts || 0)}</span></div>
          <div className="row"><span>Equity canonique</span><span>{Number(portfolioRisk?.equity_usd || 0).toFixed(0)} USD</span></div>
          <div className="row"><span>Gross exposure</span><span>{Number(portfolioRisk?.gross_exposure_usd || 0).toFixed(0)} USD</span></div>
          <div className="row"><span>Concentration max</span><span>{Number(portfolioRisk?.concentration_pct || 0).toFixed(1)}%</span></div>
          <div className="row"><span>Pending live approvals</span><span>{String(pendingCount)}</span></div>
          <div style={{ marginTop: 10 }}>
            <button type="button" onClick={() => startVoiceCommand()} disabled={!voiceAvailable || voiceListening}>
              {voiceListening ? "Ecoute en cours..." : "Commande vocale"}
            </button>
            <button type="button" onClick={() => rebuildMt5Projections()} disabled={busy} style={{ marginLeft: 10 }}>
              {busy ? "Traitement..." : "Rebuild projections MT5"}
            </button>
          </div>
          {voiceTranscript ? <p className="subtle" style={{ marginTop: 8 }}>Derniere commande: {voiceTranscript}</p> : null}
        </div>
      </section>

      <section className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <div className="panel">
          <div className="eyebrow">Connecteurs Live <HelpHint text="Disponibilite instantanee des integrations critiques." examples={["Chaque ligne doit etre healthy=true avant une vraie session de trading.", "Si un connecteur devient false, considere l'environnement comme degrade jusqu'a verification."]} /></div>
          <div className="txt-scroll-shell">
            {connectors.map((item) => {
              const badge = getConnectorHealthView(item);
              return (
                <div className="row" key={String(item.name)}>
                  <span>{String(item.name)} ({String(item.transport)}) | REST {formatMs(item.rest_latency_ms)} | WS {formatMs(item.websocket_latency_ms)}</span>
                  <span className="connector-health-stack">
                    <span className={badge.badgeClassName}>{badge.label}</span>
                    <span className={badge.noteClassName}>{badge.message}</span>
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="panel">
          <div className="eyebrow">Comptes MT5 <HelpHint text="Inventaire des comptes raccordes et leur mode paper/live." examples={["Cherche ici ton compte demo pour verifier qu'il est bien en paper avant un test.", "Ne bascule pas en live sans voir clairement le mode et le status attendus."]} /></div>
          {mt5Accounts.length === 0 ? <p className="subtle">Aucun compte connecte.</p> : null}
          <div className="txt-scroll-shell">
            {mt5Accounts.map((item) => (
              <div className="row" key={String(item.account_id)}>
                <span>
                  {String(item.account_id)} | {String(item.server)}
                  {canonicalByAccount.get(String(item.account_id))
                    ? ` | client ${String(canonicalByAccount.get(String(item.account_id))?.client_id || "-")} | equity ${Number(canonicalByAccount.get(String(item.account_id))?.latest_equity_usd || 0).toFixed(0)} USD | pos ${Number(canonicalByAccount.get(String(item.account_id))?.open_positions || 0)}`
                    : " | sync pending"}
                </span>
                <span>{String(item.mode)} / {String(item.status)}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="grid" style={{ marginTop: 16, gridTemplateColumns: "0.85fr 1.15fr" }}>
        <div className="panel">
          <div className="eyebrow">Capacites d'execution par compte <HelpHint text="Vue operateur dediee pour voir quel compte peut vraiment executer un cancel/replace natif et quel compte reste en reslice." examples={["Si un compte affiche CANCEL REPLACE=true et MODIFY=false, le scheduler doit rester sur cancel_replace et non sur amend natif.", "Si un compte est trade=false, traite ses capacites comme purement informatives tant qu'il n'est pas habilite execution."]} /></div>
          <div className="row"><span>Comptes lies</span><span>{String(brokerCapabilitySummary.totalAccounts)}</span></div>
          <div className="row"><span>Comptes trade enabled</span><span>{String(brokerCapabilitySummary.tradableAccounts)}</span></div>
          <div className="row"><span>Cancel/replace natif</span><span className={brokerCapabilitySummary.cancelReplaceAccounts > 0 ? "good" : "subtle"}>{String(brokerCapabilitySummary.cancelReplaceAccounts)}</span></div>
          <div className="row"><span>Modify natif</span><span className={brokerCapabilitySummary.modifyAccounts > 0 ? "good" : "subtle"}>{String(brokerCapabilitySummary.modifyAccounts)}</span></div>
          <div className="row"><span>Live cancel disponible</span><span>{String(brokerCapabilitySummary.liveCancelAccounts)}</span></div>
          <div className="row"><span>Fallback reslice only</span><span>{String(brokerCapabilitySummary.resliceOnlyAccounts)}</span></div>
          <p className="subtle" style={{ marginTop: 10 }}>
            Aucun amend broker natif n'est confirme dans la stack actuelle. La strategie MODIFY reste volontairement inactive tant qu'une vraie route backend broker n'existe pas.
          </p>
        </div>

        <div className="panel">
          <div className="eyebrow">Chemin de modification par compte <HelpHint text="Lecture directe du chemin de remplacement expose par le control-plane pour chaque compte lie." examples={["Un compte BingX doit aujourd'hui montrer replace strategy = CANCEL REPLACE et modify = false.", "Si un futur broker confirme amend natif, cette matrice devra montrer MODIFY avant tout basculement du scheduler."]} /></div>
          {brokerCapabilityRows.length === 0 ? <p className="subtle">Aucun compte lie avec broker_capabilities.</p> : null}
          <div className="txt-scroll-shell">
            {brokerCapabilityRows.map((item) => (
              <div className="panel" key={`broker-capability-${item.provider}-${item.accountId}`} style={{ borderRadius: 12 }}>
                <div className="row"><span>{item.provider} | {item.accountId}</span><span>{item.canTrade ? "trade enabled" : "read only"}</span></div>
                <div className="row"><span>Replace strategy</span><span>{formatCapabilityLabel(item.replaceStrategy)}</span></div>
                <div className="row"><span>Capabilities</span><span><span className={item.supportsCancelReplace ? "good" : "subtle"}>cancel_replace={String(item.supportsCancelReplace)}</span> | <span className={item.supportsModify ? "good" : "subtle"}>modify={String(item.supportsModify)}</span> | <span className={item.supportsLiveCancel ? "good" : "subtle"}>live_cancel={String(item.supportsLiveCancel)}</span></span></div>
                <div className="row"><span>Venue / auth</span><span>{item.preferredVenue} | {item.authMethod}</span></div>
                <div className="row"><span>Client / portfolio</span><span>{item.clientId} | {item.portfolioId}</span></div>
                <div className="row"><span>Mode / source</span><span>{item.mode} | {item.capabilitySource}</span></div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="grid" style={{ marginTop: 16, gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))" }}>
        {connectorDeskRows.map((item) => {
          const feedQuality = asMap(item.feed_quality);
          const incidentSummary = asMap(item.incident_summary);
          const degradation = asMap(item.degradation_engine);
          const badge = getConnectorHealthView(item);
          return (
            <div className="panel" key={`quality-${String(item.name)}`}>
              <div className="eyebrow">Health & Latency | {String(item.name)}</div>
              <div style={{ marginBottom: 12 }}>
                <span className={badge.badgeClassName}>{badge.label}</span>
                <div className={badge.noteClassName} style={{ marginTop: 8 }}>{badge.message}</div>
              </div>
              <div className="row"><span>Etat engine</span><span className={toneClass(String(degradation.state || "watch"))}>{String(degradation.state || "watch")}</span></div>
              <div className="row"><span>Health score</span><span>{badge.scoreText}</span></div>
              <div className="row"><span>Action</span><span>{String(degradation.health_action || badge.action)}</span></div>
              <div className="row"><span>Latence REST</span><span>{formatMs(item.rest_latency_ms)}</span></div>
              <div className="row"><span>Latence WebSocket</span><span>{formatMs(item.websocket_latency_ms)}</span></div>
              <div className="row"><span>Taux d'erreur 24h</span><span>{formatPct(item.error_rate_pct, 2)}</span></div>
              <div className="row"><span>Taux throttling</span><span>{formatPct(item.throttling_rate_pct, 2)}</span></div>
              <div className="row"><span>Uptime observe 24h</span><span>{formatPct(item.uptime_24h_pct, 2)}</span></div>
              <div className="row"><span>Uptime observe 7j</span><span>{formatPct(item.uptime_7d_pct, 2)}</span></div>
              <div className="row"><span>Profondeur recue</span><span>{formatMaybeInt(item.depth_levels, " niveaux")}</span></div>
              <div className="row"><span>Debit</span><span>{formatRate(item.messages_per_sec)}</span></div>
              <div className="row"><span>Flux observe</span><span>{item.market_feed_venue ? `${String(item.market_feed_venue)} | ${String(item.market_feed_instrument || "n/a")}` : "n/a"}</span></div>
              <div className="row"><span>Spread observe</span><span>{formatBps(feedQuality.spread_bps)}</span></div>
              <div className="row"><span>Feed quality</span><span className={toneClass(String(feedQuality.status || "watch"))}>{String(feedQuality.status || "watch")} ({formatMaybeInt(feedQuality.score)})</span></div>
              <div className="row"><span>Gaps / desync</span><span>{formatMaybeInt(feedQuality.gap_count, " gaps")} | {formatMs(feedQuality.desync_ms)}</span></div>
              <div className="row"><span>Dernier sync compte</span><span>{formatMaybeInt(item.latest_sync_age_sec, " s")}</span></div>
              <div className="row"><span>Incidents actifs</span><span>{formatMaybeInt(incidentSummary.active_count)}</span></div>
            </div>
          );
        })}
      </section>

      <section className="grid" style={{ marginTop: 16, gridTemplateColumns: "1.1fr 1fr" }}>
        <div className="panel">
          <div className="eyebrow">Droits par connecteur <HelpHint text="Granularite des droits, scopes et contraintes de signature par compte lie." examples={["Vrifie qu'un compte exchange n'a pas withdraw=true si son role est uniquement execution.", "Pour les wallets, la policy doit montrer hardware, MPC ou signer externe, jamais une cle privee en clair."]} /></div>
          {linkedConnectorAccounts.length === 0 ? <p className="subtle">Aucun compte lie.</p> : null}
          <div className="txt-scroll-shell">
            {linkedConnectorAccounts.map((account) => {
              const permissionsView = asMap(account.permissions_view);
              const permissionFlags = asMap(permissionsView.permissions);
              const rateLimits = asMap(permissionsView.rate_limits);
              return (
                <div className="panel" key={`perm-${String(account.provider)}-${String(account.account_id)}`} style={{ borderRadius: 12 }}>
                  <div className="row"><span>{String(account.provider)} | {String(account.account_id)}</span><span>{String(account.auth_method || "manual")}</span></div>
                  <div className="row"><span>Permissions</span><span>read={String(Boolean(permissionFlags.read))} | trade={String(Boolean(permissionFlags.trade))} | withdraw={String(Boolean(permissionFlags.withdraw))} | sign={String(Boolean(permissionFlags.sign))}</span></div>
                  <div className="row"><span>Scopes actifs</span><span>{String((permissionsView.scopes as string[] | undefined)?.join(", ") || "n/a")}</span></div>
                  <div className="row"><span>Rate-limit</span><span>{Object.entries(rateLimits).map(([key, value]) => `${key}:${String(value)}`).join(" | ") || "n/a"}</span></div>
                  <div className="row"><span>Sub-comptes</span><span>{((permissionsView.subaccount_restrictions as string[] | undefined) || []).join(", ") || "n/a"}</span></div>
                  <div className="row"><span>Whitelists</span><span>{((permissionsView.withdraw_whitelist as string[] | undefined) || []).join(", ") || "n/a"}</span></div>
                  <div className="row"><span>Signature policy</span><span>{String(permissionsView.signature_policy || "unknown")}</span></div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="panel">
          <div className="eyebrow">Plan de secours par connecteur <HelpHint text="Diagnostic et plan d'auto-downgrade par venue." examples={["Si WS drop ou feed degraded, la chaine doit montrer WS -> REST -> stale cache.", "Si l'etat devient critical, le live doit passer read-only et proposer un reroute venue."]} /></div>
          {connectorIncidentRows.length === 0 ? <p className="subtle">Aucune degradation active.</p> : null}
          <div className="txt-scroll-shell">
            {connectorIncidentRows.map((item) => {
              const incidentSummary = asMap(item.incident_summary);
              const degradation = asMap(item.degradation_engine);
              const badge = getConnectorHealthView(item);
              return (
                <div className="panel" key={`degrade-${String(item.name)}`} style={{ borderRadius: 12 }}>
                  <div className="row"><span>{String(item.name)}</span><span className={badge.badgeClassName}>{badge.label}</span></div>
                  <div className={badge.noteClassName} style={{ marginBottom: 10 }}>{badge.message}</div>
                  <div className="row"><span>Diagnostic</span><span>{String(degradation.diagnostic || incidentSummary.top_diagnostic || "nominal")}</span></div>
                  <div className="row"><span>Health score</span><span>{badge.scoreText}</span></div>
                  <div className="row"><span>Action</span><span>{String(degradation.health_action || badge.action)}</span></div>
                  <div className="row"><span>Path</span><span>{((degradation.auto_downgrade_path as string[] | undefined) || []).join(" -> ") || "n/a"}</span></div>
                  <div className="row"><span>Auto-disable</span><span>{String(Boolean(degradation.auto_disable_live))}</span></div>
                  <div className="row"><span>Auto-reroute</span><span>{String(degradation.auto_reroute_target || "n/a")}</span></div>
                  <div className="row"><span>Incidents</span><span>actifs {formatMaybeInt(incidentSummary.active_count)} | critiques {formatMaybeInt(incidentSummary.critical_count)} | throttling {formatMaybeInt(incidentSummary.throttling_count)}</span></div>
                  <div className="row"><span>Historique</span><span>{asList(incidentSummary.history).map((entry) => `${String(entry.severity)}:${String(entry.title)}`).join(" | ") || "n/a"}</span></div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section className="grid" style={{ marginTop: 16, gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))" }}>
        {connectorCapitalRows.map((item) => {
          const capital = asMap(item.capital_summary);
          const pockets = asList(capital.pockets);
          const topRisks = asList(capital.top_risks);
          return (
            <div className="panel" key={`capital-${String(item.name)}`}>
              <div className="eyebrow">Capital Integration | {String(item.name)} <HelpHint text="Vision capital et risque par venue/connecteur raccorde au Fund Manager." examples={["Compare valeur plateforme et cash brut pour savoir si la venue est sur-inventorisee ou vraiment liquide.", "Regarde le drift vs Fund Manager avant de laisser l'OMS router plus de risque sur cette venue."]} /></div>
              <div className="row"><span>Valeur plateforme</span><span>{formatUsd(capital.actual_equivalent_usd)}</span></div>
              <div className="row"><span>Cash brut</span><span>{formatUsd(capital.actual_raw_cash_usd)}</span></div>
              <div className="row"><span>Inventaire</span><span>{formatUsd(capital.inventory_usd)}</span></div>
              <div className="row"><span>Marge disponible</span><span>{formatUsd(capital.margin_available_usd)}</span></div>
              <div className="row"><span>Solvabilite venue</span><span>{formatPct(capital.solvency_ratio_pct, 2)}</span></div>
              <div className="row"><span>Risque venue</span><span>gross {formatUsd(capital.gross_exposure_usd)} | net {formatUsd(capital.net_exposure_usd)}</span></div>
              <div className="row"><span>Concentration</span><span>{formatPct(capital.concentration_pct, 2)}</span></div>
              <div className="row"><span>Drift vs Fund Manager</span><span>{formatUsd(capital.drift_vs_fund_manager_usd)}</span></div>
              <div className="row"><span>Cashflow / funding</span><span>{formatUsd(capital.net_external_cashflow_usd)} | {formatUsd(capital.funding_fee_usd)}</span></div>
              <div className="row"><span>Poches</span><span>{pockets.map((pocket) => `${String(pocket.pocket)}:${formatUsd(pocket.equivalent_usd)}`).join(" | ") || "n/a"}</span></div>
              <div className="row"><span>Top risk</span><span>{topRisks.map((risk) => `${String(risk.symbol)}:${formatUsd(risk.gross_notional_usd)}`).join(" | ") || "n/a"}</span></div>
            </div>
          );
        })}
      </section>

      <section className="grid" style={{ marginTop: 16, gridTemplateColumns: "1fr" }}>
        <div className="panel">
          <div className="eyebrow">Vue Client / Portfolio <HelpHint text="Agrgat interne client par client pour verifier la repartition des comptes et l'exposition canonique." examples={["Un client peut porter plusieurs comptes mais un seul portfolio ops principal.", "Cette vue aide a repérer un compte MT5 rattache au mauvais client ou au mauvais portfolio."]} /></div>
          {clientPortfolioSummaries.length === 0 ? <p className="subtle">Aucun portfolio canonique disponible.</p> : null}
          {clientPortfolioSummaries.map((item) => (
            <div className="row" key={`${item.client_id}-${item.portfolio_id}`}>
              <span>{item.client_id} | {item.portfolio_id} | comptes {item.account_count} | positions {item.open_positions}</span>
              <span>equity {item.equity_usd.toFixed(0)} USD | gross {item.gross_exposure_usd.toFixed(0)} USD</span>
            </div>
          ))}
        </div>
      </section>

      <section className="grid" style={{ marginTop: 16, gridTemplateColumns: "1fr 1fr" }}>
        <div className="panel">
          <div className="eyebrow">Alertes Temps Reel <HelpHint text="Alertes websocket: kill-switch, validations live, incidents." examples={["Si une alerte kill-switch apparait, stoppe les actions execution et va d'abord sur Incidents.", "Si une alerte live approval arrive, ouvre le bloc de double validation juste en dessous."]} /></div>
          {alerts.length === 0 ? <p className="subtle">Aucune alerte active.</p> : null}
          {alerts.map((item, idx) => (
            <div className="row" key={`${String(item.type)}-${idx}`}>
              <span>{String(item.type)}</span>
              <span className={String(item.level) === "critical" ? "warn" : "subtle"}>{String(item.message)}</span>
            </div>
          ))}
        </div>

        <div className="panel">
          <div className="eyebrow">Historique Validations Live <HelpHint text="Traite la preuve de double approbation des ordres live." examples={["Apres un ordre live, verifie ici qui a fait la seconde approbation.", "Si une validation manque, ne considere pas l'execution comme completement gouvernee."]} /></div>
          {recentApprovals.length === 0 ? <p className="subtle">Aucune validation live recente.</p> : null}
          {recentApprovals.map((item) => (
            <div className="row" key={String(item.approval_id)}>
              <span>{String(item.approval_id)} | {String(item.account_id)}</span>
              <span>{String(item.status)} | {String(item.second_approved_by || "-")}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="grid" style={{ marginTop: 16, gridTemplateColumns: "1fr 1fr" }}>
        <div className="panel">
          <div className="eyebrow">Connexion MT5 <HelpHint text="Formulaire de raccordement compte MT5 au bridge." examples={["Exemple: entre mt5-demo-01, serveur demo, login demo, puis clique Connecter le compte.", "Utilise paper pour tester le pipeline sans risque reel."]} /></div>
          <div className="form-grid" style={{ marginTop: 12 }}>
            <input value={accountId} onChange={(e) => setAccountId(e.target.value)} placeholder="account_id" />
            <input value={broker} onChange={(e) => setBroker(e.target.value)} placeholder="broker" />
            <input value={server} onChange={(e) => setServer(e.target.value)} placeholder="server" />
            <input value={login} onChange={(e) => setLogin(e.target.value)} placeholder="login" />
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="paper">paper</option>
              <option value="live">live</option>
            </select>
            <input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="client_id metier (optionnel)" />
            <input value={clientName} onChange={(e) => setClientName(e.target.value)} placeholder="client name (optionnel)" />
            <input value={portfolioId} onChange={(e) => setPortfolioId(e.target.value)} placeholder="portfolio_id (optionnel)" />
            <button type="button" onClick={() => connectMt5()} disabled={busy}>Connecter le compte</button>
          </div>
        </div>

        <div className="panel">
          <div className="eyebrow">Ordre MT5 Filtre par MWC <HelpHint text="Ordre soumis au risk gate et verifications spread/slippage." examples={["Exemple: EURUSD, buy, 0.10 lot, rationale concise, puis Soumettre ordre filtre.", "Si le spread est trop large, augmente l'exigence de prudence ou attends une meilleure liquidite."]} /></div>
          <div className="form-grid" style={{ marginTop: 12 }}>
            <input value={orderSymbol} onChange={(e) => setOrderSymbol(e.target.value)} placeholder="symbol" />
            <select value={orderSide} onChange={(e) => setOrderSide(e.target.value)}>
              <option value="buy">buy</option>
              <option value="sell">sell</option>
            </select>
            <input type="number" step="0.01" value={orderLots} onChange={(e) => setOrderLots(Number(e.target.value || 0))} placeholder="lots" />
            <input type="number" step="1" value={orderNotional} onChange={(e) => setOrderNotional(Number(e.target.value || 0))} placeholder="estimated_notional_usd" />
            <input type="number" step="1" value={orderSpread} onChange={(e) => setOrderSpread(Number(e.target.value || 0))} placeholder="max_spread_bps" />
            <input value={orderWhy} onChange={(e) => setOrderWhy(e.target.value)} placeholder="rationale" />
            <button type="button" onClick={() => sendFilteredOrder()} disabled={busy}>Soumettre ordre filtre</button>
          </div>
        </div>
      </section>

      <section className="grid" style={{ marginTop: 16, gridTemplateColumns: "1fr" }}>
        <div className="panel">
          <div className="eyebrow">Double Validation Live MT5 <HelpHint text="Second validateur requis pour execution compte live." examples={["Quand une demande arrive ici, un autre operateur doit cliquer Valider en second.", "Si rien n'apparait ici, l'ordre est soit en paper, soit pas encore eligibile au live."]} /></div>
          {pendingLive.length === 0 ? <p className="subtle">Aucune demande live en attente.</p> : null}
          {pendingLive.map((item) => (
            <div className="row" key={String(item.approval_id)}>
              <span>
                {String(item.approval_id)} | {String(item.account_id)} | premier validateur: {String(item.first_approved_by)}
              </span>
              <button type="button" disabled={busy} onClick={() => approveLiveOrder(String(item.approval_id))}>
                Valider en second
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className="grid" style={{ marginTop: 16, gridTemplateColumns: "1fr 1fr" }}>
        <div className="panel">
          <div className="eyebrow">Detection Regime Marche <HelpHint text="Inference regime pour adapter strategie et exposition." examples={["Entre trend_score, vol et sentiment pour savoir si le marche ressemble a trend, chop ou stress.", "Si le regime change, adapte ensuite les seuils de drift dans Live Readiness."]} /></div>
          <div className="form-grid" style={{ marginTop: 12 }}>
            <input type="number" step="0.01" value={trendScore} onChange={(e) => setTrendScore(Number(e.target.value || 0))} placeholder="trend_score" />
            <input type="number" step="0.001" value={realizedVolatility} onChange={(e) => setRealizedVolatility(Number(e.target.value || 0))} placeholder="realized_volatility" />
            <input type="number" step="0.01" value={sentimentScore} onChange={(e) => setSentimentScore(Number(e.target.value || 0))} placeholder="sentiment_score" />
            <button type="button" onClick={() => detectRegime()} disabled={busy}>Detecter regime</button>
          </div>
          {regimeResult ? (
            <div className="panel" style={{ marginTop: 12, borderRadius: 12 }}>
              <div className="row"><span>Regime</span><span>{String(regimeResult.regime || "-")}</span></div>
              <div className="row"><span>Confidence</span><span>{String(regimeResult.confidence || "-")}</span></div>
            </div>
          ) : null}
        </div>

        <div className="panel">
          <div className="eyebrow">Backtest IA Geopolitique <HelpHint text="Stress-test scenario pour mesurer resilience strategie." examples={["Exemple: Fed emergency hike puis Lance backtest pour mesurer la resilience.", "Si expected_max_drawdown est trop fort, ne promote pas la strategie sans retravail."]} /></div>
          <div className="form-grid" style={{ marginTop: 12 }}>
            <input value={scenario} onChange={(e) => setScenario(e.target.value)} placeholder="scenario" />
            <button type="button" onClick={() => runBacktest()} disabled={busy}>Lancer backtest</button>
          </div>
          {backtestResult ? (
            <div className="panel" style={{ marginTop: 12, borderRadius: 12 }}>
              <div className="row"><span>Resilience</span><span>{String(backtestResult.resilience_score || "-")}</span></div>
              <div className="row"><span>Expected max DD</span><span>{String(backtestResult.expected_max_drawdown || "-")}</span></div>
            </div>
          ) : null}
        </div>
      </section>

      <section className="grid" style={{ marginTop: 16, gridTemplateColumns: "1fr" }}>
        <div className="panel">
          <div className="eyebrow">Prop Firm sans MT5 <HelpHint text="Cadrage pour les clients prop qui utilisent une plateforme proprietaire au lieu de MT5." examples={["Si la firme expose une API, TXT doit passer par un adaptateur natif plateforme plutot que par MT5.", "Sans API, la bonne voie est souvent un connecteur OMS/FIX ou un workflow semi-assiste, pas un faux bridge fragile."]} /></div>
          <div className="row"><span>Option 1</span><span>Adaptateur natif plateforme</span></div>
          <div className="row"><span>Option 2</span><span>FIX / OpenAPI / broker SDK</span></div>
          <div className="row"><span>Option 3</span><span>OMS TXT + validation humaine</span></div>
          <div className="row"><span>A eviter</span><span>web automation fragile pour execution live</span></div>
          <p className="subtle" style={{ marginTop: 10 }}>
            Pour une prop firm sans MT5, on traite la plateforme comme un nouveau venue adapter. Le compte client reste dans TXT, mais l'execution doit passer par une integration native plateforme, FIX, ou un workflow gouverne semi-assiste si aucune API robuste n'existe.
          </p>
        </div>
      </section>

      <section className="grid" style={{ marginTop: 16, gridTemplateColumns: "1fr 1fr" }}>
        <div className="panel">
          <div className="eyebrow">Catalogue Brokers & Platforms</div>
          {[...BROKER_CONNECTION_CATALOG, ...EXCHANGE_CONNECTION_CATALOG].map((item) => (
            <div className="row" key={`${item.provider}-${item.mode}`}>
              <span>{item.provider} | {item.coverage}</span>
              <span>{item.mode}</span>
            </div>
          ))}
        </div>
        <div className="panel">
          <div className="eyebrow">Catalogue Wallets</div>
          {WALLET_CONNECTION_CATALOG.map((item) => (
            <div className="row" key={`${item.provider}-${item.mode}`}>
              <span>{item.provider} | {item.coverage}</span>
              <span>{item.mode}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="grid" style={{ marginTop: 16, gridTemplateColumns: "1fr 1fr" }}>
        <div className="panel">
          <div className="eyebrow">Onboarding Connection Hub <HelpHint text="Point d'entree unique pour les demandes de connexion client/trader hors MT5 natif." examples={["Choisis exchange puis OKX si le client veut brancher un compte API spot/perp.", "Choisis wallet puis MetaMask si le trader veut un flux on-chain signe depuis son navigateur."]} /></div>
          <div className="form-grid" style={{ marginTop: 12 }}>
            <select value={connectionProviderType} onChange={(e) => setConnectionProviderType(e.target.value as "broker" | "exchange" | "wallet" | "prop")}>
              <option value="broker">broker</option>
              <option value="exchange">exchange</option>
              <option value="wallet">wallet</option>
              <option value="prop">prop firm</option>
            </select>
            <input value={connectionProviderName} onChange={(e) => setConnectionProviderName(e.target.value)} placeholder="provider" />
            <input value={connectionMarketScope} onChange={(e) => setConnectionMarketScope(e.target.value)} placeholder="coverage / market scope" />
            <input value={connectionMode} onChange={(e) => setConnectionMode(e.target.value)} placeholder="mode (api-key, walletconnect, FIX...)" />
            <input value={connectionReference} onChange={(e) => setConnectionReference(e.target.value)} placeholder="account label / wallet / API ref" />
            <input value={connectionNotes} onChange={(e) => setConnectionNotes(e.target.value)} placeholder="notes integration / permissions / prop rules" />
            <button type="button" onClick={() => requestConnectionOnboarding()} disabled={connectionRequestBusy}>{connectionRequestBusy ? "Envoi…" : "Creer demande d'onboarding"}</button>
          </div>
        </div>

        <div className="panel">
          <div className="eyebrow">Patterns de connexion supportes</div>
          <div className="row"><span>MT5 / broker bridge</span><span>direct live/paper</span></div>
          <div className="row"><span>Exchange CEX</span><span>API key segmentees</span></div>
          <div className="row"><span>DEX / on-chain</span><span>wallet signing</span></div>
          <div className="row"><span>Custody / wallet</span><span>watch-only ou signing</span></div>
          <div className="row"><span>Prop firm</span><span>adapter natif / FIX / OMS</span></div>
          {connectionRequestResult ? (
            <div className="panel" style={{ marginTop: 12, borderRadius: 12 }}>
              <div className="row"><span>Status</span><span>{String(connectionRequestResult.status || "-")}</span></div>
              <div className="row"><span>Ticket</span><span>{String(connectionRequestResult.ticket_key || "-")}</span></div>
              <div className="row"><span>Detail</span><span>{String(connectionRequestResult.detail || "-")}</span></div>
            </div>
          ) : null}
        </div>
      </section>

      {result ? (
        <section className="grid" style={{ marginTop: 16, gridTemplateColumns: "1fr" }}>
          <div className="panel">
            <div className="eyebrow">Dernier resultat <HelpHint text="Sortie detaillee de la derniere action API executee." examples={["Lis ce JSON juste apres une action pour comprendre la reponse brute du systeme.", "Si quelque chose echoue, copie surtout detail, status ou approval_id pour le diagnostic."]} /></div>
            <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{JSON.stringify(result, null, 2)}</pre>
          </div>
        </section>
      ) : null}
    </main>
  );
}
