"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";

import HelpHint from "../../components/HelpHint";
import PanelShell from "../../components/ui/PanelShell";
import type { SmartDecisionHudShape } from "./chartHudTypes";
import { buildFeedbackSummary } from "./feedbackEngine";
import SmartDecisionSummary from "./SmartDecisionSummary";

type RiskTimelineFilter = "all" | "compliant" | "miss";

type DomPanelLevel = { side: "bid" | "ask"; price: number; size: number; intensity: number };
type FootprintPanelRow = { low: number; high: number; buyVolume: number; sellVolume: number; delta: number; timeLabel?: string };
type TapePanelPrint = { label: string; price: number; side: "buy" | "sell" | "flat"; volume: number };
type BlotterOutcomeRow = Record<string, unknown>;
type BrokerProviderRow = Record<string, unknown>;
type BrokerBalanceRow = Record<string, unknown>;
type BrokerPositionRow = Record<string, unknown>;
type AlertRow = Record<string, unknown>;
type ExecutionOptimizerLivePayload = Record<string, unknown>;
type VenueTelemetryPayload = Record<string, unknown>;
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
  v6Action: string;
  v6ConfidencePct: number;
  v6Regime: string;
  v6PersistenceAvailable: boolean;
  v6PersistenceLabel: string;
  v6PersistenceError: string;
  edgeBps: number;
  v8Execute: boolean;
  v8ProbabilityPct: number;
  brainAction: string;
  brainConfidencePct: number;
  brainRegime: string;
  reasonLabel: string;
  smartDecision: SmartDecisionHudShape | null;
};

type ExecutionAiV6PanelPayload = Record<string, unknown>;
type ExecutionPnlAnalyzerPayload = Record<string, unknown>;

function safeNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function safeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function safeRows(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function safeTextArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
}

function toneClass(value: string, positive: string, warning: string): string {
  const normalized = value.trim().toUpperCase();
  if (positive.split("|").includes(normalized)) {
    return "good";
  }
  if (warning.split("|").includes(normalized)) {
    return "warn";
  }
  return "subtle";
}

function formatCompactUsd(value: unknown): string {
  const amount = safeNumber(value, 0);
  return `${amount.toFixed(Math.abs(amount) >= 100 ? 0 : 2)} USD`;
}

function formatSignedCompactUsd(value: unknown): string {
  const amount = safeNumber(value, 0);
  const label = formatCompactUsd(amount);
  return amount > 0 ? `+${label}` : label;
}

function formatCompactMetricMs(value: unknown): string {
  const numeric = safeNumber(value, -1);
  if (numeric < 0) {
    return "n/a";
  }
  if (numeric < 1000) {
    return `${Math.round(numeric)}ms`;
  }
  if (numeric < 60_000) {
    return `${(numeric / 1000).toFixed(numeric < 10_000 ? 1 : 0)}s`;
  }
  return `${Math.round(numeric / 60_000)}m`;
}

function formatCompactClock(value: unknown, formatClock: (value: string) => string): string {
  const iso = String(value || "").trim();
  return iso ? formatClock(iso) : "--:--:--";
}

function resolveVenueTelemetryTone(input: {
  freshestMs: number;
  avgSlippageBps: number;
  avgFillLatencyMs: number;
  avgFillQualityScore: number;
  stabilityState: string;
  proxyState: string;
}): "good" | "subtle" | "warn" {
  const freshness = Math.max(0, input.freshestMs);
  const stability = input.stabilityState.trim().toLowerCase();
  const proxyState = input.proxyState.trim().toLowerCase();
  if (
    proxyState === "degraded"
    || freshness >= 120_000
    || stability === "critical"
    || (input.avgFillQualityScore > 0 && input.avgFillQualityScore < 60)
  ) {
    return "warn";
  }
  if (
    proxyState === "retry_recovered"
    || freshness >= 20_000
    || input.avgSlippageBps >= 8
    || input.avgFillLatencyMs >= 220
    || stability === "degraded"
    || stability === "watch"
    || (input.avgFillQualityScore > 0 && input.avgFillQualityScore < 78)
  ) {
    return "subtle";
  }

  return "good";
}

function resolveExecutionOptimizerTone(order: Record<string, unknown>): "good" | "subtle" | "warn" {
  const guardReasons = Array.isArray(order.guard_reasons) ? order.guard_reasons.length : 0;
  const lifecycleAction = String(order.lifecycle_action || "keep").trim().toLowerCase();
  const fillScore = safeNumber(order.fill_score, 0);
  const predictedFill = safeNumber(order.predicted_fill_probability, 0);
  const adverseSelectionScore = safeNumber(order.adverse_selection_score, 0);
  if (guardReasons > 0 || Boolean(order.spoof_detected) || Boolean(order.liquidity_trap_detected) || lifecycleAction === "cancel" || adverseSelectionScore >= 0.78) {
    return "warn";
  }
  if (lifecycleAction === "replace" || lifecycleAction === "upgrade_to_market" || Boolean(order.should_move_ahead) || fillScore < 0.65 || predictedFill < 0.65) {
    return "subtle";
  }
  return "good";
}

function buildVenueTelemetryRows(
  marketPayload: VenueTelemetryPayload | null,
  routePayload: VenueTelemetryPayload | null,
): Array<Record<string, unknown>> {
  const marketEnvelope = safeRecord(marketPayload);
  const routeEnvelope = safeRecord(routePayload);
  const marketVenues = safeRows(marketEnvelope.venues);
  const routeVenues = safeRows(routeEnvelope.venues);
  const marketByVenue = new Map<string, Record<string, unknown>>();
  const routeByVenue = new Map<string, Record<string, unknown>>();

  for (const item of marketVenues) {
    const venue = String(item.venue || "unknown").trim();
    if (venue) {
      marketByVenue.set(venue, item);
    }
  }
  for (const item of routeVenues) {
    const venue = String(item.venue || "unknown").trim();
    if (venue) {
      routeByVenue.set(venue, item);
    }
  }

  const allVenues = [...new Set([...marketByVenue.keys(), ...routeByVenue.keys()])];
  const sharedProxyState = [String(routeEnvelope.network_state || ""), String(marketEnvelope.network_state || "")]
    .map((value) => value.trim().toLowerCase())
    .find((value) => value === "degraded")
    || [String(routeEnvelope.network_state || ""), String(marketEnvelope.network_state || "")]
      .map((value) => value.trim().toLowerCase())
      .find((value) => value === "retry_recovered")
    || "healthy";

  const rows = allVenues.map((venue) => {
    const routeRow = safeRecord(routeByVenue.get(venue));
    const routeMarket = safeRecord(routeRow.market);
    const fallbackMarket = safeRecord(marketByVenue.get(venue));
    const marketRow = Object.keys(routeMarket).length > 0 ? routeMarket : fallbackMarket;
    const executionRow = safeRecord(routeRow.execution);
    const stabilityRow = safeRecord(routeRow.stability);
    const profileRow = safeRecord(routeRow.profile);
    const instrumentRows = safeRows(marketRow.instruments);
    const freshestMs = Math.max(
      safeNumber(marketRow.max_quote_freshness_ms, 0),
      safeNumber(marketRow.max_depth_freshness_ms, 0),
      safeNumber(marketRow.max_trade_freshness_ms, 0),
    );
    const avgSlippageBps = safeNumber(executionRow.avg_slippage_bps, 0);
    const avgFillLatencyMs = safeNumber(executionRow.avg_fill_latency_ms, 0);
    const avgFillQualityScore = safeNumber(executionRow.avg_fill_quality_score, 0);
    const stabilityState = String(stabilityRow.state || stabilityRow.stability_state || "nominal");
    const tone = resolveVenueTelemetryTone({
      freshestMs,
      avgSlippageBps,
      avgFillLatencyMs,
      avgFillQualityScore,
      stabilityState,
      proxyState: sharedProxyState,
    });

    return {
      venue,
      tone,
      market: marketRow,
      execution: executionRow,
      stability: stabilityRow,
      profile: profileRow,
      instruments: instrumentRows,
      severity_score: tone === "warn" ? 2 : tone === "subtle" ? 1 : 0,
    };
  });

  rows.sort((left, right) => safeNumber(right.severity_score, 0) - safeNumber(left.severity_score, 0) || String(left.venue || "").localeCompare(String(right.venue || "")));
  return rows;
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
  "H24 Control Room": {
    text: "Salle de controle live: watchdog, gouvernance, memory gate, recovery, audit et warfare core sur un seul panneau.",
    examples: ["Si le watchdog passe en HALT, le bouton rouge doit etre considere comme prioritaire.", "Croiser health score, market state et audit trail avant toute promotion live."],
  },
  "Execution AI V6.1": {
    text: "Observabilite du moteur d'execution V6: persistence DB, guardrails, top actions apprises et episodes recents.",
    examples: ["Si la DB passe en degrade, l'alerte doit etre visible meme sans routing score actif.", "Les top actions et freeze reasons montrent si le moteur apprend encore ou s'est auto-protege."],
  },
  "Execution Context": {
    text: "Panneau desk policy: market structure, contexte d'execution, no-trade, sizing volatilite, fallback et freeze learning.",
    examples: ["Si le fallback passe en rules_only, le desk sait que l'execution reste possible mais sous regles strictes.", "Les seuils, la zone, le biais et le sizing montrent pourquoi le moteur coupe ou reduit un trade."],
  },
  "Execution PnL Truth": {
    text: "Verite PnL du desk: gains/pertes executes, frictions reelles, flags haute confiance et poids du no-trade.",
    examples: ["Si les high-confidence losses montent, le probleme vient du filtre ou de la confiance, pas d'une absence de features.", "Compare regime, venue et execution mode pour voir ou la route gagne ou detruit du PnL reel."],
  },
  "Venue Telemetry": {
    text: "Rassemble la sante feed et execution par venue: fraicheur quotes/depth/trades, spread, slippage, fill quality et contraintes de route.",
    examples: ["Si la fraicheur depth explose mais le proxy reste healthy, le souci vient du feed venue, pas du control plane.", "Une venue avec fill quality faible et slippage eleve doit etre re-degradee ou reroutee avant live."],
  },
  "Execution Smart Tracker": {
    text: "Tracker compact pour la calibration live V7 Smart: gate allow/block, delai, reduction de taille, score d'execution, score venue et frictions reelles.",
    examples: ["Si le score baisse mais que le gate reste allow, on reduit avant d'envisager un blocage global.", "Le panel se lit en sequence: gate live, frictions fenetre, puis PnL par posture d'execution."],
  },
};

function deriveDeskTruthState(input: {
  summary: Record<string, unknown>;
  liveOpsPayload?: Record<string, unknown> | null;
  executionAiV6Payload?: ExecutionAiV6PanelPayload | null;
}): { label: "OK" | "REDUCE" | "BLOCK"; tone: "good" | "subtle" | "warn"; reason: string } {
  const summary = safeRecord(input.summary);
  const liveOps = safeRecord(input.liveOpsPayload);
  const watchdog = safeRecord(liveOps.watchdog_state);
  const governance = safeRecord(liveOps.governance);
  const v6Envelope = safeRecord(input.executionAiV6Payload);
  const v6Snapshot = safeRecord(v6Envelope.snapshot);
  const v6Guardrails = safeRecord(v6Snapshot.guardrails);

  const tradeCount = safeNumber(summary.trade_count, 0);
  const noTradeCount = safeNumber(summary.no_trade_dominance_count, 0);
  const highConfidenceLossCount = safeNumber(summary.high_confidence_loss_count, 0);
  const avgLatencyMs = safeNumber(summary.avg_latency_ms, 0);
  const avgSlippageBps = safeNumber(summary.avg_slippage_bps, 0);
  const netPnlUsd = safeNumber(summary.net_pnl_usd, 0);
  const winRatePct = safeNumber(summary.win_rate_pct, 0);
  const noTradeRatio = tradeCount > 0 ? noTradeCount / tradeCount : 0;
  const watchdogStatus = String(watchdog.status || "OK").trim().toUpperCase();
  const governanceMode = String(governance.mode || "SAFE").trim().toUpperCase();
  const learningFrozen = Boolean(v6Guardrails.learning_frozen);

  if (watchdogStatus === "HALT" || governanceMode === "LOCKED") {
    return { label: "BLOCK", tone: "warn", reason: "system guardrails locked the desk" };
  }
  if (tradeCount >= 5 && (highConfidenceLossCount >= 2 || (netPnlUsd < 0 && winRatePct < 40))) {
    return { label: "BLOCK", tone: "warn", reason: "live truth says stop and re-check the filter" };
  }
  if (tradeCount < 3) {
    return { label: "REDUCE", tone: "subtle", reason: "collect more small live samples before trusting the edge" };
  }
  if (learningFrozen || avgLatencyMs > 120 || avgSlippageBps > 3 || noTradeRatio < 0.1) {
    return { label: "REDUCE", tone: "subtle", reason: "keep size down and let no-trade dominate harder" };
  }
  return { label: "OK", tone: "good", reason: "truth engine is stable enough for guarded micro-live" };
}

function aggregateDominanceReasons(trades: Array<Record<string, unknown>>): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const trade of trades) {
    const reasons = [...safeTextArray(trade.dominant_reasons), ...safeTextArray(trade.no_trade_reasons)];
    for (const reason of reasons) {
      counts.set(reason, (counts.get(reason) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
    .slice(0, 5);
}

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
        {layoutEditMode ? <button type="button" className="panel-detach-btn" title="Detacher ce panneau" onClick={onDetach}>⤡</button> : null}
      </div>
      <div className="monitoring-panel-scroll">{children}</div>
    </div>
  );
}

type OperatorActionSummaryProps = {
  badge?: ReactNode;
  executionPnlPayload: ExecutionPnlAnalyzerPayload | null;
  liveOpsPayload?: Record<string, unknown> | null;
  executionAiV6Payload?: ExecutionAiV6PanelPayload | null;
  routingPayload?: Record<string, unknown> | null;
  smartDecision?: SmartDecisionHudShape | null;
  journalContext?: {
    symbol: string;
    timeframe: string;
    strategy: string;
  };
  formatClock: (value: string) => string;
  footer?: ReactNode;
};

type OperatorJournalEntry = {
  id: string;
  createdAtIso: string;
  symbol: string;
  timeframe: string;
  strategy: string;
  action: string;
  detail: string;
  meta?: Record<string, unknown>;
};

type OperatorActionDecision = {
  action: "STOP" | "NO TRADE" | "WAIT" | "REDUCE SIZE" | "ENTRY SMALL";
  tone: "good" | "subtle" | "warn";
  riskLabel: "faible" | "moyen" | "eleve";
  headline: string;
  summary: string;
  reasons: string[];
  metrics: Array<{ label: string; value: string; tone: "good" | "subtle" | "warn" }>;
  nextStep: string;
  updatedAt: string | null;
  hardGuardActive: boolean;
  hardGuardLabel: "TRADE BLOQUE" | "GARDE ACTIVE";
  hardGuardReasons: string[];
  dominancePct: number;
  dominanceTone: "good" | "subtle" | "warn";
  dominanceState: "EXPLOITABLE" | "PRUDENCE" | "ATTENDRE" | "BLOQUE";
  dominanceDetail: string;
  postTradeFeedback: {
    label: "BON TRADE" | "MAUVAIS TRADE" | "PAS DE FEEDBACK";
    tone: "good" | "subtle" | "warn";
    summary: string;
    reasons: string[];
  };
};

type DisciplineHeatCell = {
  label: string;
  value: string;
  tone: "good" | "subtle" | "warn";
};

type DisciplineHeatRow = {
  label: string;
  cells: DisciplineHeatCell[];
};

type DisciplineAnalytics = {
  score: number;
  scoreTone: "good" | "subtle" | "warn";
  scoreLabel: string;
  driftState: "CALM" | "WATCH" | "DRIFT" | "LOCK";
  driftTone: "good" | "subtle" | "warn";
  summary: string;
  recommendation: string;
  penalties: string[];
  driftReasons: string[];
  blockedOverrideCount24h: number;
  blockedOverrideEntries: OperatorJournalEntry[];
  lastBlockedOverrideEvent: OperatorJournalEntry | null;
  latestEvent: OperatorJournalEntry | null;
  kpis: Array<{ label: string; value: string; tone: "good" | "subtle" | "warn" }>;
  heatmap: DisciplineHeatRow[];
};

const OPERATOR_OVERRIDE_STORAGE_KEY = "txt.operator.override.v1";

function isOperatorJournalEntry(value: unknown): value is OperatorJournalEntry {
  const row = safeRecord(value);
  return Boolean(
    String(row.id || "").trim()
    && String(row.createdAtIso || "").trim()
    && String(row.symbol || "").trim()
    && String(row.timeframe || "").trim()
    && String(row.strategy || "").trim()
    && String(row.action || "").trim()
    && String(row.detail || "").trim(),
  );
}

function formatOperatorJournalAction(action: string): string {
  const normalized = action.trim().toLowerCase();
  switch (normalized) {
    case "override-visible-on":
      return "override visible";
    case "override-visible-off":
      return "override retire";
    case "override-blocked-lock":
      return "override bloque";
    case "auto-reduce":
      return "reduction forcee";
    case "auto-close":
      return "sortie forcee";
    case "emergency-stop":
      return "emergency stop";
    case "system-mode-changed":
      return "mode systeme";
    case "ops-brief-opened":
      return "brief ops";
    case "commandant-brief-opened":
      return "mode commandant";
    case "daily-plan-brief-opened":
      return "brief journalier";
    case "sprint-brief-opened":
      return "brief sprint";
    case "daily-plan-task-done":
      return "tache discipline validee";
    case "daily-plan-task-reopened":
      return "tache discipline reouverte";
    case "daily-plan-sprint-reset":
      return "sprint recale";
    default:
      return normalized.replace(/[-_]/g, " ");
  }
}

const DISCIPLINE_ACTIONS = new Set([
  "auto-reduce",
  "auto-close",
  "override-blocked-lock",
  "override-visible-on",
  "override-visible-off",
  "emergency-stop",
  "system-mode-changed",
  "ops-brief-opened",
  "commandant-brief-opened",
  "daily-plan-brief-opened",
  "sprint-brief-opened",
  "daily-plan-task-done",
  "daily-plan-task-reopened",
  "daily-plan-sprint-reset",
]);

function buildOperatorJournalAnalytics(entries: OperatorJournalEntry[]): {
  overrideCount: number;
  overrideActive: boolean;
  blockedOverrideCount: number;
  lastBlockedOverrideEntry: OperatorJournalEntry | null;
  lastOverrideEntry: OperatorJournalEntry | null;
  lastOverrideEvent: OperatorJournalEntry | null;
  disciplineCount: number;
  latestEntries: OperatorJournalEntry[];
} {
  const overrideEvents = entries.filter((entry) => entry.action === "override-visible-on" || entry.action === "override-visible-off");
  const blockedOverrideEvents = entries.filter((entry) => entry.action === "override-blocked-lock");
  const disciplineEvents = entries.filter((entry) => DISCIPLINE_ACTIONS.has(entry.action));
  const lastOverrideEvent = overrideEvents[0] || null;
  const lastOverrideEntry = overrideEvents.find((entry) => entry.action === "override-visible-on") || null;
  return {
    overrideCount: overrideEvents.filter((entry) => entry.action === "override-visible-on").length,
    overrideActive: lastOverrideEvent?.action === "override-visible-on",
    blockedOverrideCount: blockedOverrideEvents.length,
    lastBlockedOverrideEntry: blockedOverrideEvents[0] || null,
    lastOverrideEntry,
    lastOverrideEvent,
    disciplineCount: disciplineEvents.length,
    latestEntries: entries.slice(0, 6),
  };
}

function normalizeOperatorKey(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

function countJournalEntriesWithinHours(entries: OperatorJournalEntry[], actions: Set<string>, hours: number): number {
  const now = Date.now();
  const windowMs = hours * 60 * 60 * 1000;
  return entries.filter((entry) => {
    if (!actions.has(normalizeOperatorKey(entry.action))) {
      return false;
    }
    const createdAt = Date.parse(entry.createdAtIso);
    return Number.isFinite(createdAt) && now - createdAt <= windowMs;
  }).length;
}

function buildDisciplineHeatmap(entries: OperatorJournalEntry[]): DisciplineHeatRow[] {
  const windows = [
    { label: "24h", hours: 24 },
    { label: "72h", hours: 72 },
    { label: "7j", hours: 168 },
  ];
  const rows = [
    {
      label: "Overrides visibles",
      positive: false,
      actions: new Set(["override-visible-on"]),
    },
    {
      label: "Overrides bloques",
      positive: false,
      actions: new Set(["override-blocked-lock"]),
    },
    {
      label: "Protections forcees",
      positive: false,
      actions: new Set(["auto-reduce", "auto-close", "emergency-stop"]),
    },
    {
      label: "Checklist reouverte",
      positive: false,
      actions: new Set(["daily-plan-task-reopened", "daily-plan-sprint-reset"]),
    },
    {
      label: "Checklist validee",
      positive: true,
      actions: new Set(["daily-plan-task-done", "daily-plan-brief-opened", "sprint-brief-opened"]),
    },
  ];

  return rows.map((row) => ({
    label: row.label,
    cells: windows.map((window) => {
      const count = countJournalEntriesWithinHours(entries, row.actions, window.hours);
      const tone = row.positive
        ? count >= 3
          ? "good"
          : count >= 1
            ? "subtle"
            : "subtle"
        : count === 0
          ? "good"
          : count === 1
            ? "subtle"
            : "warn";
      return {
        label: window.label,
        value: String(count),
        tone,
      } satisfies DisciplineHeatCell;
    }),
  }));
}

function resolveDriftItemsFromPayload(payload: unknown): DriftItem[] {
  const envelope = safeRecord(payload);
  const nested = safeRecord(envelope.drift);
  if (Array.isArray(envelope.items)) {
    return safeRows(envelope.items);
  }
  if (Array.isArray(nested.items)) {
    return safeRows(nested.items);
  }
  return [];
}

function filterRelevantDriftItems(items: DriftItem[], context: { strategy: string; symbol: string }): DriftItem[] {
  const strategyKey = normalizeOperatorKey(context.strategy);
  const symbolKey = normalizeOperatorKey(context.symbol);
  const filtered = items.filter((item) => {
    const row = safeRecord(item);
    const candidateKeys = [
      row.strategy,
      row.strategy_id,
      row.scope_id,
      row.scope_type,
      row.symbol,
      row.instrument,
      row.regime,
      row.name,
    ].map(normalizeOperatorKey).filter(Boolean);

    if (strategyKey && candidateKeys.some((candidate) => candidate === strategyKey || candidate.includes(strategyKey) || strategyKey.includes(candidate))) {
      return true;
    }
    if (symbolKey && candidateKeys.some((candidate) => candidate === symbolKey || candidate.includes(symbolKey) || symbolKey.includes(candidate))) {
      return true;
    }
    return false;
  });
  return filtered.length > 0 ? filtered : items;
}

function buildDisciplineAnalytics(input: {
  entries: OperatorJournalEntry[];
  decision: OperatorActionDecision;
  executionPnlPayload: ExecutionPnlAnalyzerPayload | null;
  liveOpsPayload?: Record<string, unknown> | null;
  driftItems: DriftItem[];
  journalContext?: {
    symbol: string;
    timeframe: string;
    strategy: string;
  };
}): DisciplineAnalytics {
  const pnlSummary = safeRecord(safeRecord(input.executionPnlPayload).summary);
  const liveOps = safeRecord(input.liveOpsPayload);
  const watchdog = safeRecord(liveOps.watchdog_state);
  const governance = safeRecord(liveOps.governance);
  const journalEntries = input.entries;
  const heatmap = buildDisciplineHeatmap(journalEntries);
  const overrides24h = countJournalEntriesWithinHours(journalEntries, new Set(["override-visible-on"]), 24);
  const blockedOverrides24h = countJournalEntriesWithinHours(journalEntries, new Set(["override-blocked-lock"]), 24);
  const forced24h = countJournalEntriesWithinHours(journalEntries, new Set(["auto-reduce", "auto-close", "emergency-stop"]), 24);
  const reopened7d = countJournalEntriesWithinHours(journalEntries, new Set(["daily-plan-task-reopened", "daily-plan-sprint-reset"]), 168);
  const checklist7d = countJournalEntriesWithinHours(journalEntries, new Set(["daily-plan-task-done", "daily-plan-brief-opened", "sprint-brief-opened"]), 168);
  const modeChanges72h = countJournalEntriesWithinHours(journalEntries, new Set(["system-mode-changed"]), 72);
  const blockedOverrideEntries = journalEntries.filter((entry) => entry.action === "override-blocked-lock").slice(0, 3);
  const tradeCount = safeNumber(pnlSummary.trade_count, 0);
  const highConfidenceLossCount = safeNumber(pnlSummary.high_confidence_loss_count, 0);
  const noTradeCount = safeNumber(pnlSummary.no_trade_dominance_count, 0);
  const noTradeRatioPct = tradeCount > 0 ? (noTradeCount / tradeCount) * 100 : 0;
  const avgLatencyMs = safeNumber(pnlSummary.avg_latency_ms, 0);
  const avgSlippageBps = safeNumber(pnlSummary.avg_slippage_bps, 0);
  const netPnlUsd = safeNumber(pnlSummary.net_pnl_usd, 0);
  const watchdogStatus = normalizeOperatorKey(watchdog.status).toUpperCase();
  const governanceMode = normalizeOperatorKey(governance.mode).toUpperCase();
  const relevantDriftItems = filterRelevantDriftItems(input.driftItems, {
    strategy: String(input.journalContext?.strategy || ""),
    symbol: String(input.journalContext?.symbol || ""),
  });
  const activeDriftItems = relevantDriftItems.filter((item) => Boolean(safeRecord(item).drift_detected));
  const driftReasons = [...new Set(activeDriftItems
    .map((item) => {
      const row = safeRecord(item);
      return String(row.reason || row.detail || row.regime || row.strategy || row.symbol || "").trim();
    })
    .filter(Boolean))].slice(0, 4);
  const penalties: string[] = [];
  let score = 100;

  if (overrides24h > 0) {
    score -= overrides24h * 12;
    penalties.push(`${overrides24h} override visible sur 24h`);
  }
  if (blockedOverrides24h > 0) {
    score -= Math.min(12, blockedOverrides24h * 4);
    penalties.push(`${blockedOverrides24h} override bloque sur 24h`);
  }
  if (forced24h > 0) {
    score -= forced24h * 16;
    penalties.push(`${forced24h} protection forcee sur 24h`);
  }
  if (reopened7d > 0) {
    score -= Math.min(18, reopened7d * 6);
    penalties.push(`${reopened7d} checklist reouverte sur 7j`);
  }
  if (modeChanges72h >= 2) {
    score -= 8;
    penalties.push(`${modeChanges72h} changements de posture en 72h`);
  }
  if (input.decision.hardGuardActive) {
    score -= 10;
    penalties.push("hard guard actif");
  }
  if (input.decision.postTradeFeedback.tone === "warn") {
    score -= 14;
    penalties.push("dernier trade juge mauvais");
  } else if (input.decision.postTradeFeedback.tone === "subtle") {
    score -= 6;
  }
  if (tradeCount >= 5 && netPnlUsd < 0) {
    score -= 10;
    penalties.push(`verite PnL ${formatSignedCompactUsd(netPnlUsd)}`);
  }
  if (highConfidenceLossCount > 0) {
    score -= Math.min(16, highConfidenceLossCount * 6);
    penalties.push(`${highConfidenceLossCount} perte haute confiance`);
  }
  if (avgLatencyMs > 120) {
    score -= avgLatencyMs > 200 ? 10 : 5;
    penalties.push(`latence ${Math.round(avgLatencyMs)}ms`);
  }
  if (avgSlippageBps > 3) {
    score -= avgSlippageBps > 5 ? 10 : 5;
    penalties.push(`slippage ${avgSlippageBps.toFixed(2)}bps`);
  }
  if (tradeCount >= 3 && noTradeRatioPct < 10) {
    score -= 8;
    penalties.push("no-trade trop peu dominant");
  }
  if (activeDriftItems.length > 0) {
    score -= Math.min(20, activeDriftItems.length * 8);
    penalties.push(`${activeDriftItems.length} ligne de drift active`);
  }
  if (watchdogStatus === "HALT" || governanceMode === "LOCKED") {
    score = Math.min(score, 20);
    penalties.unshift("desk verrouille par les guardrails");
  }
  if (checklist7d > reopened7d && checklist7d > 0) {
    score += 4;
  }
  score = Math.max(0, Math.min(100, Math.round(score)));

  const scoreTone = score >= 82 ? "good" : score >= 65 ? "subtle" : "warn";
  const scoreLabel = score >= 82 ? "discipline propre" : score >= 65 ? "discipline sous surveillance" : "discipline en derive";
  const driftState: DisciplineAnalytics["driftState"] = watchdogStatus === "HALT" || governanceMode === "LOCKED" || forced24h > 0 || activeDriftItems.length >= 2 || score < 45
    ? "LOCK"
    : activeDriftItems.length >= 1 || score < 65 || input.decision.postTradeFeedback.tone === "warn" || highConfidenceLossCount > 0
      ? "DRIFT"
      : overrides24h > 0 || reopened7d > 0 || modeChanges72h >= 2 || score < 82
        ? "WATCH"
        : "CALM";
  const driftTone = driftState === "CALM" ? "good" : driftState === "WATCH" ? "subtle" : "warn";
  const summary = driftState === "LOCK"
    ? "La discipline ne tient plus assez proprement pour justifier une acceleration ou un override discret."
    : driftState === "DRIFT"
      ? "La derive est visible: il faut ralentir, relire la verite PnL et retirer les frictions avant le prochain cycle."
      : driftState === "WATCH"
        ? "Le desk reste exploitable, mais la discipline n'est pas encore assez lisse pour monter en confiance."
        : "Le journal et la verite live restent coherents: conserve le cadre et n'ajoute pas de complexite inutile.";
  const recommendation = driftState === "LOCK"
    ? "Coupe le rythme, retire les overrides et traite d'abord le drift actif ou le hard guard avant toute execution suivante."
    : driftState === "DRIFT"
      ? "Repasse en micro-live, force le no-trade et n'autorise qu'un seul ajustement a la fois tant que le score ne remonte pas."
      : driftState === "WATCH"
        ? "Garde la taille petite, surveille les reouvertures de checklist et evite les changements de posture rapproches."
        : "Conserve le meme cadre, logue proprement les exceptions et laisse la discipline dominer l'envie d'agir.";
  const latestEvent = journalEntries[0] || null;
  const kpis: DisciplineAnalytics["kpis"] = [
    { label: "Discipline score", value: `${score}/100`, tone: scoreTone },
    { label: "Drift watchdog", value: driftState, tone: driftTone },
    { label: "Overrides 24h", value: String(overrides24h), tone: overrides24h === 0 ? "good" : overrides24h === 1 ? "subtle" : "warn" },
    { label: "Overrides bloques", value: String(blockedOverrides24h), tone: blockedOverrides24h === 0 ? "good" : blockedOverrides24h === 1 ? "subtle" : "warn" },
    { label: "Protections 24h", value: String(forced24h), tone: forced24h === 0 ? "good" : forced24h === 1 ? "subtle" : "warn" },
    { label: "Checklist 7j", value: `${checklist7d}/${Math.max(checklist7d + reopened7d, 1)}`, tone: checklist7d >= reopened7d ? "good" : "warn" },
    { label: "Drift actif", value: String(activeDriftItems.length), tone: activeDriftItems.length === 0 ? "good" : activeDriftItems.length === 1 ? "subtle" : "warn" },
  ];

  return {
    score,
    scoreTone,
    scoreLabel,
    driftState,
    driftTone,
    summary,
    recommendation,
    penalties: penalties.length > 0 ? penalties.slice(0, 5) : ["aucune derive recente visible dans le journal discipline"],
    driftReasons,
    blockedOverrideCount24h: blockedOverrides24h,
    blockedOverrideEntries,
    lastBlockedOverrideEvent: blockedOverrideEntries[0] || null,
    latestEvent,
    kpis,
    heatmap,
  };
}

function buildPostTradeFeedback(trades: Array<Record<string, unknown>>): OperatorActionDecision["postTradeFeedback"] {
  const latestTrade = safeRecord(trades[0]);
  if (Object.keys(latestTrade).length === 0) {
    return {
      label: "PAS DE FEEDBACK",
      tone: "subtle",
      summary: "Aucun trade recent a relire, donc pas de feedback execution pour l'instant.",
      reasons: ["attends un trade execute pour juger l'entree, le fill et la friction reelle"],
    };
  }

  const netResultUsd = safeNumber(latestTrade.net_result_usd, 0);
  const latencyMs = safeNumber(latestTrade.latency_ms, 0);
  const slippageBps = Math.abs(safeNumber(latestTrade.slippage_real_bps, 0));
  const confidence = safeNumber(latestTrade.confidence, 0);
  const fallbackMode = String(latestTrade.fallback_mode || "normal");
  const againstNoTrade = Boolean(latestTrade.no_trade_dominance);
  const reasons: string[] = [];

  if (netResultUsd < 0) {
    reasons.push(`resultat ${formatSignedCompactUsd(netResultUsd)}`);
  }
  if (slippageBps > 3) {
    reasons.push(`fill trop cher ${slippageBps.toFixed(2)}bps`);
  }
  if (latencyMs > 120) {
    reasons.push(`latence mauvaise ${Math.round(latencyMs)}ms`);
  }
  if (confidence >= 0.7 && netResultUsd < 0) {
    reasons.push("perte haute confiance");
  }
  if (againstNoTrade) {
    reasons.push("trade pris contre la dominance no-trade");
  }
  if (fallbackMode !== "normal") {
    reasons.push(`fallback ${fallbackMode.replace(/_/g, " ")}`);
  }

  if (reasons.length > 0) {
    return {
      label: "MAUVAIS TRADE",
      tone: "warn",
      summary: "Le dernier trade montre une execution ou une discipline a corriger avant d'accelerer.",
      reasons,
    };
  }

  return {
    label: "BON TRADE",
    tone: "good",
    summary: "Le dernier trade respecte plutot bien le cadre execution/risk du desk.",
    reasons: [
      `resultat ${formatSignedCompactUsd(netResultUsd)}`,
      slippageBps > 0 ? `slippage contenu ${slippageBps.toFixed(2)}bps` : "slippage contenu",
      latencyMs > 0 ? `latence correcte ${Math.round(latencyMs)}ms` : "latence propre",
    ],
  };
}

function buildOperatorActionDecision(input: {
  executionPnlPayload: ExecutionPnlAnalyzerPayload | null;
  liveOpsPayload?: Record<string, unknown> | null;
  executionAiV6Payload?: ExecutionAiV6PanelPayload | null;
  routingPayload?: Record<string, unknown> | null;
  smartDecision?: SmartDecisionHudShape | null;
}): OperatorActionDecision {
  const envelope = safeRecord(input.executionPnlPayload);
  const summary = safeRecord(envelope.summary);
  const trades = safeRows(envelope.trades);
  const liveOps = safeRecord(input.liveOpsPayload);
  const watchdog = safeRecord(liveOps.watchdog_state);
  const governance = safeRecord(liveOps.governance);
  const routingEnvelope = safeRecord(input.routingPayload);
  const executionContext = safeRecord(routingEnvelope.execution_context);
  const policy = safeRecord(executionContext.policy);
  const dominance = safeRecord(routingEnvelope.dominance);
  const bestRoute = safeRecord(routingEnvelope.best);
  const v6Envelope = safeRecord(input.executionAiV6Payload);
  const v6Snapshot = safeRecord(v6Envelope.snapshot);
  const v6Guardrails = safeRecord(v6Snapshot.guardrails);
  const v6PersistenceAvailable = typeof v6Guardrails.persistence_available === "boolean"
    ? Boolean(v6Guardrails.persistence_available)
    : true;
  const smartDecision = input.smartDecision ?? null;
  const truthState = deriveDeskTruthState({ summary, liveOpsPayload: input.liveOpsPayload, executionAiV6Payload: input.executionAiV6Payload });
  const dominanceReasons = aggregateDominanceReasons(trades).slice(0, 3).map((item) => `${item.label} x${item.count}`);
  const noTradeReasons = safeTextArray(executionContext.no_trade_reasons).slice(0, 3);
  const freezeReasons = safeTextArray(executionContext.freeze_learning_reasons).slice(0, 2);
  const tradeCount = safeNumber(summary.trade_count, 0);
  const noTradeCount = safeNumber(summary.no_trade_dominance_count, 0);
  const noTradeRatioPct = tradeCount > 0 ? (noTradeCount / tradeCount) * 100 : 0;
  const confidencePct = safeNumber(executionContext.confidence, 0) * 100;
  const dominanceGapPct = safeNumber(dominance.score_gap, 0) * 100;
  const avgLatencyMs = safeNumber(summary.avg_latency_ms, 0);
  const avgSlippageBps = safeNumber(summary.avg_slippage_bps, 0);
  const learningFrozen = Boolean(v6Guardrails.learning_frozen);
  const noTrade = Boolean(executionContext.no_trade || policy.no_trade);
  const watchdogStatus = String(watchdog.status || "OK").trim().toUpperCase();
  const governanceMode = String(governance.mode || "SAFE").trim().toUpperCase();
  const leadingVenue = String(dominance.leader_venue || bestRoute.venue || "--");
  const updatedAt = String(envelope.updated_at || liveOps.updated_at || "").trim() || null;
  const negativeStreak = (() => {
    let streak = 0;
    for (const trade of trades) {
      if (safeNumber(trade.net_result_usd, 0) < 0) {
        streak += 1;
        continue;
      }
      break;
    }
    return streak;
  })();
  const hardGuardReasons: string[] = [];
  if (watchdogStatus === "HALT") {
    hardGuardReasons.push("watchdog en HALT");
  }
  if (governanceMode === "LOCKED") {
    hardGuardReasons.push("gouvernance lockee");
  }
  if (noTrade) {
    hardGuardReasons.push("desk policy en NO TRADE");
  }
  if (confidencePct > 0 && confidencePct < 40) {
    hardGuardReasons.push(`confidence ${confidencePct.toFixed(0)}% < 40%`);
  }
  if (avgLatencyMs > 120) {
    hardGuardReasons.push(`latence ${Math.round(avgLatencyMs)}ms > seuil`);
  }
  if (negativeStreak >= 2) {
    hardGuardReasons.push(`streak negatif ${negativeStreak}`);
  }
  if (!v6PersistenceAvailable) {
    hardGuardReasons.push("DB V6 indisponible");
  }
  const hardGuardActive = hardGuardReasons.length > 0;
  const postTradeFeedback = buildPostTradeFeedback(trades);
  const dominanceTone = noTrade ? "warn" : noTradeRatioPct >= 70 ? "warn" : noTradeRatioPct >= 50 ? "subtle" : "good";
  const dominanceState = noTrade ? "BLOQUE" : noTradeRatioPct >= 70 ? "ATTENDRE" : noTradeRatioPct >= 50 ? "PRUDENCE" : "EXPLOITABLE";
  const dominanceDetail = noTrade
    ? "Le moteur bloque deja l'entree: aucune justification de trade n'est suffisante tant que le contexte ne se nettoie pas."
    : noTradeRatioPct >= 70
      ? "Le flux est dominé par le refus de trade: la meilleure action est d'attendre."
      : noTradeRatioPct >= 50
        ? "Le desk reste lisible mais demande une prudence forte et une taille minimale."
        : "Le no-trade ne domine plus le flux: le contexte redevient exploitable sous garde-fous.";
  const riskLabel = hardGuardActive || truthState.label === "BLOCK"
    ? "eleve"
    : truthState.label === "REDUCE" || noTradeRatioPct >= 50 || postTradeFeedback.tone === "warn"
      ? "moyen"
      : "faible";

  const metrics: OperatorActionDecision["metrics"] = [
    { label: "Truth", value: truthState.label, tone: truthState.tone as OperatorActionDecision["metrics"][number]["tone"] },
    { label: "No-trade", value: `${noTradeRatioPct.toFixed(0)}%`, tone: noTradeRatioPct >= 70 ? "warn" : noTradeRatioPct >= 35 ? "subtle" : "good" },
    { label: "Confidence", value: smartDecision?.confidenceBand || (confidencePct > 0 ? `${confidencePct.toFixed(0)}%` : "n/a"), tone: smartDecision ? (smartDecision.confidenceBand === "HIGH" ? "good" : smartDecision.confidenceBand === "MEDIUM" ? "subtle" : "warn") : confidencePct >= 60 ? "good" : confidencePct >= 40 ? "subtle" : "warn" },
    { label: "Latency", value: formatCompactMetricMs(avgLatencyMs), tone: avgLatencyMs > 120 ? "warn" : avgLatencyMs > 80 ? "subtle" : "good" },
    { label: "Slippage", value: `${avgSlippageBps.toFixed(2)}bps`, tone: avgSlippageBps > 3 ? "warn" : avgSlippageBps > 1.5 ? "subtle" : "good" },
    { label: "Dominance", value: leadingVenue === "--" ? "n/a" : `${leadingVenue} ${dominanceGapPct.toFixed(0)}%`, tone: dominanceGapPct >= 8 ? "good" : dominanceGapPct >= 4 ? "subtle" : "warn" },
  ];

  if (watchdogStatus === "HALT" || governanceMode === "LOCKED" || truthState.label === "BLOCK") {
    return {
      action: "STOP",
      tone: "warn",
      riskLabel,
      headline: "Arrete le live et repasse par la verification.",
      summary: "Le desk n'est pas dans un etat ou une nouvelle prise de risque est defendable.",
      reasons: [
        truthState.reason,
        watchdogStatus === "HALT" ? "watchdog en HALT" : `governance ${governanceMode.toLowerCase()}`,
        avgLatencyMs > 0 ? `latence moyenne ${Math.round(avgLatencyMs)}ms` : "verite PnL deja en blocage",
      ],
      metrics,
      nextStep: "Traite l'alerte ou la cause de blocage avant toute nouvelle execution.",
      updatedAt,
      hardGuardActive,
      hardGuardLabel: "TRADE BLOQUE",
      hardGuardReasons,
      dominancePct: noTradeRatioPct,
      dominanceTone,
      dominanceState,
      dominanceDetail,
      postTradeFeedback,
    };
  }

  if (noTrade) {
    return {
      action: "NO TRADE",
      tone: "warn",
      riskLabel,
      headline: "Le filtre d'execution interdit une entree maintenant.",
      summary: "Le systeme voit un contexte ou la meilleure decision est de ne rien lancer.",
      reasons: noTradeReasons.length > 0 ? noTradeReasons : ["desk policy activee", truthState.reason, `confidence ${confidencePct.toFixed(0)}%`],
      metrics,
      nextStep: "Attends un contexte eligible ou corrige la cause precise avant de reconsiderer le trade.",
      updatedAt,
      hardGuardActive: true,
      hardGuardLabel: "TRADE BLOQUE",
      hardGuardReasons,
      dominancePct: noTradeRatioPct,
      dominanceTone,
      dominanceState,
      dominanceDetail,
      postTradeFeedback,
    };
  }

  if (smartDecision?.state === "NO_TRADE") {
    return {
      action: "NO TRADE",
      tone: "warn",
      riskLabel,
      headline: "Le smart decision engine invalide l'entree.",
      summary: "La couche structure/liquidite/regime ne voit pas de trade defendable dans sa forme actuelle.",
      reasons: [smartDecision.headline, smartDecision.reason, `stability ${smartDecision.stability.statusLabel}`],
      metrics,
      nextStep: "Attends une structure plus propre ou une baisse du bruit avant de reconsiderer le live.",
      updatedAt,
      hardGuardActive,
      hardGuardLabel: hardGuardActive ? "GARDE ACTIVE" : "TRADE BLOQUE",
      hardGuardReasons,
      dominancePct: noTradeRatioPct,
      dominanceTone,
      dominanceState,
      dominanceDetail,
      postTradeFeedback,
    };
  }

  if (smartDecision?.state === "FAKE_BREAKOUT_RISK" || smartDecision?.state === "WAIT_CONFIRMATION") {
    return {
      action: "WAIT",
      tone: smartDecision.tone,
      riskLabel,
      headline: smartDecision.headline,
      summary: "Le signal instantane n'est pas encore tradable; la priorite est la persistance et non la vitesse.",
      reasons: [smartDecision.reason, `confidence ${smartDecision.confidenceBand}`, `stability ${smartDecision.stability.statusLabel}`],
      metrics,
      nextStep: "Laisse la decision se stabiliser avant d'engager du risque ou d'augmenter la taille.",
      updatedAt,
      hardGuardActive,
      hardGuardLabel: hardGuardActive ? "GARDE ACTIVE" : "TRADE BLOQUE",
      hardGuardReasons,
      dominancePct: noTradeRatioPct,
      dominanceTone,
      dominanceState,
      dominanceDetail,
      postTradeFeedback,
    };
  }

  if (noTradeRatioPct >= 70 || (confidencePct > 0 && confidencePct < 40)) {
    return {
      action: "WAIT",
      tone: "subtle",
      riskLabel,
      headline: "Observe encore un cycle avant d'engager du risque.",
      summary: "Le contexte n'est pas assez propre pour transformer le signal en decision exploitable.",
      reasons: [
        noTradeRatioPct >= 70 ? `no-trade dominance ${noTradeRatioPct.toFixed(0)}%` : `confidence faible ${confidencePct.toFixed(0)}%`,
        dominanceReasons[0] || truthState.reason,
        avgLatencyMs > 0 ? `latence moyenne ${Math.round(avgLatencyMs)}ms` : "pas assez de confirmations propres",
      ],
      metrics,
      nextStep: "Laisse le marche se clarifier et relis la route quand la dominance ou la confiance remontent.",
      updatedAt,
      hardGuardActive,
      hardGuardLabel: hardGuardActive ? "GARDE ACTIVE" : "TRADE BLOQUE",
      hardGuardReasons,
      dominancePct: noTradeRatioPct,
      dominanceTone,
      dominanceState,
      dominanceDetail,
      postTradeFeedback,
    };
  }

  if (learningFrozen || truthState.label === "REDUCE" || avgLatencyMs > 120 || avgSlippageBps > 3) {
    return {
      action: "REDUCE SIZE",
      tone: "subtle",
      riskLabel,
      headline: "Si tu executes, reste en micro-size gouverne.",
      summary: "L'edge n'est pas casse, mais la friction ou les guardrails imposent une posture prudente.",
      reasons: [
        learningFrozen ? "learning gele par guardrail" : truthState.reason,
        avgLatencyMs > 120 ? `latence ${Math.round(avgLatencyMs)}ms` : `slippage ${avgSlippageBps.toFixed(2)}bps`,
        freezeReasons[0] || dominanceReasons[0] || "friction execution a surveiller",
      ],
      metrics,
      nextStep: "Reduis la taille, confirme la qualite de fill, puis seulement re-augmente si la friction baisse.",
      updatedAt,
      hardGuardActive,
      hardGuardLabel: hardGuardActive ? "GARDE ACTIVE" : "TRADE BLOQUE",
      hardGuardReasons,
      dominancePct: noTradeRatioPct,
      dominanceTone,
      dominanceState,
      dominanceDetail,
      postTradeFeedback,
    };
  }

  if (dominanceGapPct >= 8 && confidencePct >= 60) {
    const entryHeadline = smartDecision?.state === "ENTRY_VALID"
      ? "Le smart decision engine autorise une entree petite et stable."
      : "Le desk autorise une entree petite et surveillee.";
    const entryReasons = smartDecision?.state === "ENTRY_VALID"
      ? [smartDecision.headline, `confidence ${smartDecision.confidenceBand}`, `stability ${smartDecision.stability.statusLabel}`]
      : [`dominance claire sur ${leadingVenue}`, `confidence ${confidencePct.toFixed(0)}%`, truthState.reason];
    return {
      action: "ENTRY SMALL",
      tone: "good",
      riskLabel,
      headline: entryHeadline,
      summary: "Les signaux restent assez coherents pour un micro-live, pas pour une acceleration agressive.",
      reasons: entryReasons,
      metrics,
      nextStep: "Execute petit, surveille fill/slippage, puis confirme que le contexte tient sur les prochains prints.",
      updatedAt,
      hardGuardActive,
      hardGuardLabel: hardGuardActive ? "GARDE ACTIVE" : "TRADE BLOQUE",
      hardGuardReasons,
      dominancePct: noTradeRatioPct,
      dominanceTone,
      dominanceState,
      dominanceDetail,
      postTradeFeedback,
    };
  }

  return {
    action: "WAIT",
    tone: "subtle",
    riskLabel,
    headline: "Le desk reste exploitable, mais pas encore assez propre pour pousser le risque.",
    summary: "Rien n'impose un stop, mais le contexte ne donne pas encore une autorisation forte.",
    reasons: [
      truthState.reason,
      dominanceReasons[0] || "dominance encore moyenne",
      confidencePct > 0 ? `confidence ${confidencePct.toFixed(0)}%` : "pas assez de contexte route",
    ],
    metrics,
    nextStep: "Attends un meilleur alignement entre truth, dominance et confiance avant d'agir.",
    updatedAt,
    hardGuardActive,
    hardGuardLabel: hardGuardActive ? "GARDE ACTIVE" : "TRADE BLOQUE",
    hardGuardReasons,
    dominancePct: noTradeRatioPct,
    dominanceTone,
    dominanceState,
    dominanceDetail,
    postTradeFeedback,
  };
}

export function OperatorActionSummary({
  badge,
  executionPnlPayload,
  liveOpsPayload,
  executionAiV6Payload,
  routingPayload,
  smartDecision,
  journalContext,
  formatClock,
  footer,
}: OperatorActionSummaryProps) {
  const decision = useMemo(() => buildOperatorActionDecision({
    executionPnlPayload,
    liveOpsPayload,
    executionAiV6Payload,
    routingPayload,
    smartDecision,
  }), [executionAiV6Payload, executionPnlPayload, liveOpsPayload, routingPayload, smartDecision]);
  const journalSymbol = String(journalContext?.symbol || "").trim().toUpperCase();
  const journalTimeframe = String(journalContext?.timeframe || "").trim();
  const journalStrategy = String(journalContext?.strategy || "").trim();
  const journalEnabled = Boolean(journalSymbol && journalTimeframe && journalStrategy);
  const [overrideArmed, setOverrideArmed] = useState(false);
  const [overrideDraft, setOverrideDraft] = useState("");
  const [overrideRecord, setOverrideRecord] = useState<{ reason: string; createdAt: string; action: string } | null>(null);
  const [journalEntries, setJournalEntries] = useState<OperatorJournalEntry[]>([]);
  const [journalBusy, setJournalBusy] = useState(false);
  const [journalError, setJournalError] = useState<string | null>(null);
  const [driftItems, setDriftItems] = useState<DriftItem[]>([]);
  const [driftBusy, setDriftBusy] = useState(false);
  const [driftError, setDriftError] = useState<string | null>(null);
  const journalAnalytics = useMemo(() => buildOperatorJournalAnalytics(journalEntries), [journalEntries]);
  const feedbackSummary = useMemo(() => buildFeedbackSummary({
    executionPnlPayload,
    liveOpsPayload,
    executionAiV6Payload,
    journalEntries,
  }), [executionAiV6Payload, executionPnlPayload, journalEntries, liveOpsPayload]);
  const overrideLockActive = feedbackSummary.driftState === "LOCK" || feedbackSummary.learningDisabled;
  const overrideLockReason = feedbackSummary.protections[0] || "drift LOCK";
  const disciplineAnalytics = useMemo(() => buildDisciplineAnalytics({
    entries: journalEntries,
    decision,
    executionPnlPayload,
    liveOpsPayload,
    driftItems,
    journalContext,
  }), [decision, executionPnlPayload, liveOpsPayload, driftItems, journalContext, journalEntries]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const raw = window.localStorage.getItem(OPERATOR_OVERRIDE_STORAGE_KEY);
    if (!raw) {
      return;
    }
    try {
      const parsed = JSON.parse(raw) as { reason?: string; createdAt?: string; action?: string };
      if (parsed && parsed.reason && parsed.createdAt && parsed.action) {
        setOverrideRecord({ reason: parsed.reason, createdAt: parsed.createdAt, action: parsed.action });
      }
    } catch {
      window.localStorage.removeItem(OPERATOR_OVERRIDE_STORAGE_KEY);
    }
  }, []);

  useEffect(() => {
    if (!overrideLockActive) {
      return;
    }
    setOverrideArmed(false);
  }, [overrideLockActive]);

  useEffect(() => {
    if (!journalEnabled) {
      setJournalEntries([]);
      setJournalBusy(false);
      setJournalError(null);
      return;
    }
    let cancelled = false;
    const loadJournal = async () => {
      setJournalBusy(true);
      const query = new URLSearchParams();
      query.set("symbol", journalSymbol);
      query.set("timeframe", journalTimeframe);
      query.set("strategy", journalStrategy);
      query.set("limit", "80");
      const response = await fetch(`/api/terminal/v2-risk-journal?${query.toString()}`, { cache: "no-store" }).catch(() => null);
      const payload = response ? await response.json().catch(() => null) : null;
      if (cancelled) {
        return;
      }
      if (!response || !response.ok || !payload || !Array.isArray(payload.entries)) {
        setJournalError("Journal discipline indisponible");
        setJournalBusy(false);
        return;
      }
      setJournalEntries(payload.entries.filter(isOperatorJournalEntry));
      setJournalError(null);
      setJournalBusy(false);
    };
    void loadJournal();
    return () => {
      cancelled = true;
    };
  }, [journalEnabled, journalStrategy, journalSymbol, journalTimeframe]);

  useEffect(() => {
    let cancelled = false;
    const loadDrift = async () => {
      setDriftBusy(true);
      const response = await fetch("/api/strategies/drift", { cache: "no-store" }).catch(() => null);
      const payload = response ? await response.json().catch(() => null) : null;
      if (cancelled) {
        return;
      }
      if (!response || !response.ok || !payload) {
        setDriftError("Drift strategy indisponible");
        setDriftBusy(false);
        return;
      }
      setDriftItems(resolveDriftItemsFromPayload(payload));
      setDriftError(null);
      setDriftBusy(false);
    };

    void loadDrift();
    const timer = window.setInterval(() => {
      void loadDrift();
    }, 30_000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  async function appendOperatorJournalEntry(action: string, detail: string, meta?: Record<string, unknown>): Promise<void> {
    if (!journalEnabled) {
      return;
    }
    const response = await fetch("/api/terminal/v2-risk-journal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol: journalSymbol,
        timeframe: journalTimeframe,
        strategy: journalStrategy,
        action,
        detail,
        meta: meta || {},
      }),
    }).catch(() => null);
    const payload = response ? await response.json().catch(() => null) : null;
    if (payload?.entry && isOperatorJournalEntry(payload.entry)) {
      setJournalEntries((current) => [payload.entry, ...current].slice(0, 80));
      setJournalError(null);
      return;
    }
    setJournalError("Journal discipline indisponible");
  }

  function confirmOverride(): void {
    const reason = overrideDraft.trim();
    if (!reason || typeof window === "undefined") {
      return;
    }
    if (overrideLockActive) {
      setOverrideArmed(false);
      setOverrideDraft("");
      void appendOperatorJournalEntry("override-blocked-lock", `Override bloque: ${overrideLockReason}`, {
        forced_action: decision.action,
        drift_state: feedbackSummary.driftState,
        protections: feedbackSummary.protections,
        source: "operator-action-summary",
      });
      setJournalError(`Override bloque: ${overrideLockReason}`);
      return;
    }
    const nextRecord = {
      reason,
      createdAt: new Date().toISOString(),
      action: decision.action,
    };
    window.localStorage.setItem(OPERATOR_OVERRIDE_STORAGE_KEY, JSON.stringify(nextRecord));
    setOverrideRecord(nextRecord);
    setOverrideArmed(false);
    setOverrideDraft("");
    void appendOperatorJournalEntry("override-visible-on", reason, {
      forced_action: decision.action,
      hard_guard_active: decision.hardGuardActive,
      hard_guard_reasons: decision.hardGuardReasons,
      dominance_pct: Number(decision.dominancePct.toFixed(2)),
      risk_label: decision.riskLabel,
      source: "operator-action-summary",
    });
  }

  function clearOverride(): void {
    const currentOverride = overrideRecord;
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(OPERATOR_OVERRIDE_STORAGE_KEY);
    }
    setOverrideRecord(null);
    setOverrideArmed(false);
    setOverrideDraft("");
    if (currentOverride) {
      void appendOperatorJournalEntry("override-visible-off", currentOverride.reason, {
        forced_action: currentOverride.action,
        source: "operator-action-summary",
      });
    }
  }

  return (
    <div className={`operator-action-panel ${decision.tone}`}>
      <div className="operator-action-head">
        <div className="eyebrow" style={{ marginBottom: 6 }}>
          Que faire maintenant
          <HelpHint
            text="Bloc operateur central: il transforme l'etat du desk en action immediate pour eviter la hesitation ou la lecture partielle du terminal."
            examples={[
              "STOP = coupe le live et traite le blocage avant de reprendre.",
              "ENTRY SMALL = entree petite, gouvernee, avec verification fill/slippage.",
            ]}
            label="Guide action"
          />
        </div>
        {badge ? <div className="operator-action-badge">{badge}</div> : null}
      </div>
      <div className="operator-action-grid">
        <div className="operator-action-status-card">
          {smartDecision ? <SmartDecisionSummary decision={smartDecision} variant="operator" showLevels={false} /> : null}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <div className={`operator-action-chip ${decision.tone}`}>{decision.action}</div>
            <div className={`operator-action-risk-pill ${decision.riskLabel === "eleve" ? "warn" : decision.riskLabel === "moyen" ? "subtle" : "good"}`}>
              risque {decision.riskLabel}
            </div>
          </div>
          <div className="operator-action-headline">{decision.headline}</div>
          <div className="subtle mini">{decision.summary}</div>
        </div>
        <div className="operator-action-reasons-card">
          <div className="subtle mini" style={{ marginBottom: 6 }}>Pourquoi maintenant</div>
          {decision.reasons.map((reason) => (
            <div key={reason} className="operator-action-reason-row">
              <span className={`operator-action-dot ${decision.tone}`} />
              <span>{reason}</span>
            </div>
          ))}
          <div className="operator-action-next-step">{decision.nextStep}</div>
          {decision.updatedAt ? <div className="subtle mini">Derniere mise a jour utile: {formatClock(decision.updatedAt)}</div> : null}
        </div>
      </div>
      <div className={`operator-dominance-card ${decision.dominanceTone}`}>
        <div>
          <div className="subtle mini">No-trade dominance</div>
          <div className="operator-dominance-value">{decision.dominancePct.toFixed(0)}%</div>
        </div>
        <div>
          <div className={`operator-dominance-chip ${decision.dominanceTone}`}>{decision.dominanceState}</div>
          <div className="operator-dominance-text">{decision.dominanceDetail}</div>
        </div>
      </div>
      {decision.hardGuardActive ? (
        <div className={`operator-hard-guard ${decision.tone}`}>
          <div className="operator-hard-guard-head">
            <div className="operator-hard-guard-label">{decision.hardGuardLabel}</div>
            <div className="subtle mini">override possible mais visible</div>
          </div>
          <div className="operator-hard-guard-list">
            {decision.hardGuardReasons.map((reason) => (
              <div key={reason} className="operator-hard-guard-row">{reason}</div>
            ))}
          </div>
          {overrideLockActive ? (
            <div className="operator-override-locked">
              <div className="operator-hard-guard-label">Override bloque</div>
              <div className="subtle mini">Drift {feedbackSummary.driftState} · {overrideLockReason}</div>
            </div>
          ) : null}
          {overrideRecord ? (
            <div className="operator-override-banner">
              <div className="subtle mini">Override actif depuis {formatClock(overrideRecord.createdAt)}</div>
              <div>{overrideRecord.action} force: {overrideRecord.reason}</div>
              <button type="button" onClick={clearOverride}>Retirer l'override visible</button>
            </div>
          ) : overrideArmed ? (
            <div className="operator-override-compose">
              <textarea
                value={overrideDraft}
                onChange={(event) => setOverrideDraft(event.target.value)}
                rows={3}
                placeholder="Raison visible de l'override (ex: je reduis a micro-size pour test strict)."
              />
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button type="button" disabled={!overrideDraft.trim() || overrideLockActive} onClick={confirmOverride}>Confirmer l'override visible</button>
                <button type="button" onClick={() => setOverrideArmed(false)}>Annuler</button>
              </div>
            </div>
          ) : (
            <button type="button" disabled={overrideLockActive} onClick={() => setOverrideArmed(true)}>Passer outre quand meme</button>
          )}
        </div>
      ) : null}
      <div className={`operator-feedback-card ${decision.postTradeFeedback.tone}`}>
        <div className="operator-feedback-head">
          <div className={`operator-feedback-chip ${decision.postTradeFeedback.tone}`}>{decision.postTradeFeedback.label}</div>
          <div className="subtle mini">Feedback post-trade</div>
        </div>
        <div className="operator-feedback-summary">{decision.postTradeFeedback.summary}</div>
        <div className="operator-feedback-list">
          {decision.postTradeFeedback.reasons.map((reason) => (
            <div key={reason} className="operator-feedback-row">{reason}</div>
          ))}
        </div>
      </div>
      <div className="operator-discipline-grid">
        <div className="operator-discipline-card">
          <div className="operator-feedback-head">
            <div>
              <div className="subtle mini">Discipline analytics</div>
              <div className="operator-discipline-score-row">
                <strong className={`operator-discipline-score ${disciplineAnalytics.scoreTone}`}>{disciplineAnalytics.score}/100</strong>
                <div className={`operator-dominance-chip ${disciplineAnalytics.scoreTone}`}>{disciplineAnalytics.scoreLabel}</div>
              </div>
            </div>
            <div className={`operator-dominance-chip ${disciplineAnalytics.driftTone}`}>{disciplineAnalytics.driftState}</div>
          </div>
          <div className="operator-discipline-kpi-grid">
            {disciplineAnalytics.kpis.map((metric) => (
              <div key={metric.label} className="operator-journal-kpi">
                <span className="subtle mini">{metric.label}</span>
                <strong className={metric.tone}>{metric.value}</strong>
              </div>
            ))}
          </div>
          <div className="operator-journal-summary">{disciplineAnalytics.summary}</div>
          <div className="operator-discipline-list">
            {disciplineAnalytics.penalties.map((penalty) => (
              <div key={penalty} className="operator-discipline-row">{penalty}</div>
            ))}
          </div>
          {disciplineAnalytics.driftReasons.length > 0 ? (
            <div className="operator-discipline-drift-box">
              <div className="subtle mini">Sources probables du drift</div>
              <div className="operator-discipline-list">
                {disciplineAnalytics.driftReasons.map((reason) => (
                  <div key={reason} className="operator-discipline-row">{reason}</div>
                ))}
              </div>
            </div>
          ) : null}
          <div className="operator-discipline-drift-box operator-discipline-blocked-box" data-testid="operator-discipline-blocked-overrides">
            <div className="operator-feedback-head">
              <div className="subtle mini">Overrides bloques visibles</div>
              <div className={`operator-dominance-chip ${disciplineAnalytics.blockedOverrideCount24h === 0 ? "good" : disciplineAnalytics.blockedOverrideCount24h === 1 ? "subtle" : "warn"}`}>
                {disciplineAnalytics.blockedOverrideCount24h} sur 24h
              </div>
            </div>
            <div className="operator-journal-summary">
              {disciplineAnalytics.lastBlockedOverrideEvent
                ? `Derniere tentative a ${formatClock(disciplineAnalytics.lastBlockedOverrideEvent.createdAtIso)}: ${disciplineAnalytics.lastBlockedOverrideEvent.detail}`
                : "Aucune tentative d'override bloquee sur ce contexte recent."}
            </div>
            <div className="operator-discipline-list">
              {disciplineAnalytics.blockedOverrideEntries.length > 0 ? disciplineAnalytics.blockedOverrideEntries.map((entry) => (
                <div key={entry.id} className="operator-discipline-row operator-discipline-blocked-row">
                  <strong>{formatClock(entry.createdAtIso)}</strong>
                  <span>{entry.detail}</span>
                </div>
              )) : (
                <div className="operator-discipline-row operator-discipline-blocked-row">
                  <strong>OK</strong>
                  <span>Le verrou discipline n'a bloque aucun override recent.</span>
                </div>
              )}
            </div>
          </div>
          {driftError ? <div className="operator-journal-summary warn">{driftError}</div> : null}
        </div>
        <div className="operator-discipline-card">
          <div className="operator-feedback-head">
            <div className="subtle mini">Heatmap discipline</div>
            <div className="subtle mini">{journalBusy || driftBusy ? "sync..." : "24h / 72h / 7j"}</div>
          </div>
          <div className="operator-heatmap-grid" role="table" aria-label="Heatmap discipline recente">
            <div className="operator-heatmap-spacer" />
            <div className="operator-heatmap-heading">24h</div>
            <div className="operator-heatmap-heading">72h</div>
            <div className="operator-heatmap-heading">7j</div>
            {disciplineAnalytics.heatmap.map((row) => (
              <div key={row.label} className="operator-heatmap-row-group">
                <div className="operator-heatmap-label">{row.label}</div>
                {row.cells.map((cell) => (
                  <div key={`${row.label}-${cell.label}`} className={`operator-heatmap-cell ${cell.tone}`}>
                    <strong>{cell.value}</strong>
                    <span>{cell.label}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
          <div className="operator-journal-summary">{disciplineAnalytics.recommendation}</div>
          {disciplineAnalytics.latestEvent ? (
            <div className="subtle mini">
              Dernier signal journal: {formatOperatorJournalAction(disciplineAnalytics.latestEvent.action)} a {formatClock(disciplineAnalytics.latestEvent.createdAtIso)}.
            </div>
          ) : (
            <div className="subtle mini">Aucun signal journal recent sur ce contexte.</div>
          )}
        </div>
      </div>
      {journalEnabled ? (
        <>
          <div className="operator-journal-grid">
            <div className="operator-journal-analytics-card">
              <div className="operator-feedback-head">
                <div className="subtle mini">Override analytics</div>
                <div className={`operator-dominance-chip ${journalAnalytics.overrideActive ? "warn" : "good"}`}>
                  {journalAnalytics.overrideActive ? "override actif" : "override off"}
                </div>
              </div>
              <div className="operator-journal-kpi-grid">
                <div className="operator-journal-kpi">
                  <span className="subtle mini">Overrides visibles</span>
                  <strong>{journalAnalytics.overrideCount}</strong>
                </div>
                <div className="operator-journal-kpi">
                  <span className="subtle mini">Overrides bloques</span>
                  <strong>{journalAnalytics.blockedOverrideCount}</strong>
                </div>
                <div className="operator-journal-kpi">
                  <span className="subtle mini">Events discipline</span>
                  <strong>{journalAnalytics.disciplineCount}</strong>
                </div>
              </div>
              {journalAnalytics.lastBlockedOverrideEntry ? (
                <div className="operator-journal-summary warn">
                  Dernier blocage {formatClock(journalAnalytics.lastBlockedOverrideEntry.createdAtIso)}: {journalAnalytics.lastBlockedOverrideEntry.detail}
                </div>
              ) : null}
              {journalAnalytics.lastOverrideEntry ? (
                <div className="operator-journal-summary">
                  Dernier forcage {formatClock(journalAnalytics.lastOverrideEntry.createdAtIso)}: {journalAnalytics.lastOverrideEntry.detail}
                </div>
              ) : (
                <div className="operator-journal-summary">Aucun override visible persiste sur ce contexte.</div>
              )}
            </div>
            <div className="operator-journal-analytics-card">
              <div className="operator-feedback-head">
                <div className="subtle mini">Journal discipline</div>
                {journalBusy ? <div className="subtle mini">sync...</div> : null}
              </div>
              {journalError ? <div className="operator-journal-summary warn">{journalError}</div> : null}
              <div className="operator-journal-list">
                {journalAnalytics.latestEntries.length > 0 ? journalAnalytics.latestEntries.map((entry) => (
                  <div key={entry.id} className="operator-journal-row">
                    <div>
                      <div className="operator-journal-row-head">
                        <strong>{formatOperatorJournalAction(entry.action)}</strong>
                        <span className="subtle mini">{formatClock(entry.createdAtIso)}</span>
                      </div>
                      <div className="operator-journal-row-detail">{entry.detail}</div>
                    </div>
                    <div className="subtle mini">{entry.symbol} · {entry.timeframe} · {entry.strategy}</div>
                  </div>
                )) : (
                  <div className="operator-journal-summary">Aucun evenement de discipline enregistre pour ce contexte.</div>
                )}
              </div>
            </div>
          </div>
        </>
      ) : null}
      <div className="operator-action-metrics">
        {decision.metrics.map((metric) => (
          <div key={metric.label} className="operator-action-metric">
            <span className="subtle mini">{metric.label}</span>
            <strong className={metric.tone}>{metric.value}</strong>
          </div>
        ))}
      </div>
      {footer ? <div className="operator-action-footer">{footer}</div> : null}
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
            {aiBridge.smartDecision ? <div className="row"><span>Smart state</span><span className={aiBridge.smartDecision.tone}>{aiBridge.smartDecision.displayStateLabel} | {aiBridge.smartDecision.confidenceBand}</span></div> : null}
            {aiBridge.smartDecision ? <div className="row"><span>Decision gate</span><span className={aiBridge.smartDecision.qualityGate === "pass" ? "good" : aiBridge.smartDecision.qualityGate === "warn" ? "subtle" : "warn"}>{aiBridge.smartDecision.qualityGateLabel} | {aiBridge.smartDecision.stability.statusLabel}</span></div> : null}
            <div className="row"><span>V7 gate</span><span className={aiBridge.v7Tone === "good" ? "good" : aiBridge.v7Tone === "warn" ? "warn" : "subtle"}>{aiBridge.v7Label}</span></div>
            <div className="row"><span>V6 policy</span><span className={aiBridge.v6Action === "HOLD" ? "subtle" : "good"}>{aiBridge.v6Action} | {aiBridge.v6ConfidencePct.toFixed(0)}%</span></div>
            <div className="row"><span>V6 regime</span><span>{aiBridge.v6Regime}</span></div>
            <div className="row"><span>V6 DB</span><span className={aiBridge.v6PersistenceAvailable ? "good" : "warn"}>{aiBridge.v6PersistenceLabel}</span></div>
            <div className="row"><span>Route</span><span>{aiBridge.routeLabel} | {aiBridge.routeScore.toFixed(2)}</span></div>
            <div className="row"><span>Final edge</span><span className={aiBridge.edgeBps >= 0 ? "good" : "warn"}>{aiBridge.edgeBps.toFixed(1)} bps</span></div>
            <div className="row"><span>V8 execute</span><span className={aiBridge.v8Execute ? "good" : "subtle"}>{aiBridge.v8Execute ? "yes" : "hold"} | {aiBridge.v8ProbabilityPct.toFixed(0)}%</span></div>
            <div className="row"><span>Brain</span><span>{aiBridge.brainAction} | {aiBridge.brainConfidencePct.toFixed(0)}%</span></div>
            <div className="row"><span>Regime</span><span>{aiBridge.brainRegime}</span></div>
            <div className="subtle mini gtix-ellipsis" style={{ marginTop: 6 }}>{aiBridge.smartDecision?.headline || aiBridge.reasonLabel || "No predictor rationale"}</div>
            {aiBridge.smartDecision ? <div className="subtle mini gtix-ellipsis">{aiBridge.smartDecision.reason}</div> : null}
            {!aiBridge.v6PersistenceAvailable && aiBridge.v6PersistenceError ? (
              <div className="warn mini gtix-ellipsis" style={{ marginTop: 4 }}>{aiBridge.v6PersistenceError}</div>
            ) : null}
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

export function ControlRoomMonitoringPanel({
  badge,
  layoutEditMode,
  onDetach,
  liveOpsPayload,
  executionAiV6Payload,
  emergencyStopBusy,
  emergencyStopFeedback,
  onEmergencyStop,
  formatClock,
}: {
  badge: ReactNode;
  layoutEditMode: boolean;
  onDetach: () => void;
  liveOpsPayload: Record<string, unknown> | null;
  executionAiV6Payload?: ExecutionAiV6PanelPayload | null;
  emergencyStopBusy: boolean;
  emergencyStopFeedback: string | null;
  onEmergencyStop: () => void;
  formatClock: (value: string) => string;
}) {
  const snapshot = safeRecord(liveOpsPayload);
  const watchdog = safeRecord(snapshot.watchdog_state);
  const governance = safeRecord(snapshot.governance);
  const recovery = safeRecord(snapshot.recovery);
  const risk = safeRecord(snapshot.risk_snapshot);
  const memoryGap = safeRecord(snapshot.memory_gap);
  const warfare = safeRecord(snapshot.warfare_core);
  const arbitrage = safeRecord(warfare.arbitrage);
  const smartMoney = safeRecord(warfare.smart_money);
  const spoof = safeRecord(warfare.spoof);
  const marketState = safeRecord(warfare.market_state);
  const domination = safeRecord(warfare.domination);
  const auditTrail = safeRows(snapshot.audit_trail).slice(0, 3);
  const riskTimeline = safeRows(snapshot.risk_timeline).slice(0, 3);
  const exposureRows = safeRows(risk.exposure_by_symbol).slice(0, 3);
  const venueRankings = safeRows(arbitrage.rankings).slice(0, 4);
  const executionAiV6Envelope = safeRecord(executionAiV6Payload);
  const executionAiV6Snapshot = safeRecord(executionAiV6Envelope.snapshot);
  const executionAiV6Guardrails = safeRecord(executionAiV6Snapshot.guardrails);
  const watchdogTriggers = Array.isArray(watchdog.triggers) ? watchdog.triggers.map((item) => String(item)).filter(Boolean).slice(0, 4) : [];
  const executionAiV6FreezeReasons = Array.isArray(executionAiV6Guardrails.freeze_reasons)
    ? executionAiV6Guardrails.freeze_reasons.map((item) => String(item)).filter(Boolean).slice(0, 3)
    : [];
  const healthScore = safeNumber(watchdog.health_score, 0);
  const watchdogStatus = String(watchdog.status || "UNKNOWN");
  const systemMode = String(governance.mode || "SAFE");
  const recoveryMode = String(recovery.mode || "NOMINAL");
  const memoryDecision = String(memoryGap.memory_decision || "OK");
  const dominationState = String(domination.state || "WEAK");
  const marketStateLabel = String(marketState.state || "CHOP");
  const arbitrageExecutable = Boolean(arbitrage.executable);
  const arbitrageEdge = safeNumber(arbitrage.netEdgeBps, 0);
  const executableDepthUsd = safeNumber(arbitrage.maxExecutableUsd, 0);
  const executionAiV6PersistenceAvailable = typeof executionAiV6Guardrails.persistence_available === "boolean"
    ? Boolean(executionAiV6Guardrails.persistence_available)
    : true;

  return (
    <MonitoringPanelCard title="H24 Control Room" badge={badge} layoutEditMode={layoutEditMode} onDetach={onDetach}>
      {!liveOpsPayload ? <p className="subtle mini">Control room indisponible.</p> : null}
      {liveOpsPayload ? (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
            <div style={{ padding: "8px 10px", borderRadius: 10, border: "1px solid rgba(148, 163, 184, 0.18)", background: "rgba(15, 23, 42, 0.24)" }}>
              <div className="subtle mini">Health score</div>
              <div className={healthScore >= 80 ? "good" : healthScore >= 60 ? "subtle" : "warn"} style={{ fontSize: 18, fontWeight: 700 }}>{healthScore.toFixed(0)}%</div>
              <div className={`subtle mini ${toneClass(watchdogStatus, "OK", "HALT|WARNING")}`}>watchdog {watchdogStatus}</div>
            </div>
            <div style={{ padding: "8px 10px", borderRadius: 10, border: "1px solid rgba(148, 163, 184, 0.18)", background: "rgba(15, 23, 42, 0.24)" }}>
              <div className="subtle mini">System lock</div>
              <div className={toneClass(systemMode, "LIVE", "LOCKED")} style={{ fontSize: 18, fontWeight: 700 }}>{systemMode}</div>
              <div className="subtle mini">{String(governance.backend_mode || "guarded_auto")} · {recoveryMode}</div>
            </div>
          </div>
          <div className="mon-row"><span>Memory gate</span><span className={toneClass(memoryDecision, "OK", "BLOCKED|WATCH")}>{memoryDecision}</span></div>
          <div className="mon-row"><span>Drawdown</span><span className={safeNumber(risk.dd_pct, 0) >= 2 ? "warn" : safeNumber(risk.dd_pct, 0) >= 1 ? "subtle" : "good"}>{safeNumber(risk.dd_pct, 0).toFixed(2)}% · {formatCompactUsd(risk.dd_usd)}</span></div>
          <div className="mon-row"><span>Slippage / day use</span><span>{safeNumber(risk.avg_slippage_bps, 0).toFixed(2)}bps · {formatCompactUsd(risk.daily_used_usd)}</span></div>
          <div className="mon-row"><span>Market state</span><span className={toneClass(marketStateLabel, "TREND", "TRAP|HIGH_VOL|DEAD")}>{marketStateLabel} · {(safeNumber(marketState.confidence, 0) * 100).toFixed(0)}%</span></div>
          <div className="mon-row"><span>Warfare</span><span>{String(smartMoney.state || "INACTIVE")} / {String(spoof.state || "CLEAR")} / {dominationState}</span></div>
          <div className="mon-row"><span>Execution AI V6</span><span className={executionAiV6PersistenceAvailable ? "good" : "warn"}>{executionAiV6PersistenceAvailable ? "DB online" : "DB degraded"}</span></div>
          <div className="mon-row"><span>V6 guardrails</span><span className={Boolean(executionAiV6Guardrails.learning_frozen) ? "warn" : "good"}>{Boolean(executionAiV6Guardrails.learning_frozen) ? "frozen" : "active"} · {safeNumber(executionAiV6Snapshot.context_count, 0).toFixed(0)} ctx</span></div>
          <div className="mon-row"><span>Arbitrage</span><span className={arbitrageExecutable && arbitrageEdge > 0 ? "good" : "subtle"}>{arbitrageExecutable ? `${String(arbitrage.buyVenue || "buy")} → ${String(arbitrage.sellVenue || "sell")} · +${arbitrageEdge.toFixed(2)}bps` : "standby"}</span></div>
          <div className="mon-row"><span>Executable depth</span><span className={executableDepthUsd > 0 ? "good" : "subtle"}>{formatCompactUsd(executableDepthUsd)}</span></div>
          {watchdogTriggers.length > 0 ? <div className="subtle mini" style={{ marginTop: 6 }}>Triggers: {watchdogTriggers.join(" · ")}</div> : null}
          {executionAiV6FreezeReasons.length > 0 ? <div className="subtle mini warn" style={{ marginTop: 6 }}>V6 freeze: {executionAiV6FreezeReasons.join(" · ")}</div> : null}
          {!executionAiV6PersistenceAvailable && String(executionAiV6Guardrails.last_persist_error || "") ? <div className="subtle mini warn" style={{ marginTop: 4 }}>V6 DB: {String(executionAiV6Guardrails.last_persist_error || "")}</div> : null}
          <div style={{ display: "flex", gap: 8, marginTop: 10, marginBottom: 8 }}>
            <button type="button" className="chart-chip" onClick={onEmergencyStop} disabled={emergencyStopBusy} style={{ color: "#ffd5d5", borderColor: "rgba(248, 113, 113, 0.5)" }}>
              {emergencyStopBusy ? "Emergency stop..." : "Emergency stop"}
            </button>
            <span className="subtle mini" style={{ alignSelf: "center" }}>
              {String(recovery.active) === "true" ? "Recovery active" : "Recovery nominal"}
            </span>
          </div>
          {emergencyStopFeedback ? <p className="subtle mini" style={{ marginTop: 0 }}>{emergencyStopFeedback}</p> : null}
          <div style={{ marginTop: 10 }}>
            <div className="subtle mini" style={{ marginBottom: 4 }}>Venue ladder</div>
            {venueRankings.length === 0 ? <p className="subtle mini">Aucune venue classee.</p> : null}
            {venueRankings.map((row, index) => (
              <div key={`ops-venue-${index}`} className="mon-row">
                <span>{String(row.venue || "venue").slice(0, 10)}</span>
                <span className="subtle mini">{safeNumber(row.totalCostBps, 0).toFixed(2)}bps · {safeNumber(row.latencyMs, 0).toFixed(0)}ms</span>
                <span className={Boolean(row.executable) ? "good" : "warn"}>{safeNumber(row.availableDepthUsd, 0).toFixed(0)} USD</span>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 10 }}>
            <div className="subtle mini" style={{ marginBottom: 4 }}>Exposure concentration</div>
            {exposureRows.length === 0 ? <p className="subtle mini">Aucune exposition recente.</p> : null}
            {exposureRows.map((row, index) => (
              <div key={`ops-exposure-${index}`} className="mon-row">
                <span>{String(row.symbol || "BOOK").slice(0, 10)}</span>
                <span className="subtle mini">notional proxy</span>
                <span>{formatCompactUsd(row.notionalUsd)}</span>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 10 }}>
            <div className="subtle mini" style={{ marginBottom: 4 }}>Audit trail</div>
            {auditTrail.length === 0 ? <p className="subtle mini">Aucun audit recent.</p> : null}
            {auditTrail.map((row, index) => (
              <div key={`ops-audit-${index}`} className="mon-row">
                <span>{String(row.at) ? formatClock(String(row.at)) : "--:--:--"}</span>
                <span className="subtle mini">{String(row.route || row.decision || "n/a").slice(0, 20)}</span>
                <span className={String(row.result || "").includes("BLOCK") ? "warn" : "good"}>{String(row.result || "OK").slice(0, 10)}</span>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 10 }}>
            <div className="subtle mini" style={{ marginBottom: 4 }}>Risk timeline</div>
            {riskTimeline.length === 0 ? <p className="subtle mini">Aucun point risque recent.</p> : null}
            {riskTimeline.map((row, index) => (
              <div key={`ops-risk-${index}`} className="mon-row">
                <span>{String(row.at) ? formatClock(String(row.at)) : "--:--:--"}</span>
                <span className="subtle mini">{String(row.exposure_symbol || "BOOK").slice(0, 10)}</span>
                <span className={safeNumber(row.dd_pct, 0) >= 2 ? "warn" : "subtle"}>{safeNumber(row.dd_pct, 0).toFixed(2)}%</span>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </MonitoringPanelCard>
  );
}

export function ExecutionPnlTruthMonitoringPanel({
  badge,
  layoutEditMode,
  onDetach,
  payload,
  liveOpsPayload,
  executionAiV6Payload,
  journalContext,
  formatClock,
}: {
  badge: ReactNode;
  layoutEditMode: boolean;
  onDetach: () => void;
  payload: ExecutionPnlAnalyzerPayload | null;
  liveOpsPayload?: Record<string, unknown> | null;
  executionAiV6Payload?: ExecutionAiV6PanelPayload | null;
  journalContext?: {
    symbol: string;
    timeframe: string;
    strategy: string;
  };
  formatClock: (value: string) => string;
}) {
  const journalSymbol = String(journalContext?.symbol || "").trim().toUpperCase();
  const journalTimeframe = String(journalContext?.timeframe || "").trim();
  const journalStrategy = String(journalContext?.strategy || "").trim();
  const journalEnabled = Boolean(journalSymbol && journalTimeframe && journalStrategy);
  const [journalEntries, setJournalEntries] = useState<OperatorJournalEntry[]>([]);
  const [journalBusy, setJournalBusy] = useState(false);
  const [journalError, setJournalError] = useState<string | null>(null);

  useEffect(() => {
    if (!journalEnabled) {
      setJournalEntries([]);
      setJournalBusy(false);
      setJournalError(null);
      return;
    }
    let cancelled = false;
    const loadJournal = async () => {
      setJournalBusy(true);
      const query = new URLSearchParams();
      query.set("symbol", journalSymbol);
      query.set("timeframe", journalTimeframe);
      query.set("strategy", journalStrategy);
      query.set("limit", "80");
      const response = await fetch(`/api/terminal/v2-risk-journal?${query.toString()}`, { cache: "no-store" }).catch(() => null);
      const responsePayload = response ? await response.json().catch(() => null) : null;
      if (cancelled) {
        return;
      }
      if (!response || !response.ok || !responsePayload || !Array.isArray(responsePayload.entries)) {
        setJournalError("Journal feedback indisponible");
        setJournalBusy(false);
        return;
      }
      setJournalEntries(responsePayload.entries.filter(isOperatorJournalEntry));
      setJournalError(null);
      setJournalBusy(false);
    };
    void loadJournal();
    const timer = window.setInterval(() => {
      void loadJournal();
    }, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [journalEnabled, journalStrategy, journalSymbol, journalTimeframe]);

  const envelope = safeRecord(payload);
  const summary = safeRecord(envelope.summary);
  const trades = safeRows(envelope.trades);
  const byRegime = safeRows(envelope.by_regime).slice(0, 3);
  const byVenue = safeRows(envelope.by_venue).slice(0, 3);
  const byExecutionMode = safeRows(envelope.by_execution_mode).slice(0, 3);
  const badModelFlags = safeRows(envelope.bad_model_flags).slice(0, 4);
  const dominanceReasons = aggregateDominanceReasons(trades);
  const truthState = deriveDeskTruthState({ summary, liveOpsPayload, executionAiV6Payload });
  const tradeCount = safeNumber(summary.trade_count, 0);
  const noTradeCount = safeNumber(summary.no_trade_dominance_count, 0);
  const noTradeRatioPct = tradeCount > 0 ? (noTradeCount / tradeCount) * 100 : 0;
  const feedbackSummary = useMemo(() => buildFeedbackSummary({
    executionPnlPayload: payload,
    liveOpsPayload,
    executionAiV6Payload,
    journalEntries,
  }), [executionAiV6Payload, journalEntries, liveOpsPayload, payload]);

  return (
    <MonitoringPanelCard title="Execution PnL Truth" badge={badge} layoutEditMode={layoutEditMode} onDetach={onDetach}>
      {!payload ? <p className="subtle mini">PnL truth indisponible.</p> : null}
      {payload ? (
        <>
          <div className="venue-telemetry-summary">
            <span className={`venue-telemetry-pill ${truthState.tone === "warn" ? "warn" : ""}`}>{truthState.label}</span>
            <span className="venue-telemetry-pill">trades {tradeCount.toFixed(0)}</span>
            <span className="venue-telemetry-pill">net {formatSignedCompactUsd(summary.net_pnl_usd)}</span>
            <span className="venue-telemetry-pill">flags {safeNumber(summary.high_confidence_loss_count, 0).toFixed(0)}</span>
          </div>
          <div className="subtle mini" style={{ marginBottom: 8 }}>{truthState.reason}</div>
          <div className="optimizer-live-section">
            <div className="venue-telemetry-summary">
              <span className={`venue-telemetry-pill ${feedbackSummary.modelHealth === "BROKEN" || feedbackSummary.modelHealth === "DEGRADING" ? "warn" : feedbackSummary.modelHealth === "ADAPTING" ? "subtle" : ""}`}>health {feedbackSummary.modelHealth}</span>
              <span className={`venue-telemetry-pill ${feedbackSummary.driftState === "LOCK" || feedbackSummary.driftState === "DRIFT" ? "warn" : feedbackSummary.driftState === "WATCH" ? "subtle" : ""}`}>drift {feedbackSummary.driftState}</span>
              <span className={`venue-telemetry-pill ${feedbackSummary.reward.scorePct < 45 ? "warn" : feedbackSummary.reward.scorePct < 65 ? "subtle" : ""}`}>reward {feedbackSummary.reward.scorePct.toFixed(0)}%</span>
              <span className={`venue-telemetry-pill ${feedbackSummary.shield.learningState === "FROZEN" ? "warn" : feedbackSummary.shield.learningState === "REDUCED" ? "subtle" : ""}`}>learning {feedbackSummary.shield.learningState}</span>
            </div>
            {journalBusy ? <div className="subtle mini">journal feedback sync...</div> : null}
            {journalError ? <div className="warn mini">{journalError}</div> : null}
            <div className="optimizer-live-grid">
              <div className={`venue-telemetry-item ${feedbackSummary.reward.scorePct >= 65 ? "good" : feedbackSummary.reward.scorePct >= 45 ? "subtle" : "warn"}`}>
                <div className="venue-telemetry-head">
                  <span className="venue-telemetry-venue">Reward pro</span>
                  <span className={`venue-telemetry-state ${feedbackSummary.reward.scorePct >= 65 ? "good" : feedbackSummary.reward.scorePct >= 45 ? "subtle" : "warn"}`}>{feedbackSummary.reward.scorePct.toFixed(0)}%</span>
                </div>
                <div className="mon-row"><span>PnL</span><span>{feedbackSummary.reward.normalizedPnl.toFixed(2)}</span></div>
                <div className="mon-row"><span>Fill</span><span>{feedbackSummary.reward.fillEfficiency.toFixed(2)}</span></div>
                <div className="mon-row"><span>Decision</span><span>{feedbackSummary.reward.decisionQuality.toFixed(2)}</span></div>
                <div className="mon-row"><span>Bias</span><span>{feedbackSummary.reward.regimeBiasLabel}</span></div>
              </div>
              <div className={`venue-telemetry-item ${feedbackSummary.shield.freezeLearning ? "warn" : feedbackSummary.shield.multiRegimeValidation === "REVIEW" ? "subtle" : "good"}`}>
                <div className="venue-telemetry-head">
                  <span className="venue-telemetry-venue">Anti-overfit shield</span>
                  <span className={`venue-telemetry-state ${feedbackSummary.shield.freezeLearning ? "warn" : feedbackSummary.shield.multiRegimeValidation === "REVIEW" ? "subtle" : "good"}`}>{feedbackSummary.shield.multiRegimeValidation}</span>
                </div>
                <div className="mon-row"><span>Reality ratio</span><span className={feedbackSummary.shield.rollingRealityRatio < 0.6 ? "warn" : "subtle"}>{feedbackSummary.shield.rollingRealityRatio.toFixed(2)}</span></div>
                <div className="mon-row"><span>Exploration</span><span>{feedbackSummary.shield.explorationMode}</span></div>
                <div className="mon-row"><span>Context</span><span>{feedbackSummary.shield.contextCompression}</span></div>
                <div className="optimizer-live-reasons">
                  {feedbackSummary.shield.reasons.length === 0 ? <span className="optimizer-live-chip subtle">shield nominal</span> : null}
                  {feedbackSummary.shield.reasons.slice(0, 3).map((reason) => <span key={reason} className="optimizer-live-chip warn">{reason}</span>)}
                </div>
              </div>
              <div className={`venue-telemetry-item ${feedbackSummary.calibrationActions.length === 0 ? "good" : "subtle"}`}>
                <div className="venue-telemetry-head">
                  <span className="venue-telemetry-venue">Auto calibration</span>
                  <span className="venue-telemetry-state subtle">max {feedbackSummary.maxAdjustmentPerDayPct.toFixed(0)}%</span>
                </div>
                <div className="mon-row"><span>Reduce size</span><span className={feedbackSummary.reduceSize ? "warn" : "good"}>{feedbackSummary.reduceSize ? "yes" : "no"}</span></div>
                <div className="mon-row"><span>Force no-trade</span><span className={feedbackSummary.forceNoTrade ? "warn" : "good"}>{feedbackSummary.forceNoTrade ? "yes" : "no"}</span></div>
                <div className="mon-row"><span>Learning</span><span className={feedbackSummary.learningDisabled ? "warn" : "subtle"}>{feedbackSummary.learningDisabled ? "disabled" : "guarded"}</span></div>
                <div className="optimizer-live-reasons">
                  {feedbackSummary.calibrationActions.length === 0 ? <span className="optimizer-live-chip subtle">no threshold change</span> : null}
                  {feedbackSummary.calibrationActions.map((action) => (
                    <span key={`${action.target}-${action.direction}`} className="optimizer-live-chip subtle">{action.target} {action.direction === "increase" ? "+" : "-"}{action.magnitudePct.toFixed(1)}%</span>
                  ))}
                </div>
              </div>
            </div>
          </div>
          <div className="optimizer-live-grid">
            <div className={`venue-telemetry-item ${safeNumber(summary.net_pnl_usd, 0) >= 0 ? "good" : "warn"}`}>
              <div className="venue-telemetry-head">
                <span className="venue-telemetry-venue">Truth line</span>
                <span className={`venue-telemetry-state ${truthState.tone}`}>{truthState.label}</span>
              </div>
              <div className="mon-row"><span>Expectancy</span><span className={safeNumber(summary.avg_pnl_usd, 0) >= 0 ? "good" : "warn"}>{formatSignedCompactUsd(summary.avg_pnl_usd)}</span></div>
              <div className="mon-row"><span>Win rate</span><span>{safeNumber(summary.win_rate_pct, 0).toFixed(1)}%</span></div>
              <div className="mon-row"><span>Fees</span><span>{formatCompactUsd(summary.fees_usd)}</span></div>
            </div>
            <div className={`venue-telemetry-item ${safeNumber(summary.high_confidence_loss_count, 0) > 0 ? "warn" : "subtle"}`}>
              <div className="venue-telemetry-head">
                <span className="venue-telemetry-venue">Execution friction</span>
                <span className={`venue-telemetry-state ${safeNumber(summary.high_confidence_loss_count, 0) > 0 ? "warn" : "subtle"}`}>{safeNumber(summary.high_confidence_loss_count, 0).toFixed(0)} flag(s)</span>
              </div>
              <div className="mon-row"><span>Latency</span><span className={safeNumber(summary.avg_latency_ms, 0) > 120 ? "warn" : "subtle"}>{formatCompactMetricMs(summary.avg_latency_ms)}</span></div>
              <div className="mon-row"><span>Slippage</span><span className={safeNumber(summary.avg_slippage_bps, 0) > 3 ? "warn" : "subtle"}>{safeNumber(summary.avg_slippage_bps, 0).toFixed(2)}bps</span></div>
              <div className="mon-row"><span>Bad-model losses</span><span>{safeNumber(summary.high_confidence_loss_count, 0).toFixed(0)}</span></div>
            </div>
            <div className={`venue-telemetry-item ${noTradeRatioPct >= 25 ? "good" : noTradeRatioPct >= 10 ? "subtle" : "warn"}`}>
              <div className="venue-telemetry-head">
                <span className="venue-telemetry-venue">No-trade dominance</span>
                <span className={`venue-telemetry-state ${noTradeRatioPct >= 25 ? "good" : noTradeRatioPct >= 10 ? "subtle" : "warn"}`}>{noTradeRatioPct.toFixed(0)}%</span>
              </div>
              <div className="mon-row"><span>Dominance trades</span><span>{noTradeCount.toFixed(0)} / {tradeCount.toFixed(0)}</span></div>
              <div className="optimizer-live-reasons">
                {dominanceReasons.length === 0 ? <span className="optimizer-live-chip subtle">no dominant reason yet</span> : null}
                {dominanceReasons.map((reason) => <span key={reason.label} className="optimizer-live-chip warn">{reason.label} x{reason.count}</span>)}
              </div>
            </div>
          </div>
          <div className="optimizer-live-section">
            <div className="subtle mini">Feedback windows</div>
            {feedbackSummary.windows.map((window) => (
              <div key={window.key} className="mon-row">
                <span>{window.label}</span>
                <span className="subtle mini">{window.sampleSize.toFixed(0)} sample(s)</span>
                <span className={window.scorePct >= 65 ? "good" : window.scorePct >= 45 ? "subtle" : "warn"}>{window.scorePct.toFixed(0)}%</span>
              </div>
            ))}
            <div className="optimizer-live-reasons">
              {feedbackSummary.windows.map((window) => <span key={`${window.key}-summary`} className="optimizer-live-chip subtle">{window.summary}</span>)}
            </div>
          </div>
          <div className="optimizer-live-section">
            <div className="subtle mini">Feedback errors</div>
            {feedbackSummary.errors.map((error) => (
              <div key={error.kind} className="mon-row">
                <span>{error.label}</span>
                <span className="subtle mini">{error.detail}</span>
                <span className={error.severity === "high" ? "warn" : error.severity === "medium" ? "subtle" : "good"}>{(error.score * 100).toFixed(0)}%</span>
              </div>
            ))}
            <div className="optimizer-live-reasons">
              {feedbackSummary.tradeCount === 0 ? <span className="optimizer-live-chip subtle">waiting for live samples</span> : null}
              {Object.entries(feedbackSummary.tradeQualityCounts).map(([label, count]) => (
                <span key={label} className={`optimizer-live-chip ${label === feedbackSummary.dominantTradeQuality ? "warn" : "subtle"}`}>{label.toLowerCase()} x{count}</span>
              ))}
            </div>
          </div>
          <div className="optimizer-live-section">
            <div className="subtle mini">Best/worst buckets</div>
            {byRegime.map((row) => (
              <div key={`pnl-regime-${String(row.regime || "unknown")}`} className="mon-row">
                <span>{String(row.regime || "UNKNOWN")}</span>
                <span className="subtle mini">{safeNumber(row.trade_count, 0).toFixed(0)} trades · {safeNumber(row.win_rate_pct, 0).toFixed(1)}%</span>
                <span className={safeNumber(row.net_pnl_usd, 0) >= 0 ? "good" : "warn"}>{formatSignedCompactUsd(row.net_pnl_usd)}</span>
              </div>
            ))}
            {byVenue.map((row) => (
              <div key={`pnl-venue-${String(row.venue || "unknown")}`} className="mon-row">
                <span>{String(row.venue || "unknown")}</span>
                <span className="subtle mini">{safeNumber(row.avg_latency_ms, 0).toFixed(0)}ms · {safeNumber(row.avg_slippage_bps, 0).toFixed(2)}bps</span>
                <span className={safeNumber(row.net_pnl_usd, 0) >= 0 ? "good" : "warn"}>{formatSignedCompactUsd(row.net_pnl_usd)}</span>
              </div>
            ))}
            {byExecutionMode.map((row) => (
              <div key={`pnl-mode-${String(row.execution_mode || "unknown")}`} className="mon-row">
                <span>{String(row.execution_mode || "unknown")}</span>
                <span className="subtle mini">flags {safeNumber(row.high_confidence_losses, 0).toFixed(0)}</span>
                <span className={safeNumber(row.net_pnl_usd, 0) >= 0 ? "good" : "warn"}>{formatSignedCompactUsd(row.net_pnl_usd)}</span>
              </div>
            ))}
          </div>
          <div className="optimizer-live-section">
            <div className="subtle mini">Bad-model flags</div>
            {badModelFlags.length === 0 ? <p className="subtle mini">Aucune perte haute confiance.</p> : null}
            {badModelFlags.map((row, index) => (
              <div key={`pnl-flag-${index}`} className="mon-row">
                <span>{String(row.decision_id || "decision")}</span>
                <span className="subtle mini">{String(row.regime || "UNKNOWN")} · {String(row.venue || "unknown")}</span>
                <span className="warn">{formatSignedCompactUsd(row.net_result_usd)}</span>
              </div>
            ))}
            {trades.length > 0 ? <div className="subtle mini" style={{ marginTop: 4 }}>Dernier trade: {formatCompactClock(trades[0]?.created_at, formatClock)}</div> : null}
          </div>
          <div className="optimizer-live-section">
            <div className="subtle mini">Recommendations</div>
            <div className="optimizer-live-reasons">
              {feedbackSummary.protections.length === 0 ? <span className="optimizer-live-chip subtle">no hard protection</span> : null}
              {feedbackSummary.protections.map((protection) => <span key={protection} className="optimizer-live-chip warn">{protection}</span>)}
            </div>
            <div className="optimizer-live-reasons" style={{ marginTop: 6 }}>
              {feedbackSummary.recommendations.map((recommendation) => <span key={recommendation} className="optimizer-live-chip subtle">{recommendation}</span>)}
            </div>
          </div>
        </>
      ) : null}
    </MonitoringPanelCard>
  );
}

export function ExecutionAiV6ObservabilityPanel({
  badge,
  layoutEditMode,
  onDetach,
  payload,
  formatClock,
}: {
  badge: ReactNode;
  layoutEditMode: boolean;
  onDetach: () => void;
  payload: ExecutionAiV6PanelPayload | null;
  formatClock: (value: string) => string;
}) {
  const envelope = safeRecord(payload);
  const snapshot = safeRecord(envelope.snapshot);
  const guardrails = safeRecord(snapshot.guardrails);
  const topActions = safeRows(snapshot.top_actions).slice(0, 5);
  const recentEpisodes = safeRows(snapshot.recent_episodes).slice(0, 6);
  const freezeReasons = Array.isArray(guardrails.freeze_reasons)
    ? guardrails.freeze_reasons.map((item) => String(item)).filter(Boolean).slice(0, 4)
    : [];
  const persistenceAvailable = typeof guardrails.persistence_available === "boolean"
    ? Boolean(guardrails.persistence_available)
    : true;

  return (
    <MonitoringPanelCard title="Execution AI V6.1" badge={badge} layoutEditMode={layoutEditMode} onDetach={onDetach}>
      {!payload ? <p className="subtle mini">Observabilite V6 indisponible.</p> : null}
      {payload ? (
        <>
          <div className="venue-telemetry-summary">
            <span className={`venue-telemetry-pill ${persistenceAvailable ? "" : "warn"}`}>{persistenceAvailable ? "db online" : "db degraded"}</span>
            <span className="venue-telemetry-pill">ctx {safeNumber(snapshot.context_count, 0).toFixed(0)}</span>
            <span className="venue-telemetry-pill">ema {safeNumber(guardrails.reward_ema, 0).toFixed(2)}</span>
            <span className="venue-telemetry-pill">dd {safeNumber(guardrails.reward_drawdown, 0).toFixed(2)}</span>
          </div>
          <div className="optimizer-live-grid">
            <div className={`venue-telemetry-item ${persistenceAvailable ? "subtle" : "warn"}`}>
              <div className="venue-telemetry-head">
                <span className="venue-telemetry-venue">Persistence</span>
                <span className={`venue-telemetry-state ${persistenceAvailable ? "subtle" : "warn"}`}>{persistenceAvailable ? "online" : "degraded"}</span>
              </div>
              <div className="mon-row"><span>Loaded</span><span>{Boolean(guardrails.loaded) ? formatCompactClock(guardrails.loaded_at, formatClock) : "cold"}</span></div>
              <div className="mon-row"><span>Vol / streak</span><span>{safeNumber(guardrails.reward_volatility, 0).toFixed(2)} · {safeNumber(guardrails.negative_streak, 0).toFixed(0)} neg</span></div>
              {!persistenceAvailable && String(guardrails.last_persist_error || "") ? <div className="warn mini gtix-ellipsis">{String(guardrails.last_persist_error || "")}</div> : null}
            </div>
            <div className={`venue-telemetry-item ${Boolean(guardrails.learning_frozen) ? "warn" : "good"}`}>
              <div className="venue-telemetry-head">
                <span className="venue-telemetry-venue">Guardrails</span>
                <span className={`venue-telemetry-state ${Boolean(guardrails.learning_frozen) ? "warn" : "good"}`}>{Boolean(guardrails.learning_frozen) ? "frozen" : "active"}</span>
              </div>
              <div className="mon-row"><span>EMA / drawdown</span><span>{safeNumber(guardrails.reward_ema, 0).toFixed(2)} · {safeNumber(guardrails.reward_drawdown, 0).toFixed(2)}</span></div>
              <div className="optimizer-live-reasons">
                {freezeReasons.length === 0 ? <span className="optimizer-live-chip good">no freeze</span> : null}
                {freezeReasons.map((reason) => <span key={reason} className="optimizer-live-chip warn">{reason}</span>)}
              </div>
            </div>
          </div>
          <div className="optimizer-live-section">
            <div className="subtle mini">Top actions</div>
            {topActions.length === 0 ? <p className="subtle mini">Aucune action apprise.</p> : null}
            {topActions.map((row) => (
              <div key={`v6-action-${String(row.action || "hold")}`} className="mon-row">
                <span>{String(row.action || "hold")}</span>
                <span className="subtle mini">reward {safeNumber(row.avg_reward, 0).toFixed(2)} · win {(safeNumber(row.win_rate, 0) * 100).toFixed(0)}%</span>
                <span>{safeNumber(row.sample_count, 0).toFixed(0)} ep</span>
              </div>
            ))}
          </div>
          <div className="optimizer-live-section">
            <div className="subtle mini">Recent episodes</div>
            {recentEpisodes.length === 0 ? <p className="subtle mini">Aucun episode recent.</p> : null}
            {recentEpisodes.map((row, index) => (
              <div key={`v6-episode-row-${index}`} className="mon-row">
                <span>{String(row.timestamp || "") ? formatCompactClock(row.timestamp, formatClock) : "--:--:--"}</span>
                <span className="subtle mini">{String(row.action || "hold")}</span>
                <span className={safeNumber(row.reward, 0) >= 0 ? "good" : "warn"}>{safeNumber(row.reward, 0).toFixed(2)}</span>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </MonitoringPanelCard>
  );
}

export function ExecutionContextMonitoringPanel({
  badge,
  layoutEditMode,
  onDetach,
  routingPayload,
  optimizerPayload,
  smartDecision,
  formatClock,
}: {
  badge: ReactNode;
  layoutEditMode: boolean;
  onDetach: () => void;
  routingPayload: Record<string, unknown> | null;
  optimizerPayload: ExecutionOptimizerLivePayload | null;
  smartDecision?: SmartDecisionHudShape | null;
  formatClock: (value: string) => string;
}) {
  const routingEnvelope = safeRecord(routingPayload);
  const optimizerEnvelope = safeRecord(optimizerPayload);
  const marketStructure = safeRecord(routingEnvelope.market_structure);
  const executionContext = safeRecord(routingEnvelope.execution_context);
  const policy = safeRecord(executionContext.policy);
  const thresholds = safeRecord(policy.thresholds);
  const bias = safeRecord(marketStructure.bias);
  const volatility = safeRecord(marketStructure.volatility);
  const zone = safeRecord(marketStructure.zone);
  const volumeProfile = safeRecord(marketStructure.volume_profile);
  const activeOrders = safeRows(optimizerEnvelope.active_orders).slice(0, 3);
  const noTradeReasons = Array.isArray(executionContext.no_trade_reasons)
    ? executionContext.no_trade_reasons.map((item) => String(item)).filter(Boolean).slice(0, 4)
    : [];
  const freezeReasons = Array.isArray(executionContext.freeze_learning_reasons)
    ? executionContext.freeze_learning_reasons.map((item) => String(item)).filter(Boolean).slice(0, 4)
    : [];
  const hvnZones = Array.isArray(volumeProfile.hvn_zones) ? volumeProfile.hvn_zones.slice(0, 3).map((item) => safeNumber(item, 0).toFixed(2)) : [];
  const lvnZones = Array.isArray(volumeProfile.lvn_zones) ? volumeProfile.lvn_zones.slice(0, 3).map((item) => safeNumber(item, 0).toFixed(2)) : [];
  const fallbackMode = String(executionContext.fallback_mode || policy.fallback_mode || "normal");
  const freezeLearning = Boolean(executionContext.freeze_learning || policy.freeze_learning);
  const noTrade = Boolean(executionContext.no_trade || policy.no_trade);
  const confidence = safeNumber(executionContext.confidence, 0);
  const targetNotionalUsd = safeNumber(executionContext.target_notional_usd, 0);
  const sizeMultiplier = safeNumber(executionContext.size_multiplier, 0);
  const entryBoost = safeNumber(executionContext.entry_boost_adjustment, 0);
  const titleBadge = (
    <>
      {badge}
      <span className={`venue-telemetry-proxy-badge ${noTrade ? "degraded" : freezeLearning ? "retry_recovered" : "healthy"}`}>
        {noTrade ? "no-trade" : freezeLearning ? "frozen" : fallbackMode.replace(/_/g, " ")}
      </span>
    </>
  );

  return (
    <MonitoringPanelCard title="Execution Context" badge={titleBadge} layoutEditMode={layoutEditMode} onDetach={onDetach}>
      {!routingPayload ? <p className="subtle mini">Contexte d'execution indisponible.</p> : null}
      {routingPayload ? (
        <>
          <div className="venue-telemetry-summary">
            <span className="venue-telemetry-pill">bias {String(executionContext.bias || bias.state || "neutral")}</span>
            <span className="venue-telemetry-pill">vol {String(executionContext.volatility_regime || volatility.regime || "normal")}</span>
            <span className="venue-telemetry-pill">zone {String(executionContext.zone || zone.state || "none")}</span>
            <span className="venue-telemetry-pill">conf {(confidence * 100).toFixed(0)}%</span>
            {smartDecision ? <span className={`venue-telemetry-pill ${smartDecision.tone}`}>smart {smartDecision.displayStateLabel}</span> : null}
          </div>
          <div className="optimizer-live-grid">
            <div className={`venue-telemetry-item ${noTrade ? "warn" : confidence >= 0.6 ? "good" : "subtle"}`}>
              <div className="venue-telemetry-head">
                <span className="venue-telemetry-venue">Desk policy</span>
                <span className={`venue-telemetry-state ${noTrade ? "warn" : confidence >= 0.6 ? "good" : "subtle"}`}>{fallbackMode.replace(/_/g, " ")}</span>
              </div>
              <div className="mon-row"><span>Trade gate</span><span className={noTrade ? "warn" : "good"}>{noTrade ? "NO_TRADE" : "eligible"}</span></div>
              {smartDecision ? <div className="mon-row"><span>Smart state</span><span className={smartDecision.tone}>{smartDecision.displayStateLabel} · {smartDecision.confidenceBand}</span></div> : null}
              {smartDecision ? <div className="mon-row"><span>Stability</span><span className={smartDecision.stability.isStable ? "good" : "warn"}>{smartDecision.stability.statusLabel}</span></div> : null}
              <div className="mon-row"><span>Learning</span><span className={freezeLearning ? "warn" : "good"}>{freezeLearning ? "frozen" : String(policy.learning_mode || executionContext.learning_mode || "online")}</span></div>
              <div className="mon-row"><span>Daily loss</span><span>{safeNumber(policy.daily_loss_pct, 0).toFixed(2)}% / {safeNumber(thresholds.daily_loss_limit_pct, 0).toFixed(2)}%</span></div>
              <div className="optimizer-live-reasons">
                {noTradeReasons.length === 0 ? <span className="optimizer-live-chip good">trade allowed</span> : null}
                {noTradeReasons.map((reason) => <span key={reason} className="optimizer-live-chip warn">{reason}</span>)}
              </div>
              {smartDecision ? <div className="subtle mini gtix-ellipsis" style={{ marginTop: 6 }}>{smartDecision.headline} · {smartDecision.reason}</div> : null}
            </div>
            <div className={`venue-telemetry-item ${sizeMultiplier >= 1 ? "good" : "subtle"}`}>
              <div className="venue-telemetry-head">
                <span className="venue-telemetry-venue">Sizing & boost</span>
                <span className={`venue-telemetry-state ${sizeMultiplier >= 1 ? "good" : "subtle"}`}>x{sizeMultiplier.toFixed(2)}</span>
              </div>
              <div className="mon-row"><span>Target notional</span><span>{formatCompactUsd(targetNotionalUsd)}</span></div>
              <div className="mon-row"><span>Vol sizing</span><span>x{safeNumber(policy.volatility_sizing_multiplier, sizeMultiplier).toFixed(2)} · {String(executionContext.volatility_regime || volatility.regime || "normal")}</span></div>
              <div className="mon-row"><span>Entry boost</span><span>+{entryBoost.toFixed(2)} · aggr x{safeNumber(executionContext.aggressiveness_multiplier, 1).toFixed(2)}</span></div>
              <div className="optimizer-live-reasons">
                {Array.isArray(executionContext.reasons) && executionContext.reasons.length === 0 ? <span className="optimizer-live-chip subtle">no context reasons</span> : null}
                {Array.isArray(executionContext.reasons) ? executionContext.reasons.map((reason) => <span key={String(reason)} className="optimizer-live-chip good">{String(reason)}</span>) : null}
              </div>
            </div>
            <div className="venue-telemetry-item subtle">
              <div className="venue-telemetry-head">
                <span className="venue-telemetry-venue">Market structure</span>
                <span className="venue-telemetry-state subtle">{String(bias.state || executionContext.bias || "neutral")}</span>
              </div>
              <div className="mon-row"><span>Reference / POC</span><span>{safeNumber(marketStructure.reference_price, 0).toFixed(2)} · {safeNumber(volumeProfile.poc, 0).toFixed(2)}</span></div>
              <div className="mon-row"><span>Value area</span><span>{safeNumber(volumeProfile.value_area_low, 0).toFixed(2)} → {safeNumber(volumeProfile.value_area_high, 0).toFixed(2)}</span></div>
              <div className="mon-row"><span>Zone / source</span><span>{String(zone.state || executionContext.zone || "none")} · {String(volumeProfile.source || zone.source || "derived")}</span></div>
              <div className="optimizer-live-reasons">
                {hvnZones.length === 0 ? <span className="optimizer-live-chip subtle">no HVN</span> : null}
                {hvnZones.map((price) => <span key={`hvn-${price}`} className="optimizer-live-chip good">HVN {price}</span>)}
                {lvnZones.map((price) => <span key={`lvn-${price}`} className="optimizer-live-chip warn">LVN {price}</span>)}
              </div>
            </div>
            <div className={`venue-telemetry-item ${freezeLearning ? "warn" : "subtle"}`}>
              <div className="venue-telemetry-head">
                <span className="venue-telemetry-venue">Policy thresholds</span>
                <span className={`venue-telemetry-state ${freezeLearning ? "warn" : "subtle"}`}>{freezeLearning ? "freeze" : "watch"}</span>
              </div>
              {smartDecision ? <div className="mon-row"><span>Decision gate</span><span className={smartDecision.qualityGate === "pass" ? "good" : smartDecision.qualityGate === "warn" ? "subtle" : "warn"}>{smartDecision.qualityGateLabel}</span></div> : null}
              {smartDecision ? <div className="mon-row"><span>Latency / invalid</span><span>{smartDecision.latencyLabel} · {smartDecision.invalidationLabel}</span></div> : null}
              <div className="mon-row"><span>Confidence floor</span><span>{(safeNumber(thresholds.confidence_floor, 0) * 100).toFixed(0)}%</span></div>
              <div className="mon-row"><span>Latency / fill floor</span><span>{safeNumber(thresholds.latency_ceiling_ms, 0).toFixed(0)}ms · {(safeNumber(thresholds.fill_probability_floor, 0) * 100).toFixed(0)}%</span></div>
              <div className="mon-row"><span>High vol spread</span><span>{safeNumber(thresholds.high_vol_spread_bps, 0).toFixed(1)}bps · stale {formatCompactMetricMs(thresholds.stale_market_ms)}</span></div>
              <div className="optimizer-live-reasons">
                {freezeReasons.length === 0 ? <span className="optimizer-live-chip good">learning online</span> : null}
                {freezeReasons.map((reason) => <span key={reason} className="optimizer-live-chip warn">{reason}</span>)}
              </div>
            </div>
          </div>
          <div className="optimizer-live-section">
            <div className="subtle mini">Active order context</div>
            {activeOrders.length === 0 ? <p className="subtle mini">Aucun ordre live avec contexte actif.</p> : null}
            {activeOrders.map((order, index) => {
              const orderContext = safeRecord(order.execution_context);
              const orderStructure = safeRecord(order.market_structure);
              const orderPolicy = safeRecord(orderContext.policy);
              return (
                <div key={`ctx-order-${index}-${String(order.order_id || order.decision_id || "row")}`} className="mon-row">
                  <span>{String(order.symbol || "?")} · {String(order.market_venue || "venue")}</span>
                  <span className="subtle mini">{String(orderContext.bias || safeRecord(orderStructure.bias).state || "neutral")} / {String(orderContext.zone || safeRecord(orderStructure.zone).state || "none")}</span>
                  <span className={Boolean(orderContext.no_trade || orderPolicy.no_trade) ? "warn" : Boolean(orderContext.freeze_learning || orderPolicy.freeze_learning) ? "subtle" : "good"}>
                    {Boolean(orderContext.no_trade || orderPolicy.no_trade)
                      ? "NO_TRADE"
                      : Boolean(orderContext.freeze_learning || orderPolicy.freeze_learning)
                        ? "freeze"
                        : `${safeNumber(orderContext.target_notional_usd, 0).toFixed(0)} USD`}
                  </span>
                </div>
              );
            })}
          </div>
        </>
      ) : null}
    </MonitoringPanelCard>
  );
}

export function VenueTelemetryMonitoringPanel({
  badge,
  layoutEditMode,
  onDetach,
  marketPayload,
  routePayload,
  formatClock,
}: {
  badge: ReactNode;
  layoutEditMode: boolean;
  onDetach: () => void;
  marketPayload: VenueTelemetryPayload | null;
  routePayload: VenueTelemetryPayload | null;
  formatClock: (value: string) => string;
}) {
  const marketEnvelope = safeRecord(marketPayload);
  const routeEnvelope = safeRecord(routePayload);
  const rows = buildVenueTelemetryRows(marketPayload, routePayload);
  const updatedAt = String(routeEnvelope.updated_at || marketEnvelope.updated_at || "").trim();
  const marketProxyState = String(marketEnvelope.network_state || "healthy").trim().toLowerCase();
  const routeProxyState = String(routeEnvelope.network_state || "healthy").trim().toLowerCase();
  const proxyState = marketProxyState === "degraded" || routeProxyState === "degraded"
    ? "degraded"
    : marketProxyState === "retry_recovered" || routeProxyState === "retry_recovered"
      ? "retry_recovered"
      : "healthy";
  const titleBadge = (
    <>
      {badge}
      <span className={`venue-telemetry-proxy-badge ${proxyState}`}>{proxyState.replace(/_/g, " ")}</span>
    </>
  );

  return (
    <MonitoringPanelCard title="Venue Telemetry" badge={titleBadge} layoutEditMode={layoutEditMode} onDetach={onDetach}>
      {!marketPayload && !routePayload ? <p className="subtle mini">Télémétrie venue indisponible.</p> : null}
      {(marketPayload || routePayload) ? (
        <>
          <div className="venue-telemetry-summary">
            <span className="venue-telemetry-pill">proxy {proxyState}</span>
            <span className="venue-telemetry-pill">venues {rows.length}</span>
            <span className="venue-telemetry-pill">updated {updatedAt ? formatCompactClock(updatedAt, formatClock) : "--:--:--"}</span>
          </div>
          {rows.length === 0 ? <p className="subtle mini">Aucune venue observée.</p> : null}
          <div className="venue-telemetry-list">
            {rows.slice(0, 8).map((row) => {
              const market = safeRecord(row.market);
              const execution = safeRecord(row.execution);
              const stability = safeRecord(row.stability);
              const profile = safeRecord(row.profile);
              const instruments = safeRows(row.instruments);
              const tone = String(row.tone || "subtle");
              const feedLine = `q ${formatCompactMetricMs(market.max_quote_freshness_ms)} · d ${formatCompactMetricMs(market.max_depth_freshness_ms)} · t ${formatCompactMetricMs(market.max_trade_freshness_ms)}`;
              const marketLine = `${safeNumber(market.avg_spread_bps, 0).toFixed(2)}bp · depth ${safeNumber(market.avg_depth_levels, 0).toFixed(0)} · dlat ${formatCompactMetricMs(market.avg_depth_latency_ms)}`;
              const executionLine = Object.keys(execution).length > 0
                ? `${safeNumber(execution.fill_count, 0)} fills · ${safeNumber(execution.avg_slippage_bps, 0).toFixed(2)}bp · qual ${safeNumber(execution.avg_fill_quality_score, 0).toFixed(0)}`
                : "no fills in window";
              const instrumentLine = instruments.length > 0
                ? instruments.slice(0, 2).map((item) => `${String(item.instrument || "?")} ${safeNumber(item.spread_bps, 0).toFixed(2)}bp`).join(" · ")
                : "no market instruments";
              return (
                <div key={String(row.venue || "venue")} className={`venue-telemetry-item ${tone}`}>
                  <div className="venue-telemetry-head">
                    <span className="venue-telemetry-venue">{String(row.venue || "venue")}</span>
                    <span className={`venue-telemetry-state ${tone}`}>{String(stability.state || stability.stability_state || tone)}</span>
                  </div>
                  <div className="venue-telemetry-meta">
                    <span>Feed</span>
                    <strong>{feedLine}</strong>
                    <span>Market</span>
                    <strong>{marketLine}</strong>
                    <span>Exec</span>
                    <strong>{executionLine}</strong>
                    <span>Profile</span>
                    <strong>{String(profile.matching_rule || "price-time")} · q {safeNumber(profile.queue_priority_bias, 0).toFixed(2)}</strong>
                  </div>
                  <div className="venue-telemetry-instruments">{instrumentLine}</div>
                </div>
              );
            })}
          </div>
        </>
      ) : null}
    </MonitoringPanelCard>
  );
}

export function ExecutionSmartTrackerPanel({
  badge,
  layoutEditMode,
  onDetach,
  telemetry,
  outcomes,
  preview,
  symbol,
  formatClock,
}: {
  badge: ReactNode;
  layoutEditMode: boolean;
  onDetach: () => void;
  telemetry: Array<Record<string, unknown>>;
  outcomes: Array<Record<string, unknown>>;
  preview: Record<string, unknown> | null;
  symbol: string;
  formatClock: (value: string) => string;
}) {
  const symbolKey = String(symbol || "").trim().toUpperCase();
  const rows = [...safeRows(telemetry), ...safeRows(outcomes)]
    .filter((row) => {
      if (!symbolKey) {
        return true;
      }
      const rowSymbol = String(row.symbol || row.instrument || "").trim().toUpperCase();
      return !rowSymbol || rowSymbol === symbolKey;
    })
    .slice(0, 48);
  const live = safeRecord(preview);
  const gateAllow = Boolean(live.allow);
  const gateReasons = safeTextArray(live.reasons).slice(0, 4);
  const liveDelayMs = safeNumber(live.delay_ms, safeNumber(live.recommended_delay_ms, 0));
  const liveSizeMultiplier = safeNumber(live.size_multiplier, 1);
  const liveVenueScore = safeNumber(live.venue_score, 0);
  const liveExecutionScore = safeNumber(live.execution_score, 0);
  const liveContextScore = safeNumber(live.context_score, 0);
  const liveVenue = String(live.venue || "").trim() || "auto";

  const metrics = rows.map((row) => {
    const status = String(row.status || row.execution_status || row.order_status || "").toLowerCase();
    const latencyMs = Math.max(0, safeNumber(row.latency_e2e_ms, safeNumber(row.latency_ms, 0)));
    const slippageBps = Math.abs(safeNumber(row.realized_slippage_bps, safeNumber(row.slippage_real_bps, safeNumber(row.slippage_bps, 0))));
    const fillRatio = Math.max(0, Math.min(1, safeNumber(row.fill_ratio, safeNumber(row.executed_ratio, /fill|done|complete|closed/.test(status) ? 1 : /partial/.test(status) ? 0.5 : 0))));
    const executionScore = Math.max(0, Math.min(1, safeNumber(row.execution_score, safeNumber(row.execution_v7_smart_execution_score, 0))));
    const sizeMultiplier = Math.max(0, Math.min(1, safeNumber(row.execution_v7_smart_size_multiplier, safeNumber(row.size_multiplier, 1))));
    const delayMs = Math.max(0, safeNumber(row.execution_v7_smart_gate_delay_ms, safeNumber(row.delay_ms, 0)));
    const venueScore = Math.max(0, Math.min(1, safeNumber(row.execution_v7_smart_venue_score, safeNumber(row.venue_score, 0))));
    const pnlUsd = safeNumber(row.pnl_usd, safeNumber(row.net_result_usd, safeNumber(row.realized_pnl_usd, 0)));
    const blocked = /reject|block|cancel|error|fail|blocked/.test(status) || status === "failed";
    const reduced = sizeMultiplier > 0 && sizeMultiplier < 0.999;
    const delayed = delayMs > 0;
    const posture = blocked ? "blocked" : reduced ? "reduced" : delayed ? "delayed" : "clean";
    return {
      raw: row,
      status,
      latencyMs,
      slippageBps,
      fillRatio,
      executionScore,
      sizeMultiplier,
      delayMs,
      venueScore,
      pnlUsd,
      blocked,
      reduced,
      delayed,
      posture,
      timestamp: String(row.ts || row.created_at || row.timestamp || row.closed_at || ""),
    };
  });

  const avgExecutionScore = metrics.length > 0 ? metrics.reduce((sum, item) => sum + item.executionScore, 0) / metrics.length : 0;
  const avgLatencyMs = metrics.length > 0 ? metrics.reduce((sum, item) => sum + item.latencyMs, 0) / metrics.length : 0;
  const avgSlippageBps = metrics.length > 0 ? metrics.reduce((sum, item) => sum + item.slippageBps, 0) / metrics.length : 0;
  const avgFillRatio = metrics.length > 0 ? metrics.reduce((sum, item) => sum + item.fillRatio, 0) / metrics.length : 0;
  const blockedCount = metrics.filter((item) => item.blocked).length;
  const reducedCount = metrics.filter((item) => item.reduced).length;
  const delayedCount = metrics.filter((item) => item.delayed).length;
  const positivePnlCount = metrics.filter((item) => item.pnlUsd > 0).length;
  const liveTone = !preview
    ? "subtle"
    : gateAllow
      ? liveExecutionScore >= 0.72 ? "good" : "subtle"
      : "warn";
  const titleBadge = (
    <>
      {badge}
      <span className={`venue-telemetry-proxy-badge ${liveTone === "good" ? "healthy" : liveTone === "warn" ? "degraded" : "retry_recovered"}`}>
        {preview ? (gateAllow ? "allow" : "block") : "watch"}
      </span>
    </>
  );

  const postureRows = ["clean", "reduced", "delayed", "blocked"].map((posture) => {
    const postureItems = metrics.filter((item) => item.posture === posture);
    const pnlUsd = postureItems.reduce((sum, item) => sum + item.pnlUsd, 0);
    const avgScore = postureItems.length > 0 ? postureItems.reduce((sum, item) => sum + item.executionScore, 0) / postureItems.length : 0;
    return {
      posture,
      count: postureItems.length,
      pnlUsd,
      avgScore,
    };
  });

  return (
    <MonitoringPanelCard title="Execution Smart Tracker" badge={titleBadge} layoutEditMode={layoutEditMode} onDetach={onDetach}>
      <div className="venue-telemetry-summary">
        <span className="venue-telemetry-pill">samples {metrics.length}</span>
        <span className="venue-telemetry-pill">score {(avgExecutionScore * 100).toFixed(0)}%</span>
        <span className="venue-telemetry-pill">blocked {blockedCount}</span>
        <span className="venue-telemetry-pill">reduced {reducedCount}</span>
        <span className="venue-telemetry-pill">delayed {delayedCount}</span>
      </div>
      <div className="optimizer-live-grid">
        <div className={`venue-telemetry-item ${liveTone}`}>
          <div className="venue-telemetry-head">
            <span className="venue-telemetry-venue">Live gate</span>
            <span className={`venue-telemetry-state ${liveTone}`}>{preview ? (gateAllow ? "ALLOW" : "BLOCK") : "watch"}</span>
          </div>
          <div className="mon-row"><span>Venue</span><span>{liveVenue}</span></div>
          <div className="mon-row"><span>Delay</span><span>{liveDelayMs.toFixed(0)}ms</span></div>
          <div className="mon-row"><span>Size multiplier</span><span>x{liveSizeMultiplier.toFixed(2)}</span></div>
          <div className="mon-row"><span>Venue / exec</span><span>{(liveVenueScore * 100).toFixed(0)}% · {(liveExecutionScore * 100).toFixed(0)}%</span></div>
          <div className="mon-row"><span>Context score</span><span>{(liveContextScore * 100).toFixed(0)}%</span></div>
          <div className="optimizer-live-reasons">
            {gateReasons.length === 0 ? <span className="optimizer-live-chip good">gate clean</span> : null}
            {gateReasons.map((reason) => <span key={reason} className="optimizer-live-chip warn">{reason}</span>)}
          </div>
        </div>
        <div className={`venue-telemetry-item ${blockedCount > 0 ? "warn" : avgExecutionScore >= 0.72 ? "good" : "subtle"}`}>
          <div className="venue-telemetry-head">
            <span className="venue-telemetry-venue">Window frictions</span>
            <span className={`venue-telemetry-state ${blockedCount > 0 ? "warn" : avgExecutionScore >= 0.72 ? "good" : "subtle"}`}>{metrics.length} obs</span>
          </div>
          <div className="mon-row"><span>Latency</span><span>{avgLatencyMs.toFixed(0)}ms</span></div>
          <div className="mon-row"><span>Slippage</span><span>{avgSlippageBps.toFixed(2)}bps</span></div>
          <div className="mon-row"><span>Fill ratio</span><span>{(avgFillRatio * 100).toFixed(0)}%</span></div>
          <div className="mon-row"><span>Positive PnL</span><span>{positivePnlCount}/{metrics.length || 0}</span></div>
          <div className="optimizer-live-reasons">
            <span className={`optimizer-live-chip ${blockedCount > 0 ? "warn" : "subtle"}`}>blocked {blockedCount}</span>
            <span className={`optimizer-live-chip ${reducedCount > 0 ? "subtle" : "good"}`}>reduced {reducedCount}</span>
            <span className={`optimizer-live-chip ${delayedCount > 0 ? "subtle" : "good"}`}>delayed {delayedCount}</span>
          </div>
        </div>
      </div>
      <div className="optimizer-live-section">
        <div className="subtle mini">PnL par posture d'execution</div>
        {postureRows.map((row) => (
          <div key={`posture-${row.posture}`} className="mon-row">
            <span>{row.posture}</span>
            <span className="subtle mini">score {(row.avgScore * 100).toFixed(0)}%</span>
            <span className={row.pnlUsd >= 0 ? "good" : "warn"}>{formatSignedCompactUsd(row.pnlUsd)} · {row.count}</span>
          </div>
        ))}
      </div>
      <div className="optimizer-live-section">
        <div className="subtle mini">Evenements recents</div>
        {metrics.length === 0 ? <p className="subtle mini">Aucun echantillon execution smart.</p> : null}
        {metrics.slice(0, 6).map((item, index) => (
          <div key={`smart-tracker-${index}-${item.timestamp || item.status}`} className="mon-row">
            <span>{item.timestamp ? formatCompactClock(item.timestamp, formatClock) : "--:--:--"}</span>
            <span className="subtle mini">{item.status || item.posture}</span>
            <span>{(item.executionScore * 100).toFixed(0)}% · x{item.sizeMultiplier.toFixed(2)} · {item.delayMs.toFixed(0)}ms</span>
          </div>
        ))}
      </div>
    </MonitoringPanelCard>
  );
}

export function ExecutionOptimizerMonitoringPanel({
  badge,
  layoutEditMode,
  onDetach,
  payload,
  routingPayload,
  formatClock,
}: {
  badge: ReactNode;
  layoutEditMode: boolean;
  onDetach: () => void;
  payload: ExecutionOptimizerLivePayload | null;
  routingPayload: Record<string, unknown> | null;
  formatClock: (value: string) => string;
}) {
  const envelope = safeRecord(payload);
  const routingEnvelope = safeRecord(routingPayload);
  const profilesRecord = safeRecord(envelope.profiles);
  const activeOrders = safeRows(envelope.active_orders);
  const recentEvents = safeRows(envelope.recent_events);
  const dominance = safeRecord(routingEnvelope.dominance);
  const splitPlan = safeRecord(routingEnvelope.split_plan);
  const hedgeRecommendation = safeRecord(routingEnvelope.hedge_recommendation);
  const executionAiV6 = safeRecord(routingEnvelope.execution_ai_v6);
  const executionAiV6State = safeRecord(executionAiV6.state);
  const executionAiV6Decision = safeRecord(executionAiV6.decision);
  const executionAiV6Snapshot = safeRecord(executionAiV6.snapshot);
  const executionAiV6Guardrails = safeRecord(executionAiV6Decision.guardrails || executionAiV6Snapshot.guardrails);
  const bestRoute = safeRecord(routingEnvelope.best);
  const backupRoute = safeRecord(routingEnvelope.backup);
  const splitSlices = safeRows(splitPlan.slices).slice(0, 3);
  const executionAiV6TopActions = safeRows(executionAiV6Snapshot.top_actions).slice(0, 3);
  const executionAiV6Episodes = safeRows(executionAiV6Snapshot.recent_episodes).slice(0, 3);
  const hedgeReasons = Array.isArray(hedgeRecommendation.reasons)
    ? hedgeRecommendation.reasons.map((item) => String(item)).filter(Boolean).slice(0, 3)
    : [];
  const executionAiV6Reasons = Array.isArray(executionAiV6Decision.reasons)
    ? executionAiV6Decision.reasons.map((item) => String(item)).filter(Boolean).slice(0, 4)
    : [];
  const executionAiV6FreezeReasons = Array.isArray(executionAiV6Guardrails.freeze_reasons)
    ? executionAiV6Guardrails.freeze_reasons.map((item) => String(item)).filter(Boolean).slice(0, 3)
    : [];
  const routingAvailable = Object.keys(routingEnvelope).length > 0;
  const executionAiV6Available = Object.keys(executionAiV6).length > 0;
  const routingLeader = String(dominance.leader_venue || bestRoute.venue || "--");
  const routingRunnerUp = String(dominance.runner_up_venue || backupRoute.venue || "--");
  const splitMode = String(splitPlan.mode || dominance.mode || "singleVenue");
  const hedgeMode = String(hedgeRecommendation.mode || "standby");
  const hedgeEnabled = Boolean(hedgeRecommendation.enabled);
  const executionAiV6Action = String(executionAiV6Decision.action || "hold");
  const executionAiV6LearningEnabled = Boolean(executionAiV6Decision.learning_enabled);
  const executionAiV6Frozen = Boolean(executionAiV6Guardrails.learning_frozen);
  const hedgeVenueLabel = hedgeMode === "crossExchangeLock"
    ? `${String(hedgeRecommendation.buy_venue || "--")}→${String(hedgeRecommendation.sell_venue || "--")}`
    : String(hedgeRecommendation.venue || "--");
  const profileRows = Object.values(profilesRecord)
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    .sort((left, right) => safeNumber(right.sample_count, 0) - safeNumber(left.sample_count, 0));
  const updatedAt = String(envelope.updated_at || envelope.profiles_updated_at || "").trim();
  const proxyState = String(envelope.network_state || "healthy").trim().toLowerCase();
  const titleBadge = (
    <>
      {badge}
      <span className={`venue-telemetry-proxy-badge ${proxyState}`}>{proxyState.replace(/_/g, " ")}</span>
    </>
  );

  return (
    <MonitoringPanelCard title="Execution Optimizer" badge={titleBadge} layoutEditMode={layoutEditMode} onDetach={onDetach}>
      {!payload ? <p className="subtle mini">Optimizer live-state indisponible.</p> : null}
      {payload ? (
        <>
          <div className="venue-telemetry-summary">
            <span className="venue-telemetry-pill">active {activeOrders.length}</span>
            <span className="venue-telemetry-pill">profiles {profileRows.length}</span>
            <span className="venue-telemetry-pill">events {recentEvents.length}</span>
            <span className="venue-telemetry-pill">updated {updatedAt ? formatCompactClock(updatedAt, formatClock) : "--:--:--"}</span>
          </div>
          <div className="optimizer-live-section">
            <div className="subtle mini">V5 multi-venue routing</div>
            {!routingAvailable ? <p className="subtle mini">Dominance, split et hedge V5 indisponibles.</p> : null}
            {routingAvailable ? (
              <div className="optimizer-live-grid">
                <div className={`venue-telemetry-item ${safeNumber(dominance.score_gap, 0) >= 0.08 ? "good" : "subtle"}`}>
                  <div className="venue-telemetry-head">
                    <span className="venue-telemetry-venue">Dominance</span>
                    <span className={`venue-telemetry-state ${safeNumber(dominance.score_gap, 0) >= 0.08 ? "good" : "subtle"}`}>{routingLeader}</span>
                  </div>
                  <div className="mon-row"><span>Leader / backup</span><span>{routingLeader} · {routingRunnerUp}</span></div>
                  <div className="mon-row"><span>Score gap</span><span>{safeNumber(dominance.score_gap, 0).toFixed(3)} · lead {(safeNumber(dominance.leader_score, 0) * 100).toFixed(0)}%</span></div>
                  <div className="mon-row"><span>Latency edge</span><span>{formatCompactMetricMs(dominance.latency_edge_ms)} · queue {(safeNumber(dominance.queue_position, 0) * 100).toFixed(0)}%</span></div>
                  <div className="mon-row"><span>Route score</span><span>{(safeNumber(bestRoute.score, safeNumber(dominance.leader_score, 0)) * 100).toFixed(0)}% · reason {String(routingEnvelope.reason || "best_route_candidate").replace(/_/g, " ")}</span></div>
                </div>
                <div className={`venue-telemetry-item ${splitMode === "multiVenueSplit" ? "good" : "subtle"}`}>
                  <div className="venue-telemetry-head">
                    <span className="venue-telemetry-venue">Split</span>
                    <span className={`venue-telemetry-state ${splitMode === "multiVenueSplit" ? "good" : "subtle"}`}>{splitMode.replace(/_/g, " ")}</span>
                  </div>
                  <div className="mon-row"><span>Primary / venues</span><span>{String(splitPlan.primary_venue || routingLeader || "--")} · {safeNumber(splitPlan.venue_count, splitSlices.length || 1).toFixed(0)} venues</span></div>
                  <div className="mon-row"><span>Coverage / slip</span><span>{(safeNumber(splitPlan.coverage_ratio, 0) * 100).toFixed(0)}% · {safeNumber(splitPlan.estimated_slippage_bps, 0).toFixed(2)}bps</span></div>
                  <div className="mon-row"><span>Plan size</span><span>{formatCompactUsd(splitPlan.total_notional_usd)} · rem {formatCompactUsd(splitPlan.remaining_notional_usd)}</span></div>
                  <div className="optimizer-live-reasons">
                    {splitSlices.length === 0 ? <span className="optimizer-live-chip warn">no split slices</span> : null}
                    {splitSlices.map((slice, index) => (
                      <span key={`split-slice-${index}-${String(slice.venue || "venue")}`} className="optimizer-live-chip good">
                        {String(slice.venue || "?")} {(safeNumber(slice.share_pct, 0) * 100).toFixed(0)}% · {formatCompactUsd(slice.notional_usd)}
                      </span>
                    ))}
                  </div>
                </div>
                <div className={`venue-telemetry-item ${hedgeEnabled ? "good" : "subtle"}`}>
                  <div className="venue-telemetry-head">
                    <span className="venue-telemetry-venue">Hedge</span>
                    <span className={`venue-telemetry-state ${hedgeEnabled ? "good" : "subtle"}`}>{hedgeMode.replace(/_/g, " ")}</span>
                  </div>
                  <div className="mon-row"><span>State</span><span>{hedgeEnabled ? "enabled" : "standby"}</span></div>
                  <div className="mon-row"><span>Venue</span><span>{hedgeVenueLabel}</span></div>
                  <div className="mon-row"><span>Trigger / size</span><span>{formatCompactUsd(hedgeRecommendation.trigger_delta_usd)} · {formatCompactUsd(hedgeRecommendation.hedge_notional_usd)}</span></div>
                  <div className="optimizer-live-reasons">
                    {hedgeReasons.length === 0 ? <span className="optimizer-live-chip warn">no hedge trigger</span> : null}
                    {hedgeReasons.map((reason) => <span key={reason} className="optimizer-live-chip good">{reason}</span>)}
                  </div>
                </div>
                <div className={`venue-telemetry-item ${executionAiV6Frozen ? "warn" : executionAiV6Action === "hold" ? "subtle" : "good"}`}>
                  <div className="venue-telemetry-head">
                    <span className="venue-telemetry-venue">Execution AI V6</span>
                    <span className={`venue-telemetry-state ${executionAiV6Frozen ? "warn" : executionAiV6Action === "hold" ? "subtle" : "good"}`}>{executionAiV6Action.replace(/_/g, " ")}</span>
                  </div>
                  {!executionAiV6Available ? <div className="mon-row"><span>State</span><span>indisponible</span></div> : null}
                  {executionAiV6Available ? (
                    <>
                      <div className="mon-row"><span>Confiance / reward</span><span>{(safeNumber(executionAiV6Decision.confidence, 0) * 100).toFixed(0)}% · {safeNumber(executionAiV6Decision.projected_reward, 0).toFixed(2)}</span></div>
                      <div className="mon-row"><span>Regime / venue</span><span>{String(executionAiV6State.market_regime || "balanced")} · {String(executionAiV6State.venue || routingLeader || "--")}</span></div>
                      <div className="mon-row"><span>Queue / fill</span><span>{(safeNumber(executionAiV6State.queue_position, 0) * 100).toFixed(0)}% · {(safeNumber(executionAiV6State.fill_probability, 0) * 100).toFixed(0)}%</span></div>
                      <div className="mon-row"><span>Learning</span><span>{executionAiV6LearningEnabled ? "enabled" : "frozen"} · {safeNumber(executionAiV6Snapshot.context_count, 0).toFixed(0)} ctx</span></div>
                      <div className="mon-row"><span>Persistence</span><span className={Boolean(executionAiV6Guardrails.persistence_available) ? "good" : "warn"}>{Boolean(executionAiV6Guardrails.persistence_available) ? "db online" : "db degraded"}</span></div>
                      <div className="optimizer-live-reasons">
                        {executionAiV6Reasons.length === 0 ? <span className="optimizer-live-chip subtle">no policy reasons</span> : null}
                        {executionAiV6Reasons.map((reason) => <span key={reason} className="optimizer-live-chip good">{reason}</span>)}
                      </div>
                    </>
                  ) : null}
                </div>
                <div className={`venue-telemetry-item ${executionAiV6Frozen ? "warn" : "subtle"}`}>
                  <div className="venue-telemetry-head">
                    <span className="venue-telemetry-venue">V6 learning state</span>
                    <span className={`venue-telemetry-state ${executionAiV6Frozen ? "warn" : "subtle"}`}>{executionAiV6Frozen ? "guarded" : "active"}</span>
                  </div>
                  {!executionAiV6Available ? <div className="mon-row"><span>Episodes</span><span>aucune donnee</span></div> : null}
                  {executionAiV6Available ? (
                    <>
                      <div className="mon-row"><span>EMA / drawdown</span><span>{safeNumber(executionAiV6Guardrails.reward_ema, 0).toFixed(2)} · dd {safeNumber(executionAiV6Guardrails.reward_drawdown, 0).toFixed(2)}</span></div>
                      <div className="mon-row"><span>Vol / streak</span><span>{safeNumber(executionAiV6Guardrails.reward_volatility, 0).toFixed(2)} · {safeNumber(executionAiV6Guardrails.negative_streak, 0).toFixed(0)} neg</span></div>
                      <div className="mon-row"><span>Loaded</span><span>{Boolean(executionAiV6Guardrails.loaded) ? formatCompactClock(executionAiV6Guardrails.loaded_at, formatClock) : "cold"}</span></div>
                      {!Boolean(executionAiV6Guardrails.persistence_available) && String(executionAiV6Guardrails.last_persist_error || "") ? (
                        <div className="mon-row"><span>DB error</span><span className="warn gtix-ellipsis">{String(executionAiV6Guardrails.last_persist_error || "")}</span></div>
                      ) : null}
                      <div className="optimizer-live-reasons">
                        {executionAiV6FreezeReasons.length === 0 ? <span className="optimizer-live-chip good">guardrails clean</span> : null}
                        {executionAiV6FreezeReasons.map((reason) => <span key={reason} className="optimizer-live-chip warn">{reason}</span>)}
                        {executionAiV6TopActions.map((row) => (
                          <span key={`v6-top-${String(row.action || "hold")}`} className="optimizer-live-chip subtle">
                            {String(row.action || "hold")} {safeNumber(row.avg_reward, 0).toFixed(2)} · {safeNumber(row.sample_count, 0).toFixed(0)}
                          </span>
                        ))}
                      </div>
                      <div className="optimizer-live-reasons">
                        {executionAiV6Episodes.map((episode, index) => (
                          <span key={`v6-episode-${index}-${String(episode.timestamp || "ts")}`} className={`optimizer-live-chip ${safeNumber(episode.reward, 0) >= 0 ? "good" : "warn"}`}>
                            {String(episode.action || "hold")} {safeNumber(episode.reward, 0).toFixed(2)}
                          </span>
                        ))}
                      </div>
                    </>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
          <div className="optimizer-live-section">
            <div className="subtle mini">Live managed orders</div>
            {activeOrders.length === 0 ? <p className="subtle mini">Aucun ordre live actuellement managé.</p> : null}
            <div className="optimizer-live-grid">
              {activeOrders.slice(0, 4).map((order, index) => {
                const tone = resolveExecutionOptimizerTone(order);
                const guardReasons = Array.isArray(order.guard_reasons) ? order.guard_reasons.map((item) => String(item)).filter(Boolean).slice(0, 3) : [];
                const deskProfile = safeRecord(order.desk_profile);
                return (
                  <div key={`optimizer-active-${index}-${String(order.order_id || order.decision_id || "row")}`} className={`venue-telemetry-item ${tone}`}>
                    <div className="venue-telemetry-head">
                      <span className="venue-telemetry-venue">{String(order.symbol || "?")} · {String(order.side || "buy").toUpperCase()}</span>
                      <span className={`venue-telemetry-state ${tone}`}>{String(order.lifecycle_action || order.status || "keep").replace(/_/g, " ")}</span>
                    </div>
                    <div className="mon-row"><span>Venue</span><span>{String(order.market_venue || order.broker_provider || "unknown")}</span></div>
                    <div className="mon-row"><span>Queue / fill</span><span>{(safeNumber(order.queue_rank_estimate, 0) * 100).toFixed(0)}% tail · {(safeNumber(order.fill_score, 0) * 100).toFixed(0)}%</span></div>
                    <div className="mon-row"><span>Predicted fill</span><span>{(safeNumber(order.predicted_fill_probability, 0) * 100).toFixed(0)}% · {(safeNumber(order.dominance_score, 0) * 100).toFixed(0)} dom</span></div>
                    <div className="mon-row"><span>Queue clock</span><span>{formatCompactMetricMs(order.time_in_queue_ms)} · TTF {formatCompactMetricMs(order.time_to_fill_estimate_ms)}</span></div>
                    <div className="mon-row"><span>Toxicity</span><span>{(safeNumber(order.adverse_selection_score, 0) * 100).toFixed(0)}% adv · {(safeNumber(order.liquidity_decay_rate, 0) * 100).toFixed(0)}% decay</span></div>
                    <div className="mon-row"><span>Timing</span><span>{String(order.timing || "WAIT")}</span></div>
                    <div className="mon-row"><span>Profile</span><span>{safeNumber(deskProfile.sample_count, 0)} fills · max {safeNumber(deskProfile.max_spread_bps, 0).toFixed(1)}bps</span></div>
                    <div className="optimizer-live-reasons">
                      {guardReasons.length === 0 ? <span className="optimizer-live-chip good">guard clean</span> : null}
                      {guardReasons.map((reason) => <span key={reason} className="optimizer-live-chip warn">{reason}</span>)}
                      {Boolean(order.spoof_detected) ? <span className="optimizer-live-chip warn">spoof</span> : null}
                      {Boolean(order.liquidity_trap_detected) ? <span className="optimizer-live-chip warn">trap</span> : null}
                      {Boolean(order.should_move_ahead) ? <span className="optimizer-live-chip good">move-ahead</span> : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="optimizer-live-section">
            <div className="subtle mini">Recent lifecycle events</div>
            {recentEvents.length === 0 ? <p className="subtle mini">Aucun event recent.</p> : null}
            {recentEvents.slice(0, 4).map((event, index) => (
              <div key={`optimizer-event-${index}`} className="mon-row">
                <span>{String(event.updated_at || "") ? formatClock(String(event.updated_at)) : "--:--:--"}</span>
                <span className="subtle mini">{String(event.symbol || "?")} · {String(event.market_venue || event.broker_provider || "unknown")}</span>
                <span className={resolveExecutionOptimizerTone(event)}>{String(event.lifecycle_action || event.status || "keep")}</span>
              </div>
            ))}
          </div>
          <div className="optimizer-live-section">
            <div className="subtle mini">Calibrated venue desk profiles</div>
            {profileRows.length === 0 ? <p className="subtle mini">Pas encore de calibration fills.</p> : null}
            <div className="optimizer-profile-grid">
              {profileRows.slice(0, 4).map((profile, index) => (
                <div key={`optimizer-profile-${index}-${String(profile.venue || "venue")}`} className="venue-telemetry-item subtle">
                  <div className="venue-telemetry-head">
                    <span className="venue-telemetry-venue">{String(profile.venue || "venue")}</span>
                    <span className="venue-telemetry-state subtle">{safeNumber(profile.sample_count, 0)} fills</span>
                  </div>
                  <div className="mon-row"><span>Spread / latency</span><span>{safeNumber(profile.max_spread_bps, 0).toFixed(1)}bps · {Math.round(safeNumber(profile.max_latency_ms, 0))}ms</span></div>
                  <div className="mon-row"><span>Fill guard</span><span>{(safeNumber(profile.min_fill_probability, 0) * 100).toFixed(0)}% / {(safeNumber(profile.replace_below_fill_probability, 0) * 100).toFixed(0)}%</span></div>
                  <div className="mon-row"><span>Spoof wall</span><span>{formatCompactUsd(profile.spoof_notional_usd)} · {Math.round(safeNumber(profile.spoof_lifetime_ms, 0))}ms</span></div>
                </div>
              ))}
            </div>
          </div>
        </>
      ) : null}
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