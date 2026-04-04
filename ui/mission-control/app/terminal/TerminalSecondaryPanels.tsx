"use client";

import type { ReactNode } from "react";

import HelpHint from "../../components/HelpHint";
import PanelShell from "../../components/ui/PanelShell";

type RiskTimelineFilter = "all" | "compliant" | "miss";

type DomPanelLevel = { side: "bid" | "ask"; price: number; size: number; intensity: number };
type FootprintPanelRow = { low: number; high: number; buyVolume: number; sellVolume: number; delta: number; timeLabel?: string };
type TapePanelPrint = { label: string; price: number; side: "buy" | "sell" | "flat"; volume: number };
type BlotterOutcomeRow = Record<string, unknown>;
type BrokerProviderRow = Record<string, unknown>;
type BrokerBalanceRow = Record<string, unknown>;
type BrokerPositionRow = Record<string, unknown>;
type AlertRow = Record<string, unknown>;
type IncidentItemRow = {
  item: Record<string, unknown>;
  status: string;
  severityLabel: string;
  slaLabel: string;
};
type GovernanceRow = { label: string; value: string; severity: number };
type DriftItem = Record<string, unknown>;
type MemorySummary = Record<string, unknown>;
type GovernanceSort = "severity" | "label" | "value";
type IncidentSort = "severity" | "status" | "sla";
type RiskHistorySummary = {
  count_ok: number;
  count_miss: number;
  last_block_reason: string;
  ratio_miss_window: number;
};
type RiskPollingStatus = {
  lastRefreshIso: string | null;
  latencyMs: number | null;
  source: "summary" | "history" | null;
};
type RiskTimelineRow = {
  atIso: string;
  symbol: string;
  side: string;
  rr: number;
  compliant: boolean;
  source?: string;
  outcome: string;
};
type OmsLifecycleSummary = {
  pendingApprovals: number;
  routedCount: number;
  acceptedCount: number;
  partialCount: number;
  filledCount: number;
  blockedCount: number;
  avgLatencyMs: number;
  avgSlippageBps: number;
  lastEventIso: string | null;
  agentReadyCount: number;
  agentTotalCount: number;
};
type PortfolioOverlaySummary = {
  accountFreeUsd: number;
  openTradesCount: number;
  grossExposureUsd: number;
  exposureRatioPct: number;
  dailyPnLUsd: number;
  dailyDrawdownPct: number;
  dominantBookLabel: string;
};
type AiBridgeSummary = {
  routeLabel: string;
  routeScore: number;
  v7Label: string;
  v7Tone: "good" | "warn" | "neutral";
  edgeBps: number;
  v8Execute: boolean;
  v8ProbabilityPct: number;
  brainAction: string;
  brainConfidencePct: number;
  brainRegime: string;
  reasonLabel: string;
};

function safeNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function formatCompactUsd(value: unknown): string {
  const amount = safeNumber(value, 0);
  return `${amount.toFixed(Math.abs(amount) >= 100 ? 0 : 2)} USD`;
}

function ScrollWrap({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={className} style={{ height: "100%", overflow: "auto" }}>{children}</div>;
}

const PANEL_HINTS: Record<string, { text: string; examples: string[] }> = {
  DOM: {
    text: "Le DOM montre la profondeur instantanee: bid/ask, tailles et concentration de liquidite autour du prix.",
    examples: ["Beaucoup d'ask au-dessus peut freiner une montee.", "Une profondeur tres fine signale souvent un environnement plus fragile pour l'execution."],
  },
  Footprint: {
    text: "Le footprint oppose les volumes buy/sell par niveau de prix pour lire l'agression reelle dans la bougie.",
    examples: ["Delta positif fort: aggression acheteuse dominante.", "Delta negatif autour d'un support peut signaler une cassure faible ou un absorbtion."],
  },
  Tape: {
    text: "Le tape liste les derniers prints executes pour lire le rythme et le sens immediat des transactions.",
    examples: ["Une succession de prints buy peut confirmer une acceleration.", "Des prints alternes et petits traduisent souvent un marche hesitant."],
  },
  Heatmap: {
    text: "La heatmap visualise la densite de liquidite par niveau de prix, utile pour reperer murs et zones d'absorption.",
    examples: ["Un mur ask persistant peut bloquer la hausse.", "Une zone bid qui disparait brutalement annonce souvent un trou de liquidite."],
  },
  "Blotter d'exécution": {
    text: "Le blotter recense les executions recentes, leur PnL, leur slippage et leur statut de fin.",
    examples: ["Slip eleve avec PnL faible: execution a retravailler.", "Compare les statuts pour voir si les runs passent ou restent bloques."],
  },
  "Desk Bridge · OMS · Overlay": {
    text: "Resume compact du lifecycle OMS, de l'overlay portefeuille et du pont IA d'execution deja calcules dans le terminal.",
    examples: ["Si les approvals montent mais que les fills stagnent, le lifecycle OMS se tasse avant execution finale.", "Croise edge IA, exposition portefeuille et disponibilite agents avant de laisser le desk pousser en live."],
  },
  "Alertes actives": {
    text: "Bloc des alertes prioritaires: incidents critiques, guardrails, approvals et signaux de degradation.",
    examples: ["Une alerte critique doit etre traitee avant toute nouvelle action live.", "Les alertes repetitives indiquent souvent un flux ou un service degrade."],
  },
  Incidents: {
    text: "Les incidents structurent le suivi operatoire avec statut, severite et SLA.",
    examples: ["SLA breach signale une dette operatoire a traiter vite.", "Un incident ouvert sur connecteurs invalide souvent une lecture trop confiante du desk."],
  },
  Governance: {
    text: "La gouvernance rassemble les signaux de derive, limites et guardrails actifs sur le systeme.",
    examples: ["Trie par severity pour voir ce qui bloque vraiment l'usage live.", "Le filtre texte aide a isoler une strategie, un routeur ou un composant precis."],
  },
  Readiness: {
    text: "La readiness combine drift, suspensions, memoire et incidents pour juger si le systeme est exploitable.",
    examples: ["Beaucoup de drift et des SLA breach = environnement pas pret pour une promotion live.", "Une strategie suspendue ne doit pas etre traitee comme allocable."],
  },
  "Risk Compliance Timeline": {
    text: "Historique de conformite risque: ok/miss, ratio de miss, poll et seuils d'alerte locale.",
    examples: ["Si le ratio miss grimpe, le desk doit ralentir ou couper certaines executions.", "Le hard alert permet de declencher une vigilance locale plus stricte."],
  },
};

function titleWithHelp(title: string, badge?: ReactNode): ReactNode {
  const hint = PANEL_HINTS[title];
  return (
    <>
      {title}
      {hint ? <HelpHint text={hint.text} examples={hint.examples} label="Guide rapide" /> : null}
      {badge ? <> {badge}</> : null}
    </>
  );
}

function MonitoringPanelCard({
  title,
  badge,
  layoutEditMode,
  onDetach,
  children,
}: {
  title: string;
  badge: ReactNode;
  layoutEditMode: boolean;
  onDetach: () => void;
  children: ReactNode;
}) {
  return (
    <div className="monitoring-col">
      <div className="eyebrow monitoring-panel-head" style={{ marginBottom: 6 }}>
        <span className="monitoring-panel-title">{titleWithHelp(title, badge)}</span>
        {layoutEditMode ? <button type="button" className="panel-detach-btn" title="Floating" onClick={onDetach}>⤡</button> : null}
      </div>
      {children}
    </div>
  );
}

export function DomDockPanel({
  depthStreamState,
  activeDomLevels,
}: {
  depthStreamState: string;
  activeDomLevels: DomPanelLevel[];
}) {
  return (
    <ScrollWrap>
      <PanelShell className="panel micro-panel">
        <div className="eyebrow micro-panel-title">{titleWithHelp("DOM", <span className={`micro-stream-badge micro-stream-${depthStreamState}`}>{depthStreamState}</span>)}</div>
        <div className="dom-table-compact">
          <div className="dom-header-row"><span>Side</span><span>Prix</span><span>Taille</span><span>Profondeur</span></div>
          {activeDomLevels.map((level, index) => (
            <div key={`fdom-${index}`} className={`dom-row-compact ${level.side}`}>
              <span className={`dom-side-label ${level.side}`}>{level.side === "ask" ? "A" : "B"}</span>
              <span className="dom-price">{level.price.toFixed(1)}</span>
              <span className="dom-size">{level.size}</span>
              <span className="dom-bar-cell"><span style={{ width: `${Math.min(100, level.intensity * 100)}%` }} /></span>
            </div>
          ))}
        </div>
      </PanelShell>
    </ScrollWrap>
  );
}

export function FootprintDockPanel({ activeFootprintRows }: { activeFootprintRows: FootprintPanelRow[] }) {
  return (
    <ScrollWrap>
      <PanelShell className="panel micro-panel">
        <div className="eyebrow micro-panel-title">{titleWithHelp("Footprint")}</div>
        <div className="footprint-compact">
          <div className="fp-header-row"><span>Niveau</span><span className="good">Buy</span><span className="warn">Sell</span><span>Δ</span></div>
          {activeFootprintRows.map((row, index) => (
            <div key={`ffp-${index}`} className="fp-row-compact">
              <span className="fp-level">{row.timeLabel ? `${row.timeLabel} · ` : ""}{row.high.toFixed(0)}–{row.low.toFixed(0)}</span>
              <span className="good fp-num">{row.buyVolume.toFixed(0)}</span>
              <span className="warn fp-num">{row.sellVolume.toFixed(0)}</span>
              <span className={`fp-num ${row.delta >= 0 ? "good" : "warn"}`}>{row.delta.toFixed(0)}</span>
            </div>
          ))}
        </div>
      </PanelShell>
    </ScrollWrap>
  );
}

export function TapeDockPanel({ activeTape }: { activeTape: TapePanelPrint[] }) {
  return (
    <ScrollWrap>
      <PanelShell className="panel micro-panel">
        <div className="eyebrow micro-panel-title">{titleWithHelp("Tape")}</div>
        <div className="tape-compact">
          {activeTape.map((print, index) => (
            <div key={`ftp-${index}`} className={`tape-row-compact ${print.side}`}>
              <span className="tape-time">{print.label.slice(-8)}</span>
              <span className="tape-price">{print.price.toFixed(1)}</span>
              <span className="tape-vol">{print.volume}</span>
              <span className={`tape-badge ${print.side}`}>{print.side === "buy" ? "B" : print.side === "sell" ? "S" : "–"}</span>
            </div>
          ))}
        </div>
      </PanelShell>
    </ScrollWrap>
  );
}

export function HeatmapDockPanel({
  activeHeatmapLevels,
  sessionLabel,
}: {
  activeHeatmapLevels: DomPanelLevel[];
  sessionLabel: string;
}) {
  return (
    <ScrollWrap>
      <PanelShell className="panel micro-panel">
        <div className="eyebrow micro-panel-title">{titleWithHelp("Heatmap", <span className="subtle mini" style={{ marginLeft: 6 }}>{sessionLabel}</span>)}</div>
        <div className="heatmap-compact">
          {activeHeatmapLevels.map((level, index) => (
            <div key={`fhm-${index}`} className={`hm-row ${level.side}`} style={{ opacity: Math.max(0.2, level.intensity) }}>
              <span className="hm-price">{level.price.toFixed(1)}</span>
              <div className="hm-bar-wrap"><div className={`hm-bar ${level.side}`} style={{ width: `${Math.min(100, level.intensity * 100)}%` }} /></div>
              <span className="hm-size">{level.size}</span>
            </div>
          ))}
        </div>
      </PanelShell>
    </ScrollWrap>
  );
}

export function BlotterDockPanel({
  filteredOutcomes,
  instrumentLabel,
}: {
  filteredOutcomes: BlotterOutcomeRow[];
  instrumentLabel: (item: BlotterOutcomeRow) => string;
}) {
  return (
    <ScrollWrap>
      <PanelShell className="panel term-blotter-panel">
        <div className="eyebrow">{titleWithHelp("Blotter d'exécution")}</div>
        {filteredOutcomes.length === 0 ? <p className="subtle mini" style={{ marginTop: 8 }}>Aucune exécution.</p> : null}
        {filteredOutcomes.length > 0 ? (
          <div className="blotter-scroll">
            <table className="blotter-table" style={{ marginTop: 8 }}>
              <thead><tr><th>Time</th><th>Symbol</th><th>PnL</th><th>Slip</th><th>Status</th></tr></thead>
              <tbody>
                {filteredOutcomes.slice(0, 8).map((item, index) => (
                  <tr key={`fbl-${index}`}>
                    <td>{String(item.created_at || "–").slice(11, 19)}</td>
                    <td>{instrumentLabel(item)}</td>
                    <td className={safeNumber(item.net_result_usd, 0) >= 0 ? "good" : "warn"}>{safeNumber(item.net_result_usd, 0).toFixed(2)}</td>
                    <td>{safeNumber(item.slippage_real_bps, 0).toFixed(1)}bps</td>
                    <td>{String(item.status || "–").slice(0, 8)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </PanelShell>
    </ScrollWrap>
  );
}

export function BrokersDockPanel({
  providerRows,
  balances,
  positions,
  instrumentLabel,
  omsLifecycle,
  portfolioOverlay,
  aiBridge,
}: {
  providerRows: BrokerProviderRow[];
  balances: BrokerBalanceRow[];
  positions: BrokerPositionRow[];
  instrumentLabel: (item: BrokerPositionRow) => string;
  omsLifecycle: OmsLifecycleSummary;
  portfolioOverlay: PortfolioOverlaySummary;
  aiBridge: AiBridgeSummary;
}) {
  return (
    <ScrollWrap>
      <PanelShell className="panel term-brokers-panel">
        <div className="eyebrow">{titleWithHelp("Desk Bridge · OMS · Overlay")}</div>
        <div className="brokers-grid">
          <div className="brokers-section">
            <div className="chart-stat-label" style={{ marginBottom: 6 }}>OMS Lifecycle</div>
            <div className="row"><span>Approvals</span><span className={omsLifecycle.pendingApprovals > 0 ? "warn" : "good"}>{omsLifecycle.pendingApprovals}</span></div>
            <div className="row"><span>Routed / ack</span><span>{omsLifecycle.routedCount} / {omsLifecycle.acceptedCount}</span></div>
            <div className="row"><span>Partial / final</span><span>{omsLifecycle.partialCount} / {omsLifecycle.filledCount}</span></div>
            <div className="row"><span>Blocked</span><span className={omsLifecycle.blockedCount > 0 ? "warn" : "good"}>{omsLifecycle.blockedCount}</span></div>
            <div className="row"><span>Latency / slip</span><span>{safeNumber(omsLifecycle.avgLatencyMs, 0).toFixed(0)} ms | {safeNumber(omsLifecycle.avgSlippageBps, 0).toFixed(1)} bps</span></div>
            <div className="row"><span>Agents live</span><span className={omsLifecycle.agentReadyCount >= Math.max(1, omsLifecycle.agentTotalCount) ? "good" : "subtle"}>{omsLifecycle.agentReadyCount}/{omsLifecycle.agentTotalCount}</span></div>
            <div className="subtle mini" style={{ marginTop: 6 }}>last event {omsLifecycle.lastEventIso ? omsLifecycle.lastEventIso.slice(11, 19) : "n/a"}</div>
          </div>
          <div className="brokers-section">
            <div className="chart-stat-label" style={{ marginBottom: 6 }}>Portfolio Overlay</div>
            <div className="row"><span>Free equity</span><span>{formatCompactUsd(portfolioOverlay.accountFreeUsd)}</span></div>
            <div className="row"><span>Open books</span><span>{portfolioOverlay.openTradesCount}</span></div>
            <div className="row"><span>Gross exposure</span><span>{formatCompactUsd(portfolioOverlay.grossExposureUsd)}</span></div>
            <div className="row"><span>Exposure / cash</span><span className={portfolioOverlay.exposureRatioPct >= 100 ? "warn" : portfolioOverlay.exposureRatioPct >= 70 ? "subtle" : "good"}>{portfolioOverlay.exposureRatioPct.toFixed(0)}%</span></div>
            <div className="row"><span>PnL 24h</span><span className={portfolioOverlay.dailyPnLUsd >= 0 ? "good" : "warn"}>{formatCompactUsd(portfolioOverlay.dailyPnLUsd)}</span></div>
            <div className="row"><span>Intraday DD</span><span className={portfolioOverlay.dailyDrawdownPct >= 2 ? "warn" : portfolioOverlay.dailyDrawdownPct >= 1 ? "subtle" : "good"}>{portfolioOverlay.dailyDrawdownPct.toFixed(2)}%</span></div>
            <div className="subtle mini gtix-ellipsis" style={{ marginTop: 6 }}>dominant book {portfolioOverlay.dominantBookLabel}</div>
            {balances.slice(0, 2).map((item) => (
              <div key={String(item.currency || "")} className="balance-row">
                <span className="balance-ccy">{String(item.currency || "–")}</span>
                <span className="balance-val gtix-ellipsis">{String(item.free || "–")}</span>
              </div>
            ))}
          </div>
          <div className="brokers-section">
            <div className="chart-stat-label" style={{ marginBottom: 6 }}>AI Execution Bridge</div>
            <div className="row"><span>V7 gate</span><span className={aiBridge.v7Tone === "good" ? "good" : aiBridge.v7Tone === "warn" ? "warn" : "subtle"}>{aiBridge.v7Label}</span></div>
            <div className="row"><span>Route</span><span>{aiBridge.routeLabel} | {aiBridge.routeScore.toFixed(2)}</span></div>
            <div className="row"><span>Final edge</span><span className={aiBridge.edgeBps >= 0 ? "good" : "warn"}>{aiBridge.edgeBps.toFixed(1)} bps</span></div>
            <div className="row"><span>V8 execute</span><span className={aiBridge.v8Execute ? "good" : "subtle"}>{aiBridge.v8Execute ? "yes" : "hold"} | {aiBridge.v8ProbabilityPct.toFixed(0)}%</span></div>
            <div className="row"><span>Brain</span><span>{aiBridge.brainAction} | {aiBridge.brainConfidencePct.toFixed(0)}%</span></div>
            <div className="row"><span>Regime</span><span>{aiBridge.brainRegime}</span></div>
            <div className="subtle mini gtix-ellipsis" style={{ marginTop: 6 }}>{aiBridge.reasonLabel || "No predictor rationale"}</div>
            {providerRows.slice(0, 3).map((item, index) => (
              <div key={`fbr-ag-${index}`} className="agent-row">
                <span className="agent-name gtix-ellipsis">{String(item.route || "–").slice(0, 14)}</span>
                <span className={Boolean(item.available) ? "good mini" : "warn mini"}>{Boolean(item.available) ? "●" : "○"}</span>
              </div>
            ))}
            {positions.slice(0, 2).map((item) => (
              <div key={instrumentLabel(item)} className="pos-row">
                <span className="pos-sym gtix-ellipsis">{instrumentLabel(item).slice(0, 10)}</span>
                <span className="balance-val">{safeNumber(item.net_notional_usd, 0).toFixed(0)}</span>
              </div>
            ))}
          </div>
        </div>
      </PanelShell>
    </ScrollWrap>
  );
}

export function AlertsDockPanel({ filteredAlerts }: { filteredAlerts: AlertRow[] }) {
  return (
    <div className="monitoring-col" style={{ height: "100%", overflow: "auto" }}>
      <div className="eyebrow" style={{ marginBottom: 8 }}>{titleWithHelp("Alertes actives")}</div>
      {filteredAlerts.length === 0 ? <p className="subtle mini">Aucune alerte.</p> : null}
      {filteredAlerts.slice(0, 10).map((item, index) => (
        <div key={`fal-${index}`} className="mon-row">
          <span className={String(item.level) === "critical" ? "warn" : ""}>{String(item.type || "–")}</span>
          <span className="subtle mini">{String(item.message || "").slice(0, 48)}</span>
        </div>
      ))}
    </div>
  );
}

export function IncidentsDockPanel({ incidentRows }: { incidentRows: IncidentItemRow[] }) {
  return (
    <div className="monitoring-col" style={{ height: "100%", overflow: "auto" }}>
      <div className="eyebrow" style={{ marginBottom: 8 }}>{titleWithHelp("Incidents")}</div>
      {incidentRows.length === 0 ? <p className="subtle mini">Aucun incident.</p> : null}
      {incidentRows.map(({ item, status, severityLabel, slaLabel }) => (
        <div key={String(item.ticket_key || "")} className="mon-row incident-row">
          <span>{String(item.ticket_key || "–")}</span>
          <span className="subtle mini">{String(item.title || "–").slice(0, 28)}</span>
          <span className="incident-meta-strip">
            <span className={`incident-chip incident-chip-status-${status.toLowerCase()}`}>{status}</span>
            <span className={`incident-chip incident-chip-severity-${severityLabel}`}>{severityLabel}</span>
            <span className={`incident-chip ${slaLabel === "breach" ? "incident-chip-sla-breach" : "incident-chip-sla-ok"}`}>sla {slaLabel}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

export function GovernanceDockPanel({ governanceFiltered }: { governanceFiltered: GovernanceRow[] }) {
  return (
    <div className="monitoring-col" style={{ height: "100%", overflow: "auto" }}>
      <div className="eyebrow" style={{ marginBottom: 8 }}>{titleWithHelp("Governance")}</div>
      {governanceFiltered.slice(0, 12).map((row) => (
        <div key={row.label} className="mon-row">
          <span>{row.label}</span>
          <span className={row.severity >= 3 ? "warn" : row.severity >= 2 ? "subtle" : "good"}>{row.value}</span>
        </div>
      ))}
    </div>
  );
}

export function ReadinessDockPanel({
  driftItems,
  suspendedCount,
  memorySummary,
  incidents,
}: {
  driftItems: DriftItem[];
  suspendedCount: number;
  memorySummary: MemorySummary;
  incidents: Array<Record<string, unknown>>;
}) {
  return (
    <div className="monitoring-col" style={{ height: "100%", overflow: "auto" }}>
      <div className="eyebrow" style={{ marginBottom: 8 }}>{titleWithHelp("Readiness")}</div>
      <div className="mon-row"><span>Drift détecté</span><span>{driftItems.filter((item) => Boolean(item.drift_detected)).length}</span></div>
      <div className="mon-row"><span>Suspendues</span><span className={suspendedCount > 0 ? "warn" : "good"}>{suspendedCount}</span></div>
      <div className="mon-row"><span>Similarity</span><span>{String(memorySummary.avg_final_similarity || "–")}</span></div>
      <div className="mon-row"><span>Memory impact</span><span>{String(memorySummary.avg_memory_impact || "–")}</span></div>
      <div className="mon-row"><span>SLA breach</span><span className={incidents.some((item) => Boolean(item.sla_breached)) ? "warn" : "good"}>{incidents.filter((item) => Boolean(item.sla_breached)).length}</span></div>
    </div>
  );
}

export function RiskTimelineBody({
  hardAlertLocal,
  riskTimelineFilter,
  onSetRiskTimelineFilter,
  riskSummary,
  thresholdAtLimit,
  pollingStale,
  riskPollingStatus,
  riskPollAgeSec,
  riskTimelineFrom,
  onRiskTimelineFromChange,
  riskTimelineTo,
  onRiskTimelineToChange,
  riskAlertWindow,
  onRiskAlertWindowChange,
  riskAlertMissThreshold,
  onRiskAlertMissThresholdChange,
  riskTimelineRefreshSec,
  onRiskTimelineRefreshSecChange,
  riskHardAlertEnabled,
  onRiskHardAlertEnabledChange,
  riskHardAlertThresholdPct,
  onRiskHardAlertThresholdPctChange,
  onExportRiskHistoryJson,
  onExportRiskHistoryCsv,
  onExportComplianceZip,
  onResetWorkspaceRiskAlert,
  presetLabel,
  riskTimelineRows,
  rowLimit,
  keyPrefix,
  formatClock,
}: {
  hardAlertLocal: boolean;
  riskTimelineFilter: RiskTimelineFilter;
  onSetRiskTimelineFilter: (filter: RiskTimelineFilter) => void;
  riskSummary: RiskHistorySummary | null;
  thresholdAtLimit: boolean;
  pollingStale: boolean;
  riskPollingStatus: RiskPollingStatus;
  riskPollAgeSec: number;
  riskTimelineFrom: string;
  onRiskTimelineFromChange: (value: string) => void;
  riskTimelineTo: string;
  onRiskTimelineToChange: (value: string) => void;
  riskAlertWindow: number;
  onRiskAlertWindowChange: (value: number) => void;
  riskAlertMissThreshold: number;
  onRiskAlertMissThresholdChange: (value: number) => void;
  riskTimelineRefreshSec: 5 | 15 | 30;
  onRiskTimelineRefreshSecChange: (value: 5 | 15 | 30) => void;
  riskHardAlertEnabled: boolean;
  onRiskHardAlertEnabledChange: (enabled: boolean) => void;
  riskHardAlertThresholdPct: number;
  onRiskHardAlertThresholdPctChange: (value: number) => void;
  onExportRiskHistoryJson: () => void;
  onExportRiskHistoryCsv: () => void;
  onExportComplianceZip: () => void;
  onResetWorkspaceRiskAlert: () => void;
  presetLabel: string;
  riskTimelineRows: RiskTimelineRow[];
  rowLimit: number;
  keyPrefix: string;
  formatClock: (value: string) => string;
}) {
  return (
    <>
      {hardAlertLocal ? <div className="hard-alert-inline">Hard alert actif dans ce panel</div> : null}
      <div className="risk-timeline-toolbar">
        <button type="button" className={`chart-chip ${riskTimelineFilter === "all" ? "active" : ""}`} onClick={() => onSetRiskTimelineFilter("all")}>all</button>
        <button type="button" className={`chart-chip ${riskTimelineFilter === "compliant" ? "active" : ""}`} onClick={() => onSetRiskTimelineFilter("compliant")}>ok</button>
        <button type="button" className={`chart-chip ${riskTimelineFilter === "miss" ? "active" : ""}`} onClick={() => onSetRiskTimelineFilter("miss")}>miss</button>
      </div>
      <div className="risk-summary-kpis">
        <span className="kpi">ok {riskSummary?.count_ok ?? 0}</span>
        <span className={`kpi ${(riskSummary?.count_miss || 0) > 0 ? "warn" : ""}`}>miss {riskSummary?.count_miss ?? 0}</span>
        <span className="kpi gtix-ellipsis">reason {riskSummary?.last_block_reason || "none"}</span>
        <span className={`kpi ${thresholdAtLimit ? "warn" : ""}`}>ratio {(safeNumber(riskSummary?.ratio_miss_window, 0) * 100).toFixed(0)}%</span>
        <span className={`kpi gtix-ellipsis ${pollingStale ? "warn" : ""}`}>poll {riskPollingStatus.lastRefreshIso ? `${formatClock(riskPollingStatus.lastRefreshIso)} · ${Math.max(0, Math.round(safeNumber(riskPollingStatus.latencyMs, 0)))}ms · ${riskPollingStatus.source || "-"} · ${riskPollAgeSec}s` : "pending"}</span>
      </div>
      <div className="risk-timeline-controls">
        <label className="risk-control-field"><span>From</span><input type="datetime-local" value={riskTimelineFrom} onChange={(event) => onRiskTimelineFromChange(event.target.value)} /></label>
        <label className="risk-control-field"><span>To</span><input type="datetime-local" value={riskTimelineTo} onChange={(event) => onRiskTimelineToChange(event.target.value)} /></label>
        <label className="risk-control-field"><span>Window</span><input type="number" min={3} max={100} value={riskAlertWindow} onChange={(event) => onRiskAlertWindowChange(Number(event.target.value) || riskAlertWindow)} /></label>
        <label className={`risk-control-field ${thresholdAtLimit ? "risk-threshold-guard" : ""}`}><span>Threshold</span><input type="number" min={1} max={riskAlertWindow} value={riskAlertMissThreshold} onChange={(event) => onRiskAlertMissThresholdChange(Number(event.target.value) || riskAlertMissThreshold)} /></label>
        <label className="risk-control-field"><span>Refresh</span><select value={String(riskTimelineRefreshSec)} onChange={(event) => {
          const nextValue = Number(event.target.value);
          onRiskTimelineRefreshSecChange(nextValue === 5 || nextValue === 30 ? nextValue : 15);
        }}>
          <option value="5">5s</option>
          <option value="15">15s</option>
          <option value="30">30s</option>
        </select></label>
        <label className="risk-control-field"><span>Hard alert</span><select value={riskHardAlertEnabled ? "on" : "off"} onChange={(event) => {
          onRiskHardAlertEnabledChange(event.target.value === "on");
        }}>
          <option value="off">off</option>
          <option value="on">on</option>
        </select></label>
        <label className="risk-control-field"><span>Hard %</span><input type="number" min={20} max={95} value={Math.round(riskHardAlertThresholdPct)} onChange={(event) => onRiskHardAlertThresholdPctChange(Number(event.target.value) || riskHardAlertThresholdPct)} /></label>
        <button type="button" className="chart-chip" onClick={onExportRiskHistoryJson}>export json</button>
        <button type="button" className="chart-chip" onClick={onExportRiskHistoryCsv}>export csv</button>
        <button type="button" className="chart-chip" onClick={onExportComplianceZip}>export zip</button>
        <button type="button" className="chart-chip" onClick={onResetWorkspaceRiskAlert}>reset</button>
      </div>
      {pollingStale ? <p className="subtle mini warn">Polling stale: plus de 2 cycles sans succes.</p> : null}
      {thresholdAtLimit ? <p className="subtle mini warn">Guardrail: threshold a atteint la fenetre (alerte au moindre miss).</p> : null}
      <p className="subtle mini">preset actif: {presetLabel}</p>
      {riskTimelineRows.length === 0 ? <p className="subtle mini">Aucun event risque.</p> : null}
      {riskTimelineRows.slice(0, rowLimit).map((entry, index) => (
        <div key={`${keyPrefix}-${index}-${entry.atIso}`} className="risk-timeline-row">
          <span>{formatClock(entry.atIso)}</span>
          <span className="gtix-ellipsis">{entry.symbol}</span>
          <span>{entry.side.toUpperCase()}</span>
          <span>RR {entry.rr.toFixed(2)}</span>
          <span className={entry.compliant ? "good" : "warn"}>{entry.compliant ? "ok" : "miss"}</span>
          <span className="subtle mini">{entry.source || "local"}</span>
          <span className="subtle mini">{entry.outcome === "confirmation-required" ? "confirm" : entry.outcome}</span>
        </div>
      ))}
    </>
  );
}

export function AlertsMonitoringPanel({
  badge,
  layoutEditMode,
  onDetach,
  filteredAlerts,
}: {
  badge: ReactNode;
  layoutEditMode: boolean;
  onDetach: () => void;
  filteredAlerts: AlertRow[];
}) {
  return (
    <MonitoringPanelCard title="Alertes actives" badge={badge} layoutEditMode={layoutEditMode} onDetach={onDetach}>
      {filteredAlerts.length === 0 ? <p className="subtle mini">Aucune alerte.</p> : null}
      {filteredAlerts.slice(0, 5).map((item, index) => (
        <div key={`al-${index}`} className="mon-row">
          <span className={String(item.level) === "critical" ? "warn" : ""}>{String(item.type || "–")}</span>
          <span className="subtle mini">{String(item.message || "").slice(0, 38)}</span>
        </div>
      ))}
    </MonitoringPanelCard>
  );
}

export function IncidentsMonitoringPanel({
  badge,
  layoutEditMode,
  onDetach,
  incidents,
  incidentRows,
}: {
  badge: ReactNode;
  layoutEditMode: boolean;
  onDetach: () => void;
  incidents: Array<Record<string, unknown>>;
  incidentRows: IncidentItemRow[];
}) {
  return (
    <MonitoringPanelCard title="Incidents" badge={badge} layoutEditMode={layoutEditMode} onDetach={onDetach}>
      {incidents.length === 0 ? <p className="subtle mini">Aucun incident.</p> : null}
      {incidentRows.slice(0, 5).map(({ item, status, severityLabel, slaLabel }) => (
        <div key={String(item.ticket_key || "")} className="mon-row incident-row">
          <span>{String(item.ticket_key || "–")}</span>
          <span className="subtle mini">{String(item.title || "–").slice(0, 22)}</span>
          <span className="incident-meta-strip">
            <span className={`incident-chip incident-chip-status-${status.toLowerCase()}`}>{status}</span>
            <span className={`incident-chip incident-chip-severity-${severityLabel}`}>{severityLabel}</span>
            <span className={`incident-chip ${slaLabel === "breach" ? "incident-chip-sla-breach" : "incident-chip-sla-ok"}`}>sla {slaLabel}</span>
          </span>
        </div>
      ))}
    </MonitoringPanelCard>
  );
}

export function GovernanceMonitoringPanel({
  badge,
  layoutEditMode,
  onDetach,
  governanceSort,
  onGovernanceSortChange,
  incidentSort,
  onIncidentSortChange,
  governanceOnlyAlerts,
  onGovernanceOnlyAlertsChange,
  governanceFilterText,
  onGovernanceFilterTextChange,
  governanceFiltered,
}: {
  badge: ReactNode;
  layoutEditMode: boolean;
  onDetach: () => void;
  governanceSort: GovernanceSort;
  onGovernanceSortChange: (value: GovernanceSort) => void;
  incidentSort: IncidentSort;
  onIncidentSortChange: (value: IncidentSort) => void;
  governanceOnlyAlerts: boolean;
  onGovernanceOnlyAlertsChange: (value: boolean) => void;
  governanceFilterText: string;
  onGovernanceFilterTextChange: (value: string) => void;
  governanceFiltered: GovernanceRow[];
}) {
  return (
    <MonitoringPanelCard title="Governance" badge={badge} layoutEditMode={layoutEditMode} onDetach={onDetach}>
      <div className="governance-toolbar">
        <select value={governanceSort} onChange={(event) => onGovernanceSortChange(event.target.value as GovernanceSort)}>
          <option value="severity">tri: severity</option>
          <option value="label">tri: label</option>
          <option value="value">tri: value</option>
        </select>
        <select value={incidentSort} onChange={(event) => onIncidentSortChange(event.target.value as IncidentSort)}>
          <option value="severity">incidents: severity</option>
          <option value="status">incidents: status</option>
          <option value="sla">incidents: SLA</option>
        </select>
        <label className="governance-check"><input type="checkbox" checked={governanceOnlyAlerts} onChange={(event) => onGovernanceOnlyAlertsChange(event.target.checked)} /> alerts only</label>
      </div>
      <input value={governanceFilterText} onChange={(event) => onGovernanceFilterTextChange(event.target.value)} className="governance-search" placeholder="filtrer incidents / governance" />
      {governanceFiltered.slice(0, 8).map((row) => (
        <div key={row.label} className="mon-row">
          <span>{row.label}</span>
          <span className={row.severity >= 3 ? "warn" : row.severity >= 2 ? "subtle" : "good"}>{row.value}</span>
        </div>
      ))}
    </MonitoringPanelCard>
  );
}

export function ReadinessMonitoringPanel({
  badge,
  layoutEditMode,
  onDetach,
  driftItems,
  suspendedCount,
  memorySummary,
  incidents,
}: {
  badge: ReactNode;
  layoutEditMode: boolean;
  onDetach: () => void;
  driftItems: DriftItem[];
  suspendedCount: number;
  memorySummary: MemorySummary;
  incidents: Array<Record<string, unknown>>;
}) {
  return (
    <MonitoringPanelCard title="Readiness" badge={badge} layoutEditMode={layoutEditMode} onDetach={onDetach}>
      <div className="mon-row"><span>Drift</span><span>{driftItems.filter((item) => Boolean(item.drift_detected)).length}</span></div>
      <div className="mon-row"><span>Suspendues</span><span className={suspendedCount > 0 ? "warn" : "good"}>{suspendedCount}</span></div>
      <div className="mon-row"><span>Similarity</span><span>{String(memorySummary.avg_final_similarity || "–")}</span></div>
      <div className="mon-row"><span>Memory impact</span><span>{String(memorySummary.avg_memory_impact || "–")}</span></div>
      <div className="mon-row"><span>SLA breach</span><span className={incidents.some((item) => Boolean(item.sla_breached)) ? "warn" : "good"}>{incidents.filter((item) => Boolean(item.sla_breached)).length}</span></div>
    </MonitoringPanelCard>
  );
}

export function RiskTimelineMonitoringPanel({
  badge,
  layoutEditMode,
  onDetach,
  body,
}: {
  badge: ReactNode;
  layoutEditMode: boolean;
  onDetach: () => void;
  body: ReactNode;
}) {
  return (
    <MonitoringPanelCard title="Risk Compliance Timeline" badge={badge} layoutEditMode={layoutEditMode} onDetach={onDetach}>
      {body}
    </MonitoringPanelCard>
  );
}