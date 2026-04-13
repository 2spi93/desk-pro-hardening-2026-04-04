import Link from "next/link";
import { redirect } from "next/navigation";

import { cpFetch } from "../lib/controlPlane";
import { readHealthwatchDashboard } from "../lib/healthwatchDashboard";
import { getLatestLocalTerminalCapture } from "../lib/localTerminalCapture";
import { readLocalTerminalCaptureStore } from "../lib/localTerminalCaptureStore";
import { getConnectorHealthView } from "../lib/connectorHealth";
import HelpHint from "../components/HelpHint";
import OperatorPanelGuide from "../components/ui/OperatorPanelGuide";
import { getRoleGroup, getRoleDisplayLabel, isClientRole } from "../lib/roleGroups";

type RecordItem = Record<string, unknown>;

function asRecordItem(value: unknown): RecordItem {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordItem : {};
}

async function getJson(path: string): Promise<unknown> {
  const response = await cpFetch(path);
  if (!response.ok) {
    return null;
  }
  return response.json();
}

export default async function Page() {
  const [me, overview, audit, positions, quotes, balances, pending, strategies, connectorsStatus, healthwatchDashboard, localTerminalCaptureStore] = await Promise.all([
    getJson("/v1/auth/me") as Promise<RecordItem | null>,
    getJson("/v1/dashboard/overview") as Promise<RecordItem | null>,
    getJson("/v1/audit") as Promise<RecordItem[] | null>,
    getJson("/v1/broker/positions") as Promise<RecordItem[] | null>,
    getJson("/v1/market/quotes") as Promise<RecordItem[] | null>,
    getJson("/v1/broker/balance") as Promise<RecordItem | null>,
    getJson("/v1/intents/pending") as Promise<Record<string, RecordItem> | null>,
    getJson("/v1/strategies") as Promise<RecordItem[] | null>,
    getJson("/v1/connectors/status") as Promise<RecordItem | null>,
    readHealthwatchDashboard(),
    readLocalTerminalCaptureStore(),
  ]);

  if (!me) {
    return (
      <main className="shell txt-page-shell">
        <section className="hero txt-page-hero-grid" style={{ gridTemplateColumns: "1fr" }}>
          <div className="panel txt-page-hero">
            <div className="eyebrow">TXT</div>
            <h1 className="title" style={{ fontSize: 34 }}>Session requise</h1>
            <p className="subtle">Connecte-toi pour acceder au cockpit RBAC.</p>
            <p><Link href="/login">Aller a la page de connexion</Link></p>
          </div>
        </section>
      </main>
    );
  }

  if (Boolean(me.password_must_change)) {
    redirect("/change-password");
  }

  // Clients should never reach this internal dashboard — middleware redirects
  // them to /terminal. Enforce here as a defence-in-depth fallback.
  const meRole = String(me.role || "");
  if (isClientRole(meRole)) {
    redirect("/terminal");
  }

  const meRoleGroup = getRoleGroup(meRole);
  const meRoleLabel = getRoleDisplayLabel(meRole, meRoleGroup);

  const safeOverview = overview || {};
  const safeAudit = audit || [];
  const safePositions = positions || [];
  const safeQuotes = quotes || [];
  const safeBalances = balances || { balances: [] };
  const safePending = pending || {};
  const safeStrategies = strategies || [];
  const safeConnectors = Array.isArray(connectorsStatus?.connectors)
    ? connectorsStatus.connectors.filter((item): item is RecordItem => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
  const connectorByName = new Map(safeConnectors.map((item) => [String(item.name || "").toLowerCase(), item]));
  const executionVenueRows = safeConnectors.filter((item) => Number(asRecordItem(item.broker_capabilities).linked_trade_accounts || 0) > 0);
  const marketVenueRows = ["okx", "binance", "bybit"]
    .map((provider) => connectorByName.get(provider))
    .filter((item): item is RecordItem => Boolean(item));
  const okxTradeLinked = executionVenueRows.some((item) => String(item.name || "").toLowerCase() === "okx");
  const publicChartVisibility = (healthwatchDashboard?.public_chart_visibility && typeof healthwatchDashboard.public_chart_visibility === "object"
    ? healthwatchDashboard.public_chart_visibility
    : null) as RecordItem | null;
  const latestLocalTerminalCapture = getLatestLocalTerminalCapture(localTerminalCaptureStore);
  const publicFailureDetails = (publicChartVisibility?.failure_details && typeof publicChartVisibility.failure_details === "object"
    ? publicChartVisibility.failure_details
    : null) as RecordItem | null;

  const balanceRows = (safeBalances.balances as RecordItem[]) || [];
  const pendingRows = Object.entries(safePending);

  return (
    <main className="shell txt-page-shell">
      <section className="hero txt-page-hero-grid">
        <div id="global-guide-dashboard-hero" className="panel txt-page-hero">
          <div className="eyebrow">TXT Dashboard</div>
          <h1 className="title">Trader eXelle Terminal</h1>
          <p className="subtle">Plateforme de trading humaine: lisible pour debutants, puissante pour experts.</p>
          <OperatorPanelGuide
            title="Guide Dashboard"
            what="Une vue simplifiee de la sante trading: exposition, approvals, balances et alertes." 
            why="Aider un debutant a savoir quoi verifier avant toute action, sans noyer les infos critiques."
            example="Si Pending approvals monte et qu'un incident est ouvert, va d'abord sur Terminal puis Incidents."
            terms={["allocation", "metaRisk", "liquidity"]}
          />
          <div className="row"><span>User</span><span className="pill">{String(me.username)} ({meRoleLabel})</span></div>
          <p style={{ marginTop: 8 }}>
            <Link href="/terminal">TXT Terminal</Link>
            {" | "}
            <Link href="/fund-manager">Fund Manager</Link>
            {" | "}
            <Link href="/live-capital">Live Capital</Link>
            {" | "}
            <Link href="/learn">TXT Learn</Link>
            {" | "}
            <Link href="/advanced">TXT Advanced</Link>
            {" | "}
            <Link href="/settings">TXT Settings</Link>
            {" | "}
            <Link href="/incidents">Incidents</Link>
          </p>
          <form action="/api/auth/logout" method="post" style={{ marginTop: 10 }}>
            <button type="submit">Se deconnecter</button>
          </form>
          <div style={{ marginTop: 20 }}>
            <div className="row"><span>System mode</span><span className="pill">{String(safeOverview.system_mode)}</span></div>
            <div className="row"><span>Pending approvals</span><span>{String(safeOverview.pending_intents)}</span></div>
            <div className="row"><span>Open net exposure</span><span>{String(safeOverview.net_exposure_usd)} USD</span></div>
            <div className="row"><span>Orders persisted</span><span>{String(safeOverview.orders_count)}</span></div>
          </div>
        </div>
        <div className="panel">
          <div className="eyebrow">Security <HelpHint text="RBAC, rotation mot de passe, signatures et garde-fous d'execution." examples={["Avant un passage live, verifie que ton role est correct et que Paper only n'est pas incoherent.", "Si un ordre sensible doit sortir, assure-toi que la validation HMAC et les approvals sont disponibles."]} /></div>
          <div className="metric good">RBAC + Signed Approvals</div>
          <p className="subtle">Les approbations passent par bearer token, rôle et signature HMAC.</p>
          <div className="row"><span>Policy version</span><span>{String(safeOverview.policy_version)}</span></div>
          <div className="row"><span>Paper only</span><span className="warn">{String(safeOverview.paper_only)}</span></div>
        </div>
      </section>

      <section className="grid" style={{ marginTop: 16, gridTemplateColumns: "1.1fr 0.9fr" }}>
        <div className="panel">
          <div className="eyebrow">Venue Health <HelpHint text="Badge unifie backend pour savoir si l'execution est bloquee, reduite ou nominale." examples={["Si le badge passe en REDUCE SIZE, la taille live backend est deja rabotee.", "Si le badge passe en LIVE BLOCKED, ne cherche pas a forcer un smoke test: le control-plane coupe deja l'execution."]} /></div>
          {executionVenueRows.length === 0 ? <p className="subtle">Aucune venue d'execution live liee.</p> : null}
          {executionVenueRows.map((item) => {
            const badge = getConnectorHealthView(item);
            return (
              <div className="row" key={`execution-venue-${String(item.name)}`}>
                <span>{String(item.name).toUpperCase()} | trade accounts {String(asRecordItem(item.broker_capabilities).linked_trade_accounts || 0)}</span>
                <span className="connector-health-stack">
                  <span className={badge.badgeClassName}>{badge.label}</span>
                  <span className={badge.noteClassName}>{badge.message}</span>
                </span>
              </div>
            );
          })}
        </div>
        <div className="panel">
          <div className="eyebrow">Data Mesh Health <HelpHint text="Supervision des venues de marche prioritaires pour la migration venue-aware." examples={["OKX, Binance et Bybit servent ici de thermometre data/market-health.", "Une venue peut etre bonne en data mais non prete en execution si aucun compte trade n'est lie."]} /></div>
          {marketVenueRows.length === 0 ? <p className="subtle">Aucune venue de data prioritaire visible.</p> : null}
          {marketVenueRows.map((item) => {
            const badge = getConnectorHealthView(item);
            return (
              <div className="row" key={`market-venue-${String(item.name)}`}>
                <span>{String(item.name).toUpperCase()}</span>
                <span className="connector-health-stack">
                  <span className={badge.badgeClassName}>{badge.compactLabel}</span>
                  <span className={badge.noteClassName}>{badge.message}</span>
                </span>
              </div>
            );
          })}
          {!okxTradeLinked ? <p className="warn" style={{ marginTop: 12 }}>OKX n'est pas encore lie en execution live.</p> : null}
        </div>
      </section>

      <section className="grid" style={{ marginTop: 16, gridTemplateColumns: "1fr 1fr" }}>
        <div className="panel">
          <div className="eyebrow">Public Probe <HelpHint text="Reference probe du chart public. Ce bloc ne parle pas forcement de l'onglet terminal local en face de toi." examples={["Si ce probe est green mais le terminal local est rouge, le probleme est dans l'instance locale ou son feed choisi.", "Si failure reason=freshness, le chart public peut encore rendre des bougies mais avec retard."]} /></div>
          <div className={`metric ${String(publicChartVisibility?.state || publicChartVisibility?.public_chart_state || "unknown") === "healthy" ? "good" : "warn"}`}>{String(publicChartVisibility?.state || publicChartVisibility?.public_chart_state || "unavailable")}</div>
          <div className="row"><span>Failure reason</span><span>{String(publicChartVisibility?.failure_reason || "none")}</span></div>
          <div className="row"><span>Feed</span><span>{String(((publicChartVisibility?.ohlcv_contract as RecordItem | undefined)?.instrument) || "-")} @ {String(((publicChartVisibility?.ohlcv_contract as RecordItem | undefined)?.venue) || "-")}</span></div>
          <div className="row"><span>Bars freshness</span><span>{String(publicFailureDetails?.freshness_stale_ms || "-")}</span></div>
          <div className="row"><span>Generated</span><span>{String(healthwatchDashboard?.generated_at || "-").slice(11, 19) || "-"}</span></div>
        </div>
        <div className="panel">
          <div className="eyebrow">Local Terminal Capture <HelpHint text="Snapshot persiste de l'onglet terminal actif. C'est la source de verite pour verifier les pills exactes d'une instance locale." examples={["Si tu vois BUS OFFLINE dans l'onglet, ce bloc doit montrer la meme chose ici si cette instance publie encore ses captures.", "Le client id permet de distinguer plusieurs onglets ou postes de travail si necessaire."]} /></div>
          {latestLocalTerminalCapture ? (
            <>
              <div className={`metric ${latestLocalTerminalCapture.runtime.noCandlesExpected ? "warn" : "good"}`}>{latestLocalTerminalCapture.runtime.noCandlesExpected ? "No candles expected" : "Flowing"}</div>
              <div className="row"><span>Client id</span><span>{latestLocalTerminalCapture.clientId.slice(0, 8)}</span></div>
              <div className="row"><span>Feed</span><span>{latestLocalTerminalCapture.chart.feedLabel}</span></div>
              <div className="row"><span>Signal</span><span>{latestLocalTerminalCapture.localFeed.signal}</span></div>
              <div className="row"><span>Persisted</span><span>{latestLocalTerminalCapture.capturedAt.slice(11, 19)}</span></div>
              {latestLocalTerminalCapture.runtime.exactStateVector.map((item) => (
                <div className="row" key={item}>
                  <span>State</span><span>{item}</span>
                </div>
              ))}
            </>
          ) : (
            <p className="subtle">Aucune capture locale persistee pour le moment.</p>
          )}
        </div>
      </section>

      <section className="grid">
        <div className="panel">
          <div className="eyebrow">Balances <HelpHint text="Liquidite par devise depuis le broker adapter." examples={["Si USDT libre baisse trop, reduis la taille des nouveaux ordres crypto.", "Si USD libre est a zero, n'envoie pas de ticket forex sans reallouer du cash."]} /></div>
          {balanceRows.map((item) => (
            <div className="row" key={String(item.currency)}>
              <span>{String(item.currency)}</span>
              <span>{String(item.free)}</span>
            </div>
          ))}
        </div>
        <div className="panel">
          <div className="eyebrow">Positions <HelpHint text="Exposition nette en temps reel par instrument." examples={["Si BTCUSD est trop gros par rapport au reste, coupe ou hedge avant un news event.", "Si une ligne apparait ici alors qu'aucun bot ne devrait tourner, va verifier Connecteurs et Incidents."]} /></div>
          {safePositions.map((item) => (
            <div className="row" key={String(item.instrument)}>
              <span>{String(item.instrument)}</span>
              <span>{String(item.net_notional_usd)}</span>
            </div>
          ))}
        </div>
        <div className="panel">
          <div className="eyebrow">Market Data <HelpHint text="Derniers ticks consolides pour supervision rapide." examples={["Utilise ce bloc pour voir en 2 secondes si le prix bouge encore normalement.", "Si le dernier prix semble fige, suspecte un connecteur de marche ou un broker en retard."]} /></div>
          {safeQuotes.map((item) => (
            <div className="row" key={`${String(item.venue)}-${String(item.instrument)}`}>
              <span>{String(item.instrument)}</span>
              <span>{String(item.last)}</span>
            </div>
          ))}
        </div>
        <div className="panel">
          <div className="eyebrow">Audit Trail <HelpHint text="Journal d'evenements pour non-repudiation et gouvernance." examples={["Si un operateur dit qu'il n'a rien fait, verifie ici la trace exacte.", "Si une approbation live est contestee, l'audit trail est la premiere preuve a lire."]} /></div>
          {safeAudit.slice(0, 5).map((item, index) => (
            <div className="row" key={`${String(item.timestamp)}-${index}`}>
              <span>{String(item.category)}</span>
              <span className="subtle">{String(item.timestamp)}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="grid" style={{ marginTop: 16, gridTemplateColumns: "1fr 1fr" }}>
        <div className="panel">
          <div className="eyebrow">Pending Approvals <HelpHint text="Intentions acceptees par le risk gateway en attente de validation humaine." examples={["Exemple: une strategie propose un ordre, le risk gateway l'accepte, l'humain clique Approve ici.", "Si tu ne comprends pas le contexte d'un intent, n'approuve pas: ouvre IA ou Incidents pour investiguer."]} /></div>
          {pendingRows.length === 0 ? <p className="subtle">Aucune intention en attente.</p> : null}
          {pendingRows.map(([intentId, payload]) => (
            <div className="row" key={intentId}>
              <div>
                <div>{intentId}</div>
                <div className="subtle mini">{String((payload as Record<string, unknown>).intent ? (payload as { intent: { strategy_id?: string } }).intent.strategy_id || "" : "")}</div>
              </div>
              <form method="post" action={`/api/intents/${intentId}/approve`}>
                <button type="submit">Approve</button>
              </form>
            </div>
          ))}
        </div>

        <div className="panel">
          <div className="eyebrow">Strategy Registry <HelpHint text="Catalogue des strategies avec progression de niveau et promotions." examples={["Create Strategy: enregistre une nouvelle strategie avant de la tester ailleurs.", "Promote: passe L2 vers L3 seulement si sharpe, drawdown et rationale sont solides."]} /></div>
          <form action="/api/strategies" method="post" className="form-grid" style={{ marginBottom: 14 }}>
            <input name="strategy_id" placeholder="strategy_id" required />
            <input name="name" placeholder="name" required />
            <input name="market" placeholder="market (crypto/fx/etc)" required />
            <input name="setup_type" placeholder="setup_type" required />
            <textarea name="notes" placeholder="notes" rows={2} />
            <button type="submit">Create Strategy</button>
          </form>

          {safeStrategies.map((item) => {
            const strategyId = String(item.strategy_id);
            const level = Number(item.current_level || 0);
            const nextLevel = Math.min(level + 1, 6);
            return (
              <div className="row" key={strategyId}>
                <div>
                  <div>{strategyId}</div>
                  <div className="subtle mini">L{level} - {String(item.market)} - {String(item.setup_type)}</div>
                </div>
                {level < 6 ? (
                  <form method="post" action={`/api/strategies/${strategyId}/promote`} className="form-grid" style={{ minWidth: 200 }}>
                    <input type="hidden" name="to_level" value={nextLevel} />
                    <input type="text" name="rationale" placeholder={`Promote to L${nextLevel}`} required />
                    <input type="number" step="0.01" name="sharpe" placeholder="sharpe" />
                    <input type="number" step="0.01" name="max_dd" placeholder="max_dd" />
                    <button type="submit">Promote</button>
                  </form>
                ) : (
                  <span className="pill">L6 max</span>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </main>
  );
}