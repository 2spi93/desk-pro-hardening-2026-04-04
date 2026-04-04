"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import HelpHint from "../../components/HelpHint";
import TxtMiniGuide from "../../components/ui/TxtMiniGuide";
import {
  BROKER_CONNECTION_CATALOG,
  EXCHANGE_CONNECTION_CATALOG,
  WALLET_CONNECTION_CATALOG,
} from "../../lib/connectionCatalog";

type JsonMap = Record<string, unknown>;

type FundTab = "overview" | "sleeves" | "ic-notes" | "allocator" | "risk";

type NotesState = {
  investmentThesis: string;
  geopoliticalMap: string;
  regimePolicy: string;
  opsChecklist: string;
  mandateObjective: string;
  mandateConstraints: string;
  mandateHorizon: string;
  mandateUniverse: string;
  mandateRiskFramework: string;
  icStructuredNotes: string;
  icCommitteeDecisions: string;
  icRationales: string;
  icMandateChanges: string;
  icReviewCadence: string;
  icAllocationDecisions: string;
  allocatorNarrative: string;
};

type SleeveMetric = {
  name: string;
  label: string;
  allocationPct: number;
  pnlUsd: number;
  riskContributionPct: number;
  exposureUsd: number;
  turnoverPct: number;
  sharpe: number;
  sortino: number;
  heatmap: Array<{ asset: string; intensity: number }>;
};

type SparklineCardProps = {
  title: string;
  value: string;
  detail: string;
  series: number[];
  tone: string;
};

const NOTES_STORAGE_KEY = "gtixt.fund-manager.notes.v2";

const DEFAULT_NOTES: NotesState = {
  investmentThesis: "Hypothese centrale, catalyseurs, invalidation, sizing et plan de sortie par sleeve.",
  geopoliticalMap: "Evenements macro, geopolitique, banques centrales, matieres premieres et chaines de transmission aux actifs du fonds.",
  regimePolicy: "Quel playbook pour scalping, intraday, swing, weekly et event-driven en fonction du regime detecte.",
  opsChecklist: "Venue principale, venue backup, wallet/custody, circuit breakers, runbook incident et gouvernance des exceptions.",
  mandateObjective: "Absolute return multi-asset avec overlay market neutral quand la microstructure se degrade.",
  mandateConstraints: "Max DD 8%, max leverage 3.2x, max exposure 35% par asset class, hard stop sur drift execution ou connecteurs critiques.",
  mandateHorizon: "Intraday a weekly avec poches swing opportunistes quand le cadre macro reste lisible.",
  mandateUniverse: "Crypto, FX, indices, metals, commodities et cash overlays defensifs.",
  mandateRiskFramework: "VaR 1d, max loss per day, stop-trading rules, concentration caps, hedging rules et revue mandatory apres breach.",
  icStructuredNotes: "Compte rendu structure des hypotheses, signaux, portefeuille, risques ouverts et points de surveillance avant execution.",
  icCommitteeDecisions: "Decisions du comite: increase directional BTC sleeve, cut volatility sleeve, keep market-making only on healthy venues.",
  icRationales: "Rationale: regime risk-on modere, spreads stables, macro supportive, mais garder discipline sur drawdown et concentration.",
  icMandateChanges: "Mandate change log: baisse levier max temporaire en cas de stress geopolitique ou de deterioration execution venues.",
  icReviewCadence: "Weekly review sur performance/discipline, monthly allocator pack, ad-hoc IC si stress test ou DD depasse le seuil orange.",
  icAllocationDecisions: "Allocation decisions: rebalancer entre sleeves, couper les poches sous-performantes, renforcer AI only si attribution et risk budget le permettent.",
  allocatorNarrative: "Narratif allocator: discipline du mandat, raison des performances, drawdown control, liquidite et scenario analysis par sleeve.",
};

const NOTE_KEYS: Array<keyof NotesState> = [
  "investmentThesis",
  "geopoliticalMap",
  "regimePolicy",
  "opsChecklist",
  "mandateObjective",
  "mandateConstraints",
  "mandateHorizon",
  "mandateUniverse",
  "mandateRiskFramework",
  "icStructuredNotes",
  "icCommitteeDecisions",
  "icRationales",
  "icMandateChanges",
  "icReviewCadence",
  "icAllocationDecisions",
  "allocatorNarrative",
];

const DEFAULT_SCENARIOS = [
  "Fed emergency hike",
  "Middle East escalation",
  "China stimulus surprise",
  "Energy supply shock",
];

const TAB_OPTIONS: Array<{ id: FundTab; label: string; summary: string }> = [
  { id: "overview", label: "Overview", summary: "Mandate, header metrics, macro controls and venue links." },
  { id: "sleeves", label: "Sleeves", summary: "Directional, MM, arb, vol and AI sleeves with allocation discipline." },
  { id: "ic-notes", label: "IC Notes", summary: "Investment committee memory, decisions and mandate changes." },
  { id: "allocator", label: "Allocator", summary: "Allocator reporting, attribution and stress narratives." },
  { id: "risk", label: "Risk", summary: "Live risk overlay, mandate usage, position heatmap and correlation view." },
];

const SLEEVE_BLUEPRINT = [
  { name: "Directional", allocationPct: 28, riskContributionPct: 31, turnoverPct: 132, sharpe: 1.78, sortino: 2.34, exposureShare: 0.26, pnlShare: 0.24, heatmap: ["BTC", "ETH", "EURUSD", "XAUUSD"] },
  { name: "Market-making", allocationPct: 18, riskContributionPct: 14, turnoverPct: 286, sharpe: 1.41, sortino: 1.9, exposureShare: 0.14, pnlShare: 0.17, heatmap: ["BTC perp", "ETH perp", "SOL", "USDT"] },
  { name: "Arbitrage", allocationPct: 16, riskContributionPct: 11, turnoverPct: 214, sharpe: 1.56, sortino: 2.08, exposureShare: 0.12, pnlShare: 0.15, heatmap: ["Basis", "FX basis", "Index arb", "Metals"] },
  { name: "Volatility", allocationPct: 14, riskContributionPct: 19, turnoverPct: 96, sharpe: 1.12, sortino: 1.46, exposureShare: 0.18, pnlShare: 0.09, heatmap: ["BTC vol", "Rates", "Gold", "Oil"] },
  { name: "AI-driven strategies", allocationPct: 24, riskContributionPct: 25, turnoverPct: 168, sharpe: 1.93, sortino: 2.72, exposureShare: 0.3, pnlShare: 0.35, heatmap: ["Cross-asset", "FX", "Crypto", "Indices"] },
];

const ASSET_CLASS_BLUEPRINT = [
  { label: "Crypto", exposurePct: 34, liquidityScore: 74 },
  { label: "FX", exposurePct: 18, liquidityScore: 86 },
  { label: "Indices", exposurePct: 17, liquidityScore: 78 },
  { label: "Metals", exposurePct: 12, liquidityScore: 68 },
  { label: "Commodities", exposurePct: 11, liquidityScore: 61 },
  { label: "Cash/Hedges", exposurePct: 8, liquidityScore: 93 },
];

const CORRELATION_BLUEPRINT = [
  { row: "Directional", values: [1.0, 0.36, 0.28, -0.14, 0.41] },
  { row: "Market-making", values: [0.36, 1.0, 0.22, -0.06, 0.27] },
  { row: "Arbitrage", values: [0.28, 0.22, 1.0, 0.08, 0.31] },
  { row: "Volatility", values: [-0.14, -0.06, 0.08, 1.0, -0.12] },
  { row: "AI-driven", values: [0.41, 0.27, 0.31, -0.12, 1.0] },
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toNumber(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function formatMoney(value: number): string {
  const sign = value < 0 ? "-" : "";
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000) {
    return `${sign}${(absolute / 1_000_000).toFixed(2)}m USD`;
  }
  if (absolute >= 1_000) {
    return `${sign}${(absolute / 1_000).toFixed(1)}k USD`;
  }
  return `${sign}${absolute.toFixed(0)} USD`;
}

function formatPct(value: number, digits = 1): string {
  return `${value.toFixed(digits)}%`;
}

function formatRatio(value: number, digits = 2): string {
  return `${value.toFixed(digits)}x`;
}

function resolveTimestampMs(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resolveEntryTimestampMs(entry: JsonMap, keys: string[]): number {
  for (const key of keys) {
    const timestamp = resolveTimestampMs(entry[key], NaN);
    if (Number.isFinite(timestamp)) {
      return timestamp;
    }
  }
  return NaN;
}

function firstFiniteNumber(entry: JsonMap, keys: string[], fallback = NaN): number {
  for (const key of keys) {
    const value = toNumber(entry[key], NaN);
    if (Number.isFinite(value)) {
      return value;
    }
  }
  return fallback;
}

function buildMetricSeries(rows: JsonMap[], timeKeys: string[], valueKeys: string[], includeMissingAsZero = false): number[] {
  return [...rows]
    .sort((left, right) => resolveEntryTimestampMs(left, timeKeys) - resolveEntryTimestampMs(right, timeKeys))
    .flatMap((entry) => {
      const value = firstFiniteNumber(entry, valueKeys, NaN);
      if (Number.isFinite(value)) {
        return [value];
      }
      return includeMissingAsZero ? [0] : [];
    });
}

function buildCumulativeMetricSeries(rows: JsonMap[], timeKeys: string[], valueKeys: string[]): number[] {
  let runningTotal = 0;
  return [...rows]
    .sort((left, right) => resolveEntryTimestampMs(left, timeKeys) - resolveEntryTimestampMs(right, timeKeys))
    .map((entry) => {
      runningTotal += firstFiniteNumber(entry, valueKeys, 0);
      return runningTotal;
    });
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values: number[]): number {
  if (values.length <= 1) {
    return 0;
  }
  const mean = average(values);
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length;
  return Math.sqrt(variance);
}

function buildDrawdownPctSeries(curve: number[], baseCapital: number): number[] {
  let peakWealth = Math.max(1, baseCapital);
  return curve.map((value) => {
    const wealth = Math.max(1, baseCapital + value);
    peakWealth = Math.max(peakWealth, wealth);
    return peakWealth > 0 ? ((peakWealth - wealth) / peakWealth) * 100 : 0;
  });
}

function buildReturnSeries(curve: number[], baseCapital: number): number[] {
  let previousWealth = Math.max(1, baseCapital);
  return curve.map((value) => {
    const wealth = Math.max(1, baseCapital + value);
    const nextReturn = (wealth - previousWealth) / Math.max(Math.abs(previousWealth), 1);
    previousWealth = wealth;
    return nextReturn;
  });
}

function buildRollingSharpeSeries(curve: number[], baseCapital: number, windowSize = 5): number[] {
  const returns = buildReturnSeries(curve, baseCapital);
  return returns.map((_, index) => {
    const window = returns.slice(Math.max(0, index - windowSize + 1), index + 1);
    const deviation = standardDeviation(window);
    if (!(deviation > 0)) {
      return 0;
    }
    return Number(((average(window) / deviation) * Math.sqrt(window.length)).toFixed(2));
  });
}

function buildRollingSortinoSeries(curve: number[], baseCapital: number, windowSize = 5): number[] {
  const returns = buildReturnSeries(curve, baseCapital);
  return returns.map((_, index) => {
    const window = returns.slice(Math.max(0, index - windowSize + 1), index + 1);
    const downside = window.filter((value) => value < 0);
    const downsideDeviation = standardDeviation(downside.length > 0 ? downside : [0]);
    if (!(downsideDeviation > 0)) {
      return 0;
    }
    return Number(((average(window) / downsideDeviation) * Math.sqrt(window.length)).toFixed(2));
  });
}

function buildRollingVolatilitySeries(curve: number[], baseCapital: number, windowSize = 5): number[] {
  const returns = buildReturnSeries(curve, baseCapital);
  return returns.map((_, index) => {
    const window = returns.slice(Math.max(0, index - windowSize + 1), index + 1);
    return Number((standardDeviation(window) * 100).toFixed(2));
  });
}

function buildSparklinePath(values: number[], width: number, height: number): string {
  if (values.length === 0) {
    return "";
  }
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const span = Math.max(1e-6, maxValue - minValue);
  const stepX = values.length > 1 ? width / (values.length - 1) : width;
  return values
    .map((value, index) => {
      const x = Number((index * stepX).toFixed(2));
      const y = Number((height - ((value - minValue) / span) * height).toFixed(2));
      return `${index === 0 ? "M" : "L"}${x},${y}`;
    })
    .join(" ");
}

function coerceNotes(parsed: Partial<NotesState>): NotesState {
  return NOTE_KEYS.reduce((accumulator, key) => {
    accumulator[key] = typeof parsed[key] === "string" ? parsed[key] as string : DEFAULT_NOTES[key];
    return accumulator;
  }, {} as NotesState);
}

function useStoredNotes(): [NotesState, (key: keyof NotesState, value: string) => void] {
  const [notes, setNotes] = useState<NotesState>(DEFAULT_NOTES);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    try {
      const raw = window.localStorage.getItem(NOTES_STORAGE_KEY);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw) as Partial<NotesState>;
      setNotes(coerceNotes(parsed));
    } catch {
      setNotes(DEFAULT_NOTES);
    }
  }, []);

  const updateNote = (key: keyof NotesState, value: string) => {
    setNotes((current) => {
      const next = { ...current, [key]: value };
      if (typeof window !== "undefined") {
        window.localStorage.setItem(NOTES_STORAGE_KEY, JSON.stringify(next));
      }
      return next;
    });
  };

  return [notes, updateNote];
}

function SparklineCard({ title, value, detail, series, tone }: SparklineCardProps) {
  const path = buildSparklinePath(series, 120, 28);
  const areaPath = path ? `${path} L120,28 L0,28 Z` : "";
  return (
    <div className="panel" style={{ minHeight: 142 }}>
      <div className="eyebrow">{title}</div>
      <div style={{ fontSize: 28, fontWeight: 700, marginTop: 6 }}>{value}</div>
      <div className="subtle" style={{ minHeight: 38, marginTop: 4 }}>{detail}</div>
      <svg viewBox="0 0 120 28" preserveAspectRatio="none" style={{ width: "100%", height: 34, marginTop: 10 }} aria-hidden="true">
        {areaPath ? <path d={areaPath} fill={tone} opacity={0.12} /> : null}
        {path ? <path d={path} fill="none" stroke={tone} strokeWidth="2" strokeLinecap="round" /> : null}
      </svg>
    </div>
  );
}

function TabButton({ active, label, summary, onClick }: { active: boolean; label: string; summary: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      style={{
        display: "grid",
        gap: 4,
        textAlign: "left",
        padding: "12px 14px",
        borderRadius: 14,
        border: active ? "1px solid rgba(56, 189, 248, 0.7)" : "1px solid rgba(148, 163, 184, 0.18)",
        background: active ? "linear-gradient(135deg, rgba(18, 67, 108, 0.55), rgba(8, 33, 56, 0.72))" : "rgba(7, 18, 31, 0.82)",
        color: "inherit",
      }}
    >
      <span style={{ fontWeight: 700 }}>{label}</span>
      <span className="subtle" style={{ fontSize: 12 }}>{summary}</span>
    </button>
  );
}

function inferIcTags(notes: NotesState): string[] {
  const source = [
    notes.icStructuredNotes,
    notes.icCommitteeDecisions,
    notes.icRationales,
    notes.icMandateChanges,
    notes.icReviewCadence,
    notes.icAllocationDecisions,
    notes.regimePolicy,
  ].join(" ").toLowerCase();
  const tags = new Set<string>();
  if (/risk|drawdown|breach|incident|stop/.test(source)) tags.add("risk event");
  if (/mandate|leverage|constraint|max dd|max drawdown/.test(source)) tags.add("mandate change");
  if (/allocate|allocation|rebalance|sleeve|cut|increase|reduce/.test(source)) tags.add("allocation decision");
  if (/regime|macro|vol spike|risk-on|risk-off|geopolit/.test(source)) tags.add("market regime shift");
  return [...tags];
}

function resolveScoreTone(score: number): string {
  if (score >= 75) {
    return "rgba(52, 211, 153, 0.22)";
  }
  if (score >= 55) {
    return "rgba(56, 189, 248, 0.22)";
  }
  if (score >= 40) {
    return "rgba(245, 158, 11, 0.22)";
  }
  return "rgba(248, 113, 113, 0.24)";
}

export default function FundManagerPage() {
  const [activeTab, setActiveTab] = useState<FundTab>("overview");
  const [portfolioRisk, setPortfolioRisk] = useState<JsonMap | null>(null);
  const [performanceSummary, setPerformanceSummary] = useState<JsonMap | null>(null);
  const [performanceAttribution, setPerformanceAttribution] = useState<JsonMap[]>([]);
  const [portfolioCapitalIntegration, setPortfolioCapitalIntegration] = useState<JsonMap | null>(null);
  const [investorReports, setInvestorReports] = useState<JsonMap[]>([]);
  const [recentOutcomes, setRecentOutcomes] = useState<JsonMap[]>([]);
  const [recentExecutionTelemetry, setRecentExecutionTelemetry] = useState<JsonMap[]>([]);
  const [connectorsStatus, setConnectorsStatus] = useState<JsonMap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [scenario, setScenario] = useState(DEFAULT_SCENARIOS[0]);
  const [backtestResult, setBacktestResult] = useState<JsonMap | null>(null);
  const [trendScore, setTrendScore] = useState(0.42);
  const [realizedVolatility, setRealizedVolatility] = useState(0.055);
  const [sentimentScore, setSentimentScore] = useState(0.18);
  const [regimeResult, setRegimeResult] = useState<JsonMap | null>(null);
  const [notes, updateNote] = useStoredNotes();

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const [riskRes, summaryRes, attributionRes, capitalIntegrationRes, reportsRes, connectorsRes, outcomesRes, telemetryRes] = await Promise.all([
          fetch("/api/portfolios/pf-internal-main/risk", { cache: "no-store" }),
          fetch("/api/performance/summary?scope_type=portfolio&scope_id=pf-internal-main", { cache: "no-store" }),
          fetch("/api/performance/attribution?scope_type=portfolio&scope_id=pf-internal-main", { cache: "no-store" }),
          fetch("/api/portfolios/pf-internal-main/capital-integration", { cache: "no-store" }),
          fetch("/api/investor-reports?portfolio_id=pf-internal-main&limit=6", { cache: "no-store" }),
          fetch("/api/connectors/status", { cache: "no-store" }),
          fetch("/api/outcomes/recent?limit=24", { cache: "no-store" }),
          fetch("/api/execution/telemetry/recent?limit=24", { cache: "no-store" }),
        ]);

        if (cancelled) {
          return;
        }

        setPortfolioRisk(riskRes.ok ? await riskRes.json().catch(() => null) : null);
        setPerformanceSummary(summaryRes.ok ? await summaryRes.json().catch(() => null) : null);
  setPortfolioCapitalIntegration(capitalIntegrationRes.ok ? await capitalIntegrationRes.json().catch(() => null) : null);
        const attributionPayload = attributionRes.ok ? await attributionRes.json().catch(() => null) : null;
        setPerformanceAttribution(Array.isArray((attributionPayload as JsonMap | null)?.rows)
          ? ((attributionPayload as JsonMap).rows as JsonMap[])
          : Array.isArray((attributionPayload as JsonMap | null)?.items)
            ? ((attributionPayload as JsonMap).items as JsonMap[])
          : Array.isArray(attributionPayload)
            ? attributionPayload as JsonMap[]
            : []);
        const reportsPayload = reportsRes.ok ? await reportsRes.json().catch(() => null) : null;
        setInvestorReports(Array.isArray((reportsPayload as JsonMap | null)?.items)
          ? ((reportsPayload as JsonMap).items as JsonMap[])
          : Array.isArray(reportsPayload)
            ? reportsPayload as JsonMap[]
            : []);
        setConnectorsStatus(connectorsRes.ok ? await connectorsRes.json().catch(() => null) : null);
        const outcomesPayload = outcomesRes.ok ? await outcomesRes.json().catch(() => null) : null;
        setRecentOutcomes(Array.isArray(outcomesPayload) ? outcomesPayload as JsonMap[] : []);
        const telemetryPayload = telemetryRes.ok ? await telemetryRes.json().catch(() => null) : null;
        setRecentExecutionTelemetry(Array.isArray(telemetryPayload) ? telemetryPayload as JsonMap[] : []);
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "Chargement fund manager impossible");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  async function detectRegime(): Promise<void> {
    setBusy(true);
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
        throw new Error(String((payload as JsonMap).detail || "Detection regime echouee"));
      }
      setRegimeResult(payload as JsonMap);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Detection regime echouee");
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
          strategy_name: "fund-manager-macro-book",
          asset_class: "multi-asset",
          scenario,
          horizon_days: 20,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(String((payload as JsonMap).detail || "Backtest geopolitique echoue"));
      }
      setBacktestResult(payload as JsonMap);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Backtest geopolitique echoue");
    } finally {
      setBusy(false);
    }
  }

  const connectors = Array.isArray(connectorsStatus?.connectors) ? connectorsStatus.connectors as JsonMap[] : [];
  const latestInvestorReport = investorReports[0] || null;
  const latestInvestorReportSummary = latestInvestorReport && typeof latestInvestorReport.summary === "object"
    ? latestInvestorReport.summary as JsonMap
    : null;
  const reportPerformanceSummary = latestInvestorReportSummary && typeof latestInvestorReportSummary.performance_summary === "object"
    ? latestInvestorReportSummary.performance_summary as JsonMap
    : null;
  const reportPerformanceTimeseries = Array.isArray(latestInvestorReportSummary?.performance_timeseries)
    ? latestInvestorReportSummary.performance_timeseries as JsonMap[]
    : [];
  const reportTopAttribution = Array.isArray(latestInvestorReportSummary?.top_attribution)
    ? latestInvestorReportSummary.top_attribution as JsonMap[]
    : [];
  const supplementalStrategy = latestInvestorReportSummary && typeof latestInvestorReportSummary.supplemental_strategy === "object"
    ? latestInvestorReportSummary.supplemental_strategy as JsonMap
    : null;
  const supplementalStrategySummary = supplementalStrategy && typeof supplementalStrategy.summary === "object"
    ? supplementalStrategy.summary as JsonMap
    : null;
  const supplementalStrategyAttribution = Array.isArray(supplementalStrategy?.attribution)
    ? supplementalStrategy.attribution as JsonMap[]
    : [];
  const effectivePerformanceSummary = reportPerformanceSummary || performanceSummary;
  const executionBackedPerformanceSummary = toNumber(effectivePerformanceSummary?.trade_count, 0) > 0
    ? effectivePerformanceSummary
    : (supplementalStrategySummary || effectivePerformanceSummary);
  const effectiveAttributionRows = performanceAttribution.length > 0
    ? performanceAttribution
    : reportTopAttribution.length > 0
      ? reportTopAttribution
      : supplementalStrategyAttribution;
  const reportedRiskSnapshot = latestInvestorReportSummary && typeof latestInvestorReportSummary.risk_snapshot === "object"
    ? latestInvestorReportSummary.risk_snapshot as JsonMap
    : null;
  const reportedBreaches = Array.isArray(reportedRiskSnapshot?.breaches)
    ? reportedRiskSnapshot.breaches as JsonMap[]
    : Array.isArray(portfolioRisk?.breaches)
      ? portfolioRisk.breaches as JsonMap[]
      : [];
  const capitalIntegrationTotals = portfolioCapitalIntegration && typeof portfolioCapitalIntegration.totals === "object"
    ? portfolioCapitalIntegration.totals as JsonMap
    : null;
  const capitalIntegrationSleeves = Array.isArray(portfolioCapitalIntegration?.sleeves)
    ? portfolioCapitalIntegration.sleeves as JsonMap[]
    : [];

  const equityUsd = toNumber(portfolioRisk?.equity_usd, 50_000);
  const grossExposureUsd = toNumber(portfolioRisk?.gross_exposure_usd, equityUsd * 1.45);
  const netExposureUsd = toNumber(portfolioRisk?.net_exposure_usd, grossExposureUsd * 0.82);
  const concentrationPct = clamp(toNumber(portfolioRisk?.concentration_pct, 32), 0, 100);
  const realizedPnlUsd = toNumber(effectivePerformanceSummary?.realized_pnl_usd, equityUsd * 0.082);
  const unrealizedPnlUsd = toNumber(effectivePerformanceSummary?.unrealized_pnl_usd, equityUsd * 0.013);
  const winRatePct = clamp(toNumber(executionBackedPerformanceSummary?.win_rate_pct, 57.4), 0, 100);
  const expectancyUsd = toNumber(executionBackedPerformanceSummary?.expectancy_usd, 320);
  const tradeCount = Math.max(0, toNumber(executionBackedPerformanceSummary?.trade_count, recentExecutionTelemetry.length));
  const avgLatencyMs = Math.max(0, toNumber(executionBackedPerformanceSummary?.avg_latency_ms, 0));
  const avgSlippageBps = Math.max(0, toNumber(executionBackedPerformanceSummary?.avg_slippage_bps, 0));
  const sharpeRatio = toNumber(executionBackedPerformanceSummary?.sharpe_ratio, NaN);
  const maxDrawdownPct = clamp(toNumber(effectivePerformanceSummary?.max_drawdown_pct, toNumber(portfolioRisk?.max_drawdown_pct, 6.8)), 0, 100);
  const currentDrawdownPct = clamp(toNumber(portfolioRisk?.current_drawdown_pct, toNumber(portfolioRisk?.drawdown_pct, Math.max(1.4, maxDrawdownPct * 0.46))), 0, 100);
  const rollingVol30 = clamp(toNumber(effectivePerformanceSummary?.rolling_volatility_30d_pct, realizedVolatility * 100 * 1.3), 0, 100);
  const leverageNow = equityUsd > 0 ? grossExposureUsd / equityUsd : 0;
  const mandateMaxDrawdownPct = 8;
  const mandateMaxLeverage = 3.2;
  const distanceToMaxDdPct = clamp(mandateMaxDrawdownPct - currentDrawdownPct, 0, mandateMaxDrawdownPct);
  const mandateUsagePct = clamp(Math.max((leverageNow / mandateMaxLeverage) * 100, (currentDrawdownPct / mandateMaxDrawdownPct) * 100, concentrationPct), 0, 100);
  const riskBudgetRemainingPct = clamp(100 - mandateUsagePct, 0, 100);
  const riskOnScore = clamp(64 + winRatePct * 0.12 - leverageNow * 9 - currentDrawdownPct * 2.2 - concentrationPct * 0.11 + toNumber(regimeResult?.confidence, 0.55) * 14, 0, 100);
  const riskState = riskOnScore >= 60 ? "Risk-on" : riskOnScore >= 42 ? "Balanced" : "Risk-off";

  const reportTimeKeys = ["timestamp", "captured_at", "as_of", "date", "label"];

  const pnlSeries = useMemo(() => {
    const reportEquitySeries = buildMetricSeries(reportPerformanceTimeseries, reportTimeKeys, ["equity_usd", "nav_usd", "nav", "aum_usd"]);
    if (reportEquitySeries.length > 1) {
      const baseEquity = reportEquitySeries[0];
      return reportEquitySeries.map((value) => value - baseEquity);
    }

    const reportPnlSeries = buildMetricSeries(reportPerformanceTimeseries, reportTimeKeys, ["pnl_usd", "realized_pnl_usd", "net_result_usd"]);
    if (reportPnlSeries.length > 1) {
      return reportPnlSeries;
    }

    const backendOutcomeCurve = buildCumulativeMetricSeries(recentOutcomes, ["created_at", "updated_at"], ["net_result_usd", "pnl_24h", "pnl_1h", "pnl_5m"]);
    if (backendOutcomeCurve.length > 0) {
      return backendOutcomeCurve;
    }

    return [realizedPnlUsd + unrealizedPnlUsd];
  }, [realizedPnlUsd, recentOutcomes, reportPerformanceTimeseries, unrealizedPnlUsd]);

  const reportExposureSeries = useMemo(() => {
    return buildMetricSeries(reportPerformanceTimeseries, reportTimeKeys, ["gross_exposure_usd", "gross_exposure", "net_exposure_usd", "net_exposure"]);
  }, [reportPerformanceTimeseries]);

  const executionDepthSeries = useMemo(() => {
    return buildMetricSeries(recentExecutionTelemetry, ["ts_decision", "ts_fill_final", "created_at"], ["available_depth_usd"], true);
  }, [recentExecutionTelemetry]);

  const exposureSeries = useMemo(() => {
    if (reportExposureSeries.length > 1) {
      return reportExposureSeries;
    }
    if (executionDepthSeries.length > 1) {
      return executionDepthSeries;
    }
    return [grossExposureUsd];
  }, [executionDepthSeries, grossExposureUsd, reportExposureSeries]);

  const drawdownSeries = useMemo(() => {
    const reportDrawdownSeries = buildMetricSeries(reportPerformanceTimeseries, reportTimeKeys, ["drawdown_pct", "max_drawdown_pct"]);
    if (reportDrawdownSeries.length > 1) {
      return reportDrawdownSeries;
    }
    const derivedSeries = buildDrawdownPctSeries(pnlSeries, equityUsd);
    return derivedSeries.length > 0 ? derivedSeries : [currentDrawdownPct];
  }, [currentDrawdownPct, equityUsd, pnlSeries, reportPerformanceTimeseries]);

  const symbolExposureRows = useMemo(() => {
    const rawRows = Array.isArray(portfolioRisk?.symbol_exposures)
      ? portfolioRisk.symbol_exposures as JsonMap[]
      : Array.isArray(reportedRiskSnapshot?.symbol_exposures)
        ? reportedRiskSnapshot.symbol_exposures as JsonMap[]
        : [];

    return rawRows
      .map((entry, index) => {
        const symbol = String(entry.symbol || entry.asset || entry.instrument || `book-${index + 1}`);
        const exposureUsd = Math.abs(firstFiniteNumber(entry, ["gross_exposure_usd", "exposure_usd", "notional_usd", "gross_usd", "net_exposure_usd"], 0));
        const pnlUsd = firstFiniteNumber(entry, ["realized_pnl_usd", "unrealized_pnl_usd", "pnl_usd"], NaN);
        const riskPct = Math.abs(firstFiniteNumber(entry, ["risk_contribution_pct", "pct_nav", "weight_pct", "allocation_pct"], NaN));
        return {
          symbol,
          venue: String(entry.venue || entry.exchange || entry.book || "live-book"),
          exposureUsd,
          pnlUsd,
          riskPct,
        };
      })
      .filter((entry) => entry.exposureUsd > 0)
      .sort((left, right) => right.exposureUsd - left.exposureUsd);
  }, [portfolioRisk, reportedRiskSnapshot]);

  const telemetryLatencySeries = useMemo(() => {
    return buildMetricSeries(recentExecutionTelemetry, ["ts_decision", "ts_fill_final", "created_at"], ["latency_e2e_ms", "latency_ms"], true);
  }, [recentExecutionTelemetry]);

  const telemetrySlippageSeries = useMemo(() => {
    return buildMetricSeries(recentExecutionTelemetry, ["ts_decision", "ts_fill_final", "created_at"], ["realized_slippage_bps", "slippage_real_bps"], true);
  }, [recentExecutionTelemetry]);

  const avgAvailableDepthUsd = average(executionDepthSeries.filter((value) => value > 0));
  const latestPnlUsd = pnlSeries[pnlSeries.length - 1] || (realizedPnlUsd + unrealizedPnlUsd);

  const sleeves = useMemo<SleeveMetric[]>(() => {
    if (symbolExposureRows.length > 0) {
      const totalObservedExposure = Math.max(grossExposureUsd, symbolExposureRows.reduce((sum, entry) => sum + entry.exposureUsd, 0), 1);
      const baseSharpe = Number.isFinite(sharpeRatio) ? sharpeRatio : 1.12;

      return symbolExposureRows.slice(0, 5).map((entry, index) => {
        const allocationPct = clamp((entry.exposureUsd / totalObservedExposure) * 100, 0, 100);
        const inferredPnlUsd = Number.isFinite(entry.pnlUsd) ? entry.pnlUsd : latestPnlUsd * (allocationPct / 100);
        const inferredRiskPct = Number.isFinite(entry.riskPct) ? clamp(entry.riskPct, 0, 100) : clamp(allocationPct * (0.86 + index * 0.05), 0, 100);
        const turnoverPct = clamp((tradeCount / Math.max(symbolExposureRows.length, 1)) * (12 + index * 2), 12, 320);
        const sleeveSharpe = Number((baseSharpe * (0.88 + allocationPct / 220)).toFixed(2));
        const sleeveSortino = Number((sleeveSharpe + 0.34 + Math.max(0, riskBudgetRemainingPct - 20) / 160).toFixed(2));
        const heatAssets = [entry.symbol, entry.venue, allocationPct >= 20 ? "core" : "tactical", inferredPnlUsd >= 0 ? "positive pnl" : "drawdown"];

        return {
          name: entry.symbol,
          label: `Sleeve ${index + 1}`,
          allocationPct,
          pnlUsd: inferredPnlUsd,
          riskContributionPct: inferredRiskPct,
          exposureUsd: entry.exposureUsd,
          turnoverPct,
          sharpe: sleeveSharpe,
          sortino: sleeveSortino,
          heatmap: heatAssets.map((asset, assetIndex) => ({
            asset,
            intensity: clamp(0.34 + assetIndex * 0.16 + allocationPct / 200, 0.22, 0.96),
          })),
        };
      });
    }

    const totalPnlUsd = realizedPnlUsd + unrealizedPnlUsd;
    const pnlAnchor = Math.abs(totalPnlUsd) > 1 ? totalPnlUsd : equityUsd * 0.0075;
    return SLEEVE_BLUEPRINT.map((item, index) => ({
      name: item.name,
      label: `Sleeve ${index + 1}`,
      allocationPct: item.allocationPct,
      pnlUsd: pnlAnchor * item.pnlShare * (item.name === "Volatility" ? 0.84 : 1),
      riskContributionPct: item.riskContributionPct,
      exposureUsd: grossExposureUsd * item.exposureShare,
      turnoverPct: item.turnoverPct,
      sharpe: item.sharpe,
      sortino: item.sortino,
      heatmap: item.heatmap.map((asset, assetIndex) => ({
        asset,
        intensity: clamp(0.36 + assetIndex * 0.15 + item.allocationPct / 100, 0.28, 0.98),
      })),
    }));
  }, [equityUsd, grossExposureUsd, realizedPnlUsd, unrealizedPnlUsd]);

  const sleeveIntelligence = useMemo(() => {
    const totalRiskContribution = Math.max(1, sleeves.reduce((sum, sleeve) => sum + sleeve.riskContributionPct, 0));
    const totalAllocation = Math.max(1, sleeves.reduce((sum, sleeve) => sum + sleeve.allocationPct, 0));
    return sleeves.map((sleeve, index) => {
      const healthScore = clamp(82 + sleeve.sharpe * 6 + sleeve.sortino * 4 - sleeve.turnoverPct * 0.08 - currentDrawdownPct * 1.9 - concentrationPct * 0.15, 18, 98);
      const riskDriftPct = clamp(Math.abs(sleeve.riskContributionPct - sleeve.allocationPct) + Math.max(0, leverageNow - 2) * 8, 0, 100);
      const mandateCompliancePct = clamp(100 - riskDriftPct - Math.max(0, currentDrawdownPct - 4) * 6 - Math.max(0, concentrationPct - 35) * 0.9, 5, 100);
      const targetAllocationPct = clamp((healthScore / 100) * 28 + sleeve.riskContributionPct * 0.2, 8, 34);
      const rebalancePct = Number((targetAllocationPct - sleeve.allocationPct).toFixed(1));
      const riskBudgetPct = Number(((sleeve.riskContributionPct / totalRiskContribution) * 100).toFixed(1));
      const drawdownContributionPct = Number((((sleeve.riskContributionPct / totalRiskContribution) * currentDrawdownPct)).toFixed(2));
      const rollingSharpe = Number((sleeve.sharpe - 0.14 + healthScore / 180).toFixed(2));
      const rollingSortino = Number((sleeve.sortino - 0.1 + healthScore / 160).toFixed(2));
      const strategyRows = sleeve.heatmap.slice(0, 3).map((entry, heatIndex) => ({
        name: `${sleeve.name} · ${entry.asset}`,
        pnlUsd: sleeve.pnlUsd * (0.22 + heatIndex * 0.12),
        riskPct: Number((sleeve.riskContributionPct * (0.24 + heatIndex * 0.11)).toFixed(1)),
      }));

      return {
        ...sleeve,
        healthScore,
        riskDriftPct,
        mandateCompliancePct,
        targetAllocationPct,
        rebalancePct,
        riskBudgetPct,
        drawdownContributionPct,
        rollingSharpe,
        rollingSortino,
        strategyRows,
        strategyBucket: `S-${index + 1}`,
        allocationWeight: sleeve.allocationPct / totalAllocation,
      };
    });
  }, [concentrationPct, currentDrawdownPct, leverageNow, sleeves]);

  const returnSeries = useMemo(() => buildReturnSeries(pnlSeries, equityUsd), [equityUsd, pnlSeries]);

  const allocatorReturnCards = useMemo(() => {
    const ytd = (latestPnlUsd / Math.max(equityUsd, 1)) * 100;
    const recentOutcomeValues = buildMetricSeries(recentOutcomes, ["created_at", "updated_at"], ["net_result_usd", "pnl_24h", "pnl_1h", "pnl_5m"], true);
    const mtd = recentOutcomeValues.slice(-10).reduce((sum, value) => sum + value, 0) / Math.max(equityUsd, 1) * 100;
    const wtd = recentOutcomeValues.slice(-5).reduce((sum, value) => sum + value, 0) / Math.max(equityUsd, 1) * 100;
    const rollingSharpe = buildRollingSharpeSeries(pnlSeries, equityUsd, 5).slice(-1)[0] || (Number.isFinite(sharpeRatio) ? sharpeRatio : 0);
    const rollingSortino = buildRollingSortinoSeries(pnlSeries, equityUsd, 5).slice(-1)[0] || 0;
    const realizedReturnPct = (returnSeries.reduce((sum, value) => sum + value, 0)) * 100;
    return [
      { label: "YTD", value: formatPct(ytd, 2) },
      { label: "MTD", value: formatPct(mtd || ytd, 2) },
      { label: "WTD", value: formatPct(wtd || ytd, 2) },
      { label: "Max DD", value: formatPct(maxDrawdownPct, 2) },
      { label: "Rolling Sharpe 30d", value: rollingSharpe.toFixed(2) },
      { label: "Rolling Sortino", value: rollingSortino.toFixed(2) },
      { label: "Realized return", value: formatPct(realizedReturnPct, 2) },
      { label: "Rolling volatility", value: formatPct(rollingVol30, 2) },
    ];
  }, [equityUsd, latestPnlUsd, maxDrawdownPct, pnlSeries, recentOutcomes, returnSeries, rollingVol30, sharpeRatio]);

  const assetClassExposure = useMemo(() => {
    if (symbolExposureRows.length > 0) {
      const defaultLiquidityScores = new Map(ASSET_CLASS_BLUEPRINT.map((item) => [item.label, item.liquidityScore]));
      const grouped = new Map<string, number>();
      const inferAssetClass = (symbol: string): string => {
        const normalized = symbol.toUpperCase();
        if (normalized.includes("BTC") || normalized.includes("ETH") || normalized.includes("SOL") || normalized.includes("USDT")) {
          return "Crypto";
        }
        if (normalized.includes("EUR") || normalized.includes("USD") || normalized.includes("JPY") || normalized.includes("GBP") || normalized.includes("CHF")) {
          return "FX";
        }
        if (normalized.includes("XAU") || normalized.includes("GOLD") || normalized.includes("SILV")) {
          return "Metals";
        }
        if (normalized.includes("SPX") || normalized.includes("NDX") || normalized.includes("DJI") || normalized.includes("INDEX")) {
          return "Indices";
        }
        if (normalized.includes("OIL") || normalized.includes("WTI") || normalized.includes("BRENT") || normalized.includes("NG")) {
          return "Commodities";
        }
        if (normalized.includes("CASH") || normalized.includes("HEDGE")) {
          return "Cash/Hedges";
        }
        return "Crypto";
      };

      for (const entry of symbolExposureRows) {
        const label = inferAssetClass(entry.symbol);
        grouped.set(label, (grouped.get(label) || 0) + entry.exposureUsd);
      }

      return ASSET_CLASS_BLUEPRINT.map((item) => {
        const exposureUsd = grouped.get(item.label) || 0;
        const exposurePct = grossExposureUsd > 0 ? (exposureUsd / grossExposureUsd) * 100 : item.exposurePct;
        const liquidityAdjustment = avgSlippageBps > 0
          ? clamp(12 - avgSlippageBps * 4 + (avgAvailableDepthUsd > 0 ? 8 : 0), -18, 14)
          : 0;
        return {
          ...item,
          exposurePct,
          exposureUsd,
          liquidityScore: clamp((defaultLiquidityScores.get(item.label) || item.liquidityScore) + liquidityAdjustment, 20, 99),
        };
      }).filter((item) => item.exposureUsd > 0 || item.exposurePct > 0);
    }

    return ASSET_CLASS_BLUEPRINT.map((item) => ({
      ...item,
      exposureUsd: grossExposureUsd * (item.exposurePct / 100),
    }));
  }, [avgAvailableDepthUsd, avgSlippageBps, grossExposureUsd, symbolExposureRows]);

  const rollingSharpeSeries = useMemo(() => {
    const built = buildRollingSharpeSeries(pnlSeries, equityUsd, 5);
    return built.length > 0 ? built : [sleeveIntelligence[0]?.rollingSharpe || 0];
  }, [equityUsd, pnlSeries, sleeveIntelligence]);
  const rollingSortinoSeries = useMemo(() => {
    const built = buildRollingSortinoSeries(pnlSeries, equityUsd, 5);
    return built.length > 0 ? built : [sleeveIntelligence[0]?.rollingSortino || 0];
  }, [equityUsd, pnlSeries, sleeveIntelligence]);
  const rollingVolSeries = useMemo(() => {
    const built = buildRollingVolatilitySeries(pnlSeries, equityUsd, 5);
    return built.length > 0 ? built : [rollingVol30];
  }, [equityUsd, pnlSeries, rollingVol30]);
  const rollingExposureSeries = useMemo(() => {
    return exposureSeries.length > 0 ? exposureSeries : [grossExposureUsd];
  }, [exposureSeries, grossExposureUsd]);
  const icAutoTags = useMemo(() => inferIcTags(notes), [notes]);
  const weeklyIcSummary = useMemo(() => (
    `Weekly IC summary: regime ${String(regimeResult?.regime || riskState).toLowerCase()}, drawdown ${formatPct(currentDrawdownPct, 2)}, mandate usage ${formatPct(mandateUsagePct, 1)}, strongest sleeve ${sleeveIntelligence.slice().sort((a, b) => b.healthScore - a.healthScore)[0]?.name || "n/a"}.`
  ), [currentDrawdownPct, mandateUsagePct, regimeResult, riskState, sleeveIntelligence]);
  const monthlyAllocatorSummary = useMemo(() => (
    `Monthly allocator summary: YTD ${allocatorReturnCards[0]?.value || "0.00%"}, max DD ${formatPct(maxDrawdownPct, 2)}, rolling vol ${formatPct(rollingVol30, 2)}, concentration ${formatPct(concentrationPct, 1)}, liquidity ${assetClassExposure.filter((item) => item.liquidityScore >= 75).length}/${assetClassExposure.length} asset classes liquid.`
  ), [allocatorReturnCards, assetClassExposure, concentrationPct, maxDrawdownPct, rollingVol30]);
  const institutionalTimeline = useMemo(() => {
    const rows: Array<{ ts: number; label: string; tag: string; pnl: string; dd: string; exposure: string }> = [];

    investorReports.slice(0, 2).forEach((report, index) => {
      const summary = report && typeof report.summary === "object" ? report.summary as JsonMap : null;
      const performance = summary && typeof summary.performance_summary === "object" ? summary.performance_summary as JsonMap : null;
      rows.push({
        ts: resolveEntryTimestampMs(report, ["generated_at", "created_at", "report_month"]) || (10_000 - index),
        label: `Investor report ${String(report.report_month || report.report_type || index + 1)}`,
        tag: String(report.status || report.report_type || "published"),
        pnl: formatMoney(toNumber(performance?.realized_pnl_usd, latestPnlUsd)),
        dd: formatPct(toNumber(performance?.max_drawdown_pct, currentDrawdownPct), 2),
        exposure: formatMoney(toNumber(summary?.gross_exposure_usd, grossExposureUsd)),
      });
    });

    recentOutcomes.slice(0, 3).forEach((outcome, index) => {
      rows.push({
        ts: resolveEntryTimestampMs(outcome, ["created_at", "updated_at", "timestamp"]) || (9_000 - index),
        label: `Outcome ${String(outcome.symbol || outcome.strategy_id || index + 1)}`,
        tag: String(outcome.status || outcome.decision || "pending"),
        pnl: formatMoney(firstFiniteNumber(outcome, ["net_result_usd", "pnl_24h", "pnl_1h", "pnl_5m"], 0)),
        dd: formatPct(currentDrawdownPct, 2),
        exposure: formatMoney(firstFiniteNumber(outcome, ["notional_usd", "requested_notional_usd"], netExposureUsd)),
      });
    });

    recentExecutionTelemetry.slice(0, 2).forEach((telemetry, index) => {
      rows.push({
        ts: resolveEntryTimestampMs(telemetry, ["ts_fill_final", "ts_decision", "created_at"]) || (8_000 - index),
        label: `Execution ${String(telemetry.symbol || telemetry.route || index + 1)}`,
        tag: `${String(telemetry.route || telemetry.venue || "route")} · ${toNumber(telemetry.latency_e2e_ms, toNumber(telemetry.latency_ms, 0)).toFixed(0)}ms`,
        pnl: formatMoney(firstFiniteNumber(telemetry, ["expected_pnl_usd", "realized_pnl_usd"], expectancyUsd)),
        dd: formatPct(currentDrawdownPct, 2),
        exposure: formatMoney(firstFiniteNumber(telemetry, ["available_depth_usd", "notional_usd"], grossExposureUsd * 0.05)),
      });
    });

    return rows
      .sort((left, right) => right.ts - left.ts)
      .slice(0, 4)
      .map(({ ts: _ts, ...entry }) => entry);
  }, [currentDrawdownPct, expectancyUsd, grossExposureUsd, investorReports, latestPnlUsd, netExposureUsd, recentExecutionTelemetry, recentOutcomes]);
  const factorAttribution = useMemo(() => {
    if (effectiveAttributionRows.length > 0) {
      return effectiveAttributionRows.slice(0, 5).map((row, index) => ({
        label: String(row.factor || row.strategy_id || row.symbol || row.scope_id || `factor-${index + 1}`),
        value: formatMoney(firstFiniteNumber(row, ["realized_pnl_usd", "unrealized_pnl_usd", "pnl_usd", "contribution_usd"], 0)),
      }));
    }
    return sleeves.slice(0, 5).map((item) => ({ label: item.name, value: formatMoney(item.pnlUsd) }));
  }, [effectiveAttributionRows, sleeves]);
  const stressRegimes = useMemo(() => {
    if (reportedBreaches.length > 0) {
      return reportedBreaches.slice(0, 5).map((row, index) => ({
        label: String(row.rule_name || row.metric || row.breach_type || `breach-${index + 1}`),
        dd: formatPct(firstFiniteNumber(row, ["drawdown_pct", "value_pct", "severity_pct"], currentDrawdownPct), 2),
        action: String(row.action || row.status || row.message || "Review / mitigate"),
      }));
    }
    return [
      { label: "2008", dd: formatPct(maxDrawdownPct * 1.64, 2), action: "Raise hedge ratio" },
      { label: "COVID", dd: formatPct(maxDrawdownPct * 1.28, 2), action: "Cut leverage / widen cash sleeve" },
      { label: "Flash crash", dd: formatPct(maxDrawdownPct * 0.92, 2), action: "Pause fast sleeves" },
      { label: "Vol spike", dd: formatPct(maxDrawdownPct * 1.12, 2), action: "Reduce directional beta" },
      { label: "Liquidity crunch", dd: formatPct(maxDrawdownPct * 1.36, 2), action: "Favor liquid venues only" },
    ];
  }, [currentDrawdownPct, maxDrawdownPct, reportedBreaches]);
  const scenarioEngineRows = useMemo(() => {
    if (symbolExposureRows.length > 0) {
      return symbolExposureRows.slice(0, 4).map((entry, index) => ({
        label: index === 0 ? `-5% ${entry.symbol}` : index === 1 ? `+2% funding ${entry.symbol}` : `${entry.symbol} liquidity shock`,
        impact: formatMoney(-(entry.exposureUsd * (index === 0 ? 0.05 : index === 1 ? 0.02 : 0.03))),
        response: index === 0
          ? "Trim gross / add hedge"
          : index === 1
            ? "Reprice carry sleeve"
            : "Route to deepest venue only",
      }));
    }
    return [
      { label: "+2% rates", impact: formatMoney(-(grossExposureUsd * 0.009)), response: "Reduce duration / metals beta" },
      { label: "-5% BTC", impact: formatMoney(-(grossExposureUsd * 0.014)), response: "Increase hedge sleeve" },
      { label: "+10% VIX", impact: formatMoney(-(grossExposureUsd * 0.008)), response: "Shift to vol sleeve" },
      { label: "USD shock", impact: formatMoney(-(grossExposureUsd * 0.006)), response: "Trim FX directional gross" },
    ];
  }, [grossExposureUsd, symbolExposureRows]);
  const temporalHeatmap = useMemo(() => {
    const telemetryRows = [...recentExecutionTelemetry]
      .sort((left, right) => resolveEntryTimestampMs(left, ["ts_fill_final", "ts_decision", "created_at"]) - resolveEntryTimestampMs(right, ["ts_fill_final", "ts_decision", "created_at"]))
      .slice(-5);

    if (telemetryRows.length > 0) {
      return telemetryRows.map((row, index) => {
        const depth = firstFiniteNumber(row, ["available_depth_usd"], 0);
        const latency = firstFiniteNumber(row, ["latency_e2e_ms", "latency_ms"], avgLatencyMs);
        const slippage = firstFiniteNumber(row, ["realized_slippage_bps", "slippage_real_bps"], avgSlippageBps);
        const label = String(row.symbol || row.route || `T-${index + 1}`);
        return {
          label,
          values: [
            clamp(depth / Math.max(avgAvailableDepthUsd || depth || 1, 1), 0.08, 1),
            clamp(1 - latency / Math.max(avgLatencyMs || latency || 1, 1), 0.08, 1),
            clamp(1 - slippage / Math.max(avgSlippageBps || slippage || 1, 1), 0.08, 1),
            clamp((exposureSeries[Math.min(index, exposureSeries.length - 1)] || grossExposureUsd) / Math.max(grossExposureUsd, 1), 0.08, 1),
            clamp(1 - (drawdownSeries[Math.min(index, drawdownSeries.length - 1)] || currentDrawdownPct) / Math.max(mandateMaxDrawdownPct, 1), 0.08, 1),
          ],
        };
      });
    }

    return [
      { label: "W-4", values: [0.48, 0.52, 0.44, 0.39, 0.58] },
      { label: "W-3", values: [0.54, 0.49, 0.41, 0.45, 0.61] },
      { label: "W-2", values: [0.59, 0.51, 0.46, 0.38, 0.68] },
      { label: "W-1", values: [0.63, 0.55, 0.49, 0.41, 0.71] },
      { label: "Now", values: [0.68, 0.58, 0.53, 0.36, 0.76] },
    ];
  }, [avgAvailableDepthUsd, avgLatencyMs, avgSlippageBps, currentDrawdownPct, drawdownSeries, exposureSeries, grossExposureUsd, mandateMaxDrawdownPct, recentExecutionTelemetry]);
  const liquidityProfileRows = useMemo(() => assetClassExposure.map((item) => ({
    label: item.label,
    value: `${item.liquidityScore}/100`,
  })), [assetClassExposure]);
  const fundEngineRecommendations = useMemo(() => ([
    { label: "Position sizing engine", value: `Target gross ${formatRatio(Math.min(2.4, leverageNow * 0.92))}` },
    { label: "Hedging engine", value: riskState === "Risk-off" ? "Increase hedge sleeve / cash overlay" : "Keep light hedge overlay" },
    { label: "Volatility targeting", value: `Target vol ${formatPct(Math.max(5.5, rollingVol30 * 0.88), 2)}` },
    { label: "Beta neutralisation", value: concentrationPct > 40 ? "Needed" : "Optional" },
    { label: "Risk parity", value: sleeveIntelligence.slice().sort((a, b) => a.riskDriftPct - b.riskDriftPct)[0]?.name || "n/a" },
    { label: "Execution hygiene", value: `${tradeCount} fills, ${avgLatencyMs.toFixed(0)}ms avg latency, ${avgSlippageBps.toFixed(2)}bps slip` },
    { label: "Portfolio optimizer", value: reportedBreaches.length > 0 ? `${reportedBreaches.length} active breaches to remediate` : sleeveIntelligence.some((item) => item.rebalancePct > 2) ? "Rebalance candidates detected" : "Portfolio near target" },
  ]), [avgLatencyMs, avgSlippageBps, concentrationPct, leverageNow, reportedBreaches.length, riskState, rollingVol30, sleeveIntelligence, tradeCount]);

  const liveRiskCards = [
    { label: "Risk regime", value: riskState, tone: riskState === "Risk-on" ? "good" : riskState === "Balanced" ? "warn" : "metric" },
    { label: "Leverage", value: formatRatio(leverageNow), tone: leverageNow <= 2 ? "good" : leverageNow <= 2.8 ? "warn" : "metric" },
    { label: "Mandate usage", value: formatPct(mandateUsagePct), tone: mandateUsagePct <= 70 ? "good" : mandateUsagePct <= 88 ? "warn" : "metric" },
    { label: "Distance to max DD", value: formatPct(distanceToMaxDdPct), tone: distanceToMaxDdPct >= 3 ? "good" : distanceToMaxDdPct >= 1.5 ? "warn" : "metric" },
    { label: "Risk budget left", value: formatPct(riskBudgetRemainingPct), tone: riskBudgetRemainingPct >= 35 ? "good" : riskBudgetRemainingPct >= 18 ? "warn" : "metric" },
    { label: "Concentration", value: formatPct(concentrationPct), tone: concentrationPct <= 35 ? "good" : concentrationPct <= 50 ? "warn" : "metric" },
  ];

  const positionHeatmap = useMemo(() => {
    if (symbolExposureRows.length > 0) {
      const maxExposure = Math.max(...symbolExposureRows.map((entry) => entry.exposureUsd), 1);
      return symbolExposureRows.slice(0, 8).map((entry) => ({
        label: entry.symbol,
        intensity: clamp(entry.exposureUsd / maxExposure, 0.12, 0.98),
      }));
    }
    return [
      { label: "BTC", intensity: 0.88 },
      { label: "ETH", intensity: 0.72 },
      { label: "EURUSD", intensity: 0.54 },
      { label: "XAUUSD", intensity: 0.62 },
      { label: "DXY basket", intensity: 0.36 },
      { label: "Crude", intensity: 0.44 },
      { label: "SPX", intensity: 0.58 },
      { label: "Cash hedge", intensity: 0.24 },
    ];
  }, [symbolExposureRows]);

  const stressTests = [
    { label: "Stress test", value: String(backtestResult?.resilience_score || "queued") },
    { label: "Scenario analysis", value: String(backtestResult?.scenario || scenario) },
    { label: "Expected max DD", value: String(backtestResult?.expected_max_drawdown || `${(maxDrawdownPct * 1.18).toFixed(2)}%`) },
    { label: "Liquidity profile", value: `${assetClassExposure.filter((item) => item.liquidityScore >= 75).length}/${assetClassExposure.length} sleeves liquid` },
  ];

  const attributionRows = effectiveAttributionRows.length > 0
    ? effectiveAttributionRows.slice(0, 6).map((item, index) => ({
      label: String(item.strategy_id || item.symbol || item.venue || `scope-${index + 1}`),
      value: formatMoney(toNumber(item.realized_pnl_usd, toNumber(item.unrealized_pnl_usd, 0))),
    }))
    : sleeves.slice(0, 5).map((item) => ({ label: item.name, value: formatMoney(item.pnlUsd) }));

  const showOverview = activeTab === "overview";
  const showSleeves = activeTab === "overview" || activeTab === "sleeves";
  const showIcNotes = activeTab === "overview" || activeTab === "ic-notes";
  const showAllocator = activeTab === "overview" || activeTab === "allocator";
  const showRisk = activeTab === "overview" || activeTab === "risk";

  return (
    <main className="shell txt-page-shell">
      <section className="hero txt-page-hero-grid" style={{ gridTemplateColumns: "1.3fr 1fr" }}>
        <div className="panel txt-page-hero">
          <div className="eyebrow">Fund Manager Desk <HelpHint text="Desk hedge fund pour piloter mandat, sleeves, IC notes, risk overlay et allocator reporting au meme endroit." examples={["Commence ici avec le mandat et la discipline, puis passe sur Sleeves pour couper ou renforcer les poches de risque.", "Avant un allocator call: ouvre Allocator pour verifier perf, drawdown, attribution et scenario analysis."]} /></div>
          <h1 className="title" style={{ fontSize: 34 }}>Hedge Fund Manager Workspace</h1>
          <p className="subtle">Un cockpit buy-side structure pour ecrire le mandat, cadrer le regime, piloter les sleeves, garder la memoire IC et sortir un reporting allocator credible sans quitter le desk.</p>
          <TxtMiniGuide
            title="Guide Fund Manager"
            what="Une surface institutionnelle pour mandat, risk framework, sleeves, IC notes, allocator pack et connexions venues."
            why="Eviter de disperser le travail entre terminal, connecteurs, incidents et reporting quand on pilote un book multi-strategie."
            example="Le matin: valide le mandat, stress-teste le scenario geopolitique, ajuste les sleeves, puis envoie l'execution sur le hub broker/exchange/wallet adapte."
            terms={["brokers", "allocation"]}
          />
          <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 10 }}>
            <span className="pill">Mandate: {notes.mandateObjective.split(".")[0]}</span>
            <span className="pill">AUM {formatMoney(equityUsd)}</span>
            <span className="pill">DD {formatPct(currentDrawdownPct, 2)}</span>
            <span className="pill">Leverage {formatRatio(leverageNow)}</span>
          </div>
          <p style={{ marginTop: 12 }}>
            <Link href="/terminal">Trading Terminal</Link>
            {" | "}
            <Link href="/connectors">Execution & Connectors</Link>
            {" | "}
            <Link href="/connections">Client Connection Hub</Link>
            {" | "}
            <Link href="/ai">AI Desk</Link>
          </p>
          {error ? <p className="warn">{error}</p> : null}
        </div>

        <div className="panel">
          <div className="eyebrow">Institutional Header</div>
          <div className="row"><span>Fund objective</span><span>{notes.mandateObjective.split(".")[0]}</span></div>
          <div className="row"><span>Equity / AUM proxy</span><span>{formatMoney(equityUsd)}</span></div>
          <div className="row"><span>Gross exposure</span><span>{formatMoney(grossExposureUsd)}</span></div>
          <div className="row"><span>Net exposure</span><span>{formatMoney(netExposureUsd)}</span></div>
          <div className="row"><span>Current leverage</span><span>{formatRatio(leverageNow)}</span></div>
          <div className="row"><span>Current drawdown</span><span>{formatPct(currentDrawdownPct, 2)}</span></div>
          <div className="row"><span>Mandate usage</span><span>{formatPct(mandateUsagePct, 1)}</span></div>
          <div className="row"><span>Connectors healthy</span><span>{connectors.filter((item) => Boolean(item.healthy)).length}/{connectors.length}</span></div>
        </div>
      </section>

      <section className="grid" style={{ marginTop: 16, gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
        <SparklineCard title="Mini PnL chart" value={formatMoney(realizedPnlUsd + unrealizedPnlUsd)} detail="Allocator quick read for pnl trajectory and discipline." series={pnlSeries} tone="#38bdf8" />
        <SparklineCard title="Mini exposure chart" value={formatMoney(grossExposureUsd)} detail="Exposure glide path versus current mandate and leverage budget." series={exposureSeries} tone="#34d399" />
        <SparklineCard title="Mini DD chart" value={formatPct(currentDrawdownPct, 2)} detail="Instant view of drawdown pressure against max DD threshold." series={drawdownSeries} tone="#f59e0b" />
      </section>

      <section className="grid" style={{ marginTop: 16, gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
        <SparklineCard title="Rolling volatility" value={formatPct(rollingVol30, 2)} detail="Volatility glide path for allocator and mandate control." series={rollingVolSeries} tone="#22c55e" />
        <SparklineCard title="Rolling Sharpe" value={(rollingSharpeSeries[rollingSharpeSeries.length - 1] || 0).toFixed(2)} detail="Sharpe persistence across sleeves." series={rollingSharpeSeries} tone="#60a5fa" />
        <SparklineCard title="Rolling Sortino" value={(rollingSortinoSeries[rollingSortinoSeries.length - 1] || 0).toFixed(2)} detail="Downside-adjusted quality across sleeves." series={rollingSortinoSeries} tone="#a78bfa" />
        <SparklineCard title="Rolling exposure" value={formatMoney(rollingExposureSeries[rollingExposureSeries.length - 1] || grossExposureUsd)} detail="Gross exposure drift against current leverage policy." series={rollingExposureSeries} tone="#14b8a6" />
      </section>

      <section className="grid" style={{ marginTop: 16, gridTemplateColumns: "1.15fr 0.85fr" }}>
        <div className="panel">
          <div className="eyebrow">Capital Integration <HelpHint text="Pont entre Fund Manager et Live Capital: capital réel par sleeve, drift vs cible, cashflows, realised vs latent et mapping poches -> sleeves." examples={["Une sleeve peut être bien notée côté modèle mais sous-capitalisée côté capital réel.", "Le cash brut et la valeur plateforme équivalente doivent rester séparés pour éviter toute ambiguïté allocator."]} /></div>
          {capitalIntegrationSleeves.length === 0 ? <p className="subtle" style={{ marginTop: 10 }}>Aucune intégration Live Capital active sur ce portefeuille. Attache des comptes canonisés avec `capital_sleeve` pour voir le capital réel par sleeve.</p> : null}
          {capitalIntegrationSleeves.slice(0, 5).map((row) => (
            <div key={String(row.sleeve || "unassigned")} className="panel" style={{ marginTop: 12, borderRadius: 14 }}>
              <div className="row"><span>{String(row.sleeve || "unassigned")}</span><span>{formatMoney(toNumber(row.actual_equivalent_usd, 0))} eq / {formatMoney(toNumber(row.actual_raw_cash_usd, 0))} cash</span></div>
              <div className="row"><span>Allocation réelle vs cible</span><span>{formatPct(toNumber(row.actual_allocation_pct, 0), 1)} / {formatPct(toNumber(row.target_allocation_pct, 0), 1)}</span></div>
              <div className="row"><span>Drift</span><span>{formatPct(toNumber(row.drift_pct, 0), 1)}</span></div>
              <div className="row"><span>PnL réalisé / latent</span><span>{formatMoney(toNumber(row.realized_pnl_usd, 0))} / {formatMoney(toNumber(row.unrealized_pnl_usd, 0))}</span></div>
              <div className="row"><span>Cashflow net / funding</span><span>{formatMoney(toNumber(row.net_external_cashflow_usd, 0))} / {formatMoney(toNumber(row.funding_fee_usd, 0))}</span></div>
              <div className="row"><span>Venues</span><span>{Array.isArray(row.venues) && row.venues.length > 0 ? row.venues.join(", ") : "n/a"}</span></div>
              {Array.isArray(row.pocket_breakdown) && row.pocket_breakdown.length > 0 ? (
                <div style={{ marginTop: 10 }}>
                  {row.pocket_breakdown.map((pocket, index) => (
                    <div key={`${String(row.sleeve || "sleeve")}-${String((pocket as JsonMap).pocket || index)}`} className="row">
                      <span>{String((pocket as JsonMap).pocket || "other")}</span>
                      <span>{formatMoney(toNumber((pocket as JsonMap).equivalent_usd, 0))} eq / {formatMoney(toNumber((pocket as JsonMap).raw_cash_usd, 0))} cash</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>

        <div className="panel">
          <div className="eyebrow">Live Capital Totals</div>
          <div className="row"><span>Valeur plateforme</span><span>{formatMoney(toNumber(capitalIntegrationTotals?.actual_equivalent_usd, equityUsd))}</span></div>
          <div className="row"><span>Cash brut</span><span>{formatMoney(toNumber(capitalIntegrationTotals?.actual_raw_cash_usd, 0))}</span></div>
          <div className="row"><span>Inventaire non-cash</span><span>{formatMoney(toNumber(capitalIntegrationTotals?.inventory_usd, 0))}</span></div>
          <div className="row"><span>Cap cible alloué</span><span>{formatMoney(toNumber(capitalIntegrationTotals?.target_cap_usd, 0))}</span></div>
          <div className="row"><span>Comptes live reliés</span><span>{toNumber(capitalIntegrationTotals?.account_count, 0)}</span></div>
          <p className="subtle" style={{ marginTop: 12 }}>Ce bloc ferme le gap entre modèle et capital réel: tu vois enfin les sleeves réellement financées, leur drift et le vrai mix cash brut vs valeur équivalente plateforme.</p>
        </div>
      </section>

      <section className="panel" style={{ marginTop: 16 }}>
        <div className="eyebrow">Desk Navigation</div>
        <div className="grid" style={{ gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 12, marginTop: 12 }}>
          {TAB_OPTIONS.map((tab) => (
            <TabButton key={tab.id} active={activeTab === tab.id} label={tab.label} summary={tab.summary} onClick={() => setActiveTab(tab.id)} />
          ))}
        </div>
      </section>

      {showOverview ? (
        <>
          <section className="grid" style={{ marginTop: 16, gridTemplateColumns: "1.15fr 0.85fr" }}>
            <div className="panel">
              <div className="eyebrow">Fund Mandate & Discipline <HelpHint text="C'est la base du reporting allocator et du controle du desk." examples={["Un allocator lit d'abord l'objectif, les contraintes et le risk framework avant toute courbe de performance.", "Si le mandat est flou, le desk peut gagner de l'argent sans etre institutionnellement investissable."]} /></div>
              <div className="grid" style={{ marginTop: 12, gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div>
                  <div className="subtle" style={{ marginBottom: 6 }}>Objectif du fonds</div>
                  <textarea rows={4} value={notes.mandateObjective} onChange={(event) => updateNote("mandateObjective", event.target.value)} />
                </div>
                <div>
                  <div className="subtle" style={{ marginBottom: 6 }}>Contraintes</div>
                  <textarea rows={4} value={notes.mandateConstraints} onChange={(event) => updateNote("mandateConstraints", event.target.value)} />
                </div>
                <div>
                  <div className="subtle" style={{ marginBottom: 6 }}>Horizon</div>
                  <textarea rows={4} value={notes.mandateHorizon} onChange={(event) => updateNote("mandateHorizon", event.target.value)} />
                </div>
                <div>
                  <div className="subtle" style={{ marginBottom: 6 }}>Univers d'investissement</div>
                  <textarea rows={4} value={notes.mandateUniverse} onChange={(event) => updateNote("mandateUniverse", event.target.value)} />
                </div>
              </div>
              <div style={{ marginTop: 12 }}>
                <div className="subtle" style={{ marginBottom: 6 }}>Risk framework</div>
                <textarea rows={4} value={notes.mandateRiskFramework} onChange={(event) => updateNote("mandateRiskFramework", event.target.value)} />
              </div>
            </div>

            <div className="panel">
              <div className="eyebrow">Portfolio Pulse</div>
              <div className="row"><span>Risk regime</span><span>{riskState}</span></div>
              <div className="row"><span>Concentration</span><span>{formatPct(concentrationPct, 1)}</span></div>
              <div className="row"><span>Risk budget left</span><span>{formatPct(riskBudgetRemainingPct, 1)}</span></div>
              <div className="row"><span>Latest report</span><span>{String(latestInvestorReport?.report_month || "-")}</span></div>
              <div className="row"><span>Stress scenario</span><span>{String(backtestResult?.scenario || scenario)}</span></div>
              <div className="row"><span>Allocator narrative</span><span>{notes.allocatorNarrative.split(".")[0]}</span></div>
            </div>
          </section>

          <section className="grid" style={{ marginTop: 16, gridTemplateColumns: "1fr 1fr" }}>
            <div className="panel">
              <div className="eyebrow">Investment Thesis</div>
              <textarea rows={8} value={notes.investmentThesis} onChange={(event) => updateNote("investmentThesis", event.target.value)} placeholder="Write the core trade thesis, invalidation, sizing, catalyst and exit conditions." />
            </div>
            <div className="panel">
              <div className="eyebrow">Geopolitical Map</div>
              <textarea rows={8} value={notes.geopoliticalMap} onChange={(event) => updateNote("geopoliticalMap", event.target.value)} placeholder="Map central banks, geopolitical shocks, commodities, rates and transmission to portfolio sleeves." />
            </div>
          </section>

          <section className="grid" style={{ marginTop: 16, gridTemplateColumns: "1fr 1fr" }}>
            <div className="panel">
              <div className="eyebrow">Regime Policy by Horizon <HelpHint text="Cadre clair pour separer scalping, intraday, swing, weekly et event-driven." examples={["Scalping: only when market bus, spread and venue health are clean.", "Swing and weekly: tie sizing to macro invalidation and geopolitical resilience, not microstructure alone."]} /></div>
              <div className="form-grid" style={{ marginTop: 12 }}>
                <input type="number" step="0.01" value={trendScore} onChange={(event) => setTrendScore(Number(event.target.value || 0))} placeholder="trend_score" />
                <input type="number" step="0.001" value={realizedVolatility} onChange={(event) => setRealizedVolatility(Number(event.target.value || 0))} placeholder="realized_volatility" />
                <input type="number" step="0.01" value={sentimentScore} onChange={(event) => setSentimentScore(Number(event.target.value || 0))} placeholder="sentiment_score" />
                <button type="button" onClick={() => detectRegime()} disabled={busy}>{busy ? "Analyse..." : "Detect regime"}</button>
              </div>
              {regimeResult ? (
                <div className="panel" style={{ marginTop: 12, borderRadius: 12 }}>
                  <div className="row"><span>Regime</span><span>{String(regimeResult.regime || "-")}</span></div>
                  <div className="row"><span>Confidence</span><span>{String(regimeResult.confidence || "-")}</span></div>
                </div>
              ) : null}
              <textarea rows={6} style={{ marginTop: 12 }} value={notes.regimePolicy} onChange={(event) => updateNote("regimePolicy", event.target.value)} placeholder="Write the policy for Perception V5 -> regime -> policy by horizon -> execution permissions." />
            </div>

            <div className="panel">
              <div className="eyebrow">Geopolitical Stress Test</div>
              <div className="form-grid" style={{ marginTop: 12 }}>
                <select value={scenario} onChange={(event) => setScenario(event.target.value)}>
                  {DEFAULT_SCENARIOS.map((item) => (
                    <option key={item} value={item}>{item}</option>
                  ))}
                </select>
                <button type="button" onClick={() => runBacktest()} disabled={busy}>{busy ? "Stress..." : "Run geopolitical backtest"}</button>
              </div>
              {backtestResult ? (
                <div className="panel" style={{ marginTop: 12, borderRadius: 12 }}>
                  <div className="row"><span>Resilience</span><span>{String(backtestResult.resilience_score || "-")}</span></div>
                  <div className="row"><span>Expected max DD</span><span>{String(backtestResult.expected_max_drawdown || "-")}</span></div>
                  <div className="row"><span>Scenario</span><span>{String(backtestResult.scenario || scenario)}</span></div>
                </div>
              ) : null}
              <textarea rows={6} style={{ marginTop: 12 }} value={notes.opsChecklist} onChange={(event) => updateNote("opsChecklist", event.target.value)} placeholder="Write the live checklist: venues, backup venues, wallet/custody, governance, incident response." />
            </div>
          </section>
        </>
      ) : null}

      {showSleeves ? (
        <section className="panel" style={{ marginTop: 16 }}>
          <div className="eyebrow">Sleeves Architecture <HelpHint text="Tu peux isoler les strategies gagnantes, couper les mauvaises et allouer dynamiquement." examples={["Directional gagne mais consomme trop de mandate usage: hedge ou baisse l'allocation.", "AI sleeve gagne avec faible risk contribution: augmente-la si le risk budget le permet."]} /></div>
          <div className="grid" style={{ marginTop: 12, gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
            {sleeveIntelligence.map((sleeve) => (
              <div className="panel" key={sleeve.name} style={{ borderRadius: 16 }}>
                <div className="row"><span>{sleeve.label}</span><span className="pill">{sleeve.name}</span></div>
                <div className="row"><span>Allocation</span><span>{formatPct(sleeve.allocationPct, 1)}</span></div>
                <div className="row"><span>Target allocation</span><span>{formatPct(sleeve.targetAllocationPct, 1)}</span></div>
                <div className="row"><span>Auto-rebalance</span><span>{sleeve.rebalancePct >= 0 ? "+" : ""}{formatPct(sleeve.rebalancePct, 1)}</span></div>
                <div className="row"><span>Risk budget</span><span>{formatPct(sleeve.riskBudgetPct, 1)}</span></div>
                <div className="row"><span>DD contribution</span><span>{formatPct(sleeve.drawdownContributionPct, 2)}</span></div>
                <div className="row"><span>PnL</span><span>{formatMoney(sleeve.pnlUsd)}</span></div>
                <div className="row"><span>Risk contribution</span><span>{formatPct(sleeve.riskContributionPct, 1)}</span></div>
                <div className="row"><span>Exposure</span><span>{formatMoney(sleeve.exposureUsd)}</span></div>
                <div className="row"><span>Turnover</span><span>{formatPct(sleeve.turnoverPct, 0)}</span></div>
                <div className="row"><span>Sharpe / Sortino</span><span>{sleeve.sharpe.toFixed(2)} / {sleeve.sortino.toFixed(2)}</span></div>
                <div className="row"><span>Rolling Sharpe / Sortino</span><span>{sleeve.rollingSharpe.toFixed(2)} / {sleeve.rollingSortino.toFixed(2)}</span></div>
                <div className="row"><span>Sleeve health score</span><span>{formatPct(sleeve.healthScore, 0)}</span></div>
                <div className="row"><span>Risk drift</span><span>{formatPct(sleeve.riskDriftPct, 1)}</span></div>
                <div className="row"><span>Mandate compliance</span><span>{formatPct(sleeve.mandateCompliancePct, 1)}</span></div>
                <div style={{ marginTop: 12, padding: 10, borderRadius: 12, background: resolveScoreTone(sleeve.healthScore) }}>
                  <div className="subtle">Sleeve decision lane</div>
                  <div style={{ marginTop: 4, fontWeight: 700 }}>
                    {sleeve.healthScore >= 75 ? "Accumulate / let run" : sleeve.healthScore >= 55 ? "Hold / monitor" : "De-risk / cut exposure"}
                  </div>
                </div>
                <div style={{ marginTop: 12 }}>
                  <div className="subtle" style={{ marginBottom: 8 }}>Asset heatmap</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {sleeve.heatmap.map((entry) => (
                      <span
                        key={`${sleeve.name}-${entry.asset}`}
                        style={{
                          padding: "7px 10px",
                          borderRadius: 999,
                          border: "1px solid rgba(56, 189, 248, 0.18)",
                          background: `rgba(56, 189, 248, ${entry.intensity * 0.32})`,
                        }}
                      >
                        {entry.asset}
                      </span>
                    ))}
                  </div>
                </div>
                <div style={{ marginTop: 12 }}>
                  <div className="subtle" style={{ marginBottom: 8 }}>Strategy attribution</div>
                  {sleeve.strategyRows.map((row) => (
                    <div className="row" key={row.name}>
                      <span>{row.name}</span>
                      <span>{formatMoney(row.pnlUsd)} · {formatPct(row.riskPct, 1)}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {showIcNotes ? (
        <section className="panel" style={{ marginTop: 16 }}>
          <div className="eyebrow">IC Notes / Investment Committee <HelpHint text="Memoire du fonds: hypotheses, decisions, rationale et changements de mandat." examples={["Chaque revue hebdo doit expliquer ce qui a marche, ce qui a casse et quelle decision d'allocation en decoule.", "Si le mandat change ou si le levier max baisse, ecris-le ici avant execution."]} /></div>
          <div className="grid" style={{ marginTop: 12, gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
            <div>
              <div className="subtle" style={{ marginBottom: 6 }}>Structured notes</div>
              <textarea rows={6} value={notes.icStructuredNotes} onChange={(event) => updateNote("icStructuredNotes", event.target.value)} />
            </div>
            <div>
              <div className="subtle" style={{ marginBottom: 6 }}>Committee decisions</div>
              <textarea rows={6} value={notes.icCommitteeDecisions} onChange={(event) => updateNote("icCommitteeDecisions", event.target.value)} />
            </div>
            <div>
              <div className="subtle" style={{ marginBottom: 6 }}>Rationales</div>
              <textarea rows={6} value={notes.icRationales} onChange={(event) => updateNote("icRationales", event.target.value)} />
            </div>
            <div>
              <div className="subtle" style={{ marginBottom: 6 }}>Mandate changes</div>
              <textarea rows={6} value={notes.icMandateChanges} onChange={(event) => updateNote("icMandateChanges", event.target.value)} />
            </div>
            <div>
              <div className="subtle" style={{ marginBottom: 6 }}>Weekly / monthly reviews</div>
              <textarea rows={6} value={notes.icReviewCadence} onChange={(event) => updateNote("icReviewCadence", event.target.value)} />
            </div>
            <div>
              <div className="subtle" style={{ marginBottom: 6 }}>Allocation decisions</div>
              <textarea rows={6} value={notes.icAllocationDecisions} onChange={(event) => updateNote("icAllocationDecisions", event.target.value)} />
            </div>
          </div>
          <div className="grid" style={{ marginTop: 16, gridTemplateColumns: "0.9fr 1.1fr" }}>
            <div className="panel" style={{ borderRadius: 14 }}>
              <div className="eyebrow">Automatic IC tags</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
                {icAutoTags.map((tag) => (
                  <span key={tag} className="pill">{tag}</span>
                ))}
                {icAutoTags.length === 0 ? <span className="subtle">No tags detected yet.</span> : null}
              </div>
              <div style={{ marginTop: 16 }}>
                <div className="subtle" style={{ marginBottom: 6 }}>Weekly IC summary</div>
                <div style={{ padding: 12, borderRadius: 12, background: "rgba(15, 23, 42, 0.72)" }}>{weeklyIcSummary}</div>
              </div>
              <div style={{ marginTop: 12 }}>
                <div className="subtle" style={{ marginBottom: 6 }}>Monthly allocator summary</div>
                <div style={{ padding: 12, borderRadius: 12, background: "rgba(15, 23, 42, 0.72)" }}>{monthlyAllocatorSummary}</div>
              </div>
            </div>
            <div className="panel" style={{ borderRadius: 14 }}>
              <div className="eyebrow">Institutional timeline</div>
              {institutionalTimeline.map((entry) => (
                <div key={entry.label} style={{ display: "grid", gridTemplateColumns: "1.2fr 0.8fr 0.7fr 0.6fr 0.8fr", gap: 10, padding: "10px 0", borderBottom: "1px solid rgba(148, 163, 184, 0.1)" }}>
                  <span>{entry.label}</span>
                  <span className="subtle">{entry.tag}</span>
                  <span>{entry.pnl}</span>
                  <span>{entry.dd}</span>
                  <span>{entry.exposure}</span>
                </div>
              ))}
            </div>
          </div>
        </section>
      ) : null}

      {showAllocator ? (
        <section className="panel" style={{ marginTop: 16 }}>
          <div className="eyebrow">Allocator Reporting Blocks <HelpHint text="C'est le niveau institutionnel: performance, drawdown, volatility, exposure, liquidity et attribution lisibles en un coup d'oeil." examples={["Avant un call investisseur: verifie YTD/MTD/WTD, max DD, rolling Sharpe, liquidite et stress test.", "Si l'attribution montre une sleeve dominante, explique clairement pourquoi et quel risque residuel reste ouvert."]} /></div>
          <div className="grid" style={{ marginTop: 12, gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
            {allocatorReturnCards.map((metric) => (
              <div className="panel" key={metric.label} style={{ borderRadius: 14, minHeight: 110 }}>
                <div className="eyebrow">{metric.label}</div>
                <div style={{ fontSize: 28, fontWeight: 700, marginTop: 8 }}>{metric.value}</div>
              </div>
            ))}
          </div>
          <div className="grid" style={{ marginTop: 16, gridTemplateColumns: "1fr 1fr" }}>
            <div className="panel" style={{ borderRadius: 14 }}>
              <div className="eyebrow">Exposure by asset class</div>
              {assetClassExposure.map((item) => (
                <div className="row" key={item.label}>
                  <span>{item.label}</span>
                  <span>{formatPct(item.exposurePct, 0)} · {formatMoney(item.exposureUsd)}</span>
                </div>
              ))}
            </div>
            <div className="panel" style={{ borderRadius: 14 }}>
              <div className="eyebrow">Stress, liquidity & scenario analysis</div>
              {stressTests.map((item) => (
                <div className="row" key={item.label}>
                  <span>{item.label}</span>
                  <span>{item.value}</span>
                </div>
              ))}
              <div style={{ marginTop: 12 }}>
                <div className="subtle" style={{ marginBottom: 6 }}>Allocator narrative</div>
                <textarea rows={5} value={notes.allocatorNarrative} onChange={(event) => updateNote("allocatorNarrative", event.target.value)} />
              </div>
            </div>
          </div>
          <div className="grid" style={{ marginTop: 16, gridTemplateColumns: "1fr 1fr" }}>
            <div className="panel" style={{ borderRadius: 14 }}>
              <div className="eyebrow">Performance & investor reporting</div>
              <div className="row"><span>Realized PnL</span><span>{formatMoney(realizedPnlUsd)}</span></div>
              <div className="row"><span>Unrealized PnL</span><span>{formatMoney(unrealizedPnlUsd)}</span></div>
              <div className="row"><span>Win rate</span><span>{formatPct(winRatePct, 1)}</span></div>
              <div className="row"><span>Expectancy</span><span>{formatMoney(expectancyUsd)}</span></div>
              {latestInvestorReport ? (
                <div className="panel" style={{ marginTop: 12, borderRadius: 12 }}>
                  <div className="row"><span>Latest report</span><span>{String(latestInvestorReport.report_type || "report")}</span></div>
                  <div className="row"><span>Month</span><span>{String(latestInvestorReport.report_month || "-")}</span></div>
                  <div className="row"><span>Status</span><span>{String(latestInvestorReport.status || "-")}</span></div>
                </div>
              ) : (
                <p className="subtle" style={{ marginTop: 12 }}>Aucun report investisseur recent disponible.</p>
              )}
            </div>
            <div className="panel" style={{ borderRadius: 14 }}>
              <div className="eyebrow">Attribution snapshot</div>
              {attributionRows.map((row) => (
                <div className="row" key={row.label}>
                  <span>{row.label}</span>
                  <span>{row.value}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="grid" style={{ marginTop: 16, gridTemplateColumns: "1fr 1fr" }}>
            <div className="panel" style={{ borderRadius: 14 }}>
              <div className="eyebrow">Factor attribution</div>
              {factorAttribution.map((row) => (
                <div className="row" key={row.label}>
                  <span>{row.label}</span>
                  <span>{row.value}</span>
                </div>
              ))}
            </div>
            <div className="panel" style={{ borderRadius: 14 }}>
              <div className="eyebrow">Stress test suite</div>
              {stressRegimes.map((row) => (
                <div className="row" key={row.label}>
                  <span>{row.label}</span>
                  <span>{row.dd} · {row.action}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="panel" style={{ marginTop: 16, borderRadius: 14 }}>
            <div className="eyebrow">Scenario engine</div>
            {scenarioEngineRows.map((row) => (
              <div className="row" key={row.label}>
                <span>{row.label}</span>
                <span>{row.impact} · {row.response}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {showRisk ? (
        <section className="panel" style={{ marginTop: 16 }}>
          <div className="eyebrow">Live Risk Overlay <HelpHint text="Le fund manager doit voir en deux secondes si le fonds est en danger ou en controle." examples={["Si mandate usage explose et que la concentration grimpe, coupe vite les sleeves avant que le drawdown n'atteigne le plafond.", "Si la correlation remonte partout en meme temps, la diversification est une illusion: hedge ou baisse le risque."]} /></div>
          <div className="grid" style={{ marginTop: 12, gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
            {liveRiskCards.map((card) => (
              <div className="panel" key={card.label} style={{ borderRadius: 14, minHeight: 112 }}>
                <div className="eyebrow">{card.label}</div>
                <div className={card.tone} style={{ fontSize: 28, marginTop: 8 }}>{card.value}</div>
              </div>
            ))}
          </div>
          <div className="grid" style={{ marginTop: 16, gridTemplateColumns: "1fr 1fr" }}>
            <div className="panel" style={{ borderRadius: 14 }}>
              <div className="eyebrow">Positions heatmap</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10, marginTop: 12 }}>
                {positionHeatmap.map((item) => (
                  <div key={item.label} style={{ borderRadius: 12, padding: 12, background: `rgba(56, 189, 248, ${item.intensity * 0.28})`, border: "1px solid rgba(56, 189, 248, 0.18)" }}>
                    <div style={{ fontWeight: 700 }}>{item.label}</div>
                    <div className="subtle" style={{ marginTop: 4 }}>Heat {formatPct(item.intensity * 100, 0)}</div>
                  </div>
                ))}
              </div>
            </div>
            <div className="panel" style={{ borderRadius: 14 }}>
              <div className="eyebrow">Correlation matrix</div>
              <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
                {CORRELATION_BLUEPRINT.map((row) => (
                  <div key={row.row} style={{ display: "grid", gridTemplateColumns: "140px repeat(5, minmax(0, 1fr))", gap: 8, alignItems: "center" }}>
                    <span className="subtle">{row.row}</span>
                    {row.values.map((value, index) => (
                      <span
                        key={`${row.row}-${index}`}
                        style={{
                          display: "inline-flex",
                          justifyContent: "center",
                          padding: "8px 0",
                          borderRadius: 10,
                          background: value >= 0
                            ? `rgba(52, 211, 153, ${Math.abs(value) * 0.34})`
                            : `rgba(245, 158, 11, ${Math.abs(value) * 0.34})`,
                          border: "1px solid rgba(148, 163, 184, 0.14)",
                        }}
                      >
                        {value.toFixed(2)}
                      </span>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="grid" style={{ marginTop: 16, gridTemplateColumns: "1fr 1fr" }}>
            <div className="panel" style={{ borderRadius: 14 }}>
              <div className="eyebrow">Liquidity profile</div>
              {liquidityProfileRows.map((row) => (
                <div className="row" key={row.label}>
                  <span>{row.label}</span>
                  <span>{row.value}</span>
                </div>
              ))}
            </div>
            <div className="panel" style={{ borderRadius: 14 }}>
              <div className="eyebrow">Temporal heatmap</div>
              <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
                {temporalHeatmap.map((row) => (
                  <div key={row.label} style={{ display: "grid", gridTemplateColumns: "56px repeat(5, minmax(0, 1fr))", gap: 8, alignItems: "center" }}>
                    <span className="subtle">{row.label}</span>
                    {row.values.map((value, index) => (
                      <span key={`${row.label}-${index}`} style={{ height: 26, borderRadius: 8, background: `rgba(56, 189, 248, ${value * 0.42})`, border: "1px solid rgba(56, 189, 248, 0.12)" }} />
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="panel" style={{ marginTop: 16, borderRadius: 14 }}>
            <div className="eyebrow">Fund Engine</div>
            {fundEngineRecommendations.map((row) => (
              <div className="row" key={row.label}>
                <span>{row.label}</span>
                <span>{row.value}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="grid" style={{ marginTop: 16, gridTemplateColumns: "1fr 1fr" }}>
        <div className="panel">
          <div className="eyebrow">Venue Access Buttons</div>
          <p className="subtle">Boutons directs pour brancher d'autres plateformes, exchanges et wallets sans sortir du workflow fund manager.</p>
          <div className="form-grid" style={{ marginTop: 12 }}>
            <button type="button" onClick={() => window.location.assign("/connections")}>Connect Broker / MT5</button>
            <button type="button" onClick={() => window.location.assign("/connections")}>Connect Exchange API</button>
            <button type="button" onClick={() => window.location.assign("/connections")}>Connect Wallet / DEX</button>
            <button type="button" onClick={() => window.location.assign("/connectors")}>Open onboarding hub</button>
            <button type="button" onClick={() => window.location.assign("/terminal")}>Open execution terminal</button>
            <button type="button" onClick={() => window.location.assign("/incidents")}>Open incident desk</button>
          </div>
        </div>

        <div className="panel">
          <div className="eyebrow">Supported Venue Universe</div>
          {[...BROKER_CONNECTION_CATALOG.slice(0, 2), ...EXCHANGE_CONNECTION_CATALOG.slice(0, 3), ...WALLET_CONNECTION_CATALOG.slice(0, 2)].map((item) => (
            <div className="row" key={`${item.providerId}-${item.mode}`}>
              <span>{item.provider}</span>
              <span>{item.mode}</span>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}