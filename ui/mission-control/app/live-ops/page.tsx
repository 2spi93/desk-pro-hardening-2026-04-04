"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import OperatorPanelGuide from "../../components/ui/OperatorPanelGuide";
import { openOpsCopilotPrompt } from "../../lib/opsCopilot";
import { ControlRoomMonitoringPanel, ExecutionPnlTruthMonitoringPanel, OperatorActionSummary } from "../terminal/TerminalSecondaryPanels";

type JsonMap = Record<string, unknown>;
type DailyPlanTemplateTask = {
  id: string;
  title: string;
  detail: string;
};

type DailyPlanTemplateDay = {
  dayOffset: number;
  title: string;
  focus: string;
  objective: string;
  context: string;
  tasks: DailyPlanTemplateTask[];
};

const DAILY_PLAN_SPRINT_STORAGE_KEY = "txt.liveops.daily-plan.sprint-start.v1";
const DAILY_PLAN_CHECKS_STORAGE_KEY = "txt.liveops.daily-plan.checks.v1";
const LIVE_OPS_JOURNAL_CONTEXT = {
  symbol: "DESK",
  timeframe: "live",
  strategy: "live-ops",
} as const;

function formatClock(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return value || "-";
  }
  return new Intl.DateTimeFormat("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "UTC",
  }).format(new Date(parsed));
}

function toNumber(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function asRecord(value: unknown): JsonMap {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonMap
    : {};
}

function startOfLocalDay(input: Date): Date {
  return new Date(input.getFullYear(), input.getMonth(), input.getDate());
}

function addDays(input: Date, days: number): Date {
  const next = new Date(input);
  next.setDate(next.getDate() + days);
  return startOfLocalDay(next);
}

function toDateKey(input: Date): string {
  const year = input.getFullYear();
  const month = `${input.getMonth() + 1}`.padStart(2, "0");
  const day = `${input.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDateKey(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) {
    return null;
  }
  const parsed = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(parsed.getTime()) ? null : startOfLocalDay(parsed);
}

function diffInDays(left: Date, right: Date): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.floor((startOfLocalDay(left).getTime() - startOfLocalDay(right).getTime()) / msPerDay);
}

function formatPlanDate(input: Date): string {
  return new Intl.DateTimeFormat("fr-FR", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
  }).format(input);
}

export default function LiveOpsPage() {
  const [liveOpsPayload, setLiveOpsPayload] = useState<JsonMap | null>(null);
  const [executionPnlAnalyzerPayload, setExecutionPnlAnalyzerPayload] = useState<JsonMap | null>(null);
  const [executionAiV6Payload, setExecutionAiV6Payload] = useState<JsonMap | null>(null);
  const [dailyPlanSprintStart, setDailyPlanSprintStart] = useState<string>(toDateKey(startOfLocalDay(new Date())));
  const [dailyPlanChecks, setDailyPlanChecks] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [emergencyStopBusy, setEmergencyStopBusy] = useState(false);
  const [emergencyStopFeedback, setEmergencyStopFeedback] = useState<string | null>(null);
  const [systemModeBusy, setSystemModeBusy] = useState(false);
  const [systemModeFeedback, setSystemModeFeedback] = useState<string | null>(null);

  async function appendLiveOpsJournalEntry(action: string, detail: string, meta: JsonMap = {}): Promise<void> {
    await fetch("/api/terminal/v2-risk-journal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...LIVE_OPS_JOURNAL_CONTEXT,
        action,
        detail,
        meta,
      }),
    }).catch(() => null);
  }

  async function loadData(): Promise<void> {
    setBusy(true);
    try {
      const fetchOptional = async (url: string): Promise<JsonMap | null> => {
        const response = await fetch(url, { cache: "no-store" }).catch(() => null);
        if (!response || !response.ok) {
          return null;
        }
        const payload = await response.json().catch(() => null);
        return payload && typeof payload === "object" ? payload as JsonMap : null;
      };

      const [response, pnlResponse, executionAiResponse] = await Promise.all([
        fetch("/api/system/live-ops", { cache: "no-store" }),
        fetchOptional("/api/execution/pnl-analyzer?scope_type=strategy&scope_id=mt5-live&limit=50"),
        fetchOptional("/api/execution/ai/v6/state"),
      ]);
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(String(payload && typeof payload === "object" ? (payload as JsonMap).detail || "Live Ops indisponible" : "Live Ops indisponible"));
      }
      const payload = await response.json();
      setLiveOpsPayload(payload && typeof payload === "object" ? payload as JsonMap : null);
      setExecutionPnlAnalyzerPayload(pnlResponse);
      setExecutionAiV6Payload(executionAiResponse);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur inconnue");
    } finally {
      setBusy(false);
      setLoading(false);
    }
  }

  async function triggerEmergencyStop(): Promise<void> {
    setEmergencyStopBusy(true);
    setEmergencyStopFeedback(null);
    try {
      const response = await fetch("/api/system/emergency-stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "live-ops-page" }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(String(payload && typeof payload === "object" ? (payload as JsonMap).detail || "Emergency stop refuse" : "Emergency stop refuse"));
      }
      setEmergencyStopFeedback(String(payload && typeof payload === "object" ? (payload as JsonMap).detail || "Emergency stop envoye" : "Emergency stop envoye"));
      void appendLiveOpsJournalEntry("emergency-stop", "Emergency stop declenche depuis Live Ops", {
        source: "live-ops-page",
        detail: String(payload && typeof payload === "object" ? (payload as JsonMap).detail || "Emergency stop envoye" : "Emergency stop envoye"),
      });
      await loadData();
    } catch (err) {
      setEmergencyStopFeedback(err instanceof Error ? err.message : "Erreur inconnue");
    } finally {
      setEmergencyStopBusy(false);
    }
  }

  async function changeSystemMode(mode: "suggest" | "guarded_auto" | "managed_live"): Promise<void> {
    const previousMode = backendMode;
    setSystemModeBusy(true);
    setSystemModeFeedback(null);
    try {
      const response = await fetch("/api/system/mode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(String(payload && typeof payload === "object" ? (payload as JsonMap).detail || "Changement de mode refuse" : "Changement de mode refuse"));
      }
      setSystemModeFeedback(`Mode systeme mis a jour: ${mode}`);
      void appendLiveOpsJournalEntry("system-mode-changed", `Mode ${previousMode} -> ${mode}`, {
        source: "live-ops-page",
        previous_mode: previousMode,
        next_mode: mode,
      });
      await loadData();
    } catch (err) {
      setSystemModeFeedback(err instanceof Error ? err.message : "Erreur inconnue");
    } finally {
      setSystemModeBusy(false);
    }
  }

  useEffect(() => {
    let mounted = true;
    const refresh = async () => {
      if (!mounted) {
        return;
      }
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
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const today = startOfLocalDay(new Date());
    const todayKey = toDateKey(today);
    const rawSprint = window.localStorage.getItem(DAILY_PLAN_SPRINT_STORAGE_KEY) || todayKey;
    const parsedSprint = parseDateKey(rawSprint) || today;
    const resolvedSprint = diffInDays(today, parsedSprint) >= 7 ? todayKey : rawSprint;
    setDailyPlanSprintStart(resolvedSprint);
    window.localStorage.setItem(DAILY_PLAN_SPRINT_STORAGE_KEY, resolvedSprint);

    const rawChecks = window.localStorage.getItem(DAILY_PLAN_CHECKS_STORAGE_KEY);
    if (!rawChecks) {
      return;
    }
    try {
      const parsedChecks = JSON.parse(rawChecks) as Record<string, boolean>;
      if (parsedChecks && typeof parsedChecks === "object") {
        setDailyPlanChecks(parsedChecks);
      }
    } catch {
      window.localStorage.removeItem(DAILY_PLAN_CHECKS_STORAGE_KEY);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(DAILY_PLAN_CHECKS_STORAGE_KEY, JSON.stringify(dailyPlanChecks));
  }, [dailyPlanChecks]);

  const snapshot = asRecord(liveOpsPayload);
  const watchdog = asRecord(snapshot.watchdog_state);
  const governance = asRecord(snapshot.governance);
  const recovery = asRecord(snapshot.recovery);
  const memoryGap = asRecord(snapshot.memory_gap);
  const alerts = Array.isArray(snapshot.alerts) ? snapshot.alerts : [];
  const backendMode = String(governance.backend_mode || "guarded_auto");
  const pnlEnvelope = asRecord(executionPnlAnalyzerPayload);
  const pnlSummary = asRecord(pnlEnvelope.summary);
  const v6Envelope = asRecord(executionAiV6Payload);
  const v6Snapshot = asRecord(v6Envelope.snapshot);
  const v6Guardrails = asRecord(v6Snapshot.guardrails);
  const tradeCount = toNumber(pnlSummary.trade_count, 0);
  const avgLatencyMs = toNumber(pnlSummary.avg_latency_ms, 0);
  const avgSlippageBps = toNumber(pnlSummary.avg_slippage_bps, 0);
  const netPnlUsd = toNumber(pnlSummary.net_pnl_usd, 0);
  const highConfidenceLossCount = toNumber(pnlSummary.high_confidence_loss_count, 0);
  const noTradeDominanceCount = toNumber(pnlSummary.no_trade_dominance_count, 0);
  const noTradeRatioPct = tradeCount > 0 ? (noTradeDominanceCount / tradeCount) * 100 : 0;
  const drawdownPct = toNumber(asRecord(snapshot.risk_snapshot).dd_pct, 0);
  const watchdogStatus = String(watchdog.status || "UNKNOWN").toUpperCase();
  const learningFrozen = Boolean(v6Guardrails.learning_frozen);
  const expectancyR = tradeCount > 0
    ? ((toNumber(pnlSummary.win_rate_pct, 0) / 100) * Math.max(toNumber(pnlSummary.avg_pnl_usd, 0), 0)
      - ((100 - toNumber(pnlSummary.win_rate_pct, 0)) / 100) * Math.abs(Math.min(toNumber(pnlSummary.avg_pnl_usd, 0), 0)))
    : 0;
  const noTradeScore = Math.max(
    0,
    Math.min(
      1,
      (avgLatencyMs > 150 ? 0.3 : avgLatencyMs > 120 ? 0.18 : 0)
      + (avgSlippageBps > 4 ? 0.22 : avgSlippageBps > 3 ? 0.12 : 0)
      + (noTradeRatioPct < 10 ? 0.2 : noTradeRatioPct < 20 ? 0.08 : 0)
      + (highConfidenceLossCount > 0 ? 0.15 : 0)
      + (learningFrozen ? 0.15 : 0),
    ),
  );
  const truthLine = (() => {
    if (watchdogStatus === "HALT" || String(governance.mode || "SAFE") === "LOCKED") {
      return { label: "BLOCK", tone: "warn", detail: "system guardrails active" };
    }
    if (expectancyR < 0) {
      return { label: "BLOCK", tone: "warn", detail: "expectancy live negatif: stop system avant d'ajuster quoi que ce soit" };
    }
    if (noTradeScore > 0.7) {
      return { label: "BLOCK", tone: "warn", detail: "no-trade score trop eleve: le desk doit refuser le flux" };
    }
    if ((tradeCount >= 5 && netPnlUsd < 0 && highConfidenceLossCount > 0) || drawdownPct >= 3) {
      return { label: "BLOCK", tone: "warn", detail: "stop live and investigate before the next trade" };
    }
    if (learningFrozen || avgLatencyMs > 120 || avgSlippageBps > 3 || tradeCount < 3 || noTradeRatioPct < 10 || noTradeScore > 0.45) {
      return { label: "REDUCE", tone: "subtle", detail: "micro-live only, tighten no-trade and collect more truth" };
    }
    return { label: "OK", tone: "good", detail: "guarded micro-live remains acceptable" };
  })();
  const planCards = [
    {
      title: "Pre-open",
      tone: watchdogStatus === "OK" && String(memoryGap.memory_decision || "OK") === "OK" ? "good" : "warn",
      headline: `${watchdogStatus} / memory ${String(memoryGap.memory_decision || "OK")}`,
      detail: "Verifie watchdog, memory gate et mode systeme avant la premiere decision live.",
    },
    {
      title: "Collecte",
      tone: tradeCount <= 10 ? "good" : "warn",
      headline: `${tradeCount.toFixed(0)} / 10 trades max`,
      detail: "Reste en micro-live. L'objectif du jour est la qualite de donnees, pas le volume.",
    },
    {
      title: "Filtrage",
      tone: avgLatencyMs <= 120 && avgSlippageBps <= 3 && noTradeRatioPct >= 10 ? "good" : avgLatencyMs > 150 || avgSlippageBps > 4 ? "warn" : "subtle",
      headline: `${avgLatencyMs.toFixed(0)}ms · ${avgSlippageBps.toFixed(2)}bps · no-trade ${noTradeRatioPct.toFixed(0)}%`,
      detail: "Latence, slippage et dominance du no-trade doivent rester stricts avant toute montee en taille.",
    },
    {
      title: "Hard stops",
      tone: drawdownPct >= 3 || (tradeCount >= 5 && netPnlUsd <= 0) || highConfidenceLossCount > 0 ? "warn" : learningFrozen ? "subtle" : "good",
      headline: `DD ${drawdownPct.toFixed(2)}% · flags ${highConfidenceLossCount.toFixed(0)} · V6 ${learningFrozen ? "frozen" : "active"}`,
      detail: "Si l'expectancy tourne negatif ou que les flags montent, stoppe le live et garde la calibration verrouillee.",
    },
  ];
  const calibrationProgressPct = Math.min(100, Math.round((tradeCount / 50) * 100));
  const sprintStartDate = parseDateKey(dailyPlanSprintStart) || startOfLocalDay(new Date());
  const today = startOfLocalDay(new Date());
  const dailyPlanBlueprint: DailyPlanTemplateDay[] = [
    {
      dayOffset: 0,
      title: "Jour 1 · Bootstrap micro-live",
      focus: "Survivre et capter une verite propre",
      objective: "+0.5% max, zero forcing",
      context: `Bias ${truthLine.label === "OK" ? "constructif" : "defensif"} · volatilite ${avgSlippageBps > 3 ? "bruyante" : "moyenne"} · risque ${drawdownPct >= 2 ? "sous tension" : "controle"}`,
      tasks: [
        { id: "preopen-check", title: "Valider pre-open", detail: `Watchdog ${watchdogStatus}, memory gate ${String(memoryGap.memory_decision || "OK")}, mode ${backendMode}.` },
        { id: "size-fixed", title: "Conserver size fixe", detail: "Reste a 5$ et interdit tout scaling sur le premier jour." },
        { id: "max-10-trades", title: "Limiter le flux", detail: "Max 10 trades, no-trade prioritaire si le contexte se degrade." },
        { id: "avoid-revenge", title: "Interdire revenge trade", detail: "Aucun trade force si deux executions d'affilee sont sales." },
      ],
    },
    {
      dayOffset: 1,
      title: "Jour 2 · Collecte disciplinee",
      focus: "Mesurer execution et latence avant toute idee de perf",
      objective: "Execution propre > resultat brut",
      context: `Latency ${avgLatencyMs.toFixed(0)}ms · slippage ${avgSlippageBps.toFixed(2)}bps · fill strict`,
      tasks: [
        { id: "latency-watch", title: "Surveiller latency", detail: `Reduire si latency > 120ms, stop infra si > 200ms.` },
        { id: "fills-review", title: "Verifier fills", detail: "Comparer fill rate et slippage reel avant d'autoriser un flux plus dense." },
        { id: "context-lock", title: "Respecter le contexte", detail: "Si volatilite spike + liquidite faible, repasse en NO TRADE." },
        { id: "close-check", title: "Cloture sobre", detail: "Pas de trade de rattrapage en fin de session pour compenser la journee." },
      ],
    },
    {
      dayOffset: 2,
      title: "Jour 3 · Verite PnL",
      focus: "Confirmer que l'expectancy et le no-trade racontent la meme histoire",
      objective: "Verite > ego",
      context: `Expectancy ${expectancyR >= 0 ? "+" : ""}${expectancyR.toFixed(2)}R · no-trade score ${(noTradeScore * 100).toFixed(0)}%`,
      tasks: [
        { id: "expectancy-check", title: "Verifier expectancy", detail: "Si expectancy live est negatif, stop system et ouvre l'analyse." },
        { id: "truth-panel-review", title: "Relire Truth Panel", detail: "Comparer regime, venue et execution mode pour localiser la destruction de PnL." },
        { id: "error-log", title: "Logger erreurs a eviter", detail: "Noter forcing, latence, overtrading ou baisse de discipline." },
        { id: "close-rules", title: "Valider respect des regles", detail: "Fin de journee: rules respectees, erreurs identifiees, aucune action punitive." },
      ],
    },
    {
      dayOffset: 3,
      title: "Jour 4 · Calibration V2 legere",
      focus: "Adapter sans casser",
      objective: "Petits ajustements, aucune derive",
      context: `${tradeCount.toFixed(0)} trades observes · gate calibration ${tradeCount >= 20 ? "ouvrable legerement" : "encore verrouillee"}`,
      tasks: [
        { id: "trade-count-gate", title: "Verifier gate 20 trades", detail: "Si moins de 20 trades aujourd'hui, garder learning LOW et aucune auto-calibration." },
        { id: "reward-lock", title: "Appliquer negative lock", detail: `Si reward EMA ou expectancy tourne negatif, freeze learning immediat.` },
        { id: "regime-lock", title: "Confirmer regime lock", detail: "Aucun update learning si regime inconnu ou contexte degrade." },
        { id: "v4-fallback", title: "Valider safe fallback", detail: "Au moindre signal d'anomalie, retour vers logique V4/V4.2." },
      ],
    },
    {
      dayOffset: 4,
      title: "Jour 5 · No-trade dominance",
      focus: "Moins trader, mieux trader",
      objective: "No-trade > sur-trading",
      context: `Dominance ${noTradeDominanceCount.toFixed(0)} / ${tradeCount.toFixed(0)} · drawdown ${drawdownPct.toFixed(2)}%`,
      tasks: [
        { id: "dominance-review", title: "Revoir score no-trade", detail: "Si no_trade_score > 0.7, forcer NO TRADE sur le flux degrade." },
        { id: "micro-killswitch", title: "Activer micro kill-switch", detail: "3 pertes = size -50%, 5 pertes = STOP." },
        { id: "context-stop", title: "Bloquer contexte toxique", detail: "Volatility spike + low liquidity = NO TRADE sans discussion." },
        { id: "queue-hygiene", title: "Relire hygiene execution", detail: "Pas d'entree agressive si queue, fill prob ou spread se degradent." },
      ],
    },
    {
      dayOffset: 5,
      title: "Jour 6 · Ajustements bornes",
      focus: "Ajuster 3 variables maximum",
      objective: "Confidence, fill, latency seulement",
      context: `Confidence floor, fill probability floor et latency threshold sont les seuls leviers autorises.`,
      tasks: [
        { id: "confidence-floor", title: "Ajuster confidence floor", detail: "Micro-ajustement seulement, jamais de grand saut de seuil." },
        { id: "fill-floor", title: "Ajuster fill probability", detail: "Relever le filtre si les fills degradent ou si le slippage explose." },
        { id: "latency-threshold", title: "Ajuster seuil latency", detail: "Ne jamais relacher le seuil si l'infra reste instable." },
        { id: "rollback-ready", title: "Garder rollback pret", detail: "Si drawdown > 3% ou anomalie, revert immediate de la calibration." },
      ],
    },
    {
      dayOffset: 6,
      title: "Jour 7 · Gate de scaling",
      focus: "Go / no-go pour la phase suivante",
      objective: "Scaler seulement si stable",
      context: `${tradeCount.toFixed(0)} / 50 trades · DD ${drawdownPct.toFixed(2)}% · expectancy ${expectancyR >= 0 ? "+" : ""}${expectancyR.toFixed(2)}R`,
      tasks: [
        { id: "scale-check", title: "Verifier conditions phase 2", detail: "50+ trades, expectancy > 0, drawdown < 3% avant tout x1.5." },
        { id: "profit-factor-check", title: "Confirmer stabilite", detail: "Si la stabilite n'est pas prouvee, rester en phase 1 sans ego." },
        { id: "close-audit", title: "Boucler audit de discipline", detail: "Valider que les regles, hard stops et erreurs ont ete revus proprement." },
        { id: "next-sprint", title: "Preparer sprint suivant", detail: "Si le sprint est propre, recalculer les dates et repartir sur un cycle discipline." },
      ],
    },
  ];
  const dailyPlanDays = dailyPlanBlueprint.map((day) => {
    const date = addDays(sprintStartDate, day.dayOffset);
    const dateKey = toDateKey(date);
    const dayPassed = date.getTime() < today.getTime();
    const isToday = date.getTime() === today.getTime();
    return {
      ...day,
      date,
      dateKey,
      dayPassed,
      isToday,
      tasks: day.tasks.map((task) => {
        const taskKey = `${dateKey}:${task.id}`;
        return {
          ...task,
          taskKey,
          done: Boolean(dailyPlanChecks[taskKey]),
        };
      }),
    };
  });

  function openDeskBriefing(): void {
    openOpsCopilotPrompt({ message: "Resume-moi en langage naturel le desk du jour: verite PnL, no-trade, risque, V6 et priorites operationnelles.", autoSend: true });
    void appendLiveOpsJournalEntry("ops-brief-opened", "Briefing Ops Copilot demande", {
      source: "live-ops-page",
      prompt: "desk-day-brief",
    });
  }

  function openDailyPlanBrief(): void {
    openOpsCopilotPrompt({ message: "Rappelle-moi le plan journalier a respecter aujourd'hui avec hard stops et calibration gate.", autoSend: true });
    void appendLiveOpsJournalEntry("daily-plan-brief-opened", "Plan journalier relu via Ops Copilot", {
      source: "live-ops-page",
      prompt: "daily-plan-brief",
    });
  }

  function openCommandantBrief(): void {
    openOpsCopilotPrompt({ message: "Mode commandant: que faire maintenant sur Live Ops ? Donne DECISION, RISQUE, RAISON et rappelle que l'override doit rester visible.", autoSend: true });
    void appendLiveOpsJournalEntry("commandant-brief-opened", "Mode commandant demande depuis Live Ops", {
      source: "live-ops-page",
      prompt: "commandant-live-ops",
    });
  }

  function openSprintBrief(): void {
    openOpsCopilotPrompt({ message: "Rappelle-moi le plan journalier du sprint en cours, les taches en retard et les hard stops a ne pas violer.", autoSend: true });
    void appendLiveOpsJournalEntry("sprint-brief-opened", "Brief sprint demande", {
      source: "live-ops-page",
      prompt: "sprint-brief",
    });
  }

  function toggleDailyPlanTask(taskKey: string, title: string, dayTitle: string): void {
    const nextDone = !dailyPlanChecks[taskKey];
    setDailyPlanChecks((current) => ({
      ...current,
      [taskKey]: nextDone,
    }));
    void appendLiveOpsJournalEntry(nextDone ? "daily-plan-task-done" : "daily-plan-task-reopened", `${dayTitle} · ${title}`, {
      source: "live-ops-page",
      task_key: taskKey,
      done: nextDone,
    });
  }

  function resetDailyPlanSprint(): void {
    const nextKey = toDateKey(startOfLocalDay(new Date()));
    setDailyPlanSprintStart(nextKey);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(DAILY_PLAN_SPRINT_STORAGE_KEY, nextKey);
    }
    if (nextKey !== dailyPlanSprintStart) {
      void appendLiveOpsJournalEntry("daily-plan-sprint-reset", `Sprint recale sur ${nextKey}`, {
        source: "live-ops-page",
        sprint_start: nextKey,
      });
    }
  }

  return (
    <main className="shell txt-page-shell" data-testid="mission-control-live-ops-page">
      <section className="hero txt-page-hero-grid" style={{ gridTemplateColumns: "1.25fr 1fr" }}>
        <div id="global-guide-liveops-hero" className="panel txt-page-hero">
          <div className="eyebrow">Live Ops Control Room</div>
          <h1 className="title" style={{ fontSize: 34 }}>H24 Control Room</h1>
          <p className="subtle">Route dediee au pilotage live des gardes systeme, de la recovery et de la warfare logic. Le menu global pointe maintenant vers une vraie page, plus vers une route manquante.</p>
          <OperatorPanelGuide
            title="Guide Live Ops"
            what="L'état des protections du système, des alertes et du mode de secours."
            why="Savoir en quelques secondes si la machine reste fiable ou si elle doit ralentir."
            example="Si le score de santé baisse et que le mode de secours s'active, réduis le risque et cherche la cause."
            actions={(
              <>
                <button type="button" onClick={openDeskBriefing}>Briefing Ops Copilot</button>
                <button type="button" onClick={openDailyPlanBrief}>Plan journalier</button>
              </>
            )}
          />
          <p>
            <Link href="/">Dashboard</Link>
            {" | "}
            <Link href="/terminal">Terminal</Link>
            {" | "}
            <Link href="/live-readiness">Readiness</Link>
            {" | "}
            <Link href="/incidents">Incidents</Link>
          </p>
          {error ? <p className="warn">{error}</p> : null}
        </div>
        <div className="panel">
          <div className="eyebrow">Etat Global</div>
          <div className="row"><span>Watchdog</span><span className={String(watchdog.status || "UNKNOWN") === "OK" ? "good" : "warn"}>{String(watchdog.status || "UNKNOWN")}</span></div>
          <div className="row"><span>Health score</span><span>{toNumber(watchdog.health_score, 0).toFixed(0)}%</span></div>
          <div className="row"><span>System mode</span><span className={String(governance.mode || "SAFE") === "LIVE" ? "good" : String(governance.mode || "SAFE") === "LOCKED" ? "warn" : "subtle"}>{String(governance.mode || "SAFE")}</span></div>
          <div className="row"><span>Backend mode</span><span>{backendMode}</span></div>
          <div className="row"><span>Recovery</span><span>{String(recovery.mode || "NOMINAL")}</span></div>
          <div className="row"><span>Memory gate</span><span className={String(memoryGap.memory_decision || "OK") === "OK" ? "good" : "warn"}>{String(memoryGap.memory_decision || "OK")}</span></div>
          <div className="row"><span>Alertes live</span><span>{String(alerts.length)}</span></div>
          <div className="row"><span>Refresh</span><span>{loading ? "bootstrap" : busy ? "sync" : "15s"}</span></div>
        </div>
      </section>

      <section className="grid" style={{ gridTemplateColumns: "1fr", marginBottom: 16 }}>
        <div className="panel">
          <OperatorActionSummary
            executionPnlPayload={executionPnlAnalyzerPayload}
            liveOpsPayload={liveOpsPayload}
            executionAiV6Payload={executionAiV6Payload}
            journalContext={LIVE_OPS_JOURNAL_CONTEXT}
            formatClock={formatClock}
            footer={(
              <>
                <button type="button" onClick={openCommandantBrief}>
                  Mode commandant
                </button>
                <Link href="/terminal">Executer depuis le terminal</Link>
              </>
            )}
          />
        </div>
      </section>

      <section className="grid" style={{ gridTemplateColumns: "1fr", marginBottom: 16 }}>
        <div className="panel">
          <OperatorPanelGuide
            title="Pilotage du mode systeme"
            what="Bascule le systeme entre suggestion, auto garde et live gouverne."
            why="Tracer chaque changement de posture du desk avant et apres la bascule live."
            example="Passe en managed_live seulement si la route live, les credentials et la gouvernance sont prets."
            compact
          />
          <div className="row"><span>Mode backend actif</span><span>{backendMode}</span></div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
            <button type="button" disabled={systemModeBusy || backendMode === "suggest"} onClick={() => { void changeSystemMode("suggest"); }}>
              Suggest
            </button>
            <button type="button" disabled={systemModeBusy || backendMode === "guarded_auto"} onClick={() => { void changeSystemMode("guarded_auto"); }}>
              Guarded Auto
            </button>
            <button type="button" disabled={systemModeBusy || backendMode === "managed_live"} onClick={() => { void changeSystemMode("managed_live"); }}>
              Managed Live
            </button>
          </div>
          {systemModeFeedback ? <p className="subtle" style={{ marginTop: 10 }}>{systemModeFeedback}</p> : null}
        </div>
      </section>

      <section className="grid" style={{ gridTemplateColumns: "1fr", marginBottom: 16 }}>
        <div className="panel">
          <ControlRoomMonitoringPanel
            badge={null}
            layoutEditMode={false}
            onDetach={() => {}}
            liveOpsPayload={liveOpsPayload}
            emergencyStopBusy={emergencyStopBusy}
            emergencyStopFeedback={emergencyStopFeedback}
            onEmergencyStop={() => { void triggerEmergencyStop(); }}
            formatClock={formatClock}
          />
        </div>
      </section>

      <section className="grid" style={{ gridTemplateColumns: "1.15fr 0.85fr", marginBottom: 16 }}>
        <div className="panel">
          <ExecutionPnlTruthMonitoringPanel
            badge={null}
            layoutEditMode={false}
            onDetach={() => {}}
            payload={executionPnlAnalyzerPayload}
            liveOpsPayload={liveOpsPayload}
            executionAiV6Payload={executionAiV6Payload}
            journalContext={LIVE_OPS_JOURNAL_CONTEXT}
            formatClock={formatClock}
          />
        </div>
        <div className="panel">
          <OperatorPanelGuide
            title="Plan Journalier"
            what="Checklist d'exploitation bornee: survivre, mesurer, filtrer, puis seulement calibrer."
            why="Donner la lecture du jour sans ouvrir plusieurs panneaux ou briefs disperses."
            example="Si le truth line passe a BLOCK, arrete le live avant d'ajouter une seule feature."
            compact
          />
          <div className="row" style={{ marginTop: 10 }}><span>Truth line</span><span className={truthLine.tone}>{truthLine.label}</span></div>
          <p className="subtle" style={{ marginTop: 8 }}>{truthLine.detail}</p>
          <div className="row" style={{ marginTop: 8 }}><span>Expectancy live</span><span className={expectancyR >= 0 ? "good" : "warn"}>{expectancyR >= 0 ? "+" : ""}{expectancyR.toFixed(2)}R</span></div>
          <div className="row" style={{ marginTop: 6 }}><span>No-trade score</span><span className={noTradeScore > 0.7 ? "warn" : noTradeScore > 0.45 ? "subtle" : "good"}>{(noTradeScore * 100).toFixed(0)}%</span></div>
          <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
            {planCards.map((card) => (
              <div key={card.title} style={{ border: "1px solid rgba(148, 163, 184, 0.18)", borderRadius: 12, padding: 12, background: "rgba(15, 23, 42, 0.2)" }}>
                <div className="row" style={{ marginBottom: 6 }}>
                  <span>{card.title}</span>
                  <span className={card.tone}>{card.headline}</span>
                </div>
                <div className="subtle mini">{card.detail}</div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 14, padding: 12, borderRadius: 12, border: "1px solid rgba(148, 163, 184, 0.18)", background: "rgba(8, 21, 35, 0.38)" }}>
            <div className="row"><span>Calibration gate</span><span className={tradeCount >= 50 ? "good" : "subtle"}>{tradeCount.toFixed(0)} / 50 trades</span></div>
            <div className="subtle mini" style={{ marginTop: 6 }}>La calibration semi-auto reste verrouillee tant que tu n'as pas assez de micro-live stable.</div>
            <div style={{ marginTop: 10, height: 8, borderRadius: 999, background: "rgba(148, 163, 184, 0.14)", overflow: "hidden" }}>
              <div style={{ width: `${calibrationProgressPct}%`, height: "100%", background: calibrationProgressPct >= 100 ? "linear-gradient(90deg, rgba(34,197,94,0.9), rgba(16,185,129,0.9))" : "linear-gradient(90deg, rgba(56,189,248,0.9), rgba(14,165,233,0.9))" }} />
            </div>
          </div>
        </div>
      </section>

      <section className="grid" style={{ gridTemplateColumns: "1fr", marginBottom: 16 }}>
        <div className="panel">
          <OperatorPanelGuide
            title="Sprint Journalier Intelligent"
            what="Plan roulant sur 7 jours: les dates se conservent pendant le sprint puis se recalculent si le cycle est termine."
            why="Centraliser lecture et actions de discipline dans un seul bloc operateur."
            example="La case Realise reste manuelle pour que tu valides toi-meme l'execution de la tache."
            actions={(
              <>
                <button type="button" onClick={resetDailyPlanSprint}>Recaler le sprint a aujourd'hui</button>
                <button type="button" onClick={openSprintBrief}>Brief sprint</button>
              </>
            )}
          />
          <div className="row" style={{ marginTop: 10 }}>
            <span>Période du sprint</span>
            <span>{formatPlanDate(dailyPlanDays[0].date)} → {formatPlanDate(dailyPlanDays[dailyPlanDays.length - 1].date)}</span>
          </div>
          <div className="subtle mini" style={{ marginTop: 6 }}>Les dates se rebasent automatiquement quand le sprint complet est depasse. Tu peux aussi le recaler manuellement.</div>
          <div style={{ display: "grid", gap: 12, marginTop: 14 }}>
            {dailyPlanDays.map((day) => (
              <div key={day.dateKey} style={{ border: `1px solid ${day.isToday ? "rgba(56, 189, 248, 0.45)" : "rgba(148, 163, 184, 0.18)"}`, borderRadius: 14, padding: 14, background: day.isToday ? "rgba(8, 47, 73, 0.28)" : "rgba(15, 23, 42, 0.2)" }}>
                <div className="row" style={{ marginBottom: 6 }}>
                  <span>{day.title}</span>
                  <span className={day.dayPassed ? "warn" : day.isToday ? "good" : "subtle"}>{formatPlanDate(day.date)}{day.isToday ? " · aujourd'hui" : day.dayPassed ? " · passe" : " · a venir"}</span>
                </div>
                <div className="subtle mini">Focus: {day.focus}</div>
                <div className="subtle mini" style={{ marginTop: 4 }}>Objectif: {day.objective}</div>
                <div className="subtle mini" style={{ marginTop: 4, marginBottom: 10 }}>Contexte: {day.context}</div>
                <div style={{ display: "grid", gap: 8 }}>
                  {day.tasks.map((task) => (
                    <div key={task.taskKey} style={{ border: "1px solid rgba(148, 163, 184, 0.14)", borderRadius: 12, padding: 10, background: "rgba(2, 6, 23, 0.18)" }}>
                      <div className="row" style={{ alignItems: "flex-start", gap: 12 }}>
                        <div style={{ flex: 1 }}>
                          <div>{task.title}</div>
                          <div className="subtle mini" style={{ marginTop: 4 }}>{task.detail}</div>
                        </div>
                        <div style={{ display: "grid", gap: 6, minWidth: 180 }}>
                          <label className="subtle mini" style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between" }}>
                            <span>Jour passé</span>
                            <input type="checkbox" checked={day.dayPassed} readOnly disabled />
                          </label>
                          <label className="subtle mini" style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between" }}>
                            <span>Réalisé</span>
                            <input type="checkbox" checked={task.done} onChange={() => toggleDailyPlanTask(task.taskKey, task.title, day.title)} />
                          </label>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}